import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision } from "../src/storage/store.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import {
  beginAttempt, completeAttempt, openSeries, resumeSeries, seriesId, stopReviewNamespace, STOP_REVIEW_KIND,
  type AttemptGoal, type RepairSeries,
} from "../src/om/series.js";
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from "../src/om/refusal-journal.js";
import {
  closeAttempt, liftOriginHold, openAttempt, originDecisionNamespace,
  ORIGIN_DECISION_KIND, type OriginHold,
} from "../src/om/repeat-gate.js";
import {
  callLedgerId, callRecordId, readCall, recordCall, settleCall,
  CALL_LEDGER_KIND, CALL_PURPOSES, CALL_RECORD_CODES, CALL_RECORD_KIND,
  type CallLedger, type CallRecord, type RecordCallRequest,
} from "../src/om/call-record.js";

const UNIT = "gate-admit";
const PROJECT = "alpha";
const BLOCK = "block:cart";
const SLICE = "slice:cart@1";
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;

function refusalOf<T>(result: OmResult<T>): Refusal {
  if (result.ok) assert.fail("expected a refusal, got a delivered value");
  return result.refusal;
}

function deliveredOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`unexpected refusal ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

function addressed<T>(result: OmResult<T>, expected: string): Refusal {
  const refusal = refusalOf(result);
  assert.equal(refusal.code, expected);
  assert.equal(refusal.at.unit, UNIT);
  assert.ok(refusal.at.target.length > 0);
  assert.ok(refusal.message.length > 0);
  assert.ok(REFUSAL_ROUTES.includes(refusal.route));
  return refusal;
}

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(deeplyFrozen);
}

function goal(over: Partial<AttemptGoal> = {}): AttemptGoal {
  return {
    key: "gap:cart:price",
    questions: ["which operation owns the price?", "which contract carries it?"],
    result: "an accepted producer and its contract",
    ...over,
  };
}

interface Fixture {
  readonly root: string;
  readonly path: string;
  readonly store: Store;
  readonly adapter: Revision<Json>;
  readonly config: Revision<Json>;
  readonly series: Revision<RepairSeries>;
  readonly goal: AttemptGoal;
}

function fixture(t: test.TestContext, label = "case", StoreType: typeof Store = Store, project = PROJECT): Fixture {
  const root = mkdtempSync(join(tmpdir(), `omg-om-call-${label}-`));
  const path = join(root, "state.sqlite");
  const store = new StoreType(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const adapter = store.write({
    id: `adapter:${project}`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio", status: "configured-not-accepted" },
  });
  const config = store.write({
    id: `config:${project}`, kind: "dispatch-config", expected: 0,
    value: { projectId: project, model: "fixture", transport: "stdio", status: "configured-not-accepted" },
  });
  deliveredOf(openSeries(store, {
    project, block: BLOCK, line: 1, slice: SLICE, predecessor: null, basis: null,
  }));
  const attemptGoal = goal();
  const series = deliveredOf(beginAttempt(store, {
    project, block: BLOCK, line: 1, attempt: 1, goal: attemptGoal,
  }));
  return { root, path, store, adapter, config, series, goal: attemptGoal };
}

function request(f: Fixture, over: Partial<RecordCallRequest> = {}): RecordCallRequest {
  return {
    call: "research-price-1",
    purpose: "model-research",
    basis: null,
    block: BLOCK,
    gaps: [
      { id: "gap:contract", goal: "price contract", field: "contract", consumer: BLOCK },
      { id: "gap:producer", goal: "price producer", field: "producer", consumer: BLOCK },
    ],
    series: reference(f.series), attempt: 1, goal: f.goal,
    dispatch: { adapter: reference(f.adapter), config: reference(f.config) },
    packet: { question: "who produces the price?", neighbours: ["cart", "catalogue"] },
    ...over,
  };
}

let unique = 0;
const next = (): number => (unique += 1);

const analysisGoal = (kind: string): AttemptGoal => ({
  key: `analysis:${kind}`,
  questions: [`what caused ${kind}, and what exact change addresses it?`],
  result: "a review record with a cause or explicit hypothesis and an addressed change",
});

const analysisGaps = (basis: string, wanted: AttemptGoal, field: string) => [{
  id: basis, goal: wanted.key, field, consumer: "A6:stop-analysis",
}];

function stoppedSeries(f: Fixture): Revision<RepairSeries> {
  deliveredOf(completeAttempt(f.store, {
    project: PROJECT, block: BLOCK, line: 1, attempt: 1,
    outcome: { reason: "result", achieved: [], cancelled: [], refusals: [] },
  }));
  for (const attempt of [2, 3]) {
    deliveredOf(beginAttempt(f.store, { project: PROJECT, block: BLOCK, line: 1, attempt, goal: f.goal }));
    deliveredOf(completeAttempt(f.store, {
      project: PROJECT, block: BLOCK, line: 1, attempt,
      outcome: { reason: "result", achieved: [], cancelled: [], refusals: [] },
    }));
  }
  const stopped = f.store.get<RepairSeries>(seriesId(PROJECT, BLOCK, 1))!;
  assert.equal(stopped.value.stop?.attempt, 3);
  return stopped;
}

function stopReview(store: Store, series: Revision<RepairSeries>): Ref {
  const stop = series.value.stop!;
  return reference(store.write({
    id: `${stopReviewNamespace(PROJECT)}${next()}`, kind: STOP_REVIEW_KIND, expected: 0,
    value: {
      projectId: PROJECT, block: BLOCK, stop: stop.attempt, goals: [...stop.goals],
      reviewer: { name: "independent reviewer", independent: true },
      cause: "the same unresolved question survived every attempt in the window",
      change: { text: "change the producer addressed by the repeated question", addresses: ["M5"] },
    },
  }));
}

function unknownRefusal(store: Store, project: string): { readonly name: string; readonly goal: string; readonly row: string } {
  const name = `graph_invalid:${next()}`;
  const wanted = "every artifact consumed by an operation has one producer";
  const source = store.write({
    id: `${unitRefusalNamespace(project)}g:${next()}`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: {
      gate: "G3",
      refusals: [{
        code: name, goal: wanted, remedy: "identify the producer or the defective derivation",
        origin: { name: "artifact_missing", stage: "layer-check", subject: "artifact:cart", sources: [] },
      }],
    },
  });
  const journal = deliveredOf(recordRefusal(store, { project, source: reference(source) }));
  return { name, goal: wanted, row: journal.value.rows[journal.value.rows.length - 1]!.id };
}

function raisedHold(store: Store, project: string, attemptGoal: AttemptGoal, begin = false, block = BLOCK): {
  readonly hold: Ref; readonly series: Revision<RepairSeries>;
} {
  if (begin) {
    deliveredOf(openSeries(store, { project, block, line: 1, slice: `slice:${project}:${block}@1`, predecessor: null, basis: null }));
    deliveredOf(openAttempt(store, { project, block, line: 1, attempt: 1, goal: attemptGoal }));
  }
  const refusal = unknownRefusal(store, project);
  const result = deliveredOf(closeAttempt(store, {
    project, block, line: 1, attempt: 1,
    outcome: { reason: "refused", accepting: [], cancelling: [], refusals: [refusal] },
  }));
  assert.equal(result.holds.length, 1);
  return { hold: result.holds[0]!, series: store.get<RepairSeries>(seriesId(project, block, 1))! };
}

function liftByOwner(store: Store, project: string, hold: Ref): Ref {
  const value = store.get<OriginHold>(hold.id)!.value;
  const decision = reference(store.write({
    id: `${originDecisionNamespace(project)}${next()}`, kind: ORIGIN_DECISION_KIND, expected: 0,
    value: {
      projectId: project, block: value.block, attempt: value.attempt, row: value.row,
      decided: "continue after reviewing the unknown origin", approved: true,
    },
  }));
  return reference(deliveredOf(liftOriginHold(store, {
    project, hold, ground: "owner-decision", record: { ref: decision },
  })));
}

const heldCall = (f: Fixture, name = "research-price-1"): Revision<CallRecord> | null =>
  f.store.get<CallRecord>(callRecordId(PROJECT, name));
const heldLedger = (f: Fixture): Revision<CallLedger> | null => f.store.get<CallLedger>(callLedgerId(PROJECT));

class CallReadStore extends Store {
  onRead: ((id: string, revision: number | undefined) => void) | null = null;
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    this.onRead?.(id, revision);
    return super.get<T>(id, revision);
  }
}

test("readCall returns sealed exact history after settlement and source or call head movement", t => {
  const f = fixture(t, "read-history", CallReadStore), store = f.store as CallReadStore;
  const admitted = deliveredOf(recordCall(store, PROJECT, request(f)));
  const settled = deliveredOf(settleCall(store, reference(admitted.call), usage, "succeeded"));
  for (const source of [f.adapter, f.config, f.series]) {
    store.write({ id: source.id, kind: source.kind, expected: source.revision, value: { later: true } });
  }
  store.write({ id: admitted.call.id, kind: CALL_RECORD_KIND, expected: 2, value: null });
  store.write({ id: settled.ledger.id, kind: CALL_LEDGER_KIND, expected: settled.ledger.revision, value: null });
  const reads: { id: string; revision: number | undefined }[] = [];
  store.onRead = (id, revision) => { reads.push({ id, revision }); };

  const open = deliveredOf(readCall(store, PROJECT, reference(admitted.call)));
  const closed = deliveredOf(readCall(store, PROJECT, reference(settled.call)));
  assert.deepEqual(open, admitted.call);
  assert.deepEqual(closed, settled.call);
  assert.ok(deeplyFrozen(open) && deeplyFrozen(closed));
  assert.notEqual(open, admitted.call);
  assert.deepEqual(reads, [
    { id: admitted.call.id, revision: 1 },
    { id: admitted.call.id, revision: 2 },
    { id: admitted.call.id, revision: 1 },
  ]);
  assert.equal(store.history(admitted.call.id).length, 3);
  assert.equal(store.history(settled.ledger.id).length, 3);
});

test("readCall rejects malformed arguments and foreign namespaces before storage", t => {
  const f = fixture(t, "read-arguments", CallReadStore), store = f.store as CallReadStore;
  const ref = reference(deliveredOf(recordCall(store, PROJECT, request(f))).call);
  store.onRead = () => assert.fail("Invalid read arguments must not access storage");
  for (const invalid of [undefined, null, {}, [], "store"]) {
    assert.throws(() => readCall(invalid as never, PROJECT, ref), code("call_request_invalid"));
  }
  for (const invalid of [undefined, null, {}, [], 7, "", "alpha:child", "x".repeat(201)]) {
    addressed(readCall(store, invalid as never, ref), "call_request_invalid");
  }
  for (const invalid of [undefined, null, {}, [], "ref", 7,
    { ...ref, id: "" }, { ...ref, revision: 0 }, { ...ref, revision: 1.5 }, { ...ref, hash: "forged" },
    { ...ref, extra: true },
    ...["id", "revision", "hash"].map(field => Object.fromEntries(Object.entries(ref).filter(([key]) => key !== field))),
    ...[callRecordId("beta", "call"), callRecordId("alphabet", "call"), callLedgerId(PROJECT),
      `call-record:${PROJECT}:`, `call-record:${PROJECT}:not-a-hash`, `${ref.id}:extra`].map(id => ({ ...ref, id })),
  ]) addressed(readCall(store, PROJECT, invalid as never), "call_unresolved");
});

test("readCall refuses missing or forged references, kinds, identities and historical bodies", t => {
  const f = fixture(t, "read-forged");
  const admitted = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  const ref = reference(admitted.call);
  for (const forged of [
    { ...ref, id: callRecordId(PROJECT, "missing") }, { ...ref, hash: "f".repeat(64) }, { ...ref, revision: 2 },
  ]) addressed(readCall(f.store, PROJECT, forged), "call_unresolved");
  const wrongKind = f.store.write({ id: callRecordId(PROJECT, "wrong-kind"), kind: "other", expected: 0, value: admitted.call.value });
  addressed(readCall(f.store, PROJECT, reference(wrongKind)), "call_unresolved");
  const copied = f.store.write({ id: callRecordId(PROJECT, "copied"), kind: CALL_RECORD_KIND, expected: 0, value: admitted.call.value });
  assert.equal(copied.hash, admitted.call.hash);
  addressed(readCall(f.store, PROJECT, reference(copied)), "call_record_invalid");
  const foreign = f.store.write({ id: callRecordId(PROJECT, "foreign"), kind: CALL_RECORD_KIND, expected: 0,
    value: { ...admitted.call.value, call: "foreign", projectId: "beta" } });
  addressed(readCall(f.store, PROJECT, reference(foreign)), "call_record_invalid");
  for (const field of Object.keys(admitted.call.value)) {
    const call = `missing-${field}`, value: Record<string, unknown> = { ...admitted.call.value, call };
    delete value[field];
    const malformed = f.store.write({ id: callRecordId(PROJECT, call), kind: CALL_RECORD_KIND, expected: 0, value });
    addressed(readCall(f.store, PROJECT, reference(malformed)), "call_record_invalid");
  }
  const forgedSettlement = f.store.write({ id: ref.id, kind: CALL_RECORD_KIND, expected: 1,
    value: { ...admitted.call.value, block: "forged", status: "succeeded", usage, settledAt: admitted.call.value.openedAt } });
  addressed(readCall(f.store, PROJECT, reference(forgedSettlement)), "call_record_invalid");
  const invalidRevision = f.store.write({ id: ref.id, kind: CALL_RECORD_KIND, expected: 2, value: admitted.call.value });
  addressed(readCall(f.store, PROJECT, reference(invalidRevision)), "call_record_invalid");
  assert.deepEqual(deliveredOf(readCall(f.store, PROJECT, ref)), admitted.call);
});

test("readCall preserves storage exceptions from either the requested revision or its admission", t => {
  const f = fixture(t, "read-storage", CallReadStore), store = f.store as CallReadStore;
  const admitted = deliveredOf(recordCall(store, PROJECT, request(f)));
  const settled = deliveredOf(settleCall(store, reference(admitted.call), usage, "failed"));
  for (const revision of [1, 2]) {
    for (const failure of [new EngineError("record_corrupt", "checksum mismatch"), new Error("storage unavailable")]) {
      store.onRead = (_id, reading) => { if (reading === revision) throw failure; };
      assert.throws(() => readCall(store, PROJECT, reference(settled.call)), error => error === failure);
    }
  }
  store.onRead = null;
  assert.equal(store.history(admitted.call.id).length, 2);
  assert.equal(store.history(settled.ledger.id).length, 2);
});

test("recordCall writes the call and the one project-ledger row before dispatch, as sealed copies", t => {
  const f = fixture(t, "record");
  assert.deepEqual([...CALL_PURPOSES], ["model-research", "model-design", "stop-analysis", "origin-analysis"]);
  const packet = Object.create(null) as Record<string, Json>;
  Object.defineProperty(packet, "__proto__", { value: { literal: true }, enumerable: true });
  packet['question'] = "who produces the price?";
  const input = request(f, { packet, gaps: [...request(f).gaps].reverse() });
  const recorded = deliveredOf(recordCall(f.store, PROJECT, input));

  assert.equal(recorded.repeated, false);
  assert.equal(recorded.call.id, callRecordId(PROJECT, input.call));
  assert.equal(recorded.call.kind, CALL_RECORD_KIND);
  assert.equal(recorded.call.revision, 1);
  assert.equal(recorded.call.value.status, "open");
  assert.equal(recorded.call.value.usage, null);
  assert.equal(recorded.call.value.settledAt, null);
  assert.equal(recorded.call.value.packet.hash, hashJson(packet));
  assert.ok(recorded.call.value.packet.chars > 0);
  assert.ok(recorded.call.value.packet.bytes >= recorded.call.value.packet.chars);
  assert.equal(hashJson(recorded.call.value), recorded.call.hash);
  assert.equal(recorded.ledger.id, callLedgerId(PROJECT));
  assert.equal(recorded.ledger.kind, CALL_LEDGER_KIND);
  assert.equal(recorded.ledger.value.calls.length, 1);
  assert.deepEqual(recorded.ledger.value.calls[0]!.call, reference(recorded.call));
  assert.equal(recorded.call.value.purpose, "model-research");
  assert.equal(recorded.call.value.basis, null);
  assert.equal(recorded.ledger.value.calls[0]!.purpose, "model-research");
  assert.equal(recorded.ledger.value.calls[0]!.basis, null);
  assert.equal(hashJson(recorded.ledger.value), recorded.ledger.hash);
  assert.ok(deeplyFrozen(recorded));

  // Caller-owned objects can move after admission; neither stored bytes nor the delivered copy moves with them (T11).
  (input.gaps[0] as { consumer: string }).consumer = "changed-later";
  (input.goal.questions as string[])[0] = "changed-later";
  packet['question'] = "changed-later";
  assert.equal(heldCall(f)!.value.gaps.some(gap => gap.consumer === "changed-later"), false);
  assert.equal(heldCall(f)!.value.goal.questions.includes("changed-later"), false);
  assert.equal(heldCall(f)!.value.packet.hash, recorded.call.value.packet.hash);
  assert.deepEqual(f.store.list(CALL_RECORD_KIND).map(item => item.id), [recorded.call.id]);
  assert.deepEqual(f.store.list(CALL_LEDGER_KIND).map(item => item.id), [recorded.ledger.id]);
});

test("a normalized late repeat after settlement and restart adds no revision or row", t => {
  const f = fixture(t, "repeat");
  const base = request(f);
  const gaps = [...base.gaps, { ...base.gaps[0]! }];
  const firstRequest = request(f, {
    gaps: [...gaps].reverse(),
    goal: { ...f.goal, questions: [...f.goal.questions].reverse() },
  });
  const first = deliveredOf(recordCall(f.store, PROJECT, firstRequest));
  const settled = deliveredOf(settleCall(f.store, reference(first.call), usage, "succeeded"));
  deliveredOf(completeAttempt(f.store, {
    project: PROJECT, block: BLOCK, line: 1, attempt: 1,
    outcome: { reason: "result", achieved: [], cancelled: [], refusals: [] },
  }));
  f.store.write({ id: f.config.id, kind: f.config.kind, expected: f.config.revision, value: { changed: true } });
  f.store.close();

  const reopened = new Store(f.path);
  try {
    const repeat = deliveredOf(recordCall(reopened, PROJECT, request(f, { gaps })));
    assert.equal(repeat.repeated, true);
    assert.deepEqual(reference(repeat.call), reference(settled.call));
    assert.deepEqual(reference(repeat.ledger), reference(settled.ledger));
    assert.equal(reopened.history(first.call.id).length, 2);
    assert.equal(reopened.history(first.ledger.id).length, 2);
    assert.equal(repeat.ledger.value.calls.length, 1);
    assert.equal(repeat.call.value.gaps.length, 3); // T6 keeps multiplicity while normalizing order.
  } finally {
    reopened.close();
  }
});

test("unknown usage leaves a call open; known usage closes call and ledger once, survives restart, and has no amount ceiling", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-call-restart-"));
  const path = join(root, "state.sqlite");
  const firstStore = new Store(path);
  // Build the same fixture without handing cleanup of the first connection to node:test.
  const adapter = firstStore.write({ id: "adapter:alpha", kind: "adapter", expected: 0, value: {} });
  const config = firstStore.write({ id: "config:alpha", kind: "config", expected: 0, value: {} });
  deliveredOf(openSeries(firstStore, { project: PROJECT, block: BLOCK, line: 1, slice: SLICE, predecessor: null, basis: null }));
  const series = deliveredOf(beginAttempt(firstStore, { project: PROJECT, block: BLOCK, line: 1, attempt: 1, goal: goal() }));
  const f = { root, path, store: firstStore, adapter, config, series, goal: goal() } satisfies Fixture;
  const admitted = deliveredOf(recordCall(firstStore, PROJECT, request(f)));
  const unknown = deliveredOf(settleCall(firstStore, reference(admitted.call), null, "failed"));
  assert.equal(unknown.settled, false);
  assert.equal(unknown.call.value.status, "open");
  assert.equal(firstStore.history(admitted.call.id).length, 1);
  firstStore.close();

  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const enormous = {
    inputTokens: 9_000_000_000_000, outputTokens: 8_000_000_000_000,
    cachedInputTokens: 8_000_000_000_000, reasoningOutputTokens: 7_000_000_000_000,
  };
  const settled = deliveredOf(settleCall(store, reference(admitted.call), enormous, "succeeded"));
  assert.equal(settled.settled, true);
  assert.equal(settled.repeated, false);
  assert.equal(settled.call.revision, 2);
  assert.deepEqual(settled.call.value.usage, enormous);
  assert.equal(settled.call.value.status, "succeeded");
  assert.equal(settled.ledger.revision, 2);
  assert.deepEqual(settled.ledger.value.calls[0]!.usage, enormous);
  assert.deepEqual(settled.ledger.value.calls[0]!.call, reference(settled.call));

  const repeated = deliveredOf(settleCall(store, reference(admitted.call), enormous, "succeeded"));
  assert.equal(repeated.repeated, true);
  assert.deepEqual(reference(repeated.call), reference(settled.call));
  assert.equal(store.history(admitted.call.id).length, 2);
  assert.equal(store.history(settled.ledger.id).length, 2);
});

test("token counters use tokenUsage exactly and any different final usage or status conflicts", t => {
  const f = fixture(t, "usage");
  const admitted = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  for (const invalid of [
    { inputTokens: -1, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 },
    { inputTokens: 1.5, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 },
    { inputTokens: 1, outputTokens: 0, cachedInputTokens: 2, reasoningOutputTokens: 0 },
    { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 },
  ]) {
    addressed(settleCall(f.store, reference(admitted.call), invalid as never, "failed"), "usage_invalid");
    assert.equal(heldCall(f)!.revision, 1);
  }
  const measured = { ...usage, cachedInputTokens: null, reasoningOutputTokens: null };
  const settled = deliveredOf(settleCall(f.store, reference(admitted.call), measured, "failed"));
  addressed(settleCall(f.store, reference(admitted.call), { ...measured, outputTokens: 31 }, "failed"), "settlement_conflict");
  addressed(settleCall(f.store, reference(admitted.call), measured, "succeeded"), "settlement_conflict");
  addressed(settleCall(f.store, reference(admitted.call), null, "failed"), "settlement_conflict");
  assert.deepEqual(reference(heldCall(f)!), reference(settled.call));
  assert.equal(heldLedger(f)!.revision, 2);
});

test("a stop-analysis call binds to the standing first-rung stop without opening attempt four", t => {
  const f = fixture(t, "stop-analysis");
  const stopped = stoppedSeries(f);
  const reviewGoal = analysisGoal("the saved stop");
  const input = request(f, {
    call: "review-stop-3", purpose: "stop-analysis",
    basis: { kind: "series-stop", series: reference(stopped), attempt: 3 },
    gaps: analysisGaps(`${stopped.id}:stop:3`, reviewGoal, "cause-and-change"),
    series: reference(stopped), attempt: 3, goal: reviewGoal,
  });
  const recorded = deliveredOf(recordCall(f.store, PROJECT, input));
  assert.equal(recorded.call.value.purpose, "stop-analysis");
  assert.deepEqual(recorded.call.value.basis, input.basis);
  assert.deepEqual(recorded.ledger.value.calls[0]!.basis, input.basis);
  assert.equal(f.store.get<RepairSeries>(stopped.id)!.revision, stopped.revision);
  assert.equal(f.store.get<RepairSeries>(stopped.id)!.value.stop?.attempt, 3);
  assert.equal(f.store.get<RepairSeries>(stopped.id)!.value.attempts.length, 3);

  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "ordinary-after-stop", purpose: "model-design", basis: null,
    series: reference(stopped), attempt: 3, goal: f.goal,
  })), "call_series_unresolved");
  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "foreign-stop", purpose: "stop-analysis",
    basis: { kind: "series-stop", series: reference(f.series), attempt: 1 },
    gaps: analysisGaps(`${stopped.id}:stop:3`, reviewGoal, "cause-and-change"),
    series: reference(stopped), attempt: 3, goal: reviewGoal,
  })), "call_basis_unresolved");

  const resumed = deliveredOf(resumeSeries(f.store, {
    project: PROJECT, block: BLOCK, line: 1, stop: 3,
    ground: "review-record", text: "the independent review named an addressed change",
    review: { ref: stopReview(f.store, stopped) },
  }));
  assert.equal(resumed.value.stop, null);
  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "review-lifted-stop", purpose: "stop-analysis",
    basis: { kind: "series-stop", series: reference(resumed), attempt: 3 },
    gaps: analysisGaps(`${resumed.id}:stop:3`, reviewGoal, "cause-and-change"),
    series: reference(resumed), attempt: 3, goal: reviewGoal,
  })), "call_basis_unresolved");

  const late = deliveredOf(recordCall(f.store, PROJECT, input));
  assert.equal(late.repeated, true);
  assert.deepEqual(reference(late.call), reference(recorded.call));
  assert.equal(f.store.history(recorded.call.id).length, 1);
  assert.equal(heldLedger(f)!.value.calls.length, 1);
});

test("an origin-analysis call binds to its standing hold after close and rejects foreign or lifted holds", t => {
  const f = fixture(t, "origin-analysis");
  const own = raisedHold(f.store, PROJECT, f.goal);
  const reviewGoal = analysisGoal("the unknown refusal origin");
  const input = request(f, {
    call: "review-origin-1", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold: own.hold },
    gaps: analysisGaps(own.hold.id, reviewGoal, "origin"),
    series: reference(own.series), attempt: 1, goal: reviewGoal,
  });
  const seriesRevision = own.series.revision;
  const recorded = deliveredOf(recordCall(f.store, PROJECT, input));
  assert.equal(recorded.call.value.purpose, "origin-analysis");
  assert.deepEqual(recorded.call.value.basis, input.basis);
  assert.equal(f.store.get<RepairSeries>(own.series.id)!.revision, seriesRevision);
  assert.equal(f.store.get<RepairSeries>(own.series.id)!.value.attempts.length, 1);
  assert.equal(f.store.get<OriginHold>(own.hold.id)!.value.lift, null);

  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "ordinary-after-hold", purpose: "model-research", basis: null,
    series: reference(own.series), attempt: 1, goal: f.goal,
  })), "call_series_unresolved");
  const foreign = raisedHold(f.store, PROJECT, f.goal, true, "block:foreign-cart");
  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "foreign-origin-hold", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold: foreign.hold },
    gaps: analysisGaps(foreign.hold.id, reviewGoal, "origin"),
    series: reference(own.series), attempt: 1, goal: reviewGoal,
  })), "call_basis_unresolved");
  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "forged-origin-hold", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold: { ...own.hold, hash: "f".repeat(64) } },
    gaps: analysisGaps(own.hold.id, reviewGoal, "origin"),
    series: reference(own.series), attempt: 1, goal: reviewGoal,
  })), "call_basis_unresolved");

  const lifted = liftByOwner(f.store, PROJECT, own.hold);
  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "old-origin-hold", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold: own.hold },
    gaps: analysisGaps(own.hold.id, reviewGoal, "origin"),
    series: reference(own.series), attempt: 1, goal: reviewGoal,
  })), "call_basis_unresolved");
  addressed(recordCall(f.store, PROJECT, request(f, {
    call: "lifted-origin-hold", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold: lifted },
    gaps: analysisGaps(lifted.id, reviewGoal, "origin"),
    series: reference(own.series), attempt: 1, goal: reviewGoal,
  })), "call_basis_unresolved");

  const late = deliveredOf(recordCall(f.store, PROJECT, input));
  assert.equal(late.repeated, true);
  assert.deepEqual(reference(late.call), reference(recorded.call));
  assert.equal(f.store.history(recorded.call.id).length, 1);
  assert.equal(heldLedger(f)!.value.calls.length, 1);
});

test("every refusal introduced by E1 is produced with an address and route", t => {
  const seen = new Set<string>();
  const take = <T>(result: OmResult<T>, expected: string): Refusal => {
    const refusal = addressed(result, expected);
    seen.add(refusal.code);
    return refusal;
  };

  let f = fixture(t, "codes-request");
  take(recordCall(f.store, PROJECT, { ...request(f), extra: "status" } as never), "call_request_invalid");

  f = fixture(t, "codes-question-missing");
  take(recordCall(f.store, PROJECT, request(f, { gaps: [] })), "call_question_missing");

  f = fixture(t, "codes-question-invalid");
  take(recordCall(f.store, PROJECT, request(f, { gaps: [{ id: "g", goal: "g", field: "f" } as never] })), "call_question_invalid");

  f = fixture(t, "codes-goal-missing");
  take(recordCall(f.store, PROJECT, request(f, { goal: null as never })), "call_goal_missing");

  f = fixture(t, "codes-goal-invalid");
  take(recordCall(f.store, PROJECT, request(f, { goal: { key: "g", questions: [], result: "r" } })), "call_goal_invalid");

  f = fixture(t, "codes-goal-conflict");
  take(recordCall(f.store, PROJECT, request(f, { goal: goal({ result: "a different result" }) })), "call_goal_conflict");

  f = fixture(t, "codes-purpose");
  take(recordCall(f.store, PROJECT, request(f, { purpose: "other" as never })), "call_purpose_invalid");

  f = fixture(t, "codes-basis-invalid");
  take(recordCall(f.store, PROJECT, request(f, {
    basis: { kind: "series-stop", series: reference(f.series), attempt: 1 },
  })), "call_basis_invalid");

  f = fixture(t, "codes-basis-unresolved");
  take(recordCall(f.store, PROJECT, request(f, {
    purpose: "stop-analysis", basis: { kind: "series-stop", series: reference(f.series), attempt: 1 },
    goal: analysisGoal("a stop that does not stand"),
  })), "call_basis_unresolved");

  f = fixture(t, "codes-series");
  take(recordCall(f.store, PROJECT, request(f, { series: { ...reference(f.series), id: "repair-series:beta:1:block:cart" } })), "call_series_unresolved");

  f = fixture(t, "codes-dispatch-invalid");
  take(recordCall(f.store, PROJECT, request(f, {
    dispatch: { adapter: { ...reference(f.adapter), status: "accepted" } as never, config: reference(f.config) },
  })), "dispatch_contract_invalid");

  f = fixture(t, "codes-dispatch-unresolved");
  take(recordCall(f.store, PROJECT, request(f, {
    dispatch: { adapter: { ...reference(f.adapter), hash: "0".repeat(64) }, config: reference(f.config) },
  })), "dispatch_contract_unresolved");

  f = fixture(t, "codes-packet");
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  take(recordCall(f.store, PROJECT, request(f, { packet: cyclic as Json })), "packet_invalid");

  f = fixture(t, "codes-identity");
  deliveredOf(recordCall(f.store, PROJECT, request(f)));
  take(recordCall(f.store, PROJECT, request(f, { packet: { different: true } })), "call_identity_conflict");

  f = fixture(t, "codes-record");
  const badId = callRecordId(PROJECT, "research-price-1");
  f.store.write({ id: badId, kind: CALL_RECORD_KIND, expected: 0, value: { status: "accepted", projectId: PROJECT } });
  take(recordCall(f.store, PROJECT, request(f)), "call_record_invalid");

  f = fixture(t, "codes-ledger");
  const ledgerCall = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  f.store.write({ id: ledgerCall.ledger.id, kind: CALL_LEDGER_KIND, expected: 1,
    value: { projectId: PROJECT, calls: [null] } });
  take(recordCall(f.store, PROJECT, request(f)), "ledger_invalid");

  f = fixture(t, "codes-call-unresolved");
  take(settleCall(f.store, { id: "call-record:absent", revision: 1, hash: "a".repeat(64) }, usage, "failed"), "call_unresolved");

  f = fixture(t, "codes-status");
  const statusCall = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  take(settleCall(f.store, reference(statusCall.call), usage, "accepted" as never), "settlement_status_invalid");

  f = fixture(t, "codes-conflict");
  const conflictCall = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  deliveredOf(settleCall(f.store, reference(conflictCall.call), usage, "succeeded"));
  take(settleCall(f.store, reference(conflictCall.call), { ...usage, inputTokens: 121 }, "succeeded"), "settlement_conflict");

  f = fixture(t, "codes-usage");
  const usageCall = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  take(settleCall(f.store, reference(usageCall.call), { ...usage, inputTokens: -1 }, "failed"), "usage_invalid");

  assert.deepEqual([...seen].sort(), [...CALL_RECORD_CODES].sort());
});

test("absent arguments, sets and fields fail with typed codes before field access or storage", t => {
  const f = fixture(t, "absence");
  for (const value of [undefined, null, "request", 7, []]) {
    addressed(recordCall(f.store, PROJECT, value as never), "call_request_invalid");
  }
  for (const field of ["call", "purpose", "basis", "block", "gaps", "series", "attempt", "goal", "dispatch", "packet"] as const) {
    const value = { ...request(f) } as Record<string, unknown>;
    delete value[field];
    const refusal = refusalOf(recordCall(f.store, PROJECT, value as never));
    assert.ok(CALL_RECORD_CODES.includes(refusal.code as never), `${field} produced ${refusal.code}`);
    assert.equal(refusal.at.unit, UNIT);
  }
  addressed(recordCall(f.store, null as never, request(f)), "call_request_invalid");
  assert.throws(() => recordCall(null as never, PROJECT, request(f)), code("call_request_invalid"));
  assert.throws(() => callRecordId(undefined as never, "call"), code("call_request_invalid"));
  assert.throws(() => callRecordId(PROJECT, undefined as never), code("call_request_invalid"));
  assert.throws(() => callLedgerId(undefined as never), code("call_request_invalid"));
  addressed(settleCall(f.store, null as never, usage, "failed"), "call_unresolved");
  const admitted = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  assert.throws(() => settleCall(null as never, reference(admitted.call), usage, "failed"), code("settlement_request_invalid"));
  addressed(settleCall(f.store, reference(admitted.call), usage, undefined as never), "settlement_status_invalid");
  addressed(settleCall(f.store, reference(admitted.call), undefined as never, "failed"), "usage_invalid");
  assert.equal(f.store.history(admitted.call.id).length, 1);
});

test("foreign series, forged hashes and status masquerades cannot stand for exact sources", t => {
  const f = fixture(t, "masquerade");
  deliveredOf(openSeries(f.store, {
    project: "beta", block: BLOCK, line: 1, slice: "slice:beta-cart@1", predecessor: null, basis: null,
  }));
  const foreign = deliveredOf(beginAttempt(f.store, {
    project: "beta", block: BLOCK, line: 1, attempt: 1, goal: f.goal,
  }));
  addressed(recordCall(f.store, PROJECT, request(f, { series: reference(foreign) })), "call_series_unresolved");
  addressed(recordCall(f.store, PROJECT, request(f, {
    dispatch: { adapter: { ...reference(f.adapter), hash: "f".repeat(64) }, config: reference(f.config) },
  })), "dispatch_contract_unresolved");

  const disguised = f.store.write({
    id: seriesId(PROJECT, BLOCK, 2), kind: "repair-series", expected: 0,
    value: { projectId: PROJECT, block: BLOCK, line: 2, status: "accepted" },
  });
  addressed(recordCall(f.store, PROJECT, request(f, { series: reference(disguised) })), "call_series_unresolved");
  const emptySeries = f.store.write({
    id: seriesId(PROJECT, BLOCK, 3), kind: "repair-series", expected: 0, value: null,
  });
  addressed(recordCall(f.store, PROJECT, request(f, { series: reference(emptySeries) })), "call_series_unresolved");
  const longBlock = "block:" + "x".repeat(220);
  const longSeries = f.store.write({
    id: "repair-series:forged-long", kind: "repair-series", expected: 0,
    value: { projectId: PROJECT, block: longBlock, line: 1 },
  });
  addressed(recordCall(f.store, PROJECT, request(f, {
    block: longBlock, series: reference(longSeries),
  })), "call_series_unresolved");

  const admitted = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  const forged = f.store.write({
    id: admitted.call.id, kind: CALL_RECORD_KIND, expected: admitted.call.revision,
    value: {
      ...admitted.call.value, block: "block:forged", status: "succeeded",
      usage, settledAt: admitted.call.value.openedAt,
    },
  });
  addressed(settleCall(f.store, reference(forged), usage, "succeeded"), "call_record_invalid");
  assert.equal(heldLedger(f)!.revision, 1);
  const emptyCall = f.store.write({
    id: forged.id, kind: CALL_RECORD_KIND, expected: forged.revision, value: null,
  });
  addressed(settleCall(f.store, reference(emptyCall), usage, "succeeded"), "call_record_invalid");
  assert.equal(heldLedger(f)!.revision, 1);
});

test("every record and settlement path rejects partial or total ledger loss derived from saved calls", t => {
  const paths = ["create-other", "repeat-other", "settle-other", "unknown-other"] as const;
  for (const loss of ["partial", "total"] as const) {
    for (const path of paths) {
      const f = fixture(t, `ledger-${loss}-${path}`);
      const closed = deliveredOf(recordCall(f.store, PROJECT, request(f, { call: `closed-${loss}-${path}` })));
      deliveredOf(settleCall(f.store, reference(closed.call), usage, "succeeded"));
      const otherRequest = request(f, { call: `other-${loss}-${path}`, purpose: "model-design" });
      const other = deliveredOf(recordCall(f.store, PROJECT, otherRequest));
      const ledger = heldLedger(f)!;
      const otherRow = ledger.value.calls.find(row => row.call.id === other.call.id)!;
      f.store.write({
        id: ledger.id, kind: CALL_LEDGER_KIND, expected: ledger.revision,
        value: { projectId: PROJECT, calls: loss === "partial" ? [otherRow] : [] },
      });
      const before = {
        calls: f.store.list(CALL_RECORD_KIND).map(reference),
        ledger: reference(heldLedger(f)!),
        histories: f.store.list(CALL_RECORD_KIND).map(call => [call.id, f.store.history(call.id).length] as const),
      };
      const result = path === "create-other"
        ? recordCall(f.store, PROJECT, request(f, { call: `new-${loss}-${path}` }))
        : path === "repeat-other"
          ? recordCall(f.store, PROJECT, otherRequest)
          : settleCall(f.store, reference(other.call), path === "unknown-other" ? null : usage, "failed");
      addressed(result, "ledger_invalid");
      assert.deepEqual(f.store.list(CALL_RECORD_KIND).map(reference), before.calls, `${loss}/${path}: calls changed`);
      assert.deepEqual(reference(heldLedger(f)!), before.ledger, `${loss}/${path}: ledger changed`);
      assert.deepEqual(
        f.store.list(CALL_RECORD_KIND).map(call => [call.id, f.store.history(call.id).length] as const),
        before.histories, `${loss}/${path}: history changed`,
      );
      assert.equal(heldCall(f, `new-${loss}-${path}`), null);
      assert.equal(heldCall(f, otherRequest.call)!.value.status, "open");
      assert.equal(heldCall(f, closed.call.value.call)!.value.status, "succeeded");
    }
  }
});

// A second connection commits after this unit has read a head and before writeGuarded checks it.
class RacingStore extends Store {
  target = "";
  remaining = 0;
  run: ((store: Store) => void) | null = null;
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    const found = super.get<T>(id, revision);
    if (id === this.target && this.remaining > 0) {
      this.remaining -= 1;
      if (this.remaining === 0 && this.run) {
        const run = this.run;
        this.run = null;
        const other = new Store(this.path);
        try { run(other); } finally { other.close(); }
      }
    }
    return found;
  }
}

test("a dispatch or ledger head changed in the check/write window refuses the whole transaction (T7)", t => {
  let f = fixture(t, "race-admit", RacingStore);
  let store = f.store as RacingStore;
  store.target = f.config.id;
  store.remaining = 2; // exact revision, then its head
  store.run = other => {
    other.write({ id: f.config.id, kind: f.config.kind, expected: f.config.revision, value: { changed: "between" } });
  };
  const staleDispatch = addressed(recordCall(store, PROJECT, request(f)), "input_stale");
  assert.deepEqual(staleDispatch.at.ref, reference(f.config));
  assert.equal(heldCall(f), null);
  assert.equal(heldLedger(f), null);

  f = fixture(t, "race-settle", RacingStore);
  store = f.store as RacingStore;
  const admitted = deliveredOf(recordCall(store, PROJECT, request(f)));
  const ledger = heldLedger(f)!;
  store.target = ledger.id;
  store.remaining = 1;
  store.run = other => {
    other.write({ id: ledger.id, kind: ledger.kind, expected: ledger.revision, value: ledger.value });
  };
  const staleLedger = addressed(settleCall(store, reference(admitted.call), usage, "succeeded"), "input_stale");
  assert.deepEqual(staleLedger.at.ref, reference(ledger));
  assert.equal(heldCall(f)!.value.status, "open");
  assert.equal(heldCall(f)!.revision, 1);
  assert.equal(heldLedger(f)!.revision, 2);

  f = fixture(t, "race-stop", RacingStore);
  store = f.store as RacingStore;
  const stopped = stoppedSeries(f);
  const review = stopReview(store, stopped);
  store.target = stopped.id;
  store.remaining = 2; // exact historical revision, then the current head read by readSeries
  store.run = other => {
    deliveredOf(resumeSeries(other, {
      project: PROJECT, block: BLOCK, line: 1, stop: 3,
      ground: "review-record", text: "the independent review named an addressed change", review: { ref: review },
    }));
  };
  const staleStop = addressed(recordCall(store, PROJECT, request(f, {
    call: "race-stop-analysis", purpose: "stop-analysis",
    basis: { kind: "series-stop", series: reference(stopped), attempt: 3 },
    gaps: analysisGaps(`${stopped.id}:stop:3`, analysisGoal("the saved stop"), "cause-and-change"),
    series: reference(stopped), attempt: 3, goal: analysisGoal("the saved stop"),
  })), "input_stale");
  assert.deepEqual(staleStop.at.ref, reference(stopped));
  assert.equal(heldCall(f, "race-stop-analysis"), null);
  assert.equal(heldLedger(f), null);

  f = fixture(t, "race-origin", RacingStore);
  store = f.store as RacingStore;
  const held = raisedHold(store, PROJECT, f.goal);
  store.target = held.hold.id;
  store.remaining = 1;
  store.run = other => { liftByOwner(other, PROJECT, held.hold); };
  const staleHold = addressed(recordCall(store, PROJECT, request(f, {
    call: "race-origin-analysis", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold: held.hold },
    gaps: analysisGaps(held.hold.id, analysisGoal("the unknown refusal origin"), "origin"),
    series: reference(held.series), attempt: 1, goal: analysisGoal("the unknown refusal origin"),
  })), "input_stale");
  assert.deepEqual(staleHold.at.ref, held.hold);
  assert.equal(heldCall(f, "race-origin-analysis"), null);
  assert.equal(heldLedger(f), null);
});

test("two admitted calls share one ledger, stay distinguishable, and settle independently", t => {
  const f = fixture(t, "several");
  const first = deliveredOf(recordCall(f.store, PROJECT, request(f, { call: "same-purpose-a" })));
  const second = deliveredOf(recordCall(f.store, PROJECT, request(f, { call: "same-purpose-b", purpose: "model-design" })));
  assert.notEqual(first.call.id, second.call.id);
  assert.equal(second.ledger.value.calls.length, 2);
  assert.deepEqual(second.ledger.value.calls.map(row => row.name).sort(), ["same-purpose-a", "same-purpose-b"]);
  assert.equal(second.ledger.value.calls.find(row => row.name === "same-purpose-b")!.purpose, "model-design");
  const closed = deliveredOf(settleCall(f.store, reference(first.call), usage, "succeeded"));
  assert.equal(closed.ledger.value.calls.find(row => row.name === "same-purpose-a")!.status, "succeeded");
  assert.equal(closed.ledger.value.calls.find(row => row.name === "same-purpose-b")!.status, "open");
  assert.equal(f.store.history(second.call.id).length, 1);
});

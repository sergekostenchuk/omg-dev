import { answerDiscoveryFixture, currentUpstreamFixtureValue } from './product-fixture.js';
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { isRef, reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision, type Write, type ReadGuard } from "../src/storage/store.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import {
  beginAttempt, completeAttempt, openSeries, resumeSeries, escalateSeries, readSeriesAt, seriesId, stopReviewNamespace, STOP_REVIEW_KIND,
  prepareSeriesAdmission, readMechanismAdmission, readCompletionBinding, completionWorkId,
  type AttemptGoal, type RepairSeries, type AnyRepairSeries, type MechanismAdmission,
} from "../src/om/series.js";
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from "../src/om/refusal-journal.js";
import {
  closeAttempt, liftOriginHold, openAttempt, originDecisionNamespace, prepareManagedClaim,
  ORIGIN_DECISION_KIND, type GateOutcome, type OriginHold,
} from "../src/om/repeat-gate.js";
import {
  callLedgerId, callRecordId, readCall, prepareCallDispatch, recordCall, settleCall,
  CALL_LEDGER_KIND, CALL_PURPOSES, CALL_RECORD_CODES, CALL_RECORD_KIND,
  type CallLedger, type CallRecord, type RecordCallRequest, type MechanismRecordCallRequest, type AnyCallRecord,
} from "../src/om/call-record.js";
import { writeGuarded } from "../src/om/refs.js";

import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { designOf } from "../src/graph/builder.js";
import type { Question } from "../src/discovery/discovery.js";
import { Evidence, type Source } from "../src/evidence/evidence.js";
import { projectGraph } from "../src/graph/project.js";
import type { Graph } from "../src/graph/model.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { writeRoutes } from "../src/om/routes.js";
import { prepareQuestionTasks, writeQuestionPacket, type QuestionPacketRecord } from "../src/om/question-packet.js";
import { readModelCallState, readModelTransport, recoverOmModelCall, runModelCall, runModelTransport, readCompletionWorkAt, writeCompletionCessation, prepareCompletionCall } from "../src/om/model-call.js";
import { readAssessmentIntentAt, writeAssessmentIntent, assessFact } from "../src/om/assessment.js";
import { gapLineKey, gapLineExpectedResult } from "../src/om/gap-lines.js";
import { gardenGraph } from "./om-fixture.js";
import { managedBlock } from "./om-managed-block.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

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

function addressed(result: OmResult<unknown>, expected: string): Refusal {
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

function stopReview(store: Store, series: Revision<RepairSeries>, block = BLOCK): Ref {
  const stop = series.value.stop!;
  return reference(store.write({
    id: `${stopReviewNamespace(PROJECT)}${next()}`, kind: STOP_REVIEW_KIND, expected: 0,
    value: {
      projectId: PROJECT, block, stop: stop.attempt, goals: [...stop.goals],
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

/** LG07 (№10173 п.1, №9133): the goal of a stop analysis, asked as two questions so that their order is data. */
const stopGoal = (): AttemptGoal => ({
  key: "analysis:the saved stop",
  questions: ["what caused the stop?", "what exact change addresses it?"],
  result: "a review record with a cause or explicit hypothesis and an addressed change",
});

interface ManagedStop {
  readonly root: string;
  readonly path: string;
  readonly store: Store;
  readonly block: string;
  readonly series: Revision<RepairSeries>;
  readonly adapter: Revision<Json>;
  readonly config: Revision<Json>;
  /** What the paid attempts left: every count of the tests below is relative to it. */
  readonly paid: { readonly calls: readonly Ref[]; readonly ledger: Revision<CallLedger>; readonly history: number };
}

/**
 * LG07 (№10173 п.1, №9133): a real first-rung stop — three managed attempts whose E5 found the fact insufficient, each
 * closed by G7 — and the dispatch records a direct stop analysis is sent through. On the managed path an ordinary
 * research E1 is exactly its E2 (the product E1 test below); a stop analysis is the call whose packet and gaps are the
 * caller's transport data.
 */
async function managedStop(t: test.TestContext, label: string): Promise<ManagedStop> {
  const root = mkdtempSync(join(tmpdir(), `omg-om-call-${label}-`)), path = join(root, "state.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const m = managedBlock(store, { root, path }, PROJECT);
  deliveredOf(openSeries(store, { ...m.address(), slice: SLICE, predecessor: null, basis: null }));
  for (let attempt = 1; attempt <= 3; attempt += 1) await m.cycle("gap:cart:price", "insufficient");
  const series = store.get<RepairSeries>(seriesId(PROJECT, m.block, 1))!;
  assert.deepEqual(series.value.stop?.attempts, [1, 2, 3]);
  assert.ok(series.value.ladder.grounds.includes("review-record"));
  const adapter = store.write({ id: `adapter:${PROJECT}`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: PROJECT, protocol: "codex-stdio", status: "configured-not-accepted" } });
  const config = store.write({ id: `config:${PROJECT}`, kind: "dispatch-config", expected: 0,
    value: { projectId: PROJECT, model: "fixture", transport: "stdio", status: "configured-not-accepted" } });
  const ledger = store.get<CallLedger>(callLedgerId(PROJECT))!;
  assert.ok(ledger.value.calls.length > 0, "the stop was paid for");
  return { root, path, store, block: m.block, series, adapter, config,
    paid: { calls: store.list(CALL_RECORD_KIND).map(reference), ledger, history: store.history(ledger.id).length } };
}

function stopRequest(s: ManagedStop, over: Partial<RecordCallRequest> = {}): RecordCallRequest {
  const wanted = stopGoal();
  return {
    call: "review-stop-3",
    purpose: "stop-analysis",
    basis: { kind: "series-stop", series: reference(s.series), attempt: 3 },
    block: s.block,
    gaps: [
      { id: `${s.series.id}:stop:3`, goal: wanted.key, field: "cause", consumer: "A6:stop-analysis" },
      { id: `${s.series.id}:stop:3`, goal: wanted.key, field: "change", consumer: "A6:stop-analysis" },
    ],
    series: reference(s.series), attempt: 3, goal: wanted,
    dispatch: { adapter: reference(s.adapter), config: reference(s.config) },
    packet: { question: "what stopped the price?", neighbours: ["cart", "catalogue"] },
    ...over,
  };
}

test("recordCall writes the call and the one project-ledger row before dispatch, as sealed copies", async t => {
  const s = await managedStop(t, "record");
  assert.deepEqual([...CALL_PURPOSES], ["model-research", "model-design", "stop-analysis", "origin-analysis", "fact-assessment", "wake-choice"]);
  const packet = Object.create(null) as Record<string, Json>;
  Object.defineProperty(packet, "__proto__", { value: { literal: true }, enumerable: true });
  packet['question'] = "what stopped the price?";
  const input = stopRequest(s, { packet, gaps: [...stopRequest(s).gaps].reverse() });
  const recorded = deliveredOf(recordCall(s.store, PROJECT, input));

  assert.equal(recorded.repeated, false);
  assert.equal(recorded.call.id, callRecordId(PROJECT, input.call));
  assert.equal(recorded.call.kind, CALL_RECORD_KIND);
  assert.equal(recorded.call.revision, 1);
  assert.equal(recorded.call.value.status, "open");
  assert.equal(recorded.call.value.usage, null);
  assert.equal(recorded.call.value.settledAt, null);
  assert.equal(recorded.call.value.packet.hash, hashJson(packet));
  // A packet with no declared text contract is sent as its canonical text: these are its exact sizes.
  const text = canonical(packet);
  assert.equal(recorded.call.value.packet.chars, text.length);
  assert.equal(recorded.call.value.packet.bytes, Buffer.byteLength(text, "utf8"));
  assert.equal(hashJson(recorded.call.value), recorded.call.hash);
  assert.equal(recorded.ledger.id, callLedgerId(PROJECT));
  assert.equal(recorded.ledger.kind, CALL_LEDGER_KIND);
  assert.equal(recorded.call.value.purpose, "stop-analysis");
  assert.deepEqual(recorded.call.value.basis, input.basis);
  // One row more in the project's one ledger, one revision on; the rows of the paid attempts stand as they were.
  assert.equal(recorded.ledger.revision, s.paid.ledger.revision + 1);
  const own = recorded.ledger.value.calls.filter(row => row.call.id === recorded.call.id);
  assert.equal(own.length, 1);
  assert.deepEqual(own[0]!.call, reference(recorded.call));
  assert.equal(own[0]!.purpose, "stop-analysis");
  assert.deepEqual(own[0]!.basis, input.basis);
  assert.deepEqual(recorded.ledger.value.calls.filter(row => row.call.id !== recorded.call.id), s.paid.ledger.value.calls);
  assert.equal(hashJson(recorded.ledger.value), recorded.ledger.hash);
  assert.ok(deeplyFrozen(recorded));
  // The analysis opens no attempt four, and the stop it analyses stands.
  assert.deepEqual(s.store.get<RepairSeries>(s.series.id), s.series);

  // Caller-owned objects can move after admission; neither stored bytes nor the delivered copy moves with them (T11).
  (input.gaps[0] as { consumer: string }).consumer = "changed-later";
  (input.goal.questions as string[])[0] = "changed-later";
  packet['question'] = "changed-later";
  const held = s.store.get<CallRecord>(callRecordId(PROJECT, input.call))!;
  assert.equal(held.value.gaps.some(gap => gap.consumer === "changed-later"), false);
  assert.equal(held.value.goal.questions.includes("changed-later"), false);
  assert.equal(held.value.packet.hash, recorded.call.value.packet.hash);
  assert.equal(recorded.call.value.gaps.some(gap => gap.consumer === "changed-later"), false);
  assert.deepEqual(s.store.list(CALL_RECORD_KIND).map(item => item.id).sort(), [...s.paid.calls.map(ref => ref.id), recorded.call.id].sort());
  assert.deepEqual(s.store.list(CALL_LEDGER_KIND).map(item => item.id), [recorded.ledger.id]);
});

test("a normalized late repeat after settlement and restart adds no revision or row", async t => {
  const s = await managedStop(t, "repeat");
  const base = stopRequest(s);
  // The same three questions, one of them twice, in two different orders: [B, A, A] first, [A, B, A] at the repeat.
  const gaps = [...base.gaps, { ...base.gaps[0]! }];
  const firstRequest = stopRequest(s, {
    gaps: [{ ...base.gaps[1]! }, { ...base.gaps[0]! }, { ...base.gaps[0]! }],
    goal: { ...base.goal, questions: [...base.goal.questions].reverse() },
  });
  assert.notDeepEqual(firstRequest.gaps, gaps);
  const first = deliveredOf(recordCall(s.store, PROJECT, firstRequest));
  const settled = deliveredOf(settleCall(s.store, reference(first.call), usage, "succeeded"));
  // Later events move the series and the current dispatch on: an independent review resumes the stop, and the
  // configuration changes. The admitted call stands on neither.
  deliveredOf(resumeSeries(s.store, { project: PROJECT, block: s.block, line: 1, stop: 3, ground: "review-record",
    text: "the independent review named an addressed change", review: { ref: stopReview(s.store, s.series, s.block) } }));
  s.store.write({ id: s.config.id, kind: s.config.kind, expected: s.config.revision, value: { changed: true } });
  const before = s.store.list().map(reference);
  s.store.close();

  const reopened = new Store(s.path);
  try {
    const repeat = deliveredOf(recordCall(reopened, PROJECT, stopRequest(s, { gaps })));
    assert.equal(repeat.repeated, true);
    assert.deepEqual(reference(repeat.call), reference(settled.call));
    assert.deepEqual(reference(repeat.ledger), reference(settled.ledger));
    assert.deepEqual(repeat.call.value.usage, usage);
    assert.equal(reopened.history(first.call.id).length, 2);
    assert.equal(reopened.history(first.ledger.id).length, s.paid.history + 2);
    assert.equal(repeat.ledger.value.calls.length, s.paid.ledger.value.calls.length + 1);
    assert.equal(repeat.call.value.gaps.length, 3); // T6 keeps multiplicity while normalizing order.
    assert.deepEqual(reopened.list().map(reference), before);
  } finally {
    reopened.close();
  }
});

/** LG07 (№10173 п.2, №9133): the research E1 its own E2 assignment derives — its call, packet, gaps, goal and dispatch. */
function productE1(f: ReturnType<typeof factAssessmentFixture>): RecordCallRequest {
  const payload = (f.packet as Revision<QuestionPacketRecord>).value.packet as unknown as Record<string, Json>
    & { requestId: string; purpose: "model-research" | "model-design" };
  return {
    call: payload.requestId, purpose: payload.purpose, basis: null, block: f.block,
    series: reference(f.series), attempt: 1, goal: f.attemptGoal, dispatch: f.dispatch, packet: payload,
    gaps: f.batch.items.flatMap(item => item.consumers.map(consumer => ({ id: item.target, goal: item.target, field: item.field, consumer }))),
  };
}

test("a product E1 is exactly the call its E2 assignment derives: an arbitrary packet or a duplicated gap is refused before any record", async t => {
  const f = factAssessmentFixture(t), lawful = productE1(f);
  const binding = deliveredOf(readCompletionBinding(f.store, f.project, reference(f.series), 1))!;
  const opaque = Object.create(null) as Record<string, Json>;
  Object.defineProperty(opaque, "__proto__", { value: { literal: true }, enumerable: true });
  opaque['question'] = "who produces the price?";
  // Each negative is the complete lawful request with one corruption.
  const corrupted: [string, RecordCallRequest, readonly [string, string, string]][] = [
    ["an arbitrary packet", { ...lawful, packet: opaque }, ["E4", lawful.call, "packet"]],
    ["a duplicated gap", { ...lawful, gaps: [...lawful.gaps, structuredClone(lawful.gaps[0]!)] }, ["E4", binding.id, "call"]],
  ];
  const prepared = f.store.list().map(reference);
  const refusedAll = () => {
    for (const [name, input, [unit, target, field]] of corrupted) {
      const found = refusalOf(recordCall(f.store, f.project, input));
      assert.deepEqual([found.code, found.at.unit, found.at.target, found.at.field], ["completion_foreign", unit, target, field], name);
      assert.deepEqual(f.store.list().map(reference), prepared, name);
    }
  };
  refusedAll();
  f.restart();
  refusedAll();

  // The lawful one writes the call, its ledger row and exactly the E4 ownership its registration derives.
  const registration = deliveredOf(prepareCompletionCall(f.store, f.project, lawful));
  assert.ok(registration.owner);
  const recorded = deliveredOf(recordCall(f.store, f.project, lawful));
  assert.equal(recorded.repeated, false);
  assert.equal(recorded.call.value.purpose, lawful.purpose);
  assert.equal(recorded.call.value.packet.hash, hashJson(lawful.packet));
  assert.equal(recorded.call.value.gaps.length, lawful.gaps.length);
  assert.equal(recorded.ledger.value.calls.filter(row => row.call.id === recorded.call.id).length, 1);
  const admitted = f.store.list().map(reference);
  const added = admitted.filter(ref => !prepared.some(item => item.id === ref.id)).map(ref => ref.id).sort();
  assert.deepEqual(added, [...new Set([recorded.call.id, recorded.ledger.id, ...registration.writes.map(write => write.id)])]
    .filter(id => !prepared.some(item => item.id === id)).sort());
  assert.deepEqual(admitted.filter(ref => prepared.some(item => item.id === ref.id && item.revision !== ref.revision)).map(ref => ref.id).sort(),
    registration.writes.map(write => write.id).filter(id => prepared.some(item => item.id === id)).sort());
  // A cold late repeat is the same call and writes nothing.
  f.restart();
  const again = deliveredOf(recordCall(f.store, f.project, lawful));
  assert.equal(again.repeated, true);
  assert.deepEqual(reference(again.call), reference(recorded.call));
  assert.deepEqual(f.store.list().map(reference), admitted);
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

test("foreign series, forged hashes and status masquerades cannot stand for exact sources", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
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

  // A malformed record occupying the successor address also blocks fresh work on the predecessor.
  addressed(recordCall(f.store, PROJECT, request(f)), "call_series_unresolved");
  const clean = fixture(t, "call-masquerade");
  const admitted = deliveredOf(recordCall(clean.store, PROJECT, request(clean)));
  const forged = clean.store.write({
    id: admitted.call.id, kind: CALL_RECORD_KIND, expected: admitted.call.revision,
    value: {
      ...admitted.call.value, block: "block:forged", status: "succeeded",
      usage, settledAt: admitted.call.value.openedAt,
    },
  });
  addressed(settleCall(clean.store, reference(forged), usage, "succeeded"), "call_record_invalid");
  assert.equal(heldLedger(clean)!.revision, 1);
  const emptyCall = clean.store.write({
    id: forged.id, kind: CALL_RECORD_KIND, expected: forged.revision, value: null,
  });
  addressed(settleCall(clean.store, reference(emptyCall), usage, "succeeded"), "call_record_invalid");
  assert.equal(heldLedger(clean)!.revision, 1);
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


test("E1 exact-series admission shares A3 validation and still requires the current owner head", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const f = fixture(t, "shared-series-reader");
  const historical = deliveredOf(readSeriesAt(f.store, PROJECT, reference(f.series)));
  assert.deepEqual(historical, f.series);
  addressed(recordCall(f.store, PROJECT, request(f, { block: "another-block" })), "call_series_unresolved");
  assert.equal(heldCall(f), null); assert.equal(heldLedger(f), null);
  deliveredOf(completeAttempt(f.store, { project: PROJECT, block: BLOCK, line: 1, attempt: 1,
    outcome: { reason: "interrupted", achieved: [], cancelled: [], refusals: [] } }));
  assert.deepEqual(deliveredOf(readSeriesAt(f.store, PROJECT, reference(f.series))), historical);
  addressed(recordCall(f.store, PROJECT, request(f)), "call_series_unresolved");
  assert.equal(heldCall(f), null); assert.equal(heldLedger(f), null);
  const current = f.store.get<RepairSeries>(f.series.id)!;
  const forged = f.store.write<RepairSeries>({ id: current.id, kind: current.kind, expected: current.revision,
    value: { ...current.value, withoutProgress: current.value.withoutProgress + 1 } });
  assert.equal(refusalOf(readSeriesAt(f.store, PROJECT, reference(forged))).code, "series_invalid");
  addressed(recordCall(f.store, PROJECT, request(f, { series: reference(forged) })), "call_series_unresolved");
  assert.equal(heldCall(f), null); assert.equal(heldLedger(f), null);
});


const mechanismOwner = { kind: "mechanism", mechanism: "M5:addressing" } as const;
function mechanismQuestion(id: string): Json {
  return { id, question: id === "encoding" ? "Which output encoding is supported?" : id === "transport" ? "Which transport needs confirmation?" : `What is ${id}?`,
    consumer: `${PROJECT}-consume-block`, moment: "om-pass", blocksCurrentStage: false, resolution: "Address this question before research" };
}
function mechanismFixture(t: test.TestContext, label: string, StoreType: typeof Store = Store, questions = ["encoding", "transport"]) {
  const f = fixture(t, label, StoreType), engine = new ProductEngine(f.store);
  const { level: _level, ...l1 } = projectGraph(gardenGraph("cross", PROJECT), 1);
  preparedFeatures(engine, PROJECT, l1 as Graph, field => {
    const value = preparedField(PROJECT, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = questions.map(mechanismQuestion);
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${PROJECT}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  let graph = f.store.get<Graph>(`graph:${PROJECT}`)!;
  let input = deliveredOf(writeOmInput(f.store, { project: PROJECT, expected: 0, stages }));
  let questionCount = questions.length;
  function task() {
    graph = f.store.get<Graph>(`graph:${PROJECT}`)!;
    const horizon = deliveredOf(writeHorizon(f.store, { project: PROJECT, input: reference(input), graph: reference(graph),
      refinement: null, available: {}, choice: { choiceVersion: `mechanism-call-${input.revision}`, features: [{ outcome: `${PROJECT}-result` }], excluded: [] } }));
    const sources: GapRequest = { project: PROJECT, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
      operations: { proposals: [], frame: { project: PROJECT, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
      works: { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${PROJECT}:2`)!) } };
    const gaps = deliveredOf(writeGaps(f.store, sources)), gapSet = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
    const routes = deliveredOf(writeRoutes(f.store, { project: PROJECT, gaps: gapSet, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
    const batch = routes.value.batches.find(batch => batch.task === "input-field" && batch.items.every(item => item.target.startsWith("discovery:") && item.consumers.length === 0))!;
    assert.ok(batch); assert.equal(batch.items.length, questionCount);
    const admission: MechanismAdmission = { gaps: gapSet, routes: reference(routes), batch: batch.id };
    return { admission, routes, gaps };
  }
  const initial = task(), ownerAddress = { project: PROJECT, owner: mechanismOwner, line: 1 };
  deliveredOf(openSeries(f.store, { ...ownerAddress, scope: initial.admission.gaps, predecessor: null, basis: null }));
  const proof = deliveredOf(prepareSeriesAdmission(f.store, ownerAddress, initial.admission));
  const attemptGoal = { key: "address-missing-fields", ...proof.goal };
  const series = deliveredOf(beginAttempt(f.store, { ...ownerAddress, attempt: 1, goal: attemptGoal, admission: initial.admission }));
  function call(admission = initial.admission, name = "mechanism-call"): MechanismRecordCallRequest {
    const proof = deliveredOf(readMechanismAdmission(f.store, { project: PROJECT, series: reference(series), attempt: 1, admission, current: false }));
    return { call: name, purpose: "model-design", basis: null, owner: mechanismOwner, admission,
      gaps: proof.gaps.map(gap => ({ id: gap.id, goal: gap.target, field: gap.field, consumer: mechanismOwner })),
      series: reference(series), attempt: 1, goal: attemptGoal,
      dispatch: { adapter: reference(f.adapter), config: reference(f.config) }, packet: { task: "address-questions", questions: [...attemptGoal.questions] } };
  }
  function refreshInventory() {
    const inventory = f.store.write({ id: `repo-inventory:${PROJECT}`, kind: "repo-inventory", expected: 0, value: { projectId: PROJECT, paths: [] } });
    input = deliveredOf(writeOmInput(f.store, { project: PROJECT, expected: input.revision, stages, inventory: reference(inventory) }));
    return task();
  }
  function addressOne() {
    input = deliveredOf(writeAddressing(f.store, { project: PROJECT, input: reference(input), graph: reference(graph),
      decisions: [{ pending: inputDecisionWrite({ project: PROJECT, input: reference(input), graph: reference(graph), layers: [],
        decision: { target: "discovery:encoding", field: "address", value: { consumer: `${PROJECT}-consume-block`, kind: "repository-fact" } } }) as Write }] }));
  }
  function replaceProducerQuestions(ids: string[]) {
    const source = f.store.get<Source>(`source:${PROJECT}:brief`)!;
    for (const stage of UPSTREAM_STAGES) {
      const draft = engine.prepare(PROJECT, stage);
      for (const id of draft.value.questions) {
        const question = f.store.get<Question>(id)!;
        if (question.value.spec.kind === "fact")
          engine.discovery.fact(id, question.revision, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
        else {
          const field = question.value.spec.field;
          const value = currentUpstreamFixtureValue(engine, PROJECT, field,
            field === "mapDesign" ? designOf(f.store.get<Graph>(`graph:${PROJECT}`)!.value) as unknown as Json : preparedField(PROJECT, field));
          if (field === "preparation") (value as Record<string, Json>).unknowns = ids.map(mechanismQuestion);
          if (stage === 'discovery' && (draft.value.contractVersion ?? 0) >= 5 && ['researchPlan','researchReport','verdict','preparation'].includes(field))
              answerDiscoveryFixture(engine, PROJECT, engine.store.get<import('../src/discovery/discovery.js').DiscoveryDraft>(draft.id)!, question, value, source);
            else engine.discovery.decision(id, question.revision, "owner", value);
        }
      }
      const previous = f.store.get(`stage:${PROJECT}:${stage}`)!;
      const produced = engine.draft(PROJECT, stage, draft.id, previous.revision);
      stages[stage] = reference(engine.pipeline.accept(PROJECT, stage, produced.revision));
    }
    assert.equal(engine.pipeline.inspect(PROJECT, "features").state, "accepted");
    input = deliveredOf(writeOmInput(f.store, { project: PROJECT, stages, expected: input.revision }));
    questionCount = ids.length;
    return task();
  }
  function addressForSuccessor() {
    input = deliveredOf(writeAddressing(f.store, { project: PROJECT, input: reference(input), graph: reference(graph),
      decisions: [{ pending: inputDecisionWrite({ project: PROJECT, input: reference(input), graph: reference(graph), layers: [],
        decision: { target: "discovery:encoding", field: "address", value: { consumer: `${PROJECT}-consume-block`, kind: "owner-decision" } } }) as Write }] }));
    questionCount -= 1;
    return task();
  }
  return { ...f, initial, ownerAddress, mechanismSeries: series, call, refreshInventory, addressOne,
    replaceProducerQuestions, addressForSuccessor, graph, input: () => input };
}

test("E1 admits an explicit mechanism owner on a fresh equivalent D1 and preserves exact history after D3 and restart", t => {
  const f = mechanismFixture(t, "mechanism-refresh"), before = reference(f.mechanismSeries);
  const legacy = deliveredOf(recordCall(f.store, PROJECT, request(f, { call: "legacy-in-mixed-ledger" })));
  const fresh = f.refreshInventory();
  const stale = recordCall(f.store, PROJECT, f.call(f.initial.admission, "stale-source"));
  addressed(stale, "call_series_unresolved");
  assert.equal(f.store.get(callRecordId(PROJECT, "stale-source")), null);
  const input = f.call(fresh.admission), saved = deliveredOf(recordCall(f.store, PROJECT, input));
  assert.equal("block" in saved.call.value, false);
  assert.deepEqual("owner" in saved.call.value && saved.call.value.owner, mechanismOwner);
  assert.deepEqual("admission" in saved.call.value && saved.call.value.admission, fresh.admission);
  assert.deepEqual(reference(f.store.get(f.mechanismSeries.id)!), before, "E1 does not rewrite A3's declaration");
  const rows = saved.ledger.value.calls;
  assert.equal(rows.length, 2); assert.ok(rows.some(row => row.call.id === legacy.call.id && "block" in row));
  assert.ok(rows.some(row => row.call.id === saved.call.id && "owner" in row && !Object.hasOwn(row, "block")));
  f.addressOne(); // The question is answered before accounting closes the admitted call.
  const completed = deliveredOf(completeAttempt(f.store, { ...f.ownerAddress, attempt: 1,
    outcome: { reason: "interrupted", achieved: [], cancelled: [], refusals: [] } }));
  assert.equal(completed.value.attempts[0]!.outcome!.reason, "interrupted");
  addressed(recordCall(f.store, PROJECT, { ...input, call: "late-new-dispatch" }), "call_series_unresolved");
  assert.equal(f.store.get(callRecordId(PROJECT, "late-new-dispatch")), null);
  const settled = deliveredOf(settleCall(f.store, reference(saved.call), usage, "succeeded"));
  assert.deepEqual("admission" in settled.call.value && settled.call.value.admission, fresh.admission);
  assert.equal(deliveredOf(recordCall(f.store, PROJECT, input)).repeated, true);
  const reopened = new Store(f.path);
  try {
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(saved.call))), saved.call);
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(settled.call))), settled.call);
    assert.equal(deliveredOf(recordCall(reopened, PROJECT, input)).repeated, true);
    assert.deepEqual(reference(reopened.get(f.mechanismSeries.id)!), reference(completed));
  } finally { reopened.close(); }
});

test("E1 mechanism admission rejects missing owner basis, foreign goal, purpose, consumers and incomplete batch without records", t => {
  const f = mechanismFixture(t, "mechanism-rejections"), valid = f.call();
  const cases: [string, unknown, string][] = [
    ["owner", { ...valid, owner: { kind: "mechanism", mechanism: "M5:other" } }, "call_request_invalid"],
    ["missing-basis", Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "admission")), "call_request_invalid"],
    ["block-masquerade", { ...valid, block: "M5:addressing" }, "call_request_invalid"],
    ["foreign-series", { ...valid, series: reference(f.series) }, "call_series_unresolved"],
    ["foreign-goal", { ...valid, goal: { ...valid.goal, result: "Unrelated result" } }, "call_goal_conflict"],
    ["foreign-purpose", { ...valid, purpose: "model-research" }, "call_purpose_invalid"],
    ["foreign-consumer", { ...valid, gaps: valid.gaps.map(gap => ({ ...gap, consumer: "M5:addressing" })) }, "call_question_invalid"],
    ["missing-question", { ...valid, gaps: valid.gaps.slice(1) }, "call_question_invalid"],
    ["duplicate-question", { ...valid, gaps: [...valid.gaps, valid.gaps[0]!] }, "call_question_invalid"],
    ["foreign-batch", { ...valid, admission: { ...valid.admission, batch: "other-task" } }, "call_series_unresolved"],
    ["incomplete-d1", { ...valid, admission: { ...valid.admission, gaps: { ...valid.admission.gaps, records: valid.admission.gaps.records.slice(1) } } }, "call_series_unresolved"],
  ];
  for (const [name, value, expected] of cases) {
    addressed(recordCall(f.store, PROJECT, { ...(value as MechanismRecordCallRequest), call: name }), expected);
    assert.equal(f.store.get(callRecordId(PROJECT, name)), null);
  }
  assert.equal(f.store.get(callLedgerId(PROJECT)), null);
  const saved = deliveredOf(recordCall(f.store, PROJECT, valid));
  const forged = { ...structuredClone(saved.call.value), goal: { ...saved.call.value.goal, result: "Forged historical result" } } as AnyCallRecord;
  // A new self-consistent opening record still cannot replace the goal proved by the exact series.
  const bad = f.store.write({ id: callRecordId(PROJECT, "forged-history"), kind: CALL_RECORD_KIND, expected: 0,
    value: { ...forged, call: "forged-history" } });
  addressed(readCall(f.store, PROJECT, reference(bad)), "call_record_invalid");
  const reopened = new Store(f.path);
  try { addressed(readCall(reopened, PROJECT, reference(bad)), "call_record_invalid"); }
  finally { reopened.close(); }
});

class MechanismCommitRaceStore extends Store {
  race: ((store: Store) => void) | null = null;
  override writeMany<T = Json>(writes: Write[], guards: ReadGuard[] = []): Revision<T>[] {
    if (this.race && writes.some(write => write.kind === CALL_RECORD_KIND)) {
      const run = this.race; this.race = null;
      const other = new Store(this.path);
      try { run(other); } finally { other.close(); }
    }
    return super.writeMany<T>(writes, guards);
  }
}

test("E1 guards the full mechanism admission through the transaction and propagates storage failures", t => {
  const f = mechanismFixture(t, "mechanism-race", MechanismCommitRaceStore), store = f.store as MechanismCommitRaceStore;
  const input = f.call();
  const failure = new EngineError("record_corrupt", "broken saved source");
  const broken = new Proxy(store, { get(target, property) {
    if (property === "get") return (id: string, revision?: number) => {
      if (id === f.initial.admission.routes.id) throw failure;
      return target.get(id, revision);
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.throws(() => recordCall(broken, PROJECT, input), error => error === failure);
  store.race = other => {
    const source = other.get(f.initial.admission.gaps.sources.input.id)!;
    other.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  };
  addressed(recordCall(store, PROJECT, input), "input_stale");
  assert.equal(store.get(callRecordId(PROJECT, input.call)), null); assert.equal(store.get(callLedgerId(PROJECT)), null);
  assert.equal(store.get(callRecordId(PROJECT, input.call)), null);
});

/**
 * LG07 m3c (№10309): the M5 mechanism of this project on the managed path. Unlike mechanismFixture it opens no block line
 * at all: its attempts are opened with their own admission and the exact completion of their MC2 batch, paid by the
 * implementer's answer off its form (E2, then E1+E4) and closed by G7 with the claim it derives. The raw dispatch records
 * are the ones a direct analysis call is sent through, as the shared fixture writes them.
 */
function managedMechanismFixture(t: test.TestContext, label: string, StoreType: typeof Store = Store, questions = ["encoding", "transport"]) {
  const root = mkdtempSync(join(tmpdir(), `omg-om-call-${label}-`)), path = join(root, "state.sqlite");
  const store = new StoreType(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const adapter = store.write({ id: `adapter:${PROJECT}`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: PROJECT, protocol: "codex-stdio", status: "configured-not-accepted" } });
  const config = store.write({ id: `config:${PROJECT}`, kind: "dispatch-config", expected: 0,
    value: { projectId: PROJECT, model: "fixture", transport: "stdio", status: "configured-not-accepted" } });
  const engine = new ProductEngine(store);
  const { level: _level, ...l1 } = projectGraph(gardenGraph("cross", PROJECT), 1);
  preparedFeatures(engine, PROJECT, l1 as Graph, field => {
    const value = preparedField(PROJECT, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = questions.map(mechanismQuestion);
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${PROJECT}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  let graph = store.get<Graph>(`graph:${PROJECT}`)!;
  let input = deliveredOf(writeOmInput(store, { project: PROJECT, expected: 0, stages }));
  let questionCount = questions.length;
  function task() {
    graph = store.get<Graph>(`graph:${PROJECT}`)!;
    const horizon = deliveredOf(writeHorizon(store, { project: PROJECT, input: reference(input), graph: reference(graph),
      refinement: null, available: {}, choice: { choiceVersion: `mechanism-call-${input.revision}`, features: [{ outcome: `${PROJECT}-result` }], excluded: [] } }));
    const sources: GapRequest = { project: PROJECT, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
      operations: { proposals: [], frame: { project: PROJECT, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
      works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${PROJECT}:2`)!) } };
    const gaps = deliveredOf(writeGaps(store, sources)), gapSet = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
    const routes = deliveredOf(writeRoutes(store, { project: PROJECT, gaps: gapSet, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
    const batch = routes.value.batches.find(batch => batch.task === "input-field" && batch.items.every(item => item.target.startsWith("discovery:") && item.consumers.length === 0))!;
    assert.ok(batch); assert.equal(batch.items.length, questionCount);
    const admission: MechanismAdmission = { gaps: gapSet, routes: reference(routes), batch: batch.id };
    return { admission, routes, gaps };
  }
  // The paid work of an attempt — its E2 packet and the E1+E4 call — runs through the scenario adapter.
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl"), steps: unknown[] = [];
  const command = { executable: process.execPath, args: [e4FixturePath, "--scenario", scenario, "--trace", trace] };
  const environment = reference(engine.environments.configure(PROJECT, { workspace: root,
    implementer: { actor: "mechanism-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "mechanism-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: 100_000 },
  store.get(`environment:${PROJECT}`)?.revision ?? 0));
  const paidAdapter = reference(store.write({ id: `adapter:${PROJECT}:mechanism`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: PROJECT, protocol: "codex-stdio" } }));
  const initial = task(), ownerAddress = { project: PROJECT, owner: mechanismOwner, line: 1 };
  deliveredOf(openSeries(store, { ...ownerAddress, scope: initial.admission.gaps, predecessor: null, basis: null }));
  const proof = deliveredOf(prepareSeriesAdmission(store, ownerAddress, initial.admission));
  const attemptGoal = { key: "address-missing-fields", ...proof.goal };
  let mechanismSeries: Revision<AnyRepairSeries> | null = null;
  /** One managed M5 attempt: opened, paid off its form, claimed as G7 derives it and closed at the gate. */
  async function cycle(attempt: number): Promise<Revision<AnyRepairSeries>> {
    const opened = deliveredOf(openAttempt(store, { ...ownerAddress, attempt, goal: attemptGoal, admission: initial.admission,
      completion: { routes: initial.admission.routes, batches: [initial.admission.batch] } } as never)) as Revision<AnyRepairSeries>;
    mechanismSeries ??= opened;
    const packet = deliveredOf(writeQuestionPacket(store, { project: PROJECT, routes: initial.admission.routes, batch: initial.admission.batch,
      environment, attempt: { series: reference(opened), ordinal: attempt }, previous: [] })).record;
    steps.push({ research: {}, usage });
    writeFileSync(scenario, JSON.stringify({ database: path, steps }));
    deliveredOf(await runModelCall(store, { project: PROJECT, packet: reference(packet), dispatch: { adapter: paidAdapter, config: environment }, role: "implementer" }));
    const claim: GateOutcome = deliveredOf(prepareManagedClaim(store, { ...ownerAddress, attempt,
      outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never)).outcome;
    deliveredOf(closeAttempt(store, { ...ownerAddress, attempt, outcome: claim } as never));
    return store.get<AnyRepairSeries>(opened.id)!;
  }
  /** Three managed attempts without progress: the real first-rung stop of the line. */
  async function stop(): Promise<Revision<AnyRepairSeries>> {
    for (const attempt of [1, 2, 3]) await cycle(attempt);
    const stopped = store.get<AnyRepairSeries>(mechanismSeries!.id)!;
    assert.deepEqual(stopped.value.stop?.attempts, [1, 2, 3]);
    assert.equal(stopped.value.ladder.rung, 1);
    assert.deepEqual(stopped.value.attempts.map(item => item.outcome?.reason), ["off-form", "off-form", "off-form"]);
    return stopped;
  }
  function call(admission = initial.admission, name = "mechanism-call"): MechanismRecordCallRequest {
    const read = deliveredOf(readMechanismAdmission(store, { project: PROJECT, series: reference(mechanismSeries!), attempt: 1, admission, current: false }));
    return { call: name, purpose: "model-design", basis: null, owner: mechanismOwner, admission,
      gaps: read.gaps.map(gap => ({ id: gap.id, goal: gap.target, field: gap.field, consumer: mechanismOwner })),
      series: reference(mechanismSeries!), attempt: 1, goal: attemptGoal,
      dispatch: { adapter: reference(adapter), config: reference(config) }, packet: { task: "address-questions", questions: [...attemptGoal.questions] } };
  }
  function refreshInventory() {
    const inventory = store.write({ id: `repo-inventory:${PROJECT}`, kind: "repo-inventory", expected: 0, value: { projectId: PROJECT, paths: [] } });
    input = deliveredOf(writeOmInput(store, { project: PROJECT, expected: input.revision, stages, inventory: reference(inventory) }));
    return task();
  }
  function addressOne() {
    input = deliveredOf(writeAddressing(store, { project: PROJECT, input: reference(input), graph: reference(graph),
      decisions: [{ pending: inputDecisionWrite({ project: PROJECT, input: reference(input), graph: reference(graph), layers: [],
        decision: { target: "discovery:encoding", field: "address", value: { consumer: `${PROJECT}-consume-block`, kind: "repository-fact" } } }) as Write }] }));
  }
  function replaceProducerQuestions(ids: string[]) {
    const source = store.get<Source>(`source:${PROJECT}:brief`)!;
    for (const stage of UPSTREAM_STAGES) {
      const draft = engine.prepare(PROJECT, stage);
      for (const id of draft.value.questions) {
        const question = store.get<Question>(id)!;
        if (question.value.spec.kind === "fact")
          engine.discovery.fact(id, question.revision, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
        else {
          const field = question.value.spec.field;
          const value = currentUpstreamFixtureValue(engine, PROJECT, field,
            field === "mapDesign" ? designOf(store.get<Graph>(`graph:${PROJECT}`)!.value) as unknown as Json : preparedField(PROJECT, field));
          if (field === "preparation") (value as Record<string, Json>).unknowns = ids.map(mechanismQuestion);
          if (stage === 'discovery' && (draft.value.contractVersion ?? 0) >= 5 && ['researchPlan','researchReport','verdict','preparation'].includes(field))
            answerDiscoveryFixture(engine, PROJECT, engine.store.get<import('../src/discovery/discovery.js').DiscoveryDraft>(draft.id)!, question, value, source);
          else engine.discovery.decision(id, question.revision, "owner", value);
        }
      }
      const previous = store.get(`stage:${PROJECT}:${stage}`)!;
      const produced = engine.draft(PROJECT, stage, draft.id, previous.revision);
      stages[stage] = reference(engine.pipeline.accept(PROJECT, stage, produced.revision));
    }
    assert.equal(engine.pipeline.inspect(PROJECT, "features").state, "accepted");
    input = deliveredOf(writeOmInput(store, { project: PROJECT, stages, expected: input.revision }));
    questionCount = ids.length;
    return task();
  }
  return { root, path, store, adapter, config, initial, ownerAddress, attemptGoal, cycle, stop, call, refreshInventory, addressOne,
    replaceProducerQuestions, get mechanismSeries() { return mechanismSeries!; } };
}

/** LG07 m3c (№10309): every record's exact head — a refusal or a repeat after real paid work hides no partial write. */
const fullSnapshot = (store: Store): Ref[] => store.list().map(reference);

test("E1 mechanism stop analysis preserves its own exact ground after a real managed stop, D3 and settlement", async t => {
  const f = managedMechanismFixture(t, "mechanism-stop-analysis"), stopped = await f.stop();
  const ordinary = f.call(), wanted = analysisGoal("mechanism stop");
  const paid = f.store.get<CallLedger>(callLedgerId(PROJECT))!;
  assert.equal(paid.value.calls.length, 3, "one paid E1 for each managed attempt");
  const stopCall: MechanismRecordCallRequest = { ...ordinary, call: "mechanism-stop", purpose: "stop-analysis",
    basis: { kind: "series-stop", series: reference(stopped), attempt: 3 }, series: reference(stopped), attempt: 3,
    goal: wanted, gaps: [{ id: stopped.id, goal: wanted.key, field: "stop", consumer: mechanismOwner }] };
  const admitted = deliveredOf(recordCall(f.store, PROJECT, stopCall));
  assert.equal(admitted.call.value.purpose, "stop-analysis");
  assert.deepEqual(admitted.call.value.basis, stopCall.basis);
  assert.deepEqual("owner" in admitted.call.value && admitted.call.value.owner, mechanismOwner);
  assert.deepEqual("admission" in admitted.call.value && admitted.call.value.admission, f.initial.admission);
  assert.equal(admitted.ledger.value.calls.length, paid.value.calls.length + 1);
  assert.deepEqual(f.store.get(stopped.id), stopped, "the analysis opens no attempt four");
  f.addressOne(); // D3 answers the question before accounting closes the admitted call.
  const settled = deliveredOf(settleCall(f.store, reference(admitted.call), usage, "succeeded"));
  assert.deepEqual(deliveredOf(readCall(f.store, PROJECT, reference(admitted.call))), admitted.call);
  assert.deepEqual(deliveredOf(readCall(f.store, PROJECT, reference(settled.call))), settled.call);
  const before = fullSnapshot(f.store);
  const reopened = new Store(f.path);
  try {
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(settled.call))), settled.call);
    const repeat = deliveredOf(recordCall(reopened, PROJECT, stopCall));
    assert.equal(repeat.repeated, true);
    assert.deepEqual(reference(repeat.call), reference(settled.call));
    assert.deepEqual(fullSnapshot(reopened), before);
  } finally { reopened.close(); }
});

test("E1 mechanism origin analysis preserves its own exact ground after settlement and lifting", t => {
  // LG07 m3c (№10309 п.1): the origin half of the former mixed test, with its own preparation; its migration waits for G5.
  const h = mechanismFixture(t, "mechanism-origin-analysis"), before = h.call();
  const refusal = unknownRefusal(h.store, PROJECT);
  const closed = deliveredOf(closeAttempt(h.store, { ...h.ownerAddress, attempt: 1,
    outcome: { reason: "refused", accepting: [], cancelling: [], refusals: [refusal] } }));
  assert.equal(closed.holds.length, 1);
  const hold = closed.holds[0]!, heldSeries = h.store.get(h.mechanismSeries.id)!, originGoal = analysisGoal("mechanism origin");
  const input: MechanismRecordCallRequest = { ...before, call: "mechanism-origin", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold }, series: reference(heldSeries), goal: originGoal,
    gaps: [{ id: hold.id, goal: originGoal.key, field: "origin", consumer: mechanismOwner }] };
  const call = deliveredOf(recordCall(h.store, PROJECT, input));
  const decision = h.store.write({ id: `${originDecisionNamespace(PROJECT)}mechanism-e1`, kind: ORIGIN_DECISION_KIND, expected: 0,
    value: { projectId: PROJECT, owner: mechanismOwner, attempt: 1, row: refusal.row,
      decided: "Continue after reviewing the mechanism origin", approved: true } });
  deliveredOf(liftOriginHold(h.store, { project: PROJECT, hold, ground: "owner-decision", record: { ref: reference(decision) } }));
  addressed(recordCall(h.store, PROJECT, { ...input, call: "late-origin-analysis" }), "call_basis_unresolved");
  const accounted = deliveredOf(settleCall(h.store, reference(call.call), usage, "succeeded"));
  const reopened = new Store(h.path);
  try {
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(call.call))), call.call);
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(accounted.call))), accounted.call);
    assert.equal(deliveredOf(recordCall(reopened, PROJECT, input)).repeated, true);
  } finally { reopened.close(); }
});


async function inheritedStopFixture(t: test.TestContext, label: string) {
  // LG07 m3c (№10309): the stop is the real one of three managed M5 attempts; the successor is the real A → A+B change.
  const f = managedMechanismFixture(t, label, MechanismCommitRaceStore, ["encoding"]), stopped = await f.stop();
  const ordinary = f.call();
  const fresh = f.replaceProducerQuestions(["encoding", "transport"]), successorAddress = { ...f.ownerAddress, line: 2 };
  const successor = deliveredOf(openSeries(f.store, { ...successorAddress, scope: fresh.admission.gaps,
    predecessor: reference(stopped), basis: { ground: "inputs-changed", text: "Accepted producer added the transport question" } }));
  assert.notEqual(successor.value.slice, stopped.value.slice);
  assert.deepEqual(successor.value.stop, stopped.value.stop);
  assert.equal(successor.value.ladder.rung, 1);
  function analysis(name: string, admission = f.initial.admission, series = reference(successor)): MechanismRecordCallRequest {
    const wanted = analysisGoal("inherited mechanism stop");
    return { ...ordinary, call: name, purpose: "stop-analysis", admission, series, attempt: 3,
      basis: { kind: "series-stop", series, attempt: 3 }, goal: wanted,
      gaps: [{ id: successor.id, goal: wanted.key, field: "stop", consumer: mechanismOwner }],
      packet: { task: "review-stop", stop: structuredClone(successor.value.stop) as Json } };
  }
  function review(undecided = false) {
    return reference(f.store.write({ id: `${stopReviewNamespace(PROJECT)}inherited-${next()}`, kind: STOP_REVIEW_KIND, expected: 0,
      value: { projectId: PROJECT, owner: mechanismOwner, stop: 3, goals: [...successor.value.stop!.goals],
        reviewer: { name: "independent mechanism reviewer", independent: true },
        cause: "The addressing attempts still lack a verified decision",
        change: undecided ? null : { text: "Change the addressed question before the next attempt", addresses: ["M5:addressing"] } } }));
  }
  const paid = f.store.get<CallLedger>(callLedgerId(PROJECT))!;
  assert.equal(paid.value.calls.length, 3, "one paid E1 for each managed attempt");
  return { ...f, ordinary, stopped, fresh, successor, successorAddress, analysis, review, paid };
}

const accountingSnapshot = (store: Store) => ({ calls: store.list(CALL_RECORD_KIND).map(reference), ledger: store.get(callLedgerId(PROJECT)) });

test("E1 analyses an inherited stop after a real A to A+B successor and guards continuation while original tasks remain history", async t => {
  const f = await inheritedStopFixture(t, "inherited-stop"), store = f.store as MechanismCommitRaceStore;
  const input = f.analysis("inherited-stop-original"), extra = f.analysis("inherited-stop-fresh", f.fresh.admission);
  const beforeInvalid = fullSnapshot(store);
  addressed(recordCall(store, PROJECT, f.analysis("new-analysis-on-old-line", f.initial.admission, reference(f.stopped))), "call_series_unresolved");
  assert.deepEqual(fullSnapshot(store), beforeInvalid);
  const invalidSources: [string, MechanismAdmission][] = [
    ["forged-extra-route", { ...f.fresh.admission, routes: { ...f.fresh.admission.routes, hash: "0".repeat(64) } }],
    ["foreign-extra-batch", { ...f.fresh.admission, batch: "batch:absent" }],
    ["incomplete-extra-d1", { ...f.fresh.admission, gaps: { ...f.fresh.admission.gaps, records: [] } }],
  ];
  for (const [name, admission] of invalidSources) {
    addressed(recordCall(store, PROJECT, f.analysis(name, admission)), "call_series_unresolved");
    assert.equal(store.get(callRecordId(PROJECT, name)), null);
    assert.deepEqual(fullSnapshot(store), beforeInvalid, name);
  }
  const admitted = deliveredOf(recordCall(store, PROJECT, input));
  const fresh = deliveredOf(recordCall(store, PROJECT, extra));
  assert.deepEqual("admission" in admitted.call.value && admitted.call.value.admission, f.initial.admission);
  assert.deepEqual("admission" in fresh.call.value && fresh.call.value.admission, f.fresh.admission);
  assert.equal(fresh.ledger.value.calls.length, f.paid.value.calls.length + 2);
  const beforeOrdinary = fullSnapshot(store);
  addressed(recordCall(store, PROJECT, { ...f.ordinary, call: "ordinary-after-successor", series: reference(f.successor), attempt: 3 }), "call_series_unresolved");
  assert.deepEqual(fullSnapshot(store), beforeOrdinary);
  f.refreshInventory();
  assert.deepEqual(deliveredOf(prepareCallDispatch(store, PROJECT, reference(admitted.call))).call, admitted.call,
    "The inherited stop uses its historical assignment after the producer changed");
  addressed(prepareCallDispatch(store, PROJECT, reference(fresh.call)), "call_series_unresolved");
  const beforeStale = fullSnapshot(store);
  addressed(recordCall(store, PROJECT, { ...extra, call: "stale-additional-analysis-sources" }), "call_series_unresolved");
  assert.deepEqual(fullSnapshot(store), beforeStale);
  const review = f.review();
  const continuation = { ...f.successorAddress, stop: 3, ground: "review-record" as const,
    text: "The reviewer supplied an addressed change", review: { ref: review } };
  let afterWinner: Ref[] = [];
  store.race = other => { deliveredOf(resumeSeries(other, continuation)); afterWinner = fullSnapshot(other); };
  addressed(recordCall(store, PROJECT, { ...input, call: "analysis-racing-continuation" }), "input_stale");
  assert.ok(afterWinner.length > 0, "the continuation ran in the write window");
  assert.deepEqual(fullSnapshot(store), afterWinner, "A continuation wins without a partial call or ledger row");
  const continued = store.get<AnyRepairSeries>(f.successor.id)!;
  assert.equal(continued.value.stop, null);
  addressed(recordCall(store, PROJECT, f.analysis("analysis-after-continuation", f.initial.admission, reference(continued))), "call_basis_unresolved");
  assert.deepEqual(fullSnapshot(store), afterWinner);
  const settled = deliveredOf(settleCall(store, reference(admitted.call), usage, "succeeded"));
  deliveredOf(settleCall(store, reference(fresh.call), usage, "failed"));
  const reopened = new Store(f.path);
  try {
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(admitted.call))), admitted.call);
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(fresh.call))), fresh.call);
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(settled.call))), settled.call);
    const snapshot = fullSnapshot(reopened);
    assert.equal(deliveredOf(recordCall(reopened, PROJECT, input)).repeated, true);
    assert.equal(deliveredOf(recordCall(reopened, PROJECT, extra)).repeated, true);
    assert.deepEqual(fullSnapshot(reopened), snapshot);
  } finally { reopened.close(); }
});

test("E1 inherited stop analysis guards extra fresh sources and refuses the owner's rung without altering admission history", async t => {
  const f = await inheritedStopFixture(t, "inherited-stop-rung"), store = f.store as MechanismCommitRaceStore;
  const fresh = f.analysis("analysis-racing-extra-source", f.fresh.admission);
  let afterRival: Ref[] = [];
  store.race = other => {
    const input = other.get(f.fresh.admission.gaps.sources.input.id)!;
    other.write({ id: input.id, kind: input.kind, expected: input.revision, value: input.value });
    afterRival = fullSnapshot(other);
  };
  addressed(recordCall(store, PROJECT, fresh), "input_stale");
  assert.ok(afterRival.length > 0, "the source moved in the write window");
  assert.deepEqual(fullSnapshot(store), afterRival);
  const input = f.analysis("original-history-after-extra-source-moved");
  const admitted = deliveredOf(recordCall(store, PROJECT, input));
  assert.equal(admitted.ledger.value.calls.length, f.paid.value.calls.length + 1);
  const review = f.review(true);
  const escalated = deliveredOf(escalateSeries(store, { ...f.successorAddress, stop: 3,
    review: { ref: review } }));
  assert.equal(escalated.value.ladder.rung, 2);
  assert.ok(escalated.value.stop);
  const snapshot = fullSnapshot(store);
  addressed(recordCall(store, PROJECT, f.analysis("analysis-on-owner-rung", f.initial.admission, reference(escalated))), "call_basis_unresolved");
  assert.deepEqual(fullSnapshot(store), snapshot);
  const settled = deliveredOf(settleCall(store, reference(admitted.call), usage, "succeeded"));
  const reopened = new Store(f.path);
  try {
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(settled.call))), settled.call);
    const cold = fullSnapshot(reopened);
    assert.equal(deliveredOf(recordCall(reopened, PROJECT, input)).repeated, true);
    addressed(recordCall(reopened, PROJECT, f.analysis("analysis-owner-rung-after-restart", f.initial.admission, reference(escalated))), "call_basis_unresolved");
    assert.deepEqual(fullSnapshot(reopened), cold);
  } finally { reopened.close(); }
});

test("E1 analyses an inherited origin hold after D3 and a full D1 successor, with atomic lifting and exact restart history", t => {
  const f = mechanismFixture(t, "inherited-origin", MechanismCommitRaceStore), store = f.store as MechanismCommitRaceStore;
  const ordinary = f.call(), refusal = unknownRefusal(store, PROJECT);
  const closed = deliveredOf(closeAttempt(store, { ...f.ownerAddress, attempt: 1,
    outcome: { reason: "refused", accepting: [], cancelling: [], refusals: [refusal] } }));
  const hold = closed.holds[0]!;
  assert.ok(hold);
  const old = store.get<AnyRepairSeries>(f.mechanismSeries.id)!, fresh = f.addressForSuccessor();
  const successorAddress = { ...f.ownerAddress, line: 2 };
  const successor = deliveredOf(openSeries(store, { ...successorAddress, scope: fresh.admission.gaps,
    predecessor: reference(old), basis: { ground: "inputs-changed", text: "D3 addressed the encoding question" } }));
  assert.notEqual(successor.value.slice, old.value.slice);
  const goal = analysisGoal("inherited origin hold");
  const input: MechanismRecordCallRequest = { ...ordinary, call: "inherited-origin-analysis", purpose: "origin-analysis",
    basis: { kind: "origin-hold", hold }, series: reference(successor), goal,
    gaps: [{ id: hold.id, goal: goal.key, field: "origin", consumer: mechanismOwner }], packet: { hold } };
  const admitted = deliveredOf(recordCall(store, PROJECT, input));
  const extra = { ...input, call: "inherited-origin-fresh-analysis", admission: fresh.admission };
  const freshCall = deliveredOf(recordCall(store, PROJECT, extra));
  addressed(recordCall(store, PROJECT, { ...ordinary, call: "ordinary-with-inherited-hold", series: reference(successor) }), "call_series_unresolved");
  const decision = reference(store.write({ id: `${originDecisionNamespace(PROJECT)}inherited-origin-e1`, kind: ORIGIN_DECISION_KIND, expected: 0,
    value: { projectId: PROJECT, owner: mechanismOwner, attempt: 1, row: refusal.row,
      decided: "Continue after reviewing this inherited origin hold", approved: true } }));
  const lift = { project: PROJECT, hold, ground: "owner-decision" as const, record: { ref: decision } };
  const before = accountingSnapshot(store);
  store.race = other => { deliveredOf(liftOriginHold(other, lift)); };
  addressed(recordCall(store, PROJECT, { ...input, call: "analysis-racing-origin-lift" }), "input_stale");
  assert.deepEqual(accountingSnapshot(store), before, "The inherited hold changed without a partial accounting write");
  addressed(recordCall(store, PROJECT, { ...input, call: "new-analysis-after-origin-lift" }), "call_basis_unresolved");
  const settled = deliveredOf(settleCall(store, reference(admitted.call), usage, "succeeded"));
  deliveredOf(settleCall(store, reference(freshCall.call), usage, "failed"));
  const reopened = new Store(f.path);
  try {
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(admitted.call))), admitted.call);
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(settled.call))), settled.call);
    assert.deepEqual(deliveredOf(readCall(reopened, PROJECT, reference(freshCall.call))), freshCall.call);
    const snapshot = accountingSnapshot(reopened);
    assert.equal(deliveredOf(recordCall(reopened, PROJECT, input)).repeated, true);
    assert.equal(deliveredOf(recordCall(reopened, PROJECT, extra)).repeated, true);
    assert.deepEqual(accountingSnapshot(reopened), snapshot);
    addressed(recordCall(reopened, PROJECT, { ...input, call: "new-origin-analysis-after-restart" }), "call_basis_unresolved");
  } finally { reopened.close(); }
});

test("block successor and call admission serialize both orders without partial accounting or loss of historical settlement", t => {
  for (const successorFirst of [false, true]) {
    const f = fixture(t, `block-successor-${successorFirst}`, MechanismCommitRaceStore), store = f.store as MechanismCommitRaceStore;
    const stopped = stoppedSeries(f), wanted = analysisGoal("block predecessor stop");
    const input = request(f, { call: "block-line-analysis", purpose: "stop-analysis", attempt: 3, series: reference(stopped),
      basis: { kind: "series-stop", series: reference(stopped), attempt: 3 }, goal: wanted,
      gaps: analysisGaps(stopped.id, wanted, "stop") });
    const successorRequest = { project: PROJECT, block: BLOCK, line: 2, slice: "slice:cart@2", predecessor: reference(stopped),
      basis: { ground: "inputs-changed" as const, text: "Added a question to the block horizon" } };
    let saved: ReturnType<typeof recordCall> | null = null;
    if (successorFirst) {
      store.race = other => { deliveredOf(openSeries(other, successorRequest)); };
      const before = accountingSnapshot(store);
      assert.equal(refusalOf(recordCall(store, PROJECT, input)).code, "input_stale");
      assert.deepEqual(accountingSnapshot(store), before, "Successor winning immediately before call write leaves neither call nor ledger");
    } else {
      saved = recordCall(store, PROJECT, input);
      const admitted = deliveredOf(saved), launch = deliveredOf(prepareCallDispatch(store, PROJECT, reference(admitted.call)));
      deliveredOf(openSeries(store, successorRequest));
      assert.equal(refusalOf(writeGuarded(store, { unit: "E4-test", target: "launch:old-line",
        writes: [{ id: "launch:old-line", kind: "launch", expected: 0, value: {} }], guards: launch.guards })).code, "input_stale");
      assert.equal(store.get("launch:old-line"), null);
      addressed(prepareCallDispatch(store, PROJECT, reference(admitted.call)), "call_series_unresolved");
    }
    const claimed = store.get<RepairSeries>(stopped.id)!, successor = store.get<RepairSeries>(seriesId(PROJECT, BLOCK, 2))!;
    assert.equal(claimed.revision, stopped.revision + 1);
    assert.deepEqual(claimed.value, stopped.value);
    for (const ref of [reference(stopped), reference(claimed)]) {
      addressed(recordCall(store, PROJECT, { ...input, call: `forbidden-${ref.revision}`, series: ref,
        basis: { kind: "series-stop", series: ref, attempt: 3 } }), "call_series_unresolved");
    }
    const inheritedInput = { ...input, call: "inherited-stop-analysis", series: reference(successor),
      basis: { kind: "series-stop" as const, series: reference(successor), attempt: 3 } };
    const inherited = deliveredOf(recordCall(store, PROJECT, inheritedInput));
    assert.deepEqual(deliveredOf(prepareCallDispatch(store, PROJECT, reference(inherited.call))).call, inherited.call);
    const restarted = new Store(f.path);
    try {
      addressed(recordCall(restarted, PROJECT, { ...input, call: "old-after-restart" }), "call_series_unresolved");
      assert.deepEqual(deliveredOf(readSeriesAt(restarted, PROJECT, reference(stopped))), stopped);
      assert.equal(deliveredOf(recordCall(restarted, PROJECT, inheritedInput)).repeated, true);
      if (saved) {
        const admitted = deliveredOf(saved);
        assert.deepEqual(deliveredOf(readCall(restarted, PROJECT, reference(admitted.call))), admitted.call);
        assert.equal(deliveredOf(recordCall(restarted, PROJECT, input)).repeated, true);
        const accounted = deliveredOf(settleCall(restarted, reference(admitted.call), usage, "succeeded"));
        assert.equal(accounted.settled, true);
        assert.equal(deliveredOf(recordCall(restarted, PROJECT, input)).call.revision, 2);
        assert.equal(deliveredOf(settleCall(restarted, reference(admitted.call), usage, "succeeded")).repeated, true);
      }
    } finally { restarted.close(); }
  }
});

test("current admission rejects a legacy block predecessor even when succession left its exact head unchanged", t => {
  const f = fixture(t, "legacy-successor"), stopped = stoppedSeries(f), wanted = analysisGoal("legacy stop");
  const input = request(f, { call: "legacy-admitted", purpose: "stop-analysis", series: reference(stopped), attempt: 3,
    basis: { kind: "series-stop", series: reference(stopped), attempt: 3 }, goal: wanted, gaps: analysisGaps(stopped.id, wanted, "stop") });
  const admitted = deliveredOf(recordCall(f.store, PROJECT, input));
  // Reconstruct the historical era's valid record shape; its writer did not claim the predecessor.
  const legacyValue: RepairSeries = { ...stopped.value, line: 2, slice: "legacy:second-slice", predecessor: reference(stopped),
    basis: { ground: "inputs-changed", text: "The historical slice moved" }, inherited: stopped.value.attempts, attempts: [] };
  const legacy = f.store.write({ id: seriesId(PROJECT, BLOCK, 2), kind: stopped.kind, expected: 0, value: legacyValue });
  const restarted = new Store(f.path);
  try {
    assert.deepEqual(reference(restarted.get(stopped.id)!), reference(stopped));
    assert.deepEqual(deliveredOf(readSeriesAt(restarted, PROJECT, reference(legacy))), legacy);
    addressed(recordCall(restarted, PROJECT, { ...input, call: "new-on-legacy-predecessor" }), "call_series_unresolved");
    addressed(prepareCallDispatch(restarted, PROJECT, reference(admitted.call)), "call_series_unresolved");
    assert.deepEqual(deliveredOf(readCall(restarted, PROJECT, reference(admitted.call))), admitted.call);
    assert.equal(deliveredOf(recordCall(restarted, PROJECT, input)).repeated, true);
    assert.equal(deliveredOf(settleCall(restarted, reference(admitted.call), usage, "failed")).settled, true);
  } finally { restarted.close(); }
});

test("prepareCallDispatch uses current purpose, call and configuration guards while readCall stays historical", t => {
  const f = fixture(t, "prepare-dispatch"), admitted = deliveredOf(recordCall(f.store, PROJECT, request(f)));
  const proof = deliveredOf(prepareCallDispatch(f.store, PROJECT, reference(admitted.call)));
  assert.deepEqual(proof.call, admitted.call);
  assert.ok(deeplyFrozen(proof));
  for (const source of [admitted.call, f.series, f.adapter, f.config])
    assert.ok(proof.guards.some(ref => isRef(ref) && ref.id === source.id && ref.revision === source.revision && ref.hash === source.hash));
  addressed(prepareCallDispatch(f.store, PROJECT, undefined as never), "call_unresolved");
  addressed(prepareCallDispatch(f.store, PROJECT, { ...reference(admitted.call), hash: "f".repeat(64) }), "call_unresolved");
  addressed(prepareCallDispatch(f.store, "beta", reference(admitted.call)), "call_unresolved");
  const moved = f.store.write({ id: f.config.id, kind: f.config.kind, expected: f.config.revision, value: { model: "changed" } });
  addressed(prepareCallDispatch(f.store, PROJECT, reference(admitted.call)), "dispatch_contract_unresolved");
  assert.equal(refusalOf(writeGuarded(f.store, { unit: "E4-test", target: "launch:changed-config",
    writes: [{ id: "launch:changed-config", kind: "launch", expected: 0, value: {} }], guards: proof.guards })).code, "input_stale");
  assert.equal(f.store.get("launch:changed-config"), null);
  assert.equal(moved.revision, 2);
  assert.deepEqual(deliveredOf(readCall(f.store, PROJECT, reference(admitted.call))), admitted.call);
  const settled = deliveredOf(settleCall(f.store, reference(admitted.call), usage, "succeeded"));
  addressed(prepareCallDispatch(f.store, PROJECT, reference(admitted.call)), "call_unresolved");
  addressed(prepareCallDispatch(f.store, PROJECT, reference(settled.call)), "call_unresolved");

  const g = fixture(t, "dispatch-ended-attempt"), ordinary = deliveredOf(recordCall(g.store, PROJECT, request(g)));
  deliveredOf(completeAttempt(g.store, { project: PROJECT, block: BLOCK, line: 1, attempt: 1,
    outcome: { reason: "off-form", achieved: [], cancelled: [], refusals: [] } }));
  addressed(prepareCallDispatch(g.store, PROJECT, reference(ordinary.call)), "call_series_unresolved");
  assert.deepEqual(deliveredOf(readCall(g.store, PROJECT, reference(ordinary.call))), ordinary.call);
});

test("block origin analysis follows its inherited current hold and rejects a lifted hold on a fresh process launch", t => {
  const f = fixture(t, "inherited-block-origin"), held = raisedHold(f.store, PROJECT, f.goal), wanted = analysisGoal("inherited block hold");
  const input = request(f, { call: "block-origin-old", purpose: "origin-analysis", series: reference(held.series), attempt: 1,
    basis: { kind: "origin-hold", hold: held.hold }, goal: wanted, gaps: analysisGaps(held.hold.id, wanted, "origin") });
  const old = deliveredOf(recordCall(f.store, PROJECT, input));
  const successor = deliveredOf(openSeries(f.store, { project: PROJECT, block: BLOCK, line: 2, slice: "slice:cart@2", predecessor: reference(held.series),
    basis: { ground: "inputs-changed", text: "The inherited origin remains unresolved" } }));
  addressed(prepareCallDispatch(f.store, PROJECT, reference(old.call)), "call_series_unresolved");
  const inherited = deliveredOf(recordCall(f.store, PROJECT, { ...input, call: "block-origin-inherited", series: reference(successor) }));
  const proof = deliveredOf(prepareCallDispatch(f.store, PROJECT, reference(inherited.call)));
  assert.ok(proof.guards.some(ref => ref.id === held.hold.id));
  liftByOwner(f.store, PROJECT, held.hold);
  addressed(prepareCallDispatch(f.store, PROJECT, reference(inherited.call)), "call_basis_unresolved");
  const restarted = new Store(f.path);
  try {
    assert.deepEqual(deliveredOf(readCall(restarted, PROJECT, reference(old.call))), old.call);
    assert.deepEqual(deliveredOf(readCall(restarted, PROJECT, reference(inherited.call))), inherited.call);
    assert.equal(deliveredOf(settleCall(restarted, reference(inherited.call), usage, "succeeded")).settled, true);
    assert.equal(deliveredOf(recordCall(restarted, PROJECT, input)).repeated, true);
  } finally { restarted.close(); }
});

const e4FixturePath = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));

function factAssessmentFixture(t: test.TestContext, StoreType: typeof Store = Store, fileEvidence = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-e50-fact-")), path = join(root, "state.sqlite"), project = "garden";
  let store = new StoreType(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), desired = gardenGraph("cross");
  desired.nodes.find(node => node.id === "garden-produce-block")!.ports.push({ id: "out-side", direction: "out", contract: "garden-contract" });
  desired.nodes.find(node => node.id === "garden-consume-block")!.ports.push({ id: "in-side", direction: "in", contract: "garden-contract" });
  desired.connectors.push({ id: "garden-side-flow", artifact: "garden-data", returnsTo: "garden-produce-block", wakeTest: null,
    bindings: [{ level: 1, producer: { node: "garden-produce-block", port: "out-side" },
      consumers: [{ node: "garden-consume-block", port: "in-side" }], anchor: null }] });
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "encoding", question: "What encoding is supported?",
      consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false,
      resolution: "Resolve the addressed question during OM" }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = deliveredOf(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = deliveredOf(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: "discovery:encoding", field: "address",
        value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: "e50-fact", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = deliveredOf(writeGaps(store, sources));
  const gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = deliveredOf(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing"
      && !row.value.gap.deferral).map(gap => ({ gap: reference(gap), requirements: [{ pointer: "/contracts/0" }],
        resultForm: { type: "string" } })) }));
  const routesRequest = { project, gaps: gapRequest, tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ["e50-source.txt"], records: [] }, previous: null };
  const routes = deliveredOf(writeRoutes(store, routesRequest));
  const batch = routes.value.batches.find(item => item.model === "MC1" && item.items.some(question => question.target === "discovery:encoding"))!;
  assert.ok(batch);
  const sourcePath = join(root, "e50-source.txt");
  writeFileSync(sourcePath, "UTF-8 is the supported encoding.");
  const block = "garden-consume-block", source = fileEvidence
    ? new Evidence(store).file(project, "e50-file", root, "e50-source.txt", "text/plain", 0)
    : store.get<{ content: string }>(`source:${project}:brief`)!;
  const attemptGoal: AttemptGoal = { key: "e50:fact", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const opening = { project, block, line: 1, slice: "e50-fact", predecessor: null, basis: null };
  deliveredOf(openSeries(store, opening));
  const completion = { routes: reference(routes), batches: [batch.id] };
  const series = deliveredOf(openAttempt(store, { project, block, line: 1, attempt: 1, goal: attemptGoal, completion }));
  const binding = deliveredOf(readCompletionBinding(store, project, reference(series), 1));
  assert.ok(binding, 'Current fact assessment has a completion owner');
  assert.deepEqual(binding.value.plan, completion);
  assert.deepEqual(binding.value.goal, attemptGoal);
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [e4FixturePath, "--scenario", scenario, "--trace", trace] };
  const config = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "e50-researcher", model: "fixture", effort: "high", command },
    reviewer: { actor: "e50-assessor", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: 100_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:e50`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio" } });
  const packetRequest = { project, routes: reference(routes), batch: batch.id,
    environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] };
  const packet = deliveredOf(writeQuestionPacket(store, packetRequest)).record;
  const questionId = batch.items[0]!.gap;
  const native = (packet as Revision<QuestionPacketRecord>).value.native.find(item => item.gap.id === `om-gap:${project}:${questionId}`)!;
  assert.ok(native);
  writeFileSync(join(root, "e50-source.txt"), "UTF-8 is the supported encoding.");
  const originalStep = { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: [{ questionId, value: "UTF-8", citations: [{ source: reference(source),
      selector: { kind: "text-range", start: 0, end: source.value.content.length } }] }] }, usage };
  writeFileSync(scenario, JSON.stringify({ database: store.path, steps: [originalStep] }));
  const modelRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(config) },
    role: "implementer" as const };
  async function original() {
    const model = deliveredOf(await runModelCall(store, modelRequest));
    assert.equal(model.outcome?.kind, "fact-candidates");
    assert.ok(model.response);
    assert.equal(store.get<RepairSeries>(series.id)!.value.attempts[0]!.outcome, null);
    const research = deliveredOf(readCall(store, project, model.call));
    if ("owner" in research.value) assert.fail("Original MC1 call must belong to its block attempt");
    const intent = deliveredOf(writeAssessmentIntent(store, { project, modelCall: reference(model.record),
      questionId, dispatch: modelRequest.dispatch }));
    const admittedIntent = deliveredOf(readAssessmentIntentAt(store, project, reference(intent)));
    const basis = admittedIntent.basis;
    const addressedFact = research.value.gaps.filter(gap => gap.id === batch.items[0]!.target && gap.field === batch.items[0]!.field);
    assert.ok(addressedFact.length > 0);
    const assessment = (over: Partial<RecordCallRequest> = {}): RecordCallRequest => ({
      call: admittedIntent.call, purpose: "fact-assessment", basis, block,
      gaps: addressedFact, series: admittedIntent.series, attempt: admittedIntent.attempt, goal: attemptGoal,
      dispatch: admittedIntent.dispatch, packet: admittedIntent.packet as unknown as Json, ...over,
    });
    return { model, research, basis, intent, assessment };
  }
  return { project, block, path, root, sourcePath, source, series, packet, native, questionId, batch, attemptGoal,
    dispatch: modelRequest.dispatch, get store() { return store; }, original,
    assessorScenario() { writeFileSync(scenario, JSON.stringify({ database: store.path, steps: [originalStep,
      { research: { verdict: "supported", reasons: [] }, usage }] })); },
    sent() { return readFileSync(trace, "utf8").trim().split("\n").filter(Boolean); },
    restart() { store.close(); store = new StoreType(path); } };
}

function closeFactAssessment(f: ReturnType<typeof factAssessmentFixture>, reason: 'result' | 'interrupted', store = f.store) {
  const binding = deliveredOf(readCompletionBinding(store, f.project, reference(store.get(f.series.id)!), 1));
  assert.ok(binding);
  const work = deliveredOf(readCompletionWorkAt(store, f.project, reference(store.get(completionWorkId(f.project, binding.id))!)));
  assert.equal(work.complete, true);
  return deliveredOf(closeAttempt(store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: { reason, accepting: work.accepting, cancelling: [], refusals: work.refusals } }));
}
function ceaseFactBeforeAssessment(f: ReturnType<typeof factAssessmentFixture>, store = f.store) {
  writeFileSync(f.sourcePath, 'The captured source has changed.');
  const binding = deliveredOf(readCompletionBinding(store, f.project, reference(store.get(f.series.id)!), 1));
  assert.ok(binding);
  const work = deliveredOf(readCompletionWorkAt(store, f.project, reference(store.get(completionWorkId(f.project, binding.id))!)));
  const fact = work.assignments.find(row => row.value.kind === 'fact');
  assert.ok(fact);
  const cessation = deliveredOf(writeCompletionCessation(store, { project: f.project, binding: reference(binding), assignment: reference(fact) }));
  assert.equal(cessation.value.disposition, 'not-dispatched');
  return closeFactAssessment(f, 'interrupted', store);
}

test("new direct fact E1 refuses both unmanaged and reserved names without an E5 intent", async t => {
  const f = factAssessmentFixture(t), origin = await f.original();
  const legacyBasis = structuredClone(origin.basis);
  delete (legacyBasis as { assessment?: Ref }).assessment;
  const beforeCalls = f.store.list(CALL_RECORD_KIND).map(reference);
  const beforeLedger = f.store.get<CallLedger>(callLedgerId(f.project));
  for (const call of ["unmanaged-direct-assessor", origin.assessment().call]) {
    const input = origin.assessment({ call, basis: legacyBasis });
    addressed(recordCall(f.store, f.project, input), "call_basis_unresolved");
    assert.equal(f.store.get(callRecordId(f.project, call)), null);
  }
  assert.deepEqual(f.store.list(CALL_RECORD_KIND).map(reference), beforeCalls);
  assert.deepEqual(f.store.get<CallLedger>(callLedgerId(f.project)), beforeLedger);
});


test("fact assessment is admitted only from the applied original MC1 fact in its running attempt", async t => {
  const f = factAssessmentFixture(t), origin = await f.original(), input = origin.assessment();
  const recorded = deliveredOf(recordCall(f.store, f.project, input));
  assert.equal(recorded.call.value.purpose, "fact-assessment");
  assert.deepEqual(recorded.call.value.basis, origin.basis);
  assert.equal(recorded.call.value.attempt, origin.research.value.attempt);
  assert.equal(recorded.call.value.series.id, origin.research.value.series.id);
  assert.equal(recorded.ledger.value.calls.filter(row => row.purpose === "fact-assessment").length, 1);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  f.assessorScenario();
  const terminal = deliveredOf(await assessFact(f.store, { project: f.project, modelCall: reference(origin.model.record),
    questionId: f.questionId, dispatch: input.dispatch }));
  assert.equal(terminal.value.verdict, 'supported');
  closeFactAssessment(f, 'result');
  const exact = reference(recorded.call), before = f.store.list().map(reference);
  f.restart();
  assert.deepEqual(deliveredOf(readCall(f.store, f.project, exact)), recorded.call);
  assert.equal(deliveredOf(recordCall(f.store, f.project, input)).repeated, true);
  assert.deepEqual(f.store.list().map(reference), before);
});

test("fact assessment rejects intent imitations, missing and foreign exact sources", async t => {
  const f = factAssessmentFixture(t), origin = await f.original(), baselineSize = f.store.list().length;
  const fake = f.store.write({ id: `model-call:${f.project}:om:imitation`, kind: "model-call", expected: 0,
    value: { projectId: f.project, purpose: "model-research", status: "succeeded", response: { record: origin.basis.response } } });
  const malformed = [
    { name: "intent imitation", basis: { ...origin.basis, modelCall: reference(fake) }, code: "call_basis_unresolved" },
    { name: "missing response", basis: { ...origin.basis, response: { ...origin.basis.response, hash: "0".repeat(64) } }, code: "call_basis_unresolved" },
    { name: "foreign packet", basis: { ...origin.basis, packet: { ...origin.basis.packet, id: origin.basis.packet.id.replace(f.project, "foreign") } }, code: "call_basis_unresolved" },
    { name: "another question", basis: { ...origin.basis, questionId: "other-question" }, code: "call_basis_unresolved" },
    { name: "missing question", basis: { ...origin.basis, question: undefined }, code: "call_basis_invalid" },
  ];
  for (const item of malformed) {
    const input = origin.assessment({ basis: item.basis as RecordCallRequest["basis"] });
    addressed(recordCall(f.store, f.project, input), item.code);
    assert.equal(f.store.get(callRecordId(f.project, input.call)), null, item.name);
  }
  assert.equal(f.store.list().length, baselineSize + 1);
});

test("fact assessment rejects a changed source identity and incomplete original MC1 records at historical read", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  const corruptions = [
    { name: "missing om.part", field: "part" },
    { name: "missing om.input", field: "input" },
    { name: "missing om.diagnostic", field: "diagnostic" },
    { name: "contradictory error", field: "error" },
  ] as const;
  for (const { name, field } of corruptions) {
    await t.test(name, async t => {
      const f = factAssessmentFixture(t), origin = await f.original();
      const valid = deliveredOf(recordCall(f.store, f.project, origin.assessment()));
      const value = structuredClone(origin.model.record.value);
      if (field === "error") {
        assert.equal(value.error, null);
        (value as { error: string | null }).error = "fabricated-error";
      } else {
        const om = value.om as unknown as Record<string, unknown>;
        assert.ok(Object.hasOwn(om, field));
        assert.equal(om[field], null);
        delete om[field];
      }
      const corrupt = f.store.write({ id: origin.model.record.id, kind: "model-call",
        expected: origin.model.record.revision, value });
      assert.equal(corrupt.revision, origin.model.record.revision + 1);
      assert.equal(corrupt.hash, hashJson(value));
      const malformedSource = refusalOf(readModelCallState(f.store, { project: f.project, record: reference(corrupt) }));
      assert.equal(malformedSource.code, "model_call_record_invalid");
      assert.equal(malformedSource.at.unit, "E4");
      const corruptBasis = { ...origin.basis, modelCall: reference(corrupt) };
      const input = origin.assessment({ basis: corruptBasis });
      const beforeCalls = f.store.list(CALL_RECORD_KIND).map(reference);
      const beforeLedger = f.store.get<CallLedger>(callLedgerId(f.project));
      addressed(recordCall(f.store, f.project, input), "call_identity_conflict");
      assert.deepEqual(f.store.get(callRecordId(f.project, input.call)), valid.call);
      assert.deepEqual(f.store.list(CALL_RECORD_KIND).map(reference), beforeCalls);
      assert.deepEqual(f.store.get<CallLedger>(callLedgerId(f.project)), beforeLedger);

      // A saved opening call can name the same exact damaged origin even when new admission refuses it.
      const forgedName = `historical-${field}-${next()}`;
      const forged = f.store.write({ id: callRecordId(f.project, forgedName), kind: CALL_RECORD_KIND, expected: 0,
        value: { ...structuredClone(valid.call.value), call: forgedName, basis: corruptBasis } });
      const forgedRef = reference(forged);
      f.restart();
      assert.deepEqual(deliveredOf(readCall(f.store, f.project, reference(valid.call))), valid.call);
      addressed(readCall(f.store, f.project, forgedRef), "call_record_invalid");
    });
  }
});

test("fact assessment cannot move to another attempt or start after its original attempt completes", async t => {
  const f = factAssessmentFixture(t, Store, true), origin = await f.original();
  addressed(recordCall(f.store, f.project, origin.assessment({ attempt: 2 })), "call_basis_unresolved");
  addressed(recordCall(f.store, f.project, origin.assessment({ goal: goal() })), "call_basis_unresolved");
  if ("owner" in origin.research.value) assert.fail("Original MC1 call must belong to its block attempt");
  addressed(recordCall(f.store, f.project, origin.assessment({ gaps: [
    ...origin.research.value.gaps, { id: "another-fact", goal: "encoding", field: "value", consumer: f.block },
  ] })), "call_basis_unresolved");
  ceaseFactBeforeAssessment(f);
  const late = origin.assessment({ series: reference(f.store.get<RepairSeries>(f.series.id)!) });
  const ended = refusalOf(recordCall(f.store, f.project, late));
  assert.equal(ended.code, "answer_inapplicable");
  assert.equal(ended.at.unit, "D5");
  assert.equal(f.store.get(callRecordId(f.project, late.call)), null);
});

test("fact assessment current series change between origin proof and E1 write rejects atomically", async t => {
  const f = factAssessmentFixture(t, Store, true), origin = await f.original(), input = origin.assessment();
  const beforeCalls = f.store.list(CALL_RECORD_KIND).length, beforeLedger = f.store.get<CallLedger>(callLedgerId(f.project))!;
  const writeMany = f.store.writeMany.bind(f.store);
  let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === CALL_RECORD_KIND
      && (write.value as { purpose?: string }).purpose === "fact-assessment")) {
      raced = true;
      const other = new Store(f.path);
      try {
        ceaseFactBeforeAssessment(f, other);
      } finally { other.close(); }
    }
    return writeMany(writes, guards);
  }) as Store["writeMany"];
  try { addressed(recordCall(f.store, f.project, input), "input_stale"); }
  finally { f.store.writeMany = writeMany; }
  assert.ok(raced);
  assert.equal(f.store.list(CALL_RECORD_KIND).length, beforeCalls);
  assert.deepEqual(f.store.get<CallLedger>(callLedgerId(f.project)), beforeLedger);
  assert.equal(f.store.get(callRecordId(f.project, input.call)), null);
});

test("fact assessment uses the shared E4 physical transport and exact replay without another charge", async t => {
  const f = factAssessmentFixture(t), origin = await f.original(), input = origin.assessment();
  const admitted = deliveredOf(recordCall(f.store, f.project, input));
  f.assessorScenario();
  const request = { project: f.project, call: reference(admitted.call), packet: input.packet, role: "reviewer" as const };
  const first = deliveredOf(await runModelTransport(f.store, request));
  assert.equal(first.result.kind, "answered");
  assert.equal(first.record.value.purpose, "fact-assessment");
  assert.equal(first.repeated, false);
  assert.equal(f.sent().length, 2);
  assert.deepEqual(deliveredOf(readModelTransport(f.store, { project: f.project, record: reference(first.record) })).record, first.record);
  const historical = deliveredOf(readCall(f.store, f.project, reference(f.store.get(admitted.call.id)!)));
  assert.equal(historical.value.status, "succeeded");
  const repeat = deliveredOf(await runModelTransport(f.store, request));
  assert.equal(repeat.repeated, true);
  assert.equal(f.sent().length, 2);
  f.restart();
  assert.deepEqual(deliveredOf(readModelTransport(f.store, { project: f.project, record: reference(first.record) })).record, first.record);
  assert.equal(deliveredOf(await runModelTransport(f.store, request)).repeated, true);
  assert.equal(f.sent().length, 2);
  assert.equal(f.store.list("model-call").length, 2);
});

test("fact assessment recovers a lost claimed E4 owner without another physical send", async t => {
  const f = factAssessmentFixture(t), origin = await f.original(), input = origin.assessment();
  const admitted = deliveredOf(recordCall(f.store, f.project, input));
  const request = { project: f.project, call: reference(admitted.call), packet: input.packet, role: "reviewer" as const };
  const checkpoint = join(f.root, "claimed-assessor.json"), spec = join(f.root, "driver-assessor.json"), output = join(f.root, "driver-assessor-output.json");
  writeFileSync(spec, JSON.stringify({ database: f.path, output, operation: "transport", request,
    checkpoint: { path: checkpoint, kind: "model-call", matches: [{ path: ["execution", "phase"], value: "claimed" }] } }));
  const child = spawn(process.execPath, [e4FixturePath, "--driver", spec], { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.resume(); child.stderr!.resume();
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const deadline = Date.now() + 20_000;
  while (!existsSync(checkpoint)) {
    assert.ok(Date.now() < deadline, "local fixture must reach the saved claimed state");
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
  const claimed = f.store.list<{ purpose: string; status: string }>("model-call")
    .find(row => row.value.purpose === "fact-assessment")!;
  assert.ok(claimed);
  assert.equal(claimed.value.status, "running");
  assert.equal(f.sent().length, 1);
  assert.throws(() => recoverOmModelCall(f.store, f.project, reference(claimed)), code("model_call_still_running"));
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  const recovered = recoverOmModelCall(f.store, f.project, reference(claimed));
  assert.equal(recovered.value.status, "failed");
  const read = deliveredOf(readModelTransport(f.store, { project: f.project, record: reference(recovered) }));
  assert.equal(read.result.kind, "interrupted");
  assert.equal(deliveredOf(await runModelTransport(f.store, request)).repeated, true);
  assert.equal(f.sent().length, 1);
  assert.equal(deliveredOf(readCall(f.store, f.project, reference(admitted.call))).value.status, "open");
  f.restart();
  assert.equal(deliveredOf(readModelTransport(f.store, { project: f.project, record: reference(recovered) })).result.kind, "interrupted");
  assert.equal(deliveredOf(await runModelTransport(f.store, request)).repeated, true);
  assert.equal(f.sent().length, 1);
});

test('MP1 E1 measures the sent Cyrillic/non-BMP text while binding the complete semantic packet', t => {
  const f = fixture(t, 'brief-fingerprint');
  const call = 'research-price-1', text = 'Задание 😀: установи цену';
  const packet: Json = { version: 'om-question-packet/brief-v1', requestId: call,
    responseForm: { protocol: 'omg-answer/v3', requestId: call, schema: { type: 'object' } },
    brief: { contract: 'om-brief/v1', requestId: call, text, labels: [], manifest: [], references: [], examples: [] },
    semanticBasis: { meaning: 'price for cart' } };
  const saved = deliveredOf(recordCall(f.store, PROJECT, request(f, { packet }))).call;
  assert.deepEqual(saved.value.packet, { hash: hashJson(packet), chars: text.length, bytes: Buffer.byteLength(text, 'utf8') });
  assert.notEqual(text.length, [...text].length); assert.ok(Buffer.byteLength(text) > text.length);
  assert.deepEqual(deliveredOf(recordCall(f.store, PROJECT, request(f, { packet }))).call, saved);
  const other = { ...packet as object, semanticBasis: { meaning: 'foreign cart' } } as Json;
  assert.notEqual(hashJson(packet), hashJson(other));
  const before = f.store.list().map(reference);
  assert.equal(recordCall(f.store, PROJECT, request(f, { packet: other })).ok, false);
  assert.deepEqual(f.store.list().map(reference), before);
  for (const field of ['text', 'labels', 'manifest', 'references', 'contract', 'requestId']) {
    const broken = structuredClone(packet) as Record<string, any>; delete broken.brief[field];
    addressed(recordCall(f.store, PROJECT, request(f, { packet: broken })), 'packet_invalid');
    assert.deepEqual(f.store.list().map(reference), before);
  }
});

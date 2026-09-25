import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Question } from "../src/discovery/discovery.js";
import { assessAnswer } from "../src/discovery/research-assessment.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { type OmResult, type Refusal } from "../src/om/refusal.js";
import { beginAttempt, completeAttempt, openSeries, prepareSeriesAdmission, type AttemptGoal, type RepairSeries, type MechanismAdmission } from "../src/om/series.js";
import { closeAttempt } from "../src/om/repeat-gate.js";
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from "../src/om/refusal-journal.js";
import { writeOmInput } from "../src/om/input.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { writeHorizon } from "../src/om/horizon.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { writeRoutes } from "../src/om/routes.js";
import { prepareQuestionTasks, writeQuestionPacket, type QuestionPacketRequest } from "../src/om/question-packet.js";
import { gapLineKey, gapLineExpectedResult, writeGapLines } from "../src/om/gap-lines.js";
import { writeOmObligations, normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND } from "../src/om/obligations.js";
import { mc1FieldSpec, writeMc1Question, writeAcceptedAnswer, type AnswerQuestionContract } from "../src/om/accepted-answer.js";
import { confirmResults } from "../src/om/achievements.js";
import { writeGuarded } from "../src/om/refs.js";
import { runModelTransport, runModelCall, readModelTransport, readModelCallPhysical, type ModelTransportRequest, type ModelCallRequest } from "../src/om/model-call.js";
import { spendReport, readSpendReport, type SpendSnapshot } from "../src/om/spend-report.js";
import { Environments } from "../src/runtime/environment.js";
import type { ModelCall } from "../src/runtime/model-usage.js";
import type { ProcessResult } from "../src/runtime/process.js";
import { executionOf, prepareLateModelReceipt } from "../src/discovery/model-call-recovery.js";
import {
  CALL_LEDGER_KIND, CALL_RECORD_KIND, callLedgerId, callRecordId,
  readCallLedger, readCallLedgerAt, recordCall, settleCall,
  type CallLedger, type RecordCallRequest, type MechanismRecordCallRequest,
} from "../src/om/call-record.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { answerLayerFixture } from "./layer-design-fixture.js";

const PROJECT = "alpha";
const BLOCK = "block:cart";
const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 };
const actualUsage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };

function deliveredOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`unexpected refusal ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

function refusedWith(result: OmResult<unknown>, codes: string | readonly string[]): Refusal {
  if (result.ok) assert.fail("expected an addressed refusal");
  assert.ok((typeof codes === "string" ? [codes] : codes).includes(result.refusal.code), result.refusal.code);
  assert.equal(result.refusal.at.unit, "gate-admit");
  assert.ok(result.refusal.at.target.length > 0);
  assert.ok(result.refusal.message.length > 0);
  return result.refusal;
}

function deeplyFrozen(value: unknown): boolean {
  return value === null || typeof value !== "object"
    || Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(deeplyFrozen);
}

interface Fixture {
  readonly path: string;
  readonly store: Store;
  readonly series: Revision<RepairSeries>;
  readonly adapter: Ref;
  readonly config: Ref;
  readonly goal: AttemptGoal;
}

function fixture(t: test.TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "omg-om-spend-"));
  const path = join(root, "state.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const adapter = reference(store.write({
    id: `adapter:${PROJECT}`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: PROJECT, protocol: "codex-stdio", status: "configured-not-accepted" },
  }));
  const config = reference(store.write({
    id: `config:${PROJECT}`, kind: "dispatch-config", expected: 0,
    value: { projectId: PROJECT, model: "fixture", transport: "stdio", status: "configured-not-accepted" },
  }));
  deliveredOf(openSeries(store, {
    project: PROJECT, block: BLOCK, line: 1, slice: "slice:cart@1", predecessor: null, basis: null,
  }));
  const goal: AttemptGoal = {
    key: "gap:cart:price", questions: ["which operation owns the price?"], result: "an accepted price producer",
  };
  const series = deliveredOf(beginAttempt(store, { project: PROJECT, block: BLOCK, line: 1, attempt: 1, goal }));
  return { path, store, series, adapter, config, goal };
}

function request(f: Fixture, call: string): RecordCallRequest {
  return {
    call, purpose: "model-research", basis: null, block: BLOCK,
    gaps: [{ id: "gap:price", goal: "price contract", field: "contract", consumer: BLOCK }],
    series: reference(f.series), attempt: 1, goal: f.goal,
    dispatch: { adapter: f.adapter, config: f.config }, packet: { question: "who produces the price?" },
  };
}

function rewriteLedger(f: Fixture, value: unknown): Ref {
  const current = f.store.get(callLedgerId(PROJECT));
  return reference(f.store.write({
    id: callLedgerId(PROJECT), kind: CALL_LEDGER_KIND, expected: current?.revision ?? 0, value,
  }));
}

/** A historical report must not obtain its facts from a later head or enumeration. */
class ExactOnlyStore extends Store {
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    assert.notEqual(revision, undefined, `historical read consulted head ${id}`);
    return super.get<T>(id, revision);
  }
  override list<T = Json>(_kind?: string): Revision<T>[] {
    assert.fail("historical read enumerated current records");
  }
}

test("E6 ledger: absence is explicit; reading current and exact snapshots writes nothing and seals the result", t => {
  const f = fixture(t);
  const beforeEmpty = canonical(f.store.list());
  assert.equal(deliveredOf(readCallLedger(f.store, PROJECT)), null);
  assert.equal(canonical(f.store.list()), beforeEmpty);
  const first = deliveredOf(recordCall(f.store, PROJECT, request(f, "price-1")));
  const before = canonical(f.store.list());
  const current = deliveredOf(readCallLedger(f.store, PROJECT));
  const historical = deliveredOf(readCallLedgerAt(f.store, PROJECT, reference(first.ledger)));
  assert.deepEqual(current, first.ledger);
  assert.deepEqual(historical, first.ledger);
  assert.ok(deeplyFrozen(current));
  assert.ok(deeplyFrozen(historical));
  assert.equal(canonical(f.store.list()), before);
});

test("E6 ledger: unknown usage stays open and differs from an explicitly settled zero", t => {
  const f = fixture(t);
  const unknown = deliveredOf(recordCall(f.store, PROJECT, request(f, "unknown")));
  const unsettled = deliveredOf(settleCall(f.store, reference(unknown.call), null, "failed"));
  assert.equal(unsettled.settled, false);
  assert.deepEqual(unsettled.ledger, unknown.ledger);
  const zero = deliveredOf(recordCall(f.store, PROJECT, request(f, "zero")));
  const settled = deliveredOf(settleCall(f.store, reference(zero.call), zeroUsage, "succeeded"));
  const ledger = deliveredOf(readCallLedger(f.store, PROJECT))!;
  assert.deepEqual(ledger, settled.ledger);
  const unknownRow = ledger.value.calls.find(row => row.name === "unknown")!;
  const zeroRow = ledger.value.calls.find(row => row.name === "zero")!;
  assert.equal(unknownRow.usage, null);
  assert.equal(unknownRow.status, "open");
  assert.equal(unknownRow.settledAt, null);
  assert.deepEqual(zeroRow.usage, zeroUsage);
  assert.equal(zeroRow.status, "succeeded");
  assert.equal(typeof zeroRow.settledAt, "number");
  assert.equal(ledger.value.calls.length, 2);
});

test("E6 ledger: exact admission and settlement snapshots survive later calls, head changes and restart", t => {
  const f = fixture(t);
  const first = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  const settled = deliveredOf(settleCall(f.store, reference(first.call), actualUsage, "succeeded"));
  const second = deliveredOf(recordCall(f.store, PROJECT, request(f, "second")));
  deliveredOf(settleCall(f.store, reference(second.call), zeroUsage, "failed"));
  assert.equal(deliveredOf(readCallLedger(f.store, PROJECT))!.value.calls.length, 2);
  f.store.close();
  const reopened = new ExactOnlyStore(f.path);
  try {
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(first.ledger))), first.ledger);
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(settled.ledger))), settled.ledger);
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(second.ledger))), second.ledger);
  } finally { reopened.close(); }
});

test("E6 ledger: a missing ledger cannot turn existing calls into an empty current report", t => {
  const f = fixture(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  class MissingLedgerStore extends Store {
    override get<T = Json>(id: string, revision?: number): Revision<T> | null {
      return id === callLedgerId(PROJECT) ? null : super.get<T>(id, revision);
    }
  }
  const missing = new MissingLedgerStore(f.path);
  try {
    refusedWith(readCallLedger(missing, PROJECT), "ledger_invalid");
    refusedWith(readCallLedgerAt(missing, PROJECT, reference(recorded.ledger)), "ledger_invalid");
  } finally { missing.close(); }
});

test("E6 ledger: an exact historical slice requires its own project, revision and hash", t => {
  const f = fixture(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  const ref = reference(recorded.ledger);
  for (const invalid of [
    { ...ref, id: callLedgerId("other") },
    { ...ref, hash: "0".repeat(64) },
    { ...ref, revision: ref.revision + 1 },
    { id: ref.id },
    null,
  ]) {
    refusedWith(readCallLedgerAt(f.store, PROJECT, invalid as Ref), "ledger_invalid");
  }
});

test("E6 ledger: malformed and incomplete ledger values are refusals, not empty slices", t => {
  const cases: ((valid: CallLedger) => unknown)[] = [
    () => null, () => ({}), valid => ({ calls: valid.calls }), () => ({ projectId: PROJECT }),
    valid => ({ ...valid, projectId: "other" }), valid => ({ ...valid, calls: null }),
    valid => ({ ...valid, calls: {} }), valid => ({ ...valid, extra: true }),
  ];
  for (const change of cases) {
    const f = fixture(t);
    const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
    const ref = rewriteLedger(f, change(recorded.ledger.value));
    refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  }
});

for (const field of ["call", "name", "purpose", "basis", "block", "gaps", "series", "attempt", "goal", "status", "usage", "openedAt", "settledAt"]) {
  test(`E6 ledger: missing row.${field} is refused by both readers`, t => {
    const f = fixture(t);
    const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
    const row = { ...recorded.ledger.value.calls[0] } as Record<string, unknown>;
    delete row[field];
    const ref = rewriteLedger(f, { projectId: PROJECT, calls: [row] });
    refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  });
}

test("E6 ledger: the current full set rejects a removed row and historical transitions cannot lose an admitted call", t => {
  const f = fixture(t);
  deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  const second = deliveredOf(recordCall(f.store, PROJECT, request(f, "second")));
  const ref = rewriteLedger(f, { projectId: PROJECT, calls: second.ledger.value.calls.slice(0, 1) });
  refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
  refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  assert.deepEqual(deliveredOf(readCallLedgerAt(f.store, PROJECT, reference(second.ledger))), second.ledger);
});

test("E6 ledger: historical transitions cannot replace a call, repeat a snapshot, or duplicate an identity", t => {
  for (const kind of ["replace", "repeat", "duplicate"]) {
    const f = fixture(t);
    const first = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
    const second = deliveredOf(recordCall(f.store, PROJECT, request(f, "second")));
    const firstRow = first.ledger.value.calls[0]!;
    const secondRow = second.ledger.value.calls.find(row => row.call.id !== firstRow.call.id)!;
    const calls = kind === "replace" ? [secondRow] : kind === "repeat" ? second.ledger.value.calls : [firstRow, firstRow];
    const ref = rewriteLedger(f, { projectId: PROJECT, calls });
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  }
});

test("E6 ledger: copied rows must equal the exact call, including expense and addressed questions", t => {
  for (const kind of ["usage", "gaps", "name", "purpose", "status"]) {
    const f = fixture(t);
    const opened = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
    const settled = deliveredOf(settleCall(f.store, reference(opened.call), actualUsage, "succeeded"));
    const row = settled.ledger.value.calls[0]!;
    const changed = kind === "usage" ? { ...row, usage: { ...actualUsage, inputTokens: 0 } }
      : kind === "gaps" ? { ...row, gaps: [{ ...row.gaps[0], id: "gap:other" }] }
      : kind === "name" ? { ...row, name: "other" }
      : kind === "purpose" ? { ...row, purpose: "model-design" }
      : { ...row, status: "open", usage: null, settledAt: null };
    const ref = rewriteLedger(f, { projectId: PROJECT, calls: [changed] });
    refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  }
});

test("E6 ledger: absent, foreign and wrong-hash exact call references refuse a historical slice", t => {
  for (const kind of ["missing", "foreign", "hash", "revision"]) {
    const f = fixture(t);
    const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
    const row = recorded.ledger.value.calls[0]!;
    const call = kind === "missing" ? { ...row.call, id: callRecordId(PROJECT, "missing") }
      : kind === "foreign" ? { ...row.call, id: callRecordId("other", "first") }
      : kind === "hash" ? { ...row.call, hash: "0".repeat(64) } : { ...row.call, revision: 42 };
    const ref = rewriteLedger(f, { projectId: PROJECT, calls: [{ ...row, call }] });
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), ["call_unresolved", "ledger_invalid"]);
  }
});

test("E6 ledger: a named call's saved shape is validated rather than trusted from its ledger row", t => {
  const f = fixture(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  const changed = { ...recorded.call.value, gaps: [] };
  const call = f.store.write({ id: recorded.call.id, kind: CALL_RECORD_KIND, expected: 1, value: changed });
  const row = { ...recorded.ledger.value.calls[0], call: reference(call), gaps: [] };
  const ref = rewriteLedger(f, { projectId: PROJECT, calls: [row] });
  refusedWith(readCallLedger(f.store, PROJECT), "call_record_invalid");
  refusedWith(readCallLedgerAt(f.store, PROJECT, ref), ["call_record_invalid", "ledger_invalid"]);
});

test("E6 ledger: invalid reader arguments and undeclared historical contexts are typed refusals", t => {
  const f = fixture(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  const ref = reference(recorded.ledger);
  const invalid = (error: unknown) => error instanceof EngineError && error.code === "call_request_invalid";
  assert.throws(() => readCallLedger({} as Store, PROJECT), invalid);
  assert.throws(() => readCallLedgerAt({} as Store, PROJECT, ref), invalid);
  for (const project of ["", "alpha:other", null as unknown as string]) {
    assert.throws(() => readCallLedger(f.store, project), invalid);
    assert.throws(() => readCallLedgerAt(f.store, project, ref), invalid);
  }
  type History = NonNullable<Parameters<typeof readCallLedgerAt>[3]>;
  const context = { call: reference(recorded.call), journal: ref };
  for (const history of [null, {}, [null], [{}], [{ call: context.call }], new Array(1), [context, context]]) {
    assert.throws(() => readCallLedger(f.store, PROJECT, history as History), invalid);
    assert.throws(() => readCallLedgerAt(f.store, PROJECT, ref, history as History), invalid);
  }
  refusedWith(readCallLedger(f.store, PROJECT, [context]), "ledger_invalid");
  refusedWith(readCallLedgerAt(f.store, PROJECT, ref, [context]), "ledger_invalid");
  const unused = { ...context, call: { ...context.call, id: callRecordId(PROJECT, "unused") } };
  refusedWith(readCallLedger(f.store, PROJECT, [unused]), "ledger_invalid");
  refusedWith(readCallLedgerAt(f.store, PROJECT, ref, [unused]), "ledger_invalid");
});

function mechanismOriginFixture(t: test.TestContext) {
  const f = fixture(t), engine = new ProductEngine(f.store);
  const owner = { kind: "mechanism", mechanism: "M5:addressing" } as const;
  const { level: _level, ...l1 } = projectGraph(gardenGraph("cross", PROJECT), 1);
  preparedFeatures(engine, PROJECT, l1 as Graph, field => {
    const value = preparedField(PROJECT, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{
      id: "encoding", question: "Which output encoding is supported?", consumer: `${PROJECT}-consume-block`,
      moment: "om-pass", blocksCurrentStage: false, resolution: "Address this question before research",
    }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${PROJECT}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = deliveredOf(writeOmInput(f.store, { project: PROJECT, expected: 0, stages }));
  const graph = reference(f.store.get(`graph:${PROJECT}`)!);
  const horizon = deliveredOf(writeHorizon(f.store, { project: PROJECT, input: reference(input), graph, refinement: null, available: {},
    choice: { choiceVersion: "spend-origin", features: [{ outcome: `${PROJECT}-result` }], excluded: [] } }));
  const sources: GapRequest = { project: PROJECT, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project: PROJECT, level: 2, graph, horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${PROJECT}:2`)!) } };
  const gaps = deliveredOf(writeGaps(f.store, sources));
  const scope = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const routes = deliveredOf(writeRoutes(f.store, { project: PROJECT, gaps: scope, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(item => item.task === "input-field"
    && item.items.some(member => member.target === "discovery:encoding") && item.items.every(member => member.consumers.length === 0));
  assert.ok(batch);
  const admission: MechanismAdmission = { gaps: scope, routes: reference(routes), batch: batch.id };
  const address = { project: PROJECT, owner, line: 1 };
  deliveredOf(openSeries(f.store, { ...address, scope, predecessor: null, basis: null }));
  const goal = { key: "address-encoding", ...deliveredOf(prepareSeriesAdmission(f.store, address, admission)).goal };
  const running = deliveredOf(beginAttempt(f.store, { ...address, attempt: 1, goal, admission }));
  function appendRefusal(suffix: string) {
    const source = f.store.write({ id: `${unitRefusalNamespace(PROJECT)}spend-${suffix}`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: "G3", refusals: [{ code: `graph_invalid:${suffix}`, goal: goal.key,
        remedy: "identify the producer or the defective derivation",
        origin: { name: "artifact_missing", stage: "layer-check", subject: "artifact:cart", sources: [] } }] } });
    return deliveredOf(recordRefusal(f.store, { project: PROJECT, source: reference(source) }));
  }
  const journal = appendRefusal("held"), row = journal.value.rows[journal.value.rows.length - 1]!;
  const closed = deliveredOf(closeAttempt(f.store, { ...address, attempt: 1,
    outcome: { reason: "refused", accepting: [], cancelling: [], refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
  assert.equal(closed.holds.length, 1);
  const hold = closed.holds[0]!, series = f.store.get(running.id)!;
  const analysisGoal = { key: "analyse-encoding-origin", questions: ["What caused this unanswered encoding question?"],
    result: "A checked origin for the saved refusal" };
  const analysis: MechanismRecordCallRequest = {
    call: "mechanism-origin", purpose: "origin-analysis", basis: { kind: "origin-hold", hold }, owner, admission,
    gaps: [{ id: hold.id, goal: analysisGoal.key, field: "origin", consumer: owner }],
    series: reference(series), attempt: 1, goal: analysisGoal,
    dispatch: { adapter: f.adapter, config: f.config }, packet: { question: "What caused this saved refusal?" },
  };
  const recorded = deliveredOf(recordCall(f.store, PROJECT, analysis));
  const settled = deliveredOf(settleCall(f.store, reference(recorded.call), actualUsage, "succeeded"));
  return { ...f, recorded, settled, journal: reference(f.store.get(journal.id)!), appendRefusal, gaps, gapScope: scope };
}

test("E6 ledger: mechanism origin analysis reads its exact journal after later journal heads and restart", t => {
  const f = mechanismOriginFixture(t);
  const currentHistory = [{ call: reference(f.settled.call), journal: f.journal }];
  assert.deepEqual(deliveredOf(readCallLedger(f.store, PROJECT, currentHistory)), f.settled.ledger);
  const laterJournal = f.appendRefusal("later");
  assert.ok(laterJournal.revision > f.journal.revision);
  f.store.close();
  const reopened = new ExactOnlyStore(f.path);
  try {
    const admissionHistory = [{ call: reference(f.recorded.call), journal: f.journal }];
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(f.recorded.ledger), admissionHistory)), f.recorded.ledger);
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(f.settled.ledger), currentHistory)), f.settled.ledger);
    refusedWith(readCallLedgerAt(reopened, PROJECT, reference(f.recorded.ledger)), "ledger_invalid");
    for (const journal of [
      { ...f.journal, hash: "0".repeat(64) }, { ...f.journal, revision: 50 }, { ...f.journal, id: "om-refusal-journal:other" },
    ]) {
      refusedWith(readCallLedgerAt(reopened, PROJECT, reference(f.recorded.ledger), [{ call: reference(f.recorded.call), journal }]),
        ["ledger_invalid", "call_record_invalid"]);
    }
  } finally { reopened.close(); }
});

function spendRefused(result: OmResult<unknown>, codes: string | readonly string[]): Refusal {
  if (result.ok) assert.fail("Expected a spend report refusal");
  assert.ok((typeof codes === "string" ? [codes] : codes).includes(result.refusal.code), result.refusal.code);
  assert.ok(result.refusal.at.target);
  assert.ok(result.refusal.message);
  return result.refusal;
}

test("E6 report: empty OM scope is explicit and excludes native research calls", t => {
  const f = fixture(t);
  // The native research producer owns another namespace and does not write E1.
  f.store.write({ id: "model-call:3e621321-003a-4abf-8da4-dd8b827697ce", kind: "model-call", expected: 0,
    value: { projectId: PROJECT, purpose: "research-assessment", status: "succeeded", usage: actualUsage } });
  const before = canonical(f.store.list());
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.equal(report.scope, "om-e1");
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.findings, []);
  assert.equal(report.snapshot.ledger, null);
  assert.deepEqual(report.snapshot.calls, []);
  assert.equal(report.totals.calls, 0);
  assert.equal(report.totals.unmeasuredCalls, 0);
  assert.equal(canonical(f.store.list()), before);
  assert.ok(deeplyFrozen(report));
});

test("E6 report: one packet with several questions and consumers incurs one expense, with no hidden significance threshold", t => {
  const f = fixture(t), input = request(f, "package");
  const admitted = deliveredOf(recordCall(f.store, PROJECT, { ...input, gaps: [
    { id: "encoding", goal: "Encoding at first consumer", field: "encoding", consumer: "block:first" },
    { id: "encoding", goal: "Encoding at second consumer", field: "encoding", consumer: "block:second" },
    { id: "transport", goal: "Transport at second consumer", field: "transport", consumer: "block:second" },
  ] }));
  const measured = { inputTokens: 9_000_000, outputTokens: 3_000_000, cachedInputTokens: 2_000_000, reasoningOutputTokens: 1_000_000 };
  const settled = deliveredOf(settleCall(f.store, reference(admitted.call), measured, "succeeded"));
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.equal(report.rows.length, 1);
  const row = report.rows[0]!;
  assert.deepEqual(row.call, reference(settled.call));
  assert.deepEqual(row.questions, settled.call.value.gaps);
  assert.equal(row.questions.length, 3);
  assert.deepEqual(row.usage, measured);
  assert.equal(row.settlement, "succeeded");
  assert.deepEqual(row.significance, { obligations: null, consumers: null, blocks: null, sources: [] });
  assert.equal(row.result, null, "Settlement is not acceptance of an attempt result");
  assert.deepEqual(report.totals, { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: measured });
  assert.deepEqual(report.byPurpose["model-research"], report.totals);
  assert.deepEqual(report.findings, [], "Disproportionate expense is the owner's decision, not an automatic finding");
});

test("E6 report: partial token measurements stay unknown, explicit zeros stay measured and purposes stay separate", t => {
  const f = fixture(t);
  const unknown = deliveredOf(recordCall(f.store, PROJECT, request(f, "unknown")));
  const zero = deliveredOf(recordCall(f.store, PROJECT, { ...request(f, "zero"), purpose: "model-design" }));
  deliveredOf(settleCall(f.store, reference(zero.call), zeroUsage, "failed"));
  const partial = deliveredOf(recordCall(f.store, PROJECT, request(f, "partial")));
  const measured = { inputTokens: 120, outputTokens: 30, cachedInputTokens: null, reasoningOutputTokens: null };
  deliveredOf(settleCall(f.store, reference(partial.call), measured, "succeeded"));
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.equal(report.totals.calls, 3);
  assert.equal(report.totals.measuredCalls, 2);
  assert.equal(report.totals.unmeasuredCalls, 1);
  assert.deepEqual(report.totals.reportedTokens, measured);
  assert.deepEqual(report.byPurpose["model-design"], { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: zeroUsage });
  assert.equal(report.byPurpose["model-research"].calls, 2);
  assert.deepEqual(report.findings.map(item => item.code), ["call_not_settled"]);
  assert.equal(report.findings[0]!.at.target, unknown.call.id);
  assert.equal(report.rows.find(row => row.call?.id === unknown.call.id)!.usage, null);
});

test("E6 report: historical snapshots keep exact expense and unfinished outcomes after later settlement, attempts and restart", t => {
  const f = fixture(t);
  const first = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  const saved = deliveredOf(spendReport(f.store, { project: PROJECT }));
  deliveredOf(settleCall(f.store, reference(first.call), actualUsage, "succeeded"));
  deliveredOf(completeAttempt(f.store, { project: PROJECT, block: BLOCK, line: 1, attempt: 1,
    outcome: { reason: "result", achieved: [], cancelled: [], refusals: [] } }));
  deliveredOf(beginAttempt(f.store, { project: PROJECT, block: BLOCK, line: 1, attempt: 2, goal: f.goal }));
  const current = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.deepEqual(current.rows[0]!.usage, actualUsage);
  assert.notDeepEqual(current.snapshot, saved.snapshot);
  f.store.close();
  const historical = new ExactOnlyStore(f.path);
  try { assert.deepEqual(deliveredOf(readSpendReport(historical, saved.snapshot as SpendSnapshot)), saved); }
  finally { historical.close(); }
});

test("E6 report: every historical snapshot field is mandatory, including explicit empty sets and null ledger", t => {
  const f = fixture(t);
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  const invalid = (error: unknown) => error instanceof EngineError && error.code === "spend_request_invalid";
  for (const field of ["project", "ledger", "calls", "series", "histories", "significance", "late"]) {
    const bad = { ...report.snapshot } as Record<string, unknown>;
    delete bad[field];
    assert.throws(() => readSpendReport(f.store, bad as unknown as SpendSnapshot), invalid, field);
  }
  for (const input of [null, {}, { project: "" }, { project: PROJECT, extra: true }, { project: PROJECT, histories: null }]) {
    assert.throws(() => spendReport(f.store, input as Parameters<typeof spendReport>[1]), invalid);
  }
});

test("E6 report: invalid E1 questions with a consistent hash remain a refusal of record integrity", t => {
  const question = { id: "gap:price", goal: "price contract", field: "contract", consumer: BLOCK };
  const malformed = [[], ...Object.keys(question).map(field => [Object.fromEntries(Object.entries(question).filter(([key]) => key !== field))])];
  for (const gaps of malformed) {
    const f = fixture(t);
    const original = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
    const bad = f.store.write({ id: callRecordId(PROJECT, "bad-questions"), kind: CALL_RECORD_KIND, expected: 0,
      value: { ...original.call.value, call: "bad-questions", gaps } });
    const badRow = { ...original.ledger.value.calls[0], call: reference(bad), name: "bad-questions", gaps };
    rewriteLedger(f, { projectId: PROJECT, calls: [original.ledger.value.calls[0]!, badRow].sort((a, b) => a.call.id.localeCompare(b.call.id)) });
    spendRefused(spendReport(f.store, { project: PROJECT }), "call_record_invalid");
  }
});

test("E6 report: corrupted ledger and exact snapshot references cannot become unknown significance or empty expense", t => {
  const f = fixture(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "first")));
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  spendRefused(readSpendReport(f.store, { ...report.snapshot, ledger: { ...reference(recorded.ledger), hash: "0".repeat(64) } }), "ledger_invalid");
  rewriteLedger(f, { projectId: PROJECT, calls: [] });
  spendRefused(spendReport(f.store, { project: PROJECT }), "ledger_invalid");
});

test("E6 report: explicit D1 sources count distinct obligations, consumers and blocks rather than repeated mentions", t => {
  const f = mechanismOriginFixture(t);
  const selected = f.gaps.records.filter(record => record.value.gap.code === "obligation_open" && record.value.gap.consumers.length > 0);
  assert.ok(selected.length >= 2, "The real frame fixture carries several addressed obligations");
  const chosen = selected.slice(0, 2), rows = chosen.flatMap(record => record.value.gap.consumers.map(consumer => ({
    id: record.value.gap.target, goal: record.value.gap.target, field: record.value.gap.field, consumer,
  })));
  const recorded = deliveredOf(recordCall(f.store, PROJECT, { ...request(f, "declared-significance"), gaps: [...rows, rows[0]!] }));
  const settled = deliveredOf(settleCall(f.store, reference(recorded.call), actualUsage, "succeeded"));
  const source = { call: reference(settled.call), gaps: f.gapScope, obligations: null };
  const report = deliveredOf(spendReport(f.store, { project: PROJECT,
    histories: [{ call: reference(f.settled.call), journal: f.journal }], significance: [source] }));
  const row = report.rows.find(item => item.call?.id === settled.call.id)!;
  assert.ok(row);
  assert.equal(row.questions.length, rows.length + 1, "Accounting keeps every declared question in the package");
  assert.equal(row.significance.obligations, new Set(chosen.map(item => item.value.gap.target)).size);
  const consumers = new Set(rows.map(item => item.consumer));
  assert.equal(row.significance.consumers, consumers.size);
  const graph = f.store.get<Graph>(f.gapScope.sources.graph.id, f.gapScope.sources.graph.revision)!.value;
  const blocks = new Set([...consumers].map(consumer => {
    let node = graph.nodes.find(item => item.id === consumer)!;
    assert.ok(node, "Each D1 consumer has an exact graph address");
    while (node.kind !== "block" && node.parent !== null) node = graph.nodes.find(item => item.id === node.parent)!;
    assert.equal(node.kind, "block");
    return node.id;
  }));
  assert.equal(row.significance.blocks, blocks.size);
  assert.ok(row.significance.sources.length > 0);
  assert.deepEqual(row.usage, actualUsage);
  f.store.close();
  const reopened = new ExactOnlyStore(f.path);
  try { assert.deepEqual(deliveredOf(readSpendReport(reopened, report.snapshot as SpendSnapshot)), report); }
  finally { reopened.close(); }
});

test("E6 report: a valid D1 set unrelated to the call is refused instead of producing guessed counts", t => {
  const f = mechanismOriginFixture(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, request(f, "unrelated-to-d1")));
  const report = spendReport(f.store, { project: PROJECT,
    histories: [{ call: reference(f.settled.call), journal: f.journal }],
    significance: [{ call: reference(recorded.call), gaps: f.gapScope, obligations: null }] });
  const refusal = spendRefused(report, "spend_basis_invalid");
  assert.equal(refusal.at.target, recorded.call.id);
  assert.equal(refusal.at.field, "gaps");
});

test("E6 report: a named missing or incorrect D1 source is a refusal rather than unknown significance", t => {
  const f = mechanismOriginFixture(t);
  const selected = f.gaps.records.find(record => record.value.gap.code === "obligation_open" && record.value.gap.consumers.length > 0)!;
  assert.ok(selected);
  const gap = selected.value.gap;
  const recorded = deliveredOf(recordCall(f.store, PROJECT, { ...request(f, "exact-d1"),
    gaps: [{ id: gap.target, goal: gap.target, field: gap.field, consumer: gap.consumers[0]! }] }));
  for (const changed of [
    { ...f.gapScope, records: f.gapScope.records.filter(ref => ref.id !== selected.id) },
    { ...f.gapScope, records: f.gapScope.records.map(ref => ref.id === selected.id ? { ...ref, hash: "0".repeat(64) } : ref) },
    { ...f.gapScope, sources: { ...f.gapScope.sources, input: { ...f.gapScope.sources.input, revision: 99 } } },
  ]) {
    const result = spendReport(f.store, { project: PROJECT,
      histories: [{ call: reference(f.settled.call), journal: f.journal }],
      significance: [{ call: reference(recorded.call), gaps: changed, obligations: null }] });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.ok(result.refusal.code); assert.ok(result.refusal.at.target); }
  }
});

const providerPath = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
function physicalFixture(t: test.TestContext, purpose: "stop-analysis" | "origin-analysis" = "stop-analysis") {
  const root = mkdtempSync(join(tmpdir(), "omg-spend-physical-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = "analysis", block = "analysis-block", address = { project, block, line: 1 };
  store.write({ id: `project:${project}`, kind: "project", expected: 0, value: { id: project, title: "Spend report fixture" } });
  const goal = { key: "physical-ground", questions: ["Which contract needs evidence?"], result: "An evidenced contract" };
  deliveredOf(openSeries(store, { ...address, slice: "analysis-slice", predecessor: null, basis: null }));
  let series = deliveredOf(beginAttempt(store, { ...address, attempt: 1, goal })) as Revision<RepairSeries>;
  let basis: { kind: "series-stop"; series: Ref; attempt: number } | { kind: "origin-hold"; hold: Ref };
  if (purpose === "stop-analysis") {
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) deliveredOf(beginAttempt(store, { ...address, attempt, goal }));
      series = deliveredOf(completeAttempt(store, { ...address, attempt,
        outcome: { reason: "result", achieved: [], cancelled: [], refusals: [] } })) as Revision<RepairSeries>;
    }
    basis = { kind: "series-stop", series: reference(series), attempt: 3 };
  } else {
    const source = store.write({ id: `${unitRefusalNamespace(project)}spend-origin`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: "G3", refusals: [{ code: "unrecognized_spend_refusal", goal: goal.key, remedy: "Identify the exact origin",
        origin: { name: "artifact_missing", stage: "layer-check", subject: "artifact:fixture", sources: [] } }] } });
    const journal = deliveredOf(recordRefusal(store, { project, source: reference(source) })), row = journal.value.rows[0]!;
    const closed = deliveredOf(closeAttempt(store, { ...address, attempt: 1,
      outcome: { reason: "refused", accepting: [], cancelling: [], refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
    assert.equal(closed.holds.length, 1);
    series = store.get<RepairSeries>(series.id)!;
    basis = { kind: "origin-hold", hold: closed.holds[0]! };
  }
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [providerPath, "--scenario", scenario, "--trace", trace] };
  const environment = new Environments(store).configure(project, { workspace: root,
    implementer: { actor: "physical-author", model: "fixture", effort: "high", command },
    reviewer: { actor: "physical-reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 30_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}`, kind: "dispatch-adapter", expected: 0, value: { protocol: "codex-stdio" } });
  const packet = { task: "Analyse this exact stop", basis } as unknown as Json;
  const reviewGoal = { key: purpose, questions: ["What caused this ground?"], result: "An evidenced cause or an explicit hypothesis" };
  const admitted = deliveredOf(recordCall(store, project, { call: `spend:${purpose}`, purpose, basis, block,
    gaps: [{ id: purpose, goal: purpose, field: "cause", consumer: "A6:stop-analysis" }],
    series: reference(series), attempt: purpose === "stop-analysis" ? 3 : 1, goal: reviewGoal,
    dispatch: { adapter: reference(adapter), config: reference(environment) }, packet }));
  const request: ModelTransportRequest = { project, call: reference(admitted.call), packet, role: "reviewer" };
  function scenarioUsage(usage: unknown) {
    writeFileSync(scenario, JSON.stringify({ steps: [{ research: { cause: "fixture observation", hypothesis: true }, usage }] }));
  }
  scenarioUsage(actualUsage);
  return { root, database, project, series, admitted, request, scenario, trace, scenarioUsage,
    get store() { return store; }, restart() { store.close(); store = new Store(database); },
    sent() { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; } };
}

/** Commit the actual E4 claim and stop before the provider can be launched. */
async function retainedPhysicalClaim(store: Store, invoke: () => Promise<unknown>): Promise<Revision<ModelCall>> {
  const checkpoint = new Error("Physical claim retained before provider launch"), writeMany = store.writeMany.bind(store);
  let captured: Revision<ModelCall> | undefined;
  store.writeMany = ((writes, guards) => {
    const saved = writeMany(writes, guards);
    if (writes.some(write => write.kind === "model-call" && write.expected === 0)) {
      captured = saved.find(record => record.kind === "model-call") as unknown as Revision<ModelCall>;
      throw checkpoint;
    }
    return saved;
  }) as Store["writeMany"];
  try { await assert.rejects(invoke, error => error === checkpoint); }
  finally { store.writeMany = writeMany; }
  assert.ok(captured);
  assert.equal(captured.value.status, "running");
  assert.equal(captured.value.execution?.phase, "claimed");
  assert.equal(captured.value.providerProcess, undefined);
  return captured;
}

type PhysicalBody = Record<string, Json>;
interface InvalidPhysicalCase { name: string; change: (body: PhysicalBody) => void }
const physicalObject = (body: PhysicalBody, key: string) => body[key] as PhysicalBody;
function authorizedBody(body: PhysicalBody): PhysicalBody {
  const owner = physicalObject(body, "ownerProcess"), execution = physicalObject(body, "execution");
  body.providerProcess = structuredClone(owner);
  execution.phase = "authorized";
  execution.provider = { ...owner, group: owner.pid! };
  return execution;
}
const unreceivedPhysicalCases: InvalidPhysicalCase[] = [
  ...["draftId", "status", "startedAt", "finishedAt", "response", "usage", "error", "confirmed", "usageSource", "execution", "ownerProcess", "requested", "request"]
    .map(field => ({ name: `missing ${field}`, change: (body: PhysicalBody) => { delete body[field]; } })),
  { name: "null requested", change: body => { body.requested = null; } },
  { name: "null request", change: body => { body.request = null; } },
  { name: "wrong draft identity", change: body => { body.draftId = "another-physical-assignment"; } },
  ...[null, "1000", -1, 1.5].map(value => ({ name: `invalid startedAt ${JSON.stringify(value)}`,
    change: (body: PhysicalBody) => { body.startedAt = value; } })),
  { name: "finished running call", change: body => { body.finishedAt = (body.startedAt as number) + 1; } },
  { name: "running response evidence", change: body => { body.response = { chars: 1, bytes: 1 }; } },
  { name: "running known usage", change: body => { body.usage = actualUsage; } },
  { name: "running measured zero", change: body => { body.usage = zeroUsage; } },
  { name: "running error", change: body => { body.error = "provider_failed"; } },
  { name: "null confirmed", change: body => { body.confirmed = null; } },
  ...["model", "effort", "speed"].flatMap(field => [
    { name: `missing confirmed.${field}`, change: (body: PhysicalBody) => { delete physicalObject(body, "confirmed")[field]; } },
    { name: `running confirmed.${field}`, change: (body: PhysicalBody) => { physicalObject(body, "confirmed")[field] = "known"; } },
  ]),
  { name: "extra confirmed evidence", change: body => { physicalObject(body, "confirmed").extra = null; } },
  { name: "null usageSource", change: body => { body.usageSource = null; } },
  { name: "adapter usageSource without receipt", change: body => { body.usageSource = "adapter"; } },
  { name: "null execution", change: body => { body.execution = null; } },
  { name: "null ownerProcess", change: body => { body.ownerProcess = null; } },
  ...["version", "phase", "owner", "provider"].map(field => ({ name: `missing execution.${field}`,
    change: (body: PhysicalBody) => { delete physicalObject(body, "execution")[field]; } })),
  { name: "unknown execution era", change: body => { physicalObject(body, "execution").version = "model-execution/unknown"; } },
  { name: "unknown execution phase", change: body => { physicalObject(body, "execution").phase = "finished"; } },
  { name: "null execution owner", change: body => { physicalObject(body, "execution").owner = null; } },
  { name: "different execution owner", change: body => {
    physicalObject(body, "execution").owner = { ...physicalObject(body, "ownerProcess"), pid: process.pid + 1 };
  } },
  { name: "owner without process start", change: body => {
    const owner = { pid: process.pid }; body.ownerProcess = owner; physicalObject(body, "execution").owner = owner;
  } },
  { name: "owner without process identity", change: body => {
    const owner = { pid: 0, started: "fixture-start" }; body.ownerProcess = owner; physicalObject(body, "execution").owner = owner;
  } },
  { name: "claimed provider evidence", change: body => { physicalObject(body, "execution").provider = body.ownerProcess!; } },
  { name: "claimed providerProcess", change: body => { body.providerProcess = body.ownerProcess!; } },
  { name: "authorized without provider", change: body => { physicalObject(body, "execution").phase = "authorized"; } },
  { name: "authorized without providerProcess", change: body => { authorizedBody(body); delete body.providerProcess; } },
  { name: "authorized mismatched providerProcess", change: body => {
    authorizedBody(body); body.providerProcess = { ...physicalObject(body, "ownerProcess"), pid: process.pid + 1 };
  } },
  { name: "authorized provider without started", change: body => { delete physicalObject(authorizedBody(body), "provider").started; } },
  { name: "authorized provider without group", change: body => { delete physicalObject(authorizedBody(body), "provider").group; } },
  { name: "authorized provider with foreign group", change: body => {
    physicalObject(authorizedBody(body), "provider").group = process.pid + 1;
  } },
  { name: "running recovery marker", change: body => { body.recovery = null; } },
];

test("E6 physical execution reader: malformed arguments preserve a typed refusal", () => {
  for (const value of [undefined, null, [], new Date(0), "call", 0, true]) {
    assert.throws(() => executionOf(value as unknown as ModelCall),
      error => error instanceof EngineError && error.code === "model_call_execution_invalid");
  }
});

for (const mode of ["analysis", "ordinary"] as const) {
  test(`E6 ${mode}: only a complete unreceived claim justifies unknown expense`, async t => {
    const f = mode === "analysis" ? physicalFixture(t) : ordinarySpendFixture(t);
    const initial = await retainedPhysicalClaim(f.store, () => mode === "analysis"
      ? runModelTransport(f.store, f.request as ModelTransportRequest)
      : runModelCall(f.store, f.request as ModelCallRequest));
    if ("sent" in f) assert.equal(f.sent().length, 0);
    const baseline = deliveredOf(spendReport(f.store, { project: f.project }));
    assert.deepEqual(baseline.findings.map(row => row.code), ["call_not_settled"]);
    assert.deepEqual(baseline.rows[0]!.physical, reference(initial));
    assert.equal(baseline.rows[0]!.usage, null);
    assert.equal(baseline.rows[0]!.settlement, "open");
    assert.deepEqual(baseline.totals, { calls: 1, measuredCalls: 0, unmeasuredCalls: 1, reportedTokens: null });
    const firstRestart = new ExactOnlyStore(f.database);
    try { assert.deepEqual(deliveredOf(readSpendReport(firstRestart, baseline.snapshot)), baseline); }
    finally { firstRestart.close(); }

    const producer = mode === "analysis" ? "transport" : "om";
    const facts = mode === "analysis" ? ["exchange"] : ["exchange", "part", "input", "diagnostic", "failure", "rejection"];
    const cases = [...unreceivedPhysicalCases, ...facts.flatMap(field => [
      { name: `missing ${producer}.${field}`, change: (body: PhysicalBody) => { delete physicalObject(body, producer)[field]; } },
      { name: `running ${producer}.${field}`, change: (body: PhysicalBody) => { physicalObject(body, producer)[field] = { ...reference(initial) }; } },
    ]), ...(mode === "ordinary" ? [
      { name: "running om.completion null", change: (body: PhysicalBody) => { physicalObject(body, "om").completion = null; } },
      { name: "running om.completion reference", change: (body: PhysicalBody) => { physicalObject(body, "om").completion = { ...reference(initial) }; } },
    ] : [])];
    for (const invalid of cases) await t.test(invalid.name, () => {
      const body = structuredClone(initial.value) as unknown as PhysicalBody;
      invalid.change(body);
      const changed = f.store.write({ id: initial.id, kind: initial.kind, expected: f.store.get(initial.id)!.revision, value: body });
      const snapshot = { ...baseline.snapshot, calls: [reference(changed)] } as SpendSnapshot;
      const reopened = new Store(f.database), historical = new ExactOnlyStore(f.database);
      try {
        const before = canonical(reopened.list().flatMap(record => reopened.history(record.id)));
        const physical = mode === "analysis"
          ? readModelTransport(historical, { project: f.project, record: reference(changed) })
          : readModelCallPhysical(historical, { project: f.project, record: reference(changed) });
        for (const refusal of [spendRefused(physical, "model_call_record_invalid"),
          spendRefused(spendReport(reopened, { project: f.project }), "model_call_record_invalid"),
          spendRefused(readSpendReport(historical, snapshot), "model_call_record_invalid")]) {
          assert.equal(refusal.at.target, initial.id);
          assert.ok(refusal.at.field);
        }
        assert.deepEqual(deliveredOf(readSpendReport(historical, baseline.snapshot)), baseline,
          "The original exact claim remains an unknown, valid historical outcome");
        assert.equal(canonical(reopened.list().flatMap(record => reopened.history(record.id))), before,
          "Refused reads neither retry the provider nor settle a fabricated expense");
      } finally { reopened.close(); historical.close(); }
      if ("sent" in f) assert.equal(f.sent().length, 0);
    });
  });
}

for (const purpose of ["stop-analysis", "origin-analysis"] as const) {
  test(`E6 report: real ${purpose} transport records measured expense without asserting acceptance`, async t => {
    const f = physicalFixture(t, purpose);
    const sent = deliveredOf(await runModelTransport(f.store, f.request));
    const before = canonical(f.store.list()), report = deliveredOf(spendReport(f.store, { project: f.project }));
    assert.equal(report.rows.length, 1);
    const row = report.rows[0]!;
    assert.equal(row.purpose, purpose);
    assert.deepEqual(row.physical, reference(sent.record));
    assert.deepEqual(row.usage, actualUsage);
    assert.equal(row.settlement, "succeeded");
    assert.equal(row.result, null, "Analysis response is not the completed product attempt's accepted result");
    assert.deepEqual(report.byPurpose[purpose], { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: actualUsage });
    assert.deepEqual(report.findings, []);
    assert.equal(canonical(f.store.list()), before);
    assert.equal(f.sent().length, 1);
    f.restart();
    const history = new ExactOnlyStore(f.database);
    try { assert.deepEqual(deliveredOf(readSpendReport(history, report.snapshot as SpendSnapshot)), report); }
    finally { history.close(); }
    assert.equal(f.sent().length, 1);
  });
}

test("E6 report: a completed physical response with unknown usage remains open and the reader does not settle it", async t => {
  const f = physicalFixture(t);
  f.scenarioUsage(null);
  deliveredOf(await runModelTransport(f.store, f.request));
  const before = canonical(f.store.list()), report = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.equal(report.rows[0]!.settlement, "open");
  assert.equal(report.rows[0]!.usage, null);
  assert.deepEqual(report.findings.map(item => item.code), ["call_not_settled"]);
  assert.equal(report.totals.unmeasuredCalls, 1);
  assert.equal(report.totals.measuredCalls, 0);
  assert.equal(canonical(f.store.list()), before);
  assert.equal(f.sent().length, 1);
});

test("E6 report: an OM physical call with its E1 record absent is visible as call_without_record", async t => {
  const f = physicalFixture(t);
  const sent = deliveredOf(await runModelTransport(f.store, f.request));
  class LostE1Store extends Store {
    override get<T = Json>(id: string, revision?: number): Revision<T> | null {
      return id.startsWith(`call-record:${f.project}:`) || id === callLedgerId(f.project) ? null : super.get<T>(id, revision);
    }
    override list<T = Json>(kind?: string): Revision<T>[] {
      return super.list<T>(kind).filter(record => record.kind !== CALL_RECORD_KIND && record.kind !== CALL_LEDGER_KIND);
    }
  }
  const lost = new LostE1Store(f.database);
  try {
    const report = deliveredOf(spendReport(lost, { project: f.project }));
    assert.equal(report.rows.length, 1);
    assert.deepEqual(report.rows[0]!.physical, reference(sent.record));
    assert.equal(report.rows[0]!.call, null);
    assert.equal(report.rows[0]!.settlement, "missing");
    assert.deepEqual(report.findings.map(item => item.code), ["call_without_record"]);
    assert.ok(report.findings[0]!.at.target);
  } finally { lost.close(); }
});

interface PhysicalCheckpoint { pid: number; writes: Write[] }
function driver(t: test.TestContext, f: ReturnType<typeof physicalFixture>, checkpoint: string) {
  const spec = join(f.root, "driver.json"), output = join(f.root, "driver-output.json");
  writeFileSync(spec, JSON.stringify({ database: f.database, output, operation: "transport", request: f.request,
    checkpoint: { path: checkpoint, kind: "om-model-exchange", matches: [], when: "before" } }));
  const child = spawn(process.execPath, [providerPath, "--driver", spec], { cwd: f.root, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", value => { stderr += value.toString(); });
  const exit = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; });
  return { child, exit, errors: () => stderr };
}

async function physicalCheckpoint(path: string, child: ChildProcess): Promise<PhysicalCheckpoint> {
  if (!existsSync(path)) await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(deadline); watcher.close(); child.off("exit", ended); };
    const ended = () => { stop(); reject(new Error(`Fixture ended before checkpoint ${path}`)); };
    const watcher = watch(dirname(path), () => { if (existsSync(path)) { stop(); resolve(); } });
    const deadline = setTimeout(() => { stop(); reject(new Error(`Fixture did not reach checkpoint ${path}`)); }, 20_000);
    child.once("exit", ended);
    if (existsSync(path)) { stop(); resolve(); }
  });
  return JSON.parse(readFileSync(path, "utf8")) as PhysicalCheckpoint;
}

test("E6 report: a late receipt keeps measured expense when the recovered model-call retains usage null", async t => {
  const f = physicalFixture(t), checkpoint = join(f.root, "received-before-save.json"), owner = driver(t, f, checkpoint);
  const pending = await physicalCheckpoint(checkpoint, owner.child);
  assert.equal(pending.pid, owner.child.pid);
  assert.equal(f.sent().length, 1);
  const exchange = pending.writes.find(write => write.kind === "om-model-exchange")!.value as { process: ProcessResult; launchError: null };
  const evidence = { process: exchange.process, launchError: exchange.launchError };
  assert.deepEqual(JSON.parse(evidence.process.stdout).usage, actualUsage);
  const dispatch = f.store.list<ModelCall>("model-call")[0]!;
  assert.equal(owner.child.kill("SIGKILL"), true);
  await owner.exit;
  const recovered = new ProductEngine(f.store).execute({ type: "recover-model-call", project: f.project, call: reference(dispatch) }) as Revision<ModelCall>;
  assert.equal(recovered.value.usage, null);
  const late = prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence);
  deliveredOf(writeGuarded(f.store, { unit: "E4", target: dispatch.id, writes: late.writes, guards: late.guards }));
  deliveredOf(await runModelTransport(f.store, f.request));
  const before = canonical(f.store.list()), report = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.deepEqual(report.rows[0]!.usage, actualUsage);
  assert.equal(report.rows[0]!.settlement, "failed");
  assert.deepEqual(report.totals.reportedTokens, actualUsage);
  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.unmeasuredCalls, 0);
  assert.deepEqual(report.findings, []);
  assert.ok(report.snapshot.late.some(item => item.receipt?.id === late.record.id));
  assert.equal(canonical(f.store.list()), before);
  assert.deepEqual(f.store.get(recovered.id), recovered);
  f.restart();
  const history = new ExactOnlyStore(f.database);
  try { assert.deepEqual(deliveredOf(readSpendReport(history, report.snapshot as SpendSnapshot)), report); }
  finally { history.close(); }
  assert.equal(f.sent().length, 1);
  assert.deepEqual(deliveredOf(spendReport(f.store, { project: f.project })), report);
  await assertE6R2RecoveredEvidence(t, f, dispatch, recovered, late);
});

test("E6 report: physical recovery retains a complete terminal time in both current and exact history", async t => {
  const f = physicalFixture(t), checkpoint = join(f.root, "recovery-time.json"), owner = driver(t, f, checkpoint);
  await physicalCheckpoint(checkpoint, owner.child);
  const dispatch = f.store.list<ModelCall>("model-call")[0]!;
  assert.equal(owner.child.kill("SIGKILL"), true);
  await owner.exit;
  const recovered = new ProductEngine(f.store).execute({
    type: "recover-model-call", project: f.project, call: reference(dispatch),
  }) as Revision<ModelCall>;
  const baseline = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.equal(baseline.rows[0]!.usage, null);
  assert.deepEqual(baseline.findings.map(row => row.code), ["call_not_settled"]);
  assert.deepEqual(baseline.snapshot.late, [{ call: reference(recovered), receipt: null }]);
  assert.equal(f.sent().length, 1);

  // Preserve the exact recovery transition and alter only its terminal field.
  // Appending a revision would instead exercise the shared predecessor check.
  function replaceTerminal(value: PhysicalBody): Ref {
    const raw = new DatabaseSync(f.database);
    try {
      raw.exec("BEGIN");
      raw.exec("DROP TRIGGER revisions_no_update");
      raw.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?")
        .run(canonical(value), hashJson(value), recovered.id, recovered.revision);
      raw.exec("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END");
      raw.exec("COMMIT");
    } finally { raw.close(); }
    return { id: recovered.id, revision: recovered.revision, hash: hashJson(value) };
  }
  const cases: InvalidPhysicalCase[] = [
    { name: "missing finishedAt", change: body => { delete body.finishedAt; } },
    { name: "string finishedAt", change: body => { body.finishedAt = "finished"; } },
    { name: "finishedAt before dispatch", change: body => { body.finishedAt = (body.startedAt as number) - 1; } },
    { name: "null finishedAt", change: body => { body.finishedAt = null; } },
  ];
  try {
    for (const invalid of cases) await t.test(invalid.name, () => {
      const value = structuredClone(recovered.value) as unknown as PhysicalBody;
      invalid.change(value);
      const physical = replaceTerminal(value);
      const snapshot = { ...baseline.snapshot, calls: [physical], late: [{ call: physical, receipt: null }] } as SpendSnapshot;
      const current = new Store(f.database), history = new ExactOnlyStore(f.database);
      try {
        const readers = [() => readModelTransport(history, { project: f.project, record: physical }),
          () => spendReport(current, { project: f.project }), () => readSpendReport(history, snapshot)];
        for (const read of readers) {
          if (value.finishedAt === null) assert.throws(read,
            error => error instanceof EngineError && error.code === "model_call_recovery_invalid");
          else {
            const refusal = spendRefused(read(), "model_call_record_invalid");
            assert.equal(refusal.at.target, recovered.id);
            assert.equal(refusal.at.field, "finishedAt");
          }
        }
        assert.equal(current.get(recovered.id)!.hash, physical.hash);
        assert.equal(f.sent().length, 1);
      } finally { current.close(); history.close(); }
    });
  } finally { replaceTerminal(recovered.value as unknown as PhysicalBody); }
  const reopened = new ExactOnlyStore(f.database);
  try { assert.deepEqual(deliveredOf(readSpendReport(reopened, baseline.snapshot)), baseline); }
  finally { reopened.close(); }
});

test("E6 report: a real D7 package counts one obligation shared by two accepted consumers once", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-spend-d7-")), database = join(root, "state.sqlite");
  const store = new Store(database), engine = new ProductEngine(store), project = "garden";
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "README.md"), "Deterministic native garden fixture for the expense report.\n");
  const desired = gardenGraph(), consumer = "garden-later-operation";
  desired.nodes.find(node => node.id === consumer)!.parent = "garden-produce-block";
  desired.edges!.push({ id: "late-consumer-realizes-later", relation: "realizes", source: consumer,
    target: "garden-later-block", condition: "One operation serves both retained consumers" });
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "late-proof",
      question: "Which result proof does the shared operation supply?", consumer, moment: "task-result",
      blocksCurrentStage: false, resolution: "Address the retained result proof during OM" }];
    return value;
  });
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "assignment-researcher", model: "fixture", effort: "high", command },
    reviewer: { actor: "assignment-reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 10_000 }, 0);
  const r0 = engine.refinement.begin(project, "R0");
  engine.refinement.finishResearch(project, "R0", reference(r0), 0);
  engine.refinement.sealLayer(project, 1, 0);
  const r1 = engine.refinement.begin(project, "R1");
  answerTechnicalFixture(engine, project, r1);
  engine.refinement.finishResearch(project, "R1", reference(store.get(r1.id)!), 0);
  const design = engine.refinement.prepareLayer(project, 2);
  const answered = answerLayerFixture(engine, project, design, 2, desired);
  engine.refinement.buildLayer(project, 2, reference(answered), store.get(`graph:${project}`)!.revision, "assignment-researcher");
  engine.refinement.sealLayer(project, 2, 0);
  const graph = store.get<Graph>(`graph:${project}`)!, layer = store.get(`graph-layer:${project}:2`)!;
  const first = deliveredOf(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const input = deliveredOf(writeAddressing(store, { project, input: reference(first), graph: reference(graph), decisions: [{
    pending: inputDecisionWrite({ project, input: reference(first), graph: reference(graph), layers: [reference(layer)],
      decision: { target: "discovery:late-proof", field: "address", value: { consumer, kind: "post-implementation-proof" } } }) as Write,
  }] }));
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph),
    refinement: reference(store.get(`phase:${project}:L2`)!), available: {},
    choice: { choiceVersion: "spend-d7", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: reference(layer), frame: null, upper: null } },
    works: { proposals: [], frame: { project, level: 3, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: null } } } };
  const gaps = deliveredOf(writeGaps(store, sources));
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const gap = gaps.records.find(record => record.value.gap.target === "discovery:late-proof")!;
  assert.ok(gap);
  assert.deepEqual(gap.value.gap.consumers, ["garden-later-block", "garden-produce-block"]);
  const lines = deliveredOf(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const assignment = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project,
    context: { gaps: gapRead, lines: reference(lines) }, gap: reference(gap),
    assignments: gap.value.gap.consumers.map(block => ({ responsibleNode: block, responsibleConsumer: block,
      reason: `Retain the result condition for ${block}`, returnCondition: `Verify the result proof for ${block}`, wake: null })) });
  const obligations = deliveredOf(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [{
    pending: { id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment },
  }] }));
  assert.equal(obligations.handoff.obligations.length, 2);
  assert.equal(new Set(obligations.handoff.obligations.map(item => item.obligation)).size, 1);
  const block = "garden-produce-block", address = { project, block, line: 1 };
  const goal = { key: "shared-result-proof", questions: [gap.value.gap.target], result: "An assigned proof for both consumers" };
  deliveredOf(openSeries(store, { ...address, slice: "spend-d7", predecessor: null, basis: null }));
  const series = deliveredOf(beginAttempt(store, { ...address, attempt: 1, goal }));
  const adapter = store.write({ id: `adapter:${project}:spend`, kind: "dispatch-adapter", expected: 0, value: { protocol: "codex-stdio" } });
  const questions = gap.value.gap.consumers.map(block => ({ id: gap.value.gap.target, goal: gap.value.gap.target,
    field: gap.value.gap.field, consumer: block }));
  const admitted = deliveredOf(recordCall(store, project, { call: "shared-proof-package", purpose: "model-design", basis: null,
    block, gaps: questions, series: reference(series), attempt: 1, goal,
    dispatch: { adapter: reference(adapter), config: reference(environment) },
    packet: { question: gap.value.gap.target, consumers: gap.value.gap.consumers, obligations: { ...reference(obligations.record) } } }));
  const paid = deliveredOf(settleCall(store, reference(admitted.call), actualUsage, "succeeded"));
  const report = deliveredOf(spendReport(store, { project,
    significance: [{ call: reference(paid.call), gaps: gapRead, obligations: reference(obligations.record) }] }));
  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.rows[0]!.questions, paid.call.value.gaps);
  assert.equal(report.rows[0]!.questions.length, 2);
  assert.equal(report.rows[0]!.significance.obligations, 1);
  assert.equal(report.rows[0]!.significance.consumers, 2);
  assert.equal(report.rows[0]!.significance.blocks, 2);
  assert.ok(report.rows[0]!.significance.sources.some(ref => canonical(ref) === canonical(reference(obligations.record))));
  assert.ok(report.rows[0]!.significance.sources.some(ref => canonical(ref) === canonical(reference(obligations.producer))));
  assert.deepEqual(report.totals, { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: actualUsage });
  const reversed = deliveredOf(spendReport(store, { project, significance: [{ call: reference(paid.call),
    gaps: { ...gapRead, records: [...gapRead.records].reverse() }, obligations: reference(obligations.record) }] }));
  assert.deepEqual(reversed.rows, report.rows, "Source-set ordering cannot change proven D7 significance");
  const frameGap = gaps.records.find(record => record.value.gap.code === "obligation_open" && record.value.gap.consumers.length > 0)!;
  assert.ok(frameGap, "The same real D1 set includes unresolved work-frame obligations");
  const frameQuestions = frameGap.value.gap.consumers.map(consumer => ({ id: frameGap.value.gap.target,
    goal: frameGap.value.gap.target, field: frameGap.value.gap.field, consumer }));
  const extraCalls = [
    { call: "frame-with-unrelated-d7", gaps: frameQuestions, count: 1 },
    { call: "frame-union-d7", gaps: [...frameQuestions, ...questions], count: 2 },
  ].map(item => {
    const recorded = deliveredOf(recordCall(store, project, { call: item.call, purpose: "model-design", basis: null,
      block, gaps: item.gaps, series: reference(series), attempt: 1, goal,
      dispatch: { adapter: reference(adapter), config: reference(environment) }, packet: { questions: item.gaps } }));
    return { ...item, call: reference(deliveredOf(settleCall(store, reference(recorded.call), zeroUsage, "succeeded")).call) };
  });
  const combined = deliveredOf(spendReport(store, { project,
    significance: [reference(paid.call), ...extraCalls.map(item => item.call)].map(call => ({ call, gaps: gapRead, obligations: reference(obligations.record) })) }));
  for (const extra of extraCalls) assert.equal(combined.rows.find(row => row.call?.id === extra.call.id)!.significance.obligations, extra.count,
    "An empty selected D7 subset cannot erase a frame obligation, and two consumer bindings add only one D7 obligation");
  assert.deepEqual(combined.totals.reportedTokens, actualUsage, "Three packages retain three expenses, including two explicit zeros");
  store.close();
  const reopened = new ExactOnlyStore(database);
  try {
    assert.deepEqual(deliveredOf(readSpendReport(reopened, report.snapshot)), report);
    assert.deepEqual(deliveredOf(readSpendReport(reopened, combined.snapshot)), combined);
  }
  finally { reopened.close(); }
});

test("E6 report: a native accepted answer contributes only its provider-confirmed result after completion and restart", async t => {
  const f = mechanismOriginFixture(t), engine = new ProductEngine(f.store), project = PROJECT;
  const root = dirname(f.path), block = `${project}-consume-block`, target = "discovery:encoding";
  const graph = f.gapScope.sources.graph;
  const input = deliveredOf(writeAddressing(f.store, { project, input: f.gapScope.sources.input, graph, decisions: [{
    pending: inputDecisionWrite({ project, input: f.gapScope.sources.input, graph, layers: [],
      decision: { target, field: "address", value: { consumer: block, kind: "repository-fact" } } }) as Write,
  }] }));
  const horizon = deliveredOf(writeHorizon(f.store, { project, input: reference(input), graph, refinement: null, available: {},
    choice: { choiceVersion: "spend-accepted-answer", features: [{ outcome: `${project}-result` }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph, horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = deliveredOf(writeGaps(f.store, sources)), gap = gaps.records.find(record => record.value.gap.target === target)!;
  assert.equal(gap.value.gap.kind, "repository-fact");
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const command = { executable: process.execPath, args: ["-e",
    "const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));"] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "fact-researcher", model: "fixture", effort: "high", command },
    reviewer: { actor: "fact-assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000 }, 0);
  writeFileSync(join(root, "answer.json"), JSON.stringify({ answer: "UTF-8" }));
  const source = engine.discovery.evidence.file(project, "encoding-answer", root, "answer.json", "application/json", 0);
  const address = { project, block, line: 1 }, goal = { key: "encoding-fact", questions: [gapLineKey(project, target, "answer")],
    result: gapLineExpectedResult(project, target, "answer") };
  deliveredOf(openSeries(f.store, { ...address, slice: "spend-accepted-answer", predecessor: null, basis: null }));
  const attempt = deliveredOf(beginAttempt(f.store, { ...address, attempt: 1, goal }));
  const contract: AnswerQuestionContract = { establishes: input.value.input.questions[0]!.question,
    consumer: { blocks: [...gap.value.gap.consumers] }, requirements: [structuredClone(input.value.input.contracts[0]!) as unknown as Json], resultForm: { type: "string" } };
  const draft = engine.discovery.create(project, "om-g2", "R1", block,
    [mc1FieldSpec({ input: reference(input), gap: reference(gap), contract })], [reference(input), reference(gap)]);
  const issued = f.store.get<Question>(draft.value.questions[0]!)!;
  const question = deliveredOf(writeMc1Question(f.store, { project, input: reference(input), gaps: gapRead,
    gap: reference(gap), contract, requirements: [{ pointer: "/contracts/0" }], engineQuestion: reference(issued), draft: reference(draft) }));
  const admitted = deliveredOf(recordCall(f.store, project, { call: "accepted-encoding", purpose: "model-research", basis: null,
    block, gaps: [{ id: target, goal: target, field: "answer", consumer: block }], series: reference(attempt), attempt: 1, goal,
    dispatch: { adapter: f.adapter, config: reference(environment) }, packet: { question: { ...reference(question) } } }));
  const assessed = await assessAnswer(f.store, issued, { action: "answer", question: issued.id, value: "UTF-8",
    citations: [{ source: reference(source), selector: { kind: "json-pointer", pointer: "/answer" } }] }, environment, root);
  const answeredDraft = engine.discovery.researched(issued.id, issued.revision, reference(assessed)), answered = f.store.get<Question>(issued.id)!;
  const accepted = deliveredOf(writeAcceptedAnswer(f.store, { project, question: reference(question), answer: answered.value.answer!,
    answeredQuestion: reference(answered), draft: reference(answeredDraft), attempt: { series: reference(attempt), attempt: 1 } }));
  const confirmed = deliveredOf(confirmResults(f.store, { project, block, target: attempt.id, goal,
    accepting: [reference(accepted)], cancelling: [] }));
  assert.equal(confirmed.achieved.length, 1);
  deliveredOf(closeAttempt(f.store, { ...address, attempt: 1,
    outcome: { reason: "result", accepting: [reference(accepted)], cancelling: [], refusals: [] } }));
  deliveredOf(settleCall(f.store, reference(admitted.call), actualUsage, "succeeded"));
  const completed = f.store.get(attempt.id)!;
  const report = deliveredOf(spendReport(f.store, { project,
    histories: [{ call: reference(f.settled.call), journal: f.journal }] }));
  const row = report.rows.find(item => item.call?.id === admitted.call.id)!;
  assert.deepEqual(row.result, { series: reference(completed), attempt: 1, verdict: "progress", achieved: confirmed.achieved });
  assert.equal(report.rows.length, 2, "Native assessment transport is outside OM/E1 expense scope");
  assert.equal(report.snapshot.calls.length, 0, "Native assessment is not an OM physical model-call");
  assert.ok(f.store.list<ModelCall>("model-call").some(record => !record.id.startsWith(`model-call:${project}:om:`)), "The result was assessed through the real native call producer");
  f.store.close();
  const reopened = new ExactOnlyStore(f.path);
  try { assert.deepEqual(deliveredOf(readSpendReport(reopened, report.snapshot)), report); }
  finally { reopened.close(); }
});

test("E6 reads unchanged E1 bytes from the complete 0da9006 producer after restart", t => {
  const base = "0da900606c30ac03699053e2bfa45844b769e371";
  const root = mkdtempSync(join(tmpdir(), "omg-e6-base-producer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const run = (executable: string, args: string[], cwd: string, timeout = 60_000): string => {
    const child = spawnSync(executable, args, {
      cwd, env: environment, encoding: "utf8", timeout, maxBuffer: 20_000_000,
    });
    assert.equal(child.error, undefined, `${executable}: ${child.error?.message ?? ""}`);
    assert.equal(child.status, 0, `${executable} ${args.join(" ")}\n${child.stdout}\n${child.stderr}`);
    return child.stdout;
  };
  const repository = run("git", ["rev-parse", "--show-toplevel"], dirname(fileURLToPath(import.meta.url))).trim();
  const legacy = join(root, "base"), archive = join(root, "base.tar");
  mkdirSync(legacy);
  run("git", ["archive", "--format=tar", "--output", archive, base], repository);
  run("tar", ["-xf", archive, "-C", legacy], root);
  symlinkSync(join(repository, "node_modules"), join(legacy, "node_modules"), "dir");
  // The whole commit is archived. Compile its complete source graph independently,
  // without importing today's dist, fixtures, changed E1 reader or E6 producer.
  writeFileSync(join(legacy, "tsconfig.e6-history.json"), JSON.stringify({
    extends: "./tsconfig.json", include: ["src/**/*.ts"], exclude: [],
  }));
  run(process.execPath, [join(legacy, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.e6-history.json"], legacy);
  const database = join(root, "old-e1.sqlite"), expectedFile = join(root, "old-e1.json");
  const producer = join(legacy, "e6-old-producer.mjs");
  writeFileSync(producer, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from './dist/src/canonical.js';
import { reference } from './dist/src/pipeline/contracts.js';
import { Store } from './dist/src/storage/store.js';
import { openSeries, beginAttempt } from './dist/src/om/series.js';
import { recordCall, settleCall } from './dist/src/om/call-record.js';
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const database = process.argv[2], output = process.argv[3], project = 'history-e6', block = 'history-block';
const store = new Store(database);
let expected;
try {
  const adapter = reference(store.write({ id: 'adapter:' + project, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio', status: 'configured-not-accepted' } }));
  const config = reference(store.write({ id: 'config:' + project, kind: 'dispatch-config', expected: 0,
    value: { projectId: project, model: 'never-invoked', transport: 'stdio', status: 'configured-not-accepted' } }));
  ok(openSeries(store, { project, block, line: 1, slice: 'history-slice', predecessor: null, basis: null }));
  const goal = { key: 'history-question', questions: ['Which contract supplies this result?'], result: 'An accepted contract' };
  const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
  const request = call => ({ call, purpose: 'model-research', basis: null, block,
    gaps: [{ id: 'history-gap', goal: 'history-contract', field: 'contract', consumer: block }],
    series: reference(series), attempt: 1, goal, dispatch: { adapter, config },
    packet: { question: 'Which contract supplies this result?', neighbors: ['history-neighbor'] } });
  const paid = ok(recordCall(store, project, request('old-paid')));
  const usage = { inputTokens: 41, outputTokens: 13, cachedInputTokens: 5, reasoningOutputTokens: 3 };
  const settled = ok(settleCall(store, reference(paid.call), usage, 'succeeded'));
  assert.equal(settled.settled, true);
  const unknown = ok(recordCall(store, project, request('old-unknown')));
  const unsettled = ok(settleCall(store, reference(unknown.call), null, 'failed'));
  assert.equal(unsettled.settled, false);
  assert.deepEqual(unsettled.ledger, unknown.ledger);
  const ledgers = [paid.ledger, settled.ledger, unknown.ledger];
  const calls = [paid.call, settled.call, unknown.call];
  assert.deepEqual(ledgers.map(row => row.revision), [1, 2, 3]);
  assert.deepEqual(calls.map(row => row.revision), [1, 2, 1]);
  expected = { project, database, usage, ledgers, calls, series: reference(series),
    hashes: { ledgers: ledgers.map(reference), calls: calls.map(reference) },
    historyBytes: canonical(store.list().flatMap(row => store.history(row.id))) };
} finally { store.close(); }
const raw = new DatabaseSync(database, { readOnly: true });
try {
  expected.storageBytes = JSON.stringify({
    revisions: raw.prepare('SELECT entity_id, revision, kind, body, sha256 FROM revisions ORDER BY entity_id, revision').all(),
    heads: raw.prepare('SELECT entity_id, revision FROM heads ORDER BY entity_id').all(),
    events: raw.prepare('SELECT * FROM events ORDER BY rowid').all(),
  });
} finally { raw.close(); }
writeFileSync(output, JSON.stringify(expected));
`);
  run(process.execPath, [producer, database, expectedFile], legacy);
  const old = JSON.parse(readFileSync(expectedFile, "utf8")) as {
    project: string; database: string; usage: { inputTokens: number; outputTokens: number;
      cachedInputTokens: number; reasoningOutputTokens: number };
    ledgers: Revision<CallLedger>[]; calls: Revision[]; series: Ref;
    hashes: { ledgers: Ref[]; calls: Ref[] }; historyBytes: string; storageBytes: string;
  };
  const storageBytes = (): string => {
    const raw = new DatabaseSync(old.database, { readOnly: true });
    try {
      return JSON.stringify({
        revisions: raw.prepare("SELECT entity_id, revision, kind, body, sha256 FROM revisions ORDER BY entity_id, revision").all(),
        heads: raw.prepare("SELECT entity_id, revision FROM heads ORDER BY entity_id").all(),
        events: raw.prepare("SELECT * FROM events ORDER BY rowid").all(),
      });
    } finally { raw.close(); }
  };
  assert.equal(storageBytes(), old.storageBytes);
  const current = new Store(old.database);
  let report: ReturnType<typeof spendReport>;
  try {
    assert.equal(canonical(current.list().flatMap(row => current.history(row.id))), old.historyBytes);
    for (const [index, ledger] of old.ledgers.entries()) {
      const loaded = deliveredOf(readCallLedgerAt(current, old.project, old.hashes.ledgers[index]!));
      assert.deepEqual(loaded, ledger);
      assert.deepEqual(reference(loaded), old.hashes.ledgers[index]);
    }
    for (const [index, call] of old.calls.entries()) {
      const loaded = current.get(call.id, call.revision)!;
      assert.deepEqual(loaded, call);
      assert.deepEqual(reference(loaded), old.hashes.calls[index]);
    }
    report = spendReport(current, { project: old.project });
    const value = deliveredOf(report);
    assert.deepEqual(value.snapshot.ledger, old.hashes.ledgers[2]);
    assert.deepEqual(value.snapshot.series, [old.series]);
    assert.deepEqual(value.snapshot.calls, [], "Direct E1 does not invent a physical model call");
    assert.equal(value.rows.length, 2);
    assert.deepEqual(value.totals, { calls: 2, measuredCalls: 1, unmeasuredCalls: 1, reportedTokens: old.usage });
    assert.deepEqual(value.findings.map(row => row.code), ["call_not_settled"]);
    for (const row of value.rows) {
      assert.deepEqual(row.significance, { obligations: null, consumers: null, blocks: null, sources: [] });
      assert.equal(row.result, null, "An unfinished attempt has no accepted result");
    }
    assert.equal(canonical(current.list().flatMap(row => current.history(row.id))), old.historyBytes);
  } finally { current.close(); }
  assert.equal(storageBytes(), old.storageBytes, "Current E6 leaves all old bodies, hashes, heads and events unchanged");
  const saved = deliveredOf(report!);
  // A fresh exact-only connection rejects accidental use of today's heads or census.
  const restarted = new ExactOnlyStore(old.database);
  try {
    for (const [index, ledger] of old.ledgers.entries())
      assert.deepEqual(deliveredOf(readCallLedgerAt(restarted, old.project, old.hashes.ledgers[index]!)), ledger);
    assert.deepEqual(deliveredOf(readSpendReport(restarted, saved.snapshot)), saved);
    const beforeLaterAdmission = deliveredOf(readSpendReport(restarted, {
      ...saved.snapshot, ledger: old.hashes.ledgers[1]!,
    }));
    assert.equal(beforeLaterAdmission.rows.length, 1);
    assert.deepEqual(beforeLaterAdmission.rows[0]!.call, old.hashes.calls[1]);
    assert.deepEqual(beforeLaterAdmission.findings, []);
    assert.deepEqual(beforeLaterAdmission.totals,
      { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: old.usage });
  } finally { restarted.close(); }
  assert.equal(storageBytes(), old.storageBytes, "Historical E6 creates no new E1 revisions or migrations of their bytes");
});

/** Real ordinary E4/E2 fact assignment, using the same source construction as om-model-call.test.ts. */
function ordinarySpendFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-spend-ordinary-")), database = join(root, "state.sqlite");
  const store = new Store(database), engine = new ProductEngine(store), project = "garden";
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graphData = gardenGraph("cross");
  graphData.nodes.find(node => node.id === "garden-produce-block")!.ports.push({ id: "out-side", direction: "out", contract: "garden-contract" });
  graphData.nodes.find(node => node.id === "garden-consume-block")!.ports.push({ id: "in-side", direction: "in", contract: "garden-contract" });
  graphData.connectors.push({ id: "garden-side-flow", artifact: "garden-data", returnsTo: "garden-produce-block", wakeTest: null,
    bindings: [{ level: 1, producer: { node: "garden-produce-block", port: "out-side" },
      consumers: [{ node: "garden-consume-block", port: "in-side" }], anchor: null }] });
  const { level: _level, ...l1 } = projectGraph(graphData, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "encoding", question: "What encoding is supported?",
      consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false, resolution: "Resolve the addressed question during OM" }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = deliveredOf(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = deliveredOf(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: "e6-e4-fixture", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = deliveredOf(writeGaps(store, sources));
  const gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = deliveredOf(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing" && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: "/contracts/0" }], resultForm: { type: "string" } })) }));
  const source = store.get<{ content: string }>(`source:${project}:brief`)!;
  const routes = deliveredOf(writeRoutes(store, { project, gaps: gapRequest,
    tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ["e4-source.txt"], records: [] }, previous: null }));
  writeFileSync(join(root, "e4-source.txt"), "UTF-8 is the supported encoding.");
  const batch = routes.value.batches.find(item => item.model === "MC1" && item.items.some(member => member.target === "discovery:encoding"))!;
  assert.ok(batch);
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [providerPath, "--scenario", scenario, "--trace", trace] };
  function environment() {
    return engine.environments.configure(project, { workspace: root,
      implementer: { actor: "e4-implementer", model: "fixture", effort: "high", speed: "fast", command },
      reviewer: { actor: "e4-reviewer", model: "fixture-reviewer", effort: "medium", command },
      fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: 100_000 },
    store.get(`environment:${project}`)?.revision ?? 0);
  }
  const configured = environment(), adapter = store.write({ id: `adapter:${project}:e4`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio" } });
  const goal = { key: "e6-e4:encoding", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const address = { project, block: "garden-consume-block", line: 1 };
  deliveredOf(openSeries(store, { ...address, slice: "e6-e4-fixture", predecessor: null, basis: null }));
  const series = deliveredOf(beginAttempt(store, { ...address, attempt: 1, goal }));
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal: 1 }, previous: [] };
  const packet = deliveredOf(writeQuestionPacket(store, packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: "implementer" };
  return { database, store, project, source, routes, gaps, batch, packet, request, address, goal, series, environment,
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); } };
}

test("E6 ordinary E4: packet significance and exact physical expense survive later application heads", async t => {
  for (const action of ["answer", "cannot_answer"] as const) await t.test(action, async nested => {
    const f = ordinarySpendFixture(nested);
    const research = action === "answer"
      ? { protocol: "omg-answer/v2", requestId: "$requestId", action,
        results: [{ questionId: f.batch.items[0]!.gap, value: "UTF-8",
          citations: [{ source: reference(f.source), selector: { kind: "text-range", start: 0, end: f.source.value.content.length } }] }] }
      : { protocol: "omg-answer/v2", requestId: "$requestId", action,
        questionIds: [f.batch.items[0]!.gap], reason: "The requested fact is unavailable in the named source" };
    f.steps([{ research, usage: actualUsage }]);
    const applied = deliveredOf(await runModelCall(f.store, f.request));
    assert.equal(applied.outcome?.kind, action === "answer" ? "fact-candidates" : "no-result");
    assert.equal(applied.record.value.om.application, "applied");
    assert.equal(applied.diagnostic === null, action === "answer");
    const physicalRef = reference(applied.record);
    const physical = deliveredOf(readModelCallPhysical(f.store, { project: f.project, record: physicalRef }));
    assert.deepEqual(physical.call, applied.call);
    assert.deepEqual(physical.packet, reference(f.packet));
    assert.deepEqual(physical.transport?.usage, actualUsage);
    const saved = deliveredOf(spendReport(f.store, { project: f.project }));
    assert.equal(saved.rows.length, 1);
    assert.deepEqual(saved.rows[0]!.physical, physicalRef);
    assert.equal(saved.rows[0]!.call?.id, applied.call.id);
    assert.equal(saved.rows[0]!.settlement, "succeeded");
    assert.deepEqual(saved.rows[0]!.usage, actualUsage);
    assert.deepEqual(saved.totals, { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: actualUsage });
    assert.deepEqual(saved.findings, []);
    const significance = saved.rows[0]!.significance;
    assert.equal(significance.consumers, 1);
    assert.equal(significance.blocks, 1);
    assert.equal(significance.obligations, null, "A repository-fact packet is not an obligation count");
    assert.ok(significance.sources.some(at => canonical(at) === canonical(reference(f.packet))));
    assert.ok(significance.sources.some(at => canonical(at) === canonical(reference(f.routes))));
    assert.ok(significance.sources.some(at => f.gaps.records.some(gap => canonical(at) === canonical(reference(gap)))));

    if (action === "answer") deliveredOf(completeAttempt(f.store, { ...f.address, attempt: 1,
      outcome: { reason: "result", achieved: [], cancelled: [], refusals: [] } }));
    const next = deliveredOf(beginAttempt(f.store, { ...f.address, attempt: 2, goal: f.goal }));
    assert.ok(next.revision > saved.snapshot.series[0]!.revision);
    assert.ok(f.environment().revision > f.request.dispatch.config.revision);
    const source = f.store.write({ id: `${unitRefusalNamespace(f.project)}e6-later`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: "G3", refusals: [{ code: "graph_invalid:later", goal: f.goal.key, remedy: "Find the later producer",
        origin: { name: "artifact_missing", stage: "layer-check", subject: "artifact:later", sources: [] } }] } });
    deliveredOf(recordRefusal(f.store, { project: f.project, source: reference(source) }));
    const beforeRead = canonical(f.store.list());
    const exact = new ExactOnlyStore(f.database);
    try {
      assert.deepEqual(deliveredOf(readModelCallPhysical(exact, { project: f.project, record: physicalRef })), physical);
      assert.deepEqual(deliveredOf(readSpendReport(exact, saved.snapshot as SpendSnapshot)), saved);
    } finally { exact.close(); }
    assert.equal(canonical(f.store.list()), beforeRead);

    // Loss of a required E2 or transport source must fail; it cannot downgrade known spend/significance to unknown.
    for (const missing of [reference(f.packet), applied.record.value.om.exchange!]) {
      class MissingOrdinarySourceStore extends ExactOnlyStore {
        override get<T = Json>(id: string, revision?: number): Revision<T> | null {
          assert.notEqual(revision, undefined, `historical read consulted head ${id}`);
          return id === missing.id && revision === missing.revision ? null : super.get<T>(id, revision);
        }
      }
      const absent = new MissingOrdinarySourceStore(f.database);
      try {
        spendRefused(readModelCallPhysical(absent, { project: f.project, record: physicalRef }), "record_missing");
        spendRefused(readSpendReport(absent, saved.snapshot as SpendSnapshot), "record_missing");
      } finally { absent.close(); }
    }
  });
});

test("E6 report: recomputed E1 and ledger hashes do not let another block claim a series", t => {
  const f = fixture(t);
  const admitted = deliveredOf(recordCall(f.store, PROJECT, request(f, "wrong-owner")));
  const saved = deliveredOf(spendReport(f.store, { project: PROJECT }));
  const changedCall = { ...admitted.call, value: { ...admitted.call.value, block: "other-block" } };
  changedCall.hash = hashJson(changedCall.value);
  const changedLedger: Revision<CallLedger> = { ...admitted.ledger, value: {
    ...admitted.ledger.value,
    calls: admitted.ledger.value.calls.map(row => {
      if ("owner" in row) assert.fail("The block fixture must retain a block-owned E1 row");
      return { ...row, block: "other-block", call: reference(changedCall) };
    }),
  } };
  changedLedger.hash = hashJson(changedLedger.value);
  f.store.close();
  // Rewrite BOTH producer bodies and their hashes, preserving canonical E1 row
  // derivation. The report must reject the foreign series owner, not just a hash.
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec("BEGIN IMMEDIATE");
    // This disposable integrity fixture deliberately replaces stored bytes.
    raw.exec("DROP TRIGGER revisions_no_update");
    const update = raw.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?");
    for (const record of [changedCall, changedLedger]) {
      const write = update.run(canonical(record.value), record.hash, record.id, record.revision);
      assert.equal(Number(write.changes), 1);
    }
    raw.exec("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END");
    raw.exec("COMMIT");
  } finally { raw.close(); }
  const current = new Store(f.path);
  try {
    const before = canonical(current.list().flatMap(row => current.history(row.id)));
    assert.deepEqual(deliveredOf(readCallLedgerAt(current, PROJECT, reference(changedLedger))), changedLedger);
    const refused = spendRefused(spendReport(current, { project: PROJECT }), "spend_basis_invalid");
    assert.equal(refused.at.target, changedCall.id);
    assert.equal(refused.at.field, "series");
    assert.equal(canonical(current.list().flatMap(row => current.history(row.id))), before);
  } finally { current.close(); }
  const historical = new ExactOnlyStore(f.path);
  try {
    const refused = spendRefused(readSpendReport(historical, {
      ...saved.snapshot, ledger: reference(changedLedger),
    }), "spend_basis_invalid");
    assert.equal(refused.at.target, changedCall.id);
    assert.equal(refused.at.field, "series");
  } finally { historical.close(); }
});

test("E6 report: a real late receipt arriving after the absence read invalidates the current cut", async t => {
  const f = physicalFixture(t), checkpoint = join(f.root, "receipt-race.json"), owner = driver(t, f, checkpoint);
  const pending = await physicalCheckpoint(checkpoint, owner.child);
  assert.equal(pending.pid, owner.child.pid);
  const exchange = pending.writes.find(write => write.kind === "om-model-exchange")!.value as {
    process: ProcessResult; launchError: null;
  };
  const evidence = { process: exchange.process, launchError: exchange.launchError };
  assert.deepEqual(JSON.parse(evidence.process.stdout).usage, actualUsage);
  const dispatch = f.store.list<ModelCall>("model-call")[0]!;
  assert.equal(owner.child.kill("SIGKILL"), true);
  await owner.exit;
  const recovered = new ProductEngine(f.store).execute({
    type: "recover-model-call", project: f.project, call: reference(dispatch),
  }) as Revision<ModelCall>;
  const late = prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence);
  assert.equal(late.writes.length, 1);
  assert.equal(f.store.get(late.record.id), null);
  const beforeReceipt = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.deepEqual(beforeReceipt.snapshot.late, [{ call: reference(recovered), receipt: null }]);
  assert.equal(beforeReceipt.rows[0]!.usage, null);
  const ledgerBefore = f.store.get(callLedgerId(f.project));
  const writer = new Store(f.database);
  class ReceiptArrivesStore extends Store {
    injected = false;
    override get<T = Json>(id: string, revision?: number): Revision<T> | null {
      const read = super.get<T>(id, revision);
      if (!this.injected && revision === undefined && id === late.record.id) {
        assert.equal(read, null);
        this.injected = true;
        // This is the genuine receipt transition on a second connection. It
        // changes neither the ledger nor the recovered physical-call head.
        writer.writeMany(late.writes, late.guards);
      }
      return read;
    }
  }
  const racing = new ReceiptArrivesStore(f.database);
  try {
    const refused = spendRefused(spendReport(racing, { project: f.project }), "input_stale");
    assert.equal(racing.injected, true);
    assert.equal(refused.at.target, callLedgerId(f.project));
    assert.equal(refused.at.field, "sources");
    assert.deepEqual(f.store.get(late.record.id), late.record);
    assert.deepEqual(f.store.get(recovered.id), recovered);
    assert.deepEqual(f.store.get(callLedgerId(f.project)), ledgerBefore);
    const historical = new ExactOnlyStore(f.database);
    try { assert.deepEqual(deliveredOf(readSpendReport(historical, beforeReceipt.snapshot)), beforeReceipt,
      "An explicit historical null receipt cannot load the receipt created after its snapshot"); }
    finally { historical.close(); }
    const beforeRetry = canonical(f.store.list().flatMap(row => f.store.history(row.id)));
    const retried = deliveredOf(spendReport(racing, { project: f.project }));
    assert.equal(retried.rows.length, 1);
    assert.deepEqual(retried.rows[0]!.usage, actualUsage);
    assert.equal(retried.rows[0]!.settlement, "open");
    assert.deepEqual(retried.findings.map(row => row.code), ["call_not_settled"]);
    assert.deepEqual(retried.snapshot.late, [{ call: reference(recovered), receipt: reference(late.record) }]);
    assert.deepEqual(retried.totals, { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: actualUsage });
    assert.equal(canonical(f.store.list().flatMap(row => f.store.history(row.id))), beforeRetry);
    assert.equal(f.sent().length, 1, "The reader neither retries the model nor settles the E1 call");
  } finally { racing.close(); writer.close(); }
});

async function assertE6R2RecoveredEvidence(
  t: test.TestContext,
  f: ReturnType<typeof physicalFixture>,
  dispatch: Revision<ModelCall>,
  recovered: Revision<ModelCall>,
  late: ReturnType<typeof prepareLateModelReceipt>,
): Promise<void> {
  const recoveredRef = reference(recovered), receiptRef = reference(late.record);
  const allBytes = () => canonical(f.store.list().flatMap(row => f.store.history(row.id)));
  const originalBytes = allBytes();
  // Only this disposable integrity fixture is rewritten; each scenario restores
  // the original bodies, hashes and the storage immutability trigger.
  const rewrite = (records: readonly Revision<unknown>[]): void => {
    const raw = new DatabaseSync(f.database);
    try {
      raw.exec("BEGIN IMMEDIATE");
      raw.exec("DROP TRIGGER revisions_no_update");
      const update = raw.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?");
      for (const record of records) {
        assert.equal(hashJson(record.value), record.hash);
        assert.equal(Number(update.run(canonical(record.value), record.hash, record.id, record.revision).changes), 1);
      }
      raw.exec("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END");
      raw.exec("COMMIT");
    } catch (error) { raw.exec("ROLLBACK"); throw error; }
    finally { raw.close(); }
  };
  const hidesE1 = (id: string): boolean => id.startsWith(`call-record:${f.project}:`) || id === callLedgerId(f.project);
  class OrphanStore extends Store {
    hideReceipt = false;
    override get<T = Json>(id: string, revision?: number): Revision<T> | null {
      if (hidesE1(id) || this.hideReceipt && id === receiptRef.id) return null;
      return super.get<T>(id, revision);
    }
    override list<T = Json>(kind?: string): Revision<T>[] {
      return super.list<T>(kind).filter(record => !hidesE1(record.id));
    }
  }
  class ExactOrphanStore extends OrphanStore {
    override get<T = Json>(id: string, revision?: number): Revision<T> | null {
      assert.notEqual(revision, undefined, `historical orphan read consulted head ${id}`);
      return super.get<T>(id, revision);
    }
    override list<T = Json>(_kind?: string): Revision<T>[] {
      assert.fail("Historical orphan reading enumerated current records");
    }
  }
  const orphanSnapshot = (receipt: Ref | null): SpendSnapshot => ({
    project: f.project, ledger: null, calls: [recoveredRef], series: [], histories: [], significance: [],
    late: [{ call: recoveredRef, receipt }],
  });
  const assertOrphan = (report: ReturnType<typeof spendReport>): void => {
    const value = deliveredOf(report);
    assert.equal(value.rows.length, 1);
    assert.deepEqual(value.rows[0]!.physical, recoveredRef);
    assert.equal(value.rows[0]!.call, null);
    assert.equal(value.rows[0]!.settlement, "missing");
    assert.equal(value.rows[0]!.usage, null);
    assert.equal(value.rows[0]!.result, null);
    assert.deepEqual(value.findings.map(row => row.code), ["call_without_record"]);
    assert.deepEqual(value.totals, { calls: 1, measuredCalls: 0, unmeasuredCalls: 1, reportedTokens: null });
  };
  const invalidLate = (error: unknown): boolean => error instanceof EngineError && error.code === "model_call_late_receipt_invalid";

  await t.test("orphan recovery accepts explicit absent and actual late sources without inventing expense", () => {
    for (const missingReceipt of [false, true]) {
      const current = new OrphanStore(f.database);
      current.hideReceipt = missingReceipt;
      try {
        const report = spendReport(current, { project: f.project });
        assertOrphan(report);
        assert.deepEqual(deliveredOf(report).snapshot.late,
          [{ call: recoveredRef, receipt: missingReceipt ? null : receiptRef }]);
      } finally { current.close(); }
    }
    // A fresh exact-only reader must respect null even though a receipt now exists.
    const historical = new ExactOrphanStore(f.database);
    try {
      assertOrphan(readSpendReport(historical, orphanSnapshot(null)));
      assertOrphan(readSpendReport(historical, orphanSnapshot(receiptRef)));
    } finally { historical.close(); }
    assert.equal(allBytes(), originalBytes);
  });

  await t.test("orphan recovery cannot omit its late entry or bypass named receipt integrity", () => {
    const historical = new ExactOrphanStore(f.database);
    try {
      const omitted = spendRefused(readSpendReport(historical, { ...orphanSnapshot(null), late: [] }), "spend_source_invalid");
      assert.equal(omitted.at.target, recovered.id);
      assert.equal(omitted.at.field, "late");
      for (const named of [
        { ...receiptRef, hash: "0".repeat(64) },
        { ...receiptRef, id: `${receiptRef.id}:foreign` },
      ]) assert.throws(() => readSpendReport(historical, orphanSnapshot(named)), invalidLate);
      historical.hideReceipt = true;
      assert.throws(() => readSpendReport(historical, orphanSnapshot(receiptRef)), invalidLate,
        "An explicitly named missing receipt is not the explicit-null historical state");
    } finally { historical.close(); }
    // The current API supplies its own complete late list, so omitted/named-missing
    // input is historical-only. A present malformed producer is refused by BOTH.
    const foreignValue = { ...late.record.value, recovered: { ...recoveredRef, hash: "0".repeat(64) } };
    const foreign = { ...late.record, value: foreignValue, hash: hashJson(foreignValue) };
    rewrite([foreign]);
    try {
      const current = new OrphanStore(f.database), exact = new ExactOrphanStore(f.database);
      try {
        assert.throws(() => spendReport(current, { project: f.project }), invalidLate);
        assert.throws(() => readSpendReport(exact, orphanSnapshot(reference(foreign))), invalidLate);
      } finally { current.close(); exact.close(); }
    } finally { rewrite([late.record]); }
    assert.equal(allBytes(), originalBytes);
  });

  await t.test("recovered analysis validates its original unreceived usage beyond consistent recovery hashes", () => {
    assert.ok(recovered.value.recovery);
    const incident = f.store.get<Record<string, unknown>>(recovered.value.recovery.id, recovered.value.recovery.revision)!;
    assert.ok(incident);
    const originalValue = { ...dispatch.value } as unknown as Record<string, unknown>;
    delete originalValue.usage;
    const forgedOriginal = { ...dispatch, value: originalValue, hash: hashJson(originalValue) };
    // Match the generic recovery predicate (undefined !== null) deliberately:
    // the OM reader must still reject the missing mandatory usage field.
    const incidentValue = { ...incident.value, call: reference(forgedOriginal), usageKnown: true };
    const forgedIncident = { ...incident, value: incidentValue, hash: hashJson(incidentValue) };
    const terminalValue = { ...recovered.value, recovery: reference(forgedIncident) } as unknown as Record<string, unknown>;
    delete terminalValue.usage;
    const forgedTerminal = { ...recovered, value: terminalValue, hash: hashJson(terminalValue) };
    const baseline = deliveredOf(spendReport(f.store, { project: f.project }));
    const receiptValue = { ...late.record.value, dispatch: reference(forgedOriginal),
      recovered: reference(forgedTerminal), incident: reference(forgedIncident) };
    const forgedReceipt = { ...late.record, value: receiptValue, hash: hashJson(receiptValue) };
    rewrite([forgedOriginal, forgedIncident, forgedTerminal, forgedReceipt]);
    try {
      const current = new Store(f.database), exact = new ExactOnlyStore(f.database);
      try {
        const refusal = spendRefused(spendReport(current, { project: f.project }), "model_call_record_invalid");
        assert.equal(refusal.at.target, dispatch.id);
        assert.equal(refusal.at.field, "usage");
        const historical = spendRefused(readSpendReport(exact, {
          ...baseline.snapshot, calls: [reference(forgedTerminal)],
          late: [{ call: reference(forgedTerminal), receipt: null }],
        }), "model_call_record_invalid");
        assert.equal(historical.at.target, dispatch.id);
        assert.equal(historical.at.field, "usage");
      } finally { current.close(); exact.close(); }
    } finally { rewrite([dispatch, incident, recovered, late.record]); }
    assert.equal(allBytes(), originalBytes);
  });
  assert.equal(f.sent().length, 1, "All recovery-source regressions reuse the single genuine dispatch");
}

import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { canonical, canonicalSorted, hashJson, type Json } from "../src/canonical.js";
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
import { beginAttempt, completeAttempt, completionWorkId, openSeries, prepareSeriesAdmission, readCompletionBinding, resumeSeries, seriesId, stopReviewNamespace, STOP_REVIEW_KIND,
  type AnyRepairSeries, type AttemptGoal, type RepairSeries, type MechanismAdmission, type CompletionWork } from "../src/om/series.js";
import { closeAttempt, openAttempt, prepareManagedClaim, readOriginHoldAt, readStopContext,
  type MechanismOriginHold, type OriginHold } from "../src/om/repeat-gate.js";
import { startRun } from "../src/om/run.js";
import { journalId, readJournal, recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND,
  type RefusalJournal, type UnitRefusalRecord } from "../src/om/refusal-journal.js";
import { writeOmInput } from "../src/om/input.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { writeHorizon } from "../src/om/horizon.js";
import { writeGaps, type GapReadRequest, type GapRecord, type GapRequest } from "../src/om/gaps.js";
import { writeRoutes, type RoutesRecord } from "../src/om/routes.js";
import { prepareQuestionTasks, writeQuestionPacket, type QuestionPacketRequest } from "../src/om/question-packet.js";
import { gapLineKey, gapLineExpectedResult, gapLinesId, writeGapLines, type GapLinesRecord } from "../src/om/gap-lines.js";
import { writeWorksFrame } from "../src/om/works-frame.js";
import { writeNeighbors } from "../src/om/neighbors.js";
import { writeAtomicGate } from "../src/om/atomic-gate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { resolveSnapshot } from "../src/om/impact.js";
import type { LayerProposal, ProposalRequest } from "../src/om/frame-proposals.js";
import type { FrameRequest } from "../src/om/frame-obligations.js";
import { writeOmObligations, normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND } from "../src/om/obligations.js";
import { mc1FieldSpec, writeMc1Question, writeAcceptedAnswer, type AnswerQuestionContract } from "../src/om/accepted-answer.js";
import { confirmResults } from "../src/om/achievements.js";
import { writeGuarded } from "../src/om/refs.js";
import { runModelTransport, runModelCall, readModelTransport, readModelCallPhysical, readCompletionWorkAt, readManagedModelDiagnostic,
  type ModelTransportRequest, type ModelCallRequest } from "../src/om/model-call.js";
import { readAssessmentIntentAt, writeAssessmentIntent } from "../src/om/assessment.js";
import { spendReport, readSpendReport, SPEND_PURPOSE_SET_V2, type SpendSnapshot } from "../src/om/spend-report.js";
import { Environments } from "../src/runtime/environment.js";
import type { ModelCall } from "../src/runtime/model-usage.js";
import type { ProcessResult } from "../src/runtime/process.js";
import { executionOf, prepareLateModelReceipt } from "../src/discovery/model-call-recovery.js";
import {
  CALL_LEDGER_KIND, CALL_RECORD_KIND, callLedgerId, callRecordId,
  readCallLedger, readCallLedgerAt, recordCall, settleCall,
  type CallLedger, type RecordCallRequest, type MechanismRecordCallRequest,
} from "../src/om/call-record.js";
import { gardenGraph, prepareNativeLayers } from "./om-fixture.js";
import { managedBlock, managedUsage } from "./om-managed-block.js";
import { defectedWork, project, regatedHold, runFixture } from "./om-run-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

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

function rewriteLedger(f: { readonly store: Store }, value: unknown): Ref {
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

/** The same exact-read store with a write guard: a lawful historical read changes nothing. */
class FrozenExactStore extends ExactOnlyStore {
  override write<T = Json>(input: Write): Revision<T> {
    assert.fail(`a lawful historical read must not write ${input.id}`);
  }
  override writeMany<T = Json>(inputs: Write[]): Revision<T>[] {
    assert.fail(`a lawful historical read must not write ${inputs.map(input => input.id).join(", ")}`);
  }
}


/** LG07 sr-a (№10394 п.2): a store that holds nothing yet — no series and no E1 — where absence is read first. */
function bareStore(t: test.TestContext): { readonly path: string; readonly store: Store } {
  const root = mkdtempSync(join(tmpdir(), "omg-om-spend-bare-")), path = join(root, "state.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, store };
}

type LedgerRow = CallLedger["calls"][number];
type Tokens = { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningOutputTokens: number | null };
/** Token totals the way the report adds them: a component unknown in any measured call is unknown in the sum. */
function tokensOf(...usages: readonly Tokens[]): Tokens {
  const sum = (key: keyof Tokens) => usages.some(usage => usage[key] === null) ? null : usages.reduce((total, usage) => total + usage[key]!, 0);
  return { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cachedInputTokens: sum("cachedInputTokens"), reasoningOutputTokens: sum("reasoningOutputTokens") };
}
/**
 * What the paid preparation costs by its scenario: each of three managed attempts pays one research call and the
 * assessment of its one fact, each at managedUsage. The expected sums below come from these, not from the rows read.
 */
const PAID: Readonly<Record<string, number>> = { "model-research": 3, "fact-assessment": 3 };
const PAID_CALLS = Object.values(PAID).reduce((total, count) => total + count, 0);
const paidTokens = (count: number): Tokens => tokensOf(...Array.from({ length: count }, () => managedUsage));
const paidPurpose = (purpose: string) => ({ calls: PAID[purpose]!, measuredCalls: PAID[purpose]!, unmeasuredCalls: 0, reportedTokens: paidTokens(PAID[purpose]!) });

interface SpendStop {
  readonly root: string;
  readonly path: string;
  readonly store: Store;
  readonly block: string;
  readonly series: Revision<RepairSeries>;
  readonly adapter: Ref;
  readonly config: Ref;
  /** The ledger the paid attempts left: every count of the tests on this carrier is relative to it. */
  readonly paid: Revision<CallLedger>;
}
interface PaidSeed { readonly database: string; readonly block: string; readonly series: Ref }
const paidSeeds = new Map<string, Promise<PaidSeed>>();

/**
 * LG07 sr-a (№10394): the carrier N1 of the ledger and spend readers. A real first-rung stop is paid once per test
 * process — three managed attempts whose E5 found the fact insufficient, each closed by G7 — and every test receives
 * its own copy of that database file. (seedCopy takes only synchronous builds whose records name no directory; this
 * preparation names its workspace, which none of the readers below opens.) The calls under test are direct stop
 * analyses of that stop: their gaps and packet are transport data, and they are settled through settleCall.
 */
async function buildPaidSeed(project: string): Promise<PaidSeed> {
  const root = mkdtempSync(join(tmpdir(), "omg-om-spend-paid-")), database = join(root, "state.sqlite");
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  const store = new Store(database);
  try {
    const m = managedBlock(store, { root, path: database }, project);
    deliveredOf(openSeries(store, { ...m.address(), slice: "slice:cart@1", predecessor: null, basis: null }));
    for (let attempt = 1; attempt <= 3; attempt += 1) await m.cycle("gap:cart:price", "insufficient");
    const series = store.get<RepairSeries>(seriesId(project, m.block, 1))!;
    assert.deepEqual(series.value.stop?.attempts, [1, 2, 3]);
    assert.ok(series.value.ladder.grounds.includes("review-record"));
    // The preparation paid exactly what its scenario says, and every paid call is settled.
    const paid = store.get<CallLedger>(callLedgerId(project))!.value.calls;
    assert.deepEqual(Object.fromEntries(Object.keys(PAID).map(purpose => [purpose, paid.filter(row => row.purpose === purpose).length])), PAID);
    assert.equal(paid.length, PAID_CALLS);
    assert.ok(paid.every(row => row.status === "succeeded" && canonical(row.usage) === canonical(managedUsage)));
    return { database, block: m.block, series: reference(series) };
  } finally {
    store.close();
    assert.equal(existsSync(`${database}-wal`), false, "the paid seed is one checkpointed file");
  }
}

/** This test's own copy of the paid stop of `project`, in a root of its own. */
async function paidCopy(project: string, prefix: string) {
  if (!paidSeeds.has(project)) paidSeeds.set(project, buildPaidSeed(project));
  const seed = await paidSeeds.get(project)!;
  const root = mkdtempSync(join(tmpdir(), prefix)), path = join(root, "state.sqlite");
  copyFileSync(seed.database, path);
  const store = new Store(path);
  const series = store.get<RepairSeries>(seed.series.id)!;
  assert.deepEqual(reference(series), seed.series);
  return { root, path, store, block: seed.block, series, paid: store.get<CallLedger>(callLedgerId(project))! };
}

async function spendStop(t: test.TestContext): Promise<SpendStop> {
  const copy = await paidCopy(PROJECT, "omg-om-spend-"), store = copy.store;
  t.after(() => { store.close(); rmSync(copy.root, { recursive: true, force: true }); });
  // The dispatch records a direct analysis is sent through, as the shared fixture writes them.
  const adapter = reference(store.write({ id: `adapter:${PROJECT}`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: PROJECT, protocol: "codex-stdio", status: "configured-not-accepted" } }));
  const config = reference(store.write({ id: `config:${PROJECT}`, kind: "dispatch-config", expected: 0,
    value: { projectId: PROJECT, model: "fixture", transport: "stdio", status: "configured-not-accepted" } }));
  return { ...copy, adapter, config };
}

/** A direct stop analysis of the paid stop: its own name, and the questions its package addresses. */
function analysisRequest(f: SpendStop, call: string): RecordCallRequest {
  return {
    call, purpose: "stop-analysis", basis: { kind: "series-stop", series: reference(f.series), attempt: 3 }, block: f.block,
    gaps: [{ id: "gap:price", goal: "price contract", field: "contract", consumer: f.block }],
    series: reference(f.series), attempt: 3,
    goal: { key: "analysis:the saved stop", questions: ["what caused the stop of the price?"], result: "a review record with an addressed change" },
    dispatch: { adapter: f.adapter, config: f.config }, packet: { question: "who produces the price?" },
  };
}

const ownRow = (ledger: Revision<CallLedger>, call: Ref | string): LedgerRow =>
  ledger.value.calls.find(row => row.call.id === (typeof call === "string" ? call : call.id))!;
/** The full ledger with exactly the row of `call` changed: every other row, the paid ones included, stays as it was. */
const changedRows = (ledger: Revision<CallLedger>, call: Ref | string, change: (row: LedgerRow) => unknown): unknown[] =>
  ledger.value.calls.map(row => row.call.id === (typeof call === "string" ? call : call.id) ? change(row) : row);

test("E6 ledger: absence is explicit; reading current and exact snapshots writes nothing and seals the result", async t => {
  // LG07 sr-a (№10394 п.2): absence is read before any paid preparation; the positive half runs on the carrier N1.
  const bare = bareStore(t).store;
  const beforeEmpty = canonical(bare.list());
  assert.equal(deliveredOf(readCallLedger(bare, PROJECT)), null);
  assert.equal(canonical(bare.list()), beforeEmpty);
  const f = await spendStop(t);
  const first = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "price-1")));
  const before = canonical(f.store.list());
  const current = deliveredOf(readCallLedger(f.store, PROJECT));
  const historical = deliveredOf(readCallLedgerAt(f.store, PROJECT, reference(first.ledger)));
  assert.deepEqual(current, first.ledger);
  assert.deepEqual(historical, first.ledger);
  assert.ok(deeplyFrozen(current));
  assert.ok(deeplyFrozen(historical));
  assert.equal(canonical(f.store.list()), before);
});

test("E6 ledger: unknown usage stays open and differs from an explicitly settled zero", async t => {
  const f = await spendStop(t);
  const unknown = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "unknown")));
  const unsettled = deliveredOf(settleCall(f.store, reference(unknown.call), null, "failed"));
  assert.equal(unsettled.settled, false);
  assert.deepEqual(unsettled.ledger, unknown.ledger);
  const zero = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "zero")));
  const settled = deliveredOf(settleCall(f.store, reference(zero.call), zeroUsage, "succeeded"));
  const ledger = deliveredOf(readCallLedger(f.store, PROJECT))!;
  assert.deepEqual(ledger, settled.ledger);
  const unknownRow = ownRow(ledger, unknown.call), zeroRow = ownRow(ledger, zero.call);
  assert.equal(unknownRow.usage, null);
  assert.equal(unknownRow.status, "open");
  assert.equal(unknownRow.settledAt, null);
  assert.deepEqual(zeroRow.usage, zeroUsage);
  assert.equal(zeroRow.status, "succeeded");
  assert.equal(typeof zeroRow.settledAt, "number");
  assert.equal(ledger.value.calls.length, PAID_CALLS + 2);
});

test("E6 ledger: exact admission and settlement snapshots survive later calls, head changes and restart", async t => {
  const f = await spendStop(t);
  const first = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
  const settled = deliveredOf(settleCall(f.store, reference(first.call), actualUsage, "succeeded"));
  const second = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "second")));
  deliveredOf(settleCall(f.store, reference(second.call), zeroUsage, "failed"));
  assert.equal(deliveredOf(readCallLedger(f.store, PROJECT))!.value.calls.length, PAID_CALLS + 2);
  f.store.close();
  const reopened = new ExactOnlyStore(f.path);
  try {
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(f.paid))), f.paid);
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(first.ledger))), first.ledger);
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(settled.ledger))), settled.ledger);
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, PROJECT, reference(second.ledger))), second.ledger);
  } finally { reopened.close(); }
});

test("E6 ledger: a missing ledger cannot turn existing calls into an empty current report", async t => {
  const f = await spendStop(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
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

test("E6 ledger: an exact historical slice requires its own project, revision and hash", async t => {
  const f = await spendStop(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
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

test("E6 ledger: malformed and incomplete ledger values are refusals, not empty slices", async t => {
  const cases: ((valid: CallLedger) => unknown)[] = [
    () => null, () => ({}), valid => ({ calls: valid.calls }), () => ({ projectId: PROJECT }),
    valid => ({ ...valid, projectId: "other" }), valid => ({ ...valid, calls: null }),
    valid => ({ ...valid, calls: {} }), valid => ({ ...valid, extra: true }),
  ];
  for (const change of cases) {
    const f = await spendStop(t);
    const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
    const ref = rewriteLedger(f, change(recorded.ledger.value));
    refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  }
});

for (const field of ["call", "name", "purpose", "basis", "block", "gaps", "series", "attempt", "goal", "status", "usage", "openedAt", "settledAt"]) {
  test(`E6 ledger: missing row.${field} is refused by both readers`, async t => {
    const f = await spendStop(t);
    const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
    const ref = rewriteLedger(f, { projectId: PROJECT, calls: changedRows(recorded.ledger, recorded.call, own => {
      const row = { ...own } as Record<string, unknown>;
      delete row[field];
      return row;
    }) });
    refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  });
}

test("E6 ledger: the current full set rejects a removed row and historical transitions cannot lose an admitted call", async t => {
  const f = await spendStop(t);
  deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
  const second = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "second")));
  // Removal: the newest admitted row is dropped; every other row stays.
  const ref = rewriteLedger(f, { projectId: PROJECT, calls: second.ledger.value.calls.filter(row => row.call.id !== second.call.id) });
  refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
  refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  assert.deepEqual(deliveredOf(readCallLedgerAt(f.store, PROJECT, reference(second.ledger))), second.ledger);
});

test("E6 ledger: historical transitions cannot replace a call, repeat a snapshot, or duplicate an identity", async t => {
  for (const kind of ["replace", "repeat", "duplicate"]) {
    const f = await spendStop(t);
    const first = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
    const second = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "second")));
    const all = second.ledger.value.calls, firstRow = ownRow(second.ledger, first.call);
    // Replacement: the earlier admitted row is gone and the later one stands in its place; repetition: the same set
    // again as a new revision; duplication: the earlier row named twice. The paid rows stay as they were in each.
    const calls = kind === "replace" ? all.filter(row => row.call.id !== first.call.id)
      : kind === "repeat" ? all
      : all.filter(row => row.call.id !== second.call.id).flatMap(row => row.call.id === first.call.id ? [firstRow, firstRow] : [row]);
    const ref = rewriteLedger(f, { projectId: PROJECT, calls });
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  }
});

test("E6 ledger: copied rows must equal the exact call, including expense and addressed questions", async t => {
  for (const kind of ["usage", "gaps", "name", "purpose", "status"]) {
    const f = await spendStop(t);
    const opened = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
    const settled = deliveredOf(settleCall(f.store, reference(opened.call), actualUsage, "succeeded"));
    const ref = rewriteLedger(f, { projectId: PROJECT, calls: changedRows(settled.ledger, settled.call, row =>
      kind === "usage" ? { ...row, usage: { ...actualUsage, inputTokens: 0 } }
      : kind === "gaps" ? { ...row, gaps: [{ ...row.gaps[0], id: "gap:other" }] }
      : kind === "name" ? { ...row, name: "other" }
      : kind === "purpose" ? { ...row, purpose: "model-design" }
      : { ...row, status: "open", usage: null, settledAt: null }) });
    refusedWith(readCallLedger(f.store, PROJECT), "ledger_invalid");
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), "ledger_invalid");
  }
});

test("E6 ledger: absent, foreign and wrong-hash exact call references refuse a historical slice", async t => {
  for (const kind of ["missing", "foreign", "hash", "revision"]) {
    const f = await spendStop(t);
    const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
    const ref = rewriteLedger(f, { projectId: PROJECT, calls: changedRows(recorded.ledger, recorded.call, row => {
      const call = kind === "missing" ? { ...row.call, id: callRecordId(PROJECT, "missing") }
        : kind === "foreign" ? { ...row.call, id: callRecordId("other", "first") }
        : kind === "hash" ? { ...row.call, hash: "0".repeat(64) } : { ...row.call, revision: 42 };
      return { ...row, call };
    }) });
    refusedWith(readCallLedgerAt(f.store, PROJECT, ref), ["call_unresolved", "ledger_invalid"]);
  }
});

test("E6 ledger: a named call's saved shape is validated rather than trusted from its ledger row", async t => {
  const f = await spendStop(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
  const changed = { ...recorded.call.value, gaps: [] };
  const call = f.store.write({ id: recorded.call.id, kind: CALL_RECORD_KIND, expected: 1, value: changed });
  const ref = rewriteLedger(f, { projectId: PROJECT, calls: changedRows(recorded.ledger, recorded.call, row => ({ ...row, call: reference(call), gaps: [] })) });
  refusedWith(readCallLedger(f.store, PROJECT), "call_record_invalid");
  refusedWith(readCallLedgerAt(f.store, PROJECT, ref), ["call_record_invalid", "ledger_invalid"]);
});

test("E6 ledger: invalid reader arguments and undeclared historical contexts are typed refusals", async t => {
  const f = await spendStop(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
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

/** The one M5 mechanism address of the run fixture's project. */
const M5 = { project, owner: { kind: "mechanism", mechanism: "M5:addressing" } as const, line: 1 };
/* The mechanism-origin world, built on the fixture's real accepted state — "encoding" stays unaddressed, the
 * level-2 and level-3 frames stand accepted, and the repository is real — by the engine's own writers, nothing
 * hand-made. A works proposal that declares its nodes removed while keeping only read access to their code is
 * carried as a real candidate to the true G5: settleCandidate writes the actual diagnostic and journals its rows,
 * and because the accepted base and the rejected proposal both hold the work the finding names, no row of the
 * origin table places it — the weighing stands unknown. The mechanism's managed lifecycle then runs on the derived
 * routes — owner series, the prepared admission, the issued packet, the paid call ending in the real
 * cannot_answer — and its explicit G7 close claims the unplaced row: the gate's own weighing raises THIS attempt's
 * hold on it. The later journal head is another settled rejection of the same kind — a real producer's newer
 * revision, after the analysis already settled on the older one. The paid preparation is accounted by the ledger
 * itself, never derived from the report under test. */
async function mechanismOriginFixture(t: test.TestContext) {
  const { owner, project } = M5;
  const f = runFixture(t, ["encoding"], "executed"), store = f.store, request = f.request();
  const input = reference(store.get(`om-input:${project}`)!);
  const graph = reference(store.get(`graph:${project}`)!);
  const environment = reference(store.get(`environment:${project}`)!);
  const layer2 = reference(store.get(`graph-layer:${project}:2`)!), layer3 = reference(store.get(`graph-layer:${project}:3`)!);
  const frame2 = reference(store.get(`om-frame:${project}:2`)!), frame3 = reference(store.get(`om-frame:${project}:3`)!);
  const horizon = deliveredOf(writeHorizon(store, { project, input, graph, refinement: layer2, available: {},
    choice: { choiceVersion: "spend-origin", features: [{ outcome: `${project}-result` }], excluded: [] } }));
  const h = reference(horizon.gate);
  // The accepted-world frame requests — the same shape the door itself derives after the level-3 acceptance.
  const worksFrame = (): FrameRequest => ({ project, level: 3, graph, horizon: h, layer: layer3, frame: frame3,
    upper: { horizon: h, frame: frame2 }, workZoneContract: "accepted-l2-v1" });
  const operationsFrame = (): FrameRequest => ({ project, level: 2, graph, horizon: h, layer: layer2, frame: frame2, upper: null });
  const scopeOf = (works: ProposalRequest): GapRequest =>
    ({ project, input, graph, horizon: h, operations: { frame: operationsFrame(), proposals: [] }, works });
  const accepted3 = store.list<LayerProposal>("layer-proposal").filter(record => record.value.level === 3).at(-1)!;
  assert.ok(accepted3, "the executed world keeps its accepted level-3 proposal");

  // A real failed works cycle on the accepted base: the defected proposal meets the true G5, and settleCandidate
  // writes the actual diagnostic and journals its rows — the base and the rejected proposal both hold the work the
  // finding names, so no rule of the origin table places it: claimed, the row weighs unknown.
  const failCandidate = (suffix: string) => {
    const defected = structuredClone(accepted3.value);
    defected.base = { graph, frame: frame3 };
    defected.status = "proposed";
    delete defected.verdict;
    for (const node of defected.nodes) if (node.code) node.code = node.code.map(item => ({ ...item, access: "read" }));
    for (const fill of defected.fills) if (fill.codeRef) fill.codeRef = { ...fill.codeRef, access: "read" };
    // The accepted frame's slots are occupied: every re-stated fill is an explicit replacement of the accepted
    // endpoint it succeeds, and the proposal says the works it redefines are removed — the defected copy is real.
    defected.replaces = defected.fills.map(fill => ({ obligation: fill.obligation,
      base: { node: fill.node, graph }, with: { node: fill.node, port: fill.port ?? null },
      basis: "spend-origin: the re-issued work carries read-only write scope" }));
    defected.removes = [...new Set([...defected.removes, ...defected.nodes.map(node => node.id)])];
    const proposal = reference(store.write({ id: `om-proposal:${project}:${suffix}`,
      kind: "layer-proposal", expected: 0, value: defected }));
    const works = { frame: worksFrame(), proposals: [proposal] };
    const derived = deliveredOf(writeGaps(store, scopeOf(works)));
    const read = { sources: structuredClone(derived.sources) as GapRequest, records: canonicalSorted(derived.records.map(reference)) };
    const previous = store.get<GapLinesRecord>(gapLinesId(project));
    const lines = deliveredOf(writeGapLines(store, { project, previous: previous ? reference(previous) : null,
      pass: (previous?.value.request.pass ?? 0) + 1, gaps: read, closures: [] }));
    const handoff = deliveredOf(writeOmObligations(store, { project, gaps: read, lines: reference(lines), assignments: [] }));
    const candidate = deliveredOf(writeWorksFrame(store, { ...works, works: { contract: "works-frame/v1",
      producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } }));
    assert.equal(candidate.state, "candidate");
    const neighbors = deliveredOf(writeNeighbors(store, { project, candidate: reference(candidate.record) }));
    const gate = deliveredOf(writeAtomicGate(store, { project, candidate: reference(candidate.record),
      neighbors: reference(neighbors), environment, gaps: read, results: [], sources: [],
      snapshot: resolveSnapshot(join(f.root, "repo")) }));
    assert.ok(!gate.value.result.passed, "the defected proposal meets a real G5 refusal");
    const journalBefore = new Set((store.get<RefusalJournal>(journalId(project))?.value.rows ?? []).map(row => row.id));
    const settled = deliveredOf(settleCandidate(store, { project, level: 3, candidate: reference(candidate.record),
      outcome: { ...gate.value.result, codes: [...gate.value.result.codes], basis: reference(gate) } }));
    assert.equal(settled.state, "rejected");
    // Exactly this candidate's rows: the delta its settlement journaled, not every G5 row the journal holds.
    const rows = deliveredOf(readJournal(store, { project })).value.rows
      .filter(row => row.gate === "G5" && !journalBefore.has(row.id));
    assert.ok(rows.length >= 1, "the refused candidate's own diagnostic journals its own G5 rows");
    return rows;
  };

  const g5rows = failCandidate("defected");
  for (const row of g5rows) {
    const source = store.get<UnitRefusalRecord>(row.source.id, row.source.revision);
    assert.ok(source && source.value.gate === "G5", "each candidate row links its own exact G5 refusal record");
  }

  // The mechanism's managed lifecycle on the derived routes — owner series line 1, the prepared admission, the
  // issued packet and the paid call whose real cannot_answer completes its work as refused.
  const derived = deliveredOf(writeGaps(store, scopeOf({ frame: worksFrame(), proposals: [] })));
  const scope = { sources: structuredClone(derived.sources) as GapRequest, records: canonicalSorted(derived.records.map(reference)) };
  const routes4 = deliveredOf(writeRoutes(store, { project, gaps: scope, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch4 = routes4.value.batches.find(batch => batch.model === "MC2" && batch.task === "input-field"
    && batch.items.every(item => item.consumers.length === 0))!;
  assert.ok(batch4, "the open encoding question is routed to the mechanism on the current routes");
  const ownerAddress = { project, owner, line: 1 };
  const admission: MechanismAdmission = { gaps: { sources: structuredClone(scope.sources) as GapRequest,
    records: [...scope.records] }, routes: reference(routes4), batch: batch4.id };
  deliveredOf(openSeries(store, { ...ownerAddress, scope: admission.gaps, predecessor: null, basis: null }));
  const proof = deliveredOf(prepareSeriesAdmission(store, ownerAddress, admission));
  const goal: AttemptGoal = { key: "address-missing-fields", ...proof.goal };
  const series = deliveredOf(openAttempt(store, { ...ownerAddress, attempt: 1, goal, admission,
    completion: { routes: reference(routes4), batches: [batch4.id] } })) as Revision<AnyRepairSeries>;
  const binding = deliveredOf(readCompletionBinding(store, project, reference(series), 1));
  assert.ok(binding, "the managed opening binds its own exact completion owner");
  assert.deepEqual(binding.value.series, reference(series));
  assert.equal(binding.value.attempt, 1);
  assert.deepEqual(binding.value.owner, owner);
  assert.deepEqual(binding.value.goal, goal);
  assert.deepEqual(binding.value.plan, { routes: reference(routes4), batches: [batch4.id] });
  const packet = deliveredOf(writeQuestionPacket(store, { project, routes: reference(routes4), batch: batch4.id,
    environment, attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  assert.equal(packet.value.state, "ready", "E2 issues the ready packet of this exact attempt");
  assert.equal(packet.value.request.batch, batch4.id);
  assert.deepEqual(packet.value.request.routes, reference(routes4), "the packet names the full exact routes reference");
  assert.deepEqual(packet.value.request.attempt?.series, reference(series), "the packet names the full exact series reference");
  assert.equal(packet.value.request.attempt?.ordinal, 1);
  const inputHead = reference(store.get(`om-input:${project}`)!);
  f.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "cannot_answer",
    questionIds: batch4.items.map(item => item.gap),
    reason: "The delivered material does not answer the encoding question" }, usage: actualUsage });
  const e4 = deliveredOf(await runModelCall(store, { project, packet: reference(packet),
    dispatch: request.dispatch, role: "implementer" }));
  assert.equal(e4.outcome?.kind, "no-result", "the paid E4 ends refused through the real answer form");
  assert.deepEqual(e4.packet, reference(packet), "the paid E4 is the exchange of this exact packet");
  assert.ok(e4.call, "the paid E4 keeps its own call record");
  assert.equal(e4.record.value.om.application, "applied", "the paid E4 exchange is applied to its exact call record");
  assert.deepEqual(e4.record.value.om.call, e4.call, "the call record names its own full call reference");
  assert.ok(e4.record.value.om.exchange, "the applied call keeps its exact exchange record");
  assert.deepEqual(e4.record.value.om.request.packet, reference(packet), "the call request names the full exact packet");
  const physical = deliveredOf(readModelCallPhysical(store, { project, record: reference(e4.record) }));
  assert.deepEqual(physical.call, e4.call, "the physical exchange names the same full call reference");
  assert.deepEqual(physical.packet, reference(packet), "the physical exchange names the same full packet reference");
  assert.ok(physical.transport, "the applied E4 keeps its transport exchange");
  assert.deepEqual(e4.record.value.usage, actualUsage, "the paid preparatory call carries its measured usage");
  assert.ok(e4.diagnostic, "the refused E4 keeps its own diagnostic");
  const e4diagnostic = store.get<UnitRefusalRecord>(e4.diagnostic.id, e4.diagnostic.revision)!;
  assert.equal(e4diagnostic.value.gate, "E4", "the saved diagnostic is the E4's own unit refusal");
  const e4proof = deliveredOf(readManagedModelDiagnostic(store, binding, e4.diagnostic!));
  assert.equal(e4proof.reason, "refused", "the E4 diagnostic's own derived reason is refused");
  const e4origin = e4diagnostic.value.refusals[0]!.origin;
  const e4packetSource = e4origin.sources.find(source => source.role === "packet")!;
  const e4callSource = e4origin.sources.find(source => source.role === "call")!;
  assert.deepEqual(e4packetSource.ref, reference(packet), "the E4 diagnostic names the full exact packet reference");
  assert.deepEqual(e4callSource.ref, e4.call, "the E4 diagnostic names the full exact call reference");
  assert.deepEqual(reference(store.get(`om-input:${project}`)!), inputHead,
    "the paid refused E4 leaves the admitted input untouched");

  // The paid E4's own saved diagnostic is journalled too — a second real refusal row of this project's own journal.
  deliveredOf(recordRefusal(store, { project, source: e4.diagnostic! }));
  const rows = deliveredOf(readJournal(store, { project })).value.rows.filter(item => item.source.id === e4.diagnostic!.id);
  assert.ok(rows.length >= 1, "the refused paid E4 journals its diagnostic as rows");

  // The mechanism attempt's explicit G7 claims its own paid row and the unplaced works row: the gate's own weighing
  // raises this attempt's hold on it, and the origin analysis is recorded and settled on that exact journal head.
  const claim = deliveredOf(prepareManagedClaim(store, { ...ownerAddress, attempt: 1,
    outcome: { reason: "refused", accepting: [], cancelling: [],
      refusals: [...rows.slice(0, 1), ...g5rows].map(item => ({ row: item.id, name: item.code, goal: item.goal })) } }));
  assert.equal(claim.outcome.reason, "refused", "the gate derives the refused reason from the weighed rows");
  const claimedRows = new Set(claim.outcome.refusals.map(item => item.row));
  for (const row of [...rows, ...g5rows])
    assert.ok(claimedRows.has(row.id), "the managed claim keeps every required E4 and candidate row");
  // The same M5 series is re-read at its own head immediately before the close: its own attempt 1 is still open.
  const preCloseHead = store.get<AnyRepairSeries>(series.id)!;
  assert.equal(preCloseHead.value.attempts.length, 1, "the own series holds only this exact attempt");
  assert.equal(preCloseHead.value.attempts[0]!.ordinal, 1);
  assert.equal(preCloseHead.value.attempts[0]!.outcome, null, "attempt 1 stays open on its own series until the G7 close");
  // Before the close the factual work record already reads the complete composition of the own paid batch.
  const workHead = store.get<CompletionWork>(completionWorkId(project, binding.id))!;
  const composition = deliveredOf(readCompletionWorkAt(store, project, reference(workHead)));
  assert.equal(composition.complete, true, "the own paid batch is complete in the factual work composition before G7");
  const closed = deliveredOf(closeAttempt(store, { ...ownerAddress, attempt: 1, outcome: claim.outcome }));
  assert.equal(closed.attempt, 1, "the explicit G7 completes this exact attempt");
  // The gate's own routing of the claimed rows: each own G5 row weighs unknown by the origin table itself,
  // and the refused paid E4 is a proposal row — a source of the stop, never a substitute for the unknown one.
  for (const row of g5rows) {
    const routed = closed.routed.find(item => item.row === row.id);
    assert.ok(routed, "G7 itself routes the own candidate row");
    assert.equal(routed!.class, "unknown", "the own G5 row weighs unknown by the gate's own table");
  }
  const e4routed = closed.routed.find(item => item.row === rows[0]!.id);
  assert.equal(e4routed?.class, "proposal", "the refused paid E4 is a proposal row, not a substitute for unknown");
  // The closure is proved by the completion reader on the factual post-close work record, not by a flag.
  const closedWorkHead = store.get<CompletionWork>(completionWorkId(project, binding.id))!;
  assert.ok(closedWorkHead.value.closed, "the factual work record carries its own close");
  const closedComposition = deliveredOf(readCompletionWorkAt(store, project, reference(closedWorkHead)));
  assert.ok(closedComposition.work.value.closed, "the completion reader returns the closed registry");
  assert.equal(closedComposition.complete, true, "the closed registry still holds the complete own composition");
  // The hold is this series' fact for its own unplaced row — the candidate's row, not any row the journal holds.
  const head = reference(store.get<RefusalJournal>(journalId(project))!);
  const held = closed.holds.map(item => deliveredOf(readOriginHoldAt(store, project, item, head)));
  const own = held.filter(item => g5rows.some(row => row.id === item.value.row));
  assert.ok(own.length >= 1, "the unplaced candidate row stands as this attempt's hold");
  const heldRecord = own[0]!, hold = reference(heldRecord);
  assert.equal(heldRecord.value.attempt, 1);
  const seriesAtHold = reference(store.get<AnyRepairSeries>(series.id)!);
  assert.deepEqual(heldRecord.value.series, seriesAtHold, "the hold names the full exact M5 series revision that recorded its refusal");
  assert.deepEqual((heldRecord.value as MechanismOriginHold).owner, owner);
  assert.equal(heldRecord.value.lift, null, "the hold stands while its origin is not established");
  const context = deliveredOf(readStopContext(store, { project, owner, line: 1 })).context;
  const contextHold = context.holds.find(item => item.hold.id === hold.id)!;
  assert.ok(contextHold, "the standing-hold context names the same hold");
  assert.equal(contextHold.attempt, 1);
  const heldRow = g5rows.find(row => row.id === heldRecord.value.row)!;
  assert.deepEqual(contextHold.origin, heldRow.origin, "the hold's context carries the row's own weighed origin");
  const obstacle = context.repeated.find(item => item.row === heldRow.id);
  assert.ok(obstacle, "the stop context counts the own row among this series' obstacles");
  assert.equal(obstacle!.class, "unknown", "the context's own weighing of the own row is unknown");
  assert.equal(obstacle!.times, 1, "the tally counts exactly this one attempt running into the row");
  const closedSeries = reference(store.get<AnyRepairSeries>(series.id)!);
  const analysisGoal = { key: "analyse-encoding-origin", questions: ["What caused this unanswered encoding question?"],
    result: "A checked origin for the saved refusal" };
  const analysis: MechanismRecordCallRequest = {
    call: "mechanism-origin", purpose: "origin-analysis", basis: { kind: "origin-hold", hold }, owner, admission,
    gaps: [{ id: hold.id, goal: analysisGoal.key, field: "origin", consumer: owner }],
    series: closedSeries, attempt: 1, goal: analysisGoal,
    dispatch: request.dispatch, packet: { question: "What caused this saved refusal?" },
  };
  const recorded = deliveredOf(recordCall(store, project, analysis));
  const settled = deliveredOf(settleCall(store, reference(recorded.call), actualUsage, "succeeded"));
  const journal = reference(store.get<RefusalJournal>(journalId(project))!);
  const gapRecords = { records: admission.gaps.records.map(ref => store.get<GapRecord>(ref.id, ref.revision)!) };
  // The later journal head is a real producer's too: another defected proposal on the same accepted base meets the
  // true G5 and its settled rejection journals its own rows — a new revision of the same real journal, reached
  // after the analysis was already settled on the older head.
  async function laterJournal() {
    failCandidate("defected-again");
    return reference(store.get<RefusalJournal>(journalId(project))!);
  }
  return { get store() { return store; }, path: f.database, recorded, settled, journal, laterJournal, hold, e4,
    series: closedSeries, admission, goal: analysisGoal, dispatch: request.dispatch, gaps: gapRecords,
    gapScope: { sources: structuredClone(admission.gaps.sources) as GapRequest, records: [...admission.gaps.records] } };
}

test("E6 ledger: mechanism origin analysis reads its exact journal after later journal heads and restart", async t => {
  const f = await mechanismOriginFixture(t);
  // The paid preparatory call and its expense — the refused E4 exchange of the managed attempt.
  assert.equal(f.e4.outcome?.kind, "no-result");
  assert.deepEqual(f.e4.record.value.usage, actualUsage, "the preparatory E4 call is paid at its measured usage");
  assert.ok(f.e4.call && f.e4.diagnostic);
  // Both exact revisions of the origin analysis exist — the recorded opening and the settled head.
  assert.ok(f.settled.call.revision > f.recorded.call.revision, "the settled call is a later revision of the recorded one");
  const currentHistory = [{ call: reference(f.settled.call), journal: f.journal }];
  assert.deepEqual(deliveredOf(readCallLedger(f.store, M5.project, currentHistory)), f.settled.ledger);
  const laterJournal = await f.laterJournal();
  assert.ok(laterJournal.revision > f.journal.revision);
  f.store.close();
  const reopened = new FrozenExactStore(f.path);
  try {
    const admissionHistory = [{ call: reference(f.recorded.call), journal: f.journal }];
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, M5.project, reference(f.recorded.ledger), admissionHistory)), f.recorded.ledger);
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, M5.project, reference(f.settled.ledger), currentHistory)), f.settled.ledger);
    // A lawful historical read writes nothing and a repeat reads the same ledgers.
    assert.deepEqual(deliveredOf(readCallLedgerAt(reopened, M5.project, reference(f.settled.ledger), currentHistory)), f.settled.ledger);
    assert.deepEqual(reopened.get(f.recorded.call.id, f.recorded.call.revision)!.value, f.recorded.call.value,
      "the recorded revision of the origin analysis is read exactly");
    assert.deepEqual(reopened.get(f.settled.call.id, f.settled.call.revision)!.value, f.settled.call.value,
      "the settled revision of the origin analysis is read exactly");
    refusedWith(readCallLedgerAt(reopened, M5.project, reference(f.recorded.ledger)), "ledger_invalid");
    for (const journal of [
      { ...f.journal, hash: "0".repeat(64) }, { ...f.journal, revision: 50 }, { ...f.journal, id: "om-refusal-journal:other" },
    ]) {
      refusedWith(readCallLedgerAt(reopened, M5.project, reference(f.recorded.ledger), [{ call: reference(f.recorded.call), journal }]),
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
  // LG07 sr-a (№10394 п.2): an empty scope is a project with no series and no E1 at all.
  const f = bareStore(t);
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

test("E6 report: one packet with several questions and consumers incurs one expense, with no hidden significance threshold", async t => {
  // LG07 sr-a (№10394 п.1): the package is a direct stop analysis, so its purpose is stop-analysis; the paid
  // preparation's research and assessment calls stand beside it with what their scenario cost.
  const f = await spendStop(t), input = analysisRequest(f, "package");
  const admitted = deliveredOf(recordCall(f.store, PROJECT, { ...input, gaps: [
    { id: "encoding", goal: "Encoding at first consumer", field: "encoding", consumer: "block:first" },
    { id: "encoding", goal: "Encoding at second consumer", field: "encoding", consumer: "block:second" },
    { id: "transport", goal: "Transport at second consumer", field: "transport", consumer: "block:second" },
  ] }));
  const measured = { inputTokens: 9_000_000, outputTokens: 3_000_000, cachedInputTokens: 2_000_000, reasoningOutputTokens: 1_000_000 };
  const settled = deliveredOf(settleCall(f.store, reference(admitted.call), measured, "succeeded"));
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.equal(report.rows.length, PAID_CALLS + 1);
  const row = report.rows.find(item => item.call?.id === settled.call.id)!;
  assert.deepEqual(row.call, reference(settled.call));
  assert.deepEqual(row.questions, settled.call.value.gaps);
  assert.equal(row.questions.length, 3);
  assert.deepEqual(row.usage, measured);
  assert.equal(row.settlement, "succeeded");
  assert.deepEqual(row.significance, { obligations: null, consumers: null, blocks: null, sources: [] });
  assert.equal(row.result, null, "Settlement is not acceptance of an attempt result");
  assert.deepEqual(report.byPurpose["stop-analysis"], { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: measured });
  for (const purpose of Object.keys(PAID)) assert.deepEqual(report.byPurpose[purpose as keyof typeof report.byPurpose], paidPurpose(purpose), purpose);
  assert.deepEqual(report.totals, { calls: PAID_CALLS + 1, measuredCalls: PAID_CALLS + 1, unmeasuredCalls: 0,
    reportedTokens: tokensOf(paidTokens(PAID_CALLS), measured) });
  assert.deepEqual(report.findings, [], "Disproportionate expense is the owner's decision, not an automatic finding");
});

test("E6 report: partial token measurements stay unknown, explicit zeros stay measured and purposes stay separate", async t => {
  // LG07 sr-a (№10394 п.1): the calls under test are stop analyses (the former model-design call has no lawful
  // carrier here); the separation of purposes is shown on the paid research and assessment calls beside them.
  const f = await spendStop(t);
  const unknown = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "unknown")));
  const zero = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "zero")));
  deliveredOf(settleCall(f.store, reference(zero.call), zeroUsage, "failed"));
  const partial = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "partial")));
  const measured = { inputTokens: 120, outputTokens: 30, cachedInputTokens: null, reasoningOutputTokens: null };
  deliveredOf(settleCall(f.store, reference(partial.call), measured, "succeeded"));
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  // Unknown usage: one call stays unmeasured and open.
  assert.equal(report.totals.calls, PAID_CALLS + 3);
  assert.equal(report.totals.unmeasuredCalls, 1);
  assert.equal(report.rows.find(row => row.call?.id === unknown.call.id)!.usage, null);
  assert.deepEqual(report.findings.map(item => item.code), ["call_not_settled"]);
  assert.equal(report.findings[0]!.at.target, unknown.call.id);
  // An explicit zero is a measurement.
  assert.equal(report.totals.measuredCalls, PAID_CALLS + 2);
  assert.deepEqual(report.rows.find(row => row.call?.id === zero.call.id)!.usage, zeroUsage);
  // A component unknown in one measured call is unknown in every sum it enters.
  assert.deepEqual(report.byPurpose["stop-analysis"], { calls: 3, measuredCalls: 2, unmeasuredCalls: 1, reportedTokens: tokensOf(zeroUsage, measured) });
  assert.equal(report.byPurpose["stop-analysis"].reportedTokens!.cachedInputTokens, null);
  assert.deepEqual(report.totals.reportedTokens, tokensOf(paidTokens(PAID_CALLS), zeroUsage, measured));
  // Each purpose keeps exactly its own calls and their cost.
  for (const purpose of Object.keys(PAID)) assert.deepEqual(report.byPurpose[purpose as keyof typeof report.byPurpose], paidPurpose(purpose), purpose);
});

test("E6 report: historical snapshots keep exact expense and unfinished outcomes after later settlement, attempts and restart", async t => {
  const f = await spendStop(t);
  const first = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
  const saved = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.equal(saved.rows.find(row => row.call?.id === first.call.id)!.usage, null);
  deliveredOf(settleCall(f.store, reference(first.call), actualUsage, "succeeded"));
  // LG07 sr-a (№10394 п.2): the later change of the series is its lawful continuation after an independent review.
  const stop = f.series.value.stop!;
  const review = reference(f.store.write({ id: `${stopReviewNamespace(PROJECT)}spend-later`, kind: STOP_REVIEW_KIND, expected: 0,
    value: { projectId: PROJECT, block: f.block, stop: stop.attempt, goals: [...stop.goals],
      reviewer: { name: "independent reviewer", independent: true },
      cause: "the same unresolved question survived every attempt in the window",
      change: { text: "change the producer addressed by the repeated question", addresses: ["M5"] } } }));
  const resumed = deliveredOf(resumeSeries(f.store, { project: PROJECT, block: f.block, line: 1, stop: stop.attempt,
    ground: "review-record", text: "the independent review named an addressed change", review: { ref: review } }));
  assert.equal(resumed.value.stop, null);
  const current = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.deepEqual(current.rows.find(row => row.call?.id === first.call.id)!.usage, actualUsage);
  assert.notDeepEqual(current.snapshot, saved.snapshot);
  f.store.close();
  const historical = new ExactOnlyStore(f.path);
  try { assert.deepEqual(deliveredOf(readSpendReport(historical, saved.snapshot as SpendSnapshot)), saved); }
  finally { historical.close(); }
});

test("E6 report: every historical snapshot field is mandatory, including explicit empty sets and null ledger", t => {
  // LG07 sr-a (№10394 п.2): the empty sets and the null ledger are those of a project with no series and no E1.
  const f = bareStore(t);
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  assert.equal(report.snapshot.ledger, null);
  const invalid = (error: unknown) => error instanceof EngineError && error.code === "spend_request_invalid";
  for (const field of ["purposeSet", "project", "ledger", "calls", "series", "histories", "significance", "late"]) {
    const bad = { ...report.snapshot } as Record<string, unknown>;
    delete bad[field];
    assert.throws(() => readSpendReport(f.store, bad as unknown as SpendSnapshot), invalid, field);
  }
  for (const input of [null, {}, { project: "" }, { project: PROJECT, extra: true }, { project: PROJECT, histories: null }]) {
    assert.throws(() => spendReport(f.store, input as Parameters<typeof spendReport>[1]), invalid);
  }
});

test("E6 report: invalid E1 questions with a consistent hash remain a refusal of record integrity", async t => {
  const malformed = (owner: string) => {
    const question = { id: "gap:price", goal: "price contract", field: "contract", consumer: owner };
    return [[], ...Object.keys(question).map(field => [Object.fromEntries(Object.entries(question).filter(([key]) => key !== field))])];
  };
  for (const index of malformed(BLOCK).keys()) {
    const f = await spendStop(t), gaps = malformed(f.block)[index]!;
    const original = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
    // A negative mutation, written by hand only to be refused: a self-consistent record whose questions are invalid.
    const bad = f.store.write({ id: callRecordId(PROJECT, "bad-questions"), kind: CALL_RECORD_KIND, expected: 0,
      value: { ...original.call.value, call: "bad-questions", gaps } });
    const badRow = { ...ownRow(original.ledger, original.call), call: reference(bad), name: "bad-questions", gaps };
    rewriteLedger(f, { projectId: PROJECT, calls: [...original.ledger.value.calls, badRow].sort((a, b) => a.call.id.localeCompare(b.call.id)) });
    spendRefused(spendReport(f.store, { project: PROJECT }), "call_record_invalid");
  }
});

test("E6 report: corrupted ledger and exact snapshot references cannot become unknown significance or empty expense", async t => {
  const f = await spendStop(t);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "first")));
  const report = deliveredOf(spendReport(f.store, { project: PROJECT }));
  spendRefused(readSpendReport(f.store, { ...report.snapshot, ledger: { ...reference(recorded.ledger), hash: "0".repeat(64) } }), "ledger_invalid");
  rewriteLedger(f, { projectId: PROJECT, calls: [] });
  spendRefused(spendReport(f.store, { project: PROJECT }), "ledger_invalid");
});

/** LG07 sr-c (№10394 п.6): the exact D1 set the paid plan of the attempt stood on, as its routes record it. */
function planD1(f: SpendStop): GapReadRequest {
  const binding = deliveredOf(readCompletionBinding(f.store, PROJECT, reference(f.series), 1));
  assert.ok(binding, "the paid attempt has its completion plan");
  const routes = f.store.get<RoutesRecord>(binding.value.plan.routes.id, binding.value.plan.routes.revision)!;
  return structuredClone(routes.value.request.gaps) as GapReadRequest;
}
type D1Gap = { gap: { code: string; target: string; field: string; consumers: string[] } };

test("E6 report: explicit D1 sources count distinct obligations, consumers and blocks rather than repeated mentions", async t => {
  // LG07 sr-c (№10394 п.6): the D1 set is the exact one the paid plan stood on, and the declaring package is a stop
  // analysis of the paid stop: no origin history enters the ledger, so the report names none.
  const f = await spendStop(t), gapScope = planD1(f);
  const records = gapScope.records.map(ref => f.store.get<D1Gap>(ref.id, ref.revision)!);
  const selected = records.filter(record => record.value.gap.code === "obligation_open" && record.value.gap.consumers.length > 0);
  assert.ok(selected.length >= 2, "The real plan carries several addressed obligations");
  const chosen = selected.slice(0, 2), rows = chosen.flatMap(record => record.value.gap.consumers.map(consumer => ({
    id: record.value.gap.target, goal: record.value.gap.target, field: record.value.gap.field, consumer,
  })));
  const recorded = deliveredOf(recordCall(f.store, PROJECT, { ...analysisRequest(f, "declared-significance"), gaps: [...rows, rows[0]!] }));
  const settled = deliveredOf(settleCall(f.store, reference(recorded.call), actualUsage, "succeeded"));
  const source = { call: reference(settled.call), gaps: gapScope, obligations: null };
  const report = deliveredOf(spendReport(f.store, { project: PROJECT, significance: [source] }));
  const row = report.rows.find(item => item.call?.id === settled.call.id)!;
  assert.ok(row);
  assert.equal(row.questions.length, rows.length + 1, "Accounting keeps every declared question in the package");
  assert.equal(row.significance.obligations, new Set(chosen.map(item => item.value.gap.target)).size);
  const consumers = new Set(rows.map(item => item.consumer));
  assert.equal(row.significance.consumers, consumers.size);
  const graph = f.store.get<Graph>(gapScope.sources.graph.id, gapScope.sources.graph.revision)!.value;
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

test("E6 report: a valid D1 set unrelated to the call is refused instead of producing guessed counts", async t => {
  const f = await spendStop(t), gapScope = planD1(f);
  const recorded = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "unrelated-to-d1")));
  const report = spendReport(f.store, { project: PROJECT,
    significance: [{ call: reference(recorded.call), gaps: gapScope, obligations: null }] });
  const refusal = spendRefused(report, "spend_basis_invalid");
  assert.equal(refusal.at.target, recorded.call.id);
  assert.equal(refusal.at.field, "gaps");
});

test("E6 report: a named missing or incorrect D1 source is a refusal rather than unknown significance", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  // The carrier is the block-level call the question belongs to: a stop analysis of the paid stop, and the D1 set
  // is the exact one its plan stood on. A mechanism origin-analysis is not the subject this negative checks.
  const f = await spendStop(t), gapScope = planD1(f);
  const selected = gapScope.records.map(ref => f.store.get<D1Gap>(ref.id, ref.revision)!)
    .find(record => record.value.gap.code === "obligation_open" && record.value.gap.consumers.length > 0)!;
  assert.ok(selected);
  const gap = selected.value.gap;
  const recorded = deliveredOf(recordCall(f.store, PROJECT, { ...analysisRequest(f, "exact-d1"),
    gaps: [{ id: gap.target, goal: gap.target, field: gap.field, consumer: gap.consumers[0]! }] }));
  const whole = spendReport(f.store, { project: PROJECT,
    significance: [{ call: reference(recorded.call), gaps: gapScope, obligations: null }] });
  assert.ok(whole.ok, "the intact named source is the lawful control for the same declared question");
  for (const changed of [
    { ...gapScope, records: gapScope.records.filter(ref => ref.id !== selected.id) },
    { ...gapScope, records: gapScope.records.map(ref => ref.id === selected.id ? { ...ref, hash: "0".repeat(64) } : ref) },
    { ...gapScope, sources: { ...gapScope.sources, input: { ...gapScope.sources.input, revision: 99 } } },
  ]) {
    const result = spendReport(f.store, { project: PROJECT,
      significance: [{ call: reference(recorded.call), gaps: changed, obligations: null }] });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.ok(result.refusal.code); assert.ok(result.refusal.at.target); }
  }
});

const providerPath = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
function physicalFixture(t: test.TestContext) {
  const purpose = "stop-analysis" as const;
  const root = mkdtempSync(join(tmpdir(), "omg-spend-physical-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = "analysis", block = "analysis-block", address = { project, block, line: 1 };
  store.write({ id: `project:${project}`, kind: "project", expected: 0, value: { id: project, title: "Spend report fixture" } });
  const goal = { key: "physical-ground", questions: ["Which contract needs evidence?"], result: "An evidenced contract" };
  deliveredOf(openSeries(store, { ...address, slice: "analysis-slice", predecessor: null, basis: null }));
  let series = deliveredOf(beginAttempt(store, { ...address, attempt: 1, goal })) as Revision<RepairSeries>;
  for (const attempt of [1, 2, 3]) {
    if (attempt > 1) deliveredOf(beginAttempt(store, { ...address, attempt, goal }));
    series = deliveredOf(completeAttempt(store, { ...address, attempt,
      outcome: { reason: "result", achieved: [], cancelled: [], refusals: [] } })) as Revision<RepairSeries>;
  }
  const basis = { kind: "series-stop" as const, series: reference(series), attempt: 3 };
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
    series: reference(series), attempt: 3, goal: reviewGoal,
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

/**
 * LG07 sr-b (№10394 п.4): the physical stop analysis on a real managed stop — the paid stop of project "analysis" from
 * the same seed as N1. The analysis has its own scenario and trace, so what it sends is counted apart from the paid
 * preparation; the reviewer's environment is configured on top of the one the preparation configured.
 */
async function managedPhysicalFixture(t: test.TestContext) {
  const project = "analysis", copy = await paidCopy(project, "omg-spend-physical-");
  const root = copy.root, database = copy.path, series = copy.series;
  let store = copy.store;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const paidPhysical = new Set(store.list("model-call").map(record => record.id));
  const basis = { kind: "series-stop" as const, series: reference(series), attempt: 3 };
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [providerPath, "--scenario", scenario, "--trace", trace] };
  const environment = new Environments(store).configure(project, { workspace: root,
    implementer: { actor: "physical-author", model: "fixture", effort: "high", command },
    reviewer: { actor: "physical-reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 30_000 },
  store.get(`environment:${project}`)?.revision ?? 0);
  const adapter = store.write({ id: `adapter:${project}`, kind: "dispatch-adapter", expected: 0, value: { protocol: "codex-stdio" } });
  const packet = { task: "Analyse this exact stop", basis } as unknown as Json;
  const reviewGoal = { key: "stop-analysis", questions: ["What caused this ground?"], result: "An evidenced cause or an explicit hypothesis" };
  const admitted = deliveredOf(recordCall(store, project, { call: "spend:stop-analysis", purpose: "stop-analysis", basis, block: copy.block,
    gaps: [{ id: "stop-analysis", goal: "stop-analysis", field: "cause", consumer: "A6:stop-analysis" }],
    series: reference(series), attempt: 3, goal: reviewGoal,
    dispatch: { adapter: reference(adapter), config: reference(environment) }, packet }));
  const request: ModelTransportRequest = { project, call: reference(admitted.call), packet, role: "reviewer" };
  function scenarioUsage(usage: unknown) {
    writeFileSync(scenario, JSON.stringify({ steps: [{ research: { cause: "fixture observation", hypothesis: true }, usage }] }));
  }
  scenarioUsage(actualUsage);
  return { root, database, project, series, admitted, request, scenario, trace, scenarioUsage, paidPhysical,
    get store() { return store; }, restart() { store.close(); store = new Store(database); },
    sent() { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; },
    /** The one physical call this analysis made: the model-call record the paid preparation did not leave. */
    dispatch(): Revision<ModelCall> {
      const own = store.list<ModelCall>("model-call").filter(record => !paidPhysical.has(record.id));
      assert.equal(own.length, 1, "the analysis made exactly one physical call");
      return own[0]!;
    } };
}
/** The per-purpose block of the report for `count` settled calls, each at `usage`. */
const spentPurpose = (count: number, usage: Tokens) => ({ calls: count, measuredCalls: count, unmeasuredCalls: 0,
  reportedTokens: tokensOf(...Array.from({ length: count }, () => usage)) });
/**
 * What the regated pass pays before its hold, by its scenario: its native layers are prepared, so the one call sent is
 * the design of the level-3 batch, whose works answer is defected. The expected counts below come from this, not from
 * the rows read.
 */
const REGATED_PAID: Readonly<Record<string, number>> = { "model-design": 1 };
/**
 * LG07 sr-origin (№10753 п.2): the origin analysis of a real standing block hold — the carrier of the accepted LG07 oh-a:
 * the regated run's works answer is defected, so its G5 rejects the attempt and the run waits at the analysis of the
 * hold. What the run paid up to that hold is the preparation: it is checked against the provider's trace and the
 * producer's ledger before the analysis is recorded, and every count of the test is relative to it. The analysis is an
 * E1 of its own and its provider step follows the run's scripted replies, so what it sends is counted apart from the
 * preparation.
 */
async function regatedOriginFixture(t: test.TestContext) {
  const project = "garden", f = runFixture(t, [], "executed");
  deliveredOf(startRun(f.store, { project }));
  const held = await regatedHold(f, {
    cycle: (packet, batch) => batch.task === "node-expansion" && batch.level === 3 ? defectedWork(f, reference(packet)) : null,
    pause: { step: "analyze" },
  });
  const waiting = held.second?.step?.request as { hold: Ref } | undefined;
  assert.ok(waiting, "the regated pass waits at the analysis of its hold");
  const hold = f.store.get<OriginHold>(waiting.hold.id, waiting.hold.revision)!;
  // The preparation as its producers left it: every scripted reply was sent once and is one settled call at its usage.
  const scenario = join(f.root, "scenario.json"), sentBefore = f.sent().length;
  assert.equal((JSON.parse(readFileSync(scenario, "utf8")) as { steps: unknown[] }).steps.length, sentBefore,
    "no scripted reply is left over: the next one is the analysis's own");
  const calls = f.store.get<CallLedger>(callLedgerId(project))!.value.calls;
  assert.equal(calls.length, sentBefore, "every send of the preparation is one recorded call");
  assert.ok(calls.every(row => row.status === "succeeded" && canonical(row.usage) === canonical(actualUsage)));
  const paid: Record<string, number> = {};
  for (const row of calls) paid[row.purpose] = (paid[row.purpose] ?? 0) + 1;
  assert.deepEqual(paid, REGATED_PAID, "the regated pass paid exactly what its scenario sends");
  const basis = { kind: "origin-hold" as const, hold: reference(hold) };
  const packet = { task: "Analyse this exact origin hold", basis } as unknown as Json;
  const reviewGoal = { key: "origin-analysis", questions: ["What caused this ground?"], result: "An evidenced cause or an explicit hypothesis" };
  const admitted = deliveredOf(recordCall(f.store, project, { call: "spend:origin-analysis", purpose: "origin-analysis", basis, block: hold.value.block,
    gaps: [{ id: "origin-analysis", goal: "origin-analysis", field: "cause", consumer: "A6:stop-analysis" }],
    series: hold.value.series, attempt: hold.value.attempt, goal: reviewGoal,
    dispatch: { adapter: reference(f.store.get(`adapter:${project}:run`)!), config: reference(f.store.get(`environment:${project}`)!) }, packet }));
  const request: ModelTransportRequest = { project, call: reference(admitted.call), packet, role: "reviewer" };
  f.push({ research: { cause: "fixture observation", hypothesis: true }, usage: actualUsage });
  return { database: f.database, project, hold, admitted, request, paid: REGATED_PAID, prepared: calls.map(row => row.call),
    get store() { return f.store; }, restart() { f.restart(); },
    sent() { return f.sent().slice(sentBefore); } };
}
/** The physical OM calls of a project as their producer names them — not as the report under test lists them. */
const omPhysical = (store: Store, project: string): Ref[] =>
  store.list("model-call").filter(record => record.id.startsWith(`model-call:${project}:om:`)).map(reference);

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
  test(`E6 ${mode}: only a complete unreceived claim justifies unknown expense`, { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
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
    // LG07 sr-b (№10394 п.5) and sr-origin (№10753 п.2): both analyses run on a real standing block — the stop analysis
    // on the paid managed stop, the origin analysis on the hold of a regated run. What the carrier paid before the
    // analysis comes from its scenario; the row under test is the analysis's own call.
    const f = purpose === "stop-analysis" ? await managedPhysicalFixture(t) : await regatedOriginFixture(t);
    const paid: Readonly<Record<string, number>> = "paidPhysical" in f ? PAID : f.paid;
    const paidCalls = Object.values(paid).reduce((total, count) => total + count, 0);
    assert.equal(paid[purpose], undefined, "the analysis is the first call of its purpose");
    const sent = deliveredOf(await runModelTransport(f.store, f.request));
    const before = canonical(f.store.list()), report = deliveredOf(spendReport(f.store, { project: f.project }));
    assert.equal(report.rows.length, paidCalls + 1);
    const row = report.rows.find(item => item.call?.id === f.admitted.call.id)!;
    assert.equal(row.purpose, purpose);
    assert.deepEqual(row.physical, reference(sent.record));
    assert.deepEqual(row.usage, actualUsage);
    assert.equal(row.settlement, "succeeded");
    assert.equal(row.result, null, "Analysis response is not the completed product attempt's accepted result");
    assert.deepEqual(report.byPurpose[purpose], { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: actualUsage });
    for (const other of Object.keys(paid)) assert.deepEqual(report.byPurpose[other as keyof typeof report.byPurpose],
      "paidPhysical" in f ? paidPurpose(other) : spentPurpose(paid[other]!, actualUsage), other);
    if ("prepared" in f) {
      assert.deepEqual(row.call, reference(f.store.get(f.admitted.call.id)!), "the report names the analysis's settled call record by its exact Ref");
      assert.deepEqual(report.rows.filter(item => item !== row).map(item => canonical(item.call)).sort(), f.prepared.map(canonical).sort(),
        "besides the analysis the report lists exactly the calls the preparation paid");
    }
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
  const f = await managedPhysicalFixture(t);
  f.scenarioUsage(null);
  deliveredOf(await runModelTransport(f.store, f.request));
  const before = canonical(f.store.list()), report = deliveredOf(spendReport(f.store, { project: f.project }));
  const own = report.rows.find(row => row.call?.id === f.admitted.call.id)!;
  assert.equal(own.settlement, "open");
  assert.equal(own.usage, null);
  assert.deepEqual(report.findings.map(item => [item.code, item.at.target]), [["call_not_settled", f.admitted.call.id]]);
  assert.equal(report.totals.unmeasuredCalls, 1);
  assert.equal(report.totals.measuredCalls, PAID_CALLS);
  assert.equal(canonical(f.store.list()), before);
  assert.equal(f.sent().length, 1);
});

test("E6 report: an OM physical call with its E1 record absent is visible as call_without_record", async t => {
  const f = await managedPhysicalFixture(t);
  const sent = deliveredOf(await runModelTransport(f.store, f.request));
  const physical = omPhysical(f.store, f.project);
  assert.equal(physical.length, f.paidPhysical.size + 1);
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
    // LG07 sr-b (№10394 п.3): with every E1 of the project hidden, every real OM physical call of it — the paid ones and
    // this analysis — is one row without its record, with its own addressed finding: none missing and none extra.
    const sort = (refs: Ref[]) => [...refs].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(sort(report.rows.map(row => row.physical!)), sort(physical));
    assert.ok(report.rows.every(row => row.call === null && row.settlement === "missing"));
    assert.ok(report.rows.some(row => canonical(row.physical) === canonical(reference(sent.record))));
    assert.deepEqual(report.findings.map(item => item.code), physical.map(() => "call_without_record"));
    assert.deepEqual(report.findings.map(item => item.at.target).sort(), physical.map(ref => ref.id).sort());
  } finally { lost.close(); }
});

interface PhysicalCheckpoint { pid: number; writes: Write[] }
function driver(t: test.TestContext, f: { readonly root: string; readonly database: string; readonly request: ModelTransportRequest }, checkpoint: string) {
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
  const f = await managedPhysicalFixture(t), checkpoint = join(f.root, "received-before-save.json"), owner = driver(t, f, checkpoint);
  const pending = await physicalCheckpoint(checkpoint, owner.child);
  assert.equal(pending.pid, owner.child.pid);
  assert.equal(f.sent().length, 1);
  const exchange = pending.writes.find(write => write.kind === "om-model-exchange")!.value as { process: ProcessResult; launchError: null };
  const evidence = { process: exchange.process, launchError: exchange.launchError };
  assert.deepEqual(JSON.parse(evidence.process.stdout).usage, actualUsage);
  const dispatch = f.dispatch();
  assert.equal(owner.child.kill("SIGKILL"), true);
  await owner.exit;
  const recovered = new ProductEngine(f.store).execute({ type: "recover-model-call", project: f.project, call: reference(dispatch) }) as Revision<ModelCall>;
  assert.equal(recovered.value.usage, null);
  const late = prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence);
  deliveredOf(writeGuarded(f.store, { unit: "E4", target: dispatch.id, writes: late.writes, guards: late.guards }));
  deliveredOf(await runModelTransport(f.store, f.request));
  const before = canonical(f.store.list()), report = deliveredOf(spendReport(f.store, { project: f.project }));
  const own = report.rows.find(row => row.call?.id === f.admitted.call.id)!;
  assert.deepEqual(own.usage, actualUsage);
  assert.equal(own.settlement, "failed");
  assert.deepEqual(report.totals.reportedTokens, tokensOf(paidTokens(PAID_CALLS), actualUsage));
  assert.equal(report.totals.calls, PAID_CALLS + 1);
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
  const f = await managedPhysicalFixture(t), checkpoint = join(f.root, "recovery-time.json"), owner = driver(t, f, checkpoint);
  await physicalCheckpoint(checkpoint, owner.child);
  const dispatch = f.dispatch();
  assert.equal(owner.child.kill("SIGKILL"), true);
  await owner.exit;
  const recovered = new ProductEngine(f.store).execute({
    type: "recover-model-call", project: f.project, call: reference(dispatch),
  }) as Revision<ModelCall>;
  const baseline = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.equal(baseline.rows.find(row => row.call?.id === f.admitted.call.id)!.usage, null);
  assert.deepEqual(baseline.findings.map(row => [row.code, row.at.target]), [["call_not_settled", f.admitted.call.id]]);
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
      // LG07 sr-b (№10394 п.4): only the reference of the changed call is replaced; every other physical call, series and
      // late entry of the complete snapshot stays, so the refusal cannot come from an incomplete cut.
      const snapshot = { ...baseline.snapshot, calls: baseline.snapshot.calls.map(ref => ref.id === recovered.id ? physical : ref),
        late: baseline.snapshot.late.map(item => item.call.id === recovered.id ? { call: physical, receipt: null } : item) } as SpendSnapshot;
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

test("E6 report: a real D7 package counts one obligation shared by two accepted consumers once", async t => {
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
  prepareNativeLayers(engine, project, desired, "n2");
  const graph = store.get<Graph>(`graph:${project}`)!, layer = store.get(`graph-layer:${project}:2`)!;
  const upperFrame = reference(store.get(`om-frame:${project}:2`)!);
  const first = store.get(`om-input:${project}`)!;
  const input = deliveredOf(writeAddressing(store, { project, input: reference(first), graph: reference(graph), decisions: [{
    pending: inputDecisionWrite({ project, input: reference(first), graph: reference(graph), layers: [reference(layer)],
      decision: { target: "discovery:late-proof", field: "address", value: { consumer, kind: "post-implementation-proof" } } }) as Write,
  }] }));
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph),
    refinement: reference(layer), available: {},
    choice: { choiceVersion: "spend-d7", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: reference(layer), frame: upperFrame, upper: null } },
    works: { proposals: [], frame: { project, level: 3, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: upperFrame } } } };
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
  // LG07 sr-c (№10394 п.6): the packages are direct stop analyses of a real block stop — three managed attempts on the
  // input-field MC2 batch these same D1 routes address to the consuming block, each paid by the implementer's answer off
  // its form and closed by G7. (A node-expansion batch of the producing block cannot end without a result here: its
  // work stays incomplete until the common acceptance of its level, which this fixture does not run.) The block
  // semantics of the packages stay: gap.target and the two block consumers they declare.
  const block = "garden-consume-block", address = { project, block, line: 1 };
  const routes = deliveredOf(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(item => item.model === "MC2" && item.task === "input-field"
    && item.items.every(member => canonical(member.consumers) === canonical([block])))!;
  assert.ok(batch, "The same D1 routes hold an input-field MC2 batch of the consuming block");
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl"), steps: unknown[] = [];
  const paidCommand = { executable: process.execPath, args: [providerPath, "--scenario", scenario, "--trace", trace] };
  const paidEnvironment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "assignment-researcher", model: "fixture", effort: "high", command: paidCommand },
    reviewer: { actor: "assignment-reviewer", model: "fixture", effort: "high", command: paidCommand },
    fullCheck: command, timeoutMs: 10_000, requestCapacityChars: 100_000 }, environment.revision);
  const adapter = store.write({ id: `adapter:${project}:spend`, kind: "dispatch-adapter", expected: 0, value: { protocol: "codex-stdio" } });
  const attemptGoal: AttemptGoal = { key: "shared-result-proof", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)).sort(),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  deliveredOf(openSeries(store, { ...address, slice: "spend-d7", predecessor: null, basis: null }));
  for (const attempt of [1, 2, 3]) {
    const opened = deliveredOf(openAttempt(store, { ...address, attempt, goal: attemptGoal,
      completion: { routes: reference(routes), batches: [batch.id] } }));
    const packet = deliveredOf(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
      environment: reference(paidEnvironment), attempt: { series: reference(opened), ordinal: attempt }, previous: [] })).record;
    steps.push({ research: {}, usage: actualUsage });
    writeFileSync(scenario, JSON.stringify({ database, steps }));
    deliveredOf(await runModelCall(store, { project, packet: reference(packet),
      dispatch: { adapter: reference(adapter), config: reference(paidEnvironment) }, role: "implementer" }));
    const claim = deliveredOf(prepareManagedClaim(store, { ...address, attempt,
      outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } })).outcome;
    deliveredOf(closeAttempt(store, { ...address, attempt, outcome: claim }));
  }
  const stopped = store.get<RepairSeries>(seriesId(project, block, 1))!;
  assert.deepEqual(stopped.value.stop?.attempts, [1, 2, 3]);
  // What the stop cost by its scenario: three paid calls at actualUsage.
  const paidCalls = 3, paidUsage = tokensOf(actualUsage, actualUsage, actualUsage);
  assert.equal(deliveredOf(readCallLedger(store, project))!.value.calls.length, paidCalls);
  const analysis = (call: string, gaps: RecordCallRequest["gaps"], packet: Json): RecordCallRequest => ({ call, purpose: "stop-analysis",
    basis: { kind: "series-stop", series: reference(stopped), attempt: 3 }, block, gaps, series: reference(stopped), attempt: 3,
    goal: { key: "analysis:shared-result-proof", questions: [gap.value.gap.target], result: "An assigned proof for both consumers" },
    dispatch: { adapter: reference(adapter), config: reference(paidEnvironment) }, packet });
  const questions = gap.value.gap.consumers.map(block => ({ id: gap.value.gap.target, goal: gap.value.gap.target,
    field: gap.value.gap.field, consumer: block }));
  const admitted = deliveredOf(recordCall(store, project, analysis("shared-proof-package", questions,
    { question: gap.value.gap.target, consumers: gap.value.gap.consumers, obligations: { ...reference(obligations.record) } })));
  const paid = deliveredOf(settleCall(store, reference(admitted.call), actualUsage, "succeeded"));
  const report = deliveredOf(spendReport(store, { project,
    significance: [{ call: reference(paid.call), gaps: gapRead, obligations: reference(obligations.record) }] }));
  assert.equal(report.rows.length, paidCalls + 1);
  const own = report.rows.find(row => row.call?.id === paid.call.id)!;
  assert.deepEqual(own.questions, paid.call.value.gaps);
  assert.equal(own.questions.length, 2);
  assert.equal(own.significance.obligations, 1);
  assert.equal(own.significance.consumers, 2);
  assert.equal(own.significance.blocks, 2);
  assert.ok(own.significance.sources.some(ref => canonical(ref) === canonical(reference(obligations.record))));
  assert.ok(own.significance.sources.some(ref => canonical(ref) === canonical(reference(obligations.producer))));
  assert.deepEqual(report.totals, { calls: paidCalls + 1, measuredCalls: paidCalls + 1, unmeasuredCalls: 0, reportedTokens: tokensOf(paidUsage, actualUsage) });
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
    const recorded = deliveredOf(recordCall(store, project, analysis(item.call, item.gaps, { questions: item.gaps })));
    return { ...item, call: reference(deliveredOf(settleCall(store, reference(recorded.call), zeroUsage, "succeeded")).call) };
  });
  const combined = deliveredOf(spendReport(store, { project,
    significance: [reference(paid.call), ...extraCalls.map(item => item.call)].map(call => ({ call, gaps: gapRead, obligations: reference(obligations.record) })) }));
  for (const extra of extraCalls) assert.equal(combined.rows.find(row => row.call?.id === extra.call.id)!.significance.obligations, extra.count,
    "An empty selected D7 subset cannot erase a frame obligation, and two consumer bindings add only one D7 obligation");
  assert.deepEqual(combined.totals.reportedTokens, tokensOf(paidUsage, actualUsage, zeroUsage, zeroUsage),
    "Three packages retain three expenses, including two explicit zeros, beside the paid stop");
  store.close();
  const reopened = new ExactOnlyStore(database);
  try {
    assert.deepEqual(deliveredOf(readSpendReport(reopened, report.snapshot)), report);
    assert.deepEqual(deliveredOf(readSpendReport(reopened, combined.snapshot)), combined);
  }
  finally { reopened.close(); }
});

test("E6 report: a native accepted answer contributes only its provider-confirmed result after completion and restart", async t => {
  // LG07 sr-c (№10394 п.6): a managed attempt on its own MC1 E2. Its paid work ends off its form — a technical E4 — and
  // its result is the native accepted answer, which G7 confirms through the answer's own provider beside that work, as
  // for the native D5 of om-repeat-gate (:3858). The native assessment stays outside OM/E1.
  const f = ordinarySpendFixture(t, true), engine = new ProductEngine(f.store), project = f.project, block = f.address.block;
  const root = dirname(f.database), target = "discovery:encoding";
  const gap = f.gaps.records.find(record => record.value.gap.target === target)!;
  assert.equal(gap.value.gap.kind, "repository-fact");
  const gapRead = { sources: structuredClone(f.gaps.sources) as GapRequest, records: f.gaps.records.map(reference) };
  type AddressedInput = Extract<ReturnType<typeof writeAddressing>, { ok: true }>["value"];
  const input = f.store.get(gapRead.sources.input.id, gapRead.sources.input.revision) as unknown as AddressedInput;
  f.steps([{ research: {}, usage: actualUsage }]);
  const paid = deliveredOf(await runModelCall(f.store, f.request));
  assert.notEqual(paid.outcome?.kind, "fact-candidates", "the paid answer is off its form");
  const command = { executable: process.execPath, args: ["-e",
    "const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));"] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "fact-researcher", model: "fixture", effort: "high", command },
    reviewer: { actor: "fact-assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000 }, f.store.get(`environment:${project}`)!.revision);
  writeFileSync(join(root, "answer.json"), JSON.stringify({ answer: "UTF-8" }));
  const source = engine.discovery.evidence.file(project, "encoding-answer", root, "answer.json", "application/json", 0);
  const contract: AnswerQuestionContract = { establishes: input.value.input.questions[0]!.question,
    consumer: { blocks: [...gap.value.gap.consumers] }, requirements: [structuredClone(input.value.input.contracts[0]!) as unknown as Json], resultForm: { type: "string" } };
  const draft = engine.discovery.create(project, "om-g2", "R1", block,
    [mc1FieldSpec({ input: reference(input), gap: reference(gap), contract })], [reference(input), reference(gap)]);
  const issued = f.store.get<Question>(draft.value.questions[0]!)!;
  const question = deliveredOf(writeMc1Question(f.store, { project, input: reference(input), gaps: gapRead,
    gap: reference(gap), contract, requirements: [{ pointer: "/contracts/0" }], engineQuestion: reference(issued), draft: reference(draft) }));
  const assessed = await assessAnswer(f.store, issued, { action: "answer", question: issued.id, value: "UTF-8",
    citations: [{ source: reference(source), selector: { kind: "json-pointer", pointer: "/answer" } }] }, environment, root);
  const answeredDraft = engine.discovery.researched(issued.id, issued.revision, reference(assessed)), answered = f.store.get<Question>(issued.id)!;
  const accepted = deliveredOf(writeAcceptedAnswer(f.store, { project, question: reference(question), answer: answered.value.answer!,
    answeredQuestion: reference(answered), draft: reference(answeredDraft), attempt: { series: reference(f.series), attempt: 1 } }));
  const confirmed = deliveredOf(confirmResults(f.store, { project, block, target: f.series.id, goal: f.goal,
    accepting: [reference(accepted)], cancelling: [] }));
  assert.equal(confirmed.achieved.length, 1);
  // G7 derives the claim of the attempt's own work and adds the one independent result of this step.
  const at = { ...f.address, attempt: 1 };
  const claim = deliveredOf(prepareManagedClaim(f.store, { ...at,
    outcome: { reason: "result", accepting: [reference(accepted)], cancelling: [], refusals: [] } })).outcome;
  deliveredOf(closeAttempt(f.store, { ...at, outcome: claim }));
  const completed = f.store.get(f.series.id)!;
  const report = deliveredOf(spendReport(f.store, { project }));
  const row = report.rows.find(item => item.call?.id === paid.call.id)!;
  assert.deepEqual(row.result, { series: reference(completed), attempt: 1, verdict: "progress", achieved: confirmed.achieved });
  assert.equal(report.rows.length, 1, "Native assessment transport is outside OM/E1 expense scope");
  assert.deepEqual(report.snapshot.calls, omPhysical(f.store, project), "Only the attempt's own E4 is an OM physical model-call");
  assert.ok(f.store.list<ModelCall>("model-call").some(record => !record.id.startsWith(`model-call:${project}:om:`)), "The result was assessed through the real native call producer");
  f.store.close();
  const reopened = new ExactOnlyStore(f.database);
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
function ordinarySpendFixture(t: test.TestContext, managed = false) {
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
  // LG07 sr-b (№10394 п.5): a migrated test opens the attempt with the complete plan of its own MC1 batch; the NR1
  // tests keep the earlier opening until their own migration.
  const series = deliveredOf(managed
    ? openAttempt(store, { ...address, attempt: 1, goal, completion: { routes: reference(routes), batches: [batch.id] } })
    : beginAttempt(store, { ...address, attempt: 1, goal }));
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal: 1 }, previous: [] };
  const packet = deliveredOf(writeQuestionPacket(store, packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: "implementer" };
  return { database, store, project, source, routes, gaps, batch, packet, request, address, goal, series, environment,
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ database: store.path, steps })); } };
}

test("E6 report: one assessed fact has its own physical expense beside the original MC1 call", async t => {
  const f = ordinarySpendFixture(t, true);
  const assessmentUsage = { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 };
  f.steps([{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: [{ questionId: f.batch.items[0]!.gap, value: "UTF-8",
      citations: [{ source: reference(f.source), selector: { kind: "text-range", start: 0, end: f.source.value.content.length } }] }] },
    usage: actualUsage }, { research: { verdict: "supported" }, usage: assessmentUsage }]);
  const original = deliveredOf(await runModelCall(f.store, f.request));
  assert.equal(original.outcome?.kind, "fact-candidates");
  if (original.outcome?.kind !== "fact-candidates") assert.fail("The MC1 fixture must produce a checked fact");
  const fact = original.outcome.facts[0]!;
  const intent = deliveredOf(writeAssessmentIntent(f.store, { project: f.project,
    modelCall: reference(original.record), questionId: fact.questionId, dispatch: f.request.dispatch }));
  const admission = deliveredOf(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const packet = admission.packet as unknown as Json;
  const admitted = deliveredOf(recordCall(f.store, f.project, {
    call: admission.call, purpose: "fact-assessment", basis: admission.basis, block: admission.block,
    gaps: admission.gaps, series: admission.series, attempt: admission.attempt,
    goal: admission.goal, dispatch: admission.dispatch, packet }));
  const assessed = deliveredOf(await runModelTransport(f.store, {
    project: f.project, call: reference(admitted.call), packet, role: "reviewer",
  }));
  const stored = canonical(f.store.list());
  const report = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.equal(report.snapshot.purposeSet, SPEND_PURPOSE_SET_V2);
  assert.equal(report.rows.length, 2);
  const assessment = report.rows.find(row => row.purpose === "fact-assessment")!;
  assert.deepEqual(assessment.physical, reference(assessed.record));
  assert.deepEqual(assessment.usage, assessmentUsage);
  assert.equal(assessment.settlement, "succeeded");
  assert.deepEqual(report.byPurpose["fact-assessment"],
    { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: assessmentUsage });
  assert.deepEqual(report.byPurpose["model-research"],
    { calls: 1, measuredCalls: 1, unmeasuredCalls: 0, reportedTokens: actualUsage });
  assert.deepEqual(report.totals.reportedTokens,
    { inputTokens: 131, outputTokens: 33, cachedInputTokens: 22, reasoningOutputTokens: 11 });
  assert.deepEqual(report.findings, []);
  assert.equal(canonical(f.store.list()), stored);
  const unmarked = { ...report.snapshot } as Record<string, unknown>;
  delete unmarked.purposeSet;
  assert.throws(() => readSpendReport(f.store, unmarked as unknown as SpendSnapshot),
    error => error instanceof EngineError && error.code === "spend_request_invalid");
  const historical = new ExactOnlyStore(f.database);
  try { assert.deepEqual(deliveredOf(readSpendReport(historical, report.snapshot)), report); }
  finally { historical.close(); }
});

test("E6 ordinary E4: packet significance and exact physical expense survive later application heads", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  for (const action of ["answer", "cannot_answer"] as const) await t.test(action, async nested => {
    const f = ordinarySpendFixture(nested);
    const research = action === "answer"
      ? { protocol: "$answerProtocol", requestId: "$requestId", action,
        results: [{ questionId: f.batch.items[0]!.gap, value: "UTF-8",
          citations: [{ source: reference(f.source), selector: { kind: "text-range", start: 0, end: f.source.value.content.length } }] }] }
      : { protocol: "$answerProtocol", requestId: "$requestId", action,
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

test("E6 report: recomputed E1 and ledger hashes do not let another block claim a series", async t => {
  const f = await spendStop(t);
  const admitted = deliveredOf(recordCall(f.store, PROJECT, analysisRequest(f, "wrong-owner")));
  const saved = deliveredOf(spendReport(f.store, { project: PROJECT }));
  const changedCall = { ...admitted.call, value: { ...admitted.call.value, block: "other-block" } };
  changedCall.hash = hashJson(changedCall.value);
  const changedLedger: Revision<CallLedger> = { ...admitted.ledger, value: {
    ...admitted.ledger.value,
    // LG07 sr-a (№10394 п.1): only the selected E1 and its row change; the paid rows stay exactly as they were.
    calls: admitted.ledger.value.calls.map(row => {
      if (row.call.id !== admitted.call.id) return row;
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
  const f = await managedPhysicalFixture(t), checkpoint = join(f.root, "receipt-race.json"), owner = driver(t, f, checkpoint);
  const pending = await physicalCheckpoint(checkpoint, owner.child);
  assert.equal(pending.pid, owner.child.pid);
  const exchange = pending.writes.find(write => write.kind === "om-model-exchange")!.value as {
    process: ProcessResult; launchError: null;
  };
  const evidence = { process: exchange.process, launchError: exchange.launchError };
  assert.deepEqual(JSON.parse(evidence.process.stdout).usage, actualUsage);
  const dispatch = f.dispatch();
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
  assert.equal(beforeReceipt.rows.find(row => row.call?.id === f.admitted.call.id)!.usage, null);
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
    assert.equal(retried.rows.length, PAID_CALLS + 1);
    const own = retried.rows.find(row => row.call?.id === f.admitted.call.id)!;
    assert.deepEqual(own.usage, actualUsage);
    assert.equal(own.settlement, "open");
    assert.deepEqual(retried.findings.map(row => [row.code, row.at.target]), [["call_not_settled", f.admitted.call.id]]);
    assert.deepEqual(retried.snapshot.late, [{ call: reference(recovered), receipt: reference(late.record) }]);
    assert.deepEqual(retried.totals, { calls: PAID_CALLS + 1, measuredCalls: PAID_CALLS + 1, unmeasuredCalls: 0,
      reportedTokens: tokensOf(paidTokens(PAID_CALLS), actualUsage) });
    assert.equal(canonical(f.store.list().flatMap(row => f.store.history(row.id))), beforeRetry);
    assert.equal(f.sent().length, 1, "The reader neither retries the model nor settles the E1 call");
  } finally { racing.close(); writer.close(); }
});

async function assertE6R2RecoveredEvidence(
  t: test.TestContext,
  f: Awaited<ReturnType<typeof managedPhysicalFixture>>,
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
    purposeSet: SPEND_PURPOSE_SET_V2,
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
  // LG07 sr-b (№10394 п.3): with every E1 of the project hidden, the CURRENT report lists every real OM physical call of
  // it as an orphan — the paid ones and the recovered analysis — exactly; the exact historical cut of the one recovered
  // call stays a separate lawful slice with exactly one row (assertOrphan).
  const physical = omPhysical(f.store, f.project), sort = (refs: readonly Ref[]) => [...refs].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(physical.length, f.paidPhysical.size + 1);
  assert.ok(physical.some(ref => canonical(ref) === canonical(recoveredRef)));
  const assertCurrentOrphans = (report: ReturnType<typeof spendReport>): void => {
    const value = deliveredOf(report);
    assert.deepEqual(sort(value.rows.map(row => row.physical!)), sort(physical));
    assert.ok(value.rows.every(row => row.call === null && row.settlement === "missing" && row.usage === null && row.result === null));
    assert.deepEqual(value.findings.map(row => row.code), physical.map(() => "call_without_record"));
    assert.deepEqual(value.findings.map(row => row.at.target).sort(), physical.map(ref => ref.id).sort());
    assert.deepEqual(value.totals, { calls: physical.length, measuredCalls: 0, unmeasuredCalls: physical.length, reportedTokens: null });
  };

  await t.test("orphan recovery accepts explicit absent and actual late sources without inventing expense", () => {
    for (const missingReceipt of [false, true]) {
      const current = new OrphanStore(f.database);
      current.hideReceipt = missingReceipt;
      try {
        const report = spendReport(current, { project: f.project });
        assertCurrentOrphans(report);
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
        // LG07 sr-b (№10394 п.4): only the forged call is replaced in the complete snapshot.
        const historical = spendRefused(readSpendReport(exact, {
          ...baseline.snapshot, calls: baseline.snapshot.calls.map(ref => ref.id === recovered.id ? reference(forgedTerminal) : ref),
          late: baseline.snapshot.late.map(item => item.call.id === recovered.id ? { call: reference(forgedTerminal), receipt: null } : item),
        }), "model_call_record_invalid");
        assert.equal(historical.at.target, dispatch.id);
        assert.equal(historical.at.field, "usage");
      } finally { current.close(); exact.close(); }
    } finally { rewrite([dispatch, incident, recovered, late.record]); }
    assert.equal(allBytes(), originalBytes);
  });
  assert.equal(f.sent().length, 1, "All recovery-source regressions reuse the single genuine dispatch");
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, storeReads, type Revision } from "../src/storage/store.js";
import { hashJson } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { uniqueTransactionGuards, Environments } from "../src/runtime/environment.js";
import type { Environment, RoleBinding } from "../src/runtime/environment.js";
import { Discovery } from "../src/discovery/discovery.js";
import { ProductEngine } from "../src/product/engine.js";
import { preparedFeatures } from "./product-fixture.js";
import { pilotContext } from "../src/discovery/pilot-context.js";
import { Session as InspectorSession } from "node:inspector/promises";
import {
  readResearchConsumerIntent, researchConsumerIntentId, prepareResearchConsumerIntent,
  prepareResearchConsumerReservation, consumerCapacityFailure,
  type ResearchConsumerIntent,
} from "../src/discovery/response-recovery.js";
import { retryPlannedRead } from "../src/discovery/reading-plan.js";
import { Researcher } from "../src/discovery/research-runner.js";
import { RESULT_CAPACITY } from "../src/discovery/early-research-outcome.js";

/**
 * G5a (№6218, редакция 2 по №6200): the saved research-consumer-intent is a
 * commit — its transitions, capacity and generation chain are proved once by
 * the producer writing each revision. The reader trusts the exact saved row:
 * kind, exact Ref, producer address and field shape — one physical read, never
 * O(revisions × generations), never a capacity recompute. Producers that used
 * to rely on the reader's replay now prove the new transition before writing.
 */

const ref = (id: string, revision = 1): Ref => ({ id, revision, hash: hashJson([id, revision]) });

function intent(over: Partial<ResearchConsumerIntent> = {}, cursor: Record<string, unknown> = {}): ResearchConsumerIntent {
  const owner = ref("research-run:r"), draft = ref("discovery-draft:d"), question = ref("question:q");
  const value = {
    contract: "research-consumer-intent/v1" as const, projectId: "p", kind: "analyst" as const,
    key: "k", rootKey: "k", generation: 0, previous: null, owner, draft, question,
    role: { actor: "a", model: "m", effort: "e", command: { executable: "x", args: [] } } as RoleBinding,
    dispatch: { projectId: "p" } as unknown as Environment, profile: null,
    cursor: { run: owner.id, turn: 1, context: {}, prompt: "p" },
    basis: [], guards: uniqueTransactionGuards([owner, draft, question]),
    state: "prepared" as const, call: null, request: null, archive: null, outputs: null, refusal: null };
  value.cursor = { ...value.cursor, ...cursor };
  return { ...value, ...over };
}

const writeIntent = (store: Store, value: ResearchConsumerIntent, expected: number) =>
  store.writeMany<ResearchConsumerIntent>([{ id: researchConsumerIntentId(value.projectId, value.kind,
    value.key, value.generation), kind: "research-consumer-intent", expected, value }])[0]!;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-g5a-intent-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

test("G5a: reading a saved intent is one physical read — N revisions and K generations add nothing", (t) => {
  const store = fixture(t);
  // Three generations, each with its own short revision chain.
  const heads: Revision<ResearchConsumerIntent>[] = [];
  for (let generation = 0; generation < 3; generation += 1) {
    const value = intent({ generation, previous: generation ? reference(heads.at(-1)!) : null });
    let head = writeIntent(store, value, 0);
    for (let revision = 2; revision <= generation + 2; revision += 1)
      head = writeIntent(store, value, revision - 1);
    heads.push(head);
  }
  for (const head of heads) {
    const before = storeReads();
    const read = readResearchConsumerIntent(store, reference(head));
    assert.deepEqual(read.value, head.value);
    assert.equal(storeReads() - before, 1, "an exact trusted read is one get — no revision or generation walk");
  }
  // Ten times the history: the count is still one read per intent.
  const value = intent({ generation: 3, previous: reference(heads.at(-1)!) });
  let head = writeIntent(store, value, 0);
  for (let revision = 2; revision <= 30; revision += 1) head = writeIntent(store, value, revision - 1);
  const before = storeReads();
  assert.deepEqual(readResearchConsumerIntent(store, reference(head)).value, head.value);
  assert.equal(storeReads() - before, 1);
});

test("G5a: the cheap contract still refuses missing rows, foreign kinds and stale refs", (t) => {
  const store = fixture(t);
  const head = writeIntent(store, intent(), 0);
  // A missing row is a typed refusal, not a silent pass.
  assert.throws(() => readResearchConsumerIntent(store, ref("research-consumer-intent:v1:nope")),
    { code: "research_consumer_intent_invalid" });
  // A foreign kind at the exact address is not an intent.
  const [note] = store.writeMany([{ id: "note:x", kind: "note", expected: 0, value: { text: "x" } }]);
  assert.throws(() => readResearchConsumerIntent(store, reference(note!)),
    { code: "research_consumer_intent_invalid" });
  // A stale ref (right id, wrong hash) does not read the current row.
  assert.throws(() => readResearchConsumerIntent(store,
    { id: head.id, revision: head.revision, hash: hashJson(["other"]) }),
    { code: "research_consumer_intent_invalid" });
  // A row whose body lost a producer field fails the shape check.
  const broken = { ...intent() } as Record<string, unknown>;
  delete broken.refusal;
  store.writeMany([{ id: researchConsumerIntentId("p", "analyst", "broken", 0),
    kind: "research-consumer-intent", expected: 0, value: broken }]);
  const saved = store.get(researchConsumerIntentId("p", "analyst", "broken", 0))!;
  assert.throws(() => readResearchConsumerIntent(store, reference(saved)),
    { code: "research_consumer_intent_invalid" });
  // A row at the wrong deterministic address refuses its producer proof.
  const alien = intent({ key: "alien", rootKey: "alien" });
  store.writeMany([{ id: "research-consumer-intent:v1:manual", kind: "research-consumer-intent",
    expected: 0, value: alien }]);
  const manual = store.get("research-consumer-intent:v1:manual")!;
  assert.throws(() => readResearchConsumerIntent(store, reference(manual)),
    { code: "research_consumer_intent_invalid" });
});

test("G5a: capacity and outcome records are trusted — no draft/question reads, no minimum, no execution walk", (t) => {
  const store = fixture(t);
  // The capacity declaration and every physical reference name rows that are
  // not even in this store: a recomputing reader would have to fetch them all.
  const prepared = writeIntent(store, intent({ generation: 0 }, {
    resultCapacityContract: RESULT_CAPACITY, resultCapacity: { contract: RESULT_CAPACITY, declared: true } }), 0);
  const before = storeReads();
  assert.equal(readResearchConsumerIntent(store, reference(prepared)).value.cursor.resultCapacityContract,
    RESULT_CAPACITY);
  assert.equal(storeReads() - before, 1);
  const applied = writeIntent(store, intent({ generation: 1, previous: reference(prepared), state: "applied",
    call: ref("model-call:c"), request: ref("request-manifest:c"), archive: ref("archive:c"),
    outputs: [ref("research-turn:t")] }), 0);
  const beforeApplied = storeReads();
  assert.equal(readResearchConsumerIntent(store, reference(applied)).value.state, "applied");
  assert.equal(storeReads() - beforeApplied, 1, "the applied output existence was the application's proof");
  const refused = writeIntent(store, intent({ generation: 2, previous: reference(applied), state: "refused",
    call: ref("model-call:c"), request: ref("request-manifest:c"), archive: ref("archive:c"),
    refusal: { kind: "provider-failed", code: "provider_failed", call: ref("model-call:c"),
      request: ref("request-manifest:c"), response: null, archive: ref("archive:c") } }), 0);
  const beforeRefused = storeReads();
  assert.equal(readResearchConsumerIntent(store, reference(refused)).value.refusal?.code, "provider_failed");
  assert.equal(storeReads() - beforeRefused, 1, "the refusal proof was the producer's, not the reader's");
  // A repeat of the paid read is again one read.
  const beforeAgain = storeReads();
  readResearchConsumerIntent(store, reference(refused));
  assert.equal(storeReads() - beforeAgain, 1);
});

/** A reading-plan fixture: paused run → plan turn → failed child, and a
 * prepared reader intent bound to the child's pending revision. */
function c23Fixture(t: test.TestContext, childAction: unknown, headAction: unknown) {
  const root = mkdtempSync(join(tmpdir(), "omg-g5a-c23-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const [draft] = store.writeMany([{ id: "discovery-draft:d", kind: "discovery-draft", expected: 0,
    value: { projectId: "p", stage: "discovery", questions: ["question:q"], inputs: [] } }]);
  const [question] = store.writeMany([{ id: "question:q", kind: "question", expected: 0,
    value: { projectId: "p", draftId: draft!.id, status: "open" } }]);
  const [run] = store.writeMany([{ id: "research-run:r", kind: "research-run", expected: 0,
    value: { projectId: "p", draftId: draft!.id, status: "paused", turns: 2, inputs: [] } }]);
  const [parent] = store.writeMany([{ id: "research-turn:plan", kind: "research-turn", expected: 0,
    value: { run: run!.id, number: 1, question: reference(question!), plannedBy: null, dispatchMode: "planning",
      action: { action: "read_plan", question: question!.id, reads: [headAction] },
      status: "completed", error: null, observation: null } }]);
  const childPending = { run: run!.id, number: 2, question: reference(question!), plannedBy: reference(parent!),
    dispatchMode: "planning", action: childAction, status: "pending", error: null, observation: null };
  const [pending] = store.writeMany([
    { id: "research-turn:c", kind: "research-turn", expected: 0, value: childPending }]);
  const [failed] = store.writeMany([{ id: "research-turn:c", kind: "research-turn", expected: 1,
    value: { ...childPending, status: "completed", error: "provider_failed", action: headAction } }]);
  const bound = reference(pending!);
  const reader = intent({ kind: "reader", owner: bound, draft: reference(draft!), question: reference(question!),
    guards: uniqueTransactionGuards([bound, reference(draft!), reference(question!)]) }, {
    rootKey: "rk", rootSourceOrder: [{ sourceIndex: 0, source: ref("source:s"), window: { start: 0, end: 1 } }],
    sourceOrder: [{ sourceIndex: 0, source: ref("source:s"), window: { start: 0, end: 1 } }],
    reusedFrom: [], child: [0], consumer: { run: reference(run!), turn: bound } });
  writeIntent(store, reader, 0);
  return { store, run: run!, question: question!, child: failed!, bound,
    readerId: researchConsumerIntentId("p", "reader", "k", 0) };
}

test("G5a: the C23 writer rebinds an unclaimed reader through the proved pending chain", (t) => {
  const { store, child, bound, readerId } = c23Fixture(t, { action: "read", path: "a" }, { action: "read", path: "a" });
  const failed = reference(child);
  retryPlannedRead(store, "p", failed);
  const retried = store.get<Record<string, any>>("research-turn:c")!;
  assert.equal(retried.revision, 3);
  assert.equal(retried.value.status, "pending");
  assert.deepEqual(retried.value.replayedFrom, failed);
  const rebound = store.get<any>(readerId)!;
  assert.equal(rebound.revision, 2, "the reader intent moved to the retried child");
  assert.deepEqual(rebound.value.cursor.consumer.turn, reference(retried));
  assert.deepEqual(rebound.value.owner, reference(retried));
  assert.notDeepEqual(rebound.value.cursor.consumer.turn, bound);
});

test("G5a: a rebound whose owner is not the bound turn is refused before any write", (t) => {
  const { store, child, readerId } = c23Fixture(t, { action: "read", path: "a" }, { action: "read", path: "a" });
  const head = store.get<any>(readerId)!;
  store.writeMany([{ id: readerId, kind: "research-consumer-intent", expected: head.revision,
    value: { ...head.value, owner: ref("research-run:r") } }]);
  assert.throws(() => retryPlannedRead(store, "p", reference(child)),
    { code: "reading_plan_recovery_invalid" });
  assert.equal(store.get("research-turn:c")!.revision, 2, "the child was not retried");
  assert.equal(store.get(readerId)!.revision, 2, "the reader intent was not re-bound");
});

test("G5a: a rebound across a changed pending basis is refused before any write", (t) => {
  // The pending revision carries one action and the failed head another —
  // the bound pending revision cannot reach the retried one.
  const { store, child, readerId } = c23Fixture(t, { action: "read", path: "a" }, { action: "read", path: "b" });
  assert.throws(() => retryPlannedRead(store, "p", reference(child)),
    { code: "reading_plan_recovery_invalid" });
  assert.equal(store.get("research-turn:c")!.revision, 2, "the child was not retried");
  assert.equal(store.get(readerId)!.revision, 1, "the reader intent was not re-bound");
});

/** A synthesis delivery fixture: an applied intent over a saved session;
 * `extraPrepared` places the applied head past revision 3. */
function handoffFixture(t: test.TestContext, extraPrepared = false) {
  const store = fixture(t);
  const action = { action: "deliver", note: "x" };
  const [session] = store.writeMany([{ id: "synthesis-session:s", kind: "synthesis-session", expected: 0,
    value: { projectId: "p", result: action, delivered: null } }]);
  const [run] = store.writeMany([{ id: "research-run:r", kind: "research-run", expected: 0,
    value: { projectId: "p", draftId: "discovery-draft:d", status: "running", turns: 5, inputs: [] } }]);
  const base = intent({ kind: "synthesis", owner: reference(session!), draft: ref("discovery-draft:d"),
    guards: uniqueTransactionGuards([reference(session!), ref("discovery-draft:d"), ref("question:q")]) },
    { run: session!.id, sessionId: session!.id, offset: 0, materialEncoding: null,
      delivery: { run: run!.id, turn: 5 } });
  const call = ref("model-call:c"), request = ref("request-manifest:c"), archive = ref("archive:c");
  const running = { ...base, state: "running" as const, call, request, archive };
  const applied = { ...running, state: "applied" as const, outputs: [reference(session!)] };
  let head = writeIntent(store, base, 0);
  if (extraPrepared) head = writeIntent(store, base, 1);
  head = writeIntent(store, running, head.revision);
  head = writeIntent(store, applied, head.revision);
  return { store, session: session!, run: run!, intent: head, action };
}

const handoff = (store: Store) => new Researcher(store, new Discovery(store), new Environments(store)) as
  unknown as { handoffSynthesis(intent: Revision<ResearchConsumerIntent>, run: Revision<never>,
    action: unknown, owner: unknown, guards?: Ref[]): unknown };

test("G5a: the delivery-turn append is the producer's once-only proof", (t) => {
  const { store, run, intent, action, session } = handoffFixture(t);
  const before = storeReads();
  handoff(store).handoffSynthesis(intent, run as Revision<never>, action, { pid: 1, started: "t" });
  assert.ok(storeReads() - before > 0, "the producer reads the head, origin and session once");
  const head = store.get<any>(intent.id)!;
  assert.equal(head.revision, 4);
  assert.equal(head.value.outputs.length, 2);
  const turnId = `research-turn:v1:${hashJson([run.id, 5])}`;
  const turn = store.get<any>(turnId)!;
  assert.equal(turn.value.contract, "research-consumer-turn/v1");
  assert.equal(turn.value.run, run.id);
  assert.equal(turn.value.number, 5);
  assert.deepEqual(head.value.outputs[1], reference(turn));
  assert.deepEqual(turn.value.consumerIntent, reference(store.get<any>(intent.id, 1)!));
  // The one-time delivered mark rode the same transaction.
  assert.deepEqual(store.get<any>(session.id)!.value.delivered, reference(turn));
});

test("G5a: a foreign turn action or a second append is refused before any write", (t) => {
  const { store, run, intent } = handoffFixture(t);
  assert.throws(() => handoff(store).handoffSynthesis(intent, run as Revision<never>,
    { action: "other" }, { pid: 1, started: "t" }), { code: "research_consumer_intent_invalid" });
  assert.equal(store.get(intent.id)!.revision, 3, "no append was written");
  assert.equal(store.get(`research-turn:v1:${hashJson([run.id, 5])}`), null, "no turn was written");
  // The once-only rule: a head already past the applied @3 cannot grow a turn.
  const twice = handoffFixture(t, true);
  assert.throws(() => handoff(twice.store).handoffSynthesis(twice.intent, twice.run as Revision<never>,
    twice.action, { pid: 1, started: "t" }), { code: "research_consumer_intent_invalid" });
  assert.equal(twice.store.get(twice.intent.id)!.revision, 4, "the applied intent kept its history");
});

test("G5a: an already-present turn address fails the append atomically — no partial commit", (t) => {
  const { store, run, intent, action } = handoffFixture(t);
  const turnId = `research-turn:v1:${hashJson([run.id, 5])}`;
  store.writeMany([{ id: turnId, kind: "research-turn", expected: 0, value: { contract: "research-consumer-turn/v1" } }]);
  assert.throws(() => handoff(store).handoffSynthesis(intent, run as Revision<never>, action, { pid: 1, started: "t" }),
    { code: "input_stale" });
  assert.equal(store.get(intent.id)!.revision, 3, "the intent was not appended");
  assert.equal(store.get(run.id)!.revision, 1, "the run was not bumped");
  assert.equal(store.get<any>(turnId)!.revision, 1, "the occupying turn is untouched");
});

/** A real admission fixture: engine-owned draft/question and environment, so
 * the producer's capacity computation runs over genuine rows. */
function admissionFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-g5a-admit-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  preparedFeatures(engine, "p");
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = engine.environments.configure("p", { workspace: root,
    implementer: { actor: "author", model: "m", effort: "high", command },
    reviewer: { actor: "assessor", model: "m", effort: "high", command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const r0 = engine.refinement.begin("p", "R0");
  engine.refinement.finishResearch("p", "R0", reference(r0), 0);
  engine.refinement.sealLayer("p", 1, 0);
  const draft = engine.refinement.begin("p", "R1");
  const question = store.get<Record<string, any>>(draft.value.questions[0]!)!;
  const [run] = store.writeMany([{ id: "research-run:r", kind: "research-run", expected: 0,
    value: { projectId: "p", draftId: draft.id, turns: 1, status: "running", inputs: draft.value.inputs } }]);
  const input = { projectId: "p", kind: "analyst" as const, key: "k",
    owner: reference(run!), draft: reference(draft), question: reference(question),
    role: environment.value.implementer, dispatch: environment.value, profile: null,
    cursor: { run: run!.id, turn: 1, instruction: "Research k",
      context: pilotContext(store, draft as Revision<never>, question as Revision<never>) },
    basis: [], guards: uniqueTransactionGuards([reference(run!), reference(draft), reference(question)]) };
  return { root, store, engine, environment, draft, question, run: run!, input };
}

test("G5a: a new admission still computes and stores its declared capacity", (t) => {
  const { store, input } = admissionFixture(t);
  const prepared = prepareResearchConsumerIntent(store, input as never);
  assert.equal(prepared.value.state, "prepared");
  assert.equal(prepared.value.cursor.resultCapacityContract, RESULT_CAPACITY);
  assert.ok(prepared.value.cursor.resultCapacity && typeof prepared.value.cursor.resultCapacity === "object",
    "the producer computed the mandatory minimum once at the write");
  assert.equal(typeof prepared.value.cursor.resultCapacityPrompt, "string",
    "the producer stored the prompt the admission was proved against");
  // Repeating the same admission is idempotent — the saved prepared row stands.
  const again = prepareResearchConsumerIntent(store, input as never);
  assert.equal(again.revision, prepared.revision);
});

test("G5a (возврат 1): the trusted declaration costs no recomputation on repeat checks", async (t) => {
  const { store, input, question } = admissionFixture(t);
  const profiler = new InspectorSession();
  profiler.connect();
  t.after(() => profiler.disconnect());
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  /** Calls of `minimum` (the capacity measure in research-delivery.js) since the previous take. */
  const measure = async (operation: () => unknown) => {
    await profiler.post("Profiler.takePreciseCoverage");
    const before = storeReads();
    const value = operation();
    const reads = storeReads() - before;
    const coverage = await profiler.post("Profiler.takePreciseCoverage") as { result: { url: string; functions: { functionName: string; ranges: { count: number }[] }[] }[] };
    const minimumCalls = coverage.result.filter(file => file.url.endsWith("/research-delivery.js"))
      .flatMap(file => file.functions).filter(fn => fn.functionName === "minimum")
      .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
    return { value, reads, minimumCalls };
  };
  const admitted = await measure(() => prepareResearchConsumerIntent(store, input as never));
  assert.ok(admitted.minimumCalls > 0, "a new admission still computes its declared capacity");
  const prepared = admitted.value as Revision<ResearchConsumerIntent>;
  assert.equal(prepared.value.state, "prepared");
  const payload = { action: "answer", question: question.id, value: { answer: "small" }, citations: [] };
  for (let i = 0; i < 2; i += 1) {
    const check = await measure(() => consumerCapacityFailure(store, prepared, payload));
    assert.equal(check.value, null, "a fitting payload is not a capacity failure");
    assert.equal(check.minimumCalls, 0, "the saved declaration answers without recomputation");
    assert.equal(check.reads, 0, "no draft/question/profile rows reload for a saved admission");
  }
  const repeat = await measure(() => prepareResearchConsumerIntent(store, input as never));
  assert.deepEqual(reference(repeat.value as Revision<ResearchConsumerIntent>), reference(prepared),
    "an unchanged admission returns the exact saved prepared row");
  assert.equal(repeat.minimumCalls, 0, "an unchanged prepared admission is not rebuilt");
  const changed = { ...input, role: { ...input.role, effort: "low" } };
  const rewritten = await measure(() => prepareResearchConsumerIntent(store, changed as never));
  assert.ok(rewritten.minimumCalls > 0, "a lawful input change still recomputes at the write");
  assert.equal((rewritten.value as Revision<ResearchConsumerIntent>).revision, prepared.revision + 1,
    "a lawful input change rewrites the prepared admission in place");
});

test("G5a: a retry generation proves its predecessor once and recomputes capacity at its write", (t) => {
  const { store, input } = admissionFixture(t);
  const [call] = store.writeMany([{ id: "model-call:fixture", kind: "model-call", expected: 0,
    value: { status: "completed", error: "provider_failed" } }]);
  const refused = writeIntent(store, { ...input, key: "k2", contract: "research-consumer-intent/v1",
    rootKey: "k2", generation: 0, previous: null, state: "refused",
    call: reference(call!), request: ref("request-manifest:rq"), archive: ref("archive:ar"), outputs: null,
    refusal: { kind: "provider-failed", code: "provider_failed", call: reference(call!),
      request: ref("request-manifest:rq"), response: null, archive: ref("archive:ar") } } as ResearchConsumerIntent, 0);
  // Without the exact permit the refused predecessor buys nothing: the same
  // re-admission returns the saved refused row, no new generation is written.
  const held = prepareResearchConsumerIntent(store, { ...input, key: "k2" } as never);
  assert.equal(held.id, refused.id);
  assert.equal(held.value.state, "refused");
  assert.equal(store.get(refused.id)!.revision, 1);
  const retried = prepareResearchConsumerIntent(store, { ...input, key: "k2" } as never,
    [reference(refused)]);
  assert.equal(retried.value.generation, 1);
  assert.deepEqual(retried.value.previous, reference(refused));
  assert.equal(retried.value.cursor.resultCapacityContract, RESULT_CAPACITY);
  assert.ok(retried.value.cursor.resultCapacity, "the new generation stored its own declared capacity");
  assert.notEqual(retried.id, refused.id, "the retry generation is a new committed address");
  assert.equal(store.get<ResearchConsumerIntent>(retried.id)!.value.generation, 1);
});

test("G5a: reserving a physical call on a non-prepared intent is refused before any write", (t) => {
  const store = fixture(t);
  const applied = writeIntent(store, intent({ state: "applied",
    call: ref("model-call:c"), request: ref("request-manifest:c"), archive: ref("archive:c"),
    outputs: [ref("research-turn:t")] }), 0);
  const callWrite = { id: "model-call:c2", kind: "model-call", expected: 0,
    value: { request: { record: ref("request-manifest:c2") }, packet: { archive: ref("archive:c2") },
      consumerIntent: reference(applied), projectId: "p", draftId: "discovery-draft:d", questionId: "question:q",
      requested: applied.value.role, purpose: "analyst" } };
  assert.throws(() => prepareResearchConsumerReservation(store, reference(applied), callWrite,
    ref("request-manifest:c2"), ref("archive:c2")), { code: "research_consumer_intent_invalid" });
  assert.equal(store.get(applied.id)!.revision, 1, "the applied intent kept its saved state");
  assert.equal(store.get("model-call:c2"), null, "the call was never written");
});

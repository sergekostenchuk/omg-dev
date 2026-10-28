import { fixturePlanAxes, fixturePlanCoverage } from "./discovery-v7-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_STAGE_TOKEN_CEILING } from "../src/discovery/v7-contracts.js";
import { Researcher } from "../src/discovery/research-runner.js";
import { researchCall } from "../src/discovery/research-protocol.js";
import { prepareResearchConsumerIntent, readResearchConsumerTurn } from "../src/discovery/response-recovery.js";
import { managedTurnId, projectPaidTurnAdmission } from "../src/discovery/research-consumer-transition.js";
import { dispatchMode, PLANNING_INSTRUCTION, projectPlannedRetry, projectReadingQueue, projectSplitParts,
  queueOriginOf, queueReadingPlan, queuedChildReached, v7DispatchMode, v7PlannerRounds } from "../src/discovery/reading-plan.js";
import { ATTEMPT_BINDING_CONTRACT, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import type { V7PlanningSettings } from "../src/discovery/reader-pilot.js";
import type { ResearchAction, ResearchRun, ResearchTurn } from "../src/discovery/research-model.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, uniqueRefs, type Ref } from "../src/pipeline/contracts.js";
import { uniqueTransactionGuards } from "../src/runtime/environment.js";
import { Store, type Revision } from "../src/storage/store.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture } from "./discovery-v7-fixture.js";

// DR3a3-S3 (codex-omg №7690 §3 S3; граница проверок — №8173, вариант (b)):
// the reading queue of the v7 planner. The plan, the run and the planner
// intent come from their real producers; the paid planner turn (O@1) has no
// lawful producer before S5/S6, so the queue/split/retry forms and lineage are
// checked on in-memory values only — a projector output is never saved as a
// paid turn. The positive queue on a lawfully paid parent is S6's (№8173).

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3a3s3-queue-");
type Fixture = ReturnType<typeof fixture>;
const validFrame = (): Json => ({ productType: "internal", scale: "30 users across 10 sites",
  industries: ["construction"], domains: ["materials supply"], axes: fixturePlanAxes([{ axis: "industry" }, { axis: "market" }]),
  budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } });
const planQuestion = (id: string, axis: string, cls = "supporting") => ({ id, axis, domain: "construction",
  text: `What covers ${id}?`, class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
  roles: ["domain expert"], searchPlaces: ["domain documents"] });
const validPlan = (frame: Ref, ids: string[]): Json =>
  ({ edition: 1, frame, previous: null, coverage: fixturePlanCoverage(ids.map((id, i) => ({ id, axis: i ? "market" : "industry" }))), questions: ids.map((id, i) => planQuestion(id, i ? "market" : "industry",
    i ? "supporting" : "blocking")) }) as unknown as Json;
const questionOf = (store: Store, draft: Revision<DiscoveryDraft>, field: string) =>
  draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
const subjectOf = (planAnswer: Ref, planQuestionId: string): V7PlanSubject =>
  ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId });
const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};
/** An in-memory revision: the structural input of a pure check, never written to a Store. */
const memo = <T,>(id: string, kind: string, revision: number, value: T): Revision<T> =>
  ({ id, kind, revision, hash: hashJson(value as unknown as Json), value });
/** A read-only view over in-memory revisions for the chain/count readers — no Store, no write. */
function view(rows: Revision<any>[]): Store {
  const get = (id: string, revision?: number) => {
    const all = rows.filter(row => row.id === id);
    return revision === undefined ? all.sort((a, b) => b.revision - a.revision)[0] ?? null
      : all.find(row => row.revision === revision) ?? null;
  };
  const list = (kind?: string) => [...new Set(rows.map(row => row.id))].map(id => get(id)!)
    .filter(row => kind === undefined || row.kind === kind);
  return { get, list } as unknown as Store;
}

/** The real plan acceptance chain (frame and plan through #answer) and the environment. */
function planned(f: Fixture, project: string) {
  f.engine.execute({ type: "create-project", project, title: project });
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, ["q-supply", "q-market"]), src);
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 30000 }, 0);
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, environment };
}
type Planned = ReturnType<typeof planned>;

const reads: ResearchAction[] = [
  { action: "search", query: "supply contract terms" },
  { action: "read_bundle", purpose: "contract basis", inputs: [{ path: "a.txt", media: "text/plain" }] }] as ResearchAction[];
const readPlan = (question: string, items = reads) =>
  ({ action: "read_plan", question, reads: items }) as Extract<ResearchAction, { action: "read_plan" }>;
const runOf = (p: Planned, turns = 0) => memo<ResearchRun>(`research-run:${hashJson([p.project, p.draft.id])}`, "research-run", 1,
  { projectId: p.project, draftId: p.draft.id, environment: reference(p.environment), status: "running", turns, limit: 8,
    inputs: [], ownerQuestion: null, error: null, pauseCode: null, owner: { pid: 1, started: "fixture" }, requestChars: 0 } as ResearchRun);
/** The planner O@1 the runner would write for a paid read_plan — built in memory by the shared projector. */
function plannerTurn(p: Planned, run: Revision<ResearchRun>, intent: Ref, subject: V7PlanSubject | null,
  action: unknown, mode: "planning" | "synthesis" | null = "planning"): Revision<ResearchTurn> {
  const { turn } = projectPaidTurnAdmission(run.value, { runId: run.id, intent, response: action, question: reference(p.plan),
    owner: run.value.owner, limit: 8, context: {}, ...(mode ? { mode } : {}), ...(subject ? { subject } : {}) });
  return memo<ResearchTurn>(managedTurnId(run.id, turn.number), "research-turn", 1, turn);
}
const intentRef: Ref = { id: "research-consumer-intent:in-memory", revision: 1, hash: hashJson("in-memory planner intent") };

test("S3 queue forms: a v7 queue addresses its plan-question, keeps the real Question and planner subject on every child, and no child becomes an attempt", t => {
  const f = fixture(t), p = planned(f, "s3-forms"), run = runOf(p);
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const parentA = plannerTurn(p, run, intentRef, A, readPlan("q-supply"));
  assert.equal((parentA.value as { attemptContract?: string }).attemptContract, ATTEMPT_BINDING_CONTRACT);
  const children = projectReadingQueue(run, parentA, p.plan, readPlan("q-supply"));
  assert.equal(children.length, reads.length);
  children.forEach((child, index) => {
    assert.equal(child.id, `research-turn:${hashJson([parentA.id, "read", index])}`);
    assert.deepEqual(child.value.subject, A);
    assert.deepEqual(child.value.question, reference(p.plan), "the child keeps the real plan Question basis");
    assert.deepEqual(child.value.plannedBy, reference(parentA));
    assert.deepEqual(child.value.action, reads[index]);
    assert.equal(child.value.status, "pending");
    for (const field of ["attemptContract", "attempt", "attemptBinding", "contract", "consumerIntent"])
      assert.equal(Object.hasOwn(child.value, field), false, `a child never claims ${field}`);
  });
  // action.question is the logical question: the plan-question id of the planner's subject.
  assert.equal(code(() => projectReadingQueue(run, parentA, p.plan, readPlan(p.plan.id))), "reading_plan_invalid");
  assert.equal(code(() => projectReadingQueue(run, parentA, p.plan, readPlan("q-market"))), "reading_plan_invalid");
  assert.equal(code(() => projectReadingQueue(run, parentA, p.plan, readPlan("q-supply", [reads[0]!, reads[0]!]))), "reading_plan_invalid");
  // The same read action cannot move the queue to another parent or subject.
  const parentB = plannerTurn(p, runOf(p, 1), intentRef, B, readPlan("q-market"));
  assert.equal(code(() => projectReadingQueue(run, parentB, p.plan, readPlan("q-supply"))), "reading_plan_invalid");
  const childrenB = projectReadingQueue(run, parentB, p.plan, readPlan("q-market"));
  assert.deepEqual(childrenB.map(child => child.value.action), children.map(child => child.value.action));
  assert.notDeepEqual(childrenB.map(child => child.id), children.map(child => child.id));
  assert.ok(childrenB.every(child => child.value.subject!.planQuestionId === "q-market"));
  // Only the exact paid planner turn of the subject owns a v7 queue.
  assert.equal(code(() => projectReadingQueue(run, parentA, p.plan, readPlan("q-supply", [reads[0]!]))), "reading_plan_invalid",
    "the queue is the parent's own paid read_plan");
  assert.equal(code(() => projectReadingQueue(run, plannerTurn(p, run, intentRef, A, readPlan("q-supply"), null),
    p.plan, readPlan("q-supply"))), "reading_plan_invalid", "an analyst-mode turn is not a planner");
  const child = memo<ResearchTurn>(children[0]!.id, "research-turn", 1, children[0]!.value);
  assert.equal(code(() => projectReadingQueue(run, child, p.plan, readPlan("q-supply"))), "reading_plan_invalid",
    "a child carrying the subject is not a planner");
  assert.equal(code(() => projectReadingQueue(runOf({ ...p, draft: { ...p.draft, id: "foreign-draft" } }), parentA, p.plan,
    readPlan("q-supply"))), "reading_plan_invalid", "another run does not own this planner turn");
  const damaged = memo<ResearchTurn>(parentA.id, "research-turn", 1, { ...parentA.value, subject: { ...A, planQuestionId: "" } });
  assert.equal(code(() => projectReadingQueue(run, damaged, p.plan, readPlan("q-supply"))), "reading_plan_invalid");
  // The field path keeps its form: a planner without a subject addresses the Question id and its children carry none.
  const field = plannerTurn(p, run, intentRef, null, readPlan(p.plan.id));
  const fieldChildren = projectReadingQueue(run, field, p.plan, readPlan(p.plan.id));
  assert.ok(fieldChildren.every(item => !Object.hasOwn(item.value, "subject")));
  assert.equal(code(() => projectReadingQueue(run, field, p.plan, readPlan("q-supply"))), "reading_plan_invalid");
});

test("S3 split and retry keep the exact parent, Question and subject; the retry chain refuses a changed or lost lineage", t => {
  const f = fixture(t), p = planned(f, "s3-chain"), run = runOf(p, 3);
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const parent = plannerTurn(p, run, intentRef, A, readPlan("q-supply"));
  const queued = projectReadingQueue(run, parent, p.plan, readPlan("q-supply"))[0]!;
  const original = memo<ResearchTurn>(queued.id, "research-turn", 1, queued.value);
  const page = { action: "read_context", record: reference(p.plan), pointer: "/answer" } as ResearchAction;
  const parts = projectSplitParts(run, original, [page, page]);
  for (const part of parts) {
    assert.deepEqual(part.value.subject, A);
    assert.deepEqual(part.value.plannedBy, reference(parent));
    assert.deepEqual(part.value.question, reference(p.plan));
    assert.deepEqual(part.value.splitFrom, reference(original));
    assert.deepEqual(part.value.replayedFrom, reference(original));
    assert.equal(Object.hasOwn(part.value, "attemptContract"), false);
  }
  const failed = memo<ResearchTurn>(original.id, "research-turn", 2,
    { ...original.value, status: "completed", error: "temporary source problem", observation: { code: "source_missing" } });
  const retried = projectPlannedRetry(failed, reference(failed));
  assert.deepEqual(retried, { ...original.value, replayedFrom: reference(failed) },
    "a retry keeps every basis field and the subject lineage");
  const P = memo<ResearchTurn>(original.id, "research-turn", 3, retried);
  assert.equal(queuedChildReached(view([original, failed, P]), reference(original), P), true);
  const swapped = memo<ResearchTurn>(original.id, "research-turn", 3, { ...retried, subject: B });
  assert.equal(queuedChildReached(view([original, failed, swapped]), reference(original), swapped), false,
    "another subject is not the same queued child");
  const { subject: _lost, ...withoutSubject } = retried;
  const lost = memo<ResearchTurn>(original.id, "research-turn", 3, withoutSubject as ResearchTurn);
  assert.equal(queuedChildReached(view([original, failed, lost]), reference(original), lost), false,
    "a lost lineage is not the same queued child");
  const midSwap = memo<ResearchTurn>(original.id, "research-turn", 2, { ...failed.value, subject: B });
  assert.equal(queuedChildReached(view([original, midSwap, P]), reference(original), P), false,
    "every revision of the retry chain keeps the subject");
});

test("S3-02/03 queue origin: only the writers' own chain — original child, completion, no-progress pause, lawful retry and the exact split of the historical bytes — keeps the origin", t => {
  // The runner's positions: the paid planner is turn 1, its queue is written at run.turns=1 and a split at 2.
  const f = fixture(t), p = planned(f, "s3-origin"), run = runOf(p, 2);
  const A = subjectOf(p.planAnswer, "q-supply");
  // The material of the read: an exact archived record of ten characters (in memory, structural input only).
  // A whole-body archive keeps its body as an object (readArchiveBody); the read selects a string inside it.
  const material = memo("research-context:s3-material", "research-context", 1, { body: { text: "abcdefghij" } });
  const contextRead = { action: "read_context", record: reference(material), pointer: "/body/text", page: { offset: 0, limit: 10 } } as ResearchAction;
  const parent = plannerTurn(p, runOf(p, 0), intentRef, A, readPlan("q-supply", [contextRead]));
  const queued = projectReadingQueue(runOf(p, 1), parent, p.plan, readPlan("q-supply", [contextRead]))[0]!;
  const original = memo<ResearchTurn>(queued.id, "research-turn", 1, queued.value);
  const origin = reference(original);
  const rows = (...more: Revision<any>[]) => view([material, original, ...more]);
  assert.deepEqual(queueOriginOf(rows(), original, parent), origin);
  // Completion and lawful retry of a failed revision.
  const failed = memo<ResearchTurn>(original.id, "research-turn", 2, { ...original.value, status: "completed", error: "retryable" });
  const retried = memo<ResearchTurn>(original.id, "research-turn", 3, projectPlannedRetry(failed, reference(failed)));
  assert.deepEqual(queueOriginOf(rows(failed, retried), retried, parent), origin);
  // S3-03: the runner's no-progress pause names the exact earlier completed read of this run and Question;
  // its lawful continuation is a completion. Another pending rewrite is not a pause.
  const earlier = memo<ResearchTurn>("research-turn:s3-earlier", "research-turn", 2, { ...original.value, number: 1,
    status: "completed", observation: { value: "abcde" } });
  const paused = memo<ResearchTurn>(original.id, "research-turn", 2, { ...original.value,
    observation: { code: "research_no_progress", previous: reference(earlier) }, status: "pending" });
  assert.deepEqual(queueOriginOf(rows(earlier, paused), paused, parent), origin);
  const resumed = memo<ResearchTurn>(original.id, "research-turn", 3, { ...paused.value, status: "completed", observation: { value: "abcdefghij" } });
  assert.deepEqual(queueOriginOf(rows(earlier, paused, resumed), resumed, parent), origin, "the paused read completes later");
  const noPrevious = memo<ResearchTurn>(original.id, "research-turn", 2, { ...paused.value,
    observation: { code: "research_no_progress", previous: { id: "research-turn:missing", revision: 1, hash: hashJson("missing") } } });
  assert.equal(queueOriginOf(rows(noPrevious), noPrevious, parent), null, "the pause names an existing earlier read");
  const otherPending = memo<ResearchTurn>(original.id, "research-turn", 2, { ...original.value, observation: { note: "kept" } });
  assert.equal(queueOriginOf(rows(otherPending), otherPending, parent), null, "no other pending rewrite");
  // S3-02: the split is exactly the writer's cut of the full selected range — 5+5 of 10 characters.
  const page = (offset: number, limit: number) => ({ ...contextRead, page: { offset, limit } }) as ResearchAction;
  const split = (actions: ResearchAction[], base = original) => {
    const parts = projectSplitParts(run, base, actions).map(part => memo<ResearchTurn>(part.id, "research-turn", 1, part.value));
    const divided = memo<ResearchTurn>(base.id, "research-turn", base.revision + 1, { ...base.value, status: "completed", error: null,
      observation: { splitInto: parts.map(reference), reason: "context_read_limit" } });
    return { parts, divided };
  };
  const lawful = split([page(0, 5), page(5, 5)]);
  assert.deepEqual(queueOriginOf(rows(lawful.divided, ...lawful.parts), lawful.parts[1]!, parent), origin);
  // A successful child cannot become pending again; a retry is only of a failed revision and only exactly projected.
  const done = memo<ResearchTurn>(original.id, "research-turn", 2, { ...original.value, status: "completed", error: null,
    observation: { value: "done" } });
  const reopened = memo<ResearchTurn>(original.id, "research-turn", 3, { ...original.value });
  assert.equal(queuedChildReached(rows(done, reopened), origin, reopened), false, "the shared retry predicate refuses it");
  assert.equal(queueOriginOf(rows(done, reopened), reopened, parent), null);
  const retryOfDone = memo<ResearchTurn>(original.id, "research-turn", 3, projectPlannedRetry(done, reference(done)));
  assert.equal(queueOriginOf(rows(done, retryOfDone), retryOfDone, parent), null);
  const looseRetry = memo<ResearchTurn>(original.id, "research-turn", 3, { ...original.value, observation: { note: "kept" } });
  assert.equal(queueOriginOf(rows(failed, looseRetry), looseRetry, parent), null);
  const rewritten = memo<ResearchTurn>(original.id, "research-turn", 2, { ...original.value, status: "completed", error: null,
    observation: null, number: 9 });
  assert.equal(queueOriginOf(rows(rewritten), rewritten, parent), null, "a completion keeps the pending basis");
  // S3-04's shared proof: a damaged intermediate revision under a restored head is not this queue's child.
  const damaged = memo<ResearchTurn>(original.id, "research-turn", 2, { ...original.value, action: reads[0]!, status: "completed", error: "x" });
  const restored = memo<ResearchTurn>(original.id, "research-turn", 3, projectPlannedRetry(damaged, reference(damaged)));
  assert.equal(queueOriginOf(rows(damaged, restored), restored, parent), null);
  // A split part never acquires the origin by a splitInto marker.
  const stringBody = memo("research-context:s3-string-body", "research-context", 1, { body: "abcdefghij" });
  const onString = { ...contextRead, record: reference(stringBody), pointer: "/body" } as ResearchAction;
  const stringParent = plannerTurn(p, runOf(p, 0), intentRef, A, readPlan("q-supply", [onString]));
  const stringChild = projectReadingQueue(runOf(p, 1), stringParent, p.plan, readPlan("q-supply", [onString]))[0]!;
  const stringOriginal = memo<ResearchTurn>(stringChild.id, "research-turn", 1, stringChild.value);
  const stringCut = split([{ ...onString, page: { offset: 0, limit: 5 } }, { ...onString, page: { offset: 5, limit: 5 } }] as ResearchAction[], stringOriginal);
  assert.equal(queueOriginOf(view([stringBody, stringOriginal, stringCut.divided, ...stringCut.parts]), stringCut.parts[0]!, stringParent), null,
    "an archive whose body is not an object is refused by readArchiveBody, so the writer never splits it");
  const unrelated = { ...contextRead, record: { id: "context:unrelated", revision: 1, hash: hashJson("unrelated") } } as ResearchAction;
  const foreign = split([{ ...unrelated, page: { offset: 0, limit: 5 } }, { ...unrelated, page: { offset: 5, limit: 5 } }] as ResearchAction[]);
  assert.equal(queueOriginOf(rows(foreign.divided, ...foreign.parts), foreign.parts[0]!, parent), null, "another record");
  for (const [name, actions] of [["one part", [page(0, 1)]], ["a prefix of the range", [page(0, 1), page(1, 1)]],
    ["uneven halves", [page(0, 2), page(2, 8)]], ["a gap", [page(0, 5), page(6, 5)]], ["beyond the material", [page(0, 6), page(6, 6)]]] as const) {
    const cut = split([...actions]);
    assert.equal(queueOriginOf(rows(cut.divided, ...cut.parts), cut.parts[0]!, parent), null, name);
  }
  const changed = lawful.parts.map(part => memo<ResearchTurn>(part.id, "research-turn", 1, { ...part.value, question: { ...part.value.question!, revision: 9 } }));
  const changedDivided = memo<ResearchTurn>(original.id, "research-turn", 2, { ...lawful.divided.value,
    observation: { splitInto: changed.map(reference), reason: "context_read_limit" } });
  assert.equal(queueOriginOf(rows(changedDivided, ...changed), changed[0]!, parent), null, "a changed basis of a part");
  // Malformed siblings are refusals, never a JavaScript exception or a confirmed origin.
  const nullSibling = memo<ResearchTurn>(lawful.parts[1]!.id, "research-turn", 1, null as unknown as ResearchTurn);
  const unhashed = { ...lawful.parts[1]!, hash: hashJson("another value") };
  const second = memo<ResearchTurn>(lawful.parts[1]!.id, "research-turn", 2, { ...lawful.parts[1]!.value, status: "completed" });
  for (const [name, sibling, extra] of [["null value", nullSibling, []], ["unhashed value", unhashed, []],
    ["a later revision", second, [lawful.parts[1]!]]] as [string, Revision<ResearchTurn>, Revision<ResearchTurn>[]][]) {
    const divided = memo<ResearchTurn>(original.id, "research-turn", 2, { ...lawful.divided.value,
      observation: { splitInto: [reference(lawful.parts[0]!), reference(sibling)], reason: "context_read_limit" } });
    assert.equal(queueOriginOf(rows(divided, lawful.parts[0]!, sibling, ...extra), lawful.parts[0]!, parent), null, name);
  }
});

test("S3 mode isolation: A never inherits B's plan, mode or failed child; the field path ignores subject turns", t => {
  const f = fixture(t), p = planned(f, "s3-mode"), run = runOf(p);
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const parentA = plannerTurn(p, run, intentRef, A, readPlan("q-supply"));
  const completedA = memo<ResearchTurn>(parentA.id, "research-turn", 2,
    { ...parentA.value, status: "completed", observation: { state: "queued", children: [] } });
  const queued = projectReadingQueue(run, parentA, p.plan, readPlan("q-supply"))[0]!;
  const failedChild = memo<ResearchTurn>(queued.id, "research-turn", 2,
    { ...queued.value, status: "completed", error: "source unavailable", observation: null });
  const turns = [completedA, failedChild];
  assert.equal(code(() => dispatchMode(turns, p.plan, A)), "reading_plan_blocked", "A's own failed child blocks A");
  assert.equal(dispatchMode(turns, p.plan, B), "planning", "B does not inherit A's plan or failed child");
  assert.equal(dispatchMode(turns, p.plan, null), "planning", "the field path reads no subject turns");
  const runB = runOf(p, 3);
  const synthesizeB = plannerTurn(p, runB, intentRef, B, { action: "synthesize", question: "q-market" });
  const doneB = memo<ResearchTurn>(synthesizeB.id, "research-turn", 2, { ...synthesizeB.value, status: "completed",
    observation: { nextMode: "synthesis" } });
  assert.equal(dispatchMode([...turns, doneB], p.plan, B), "synthesis");
  assert.equal(code(() => dispatchMode([...turns, doneB], p.plan, A)), "reading_plan_blocked", "B's mode is not A's");
});

test("S3 rounds: planner rounds count per project+subject from saved planner turns only; the limit stops new planning and damaged settings refuse", t => {
  const f = fixture(t), p = planned(f, "s3-rounds"), run = runOf(p);
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const settings = (maxRounds: number): V7PlanningSettings => ({ contract: "v7-plan-planning/v1", maxRequestChars: 20000, maxRounds });
  const at = (n: number) => runOf(p, n);
  const roundA1 = plannerTurn(p, at(0), intentRef, A, readPlan("q-supply"));
  const roundA2 = plannerTurn(p, at(3), intentRef, A, { action: "synthesize", question: "q-supply" });
  const roundB = plannerTurn(p, at(4), intentRef, B, readPlan("q-market"));
  const analystA = plannerTurn(p, at(5), intentRef, A, { action: "search", query: "analyst read" }, null);
  const child = projectReadingQueue(at(0), roundA1, p.plan, readPlan("q-supply"))[0]!;
  const childRow = memo<ResearchTurn>(child.id, "research-turn", 1, child.value);
  const foreignRun = memo<ResearchRun>("research-run:foreign", "research-run", 1, { ...run.value, projectId: "foreign" });
  const foreign = plannerTurn(p, foreignRun, intentRef, A, readPlan("q-supply"));
  const saved = view([run, foreignRun, roundA1, roundA2, roundB, analystA, childRow, foreign]);
  assert.equal(v7PlannerRounds(saved, p.project, A), 2, "children, analyst turns and other projects are not planner rounds");
  assert.equal(v7PlannerRounds(saved, p.project, B), 1);
  assert.equal(code(() => v7DispatchMode(saved, p.project, [], p.plan, A, settings(2))), "reading_plan_rounds_exhausted");
  assert.equal(v7DispatchMode(saved, p.project, [], p.plan, A, settings(3)), "planning");
  assert.equal(v7DispatchMode(saved, p.project, [], p.plan, B, settings(2)), "planning", "A's rounds are not B's");
  for (const damaged of [settings(0), { ...settings(3), contract: "v7-plan-planning/v0" }, null])
    assert.equal(code(() => v7DispatchMode(saved, p.project, [], p.plan, A, damaged as unknown as V7PlanningSettings)),
      "reader_pilot_invalid");
});

test("S3 boundary: a lawful planner intent is saved, its paid admission reaches the exact budget boundary without a call, and no queue is written without a lawful paid parent", async t => {
  const f = fixture(t), p = planned(f, "s3-boundary");
  const A = subjectOf(p.planAnswer, "q-supply");
  // The real v7 runner writes the run; with no calibrated estimate it pauses before any payment.
  const paused = await new Researcher(f.store, new Discovery(f.store), f.engine.environments)
    .run(p.project, p.draft.id, 1, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(paused.value.status, "paused", JSON.stringify(paused.value));
  assert.deepEqual(f.store.list("model-call"), [], "the runner bought nothing");
  const run = f.store.get<ResearchRun>(paused.id)!;
  const dispatch = { ...p.environment.value, workspace: f.root };
  const context = { role: "research", stage: "discovery", subject: A, inventory: { sources: [] }, history: [],
    contextWorkspace: [], dispatchMode: "planning" };
  const intent = prepareResearchConsumerIntent(f.store, { projectId: p.project, kind: "reading-planner",
    key: hashJson([run.id, run.value.turns + 1, "reading-planner"]), owner: reference(run),
    draft: reference(p.draft), question: reference(p.plan), role: dispatch.implementer, dispatch, profile: null,
    cursor: { run: run.id, turn: run.value.turns + 1, mode: "planning", instruction: PLANNING_INSTRUCTION, context, subject: A },
    basis: uniqueRefs([...p.draft.value.inputs, p.planAnswer]),
    guards: uniqueTransactionGuards([reference(run), reference(p.draft), reference(p.plan), ...p.draft.value.inputs, p.planAnswer]) });
  assert.equal(intent.value.state, "prepared");
  assert.deepEqual(intent.value.cursor.subject, A);
  const before = f.store.list().map(row => [row.id, row.revision, row.hash]);
  await assert.rejects(researchCall(intent.value.role, intent.value.dispatch, PLANNING_INSTRUCTION, context, undefined,
    { store: f.store, draftId: p.draft.id, questionId: p.plan.id, purpose: "reading-planner", consumerIntent: reference(intent) }),
  // DR3a3-S5 (№7690 §3 S5) connected the planner's paid admission: the lawful S3 intent now passes the role
  // admission and stops at the next exact boundary — no calibrated estimate — before any adapter or ledger.
  { code: "budget_estimate_missing" });
  for (const kind of ["model-call", "model-request", "research-budget-ledger", "research-turn"])
    assert.deepEqual(f.store.list(kind), [], `no ${kind}`);
  assert.deepEqual(f.store.list().map(row => [row.id, row.revision, row.hash]), before, "the refused admission wrote nothing");
  // A planner turn the runner never wrote cannot own a queue: the shared reader refuses it before any write.
  const parent = plannerTurn(p, run, reference(intent), A, readPlan("q-supply"));
  assert.equal(code(() => queueReadingPlan(f.store, run, parent, p.draft, p.plan, readPlan("q-supply"))),
    "research_consumer_intent_invalid");
  assert.deepEqual(f.store.list("research-turn"), [], "no child of an unpaid parent");
  assert.deepEqual(f.store.get(run.id), run, "the run counter is unchanged");

  // S3-01 (codex-omg №8262): negative corruption only — the projector result of the lawful but unpaid intent is
  // deliberately saved as a forged parent. Its markers (attemptContract, planning, subject) are not provenance:
  // the shared reader refuses the parent, the queue is not published and a child naming it is not readable.
  const forgedParent = f.store.write<ResearchTurn>({ id: parent.id, kind: "research-turn", expected: 0, value: parent.value });
  assert.equal(code(() => readResearchConsumerTurn(f.store, reference(forgedParent))), "research_consumer_intent_invalid",
    "control: no applied intent produced this turn");
  const turnsBefore = f.store.list("research-turn").length, runBefore = f.store.get(run.id);
  assert.equal(code(() => queueReadingPlan(f.store, run, forgedParent, p.draft, p.plan, readPlan("q-supply"))),
    "research_consumer_intent_invalid", "an exact stored parent with planner markers is not a paid planner");
  assert.equal(f.store.list("research-turn").length, turnsBefore, "no child of a forged parent");
  assert.deepEqual(f.store.get(run.id), runBefore, "the run counter is unchanged");
  const queued = projectReadingQueue(run, forgedParent, p.plan, readPlan("q-supply"))[0]!;
  const forgedChild = f.store.write<ResearchTurn>({ id: queued.id, kind: "research-turn", expected: 0, value: queued.value });
  assert.equal(code(() => readResearchConsumerTurn(f.store, reference(forgedChild))), "research_consumer_intent_invalid",
    "a child does not acquire v7 lineage from parent markers alone");
});

test("S3 masquerade: a legacy-address turn cannot claim a plan subject without its exact paid planner parent", t => {
  const f = fixture(t), p = planned(f, "s3-masquerade");
  const A = subjectOf(p.planAnswer, "q-supply");
  const forged = (name: string, extra: Record<string, unknown>) => f.store.write<ResearchTurn>({
    id: `research-turn:${hashJson(["s3-forged", name])}`, kind: "research-turn", expected: 0,
    value: { run: "research-run:forged", number: 2, action: reads[0], assessment: null, observation: null, error: null,
      status: "pending", question: reference(p.plan), ...extra } as ResearchTurn });
  const missingParent = { id: managedTurnId("research-run:forged", 1), revision: 1, hash: hashJson("never written") };
  for (const [name, extra] of [
    ["no-parent", { subject: A }],
    ["missing-parent", { subject: A, plannedBy: missingParent }],
    ["field-parent", { subject: A, plannedBy: reference(forged("field-planner", {})) }],
    ["attempt-claim", { subject: A, attemptContract: ATTEMPT_BINDING_CONTRACT, plannedBy: missingParent }],
    ["damaged", { subject: { ...A, planQuestionId: "" }, plannedBy: missingParent }],
  ] as [string, Record<string, unknown>][])
    assert.equal(code(() => readResearchConsumerTurn(f.store, reference(forged(name, extra)))), "research_consumer_intent_invalid", name);
  const plain = forged("plain", {});
  assert.deepEqual(readResearchConsumerTurn(f.store, reference(plain)), plain, "a field-path legacy turn keeps its rules");
});

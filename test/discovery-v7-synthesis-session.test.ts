import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from "../src/discovery/v7-contracts.js";
import { findUnfinishedSynthesisSession, findUnfinishedSynthesisSessionV3, readSynthesisSessionV3,
  synthesisSession } from "../src/discovery/synthesis-session.js";
import { projectSynthesisSessionV3Initial } from "../src/discovery/research-consumer-transition.js";
import { readerPilot } from "../src/discovery/reader-pilot.js";
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { EngineError } from "../src/errors.js";
import type { Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import { answerDiscoveryFixture } from "./product-fixture.js";

// DR3a3-S5, независимая часть (№8525; переносы S1→S5 №7869 и S4→S5 №8455):
// the v3 synthesis producer of one v7 plan-question. The plan, environment
// and reader profile come from their real producers and the session from the
// real synthesisSession entry. The paid admission of synthesis stays closed
// until the shared files are connected, so the producer reaches its first
// record and a prepared step intent, and the payment refuses before any
// adapter or ledger.

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3a3s5-session-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;
const allAxes = (depth: string) => Object.fromEntries(V7_AXES.map(axis => [axis, { depth }]));
const validFrame = (): Json => ({ productType: "internal", scale: "30 users across 10 sites",
  industries: ["construction"], domains: ["materials supply"], axes: allAxes("deep"),
  budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } });
const planQuestion = (id: string, axis: string, cls = "supporting") => ({ id, axis, domain: "construction",
  text: `What covers ${id}?`, class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
  roles: ["domain expert"], searchPlaces: ["domain documents"] });
const validPlan = (frame: Ref, ids: string[], edition = 1, previous: Ref | null = null): Json =>
  ({ edition, frame, previous, questions: ids.map((id, i) => planQuestion(id, i ? "market" : "industry",
    i ? "supporting" : "blocking")) }) as unknown as Json;
const questionOf = (store: Store, draft: Revision<DiscoveryDraft>, field: string) =>
  draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
const subjectOf = (planAnswer: Ref, planQuestionId: string): V7PlanSubject =>
  ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId });
const code = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};

/** The real plan, environment and active reader profile of one v7 project. */
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
  f.engine.execute({ type: "configure-reader-pilot", project, expected: 0, settings: { experimental: true, active: true,
    stopAfter: "L2", reader: { actor: "reader", model: "fixture", effort: "high", speed: "inherited", command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000, maxCalls: 20, maxReportedTokens: 100000 } });
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef, environment,
    pilot: readerPilot(f.store, project)!, dispatch: { ...environment.value, workspace: f.root } };
}
type Planned = ReturnType<typeof planned>;
function nextEdition(f: Fixture, p: Planned) {
  const planQ = f.store.get<Question>(p.plan.id)!;
  f.discovery.reopen(planQ.id, planQ.revision);
  const src = f.discovery.evidence.document(p.project, "basis-2", `Second source for ${p.project}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, p.project, f.store.get<DiscoveryDraft>(p.draft.id)!, f.store.get<Question>(planQ.id)!,
    validPlan(p.frameRef, ["q-supply", "q-market"], 2, p.planAnswer), src);
  return f.store.get<Question>(planQ.id)!.value.answer!;
}
/** The synthesis call context of one subject (S2's transport form). */
const contextOf = (subject: V7PlanSubject) => ({ role: "research", stage: "discovery", subject,
  inventory: { sources: [] }, history: [], contextWorkspace: [] });
const run = (f: Fixture, p: Planned, context: Record<string, any>) => synthesisSession(f.store, p.draft, p.plan,
  p.environment, p.dispatch, p.pilot, context, "Synthesize the exact plan-question");
const history = (store: Store) => store.list().map(row => [row.id, row.revision, row.hash]);

test("S5 creation (S1→S5): the real producer writes exactly the v3 projector's first record at its address, prepares its subject's step and stays unpaid while paid admission is closed", async t => {
  const f = fixture(t), p = planned(f, "s5-create");
  const A = subjectOf(p.planAnswer, "q-supply");
  assert.equal(await code(() => run(f, p, contextOf(A))), "research_v7_mode_unavailable");
  const sessions = f.store.list<any>("synthesis-session");
  const expected = projectSynthesisSessionV3Initial({ projectId: p.project, binding: { draft: reference(p.draft),
    question: reference(p.plan), environment: reference(p.environment), inputs: p.draft.value.inputs, subject: A },
    basis: { materials: [], previousProposal: null, previousProposalRef: null }, delivery: null });
  assert.deepEqual(sessions.map(session => [session.id, session.revision]), [[expected.id, 1]]);
  assert.deepEqual(sessions[0]!.value, expected.value, "exactly the shared projector's first record");
  const intents = f.store.list<any>("research-consumer-intent");
  assert.deepEqual(intents.map(intent => [intent.value.kind, intent.value.state, intent.value.owner.id]),
    [["synthesis", "prepared", expected.id]]);
  assert.deepEqual(intents[0]!.value.cursor.subject, A, "the step names exactly its session's subject");
  for (const kind of ["model-call", "model-request", "research-budget-ledger"]) assert.deepEqual(f.store.list(kind), [], `no ${kind}`);
  // A repeat continues the same unfinished session of the subject: no second session, no second step, no payment.
  assert.equal(await code(() => run(f, p, contextOf(A))), "research_v7_mode_unavailable");
  assert.equal(f.store.list("synthesis-session").length, 1);
  assert.equal(f.store.list("research-consumer-intent").length, 1);
});

test("S5 exact, cold and historical reads (S1→S5): the saved v3 session proves on saved bases in a new Store without writes, after a new plan edition too, and passes the store integrity check", async t => {
  const f = fixture(t), p = planned(f, "s5-read");
  const A = subjectOf(p.planAnswer, "q-supply");
  await code(() => run(f, p, contextOf(A)));
  const session = f.store.list<any>("synthesis-session")[0]!;
  const before = history(f.store);
  const cold = f.open();
  assert.deepEqual(readSynthesisSessionV3(cold, reference(session)), session);
  assert.deepEqual(history(cold), before, "the exact reader writes nothing");
  assert.deepEqual(checkStoreIntegrity(cold).findings.filter(finding => finding.id === session.id), []);
  nextEdition(f, p);
  assert.deepEqual(readSynthesisSessionV3(f.open(), reference(session)), session, "history reads by its own saved plan edition");
  // New work on the replaced edition is not sent as a new step of the current plan.
  const after = history(f.store);
  assert.equal(await code(() => run(f, p, contextOf(A))), "research_plan_subject_invalid");
  assert.deepEqual(history(f.store), after);
});

test("S5 subject isolation: A and B keep separate sessions and unfinished lookups; the v2 lookup never adopts a v3 session; a damaged subject refuses before any record", async t => {
  const f = fixture(t), p = planned(f, "s5-isolation");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const before = history(f.store);
  for (const damaged of [{ ...A, planQuestionId: "" }, null, { ...A, contract: "v7-plan-subject/v0" }, subjectOf(p.planAnswer, "q-unknown")])
    assert.equal(await code(() => run(f, p, { ...contextOf(A), subject: damaged })), "research_plan_subject_invalid", JSON.stringify(damaged));
  assert.deepEqual(history(f.store), before, "a refused subject wrote nothing");
  await code(() => run(f, p, contextOf(A)));
  await code(() => run(f, p, contextOf(B)));
  const ids = f.store.list<any>("synthesis-session").map(session => session.id);
  assert.equal(new Set(ids).size, 2, "two subjects, two sessions");
  const a = findUnfinishedSynthesisSessionV3(f.store, p.project, p.draft.id, A)!;
  const b = findUnfinishedSynthesisSessionV3(f.store, p.project, p.draft.id, B)!;
  assert.notEqual(a.session.id, b.session.id);
  assert.deepEqual([a.subject, b.subject], [A, B], "the operation returns its saved subject, not only a Question id");
  assert.equal(a.questionId, p.plan.id);
  assert.equal(findUnfinishedSynthesisSession(f.store, p.project, p.draft.id), null, "the v2 lookup never adopts a v3 session");
  // Negative corruption only: a later revision that swaps the saved subject is not a lawful transition.
  const head = f.store.get<any>(a.session.id)!;
  const forged = f.store.write({ id: head.id, kind: head.kind, expected: head.revision,
    value: { ...head.value, binding: { ...head.value.binding, subject: B } } });
  assert.equal(await code(async () => readSynthesisSessionV3(f.open(), reference(forged))), "synthesis_session_invalid");
});

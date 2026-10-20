import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from "../src/discovery/v7-contracts.js";
import { proveSynthesisSessionSubject } from "../src/discovery/synthesis-session.js";
import { projectSynthesisSessionV3Initial, synthesisSessionV3Address, synthesisSessionSubject, synthesisStepSubject,
  parseSynthesisSessionV3, projectCheckpointValue, projectCheckpointValueV2, proveCheckpointRecord,
  researchCheckpointV2Holds, projectSavedSynthesisV2, savedSynthesisV2Shape, savedSynthesisV2Id,
  projectSynthesisHandoffTurn, SYNTHESIS_SESSION_V2_PREFIX, SYNTHESIS_SESSION_V3_PREFIX,
  RESEARCH_CHECKPOINT_V2_PREFIX, type SynthesisSessionV3Origin } from "../src/discovery/research-consumer-transition.js";
import { V7_PLAN_SUBJECT_CONTRACT, questionDispatchId, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import { prepareResearchConsumerIntent } from "../src/discovery/response-recovery.js";
import { researchCall } from "../src/discovery/research-protocol.js";
import { uniqueTransactionGuards } from "../src/runtime/environment.js";
import { synthesisControls } from "../src/discovery/synthesis-controls.js";
import { contextWorkspace } from "../src/discovery/context-workspace.js";
import type { Environment } from "../src/runtime/environment.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import { answerDiscoveryFixture } from "./product-fixture.js";

// DR3a3-S1 (codex-omg №7690 решения 2, 3, 5, 8; §3 S1): the subject forms of
// v7 planner/synthesis — the v3 session, the v2 partial note, the v2 saved-only
// selection, the dispatch scope and the exact readers. These are STRUCTURAL
// tests of forms and readers: the v3 producer, its paid steps and the runner
// handoff are connected in S5/S6, so no test here is evidence of paid end-to-end
// execution. Every first record comes from the producer's own projector; the
// plan acceptance chain and the step-intent producer are the real ones.

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3a3s1-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

const failure = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return `${(error as EngineError).code}: ${(error as EngineError).message}`;
  }
  return "no-error";
};
const rand = () => Math.random().toString(16).slice(2);
const allAxes = (depth: string) => Object.fromEntries(V7_AXES.map(axis => [axis, { depth }]));
const validFrame = (): Json => ({ productType: "internal", scale: "30 users across 10 sites",
  industries: ["construction"], domains: ["materials supply", "equipment accounting"], axes: allAxes("deep"),
  budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } });
const planQuestion = (id: string, axis: string, cls = "supporting") => ({ id, axis, domain: "construction",
  text: `What covers ${id}?`, class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
  roles: ["domain expert"], searchPlaces: ["domain documents"] });
const validPlan = (frame: Ref, ids: string[], edition = 1, previous: Ref | null = null): Json =>
  ({ edition, frame, previous, questions: ids.map((id, i) => planQuestion(id, i ? "market" : "industry", i ? "supporting" : "blocking")) }) as unknown as Json;
function questionOf(store: Store, draft: Revision<DiscoveryDraft>, field: string): Revision<Question> {
  const question = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field);
  assert.ok(question, `question for ${field}`);
  return question;
}
const subjectOf = (planAnswer: Ref, planQuestionId: string): V7PlanSubject =>
  ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId });

/** The real plan acceptance chain, one exact source material and the project
 * environment — everything a first v3 record binds. */
function planned(f: Fixture, project: string, ids = ["q-supply", "q-market"]) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, ids), src);
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 30000 }, 0);
  const material = f.discovery.evidence.document(project, "material", "Supply terms with an exception", "text/plain", 0);
  const observation = f.discovery.evidence.observe(project, reference(material),
    { kind: "text-range", start: 0, end: material.value.content.length });
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef,
    frame: f.store.get<Question>(frame.id)!, environment, material, observation,
    materials: [{ kind: "context", value: observation }] as Record<string, any>[] };
}
type Planned = ReturnType<typeof planned>;
/** The next lawful plan edition: reopen and accept again (same ids). */
function nextEdition(f: Fixture, p: Planned, ids = ["q-supply", "q-market"]) {
  const planQ = f.store.get<Question>(p.plan.id)!;
  f.discovery.reopen(planQ.id, planQ.revision);
  const src = f.discovery.evidence.document(p.project, `basis-${rand()}`, `Source ${rand()}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, p.project, f.store.get<DiscoveryDraft>(p.draft.id)!, f.store.get<Question>(planQ.id)!,
    validPlan(p.frameRef, ids, 2, p.planAnswer), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(p.draft.id)!, plan, planAnswer: plan.value.answer! };
}
function origin(p: Planned, subject: V7PlanSubject, over: Partial<{ draft: Ref; question: Ref; environment: Ref;
  materials: Record<string, any>[] }> = {}): SynthesisSessionV3Origin {
  return { projectId: p.project, binding: { draft: over.draft ?? reference(p.draft), question: over.question ?? reference(p.plan),
    environment: over.environment ?? reference(p.environment), inputs: p.draft.value.inputs, subject },
  basis: { materials: over.materials ?? p.materials, previousProposal: null, previousProposalRef: null } };
}
/** The first step's call context exactly as the session producer builds it
 * (buildCallContext): controls, material cursor and the empty saved carry. */
const stepContext = (sessionId: string, materials: Record<string, any>[]) => {
  const workspace = contextWorkspace(undefined, undefined);
  return { dispatchMode: "synthesis", synthesisMaterials: materials, synthesisSession: sessionId,
    synthesisState: { offset: 0, materialOffset: 0 }, synthesisNotes: [], contextWorkspace: [], focus: null,
    contextControls: synthesisControls(false, workspace, 3, undefined), contextCheckpointedKeys: [] };
};
const snapshot = (store: Store) => canonical(store.list().map(reference));

test("S1 v3 address: one plan Question at two plan-questions and one id in two plan editions are different sessions; the environment is not task identity", t => {
  const f = fixture(t), p = planned(f, "dr3a3s1-address");
  const a = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-supply")));
  const b = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-market")));
  assert.ok(a.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX) && b.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX));
  assert.notEqual(a.id, b.id, "two plan-questions of one physical Question and the same materials are two tasks");
  assert.deepEqual(a.value.binding.question, b.value.binding.question);
  assert.equal(a.id, synthesisSessionV3Address({ projectId: p.project, draft: reference(p.draft), question: reference(p.plan),
    inputs: p.draft.value.inputs, subject: subjectOf(p.planAnswer, "q-supply"), materials: p.materials,
    previousProposal: null, previousProposalRef: null }), "the projector and the address formula agree");
  const next = nextEdition(f, p);
  const a2 = projectSynthesisSessionV3Initial({ ...origin(p, subjectOf(next.planAnswer, "q-supply")),
    binding: { ...origin(p, subjectOf(next.planAnswer, "q-supply")).binding, draft: reference(next.draft), question: reference(next.plan) } });
  assert.notEqual(a2.id, a.id, "the same plan-question id in another plan edition is another task");
  const environment = f.engine.environments.configure(p.project, { ...structuredClone(p.environment.value), timeoutMs: 31000 } as Environment, 1);
  const moved = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-supply"), { environment: reference(environment) }));
  assert.equal(moved.id, a.id, "the environment lives in the binding, not in the task address");
  assert.notDeepEqual(moved.value.binding.environment, a.value.binding.environment);
});

// Positive creation of a v3 session by its real producer, its exact/cold read without writes, the historical
// read after the plan moved on, anchor/subject substitution on a SAVED session and checkStoreIntegrity of a
// saved v3 move to S5 (codex-omg №7869, variant c): here sessions are in-memory inputs of structural checks.

test("S1 subject proof (structural, in memory): the session subject stands on the exact plan records of its edition — after the plan moved on too — and a foreign plan-question or a substituted plan anchor is refused", t => {
  const f = fixture(t), p = planned(f, "dr3a3s1-subject");
  const proof = (session: { id: string; value: unknown }) => failure(() => proveSynthesisSessionSubject(f.store, session));
  const lawful = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-supply")));
  const before = snapshot(f.store);
  assert.deepEqual(proveSynthesisSessionSubject(f.store, lawful), subjectOf(p.planAnswer, "q-supply"));
  assert.equal(snapshot(f.store), before, "the proof reads exact records only");
  const foreign = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-absent")));
  assert.match(proof(foreign), /^research_plan_subject_invalid: .*not in its accepted plan edition/);
  const frameAnchor = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-supply"), { question: reference(p.frame) }));
  assert.match(proof(frameAnchor), /^research_plan_subject_invalid: .*plan anchor/, "the frame Question is not a plan anchor");
  const lost = projectSynthesisSessionV3Initial(origin(p, subjectOf({ ...p.planAnswer, hash: "f".repeat(64) }, "q-supply")));
  assert.match(proof(lost), /^research_plan_subject_invalid: .*plan answer of the session subject is missing or changed/);
  // Historical: edition 2 is accepted; the edition-1 subject still proves by its own act, while a Question
  // answered by edition 2 is not the anchor of an edition-1 subject.
  const next = nextEdition(f, p);
  assert.notDeepEqual(f.store.get<Question>(p.plan.id)!.value.answer, p.planAnswer);
  assert.deepEqual(proveSynthesisSessionSubject(f.store, lawful), subjectOf(p.planAnswer, "q-supply"));
  const stale = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-supply"),
    { draft: reference(next.draft), question: reference(next.plan) }));
  assert.match(proof(stale), /^research_plan_subject_invalid: .*plan anchor/);
  const q = planned(f, "dr3a3s1-subject-other");
  const borrowed = projectSynthesisSessionV3Initial(origin(p, subjectOf(q.planAnswer, "q-supply")));
  assert.match(proof(borrowed), /^research_plan_subject_invalid: .*plan anchor/, "another project's plan is not this session's subject");
  // Control (codex-omg №7894): the plan Question reopened after acceptance answers nothing — not an anchor.
  f.discovery.reopen(p.plan.id, f.store.get<Question>(p.plan.id)!.revision);
  const reopened = projectSynthesisSessionV3Initial(origin(p, subjectOf(next.planAnswer, "q-supply"),
    { draft: reference(f.store.get<DiscoveryDraft>(p.draft.id)!), question: reference(f.store.get<Question>(p.plan.id)!) }));
  assert.match(proof(reopened), /^research_plan_subject_invalid: .*plan anchor/);
  // A v2 session has no subject to prove.
  const { subject: _s, ...v2Binding } = lawful.value.binding;
  assert.equal(proveSynthesisSessionSubject(f.store, { id: `${SYNTHESIS_SESSION_V2_PREFIX}${hashJson("v2")}`,
    value: { ...lawful.value, contract: "synthesis-session/v2", binding: v2Binding } }), null);
});

test("S1 forms (structural): the subject is mandatory and exact, the era is the address prefix together with the contract, and v2 never becomes v3 by one more field", t => {
  const f = fixture(t), p = planned(f, "dr3a3s1-forms");
  const lawful = projectSynthesisSessionV3Initial(origin(p, subjectOf(p.planAnswer, "q-supply")));
  const v3Id = `${SYNTHESIS_SESSION_V3_PREFIX}${hashJson("form")}`, v2Id = `${SYNTHESIS_SESSION_V2_PREFIX}${hashJson("form")}`;
  const subjectOfSession = (id: string, value: unknown) => failure(() => synthesisSessionSubject({ id, value }));
  const withSubject = (subject: unknown) => ({ ...lawful.value, binding: { ...lawful.value.binding, subject } });
  const { subject: _dropped, ...noSubject } = lawful.value.binding;
  // Absence: missing, null, damaged or unknown-contract subject is a refusal, never the v2 path.
  for (const value of [{ ...lawful.value, binding: noSubject }, withSubject(null),
    withSubject({ ...subjectOf(p.planAnswer, "q-supply"), extra: 1 }), withSubject({ ...subjectOf(p.planAnswer, "q-supply"), contract: "v7-plan-subject/v2" }),
    withSubject({ ...subjectOf(p.planAnswer, "q-supply"), planAnswer: { id: "x" } })]) {
    assert.match(subjectOfSession(v3Id, value), /^research_plan_subject_invalid: /);
    assert.equal(parseSynthesisSessionV3(value), null);
  }
  assert.match(failure(() => projectSynthesisSessionV3Initial({ ...origin(p, subjectOf(p.planAnswer, "q-supply")),
    binding: { ...noSubject } as any })), /^research_plan_subject_invalid: /, "the producer projector refuses a missing subject too");
  assert.match(failure(() => projectSynthesisSessionV3Initial({ ...origin(p, subjectOf(p.planAnswer, "q-supply")),
    workspace: { entries: [], sinceProgress: 0 } })), /^synthesis_session_invalid: .*direct session cannot inherit/);
  // Eras: the prefix and the contract agree; a v2 record never carries a subject.
  assert.match(subjectOfSession(v3Id, { ...lawful.value, contract: "synthesis-session/v2" }), /^synthesis_session_invalid: .*address era/);
  assert.match(subjectOfSession(v3Id, { ...lawful.value, contract: "synthesis-session/v4" }), /^synthesis_session_invalid: .*address era/);
  assert.match(subjectOfSession(v2Id, lawful.value), /^synthesis_session_invalid: .*address era/);
  assert.match(subjectOfSession(v2Id, { ...lawful.value, contract: "synthesis-session/v2" }),
    /^synthesis_session_invalid: .*pre-v3 synthesis session cannot carry a v7 plan subject/);
  assert.equal(synthesisSessionSubject({ id: v2Id, value: { ...lawful.value, contract: "synthesis-session/v2", binding: noSubject } }), null);
  assert.equal(parseSynthesisSessionV3({ ...lawful.value, contract: "synthesis-session/v2" }), null);
  assert.deepEqual(parseSynthesisSessionV3(lawful.value)?.binding.subject, subjectOf(p.planAnswer, "q-supply"));
  assert.deepEqual(synthesisSessionSubject(lawful), subjectOf(p.planAnswer, "q-supply"));
});

test("S1 session → step → handoff (structural): the step names exactly the session subject, the second O@1 producer takes that subject, and the unconnected v3 step stops before any consumer state while its paid send stays unavailable", async t => {
  const f = fixture(t), p = planned(f, "dr3a3s1-steps");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const session = projectSynthesisSessionV3Initial(origin(p, A));
  assert.deepEqual(synthesisStepSubject({ cursor: { subject: A } }, session), A);
  assert.match(failure(() => synthesisStepSubject({ cursor: { subject: B } }, session)),
    /^research_consumer_intent_invalid: .*another subject than its exact session/);
  assert.match(failure(() => synthesisStepSubject({ cursor: {} }, session)),
    /^research_consumer_intent_invalid: .*another subject than its exact session/, "a step without a subject is not a v3 step");
  assert.match(failure(() => synthesisStepSubject({ cursor: { subject: { ...A, planQuestionId: "" } } }, session)),
    /^research_consumer_intent_invalid: .*damaged plan subject/);
  const { subject: _s, ...v2Binding } = session.value.binding;
  const v2 = { id: `${SYNTHESIS_SESSION_V2_PREFIX}${hashJson("x")}`, value: { ...session.value, contract: "synthesis-session/v2", binding: v2Binding } };
  assert.equal(synthesisStepSubject({ cursor: {} }, v2), null, "a v2 step carries no subject");
  assert.match(failure(() => synthesisStepSubject({ cursor: { subject: A } }, v2)), /^research_consumer_intent_invalid: /,
    "a subject never attaches to a v2 session step");
  // The second producer of O@1 fixes the derived subject together with the attempt era.
  const end = { type: "refused", code: "source_unavailable", evidence: [reference(p.material)], text: "No primary source states it" };
  const turn = projectSynthesisHandoffTurn({ intent: { id: "research-consumer-intent:v1:x", revision: 1, hash: "a".repeat(64) },
    runId: "research-run:x", number: 2, question: reference(p.plan), subject: synthesisStepSubject({ cursor: { subject: A } }, session)!,
    action: { action: "answer", question: "q-supply", value: end, citations: [] } });
  assert.deepEqual(turn.subject, A);
  assert.equal(turn.attemptContract, "research-attempt-binding/v1");
  assert.match(failure(() => projectSynthesisHandoffTurn({ intent: { id: "research-consumer-intent:v1:x", revision: 1, hash: "a".repeat(64) },
    runId: "research-run:x", number: 2, question: reference(p.plan), subject: A,
    action: { action: "answer", question: p.plan.id, value: end, citations: [] } })), /^research_response_invalid: /,
  "K-01 class: the handoff answer addresses the plan-question id, not the Question id");
  // The v3 step is not connected before S5. Since S2 (codex-omg №7690 §3 S2) the packer carries the synthesis
  // role's subject, so the real intent producer no longer stops in its preflight: it stops at the exact guard
  // of its owner — the v3 session, whose producer is S5 — before any consumer state exists. The paid send of
  // the synthesis role stays closed (below).
  const dispatch = p.environment.value;
  const owner = { id: session.id, revision: 1, hash: hashJson(session.value) };
  assert.match(failure(() => prepareResearchConsumerIntent(f.store, { projectId: p.project, kind: "synthesis",
    key: `synthesis-step:${hashJson([session.id, owner])}`, owner, draft: reference(p.draft),
    question: reference(p.plan), role: dispatch.implementer, dispatch, profile: null,
    cursor: { sessionId: session.id, offset: 0, materialOffset: 0, materialEncoding: null, subject: A,
      context: stepContext(session.id, p.materials), prompt: "Return the declared research action",
      delivery: null }, basis: [owner], guards: uniqueTransactionGuards([owner, reference(p.draft), reference(p.plan)]) })),
  /^input_stale: /);
  for (const kind of ["research-consumer-intent", "model-call", "model-request", "request-manifest", "synthesis-session"])
    assert.deepEqual(f.store.list(kind), [], `the refused admission wrote no ${kind}`);
  await assert.rejects(researchCall(dispatch.implementer, dispatch, "Return the declared research action",
    stepContext(session.id, p.materials), undefined, { store: f.store, draftId: p.draft.id, questionId: p.plan.id, purpose: "analyst" }),
  { code: "research_v7_mode_unavailable" });
  for (const kind of ["model-call", "model-request", "research-budget-ledger"])
    assert.deepEqual(f.store.list(kind), [], `the closed paid send wrote no ${kind}`);
});

test("S1 one projector for writer and reader: the v2 partial note and the v2 saved-only selection are subject-scoped forms with their own addresses", t => {
  const f = fixture(t), p = planned(f, "dr3a3s1-notes");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const observe = (source: Ref, selector: any) => f.discovery.evidence.observe(p.project, source, selector);
  const citation = { source: reference(p.material), selector: { kind: "text-range" as const, start: 0, end: 12 } };
  const action = (question: string) => ({ question, value: { finding: "terms carry an exception", nested: { id: "x", revision: 1, hash: "0".repeat(64) } },
    citations: [citation], unresolved: ["the exception's scope"] });
  const note = projectCheckpointValueV2(p.project, reference(p.draft), reference(p.plan), A, action("q-supply"), observe);
  assert.ok(note.id.startsWith(RESEARCH_CHECKPOINT_V2_PREFIX));
  assert.equal(note.value.status, "unassessed");
  assert.deepEqual(note.value.question, reference(p.plan), "the record keeps the real Question Ref");
  assert.deepEqual(note.value.subject, A);
  assert.ok(researchCheckpointV2Holds(note.value));
  const noteB = projectCheckpointValueV2(p.project, reference(p.draft), reference(p.plan), B, action("q-market"), observe);
  assert.notEqual(noteB.id, note.id, "two plan-questions never share a note address");
  // K-01 class: the wire names the plan-question id, not the Question id — and the v1 formula does not accept it.
  assert.match(failure(() => projectCheckpointValueV2(p.project, reference(p.draft), reference(p.plan), A, action(p.plan.id), observe)),
    /^research_question_foreign: /);
  assert.match(failure(() => projectCheckpointValueV2(p.project, reference(p.draft), reference(p.plan), A, action("q-market"), observe)),
    /^research_question_foreign: /);
  assert.match(failure(() => projectCheckpointValue(p.project, reference(p.draft), reference(p.plan), action("q-supply"), observe)),
    /^research_question_foreign: /);
  // The exact prover re-derives the note by the same formula from its pinned sources (an explicit in-memory
  // revision — the v2 note producer is the S5 transition); a v2 value in the v1 address space is not lawful.
  const revision = (id: string, value: Record<string, any>): Revision<Record<string, any>> =>
    ({ id, kind: "research-checkpoint", revision: 1, hash: hashJson(value), value });
  const saved = revision(note.id, note.value), before = snapshot(f.store);
  proveCheckpointRecord(f.store, saved);
  const misplaced = revision(`research-checkpoint:${hashJson(note.value)}`, note.value);
  assert.match(failure(() => proveCheckpointRecord(f.store, misplaced)), /^context_lookup_integrity: /);
  assert.match(failure(() => proveCheckpointRecord(f.store, revision(note.id, { ...note.value, subject: null }))),
    /^context_lookup_integrity: .*exact subject form/);
  // S1-01 (codex-omg №7894): unresolved is the wire list of non-empty texts — a number, null, an object or a
  // Ref inside it is a damaged form: refused by the form check and by the exact prover, and at the projector input.
  for (const item of [17, null, { question: "unresolved" }, reference(p.material), ""]) {
    const value = { ...note.value, unresolved: [item] };
    assert.equal(researchCheckpointV2Holds(value), false, `unresolved item ${JSON.stringify(item)} is not text`);
    assert.match(failure(() => proveCheckpointRecord(f.store, revision(`${RESEARCH_CHECKPOINT_V2_PREFIX}${hashJson(value)}`, value))),
      /^context_lookup_integrity: .*exact subject form/);
    assert.match(failure(() => projectCheckpointValueV2(p.project, reference(p.draft), reference(p.plan), A,
      { ...action("q-supply"), unresolved: [item] as unknown as string[] }, observe)), /^research_response_invalid: .*non-empty texts/);
  }
  assert.equal(snapshot(f.store), before, "proving a note reads exact sources only");
  for (const broken of [{ ...note.value, subject: undefined }, { ...note.value, status: "accepted" }, { ...note.value, extra: true },
    { ...note.value, subject: { ...A, planQuestionId: 7 } }])
    assert.equal(researchCheckpointV2Holds(JSON.parse(JSON.stringify(broken))), false);
  // Saved-only (решение 3): its own address from project+subject; the selection names only distinct v2 notes.
  const selection = projectSavedSynthesisV2({ projectId: p.project, draft: reference(p.draft), question: reference(p.plan),
    inputs: p.draft.value.inputs, subject: A, checkpoints: [reference(saved)] });
  assert.equal(selection.id, savedSynthesisV2Id(p.project, A));
  assert.notEqual(savedSynthesisV2Id(p.project, B), selection.id);
  assert.notEqual(savedSynthesisV2Id(p.project, subjectOf(nextEdition(f, p).planAnswer, "q-supply")), selection.id,
    "another plan edition is another saved-only selection");
  assert.match(failure(() => savedSynthesisV2Shape({ ...selection.value, checkpoints: [] }, selection.id)), /^saved_synthesis_missing: /);
  assert.match(failure(() => savedSynthesisV2Shape({ ...selection.value, checkpoints: [reference(misplaced)] }, selection.id)), /^saved_synthesis_stale: /);
  assert.match(failure(() => savedSynthesisV2Shape({ ...selection.value, checkpoints: [reference(saved), reference(saved)] }, selection.id)), /^saved_synthesis_stale: /);
  assert.match(failure(() => savedSynthesisV2Shape(selection.value, savedSynthesisV2Id(p.project, B))), /^saved_synthesis_stale: .*address/);
  assert.match(failure(() => savedSynthesisV2Shape({ ...selection.value, subject: null }, selection.id)), /^research_plan_subject_invalid: /);
  assert.match(failure(() => savedSynthesisV2Shape({ ...selection.value, extra: 1 }, selection.id)), /^saved_synthesis_stale: /);
});

test("S1 registry: the subject plan answer and the declared references are visible; ref-shaped JSON inside proposals, notes and results stays data", t => {
  const f = fixture(t), p = planned(f, "dr3a3s1-sites");
  const A = subjectOf(p.planAnswer, "q-supply"), refShaped = { id: "fixture-shaped", revision: 1, hash: "0".repeat(64) };
  const a = projectSynthesisSessionV3Initial(origin(p, A));
  const session = { ...a.value, result: { action: "answer", question: "q-supply",
    value: { type: "duplicate", of: refShaped }, citations: [] },
  notes: [{ checkpoint: reference(p.plan), proposal: { action: "checkpoint", question: "q-supply", value: { nested: refShaped },
    citations: [], unresolved: [] }, page: { offset: 0, end: 1 } }] };
  const sites = referenceSites("synthesis-session", session);
  assert.ok(sites.some(site => site.field === "binding.subject.planAnswer" && canonical(site.ref) === canonical(p.planAnswer)));
  assert.ok(sites.some(site => site.field === "basis.materials[0].value.source"));
  assert.equal(sites.some(site => site.ref.id === refShaped.id), false, "the model's proposed end and notes are data");
  const note = projectCheckpointValueV2(p.project, reference(p.draft), reference(p.plan), A,
    { question: "q-supply", value: { nested: refShaped }, citations: [{ source: reference(p.material),
      selector: { kind: "text-range", start: 0, end: 5 } }], unresolved: [] },
    (source, selector) => f.discovery.evidence.observe(p.project, source, selector));
  const noteSites = referenceSites("research-checkpoint", note.value).map(site => site.field).sort();
  assert.deepEqual(noteSites, ["draft", "observations[0].source", "question", "subject.planAnswer"]);
  const selection = projectSavedSynthesisV2({ projectId: p.project, draft: reference(p.draft), question: reference(p.plan),
    inputs: p.draft.value.inputs, subject: A, checkpoints: [{ id: note.id, revision: 1, hash: hashJson(note.value) }] });
  assert.deepEqual(referenceSites("saved-synthesis", selection.value).map(site => site.field).sort(),
    ["checkpoints[0]", "draft", ...p.draft.value.inputs.map((_, i) => `inputs[${i}]`), "question", "subject.planAnswer"].sort());
});

test("S1 dispatch identity: one formula — the subject scope of C for a plan-question, the unchanged Question counter otherwise", t => {
  const f = fixture(t), p = planned(f, "dr3a3s1-dispatch");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  assert.equal(questionDispatchId(p.project, p.plan.id, null), `question-dispatch:${hashJson(p.plan.id)}`, "the v6 counter is unchanged");
  assert.equal(questionDispatchId(p.project, p.plan.id, A), `question-dispatch:${hashJson([p.project, A] as unknown as Json)}`);
  assert.notEqual(questionDispatchId(p.project, p.plan.id, A), questionDispatchId(p.project, p.plan.id, B));
  assert.notEqual(questionDispatchId(p.project, p.plan.id, A), questionDispatchId(p.project, p.plan.id, null));
  assert.equal(questionDispatchId(p.project, p.plan.id, A),
    questionDispatchId(p.project, "another-question", { planQuestionId: A.planQuestionId, planAnswer: A.planAnswer, contract: A.contract }),
    "the subject scope does not depend on the physical Question id or key order");
});

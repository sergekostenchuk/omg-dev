import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from "../src/discovery/v7-contracts.js";
import { configureV7SavedSynthesis, notesInProvenOrder, provenSubjectSessions, savedV7SynthesisMaterials, selectSavedCheckpointsV2,
  savedSynthesisMaterials } from "../src/discovery/saved-synthesis.js";
import { recoverContextSession, recoveryRecordSubjectHolds } from "../src/discovery/context-recovery.js";
import { readSynthesisSessionV3 } from "../src/discovery/synthesis-session.js";
import { latestFocus, latestProposal, workingSelections } from "../src/discovery/research-continuation.js";
import { projectCheckpointValueV2, projectSavedSynthesisV2, projectSynthesisSessionV3Initial, RESEARCH_CHECKPOINT_V2_CONTRACT,
  SYNTHESIS_SESSION_CONTRACT_V3, type SynthesisSessionStateV3 } from "../src/discovery/research-consumer-transition.js";
import { V7_PLAN_SUBJECT_CONTRACT, ATTEMPT_BINDING_CONTRACT, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import type { ResearchTurn } from "../src/discovery/research-model.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import { answerDiscoveryFixture } from "./product-fixture.js";

// DR3a3-S4 (codex-omg №7690 §3 S4; решения 3, 5, 6): saved-only of one v7
// subject, its subject-aware history and the v3 operator recovery rule. The
// plan comes from its real producers. A lawful synthesis-session/v3 with notes
// and its research-checkpoint/v2 have no producer before S5, so the selection
// is checked on in-memory proven-session values, and the saved-only choice on
// lawful notes moves to S5 (the boundary of №7869 S1→S5 and №8173 S3→S6).

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3a3s4-saved-"));
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, engine, discovery };
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
/** A read-only view over in-memory revisions — no Store, no write. */
function view(rows: Revision<any>[]): Store {
  const get = (id: string, revision?: number) => {
    const all = rows.filter(row => row.id === id);
    return revision === undefined ? all.sort((a, b) => b.revision - a.revision)[0] ?? null
      : all.find(row => row.revision === revision) ?? null;
  };
  return { get, list: (kind?: string) => [...new Set(rows.map(row => row.id))].map(id => get(id)!)
    .filter(row => kind === undefined || row.kind === kind) } as unknown as Store;
}

/** The real plan acceptance chain (frame and plan through #answer). */
function planned(f: Fixture, project: string) {
  f.engine.execute({ type: "create-project", project, title: project });
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, ["q-supply", "q-market"]), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
type Planned = ReturnType<typeof planned>;
/** The next lawful plan edition: reopen and accept again. */
function nextEdition(f: Fixture, p: Planned) {
  const planQ = f.store.get<Question>(p.plan.id)!;
  f.discovery.reopen(planQ.id, planQ.revision);
  const src = f.discovery.evidence.document(p.project, "basis-2", `Second source for ${p.project}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, p.project, f.store.get<DiscoveryDraft>(p.draft.id)!, f.store.get<Question>(planQ.id)!,
    validPlan(p.frameRef, ["q-supply", "q-market"], 2, p.planAnswer), src);
  return f.store.get<Question>(planQ.id)!.value.answer!;
}

test("S4 command: the parser→engine path and the direct API give one refusal for a missing, null, damaged, foreign, unknown or superseded subject; a proven answered anchor reaches saved_synthesis_missing", t => {
  const f = fixture(t), p = planned(f, "s4-cmd"), q = planned(f, "s4-other");
  const A = subjectOf(p.planAnswer, "q-supply");
  const both = (subject: unknown, project = p.project) => {
    const command: Record<string, unknown> = { type: "configure-v7-saved-synthesis", project, expected: 0 };
    if (subject !== undefined) command.subject = subject;
    return [code(() => f.engine.execute(command)), code(() => configureV7SavedSynthesis(f.store, project, subject, 0))];
  };
  const history = () => f.store.list().map(row => [row.id, row.revision, row.hash]);
  const before = history();
  for (const [name, subject] of [["missing", undefined], ["null", null], ["Question id string", p.plan.id],
    ["damaged", { ...A, planQuestionId: "" }], ["unknown contract", { ...A, contract: "v7-plan-subject/v0" }],
    ["foreign project", subjectOf(q.planAnswer, "q-supply")], ["unknown plan-question", subjectOf(p.planAnswer, "q-unknown")],
    ["forged plan answer", subjectOf({ ...p.planAnswer, hash: hashJson("forged") }, "q-supply")]] as [string, unknown][])
    assert.deepEqual(both(subject), ["research_plan_subject_invalid", "research_plan_subject_invalid"], name);
  // The answered plan anchor is the v7 norm: a proven current subject reaches the selection, which finds no note.
  assert.deepEqual(both(A), ["saved_synthesis_missing", "saved_synthesis_missing"]);
  assert.deepEqual(history(), before, "no refusal wrote anything");
  // A replaced plan edition is not a new saved-only choice; its successor's subject is proven again.
  const second = nextEdition(f, p);
  assert.deepEqual(both(A), ["research_plan_subject_invalid", "research_plan_subject_invalid"], "superseded edition");
  assert.deepEqual(both(subjectOf(second, "q-supply")), ["saved_synthesis_missing", "saved_synthesis_missing"]);
  assert.deepEqual(f.store.list("saved-synthesis"), []);
  // The field-path command never chooses for a v7 draft, even on a reopened plan Question whose v2 notes share it.
  const planQ = f.store.get<Question>(p.plan.id)!;
  f.discovery.reopen(planQ.id, planQ.revision);
  assert.equal(code(() => f.engine.execute({ type: "configure-saved-synthesis", project: p.project, question: planQ.id, expected: 0 })),
    "research_question_foreign");
  assert.deepEqual(f.store.list("saved-synthesis"), []);
});

test("S4 selection in memory: A never takes B's or another edition's notes, takes only the active frontier in session order, and two noted sessions of one subject are ambiguous", () => {
  const answer: Ref = { id: "research-answer:plan", revision: 1, hash: hashJson("plan-1") };
  const edition2: Ref = { id: "research-answer:plan", revision: 2, hash: hashJson("plan-2") };
  const A = subjectOf(answer, "q-supply"), B = subjectOf(answer, "q-market"), A2 = subjectOf(edition2, "q-supply");
  const note = (name: string, extra: Record<string, unknown> = {}) => ({ checkpoint: { id: `research-checkpoint:v2:${name}`, revision: 1,
    hash: hashJson(name) }, proposal: { action: "checkpoint", question: "q", value: name, citations: [], unresolved: ["open"] },
    page: { offset: 0, end: 1 }, ...extra });
  const session = (name: string, subject: V7PlanSubject, notes: unknown[]) => memo(`synthesis-session:v3:${name}`, "synthesis-session", 1,
    { contract: SYNTHESIS_SESSION_CONTRACT_V3, projectId: "p", offset: 0, notes, result: null,
      binding: { draft: answer, question: answer, environment: answer, inputs: [], subject } } as unknown as SynthesisSessionStateV3);
  const a1 = note("a1"), a2 = note("a2"), b1 = note("b1"), e1 = note("e1");
  const sessions = [session("a", A, [a1, a2]), session("b", B, [b1]), session("a2", A2, [e1])];
  assert.deepEqual(selectSavedCheckpointsV2(sessions, A)!.checkpoints, [a1.checkpoint, a2.checkpoint]);
  assert.deepEqual(selectSavedCheckpointsV2(sessions, B)!.checkpoints, [b1.checkpoint]);
  assert.deepEqual(selectSavedCheckpointsV2(sessions, A2)!.checkpoints, [e1.checkpoint], "another edition is another subject");
  // A consolidated note replaces its originals: only the active frontier is the saved selection.
  const merged = note("a12", { consolidated: { replaces: [a1.checkpoint, a2.checkpoint] } });
  assert.deepEqual(selectSavedCheckpointsV2([session("a", A, [a1, a2, merged])], A)!.checkpoints, [merged.checkpoint]);
  assert.equal(selectSavedCheckpointsV2([session("a", A, []), sessions[1]!], A), null, "no note is no selection");
  assert.equal(code(() => selectSavedCheckpointsV2([...sessions, session("a-other", A, [note("x")])], A)), "research_synthesis_ambiguous");
  // A saved choice reads only one proven session's notes in their proven order (S4-01).
  const order = [a1.checkpoint, a2.checkpoint, merged.checkpoint];
  assert.equal(notesInProvenOrder(order, [a1.checkpoint, a2.checkpoint]), true);
  assert.equal(notesInProvenOrder(order, [merged.checkpoint]), true, "a later frontier of the same session");
  assert.equal(notesInProvenOrder(order, [a2.checkpoint, a1.checkpoint]), false, "reordered");
  assert.equal(notesInProvenOrder(order, [a1.checkpoint, b1.checkpoint]), false, "mixed with another session's note");
  assert.equal(notesInProvenOrder(order, []), false, "an empty choice");
});

test("S4 reader: no choice is null; a choice of another subject, form or basis is stale; a lost note version refuses; the v1 reader and address stay apart", t => {
  const f = fixture(t), p = planned(f, "s4-read");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  assert.equal(savedV7SynthesisMaterials(f.store, p.draft, p.plan, A), null);
  assert.equal(savedSynthesisMaterials(f.store, p.draft, p.plan), null, "the v1 address of the Question is untouched");
  assert.equal(code(() => savedV7SynthesisMaterials(f.store, p.draft, p.plan, { ...A, planQuestionId: "" })), "research_plan_subject_invalid");
  // Negative corruption only: forged saved-only records are written to demand their refusal.
  const lost: Ref = { id: `research-checkpoint:v2:${hashJson("lost")}`, revision: 1, hash: hashJson("lost") };
  const choice = (subject: V7PlanSubject, overrides: Record<string, unknown> = {}) => projectSavedSynthesisV2({ projectId: p.project,
    draft: reference(p.draft), question: reference(p.plan), inputs: p.draft.value.inputs, subject, checkpoints: [lost], ...overrides });
  const forgedA = choice(A);
  const written = f.store.write({ id: forgedA.id, kind: "saved-synthesis", expected: 0, value: forgedA.value });
  // S4-01: the origin is proven before the note is read — a note no proven session wrote refuses first.
  assert.equal(code(() => savedV7SynthesisMaterials(f.store, p.draft, p.plan, A)), "saved_synthesis_stale", "no proven origin");
  f.store.write({ id: forgedA.id, kind: "saved-synthesis", expected: written.revision, value: { ...forgedA.value, subject: B } });
  assert.equal(code(() => savedV7SynthesisMaterials(f.store, p.draft, p.plan, A)), "saved_synthesis_stale", "another subject at A's address");
  f.store.write({ id: forgedA.id, kind: "saved-synthesis", expected: written.revision + 1, value: { ...forgedA.value, inputs: [p.planAnswer] } });
  assert.equal(code(() => savedV7SynthesisMaterials(f.store, p.draft, p.plan, A)), "saved_synthesis_stale", "another basis");
  assert.equal(savedSynthesisMaterials(f.store, p.draft, p.plan), null, "the v1 reader never reads the v2 form");
  assert.equal(code(() => projectSavedSynthesisV2({ projectId: p.project, draft: reference(p.draft), question: reference(p.plan),
    inputs: [], subject: A, checkpoints: [] })), "saved_synthesis_missing");
});

test("S4 v3 recovery rule: a reader-result is shared, a checkpoint is only a v2 note of the session's own subject", () => {
  const answer: Ref = { id: "research-answer:plan", revision: 1, hash: hashJson("plan-1") };
  const A = subjectOf(answer, "q-supply"), B = subjectOf(answer, "q-market");
  const checkpointV2 = (subject: V7PlanSubject) => memo(`research-checkpoint:v2:${subject.planQuestionId}`, "research-checkpoint", 1,
    { contract: RESEARCH_CHECKPOINT_V2_CONTRACT, projectId: "p", draft: answer, question: answer, subject, status: "unassessed",
      proposal: {}, observations: [], unresolved: ["open"] } as Record<string, any>);
  const v1 = memo("research-checkpoint:v1", "research-checkpoint", 1,
    { projectId: "p", draft: answer, question: answer, status: "unassessed", proposal: {}, observations: [], unresolved: [] } as Record<string, any>);
  const reader = memo("reader-result:x", "reader-result", 1, { projectId: "p" } as Record<string, any>);
  assert.equal(recoveryRecordSubjectHolds(checkpointV2(A), A), true);
  assert.equal(recoveryRecordSubjectHolds(checkpointV2(B), A), false, "another subject's note is foreign");
  assert.equal(recoveryRecordSubjectHolds(v1, A), false, "a field-path note of the same Question is foreign");
  assert.equal(recoveryRecordSubjectHolds({ ...checkpointV2(A), value: { ...checkpointV2(A).value, subject: null } }, A), false);
  assert.equal(recoveryRecordSubjectHolds(reader, A), true, "the common reader's exact result is shared (решение 6)");
});

test("S4 history in memory: focus, selections and proposal are chosen among the subject's own turns before 'latest'; without a subject the caller's turns are read as before", t => {
  const f = fixture(t), p = planned(f, "s4-history");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const turn = (number: number, subject: V7PlanSubject | null, action: unknown, observation: unknown) =>
    memo<ResearchTurn>(`research-turn:s4-${number}`, "research-turn", 2, { run: "run", number, action, assessment: null,
      observation, error: null, status: "completed", question: reference(p.plan),
      ...(subject ? { subject, attemptContract: ATTEMPT_BINDING_CONTRACT } : {}) } as ResearchTurn);
  const end = (question: string) => ({ action: "answer", question, citations: [],
    value: { type: "impossible", code: "source_unavailable", evidence: [], text: "No accessible source" } });
  // The latest turn of a history decides its focus (the legacy rule): A answered, then read again.
  const turns = [turn(1, A, end("q-supply"), null), turn(2, A, { action: "search", query: "supply A" }, { query: "A" }),
    turn(3, B, { action: "search", query: "market B" }, { query: "B" })];
  const store = view(turns);
  assert.deepEqual(latestFocus(store, turns, p.plan, A), { query: "A" }, "B's later read is not A's focus");
  assert.deepEqual(latestFocus(store, turns, p.plan, B), { query: "B" });
  assert.deepEqual(latestFocus(store, turns, p.plan), { query: "B" }, "without a subject the caller's selection is read as before");
  assert.deepEqual(latestProposal(turns, "q-supply", A), end("q-supply"));
  assert.equal(latestProposal(turns, "q-supply", B), null, "A's attempt is never B's proposal");
  assert.deepEqual(workingSelections(store, turns, p.plan, B).map(item => item.value), [{ query: "B" }]);
  assert.deepEqual(workingSelections(store, turns, p.plan, A).map(item => item.value), [{ query: "A" }],
    "A's selections are its own reads after its own answer");
});

test("S4-01: a forged note and choice with a real plan and source but no paid transition never become saved findings", t => {
  const f = fixture(t), p = planned(f, "s4-origin");
  const A = subjectOf(p.planAnswer, "q-supply");
  const source = f.discovery.evidence.document(p.project, "injection-source", "A real source, but no paid synthesis happened.", "text/plain", 0);
  const projected = projectCheckpointValueV2(p.project, reference(p.draft), reference(p.plan), A,
    { question: "q-supply", value: { text: "Injected proposal" },
      citations: [{ source: reference(source), selector: { kind: "text-range", start: 0, end: 10 } }], unresolved: ["unassessed"] },
    (ref, selector) => f.discovery.evidence.observe(p.project, ref, selector));
  // Deliberate negative corruption only: a well-formed note and choice written without their producers.
  const note = f.store.write({ id: projected.id, kind: "research-checkpoint", expected: 0, value: projected.value });
  const choice = projectSavedSynthesisV2({ projectId: p.project, draft: reference(p.draft), question: reference(p.plan),
    inputs: p.draft.value.inputs, subject: A, checkpoints: [reference(note)] });
  f.store.write({ id: choice.id, kind: "saved-synthesis", expected: 0, value: choice.value });
  assert.deepEqual([f.store.list("synthesis-session").length, f.store.list("research-consumer-intent").length], [0, 0]);
  assert.equal(provenSubjectSessions(f.store, A).notes.size, 0, "no proven session, no proven note");
  assert.equal(code(() => savedV7SynthesisMaterials(f.store, p.draft, p.plan, A)), "saved_synthesis_stale",
    "the form of a note is not its paid origin");
});

test("S4-02: a v3 session with a forged blocked marker is refused by the full chain reader before any recovery revision", t => {
  const f = fixture(t), p = planned(f, "s4-blocked");
  const A = subjectOf(p.planAnswer, "q-supply");
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = f.engine.environments.configure(p.project, { workspace: f.root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 30000 }, 0);
  f.engine.execute({ type: "configure-reader-pilot", project: p.project, expected: 0, settings: { experimental: true, active: true,
    stopAfter: "L2", reader: { actor: "reader", model: "fixture", effort: "high", speed: "inherited", command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000, maxCalls: 20, maxReportedTokens: 100000 } });
  const initial = projectSynthesisSessionV3Initial({ projectId: p.project, binding: { draft: reference(p.draft), question: reference(p.plan),
    environment: reference(environment), inputs: p.draft.value.inputs, subject: A },
    basis: { materials: [], previousProposal: null, previousProposalRef: null } });
  // Deliberate negative corruption only: a lawful binding with a blocked workspace no paid transition produced.
  const forged = f.store.write({ id: initial.id, kind: "synthesis-session", expected: 0,
    value: { ...initial.value, workspace: { entries: [], sinceProgress: 2, blocked: "forged block without paid transition" } } });
  assert.equal(code(() => readSynthesisSessionV3(f.store, reference(forged))), "synthesis_session_invalid", "control");
  const before = f.store.list().map(row => [row.id, row.revision, row.hash]);
  assert.equal(code(() => recoverContextSession(f.store, p.project, reference(forged), { record: reference(p.draft), pointer: "/fields" })),
    "synthesis_session_invalid", "a proven subject alone does not authorize a recovery");
  assert.equal(code(() => f.engine.execute({ type: "recover-context-session", project: p.project, session: reference(forged),
    selector: { record: reference(p.draft), pointer: "/fields" } })), "synthesis_session_invalid", "the same refusal through the command");
  assert.deepEqual(f.store.list().map(row => [row.id, row.revision, row.hash]), before, "no recovery revision");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from "../src/discovery/v7-contracts.js";
import { prepareResearchEnvelope, researchCall, V7_FINAL_SYNTHESIS_INSTRUCTION } from "../src/discovery/research-protocol.js";
import { researchCapacityInput, resultCapacityFrom } from "../src/discovery/early-research-outcome.js";
import { invocationProgress } from "../src/discovery/invocation-progress.js";
import { synthesisControls, FINAL_SYNTHESIS_INSTRUCTION } from "../src/discovery/synthesis-controls.js";
import { contextWorkspace } from "../src/discovery/context-workspace.js";
import { CONSOLIDATION_INSTRUCTION } from "../src/discovery/conclusion-consolidation.js";
import { projectSynthesisSessionV3Initial } from "../src/discovery/research-consumer-transition.js";
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import { EngineError } from "../src/errors.js";
import { canonical, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import { answerDiscoveryFixture } from "./product-fixture.js";

// DR3a3-S2 (codex-omg №7690 §3 S2): the transport of the v7 synthesis roles —
// synthesis pages, the final page and consolidation — carries one exact plan
// subject and its own action contract. The packer is the real preflight
// builder; the plan chain, sources and environment come from their real
// producers. The paid admission of these roles is connected in S5/S6, so the
// last check proves it is still closed before any adapter or ledger.

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3a3s2-syn-"));
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
  ({ edition, frame, previous, questions: ids.map((id, i) => planQuestion(id, i ? "market" : "industry", i ? "supporting" : "blocking")) }) as unknown as Json;
const questionOf = (store: Store, draft: Revision<DiscoveryDraft>, field: string) =>
  draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
const subjectOf = (planAnswer: Ref, planQuestionId: string): V7PlanSubject =>
  ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId });
const failure = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return `${(error as EngineError).code}: ${(error as EngineError).message}`;
  }
  return "no-error";
};

function planned(f: Fixture, project: string) {
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
  const material = f.discovery.evidence.document(project, "material", "Supply terms with an exception", "text/plain", 0);
  const observation = f.discovery.evidence.observe(project, reference(material), { kind: "text-range", start: 0, end: material.value.content.length });
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef, environment,
    materials: [{ kind: "context", value: observation }] as Record<string, any>[] };
}
type Planned = ReturnType<typeof planned>;
/** The next lawful plan edition with the same plan-question ids: reopen and accept again. */
function nextEdition(f: Fixture, p: Planned) {
  f.discovery.reopen(p.plan.id, f.store.get<Question>(p.plan.id)!.revision);
  const src = f.discovery.evidence.document(p.project, "basis-2", "Second source", "text/plain", 0);
  answerDiscoveryFixture(f.engine, p.project, f.store.get<DiscoveryDraft>(p.draft.id)!, f.store.get<Question>(p.plan.id)!,
    validPlan(p.frameRef, ["q-supply", "q-market"], 2, p.planAnswer), src);
  const plan = f.store.get<Question>(p.plan.id)!;
  return { ...p, draft: f.store.get<DiscoveryDraft>(p.draft.id)!, plan, planAnswer: plan.value.answer! };
}

/** The synthesis-family call context exactly as the session producer builds it. */
function synthesisContext(p: Planned, subject: V7PlanSubject, mode: "synthesis" | "final" | "consolidation") {
  const session = projectSynthesisSessionV3Initial({ projectId: p.project, binding: { draft: reference(p.draft),
    question: reference(p.plan), environment: reference(p.environment), inputs: p.draft.value.inputs, subject },
  basis: { materials: p.materials, previousProposal: null, previousProposalRef: null } });
  const workspace = contextWorkspace(undefined, undefined);
  return { dispatchMode: mode === "consolidation" ? "consolidation" : "synthesis", synthesisMaterials: p.materials,
    synthesisSession: session.id, synthesisState: { offset: mode === "final" ? 1 : 0, materialOffset: 0 }, synthesisNotes: [],
    contextWorkspace: [], focus: null, contextControls: synthesisControls(mode === "final", workspace, undefined),
    contextCheckpointedKeys: [],
    ...(mode === "consolidation" ? { consolidation: { targetChars: 4000, fullTargetChars: 8000, format: 2 } } : {}) };
}
function pack(f: Fixture, p: Planned, subject: V7PlanSubject | null, mode: "synthesis" | "final" | "consolidation",
  overrides: { capacityPurpose?: string; bindings?: Record<string, unknown>; context?: Record<string, any> } = {}) {
  const context = overrides.context ?? synthesisContext(p, subject ?? subjectOf(p.planAnswer, "q-supply"), mode);
  const purpose = overrides.capacityPurpose ?? (mode === "consolidation" ? "consolidation" : "synthesis");
  const capacity = resultCapacityFrom(researchCapacityInput({ operation: `op-${mode}`, generation: 0,
    bindings: overrides.bindings ?? { projectId: p.project, draft: reference(p.draft), question: reference(p.plan), ...(subject ? { subject } : {}) },
    role: "synthesizer", purpose, actionMode: mode === "consolidation" ? "consolidation" : "synthesis",
    limit: 200000, prompt: "Synthesize the plan-question", binding: p.environment.value.implementer, draft: p.draft.value,
    question: { id: p.plan.id, value: p.plan.value }, context }));
  return prepareResearchEnvelope(p.environment.value.implementer, p.environment.value, "Synthesize the plan-question", context,
    { store: f.store, draftId: p.draft.id, questionId: p.plan.id, purpose: "analyst" }, capacity as unknown as Record<string, any>);
}

test("S2 synthesis transport: material, final and consolidation pages carry one exact subject and the attempt-end contract, never the plan FieldSpec or answer_delta", t => {
  const f = fixture(t), p = planned(f, "s2-syn");
  const A = subjectOf(p.planAnswer, "q-supply");
  for (const mode of ["synthesis", "final", "consolidation"] as const) {
    const packed = pack(f, p, A, mode), subject = packed.subject as Record<string, any>;
    assert.deepEqual(subject.subject, A, `${mode}: the packet names its exact subject`);
    assert.equal(subject.question.id, "q-supply", `${mode}: the question is the plan-question, not the plan Question id`);
    assert.ok(Array.isArray(subject.question.schema?.oneOf), `${mode}: the result contract is the attempt-end schema`);
    assert.notEqual(subject.question.field, "plan");
    assert.deepEqual(subject.continuation.subject, A);
    assert.equal(subject.continuation.question, "q-supply");
    const forms = subject.resultCapacity.forms.map((form: { kind: string }) => form.kind);
    assert.equal(forms.includes("answer_delta"), false, `${mode}: an attempt has no answer_delta`);
    const projection = subject.resultCapacity.mandatory.projection.subject.question;
    assert.deepEqual(projection, { id: "q-supply", subject: A }, `${mode}: the declared projection is the plan-question, not the plan FieldSpec`);
    const archive = f.store.get<any>(subject.working.archive.id, subject.working.archive.revision)!;
    assert.deepEqual(archive.value.subject, A, `${mode}: the archive keeps the exact subject`);
    if (mode === "final") {
      assert.equal(packed.envelope.prompt, V7_FINAL_SYNTHESIS_INSTRUCTION);
      assert.equal(packed.envelope.prompt.includes("answer_delta only"), false);
      assert.ok(packed.envelope.prompt.includes("citations:[]"));
    }
    if (mode === "consolidation") assert.ok(packed.envelope.prompt.endsWith(CONSOLIDATION_INSTRUCTION));
  }
  // The v7 variant differs from the field-question instruction only by the end of the attempt.
  assert.notEqual(V7_FINAL_SYNTHESIS_INSTRUCTION, FINAL_SYNTHESIS_INSTRUCTION);
  assert.ok(FINAL_SYNTHESIS_INSTRUCTION.includes("answer/answer_delta"));
});

test("S2 synthesis transport: A/B, a new plan edition and another actor never share continuation or progress; the exact wire is reproducible", t => {
  const f = fixture(t), p = planned(f, "s2-syn-keys");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const a = pack(f, p, A, "synthesis"), again = pack(f, p, A, "synthesis"), b = pack(f, p, B, "synthesis");
  assert.equal(again.input, a.input, "the same saved inputs give the same exact wire");
  assert.notEqual(a.packetState!.id, b.packetState!.id, "two plan-questions of one Question never share continuation");
  const ctxA = synthesisContext(p, A, "synthesis"), ctxB = synthesisContext(p, B, "synthesis");
  const progress = (context: Record<string, any>, subject: V7PlanSubject, actor: string) =>
    invocationProgress(f.store, p.plan.id, "analyst", context, subject, actor).key;
  assert.notEqual(progress(ctxA, A, "author"), progress(ctxB, B, "author"));
  assert.notEqual(progress(ctxA, A, "author"), progress(ctxA, A, "another-author"), "another actor is another progress");
  assert.equal(progress(ctxA, A, "author"), progress(synthesisContext(p, A, "synthesis"), A, "author"));
  // The next plan edition with the same plan-question id is another subject: its own continuation and progress;
  // a fresh packet of the replaced edition is refused (a new send needs the current plan).
  const q = nextEdition(f, p), A2 = subjectOf(q.planAnswer, "q-supply");
  const a2 = pack(f, q, A2, "synthesis");
  assert.notEqual(a2.packetState!.id, a.packetState!.id);
  assert.notEqual(progress(synthesisContext(q, A2, "synthesis"), A2, "author"), progress(ctxA, A, "author"));
  assert.match(failure(() => pack(f, q, A, "synthesis")), /^research_plan_subject_invalid: /);
});

test("S2 synthesis transport: a role that differs from its admission, a role without a plan subject and a damaged subject are refused before any wire", t => {
  const f = fixture(t), p = planned(f, "s2-syn-forms");
  const A = subjectOf(p.planAnswer, "q-supply");
  const archives = f.store.list("research-context").length;
  // A synthesis admission over a context without its session is not a synthesis packet.
  const { synthesisSession: _s, ...withoutSession } = synthesisContext(p, A, "synthesis");
  assert.match(failure(() => pack(f, p, A, "synthesis", { context: withoutSession })), /^research_capacity_invalid: |^research_capacity_invalid/);
  // A consolidation admission over a material page.
  assert.match(failure(() => pack(f, p, A, "synthesis", { capacityPurpose: "consolidation" })), /^research_capacity_invalid: /);
  // Roles that never carry a plan subject.
  assert.match(failure(() => pack(f, p, A, "synthesis", { capacityPurpose: "reader" })), /^research_v7_mode_unavailable: /);
  // A damaged subject never becomes "no subject".
  assert.match(failure(() => pack(f, p, null, "synthesis", { bindings: { projectId: p.project, draft: reference(p.draft),
    question: reference(p.plan), subject: { ...A, planQuestionId: "" } } })), /^research_plan_subject_invalid: /);
  assert.equal(f.store.list("research-context").length, archives, "a refused packet saved no archive");
});

test("S2 synthesis transport: the paid admission of v7 synthesis stays closed before any adapter or ledger", async t => {
  const f = fixture(t), p = planned(f, "s2-syn-paid");
  const A = subjectOf(p.planAnswer, "q-supply");
  const context = synthesisContext(p, A, "synthesis");
  await assert.rejects(researchCall(p.environment.value.implementer, p.environment.value, "Synthesize", context, undefined,
    { store: f.store, draftId: p.draft.id, questionId: p.plan.id, purpose: "analyst" }), { code: "research_v7_mode_unavailable" });
  for (const kind of ["model-call", "model-request", "research-budget-ledger", "research-budget"])
    assert.deepEqual(f.store.list(kind), [], `no ${kind}`);
  assert.equal(canonical(context.synthesisSession).length > 0, true);
});

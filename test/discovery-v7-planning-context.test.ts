import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from "../src/discovery/v7-contracts.js";
import { prepareResearchEnvelope, researchCall } from "../src/discovery/research-protocol.js";
import { researchCapacityInput, resultCapacityFrom } from "../src/discovery/early-research-outcome.js";
import { invocationProgress } from "../src/discovery/invocation-progress.js";
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import { EngineError } from "../src/errors.js";
import type { Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import { answerDiscoveryFixture } from "./product-fixture.js";

// DR3a3-S2 (codex-omg №7690 §3 S2): the transport of the v7 reading planner —
// its packet carries the exact plan subject, the plan-question as its contract
// (read_plan addresses the plan-question id) and its own continuation and
// progress; the analyst packet of the same subject (C) is its neighbour. The
// packer is the real preflight builder over real plan records; the paid
// admission of the planner is connected later and stays closed here.

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3a3s2-plan-"));
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
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef, environment };
}
type Planned = ReturnType<typeof planned>;

/** The reading-planner and analyst call context of the v7 path (R's form). */
const callContext = (subject: V7PlanSubject, planning: boolean) => ({ role: "research", stage: "discovery", subject,
  inventory: { sources: [] }, history: [], contextWorkspace: [], ...(planning ? { dispatchMode: "planning" } : {}) });
function pack(f: Fixture, p: Planned, subject: V7PlanSubject, role: "reading-planner" | "analyst",
  overrides: { auditPurpose?: string; context?: Record<string, any>; actor?: string } = {}) {
  const context = overrides.context ?? callContext(subject, role === "reading-planner");
  const capacity = resultCapacityFrom(researchCapacityInput({ operation: `op-${role}`, generation: 0,
    bindings: { projectId: p.project, draft: reference(p.draft), question: reference(p.plan), subject },
    role: "analyst", purpose: role, actionMode: role === "reading-planner" ? "planning" : role,
    limit: 200000, prompt: "Plan the reads of the plan-question", binding: p.environment.value.implementer, draft: p.draft.value,
    question: { id: p.plan.id, value: p.plan.value }, context }));
  const implementer = overrides.actor ? { ...p.environment.value.implementer, actor: overrides.actor } : p.environment.value.implementer;
  return prepareResearchEnvelope(implementer, p.environment.value, "Plan the reads of the plan-question", context,
    { store: f.store, draftId: p.draft.id, questionId: p.plan.id, purpose: overrides.auditPurpose ?? role },
    capacity as unknown as Record<string, any>);
}

test("S2 planner transport: the planner packet carries the exact subject, the plan-question contract and read_plan, never the plan FieldSpec or answer_delta", t => {
  const f = fixture(t), p = planned(f, "s2-plan");
  const A = subjectOf(p.planAnswer, "q-supply");
  const packed = pack(f, p, A, "reading-planner"), subject = packed.subject as Record<string, any>;
  assert.deepEqual(subject.subject, A);
  assert.equal(subject.question.id, "q-supply", "read_plan addresses the plan-question id");
  assert.notEqual(subject.question.field, "plan");
  assert.deepEqual(subject.continuation.subject, A);
  assert.equal(subject.continuation.role, "reading-planner");
  const forms = subject.resultCapacity.forms.map((form: { kind: string }) => form.kind);
  assert.ok(forms.includes("read_plan") && !forms.includes("answer_delta"), forms.join(","));
  assert.deepEqual(subject.resultCapacity.mandatory.projection.subject.question, { id: "q-supply", subject: A });
  assert.equal(packed.envelope.prompt, "Plan the reads of the plan-question", "the planner prompt is its own");
});

test("S2 planner transport: planner and analyst of one subject, A/B and two actors keep separate continuation and progress; the exact wire is reproducible", t => {
  const f = fixture(t), p = planned(f, "s2-plan-keys");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const planner = pack(f, p, A, "reading-planner"), analyst = pack(f, p, A, "analyst");
  assert.notEqual(planner.packetState!.id, analyst.packetState!.id, "two roles of one subject never share continuation");
  assert.notEqual(planner.packetState!.id, pack(f, p, B, "reading-planner").packetState!.id);
  assert.notEqual(planner.packetState!.id, pack(f, p, A, "reading-planner", { actor: "another-author" }).packetState!.id);
  assert.equal(pack(f, p, A, "reading-planner").input, planner.input, "the same saved inputs give the same exact wire");
  const key = (subject: V7PlanSubject, purpose: string, actor = "author") =>
    invocationProgress(f.store, p.plan.id, purpose, callContext(subject, purpose === "reading-planner"), subject, actor).key;
  assert.notEqual(key(A, "reading-planner"), key(A, "analyst"));
  assert.notEqual(key(A, "reading-planner"), key(B, "reading-planner"));
  assert.notEqual(key(A, "reading-planner"), key(A, "reading-planner", "another-author"));
});

test("S2 planner transport: a planner context declared by another role, and a damaged subject, are refused before any wire", t => {
  const f = fixture(t), p = planned(f, "s2-plan-forms");
  const A = subjectOf(p.planAnswer, "q-supply");
  const archives = f.store.list("research-context").length;
  assert.match(failure(() => pack(f, p, A, "reading-planner", { context: callContext(A, false) })), /^research_capacity_invalid: /,
    "a planner admission over an analyst context");
  assert.match(failure(() => pack(f, p, A, "reading-planner", { auditPurpose: "analyst" })), /^research_capacity_invalid: /);
  assert.match(failure(() => pack(f, p, A, "analyst", { context: callContext(A, true) })), /^research_capacity_invalid: /,
    "an analyst admission over a planning context");
  assert.match(failure(() => pack(f, p, { ...A, planAnswer: { id: "x" } as unknown as Ref }, "reading-planner")),
    /^research_plan_subject_invalid: /);
  assert.equal(f.store.list("research-context").length, archives, "a refused packet saved no archive");
});

test("S2 planner transport: the paid admission of the v7 reading planner stays closed before any adapter or ledger", async t => {
  const f = fixture(t), p = planned(f, "s2-plan-paid");
  const A = subjectOf(p.planAnswer, "q-supply");
  await assert.rejects(researchCall(p.environment.value.implementer, p.environment.value, "Plan", callContext(A, true), undefined,
    { store: f.store, draftId: p.draft.id, questionId: p.plan.id, purpose: "reading-planner" }), { code: "research_v7_mode_unavailable" });
  for (const kind of ["model-call", "model-request", "research-budget-ledger", "research-budget"])
    assert.deepEqual(f.store.list(kind), [], `no ${kind}`);
});

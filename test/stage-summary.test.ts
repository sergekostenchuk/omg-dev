import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson, type Json } from "../src/canonical.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { projectWebSource } from "../src/evidence/evidence.js";
import { ProductEngine } from "../src/product/engine.js";
import { reference, stageId } from "../src/pipeline/contracts.js";
import { renderStageSummary, stageSummary } from "../src/product/stage-summary.js";
import { Store, type Revision } from "../src/storage/store.js";
import { preparedField } from "./preparation-fixture.js";
import { answerDiscoveryFixture, preparedFeatures, withHistoricalUpstream } from "./product-fixture.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-stage-summary-"));
  const database = join(root, "state.sqlite"), store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, database, store, engine };
}

type Outcome = "go" | "conditional" | "no_go" | "insufficient_evidence";
function answerDiscovery(engine: ProductEngine, project: string, draft: Revision<DiscoveryDraft>, source: Revision<{ content: string }>,
  options: { outcome?: Outcome; through?: "report" | "verdict" | "preparation"; objectiveActor?: string } = {}): Revision<DiscoveryDraft> {
  const through = options.through ?? (options.outcome && options.outcome !== "go" ? "verdict" : "preparation");
  for (const id of draft.value.questions) {
    const question = engine.store.get<Question>(id)!;
    const field = question.value.spec.field;
    if (question.value.status === "answered") continue;
    if (field === "brief") engine.discovery.fact(id, question.revision, reference(source),
      { kind: "text-range", start: 0, end: source.value.content.length });
    else if (field === "objective") engine.discovery.decision(id, question.revision,
      options.objectiveActor ?? "local-caller", `objective for ${project}`);
    else {
      if (field === "verdict" && through === "report") break;
      let value = preparedField(project, field);
      if (field === "verdict" && options.outcome && options.outcome !== "go") {
        value = { ...(value as object), outcome: options.outcome,
          reason: `${options.outcome} fixture reason`,
          conditions: options.outcome === "conditional" ? [{ id: "owner-scope", kind: "owner_choice",
            condition: "Choose the required scope", criterion: "A new supported verdict establishes the choice",
            options: [{ optionId: "accept", label: "Accept the scope", consequences: ["Reassess the variant"], choice: "accept" },
              { optionId: "decline", label: "Decline the scope", consequences: ["Research alternatives"], choice: "decline" }] }] : [] } as Json;
      }
      answerDiscoveryFixture(engine, project, engine.store.get<DiscoveryDraft>(draft.id)!, question, value, source);
      if (field === "verdict" && through === "verdict") break;
    }
  }
  return engine.store.get<DiscoveryDraft>(draft.id)!;
}

function acceptDiscovery(engine: ProductEngine, project: string, source?: Revision<{ content: string }>, objectiveActor?: string) {
  engine.execute({ type: "create-project", project, title: project });
  const evidence = source ?? engine.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const draft = engine.prepare(project, "discovery");
  const answered = answerDiscovery(engine, project, draft, evidence,
    objectiveActor === undefined ? {} : { objectiveActor });
  const staged = engine.draft(project, "discovery", answered.id, 0);
  const accepted = engine.pipeline.accept(project, "discovery", staged.revision);
  return { draft: answered, source: evidence, artifact: accepted };
}

function configurePauseAdapter(root: string, engine: ProductEngine, project: string,
  mode: "pause" | "need-owner" = "pause", source?: Revision<unknown>): void {
  const adapter = join(root, "pause-adapter.mjs");
  writeFileSync(adapter, `import {readFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),subject=request.subject,q=subject.question??subject.questions?.[0],role=subject.role??subject.continuation?.role;
let research;
if(${JSON.stringify(mode)}==='pause')research={action:'pause',reason:'fixture pause'};
else if(role==='assess-escalation')research={necessary:true,reason:'The exact owner answer is required'};
else {const read=[...(subject.history??[]),subject.currentRead].some(item=>item?.action?.action==='read_source');
 research=read?{action:'need_owner',question:q.id,reason:'The source does not contain the owner answer',searched:[${JSON.stringify(source ? reference(source) : null)}]}:
 {action:'read_source',source:${JSON.stringify(source ? reference(source) : null)},start:0,end:8};}
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));
`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: "fixture-author", model: "fixture", effort: "medium", command },
    reviewer: { actor: "fixture-assessor", model: "fixture", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 4000 }, 0);
}

test("DS1.3a keeps accepted Discovery and exact citations separate from a newer candidate after restart", t => {
  const f = fixture(t), accepted = acceptDiscovery(f.engine, "p", undefined, "driver:verbatim");
  const first = stageSummary(f.store, "p", "discovery");
  assert.equal(first.accepted?.state, "accepted");
  assert.equal(first.accepted?.instruction.objective.origin.label, "Решение вызывающего",
    "an actor string without the exact IN1 binding grants no verbatim authority");
  assert.deepEqual(first.accepted?.report?.results[0]?.citations.map(item => [item.ref.id, item.quote, item.proofLimit]),
    [[accepted.source.id, accepted.source.value.content, "quoted-intent-requires-attribution"]]);
  assert.equal(first.accepted?.report?.results[0]?.address.pointer, "/value/results/0");
  assert.equal(first.accepted?.report?.constraints[0]?.address.pointer, "/value/constraints/0");
  assert.equal(first.accepted?.verdict?.bases[0]?.address.pointer, "/value/bases/0");
  assert.deepEqual(f.engine.execute({ type: "stage-summary", project: "p", stage: "discovery" }), first);
  const exported = f.engine.execute({ type: "export-stage", project: "p", stage: "discovery" }) as string;
  assert.match(exported, /## Результаты исследования/);
  assert.ok(exported.lastIndexOf("## Исходный JSON") > exported.indexOf("## Вердикт"));
  assert.match(exported, /```json\n\{/);

  const newer = f.engine.prepare("p", "discovery");
  const acceptedQuestion = f.store.get<Question>(accepted.draft.value.questions[0]!)!;
  f.engine.discovery.reopen(acceptedQuestion.id, acceptedQuestion.revision);
  f.engine.discovery.evidence.document("p", "basis", "Changed current source", "text/plain", accepted.source.revision);
  const reopened = new Store(f.database);
  try {
    const before = reopened.changeStamp();
    const summary = stageSummary(reopened, "p", "discovery", newer.id);
    assert.equal(summary.accepted?.state, "accepted");
    assert.equal(summary.accepted?.artifact.hash, accepted.artifact.hash);
    assert.equal(summary.accepted?.instruction.brief.value, accepted.source.value.content);
    assert.equal(summary.accepted?.report?.results[0]?.citations[0]?.quote, accepted.source.value.content);
    assert.equal(summary.candidate?.draft.id, newer.id);
    assert.equal(summary.candidate?.state, "researching");
    assert.equal(reopened.changeStamp(), before, "summary is read-only");
  } finally { reopened.close(); }
});

test("DS1.3a keeps the accepted result and selects its normally reopened question as the sole current candidate", t => {
  const f = fixture(t), accepted = acceptDiscovery(f.engine, "reopened");
  const objective = accepted.draft.value.questions.map(id => f.store.get<Question>(id)!)
    .find(question => question.value.spec.field === "objective")!;
  f.engine.execute({ type: "reopen-question", question: objective.id, expected: objective.revision });
  const stamp = f.store.changeStamp();
  const automatic = f.engine.execute({ type: "stage-summary", project: "reopened", stage: "discovery" }) as ReturnType<typeof stageSummary>;
  const explicit = f.engine.execute({ type: "stage-summary", project: "reopened", stage: "discovery",
    draftId: accepted.draft.id }) as ReturnType<typeof stageSummary>;
  assert.equal(automatic.accepted?.artifact.hash, accepted.artifact.hash);
  assert.deepEqual(automatic.candidates, []);
  assert.equal(automatic.candidate?.draft.id, accepted.draft.id);
  assert.deepEqual(automatic.candidate?.draft, explicit.candidate?.draft);
  assert.deepEqual(automatic.candidate?.questions.find(item => item.field === "objective"),
    { ref: reference(f.store.get<Question>(objective.id)!), field: "objective", status: "open" });
  assert.equal(automatic.candidate?.report, null, "answers after the reopened prefix are not presented as current research");
  assert.equal(f.store.changeStamp(), stamp);
});

test("DS1.3a isolates a stale current candidate from accepted history and exposes the original admission refusal", t => {
  const f = fixture(t), accepted = acceptDiscovery(f.engine, "stale");
  const questions = accepted.draft.value.questions.map(id => f.store.get<Question>(id)!);
  const objective = questions.find(question => question.value.spec.field === "objective")!;
  const brief = questions.find(question => question.value.spec.field === "brief")!;
  f.engine.execute({ type: "reopen-question", question: objective.id, expected: objective.revision });
  f.engine.execute({ type: "answer-decision", question: objective.id, expected: objective.revision + 1,
    value: "Revised current goal" });
  f.engine.execute({ type: "source-document", project: "stale", id: "basis", text: "Updated source",
    media: "text/plain", expected: accepted.source.revision });
  const second = new Store(f.database); t.after(() => second.close());
  const engine = new ProductEngine(second), stamp = second.changeStamp();
  const summary = engine.execute({ type: "stage-summary", project: "stale", stage: "discovery" }) as ReturnType<typeof stageSummary>;
  const exported = engine.execute({ type: "export-stage", project: "stale", stage: "discovery" }) as string;
  assert.equal(summary.accepted?.artifact.hash, accepted.artifact.hash);
  assert.equal(summary.accepted?.report?.results[0]?.citations[0]?.quote, accepted.source.value.content);
  assert.equal(summary.candidate?.draft.id, accepted.draft.id);
  assert.deepEqual(summary.candidate?.admission,
    { code: "evidence_stale", message: `[${brief.id}] Source evidence is missing or changed`, question: reference(brief) });
  assert.equal(summary.candidate?.report?.results[0]?.citations[0]?.quote, accepted.source.value.content,
    "saved candidate research remains readable from its exact captured Source");
  assert.match(exported, /Отказ допуска evidence_stale/);
  assert.match(exported, /Exact source for stale/);
  assert.equal(second.changeStamp(), stamp);
});

test("DS1.3a isolates stale choice history after a revised research plan from the accepted section", t => {
  const f = fixture(t), accepted = acceptDiscovery(f.engine, "plan-revised");
  const originalDraft = f.store.get<DiscoveryDraft>(accepted.draft.id)!;
  const records = originalDraft.value.questions.map(id => f.store.get<Question>(id)!);
  const plan = records.find(question => question.value.spec.field === "researchPlan")!;
  const report = records.find(question => question.value.spec.field === "researchReport")!;
  const oldPlanAnswer = plan.value.answer;
  f.engine.execute({ type: "reopen-question", question: plan.id, expected: plan.revision });
  const openPlan = f.store.get<Question>(plan.id)!, currentDraft = f.store.get<DiscoveryDraft>(originalDraft.id)!;
  answerDiscoveryFixture(f.engine, "plan-revised", currentDraft, openPlan,
    currentDraft.value.fields.researchPlan!, accepted.source);
  assert.notDeepEqual(f.store.get<Question>(plan.id)!.value.answer, oldPlanAnswer);
  assert.deepEqual(f.store.get<Question>(report.id)!.value.answer, report.value.answer);

  const second = new Store(f.database); t.after(() => second.close());
  const engine = new ProductEngine(second), stamp = second.changeStamp();
  const automatic = engine.execute({ type: "stage-summary", project: "plan-revised", stage: "discovery" }) as ReturnType<typeof stageSummary>;
  const explicit = engine.execute({ type: "stage-summary", project: "plan-revised", stage: "discovery",
    draftId: originalDraft.id }) as ReturnType<typeof stageSummary>;
  const exported = engine.execute({ type: "export-stage", project: "plan-revised", stage: "discovery" }) as string;
  for (const summary of [automatic, explicit]) {
    assert.equal(summary.accepted?.artifact.hash, accepted.artifact.hash);
    assert.equal(summary.candidate?.draft.id, originalDraft.id);
    assert.equal(summary.candidate?.admission?.code, "discovery_basis_stale");
    assert.equal(summary.candidate?.researchFailure?.code, "stage_summary_basis_invalid");
    assert.deepEqual(summary.candidate?.choiceHistoryFailure,
      { code: "discovery_basis_stale",
        message: `[${report.id}] Reopen the report and verdict: the report names a previous research plan`,
        question: reference(report) });
    assert.deepEqual(summary.candidate?.decisions, [], "failed choice-history read is distinct from a proven empty history");
  }
  assert.match(exported, /Отказ чтения истории выбора discovery_basis_stale/);
  assert.match(exported, /Принятый результат/);
  assert.equal(second.changeStamp(), stamp);
});

test("DS1.3a gives a real nonempty owner-choice history its own refusal after the current plan is revised", t => {
  const f = fixture(t), project = "choice-plan-revised";
  f.engine.execute({ type: "create-project", project, title: project });
  const source = f.engine.discovery.evidence.document(project, "basis", "Choice history source", "text/plain", 0);
  const initial = f.engine.prepare(project, "discovery");
  answerDiscovery(f.engine, project, initial, source, { outcome: "conditional", through: "verdict" });
  const conditional = stageSummary(f.store, project, "discovery", initial.id), choice = conditional.candidate!.ownerChoices[0]!;
  f.engine.execute({ type: "answer-decision", mode: "discovery-condition", project, draft: initial.id,
    verdictRef: choice.verdictRef, conditionId: choice.conditionId, optionId: choice.options[0]!.optionId });
  const recorded = stageSummary(f.store, project, "discovery", initial.id);
  assert.equal(recorded.candidate?.choiceHistoryFailure, null);
  assert.deepEqual(recorded.candidate?.decisions.map(item => [item.conditionId, item.optionId, item.round !== null]),
    [[choice.conditionId, choice.options[0]!.optionId, true]], "the history is genuinely nonempty before it becomes stale");

  const answered = answerDiscovery(f.engine, project, f.store.get<DiscoveryDraft>(initial.id)!, source);
  const staged = f.engine.draft(project, "discovery", answered.id, 0);
  const accepted = f.engine.pipeline.accept(project, "discovery", staged.revision);
  const questions = answered.value.questions.map(id => f.store.get<Question>(id)!);
  const plan = questions.find(question => question.value.spec.field === "researchPlan")!;
  const report = questions.find(question => question.value.spec.field === "researchReport")!;
  f.engine.execute({ type: "reopen-question", question: plan.id, expected: plan.revision });
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(initial.id)!, f.store.get<Question>(plan.id)!,
    f.store.get<DiscoveryDraft>(initial.id)!.value.fields.researchPlan!, source);

  const second = new Store(f.database); t.after(() => second.close());
  const engine = new ProductEngine(second), stamp = second.changeStamp();
  const automatic = engine.execute({ type: "stage-summary", project, stage: "discovery" }) as ReturnType<typeof stageSummary>;
  const explicit = engine.execute({ type: "stage-summary", project, stage: "discovery", draftId: initial.id }) as ReturnType<typeof stageSummary>;
  const exported = engine.execute({ type: "export-stage", project, stage: "discovery" }) as string;
  for (const summary of [automatic, explicit]) {
    assert.equal(summary.accepted?.artifact.hash, accepted.hash);
    assert.equal(summary.candidate?.admission?.code, "discovery_basis_stale");
    assert.deepEqual(summary.candidate?.choiceHistoryFailure,
      { code: "discovery_basis_stale",
        message: `[${report.id}] Reopen the report and verdict: the report names a previous research plan`,
        question: reference(report) });
    assert.deepEqual(summary.candidate?.decisions, [],
      "the typed choice-history failure distinguishes unavailable history from a proven empty history");
  }
  assert.match(exported, /Отказ чтения истории выбора discovery_basis_stale/);
  assert.equal(second.changeStamp(), stamp);
});

test("DS1.3a reports lawful nonaccepted outcomes and an unfinished candidate without inventing acceptance", t => {
  const f = fixture(t);
  for (const outcome of ["conditional", "no_go", "insufficient_evidence"] as const) {
    const project = outcome.replaceAll("_", "-");
    f.engine.execute({ type: "create-project", project, title: project });
    const source = f.engine.discovery.evidence.document(project, "basis", `Source for ${project}`, "text/plain", 0);
    const draft = f.engine.prepare(project, "discovery");
    answerDiscovery(f.engine, project, draft, source, { outcome, through: "verdict" });
    const stamp = f.store.changeStamp();
    const summary = stageSummary(f.store, project, "discovery");
    assert.equal(summary.accepted, null);
    assert.equal(summary.candidate?.state, outcome);
    assert.equal(summary.candidate?.report?.results[0]?.conclusion,
      "The fixture explicitly proposes a bounded local transformation");
    assert.deepEqual(summary.candidate?.report?.results[0]?.citations.map(item => [item.ref.id, item.quote]),
      [[source.id, source.value.content]]);
    assert.equal(summary.candidate?.report?.constraints[0]?.value, "Local inputs and outputs only");
    assert.equal(summary.candidate?.verdict?.outcome, outcome);
    assert.equal(summary.candidate?.verdict?.bases[0]?.address.pointer, "/value/bases/0");
    assert.equal(summary.candidate?.researchFailure, null);
    assert.equal(f.store.get(stageId(project, "discovery")), null);
    const exported = f.engine.execute({ type: "export-stage", project, stage: "discovery" }) as string;
    assert.match(exported, new RegExp(`Исход: ${outcome}`));
    assert.match(exported, /The fixture explicitly proposes a bounded local transformation/);
    assert.match(exported, /Local inputs and outputs only/);
    assert.equal(f.store.changeStamp(), stamp);
    if (outcome === "conditional") {
      const choice = summary.candidate?.ownerChoices[0];
      assert.equal(choice?.address.pointer, "/value/conditions/0");
      assert.equal(summary.candidate?.door, "answer-decision:discovery-condition");
      f.engine.execute({ type: "answer-decision", mode: "discovery-condition", project, draft: draft.id,
        verdictRef: choice!.verdictRef, conditionId: choice!.conditionId, optionId: choice!.options[0]!.optionId });
      const revised = stageSummary(f.store, project, "discovery");
      assert.equal(revised.candidate?.state, "researching");
      assert.deepEqual(revised.candidate?.decisions.map(item =>
        [item.conditionId, item.optionId, item.actor, item.round !== null]),
      [[choice!.conditionId, choice!.options[0]!.optionId, "local-caller", true]]);
      assert.equal(revised.candidate?.choiceHistoryFailure, null);
      assert.equal(revised.candidate?.door, "research-stage");
    }
  }
  f.engine.execute({ type: "create-project", project: "unfinished", title: "unfinished" });
  const source = f.engine.discovery.evidence.document("unfinished", "basis", "unfinished source", "text/plain", 0);
  const draft = f.engine.prepare("unfinished", "discovery");
  answerDiscovery(f.engine, "unfinished", draft, source, { through: "report" });
  const stamp = f.store.changeStamp();
  const summary = stageSummary(f.store, "unfinished", "discovery");
  assert.equal(summary.candidate?.state, "researching");
  assert.equal(summary.candidate?.report?.results[0]?.citations[0]?.quote, source.value.content);
  assert.equal(summary.candidate?.verdict, null);
  assert.match(renderStageSummary(summary), /Исход: исследование не завершено/);
  assert.match(renderStageSummary(summary), /The fixture explicitly proposes a bounded local transformation/);
  assert.equal(f.store.changeStamp(), stamp);
});

test("DS1.3a selects only the run linked to the candidate draft and never a foreign last run", async t => {
  const f = fixture(t);
  for (const project of ["target", "foreign"]) {
    f.engine.execute({ type: "create-project", project, title: project });
    configurePauseAdapter(f.root, f.engine, project);
    f.engine.discovery.evidence.document(project, "basis", `${project} source`, "text/plain", 0);
    const draft = f.engine.prepare(project, "discovery");
    const result = await f.engine.stageResearch.run(project, draft.id, 1);
    assert.equal(result.status, "paused");
  }
  const target = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.projectId === "target")!;
  const foreign = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.projectId === "foreign")!;
  const summary = stageSummary(f.store, "target", "discovery", target.id);
  assert.equal(summary.candidate?.run?.ref.id, `research-run:${hashJson(["target", target.id])}`);
  assert.notEqual(summary.candidate?.run?.ref.id, `research-run:${hashJson(["foreign", foreign.id])}`);
  assert.equal(summary.candidate?.run?.question, null);
  assert.equal(summary.candidate?.run?.door, "research-stage");
});

test("DS1.3a addresses the exact owner question and its existing answer door", async t => {
  const f = fixture(t);
  f.engine.execute({ type: "create-project", project: "owner", title: "owner" });
  const source = f.engine.discovery.evidence.document("owner", "basis", "owner source", "text/plain", 0);
  configurePauseAdapter(f.root, f.engine, "owner", "need-owner", source);
  const draft = f.engine.prepare("owner", "discovery");
  const result = await f.engine.stageResearch.run("owner", draft.id, 4);
  assert.equal(result.status, "needs_owner");
  const summary = stageSummary(f.store, "owner", "discovery", draft.id);
  const question = f.store.get<Question>(draft.value.questions[0]!)!;
  assert.deepEqual(summary.candidate?.run?.question, reference(question));
  assert.equal(summary.candidate?.run?.missing[0], "The exact owner answer is required");
  assert.equal(summary.candidate?.door, "answer-fact");
  assert.match(renderStageSummary(summary), new RegExp(`${question.id}@${question.revision}`));
});

test("DS1.3a refuses to guess between lawful unbound candidates and accepts an explicit draft", t => {
  const f = fixture(t);
  f.engine.execute({ type: "create-project", project: "choice", title: "choice" });
  const first = f.engine.prepare("choice", "discovery"), second = f.engine.prepare("choice", "discovery");
  const ambiguous = stageSummary(f.store, "choice", "discovery");
  assert.equal(ambiguous.candidate, null);
  assert.deepEqual(new Set(ambiguous.candidates.map(item => item.id)), new Set([first.id, second.id]));
  const selected = f.engine.execute({ type: "stage-summary", project: "choice", stage: "discovery", draftId: first.id }) as ReturnType<typeof stageSummary>;
  assert.equal(selected.candidate?.draft.id, first.id);
  assert.deepEqual(selected.candidates, []);
  f.engine.execute({ type: "create-project", project: "other", title: "other" });
  const foreign = f.engine.prepare("other", "discovery");
  assert.throws(() => f.engine.execute({ type: "stage-summary", project: "choice", stage: "discovery", draftId: foreign.id }),
    { code: "stage_summary_draft_foreign" });
});


test("DS1.3a proves the IN1 selectors before applying the verbatim label", async t => {
  const f = fixture(t);
  f.engine.execute({ type: "create-project", project: "verbatim", title: "verbatim" });
  configurePauseAdapter(f.root, f.engine, "verbatim");
  const text = "Build the exact product.\nPreserve the exact goal.";
  await f.engine.execute({ type: "early-stage-run", project: "verbatim", maxTurns: 1, maxCalls: 1,
    instruction: { title: "verbatim", id: "instruction", text, media: "text/plain",
      brief: { kind: "text-range", start: 0, end: 24 }, objective: { kind: "text-range", start: 25, end: text.length } } });
  const draft = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.projectId === "verbatim")!;
  const source = f.store.get<{ content: string }>("source:verbatim:instruction")!;
  answerDiscovery(f.engine, "verbatim", draft, source);
  const current = f.store.get<DiscoveryDraft>(draft.id)!;
  const staged = f.engine.draft("verbatim", "discovery", current.id, 0);
  f.engine.pipeline.accept("verbatim", "discovery", staged.revision);
  const summary = stageSummary(f.store, "verbatim", "discovery");
  assert.deepEqual([summary.accepted?.instruction.brief.origin.label, summary.accepted?.instruction.objective.origin.label],
    ["Слова поручения (дословно)", "Слова поручения (дословно)"]);
  assert.deepEqual([summary.accepted?.instruction.brief.origin.binding?.id, summary.accepted?.instruction.objective.origin.source?.ref.id],
    ["early-stage-input:verbatim", "source:verbatim:instruction"]);
});

test("DS1.3a detects a second Store changing a selected head during the read", t => {
  const f = fixture(t);
  f.engine.execute({ type: "create-project", project: "window", title: "window" });
  const draft = f.engine.prepare("window", "discovery"), question = f.store.get<Question>(draft.value.questions[0]!)!;
  const second = new Store(f.database); t.after(() => second.close());
  const original = f.store.get.bind(f.store); let moved = false;
  f.store.get = function<T>(id: string, revision?: number): Revision<T> | null {
    const result = original<T>(id, revision);
    if (!moved && id === question.id && revision === undefined) {
      moved = true;
      new ProductEngine(second).discovery.reopen(question.id, question.revision);
    }
    return result;
  };
  try { assert.throws(() => stageSummary(f.store, "window", "discovery"), { code: "input_stale" }); }
  finally { f.store.get = original; }
});

test("DS1.3a reads genuine v3, v4 and v5 accepted histories by their own contracts", t => {
  const f = fixture(t);
  withHistoricalUpstream("1189043f4bc7", () => preparedFeatures(f.engine, "v3"));
  withHistoricalUpstream("e9c1ca5c41fb80508559aeab41da8f3da7422953", () => preparedFeatures(f.engine, "v4"));
  preparedFeatures(f.engine, "v5");
  for (const [project, version] of [["v3", 3], ["v4", 4], ["v5", 5]] as const) {
    const summary = stageSummary(f.store, project, "discovery");
    assert.equal(summary.accepted?.contractVersion, version);
    if (version < 5) {
      assert.equal(summary.accepted?.report, null);
      assert.ok(summary.accepted?.limitations.every(item => item.includes(`contractVersion ${version}`)));
    } else assert.equal(summary.accepted?.verdict?.outcome, "go");
  }
});

test("DS1.3a renders saved web URLs, capture time, quote and documentary proof limit without fetching", t => {
  const f = fixture(t);
  f.engine.execute({ type: "create-project", project: "web", title: "web" });
  const capture = f.store.write({ id: "web-capture:web:1", kind: "web-capture", expected: 0,
    value: { projectId: "web", requestedUrl: "https://example.test/request", finalUrl: "https://example.test/final" } });
  const projected = projectWebSource("web", reference(capture), { requestedUrl: "https://example.test/request",
    finalUrl: "https://example.test/final", fetchedAt: "2026-10-15T00:00:00.000Z", status: 200,
    text: "Saved web statement", extraction: "fixture", truncated: false });
  const source = f.store.write<{ content: string }>({ ...projected, expected: 0 });
  const draft = f.engine.prepare("web", "discovery");
  answerDiscovery(f.engine, "web", draft, source);
  const staged = f.engine.draft("web", "discovery", draft.id, 0);
  f.engine.pipeline.accept("web", "discovery", staged.revision);
  const before = f.store.changeStamp(), citation = stageSummary(f.store, "web", "discovery").accepted?.report?.results[0]?.citations[0];
  assert.deepEqual([citation?.requestedUrl, citation?.finalUrl, citation?.fetchedAt, citation?.quote, citation?.proofLimit],
    ["https://example.test/request", "https://example.test/final", "2026-10-15T00:00:00.000Z",
      "Saved web statement", "reported-not-runtime-proof"]);
  assert.equal(f.store.changeStamp(), before);
});

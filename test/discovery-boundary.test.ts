import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Discovery, type DiscoveryDraft, type FieldSpec, type Question } from "../src/discovery/discovery.js";
import {
  LEGACY_REQUIREMENTS, REQUIREMENTS, VERSION2_REQUIREMENTS, VERSION4_REQUIREMENTS,
  VERSION5_REQUIREMENTS, VERSION6_REQUIREMENTS,
} from "../src/discovery/requirements.js";
import {
  acceptedIssuance, contractEraOf, discoveryActors, executionAdmission,
  explicitContractEraOf, hasBasisApplications, issuedForm, outcomeSummary,
  proveIssuedAnswer, type RecordView,
} from "../src/discovery/projection-reader.js";
import { reference } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { stageSummary } from "../src/product/stage-summary.js";
import { Store, type Revision } from "../src/storage/store.js";
import { preparedField } from "./preparation-fixture.js";
import { answerDiscoveryFixture } from "./product-fixture.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr0-boundary-"));
  const store = new Store(join(root, "state.sqlite")), discovery = new Discovery(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, discovery, engine: new ProductEngine(store) };
}

function source(discovery: Discovery, project: string) {
  return discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
}

/** Отвечает каждый вопрос драфта записью его собственного kind/proof —
 * значения берутся из того же fixture, что проверяет принятые стадии. */
function answerAll(engine: ProductEngine, project: string, draft: Revision<DiscoveryDraft>,
  evidence: Revision<{ content: string }>): Revision<DiscoveryDraft> {
  let answered = draft;
  for (const id of answered.value.questions) {
    const question = engine.store.get<Question>(id)!;
    if (question.value.status === "answered") continue;
    const field = question.value.spec.field;
    if (question.value.spec.kind === "fact")
      answered = engine.discovery.fact(id, question.revision, reference(evidence),
        { kind: "text-range", start: 0, end: evidence.value.content.length });
    else if (question.value.spec.proof === "assessment")
      answered = answerDiscoveryFixture(engine, project, answered, question, preparedField(project, field), evidence);
    else answered = engine.discovery.decision(id, question.revision, "owner", preparedField(project, field));
  }
  return engine.store.get<DiscoveryDraft>(answered.id)!;
}

/** Драфт той же эры, но со specs вне таблицы контракта — contract-mismatch
 * через легальный Discovery.create, без правки сохранённых записей. */
function mismatchedSpecs(specs: readonly FieldSpec[]): FieldSpec[] {
  return specs.map(spec => ({ ...spec, prompt: `${spec.prompt} [tampered]` }));
}

test("boundary: explicitContractEraOf различает отсутствие, null, число и malformed", t => {
  const { discovery } = fixture(t);
  const draft = discovery.create("p", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery);
  assert.equal(Object.hasOwn(draft.value, "contractVersion"), false, "синтетический v1-драфт не несёт поля");

  const absent = explicitContractEraOf(draft.value);
  assert.deepEqual(absent, { present: false, version: undefined });
  // DR0-01: отсутствующее поле нормализуется к null, а не к undefined.
  assert.equal(absent.present ? absent.version : null, null);

  assert.deepEqual(explicitContractEraOf({ ...draft.value, contractVersion: null }), { present: true, version: null });
  assert.deepEqual(explicitContractEraOf({ ...draft.value, contractVersion: 4 }), { present: true, version: 4 });

  // malformed сохраняется сырым и различим от отсутствия — потребитель отказывает сам.
  const undef = explicitContractEraOf({ ...draft.value, contractVersion: undefined } as unknown as DiscoveryDraft);
  assert.equal(undef.present, true, "явный undefined — присутствующее malformed-поле");
  assert.equal(undef.version, undefined, "сырое значение не нормализуется к null");
  const text = explicitContractEraOf({ ...draft.value, contractVersion: "six" as unknown as number });
  assert.equal(text.present, true);
  assert.equal(text.version, "six");
});

test("boundary: contractEraOf и admission-матрица сохраняют прежние правила", t => {
  const { store, discovery } = fixture(t);
  assert.equal(contractEraOf({}), 1);
  assert.equal(contractEraOf({ contractVersion: 4 }), 4);

  const draft = (version?: number) =>
    discovery.create("m", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery, [], version);

  for (const era of [4, 5, 6] as const) {
    const admission = executionAdmission(store, draft(era), "new-research");
    if (era === 6) assert.equal(admission.admitted, true);
    else {
      assert.equal(admission.admitted, false);
      assert.equal(admission.paused, true, "оплаченная работа удерживается, а не отвергается");
      assert.equal(admission.upgradeRequired, true);
    }
    assert.equal(admission.form, null, "form интерпретируется только для early-drive");
    assert.equal(executionAdmission(store, draft(era), "early-drive").admitted, true,
      `early-drive допускает эру ${era}`);
  }
  const restore = executionAdmission(store, draft(4), "new-research");
  assert.equal(restore.paidRestore, true);
  assert.equal(restore.message,
    "Paid v4 work is retained; prepare Discovery v5 before new research or acceptance");
  assert.equal(executionAdmission(store, draft(5), "new-research").message,
    "Paid v5 work is retained; prepare Discovery v6 before new research or acceptance");

  for (const era of [undefined, 2, 3] as const) {
    const admission = executionAdmission(store, draft(era), "new-research");
    assert.equal(admission.admitted, false);
    assert.equal(admission.paused, false, "доплатных дверей у ранних эр нет");
    assert.equal(admission.message, null);
    assert.equal(executionAdmission(store, draft(era), "early-drive").admitted, false);
  }
});

test("boundary: acceptedIssuance возвращает типизированный отказ вместо исключения", t => {
  const { store, discovery, engine } = fixture(t);
  const evidence = source(discovery, "p");
  const draft = discovery.create("p", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery);

  // Ни один вопрос не отвечен — отказ 'incomplete' с адресом первого вопроса.
  const open = acceptedIssuance(store, draft);
  assert.equal(open.issued, false);
  if (open.issued) return;
  assert.equal(open.failure, "incomplete");
  assert.equal(open.question, draft.value.questions[0]);

  // Частично отвеченный драфт — тот же отказ на следующем неотвеченном.
  discovery.fact(draft.value.questions[0]!, 1, reference(evidence),
    { kind: "text-range", start: 0, end: evidence.value.content.length });
  const partial = acceptedIssuance(store, store.get<DiscoveryDraft>(draft.id)!);
  assert.equal(partial.issued, false);
  if (partial.issued) return;
  assert.equal(partial.failure, "incomplete");
  assert.equal(partial.question, draft.value.questions[1]);

  // Маскарад: ссылка на несуществующий вопрос — 'missing', не пропуск.
  const forged = { ...draft, value: { ...draft.value, questions: ["question:p:missing"] } };
  const missing = acceptedIssuance(store, forged);
  assert.equal(missing.issued, false);
  if (missing.issued) return;
  assert.equal(missing.failure, "missing");
  assert.equal(missing.question, draft.id);

  // Прежний приоритет: несовпадение контракта сообщается раньше неотвеченности —
  // драфт со specs вне таблицы эры отвечать не нужно, отказ уже 'contract'.
  const tampered = discovery.create("p", "discovery", "R0", "concept",
    mismatchedSpecs(LEGACY_REQUIREMENTS.discovery));
  const contract = acceptedIssuance(store, tampered);
  assert.equal(contract.issued, false);
  if (contract.issued) return;
  assert.equal(contract.failure, "contract",
    "contract-отказ первым даже на полностью открытом драфте");

  // Полностью отвеченный драфт с чужими specs — контракт всё равно первым.
  const answeredTampered = answerAll(engine, "p", tampered, evidence);
  const late = acceptedIssuance(store, answeredTampered);
  assert.equal(late.issued, false);
  if (late.issued) return;
  assert.equal(late.failure, "contract");
});

test("boundary: acceptedIssuance читает вопросы строго в сохранённом порядке", t => {
  const { store, discovery, engine } = fixture(t);
  const evidence = source(discovery, "p");
  const draft = answerAll(engine, "p",
    discovery.create("p", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery), evidence);

  const calls: string[] = [];
  const traced: RecordView = { get: id => { calls.push(id); return store.get(id); } };
  const issuance = acceptedIssuance(traced, draft);
  assert.deepEqual(calls, draft.value.questions,
    "ровно одно чтение на вопрос, в сохранённом порядке, без лишних чтений");
  assert.equal(issuance.issued, true);
  if (!issuance.issued) return;

  assert.equal(issuance.era, 1);
  assert.equal(issuance.supported, true);
  assert.equal(issuance.prepared, false);
  assert.equal(issuance.basis, false);
  assert.equal(issuance.entries.length, draft.value.questions.length);
  for (const [index, entry] of issuance.entries.entries()) {
    assert.equal(entry.foreign, false);
    assert.equal(entry.staged, true);
    assert.equal(entry.namespaced, true);
    assert.equal(entry.valid, true);
    assert.ok(entry.answerRef, "точная ссылка ответа доказывается выдачей");
    assert.equal(entry.question!.id, draft.value.questions[index]);
  }
});

test("boundary: принятая выдача поддерживает все исторические формы и оба v6-издания", t => {
  const { store, discovery, engine } = fixture(t);
  const evidence = source(discovery, "p");
  const editions: [string, FieldSpec[], number | undefined, { era: number; prepared: boolean; basis: boolean }][] = [
    ["v1 (нет contractVersion)", LEGACY_REQUIREMENTS.discovery, undefined, { era: 1, prepared: false, basis: false }],
    ["v2", VERSION2_REQUIREMENTS.discovery, 2, { era: 2, prepared: false, basis: false }],
    ["v4", VERSION4_REQUIREMENTS.discovery, 4, { era: 4, prepared: false, basis: false }],
    ["v5", VERSION5_REQUIREMENTS.discovery, 5, { era: 5, prepared: true, basis: false }],
    ["v6 (замороженное издание)", VERSION6_REQUIREMENTS.discovery, 6, { era: 6, prepared: true, basis: true }],
    ["v6 (издание аналогов)", REQUIREMENTS.discovery, 6, { era: 6, prepared: true, basis: true }],
  ];
  for (const [name, specs, version, want] of editions) {
    const draft = answerAll(engine, "p",
      discovery.create("p", "discovery", "R0", "concept", specs, [], version), evidence);
    const issuance = acceptedIssuance(store, draft);
    assert.equal(issuance.issued, true, name);
    if (!issuance.issued) continue;
    assert.equal(issuance.era, want.era, name);
    assert.equal(issuance.supported, true, name);
    assert.equal(issuance.prepared, want.prepared, name);
    assert.equal(issuance.basis, want.basis, name);
    assert.deepEqual(issuance.fields, specs.map(spec => spec.field),
      `${name}: сохранённые specs выбирают своё издание`);
  }

  // Оба v6-издания различаются сохранёнными specs, а не веткой версии у потребителя.
  const evidenceE = source(discovery, "e");
  const frozen = answerAll(engine, "e",
    discovery.create("e", "discovery", "R0", "concept", VERSION6_REQUIREMENTS.discovery, [], 6), evidenceE);
  const analogues = answerAll(engine, "e",
    discovery.create("e", "discovery", "R0", "concept", REQUIREMENTS.discovery, [], 6), evidenceE);
  const frozenIssuance = acceptedIssuance(store, frozen);
  const analoguesIssuance = acceptedIssuance(store, analogues);
  assert.equal(frozenIssuance.issued && frozenIssuance.matchesCurrentContract, false);
  assert.equal(analoguesIssuance.issued && analoguesIssuance.matchesCurrentContract, true);
});

test("boundary: issuedForm интерпретирует форму и стоит на первом дефекте", t => {
  const { store, discovery, engine } = fixture(t);
  const evidence = source(discovery, "q");
  const foreign = answerAll(engine, "q",
    discovery.create("q", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery), evidence);

  // Полная форма: все вопросы интерпретированы, дефекта нет.
  const form = issuedForm(store, foreign);
  assert.equal(form.defect, null);
  assert.equal(form.entries.length, foreign.value.questions.length);
  assert.ok(form.entries.every(entry => !entry.foreign && entry.answered));

  // Чужой вопрос на позиции 2 — префикс до него, дефект с его адресом.
  const own = discovery.create("p", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery);
  const forged = {
    ...own,
    value: { ...own.value, questions: [own.value.questions[0]!, foreign.value.questions[1]!] },
  };
  const defect = issuedForm(store, forged);
  assert.equal(defect.entries.length, 1, "прочитан только префикс до дефекта");
  assert.deepEqual(defect.defect, { index: 1, id: foreign.value.questions[1] },
    "дефект — чужой вопрос с его индексом и id");
});

test("boundary: proveIssuedAnswer доказывает значение и происхождение ответа", t => {
  const { store, discovery, engine } = fixture(t);
  const evidence = source(discovery, "p");
  const draft = answerAll(engine, "p",
    discovery.create("p", "discovery", "R0", "concept", REQUIREMENTS.discovery, [], 6), evidence);
  const issuance = acceptedIssuance(store, draft);
  assert.equal(issuance.issued, true);
  if (!issuance.issued) return;

  const proven = issuance.entries.map(entry => {
    const record = store.get<Record<string, unknown>>(entry.answerRef!.id, entry.answerRef!.revision)!;
    return { entry, record, issued: proveIssuedAnswer(store, draft, entry, record, { verifyIssuedQuestion: true }) };
  });
  const kinds = new Set(proven.map(row => row.issued.ok ? row.issued.proof.kind : null));
  assert.ok(kinds.has("research-answer"), "v6-выдача несёт исследовательские ответы");
  assert.ok(proven.every(row => row.issued.ok), "все ответы принятой выдачи доказаны");

  for (const { record, issued } of proven) {
    if (!issued.ok) continue;
    assert.equal(issued.proof.ref.id, record.id);
    assert.equal(issued.proof.matchesSpec, issued.proof.kind !== "research-answer",
      "kind ответа совпадает со spec.kind кроме исследовательского вида");
    assert.equal(issued.proof.reproduces, true, "значение воспроизводит поле драфта и схему spec");
    const prov = issued.proof.provenance;
    if (prov.kind === "fact") {
      assert.ok(prov.observation, "факт несёт сохранённое наблюдение");
    } else if (prov.kind === "research-answer") {
      assert.equal(prov.supported, true);
      assert.equal(prov.wellFormed, true);
      assert.equal(prov.independent, true);
      assert.equal(prov.valueMatches, true);
      assert.equal(prov.bindsQuestion, true, "оценка доказанно привязана к выданному вопросу");
      assert.ok(prov.assessment, "standalone-эра: оценка разрешилась по сохранённой ссылке");
      assert.equal(prov.binding, null, "standalone-эра: записи принятия K нет");
      assert.equal(prov.researcher, "fixture-author", "фамилия из доказанной оценки");
    } else {
      assert.equal(prov.actor, "owner");
      assert.equal(prov.hasAuthor, true);
    }
  }

  // Чужая запись: ответ вопроса другого проекта — 'foreign', а не пропуск.
  const alienEvidence = source(discovery, "q");
  const alien = answerAll(engine, "q",
    discovery.create("q", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery), alienEvidence);
  const alienIssuance = acceptedIssuance(store, alien);
  assert.equal(alienIssuance.issued && alienIssuance.entries[0]!.answered, true);
  const alienRecord = store.get<Record<string, unknown>>(alienIssuance.issued
    ? alienIssuance.entries[0]!.answerRef!.id : "")!;
  const foreign = proveIssuedAnswer(store, draft, issuance.entries[0]!, alienRecord);
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.failure, "foreign", "ответ чужого проекта разоблачён");

  // Маскарад значения: запись правильного проекта, но чужого вопроса.
  const secondRecord = store.get<Record<string, unknown>>(issuance.entries[1]!.answerRef!.id)!;
  const mismatched = proveIssuedAnswer(store, draft, issuance.entries[0]!, secondRecord);
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.failure, "foreign", "ответ чужого вопроса разоблачён");

  // Неотвеченный вопрос — 'question', запись ответа не требуется.
  const opened = discovery.create("p", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery);
  const openForm = issuedForm(store, opened);
  const unanswered = proveIssuedAnswer(store, opened, openForm.entries[0]!, null);
  assert.equal(unanswered.ok, false);
  if (!unanswered.ok) assert.equal(unanswered.failure, "question");
});

test("boundary: outcomeSummary работает без принятой выдачи и несёт форму", t => {
  const { store, discovery } = fixture(t);
  const legacy = discovery.create("p", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery);
  const legacyForm = issuedForm(store, legacy);
  const incomplete = outcomeSummary(store, legacy, legacyForm);
  assert.equal(incomplete.era, 1);
  assert.equal(incomplete.prepared, false);
  assert.equal(incomplete.outcome.state, "legacy");
  assert.equal(incomplete.run, null);
  assert.equal(incomplete.form.defect, null);

  const current = discovery.create("p", "discovery", "R0", "concept", REQUIREMENTS.discovery, [], 6);
  const summary = outcomeSummary(store, current, issuedForm(store, current));
  assert.equal(summary.era, 6);
  assert.equal(summary.prepared, true);
  assert.equal(summary.outcome.state, "researching", "незавершённый драфт — researching, не отказ");
  assert.equal(summary.form.entries.length, current.value.questions.length);
});

test("boundary: executionAdmission для early-drive несёт интерпретацию формы", t => {
  const { store, discovery } = fixture(t);
  const valid = discovery.create("p", "discovery", "R0", "concept", REQUIREMENTS.discovery, [], 6);
  const admission = executionAdmission(store, valid, "early-drive");
  assert.equal(admission.admitted, true);
  assert.equal(admission.form, "valid", "полная форма текущей эры допускается к драйву");

  // Потерянная форма: questions не массив — 'lost', драйв отказывает.
  const lostDraft = { ...valid, value: { ...valid.value, questions: "gone" as unknown as string[] } };
  const lost = executionAdmission(store, lostDraft, "early-drive");
  assert.equal(lost.admitted, true);
  assert.equal(lost.form, "lost");

  // Форма чужих specs: драфт создан легально, но контракту эры не соответствует.
  const wrong = discovery.create("p", "discovery", "R0", "concept",
    mismatchedSpecs(REQUIREMENTS.discovery), [], 6);
  const mismatch = executionAdmission(store, wrong, "early-drive");
  assert.equal(mismatch.admitted, true);
  assert.equal(mismatch.form, "mismatch");

  // Старые назначения формы не читают — лишних обращений к store нет.
  const quiet = executionAdmission({ get: () => { throw new Error("не должно читать"); } } as unknown as Store,
    valid, "stage-result");
  assert.equal(quiet.admitted, true);
  assert.equal(quiet.form, null);
});

/** Принятая стадия Discovery через реальный движок — тот же путь, что stage-summary. */
function acceptDiscovery(engine: ProductEngine, project: string) {
  engine.execute({ type: "create-project", project, title: project });
  const evidence = engine.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const draft = engine.prepare(project, "discovery");
  const answered = answerAll(engine, project, draft, evidence);
  const staged = engine.draft(project, "discovery", answered.id, 0);
  const artifact = engine.pipeline.accept(project, "discovery", staged.revision);
  return { draft: answered, evidence, artifact };
}

test("boundary: реальный потребитель stageSummary идёт через выдачу и сводку исхода", t => {
  const { store, engine } = fixture(t);
  const accepted = acceptDiscovery(engine, "p");
  const summary = stageSummary(store, "p", "discovery");
  assert.equal(summary.accepted?.state, "accepted");
  assert.equal(summary.accepted?.artifact.hash, accepted.artifact.hash,
    "acceptedIssuance доказал принятую стадию через сохранённые proofs");

  // Поля принятой стадии — доказанные значения с происхождением.
  const acc = summary.accepted!;
  assert.equal(acc.instruction.brief.origin.label, "Факт источника",
    "факт несёт происхождение наблюдения");
  assert.ok(acc.instruction.brief.origin.source, "ссылка источника наблюдения в происхождении");
  assert.equal(acc.instruction.objective.origin.label, "Решение вызывающего");
  assert.equal(acc.instruction.objective.origin.author, "owner");
  assert.equal(acc.researchPlan?.origin.label, "Предложение модели, принято по оценке",
    "исследовательский ответ интерпретирован по доказанной оценке");
  assert.equal(acc.researchPlan?.origin.author, "fixture-author",
    "автор — researcher из доказанной оценки");
  assert.ok(acc.researchPlan?.origin.assessment, "ссылка оценки в происхождении");
  assert.ok(acc.researchPlan?.answer.id, "точная ссылка ответа сохранена");

  assert.deepEqual(discoveryActors(store, "p"), [{ id: "p-user", role: "CLI user",
    benefit: "Receive a validated transformation result", channels: ["CLI"] }],
    "акторы сохранённой подготовки читаются через границу");

  // Кандидат без принятого артефакта — outcomeSummary, а не выдача.
  const newer = engine.prepare("p", "discovery");
  const reopened = stageSummary(store, "p", "discovery", newer.id);
  assert.equal(reopened.candidate?.draft.id, newer.id,
    "незавершённый кандидат читается сводкой исхода без принятой выдачи");
});

test("boundary: потребители вызывают операции границы и не ветвятся по сырым эрам", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const callSites: Record<string, string[]> = {
    "src/om/input.ts": ["acceptedIssuance(", "proveIssuedAnswer(", "explicitContractEraOf(", "eraInfo.present"],
    "src/product/stage-summary.ts": ["acceptedIssuance(", "outcomeSummary(", "proveIssuedAnswer(", "issuedForm("],
    "src/product/engine.ts": ["executionAdmission(", "orderedQuestions(", "stageFields("],
    "src/product/stage-checks.ts": ["researchContract(", "stageFields(", "artifactFields("],
    "src/product/stage-research.ts": ["executionAdmission("],
    "src/product/early-stage-driver.ts": ["executionAdmission(", "orderedQuestions("],
    "src/graph/research-evidence.ts": ["discoveryActors(", "orderedQuestions("],
    "src/om/selected-specification.ts": ["hasBasisApplications("],
  };
  // Сравнение сохранённой Discovery-эры с числом — запрещённая внешняя интерпретация.
  const eraBranch = /\b(?:contractVersion|era)\s*===\s*\d|\bcontractVersion\s*[<>]=?\s*[1-9]/;
  for (const [file, calls] of Object.entries(callSites)) {
    const sourceText = readFileSync(join(root, file), "utf8");
    for (const call of calls)
      assert.ok(sourceText.includes(call), `${file} должен реально вызывать ${call}`);
    assert.equal(eraBranch.test(sourceText), false,
      `${file} не должен ветвиться по сырой эре контракта — предикаты живут в projection-reader`);
  }
});

test("boundary: hasBasisApplications — правило форм за границей", () => {
  assert.equal(hasBasisApplications([
    { stage: "discovery", contractVersion: 6 },
    { stage: "concept", contractVersion: 6 },
    { stage: "specification", contractVersion: 6 },
  ]), true);
  assert.equal(hasBasisApplications([
    { stage: "discovery", contractVersion: 5 },
    { stage: "concept", contractVersion: 6 },
    { stage: "specification", contractVersion: 6 },
  ]), false, "одна pre-v6 эра ломает базисное правило целиком");
  assert.equal(hasBasisApplications([
    { stage: "discovery", contractVersion: 6 },
    { stage: "discovery", contractVersion: 6 },
    { stage: "concept", contractVersion: 6 },
    { stage: "specification", contractVersion: 6 },
  ]), false, "лишняя строка производителя не принимается");
});

test('R v7 admission remains explicit and requires an accepted plan without opening stage-result',async t=>{
  const {store,discovery}=fixture(t);
  const {createPartialV7Draft}=await import('../src/discovery/v7-contracts.js');
  const draft=createPartialV7Draft(discovery,'r-boundary','concept');
  const before=store.list();
  assert.equal(executionAdmission(store,draft,'new-research').admitted,false);
  assert.equal(executionAdmission(store,draft,'stage-result',{discovery:7}).admitted,false);
  assert.throws(()=>executionAdmission(store,draft,'new-research',{discovery:7}),{code:'plan_questions_invalid'});
  assert.equal(acceptedIssuance(store,draft).issued,false);
  assert.deepEqual(store.list(),before);
});

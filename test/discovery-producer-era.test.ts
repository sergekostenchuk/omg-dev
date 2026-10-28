import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Discovery, type DiscoveryDraft, type FieldSpec, type Question } from "../src/discovery/discovery.js";
import {
  LEGACY_REQUIREMENTS, NEXT_CONTRACT_ERA, producerContractEra, producerRequirements,
  REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, VERSION2_REQUIREMENTS,
  VERSION3_REQUIREMENTS, VERSION4_REQUIREMENTS, VERSION5_REQUIREMENTS, VERSION6_REQUIREMENTS,
  type ProducerPolicy, type UpstreamStage,
} from "../src/discovery/requirements.js";
import {
  acceptedIssuance, executionAdmission, isCurrentEra, issuedForm, outcomeSummary,
  researchContract,
} from "../src/discovery/projection-reader.js";
import { reference } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import type { ResearchTurn } from "../src/discovery/research-model.js";
import { preparedField } from "./preparation-fixture.js";
import { answerDiscoveryFixture } from "./product-fixture.js";

const V7: ProducerPolicy = { discovery: NEXT_CONTRACT_ERA };

/** Законный потребитель стадии — следующая за ней (как выбирает engine.prepare). */
const CONSUMER: Record<UpstreamStage, string> = {
  discovery: "concept", concept: "operation-map", "operation-map": "specification",
  specification: "features", features: "om-g2",
};

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr1b-era-"));
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store);
  const discovery = new Discovery(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, engine, discovery };
}

function source(discovery: Discovery, project: string) {
  return discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
}

/** Отвечает каждый вопрос драфта записью его собственного kind/proof — тот же
 * приём, что в граничных тестах DR0. */
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

const fieldNames = (specs: readonly FieldSpec[]) => specs.map(spec => spec.field);

/** Типизированный отказ синхронного пути (assert.throws здесь типизирован void). */
function thrown(fn: () => unknown): { code?: string; message: string } {
  try { fn(); } catch (error) { return error as { code?: string; message: string }; }
  throw new Error("expected a typed refusal");
}

/** Типизированный отказ асинхронного пути. */
async function rejected(run: Promise<unknown>): Promise<{ code?: string; message: string }> {
  return run.then(() => { throw new Error("expected a typed refusal"); },
    error => error as { code?: string; message: string });
}

test("DR1b: producerContractEra — одна функция эры производителя по стадии", () => {
  assert.equal(RESEARCH_CONTRACT_VERSION, 6);
  assert.equal(NEXT_CONTRACT_ERA, 7);
  for (const stage of UPSTREAM_STAGES) {
    assert.equal(producerContractEra(stage), RESEARCH_CONTRACT_VERSION, `${stage}: выключено — прежняя 6`);
    assert.equal(producerContractEra(stage, {}), RESEARCH_CONTRACT_VERSION, `${stage}: пустая политика — прежняя 6`);
  }
  assert.equal(producerContractEra("discovery", V7), NEXT_CONTRACT_ERA);
  for (const stage of UPSTREAM_STAGES.filter(stage => stage !== "discovery"))
    assert.equal(producerContractEra(stage, V7), RESEARCH_CONTRACT_VERSION,
      `${stage}: выключатель discovery не меняет соседние стадии`);
  assert.equal(producerContractEra("concept", { concept: NEXT_CONTRACT_ERA }), NEXT_CONTRACT_ERA,
    "политика выбирается по стадии, а не глобально");
});

test("DR1b: выключено — все пять стадий производят v6-драфты с прежними specs", t => {
  const { engine, discovery } = fixture(t);
  for (const stage of UPSTREAM_STAGES) {
    const expected = REQUIREMENTS[stage];
    const draft = discovery.forStage("off", stage, CONSUMER[stage]);
    assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION, stage);
    assert.equal(draft.value.questions.length, expected.length, stage);
    assert.deepEqual(draft.value.questions.map(id =>
      engine.store.get<Question>(id)!.value.spec), expected,
      `${stage}: specs нового драфта побайтно прежние`);
    assert.deepEqual(Object.keys(draft.value.fields), [...fieldNames(expected)].sort(),
      `${stage}: сохранённые fields — канонический порядок имён, набор прежний`);
  }
  // Реальный продуктовый путь (engine.prepare → forStage) — та же эра, инъекции в нём нет.
  engine.execute({ type: "create-project", project: "off", title: "off" });
  assert.equal(engine.prepare("off", "discovery").value.contractVersion, RESEARCH_CONTRACT_VERSION);
});

test("DR1b: включено инъекцией — Discovery отказывает до записи, остальные стадии производят v6", t => {
  const { store, discovery } = fixture(t);
  const before = store.list().map(row => ({ id: row.id, revision: row.revision, hash: row.hash }));
  const refusal = thrown(() => discovery.forStage("on", "discovery", CONSUMER.discovery, [], V7));
  assert.equal(refusal.code, "discovery_v7_producer_not_ready");
  assert.deepEqual(store.list().map(row => ({ id: row.id, revision: row.revision, hash: row.hash })), before,
    "ни драфта, ни вопросов, ни оплаты — отказ до любой записи");
  assert.equal(store.list("discovery-draft").length, 0);
  assert.equal(store.list("question").length, 0);
  assert.equal(store.list("model-call").length, 0);

  for (const stage of UPSTREAM_STAGES.filter(stage => stage !== "discovery")) {
    const draft = discovery.forStage("on", stage, CONSUMER[stage], [], V7);
    assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION,
      `${stage}: включённый выключатель discovery её не меняет`);
    assert.deepEqual(draft.value.questions.map(id => store.get<Question>(id)!.value.spec),
      REQUIREMENTS[stage], `${stage}: specs прежние`);
  }
  // Политика стадийная: включённый концепт отказывает, Discovery при этом производит прежнюю 6.
  const conceptRefusal = thrown(() =>
    discovery.forStage("on", "concept", CONSUMER.concept, [], { concept: NEXT_CONTRACT_ERA }));
  assert.equal(conceptRefusal.code, "discovery_v7_producer_not_ready");
  assert.equal(discovery.forStage("on", "discovery", CONSUMER.discovery, [], { concept: NEXT_CONTRACT_ERA })
    .value.contractVersion, RESEARCH_CONTRACT_VERSION);
});

test("DR1b: приоритет отказов forStage сохранён — нет стадии раньше not-ready", t => {
  const { discovery } = fixture(t);
  const missing = thrown(() =>
    discovery.forStage("on", "no-such-stage" as UpstreamStage, "concept", [], V7));
  assert.equal(missing.code, "stage_contract_missing",
    "некорректная стадия отвергается прежней проверкой даже под инъекцией");
});

test("DR1b: executionAdmission и сообщения допуска берут эру производителя стадии", t => {
  const { store, discovery } = fixture(t);
  const v6 = (stage: UpstreamStage) => discovery.forStage("adm", stage, CONSUMER[stage]);
  // Выключено — прежняя матрица допуска.
  assert.equal(executionAdmission(store, v6("discovery"), "new-research").admitted, true);
  assert.equal(executionAdmission(store, v6("discovery"), "stage-result").admitted, true);
  // Включено инъекцией: v6-драфт discovery больше не эра производителя — upgrade,
  // оплаченная работа удерживается (paused), а не отвергается.
  const held = executionAdmission(store, v6("discovery"), "new-research", V7);
  assert.equal(held.admitted, false);
  assert.equal(held.upgradeRequired, true);
  assert.equal(held.paused, true);
  assert.equal(held.message,
    "Paid v6 work is retained; prepare Discovery v7 before new research or acceptance");
  assert.equal(executionAdmission(store, v6("discovery"), "stage-result", V7).admitted, false);
  // Соседняя стадия под тем же выключателем — прежний допуск.
  assert.equal(executionAdmission(store, v6("concept"), "new-research", V7).admitted, true);
  // Сообщения сохранённых эр: v5 — эра производителя стадии, v4 — прежний фиксированный текст.
  const v5 = discovery.create("adm", "discovery", "R0", "concept", VERSION5_REQUIREMENTS.discovery, [], 5);
  assert.equal(executionAdmission(store, v5, "new-research").message,
    "Paid v5 work is retained; prepare Discovery v6 before new research or acceptance");
  assert.equal(executionAdmission(store, v5, "new-research", V7).message,
    "Paid v5 work is retained; prepare Discovery v7 before new research or acceptance");
  const v4 = discovery.create("adm", "discovery", "R0", "concept", VERSION4_REQUIREMENTS.discovery, [], 4);
  for (const policy of [undefined, V7] as const)
    assert.equal(executionAdmission(store, v4, "new-research", policy).message,
      "Paid v4 work is retained; prepare Discovery v5 before new research or acceptance",
      "v4 сохраняет своё историческое сообщение при любом положении выключателя");
  // early-drive читает сохранённые admission-эры — политика производителя его не трогает.
  for (const draft of [v4, v5, v6("discovery")])
    for (const policy of [undefined, V7] as const)
      assert.equal(executionAdmission(store, draft, "early-drive", policy).admitted, true);
});

test("DR1b: researchContract и isCurrentEra стали стадийными — история не переоценивается", t => {
  const { engine, discovery } = fixture(t);
  const evidence = source(discovery, "hist");
  const accepted = answerAll(engine, "hist",
    discovery.forStage("hist", "discovery", CONSUMER.discovery), evidence);
  assert.equal(accepted.value.contractVersion, RESEARCH_CONTRACT_VERSION);

  for (const acceptedFlag of [false, true]) {
    const contract = researchContract("discovery", 6, acceptedFlag, V7);
    assert.equal(contract.supported, acceptedFlag,
      "принятая v6-история поддерживается и при включённом выключателе; непринятая — уже не текущая");
    assert.equal(researchContract("concept", 6, acceptedFlag, V7).supported, true,
      "соседняя стадия под тем же выключателем — прежняя текущая эра");
  }
  assert.equal(researchContract("discovery", 6, false).supported, true, "выключено — прежнее поведение");
  assert.equal(isCurrentEra("discovery", 6), true);
  assert.equal(isCurrentEra("discovery", 6, V7), false);
  assert.equal(isCurrentEra("concept", 6, V7), true);
  assert.equal(isCurrentEra("discovery", 5), false);
});

test("DR1b: исследовательский run берёт эру производителя — upgrade по инъекции и по умолчанию", async t => {
  const { store, engine, discovery, root } = fixture(t);
  const project = "runner";
  engine.execute({ type: "create-project", project, title: project });
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: "author", model: "fixture", effort: "medium", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "medium", command },
    fullCheck: command, timeoutMs: 10_000 }, 0);

  for (const [version, specs] of [[4, VERSION4_REQUIREMENTS.discovery],
      [5, VERSION5_REQUIREMENTS.discovery]] as const) {
    const draft = discovery.create(project, "discovery", "R0", "concept", specs, [], version);
    const off = await rejected(engine.researcher.run(project, draft.id, 3));
    assert.equal(off.code, "research_contract_upgrade_required", `v${version} выключено`);
    assert.match(off.message, new RegExp(`prepare Discovery v${RESEARCH_CONTRACT_VERSION}`));
    const on = await rejected(engine.researcher.run(project, draft.id, 3, undefined, { producerPolicy: V7 }));
    assert.equal(on.code, "research_contract_upgrade_required", `v${version} включено`);
    assert.match(on.message, /prepare Discovery v7/);
    assert.equal(store.list("model-call").length, 0, "отказ до любой оплаты");
  }

  // Включённый выключатель делает оплаченный v6-драфт discovery «прежним» —
  // новая работа отказывает upgrade-ом; restore сохранённого по-прежнему работает.
  const current = discovery.forStage(project, "discovery", CONSUMER.discovery);
  const on = await rejected(engine.researcher.run(project, current.id, 3, undefined, { producerPolicy: V7 }));
  assert.equal(on.code, "research_contract_upgrade_required");
  assert.match(on.message, /prepare Discovery v7/);
  // Выключено — тот же run не отказан апгрейдом (идёт в рабочий прогон и падает
  // на фиктивной команде --version, не на допуске).
  const outcome = await engine.researcher.run(project, current.id, 3).catch(error => error);
  assert.notEqual((outcome as { code?: string })?.code, "research_contract_upgrade_required",
    "выключено: допуск прошёл, отказ — не upgrade");
  // Политика — параметр вызова, не команда: соседняя стадия под тем же объектом не затронута.
  const sibling = discovery.forStage(project, "concept", CONSUMER.concept);
  const siblingOutcome = await engine.researcher.run(project, sibling.id, 3, undefined, { producerPolicy: V7 })
    .catch(error => error);
  assert.notEqual((siblingOutcome as { code?: string })?.code, "research_contract_upgrade_required",
    "concept под выключателем discovery — прежний допуск");
});

/** Прерывание на границе сохранения (как dry5Stop в stage-research): пакет
 * уходит в базу, процесс «умирает» — остаётся подлинный pending paid turn. */
function writeStop(store: Store, match: (write: Write) => boolean) {
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const saved = original(writes, guards);
    if (!hit && writes.some(match)) { hit = true; throw new Error("DR1b deliberate process boundary"); }
    return saved;
  }) as typeof store.writeMany;
  return () => { store.writeMany = original; assert.ok(hit, "The real persistence boundary was reached"); };
}

const READ_ADAPTER = `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(process.argv[3],'call\\n');
const src=(c.inventory?.sources??c.originals?.sources??[]).find(s=>s.location==='values');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,
 research:{action:'read_source',source:src.ref,start:0,end:20}}));`;

test("DR1b: оплаченный pending-ход восстанавливается под включённым выключателем без повторной оплаты", async t => {
  const { root, store, engine } = fixture(t);
  const project = "paid-restore";
  engine.execute({ type: "create-project", project, title: project });
  const values = Object.fromEntries(REQUIREMENTS.discovery.map(spec => [spec.field, preparedField(project, spec.field)]));
  const valuesPath = join(root, "values.json"), callsPath = join(root, "calls");
  writeFileSync(valuesPath, JSON.stringify(values));
  const adapter = join(root, "adapter.mjs"); writeFileSync(adapter, READ_ADAPTER);
  engine.discovery.evidence.document(project, "values", JSON.stringify(values), "application/json", 0);
  const command = { executable: process.execPath, args: [adapter, valuesPath, callsPath] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: "author", model: "fixture", effort: "medium", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000 }, 0);
  const draft = engine.prepare(project, "discovery");
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);

  // Процесс умирает после сохранения оплаченного ответа модели — подлинный
  // pending paid turn (тот же приём, что DS1-09 на производителе v4).
  const stop = writeStop(store, write => write.kind === "model-response");
  await engine.researcher.run(project, draft.id, 8).catch(() => undefined);
  stop();
  const pending = store.list<{ state: string; cursor?: { turn?: number } }>("research-consumer-intent")
    .find(intent => intent.value.state === "running");
  assert.ok(pending, "оплаченный ход сохранён как running-интент до восстановления");
  const paidCalls = store.list("model-call").map(row => ({ id: row.id, revision: row.revision, hash: row.hash }));
  const callsBefore = readFileSync(callsPath, "utf8");

  // Восстановление читает сохранённые записи до любых текущих допусков —
  // порядок чтений фиксируем обёрнутым Store.
  const reads: string[] = [];
  const traced = new Store(join(root, "state.sqlite")); t.after(() => traced.close());
  const get = traced.get.bind(traced);
  traced.get = ((id: string, revision?: number) => { reads.push(id); return get(id, revision); }) as typeof traced.get;
  const restored = await new ProductEngine(traced)
    .researcher.run(project, draft.id, 8, undefined, { producerPolicy: V7 });
  assert.equal(traced.get<{ state: string }>(pending.id)!.value.state, "applied",
    "оплаченный ход восстановлен под включённым выключателем");
  const turn = traced.list<ResearchTurn>("research-turn").find(row => row.id.startsWith("research-turn:v1:"));
  assert.equal(turn?.value.status, "completed", "сохранённый ответ применён — ход завершён");
  assert.equal(restored.value.status, "paused");
  assert.equal(restored.value.pauseCode, "research_contract_upgrade_required");
  assert.match(restored.value.error ?? "", /Restore cannot prepare a new research question/);
  assert.deepEqual(traced.list("model-call").map(row => ({ id: row.id, revision: row.revision, hash: row.hash })),
    paidCalls, "восстановление оплаченного ответа не делает новых оплат");
  assert.equal(readFileSync(callsPath, "utf8"), callsBefore, "ни одного нового обращения к модели");
  assert.notEqual(reads.indexOf(turn!.id), -1, "сохранённый ход читается при восстановлении");
  assert.notEqual(reads.indexOf(pending.id), -1, "running-интент читается при восстановлении");
});

test("DR1b: принятая история v1–v6 читается границей как раньше и при включённом выключателе", t => {
  const { store, engine, discovery } = fixture(t);
  const editions: [string, FieldSpec[], number | undefined][] = [
    ["v1 (нет contractVersion)", LEGACY_REQUIREMENTS.discovery, undefined],
    ["v2", VERSION2_REQUIREMENTS.discovery, 2],
    ["v3", VERSION3_REQUIREMENTS.discovery, 3],
    ["v4", VERSION4_REQUIREMENTS.discovery, 4],
    ["v5", VERSION5_REQUIREMENTS.discovery, 5],
    ["v6 (замороженное издание)", VERSION6_REQUIREMENTS.discovery, 6],
    ["v6 (издание аналогов)", REQUIREMENTS.discovery, 6],
  ];
  for (const [name, specs, version] of editions) {
    const project = `hist-${version ?? 1}-${name.includes("аналог") ? "a" : "f"}`;
    const evidence = source(discovery, project);
    const draft = answerAll(engine, project,
      discovery.create(project, "discovery", "R0", "concept", specs, [], version), evidence);
    // Читатели сохранённых эр не принимают политику — выключатель не может
    // переоценить принятую историю; проверяем обе операции границы.
    const issuance = acceptedIssuance(store, draft);
    assert.equal(issuance.issued, true, name);
    if (issuance.issued) {
      assert.equal(issuance.era, version ?? 1, name);
      assert.deepEqual(issuance.fields, fieldNames(specs), name);
    }
    const summary = outcomeSummary(store, draft, issuedForm(store, draft));
    assert.equal(summary.era, version ?? 1, name);
    assert.equal(summary.form.defect, null, name);
  }
});

test("DR1b: эры принадлежат Discovery; отдельная owner-дверь только сохраняет разрешение проекта", () => {
  const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(srcRoot);
  const banned = /producerContractEra|producerRequirements|ProducerPolicy|NEXT_CONTRACT_ERA|PRODUCER_V7_STAGES|discovery_v7_producer_not_ready/;
  const offenders = files
    .filter(file => !file.startsWith(join(srcRoot, "discovery") + "/"))
    .filter(file => banned.test(readFileSync(file, "utf8")));
  const ownerDoor = [join(srcRoot, 'cli.ts'), join(srcRoot, 'product/producer-policy-authority.ts')];
  assert.deepEqual(offenders.sort(), ownerDoor.sort(),
    'Only the separate owner door may carry producer-policy authority outside Discovery');
  for (const file of ownerDoor) assert.doesNotMatch(readFileSync(file, 'utf8'),
    /producerContractEra|producerRequirements|NEXT_CONTRACT_ERA|PRODUCER_V7_STAGES|discovery_v7_producer_not_ready/,
    'The owner door stores a scoped permission; interpreting eras remains inside Discovery');
});

test("DR1b: канонические specs выключенного и включённого производителя совпадают", t => {
  const { store, discovery } = fixture(t);
  for (const stage of UPSTREAM_STAGES.filter(stage => stage !== "discovery")) {
    const off = discovery.forStage("eq", stage, CONSUMER[stage]);
    const on = discovery.forStage("eq", stage, CONSUMER[stage], [], V7);
    assert.equal(on.value.contractVersion, off.value.contractVersion, stage);
    assert.deepEqual(on.value.questions.map(id => store.get<Question>(id)!.value.spec),
      off.value.questions.map(id => store.get<Question>(id)!.value.spec),
      `${stage}: specs побайтно одинаковы при любом положении выключателя`);
  }
  assert.equal(producerRequirements("discovery"), REQUIREMENTS.discovery);
  assert.throws(() => producerRequirements("discovery", V7), { code: "discovery_v7_producer_not_ready" });
});

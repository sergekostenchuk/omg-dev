// Тесты входного контракта M1. Стадии omg-live читаются ТОЛЬКО на чтение; дефекты вносятся в копии.
import test from "node:test"; import assert from "node:assert/strict"; import { DatabaseSync } from "node:sqlite"; import { homedir } from "node:os"; import { join } from "node:path";
import { buildOmInput, gateInput } from "./input.mjs";
const db = new DatabaseSync(join(homedir(), "OMG/.omg/state.sqlite"), { readOnly: true });
const load = () => Object.fromEntries(["discovery", "concept", "operation-map", "specification", "features"].map(st => { const r = db.prepare(`SELECT r.entity_id id, r.revision, r.sha256 hash, r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id=?`).get(`stage:omg-live:${st}`);
  const body = JSON.parse(r.body); const d = body.content.draft; const draft = d ? db.prepare(`SELECT body, sha256 FROM revisions WHERE entity_id=? AND revision=?`).get(d.id, d.revision) : null;
  if (draft && draft.sha256 !== d.hash) throw new Error("черновик стадии не соответствует точной ссылке");       // версия контракта берётся из ТОЧНОЙ записи черновика
  return [st, { ref: { id: r.id, revision: r.revision, hash: r.hash }, fields: body.content.fields, contractVersion: draft ? JSON.parse(draft.body).contractVersion : undefined }]; }));
const codes = list => Object.fromEntries([...new Set(list.map(x => x.code))].sort().map(c => [c, list.filter(x => x.code === c).length]));

test("живые стадии omg-live: ссылки целы, ворота входа пройдены; вся проза стала адресными пробелами с потребителями", () => {
  const r = buildOmInput(load()); assert.deepEqual(r.refusals, []); assert.equal(gateInput(r).passed, true);
  assert.equal(r.input.contracts.length, 20); assert.equal(r.input.features.length, 20); assert.equal(r.input.requirements.length, 25); assert.equal(r.input.sources.length, 5);
  const g = codes(r.gaps); assert.equal(g.contract_node_unbound, 20, "ни один из 20 контрактов не привязан к блокам по id"); assert.equal(g.inventory_missing, 1); assert.ok(g.acceptance_kind_missing > 0 && g.contract_boundary_prose === 20);
  assert.ok(r.gaps.every(x => x.consumer), "у каждого пробела назван потребитель"); assert.ok(r.input.contracts.every(c => c.nodes === null)); });

test("вход детерминирован: тот же хэш при повторе и при другом порядке ключей и элементов", () => {
  const a = buildOmInput(load()); const s = load(); s.specification.fields.behaviorContracts.reverse(); s.features = { ref: s.features.ref, fields: Object.fromEntries(Object.entries(s.features.fields).reverse()) };
  const b = buildOmInput(s); assert.equal(a.hash, buildOmInput(load()).hash); assert.equal(JSON.stringify(a.input.contracts), JSON.stringify(b.input.contracts)); });

test("битые ссылки — отказ ворот входа с типизированным кодом, а не пробел и не догадка", () => {
  const bad = (mut, code) => { const s = load(); mut(s); const r = buildOmInput(s); assert.ok(r.refusals.some(x => x.code === code), `ожидался ${code}: ${JSON.stringify(codes(r.refusals))}`); assert.equal(gateInput(r).passed, false); };
  bad(s => s.specification.fields.behaviorContracts[0].requirements.push("req-нет-такого"), "requirement_ref_unresolved");
  bad(s => s.features.fields.features[0].requirements.push(999), "behavior_index_out_of_range");
  bad(s => s.features.fields.featurePreparation[0].behaviorContracts.push("bc-нет-такого"), "contract_ref_unresolved");
  bad(s => { s.features.fields.featurePreparation.find(p => p.remainingQuestions.length).remainingQuestions[0].consumer = " "; }, "question_consumer_missing");
  bad(s => { s.features.fields.features[0].outcome = "a-нет-такого"; }, "outcome_artifact_unknown");
  bad(s => { s.specification.fields.behaviorContracts[0].nodes = ["n-нет-такого"]; }, "contract_node_unknown");
  bad(s => { s.specification.fields.behaviorContracts[0].nodes = []; }, "contract_node_unbound");          // поле задано и пусто — отказ в любой эре
  bad(s => { s.specification.fields.behaviorContracts[0].nodes = "n-intake"; }, "contract_node_unbound");   // не список id
  bad(s => { s.features.fields.featurePreparation[0].featureTitle += " (другая)"; }, "feature_preparation_missing");
  bad(s => { s.features.fields.featurePreparation.push(structuredClone(s.features.fields.featurePreparation[0])); }, "feature_preparation_ambiguous");
  bad(s => { delete s.specification.fields.behaviorContracts; }, "input_field_missing"); bad(s => { delete s.concept; }, "input_field_missing"); });

test("привязка контракта к блокам — по id и «один ко многим»; упоминание блока в прозе привязкой не считается", () => {
  const s = load(); const c = s.specification.fields.behaviorContracts[0]; assert.ok(JSON.stringify(c).includes("n-intake"), "в прозе контракта блок упомянут");
  assert.equal(buildOmInput(s).input.contracts.find(x => x.id === c.id).nodes, null, "проза не превратилась в привязку");
  c.nodes = ["n-state", "n-intake"]; const r = buildOmInput(s); assert.deepEqual(r.input.contracts.find(x => x.id === c.id).nodes, ["n-intake", "n-state"]);
  assert.equal(codes(r.gaps).contract_node_unbound, 19); assert.equal(gateInput(r).passed, true); });

test("вид проверки у критерия и инвентарь закрывают свои пробелы; неизвестный вид проверки остаётся пробелом", () => {
  const s = load(); const req = s.concept.fields.conceptSections[0].requirements[0]; const before = codes(buildOmInput(s).gaps).acceptance_kind_missing;
  req.acceptance[0] = { text: req.acceptance[0], checkKind: "test" }; req.acceptance[1] = { text: req.acceptance[1], checkKind: "на глаз" };
  const r = buildOmInput(s, { inventory: { ref: { id: "repo-inventory:omg-live", revision: 1, hash: "a".repeat(64) } } }); const g = codes(r.gaps);
  assert.equal(g.acceptance_kind_missing, before - 1); assert.equal(g.inventory_missing, undefined); assert.equal(r.input.inventory.id, "repo-inventory:omg-live"); });

test("вердикт №1 п.1: перестановка подготовки привязок не меняет — подготовка сопоставляется с фичей по названию и исходу, не по месту", () => {
  const a = buildOmInput(load()); const s = load(); s.features.fields.featurePreparation.reverse(); const b = buildOmInput(s);
  assert.deepEqual(b.refusals, []); assert.equal(b.hash, a.hash, "вход тот же"); const first = b.input.features[0], spec = s.specification.fields.behaviorContracts;
  for (const id of first.contracts) assert.equal(spec.find(c => c.id === id).outcome, first.outcome, "у фичи только контракты её исхода");
  assert.deepEqual(b.gaps, a.gaps, "потребители пробелов те же"); });

test("вердикт №1 п.2: эру определяет версия контракта точной записи стадии, а не наличие поля", () => {
  const s = load(); assert.ok(Number.isInteger(s.specification.contractVersion) || s.specification.contractVersion === undefined);
  const v = s.specification.contractVersion ?? 1; assert.equal(gateInput(buildOmInput(s)).passed, true, "пока новая эра не введена — исторический пробел");
  const older = buildOmInput(load(), { nodesRequiredSince: v + 1 }); assert.equal(gateInput(older).passed, true, "запись прежней версии: отсутствие поля — пробел"); assert.equal(older.gaps.filter(g => g.code === "contract_node_unbound").length, 20);
  const s2 = load(); s2.specification.contractVersion = v; const now = buildOmInput(s2, { nodesRequiredSince: v }); assert.equal(gateInput(now).passed, false, "запись новой версии: отсутствие обязательного поля — отказ, удаление поля пробелом не становится");
  assert.equal(now.refusals.filter(r => r.code === "contract_node_unbound").length, 20); assert.equal(now.gaps.filter(g => g.code === "contract_node_unbound").length, 0); });

test("вердикт №2, риск 1: при введённом пороге эры версия контракта обязана определяться — невозможность её прочитать прежней эрой не считается", () => {
  const s = load(); s.specification.contractVersion = undefined; const r = buildOmInput(s, { nodesRequiredSince: 3 });
  assert.ok(r.refusals.some(x => x.code === "stage_contract_version_unknown")); assert.equal(gateInput(r).passed, false); assert.equal(gateInput(buildOmInput(s)).passed, true, "без порога эры различать нечего"); });

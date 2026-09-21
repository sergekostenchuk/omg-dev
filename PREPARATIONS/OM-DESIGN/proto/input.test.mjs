// Тесты входного контракта M1. Стадии omg-live читаются ТОЛЬКО на чтение; дефекты вносятся в копии.
import test from "node:test"; import assert from "node:assert/strict"; import { DatabaseSync } from "node:sqlite"; import { homedir } from "node:os"; import { join } from "node:path";
import { buildOmInput, gateInput } from "./input.mjs";
const db = new DatabaseSync(join(homedir(), "OMG/.omg/state.sqlite"), { readOnly: true });
const load = () => Object.fromEntries(["discovery", "concept", "operation-map", "specification", "features"].map(st => { const r = db.prepare(`SELECT r.entity_id id, r.revision, r.sha256 hash, r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id=?`).get(`stage:omg-live:${st}`);
  return [st, { ref: { id: r.id, revision: r.revision, hash: r.hash }, fields: JSON.parse(r.body).content.fields }]; }));
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
  bad(s => { s.specification.fields.behaviorContracts[0].nodes = []; }, "contract_node_unbound");          // новая эра: поле объявлено и пусто — отказ
  bad(s => { s.specification.fields.behaviorContracts[0].nodes = "n-intake"; }, "contract_node_unbound");   // не список id
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

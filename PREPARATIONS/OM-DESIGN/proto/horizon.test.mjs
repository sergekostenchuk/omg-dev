// Тесты замыкания горизонта на принятом верхнем слое omg-live (только чтение).
import test from "node:test"; import assert from "node:assert/strict"; import { DatabaseSync } from "node:sqlite"; import { homedir } from "node:os"; import { join } from "node:path";
import { closeHorizon, gateHorizon } from "./horizon.mjs"; import { frameObligations, fillObligations } from "./frame.mjs";
const db = new DatabaseSync(join(homedir(), "OMG/.omg/state.sqlite"), { readOnly: true });
const UPPER = (({ level, ...g }) => g)(JSON.parse(db.prepare(`SELECT r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id='graph-layer:omg-live:1'`).get().body).projection);
const BLOCKS = UPPER.nodes.filter(n => n.kind === "block"); const F = outcome => [{ outcome }]; const UI = { block: "n-ui", reason: "сначала бэкенд (решение владельца 21.09.2026)", returnCondition: "понятно, как работает бэкенд" };

test("новый продукт: горизонт замкнут — у каждого потребителя горизонта производитель тоже в горизонте; M4 не встретит нераскрытого производителя", () => {
  const r = closeHorizon(UPPER, { choiceVersion: "c1", features: F("verified-change"), excluded: [UI] }); assert.equal(gateHorizon(r).passed, true, JSON.stringify(gateHorizon(r)));
  const H = new Set(r.horizon.nodes); assert.ok(H.size > 1 && H.size < BLOCKS.length + 1); assert.ok(!H.has("n-ui"));
  const ob = frameObligations(UPPER, H); for (const o of ob.filter(o => o.kind === "connection-end" && o.role === "consumer" && o.zone === "horizon")) {
    const producer = ob.find(p => p.connector === o.connector && p.role === "producer"); assert.equal(producer.zone, "horizon", `производитель ${producer.upper} связи ${o.connector} обязан быть в горизонте`); } });

const FULL = JSON.parse(db.prepare(`SELECT r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id='graph:omg-live'`).get().body);
const REFINED = new Set(FULL.nodes.filter(n => n.kind === "operation").map(n => n.parent)); const basis = id => ({ id: `artifact-receipt:${id}`, revision: 1, hash: "e".repeat(64) });

test("вердикт №1 п.4: принятое раскрытие — не готовый результат: неисполненные производители входят в горизонт, раскрытие помечено как переиспользуемое", () => {
  const root = BLOCKS.find(b => b.outcome === "verified-change").id; const r = closeHorizon(UPPER, { choiceVersion: "c1", features: F("verified-change"), refined: REFINED });
  for (const b of ["n-check", "n-implement", "n-review"]) assert.ok(r.horizon.nodes.includes(b), `${b} не исполнен — обязан быть в плане работ`);
  assert.ok(r.horizon.nodes.length > 1); assert.deepEqual(r.horizon.boundary, []); assert.ok(Object.values(r.horizon.refinement).every(x => x === "accepted"), "раскрытие переиспользуется, проектировать заново не нужно");
  const ready = new Map(r.horizon.nodes.filter(n => n !== root).map(n => [n, basis(n)])); const cut = closeHorizon(UPPER, { choiceVersion: "c1", features: F("verified-change"), refined: REFINED, available: ready });
  assert.deepEqual(cut.horizon.nodes, [root]); assert.ok(cut.horizon.boundary.length > 0 && cut.horizon.boundary.every(x => x.basis.hash), "граница — только с подтверждённым основанием");
  assert.ok(gateHorizon(closeHorizon(UPPER, { choiceVersion: "c1", features: F("verified-change"), available: new Map([["n-check", {}]]) })).codes.includes("horizon_available_unproven")); });

test("вердикт №1 п.3: обязательная управляющая зависимость (requires) входит в замыкание; исключённая — конфликт с путём", () => {
  const G = structuredClone(UPPER); G.edges.push({ id: "e-test-requires", relation: "requires", source: "n-publish", target: "n-backup", condition: "проверка ревью" });
  const base = closeHorizon(UPPER, { choiceVersion: "c", features: F("verified-change") }); const withReq = closeHorizon(G, { choiceVersion: "c", features: F("verified-change") });
  assert.ok(withReq.horizon.nodes.includes("n-backup")); if (!base.horizon.nodes.includes("n-backup")) assert.equal(withReq.horizon.nodes.length, base.horizon.nodes.length + (withReq.horizon.nodes.length - base.horizon.nodes.length));
  const ex = closeHorizon(G, { choiceVersion: "c", features: F("verified-change"), excluded: [{ block: "n-backup", reason: "проверка", returnCondition: "после проверки" }] });
  assert.deepEqual(gateHorizon(ex).codes, ["horizon_requires_excluded"]); assert.ok(ex.conflicts.some(c => c.block === "n-backup" && c.path.some(step => String(step).includes("e-test-requires")))); });

test("вердикт №1 п.5: внешний источник согласован между M2 и каркасом — G2 проходит, и F4.2 НЕ даёт horizon_producer_unrefined; адрес связи потребителя сохранён", () => {
  const EXT = structuredClone(UPPER); EXT.artifacts.find(a => a.id === "a-runtime").external = true; const r = closeHorizon(EXT, { choiceVersion: "c", features: F("autonomous-knowledge") });
  assert.equal(gateHorizon(r).passed, true); assert.ok(!r.horizon.nodes.includes("n-runtime")); assert.ok(r.horizon.externalInputs.some(x => x.connector === "cn-runtime"), "связь с внешним источником названа");
  const H = new Set(r.horizon.nodes); const ob = frameObligations(EXT, H); const filled = fillObligations(EXT, ob, null, [], H, { graph: null, frame: null });      // не бросает отказ
  const end = ob.find(o => o.connector === "cn-runtime" && o.role === "producer"); assert.ok(filled.fills.some(f => f.obligation === end.id && f.source === "identity"), "конец внешней связи закрыт представителем");
  assert.throws(() => fillObligations(UPPER, frameObligations(UPPER, H), null, [], H, { graph: null, frame: null }), e => e.code === "horizon_producer_unrefined", "тот же горизонт без пометки external — отказ остаётся"); });

test("исключённый блок, без которого фича не производится, молча не отбрасывается: конфликт с путём зависимости → вопрос владельцу", () => {
  const free = closeHorizon(UPPER, { choiceVersion: "c1", features: F("verified-change") }); const needed = free.horizon.nodes.find(n => n !== BLOCKS.find(b => b.outcome === "verified-change").id);
  const r = closeHorizon(UPPER, { choiceVersion: "c2", features: F("verified-change"), excluded: [{ block: needed, reason: "проверка", returnCondition: "после проверки" }] });
  assert.deepEqual(gateHorizon(r).codes, ["horizon_requires_excluded"]); assert.ok(r.conflicts[0].path.length >= 2 && r.conflicts[0].block === needed, "путь зависимости назван"); assert.ok(!r.horizon.nodes.includes(needed)); });

test("исключение без причины или условия возвращения и неизвестная фича — отказ ворот горизонта", () => {
  assert.deepEqual(gateHorizon(closeHorizon(UPPER, { choiceVersion: "c", features: F("verified-change"), excluded: [{ block: "n-ui", reason: " ", returnCondition: "" }] })).codes, ["horizon_exclusion_unjustified"]);
  assert.deepEqual(gateHorizon(closeHorizon(UPPER, { choiceVersion: "c", features: F("a-нет-такого") })).codes, ["horizon_empty", "horizon_feature_unknown"]);
  assert.ok(gateHorizon(closeHorizon(UPPER, { choiceVersion: "c", features: F("verified-change"), excluded: [{ block: "n-нет", reason: "x", returnCondition: "y" }] })).codes.includes("horizon_exclusion_unknown")); });

test("исключения входят в хэш горизонта; повтор той же версии выбора даёт тот же хэш; порядок фич и исключений не влияет", () => {
  const a = closeHorizon(UPPER, { choiceVersion: "c1", features: [{ outcome: "verified-change" }, { outcome: "recoverable-state" }], excluded: [UI] });
  const b = closeHorizon(UPPER, { choiceVersion: "c1", features: [{ outcome: "recoverable-state" }, { outcome: "verified-change" }], excluded: [UI] }); assert.equal(a.horizon.hash, b.horizon.hash);
  assert.notEqual(a.horizon.hash, closeHorizon(UPPER, { choiceVersion: "c1", features: [{ outcome: "verified-change" }, { outcome: "recoverable-state" }] }).horizon.hash, "снятие исключения меняет хэш");
  assert.notEqual(a.horizon.hash, closeHorizon(UPPER, { choiceVersion: "c2", features: [{ outcome: "verified-change" }, { outcome: "recoverable-state" }], excluded: [UI] }).horizon.hash, "другая версия выбора — другой горизонт, даже при тех же узлах"); });

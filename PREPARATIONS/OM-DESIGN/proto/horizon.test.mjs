// Тесты замыкания горизонта на принятом верхнем слое omg-live (только чтение).
import test from "node:test"; import assert from "node:assert/strict"; import { DatabaseSync } from "node:sqlite"; import { homedir } from "node:os"; import { join } from "node:path";
import { closeHorizon, gateHorizon } from "./horizon.mjs"; import { frameObligations } from "./frame.mjs";
const db = new DatabaseSync(join(homedir(), "OMG/.omg/state.sqlite"), { readOnly: true });
const UPPER = (({ level, ...g }) => g)(JSON.parse(db.prepare(`SELECT r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id='graph-layer:omg-live:1'`).get().body).projection);
const BLOCKS = UPPER.nodes.filter(n => n.kind === "block"); const F = outcome => [{ outcome }]; const UI = { block: "n-ui", reason: "сначала бэкенд (решение владельца 21.09.2026)", returnCondition: "понятно, как работает бэкенд" };

test("новый продукт: горизонт замкнут — у каждого потребителя горизонта производитель тоже в горизонте; M4 не встретит нераскрытого производителя", () => {
  const r = closeHorizon(UPPER, { choiceVersion: "c1", features: F("verified-change"), excluded: [UI] }); assert.equal(gateHorizon(r).passed, true, JSON.stringify(gateHorizon(r)));
  const H = new Set(r.horizon.nodes); assert.ok(H.size > 1 && H.size < BLOCKS.length + 1); assert.ok(!H.has("n-ui"));
  const ob = frameObligations(UPPER, H); for (const o of ob.filter(o => o.kind === "connection-end" && o.role === "consumer" && o.zone === "horizon")) {
    const producer = ob.find(p => p.connector === o.connector && p.role === "producer"); assert.equal(producer.zone, "horizon", `производитель ${producer.upper} связи ${o.connector} обязан быть в горизонте`); } });

test("готовые зависимости в горизонт не добираются: при уже раскрытых соседях горизонт — только блок фичи", () => {
  const root = BLOCKS.find(b => b.outcome === "verified-change").id; const r = closeHorizon(UPPER, { choiceVersion: "c1", features: F("verified-change"), refined: new Set(BLOCKS.map(b => b.id).filter(id => id !== root)) });
  assert.deepEqual(r.horizon.nodes, [root]); assert.ok(r.horizon.boundary.length > 0, "готовые зависимости названы границей"); });

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

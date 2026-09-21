// Тесты исполняемой спецификации каркаса. Принятый граф omg-live читается ТОЛЬКО на чтение; запись — во временный Store.
// Запуск: node --test PREPARATIONS/OM-DESIGN/proto/frame.test.mjs   (нужен собранный dist/)
import test from "node:test"; import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite"; import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir, homedir } from "node:os"; import { join } from "node:path";
import { Store } from "../../../dist/src/storage/store.js"; import { reference } from "../../../dist/src/pipeline/contracts.js";
import * as F from "./frame.mjs";

const live = new DatabaseSync(join(homedir(), "OMG/.omg/state.sqlite"), { readOnly: true });
const FULL = JSON.parse(live.prepare(`SELECT r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id='graph:omg-live'`).get().body);
const UPPER = (({ level, ...g }) => g)(JSON.parse(live.prepare(`SELECT r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id='graph-layer:omg-live:1'`).get().body).projection);
const BLOCKS = UPPER.nodes.filter(n => n.kind === "block").map(n => n.id); const P = "proto";
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "om-frame-")); const store = new Store(join(dir, "s.sqlite")); return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } }; };
const baseOf = acc => ({ graph: acc.graph ? reference(acc.graph) : null, frame: acc.frame ? reference(acc.frame) : null });

/** Предложение слоя из настоящих операций выбранных блоков — с ПОЛНЫМ составом: узлы, заполнения, локальные связи, зависимые определения. */
function proposalFor(blocks, obligations, base, rename = null) {
  const R = id => rename?.[id] ?? id; const ops = FULL.nodes.filter(n => n.kind === "operation" && blocks.includes(n.parent)); const ids = new Set(ops.map(o => o.id));
  const fills = []; for (const o of obligations.filter(o => blocks.includes(o.upper))) {
    if (o.kind === "block-outcome") { const n = ops.find(n => n.parent === o.upper && n.outcome === o.artifact); if (n) fills.push({ obligation: o.id, node: R(n.id) }); continue; }
    for (const b of FULL.connectors.find(c => c.id === o.connector).bindings.filter(b => b.level === 2))
      for (const e of (o.role === "producer" ? [b.producer] : b.consumers)) if (ids.has(e.node) && FULL.nodes.find(n => n.id === e.node).parent === o.upper) fills.push({ obligation: o.id, node: R(e.node), port: e.port }); }
  const allOps = new Set(FULL.nodes.filter(n => n.kind === "operation").map(n => n.id)); const toks = x => JSON.stringify(x).split('"');
  // предложение несёт только то, что вводит само: определение касается его операций и не ссылается на операции вне предложения
  const touches = x => toks(x).some(t => ids.has(t)) && toks(x).filter(t => allOps.has(t)).every(t => ids.has(t));
  const swap = x => rename ? JSON.parse(JSON.stringify(x).replace(new RegExp(`"(${Object.keys(rename).join("|")})"`, "g"), (_, k) => `"${rename[k]}"`)) : structuredClone(x);
  const value = { base, level: 2, source: "decision", status: "proposed", nodes: ops.map(swap), fills,
    localConnectors: FULL.connectors.filter(c => !c.bindings.some(b => b.level === 1) && c.bindings.every(b => [b.producer, ...b.consumers].every(e => ids.has(e.node)))).map(swap) };
  for (const key of ["joins", "tests", "edges", "journeys", "packets", "transfers", "anchors"]) value[key] = (FULL[key] ?? []).filter(touches).map(swap);
  const arts = new Set([...ops.map(o => o.outcome), ...value.localConnectors.map(c => c.artifact), ...value.journeys.map(j => j.outcome)]);
  value.artifacts = FULL.artifacts.filter(a => arts.has(a.id) && !UPPER.artifacts.some(u => u.id === a.id));
  const cts = new Set([...ops.flatMap(o => o.ports.map(p => p.contract)), ...value.artifacts.map(a => a.contract)]);
  value.contracts = FULL.contracts.filter(c => cts.has(c.id) && !UPPER.contracts.some(u => u.id === c.id));
  return value;
}
const put = (store, id, value) => store.write({ id: `om-proposal:${id}`, kind: "layer-proposal", expected: 0, value: JSON.parse(JSON.stringify(value)) });
/** Один проход: обязательства → заполнения → кандидат → запись кандидата → принятие. */
function pass(store, horizonIds, makeProposals = () => [], UPPER_ = UPPER) {
  const UPPER = UPPER_; const horizon = new Set(horizonIds); const acc = F.loadAccepted(store, P); const base = baseOf(acc); const obligations = F.frameObligations(UPPER, horizon);
  const proposals = makeProposals(obligations, base, acc); const filled = F.fillObligations(UPPER, obligations, acc, proposals, horizon, base);
  if (filled.open.length) return { obligations, filled, acc };
  const candidate = F.assembleCandidate(UPPER, obligations, filled, acc, proposals, horizon); const rev = F.saveCandidate(store, P, candidate, filled, base, proposals);
  return { obligations, filled, candidate, rev, acc, settle: (ok = true) => F.settleCandidate(store, P, reference(rev), ok) };
}
const refusal = (fn, code) => assert.throws(fn, e => { assert.ok(String(e.code ?? e.message).includes(code) || String(e.message).includes(code), `ожидался ${code}, получено: ${e.code} ${e.message}`); return true; });

test("обязательства строятся по всему верхнему слою, включая связи внешних артефактов (вердикт 2, п.4)", () => {
  const ob = F.frameObligations(UPPER, new Set()); assert.equal(ob.filter(o => o.kind === "block-outcome").length, BLOCKS.length);
  const ends = UPPER.connectors.flatMap(c => c.bindings.filter(b => b.level === 1)).reduce((n, b) => n + 1 + b.consumers.length, 0); assert.equal(ob.filter(o => o.kind === "connection-end").length, ends);
  // в живых данных внешних артефактов нет — как и ревьюер, помечаем a-runtime внешним на КОПИИ верхнего слоя
  const EXT = structuredClone(UPPER); EXT.artifacts.find(a => a.id === "a-runtime").external = true;
  const obE = F.frameObligations(EXT, new Set()); const endsOf = c => 1 + c.bindings[0].consumers.length; const cn = EXT.connectors.find(c => c.id === "cn-runtime");
  assert.equal(obE.filter(o => o.connector === "cn-runtime").length, endsOf(cn), "концы связи внешнего артефакта остаются обязательствами");
  const { store, done } = fresh(); try { const r = pass(store, [], () => [], EXT); const low = r.candidate.graph.connectors.find(c => c.id === "cn-runtime").bindings.find(b => b.level === 2);
    assert.equal(low.consumers.length, cn.bindings[0].consumers.length, "нижняя привязка связи внешнего артефакта собрана и принята настоящим кодом"); } finally { done(); }
});

test("новый продукт, пустой горизонт: слой из представителей принят настоящими валидатором и сборщиком и сохранён с признаком identity", () => {
  const { store, done } = fresh(); try { const r = pass(store, []); assert.equal(r.candidate.graph.nodes.filter(n => n.kind === "operation").length, BLOCKS.length); r.settle();
    const acc = F.loadAccepted(store, P); assert.equal(acc.identity.size, BLOCKS.length); assert.ok(acc.frame.value.fills.every(f => f.source === "identity"));
    for (const c of r.candidate.graph.connectors) assert.ok(c.bindings.some(b => b.level === 2), `у связи ${c.id} есть нижняя привязка`); } finally { done(); } });

test("принятый представитель НЕ закрывает обязательства блока, вошедшего в горизонт; раскрытие заменяет его (вердикт 2, п.3; вердикт 1, п.1)", () => {
  const { store, done } = fresh(); try { pass(store, []).settle(); const H = ["n-intake", "n-state"];
    const bare = pass(store, H); assert.ok(bare.filled.open.length > 0, "без предложений обязательства горизонта открыты, хотя слой из представителей принят");
    assert.ok(bare.filled.open.every(o => H.includes(o.upper))); const gaps = F.openObligationsToGaps(bare.obligations, bare.filled.open);
    assert.ok(gaps.every(g => H.includes(g.consumer) && g.blocking)); assert.ok(gaps.some(g => g.neighbors.length > 1), "у связи с несколькими потребителями соседи не теряются");
    const r = pass(store, H, (ob, base) => [put(store, "h1", proposalFor(H, ob, base))]); const nodes = r.candidate.graph.nodes.map(n => n.id);
    assert.ok(!nodes.includes("i-intake") && !nodes.includes("i-state") && nodes.includes("o-intake")); r.settle();   // проход без конкурента не даёт input_stale (вердикт 2, п.1)
    const acc = F.loadAccepted(store, P); assert.ok(!acc.identity.has("i-intake") && acc.identity.has("i-research")); assert.equal(store.get("om-proposal:h1").value.status, "accepted");
    // уже раскрытый блок вне горизонта переносится целиком, второй представитель не добавляется
    const again = pass(store, []); const ids = again.candidate.graph.nodes.map(n => n.id); assert.ok(ids.includes("o-intake") && !ids.includes("i-intake")); again.settle(); } finally { done(); } });

test("два кандидата одной базы: первый принят, второй получает отказ; отказ G3 принятого не меняет (вердикт 2, п.1)", () => {
  const { store, done } = fresh(); try { pass(store, []).settle(); const H = ["n-intake", "n-state"];
    const a = pass(store, H, (ob, base) => [put(store, "a", proposalFor(H, ob, base))]); const before = F.loadAccepted(store, P).graph.hash;
    const b = pass(store, H, (ob, base) => [put(store, "b", proposalFor(H, ob, base))]);
    a.settle(); refusal(() => b.settle(), "input_stale"); assert.notEqual(F.loadAccepted(store, P).graph.hash, before);
    const c = pass(store, ["n-intake", "n-state", "n-runtime"], (ob, base) => [put(store, "c", proposalFor(["n-runtime"], ob, base))]); const head = F.loadAccepted(store, P).graph.hash;
    c.settle(false); assert.equal(store.get("om-proposal:c").value.status, "rejected"); assert.equal(F.loadAccepted(store, P).graph.hash, head); } finally { done(); } });

test("предложение обязано нести полный состав: без соединений входов и без артефактов кандидат отклоняется (вердикт 2, п.2)", () => {
  const { store, done } = fresh(); try { const strip = key => (ob, base) => { const v = proposalFor(BLOCKS, ob, base); v[key] = []; return [put(store, `no-${key}`, v)]; };
    refusal(() => pass(store, BLOCKS, strip("joins")), "join_missing"); refusal(() => pass(store, BLOCKS, strip("artifacts")), "artifact_missing");
    const ok = pass(store, BLOCKS, (ob, base) => [put(store, "full", proposalFor(BLOCKS, ob, base))]); assert.equal(ok.candidate.graph.nodes.filter(n => n.kind === "operation").length, FULL.nodes.filter(n => n.kind === "operation").length);
    assert.equal(ok.candidate.graph.connectors.length, FULL.connectors.length, "локальные связи принятого слоя сохранены"); } finally { done(); } });

test("производитель вне горизонта без настоящего раскрытия, нужный узлу горизонта, не откладывается (вердикт 1, п.2)", () => {
  const { store, done } = fresh(); try { refusal(() => pass(store, ["n-state"], (ob, base) => [put(store, "s", proposalFor(["n-state"], ob, base))]), "horizon_producer_unrefined"); } finally { done(); } });

test("принятое заполнение меняется только явной заменой с точной базой; устаревшая база и две разные замены — отказ (вердикт 1, п.7)", () => {
  const { store, done } = fresh(); try { const H = ["n-intake", "n-state"]; pass(store, []).settle(); pass(store, H, (ob, base) => [put(store, "h", proposalFor(H, ob, base))]).settle();
    const ren = { "o-intake": "o-intake-v2" }; const mk = (tag, tweak = x => x) => (ob, base, acc) => { const v = proposalFor(["n-intake"], ob, base, ren);
      // замена обязана переопределить всё принятое, что ссылалось на заменяемый узел (пути, тесты, рёбра…)
      const sw = x => JSON.parse(JSON.stringify(x).replaceAll('"o-intake"', '"o-intake-v2"')); v.redefines = [];
      for (const key of ["joins", "tests", "edges", "journeys", "packets", "transfers"]) for (const x of acc.graph.value[key] ?? []) if (JSON.stringify(x).includes('"o-intake"')) { v[key] = [...v[key].filter(y => y.id !== x.id), sw(x)]; v.redefines.push(x.id); }
      v.removes = ["o-intake"]; v.replaces = v.fills.map(f => ({ obligation: f.obligation, base: { node: "o-intake", graph: reference(acc.graph) }, with: { node: f.node, port: f.port ?? null }, basis: "исправление раскрытия n-intake" })); return [put(store, tag, tweak(v))]; };
    refusal(() => pass(store, H, (ob, base) => [put(store, "plain", proposalFor(["n-intake"], ob, base, ren))]), "slot_fill_conflict");          // без replaces
    refusal(() => pass(store, H, mk("stale", v => { v.replaces.forEach(r => r.base.graph = { ...r.base.graph, hash: "0".repeat(64) }); return v; })), "proposal_base_stale");
    refusal(() => pass(store, H, mk("dangling", v => { v.redefines = []; return v; })), "replacement_leaves_dangling");
    const r = pass(store, H, mk("good")); const ids = r.candidate.graph.nodes.map(n => n.id); assert.ok(ids.includes("o-intake-v2") && !ids.includes("o-intake")); r.settle();
    assert.equal(store.get("graph:proto", 2).value.nodes.some(n => n.id === "o-intake"), true, "прежняя ревизия сохранена в истории"); } finally { done(); } });

test("кратность: все потребители связи доезжают до нижней привязки (вердикт 1, п.6)", () => {
  const { store, done } = fresh(); try { const r = pass(store, BLOCKS, (ob, base) => [put(store, "all", proposalFor(BLOCKS, ob, base))]);
    const multi = UPPER.connectors.filter(c => c.bindings[0].consumers.length > 1); assert.ok(multi.length > 0);
    for (const c of multi) { const low = r.candidate.graph.connectors.find(x => x.id === c.id).bindings.find(b => b.level === 2); const want = FULL.connectors.find(x => x.id === c.id).bindings.find(b => b.level === 2).consumers.length;
      assert.equal(low.consumers.length, want, `${c.id}: потребителей внизу ${low.consumers.length}, в принятом слое ${want}`); } } finally { done(); } });

// ---- контрпримеры третьего вердикта Codex (~/REPORTS/review/omg-l2-m4_verdict-3.md) ----
test("принимается только граф из записи кандидата: подмена объекта после проверки ничего не даёт, несоответствие хэша — отказ (вердикт 3, п.1)", () => {
  const { store, done } = fresh(); try { const r = pass(store, []); r.candidate.graph.nodes.find(n => n.kind === "operation").title = "ПОДМЕНА после проверки"; r.settle();
    const acc = F.loadAccepted(store, P); assert.equal(acc.graph.hash ? acc.frame.value.candidateHash : null, r.rev.value.graphHash);
    assert.ok(!JSON.stringify(acc.graph.value).includes("ПОДМЕНА"), "в принятый граф попало только проверенное содержание");
    const forged = store.write({ id: "om-candidate:forged", kind: "frame-candidate", expected: 0, value: { ...r.rev.value, graphHash: "0".repeat(64) } });
    refusal(() => F.settleCandidate(store, P, reference(forged), true), "candidate_graph_mismatch");
    refusal(() => F.settleCandidate(store, P, { ...reference(r.rev), hash: "f".repeat(64) }, true), "candidate_missing"); } finally { done(); } });

test("принятие идёт по ревизиям предложений, сохранённым в кандидате; изменённое после сборки предложение не принимается (вердикт 3, п.2)", () => {
  const { store, done } = fresh(); try { pass(store, []).settle(); const H = ["n-intake", "n-state"];
    const r = pass(store, H, (ob, base) => [put(store, "p", proposalFor(H, ob, base))]); const p1 = store.get("om-proposal:p");
    store.write({ id: p1.id, kind: "layer-proposal", expected: p1.revision, value: { ...p1.value, nodes: p1.value.nodes.map(n => ({ ...n, title: n.title + " (изменено после сборки)" })) } });
    const head = F.loadAccepted(store, P).graph.hash; refusal(() => r.settle(), "input_stale");
    assert.equal(F.loadAccepted(store, P).graph.hash, head); assert.equal(store.get("om-proposal:p").value.status, "proposed", "новое содержание не помечено принятым"); } finally { done(); } });

test("отклонённое предложение повторно не подаётся; запоздавший отказ не отменяет принятого (вердикт 3, п.2)", () => {
  const { store, done } = fresh(); try { pass(store, []).settle(); const H = ["n-intake", "n-state"];
    const r = pass(store, H, (ob, base) => [put(store, "x", proposalFor(H, ob, base))]); r.settle(false); assert.equal(store.get("om-proposal:x").value.status, "rejected");
    refusal(() => pass(store, H, () => [store.get("om-proposal:x")]), "proposal_not_proposed");
    const ok = pass(store, H, (ob, base) => [put(store, "y", proposalFor(H, ob, base))]); ok.settle(); const late = ok.settle(false);
    assert.ok(late.skipped); assert.equal(store.get("om-proposal:y").value.status, "accepted", "запоздавший отказ не меняет принятое"); } finally { done(); } });

test("законная замена раскрытия с переопределением ЛОКАЛЬНОЙ связи принимается (вердикт 3, п.3)", () => {
  const { store, done } = fresh(); try { const H = ["n-intake", "n-state"]; pass(store, []).settle(); pass(store, H, (ob, base) => [put(store, "h", proposalFor(H, ob, base))]).settle();
    const OLD = "o-state-project", NEW = "o-state-project-v2"; const r = pass(store, H, (ob, base, acc) => { const v = proposalFor(["n-state"], ob, base, { [OLD]: NEW });
      const sw = x => JSON.parse(JSON.stringify(x).replaceAll(`"${OLD}"`, `"${NEW}"`)); v.nodes = v.nodes.filter(n => n.id === NEW); v.redefines = [];
      for (const key of ["joins", "tests", "edges", "journeys", "packets", "transfers"]) { v[key] = []; for (const x of acc.graph.value[key] ?? []) if (JSON.stringify(x).includes(`"${OLD}"`)) { v[key].push(sw(x)); v.redefines.push(x.id); } }
      v.localConnectors = acc.graph.value.connectors.filter(c => !c.bindings.some(b => b.level === 1) && JSON.stringify(c).includes(`"${OLD}"`)).map(sw); v.redefines.push(...v.localConnectors.map(c => c.id));
      assert.ok(v.localConnectors.length > 0, "у заменяемой операции есть локальная связь"); v.removes = [OLD];
      v.fills = v.fills.filter(f => f.node === NEW); v.replaces = v.fills.map(f => ({ obligation: f.obligation, base: { node: OLD, graph: reference(acc.graph) }, with: { node: f.node, port: f.port ?? null }, basis: "исправление раскрытия n-state" }));
      v.artifacts = []; v.contracts = []; return [put(store, "swap", v)]; });
    const ids = r.candidate.graph.nodes.map(n => n.id); assert.ok(ids.includes(NEW) && !ids.includes(OLD)); r.settle(); } finally { done(); } });

// Тесты исполняемой спецификации M7: каркас работ (frame.mjs, level = 3) + соседи задачи (works.mjs). Граф — расширенная штатная фикстура
// движка (garden-plus.mjs). Проверка — НАСТОЯЩИМИ validateGraph, composeLayer, Store, deriveTasks, controlPredecessors, nodeSignature из dist/.
// Запуск: node --test PREPARATIONS/OM-DESIGN/proto/works.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Store } from "../../../dist/src/storage/store.js"; import { reference } from "../../../dist/src/pipeline/contracts.js"; import { projectGraph } from "../../../dist/src/graph/project.js";
import { validateGraph } from "../../../dist/src/graph/validate.js"; import { deriveTasks } from "../../../dist/src/compiler/derive.js"; import { nodeSignature, receiptId } from "../../../dist/src/compiler/model.js"; import { hashJson } from "../../../dist/src/canonical.js";
import * as F from "./frame.mjs"; import * as W from "./works.mjs"; import { gardenPlus } from "./garden-plus.mjs";

const P = "proto"; const G3 = gardenPlus(); const ACC2 = (({ level, ...g }) => g)(projectGraph(G3, 2));      // принятый слой операций, работ ещё нет
const OPS = ["garden-prep-operation", "garden-produce-operation", "garden-consume-operation"]; const ZONE = new Set(OPS);
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "om-works-")); const store = new Store(join(dir, "s.sqlite")); store.write({ id: `graph:${P}`, kind: "graph", expected: 0, value: ACC2 });
  return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } }; };
const baseOf = acc => ({ graph: acc.graph ? reference(acc.graph) : null, frame: acc.frame ? reference(acc.frame) : null });
const parent = id => G3.nodes.find(n => n.id === id)?.parent;

/** Предложение слоя работ из работ фикстуры: узлы, заполнения с привязкой к коду (codeRef), тесты. */
function proposal3(ops, obligations, base, tweak = v => v) {
  const works = G3.nodes.filter(n => n.kind === "work" && ops.includes(n.parent)); const ids = new Set(works.map(w => w.id)); const fills = [];
  for (const o of obligations.filter(o => ops.includes(o.upper))) {
    if (o.kind.endsWith("-outcome")) { const w = works.find(w => w.parent === o.upper && w.outcome === o.artifact); if (w) fills.push({ obligation: o.id, node: w.id }); continue; }
    for (const b of G3.connectors.find(c => c.id === o.connector).bindings.filter(b => b.level === 3)) for (const e of (o.role === "producer" ? [b.producer] : b.consumers))
      if (ids.has(e.node) && parent(e.node) === o.upper) fills.push({ obligation: o.id, node: e.node, port: e.port, codeRef: e.codeRef }); }
  return tweak({ base, level: 3, source: "decision", status: "proposed", nodes: structuredClone(works), fills, tests: structuredClone(G3.tests.filter(t => ids.has(t.node))), localConnectors: [] });
}
/** Полный проход каркаса работ: обязательства → предложение → заполнение → кандидат → (по желанию) принятие. */
function run(store, zone, ops, { accept = false, tweak, tag = "" } = {}) {
  const acc = F.loadAccepted(store, P, 3); const upper = F.upperOf(acc.graph.value, 3); const ob = F.frameObligations(upper, zone, 3); const base = baseOf(acc);
  const props = ops.length ? [store.write({ id: `om-proposal:w-${hashJson([ops, base, tag]).slice(0, 8)}`, kind: "layer-proposal", expected: 0, value: proposal3(ops, ob, base, tweak) })] : [];
  const filled = F.fillObligations(upper, ob, acc, props, zone, base, 3); const cand = F.assembleCandidate(upper, ob, filled, acc, props, zone, 3);
  if (accept) F.settleCandidate(store, P, reference(F.saveCandidate(store, P, cand, filled, base, props, 3)), true);
  return { ob, filled, cand, identity: new Set(filled.fills.filter(f => f.source === "identity").map(f => f.node)) };
}
const receipt = (graph, node, artifact = "garden-data") => ({ projectId: P, artifact, node, signature: nodeSignature(graph, graph.nodes.find(n => n.id === node)),
  contractHash: hashJson(graph.contracts.find(c => c.id === graph.artifacts.find(a => a.id === artifact).contract).schema), commit: "c".repeat(40), tree: "t".repeat(40), value: { files: [] } });

test("F7.1: зона раскрытия работ — операции блоков горизонта, которым нужно исполнение; блок «результат уже есть» повторно не исполняется", () => {
  const h = execution => ({ nodes: ["garden-consume-block", "garden-produce-block"], execution });
  assert.deepEqual([...W.workZone(ACC2, h({ "garden-consume-block": { state: "needed" }, "garden-produce-block": { state: "needed" } }))].sort(), [...OPS].sort());
  assert.deepEqual([...W.workZone(ACC2, h({ "garden-consume-block": { state: "needed" }, "garden-produce-block": { state: "available", basis: { id: "x", revision: 1, hash: "h" } } }))], ["garden-consume-operation"]);
  assert.throws(() => W.workZone(ACC2, { nodes: ["garden-consume-block"] }), e => e.code === "horizon_execution_missing", "горизонт прежней редакции без готовности — отказ, а не пустая зона");
  assert.throws(() => W.workZone(ACC2, h({ "garden-consume-block": { state: "needed" } })), e => e.code === "horizon_execution_missing");
  assert.deepEqual([...W.workZone(ACC2, h({ "garden-consume-block": { state: "needed" }, "garden-produce-block": { state: "needed" } }), new Set(["garden-prep-operation"]))].sort(), ["garden-consume-operation", "garden-produce-operation"], "представитель операции в зону не входит"); });

test("каркас работ — тот же код, что каркас операций: каждый конец каждой связи подблоков и исход каждой операции доезжают до работ; принято настоящими валидатором и сборщиком", () => {
  const { store, done } = fresh(); try { const r = run(store, ZONE, OPS, { accept: true });
    assert.equal(r.ob.length, 10, "5 исходов операций + 5 концов двух связей"); assert.equal(r.filled.open.length, 0); assert.deepEqual(r.cand.graph.horizon, ["garden-consume-work", "garden-prep-work", "garden-produce-work"]);
    assert.equal(validateGraph(r.cand.graph).findings.length, 0); assert.deepEqual([...r.identity].sort(), ["w-garden-later-operation", "w-garden-refusal-operation"], "вне зоны — представители, они не исполняются");
    const prep = r.cand.graph.connectors.find(c => c.id === "garden-prep-flow").bindings.find(b => b.level === 3);
    assert.deepEqual([prep.producer.node, prep.consumers.map(e => e.node)], ["garden-prep-work", ["garden-produce-work"]], "связь подблок ↔ подблок внутри одного блока дошла до работ");
    const frame = store.get(`om-frame:${P}:3`); assert.equal(frame.value.level, 3); assert.equal(store.get(`om-frame:${P}:2`), null, "каркас уровня операций не тронут");
    assert.ok(frame.value.fills.some(f => f.source === "identity" && f.node === "w-garden-later-operation")); assert.equal(store.get(`graph:${P}`).value.nodes.filter(n => n.kind === "work").length, 5); } finally { done(); } });

test("сосед вне плана исполнения: действующий механизм спящей связи — отдельная привязка с якорем и тестом пробуждения; без покрывающего теста — отказ", () => {
  const { store, done } = fresh(); try { const r = run(store, ZONE, OPS); const flow = r.cand.graph.connectors.find(c => c.id === "garden-flow"); const l3 = flow.bindings.filter(b => b.level === 3);
    assert.equal(l3.length, 2); assert.deepEqual(l3.find(b => b.anchor === null).consumers.map(e => e.node), ["garden-consume-work"]);
    const sleeping = l3.find(b => b.anchor !== null); assert.deepEqual(sleeping.consumers.map(e => e.node), ["w-garden-later-operation"]); assert.equal(flow.wakeTest, "garden-produce-work-test");
    assert.deepEqual(r.cand.graph.anchors.find(a => a.id === sleeping.anchor), { id: "anchor-garden-flow", owner: "garden-produce-work", outcome: "garden-data", test: "garden-produce-work-test" });
    assert.throws(() => run(store, ZONE, OPS, { tag: "без теста связи", tweak: v => { v.tests.find(t => t.id === "garden-produce-work-test").covers = []; return v; } }), e => e.code === "sleeping_wake_test_missing"); } finally { done(); } });

test("F7.3: пакет задачи знает КАЖДОГО соседа с цепочкой работа → операция → блок, контрактом, портами, местом в коде и направлением обмена", () => {
  const { store, done } = fresh(); try { const r = run(store, ZONE, OPS); const ns = W.neighborsOf(r.cand.graph, "garden-produce-work", { identity: r.identity }); assert.equal(ns.length, 3);
    const reads = ns.find(n => n.direction === "reads"); assert.deepEqual([reads.connector, reads.artifact, reads.port, reads.delivery], ["garden-prep-flow", "garden-prep", "in", "in-plan"]);
    assert.deepEqual([reads.neighbor.work.id, reads.neighbor.operation.id, reads.neighbor.block.id, reads.neighbor.port], ["garden-prep-work", "garden-prep-operation", "garden-produce-block", "out"], "сосед — конкретный подблок своего же блока");
    assert.ok(reads.codeRef?.path && reads.neighbor.codeRef?.path, "оба конца привязаны к месту в коде"); assert.equal(reads.contract.id, "garden-contract"); assert.equal(reads.contract.hash.length, 64);
    const writes = ns.filter(n => n.direction === "writes"); const live = writes.find(n => n.delivery === "in-plan"), later = writes.find(n => n.delivery === "sleeping");
    assert.deepEqual([live.neighbor.work.id, live.neighbor.operation.id, live.neighbor.block.id], ["garden-consume-work", "garden-consume-operation", "garden-consume-block"], "сосед — конкретный подблок ДРУГОГО блока");
    assert.deepEqual([later.neighbor.work.represented, later.neighbor.operation.id, later.neighbor.block.id, later.anchor, later.wakeTest], [true, "garden-later-operation", "garden-later-block", "anchor-garden-flow", "garden-produce-work-test"],
      "сосед вне горизонта назван честно: подблок известен, работа ещё не раскрыта, обмен закреплён спящей связью"); } finally { done(); } });

test("сверка с настоящим компилятором задач: у каждого входа каждой задачи есть сосед в пакете; ворота G5 проходят; подделка, пропуск и чужой пакет — отказы", () => {
  const { store, done } = fresh(); try { const r = run(store, ZONE, OPS); const ctx = { identity: r.identity }; const packets = W.buildPackets(r.cand.graph, ctx);
    const { tasks } = deriveTasks(P, r.cand.hash, r.cand.graph, () => ({ receipt: null, source: null })); assert.equal(tasks.length, 3);
    for (const t of tasks) for (const input of t.inputs) { const n = packets.find(p => p.work === t.node).neighbors.find(n => (n.connector ?? n.control) === input.connector && ["reads", "requires", "receives"].includes(n.direction));
      assert.ok(n, `вход ${input.connector} задачи ${t.node} без соседа`); assert.equal(n.artifact ?? input.artifact, input.artifact); }
    assert.deepEqual(W.gatePackets(r.cand.graph, packets, ctx), { passed: true, codes: [], findings: [] });
    const forged = structuredClone(packets); forged[2].neighbors[0].neighbor.operation.id = "garden-forged-operation"; assert.deepEqual(W.gatePackets(r.cand.graph, forged, ctx).codes, ["packet_neighbors_forged"]);
    forged[2].hash = hashJson(forged[2].neighbors); assert.deepEqual(W.gatePackets(r.cand.graph, forged, ctx).codes, ["packet_neighbors_forged"], "пересчитанный подделкой хэш не спасает: пакет сверяется с выведенным заново");
    const dropped = structuredClone(packets); dropped[0].neighbors.pop(); dropped[0].hash = hashJson(dropped[0].neighbors); assert.deepEqual(W.gatePackets(r.cand.graph, dropped, ctx).codes, ["packet_neighbors_forged"], "пропущенный сосед виден");
    assert.deepEqual(W.gatePackets(r.cand.graph, packets.slice(1), ctx).codes, ["packet_missing"]);
    assert.deepEqual(W.gatePackets(r.cand.graph, [...packets, { work: "w-garden-later-operation", neighbors: [], hash: hashJson([]) }], ctx).codes, ["packet_foreign"]); } finally { done(); } });

test("производитель вне плана исполнения: без настоящей принятой работы — отказ (пересмотр готовности); с ней — только по годной квитанции на ЭТОГО производителя", () => {
  const { store, done } = fresh(); try { const only = new Set(["garden-consume-operation"]);
    assert.throws(() => run(store, only, ["garden-consume-operation"]), e => e.code === "horizon_producer_unrefined", "результат «уже есть», а раскрытого производителя нет — готовность пересматривается");
    run(store, ZONE, OPS, { accept: true }); const r = run(store, only, []); assert.deepEqual(r.cand.graph.horizon, ["garden-consume-work"]); const g = r.cand.graph; const ctx = { identity: r.identity };
    assert.deepEqual(W.checkDeliveries(store, P, g).findings.map(f => [f.code, f.target, f.block]), [["available_basis_missing", "garden-flow", "garden-produce-block"]]);
    assert.deepEqual(W.gatePackets(g, W.buildPackets(g, ctx), ctx).codes, ["neighbor_undelivered"], "вход без источника задачу исполнителю не пускает");
    let rec = store.write({ id: receiptId(P, "garden-data"), kind: "artifact", expected: 0, value: receipt(g, "garden-prep-work") });
    assert.deepEqual(W.checkDeliveries(store, P, g).findings.map(f => f.code), ["available_basis_mismatch"], "квитанция на другого производителя не годится");
    rec = store.write({ id: rec.id, kind: "artifact", expected: rec.revision, value: receipt(g, "garden-produce-work") }); const ok = W.checkDeliveries(store, P, g, { "garden-produce-block": reference(rec) });
    assert.deepEqual(ok.findings, []); const full = { ...ctx, receipts: ok.receipts }; const n = W.neighborsOf(g, "garden-consume-work", full).find(n => n.direction === "reads");
    assert.deepEqual([n.delivery, n.basis, n.neighbor.operation.id], ["available", reference(rec), "garden-produce-operation"], "сосед известен до подблока, данные — по квитанции"); assert.equal(W.gatePackets(g, W.buildPackets(g, full), full).passed, true);
    const ext = structuredClone(g); ext.artifacts.find(a => a.id === "garden-data").external = true; assert.equal(W.neighborsOf(ext, "garden-consume-work", ctx).find(n => n.direction === "reads").delivery, "external", "внешний источник — не недоставленный вход");
    assert.equal(W.gatePackets(ext, W.buildPackets(ext, ctx), ctx).passed, true);
    assert.deepEqual(W.checkDeliveries(store, P, g, { "garden-produce-block": { ...reference(rec), hash: "0".repeat(64) } }).findings.map(f => f.code), ["available_basis_unresolved"]);
    assert.deepEqual(W.checkDeliveries(store, P, g, { "garden-consume-block": reference(rec) }).findings.map(f => f.code), ["available_basis_foreign"], "основание названо на работу чужого блока"); } finally { done(); } });

test("маскарад и отсутствие: сломанная цепочка соседа, артефакт без контракта, пакет не для работы — типизированные отказы", () => {
  const { store, done } = fresh(); try { const g = run(store, ZONE, OPS).cand.graph; const broken = structuredClone(g); broken.nodes.find(n => n.id === "garden-consume-work").parent = "garden-consume-block";
    assert.throws(() => W.neighborsOf(broken, "garden-produce-work"), e => e.code === "neighbor_chain_broken"); assert.throws(() => W.neighborsOf(g, "garden-produce-operation"), e => e.code === "neighbor_chain_broken");
    assert.throws(() => run(store, ZONE, OPS, { tag: "маскарад", tweak: v => { v.nodes.push({ ...structuredClone(v.nodes[0]), id: "w-garden-later-operation" }); return v; } }), e => e.code === "proposal_node_reserved", "узел предложения не выдаёт себя за представителя");
    const bare = structuredClone(g); bare.artifacts = bare.artifacts.filter(a => a.id !== "garden-prep"); assert.throws(() => W.neighborsOf(bare, "garden-produce-work"), e => e.code === "neighbor_contract_missing"); } finally { done(); } });

test("передача владения путём — обязательный предшественник (настоящий controlPredecessors): у получателя receives, у отдающего sends, оба с цепочкой соседа", () => {
  const { store, done } = fresh(); try { const g = structuredClone(run(store, ZONE, OPS).cand.graph); g.transfers = [{ id: "t-shared", path: "shared.txt", from: "garden-prep-work", to: "garden-produce-work", condition: "producer_committed" }];
    const got = W.neighborsOf(g, "garden-produce-work").find(n => n.control === "t-shared"); assert.deepEqual([got.direction, got.path, got.neighbor.work.id, got.neighbor.operation.id, got.delivery], ["receives", "shared.txt", "garden-prep-work", "garden-prep-operation", "in-plan"]);
    const sent = W.neighborsOf(g, "garden-prep-work").find(n => n.control === "t-shared"); assert.deepEqual([sent.direction, sent.neighbor.work.id, sent.neighbor.block.id], ["sends", "garden-produce-work", "garden-produce-block"]); } finally { done(); } });

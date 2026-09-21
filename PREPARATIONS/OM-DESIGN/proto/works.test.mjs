// Тесты исполняемой спецификации M7: каркас работ (frame.mjs, level = 3) + соседи задачи (works.mjs). Граф — расширенная штатная фикстура
// движка (garden-plus.mjs). Проверка — НАСТОЯЩИМИ validateGraph, composeLayer, Store, deriveTasks, controlPredecessors, nodeSignature из dist/.
// Запуск: node --test PREPARATIONS/OM-DESIGN/proto/works.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Store } from "../../../dist/src/storage/store.js"; import { reference } from "../../../dist/src/pipeline/contracts.js"; import { projectGraph } from "../../../dist/src/graph/project.js";
import { validateGraph } from "../../../dist/src/graph/validate.js"; import { RefinementRelations } from "../../../dist/src/graph/relations.js"; import { deriveTasks } from "../../../dist/src/compiler/derive.js"; import { nodeSignature, receiptId } from "../../../dist/src/compiler/model.js"; import { hashJson } from "../../../dist/src/canonical.js";
import * as F from "./frame.mjs"; import * as W from "./works.mjs"; import { gardenPlus } from "./garden-plus.mjs";

const P = "proto"; const G3 = gardenPlus(); const ACC2 = (({ level, ...g }) => g)(projectGraph(G3, 2));      // принятый слой операций, работ ещё нет
const OPS = ["garden-prep-operation", "garden-produce-operation", "garden-consume-operation"]; const ZONE = new Set(OPS);
const fresh = (value = ACC2) => { const dir = mkdtempSync(join(tmpdir(), "om-works-")); const store = new Store(join(dir, "s.sqlite")); store.write({ id: `graph:${P}`, kind: "graph", expected: 0, value });
  return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } }; };
const baseOf = acc => ({ graph: acc.graph ? reference(acc.graph) : null, frame: acc.frame ? reference(acc.frame) : null }); const KIND = { 2: "operation", 3: "work" };

/** Предложение слоя из узлов фикстуры G: узлы, заполнения (конец берётся из нижней привязки ТОГО ЖЕ потока, с привязкой к коду), тесты, локальные связи. */
function proposalAt(G, level, uppers, obligations, base, upper, tweak = v => v, portMap = {}) {
  const rel = new RefinementRelations(G); const under = (id, up) => id !== up && rel.refines(id, up); const low = port => portMap[port] ?? port;      // уточнение — вложенность или realizes; нижние порты могут называться иначе
  const nodes = G.nodes.filter(n => n.kind === KIND[level] && uppers.some(u => under(n.id, u))); const ids = new Set(nodes.map(n => n.id)); const fills = [];
  for (const o of obligations.filter(o => uppers.includes(o.upper))) {
    if (o.kind.endsWith("-outcome")) { const n = nodes.find(n => under(n.id, o.upper) && n.outcome === o.artifact); if (n) fills.push({ obligation: o.id, node: n.id }); continue; }
    const U = upper.connectors.find(c => c.id === o.connector).bindings.find(b => b.level === level - 1 && F.flowKey(b) === o.flow);
    for (const b of G.connectors.find(c => c.id === o.connector).bindings.filter(b => b.level === level && b.producer.port === low(U.producer.port))) for (const e of (o.role === "producer" ? [b.producer] : b.consumers))
      if (ids.has(e.node) && under(e.node, o.upper) && (o.role === "producer" || e.port === low(o.port)) && !fills.some(f => f.obligation === o.id && f.node === e.node && f.port === e.port)) fills.push({ obligation: o.id, node: e.node, port: e.port, ...(e.codeRef ? { codeRef: e.codeRef } : {}) }); }
  const local = G.connectors.filter(c => !c.bindings.some(b => b.level < level) && c.bindings.some(b => b.level === level) && c.bindings.filter(b => b.level === level).every(b => [b.producer, ...b.consumers].every(e => ids.has(e.node))))
    .map(c => ({ ...structuredClone(c), bindings: structuredClone(c.bindings.filter(b => b.level <= level)) }));
  const artifacts = G.artifacts.filter(a => (nodes.some(n => n.outcome === a.id) || local.some(c => c.artifact === a.id)) && !upper.artifacts.some(u => u.id === a.id));
  return tweak({ base, level, source: "decision", status: "proposed", nodes: structuredClone(nodes), fills, tests: structuredClone(G.tests.filter(t => ids.has(t.node))), localConnectors: local, artifacts: structuredClone(artifacts), edges: structuredClone((G.edges ?? []).filter(e => e.relation === "realizes" && ids.has(e.source))) });
}
/** Полный проход каркаса: обязательства → предложение → заполнение → кандидат → (по желанию) принятие. */
function runAt(store, G, level, zone, uppers, { accept = false, tweak, tag = "", portMap } = {}) {
  const acc = F.loadAccepted(store, P, level); const upper = F.upperOf(acc.graph.value, level); const ob = F.frameObligations(upper, zone, level); const base = baseOf(acc);
  const props = uppers.length ? [store.write({ id: `om-proposal:w-${hashJson([level, uppers, base, tag]).slice(0, 8)}`, kind: "layer-proposal", expected: 0, value: proposalAt(G, level, uppers, ob, base, upper, tweak, portMap) })] : [];
  const filled = F.fillObligations(upper, ob, acc, props, zone, base, level); const cand = F.assembleCandidate(upper, ob, filled, acc, props, zone, level);
  if (accept) F.settleCandidate(store, P, reference(F.saveCandidate(store, P, cand, filled, base, props, level)), true);
  return { ob, filled, cand, identity: new Set(filled.fills.filter(f => f.source === "identity").map(f => f.node)) };
}
const run = (store, zone, ops, opts) => runAt(store, G3, 3, zone, ops, opts);
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

/** Принятый слой работ, в плане исполнения — только потребитель: производители (prep, produce) приняты, но исполнять их не нужно. */
function consumerOnly(store, change = g => g) { run(store, ZONE, OPS, { accept: true }); const r = run(store, new Set(["garden-consume-operation"]), []); return { g: change(structuredClone(r.cand.graph)), ctx: { identity: r.identity } }; }
const put = (store, graph, node, artifact) => { const id = receiptId(P, artifact); const head = store.get(id); return store.write({ id, kind: "artifact", expected: head?.revision ?? 0, value: receipt(graph, node, artifact) }); };

test("производитель вне плана исполнения: без настоящей принятой работы — отказ (пересмотр готовности); с ней — только по квитанции, которую M2 назвал основанием ЭТОГО результата", () => {
  const { store, done } = fresh(); try { const only = new Set(["garden-consume-operation"]);
    assert.throws(() => run(store, only, ["garden-consume-operation"]), e => e.code === "horizon_producer_unrefined", "результат «уже есть», а раскрытого производителя нет — готовность пересматривается");
    const { g, ctx } = consumerOnly(store); assert.deepEqual(g.horizon, ["garden-consume-work"]);
    assert.deepEqual(W.checkDeliveries(store, P, g).findings.map(f => [f.code, f.target, f.block, f.artifact]), [["available_basis_missing", "garden-flow", "garden-produce-block", "garden-data"]]);
    assert.deepEqual(W.gatePackets(g, W.buildPackets(g, ctx), ctx).codes, ["neighbor_undelivered"], "вход без источника задачу исполнителю не пускает");
    let rec = put(store, g, "garden-prep-work", "garden-data"); const named = r => ({ "garden-produce-block": { "garden-data": reference(r) } });
    assert.deepEqual(W.checkDeliveries(store, P, g, named(rec)).findings.map(f => f.code), ["available_basis_mismatch"], "квитанция на другого производителя не годится");
    rec = put(store, g, "garden-produce-work", "garden-data"); const ok = W.checkDeliveries(store, P, g, named(rec)); assert.deepEqual(ok.findings, []);
    const full = { ...ctx, receipts: ok.receipts }; const n = W.neighborsOf(g, "garden-consume-work", full).find(n => n.direction === "reads");
    assert.deepEqual([n.delivery, n.basis, n.neighbor.operation.id], ["available", reference(rec), "garden-produce-operation"], "сосед известен до подблока, данные — по квитанции"); assert.equal(W.gatePackets(g, W.buildPackets(g, full), full).passed, true);
    const ext = structuredClone(g); ext.artifacts.find(a => a.id === "garden-data").external = true; assert.equal(W.neighborsOf(ext, "garden-consume-work", ctx).find(n => n.direction === "reads").delivery, "external", "внешний источник — не недоставленный вход");
    assert.equal(W.gatePackets(ext, W.buildPackets(ext, ctx), ctx).passed, true);
    assert.deepEqual(W.checkDeliveries(store, P, g, { "garden-produce-block": { "garden-data": { ...reference(rec), hash: "0".repeat(64) } } }).findings.map(f => f.code), ["available_basis_unresolved"]); } finally { done(); } });

test("вердикт №1 п.3: негодное основание того же блока не заменяется другой квитанцией; сменившаяся квитанция — отказ, пока M2 не назовёт её основанием", () => {
  const { store, done } = fresh(); try { const { g } = consumerOnly(store); const data = put(store, g, "garden-produce-work", "garden-data");
    const bad = store.write({ id: receiptId(P, "garden-prep"), kind: "artifact", expected: 0, value: { ...receipt(g, "garden-prep-work", "garden-prep"), signature: "f".repeat(64), contractHash: "f".repeat(64) } });
    const f = W.checkDeliveries(store, P, g, { "garden-produce-block": { "garden-prep": reference(bad) } }).findings.map(x => [x.code, x.artifact]).sort();
    assert.deepEqual(f, [["available_basis_mismatch", "garden-prep"], ["available_basis_missing", "garden-data"]], "контрпример ревью: годная квитанция garden-data существует, но основанием не названа — и не подставляется; негодное основание отклонено");
    assert.deepEqual(W.checkDeliveries(store, P, g, { "garden-produce-block": { "garden-data": reference(data) }, "garden-consume-block": { "garden-data": reference(data) } }).findings.map(x => [x.code, x.block]), [["available_basis_foreign", "garden-consume-block"]], "основание названо на работу чужого блока");
    const newer = put(store, g, "garden-produce-work", "garden-data"); assert.ok(newer.revision > data.revision);
    assert.deepEqual(W.checkDeliveries(store, P, g, { "garden-produce-block": { "garden-data": reference(data) } }).findings.map(x => x.code), ["available_basis_stale"], "компилятор прочтёт новую квитанцию — M2 обязан назвать основанием именно её");
    assert.deepEqual(W.checkDeliveries(store, P, g, { "garden-produce-block": { "garden-data": reference(newer) } }).findings, []); } finally { done(); } });

test("вердикт №1 п.2: доставка покрывает ВСЕ виды входа — обязательный предшественник (requires) по квитанции его исхода, передача владения по основанию прежнего писателя; сверено с настоящим deriveTasks версии 2", () => {
  const { store, done } = fresh(); try { const { g, ctx } = consumerOnly(store, g => { g.edges.push({ id: "e-needs-prep", relation: "requires", source: "garden-consume-work", target: "garden-prep-work", condition: "подготовка завершена" });
      g.transfers.push({ id: "t-own", path: "consume.txt", from: "garden-prep-work", to: "garden-consume-work", condition: "producer_committed" }); return g; });
    const data = put(store, g, "garden-produce-work", "garden-data"), prep = put(store, g, "garden-prep-work", "garden-prep"); const bases = { "garden-produce-block": { "garden-data": reference(data), "garden-prep": reference(prep) } };
    const proof = { node: "garden-prep-work", boundary: g.nodes.find(n => n.id === "garden-prep-work").boundary, ref: { id: "owner:consume.txt", revision: 1, hash: "a".repeat(64) } }; const owner = path => (path === "consume.txt" ? proof : null);
    const none = W.checkDeliveries(store, P, g, { "garden-produce-block": { "garden-data": reference(data) } }); assert.deepEqual(none.findings.map(f => [f.code, f.target]).sort(), [["available_basis_missing", "e-needs-prep"], ["ownership_predecessor_missing", "t-own"]]);
    assert.deepEqual(W.checkDeliveries(store, P, g, bases, { owner: () => ({ ...proof, node: "garden-produce-work" }) }).findings.map(f => f.code), ["ownership_predecessor_missing"], "основание владения — точный прежний писатель пути, а не произвольная квитанция");
    assert.deepEqual(W.checkDeliveries(store, P, g, bases, { owner: () => ({ ...proof, boundary: { ...proof.boundary, rollback: "другая" } }) }).findings.map(f => f.code), ["ownership_predecessor_missing"], "сменившаяся граница прежнего писателя основанием не считается");
    const ok = W.checkDeliveries(store, P, g, bases, { owner }); assert.deepEqual(ok.findings, []); const full = { ...ctx, receipts: ok.receipts }; const ns = W.neighborsOf(g, "garden-consume-work", full);
    const req = ns.find(n => n.control === "e-needs-prep"), got = ns.find(n => n.control === "t-own");
    assert.deepEqual([req.direction, req.delivery, req.basis, req.artifact, req.neighbor.operation.id], ["requires", "available", reference(prep), "garden-prep", "garden-prep-operation"], "управляющий элемент пакета несёт основание");
    assert.deepEqual([got.direction, got.delivery, got.basis, got.path], ["receives", "available", proof.ref, "consume.txt"]); assert.equal(W.gatePackets(g, W.buildPackets(g, full), full).passed, true);
    const refs = { "garden-data": reference(data), "garden-prep": reference(prep) }; const { tasks } = deriveTasks(P, hashJson(g), g, (producer, artifact) => ({ receipt: refs[artifact], source: null }), { version: 2, owner });
    const task = tasks.find(t => t.node === "garden-consume-work"); for (const input of task.inputs) { const n = ns.find(n => (n.connector ?? n.control) === input.connector); assert.ok(n && n.delivery === "available", `вход ${input.connector} доставлен`); assert.deepEqual(n.basis, input.receipt, "пакет и компилятор называют одно и то же основание"); }
    const grant = task.ownership.find(o => o.transfer === "t-own"); assert.deepEqual([grant.from, grant.receipt], ["garden-prep-work", got.basis], "основание передачи владения — то же, что выдаёт writeGrants"); } finally { done(); } });

test("вердикт №1 п.4: ровно один пакет на работу — дубликат отклоняется, даже если второй пакет правильный", () => {
  const { store, done } = fresh(); try { const r = run(store, ZONE, OPS); const ctx = { identity: r.identity }; const packets = W.buildPackets(r.cand.graph, ctx); const forged = structuredClone(packets[2]);
    forged.neighbors[0].neighbor.operation.id = "garden-forged-operation"; forged.hash = hashJson(forged.neighbors);
    assert.deepEqual(W.gatePackets(r.cand.graph, [packets[0], packets[1], forged, packets[2]], ctx).codes, ["packet_duplicate"], "контрпример ревью: поддельный первым, правильный вторым");
    assert.deepEqual(W.gatePackets(r.cand.graph, [...packets, packets[0]], ctx).codes, ["packet_duplicate"]); } finally { done(); } });

test("маскарад и отсутствие: сломанная цепочка соседа, артефакт без контракта, пакет не для работы — типизированные отказы", () => {
  const { store, done } = fresh(); try { const g = run(store, ZONE, OPS).cand.graph; const broken = structuredClone(g); broken.nodes.find(n => n.id === "garden-consume-work").parent = "garden-consume-block";
    assert.throws(() => W.neighborsOf(broken, "garden-produce-work"), e => e.code === "neighbor_chain_broken"); assert.throws(() => W.neighborsOf(g, "garden-produce-operation"), e => e.code === "neighbor_chain_broken");
    assert.throws(() => run(store, ZONE, OPS, { tag: "маскарад", tweak: v => { v.nodes.push({ ...structuredClone(v.nodes[0]), id: "w-garden-later-operation" }); return v; } }), e => e.code === "proposal_node_reserved", "узел предложения не выдаёт себя за представителя");
    const bare = structuredClone(g); bare.artifacts = bare.artifacts.filter(a => a.id !== "garden-prep"); assert.throws(() => W.neighborsOf(bare, "garden-produce-work"), e => e.code === "neighbor_contract_missing"); } finally { done(); } });

test("передача владения путём — обязательный предшественник (настоящий controlPredecessors): у получателя receives, у отдающего sends, оба с цепочкой соседа", () => {
  const { store, done } = fresh(); try { const g = structuredClone(run(store, ZONE, OPS).cand.graph); g.transfers = [{ id: "t-shared", path: "shared.txt", from: "garden-prep-work", to: "garden-produce-work", condition: "producer_committed" }];
    const got = W.neighborsOf(g, "garden-produce-work").find(n => n.control === "t-shared"); assert.deepEqual([got.direction, got.path, got.neighbor.work.id, got.neighbor.operation.id, got.delivery], ["receives", "shared.txt", "garden-prep-work", "garden-prep-operation", "in-plan"]);
    const sent = W.neighborsOf(g, "garden-prep-work").find(n => n.control === "t-shared"); assert.deepEqual([sent.direction, sent.neighbor.work.id, sent.neighbor.block.id], ["sends", "garden-produce-work", "garden-produce-block"]); } finally { done(); } });

test("вердикт №1 п.1: у одной связи два потока с разными портами — различие сохраняется на ОБОИХ уровнях, и при предложении, и при повторном проходе по принятому слою; неразличимое соответствие — отказ", () => {
  const G = gardenPlus({ alt: true }); assert.equal(validateGraph(G).findings.length, 0); const strip = ({ level, ...g }) => g; const pairs = (graph, level) => graph.connectors.find(c => c.id === "garden-flow").bindings.filter(b => b.level === level)
    .map(b => `${b.producer.node}/${b.producer.port} → ${b.consumers.map(e => `${e.node}/${e.port}`).join(",")}${b.anchor ? " (спит)" : ""}`).sort();
  for (const [level, accepted, zone, want] of [
    [2, strip(projectGraph(G, 1)), ["garden-produce-block", "garden-consume-block"], ["garden-produce-operation/out → garden-consume-operation/in,i-garden-later-block/in", "garden-produce-operation/out-alt → garden-consume-operation/in-alt"]],
    [3, strip(projectGraph(G, 2)), OPS, ["garden-produce-work/out → garden-consume-work/in", "garden-produce-work/out → w-garden-later-operation/in (спит)", "garden-produce-work/out-alt → garden-consume-work/in-alt"]]]) {
    const { store, done } = fresh(accepted); try { const first = runAt(store, G, level, new Set(zone), zone, { accept: true }); assert.deepEqual(pairs(first.cand.graph, level), want, `уровень ${level}: предложение`);
      const again = runAt(store, G, level, new Set(zone), []); assert.deepEqual(pairs(again.cand.graph, level), want, `уровень ${level}: повторный проход по принятому — без потери порта и без дублей`);
      const hist = structuredClone(store.get(`graph:${P}`).value); for (const b of hist.connectors.find(c => c.id === "garden-flow").bindings.filter(b => b.level === level)) b.producer.port = "renamed";
      for (const n of hist.nodes.filter(n => n.id === (level === 2 ? "garden-produce-operation" : "garden-produce-work"))) n.ports.push({ id: "renamed", direction: "out", contract: "garden-contract" });
      const upper = F.upperOf(hist, level); const ob = F.frameObligations(upper, new Set(zone), level);
      assert.throws(() => F.fillObligations(upper, ob, { graph: { value: hist, id: "h", hash: "h" }, identity: new Set() }, [], new Set(zone), { graph: null, frame: null }, level), e => e.code === "accepted_binding_ambiguous", "первый порт не выбирается"); } finally { done(); } }
  const twice = strip(projectGraph(G, 1)); twice.connectors.find(c => c.id === "garden-flow").bindings[0].consumers.push({ node: "garden-consume-block", port: "in" });
  assert.throws(() => F.frameObligations(twice, new Set(), 2), e => e.code === "upper_binding_ambiguous"); });

test("перекрёстные потоки: один порт потребителя питают два потока, а один поток — два порта одного узла; концы различаются потоком И портом, на обоих уровнях, при предложении и повторном проходе", () => {
  const G = gardenPlus({ alt: "cross" }); assert.equal(validateGraph(G).findings.length, 0); const strip = ({ level, ...g }) => g; const pairs = (graph, level) => graph.connectors.find(c => c.id === "garden-flow").bindings.filter(b => b.level === level)
    .map(b => `${b.producer.port} → ${b.consumers.map(e => `${e.node.replace("garden-", "")}/${e.port}`).sort().join(",")}${b.anchor ? " (спит)" : ""}`).sort();
  for (const [level, accepted, zone, want] of [[2, strip(projectGraph(G, 1)), ["garden-produce-block", "garden-consume-block"], ["out → consume-operation/in,consume-operation/in-alt,i-later-block/in", "out-alt → consume-operation/in"]],
    [3, strip(projectGraph(G, 2)), OPS, ["out → consume-work/in,consume-work/in-alt", "out → w-later-operation/in (спит)", "out-alt → consume-work/in"]]]) {
    const { store, done } = fresh(accepted); try { assert.deepEqual(pairs(runAt(store, G, level, new Set(zone), zone, { accept: true }).cand.graph, level), want, `уровень ${level}: предложение`);
      const again = runAt(store, G, level, new Set(zone), []); assert.deepEqual(pairs(again.cand.graph, level), want, `уровень ${level}: повторный проход по принятому`); assert.equal(validateGraph(again.cand.graph).findings.length, 0); } finally { done(); } } });

test("вердикт №2 п.1: принятое соответствие «обязательство → конец» читается из записи каркаса — нижние порты названы иначе, повторный проход не угадывает и не отказывает; слой, изменённый в обход каркаса, — отказ", () => {
  const MAP = { out: "emit", "out-alt": "emit-alt", in: "receive", "in-alt": "receive-alt" }; const strip = ({ level, ...g }) => g;
  const renamed = level => { const G = gardenPlus({ alt: true }); for (const n of G.nodes.filter(n => n.kind === KIND[level])) for (const p of n.ports) p.id = MAP[p.id] ?? p.id;
    for (const c of G.connectors) for (const b of c.bindings.filter(b => b.level === level)) for (const e of [b.producer, ...b.consumers]) if (G.nodes.find(n => n.id === e.node).kind === KIND[level]) e.port = MAP[e.port] ?? e.port; return G; };
  const pairs = (graph, level) => graph.connectors.find(c => c.id === "garden-flow").bindings.filter(b => b.level === level).map(b => `${b.producer.port} → ${b.consumers.map(e => e.port).join(",")}${b.anchor ? " (спит)" : ""}`).sort();
  for (const [level, zone, want] of [[2, ["garden-produce-block", "garden-consume-block"], ["emit → receive,in", "emit-alt → receive-alt"]], [3, OPS, ["emit → in (спит)", "emit → receive", "emit-alt → receive-alt"]]]) {
    const G = renamed(level); assert.equal(validateGraph(G).findings.length, 0); const { store, done } = fresh(strip(projectGraph(G, level - 1)));
    try { assert.deepEqual(pairs(runAt(store, G, level, new Set(zone), zone, { accept: true, portMap: MAP }).cand.graph, level), want, `уровень ${level}: предложение со своими именами портов`);
      const again = runAt(store, G, level, new Set(zone), []); assert.deepEqual(pairs(again.cand.graph, level), want, `уровень ${level}: сценарий ревью — повторный проход без изменений проходит`); assert.equal(again.filled.open.length, 0);
      assert.ok(again.filled.fills.filter(f => f.source === "accepted").length > 0); const head = store.get(`graph:${P}`); const touched = structuredClone(head.value); touched.nodes.find(n => n.kind === KIND[level]).title += " (правка в обход каркаса)";
      store.write({ id: head.id, kind: "graph", expected: head.revision, value: touched }); assert.throws(() => runAt(store, G, level, new Set(zone), []), e => e.code === "frame_layer_drift"); } finally { done(); } } });

test("вердикт №2 п.2: работа лежит в одной операции и явно реализует роль другой (realizes) — каркас не открывает заполненное, а пакет называет соседом операцию УТОЧНЯЕМОГО конца связи", () => {
  const G = gardenPlus(); G.nodes.find(n => n.id === "garden-produce-work").parent = "garden-prep-operation"; G.edges.push({ id: "e-realizes", relation: "realizes", source: "garden-produce-work", target: "garden-produce-operation", condition: "одна атомарная работа реализует роль производства" });
  assert.equal(validateGraph(G).findings.length, 0, "граф сценария ревью допустим"); const strip = ({ level, ...g }) => g; const { store, done } = fresh(strip(projectGraph(G, 2)));
  try { const r = runAt(store, G, 3, ZONE, OPS, { accept: true }); assert.equal(r.filled.open.length, 0); assert.deepEqual(r.cand.graph.horizon, ["garden-consume-work", "garden-prep-work", "garden-produce-work"]);
    const again = runAt(store, G, 3, ZONE, []); assert.equal(again.filled.open.length, 0, "по записи каркаса: заполненные обязательства не открываются");
    assert.deepEqual(runAt(store, G, 3, new Set(["garden-produce-operation", "garden-consume-operation"]), []).cand.graph.horizon, ["garden-consume-work", "garden-produce-work"], "в план исполнения работа входит по уточняемой операции зоны, даже если лежит в операции вне зоны"); const upper = F.upperOf(G, 3); const ob = F.frameObligations(upper, ZONE, 3);
    const hist = F.fillObligations(upper, ob, { graph: { value: G, id: "h", hash: "h" }, identity: new Set() }, [], ZONE, { graph: null, frame: null }, 3); assert.equal(hist.open.length, 0, "исторический слой без записи каркаса: уточнение через realizes распознано действующим RefinementRelations");
    assert.ok(hist.fills.some(f => f.node === "garden-produce-work" && f.source === "accepted" && ob.find(o => o.id === f.obligation).upper === "garden-produce-operation"));
    const g = r.cand.graph; const ctx = { identity: r.identity, correspondence: W.correspondenceOf(r.ob, r.filled.fills) }; const reads = W.neighborsOf(g, "garden-consume-work", ctx).find(n => n.direction === "reads");
    assert.deepEqual([reads.neighbor.work.id, reads.neighbor.operation.id, reads.neighbor.block.id], ["garden-produce-work", "garden-produce-operation", "garden-produce-block"], "сценарий ревью: сосед — операция производства, а не операция, где лежит работа");
    assert.equal(W.neighborsOf(g, "garden-produce-work", ctx).find(n => n.direction === "reads").neighbor.operation.id, "garden-prep-operation"); const packets = W.buildPackets(g, ctx); assert.equal(W.gatePackets(g, packets, ctx).passed, true);
    const wrong = structuredClone(packets); const p = wrong.find(x => x.work === "garden-consume-work"); p.neighbors.find(n => n.direction === "reads").neighbor.operation.id = "garden-prep-operation"; p.hash = hashJson(p.neighbors);
    assert.deepEqual(W.gatePackets(g, wrong, ctx).codes, ["packet_neighbors_forged"], "пакет с адресом «где лежит работа» ворота больше не пропускают");
    const twin = structuredClone(g); twin.edges.push({ id: "e-twin", relation: "realizes", source: "garden-consume-work", target: "garden-later-operation", condition: "та же работа реализует и отложенного потребителя" });
    assert.throws(() => W.neighborsOf(twin, "garden-produce-work", { identity: r.identity }), e => e.code === "neighbor_chain_ambiguous", "работа уточняет два конца одной связи: без записи каркаса адрес не выбирается");
    assert.equal(W.neighborsOf(twin, "garden-produce-work", ctx).find(n => n.direction === "writes" && n.delivery === "in-plan").neighbor.operation.id, "garden-consume-operation", "с записью каркаса — принятое соответствие"); } finally { done(); } });

test("основание готовности ищется по блоку-ПРОИЗВОДИТЕЛЮ связи (как его видит горизонт M2), а не по блоку, где лежит работа", () => {
  const { store, done } = fresh(); try { const { g, ctx } = consumerOnly(store, g => { g.nodes.find(n => n.id === "garden-produce-work").parent = "garden-later-operation";
      g.edges.push({ id: "e-realizes-far", relation: "realizes", source: "garden-produce-work", target: "garden-produce-operation", condition: "работа лежит в операции другого блока" }); return g; });
    const rec = put(store, g, "garden-produce-work", "garden-data"); const ok = W.checkDeliveries(store, P, g, { "garden-produce-block": { "garden-data": reference(rec) } }); assert.deepEqual(ok.findings, []);
    const n = W.neighborsOf(g, "garden-consume-work", { ...ctx, receipts: ok.receipts }).find(n => n.direction === "reads"); assert.deepEqual([n.delivery, n.neighbor.operation.id, n.neighbor.block.id], ["available", "garden-produce-operation", "garden-produce-block"]); } finally { done(); } });

test("выданный пакет — копия: правка пакета не меняет граф, из которого ворота выводят его заново; основание ищется только в собственных полях", () => {
  const { store, done } = fresh(); try { const r = run(store, ZONE, OPS); const g = r.cand.graph; const ctx = { identity: r.identity }; const before = hashJson(g); const packets = W.buildPackets(g, ctx);
    const p = packets.find(x => x.work === "garden-consume-work"); const n = p.neighbors.find(x => x.direction === "reads"); n.codeRef.path = "чужой-файл.txt"; n.neighbor.codeRef.path = "чужой-файл.txt"; p.hash = hashJson(p.neighbors);
    assert.equal(hashJson(g), before, "граф не изменился"); assert.deepEqual(W.gatePackets(g, packets, ctx).codes, ["packet_neighbors_forged"]); } finally { done(); }
  const second = fresh(); try { const store = second.store; const only = consumerOnly(store); put(store, only.g, "garden-produce-work", "garden-data"); const proto = Object.create({ "garden-data": { id: "x", revision: 1, hash: "a".repeat(64) } });
    assert.deepEqual(W.checkDeliveries(store, P, only.g, { "garden-produce-block": proto }).findings.map(f => f.code), ["available_basis_missing"], "унаследованное поле основанием не считается"); } finally { second.done(); } });

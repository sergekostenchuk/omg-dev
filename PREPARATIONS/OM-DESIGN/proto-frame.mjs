// Прототип каркаса связей (уровень 2 · M4): проверка замысла НАСТОЯЩИМ валидатором и сборщиком из dist/. Только чтение базы.
// Использование: node proto-frame.mjs [id блоков горизонта через запятую]
import { DatabaseSync } from "node:sqlite"; import { homedir } from "node:os";
import { validateGraph } from "../../dist/src/graph/validate.js";
import { projectGraph } from "../../dist/src/graph/project.js";
import { composeLayer, layerDesignOf } from "../../dist/src/graph/layer-design.js";
const db = new DatabaseSync(homedir() + "/OMG/.omg/state.sqlite", { readOnly: true });
const get = id => JSON.parse(db.prepare(`SELECT r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id=?`).get(id).body);
const full = (g => g.nodes ? g : g.graph ?? g.projection)(get("graph:omg-live"));
const show = (name, v) => { const f = v.findings ?? v.errors ?? (v.ok === false && v.error ? [v.error] : []); console.log(`${name}: ${v.ok === false || f.length ? "ОТКАЗ" : "принят"}${f.length ? " — " + f.slice(0, 6).map(x => `${x.code}@${x.target ?? x.path ?? ""}`).join("; ") + (f.length > 6 ? ` … всего ${f.length}` : "") : ""}`); return !(v.ok === false || f.length); };

// 1. верхний слой: только блоки и привязки уровня 1
// принятый слой 1 — из его записи; служебное поле level схема графа не допускает
const L1 = (({ level, ...g }) => g)(get("graph-layer:omg-live:1").projection); show("исходный верхний слой (L1)", validateGraph(L1));
const blocks = L1.nodes.filter(n => n.kind === "block"); const horizon = new Set((process.argv[2] ?? "").split(",").filter(Boolean));

// 2. обязательства двух видов (F4.1)
const obligations = [];
for (const b of blocks) obligations.push({ kind: "block-outcome", upper: b.id, artifact: b.outcome, zone: horizon.has(b.id) ? "горизонт" : "вне" });
for (const c of L1.connectors) for (const bind of c.bindings.filter(x => x.level === 1))
  for (const [role, ep] of [["producer", bind.producer], ...bind.consumers.map(e => ["consumer", e])])
    obligations.push({ kind: "connection-end", connector: c.id, artifact: c.artifact, role, upper: ep.node, port: ep.port, zone: horizon.has(ep.node) ? "горизонт" : "вне" });
const cnt = k => obligations.filter(o => o.kind === k).length;
console.log(`обязательств: исход блока ${cnt("block-outcome")}, конец связи ${cnt("connection-end")}; в горизонте ${obligations.filter(o => o.zone === "горизонт").length}`);

// 3. заполнение: блоки горизонта — настоящими принятыми операциями; остальные — тождественным представителем, выведенным кодом из блока
const realOps = full.nodes.filter(n => n.kind === "operation"); const cand = structuredClone(L1); const idOf = b => `i-${b.replace(/^n-/, "")}`;
for (const b of blocks) { if (horizon.has(b.id)) cand.nodes.push(...structuredClone(realOps.filter(o => o.parent === b.id)));
  else cand.nodes.push({ ...structuredClone(b), id: idOf(b.id), kind: "operation", parent: b.id, title: `${b.title} (представитель блока)` }); }
const lowerEnd = (ep, role, c) => { if (!horizon.has(ep.node)) return [{ node: idOf(ep.node), port: ep.port }];
  const l2 = full.connectors.find(x => x.id === c.id).bindings.filter(x => x.level === 2);
  return l2.flatMap(x => role === "producer" ? [x.producer] : x.consumers).filter(e => realOps.find(o => o.id === e.node)?.parent === ep.node); };
for (const c of cand.connectors) { const up = c.bindings.find(x => x.level === 1);
  c.bindings.push({ level: 2, producer: lowerEnd(up.producer, "producer", c)[0], consumers: up.consumers.flatMap(e => lowerEnd(e, "consumer", c)), anchor: up.anchor ?? null }); }
// связи, живущие только с уровня 2, — только те, оба конца которых в горизонте
for (const c of full.connectors.filter(c => !c.bindings.some(b => b.level === 1))) { const b2 = c.bindings.find(b => b.level === 2);
  if ([b2.producer, ...b2.consumers].every(e => cand.nodes.some(n => n.id === e.node))) cand.connectors.push({ ...structuredClone(c), bindings: [structuredClone(b2)] }); }
// соединения входов: представитель наследует соединение своего блока 1:1; у настоящих операций горизонта — принятые соединения
for (const j of L1.joins) if (!horizon.has(j.consumer)) cand.joins.push({ ...structuredClone(j), id: `${j.id}-i`, consumer: idOf(j.consumer) });
for (const j of full.joins) if (cand.nodes.some(n => n.id === j.consumer && n.kind === "operation") && !cand.joins.some(x => x.id === j.id)) cand.joins.push(structuredClone(j));
// настоящие операции вводят свои артефакты, контракты портов, тесты, управляющие рёбра и пакеты — предложение слоя обязано нести их с собой
const bring = (key, want) => { for (const x of full[key] ?? []) if (want(x) && !cand[key].some(y => y.id === x.id)) cand[key].push(structuredClone(x)); };
const opIds = new Set(cand.nodes.filter(n => n.kind === "operation").map(n => n.id)); const has = id => cand.nodes.some(n => n.id === id);
bring("artifacts", a => cand.connectors.some(c => c.artifact === a.id) || cand.nodes.some(n => n.outcome === a.id));
bring("contracts", c => cand.nodes.some(n => n.ports.some(p => p.contract === c.id)) || cand.artifacts.some(a => a.contract === c.id));
bring("tests", t => cand.nodes.some(n => opIds.has(n.id) && n.tests.includes(t.id)));
bring("edges", e => (opIds.has(e.source) || opIds.has(e.target)) && has(e.source) && has(e.target));
bring("journeys", j => j.path.every(has) && cand.artifacts.some(a => a.id === j.outcome));
bring("packets", k => opIds.has(k.unit)); bring("transfers", t => opIds.has(t.from) || opIds.has(t.to));
const ids = cand.nodes.filter(n => n.kind === "operation"); console.log(`кандидат слоя 2: операций ${ids.length} (представителей ${ids.filter(n => n.id.startsWith("i-")).length}, настоящих ${ids.filter(n => !n.id.startsWith("i-")).length}), связей ${cand.connectors.length}`);

// 4. проверка настоящим кодом, без единой правки в нём
const okV = show("validateGraph(кандидат)", validateGraph(cand));
try { const composed = composeLayer(L1, 2, layerDesignOf(cand, 2)); show("composeLayer(L1, 2, кандидат) → validateGraph", validateGraph(composed)); }
catch (e) { console.log("composeLayer: ОТКАЗ —", e.code ?? "", String(e.message).slice(0, 220)); }

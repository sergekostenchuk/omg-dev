// Исполняемая спецификация уровня 2 · M4 «каркас обязательств» (прототип, не продуктовый модуль).
// Проверяется НАСТОЯЩИМИ validateGraph, composeLayer и Store из dist/ — без правок в них. Источники правил: вердикты Codex
// ~/REPORTS/review/omg-l2-m4_verdict-{1,2}.md. Записи прототипа: graph:<p>, om-frame:<p>:<N> (принятый каркас),
// om-proposal:<id> (предложение слоя), om-candidate:<hash> (кандидат — отдельная неизменяемая запись, не ревизия каркаса).
import { validateGraph } from "../../../dist/src/graph/validate.js";
import { composeLayer, layerDesignOf } from "../../../dist/src/graph/layer-design.js";
import { projectGraph } from "../../../dist/src/graph/project.js";
import { hashJson } from "../../../dist/src/canonical.js";
import { reference } from "../../../dist/src/pipeline/contracts.js";

export class FrameRefusal extends Error { constructor(code, target, message) { super(`${code}: ${message}`); this.code = code; this.target = target; } }
const refuse = (code, target, message) => { throw new FrameRefusal(code, target, message); };
const plain = v => JSON.parse(JSON.stringify(v));      // хранилище принимает только конечный JSON: undefined в записи не попадает
const PARTS = ["artifacts", "contracts", "joins", "tests", "edges", "journeys", "packets", "transfers", "anchors"];
export const repId = block => `i-${block.replace(/^n-/, "")}`;
export const upperOf = graph => (({ level, ...g }) => g)(projectGraph(graph, 1));

/** F4.1. Обязательства по ВСЕМУ верхнему слою: исход каждого блока и каждый конец каждой связи, включая связи внешних артефактов. */
export function frameObligations(upper, horizon) {
  const out = []; const zone = id => horizon.has(id) ? "horizon" : "outside";
  const id = o => hashJson([o.kind, o.connector ?? null, 2, o.role ?? null, o.upper, o.port ?? null]);
  for (const b of upper.nodes.filter(n => n.kind === "block")) out.push({ kind: "block-outcome", upper: b.id, artifact: b.outcome, zone: zone(b.id) });
  for (const c of upper.connectors) for (const bind of c.bindings.filter(x => x.level === 1))
    for (const [role, ep] of [["producer", bind.producer], ...bind.consumers.map(e => ["consumer", e])])
      out.push({ kind: "connection-end", connector: c.id, artifact: c.artifact, role, upper: ep.node, port: ep.port, zone: zone(ep.node) });
  return out.map(o => ({ id: id(o), ...o })).sort((a, b) => a.id < b.id ? -1 : 1);
}

/** Узел-представитель: тождественное уточнение блока 1:1. Признак identity хранится в каркасе, а не в узле (схема узла закрыта). */
export const identityNode = block => ({ ...structuredClone(block), id: repId(block.id), kind: "operation", parent: block.id, title: `${block.title} (представитель блока)` });

/** Принятое состояние: граф и принятый каркас (с источниками заполнений). Исторический слой без каркаса — целиком настоящий. */
export function loadAccepted(store, project) {
  const graph = store.get(`graph:${project}`); const frame = store.get(`om-frame:${project}:2`);
  return { graph, frame, identity: new Set((frame?.value.fills ?? []).filter(f => f.source === "identity").map(f => f.node)) };
}

/** F4.2 + F4.3. Заполнения: принятое настоящее → предложения → представитель (только вне горизонта). Возвращает fills и незаполненное. */
export function fillObligations(upper, obligations, accepted, proposals, horizon, baseRefs) {
  const g = accepted?.graph?.value ?? null; const identity = accepted?.identity ?? new Set(); const fills = []; const open = [];
  const parentOf = new Map([...(g?.nodes ?? []), ...proposals.flatMap(p => p.value.nodes)].map(n => [n.id, n.parent]));
  for (const p of proposals) { if (p.value.status !== "proposed") continue;
    if (hashJson(p.value.base) !== hashJson(baseRefs)) refuse("proposal_base_stale", p.id, "Предложение сделано для другой базы"); }
  const removed = new Set(proposals.flatMap(p => p.value.removes ?? []));
  for (const o of obligations) {
    const proposed = proposals.flatMap(p => p.value.fills.filter(f => f.obligation === o.id).map(f => ({ ...f, proposal: p.id })));
    for (const f of proposed) if (parentOf.get(f.node) !== o.upper) refuse("slot_fill_foreign", o.id, `Узел ${f.node} не принадлежит ${o.upper}`);
    const distinct = new Set(proposed.map(f => `${f.node}:${f.port ?? ""}`));
    if (o.role !== "consumer" && distinct.size > 1) refuse("slot_fill_conflict", o.id, "Несколько разных предложений на единичное обязательство");
    // принятое: концы нижних привязок (или узел с исходом блока), чей узел — потомок upper.node, не представитель и не удалён заменой
    let acceptedFill = [];
    if (g) { const mine = n => g.nodes.find(x => x.id === n)?.parent === o.upper;
      if (o.kind === "block-outcome") acceptedFill = g.nodes.filter(n => n.kind === "operation" && n.parent === o.upper && n.outcome === o.artifact).map(n => ({ node: n.id }));
      else acceptedFill = (g.connectors.find(c => c.id === o.connector)?.bindings.filter(b => b.level === 2) ?? [])
        .flatMap(b => o.role === "producer" ? [b.producer] : b.consumers).filter(e => mine(e.node) && e.port !== undefined); }
    const before = acceptedFill.filter(f => !identity.has(f.node));                       // принятое ДО замен — по нему сверяется база замены
    const real = before.filter(f => !removed.has(f.node)); const reps = acceptedFill.filter(f => identity.has(f.node));
    const replaces = proposals.flatMap(p => (p.value.replaces ?? []).filter(r => r.obligation === o.id).map(r => ({ ...r, proposal: p.id })));
    if (new Set(replaces.map(r => hashJson(r.with))).size > 1) refuse("slot_fill_conflict", o.id, "Две разные замены одной базы");
    for (const r of replaces) if (!before.some(f => f.node === r.base.node) || r.base.graph?.hash !== accepted.graph.hash) refuse("proposal_base_stale", o.id, "Замена ссылается не на действующее принятое заполнение");
    if (before.length && proposed.length && !replaces.length) refuse("slot_fill_conflict", o.id, "Принятое заполнение меняется только явной заменой с точной базой");
    if (proposed.length) { for (const f of proposed) fills.push({ obligation: o.id, node: f.node, port: f.port, source: "proposed", basis: f.proposal }); continue; }
    if (real.length) { for (const f of real) fills.push({ obligation: o.id, node: f.node, port: f.port, source: "accepted", basis: accepted.graph.id }); continue; }
    if (o.zone === "horizon") { open.push(o); continue; }                         // представитель горизонт не закрывает
    fills.push({ obligation: o.id, node: repId(o.upper), port: o.port, source: "identity", basis: o.upper, kept: reps.length > 0 });
  }
  // производитель вне горизонта без настоящего раскрытия, нужный узлу горизонта, не откладывается
  for (const o of obligations.filter(x => x.kind === "connection-end" && x.role === "producer" && x.zone === "outside")) {
    const mine = fills.filter(f => f.obligation === o.id); const needed = obligations.some(x => x.connector === o.connector && x.role === "consumer" && x.zone === "horizon");
    if (needed && mine.every(f => f.source === "identity")) refuse("horizon_producer_unrefined", o.id, `Производитель ${o.upper} связи ${o.connector} вне горизонта и не раскрыт`); }
  for (const f of fills) if (f.source === "identity" && obligations.find(o => o.id === f.obligation).zone === "horizon") refuse("identity_in_horizon", f.obligation, "Представитель не закрывает обязательство горизонта");
  return { fills, open };
}

/** F4.4. Незаполненное в адресные пробелы: потребитель — блок, чьё раскрытие заблокировано; соседи — все прочие концы той же связи. */
export function openObligationsToGaps(obligations, open) {
  return open.map(o => ({ target: o.id, field: "fill", kind: "design-decision", consumer: o.upper, blocking: true,
    neighbors: o.connector ? obligations.filter(x => x.connector === o.connector && x.id !== o.id).map(x => ({ node: x.upper, port: x.port, role: x.role })) : [] }));
}

/** F4.5. Кандидат: принятая нижняя часть СОХРАНЯЕТСЯ целиком, затем адресные замены, предложения и представители; проверка настоящим кодом. */
export function assembleCandidate(upper, obligations, filled, accepted, proposals, horizon) {
  if (filled.open.length) refuse("obligation_open", filled.open[0].id, "Есть незаполненные обязательства горизонта — сначала пробелы и предложения");
  const cand = structuredClone(accepted?.graph?.value ?? upper); const identity = accepted?.identity ?? new Set();
  const drop = new Set(proposals.flatMap(p => p.value.removes ?? []));
  for (const b of upper.nodes.filter(n => n.kind === "block")) if (horizon.has(b.id) && identity.has(repId(b.id))) drop.add(repId(b.id));   // блок вошёл в горизонт — представитель уходит
  cand.nodes = cand.nodes.filter(n => !drop.has(n.id)); cand.joins = cand.joins.filter(j => !drop.has(j.consumer));
  for (const p of proposals) { for (const n of p.value.nodes) if (!cand.nodes.some(x => x.id === n.id)) cand.nodes.push(structuredClone(n));
    // зависимое определение принятой части меняется только ЯВНО: его id назван в redefines предложения
    for (const key of PARTS) for (const x of p.value[key] ?? []) { const at = cand[key].findIndex(y => y.id === x.id);
      if (at < 0) cand[key].push(structuredClone(x)); else if ((p.value.redefines ?? []).includes(x.id)) cand[key][at] = structuredClone(x); }
    for (const c of p.value.localConnectors ?? []) if (!cand.connectors.some(y => y.id === c.id)) cand.connectors.push(structuredClone(c)); }
  const need = new Set(filled.fills.filter(f => f.source === "identity").map(f => f.node));
  for (const b of upper.nodes.filter(n => n.kind === "block")) if (need.has(repId(b.id)) && !cand.nodes.some(n => n.id === repId(b.id))) {
    cand.nodes.push(identityNode(b)); for (const j of upper.joins.filter(j => j.consumer === b.id)) cand.joins.push({ ...structuredClone(j), id: `${j.id}-i`, consumer: repId(b.id) }); }
  for (const c of cand.connectors) { const up = c.bindings.find(b => b.level === 1); if (!up) continue;
    const of = (role, node, port) => filled.fills.filter(f => { const o = obligations.find(x => x.id === f.obligation); return o.connector === c.id && o.role === role && o.upper === node && o.port === port; }).map(f => ({ node: f.node, port: f.port }));
    const lower = { level: 2, producer: of("producer", up.producer.node, up.producer.port)[0], consumers: up.consumers.flatMap(e => of("consumer", e.node, e.port)), anchor: up.anchor ?? null };
    c.bindings = [...c.bindings.filter(b => b.level !== 2), lower]; }
  // замена не оставляет висящих ссылок: всё принятое, что ссылалось на убранный узел, обязано быть переопределено предложением
  const dangling = []; for (const key of [...PARTS, "connectors"]) for (const x of cand[key]) { const t = JSON.stringify(x).split('"'); for (const id of drop) if (t.includes(id)) dangling.push(`${key}:${x.id}→${id}`); }
  if (dangling.length) refuse("replacement_leaves_dangling", dangling[0], `Принятые определения ссылаются на убранный узел: ${dangling.join(", ")}`);
  const live = new Set(cand.nodes.map(n => n.id));
  cand.connectors = cand.connectors.filter(c => c.bindings.every(b => [b.producer, ...b.consumers].every(e => e && live.has(e.node))) || c.bindings.some(b => b.level === 1));
  for (const n of cand.nodes.filter(x => x.kind === "operation")) for (const port of n.ports.filter(p => p.direction === "in"))
    if (!cand.connectors.some(c => c.bindings.some(b => b.level === 2 && b.consumers.some(e => e.node === n.id && e.port === port.id)))) refuse("operation_port_unbound", n.id, `Входной порт ${port.id} не привязан связью`);
  const v = validateGraph(cand); if (v.findings.length) refuse("graph_invalid", v.findings[0].target, v.findings.map(f => `${f.code}@${f.target}`).join("; "));
  try { composeLayer(upper, 2, layerDesignOf(cand, 2)); } catch (e) { refuse(e.code ?? "layer_invalid", "", String(e.message)); }
  return { graph: cand, hash: hashJson(cand) };
}

/** Кандидат — отдельная неизменяемая запись со ссылками на базу и предложения; каркас при этом ревизию НЕ меняет. */
export function saveCandidate(store, project, candidate, filled, base, proposals) {
  // имя кандидата — от графа, базы и предложений: одинаковый граф на другой базе — другой кандидат
  return store.write({ id: `om-candidate:${hashJson([candidate.hash, base, proposals.map(p => reference(p))])}`, kind: "frame-candidate", expected: 0,
    value: plain({ project, level: 2, graphHash: candidate.hash, fills: filled.fills, base, proposals: proposals.map(p => reference(p)) }) });
}

/** F4.6. Исход проверки. Проход — один writeMany с охраной на актуальные граф, каркас и предложения; отказ принятого не меняет. */
export function settleCandidate(store, project, candidate, candidateRev, passed, codes = []) {
  const proposals = candidateRev.value.proposals.map(r => store.get(r.id)); const verdict = { candidateHash: candidate.hash, candidate: reference(candidateRev), codes };
  const mark = status => proposals.map(p => ({ id: p.id, kind: "layer-proposal", expected: p.revision, value: plain({ ...p.value, status, verdict }) }));
  if (!passed) return store.writeMany(mark("rejected"), [reference(candidateRev)]);
  const graph = store.get(`graph:${project}`); const frame = store.get(`om-frame:${project}:2`);
  const guards = [reference(candidateRev), ...(graph ? [reference(graph)] : []), ...(frame ? [reference(frame)] : []), ...proposals.map(p => reference(p))];
  const stale = (now, was) => (now ? hashJson(reference(now)) : null) !== (was ? hashJson(was) : null);
  if (stale(graph, candidateRev.value.base.graph) || stale(frame, candidateRev.value.base.frame)) refuse("input_stale", candidate.hash, "База кандидата уже сменилась: принят другой кандидат");
  return store.writeMany([{ id: `graph:${project}`, kind: "graph", expected: graph?.revision ?? 0, value: candidate.graph },
    { id: `om-frame:${project}:2`, kind: "connection-frame", expected: frame?.revision ?? 0, value: plain({ project, level: 2, candidateHash: candidate.hash,
      fills: candidateRev.value.fills.map(f => ({ ...f, source: f.source === "proposed" ? "accepted" : f.source })) }) }, ...mark("accepted")], guards);
}

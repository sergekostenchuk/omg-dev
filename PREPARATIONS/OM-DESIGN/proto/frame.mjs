// Исполняемая спецификация уровня 2 · M4 и M7 «каркас обязательств» (прототип, не продуктовый модуль). ОДИН код для двух уровней:
// level = 2 — блоки раскрываются операциями (M4), level = 3 — операции раскрываются работами (M7). По умолчанию level = 2.
// Проверяется НАСТОЯЩИМИ validateGraph, composeLayer и Store из dist/ — без правок в них. Источники правил: вердикты Codex
// ~/REPORTS/review/omg-l2-m4_verdict-{1,2}.md. Записи прототипа: graph:<p>, om-frame:<p>:<N> (принятый каркас),
// om-proposal:<id> (предложение слоя), om-candidate:<hash> (кандидат — отдельная неизменяемая запись, не ревизия каркаса).
import { validateGraph } from "../../../dist/src/graph/validate.js";
import { composeLayer, layerDesignOf } from "../../../dist/src/graph/layer-design.js";
import { projectGraph } from "../../../dist/src/graph/project.js";
import { hashJson } from "../../../dist/src/canonical.js";
import { reference } from "../../../dist/src/pipeline/contracts.js";
import { RefinementRelations } from "../../../dist/src/graph/relations.js";

export class FrameRefusal extends Error { constructor(code, target, message) { super(`${code}: ${message}`); this.code = code; this.target = target; } }
const refuse = (code, target, message) => { throw new FrameRefusal(code, target, message); };
const plain = v => JSON.parse(JSON.stringify(v));      // хранилище принимает только конечный JSON: undefined в записи не попадает
const PARTS = ["artifacts", "contracts", "joins", "tests", "edges", "journeys", "packets", "transfers", "anchors"];
const KIND = { 1: "block", 2: "operation", 3: "work" };
export const repId = (id, level = 2) => level === 2 ? `i-${id.replace(/^n-/, "")}` : `w-${id}`;
export const upperOf = (graph, level = 2) => (({ level: _l, ...g }) => g)(projectGraph(graph, level - 1));

/** F4.1. Обязательства по ВСЕМУ верхнему слою: исход каждого блока и каждый конец каждой связи, включая связи внешних артефактов. */
/** Поток связи — верхняя привязка, различимая концом-производителем (узел И порт) и якорем. У одной связи потоков может быть несколько
 *  (out → in и out-alt → in-alt): каждый конец принадлежит СВОЕМУ потоку, нижние привязки зеркалят верхние по одной (вердикт №1 по M7, п.1). */
export const flowKey = b => hashJson([b.producer.node, b.producer.port, b.anchor ?? null]);
export function frameObligations(upper, horizon, level = 2) {
  const out = new Map(); const zone = id => horizon.has(id) ? "horizon" : "outside";
  const id = o => hashJson([o.kind, o.connector ?? null, level, o.role ?? null, o.upper, o.port ?? null, o.flow ?? null]);
  const put = o => { const k = id(o); if (!out.has(k)) { out.set(k, { id: k, ...o }); return; }        // производитель общий для привязок одного потока; потребитель дважды в одном потоке неразличим
    if (o.role === "consumer") refuse("upper_binding_ambiguous", o.connector, `Конец ${o.upper}/${o.port} дважды входит в один поток связи ${o.connector}`); };
  for (const b of upper.nodes.filter(n => n.kind === KIND[level - 1])) put({ kind: `${KIND[level - 1]}-outcome`, upper: b.id, artifact: b.outcome, zone: zone(b.id) });
  for (const c of upper.connectors) for (const bind of c.bindings.filter(x => x.level === level - 1))
    for (const [role, ep] of [["producer", bind.producer], ...bind.consumers.map(e => ["consumer", e])])
      put({ kind: "connection-end", connector: c.id, artifact: c.artifact, role, upper: ep.node, port: ep.port, flow: flowKey(bind), zone: zone(ep.node) });
  return [...out.values()].sort((a, b) => a.id < b.id ? -1 : 1);
}

/** ЭВРИСТИКА для слоя БЕЗ записи каркаса (исторический слой). Там, где соответствие «обязательство → конец» принято и записано, оно читается из
 *  записи (fillObligations) и не угадывается заново (вердикт №2 по M7, п.1).
 *  Принятые концы нижних привязок, относящиеся к обязательству. Нижняя привязка относится к верхнему потоку по узлам (правило уточнения
 *  валидатора); подходят несколько РАЗНЫХ потоков — по совпадению id портов; не различить — отказ: первый порт не выбирается. */
function acceptedEnds(connector, flows, o, level, under) {
  const out = []; const ambiguous = () => refuse("accepted_binding_ambiguous", o.connector, `Принятую привязку связи ${o.connector} нельзя однозначно отнести к верхнему потоку: нужны разные id портов или запись каркаса`);
  for (const L of connector?.bindings.filter(b => b.level === level) ?? []) {
    let mine = flows.filter(U => under(L.producer.node, U.producer.node) && L.consumers.every(e => U.consumers.some(u => under(e.node, u.node))));
    if (new Set(mine.map(flowKey)).size > 1) { mine = mine.filter(U => U.producer.port === L.producer.port && L.consumers.every(e => U.consumers.some(u => under(e.node, u.node) && u.port === e.port))); if (new Set(mine.map(flowKey)).size !== 1) ambiguous(); }
    mine = mine.filter(U => flowKey(U) === o.flow); if (!mine.length) continue;
    if (o.role === "producer") { out.push(L.producer); continue; }
    const ends = mine.flatMap(U => U.consumers).filter(u => u.node === o.upper); const ports = new Set(ends.map(u => u.port));
    for (const e of L.consumers.filter(e => under(e.node, o.upper))) { if (ports.size > 1 && !ports.has(e.port)) ambiguous(); if (ports.size <= 1 || e.port === o.port) out.push(e); } }
  return out.filter(e => e.port !== undefined).filter((e, i, all) => all.findIndex(x => x.node === e.node && x.port === e.port) === i);
}

/** Узел-представитель: тождественное уточнение блока 1:1. Признак identity хранится в каркасе, а не в узле (схема узла закрыта). */
export const identityNode = (block, level = 2) => ({ ...structuredClone(block), id: repId(block.id, level), kind: KIND[level], parent: block.id, title: `${block.title} (представитель ${level === 2 ? "блока" : "операции"})` });

/** СВОЯ часть слоя: то, что есть в проекции уровня, но отсутствует в проекции уровня выше, — узлы уровня, привязки уровня, зависимые определения. */
export function lowerPart(graph, level) { const P = projectGraph(graph, level), U = projectGraph(graph, level - 1); const seen = key => new Set((U[key] ?? []).map(x => hashJson(x)));
  const own = key => { const u = seen(key); return (P[key] ?? []).filter(x => !u.has(hashJson(x))); };
  return { nodes: P.nodes.filter(n => n.kind === KIND[level]), bindings: P.connectors.map(c => ({ id: c.id, wakeTest: c.wakeTest ?? null, bindings: c.bindings.filter(b => b.level === level) })).filter(c => c.bindings.length),
    ...Object.fromEntries(["anchors", "joins", "tests", "edges", "transfers", "packets"].map(k => [k, own(k)])), horizon: P.horizon ?? [] }; }

/** Принятое состояние: граф и принятый каркас (с источниками заполнений). Исторический слой без каркаса — целиком настоящий. */
export function loadAccepted(store, project, level = 2) {
  const graph = store.get(`graph:${project}`); const frame = store.get(`om-frame:${project}:${level}`);
  // записанное соответствие «обязательство → конец» относится к слою, принятому вместе с ним: сверка по хэшу проекции слоя (как LayerProof движка).
  // Слой изменился: если СВОЯ часть слоя та же, а верхний слой — ровно тот, что принят каркасом уровня выше, это законная смена базы (нужен явный
  // переход rebaseFrame); всё остальное — правка в обход каркаса (вердикт №3 по M7, п.3). Проверка посторонних изменений не ослабляется.
  let drift = false, rebase = false;
  if (frame && graph && frame.value.layerHash !== hashJson(projectGraph(graph.value, level))) { const upperFrame = level > 2 ? store.get(`om-frame:${project}:${level - 1}`) : null;
    rebase = Boolean(upperFrame) && upperFrame.value.layerHash === hashJson(projectGraph(graph.value, level - 1)) && frame.value.lowerHash === hashJson(lowerPart(graph.value, level)); drift = !rebase; }
  return { graph, frame, drift, rebase, recorded: frame && !drift && !rebase ? frame.value.fills : null, identity: new Set((frame?.value.fills ?? []).filter(f => f.source === "identity").map(f => f.node)) };
}

/** F4.2 + F4.3. Заполнения: принятое настоящее → предложения → представитель (только вне горизонта). Возвращает fills и незаполненное. */
export function fillObligations(upper, obligations, accepted, proposals, horizon, baseRefs, level = 2) {
  const g = accepted?.graph?.value ?? null; const identity = accepted?.identity ?? new Set(); const fills = []; const open = [];
  if (accepted?.rebase) refuse("frame_rebase_required", accepted.frame.id, "Верхний слой законно изменён и принят: сначала явный переход каркаса на новую базу (rebaseFrame), потом новые обязательства");
  if (accepted?.drift) refuse("frame_layer_drift", accepted.frame.id, "Принятый слой изменён в обход каркаса: записанное соответствие обязательств к нему не относится");
  // принадлежность узла верхнему — действующая семантика уточнения движка: вложенность И явное realizes (вердикт №2 по M7, п.2), а не один parent
  const rel = new RefinementRelations({ version: 2, nodes: [...(g?.nodes ?? upper.nodes), ...proposals.flatMap(p => p.value.nodes)], edges: [...(g?.edges ?? upper.edges ?? []), ...proposals.flatMap(p => p.value.edges ?? [])] });
  const under = (id, up) => id !== up && rel.refines(id, up);
  for (const p of proposals) { if (p.value.status !== "proposed") refuse("proposal_not_proposed", p.id, `Предложение со статусом ${p.value.status} повторно не подаётся: нужно новое предложение`);
    if (hashJson(p.value.base) !== hashJson(baseRefs)) refuse("proposal_base_stale", p.id, "Предложение сделано для другой базы"); }
  // МАСКАРАД: имена представителей зарезервированы — узел предложения не может выдать себя за представителя (и наоборот)
  const reserved = new Set(upper.nodes.map(n => repId(n.id, level))); for (const p of proposals) for (const n of p.value.nodes) if (reserved.has(n.id)) refuse("proposal_node_reserved", n.id, "Имя узла занято представителем: предложение обязано назвать узел иначе");
  const removed = new Set(proposals.flatMap(p => p.value.removes ?? []));
  for (const o of obligations) {
    const proposed = proposals.flatMap(p => p.value.fills.filter(f => f.obligation === o.id).map(f => ({ ...f, proposal: p.id })));
    for (const f of proposed) if (!under(f.node, o.upper)) refuse("slot_fill_foreign", o.id, `Узел ${f.node} не уточняет ${o.upper}`);
    const distinct = new Set(proposed.map(f => `${f.node}:${f.port ?? ""}`));
    if (o.role !== "consumer" && distinct.size > 1) refuse("slot_fill_conflict", o.id, "Несколько разных предложений на единичное обязательство");
    // принятое: концы нижних привязок (или узел с исходом блока), чей узел — потомок upper.node, не представитель и не удалён заменой
    const recorded = accepted?.recorded?.filter(f => f.obligation === o.id) ?? []; let acceptedFill = [];
    if (recorded.length) acceptedFill = recorded.map(f => plain({ node: f.node, port: f.port, codeRef: f.codeRef }));              // принятое соответствие — из записи каркаса, без угадывания
    else if (g) { if (o.kind.endsWith("-outcome")) acceptedFill = g.nodes.filter(n => n.kind === KIND[level] && under(n.id, o.upper) && n.outcome === o.artifact).map(n => ({ node: n.id }));
      else acceptedFill = acceptedEnds(g.connectors.find(c => c.id === o.connector), upper.connectors.find(c => c.id === o.connector)?.bindings.filter(b => b.level === level - 1) ?? [], o, level, under); }
    const before = acceptedFill.filter(f => !identity.has(f.node));                       // принятое ДО замен — по нему сверяется база замены
    const real = before.filter(f => !removed.has(f.node)); const reps = acceptedFill.filter(f => identity.has(f.node));
    const replaces = proposals.flatMap(p => (p.value.replaces ?? []).filter(r => r.obligation === o.id).map(r => ({ ...r, proposal: p.id })));
    if (new Set(replaces.map(r => hashJson(r.with))).size > 1) refuse("slot_fill_conflict", o.id, "Две разные замены одной базы");
    for (const r of replaces) if (!before.some(f => f.node === r.base.node) || r.base.graph?.hash !== accepted.graph.hash) refuse("proposal_base_stale", o.id, "Замена ссылается не на действующее принятое заполнение");
    if (before.length && proposed.length && !replaces.length) refuse("slot_fill_conflict", o.id, "Принятое заполнение меняется только явной заменой с точной базой");
    if (proposed.length) { for (const f of proposed) fills.push({ obligation: o.id, node: f.node, port: f.port, codeRef: f.codeRef, source: "proposed", basis: f.proposal }); continue; }
    if (real.length) { for (const f of real) fills.push({ obligation: o.id, node: f.node, port: f.port, codeRef: f.codeRef, source: "accepted", basis: accepted.graph.id }); continue; }
    if (o.zone === "horizon") { open.push(o); continue; }                         // представитель горизонт не закрывает
    fills.push({ obligation: o.id, node: repId(o.upper, level), port: o.port, source: "identity", basis: o.upper, kept: reps.length > 0 });
  }
  // производитель вне горизонта без настоящего раскрытия, нужный узлу горизонта, не откладывается
  const externalArtifacts = new Set(upper.artifacts.filter(a => a.external).map(a => a.id));      // внешний источник: адрес связи сохраняется представителем, реализация производителя не требуется
  for (const o of obligations.filter(x => x.kind === "connection-end" && x.role === "producer" && x.zone === "outside" && !externalArtifacts.has(x.artifact))) {
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
export function assembleCandidate(upper, obligations, filled, accepted, proposals, horizon, level = 2) {
  if (filled.open.length) refuse("obligation_open", filled.open[0].id, "Есть незаполненные обязательства горизонта — сначала пробелы и предложения");
  const cand = structuredClone(accepted?.graph?.value ?? upper); const identity = accepted?.identity ?? new Set();
  const drop = new Set(proposals.flatMap(p => p.value.removes ?? []));
  for (const b of upper.nodes.filter(n => n.kind === KIND[level - 1])) if (horizon.has(b.id) && identity.has(repId(b.id, level))) drop.add(repId(b.id, level));   // блок вошёл в горизонт — представитель уходит
  cand.nodes = cand.nodes.filter(n => !drop.has(n.id)); cand.joins = cand.joins.filter(j => !drop.has(j.consumer));
  for (const p of proposals) { for (const n of p.value.nodes) if (!cand.nodes.some(x => x.id === n.id)) cand.nodes.push(structuredClone(n));
    // зависимое определение принятой части меняется только ЯВНО: его id назван в redefines предложения
    for (const key of PARTS) for (const x of p.value[key] ?? []) { const at = cand[key].findIndex(y => y.id === x.id);
      if (at < 0) cand[key].push(structuredClone(x)); else if ((p.value.redefines ?? []).includes(x.id)) cand[key][at] = structuredClone(x); }
    for (const c of p.value.localConnectors ?? []) { const at = cand.connectors.findIndex(y => y.id === c.id);
      if (at < 0) cand.connectors.push(structuredClone(c)); else if ((p.value.redefines ?? []).includes(c.id)) cand.connectors[at] = structuredClone(c); } }
  const need = new Set(filled.fills.filter(f => f.source === "identity").map(f => f.node));
  for (const b of upper.nodes.filter(n => n.kind === KIND[level - 1])) if (need.has(repId(b.id, level)) && !cand.nodes.some(n => n.id === repId(b.id, level))) {
    cand.nodes.push(identityNode(b, level)); if (level === 2) for (const j of upper.joins.filter(j => j.consumer === b.id)) cand.joins.push({ ...structuredClone(j), id: `${j.id}-i`, consumer: repId(b.id) }); }
  // представитель несёт только те порты, концы которых закрывает САМ: если часть концов верхнего узла закрыта настоящим узлом (например, работой,
  // реализующей две операции), лишний порт представителя остался бы непривязанным
  for (const b of upper.nodes.filter(n => n.kind === KIND[level - 1])) { const rep = cand.nodes.find(n => n.id === repId(b.id, level)); if (!rep || !need.has(rep.id)) continue;
    const used = new Set(filled.fills.filter(f => f.source === "identity" && f.node === rep.id && f.port !== undefined).map(f => f.port)); rep.ports = structuredClone(b.ports.filter(p => used.has(p.id))); }
  // уровень 3: план исполнения — настоящие работы операций горизонта; представитель не исполняется никогда
  const relC = new RefinementRelations(cand); const exec = new Set(level === 3 ? cand.nodes.filter(n => n.kind === "work" && !need.has(n.id) && [...horizon].some(op => relC.refines(n.id, op))).map(n => n.id) : []); if (level === 3) cand.horizon = [...exec].sort();
  const obById = new Map(obligations.map(o => [o.id, o]));
  for (const c of cand.connectors) { const ups = c.bindings.filter(b => b.level === level - 1); if (!ups.length) continue; const lower = [];
    const of = (role, node, port, flow) => filled.fills.filter(f => { const o = obById.get(f.obligation); return o.connector === c.id && o.role === role && o.upper === node && o.port === port && o.flow === flow; }).map(f => plain({ node: f.node, port: f.port, codeRef: f.codeRef }));
    for (const U of ups) { const fk = flowKey(U); const producer = of("producer", U.producer.node, U.producer.port, fk)[0]; const consumers = U.consumers.flatMap(e => of("consumer", e.node, e.port, fk)).filter((e, i, all) => all.findIndex(x => x.node === e.node && x.port === e.port) === i);      // один конец может законно закрывать два обязательства потока (работа уточняет две операции): в привязке он один
      // уровень 3, действующий механизм «спящей связи»: производитель в плане исполнения, потребитель — нет → отдельная привязка с якорем и тестом пробуждения
      if (level === 3 && U.anchor == null && producer && exec.has(producer.node) && consumers.some(e => !exec.has(e.node))) {
        const test = cand.tests.find(t => t.node === producer.node && t.covers.includes(c.id)); if (!test) refuse("sleeping_wake_test_missing", c.id, `У производителя ${producer.node} нет теста, покрывающего связь: спящий потребитель останется без проверки пробуждения`);
        let anchor = cand.anchors.find(a => a.outcome === c.artifact);
        if (!anchor) { const owner = cand.nodes.find(n => n.id === producer.node && n.outcome === c.artifact) ?? cand.nodes.find(n => n.outcome === c.artifact && n.kind === "work"); if (!owner) refuse("sleeping_anchor_underivable", c.id, `Нет работы с исходом ${c.artifact}: якорь спящей связи механически не выводится`);
          anchor = { id: `anchor-${c.id}`, owner: owner.id, outcome: c.artifact, test: test.id }; cand.anchors.push(anchor); }
        c.wakeTest = c.wakeTest ?? test.id; const awake = consumers.filter(e => exec.has(e.node));
        lower.push(...(awake.length ? [{ level, producer, consumers: awake, anchor: null }] : []), { level, producer, consumers: consumers.filter(e => !exec.has(e.node)), anchor: anchor.id }); }
      else lower.push({ level, producer, consumers, anchor: U.anchor ?? null }); }
    c.bindings = [...c.bindings.filter(b => b.level !== level), ...lower]; }
  // замена не оставляет висящих ссылок: всё принятое, что ссылалось на убранный узел, обязано быть переопределено предложением
  const dangling = []; for (const key of [...PARTS, "connectors"]) for (const x of cand[key]) { const t = JSON.stringify(x).split('"'); for (const id of drop) if (t.includes(id)) dangling.push(`${key}:${x.id}→${id}`); }
  if (dangling.length) refuse("replacement_leaves_dangling", dangling[0], `Принятые определения ссылаются на убранный узел: ${dangling.join(", ")}`);
  const live = new Set(cand.nodes.map(n => n.id));
  cand.connectors = cand.connectors.filter(c => c.bindings.every(b => [b.producer, ...b.consumers].every(e => e && live.has(e.node))) || c.bindings.some(b => b.level < level));
  for (const n of cand.nodes.filter(x => x.kind === KIND[level])) for (const port of n.ports.filter(p => p.direction === "in"))
    if (!cand.connectors.some(c => c.bindings.some(b => b.level === level && b.consumers.some(e => e.node === n.id && e.port === port.id)))) refuse(`${KIND[level]}_port_unbound`, n.id, `Входной порт ${port.id} не привязан связью`);
  const v = validateGraph(cand); if (v.findings.length) refuse("graph_invalid", v.findings[0].target, v.findings.map(f => `${f.code}@${f.target}`).join("; "));
  try { composeLayer(upper, level, layerDesignOf(cand, level)); } catch (e) { refuse(e.code ?? "layer_invalid", "", String(e.message)); }
  return { graph: cand, hash: hashJson(cand) };
}

/** Кандидат — отдельная неизменяемая запись со ссылками на базу и предложения; каркас при этом ревизию НЕ меняет. */
export function saveCandidate(store, project, candidate, filled, base, proposals, level = 2) {
  // имя кандидата — от графа, базы и предложений: одинаковый граф на другой базе — другой кандидат
  return store.write({ id: `om-candidate:${hashJson([candidate.hash, base, proposals.map(p => reference(p))])}`, kind: "frame-candidate", expected: 0,
    value: plain({ project, level, graphHash: candidate.hash, layerHash: hashJson(projectGraph(candidate.graph, level)), upperHash: hashJson(projectGraph(candidate.graph, level - 1)), lowerHash: hashJson(lowerPart(candidate.graph, level)), graph: candidate.graph, fills: filled.fills, base, proposals: proposals.map(p => reference(p)) }) });
}

/** F4.6. Исход проверки G3 для ТОЧНОЙ записи кандидата. Цепочка: граф из записи → его хэш → запись кандидата → исход G3.
 *  Предложения сверяются и охраняются по ссылкам, сохранённым в кандидате, а не по текущим головам. */
export function settleCandidate(store, project, candidateRef, passed, codes = []) {
  const rec = store.get(candidateRef.id, candidateRef.revision);
  if (!rec || rec.hash !== candidateRef.hash || rec.kind !== "frame-candidate") refuse("candidate_missing", candidateRef.id, "Исход G3 выдан не на эту запись кандидата");
  if (hashJson(rec.value.graph) !== rec.value.graphHash) refuse("candidate_graph_mismatch", rec.id, "Граф в записи не соответствует проверенному хэшу");
  const saved = rec.value.proposals; const heads = saved.map(r => store.get(r.id));
  const exact = heads.every((h, i) => h && h.revision === saved[i].revision && h.hash === saved[i].hash && h.value.status === "proposed");
  const verdict = { candidateHash: rec.value.graphHash, candidate: reference(rec), codes };
  const mark = status => heads.map((p, i) => ({ id: p.id, kind: "layer-proposal", expected: saved[i].revision, value: plain({ ...p.value, status, verdict }) }));
  if (!passed) { if (!exact) return { skipped: "предложения уже в другой ревизии или статусе — запоздавший отказ ничего не меняет" };
    return store.writeMany(mark("rejected"), [reference(rec), ...saved]); }
  // проход: отдельной сверки предложений нет намеренно — их защищают охранные ссылки и expected по ревизиям, СОХРАНЁННЫМ в кандидате:
  // изменённое после сборки предложение даёт input_stale от самого хранилища, и ни одна запись транзакции не применяется
  const level = rec.value.level; const graph = store.get(`graph:${project}`); const frame = store.get(`om-frame:${project}:${level}`);
  const stale = (now, was) => (now ? hashJson(reference(now)) : null) !== (was ? hashJson(was) : null);
  if (stale(graph, rec.value.base.graph) || stale(frame, rec.value.base.frame)) refuse("input_stale", rec.id, "База кандидата уже сменилась: принят другой кандидат");
  const guards = [reference(rec), ...(graph ? [reference(graph)] : []), ...(frame ? [reference(frame)] : []), ...saved];
  return store.writeMany([{ id: `graph:${project}`, kind: "graph", expected: graph?.revision ?? 0, value: rec.value.graph },
    { id: `om-frame:${project}:${level}`, kind: "connection-frame", expected: frame?.revision ?? 0, value: plain({ project, level, candidateHash: rec.value.graphHash, layerHash: rec.value.layerHash, upperHash: rec.value.upperHash, lowerHash: rec.value.lowerHash,
      fills: rec.value.fills.map(f => ({ ...f, source: f.source === "proposed" ? "accepted" : f.source })) }) }, ...mark("accepted")], guards);
}

/** Явный переход каркаса на новую принятую базу (вердикт №3 по M7, п.3). Условия — те же, что в loadAccepted: своя часть слоя не менялась, верхний слой
 *  принят каркасом уровня выше. Заполнения, чьё обязательство сохранилось в новом верхнем слое (тот же id = тот же конец того же потока), ПЕРЕНОСЯТСЯ;
 *  остальные уходят в retired и остаются в записи. История — ревизии записи каркаса и ссылка rebasedFrom. Новые обязательства заполнений не имеют:
 *  после перехода они обрабатываются обычным порядком (предложение, представитель, пробел). Одна транзакция с охраной графа и каркаса. */
export function rebaseFrame(store, project, level = 3) {
  const acc = loadAccepted(store, project, level); if (!acc.frame || !acc.graph) refuse("frame_missing", `om-frame:${project}:${level}`, "Переносить нечего: каркас уровня не принят");
  if (acc.drift) refuse("frame_layer_drift", acc.frame.id, "Принятый слой изменён в обход каркаса: переход на новую базу не выполняется"); if (!acc.rebase) return { skipped: "каркас уже на действующей базе" };
  const g = acc.graph.value; const ids = new Set(frameObligations(upperOf(g, level), new Set(), level).map(o => o.id)); const fills = acc.frame.value.fills;
  const carried = fills.filter(f => ids.has(f.obligation)), retired = fills.filter(f => !ids.has(f.obligation));
  store.writeMany([{ id: acc.frame.id, kind: "connection-frame", expected: acc.frame.revision, value: plain({ ...acc.frame.value, layerHash: hashJson(projectGraph(g, level)), upperHash: hashJson(projectGraph(g, level - 1)),
    fills: carried, retired: [...(acc.frame.value.retired ?? []), ...retired], rebasedFrom: reference(acc.frame) }) }], [reference(acc.graph), reference(acc.frame)]);
  return { carried: carried.length, retired: retired.length };
}

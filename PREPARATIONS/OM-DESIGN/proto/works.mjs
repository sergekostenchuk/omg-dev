// Исполняемая спецификация уровня 2 · M7 «работы и соседи» (прототип, не продуктовый модуль).
// Каркас работ — ТОТ ЖЕ код, что каркас операций: frame.mjs с level = 3. Здесь — только то, чего у каркаса нет:
//   F7.1 зона раскрытия работ из принятого горизонта M2; F7.3 соседи задачи с цепочкой работа → операция → блок;
//   F7.4 сверка квитанций производителей вне плана исполнения (формула — src/compiler/inputs.ts:34–35); G5 ворота пакетов.
// Цель владельца: не рождается код, не знающий соседа, с которым обменивается данными (читает, пишет, передаёт).
import { hashJson, canonical } from "../../../dist/src/canonical.js";
import { controlPredecessors } from "../../../dist/src/graph/dependencies.js";
import { nodeSignature, receiptId } from "../../../dist/src/compiler/model.js";
import { reference } from "../../../dist/src/pipeline/contracts.js";
import { RefinementRelations } from "../../../dist/src/graph/relations.js";

export class WorkRefusal extends Error { constructor(code, target, message) { super(`${code}: ${message}`); this.code = code; this.target = target; } }
const refuse = (code, target, message) => { throw new WorkRefusal(code, target, message); };

/** F7.1. Зона раскрытия работ: операции блоков горизонта, которым НУЖНО исполнение. Блок «результат уже есть» (execution available)
 *  в зону не входит: повторного исполнения не выводим; его производители обязаны быть настоящими принятыми работами с годной квитанцией. */
export function workZone(graph, horizon, identityOps = new Set()) {
  // ОТСУТСТВИЕ: горизонт без сведений о готовности блока (запись прежней редакции) — отказ, а не молча пустая зона
  for (const b of horizon.nodes) if (!["needed", "available"].includes(horizon.execution?.[b]?.state)) refuse("horizon_execution_missing", b, `В горизонте нет готовности блока ${b}: зона работ не выводится`);
  const need = new Set(horizon.nodes.filter(b => horizon.execution[b]?.state === "needed"));
  return new Set(graph.nodes.filter(n => n.kind === "operation" && need.has(n.parent) && !identityOps.has(n.id)).map(n => n.id));
}

/** Принятое соответствие конца связи уровня работ своей операции — из записи каркаса работ: ключ «связь|роль|работа|порт» → операция. */
export const correspondenceOf = (obligations, fills) => { const by = new Map(obligations.map(o => [o.id, o])); return new Map(fills.filter(f => by.get(f.obligation)?.connector).map(f => { const o = by.get(f.obligation); return [`${o.connector}|${o.role}|${f.node}|${f.port}`, o.upper]; })); };

/** Цепочка соседа: работа → операция → блок. Сломанная цепочка — отказ: сосед без адреса подблока владельцу не годится.
 *  Адрес операции — НЕ «где лежит работа», а тот конец верхней связи, который работа уточняет (вложенность или явное realizes — действующий
 *  RefinementRelations; вердикт №2 по M7, п.2): работа может лежать в одной операции и реализовывать роль другой. via = { c, role, end, rel, correspondence }. */
function chainOf(N, id, identity, via = null) {
  const pick = (level, node, fallback) => { if (!via) return fallback; const ends = [...new Set(via.c.bindings.filter(b => b.level === level).flatMap(b => via.role === "producer" ? [b.producer] : b.consumers).filter(u => via.rel.refines(node, u.node)).map(u => u.node))];
    if (ends.length <= 1) return ends[0] ?? fallback; const known = level === 2 ? via.correspondence?.get(`${via.c.id}|${via.role}|${via.end.node}|${via.end.port}`) : null;
    if (!ends.includes(known)) refuse("neighbor_chain_ambiguous", id, `Конец связи ${via.c.id} уточняет несколько верхних концов (${ends.join(", ")}): адрес подблока неоднозначен, нужна запись каркаса`); return known; };
  const w = N.get(id), o = N.get(pick(2, id, w?.parent)), b = N.get(o ? pick(1, o.id, o.parent) : undefined);
  if (w?.kind !== "work" || o?.kind !== "operation" || b?.kind !== "block") refuse("neighbor_chain_broken", id, `У соседа ${id} нет цепочки работа → операция → блок`);
  const part = n => ({ id: n.id, title: n.title, outcome: n.outcome, ...(identity.has(n.id) ? { represented: true } : {}) });
  return { work: part(w), operation: part(o), block: part(b) };
}

/** F7.3. Соседи работы: каждый конец каждой связи уровня работ, передачи владения и управляющие предшественники.
 *  direction — с точки зрения самой работы: reads (читаю то, что пишет сосед), writes (пишу то, что читает сосед), sends/receives (передача
 *  права записи пути), requires (обязательный предшественник). delivery — откуда возьмутся данные: in-plan | available | sleeping | undelivered. */
export function neighborsOf(graph, workId, { identity = new Set(), receipts = new Map(), correspondence = null } = {}) {
  const N = new Map(graph.nodes.map(n => [n.id, n])); const me = N.get(workId); if (me?.kind !== "work") refuse("neighbor_chain_broken", workId, "Пакет соседей строится только для работы");
  const exec = new Set(graph.horizon); const out = []; const rel = new RefinementRelations(graph);
  const contractOf = artifact => { const a = graph.artifacts.find(x => x.id === artifact); const c = graph.contracts.find(x => x.id === a?.contract);
    if (!a || !c) refuse("neighbor_contract_missing", artifact, `У артефакта ${artifact} нет контракта: обмен с соседом не определён`); return { id: c.id, hash: hashJson(c.schema), external: a.external }; };
  for (const c of graph.connectors) for (const b of c.bindings.filter(x => x.level === 3)) {
    const pairs = [...(b.consumers.some(e => e.node === workId) && b.producer.node !== workId ? b.consumers.filter(e => e.node === workId).map(mine => ["reads", mine, b.producer]) : []),
      ...(b.producer.node === workId ? b.consumers.filter(e => e.node !== workId).map(other => ["writes", b.producer, other]) : [])];
    for (const [direction, mine, other] of pairs) {
      const delivery = b.anchor !== null ? "sleeping" : exec.has(other.node) ? "in-plan" : direction === "reads" && contractOf(c.artifact).external ? "external"        // внешний источник: сверку источника делает компилятор (external_input_missing)
        : direction === "reads" && receipts.has(`${c.id}:${other.node}`) ? "available" : "undelivered";
      out.push({ connector: c.id, artifact: c.artifact, contract: contractOf(c.artifact), direction, port: mine.port, codeRef: mine.codeRef ?? null,
        neighbor: { ...chainOf(N, other.node, identity, { c, role: direction === "reads" ? "producer" : "consumer", end: other, rel, correspondence }), port: other.port, codeRef: other.codeRef ?? null }, returnsTo: c.returnsTo, delivery,
        ...(delivery === "sleeping" ? { anchor: b.anchor, wakeTest: c.wakeTest } : {}), ...(delivery === "available" ? { basis: receipts.get(`${c.id}:${other.node}`) } : {}) }); } }
  const transfers = graph.transfers ?? [];
  for (const p of controlPredecessors(graph, workId)) { const t = transfers.find(x => x.id === p.id);
    const key = `${p.id}:${p.producer}`; const delivery = exec.has(p.producer) ? "in-plan" : receipts.has(key) ? "available" : "undelivered";
    out.push({ control: p.id, direction: t ? "receives" : "requires", ...(t ? { path: t.path, condition: t.condition } : { artifact: N.get(p.producer)?.outcome }), neighbor: chainOf(N, p.producer, identity), delivery, ...(delivery === "available" ? { basis: receipts.get(key) } : {}) }); }
  for (const t of transfers.filter(x => x.from === workId)) out.push({ control: t.id, direction: "sends", path: t.path, condition: t.condition, neighbor: chainOf(N, t.to, identity), delivery: exec.has(t.to) ? "in-plan" : "sleeping" });
  // записи пакета — КОПИИ: правка выданного пакета не меняет граф, из которого ворота выводят его заново (тот же класс, что вердикт №2 по M5, п.1)
  return structuredClone(out.sort((a, b) => (hashJson(a) < hashJson(b) ? -1 : 1)));
}

/** F7.4. Вход работы плана от производителя вне плана. Одно правило для ВСЕХ видов входа (вердикт №1 по M7, пп. 2 и 3):
 *  · вход по артефакту (связь данных и обязательный предшественник requires — его исход): квитанция — ТА САМАЯ, которую M2 назвал основанием
 *    готовности блока для этого артефакта (bases: блок → {артефакт: ссылка}); другая квитанция основание не подменяет. Сверка — формула
 *    компилятора (inputs.ts:34–35): проект, артефакт, node = работа-производитель, её подпись, хэш контракта. Текущая квитанция артефакта
 *    обязана быть той же записью: компилятор прочтёт именно её. Подлинность коммита, дерева, плана и прогона — стык с M8.
 *  · передача владения путём: основание — подтверждённый прежний писатель пути (семантика writeGrants: тот же узел и та же граница),
 *    а не квитанция артефакта. owner(path) → { node, boundary, ref } | null — действующий поставщик владельцев путей.
 *  · каждое названное M2 основание проверяется, даже если вход по нему сейчас не берётся: негодное основание молча в горизонте не остаётся. */
export function checkDeliveries(store, project, graph, bases = {}, { owner = () => null } = {}) {
  const N = new Map(graph.nodes.map(n => [n.id, n])); const exec = new Set(graph.horizon); const findings = []; const receipts = new Map(); const checked = new Set();
  const blockOf = id => N.get(N.get(N.get(id)?.parent)?.parent)?.id; const schemaOf = artifact => graph.contracts.find(x => x.id === graph.artifacts.find(a => a.id === artifact)?.contract)?.schema;
  const fits = (rec, artifact, producer) => rec.kind === "artifact" && rec.value.projectId === project && rec.value.artifact === artifact && rec.value.node === producer.id
    && rec.value.signature === nodeSignature(graph, producer) && rec.value.contractHash === hashJson(schemaOf(artifact));
  const deliver = (key, artifact, producerId, target, flowBlock = null) => { const producer = N.get(producerId); const block = flowBlock ?? blockOf(producerId); /* блок — производитель связи на уровне блоков, а не «где лежит работа» */ const named = Object.hasOwn(bases, String(block)) && bases[block] && Object.hasOwn(bases[block], artifact) ? bases[block][artifact] : undefined; const at = { target, producer: producerId, block, artifact }; checked.add(`${block}:${artifact}`);
    if (!named) return findings.push({ code: "available_basis_missing", ...at }); const rec = store.get(named.id, named.revision);
    if (!rec || rec.hash !== named.hash) return findings.push({ code: "available_basis_unresolved", ...at }); const head = store.get(receiptId(project, artifact));
    if (rec.id !== receiptId(project, artifact) || head?.revision !== rec.revision || head?.hash !== rec.hash) return findings.push({ code: "available_basis_stale", ...at });
    if (!fits(rec, artifact, producer)) return findings.push({ code: "available_basis_mismatch", ...at }); receipts.set(key, reference(rec)); };
  for (const c of graph.connectors) { if (graph.artifacts.find(a => a.id === c.artifact)?.external) continue;
    for (const b of c.bindings.filter(x => x.level === 3 && x.anchor === null)) if (!exec.has(b.producer.node) && b.consumers.some(e => exec.has(e.node)) && !receipts.has(`${c.id}:${b.producer.node}`)) deliver(`${c.id}:${b.producer.node}`, c.artifact, b.producer.node, c.id, c.bindings.find(x => x.level === 1)?.producer.node); }
  const transfers = graph.transfers ?? [];
  for (const work of exec) for (const p of controlPredecessors(graph, work)) { if (exec.has(p.producer)) continue; const t = transfers.find(x => x.id === p.id);
    if (!t) { deliver(`${p.id}:${p.producer}`, N.get(p.producer).outcome, p.producer, p.id); continue; }
    const proof = owner(t.path); const from = N.get(t.from);
    if (proof?.node === t.from && proof.ref?.id && canonical(proof.boundary) === canonical(from.boundary)) receipts.set(`${t.id}:${t.from}`, proof.ref);
    else findings.push({ code: "ownership_predecessor_missing", target: t.id, producer: t.from, block: blockOf(t.from), path: t.path }); }
  for (const [block, arts] of Object.entries(bases)) for (const [artifact, named] of Object.entries(arts ?? {})) { if (checked.has(`${block}:${artifact}`)) continue; const rec = named?.id ? store.get(named.id, named.revision) : null; const at = { target: `${block}:${artifact}`, block, artifact };
    if (!rec || rec.hash !== named.hash) { findings.push({ code: "available_basis_unresolved", ...at }); continue; } const producer = N.get(rec.value?.node);
    if (!producer || blockOf(producer.id) !== block) findings.push({ code: "available_basis_foreign", ...at }); else if (!fits(rec, artifact, producer)) findings.push({ code: "available_basis_mismatch", ...at, producer: producer.id }); }
  return { receipts, findings };
}

/** Пакеты соседей всех работ плана исполнения. Пакет ВЫВОДИТСЯ из принятого графа, модель его не присылает. */
export function buildPackets(graph, ctx = {}) { return [...graph.horizon].sort().map(work => { const neighbors = neighborsOf(graph, work, ctx); return { work, neighbors, hash: hashJson(neighbors) }; }); }

/** G5. Ворота пакетов: у каждой работы плана есть пакет; пакет равен выведенному заново (подделка и пропуск соседа видны по хэшу);
 *  ни один нужный вход не остаётся без источника. Любой код — типизированный отказ, задача исполнителю не выдаётся. */
export function gatePackets(graph, packets, ctx = {}) {
  const exec = new Set(graph.horizon); const findings = []; const seen = new Set();
  // ровно один пакет на работу: дубликат отклоняется ДО выбора пакета — иначе проверен один вариант, а потребитель возьмёт другой (вердикт №1 по M7, п.4)
  for (const p of packets) { if (seen.has(p.work)) findings.push({ code: "packet_duplicate", target: p.work }); seen.add(p.work); if (!exec.has(p.work)) findings.push({ code: "packet_foreign", target: p.work }); }
  const by = new Map(packets.map(p => [p.work, p]));
  for (const work of exec) { const p = by.get(work); if (!p) { findings.push({ code: "packet_missing", target: work }); continue; }
    const fresh = neighborsOf(graph, work, ctx); if (p.hash !== hashJson(fresh) || hashJson(p.neighbors) !== p.hash) findings.push({ code: "packet_neighbors_forged", target: work });
    for (const n of fresh) if (n.delivery === "undelivered") findings.push({ code: "neighbor_undelivered", target: work, via: n.connector ?? n.control }); }
  const codes = [...new Set(findings.map(f => f.code))].sort(); return { passed: codes.length === 0, codes, findings };
}

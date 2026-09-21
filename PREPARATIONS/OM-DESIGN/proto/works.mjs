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
  // операция относится к блоку, если УТОЧНЯЕТ его — вложенностью или явным realizes (вердикт №3 по M7, п.2), а не только лежит в нём; представитель в зону не входит
  const rel = new RefinementRelations(graph); return new Set(graph.nodes.filter(n => n.kind === "operation" && !identityOps.has(n.id) && [...need].some(b => rel.refines(n.id, b))).map(n => n.id));
}

/** Принятое соответствие конца связи своим верхним узлам — из записи каркаса, С КРАТНОСТЬЮ: одна работа может законно уточнять несколько операций
 *  (вердикт №3 по M7, п.1). Ключ «связь|роль|узел|порт» → отсортированный список верхних узлов; для каркаса операций (op → блоки) — то же. */
export const correspondenceOf = (obligations, fills) => { const by = new Map(obligations.map(o => [o.id, o])); const out = new Map();
  for (const f of fills) { const o = by.get(f.obligation); if (!o?.connector) continue; const k = `${o.connector}|${o.role}|${f.node}|${f.port}`; out.set(k, [...new Set([...(out.get(k) ?? []), o.upper])].sort()); } return out; };

/** Цепочки соседа: работа → операция → блок. Сломанная цепочка — отказ: сосед без адреса подблока владельцу не годится.
 *  Адрес операции — НЕ «где лежит работа», а тот конец верхней связи, который работа уточняет (вложенность или явное realizes — действующий
 *  RefinementRelations). Уточняемых концов может быть НЕСКОЛЬКО — тогда адресов столько, сколько принято и записано в каркасе; порядком записей
 *  неоднозначность не разрешается: без записи каркаса — отказ. via = { c, role, end, rel, correspondence, upperCorrespondence }. */
function chainsOf(N, id, identity, via = null) {
  const part = n => ({ id: n.id, title: n.title, outcome: n.outcome, ...(identity.has(n.id) ? { represented: true } : {}) }); const broken = () => refuse("neighbor_chain_broken", id, `У соседа ${id} нет цепочки работа → операция → блок`);
  const ends = (level, node) => via ? [...new Set(via.c.bindings.filter(b => b.level === level).flatMap(b => via.role === "producer" ? [b.producer] : b.consumers).filter(u => via.rel.refines(node, u.node)).map(u => u.node))].sort() : [];
  const settle = (found, known, fallback, what) => { if (found.length <= 1) return found.length ? found : [fallback]; if (!known?.length || known.some(k => !found.includes(k)))
      refuse("neighbor_chain_ambiguous", id, `${what} связи ${via.c.id} уточняет несколько верхних концов (${found.join(", ")}): нужна запись каркаса, порядком записей адрес не выбирается`); return known; };
  const w = N.get(id); if (w?.kind !== "work") broken(); const chains = [];
  for (const opId of settle(ends(2, id), via?.correspondence?.get(`${via.c.id}|${via.role}|${via.end.node}|${via.end.port}`), w.parent, "Работа")) { const o = N.get(opId); if (o?.kind !== "operation") broken();
    const upperKnown = [...(via?.upperCorrespondence ?? [])].filter(([k]) => k.startsWith(`${via.c.id}|${via.role}|${opId}|`)).flatMap(([, v]) => v);
    for (const blockId of settle(ends(1, opId), [...new Set(upperKnown)].sort(), o.parent, "Операция")) { const b = N.get(blockId); if (b?.kind !== "block") broken(); chains.push({ work: part(w), operation: part(o), block: part(b) }); } }
  return chains;
}

/** F7.3. Соседи работы: каждый конец каждой связи уровня работ, передачи владения и управляющие предшественники.
 *  direction — с точки зрения самой работы: reads (читаю то, что пишет сосед), writes (пишу то, что читает сосед), sends/receives (передача
 *  права записи пути), requires (обязательный предшественник). delivery — откуда возьмутся данные: in-plan | available | sleeping | undelivered. */
export function neighborsOf(graph, workId, { identity = new Set(), receipts = new Map(), correspondence = null, upperCorrespondence = null } = {}) {
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
      // сосед, уточняющий несколько верхних концов, даёт по записи на КАЖДЫЙ адрес: кратность доезжает до пакета
      for (const chain of chainsOf(N, other.node, identity, { c, role: direction === "reads" ? "producer" : "consumer", end: other, rel, correspondence, upperCorrespondence })) out.push({ connector: c.id, artifact: c.artifact, contract: contractOf(c.artifact), direction, port: mine.port, codeRef: mine.codeRef ?? null,
        neighbor: { ...chain, port: other.port, codeRef: other.codeRef ?? null }, returnsTo: c.returnsTo, delivery,
        ...(delivery === "sleeping" ? { anchor: b.anchor, wakeTest: c.wakeTest } : {}), ...(delivery === "available" ? { basis: receipts.get(`${c.id}:${other.node}`) } : {}) }); } }
  const transfers = graph.transfers ?? [];
  for (const p of controlPredecessors(graph, workId)) { const t = transfers.find(x => x.id === p.id);
    const key = `${p.id}:${p.producer}`; const delivery = exec.has(p.producer) ? "in-plan" : receipts.has(key) ? "available" : "undelivered";
    out.push({ control: p.id, direction: t ? "receives" : "requires", ...(t ? { path: t.path, condition: t.condition } : { artifact: N.get(p.producer)?.outcome }), neighbor: chainsOf(N, p.producer, identity)[0], delivery, ...(delivery === "available" ? { basis: receipts.get(key) } : {}) }); }
  for (const t of transfers.filter(x => x.from === workId)) out.push({ control: t.id, direction: "sends", path: t.path, condition: t.condition, neighbor: chainsOf(N, t.to, identity)[0], delivery: exec.has(t.to) ? "in-plan" : "sleeping" });
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
  // основание результата ищется ОДИНАКОВО для всех видов входа (вердикт №3 по M7, п.4): среди блоков, которые работа-производитель уточняет (вложенность или realizes),
  // берётся тот, у которого M2 назвал основание ЭТОГО артефакта; структурное расположение работы поиска не определяет
  const rel = new RefinementRelations(graph); const own = (o, k) => Boolean(o) && Object.hasOwn(o, String(k)); const blocksOf = id => graph.nodes.filter(n => n.kind === "block" && rel.refines(id, n.id)).map(n => n.id).sort();
  const deliver = (key, artifact, producerId, target) => { const producer = N.get(producerId); const naming = blocksOf(producerId).filter(b => own(bases, b) && own(bases[b], artifact));
    const block = naming[0] ?? blocksOf(producerId).find(b => N.get(b).outcome === artifact || graph.connectors.some(c => c.artifact === artifact && c.bindings.some(x => x.level === 1 && x.producer.node === b))) ?? blockOf(producerId);
    for (const b of naming) checked.add(`${b}:${artifact}`);
    if (new Set(naming.map(b => hashJson(bases[b][artifact]))).size > 1) return findings.push({ code: "available_basis_ambiguous", target, producer: producerId, block, artifact }); const named = naming.length ? bases[naming[0]][artifact] : undefined; const at = { target, producer: producerId, block, artifact }; checked.add(`${block}:${artifact}`);
    if (!named) return findings.push({ code: "available_basis_missing", ...at }); const rec = store.get(named.id, named.revision);
    if (!rec || rec.hash !== named.hash) return findings.push({ code: "available_basis_unresolved", ...at }); const head = store.get(receiptId(project, artifact));
    if (rec.id !== receiptId(project, artifact) || head?.revision !== rec.revision || head?.hash !== rec.hash) return findings.push({ code: "available_basis_stale", ...at });
    if (!fits(rec, artifact, producer)) return findings.push({ code: "available_basis_mismatch", ...at }); receipts.set(key, reference(rec)); };
  for (const c of graph.connectors) { if (graph.artifacts.find(a => a.id === c.artifact)?.external) continue;
    for (const b of c.bindings.filter(x => x.level === 3 && x.anchor === null)) if (!exec.has(b.producer.node) && b.consumers.some(e => exec.has(e.node)) && !receipts.has(`${c.id}:${b.producer.node}`)) deliver(`${c.id}:${b.producer.node}`, c.artifact, b.producer.node, c.id); }
  const transfers = graph.transfers ?? [];
  for (const work of exec) for (const p of controlPredecessors(graph, work)) { if (exec.has(p.producer)) continue; const t = transfers.find(x => x.id === p.id);
    if (!t) { deliver(`${p.id}:${p.producer}`, N.get(p.producer).outcome, p.producer, p.id); continue; }
    const proof = owner(t.path); const from = N.get(t.from);
    if (proof?.node === t.from && proof.ref?.id && canonical(proof.boundary) === canonical(from.boundary)) receipts.set(`${t.id}:${t.from}`, proof.ref);
    else findings.push({ code: "ownership_predecessor_missing", target: t.id, producer: t.from, block: blockOf(t.from), path: t.path }); }
  for (const [block, arts] of Object.entries(bases)) for (const [artifact, named] of Object.entries(arts ?? {})) { if (checked.has(`${block}:${artifact}`)) continue; const rec = named?.id ? store.get(named.id, named.revision) : null; const at = { target: `${block}:${artifact}`, block, artifact };
    if (!rec || rec.hash !== named.hash) { findings.push({ code: "available_basis_unresolved", ...at }); continue; } const producer = N.get(rec.value?.node);
    if (!producer || !rel.refines(producer.id, block)) findings.push({ code: "available_basis_foreign", ...at }); else if (!fits(rec, artifact, producer)) findings.push({ code: "available_basis_mismatch", ...at, producer: producer.id }); }
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

// Уровень 2 схемы: раскрытие M4 до записей и функций — «каркас связей». Идемпотентен. Основание: измерение measure-frame.mjs
// и отчёты ~/REPORTS/omg-level2/A-graph-model.md, B-stage-outputs.md (21.09.2026).
import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id);
const G = "Уровень 2 · M4 · Каркас связей операций"; const X = 5880; let y = -80;
const add = (id, type, fields) => { if (by(id)) return; const size = [W, heightOf(type, fields)]; s.nodes.push({ id, type, fields, pos: [X, y], size, group: G }); y += size[1] + 110; };
const edge = (from, to, kind) => { if (!s.edges.some(e => e.from === from && e.to === to && e.kind === kind)) s.edges.push({ from, to, kind }); };

// ---- посылка M4 исправлена по данным ----
const m4 = by("mech-l2").fields;
m4["что делает"] = "Каркас связей. Для блоков горизонта код строит гнёзда — по одному на каждый конец каждой связи уровня блоков («в этом блоке нужен конкретный производитель / потребитель этого артефакта») — и заполняет их по порядку: из принятого нижнего слоя, из структурированных привязок входа (после M1), из принятых проектных решений. Пустое гнездо — адресный пробел вида design-decision в M5, потребитель пробела — сосед на другом конце связи; догадок нет. Так ни одна связь блоков не спускается вниз, пока оба её конца не привязаны к конкретным подблокам.\nОперация — не контракт поведения. Измерено на omg-live r2 (21.09.2026): 20 контрактов дают всего 6 исходов и проходят через несколько блоков; все 60 их входов — проза; с операциями они связаны только через общие требования, и у 28 операций из 29 таких контрактов несколько. Поэтому контракт даёт операции поведенческое содержание (успех, отказы, запреты, состояние), а не определяет её. На тех же данных: 24 связи блоков → 79 гнёзд, все 79 заполнены принятым слоем 2 (measure-frame.mjs). Прежняя оценка «0 из 20» относилась к выводу операций из контрактов — этот путь снят.\nЧастичное уточнение по горизонту требует изменения composeLayer/deriveLayer: сейчас они требуют весь слой и исследованный layerDesign с оценённым ответом. Нужен контракт частичного уточнения с сохранением верхнего слоя и происхождением результата кода.\nПереиспользуется копированием: Connector/Binding/Endpoint (model.ts), composeLayer, projectGraph, validateGraph, layerProofs, правило layer_connector_uncovered — оно становится генератором гнёзд, а не только проверкой. Раскрытие — группа «Уровень 2 · M4».";
by("mech-l2").size = [W, heightOf("mechanism", m4)];
const g3 = by("gate-l2").fields;
if (!g3["коды отказа"].includes("slot_fill_conflict")) g3["коды отказа"] += " Каркас (уровень 2 · M4): slot_fill_conflict; slot_fill_foreign; frame_upper_drift. Пустое гнездо — не отказ, а пробел в M5.";
by("gate-l2").size = [W, heightOf("gate", g3)];

// ---- уровень 2: запись и функции ----
add("st-frame", "store", { "запись": "connection-frame (каркас связей уровня N)",
  "что хранит": "{ project, level N (2 или 3), horizonHash, upperLayerHash, slots[], counts{all, filled, open, sleeping} }. Гнездо: { id, connector, artifact, portContract (ct-*), role: producer | consumer, upper{node, port} — конец связи уровня N−1, state: open | filled | sleeping, fill?{node, port} — конкретный узел уровня N, потомок upper.node, source?: accepted | input | decision, basis?{id, revision, hash} }. Гнездо sleeping — потребитель вне горизонта и ещё не раскрыт: привязка получает якорь и wake-тест по действующему правилу спящих связей, конец остаётся на верхнем уровне до входа соседа в горизонт. Запись неизменяема, как все записи: новое заполнение — новая ревизия с тем же набором id гнёзд. Id гнезда = хэш(connector, level, role, upper.node, upper.port) — не зависит от порядка, дат и позиций. Потребители: F4.4 (open), F4.5 (filled), M5, M7 (тот же каркас уровнем ниже), пакет контекста задачи (сосед с цепочкой работа → операция → блок)." });
add("f4-slots", "mechanism", { "название": "F4.1 · frameSlots — построить гнёзда",
  "цель": "Требование «у каждой связи внизу есть конкретные концы» выражено данными до вывода слоя, а не проверкой после.",
  "что делает": "frameSlots(graph, horizon, level) → slots[]. Для каждого коннектора и каждой его привязки уровня N−1, у которой хотя бы один конец — узел горизонта или его предок/потомок: по гнезду на каждый конец. Конец в горизонте → state open. Конец вне горизонта: сосед уже раскрыт принятым слоем → open (заполнится в F4.2); сосед не раскрыт → sleeping. Внешний артефакт (artifact.external) гнезда не порождает. Чистая функция: без часов, без обращений к хранилищу; порядок гнёзд — по id. Проверка от обратного: на omg-live r2 даёт 79 гнёзд при 24 связях блоков.",
  "вход": "graph (слой N−1: nodes, connectors, artifacts, contracts); horizon {nodes, excluded, hash}",
  "выход": "slots[] со state open | sleeping",
  "ворота": "—" });
add("f4-accepted", "mechanism", { "название": "F4.2 · fillAccepted — заполнить из принятого слоя",
  "цель": "Принятая история не переделывается: то, что уже раскрыто и принято, заполняет гнёзда без модели.",
  "что делает": "fillAccepted(slots, acceptedLayer) → slots. Если у проекта есть принятый слой уровня N и его upperLayerHash равен текущему верхнему слою, концы его привязок заполняют гнёзда: fill = конец нижней привязки, чей узел — потомок upper.node (RefinementRelations.refines), source accepted, basis — id/revision/hash слоя. Верх изменился → отказ frame_upper_drift в G3, заполнения нет. Принятый слой не меняется.",
  "вход": "slots[]; graph-layer:<project>:<N> (принятый), если есть",
  "выход": "slots[] с заполненными accepted",
  "ворота": "G3 (frame_upper_drift)" });
add("f4-input", "mechanism", { "название": "F4.3 · fillFromInput — заполнить из привязок входа и решений",
  "цель": "Структурированные привязки и принятые решения ложатся в гнёзда кодом; неоднозначность — отказ, а не выбор.",
  "что делает": "fillFromInput(slots, omInput.bindings, acceptedDeltas) → slots. Кандидат подходит гнезду, если его узел — потомок upper.node, порт нужного направления и контракт порта равен portContract. Для гнезда производителя допустим ровно один кандидат: несколько → slot_fill_conflict; узел чужого блока → slot_fill_foreign (оба — отказ G3 класса «данные входа», маршрут к производителю). Принятая дельта MC2 (прошла G3 с хэшем кандидата) заполняет гнездо с source decision. Уже заполненное accepted гнездо не перезаписывается: расхождение — slot_fill_conflict.",
  "вход": "slots[]; om-input.bindings {node, port, contract}; принятые дельты операций",
  "выход": "slots[] с заполненными input | decision",
  "ворота": "G3 (slot_fill_conflict, slot_fill_foreign)" });
add("f4-open", "mechanism", { "название": "F4.4 · openSlotsToGaps — пустые гнёзда в адресные пробелы",
  "цель": "Каждая неуловленная связь подблоков видна поимённо и имеет потребителя — соседа, которому она нужна.",
  "что делает": "openSlotsToGaps(slots) → gaps[]. На каждое гнездо open: пробел { target: id гнезда, field: fill, kind: design-decision, consumer: узел на другом конце той же привязки, blocking: true для гнёзд горизонта }. Вопрос закрытый: «какой узел уровня N внутри <upper.node> производит / потребляет <artifact> по контракту <portContract>: один из существующих [перечень потомков с подходящим портом] либо новый». Линия пробела — по id гнезда: тот же id между проходами — тот же пробел. Гнёзда sleeping пробелов не дают: у них есть момент разрешения — вход соседа в горизонт.",
  "вход": "slots[] (state open)",
  "выход": "gaps[] → M5",
  "ворота": "G4 (через M5)" });
add("f4-assemble", "mechanism", { "название": "F4.5 · assembleLayer — собрать слой из заполненных гнёзд",
  "цель": "Кандидат слоя, у каждого элемента которого названо происхождение; проверяет его действующий валидатор.",
  "что делает": "assembleLayer(graph, frame, nodes) → candidate. Узлы уровня N — из принятого слоя, входа и принятых дельт; привязка уровня N каждого коннектора собирается из заполненных гнёзд: producer — гнездо производителя, consumers — гнёзда потребителей, sleeping — с якорем. Связи, живущие только с уровня N (внутри блока, между его подблоками; на omg-live r2 их 4), приходят из входа или дельт и проверяются теми же правилами (orphan_artifact, multiple_producers). Затем composeLayer (копия) и validateGraph; происхождение (source, basis) каждого узла и привязки пишется в layerProofs. Пока есть гнёзда open у горизонта, кандидат не собирается: сначала F4.4 → M5.",
  "вход": "connection-frame (все гнёзда горизонта filled | sleeping); узлы уровня N",
  "выход": "graph (кандидат: слой N для горизонта); layerProofs",
  "ворота": "G3 «Ворота слоя операций»" });

edge("mech-l2", "f4-slots", "flow"); edge("f4-slots", "st-frame", "record"); edge("f4-slots", "f4-accepted", "flow"); edge("f4-accepted", "f4-input", "flow");
edge("f4-input", "f4-open", "flow"); edge("f4-open", "mech-gaps", "record"); edge("f4-open", "f4-assemble", "flow"); edge("st-frame", "f4-assemble", "record");
edge("f4-assemble", "gate-l2", "flow"); edge("st-frame", "mech-l3", "record");

// раскладка: новая группа и пересчёт колонок, где изменились высоты
const relayout = gid => { const ns = s.nodes.filter(n => n.group === gid).sort((a, b) => a.pos[1] - b.pos[1]); if (!ns.length) return; let yy = ns[0].pos[1]; for (const n of ns) { n.pos[1] = yy; yy += n.size[1] + 110; }
  let g = s.groups.find(g => g.id === gid || String(g.title).startsWith(gid)); if (!g) { g = { id: gid, title: gid }; s.groups.push(g); } g.bounding = [ns[0].pos[0] - 40, ns[0].pos[1] - 80, W + 80, yy - 110 - ns[0].pos[1] + 140]; };
for (const gid of new Set(s.nodes.map(n => n.group).filter(Boolean))) relayout(gid);
writeFileSync("om-design.json", JSON.stringify(s, null, 1)); console.log(`уровень 2 · M4 засеян: узлов ${s.nodes.length}, связей ${s.edges.length}, групп ${s.groups.length}`);

// Уровень 2 · M4, редакция 2 — перестройка по вердикту Codex №1 (OMG-L2-M4). Проверено прототипом proto-frame.mjs
// на настоящих validateGraph и composeLayer из dist/ без правок в них. Идемпотентен по содержанию (перезаписывает поля узлов группы).
import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id);
const G = "Уровень 2 · M4 · Каркас связей операций";
const put = (id, type, fields, after) => { let n = by(id); if (!n) { const ref = by(after); n = { id, type, fields, pos: [ref.pos[0], ref.pos[1] + 1], size: [W, 0], group: G }; s.nodes.push(n); } n.fields = fields; n.size = [W, heightOf(type, fields)]; };
const edge = (from, to, kind) => { if (!s.edges.some(e => e.from === from && e.to === to && e.kind === kind)) s.edges.push({ from, to, kind }); };

put("st-frame", "store", { "запись": "connection-frame (каркас обязательств уровня N)",
  "что хранит": "{ project, level N, horizonHash, upperProjectionHash — hashJson(projectGraph(graph, N−1)), тот же вид хэша, что LayerProof.hash, obligations[], counts }. Обязательство двух видов: connection-end { connector, artifact, portContract, role producer | consumer, upper{node, port} } — конец связи уровня N−1; block-outcome { upper.node, artifact } — в верхнем узле нужен узел уровня N, производящий его исход (правило layer_outcome_uncovered; узел без связей тоже получает обязательство). Зона: horizon | outside. Заполнения: у producer и block-outcome ровно одно, у consumer — fills[] (≥ 1: исход могут потреблять несколько подблоков одного блока). Заполнение { node, port?, source: accepted | proposed | identity, basis{id, revision, hash} }. Ревизии записи: F4.1 — обязательства; F4.3 — с заполнениями (кандидатная); F4.6 — принятая, с тем же хэшем кандидата, что у прохода G3; M7 и пакет контекста читают ТОЛЬКО принятую ревизию по точной ссылке. Id обязательства = хэш(вид, connector, level, role, upper.node, upper.port): не зависит от порядка, дат и позиций. При смене идентификаторов верхнего слоя соответствие старое → новое берётся только из ОБЪЯВЛЕННОГО переименования в самом изменении верхнего слоя; без него новое обязательство — новая работа с основанием «верх изменён: ревизия X → Y», ответ со старого обязательства не переносится. Расход учитывается на блоке (серия исправлений и ведомость G8), поэтому смена id обязательства расход и попытки не обнуляет." });
put("st-proposal", "store", { "запись": "layer-proposal (предложение слоя)",
  "что хранит": "{ id, base{graph ref, frame ref}, level, nodes[] — полные определения узлов уровня N (id, parent, outcome, ports, boundary, code, tests, implements…), fills[{ obligation, node, port? }], localConnectors[] — связи, живущие с уровня N, с обоими концами, artifacts[] и contracts[], которые предложение вводит, tests/edges/journeys при необходимости, replaces?[{ obligation, base{id, revision, hash} принятого заполнения, basis }], source: input (структурированный вход M1) | decision (MC2), status: proposed | accepted | rejected, verdict?{candidateHash, gate ref} }. Ссылка {node, port, contract} без определения узла предложением не считается: вариант ответа «новый узел» обязан нести определение. Прототип показал, что без artifacts/contracts/journeys предложения настоящий валидатор отклоняет кандидат (artifact_missing, contract_missing, terminal_outcome_unobserved)." }, "st-frame");
put("f4-slots", "mechanism", { "название": "F4.1 · frameObligations — построить обязательства",
  "цель": "Требования «у каждой связи внизу конкретные концы» и «у каждого блока внизу производитель его исхода» выражены данными до вывода слоя.",
  "что делает": "frameObligations(graph, horizon, level) → obligations[]. По ВСЕМУ верхнему слою, не только по горизонту: сборщик требует покрытия каждого узла (layer-design.ts:73) и каждой связи (78–85). Каждому верхнему узлу — block-outcome; каждому концу каждой привязки уровня N−1 — connection-end. Зона horizon, если upper.node в горизонте, иначе outside. Внешний артефакт обязательств не порождает. Чистая функция: без часов и хранилища, порядок по id. На omg-live r2: 25 + 79 обязательств (proto-frame.mjs).",
  "вход": "graph (слой N−1); horizon {nodes, excluded, hash}",
  "выход": "connection-frame, ревизия обязательств",
  "ворота": "—" });
put("f4-accepted", "mechanism", { "название": "F4.2 · fillAcceptedAndIdentity — принятое и тождественное",
  "цель": "Принятая история не переделывается; нераскрытое вне горизонта не выдумывается, а честно представлено самим собой.",
  "что делает": "1) Принятое. Слой N считается принятым не по наличию graph-layer:<project>:<N>, а если layerIsDerived(project, N) истинно; его верх сверяется так: layerProofs.find(level = N−1).hash === hashJson(projectGraph(текущий граф, N−1)). Совпало — концы его привязок и узлы заполняют обязательства (source accepted, basis — ссылка слоя). Не совпало — frame_upper_drift. Поля upperLayerHash в исторических записях нет и не вводится задним числом. 2) Тождественное уточнение. Обязательства зоны outside без принятого раскрытия заполняет узел-представитель, выведенный кодом 1:1 из верхнего узла (тот же исход, порты, граница; соединение входов блока наследуется; source identity). Уровни концов совпадают, поэтому validate.ts:74 и composeLayer проходят без изменений: проверено прототипом — 25 представителей приняты настоящими validateGraph и composeLayer. Из представителей работы и задачи не выводятся. 3) Исключение: producer зоны outside без принятого раскрытия, чей артефакт потребляет узел горизонта, — не откладывается: отказ horizon_producer_unrefined, возврат в M2/G2 (горизонт не замкнут).",
  "вход": "connection-frame; graph; graph-layer:<project>:<N> и его layerProofs, если есть",
  "выход": "заполнения accepted | identity",
  "ворота": "G3 (frame_upper_drift, horizon_producer_unrefined)" });
put("f4-input", "mechanism", { "название": "F4.3 · applyProposals — положить предложения",
  "цель": "Предложения слоя ложатся в обязательства кодом до проверки; принятия для этого не требуется — взаимного ожидания нет.",
  "что делает": "applyProposals(frame, proposals) → frame (кандидатная ревизия). Берёт предложения со status proposed для этой базы (base.frame, base.graph): устаревшая база → proposal_base_stale. Заполнение подходит обязательству, если узел определён в том же предложении либо принят, является потомком upper.node, порт нужного направления и контракта. producer и block-outcome — ровно одно заполнение; consumer — одно или несколько. Принятое заполнение меняется только явной заменой replaces с точной базой {id, revision, hash} и основанием: старая ревизия сохраняется, новая пойдёт через G3. Две разные замены одной базы либо два разных предложения на одно единичное обязательство → slot_fill_conflict; узел чужого верхнего узла → slot_fill_foreign. Заполнить обязательство зоны horizon представителем нельзя → identity_in_horizon.",
  "вход": "connection-frame; layer-proposal[] (source input | decision)",
  "выход": "connection-frame, кандидатная ревизия; перечень незаполненных обязательств горизонта",
  "ворота": "G3 (proposal_base_stale, slot_fill_conflict, slot_fill_foreign, identity_in_horizon)" });
put("f4-open", "mechanism", { "название": "F4.4 · openObligationsToGaps — незаполненное в адресные пробелы",
  "цель": "Каждая неуловленная связь подблоков и каждый блок без производителя исхода видны поимённо, с тем, кого это блокирует.",
  "что делает": "openObligationsToGaps(frame) → gaps[]. На каждое обязательство зоны horizon без заполнения: пробел { target: id обязательства, field: fill, kind: design-decision, consumer: upper.node — узел, чьё раскрытие заблокировано, neighbors[]: все остальные концы той же привязки (у 14 связей omg-live потребителей несколько — адресаты не теряются), blocking: true }. Вопрос к MC2 закрытый: «какой узел уровня N внутри <upper.node> производит / потребляет <artifact> по контракту <portContract>: один из существующих [перечень] либо новый — тогда с полным определением узла». Ответ MC2 — запись layer-proposal со status proposed, она возвращается в F4.3. Линия пробела — по id обязательства.",
  "вход": "connection-frame, кандидатная ревизия",
  "выход": "gaps[] → M5 → MC2 → layer-proposal",
  "ворота": "G4 (через M5)" });
put("f4-assemble", "mechanism", { "название": "F4.5 · assembleCandidate — собрать кандидат слоя",
  "цель": "Кандидат собирается из принятого, предложенного и тождественного; проверяет его действующий валидатор без изменений.",
  "что делает": "assembleCandidate(graph, frame, proposals) → candidate. Условие запуска: каждое обязательство зоны horizon заполнено принятым ИЛИ предложенным (не обязательно принятым); зоны outside — принятым или представителем. Узлы уровня N — из принятого слоя, предложений и представителей; привязка уровня N каждой связи: producer — заполнение производителя, consumers — объединение ВСЕХ заполнений потребителей. Локальные связи, артефакты, контракты, тесты, рёбра и пути — из предложений. Затем composeLayer и validateGraph (копии) — весь валидатор, включая концы, направление, контракт порта, родство, возвраты, соединения входов и циклы. Дополнительно для уровня 2: каждый входной порт предложенного узла привязан связью (действующий layer_port_unbound работает только для уровня 3) → operation_port_unbound. Происхождение (source, basis) каждого элемента — в layerProofs. Прототип: горизонты {}, {n-intake, n-state} и все 25 блоков приняты; горизонт из четырёх блоков без n-intake отклонён terminal_outcome_unobserved — путь, наблюдающий конечный артефакт, начинается вне горизонта: незамкнутый горизонт ловится, а не проходит молча.",
  "вход": "connection-frame, кандидатная ревизия; layer-proposal[]; graph",
  "выход": "candidate {graph, hash}; layerProofs",
  "ворота": "G3 «Ворота слоя операций»" });
put("f4-accept", "mechanism", { "название": "F4.6 · settleCandidate — зафиксировать исход проверки",
  "цель": "Кандидат и принятый результат различимы; принятие атомарно и однократно, отказ ничего принятого не меняет.",
  "что делает": "settleCandidate(candidate, verdict G3). Проход: одним store.writeMany с guards [base.graph, base.frame, ревизии предложений] — новая ревизия graph, graph-layer уровня N с LayerProof {level N, hash проекции}, принятая ревизия connection-frame, предложения кандидата → accepted {candidateHash}. Несовпадение базы — отказ записи, ничего не применено. Отказ G3: предложения кандидата → rejected {candidateHash, коды}; граф, слой и принятый каркас не меняются; дальше решают ворота повтора G7 (серия и лимит). Повторная доставка того же исхода по тому же candidateHash ничего не меняет.",
  "вход": "candidate; исход G3 с хэшем кандидата",
  "выход": "принятый слой N и принятая ревизия каркаса либо отклонённые предложения",
  "ворота": "G7 на обратном пути (действующая связь G3 → G7)" }, "f4-assemble");

const m4 = by("mech-l2").fields;
m4["что делает"] = m4["что делает"].replace(/Частичное уточнение по горизонту требует изменения composeLayer\/deriveLayer:[^\n]*\n?/, "Частичное уточнение по горизонту не требует менять сборщик: нераскрытые блоки вне горизонта представлены тождественной операцией, выведенной кодом 1:1 из блока, — настоящие validateGraph и composeLayer принимают такой слой без правок (proto-frame.mjs, 21.09.2026). Операции нового продукта приходят предложениями слоя (layer-proposal: структурированный вход либо MC2) с полными определениями узлов; круг: предложение → кандидат → G3 → принятие.\n");
by("mech-l2").size = [W, heightOf("mechanism", m4)];
const g3 = by("gate-l2").fields;
g3["коды отказа"] = g3["коды отказа"].replace(/ Каркас \(уровень 2 · M4\):[^]*$/, "") + " Каркас (уровень 2 · M4): frame_upper_drift; horizon_producer_unrefined (→ M2/G2, владелец); proposal_base_stale; slot_fill_conflict; slot_fill_foreign; identity_in_horizon; operation_port_unbound. Незаполненное обязательство — не отказ, а пробел в M5.";
by("gate-l2").size = [W, heightOf("gate", g3)];

edge("st-proposal", "f4-input", "record"); edge("model-design", "st-proposal", "record"); edge("mech-contract", "st-proposal", "record");
edge("f4-input", "st-frame", "record"); edge("gate-l2", "f4-accept", "gate_pass"); edge("gate-l2", "f4-accept", "gate_fail");
edge("f4-accept", "st-frame", "record"); edge("f4-accept", "st-proposal", "record"); edge("f4-accept", "store-records", "record");

const order = ["st-frame", "st-proposal", "f4-slots", "f4-accepted", "f4-input", "f4-open", "f4-assemble", "f4-accept"]; let y = -80;
for (const id of order) { const n = by(id); n.pos[1] = y; y += n.size[1] + 110; }
for (const gid of new Set(s.nodes.map(n => n.group).filter(Boolean))) { const ns = s.nodes.filter(n => n.group === gid).sort((a, b) => a.pos[1] - b.pos[1]); let yy = ns[0].pos[1]; for (const n of ns) { n.pos[1] = yy; yy += n.size[1] + 110; }
  const g = s.groups.find(g => g.id === gid || String(g.title).startsWith(gid)); if (g) g.bounding = [ns[0].pos[0] - 40, ns[0].pos[1] - 80, W + 80, yy - 110 - ns[0].pos[1] + 140]; }
writeFileSync("om-design.json", JSON.stringify(s, null, 1)); console.log(`редакция 2: узлов ${s.nodes.length}, связей ${s.edges.length}`);

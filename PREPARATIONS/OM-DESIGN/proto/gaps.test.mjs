// Тесты исполняемой спецификации M5 «пробелы», редакция 2. Живые стадии и верхний слой omg-live — ТОЛЬКО на чтение; уровень работ — тестовый граф garden-plus.
// Запуск: node --test PREPARATIONS/OM-DESIGN/proto/gaps.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import { DatabaseSync } from "node:sqlite"; import { homedir } from "node:os"; import { join } from "node:path";
import { projectGraph } from "../../../dist/src/graph/project.js";
import { buildOmInput } from "./input.mjs"; import { closeHorizon } from "./horizon.mjs"; import * as F from "./frame.mjs"; import * as G from "./gaps.mjs"; import { gardenPlus } from "./garden-plus.mjs";
const db = new DatabaseSync(join(homedir(), "OMG/.omg/state.sqlite"), { readOnly: true }); const head = id => db.prepare(`SELECT r.entity_id id, r.revision, r.sha256 hash, r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id=?`).get(id);
const load = () => Object.fromEntries(["discovery", "concept", "operation-map", "specification", "features"].map(st => { const r = head(`stage:omg-live:${st}`); const body = JSON.parse(r.body); const d = body.content.draft;
  const draft = d ? db.prepare(`SELECT body FROM revisions WHERE entity_id=? AND revision=?`).get(d.id, d.revision) : null; return [st, { ref: { id: r.id, revision: r.revision, hash: r.hash }, fields: body.content.fields, contractVersion: draft ? JSON.parse(draft.body).contractVersion : undefined }]; }));
const UPPER = (({ level, ...g }) => g)(JSON.parse(head("graph-layer:omg-live:1").body).projection); const UI = { block: "n-ui", reason: "сначала бэкенд (решение владельца 21.09.2026)", returnCondition: "понятно, как работает бэкенд" };
const INPUT = buildOmInput(load()); const horizonOf = (outcome, v = "c1") => closeHorizon(UPPER, { choiceVersion: v, features: [{ outcome }], excluded: [UI] }).horizon;
const sourcesFor = (hor, inputResult = INPUT) => { const H = new Set(hor.nodes); const ob = F.frameObligations(UPPER, H); const open = F.fillObligations(UPPER, ob, null, [], H, { graph: null, frame: null }).open;
  return { inputResult, frameGaps: F.openObligationsToGaps(ob, open), horizon: hor, graph: UPPER }; };
const HOR = horizonOf("autonomous-knowledge"); const H = new Set(HOR.nodes); const SRC = sourcesFor(HOR); const live = () => G.collectGaps(SRC); const ref = (i, h = "a") => ({ id: `om-answer:${i}`, revision: 1, hash: h.repeat(64) });

test("живые данные omg-live: четыре источника сведены к одной записи; у каждого пробела — потребитель в горизонте, механизм или отсрочка с условием возвращения; ворота G4 пройдены", () => {
  const r = live(); assert.deepEqual(r.refusals, []); assert.deepEqual(G.gateGaps(r, SRC), { passed: true, codes: [], findings: [] }); assert.equal(r.gaps.length, INPUT.gaps.length + SRC.frameGaps.length + INPUT.input.questions.length);
  assert.ok(SRC.frameGaps.length > 0 && r.gaps.filter(g => g.origins.includes("frame")).every(g => g.blocking && g.kind === "design-decision" && g.consumers.every(b => H.has(b))), "незаполненное обязательство горизонта блокирует сборку");
  const deferred = r.gaps.filter(g => g.deferral); assert.ok(deferred.length > 0, "пробелы фич вне горизонта отложены, а не потеряны"); assert.ok(deferred.every(g => !g.blocking && g.deferral.until === "horizon-entry" && g.deferral.blocks.length && !g.deferral.blocks.some(b => H.has(b))));
  const inv = r.gaps.find(g => g.code === "inventory_missing"); assert.deepEqual([inv.kind, inv.moment, inv.blocking, inv.routes], ["repository-fact", "feasibility", false, ["code", "research"]], "инвентарь нужен проверке реализуемости, сборку слоя не блокирует"); });

test("вердикт №1 п.4: вид знания и адрес вопроса проходят через НАСТОЯЩИЙ стык F1.1 → F5.1; принятое решение об адресации делает вопрос обязательством своего вида, а не ответом", () => {
  const prose = live().gaps.filter(g => g.origins.includes("question")); assert.equal(prose.length, 10); assert.ok(prose.every(g => g.code === "question_unaddressed" && g.blocking && g.mechanism && g.routes[0] === "design"), "потребитель прозой узлом не считается");
  const stages = load(); const u = stages.discovery.fields.preparation.unknowns[0]; u.consumer = HOR.nodes[0]; u.kind = "repository-fact"; const joined = buildOmInput(stages); assert.deepEqual(joined.refusals, []);
  const q = G.collectGaps(sourcesFor(HOR, joined)).gaps.find(g => g.target === `discovery:${u.id}`); assert.deepEqual([q.code, q.field, q.kind, q.routes, q.consumers, q.blocking], ["predecessor_question", "answer", "repository-fact", ["code", "research"], [HOR.nodes[0]], true], "сценарий ревью: вид от производителя не теряется");
  const target = INPUT.input.questions[1].id, outside = UPPER.nodes.find(n => n.kind === "block" && !H.has(n.id) && n.id !== "n-ui").id; const bad = d => G.applyAddressing(INPUT, [d], UPPER).refusals.map(x => x.code);
  assert.deepEqual(bad({ question: target, consumer: "нет-такого-узла", kind: "owner-decision", basis: ref(1) }), ["addressing_invalid"]); assert.deepEqual(bad({ question: target, consumer: outside, kind: "сам придумал", basis: ref(1) }), ["addressing_invalid"]);
  assert.deepEqual(bad({ question: target, consumer: outside, kind: "owner-decision", basis: { id: "x", revision: -1, hash: "x" } }), ["addressing_invalid"]); assert.deepEqual(bad({ question: "нет-такого-вопроса", consumer: outside, kind: "owner-decision", basis: ref(1) }), ["addressing_invalid"]);
  const done = G.applyAddressing(INPUT, [{ question: target, consumer: outside, kind: "environment-confirmation", basis: ref(7) }], UPPER); assert.deepEqual(done.refusals, []); assert.notEqual(done.result.hash, INPUT.hash, "адресация меняет версию входа");
  const after = G.collectGaps(sourcesFor(HOR, done.result)); const a = after.gaps.find(g => g.target === target); assert.deepEqual([a.code, a.field, a.kind, a.moment, a.blocking, a.addressedBy, a.deferral.until], ["predecessor_question", "answer", "environment-confirmation", "task-start", false, ref(7), "horizon-entry"]);
  assert.ok(!after.gaps.some(g => g.id === G.gapId(target, "address")), "пробел адресации ушёл, но появился пробел ответа: вопрос не считается разрешённым"); assert.equal(G.gateGaps(after, sourcesFor(HOR, done.result)).passed, true); });

test("горизонт меняет статус, а не состав пробелов входа: при другой фиче те же пробелы, отложенные становятся действующими", () => {
  const wide = horizonOf("verified-change", "c2"); const a = live(); const b = G.collectGaps({ ...SRC, frameGaps: [], horizon: wide }); const ids = r => r.gaps.filter(g => !g.origins.includes("frame")).map(g => g.id).sort(); assert.deepEqual(ids(a), ids(b));
  const woke = b.gaps.filter(g => !g.deferral && a.gaps.find(x => x.id === g.id)?.deferral); assert.ok(woke.length > 0, "блок вошёл в горизонт — его отложенные пробелы проснулись"); assert.ok(woke.every(g => g.blocking)); });

test("каркас работ: потребитель пробела — операция, горизонт — блоки; пробел привязан к блоку операции, сосед сохранён", () => {
  const g3 = gardenPlus(); const acc2 = (({ level, ...g }) => g)(projectGraph(g3, 2)); const upper = F.upperOf(acc2, 3); const zone = new Set(["garden-prep-operation", "garden-produce-operation", "garden-consume-operation"]);
  const ob = F.frameObligations(upper, zone, 3); const open = F.fillObligations(upper, ob, null, [], zone, { graph: null, frame: null }, 3).open; const src = { inputResult: { input: { features: [], contracts: [], questions: [] }, gaps: [], hash: null }, frameGaps: F.openObligationsToGaps(ob, open), horizon: { nodes: ["garden-consume-block", "garden-produce-block"] }, graph: acc2 };      // источники — явно, в том числе пустой вход
  const r = G.collectGaps(src); assert.deepEqual(r.refusals, []); assert.equal(G.gateGaps(r, src).passed, true); assert.equal(r.gaps.length, open.length);
  const end = r.gaps.find(g => g.node === "garden-produce-operation" && g.neighbors?.length); assert.deepEqual(end.consumers, ["garden-produce-block"]); assert.ok(end.neighbors.some(n => n.node === "garden-prep-operation" || n.node === "garden-consume-operation"), "в пробеле назван сосед по связи"); });

test("вердикт №1 п.3: выход блока из горизонта НЕ закрывает незаполненные обязательства — линия отложена «вне области проверки»; закрытие только с основанием; фиксация прохода идемпотентна", () => {
  const wideSrc = sourcesFor(horizonOf("verified-change")); const wide = G.collectGaps(wideSrc).gaps; const p1 = G.mergeLines([], wide, 1); assert.deepEqual(p1.refusals, []); const narrow = live().gaps; const p2 = G.mergeLines(p1.lines, narrow, 2);
  const lost = p1.lines.filter(l => !narrow.some(g => g.id === l.id)); assert.ok(lost.length > 50, `сценарий ревью: из набора ушло ${lost.length} незаполненных обязательств`);
  assert.ok(lost.every(l => { const x = p2.lines.find(y => y.id === l.id); return x.status === "deferred" && x.scope === "absent" && x.closedPass === undefined; }), "ни одно не закрыто"); assert.equal(p2.lines.filter(l => l.status === "closed").length, 0);
  const again = G.mergeLines(p2.lines, narrow, 2); assert.deepEqual(again.lines, p2.lines, "повтор того же прохода ничего не меняет"); const p3 = G.mergeLines(p2.lines, wide, 3); const back = p3.lines.find(l => l.id === lost[0].id);
  assert.deepEqual([back.status, back.scope, back.passes, back.reopened], ["open", undefined, 2, 0], "вернулся в область проверки — та же линия, не новая и не «открытая заново»");
  const gone = lost[0].id, here = narrow[0].id; const c = G.mergeLines(p2.lines, narrow, 3, [{ id: gone, reason: "filled", basis: ref(1) }]); assert.deepEqual(c.refusals, []);
  assert.deepEqual((({ status, closedBy, closedPass, basis }) => [status, closedBy, closedPass, basis])(c.lines.find(l => l.id === gone)), ["closed", "filled", 3, ref(1)]);
  const re = G.mergeLines(c.lines, wide, 4).lines.find(l => l.id === gone); assert.deepEqual([re.status, re.reopened, re.closedBy], ["open", 1, undefined], "закрытый и вернувшийся — открыт заново, возвращение учтено");
  for (const bad of [{ id: here, reason: "filled", basis: ref(1) }, { id: gone, reason: "надоел", basis: ref(1) }, { id: gone, reason: "cancelled", basis: { id: "x", revision: -1, hash: "x" } }, { id: "f".repeat(64), reason: "filled", basis: ref(1) }])
    assert.deepEqual(G.mergeLines(p2.lines, narrow, 3, [bad]).refusals.map(x => x.code), ["closure_invalid"], JSON.stringify(bad)); });

test("вердикт №1 п.2: ворота не доверяют присланной записи — набор выводится заново из источников; подмена момента, маршрута, признака «блокирует», вида, id, отсрочки, пропуск, лишний и дубль видны", () => {
  const forge = change => { const r = live(); change(r.gaps.find(x => x.blocking), r); return G.gateGaps(r, SRC).codes; };
  assert.deepEqual(forge(g => { g.moment = "task-result"; g.blocking = false; }), ["gap_record_forged"], "сценарий ревью: блокирующий проектный пробел не уходит «на потом»"); assert.deepEqual(forge(g => { g.routes = ["code"]; }), ["gap_record_forged"], "сценарий ревью: маршрут не подменяется");
  assert.deepEqual(forge(g => { g.blocking = false; }), ["gap_record_forged"]); assert.deepEqual(forge(g => { g.kind = "repository-fact"; }), ["gap_record_forged"]); assert.deepEqual(forge(g => { g.deferral = { reason: "так удобнее", until: "horizon-entry" }; }), ["gap_record_forged"]);
  assert.deepEqual(forge(g => { g.consumers = []; }), ["gap_record_forged"]); assert.deepEqual(forge(g => { g.id = "0".repeat(64); }), ["gap_foreign", "gap_missing"]); assert.deepEqual(forge((g, r) => { r.gaps.pop(); }), ["gap_missing"]);
  assert.deepEqual(forge((g, r) => { r.gaps.push(structuredClone(g)); }), ["gap_duplicate"]); assert.deepEqual(forge((g, r) => { r.gaps.push({ ...structuredClone(g), id: G.gapId("выдуманная цель", "fill"), target: "выдуманная цель" }); }), ["gap_foreign"]);
  const bad = (gaps, questions = []) => { const src = { ...SRC, frameGaps: [], inputResult: { ...INPUT, input: { ...INPUT.input, questions }, gaps } }; return G.gateGaps(G.collectGaps(src), src).codes; };
  assert.deepEqual(bad([{ code: "made_up_code", target: "x", consumer: { features: [] } }]), ["gap_class_unknown"]); assert.deepEqual(bad([{ code: "contract_node_unbound", target: "x", consumer: { features: [] } }]), ["gap_consumer_missing"]);
  assert.deepEqual(bad([{ code: "contract_node_unbound", target: "x", consumer: "нет-такого-узла" }]), ["gap_consumer_missing"]); const inside = HOR.nodes[0], other = HOR.nodes[1];
  assert.deepEqual(bad([], [{ id: "q", consumer: inside, kind: "repository-fact" }, { id: "q", consumer: inside, kind: "owner-decision" }]), ["gap_class_conflict"], "два источника с разной классификацией одного поля — явный отказ, первый молча не выигрывает");
  const src = { ...SRC, frameGaps: [], inputResult: { ...INPUT, gaps: [], input: { ...INPUT.input, questions: [{ id: "q", consumer: inside, kind: "repository-fact" }, { id: "q", consumer: other, kind: "repository-fact" }] } } }; const merged = G.collectGaps(src);
  assert.deepEqual([merged.refusals, merged.gaps.length, merged.gaps[0].consumers], [[], 1, [inside, other].sort()], "одинаковая классификация — одна запись с объединёнными потребителями"); });

test("вердикт №1 п.1: G4b — у каждого блокирующего пробела один результат законным маршрутом со СТРОГОЙ ссылкой; отсрочку блокирующего пробела результат маршрута дать не может; пробелы берутся из источников, а не у вызывающего", () => {
  const blocking = live().gaps.filter(g => g.blocking); assert.ok(blocking.length > 40); const all = blocking.map((g, i) => ({ gap: g.id, route: g.routes[0], inputHash: INPUT.hash, answerRef: ref(i) }));
  assert.deepEqual(G.gateAnswers(SRC, all), { passed: true, codes: [], findings: [] }); assert.deepEqual(G.gateAnswers(SRC, all.slice(1)).codes, ["answer_missing_for_blocking_gap"]);
  assert.deepEqual(G.gateAnswers(SRC, blocking.map(g => ({ gap: g.id, route: g.routes[0], inputHash: INPUT.hash, deferral: { until: "never" } }))).codes, ["deferral_not_permitted"], "сценарий ревью: все блокирующие «отложены навсегда» — отказ");
  const swap = change => all.map((r, i) => (i === 0 ? change({ ...r }) : r)); assert.deepEqual(G.gateAnswers(SRC, swap(r => ({ ...r, answerRef: { id: "x", revision: -1, hash: "x" } }))).codes, ["route_result_missing"], "сценарий ревью: неточная ссылка не проходит");
  assert.deepEqual(G.gateAnswers(SRC, swap(r => ({ ...r, deferral: { until: "task-start" } }))).codes, ["deferral_not_permitted"]); assert.deepEqual(G.gateAnswers(SRC, swap(r => ({ ...r, route: "code" }))).codes, ["answer_route_foreign"], "проектное решение нельзя объявить фактом репозитория");
  assert.deepEqual(G.gateAnswers(SRC, swap(r => ({ ...r, inputHash: "другая версия входа" }))).codes, ["answer_version_stale"]); assert.deepEqual(G.gateAnswers(SRC, [...all, all[0]]).codes, ["answer_duplicate"]);
  assert.deepEqual(G.gateAnswers(SRC, [...all, { ...all[0], gap: "f".repeat(64) }]).codes, ["answer_gap_unknown"]);
  const calm = { ...SRC, frameGaps: [], inputResult: { ...INPUT, gaps: INPUT.gaps.filter(g => g.code === "inventory_missing"), input: { ...INPUT.input, questions: [] } } }; assert.equal(G.gateAnswers(calm, []).passed, true, "инвентарь остаётся обязательством M8, но готовности сборки не держит"); });

test("вердикт №2 п.1: проверяемая запись не может изменить доверенную таблицу — правка массива маршрутов НА МЕСТЕ политику не трогает, таблицы заморожены", () => {
  const r = live(); const g = r.gaps.find(x => x.blocking && x.kind === "design-decision"); g.routes.splice(0, 1, "code"); assert.deepEqual(G.ROUTES["design-decision"], ["design"], "сценарий ревью: таблица не изменилась");
  assert.deepEqual(live().gaps.find(x => x.id === g.id).routes, ["design"]); assert.deepEqual(G.gateGaps(r, SRC).codes, ["gap_record_forged"]);
  const blocking = live().gaps.filter(x => x.blocking); assert.ok(G.gateAnswers(SRC, blocking.map((x, i) => ({ gap: x.id, route: "code", inputHash: INPUT.hash, answerRef: ref(i) }))).codes.includes("answer_route_foreign"), "маршрут code для проектных пробелов по-прежнему чужой");
  assert.throws(() => G.ROUTES["design-decision"].push("code"), TypeError); assert.throws(() => { G.GAP_CLASSES.obligation_open.kind = "repository-fact"; }, TypeError); assert.throws(() => { G.ROUTES["design-decision"] = ["code"]; }, TypeError); assert.throws(() => G.MOMENTS.push("never"), TypeError);
  const d = live().gaps.find(x => x.deferral); d.deferral.blocks.push("n-ui"); assert.notDeepEqual(d.deferral.blocks, d.consumers, "части записи не делят один массив");
  assert.deepEqual(G.collectGaps({ ...SRC, frameGaps: [], inputResult: { ...INPUT, gaps: [{ code: "constructor", target: "x", kind: "design-decision", consumer: HOR.nodes[0] }] } }).refusals.map(x => x.code), ["gap_class_unknown"], "унаследованное поле объекта классом пробела не считается"); });

test("вердикт №2 п.2: адресация заполняет только НЕДОСТАЮЩИЙ адрес — сведения производителя и принятую адресацию не переписывает; повтор того же решения ничего не меняет", () => {
  const stages = load(); const u = stages.discovery.fields.preparation.unknowns[0]; u.consumer = HOR.nodes[0]; u.kind = "repository-fact"; const joined = buildOmInput(stages); const qid = `discovery:${u.id}`; const src = sourcesFor(HOR, joined);
  const gap = G.collectGaps(src).gaps.find(g => g.target === qid); assert.equal(gap.blocking, true); assert.ok(G.gateAnswers(src, []).codes.includes("answer_missing_for_blocking_gap"));
  const bypass = G.applyAddressing(joined, [{ question: qid, consumer: HOR.nodes[0], kind: "post-implementation-proof", basis: ref(1) }], UPPER);
  assert.deepEqual(bypass.refusals.map(x => x.code), ["addressing_overrides_producer"], "сценарий ревью: переклассификация уже адресованного вопроса — отказ"); assert.equal(bypass.result.hash, joined.hash, "вход не изменён");
  assert.equal(G.collectGaps(sourcesFor(HOR, bypass.result)).gaps.find(g => g.target === qid).blocking, true, "вопрос остался блокирующим: запрет отсрочки не обойдён");
  const target = INPUT.input.questions[1]; const outside = UPPER.nodes.find(n => n.kind === "block" && !H.has(n.id) && n.id !== "n-ui").id; const d = { question: target.id, consumer: outside, kind: "environment-confirmation", basis: ref(7) };
  const once = G.applyAddressing(INPUT, [d], UPPER), twice = G.applyAddressing(once.result, [d], UPPER); assert.deepEqual([once.refusals, twice.refusals], [[], []]); assert.equal(twice.result.hash, once.result.hash, "сценарий ревью: повтор того же решения не меняет версию входа");
  assert.equal(twice.result.input.questions.find(q => q.id === target.id).prose, target.consumer, "исходная проза потребителя сохранена");
  for (const other of [{ ...d, kind: "post-implementation-proof" }, { ...d, consumer: HOR.nodes[0] }, { ...d, basis: ref(8) }]) { const again = G.applyAddressing(once.result, [other], UPPER);
    assert.deepEqual(again.refusals.map(x => x.code), ["addressing_conflict"], JSON.stringify(other)); assert.equal(again.result.hash, once.result.hash); }
  assert.deepEqual(G.applyAddressing(INPUT, "не список", UPPER).refusals.map(x => x.code), ["addressing_invalid"]); });

test("вердикт №2 п.3 и ОТСУТСТВИЕ: нет присланного набора, списка отказов, ответов или обязательного источника — типизированный отказ, а не успех; проход старше зафиксированного линий не меняет", () => {
  assert.ok(live().gaps.some(g => g.blocking)); for (const bad of [{}, undefined, null, { gaps: live().gaps }, { refusals: [] }, { gaps: "набор", refusals: [] }, { gaps: [null], refusals: [] }])
    assert.deepEqual(G.gateGaps(bad, SRC).codes, ["gap_set_missing"], `сценарий ревью: ${JSON.stringify(bad)?.slice(0, 40)}`);
  assert.deepEqual(G.gateGaps({ gaps: [], refusals: [] }, SRC).codes, ["gap_missing"], "пустой присланный набор сверяется честно"); assert.deepEqual(G.gateAnswers(SRC, undefined).codes, ["answers_missing"]); assert.deepEqual(G.gateAnswers(SRC, [null]).codes, ["answers_missing"]);
  for (const [name, broken] of [["horizon", { ...SRC, horizon: undefined }], ["graph", { ...SRC, graph: {} }], ["frameGaps", { ...SRC, frameGaps: null }]]) { assert.deepEqual(G.collectGaps(broken).refusals, [{ code: "gap_source_missing", target: name }]);
    assert.deepEqual(G.gateGaps({ gaps: [], refusals: [] }, broken).codes, ["gap_source_missing"]); assert.deepEqual(G.gateAnswers(broken, []).codes, ["gap_source_missing"], "нет источника — не значит «пробелов нет»"); }
  const p2 = G.mergeLines(G.mergeLines([], live().gaps, 1).lines, live().gaps, 2); for (const pass of [1, 0, 1.5, "3", undefined]) { const late = G.mergeLines(p2.lines, [], pass); assert.deepEqual(late.refusals.map(x => x.code), ["pass_out_of_order"], String(pass)); assert.deepEqual(late.lines, p2.lines); } });

test("вердикт №3 п.1: обязательный источник приходит ЯВНО — удалённое поле frameGaps или вход без списков дают отказ, а не «пробелов нет»; явный пустой список — полученный пустой результат", () => {
  assert.ok(G.gateAnswers(SRC, []).codes.includes("answer_missing_for_blocking_gap")); const { frameGaps, ...noFrame } = SRC; assert.ok(frameGaps.length > 0);
  assert.deepEqual(G.collectGaps(noFrame), { gaps: [], refusals: [{ code: "gap_source_missing", target: "frameGaps" }] }, "сценарий ревью: поле удалено"); assert.deepEqual(G.gateGaps({ gaps: [], refusals: [] }, noFrame).codes, ["gap_source_missing"]); assert.deepEqual(G.gateAnswers(noFrame, []).codes, ["gap_source_missing"]);
  for (const [target, broken] of [["frameGaps", { ...SRC, frameGaps: undefined }], ["inputResult", { ...SRC, inputResult: undefined }], ["inputResult", { ...SRC, inputResult: null }], ["inputResult", { ...SRC, inputResult: { input: INPUT.input } }],
    ["inputResult.input", { ...SRC, inputResult: { ...INPUT, input: { ...INPUT.input, questions: undefined } } }], ["horizon", undefined]]) assert.deepEqual(G.collectGaps(broken).refusals, [{ code: "gap_source_missing", target }], target);
  const empty = { ...SRC, frameGaps: [] }; const r = G.collectGaps(empty); assert.deepEqual(r.refusals, []); assert.ok(r.gaps.length > 0 && !r.gaps.some(g => g.origins.includes("frame"))); assert.equal(G.gateGaps(r, empty).passed, true); });

test("вердикт №3 п.2: каждое известное поле производителя защищено отдельно — при потребителе прозой вид знания не меняется, при известном потребителе не меняется узел; недостающее заполняется", () => {
  const stages = load(); const [a, b] = stages.discovery.fields.preparation.unknowns; a.kind = "repository-fact"; b.consumer = HOR.nodes[0]; delete b.kind; const joined = buildOmInput(stages); assert.deepEqual(joined.refusals, []);
  const qa = `discovery:${a.id}`, qb = `discovery:${b.id}`; const before = G.collectGaps(sourcesFor(HOR, joined)).gaps; assert.ok([qa, qb].every(id => before.find(g => g.target === id).code === "question_unaddressed"), "оба вопроса адресованы не полностью");
  const bypass = G.applyAddressing(joined, [{ question: qa, consumer: HOR.nodes[0], kind: "post-implementation-proof", basis: ref(1) }], UPPER); assert.deepEqual(bypass.refusals.map(x => x.code), ["addressing_overrides_producer"], "сценарий ревью: известный вид знания не теряется");
  assert.equal(bypass.result.hash, joined.hash); assert.deepEqual(G.applyAddressing(joined, [{ question: qb, consumer: HOR.nodes[1], kind: "repository-fact", basis: ref(1) }], UPPER).refusals.map(x => x.code), ["addressing_overrides_producer"], "известный потребитель не переписывается");
  const ok = G.applyAddressing(joined, [{ question: qa, consumer: HOR.nodes[0], kind: "repository-fact", basis: ref(1) }, { question: qb, consumer: HOR.nodes[0], kind: "owner-decision", basis: ref(2) }], UPPER); assert.deepEqual(ok.refusals, []);
  const src = sourcesFor(HOR, ok.result); const after = G.collectGaps(src).gaps; assert.deepEqual([qa, qb].map(id => { const g = after.find(x => x.target === id); return [g.code, g.kind, g.blocking]; }), [["predecessor_question", "repository-fact", true], ["predecessor_question", "owner-decision", true]]);
  assert.ok(G.gateAnswers(src, []).codes.includes("answer_missing_for_blocking_gap"), "вопрос остался блокирующим: запрет отсрочки не обойдён"); });

test("вердикт №3 п.3: запоздавший проход не отменяет более позднее закрытие или отсрочку — порядок сверяется по последнему ОБРАБОТАННОМУ состоянию линии", () => {
  const gaps = live().gaps; const one = gaps.find(g => !g.deferral); const rest = gaps.filter(g => g.id !== one.id); const p1 = G.mergeLines([], gaps, 1).lines; const closed = G.mergeLines(p1, rest, 5, [{ id: one.id, reason: "filled", basis: ref(1) }]); assert.deepEqual(closed.refusals, []);
  const line = closed.lines.find(l => l.id === one.id); assert.deepEqual([line.status, line.closedPass, line.lastPass, line.statePass], ["closed", 5, 1, 5], "появлялся на проходе 1, состояние обработано на проходе 5");
  const late = G.mergeLines(closed.lines, gaps, 2); assert.deepEqual(late.refusals.map(x => x.code), ["pass_out_of_order"], "сценарий ревью: проход 2 после закрытия на проходе 5"); assert.deepEqual(late.lines, closed.lines, "закрытие и его основание сохранены");
  const away = G.mergeLines(p1, rest, 5); assert.deepEqual((({ status, scope, statePass }) => [status, scope, statePass])(away.lines.find(l => l.id === one.id)), ["deferred", "absent", 5]);
  const late2 = G.mergeLines(away.lines, gaps, 2); assert.deepEqual(late2.refusals.map(x => x.code), ["pass_out_of_order"]); assert.deepEqual(late2.lines, away.lines, "отсрочка сохранена");
  const next = G.mergeLines(closed.lines, gaps, 6).lines.find(l => l.id === one.id); assert.deepEqual([next.status, next.reopened, next.statePass, next.passes], ["open", 1, 6, 2], "законный следующий проход открывает линию заново");
  assert.deepEqual(G.mergeLines(closed.lines, rest, 5, [{ id: one.id, reason: "filled", basis: ref(1) }]).lines, closed.lines, "повтор прохода 5 ничего не меняет");
  // сценарий ревью в чистом виде — ЕДИНСТВЕННАЯ линия: соседние линии с поздним появлением отказ не подменяют
  const solo = G.mergeLines(G.mergeLines([], [one], 1).lines, [], 5, [{ id: one.id, reason: "filled", basis: ref(1) }]).lines; assert.deepEqual([solo[0].lastPass, solo[0].statePass, solo[0].status], [1, 5, "closed"]);
  const soloLate = G.mergeLines(solo, [one], 2); assert.deepEqual(soloLate.refusals.map(x => x.code), ["pass_out_of_order"]); assert.deepEqual(soloLate.lines, solo);
  const soloAway = G.mergeLines(G.mergeLines([], [one], 1).lines, [], 5).lines; const soloAwayLate = G.mergeLines(soloAway, [one], 2); assert.deepEqual([soloAwayLate.refusals.map(x => x.code), soloAwayLate.lines], [["pass_out_of_order"], soloAway]); });

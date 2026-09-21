// Тесты исполняемой спецификации M5 «пробелы». Живые стадии и верхний слой omg-live — ТОЛЬКО на чтение; уровень работ — тестовый граф garden-plus.
// Запуск: node --test PREPARATIONS/OM-DESIGN/proto/gaps.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import { DatabaseSync } from "node:sqlite"; import { homedir } from "node:os"; import { join } from "node:path";
import { projectGraph } from "../../../dist/src/graph/project.js";
import { buildOmInput } from "./input.mjs"; import { closeHorizon } from "./horizon.mjs"; import * as F from "./frame.mjs"; import * as G from "./gaps.mjs"; import { gardenPlus } from "./garden-plus.mjs";
const db = new DatabaseSync(join(homedir(), "OMG/.omg/state.sqlite"), { readOnly: true }); const head = id => db.prepare(`SELECT r.entity_id id, r.revision, r.sha256 hash, r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id=?`).get(id);
const load = () => Object.fromEntries(["discovery", "concept", "operation-map", "specification", "features"].map(st => { const r = head(`stage:omg-live:${st}`); const body = JSON.parse(r.body); const d = body.content.draft;
  const draft = d ? db.prepare(`SELECT body FROM revisions WHERE entity_id=? AND revision=?`).get(d.id, d.revision) : null; return [st, { ref: { id: r.id, revision: r.revision, hash: r.hash }, fields: body.content.fields, contractVersion: draft ? JSON.parse(draft.body).contractVersion : undefined }]; }));
const UPPER = (({ level, ...g }) => g)(JSON.parse(head("graph-layer:omg-live:1").body).projection); const UI = { block: "n-ui", reason: "сначала бэкенд (решение владельца 21.09.2026)", returnCondition: "понятно, как работает бэкенд" };
const INPUT = buildOmInput(load()); const HOR = closeHorizon(UPPER, { choiceVersion: "c1", features: [{ outcome: "autonomous-knowledge" }], excluded: [UI] }).horizon; const H = new Set(HOR.nodes);
const OB = F.frameObligations(UPPER, H); const OPEN = F.fillObligations(UPPER, OB, null, [], H, { graph: null, frame: null }).open; const FRAME_GAPS = F.openObligationsToGaps(OB, OPEN);
const live = () => G.collectGaps({ inputResult: INPUT, frameGaps: FRAME_GAPS, horizon: HOR, graph: UPPER });

test("живые данные omg-live: пробелы входа и каркаса сведены к одной записи; у каждого — потребитель в горизонте, механизм или отсрочка с моментом; ворота G4 пройдены", () => {
  const r = live(); assert.deepEqual(r.refusals, []); assert.deepEqual(G.gateGaps(r, HOR), { passed: true, codes: [], findings: [] }); assert.equal(r.gaps.length, INPUT.gaps.length + FRAME_GAPS.length + INPUT.input.questions.length);
  assert.ok(FRAME_GAPS.length > 0 && r.gaps.filter(g => g.origin === "frame").every(g => g.blocking && g.kind === "design-decision" && g.consumers.every(b => H.has(b))), "незаполненное обязательство горизонта блокирует сборку");
  const deferred = r.gaps.filter(g => g.deferral); assert.ok(deferred.length > 0, "пробелы фич вне горизонта отложены, а не потеряны"); assert.ok(deferred.every(g => !g.blocking && g.deferral.until === "horizon-entry" && g.deferral.blocks.length && !g.deferral.blocks.some(b => H.has(b))));
  const inv = r.gaps.find(g => g.code === "inventory_missing"); assert.deepEqual([inv.kind, inv.moment, inv.blocking, inv.routes], ["repository-fact", "feasibility", false, ["code", "research"]], "инвентарь нужен проверке реализуемости, сборку слоя не блокирует");
  assert.equal(new Set(r.gaps.map(g => g.id)).size, r.gaps.length); });

test("вопросы предыдущих стадий — четвёртый источник: записанный прозой сначала адресуется, адресованный становится пробелом своего вида с потребителем-блоком", () => {
  const r = live(); const qs = r.gaps.filter(g => g.origin === "question"); assert.equal(qs.length, 10); assert.ok(qs.every(g => g.code === "question_unaddressed" && g.blocking && g.mechanism && g.routes[0] === "design"), "потребитель прозой узлом не считается");
  const addressed = structuredClone(INPUT); const inside = HOR.nodes[0], outside = UPPER.nodes.find(n => n.kind === "block" && !H.has(n.id) && n.id !== "n-ui").id;
  addressed.input.questions = [{ id: "q-in", question: "?", consumer: inside, kind: "repository-fact" }, { id: "q-out", question: "?", consumer: outside, kind: "owner-decision" }, { id: "q-env", question: "?", consumer: inside, kind: "environment-confirmation" }];
  const a = G.collectGaps({ inputResult: addressed, horizon: HOR, graph: UPPER }); assert.equal(G.gateGaps(a, HOR).passed, true); const q = id => a.gaps.find(g => g.target === id);
  assert.deepEqual([q("q-in").consumers, q("q-in").routes, q("q-in").blocking], [[inside], ["code", "research"], true]); assert.deepEqual([q("q-out").blocking, q("q-out").deferral.until], [false, "horizon-entry"]);
  assert.deepEqual([q("q-env").moment, q("q-env").blocking], ["task-start", false], "подтверждение среды — на старте задачи, сборку не держит");
  addressed.input.questions = [{ id: "q-bad", question: "?", consumer: inside, kind: "сам придумал" }]; assert.equal(G.collectGaps({ inputResult: addressed, horizon: HOR, graph: UPPER }).gaps.find(g => g.target === "q-bad").code, "question_unaddressed"); });

test("горизонт меняет статус, а не состав: при другой фиче те же пробелы, отложенные становятся действующими", () => {
  const wide = closeHorizon(UPPER, { choiceVersion: "c2", features: [{ outcome: "verified-change" }], excluded: [UI] }).horizon; const a = live(); const b = G.collectGaps({ inputResult: INPUT, frameGaps: [], horizon: wide, graph: UPPER });
  const ids = r => new Set(r.gaps.filter(g => g.origin === "input").map(g => g.id)); assert.deepEqual([...ids(a)].sort(), [...ids(b)].sort());
  const woke = b.gaps.filter(g => !g.deferral && a.gaps.find(x => x.id === g.id)?.deferral); assert.ok(woke.length > 0, "блок вошёл в горизонт — его отложенные пробелы проснулись"); assert.ok(woke.every(g => g.blocking)); });

test("каркас работ: потребитель пробела — операция, горизонт — блоки; пробел привязан к блоку операции, сосед сохранён", () => {
  const g3 = gardenPlus(); const acc2 = (({ level, ...g }) => g)(projectGraph(g3, 2)); const upper = F.upperOf(acc2, 3); const zone = new Set(["garden-prep-operation", "garden-produce-operation", "garden-consume-operation"]);
  const ob = F.frameObligations(upper, zone, 3); const open = F.fillObligations(upper, ob, null, [], zone, { graph: null, frame: null }, 3).open; const hor = { nodes: ["garden-consume-block", "garden-produce-block"] };
  const r = G.collectGaps({ frameGaps: F.openObligationsToGaps(ob, open), horizon: hor, graph: acc2 }); assert.deepEqual(r.refusals, []); assert.equal(G.gateGaps(r, hor).passed, true); assert.equal(r.gaps.length, open.length);
  const end = r.gaps.find(g => g.node === "garden-produce-operation" && g.neighbors?.length); assert.deepEqual(end.consumers, ["garden-produce-block"]); assert.ok(end.neighbors.some(n => n.node === "garden-prep-operation" || n.node === "garden-consume-operation"), "в пробеле назван сосед по связи"); });

test("линия пробела: тот же target и field — тот же пробел со счётчиком проходов; исчез — закрыт; вернулся — открыт заново; порядок и новые поля линию не меняют", () => {
  const r = live(); const p1 = G.mergeLines([], r.gaps, 1); assert.ok(p1.every(l => l.passes === 1 && l.firstPass === 1)); const shuffled = [...r.gaps].reverse().map(g => ({ ...g, message: "другое время и текст" }));
  const p2 = G.mergeLines(p1, shuffled, 2); assert.equal(p2.length, p1.length); assert.ok(p2.every(l => l.passes === 2 && l.firstPass === 1)); const gone = r.gaps[0].id;
  const p3 = G.mergeLines(p2, r.gaps.slice(1), 3); assert.deepEqual([p3.find(l => l.id === gone).status, p3.find(l => l.id === gone).closedPass, p3.find(l => l.id === gone).passes], ["closed", 3, 2]);
  const p4 = G.mergeLines(p3, r.gaps, 4); assert.deepEqual([p4.find(l => l.id === gone).reopened, p4.find(l => l.id === gone).passes, p4.find(l => l.id === gone).firstPass], [1, 3, 1]); assert.notEqual(p4.find(l => l.id === gone).status, "closed"); });

test("G4, отсутствие и маскарад: неизвестный код, пробел без потребителя, дубль, подделанные id, вид, признак «блокирует» и отсрочка — типизированные отказы", () => {
  const bad = (gaps, frameGaps = []) => G.gateGaps(G.collectGaps({ inputResult: { input: INPUT.input, gaps }, frameGaps, horizon: HOR, graph: UPPER }), HOR).codes;
  assert.deepEqual(bad([{ code: "made_up_code", target: "x", consumer: { features: [] } }]), ["gap_class_unknown"]); assert.deepEqual(bad([{ code: "contract_node_unbound", target: "x", consumer: { features: [] } }]), ["gap_consumer_missing"]);
  assert.deepEqual(bad([{ code: "contract_node_unbound", target: "x", consumer: "нет-такого-узла" }]), ["gap_consumer_missing"]); assert.deepEqual(bad([], [FRAME_GAPS[0], FRAME_GAPS[0]]), ["gap_duplicate"]);
  const forge = change => { const r = live(); const g = r.gaps.find(x => x.blocking); change(g, r); return G.gateGaps(r, HOR).codes; };
  assert.deepEqual(forge(g => { g.blocking = false; }), ["gap_blocking_forged"], "блокирующий пробел не проскальзывает мимо G4b"); assert.deepEqual(forge(g => { g.id = "0".repeat(64); }), ["gap_identity_forged"]);
  assert.deepEqual(forge(g => { g.kind = "сам придумал"; }), ["gap_kind_unknown"]); assert.deepEqual(forge(g => { g.deferral = { reason: "так удобнее", until: "horizon-entry" }; }), ["deferral_without_moment"], "действующий пробел отложить нельзя");
  assert.deepEqual(forge((g, r) => { const d = r.gaps.find(x => x.deferral); delete d.deferral; }), ["gap_outside_horizon"]); assert.deepEqual(forge((g, r) => { r.gaps.find(x => x.deferral).deferral.until = ""; }), ["deferral_without_moment"]); });

test("G4b: у каждого блокирующего пробела — один результат законным маршрутом, для текущей версии входа, с точной ссылкой или отсрочкой с моментом", () => {
  const gaps = live().gaps; const blocking = gaps.filter(g => g.blocking); const ref = i => ({ id: `om-answer:${i}`, revision: 1, hash: "a".repeat(64) }); const all = blocking.map((g, i) => ({ gap: g.id, route: g.routes[0], inputHash: INPUT.hash, answerRef: ref(i) }));
  assert.deepEqual(G.gateAnswers(gaps, all, INPUT.hash), { passed: true, codes: [], findings: [] }); assert.deepEqual(G.gateAnswers(gaps, all.slice(1), INPUT.hash).codes, ["answer_missing_for_blocking_gap"]);
  assert.deepEqual(G.gateAnswers(gaps, all, "другая версия входа").codes, ["answer_version_stale"]); const swap = change => all.map((r, i) => (i === 0 ? change({ ...r }) : r));
  assert.deepEqual(G.gateAnswers(gaps, swap(r => ({ ...r, route: "code" })), INPUT.hash).codes, ["answer_route_foreign"], "проектное решение нельзя объявить фактом репозитория");
  assert.deepEqual(G.gateAnswers(gaps, swap(r => ({ ...r, answerRef: { id: "x" } })), INPUT.hash).codes, ["route_result_missing"]); assert.deepEqual(G.gateAnswers(gaps, swap(r => ({ gap: r.gap, route: r.route, inputHash: r.inputHash, deferral: { until: "" } })), INPUT.hash).codes, ["deferral_without_moment"]);
  assert.deepEqual(G.gateAnswers(gaps, swap(r => ({ gap: r.gap, route: r.route, inputHash: r.inputHash, deferral: { until: "task-start" } })), INPUT.hash).passed, true);
  assert.deepEqual(G.gateAnswers(gaps, [...all, all[0]], INPUT.hash).codes, ["answer_duplicate"]); assert.deepEqual(G.gateAnswers(gaps, [...all, { ...all[0], gap: "f".repeat(64) }], INPUT.hash).codes, ["answer_gap_unknown"]);
  const calm = gaps.filter(g => !g.blocking); assert.equal(G.gateAnswers(calm, [], INPUT.hash).passed, true, "неблокирующие и отложенные пробелы готовности сборки не держат"); });

#!/usr/bin/env node
// export-map.mjs — выгрузка карты OMG из КОПИИ базы в data/map.json (только чтение).
//
// Запуск:  node export-map.mjs [путь-к-копии] [путь-к-map.json]
// По умолчанию: ./state-copy.sqlite → ./data/map.json
//
// Копия снимается так (единственный разрешённый способ):
//   sqlite3 "file:$HOME/OMG/.omg/state.sqlite?mode=ro" ".backup './state-copy.sqlite'"
//
// Читаем прямым SQL через node:sqlite (без Store/ProductEngine — они делают migrate).
// Тяжёлое (research-context, тексты промптов/ответов, source) не выгружаем.

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(process.argv[2] ?? join(here, 'state-copy.sqlite'));
const outPath = resolve(process.argv[3] ?? join(here, 'data', 'map.json'));
const P = 'omg-live';

if (/\/\.omg\/state\.sqlite$/.test(dbPath) || dbPath.includes('/live-source/')) {
  console.error('Отказ: живую базу открывать нельзя — только копию через .backup в режиме mode=ro.');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const headBody = (id) => {
  const r = all(`SELECT r.body b, h.revision rev FROM heads h JOIN revisions r ON r.entity_id=h.entity_id AND r.revision=h.revision WHERE h.entity_id=?`, id)[0];
  return r ? { rev: r.rev, body: JSON.parse(r.b) } : null;
};
const revBody = (id, rev) => JSON.parse(all(`SELECT body b FROM revisions WHERE entity_id=? AND revision=?`, id, rev)[0].b);
const headsOfKind = (kind) => all(`SELECT h.entity_id id, h.revision rev, r.body b FROM heads h JOIN revisions r ON r.entity_id=h.entity_id AND r.revision=h.revision WHERE r.kind=?`, kind)
  .map(r => ({ id: r.id, rev: r.rev, body: JSON.parse(r.b) }));

// ───────────────────────── 1. Лента событий + якоря времени ─────────────────────────
// Тело берём только у видов, которые нужны для якорей/вех; остальное — NULL (экономим память).
const LIGHT = ['model-call', 'discovery-draft', 'research-run', 'stage', 'question', 'phase', 'research-scope', 'graph', 'graph-layer', 'map-status', 'research-budget', 'phase-policy', 'graph-binding'];
const evRows = all(`SELECT e.sequence s, e.entity_id id, e.revision rev, r.kind kind,
  CASE WHEN r.kind IN (${LIGHT.map(() => '?').join(',')}) THEN r.body ELSE NULL END AS body
  FROM events e JOIN revisions r ON r.entity_id=e.entity_id AND r.revision=e.revision ORDER BY e.sequence`, ...LIGHT);
const N = evRows.length;
for (let i = 0; i < N; i++) if (evRows[i].s !== i + 1) throw new Error(`events.sequence не сплошная: позиция ${i} → ${evRows[i].s}`);
const ev = evRows.map(r => ({ s: r.s, id: r.id, rev: r.rev, kind: r.kind, body: r.body ? JSON.parse(r.body) : null }));

// Якоря: discovery-draft.createdAt только у rev1 (у поздних ревизий тот же createdAt — они не якоря);
// model-call: rev1 → startedAt; поздние ревизии → finishedAt, иначе runtime.startedAt.
const rawAnchors = [];
for (const e of ev) {
  let t = null, field = null;
  if (e.kind === 'discovery-draft' && e.rev === 1 && e.body?.createdAt) { t = e.body.createdAt; field = 'createdAt'; }
  else if (e.kind === 'model-call' && e.body) {
    if (e.rev === 1 && e.body.startedAt) { t = e.body.startedAt; field = 'startedAt'; }
    else if (e.body.finishedAt) { t = e.body.finishedAt; field = 'finishedAt'; }
    else if (e.body.runtime?.startedAt) { t = e.body.runtime.startedAt; field = 'runtime.startedAt'; }
  }
  if (t) rawAnchors.push({ s: e.s, t, field, kind: e.kind });
}
const anchors = []; let droppedAnchors = 0;
for (const a of rawAnchors) { if (!anchors.length || a.t >= anchors[anchors.length - 1].t) anchors.push(a); else droppedAnchors++; }
if (anchors.length < 2) throw new Error('Мало якорей времени');

// Интерполяция по sequence между соседними якорями; до первого/после последнего — время крайнего якоря.
const anchorBySeq = new Map(anchors.map(a => [a.s, a]));
const tOf = new Array(N + 1); const exactOf = new Array(N + 1);
{
  let ai = 0;
  for (let s = 1; s <= N; s++) {
    const a = anchorBySeq.get(s);
    if (a) { tOf[s] = a.t; exactOf[s] = 1; continue; }
    while (ai < anchors.length - 1 && anchors[ai + 1].s < s) ai++;
    const a0 = anchors[ai], a1 = anchors[ai + 1];
    if (s < anchors[0].s) { tOf[s] = anchors[0].t; exactOf[s] = 0; }
    else if (!a1 || s > anchors[anchors.length - 1].s) { tOf[s] = anchors[anchors.length - 1].t; exactOf[s] = 0; }
    else { tOf[s] = Math.round(a0.t + (a1.t - a0.t) * (s - a0.s) / (a1.s - a0.s)); exactOf[s] = 0; }
  }
}
// Паузы > 1 ч между соседними якорями: время событий внутри — заведомо приблизительное.
const pauses = [];
for (let i = 1; i < anchors.length; i++) {
  const d = anchors[i].t - anchors[i - 1].t;
  if (d > 3600e3) pauses.push({ fromSeq: anchors[i - 1].s, toSeq: anchors[i].s, fromT: anchors[i - 1].t, toT: anchors[i].t, hours: +(d / 3600e3).toFixed(1) });
}

// Короткие id сущностей для ленты: kind:<8 знаков хэша/uuid> (полные id — в своих разделах).
const shortId = (id) => {
  const i = id.indexOf(':'); if (i < 0) return id;
  const rest = id.slice(i + 1).replace(/^omg-live:/, '');
  return id.slice(0, i) + ':' + (rest.length > 24 ? rest.slice(0, 8) : rest);
};
const kinds = []; const kindIdx = new Map();
const entities = []; const entIdx = new Map();
const events = ev.map(e => {
  if (!kindIdx.has(e.kind)) { kindIdx.set(e.kind, kinds.length); kinds.push(e.kind); }
  const sid = shortId(e.id);
  if (!entIdx.has(e.id)) { entIdx.set(e.id, entities.length); entities.push(sid); }
  return [kindIdx.get(e.kind), entIdx.get(e.id), e.rev, tOf[e.s], exactOf[e.s]];
});
const seqOfHead = new Map(); // id → seq последней ревизии
for (const e of ev) seqOfHead.set(e.id, e.s);
const seqOfRev = (id, rev) => ev.find(e => e.id === id && e.rev === rev)?.s ?? null;

// ───────────────────────── 2. Граф r1 / r2 ─────────────────────────
const graphRevs = all(`SELECT revision rev FROM revisions WHERE entity_id=? ORDER BY revision`, `graph:${P}`).map(r => r.rev);
const packGraph = (g, rev, full) => {
  const nodes = g.nodes.map(n => full ? {
    id: n.id, kind: n.kind, parent: n.parent, title: n.title, purpose: n.purpose, benefit: n.benefit, outcome: n.outcome,
    beneficiary: n.beneficiary, boundary: n.boundary, implements: n.implements ?? [], tests: n.tests ?? [], code: n.code ?? [], ports: n.ports ?? [],
  } : { id: n.id, kind: n.kind, parent: n.parent, title: n.title, ports: n.ports ?? [] });
  const edges = g.edges.map(e => full ? { id: e.id, source: e.source, target: e.target, relation: e.relation, condition: e.condition } : { id: e.id, source: e.source, target: e.target, relation: e.relation });
  const out = { revision: rev, seq: seqOfRev(`graph:${P}`, rev), title: g.title, version: g.version, nodes, edges,
    counts: { nodes: nodes.length, byKind: count(nodes, n => n.kind), edges: edges.length, byRelation: count(edges, e => e.relation) } };
  if (full) {
    out.connectors = (g.connectors ?? []).map(c => ({ id: c.id, artifact: c.artifact, returnsTo: c.returnsTo ?? null, bindings: (c.bindings ?? []).map(b => ({ level: b.level, producer: b.producer, consumers: b.consumers })) }));
    out.contracts = Object.fromEntries((g.contracts ?? []).map(c => [c.id, { description: c.schema?.description ?? null, required: c.schema?.required ?? [], properties: Object.keys(c.schema?.properties ?? {}) }]));
    out.requirements = Object.fromEntries((g.requirements ?? []).map(r => [r.id, { statement: r.statement, section: r.section, outcome: r.outcome, beneficiary: r.beneficiary }]));
    out.tests = Object.fromEntries((g.tests ?? []).map(t => [t.id, { node: t.node, covers: t.covers ?? [], obligations: t.obligations ?? [], command: t.command ? [t.command.executable, ...(t.command.args ?? [])].join(' ') : null, when: t.contract?.when ?? null, entrypoint: t.contract?.entrypoint ?? null }]));
    out.artifacts = Object.fromEntries((g.artifacts ?? []).map(a => [a.id, { kind: a.kind, contract: a.contract, purpose: a.purpose, durability: a.durability, external: a.external, terminal: a.terminal }]));
    out.actors = g.actors ?? [];
    out.journeys = (g.journeys ?? []).map(j => ({ id: j.id, actor: j.actor, variant: j.variant, entry: j.entry, terminal: j.terminal, path: j.path }));
  }
  return out;
};
function count(arr, f) { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; }
const graphs = {};
for (const rev of graphRevs) graphs[`r${rev}`] = packGraph(revBody(`graph:${P}`, rev), rev, rev === graphRevs[graphRevs.length - 1]);
const gLast = graphs[`r${graphRevs[graphRevs.length - 1]}`];

// ───────────────────────── 3. Черновики, вопросы, прогоны ─────────────────────────
const drafts = headsOfKind('discovery-draft').filter(d => d.body.projectId === P).map(d => ({
  id: d.id, rev: d.rev, level: d.body.level, stage: d.body.stage, consumer: d.body.consumer, createdAt: d.body.createdAt,
  seqFirst: seqOfRev(d.id, 1), seqLast: seqOfHead.get(d.id), questions: d.body.questions ?? [],
}));
const draftById = new Map(drafts.map(d => [d.id, d]));

const runs = headsOfKind('research-run').filter(r => r.body.projectId === P).map(r => {
  const pausedSeq = ev.find(e => e.id === r.id && e.body?.status === 'paused')?.s ?? null;
  const d = draftById.get(r.body.draftId);
  return { id: r.id, draftId: r.body.draftId, level: d?.level ?? null, status: r.body.status, turns: r.body.turns, limit: r.body.limit, error: r.body.error ?? null, seqFirst: seqOfRev(r.id, 1), seqLast: seqOfHead.get(r.id), pausedSeq };
});

const questions = headsOfKind('question').filter(q => q.body.projectId === P).map(q => {
  const targets = [...new Set((q.body.spec?.targets ?? []).map(t => typeof t === 'string' ? t : t.target).filter(Boolean))];
  const answeredSeq = ev.find(e => e.id === q.id && e.body?.status === 'answered')?.s ?? null;
  return { id: q.id, level: q.body.level, stage: q.body.stage, status: q.body.status, kind: q.body.spec?.kind ?? null, field: q.body.spec?.field ?? null,
    prompt: q.body.spec?.prompt ?? null, risk: q.body.spec?.risk ?? null, consumer: q.body.consumer, draftId: q.body.draftId, targets,
    obligations: (q.body.spec?.obligations ?? []).map(o => o.id ?? o), seqFirst: seqOfRev(q.id, 1), answeredSeq, answerId: q.body.answer?.id ?? null };
});

// ───────────────────────── 4. Расход model-call ─────────────────────────
const callHeads = headsOfKind('model-call').filter(c => c.body.projectId === P);
const calls = callHeads.map(c => {
  const b = c.body; const d = draftById.get(b.draftId);
  const evs = ev.filter(e => e.id === c.id);
  const seqStart = evs[0]?.s ?? null;
  const seqEnd = evs.find(e => e.body?.finishedAt)?.s ?? evs[evs.length - 1]?.s ?? null;
  return { id: c.id.replace('model-call:', ''), level: d?.level ?? '?', draftId: b.draftId, questionId: b.questionId ?? null, purpose: b.purpose, model: b.requested?.model ?? null,
    status: b.status, startedAt: b.startedAt ?? null, finishedAt: b.finishedAt ?? null, seqStart, seqEnd,
    inputTokens: b.usage?.inputTokens ?? 0, outputTokens: b.usage?.outputTokens ?? 0, cachedInputTokens: b.usage?.cachedInputTokens ?? 0, reasoningOutputTokens: b.usage?.reasoningOutputTokens ?? 0 };
});
const agg = (list) => {
  const a = { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, failed: 0, first: null, last: null };
  for (const c of list) { a.calls++; a.inputTokens += c.inputTokens; a.outputTokens += c.outputTokens; a.cachedInputTokens += c.cachedInputTokens; a.reasoningOutputTokens += c.reasoningOutputTokens; if (c.status === 'failed') a.failed++;
    if (c.startedAt && (a.first === null || c.startedAt < a.first)) a.first = c.startedAt; const end = c.finishedAt ?? c.startedAt; if (end && (a.last === null || end > a.last)) a.last = end; }
  a.tokens = a.inputTokens + a.outputTokens; return a;
};
const group = (list, f) => { const m = {}; for (const c of list) (m[f(c)] ??= []).push(c); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, agg(v)])); };
const spend = { total: agg(calls), byLevel: group(calls, c => c.level), byPurpose: group(calls, c => c.purpose), byModel: group(calls, c => c.model),
  byDraft: Object.entries(group(calls, c => c.draftId)).map(([draftId, a]) => ({ draftId, level: draftById.get(draftId)?.level ?? '?', stage: draftById.get(draftId)?.stage ?? '?', ...a })), calls };

// ───────────────────────── 5. Лестница ─────────────────────────
const STAGES = ['discovery', 'concept', 'operation-map', 'specification', 'features'];
const stages = STAGES.map(st => {
  const id = `stage:${P}:${st}`; const h = headBody(id);
  const revisions = ev.filter(e => e.id === id).map(e => ({ rev: e.rev, seq: e.s, status: e.body?.status ?? null, at: tOf[e.s] }));
  return { id, stage: st, status: h?.body?.status ?? 'none', draftId: h?.body?.content?.draft?.id ?? null, revisions, acceptedSeq: revisions.find(r => r.status === 'accepted')?.seq ?? null, draftSeq: revisions[0]?.seq ?? null };
});
const phases = ['R0', 'L1', 'R1', 'L2'].map(ph => {
  const id = `phase:${P}:${ph}`; const h = headBody(id);
  return h ? { id, phase: ph, seq: seqOfRev(id, 1), at: tOf[seqOfRev(id, 1)], draftId: h.body.draft?.id ?? null, layerId: h.body.layer?.id ?? null, inputs: (h.body.inputs ?? []).length } : { id, phase: ph, seq: null };
});
const scopeHead = headBody(`research-scope:${P}:R2`);
const scope = scopeHead ? {
  id: `research-scope:${P}:R2`, revision: scopeHead.rev, revisions: ev.filter(e => e.id === `research-scope:${P}:R2`).map(e => ({ rev: e.rev, seq: e.s, at: tOf[e.s] })),
  nodes: scopeHead.body.nodes ?? [], boundaries: (scopeHead.body.boundaries ?? []).map(b => ({ node: b.node, reason: b.reason })), outcome: scopeHead.body.outcome ?? null, uiRequired: scopeHead.body.uiRequired ?? null,
  obligations: (scopeHead.body.obligations ?? []).map(o => ({ id: o.gap.id, target: o.gap.target, consumer: o.gap.consumer, field: o.gap.field, requiredFor: o.gap.requiredFor, state: o.state, question: o.gap.question, reason: o.reason })),
  policy: scopeHead.body.policy ? { version: scopeHead.body.policy.version, assignments: scopeHead.body.policy.assignments.map(a => ({ obligation: a.obligation, kind: a.kind, moment: a.moment, neededForR2: a.neededForR2, responsibleNode: a.responsibleNode, responsibleConsumer: a.responsibleConsumer })) } : null,
  runs: runs.filter(r => r.level === 'R2'),
} : null;
const budgets = headsOfKind('research-budget').filter(b => b.body.projectId === P).map(b => ({ id: b.id, key: b.body.key, limit: b.body.limit, initialGroupLimit: b.body.initialGroupLimit ?? null, ownerGroupCeiling: b.body.ownerGroupCeiling ?? null, seq: seqOfRev(b.id, 1), at: tOf[seqOfRev(b.id, 1)] }));
const policyHead = headBody(`phase-policy:${P}`);
const layer3 = headBody(`graph-layer:${P}:3`);
const omKinds = all(`SELECT r.kind kind, count(*) n FROM heads h JOIN revisions r ON r.entity_id=h.entity_id AND r.revision=h.revision WHERE r.kind LIKE 'om-%' OR r.kind IN ('task','task-run','repair-series','horizon','block-weight') OR h.entity_id LIKE 'om-%' OR h.entity_id LIKE 'task:%' GROUP BY r.kind`);

const runsFor = (lvl) => runs.filter(r => r.level === lvl);
const stepStatus = (s) => ({ accepted: 'принята', paused: 'на паузе', none: 'не начата', draft: 'в работе' }[s] ?? s);
const ladder = [
  { id: 'L0', title: 'L0 · стадии продукта', status: stages.every(s => s.status === 'accepted') ? 'accepted' : stages.some(s => s.status !== 'none') ? 'draft' : 'none',
    seq: stages.map(s => s.acceptedSeq).filter(Boolean).sort((a, b) => b - a)[0] ?? null, seqFirst: stages.map(s => s.draftSeq).filter(Boolean).sort((a, b) => a - b)[0] ?? null,
    detail: `${stages.filter(s => s.status === 'accepted').length}/${STAGES.length} стадий приняты: ${STAGES.join(' → ')}`, spend: agg([]), turns: 0 },
  { id: 'R0', title: 'R0 · исследование', status: phases[0].seq ? 'accepted' : 'none', seq: phases[0].seq, seqFirst: drafts.find(d => d.level === 'R0')?.seqFirst ?? null,
    detail: `Фаза ${phases[0].id}; вызовов model-call не записано — исследование R0 шло через research-run`, spend: spend.byLevel.R0 ?? agg([]), turns: runsFor('R0').reduce((s, r) => s + (r.turns ?? 0), 0) },
  { id: 'L1', title: 'L1 · карта блоков', status: phases[1].seq ? 'accepted' : 'none', seq: phases[1].seq, seqFirst: graphs.r1?.seq ?? null,
    detail: `Граф r1: ${graphs.r1?.counts.nodes ?? 0} узлов, ${graphs.r1?.counts.edges ?? 0} рёбер; фаза ${phases[1].id}`, spend: agg([]), turns: 0 },
  { id: 'R1', title: 'R1 · исследование блоков', status: phases[2].seq ? 'accepted' : 'none', seq: phases[2].seq, seqFirst: drafts.find(d => d.level === 'R1')?.seqFirst ?? null,
    detail: `Черновики R1: ${drafts.filter(d => d.level === 'R1').length}; фаза ${phases[2].id}`, spend: spend.byLevel.R1 ?? agg([]), turns: runsFor('R1').reduce((s, r) => s + (r.turns ?? 0), 0) },
  { id: 'L2', title: 'L2 · операции', status: phases[3].seq ? 'accepted' : 'none', seq: phases[3].seq, seqFirst: gLast.seq,
    detail: `Граф r${gLast.revision}: ${gLast.counts.nodes} узлов (${gLast.counts.byKind.operation ?? 0} операций), ${gLast.counts.edges} рёбер; фаза ${phases[3].id}`, spend: agg([]), turns: 0 },
  { id: 'R2', title: 'R2 · исследование операций', status: scope ? (scope.runs.some(r => r.status === 'paused') && !scope.runs.some(r => r.status === 'running') ? 'paused' : 'draft') : 'none',
    seq: scope ? scope.runs.map(r => r.pausedSeq).filter(Boolean).sort((a, b) => b - a)[0] ?? scope.revisions[scope.revisions.length - 1].seq : null, seqFirst: scope?.revisions[0]?.seq ?? null,
    detail: scope ? `Область R2: ${scope.nodes.length} узлов + ${scope.boundaries.length} граничных, ${scope.obligations.length} обязательств; прогонов на паузе: ${scope.runs.filter(r => r.status === 'paused').length}` : 'нет записи', spend: spend.byLevel.R2 ?? agg([]), turns: runsFor('R2').reduce((s, r) => s + (r.turns ?? 0), 0) },
  { id: 'L3', title: 'L3 · атомарные работы', status: 'none', seq: null, seqFirst: null, detail: layer3 ? `Не начата (graph-layer:3 — лишь проекция уровня 3, horizon пуст)` : 'Не начата', spend: agg([]), turns: 0 },
  { id: 'R3', title: 'R3 · исследование работ', status: 'none', seq: null, seqFirst: null, detail: 'Не начата', spend: agg([]), turns: 0 },
  { id: 'EXEC', title: 'Исполнение', status: 'none', seq: null, seqFirst: null, detail: `Не начато (записей OM: ${omKinds.reduce((s, k) => s + k.n, 0)})`, spend: agg([]), turns: 0 },
].map(s => ({ ...s, statusLabel: stepStatus(s.status), at: s.seq ? tOf[s.seq] : null, atFirst: s.seqFirst ? tOf[s.seqFirst] : null }));

// ───────────────────────── 6. Аннотации узлов ─────────────────────────
const ms = headBody(`map-status:${P}`);
const nodeAnnotations = {};
const ann = (id) => (nodeAnnotations[id] ??= { mapStatus: null, mapExplanation: null, code: [], scopeRole: null, obligations: [], questions: [] });
for (const n of ms?.body?.nodes ?? []) { const a = ann(n.id); a.mapStatus = n.status; a.mapExplanation = n.explanation; a.code = n.code ?? []; }
for (const id of scope?.nodes ?? []) ann(id).scopeRole = 'scope';
for (const b of scope?.boundaries ?? []) ann(b.node).scopeRole = ann(b.node).scopeRole ?? 'boundary';
for (const o of scope?.obligations ?? []) ann(o.target).obligations.push(o.id);
for (const q of questions) for (const t of q.targets) ann(t).questions.push(q.id);
const mapStatus = ms ? { id: `map-status:${P}`, seq: seqOfRev(`map-status:${P}`, 1), at: tOf[seqOfRev(`map-status:${P}`, 1)], actor: ms.body.actor, base: ms.body.base, nodes: ms.body.nodes.length } : null;

// ───────────────────────── 7. Вехи для проигрывания ─────────────────────────
const milestones = [];
const push = (seq, kind, label) => { if (seq) milestones.push({ seq, at: tOf[seq], kind, label }); };
push(seqOfRev(`project:${P}`, 1), 'project', 'Проект omg-live создан');
for (const s of stages) for (const r of s.revisions) push(r.seq, r.status === 'accepted' ? 'stage-accepted' : 'stage-draft', `Стадия ${s.stage}: ${r.status === 'accepted' ? 'принята' : 'черновик'}${r.rev > 1 ? ` (rev ${r.rev})` : ''}`);
for (const [k, g] of Object.entries(graphs)) push(g.seq, 'graph', `Граф ${k}: ${g.counts.nodes} узлов, ${g.counts.edges} рёбер`);
for (const p of phases) push(p.seq, 'phase', `Фаза ${p.phase} записана`);
for (const d of drafts.filter(d => d.level !== 'R0' || d.id.startsWith('derived'))) push(d.seqFirst, 'draft', `Черновик ${d.level} ${d.stage}: ${d.id.split(':').pop().slice(0, 8)}`);
if (scope) { for (const r of scope.revisions) push(r.seq, 'scope', `Область R2 rev ${r.rev}`); for (const r of scope.runs) push(r.pausedSeq, 'paused', `Прогон R2 ${r.id.split(':').pop().slice(0, 8)} на паузе: ${r.error ?? ''}`); }
push(mapStatus?.seq, 'map-status', `map-status: ${mapStatus?.nodes ?? 0} узлов размечены`);
for (const b of budgets) push(b.seq, 'budget', `Бюджет ${b.key}: ${b.limit.toLocaleString('ru-RU')} токенов`);
milestones.sort((a, b) => a.seq - b.seq);

// ───────────────────────── 8. Сборка и запись ─────────────────────────
const project = headBody(`project:${P}`);
const map = {
  meta: {
    generatedAt: Date.now(), generatedAtIso: new Date().toISOString(), source: 'копия state.sqlite (.backup, mode=ro)', dbBytes: statSync(dbPath).size,
    projectId: P, projectTitle: project?.body?.title ?? P, timezone: 'В базе время UTC (epoch ms); показывать по Москве (Europe/Moscow).',
    events: N, heads: all(`SELECT count(*) n FROM heads`)[0].n, revisions: all(`SELECT count(*) n FROM revisions`)[0].n,
    anchors: anchors.length, anchorsDropped: droppedAnchors, anchorsRaw: rawAnchors.length,
    timeNote: 'Время событий восстановлено интерполяцией по якорям (model-call.startedAt/finishedAt, discovery-draft.createdAt rev1); у не-якорных событий оно приблизительное, внутри пауз > 1 ч — заведомо приблизительное.',
    firstAt: tOf[1], lastAt: tOf[N],
  },
  graphs, ladder, stages, phases, scope, budgets, policy: policyHead ? { stopAfter: policyHead.body.stopAfter, budgetSegment: policyHead.body.budgetSegment, rev: policyHead.rev } : null,
  spend, drafts, runs, questions, nodeAnnotations, mapStatus,
  events: { kinds, entities, rows: events, pauses, anchors: anchors.map(a => [a.s, a.t]) },
  milestones,
  om: { note: 'OM ещё не запускался', counts: Object.fromEntries(omKinds.map(k => [k.kind, k.n])), total: omKinds.reduce((s, k) => s + k.n, 0),
    legend: [
      { entity: 'Проход', records: 'om-run:<p>', statuses: ['ready', 'step', 'waiting', 'complete'] },
      { entity: 'Основания', records: 'om-input, horizon, om-horizon, block-weight, om-routes', statuses: ['accepted', 'refused', 'needed', 'available', 'pending', 'deferred', 'answered'] },
      { entity: 'Блок (серия)', records: 'repair-series:<p>:<line>:<block>', statuses: ['попытка идёт', 'result', 'refused', 'off-form', 'interrupted', 'awaiting-owner'] },
      { entity: 'Пробел', records: 'om-gap:<p>:<hash>, om-gap-lines', statuses: ['open', 'deferred', 'closed'] },
      { entity: 'Операции / работы', records: 'om-frame:<p>:2, om-frame:<p>:3', statuses: ['accepted', 'rejected', 'unchanged', 'obsolete'] },
      { entity: 'Атомарная работа (L3)', records: 'om-atomic-gate, om-works-acceptance', statuses: ['прошла', 'не прошла'] },
      { entity: 'Реализуемость (M8)', records: 'om-feasibility:<p>', statuses: ['ready', 'findings'] },
      { entity: 'Передача компилятору (M9)', records: 'stage:<p>:om-g2', statuses: ['draft', 'accepted'] },
      { entity: 'Задачи', records: 'task:<hash40>, task-run', statuses: ['компиляция', 'очередь', 'выполнение', 'готово', 'отказ'] },
      { entity: 'Деньги', records: 'ведомость E1, model-call', statuses: ['по блоку', 'по пробелу', 'по серии', 'по попытке'] },
    ] },
};
mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(map);
writeFileSync(outPath, json);
db.close();

const kb = (n) => (n / 1024).toFixed(0) + ' КБ';
console.log(`map.json: ${kb(json.length)} → ${outPath}`);
console.log(`граф: ${Object.entries(graphs).map(([k, g]) => `${k} ${g.counts.nodes} узлов/${g.counts.edges} рёбер`).join(', ')}`);
console.log(`лестница: ${ladder.map(s => `${s.id}=${s.statusLabel}`).join(', ')}`);
console.log(`расход: ${spend.total.calls} вызовов, ${spend.total.tokens.toLocaleString('ru-RU')} токенов; по уровням: ${Object.entries(spend.byLevel).map(([k, a]) => `${k} ${a.calls}/${a.tokens.toLocaleString('ru-RU')}`).join(', ')}`);
console.log(`вопросы: ${questions.length} (open ${questions.filter(q => q.status === 'open').length}, answered ${questions.filter(q => q.status === 'answered').length}); с целями-узлами: ${questions.filter(q => q.targets.length).length}`);
console.log(`R2: ${scope ? `${scope.nodes.length} узлов + ${scope.boundaries.length} границ, ${scope.obligations.length} обязательств, прогонов ${scope.runs.length} (${scope.runs.map(r => r.status).join('/')})` : 'нет'}`);
console.log(`события: ${N}; якорей ${anchors.length} (сырых ${rawAnchors.length}, отброшено немонотонных ${droppedAnchors}); пауз > 1 ч: ${pauses.length}; вех: ${milestones.length}`);
console.log(`OM: записей ${map.om.total}`);
const sizes = Object.entries(map).map(([k, v]) => [k, JSON.stringify(v).length]).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('крупнейшие разделы: ' + sizes.map(([k, n]) => `${k}=${kb(n)}`).join(', '));

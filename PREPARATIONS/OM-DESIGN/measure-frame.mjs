// Измерение каркаса связей на живом графе (только чтение .omg/state.sqlite): гнёзда от связей блоков и их заполнение операциями.
// Использование: node measure-frame.mjs   — результат 21.09.2026 на omg-live r2: 79 гнёзд, заполнено 79.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.HOME + '/OMG/.omg/state.sqlite', { readOnly: true });
const ids = db.prepare(`SELECT h.entity_id id FROM heads h WHERE h.entity_id LIKE 'graph%omg-live%' OR h.entity_id LIKE 'stage:omg-live:%'`).all().map(r => r.id);
console.log('записи:', ids.join(', '));
const get = id => { const r = db.prepare(`SELECT r.body FROM revisions r JOIN heads h ON h.entity_id=r.entity_id AND h.revision=r.revision WHERE r.entity_id=?`).get(id); return r ? JSON.parse(r.body) : null; };
const dig = (o, key) => { if (!o || typeof o !== 'object') return undefined; if (key in o && o[key] && typeof o[key] === 'object') return o[key]; for (const v of Object.values(o)) { const f = dig(v, key); if (f !== undefined) return f; } };
const gid = ids.find(i => i === 'graph:omg-live') || ids.find(i => i.startsWith('graph:'));
const G = get(gid); const graph = G.nodes ? G : (dig(G, 'graph') || dig(G, 'projection') || G);
const nodes = graph.nodes, conns = graph.connectors; const byId = new Map(nodes.map(n => [n.id, n]));
const kinds = nodes.reduce((m, n) => (m[n.kind] = (m[n.kind] || 0) + 1, m), {});
console.log(`граф ${gid}: узлы`, kinds, `| коннекторов ${conns.length} | управляющих рёбер ${(graph.edges || []).length}`);
// гнёзда: каждый конец привязки L1 обязан иметь внизу конкретную операцию в том же блоке
let slots = 0, filled = 0; const open = [];
for (const c of conns) { const l1 = c.bindings.filter(b => b.level === 1), l2 = c.bindings.filter(b => b.level === 2);
  for (const b of l1) for (const [role, ep] of [['производитель', b.producer], ...b.consumers.map(e => ['потребитель', e])]) { slots++;
    const ok = l2.some(x => (role === 'производитель' ? [x.producer] : x.consumers).some(e => byId.get(e.node)?.parent === ep.node));
    if (ok) filled++; else open.push(`${c.id}: ${role} в блоке ${ep.node} (артефакт ${c.artifact})`); } }
console.log(`гнёзд от связей блоков: ${slots} | заполнено конкретной операцией: ${filled} | пусто: ${slots - filled}`);
open.slice(0, 8).forEach(x => console.log('   пусто →', x));
const onlyL2 = conns.filter(c => !c.bindings.some(b => b.level === 1) && c.bindings.some(b => b.level === 2)).length;
console.log(`связей, живущих только с уровня 2 (внутри блоков или между операциями): ${onlyL2}`);
// контракт ↔ операция через общую цепочку требований
const spec = get('stage:omg-live:specification'); const bcs = dig(spec, 'behaviorContracts');
const ops = nodes.filter(n => n.kind === 'operation'); let opNo = 0, multi = 0; const bcHit = new Set();
for (const o of ops) { const m = bcs.filter(c => (c.requirements || []).some(r => (o.implements || []).includes(r))); if (!m.length) opNo++; if (m.length > 1) multi++; m.forEach(c => bcHit.add(c.id)); }
console.log(`операций ${ops.length}: без единого контракта по общим требованиям — ${opNo}, с несколькими контрактами — ${multi}; контрактов без операции — ${bcs.length - bcHit.size} из ${bcs.length}`);
const blocksWithOps = new Set(ops.map(o => o.parent)); console.log(`блоков с раскрытием на операции: ${blocksWithOps.size} из ${nodes.filter(n => n.kind === 'block').length}`);

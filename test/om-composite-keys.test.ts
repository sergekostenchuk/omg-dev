import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, compareKeys, compositeKey, hashJson } from '../src/canonical.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { LEVEL } from '../src/graph/model.js';
import { acceptedLevelOf } from '../src/om/obligations.js';
import { QUEUE_POLICY_VERSION, computeBlockWeights, type QueuePolicy } from '../src/om/queue.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import type { OmResult } from '../src/om/refusal.js';
import {
  SOURCE_ORDER, UNIT_REFUSAL_KIND, classifyRefusal, readJournalAt, recordRefusal, unitRefusalNamespace,
} from '../src/om/refusal-journal.js';
import { gardenGraph } from './om-fixture.js';

// Q3 (№2549): a composite key of a canonical order is the canonical tuple of its parts, ordered by code units; the
// maximum of a possibly empty set is an explicit refusal, never -Infinity cast to a level.

test('Q3 compositeKey is unambiguous where a separator-joined key is not, and keeps a fixed arity', () => {
  // Two different tuples that a space or NUL join cannot tell apart.
  assert.equal(['a b', 'c'].join(' '), ['a', 'b c'].join(' '));
  assert.notEqual(compositeKey(['a b', 'c']), compositeKey(['a', 'b c']));
  assert.equal(['a\0b', 'c'].join('\0'), ['a', 'b\0c'].join('\0'));
  assert.notEqual(compositeKey(['a\0b', 'c']), compositeKey(['a', 'b\0c']));
  // Numbers stay numbers and strings stay strings: the revision 1 is not the id "1".
  assert.notEqual(compositeKey(['x', 1]), compositeKey(['x', '1']));
  // An absent part is null in its place; a shorter tuple would sort elsewhere.
  assert.equal(compositeKey(['role', 'id', 1, 'h', null]), '["role","id",1,"h",null]');
  assert.ok(compareKeys(compositeKey(['r', 'id', 1, 'h', null]), compositeKey(['r', 'id', 1, 'h', { kind: 'frame' }])) < 0);
  assert.ok(compareKeys(compositeKey(['r', 'id', 1, 'h']), compositeKey(['r', 'id', 1, 'h', { kind: 'frame' }])) > 0,
    'Without the fixed arity a shorter tuple would sort after a longer one: the reason each caller fixes it');
  // The key is the canonical encoding itself; canonical and hashJson are unchanged.
  assert.equal(compositeKey(['b', { z: 1, a: [2, 'x'] }]), canonical(['b', { a: [2, 'x'], z: 1 }]));
  assert.equal(canonical({ z: 1, a: [2, 'x', null, true] }), '{"a":[2,"x",null,true],"z":1}');
  assert.equal(hashJson({ z: 1, a: [2, 'x'] }), hashJson({ a: [2, 'x'], z: 1 }));
});

test('Q3 compareKeys is the code-unit order, never the locale order', () => {
  assert.equal(compareKeys('B', 'a'), -1, 'Upper-case letters come first by code unit');
  assert.equal(compareKeys('a', 'a'), 0);
  assert.equal(compareKeys('a!', 'a'), 1);
  const keys = ['b', 'B', 'a-b', 'ab', 'a'];
  assert.deepEqual([...keys].sort(compareKeys), ['B', 'a', 'a-b', 'ab', 'b']);
  // The order a separator join gave and the order of the canonical tuple can differ on legal parts — the reason the
  // saved orders keep their era (№2549-3): a NUL join puts "a" first, the tuple puts "a!" first.
  const joined = [['a', 'x'], ['a!', 'x']].sort((left, right) => compareKeys(left.join('\0'), right.join('\0')));
  const tupled = [['a', 'x'], ['a!', 'x']].sort((left, right) => compareKeys(compositeKey(left), compositeKey(right)));
  assert.deepEqual(joined.map(item => item[0]), ['a', 'a!']);
  assert.deepEqual(tupled.map(item => item[0]), ['a!', 'a']);
});

function upper(): Graph {
  const { level: _level, ...graph } = projectGraph(gardenGraph(), 1);
  return graph as Graph;
}
function policy(graph: Graph): QueuePolicy {
  const layer: Ref = { id: 'graph-layer:garden:1', revision: 1, hash: hashJson(graph) };
  const journey = graph.journeys!.find(item => item.terminal === 'success' && item.outcome === 'garden-result')!;
  return { version: QUEUE_POLICY_VERSION, machinePath: { layer, journeyId: journey.id, actorId: journey.actor, outcomeId: journey.outcome } };
}

test('Q3 the queue maximum: an empty horizon is refused before the maximum, and the maximum of a nonempty one is unchanged', () => {
  const graph = upper(), blocks = graph.nodes.filter(node => node.kind === 'block').map(node => node.id);
  const empty = computeBlockWeights(graph, [], policy(graph));
  if (empty.ok) assert.fail('An empty horizon has no maximum');
  assert.deepEqual([empty.refusal.code, empty.refusal.at.unit, empty.refusal.at.target, empty.refusal.at.field, empty.refusal.route],
    ['queue_source_invalid', 'M3', 'horizon', 'nodes', 'producer']);
  const full = computeBlockWeights(graph, blocks, policy(graph));
  if (!full.ok) assert.fail(full.refusal.code);
  assert.equal(full.value.maxD, Math.max(...full.value.order.map(row => row.D)));
  assert.equal(full.value.maxD, 2, 'The garden producer has two dependents across the whole upper layer');
});

test('Q3 D7 accepted level: the intersection with the exact graph is checked before any maximum, and only matched nodes count', () => {
  // The same function context() in obligations.ts calls; the guard of an invariant at its boundary (№2557), not a claim
  // that a public producer reaches it.
  const graph = gardenGraph(), graphRef: Ref = { id: 'graph:garden', revision: 3, hash: hashJson(graph) };
  const refusal = (nodes: ReadonlySet<string>) => {
    const result = acceptedLevelOf(graph, nodes, graphRef);
    if (result.ok) assert.fail('An empty intersection has no level');
    return [result.refusal.code, result.refusal.message, result.refusal.at.unit, result.refusal.at.target, result.refusal.at.field, result.refusal.route];
  };
  const expected = ['obligation_context_mismatch', 'The accepted frames must name nodes of the exact graph', 'D7', 'graph:garden', 'frames', 'producer'];
  assert.deepEqual(refusal(new Set()), expected, 'Empty accepted nodes');
  assert.deepEqual(refusal(new Set(['foreign-block', 'foreign-work'])), expected, 'Accepted nodes that name no node of the graph');
  const block = graph.nodes.find(node => node.kind === 'block')!, work = graph.nodes.find(node => node.kind === 'work')!;
  const level = (nodes: ReadonlySet<string>) => { const result = acceptedLevelOf(graph, nodes, graphRef); if (!result.ok) assert.fail(result.refusal.code); return result.value; };
  assert.equal(level(new Set([block.id, 'foreign-work'])), LEVEL.block, 'A foreign id adds no level');
  assert.equal(level(new Set([block.id, work.id, 'foreign-block'])), LEVEL.work, 'The maximum of the matched nodes');
  assert.equal(level(new Set(graph.nodes.map(node => node.id))), Math.max(...graph.nodes.map(node => LEVEL[node.kind])));
});

// ---- The order the journal keeps (№2556): every journal names composite-key/v1, orders its sources and grounds by
// it, and is refused without it.
const okq = <T>(result: OmResult<T>): T => { if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} ${canonical(result.refusal.at)}`); return result.value; };
test('Q3 a journal of the new code is marked with its order on every revision and keeps it across a restart; an absent or unknown marker is an addressed refusal', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-q3-journal-'));
  const store = new Store(join(root, 'state.sqlite'));
  const evidence = store.write({ id: 'evidence:p', kind: 'evidence', expected: 0, value: { result: true } });
  const basis = reference(evidence), horizon: Ref = { id: 'om-horizon-gate:p:one', revision: 1, hash: hashJson('horizon') };
  // The legal pair in the new order: the tuple sorts "a!" before "a", and a contextless source before a contextful one.
  const sources = [{ role: 'a!', ref: basis }, { role: 'a', ref: basis, context: { kind: 'frame' as const,
    request: { project: 'p', level: 2 as const, horizon, graph: basis, layer: null, frame: null, upper: null } } }, { role: 'a', ref: basis }];
  const [unit] = store.writeMany([{ id: `${unitRefusalNamespace('p')}q3`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: 'G1', refusals: [{ code: 'q3_probe', goal: 'goal', remedy: 'fix', origin: { name: 'probe', stage: 'stage', subject: 'subject', sources } }] } }]);
  const recorded = okq(recordRefusal(store, { project: 'p', source: reference(unit!) }));
  assert.equal(recorded.value.sourceOrder, SOURCE_ORDER);
  assert.deepEqual(recorded.value.rows[0]!.origin.sources.map(source => [source.role, Object.hasOwn(source, 'context')]), [['a!', false], ['a', false], ['a', true]]);
  const classified = okq(classifyRefusal(store, { project: 'p', row: recorded.value.rows[0]!.id, class: 'q3-class', addressee: 'owner:q3',
    basis: [{ role: 'a', ref: basis }, { role: 'a!', ref: basis }] }));
  assert.equal(classified.value.sourceOrder, SOURCE_ORDER);
  assert.deepEqual(classified.value.classifications[0]!.basis.map(source => source.role), ['a!', 'a']);
  store.close();
  const reopened = new Store(join(root, 'state.sqlite'));
  t.after(() => { reopened.close(); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(okq(readJournalAt(reopened, 'p', reference(classified))), classified);
  // The marker is mandatory: an absent one is a journal of an earlier era, an unknown one is no order of this unit.
  const unmarked = reopened.write({ id: classified.id, kind: classified.kind, expected: classified.revision,
    value: { projectId: 'p', rows: classified.value.rows, classifications: classified.value.classifications } });
  const missing = readJournalAt(reopened, 'p', reference(unmarked));
  if (missing.ok) assert.fail('A journal without its order is not a journal of this code');
  assert.deepEqual([missing.refusal.code, missing.refusal.at.field], ['journal_invalid', 'sourceOrder']);
  const marked = reopened.write({ id: classified.id, kind: classified.kind, expected: unmarked.revision,
    value: { ...classified.value, sourceOrder: 'composite-key/v0' } });
  const unknown = readJournalAt(reopened, 'p', reference(marked));
  if (unknown.ok) assert.fail('An unknown order is no order of this unit');
  assert.deepEqual([unknown.refusal.code, unknown.refusal.at.field], ['journal_invalid', 'sourceOrder']);
});

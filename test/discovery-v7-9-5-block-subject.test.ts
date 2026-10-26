import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { BLOCK_SUBJECT_CONTRACT, BLOCK_SUBJECT_KIND, BLOCK_SUBJECT_REFUSAL_CODES, checkBlockSubject,
  collectBlockSubject, decodeBlockSubject, type BlockSubject, type BlockSubjectRequest } from '../src/om/block-keeper.js';
import type { FrameCandidateRecord } from '../src/om/frame-candidate.js';
import type { Refusal } from '../src/om/refusal.js';
import { createCrossOmFixture } from './om-fixture.js';

// DR9 9.5 (codex-omg №14392): the proven subject material of one exact OM block for the keeper — the block, its
// whole operation/work subtree, the connections touching it with both ends kept, and the exact source records the
// saved candidate's identity names, assembled only from proven reads. Real managed OM producers (the cross garden
// fixture writes L2/L3 candidates through writeCandidate/writeWorksFrame); no payment and no acceptance is claimed —
// that stays with 9.2/9.3/9.4.

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };
const take = <T,>(result: Result<T>): T => { assert.ok(result.ok, (result as { refusal?: Refusal }).refusal?.message); return result.value; };
const refused = (result: Result<unknown>): Refusal => { assert.equal(result.ok, false, 'expected a refusal'); return (result as { refusal: Refusal }).refusal; };
const error = (fn: () => unknown, expected: string): EngineError => {
  try { fn(); } catch (failure) {
    assert.ok(failure instanceof EngineError, `expected EngineError, got ${String(failure)}`);
    assert.equal((failure as EngineError).code, expected);
    return failure as EngineError;
  }
  assert.fail('expected an EngineError');
};
const fieldOf = (failure: EngineError): string => ((failure.details as { field?: string } | null)?.field) ?? '?';
const candidate = (store: Store, level: 2 | 3): Revision<FrameCandidateRecord> =>
  store.list<FrameCandidateRecord>('frame-candidate').find(record => record.value.level === level)!;
const request = (store: Store, level: 2 | 3, block = 'garden-produce-block'): BlockSubjectRequest =>
  ({ project: 'garden', candidate: reference(candidate(store, level)), block });
const clone = (value: unknown) => JSON.parse(canonical(value));
const ends = (connector: { bindings: readonly { producer: { node: string }; consumers: readonly { node: string }[] }[];
  returnsTo: string | null }): string[] =>
  [...connector.bindings.flatMap(binding => [binding.producer.node, ...binding.consumers.map(consumer => consumer.node)]),
    ...(connector.returnsTo ? [connector.returnsTo] : [])];
const heads = (store: Store): string => store.list().map(record => `${record.id}:${record.revision}`).join('|');

test('9.5 the collector proves the L2 block subject: the block, its operation subtree, both-ended and boundary connections, and the exact source records with contents', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const store = f.store, cand = candidate(store, 2), req = request(store, 2);
  const pkg = take(collectBlockSubject(store, req));
  assert.equal(pkg.contract, BLOCK_SUBJECT_CONTRACT);
  assert.match(pkg.subject, new RegExp(`^${BLOCK_SUBJECT_KIND}:garden:[0-9a-f]{64}$`));
  assert.ok(Object.isFrozen(pkg) && Object.isFrozen(pkg.block) && Object.isFrozen(pkg.grounds), 'the delivered package is sealed');
  assert.deepEqual(pkg.block, cand.value.graph.nodes.find(node => node.id === 'garden-produce-block'),
    'the block is the saved node itself, not a copy the caller chose');
  assert.deepEqual(new Set(pkg.members.map(node => node.id)),
    new Set(['garden-prep-operation', 'garden-produce-operation']), 'the whole L2 subtree, nothing above the block');
  for (const member of pkg.members)
    assert.deepEqual(member, cand.value.graph.nodes.find(node => node.id === member.id));
  assert.deepEqual(pkg.internal.map(connector => connector.id), ['garden-prep-flow']);
  assert.deepEqual(pkg.boundary.map(connector => connector.id), ['garden-flow']);
  assert.deepEqual(pkg.internal[0], cand.value.graph.connectors.find(connector => connector.id === 'garden-prep-flow'),
    'the internal connection is the whole saved connector');
  const boundary = pkg.boundary[0]!, inside = new Set([pkg.block.id, ...pkg.members.map(node => node.id)]);
  assert.ok(ends(boundary).some(node => inside.has(node)) && ends(boundary).some(node => !inside.has(node)),
    'a boundary connection keeps an end on each side');
  assert.ok(boundary.bindings.some(binding => binding.consumers.some(consumer => !inside.has(consumer.node))),
    'the outside end of the boundary connection is kept, not trimmed away');
  assert.ok(pkg.internal.every(connector => ends(connector).every(node => inside.has(node))), 'internal ends never leave the subtree');
  // The grounds are the source records themselves, at the revisions the candidate's identity names — never heads.
  assert.deepEqual(reference(pkg.grounds.graph), cand.value.base.graph);
  assert.deepEqual(pkg.grounds.graph, store.get('graph:garden', cand.value.base.graph.revision));
  assert.notEqual(pkg.grounds.graph.revision, store.get('graph:garden')!.revision,
    'the ground is the referenced revision even though the graph head moved since');
  assert.equal(pkg.grounds.frame, null);
  assert.deepEqual(pkg.grounds.proposals.map(record => reference(record)), cand.value.proposals);
  assert.ok(pkg.grounds.proposals.every(record => typeof record.value === 'object' && record.value !== null),
    'grounds carry contents, not only references');
  assert.equal(pkg.grounds.works, null);
  assert.equal(pkg.candidate.id, cand.id); assert.equal(pkg.level, 2); assert.equal(pkg.project, 'garden');
});

test('9.5 the L3 works candidate keeps the works subtree and the works grounds of its own producer and ledger', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const store = f.store, cand = candidate(store, 3);
  const pkg = take(collectBlockSubject(store, request(store, 3)));
  assert.equal(pkg.level, 3);
  assert.deepEqual(new Set(pkg.members.map(node => node.id)),
    new Set(['garden-prep-operation', 'garden-produce-operation', 'garden-prep-work', 'garden-produce-work']),
    'operations and works of the block subtree');
  assert.deepEqual(pkg.internal.map(connector => connector.id), ['garden-prep-flow']);
  assert.deepEqual(pkg.boundary.map(connector => connector.id), ['garden-flow']);
  const works = pkg.grounds.works!;
  assert.deepEqual(reference(works.producer), cand.value.works!.producer);
  assert.deepEqual(reference(works.ledger), cand.value.works!.ledger);
  assert.deepEqual(works.producer, store.get(cand.value.works!.producer.id, cand.value.works!.producer.revision));
  assert.deepEqual(works.ledger, store.get(cand.value.works!.ledger.id, cand.value.works!.ledger.revision));
  assert.deepEqual(reference(pkg.grounds.graph), cand.value.base.graph);
  assert.equal(pkg.grounds.graph.revision, 2, 'the L3 base revision, not the current head');
});

test('9.5 a repeat read restores the same package after heads move, and a cold store proves it again', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const before = take(collectBlockSubject(f.store, request(f.store, 3)));
  const head = f.store.get('graph:garden')!;
  f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value as object, moved: true } });
  const fact = f.store.list('fact')[0]!;
  f.store.write({ id: fact.id, kind: fact.kind, expected: fact.revision, value: { ...fact.value as object, moved: true } });
  const after = take(collectBlockSubject(f.store, request(f.store, 3)));
  assert.deepEqual(after, before, 'moved heads change nothing: every address is an exact {id, revision, hash}');
  f.reopen();
  const cold = take(collectBlockSubject(f.store, request(f.store, 3)));
  assert.deepEqual(cold, before, 'a fresh store reads the same proven records');
  assert.equal(cold.subject, before.subject);
});

test('9.5 another block, another level or another candidate is another subject — the caller cannot pick a cut-down inventory', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const produce3 = take(collectBlockSubject(f.store, request(f.store, 3, 'garden-produce-block')));
  const consume3 = take(collectBlockSubject(f.store, request(f.store, 3, 'garden-consume-block')));
  const produce2 = take(collectBlockSubject(f.store, request(f.store, 2, 'garden-produce-block')));
  assert.notEqual(consume3.subject, produce3.subject);
  assert.notEqual(produce2.subject, produce3.subject);
  assert.deepEqual(consume3.members.map(node => node.id).sort(), ['garden-consume-operation', 'garden-consume-work']);
  assert.deepEqual(consume3.internal.map(connector => connector.id), [], 'no connection stays fully inside the consume block');
  assert.deepEqual(consume3.boundary.map(connector => connector.id), ['garden-flow']);
  const mismatch = refused(checkBlockSubject(f.store, request(f.store, 3, 'garden-produce-block'), clone(consume3)));
  assert.equal(mismatch.code, 'block_subject_mismatch'); assert.equal(mismatch.at.field, 'block');
});

test('9.5 the check delivers the proven package and refuses a substituted, truncated or stale presentation at its field', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const req = request(f.store, 3), pkg = take(collectBlockSubject(f.store, req));
  const ok = take(checkBlockSubject(f.store, req, clone(pkg)));
  assert.deepEqual(ok, pkg, 'the check hands back the proven package, not the presented one');
  const cases: [string, (p: BlockSubject) => void, string][] = [
    ['a member dropped', p => { p.members.splice(0, 1); }, 'members'],
    ['a member replaced by another member', p => { p.members[0] = clone(pkg.members[1]!); }, 'members'],
    ['an internal connection dropped', p => { p.internal.splice(0); }, 'internal'],
    ['the boundary connection dropped', p => { p.boundary.splice(0); }, 'boundary'],
    ['the block body edited', p => { p.block.title = 'Edited'; }, 'block'],
    ['a ground replaced by another record', p => { p.grounds.graph = clone(p.grounds.proposals[0]!); }, 'grounds'],
    ['the identity itself restated', p => { p.subject = `${BLOCK_SUBJECT_KIND}:garden:${'0'.repeat(64)}`; }, 'subject'],
  ];
  for (const [name, damage, field] of cases) {
    const presented = clone(pkg); damage(presented);
    const failure = refused(checkBlockSubject(f.store, req, presented));
    assert.equal(failure.code, 'block_subject_mismatch', name);
    assert.equal(failure.at.field, field, `${name} is caught at ${field}`);
  }
  const wrongCandidate = { ...clone(pkg), candidate: reference(candidate(f.store, 2)) };
  assert.equal(refused(checkBlockSubject(f.store, req, wrongCandidate)).at.field, 'candidate');
  const wrongProject = { ...clone(pkg), project: 'other' };
  assert.equal(refused(checkBlockSubject(f.store, req, wrongProject)).at.field, 'project');
  // A stale package: the L2 composition of the same block is well-formed but not what the L3 snapshot proves.
  const stale = clone(take(collectBlockSubject(f.store, request(f.store, 2, 'garden-produce-block'))));
  assert.equal(refused(checkBlockSubject(f.store, req, stale)).at.field, 'candidate');
});

test('9.5 the closed form refuses a truncated, marked or malformed package at its field', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const pkg = clone(take(collectBlockSubject(f.store, request(f.store, 3)))) as Record<string, any>;
  const fields = ['contract', 'subject', 'project', 'candidate', 'level', 'block', 'members', 'internal', 'boundary', 'grounds'];
  for (const key of fields) {
    const damaged = { ...pkg }; delete damaged[key];
    assert.equal(fieldOf(error(() => decodeBlockSubject(damaged), 'block_subject_invalid')), key, `a missing ${key}`);
  }
  for (const mark of [{ accepted: true }, { supported: true }, { paid: true }, { reuse: pkg.candidate }]) {
    const damaged = { ...pkg, ...mark };
    assert.equal(fieldOf(error(() => decodeBlockSubject(damaged), 'block_subject_invalid')), Object.keys(mark)[0],
      'an added mark is refused at its own field — acceptance is not this package to assert');
  }
  const cases: [string, (p: Record<string, any>) => void, string][] = [
    ['older contract', p => { p.contract = 'om-block-subject/v0'; }, 'contract'],
    ['identity without a hash', p => { p.subject = 'om-block-subject:garden:x'; }, 'subject'],
    ['identity of another kind', p => { p.subject = `om-block-subject-other:garden:${'0'.repeat(64)}`; }, 'subject'],
    ['blank project', p => { p.project = ' '; }, 'project'],
    ['candidate as a bare id', p => { p.candidate = pkg.candidate.id; }, 'candidate'],
    ['a fourth level', p => { p.level = 4; }, 'level'],
    ['a work standing for the block', p => { p.block = { ...pkg.block, kind: 'work' }; }, 'block'],
    ['the block nested among members', p => { p.members = [clone(pkg.block)]; }, 'members'],
    ['a connector without bindings', p => { p.internal = [{ id: 'x', artifact: 'a', returnsTo: '', wakeTest: null }]; }, 'internal'],
    ['grounds missing the works field', p => { delete p.grounds.works; }, 'grounds'],
    ['a smuggled ground', p => { p.grounds.smuggled = pkg.grounds.graph; }, 'grounds'],
    ['a frame that is no record', p => { p.grounds.frame = {}; }, 'grounds.frame'],
    ['a proposal without a hash', p => { p.grounds.proposals = [{ id: 'x', kind: 'layer-proposal', revision: 1, value: {} }]; }, 'grounds.proposals'],
    ['works grounds at L2', p => { p.level = 2; }, 'grounds.works'],
    ['no works grounds at L3', p => { p.grounds.works = null; }, 'grounds.works'],
    ['a ledger missing', p => { p.grounds.works = { producer: pkg.grounds.works.producer }; }, 'grounds.works'],
  ];
  for (const [name, damage, field] of cases) {
    const damaged = clone(pkg); damage(damaged);
    assert.equal(fieldOf(error(() => decodeBlockSubject(damaged), 'block_subject_invalid')), field, name);
  }
  for (const value of [null, [], 'om-block-subject:garden:x'])
    assert.equal(fieldOf(error(() => decodeBlockSubject(value), 'block_subject_invalid')), 'contract');
});

test('9.5 a foreign or missing candidate, a foreign project, a non-block address and malformed inputs are refused at their addresses', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const req = request(f.store, 3);
  // A candidate of another project is foreign to the namespace the request names.
  const foreign = refused(collectBlockSubject(f.store, { ...req, project: 'other' }));
  assert.equal(foreign.code, 'record_foreign'); assert.equal(foreign.at.field, 'id');
  // An exact reference with no record behind it.
  const missingRef: Ref = { id: 'om-candidate:garden:none', revision: 1, hash: hashJson('none') };
  assert.equal(refused(collectBlockSubject(f.store, { ...req, candidate: missingRef })).code, 'record_missing');
  // A forged reference — a real revision under a hash that is not its own.
  const forged: Ref = { ...req.candidate, hash: '0'.repeat(64) };
  assert.equal(refused(collectBlockSubject(f.store, { ...req, candidate: forged })).code, 'record_forged');
  // The block address must name a block of this snapshot — not an absent node, an operation or a single work.
  for (const [name, block] of [['absent', 'garden-absent-block'], ['an operation', 'garden-produce-operation'],
    ['a single work', 'garden-produce-work'], ['a foreign block', 'other-produce-block']] as const) {
    const failure = refused(collectBlockSubject(f.store, { ...req, block }));
    assert.equal(failure.code, 'block_subject_missing', name);
    assert.equal(failure.at.field, 'block'); assert.equal(failure.at.target, block);
  }
  for (const [name, bad] of [['null', null], ['no project', { candidate: req.candidate, block: req.block }],
    ['a bare candidate id', { project: 'garden', candidate: req.candidate.id, block: req.block }],
    ['an empty block', { ...req, block: '' }], ['no store', 'store']] as const) {
    const failure = error(() => bad === 'store' ? collectBlockSubject(null as unknown as Store, req)
      : collectBlockSubject(f.store, bad as unknown as BlockSubjectRequest), 'block_subject_request_invalid');
    assert.ok(fieldOf(failure).length > 0, name);
  }
  // The same rules stand for the check: malformed presentations are defects, absent blocks are refusals.
  assert.equal(fieldOf(error(() => checkBlockSubject(f.store, req, null), 'block_subject_invalid')), 'contract');
  assert.equal(refused(checkBlockSubject(f.store, { ...req, block: 'garden-later-block' },
    clone(take(collectBlockSubject(f.store, req))))).code, 'block_subject_mismatch');
});

test('9.5 the collector and the check write nothing and pay nothing', async (t: TestContext) => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const req = request(f.store, 3), before = heads(f.store);
  const pkg = take(collectBlockSubject(f.store, req));
  take(checkBlockSubject(f.store, req, clone(pkg)));
  decodeBlockSubject(clone(pkg));
  assert.equal(heads(f.store), before, 'no head moved — the package is assembled by reads alone');
  assert.equal(f.store.list('model-call').length, 0, 'no call was dispatched and nothing was paid');
});

test('9.5 the refusal catalogue is exactly the two codes the unit can produce', () => {
  assert.deepEqual([...BLOCK_SUBJECT_REFUSAL_CODES], ['block_subject_missing', 'block_subject_mismatch']);
});

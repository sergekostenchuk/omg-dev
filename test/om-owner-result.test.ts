import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { type Json } from '../src/canonical.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { issueOwnerInvitation, OwnerSessions, type OwnerSession } from '../src/product/owner-authority.js';
import { Store, type Write } from '../src/storage/store.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeGaps, type GapReadRequest, type GapRequest } from '../src/om/gaps.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeOmInput } from '../src/om/input.js';
import type { OmResult } from '../src/om/refusal.js';
import { writeRoutes } from '../src/om/routes.js';
import { listOwnerQuestions, OWNER_COMMAND_KIND, OWNER_RESULT_KIND, ownerCommandId, ownerQuestionAddress,
  ownerResultId, readOwnerResult, writeOwnerResult, type OwnerCommand, type OwnerReaders } from '../src/om/owner-result.js';
import { readOmInput } from '../src/om/input.js';
import { readRoutes } from '../src/om/routes.js';
import { gardenGraph, refusedWith } from './om-fixture.js';
import { seedCopy } from './om-seed.js';
import { preparedField } from './preparation-fixture.js';
import { preparedFeatures } from './product-fixture.js';

const clone = structuredClone;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function snapshot(store: Store): Ref[] { return store.list().map(reference); }

/** The same B1→D1→M6 chain as the answers-gate fixture, with one owner-decision unknown routed to 'owner'. */
function gatePrefix(store: Store) {
  const engine = new ProductEngine(store), project = 'garden', block = 'garden-produce-block';
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [
      { id: 'owner-choice', question: 'Which output should this project use?', consumer: block, moment: 'om-pass',
        blocksCurrentStage: false, resolution: 'Resolve the named decision before assembling work' }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
    reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const first = ok(writeOmInput(store, { project, expected: 0, stages }));
  const graph = store.get<Graph>(`graph:${project}`)!;
  const target = 'discovery:owner-choice';
  const input = ok(writeAddressing(store, { project, input: reference(first), graph: reference(graph),
    decisions: [{ pending: clone(inputDecisionWrite({ project, input: reference(first), graph: reference(graph),
      layers: [], decision: { target, field: 'address', value: { consumer: block, kind: 'owner-decision' } } })) }] }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: 'owner-result-fixture', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources));
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const route = ok(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const owner = gaps.records.find(row => row.value.gap.target === target && row.value.gap.kind === 'owner-decision');
  assert.ok(owner, 'The fixture must carry the owner-decision gap');
  assert.equal(route.value.routes.find(row => row.gap === owner.value.gap.id)?.route, 'owner');
  return { project, block, target, input, graph, horizon, gaps, route, owner };
}
function fixture(t: TestContext) {
  const seeded = seedCopy('owner-result:garden', gatePrefix, 'omg-owner-result-');
  const { root, database: path } = seeded;
  let store = new Store(path);
  const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, ...seeded.data,
    get engine() { return engine; },
    get store() { return store; }, restart() { store.close(); store = new Store(path); } };
}
function ownerLogin(store: Store, project: string, sessions = new OwnerSessions(store)) {
  const { invitation } = ok(issueOwnerInvitation(store, { project }));
  const exchanged = ok(sessions.exchange({ project, invitation }));
  const authority = sessions.authority(exchanged.bearer);
  assert.ok(authority, 'A live bearer yields its opaque authority');
  return { sessions, invitation, ...exchanged, authority };
}
const READERS: OwnerReaders = { routes: readRoutes, input: readOmInput };
const decide = (f: ReturnType<typeof fixture>, authority: unknown, value: Json = 'JSON', basis = 'The owner chose JSON') =>
  writeOwnerResult(f.store, authority,
    { project: f.project, routes: reference(f.route), gap: reference(f.owner), value, basis }, READERS);

test('H2 writes the owner command and the owner result in one transaction and the common reader rederives the chain', t => {
  const f = fixture(t);
  const { authority, session } = ownerLogin(f.store, f.project);
  const decided = ok(decide(f, authority));
  assert.equal(decided.repeated, false);
  assert.equal(decided.result.kind, 'om-owner-result');
  assert.equal(decided.command.kind, OWNER_COMMAND_KIND);
  assert.equal(decided.result.value.contract, 'om-owner-result/v1');
  assert.equal(decided.command.value.contract, 'owner-command/v1');
  assert.deepEqual(decided.result.value.command, reference(decided.command));
  assert.deepEqual(decided.command.value.session, session);
  assert.equal(decided.result.id, ownerResultId(f.project, reference(decided.command)));
  assert.equal(decided.command.id, ownerCommandId(decided.command.value as OwnerCommand));
  assert.equal(decided.result.value.question, ownerQuestionAddress(decided.command.value.question));
  const view = ok(readOwnerResult(f.store, { project: f.project, record: reference(decided.result) }, READERS));
  assert.equal(view.record.id, decided.result.id);
  assert.equal(view.question.contract, 'om-owner-question/v1');
  assert.equal(view.question.question.id, f.target);
  assert.equal(view.question.question.text, 'Which output should this project use?');
  assert.equal(view.question.question.kind, 'owner-decision');
  assert.deepEqual(view.question.gap, reference(f.owner));
  assert.deepEqual(view.question.routes, reference(f.route));
  assert.deepEqual(view.question.input, decided.command.value.question.input);
  assert.equal(view.question.route.gap, f.owner.value.gap.id);
  assert.equal(view.question.route.target, f.target);
  assert.equal(view.question.route.field, f.owner.value.gap.field);
  assert.equal(view.session.id, session.id);
  assert.equal(view.grant.id.startsWith('owner-session-grant:'), true);
  f.restart();
  assert.deepEqual(ok(readOwnerResult(f.store, { project: f.project, record: reference(decided.result) }, READERS)).record,
    decided.result, 'The historical read rederives the same record after restart');
});

test('H2 is idempotent: the exact repeat under the same and a new session returns the prior result without writes', t => {
  const f = fixture(t);
  const first = ownerLogin(f.store, f.project);
  const decided = ok(decide(f, first.authority));
  const after = snapshot(f.store);
  const repeated = ok(decide(f, first.authority));
  assert.equal(repeated.repeated, true);
  assert.deepEqual(reference(repeated.result), reference(decided.result));
  assert.deepEqual(snapshot(f.store), after, 'An exact repeat performs no write');
  // The command identity excludes the session: a new owner login returns the same result (№1353).
  const second = ownerLogin(f.store, f.project);
  const beforeRepeat = snapshot(f.store);   // the login itself legitimately wrote its grant and session
  const revived = ok(decide(f, second.authority));
  assert.equal(revived.repeated, true);
  assert.deepEqual(reference(revived.result), reference(decided.result));
  assert.deepEqual(snapshot(f.store), beforeRepeat, 'A repeat under a new session performs no write');
  const changed = ok(decide(f, second.authority, 'XML', 'The owner revised the output'));
  assert.equal(changed.repeated, false);
  assert.notEqual(changed.command.id, decided.command.id, 'Different content is a different command identity');
  assert.notEqual(changed.result.id, decided.result.id);
});

test('H2 refuses lookalike authority, wrong scope, foreign records and a revoked session', t => {
  const f = fixture(t);
  const { authority, sessions, bearer } = ownerLogin(f.store, f.project);
  for (const lookalike of [null, {}, 'owner', { authority: true }, reference(f.route)])
    refusedWith(decide(f, lookalike), 'owner_authority_invalid');
  const design = f.gaps.records.find(row => row.value.gap.kind !== 'owner-decision' && row.value.gap.blocking)!;
  refusedWith(writeOwnerResult(f.store, authority, { project: f.project, routes: reference(f.route),
    gap: reference(design), value: 'JSON', basis: 'answered' }, READERS), 'owner_question_invalid');
  refusedWith(writeOwnerResult(f.store, authority, { project: f.project, routes: reference(f.route),
    gap: { id: `om-gap:${f.project}:absent`, revision: 1, hash: '0'.repeat(64) }, value: 'JSON', basis: 'answered' }, READERS),
    ['record_missing', 'record_forged', 'owner_question_invalid']);
  refusedWith(decide(f, authority, 'JSON', 42 as unknown as string), 'owner_request_invalid');
  refusedWith(writeOwnerResult(f.store, authority, { project: 'other', routes: reference(f.route),
    gap: reference(f.owner), value: 'JSON', basis: 'answered' }, READERS), 'owner_authority_foreign');
  ok(sessions.revoke(bearer));
  refusedWith(decide(f, authority), 'owner_session_missing');
  assert.equal(snapshot(f.store).some(ref => ref.id.startsWith(`om-owner-result:${f.project}:`)), false,
    'Every refusal happened before any write');
});

test('H2 common reader refuses masquerading, tampered and chain-broken records', t => {
  const f = fixture(t);
  const { authority, sessions, bearer, session } = ownerLogin(f.store, f.project);
  // A record of the right kind/namespace without the command chain is no result.
  const lookalike = f.store.write({ id: `om-owner-result:${f.project}:lookalike`, kind: 'om-owner-result', expected: 0,
    value: { project: f.project, actor: 'owner', gap: reference(f.owner), answer: 'JSON' } });
  refusedWith(readOwnerResult(f.store, { project: f.project, record: reference(lookalike) }, READERS), 'owner_result_invalid');
  refusedWith(readOwnerResult(f.store, { project: f.project, record: { ...reference(lookalike), hash: '0'.repeat(64) } }, READERS),
    'record_forged');
  refusedWith(readOwnerResult(f.store, { project: 'other', record: reference(lookalike) }, READERS), 'record_foreign');
  const decided = ok(decide(f, authority));
  // A result that restates nothing of its receipt is invalid even when its envelope parses.
  const tampered = f.store.write({ id: `om-owner-result:${f.project}:tampered`, kind: 'om-owner-result', expected: 0,
    value: { contract: 'om-owner-result/v1', project: f.project, command: reference(decided.command),
      question: decided.result.value.question, value: 'XML', basis: 'forged' } });
  refusedWith(readOwnerResult(f.store, { project: f.project, record: reference(tampered) }, READERS), 'owner_result_invalid');
  // A receipt bound to a foreign session chain is invalid.
  const foreignCommand = f.store.write({ id: `owner-command:${f.project}:${'f'.repeat(64)}`,
    kind: 'owner-command', expected: 0, value: { ...clone(decided.command.value),
      session: { id: 'owner-session:forged', revision: 1, hash: '0'.repeat(64) } } });
  const chained = f.store.write({ id: `om-owner-result:${f.project}:chained`, kind: 'om-owner-result', expected: 0,
    value: { ...clone(decided.result.value), command: reference(foreignCommand) } });
  refusedWith(readOwnerResult(f.store, { project: f.project, record: reference(chained) }, READERS),
    ['owner_command_invalid', 'owner_result_invalid']);
  // Logout closes the session head but never retroactively invalidates the persisted result: the receipt pins the
  // exact session revision that was live at write time, and the common reader reads that history faithfully.
  ok(sessions.revoke(bearer));
  const view = ok(readOwnerResult(f.store, { project: f.project, record: reference(decided.result) }, READERS));
  assert.equal(view.session.revision, 1);
  assert.equal(view.session.value.state, 'open');
  assert.equal(f.store.get<OwnerSession>(session.id)!.value.state, 'closed', 'The head shows the session revoked');
});

test('H2 owner questions list feeds the UI from rederived records only', t => {
  const f = fixture(t);
  const before = ok(listOwnerQuestions(f.store, f.project, READERS));
  assert.equal(before.length, 1);
  assert.equal(before[0]!.question.question.id, f.target);
  assert.equal(before[0]!.answered, null);
  const { authority } = ownerLogin(f.store, f.project);
  const decided = ok(decide(f, authority));
  const after = ok(listOwnerQuestions(f.store, f.project, READERS));
  assert.equal(after.length, 1);
  assert.deepEqual(after[0]!.answered, reference(decided.result));
  refusedWith(listOwnerQuestions(f.store, 42 as unknown as string, READERS), 'owner_request_invalid');
});

test('H2 a second Store moving any guarded head between preparation and commit refuses the pair atomically', t => {
  // Договор №2719: the exact session revision and the B1/D1/M6 heads are transaction guards — a second connection
  // moving any of them between the producer's reads and its writeMany must refuse the whole pair write.
  for (const target of ['session', 'input', 'gap', 'routes', 'clean'] as const) {
    const f = fixture(t);
    const { authority, session } = ownerLogin(f.store, f.project);
    const question = ok(listOwnerQuestions(f.store, f.project, READERS))[0]!.question;
    const moved = { session: session.id, input: question.input.id, gap: question.gap.id, routes: question.routes.id };
    const second = new Store(f.path), original = f.store.writeMany.bind(f.store);
    let raced = false; const seen: Write[][] = [];
    f.store.writeMany = ((writes: Write[], guards: Ref[] = []) => {
      if (writes.some(write => write.kind === OWNER_RESULT_KIND)) {
        seen.push(writes);
        if (target !== 'clean' && !raced) {
          raced = true;
          const head = second.get(moved[target])!;
          second.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
        }
      }
      return original(writes, guards);
    }) as typeof f.store.writeMany;
    try {
      const outcome = decide(f, authority);
      const captured = seen[0];
      assert.ok(captured, `${target}: the producer issued the pair write`);
      assert.equal(captured.length, 2, `${target}: the commit is one atomic pair write`);
      assert.ok(captured.every(write => write.expected === 0), `${target}: both records are fresh writes`);
      assert.deepEqual(captured.map(write => write.kind).sort(), [OWNER_COMMAND_KIND, OWNER_RESULT_KIND].sort());
      if (target === 'clean') {
        ok(outcome);
        assert.equal(f.store.list(OWNER_COMMAND_KIND).length, 1);
        assert.equal(f.store.list(OWNER_RESULT_KIND).length, 1);
      } else {
        refusedWith(outcome, ['input_stale', 'revision_conflict']);
        assert.equal(raced, true, `${target}: the head must actually move before the commit`);
        assert.equal(f.store.list(OWNER_COMMAND_KIND).length, 0, `${target}: no owner-command leaked`);
        assert.equal(f.store.list(OWNER_RESULT_KIND).length, 0, `${target}: no om-owner-result leaked`);
      }
    } finally { second.close(); }
  }
});

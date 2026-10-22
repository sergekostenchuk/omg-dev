import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { prepareVariantSession, applyVariantSession, runVariantSession, readVariantExecutionSession, readVariantGeneration } from '../src/discovery/variant-session.js';
import { projectPaidVariantSession } from '../src/discovery/research-consumer-transition.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, variantRecordId, type VariantSubject, type VariantSet, type DiscoveryVariant,
  type VariantExecutionSession } from '../src/discovery/discovery-variants.js';
import { variantStateId, variantPublicationWrites, type VariantState } from '../src/discovery/variant-decision.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

// 4B.1 (codex-omg №11459 п.2): a real paid generation publishes its members and set, or no_variants, with the execution
// receipt and the next current state, in one atomic batch of the common managed lifecycle. The snapshot is the real 4T.1
// one over real paid assessments; frame/plan come from the named v7 fixture; the mode row is an explicit control fixture.
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const judgement = { conclusion: 'Bounded by the actual sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the saved sweep'], quantity: null };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'One shared scale from low to high']));
function generation(count: number, recommend = count - 1) {
  const variants = Array.from({ length: count }, (_, i) => ({ key: `v${i + 1}`, title: `Variant ${i + 1}`, proposal: { scope: `scope-${i + 1}` }, criteria }));
  return { action: 'variants', variants, scale, comparison: `${count} bounded variants on one scale`,
    recommendation: { key: `v${recommend + 1}`, reason: 'Fits the snapshot best' }, searchLimits: ['Only the saved sweep'], unknowns: [] };
}
const none = (grounds: Ref[]) => ({ action: 'no_variants', reasons: [{ code: 'snapshot_insufficient', message: 'The sweep supports no bounded variant', grounds }],
  searchLimits: ['Only the saved sweep'], unknowns: ['Demand stays unknown'] });

async function setup(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-4b1-' }), project = 'p';
  const runs = new Map<string, string>();
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const runId = runs.get(selected.planAnswer.hash);
    const run = runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({ id: `research-run:${rand()}`, kind: 'research-run', expected: 0,
      value: { projectId: project, draftId: draft.id, environment: reference(f.environment), turns: 0, limit: 100, requestChars: 0,
        owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run), draft: reference(draft),
      question: reference(question), role: f.environment.value.implementer, dispatch: f.environment.value, profile: null,
      cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input);
    const invoke = () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const entry = await produce(g, undefined, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Real paid assessment'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }],
      accepted: [], rejected: [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
      methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
    const paid = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
    applyDiscoveryAssessment(f.store, project, reference(paid));
  }
  const saved = produceVariantSnapshot(f.store, project).record;
  const mode = f.store.write({ id: 'mode-fixture:p', kind: 'mode-fixture', expected: 0, value: { projectId: project, mode: 'questions' } });
  const cal = f.store.write({ id: 'transport-fixture:calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  const calibration: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(cal), mode: reference(mode), expectedSelection: null };
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: generation(1) }));
  await researchCall(f.environment.value.implementer, f.environment.value, 'Calibrate variants', { variantSubject: calibration, history: [] }, undefined,
    { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  const input = { projectId: project, variantSubject: { ...calibration, snapshot: reference(saved) }, environment: f.environment,
    role: f.environment.value.implementer, prompt: 'Propose variants from this exact saved sweep' };
  const reply = (answer: unknown) => writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: answer }));
  /** The real managed paid call, without its application: the paid answer is saved before anything is published. */
  async function pay(store = f.store) {
    const prepared = prepareVariantSession(store, input), v = prepared.intent.value;
    await researchCall(v.role, v.dispatch, v.cursor.prompt, v.cursor.context, undefined,
      { store, draftId: v.draft.id, questionId: v.question.id, purpose: v.kind, consumerIntent: reference(prepared.intent), session: v.owner });
    return store.get<ResearchConsumerIntent>(prepared.intent.id)!;
  }
  return { ...g, project, input, mode, saved, reply, pay };
}

for (const count of [1, 2, 3]) {
  test(`4B.1: a real paid generation of ${count} variant(s) publishes members, set, receipt and current state in one batch of the common lifecycle`, async t => {
    const f = await setup(t);
    f.reply(generation(count));
    const running = await f.pay(), before = history(f.store), sent = f.wires().length;
    const batches: string[][] = [], write = f.store.writeMany.bind(f.store);
    f.store.writeMany = ((writes, guards = []) => { batches.push(writes.map(item => item.kind)); return write(writes, guards); }) as typeof f.store.writeMany;
    const receipt = applyVariantSession(f.store, f.project, reference(running));
    f.store.writeMany = write;
    assert.deepEqual(batches, [['discovery-variant-session', ...Array(count).fill('discovery-variant'), 'discovery-variant-set', 'discovery-variant-state', 'research-consumer-intent']],
      'one atomic batch: receipt, members, set, state and the terminal intent');
    assert.equal(f.wires().length, sent, 'publication pays nothing');
    const applied = f.store.get<ResearchConsumerIntent>(running.id)!;
    assert.deepEqual([applied.value.state, applied.revision], ['applied', running.revision + 1]);
    assert.deepEqual(applied.value.outputs![0], reference(receipt));
    const set = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === f.project)!;
    const members = set.value.members.map(ref => f.store.get<DiscoveryVariant>(ref.id, ref.revision)!);
    assert.deepEqual(members.map(member => member.value.key), Array.from({ length: count }, (_, i) => `v${i + 1}`));
    for (const member of members) {
      assert.equal(member.id, variantRecordId('discovery-variant', member.value));
      assert.deepEqual([member.value.scale, member.value.origin], [set.value.scale, set.value.origin], 'one shared scale and producer');
    }
    assert.deepEqual(set.value.recommendation.member, reference(members[count - 1]!), 'the recommendation names the exact member of its key');
    assert.deepEqual(set.value.origin, { intent: reference(running), call: receipt.value.result!.call, response: receipt.value.result!.response },
      'origin names the running intent, not the terminal written beside it');
    const state = f.store.get<VariantState>(variantStateId(f.project, receipt.value.draft.id))!;
    assert.deepEqual([state.revision, state.value.result, state.value.set, state.value.decision, state.value.previous, state.value.mode],
      [1, reference(set), reference(set), null, null, f.input.variantSubject.mode]);
    assert.deepEqual(applied.value.outputs, [reference(receipt), ...members.map(reference), reference(set), reference(state)]);
    const proven = readVariantGeneration(f.store, f.project, reference(set));
    assert.equal(proven.verification, 'proven');
    assert.deepEqual([proven.session, proven.state], [receipt, reference(state)]);
    assert.ok(history(f.store).length > before.length);
  });
}

test('4B.1: no_variants is its own record — no member, no empty set — published with its receipt and a state without a set', async t => {
  const f = await setup(t);
  f.reply(none([reference(f.saved)]));
  const running = await f.pay(), receipt = applyVariantSession(f.store, f.project, reference(running));
  assert.deepEqual(f.store.list('discovery-variant').filter(row => (row.value as any).projectId === f.project), []);
  assert.deepEqual(f.store.list('discovery-variant-set').filter(row => (row.value as any).projectId === f.project), []);
  const [result] = f.store.list<any>('discovery-variant-none').filter(row => row.value.projectId === f.project);
  assert.ok(result);
  assert.deepEqual(result.value.reasons[0].grounds, [reference(f.saved)]);
  const state = f.store.get<VariantState>(variantStateId(f.project, receipt.value.draft.id))!;
  assert.deepEqual([state.value.result, state.value.set, state.value.decision], [reference(result), null, null]);
  assert.deepEqual(readVariantGeneration(f.store, f.project, reference(result)).state, reference(state));
});

test('4B.1: a break after payment publishes later in a new Store without another payment; a cold exact repeat writes and pays nothing', async t => {
  const f = await setup(t);
  f.reply(generation(2));
  const running = await f.pay(), sent = f.wires().length;
  // The process stops between the paid answer and its publication: nothing of the product exists yet.
  assert.deepEqual(f.store.list('discovery-variant-set').filter(row => (row.value as any).projectId === f.project), []);
  f.reply(generation(3));
  const cold = f.open();
  const receipt = applyVariantSession(cold, f.project, reference(running));
  assert.equal(f.wires().length, sent, 'the publication uses the saved paid answer');
  const set = cold.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === f.project)!;
  assert.equal(set.value.members.length, 2, 'the saved answer, not the adapter\'s current one');
  const snapshot = history(cold);
  for (const store of [cold, f.open()]) {
    assert.deepEqual(applyVariantSession(store, f.project, reference(store.get<ResearchConsumerIntent>(running.id)!)), receipt);
    assert.deepEqual(await runVariantSession(store, f.input), receipt);
    assert.deepEqual(readVariantExecutionSession(store, f.project, reference(receipt)), receipt);
    assert.equal(readVariantGeneration(store, f.project, reference(set)).verification, 'proven');
  }
  assert.deepEqual(history(cold), snapshot);
  assert.equal(f.wires().length, sent);
});

for (const conflict of ['another current selection', 'a moved mode'] as const) {
  test(`4B.1: ${conflict} keeps the newer choice: the paid result is published under its original subject without a current state`, async t => {
    const f = await setup(t);
    f.reply(generation(2));
    const running = await f.pay(), sent = f.wires().length;
    const draft = prepareVariantSession(f.store, f.input).session.value.draft;
    const stateId = variantStateId(f.project, draft.id);
    let moved: Ref;
    if (conflict === 'another current selection') {
      // A concurrent writer published a state for this draft after the dispatch, which expected none.
      moved = reference(f.store.write({ id: stateId, kind: 'discovery-variant-state', expected: 0, value: { fixture: 'concurrent state' } }));
    } else moved = reference(f.store.write({ id: f.mode.id, kind: f.mode.kind, expected: f.mode.revision, value: { projectId: f.project, mode: 'bypass' } }));
    const stateBefore = f.store.get(stateId);
    const receipt = applyVariantSession(f.store, f.project, reference(running));
    assert.deepEqual(reference(f.store.get(moved.id)!), moved, 'the newer selection or mode stays as it was');
    assert.deepEqual(f.store.get(stateId), stateBefore, 'no current state is written over it');
    const set = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === f.project)!;
    const applied = f.store.get<ResearchConsumerIntent>(running.id)!;
    assert.deepEqual(applied.value.outputs, [reference(receipt), ...set.value.members, reference(set)]);
    const proven = readVariantGeneration(f.store, f.project, reference(set));
    assert.deepEqual([proven.verification, proven.state], ['proven', null]);
    assert.deepEqual(proven.session.value.variantSubject, f.input.variantSubject, 'under its original subject');
    assert.equal(f.wires().length, sent);
    const cold = f.open(), snapshot = history(cold);
    assert.deepEqual(readVariantExecutionSession(cold, f.project, reference(receipt)), receipt);
    assert.deepEqual(history(cold), snapshot);
  });
}

test('4B.1: a forged member, recommendation or origin proves no set, and the lifecycle applies only the batch its paid answer projects', async t => {
  const f = await setup(t);
  f.reply(generation(2));
  const running = await f.pay();
  // The application door refuses any other publication than the projection of the paid answer.
  const paid = readResearchConsumerExecution(f.store, f.project, reference(running));
  assert.equal(paid.kind, 'response');
  if (paid.kind !== 'response') return;
  const owner = f.store.get<VariantExecutionSession>(running.value.owner.id, running.value.owner.revision)!;
  const receiptValue = projectPaidVariantSession(owner, running, { call: reference(paid.call), response: paid.response, payload: paid.payload });
  const product = variantPublicationWrites(f.store, receiptValue, paid.payload);
  const receiptWrite = { id: owner.id, kind: owner.kind, expected: owner.revision, value: receiptValue };
  const tampered: [string, any[]][] = [
    ['a member with another title', product.writes.map((write, i) => i === 0 ? { ...write, value: { ...(write.value as any), title: 'Forged' } } : write)],
    ['a missing state', product.writes.slice(0, -1)],
    ['no publication at all (the 4T.4 execution-only form)', []],
  ];
  const before = history(f.store);
  for (const [note, writes] of tampered)
    assert.throws(() => prepareResearchConsumerApplication(f.store, reference(running), reference(paid.call), [receiptWrite, ...writes] as any,
      [reference(owner), ...product.guards]), code('research_consumer_intent_invalid'), note);
  assert.deepEqual(history(f.store), before);
  const receipt = applyVariantSession(f.store, f.project, reference(running));
  const set = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === f.project)!;
  const [first, second] = set.value.members.map(ref => f.store.get<DiscoveryVariant>(ref.id, ref.revision)!);
  const forge = <T extends { projectId: string }>(kind: string, value: T) =>
    reference(f.store.write({ id: variantRecordId(kind, value), kind, expected: 0, value: value as unknown as Json }));
  const otherRecommendation = forge('discovery-variant-set', { ...set.value, recommendation: { member: reference(first!), reason: 'Forged' } });
  const forgedMember = forge('discovery-variant', { ...first!.value, title: 'Forged member' });
  const otherMember = forge('discovery-variant-set', { ...set.value, members: [forgedMember, reference(second!)], recommendation: { member: reference(second!), reason: set.value.recommendation.reason } });
  const otherOrigin = forge('discovery-variant-set', { ...set.value, origin: { ...set.value.origin, call: receipt.value.result!.response } });
  for (const [note, ref] of [['another recommendation', otherRecommendation], ['a forged member', otherMember], ['another origin', otherOrigin]] as const)
    assert.throws(() => readVariantGeneration(f.store, f.project, ref), (error: unknown) => error instanceof EngineError, note);
  assert.equal(readVariantGeneration(f.store, f.project, reference(set)).verification, 'proven');
  assert.ok(canonical(set.value.recommendation.member) === canonical(reference(second!)));
});


test('4B.1: a real project-mode record is proved by its own reader; a forged one of that kind is refused before any intent', async t => {
  const f = await setup(t);
  const forged = f.store.write({ id: 'project-mode:p', kind: 'project-mode', expected: 0, value: { projectId: f.project, mode: 'questions' } });
  const before = history(f.store);
  assert.throws(() => prepareVariantSession(f.store, { ...f.input, variantSubject: { ...f.input.variantSubject, mode: reference(forged) } }),
    (error: unknown) => error instanceof EngineError && error.code.startsWith('project_mode_'));
  assert.deepEqual(history(f.store), before);
});

test('4B1-01: the common door derives the guards of an admitted state itself — a caller without the mode guard still meets it', async t => {
  const f = await setup(t);
  f.reply(generation(2));
  const running = await f.pay(), sent = f.wires().length;
  const paid = readResearchConsumerExecution(f.store, f.project, reference(running));
  assert.equal(paid.kind, 'response');
  if (paid.kind !== 'response') return;
  const owner = f.store.get<VariantExecutionSession>(running.value.owner.id, running.value.owner.revision)!;
  const receiptValue = projectPaidVariantSession(owner, running, { call: reference(paid.call), response: paid.response, payload: paid.payload });
  const product = variantPublicationWrites(f.store, receiptValue, paid.payload);
  assert.equal(product.admitted, true);
  // The caller names only the owner guard; the prepared batch still carries the exact mode the state is admitted on.
  const batch = prepareResearchConsumerApplication(f.store, reference(running), reference(paid.call),
    [{ id: owner.id, kind: owner.kind, expected: owner.revision, value: receiptValue }, ...product.writes] as any, [reference(owner)]);
  assert.ok(batch.guards.some(guard => canonical(guard) === canonical(f.input.variantSubject.mode)), 'the mode guard is derived, not trusted');
  // A second Store moves the mode between preparation and the write.
  const other = f.open(), mode = other.get(f.mode.id)!;
  const moved = other.write({ id: mode.id, kind: mode.kind, expected: mode.revision, value: { projectId: f.project, mode: 'bypass' } });
  const before = history(f.store);
  assert.throws(() => f.store.writeMany(batch.writes, batch.guards), code('input_stale'));
  assert.deepEqual(history(f.store), before, 'no part of the publication is written');
  // The lawful recovery keeps the paid result under its original subject, without the state and without a new payment.
  const receipt = applyVariantSession(f.store, f.project, reference(running));
  assert.deepEqual(reference(f.store.get(f.mode.id)!), reference(moved), 'the newer mode stays');
  assert.equal(f.store.get(variantStateId(f.project, receipt.value.draft.id)), null);
  assert.equal(f.wires().length, sent);
});

for (const damage of ['a missing state', 'a substituted state'] as const)
  test(`4B1-02: ${damage} named by the terminal intent proves neither the result nor the receipt, hot and cold`, async t => {
    const f = await setup(t);
    f.reply(generation(2));
    const running = await f.pay(), sent = f.wires().length;
    const paid = readResearchConsumerExecution(f.store, f.project, reference(running));
    assert.equal(paid.kind, 'response');
    if (paid.kind !== 'response') return;
    const owner = f.store.get<VariantExecutionSession>(running.value.owner.id, running.value.owner.revision)!;
    const receiptValue = projectPaidVariantSession(owner, running, { call: reference(paid.call), response: paid.response, payload: paid.payload });
    const product = variantPublicationWrites(f.store, receiptValue, paid.payload, true);
    const refOf = (write: { id: string; expected: number; value: unknown }) => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value as Json) });
    const receiptWrite = { id: owner.id, kind: owner.kind, expected: owner.revision, value: receiptValue };
    // Negative corruption after a real payment, bypassing the door: the terminal names the expected state.
    const kept = damage === 'a missing state' ? product.writes.slice(0, -1)
      : [...product.writes.slice(0, -1), { ...product.state, value: { ...(product.state.value as any), mode: f.saved ? reference(f.saved) : null } }];
    const outputs = [refOf(receiptWrite), ...product.writes.map(refOf)];
    f.store.writeMany([receiptWrite, ...kept, { id: running.id, kind: running.kind, expected: running.revision,
      value: { ...running.value, state: 'applied', outputs } }] as any, []);
    const set = product.publication.result.ref, receipt = refOf(receiptWrite);
    const before = history(f.store);
    for (const store of [f.store, f.open()]) {
      assert.throws(() => readVariantGeneration(store, f.project, set), code('discovery_variant_session_invalid'));
      assert.throws(() => readVariantExecutionSession(store, f.project, receipt), code('discovery_variant_session_invalid'));
    }
    assert.deepEqual(history(f.store), before);
    assert.equal(f.wires().length, sent);
  });

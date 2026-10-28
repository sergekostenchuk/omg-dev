import { readResearchAssessmentWithHandoffAt } from '../src/discovery/research-assessment.js';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, type Json } from '../src/canonical.js';
import { reference, type StageArtifact } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { EngineError } from '../src/errors.js';
import { ProductEngine } from '../src/product/engine.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { Store, observeStore, type Write, type TransactionGuard, type Revision } from '../src/storage/store.js';
import { stopRun } from '../src/om/run-control.js';
import { readResearchRun } from '../src/discovery/projection-reader.js';
import { readRunnerFinalizationAt } from '../src/discovery/discovery-finalization-runner.js';
import { readDiscoveryHandoffAt, withDiscoveryHandoffAt } from '../src/discovery/discovery-handoff.js';
import { researchPrerequisitesAt } from '../src/discovery/research-context.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { finalizationWorld, finalizationAdapter } from './discovery-v7-b1-finalization-fixture.js';
import { modeOf, money } from './discovery-v7-dossier-seed.js';
import { preparedField } from './preparation-fixture.js';
import { storeUnchanged } from './store-unchanged.js';

// Each checkpoint is built through the real Driver inside its first test. Keep its
// original paid commands alive until the file ends; every consumer gets its own DB.
const checkpointCleanup: (() => unknown)[] = [];
after(async () => { for (const cleanup of checkpointCleanup.reverse()) await cleanup(); });
function checkpoint<T extends Awaited<ReturnType<typeof finalizationWorld>>>(build: (t: test.TestContext) => Promise<T>) {
  let ready: Promise<T> | undefined;
  return async (t: test.TestContext) => {
    const owner = new Proxy(t, { get(target, key) {
      if (key === 'after') return (cleanup: () => unknown) => checkpointCleanup.push(cleanup);
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const source = await (ready ??= build(owner));
    const directory = mkdtempSync(join(tmpdir(), 'omg-c2-checkpoint-')), path = join(directory, 'state.sqlite');
    const database = new DatabaseSync(source.store.path);
    try { database.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); } finally { database.close(); }
    const stores: Store[] = [], open = () => { const store = new Store(path); stores.push(store); return store; };
    const store = open(), engine = new ProductEngine(store);
    t.after(() => { for (const opened of stores) opened.close(); rmSync(directory, { recursive: true, force: true }); });
    // Wire checks read the actual original command's trace, so an accidental send
    // from a cold copy cannot hide behind a copied but unused trace file.
    return { ...source, store, engine, discovery: engine.discovery, open };
  };
}

async function world(t: test.TestContext) {
  const f = await finalAssessmentPaid(t, { form: V9_FINAL_CONTRACT }); modeOf(f.store, 'bypass');
  const accepted = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Use this exact product' });
  assert.ok(accepted.accepted);
  const manifest = reference(accepted.accepted.manifest), engine = new ProductEngine(f.open());
  const draft = await engine.prepareAcceptedConsumer('p', 'concept', manifest);
  const h = await readDiscoveryHandoffAt(engine.store, 'p', reference(draft));
  for (const id of draft.value.questions) {
    const q = engine.store.get<Question>(id)!;
    let value = JSON.parse(JSON.stringify(preparedField('p', q.value.spec.field)).replaceAll('p-user', 'operator').replaceAll('p-result', 'record'));
    if (q.value.spec.field === 'conceptSections') value[0].requirements[0].applications = [h.catalogue.variant, ...h.catalogue.constraints]
      .map(entry => ({ contract: 'basis-application/v1', basis: entry.address, appliedAt: ['/0/requirements/0/statement'] }));
    await engine.execute({ type: 'answer-decision', question: id, expected: q.revision, value });
  }
  const artifact = await engine.execute({ type: 'draft-stage', project: 'p', stage: 'concept', draftId: draft.id, expected: 0 }) as any;
  return { f, engine, draft: engine.store.get<DiscoveryDraft>(draft.id)!, manifest, h, artifact };
}

test('C2 recovery: historic Discovery heads may advance but the saved concept root and its exact proofs remain unchanged', async t => {
  const { f, engine, draft, manifest, h, artifact } = await world(t);
  const prior = f.store.get<DiscoveryDraft>(h.source.grounds.draft.id)!;
  const q = prior.value.questions.map(id => f.store.get<Question>(id)!).find(row => row.value.spec.field === 'frame')!;
  f.discovery.reopen(q.id, q.revision);
  assert.notDeepEqual(reference(f.store.get(q.id)!), reference(q));
  const cold = new ProductEngine(f.open());
  await cold.execute({ type: 'accept-stage', project: 'p', stage: 'concept', expected: artifact.revision });
  const accepted = cold.store.get<StageArtifact>('stage:p:concept')!;
  assert.equal(accepted.value.status, 'accepted');
  assert.deepEqual(accepted.value.inputs, [manifest]);
  assert.ok(accepted.value.proofs.some(ref => canonical(ref) === canonical(h.source.grounds.draft)));
  const before = canonical(money(f.store)), wire = canonical(f.wires());
  assert.deepEqual(await storeUnchanged(cold.store, () => researchPrerequisitesAt(cold.store, 'p', reference(draft))),
    await researchPrerequisitesAt(engine.store, 'p', reference(draft)));
  assert.equal(canonical(money(f.store)), before); assert.equal(canonical(f.wires()), wire);
  const stripped = structuredClone(accepted.value);
  delete (stripped.content as Record<string, Json>).discoveryHandoff;
  const tampered = f.open();
  tampered.write({ id: accepted.id, kind: accepted.kind, expected: accepted.revision, value: stripped });
  await withDiscoveryHandoffAt(tampered, 'p', reference(draft), () => storeUnchanged(tampered, () => {
    assert.throws(() => new ProductEngine(tampered).pipeline.inspect('p', 'concept'),
      (error: unknown) => error instanceof EngineError && error.code === 'discovery_handoff_invalid');
  }));
});

test('C2 recovery: missing or substituted binding refuses without writes, and a second Store changing a concept question loses acceptance CAS', async t => {
  const { f, engine, draft, artifact, manifest } = await world(t);
  const cold = new ProductEngine(f.open());
  assert.throws(() => cold.pipeline.inspect('p', 'concept'), (e: any) => e.code === 'discovery_handoff_proof_required');
  await withDiscoveryHandoffAt(cold.store, 'p', reference(draft), () => storeUnchanged(cold.store, () => {
    const content = structuredClone(artifact.value.content);
    delete content.discoveryHandoff;
    assert.throws(() => cold.pipeline.draft('p', 'concept', content as Json, artifact.revision), (e: any) => e.code === 'discovery_handoff_invalid');
    content.discoveryHandoff = { ...draft.value.discoveryHandoff, manifest: { ...manifest, hash: 'f'.repeat(64) } };
    assert.throws(() => cold.pipeline.draft('p', 'concept', content as Json, artifact.revision), (e: any) => e.code === 'discovery_handoff_invalid');
  }));
  const other = f.open(); let moved = false;
  const observer = observeStore({ begin() { return undefined; }, end() {}, untraced() {}, write(store) {
    if (store !== engine.store || moved) return;
    moved = true;
    const question = other.get<Question>(draft.value.questions[0]!)!;
    new ProductEngine(other).discovery.reopen(question.id, question.revision);
  } });
  try {
    await assert.rejects(async () => engine.execute({ type: 'accept-stage', project: 'p', stage: 'concept', expected: artifact.revision }),
      (e: unknown) => e instanceof EngineError && e.code === 'input_stale');
    assert.equal(moved, true);
    assert.equal(engine.store.get<StageArtifact>('stage:p:concept')!.value.status, 'draft');
  } finally { observeStore(observer); }
});

const authoredFinalCheckpoint = checkpoint(async t => {
  const f = await finalizationWorld(t); modeOf(f.store, 'bypass'); await finalizationAdapter(f, 'go');
  const instruction = f.discovery.evidence.document('p', 'concept-instruction',
    'The accepted ledger serves an operator who records transactions.', 'text/plain', 0);
  const citations = [{ source: reference(instruction), selector: { kind: 'text-range', start: 0, end: instruction.value.content.length } }];
  const path = join(f.root, 'adapter.mjs'), output = 'console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,';
  const script = readFileSync(path, 'utf8'); assert.ok(script.includes(output));
  writeFileSync(path, script.replace(output, `if(r.subject.stage==='concept'||r.subject.question?.field==='audience'){
if(r.subject.role==='assess-answer')research={verdict:'supported',reasons:['Matches the accepted complete concept basis']};
else research={action:'answer',question:r.subject.question.id,value:'Operator of the accepted ledger',citations:${JSON.stringify(citations)}};}
${output}`));
  const before = new Set(f.store.list('model-call').map(row => row.id));
  const request = { project: 'p', draftId: f.packet.subject.basis.draft.id, maxTurns: 8, maxCalls: 1 };
  const result = await new EarlyStageDriver(f.engine, undefined, { discovery: 7 }).run(request);
  const discovery = readResearchRun(f.store, 'p', request.draftId)!;
  const final = await readRunnerFinalizationAt(f.store, 'p', reference(discovery));
  return { ...f, result, final, before: [...before] };
});

test('C2 Driver: one call saves the real D7 before independent assessment and concept continuation', async t => {
  const f = await authoredFinalCheckpoint(t);
  assert.equal(f.result.budget.callsMade, 1, canonical(f.result));
  assert.equal(f.final.status, 'assessing'); assert.ok(f.final.final); assert.equal(f.final.assessment, null);
  assert.equal(f.store.list('model-call').filter(row => !f.before.includes(row.id)).length, 1);
  assert.equal(f.store.list<DiscoveryDraft>('discovery-draft').some(row => row.value.stage === 'concept'), false);
});

const conceptCheckpoint = checkpoint(async t => {
  const f = await authoredFinalCheckpoint(t);
  const result = await new EarlyStageDriver(f.engine, undefined, { discovery: 7 }).run({
    project: 'p', draftId: f.packet.subject.basis.draft.id, maxTurns: 8, maxCalls: 2 });
  const discovery = readResearchRun(f.store, 'p', f.packet.subject.basis.draft.id)!;
  const final = await readRunnerFinalizationAt(f.store, 'p', reference(discovery));
  const concepts = f.store.list<DiscoveryDraft>('discovery-draft').filter(row => row.value.stage === 'concept');
  return { ...f, result, final, draftId: concepts[0]!.id,
    finals: f.store.list('discovery-final-result').map(reference) };
});

test('C2 Driver: D7 assessment and one pinned concept share the remaining physical allowance', async t => {
  const f = await conceptCheckpoint(t), { result, final, before } = f;
  const concepts = f.store.list<DiscoveryDraft>('discovery-draft').filter(row => row.value.stage === 'concept');
  assert.equal(final.status, 'accepted'); assert.equal(final.view.next, 'concept');
  assert.equal(concepts.length, 1, canonical(result));
  assert.deepEqual(concepts[0]!.value.discoveryHandoff!.manifest, final.view.manifest);
  assert.equal(result.budget.callsMade, 2, canonical(result));
  assert.equal(f.store.list('model-call').filter(row => !before.includes(row.id)).length, 3);
});

test('C2 Driver: a cold stopped copy restores the paid concept response and its historical reader without repaying D7', async t => {
  const f = await conceptCheckpoint(t), { draftId, finals, final } = f;
  const coldEngine = new ProductEngine(f.open());
  let cut = false;
  const write = Store.prototype.writeMany;
  const hook = t.mock.method(Store.prototype, 'writeMany', function<T>(this: Store, rows: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (this === coldEngine.store && !cut && rows.some(row => row.kind === 'research-assessment')) {
      cut = true; throw new EngineError('injected_write_failure', 'Cut after the paid concept assessment response');
    }
    return write.call(this, rows, guards) as Revision<T>[];
  });
  try { await new EarlyStageDriver(coldEngine, undefined, { discovery: 7 }).run({ project: 'p', draftId, maxTurns: 1, maxCalls: 1 }); }
  finally { hook.mock.restore(); }
  assert.equal(cut, true);
  assert.equal(stopRun(f.open(), { project: 'p' }).ok, true);
  const paid = canonical(money(f.store)), paidWires = canonical(f.wires());
  const next = await new EarlyStageDriver(new ProductEngine(f.open()), undefined, { discovery: 7 })
    .run({ project: 'p', draftId, maxTurns: 4, maxCalls: 8 });
  assert.equal(next.end, 'stopped', canonical(next));
  assert.equal(next.stage, 'concept', canonical(next));
  assert.equal(next.draft?.id, draftId, canonical(next));
  assert.equal(next.budget.callsMade, 0);
  assert.equal(canonical(money(f.store)), paid); assert.equal(canonical(f.wires()), paidWires);
  assert.equal(f.store.list<DiscoveryDraft>('discovery-draft').filter(row => row.value.stage === 'concept').length, 1);
  assert.deepEqual(f.store.list('discovery-final-result').map(reference), finals);
  const h = await readDiscoveryHandoffAt(f.open(), 'p', reference(f.store.get<DiscoveryDraft>(draftId)!));
  assert.deepEqual(h.source.manifest, final.view.manifest);
  const binding = f.store.list<any>('research-assessment-binding').find(row => row.value.draft.id === draftId);
  assert.ok(binding, canonical(next));
  for (const invalid of [null, [], {}, undefined]) await assert.rejects(
    storeUnchanged(f.store, () => readResearchAssessmentWithHandoffAt(f.store, 'p', binding.value.turn.id, invalid as any)),
    (error: unknown) => error instanceof EngineError && error.code === 'research_assessment_binding_invalid');
  const history = canonical(money(f.store)), wire = canonical(f.wires());
  const assessed = await storeUnchanged(f.store, () => readResearchAssessmentWithHandoffAt(f.store, 'p', binding.value.turn.id, binding.value.assessment));
  const original = f.store.get<DiscoveryDraft>(h.source.grounds.draft.id)!;
  const frame = original.value.questions.map(id => f.store.get<Question>(id)!).find(row => row.value.spec.field === 'frame')!;
  f.discovery.reopen(frame.id, frame.revision);
  const cold = f.open();
  assert.deepEqual(await storeUnchanged(cold, () => readResearchAssessmentWithHandoffAt(cold, 'p', binding.value.turn.id, binding.value.assessment)), assessed);
  assert.equal(canonical(money(f.store)), history); assert.equal(canonical(f.wires()), wire);
});

const negativeCheckpoint = checkpoint(async t => {
  const f = await finalizationWorld(t); modeOf(f.store, 'bypass'); await finalizationAdapter(f, 'no_go');
  const request = { project: 'p', draftId: f.packet.subject.basis.draft.id, maxTurns: 8, maxCalls: 8 };
  const first = await new EarlyStageDriver(f.engine, undefined, { discovery: 7 }).run(request);
  return { ...f, first, request };
});

test('C2 Driver: a real paid negative D7 is accepted as no_go and creates no concept', async t => {
  const f = await negativeCheckpoint(t);
  assert.equal(f.first.end, 'no_go', canonical(f.first));
  assert.equal(f.store.list<DiscoveryDraft>('discovery-draft').some(row => row.value.stage === 'concept'), false);
});

test('C2 Driver: a cold copy keeps its accepted negative D7 without new payment or concept', async t => {
  const f = await negativeCheckpoint(t), { request } = f;
  const before = canonical(money(f.store)), wire = canonical(f.wires());
  for (const engine of [new ProductEngine(f.open())]) {
    const repeated = await new EarlyStageDriver(engine, undefined, { discovery: 7 }).run(request);
    assert.equal(repeated.end, 'no_go');
    assert.equal(f.store.list<DiscoveryDraft>('discovery-draft').some(row => row.value.stage === 'concept'), false);
  }
  assert.equal(canonical(money(f.store)), before); assert.equal(canonical(f.wires()), wire);
});

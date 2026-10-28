import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoveryFixture, validFrame } from './discovery-v7-fixture.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import type { Question } from '../src/discovery/discovery.js';
import { reference } from '../src/pipeline/contracts.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store } from '../src/storage/store.js';
import { EngineError } from '../src/errors.js';

async function restored(work: Promise<unknown>) {
  try { await work; }
  catch (error) { if (!(error instanceof EngineError && error.code === 'research_restore_complete')) throw error; }
}

/** A frame-only scenario deliberately cannot answer the next plan. Every saved
 * response and acceptance is produced by the ordinary runner; cuts only throw. */
async function fixture(t: TestContext) {
  const f = discoveryFixture(t, 'omg-b0-recovery-', true), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  writeFileSync(wire, '');
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research={action:'pause',reason:'Frame-only scenario'};
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.questions?.[0]?.field==='frame')research={action:'answer',question:c.questions[0].id,value:${JSON.stringify(validFrame())},
citations:[{source:c.request.brief.observation.source,selector:c.request.brief.observation.selector}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  f.engine.execute({ type: 'create-project', project: 'p', title: 'B0 recovery' });
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 20_000 }, 0);
  const probe = f.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'string' } }], [], 6);
  for (const purpose of ['analyst', 'assessor'] as const)
    await researchCall(environment.value[purpose === 'analyst' ? 'implementer' : 'reviewer'], environment.value,
      'Calibrate', {}, undefined, { store: f.store, draftId: probe.id, questionId: probe.value.questions[0]!, purpose });
  const draft = createPartialV7Draft(f.discovery, 'p', 'concept');
  const q = (field: string, store = f.store) => draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
  const text = 'Keep materials, equipment and subcontractor settlements in the company ERP';
  const source = f.discovery.evidence.document('p', 'owner', text, 'text/plain', 0);
  f.discovery.fact(q('brief').id, q('brief').revision, reference(source), { kind: 'text-range', start: 0, end: text.length });
  f.discovery.decision(q('objective').id, q('objective').revision, 'owner', 'Reduce losses by 20%');
  return { ...f, draft, q, calls: () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).length - 2,
    run: (engine: ProductEngine, limit: number, restoreOnly = false) => engine.researcher.run('p', draft.id, limit, undefined,
      { producerPolicy: { discovery: 7 }, ...(restoreOnly ? { restoreOnly } : {}) }) };
}

for (const boundary of ['author-paid', 'assessor-paid', 'acceptance-written'] as const) {
  test(`B0 recovery: ${boundary} survives a cold restart without repurchasing the saved response`, { timeout: 60_000 }, async t => {
    const f = await fixture(t), write = f.store.writeMany.bind(f.store);
    let cut = false;
    f.store.writeMany = ((writes, guards = []) => {
      const hit = writes.some(w => boundary === 'author-paid' ? w.kind === 'research-turn' && w.expected === 0
        : w.kind === 'research-answer');
      if (!cut && hit) {
        cut = true;
        if (boundary === 'acceptance-written') write(writes, guards);
        throw new Error(`Cut ${boundary}`);
      }
      return write(writes, guards);
    }) as Store['writeMany'];
    await f.run(f.engine, 2); f.store.writeMany = write;
    assert.equal(cut, true);
    const paid = f.calls(); assert.equal(paid, boundary === 'author-paid' ? 1 : 2);
    if (boundary === 'acceptance-written') {
      const objective = f.q('objective'); f.discovery.reopen(objective.id, objective.revision);
    }
    const cold = new ProductEngine(f.open());
    await restored(f.run(cold, 10, true));
    assert.equal(f.calls(), paid);
    if (boundary === 'author-paid') await f.run(cold, 1);
    assert.equal(f.calls(), 2);
    assert.equal(f.q('frame', cold.store).value.status, 'answered');
    assert.equal(f.q('plan', cold.store).value.status, 'open');
    await restored(f.run(cold, 10, true));
    assert.equal(f.calls(), 2, 'Repeated restore remains free');
  });
}

test('B0 recovery: reopening the owner mandate preserves the paid result and forbids stale frame acceptance', { timeout: 60_000 }, async t => {
  const f = await fixture(t), write = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards = []) => {
    if (writes.some(w => w.kind === 'research-answer')) throw new Error('Cut before acceptance');
    return write(writes, guards);
  }) as Store['writeMany'];
  await f.run(f.engine, 2); f.store.writeMany = write;
  assert.equal(f.calls(), 2);
  const paid = f.store.list('model-response').map(reference);
  const owner = f.q('objective'); f.discovery.reopen(owner.id, owner.revision);
  const cold = new ProductEngine(f.open());
  await restored(f.run(cold, 10, true));
  assert.equal(f.calls(), 2);
  assert.equal(f.q('frame', cold.store).value.status, 'open');
  assert.deepEqual(cold.store.list('model-response').map(reference), paid);
  const currentObjective = f.q('objective', cold.store);
  cold.discovery.decision(currentObjective.id, currentObjective.revision, 'owner', 'Reduce losses by 25%');
  const frame = f.q('frame', cold.store); cold.discovery.reopen(frame.id, frame.revision);
  const resumed = await f.run(cold, 2);
  assert.equal(f.q('frame', cold.store).value.status, 'answered', JSON.stringify(resumed.value));
  assert.equal(f.calls(), 4, 'A new frame and assessment use the revised mandate; the old response is not repurchased');
});

test('B0: contractVersion alone cannot enable new entry calls without the trusted producer policy', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.researcher.run('p', f.draft.id, 10), { code: 'research_contract_upgrade_required' });
  assert.equal(f.calls(), 0);
  assert.equal(f.q('frame').value.status, 'open');
});

test('B0 recovery: a mandate reopened at the acceptance write refuses the whole new frame acceptance', { timeout: 60_000 }, async t => {
  const f = await fixture(t), write = f.store.writeMany.bind(f.store);
  let reopened = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!reopened && writes.some(w => w.kind === 'research-answer')) {
      reopened = true;
      const objective = f.q('objective');
      f.discovery.reopen(objective.id, objective.revision);
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  const result = await f.run(f.engine, 2); f.store.writeMany = write;
  assert.equal(reopened, true);
  assert.equal(f.calls(), 2);
  assert.equal(f.q('objective').value.status, 'open');
  assert.equal(f.q('frame').value.status, 'open', JSON.stringify(result.value));
  assert.equal(f.store.list('research-answer').length, 0);
  const cold = new ProductEngine(f.open());
  await restored(f.run(cold, 10, true));
  assert.equal(f.calls(), 2);
  assert.equal(f.q('frame', cold.store).value.status, 'open');
});

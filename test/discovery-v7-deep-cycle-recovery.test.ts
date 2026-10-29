import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import type { EarlyStageOutcome } from '../src/product/early-stage-driver.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { stopPass, resumeStoppedPass } from '../src/om/run-driver.js';
import { readResearchConsumerTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { readDeepResearchResult } from '../src/discovery/deep-research-execution.js';
import { deepCycleWorld, deepCycleMoney } from './discovery-v7-deep-cycle-fixture.js';

function stop(path: string) {
  const other = new Store(path);
  try { const result = stopPass(other, { project: 'p' }); assert.ok(result.ok);
    if (!result.ok) assert.fail(); return result.value.control!.value.stop!.token;
  } finally { other.close(); }
}
const intents = (store: Store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => row.value.cursor.deepResearchContract === 'deep-research-cycle/v1');
async function drive(engine: ProductEngine, draftId: string) {
  return await engine.execute({ type: 'early-stage-run', project: 'p', draftId, maxTurns: 1, maxCalls: 1 }) as EarlyStageOutcome;
}
function intercept(t: test.TestContext, store: Store, effect: (writes: Write[]) => void) {
  // Intercept the prototype so the genuine Store keeps its historical-read identity.
  const original = Store.prototype.writeMany;
  const mocked = t.mock.method(Store.prototype, 'writeMany', function<T>(this: Store, writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original.call(this, writes, guards) as Revision<T>[];
    if (this === store) effect(writes);
    return saved;
  });
  return () => mocked.mock.restore();
}
for (const cut of ['paid response', 'saved web capture'] as const) test(`deep cycle: stop after ${cut} restores paid state cold without wire or HTTP`, { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t), calls = f.store.list('model-call').length;
  let token: string | null = null;
  const restore = intercept(t, f.store, writes => {
    const hit = cut === 'paid response'
      ? writes.some(row => row.kind === 'model-response' && String((row.value as any).text).includes('web_search'))
      : writes.some(row => row.kind === 'web-capture');
    if (!token && hit) { token = stop(f.path); throw new EngineError('probe_deep_stop', 'Cut after durable paid output'); }
  });
  const first = await drive(f.engine, f.v.draft.id); restore();
  assert.ok(token); assert.equal(first.end, 'stopped', JSON.stringify(first));
  assert.equal(f.store.list('model-call').length, calls + 1);
  const cold = new Store(f.path); t.after(() => cold.close());
  const money = deepCycleMoney(cold), sent = f.wires().length, http = f.hits.length;
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await drive(new ProductEngine(cold), f.v.draft.id);
    assert.equal(result.end, 'stopped', JSON.stringify(result)); assert.equal(result.budget.callsMade, 0);
    assert.deepEqual(deepCycleMoney(cold), money); assert.equal(f.wires().length, sent); assert.equal(f.hits.length, http);
  }
  const paid = intents(cold).find(row => row.value.state === 'applied')!; assert.ok(paid);
  assert.equal(paid.value.outputs!.length, 2, 'An intermediate paid action never publishes an attempt');
  assert.equal(resumeStoppedPass(cold, { project: 'p', stop: token! }).ok, true);
  const result = await drive(new ProductEngine(cold), f.v.draft.id);
  assert.notEqual(result.end, 'blocked', JSON.stringify(result));
  assert.equal(f.hits.filter(path => path === '/search').length, 1, 'The saved capture is never fetched twice');
});
test('deep cycle: a real process cut restores the paid intermediate step without another model call', { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t), script = join(f.root, 'cut.mjs');
  const source = (name: string) => new URL(`../src/${name}.js`, import.meta.url).href;
  writeFileSync(script, `import {Store} from ${JSON.stringify(source('storage/store'))};
import {ProductEngine} from ${JSON.stringify(source('product/engine'))};
import {EngineError} from ${JSON.stringify(source('errors'))};
const store=new Store(${JSON.stringify(f.path)}), original=Store.prototype.writeMany;let cut=false;
Store.prototype.writeMany=function(writes,guards=[]){const saved=original.call(this,writes,guards);
 if(this===store&&!cut&&writes.some(row=>row.kind==='model-response'&&String(row.value.text).includes('web_search'))){cut=true;throw new EngineError('probe_deep_cut','Paid bytes saved before application');}return saved;};
await new ProductEngine(store).execute({type:'early-stage-run',project:'p',draftId:${JSON.stringify(f.v.draft.id)},maxTurns:1,maxCalls:1});
if(!cut)throw Error('The physical response cut was not reached');store.close();`);
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, child.stderr);
  const cold = new Store(f.path); t.after(() => cold.close());
  const intent = intents(cold)[0]!, money = deepCycleMoney(cold), sent = f.wires().length;
  assert.ok(intent.value.call); assert.equal(f.hits.length, 0);
  const engine = new ProductEngine(cold);
  await engine.researcher.run('p', f.v.draft.id, 1, undefined, { restoreOnly: true });
  assert.deepEqual(deepCycleMoney(cold), money); assert.equal(f.wires().length, sent);
  const applied = cold.get<ResearchConsumerIntent>(intent.id)!;
  assert.equal(applied.value.state, 'applied');
  const turn = cold.get(applied.value.outputs![1]!.id)!;
  assert.equal(readResearchConsumerTurn(cold, reference(turn)).value.status, 'completed');
  assert.equal(f.hits.filter(path => path === '/search').length, 1);
  const result = await drive(engine, f.v.draft.id);
  assert.notEqual(result.end, 'blocked', result.reason?.message);
  assert.equal(f.hits.filter(path => path === '/search').length, 1);
});


test('deep cycle: final answer application cut restores the completed attempt binding cold', { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t);
  for (let step = 0; step < 3; step++) await drive(f.engine, f.v.draft.id);
  let cut = false;
  const restore = intercept(t, f.store, writes => {
    if (!cut && writes.some(row => row.kind === 'research-attempt')) {
      cut = true; throw new EngineError('probe_deep_final_cut', 'Final attempt saved before its ordinary binding');
    }
  });
  try { await drive(f.engine, f.v.draft.id); } finally { restore(); }
  assert.ok(cut);
  const intent = intents(f.store).find(row => row.value.state === 'applied' && row.value.outputs?.length === 3)!;
  assert.ok(intent);
  const current = f.engine.environments.get('p');
  f.engine.environments.configure('p', { ...current.value,
    implementer: { ...current.value.implementer, actor: 'later-actor' } }, current.revision);
  const cold = new Store(f.path); t.after(() => cold.close());
  const money = deepCycleMoney(cold), sent = f.wires().length, http = [...f.hits];
  await new ProductEngine(cold).researcher.run('p', f.v.draft.id, 1, undefined, { restoreOnly: true });
  const result = readDeepResearchResult(cold, 'p', reference(cold.get<ResearchConsumerIntent>(intent.id)!));
  assert.equal(result.turn.value.status, 'completed');
  assert.equal(result.intent.value.role.actor, 'model-author');
  assert.deepEqual(deepCycleMoney(cold), money); assert.equal(f.wires().length, sent); assert.deepEqual(f.hits, http);
});

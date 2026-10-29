import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { canonical, hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { readResearchConsumerTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { archivedContext, contextValue } from '../src/discovery/working-context.js';
import { readV7AssessmentReplay } from '../src/discovery/v7-progress.js';
import { deepCycleWorld } from './discovery-v7-deep-cycle-fixture.js';

const cleanup: (() => unknown)[] = [];
const lifetime = { after: (work: () => unknown) => cleanup.push(work) } as unknown as TestContext;
after(async () => { for (const close of cleanup.reverse()) await close(); });
function snapshot(path: string) {
  const root = mkdtempSync(join(tmpdir(), 'omg-deep-cycle-cut-')), cut = join(root, 'state.sqlite');
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path); try { db.prepare('VACUUM INTO ?').run(cut); } finally { db.close(); }
  return cut;
}
const seed = async () => {
  const f = await deepCycleWorld(lifetime);
  return { f, path: snapshot(f.path) };
};
type World = Awaited<ReturnType<typeof seed>>;
const phases: Promise<World>[] = [];
function plant(built: World, t = lifetime) {
  const root = mkdtempSync(join(tmpdir(), 'omg-deep-cycle-step-')), path = join(root, 'state.sqlite');
  copyFileSync(built.path, path); const store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...built, path, store, engine };
}
const deepIntents = (store: Store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => row.value.cursor.deepResearchContract === 'deep-research-cycle/v1');
async function phase(index: number): Promise<World> {
  return phases[index] ??= (async () => {
    if (!index) return seed();
    const w = plant(await phase(index - 1)), before = w.store.list('model-call').length;
    const outcome = await w.engine.execute({ type: 'early-stage-run', project: 'p', draftId: w.f.v.draft.id, maxTurns: 8, maxCalls: 1 }) as any;
    assert.equal(outcome.end, 'stage_paused', JSON.stringify(outcome));
    assert.ok(outcome.stageResult?.research, 'The pause retains its saved continuation');
    assert.equal(outcome.budget.callsMade, 1);
    assert.equal(w.store.list('model-call').length - before, 1, 'The ordinary Driver retains its one-call allowance');
    return { f: w.f, path: snapshot(w.path) };
  })();
}
test('deep cycle: real sweep and owner choice reach a missing cell before any web source exists', { timeout: 60000 }, async () => {
  const w = plant(await phase(0));
  assert.equal(deepIntents(w.store).length, 0);
  assert.equal(w.store.list<any>('source').filter(row => row.value.origin.kind === 'web').length, 0);
});
for (const [index, action] of ['web_search', 'web_fetch', 'read_source', 'answer'].entries()) {
  test(`deep cycle: ordinary Driver performs ${action} on the same exact cell`, { timeout: 60000 }, async () => {
    const w = plant(await phase(index + 1)), intents = deepIntents(w.store);
    assert.equal(intents.filter(row => row.value.state === 'applied').length, index + 1);
    assert.equal(new Set(intents.map(row => canonical(row.value.cursor.deepPreparation))).size, 1);
    const current = intents.find(row => row.value.cursor.deepHistory.length === index)!;
    const turn = readResearchConsumerTurn(w.store, reference(w.store.get(current.value.outputs![1]!.id)!));
    assert.equal((turn.value.action as any).action, action);
    assert.equal(turn.value.status, 'completed');
    const deepCalls = w.f.wires().filter(row => row.subject.deepResearchContract === 'deep-research-cycle/v1');
    const request = deepCalls.at(-1).subject;
    const catalogue = request.inventory ?? request.sourceCatalogue;
    if (!catalogue) {
      const address = [...(request.working?.materialAddresses ?? []), ...(request.working?.navigationAddresses ?? []),
        ...(request.working?.sections ?? []).map((section: any) => ({ ...section, record: request.working.archive }))]
        .find((item: any) => item.pointer === '/body/inventory' || item.pointer === '/body/sourceCatalogue');
      assert.ok(address, 'The complete catalogue is inline or addressable in the actual request');
      const draft = w.store.get<any>(current.value.draft.id, current.value.draft.revision)!;
      const material = contextValue(archivedContext(w.store, draft, address.record), address.pointer) as any;
      assert.ok(material.sources);
    }
    assert.ok(request.webResearch);
    assert.ok(request.discoveryResponseContract, 'The actual request delivers the common action forms');
    const attempts = w.store.list<any>('research-attempt').filter(row => row.value.call.id === current.value.call!.id);
    assert.equal(attempts.length, action === 'answer' ? 1 : 0);
    if (action === 'web_search') assert.equal(request.discoveryClaims.sources.length, 0);
    if (action === 'web_fetch') {
      const sources = w.store.list<any>('source').filter(row => row.value.origin.kind === 'web');
      assert.equal(sources.length, 1); assert.equal(sources[0]!.value.content, w.f.page);
    }
    if (action === 'answer') {
      const claim = attempts[0]!.value.end.value.claims[0], pin = request.discoveryClaims.sources[0];
      assert.deepEqual(claim.basis.source, pin);
      assert.equal(pin.valueHash, hashJson(w.f.page));
      assert.deepEqual(w.f.hits, ['/search', '/fetch']);
    }
  });
}
test('deep cycle: the common independent assessment consumes the final claim after cold reopen', { timeout: 60000 }, async () => {
  const w = plant(await phase(5));
  const intents = deepIntents(w.store); assert.equal(intents.filter(row => row.value.state === 'applied').length, 4);
  const terminal = intents.find(row => row.value.state === 'applied' && row.value.outputs?.length === 3)!;
  assert.ok(terminal);
  const attempt = w.store.get<any>(terminal.value.outputs![2]!.id)!;
  const reviews = w.store.list<any>('discovery-assessment').filter(row => canonical(row.value).includes(attempt.id));
  assert.ok(reviews.length > 0, JSON.stringify(w.store.list<any>('research-run').map(row => ({ pauseCode: row.value.pauseCode, error: row.value.error?.slice(0, 1800) }))));
  const replay = readV7AssessmentReplay(w.store, 'p', reference(reviews[0]!));
  assert.ok(replay && replay.applications.length > 0, 'The common reader proves the applied paid assessment');
});

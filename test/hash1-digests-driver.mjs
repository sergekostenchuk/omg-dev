// HASH1 measurement driver — runs entirely on today's code (no era producers, so GUARD1 never trips).
// Launched by test/om-model-call.test.ts with a data-URL --import that patches crypto.createHash before any engine
// module loads, so globalThis.__hash1Digested collects every string handed to SHA-256. stdout: one JSON summary line.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digested = globalThis.__hash1Digested;
if (!Array.isArray(digested)) throw new Error('hash1 driver needs the createHash probe (--import preload)');
// Attribute each digest to the writeRef callsite that produced it: the frame after `writeRef (` in the stack.
// Anything not reaching the value through writeRef is background ('other'), no matter which files it crossed.
const siteOf = entry => {
  const frames = String(entry.s).split('\n');
  const body = frames.findIndex(line => line.includes('writeRef (') && line.includes('om/model-call.js'));
  if (body === -1) return 'other';
  const callsite = frames.slice(body + 1).map(line => line.match(/om\/model-call\.js:(\d+)/)).find(Boolean);
  return callsite ? callsite[1] : 'other';
};

const dist = path => pathToFileURL(join(fileURLToPath(new URL('../dist/', import.meta.url)), path)).href;
const take = result => { if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code} ${JSON.stringify(result.refusal.at)}`); return result.value; };

const { canonical, hashJson } = await import(dist('src/canonical.js'));
const { Store } = await import(dist('src/storage/store.js'));
const { ProductEngine } = await import(dist('src/product/engine.js'));
const { isRef, reference } = await import(dist('src/pipeline/contracts.js'));
const { projectGraph } = await import(dist('src/graph/project.js'));
const { gardenGraph } = await import(dist('test/om-fixture.js'));
const { preparedFeatures } = await import(dist('test/product-fixture.js'));
const { preparedField } = await import(dist('test/preparation-fixture.js'));
const { UPSTREAM_STAGES } = await import(dist('src/discovery/requirements.js'));
const { writeOmInput } = await import(dist('src/om/input.js'));
const { writeHorizon } = await import(dist('src/om/horizon.js'));
const { writeGaps } = await import(dist('src/om/gaps.js'));
const { writeRoutes } = await import(dist('src/om/routes.js'));
const { openSeries } = await import(dist('src/om/series.js'));
const { openAttempt } = await import(dist('src/om/repeat-gate.js'));
const { writeQuestionPacket } = await import(dist('src/om/question-packet.js'));
const { runModelCall } = await import(dist('src/om/model-call.js'));
const { gapLineKey, gapLineExpectedResult } = await import(dist('src/om/gap-lines.js'));

const root = mkdtempSync(join(tmpdir(), 'omg-hash1-driver-')), database = join(root, 'state.sqlite'), project = 'garden', block = 'garden-consume-block';
const fixturePath = fileURLToPath(new URL('./om-adapter-fixture.mjs', import.meta.url));
const store = new Store(database);
try {
  const engine = new ProductEngine(store);
  const { level: _level, ...l1 } = projectGraph(gardenGraph('cross'), 1);
  preparedFeatures(engine, project, l1, field => preparedField(project, field));
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`))]));
  take(writeOmInput(store, { project, expected: 0, stages }));
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  const configured = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'hash1-implementer', model: 'fixture', effort: 'high', speed: 'fast', command },
    reviewer: { actor: 'hash1-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 10_000, requestCapacityChars: 100_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:hash1`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
  const input = store.get(`om-input:${project}`), graph = store.get(`graph:${project}`);
  const horizon = take(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'hash1', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)) } };
  const gaps = take(writeGaps(store, sources));
  const routes = take(writeRoutes(store, { project, gaps: { sources: structuredClone(gaps.sources), records: gaps.records.map(reference) },
    tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(row => row.task === 'input-field' && row.items.some(item => item.consumers.includes(block))
    && new Set(row.items.map(item => item.field)).size > 1);
  if (!batch) throw new Error('no joined input-field batch');
  const goal = { key: 'hash1:dispatch', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)).sort(),
    result: gapLineExpectedResult(project, batch.items[0].target, batch.items[0].field) };
  take(openSeries(store, { project, block, line: 1, slice: 'hash1', predecessor: null, basis: null }));
  const series = take(openAttempt(store, { project, block, line: 1, attempt: 1, goal,
    completion: { routes: reference(routes), batches: [batch.id] } }));
  const packet = take(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
    environment: reference(configured), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const fieldValues = { nodes: ['garden-produce-block', 'garden-consume-block'],
    state: { writer: 'garden-produce-block', authority: 'garden-consume-block', rollback: 'garden-consume-block' }, checkKind: 'test' };
  writeFileSync(scenario, JSON.stringify({ database, steps: [{ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer',
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: fieldValues[item.field] ?? `value:${item.field}` })) },
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 } }] }));

  const calls = [], writeMany = store.writeMany.bind(store);
  store.writeMany = (writes, guards = []) => {
    const entered = digested.length, result = writeMany(writes, guards);
    calls.push({ writes: [...writes], guards: [...guards], entered, left: digested.length });
    return result;
  };
  const actual = take(await runModelCall(store, { project, packet: reference(packet),
    dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' }));
  const summary = {
    status: actual.record.value.status, digested: digested.length,
    calls: calls.map((call, i) => {
      const pending = new Set(call.writes.map(write => canonical({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) })));
      const refs = call.guards.filter(isRef);
      return {
        kinds: call.writes.map(write => write.kind), guards: call.guards.length, refGuards: refs.length,
        absentGuards: call.guards.length - refs.length,
        pendingSurvivors: refs.filter(guard => pending.has(canonical(guard))).length,
        sameIdKept: refs.filter(guard => call.writes.some(write => write.id === guard.id) && !pending.has(canonical(guard))).length,
        sites: call.writes.map(write => {
          const tally = {};
          for (const entry of digested.slice(i ? calls[i - 1].left : 0, call.entered))
            if (entry.b === canonical(write.value)) {
              const site = siteOf(entry);
              tally[site] = (tally[site] ?? 0) + 1;
            }
          return tally;
        }),
        txn: call.writes.map(write => digested.slice(call.entered, call.left)
          .filter(entry => entry.b === canonical(write.value)).length),
      };
    }),
  };
  process.stdout.write('HASH1_RESULT ' + JSON.stringify(summary) + '\n');
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

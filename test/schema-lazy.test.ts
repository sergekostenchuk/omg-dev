// IMPORT2c: lazy schema compilation — importing the engine must not compile the six costly
// top-level schema sets (om/horizon, om/work-zone, om/neighbors, om/frame-proposals,
// om/question-packet, discovery/research-consumer-transition); each compiles on first call.
// Proof is a compile journal in a FRESH child process: Ajv.prototype.compile is patched in a
// pre-import hook and records the caller module from its stack — never wall-clock time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The temp dir lives inside the worktree root so the hook resolves the same ajv instance
// the engine modules use (node_modules is reached by climbing, same realpath).
const HOOK_SRC = `import { Ajv } from 'ajv';
import { appendFileSync } from 'node:fs';
const F = process.env.COMPILES_FILE;
const orig = Ajv.prototype.compile;
Ajv.prototype.compile = function (schema) {
  const stack = new Error().stack || '';
  const hit = stack.split('\\n').map(l => l.match(/dist\\/src\\/((?:[\\w-]+\\/)*[\\w-]+)\\.js/)).find(Boolean);
  appendFileSync(F, JSON.stringify({ at: hit ? hit[1] : '?' }) + '\\n');
  return orig.apply(this, arguments);
};`;

const RUNNER_SRC = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const CJ = process.env.COMPILES_FILE, OUT = process.env.OUT_FILE, D = process.env.DIST_ROOT;
const compiles = () => existsSync(CJ) ? readFileSync(CJ, 'utf8').split('\\n').filter(Boolean).map(JSON.parse) : [];
const log = o => appendFileSync(OUT, JSON.stringify(o) + '\\n');
await import(D + '/product/engine.js');
log({ phase: 'imported', at: compiles().map(c => c.at) });
const call = (name, fn) => {
  try {
    const v = fn();
    log({ name, ok: true, value: typeof v === 'boolean' ? v : undefined,
      code: v && typeof v === 'object' && 'ok' in v && v.ok === false ? v.refusal?.code : undefined });
  } catch (e) { log({ name, ok: false, code: e && e.code || (e && e.name) || '?', details: Array.isArray(e && e.details) ? e.details.length : null }); }
};
const H = '0'.repeat(64);
const ref = id => ({ id, revision: 1, hash: H });
const { closeHorizon } = await import(D + '/om/horizon.js');
const { workZone } = await import(D + '/om/work-zone.js');
const { neighborsOf } = await import(D + '/om/neighbors.js');
const { applyProposals } = await import(D + '/om/frame-proposals.js');
const { normalizePartAnswer, packetReadPath } = await import(D + '/om/question-packet.js');
const { researchAction, projectReaderSelection, responseAction } = await import(D + '/discovery/research-consumer-transition.js');
call('horizon', () => closeHorizon({}, {}));
call('workZone', () => workZone({}, { nodes: [] }, []));
call('neighbors', () => neighborsOf({}, 'w', {}));
call('frameProposals', () => applyProposals({ request: { project: 'p', level: 2, graph: ref('g'), horizon: ref('h'), layer: null, frame: null, upper: null },
  upper: { version: 1 }, scope: {}, result: {}, references: [] }, []));
call('readPathBad', () => packetReadPath('../bad'));
call('readPathGood', () => packetReadPath('src/a.ts'));
call('partBody', () => normalizePartAnswer({}));
call('researchBad', () => researchAction({}));
call('researchGood', () => researchAction({ action: 'pause', reason: 'r' }));
call('researchBadAgain', () => researchAction({}));
call('readerBad', () => projectReaderSelection([], {}));
call('earlyNeed', () => responseAction({ action: 'need_research', question: 'q', missing: ['m'] }, false, true));
log({ phase: 'used', at: compiles().map(c => c.at) });`;

const SIX = ['om/horizon', 'om/work-zone', 'om/neighbors', 'om/frame-proposals',
  'om/question-packet', 'discovery/research-consumer-transition'];

interface Out { phase?: string; at?: string[]; name?: string; ok?: boolean;
  code?: string; details?: number | null; value?: boolean }
function run(t: test.TestContext): Out[] {
  const dir = mkdtempSync(join(resolve('.'), '.schema-lazy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hook = join(dir, 'record-compiles.mjs');
  const runner = join(dir, 'runner.mjs');
  const compilesFile = join(dir, 'compiles.txt');
  const outFile = join(dir, 'out.txt');
  writeFileSync(hook, HOOK_SRC);
  writeFileSync(runner, RUNNER_SRC);
  const r = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, runner],
    { encoding: 'utf8', env: { ...process.env, COMPILES_FILE: compilesFile, OUT_FILE: outFile,
      DIST_ROOT: pathToFileURL(resolve('dist/src')).href } });
  assert.equal(r.status, 0, `child failed: ${r.stderr.slice(-500)}`);
  const out = readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(row => JSON.parse(row) as Out);
  // The journal must observe the runner's own phases — silence proves nothing (hook may be broken).
  assert.ok(out.some(row => row.phase === 'imported'), 'runner did not report the imported phase');
  assert.ok(out.some(row => row.phase === 'used'), 'runner did not report the used phase');
  return out;
}

test('IMPORT2c engine import compiles none of the six costly schema sets', t => {
  const out = run(t);
  const imported = out.find(row => row.phase === 'imported')!;
  for (const module of SIX)
    assert.ok(!imported.at!.includes(module), `engine import compiled ${module} schemas eagerly`);
});

test('IMPORT2c each lazy validator compiles on first call and keeps refusals exact', t => {
  const out = run(t);
  const byName = new Map(out.filter(row => row.name).map(row => [row.name!, row]));
  const codes = {
    horizon: 'horizon_request_invalid', workZone: 'work_zone_request_invalid',
    neighbors: 'neighbor_request_invalid', frameProposals: 'proposal_request_invalid',
    partBody: 'part_answer_invalid', researchBad: 'research_response_invalid',
    researchBadAgain: 'research_response_invalid', readerBad: 'reader_response_invalid',
  };
  for (const [name, code] of Object.entries(codes)) {
    const row = byName.get(name);
    assert.ok(row, `call ${name} missing`);
    assert.equal(row!.code, code, `${name}: expected refusal ${code}, got ${JSON.stringify(row)}`);
  }
  assert.equal(byName.get('readPathBad')!.value, false);
  assert.equal(byName.get('readPathGood')!.value, true);
  assert.equal(byName.get('researchGood')!.ok, true);
  assert.equal(byName.get('earlyNeed')!.ok, true);
  // .errors must be the current validator's errors: non-empty on both bad calls of the same
  // cached validator (bad → good → bad), not a stale or empty detail.
  assert.ok(byName.get('researchBad')!.details! > 0, 'first bad call carried no ajv errors');
  assert.ok(byName.get('researchBadAgain')!.details! > 0, 'second bad call carried no ajv errors');
});

test('IMPORT2c each lazy validator is compiled once and reused', t => {
  const out = run(t);
  const used = out.find(row => row.phase === 'used')!.at!;
  // research-consumer-transition: exactly three validators (action, reader reply, early need),
  // invoked five times in total — cache reuse means the count stays at one compile each.
  assert.equal(used.filter(m => m === 'discovery/research-consumer-transition').length, 3,
    `research validators must compile exactly once each: ${used.join(',')}`);
  // question-packet: partBody + readPathValidator (answerFamilies stay uncompiled — unused here).
  assert.equal(used.filter(m => m === 'om/question-packet').length, 2,
    `question-packet must compile only the two used validators: ${used.join(',')}`);
  for (const module of SIX)
    assert.ok(used.includes(module), `${module} validator was never compiled`);
});

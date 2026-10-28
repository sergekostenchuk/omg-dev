import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Json } from '../src/canonical.js';
import { PAID_WORLD_ATTEMPTS, PAID_WORLD_CATALOG, PAID_WORLD_SEED, builderContext, bytesOf, paidWorldEntry, rootsOf, sharedWorld, withRootsOf,
  type World, type WorldLayer } from './discovery-v7-paid-world-cache.js';
import { processStart } from '../src/runtime/process-identity.js';

/**
 * The protocol of the run's catalog of paid worlds, on synthetic builders: no paid world is built here, so the file stays
 * fast. The real worlds are the consumers of discovery-v7-final-paid-seed.ts and discovery-v7-final-assessment-seed.ts,
 * which run through this catalog in a whole run (scripts/check-backend.mjs) and on their own through the old lazy path.
 */
/** How long a test of the protocol lets a process wait for a builder: a broken protocol fails in seconds instead of holding the file. */
const QUICK = 20_000;
const quickWorld = <T>(layer: WorldLayer, key: Json, build: (parent?: string) => Promise<World<T>>) => sharedWorld(layer, key, build, QUICK);
const MODULE = new URL('./discovery-v7-paid-world-cache.js', import.meta.url).href;
const CHILD = [
  `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';`,
  `import { join } from 'node:path';`,
  `const [moduleUrl, layer, key, builds, mode, holdMs, gate] = process.argv.slice(1);`,
  `const { sharedWorld } = await import(moduleUrl);`,
  `if (gate) writeFileSync(gate + '.' + process.pid, '');`,
  `while (gate && !existsSync(gate)) await new Promise(done => setTimeout(done, 2));`,
  `const world = await sharedWorld(layer, JSON.parse(key), async parent => {`,
  `  appendFileSync(builds, process.pid + '\\n');`,
  `  if (mode === 'fail') throw new Error('boom');`,
  `  const root = join(parent, 'world');`,
  `  mkdirSync(root);`,
  `  writeFileSync(join(root, 'state.sqlite'), 'bytes of ' + key);`,
  `  if (mode === 'hang') { writeFileSync(join(parent, 'hanging'), String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); }`,
  `  await new Promise(done => setTimeout(done, Number(holdMs)));`,
  `  return { root, data: { builtBy: process.pid, key, nested: { list: [1, 2, 3] } } };`,
  `}, Number(process.env.WAIT_MS));`,
  `console.log(JSON.stringify({ pid: process.pid, root: world.root, data: world.data }));`,
].join('\n');
interface Exit { code: number | null; signal: NodeJS.Signals | null; out: string; err: string }

function catalogFor(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-paid-world-cache-test-')), builds = join(directory, 'builds.txt');
  writeFileSync(builds, '');
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  return { directory, builds };
}
/** A child process of the test; whatever the test ends with, the child does not outlive it. */
function child(t: TestContext, catalog: string, args: string[], wait = QUICK) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', CHILD, MODULE, ...args],
    { env: { ...process.env, [PAID_WORLD_CATALOG]: catalog, WAIT_MS: String(wait) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { proc.kill('SIGKILL'); });
  let out = '', err = '';
  proc.stdout.on('data', chunk => { out += chunk; });
  proc.stderr.on('data', chunk => { err += chunk; });
  const done = new Promise<Exit>(resolve => proc.on('close', (code, signal) => resolve({ code, signal, out, err })));
  return { proc, done };
}
const built = (builds: string) => readFileSync(builds, 'utf8').split('\n').filter(Boolean);
const attempts = (catalog: string) => readdirSync(catalog).filter(name => /\.build-\d+$/.test(name)).sort();
const stats = (catalog: string) => readFileSync(join(catalog, 'stats.ndjson'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { role: string; layer: string });
const answer = (run: Exit) => JSON.parse(run.out) as { pid: number; root: string; data: { builtBy: number; key: string; nested: { list: number[] } } };
async function inCatalog<T>(catalog: string | undefined, action: () => Promise<T>): Promise<T> {
  const saved = process.env[PAID_WORLD_CATALOG];
  if (catalog === undefined) delete process.env[PAID_WORLD_CATALOG]; else process.env[PAID_WORLD_CATALOG] = catalog;
  try { return await action(); } finally { if (saved === undefined) delete process.env[PAID_WORLD_CATALOG]; else process.env[PAID_WORLD_CATALOG] = saved; }
}
/** A synthetic builder: makes `<parent>/world` and counts its own runs. */
function maker(data: unknown = { n: 1 }) {
  const calls: (string | undefined)[] = [];
  return { calls, build: async (parent?: string) => {
    calls.push(parent);
    const root = join(parent ?? mkdtempSync(join(tmpdir(), 'omg-paid-world-cache-own-')), 'world');
    mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'state.sqlite'), 'bytes');
    return { root, data };
  } };
}

test('simultaneous processes want one key: exactly one builds, the others wait and take its snapshot', { timeout: 45_000 }, async t => {
  const { directory, builds } = catalogFor(t), gate = join(directory, 'go'), key = JSON.stringify({ route: 'owner' });
  const runs = Array.from({ length: 4 }, () => child(t, directory, ['dossier', key, builds, 'build', '700', gate]));
  const deadline = Date.now() + 25_000;
  while (readdirSync(directory).filter(name => name.startsWith('go.')).length < 4) {   // every child has loaded the module and polls the gate
    assert.ok(Date.now() < deadline, 'four processes are ready'); await new Promise(done => setTimeout(done, 10));
  }
  writeFileSync(gate, '');
  const exits = await Promise.all(runs.map(run => run.done));
  for (const exit of exits) assert.equal(exit.code, 0, exit.err);
  assert.equal(built(builds).length, 1, 'the right to build one key is taken by one process only');
  const [first, ...others] = exits.map(answer);
  assert.equal(first!.data.builtBy, Number(built(builds)[0]));
  for (const other of others) { assert.equal(other.data.builtBy, first!.data.builtBy); assert.equal(other.root, first!.root); }
  assert.equal(attempts(directory).length, 1);
  assert.match(attempts(directory)[0]!, /^dossier-[a-f0-9]{24}\.build-1$/);
  const roles = stats(directory).map(row => row.role);
  assert.equal(roles.length, 4);
  assert.equal(roles.filter(role => role === 'built').length, 1, 'one built it, the other three were served');
  assert.ok(roles.includes('waited'), 'a process which asked while the builder worked waited for it');
  assert.ok(existsSync(join(first!.root, 'state.sqlite')), 'the snapshot is complete when it is served');
});

test('a consumer gets its own copy of the values; the snapshot is the same directory and is never written by the protocol', async t => {
  const { directory } = catalogFor(t), values = { when: new Date(0), map: new Map([[1, { deep: ['x'] }]]), set: new Set([1n]), gap: undefined, list: [1, [2, 3]] };
  await inCatalog(directory, async () => {
    const make = maker(values), one = await quickWorld('paid', { a: 1 }, make.build), two = await quickWorld('paid', { a: 1 }, make.build);
    assert.equal(make.calls.length, 1, 'the second request is served, not built');
    assert.equal(one.root, two.root);
    assert.notEqual(one.data, two.data, 'every request gets a fresh copy of the values');
    assert.deepEqual(one.data, structuredClone(values), 'a copy is exactly what a structured clone makes, undefined and Map included');
    (one.data as typeof values).map.get(1)!.deep.push('changed');
    assert.deepEqual((two.data as typeof values).map.get(1)!.deep, ['x'], 'one consumer changing its copy changes no other');
    assert.deepEqual((await quickWorld('paid', { a: 1 }, make.build)).data, structuredClone(values));
  });
});

test('different keys are different worlds; the same key in another order is the same world', async t => {
  const { directory } = catalogFor(t), make = maker();
  await inCatalog(directory, async () => {
    const same = [await quickWorld('paid', { a: 1, b: [2, { c: 3 }] }, make.build), await quickWorld('paid', { b: [2, { c: 3 }], a: 1 }, make.build)];
    assert.equal(make.calls.length, 1); assert.equal(same[0]!.root, same[1]!.root);
    const other = [await quickWorld('paid', { a: 1, b: [2, { c: 4 }] }, make.build), await quickWorld('assessment', { a: 1, b: [2, { c: 3 }] }, make.build),
      await quickWorld('paid', { a: 1, b: [2, { c: 3 }], form: null }, make.build)];
    assert.equal(make.calls.length, 4, 'another condition, another layer and another parameter each build their own world');
    assert.equal(new Set([same[0]!.root, ...other.map(world => world.root)]).size, 4);
    assert.equal(attempts(directory).length, 4);
  });
});

test('an interrupted build is never served: the next process takes over and later ones reuse that world', { timeout: 45_000 }, async t => {
  const { directory, builds } = catalogFor(t), key = JSON.stringify({ route: 'model' });
  const victim = child(t, directory, ['paid', key, builds, 'hang', '0']);
  const deadline = Date.now() + 30_000;
  while (!attempts(directory).some(name => existsSync(join(directory, name, 'hanging')))) {
    assert.ok(Date.now() < deadline, 'the builder started'); await new Promise(done => setTimeout(done, 20));
  }
  victim.proc.kill('SIGKILL');
  assert.equal((await victim.done).signal, 'SIGKILL');
  assert.deepEqual(attempts(directory).filter(name => existsSync(join(directory, name, 'ready.json'))), [], 'a half-made entry is not ready');
  const taker = await child(t, directory, ['paid', key, builds, 'build', '0']).done;
  assert.equal(taker.code, 0, taker.err);
  assert.equal(answer(taker).data.builtBy, answer(taker).pid, 'the process which found the builder gone built the world itself');
  assert.equal(built(builds).length, 2, 'the interrupted attempt and the taking-over one');
  assert.deepEqual(attempts(directory).map(name => existsSync(join(directory, name, 'ready.json'))), [false, true]);
  const later = await child(t, directory, ['paid', key, builds, 'build', '0']).done;
  assert.equal(later.code, 0, later.err);
  assert.equal(answer(later).data.builtBy, answer(taker).pid, 'the later process serves the taker\'s world');
  assert.equal(built(builds).length, 2, 'nobody builds it again');
});

/** The entry name the module gives a key, to put a claim of someone else exactly where the module looks for it. */
const entryName = (layer: 'paid', key: Json) => paidWorldEntry(layer, key).name;

test('a claim whose builder is not the process it names is taken over: another start time, or a claim which never named its owner', { timeout: 45_000 }, async t => {
  const { directory, builds } = catalogFor(t), key = JSON.stringify({ route: 'reused-pid' });
  // Attempt 1 names this very (live) process but another start time: the pid now belongs to a process which is not the builder.
  const impostor = join(directory, `${entryName('paid', JSON.parse(key))}.build-1`);
  mkdirSync(impostor); writeFileSync(join(impostor, 'owner.json'), JSON.stringify({ pid: process.pid, started: 'Mon Jan  1 00:00:00 2001' }));
  const first = await child(t, directory, ['paid', key, builds, 'build', '0']).done;
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(attempts(directory).map(name => existsSync(join(directory, name, 'ready.json'))), [false, true], 'the live pid did not make the claim a builder');
  // Another key: an attempt claimed long ago which never wrote its owner file.
  const other = JSON.stringify({ route: 'unnamed' }), unnamed = join(directory, `${entryName('paid', JSON.parse(other))}.build-1`), long = new Date(Date.now() - 60_000);
  mkdirSync(unnamed); utimesSync(unnamed, long, long);
  const second = await child(t, directory, ['paid', other, builds, 'build', '0']).done;
  assert.equal(second.code, 0, second.err);
  assert.equal(built(builds).length, 2, 'each key was built once, by the process which took the dead claim over');
});

test('the identity of an entry follows the bytes of the engine and of the test helpers, and no other', t => {
  const dist = mkdtempSync(join(tmpdir(), 'omg-paid-world-cache-bytes-'));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  for (const dir of ['src/discovery', 'test']) mkdirSync(join(dist, dir), { recursive: true });
  const files = { engine: join(dist, 'src/discovery/engine.js'), seed: join(dist, 'test/discovery-v7-final-paid-seed.js'), dossier: join(dist, 'test/discovery-v7-dossier-seed.js'),
    test: join(dist, 'test/some.test.js'), map: join(dist, 'test/discovery-v7-final-paid-seed.js.map') };
  for (const path of Object.values(files)) writeFileSync(path, 'one');
  const base = bytesOf(dist);
  assert.match(base, /^[a-f0-9]{64}$/);
  for (const [name, path] of Object.entries(files)) {
    writeFileSync(path, 'two');
    const changed = bytesOf(dist) !== base;
    assert.equal(changed, name === 'engine' || name === 'seed' || name === 'dossier', `${name}: ${changed ? 'is' : 'is not'} part of what a world is built from`);
    writeFileSync(path, 'one');
    assert.equal(bytesOf(dist), base, 'the same bytes are the same identity');
  }
  writeFileSync(join(dist, 'test/discovery-v7-new-helper.js'), 'one');
  assert.notEqual(bytesOf(dist), base, 'a new helper is another identity');
  const key = { route: 'owner' };
  assert.notEqual(paidWorldEntry('paid', key).name, paidWorldEntry('assessment', key).name);
  assert.equal(paidWorldEntry('paid', key).name, paidWorldEntry('paid', { route: 'owner' }).name);
  const text = JSON.parse(paidWorldEntry('paid', key).text) as { seed: number; bytes: string; layer: string; key: unknown };
  assert.deepEqual([text.seed, text.bytes.length, text.layer, text.key], [PAID_WORLD_SEED, 64, 'paid', key], 'the seed version, the bytes, the layer and the key are what an entry answers to');
});

test('a live builder which never finishes is waited for only as long as the process may, and is not built over', { timeout: 45_000 }, async t => {
  const { directory, builds } = catalogFor(t), key = { route: 'never' };
  const attempt = join(directory, `${paidWorldEntry('paid', key).name}.build-1`);
  mkdirSync(attempt); writeFileSync(join(attempt, 'owner.json'), JSON.stringify({ pid: process.pid, started: processStart(process.pid) }));
  const run = await child(t, directory, ['paid', JSON.stringify(key), builds, 'build', '0'], 600).done;
  assert.notEqual(run.code, 0);
  assert.match(run.err, /still being built by a live process after 0\.6 s/);
  assert.equal(built(builds).length, 0, 'it did not build over a builder which is alive');
});

test('a failed build is retried by the next process and reported without building after the attempts', { timeout: 45_000 }, async t => {
  const { directory, builds } = catalogFor(t), key = JSON.stringify({ route: 'partial' });
  for (let attempt = 1; attempt <= PAID_WORLD_ATTEMPTS; attempt += 1) {
    const exit = await child(t, directory, ['assessment', key, builds, 'fail', '0']).done;
    assert.notEqual(exit.code, 0); assert.match(exit.err, /boom/);
  }
  assert.equal(built(builds).length, PAID_WORLD_ATTEMPTS);
  const last = await child(t, directory, ['assessment', key, builds, 'build', '0']).done;
  assert.notEqual(last.code, 0);
  assert.match(last.err, new RegExp(`was not built in ${PAID_WORLD_ATTEMPTS} attempts: attempt ${PAID_WORLD_ATTEMPTS} failed: boom`));
  assert.equal(built(builds).length, PAID_WORLD_ATTEMPTS, 'a settled failure does not make a fourth builder');
  assert.ok(attempts(directory).every(name => existsSync(join(directory, name, 'failed.json')) && !existsSync(join(directory, name, 'ready.json'))));
});

test('the catalog serves the bytes which created it and no other build', async t => {
  const { directory } = catalogFor(t), make = maker();
  await inCatalog(directory, async () => {
    await quickWorld('paid', { a: 1 }, make.build);
    const path = join(directory, 'manifest.json'), have = JSON.parse(readFileSync(path, 'utf8')) as { seed: number; node: string; bytes: string };
    assert.equal(have.seed, PAID_WORLD_SEED); assert.equal(have.node, process.version); assert.match(have.bytes, /^[a-f0-9]{64}$/);
    for (const [field, value] of [['bytes', 'f'.repeat(64)], ['seed', PAID_WORLD_SEED + 1], ['node', 'v0.0.0']] as const) {
      const other = mkdtempSync(join(tmpdir(), 'omg-paid-world-cache-other-'));
      t.after(() => rmSync(other, { recursive: true, force: true }));
      writeFileSync(join(other, 'manifest.json'), JSON.stringify({ ...have, [field]: value }));
      process.env[PAID_WORLD_CATALOG] = other;
      await assert.rejects(quickWorld('paid', { a: 1 }, make.build), /created by other bytes/);
    }
    assert.equal(make.calls.length, 1, 'a foreign catalog builds nothing and serves nothing');
  });
});

test('without a catalog the lazy construction is the only thing that happens; a wrong variable is refused', async t => {
  const make = maker();
  const world = await inCatalog(undefined, () => quickWorld('paid', { a: 1 }, make.build));
  t.after(() => rmSync(join(world.root, '..'), { recursive: true, force: true }));
  assert.deepEqual(make.calls, [undefined], 'the builder is called with no entry');
  assert.deepEqual(world.data, { n: 1 });
  await assert.rejects(inCatalog('relative/dir', () => quickWorld('paid', { a: 1 }, make.build)), /existing absolute directory/);
  await assert.rejects(inCatalog(join(tmpdir(), 'omg-paid-world-cache-missing-dir'), () => quickWorld('paid', { a: 1 }, make.build)), /existing absolute directory/);
  assert.equal(make.calls.length, 1);
});

test('a published entry which changed, lost its world or answers another key is refused', async t => {
  const refusals = { data: /changed after it was published/, key: /answers another key/, world: /has no world/ };
  for (const damage of ['data', 'key', 'world'] as const) {
    const { directory } = catalogFor(t), make = maker();
    await inCatalog(directory, async () => {
      const world = await quickWorld('paid', { a: 1 }, make.build), entry = join(world.root, '..');
      if (damage === 'data') appendFileSync(join(entry, 'data.bin'), 'x');
      else if (damage === 'world') rmSync(world.root, { recursive: true, force: true });
      else writeFileSync(join(entry, 'ready.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(entry, 'ready.json'), 'utf8')), key: '{"other":true}' }));
      await assert.rejects(quickWorld('paid', { a: 1 }, make.build), refusals[damage]);
      assert.equal(make.calls.length, 1, 'nothing is rebuilt over a published entry');
    });
  }
});

test('a builder\'s roots live in its entry and carry no clean-up; the fixture root is made there too', async t => {
  const { directory } = catalogFor(t), entry = join(directory, 'entry'), own = { after: () => {}, diagnostic: () => {} } as unknown as TestContext;
  mkdirSync(entry);
  assert.equal(builderContext(undefined, own), own);
  assert.equal(rootsOf(own), tmpdir());
  const context = builderContext(entry, own);
  assert.equal(rootsOf(context), join(entry, 'runtime'));
  assert.ok(existsSync(join(entry, 'runtime')));
  let cleaned = false;
  context.after(() => { cleaned = true; });
  assert.equal(cleaned, false, 'the catalog, not the builder, removes the roots');
  const roots: string[] = [], before = process.env.TMPDIR;
  const fixture = async () => { roots.push(tmpdir()); await null; roots.push(tmpdir()); };
  await withRootsOf(context, fixture);
  assert.deepEqual(roots, [join(entry, 'runtime'), before === undefined ? '/tmp' : before.replace(/\/$/, '')], 'only the synchronous start of the fixture is redirected');
  assert.equal(process.env.TMPDIR, before);
  assert.throws(() => withRootsOf(context, () => { throw new Error('refused'); }), /refused/);
  assert.equal(process.env.TMPDIR, before, 'the temporary directory is restored when the fixture throws');
  let plain = 0;
  withRootsOf(own, () => { plain += 1; return plain; });
  assert.equal(plain, 1);
});

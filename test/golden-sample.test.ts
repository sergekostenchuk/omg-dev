import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { reference, STAGES, type StageArtifact } from '../src/pipeline/contracts.js';
import { readRun } from '../src/om/run.js';
import { goldenSample } from './golden-sample.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const core = await import(new URL('../../scripts/golden-sample.mjs', import.meta.url).href);
function setup(t: TestContext) {
  const directory = mkdtempSync(join(root, '.golden-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const captured = core.captureInputs(root);
  for (const entry of captured) { mkdirSync(dirname(join(directory, entry.path)), { recursive: true }); writeFileSync(join(directory, entry.path), entry.bytes); }
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const database = join(directory, 'producer.sqlite'), store = new Store(database);
  const row = store.write({ id: 'unit:producer', kind: 'sample-unit', expected: 0, value: { exact: 'bytes' } });
  const databaseId = store.databaseId;
  store.proofCacheClear(); store.close();
  const output = join(directory, 'test/fixtures/golden');
  const metadata = { producerDigest: core.inputDigest(captured), toolchain: core.toolchain(directory), databaseId };
  const meta = core.publishSample(database, output, metadata);
  return { directory, database, output, captured, metadata, meta, row,
    generation: () => readFileSync(join(output, 'CURRENT'), 'utf8').trim() };
}
test('golden sample copies exact finalized bytes into independent writable cold Stores', t => {
  const f = setup(t), reader = core.sampleReader(f.directory), first = join(f.directory, 'one.sqlite'), second = join(f.directory, 'two.sqlite');
  assert.deepEqual(reader.copy(first), f.meta); reader.copy(second);
  assert.equal(core.sha256(readFileSync(first)), f.meta.sqliteFileSha256);
  const a = new Store(first), b = new Store(second);
  try { assert.deepEqual(a.get(f.row.id), f.row); assert.deepEqual(b.get(f.row.id), f.row);
    a.write({ id: 'only:a', kind: 'sample-unit', expected: 0, value: 1 }); assert.equal(b.get('only:a'), null);
    assert.equal(a.databaseId, f.meta.databaseId);
  } finally { a.close(); b.close(); }
  const canonical = join(f.output, f.generation(), 'state.sqlite');
  assert.equal(core.sha256(readFileSync(canonical)), f.meta.sqliteFileSha256);
  assert.equal(existsSync(`${canonical}-wal`), false); assert.equal(existsSync(`${canonical}-shm`), false);
});
test('golden sample rejects a stale producer before creating a copy and names the regeneration command', t => {
  const f = setup(t); writeFileSync(join(f.directory, 'src/canonical.ts'), '// producer changed\n');
  const target = join(f.directory, 'stale.sqlite');
  assert.throws(() => core.sampleReader(f.directory).copy(target), /stale producerDigest.*npm run sample:generate/);
  assert.equal(existsSync(target), false);
});
test('golden sample refuses substituted SQLite by sha even when metadata and source version match', t => {
  const f = setup(t), canonical = join(f.output, f.generation(), 'state.sqlite');
  chmodSync(canonical, 0o600); const bytes = readFileSync(canonical); bytes[bytes.length - 1]! ^= 1; writeFileSync(canonical, bytes);
  assert.throws(() => core.sampleReader(f.directory).copy(join(f.directory, 'bad.sqlite')), /sqliteFileSha256 mismatch.*npm run sample:generate/);
});
test('golden sample verifies once per process reader and holds its own exact bytes across replacement', t => {
  const f = setup(t), reader = core.sampleReader(f.directory);
  const returned = reader.copy(join(f.directory, 'first.sqlite')); returned.databaseId = 'caller mutation';
  writeFileSync(join(f.directory, 'src/canonical.ts'), '// change after first use\n');
  const meta = reader.copy(join(f.directory, 'second.sqlite'));
  assert.equal(meta.databaseId, f.meta.databaseId); assert.equal(core.sha256(readFileSync(join(f.directory, 'second.sqlite'))), f.meta.sqliteFileSha256);
  assert.throws(() => core.sampleReader(f.directory).copy(join(f.directory, 'new-process.sqlite')), /stale producerDigest/);
});
test('golden input capture and isolated build never attribute later working tree bytes to earlier producers', t => {
  const f = setup(t), build = join(f.directory, 'isolated'); mkdirSync(build);
  const frozen = core.freezeInputs(f.directory, build, f.captured);
  for (const path of ['src/canonical.ts', 'test/golden-sample-bootstrap.mjs', 'test/golden-sample-adapter.mjs', 'test/golden-sample-recipe.json'])
    writeFileSync(join(f.directory, path), 'changed during generation');
  assert.equal(frozen.producerDigest, core.inputDigest(f.captured));
  assert.notEqual(frozen.producerDigest, core.inputDigest(core.captureInputs(f.directory)));
  for (const entry of f.captured) assert.deepEqual(readFileSync(join(build, entry.path)), entry.bytes, entry.path);
});
test('golden publication refuses WAL and does not replace the previously published pair', t => {
  const f = setup(t), before = readFileSync(join(f.output, 'CURRENT'));
  writeFileSync(`${f.database}-wal`, 'not checkpointed');
  assert.throws(() => core.publishSample(f.database, f.output, f.metadata), /WAL\/SHM/);
  assert.deepEqual(readFileSync(join(f.output, 'CURRENT')), before);
});
test('golden reader rejects missing metadata fields, unsupported format and missing artifact', t => {
  const f = setup(t), metaPath = join(f.output, f.generation(), 'meta.json');
  for (const key of ['producerDigest', 'toolchain', 'sqliteFileSha256', 'sqliteBytes', 'format']) {
    const next = { ...f.meta }; delete next[key]; writeFileSync(metaPath, JSON.stringify(next));
    assert.throws(() => core.sampleReader(f.directory).copy(join(f.directory, `missing-${key}.sqlite`)), /npm run sample:generate/);
  }
  writeFileSync(metaPath, JSON.stringify({ ...f.meta, format: 'unknown' }));
  assert.throws(() => core.sampleReader(f.directory).copy(join(f.directory, 'unknown.sqlite')), /unknown metadata format/);
  rmSync(join(f.output, 'CURRENT'));
  assert.throws(() => core.sampleReader(f.directory).copy(join(f.directory, 'missing.sqlite')), /missing CURRENT/);
});
test('golden publication leaves historical records intact and contains no disk proof cache', t => {
  const f = setup(t), canonical = join(f.output, f.generation(), 'state.sqlite'), db = new DatabaseSync(canonical, { readOnly: true });
  try {
    for (const table of ['proof_cache', 'proof_nodes', 'proof_links']) assert.equal(db.prepare(`select count(*) as n from ${table}`).get()!['n'], 0);
    assert.ok(Number(db.prepare('select count(*) as n from revisions').get()!['n']) > 0);
    assert.ok(Number(db.prepare('select count(*) as n from events').get()!['n']) > 0);
  } finally { db.close(); }
});

test('published current sample retains accepted stages and its completed OM history in a cold private copy', t => {
  const { store, meta } = goldenSample(t);
  assert.equal(store.databaseId, meta.databaseId);
  for (const stage of STAGES) {
    const record = store.get<StageArtifact>(meta.landmarks[stage].id, meta.landmarks[stage].revision)!;
    assert.deepEqual(reference(record), meta.landmarks[stage]);
    assert.equal(record.value.status, 'accepted', stage);
  }
  const run = readRun(store, { project: meta.project });
  assert.ok(run.ok, JSON.stringify(run));
  assert.equal(run.value?.value.state.phase, 'complete');
});

test('golden sample refuses missing producer input and a metadata swap before creating a copy', t => {
  const f = setup(t), destination = join(f.directory, 'refused.sqlite');
  rmSync(join(f.directory, 'test/golden-sample-recipe.json'));
  assert.throws(() => core.sampleReader(f.directory).copy(destination), /producer inputs unavailable.*npm run sample:generate/);
  assert.equal(existsSync(destination), false);
  writeFileSync(join(f.directory, 'test/golden-sample-recipe.json'), f.captured.find((entry: { path: string }) => entry.path === 'test/golden-sample-recipe.json').bytes);
  writeFileSync(join(f.output, f.generation(), 'meta.json'), JSON.stringify({ ...f.meta, databaseId: 'swapped' }));
  assert.throws(() => core.sampleReader(f.directory).copy(destination), /metadata pair hash mismatch.*npm run sample:generate/);
  assert.equal(existsSync(destination), false);
});

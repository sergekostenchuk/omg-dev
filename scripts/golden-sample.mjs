import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const version = 'golden-sample/v1';
export const regenerate = 'npm run sample:generate';
const support = ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts/golden-sample.mjs',
  'test/golden-sample.ts', 'test/golden-sample-generate.ts', 'test/golden-sample-bootstrap.mjs',
  'test/golden-sample-adapter.mjs', 'test/golden-sample-recipe.json'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Golden sample: ${message}; recreate with ${regenerate}`); };
function files(root, relative) {
  return readdirSync(join(root, relative)).sort().flatMap(name => {
    const path = `${relative}/${name}`, stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) fail(`input must not be a symlink: ${path}`);
    return stat.isDirectory() ? files(root, path) : stat.isFile() ? [path] : fail(`unsupported input: ${path}`);
  });
}
export function captureInputs(root) {
  return [...files(root, 'src'), ...support].sort().map(path => {
    if (!lstatSync(join(root, path)).isFile() || lstatSync(join(root, path)).isSymbolicLink()) fail(`invalid input ${path}`);
    return { path, bytes: readFileSync(join(root, path)) };
  });
}
const length = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
export function inputDigest(inputs) {
  const hash = createHash('sha256').update(version).update(length(inputs.length));
  for (const { path, bytes } of inputs) { const name = Buffer.from(path); hash.update(length(name.length)).update(name).update(length(bytes.length)).update(bytes); }
  return hash.digest('hex');
}
export function toolchain(root) {
  const db = new DatabaseSync(':memory:');
  let sqlite; try { sqlite = db.prepare('select sqlite_version() as version').get().version; } finally { db.close(); }
  return { node: process.versions.node, sqlite, platform: process.platform, arch: process.arch,
    typescript: JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version,
    git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() };
}
export function freezeInputs(root, destination, inputs = captureInputs(root)) {
  for (const { path, bytes } of inputs) { const target = join(destination, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
  symlinkSync(resolve(root, 'node_modules'), join(destination, 'node_modules'), 'dir');
  // Build only the captured generator and its transitive imports, never another test's historical fixture loader.
  writeFileSync(join(destination, 'tsconfig.sample.json'), JSON.stringify({ extends: './tsconfig.json', include: ['src/**/*.ts', 'test/golden-sample-generate.ts', 'test/golden-sample.ts'] }));
  return { producerDigest: inputDigest(inputs), inputs: inputs.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) })) };
}
function syncFile(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function publishSample(database, directory, metadata) {
  if (existsSync(`${database}-wal`) || existsSync(`${database}-shm`)) fail('database still has WAL/SHM');
  // This is the private producer file, after every Store/child has closed. Persist DELETE journal mode
  // before hashing: a readonly connection to a WAL-mode file can itself create empty sidecars.
  const db = new DatabaseSync(database);
  try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy !== 0) fail('producer checkpoint is busy');
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
    for (const table of ['proof_cache', 'proof_nodes', 'proof_links'])
      if (db.prepare(`select count(*) as n from ${table}`).get().n !== 0) fail(`nonempty ${table}`);
    if (db.prepare('pragma integrity_check').get().integrity_check !== 'ok') fail('SQLite integrity failed');
  } finally { db.close(); }
  if (existsSync(`${database}-wal`) || existsSync(`${database}-shm`)) fail('database is not standalone after final read');
  const bytes = readFileSync(database), meta = { ...metadata, format: version, sqliteFileSha256: sha256(bytes), sqliteBytes: bytes.length };
  const encoded = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`);
  const generation = sha256(Buffer.concat([Buffer.from(meta.sqliteFileSha256), encoded]));
  mkdirSync(directory, { recursive: true });
  const old = existsSync(join(directory, 'CURRENT')) ? readFileSync(join(directory, 'CURRENT'), 'utf8').trim() : null;
  const pending = mkdtempSync(join(directory, '.pending-'));
  try {
    syncFile(join(pending, 'state.sqlite'), bytes); syncFile(join(pending, 'meta.json'), encoded);
    chmodSync(join(pending, 'state.sqlite'), 0o400); syncDirectory(pending);
    const target = join(directory, generation);
    if (!existsSync(target)) renameSync(pending, target);
    else if (sha256(readFileSync(join(target, 'state.sqlite'))) !== meta.sqliteFileSha256
      || !readFileSync(join(target, 'meta.json')).equals(encoded)) fail('existing generation differs from its pair hash');
    const pointer = join(directory, `.current-${randomUUID()}`);
    try { syncFile(pointer, `${generation}\n`); renameSync(pointer, join(directory, 'CURRENT')); syncDirectory(directory); }
    finally { if (existsSync(pointer)) rmSync(pointer); }
    if (old && old !== generation && /^[a-f0-9]{64}$/.test(old)) rmSync(join(directory, old), { recursive: true, force: true });
    return meta;
  } finally { rmSync(pending, { recursive: true, force: true }); }
}
/** One verification per helper instance/process. No caller can mutate its private verified bytes. */
export function sampleReader(root, directory = join(root, 'test/fixtures/golden')) {
  let loaded;
  return {
    copy(destination) {
      if (!loaded) {
        let generation, meta, bytes, encoded;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { generation = readFileSync(join(directory, 'CURRENT'), 'utf8').trim(); } catch { fail('missing CURRENT'); }
          if (!/^[a-f0-9]{64}$/.test(generation)) fail('invalid CURRENT');
          try { encoded = readFileSync(join(directory, generation, 'meta.json')); meta = JSON.parse(encoded); bytes = readFileSync(join(directory, generation, 'state.sqlite')); break; }
          catch {
            if (existsSync(join(directory, 'CURRENT')) && readFileSync(join(directory, 'CURRENT'), 'utf8').trim() !== generation) continue;
            fail('missing or malformed sample pair');
          }
        }
        if (!meta || !bytes) fail('sample publication changed repeatedly');
        if (meta.format !== version) fail('unknown metadata format');
        if (meta.sqliteFileSha256 !== sha256(bytes) || meta.sqliteBytes !== bytes.length) fail('sqliteFileSha256 mismatch');
        if (sha256(Buffer.concat([Buffer.from(meta.sqliteFileSha256), encoded])) !== generation) fail('metadata pair hash mismatch');
        let digest;
        try { digest = inputDigest(captureInputs(root)); } catch { fail('producer inputs unavailable'); }
        if (meta.producerDigest !== digest) fail('stale producerDigest');
        if (JSON.stringify(meta.toolchain) !== JSON.stringify(toolchain(root))) fail('stale toolchain');
        loaded = { meta, bytes };
      }
      writeFileSync(destination, loaded.bytes, { flag: 'wx', mode: 0o600 });
      return structuredClone(loaded.meta);
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const build = mkdtempSync(join(root, '.golden-build-'));
  try {
    const frozen = freezeInputs(root, build);
    writeFileSync(join(build, 'frozen.json'), JSON.stringify({ ...frozen, toolchain: toolchain(root) }));
    execFileSync(process.execPath, [join(build, 'node_modules/typescript/bin/tsc'), '-p', join(build, 'tsconfig.sample.json')], { cwd: build, stdio: 'inherit' });
    execFileSync(process.execPath, ['--import', join(build, 'test/golden-sample-bootstrap.mjs'), join(build, 'dist/test/golden-sample-generate.js'), join(root, 'test/fixtures/golden')],
      { cwd: build, stdio: 'inherit', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
  } finally { rmSync(build, { recursive: true, force: true }); }
}

// IMPORT2b: typescript must not load until the first actual parse. Proof is module composition
// in a FRESH child process (registerHooks records every loaded specifier, ESM and require),
// never wall-clock time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve('.');
const ENGINE = join(ROOT, 'dist/src/product/engine.js');
const IMPACT = join(ROOT, 'dist/src/om/impact.js');

// Preload records every resolved+loaded module URL; with BLOCK_TS it also fails typescript
// resolution, which must surface as the typed impact_parser_unavailable refusal.
const HOOK_SRC = `import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const F = process.env.LOADS_FILE;
const BLOCK = process.env.BLOCK_TS === '1';
registerHooks({
  resolve(specifier, ctx, next) {
    if (BLOCK && specifier === 'typescript') throw new Error('typescript blocked for probe');
    return next(specifier, ctx);
  },
  load(url, ctx, next) { appendFileSync(F, url + '\\n'); return next(url, ctx); },
});`;

function child(t: test.TestContext, script: string, blockTs = false) {
  const dir = mkdtempSync(join(tmpdir(), 'impact-lazy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hook = join(dir, 'record.mjs');
  const entry = join(dir, 'entry.mjs');
  const loadsFile = join(dir, 'loads.txt');
  writeFileSync(hook, HOOK_SRC);
  writeFileSync(entry, script);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, entry],
    { encoding: 'utf8', env: { ...process.env, LOADS_FILE: loadsFile, BLOCK_TS: blockTs ? '1' : '0' } });
  // The journal must exist and must contain the entry itself — an empty/absent log proves nothing.
  const loads = readFileSync(loadsFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(loads.some(u => u.replace(/^file:\/\//, '').endsWith('entry.mjs')),
    `journal did not observe the test entry (hook broken?): ${loads.slice(0, 5)}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, loads };
}

test('IMPORT2b importing the engine does not load typescript', t => {
  const r = child(t, `await import(${JSON.stringify(pathToFileURL(ENGINE).href)}); console.log('engine-ok');`);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /engine-ok/);
  assert.ok(!r.loads.some(u => /typescript/i.test(u)),
    `typescript must stay unloaded: ${r.loads.filter(u => /typescript/i.test(u))}`);
});

test('IMPORT2b impactParser() loads typescript lazily and yields the real version', t => {
  const r = child(t, `const { impactParser } = await import(${JSON.stringify(pathToFileURL(IMPACT).href)});
    console.log('PARSER=' + impactParser());`);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const m = /PARSER=typescript@(\d+\.\d+\.\d+)/.exec(r.stdout);
  assert.ok(m, `expected typescript@x.y.z, got ${r.stdout.slice(-200)}`);
  assert.ok(r.loads.some(u => /typescript/.test(u)), 'typescript must load on first parser use');
});

test('IMPORT2b a missing typescript is the typed refusal impact_parser_unavailable', t => {
  const r = child(t, `const { impactParser } = await import(${JSON.stringify(pathToFileURL(IMPACT).href)});
    try { impactParser(); console.log('NO-REFUSAL'); }
    catch (e) { console.log('CODE=' + (e && e.code)); }`, true);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /CODE=impact_parser_unavailable/, r.stdout.slice(-300));
});

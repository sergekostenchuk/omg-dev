// IMPORT2a: lazy CLI dispatch — light branches must not pull the product-engine graph.
// Proof is module composition in a FRESH child process (registerHooks records every loaded
// specifier), never wall-clock time — the clock is unstable under load (pool note IMPORT1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = resolve('dist/src/cli.js');
const ENGINE = 'dist/src/product/engine.js';
const HOOK_SRC = `import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const F = process.env.LOADS_FILE;
registerHooks({ load(url, ctx, next) { appendFileSync(F, url + '\\n'); return next(url, ctx); } });`;

interface Run { status: number | null; stdout: string; stderr: string; loads: string[] }
function run(t: test.TestContext, args: string[], input?: string): Run {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lazy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hook = join(dir, 'record-loads.mjs');
  const loadsFile = join(dir, 'loads.txt');
  writeFileSync(hook, HOOK_SRC);
  const r = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, CLI, ...args],
    { input, encoding: 'utf8', env: { ...process.env, LOADS_FILE: loadsFile } });
  // The journal must exist and must contain the CLI entry itself — an empty/absent log proves
  // nothing (the hook may never have run), not the absence of product/engine.js.
  const loads = readFileSync(loadsFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(loads.some(u => u.replace(/^file:\/\//, '').endsWith('dist/src/cli.js')),
    `journal did not observe the CLI entry (hook broken?): ${loads.slice(0, 5)}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, loads };
}

const loaded = (r: Run, needle: string) => r.loads.some(u => u.replace(/^file:\/\//, '').endsWith(needle));

test('IMPORT2a restore/inspect/backup/init never load product/engine.js', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lazy-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'state.sqlite');
  const backups = join(dir, 'backups');

  const init = run(t, ['init', db]);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(!loaded(init, ENGINE), 'init must not load product/engine.js');
  const initBody = JSON.parse(init.stdout);
  assert.equal(typeof initBody.databaseId, 'string');
  assert.ok(Array.isArray(initBody.entities));

  const inspect = run(t, ['inspect', db]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout), initBody, 'inspect output drifted from init');
  assert.ok(!loaded(inspect, ENGINE), 'inspect must not load product/engine.js');

  const backup = run(t, ['backup', db, backups]);
  assert.equal(backup.status, 0, backup.stderr);
  const snap = JSON.parse(backup.stdout);
  assert.equal(typeof snap.generation, 'number');
  assert.ok(!loaded(backup, ENGINE), 'backup must not load product/engine.js');

  const restored = join(dir, 'restored.sqlite');
  const restore = run(t, ['restore', restored, backups]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(JSON.parse(restore.stdout).databaseId, initBody.databaseId);
  assert.ok(!loaded(restore, ENGINE), 'restore must not load product/engine.js');
});

test('IMPORT2a invalid_command refusal stays refusal-only and engine-free', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lazy-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = run(t, ['bogus', join(dir, 'x.sqlite')]);
  assert.equal(r.status, 1);
  const line = r.stderr.split(/\r?\n/).find(row => row.startsWith('{"error"'));
  assert.ok(line, `no refusal on stderr: ${r.stderr.slice(-300)}`);
  const err = JSON.parse(line!);
  assert.equal(err.error, 'invalid_command');
  assert.match(err.message, /init\|inspect\|backup\|restore/);
  assert.ok(!loaded(r, ENGINE), 'invalid_command must not load product/engine.js');
});

test('IMPORT2a the command branch still reaches ProductEngine', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lazy-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'state.sqlite');
  assert.equal(run(t, ['init', db]).status, 0);
  // payload shape does not matter: loading the engine graph itself is the positive control
  const r = run(t, ['command', db], JSON.stringify({ command: 'ping' }));
  assert.ok(loaded(r, ENGINE), 'command must load product/engine.js');
});

test('IMPORT2a owner-invite and probe resolve their own branches', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lazy-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'state.sqlite');
  const invite = run(t, ['owner-invite', db]);
  assert.ok(loaded(invite, 'dist/src/product/owner-authority.js'), 'owner-invite must load owner-authority.js');
  assert.ok(!loaded(invite, ENGINE), 'owner-invite must not load product/engine.js');
  const probe = run(t, ['probe', '--help']);
  assert.ok(loaded(probe, 'dist/src/om/probe.js'), 'probe must load probe.js');
  assert.ok(!loaded(probe, ENGINE), 'probe --help must not load product/engine.js');
});

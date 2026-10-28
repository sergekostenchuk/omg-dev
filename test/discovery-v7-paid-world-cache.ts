import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { canonical, digest, type Json } from '../src/canonical.js';
import { probeProcessIdentity, processStart } from '../src/runtime/process-identity.js';

/**
 * One catalog of paid test worlds for ONE run of the whole suite. scripts/check-backend.mjs names a fresh directory in
 * OMG_PAID_WORLD_CATALOG and removes it with the run. The paid baselines of discovery-v7-final-paid-seed.ts and
 * discovery-v7-final-assessment-seed.ts used to be built once per test process; here the first process that needs a
 * baseline builds it with the ordinary producers, every other process waits for that one build and copies the finished
 * snapshot, so no baseline is paid for twice in a run. Without the variable nothing changes: each process builds
 * lazily, inside the test that needs it.
 *
 * An entry is `<layer>-<hash of the seed version, the bytes and the whole key>.build-<n>`, the n-th attempt to build it, made in place so that no path
 * inside it ever changes. It is published only by `ready.json`, written last through a rename, and never written again.
 * Whoever finds no ready attempt waits for the highest one while its owner (pid and start time) is alive, and starts
 * attempt n + 1 when that owner failed or is gone, at most ATTEMPTS times. Every consumer copies the snapshot into its own
 * root, so no database, adapter, settings, wire or value is shared between tests or processes. The catalog belongs to
 * the bytes that created it (manifest.json: compiled engine and test helpers, seed version, Node version) and to no
 * other build.
 */
export const PAID_WORLD_CATALOG = 'OMG_PAID_WORLD_CATALOG';
/** Part of every key and of the manifest: bump it whenever a world is built differently in a way no compiled byte shows. */
export const PAID_WORLD_SEED = 1;
export const PAID_WORLD_ATTEMPTS = 3;
const POLL_MS = 150, IDENTITY_MS = 3_000, CLAIM_GRACE_MS = 5_000, WAIT_MS = 15 * 60_000;

export type WorldLayer = 'dossier' | 'paid' | 'assessment';
/** A snapshot: a directory `root` which is never written, and the values that name its records. */
export interface World<T> { root: string; data: T }
interface Owner { pid: number; started: string }
interface Attempt { n: number; dir: string }

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
function publish(path: string, value: unknown): void {
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify(value)); renameSync(draft, path);
}

function directory(): string | null {
  const given = process.env[PAID_WORLD_CATALOG];
  if (given === undefined || given === '') return null;
  if (!isAbsolute(given) || !statSync(given, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${PAID_WORLD_CATALOG} must name an existing absolute directory, not ${given}`);
  return given;
}

/** What a world is built from: the compiled engine (`dist/src`) and the compiled test helpers (`dist/test`, the seeds and the
 * dossier seed among them; not the tests). A change in any of those bytes is another identity. */
export function bytesOf(dist: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string, helpers: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!helpers) walk(path, false); }
      else if (/\.m?js$/.test(entry.name) && !(helpers && entry.name.endsWith('.test.js')))
        hash.update(`${relative(dist, path)}\0`).update(readFileSync(path)).update('\0');
    }
  };
  walk(join(dist, 'src'), false); walk(join(dist, 'test'), true);
  return hash.digest('hex');
}
let compiled: string | null = null;
const bytes = (): string => compiled ??= bytesOf(fileURLToPath(new URL('..', import.meta.url)));

/** The identity of the world of `key` in this build: the seed version, the bytes it is built from, the layer and the whole key. */
export function paidWorldEntry(layer: WorldLayer, key: Json): { text: string; name: string } {
  const text = canonical({ seed: PAID_WORLD_SEED, bytes: bytes(), layer, key });
  return { text, name: `${layer}-${digest(text).slice(0, 24)}` };
}

const verified = new Set<string>();
/** The first process names the bytes of the catalog; every other build is refused instead of silently served. */
function manifest(catalog: string): void {
  if (verified.has(catalog)) return;
  const path = join(catalog, 'manifest.json'), want = { seed: PAID_WORLD_SEED, node: process.version, bytes: bytes() };
  if (!existsSync(path)) {
    const draft = `${path}.${process.pid}.tmp`;
    writeFileSync(draft, JSON.stringify({ ...want, created: { pid: process.pid, at: new Date().toISOString() } }));
    try { linkSync(draft, path); } catch (error) { if (code(error) !== 'EEXIST') throw error; } finally { unlinkSync(draft); }
  }
  const have = JSON.parse(readFileSync(path, 'utf8')) as typeof want;
  if (have.seed !== want.seed || have.node !== want.node || have.bytes !== want.bytes)
    throw new Error(`The paid-world catalog ${catalog} was created by other bytes of the engine and its test helpers; a catalog serves one run only`);
  verified.add(catalog);
}

const attemptsOf = (catalog: string, name: string): Attempt[] => readdirSync(catalog).flatMap(entry => {
  const made = entry.startsWith(`${name}.build-`) ? /\.build-(\d+)$/.exec(entry) : null;
  return made ? [{ n: Number(made[1]), dir: join(catalog, entry) }] : [];
}).sort((a, b) => a.n - b.n);

type Standing = { building: true } | { building: false; why: string };
/** An attempt without `ready.json` is still being built only while its owner is the very process that named itself. */
function standing(attempt: Attempt, checked: { at: number }): Standing {
  const failed = join(attempt.dir, 'failed.json');
  if (existsSync(failed)) return { building: false, why: `attempt ${attempt.n} failed: ${(JSON.parse(readFileSync(failed, 'utf8')) as { message: string }).message}` };
  let owner: Owner;
  try { owner = JSON.parse(readFileSync(join(attempt.dir, 'owner.json'), 'utf8')) as Owner; }
  catch { return Date.now() - statSync(attempt.dir).mtimeMs < CLAIM_GRACE_MS ? { building: true } : { building: false, why: `attempt ${attempt.n} was claimed and never named its owner` }; }
  const gone: Standing = { building: false, why: `attempt ${attempt.n}: its builder ${owner.pid} is gone` };
  try { process.kill(owner.pid, 0); } catch (error) { if (code(error) !== 'EPERM') return gone; }
  if (Date.now() - checked.at >= IDENTITY_MS) {
    checked.at = Date.now();
    const seen = probeProcessIdentity(owner.pid);
    if (seen.state === 'absent' || (seen.state === 'present' && seen.started !== owner.started)) return gone;
  }
  return { building: true };
}

function open<T>(dir: string, text: string): World<T> {
  const ready = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')) as { key: string; data: string };
  if (ready.key !== text) throw new Error(`The paid-world entry ${dir} answers another key`);
  const packed = readFileSync(join(dir, 'data.bin'));
  if (digest(packed) !== ready.data) throw new Error(`The paid-world entry ${dir} changed after it was published`);
  if (!statSync(join(dir, 'world'), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The paid-world entry ${dir} has no world`);
  return { root: join(dir, 'world'), data: deserialize(packed) as T };
}

function record(catalog: string, line: { layer: WorldLayer; name: string; role: 'built' | 'reused' | 'waited'; ms: number }): void {
  try { appendFileSync(join(catalog, 'stats.ndjson'), `${JSON.stringify({ ...line, pid: process.pid })}\n`); } catch { /* a statistic never decides a test */ }
}

/**
 * The records of every consumer name the directories the builder made its world in (the Environment, the calls, the
 * requests), so in a catalog entry those roots live in `<entry>/runtime` until the run removes the catalog, instead of in
 * the temporary directory until the builder exits. `own` is the builder's usual stand-in for a TestContext, used without a
 * catalog; the stand-in for an entry registers no clean-up and carries the directory its roots are made in.
 */
export function builderContext(entry: string | undefined, own: TestContext): TestContext {
  if (entry === undefined) return own;
  const runtime = join(entry, 'runtime');
  mkdirSync(runtime);
  return { after: () => {}, diagnostic: () => {}, runtime } as unknown as TestContext;
}
const runtimeIn = (t: TestContext): string | undefined => (t as unknown as { runtime?: string }).runtime;
/** The directory a context makes its roots in: its entry's runtime directory for a builder, the temporary directory otherwise. */
export const rootsOf = (t: TestContext): string => runtimeIn(t) ?? tmpdir();
/** A fixture which makes its root in the temporary directory before its first await (researchSetup) makes it in the builder's roots instead. */
export function withRootsOf<T>(t: TestContext, action: () => T): T {
  const runtime = runtimeIn(t);
  if (runtime === undefined) return action();
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = runtime;
  try { return action(); } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
}

/**
 * The world of `key` from the run's catalog. `build` is the ordinary lazy construction: with a `parent` it must make the
 * snapshot in place at `<parent>/world` and return it; without a catalog it is called with no parent and is the only
 * thing that happens. The returned data is a fresh copy in every process. A process waits for a live builder `waitMs` at most.
 */
export async function sharedWorld<T>(layer: WorldLayer, key: Json, build: (parent?: string) => Promise<World<T>>, waitMs = WAIT_MS): Promise<World<T>> {
  const catalog = directory();
  if (catalog === null) return build();
  manifest(catalog);
  const { text, name } = paidWorldEntry(layer, key);
  const began = Date.now(), checked = { at: 0 };
  let me: Owner | null = null, waited = false;
  for (;;) {
    const attempts = attemptsOf(catalog, name), ready = attempts.find(attempt => existsSync(join(attempt.dir, 'ready.json'))), last = attempts.at(-1);
    if (ready) {
      const world = open<T>(ready.dir, text);
      record(catalog, { layer, name, role: waited ? 'waited' : 'reused', ms: Date.now() - began });
      return world;
    }
    const state = last === undefined ? null : standing(last, checked);
    if (state === null || !state.building) {
      if (attempts.length >= PAID_WORLD_ATTEMPTS)
        throw new Error(`The paid world ${name} was not built in ${PAID_WORLD_ATTEMPTS} attempts${state && !state.building ? `: ${state.why}` : ''}`);
      const dir = join(catalog, `${name}.build-${(last?.n ?? 0) + 1}`);
      me ??= { pid: process.pid, started: processStart(process.pid) };   // before the claim: nothing slow stands between it and the owner file
      try { mkdirSync(dir); } catch (error) { if (code(error) === 'EEXIST') continue; throw error; }
      try {
        publish(join(dir, 'owner.json'), me);
        const made = await build(dir);
        if (made.root !== join(dir, 'world')) throw new Error(`The paid world ${name} was built outside its entry: ${made.root}`);
        const packed = serialize(made.data);
        writeFileSync(join(dir, 'data.bin'), packed);
        publish(join(dir, 'ready.json'), { seed: PAID_WORLD_SEED, layer, key: text, data: digest(packed), builder: me.pid, at: new Date().toISOString() });
      } catch (error) {
        try { publish(join(dir, 'failed.json'), { message: error instanceof Error ? error.message : String(error) }); } catch { /* the entry is unwritable already */ }
        throw error;
      }
      record(catalog, { layer, name, role: 'built', ms: Date.now() - began });
      return open<T>(dir, text);
    }
    if (Date.now() - began > waitMs) throw new Error(`The paid world ${name} is still being built by a live process after ${waitMs / 1000} s`);
    waited = true; await sleep(POLL_MS);
  }
}

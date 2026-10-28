import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from '../src/canonical.js';
import { V8_FINAL_CONTRACT, V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { Discovery } from '../src/discovery/discovery.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareDiscoveryFinalAssessmentSubject } from '../src/discovery/discovery-final-assessment-subject.js';
import { prepareDiscoveryFinalAssessmentSession } from '../src/discovery/discovery-final-assessment-session.js';
import { DISCOVERY_FINAL_ASSESSMENT_RESULT } from '../src/discovery/discovery-final-assessment-result.js';
import { readDiscoveryFinalAssessmentExecutionAt, readDiscoveryFinalAssessmentPaidResultAt,
  runDiscoveryFinalAssessmentExecution, type DiscoveryFinalAssessmentPaidResult } from '../src/discovery/discovery-final-assessment-execution.js';
import type { DiscoveryFinalPaidResult } from '../src/discovery/discovery-final-execution.js';
import { finalPaid, type FinalOutcome, type FinalSeedForm, type FinalSeedRoute } from './discovery-v7-final-paid-seed.js';
import { builderContext, sharedWorld } from './discovery-v7-paid-world-cache.js';

export interface FinalAssessmentSeedOptions {
  verdict?: 'supported' | 'return';
  outcome?: FinalOutcome;
  route?: FinalSeedRoute;
  /** Explicit conditions of a conditional paid D7 (7b.3); absent keeps the default evidence-1. */
  conditions?: unknown;
  /** 7b.3-class / A1: the explicit D7 form version discovery-final/v8 or v9; absent keeps discovery-final/v7. */
  form?: FinalSeedForm;
}
const cleanups: (() => void)[] = [];
process.once('exit', () => { for (const cleanup of cleanups.reverse()) cleanup(); });
const lifetime = { after: (cleanup: () => void) => cleanups.push(cleanup), diagnostic: () => {} } as unknown as TestContext;
type FinalWorld = Awaited<ReturnType<typeof finalPaid>>;
type SeedData = {
  final: Pick<FinalWorld, 'd6' | 'packet' | 'prepared' | 'execution' | 'paidResult'>;
  prepared: Ref; execution: Ref; paidResult: Ref;
};
type Snapshot = { root: string; data: SeedData };
const seeds = new Map<string, Promise<Snapshot>>();

/** `entry` is a catalog entry of this run (test/discovery-v7-paid-world-cache.ts): the snapshot is made in place at `entry/world`
 * and the catalog, not this process, owns it until the run ends. Without one it is this process's own temporary directory. */
async function build(options: Required<Omit<FinalAssessmentSeedOptions, 'conditions' | 'form'>>
  & { conditions?: unknown; form?: FinalSeedForm }, entry?: string): Promise<Snapshot> {
  const f = await finalPaid(builderContext(entry, lifetime), options.outcome, options.route, options.conditions, options.form);
  const packet = await prepareDiscoveryFinalAssessmentSubject(f.store, 'p', f.d6, f.result.value.projection.result.bundle);
  // A real independent reviewer measurement is part of the first caller's
  // work. No consumer or copied world has to calibrate or buy this again.
  f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable',
    evidence: [], text: 'Measure the independent final reviewer' }, citations: [] });
  await researchCall(f.environment.value.reviewer, f.environment.value, 'Measure the final assessment seed reviewer', {}, undefined,
    { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  const prepared = await prepareDiscoveryFinalAssessmentSession(f.store, 'p', packet.subject,
    { prompt: 'Review the complete exact paid final candidate', packetChars: 8_000_000, limitChars: 9_000_000,
      resultLimitChars: 10_000_000, environment: reference(f.environment), role: f.environment.value.reviewer });
  const bases = [{ candidate: '/verdict' }];
  // 7b.3-class: a classed candidate's answer reviews every owner condition — confirmed when supported, rejected in a return.
  const conditions = packet.candidate.verdict.conditions as { id: string; kind: string; class?: string }[];
  const classes = options.form ? conditions.flatMap((condition, index) => condition.kind !== 'owner_choice' ? [] : [{
    conditionId: condition.id, class: condition.class, judgement: options.verdict === 'supported' ? 'confirmed' : 'rejected',
    reason: `Reviewed the class against the options of ${condition.id}`, bases: [{ candidate: `/verdict/conditions/${index}` }] }]) : undefined;
  f.reply({ contract: DISCOVERY_FINAL_ASSESSMENT_RESULT, subject: packet.subject, verdict: options.verdict,
    reasons: ['The exact paid final candidate was independently reviewed'], bases,
    return: options.verdict === 'supported' ? null : { targets: bases, reason: 'The final decision needs another basis', bases },
    ...(classes ? { classes } : {}) });
  const paid = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, reference(prepared), { profile: f.profile });
  assert.ok(paid.output && paid.result);
  assert.equal(paid.result.verdict, options.verdict);
  const root = entry === undefined ? mkdtempSync(join(tmpdir(), 'omg-final-assessment-snapshot-')) : join(entry, 'world');
  const database = new Set([f.path, `${f.path}-wal`, `${f.path}-shm`]);
  cpSync(f.root, root, { recursive: true, filter: path => !database.has(path) });
  const db = new DatabaseSync(f.path);
  try { db.prepare('VACUUM INTO ?').run(join(root, 'state.sqlite')); } finally { db.close(); }
  chmodSync(join(root, 'state.sqlite'), 0o400);
  // Rewrite only the runtime adapter of the copy, never stored commands or
  // historical Refs. Each plant will configure its own current environment.
  const script = readFileSync(join(root, 'adapter.mjs'), 'utf8');
  writeFileSync(join(root, 'adapter.mjs'), script.replaceAll(f.root, root));
  if (entry === undefined) cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, data: structuredClone({ final: { d6: f.d6, packet: f.packet, prepared: f.prepared,
    execution: f.execution, paidResult: f.paidResult }, prepared: reference(prepared),
    execution: reference(paid.session), paidResult: reference(paid.output) }) };
}

function plant(t: TestContext, seed: Snapshot) {
  const root = mkdtempSync(join(tmpdir(), 'omg-final-assessment-copy-')), path = join(root, 'state.sqlite');
  cpSync(seed.root, root, { recursive: true }); chmodSync(path, 0o600);
  writeFileSync(join(root, 'adapter.mjs'), readFileSync(join(root, 'adapter.mjs'), 'utf8').replaceAll(seed.root, root));
  const handles: Store[] = [];
  const open = () => { const value = new Store(path); handles.push(value); return value; };
  let store = open();
  t.after(() => { for (const handle of handles) handle.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), old = engine.environments.get('p');
  const { projectId: _project, ...saved } = old.value;
  const command = { executable: process.execPath, args: [join(root, 'adapter.mjs')] };
  const environment = engine.environments.configure('p', { ...saved, workspace: root,
    implementer: { ...saved.implementer, command }, reviewer: { ...saved.reviewer, command }, fullCheck: command }, old.revision);
  const previous = store.get<import('../src/discovery/reader-pilot.js').ReaderPilot>('reader-pilot:p')!;
  const { projectId: _profileProject, ...settings } = previous.value;
  const profile = configureReaderPilot(store, engine.environments, 'p', { ...settings,
    reader: { ...settings.reader, command }, agentCommand: command }, previous.revision);
  const data = structuredClone(seed.data);
  const result = store.get<DiscoveryFinalAssessmentPaidResult>(data.paidResult.id, data.paidResult.revision)!;
  const finalResult = store.get<DiscoveryFinalPaidResult>(data.final.paidResult.id, data.final.paidResult.revision)!;
  assert.deepEqual(reference(result), data.paidResult); assert.deepEqual(reference(finalResult), data.final.paidResult);
  return { root, path, project: 'p', get store() { return store; }, get engine() { return new ProductEngine(store); },
    get discovery() { return new Discovery(store); }, environment, profile, data,
    final: { ...data.final, result: finalResult }, paidD7: data.final.paidResult,
    prepared: data.prepared, execution: data.execution, paidResult: data.paidResult, result,
    packet: result.value.projection.packet, open,
    reopen() { for (const handle of handles) handle.close(); store = open(); return store; },
    read: (source: Store = store) => readDiscoveryFinalAssessmentPaidResultAt(source, 'p', data.paidResult),
    readExecution: (source: Store = store) => readDiscoveryFinalAssessmentExecutionAt(source, 'p', data.execution),
    restore: (source: Store = store) => runDiscoveryFinalAssessmentExecution(source, 'p', data.final.paidResult,
      data.prepared, { restoreOnly: true, allowance: 0 }),
    reply(value: unknown) { writeFileSync(join(root, 'reply.json'), JSON.stringify({ tokens: 10, reply: value })); },
    wires: (): unknown[] => readFileSync(join(root, 'wire.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) };
}

/** A lazily paid D7 assessment, built in the first consumer's test. Copies
 * preserve exact paid history while isolating database, values and runtime. */
export async function finalAssessmentPaid(t: TestContext, options: FinalAssessmentSeedOptions = {}) {
  // One JSON snapshot of explicit conditions before the first await: it keys both caches and builds the paid world.
  // CONDITION-SEED-SNAPSHOT-01: the property is read once into a local value, and only that value is snapshotted.
  const raw = options.conditions, form = options.form;
  const conditions = raw === undefined ? undefined : JSON.parse(canonical(raw as never)) as unknown;
  assert.ok(form === undefined || form === V8_FINAL_CONTRACT || form === V9_FINAL_CONTRACT, 'an explicit form is discovery-final/v8 or v9');
  const selected = { verdict: options.verdict ?? 'supported', outcome: options.outcome ?? 'go', route: options.route ?? 'owner',
    ...(conditions === undefined ? {} : { conditions }), ...(form === undefined ? {} : { form }) };
  assert.ok(['supported', 'return'].includes(selected.verdict));
  assert.ok(['go', 'conditional', 'no_go', 'insufficient_evidence'].includes(selected.outcome));
  assert.ok(['owner', 'model', 'partial'].includes(selected.route));
  const key = `${selected.route}:${selected.outcome}:${selected.verdict}${conditions === undefined ? '' : `:${canonical(conditions as never)}`}`
    + (form === undefined ? '' : `:${form}`);
  let pending = seeds.get(key);
  if (!pending) {
    // The run's catalog tells worlds apart by exactly this key, which carries every parameter and the one snapshot of the conditions.
    pending = sharedWorld('assessment', key, entry => build(selected, entry));
    seeds.set(key, pending); pending.catch(() => seeds.delete(key));
  }
  return plant(t, await pending);
}

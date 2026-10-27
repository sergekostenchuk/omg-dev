import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import type { TestContext } from 'node:test';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Environment } from '../src/runtime/environment.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { paid, deep, assess, claim, modeOf, type Selected } from './discovery-v7-dossier-seed.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSet, type VariantNone } from '../src/discovery/discovery-variants.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantModelDecision } from '../src/discovery/variant-decision.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { V7_AXES } from '../src/discovery/v7-contracts.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { assessDossier } from '../src/discovery/research-assessment.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS } from '../src/discovery/research-model.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { prepareDiscoveryFinalSubject, type DiscoveryFinalPacket } from '../src/discovery/discovery-final.js';
import { DISCOVERY_FINAL_RESULT } from '../src/discovery/discovery-final-result.js';
import { V7_FINAL_CONTRACT, V8_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { prepareDiscoveryFinalSession } from '../src/discovery/discovery-final-session.js';
import { readDiscoveryFinalExecutionAt, runDiscoveryFinalExecution } from '../src/discovery/discovery-final-execution.js';
import { researchCall } from '../src/discovery/research-protocol.js';

export type FinalOutcome = 'go' | 'conditional' | 'no_go' | 'insufficient_evidence';
export type FinalSeedRoute = 'owner' | 'model' | 'partial';
export const FINAL_SEED_BRIEF = '  Build an exact ledger for two regions.\nKeep roles, alternatives and constraints — α.  ';
const cleanups: (() => void)[] = [];
process.once('exit', () => { for (const cleanup of cleanups.reverse()) cleanup(); });
const lifetime = { after: (cleanup: () => void) => cleanups.push(cleanup), diagnostic: () => {} } as unknown as TestContext;
type Snapshot<T> = { root: string; data: T };

function snapshot<T>(root: string, path: string, data: T): Snapshot<T> {
  const parent = mkdtempSync(join(tmpdir(), 'omg-final-paid-snapshot-')), target = join(parent, 'world');
  const database = new Set([path, `${path}-wal`, `${path}-shm`]);
  cpSync(root, target, { recursive: true, filter: source => !database.has(source) });
  const db = new DatabaseSync(path);
  try { db.prepare('VACUUM INTO ?').run(join(target, 'state.sqlite')); } finally { db.close(); }
  chmodSync(join(target, 'state.sqlite'), 0o400);
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  return { root: target, data: structuredClone(data) };
}

function profileFor(store: Store, engine: ProductEngine, environment: Revision<Environment>) {
  const previous = store.get('reader-pilot:p');
  return configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'dossier-reader', model: environment.value.reviewer.model, effort: environment.value.reviewer.effort,
      command: environment.value.reviewer.command, speed: 'inherited' }, agentCommand: environment.value.reviewer.command,
    maxRequestChars: 12_000_000, maxReadChars: 128000, maxReplyChars: 100000, maxCalls: 100, maxReportedTokens: 100000,
    physicalLimits: { maxRequestChars: 12_000_000, maxReplyChars: 100000, basis: 'Full local dossier delivery' } }, previous?.revision ?? 0);
}

async function buildDossier(route: FinalSeedRoute) {
  // The dependency supplies the genuine paid broad sweep. Its original variant
  // generation predates a brief, so a new real generation fixes the accepted
  // assignment in its own historical draft; old Refs are never rewritten.
  const f = await paid(lifetime, undefined, true);
  const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!;
  const brief = draft.value.questions.map(id => f.store.get<Question>(id)!).find(q => q.value.spec.field === 'brief')!;
  const source = f.discovery.evidence.document('p', 'final-seed-assignment', `PREFIX${FINAL_SEED_BRIEF}SUFFIX`, 'text/plain', 0);
  f.discovery.fact(brief.id, brief.revision, reference(source), { kind: 'text-range', start: 6, end: 6 + FINAL_SEED_BRIEF.length });
  const saved = produceVariantSnapshot(f.store, 'p').record;
  const judgement = { conclusion: 'Bounded paid sweep', grounds: [], assumptions: [], unknowns: ['Beyond the saved sweep'], quantity: null };
  f.reply(route === 'partial' ? { action: 'no_variants', reasons: [{ code: 'bounded_search', message: 'No bounded variant', grounds: [reference(saved)] }],
    searchLimits: ['Saved sweep'], unknowns: ['Demand remains unknown'] } : { action: 'variants', variants: [1, 2].map(i => ({ key: `seed-v${i}`, title: `Seed variant ${i}`,
    proposal: { scope: `scope-${i}` }, criteria: Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement])) })),
    scale: Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'Shared scale'])), comparison: 'Two bounded variants',
    recommendation: { key: 'seed-v1', reason: 'Bounded owner goal' }, searchLimits: ['Saved sweep'], unknowns: [] });
  await runVariantSession(f.store, { projectId: 'p', environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Generate from the accepted assignment', variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal',
      snapshot: reference(saved), mode: reference(f.questions), expectedSelection: reference(f.state1) } });
  let root: Ref;
  if (route === 'partial') {
    const none = f.store.list<VariantNone>('discovery-variant-none').find(row => row.value.snapshot.hash === saved.hash)!;
    assert.ok(none);
    const handoff = await publishVariantHandoff(f.store, 'p', { draft: reference(f.store.get(f.v.draft.id)!),
      result: reference(none), decision: null, scope: null, earlyLimit: false });
    root = reference((await producePartialDossier(f.store, 'p', reference(handoff.record))).record);
  } else {
    const set = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.snapshot.hash === saved.hash)!;
    assert.ok(set, 'the accepted brief has its own real paid generation');
    const scope = { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set), mode: reference(f.questions),
      operation: 'initial' as const, previous: null, expectedSelection: reference(f.store.get(variantStateId('p', set.value.draft.id))!),
      outcome: { kind: 'choose' as const, member: set.value.members[0]!, reason: 'The exact assignment fits this bounded variant' } };
    let decision: Ref;
    if (route === 'owner') {
      const sessions = new VariantChoiceSessions(f.store), issued = issueVariantChoiceInvitation(f.store, scope);
      assert.ok(issued.ok);
      const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
      assert.ok(login.ok);
      decision = reference(answerVariantChoice(f.store, scope, sessions.authority(login.value.bearer)!).decision);
    } else {
      const mode = modeOf(f.store, 'bypass');
      f.reply({ action: 'choose', key: 'seed-v1', reason: 'Real paid model choice' });
      // The common forecast learns this new purpose through an actual same-role
      // calibration call; the following managed session supplies the decision.
      await researchCall(f.environment.value.implementer, f.environment.value, 'Measure variant decision',
        { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: reference(set), mode: reference(mode), expectedSelection: null } }, undefined,
        { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
      await runVariantSession(f.store, { projectId: 'p', environment: f.environment, role: f.environment.value.implementer,
        prompt: 'Choose the exact paid variant', variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision',
          set: reference(set), mode: reference(mode), expectedSelection: reference(f.store.get(variantStateId('p', set.value.draft.id))!) } });
      const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.set.hash === set.hash);
      assert.ok(model); decision = reference(model);
    }
    const selected = publishVariantScope(f.store, 'p', decision).scope;
    const world: Selected = { ...f, saved, set, draft: set.value.draft, scope, scopeRecord: selected,
      input: { scope: reference(selected), plan: f.v.planAnswer } };
    const industry = await deep(world, 'q-industry', V7_AXES.map(axis => claim(world, 'q-industry', axis, `Exact ${axis} basis`)));
    await assess(world, industry);
    const market = await deep(world, 'q-market', [claim(world, 'q-market', 'market', 'Market basis')]);
    await assess(world, market);
    root = reference(produceSelectedDossier(f.store, 'p', world.input).record);
  }
  const dossier = await prepareDossierAssessmentSubject(f.store, 'p', root);
  const bases = [{ record: dossier.manifest.ref }];
  f.reply({ contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: dossier.subject, verdict: route === 'partial' ? 'return' : 'supported', reasons: ['Exact saved dossier'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(key => [key, { judgement: 'adequate', reason: `Reviewed ${key}`, bases }])),
    inventory: { materials: dossier.materials.map(item => item.address), unknowns: dossier.unknowns.map(item => item.unknown.claim),
      contradictions: dossier.contradictions.map(item => ({ id: item.contradiction.id, sides: item.sides.map(side => side.address), grounds: item.grounds.map(row => row.ref) })) },
    return: route === 'partial' ? { targets: [{ partialReason: 0 }], reason: 'Resolve the saved partial reason', bases } : null });
  const profile = profileFor(f.store, f.engine, f.environment);
  const d6 = await assessDossier(f.store, 'p', dossier.subject, f.environment, profile);
  const packet = await prepareDiscoveryFinalSubject(f.store, 'p', reference(d6));
  return { ...f, d6, packet, profile };
}

/** The paid D7 reply; explicit conditions (7b.3, codex-omg2 №16161) replace the default evidence-1 of a conditional
 * bundle only when given, and are never defaulted when empty, null or malformed. */
/** 7b.3-class (codex-omg2 №16183): an explicit form version (discovery-final/v8) only when given; v7 otherwise. */
export function finalCandidate(packet: DiscoveryFinalPacket, outcome: FinalOutcome, conditions?: unknown, form?: typeof V8_FINAL_CONTRACT) {
  if (conditions !== undefined) assert.equal(outcome, 'conditional', 'explicit conditions belong to a conditional bundle');
  const verdict = { outcome, reason: 'The saved final decision keeps its own reasons', conditions: conditions !== undefined ? conditions
    : outcome === 'conditional' ? [{ id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' }] : [] };
  const bundle = outcome === 'go' || outcome === 'conditional'
    ? { contract: form ?? V7_FINAL_CONTRACT, dossier: packet.dossier.manifest.ref, verdict,
      summary: { what: 'Ledger', forWhom: 'Operators', why: 'Traceability', firstResult: 'A first record', successCriterion: 'No missing record', nonGoals: ['Payroll'] },
      projection: { users: ['Operator'], payers: ['Company'], rules: ['Policy'], externalSystems: ['Books'], unresolved: ['Integration'] },
      constitution: { goal: 'Traceability', consumers: ['Operator'], nonGoals: ['Payroll'], successCriterion: 'No missing record' } }
    : { contract: form ?? V7_FINAL_CONTRACT, dossier: packet.dossier.manifest.ref, verdict,
      summary: { reasons: ['A bounded refusal'], found: ['Evidence'], needed: ['More evidence'] }, projection: null, constitution: null };
  return { contract: DISCOVERY_FINAL_RESULT, subject: structuredClone(packet.subject), bundle };
}

function adapter(root: string) {
  // Real bounded delivery: ask for each not-yet-delivered exact material before
  // terminal. The paid baseline uses a full first packet, but this also serves
  // consumers preparing a smaller first wire on their independent copy.
  return `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),file=${JSON.stringify(join(root, 'reply.json'))},s=JSON.parse(readFileSync(file,'utf8'));
appendFileSync(${JSON.stringify(join(root, 'wire.ndjson'))},raw+'\\n');
const key=(record,pointer)=>JSON.stringify([record.id,record.revision,record.hash,pointer]);
const save=(k,a,b)=>{(s.coverage??={})[k]??=[];s.coverage[k].push([a,b]);};
for(const v of [...(r.subject.materialDelivery??[]),...(r.subject.contextDelivery??[])])save(key(v.original.record,v.original.pointer),v.served.offset,v.served.end);
for(const v of r.subject.contextWorkspace??[]){const a=(r.subject.working?.materialAddresses??[]).find(x=>key(x.record,x.pointer)===key(v.record,v.pointer));if(v.page)save(key(v.record,v.pointer),v.page.offset,v.page.end);else if(a)save(key(v.record,v.pointer),0,a.total);}
let research=s.reply;
for(const a of r.subject.working?.materialAddresses??[]){const k=key(a.record,a.pointer),ranges=(s.coverage?.[k]??[]).sort((a,b)=>a[0]-b[0]);let offset=0;for(const [start,end] of ranges){if(start>offset)break;offset=Math.max(offset,end);}if(offset<a.total){research={action:'read_context',record:a.record,pointer:a.pointer,page:{offset,limit:128000,...(a.encoding==='canonical-json'?{encoding:'canonical-json'}:{})}};break;}}
writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`;
}

interface DossierData { d6: Ref; packet: DiscoveryFinalPacket; calibration: { draft: Ref; question: Ref } }
interface PaidData extends DossierData { prepared: Ref; execution: Ref; paidResult: Ref }
const dossierSeeds = new Map<FinalSeedRoute, Promise<Snapshot<DossierData>>>();
const paidSeeds = new Map<string, Promise<Snapshot<PaidData>>>();

async function dossierBaseline(route: FinalSeedRoute) {
  let pending = dossierSeeds.get(route);
  if (!pending) {
    pending = (async () => {
      const f = await buildDossier(route);
      return snapshot(f.root, f.path, { d6: reference(f.d6), packet: f.packet,
        calibration: { draft: reference(f.calibration.draft), question: reference(f.calibration.question) } });
    })();
    dossierSeeds.set(route, pending); pending.catch(() => dossierSeeds.delete(route));
  }
  return pending;
}

function plant<T extends DossierData>(t: TestContext, seed: Snapshot<T>) {
  const root = mkdtempSync(join(tmpdir(), 'omg-final-paid-copy-')), path = join(root, 'state.sqlite');
  cpSync(seed.root, root, { recursive: true }); chmodSync(path, 0o600);
  const stores: Store[] = [], open = () => { const store = new Store(path); stores.push(store); return store; };
  let store = open();
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  const settings = join(root, 'reply.json');
  writeFileSync(join(root, 'adapter.mjs'), adapter(root));
  const old = engine.environments.get('p'), { projectId: _project, ...kept } = old.value;
  const command = { executable: process.execPath, args: [join(root, 'adapter.mjs')] };
  const environment = engine.environments.configure('p', { ...kept, workspace: root, implementer: { ...kept.implementer, command },
    reviewer: { ...kept.reviewer, command }, fullCheck: command }, old.revision);
  const profile = profileFor(store, engine, environment), data = structuredClone(seed.data);
  return { root, path, project: 'p', get store() { return store; }, get engine() { return new ProductEngine(store); },
    get discovery() { return new Discovery(store); }, environment, profile, data, open,
    reopen() { for (const db of stores) db.close(); store = open(); return store; },
    reply(value: unknown) { writeFileSync(settings, JSON.stringify({ tokens: 10, reply: value })); },
    wires: (): unknown[] => readFileSync(join(root, 'wire.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

async function buildPaid(outcome: FinalOutcome, route: FinalSeedRoute, conditions?: unknown, form?: typeof V8_FINAL_CONTRACT): Promise<Snapshot<PaidData>> {
  const f = plant(lifetime, await dossierBaseline(route)), { packet, d6, calibration } = f.data;
  // A different command is deliberately uncalibrated; pay a genuine same-role
  // measurement on this copy rather than borrowing the seed's old command.
  f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Calibration' }, citations: [] });
  await researchCall(f.environment.value.implementer, f.environment.value, 'Measure final seed role', {}, undefined,
    { store: f.store, draftId: calibration.draft.id, questionId: calibration.question.id, purpose: 'assessor' });
  const prepared = await prepareDiscoveryFinalSession(f.store, 'p', packet.subject,
    { prompt: 'Build the exact final Discovery package.', packetChars: 8_000_000, limitChars: 9_000_000,
      resultLimitChars: 10_000_000, environment: reference(f.environment), role: f.environment.value.implementer,
      ...(form ? { form } : {}) });
  f.reply(finalCandidate(packet, outcome, conditions, form));
  const paid = await runDiscoveryFinalExecution(f.store, 'p', reference(prepared), { profile: f.profile });
  assert.ok(paid.output && paid.result);
  assert.equal(paid.result.result.bundle.verdict.outcome, outcome);
  return snapshot(f.root, f.path, { d6, packet, calibration, prepared: reference(prepared),
    execution: reference(paid.session), paidResult: reference(paid.output) });
}

/** Lazy, genuinely paid D6→D7 baseline. No test registration or named-test
 * dependency. Each call copies DB and runtime files and configures only its
 * current Environment/profile; historical refs stay byte-exact. Restoring a
 * paid result never dispatches or calibrates a model. First construction is
 * awaited here, so its cost remains inside the calling test/file. */
export async function finalPaid(t: TestContext, outcome: FinalOutcome = 'go', route: FinalSeedRoute = 'owner', conditions?: unknown,
  form?: typeof V8_FINAL_CONTRACT) {
  assert.ok(form === undefined || form === V8_FINAL_CONTRACT, 'an explicit form is discovery-final/v8');
  assert.ok(['go', 'conditional', 'no_go', 'insufficient_evidence'].includes(outcome));
  assert.ok(['owner', 'model', 'partial'].includes(route));
  // One JSON snapshot of explicit conditions before the first await: it keys the cache and builds the paid world.
  const given = conditions === undefined ? undefined : JSON.parse(canonical(conditions as never)) as unknown;
  const key = (given === undefined ? `${route}:${outcome}` : `${route}:${outcome}:${canonical(given as never)}`) + (form ? `:${form}` : '');
  let pending = paidSeeds.get(key);
  if (!pending) { pending = buildPaid(outcome, route, given, form); paidSeeds.set(key, pending); pending.catch(() => paidSeeds.delete(key)); }
  const f = plant(t, await pending), { packet, prepared, execution, paidResult, d6 } = f.data;
  const exact = <T>(ref: Ref): Revision<T> => {
    const row = f.store.get<T>(ref.id, ref.revision);
    assert.ok(row && row.hash === ref.hash); return row;
  };
  return { ...f, get store() { return f.store; }, get engine() { return f.engine; }, get discovery() { return f.discovery; },
    packet, prepared, execution, paidResult, d6,
    result: exact<import('../src/discovery/discovery-final-execution.js').DiscoveryFinalPaidResult>(paidResult),
    restore: () => runDiscoveryFinalExecution(f.store, 'p', prepared, { restoreOnly: true }),
    read: () => readDiscoveryFinalExecutionAt(f.store, 'p', execution) };
}

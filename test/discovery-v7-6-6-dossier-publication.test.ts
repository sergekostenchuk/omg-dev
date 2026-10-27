import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeUnchanged, storeRefused } from './store-unchanged.js';
import { storeView } from '../src/storage/store-view.js';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { Discovery } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession, type VariantSessionInput } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION, type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';
import { DISCOVERY_DEEP_PREPARATION_CONTRACT, produceDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { V7_AXES, DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import type { VariantNone } from '../src/discovery/discovery-variants.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';

// Real paid generation/selection preparation shared in shape with the accepted 4P.1 scenarios.
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
}
const judgement = { conclusion: 'Bounded by the paid sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the saved sweep'], quantity: null };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'Same shared scale']));
const generation = () => ({ action: 'variants', variants: [1, 2].map(i => ({ key: `v${i}`, title: `Variant ${i}`, proposal: { scope: `scope-${i}` }, criteria })),
  scale, comparison: 'Two bounded variants on one scale', recommendation: { key: 'v2', reason: 'The generation recommends the wider one' },
  searchLimits: ['Only the saved sweep'], unknowns: [] });


/** The real paid line of 4B.1/4O.2: two assessed plan questions, the variant snapshot, real project modes and the real
 * paid generation of a two-member set with its first state. */
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial: boolean|string = false) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-64-transport-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Selected variant scope' });
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const old = runs.get(selected.planAnswer.hash), run = old ? f.store.get<ResearchRun>(old)! : f.store.write<ResearchRun>({
      id: `research-run:${rand()}`, kind: 'research-run', expected: 0, value: { projectId: project, draftId: draft.id, environment: reference(f.environment),
        turns: 0, limit: 100, requestChars: 0, owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run), draft: reference(draft), question: reference(question),
      role: f.environment.value.implementer, dispatch: f.environment.value, profile: null, cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input), invoke = () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const end = withMaterial && question === 'q-industry' ? { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT,
      value: { claims: [{ id: 'broad-rejected', kind: 'hypothesis', text: typeof withMaterial==='string'?withMaterial:'Real pre-choice rejected material', axis: 'industry',
        planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants: 'common' },
        basis: { howToVerify: 'Observe this bounded claim' } }] } } : undefined;
    const entry = await produce(g, end, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: end ? [{ claim: { project, container: entry.attempt, containerKind: 'research-attempt', pointer: '/claims/0', claimId: 'broad-rejected' }, reason: 'Rejected by the real paid assessment' }] : [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
      methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
    const assessment = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
    applyDiscoveryAssessment(f.store, project, reference(assessment));
  }
  const saved = produceVariantSnapshot(f.store, project).record;
  const modeSessions = new ProjectModeSessions(f.store), invite = ok(issueProjectModeInvitation(f.store, { project, mode: 'questions', previous: null }));
  const exchanged = ok(modeSessions.exchange({ project, invitation: invite.invitation }));
  const questions = setProjectMode(f.store, { project, mode: 'questions', previous: null }, modeSessions.authority(exchanged.bearer)).record;
  ok(modeSessions.revoke(exchanged.bearer));
  const reply = (value: unknown) => writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: value }));
  const subject: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(saved), mode: reference(questions), expectedSelection: null };
  // Transport-only service calibration; the positive producer below uses the real snapshot.
  const calibration = f.store.write({ id: 'transport-fixture:scope-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer]) {
    reply(generation());
    await researchCall(role, f.environment.value, 'Calibrate generation', { variantSubject: { ...subject, snapshot: reference(calibration) }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  }
  reply(typeof answer === 'function' ? answer(reference(saved)) : answer);
  await runVariantSession(f.store, { projectId: project, environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Propose variants from this exact paid sweep', variantSubject: subject });
  const found = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === project) ?? null;
  if (!found) {
    const noneDraft = reference(f.store.get<DiscoveryDraft>(f.v.draft.id)!);
    return { ...g, project, saved, questions, reply, set: null, draft: noneDraft,
      state1: f.store.get<VariantState>(variantStateId(project, noneDraft.id))!, scope: null };
  }
  const set = found, draft = set.value.draft, state1 = f.store.get<VariantState>(variantStateId(project, draft.id))!;
  const scope: VariantChoiceScope = { action: VARIANT_OWNER_ACTION, projectId: project, draft, set: reference(set), mode: reference(questions),
    operation: 'initial', previous: null, expectedSelection: reference(state1), outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'The exact paid set fits the owner goal' } };
  return { ...g, project, saved, questions, reply, set, draft, state1, scope };
}

const mint = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const exchanged = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...exchanged, authority: sessions.authority(exchanged.bearer)! };
};
const modeOf = (store: Store, mode: 'questions' | 'bypass') => {
  const previous = store.get('project-mode:p'), scope = { project: 'p', mode, previous: previous ? reference(previous) : null };
  const sessions = new ProjectModeSessions(store), issued = ok(issueProjectModeInvitation(store, scope));
  const login = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  return setProjectMode(store, scope, sessions.authority(login.bearer)).record;
};
/** The real paid bypass model decision over the current set, choose or reject_all. */
async function modelChoose(f: Awaited<ReturnType<typeof paid>>, outcome: 'choose' | 'reject_all' = 'choose') {
  const mode = modeOf(f.store, 'bypass');
  f.reply(outcome === 'choose' ? { action: 'choose', key: 'v1', reason: 'Real paid model choice' } : { action: 'reject_all', reason: 'Real paid model rejection' });
  const calibration = reference(f.store.write({ id: 'transport-fixture:scope-decision-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT,
      kind: 'decision', set: calibration, mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
  const input: VariantSessionInput = { projectId: 'p', environment: f.environment, role: f.environment.value.implementer, prompt: 'Choose from the exact paid set',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: reference(f.set!), mode: reference(mode), expectedSelection: reference(f.store.get(variantStateId('p', f.scope!.draft.id))!) } };
  await runVariantSession(f.store, input);
  return f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === 'p')!;
}

type Paid = Awaited<ReturnType<typeof paid>>;
function selected(f: Paid) {
  const act = answerVariantChoice(f.store, f.scope!, mint(f.store, f.scope!).authority);
  return { act, published: publishVariantScope(f.store, 'p', reference(act.decision)).scope };
}
function inputFor(f: Paid, scope: ReturnType<typeof publishVariantScope>['scope'], questionId = 'q-industry'): DeepPreparation {
  const question = provePlanQuestions(f.store, f.store.get<DiscoveryDraft>(scope.value.draft.id, scope.value.draft.revision)!,
    f.v.planAnswer).find(item => item.planQuestionId === questionId)!.question as Record<string, Json>;
  return { contract: DISCOVERY_DEEP_PREPARATION_CONTRACT, cell: { contract: DISCOVERY_COVERAGE_CELL_CONTRACT,
    projectId: 'p', subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: f.v.planAnswer, planQuestionId: questionId },
    variant: { set: scope.value.set, member: scope.value.member }, requiredDepth: question.requiredDepth as string,
    criterion: question.criterion as string }, scope: reference(scope) };
}
function nextPlan(f: Paid, store: Store) {
  const engine = new ProductEngine(store), discovery = new Discovery(store), plan = store.get<Question>(f.v.plan.id)!;
  discovery.reopen(plan.id, plan.revision);
  const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(f.v.draft.id)!;
  const source = discovery.evidence.document('p', 'deep-next-plan', 'Next accepted plan', 'text/plain', 0);
  const questions = provePlanQuestions(store, f.v.draft, f.v.planAnswer).map(item => item.question as unknown as PlanQuestion);
  answerDiscoveryFixture(engine, 'p', draft, question, validPlan(f.v.frameRef, questions, 2, f.v.planAnswer), source);
  return store.get<Question>(plan.id)!.value.answer!;
}


const all = (store: Store) => {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
    revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id,revision').all() } as never); }
  finally { db.close(); }
};
async function unchanged<T>(f: Paid, store: Store, action: () => Promise<T>, refuses = false): Promise<T | undefined> {
  const calls = money(store), wires = f.wires();
  let result: T | undefined;
  if (refuses) await storeRefused(store, action);
  else result = await storeUnchanged(store, action);
  assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  return result;
}
/** Full product history is compared once around a fixed-point block; each
 * individual public door inside it still has its own real Store stamp/money/wire. */
async function fixedPoint<T>(store:Store,action:()=>Promise<T>):Promise<T> {
  const before=all(store);try{return await action();}finally{assert.equal(all(store),before);}
}
interface World {root:string;path:string;store:Store;engine:ProductEngine;discovery:Discovery;open:()=>Store}
const seeds=new Map<string,{value:World;snapshot:string;active:Store[]}>();
const disposeSeeds:(()=>void)[]=[];
after(()=>{for(const seed of seeds.values())for(const db of seed.active)db.close();for(const dispose of disposeSeeds)dispose();});
/** Real producers run once per route. Restore their complete closed world at its
 * original path before opening a test's Stores; historical paths/Refs/hashes are
 * never rewritten. Only sequential tests use these roots. No proof is cached. */
async function isolated<T extends World>(t:test.TestContext,key:string,make:(lifetime:test.TestContext)=>Promise<T>):Promise<T> {
  let seed=seeds.get(key);
  if(!seed){
    const value=await make({after:(dispose:()=>void)=>disposeSeeds.push(dispose)} as unknown as test.TestContext);value.store.close();
    const snapshot=mkdtempSync(join(tmpdir(),'omg-live-seed-'));cpSync(value.root,join(snapshot,'world'),{recursive:true});
    disposeSeeds.push(()=>rmSync(snapshot,{recursive:true,force:true}));seed={value,snapshot,active:[]};seeds.set(key,seed);
  }
  for(const db of seed.active)db.close();
  const base=seed.value as T;
  for(const name of readdirSync(base.root))rmSync(join(base.root,name),{recursive:true,force:true});
  cpSync(join(seed.snapshot,'world'),base.root,{recursive:true});
  const stores:Store[]=[],open=()=>{const db=new Store(base.path);stores.push(db);return db;},store=open();
  seed.active=stores;
  t.after(()=>{for(const db of stores)db.close();});
  return {...base,store,open,engine:new ProductEngine(store),discovery:new Discovery(store)};
}
async function setupRaw(t: test.TestContext, model = false) {
  const f = await paid(t);
  const decision = model ? await modelChoose(f) : selected(f).act.decision;
  const scope = publishVariantScope(f.store, 'p', reference(decision)).scope;
  return { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
}
type Selected = Awaited<ReturnType<typeof setupRaw>>;
function claim(f: Selected, question: string, axis: string, text: string, variants: 'common' | Ref[] = [f.scopeRecord.value.member]): Json {
  return { id: `h-${rand()}`, kind: 'hypothesis', text, axis,
    planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants },
    basis: { howToVerify: 'Observe the named exact variant' } } as unknown as Json;
}
async function deep(f: Selected, question: string, claims: Json[]) {
  const preparation = produceDeepPreparation(f.store, 'p', inputFor(f, f.scopeRecord, question)).record;
  const subject = { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: question };
  const baseline = v7ProgressBaseline(f.store, subject), state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  const owner = f.store.get<ResearchRun>(state.value.summary.cursor.run)!;
  f.reply({ action: 'answer', question, value: { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } }, citations: [] });
  const result = (await runDeepResearch(f.store, { projectId: 'p', deepPreparation: reference(preparation),
    environment: f.environment, owner: reference(owner) }))!;
  assert.ok(result.attempt); return { result, claims, question, preparation };
}
type Entry = Awaited<ReturnType<typeof deep>>;
const addresses = (entry: Entry): ClaimAddress[] => entry.claims.map((row: any, index) => ({ project: 'p', container: reference(entry.result.attempt),
  containerKind: 'research-attempt', pointer: `/claims/${index}`, claimId: row.id }));
async function assess(f: Selected, entry: Entry, outcome: 'closed' | 'open' | 'unknown' | 'rejected' | 'material' = 'closed', apply = true) {
  const packet = projectAttemptPacket(f.store, { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: entry.question,
    entries: [{ attempt: reference(entry.result.attempt), binding: reference(entry.result.binding) }] });
  const rows = addresses(entry), accepted = outcome !== 'rejected';
  const transition = outcome === 'closed' ? { outcome, bases: rows.map(claim => ({ claim })), reason: 'Exact cell answered',
    sufficiency: { criterion: `Named basis answering ${entry.question}`, requiredDepth: 'deep', reason: 'Enough exact grounds', methodologyRequirements: [] } }
    : ['open', 'unknown'].includes(outcome) ? { outcome, bases: rows.map(claim => ({ claim })), reason: 'Reopened on new evidence',
      ...(outcome === 'unknown' ? { consequence: 'Await exact evidence', nextAction: 'Obtain the source' } : {}) } : null;
  f.reply({ verdict: 'supported', reasons: ['Real paid classification'], return: null,
    novelty: { attempts: [{ attempt: reference(entry.result.attempt), reason: 'Exact managed deep' }],
      accepted: accepted ? rows.map(claim => ({ claim, reason: 'Own variant material' })) : [],
      rejected: accepted ? [] : rows.map(claim => ({ claim, reason: 'Rejected material retained' })),
      newContent: accepted ? rows.map(claim => ({ claim, reason: 'New exact content' })) : [], duplicates: [],
      noProgress: accepted ? [] : [{ attempt: reference(entry.result.attempt), reason: 'No new accepted material' }], transition },
    methodology: { contract: 'assessment-methodology/v1', policy: outcome === 'closed' ? 'assessment-methodology-policy/v2' : 'assessment-methodology-policy/v1', facts: [] } });
  const mr = outcome === 'closed' ? await assessAttemptsWithRequirements(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root)
    : await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
  if (apply) applyDiscoveryAssessment(f.store, 'p', reference(mr));
  return mr;
}
async function complete(f: Selected) {
  const industry = await deep(f, 'q-industry', V7_AXES.map(axis => claim(f, 'q-industry', axis, `Exact ${axis} evidence`)));
  await assess(f, industry);
  const market = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Market cell evidence')]);
  await assess(f, market);
  return { industry, market };
}
function revise(f: Selected, store = f.store) {
  const state = store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const scope: VariantChoiceScope = { ...f.scope!, mode: reference(store.get('project-mode:p')!), operation: store.get(state.value.decision!.id)!.kind === 'discovery-variant-model-decision' ? 'override' : 'revise',
    previous: state.value.decision!, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'Owner changes chosen member' } };
  return answerVariantChoice(store, scope, mint(store, scope).authority);
}


import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import type { Revision, TransactionGuard, Write } from '../src/storage/store.js';
function replyFor(packet: DossierAssessmentPacket, verdict: 'supported' | 'return' = 'supported'): DossierAssessmentResult {
  const bases = [{ record: packet.manifest.ref }];
  return { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: structuredClone(packet.subject), verdict,
    reasons: ['The saved dossier is assessed at its own boundary'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(dimension => [dimension,
      { judgement: 'adequate', reason: `Reviewed ${dimension} against the saved goal and scale`, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(item => item.address), unknowns: packet.unknowns.map(item => item.unknown.claim),
      contradictions: packet.contradictions.map(item => ({ id: item.contradiction.id,
        sides: item.sides.map(side => side.address) as [ClaimAddress, ClaimAddress], grounds: item.grounds.map(record => record.ref) })) },
    return: verdict === 'return' ? { targets: [{ axis: 'market' }], reason: 'Collect an addressed market basis', bases } : null };
}


import { runDossierAssessmentSession,
  type DossierAssessmentSession, type DossierAssessmentApplication } from '../src/discovery/assessment-session.js';
import { readResearchExecution } from '../src/discovery/response-recovery.js';
import type { ModelCall } from '../src/runtime/model-usage.js';

function liveAdapter(f:Paid,packet:DossierAssessmentPacket,verdict:'supported'|'return'='supported',sequence=true) {
  const terminal=replyFor(packet,verdict);
  if(packet.manifest.value.completeness==='partial' && verdict==='return')terminal.return!.targets=[{partialReason:0}];
  writeFileSync(f.settings,JSON.stringify({tokens:10,terminal,sequence}));
  writeFileSync(f.root+'/adapter.mjs',`import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),file=${JSON.stringify(f.settings)},s=JSON.parse(readFileSync(file,'utf8'));
appendFileSync(${JSON.stringify(f.root+'/wire.ndjson')},raw+'\\n');
const step=r.subject.managedDossier?.step;
const pageLimit=s.pageLimit??128000;
let research=step===undefined?s.reply:undefined;
if(step!==undefined){s.requested??=[];s.coverage??={};
const keyOf=(record,pointer)=>JSON.stringify([record.id,record.revision,record.hash,pointer]);
const record=(key,offset,end)=>{(s.coverage[key]??=[]).push([offset,end]);};
for(const fragment of [...(r.subject.materialDelivery??[]),...(r.subject.contextDelivery??[])])
  record(keyOf(fragment.original.record,fragment.original.pointer),fragment.served.offset,fragment.served.end);
for(const lookup of r.subject.contextWorkspace??[]){
  const address=(r.subject.working.materialAddresses??[]).find(a=>keyOf(a.record,a.pointer)===keyOf(lookup.record,lookup.pointer));
  if(lookup.page)record(keyOf(lookup.record,lookup.pointer),lookup.page.offset,lookup.page.end);
  else if(address)record(keyOf(lookup.record,lookup.pointer),0,address.total);
}
for(const address of r.subject.working.materialAddresses??[]){
  const key=keyOf(address.record,address.pointer),ranges=(s.coverage[key]??[]).sort((a,b)=>a[0]-b[0]);
  let offset=0;for(const [start,end] of ranges){if(start>offset)break;offset=Math.max(offset,end);}
  if(offset<address.total){s.requested.push(JSON.stringify([address.record,address.pointer,offset]));
    research={action:'read_context',record:address.record,pointer:address.pointer,page:{offset,limit:pageLimit,
      ...(address.encoding==='canonical-json'?{encoding:'canonical-json'}:{})}};break;}
}
if(!research&&s.sequence&&!s.lookedUp&&!s.requested.length){s.lookedUp=true;research={action:'read_context',record:r.subject.working.archive,pointer:'/body/dossierPacket',page:{offset:0,limit:pageLimit,encoding:'canonical-json'}};}
if(!research&&(s.sequence||s.requested.length)&&!s.checkpointed){s.checkpointed=true;research={action:'assessment_checkpoint',dossierSubject:s.terminal.subject,notes:['Read the exact saved pages; both sides remain visible.']};}
research??=s.terminal;writeFileSync(file,JSON.stringify(s));}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:s.tokens??10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  return terminal;
}
function view(store:Store,write:(writes:any[],guards:any[],invoke:()=>any)=>any) {
  return storeView(store,{write:(writes,guards)=>write(writes,guards,()=>store.writeMany(writes,guards))});
}
// The assessDossier path reads Store indices outside the narrow storeView surface, so the write-only view cannot
// carry it. The cut intercepts only this connection's writeMany at the prototype — every read and every other
// Store's commit keep the original method, and the tested call sees the real target.
function interceptWrites(t:test.TestContext,target:Store,
  action:(writes:any[],guards:any[],invoke:()=>Revision<unknown>[])=>Revision<unknown>[]) {
  const original=Store.prototype.writeMany;
  const method=t.mock.method(Store.prototype,'writeMany',function(this:Store,writes:Write[],guards:TransactionGuard[]=[]):Revision<unknown>[] {
    let committed=false;
    const commit=()=>{if(committed)throw new Error('write intercept allows one original commit');committed=true;return original.call(this,writes,guards);};
    return (this===target?action(writes,guards,commit):commit()) as Revision<unknown>[];
  });
  let restored=false;
  const restore=()=>{if(!restored){restored=true;method.mock.restore();}};
  t.after(restore);
  return restore;
}
function mask(store:Store,ref:Ref,value:unknown=null) {
  const get=store.get.bind(store),bound=new Map<PropertyKey,unknown>();
  const masked=<T>(id:string,revision?:number)=>id===ref.id&&(revision===undefined||revision===ref.revision)?value as Revision<T>:get<T>(id,revision);
  return new Proxy(store,{get(target,key){
    if(key==='get')return masked;
    if(!bound.has(key)){const value=Reflect.get(target,key);bound.set(key,typeof value==='function'?value.bind(target):value);}return bound.get(key);
  }});
}
const dossierCalls=(store:Store)=>store.list<ModelCall>('model-call').filter(row=>row.value.purpose==='dossier-assessor');
function wideDelivery(f:Paid) {
  return configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:f.environment.value.reviewer.model,effort:f.environment.value.reviewer.effort,
      command:f.environment.value.reviewer.command,speed:'inherited'},agentCommand:f.environment.value.reviewer.command,
    maxRequestChars:3000000,maxReadChars:128000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:100000,
    physicalLimits:{maxRequestChars:3000000,maxReplyChars:100000,basis:'Full local dossier delivery'}},0);
}
async function partialRaw(t:test.TestContext, material?:string) {
  const f=await paid(t,(snapshot:Ref)=>({action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds:[snapshot]}],
    searchLimits:['Saved sweep'],unknowns:['Demand unknown']}),material??true);
  const none=f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const handoff=await publishVariantHandoff(f.store,'p',{draft:reference(f.store.get(f.draft.id)!),result:reference(none),decision:null,scope:null,earlyLimit:false});
  const root=reference((await producePartialDossier(f.store,'p',reference(handoff.record))).record);
  return {...f,packet:await prepareDossierAssessmentSubject(f.store,'p',root)};
}

async function completed(t:test.TestContext,model=false) {
  return isolated(t,model?'model-complete':'owner-complete',async lifetime=>{
    const f=await setupRaw(lifetime,model),entries=await complete(f);return {...f,entries};
  });
}
async function partial(t:test.TestContext,material?:string) {
  return isolated(t,material?'partial:'+hashJson(material):'partial',lifetime=>partialRaw(lifetime,material));
}

import { assessDossier, publishDossierAssessment, readDossierAssessmentAt } from '../src/discovery/research-assessment.js';
import { DOSSIER_ASSESSMENT_KIND, DOSSIER_ASSESSMENT_CONTRACT, type PaidDossierAssessment } from '../src/discovery/dossier-manifest.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { configureReaderPilot, type ReaderPilot } from '../src/discovery/reader-pilot.js';

async function refusePublishedCorruptions(f:Paid,store:Store,published:Revision<PaidDossierAssessment>) {
    for(const missing of [published.value.session,published.value.application,published.value.request,published.value.response,published.value.subject.root.ref])
      await unchanged(f,store,()=>readDossierAssessmentAt(mask(store,missing),'p',reference(published)),true);
    const corrupt=[null,{...published.value,contract:'unknown'},{...published.value,projectId:'foreign'},
      {...published.value,subject:{...published.value.subject,manifest:{...published.value.manifest,hash:'0'.repeat(64)}}},
      {...published.value,result:{...published.value.result,completeness:published.value.result.completeness==='complete'?'partial':'complete'}},
      {...published.value,result:{...published.value.result,result:{...published.value.result.result,verdict:'supported',return:null}}},
      {...published.value,result:{...published.value.result,packet:{...published.value.result.packet,materials:published.value.result.packet.materials.slice(0,-1)}}}];
    for(const value of corrupt){
      const fake={...published,value,hash:hashJson(value as never)};
      await unchanged(f,store,()=>readDossierAssessmentAt(mask(store,reference(published),fake),'p',reference(fake)),true);
    }
}

for(const model of [false,true])test('D6 publication: real '+(model?'model':'owner')+' selected terminal survives a cut and current-head movement',async t=>{
  const f=await completed(t,model);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  liveAdapter(f,packet,'supported',false);const pilot=wideDelivery(f);
  let cut=false;
  const restore=interceptWrites(t,f.store,(writes,_guards,invoke)=>{
    const hit=!cut&&writes.some(write=>write.kind==='assessment-session'&&write.value.contract==='dossier-session/v1'&&write.value.result);
    const rows=invoke();if(hit){cut=true;throw new Error('terminal-cut');}return rows;
  });
  try{await assert.rejects(()=>assessDossier(f.store,'p',packet.subject,f.environment,pilot),/terminal-cut/);}
  finally{restore();}
  assert.ok(cut);
  assert.equal(f.store.list(DOSSIER_ASSESSMENT_KIND).length,0);
  const terminal=f.store.list<DossierAssessmentSession>('assessment-session').find(s=>s.value.contract==='dossier-session/v1'&&s.value.subject.identity===packet.subject.identity)!;
  assert.ok(terminal.value.result);
  const payments=money(f.store),wires=f.wires();
  revise(f);modeOf(f.store,'bypass');nextPlan(f,f.store);
  const env=f.engine.environments.configure('p',{...f.environment.value,reviewer:{...f.environment.value.reviewer,actor:'later-D6-reviewer'}},f.environment.revision);
  const currentPilot=f.store.get<ReaderPilot>(pilot.id)!;
  f.store.write({id:pilot.id,kind:pilot.kind,expected:currentPilot.revision,value:{...currentPilot.value,maxCalls:1}});
  const published=await assessDossier(f.open(),'p',packet.subject,env,f.store.get<ReaderPilot>(pilot.id)!,undefined,{allowance:0,restoreOnly:true});
  assert.equal(published.value.contract,DOSSIER_ASSESSMENT_CONTRACT);assert.equal(published.value.result.result.verdict,'supported');
  assert.equal(published.value.result.completeness,'complete');assert.deepEqual(published.value.manifest,packet.subject.manifest);
  assert.deepEqual(published.value.result.packet,packet);assert.deepEqual(published.value.session,reference(terminal));
  assert.deepEqual(money(f.store),payments);assert.deepEqual(f.wires(),wires);
  assert.equal(f.store.history(published.id).length,1);
  const application=f.store.get<DossierAssessmentApplication>(published.value.application.id,published.value.application.revision)!;
  const before=f.store.get<DossierAssessmentSession>(application.value.session.id,application.value.session.revision)!;
  const execution=readResearchExecution(f.store,'p',published.value.call,before,
    f.store.get<DiscoveryDraft>(before.value.binding.draft.id,before.value.binding.draft.revision)!,
    f.store.get<Question>(before.value.binding.question.id,before.value.binding.question.revision)!,before.value.role,before.value.profile);
  assert.equal(execution.kind,'response');assert.deepEqual(execution.response,published.value.response);
  // Each selected route keeps its paid historical read and free recovery after
  // moving all current heads. Common negative tables run on the partial route.
  const historical=model?f.open():f.store,replay=model?f.store:f.open();
  await fixedPoint(historical,async()=>assert.deepEqual(await unchanged(f,historical,
    ()=>readDossierAssessmentAt(historical,'p',reference(published))),published));
  await fixedPoint(replay,async()=>assert.deepEqual(await unchanged(f,replay,
    ()=>assessDossier(replay,'p',packet.subject,env,undefined,undefined,{allowance:0,restoreOnly:true})),published));
  const fields=referenceSites(published.kind,published.value).map(site=>site.field).sort();
  assert.deepEqual(fields,['application','call','manifest','request','response','session','subject.manifest','subject.root.ref']);
  assert.deepEqual(referenceSites(published.kind,{...published.value,result:{data:{id:'user-data',revision:1,hash:'a'.repeat(64)}}}).map(site=>site.field).sort(),fields);
});

test('D6 publication: nonempty partial, committed-publication cut and competing Stores have a free fixed point',async t=>{
  const f=await partial(t);liveAdapter(f,f.packet,'return',false);
  let cut=false;
  const restore=interceptWrites(t,f.store,(writes,_guards,invoke)=>{
    const hit=!cut&&writes.some(write=>write.kind===DOSSIER_ASSESSMENT_KIND);
    const rows=invoke();if(hit){cut=true;throw new Error('publication-cut');}return rows;
  });
  try{await assert.rejects(()=>assessDossier(f.store,'p',f.packet.subject,f.environment),/publication-cut/);}
  finally{restore();}
  assert.ok(cut);
  const published=f.store.list<PaidDossierAssessment>(DOSSIER_ASSESSMENT_KIND)[0]!;
  assert.equal(published.value.result.completeness,'partial');assert.equal(published.value.result.result.verdict,'return');
  assert.ok(published.value.result.packet.materials.length);assert.deepEqual(published.value.result.packet.manifest.value.reasons,f.packet.manifest.value.reasons);
  const env=f.engine.environments.configure('p',{...f.environment.value,timeoutMs:f.environment.value.timeoutMs+1},f.environment.revision);
  for(const store of [f.store,f.open()])await fixedPoint(store,async()=>{
    await refusePublishedCorruptions(f,store,published);
    await unchanged(f,store,()=>readDossierAssessmentAt(store,'foreign',reference(published)),true);
    assert.deepEqual(await unchanged(f,store,()=>assessDossier(store,'p',f.packet.subject,env,undefined,undefined,{restoreOnly:true,allowance:0})),published);
    assert.deepEqual(await unchanged(f,store,()=>publishDossierAssessment(store,'p',published.value.session)),published);
    for(const at of [null,undefined,{},reference(published)])
      await unchanged(f,store,()=>publishDossierAssessment(store,'p',at),true);
    for(const at of [null,undefined,{},published.value.session])
      await unchanged(f,store,()=>readDossierAssessmentAt(store,'p',at),true);
  });
  const g=await partial(t);liveAdapter(g,g.packet,'return',false);
  const terminal=await runDossierAssessmentSession(g.store,'p',g.packet.subject,g.environment);
  const payments=money(g.store),wires=g.wires(),rival=g.open();let won=false;
  const race=view(g.store,(writes,guards,invoke)=>{
    if(!won&&writes.some(write=>write.kind===DOSSIER_ASSESSMENT_KIND)){won=true;rival.writeMany(writes,guards);}
    return invoke();
  });
  const first=await publishDossierAssessment(race,'p',reference(terminal.session));assert.ok(won);
  const second=await fixedPoint(rival,()=>unchanged(g,rival,()=>publishDossierAssessment(rival,'p',reference(terminal.session))));assert.deepEqual(second,first);
  assert.equal(g.store.list(DOSSIER_ASSESSMENT_KIND).length,1);assert.equal(g.store.history(first.id).length,1);
  assert.deepEqual(money(g.store),payments);assert.deepEqual(g.wires(),wires);assert.equal(dossierCalls(g.store).length,1);
});

test('D6 publication: rich blocking return retains both sides; structural supported or a lost side cannot publish',async t=>{
  const f=await completed(t),target=addresses(f.entries.industry)[0]!;
  const rejected=await deep(f,'q-market',[{...(claim(f,'q-market','market','Rejected D6 counterargument') as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json]);await assess(f,rejected,'rejected');
  const unknown=await deep(f,'q-market',[{...(claim(f,'q-market','market','Unassessed D6 unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved D6 gap',unknownId:'publication-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json]);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  liveAdapter(f,packet,'return',false);const pilot=wideDelivery(f);
  const published=await assessDossier(f.store,'p',packet.subject,f.environment,pilot);
  assert.deepEqual(published.value.result.packet,packet);assert.ok(packet.unknowns.length);assert.ok(packet.contradictions.length);
  assert.ok(packet.materials.some(row=>row.status==='rejected'));assert.ok(packet.materials.some(row=>row.status==='unassessed'));
  assert.ok(published.value.result.blockingContradictions.length);
  for(const store of [f.store,f.open()])await fixedPoint(store,async()=>{
    // Generic result truncation and a caller-supported value are checked in the
    // partial table. Here the rich-specific loss of a side remains hot and cold;
    // the material-ground table has one cold representative, the unassessed one.
    const rejected=packet.materials.find(row=>row.status==='rejected')!.address.container;
    const unknownRef=reference(unknown.result.attempt!);
    for(const ref of store===f.store?[rejected,unknownRef]:[unknownRef])
      await unchanged(f,store,()=>readDossierAssessmentAt(mask(store,ref),'p',reference(published)),true);
    const fake=structuredClone(published);fake.value.result.packet.contradictions[0]!.sides.pop();fake.hash=hashJson(fake.value as never);
    await unchanged(f,store,()=>readDossierAssessmentAt(mask(store,reference(published),fake),'p',reference(fake)),true);
  });
  await assess(f,unknown,'material');
  const second=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  liveAdapter(f,second,'supported',false);
  await assert.rejects(()=>assessDossier(f.store,'p',second.subject,f.environment,pilot),e=>e instanceof EngineError);
  assert.equal(f.store.list(DOSSIER_ASSESSMENT_KIND).length,1);
  // The Store that received the paid terminal refusal must itself recover for
  // free; a new Store additionally proves the same fixed point without its cache.
  for(const store of [f.store,f.open()])await fixedPoint(store,async()=>{
    await unchanged(f,store,()=>assessDossier(store,'p',second.subject),true);
    assert.deepEqual(await unchanged(f,store,()=>readDossierAssessmentAt(store,'p',reference(published))),published);
  });
});

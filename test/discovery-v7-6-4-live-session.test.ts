import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { storeUnchanged, storeRefused } from './store-unchanged.js';
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


import { DOSSIER_RESULT_TRANSPORT } from '../src/discovery/continuation-packet.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { checkDossierAssessmentResult } from '../src/discovery/dossier-assessment.js';
import type { Revision } from '../src/storage/store.js';
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


import { runDossierAssessmentSession, readDossierAssessmentSessionAt,
  type DossierAssessmentSession, type DossierAssessmentApplication } from '../src/discovery/assessment-session.js';
import { readResearchExecution, readResearchResponse } from '../src/discovery/response-recovery.js';
import { estimateCliCall } from '../src/adapters/codex-estimate.js';
import type { Environment } from '../src/runtime/environment.js';
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
  const bound=new Map<PropertyKey,unknown>();
  return new Proxy(store,{get(target,key){
    if(key==='writeMany')return (writes:any[],guards:any[]=[])=>write(writes,guards,()=>target.writeMany(writes,guards));
    if(!bound.has(key)){const value=Reflect.get(target,key);bound.set(key,typeof value==='function'?value.bind(target):value);}
    return bound.get(key);
  }});
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
async function refusePaidGrounds(f:Paid,store:Store,result:Awaited<ReturnType<typeof runDossierAssessmentSession>>) {
  const session=result.session,app=store.get<DossierAssessmentApplication>(result.application!.id,1)!;
  const call=dossierCalls(store).find(row=>row.value.assessmentApplication?.id===app.id)!;
  const refs=[reference(session),reference(app),call.value.request.record!,call.value.response!.record!,call.value.packet!.archive];
  await fixedPoint(store,async()=>{
    for(const ref of refs)await unchanged(f,store,()=>readDossierAssessmentSessionAt(mask(store,ref),'p',reference(session)),true);
    const value={...session.value,result:{verdict:'supported'}},fake={...session,value,hash:hashJson(value as never)};
    await unchanged(f,store,()=>readDossierAssessmentSessionAt(mask(store,reference(session),fake),'p',reference(fake)),true);
  });
}
for(const model of [false,true])test(`live dossier: real ${model?'model':'owner'} selected, read_context/checkpoint/terminal; exact paid history and free hot/cold repeat`,async t=>{
  const f=await completed(t,model);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  const terminal=liveAdapter(f,packet);const before=money(f.store),wires=f.wires().length;
  const profile=wideDelivery(f);
  const result=await runDossierAssessmentSession(f.store,'p',packet.subject,f.environment,profile);
  assert.ok(result.result);assert.deepEqual(result.result,await checkDossierAssessmentResult(f.store,'p',packet.subject,terminal));
  const steps=result.session.value.step;assert.ok(steps>=3);assert.equal(dossierCalls(f.store).length,steps);
  assert.equal(f.wires().length,wires+steps);assert.equal(money(f.store).calls.length,before.calls.length+steps*3);
  const calls=dossierCalls(f.store).sort((a,b)=>a.value.startedAt-b.value.startedAt),first=calls[0]!;
  assert.match(first.value.budget!.estimate.explanation!,/bootstrap/);
  const expected=estimateCliCall(f.store,'p',first.value.requested,'assessor',first.value.request.chars,'initial');
  assert.deepEqual(first.value.budget!.estimate,{...expected,explanation:'Managed dossier bootstrap from measured assessor calls. '+expected.explanation});
  assert.equal(calls[1]!.value.packet!.kind,'continuation');
  assert.doesNotMatch(calls[1]!.value.budget!.estimate.explanation!,/bootstrap/);
  assert.deepEqual(calls[1]!.value.budget!.estimate.basis,[reference(first)]);
  assert.equal(calls[2]!.value.budget!.estimate.basis.length,2);
  const sent=f.wires().slice(wires);assert.equal(sent[0].subject.managedDossier.step,0);
  assert.equal(sent[0].subject.resultCapacity.envelopeLimitChars,profile.value.maxRequestChars);
  assert.equal(sent[1].subject.contextWorkspace[0].record.id,(sent[0].subject.working.materialAddresses?.[0]?.record??sent[0].subject.working.archive).id);
  assert.ok(sent.at(-1).subject.dossierNotes.length);assert.deepEqual(sent.at(-1).subject.dossierSubject,packet.subject);
  const session=result.session,app=f.store.get<DossierAssessmentApplication>(result.application!.id,1)!;
  const origin=f.store.get<DossierAssessmentSession>(session.id,app.value.session.revision)!;
  const call=dossierCalls(f.store).find(call=>call.value.assessmentApplication?.id===app.id)!;
  const paidRead=readResearchExecution(f.store,'p',reference(call),origin,
    f.store.get<DiscoveryDraft>(origin.value.binding.draft.id,origin.value.binding.draft.revision)!,
    f.store.get<Question>(origin.value.binding.question.id,origin.value.binding.question.revision)!,origin.value.role,origin.value.profile);
  assert.equal(paidRead.kind,'response');
  await unchanged(f,f.store,async()=>readResearchResponse(f.store,'p',reference(call),origin,
    f.store.get<DiscoveryDraft>(origin.value.binding.draft.id,origin.value.binding.draft.revision)!,
    f.store.get<Question>(origin.value.binding.question.id,origin.value.binding.question.revision)!,origin.value.role,origin.value.profile),true);
  // A real later deep/MR/P step and later owner choice/plan/mode do not replace the saved runtime or inventory.
  const late=await deep(f,'q-market',[claim(f,'q-market','market','Late dossier evidence')]);await assess(f,late,'material');
  revise(f);modeOf(f.store,'bypass');nextPlan(f,f.store);
  const env=f.engine.environments.configure('p',{...f.environment.value,reviewer:{...f.environment.value.reviewer,actor:'later-reviewer'}},f.environment.revision);
  // Each route proves historical reading and free replay; together they cover
  // both real Store modes. Common corruptions run once on the partial route.
  const historical=model?f.open():f.store,replay=model?f.store:f.open();
  await fixedPoint(historical,async()=>assert.deepEqual(await unchanged(f,historical,
    ()=>readDossierAssessmentSessionAt(historical,'p',reference(session))),result));
  await fixedPoint(replay,async()=>assert.deepEqual(await unchanged(f,replay,
    ()=>runDossierAssessmentSession(replay,'p',packet.subject,env)),result));

});

test('live dossier: nonempty partial; prepared, paid-response and application cuts recover the original position',async t=>{
  for(const cut of ['prepared','response','application'] as const) {
    const f=await partial(t),packet=f.packet;liveAdapter(f,packet,'return',false);
    let cutOnce=false;
    const wrapped=view(f.store,(writes,_guards,invoke)=>{
      const hit=!cutOnce && writes.some(write=>cut==='prepared'?write.value.contract==='dossier-application/v1'&&write.value.state==='prepared':
        cut==='response'?write.kind==='model-response':write.value.contract==='dossier-application/v1'&&write.value.state==='applied');
      const result=invoke();if(hit){cutOnce=true;throw new Error('cut:'+cut);}return result;
    });
    await assert.rejects(()=>runDossierAssessmentSession(wrapped,'p',packet.subject,f.environment),new RegExp('cut:'+cut));assert.ok(cutOnce);
    if(cut==='prepared') {
      const initial=f.store.list<DossierAssessmentSession>('assessment-session').find(s=>s.value.contract==='dossier-session/v1')!;
      const prepared=f.store.get<DossierAssessmentApplication>(initial.value.application,1)!;
      for(const store of [f.store,f.open()]) await fixedPoint(store,async()=>{
        for(const missing of [reference(initial),reference(prepared)])
          await unchanged(f,store,()=>runDossierAssessmentSession(mask(store,missing),'p',packet.subject,f.environment,undefined,undefined,{restoreOnly:true}),true);
        const restored=await unchanged(f,store,()=>runDossierAssessmentSession(store,'p',packet.subject,f.environment,undefined,undefined,{restoreOnly:true}));
        assert.equal(restored!.session.id,initial.id);assert.equal(restored!.result,null);
      });
      const resumed=await runDossierAssessmentSession(f.open(),'p',packet.subject,f.environment);
      assert.equal(resumed.session.id,initial.id);assert.equal(dossierCalls(f.store).length,1);
    }
    const env=f.engine.environments.configure('p',{...f.environment.value,timeoutMs:f.environment.value.timeoutMs+1},f.environment.revision);
    const restored=await runDossierAssessmentSession(f.open(),'p',packet.subject,env);
    assert.equal(restored.result!.completeness,'partial');assert.ok(restored.result!.packet.materials.length);
    assert.deepEqual(restored.result!.packet.materials,packet.materials);assert.equal(dossierCalls(f.store).length,1);
    await fixedPoint(f.store,()=>unchanged(f,f.store,()=>runDossierAssessmentSession(f.store,'p',packet.subject,env)));
    if(cut==='application') {
      for(const store of [f.store,f.open()])await refusePaidGrounds(f,store,restored);
      const app=f.store.get<DossierAssessmentApplication>(restored.application!.id,1)!;
      const call=dossierCalls(f.store).find(row=>row.value.assessmentApplication?.id===app.id)!;
      await fixedPoint(f.store,async()=>{
        for(const at of [reference(app),call.value.request.record!,call.value.response!.record!,call.value.packet!.archive]) {
          const row=f.store.get<any>(at.id,at.revision)!;
          for(const value of [{...row,value:null},{...row,value:{...row.value,projectId:'foreign'}}])
            await unchanged(f,f.store,()=>readDossierAssessmentSessionAt(mask(f.store,at,value),'p',reference(restored.session)),true);
        }
      });
    }
  }
});

test('live dossier: raw/mixed/missing subjects refuse before claims; reservation and application races retain one physical operation',async t=>{
  const f=await partial(t),packet=f.packet;liveAdapter(f,packet,'return',false);
  await fixedPoint(f.store,async()=>{
  for(const subject of [undefined,null,{}, {...packet.subject,contract:'unknown'},{...packet.subject,root:{...packet.subject.root,hash:'0'.repeat(64)}}])
    await unchanged(f,f.store,()=>runDossierAssessmentSession(f.store,'p',subject,f.environment),true);
  for(const context of [{dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT},
    {dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,managedDossier:null}])
    await unchanged(f,f.store,()=>researchCall(f.environment.value.reviewer,f.environment.value,'Raw dossier',context,undefined,
      {store:f.store,draftId:f.draft.id,questionId:f.v.plan.id,purpose:'dossier-assessor'}),true);
  });
  const rival=f.open();let moved=false,afterMove:string|undefined;
  const beforePayment=money(f.store),beforeWires=f.wires();
  const race=view(f.store,(writes,_guards,invoke)=>{
    if(!moved&&writes.some(write=>write.kind==='model-call')) {
      moved=true;const env=rival.get<Environment>(f.environment.id)!;
      rival.write({id:env.id,kind:env.kind,expected:env.revision,value:{...env.value,timeoutMs:env.value.timeoutMs+1}});
      afterMove=all(rival);
    }
    return invoke();
  });
  await assert.rejects(()=>runDossierAssessmentSession(race,'p',packet.subject,f.environment),e=>e instanceof EngineError);
  assert.ok(moved);assert.equal(all(f.store),afterMove);assert.deepEqual(money(f.store),beforePayment);assert.deepEqual(f.wires(),beforeWires);
  assert.equal(dossierCalls(f.store).length,0);assert.equal(f.store.list<DossierAssessmentApplication>('assessment-application').filter(a=>a.value.contract==='dossier-application/v1'&&a.value.state!=='prepared').length,0);
});

test('live dossier: exact reservation cut resumes on hot/new Store only for its original live owner, without a second ledger reservation',async t=>{
  const f=await partial(t),packet=f.packet;liveAdapter(f,packet,'return',false);
  let interrupted=false;
  const cutting=view(f.store,(writes,_guards,invoke)=>{
    const cut=!interrupted&&writes.some(write=>write.kind==='model-call');
    const result=invoke();if(cut){interrupted=true;throw new Error('reservation-cut');}return result;
  });
  await assert.rejects(()=>runDossierAssessmentSession(cutting,'p',packet.subject,f.environment),/reservation-cut/);
  const claim=dossierCalls(f.store)[0]!,ledger=money(f.store).ledger,wires=f.wires();
  assert.equal(claim.revision,1);assert.equal(claim.value.status,'running');
  // This one real committed cut supplies both isolated recovery cases. SQLite
  // backs up every committed row while the original Store stays live for hot
  // recovery; that Store is closed before restoring the cut for the new Store.
  // Runtime files stay at their original paths; no paid row or Ref is invented.
  const checkpoint=mkdtempSync(join(tmpdir(),'omg-reserved-cut-')),world=join(checkpoint,'world');
  t.after(()=>rmSync(checkpoint,{recursive:true,force:true}));cpSync(f.root,world,{recursive:true});
  const database=join(world,basename(f.path));
  for(const suffix of ['', '-wal', '-shm'])rmSync(database+suffix,{force:true});
  const backup=new DatabaseSync(f.path);
  try{backup.prepare('VACUUM INTO ?').run(database);}finally{backup.close();}
  for(const cold of [false,true]) {
    if(cold) {
      f.store.close();
      for(const name of readdirSync(f.root))rmSync(join(f.root,name),{recursive:true,force:true});
      cpSync(world,f.root,{recursive:true});
    }
    const store=cold?f.open():f.store;
    const running=store.get<DossierAssessmentApplication>(claim.value.assessmentApplication!.id,2)!;
    const readBefore=all(store);
    // Both Store modes recover this real reservation. The hot table covers both
    // missing-row and null-body forms; cold repeats each missing proof class.
    for(const row of [running,claim])for(const value of cold?[null]:[null,{...row,value:null}])
      await unchanged(f,store,()=>runDossierAssessmentSession(mask(store,reference(row),value),'p',packet.subject),true);
    if(!cold) {
      await unchanged(f,store,()=>runDossierAssessmentSession(store,'p',packet.subject,undefined,undefined,undefined,{restoreOnly:true}));
      await unchanged(f,store,()=>runDossierAssessmentSession(store,'p',packet.subject,undefined,undefined,undefined,{allowance:0}),true);
    }
    const original=store.get<DossierAssessmentSession>(store.list<DossierAssessmentSession>('assessment-session').find(s=>s.value.contract==='dossier-session/v1')!.id)!;
    // An honest foreign owner cannot acquire the original prepared application's identity.
    const foreign={...claim,value:{...claim.value,ownerProcess:{pid:process.pid,started:'foreign'},execution:{...claim.value.execution!,owner:{pid:process.pid,started:'foreign'}}}};
    foreign.hash=hashJson(foreign.value as never);
    await unchanged(f,store,()=>runDossierAssessmentSession(mask(store,reference(claim),foreign),'p',packet.subject),true);
    assert.equal(all(store),readBefore);
    const result=await runDossierAssessmentSession(store,'p',packet.subject);
    assert.ok(result.result);assert.equal(dossierCalls(store).length,1);assert.equal(f.wires().length,wires.length+1);
    const terminal=dossierCalls(store)[0]!;assert.equal(terminal.id,claim.id);assert.deepEqual(terminal.value.request,claim.value.request);
    assert.deepEqual(terminal.value.packet,claim.value.packet);assert.deepEqual(money(store).ledger,ledger);
    assert.equal(result.session.id,original.id);
    await fixedPoint(store,()=>unchanged(f,store,()=>runDossierAssessmentSession(store,'p',packet.subject)));
  }
});

test('live dossier: a competing application commit wins once and the loser restores without another wire',async t=>{
  const f=await partial(t),packet=f.packet;liveAdapter(f,packet,'return',false);
  const rival=f.open();let won=false;
  const racing=view(f.store,(writes,guards,invoke)=>{
    if(!won&&writes.some(write=>write.value.contract==='dossier-application/v1'&&write.value.state==='applied')) {
      won=true;rival.writeMany(writes,guards);
    }
    return invoke();
  });
  await assert.rejects(()=>runDossierAssessmentSession(racing,'p',packet.subject,f.environment),e=>e instanceof EngineError);
  assert.ok(won);assert.equal(dossierCalls(f.store).length,1);
  const result=await fixedPoint(f.store,()=>unchanged(f,f.store,()=>runDossierAssessmentSession(f.store,'p',packet.subject)));assert.ok(result!.result);
});

test('live dossier: rejected/unassessed/unknown and both blocking sides survive paid return; another snapshot cannot inherit it',async t=>{
  const f=await completed(t),target=addresses(f.entries.industry)[0]!;
  const rejected=await deep(f,'q-market',[{...(claim(f,'q-market','market','Rejected explicit counterargument') as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json]);await assess(f,rejected,'rejected');
  const unknown=await deep(f,'q-market',[{...(claim(f,'q-market','market','Unassessed addressed unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved gap',unknownId:'live-session-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json]);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  assert.ok(packet.materials.some(m=>m.status==='rejected'));assert.ok(packet.materials.some(m=>m.status==='unassessed'));
  assert.ok(packet.unknowns.length);assert.ok(packet.contradictions.length);
  liveAdapter(f,packet,'return',false);const profile=wideDelivery(f);
  const result=await runDossierAssessmentSession(f.store,'p',packet.subject,f.environment,profile);
  assert.deepEqual(result.result!.packet,packet);const firstPurchases=dossierCalls(f.store).length;
  const app=f.store.get<DossierAssessmentApplication>(result.application!.id,1)!,call=dossierCalls(f.store).find(call=>call.value.assessmentApplication?.id===app.id)!;
  const archive=f.store.get<any>(call.value.packet!.archive.id,1)!;
  for(const store of [f.store,f.open()]) await fixedPoint(store,async()=>{
    // All distinct archive corruptions remain hot; cold repeats cover inventory
    // loss and managed binding, rather than duplicating the entire table.
    const changes=[(body:any)=>{body.dossierPacket.contradictions[0].sides.pop()},(body:any)=>{body.dossierPacket.materials.pop()},
      (body:any)=>{body.resultCapacity.bindings.managedDossier=null},(body:any)=>{delete body.managedDossier}];
    for(const change of store===f.store?changes:[changes[0]!,changes[2]!]) {
      const fake=structuredClone(archive);change(fake.value.body);fake.hash=hashJson(fake.value);
      await unchanged(f,store,()=>readDossierAssessmentSessionAt(mask(store,reference(archive),fake),'p',reference(result.session)),true);
    }
  });
  // Real later classification changes the immutable inventory and therefore the exact session identity.
  await assess(f,unknown,'material');
  const second=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  assert.notDeepEqual(second.subject,packet.subject);liveAdapter(f,second,'supported',false);
  await assert.rejects(()=>runDossierAssessmentSession(f.store,'p',second.subject,f.environment,profile),e=>e instanceof EngineError);
  const rejectedPurchases=dossierCalls(f.store).length;assert.ok(rejectedPurchases>firstPurchases);
  const rejectedSession=f.store.list<DossierAssessmentSession>('assessment-session').find(s=>s.value.contract==='dossier-session/v1'&&s.value.subject.identity===second.subject.identity)!;
  assert.equal(rejectedPurchases-firstPurchases,rejectedSession.value.step+1);
  for(const store of [f.store,f.open()]) await fixedPoint(store,async()=>{
    await unchanged(f,store,()=>runDossierAssessmentSession(store,'p',second.subject),true);
    const first=await unchanged(f,store,()=>runDossierAssessmentSession(store,'p',packet.subject));assert.deepEqual(first,result);
  });
});

test('live dossier: two original-owner authorization contenders send once; authorized provider is never relaunched',async t=>{
  const f=await partial(t),packet=f.packet;liveAdapter(f,packet,'return',false);
  let stopped=false;
  const cutting=view(f.store,(writes,_guards,invoke)=>{const hit=!stopped&&writes.some(w=>w.kind==='model-call');const rows=invoke();if(hit){stopped=true;throw new Error('reserved');}return rows;});
  await assert.rejects(()=>runDossierAssessmentSession(cutting,'p',packet.subject,f.environment),/reserved/);
  const count=f.wires().length;
  const outcomes=await Promise.allSettled([runDossierAssessmentSession(f.store,'p',packet.subject),runDossierAssessmentSession(f.open(),'p',packet.subject)]);
  assert.ok(outcomes.some(o=>o.status==='fulfilled'));assert.equal(dossierCalls(f.store).length,1);assert.equal(f.wires().length,count+1);
  const final=await fixedPoint(f.store,()=>unchanged(f,f.store,()=>runDossierAssessmentSession(f.store,'p',packet.subject)));assert.ok(final!.result);
  const g=await partial(t);liveAdapter(g,g.packet,'return',false);let authorized=false;
  const authorizedCut=view(g.store,(writes,_guards,invoke)=>{const hit=!authorized&&writes.some(w=>w.kind==='model-call'&&w.value.execution?.phase==='authorized');const rows=invoke();if(hit){authorized=true;throw new Error('authorized-cut');}return rows;});
  await assert.rejects(()=>runDossierAssessmentSession(authorizedCut,'p',g.packet.subject,g.environment),e=>e instanceof EngineError&&e.code==='process_record_failed');assert.ok(authorized);
  assert.equal(dossierCalls(g.store)[0]!.value.execution!.phase,'authorized');
  await fixedPoint(g.store,()=>unchanged(g,g.store,()=>runDossierAssessmentSession(g.store,'p',g.packet.subject),true));
});

test('live dossier: missing compatible samples and unaffordable real forecast refuse before claim/ledger/wire',async t=>{
  for(const missing of [true,false]) {
    const f=await partial(t),packet=f.packet;
    const environment=missing?f.engine.environments.configure('p',{...f.environment.value,
      reviewer:{...f.environment.value.reviewer,actor:'uncalibrated-dossier-reviewer'}},f.environment.revision):f.environment;
    liveAdapter(f,packet,'return',false);let cut=false;
    const prepared=view(f.store,(writes,_guards,invoke)=>{const hit=!cut&&writes.some(w=>w.value.contract==='dossier-application/v1'&&w.value.state==='prepared');const rows=invoke();if(hit){cut=true;throw new Error('prepared-budget');}return rows;});
    await assert.rejects(()=>runDossierAssessmentSession(prepared,'p',packet.subject,environment),/prepared-budget/);assert.ok(cut);
    if(!missing) {
      // A real adapter receipt with expensive measured usage, not a fabricated model-call or budget row.
      writeFileSync(f.settings,JSON.stringify({tokens:19000000,reply:{action:'assessment_checkpoint',notes:['Expensive real calibration']}}));
      await researchCall(f.environment.value.reviewer,f.environment.value,'Measure assessor cost',{},undefined,
        {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'assessor'});
      liveAdapter(f,packet,'return',false);
    }
    for(const store of [f.store,f.open()]) {
      const before=all(store),calls=money(store),wires=f.wires();
      await assert.rejects(()=>runDossierAssessmentSession(store,'p',packet.subject),e=>e instanceof EngineError
        && e.code===(missing?'budget_estimate_missing':'discovery_budget_reserve'));
      assert.equal(all(store),before);assert.deepEqual(money(store),calls);assert.deepEqual(f.wires(),wires);
      assert.equal(dossierCalls(store).length,0);
    }
  }
});

import { configureReaderPilot, type ReaderPilot } from '../src/discovery/reader-pilot.js';
test('live dossier: foreign exact profile refuses before publication and leaves the same subject usable',async t=>{
  const f=await partial(t),packet=f.packet;liveAdapter(f,packet,'return',false);
  const own=wideDelivery(f),{projectId,...settings}=own.value;assert.equal(projectId,'p');
  await f.engine.execute({type:'create-project',project:'other',title:'Other dossier profile'});
  f.engine.environments.configure('other',f.environment.value,0);
  const foreign=configureReaderPilot(f.store,f.engine.environments,'other',settings,0);
  for(const store of [f.store,f.open()]) await fixedPoint(store,async()=>{
    for(const profile of [foreign,{...foreign,value:{...foreign.value,projectId:'p'}}])
      await unchanged(f,store,async()=>{
        await assert.rejects(()=>runDossierAssessmentSession(store,'p',packet.subject,f.environment,profile),
          e=>e instanceof EngineError && e.code==='discovery_dossier_session_invalid');
      });
    assert.equal(store.list<DossierAssessmentSession>('assessment-session').filter(s=>s.value.contract==='dossier-session/v1').length,0);
    assert.equal(store.list<DossierAssessmentApplication>('assessment-application').filter(a=>a.value.contract==='dossier-application/v1').length,0);
    assert.equal(dossierCalls(store).length,0);
  });
  const result=await runDossierAssessmentSession(f.open(),'p',packet.subject,f.environment,own);
  assert.equal(result.result!.result.verdict,'return');assert.deepEqual(result.result!.packet,packet);
  assert.equal(dossierCalls(f.store).length,1);
  for(const store of [f.store,f.open()])
    await fixedPoint(store,async()=>assert.deepEqual(await unchanged(f,store,()=>runDossierAssessmentSession(store,'p',packet.subject)),result));
});
test('live dossier: bounded managed pages deliver the full saved packet and schema before terminal assessment',async t=>{
  const f=await partial(t,'Exact rejected argument '+ 'bounded material '.repeat(2000)),packet=f.packet;
  const terminal=liveAdapter(f,packet,'return',false);
  const settings=JSON.parse(readFileSync(f.settings,'utf8'));settings.pageLimit=20000;writeFileSync(f.settings,JSON.stringify(settings));
  const pilot=configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:f.environment.value.reviewer.model,effort:f.environment.value.reviewer.effort,
      command:f.environment.value.reviewer.command,speed:'inherited'},agentCommand:f.environment.value.reviewer.command,
    maxRequestChars:100000,maxReadChars:20000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:100000,
    physicalLimits:{maxRequestChars:100000,maxReplyChars:100000,basis:'Bounded local dossier adapter'}},0);
  const offset=f.wires().length,result=await runDossierAssessmentSession(f.store,'p',packet.subject,f.environment,pilot);
  assert.deepEqual(result.result,await checkDossierAssessmentResult(f.store,'p',packet.subject,terminal));
  const wires=f.wires().slice(offset);assert.ok(wires[0].subject.working.materialAddresses.length);
  assert.equal(wires[0].subject.resultCapacity.envelopeLimitChars,pilot.value.maxRequestChars);
  assert.ok(wires.length>3);assert.ok(wires.every(w=>JSON.stringify(w).length<=100000));
  assert.ok(wires.some(w=>w.subject.contextWorkspace?.length));
  const profile=f.store.get<ReaderPilot>(pilot.id)!;f.store.write({id:profile.id,kind:profile.kind,expected:profile.revision,value:{...profile.value,maxCalls:1}});
  for(const store of [f.store,f.open()])await fixedPoint(store,()=>unchanged(f,store,()=>runDossierAssessmentSession(store,'p',packet.subject,undefined,store.get<ReaderPilot>(pilot.id)!)));
});

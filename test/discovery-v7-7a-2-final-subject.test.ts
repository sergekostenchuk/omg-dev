import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial: boolean|string = false, withBrief=true) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-64-transport-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Selected variant scope' });
  if(withBrief)acceptBrief(f,ORIGINAL_BRIEF);
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
    revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id,revision').all(), events:db.prepare('SELECT * FROM events ORDER BY sequence').all() } as never); }
  finally { db.close(); }
};
async function unchanged<T>(f: Paid, store: Store, action: () => Promise<T>, refuses = false): Promise<T | undefined> {
  const before = all(store), calls = money(store), wires = f.wires();
  let result: T | undefined;
  if (refuses) await assert.rejects(action, error => error instanceof EngineError);
  else result = await action();
  assert.equal(all(store), before); assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  return result;
}
async function setup(t: test.TestContext, model = false) {
  const f = await paid(t);
  const decision = model ? await modelChoose(f) : selected(f).act.decision;
  const scope = publishVariantScope(f.store, 'p', reference(decision)).scope;
  return { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
}
type Selected = Awaited<ReturnType<typeof setup>>;
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
function mask(store:Store,ref:Ref,value:unknown=null) {
  const get=store.get.bind(store),bound=new Map<PropertyKey,unknown>();
  const masked=<T>(id:string,revision?:number)=>id===ref.id&&(revision===undefined||revision===ref.revision)?value as Revision<T>:get<T>(id,revision);
  return new Proxy(store,{get(target,key){
    if(key==='get')return masked;
    if(!bound.has(key)){const value=Reflect.get(target,key);bound.set(key,typeof value==='function'?value.bind(target):value);}return bound.get(key);
  }});
}
function wideDelivery(f:Paid) {
  return configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:f.environment.value.reviewer.model,effort:f.environment.value.reviewer.effort,
      command:f.environment.value.reviewer.command,speed:'inherited'},agentCommand:f.environment.value.reviewer.command,
    maxRequestChars:3000000,maxReadChars:128000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:100000,
    physicalLimits:{maxRequestChars:3000000,maxReplyChars:100000,basis:'Full local dossier delivery'}},0);
}
async function partial(t:test.TestContext, material?:string, withBrief=true) {
  const f=await paid(t,(snapshot:Ref)=>({action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds:[snapshot]}],
    searchLimits:['Saved sweep'],unknowns:['Demand unknown']}),material??true,withBrief);
  const none=f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const handoff=await publishVariantHandoff(f.store,'p',{draft:reference(f.store.get(f.draft.id)!),result:reference(none),decision:null,scope:null,earlyLimit:false});
  const root=reference((await producePartialDossier(f.store,'p',reference(handoff.record))).record);
  return {...f,packet:await prepareDossierAssessmentSubject(f.store,'p',root)};
}

import type { PaidDossierAssessment } from '../src/discovery/dossier-manifest.js';
import { assessDossier } from '../src/discovery/research-assessment.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { DISCOVERY_FINAL_SUBJECT, DISCOVERY_FINAL_PACKET, prepareDiscoveryFinalSubject,
  requireDiscoveryFinalSubject, requireDiscoveryFinalPacket, type DiscoveryFinalPacket } from '../src/discovery/discovery-final.js';

const ORIGINAL_BRIEF='  Построй продукт для двух регионов.\nСохрани роли, альтернативы и ограничения — α.  ';
function acceptBrief(f:{store:Store;discovery:Discovery;v:{draft:Revision<DiscoveryDraft>}},text:string) {
  const draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!;
  let question=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='brief')!;
  if(question.value.status==='answered')question=f.discovery.reopen(question.id,question.revision);
  const source=f.discovery.evidence.document('p','final-assignment','PREFIX'+text+'SUFFIX','text/plain',
    f.store.get('source:p:final-assignment')?.revision??0);
  f.discovery.fact(question.id,question.revision,reference(source),{kind:'text-range',start:6,end:6+text.length});
  return source;
}
function assertFinal(packet:DiscoveryFinalPacket,text=ORIGINAL_BRIEF) {
  assert.equal(packet.contract,DISCOVERY_FINAL_PACKET);assert.equal(packet.subject.contract,DISCOVERY_FINAL_SUBJECT);
  assert.equal(packet.subject.kind,'final');assert.equal(packet.brief.text,text);
  assert.equal(packet.brief.observation.value,text);assert.equal((packet.basis.draft.value as unknown as DiscoveryDraft).fields.brief,text);
  assert.deepEqual(packet.brief.observation.source,reference(packet.brief.source));
  assert.deepEqual(packet.subject.basis.brief.selector,packet.brief.observation.selector);
  assert.deepEqual(packet.subject.basis.brief.fact,reference(packet.brief.fact));
  assert.deepEqual(packet.brief.question.value.answer,reference(packet.brief.fact));
  assert.deepEqual(packet.brief.acceptance.value.answer,reference(packet.brief.fact));
  for(const key of ['session','application','call','request','response'] as const)
    assert.deepEqual(packet.subject.basis[key],packet.assessment.value[key]);
  for(const key of ['session','application','call','response'] as const)
    assert.deepEqual(reference(packet.terminal[key]),packet.assessment.value[key]);
  assert.deepEqual(reference(packet.terminal.request.record),packet.assessment.value.request);
  assert.ok(packet.terminal.request.text.length);
  assert.equal(typeof packet.terminal.response.value.text,'string');
  assert.deepEqual(packet.terminal.session.value.result,packet.assessment.value.result);
  assert.deepEqual(packet.dossier,packet.assessment.value.result.packet);assert.deepEqual(packet.basis,packet.dossier.basis);
  assert.equal(Object.hasOwn(packet,'verdict'),false);assert.equal(Object.hasOwn(packet,'accepted'),false);
}
// Each real producer world is built once for this file. No paid rows or proof
// results are fabricated/cached; every public final door below re-proves its D6.
let owner:Selected,model:Selected,negative:Awaited<ReturnType<typeof partial>>,absent:Awaited<ReturnType<typeof partial>>;
let ownerD6:Revision<PaidDossierAssessment>,modelD6:Revision<PaidDossierAssessment>,partialD6:Revision<PaidDossierAssessment>,
  absentD6:Revision<PaidDossierAssessment>,richD6:Revision<PaidDossierAssessment>;
let ownerPacket:DiscoveryFinalPacket,partialPacket:DiscoveryFinalPacket,richPacket:DiscoveryFinalPacket;
const disposals:(()=>void)[]=[];
after(()=>{for(const dispose of disposals)dispose();});
const lifetime={after:(dispose:()=>void)=>disposals.push(dispose)} as unknown as test.TestContext;
async function ownerWorld() {
  if(owner)return;
  owner=await setup(lifetime);const entries=await complete(owner);
  const dossier=await prepareDossierAssessmentSubject(owner.store,'p',reference(produceSelectedDossier(owner.store,'p',owner.input).record));
  liveAdapter(owner,dossier,'supported',false);
  const ownerPilot=wideDelivery(owner);
  ownerD6=await assessDossier(owner.store,'p',dossier.subject,owner.environment,ownerPilot);
  const target=addresses(entries.industry)[0]!;
  const rejected=await deep(owner,'q-market',[{...(claim(owner,'q-market','market','Rejected final counterargument') as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json]);await assess(owner,rejected,'rejected');
  await deep(owner,'q-market',[{...(claim(owner,'q-market','market','Unassessed final unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved final gap',unknownId:'final-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json]);
  const rich=await prepareDossierAssessmentSubject(owner.store,'p',reference(produceSelectedDossier(owner.store,'p',owner.input).record));
  liveAdapter(owner,rich,'return',false);
  richD6=await assessDossier(owner.store,'p',rich.subject,owner.environment,ownerPilot);
  revise(owner);modeOf(owner.store,'bypass');nextPlan(owner,owner.store);
  acceptBrief(owner,'A later accepted assignment with the same Source id.');
}
async function modelWorld() {
  if(model)return;
  model=await setup(lifetime,true);await complete(model);
  const selected=await prepareDossierAssessmentSubject(model.store,'p',reference(produceSelectedDossier(model.store,'p',model.input).record));
  liveAdapter(model,selected,'supported',false);
  modelD6=await assessDossier(model.store,'p',selected.subject,model.environment,wideDelivery(model));
  revise(model);modeOf(model.store,'bypass');nextPlan(model,model.store);
  acceptBrief(model,'Later model assignment.');
}
async function partialWorld() {
  if(negative)return;
  negative=await partial(lifetime);liveAdapter(negative,negative.packet,'return',false);
  partialD6=await assessDossier(negative.store,'p',negative.packet.subject,negative.environment);
  acceptBrief(negative,'Later partial assignment.');
}
async function absentWorld() {
  if(absent)return;
  absent=await partial(lifetime,undefined,false);liveAdapter(absent,absent.packet,'return',false);
  absentD6=await assessDossier(absent.store,'p',absent.packet.subject,absent.environment);
}

test('final owner: exact paid supported and verbatim original accepted brief after new D6/brief/choice/plan',async()=>{
  await ownerWorld();
  ownerPacket=(await unchanged(owner,owner.store,()=>prepareDiscoveryFinalSubject(owner.store,'p',reference(ownerD6))))!;
  assertFinal(ownerPacket);assert.equal(ownerPacket.assessment.value.result.result.verdict,'supported');
  assert.equal(ownerPacket.dossier.manifest.value.completeness,'complete');
});
test('final model: cold exact selected input retains original field and paid grounds',async()=>{
  await modelWorld();
  const store=model.open(),packet=(await unchanged(model,store,()=>prepareDiscoveryFinalSubject(store,'p',reference(modelD6))))!;
  assertFinal(packet);assert.equal(packet.assessment.value.result.result.verdict,'supported');
  assert.notEqual(packet.subject.identity,ownerPacket.subject.identity);
});
test('final partial: exact paid return retains nonempty material, reason and original Source bytes',async()=>{
  await partialWorld();
  partialPacket=(await unchanged(negative,negative.store,()=>prepareDiscoveryFinalSubject(negative.store,'p',reference(partialD6))))!;
  assertFinal(partialPacket);assert.equal(partialPacket.assessment.value.result.result.verdict,'return');
  assert.equal(partialPacket.dossier.manifest.value.completeness,'partial');assert.ok(partialPacket.dossier.materials.length);
  assert.deepEqual(partialPacket.dossier.manifest.value.reasons,negative.packet.manifest.value.reasons);
});
test('final partial: cold require subject and packet reproduce the full original input',async()=>{
  const store=negative.open();
  await unchanged(negative,store,async()=>{
    assert.deepEqual(await requireDiscoveryFinalSubject(store,'p',partialPacket.subject),partialPacket);
    assert.deepEqual(await requireDiscoveryFinalPacket(store,'p',partialPacket),partialPacket);
  });
});
test('final forms: missing/null/unknown/mixed subject and grounds refuse before a foreign proof',async()=>{
  await unchanged(negative,negative.store,async()=>{
    for(const at of [null,undefined,{},partialD6.value.session,{...reference(partialD6),hash:'0'.repeat(64)},
      {...reference(partialD6),revision:0},{...reference(partialD6),mixed:true}])
      await assert.rejects(()=>prepareDiscoveryFinalSubject(negative.store,'p',at),e=>e instanceof EngineError);
    const subject=partialPacket.subject;
    for(const at of [null,undefined,{}, {...subject,contract:'unknown'},{...subject,kind:'plan'},{...subject,mixed:true}])
      await assert.rejects(()=>requireDiscoveryFinalSubject(negative.store,'p',at),e=>e instanceof EngineError);
    for(const path of [[],['basis'],['basis','brief']]) {
      const original=path.reduce((v:any,key)=>v[key],subject);
      for(const key of Object.keys(original))for(const omit of [false,true]) {
        const fake:any=structuredClone(subject),parent=path.reduce((v:any,k)=>v[k],fake);
        if(omit)delete parent[key];else parent[key]=null;
        await assert.rejects(()=>requireDiscoveryFinalSubject(negative.store,'p',fake),e=>e instanceof EngineError);
      }
    }
  });
});
test('final bindings: recomputed caller identity cannot substitute project/root/manifest/Source/selector',async()=>{
  await unchanged(negative,negative.store,async()=>{
    for(const change of [(v:any)=>{v.projectId='foreign';},(v:any)=>{v.dossier.root.ref.hash='0'.repeat(64);},
      (v:any)=>{v.dossier.manifest.hash='0'.repeat(64);},(v:any)=>{v.basis.brief.source=v.basis.frame;},
      (v:any)=>{v.basis.brief.selector.end--;},(v:any)=>{v.basis.assessment=v.basis.response;}]) {
      const fake=structuredClone(partialPacket.subject);change(fake);const {identity:_,...basis}=fake;
      fake.identity='discovery-final:'+hashJson(basis as unknown as Json);
      await assert.rejects(()=>requireDiscoveryFinalSubject(negative.store,'p',fake),e=>e instanceof EngineError);
    }
  });
});
test('final packet: truncation and caller text/selector/acceptance cannot replace proven bytes',async()=>{
  await unchanged(negative,negative.store,async()=>{
    for(const key of Object.keys(partialPacket)) {
      const fake:any=structuredClone(partialPacket);delete fake[key];
      await assert.rejects(()=>requireDiscoveryFinalPacket(negative.store,'p',fake),e=>e instanceof EngineError);
    }
    for(const change of [(v:any)=>{v.brief.text='caller text';},(v:any)=>{v.brief.observation.selector.end--;},
      (v:any)=>{v.brief.source.value.content='replaced';},(v:any)=>{delete v.brief.acceptance;},
      (v:any)=>{v.dossier.materials=[];},(v:any)=>{v.dossier.manifest.value.reasons=[];},
      (v:any)=>{v.assessment.value.result.completeness='complete';},
      (v:any)=>{v.terminal.request.text=v.terminal.request.text.slice(1);},
      (v:any)=>{v.terminal.response.value.text='caller response';},
      (v:any)=>{v.terminal.application=v.terminal.session;}]) {
      const fake=structuredClone(partialPacket);change(fake);
      await assert.rejects(()=>requireDiscoveryFinalPacket(negative.store,'p',fake),e=>e instanceof EngineError);
    }
  });
});
test('final proof: lost brief/paid grounds and structural supported refuse without writes',async()=>{
  await unchanged(negative,negative.store,async()=>{
    for(const at of [partialPacket.brief.observation.source,reference(partialPacket.brief.fact),reference(partialPacket.brief.acceptance),
      partialD6.value.session,partialD6.value.application,partialD6.value.request,partialD6.value.response])
      await assert.rejects(()=>prepareDiscoveryFinalSubject(mask(negative.store,at),'p',reference(partialD6)),e=>e instanceof EngineError);
    const fake=structuredClone(partialD6);fake.value.result.result.verdict='supported';fake.value.result.result.return=null;
    fake.hash=hashJson(fake.value as never);
    await assert.rejects(()=>prepareDiscoveryFinalSubject(mask(negative.store,reference(partialD6),fake),'p',reference(fake)),e=>e instanceof EngineError);
  });
});
test('final proof: cold lost original Source refuses with full fixed point',async()=>{
  const store=negative.open();
  await unchanged(negative,store,()=>prepareDiscoveryFinalSubject(mask(store,partialPacket.brief.observation.source),'p',reference(partialD6)),true);
});
test('final absence: real paid dossier without an original accepted brief refuses hot/cold',async()=>{
  await absentWorld();
  for(const store of [absent.store,absent.open()])
    await unchanged(absent,store,()=>prepareDiscoveryFinalSubject(store,'p',reference(absentD6)),true);
});
test('final rich: paid return preserves rejected/unassessed/unknown and both blocking sides',async()=>{
  richPacket=(await unchanged(owner,owner.store,()=>prepareDiscoveryFinalSubject(owner.store,'p',reference(richD6))))!;
  assertFinal(richPacket);assert.ok(richPacket.dossier.materials.some(m=>m.status==='rejected'));
  assert.ok(richPacket.dossier.materials.some(m=>m.status==='unassessed'));assert.ok(richPacket.dossier.unknowns.length);
  assert.ok(richPacket.assessment.value.result.blockingContradictions.length);
  assert.ok(richPacket.dossier.contradictions.every(row=>row.sides.length===2));
  assert.notEqual(richPacket.subject.identity,ownerPacket.subject.identity);
});
test('final rich: cold packet losing a blocking side refuses without buying again',async()=>{
  const store=owner.open(),fake=structuredClone(richPacket);fake.dossier.contradictions[0]!.sides.pop();
  await unchanged(owner,store,()=>requireDiscoveryFinalPacket(store,'p',fake),true);
});

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
import { prepareResearchEnvelope, researchCall } from '../src/discovery/research-protocol.js';
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
import { storeUnchanged } from './store-unchanged.js';
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
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial: boolean|string = false, withBrief=true, withObjective=false) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-64-transport-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Selected variant scope' });
  if(withBrief)acceptBrief(f,ORIGINAL_BRIEF);
  if(withObjective) {
    const draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!;
    const question=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='objective')!;
    f.discovery.decision(question.id,question.revision,'owner','Deliver the accepted assignment');
  }
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
async function unchanged<T>(f: Paid, store: Store, action: () => Promise<T>,
  mode: 'stamp' | 'full' | 'cross-store' = 'stamp'): Promise<T> {
  const before = mode === 'stamp' ? null : all(store), calls = money(store), wires = f.wires();
  try {
    // The partial recovery below reads through a second connection, whose
    // legitimate proof-cache writes can move this connection's data_version.
    // It keeps the full product-history comparison instead of a stamp.
    return mode === 'cross-store' ? await action() : await storeUnchanged(store, action);
  } finally {
    const after = before === null ? null : all(store), afterCalls = money(store), afterWires = f.wires();
    if (before !== null) assert.equal(after, before);
    assert.deepEqual(afterCalls, calls); assert.deepEqual(afterWires, wires);
  }
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
async function partial(t:test.TestContext, material?:string, withBrief=true, withObjective=false) {
  const f=await paid(t,(snapshot:Ref)=>({action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds:[snapshot]}],
    searchLimits:['Saved sweep'],unknowns:['Demand unknown']}),material??true,withBrief,withObjective);
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
const LARGE_COUNTERARGUMENT='Exact blocking counterargument: '+ '0123456789α'.repeat(2600);
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
  const rejected=await deep(owner,'q-market',[{...(claim(owner,'q-market','market',LARGE_COUNTERARGUMENT) as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json]);await assess(owner,rejected,'rejected');
  await deep(owner,'q-market',[{...(claim(owner,'q-market','market','Unassessed final unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved final gap',unknownId:'final-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json]);
  const rich=await prepareDossierAssessmentSubject(owner.store,'p',reference(produceSelectedDossier(owner.store,'p',owner.input).record));
  liveAdapter(owner,rich,'return',false);
  richD6=await assessDossier(owner.store,'p',rich.subject,owner.environment,ownerPilot);
}
async function modelWorld() {
  if(model)return;
  model=await setup(lifetime,true);await complete(model);
  const selected=await prepareDossierAssessmentSubject(model.store,'p',reference(produceSelectedDossier(model.store,'p',model.input).record));
  liveAdapter(model,selected,'supported',false);
  modelD6=await assessDossier(model.store,'p',selected.subject,model.environment,wideDelivery(model));
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

import { Ajv } from 'ajv';
import { V7_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { DISCOVERY_FINAL_RESULT, prepareDiscoveryFinalResultTransport, projectDiscoveryFinal,
  checkDiscoveryFinalResearchReply, type DiscoveryFinalResultTransport } from '../src/discovery/discovery-final-result.js';

const LIMIT=3_000_000;
let ownerTransport:DiscoveryFinalResultTransport;
type Outcome='go'|'conditional'|'no_go'|'insufficient_evidence';
function candidate(packet:DiscoveryFinalPacket,outcome:Outcome) {
  const verdict={outcome,reason:'The final decision retains its own reasons',
    conditions:outcome==='conditional'?[{id:'evidence-1',kind:'evidence',condition:'A source is available',criterion:'A signed agreement'}]:[]};
  const bundle=outcome==='go'||outcome==='conditional'
    ? {contract:V7_FINAL_CONTRACT,dossier:packet.dossier.manifest.ref,verdict,
      summary:{what:'Ledger',forWhom:'Operators',why:'Traceability',firstResult:'A first record',successCriterion:'No missing record',nonGoals:['Payroll']},
      projection:{users:['Operator'],payers:['Company'],rules:['Policy'],externalSystems:['Books'],unresolved:['Integration']},
      constitution:{goal:'Traceability',consumers:['Operator'],nonGoals:['Payroll'],successCriterion:'No missing record'}}
    : {contract:V7_FINAL_CONTRACT,dossier:packet.dossier.manifest.ref,verdict,
      summary:{reasons:['A bounded refusal'],found:['Evidence'],needed:['More evidence']},projection:null,constitution:null};
  return {contract:DISCOVERY_FINAL_RESULT,subject:structuredClone(packet.subject),bundle};
}
const prepared=(store:Store,packet:DiscoveryFinalPacket,limit=LIMIT)=>
  prepareDiscoveryFinalResultTransport(store,'p',packet.subject,limit);
const checked=(store:Store,packet:unknown,transport:DiscoveryFinalResultTransport,reply:unknown,limit=LIMIT)=>
  checkDiscoveryFinalResearchReply(store,'p',packet,limit,transport.capacity,reply);
function reidentified(subject:DiscoveryFinalPacket['subject']) {
  const clone=structuredClone(subject),{identity:_identity,...basis}=clone;
  clone.identity=`discovery-final:${hashJson(basis as never)}`;
  return clone;
}

import { readArchiveBody } from '../src/discovery/request-parts.js';
import { prepareDiscoveryFinalEnvelope, requireDiscoveryFinalEnvelope, stageDiscoveryFinalEnvelope,
  type DiscoveryFinalEnvelopeInput } from '../src/discovery/discovery-final-packing.js';
import { DISCOVERY_FINAL_SESSION_KIND, prepareDiscoveryFinalSession, readDiscoveryFinalSessionAt,
  type DiscoveryFinalSession } from '../src/discovery/discovery-final-session.js';

const RESULT_LIMIT = 10_000_000;
function finalInput(f: Paid): DiscoveryFinalEnvelopeInput {
  return { prompt: 'Build the exact final Discovery package from the saved mandate and assessed dossier.',
    packetChars: 24_000, limitChars: 64_000, resultLimitChars: RESULT_LIMIT,
    environment: reference(f.environment), role: structuredClone(f.environment.value.implementer) };
}
async function preparePaidFinal(f: Paid, packet: DiscoveryFinalPacket) {
  const input=finalInput(f),before=f.store.lastEvent(),calls=money(f.store),wire=f.wires();
  const cell=await prepareDiscoveryFinalSession(f.store,'p',packet.subject,input);
  const events=f.store.eventsPage(before,f.store.lastEvent(),1000);
  assert.ok(events.some(event=>event.kind===DISCOVERY_FINAL_SESSION_KIND));
  assert.ok(events.every(event=>['request-part','research-context',DISCOVERY_FINAL_SESSION_KIND].includes(event.kind)),
    events.map(event=>event.kind).join(','));
  assert.deepEqual(money(f.store),calls);assert.deepEqual(f.wires(),wire);
  assert.equal(cell.value.state,'prepared');assert.deepEqual(cell.value.cursor,{offset:0});
  assert.equal(cell.value.result,null);assert.equal(Object.hasOwn(cell.value,'paid'),false);
  assert.equal(Object.hasOwn(cell.value,'accepted'),false);
  assert.equal(cell.value.envelope.input.length,cell.value.envelope.measuredChars);
  assert.ok(cell.value.envelope.measuredChars<=input.limitChars);
  const wireInput=JSON.parse(cell.value.envelope.input);
  assert.equal(wireInput.protocol,'omg-agent/v1');assert.equal(wireInput.model,input.role.model);
  assert.equal(wireInput.effort,input.role.effort);assert.equal(wireInput.prompt,input.prompt);
  assert.deepEqual(wireInput.subject.resultCapacity,cell.value.envelope.capacity);
  assert.deepEqual(wireInput.subject.schema,cell.value.envelope.packet.schema);
  assert.ok('archive' in cell.value.envelope.capacity.mandatory);
  const archive=f.store.get<any>(cell.value.archive.id,cell.value.archive.revision)!;
  const original=readArchiveBody(f.store,archive).body.request;
  assert.deepEqual(original.packet,packet);assert.deepEqual(original.subject,packet.subject);
  assert.deepEqual(original.schema,cell.value.envelope.packet.schema);
  return {cell,input,original};
}

test('final pack: real owner selected retains the complete paid D6 and both blocking sides after later heads',async()=>{
  await ownerWorld();
  ownerPacket=await prepareDiscoveryFinalSubject(owner.store,'p',reference(ownerD6));
  richPacket=await prepareDiscoveryFinalSubject(owner.store,'p',reference(richD6));
  assertFinal(richPacket);assert.ok(richPacket.dossier.unknowns.length);
  assert.ok(richPacket.dossier.contradictions.every(row=>row.sides.length===2));
  assert.ok(richPacket.assessment.value.result.blockingContradictions.length);
  const {cell,input,original}=await preparePaidFinal(owner,richPacket);
  assert.equal(original.packet.brief.text,ORIGINAL_BRIEF);
  assert.ok(JSON.stringify(original.packet).includes(LARGE_COUNTERARGUMENT));
  const wire=JSON.parse(cell.value.envelope.input),packet=wire.subject;
  assert.ok(packet.working.materialAddresses.some((address:any)=>address.field==='request'));
  assert.ok(packet.materialDelivery?.[0]);
  assert.ok((packet.materialDelivery[0].served.end-packet.materialDelivery[0].served.offset)>0);
  assert.ok(JSON.stringify(original).length>cell.value.envelope.measuredChars);
  revise(owner);modeOf(owner.store,'bypass');nextPlan(owner,owner.store);
  acceptBrief(owner,'A later accepted assignment with the same Source id.');
  for(const [store,mode] of [[owner.store,'full'],[owner.open(),'stamp']] as const) await unchanged(owner,store,async()=>{
    assert.deepEqual(await readDiscoveryFinalSessionAt(store,'p',reference(cell)),cell);
    assert.deepEqual(await requireDiscoveryFinalEnvelope(store,'p',richPacket.subject,input,cell.value.envelope),cell.value.envelope);
    assert.deepEqual(await prepareDiscoveryFinalSession(store,'p',richPacket.subject,input),cell);
  },mode);
});

test('final pack: real paid model selection keeps its saved role and environment on a cold Store',async()=>{
  await modelWorld();
  const packet=await prepareDiscoveryFinalSubject(model.store,'p',reference(modelD6));assertFinal(packet);
  const {cell,input}=await preparePaidFinal(model,packet),cold=model.open();
  assert.deepEqual(cell.value.environment,reference(model.environment));
  assert.deepEqual(cell.value.role,model.environment.value.implementer);
  revise(model);modeOf(model.store,'bypass');nextPlan(model,model.store);
  acceptBrief(model,'Later model assignment.');
  await unchanged(model,cold,async()=>{
    assert.deepEqual(await readDiscoveryFinalSessionAt(cold,'p',reference(cell)),cell);
    assert.deepEqual(await prepareDiscoveryFinalSession(cold,'p',packet.subject,input),cell);
  },'full');
});

let partialCell:Revision<DiscoveryFinalSession>,partialInput:DiscoveryFinalEnvelopeInput;
test('final pack: paid return with nonempty partial remains partial and does not imply a D7 verdict',async()=>{
  await partialWorld();
  partialPacket=await prepareDiscoveryFinalSubject(negative.store,'p',reference(partialD6));assertFinal(partialPacket);
  assert.deepEqual(await requireDiscoveryFinalSubject(negative.store,'p',partialPacket.subject),partialPacket);
  assert.deepEqual(await requireDiscoveryFinalPacket(negative.store,'p',partialPacket),partialPacket);
  assert.equal(partialPacket.dossier.manifest.value.completeness,'partial');
  assert.ok(partialPacket.dossier.materials.length);assert.equal(partialPacket.assessment.value.result.result.verdict,'return');
  const prepared=await preparePaidFinal(negative,partialPacket);partialCell=prepared.cell;partialInput=prepared.input;
  assert.equal(prepared.original.packet.assessment.value.result.result.verdict,'return');
  assert.equal(prepared.original.packet.dossier.manifest.value.completeness,'partial');
  assert.equal(Object.hasOwn(prepared.original.packet,'verdict'),false);
  await unchanged(negative,negative.open(),async()=>{
    assert.deepEqual(await readDiscoveryFinalSessionAt(negative.open(),'p',reference(partialCell)),partialCell);
  },'cross-store');
});

test('final pack: exact physical envelope boundary and refusal before any archive or session write',async()=>{
  const input=finalInput(negative);
  await unchanged(negative,negative.store,async()=>{
    const staged=await stageDiscoveryFinalEnvelope(negative.store,'p',partialPacket.subject,input);
    const length=staged.envelope.input.length;
    assert.ok(length>input.packetChars);
    const exact={...input,limitChars:length};
    assert.equal((await stageDiscoveryFinalEnvelope(negative.store,'p',partialPacket.subject,exact)).envelope.input.length,length);
    await assert.rejects(()=>prepareDiscoveryFinalSession(negative.store,'p',partialPacket.subject,{...exact,limitChars:length-1}),
      error=>error instanceof EngineError&&error.code==='discovery_final_envelope_limit');
    assert.deepEqual(await prepareDiscoveryFinalEnvelope(negative.store,'p',partialPacket.subject,partialInput),partialCell.value.envelope);
  },'full');
  await unchanged(owner,owner.store,async()=>{
    const freshInput=finalInput(owner);
    const staged=await stageDiscoveryFinalEnvelope(owner.store,'p',ownerPacket.subject,freshInput);
    assert.ok(staged.writes.some(write=>write.kind==='research-context'), 'A new exact archive must still be staged');
    const limitChars=staged.envelope.input.length-1;
    assert.ok(limitChars>freshInput.packetChars);
    await assert.rejects(()=>prepareDiscoveryFinalSession(owner.store,'p',ownerPacket.subject,{...freshInput,limitChars}),
      error=>error instanceof EngineError&&error.code==='discovery_final_envelope_limit');
  },'full');
});

test('final pack: simultaneous Stores converge on one prepared session without a second paid call',async()=>{
  const cold=owner.open(),input=finalInput(owner),before=owner.store.lastEvent(),calls=money(owner.store),wire=owner.wires();
  const [hotResult,coldResult]=await Promise.all([
    prepareDiscoveryFinalSession(owner.store,'p',ownerPacket.subject,input),
    prepareDiscoveryFinalSession(cold,'p',ownerPacket.subject,input),
  ]);
  assert.deepEqual(hotResult,coldResult);
  const saved=owner.store.eventsPage(before,owner.store.lastEvent(),1000);
  assert.equal(saved.filter(event=>event.kind===DISCOVERY_FINAL_SESSION_KIND).length,1);
  assert.equal(hotResult.revision,1);assert.deepEqual(money(owner.store),calls);assert.deepEqual(owner.wires(),wire);
  await unchanged(owner,cold,async()=>assert.deepEqual(await prepareDiscoveryFinalSession(cold,'p',ownerPacket.subject,input),hotResult),'full');
});

test('final pack: archived and inline result admission prove the same D6 with independent result limits',async()=>{
  await unchanged(negative,negative.store,async()=>{
    ownerTransport=await prepared(owner.store,ownerPacket);
    const inline=await prepared(negative.store,partialPacket),reply=candidate(partialPacket,'go');
    assert.deepEqual((await checked(negative.store,partialPacket,inline,reply)).normalized,reply);
    assert.deepEqual(projectDiscoveryFinal(partialPacket,reply).packet,partialPacket);
    const validate=new Ajv({strict:true,allowUnionTypes:true}).compile(inline.schema);
    assert.equal(validate(reply),true,JSON.stringify(validate.errors));
    assert.deepEqual((await checkDiscoveryFinalResearchReply(negative.store,'p',partialPacket,RESULT_LIMIT,
      partialCell.value.envelope.capacity,reply)).normalized,reply);
    await assert.rejects(()=>checked(negative.store,partialPacket,ownerTransport,reply),e=>e instanceof EngineError);
    let limit=LIMIT,transport=await prepareDiscoveryFinalResultTransport(negative.store,'p',partialPacket.subject,limit,{archive:'staged'});
    for(let i=0;i<10;i++) {
      const next=transport.capacity.forms[0]!.minimumChars+JSON.stringify(reply).length;
      if(next===limit)break;
      limit=next;transport=await prepareDiscoveryFinalResultTransport(negative.store,'p',partialPacket.subject,limit,{archive:'staged'});
    }
    const exact=await checkDiscoveryFinalResearchReply(negative.store,'p',partialPacket,limit,transport.capacity,reply);
    assert.equal(exact.measurement.requiredChars,limit);assert.equal(exact.measurement.fits,true);
    const oversized=structuredClone(reply);oversized.bundle.verdict.reason+='x';
    await assert.rejects(()=>checkDiscoveryFinalResearchReply(negative.store,'p',partialPacket,limit,transport.capacity,oversized),
      e=>e instanceof EngineError&&e.code==='research_result_capacity');
  },'full');
});

test('final pack: request and result limits are independent and the saved pilot caps still apply',async()=>{
  const base=partialCell.value.envelope.capacity,role=negative.environment.value.implementer,env=negative.environment.value;
  const pilot=configureReaderPilot(negative.store,negative.engine.environments,'p',{
    experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:env.reviewer.model,effort:env.reviewer.effort,
      command:env.reviewer.command,speed:'inherited'},agentCommand:env.reviewer.command,
    maxRequestChars:40_000,maxReadChars:10_000,maxReplyChars:100_000,maxCalls:100,maxReportedTokens:100_000,
    physicalLimits:{maxRequestChars:30_000,maxReplyChars:100_000,basis:'Saved stricter transport cap'},
  },0);
  await unchanged(negative,negative.store,async()=>{
    const resultLimit=base.forms[0]!.minimumChars+20_000;
    const input={...partialInput,prompt:'p'.repeat(resultLimit),resultLimitChars:resultLimit,
      limitChars:resultLimit+100_000};
    const staged=await stageDiscoveryFinalEnvelope(negative.store,'p',partialPacket.subject,input);
    assert.ok(staged.envelope.input.length>resultLimit);
    assert.ok(staged.envelope.input.length<=input.limitChars);
    assert.equal(staged.envelope.capacity.envelopeLimitChars,resultLimit);
    assert.deepEqual(JSON.parse(staged.envelope.input).subject.resultCapacity,staged.envelope.capacity);
    const tooLong=candidate(partialPacket,'go');tooLong.bundle.verdict.reason='x'.repeat(resultLimit);
    await assert.rejects(()=>checkDiscoveryFinalResearchReply(negative.store,'p',partialPacket,resultLimit,
      staged.envelope.capacity,tooLong),e=>e instanceof EngineError&&e.code==='research_result_capacity');

    const old=prepareResearchEnvelope(role,env,'legacy',{},undefined,base);
    const sameWire=prepareResearchEnvelope(role,env,'legacy',{},undefined,base,undefined,undefined,base.envelopeLimitChars);
    assert.equal(old.input,sameWire.input);
    for(const invalid of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])
      assert.throws(()=>prepareResearchEnvelope(role,env,'legacy',{},undefined,base,undefined,undefined,invalid),
        e=>e instanceof EngineError&&e.code==='research_request_limit_invalid');
    const audit={store:negative.store,draftId:negative.v.draft.id,purpose:'analyst',pilot};
    assert.throws(()=>prepareResearchEnvelope(role,env,'p'.repeat(31_000),{},audit,base,undefined,undefined,60_000),
      e=>e instanceof EngineError&&e.code==='budget_transport_limit');
    assert.throws(()=>prepareResearchEnvelope(role,env,'p'.repeat(41_000),{},audit,base,undefined,undefined,60_000),
      e=>e instanceof EngineError&&e.code==='pilot_request_limit');
  },'full');
});

test('final pack: mixed subjects, incomplete envelopes, foreign role and changed archive or capacity refuse',async()=>{
  const input=partialInput,cell=partialCell,good=cell.value.envelope;
  await unchanged(negative,negative.store,async()=>{
    const laterForeignSource=reference(model.store.get('source:p:final-assignment')!);
    assert.notDeepEqual(laterForeignSource,partialPacket.subject.basis.brief.source);
    for(const bad of [null,{}, {...input,prompt:null}, {...input,extra:true}, {...input,environment:null},
      {...input,environment:reference(model.environment)},
      {...input,role:{...input.role,model:'foreign-model'}}, {...input,limitChars:0}])
      await assert.rejects(()=>prepareDiscoveryFinalSession(negative.store,'p',partialPacket.subject,bad),e=>e instanceof EngineError);
    const subjects=[null,reidentified({...partialPacket.subject,dossier:ownerPacket.subject.dossier}),
      reidentified({...partialPacket.subject,basis:{...partialPacket.subject.basis,
      assessment:ownerPacket.subject.basis.assessment}}),reidentified({...partialPacket.subject,
      basis:{...partialPacket.subject.basis,brief:{...partialPacket.subject.basis.brief,source:laterForeignSource}}}),
      reidentified({...partialPacket.subject,
      basis:{...partialPacket.subject.basis,brief:{...partialPacket.subject.basis.brief,selector:{kind:'text-range',start:0,end:1}}}})];
    for(const subject of subjects) await assert.rejects(()=>prepareDiscoveryFinalSession(negative.store,'p',subject,input),e=>e instanceof EngineError);
    for(const mutate of [
      (x:any)=>{delete x.packet;},(x:any)=>{x.extra=true;},(x:any)=>{x.input=null;},
      (x:any)=>{x.subject=ownerPacket.subject;},(x:any)=>{x.archive=ownerPacket.subject.basis.assessment;},
      (x:any)=>{x.capacity.operation='foreign';},(x:any)=>{x.capacity.mandatory.archive.pointer='/body/other';},
      (x:any)=>{x.capacity.mandatory.archive.hash='0'.repeat(64);},
      (x:any)=>{x.packet.schema.properties.bundle=null;},(x:any)=>{x.measuredChars++;},
    ]) {
      const altered:any=structuredClone(good);mutate(altered);
      await assert.rejects(()=>requireDiscoveryFinalEnvelope(negative.store,'p',partialPacket.subject,input,altered),e=>e instanceof EngineError);
    }
    for(const mutate of [
      (x:any)=>{delete x.archive;},(x:any)=>{x.result={accepted:true};},(x:any)=>{x.unknown=true;},
      (x:any)=>{x.role.model='foreign';},(x:any)=>{x.input.prompt='a forged instruction';},
      (x:any)=>{x.archive=ownerPacket.subject.basis.assessment;},
    ]) {
      const value:any=structuredClone(cell.value);mutate(value);const hash=hashJson(value);
      const row={...cell,id:`${DISCOVERY_FINAL_SESSION_KIND}:p:${hash}`,hash,value};
      await assert.rejects(()=>readDiscoveryFinalSessionAt(mask(negative.store,reference(row),row),'p',reference(row)),e=>e instanceof EngineError);
    }
  },'full');
});

test('final pack: missing archive, archive part and rehashed capacity cannot impersonate paid grounds hot or cold',async()=>{
  const archive=negative.store.get<any>(partialCell.value.archive.id,partialCell.value.archive.revision)!;
  assert.ok(archive.value.parts.length);const part=archive.value.parts[0] as Ref;
  for(const [store,mode] of [[negative.store,'full'],[negative.open(),'stamp']] as const) await unchanged(negative,store,async()=>{
    for(const ref of [partialCell.value.archive,part,partialPacket.subject.basis.brief.source,
      partialPacket.subject.basis.assessment,partialPacket.subject.basis.response]) {
      const masked=mask(store,ref);
      await assert.rejects(()=>readDiscoveryFinalSessionAt(masked,'p',reference(partialCell)),e=>e instanceof EngineError);
      await assert.rejects(()=>checkDiscoveryFinalResearchReply(masked,'p',partialPacket,RESULT_LIMIT,
        partialCell.value.envelope.capacity,candidate(partialPacket,'no_go')),e=>e instanceof EngineError);
    }
    const savedPart=store.get<any>(part.id,part.revision)!;
    const value={...savedPart.value,text:savedPart.value.text+'x'};
    const substituted={...savedPart,value,hash:hashJson(value)};
    const maskedPart=mask(store,part,substituted);
    await assert.rejects(()=>readDiscoveryFinalSessionAt(maskedPart,'p',reference(partialCell)),e=>e instanceof EngineError);
    await assert.rejects(()=>checkDiscoveryFinalResearchReply(maskedPart,'p',partialPacket,RESULT_LIMIT,
      partialCell.value.envelope.capacity,candidate(partialPacket,'no_go')),e=>e instanceof EngineError);
    for(const mutate of [(x:any)=>{x.mandatory.archive.record.hash='0'.repeat(64);},
      (x:any)=>{x.mandatory.archive.pointer='/body/foreign';},(x:any)=>{x.mandatory.archive.hash='0'.repeat(64);},
      (x:any)=>{x.bindings.finalSubject=ownerPacket.subject;}]) {
      const capacity:any=structuredClone(partialCell.value.envelope.capacity);mutate(capacity);
      await assert.rejects(()=>checkDiscoveryFinalResearchReply(store,'p',partialPacket,RESULT_LIMIT,capacity,
        candidate(partialPacket,'no_go')),e=>e instanceof EngineError);
    }
  },mode);
});

test('final pack: absent original brief cannot synthesize a session',async()=>{
  await absentWorld();
  for(const [store,mode] of [[absent.store,'full'],[absent.open(),'stamp']] as const) await unchanged(absent,store,async()=>{
    await assert.rejects(()=>prepareDiscoveryFinalSubject(store,'p',reference(absentD6)),e=>e instanceof EngineError);
    await assert.rejects(()=>prepareDiscoveryFinalSession(store,'p',null,finalInput(absent)),e=>e instanceof EngineError);
  },mode);
});


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
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import type { Revision } from '../src/storage/store.js';
import type { PaidDossierAssessment } from '../src/discovery/dossier-manifest.js';
import { assessDossier } from '../src/discovery/research-assessment.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { prepareDiscoveryFinalSubject,
  type DiscoveryFinalPacket } from '../src/discovery/discovery-final.js';
import { V7_FINAL_CONTRACT, checkV7Final, type V7FinalBundle } from '../src/discovery/v7-final-contracts.js';
import { prepareDiscoveryFinalAssessmentSubject, type DiscoveryFinalAssessmentPacket } from '../src/discovery/discovery-final-assessment-subject.js';
import { DISCOVERY_FINAL_ASSESSMENT_ENVELOPE, prepareDiscoveryFinalAssessmentEnvelope, stageDiscoveryFinalAssessmentEnvelope,
  type DiscoveryFinalAssessmentEnvelopeInput } from '../src/discovery/discovery-final-assessment-packing.js';
import { DISCOVERY_FINAL_ASSESSMENT_SESSION, DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND, prepareDiscoveryFinalAssessmentSession,
  readDiscoveryFinalAssessmentSessionAt, type DiscoveryFinalAssessmentSession } from '../src/discovery/discovery-final-assessment-session.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';

// DR7 7a.3 (codex-omg2 №15630): the immutable prepared session of the complete D7 assessor request over the accepted
// packing. The paid D6 worlds below are the subject test's own real lines (owner/model selected, partial, rich).

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

/** The real paid line of 4B.1/4O.2: two assessed plan questions, the variant snapshot, real project modes and the real
 * paid generation of a two-member set with its first state. */
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial: boolean|string = false, withBrief=true, withObjective=false) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-7a3s-' }), project = 'p', runs = new Map<string, string>();
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
  else if(address)record(keyOf(address.record,address.pointer),0,address.total);
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

/** A lawful D7 candidate of each outcome over the exact manifest Ref — checked
 * here so a builder slip fails the fixture, not the subject doors. */
function candidate(manifest: Ref, outcome: 'go' | 'conditional' | 'no_go' | 'insufficient_evidence'): V7FinalBundle {
  const positive = outcome === 'go' || outcome === 'conditional';
  const bundle = { contract: V7_FINAL_CONTRACT, dossier: manifest,
    verdict: { outcome, reason: `The dossier assessment reports ${outcome}`, conditions:
      outcome === 'conditional' ? [
        { id: 'c-evidence', kind: 'evidence', condition: 'Deployment evidence exists', criterion: 'A saved source names it' },
        { id: 'c-owner', kind: 'owner_choice', condition: 'Owner picks the deployment scope', criterion: 'A saved owner choice', options: [
          { optionId: 'accept', label: 'Accept the scope', consequences: ['The build proceeds'], choice: 'accept' },
          { optionId: 'decline', label: 'Decline the scope', consequences: ['The build stops'], choice: 'decline' }] }] : [] },
    summary: positive ? { what: 'A bounded product for the brief', forWhom: 'The named owner', why: 'The accepted assignment',
      firstResult: 'The first saved answer', successCriterion: 'The brief is served', nonGoals: ['No unbounded scope'] }
      : { reasons: [`The ${outcome} follows the dossier state`], found: ['Saved dossier materials'], needed: ['A new exact basis'] },
    projection: positive ? { users: ['The owner'], payers: [], rules: ['The saved rules'], externalSystems: [], unresolved: [] } : null,
    constitution: positive ? { goal: 'Serve the accepted brief', consumers: ['The owner'], nonGoals: ['No extras'], successCriterion: 'The brief is served' } : null };
  return checkV7Final(bundle);
}
let owner: Selected, model: Selected, negative: Awaited<ReturnType<typeof partial>>;
let ownerD6: Revision<PaidDossierAssessment>, modelD6: Revision<PaidDossierAssessment>,
  partialD6: Revision<PaidDossierAssessment>, richD6: Revision<PaidDossierAssessment>;
let ownerFinal: DiscoveryFinalPacket, partialFinal: DiscoveryFinalPacket, richFinal: DiscoveryFinalPacket;
const disposals: (() => void)[] = [];
after(() => { for (const dispose of disposals) dispose(); });
const lifetime = { after: (dispose: () => void) => disposals.push(dispose) } as unknown as test.TestContext;
async function ownerWorld() {
  if (owner) return;
  owner = await setup(lifetime); const entries = await complete(owner);
  const dossier = await prepareDossierAssessmentSubject(owner.store, 'p', reference(produceSelectedDossier(owner.store, 'p', owner.input).record));
  liveAdapter(owner, dossier, 'supported', false);
  const ownerPilot = wideDelivery(owner);
  ownerD6 = await assessDossier(owner.store, 'p', dossier.subject, owner.environment, ownerPilot);
  const target = addresses(entries.industry)[0]!;
  const rejected = await deep(owner, 'q-market', [{ ...(claim(owner, 'q-market', 'market', 'Rejected final counterargument') as Record<string, Json>),
    contradicts: [target], refutedBy: [target] } as unknown as Json]); await assess(owner, rejected, 'rejected');
  await deep(owner, 'q-market', [{ ...(claim(owner, 'q-market', 'market', 'Unassessed final unknown') as Record<string, Json>), kind: 'unknown',
    basis: { origin: 'Saved final gap', unknownId: 'final-gap', question: 'Which deployment?', affects: ['deployment'], consumer: 'feasibility',
      blocksCurrentStage: false, moment: 'feasibility', closeCriterion: 'Identify deployment' } } as unknown as Json]);
  const rich = await prepareDossierAssessmentSubject(owner.store, 'p', reference(produceSelectedDossier(owner.store, 'p', owner.input).record));
  liveAdapter(owner, rich, 'return', false);
  richD6 = await assessDossier(owner.store, 'p', rich.subject, owner.environment, ownerPilot);
  ownerFinal = await prepareDiscoveryFinalSubject(owner.store, 'p', reference(ownerD6));
  richFinal = await prepareDiscoveryFinalSubject(owner.store, 'p', reference(richD6));
  revise(owner); modeOf(owner.store, 'bypass'); nextPlan(owner, owner.store);
  acceptBrief(owner, 'A later accepted assignment with the same Source id.');
}
async function modelWorld() {
  if (model) return;
  model = await setup(lifetime, true); await complete(model);
  const selected = await prepareDossierAssessmentSubject(model.store, 'p', reference(produceSelectedDossier(model.store, 'p', model.input).record));
  liveAdapter(model, selected, 'supported', false);
  modelD6 = await assessDossier(model.store, 'p', selected.subject, model.environment, wideDelivery(model));
  revise(model); modeOf(model.store, 'bypass'); nextPlan(model, model.store);
  acceptBrief(model, 'Later model assignment.');
}
async function partialWorld() {
  if (negative) return;
  negative = await partial(lifetime); liveAdapter(negative, negative.packet, 'return', false);
  partialD6 = await assessDossier(negative.store, 'p', negative.packet.subject, negative.environment);
  partialFinal = await prepareDiscoveryFinalSubject(negative.store, 'p', reference(partialD6));
  acceptBrief(negative, 'Later partial assignment.');
}


const RESULT_LIMIT = 10_000_000;
function assessmentInput(f: Paid, packetChars = 24_000): DiscoveryFinalAssessmentEnvelopeInput {
  return { prompt: 'Assess the exact D7 bundle against the saved dossier and the verbatim assignment.',
    packetChars, limitChars: 400_000, resultLimitChars: RESULT_LIMIT,
    environment: reference(f.environment), role: structuredClone(f.environment.value.reviewer) };
}
const refusal = (code?: string) => (error: unknown) => error instanceof EngineError && (!code || error.code === code);

const events = (store: Store, from: number) => store.eventsPage(from, store.lastEvent(), 1000);
/** Prepare once on a fresh subject: the archive, its parts and the session appear in one write, nothing is paid or sent. */
async function prepareSession(f: Paid, packet: DiscoveryFinalAssessmentPacket, input = assessmentInput(f)) {
  const before = f.store.lastEvent(), calls = money(f.store), wire = f.wires();
  const session = await prepareDiscoveryFinalAssessmentSession(f.store, 'p', packet.subject, input);
  const written = events(f.store, before);
  assert.ok(written.some(event => event.kind === DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND));
  assert.ok(written.every(event => ['request-part', 'research-context', DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND].includes(event.kind)),
    written.map(event => event.kind).join(','));
  assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
  const value = session.value;
  assert.equal(session.revision, 1); assert.equal(value.contract, DISCOVERY_FINAL_ASSESSMENT_SESSION);
  assert.equal(value.kind, 'final-assessment'); assert.equal(value.state, 'prepared'); assert.equal(value.project, 'p');
  assert.equal(session.id, `${DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND}:p:${hashJson(value as never)}`);
  assert.deepEqual(value.subject, packet.subject);
  assert.deepEqual(value.environment, reference(f.environment)); assert.deepEqual(value.role, f.environment.value.reviewer);
  assert.deepEqual(value.limits, { request: input.limitChars, reply: input.resultLimitChars }); assert.deepEqual(value.input, input);
  assert.equal(value.envelope.contract, DISCOVERY_FINAL_ASSESSMENT_ENVELOPE); assert.deepEqual(value.archive, value.envelope.archive);
  for (const key of ['call', 'calls', 'ledger', 'paid', 'supported', 'accepted', 'result', 'cursor', 'authority'])
    assert.equal(Object.hasOwn(value, key), false, `a prepared session carries no ${key}`);
  const archive = f.store.get<any>(value.archive.id, value.archive.revision)!;
  assert.deepEqual(readArchiveBody(f.store, archive).body.request.packet, packet, 'the archive keeps the whole proven request');
  // Repeat and exact read write nothing and pay nothing.
  assert.deepEqual(await unchanged(f, f.store, () => prepareDiscoveryFinalAssessmentSession(f.store, 'p', packet.subject, input)), session);
  assert.deepEqual(await unchanged(f, f.store, () => readDiscoveryFinalAssessmentSessionAt(f.store, 'p', reference(session))), session);
  return { session, input };
}

test('7a.3 session owner: the four candidate forms each save one immutable prepared session, and the exact read re-proves it', async () => {
  await ownerWorld();
  const manifest = ownerFinal.dossier.manifest.ref, ids = new Set<string>();
  for (const outcome of ['go', 'conditional', 'no_go', 'insufficient_evidence'] as const) {
    const packet = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(manifest, outcome));
    const { session } = await prepareSession(owner, packet);
    assert.equal(session.value.subject.candidate.verdict.outcome, outcome);
    ids.add(session.id);
  }
  assert.equal(ids.size, 4, 'every candidate is its own prepared session');
});

test('7a.3 session model: a cold Store after late heads reads and repeats the exact session, and returned data is isolated', async () => {
  await modelWorld();
  const final = await prepareDiscoveryFinalSubject(model.store, 'p', reference(modelD6));
  const packet = await prepareDiscoveryFinalAssessmentSubject(model.store, 'p', reference(modelD6), candidate(final.dossier.manifest.ref, 'conditional'));
  const { session, input } = await prepareSession(model, packet), kept = structuredClone(session);
  const cold = model.open();
  await unchanged(model, cold, async () => {
    assert.deepEqual(await readDiscoveryFinalAssessmentSessionAt(cold, 'p', reference(session)), kept);
    assert.deepEqual(await prepareDiscoveryFinalAssessmentSession(cold, 'p', packet.subject, input), kept);
  });
  cold.close();
  (session.value as any).state = 'paid'; session.value.envelope.input = '{}'; (session.value.limits as any).reply = 1;
  assert.deepEqual(await readDiscoveryFinalAssessmentSessionAt(model.store, 'p', reference(kept)), kept, 'a mutated answer never reaches a later read');
});

test('7a.3 session partial: a large request keeps its archive parts, read exactly; a capacity refusal writes nothing', async () => {
  await partialWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(partialFinal.dossier.manifest.ref, 'no_go'));
  const input = assessmentInput(negative);
  const staged = await stageDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, input);
  // One character less than the whole wire refuses before any archive, part or session is written.
  await unchanged(negative, negative.store, () => assert.rejects(() => prepareDiscoveryFinalAssessmentSession(negative.store, 'p', packet.subject,
    { ...input, limitChars: staged.envelope.input.length - 1 }), refusal('discovery_final_assessment_envelope_limit')));
  await unchanged(negative, negative.store, () => assert.rejects(() => prepareDiscoveryFinalAssessmentSession(negative.store, 'p', packet.subject,
    { ...input, resultLimitChars: 10 }), refusal()));
  // A failed session write leaves no half of the preparation: the archive and its parts belong to the same write.
  const previous = Store.prototype.writeMany;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === negative.store && writes.some(w => w.kind === DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND))
      throw new EngineError('injected_write_failure', 'The session write fails');
    return previous.call(this, writes, guards);
  } as typeof previous;
  try {
    await unchanged(negative, negative.store, () => assert.rejects(() => prepareDiscoveryFinalAssessmentSession(negative.store, 'p', packet.subject, input),
      refusal('injected_write_failure')));
  } finally { Store.prototype.writeMany = previous; }
  assert.equal(negative.store.get(staged.envelope.archive.id), null, 'no archive without its session');
  const { session } = await prepareSession(negative, packet, input);
  const archive = negative.store.get<any>(session.value.archive.id, session.value.archive.revision)!;
  assert.ok(archive.value.parts.length >= 1, 'the archive keeps its exact child parts');
  assert.ok(Array.isArray((session.value.envelope.packet as any).working.materialAddresses), 'the omitted original is addressed exactly');
  assert.equal(readArchiveBody(negative.store, archive).body.request.packet.final.assessment.value.result.result.verdict, 'return');
});

test('7a.3 session refusals: a distorted subject, environment, role, limit, saved value, wire, archive or part and a foreign project or ref refuse without writing', async () => {
  await ownerWorld(); await partialWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(partialFinal.dossier.manifest.ref, 'insufficient_evidence'));
  const { session, input } = await prepareSession(negative, packet);
  const foreign = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(ownerFinal.dossier.manifest.ref, 'go'));
  const ref = reference(session), part = negative.store.get<any>(session.value.archive.id, session.value.archive.revision)!.value.parts[0] as Ref;
  let reads = 0;
  const shifting = { ...input };
  Object.defineProperty(shifting, 'limitChars', { enumerable: true, get: () => reads++ === 0 ? input.limitChars : 1 });
  await unchanged(negative, negative.store, async () => {
    const altered = structuredClone(packet.subject) as any; altered.candidate.verdict.reason = 'A recomputed candidate';
    for (const subject of [altered, foreign.subject, { ...packet.subject, projectId: 'other' }, null])
      await assert.rejects(() => prepareDiscoveryFinalAssessmentSession(negative.store, 'p', subject, input), refusal(), 'subject');
    for (const bad of [{ ...input, environment: { ...input.environment, hash: '0'.repeat(64) } }, { ...input, environment: { ...input.environment, revision: 99 } },
      { ...input, role: structuredClone(negative.environment.value.implementer) }, { ...input, role: { ...input.role, effort: 'max' } },
      { ...input, limitChars: 0 }, { ...input, resultLimitChars: -1 }, { ...input, packetChars: input.limitChars }, { ...input, extra: true }])
      await assert.rejects(() => prepareDiscoveryFinalAssessmentSession(negative.store, 'p', packet.subject, bad), refusal(), JSON.stringify(Object.keys(bad)));
    for (const at of [{ ...ref, hash: '0'.repeat(64) }, { ...ref, revision: 2 }, { ...ref, id: `${ref.id}x` }, { ...ref, extra: 1 }, null])
      await assert.rejects(() => readDiscoveryFinalAssessmentSessionAt(negative.store, 'p', at), refusal());
    await assert.rejects(() => readDiscoveryFinalAssessmentSessionAt(negative.store, 'other', ref), refusal(), 'foreign project');
    for (const masked of [mask(negative.store, session.value.archive), mask(negative.store, part),
      mask(negative.store, partialFinal.subject.basis.brief.source), mask(negative.store, partialFinal.subject.basis.assessment),
      mask(negative.store, negative.environment)])
      await assert.rejects(() => readDiscoveryFinalAssessmentSessionAt(masked, 'p', ref), refusal());
  });
  // The one JSON snapshot: the input's limit is read once, so a later answer of 1 never reaches the preparation.
  assert.deepEqual(await prepareDiscoveryFinalAssessmentSession(negative.store, 'p', packet.subject, shifting), session);
  assert.equal(reads, 1, 'the preparation reads its external parameters once');
  // A saved value distorted in place (wire, limits, role or archive) under its own hash is never the exact preparation.
  for (const change of [(v: DiscoveryFinalAssessmentSession) => { v.envelope.input = v.envelope.input.replace('"prompt":"', '"prompt":"x'); v.envelope.measuredChars = v.envelope.input.length; },
    (v: DiscoveryFinalAssessmentSession) => { v.limits.reply += 1; v.input.resultLimitChars += 1; },
    (v: DiscoveryFinalAssessmentSession) => { v.role = structuredClone(negative.environment.value.implementer); v.input.role = structuredClone(v.role); },
    (v: DiscoveryFinalAssessmentSession) => { v.archive = { ...v.archive, hash: '0'.repeat(64) }; },
    (v: DiscoveryFinalAssessmentSession) => { (v as any).state = 'paid'; }]) {
    // The forgery even carries its own canonical identity, so only the comparison with the re-derived preparation refuses it.
    const value = structuredClone(session.value); change(value);
    const at = { id: `${DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND}:p:${hashJson(value as never)}`, revision: 1, hash: hashJson(value as never) };
    const forged = mask(negative.store, at, { ...session, ...at, value });
    await unchanged(negative, negative.store, () => assert.rejects(() => readDiscoveryFinalAssessmentSessionAt(forged, 'p', at),
      (error: unknown) => refusal()(error) && !/noncanonical identity|missing or has changed/.test(String((error as Error).message))));
  }
});

test('7a.3 session race: a second Store committing the same preparation first leaves one exact winner and no partial write', async () => {
  await partialWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(partialFinal.dossier.manifest.ref, 'go'));
  const input = { ...assessmentInput(negative), prompt: 'Assess the exact D7 bundle once, under a race.' };
  const other = negative.open(), previous = Store.prototype.writeMany, before = negative.store.lastEvent();
  let raced = false, restored = false;
  // Just before this Store commits its staged archive, parts and session, the other Store commits the very same rows.
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === negative.store && !raced && writes.some(w => w.kind === DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND)) {
      raced = true; previous.call(other, writes, guards);
    }
    return previous.call(this, writes, guards);
  } as typeof previous;
  const restore = () => { if (!restored) { restored = true; Store.prototype.writeMany = previous; } };
  let loser: Awaited<ReturnType<typeof prepareDiscoveryFinalAssessmentSession>>;
  try { loser = await prepareDiscoveryFinalAssessmentSession(negative.store, 'p', packet.subject, input); } finally { restore(); }
  assert.equal(raced, true);
  const winner = await readDiscoveryFinalAssessmentSessionAt(other, 'p', reference(loser));
  assert.deepEqual(loser, winner, 'the losing Store reads the same exact winner');
  assert.equal(negative.store.history(winner.id).length, 1);
  const written = events(negative.store, before);
  assert.ok(written.every(event => negative.store.history(event.id).length === 1), 'every archive, part and session row has one revision');
  assert.equal(written.filter(event => event.kind === DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND).length, 1);
  await unchanged(negative, other, async () => assert.deepEqual(await prepareDiscoveryFinalAssessmentSession(other, 'p', packet.subject, input), winner));
  other.close();
});

test('7a.3 session rich and packed: both contradiction sides stay in the session archive, and a session over an archive saved by the packing writes only itself', async () => {
  await ownerWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(richD6), candidate(richFinal.dossier.manifest.ref, 'no_go'));
  const input = { ...assessmentInput(owner), prompt: 'Assess the exact rich D7 bundle.' };
  const envelope = await prepareDiscoveryFinalAssessmentEnvelope(owner.store, 'p', packet.subject, input);
  const before = owner.store.lastEvent();
  const session = await prepareDiscoveryFinalAssessmentSession(owner.store, 'p', packet.subject, input);
  assert.deepEqual(events(owner.store, before).map(event => event.kind), [DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND]);
  assert.deepEqual(session.value.envelope, envelope);
  const dossier = readArchiveBody(owner.store, owner.store.get<any>(session.value.archive.id, session.value.archive.revision)!).body.request.packet.final.dossier;
  assert.ok(dossier.contradictions.length && dossier.contradictions.every((row: { sides: unknown[] }) => row.sides.length === 2));
  assert.deepEqual(dossier, richFinal.dossier);
});

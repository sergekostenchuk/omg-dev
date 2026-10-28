import { fixtureApplicableAxes } from './discovery-v7-fixture.js';
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
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
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
import { DISCOVERY_FINAL_ASSESSMENT_SUBJECT, DISCOVERY_FINAL_ASSESSMENT_PACKET,
  prepareDiscoveryFinalAssessmentSubject, requireDiscoveryFinalAssessmentSubject,
  requireDiscoveryFinalAssessmentPacket,
  type DiscoveryFinalAssessmentPacket } from '../src/discovery/discovery-final-assessment-subject.js';

// DR7 7a.3 (codex-omg №15332): the prepared D7 final-assessment subject over
// the accepted final subject. Real paid owner/model selected D6 and a nonempty
// partial as grounds; structural candidates of all four lawful outcomes are
// bound, never assessed or declared a paid D7 result.

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
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-7a3-' }), project = 'p', runs = new Map<string, string>();
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
  const industry = await deep(f, 'q-industry', fixtureApplicableAxes(f.v.draft).map(axis => claim(f, 'q-industry', axis, `Exact ${axis} evidence`)));
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
function assertAssessment(packet: DiscoveryFinalAssessmentPacket, manifest: Ref, outcome: string, final: DiscoveryFinalPacket) {
  assert.equal(packet.contract, DISCOVERY_FINAL_ASSESSMENT_PACKET);
  assert.equal(packet.subject.contract, DISCOVERY_FINAL_ASSESSMENT_SUBJECT);
  assert.equal(packet.subject.kind, 'final-assessment');
  assert.equal(packet.subject.projectId, 'p');
  assert.deepEqual(packet.candidate, packet.subject.candidate);
  assert.equal(packet.subject.candidate.verdict.outcome, outcome);
  assert.deepEqual(packet.candidate.dossier, manifest);
  assert.deepEqual(packet.subject.subject, final.subject);
  assert.deepEqual(packet.final, final);
  const { identity, ...basis } = packet.subject;
  assert.equal(identity, `discovery-final-assessment:${hashJson(basis as unknown as Json)}`);
  for (const key of ['paid', 'accepted', 'supported', 'verdict', 'result'] as const) {
    assert.equal(Object.hasOwn(packet.subject, key), false, `the subject carries no ${key} mark`);
    assert.equal(Object.hasOwn(packet, key), false, `the packet carries no ${key} mark`);
  }
}
const assessmentId = (subject: DiscoveryFinalAssessmentPacket['subject']) => {
  const { identity, ...basis } = subject;
  return `discovery-final-assessment:${hashJson(basis as unknown as Json)}`;
};

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

test('7a.3 owner: all four lawful candidate forms bind the exact paid D6 without becoming a paid D7 result', async () => {
  await ownerWorld();
  const manifest = ownerFinal.dossier.manifest.ref;
  await unchanged(owner, owner.store, async () => {
    for (const outcome of ['go', 'conditional', 'no_go', 'insufficient_evidence'] as const) {
      const packet = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(manifest, outcome));
      assertAssessment(packet, manifest, outcome, ownerFinal);
      assert.equal(packet.subject.candidate.verdict.outcome, outcome, 'the supported D6 verdict is never rewritten as the candidate outcome');
      const again = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(manifest, outcome));
      assert.deepEqual(again, packet, 'the same bound input yields the same deterministic subject');
      assert.notDeepEqual(assessmentId(packet.subject), assessmentId({ ...packet.subject,
        candidate: candidate(manifest, outcome === 'go' ? 'no_go' : 'go') }), 'a different bound candidate is a different subject');
    }
  });
  // A no_go or insufficient_evidence candidate over a supported D6 is lawful:
  // the D6 verdict is not translated into the D7 outcome.
  for (const outcome of ['no_go', 'insufficient_evidence'] as const)
    assertAssessment((await unchanged(owner, owner.store,
      () => prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(manifest, outcome))))!,
      manifest, outcome, ownerFinal);
});
test('7a.3 model: cold prepare and require reproduce the bound subject after late heads moved', async () => {
  await modelWorld();
  const final = await prepareDiscoveryFinalSubject(model.store, 'p', reference(modelD6));
  const manifest = final.dossier.manifest.ref;
  const packet = await prepareDiscoveryFinalAssessmentSubject(model.store, 'p', reference(modelD6), candidate(manifest, 'conditional'));
  assertAssessment(packet, manifest, 'conditional', final);
  assert.notEqual(packet.subject.identity, ownerFinal && assessmentId((await prepareDiscoveryFinalAssessmentSubject(
    owner.store, 'p', reference(ownerD6), candidate(ownerFinal.dossier.manifest.ref, 'conditional'))).subject));
  const store = model.open();
  await unchanged(model, store, async () => {
    assert.deepEqual(await prepareDiscoveryFinalAssessmentSubject(store, 'p', reference(modelD6), candidate(manifest, 'conditional')), packet);
    assert.deepEqual(await requireDiscoveryFinalAssessmentSubject(store, 'p', packet.subject), packet);
    assert.deepEqual(await requireDiscoveryFinalAssessmentPacket(store, 'p', packet), packet);
  });
});
test('7a.3 partial: a return D6 keeps nonempty material, reasons and unknowns beside the candidate', async () => {
  await partialWorld();
  const manifest = partialFinal.dossier.manifest.ref;
  assert.ok(partialFinal.dossier.materials.length); assert.ok(partialFinal.dossier.manifest.value.reasons.length);
  await unchanged(negative, negative.store, async () => {
    const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(manifest, 'conditional'));
    assertAssessment(packet, manifest, 'conditional', partialFinal);
    assert.equal(packet.final.assessment.value.result.result.verdict, 'return', 'a return D6 is never rewritten as no_go');
    assert.deepEqual(packet.final.dossier.manifest.value.reasons, partialFinal.dossier.manifest.value.reasons);
    const cold = negative.open();
    assert.deepEqual(await requireDiscoveryFinalAssessmentSubject(cold, 'p', packet.subject), packet);
    assert.deepEqual(await requireDiscoveryFinalAssessmentPacket(cold, 'p', packet), packet);
    cold.close();
  });
});
test('7a.3 forms: missing/null/extra fields, wrong contracts and malformed candidates refuse at their own doors', async () => {
  await partialWorld();
  const manifest = partialFinal.dossier.manifest.ref;
  await unchanged(negative, negative.store, async () => {
    for (const at of [null, undefined, {}, 'x', { ...reference(partialD6), hash: '0'.repeat(64) }, { ...reference(partialD6), revision: 0 }])
      await assert.rejects(() => prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', at, candidate(manifest, 'go')), e => e instanceof EngineError);
    const lawful = candidate(manifest, 'go'), packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), lawful);
    for (const at of [null, undefined, {}, { ...packet.subject, contract: 'unknown' }, { ...packet.subject, kind: 'final' },
      { ...packet.subject, projectId: 'other-yard' }, { ...packet.subject, mixed: true },
      (() => { const s: any = structuredClone(packet.subject); delete s.candidate; return s; })()])
      await assert.rejects(() => requireDiscoveryFinalAssessmentSubject(negative.store, 'p', at), e => e instanceof EngineError);
    // The candidate form itself: unsupported outcome, conditions on a go,
    // none on a conditional, a filled negative projection, an extra paid mark,
    // a missing or non-Ref dossier — the closed D7 form refuses them all.
    for (const bad of [
      { ...lawful, verdict: { outcome: 'supported', reason: 'x', conditions: [] } },
      { ...lawful, verdict: { outcome: 'go', reason: 'x', conditions: [{ id: 'c', kind: 'evidence', condition: 'x', criterion: 'y' }] } },
      { ...lawful, verdict: { outcome: 'conditional', reason: 'x', conditions: [] } },
      { ...candidate(manifest, 'no_go'), projection: { users: ['x'], payers: [], rules: [], externalSystems: [], unresolved: [] } },
      { ...candidate(manifest, 'no_go'), constitution: { goal: 'x', consumers: ['y'], nonGoals: ['z'], successCriterion: 'w' } },
      { ...lawful, paid: true }, { ...lawful, accepted: true },
      { ...lawful, dossier: null }, { ...lawful, dossier: { id: manifest.id } },
      { ...lawful, dossier: { ...manifest, hash: '0'.repeat(64) } }])
      await assert.rejects(() => prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), bad), e => e instanceof EngineError);
  });
});
test('7a.3 binding: a foreign manifest, a recomputed identity or a packet substitution is never proven', async () => {
  await ownerWorld(); await partialWorld();
  const manifest = partialFinal.dossier.manifest.ref, lawful = candidate(manifest, 'go');
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), lawful);
  const foreign = candidate(ownerFinal.dossier.manifest.ref, 'go');
  await unchanged(negative, negative.store, async () => {
    // A candidate bound to another world's manifest refuses at the dossier door.
    await assert.rejects(() => prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), foreign), e => e instanceof EngineError);
    // A partial dossier's root IS its manifest — that is the lawful binding.
    // The paid session, request and assessment records are no manifest.
    for (const at of [partialD6.value.session, partialD6.value.request, reference(partialD6)])
      await assert.rejects(() => prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6),
        candidate(at, 'go')), e => e instanceof EngineError);
    // A tampered bound subject plus its recomputed identity is not a proof:
    // the inner final subject is re-proven against the saved grounds, and a
    // candidate swapped for another manifest is caught at the dossier door.
    for (const change of [(v: any) => { v.subject.basis.brief.source = v.subject.basis.response; },
      (v: any) => { v.subject.basis.brief.selector.end--; }, (v: any) => { v.subject.dossier.manifest.hash = '0'.repeat(64); },
      (v: any) => { v.candidate.dossier = ownerFinal.dossier.manifest.ref; },
      (v: any) => { v.candidate.dossier = partialD6.value.session; }]) {
      const fake = structuredClone(packet.subject); change(fake);
      fake.identity = assessmentId(fake as never);
      await assert.rejects(() => requireDiscoveryFinalAssessmentSubject(negative.store, 'p', fake), e => e instanceof EngineError);
    }
    // A wrong address refuses before grounds are consulted.
    const wrong = structuredClone(packet.subject) as any; wrong.identity = `discovery-final-assessment:${'0'.repeat(64)}`;
    await assert.rejects(() => requireDiscoveryFinalAssessmentSubject(negative.store, 'p', wrong), e => e instanceof EngineError);
    // Packet substitutions: a candidate that is not the subject's own, a
    // dropped dossier material, a rewritten brief or a terminal record.
    for (const change of [(v: any) => { v.candidate = candidate(manifest, 'no_go'); },
      (v: any) => { v.candidate.verdict.outcome = 'no_go'; },
      (v: any) => { v.final.dossier.materials = []; },
      (v: any) => { v.final.brief.text = 'caller text'; },
      (v: any) => { delete v.final.terminal.response; },
      (v: any) => { v.paid = true; }]) {
      const fake = structuredClone(packet); change(fake);
      await assert.rejects(() => requireDiscoveryFinalAssessmentPacket(negative.store, 'p', fake), e => e instanceof EngineError);
    }
    for (const key of ['contract', 'subject', 'candidate', 'final'] as const) {
      const fake: any = structuredClone(packet); delete fake[key];
      await assert.rejects(() => requireDiscoveryFinalAssessmentPacket(negative.store, 'p', fake), e => e instanceof EngineError);
    }
  });
});
test('7a.3 grounds: lost brief, paid or manifest grounds refuse without writing', async () => {
  await partialWorld();
  await unchanged(negative, negative.store, async () => {
    for (const at of [partialFinal.brief.observation.source, reference(partialFinal.brief.fact), reference(partialFinal.brief.acceptance),
      partialD6.value.session, partialD6.value.request, partialD6.value.response, partialFinal.dossier.manifest.ref])
      await assert.rejects(() => prepareDiscoveryFinalAssessmentSubject(mask(negative.store, at), 'p', reference(partialD6),
        candidate(partialFinal.dossier.manifest.ref, 'go')), e => e instanceof EngineError);
  });
});
test('7a.3 rich: a return D6 keeps rejected/unassessed material and both blocking sides next to the candidate', async () => {
  await ownerWorld();
  const manifest = richFinal.dossier.manifest.ref;
  assert.ok(richFinal.dossier.contradictions.length); assert.ok(richFinal.dossier.unknowns.length);
  const packet = (await unchanged(owner, owner.store,
    () => prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(richD6), candidate(manifest, 'no_go'))))!;
  assertAssessment(packet, manifest, 'no_go', richFinal);
  assert.ok(packet.final.dossier.materials.some(m => m.status === 'rejected'));
  assert.ok(packet.final.dossier.materials.some(m => m.status === 'unassessed'));
  assert.ok(packet.final.dossier.contradictions.every(row => row.sides.length === 2));
  await unchanged(owner, owner.store, async () => {
    assert.deepEqual(await requireDiscoveryFinalAssessmentPacket(owner.store, 'p', packet), packet);
    // A truncated blocking side is never accepted as the proven packet.
    const oneSided = structuredClone(packet); oneSided.final.dossier.contradictions[0]!.sides.pop();
    await assert.rejects(() => requireDiscoveryFinalAssessmentPacket(owner.store, 'p', oneSided), e => e instanceof EngineError);
    const cold = owner.open();
    assert.deepEqual(await requireDiscoveryFinalAssessmentPacket(cold, 'p', packet), packet);
    cold.close();
  });
});
test('7a.3 isolation: mutating returned objects never rewrites the proven input', async () => {
  await partialWorld();
  const manifest = partialFinal.dossier.manifest.ref;
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(manifest, 'conditional'));
  const clone = structuredClone(packet);
  packet.candidate.verdict.reason = 'mutated'; (packet.subject.candidate as any).verdict.outcome = 'no_go';
  (packet.final.brief as any).text = 'mutated'; (packet.subject.subject as any).dossier.manifest = { ref: null };
  (packet.subject as any).paid = true;
  await unchanged(negative, negative.store, async () => {
    assert.deepEqual(await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(manifest, 'conditional')), clone);
    assert.deepEqual(await requireDiscoveryFinalAssessmentPacket(negative.store, 'p', clone), clone);
  });
});

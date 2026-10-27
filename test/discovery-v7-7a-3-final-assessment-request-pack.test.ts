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
import { DISCOVERY_FINAL_ASSESSMENT_RESULT, projectDiscoveryFinalAssessment,
  type DiscoveryFinalAssessmentAddress, type DiscoveryFinalAssessmentResult } from '../src/discovery/discovery-final-assessment-result.js';
import { prepareDiscoveryFinalAssessmentTransport, checkDiscoveryFinalAssessmentReply } from '../src/discovery/discovery-final-assessment-request.js';
import { DISCOVERY_FINAL_ASSESSMENT_ENVELOPE, prepareDiscoveryFinalAssessmentEnvelope, requireDiscoveryFinalAssessmentEnvelope,
  stageDiscoveryFinalAssessmentEnvelope, type DiscoveryFinalAssessmentEnvelopeInput } from '../src/discovery/discovery-final-assessment-packing.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';
import { RESULT_CAPACITY_REFUSAL } from '../src/discovery/early-research-outcome.js';

// DR7 7a.3 (codex-omg2 №15531): the complete request to the D7 assessor, its physical envelope through the common
// archive/delivery helpers and the check of the terminal reply through the accepted RESULT. The paid D6 worlds below
// are the subject test's own real lines (owner/model selected, partial, rich).

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
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-7a3p-' }), project = 'p', runs = new Map<string, string>();
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


/** A lawful assessor answer over the exact prepared subject: reasons, bases in the candidate and the proven
 * grounds, and for a return the exact places it sends back. */
function answer(packet: DiscoveryFinalAssessmentPacket, verdict: 'supported' | 'return',
  targets: DiscoveryFinalAssessmentAddress[] = [{ candidate: '/summary' }]): DiscoveryFinalAssessmentResult {
  const bases: DiscoveryFinalAssessmentAddress[] = [{ candidate: '/verdict/reason' }, { record: packet.final.dossier.manifest.ref },
    { record: packet.final.subject.basis.brief.source }];
  return { contract: DISCOVERY_FINAL_ASSESSMENT_RESULT, subject: structuredClone(packet.subject), verdict,
    reasons: [verdict === 'supported' ? 'The bundle follows the dossier and the verbatim assignment' : 'The summary is not grounded in the dossier'],
    bases, return: verdict === 'return' ? { targets, reason: 'Return to the summary at the named places', bases } : null };
}

const RESULT_LIMIT = 10_000_000;
function assessmentInput(f: Paid, packetChars = 24_000): DiscoveryFinalAssessmentEnvelopeInput {
  return { prompt: 'Assess the exact D7 bundle against the saved dossier and the verbatim assignment.',
    packetChars, limitChars: 400_000, resultLimitChars: RESULT_LIMIT,
    environment: reference(f.environment), role: structuredClone(f.environment.value.reviewer) };
}
const refusal = (code?: string) => (error: unknown) => error instanceof EngineError && (!code || error.code === code);
/** Prepare the envelope once: only the archive and its parts are written, nothing is paid or sent; the archive keeps
 * the whole request, the wire carries the assessor role, the prompt, the schema and the result capacity. */
async function prepared(f: Paid, packet: DiscoveryFinalAssessmentPacket, input = assessmentInput(f)) {
  const before = f.store.lastEvent(), calls = money(f.store), wire = f.wires();
  const envelope = await prepareDiscoveryFinalAssessmentEnvelope(f.store, 'p', packet.subject, input);
  const events = f.store.eventsPage(before, f.store.lastEvent(), 1000);
  assert.ok(events.length > 0 && events.every(event => ['request-part', 'research-context'].includes(event.kind)),
    events.map(event => event.kind).join(','));
  assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
  assert.equal(envelope.contract, DISCOVERY_FINAL_ASSESSMENT_ENVELOPE);
  assert.deepEqual(envelope.subject, packet.subject);
  assert.equal(envelope.input.length, envelope.measuredChars); assert.ok(envelope.measuredChars <= input.limitChars);
  const wireInput = JSON.parse(envelope.input);
  assert.equal(wireInput.protocol, 'omg-agent/v1'); assert.equal(wireInput.model, input.role.model);
  assert.equal(wireInput.effort, input.role.effort); assert.equal(wireInput.prompt, input.prompt);
  assert.deepEqual(wireInput.subject.resultCapacity, envelope.capacity);
  assert.deepEqual(wireInput.subject.schema, envelope.packet.schema);
  assert.equal(envelope.capacity.role, 'assessor');
  assert.ok('archive' in envelope.capacity.mandatory);
  const archive = f.store.get<any>(envelope.archive.id, envelope.archive.revision)!;
  const original = readArchiveBody(f.store, archive).body.request;
  assert.deepEqual(original.packet, packet, 'the archive keeps the whole proven packet: candidate, assignment, paid D6, material');
  assert.deepEqual(original.subject, packet.subject); assert.deepEqual(original.schema, envelope.packet.schema);
  for (const key of ['paid', 'accepted', 'session', 'result']) assert.equal(Object.hasOwn(envelope, key), false);
  // A repeat writes nothing more and reads the same exact addresses.
  assert.deepEqual(await unchanged(f, f.store, () => prepareDiscoveryFinalAssessmentEnvelope(f.store, 'p', packet.subject, input)), envelope);
  return { envelope, input, original, archive };
}

test('7a.3 request owner: four lawful candidates prepare the whole request once and a supported or addressed return reply is checked by RESULT', async () => {
  await ownerWorld();
  const manifest = ownerFinal.dossier.manifest.ref;
  for (const outcome of ['go', 'conditional', 'no_go', 'insufficient_evidence'] as const) {
    const packet = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(manifest, outcome));
    const { envelope } = await prepared(owner, packet);
    for (const verdict of ['supported', 'return'] as const) {
      const reply = answer(packet, verdict, [{ candidate: '/summary' }, { record: ownerFinal.subject.basis.response }]);
      const checked = (await unchanged(owner, owner.store, () =>
        checkDiscoveryFinalAssessmentReply(owner.store, 'p', packet.subject, RESULT_LIMIT, envelope.capacity, reply)))!;
      assert.deepEqual(checked.projection, projectDiscoveryFinalAssessment({ packet, result: reply }), 'the one RESULT projector decides the reply');
      assert.deepEqual(checked.normalized, reply); assert.equal(checked.terminal, true); assert.ok(checked.measurement.fits);
      assert.deepEqual([checked.projection.candidateOutcome, checked.projection.verdict], [outcome, verdict]);
    }
  }
});

test('7a.3 request model: a cold Store after late heads proves the same envelope and reply, and returned data is isolated', async () => {
  await modelWorld();
  const final = await prepareDiscoveryFinalSubject(model.store, 'p', reference(modelD6));
  const packet = await prepareDiscoveryFinalAssessmentSubject(model.store, 'p', reference(modelD6), candidate(final.dossier.manifest.ref, 'conditional'));
  const { envelope, input } = await prepared(model, packet), reply = answer(packet, 'supported');
  const kept = structuredClone(envelope);
  const cold = model.open();
  await unchanged(model, cold, async () => {
    assert.deepEqual(await requireDiscoveryFinalAssessmentEnvelope(cold, 'p', packet.subject, input, envelope), envelope);
    assert.deepEqual(await prepareDiscoveryFinalAssessmentEnvelope(cold, 'p', packet.subject, input), envelope);
    const checked = await checkDiscoveryFinalAssessmentReply(cold, 'p', packet.subject, RESULT_LIMIT, envelope.capacity, reply);
    assert.deepEqual(checked.normalized, reply);
  });
  cold.close();
  (envelope.packet as any).request = null; (envelope.capacity as any).role = 'analyst'; (envelope as any).input = '{}';
  assert.deepEqual(await prepareDiscoveryFinalAssessmentEnvelope(model.store, 'p', packet.subject, input), kept,
    'a mutated returned envelope never reaches a later read');
});

test('7a.3 request partial: a large request is sent as positive addressed fragments with exact child pages of the whole archive', async () => {
  await partialWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(partialFinal.dossier.manifest.ref, 'no_go'));
  const { envelope, original, archive } = await prepared(negative, packet, assessmentInput(negative, 24_000));
  const whole = JSON.stringify(original).length;
  assert.ok(whole > 24_000, `the proven request (${whole}) exceeds the packet share`);
  assert.ok(Array.isArray(archive.value.parts) && archive.value.parts.length >= 1, 'the archive keeps its exact child parts');
  const working = (envelope.packet as any).working, delivery = (envelope.packet as any).materialDelivery;
  assert.ok(Array.isArray(working.materialAddresses) && working.materialAddresses.length >= 1, 'the omitted original is addressed exactly');
  assert.deepEqual(working.archive, envelope.archive);
  for (const fragment of delivery ?? []) {
    assert.deepEqual(fragment.original.record, envelope.archive);
    assert.ok(fragment.served.end > fragment.served.offset, 'a delivered fragment is positive');
    assert.ok(fragment.served.end - fragment.served.offset < fragment.served.total, 'a fragment is never presented as the whole');
  }
  assert.equal(Object.hasOwn(envelope.packet, 'request') && JSON.stringify((envelope.packet as any).request).length >= whole, false,
    'the full request is not inlined beyond its share');
  assert.equal(original.packet.final.assessment.value.result.result.verdict, 'return', 'the paid D6 return is kept');
  assert.deepEqual(original.packet.final.dossier.manifest.value.reasons, partialFinal.dossier.manifest.value.reasons);
});

test('7a.3 request bounds: the exact wire and the exact reply limit fit, one character less refuses, before any archive write', async () => {
  await partialWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(partialFinal.dossier.manifest.ref, 'go'));
  const input = { ...assessmentInput(negative), resultLimitChars: RESULT_LIMIT - 1 };
  await unchanged(negative, negative.store, async () => {
    const staged = await stageDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, input);
    assert.ok(staged.writes.some(write => write.kind === 'research-context'), 'a fresh archive is only staged');
    const length = staged.envelope.input.length;
    assert.equal((await stageDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, { ...input, limitChars: length })).envelope.input.length, length);
    await assert.rejects(() => prepareDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, { ...input, limitChars: length - 1 }),
      refusal('discovery_final_assessment_envelope_limit'));
  });
  // The reply bound is the result admission, apart from the wire: its exact limit fits and one less refuses.
  const reply = answer(packet, 'return', [{ partialReason: 0 }]);
  let limit = 1_000_000;
  for (let i = 0; i < 4; i++) {
    const transport = await prepareDiscoveryFinalAssessmentTransport(negative.store, 'p', packet.subject, limit);
    const required = transport.capacity.forms[0]!.minimumChars + JSON.stringify(reply).length;
    if (required === limit) break; limit = required;
  }
  await unchanged(negative, negative.store, async () => {
    const exact = await prepareDiscoveryFinalAssessmentTransport(negative.store, 'p', packet.subject, limit);
    assert.ok((await checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, limit, exact.capacity, reply)).measurement.fits);
    const less = await prepareDiscoveryFinalAssessmentTransport(negative.store, 'p', packet.subject, limit - 1);
    await assert.rejects(() => checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, limit - 1, less.capacity, reply),
      refusal(RESULT_CAPACITY_REFUSAL));
    await assert.rejects(() => checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, limit - 1, exact.capacity, reply),
      refusal(), 'a capacity of another limit is not this admission');
    // FINAL-ASSESSMENT-PACK-01: a capacity whose limit answers limit−1 to the check and the large limit afterwards is the
    // same lawful −1 refusal — the check and the measurement read one snapshot.
    await assert.rejects(() => checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, limit - 1,
      shifting(less.capacity, limit - 1, RESULT_LIMIT), reply), refusal(RESULT_CAPACITY_REFUSAL), 'inline shifting limit');
  });
  // The archived admission has its own exact bound: it fits, one less refuses, and the shifting limit refuses the same way.
  let archived = 1_000_000;
  for (let i = 0; i < 4; i++) {
    const staged = await stageDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, { ...input, resultLimitChars: archived });
    const required = staged.envelope.capacity.forms[0]!.minimumChars + JSON.stringify(reply).length;
    if (required === archived) break; archived = required;
  }
  const fitting = await prepareDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, { ...input, resultLimitChars: archived });
  const short = await prepareDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, { ...input, resultLimitChars: archived - 1 });
  assert.ok('archive' in fitting.capacity.mandatory && 'archive' in short.capacity.mandatory);
  await unchanged(negative, negative.store, async () => {
    assert.ok((await checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, archived, fitting.capacity, reply)).measurement.fits);
    await assert.rejects(() => checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, archived - 1, short.capacity, reply),
      refusal(RESULT_CAPACITY_REFUSAL));
    await assert.rejects(() => checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, archived - 1,
      shifting(short.capacity, archived - 1, RESULT_LIMIT), reply), refusal(RESULT_CAPACITY_REFUSAL), 'archived shifting limit');
  });
});
/** A capacity whose enumerable limit answers `first` on its first read and `later` on every read after it. */
function shifting(capacity: unknown, first: number, later: number) {
  const copy = structuredClone(capacity) as Record<string, unknown>;
  let reads = 0;
  delete copy.envelopeLimitChars;
  Object.defineProperty(copy, 'envelopeLimitChars', { enumerable: true, configurable: true, get: () => reads++ === 0 ? first : later });
  return copy;
}

test('7a.3 request refusals: foreign role or subject, missing or substituted archive parts, rehashed capacity and a broken reply refuse hot and cold', async () => {
  await ownerWorld(); await partialWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(partialFinal.dossier.manifest.ref, 'insufficient_evidence'));
  const { envelope, input, archive } = await prepared(negative, packet, assessmentInput(negative, 24_000));
  const ownerPacket = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(ownerFinal.dossier.manifest.ref, 'go'));
  const reply = answer(packet, 'supported');
  const part = archive.value.parts[0] as Ref;
  await unchanged(negative, negative.store, async () => {
    for (const bad of [{ ...input, role: structuredClone(negative.environment.value.implementer) },
      { ...input, role: { ...input.role, model: 'foreign-model' } }, { ...input, environment: { ...input.environment, hash: '0'.repeat(64) } },
      { ...input, limitChars: 0 }, { ...input, packetChars: input.limitChars }, { ...input, prompt: ' ' }, { ...input, extra: true }])
      await assert.rejects(() => prepareDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, bad), refusal(), JSON.stringify(Object.keys(bad)));
    await assert.rejects(() => prepareDiscoveryFinalAssessmentEnvelope(negative.store, 'p', ownerPacket.subject, input), refusal(), 'another world\'s subject');
    for (const change of [(v: any) => { v.packet.schema.properties.verdict = { enum: ['supported'] }; }, (v: any) => { delete v.packet.schema; },
      (v: any) => { v.subject = ownerPacket.subject; }, (v: any) => { v.input = v.input.replace('"assessor"', '"analyst"'); v.measuredChars = v.input.length; },
      (v: any) => { v.archive = { ...v.archive, hash: '0'.repeat(64) }; }, (v: any) => { v.capacity.envelopeLimitChars++; }, (v: any) => { v.paid = true; }]) {
      const fake = structuredClone(envelope) as any; change(fake);
      await assert.rejects(() => requireDiscoveryFinalAssessmentEnvelope(negative.store, 'p', packet.subject, input, fake), refusal());
    }
    // A broken assessor reply is refused by the one RESULT decoder.
    for (const broken of [{ ...reply, verdict: 'go' }, { ...reply, subject: ownerPacket.subject }, { ...reply, bases: [{ candidate: '/missing' }] },
      { ...reply, return: { targets: [], reason: 'x', bases: reply.bases } }, { ...reply, extra: 1 }])
      await assert.rejects(() => checkDiscoveryFinalAssessmentReply(negative.store, 'p', packet.subject, RESULT_LIMIT, envelope.capacity, broken),
        refusal(), JSON.stringify(Object.keys(broken)));
  });
  const coldStore = negative.open();
  for (const store of [negative.store, coldStore]) await unchanged(negative, store, async () => {
    // The transport's own archive and part, hot and cold; the shared D6 grounds once, on the hot Store (the subject
    // and RESULT files hold their other doors).
    const grounds = store === negative.store ? [partialFinal.subject.basis.brief.source, partialFinal.subject.basis.assessment,
      partialFinal.subject.basis.response] : [];
    for (const ref of [envelope.archive, part, ...grounds]) {
      const masked = mask(store, ref);
      await assert.rejects(() => requireDiscoveryFinalAssessmentEnvelope(masked, 'p', packet.subject, input, envelope), refusal());
      await assert.rejects(() => checkDiscoveryFinalAssessmentReply(masked, 'p', packet.subject, RESULT_LIMIT, envelope.capacity, reply), refusal());
    }
    const savedPart = store.get<any>(part.id, part.revision)!, value = { ...savedPart.value, text: savedPart.value.text + 'x' };
    const substituted = mask(store, part, { ...savedPart, value, hash: hashJson(value) });
    await assert.rejects(() => requireDiscoveryFinalAssessmentEnvelope(substituted, 'p', packet.subject, input, envelope), refusal());
    await assert.rejects(() => checkDiscoveryFinalAssessmentReply(substituted, 'p', packet.subject, RESULT_LIMIT, envelope.capacity, reply), refusal());
    for (const mutate of [(x: any) => { x.mandatory.archive.record.hash = '0'.repeat(64); }, (x: any) => { x.mandatory.archive.pointer = '/body/foreign'; },
      (x: any) => { x.mandatory.archive.hash = '0'.repeat(64); }, (x: any) => { x.bindings.finalAssessmentSubject = ownerPacket.subject; },
      (x: any) => { x.role = 'synthesizer'; }, (x: any) => { delete x.mandatory; }]) {
      const capacity: any = structuredClone(envelope.capacity); mutate(capacity);
      await assert.rejects(() => checkDiscoveryFinalAssessmentReply(store, 'p', packet.subject, RESULT_LIMIT, capacity, reply), refusal());
    }
  });
  coldStore.close();
});

test('7a.3 request rich: both sides of every contradiction, rejected and unassessed material and unknowns stay in the archived request', async () => {
  await ownerWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(richD6), candidate(richFinal.dossier.manifest.ref, 'no_go'));
  const { envelope, original } = await prepared(owner, packet);
  const dossier = original.packet.final.dossier;
  assert.deepEqual(dossier, richFinal.dossier, 'the whole paid D6 dossier is in the request');
  assert.ok(dossier.contradictions.length && dossier.contradictions.every((row: { sides: unknown[] }) => row.sides.length === 2));
  assert.ok(dossier.materials.some((m: { status: string }) => m.status === 'rejected'));
  assert.ok(dossier.materials.some((m: { status: string }) => m.status === 'unassessed'));
  assert.ok(dossier.unknowns.length);
  const relation = dossier.contradictions[0]!;
  const reply = answer(packet, 'return', [{ contradiction: relation.contradiction.id }, { claim: relation.sides[1].address }]);
  const checked = await unchanged(owner, owner.store, () =>
    checkDiscoveryFinalAssessmentReply(owner.store, 'p', packet.subject, RESULT_LIMIT, envelope.capacity, reply));
  assert.deepEqual(checked!.normalized, reply);
});

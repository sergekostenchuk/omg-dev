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
import { DISCOVERY_FINAL_ASSESSMENT_RESULT, DISCOVERY_FINAL_ASSESSMENT_PROJECTION, checkDiscoveryFinalAssessmentResult,
  decodeDiscoveryFinalAssessmentResult, projectDiscoveryFinalAssessment,
  type DiscoveryFinalAssessmentAddress, type DiscoveryFinalAssessmentResult } from '../src/discovery/discovery-final-assessment-result.js';

// DR7 7a.3 (codex-omg2 №15478): the closed answer of the D7 assessor, its pure projection and the read-only
// checked door, over the accepted final-assessment subject. The paid D6 worlds below are the subject test's own
// real lines (owner/model selected, partial, rich); this file adds no fixture of its own beyond the answers.

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
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-7a3r-' }), project = 'p', runs = new Map<string, string>();
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
const refusal = (error: unknown) => error instanceof EngineError;
function assertProjection(projection: Awaited<ReturnType<typeof checkDiscoveryFinalAssessmentResult>>,
  packet: DiscoveryFinalAssessmentPacket, result: DiscoveryFinalAssessmentResult) {
  assert.equal(projection.contract, DISCOVERY_FINAL_ASSESSMENT_PROJECTION);
  assert.deepEqual(projection.subject, packet.subject);
  assert.deepEqual(projection.candidate, packet.candidate, 'the whole candidate is kept');
  assert.deepEqual(projection.packet, packet, 'the whole proven packet is kept: assignment, paid D6, material, unknowns, contradictions');
  assert.deepEqual(projection.result, result);
  assert.equal(projection.candidateOutcome, packet.candidate.verdict.outcome, 'the D7 outcome stays the candidate\'s own');
  assert.equal(projection.verdict, result.verdict, 'the assessor verdict stands beside it');
  const { identity, ...value } = projection;
  assert.equal(identity, `discovery-final-assessment-projection:${hashJson(value as unknown as Json)}`);
  for (const key of ['paid', 'accepted', 'application', 'session', 'manifest', 'call'])
    assert.equal(Object.hasOwn(projection, key), false, `the structural answer carries no ${key}`);
  assert.deepEqual(projectDiscoveryFinalAssessment({ packet, result }), projection, 'the checked door is the pure projector over the re-proven packet');
}

test('7a.3 result owner: supported and an addressed return over all four lawful candidates project the whole packet without writing or paying', async () => {
  await ownerWorld();
  const manifest = ownerFinal.dossier.manifest.ref;
  for (const outcome of ['go', 'conditional', 'no_go', 'insufficient_evidence'] as const) {
    const packet = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(manifest, outcome));
    for (const verdict of ['supported', 'return'] as const) {
      const result = answer(packet, verdict, [{ candidate: '/summary' }, { candidate: '/verdict/conditions' },
        { record: reference(ownerD6) }, { record: ownerFinal.subject.basis.response }]);
      const projection = (await unchanged(owner, owner.store, () => checkDiscoveryFinalAssessmentResult(owner.store, 'p', packet.subject, result)))!;
      assertProjection(projection, packet, result);
    }
  }
  // A grounded negative bundle is supported as it is: the assessor never rewrites no_go into a go.
  const negativeBundle = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(manifest, 'no_go'));
  const supported = await checkDiscoveryFinalAssessmentResult(owner.store, 'p', negativeBundle.subject, answer(negativeBundle, 'supported'));
  assert.deepEqual([supported.candidateOutcome, supported.verdict], ['no_go', 'supported']);
});

test('7a.3 result model: a cold Store after late heads gives the same projection, and returned data is isolated', async () => {
  await modelWorld();
  const final = await prepareDiscoveryFinalSubject(model.store, 'p', reference(modelD6));
  const packet = await prepareDiscoveryFinalAssessmentSubject(model.store, 'p', reference(modelD6), candidate(final.dossier.manifest.ref, 'conditional'));
  const result = answer(packet, 'return', [{ candidate: '/verdict/conditions/1/options/0' }, { candidate: '/projection/users/0' },
    { candidate: '/constitution/nonGoals' }]);
  const hot = await checkDiscoveryFinalAssessmentResult(model.store, 'p', packet.subject, result);
  const cold = model.open();
  const coldProjection = (await unchanged(model, cold, () => checkDiscoveryFinalAssessmentResult(cold, 'p', packet.subject, result)))!;
  cold.close();
  assert.deepEqual(coldProjection, hot);
  const kept = structuredClone(hot);
  hot.candidate.verdict.reason = 'mutated'; (hot.packet.final.brief as any).text = 'mutated'; hot.result.reasons.push('mutated');
  (hot.result.return as any).targets = []; (result as any).verdict = 'supported';
  const again = await checkDiscoveryFinalAssessmentResult(model.store, 'p', packet.subject, answer(packet, 'return',
    [{ candidate: '/verdict/conditions/1/options/0' }, { candidate: '/projection/users/0' }, { candidate: '/constitution/nonGoals' }]));
  assert.deepEqual(again, kept, 'neither a mutated projection nor a mutated input answer reaches a later read');
});

test('7a.3 result partial: a return D6 keeps its material and partial reasons, and a return addresses them exactly', async () => {
  await partialWorld();
  const manifest = partialFinal.dossier.manifest.ref, dossier = partialFinal.dossier;
  assert.ok(dossier.materials.length && dossier.manifest.value.reasons.length);
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(manifest, 'insufficient_evidence'));
  const axes = Object.keys((dossier.manifest.value as { axes?: Record<string, unknown> }).axes ?? {});
  const targets: DiscoveryFinalAssessmentAddress[] = [{ partialReason: 0 }, { claim: dossier.materials[0]!.address },
    { record: partialD6.value.session }, { record: reference(partialFinal.brief.fact) }, ...axes.slice(0, 1).map(axis => ({ axis }))];
  const result = answer(packet, 'return', targets);
  const projection = (await unchanged(negative, negative.store, () => checkDiscoveryFinalAssessmentResult(negative.store, 'p', packet.subject, result)))!;
  assertProjection(projection, packet, result);
  assert.equal(projection.packet.final.assessment.value.result.result.verdict, 'return', 'the paid D6 return is kept, not rewritten');
  assert.deepEqual(projection.packet.final.dossier.manifest.value.reasons, dossier.manifest.value.reasons);
  assert.deepEqual(projection.packet.final.dossier.materials, dossier.materials);
  assert.equal(projection.packet.final.brief.text, partialFinal.brief.text, 'the verbatim assignment is kept');
});

test('7a.3 result rich: both sides of a contradiction and an unknown are addressable, and the projection keeps both sides', async () => {
  await ownerWorld();
  const dossier = richFinal.dossier, relation = dossier.contradictions[0]!;
  assert.ok(relation && dossier.unknowns.length);
  const packet = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(richD6), candidate(dossier.manifest.ref, 'no_go'));
  const result = answer(packet, 'return', [{ contradiction: relation.contradiction.id }, { claim: relation.sides[0].address },
    { claim: relation.sides[1].address }, { unknown: dossier.unknowns[0]!.unknown.claim }]);
  const projection = (await unchanged(owner, owner.store, () => checkDiscoveryFinalAssessmentResult(owner.store, 'p', packet.subject, result)))!;
  assertProjection(projection, packet, result);
  assert.ok(projection.packet.final.dossier.contradictions.every(row => row.sides.length === 2));
  assert.ok(projection.packet.final.dossier.materials.some(m => m.status === 'rejected'));
});

test('7a.3 result forms: missing, null, unknown and extra fields, foreign or absent places and another subject refuse without writing', async () => {
  await ownerWorld(); await partialWorld();
  const manifest = partialFinal.dossier.manifest.ref;
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(manifest, 'conditional'));
  const lawful = answer(packet, 'return');
  const foreign = await prepareDiscoveryFinalAssessmentSubject(owner.store, 'p', reference(ownerD6), candidate(ownerFinal.dossier.manifest.ref, 'conditional'));
  const ownerClaim = ownerFinal.dossier.materials[0]!.address;
  const changes: [string, (v: any) => void][] = [
    ...(['contract', 'subject', 'verdict', 'reasons', 'bases', 'return'] as const).flatMap(key => [
      [`missing ${key}`, (v: any) => { delete v[key]; }], [`null ${key}`, (v: any) => { v[key] = null; }]] as [string, (v: any) => void][])
      .filter(([name]) => name !== 'null return'),
    ['extra field', v => { v.paid = true; }], ['contract', v => { v.contract = 'discovery-final-assessment-result/v2'; }],
    ['D7 outcome as verdict', v => { v.verdict = 'no_go'; }], ['accepted verdict', v => { v.verdict = 'accepted'; }],
    ['no reasons', v => { v.reasons = []; }], ['empty reason', v => { v.reasons = [' ']; }], ['duplicate reasons', v => { v.reasons = ['a', 'a']; }],
    ['no bases', v => { v.bases = []; }], ['duplicate bases', v => { v.bases = [v.bases[0], v.bases[0]]; }],
    ['supported with a return', v => { v.verdict = 'supported'; }], ['return without targets', v => { v.return.targets = []; }],
    ['return without reason', v => { v.return.reason = ''; }], ['return extra field', v => { v.return.severity = 'high'; }],
    ['missing return bases', v => { delete v.return.bases; }], ['return null', v => { v.return = null; }],
    ['absent pointer', v => { v.return.targets = [{ candidate: '/summary/missing' }]; }],
    ['relative pointer', v => { v.return.targets = [{ candidate: 'summary' }]; }],
    ['array index past end', v => { v.return.targets = [{ candidate: '/verdict/conditions/9' }]; }],
    ['foreign record', v => { v.bases = [{ record: reference(ownerD6) }]; }],
    ['changed record hash', v => { v.bases = [{ record: { ...manifest, hash: '0'.repeat(64) } }]; }],
    ['record with extra field', v => { v.bases = [{ record: { ...manifest, kind: 'manifest' } }]; }],
    ['foreign claim', v => { v.return.targets = [{ claim: ownerClaim }]; }],
    ['unknown not in dossier', v => { v.return.targets = [{ unknown: ownerClaim }]; }],
    ['unknown contradiction', v => { v.return.targets = [{ contradiction: 'no-such-contradiction' }]; }],
    ['partial reason past end', v => { v.return.targets = [{ partialReason: 99 }]; }],
    ['negative partial reason', v => { v.return.targets = [{ partialReason: -1 }]; }],
    ['fractional partial reason', v => { v.return.targets = [{ partialReason: 0.5 }]; }],
    ['unknown axis', v => { v.return.targets = [{ axis: 'no-such-axis' }]; }],
    ['two places in one address', v => { v.return.targets = [{ candidate: '/summary', partialReason: 0 }]; }],
    ['unknown address kind', v => { v.return.targets = [{ hint: '/summary' }]; }],
    ['another subject', v => { v.subject = structuredClone(foreign.subject); }],
    ['truncated candidate in subject', v => { delete v.subject.candidate.summary; }],
    ['another candidate outcome', v => { v.subject.candidate.verdict.outcome = 'go'; v.subject.candidate.verdict.conditions = []; }],
    ['recomputed identity', v => { v.subject.identity = `discovery-final-assessment:${'0'.repeat(64)}`; }],
    ['a getter answer', v => { Object.defineProperty(v, 'verdict', { enumerable: true, get: () => { throw new Error('not plain data'); } }); }],
  ];
  // Each refusal names its own field: the expected code and field of every case.
  const expected: Record<string, [string, string]> = {
    'missing contract': ['result_invalid', 'result.contract'],
    'null contract': ['result_invalid', 'contract'],
    'missing subject': ['result_invalid', 'result.subject'],
    'null subject': ['mismatch', 'subject'],
    'missing verdict': ['result_invalid', 'result.verdict'],
    'null verdict': ['result_invalid', 'verdict'],
    'missing reasons': ['result_invalid', 'result.reasons'],
    'null reasons': ['result_invalid', 'reasons'],
    'missing bases': ['result_invalid', 'result.bases'],
    'null bases': ['result_invalid', 'bases'],
    'missing return': ['result_invalid', 'result.return'],
    'extra field': ['result_invalid', 'result.paid'],
    'contract': ['result_invalid', 'contract'],
    'D7 outcome as verdict': ['result_invalid', 'verdict'],
    'accepted verdict': ['result_invalid', 'verdict'],
    'no reasons': ['result_invalid', 'reasons'],
    'empty reason': ['result_invalid', 'reasons.0'],
    'duplicate reasons': ['result_invalid', 'reasons'],
    'no bases': ['result_invalid', 'bases'],
    'duplicate bases': ['result_invalid', 'bases'],
    'supported with a return': ['result_invalid', 'return'],
    'return without targets': ['result_invalid', 'return.targets'],
    'return without reason': ['result_invalid', 'return.reason'],
    'return extra field': ['result_invalid', 'return.severity'],
    'missing return bases': ['result_invalid', 'return.bases'],
    'return null': ['result_invalid', 'return'],
    'absent pointer': ['result_invalid', 'return.targets.0'],
    'relative pointer': ['result_invalid', 'return.targets.0'],
    'array index past end': ['result_invalid', 'return.targets.0'],
    'foreign record': ['result_invalid', 'bases.0'],
    'changed record hash': ['result_invalid', 'bases.0'],
    'record with extra field': ['result_invalid', 'bases.0'],
    'foreign claim': ['result_invalid', 'return.targets.0'],
    'unknown not in dossier': ['result_invalid', 'return.targets.0'],
    'unknown contradiction': ['result_invalid', 'return.targets.0'],
    'partial reason past end': ['result_invalid', 'return.targets.0'],
    'negative partial reason': ['result_invalid', 'return.targets.0'],
    'fractional partial reason': ['result_invalid', 'return.targets.0'],
    'unknown axis': ['result_invalid', 'return.targets.0'],
    'two places in one address': ['result_invalid', 'return.targets.0'],
    'unknown address kind': ['result_invalid', 'return.targets.0'],
    'another subject': ['mismatch', 'subject'],
    'truncated candidate in subject': ['mismatch', 'subject'],
    'another candidate outcome': ['mismatch', 'subject'],
    'recomputed identity': ['mismatch', 'subject'],
    'a getter answer': ['result_invalid', 'result'],
  };
  assert.deepEqual(Object.keys(expected).sort(), changes.map(([name]) => name).sort());
  await unchanged(negative, negative.store, async () => {
    for (const [name, change] of changes) {
      const bad = structuredClone(lawful) as any; change(bad);
      await assert.rejects(() => checkDiscoveryFinalAssessmentResult(negative.store, 'p', packet.subject, bad), (error: unknown) =>
        error instanceof EngineError && error.code === `discovery_final_assessment_${expected[name]![0]}`
        && (error.details as { field?: string }).field === expected[name]![1], name);
    }
    // The door proves the subject itself: another, truncated or recomputed subject refuses before the answer is read.
    const altered = structuredClone(packet.subject) as any; altered.candidate.verdict.reason = 'A recomputed candidate';
    const { identity: _identity, ...basis } = altered; altered.identity = `discovery-final-assessment:${hashJson(basis as Json)}`;
    for (const subject of [altered, foreign.subject, { ...packet.subject, projectId: 'other' }, null, {}])
      await assert.rejects(() => checkDiscoveryFinalAssessmentResult(negative.store, 'p', subject, lawful), refusal);
    // The pure projector refuses a packet whose candidate is not its subject's.
    const torn = structuredClone(packet); torn.candidate = candidate(manifest, 'go');
    assert.throws(() => decodeDiscoveryFinalAssessmentResult(lawful, torn), refusal);
  });
});

test('7a.3 result grounds: lost brief, paid D6 or manifest grounds refuse at the checked door without writing', async () => {
  await partialWorld();
  const packet = await prepareDiscoveryFinalAssessmentSubject(negative.store, 'p', reference(partialD6), candidate(partialFinal.dossier.manifest.ref, 'go'));
  const result = answer(packet, 'supported');
  await unchanged(negative, negative.store, async () => {
    for (const at of [partialFinal.brief.observation.source, reference(partialFinal.brief.fact), partialD6.value.session,
      partialD6.value.response, partialFinal.dossier.manifest.ref])
      await assert.rejects(() => checkDiscoveryFinalAssessmentResult(mask(negative.store, at), 'p', packet.subject, result), refusal);
  });
});

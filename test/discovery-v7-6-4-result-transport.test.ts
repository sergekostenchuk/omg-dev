import test from 'node:test';
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
import { prepareDossierResearchEnvelope, researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { projectResearchPhysicalReply } from '../src/discovery/research-consumer-transition.js';
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
import { requireDossierTransportArchive } from '../src/discovery/continuation-packet.js';
import { archivedContext, contextPage, contextValue } from '../src/discovery/working-context.js';
import { requirePacketMaterialDelivery, measureResearchResult, type ResearchResultCapacity } from '../src/discovery/research-delivery.js';

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
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial = false) {
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
      value: { claims: [{ id: 'broad-rejected', kind: 'hypothesis', text: 'Real pre-choice rejected material', axis: 'industry',
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


import { DOSSIER_RESULT_TRANSPORT, DOSSIER_REPLY_FORMS, dossierReplyContract } from '../src/discovery/continuation-packet.js';
import { checkDossierResearchReply } from '../src/discovery/early-research-outcome.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { checkDossierAssessmentResult } from '../src/discovery/dossier-assessment.js';
import { configureReaderPilot, type ReaderPilot } from '../src/discovery/reader-pilot.js';
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

function onlyNewArchives(before:string,after:string) {
  const prior=JSON.parse(before),next=JSON.parse(after),known=new Set(prior.heads.map((row:any)=>row.entity_id));
  const added=new Set<string>(next.heads.filter((row:any)=>!known.has(row.entity_id)).map((row:any)=>row.entity_id));
  assert.ok(added.size>0);assert.ok([...added].every(id=>id.startsWith('research-context:')));
  for(const table of ['heads','revisions'])assert.deepEqual(next[table].filter((row:any)=>!added.has(row.entity_id)),prior[table]);
}
const instruction='Assess this exact saved dossier with its separate terminal result contract.';
function pilotFor(f:Paid, replyChars:number) {
  const old=f.store.get<ReaderPilot>('reader-pilot:p');
  return configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:f.environment.value.reviewer.model,effort:f.environment.value.reviewer.effort,
      command:f.environment.value.reviewer.command,speed:'inherited'},agentCommand:f.environment.value.reviewer.command,
    maxRequestChars:100000,maxReadChars:20000,maxReplyChars:replyChars,maxCalls:100,maxReportedTokens:100000,
    physicalLimits:{maxRequestChars:100000,maxReplyChars:replyChars,basis:'Measured dossier terminal response'}},old?.revision??0);
}
async function envelope(f:Paid, packet:DossierAssessmentPacket, store=f.store,
  context:unknown={dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT},
  capacity?:Record<string,any>, pilot?:Revision<ReaderPilot>, limit=30000) {
  return prepareDossierResearchEnvelope(f.environment.value.reviewer,{...f.environment.value,requestCapacityChars:limit},instruction,
    context,{store,draftId:f.draft.id,questionId:f.v.plan.id,purpose:'dossier-assessor',...(pilot?{pilot}:{})},capacity);
}
function archiveBytes(f:Paid, built:Awaited<ReturnType<typeof envelope>>, packet:DossierAssessmentPacket, store=f.store, modern=true) {
  const wire=JSON.parse(built.input), body=archivedContext(store,store.get<DiscoveryDraft>(f.draft.id)!,wire.subject.working.archive).body;
  assert.equal(canonical(wire),canonical({...built.envelope,subject:built.subject}));
  assert.ok(built.input.length<=built.requestLimit);assert.deepEqual(body.dossierPacket,packet);
  assert.deepEqual(wire.subject.dossierSubject,packet.subject);assert.equal(wire.subject.question,undefined);
  assert.equal(wire.subject.assessmentDelivery.dispatch,'unavailable');
  assert.deepEqual(wire.subject.resultCapacity.forms.map((form:any)=>form.kind),modern?[...DOSSIER_REPLY_FORMS]:['read_context']);
  requirePacketMaterialDelivery(wire.subject,wire.subject.working.archive,(ref,pointer)=>
    contextValue(archivedContext(store,store.get<DiscoveryDraft>(f.draft.id)!,ref),pointer));
  for(const field of modern?['dossierPacket','dossierReplyContract']:['dossierPacket']) {
    let encoded='',offset=0;
    do {const page=contextPage(body[field],{offset,limit:197,encoding:'canonical-json'});
      encoded+=page.value;offset=page.page!.next??-1;}while(offset!==-1);
    assert.equal(encoded,canonical(field==='dossierPacket'?packet:dossierReplyContract(packet)));
    if(wire.subject[field]===undefined)assert.ok(wire.subject.working.materialAddresses.some((a:any)=>a.field===field));
  }
  if(modern) {
    assert.equal(body.dossierResultTransport,DOSSIER_RESULT_TRANSPORT);
    assert.deepEqual(body.dossierReplyContract,dossierReplyContract(packet));
    assert.equal(wire.subject.resultCapacity.mandatory.projection.subject.dossierReplyContract.schemaHash,
      hashJson(dossierReplyContract(packet).schema));
  }
  return wire.subject.resultCapacity as ResearchResultCapacity;
}

for(const model of [false,true])test(`6.4 result transport: real ${model?'model':'owner'} selected; full schema, reply boundary, historic old/new and exact capacity`,async t=>{
  const f=await setup(t,model);await complete(f);
  const saved=produceSelectedDossier(f.store,'p',f.input),packet=await prepareDossierAssessmentSubject(f.store,'p',reference(saved.record));
  const result=replyFor(packet),replyChars=JSON.stringify(result).length,pilot=pilotFor(f,replyChars);
  const before=money(f.store),wireBefore=f.wires(),heads=all(f.store);
  const built=await envelope(f,packet,f.store,undefined,undefined,pilot),capacity=archiveBytes(f,built,packet);
  onlyNewArchives(heads,all(f.store)); // all other heads/history remain exact
  assert.deepEqual(money(f.store),before);assert.deepEqual(f.wires(),wireBefore);
  assert.equal(built.subject.responseOutputLimit.replyChars,replyChars);
  assert.ok(capacity.forms.every(form=>form.specialLimits!.physicalReplyChars===replyChars));
  const passed=(await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,result)))!;
  assert.equal(passed.terminal,true);assert.equal(passed.kind,'dossier_supported');assert.ok(passed.measurement.fits);
  assert.deepEqual(passed.projection,await checkDossierAssessmentResult(f.store,'p',packet.subject,result));
  assert.deepEqual(passed.measurement,measureResearchResult(capacity,'dossier_supported',result));
  const physicalReply=(research:unknown)=>projectResearchPhysicalReply(JSON.stringify({protocol:'omg-agent/v1',
    requestId:built.envelope.requestId,research}),built.envelope.requestId,0,'',replyChars);
  assert.deepEqual(physicalReply(result).payload,result);
  const over=structuredClone(result);over.reasons[0]+='x';
  assert.equal(physicalReply(over).error,'budget_transport_limit');
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,over),true);
  const tiny=pilotFor(f,1);
  await unchanged(f,f.store,()=>envelope(f,packet,f.store,undefined,undefined,tiny),true);
  const roomy=pilotFor(f,1000000),room=await envelope(f,packet,f.store,undefined,undefined,roomy),roomCapacity=archiveBytes(f,room,packet);
  const addressed=replyFor(packet,'return');
  const returned=await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,addressed));
  assert.equal(returned!.kind,'dossier_return');assert.deepEqual(returned!.projection!.packet,packet);
  for(const response of [{action:'assessment_checkpoint',dossierSubject:packet.subject,notes:['Retain the exact review position']},
    {action:'read_context',record:room.subject.working.archive,pointer:'/body/dossierPacket',page:{offset:0,limit:197,encoding:'canonical-json'}},
    {action:'read_context',record:room.subject.working.archive,pointer:'/body/dossierPacket/materials',purpose:'Read the saved inventory',page:{offset:0,limit:1}}]) {
    const continued=await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,response));
    assert.equal(continued!.terminal,false);assert.equal(continued!.projection,null);
  }
  const boundary=structuredClone(result),allowed=roomCapacity.forms.find(form=>form.kind==='dossier_supported')!.maxResultChars;
  boundary.reasons[0]+='x'.repeat(allowed-JSON.stringify(boundary).length);
  assert.equal(JSON.stringify(boundary).length,allowed);
  const atLimit=await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,boundary));
  assert.equal(atLimit!.measurement.requiredChars,roomCapacity.envelopeLimitChars);
  boundary.reasons[0]+='x';
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,boundary),true);
  const oversized=structuredClone(result);oversized.reasons=['x'.repeat(roomCapacity.envelopeLimitChars)];
  assert.equal(measureResearchResult(roomCapacity,'dossier_supported',oversized).fits,false);
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,oversized),true);
  await unchanged(f,f.store,()=>envelope(f,packet,f.store,{dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,
    physicalReplyLimit:9999999,responseOutputLimit:{replyChars:9999999}},undefined,pilot),true);
  assert.equal((archivedContext(f.store,f.store.get<DiscoveryDraft>(f.draft.id)!,built.subject.working.archive).body as any)
    .responseOutputLimit.replyChars,replyChars);
  const old=await envelope(f,packet,f.store,{dossierSubject:packet.subject});archiveBytes(f,old,packet,f.store,false);
  const late=await deep(f,'q-market',[claim(f,'q-market','market','New snapshot with later material')]);
  const mr=await assess(f,late,'unknown',false);const second=produceSelectedDossier(f.store,'p',f.input);
  const other=await prepareDossierAssessmentSubject(f.store,'p',reference(second.record));
  assert.notEqual(other.subject.identity,packet.subject.identity);
  await unchanged(f,f.store,()=>envelope(f,other,f.store,undefined,capacity),true);
  applyDiscoveryAssessment(f.store,'p',reference(mr));revise(f);modeOf(f.store,model?'questions':'bypass');nextPlan(f,f.store);
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    for(const record of [old.subject.working.archive,built.subject.working.archive])await unchanged(f,store,async()=>
      assert.deepEqual(await requireDossierTransportArchive(store,'p',record,packet.subject),packet));
    await unchanged(f,store,async()=>assert.deepEqual(await checkDossierResearchReply(store,'p',packet.subject,capacity,result),passed));
    // Today's larger pilot never changes the old saved physical bound.
    await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,capacity,over),true);
  }
});

test('6.4 result transport: full rejected/unassessed/unknown and blocking sides; malformed, foreign and truncated contracts refuse read-only',async t=>{
  const f=await setup(t);const entries=await complete(f),target=addresses(entries.industry)[0]!;
  const rejected=await deep(f,'q-market',[{...(claim(f,'q-market','market','Rejected explicit counterargument') as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json]);await assess(f,rejected,'rejected');
  await deep(f,'q-market',[{...(claim(f,'q-market','market','Unassessed addressed unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved gap',unknownId:'result-transport-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json]);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  assert.ok(packet.materials.some(m=>m.status==='rejected'));assert.ok(packet.materials.some(m=>m.status==='unassessed'));
  assert.ok(packet.unknowns.length);assert.ok(packet.contradictions.length);
  const built=await envelope(f,packet),capacity=archiveBytes(f,built,packet),result=replyFor(packet,'return');
  const supported=replyFor(packet);const truncated=structuredClone(result);truncated.inventory.contradictions[0]!.sides.pop();
  const noMaterial=structuredClone(result);noMaterial.inventory.materials.pop();
  const foreign=structuredClone(result);foreign.subject={...result.subject,identity:'foreign'};
  const basis=structuredClone(result);basis.quality.roles.bases=[{record:{...packet.manifest.ref,hash:'0'.repeat(64)}}];
  const malformed=[null,{}, {...result,contract:null},{...result,contract:'unknown'},foreign,basis,truncated,noMaterial,supported,
    {...result,action:'assessment_checkpoint'}, {action:'assessment_checkpoint',notes:['Lost exact subject']}];
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    const accepted=await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,capacity,result));
    assert.equal(accepted!.projection!.packet.contradictions.length,packet.contradictions.length);
    for(const response of malformed)await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,capacity,response),true);
    for(const context of [{},{dossierSubject:null},{dossierSubject:packet.subject,dossierResultTransport:null},
      {dossierSubject:packet.subject,dossierResultTransport:'unknown'}, {dossierSubject:packet.subject,dossierReplyContract:dossierReplyContract(packet)},
      {dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,assessmentSubject:{}},
      {dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,dossierReplyContract:null}])
      await unchanged(f,store,()=>envelope(f,packet,store,context),true);
    for(const change of [(c:any)=>{c.bindings.dossierSubject.identity='foreign'},(c:any)=>{c.forms.pop()},
      (c:any)=>{c.mandatory.projection.subject.dossierReplyContract.schemaHash='foreign'},
      (c:any)=>{c.forms[0].specialLimits.physicalReplyChars=999999}]) {
      const bad=structuredClone(capacity);change(bad);
      await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,bad,result),true);
      await unchanged(f,store,()=>envelope(f,packet,store,undefined,bad),true);
    }
    const original=store.get<any>(built.subject.working.archive.id,1)!;
    for(const change of [(b:any)=>{b.dossierReplyContract.schema.oneOf=[]},(b:any)=>{b.dossierResultTransport=null},
      (b:any)=>{delete b.dossierReplyContract},(b:any)=>{b.resultCapacity.forms.pop()},(b:any)=>{b.resultCapacity.mandatory={}},
      (b:any)=>{b.resultCapacity.mandatory=null},
      ...[null,[],0,'projection'].map(value=>(b:any)=>{b.resultCapacity.mandatory={projection:value};}),
      (b:any)=>{delete b.dossierReplyContract;delete b.dossierResultTransport},(b:any)=>{b.dossierPacket.contradictions[0].sides.pop()}]) {
      const value=structuredClone(original.value);change(value.body);const id=`research-context:${hashJson(value)}`;
      const fake=store.get(id)??store.write({id,kind:'research-context',expected:0,value});
      await unchanged(f,store,()=>requireDossierTransportArchive(store,'p',reference(fake),packet.subject),true);
    }
    await unchanged(f,store,()=>researchCall(f.environment.value.reviewer,f.environment.value,instruction,
      {dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT},undefined,
      {store,draftId:f.draft.id,questionId:f.v.plan.id,purpose:'dossier-assessor'}),true);
  }
});

test('6.4 result transport: real nonempty partial preserves reasons and quality without becoming complete',async t=>{
  const f=await paid(t,(snapshot:Ref)=>({action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds:[snapshot]}],
    searchLimits:['Saved sweep'],unknowns:['Demand unknown']}),true);
  const none=f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const handoff=await publishVariantHandoff(f.store,'p',{draft:reference(f.store.get(f.draft.id)!),result:reference(none),decision:null,scope:null,earlyLimit:false});
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference((await producePartialDossier(f.store,'p',reference(handoff.record))).record));
  const built=await envelope(f,packet),capacity=archiveBytes(f,built,packet),result=replyFor(packet);
  assert.equal(packet.manifest.value.completeness,'partial');assert.ok(packet.manifest.value.reasons.length);
  assert.ok(packet.materials.some(m=>m.status==='rejected'));assert.equal(packet.route.scope,null);
  const checked=(await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,result)))!;
  assert.equal(checked.projection!.completeness,'partial');
  const returned=replyFor(packet,'return');returned.return!.targets=[{partialReason:0}];
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,returned));
  modeOf(f.store,'bypass');nextPlan(f,f.store);
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    await unchanged(f,store,async()=>assert.deepEqual(await checkDossierResearchReply(store,'p',packet.subject,capacity,result),checked));
    for(const absent of [undefined,null,[],0,'capacity'])
      await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,absent as any,result),true);
    for(const damage of [
      (c:any)=>{delete c.mandatory;},
      ...[null,[],0,'minimum',{}].map(value=>(c:any)=>{c.mandatory=value;}),
      (c:any)=>{delete c.mandatory.projection;},
      ...[null,[],0,'projection',{}].map(value=>(c:any)=>{c.mandatory={projection:value};}),
      ...[null,[],0,'subject'].map(value=>(c:any)=>{c.mandatory={projection:{subject:value}};}),
      (c:any)=>{c.mandatory={archive:null};},
      (c:any)=>{c.mandatory={projection:{subject:{}},archive:{}};},
      (c:any)=>{c.bindings=null;},
      (c:any)=>{c.forms=null;}
    ]) {
      const corrupt=structuredClone(capacity);damage(corrupt);
      await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,corrupt,result),true);
    }
    await unchanged(f,store,async()=>assert.deepEqual(await requireDossierTransportArchive(store,'p',built.subject.working.archive,packet.subject),packet));
  }
});

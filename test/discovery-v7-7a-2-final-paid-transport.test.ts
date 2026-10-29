import { finalResponseContract } from '../src/discovery/discovery-response-contract.js';
import { deliveredContract } from './discovery-response-contract-fixture.js';
import { fixtureApplicableAxes } from './discovery-v7-fixture.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { storeUnchanged } from './store-unchanged.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { Discovery } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, readDiscoveryFinalResearchExecution } from '../src/discovery/response-recovery.js';
import { researchCall, resumeDiscoveryFinalResearchCall, withResearchRunControl } from '../src/discovery/research-protocol.js';
import { previewResearch } from '../src/discovery/research-preview.js';
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
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';
import { acquireRunExecution, releaseRunExecution, stopRun } from '../src/om/run-control.js';
import { DISCOVERY_DEEP_PREPARATION_CONTRACT, produceDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import type { VariantNone } from '../src/discovery/discovery-variants.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';

// Real paid generation/selection preparation shared in shape with the accepted 4P.1 scenarios.
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
const namesPrepared = (candidate: unknown, expected: Ref) => candidate !== undefined && candidate !== null
  && canonical(candidate) === canonical(expected);
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
const all = (store: Store) => {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    // Compare every column, including the full immutable body and events,
    // without materialising and re-escaping the complete database in memory.
    const digest = createHash('sha256');
    for (const query of ['SELECT * FROM heads ORDER BY entity_id',
      'SELECT * FROM revisions ORDER BY entity_id,revision', 'SELECT * FROM events ORDER BY sequence']) {
      digest.update(query);
      for (const row of db.prepare(query).iterate()) {
        digest.update('row:');
        for (const [key, value] of Object.entries(row)) {
          assert.ok(typeof value === 'string' || typeof value === 'number');
          const text = String(value);
          digest.update(key).update(typeof value).update(`${Buffer.byteLength(text)}:`).update(text);
        }
      }
    }
    return digest.digest('hex');
  }
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
/** A genuine Store stamp detects every intervening product commit, including
 * a write later undone. Full history is compared at the scenario boundary. */
async function unchangedByStamp<T>(f: Paid, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), wires = f.wires();
  const result = await storeUnchanged(store, action);
  assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
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

/** Corrupt only an isolated SQLite snapshot. The tested reader still receives
 * a genuine Store: its normal historical proof and cache invalidation run.
 * Each corruption is installed before the no-write window and restored after
 * it, and the database's immutable-revision triggers are present during every
 * product call. The original paid world is never changed. */
const STORED_JSON_NULL = Symbol('stored-json-null');
async function withCorruptCopy<T>(source: Store, action: (copy: {
  hot: Store;
  cold: () => Store;
  corrupt: (ref: Ref, replacement: unknown | null, check: () => Promise<void>) => Promise<void>;
}) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'omg-final-corrupt-'));
  const path = join(root, 'state.sqlite');
  const backup = new DatabaseSync(source.path);
  try { backup.prepare('VACUUM INTO ?').run(path); } finally { backup.close(); }
  const hot = new Store(path), stores = [hot], db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=OFF');
  const edit = (change: () => void) => {
    db.exec('BEGIN IMMEDIATE; DROP TRIGGER revisions_no_update; DROP TRIGGER revisions_no_delete');
    try {
      change();
      db.exec("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END;"
        + "CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END; COMMIT");
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const corrupt = async (ref: Ref, replacement: unknown | null, check: () => Promise<void>) => {
    const row = db.prepare('SELECT entity_id, revision, kind, body, sha256 FROM revisions WHERE entity_id=? AND revision=?')
      .get(ref.id, ref.revision);
    assert.ok(row && row['sha256'] === ref.hash, 'the corruption targets the original exact revision');
    edit(() => {
      if (replacement === null) db.prepare('DELETE FROM revisions WHERE entity_id=? AND revision=?').run(ref.id, ref.revision);
      else {
        const body = replacement === STORED_JSON_NULL ? null : replacement;
        db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
          .run(canonical(body), hashJson(body), ref.id, ref.revision);
      }
    });
    try { await check(); } finally {
      edit(() => {
        if (replacement === null) db.prepare('INSERT INTO revisions(entity_id,revision,kind,body,sha256) VALUES(?,?,?,?,?)')
          .run(String(row['entity_id']), Number(row['revision']), String(row['kind']), String(row['body']), String(row['sha256']));
        else db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
          .run(String(row['body']), String(row['sha256']), ref.id, ref.revision);
      });
    }
  };
  try { return await action({ hot, cold: () => { const store = new Store(path); stores.push(store); return store; }, corrupt }); }
  finally { for (const store of stores) store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}
async function interceptWrites<T>(store: Store, hook: (writes: any[], guards: any[], invoke: () => any) => any,
  action: () => Promise<T>): Promise<T> {
  // Intercept only writes for this real Store; all readers remain the real
  // Store's readers. Restore even when the injected cut or assertion throws.
  const original = Store.prototype.writeMany;
  const wrapped = function (this: Store, ...args: Parameters<Store['writeMany']>) {
    const invoke = () => original.apply(this, args);
    return this === store ? hook(args[0], args[1] ?? [], invoke) : invoke();
  };
  Store.prototype.writeMany = wrapped as Store['writeMany'];
  try { return await action(); }
  finally { Store.prototype.writeMany = original; }
}
function wideDelivery(f:Paid) {
  return configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:f.environment.value.reviewer.model,effort:f.environment.value.reviewer.effort,
      command:f.environment.value.reviewer.command,speed:'inherited'},agentCommand:f.environment.value.reviewer.command,
    maxRequestChars:12000000,maxReadChars:128000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:100000,
    physicalLimits:{maxRequestChars:12000000,maxReplyChars:100000,basis:'Full local dossier delivery'}},0);
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
  type DiscoveryFinalPacket } from '../src/discovery/discovery-final.js';

const ORIGINAL_BRIEF='  Построй продукт для двух регионов.\nСохрани роли, альтернативы и ограничения — α.  ';
// Force a multi-page real D6 packet while retaining the exact counterargument
// and both blocking sides without multiplying an identical proof indefinitely.
const LARGE_COUNTERARGUMENT='Exact blocking counterargument: '+ '0123456789α'.repeat(8);
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
let owner:Selected,model:Selected,negative:Awaited<ReturnType<typeof partial>>;
let ownerEntries:Awaited<ReturnType<typeof complete>>,ownerPilot:ReturnType<typeof wideDelivery>;
let ownerResearchAdapter: string;
let ownerD6:Revision<PaidDossierAssessment>,modelD6:Revision<PaidDossierAssessment>,partialD6:Revision<PaidDossierAssessment>,
  richD6:Revision<PaidDossierAssessment>;
let ownerPacket:DiscoveryFinalPacket,modelPacket:DiscoveryFinalPacket,partialPacket:DiscoveryFinalPacket,firstPaidPrepared:Ref;
const disposals:(()=>void)[]=[];
let ownerStores: Store[] = [], ownerSeed: string | undefined, richSeed: string | undefined;
after(()=>{for(const dispose of disposals)dispose();});
const lifetime={after:(dispose:()=>void)=>disposals.push(dispose)} as unknown as test.TestContext;
async function ownerWorld() {
  if(owner)return;
  owner=await setup(lifetime);ownerEntries=await complete(owner);
  const originalOpen = owner.open;
  ownerStores = [owner.store];
  owner.open = () => { const store = originalOpen(); ownerStores.push(store); return store; };
  ownerResearchAdapter=readFileSync(owner.root+'/adapter.mjs','utf8');
  const dossier=await prepareDossierAssessmentSubject(owner.store,'p',reference(produceSelectedDossier(owner.store,'p',owner.input).record));
  liveAdapter(owner,dossier,'supported',false);
  ownerPilot=wideDelivery(owner);
  ownerD6=await assessDossier(owner.store,'p',dossier.subject,owner.environment,ownerPilot);
  ownerPacket=await prepareDiscoveryFinalSubject(owner.store,'p',reference(ownerD6));
}

/** Snapshot only the genuinely paid baseline after the bootstrap scenario.
 * Each later sequential owner scenario restores its own runtime files and a
 * checkpointed database at the original path, so historic Refs and provider
 * paths remain exact and earlier test calls do not accumulate as its input. */
function saveOwnerWorld(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `omg-final-${label}-seed-`));
  const world = join(root, 'world');
  const databaseFiles = new Set([owner.path, `${owner.path}-wal`, `${owner.path}-shm`]);
  cpSync(owner.root, world, { recursive: true, filter: source => !databaseFiles.has(source) });
  const db = new DatabaseSync(owner.path);
  try { db.prepare('VACUUM INTO ?').run(join(world, 'state.sqlite')); } finally { db.close(); }
  disposals.push(() => rmSync(root, { recursive: true, force: true }));
  return world;
}
function saveOwnerSeed() {
  assert.equal(ownerSeed, undefined);
  ownerSeed = saveOwnerWorld('owner');
}
function restoreOwnerWorld(seed: string) {
  for (const store of ownerStores) store.close();
  ownerStores = [];
  for (const name of readdirSync(owner.root)) rmSync(join(owner.root, name), { recursive: true, force: true });
  cpSync(seed, owner.root, { recursive: true });
  owner.store = owner.open();
  owner.engine = new ProductEngine(owner.store);
  owner.discovery = new Discovery(owner.store);
}
function restoreOwnerSeed() {
  assert.ok(ownerSeed, 'the paid bootstrap must precede its independent owner scenarios');
  restoreOwnerWorld(ownerSeed);
}
async function richWorld() {
  await ownerWorld();
  if(richD6)return;
  // Earlier final scenarios replace this file with a D7-only adapter. The
  // following real deep-research producers still need the ordinary adapter.
  writeFileSync(owner.root+'/adapter.mjs',ownerResearchAdapter);
  const target=addresses(ownerEntries.industry)[0]!;
  const rejected=await deep(owner,'q-market',[{...(claim(owner,'q-market','market',LARGE_COUNTERARGUMENT) as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json]);await assess(owner,rejected,'rejected');
  await deep(owner,'q-market',[{...(claim(owner,'q-market','market','Unassessed final unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved final gap',unknownId:'final-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json]);
  const rich=await prepareDossierAssessmentSubject(owner.store,'p',reference(produceSelectedDossier(owner.store,'p',owner.input).record));
  liveAdapter(owner,rich,'return',false);
  richD6=await assessDossier(owner.store,'p',rich.subject,owner.environment,ownerPilot);
  richSeed = saveOwnerWorld('rich');
}
async function modelWorld() {
  if(model)return;
  model=await setup(lifetime,true);await complete(model);
  const selected=await prepareDossierAssessmentSubject(model.store,'p',reference(produceSelectedDossier(model.store,'p',model.input).record));
  liveAdapter(model,selected,'supported',false);
  modelD6=await assessDossier(model.store,'p',selected.subject,model.environment,wideDelivery(model));
  modelPacket=await prepareDiscoveryFinalSubject(model.store,'p',reference(modelD6));
}
async function partialWorld() {
  if(negative)return;
  negative=await partial(lifetime);liveAdapter(negative,negative.packet,'return',false);
  partialD6=await assessDossier(negative.store,'p',negative.packet.subject,negative.environment);
  acceptBrief(negative,'Later partial assignment.');
}
import { V7_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { DISCOVERY_FINAL_RESULT, prepareDiscoveryFinalResultTransport,
  requireDiscoveryFinalResultCapacity, checkDiscoveryFinalResearchReply } from '../src/discovery/discovery-final-result.js';
import { readFinalCapacityProjection, researchCapacityProjection } from '../src/discovery/early-research-outcome.js';

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
import { readArchiveBody } from '../src/discovery/request-parts.js';
import type { DiscoveryFinalEnvelopeInput } from '../src/discovery/discovery-final-packing.js';
import { DISCOVERY_FINAL_SESSION_KIND, prepareDiscoveryFinalSession,
  type DiscoveryFinalSession } from '../src/discovery/discovery-final-session.js';

const RESULT_LIMIT = 10_000_000;
function finalInput(f: Paid): DiscoveryFinalEnvelopeInput {
  return { prompt: 'Build the exact final Discovery package from the saved mandate and assessed dossier.',
    packetChars: 8_000_000, limitChars: 9_000_000, resultLimitChars: RESULT_LIMIT,
    environment: reference(f.environment), role: structuredClone(f.environment.value.implementer) };
}
// For refusals and cuts before a terminal, the complete archive remains real
// but the first wire need not carry the whole multi-megabyte dossier.
function compactFinalInput(f: Paid): DiscoveryFinalEnvelopeInput {
  // Keep the former material share and add the newly mandatory inline reply form.
  // The physical ceiling remains fixed; forecast/stop/atomic assertions below are unchanged.
  const replyChars = JSON.stringify({ discoveryResponseContract: finalResponseContract(false) }).length;
  return { ...finalInput(f), packetChars: 24_000 + replyChars, limitChars: 64_000 };
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

import { discoveryFinalExecutionId, readDiscoveryFinalDispatchAdmission, readDiscoveryFinalExecutionAt,
  runDiscoveryFinalExecution, type DiscoveryFinalApplication, type DiscoveryFinalExecution } from '../src/discovery/discovery-final-execution.js';
import { continuationMetadata, continuationState } from '../src/discovery/continuation-packet.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { addContextLookup, contextLookupKey, contextWorkspace, packContextWorkspace,
  requireCompleteContextPacket, requireContextDelivery } from '../src/discovery/context-workspace.js';
import { planResearchContextDelivery, planResearchDelivery, requireResearchDelivery } from '../src/discovery/research-delivery.js';
import { projectResearchContextRead } from '../src/discovery/research-consumer-transition.js';

test('final paid: clipped canonical context pages preserve absolute UTF-16 bounds and consolidation originals', () => {
  const value = { text: ('quotes " slash \\ astral 😀 and кириллица ').repeat(1_400) };
  const encoded = canonical(value);
  const record: Ref = { id: 'research-context:page-test', revision: 1, hash: hashJson({ value }) };
  const pointer = '/body/value';
  for (const offset of [0, Math.floor(encoded.length / 2), encoded.length - 8_000]) {
    const lookup = projectResearchContextRead({ body: { value } }, record, pointer,
      { offset, limit: 8_000, encoding: 'canonical-json' }, 50_000, 'bounded');
    assert.equal(lookup.value, encoded.slice(offset, offset + 8_000));
    const packet: Record<string, any> = { contextWorkspace: [lookup],
      working: { archive: record, deliveryContract: 'research-delivery/v1' } };
    packContextWorkspace(packet, 4_000, 4_000);
    requireContextDelivery([lookup], packet);
    const part = packet.contextDelivery[0];
    assert.equal(part.requested.offset, offset);
    assert.equal(part.served.offset, offset);
    assert.equal(part.served.total, encoded.length);
    assert.equal(part.text, encoded.slice(offset, part.served.end));
    assert.ok(part.served.end < lookup.page!.end);
    assert.throws(() => requireCompleteContextPacket(addContextLookup(contextWorkspace(), lookup, []), packet),
      error => error instanceof EngineError && error.code === 'research_context_incomplete');
    const changes: Array<(value: any) => void> = [
      x => { x.text += 'x'; }, x => { x.original.valueHash = '0'.repeat(64); },
      x => { x.original.key = 'foreign'; }, x => { x.original.record.hash = '0'.repeat(64); },
      x => { x.original.pointer = '/body/other'; },
      x => { x.encoding = 'utf16-string'; x.value = x.text; delete x.text; },
      x => { x.original.page.offset++; }, x => { x.original.page.end--; },
      x => { x.original.page.total++; }, x => { x.original.page.next = x.original.page.next === null ? 0 : null; },
      x => { x.requested.offset++; }, x => { x.served.offset++; },
      x => { x.served.end++; }, x => { x.served.total++; }, x => { x.served.next = null; },
    ];
    for (const change of changes) {
      const forged = structuredClone(packet); change(forged.contextDelivery[0]);
      assert.throws(() => requireContextDelivery([lookup], forged), error => error instanceof EngineError);
    }
    const key = contextLookupKey(lookup), limit = 1_500;
    const bounded = planResearchContextDelivery(lookup, key, 4_000, 3_000,
      item => JSON.stringify({ delivery: item }).length <= limit)!;
    assert.ok(JSON.stringify({ delivery: bounded }).length <= limit);
    assert.ok(bounded.served.end < lookup.page!.end);
    const extended = structuredClone(bounded);
    extended.served.end++;
    extended.served.next = extended.served.end < extended.served.total ? extended.served.end : null;
    extended.text = encoded.slice(offset, extended.served.end);
    assert.ok(JSON.stringify({ delivery: extended }).length > limit);
  }
  const start = Math.floor(encoded.length / 3);
  const original = { record, pointer, value, page: { offset: start, end: encoded.length,
    total: encoded.length, unit: 'utf16', next: null, encoding: 'canonical-json' as const } };
  const key = hashJson({ record, pointer, value });
  const legacy = planResearchDelivery(original, key, 4_000, 3_000,
    item => JSON.stringify({ delivery: item }).length <= 1_500)!;
  requireResearchDelivery(original, key, legacy);
  assert.equal(legacy.text, encoded.slice(start, legacy.served.end));
  assert.equal(legacy.original.valueHash, hashJson(value));
});

/** The adapter asks for each actually omitted range; it never invents a
 * delivered page or turns an assessment into the final verdict. */
function finalAdapter(f: Paid, packet: DiscoveryFinalPacket, outcome: Outcome, pageLimit: number | 'two-pages' = 128000) {
  const terminal = candidate(packet, outcome);
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, terminal, pageLimit, coverage: {}, requested: [] }));
  const script = [
    "import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';",
    "const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),file="+JSON.stringify(f.settings)+",s=JSON.parse(readFileSync(file,'utf8'));",
    "appendFileSync("+JSON.stringify(f.root+'/wire.ndjson')+",raw+'\\n');",
    "const key=(record,pointer)=>JSON.stringify([record.id,record.revision,record.hash,pointer]);",
    "const save=(k,a,b)=>{(s.coverage[k]??=[]).push([a,b]);};",
    "for(const v of [...(r.subject.materialDelivery??[]),...(r.subject.contextDelivery??[])]) save(key(v.original.record,v.original.pointer),v.served.offset,v.served.end);",
    "for(const v of r.subject.contextWorkspace??[]){const a=(r.subject.working?.materialAddresses??[]).find(x=>key(x.record,x.pointer)===key(v.record,v.pointer));if(v.page)save(key(v.record,v.pointer),v.page.offset,v.page.end);else if(a)save(key(v.record,v.pointer),0,a.total);}",
    "let research=s.terminal;",
    "for(const a of r.subject.working?.materialAddresses??[]){const k=key(a.record,a.pointer),ranges=(s.coverage[k]??[]).sort((x,y)=>x[0]-y[0]);let offset=0;for(const [start,end] of ranges){if(start>offset)break;offset=Math.max(offset,end);}if(offset<a.total){if(s.pageLimit==='two-pages')s.pageLimit=Math.max(1,Math.ceil((a.total-offset)/2));s.requested.push([a.record,a.pointer,offset]);research={action:'read_context',record:a.record,pointer:a.pointer,page:{offset,limit:s.pageLimit,...(a.encoding==='canonical-json'?{encoding:'canonical-json'}:{})}};break;}}",
    "writeFileSync(file,JSON.stringify(s));",
    "console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));",
  ].join('\n');
  writeFileSync(f.root+'/adapter.mjs', script);
}

async function calibrateFinalRole(f: Paid) {
  f.reply({ action: 'answer', question: 'reader',
    value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Calibration' }, citations: [] });
  const before = new Set(f.store.list<ModelCall>('model-call').map(row => row.id));
  await researchCall(f.environment.value.implementer, f.environment.value, 'Calibrate the same role', {}, undefined,
    { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'assessor' });
  const row = f.store.list<ModelCall>('model-call').find(call => !before.has(call.id)
    && call.value.purpose === 'assessor' && call.value.usage);
  assert.ok(row); return row;
}

// Isolated fallback scenarios need the same real paid baseline as the full
// file, but must not depend on the named bootstrap test having run first.
async function ensureOwnerSeed() {
  if (ownerSeed) return;
  const { cell } = await preparePaidFinal(owner, ownerPacket);
  firstPaidPrepared = reference(cell);
  await calibrateFinalRole(owner);
  finalAdapter(owner, ownerPacket, 'go');
  const paid = await runDiscoveryFinalExecution(owner.store, 'p', firstPaidPrepared, { profile: ownerPilot });
  assert.equal(paid.result?.result.bundle.verdict.outcome, 'go');
  saveOwnerSeed();
}

test('final paid: measured bootstrap uses exact same-role basis, then restores owner result hot and cold', async () => {
  await ownerWorld();
  assertFinal(ownerPacket);
  const { cell } = await preparePaidFinal(owner, ownerPacket);
  firstPaidPrepared = reference(cell);
  await unchanged(owner, owner.store, async () => {
    const inheritedRef = Object.assign(Object.create({ foreign: true }), reference(cell));
    await assert.rejects(() => runDiscoveryFinalExecution(owner.store, 'p', inheritedRef),
      error => error instanceof EngineError && error.code === 'discovery_final_execution_invalid');
    let allowanceReads = 0;
    const changingAllowance = { get allowance() { return ++allowanceReads === 1 ? 0 : 1; } };
    await assert.rejects(() => runDiscoveryFinalExecution(owner.store, 'p', reference(cell), changingAllowance),
      error => error instanceof EngineError && error.code === 'research_call_allowance');
    assert.equal(allowanceReads, 1);
    await assert.rejects(() => runDiscoveryFinalExecution(owner.store, 'p', reference(cell)),
      error => error instanceof EngineError && error.code === 'budget_estimate_missing');
  });
  const measured = await calibrateFinalRole(owner);
  finalAdapter(owner, ownerPacket, 'go');
  const callerCopy = { ...ownerPilot, value: { ...ownerPilot.value, maxRequestChars: 1,
    physicalLimits: { ...ownerPilot.value.physicalLimits!, maxRequestChars: 1 } } };
  const submitted = reference(cell);
  let preparedReads = 0, profileReads = 0;
  const changingRef = { ...submitted, get id() { return ++preparedReads === 1 ? submitted.id : 'foreign-session'; } };
  const changingProfile = { get profile() { return ++profileReads === 1 ? callerCopy : { ...ownerPilot, id: 'foreign-profile' }; } };
  const result = await runDiscoveryFinalExecution(owner.store, 'p', changingRef, changingProfile);
  assert.equal(preparedReads, 1); assert.equal(profileReads, 1);
  deliveredContract(owner.store,owner.wires().at(-1),'discovery-final');
  assert.equal(result.result?.result.bundle.verdict.outcome, 'go');
  assert.equal(result.output?.value.contract, 'discovery-final-paid-result/v1');
  assert.equal(Object.hasOwn(result.output!.value, 'accepted'), false);
  const calls = owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final');
  assert.ok(calls.length > 0);
  assert.deepEqual(calls[0]!.value.profile, reference(ownerPilot));
  assert.ok(calls[0]!.value.budget?.estimate.basis.some(ref => ref.id === measured.id));
  assert.match(calls[0]!.value.budget!.estimate.explanation, /final bootstrap/);
  await unchanged(owner, owner.store, async () => {
    for (const store of [owner.store, owner.open()]) {
      const restored = await storeUnchanged(store, () =>
        runDiscoveryFinalExecution(store, 'p', reference(cell), { restoreOnly: true }));
      assert.deepEqual(restored.result, result.result);
      const sessionRef = reference(result.session);
      let sessionReads = 0;
      const changingSession = { ...sessionRef, get id() { return ++sessionReads === 1 ? sessionRef.id : 'foreign-execution'; } };
      const read = await storeUnchanged(store, () => readDiscoveryFinalExecutionAt(store, 'p', changingSession));
      assert.equal(sessionReads, 1);
      assert.deepEqual(read.result, result.result);
    }
  });
  saveOwnerSeed();
});

test('final paid: inline and archived result bounds cannot change between proof and measurement', async () => {
  await ownerWorld();
  const packet = ownerPacket;
  const reply = candidate(packet, 'go');
  await unchanged(owner, owner.store, async () => {
    for (const archive of [false, true]) {
      const options = archive ? { archive: 'staged' as const } : undefined;
      let limit = RESULT_LIMIT;
      let transport = await prepareDiscoveryFinalResultTransport(owner.store, 'p', packet.subject, limit, options);
      for (let attempt = 0; attempt < 5; attempt++) {
        const next = transport.capacity.forms[0]!.minimumChars + JSON.stringify(reply).length;
        if (next === limit) break;
        limit = next;
        transport = await prepareDiscoveryFinalResultTransport(owner.store, 'p', packet.subject, limit, options);
      }
      assert.equal(transport.capacity.forms[0]!.minimumChars + JSON.stringify(reply).length, limit);
      if (archive) {
        assert.ok(transport.archive);
        assert.deepEqual(reference(owner.store.get(transport.archive.ref.id, transport.archive.ref.revision)!), transport.archive.ref);
        const archiveRef = transport.archive.ref;
        let archiveReads = 0;
        const changingArchive = { ...archiveRef, get id() { return ++archiveReads === 1 ? archiveRef.id : 'foreign-archive'; } };
        assert.deepEqual(readFinalCapacityProjection(owner.store, changingArchive, '/body/request'), transport.archive.projection);
        assert.equal(archiveReads, 1);
        const inheritedArchive = Object.assign(Object.create({ foreign: true }), archiveRef);
        assert.throws(() => readFinalCapacityProjection(owner.store, inheritedArchive, '/body/request'),
          error => error instanceof EngineError && error.code === 'research_capacity_invalid');
        let mandatoryReads = 0;
        const shiftingDeclaration = { ...transport.capacity,
          get mandatory() { return ++mandatoryReads === 1 ? transport.capacity.mandatory
            : { projection: { foreign: true }, hash: '0'.repeat(64) }; } };
        assert.deepEqual(researchCapacityProjection(shiftingDeclaration, owner.store), transport.archive.projection);
        assert.equal(mandatoryReads, 1);
        const changingCapacity = structuredClone(transport.capacity);
        const pending = requireDiscoveryFinalResultCapacity(owner.store, 'p', packet.subject, limit, changingCapacity);
        changingCapacity.envelopeLimitChars = 1;
        assert.equal((await pending).capacity.envelopeLimitChars, limit);
      }
      const exact = await checkDiscoveryFinalResearchReply(owner.store, 'p', packet, limit, transport.capacity, reply);
      assert.equal(exact.measurement.requiredChars, limit);
      assert.equal(exact.measurement.fits, true);
      if (!archive) {
        const changingPacket = structuredClone(packet);
        let subjectReads = 0;
        Object.defineProperty(changingPacket, 'subject', { enumerable: true,
          get: () => ++subjectReads === 1 ? packet.subject : { ...packet.subject, identity: 'foreign' } });
        const stablePacket = await checkDiscoveryFinalResearchReply(owner.store, 'p', changingPacket, limit, transport.capacity, reply);
        assert.deepEqual(stablePacket.projection.packet, packet);
        assert.equal(subjectReads, 1);
        const inheritedPacket = structuredClone(packet);
        inheritedPacket.brief = Object.assign(Object.create({ foreign: true }), inheritedPacket.brief);
        await assert.rejects(() => checkDiscoveryFinalResearchReply(owner.store, 'p', inheritedPacket, limit, transport.capacity, reply),
          error => error instanceof EngineError && error.code === 'discovery_final_subject_invalid');
        const inheritedCapacity = Object.assign(Object.create({ foreign: true }), transport.capacity);
        await assert.rejects(() => checkDiscoveryFinalResearchReply(owner.store, 'p', packet, limit, inheritedCapacity, reply),
          error => error instanceof EngineError && error.code === 'research_capacity_invalid');
        const inheritedReply = Object.assign(Object.create({ inherited: true }), reply);
        await assert.rejects(() => checkDiscoveryFinalResearchReply(owner.store, 'p', packet, limit, transport.capacity, inheritedReply),
          error => error instanceof EngineError && error.code === 'discovery_final_result_invalid');
        const inheritedNestedReply = structuredClone(reply);
        inheritedNestedReply.bundle.dossier = Object.assign(Object.create({ foreign: true }), inheritedNestedReply.bundle.dossier);
        await assert.rejects(() => checkDiscoveryFinalResearchReply(owner.store, 'p', packet, limit, transport.capacity, inheritedNestedReply),
          error => error instanceof EngineError && error.code === 'discovery_final_result_invalid');
        const shiftingReply = structuredClone(reply);
        let replyReads = 0;
        Object.defineProperty(shiftingReply.bundle.verdict, 'outcome', { enumerable: true,
          get: () => ++replyReads === 1 ? 'go' : 'unknown-outcome' });
        const stable = await checkDiscoveryFinalResearchReply(owner.store, 'p', packet, limit, transport.capacity, shiftingReply);
        assert.equal(stable.projection.result.bundle.verdict.outcome, 'go');
        assert.equal(replyReads, 1);
      }
      const smaller = await prepareDiscoveryFinalResultTransport(owner.store, 'p', packet.subject, limit - 1, options);
      const capacityRefusal = (error: unknown) => error instanceof EngineError && error.code === 'research_result_capacity';
      await assert.rejects(() => checkDiscoveryFinalResearchReply(owner.store, 'p', packet, limit - 1, smaller.capacity, reply), capacityRefusal);
      const forged = structuredClone(smaller.capacity);
      let reads = 0;
      Object.defineProperty(forged, 'envelopeLimitChars', { enumerable: true,
        get: () => ++reads === 1 ? limit - 1 : RESULT_LIMIT });
      await assert.rejects(() => checkDiscoveryFinalResearchReply(owner.store, 'p', packet, limit - 1, forged, reply), capacityRefusal);
      assert.equal(reads, 1);
    }
  });
});

test('final paid: model-selected dossier remains bound to its real paid input', async () => {
  await modelWorld();
  const packet = modelPacket;
  const { cell } = await preparePaidFinal(model, packet);
  await calibrateFinalRole(model); finalAdapter(model, packet, 'conditional');
  const result = await runDiscoveryFinalExecution(model.store, 'p', reference(cell));
  assert.equal(result.result?.result.bundle.verdict.outcome, 'conditional');
  assert.deepEqual(result.result?.packet.subject, packet.subject);
});

test('final paid: another role or adapter cannot borrow a forecast; a measured over-limit forecast cannot buy', async () => {
  await modelWorld();
  const packet = modelPacket;
  const { projectId, ...base } = model.environment.value;
  assert.equal(projectId, 'p');
  const alternateAdapter = model.root + '/final-other-adapter.mjs';
  writeFileSync(alternateAdapter, readFileSync(model.root + '/adapter.mjs'));
  const roles = [
    { ...base.implementer, actor: 'different-final-author' },
    { ...base.implementer, command: { ...base.implementer.command, args: [alternateAdapter] } },
  ];
  let lastEnvironment = model.environment;
  for (const [index, role] of roles.entries()) {
    lastEnvironment = model.engine.environments.configure('p', { ...base, implementer: role }, lastEnvironment.revision);
    const cell = await prepareDiscoveryFinalSession(model.store, 'p', packet.subject,
      { ...compactFinalInput(model), prompt: finalInput(model).prompt + ' foreign forecast ' + index,
        environment: reference(lastEnvironment), role });
    await unchanged(model, model.store, async () => {
      await assert.rejects(() => runDiscoveryFinalExecution(model.store, 'p', reference(cell)),
        error => error instanceof EngineError && error.code === 'budget_estimate_missing');
    });
  }
  // This is a genuine response from the alternate adapter under the exact
  // role; the common estimator must still enforce the real stage/group limit.
  writeFileSync(model.settings, JSON.stringify({ tokens: 10_000_000,
    terminal: { action: 'answer', question: 'reader',
      value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Measured expensive call' }, citations: [] },
    coverage: {}, requested: [] }));
  await researchCall(lastEnvironment.value.implementer, lastEnvironment.value, 'Measure the exact expensive role', {}, undefined,
    { store: model.store, draftId: model.calibration.draft.id, questionId: model.calibration.question.id, purpose: 'assessor' });
  const cell = await prepareDiscoveryFinalSession(model.store, 'p', packet.subject,
    { ...compactFinalInput(model), prompt: finalInput(model).prompt + ' expensive forecast',
      environment: reference(lastEnvironment), role: lastEnvironment.value.implementer });
  await unchanged(model, model.store, async () => {
    await assert.rejects(() => runDiscoveryFinalExecution(model.store, 'p', reference(cell)),
      error => error instanceof EngineError && ['budget_question_limit', 'budget_owner_group_limit',
        'budget_segment_exhausted', 'discovery_budget_reserve', 'discovery_budget_exhausted', 'discovery_budget_overrun'].includes(error.code));
  });
});

test('final paid: nonempty partial is paid as partial and late heads cannot authorize a new send', async () => {
  negative = await partial(lifetime);
  liveAdapter(negative, negative.packet, 'return', false);
  partialD6 = await assessDossier(negative.store, 'p', negative.packet.subject, negative.environment);
  partialPacket = await prepareDiscoveryFinalSubject(negative.store, 'p', reference(partialD6));
  assert.equal(partialPacket.dossier.manifest.value.completeness, 'partial');
  assert.ok(partialPacket.dossier.materials.length > 0);
  const paidCell = await prepareDiscoveryFinalSession(negative.store, 'p', partialPacket.subject, finalInput(negative));
  await calibrateFinalRole(negative); finalAdapter(negative, partialPacket, 'insufficient_evidence');
  const paid = await runDiscoveryFinalExecution(negative.store, 'p', reference(paidCell));
  assert.equal(paid.result?.packet.dossier.manifest.value.completeness, 'partial');
  assert.equal(paid.result?.result.bundle.verdict.outcome, 'insufficient_evidence');
  assert.equal(paid.result?.result.bundle.projection, null);
  assert.equal(paid.result?.result.bundle.constitution, null);
  const staleCell = await prepareDiscoveryFinalSession(negative.store, 'p', partialPacket.subject,
    { ...finalInput(negative), prompt: finalInput(negative).prompt + ' stale' });
  acceptBrief(negative, 'Later partial assignment.');
  await unchanged(negative, negative.store, async () => {
    const restored = await runDiscoveryFinalExecution(negative.store, 'p', reference(paidCell), { restoreOnly: true });
    assert.deepEqual(restored.result, paid.result);
    await assert.rejects(() => runDiscoveryFinalExecution(negative.store, 'p', reference(staleCell)),
      error => error instanceof EngineError);
  });
});

test('final paid: historical partial cannot be turned into new authority after another brief', async () => {
  await partialWorld();
  partialPacket = await prepareDiscoveryFinalSubject(negative.store, 'p', reference(partialD6));
  assert.equal(partialPacket.dossier.manifest.value.completeness, 'partial');
  assert.ok(partialPacket.dossier.materials.length > 0);
  const input = finalInput(negative);
  const partialCell = await prepareDiscoveryFinalSession(negative.store, 'p', partialPacket.subject,
    { ...input, prompt: input.prompt + ' newly prepared after the brief changed' });
  await unchanged(negative, negative.store, () => runDiscoveryFinalExecution(negative.store, 'p', reference(partialCell)), true);
});

test('final paid: a cut before the atomic reservation leaves no claim, ledger, or wire', async () => {
  await ownerWorld();
  restoreOwnerSeed();
  const packet = ownerPacket;
  const cell = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject,
    { ...compactFinalInput(owner), prompt: finalInput(owner).prompt + ' before claim' });
  finalAdapter(owner, packet, 'go');
  let hit = false;
  let captured: { session: any; application: any } | undefined;
  await unchanged(owner, owner.store, async () => {
    await assert.rejects(() => interceptWrites(owner.store, (writes, _guards, invoke) => {
      if (!hit && writes.some(write => write.kind === 'model-call')) {
        hit = true;
        captured = { session: structuredClone(writes.find(write => write.kind === 'discovery-final-execution')),
          application: structuredClone(writes.find(write => write.kind === 'discovery-final-application')) };
        throw new Error('before-final-reservation');
      }
      return invoke();
    }, () => runDiscoveryFinalExecution(owner.store, 'p', reference(cell))), /before-final-reservation/);
  });
  assert.ok(hit);
  assert.equal(owner.store.get(discoveryFinalExecutionId(reference(cell))), null);
  assert.ok(captured?.session && captured.application);
  const expected = structuredClone(captured);
  const pending = structuredClone(captured);
  const role = structuredClone(expected.application.value.role);
  const environment = structuredClone(expected.application.value.dispatch);
  const context = structuredClone(expected.application.value.context);
  const refOf = (write: any): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
  const sessionRef = refOf(expected.session), applicationRef = refOf(expected.application);
  let checked = false, callback = false, purposeReads = 0, sessionReads = 0, pendingReads = 0;
  await unchanged(owner, owner.store, async () => {
    await assert.rejects(() => interceptWrites(owner.store, (writes, _guards, invoke) => {
      const call = writes.find(write => write.kind === 'model-call');
      if (!callback || !call) return invoke();
      checked = true;
      const callValue = call.value as Record<string, any>;
      assert.deepEqual(writes.find(write => write.kind === 'discovery-final-execution'), expected.session);
      assert.deepEqual(writes.find(write => write.kind === 'discovery-final-application'), expected.application);
      assert.deepEqual(callValue.requested, expected.application.value.role);
      assert.deepEqual(callValue.finalApplication, refOf(expected.application));
      const request = writes.find(write => write.kind === 'model-request')!;
      assert.deepEqual(callValue.packet.archive,
        JSON.parse((request.value as { text: string }).text).subject.working.archive);
      throw new Error('inspected-final-reservation');
    }, () => researchCall(role, environment, expected.application.value.prompt, context, undefined, {
      store: owner.store, draftId: expected.session.value.binding.draft.id,
      questionId: expected.session.value.binding.question.id,
      get purpose() { return ++purposeReads === 1 ? 'discovery-final' : 'foreign-purpose'; },
      get session() { return ++sessionReads === 1 ? sessionRef : { ...sessionRef, id: 'foreign-session' }; },
      application: applicationRef,
      get finalPending() { pendingReads++; return pending; },
      onContext: subject => {
        callback = true;
        pending.application.value.prompt = 'changed after admission';
        pending.session.value.prompt = 'changed after admission';
        role.actor = 'foreign-after-admission'; environment.projectId = 'foreign-after-admission';
        context.finalContinuation.prepared.hash = '0'.repeat(64);
        applicationRef.hash = '0'.repeat(64);
        subject.working.archive.revision += 1;
      },
    })), /inspected-final-reservation/);
  });
  assert.ok(callback && checked);
  assert.equal(purposeReads, 1); assert.equal(sessionReads, 1); assert.equal(pendingReads, 1);
  assert.equal(owner.store.get(discoveryFinalExecutionId(reference(cell))), null);

  // A competing Store may advance the exact selected scope after admission but
  // before the common reservation. Its own write is allowed; the stale D7
  // attempt must add no session, application, call, ledger entry or wire.
  assert.ok(packet.dossier.route.scope);
  const scope = owner.store.get(packet.dossier.route.scope.ref.id)!;
  const competitor = owner.open(), beforeCalls = money(owner.store), beforeWires = owner.wires();
  let afterCompetingWrite: string | undefined;
  await assert.rejects(() => researchCall(structuredClone(expected.application.value.role),
    structuredClone(expected.application.value.dispatch), expected.application.value.prompt,
    structuredClone(expected.application.value.context), undefined, {
      store: owner.store, draftId: expected.session.value.binding.draft.id,
      questionId: expected.session.value.binding.question.id, purpose: 'discovery-final',
      session: refOf(expected.session), application: refOf(expected.application),
      finalPending: structuredClone(expected),
      onContext: () => {
        competitor.writeMany([{ id: scope.id, kind: scope.kind, expected: scope.revision, value: scope.value }]);
        afterCompetingWrite = all(owner.store);
      },
    }), error => error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code));
  assert.ok(afterCompetingWrite);
  assert.equal(all(owner.store), afterCompetingWrite);
  assert.deepEqual(money(owner.store), beforeCalls); assert.deepEqual(owner.wires(), beforeWires);
  assert.equal(owner.store.get(discoveryFinalExecutionId(reference(cell))), null);
});

test('final paid: one committed reservation is recovered by two Stores without a second claim', async () => {
  await ownerWorld();
  restoreOwnerSeed();
  const packet = ownerPacket;
  const cell = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject,
    { ...finalInput(owner), prompt: finalInput(owner).prompt + ' reservation race' });
  finalAdapter(owner, packet, 'conditional');
  let hit = false;
  await assert.rejects(() => interceptWrites(owner.store, (writes, _guards, invoke) => {
    const cut = !hit && writes.some(write => write.kind === 'model-call');
    const result = invoke();
    if (cut) { hit = true; throw new Error('after-final-reservation'); }
    return result;
  }, () => runDiscoveryFinalExecution(owner.store, 'p', reference(cell))), /after-final-reservation/);
  assert.ok(hit);
  const calls = owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final'
    && namesPrepared((row.value as any).finalContinuation?.prepared, reference(cell)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.value.execution?.phase, 'claimed');
  const execution = owner.store.get<any>(discoveryFinalExecutionId(reference(cell)))!;
  const application = reference(owner.store.get(execution.value.application, 1)!);
  await withCorruptCopy(owner.store, async ({ hot, cold, corrupt }) => {
    const before = all(hot);
    const malformed: unknown[] = [[], { ...calls[0]!.value, request: null }, { ...calls[0]!.value, packet: null }];
    for (const [index, value] of malformed.entries()) {
      await corrupt(reference(calls[0]!), value, async () => {
        await unchangedByStamp(owner, hot, () => assert.rejects(
          () => runDiscoveryFinalExecution(hot, 'p', reference(cell)), error => error instanceof EngineError
            && error.code === (index === 0 ? 'discovery_final_execution_invalid' : 'response_recovery_wire_invalid')));
        if (index === 1) {
          let reads = 0;
          const shifting = { ...application, get id() { return ++reads === 1 ? application.id : 'foreign-application'; } };
          const restarted = cold();
          await unchangedByStamp(owner, restarted, () => assert.rejects(
            () => resumeDiscoveryFinalResearchCall(restarted, shifting), error => error instanceof EngineError
              && error.code === 'response_recovery_wire_invalid'));
          assert.equal(reads, 1);
        }
      });
    }
    assert.equal(all(hot), before);
    // A genuine claimed reservation is not permission to send forever. Move
    // the selected scope from another Store just before authorization's CAS.
    assert.ok(packet.dossier.route.scope);
    const scope = hot.get(packet.dossier.route.scope.ref.id)!;
    const competitor = cold(), beforeEvent = hot.lastEvent();
    const beforeMoney = money(hot), beforeWires = owner.wires();
    let attempted = false;
    await assert.rejects(() => interceptWrites(hot, (writes, guards, invoke) => {
      if (!attempted && writes.some(write => write.kind === 'model-call'
        && write.value.execution?.phase === 'authorized')) {
        attempted = true;
        assert.ok(guards.some(guard => canonical(guard) === canonical(reference(scope))));
        competitor.writeMany([{ id: scope.id, kind: scope.kind, expected: scope.revision, value: scope.value }]);
      }
      return invoke();
    }, () => runDiscoveryFinalExecution(hot, 'p', reference(cell))),
    error => error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code));
    assert.ok(attempted);
    assert.equal(hot.get<ModelCall>(calls[0]!.id)!.value.execution!.phase, 'claimed');
    assert.deepEqual(money(hot), beforeMoney);
    assert.deepEqual(owner.wires(), beforeWires);
    const events = hot.eventsPage(beforeEvent, hot.lastEvent(), 100);
    assert.ok(events.some(event => event.id === scope.id));
    assert.ok(events.every(event => event.id === scope.id || event.kind === 'process-stop'));
  });
  const ledger = money(owner.store).ledger, wires = owner.wires().length, cold = owner.open();
  await unchanged(owner, owner.store, async () => {
    for (const store of [owner.store, cold]) await storeUnchanged(store, async () => {
      const pending = await runDiscoveryFinalExecution(store, 'p', reference(cell), { restoreOnly: true });
      assert.equal(pending.result, null);
    });
  });
  const contenders = await Promise.allSettled([
    runDiscoveryFinalExecution(owner.store, 'p', reference(cell)),
    runDiscoveryFinalExecution(cold, 'p', reference(cell)),
  ]);
  assert.ok(contenders.some(result => result.status === 'fulfilled'));
  const winner = contenders.find(result => result.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled');
  assert.equal(winner.value.result?.result.bundle.verdict.outcome, 'conditional');
  assert.equal(winner.value.result?.result.bundle.verdict.conditions.length, 1);
  assert.equal(owner.wires().length, wires + 1);
  assert.deepEqual(money(owner.store).ledger, ledger);
  assert.equal(owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final'
    && namesPrepared((row.value as any).finalContinuation?.prepared, reference(cell))).length, 1);
  const finalCalls = owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final');
  assert.ok(finalCalls.some(call => call.value.budget?.estimate.basis.some(ref =>
    finalCalls.some(prior => prior.id === ref.id && prior.id !== call.id))));
  await unchanged(owner, owner.store, async () => {
    for (const store of [owner.store, cold]) await storeUnchanged(store, async () => {
      assert.equal((await runDiscoveryFinalExecution(store, 'p', reference(cell), { restoreOnly: true }))
        .result?.result.bundle.verdict.outcome, 'conditional');
    });
  });
});

test('final paid: an authorized uncertain provider is never relaunched', async () => {
  await ownerWorld();
  restoreOwnerSeed();
  const packet = ownerPacket;
  const cell = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject,
    { ...compactFinalInput(owner), prompt: finalInput(owner).prompt + ' authorized cut' });
  finalAdapter(owner, packet, 'go');
  let hit = false;
  await assert.rejects(() => interceptWrites(owner.store, (writes, _guards, invoke) => {
    const cut = !hit && writes.some(write => write.kind === 'model-call'
      && write.value.execution?.phase === 'authorized');
    const result = invoke();
    if (cut) { hit = true; throw new Error('after-final-authorization'); }
    return result;
  }, () => runDiscoveryFinalExecution(owner.store, 'p', reference(cell))),
    error => error instanceof EngineError && error.code === 'process_record_failed');
  assert.ok(hit);
  const call = owner.store.list<ModelCall>('model-call').find(row => row.value.purpose === 'discovery-final'
    && namesPrepared((row.value as any).finalContinuation?.prepared, reference(cell)))!;
  assert.equal(call.value.execution?.phase, 'authorized');
  await unchanged(owner, owner.store, async () => {
    for (const store of [owner.store, owner.open()]) await storeUnchanged(store, async () => {
      await assert.rejects(() => runDiscoveryFinalExecution(store, 'p', reference(cell)),
        error => error instanceof EngineError && error.code === 'model_call_process_uncertain');
    });
  });
});

type NoGoRace = { result: Awaited<ReturnType<typeof runDiscoveryFinalExecution>>; prepared: Ref;
  beforeWire: number; cold: Store; won: boolean; conflict: boolean };
let noGoRace: NoGoRace | undefined;
test('final paid: post-response cut restores the same paid result without a second send', async () => {
  await ownerWorld();
  restoreOwnerSeed();
  const packet = ownerPacket;
  const cell = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject,
    { ...finalInput(owner), prompt: finalInput(owner).prompt + ' cut' });
  finalAdapter(owner, packet, 'no_go');
  const beforeWire = owner.wires().length;
  const original = ok(acquireRunExecution(owner.store, { project: 'p' }));
  await assert.rejects(() => interceptWrites(owner.store, (writes, _guards, invoke) => {
    if (writes.some(write => write.kind === 'discovery-final-paid-result')) throw new Error('cut-after-paid-response');
    return invoke();
  }, () => withResearchRunControl(owner.store, 'p', original.hold,
    () => runDiscoveryFinalExecution(owner.store, 'p', reference(cell)))), /cut-after-paid-response/);
  const calls = money(owner.store), wire = owner.wires().length;
  assert.equal(wire, beforeWire + 1);
  const secondStore = owner.open();
  releaseRunExecution(secondStore, original);
  const replacement = ok(acquireRunExecution(secondStore, { project: 'p' }));
  let won = false, conflict = false;
  const restored = await interceptWrites(owner.store, (writes, guards, invoke) => {
    if (!won && writes.some(write => write.kind === 'discovery-final-paid-result')) {
      won = true;
      secondStore.writeMany(writes, guards);
      try { return invoke(); }
      catch (error) {
        assert.ok(error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code));
        conflict = true;
        throw error;
      }
    }
    return invoke();
  }, () => withResearchRunControl(owner.store, 'p', original.hold,
    () => runDiscoveryFinalExecution(owner.store, 'p', reference(cell))))
    .finally(() => releaseRunExecution(secondStore, replacement));
  assert.ok(won && conflict);
  assert.equal(restored.result?.result.bundle.verdict.outcome, 'no_go');
  assert.deepEqual(money(owner.store), calls); assert.equal(owner.wires().length, wire);
  assert.equal(restored.session.id, discoveryFinalExecutionId(reference(cell)));
  // The next named scenario checks this very winner through both the hot
  // Store and a Store opened only after publication, without a second send.
  noGoRace = { result: restored, prepared: reference(cell), beforeWire, cold: owner.open(), won, conflict };
});

test('final paid: a competing atomic application wins once and is read without another payment', async () => {
  await ownerWorld();
  let race = noGoRace;
  if (!race) {
    await ensureOwnerSeed();
    restoreOwnerSeed();
    const cell = await prepareDiscoveryFinalSession(owner.store, 'p', ownerPacket.subject,
      { ...finalInput(owner), prompt: finalInput(owner).prompt + ' competing application' });
    finalAdapter(owner, ownerPacket, 'no_go');
    const cold = owner.open(), beforeWire = owner.wires().length;
    let won = false, conflict = false;
    const result = await interceptWrites(owner.store, (writes, guards, invoke) => {
      if (!won && writes.some(write => write.kind === 'discovery-final-paid-result')) {
        won = true;
        cold.writeMany(writes, guards);
        try { return invoke(); }
        catch (error) {
          assert.ok(error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code));
          conflict = true;
          throw error;
        }
      }
      return invoke();
    }, () => runDiscoveryFinalExecution(owner.store, 'p', reference(cell)));
    race = noGoRace = { result, prepared: reference(cell), beforeWire, cold, won, conflict };
  }
  const { result, prepared, beforeWire, cold, won, conflict } = race;
  assert.ok(won && conflict);
  assert.equal(result.result?.result.bundle.verdict.outcome, 'no_go');
  assert.equal(owner.wires().length, beforeWire + 1);
  const calls = owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final'
    && namesPrepared((row.value as any).finalContinuation?.prepared, prepared));
  assert.equal(calls.length, 1);
  await unchanged(owner, owner.store, async () => {
    for (const store of [owner.store, cold]) await storeUnchanged(store, async () => {
      const restored = await runDiscoveryFinalExecution(store, 'p', prepared, { restoreOnly: true });
      assert.deepEqual(restored.result, result.result);
    });
  });
  // The next scenario may reuse this genuine paid negative rather than buy
  // another identical one. Its standalone fallback still pays a real call.
});

test('final paid: missing or rehashed physical grounds cannot imitate a paid terminal', async () => {
  await ownerWorld();
  let result = noGoRace?.result;
  if (!result) {
    await ensureOwnerSeed();
    restoreOwnerSeed();
    const cell = await prepareDiscoveryFinalSession(owner.store, 'p', ownerPacket.subject,
      { ...finalInput(owner), prompt: finalInput(owner).prompt + ' paid grounds' });
    finalAdapter(owner, ownerPacket, 'no_go');
    result = await runDiscoveryFinalExecution(owner.store, 'p', reference(cell));
  }
  assert.equal(result.result?.result.bundle.verdict.outcome, 'no_go');
  assert.equal(result.result?.result.bundle.projection, null);
  assert.equal(result.result?.result.bundle.constitution, null);
  assert.ok(result.output);
  const { application, call, request, response } = result.output.value;
  await unchanged(owner, owner.store, async () => {
    assert.throws(() => readDiscoveryFinalResearchExecution(owner.store, 'p', call,
      { ...application, hash: '0'.repeat(64) }), error => error instanceof EngineError);
    assert.throws(() => readDiscoveryFinalResearchExecution(owner.store, 'foreign-project', call, application),
      error => error instanceof EngineError);
    let accessorReads = 0;
    const changingRef = { ...call, get id() { accessorReads++; return call.id; } };
    assert.throws(() => readDiscoveryFinalResearchExecution(owner.store, 'p', changingRef, application),
      error => error instanceof EngineError);
    assert.equal(accessorReads, 0, 'a caller getter is not an immutable address');
    let applicationReads = 0;
    const methods = new Map<PropertyKey, unknown>();
    const changingView = new Proxy(owner.store, { get(target, key) {
      if (key === 'get') return <T>(id: string, revision?: number) => {
        if (id === application.id && revision === application.revision && ++applicationReads > 1) return null;
        return target.get<T>(id, revision);
      };
      if (!methods.has(key)) {
        const value: unknown = Reflect.get(target, key, target);
        methods.set(key, typeof value === 'function' ? value.bind(target) : value);
      }
      return methods.get(key);
    } });
    assert.throws(() => readDiscoveryFinalResearchExecution(changingView, 'p', call, application),
      error => error instanceof EngineError);
    assert.ok(applicationReads > 1, 'an untrusted view re-proves the application');
    await withCorruptCopy(owner.store, async ({ hot, cold, corrupt }) => {
      // Warm the genuine reader before corruption; a fresh Store additionally
      // checks the distinct missing-call and changed-response cold classes.
      assert.deepEqual((await readDiscoveryFinalExecutionAt(hot, 'p', reference(result.session))).result, result.result);
      const originalHistory = all(hot);
      const originalMoney = money(hot), originalWire = owner.wires();
      const db = new DatabaseSync(hot.path);
      const saved = db.prepare('SELECT body, sha256 FROM revisions WHERE entity_id=? AND revision=?')
        .get(application.id, application.revision);
      assert.ok(saved);
      const updateApplication = (body: string, hash: string) => {
        db.exec('BEGIN IMMEDIATE; DROP TRIGGER revisions_no_update; DROP TRIGGER revisions_no_delete');
        try {
          db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
            .run(body, hash, application.id, application.revision);
          db.exec("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END;"
            + "CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END; COMMIT");
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      };
      const originalGet = Store.prototype.get;
      let changedBetweenReads = false;
      try {
        Store.prototype.get = function <T>(this: Store, id: string, revision?: number): Revision<T> | null {
          if (this === hot && id === call.id && !changedBetweenReads) {
            changedBetweenReads = true;
            // A different SQLite connection changes the application after
            // its first proof, before the paid physical call is read.
            updateApplication('null', hashJson(null));
          }
          return originalGet.call(this, id, revision) as Revision<T> | null;
        };
        assert.throws(() => readDiscoveryFinalResearchExecution(hot, 'p', call, application),
          error => error instanceof EngineError);
        assert.ok(changedBetweenReads, 'the independent connection changed state inside the proof');
      } finally {
        Store.prototype.get = originalGet;
        if (changedBetweenReads) updateApplication(String(saved['body']), String(saved['sha256']));
        db.close();
      }
      assert.equal(all(hot), originalHistory);
      assert.deepEqual(money(hot), originalMoney);
      assert.deepEqual(owner.wires(), originalWire);
      const refused = (store: Store) => unchangedByStamp(owner, store, () =>
        assert.rejects(() => readDiscoveryFinalExecutionAt(store, 'p', reference(result.session)),
          error => error instanceof EngineError));
      for (const ground of [application, call, request, response, reference(result.output!)]) {
        await corrupt(ground, null, async () => {
          await refused(hot);
          if (ground === call) await refused(cold());
        });
        const row = owner.store.get<Record<string, unknown>>(ground.id, ground.revision)!;
        await corrupt(ground, { ...row.value, forged: true }, async () => {
          await refused(hot);
          if (ground === response) await refused(cold());
        });
      }
      const origin = owner.store.get(result.session.id, 1)!;
      const claim = owner.store.get(call.id, 1)!;
      for (const ground of [reference(origin), reference(claim), application]) {
        await corrupt(ground, STORED_JSON_NULL, async () => {
          await refused(hot);
          if (ground.id === origin.id) await refused(cold());
        });
      }
      assert.equal(all(hot), originalHistory);
    });
  });
});

test('final paid: missing exact archive, parts, source and paid D6 grounds refuse without writes', async () => {
  await ownerWorld();
  restoreOwnerSeed();
  const packet = ownerPacket;
  const future = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject,
    { ...compactFinalInput(owner), prompt: finalInput(owner).prompt + ' D6 disappears before admission' });
  const futureExecution = discoveryFinalExecutionId(reference(future));
  const missingAssessment = packet.subject.basis.assessment;
  let executionReads = 0, initialAssessmentRead = false, staged = false, missingRead = false;
  const methods = new Map<PropertyKey, unknown>();
  const disappearingD6 = new Proxy(owner.store, { get(target, key) {
    if (key === 'get') return <T>(id: string, revision?: number) => {
      // The first execution lookup precedes the session proof. Its next
      // lookup is the pending reservation; hide D6 only after the producer
      // has actually read it during that initial proof.
      if (id === futureExecution && ++executionReads > 1) staged = true;
      if (id === missingAssessment.id && (revision === undefined || revision === missingAssessment.revision)) {
        if (staged) { missingRead = true; return null; }
        initialAssessmentRead = true;
      }
      return target.get<T>(id, revision);
    };
    if (!methods.has(key)) {
      const value: unknown = Reflect.get(target, key, target);
      methods.set(key, typeof value === 'function' ? value.bind(target) : value);
    }
    return methods.get(key);
  } });
  await unchanged(owner, owner.store, async () => {
    await assert.rejects(() => runDiscoveryFinalExecution(disappearingD6, 'p', reference(future)),
      error => error instanceof EngineError);
  });
  assert.ok(initialAssessmentRead && staged && missingRead);
  assert.equal(owner.store.get(futureExecution), null);
  assert.ok(firstPaidPrepared);
  const cell = owner.store.get<DiscoveryFinalSession>(firstPaidPrepared.id, firstPaidPrepared.revision)!;
  assert.deepEqual(reference(cell), firstPaidPrepared);
  const archive = owner.store.get<any>(cell.value.archive.id, cell.value.archive.revision)!;
  assert.ok(archive.value.parts.length > 0);
  const origin = owner.store.get<any>(discoveryFinalExecutionId(reference(cell)), 1)!;
  const application = reference(owner.store.get(origin.value.application, 1)!);
  const grounds = [cell.value.archive, archive.value.parts[0], packet.subject.basis.assessment,
    packet.subject.basis.brief.source, packet.subject.basis.response];
  await unchanged(owner, owner.store, async () => {
    await withCorruptCopy(owner.store, async ({ hot, cold, corrupt }) => {
      await runDiscoveryFinalExecution(hot, 'p', reference(cell), { restoreOnly: true });
      const admitted = await readDiscoveryFinalDispatchAdmission(hot, application);
      assert.deepEqual(admitted.proven.packet, packet);
      const originalHistory = all(hot);
      const refused = (store: Store, at: Ref) => unchangedByStamp(owner, store, () =>
        assert.rejects(() => runDiscoveryFinalExecution(store, 'p', at, { restoreOnly: true }),
          error => error instanceof EngineError));
      for (const ground of grounds) {
        await corrupt(ground, null, async () => {
          await refused(hot, reference(cell));
          await refused(cold(), reference(cell));
          if (ground === packet.subject.basis.assessment) {
            for (const store of [hot, cold()]) await unchangedByStamp(owner, store, () =>
              assert.rejects(() => readDiscoveryFinalDispatchAdmission(store, application),
                error => error instanceof EngineError));
          }
        });
      }
      await refused(hot, { ...reference(cell), hash: '0'.repeat(64) });
      await refused(cold(), { ...reference(cell), hash: '0'.repeat(64) });
      assert.equal(all(hot), originalHistory);
    });
  });
});

test('final paid: two subjects sharing one brief and role have isolated continuation and paid calls', async () => {
  await ownerWorld();
  restoreOwnerSeed();
  await richWorld();
  const first = ownerPacket;
  const second = await prepareDiscoveryFinalSubject(owner.store, 'p', reference(richD6));
  assert.deepEqual(first.subject.basis.brief, second.subject.basis.brief);
  assert.notDeepEqual(first.subject, second.subject);
  const input = compactFinalInput(owner);
  const a = await prepareDiscoveryFinalSession(owner.store, 'p', first.subject, { ...input, prompt: input.prompt + ' isolate A' });
  const b = await prepareDiscoveryFinalSession(owner.store, 'p', second.subject, { ...input, prompt: input.prompt + ' isolate B' });
  finalAdapter(owner, first, 'go');
  await assert.rejects(() => runDiscoveryFinalExecution(owner.store, 'p', reference(a), { allowance: 1 }),
    error => error instanceof EngineError && error.code === 'research_call_allowance');
  finalAdapter(owner, second, 'no_go');
  await assert.rejects(() => runDiscoveryFinalExecution(owner.store, 'p', reference(b), { allowance: 1 }),
    error => error instanceof EngineError && error.code === 'research_call_allowance');
  const calls = owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final');
  const forCell = (cell: Revision<DiscoveryFinalSession>) => calls.filter(row =>
    namesPrepared((row.value as any).finalContinuation?.prepared, reference(cell)));
  assert.equal(forCell(a).length, 1); assert.equal(forCell(b).length, 1);
  assert.notEqual(forCell(a)[0]!.id, forCell(b)[0]!.id);
  const states = owner.store.list<any>('continuation-state').filter(row =>
    namesPrepared(row.value.finalContinuation?.prepared, reference(a))
      || namesPrepared(row.value.finalContinuation?.prepared, reference(b)));
  assert.equal(states.length, 2); assert.notEqual(states[0]!.id, states[1]!.id);
  const marker = (forCell(a)[0]!.value as any).finalContinuation;
  const saved = continuationState(owner.store, 'p', first.subject.basis.draft.id,
    first.subject.basis.brief.question.id, 'discovery-final', owner.environment.value.implementer.actor,
    null, null, null, null, undefined, marker);
  const foreign = forCell(b)[0]!.value.packet!.archive;
  await unchanged(owner, owner.store, async () => {
    assert.throws(() => continuationMetadata(saved, foreign, owner.store), error => error instanceof EngineError);
    const own = forCell(a)[0]!.value.packet!.archive;
    const ownRow = owner.store.get<any>(own.id, own.revision)!;
    const staged = new Map([[own.id, ownRow]]);
    const wrongRevision = { ...own, revision: own.revision + 1 };
    assert.throws(() => continuationMetadata(saved, wrongRevision, owner.store, staged),
      error => error instanceof EngineError);
    assert.throws(() => continuationMetadata({ ...saved, basis: wrongRevision }, own, owner.store, staged),
      error => error instanceof EngineError);
    const changed = { ...saved.state!.value, finalContinuation: (forCell(b)[0]!.value as any).finalContinuation };
    const disguised = { ...saved.state!, value: changed, hash: hashJson(changed) };
    assert.throws(() => continuationState(mask(owner.store, reference(saved.state!), disguised), 'p',
      first.subject.basis.draft.id, first.subject.basis.brief.question.id, 'discovery-final',
      owner.environment.value.implementer.actor, null, null, null, null, undefined, marker),
    error => error instanceof EngineError);
  });
  const hot = owner.store.get<any>(discoveryFinalExecutionId(reference(a)))!;
  await unchanged(owner, owner.open(), async () => {
    const cold = await readDiscoveryFinalExecutionAt(owner.open(), 'p', reference(hot));
    assert.equal(cold.session.revision, hot.revision);
    assert.deepEqual(cold.session.value.workspace, hot.value.workspace);
  });
});

test('final paid: large real packet is paged through exact paid context before terminal', async () => {
  await richWorld();
  assert.ok(richSeed);
  restoreOwnerWorld(richSeed);
  const packet = await prepareDiscoveryFinalSubject(owner.store, 'p', reference(richD6));
  assert.ok(packet.dossier.materials.length > 0);
  assert.ok(packet.dossier.unknowns.length > 0);
  assert.ok(packet.dossier.contradictions.length > 0);
  assert.ok(packet.dossier.contradictions.every(item => item.sides.length === 2
    && canonical(item.sides[0].address) !== canonical(item.sides[1].address)));
  assert.equal(packet.assessment.value.result.result.verdict, 'return');
  const staged = await prepareDiscoveryFinalResultTransport(owner.store, 'p', packet.subject,
    RESULT_LIMIT, { archive: 'staged' });
  assert.ok(staged.archive);
  const originalChars = canonical(staged.archive.projection).length;
  assert.ok(originalChars > 100_000);
  // Keep the genuinely complete packet larger than its physical share, with
  // roughly two bounded lookups left. The content and both contradiction
  // sides stay real; the fixture does not need a repeated megabyte string.
  const remainder = Math.min(200_000, Math.floor(originalChars / 2));
  const packetChars = Math.max(24_000, originalChars - remainder);
  const input = { ...finalInput(owner), prompt: finalInput(owner).prompt + ' full pages',
    packetChars, limitChars: packetChars + Math.max(64_000, Math.ceil(packetChars / 4)) };
  const cell = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject, input);
  const saved = readArchiveBody(owner.store, owner.store.get<any>(cell.value.archive.id, cell.value.archive.revision)!).body.request;
  assert.equal(canonical(saved).length, originalChars);
  assert.ok(originalChars > packetChars);
  // Choose a page bound from the real missing range on the first wire. This
  // still requires at least two paid reads, without repeating the same proof
  // for an arbitrary sequence of tiny pages.
  finalAdapter(owner, packet, 'conditional', 'two-pages');
  const result = await runDiscoveryFinalExecution(owner.store, 'p', reference(cell), { profile: ownerPilot });
  const recorded = JSON.parse(readFileSync(owner.settings, 'utf8')) as { requested: unknown[] };
  assert.ok(recorded.requested.length > 1);
  assert.ok(recorded.requested.some(request => Array.isArray(request) && request[2] > 0));
  assert.deepEqual(result.result?.packet, packet);
  assert.equal(result.result?.result.bundle.verdict.outcome, 'conditional');
  const wires = owner.wires().filter(wire => namesPrepared(wire.subject?.finalContinuation?.prepared, reference(cell)));
  assert.ok(wires.length > 2);
  assert.ok(wires.every(wire => JSON.stringify(wire).length <= input.limitChars));
  const calls = owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final'
    && namesPrepared((row.value as any).finalContinuation?.prepared, reference(cell)))
    .sort((a, b) => a.value.startedAt - b.value.startedAt || a.id.localeCompare(b.id));
  assert.ok(calls.length > 1);
  const marker = (calls[0]!.value as any).finalContinuation;
  const state = (store: Store) => continuationState(store, 'p', packet.subject.basis.draft.id,
    packet.subject.basis.brief.question.id, 'discovery-final', owner.environment.value.implementer.actor,
    null, null, null, null, undefined, marker);
  const cold = owner.open();
  await unchanged(owner, owner.store, async () => {
    const saved = state(owner.store);
    assert.equal(saved.state!.value.attempts, calls.length);
    assert.notEqual(saved.state!.value.activeCall, calls[0]!.id);
    const later = owner.store.get<DiscoveryFinalExecution>(result.session.id, 2)!;
    const laterApplication = owner.store.get<DiscoveryFinalApplication>(later.value.application, 1)!;
    assert.ok(laterApplication);
    let originDisappeared = false;
    const viewMethods = new Map<PropertyKey, unknown>();
    const disappearingOrigin = new Proxy(owner.store, { get(target, key) {
      if (key === 'get') return <T>(id: string, revision?: number) => {
        if (id === result.session.id && revision === undefined) return later as Revision<T>;
        if (id === later.value.application && revision === 1) { originDisappeared = true; return null; }
        if (id === result.session.id && revision === 1 && originDisappeared) return null;
        return target.get<T>(id, revision);
      };
      if (!viewMethods.has(key)) {
        const value: unknown = Reflect.get(target, key, target);
        viewMethods.set(key, typeof value === 'function' ? value.bind(target) : value);
      }
      return viewMethods.get(key);
    } });
    await unchangedByStamp(owner, owner.store, () => assert.rejects(
      () => runDiscoveryFinalExecution(disappearingOrigin, 'p', reference(cell)),
      error => error instanceof EngineError && error.message === 'The final execution lost its original cursor'));
    assert.ok(originDisappeared, 'the origin disappeared only after the saved page was proved');
    await assert.rejects(() => readDiscoveryFinalDispatchAdmission(
      mask(owner.store, packet.subject.basis.assessment), reference(laterApplication)),
    error => error instanceof EngineError);
    const missingMarker = { ...(calls[0]!.value as unknown as Record<string, unknown>) };
    delete missingMarker.finalContinuation;
    const changed = { ...calls[0]!, value: missingMarker, hash: hashJson(missingMarker as never) };
    const foreign = (replacement: typeof changed) => new Proxy(owner.store, { get(target, key) {
      if (key === 'list') return (kind: string) => target.list(kind).map(row => row.id === replacement.id ? replacement : row);
      if (key === 'get') return (id: string, revision?: number) => id === replacement.id
        && (revision === undefined || revision === replacement.revision) ? replacement : target.get(id, revision);
      const member: unknown = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    assert.throws(() => state(foreign(changed)), error => error instanceof EngineError && error.code === 'continuation_call_missing');
    const noRole = { ...(calls[0]!.value as unknown as Record<string, unknown>), requested: null };
    assert.throws(() => state(foreign({ ...calls[0]!, value: noRole, hash: hashJson(noRole as never) })),
      error => error instanceof EngineError && error.code === 'continuation_call_missing');
    assert.throws(() => state(mask(owner.store, reference(saved.state!),
      { ...saved.state!, value: null, hash: hashJson(null) })),
    error => error instanceof EngineError && error.code === 'continuation_foreign');
    const archive = calls[0]!.value.packet!.archive;
    const row = owner.store.get<any>(archive.id, archive.revision)!;
    assert.throws(() => state(mask(owner.store, archive, { ...row, revision: row.revision + 1 })),
      error => error instanceof EngineError && error.code === 'continuation_foreign');
    const restored = await storeUnchanged(cold, () => readDiscoveryFinalExecutionAt(cold, 'p', reference(result.session)));
    assert.deepEqual(restored.result, result.result);
    assert.deepEqual(restored.session.value.workspace, result.session.value.workspace);
  });
});

test('final paid: exact physical bounds and stopped control refuse a new purchase but preserve the old paid result', async () => {
  await ownerWorld();
  restoreOwnerSeed();
  assert.ok(firstPaidPrepared);
  const packet = ownerPacket;
  // The physical cap applies to the exact first wire, independently of how
  // much dossier context it carries. Full multi-page delivery is tested above.
  const input = compactFinalInput(owner);
  const newCell = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject,
    { ...input, prompt: input.prompt + ' physical limit and stopped control' });
  const { projectId: _projectId, ...settings } = ownerPilot.value;
  // Measure the real complete wire, not just its subject. Equal physical cap
  // admits that exact size; one unit less must either re-pack within the cap
  // or refuse before any reservation or provider dispatch.
  const measure = (profile: typeof ownerPilot) => unchangedByStamp(owner, owner.store, () =>
    previewResearch(() => runDiscoveryFinalExecution(owner.store, 'p', reference(newCell), { profile })));
  const baselineWire = await measure(ownerPilot);
  assert.equal(baselineWire.chars, baselineWire.input.length);
  const exactLimit = configureReaderPilot(owner.store, owner.engine.environments, 'p',
    { ...settings, physicalLimits: { ...settings.physicalLimits!, maxRequestChars: baselineWire.chars } },
    owner.store.get(ownerPilot.id)!.revision);
  const exactWire = await measure(exactLimit);
  assert.equal(exactWire.chars, baselineWire.chars);
  const belowLimit = configureReaderPilot(owner.store, owner.engine.environments, 'p',
    { ...settings, physicalLimits: { ...settings.physicalLimits!, maxRequestChars: baselineWire.chars - 1 } },
    owner.store.get(ownerPilot.id)!.revision);
  // Exercise the actual purchase door once at one unit less. If packing
  // succeeds, inspect its real claim and cut just before the atomic write;
  // otherwise its physical-limit refusal itself proves no purchase occurs.
  let needsPhysicalRefusal = false;
  let reachedReservation = false;
  await unchanged(owner, owner.store, async () => {
    await assert.rejects(() => interceptWrites(owner.store, writes => {
      const claim = writes.find(write => write.kind === 'model-call');
      assert.ok(claim, 'a repacked wire must reach the actual reservation');
      assert.ok(claim.value.request.chars <= baselineWire.chars - 1);
      reachedReservation = true;
      throw new Error('bounded-wire-before-reservation');
    }, () => runDiscoveryFinalExecution(owner.store, 'p', reference(newCell), { profile: belowLimit })), error => {
      if (error instanceof Error && error.message === 'bounded-wire-before-reservation') {
        assert.ok(reachedReservation);
        needsPhysicalRefusal = true;
        return true;
      }
      if (error instanceof EngineError && error.code === 'research_context_capacity') {
        needsPhysicalRefusal = true;
        return true;
      }
      return error instanceof EngineError && ['pilot_core_limit', 'budget_transport_limit'].includes(error.code);
    });
  });
  if (needsPhysicalRefusal) {
    const limited = configureReaderPilot(owner.store, owner.engine.environments, 'p',
      { ...settings, physicalLimits: { ...settings.physicalLimits!, maxRequestChars: 1 } },
      owner.store.get(ownerPilot.id)!.revision);
    await unchanged(owner, owner.store, async () => {
      await assert.rejects(() => runDiscoveryFinalExecution(owner.store, 'p', reference(newCell), { profile: limited }),
        error => error instanceof EngineError && ['pilot_core_limit', 'budget_transport_limit'].includes(error.code));
    });
  }
  assert.equal(owner.store.get(discoveryFinalExecutionId(reference(newCell))), null);
  const heldCell = await prepareDiscoveryFinalSession(owner.store, 'p', packet.subject,
    { ...input, prompt: input.prompt + ' claimed before stopped control' });
  const original = ok(acquireRunExecution(owner.store, { project: 'p' }));
  let claimed = false;
  await assert.rejects(() => interceptWrites(owner.store, (writes, _guards, invoke) => {
    const cut = !claimed && writes.some(write => write.kind === 'model-call');
    const result = invoke();
    if (cut) { claimed = true; throw new Error('claimed-before-control-stop'); }
    return result;
  }, () => withResearchRunControl(owner.store, 'p', original.hold,
    () => runDiscoveryFinalExecution(owner.store, 'p', reference(heldCell)))), /claimed-before-control-stop/);
  assert.ok(claimed);
  const secondStore = owner.open();
  releaseRunExecution(secondStore, original);
  const replacement = ok(acquireRunExecution(secondStore, { project: 'p' }));
  try {
    await unchanged(owner, owner.store, async () => {
      await storeUnchanged(owner.store, () => assert.rejects(
        () => withResearchRunControl(owner.store, 'p', original.hold,
          () => runDiscoveryFinalExecution(owner.store, 'p', reference(heldCell))),
        error => error instanceof EngineError && error.code === 'run_control_changed'));
      const paid = await storeUnchanged(owner.store, () => withResearchRunControl(owner.store, 'p', original.hold,
        () => runDiscoveryFinalExecution(owner.store, 'p', firstPaidPrepared)));
      assert.equal(paid.result?.result.bundle.verdict.outcome, 'go');
    });
  } finally { releaseRunExecution(secondStore, replacement); }
  ok(stopRun(owner.store, { project: 'p' }));
  const heldCalls = owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final'
    && namesPrepared((row.value as any).finalContinuation?.prepared, reference(heldCell)));
  assert.equal(heldCalls.length, 1);
  const heldClaim = structuredClone(heldCalls[0]!);
  assert.equal(heldClaim.value.execution?.phase, 'claimed');
  // The distinct new-session and existing-claim doors are each exercised on
  // one Store; both Stores still independently recover the previous payment.
  const stoppedCold = owner.open();
  await unchanged(owner, owner.store, async () => {
    for (const store of [owner.store, stoppedCold]) {
      const paid = await storeUnchanged(store, () => runDiscoveryFinalExecution(store, 'p', firstPaidPrepared));
      assert.equal(paid.result?.result.bundle.verdict.outcome, 'go');
    }
    await storeUnchanged(owner.store, () => assert.rejects(
      () => runDiscoveryFinalExecution(owner.store, 'p', reference(newCell)),
      error => error instanceof EngineError && error.code === 'run_stopped'));
    await storeUnchanged(stoppedCold, () => assert.rejects(
      () => runDiscoveryFinalExecution(stoppedCold, 'p', reference(heldCell)),
      error => error instanceof EngineError && error.code === 'run_stopped'));
    assert.equal(owner.store.get(discoveryFinalExecutionId(reference(newCell))), null);
    assert.equal(owner.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final'
      && namesPrepared((row.value as any).finalContinuation?.prepared, reference(newCell))).length, 0);
    assert.deepEqual(owner.store.get<ModelCall>(heldClaim.id), heldClaim);
  });
});


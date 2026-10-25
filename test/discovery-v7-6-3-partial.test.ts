import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { VARIANT_OWNER_ACTION, variantStateId, readVariantHandoffStructural, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet, type VariantNone } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { V7_STAGE_TOKEN_CEILING, V7_AXES } from '../src/discovery/v7-contracts.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { readVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { variantRecordId } from '../src/discovery/discovery-variants.js';
import { EngineError } from '../src/errors.js';
import { canonical, hashJson } from '../src/canonical.js';
import { producePartialDossier, readPartialDossier, readDossierManifestStructural, projectDossierManifest, DOSSIER_MANIFEST_KIND, type DossierManifest } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { applyDiscoveryAssessment, proveAppliedAttemptClassification } from '../src/discovery/v7-progress.js';
import { attemptAccountKey } from '../src/discovery/v7-attempt-assessment.js';
import type { PaidDiscoveryAttemptsAssessment } from '../src/discovery/research-model.js';

// Include orphaned history as well as current heads after the explicit missing-head corruptions.
function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
      revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id, revision').all() });
  } finally { db.close(); }
}
async function setup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry')], initialMode: 'questions'|'bypass'|null = 'questions') {
  const f = discoveryFixture(t, 'omg-63partial-');
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')), s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')), q=r.subject.question?.id??'probe';
let prior=[];try{prior=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line))}catch{}
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research=s.actions?.[prior.filter(row=>!row.subject.assessmentSubject&&!row.subject.variantSubject).length]??{action:'answer',question:q,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=q;
if(r.subject.variantSubject?.kind==='decision')research=s.reject?{action:'reject_all',reason:'Model rejects this exact set'}:{action:'choose',key:'v1',reason:'Model chooses the bounded member'};
else if(r.subject.variantSubject){
 const grounds=[r.subject.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];
 research=s.none?{action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds}],searchLimits:['Saved sweep only'],unknowns:['Demand unknown']}
 :{action:'variants',variants:[{key:'v1',title:'Bounded variant',proposal:{bounded:true},criteria:Object.fromEntries(keys.map(key=>[key,{conclusion:'Bounded model proposal',grounds,assumptions:[],unknowns:['Demand unknown'],quantity:null}]))}],scale:Object.fromEntries(keys.map(key=>[key,'Same bounded scale'])),comparison:'One bounded option',recommendation:{key:'v1',reason:'Only bounded candidate'},searchLimits:['Saved sweep only'],unknowns:['Demand unknown']};
}
if(r.subject.role==='reader'){if(s.readerFail)process.exit(42);research={selections:r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]})),unresolved:[]}};
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet, attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 research={verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected:[],newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
if(r.subject.assessmentSubject&&s.classification){
 const entries=r.subject.assessmentSubject.packet.entries,all=s.classification.filter(c=>entries.some(e=>e.attempt.id===c.claim.container.id));
 const accepted=all.filter(c=>c.accepted).map(c=>({claim:c.claim,reason:'Supported exact hypothesis or addressed unknown'}));
 research={verdict:'supported',reasons:['Exact material classification'],return:null,novelty:{attempts:entries.map(e=>({attempt:e.attempt,reason:'Exact attempt'})),accepted,rejected:all.filter(c=>!c.accepted).map(c=>({claim:c.claim,reason:'Counterargument not supported'})),newContent:accepted,duplicates:[],noProgress:entries.filter(e=>!accepted.some(c=>c.claim.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No accepted addition'})),transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, 'p', questions);
  function mode(value: 'questions'|'bypass', store = f.store) {
    const request = { project: 'p', mode: value, previous: store.get('project-mode:p') ? reference(store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(store), invitation = issueProjectModeInvitation(store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const initial = initialMode === null ? null : mode(initialMode);
  if (initial) {
    const cal = f.store.write({ id: 'variant-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
    for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
      { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? {snapshot: reference(cal)} : {set: reference(cal)}), mode: reference(initial), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  }
  writeFileSync(wire, '');
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const generationCalls = () => wires().filter(row => row.subject.variantSubject);
  const nextEdition = (store = f.store) => {
    const discovery = new Discovery(store), engine = new ProductEngine(store);
    const plan = store.get<Question>(v.plan.id)!; discovery.reopen(plan.id, plan.revision);
    const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(v.draft.id)!;
    const source = discovery.evidence.document('p', 'edition-two', 'New accepted edition', 'text/plain', 0);
    answerDiscoveryFixture(engine, 'p', draft, question, validPlan(v.frameRef, questions, 2, v.planAnswer), source);
    return store.get<Question>(plan.id)!.value.answer!;
  };
  return { ...f, v, environment, command, run, wires, generationCalls, configure, mode, initial, nextEdition };
}
const money = (store: Store) => store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind)).flatMap(row => store.history(row.id));
function choiceScope(f: Awaited<ReturnType<typeof setup>>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  return { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set),
    mode: reference(f.store.get('project-mode:p')!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: kind === 'choose' ? { kind, member: set.value.members[0]!, reason: 'Authorized owner chooses the member' }
      : { kind, reason: 'Authorized owner rejects the exact set' } };
}
function owner(store: Store, scope: VariantChoiceScope) {
  const sessions = new VariantChoiceSessions(store), issued = issueVariantChoiceInvitation(store, scope);
  assert.ok(issued.ok); if (!issued.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
  assert.ok(login.ok); if (!login.ok) assert.fail('Expected successful owner exchange');
  const act = answerVariantChoice(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok); return act;
}
async function saved(f: Awaited<ReturnType<typeof setup>>, run: Revision<import('../src/discovery/research-model.js').ResearchRun>) {
  const pause = JSON.parse(run.value.error!);
  assert.ok(pause.handoff, JSON.stringify(run.value));
  const proof = await readVariantHandoff(f.store, 'p', pause.handoff);
  assert.equal(proof.verification, 'proven'); assert.equal(proof.record.value.next, pause.next);
  assert.deepEqual(reference(proof.record), pause.handoff); return proof.record;
}
async function route(t: test.TestContext, kind: 'no_variants'|'model'|'owner'|'limit'|'limit-no-mode') {
  const f = await setup(t, undefined, kind === 'limit-no-mode' ? null : kind === 'model' ? 'bypass' : 'questions');
  if (kind === 'no_variants') f.configure({none:true});
  if (kind === 'model') f.configure({reject:true});
  if (kind.startsWith('limit')) f.configure({assessorTokens:V7_STAGE_TOKEN_CEILING-1000});
  let run = await f.run(kind.startsWith('limit') ? 2 : 3);
  if (kind === 'owner') { owner(f.store, choiceScope(f,'reject_all')); run = await f.run(1,f.open(),true); }
  return {...f, handoff:await saved(f,run)};
}
async function unchanged(f: Awaited<ReturnType<typeof route>>, store: Store, invoke:()=>Promise<unknown>, refusal=false) {
  const before=history(store), calls=money(store), wire=f.wires();
  if(refusal) await assert.rejects(invoke, error=>error instanceof EngineError);
  else await invoke();
  assert.equal(history(store),before);assert.deepEqual(money(store),calls);assert.deepEqual(f.wires(),wire);
}
for(const kind of ['no_variants','model','owner','limit','limit-no-mode'] as const)
test(`6.3 partial: real ${kind} route publishes its exact partial dossier and historical hot/cold fixed point`,async t=>{
  const f=await route(t,kind), link=reference(f.handoff), proof=await producePartialDossier(f.store,'p',link);
  assert.equal(proof.repeated,false);assert.equal(proof.verification,'partial');
  assert.equal(proof.record.value.completeness,'partial');assert.deepEqual(proof.record.value.draft,f.handoff.value.draft);
  assert.deepEqual(proof.record.value.frame,f.v.frameRef);assert.deepEqual(proof.record.value.plan,f.v.planAnswer);
  const expected=kind.startsWith('limit')?'budget':kind==='no_variants'?'no_variants':'reject_all';
  assert.equal(proof.record.value.reasons[0]!.code,expected);assert.deepEqual(proof.record.value.reasons[0]!.grounds[0],link);
  if(expected==='budget')for(const ground of f.handoff.value.stop!.grounds)
    assert.ok(proof.record.value.reasons[0]!.grounds.some(r=>canonical(r)===canonical(ground)));
  assert.deepEqual(Object.keys(proof.record.value.axes).sort(),[...V7_AXES].sort());
  f.mode('questions');f.nextEdition();
  for(const store of [f.store,f.open()]) {
    await unchanged(f,store,async()=>assert.deepEqual((await readPartialDossier(store,'p',reference(proof.record))).record,proof.record));
    await unchanged(f,store,async()=>assert.deepEqual(await producePartialDossier(store,'p',link),{...proof,repeated:true}));
  }
});

test('6.3 partial: absent, null, foreign and structural handoffs never authorize a dossier',async t=>{
  const f=await route(t,'no_variants');
  for(const handoff of [undefined,null,{}, {...reference(f.handoff),hash:'0'.repeat(64)}])
    await unchanged(f,f.store,()=>producePartialDossier(f.store,'p',handoff as Ref),true);
  await unchanged(f,f.store,()=>producePartialDossier(f.store,'other',reference(f.handoff)),true);
  const fakeValue={...f.handoff.value,result:{...f.handoff.value.result!,hash:'0'.repeat(64)}};
  const fake=f.store.write({id:variantRecordId('discovery-variant-handoff',fakeValue),kind:'discovery-variant-handoff',expected:0,value:fakeValue});
  await unchanged(f,f.store,()=>producePartialDossier(f.store,'p',reference(fake)),true);
  // Honest hashes and complete structural forms are still not a paid generation proof.
  const imitationValue=structuredClone(f.store.get<VariantNone>(f.handoff.value.result!.id)!.value);
  imitationValue.reasons[0]!.message='Explicit negative imitation of a generation result';
  const imitation=f.store.write({id:variantRecordId('discovery-variant-none',imitationValue),kind:'discovery-variant-none',expected:0,value:imitationValue});
  const handoffValue={...f.handoff.value,result:reference(imitation)};
  const structural=f.store.write({id:variantRecordId('discovery-variant-handoff',handoffValue),kind:'discovery-variant-handoff',expected:0,value:handoffValue});
  assert.equal(readVariantHandoffStructural(f.store,'p',reference(structural)).verification,'structural');
  for(const store of [f.store,f.open()])await unchanged(f,store,()=>producePartialDossier(store,'p',reference(structural)),true);
});
for(const change of ['frame','plan','mode','mode-missing','frame-missing'] as const)
test(`6.3 partial: new publication refuses ${change} after the real handoff without writes or sends`,async t=>{
  const f=await route(t,'no_variants'), frame=f.store.list<Question>('question').find(q=>q.value.draftId===f.v.draft.id&&q.value.spec.field==='frame')!;
  if(change==='plan')f.nextEdition();
  else if(change==='mode')f.mode('bypass');
  else if(change==='frame')f.discovery.reopen(frame.id,frame.revision);
  else {const db=new DatabaseSync(f.store.path);try{db.prepare('DELETE FROM heads WHERE entity_id=?').run(change==='mode-missing'?'project-mode:p':frame.id);}finally{db.close();}}
  for(const store of [f.store,f.open()])await unchanged(f,store,()=>producePartialDossier(store,'p',reference(f.handoff)),true);
});
for(const change of ['frame','plan','mode','selection'] as const)
test(`6.3 partial: second Store changing ${change} in the publication window loses the atomic write`,async t=>{
  const f=await route(t,change==='selection'?'owner':'no_variants'), other=f.open(), write=f.store.writeMany.bind(f.store);
  let after='',wire:unknown,calls:unknown;
  f.store.writeMany=((writes,guards)=>{
    if(!after&&writes.some(w=>w.kind===DOSSIER_MANIFEST_KIND)){
      if(change==='frame'){const q=other.list<Question>('question').find(q=>q.value.draftId===f.v.draft.id&&q.value.spec.field==='frame')!;new Discovery(other).reopen(q.id,q.revision);}
      else if(change==='plan')f.nextEdition(other);
      else if(change==='mode')f.mode('bypass',other);
      else {const prior=other.get<VariantState>(variantStateId('p',f.v.draft.id))!, decision=other.get<any>(prior.value.decision!.id)!;
        owner(other,{...choiceScope(f,'choose'),operation:'revise',previous:reference(decision),expectedSelection:reference(prior)});}
      after=history(other);wire=f.wires();calls=money(other);
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  try{await assert.rejects(()=>producePartialDossier(f.store,'p',reference(f.handoff)),{code:'input_stale'});}finally{f.store.writeMany=write;}
  assert.ok(after);assert.equal(history(f.store),after);assert.deepEqual(f.wires(),wire);assert.deepEqual(money(f.store),calls);
  assert.equal(f.store.list(DOSSIER_MANIFEST_KIND).length,0);
});

test('6.3 partial: a saved imitation cannot change exact grounds, reason or axes',async t=>{
  const f=await route(t,'no_variants'), proof=await producePartialDossier(f.store,'p',reference(f.handoff));
  for(const mutate of [(v:DossierManifest)=>{v.reasons[0]!.code='stall';},(v:DossierManifest)=>{v.reasons[0]!.message='Caller reason';},
    (v:DossierManifest)=>{v.reasons[0]!.grounds.pop();},(v:DossierManifest)=>{v.plan.hash='0'.repeat(64);},
    (v:DossierManifest)=>{v.axes.industry.depth='brief';},(v:DossierManifest)=>{v.frame.hash='0'.repeat(64);}]){
    const value=structuredClone(proof.record.value);mutate(value);const projected=projectDossierManifest(value);
    if(projected.id===proof.record.id)continue;
    const fake=f.store.write({id:projected.id,kind:DOSSIER_MANIFEST_KIND,expected:0,value:projected.value});
    assert.equal(readDossierManifestStructural(f.store,'p',reference(fake)).verification,'structural');
    for(const store of [f.store,f.open()])await unchanged(f,store,()=>readPartialDossier(store,'p',reference(fake)),true);
  }
});



async function withMaterials(t:test.TestContext, limit=false) {
  const f=await setup(t,[planQuestion('q-one','industry'),planQuestion('q-two','industry')]), classifications:{claim:ClaimAddress;accepted:boolean}[]=[], write=f.store.writeMany.bind(f.store);
  f.store.writeMany=((writes,guards)=>{
    const rows=write(writes,guards);
    for(const row of rows)if(row.kind==='research-attempt'&&(row.value as any).end.type==='submitted') {
      const claims=(row.value as any).end.value.claims as any[];
      classifications.push(...claims.map((c,index)=>({claim:{project:'p',container:reference(row),containerKind:row.kind,pointer:`/claims/${index}`,claimId:c.id},accepted:c.id!=='counter'})));
      f.configure({classification:classifications});
    }
    return rows;
  }) as typeof f.store.writeMany;
  const claim=(id:string,text:string)=>({id,kind:'hypothesis',text,axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-one'}],scope:{variants:'common'},basis:{howToVerify:'Compare independent sources'}});
  const unknown={...claim('unknown','Demand is unknown'),kind:'unknown',basis:{origin:'Saved research',unknownId:'demand',question:'What is demand?',affects:['market'],consumer:'product-owner',blocksCurrentStage:true,moment:'om-pass',closeCriterion:'Obtain independent evidence'}};
  const action=(claims:unknown[])=>({action:'answer',question:'$selected',value:{type:'submitted',contract:'discovery-claims/v7',value:{claims}},citations:[]});
  f.configure({actions:[action([claim('positive','A is plausible'),unknown])]});
  await f.run(1);assert.equal(classifications.length,2);
  const counter={...claim('counter','A has an unsupported counterargument'),refutedBy:[classifications[0]!.claim]};
  f.configure({actions:[action([]),action([counter])],...(limit?{assessorTokens:V7_STAGE_TOKEN_CEILING-1000}:{})});
  const run=await f.run(1);f.store.writeMany=write;assert.equal(classifications.length,3,JSON.stringify({pauseCode:run.value.pauseCode,error:run.value.error,actions:f.wires().map(w=>w.subject.variantSubject?.kind??(w.subject.assessmentSubject?'assessment':w.subject.question?.id))}));
  if(limit)return {...f,handoff:await saved(f,run),classifications};
  f.configure({none:true});
  const handoff=await saved(f,await f.run(5));
  return {...f,handoff,classifications};
}
for(const limit of [false,true])test(`6.3 partial: ${limit?'paid pre-generation limit':'paid no_variants'} retains all claims, addressed unknown and both proven contradiction sides`,async t=>{
  const f=await withMaterials(t,limit), proof=await producePartialDossier(f.store,'p',reference(f.handoff));
  assert.equal(proof.materials.length,3);assert.deepEqual(proof.materials.map(m=>m.status).sort(),['accepted','accepted','rejected']);
  assert.equal(proof.record.value.axes.industry.claims.length,3);assert.equal(proof.record.value.unknowns.length,1);
  assert.deepEqual(proof.record.value.unknowns[0],{claim:f.classifications[1]!.claim,unknownId:'demand',consumer:'product-owner',moment:'om-pass',blocksCurrentStage:true});
  assert.equal(proof.contradictions.length,1);assert.deepEqual(proof.contradictions[0]!.sides.map(s=>s.status),['accepted','rejected']);
  assert.deepEqual(proof.record.value.contradictions[0]!.resolution,{state:'open'});
  assert.deepEqual(proof.record.value.contradictions[0]!.planQuestionIds,['q-one']);
  const cold=f.open(), readList=cold.list.bind(cold);
  cold.list=()=>assert.fail('Historical dossier proof must not discover material from current heads');
  try{assert.deepEqual((await readPartialDossier(cold,'p',reference(proof.record))).record,proof.record);}finally{cold.list=readList;}
  for(const mutate of [(v:DossierManifest)=>{
    // Explicit negative imitation: hide the unresearched axes to satisfy only the structural complete form.
    v.completeness='complete';v.reasons=[];
    for(const axis of Object.values(v.axes))if(!axis.claims.length){axis.depth='inapplicable';axis.reason='Imitated exclusion of an unresearched axis';}
  },(v:DossierManifest)=>{v.unknowns=[];},(v:DossierManifest)=>{v.contradictions=[];},
    (v:DossierManifest)=>{v.axes.industry.claims=v.axes.industry.claims.filter(c=>c.claimId!=='counter');v.contradictions=[];},
    (v:DossierManifest)=>{v.contradictions[0]!.sides[1].status='accepted';}]){
    const value=structuredClone(proof.record.value);mutate(value);const projected=projectDossierManifest(value);
    const fake=f.store.write({id:projected.id,kind:DOSSIER_MANIFEST_KIND,expected:0,value:projected.value});
    for(const store of [f.store,f.open()])await unchanged(f,store,()=>readPartialDossier(store,'p',reference(fake)),true);
  }
});


test('6.3 partial: a real chosen deep route is refused; a later proven rejection has a new immutable dossier address',async t=>{
  const chosen=await setup(t,undefined,'bypass'), choose=await saved(chosen,await chosen.run(3));
  assert.equal(choose.value.next,'deep');
  for(const store of [chosen.store,chosen.open()])await unchanged({...chosen,handoff:choose},store,
    ()=>producePartialDossier(store,'p',reference(choose)),true);
  const f=await route(t,'owner'), first=await producePartialDossier(f.store,'p',reference(f.handoff));
  const state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
  const next=owner(f.store,{...choiceScope(f,'reject_all'),operation:'revise',previous:state.value.decision!,expectedSelection:reference(state)});
  const handoff=(await publishVariantHandoff(f.store,'p',{draft:next.decision.value.draft,result:next.decision.value.set,decision:reference(next.decision),scope:null})).record;
  const second=await producePartialDossier(f.store,'p',reference(handoff));
  assert.notEqual(first.record.id,second.record.id);assert.equal(second.record.revision,1);
  for(const store of [f.store,f.open()])await unchanged(f,store,async()=>{
    assert.deepEqual((await readPartialDossier(store,'p',reference(first.record))).record,first.record);
    assert.deepEqual((await producePartialDossier(store,'p',reference(f.handoff))).record,first.record);
  });
});


async function paidBeforeProgress(t: test.TestContext, restoreBeforeHandoff = false) {
  const f = await setup(t, [planQuestion('q-one', 'industry'), planQuestion('q-two', 'industry')]);
  const claim = {id:'awaiting-p', kind:'hypothesis', text:'Paid MR is not applied acceptance', axis:'industry',
    planQuestions:[{planAnswer:f.v.planAnswer, planQuestionId:'q-one'}], scope:{variants:'common'},
    basis:{howToVerify:'Independent evidence'}};
  f.configure({assessorTokens:V7_STAGE_TOKEN_CEILING-1000, actions:[{action:'answer', question:'$selected',
    value:{type:'submitted', contract:'discovery-claims/v7', value:{claims:[claim]}}, citations:[]}]});
  const write = f.store.writeMany.bind(f.store); let cut = false, address: ClaimAddress | undefined;
  f.store.writeMany = ((writes, guards) => {
    if (!cut && writes.some(w => w.kind === 'v7-progress-application')) {
      cut = true; throw new EngineError('partial_paid_cut', 'Paid MR saved; stop immediately before atomic P');
    }
    const rows = write(writes, guards);
    for (const row of rows) if (row.kind === 'research-attempt' && (row.value as any).end.type === 'submitted') {
      address = {project:'p', container:reference(row), containerKind:row.kind, pointer:'/claims/0', claimId:claim.id};
      f.configure({classification:[{claim:address, accepted:true}]});
    }
    return rows;
  }) as typeof f.store.writeMany;
  try { await f.run(1); }
  catch (error) { if (!(error instanceof EngineError) || error.code !== 'partial_paid_cut') throw error; }
  finally { f.store.writeMany = write; }
  assert.ok(cut); assert.ok(address);
  const paid = f.store.list<PaidDiscoveryAttemptsAssessment>('discovery-assessment');
  assert.equal(paid.length, 1); assert.equal(f.store.list('v7-progress-application').length, 0);
  const restored = restoreBeforeHandoff ? applyDiscoveryAssessment(f.store, 'p', reference(paid[0]!)) : null;
  const handoff = (await publishVariantHandoff(f.store, 'p', {draft:reference(f.store.get(f.v.draft.id)!),
    result:null, decision:null, scope:null, earlyLimit:true})).record;
  assert.equal((await readVariantHandoff(f.store, 'p', reference(handoff))).verification, 'proven');
  return {...f, handoff, paid:paid[0]!, address:address!, restored};
}

test('6.3-PARTIAL-01: paid MR before P preserves unassessed material and its exact historical fixed point after real recovery', async t => {
  const f = await paidBeforeProgress(t), handoff = reference(f.handoff);
  const first = await producePartialDossier(f.store, 'p', handoff);
  assert.deepEqual(first.materials, [{claim:f.address, status:'unassessed', assessment:null}]);
  assert.deepEqual(first.assessments, []);
  assert.ok(first.record.value.reasons[0]!.grounds.some(r => canonical(r) === canonical(reference(f.paid))));
  for (const store of [f.store, f.open()]) await unchanged(f, store, async () => {
    const {repeated:_, ...proof} = first;
    assert.deepEqual(await readPartialDossier(store, 'p', reference(first.record)), proof);
    assert.deepEqual(await producePartialDossier(store, 'p', handoff), {...first, repeated:true});
  });
  const wire = f.wires(), calls = money(f.store);
  const recovery = applyDiscoveryAssessment(f.open(), 'p', reference(f.paid));
  assert.equal(recovery.repeated, false);
  assert.equal(proveAppliedAttemptClassification(f.store, f.address).status, 'accepted');
  assert.deepEqual(f.wires(), wire); assert.deepEqual(money(f.store), calls);
  for (const store of [f.store, f.open()]) await unchanged(f, store, async () => {
    const read = await readPartialDossier(store, 'p', reference(first.record));
    assert.deepEqual(read.record, first.record); assert.deepEqual(read.materials, first.materials); assert.deepEqual(read.assessments, []);
    assert.deepEqual(await producePartialDossier(store, 'p', handoff), {...first, repeated:true});
  });
});

for (const lost of ['application', 'account', 'substituted-account'] as const)
test(`6.3-PARTIAL-01: proof fault (${lost}) refuses without an unassessed downgrade`, async t => {
  const f = await paidBeforeProgress(t, true), first = await producePartialDossier(f.store, 'p', reference(f.handoff));
  assert.equal(first.materials[0]!.status, 'accepted'); assert.deepEqual(first.assessments, [reference(f.paid)]);
  const id = lost === 'application' ? f.restored!.applications[0]!.id : attemptAccountKey(f.paid.value.subject.packet, f.address.container);
  assert.ok(first.record.value.reasons[0]!.grounds.some(r => r.id === id));
  // Explicit negative read faults: immutable Store history itself is not rewritten.
  for (const store of [f.store, f.open()]) {
    const get = store.get.bind(store), original = get<Record<string, unknown>>(id, 1)!;
    const badValue = {...original.value, streak:-1};
    const substituted = {...original, value:badValue, hash:hashJson(badValue)};
    store.get = ((key, revision) => key === id ? lost === 'substituted-account' ? substituted : null : get(key, revision)) as typeof store.get;
    try {
      await unchanged(f, store, () => readPartialDossier(store, 'p', reference(first.record)), true);
      await unchanged(f, store, () => producePartialDossier(store, 'p', reference(f.handoff)), true);
    } finally { store.get = get; }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { V7_STAGE_TOKEN_CEILING, V7_AXES } from '../src/discovery/v7-contracts.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { readVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { EngineError } from '../src/errors.js';
import { canonical } from '../src/canonical.js';
import { producePartialDossier, readPartialDossier, DOSSIER_MANIFEST_KIND } from '../src/discovery/dossier-manifest.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';

// Include orphaned history as well as current heads after the explicit missing-head corruptions.
function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
      revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id, revision').all() });
  } finally { db.close(); }
}
async function setup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry')], initialMode: 'questions'|'bypass'|null = 'questions') {
  const f = discoveryFixture(t, 'omg-63runner-');
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
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { discoveryInspection } from '../src/discovery/discovery-outcome.js';
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

const currentRun = (f: Awaited<ReturnType<typeof setup>>, store = f.store) =>
  store.list<import('../src/discovery/research-model.js').ResearchRun>('research-run').find(r => r.value.draftId === f.v.draft.id)!;
const drive = (f: Awaited<ReturnType<typeof setup>>, store = f.store) => new EarlyStageDriver(new ProductEngine(store))
  .run({project:'p', draftId:f.v.draft.id, maxTurns:1, maxCalls:1});
async function inert(f: Awaited<ReturnType<typeof setup>>, store: Store, action:()=>Promise<unknown>) {
  const before=history(store), paid=money(store), wire=f.wires();
  const value=await action();
  assert.equal(history(store),before);assert.deepEqual(money(store),paid);assert.deepEqual(f.wires(),wire);return value;
}
async function partial(f: Awaited<ReturnType<typeof setup>>) {
  const run=currentRun(f), pause=JSON.parse(run.value.error!);
  assert.equal(run.value.pauseCode,'research_dossier_assessment_unavailable',JSON.stringify(run.value));
  assert.equal(pause.completeness,'partial');
  const proof=await readPartialDossier(f.store,'p',pause.dossier);
  assert.deepEqual(reference(proof.handoff),pause.handoff);assert.equal(proof.handoff.value.draft.id,f.v.draft.id);
  assert.deepEqual(proof.record.value.frame,f.v.frameRef);assert.deepEqual(proof.record.value.plan,f.v.planAnswer);
  assert.equal(proof.record.value.completeness,'partial');
  assert.equal(discoveryInspection(f.store,f.store.get<DiscoveryDraft>(f.v.draft.id)!).outcome.state,'researching');
  assert.equal(f.store.list('stage-artifact').length,0);return {run,pause,proof};
}
for(const kind of ['no_variants','model','owner','limit','limit-no-mode'] as const)
test(`6.3 runner: public ${kind} reaches a partial result and driver assessment pause without payment on hot/cold repeat`,async t=>{
  const f=await route(t,kind), {run,pause,proof}=await partial(f);
  assert.deepEqual(Object.keys(proof.record.value.axes).sort(),[...V7_AXES].sort());
  assert.equal(proof.record.value.reasons[0]!.code,kind.startsWith('limit')?'budget':kind==='no_variants'?'no_variants':'reject_all');
  assert.equal(f.store.list(DOSSIER_MANIFEST_KIND).length,1);
  if(kind==='limit-no-mode')assert.equal(f.store.get('project-mode:p'),null);
  if(kind.startsWith('limit'))assert.equal(f.generationCalls().length,0);
  else assert.equal(f.generationCalls().filter(c=>c.subject.variantSubject.kind==='proposal').length,1);
  for(const store of [f.store,f.open()]) {
    await inert(f,store,async()=>assert.deepEqual(await f.run(1,store,true),run));
    await inert(f,store,async()=>{
      const result=await drive(f,store);
      assert.equal(result.end,'stage_paused',JSON.stringify(result));assert.equal(result.reason?.code,'research_dossier_assessment_unavailable');
      assert.deepEqual(result.reason?.handoff,pause.handoff);assert.deepEqual(result.reason?.dossier,pause.dossier);
      assert.equal(result.reason?.completeness,'partial');assert.equal(result.reason?.next,'dossier-assessment');
      assert.equal(result.reason?.target,'dossier-assessment');assert.equal(result.stageResult?.discovery?.state,'researching');
      assert.equal(result.om,null);assert.equal(result.budget.callsMade,0);
      const implicit = await new EarlyStageDriver(new ProductEngine(store)).run({project:'p',maxTurns:1,maxCalls:1});
      assert.deepEqual(implicit.reason,result.reason);
    });
  }
});
for(const limit of [false,true])test(`6.3 runner: ${limit?'budget':'no_variants'} receiver retains claims, addressed unknown and both contradiction sides`,async t=>{
  const f=await withMaterials(t,limit), {proof,pause}=await partial(f);
  assert.equal(proof.materials.length,3);assert.deepEqual(proof.materials.map(m=>m.status).sort(),['accepted','accepted','rejected']);
  assert.equal(proof.record.value.axes.industry.claims.length,3);
  assert.deepEqual(proof.record.value.unknowns,[{claim:f.classifications[1]!.claim,unknownId:'demand',consumer:'product-owner',moment:'om-pass',blocksCurrentStage:true}]);
  assert.deepEqual(proof.contradictions[0]!.sides.map(s=>s.status),['accepted','rejected']);
  assert.deepEqual(proof.record.value.contradictions[0]!.resolution,{state:'open'});
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    assert.deepEqual((await readPartialDossier(store,'p',pause.dossier)).record,proof.record);
    const result=await drive(f,store);assert.deepEqual(result.reason?.dossier,pause.dossier);
  });
});
for(const cut of ['handoff','dossier','pause'] as const)
test(`6.3 runner: cut after ${cut} recovers the exact result without another send or snapshot`,async t=>{
  const f=await setup(t);f.configure({none:true});const write=f.store.writeMany.bind(f.store);let hit=false;
  f.store.writeMany=((writes,guards)=>{
    if(!hit&&cut==='pause'&&writes.some(w=>w.kind==='research-run'&&(w.value as any).pauseCode==='research_dossier_assessment_unavailable')){
      hit=true;throw new EngineError('runner_cut','Cut before saving the final addressed pause');
    }
    const rows=write(writes,guards);
    if(!hit&&rows.some(r=>r.kind===(cut==='handoff'?'discovery-variant-handoff':cut==='dossier'?DOSSIER_MANIFEST_KIND:'never'))){
      hit=true;throw new EngineError('runner_cut','Cut after durable output');
    }
    return rows;
  }) as typeof f.store.writeMany;
  try{await f.run(3);}catch(error){assert.equal((error as EngineError).code,'runner_cut');}finally{f.store.writeMany=write;}
  assert.ok(hit);const handoff=f.store.list('discovery-variant-handoff')[0]!, existing=f.store.list(DOSSIER_MANIFEST_KIND)[0];
  const paid=money(f.store),wire=f.wires();
  if(cut==='pause')f.mode('bypass'); // Saved dossier recovery does not reactivate its old mode.
  if(cut==='dossier'||cut==='pause')assert.equal((await drive(f,f.open())).reason?.code,'research_dossier_assessment_unavailable');
  else await f.run(1,f.open(),true);
  const {run,pause}=await partial(f);
  assert.deepEqual(pause.handoff,reference(handoff));if(existing)assert.deepEqual(pause.dossier,reference(existing));
  assert.equal(f.store.list(DOSSIER_MANIFEST_KIND).length,1);assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);
  for(const store of [f.store,f.open()])await inert(f,store,async()=>assert.deepEqual(await f.run(1,store,true),run));
});

test('6.3 runner: saved partial pause remains historical after a real new choice, mode and plan edition',async t=>{
  const f=await route(t,'owner'),{run,pause,proof}=await partial(f);
  const state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
  owner(f.store,{...choiceScope(f,'choose'),operation:'revise',previous:state.value.decision!,expectedSelection:reference(state)});
  f.mode('bypass');f.nextEdition();
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    assert.deepEqual(await f.run(1,store,true),run);
    assert.deepEqual((await readPartialDossier(store,'p',pause.dossier)).record,proof.record);
    const result=await drive(f,store);assert.deepEqual(result.reason?.dossier,pause.dossier,JSON.stringify(result));assert.equal(result.reason?.completeness,'partial');assert.deepEqual(result.draft,proof.handoff.value.draft);
  });
  assert.equal(f.store.list('discovery-variant-scope').length,0);
});
for(const field of ['handoff','dossier'] as const)for(const fault of ['absent','null','missing','foreign'] as const)
test(`6.3 runner: explicit ${fault} ${field} pause corruption refuses both public doors hot/cold without writes`,async t=>{
  const f=await route(t,'no_variants'), {run,pause}=await partial(f);
  const damaged=structuredClone(pause);
  if(fault==='absent')delete damaged[field];
  else if(fault==='null')damaged[field]=null;
  else if(fault==='missing')damaged[field]={...pause[field],id:'missing-exact-output'};
  else {
    const original=f.store.get<any>(pause[field].id)!;
    const fake=f.store.write({id:`negative-foreign-${field}`,kind:original.kind,expected:0,value:{...original.value,projectId:'other'}});
    damaged[field]=reference(fake);
  }
  // Negative imitation of the saved pause, after a wholly real paid route.
  f.store.write({id:run.id,kind:run.kind,expected:run.revision,value:{...run.value,error:canonical(damaged)}});
  for(const store of [f.store,f.open()]){
    await inert(f,store,()=>assert.rejects(()=>f.run(1,store,true),error=>error instanceof EngineError));
    await inert(f,store,async()=>{
      const result=await drive(f,store);assert.equal(result.end,'blocked',JSON.stringify(result));
      assert.ok(result.reason?.code.startsWith('discovery_'));assert.equal(result.reason?.dossier,undefined);
    });
  }
});

test('6.3 runner: swapped genuine dossier from another handoff cannot masquerade as this partial result',async t=>{
  const f=await route(t,'owner'),{run,pause}=await partial(f), state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
  const decision=owner(f.store,{...choiceScope(f,'reject_all'),operation:'revise',previous:state.value.decision!,expectedSelection:reference(state)});
  const {publishVariantHandoff}=await import('../src/discovery/discovery-outcome.js');
  const handoff=await publishVariantHandoff(f.store,'p',{draft:decision.decision.value.draft,result:decision.decision.value.set,decision:reference(decision.decision),scope:null});
  const other=await producePartialDossier(f.store,'p',reference(handoff.record));
  f.store.write({id:run.id,kind:run.kind,expected:run.revision,value:{...run.value,error:canonical({...pause,dossier:reference(other.record)})}});
  for(const store of [f.store,f.open()]){
    await inert(f,store,()=>assert.rejects(()=>f.run(1,store,true),{code:'discovery_dossier_invalid'}));
    await inert(f,store,async()=>assert.equal((await drive(f,store)).reason?.code,'discovery_dossier_invalid'));
  }
});
for(const shift of ['frame','plan','mode','selection'] as const)
test(`6.3 runner: real second Store ${shift} race before dossier publication cannot escape the common guards`,async t=>{
  const f=await setup(t),other=f.open();f.configure({none:shift!=='selection'});
  if(shift==='selection'){await f.run(3);owner(f.store,choiceScope(f,'reject_all'));}
  const write=f.store.writeMany.bind(f.store);let after='',paid:unknown,wire:unknown;
  f.store.writeMany=((writes,guards)=>{
    if(!after&&writes.some(w=>w.kind===DOSSIER_MANIFEST_KIND)){
      if(shift==='frame'){const q=other.list<Question>('question').find(q=>q.value.draftId===f.v.draft.id&&q.value.spec.field==='frame')!;new Discovery(other).reopen(q.id,q.revision);}
      else if(shift==='plan')f.nextEdition(other);
      else if(shift==='mode')f.mode('bypass',other);
      else {const state=other.get<VariantState>(variantStateId('p',f.v.draft.id))!;owner(other,{...choiceScope(f,'choose'),operation:'revise',previous:state.value.decision!,expectedSelection:reference(state)});}
      after=history(other);paid=money(other);wire=f.wires();
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  try{await assert.rejects(()=>f.run(shift==='selection'?1:3),{code:'input_stale'});}finally{f.store.writeMany=write;}
  assert.ok(after);assert.equal(history(f.store),after);assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);
  assert.equal(f.store.list(DOSSIER_MANIFEST_KIND).length,0);
  for(const store of [f.store,f.open()]){
    await inert(f,store,()=>assert.rejects(()=>f.run(1,store,true),error=>error instanceof EngineError));
    await inert(f,store,async()=>{const result=await drive(f,store);assert.equal(result.end,'blocked');assert.equal(result.reason?.dossier,undefined);});
  }
});

async function rejectedAtDossierCut(t: test.TestContext, published: boolean) {
  const f=await setup(t);await f.run(3);
  const rejected=owner(f.store,choiceScope(f,'reject_all'));
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards)=>{
    const recipient=writes.some(w=>w.kind===DOSSIER_MANIFEST_KIND);
    if(recipient&&!cut&&!published){cut=true;throw new EngineError('runner_pending_cut','Stop before dossier publication');}
    const rows=write(writes,guards);
    if(recipient&&!cut){cut=true;throw new EngineError('runner_pending_cut','Stop after dossier publication');}
    return rows;
  }) as typeof f.store.writeMany;
  try{await assert.rejects(()=>f.run(1),{code:'runner_pending_cut'});}finally{f.store.writeMany=write;}
  assert.ok(cut);
  const pending=currentRun(f);assert.equal(pending.value.pauseCode,'research_partial_dossier_pending');
  const pause=JSON.parse(pending.value.error!), handoff=(await readVariantHandoff(f.store,'p',pause.handoff)).record;
  assert.deepEqual(handoff.value.decision,reference(rejected.decision));assert.equal(handoff.value.reason,'reject_all');
  assert.equal(f.store.list(DOSSIER_MANIFEST_KIND).length,published?1:0);
  const chosen=owner(f.store,{...choiceScope(f,'choose'),operation:'revise',previous:reference(rejected.decision),expectedSelection:reference(rejected.state)});
  return {...f,pending,oldHandoff:handoff,chosen};
}
for(const cold of [false,true])for(const published of [false,true])
test(`6.3-RUNNER-01: ${cold?'cold':'hot'} owner revise exits an unpublished recipient; ${published?'written dossier restores first':'unwritten dossier stays absent'}`,async t=>{
  const f=await rejectedAtDossierCut(t,published),store=cold?f.open():f.store;
  const oldHistory=f.store.history(f.oldHandoff.id), paid=money(f.store), wire=f.wires();
  const existing=f.store.list(DOSSIER_MANIFEST_KIND)[0];
  if(published){
    // Even an explicit new invocation first restores this already-paid saved result.
    const restored=await f.run(1,store), pause=JSON.parse(restored.value.error!);
    assert.equal(restored.value.pauseCode,'research_dossier_assessment_unavailable');
    assert.deepEqual(pause.dossier,reference(existing!));assert.deepEqual(pause.handoff,reference(f.oldHandoff));
    await inert(f,store,async()=>assert.deepEqual(await f.run(1,store,true),restored));
  } else {
    await inert(f,store,()=>assert.rejects(()=>f.run(1,store,true),{code:'discovery_dossier_stale'}));
    await inert(f,store,()=>assert.rejects(()=>new Researcher(store,new Discovery(store),new ProductEngine(store).environments)
      .run('p',f.v.draft.id,1),{code:'discovery_dossier_stale'})); // default policy is not a new v7 admission
    assert.deepEqual(currentRun(f,store),f.pending);
  }
  const next=await f.run(1,store), pause=JSON.parse(next.value.error!);
  assert.equal(next.value.pauseCode,'research_variant_handoff_unavailable',JSON.stringify(next.value));
  const deep=(await readVariantHandoff(store,'p',pause.handoff)).record;
  assert.equal(deep.value.next,'deep');assert.equal(deep.value.reason,'choose');
  assert.deepEqual(deep.value.decision,reference(f.chosen.decision));assert.deepEqual(pause.decision,reference(f.chosen.decision));
  assert.ok(deep.value.scope);assert.notEqual(deep.id,f.oldHandoff.id);
  assert.deepEqual(store.history(f.oldHandoff.id),oldHistory);
  assert.deepEqual((await readVariantHandoff(store,'p',reference(f.oldHandoff))).record,f.oldHandoff);
  assert.equal(store.list(DOSSIER_MANIFEST_KIND).length,published?1:0);
  if(existing)assert.deepEqual((await readPartialDossier(store,'p',reference(existing))).record,existing);
  assert.deepEqual(money(store),paid);assert.deepEqual(f.wires(),wire);
  assert.equal(f.generationCalls().filter(c=>c.subject.variantSubject.kind==='proposal').length,1);
  assert.equal(f.generationCalls().filter(c=>c.subject.variantSubject.kind==='decision').length,0);
  for(const repeat of [store,f.open()])await inert(f,repeat,async()=>assert.deepEqual(await f.run(1,repeat,true),next));
});
for(const lost of ['handoff','snapshot'] as const)
test(`6.3-RUNNER-01: an explicit new choice does not bypass the pending ${lost} proof fault`,async t=>{
  const f=await rejectedAtDossierCut(t,false), target=lost==='handoff'?reference(f.oldHandoff):f.oldHandoff.value.snapshot!;
  assert.ok(target);
  for(const store of [f.store,f.open()]){
    const get=store.get.bind(store);
    store.get=((id,revision)=>id===target.id&&(revision===undefined||revision===target.revision)?null:get(id,revision)) as typeof store.get;
    try{await inert(f,store,()=>assert.rejects(()=>f.run(1,store),error=>error instanceof EngineError&&error.code!=='discovery_dossier_stale'));}
    finally{store.get=get;}
    assert.deepEqual(currentRun(f,store),f.pending);assert.equal(store.list(DOSSIER_MANIFEST_KIND).length,0);
  }
});

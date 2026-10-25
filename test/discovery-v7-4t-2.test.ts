import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage/store.js';
import {hashJson} from '../src/canonical.js';
import {reference, type Ref} from '../src/pipeline/contracts.js';
import {workingContext} from '../src/discovery/working-context.js';
import {continuationState, continuationDispatch, continuationMetadata} from '../src/discovery/continuation-packet.js';
import {invocationProgress} from '../src/discovery/invocation-progress.js';
import {VARIANT_SUBJECT_CONTRACT, type VariantSubject} from '../src/discovery/discovery-variants.js';
import {variantStateId} from '../src/discovery/variant-decision.js';
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {canonical, type Json} from '../src/canonical.js';
import {type Revision} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {Discovery, type DiscoveryDraft, type Question} from '../src/discovery/discovery.js';
import {createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING} from '../src/discovery/v7-contracts.js';
import {answerDiscoveryFixture} from './product-fixture.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {VARIANT_CRITERIA} from '../src/discovery/discovery-variants.js';
import type {ModelCall} from '../src/runtime/model-usage.js';
import {EngineError} from '../src/errors.js';

// TRANSPORT FIXTURES ONLY: these rows are not produced snapshots/sets, paid
// model calls, admission, mode authority, or evidence of product readiness.
function fixture(t:test.TestContext, projectId='p',suffix='') {
  const dir=mkdtempSync(join(tmpdir(),'omg-4t2-')),path=join(dir,'state.sqlite');
  const store=new Store(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const draft=store.write<any>({id:`draft-${suffix}`,kind:'discovery-draft',expected:0,value:{projectId,stage:'discovery',level:'R2',consumer:'compilation',questions:[`question-${suffix}`],fields:{topic:null},inputs:[]}});
  const question=store.write<any>({id:`question-${suffix}`,kind:'question',expected:0,value:{projectId,draftId:draft.id,stage:'discovery',level:'R2',consumer:'compilation',spec:{field:'topic',kind:'design',prompt:'Transport only',risk:'identity collision',schema:{type:'object'}},status:'open',beforeHash:hashJson(null),answer:null}});
  let serial=0;
  const record=(label:string)=>reference(store.write<any>({id:`transport-fixture:${label}:${serial++}`,kind:'transport-fixture',expected:0,value:{label}}));
  const basis=record('basis'),mode=record('mode');
  const proposal:VariantSubject={contract:VARIANT_SUBJECT_CONTRACT,kind:'proposal',snapshot:basis,mode,expectedSelection:null};
  const decision:VariantSubject={contract:VARIANT_SUBJECT_CONTRACT,kind:'decision',set:basis,mode,expectedSelection:null};
  const purpose=(v:VariantSubject)=>`variant-${v?.kind==='decision'?'decision':'proposal'}`;
  const body=(v:VariantSubject)=>({variantSubject:v,question:{id:question.id,...question.value.spec},core:{objective:'TRANSPORT FOUNDATION'},map:{nodes:[]},history:[],readings:[]});
  const state=(v:VariantSubject,actor='a')=>continuationState(store,projectId,draft.id,question.id,purpose(v),actor,null,null,v);
  const pack=(v:VariantSubject,actor='a',previous?:Ref,continuation=false)=>workingContext(store,projectId,draft.id,question.id,body(v),100000,{common:true,purpose:purpose(v),actor,variantSubject:v,...(previous?{previous}:{}),continuation});
  const progress=(v:VariantSubject,actor='a')=>invocationProgress(store,question.id,purpose(v),body(v),null,actor,null,v);
  function call(v:VariantSubject,packet:any,actor='a',overrides:Record<string,unknown>={}) {
    return store.write<any>({id:`model-call:transport-fixture:${serial++}`,kind:'model-call',expected:0,value:{projectId,draftId:draft.id,questionId:question.id,purpose:purpose(v),variantSubject:v,requested:{actor},startedAt:serial,status:'succeeded',packet:{archive:packet.working.archive,kind:'initial',maxChars:100000},progressKey:progress(v,actor).key,...overrides}});
  }
  return {store,path,draft,question,proposal,decision,record,body,state,pack,progress,call,purpose,projectId};
}
for(const kind of ['proposal','decision'] as const) {
  test(`4T.2-T ${kind} preserves complete transport identity in initial/continuation, archives and cold repeat`,t=>{
    const f=fixture(t),v=f[kind],first=f.pack(v),initial=f.state(v);
    assert.equal(initial.initial,true);
    const call=f.call(v,first),dispatch=continuationDispatch(initial,call.id);
    f.store.writeMany(dispatch.writes,dispatch.guards);
    const nextState=f.state(v),next=f.pack(v,'a',first.working.archive,true);
    assert.equal(nextState.initial,false);assert.equal(nextState.priorCalls,1);
    assert.deepEqual(nextState.basis,first.working.archive);
    for(const packet of [first,next]) {
      assert.deepEqual(packet.variantSubject,v);
      assert.equal(packet.actor,'a');assert.equal(packet.purpose,f.purpose(v));assert.equal(packet.projectId,'p');
      assert.deepEqual(packet.questionRef,reference(f.question));assert.deepEqual(packet.draftRef,reference(f.draft));
      const archive=f.store.get<any>(packet.working.archive.id)!;
      assert.deepEqual(archive.value.variantSubject,v);assert.equal(archive.value.actor,'a');assert.equal(archive.value.purpose,f.purpose(v));
      assert.deepEqual(archive.value.question,reference(f.question));assert.deepEqual(archive.value.draft,reference(f.draft));
    }
    const metadata=continuationMetadata(nextState,next.working.archive,f.store);
    assert.deepEqual(metadata.variantSubject,v);assert.deepEqual(metadata.foundation,first.working.archive);
    const before=f.store.identities('list'),key=f.progress(v).key;
    const cold=new Store(f.path);
    try {
      const repeated=continuationState(cold,'p',f.draft.id,f.question.id,f.purpose(v),'a',null,null,v);
      assert.deepEqual(repeated,nextState);
      const packet=workingContext(cold,'p',f.draft.id,f.question.id,f.body(v),100000,{common:true,continuation:true,previous:first.working.archive,purpose:f.purpose(v),actor:'a',variantSubject:v});
      assert.deepEqual(packet,next);
      assert.equal(invocationProgress(cold,f.question.id,f.purpose(v),f.body(v),null,'a',null,v).key,key);
      assert.deepEqual(cold.identities('list'),before);
    } finally {cold.close();}
  });
  test(`4T.2-T ${kind} isolates each subject field and actor, rejects foreign previous/foundation`,t=>{
    const f=fixture(t),v=f[kind],packet=f.pack(v),originalState=f.state(v),originalKey=f.progress(v).key;
    const originalCall=f.call(v,packet);
    const current=reference(f.store.write<any>({id:variantStateId('p',f.draft.id),kind:'transport-fixture',expected:0,value:{fixture:'selection'}}));
    const variants:VariantSubject[]=[{...v,mode:f.record('other-mode')},{...v,expectedSelection:current},
      v.kind==='proposal'?{...v,snapshot:f.record('other-snapshot')}:{...v,set:f.record('other-set')},
      {...v,...(v.kind==='proposal'?{snapshot:{...v.snapshot,hash:'f'.repeat(64)}}:{set:{...v.set,hash:'f'.repeat(64)}})}];
    for(const other of variants) {
      assert.notEqual(f.state(other).id,originalState.id);assert.equal(f.state(other).priorCalls,0);
      assert.notEqual(f.progress(other).key,originalKey);
      assert.throws(()=>f.pack(other,'a',packet.working.archive,true),{code:'continuation_foreign'});
      assert.throws(()=>continuationMetadata(f.state(other),packet.working.archive,f.store),{code:'continuation_foreign'});
    }
    assert.notEqual(f.state(v,'b').id,originalState.id);assert.equal(f.state(v,'b').priorCalls,0);
    assert.notEqual(f.progress(v,'b').key,originalKey);
    assert.throws(()=>f.pack(v,'b',packet.working.archive,true),{code:'continuation_foreign'});
    // Replacing the packet on a matching service call cannot import another identity.
    const foreign=f.pack({...v,expectedSelection:current},'b');
    f.store.write({id:originalCall.id,kind:'model-call',expected:originalCall.revision,value:{...originalCall.value,packet:{...originalCall.value.packet,archive:foreign.working.archive}}});
    assert.throws(()=>f.state(v),{code:'continuation_foreign'});
  });
}

test('4T.2-T project, draft and actual Question participate in transport keys',t=>{
  const a=fixture(t,'p','a'),b=fixture(t,'q','b');
  // Cross-project comparison intentionally reuses the closed subject bytes only.
  assert.notEqual(a.state(a.proposal).id,b.state(a.proposal).id);
  assert.notEqual(a.progress(a.proposal).key,b.progress(a.proposal).key);
  const own=a.state(a.proposal).id;
  a.store.write({id:a.question.id,kind:'question',expected:a.question.revision,value:{...a.question.value,status:'paused'}});
  assert.notEqual(a.state(a.proposal).id,own);
  assert.throws(()=>workingContext(b.store,'p',b.draft.id,b.question.id,b.body(a.proposal),100000,{purpose:'variant-proposal',actor:'a',variantSubject:a.proposal}),{code:'context_basis_missing'});
});

test('4T.2-T missing, null, unknown and forged fields never fall back to an ordinary subject',t=>{
  const f=fixture(t),v=f.proposal;
  const inputs:any[]=[null,{}, {...v,contract:'unknown'}, {...v,expectedSelection:undefined}, {...v,mode:null}, {...v,snapshot:null}, {...v,kind:'decision'}, {...v,ready:true}];
  for(const field of Object.keys(v)) {const omitted={...v} as any;delete omitted[field];inputs.push(omitted);}
  for(const bad of inputs) {
    assert.throws(()=>f.state(bad),{code:'discovery_variant_subject_invalid'});
    assert.throws(()=>f.progress(bad),{code:'discovery_variant_subject_invalid'});
    assert.throws(()=>f.pack(bad),{code:'discovery_variant_subject_invalid'});
  }
  for(const field of Object.keys(f.decision)) {
    const missing={...f.decision} as any;delete missing[field];
    assert.throws(()=>f.state(missing),{code:'discovery_variant_subject_invalid'});
    assert.throws(()=>f.progress(missing),{code:'discovery_variant_subject_invalid'});
    assert.throws(()=>f.pack(missing),{code:'discovery_variant_subject_invalid'});
  }
  assert.notEqual(f.state(v).id,f.state(f.decision).id);
  assert.notEqual(f.progress(v).key,f.progress(f.decision).key);
  assert.throws(()=>continuationState(f.store,'p',f.draft.id,f.question.id,'variant-proposal','a'),{code:'discovery_variant_subject_invalid'});
  assert.throws(()=>workingContext(f.store,'p',f.draft.id,f.question.id,f.body(v),100000,{purpose:'analyst'}),{code:'discovery_variant_subject_invalid'});
  assert.throws(()=>invocationProgress(f.store,f.question.id,'analyst',f.body(v)),{code:'discovery_variant_subject_invalid'});
  assert.throws(()=>workingContext(f.store,'p',f.draft.id,f.question.id,{},100000,{purpose:'variant-proposal',actor:'a',variantSubject:v}),{code:'discovery_variant_subject_invalid'});
  assert.throws(()=>invocationProgress(f.store,f.question.id,'variant-proposal',{},null,'a',null,v),{code:'discovery_variant_subject_invalid'});
});

test('4T.2-T body disagreement, K/assessment mixing and mismatched purpose/actor refuse before writes',t=>{
  const f=fixture(t),v=f.proposal;
  for(const extra of [{variantSubject:f.decision},{subject:{}},{assessmentSubject:{}},{actor:'other'},{projectId:'other'},{purpose:'other'},{questionRef:f.record('foreign-question')}]) {
    const body={...f.body(v),...extra};
    const snapshot=f.store.identities('list');
    assert.throws(()=>workingContext(f.store,'p',f.draft.id,f.question.id,body,100000,{purpose:'variant-proposal',actor:'a',variantSubject:v}),{code:'discovery_variant_subject_invalid'});
    assert.throws(()=>invocationProgress(f.store,f.question.id,'variant-proposal',body,null,'a',null,v),{code:'discovery_variant_subject_invalid'});
    assert.deepEqual(f.store.identities('list'),snapshot);
  }
  for(const [purpose,actor] of [['analyst','a'],['variant-decision','a'],['variant-proposal','']] as const)
    assert.throws(()=>continuationState(f.store,'p',f.draft.id,f.question.id,purpose,actor,null,null,v),{code:'discovery_variant_subject_invalid'});
  assert.throws(()=>continuationState(f.store,'p',f.draft.id,f.question.id,'variant-proposal','a',{} as any,null,v),{code:'discovery_variant_subject_invalid'});
  assert.throws(()=>continuationState(f.store,'p',f.draft.id,f.question.id,'variant-proposal','a',null,{} as any,v),{code:'discovery_variant_subject_invalid'});
});

test('4T.2-T exact mode and explicit absent/expected selection guards protect the actual dispatch batch',t=>{
  const f=fixture(t),v=f.proposal;
  const absent=continuationDispatch(f.state(v),'model-call:fixture');
  assert.ok(absent.guards.some(g=>'absent' in g && g.id===variantStateId('p',f.draft.id)));
  assert.ok(absent.guards.some(g=>!('absent' in g)&&g.id===v.mode.id&&g.hash===v.mode.hash));
  const selection=f.store.write<any>({id:variantStateId('p',f.draft.id),kind:'transport-fixture',expected:0,value:{fixture:'state'}});
  const before=f.store.identities('list');
  assert.throws(()=>f.store.writeMany(absent.writes,absent.guards),{code:'input_stale'});
  assert.deepEqual(f.store.identities('list'),before);
  const selected:VariantSubject={...v,expectedSelection:reference(selection)};
  const exact=continuationDispatch(f.state(selected),'model-call:fixture');
  f.store.write({id:selection.id,kind:selection.kind,expected:selection.revision,value:{fixture:'moved state'}});
  assert.throws(()=>f.store.writeMany(exact.writes,exact.guards),{code:'input_stale'});
  const modeSubject:VariantSubject={...v,expectedSelection:reference(f.store.get(selection.id)!)};
  const mode=continuationDispatch(f.state(modeSubject),'model-call:fixture');
  f.store.write({id:v.mode.id,kind:'transport-fixture',expected:v.mode.revision,value:{fixture:'moved mode'}});
  assert.throws(()=>f.store.writeMany(mode.writes,mode.guards),{code:'input_stale'});
  assert.throws(()=>f.state({...v,expectedSelection:f.record('wrong-state-address')}),{code:'discovery_variant_subject_invalid'});
});

test('4T.2-T legacy keys remain exact and a context ready flag does not select a variant branch',t=>{
  const f=fixture(t),state=continuationState(f.store,'p',f.draft.id,f.question.id,'analyst','a');
  assert.equal(state.id,`continuation-state:${hashJson(['p',f.question.id,'analyst','a'])}`);
  const body={ready:true},progress=invocationProgress(f.store,f.question.id,'analyst',body);
  assert.equal(progress.key,hashJson({version:1,question:reference(f.question),purpose:'analyst',step:{evidence:[]}}));
  const packet=workingContext(f.store,'p',f.draft.id,f.question.id,body,100000,{purpose:'analyst'});
  assert.equal(Object.hasOwn(packet,'variantSubject'),false);
  assert.equal(f.store.list('model-call').length,0);
});


test('4T.2-T service calls from another project/actor/purpose/Question do not supply history or progress',t=>{
  const f=fixture(t),v=f.proposal,packet=f.pack(v),key=f.progress(v).key;
  for(const changed of [{projectId:'foreign'},{requested:{actor:'foreign'}},{purpose:'analyst'},
    {questionId:'foreign'},{draftId:'foreign'},{subject:{}},{assessmentSubject:{}}]) f.call(v,packet,'a',changed);
  assert.equal(f.state(v).initial,true);
  assert.equal(f.progress(v).guards.filter(g=>g.id.startsWith('model-call:')).length,0);
  assert.equal(f.progress(v).key,key);
  const own=f.call(v,packet);
  assert.equal(f.state(v).priorCalls,1);
  assert.deepEqual(f.progress(v).guards.filter(g=>g.id.startsWith('model-call:')),[reference(own)]);
});

test('4T.2-T missing identity on saved state/archive and altered exact archive Ref refuse',t=>{
  const f=fixture(t),v=f.proposal,packet=f.pack(v),state=f.state(v),call=f.call(v,packet);
  const dispatch=continuationDispatch(state,call.id);
  f.store.writeMany(dispatch.writes,dispatch.guards);
  const row=f.store.get<any>(state.id)!,missing={...row.value};delete missing.variantSubject;
  f.store.write({id:row.id,kind:row.kind,expected:row.revision,value:missing});
  assert.throws(()=>f.state(v),{code:'continuation_foreign'});
  for(const ref of [{...packet.working.archive,hash:'f'.repeat(64)},{...packet.working.archive,revision:999}])
    assert.throws(()=>f.pack(v,'a',ref,true),{code:'continuation_foreign'});
  const original=f.store.get<any>(packet.working.archive.id)!,badValue={...original.value};delete badValue.actor;
  const bad=f.store.write({id:'research-context:transport-fixture-forged',kind:'research-context',expected:0,value:badValue});
  assert.throws(()=>f.pack(v,'a',reference(bad),true),{code:'continuation_foreign'});
});


for(const kind of ['proposal','decision'] as const) {
  for(const target of ['question','draft'] as const)
    test(`4T.2-T-01 ${kind} saved calls stay with their exact ${target} edition after cold reopen`,t=>{
      const f=fixture(t),v=f[kind],packet=f.pack(v),old=f.state(v),oldProgress=f.progress(v);
      const oldCall=f.call(v,packet),oldDispatch=continuationDispatch(old,oldCall.id);
      f.store.writeMany(oldDispatch.writes,oldDispatch.guards);
      const row=f[target];
      f.store.write({id:row.id,kind:row.kind,expected:row.revision,value:{...row.value,
        ...(target==='question'?{status:'paused'}:{fields:{topic:'new edition'}})}});
      const next=f.state(v),progress=f.progress(v);
      assert.notEqual(next.id,old.id);assert.equal(next.initial,true);assert.equal(next.priorCalls,0);
      assert.equal(next.state,null);assert.equal(next.basis,null);assert.equal(next.attempts,0);
      assert.notEqual(progress.key,oldProgress.key);
      assert.deepEqual(progress.guards.filter(g=>g.id.startsWith('model-call:')),[]);
      assert.throws(()=>f.pack(v,'a',packet.working.archive,true),{code:'continuation_foreign'});
      const snapshot=f.store.identities('list'),cold=new Store(f.path);
      try {
        assert.deepEqual(continuationState(cold,'p',f.draft.id,f.question.id,f.purpose(v),'a',null,null,v),next);
        assert.deepEqual(invocationProgress(cold,f.question.id,f.purpose(v),f.body(v),null,'a',null,v),progress);
        assert.deepEqual(cold.identities('list'),snapshot);
      } finally {cold.close();}
      const ownPacket=f.pack(v),ownCall=f.call(v,ownPacket),current=f.state(v);
      assert.equal(current.priorCalls,1);assert.deepEqual(current.callGuards,[reference(ownCall)]);
      assert.deepEqual(current.basis,ownPacket.working.archive);
      // Packet replacement of this edition's own call must still refuse.
      f.store.write({id:ownCall.id,kind:'model-call',expected:ownCall.revision,value:{...ownCall.value,
        packet:{...ownCall.value.packet,archive:packet.working.archive}}});
      const after=f.store.identities('list');
      assert.throws(()=>f.state(v),{code:'continuation_foreign'});
      assert.throws(()=>f.progress(v),{code:'continuation_foreign'});
      assert.deepEqual(f.store.identities('list'),after);
    });
  for(const owner of ['actor','project'] as const)
    test(`4T.2-T-02 ${kind} excludes malformed foreign ${owner} before decoding; its own corruption refuses`,t=>{
      const f=fixture(t),v=f[kind],packet=f.pack(v),own=f.call(v,packet),progress=f.progress(v),state=f.state(v);
      f.call(v,packet,'a',{...(owner==='actor'?{requested:{actor:'foreign'}}:{projectId:'foreign'}),
        variantSubject:{...v,contract:'unknown'}});
      const before=f.store.identities('list');
      assert.deepEqual(f.progress(v),progress);assert.deepEqual(f.state(v),state);
      assert.deepEqual(f.store.identities('list'),before);
      f.store.write({id:own.id,kind:'model-call',expected:own.revision,value:{...own.value,variantSubject:{...v,contract:'unknown'}}});
      const corrupt=f.store.identities('list');
      assert.throws(()=>f.progress(v),{code:'discovery_variant_subject_invalid'});
      assert.throws(()=>f.state(v),{code:'discovery_variant_subject_invalid'});
      assert.deepEqual(f.store.identities('list'),corrupt);
    });
}

// ---- 4T.2 rest: the same identities on the REAL common researchCall of 4T.3 (prerequisite commit ac338102). The
// model-call, continuation-state, progress key and archive below are written by the real reservation and packer through
// a scripted adapter; only the snapshot, set and mode rows are transport fixtures (their producers are 4T.1, 4B and 4O),
// and nothing here stands for the managed variant lifecycle of 4T.4.
const judgement = {conclusion:'Bounded by the snapshot',grounds:[],assumptions:['The saved snapshot is complete'],unknowns:[],quantity:null};
function generation(label:string):Json {
  const criteria = Object.fromEntries(VARIANT_CRITERIA.map(criterion => [criterion, judgement]));
  return {action:'variants',variants:[
    {key:`${label}-a`,title:`Variant ${label} A`,proposal:{scope:'narrow'},criteria},
    {key:`${label}-b`,title:`Variant ${label} B`,proposal:{scope:'wide'},criteria}],
  scale:Object.fromEntries(VARIANT_CRITERIA.map(criterion => [criterion, `${criterion} from low to high`])),
  comparison:`A against B for ${label}`,recommendation:{key:`${label}-a`,reason:'Fits the mandate'},
  searchLimits:['Only the saved snapshot was read'],unknowns:[]} as Json;
}
const choice = (label:string):Json => ({choice:'decline-all',reason:`Transport only: ${label}`});
const errorCode = (code:string) => (error:unknown) => error instanceof EngineError && error.code === code;
const allAxes = (depth:string) => Object.fromEntries(V7_AXES.map(axis => [axis, {depth}]));
const questionOf = (store:Store, draft:Revision<DiscoveryDraft>, field:string) =>
  draft.value.questions.map(id => store.get<Question>(id)!).find(question => question.value.spec.field === field)!;
async function realPath(t:test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-4t2r-')), path = join(root, 'state.sqlite'), stores:Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, {recursive:true, force:true}); });
  const wire = join(root, 'wire.ndjson'), settings = join(root, 'reply.json'), adapter = join(root, 'adapter.mjs');
  const configure = (reply:unknown) => writeFileSync(settings, JSON.stringify({reply, tokens:10}));
  configure(generation('calibration'));
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:s.reply,usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  writeFileSync(wire, '');
  const command = {executable:process.execPath, args:[adapter]};
  let serial = 0;
  const transport = (label:string) => reference(store.write({id:`transport-fixture:${label}:${serial++}`, kind:'transport-fixture', expected:0, value:{label}}));
  const subject = (kind:'proposal'|'decision', basis:Ref, mode:Ref):VariantSubject => kind === 'proposal'
    ? {contract:VARIANT_SUBJECT_CONTRACT, kind, snapshot:basis, mode, expectedSelection:null}
    : {contract:VARIANT_SUBJECT_CONTRACT, kind, set:basis, mode, expectedSelection:null};
  const purposeOf = (v:VariantSubject) => `variant-${v.kind}`;
  const body = (v:VariantSubject, question:Revision<Question>) => ({variantSubject:v, question:{id:question.id, ...question.value.spec},
    core:{objective:'Generate the variants of the saved snapshot'}, map:{nodes:[]}, history:[], readings:[]});
  type Project = {id:string; environment:Revision<any>; draftId:string; planId:string};
  const head = (p:Project, db = store) => ({draft:db.get<DiscoveryDraft>(p.draftId)!, plan:db.get<Question>(p.planId)!});
  const call = (p:Project, v:VariantSubject, actor:'author'|'reviewer' = 'author', db = store, onContext?:(context:Record<string, any>) => void) =>
    researchCall(actor === 'author' ? p.environment.value.implementer : p.environment.value.reviewer, p.environment.value,
      'Propose the variants of the saved snapshot', body(v, head(p, db).plan), undefined,
      {store:db, draftId:p.draftId, questionId:p.planId, purpose:purposeOf(v), ...(onContext ? {onContext} : {})});
  async function project(id:string):Promise<Project> {
    engine.execute({type:'create-project', project:id, title:id});
    const workspace = join(root, id); mkdirSync(workspace);
    const environment = engine.environments.configure(id, {workspace,
      implementer:{actor:'author', model:'fixture', effort:'high', command}, reviewer:{actor:'reviewer', model:'fixture', effort:'high', command},
      fullCheck:command, timeoutMs:10000}, 0);
    // The ordinary estimate needs comparable measured calls of each variant purpose: calibrate once on a legacy draft.
    const old = discovery.create(id, 'discovery', 'R0', 'concept', [
      {field:'probe', kind:'fact', prompt:'Calibrate', risk:'unknown', schema:{type:'object'}}], [], 6);
    const probe = store.get<Question>(old.value.questions[0]!)!, calibration = transport(`calibration-${id}`);
    for (const kind of ['proposal', 'decision'] as const) for (const role of [environment.value.implementer, environment.value.reviewer])
      await researchCall(role, environment.value, 'Calibrate', body(subject(kind, calibration, transport(`calibration-mode-${id}-${kind}-${role.actor}`)), probe),
        undefined, {store, draftId:old.id, questionId:probe.id, purpose:`variant-${kind}`});
    const base = createPartialV7Draft(discovery, id, 'concept');
    const src = discovery.evidence.document(id, 'basis', `Exact source for ${id}`, 'text/plain', 0);
    const frame = questionOf(store, base, 'frame');
    answerDiscoveryFixture(engine, id, base, frame, {productType:'internal', scale:'30 users', industries:['construction'],
      domains:['materials supply'], axes:allAxes('deep'),
      budget:{ceiling:V7_STAGE_TOKEN_CEILING, axisHints:{industry:4_000_000}, completionReserve:2_000_000}} as Json, src);
    const frameRef = store.get<Question>(frame.id)!.value.answer!, planQ = questionOf(store, base, 'plan');
    answerDiscoveryFixture(engine, id, base, planQ, {edition:1, frame:frameRef, previous:null, questions:[{id:'q-industry',
      axis:'industry', domain:'construction', text:'What covers the industry?', class:'blocking', criterion:'Named basis',
      requiredDepth:'deep', roles:['domain expert'], searchPlaces:['domain documents']}]} as unknown as Json, src);
    return {id, environment, draftId:base.id, planId:planQ.id};
  }
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const calls = (p:Project, db = store) => db.list<ModelCall>('model-call').filter(row => row.value.draftId === p.draftId);
  const stateOf = (p:Project, v:VariantSubject, actor = 'author', db = store) =>
    continuationState(db, p.id, p.draftId, p.planId, purposeOf(v), actor, null, null, v);
  const progressOf = (p:Project, v:VariantSubject, actor = 'author', db = store) =>
    invocationProgress(db, p.planId, purposeOf(v), body(v, head(p, db).plan), null, actor, null, v);
  const ownCalls = (guards:{id:string}[]) => guards.filter(guard => guard.id.startsWith('model-call:')).map(guard => guard.id);
  return {store, engine, discovery, open, configure, transport, subject, project, call, wires, calls, stateOf, progressOf, ownCalls, head};
}

test('4T.2 on the real researchCall each identity has its own packet and progress: proposals buy an initial send, a direct decision refuses', async t => {
  const r = await realPath(t), p = await r.project('p');
  const base = r.subject('proposal', r.transport('snapshot'), r.transport('mode'));
  r.configure(generation('base'));
  await r.call(p, base);
  const [baseCall] = r.calls(p), baseState = r.stateOf(p, base), baseKey = r.progressOf(p, base).key;
  assert.equal(baseCall!.value.packet!.kind, 'initial');
  assert.equal(baseCall!.value.progressKey, baseKey);
  // The expected selection comes last: once a selection state exists, an identity expecting none is refused (4T.2-T).
  const others:[string, () => VariantSubject, 'author'|'reviewer', Json][] = [
    ['a decision on the same basis', () => r.subject('decision', (base as any).snapshot, base.mode), 'author', choice('decision')],
    ['another snapshot', () => ({...base, snapshot:r.transport('snapshot-2')} as VariantSubject), 'author', generation('snapshot')],
    ['another mode', () => ({...base, mode:r.transport('mode-2')}), 'author', generation('mode')],
    ['another actor', () => base, 'reviewer', generation('actor')],
    ['an expected selection', () => ({...base, expectedSelection:reference(r.store.write({id:variantStateId('p', p.draftId),
      kind:'transport-fixture', expected:0, value:{fixture:'selection'}}))}), 'author', generation('selection')],
  ];
  const seen = new Set([baseState.id]), keys = new Set([baseKey]);
  for (const [note, make, actor, reply] of others) {
    const other = make();
    const before = r.stateOf(p, other, actor), progress = r.progressOf(p, other, actor);
    assert.deepEqual([before.initial, before.priorCalls, before.attempts, before.basis, before.state], [true, 0, 0, null, null], note);
    assert.deepEqual(r.ownCalls(progress.guards), [], note);
    assert.ok(!seen.has(before.id) && !keys.has(progress.key), `${note}: its own state and progress`);
    seen.add(before.id); keys.add(progress.key);
    r.configure(reply);
    const sent = r.wires().length;
    if (other.kind === 'decision') {
      const history = r.store.list().flatMap(row => r.store.history(row.id));
      const calls = r.store.list('model-call'), ledger = r.store.list('research-budget-ledger'), wire = r.wires();
      await assert.rejects(r.call(p, other, actor), errorCode('discovery_variant_managed'));
      assert.deepEqual(r.store.list().flatMap(row => r.store.history(row.id)), history);
      assert.deepEqual(r.store.list('model-call'), calls); assert.deepEqual(r.store.list('research-budget-ledger'), ledger);
      assert.deepEqual(r.wires(), wire); assert.equal(r.wires().length, sent);
      assert.deepEqual(r.stateOf(p, other, actor), before); assert.deepEqual(r.progressOf(p, other, actor), progress);
      continue;
    }
    assert.deepEqual(await r.call(p, other, actor), reply, note);
    assert.equal(r.wires().length, sent + 1, `${note}: a new paid send`);
    const own = r.calls(p).find(row => !before.callGuards.some(guard => guard.id === row.id) && canonical(row.value.variantSubject) === canonical(other)
      && row.value.requested.actor === actor)!;
    assert.equal(own.value.packet!.kind, 'initial', note);
    assert.deepEqual(r.wires().at(-1).subject.variantSubject, other, note);
    const after = r.stateOf(p, other, actor);
    assert.equal(after.id, before.id, note);
    assert.deepEqual([after.priorCalls, after.state!.value.activeCall, after.callGuards.map(guard => guard.id)], [1, own.id, [own.id]], note);
    assert.deepEqual(r.ownCalls(r.progressOf(p, other, actor).guards), [own.id], note);
    assert.equal(own.value.progressKey, progress.key, note);
  }
  // The first identity still has exactly its own call in its history and answers from it free.
  assert.deepEqual(r.stateOf(p, base).callGuards.map(guard => guard.id), [baseCall!.id]);
  assert.deepEqual(r.ownCalls(r.progressOf(p, base).guards), [baseCall!.id]);
  const sent = r.wires().length;
  r.configure(generation('never-sent'));
  assert.deepEqual(await r.call(p, base), generation('base'));
  assert.equal(r.wires().length, sent);
});

test('4T.2 the same closed subject in another project is another packet and progress, a new paid send, and answers nothing there', async t => {
  const r = await realPath(t), p = await r.project('p'), q = await r.project('q');
  const v = r.subject('proposal', r.transport('snapshot'), r.transport('mode'));
  r.configure(generation('p'));
  await r.call(p, v);
  const inP = r.stateOf(p, v), keyP = r.progressOf(p, v).key, inQ = r.stateOf(q, v), progressQ = r.progressOf(q, v);
  assert.notEqual(inQ.id, inP.id);
  assert.notEqual(progressQ.key, keyP);
  assert.deepEqual([inQ.initial, inQ.priorCalls, r.ownCalls(progressQ.guards)], [true, 0, []]);
  const sent = r.wires().length;
  r.configure(generation('q'));
  assert.deepEqual(await r.call(q, v), generation('q'));
  assert.equal(r.wires().length, sent + 1);
  const [own] = r.calls(q);
  assert.deepEqual([own!.value.projectId, own!.value.packet!.kind], ['q', 'initial']);
  assert.deepEqual(r.stateOf(q, v).callGuards.map(guard => guard.id), [own!.id]);
  assert.deepEqual(r.stateOf(p, v).callGuards.map(guard => guard.id), r.calls(p).map(row => row.id));
  r.configure(generation('never-sent'));
  assert.deepEqual(await r.call(p, v), generation('p'));
  assert.equal(r.wires().length, sent + 1);
});

test('4T.2 a cold paid replay keeps its original subject in packet and progress after today\'s mode moves, and writes nothing', async t => {
  const r = await realPath(t), p = await r.project('p'), mode = r.transport('mode');
  const v = r.subject('proposal', r.transport('snapshot'), mode);
  const seen:Record<string, any>[] = [], see = (context:Record<string, any>) => { seen.push(JSON.parse(JSON.stringify(context))); };
  r.configure(generation('first'));
  await r.call(p, v, 'author', r.store, see);
  const state = r.stateOf(p, v), progress = r.progressOf(p, v);
  const moved = r.store.write({id:mode.id, kind:'transport-fixture', expected:mode.revision, value:{label:'mode', revised:true}});
  const before = r.store.identities('list'), sent = r.wires().length;
  r.configure(generation('never-sent'));
  const cold = r.open();
  assert.deepEqual(await r.call(p, v, 'author', cold, see), generation('first'));
  assert.deepEqual(seen[1], seen[0], 'the replay hands over the subject that was sent');
  assert.deepEqual(seen[1]!.variantSubject, v, 'with its original mode, not today\'s');
  assert.deepEqual(r.stateOf(p, v, 'author', cold), state);
  assert.deepEqual(r.progressOf(p, v, 'author', cold), progress);
  assert.deepEqual(cold.identities('list'), before);
  assert.equal(r.wires().length, sent);
  // Today's mode is another identity with an empty history of its own.
  const today = {...v, mode:reference(moved)};
  assert.deepEqual([r.stateOf(p, today).initial, r.stateOf(p, today).priorCalls, r.ownCalls(r.progressOf(p, today).guards)], [true, 0, []]);
});

test('4T.2 a new draft edition by a real door has its own history: the earlier edition\'s paid call is neither replayed nor counted', async t => {
  const r = await realPath(t), p = await r.project('p');
  const v = r.subject('proposal', r.transport('snapshot'), r.transport('mode'));
  r.configure(generation('edition-1'));
  await r.call(p, v);
  const [old] = r.calls(p), oldState = r.stateOf(p, v), oldKey = r.progressOf(p, v).key;
  // The operator answers the objective through the ordinary decision door: the draft moves to its next edition.
  const objective = questionOf(r.store, r.head(p).draft, 'objective');
  r.discovery.decision(objective.id, objective.revision, 'operator', 'Understand the variants of the saved snapshot');
  assert.notEqual(r.head(p).draft.revision, r.store.get<any>(old!.value.packet!.archive.id)!.value.draft.revision);
  const next = r.stateOf(p, v), progress = r.progressOf(p, v);
  assert.notEqual(next.id, oldState.id);
  assert.notEqual(progress.key, oldKey);
  assert.deepEqual([next.initial, next.priorCalls, next.attempts, next.basis, r.ownCalls(progress.guards)], [true, 0, 0, null, []]);
  const sent = r.wires().length;
  r.configure(generation('edition-2'));
  assert.deepEqual(await r.call(p, v), generation('edition-2'), 'not the earlier edition\'s answer');
  assert.equal(r.wires().length, sent + 1);
  const own = r.calls(p).find(row => row.id !== old!.id)!;
  assert.equal(own.value.packet!.kind, 'initial');
  assert.deepEqual(r.stateOf(p, v).callGuards.map(guard => guard.id), [own.id]);
  assert.equal(r.store.get<ModelCall>(old!.id)!.hash, old!.hash, 'the earlier edition\'s call stays as it was');
});

test('4T.2 no caller ready on the real path: a ready flag selects no variant branch, a variant purpose without its subject refuses before payment', async t => {
  const r = await realPath(t), p = await r.project('p');
  const v = r.subject('proposal', r.transport('snapshot'), r.transport('mode'));
  const plan = r.head(p).plan, before = r.store.identities('list'), sent = r.wires().length;
  const {variantSubject:_omitted, ...bare} = {variantSubject:v, question:{id:plan.id, ...plan.value.spec}, core:{objective:'x'}, map:{nodes:[]}, history:[], readings:[]};
  for (const context of [{...bare, ready:true}, {...bare, variantReady:true, selection:'ready'}])
    await assert.rejects(() => researchCall(p.environment.value.implementer, p.environment.value, 'x', context, undefined,
      {store:r.store, draftId:p.draftId, questionId:p.planId, purpose:'variant-proposal'}), errorCode('discovery_variant_subject_invalid'));
  await assert.rejects(() => researchCall(p.environment.value.implementer, p.environment.value, 'x', {...bare, variantSubject:{...v, ready:true}},
    undefined, {store:r.store, draftId:p.draftId, questionId:p.planId, purpose:'variant-proposal'}), errorCode('discovery_variant_subject_invalid'));
  assert.deepEqual(r.store.identities('list'), before);
  assert.equal(r.wires().length, sent);
});

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

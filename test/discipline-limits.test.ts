import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fixture} from './synthesis-session-fixture.js';
import {configureReaderPilot,pilotEnvironment} from '../src/discovery/reader-pilot.js';
import {previewResearch} from '../src/discovery/research-preview.js';
import {reference} from '../src/pipeline/contracts.js';
import {researchAction,researchCall} from '../src/discovery/research-protocol.js';

function provider(path:string,body:string){writeFileSync(path,`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;${body}\nconsole.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);}

test('final synthesis accepts five distinct lookups including an original above 60000; only a repeated delivered key stops it',async t=>{
  const f=await fixture(t,20,300000,0.35,0,{maxReadChars:100,maxReplyChars:128,contextLimits:{maxLookups:1,maxChars:100}});
  f.context.resources={a:'A'.repeat(70000),b:'B',c:'C',d:'D',e:'E'};
  provider(f.path,`const keys=['a','b','c','d','e'],seen=(c.contextWorkspace??[]).map(e=>e.pointer),next=keys.find(k=>!seen.includes('/body/resources/'+k));
const research=next?{action:'read_context',record:c.working.archive,pointer:'/body/resources/'+next,purpose:'Retrieve distinct required original '+next}:{action:'pause',reason:'All five originals delivered'};`);
  assert.equal((await f.invoke()).action,'pause');
  const session=f.store.get<any>(f.before.id)!;
  assert.equal(session.value.workspace.entries.length,5);assert.equal(session.value.finalization.lookups,5);
  assert.ok(JSON.stringify(session.value.workspace.entries).length>60000);
  assert.equal(session.value.workspace.entries[0].result.value,f.context.resources.a);
  assert.deepEqual(f.store.get(f.pilot.id),f.pilot);
  provider(f.path,`const research={action:'read_context',record:c.working.archive,pointer:'/body/resources/a',purpose:'Repeat already delivered A'};`);
  const before=f.store.list('model-call').length;
  await assert.rejects(f.invoke(),{code:'research_no_progress'});
  assert.equal(f.store.list('model-call').length,before+1);
  await assert.rejects(f.invoke(),{code:'research_no_progress'});
  assert.equal(f.store.list('model-call').length,before+1);
});

test('structured missing facts enter the ordinary planner and the complete original model response remains unchanged',async t=>{
  const f=await fixture(t,20,300000);
  const {projectId:_,...settings}=f.pilot.value;
  configureReaderPilot(f.store,f.engine.environments,'p',{...settings,maxReplyChars:128,planning:{fields:[f.question.value.spec.field],maxRounds:1,maxRequestChars:1000}},f.pilot.revision);
  const rich={action:'need_research',question:f.question.id,reason:'Required basis is absent',missingFacts:[{id:'consumer-proof',required:'Establish the actual consumer',savedLocations:['src/example.ts:10–20']}],preservation:{unresolved:'The obligation remains open'}};
  provider(f.path,`const research=c.dispatchMode==='planning'?((c.researchMissing??c.missing)?.length?{action:'pause',reason:'Planner received canonical missing facts'}:{action:'synthesize',question:c.question.id}):${JSON.stringify(rich)};`);
  const firstRun = await f.engine.researcher.run('p',f.draft.id,4);
  assert.equal(firstRun.value.status,'paused','the saved pause of the unfinished session is delivered to its reserved turn and stops the call (№1658 К2/поправка 6)');
  await f.engine.researcher.run('p',f.draft.id,4);
  const calls=f.store.list<any>('model-call');
  const planner=calls.filter(call=>call.value.purpose==='reading-planner').sort((a,b)=>a.value.startedAt-b.value.startedAt);assert.equal(planner.length,1,'The early resume of the saved synthesis response precedes planning; maxRounds1 does not block its request');
  const last=JSON.parse(f.store.get<any>(planner.at(-1)!.value.request.record.id)!.value.text);
  const missing=last.subject.researchMissing??last.subject.missing;
  assert.equal(missing.length,1);assert.ok(missing[0].includes('src/example.ts:10–20'));assert.ok(missing[0].includes('The obligation remains open'));
  const raw=calls.map(call=>call.value.response?.record).filter(Boolean).map(ref=>JSON.parse(f.store.get<any>(ref.id)!.value.text).research).find(value=>value?.missingFacts);
  assert.deepEqual(raw,rich);
});

test('normalization preserves exact structured facts and context without changing the original or accepting missing identities',()=>{
  const value={action:'need_research',question:'q',missing:[{required:'A',savedRecords:[{id:'source:exact',revision:2,hash:'x'}]}],missingFacts:[{id:'B',required:'B',savedLocations:['a:1–2']}],reason:'Both required',preservation:{owner:'unchanged'}};
  const original=structuredClone(value),result=researchAction(value);
  assert.deepEqual(value,original);assert.equal(result.action,'need_research');if(result.action!=='need_research')throw Error();
  assert.equal(result.missing.length,2);assert.ok(result.missing[0]!.includes('source:exact'));assert.ok(result.missing[0]!.includes('unchanged'));assert.ok(result.missing[1]!.includes('a:1–2'));
  for(const bad of [{action:'need_research',missingFacts:[{required:'A'}]},{action:'need_research',question:'q',reason:'No fact'},{action:'need_research',question:'q',missingFacts:[null]},{action:'need_research',question:'q',missingFacts:[{}]},{action:'need_research',question:'q',missingFacts:[3]},{action:'need_research',question:'q',missingFacts:'A'}])assert.throws(()=>researchAction(bad),{code:'research_response_invalid'});
});


test('a required original may use more than half of an assessor request when the complete transport packet fits',async t=>{
  const f=await fixture(t,20,300000);
  const text='E'.repeat(180000),source=f.engine.discovery.evidence.document('p','large-original',text,'text/plain',0);
  const env=pilotEnvironment(f.engine.environments.get('p').value,f.pilot.value);
  const before=f.store.list('model-call').length;
  const p=await previewResearch(()=>researchCall(env.reviewer,env,'Assess the supplied original',
    {...f.context,contextWorkspace:[{record:reference(source),pointer:'/content',value:text}]},undefined,
    {store:f.store,draftId:f.draft.id,questionId:f.question.id,purpose:'assessor',pilot:f.pilot}));
  assert.ok(p.chars>150000&&p.chars<=300000);
  assert.equal(JSON.parse(p.input).subject.contextWorkspace[0].value,text);
  assert.equal(f.store.list('model-call').length,before);
});

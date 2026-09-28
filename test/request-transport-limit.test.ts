import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './synthesis-session-fixture.js';
import {previewResearch} from '../src/discovery/research-preview.js';
import {consolidationLimits} from '../src/discovery/conclusion-consolidation.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {pilotEnvironment} from '../src/discovery/reader-pilot.js';

test('a continuation above the old guide uses maxRequestChars without compression or profile rewrite',async t=>{
  const f=await fixture(t,20,300000,0.35,0,{maxContinuationChars:100000});
  f.context.request={required:'x'.repeat(120000)};
  const p=await previewResearch(f.invoke),wire=JSON.parse(p.input);
  assert.equal(p.limit,300000);assert.ok(p.chars>100000&&p.chars<=300000);
  assert.equal(wire.subject.dispatchMode,'synthesis');
  assert.equal((await f.invoke()).action,'pause');
  assert.equal(f.wires().filter(w=>w.subject.dispatchMode==='consolidation').length,0);
  assert.deepEqual(f.store.get(f.pilot.id),f.pilot);
});

test('the same transport ceiling governs packets even when legacy continuation or planning guides are smaller',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{maxContinuationChars:1000,contextLimits:{maxChars:60000,maxLookups:3},planning:{fields:['unused'],maxRequestChars:1000,maxRounds:5}});
  const p=await previewResearch(f.invoke);assert.equal(p.limit,100000);assert.ok(p.chars>1000);
  assert.equal(consolidationLimits(f.pilot.value).carry,35000);
  const env=pilotEnvironment(f.engine.environments.get('p').value,f.pilot.value);
  const planner=()=>researchCall(env.implementer,env,'Plan',f.context,undefined,
    {store:f.store,draftId:f.draft.id,questionId:f.question.id,purpose:'reading-planner',pilot:f.pilot});
  const first=await previewResearch(planner);
  assert.equal(first.limit,100000);assert.ok(first.chars>1000);
  assert.equal(JSON.parse(first.input).subject.continuation.kind,'initial');
  await planner();
  const next=await previewResearch(planner);
  assert.equal(next.limit,100000);assert.ok(next.chars>1000);
  assert.equal(JSON.parse(next.input).subject.continuation.kind,'continuation');
});

test('above maxRequestChars the existing capacity refusal still stops before payment',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{maxContinuationChars:500000});
  f.context.request={required:'x'.repeat(110000)};
  await assert.rejects(f.invoke(),{code:'research_context_capacity'});
  assert.equal(f.store.list('model-call').length,f.setupCalls);assert.deepEqual(f.store.get(f.pilot.id),f.pilot);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './synthesis-session-fixture.js';
import { reference } from '../src/pipeline/contracts.js';
import { contextLookupKey, contextWorkspace, packContextWorkspace } from '../src/discovery/context-workspace.js';
import { readResearchContext } from '../src/discovery/research-limits.js';
import { compactConclusions } from '../src/discovery/continuation-packet.js';
import { synthesisControls } from '../src/discovery/synthesis-controls.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { checkpoint } from '../src/discovery/research-continuation.js';
import { activeSynthesisNotes } from '../src/discovery/conclusion-consolidation.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import type { Json } from '../src/canonical.js';

function addressed(f: Awaited<ReturnType<typeof fixture>>, count = 3, chars = 20) {
  const record = f.store.write({ id: 'research-context:finalization-fixture', kind: 'research-context', expected: 0,
    value: { projectId: 'p', draft: reference(f.draft), question: reference(f.question), body: { items: Array.from({length:count},(_,i)=>String(i).repeat(chars)) } } });
  return Array.from({length:count},(_,i)=>readResearchContext(f.store,f.draft,f.question.id,f.pilot,reference(record),'/body/items/'+i));
}
function atFinal(f: Awaited<ReturnType<typeof fixture>>, entries: ReturnType<typeof addressed>, sinceProgress: number) {
  const session=f.store.get<any>(f.before.id)!;
  return f.store.write<any>({id:session.id,kind:session.kind,expected:session.revision,value:{...session.value,offset:1,materialOffset:0,
    workspace:{entries:entries.map(result=>({key:contextLookupKey(result),result})),sinceProgress}}});
}
function adapter(f: Awaited<ReturnType<typeof fixture>>, code: string) {
  writeFileSync(f.path, `import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(join(f.root,'wire.ndjson'))},JSON.stringify(r)+'\\n');let research;${code}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
}

test('reference/unresolved dictionaries retain exact identities and escape reserved-shaped literal values',()=>{
  const ref={id:'checkpoint:original',revision:1,hash:'a'.repeat(64)};
  const literal=JSON.parse('{"refId":0}'),prototype=JSON.parse('{"__proto__":{"condition":"must survive"}}');
  const packed=compactConclusions([{checkpoint:ref,proposal:{value:{one:ref,two:ref,literal,prototype},citations:[],unresolved:['Exception A','Exception A']}}]);
  assert.deepEqual(packed.references,[ref]); assert.deepEqual(packed.unresolved,['Exception A']);
  assert.equal(packed.items[0].checkpoint.refId,0);assert.equal(packed.items[0].proposal.value.two.refId,0);
  assert.deepEqual(packed.items[0].proposal.value.literal,{literal});
  assert.equal(packed.items[0].proposal.value.prototype.__proto__.condition,'must survive');
  assert.ok(JSON.stringify(packed.items).includes('__proto__'));
  assert.deepEqual(packed.items[0].proposal.unresolvedIds,[0,0]);
  const collision={citationIds:[91],unresolvedIds:[92],citations:[],unresolved:['Must remain literal']};
  assert.deepEqual(compactConclusions(collision).items,{literal:collision});
});

test('all uncheckpointed originals remain together; capacity failure is explicit instead of silently evicting one',async t=>{
  const f=await fixture(t,20),originals=addressed(f,3,1800);
  const packet:Record<string,any>={contextWorkspace:originals};
  packContextWorkspace(packet,9000,7000,{checkpointedKeys:[]});assert.deepEqual(packet.contextWorkspace,originals);
  assert.throws(()=>packContextWorkspace({contextWorkspace:originals},5000,7000,{checkpointedKeys:[]}),{code:'research_context_capacity'});
  const smaller:Record<string,any>={contextWorkspace:originals};
  packContextWorkspace(smaller,6500,7000,{checkpointedKeys:originals.slice(0,2).map(contextLookupKey)});
  assert.ok(smaller.contextWorkspace.some((x:any)=>contextLookupKey(x)===contextLookupKey(originals[2]!)));
  assert.equal(smaller.contextIndex.length,3);
  assert.throws(()=>contextWorkspace({entries:[],sinceProgress:0,checkpointedKeys:['foreign']}),{code:'research_context_invalid'});
});

test('a final checkpoint records newly delivered context without moving the material cursor or refreshing final lookup quota',async t=>{
  const f=await fixture(t,20),originals=addressed(f);atFinal(f,originals,3);
  const citations=(f.notes[0]!.proposal as any).citations;
  adapter(f,`if(c.contextControls.mode!=='finalization'||c.contextControls.remainingLookups!==0)throw Error('Expected terminal mode');
if(!existsSync('checkpoint-sent')){writeFileSync('checkpoint-sent','1');research={action:'checkpoint',question:c.question.id,value:{finding:'New exact context resolves the named condition'},citations:[],unresolved:[]};}
else research={action:'answer',question:c.question.id,value:{result:'Ready for ordinary assessment'},citations:${JSON.stringify(citations)}};`);
  const result=await f.invoke();assert.equal(result.action,'answer');
  const session=f.store.get<any>(f.before.id)!;
  assert.equal(session.value.offset,1);assert.equal(session.value.notes.length,4);assert.equal(session.value.finalization.lookups,3);
  assert.equal(session.value.workspace.sinceProgress,0);assert.deepEqual(session.value.workspace.checkpointedKeys,originals.map(contextLookupKey));
  assert.equal(f.store.list('model-call').length,3);assert.equal(f.store.get<any>(f.question.id)!.value.status,'open');
  assert.ok(f.wires().slice(1).every(w=>w.subject.contextWorkspace.length===3));
});

test('an ordinary final-stage search after the declared allowance is refused before payment; a terminal answer path remains',async t=>{
  const f=await fixture(t,20),originals=addressed(f);const session=atFinal(f,originals,3);
  const env=pilotEnvironment(f.engine.environments.get('p').value,f.pilot.value);
  await assert.rejects(researchCall(env.implementer,env,'',{...f.context,contextControls:{version:2,stage:'final',mode:'research',remainingLookups:0}},undefined,
    {store:f.store,draftId:f.draft.id,questionId:f.question.id,purpose:'analyst',pilot:f.pilot,session:reference(session)}),{code:'research_no_progress'});
  assert.equal(f.store.list('model-call').length,1);
  const p=JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(p.subject.contextControls.mode,'finalization');assert.ok(p.prompt.includes('need_research'));assert.ok(p.prompt.includes('read_context is unavailable'));
});

test('a final-stage lookup requires a concrete purpose; a paid invalid response is retained without another invocation',async t=>{
  const f=await fixture(t,20),originals=addressed(f,1);atFinal(f,[],0);
  adapter(f,`research={action:'read_context',record:${JSON.stringify(originals[0]!.record)},pointer:'/body/items/0'};`);
  await assert.rejects(f.invoke(),{code:'synthesis_context_purpose_missing'});
  assert.equal(f.store.list('model-call').length,2);
  assert.ok(f.store.get<any>(f.before.id)!.value.workspace.blocked);
  await assert.rejects(f.invoke(),{code:'research_no_progress'});assert.equal(f.store.list('model-call').length,2);
});

test('terminal pauses and repeated checkpoints cannot buy an unbounded retry with unchanged knowledge',async t=>{
  for(const response of ['pause','checkpoint']){
    const f=await fixture(t,20);atFinal(f,addressed(f),3);
    adapter(f,response==='pause'?`research={action:'pause',reason:'No result from this attempt'};`:`research={action:'checkpoint',question:c.question.id,value:{finding:'The same proposed finding'},citations:[],unresolved:[]};`);
    if(response==='pause')assert.equal((await f.invoke()).action,'pause');
    else await assert.rejects(f.invoke(),{code:'synthesis_no_progress'});
    const calls=f.store.list('model-call').length;
    assert.equal(calls,response==='pause'?2:3);
    await assert.rejects(f.invoke(),{code:'research_no_progress'});assert.equal(f.store.list('model-call').length,calls);
  }
});

test('a pending legacy oversized summary gets one bounded format upgrade without rereading or altering its originals',async t=>{
  const f=await fixture(t,20),proposal={action:'checkpoint' as const,question:f.question.id,value:{finding:'x'.repeat(22000)},citations:[],unresolved:['Preserve this uncertainty']};
  const saved=checkpoint(f.store,f.draft,f.question,{...proposal,value:proposal as unknown as Json});
  const legacy={checkpoint:reference(saved),proposal,page:{offset:0,end:0},consolidated:{replaces:f.notes.map(n=>n.checkpoint)}};
  const s=f.store.get<any>(f.before.id)!;f.store.write({id:s.id,kind:s.kind,expected:s.revision,value:{...s.value,notes:[...s.value.notes,legacy]}});
  assert.equal((await f.invoke()).action,'pause');
  const after=f.store.get<any>(f.before.id)!;assert.deepEqual(after.value.notes.slice(0,4),[...f.notes,legacy]);
  const active=activeSynthesisNotes(after.value.notes);assert.equal(active.length,1);assert.equal(active[0]!.consolidated!.format,2);
  assert.ok(JSON.stringify(compactConclusions(active).items).length<=active[0]!.consolidated!.targetChars!);
  assert.equal(f.wires().filter(w=>w.subject.dispatchMode==='consolidation').length,1);
});

test('context recovery preserves exhausted final-stage accounting instead of granting another search round',async t=>{
  const f=await fixture(t,20),originals=addressed(f,2);const s=atFinal(f,originals.slice(0,1),3);
  const blocked=f.store.write<any>({id:s.id,kind:s.kind,expected:s.revision,value:{...s.value,workspace:{...s.value.workspace,blocked:'Too many context lookups'}}});
  const recovered=await f.engine.execute({type:'recover-context-session',project:'p',session:reference(blocked),selector:{record:originals[1]!.record,pointer:originals[1]!.pointer}}) as any;
  assert.equal(recovered.value.workspace.sinceProgress,0);assert.equal(recovered.value.finalization.lookups,3);
  assert.equal(synthesisControls(true,recovered.value.workspace,3,recovered.value.finalization).mode,'finalization');
});

test('the summary target is reduced to the space left after exact context, and all new context survives compaction',async t=>{
  const f=await fixture(t,12000,80000);atFinal(f,addressed(f,3,18000),3);
  const preview=JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(preview.subject.dispatchMode,'consolidation');
  assert.ok(preview.subject.consolidation.targetChars>0 && preview.subject.consolidation.targetChars<14000);
  const archive=f.store.get<any>(preview.subject.working.archive.id)!;
  assert.ok(archive.value.body.consolidation.fullTargetChars<30000);
  assert.equal((await f.invoke()).action,'pause');
  const next=f.wires().at(-1);assert.equal(next.subject.contextWorkspace.length,3);
  assert.ok(next.subject.contextWorkspace.every((entry:any)=>entry.value.length===18000));
  assert.ok(JSON.stringify(next).length<=80000);
});

test('new unresolved content counts against the complete compact target and cannot buy a second overlarge summary',async t=>{
  const f=await fixture(t,12000,80000);atFinal(f,addressed(f,3,18000),3);
  adapter(f,`if(c.dispatchMode!=='consolidation')throw Error('Oversized compaction must stop before ordinary generation');
research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'The conditions remain distinct'}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['Z'.repeat(30000)]};`);
  await assert.rejects(f.invoke(),{code:'consolidation_target_limit'});
  const active=activeSynthesisNotes(f.store.get<any>(f.before.id)!.value.notes),note=active[0]!,packed=compactConclusions(active);
  assert.ok(JSON.stringify(packed.items).length<note.consolidated!.targetChars!);
  assert.ok(JSON.stringify(packed).length>note.consolidated!.fullTargetChars!);
  assert.equal(f.store.list('model-call').length,2);
  await assert.rejects(f.invoke(),{code:'consolidation_target_limit'});assert.equal(f.store.list('model-call').length,2);
});

test('delivering the last page enters finalization even before its cursor is acknowledged by a checkpoint',async t=>{
  const f=await fixture(t,20),s=atFinal(f,addressed(f),3);
  f.store.write({id:s.id,kind:s.kind,expected:s.revision,value:{...s.value,offset:0,materialOffset:5}});
  const packet=JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(packet.subject.synthesisState.offset,0);assert.equal(packet.subject.synthesisPage.complete,true);
  assert.equal(packet.subject.contextControls.stage,'final');assert.equal(packet.subject.contextControls.mode,'finalization');
  assert.ok(packet.prompt.includes('read_context is unavailable'));
  assert.equal(f.store.list('model-call').length,1);
});

test('a lookup from the just-delivered final page also requires purpose before it can consume another context slot',async t=>{
  const f=await fixture(t,20),original=addressed(f,1)[0]!;
  adapter(f,`research={action:'read_context',record:${JSON.stringify(original.record)},pointer:'/body/items/0'};`);
  await assert.rejects(f.invoke(),{code:'synthesis_context_purpose_missing'});
  assert.equal(f.store.list('model-call').length,2);
  assert.equal(f.store.get<any>(f.before.id)!.value.offset,0);
});

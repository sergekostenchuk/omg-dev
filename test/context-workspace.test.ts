import test from 'node:test';
import assert from 'node:assert/strict';
import {addContextLookup,contextWorkspace,contextLookupKey,packContextWorkspace,requireContextDelivery,type ContextLookup} from '../src/discovery/context-workspace.js';

const lookup=(name:string,value:unknown,revision=1):ContextLookup=>({record:{id:`source:${name}`,revision,hash:String(revision).repeat(64)},pointer:'/content',value});

test('capacity evicts only packet values, while distinct originals remain unbounded and an exact repeat is refused',()=>{
 const a=lookup('a','A'.repeat(550)),b=lookup('b','B'.repeat(550)),c=lookup('c','C'.repeat(550)),d=lookup('d','D'.repeat(550));
 const state=addContextLookup(addContextLookup(addContextLookup(addContextLookup(contextWorkspace(),a),b),c),d);
 assert.equal(state.entries.length,4);
 const packet={contextWorkspace:state.entries.map(entry=>entry.result),
   working:{archive:{id:'research-context:workspace',revision:1,hash:'f'.repeat(64)}}} as Record<string,any>;
 packContextWorkspace(packet,6000,900);
 assert.deepEqual(packet.contextWorkspace,[d]);
 assert.equal(packet.contextIndexPage?.total,4);
 assert.ok(packet.contextIndex.length>0&&packet.contextIndex.length<4);
 assert.deepEqual(state.entries.map(entry=>entry.result),[a,b,c,d]);
 const restored=addContextLookup(state,a,packet.contextWorkspace);
 const next={contextWorkspace:restored.entries.map(entry=>entry.result),working:packet.working};
 packContextWorkspace(next,6000,900);
 assert.deepEqual(next.contextWorkspace,[a]);
 assert.equal(restored.sinceProgress,5);
 assert.throws(()=>addContextLookup(restored,a,next.contextWorkspace),{code:'research_no_progress'});
});

test('a context projection must deliver its newest original and retain the addresses of omitted values',()=>{
 const a=lookup('a','A'),b=lookup('b','B');
 assert.throws(()=>requireContextDelivery([a,b],{contextWorkspace:[a],contextIndex:[]}),{code:'research_context_undelivered'});
 assert.throws(()=>requireContextDelivery([a,b],{contextWorkspace:[b],contextIndex:[]}),{code:'research_context_undelivered'});
 assert.throws(()=>requireContextDelivery([a],{contextWorkspace:[lookup('foreign','A')]}),{code:'research_context_undelivered'});
 const big=lookup('big','x'.repeat(10000));
 const bounded={contextWorkspace:[big]} as Record<string,any>;
 packContextWorkspace(bounded,3000,1000);
 assert.deepEqual(bounded.contextWorkspace,[]);
 assert.equal(bounded.contextDelivery[0].served.offset,0);
 assert.ok(bounded.contextDelivery[0].served.end>0);
 assert.equal(bounded.contextDelivery[0].served.next,bounded.contextDelivery[0].served.end);
 requireContextDelivery([big],bounded);
 assert.throws(()=>requireContextDelivery([big],{...bounded,contextIndex:[]}),{code:'research_context_undelivered'});
});

test('equal text from another source or revision never borrows the original evidence identity',()=>{
 const a=lookup('a','same'),other=lookup('b','same'),revision=lookup('a','same',2);
 assert.notEqual(contextLookupKey(a),contextLookupKey(other));
 assert.notEqual(contextLookupKey(a),contextLookupKey(revision));
 const state=addContextLookup(addContextLookup(addContextLookup(contextWorkspace(),a),other),revision);
 assert.equal(state.entries.length,3);
 const alias={...a,record:{...a.record,id:'research-context:one'}};
 assert.equal(contextLookupKey(alias),contextLookupKey({...alias,record:{...alias.record,id:'research-context:two'}}));
});

import { foldContextEvent, type ContextWorkspace } from '../src/discovery/context-workspace.js';
import { addressedWorkspace } from '../src/discovery/research-continuation.js';
import { projectAddressedWorkspace, type ManagedResearchTurn, type ContextTurnHistoryProof } from '../src/discovery/research-consumer-transition.js';
import { hashJson, canonical } from '../src/canonical.js';
import type { Store, Revision } from '../src/storage/store.js';
import type { Question } from '../src/discovery/discovery.js';
import type { ResearchTurn } from '../src/discovery/research-model.js';
import { reference } from '../src/pipeline/contracts.js';

// Pure fold inputs, not manufactured persisted research or producer proofs.
function foldFixture(actions: string[]) {
 const q={id:'question:p:fold',kind:'question',revision:1,value:{projectId:'p'}} as Revision<Question>;
 q.hash=hashJson(q.value);
 const records=['a','b'].map(name=>({id:`context:${name}`,kind:'fixture-context',revision:1,
   value:{text:name},hash:hashJson({text:name})}));
 let reads=0;
 const history:ContextTurnHistoryProof[]=actions.map((action,index)=>{
  const record=records[reads++%2]!;
  const observation={record:reference(record),pointer:'/text',value:record.value.text};
  if(action!=='read_context')reads--;
  const value={run:'run:p',number:index+1,question:reference(q),status:'completed',error:null,assessment:null,
    action:action==='read_context'?{action,record:reference(record),pointer:'/text'}:{action},
    observation:action==='read_context'?observation:null} as ResearchTurn;
  return {turn:{id:`turn:${index+1}`,kind:'research-turn',revision:1,hash:hashJson(value),value},
    ...(action==='read_context'?{context:{projectId:'p',recordKind:record.kind,recordValue:record.value}}:{})};
 });
 const before={run:'run:p',number:history.length+1,question:reference(q),status:'pending'} as ManagedResearchTurn;
 const store={get:(id:string)=>records.find(record=>record.id===id)??null} as unknown as Store;
 return {q,history,before,store};
}

for(const progress of ['read_source','read_bundle','checkpoint','answer','answer_delta'])for(const populated of [false,true])
test(`RS2 ${progress} with ${populated?'nonempty':'empty'} keys preserves both folds, order and packet bytes`,()=>{
 const f=foldFixture([...(populated?['read_context']:[]),progress,'read_context','read_context','read_context']);
 const current=addressedWorkspace(f.store,f.history.map(h=>h.turn),f.q);
 const historical=projectAddressedWorkspace(f.before,f.history,reference(f.q));
 assert.deepEqual(current,historical);
 assert.equal(current.sinceProgress,3);
 assert.deepEqual(current.checkpointedKeys,populated?[contextLookupKey(f.history[0]!.turn.value.observation as ContextLookup)]:[]);
 const last=f.history.slice(-2).map(h=>h.turn.value.observation);
 assert.deepEqual(current.entries.map(e=>e.result),last,'latest occurrence moves an original, with no duplicate');
 const legacyPacket={contextWorkspace:last};
 assert.equal(canonical({contextWorkspace:current.entries.map(e=>e.result)}),canonical(legacyPacket));
 assert.throws(()=>addContextLookup(current,last[1] as ContextLookup),{code:'research_no_progress'});
});

test('RS2 replay is pure, preserves progress metadata, and refuses a missing lookup instead of skipping it',()=>{
 const a=lookup('a','A'),b=lookup('b','B');
 const state:ContextWorkspace={entries:[{key:contextLookupKey(a),result:a}],sinceProgress:0,
   checkpointedKeys:[contextLookupKey(a)],blocked:'saved-block'};
 const original=structuredClone(state);
 const result=foldContextEvent(state,'read_context',b);
 assert.deepEqual(state,original);assert.deepEqual(result.checkpointedKeys,original.checkpointedKeys);
 assert.equal(result.blocked,'saved-block');assert.equal(result.sinceProgress,1);
 assert.strictEqual(foldContextEvent(state,'search'),state);
 assert.throws(()=>foldContextEvent(state,'read_context'),{code:'research_context_invalid'});
});

for(const damage of ['missing-turn','substituted-turn','number-gap','missing-proof','lookup-basis','question-revision'])
test(`RS2 historical fold rejects ${damage} before accepting an incomplete workspace`,()=>{
 const f=foldFixture(['read_context','checkpoint','read_context']);
 const history=structuredClone(f.history),before=structuredClone(f.before);
 if(damage==='missing-turn')history.splice(0,1);
 if(damage==='substituted-turn')history[0]!.turn.value.run='foreign';
 if(damage==='number-gap'){history[0]!.turn.value.number=2;history[0]!.turn.hash=hashJson(history[0]!.turn.value);}
 if(damage==='missing-proof')delete history[0]!.context;
 if(damage==='lookup-basis')history[0]!.context!.recordValue={text:'substituted'};
 if(damage==='question-revision')before.question={...before.question!,revision:2};
 assert.throws(()=>projectAddressedWorkspace(before,history,reference(f.q)),{code:'research_consumer_intent_invalid'});
});

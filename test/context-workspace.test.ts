import test from 'node:test';
import assert from 'node:assert/strict';
import {addContextLookup,contextWorkspace,contextLookupKey,packContextWorkspace,requireContextDelivery,type ContextLookup} from '../src/discovery/context-workspace.js';

const lookup=(name:string,value:unknown,revision=1):ContextLookup=>({record:{id:`source:${name}`,revision,hash:String(revision).repeat(64)},pointer:'/content',value});

test('capacity evicts only packet values, while distinct originals remain unbounded and an exact repeat is refused',()=>{
 const a=lookup('a','A'.repeat(550)),b=lookup('b','B'.repeat(550)),c=lookup('c','C'.repeat(550)),d=lookup('d','D'.repeat(550));
 const state=addContextLookup(addContextLookup(addContextLookup(addContextLookup(contextWorkspace(),a),b),c),d);
 assert.equal(state.entries.length,4);
 const packet={contextWorkspace:state.entries.map(entry=>entry.result)} as Record<string,any>;
 packContextWorkspace(packet,6000,900);
 assert.deepEqual(packet.contextWorkspace,[d]);
 assert.equal(packet.contextIndex.length,4);
 assert.deepEqual(state.entries.map(entry=>entry.result),[a,b,c,d]);
 const restored=addContextLookup(state,a,packet.contextWorkspace);
 const next={contextWorkspace:restored.entries.map(entry=>entry.result)};
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
 assert.throws(()=>packContextWorkspace({contextWorkspace:[lookup('big','x'.repeat(10000))]},3000,1000),{code:'research_context_undelivered'});
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

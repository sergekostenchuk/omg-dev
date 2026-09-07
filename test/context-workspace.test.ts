import test from 'node:test';
import assert from 'node:assert/strict';
import {addContextLookup,contextWorkspace,contextLookupKey,packContextWorkspace,requireContextDelivery,type ContextLookup} from '../src/discovery/context-workspace.js';

const lookup=(name:string,value:unknown,revision=1):ContextLookup=>({record:{id:`source:${name}`,revision,hash:String(revision).repeat(64)},pointer:'/content',value});

test('capacity evicts only the packet value; a retained selector can restore its exact original',()=>{
 const a=lookup('a','A'.repeat(550)),b=lookup('b','B'.repeat(550));
 const state=addContextLookup(addContextLookup(contextWorkspace(),a),b);
 const packet={contextWorkspace:state.entries.map(entry=>entry.result)} as Record<string,any>;
 packContextWorkspace(packet,6000,900);
 assert.deepEqual(packet.contextWorkspace,[b]);
 assert.equal(packet.contextIndex.length,2);
 assert.deepEqual(state.entries.map(entry=>entry.result),[a,b]);
 const restored=addContextLookup(state,a,packet.contextWorkspace,4);
 const next={contextWorkspace:restored.entries.map(entry=>entry.result)};
 packContextWorkspace(next,6000,900);
 assert.deepEqual(next.contextWorkspace,[a]);
 assert.equal(restored.sinceProgress,3);
 assert.throws(()=>addContextLookup(restored,a,next.contextWorkspace,4),{code:'research_no_progress'});
 assert.throws(()=>addContextLookup(restored,b,next.contextWorkspace,3),{code:'research_no_progress'});
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

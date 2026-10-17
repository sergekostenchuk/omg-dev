import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { preparedFeatures } from './product-fixture.js';
import type { Question } from '../src/discovery/discovery.js';
import { pilotContext } from '../src/discovery/pilot-context.js';
import { join } from 'node:path';
import { fixture } from './synthesis-session-fixture.js';
import { reference } from '../src/pipeline/contracts.js';
import { contextLookupKey, contextWorkspace, packContextWorkspace, requireContextDelivery } from '../src/discovery/context-workspace.js';
import { readResearchContext } from '../src/discovery/research-limits.js';
import { compactConclusions } from '../src/discovery/continuation-packet.js';
import { synthesisControls } from '../src/discovery/synthesis-controls.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { configureReaderPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { synthesisSession, readSynthesisSession } from '../src/discovery/synthesis-session.js';
import { activeSynthesisNotes } from '../src/discovery/conclusion-consolidation.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import { checkpoint } from '../src/discovery/research-continuation.js';
import { hashJson, digest } from '../src/canonical.js';

type F = Awaited<ReturnType<typeof fixture>>;

function addressed(f: F, count = 3, chars = 20) {
  const record = f.store.write({ id: `research-context:finalization-fixture:${count}:${chars}`, kind: 'research-context', expected: 0,
    value: { projectId: 'p', draft: reference(f.draft), question: reference(f.question), body: { items: Array.from({length:count},(_,i)=>String(i).repeat(chars)) } } });
  return Array.from({length:count},(_,i)=>readResearchContext(f.store,f.draft,f.question.id,f.pilot,reference(record),'/body/items/'+i));
}

function adapter(f: F, code: string) {
  writeFileSync(f.path, `import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(join(f.root,'wire.ndjson'))},JSON.stringify(r)+'\\n');let research;${code}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
}

/** The final-stage state is reached only by real paid steps (№1555 X29/X30):
 * checkpoint the remaining material pages, then deliver each addressed entry
 * by its own paid read_context step; the produced pause parks the session.
 * With acknowledge=true a last checkpoint records the delivered context. */
async function atFinal(f: F, entries: ReturnType<typeof addressed>, acknowledge = false,
  run: () => Promise<unknown> = f.invoke) {
  const queue = entries.map(e => ({ record: e.record, pointer: e.pointer }));
  adapter(f, `const queue=${JSON.stringify(queue)},acknowledge=${acknowledge};
if(c.dispatchMode==='consolidation')research={action:'checkpoint',question:c.question.id,value:{summaries:c.consolidation.notes.map((n,i)=>({notes:[i],text:'Finding '+i+' retains its exception and unresolved condition'})),citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]};
else if(c.dispatchMode==='synthesis'&&!c.synthesisPage.complete)research={action:'checkpoint',question:c.question.id,value:{finding:'Remaining page findings'},citations:[],unresolved:[]};
else{const seen=(c.contextWorkspace??[]).map(e=>e.record.id+':'+e.pointer),next=queue.find(e=>!seen.includes(e.record.id+':'+e.pointer));
if(next)research={action:'read_context',record:next.record,pointer:next.pointer,purpose:'Deliver the addressed finalization context'};
else if(acknowledge&&!existsSync('acknowledged')){writeFileSync('acknowledged','1');research={action:'checkpoint',question:c.question.id,value:{finding:'Acknowledged delivered context'},citations:[],unresolved:[]};}
else research={action:'pause',reason:'atFinal complete'};}`);
  const stopped = await run();
  assert.equal((stopped as any).action, 'pause', 'atFinal ends at the produced pause');
  return f.store.get<any>(f.before.id)!;
}

/** A roomier pilot for the setup drive (№1555 X30): the preparation must not
 * consolidate mid-build; tighten() then returns the measured entry under a
 * fresh revision of the fixture's original tight pilot (the current head). */
function roomyDrive(f: F, chars: number) {
  const { projectId: _p, ...rest } = f.pilot.value;
  const environment = f.engine.environments.get('p');
  const invokeWith = (pilot: typeof f.pilot) => () => synthesisSession(f.store, f.draft, f.question, environment,
    pilotEnvironment(environment.value, pilot.value), pilot, f.context, 'Return the declared research action');
  const roomy = configureReaderPilot(f.store, f.engine.environments, 'p',
    { ...rest, maxRequestChars: chars, maxContinuationChars: chars }, f.pilot.revision);
  return { drive: invokeWith(roomy),
    tighten: () => invokeWith(configureReaderPilot(f.store, f.engine.environments, 'p', rest, roomy.revision)) };
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
  const f=await fixture(t,20,100000,0.35,0,{},0,'small'),originals=addressed(f,3,1800);
  const packet:Record<string,any>={contextWorkspace:originals};
  packContextWorkspace(packet,9000,7000,{checkpointedKeys:[]});assert.deepEqual(packet.contextWorkspace,originals);
  const bounded: Record<string, any> = { contextWorkspace: originals };
  packContextWorkspace(bounded, 5000, 7000, { checkpointedKeys: [] });
  requireContextDelivery(originals, bounded);
  assert.equal(bounded.contextIndex.length, 3);
  assert.ok(bounded.contextWorkspace.length > 0 && bounded.contextWorkspace.length < 3);
  const smaller:Record<string,any>={contextWorkspace:originals};
  packContextWorkspace(smaller,6500,7000,{checkpointedKeys:originals.slice(0,2).map(contextLookupKey)});
  assert.ok(smaller.contextWorkspace.some((x:any)=>contextLookupKey(x)===contextLookupKey(originals[2]!)));
  assert.equal(smaller.contextIndex.length,3);
  assert.throws(()=>contextWorkspace({entries:[],sinceProgress:0,checkpointedKeys:['foreign']}),{code:'research_context_invalid'});
});

test('a final checkpoint records newly delivered context without moving the material cursor; lookup accounting remains observational',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{},0,'small'),originals=addressed(f);
  await atFinal(f,originals);
  const baseline=f.store.list('model-call').length;
  const citations=(f.notes[0]!.proposal as any).citations;
  adapter(f,`if(c.contextControls.mode!=='finalization'||c.contextControls.remainingLookups!==null)throw Error('Expected unbounded finalization mode');
if(!existsSync('checkpoint-sent')){writeFileSync('checkpoint-sent','1');research={action:'checkpoint',question:c.question.id,value:{finding:'New exact context resolves the named condition'},citations:[],unresolved:[]};}
else research={action:'answer',question:c.question.id,value:{result:'Ready for ordinary assessment'},citations:${JSON.stringify(citations)}};`);
  const result=await f.invoke();assert.equal(result.action,'answer');
  const session=f.store.get<any>(f.before.id)!;
  assert.equal(session.value.offset,f.context.workingSelections.length);assert.equal(session.value.notes.length,f.before.value.notes.length+1);assert.equal(session.value.finalization.lookups,3);
  assert.equal(session.value.workspace.sinceProgress,0);assert.deepEqual(session.value.workspace.checkpointedKeys,originals.map(contextLookupKey));
  assert.equal(f.store.list('model-call').length,baseline+2);assert.equal(f.store.get<any>(f.question.id)!.value.status,'open');
  assert.ok(f.wires().slice(-2).every(w=>w.subject.contextWorkspace.length===3));
});

test('a final-stage read is allowed with a purpose after material completion, and finalization advertises it',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{},0,'small'),originals=addressed(f);const session=await atFinal(f,originals);
  const env=pilotEnvironment(f.engine.environments.get('p').value,f.pilot.value);
  await researchCall(env.implementer,env,'',{...f.context,contextControls:{version:2,stage:'final',mode:'finalization',remainingLookups:null}},undefined,
    {store:f.store,draftId:f.draft.id,questionId:f.question.id,purpose:'analyst',pilot:f.pilot,session:reference(session)});
  const p=JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(p.subject.contextControls.mode,'finalization');assert.equal(p.subject.contextControls.remainingLookups,null);assert.ok(p.prompt.includes('need_research'));assert.ok(p.prompt.includes('read_context'));
});

test('RD2b accepts C after its explicitly requested page without inventing a whole-parent obligation', async t => {
  const f = await fixture(t, 20, 100000, 0.35, 0, {}, 0, 'small');
  await atFinal(f, []);
  const original = f.store.write({ id: 'research-context:rd2b-c-final', kind: 'research-context', expected: 0,
    value: { projectId: 'p', draft: reference(f.draft), question: reference(f.question),
      body: { resources: { a: 'A'.repeat(150000) } } } });
  const ref = reference(original), baseline = f.store.list('model-call').length;
  adapter(f, `const calls=existsSync('rd2b-c-calls')?Number(readFileSync('rd2b-c-calls','utf8')):0;
if(calls>=10)throw Error('The bounded finalization did not finish in ten calls');
writeFileSync('rd2b-c-calls',String(calls+1));
const latest=c.contextWorkspace?.at(-1),next=c.contextCorrection?.next??latest?.page?.next??0;
if(!latest||c.contextCorrection||latest.page?.offset>0&&latest.page?.next!==null)
  research={action:'read_context',record:${JSON.stringify(ref)},pointer:'/body/resources/a',page:{offset:next,limit:50000},purpose:'Read the next exact saved portion'};
else research={action:'answer',question:c.question.id,value:{finding:'Only after the full original'},citations:[${JSON.stringify(f.citation)}]};`);
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const paid = f.wires().slice(baseline).map(w => w.subject);
  assert.equal(paid.length, 3,
    'one addressed read, one remaining synthesis material page, then the final answer');
  assert.ok(!paid.some(packet => packet.contextCorrection), 'the parent has no invented remaining obligation');
  assert.deepEqual(paid[2]!.contextWorkspace.at(-1).page,
    { offset: 0, end: 50000, total: 150000, unit: 'utf16', next: 50000 });
  assert.equal(f.store.list('model-call').length, baseline + paid.length);
  const saved = f.store.get<any>(f.before.id)!;
  assert.equal(saved.value.result.action, 'answer');
  readSynthesisSession(f.store, reference(saved));
});

test('a final-stage lookup requires a concrete purpose; a paid invalid response is retained without another invocation',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{},0,'small'),originals=addressed(f,1);await atFinal(f,[],false);
  const baseline=f.store.list('model-call').length;
  adapter(f,`research={action:'read_context',record:${JSON.stringify(originals[0]!.record)},pointer:'/body/items/0'};`);
  // The purposeless final-stage lookup is a saved blocked outcome of the paid
  // response; the same entry then reports the block without a new call.
  await assert.rejects(f.invoke(),{code:'research_no_progress'});
  const blocked=f.store.get<any>(f.before.id)!;
  assert.equal(blocked.value.blockedCode,'synthesis_context_purpose_missing');
  assert.ok(blocked.value.workspace.blocked);
  assert.equal(f.store.list('model-call').length,baseline+1);
  await assert.rejects(f.invoke(),{code:'research_no_progress'});assert.equal(f.store.list('model-call').length,baseline+1);
});

test('a pause remains resumable, while a repeated final checkpoint without new context is refused',async t=>{
  const paused=await fixture(t,20,100000,0.35,0,{},0,'small');await atFinal(paused,addressed(paused));
  const pausedBaseline=paused.store.list('model-call').length;
  adapter(paused,`research={action:'pause',reason:'Awaiting an operator-selected missing original'};`);
  assert.equal((await paused.invoke()).action,'pause');assert.equal((await paused.invoke()).action,'pause');
  assert.equal(paused.store.list('model-call').length,pausedBaseline+2);
  const repeated=await fixture(t,20,100000,0.35,0,{},0,'small');await atFinal(repeated,addressed(repeated),true);
  const repeatedBaseline=repeated.store.list('model-call').length;
  adapter(repeated,`research={action:'checkpoint',question:c.question.id,value:{finding:'The same proposed finding'},citations:[],unresolved:[]};`);
  await assert.rejects(repeated.invoke(),{code:'synthesis_no_progress'});
  assert.equal(repeated.store.list('model-call').length,repeatedBaseline+1);
});

test('a pending legacy summary that fits the actual packet continues without a format upgrade',async t=>{
  // Previous-era note shape (consolidated without a format) lives in a genuine
  // v1-id session, continued by its own legacy producer (№1555 X29/X30).
  const f=await fixture(t,20,100000,0.35,0,{},0,'small');
  const legacyId=`synthesis-session:${hashJson([reference(f.question),reference(f.environment),f.draft.value.inputs,[...f.context.workingSelections],null,null])}`;
  const proposal={action:'checkpoint' as const,question:f.question.id,value:{finding:'x'.repeat(22000)},citations:[],unresolved:['Preserve this uncertainty']};
  const saved=checkpoint(f.store,f.draft,f.question,{...proposal,value:proposal as unknown as import('../src/canonical.js').Json});
  const legacy={checkpoint:reference(saved),proposal,page:{offset:0,end:0},consolidated:{replaces:f.notes.map(n=>n.checkpoint)}};
  f.store.write({id:legacyId,kind:'synthesis-session',expected:0,value:{projectId:'p',offset:1,materialOffset:0,notes:[...f.notes,legacy],result:null}});
  assert.equal((await f.invoke()).action,'pause');
  const after=f.store.get<any>(legacyId)!;assert.deepEqual(after.value.notes.slice(0,4),[...f.notes,legacy]);
  const active=activeSynthesisNotes(after.value.notes);assert.equal(active.length,1);assert.equal(active[0]!.consolidated!.format,undefined);
  assert.equal(f.wires().filter(w=>w.subject.dispatchMode==='consolidation').length,0);
});

test('context recovery preserves final-stage lookup observations while allowing more distinct context',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{},0,'small'),originals=addressed(f,2);
  await atFinal(f,originals.slice(0,1));
  // A real blocked state: the paid lookup of a missing pointer is refused into
  // the session by the common transition itself.
  adapter(f,`research={action:'read_context',record:${JSON.stringify(originals[0]!.record)},pointer:'/body/items/absent',purpose:'Inspect a missing addressed original'};`);
  await assert.rejects(f.invoke(),{code:'research_no_progress'});
  const blocked=f.store.get<any>(f.before.id)!;
  assert.ok(blocked.value.workspace.blocked,'the produced session is blocked');
  const recovered=await f.engine.execute({type:'recover-context-session',project:'p',session:reference(blocked),selector:{record:originals[1]!.record,pointer:originals[1]!.pointer}}) as any;
  assert.equal(recovered.value.workspace.sinceProgress,0);assert.equal(recovered.value.finalization.lookups,1);
  assert.equal(synthesisControls(true,recovered.value.workspace,3,recovered.value.finalization).mode,'finalization');
});

test('the summary target is reduced to the space left after exact context, and all new context survives compaction',async t=>{
  const f=await fixture(t,12000,80000,0.35,0,{},0,'small');
  const drive=roomyDrive(f,200000);
  await atFinal(f,addressed(f,3,18000),false,drive.drive);
  const measured=drive.tighten();
  const preview=JSON.parse((await previewResearch(measured)).input);
  assert.equal(preview.subject.dispatchMode,'consolidation');
  assert.ok(preview.subject.consolidation.targetChars>0 && preview.subject.consolidation.targetChars<14000);
  const archive=f.store.get<any>(preview.subject.working.archive.id)!;
  assert.ok(archive.value.body.consolidation.fullTargetChars<30000);
  assert.equal((await measured()).action,'pause');
  const next=f.wires().at(-1);assert.equal(next.subject.contextWorkspace.length,3);
  assert.ok(next.subject.contextWorkspace.every((entry:any)=>entry.value.length===18000));
  assert.ok(JSON.stringify(next).length<=80000);
});

test('irreducible unresolved content exceeding packet capacity stops before a pointless tightening',async t=>{
  const f=await fixture(t,12000,80000,0.35,0,{},0,'small');
  const drive=roomyDrive(f,200000);
  await atFinal(f,addressed(f,3,18000),false,drive.drive);
  const measured=drive.tighten();
  const baseline=f.store.list('model-call').length;
  adapter(f,`if(c.dispatchMode!=='consolidation')throw Error('Oversized compaction must stop before ordinary generation');
research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'The conditions remain distinct'}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['Z'.repeat(30000)]};`);
  await assert.rejects(measured(),{code:'research_context_capacity'});
  const active=activeSynthesisNotes(f.store.get<any>(f.before.id)!.value.notes),note=active[0]!,packed=compactConclusions(active);
  assert.ok(JSON.stringify(packed.items).length<note.consolidated!.targetChars!);
  assert.ok(JSON.stringify(packed).length>note.consolidated!.fullTargetChars!);
  assert.equal(f.store.list('model-call').length,baseline+1);
  await assert.rejects(measured(),{code:'research_context_capacity'});assert.equal(f.store.list('model-call').length,baseline+1);
});

test('delivering the last page enters finalization even before its cursor is acknowledged',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{},0,'small');
  // Drive one real paid page at a time; stop as soon as the delivered page
  // completes the materials — the cursor stays unacknowledged by construction.
  adapter(f,`research={action:'checkpoint',question:c.question.id,value:{finding:'page'},citations:[],unresolved:[]};`);
  const {withInvocationAllowance}=await import('../src/discovery/invocation-progress.js');
  for(;;){
    const preview=JSON.parse((await previewResearch(f.invoke)).input);
    if(preview.subject.synthesisPage.complete)break;
    await withInvocationAllowance(1,f.invoke).catch((e:any)=>{if(e.code!=='research_call_allowance')throw e;});
  }
  const packet=JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(packet.subject.synthesisState.offset,3);assert.equal(packet.subject.synthesisPage.complete,true);
  assert.equal(packet.subject.contextControls.stage,'final');assert.equal(packet.subject.contextControls.mode,'finalization');
  assert.ok(packet.prompt.includes('read_context'));
});

test('a lookup from the just-delivered final page also requires purpose before it can consume another context slot',async t=>{
  const f=await fixture(t,20,100000,0.35,0,{},0,'small'),original=addressed(f,1)[0]!;
  await atFinal(f,[],false);
  const baseline=f.store.list('model-call').length;
  adapter(f,`research={action:'read_context',record:${JSON.stringify(original.record)},pointer:'/body/items/0'};`);
  await assert.rejects(f.invoke(),{code:'research_no_progress'});
  assert.equal(f.store.get<any>(f.before.id)!.value.blockedCode,'synthesis_context_purpose_missing');
  assert.equal(f.store.list('model-call').length,baseline+1);
  assert.equal(f.store.get<any>(f.before.id)!.value.offset,3);
});


test('one unsuccessful tightening is terminal and never loses original notes, citations or unresolved items',async t=>{
  const f=await fixture(t,5000,60000,0.35,0,{},35000,'small');
  adapter(f,`if(c.dispatchMode!=='consolidation')throw Error('No ordinary generation while the packet does not fit');
research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'X'.repeat(14000)}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]};`);
  await assert.rejects(f.invoke(),{code:'consolidation_capacity_exhausted'});
  const session=f.store.get<any>(f.before.id)!;
  assert.equal(f.store.list('model-call').length,f.setupCalls+2);assert.equal(session.value.notes.length,5);
  assert.deepEqual(session.value.notes.slice(0,3),f.notes);
  const active=activeSynthesisNotes(session.value.notes),note=active[0]!;
  assert.deepEqual(note.consolidated!.tightenedFrom,session.value.notes[3].checkpoint);
  assert.deepEqual((note.proposal as any).citations,(f.notes[0]!.proposal as any).citations);
  assert.deepEqual((note.proposal as any).unresolved,['Keep unresolved-0','Keep unresolved-1','Keep unresolved-2']);
  assert.equal(f.wires().filter(w=>w.subject.consolidation?.tightening).length,1);
  await assert.rejects(f.invoke(),{code:'consolidation_capacity_exhausted'});assert.equal(f.store.list('model-call').length,f.setupCalls+2);
});

test('a paid tightening recovers through the ordinary consumer once, preserving its terminal retry boundary',async t=>{
  const f=await fixture(t,5000,60000,0.35,0,{},35000,'small');
  adapter(f,`research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'X'.repeat(14000)}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]};`);
  const write=f.store.writeMany.bind(f.store);let interrupted=false;
  f.store.writeMany=((writes:any[],guards:any[]=[])=>{
    if(!interrupted&&writes.some(w=>w.kind==='synthesis-session'&&w.value.notes.length===5)){interrupted=true;throw Error('fixture tightening crash');}
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(),/fixture tightening crash/);f.store.writeMany=write;
  const call=f.store.list<any>('model-call').find(c=>JSON.parse(f.store.get<any>(c.value.request.record.id)!.value.text).subject.consolidation?.tightening)!;
  assert.ok(call);const session=f.store.get<any>(f.before.id)!;
  const receipt=await f.engine.execute({type:'recover-research-response',project:'p',call:reference(call),session:reference(session)}) as any;
  assert.equal(receipt.value.state,'applied');assert.equal(f.store.list('model-call').length,f.setupCalls+2);
  const active=activeSynthesisNotes(f.store.get<any>(f.before.id)!.value.notes);
  assert.deepEqual(active[0]!.consolidated!.tightenedFrom,session.value.notes.at(-1).checkpoint);
  await assert.rejects(f.invoke(),{code:'consolidation_capacity_exhausted'});assert.equal(f.store.list('model-call').length,f.setupCalls+2);
});

function rs5Fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-rs5-'));
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, 'p');
  const path = join(root, 'adapter.mjs'), wire = join(root, 'wire.ndjson');
  const command = { executable: process.execPath, args: [path] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 10000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: 100000, maxContinuationChars: 100000, maxReadChars: 60000, maxReplyChars: 20000,
    maxCalls: 30, maxReportedTokens: 100000,
    planning: { fields: [question.value.spec.field], maxRequestChars: 100000, maxRounds: 5 } }, 0);
  const source = engine.discovery.evidence.document('p', 'rs5', 'The output has one writer and rejects invalid input.', 'text/plain', 0);
  const context = (reading: unknown) => ({ ...pilotContext(store, draft, question), workingSelections: [{ kind: 'context', value: reading }] });
  const dispatch = pilotEnvironment(environment.value, pilot.value);
  const invoke = (reading: unknown, view = store, options?: Parameters<typeof synthesisSession>[9]) =>
    synthesisSession(view, draft, question, environment, dispatch, pilot, context(reading), 'Return the declared research action', undefined, options);
  const adapter = (code: string) => writeFileSync(path, `import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');let research;${code}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  adapter("research={action:'pause',reason:'RS5 local terminator'};");
  return { root, store, engine, draft, question, environment, pilot, source, dispatch, context, invoke, adapter,
    wires: () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}

for (const outcome of ['complete', 'clipped'] as const) test(`RS5-01 native reading-planner → read_source ${outcome} → synthesis survives restart`, async t => {
  const f = rs5Fixture(t), length = f.source.value.content.length;
  const requested = { start: 0, end: length + (outcome === 'clipped' ? 100 : 0) };
  f.adapter(`if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'read_source',source:${JSON.stringify(reference(f.source))},...${JSON.stringify(requested)}}]};
else research={action:'pause',reason:'RS5 material reached synthesis'};`);
  const run = await f.engine.researcher.run('p', f.draft.id, 5);
  assert.equal(run.value.status, 'paused');
  assert.equal(f.wires().filter(w => w.subject.dispatchMode === 'planning').length, 1);
  const synthesis = f.wires().filter(w => w.subject.dispatchMode === 'synthesis');
  assert.equal(synthesis.length, 1, JSON.stringify(run.value));
  const session = f.store.list<any>('synthesis-session')[0]!;
  const readings: any[] = [];
  const visit = (v: any) => { if (!v || typeof v !== 'object') return; if (v.contract === 'source-read/v2') readings.push(v); else Object.values(v).forEach(visit); };
  visit(session.value.basis.materials);
  assert.equal(readings.length, 1); assert.equal(readings[0].outcome, outcome);
  assert.deepEqual(readings[0].requested, requested); assert.deepEqual(readings[0].served, { start: 0, end: length });
  assert.equal(readings[0].value, f.source.value.content);
  assert.ok(f.store.list<any>('research-turn').some(turn => turn.value.action?.action === 'read_source' && turn.value.observation?.outcome === outcome));
  const second = new Store(join(f.root, 'state.sqlite')); t.after(() => second.close());
  assert.deepEqual(readSynthesisSession(second, reference(session)), session);
  const archive = f.store.get<any>(synthesis[0].subject.working.archive.id)!.value.body;
  const beforeCalls = f.store.list('model-call').map(reference);
  const result = await synthesisSession(second, f.draft, f.question, f.environment, f.dispatch, f.pilot, archive, 'Return the declared research action');
  assert.equal(result.action, 'pause');
  assert.equal(second.list('model-call').length, beforeCalls.length + 1);
  assert.deepEqual(beforeCalls, second.list('model-call').filter(c => beforeCalls.some(ref => ref.id === c.id)).map(reference));
});

for (const outcome of ['complete', 'clipped', 'outside'] as const) test(`RS5-02 ${outcome} material is verified before initial send and resumed send`, async t => {
  const f = rs5Fixture(t), length = f.source.value.content.length;
  const reading = f.engine.discovery.evidence.readSource('p', reference(f.source),
    { start: outcome === 'outside' ? length : 0, end: length + (outcome === 'complete' ? 0 : 100) });
  assert.equal((await f.invoke(reading)).action, 'pause');
  const session = f.store.list<any>('synthesis-session')[0]!;
  const second = new Store(join(f.root, 'state.sqlite')); t.after(() => second.close());
  assert.deepEqual(readSynthesisSession(second, reference(session)), session);
  second.write({ id: f.source.id, kind: 'source', expected: f.source.revision,
    value: { ...f.source.value, content: 'Changed source', sha256: digest('Changed source') } });
  const calls = second.list('model-call');
  await assert.rejects(f.invoke(reading, second), { code: 'synthesis_evidence_stale' });
  assert.deepEqual(second.list('model-call'), calls);
  assert.deepEqual(readSynthesisSession(second, reference(session)), session, 'historical result does not use current source heads');
});

for (const outcome of ['clipped', 'outside'] as const) test(`RS5-03 ${outcome}: a genuine reading of another project never becomes this project's synthesis material`, async t => {
  const f = rs5Fixture(t), evidence = f.engine.discovery.evidence;
  const source = evidence.document('other', 'rs5', f.source.value.content, 'text/plain', 0), length = source.value.content.length;
  const foreign = evidence.readSource('other', reference(source), outcome === 'clipped' ? { start: 0, end: 200 } : { start: length, end: length + 10 });
  assert.equal(foreign.outcome, outcome); assert.equal(evidence.verifyReading(foreign), true);
  await assert.rejects(f.invoke(foreign), { code: 'synthesis_evidence_stale' });
  assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('research-checkpoint').length, 0);
});

test('RS5-04 clipped reading does not permit an out-of-range checkpoint citation', async t => {
  const f = rs5Fixture(t), reading = f.engine.discovery.evidence.readSource('p', reference(f.source), { start: 0, end: 200 });
  f.adapter(`research={action:'checkpoint',question:c.question.id,value:{finding:'A supported condition'},citations:[{source:${JSON.stringify(reference(f.source))},selector:{kind:'text-range',start:0,end:200}}],unresolved:[]};`);
  await assert.rejects(f.invoke(reading), { code: 'selector_invalid' });
  assert.equal(f.store.list('research-checkpoint').length, 0);
  assert.equal(f.store.list('model-call').length, 1);
  await assert.rejects(f.invoke(reading), { code: 'selector_invalid' });
  assert.equal(f.store.list('model-call').length, 1, 'a paid invalid citation is not sent again');
});

for (const point of ['intent', 'application'] as const) test(`RS5-07 source replacement at ${point} transaction refuses without a partial checkpoint`, async t => {
  const f = rs5Fixture(t), second = new Store(join(f.root, 'state.sqlite')); t.after(() => second.close());
  const reading = f.engine.discovery.evidence.readSource('p', reference(f.source), { start: 0, end: 200 });
  f.adapter(`research={action:'checkpoint',question:c.question.id,value:{finding:'The output has one writer'},citations:[{source:${JSON.stringify(reference(f.source))},selector:${JSON.stringify(reading.selector)}}],unresolved:[]};`);
  const write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    const target = point === 'intent' ? writes.some(w => w.kind === 'research-consumer-intent' && w.value.state === 'prepared')
      : writes.some(w => w.kind === 'research-checkpoint');
    if (!changed && target) {
      assert.ok(guards.some(g => g.id === f.source.id && g.hash === f.source.hash), 'source guard predates the write');
      changed = true;
      second.write({ id: f.source.id, kind: 'source', expected: f.source.revision,
        value: { ...f.source.value, content: 'Changed in another Store', sha256: digest('Changed in another Store') } });
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(reading), { code: point === 'intent' ? 'synthesis_intent_claim_conflict' : 'synthesis_evidence_stale' });
  assert.equal(changed, true);
  assert.equal(f.store.list('research-checkpoint').length, 0);
  assert.equal(f.store.list('model-call').length, point === 'intent' ? 0 : 1);
});

test('RS5-08 a paid synthesis checkpoint over clipped reading recovers after restart without another call', async t => {
  const f = rs5Fixture(t), reading = f.engine.discovery.evidence.readSource('p', reference(f.source), { start: 0, end: 200 });
  f.adapter(`research={action:'checkpoint',question:c.question.id,value:{finding:'The output has one writer'},citations:[{source:${JSON.stringify(reference(f.source))},selector:${JSON.stringify(reading.selector)}}],unresolved:[]};`);
  const write = f.store.writeMany.bind(f.store); let interrupted = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!interrupted && writes.some(w => w.kind === 'research-checkpoint')) {
      interrupted = true; throw Error('RS5 interrupted before checkpoint application');
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(reading), /RS5 interrupted before checkpoint application/);
  f.store.writeMany = write;
  assert.equal(interrupted, true); assert.equal(f.store.list('research-checkpoint').length, 0);
  const session = f.store.list<any>('synthesis-session')[0]!, call = f.store.list<any>('model-call')[0]!;
  assert.equal(call.value.status, 'succeeded');
  const old = f.store.list().filter(r => ['model-call', 'model-request', 'model-response', 'research-context'].includes(r.kind));
  const second = new Store(join(f.root, 'state.sqlite')); t.after(() => second.close());
  const receipt = await new ProductEngine(second).execute({ type: 'recover-research-response', project: 'p', call: reference(call), session: reference(session) }) as any;
  assert.equal(receipt.value.state, 'applied'); assert.equal(second.list('model-call').length, 1);
  const note = second.list<any>('research-checkpoint')[0]!;
  assert.equal(note.value.observations.length, 1);
  assert.equal(note.value.observations[0].value, reading.value);
  assert.equal(Object.hasOwn(note.value.observations[0], 'contract'), false, 'checkpoint records a strict quote of served bytes');
  for (const record of old) assert.deepEqual(second.get(record.id, record.revision), record);
  assert.equal(readSynthesisSession(second, reference(second.get(session.id)!)).value.notes.length, 1);
});

for (const outcome of ['clipped', 'outside'] as const) test(`RS5-09 native read_bundle ${outcome} window reaches synthesis; its bare range is not a delivered read`, async t => {
  const f = rs5Fixture(t), length = f.source.value.content.length;
  const range = outcome === 'clipped' ? { start: 0, end: length + 100 } : { start: length, end: length + 10 };
  f.adapter(`if(c.role==='reader')research={selections:[{sourceIndex:0,firstLine:1,lastLine:1}],unresolved:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'read_bundle',purpose:'RS5 window',inputs:[{source:${JSON.stringify(reference(f.source))},range:${JSON.stringify(range)}}]}]};
else research={action:'pause',reason:'RS5 reader material reached synthesis'};`);
  const run = await f.engine.researcher.run('p', f.draft.id, 5);
  assert.equal(run.value.status, 'paused', JSON.stringify(run.value));
  const reader = f.store.list<any>('reader-result')[0]!;
  assert.equal(reader.value.coverage[0].reading.outcome, outcome);
  assert.equal(f.wires().filter(w => w.subject.dispatchMode === 'synthesis').length, 1, JSON.stringify(run.value));
  const session = f.store.list<any>('synthesis-session')[0]!;
  const windows: any[] = [];
  const visit = (v: any) => { if (!v || typeof v !== 'object') return; if (v.reading?.outcome) windows.push(v); Object.values(v).forEach(visit); };
  visit(session.value.basis.materials);
  assert.equal(windows.length, 1); assert.deepEqual(windows[0].reading, reader.value.coverage[0].reading);
});

for (const [label, payload] of [
  ['reading-like fields', { outcome: 'complete', requested: { format: 'json' } }],
  ['nested reading-like fields', { job: { outcome: 'outside', requested: 'garden' } }],
  ['an engine-shaped read as content', { contract: 'source-read/v1', projectId: 'p', source: { id: 'source:p:absent', revision: 1, hash: '0'.repeat(64) },
    selector: { kind: 'text-range', start: 0, end: 1 }, value: 'x', record: { id: 'reader-result:p:absent', revision: 1, hash: '0'.repeat(64) }, pointer: '/x' }],
] as [string, unknown][]) test(`RS5-11 a lawful JSON source with ${label} reaches synthesis; its content is not engine material`, async t => {
  const f = rs5Fixture(t), evidence = f.engine.discovery.evidence;
  const source = evidence.document('p', 'domain-json', JSON.stringify({ payload }), 'application/json', 0);
  const observation = evidence.observe('p', reference(source), { kind: 'json-pointer', pointer: '/payload' });
  assert.equal(evidence.verifyReading(observation), true);
  assert.equal((await f.invoke(observation)).action, 'pause');
  assert.equal(f.store.list('model-call').length, 1);
  const second = new Store(join(f.root, 'state.sqlite')); t.after(() => second.close());
  assert.equal((await f.invoke(observation, second)).action, 'pause', 'a new Store admits the same material');
});

test('RS5-11 a changed JSON source is refused before the send', async t => {
  const f = rs5Fixture(t), evidence = f.engine.discovery.evidence;
  const source = evidence.document('p', 'domain-json', JSON.stringify({ payload: { outcome: 'complete' } }), 'application/json', 0);
  const observation = evidence.observe('p', reference(source), { kind: 'json-pointer', pointer: '/payload' });
  evidence.document('p', 'domain-json', JSON.stringify({ payload: { outcome: 'changed' } }), 'application/json', source.revision);
  await assert.rejects(f.invoke(observation), { code: 'synthesis_evidence_stale' });
  assert.equal(f.store.list('model-call').length, 0);
});

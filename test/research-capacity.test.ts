import { researchCapacityInput, resultCapacityFrom, requireResultCapacity, researchResultFailure, researchResultEnvelopeLimit } from '../src/discovery/early-research-outcome.js';
import { consumerCapacityFailure, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { measureResearchResult } from '../src/discovery/research-delivery.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Revision } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import type { EarlyStageOutcome } from '../src/product/early-stage-driver.js';
import { stopPass, resumeStoppedPass } from '../src/om/run-driver.js';
import { parseCommand } from '../src/product/commands.js';
import { REQUIREMENTS, UPSTREAM_STAGES } from '../src/discovery/requirements.js';
import { preparedField } from './preparation-fixture.js';
import { designOf } from '../src/graph/builder.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';

// An oversize child writes its bytes and then stays alive: only the executor's stop at the physical limit may end it, so a natural exit can never
// race that stop. The never-firing timer holds the event loop and costs nothing; the Environment timeout still bounds a stop that never comes.
const holdUntilStopped = 'setInterval(()=>{},2147483647)';
const adapter = String.raw`import {readFileSync,appendFileSync} from 'node:fs';
import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js',import.meta.url).href)};
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject,settings=JSON.parse(readFileSync(process.argv[2],'utf8'));
appendFileSync(process.argv[3],JSON.stringify({role:c.role,request:r.requestId})+'\n');
if(c.role===settings.oversize){process.stdout.write('x'.repeat(4100000));${holdUntilStopped};}
else {let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.role==='assess-escalation')research={necessary:true,reason:'The owner must choose'};
else {const q=c.questions[0], inventory=c.inventory??{sources:c.originals.sources};
let sources=inventory.sources;if(!Array.isArray(sources))sources=sources.rows.map(row=>Object.fromEntries(sources.columns.map((key,i)=>[key,row[i]])));
const source=sources.find(s=>s.location==='values');
if(settings.owner){const read=[...(c.history??[]),c.currentRead].some(t=>t?.action?.action==='read_source');
research=read?{action:'need_owner',question:q.id,reason:'Owner constraint is missing',searched:[source.ref]}:{action:'read_source',source:source.ref,start:0,end:source.length};}
else research={action:'answer',question:q.id,value:boundDiscoveryValue(q.field,settings.fields[q.field],c.discoveryContext),citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};}
if(c.role===settings.largeRole){const large='x'.repeat(settings.chars??400000);
if(c.role==='assess-answer')research=settings.form==='assessment_checkpoint'?{action:'assessment_checkpoint',notes:[large]}:{verdict:settings.verdict??'supported',reasons:[large]};
else if(c.role==='assess-escalation')research={necessary:true,reason:large};
else if(settings.form==='checkpoint')research={action:'checkpoint',question:research.question,value:{finding:large},citations:research.citations,unresolved:[]};
else if(settings.form==='need_owner')research={action:'need_owner',question:research.question,reason:large,searched:[research.citations[0].source]};
else if(settings.form==='citations')research={...research,citations:Array.from({length:5000},()=>research.citations[0])};
else research={...research,value:large};}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research}));if(settings.exitCode)process.exitCode=settings.exitCode;}`;

function fixture(t: { after(fn: () => void): void }, oversize: string, owner = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-result-capacity-')), database = join(root, 'state.sqlite'), workspace = join(root, 'repo');
  mkdirSync(workspace);
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']])
    execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  const settings = join(root, 'settings.json'), trace = join(root, 'calls.jsonl'), script = join(root, 'adapter.mjs');
  const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
    spec.field === 'mapDesign' ? designOf(enrichedGraph(exampleGraph('p'), 'p')) : preparedField('p', spec.field)])));
  writeFileSync(settings, JSON.stringify({ oversize, fields, owner })); writeFileSync(script, adapter);
  const store = new Store(database), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Capacity' });
  engine.discovery.evidence.document('p', 'values', JSON.stringify(fields), 'application/json', 0);
  const command = { executable: process.execPath, args: [script, settings, trace] };
  engine.environments.configure('p', { workspace, requestCapacityChars: 300_000, timeoutMs: 10_000,
    implementer: { actor: 'author', model: 'script', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'script', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] } }, 0);
  const calls = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const normal = () => writeFileSync(settings, JSON.stringify({ oversize: null, fields, owner }));
  const run = (db = store, maxCalls = 100) => new ProductEngine(db).execute({ type: 'early-stage-run', project: 'p', maxCalls, maxTurns: 100,
    instruction: { title: 'Capacity', id: 'instruction', text: 'Build the described product.', media: 'text/plain',
      brief: { kind: 'text-range', start: 0, end: 28 } } }) as Promise<EarlyStageOutcome>;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, engine, database, calls, normal, run, control: (value: Record<string, unknown>) => writeFileSync(settings, JSON.stringify({ oversize, fields, owner, ...value })) };
}

/** The saved model call that ended on the physical output limit. Any other outcome of the first run is a failure that names
 * what was saved, so a slow or failing machine reports its own cause instead of an undefined call. */
function outputLimitCall(f: ReturnType<typeof fixture>, stopped: unknown): Revision<ModelCall> {
  const calls = f.store.list<ModelCall>('model-call');
  const call = calls.find(row => row.value.error === 'process_output_limit');
  assert.ok(call, `no saved model call ended on process_output_limit; run: ${JSON.stringify(stopped)}; saved calls: ${
    JSON.stringify(calls.map(row => ({ id: row.id, status: row.value.status, error: row.value.error })))}`);
  return call;
}

for (const role of ['research', 'assess-answer', 'assess-escalation']) {
  test(`RD2a physical output-limit: ${role} needs the exact one-use permit; restart pays at most one bounded attempt`, async t => {
    const f = fixture(t, role, role === 'assess-escalation');
    const stopped = await f.run();
    const call = outputLimitCall(f, stopped);
    assert.equal(call.value.response, null);
    const request = f.store.get<{text:string}>(call.value.request.record!.id, call.value.request.record!.revision)!;
    assert.equal(JSON.parse(request.value.text).subject.responseOutputLimit.combinedStdoutStderrBytes, 4_000_000);
    const initial = f.calls().length;
    const retry = await f.run();
    assert.equal(retry.budget.callsMade, 0); assert.equal(f.calls().length, initial);
    const door = { type: 'permit-limited-call-retry', project: 'p', call: reference(call) } as const;
    assert.deepEqual(parseCommand(door), door);
    assert.throws(() => f.engine.execute({ ...door, call: reference(f.store.get(call.id, 1)!) }), { code: 'limited_call_retry_stale' });
    const permit = f.engine.execute(door) as Revision<any>;
    assert.deepEqual(f.engine.execute(door), permit); assert.equal(f.calls().length, initial);
    f.normal();
    const cold = new Store(f.database); t.after(() => cold.close());
    const resumed = await f.run(cold, 1);
    assert.equal(resumed.budget.callsMade, 1, JSON.stringify(resumed)); assert.equal(f.calls().length, initial + 1);
    assert.equal(f.calls().at(-1).role, role, 'Only the original role corrects its physical failure');
    const next = cold.list<ModelCall>('model-call').find(row => row.id !== call.id && row.value.startedAt >= call.value.startedAt && row.value.requested.actor === call.value.requested.actor)!;
    assert.equal(next.value.questionId, call.value.questionId); assert.deepEqual(next.value.requested, call.value.requested);
    assert.throws(() => new ProductEngine(cold).execute(door), { code: 'limited_call_retry_stale' });
    assert.deepEqual(f.store.get(call.id, call.revision), call, 'The earlier raw outcome and possible cost stay immutable');
  });
}

test('RD2a limited retry rejects usable responses, a foreign project and the cancellation door', async t => {
  const f = fixture(t, 'research');
  const stopped = await f.run();
  const call = outputLimitCall(f, stopped);
  f.engine.execute({ type: 'create-project', project: 'other', title: 'Other' });
  assert.throws(() => f.engine.execute({ type: 'permit-limited-call-retry', project: 'other', call: reference(call) }), { code: 'limited_call_retry_stale' });
  assert.throws(() => f.engine.execute({ type: 'permit-cancelled-call-retry', project: 'p', call: reference(call) }), { code: 'call_retry_permit_invalid' });
  assert.throws(() => parseCommand({ type: 'permit-limited-call-retry', project: 'p' }));
  f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) }); f.normal();
  await f.run(f.store, 1);
  const usable = f.store.list<ModelCall>('model-call').find(row => row.value.status === 'succeeded')!;
  assert.ok(usable.value.response);
  assert.throws(() => f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(usable) }), { code: 'limited_call_retry_invalid' });
});

test('RD2a limited retry window: two Stores issuing the same permission return the same unspent record', async t => {
  const f = fixture(t, 'research'); const stopped = await f.run();
  const call = outputLimitCall(f, stopped);
  const door = { type: 'permit-limited-call-retry', project: 'p', call: reference(call) } as const;
  const second = new Store(f.database); t.after(() => second.close());
  const write = f.store.writeMany.bind(f.store); let concurrent: unknown;
  f.store.writeMany = ((writes, guards) => {
    if (!concurrent && writes.some(row => row.kind === 'limited-call-retry-permit'))
      concurrent = new ProductEngine(second).execute(door);
    return write(writes, guards);
  }) as Store['writeMany'];
  const result = f.engine.execute(door);
  assert.deepEqual(result, concurrent); assert.equal(f.store.list('limited-call-retry-permit').length, 1);
  assert.equal(f.calls().length, 1, 'Issuing a permit never sends the provider');
});

test('RD2a limited retry window: a legitimate Source change before write refuses the permission without a new call', async t => {
  const f = fixture(t, 'research'); const stopped = await f.run();
  const call = outputLimitCall(f, stopped);
  const second = new Store(f.database); t.after(() => second.close());
  const write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes, guards) => {
    if (!changed && writes.some(row => row.kind === 'limited-call-retry-permit')) {
      changed = true;
      const source = second.list<any>('source').find(row => row.value.origin.location === 'values')!;
      new ProductEngine(second).discovery.evidence.document('p', 'values', '{"changed":true}', 'application/json', source.revision);
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  assert.throws(() => f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) }), { code: 'input_stale' });
  assert.equal(f.store.list('limited-call-retry-permit').length, 0); assert.equal(f.calls().length, 1);
});


test('RD2a a physical retry permit preserves stop and its exact question across a cold restart', async t => {
  const f = fixture(t, 'research'); const first = await f.run();
  const call = outputLimitCall(f, first);
  f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) });
  const stopped = stopPass(f.store, { project: 'p' }); assert.ok(stopped.ok);
  const token = stopped.value.control!.value.stop!.token;
  const cold = new Store(f.database); t.after(() => cold.close()); f.normal();
  const held = await f.run(cold, 1);
  assert.equal(held.end, 'stopped'); assert.equal(held.budget.callsMade, 0); assert.equal(f.calls().length, 1);
  assert.equal(resumeStoppedPass(cold, { project: 'p', stop: token }).ok, true);
  const resumed = await f.run(cold, 1);
  assert.equal(resumed.budget.callsMade, 1); assert.equal(f.calls().length, 2);
  assert.equal(cold.list<ModelCall>('model-call').find(row => row.id !== call.id)!.value.questionId, call.value.questionId);
});


test('RD2a a complete paid response from a failed adapter is never output-limit retry authority', async t => {
  const f = fixture(t, 'unused'); f.control({ exitCode: 7 });
  await f.run(f.store, 1);
  const call = f.store.list<ModelCall>('model-call')[0]!;
  assert.ok(call.value.response, 'The real adapter emitted a complete envelope'); assert.equal(call.value.status, 'failed');
  assert.throws(() => f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) }), { code: 'limited_call_retry_invalid' });
  assert.equal(f.calls().length, 1); assert.equal(f.store.list('limited-call-retry-permit').length, 0);
});


test('RD2a a second physical output-limit cannot consume the first call permission again', async t => {
  const f = fixture(t, 'research'); await f.run();
  const call = f.store.list<ModelCall>('model-call')[0]!;
  f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) });
  const next = await f.run(f.store, 1); assert.equal(next.budget.callsMade, 1);
  assert.equal(f.calls().length, 2);
  const cold = new Store(f.database); t.after(() => cold.close());
  const held = await f.run(cold, 1); assert.equal(held.budget.callsMade, 0); assert.equal(f.calls().length, 2);
  assert.throws(() => new ProductEngine(cold).execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) }), { code: 'limited_call_retry_stale' });
});

test('RD2a a permitted physical attempt resumed by two Stores sends exactly once', async t => {
  const f = fixture(t, 'research'); await f.run();
  const call = f.store.list<ModelCall>('model-call')[0]!;
  f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) }); f.normal();
  const one = new Store(f.database), two = new Store(f.database); t.after(() => { one.close(); two.close(); });
  const outcomes = await Promise.all([f.run(one, 1), f.run(two, 1)]);
  assert.ok(outcomes.some(outcome => outcome.budget.callsMade === 1)); assert.equal(f.calls().length, 2);
  assert.equal(f.store.list('limited-call-retry-permit').length, 1);
});

test('RD2a announcing physical output units does not mutate a caller-owned context', async t => {
  const f = fixture(t, 'unused');
  const { researchCall } = await import('../src/discovery/research-protocol.js');
  const environment = f.engine.environments.get('p').value;
  const context = Object.freeze({ role: 'assess-answer' });
  assert.deepEqual(await researchCall(environment.reviewer, environment, 'Assess the candidate', context), { verdict: 'supported', reasons: [] });
  assert.deepEqual(context, { role: 'assess-answer' });
});


for (const [role, form, verdict] of [['research', 'answer'], ['research', 'checkpoint'], ['research', 'citations'],
  ['research', 'need_owner'], ...['supported','insufficient','conflicting'].map(verdict=>['assess-answer','verdict',verdict]),
  ['assess-answer', 'assessment_checkpoint'], ['assess-escalation','escalation']]) {
  test(`RD2a declared result admission rejects ${role}/${form}${verdict?'/'+verdict:''} before application; cold correction uses only its role`, async t => {
    const f = fixture(t, 'none', role === 'assess-escalation'); f.control({ largeRole: role, form, verdict });
    const stopped = await f.run();
    const calls = f.store.list<ModelCall>('model-call');
    const paid = calls.find(row => row.value.purpose === (role === 'research' ? 'analyst' : role === 'assess-answer' ? 'assessor' : 'escalation-assessor') && row.value.status === 'succeeded')!;
    assert.ok(paid, JSON.stringify(stopped)); assert.ok(paid.value.response);
    assert.equal(f.store.get<any>(paid.value.questionId!)!.value.status, 'open', JSON.stringify(stopped));
    assert.equal(f.store.list('research-checkpoint').length, 0);
    const application = role !== 'assess-answer' ? f.store.list<any>('research-consumer-intent').find(row => row.value.refusal?.code === 'research_result_capacity')
      : f.store.list<any>('assessment-application').find(row => row.value.state === 'model-refused');
    assert.ok(application, JSON.stringify(stopped));
    const capacity = role !== 'assess-answer' ? application.value.cursor.resultCapacity : application.value.context.resultCapacity;
    const refusal = application.value.refusal?.capacity ?? application.value.resultCapacityRefusal;
    assert.equal(capacity.contract, 'result-capacity/v1'); assert.ok(refusal.actual > refusal.limit); assert.ok(refusal.deficit > 0);
    const request = f.store.get<any>(paid.value.request.record!.id, paid.value.request.record!.revision)!;
    assert.deepEqual(JSON.parse(request.value.text).subject.resultCapacity, capacity, 'The producer and actual wire declare identical limits');
    const response = f.store.get<any>(paid.value.response!.record!.id, paid.value.response!.record!.revision)!;
    assert.ok(response.value.text.length > 300000, 'The whole paid response survives without truncation');
    const initial = f.calls().length;
    f.normal(); const cold = new Store(f.database); t.after(() => cold.close());
    const corrected = await f.run(cold, 1);
    assert.equal(corrected.budget.callsMade, 1, JSON.stringify(corrected)); assert.equal(f.calls().length, initial + 1);
    assert.equal(f.calls().at(-1).role, role, 'A refusal of B never purchases A again');
    assert.deepEqual(cold.get(paid.id, paid.revision), paid);
  });
}

test('RD2a admission counts aggregate fields and escaped UTF-16 JSON, not field lengths or bytes', () => {
  const result = { action: 'answer', question: 'q', value: '"\\😀'.repeat(100), citations: [{ source: {id:'s',revision:1,hash:'0'.repeat(64)}, selector:{kind:'text-range',start:0,end:1} }] };
  const base = { operation:'op',generation:0,bindings:{question:'q'},role:'analyst' as const,purpose:'analyst',actionMode:'analyst',envelopeLimitChars:3000,
    mandatoryEnvelope:{protocol:'omg-agent/v1',prompt:'P',subject:{question:{id:'q',schema:{type:'string'}}}},forms:[{kind:'answer'}] };
  const capacity = resultCapacityFrom(base), measured = measureResearchResult(capacity,'answer',result);
  assert.equal(measured.requiredChars, capacity.forms[0]!.minimumChars + JSON.stringify(result).length);
  assert.ok(JSON.stringify(result).length > result.value.length); assert.ok(Buffer.byteLength(JSON.stringify(result)) > JSON.stringify(result).length);
  const allowance = capacity.forms[0]!.maxResultChars;
  const aggregate = { action:'answer',question:'q',value:'x'.repeat(Math.ceil(allowance/2)),citations:[],unresolved:['y'.repeat(Math.ceil(allowance/2))] };
  const failure = researchResultFailure(capacity,aggregate)!;
  assert.equal(failure.code,'research_result_capacity'); assert.ok((failure.details as any).deficit > 0);
  assert.throws(()=>requireResultCapacity({...capacity,forms:[]},base),{code:'research_capacity_invalid'});
  assert.throws(()=>requireResultCapacity(undefined,base),{code:'research_capacity_invalid'});
  assert.equal(researchResultFailure(undefined,aggregate),null,'Markerless paid history keeps its prior era');
  assert.throws(()=>researchResultFailure({...capacity,forms:undefined},aggregate),{code:'research_capacity_invalid'});
});

test('RD2a minimum excludes accumulated histories and candidate bodies while retaining the whole question and grounds', async t => {
  const f = fixture(t,'none'); await f.run(f.store,1);
  const intent = f.store.list<ResearchConsumerIntent>('research-consumer-intent')[0]!;
  const draft = f.store.get<any>(intent.value.draft.id,intent.value.draft.revision)!, question = f.store.get<any>(intent.value.question.id,intent.value.question.revision)!;
  const archive=intent.value.cursor.resultCapacity.mandatory.archive;
  assert.ok(archive);assert.equal(Object.hasOwn(intent.value.cursor.resultCapacity.mandatory,'projection'),false);
  const original=f.store.get<any>(archive.record.id,archive.record.revision)!;
  assert.deepEqual(original.value.body.subject.question,{id:question.id,...question.value.spec});
  const wrong={...intent,value:{...intent.value,cursor:{...intent.value.cursor,resultCapacity:{...intent.value.cursor.resultCapacity,
    mandatory:{archive:{...archive,pointer:'/body/other'}}}}}};
  // G5a: the consumer trusts the saved declaration — it only measures the new
  // payload against it. A forged mandatory body is byte damage owned by
  // om-fsck, never a recomputation at the read/check path.
  assert.equal(consumerCapacityFailure(f.store,wrong,{}),null);
  const input = {operation:'same',generation:0,bindings:{draft:reference(draft),question:reference(question)},role:'analyst' as const,purpose:'analyst',actionMode:'analyst',limit:300000,
    prompt:'Keep exact grounds',binding:intent.value.role,draft:draft.value,question:{id:question.id,value:question.value},context:{history:[],previousProposal:null}};
  const small=resultCapacityFrom(researchCapacityInput(input));
  const huge=resultCapacityFrom(researchCapacityInput({...input,context:{history:[{reasons:['h'.repeat(400000)]}],previousProposal:'v'.repeat(400000),observations:['o'.repeat(400000)]}}));
  const synthesis={contextControls:{version:2,mode:'material'},synthesisState:{offset:0,materialOffset:0},synthesisSession:'session',synthesisMaterials:[],synthesisNotes:[]};
  for(const missing of Object.keys(synthesis)){
    const context:Record<string,unknown>={...synthesis};delete context[missing];
    assert.throws(()=>researchCapacityInput({...input,purpose:'synthesis',context}),{code:'research_capacity_invalid'});
  }
  assert.deepEqual(huge,small);
  assert.ok('projection' in small.mandatory);
  assert.deepEqual((small.mandatory.projection.subject as any).question,{id:question.id,...question.value.spec});
  for(const goal of [undefined,{targetChars:1},{targetChars:0,fullTargetChars:2}])
    assert.throws(()=>researchCapacityInput({...input,purpose:'consolidation',actionMode:'consolidation',
      context:{...synthesis,consolidation:goal}}),{code:'research_capacity_invalid'});
  const b={...input,role:'assessor' as const,purpose:'assessor',actionMode:'assess-answer'};
  assert.deepEqual(resultCapacityFrom(researchCapacityInput({...b,context:{value:'short',observations:[]}})),
    resultCapacityFrom(researchCapacityInput({...b,context:{value:'v'.repeat(400000),observations:['e'.repeat(400000)]}})));
  assert.throws(()=>consumerCapacityFailure(f.store,{...intent,value:{...intent.value,cursor:{...intent.value.cursor,resultCapacity:undefined}}},{}),{code:'research_capacity_invalid'});
});

async function synthesisCapacityFixture(t: import('node:test').TestContext, summary: boolean, requestLimit = 300000) {
  const { preparedFeatures } = await import('./product-fixture.js');
  const { configureReaderPilot, pilotEnvironment } = await import('../src/discovery/reader-pilot.js');
  const { pilotContext } = await import('../src/discovery/pilot-context.js');
  const { synthesisSession } = await import('../src/discovery/synthesis-session.js');
  const root = mkdtempSync(join(tmpdir(), 'omg-capacity-c-')), database = join(root, 'state.sqlite'), store = new Store(database), engine = new ProductEngine(store, 'fixture');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); preparedFeatures(engine, 'p');
  const settings=join(root,'settings'), script=join(root,'adapter.mjs'); writeFileSync(settings,JSON.stringify({large:false}));
  const source=engine.discovery.evidence.document('p','material','A precise condition with an exception.','text/plain',0);
  const citation={source:reference(source),selector:{kind:'text-range' as const,start:0,end:source.value.content.length}};
  writeFileSync(script,`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject,large=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')).large,citation=${JSON.stringify(citation)};
  const research=c.dispatchMode==='consolidation'?{action:'checkpoint',question:c.question.id,value:{summaries:c.consolidation.notes.map((n,i)=>({notes:[i],text:large?'x'.repeat(400000):'Preserve every exact source and exception'})),citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]}
    :{action:'checkpoint',question:c.question.id,value:{finding:'x'.repeat(large?400000:${summary?180000:20})},citations:[citation],unresolved:['Keep the documented exception open']};
  console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command={executable:process.execPath,args:[script]};
  const environment=engine.environments.configure('p',{workspace:root,requestCapacityChars:requestLimit,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:10000},0);
  const pilot=configureReaderPilot(store,engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,maxRequestChars:requestLimit,maxContinuationChars:requestLimit,maxReplyChars:2000000,maxCalls:40,maxReportedTokens:1000000,conclusionShare:summary?0.001:0.95,maxReadChars:60000},0);
  const r0=engine.refinement.begin('p','R0');engine.refinement.finishResearch('p','R0',reference(r0),0);engine.refinement.sealLayer('p',1,0);
  const draft=engine.refinement.begin('p','R1'),question=store.get<any>(draft.value.questions[0]!)!;
  const context={...pilotContext(store,draft,question),...(summary?{request:{immutableCondition:'r'.repeat(110000)}}:{}),workingSelections:[{kind:'context',value:engine.discovery.evidence.observe('p',reference(source),citation.selector)}]};
  const dispatch=pilotEnvironment(environment.value,pilot.value);
  return {store,database,draft,question,large:(large:boolean)=>writeFileSync(settings,JSON.stringify({large})),
    invoke:(db=store)=>synthesisSession(db,draft,question,environment,dispatch,pilot,context,'Return a cited checkpoint or the declared summary')};
}

for (const summary of [false,true]) test(`RD2a C ${summary?'summary':'checkpoint'} rejects a whole oversized result before session/checkpoint mutation and corrects the same cursor`,async t=>{
  const {withInvocationAllowance}=await import('../src/discovery/invocation-progress.js');
  const f=await synthesisCapacityFixture(t,summary);
  if(summary) await assert.rejects(withInvocationAllowance(1,f.invoke),{code:'research_call_allowance'});
  const before=f.store.list<any>('synthesis-session')[0]??null;
  const notes=f.store.list('research-checkpoint').length,calls=f.store.list('model-call').length;
  f.large(true);
  await assert.rejects(withInvocationAllowance(1,f.invoke),{code:'research_result_capacity'});
  const rejected=f.store.list<any>('research-consumer-intent').find(row=>row.value.refusal?.code==='research_result_capacity')!;
  assert.ok(rejected);assert.equal(rejected.value.kind,summary?'consolidation':'synthesis');
  const capacity=rejected.value.cursor.resultCapacity;
  if(summary){assert.equal(capacity.forms[0].kind,'summary');assert.ok(capacity.forms[0].specialLimits.targetChars>0);assert.ok(capacity.forms[0].specialLimits.fullTargetChars>0);}
  const session=f.store.get<any>(rejected.value.owner.id)!;
  if(before)assert.deepEqual(session,before);
  else{assert.equal(session.value.offset,0);assert.equal(session.value.notes.length,0);}
  assert.equal(f.store.list('research-checkpoint').length,notes);assert.equal(f.store.list('model-call').length,calls+1);
  const paid=f.store.get<ModelCall>(rejected.value.call.id)!;assert.equal(paid.value.status,'succeeded');assert.ok(paid.value.response!.chars>300000);
  const original=f.store.get(paid.id,paid.revision);f.large(false);
  const cold=new Store(f.database);t.after(()=>cold.close());
  await assert.rejects(withInvocationAllowance(1,()=>f.invoke(cold)),{code:'research_call_allowance'});
  assert.equal(cold.list('model-call').length,calls+2);assert.equal(cold.list('research-checkpoint').length,notes+1);
  assert.deepEqual(cold.get(paid.id,paid.revision),original);
});

test('RD2a a mandatory minimum that cannot fit fails before the first model payment', async t => {
  const f = fixture(t,'none'), environment = f.engine.environments.get('p');
  const {projectId: _projectId, ...settings} = environment.value;
  f.engine.environments.configure('p',{...settings,requestCapacityChars:1},environment.revision);
  const outcome = await f.run(f.store,1);
  assert.equal(outcome.budget.callsMade,0,JSON.stringify(outcome));
  assert.equal(outcome.reason?.code,'research_capacity_configuration',JSON.stringify(outcome));
  assert.equal(f.store.list('model-call').length,0); assert.equal(f.calls().length,0);
});

for (const role of ['research','assess-answer']) test(`RD2a ${role} capacity refusal guards a Source changed by a second Store before its write`,async t=>{
  const f=fixture(t,'none');f.control({largeRole:role,form:role==='research'?'answer':'verdict'});
  const second=new Store(f.database);t.after(()=>second.close());
  const write=f.store.writeMany.bind(f.store);let changed=false;
  f.store.writeMany=((writes,guards)=>{
    if(!changed&&writes.some(row=>(row.kind==='research-consumer-intent'&&(row.value as any).refusal?.code==='research_result_capacity')
      ||row.kind==='assessment-application'&&(row.value as any).resultCapacityRefusal)){
      changed=true;const source=second.list<any>('source').find(row=>row.value.origin.location==='values')!;
      new ProductEngine(second).discovery.evidence.document('p','values','{"changed":true}','application/json',source.revision);
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  const outcome=await f.run();assert.ok(changed);
  assert.notEqual(outcome.reason?.code,'research_result_capacity',JSON.stringify(outcome));
  assert.equal(f.store.list<any>('research-consumer-intent').filter(row=>row.value.refusal?.code==='research_result_capacity').length,0);
  assert.equal(f.store.list<any>('assessment-application').filter(row=>row.value.resultCapacityRefusal).length,0);
  const paid=f.store.list<ModelCall>('model-call').find(row=>row.value.purpose===(role==='research'?'analyst':'assessor'))!;
  assert.ok(paid.value.response);assert.equal(paid.value.status,'succeeded');
  assert.equal(f.calls().length,role==='research'?1:2);
});

test('RD2a a configuration change after payment cannot change the saved result classification',async t=>{
  const f=fixture(t,'none');f.control({largeRole:'research',form:'answer'});await f.run();
  const intent=f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row=>row.value.refusal?.code==='research_result_capacity')!;
  const call=f.store.get<ModelCall>(intent.value.call!.id)!;
  const response=call.value.response!.record!, raw=f.store.get<any>(response.id,response.revision)!;
  const payload=JSON.parse(raw.value.text).research;
  const expected=consumerCapacityFailure(f.store,intent,payload)!.details;
  const environment=f.engine.environments.get('p'),{projectId:_projectId,...settings}=environment.value;
  f.engine.environments.configure('p',{...settings,requestCapacityChars:900000},environment.revision);
  const cold=new Store(f.database);t.after(()=>cold.close());
  assert.deepEqual(consumerCapacityFailure(cold,intent,payload)!.details,expected);
  assert.equal(f.calls().length,1);assert.deepEqual(cold.get(call.id,call.revision),call);
});

test('RD2a two concurrent cold corrections do not repurchase the same oversized response',async t=>{
  const f=fixture(t,'none');f.control({largeRole:'research',form:'answer'});await f.run();f.normal();
  const one=new Store(f.database),two=new Store(f.database);t.after(()=>{one.close();two.close();});
  const outcomes=await Promise.all([f.run(one,1),f.run(two,1)]);
  assert.ok(outcomes.some(row=>row.budget.callsMade===1));assert.equal(f.calls().length,2);
  assert.equal(f.store.list<ModelCall>('model-call').filter(row=>row.value.purpose==='analyst').length,2);
});

test('RD2a capacity projection keeps actual bindings as references and literal schema data as data',async()=>{
  const {referenceSites}=await import('../src/storage/reference-sites.js');
  const exact={id:'source:bound',revision:1,hash:'1'.repeat(64)},literal={id:'literal',revision:1,hash:'2'.repeat(64)};
  const value={contract:'research-consumer-intent/v1',cursor:{resultCapacity:{bindings:{source:exact},mandatory:{projection:{subject:{
    question:{schema:{const:literal}},discoveryContext:{fields:{literal:{value:literal}}},previousProposalRef:exact}}}}}};
  const sites=referenceSites('research-consumer-intent',value);
  assert.ok(sites.some(site=>site.ref.id===exact.id));assert.ok(sites.every(site=>site.ref.id!==literal.id));
  const archived=referenceSites('research-context',{contract:'result-capacity-projection/v1',draft:exact,question:exact,
    body:{subject:{inputs:[exact],question:{schema:{const:literal}},discoveryContext:{fields:{literal:{value:literal}}}}}});
  assert.ok(archived.some(site=>site.field==='body.subject.inputs[0]'));assert.ok(archived.every(site=>site.ref.id!==literal.id));
});

test('RD2a an enabled reader rejects oversized unresolved before result publication and resumes only that extraction',async t=>{
  const {configureReaderPilot}=await import('../src/discovery/reader-pilot.js');
  const {readBundle}=await import('../src/discovery/reader.js');
  const root=mkdtempSync(join(tmpdir(),'omg-capacity-reader-')),database=join(root,'state.sqlite'),store=new Store(database),engine=new ProductEngine(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});engine.execute({type:'create-project',project:'p',title:'Reader capacity'});
  const settings=join(root,'settings'),script=join(root,'reader.mjs');writeFileSync(settings,'true');writeFileSync(join(root,'source.txt'),'Condition\nException\n');
  writeFileSync(script,`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),large=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
  const selections=r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]}));
  console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections,unresolved:large?['x'.repeat(400000)]:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command={executable:process.execPath,args:[script]};
  const environment=engine.environments.configure('p',{workspace:root,requestCapacityChars:100000,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'assessor',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:10000},0);
  const pilot=configureReaderPilot(store,engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,maxRequestChars:100000,maxReadChars:60000,maxReplyChars:1000000,maxCalls:10,maxReportedTokens:1000},0);
  const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'result',kind:'design',prompt:'Preserve the condition and exception',risk:'Lost condition',schema:{type:'object'}}]);
  const question=store.get<any>(draft.value.questions[0]!)!;
  const invoke=(db=store)=>readBundle(db,environment.value,pilot,reference(question),'Extract the exact condition',[{path:'source.txt',media:'text/plain'}]);
  await assert.rejects(invoke(),{code:'research_result_capacity'});
  assert.equal(store.list('reader-result').length,0);const paid=store.list<ModelCall>('model-call')[0]!;assert.equal(paid.value.status,'succeeded');assert.ok(paid.value.response);
  writeFileSync(settings,'false');const cold=new Store(database);t.after(()=>cold.close());
  const result=await invoke(cold);assert.equal(result.value.observations[0]!.value,'Condition\nException\n');
  assert.equal(cold.list('model-call').length,2);assert.deepEqual(cold.get(paid.id,paid.revision),paid);
});


test('RD2a preview includes the same predeclared capacity as the unsent C producer without authorizing a call', async t => {
  const {previewResearch}=await import('../src/discovery/research-preview.js');
  const {withInvocationAllowance}=await import('../src/discovery/invocation-progress.js');
  const f=await synthesisCapacityFixture(t,false);
  const preview=JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(f.store.list('model-call').length,0);
  assert.equal(preview.subject.resultCapacity.contract,'result-capacity/v1');
  await assert.rejects(withInvocationAllowance(1,f.invoke),{code:'research_call_allowance'});
  const first=f.store.list<any>('research-consumer-intent').find(row=>row.value.state==='applied')!;
  assert.deepEqual(first.value.cursor.resultCapacity,preview.subject.resultCapacity);
  const { hashJson } = await import('../src/canonical.js');
  const { researchCapacityProjection } = await import('../src/discovery/early-research-outcome.js');
  assert.equal(first.value.cursor.resultCapacity.bindings.inputsHash, hashJson(f.draft.value.inputs));
  assert.equal(Object.hasOwn(first.value.cursor.resultCapacity.bindings, 'inputs'), false);
  assert.deepEqual(researchCapacityProjection(first.value.cursor.resultCapacity, f.store).subject.inputs,
    f.draft.value.inputs, 'The exact full input list remains once in the mandatory projection');
  const {researchCall}=await import('../src/discovery/research-protocol.js');
  const count=f.store.list('model-call').length;
  await assert.rejects(researchCall(first.value.role,first.value.dispatch,first.value.cursor.prompt,first.value.cursor.context,undefined,
    {store:f.store,draftId:f.draft.id,questionId:f.question.id,purpose:'analyst',consumerIntent:reference(first),previewIntent:first}),
    {code:'research_preview_unbound'});
  assert.equal(f.store.list('model-call').length,count);
});


test('RD2a C capacity refusal cannot blame the model after a second Store changes its exact Source before commit', async t => {
  const {withInvocationAllowance}=await import('../src/discovery/invocation-progress.js');
  const f=await synthesisCapacityFixture(t,false);f.large(true);
  const second=new Store(f.database);t.after(()=>second.close());
  const write=f.store.writeMany.bind(f.store);let changed=false;
  f.store.writeMany=((writes,guards)=>{
    if(!changed&&writes.some(row=>row.kind==='research-consumer-intent'&&(row.value as any).refusal?.code==='research_result_capacity')){
      changed=true;const source=second.list<any>('source').find(row=>row.value.origin.location==='material')!;
      new ProductEngine(second).discovery.evidence.document('p','material','The material was revised','text/plain',source.revision);
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  await assert.rejects(withInvocationAllowance(1,f.invoke),{code:'synthesis_evidence_stale'});
  assert.ok(changed);assert.equal(f.store.list('research-checkpoint').length,0);
  assert.equal(f.store.list<any>('research-consumer-intent').filter(row=>row.value.refusal?.code==='research_result_capacity').length,0);
  const calls=f.store.list<ModelCall>('model-call');assert.equal(calls.length,1);assert.equal(calls[0]!.value.status,'succeeded');assert.ok(calls[0]!.value.response);
  const cold=new Store(f.database);t.after(()=>cold.close());
  await assert.rejects(withInvocationAllowance(1,()=>f.invoke(cold)),{code:'synthesis_evidence_stale'});
  assert.equal(cold.list('model-call').length,1,'Cold recovery preserves the paid reply without another send');
  assert.deepEqual(cold.get(calls[0]!.id,calls[0]!.revision),calls[0]);
});


test('RD2a the real envelope packs a saved result admission once without an external serialized reserve', async t => {
  const { prepareResearchEnvelope } = await import('../src/discovery/research-protocol.js');
  const f = fixture(t, 'none');
  const draft = f.engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{
    field: 'bounded', kind: 'design', prompt: 'Return the bounded result', risk: 'Duplicate admission', schema: { type: 'string' } }]);
  const question = f.store.get<any>(draft.value.questions[0]!)!;
  const dispatch = f.engine.environments.get('p').value, role = dispatch.implementer;
  const context = { role: 'research', question: { id: question.id }, history: [],
    instruction: 'Keep the entire required instruction: ' + 'x'.repeat(30_000) };
  const capacity = resultCapacityFrom(researchCapacityInput({ operation: 'real-packet', generation: 0,
    bindings: { draft: reference(draft), question: reference(question), instruction: 'b'.repeat(12_000) },
    role: 'analyst', purpose: 'analyst', actionMode: 'research', limit: 60_000, prompt: 'Return the result',
    binding: role, draft: draft.value, question, context }));
  const packed = prepareResearchEnvelope(role, dispatch, 'Return the result', context,
    { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst' }, capacity);
  const subject = packed.subject as Record<string, any>;
  assert.deepEqual(subject.resultCapacity, capacity);
  assert.equal(subject.instruction, context.instruction);
  assert.equal(packed.input.split('result-capacity/v1').length - 1, 1);
  assert.ok(packed.input.length <= capacity.envelopeLimitChars);
  assert.equal(f.store.list('model-call').length, 0);
});


test('RD2a configured request bounds do not invent a missing physical ceiling', () => {
  const pilot = { maxRequestChars: 600000 };
  assert.equal(researchResultEnvelopeLimit({ requestCapacityChars: 600000 }, pilot), 600000);
  assert.equal(researchResultEnvelopeLimit({ requestCapacityChars: 900000 }, pilot), 600000);
  assert.equal(researchResultEnvelopeLimit({ requestCapacityChars: 500000 }, pilot), 500000);
  assert.equal(researchResultEnvelopeLimit({ requestCapacityChars: 600000 }), 600000);
  assert.equal(researchResultEnvelopeLimit({}, pilot), 600000);
  assert.equal(researchResultEnvelopeLimit({}), 300000, 'The existing unconfigured non-pilot route retains its declared default');
  const physical = { maxRequestChars: 180000, maxReplyChars: 1000000, basis: 'Declared transport capacity' };
  assert.equal(researchResultEnvelopeLimit({ requestCapacityChars: 600000 }, { ...pilot, physicalLimits: physical }), 180000);
  assert.equal(researchResultEnvelopeLimit({ requestCapacityChars: 600000 }, { ...pilot,
    physicalLimits: { ...physical, maxRequestChars: 900000 } }), 600000);
  for (const [environment, profile, field] of [
    [{ requestCapacityChars: 600000 }, {} as any, 'reader-pilot.maxRequestChars'],
    [{ requestCapacityChars: 600000 }, { ...pilot, physicalLimits: {} } as any, 'reader-pilot.physicalLimits.maxRequestChars'],
    [{ requestCapacityChars: 0 }, pilot, 'environment.requestCapacityChars'],
    [{ requestCapacityChars: Number.NaN }, pilot, 'environment.requestCapacityChars']
  ] as const) assert.throws(() => researchResultEnvelopeLimit(environment, profile), (error: any) =>
    error.code === 'research_capacity_configuration' && error.details.field === field);
});

for (const role of ['research', 'assess-answer']) test(`RD2a ${role} admits a legal 400000 result under its configured 600000 allowance`, async t => {
  const f = fixture(t, 'none');
  const environment = f.engine.environments.get('p'), { projectId: _projectId, ...settings } = environment.value;
  f.engine.environments.configure('p', { ...settings, requestCapacityChars: 600000 }, environment.revision);
  f.control({ largeRole: role, form: role === 'research' ? 'checkpoint' : 'verdict', chars: 400000 });
  const outcome = await f.run(f.store, role === 'research' ? 1 : 2);
  assert.notEqual(outcome.reason?.code, 'research_result_capacity', JSON.stringify(outcome));
  const producer = role === 'research' ? f.store.list<any>('research-consumer-intent').find(row => row.value.state === 'applied')!
    : f.store.list<any>('assessment-application').find(row => row.value.state === 'applied')!;
  assert.equal(producer.value.state, 'applied', JSON.stringify(outcome));
  const capacity = role === 'research' ? producer.value.cursor.resultCapacity : producer.value.context.resultCapacity;
  assert.equal(capacity.envelopeLimitChars, 600000);
  assert.equal(f.calls().length, role === 'research' ? 1 : 2);
});

test('RD2a C admits a legal 400000 checkpoint under its saved 600000 allowance', async t => {
  const { withInvocationAllowance } = await import('../src/discovery/invocation-progress.js');
  const f = await synthesisCapacityFixture(t, false, 600000); f.large(true);
  await assert.rejects(withInvocationAllowance(1, f.invoke), { code: 'research_call_allowance' });
  const applied = f.store.list<any>('research-consumer-intent').filter(row => row.value.state === 'applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.value.cursor.resultCapacity.envelopeLimitChars, 600000);
  assert.equal(f.store.list('model-call').length, 1);
});

async function readerRetryFixture(t: import('node:test').TestContext, split: boolean, requestLimit = 45000) {
  const { configureReaderPilot } = await import('../src/discovery/reader-pilot.js');
  const { readBundle } = await import('../src/discovery/reader.js');
  const root = mkdtempSync(join(tmpdir(), 'omg-capacity-reader-retry-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'Reader recovery' });
  const settings = join(root, 'settings'), script = join(root, 'reader.mjs');
  writeFileSync(settings, JSON.stringify({ physical: true }));
  const inputs = Array.from({ length: split ? 2 : 1 }, (_, index) => {
    const path = `source-${index}.txt`;
    writeFileSync(join(root, path), split ? (String(index) + ' exact condition ' + 'x'.repeat(1900) + '\n').repeat(16) : 'Condition\nException\n');
    return { path, media: 'text/plain' as const };
  });
  writeFileSync(script, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
    if(settings.physical){process.stdout.write('x'.repeat(4100000));${holdUntilStopped};}
    else console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{
      selections:r.subject.sources.map((s,sourceIndex)=>({sourceIndex,firstLine:s.lines[0][0],lastLine:s.lines.at(-1)[0]})),
      unresolved:settings.large?['x'.repeat(400000)]:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [script] };
  const environment = engine.environments.configure('p', { workspace: root, requestCapacityChars: requestLimit,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  let pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: requestLimit, maxReadChars: 60000, maxReplyChars: 1000000, maxCalls: 10, maxReportedTokens: 1000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{ field: 'result', kind: 'design',
    prompt: 'Preserve the condition and exception', risk: 'Lost condition', schema: { type: 'object' } }]);
  const question = store.get<any>(draft.value.questions[0]!)!;
  return { store, engine, database, inputs,
    reserve: (call: Revision<ModelCall>) => {
      const { projectId: _projectId, ...settings } = pilot.value;
      pilot = configureReaderPilot(store, engine.environments, 'p', { ...settings,
        unknownReserves: [{ call: reference(store.get<ModelCall>(call.id)!), tokens: 100 }] }, pilot.revision);
    },
    control: (value: { physical?: boolean; large?: boolean }) => writeFileSync(settings, JSON.stringify(value)),
    invoke: (db = store) => readBundle(db, environment.value, pilot, reference(question), 'Extract the exact condition', inputs) };
}

for (const split of [false, true]) test(`RD2a reader ${split ? 'split child' : 'bundle'} uses one physical permit and cold history remains readable`, async t => {
  const f = await readerRetryFixture(t, split);
  await assert.rejects(f.invoke(), { code: 'process_output_limit' });
  const call = f.store.list<ModelCall>('model-call')[0]!;
  const cold = new Store(f.database); t.after(() => cold.close());
  await assert.rejects(f.invoke(cold), { code: 'research_consumer_execution_refused' });
  assert.equal(cold.list('model-call').length, 1, 'No permit means no new dispatch');
  const permit = { type: 'permit-limited-call-retry', project: 'p', call: reference(call) } as const;
  f.engine.execute(permit); f.control({ physical: false });
  await assert.rejects(f.invoke(cold), { code: 'pilot_usage_unknown' });
  assert.equal(cold.list('model-call').length, 1, 'Permission never invents the unknown token reserve');
  f.reserve(call);
  const result = await f.invoke(cold);
  assert.equal(result.value.observations.length, split ? 2 : 1);
  assert.equal(cold.list('model-call').length, split ? 3 : 2);
  assert.deepEqual(cold.get(call.id, call.revision), call);
  assert.throws(() => new ProductEngine(cold).execute(permit), { code: 'limited_call_retry_stale' });
  const restarted = new Store(f.database); t.after(() => restarted.close());
  const before = restarted.list();
  assert.deepEqual(await f.invoke(restarted), result, 'The next generation retains its exact paid predecessor');
  assert.deepEqual(restarted.list(), before, 'Cold history does not send or write again');
});

test('RD2a reader admits a 400079 result without a physical ceiling at configured 600000', async t => {
  const f = await readerRetryFixture(t, false, 600000); f.control({ physical: false, large: true });
  const result = await f.invoke();
  assert.equal(result.value.unresolved[0]!.length, 400000);
  assert.equal(f.store.list<ResearchConsumerIntent>('research-consumer-intent')[0]!.value.cursor.resultCapacity.envelopeLimitChars, 600000);
  assert.equal(f.store.list('model-call').length, 1);
});


test('RD2a reader permit window: two cold Stores buy only one new extraction', async t => {
  const f = await readerRetryFixture(t, false);
  await assert.rejects(f.invoke(), { code: 'process_output_limit' });
  const call = f.store.list<ModelCall>('model-call')[0]!;
  f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) });
  f.reserve(call); f.control({ physical: false });
  const one = new Store(f.database), two = new Store(f.database);
  t.after(() => { one.close(); two.close(); });
  const results = await Promise.allSettled([f.invoke(one), f.invoke(two)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(f.store.list('model-call').length, 2);
  assert.deepEqual(f.store.get(call.id, call.revision), call);
});

test('RD2a reader permit window: changed Environment before renewed intent CAS prevents dispatch', async t => {
  const f = await readerRetryFixture(t, false);
  await assert.rejects(f.invoke(), { code: 'process_output_limit' });
  const call = f.store.list<ModelCall>('model-call')[0]!;
  f.engine.execute({ type: 'permit-limited-call-retry', project: 'p', call: reference(call) });
  f.reserve(call); f.control({ physical: false });
  const second = new Store(f.database); t.after(() => second.close());
  const write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes, guards) => {
    if (!changed && writes.some(row => row.kind === 'research-consumer-intent' && (row.value as any).generation === 1)) {
      changed = true;
      const engine = new ProductEngine(second), environment = engine.environments.get('p');
      const { projectId: _projectId, ...settings } = environment.value;
      engine.environments.configure('p', { ...settings, requestCapacityChars: 40000 }, environment.revision);
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  await assert.rejects(f.invoke(), (error: any) => ['input_stale', 'reader_intent_claim_conflict'].includes(error.code));
  assert.ok(changed);
  assert.equal(f.store.list('model-call').length, 1);
  assert.deepEqual(f.store.get(call.id, call.revision), call);
});

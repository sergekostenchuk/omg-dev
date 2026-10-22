import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Json, canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { runModelCall, readModelCall, type ModelCallRequest, type OmModelCall, runModelTransport, type ModelTransportRequest, readCompletionWorkAt, runModelCycle, readModelCycle, assembleModelParts, checkCompletionLedger, deliverModelSources, correctionGround as mp2Ground, runModelCycle as mp2Cycle, readContinuationEvidence } from '../src/om/model-call.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { withHistoricalReads } from '../src/om/input.js';
import { writeAddressing, inputDecisionWrite } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeQuestionPacket, type QuestionPacketRecord, prepareQuestionTasks, type QuestionPacketRequest, prepareQuestionPacket, readQuestionPacket } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { type RepairSeries, readCompletionBinding, completionWorkId, seriesRequestOf, readSeries, openSeries } from '../src/om/series.js';
import { gapLineKey } from '../src/om/gap-lines.js';
import { recordCall } from '../src/om/call-record.js';
import { closeAttempt, openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { unitRefusalNamespace, UNIT_REFUSAL_KIND, recordRefusal } from '../src/om/refusal-journal.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { readModelCallRecovery } from '../src/discovery/model-call-recovery.js';
import { completionE1, completionSnapshot, currentPacketWire, e4CannotAnswer, e4Fact, e4Fixture, e4ManagedAnalysisFixture, e4NeedSource, e4Node, ensureFixtureProject, fixtureCheckpoint, fixtureDriver, h15CannotAnswer, h15Heads, h15Refusal, killFixtureDriver, killFixtureProvider, mp2Managed, mp2Refused, mp3Carried, mp3Cycle, mp3Decisions, mp3Parts, mp3Readings, publicRecovery, readsOf, refusesLiveRecovery, signalFixtureProvider, usage, valueOf } from './om-model-call-fixture.js';



test('E4 node result conflict leaves no partial response/proposal/result, accounts observed usage and never dispatches twice', async t => {
  const f = e4Fixture(t, 'node', 100_000, 0, 5000, true); f.steps([{ research: e4Node(f), usage }]);
  const writeMany = f.store.writeMany.bind(f.store); let injected = false;
  const replace = () => {
    injected = true;
    const other = new Store(f.database);
    try {
      const head = other.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
      const { projectId: _project, ...config } = structuredClone(head.value);
      new ProductEngine(other).environments.configure(f.project, { ...config, timeoutMs: config.timeoutMs + 1 }, head.revision);
    } finally { other.close(); }
  };
  f.store.writeMany = ((writes, guards) => {
    if (!injected && writes.some(write => write.kind === 'part-response')) replace();
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  // A managed application failure is a typed refusal, not an invented failed product — the standalone
  // om.rejection record is removed (S1.1 in om-model-call-part-02); the received receipt stays resumable.
  const actual = await runModelCall(f.store, f.request); f.store.writeMany = writeMany;
  assert.equal(actual.ok, false);
  if (!actual.ok) assert.equal(actual.refusal.code, 'input_stale');
  assert.ok(injected); assert.equal(f.sent().length, 1);
  assert.equal(f.store.list('om-model-exchange').length, 1);
  for (const kind of ['part-response', 'part-result']) assert.equal(f.store.list(kind).length, 0);
  assert.equal(f.store.list('layer-proposal').length, 0);
  assert.equal(f.store.list('om-completion-cessation').length, 0);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null, 'No unpaid work is closed');
  const record = f.store.list<OmModelCall>('model-call')[0]!;
  assert.equal(record.value.om.application, 'received'); assert.equal(record.value.om.part, null);
  const call = f.store.list<{usage: typeof usage;status:string}>('call-record')[0]!;
  assert.deepEqual(call.value.usage, usage); assert.equal(call.value.status, 'succeeded');
  const pending = readModelCall(f.store, { project: f.project, record: reference(record) });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.refusal.code, 'model_call_application_pending');
  const expected = f.store.get(record.id)!;
  f.restart();
  assert.deepEqual(f.store.get(record.id), expected);
  const repeated = await runModelCall(f.store, f.request);
  assert.equal(repeated.ok, false);
  if (!repeated.ok) assert.equal(repeated.refusal.code, 'completion_ceased');
  assert.equal(f.store.list('om-completion-cessation').length, 1);
  assert.equal(f.sent().length, 1);
});



test('E4 owner loss after authorization but before stdin preserves unknown delivery for product and analysis', async t => {
  for (const purpose of ['fact', 'stop-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact';
    const f = product ? e4Fixture(nested, 'fact', 100_000, 0, 30_000, true) : await e4ManagedAnalysisFixture(nested, 'stop-analysis', 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'authorized.json');
    const research = product ? e4Fact(f as ReturnType<typeof e4Fixture>) : { cause: 'No request yet transferred', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage }] }));
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request,
      { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'authorized' }] });
    const paused = await fixtureCheckpoint(checkpoint, driver.child); assert.equal(paused.pid, driver.child.pid);
    // Under the managed carrier the paid preparation holds its own model-call rows: the live dispatch is the
    // only running one, the first list entry is otherwise an arbitrary paid predecessor.
    const dispatch = f.store.list<ModelCall>('model-call').find(row => row.value.status === 'running')!, provider = dispatch.value.execution!.provider!;
    nested.after(() => { signalFixtureProvider(provider.pid, provider.started); });
    assert.equal(f.sent().length, 0, 'Authorization alone is not evidence that stdin was transferred');
    refusesLiveRecovery(f.store, f.project, reference(dispatch));
    await killFixtureDriver(driver);
    if (processStart(provider.pid) === provider.started) await killFixtureProvider(provider.pid, provider.started);
    const recovered = publicRecovery(f.store, f.project, reference(dispatch));
    const proof = readModelCallRecovery(f.store, f.project, reference(recovered));
    assert.equal(proof.proof!.request, 'unknown'); assert.equal(proof.proof!.physical, 'group-terminated');
    assert.equal(recovered.value.usage, null); assert.equal(recovered.value.response, null); assert.equal(f.sent().length, 0);
    const saved = f.store.list(); f.restart();
    if (product) valueOf(await runModelCall(f.store, f.request as ModelCallRequest));
    else valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest));
    assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 0);
  });
});



test('13 H1.0a local off-form stays open until G7; the exact complete close survives a new Store', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
  f.steps([{ research: { nonsense: true }, usage }]);
  const called = valueOf(await runModelCall(f.store, f.request));
  assert.equal(called.record.value.om.failure?.code, 'part_answer_invalid');
  assert.ok(called.diagnostic);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(f.series), 1))!;
  const work = valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
  assert.equal(work.complete, true);
  const claim = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'off-form' as const, accepting: [], cancelling: [], refusals: work.refusals } };
  const closed = valueOf(closeAttempt(f.store, claim));
  assert.equal(closed.attempt, 1);
  const saved = f.store.get(f.series.id)!;
  f.restart();
  assert.equal(valueOf(readSeries(f.store, seriesRequestOf(f.series.value))).value.attempts[0]!.outcome?.reason, 'off-form');
  await t.test('30 exact close replays from its saved proof without another series revision',()=>{
    valueOf(closeAttempt(f.store,claim));assert.deepEqual(f.store.get(f.series.id),saved);
  });
  assert.equal(valueOf(await runModelCall(f.store, f.request)).repeated, true);
  assert.equal(f.sent().length, 1);
});



test('32 H1.0a cycle cursor recovery after G7 uses only the exact closed products', async t => {
  const { prepareCompletionProducts } = await import('../src/om/model-call.js');
  for (const mode of ['off-form', 'interrupted', 'cannot-answer', 'assembly', 'parts-and-continuation'] as const) {
    await t.test(mode, async child => {
      const node = mode === 'assembly' || mode === 'parts-and-continuation';
      const f = e4Fixture(child, node ? 'node' : 'fact', 100_000, 0, 5000, true);
      let request = f.request;
      if (node) {
        const split = mode === 'parts-and-continuation';
        const config = split ? f.environment(currentPacketWire(f.packet.value.packet) - 1) : f.configured;
        const packet = split ? valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record : f.packet;
        const answers = packet.value.plan!.assignments.map((_, position) => ({ research: e4Node(f, { ...packet,
          value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>), usage }));
        const need = { ...e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]),
          questionIds: (packet.value.packet as { questions: { id: string }[] }).questions.map(row => row.id) };
        f.steps([...(split ? [{ research: need, usage }] : []), ...answers]);
        request = { ...request, packet: reference(packet), dispatch: { ...request.dispatch, config: reference(config) } };
      } else f.steps([{ research: mode === 'cannot-answer' ? e4CannotAnswer(f) : { bad: true }, usage,
        ...(mode === 'interrupted' ? { exitCode: 7 } : {}) }]);
      const write = f.store.writeMany.bind(f.store);
      let cursor: Write | undefined;
      f.store.writeMany = ((writes, guards) => {
        const cycle = writes.find(row => row.kind === 'om-model-cycle');
        if (cycle) { cursor = cycle; throw Error('stop before cycle cursor'); }
        return write(writes, guards);
      }) as Store['writeMany'];
      try { await assert.rejects(runModelCycle(f.store, request), /stop before cycle cursor/); }
      finally { f.store.writeMany = write; }
      assert.ok(cursor);
      assert.equal(f.store.list('om-model-cycle').length, 0);
      const work = completionSnapshot(f);
      assert.equal(work.complete, true);
      let refusals = [...work.refusals];
      if (node) {
        // Assembly is ready, but it is not a C5 achievement. An independent G3 supplies reason.
        const source = f.store.write({ id: `${unitRefusalNamespace(f.project)}cycle-recovery`, kind: UNIT_REFUSAL_KIND, expected: 0,
          value: { gate: 'G3', refusals: [{ code: 'unrecognized_fixture_refusal', goal: 'cycle-recovery', remedy: 'Review the assembly',
            origin: { name: 'artifact_missing', stage: 'layer-check', subject: 'artifact:fixture', sources: [] } }] } });
        const journal = valueOf(recordRefusal(f.store, { project: f.project, source: reference(source) }));
        const row = journal.value.rows.find(row => row.source.id === source.id)!;
        refusals.push({ row: row.id, name: row.code, goal: row.goal });
      }
      const reason = mode === 'off-form' ? 'off-form' : mode === 'interrupted' ? 'interrupted' : 'refused';
      const claim = { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason, accepting: [], cancelling: [], refusals } } as const;
      const closed = valueOf(closeAttempt(f.store, claim));
      const before = f.store.list(), sends = f.sent().length;
      writeFileSync(join(f.root, 'e4-source.txt'), 'changed after completed work');
      f.restart();
      const resumed = valueOf(await runModelCycle(f.store, request));
      assert.equal(resumed.record.id, cursor.id);
      assert.deepEqual(resumed.record.value, cursor.value);
      assert.equal(resumed.record.revision, 1);
      assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(resumed.record) })).record, resumed.record);
      assert.deepEqual(f.store.list().filter(row => row.kind !== 'om-model-cycle'), before,
        'Recovery writes only the cycle cursor, never closed work, A3, E4, parts or accounting');
      assert.equal(f.sent().length, sends);
      const forbidden = prepareCompletionProducts(f.store, reference(work.binding), [reference(resumed.record)]);
      assert.equal(forbidden.ok, false, 'Cursor recovery does not open a registration path into closed work');
      if (!forbidden.ok) assert.equal(forbidden.refusal.code, 'completion_closed');
      const after = f.store.list();
      f.restart();
      await child.test('31 completed cycle and each local part replay without further writes', async () => {
        assert.equal(valueOf(await runModelCycle(f.store, request)).repeated, true);
        for (const step of resumed.record.value.steps)
          valueOf(await runModelCall(f.store, { ...request, packet: step.packet }));
        if (resumed.assembly) valueOf(assembleModelParts(f.store, { project: f.project, results: [...resumed.record.value.results] }));
        assert.deepEqual(valueOf(closeAttempt(f.store, claim)), closed);
        assert.deepEqual(f.store.list(), after);
        assert.equal(f.sent().length, sends);
      });
    });
  }
});



test('21 H1.0a MC2 complete parts require assembly, and assembly alone cannot impersonate an accepted achievement', async t => {
  for (const split of [false, true]) await t.test(split ? 'split with source child' : 'single direct part', async t => {
    const f = e4Fixture(t, 'node', 100_000, 0, 1000, true);
    const config = split ? f.environment(currentPacketWire(f.packet.value.packet) - 1) : f.configured;
    const packet = split ? valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record : f.packet;
    const count = packet.value.plan!.assignments.length;
    const answers = Array.from({ length: count }, (_, position) => e4Node(f, { ...packet,
      value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>));
    const need = { ...e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]),
      questionIds: (packet.value.packet as { questions: {id:string}[] }).questions.map(row => row.id) };
    f.steps([...(split ? [{ research: need }] : []), ...answers.map(research => ({ research, usage }))]);
    const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
    const first = valueOf(await runModelCall(f.store, request));
    await t.test('27 physical terminal or source receipt without assembly remains incomplete',()=>{
      assert.equal(completionSnapshot(f).complete,false);
    });
    assert.equal(completionSnapshot(f).assignments.filter(row => row.value.kind === 'part').length, count);
    assert.equal(first.record.value.om.completionOwner!.call.id, first.call.id);
    const cycle = valueOf(await runModelCycle(f.store, request));
    assert.equal(cycle.record.value.terminal, 'assembled');
    assert.ok(cycle.assembly);
    assert.equal(completionSnapshot(f).complete, true);
    const owners = cycle.record.value.steps.map(step => valueOf(readModelCall(f.store, { project:f.project, record:step.record })).record.value.om.completionOwner!);
    assert.equal(new Set(owners.map(row => row.call.id)).size, count + Number(split));
    await t.test('22 source continuation keeps one binding and distinct exact steps',()=>{
      assert.equal(new Set(owners.map(row=>row.binding.id)).size,1);
      assert.equal(new Set(owners.map(row=>row.assignment.id)).size,count+Number(split));
    });
    await t.test('23 proved assembly discharges the logical MC2 root',()=>{assert.equal(completionSnapshot(f).complete,true);assert.ok(cycle.assembly);});
    await t.test('28 ready assembly alone cannot claim an empty result',()=>{
      assert.equal(closeAttempt(f.store,{...seriesRequestOf(f.series.value),attempt:1,
        outcome:{reason:'result',accepting:[],cancelling:[],refusals:[]}}).ok,false);
    });
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
    const before = f.store.list(); f.restart();
    assert.equal(valueOf(await runModelCycle(f.store, request)).repeated, true);
    assert.equal(completionSnapshot(f).complete, true);
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.sent().length, count + Number(split));
  });
});



test('14 H1.0a physical technical and control terminals keep their own diagnostic through G7 and exact restart', async t => {
  for (const kind of ['interrupted','awaiting-owner','refused','mechanism'] as const) await t.test(`${kind==='awaiting-owner'?'16':'14'} ${kind}`,async t => {
    const f=e4Fixture(t,kind==='mechanism'?'field':'fact',100_000,0,1000,true);
    const action=kind==='awaiting-owner'?'need_owner':'cannot_answer';
    f.steps([kind==='interrupted' ? {exitCode:1,usage} : {research:{protocol:'$answerProtocol',requestId:'$requestId',action,
      questionIds:[f.batch.items[0]!.gap],reason:'A concrete external source is required',...(action==='need_owner'?{decision:'Choose the source'}:{})},usage}]);
    const call=valueOf(await runModelCall(f.store,f.request));
    assert.ok(call.diagnostic);
    const work=completionSnapshot(f); assert.equal(work.complete,true);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
    const reason=kind==='mechanism'?'refused':kind;
    const claim={...seriesRequestOf(f.series.value),attempt:1,outcome:{reason,accepting:[],cancelling:[],refusals:work.refusals}};
    const closed=valueOf(closeAttempt(f.store,claim));
    assert.equal(f.store.list('om-origin-hold').length,0);
    assert.equal(work.waiting.length,Number(kind==='awaiting-owner'));
    const before=f.store.list(); f.restart();
    assert.deepEqual(valueOf(closeAttempt(f.store,claim)),closed);
    valueOf(readModelCall(f.store,{project:f.project,record:reference(call.record)}));
    assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,1);
  });
});



test('32 H1.0a direct assembly repeat restores a lost registry cursor without producing or paying twice',async t=>{
  const f=e4Fixture(t,'node',100_000,0,1000,true);f.steps([{research:e4Node(f,f.packet as Revision<QuestionPacketRecord>),usage}]);
  const call=valueOf(await runModelCall(f.store,f.request));assert.ok(call.part);
  const request={project:f.project,results:[call.part.result]},write=f.store.writeMany.bind(f.store);
  let stopped=false;
  f.store.writeMany=((writes,guards)=>{
    if(!stopped&&writes.some(row=>row.kind==='om-part-assembly')){
      stopped=true;assert.ok(writes.some(row=>row.kind==='om-completion-work'));
      write(writes.filter(row=>row.kind!=='om-completion-work'),guards);throw Error('assembly cursor lost');
    }
    return write(writes,guards);
  })as Store['writeMany'];
  try{assert.throws(()=>assembleModelParts(f.store,request),/assembly cursor lost/);}finally{f.store.writeMany=write;}
  assert.equal(stopped,true);assert.equal(completionSnapshot(f).complete,false);
  const assembly=f.store.list('om-part-assembly')[0]!,physical=f.store.list('model-call');f.restart();
  assert.deepEqual(valueOf(assembleModelParts(f.store,request)).record,assembly);assert.equal(completionSnapshot(f).complete,true);
  const saved=f.store.list();f.restart();
  assert.deepEqual(valueOf(assembleModelParts(f.store,request)).record,assembly);
  assert.deepEqual(f.store.list(),saved);assert.deepEqual(f.store.list('model-call'),physical);assert.equal(f.sent().length,1);
});



test('34 H1.0a a completion ledger retains the exact journal context of a genuine mechanism origin analysis',async t=>{
  const f=e4Fixture(t,'field',100_000,0,1000,true);
  f.steps([{research:{protocol:'$answerProtocol',requestId:'$requestId',action:'cannot_answer',
    questionIds:[f.batch.items[0]!.gap],reason:'An external decision is required'},usage}]);
  valueOf(await runModelCall(f.store,f.request));
  const work=completionSnapshot(f);
  const refusal=f.store.write({id:`${unitRefusalNamespace(f.project)}h10a-origin`,kind:UNIT_REFUSAL_KIND,expected:0,
    value:{gate:'G3',refusals:[{code:'unrecognized_fixture_refusal',goal:'origin',remedy:'Identify this exact origin',
      origin:{name:'artifact_missing',stage:'layer-check',subject:'artifact:fixture',sources:[]}}]}});
  const journal=valueOf(recordRefusal(f.store,{project:f.project,source:reference(refusal)}));
  const row=journal.value.rows.find(row=>row.source.id===refusal.id)!;
  const claim={...seriesRequestOf(f.series.value),attempt:1,outcome:{reason:'refused' as const,accepting:[],cancelling:[],
    refusals:[...work.refusals,{row:row.id,name:row.code,goal:row.goal}]}};
  const closed=valueOf(closeAttempt(f.store,claim));assert.equal(closed.holds.length,1);
  const owner={kind:'mechanism' as const,mechanism:'M5:addressing' as const};
  const analysis=valueOf(recordCall(f.store,f.project,{call:'h10a:mechanism-origin',purpose:'origin-analysis',owner,
    admission:{gaps:f.gapRequest,routes:reference(f.routes),batch:f.batch.id},
    basis:{kind:'origin-hold',hold:closed.holds[0]!},series:reference(f.store.get(f.series.id)!),attempt:1,
    gaps:[{id:'origin',goal:'origin',field:'cause-and-change',consumer:owner}],
    goal:{key:'origin',questions:['What caused this exact refusal?'],result:'A proved origin or a hypothesis'},
    dispatch:f.request.dispatch,packet:{origin:closed.holds[0]!} as unknown as Json}));
  assert.equal(analysis.call.value.purpose,'origin-analysis');
  const ledger=reference(f.store.get(`om-call-ledger:${f.project}`)!),cut=reference(f.store.get(`om-refusal-journal:${f.project}`)!);
  assert.equal(checkCompletionLedger(f.store,work,ledger).ok,false,'Mechanism history cannot guess its journal');
  assert.equal(valueOf(checkCompletionLedger(f.store,work,ledger,cut)),true);
  // A different owner closes after this analysis is already in the project-wide E1 ledger.
  const input=valueOf(writeAddressing(f.store,{project:f.project,input:reference(f.input),graph:reference(f.graph),
    decisions:[{pending:structuredClone(inputDecisionWrite({project:f.project,input:reference(f.input),graph:reference(f.graph),layers:[],
      decision:{target:'discovery:encoding',field:'address',value:{consumer:'garden-consume-block',kind:'repository-fact'}}})) as Write}]}));
  const horizon=valueOf(writeHorizon(f.store,{project:f.project,input:reference(input),graph:reference(f.graph),refinement:null,available:{},
    choice:{choiceVersion:'h10a-after-analysis',features:[{outcome:'garden-result'}],excluded:[]}}));
  const gaps=valueOf(writeGaps(f.store,{project:f.project,input:reference(input),graph:reference(f.graph),horizon:reference(horizon.gate),
    operations:{proposals:[],frame:{project:f.project,level:2,graph:reference(f.graph),horizon:reference(horizon.gate),layer:null,frame:null,upper:null}},
    works:{state:'upper-not-accepted',layer:reference(f.store.get(`graph-layer:${f.project}:2`)!)}}));
  const scope={sources:structuredClone(gaps.sources) as GapRequest,records:gaps.records.map(reference)};
  const tasks=valueOf(prepareQuestionTasks(f.store,{project:f.project,gaps:scope,questions:gaps.records
    .filter(row=>row.value.gap.kind==='repository-fact'&&row.value.gap.code!=='inventory_missing'&&!row.value.gap.deferral)
    .map(row=>({gap:reference(row),requirements:[{pointer:'/contracts/0'}],resultForm:{type:'string'}}))}));
  const routes=valueOf(writeRoutes(f.store,{project:f.project,gaps:scope,tasks:tasks.tasks.map(task=>({pending:structuredClone(task.writes[0]!) as Write})),
    catalog:{paths:['e4-source.txt'],records:[]},previous:reference(f.routes)}));
  const batch=routes.value.batches.find(row=>row.model==='MC1')!,address={project:f.project,block:'garden-consume-block',line:1};
  valueOf(openSeries(f.store,{...address,slice:'after-mechanism-analysis',predecessor:null,basis:null}));
  const series=valueOf(managedOpenAttempt(f.store,{...address,attempt:1,
    goal:{key:'after-analysis',questions:batch.items.map(item=>gapLineKey(f.project,item.target,item.field)),result:'accepted-gap-fill'},
    completion:{routes:reference(routes),batches:[batch.id]}}));
  const packet=valueOf(writeQuestionPacket(f.store,{project:f.project,routes:reference(routes),batch:batch.id,environment:reference(f.configured),
    attempt:{series:reference(series),ordinal:1},previous:[]})).record;
  f.steps([{}, {research:{malformed:'a preserved technical outcome'},usage}]);
  const called=valueOf(await runModelCall(f.store,{...f.request,packet:reference(packet)}));
  assert.ok(called.diagnostic);
  const binding=valueOf(readCompletionBinding(f.store,f.project,reference(series),1))!;
  const remaining=valueOf(readCompletionWorkAt(f.store,f.project,reference(f.store.get(completionWorkId(f.project,binding.id))!)));
  assert.equal(remaining.complete,true);
  const secondClaim={...address,attempt:1,outcome:{reason:'off-form' as const,accepting:[],cancelling:[],refusals:remaining.refusals}};
  const secondClosed=valueOf(closeAttempt(f.store,secondClaim));
  const later=f.store.write({id:`${unitRefusalNamespace(f.project)}h10a-later`,kind:UNIT_REFUSAL_KIND,expected:0,
    value:{gate:'G3',refusals:[{code:'later_refusal',goal:'later',remedy:'Later independent issue',
      origin:{name:'artifact_missing',stage:'layer-check',subject:'artifact:later',sources:[]}}]}});
  valueOf(recordRefusal(f.store,{project:f.project,source:reference(later)}));
  const saved=f.store.list();f.restart();const get=f.store.get.bind(f.store);
  f.store.get=((id:string,revision?:number)=>{
    if(id===cut.id||id===ledger.id)assert.notEqual(revision,undefined,'Historical completion uses its exact ledger and journal');
    return get(id,revision);
  }) as Store['get'];
  try{
    assert.equal(valueOf(checkCompletionLedger(f.store,work,ledger,cut)),true);
    assert.deepEqual(valueOf(closeAttempt(f.store,secondClaim)),secondClosed);
  }
  finally{f.store.get=get;}
  assert.deepEqual(f.store.list(),saved);assert.equal(f.sent().length,2);
  assert.deepEqual(valueOf(closeAttempt(f.store,claim)),closed);
});



test('C31 H1.0b an applied source request can cease its continuation without a synthetic cycle terminal', async t => {
  const { writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]), usage }]);
  const first = valueOf(await runModelCall(f.store, f.request)); assert.equal(first.outcome?.kind, 'need-source');
  const before = completionSnapshot(f), marker = first.record.value.om.completionOwner!;
  f.environment(90_000);
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: marker.binding, assignment: marker.assignment }));
  assert.equal(ceased.value.disposition, 'branch-ceased'); assert.equal(ceased.value.remainder, 'continuation');
  assert.equal(ceased.value.physical, null); assert.equal(completionSnapshot(f).complete, true);
  const close = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: before.refusals } };
  valueOf(closeAttempt(f.store, close)); f.restart(); const history = f.store.list();
  assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)).record, first.record);
  const cycle = await runModelCycle(f.store, f.request); assert.equal(cycle.ok, false);
  if (!cycle.ok) { assert.equal(cycle.refusal.code, 'completion_ceased'); assert.deepEqual(cycle.refusal.at.ref, reference(ceased)); }
  assert.deepEqual(f.store.list(), history); assert.equal(f.store.list('om-model-cycle').length, 0); assert.equal(f.sent().length, 1);
});



test('3 H1.0b equivalent configure after selected E1 preserves ordinary, cycle and continuation first claim', async t => {
  const { prepareCompletionCause, prepareCompletionCessation } = await import('../src/om/model-call.js');
  for (const mode of ['call', 'cycle', 'continuation'] as const) await t.test(mode, async child => {
    const f = e4Fixture(child, 'fact', 100_000, 0, 5000, true);
    let packet = f.packet;
    if (mode === 'continuation') {
      f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]), usage },
        { research: e4Fact(f), usage }]);
      const first = valueOf(await runModelCall(f.store, f.request));
      const basis = { project: f.project, packet: f.request.packet, call: first.call, response: first.response! };
      const delivery = valueOf(deliverModelSources(f.store, basis));
      packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest,
        continuation: { packet: basis.packet, call: basis.call, response: basis.response, deliveries: [...delivery.deliveries] } })).record;
    } else f.steps([{ research: e4Fact(f), usage }]);
    const e1 = completionE1(f, packet), selected = valueOf(recordCall(f.store, f.project, e1));
    const work = completionSnapshot(f), assignments = work.assignments.map(reference);
    const part = work.assignments.find(row => row.value.kind === (mode === 'continuation' ? 'continuation' : 'part'))!;
    const current = f.environment(); f.restart();
    const before = f.store.list();
    assert.equal(valueOf(recordCall(f.store, f.project, e1)).repeated, true);
    assert.deepEqual(f.store.list(), before, 'Direct E1 replay retains the exact chosen plan');
    assert.equal(valueOf(prepareCompletionCause(f.store, f.project, reference(part))).cause, null);
    const refused = prepareCompletionCessation(f.store, { project: f.project, binding: reference(work.binding), assignment: reference(part) });
    assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.refusal.code, 'completion_cause_unproved');
    const request = { ...f.request, packet: reference(packet) };
    const outcome = mode === 'cycle' ? valueOf(await runModelCycle(f.store, request)).last : valueOf(await runModelCall(f.store, request));
    assert.equal(outcome.outcome?.kind, 'fact-candidates');
    assert.deepEqual(outcome.call, reference(selected.call));
    assert.deepEqual(outcome.record.value.om.request, request);
    assert.deepEqual(f.store.get(selected.call.id, 1), selected.call);
    assert.ok(assignments.every(ref => completionSnapshot(f).assignments.some(row => canonical(reference(row)) === canonical(ref))));
    const exchange = f.store.get<{ admissionGuards: Ref[] }>(outcome.record.value.om.exchange!.id)!;
    assert.ok(exchange.value.admissionGuards.some(ref => canonical(ref) === canonical(reference(current))));
    f.restart(); const history = f.store.list();
    const replay = mode === 'cycle' ? valueOf(await runModelCycle(f.store, request)).last : valueOf(await runModelCall(f.store, request));
    assert.deepEqual(replay.record, outcome.record); assert.deepEqual(f.store.list(), history);
    assert.equal(f.sent().length, mode === 'continuation' ? 2 : 1);
  });
});



test('35 H1.0b equivalent configuration grants no privilege to an unselected old candidate', t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true), configured = f.environment();
  const next = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(configured) })).record;
  const chosen = valueOf(recordCall(f.store, f.project, completionE1(f, next, configured)));
  f.environment(); f.restart(); const history = f.store.list();
  const other = recordCall(f.store, f.project, completionE1(f));
  assert.equal(other.ok, false); if (!other.ok) assert.equal(other.refusal.code, 'completion_conflict');
  assert.deepEqual(f.store.list(), history); assert.deepEqual(f.store.get(chosen.call.id), chosen.call);
  assert.equal(f.sent().length, 0);
});



test('H1.5 №2166 п.5 the direct transport is no way around E4: a registered E1 call of an ordinary question packet is refused by runModelTransport before any dispatch', async t => {
  const f = e4Fixture(t, 'design', 100_000, 0, 5000, true);
  f.steps([{ research: h15CannotAnswer, usage }]);
  const payload = f.packet.value.packet as { requestId: string; purpose: 'model-design' | 'model-research'; questions: { id: string }[] };
  const attempt = f.series.value.attempts[0]!, assigned = new Set(payload.questions.map(question => question.id));
  const dispatch = { adapter: reference(f.adapter), config: reference(f.configured) };
  const admitted = valueOf(recordCall(f.store, f.project, { call: payload.requestId, purpose: payload.purpose, basis: null,
    series: reference(f.series), attempt: attempt.ordinal, goal: attempt.goal, dispatch, packet: payload as unknown as Json, block: 'garden-consume-block',
    gaps: f.batch.items.filter(item => assigned.has(item.gap)).flatMap(item => item.consumers.map(consumer => ({ id: item.target, goal: item.target, field: item.field, consumer }))) }));
  const before = h15Heads(f.store);
  const refusal = h15Refusal(await runModelTransport(f.store, { project: f.project, call: reference(admitted.call), packet: payload as unknown as Json, role: 'implementer' }));
  assert.deepEqual([refusal.code, refusal.at.field], ['model_call_request_invalid', 'purpose']);
  assert.equal(f.sent().length, 0);
  assert.deepEqual(h15Heads(f.store), before);
});



test('MP2 (№2968 rows 15, 16) a correction request is proved before anything is written: another call, a mixed edge or a non-brief packet refuse; a moved head between preparation and writing refuses without a partial write', async t => {
  const f = mp2Managed(t);
  f.steps([{ research: mp2Refused(f) }]);
  const call = valueOf(await runModelCall(f.store, f.request));
  assert.ok(call.diagnostic && call.response);
  const ground = { packet: call.packet, call: call.call, response: call.response!, diagnostic: call.diagnostic! };
  assert.equal(mp2Ground(f.store, f.project, ground).eligible, true);
  const before = f.store.list().map(reference);
  const refusedWith = (request: unknown) => { const result = writeQuestionPacket(f.store, request as QuestionPacketRequest);
    if (result.ok) assert.fail('Expected a refusal'); return result.refusal.code; };
  assert.equal(refusedWith({ ...f.packetRequest, correction: { ...ground, diagnostic: call.call } }), 'packet_chain_invalid', 'Row 15: a diagnostic of another record');
  assert.throws(() => writeQuestionPacket(f.store, { ...f.packetRequest, correction: ground,
    continuation: { packet: call.packet, call: call.call, response: call.response!, deliveries: [call.call] } } as QuestionPacketRequest),
  (error: EngineError) => error.code === 'question_packet_request_invalid', 'Row 15: a correction never stands beside a continuation');
  assert.deepEqual(f.store.list().map(reference), before, 'Row 15: nothing is written');
  // Row 16: the prepared correction stands on its guards; a moved environment refuses the write without a partial record.
  const prepared = valueOf(prepareQuestionPacket(f.store, { ...f.packetRequest, correction: ground }));
  const second = new Store(f.database);
  try {
    // A legal configure in the other Store changes the guarded head, without changing the assignment.
    const old = second.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
    const { projectId: _project, ...config } = structuredClone(old.value);
    new ProductEngine(second).environments.configure(f.project, config, old.revision);
  } finally { second.close(); }
  const written = writeGuarded(f.store, { unit: 'E2', target: prepared.record.id, writes: prepared.writes as Write[], guards: prepared.guards as never });
  assert.equal(written.ok, false, 'Row 16: the guard refuses');
  assert.equal(f.store.get(prepared.record.id), null);
});



test('MP2 (№2968 rows 11, 19; №3153) a correction of a part keeps the earlier parts and the root neighbour form of the chain, the parts after it stand on the corrected answer; the chain has one correction — in a first attempt and in a later one standing on a non-empty refusal journal', async t => {
  for (const retry of [false, true]) for (const refused of [1, 0]) await t.test(`${refused ? 'a later' : 'the first'} part, ${retry ? 'attempt 2 on a non-empty journal' : 'attempt 1'}`, async t => {
    const f = mp2Managed(t, 100_000, retry), config = f.environment(currentPacketWire(f.packet.value.packet) - 1);
    const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record as Revision<QuestionPacketRecord>;
    assert.equal(packet.value.plan!.mode, 'parts');
    const total = packet.value.plan!.assignments.length;
    assert.ok(total >= 2, 'The node is split into parts');
    const at = (position: number) => ({ ...packet, value: { ...packet.value, plan: { ...packet.value.plan!, position } } }) as Revision<QuestionPacketRecord>;
    f.steps(Array.from({ length: total }, (_, position) => position === refused ? [{ research: mp2Refused(f, at(position)) }, { research: e4Node(f, at(position)) }]
      : [{ research: e4Node(f, at(position)) }]).flat());
    const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
    const cycle = valueOf(await mp2Cycle(f.store, request));
    assert.equal(cycle.record.value.terminal, 'assembled'); assert.equal(f.sent().length, total + 1);
    const steps = cycle.record.value.steps, packets = steps.map(step => f.store.get<QuestionPacketRecord>(step.packet.id)!.value);
    const correction = packets[refused + 1]!;
    assert.ok(correction.request.correction, 'The step after the refused part corrects it');
    assert.equal(correction.request.previous.length, refused, 'It keeps the earlier parts');
    assert.equal(correction.plan!.position, refused);
    for (const later of packets.slice(refused + 2))
      assert.deepEqual(later.request.previous[refused]!.packet, steps[refused + 1]!.packet, 'A part after the correction stands on the corrected answer');
    for (const value of packets) assert.deepEqual(value.briefNeighbors, packet.value.briefNeighbors, 'Row 19: one neighbour form for the whole chain');
    assert.equal(packets.filter(value => value.request.correction).length, 1, 'One correction for the chain');
    if (retry) {
      assert.ok(packet.value.journal, 'The chain root stands on the journal of the refused attempt');
      assert.deepEqual(packets.map(value => value.journal), packets.map(() => packet.value.journal), 'Every step stands on the chain root\'s saved journal');
    }
  });
});



test('MP2 (№2968 row 14) stopped after the correction call was applied, before the cycle record: the cycle reuses both paid calls and sends nothing', async t => {
  const f = mp2Managed(t);
  f.steps([{ research: mp2Refused(f) }, { research: e4Node(f) }]);
  const first = valueOf(await runModelCall(f.store, f.request));
  const ground = { packet: first.packet, call: first.call, response: first.response!, diagnostic: first.diagnostic! };
  const correction = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, correction: ground })).record;
  const second = valueOf(await runModelCall(f.store, { ...f.request, packet: reference(correction) }));
  assert.ok(second.part); assert.equal(f.sent().length, 2);
  f.restart();
  const cycle = valueOf(await mp2Cycle(f.store, f.request));
  assert.equal(f.sent().length, 2, 'No call is sent again'); assert.equal(cycle.record.value.terminal, 'assembled');
  assert.deepEqual(cycle.record.value.steps.map(step => step.record.id), [first.record.id, second.record.id]);
});


test('MP3 row 18 (MP2 correction of a later part): the correction keeps the carried set of the part it corrects and decides it by its own capacity — the larger correction omits it and stays ready', async t => {
  const { m, f, packet, total, at, request, steps } = mp3Parts(t);
  f.steps([{ research: m.need([m.range(0, 9)], packet), usage }, { research: e4Node(f, at(0)), usage }, { research: mp2Refused(f, at(1)), usage },
    { research: e4Node(f, at(1)), usage }, ...Array.from({ length: total - 2 }, (_, index) => ({ research: e4Node(f, at(index + 2)), usage }))]);
  const cycle = valueOf(await mp2Cycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.equal(f.sent().length, total + 2);
  const [, , part1, correction] = steps(cycle);
  assert.ok(correction!.value.request.correction); assert.equal(correction!.value.plan!.position, 1); assert.equal(correction!.value.state, 'ready');
  const rows = (packet: { value: { packet: unknown } }) => mp3Readings(packet.value.packet).entries.map(({ decision: _decision, ...row }) => row);
  assert.deepEqual(mp3Readings(correction!.value.packet).snapshots, mp3Readings(part1!.value.packet).snapshots, 'The snapshots of the part it corrects');
  assert.deepEqual(rows(correction!), rows(part1!), 'The entries of the part it corrects');
  assert.deepEqual(mp3Decisions(part1!.value.packet), ['included']);
  assert.deepEqual(mp3Decisions(correction!.value.packet), ['capacity'], 'Its own capacity: the refusal and the previous answer leave no room for the optional read');
  assert.deepEqual(mp3Carried(correction!), []);
});



test('PF3.1 rows 4, 25, 27, 31, 32: the historical E4 continuation keeps its refusal of exact saved inputs — the same code and address at every repeat, in this and the next operation; a different request is another key; current applicability is never taken from it', { todo: "NR1 №3591: записанное не перепроверяется при чтении — проверка была у производителя при записи" }, async t => {
  const m = mp3Cycle(t), { f } = m;
  f.steps([{ research: m.need([m.range(0, 9), { action: 'read', path: 'mp3-notes.txt', media: 'text/plain' }]), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  const link = valueOf(readQuestionPacket(f.store, { project: f.project, record: cycle.record.value.steps[1]!.packet })).value.request.continuation!;
  const evidence = { project: f.project, ...link, deliveries: [...link.deliveries] };
  assert.ok(evidence.deliveries.length > 1);
  const short = { ...evidence, deliveries: evidence.deliveries.slice(1) };
  const refusal = () => { const read = readContinuationEvidence(f.store, short); assert.equal(read.ok, false); return read.ok ? null : read.refusal; };
  let first: unknown, repeat = 0;
  const cold = readsOf(() => withHistoricalReads(() => { first = refusal(); repeat = readsOf(() => assert.deepEqual(refusal(), first)); }));
  assert.ok(repeat < cold / 2, `Row 25: the kept refusal answers a repeat in the operation without deriving it again (${repeat} of ${cold} reads: its footprint)`);
  assert.equal((first as { code: string }).code, 'model_delivery_invalid');
  assert.deepEqual(withHistoricalReads(refusal), first, 'Row 25: the same refusal in the next operation');
  assert.throws(() => { (first as { code: string }).code = 'changed by a caller'; }, TypeError);
  assert.equal(refusal()!.code, 'model_delivery_invalid', 'Row 32: a returned refusal is sealed, never a shared mutable object');
  // Row 4: another request is another key; the full one is a success of its own.
  assert.ok(valueOf(readContinuationEvidence(f.store, evidence)).data.length > 0);
  // Row 31: the current branch checks sources and admission afresh — a changed working file refuses it, history stays.
  writeFileSync(join(f.root, 'mp3-notes.txt'), 'replaced working file');
  const current = readContinuationEvidence(f.store, evidence, true);
  assert.equal(current.ok, false); if (!current.ok) assert.equal(current.refusal.code, 'input_stale');
  assert.ok(readsOf(() => readContinuationEvidence(f.store, evidence, true)) > 0, 'The current branch derives at every call');
  assert.deepEqual(refusal(), first);
});


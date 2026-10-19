import test from 'node:test';
import { packetPrompt } from '../src/om/packet-brief.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Json, canonical } from '../src/canonical.js';
import { runModelCall, runModelCycle, readModelCycle, readPartAssembly, assembleModelParts, readModelCall, runModelCycle as mp2Cycle, correctionGround as mp2Ground, readModelCycle as mp2ReadCycle } from '../src/om/model-call.js';
import { type ProcessResult } from '../src/runtime/process.js';
import { type Revision, Store, type Write } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import type { Graph } from '../src/graph/model.js';
import { writeAddressing, inputDecisionWrite } from '../src/om/addressing.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeQuestionPacket, type QuestionPacketRecord, readQuestionPacket } from '../src/om/question-packet.js';
import { seriesRequestOf, type RepairSeries, openSeries, beginAttempt, completionWorkId } from '../src/om/series.js';
import { recordCall } from '../src/om/call-record.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { prepareLateModelReceipt } from '../src/discovery/model-call-recovery.js';
import { MP3_NOTES, MP3_SCOPES, completionSnapshot, currentPacketWire, e4CannotAnswer, e4Fact, e4Fixture, e4NeedSource, e4Node, ensureFixtureProject, fixtureCheckpoint, fixtureDriver, killFixtureDriver, lp4CeasedStep, lp4Need, lp4Root, mp2Managed, mp2Refused, mp2Step, mp3Carried, mp3Close, mp3Cycle, mp3DecisionOf, mp3Decisions, mp3Open, mp3Origins, mp3Readings, mp3ScopeAttempt, publicRecovery, refusesLiveRecovery, usage, valueOf } from './om-model-call-fixture.js';



test('E4 current admission blocks stale packets, mismatched configs and masqueraded adapters without spawning', async t => {
  for (const change of ['stale', 'config', 'adapter'] as const) {
    const f = e4Fixture(t); f.steps([{ research: e4Fact(f) }]);
    const request = structuredClone(f.request);
    if (change === 'stale') f.environment();
    else if (change === 'config') request.dispatch = { ...request.dispatch, config: reference(f.environment()) };
    else request.dispatch = { ...request.dispatch, adapter: reference(f.store.write({ id: 'fake-adapter:garden', kind: 'dispatch-adapter', expected: 0, value: { protocol: 'pretend-codex' } })) };
    const actual = await runModelCall(f.store, request);
    assert.equal(actual.ok, false); assert.equal(f.sent().length, 0); assert.equal(f.store.list('call-record').length, 0);
  }
});



test('E4 narrowing the questions of an unchanged source read does not manufacture progress', async t => {
  const f = e4Fixture(t, 'node');
  const need = e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]);
  assert.ok(need.questionIds.length > 1);
  f.steps([{ research: need }, { research: { ...need, questionIds: need.questionIds.slice(0, 1) } }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'research-no-progress'); assert.equal(f.sent().length, 2);
  f.restart(); valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
});



test('E4 cycle assembles all node parts after a source continuation with exact coverage and no hidden final call', async t => {
  const f = e4Fixture(t, 'node'), config = f.environment(currentPacketWire(f.packet.value.packet) - 1);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, 'parts');
  const total = packet.value.plan!.assignments.length;
  const answers = Array.from({length: total}, (_, position) => e4Node(f, { ...packet,
    value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>));
  const need = { ...e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]),
    questionIds: (packet.value.packet as {questions: {id: string}[]}).questions.map(question => question.id) };
  f.steps([{ research: need }, ...answers.map(research => ({ research }))]);
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  const cycle = valueOf(await runModelCycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.ok(cycle.assembly); assert.equal(f.sent().length, total + 1);
  const assembly = valueOf(readPartAssembly(f.store, { project: f.project, record: cycle.assembly }));
  assert.equal(assembly.proposal.value.status, 'proposed'); assert.equal(assembly.record.value.results.length, total);
  assert.deepEqual(assembly.proposal.value.fills.map(fill => fill.obligation).sort(), packet.value.plan!.assignments.flatMap(item => item.obligations).sort());
  assert.equal(f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!.value.attempts[0]!.outcome, null);
  const snapshot = f.store.list().map(reference); f.restart();
  valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  assert.deepEqual(valueOf(assembleModelParts(f.store, { project: f.project, results: cycle.record.value.results as Ref[] })).record, assembly.record);
  valueOf(await runModelCycle(f.store, request)); assert.deepEqual(f.store.list().map(reference), snapshot);
});



test('E4 cycle replay accounts a late receipt once before or after the cycle is saved without changing product history', async t => {
  for (const kind of ['fact', 'node'] as const) for (const timing of ['before-cycle', 'after-cycle'] as const) {
    const replayPaths = kind === 'fact' && timing === 'after-cycle' ? ['cycle', 'public-recovery'] as const : ['cycle'] as const;
    for (const replayPath of replayPaths) await t.test(`${kind}: ${timing} via ${replayPath}`, async nested => {
      const f = e4Fixture(nested, kind, 100_000, 0, 30_000), checkpoint = join(f.root, 'late-cycle.json');
      f.steps([{ research: kind === 'fact' ? e4Fact(f) : e4Node(f), usage }]);
      const driver = fixtureDriver(nested, f.database, f.root, 'call', f.request,
        { path: checkpoint, kind: 'om-model-exchange', matches: [], when: 'before' });
      const pending = await fixtureCheckpoint(checkpoint, driver.child);
      assert.equal(pending.pid, driver.child.pid); assert.equal(f.sent().length, 1);
      const exchange = pending.writes!.find(write => write.kind === 'om-model-exchange')!.value as unknown as {
        process: ProcessResult; launchError: null;
      };
      const evidence = { process: exchange.process, launchError: exchange.launchError };
      assert.equal(evidence.process.exitCode, 0); assert.deepEqual(JSON.parse(evidence.process.stdout).usage, usage);
      const dispatch = f.store.list<ModelCall>('model-call')[0]!;
      await killFixtureDriver(driver);
      const recovered = publicRecovery(f.store, f.project, reference(dispatch));
      const completed = f.store.get(f.series.id)!, admitted = f.store.list<{status: string; usage: unknown}>('call-record')[0]!;
      assert.equal(admitted.value.status, 'open'); assert.equal(admitted.value.usage, null);
      assert.equal(f.store.list('om-model-exchange').length, 0);
      const priorCycle = timing === 'after-cycle' ? valueOf(await runModelCycle(f.store, f.request)).record : null;
      if (priorCycle) {
        assert.equal(priorCycle.value.terminal, 'outcome');
        assert.equal(f.store.get<{status: string}>(admitted.id)!.value.status, 'open');
      } else assert.equal(f.store.list('om-model-cycle').length, 0);
      const late = prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence);
      const writeMany = f.store.writeMany.bind(f.store); let stopped = false;
      f.store.writeMany = ((writes, guards) => {
        const committed = writeMany(writes, guards);
        if (!stopped && writes.some(write => write.kind === 'model-late-receipt')) {
          stopped = true; throw new Error('E4 simulated stop after durable late receipt before settlement');
        }
        return committed;
      }) as Store['writeMany'];
      try {
        assert.throws(() => writeGuarded(f.store, { unit: 'E4', target: dispatch.id, writes: late.writes, guards: late.guards }),
          /E4 simulated stop after durable late receipt before settlement/);
      } finally { f.store.writeMany = writeMany; }
      assert.ok(stopped); assert.equal(f.store.list('model-late-receipt').length, 1);
      assert.equal(f.store.get<{status: string}>(admitted.id)!.value.status, 'open');
      f.restart();
      if (priorCycle) {
        const beforeRead = f.store.list();
        const historical = valueOf(readModelCycle(f.store, { project: f.project, record: reference(priorCycle) }));
        assert.equal(historical.last.record.value.om.application, 'recovered');
        assert.deepEqual(f.store.list(), beforeRead, 'Historical reading cannot perform settlement');
        assert.equal(f.store.get<{status: string}>(admitted.id)!.value.status, 'open');
      }
      if (replayPath === 'public-recovery') {
        assert.deepEqual(publicRecovery(f.store, f.project, reference(recovered)), recovered);
        const accounted = f.store.get<{status: string; usage: unknown}>(admitted.id)!;
        assert.equal(accounted.value.status, 'failed'); assert.deepEqual(accounted.value.usage, usage);
      }
      const cycle = valueOf(await runModelCycle(f.store, f.request));
      assert.equal(cycle.record.value.terminal, 'outcome');
      assert.equal(cycle.last.record.value.om.application, 'recovered');
      if (priorCycle) assert.deepEqual(cycle.record, priorCycle, 'Late accounting must not replace the saved cycle');
      const settled = f.store.get<{status: string;usage: unknown}>(admitted.id)!;
      assert.equal(settled.value.status, 'failed'); assert.deepEqual(settled.value.usage, usage);
      assert.equal(f.store.history(admitted.id).length, 2, 'One original admission and one settlement');
      const ledger = f.store.list<{calls: {call: Ref; usage: unknown}[]}>('om-call-ledger')[0]!;
      assert.equal(ledger.value.calls.length, 1); assert.deepEqual(ledger.value.calls[0]!.usage, usage);
      assert.equal(f.store.history(ledger.id).length, 2);
      assert.deepEqual(f.store.get(recovered.id), recovered); assert.deepEqual(f.store.get(f.series.id), completed);
      assert.equal(f.store.history(cycle.record.id).length, 1); assert.equal(f.sent().length, 1);
      assert.deepEqual(f.store.get(late.record.id), late.record);
      const afterSettlement = f.store.list();
      assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) })).record, cycle.record);
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), cycle.last, 'Direct and cycle replay expose the same recovered result');
      assert.deepEqual(publicRecovery(f.store, f.project, reference(recovered)), recovered);
      assert.deepEqual(f.store.list(), afterSettlement);
      f.restart();
      const repeated = valueOf(await runModelCycle(f.store, f.request));
      assert.equal(repeated.repeated, true); assert.deepEqual(repeated.record, cycle.record);
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), repeated.last);
      assert.deepEqual(f.store.list(), afterSettlement); assert.equal(f.sent().length, 1);
    });
  }
});



test('33 H1.0a direct E1 cannot rename or replace the proved E2, and an unpaid admitted step resumes once',async t => {
  const f=e4Fixture(t,'fact',100_000,0,1000,true);
  const payload=f.packet.value.packet as Record<string,Json> & {requestId:string;purpose:'model-research'};
  const request={call:payload.requestId,purpose:payload.purpose,basis:null,block:'garden-consume-block',
    series:reference(f.series),attempt:1,goal:f.series.value.attempts[0]!.goal,dispatch:f.request.dispatch,packet:payload,
    gaps:f.batch.items.flatMap(item=>item.consumers.map(consumer=>({id:item.target,goal:item.target,field:item.field,consumer})))};
  for (const changed of [{...request,call:'forged-call'}, {...request,packet:{...payload,extra:'forged'}},
    {...request,purpose:'model-design' as const}]) {
    const before=f.store.list(); assert.equal(recordCall(f.store,f.project,changed).ok,false);
    assert.deepEqual(f.store.list(),before);
  }
  const admitted=valueOf(recordCall(f.store,f.project,request));
  await t.test('8 E1 without physical claim still holds the barrier',()=>{
    assert.equal(f.store.list('model-call').length,0);assert.equal(completionSnapshot(f).complete,false);
  });
  f.restart(); f.steps([{research:{nonsense:true},usage}]);
  const call=valueOf(await runModelCall(f.store,f.request));
  assert.deepEqual(call.call,reference(admitted.call)); assert.equal(f.sent().length,1);
  const work=completionSnapshot(f);
  valueOf(closeAttempt(f.store,{...seriesRequestOf(f.series.value),attempt:1,
    outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  const before=f.store.list();
  assert.equal(recordCall(f.store,f.project,{...request,call:'new-after-close'}).ok,false);
  assert.deepEqual(f.store.list(),before);
});



test('10 H1.0a recovery of a lost managed owner preserves unknown expense and closes only through explicit G7',async t => {
  const f=e4Fixture(t,'fact',100_000,0,30_000,true), checkpoint=join(f.root,'managed-claimed.json');
  ensureFixtureProject(f.store,f.project); f.steps([{research:e4Fact(f),usage}]);
  const driver=fixtureDriver(t,f.database,f.root,'call',f.request,
    {path:checkpoint,kind:'model-call',matches:[{path:['execution','phase'],value:'claimed'}]});
  await fixtureCheckpoint(checkpoint,driver.child);
  const claimed=f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(completionSnapshot(f).complete,false); refusesLiveRecovery(f.store,f.project,reference(claimed));
  await killFixtureDriver(driver);
  const recovered=publicRecovery(f.store,f.project,reference(claimed));
  assert.equal(recovered.value.error,'process_lost'); assert.equal(recovered.value.usage,null);
  assert.equal(completionSnapshot(f).complete,true);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
  const work=completionSnapshot(f), claim={...seriesRequestOf(f.series.value),attempt:1,
    outcome:{reason:'interrupted' as const,accepting:[],cancelling:[],refusals:work.refusals}};
  valueOf(closeAttempt(f.store,claim)); const before=f.store.list(); f.restart();
  valueOf(readModelCall(f.store,{project:f.project,record:reference(recovered)}));
  valueOf(await runModelCall(f.store,f.request)); valueOf(closeAttempt(f.store,claim));
  assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,0);
  assert.equal(f.store.list('model-call-recovery').length,1);
});



test('C10 H1.0a E1 ledger races protect G7 and a closed owner invalidates its earlier claim guards',async t=>{
  const {prepareCloseAttempt}=await import('../src/om/repeat-gate.js');
  for(const first of ['E1','G7'] as const)await t.test(first,async child=>{
    const f=e4Fixture(child,'fact',100_000,0,1000,true);f.steps([{research:{wrong:true},usage}]);
    valueOf(await runModelCall(f.store,f.request));const work=completionSnapshot(f);
    const address={project:f.project,block:'garden-produce-block',line:1};
    valueOf(openSeries(f.store,{...address,slice:'independent-call',predecessor:null,basis:null}));
    const goal={key:'independent',questions:['another-question'],result:'another-result'};
    const other=valueOf(beginAttempt(f.store,{...address,attempt:1,goal}));
    const request={call:'concurrent-unmanaged-call',purpose:'model-research' as const,basis:null,block:address.block,
      series:reference(other),attempt:1,goal,dispatch:f.request.dispatch,packet:{question:'independent'},
      gaps:[{id:'another-question',goal:'another-question',field:'value',consumer:address.block}]};
    const claim={...seriesRequestOf(f.series.value),attempt:1,outcome:{reason:'off-form' as const,accepting:[],cancelling:[],refusals:work.refusals}};
    if(first==='E1'){
      const prepared=valueOf(prepareCloseAttempt(f.store,claim));
      const second=new Store(f.database);try{valueOf(recordCall(second,f.project,request));}finally{second.close();}
      const stale=writeGuarded(f.store,{unit:'G7',target:f.series.id,writes:prepared.writes,guards:prepared.guards});
      assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.refusal.code,'input_stale');
      assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
      valueOf(closeAttempt(f.store,claim));
    }else{
      const {prepareCompletionCall}=await import('../src/om/model-call.js');
      const oldCall=f.store.list<{call:string;purpose:'model-research';basis:null;block:string;gaps:never[];series:Ref;attempt:number;goal:RepairSeries['attempts'][number]['goal'];dispatch:typeof f.request.dispatch}>('call-record')[0]!.value;
      const claimAdmission=valueOf(prepareCompletionCall(f.store,f.project,{call:oldCall.call,purpose:oldCall.purpose,basis:oldCall.basis,
        block:oldCall.block,gaps:oldCall.gaps,series:oldCall.series,attempt:oldCall.attempt,goal:oldCall.goal,
        dispatch:oldCall.dispatch,packet:f.packet.value.packet as Json}));
      const write=f.store.writeMany.bind(f.store);let closed=false;
      f.store.writeMany=((writes,guards)=>{
        if(!closed&&writes.some(row=>row.kind==='call-record')){
          closed=true;const second=new Store(f.database);try{valueOf(closeAttempt(second,claim));}finally{second.close();}
        }
        return write(writes,guards);
      }) as Store['writeMany'];
      try{valueOf(recordCall(f.store,f.project,request));}
      finally{f.store.writeMany=write;}
      assert.equal(closed,true);
      const stale=writeGuarded(f.store,{unit:'E4',target:'old-claim',writes:[{id:'test:stale-claim',kind:'test',expected:0,value:{}}],guards:claimAdmission.guards});
      assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.refusal.code,'input_stale');
      assert.equal(f.store.get('test:stale-claim'),null);
    }
    const saved=f.store.list();f.restart();valueOf(closeAttempt(f.store,claim));valueOf(recordCall(f.store,f.project,request));
    assert.deepEqual(f.store.list(),saved);assert.equal(f.store.list('call-record').length,2);assert.equal(f.sent().length,1);
  });
});



test('C03 H1.0a original managed opening protects all M6 sources in the same transaction',async t=>{
  const {prepareManagedBeginAttempt}=await import('../src/om/series.js');
  const f=e4Fixture(t);f.steps([{research:{wrong:true},usage}]);valueOf(await runModelCall(f.store,f.request));
  const closed=f.store.get<RepairSeries>(f.series.id)!,goal=closed.value.attempts[0]!.goal;
  valueOf(openSeries(f.store,{project:f.project,block:closed.value.block,line:2,slice:'next-line',predecessor:reference(closed),
    basis:{ground:'inputs-changed',text:'The declared task was revised'}}));
  const request={project:f.project,block:closed.value.block,line:2,attempt:2,goal,
    completion:{routes:reference(f.routes),batches:[f.batch.id]}};
  const prepared=valueOf(prepareManagedBeginAttempt(f.store,request));
  assert.ok(prepared.writes.some(row=>row.kind==='om-completion-owner'));
  assert.ok(prepared.writes.some(row=>row.kind==='om-completion-era'));
  const second=new Store(f.database);try{
    const graph=second.get<Graph>(`graph:${f.project}`)!;
    new ProductEngine(second).graphs.save(f.project,graph.value,graph.revision,'concurrent shared source');
  }finally{second.close();}
  const result=writeGuarded(f.store,{unit:'G7',target:f.project,writes:prepared.writes,guards:prepared.guards});
  assert.equal(result.ok,false);if(!result.ok)assert.equal(result.refusal.code,'input_stale');
  assert.equal(f.store.list('om-completion-owner').length,0);assert.equal(f.store.list('om-completion-era').length,0);
});



test('C47 H1.0b managed M5 completes its own ceased remainder without inventing block participation', async t => {
  const { writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'field', 100_000, 0, 5000, true), before = completionSnapshot(f);
  const root = before.assignments.find(row => row.value.kind === 'root')!;
  valueOf(writeAddressing(f.store, { project: f.project, input: reference(f.input), graph: reference(f.graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project: f.project, input: reference(f.input), graph: reference(f.graph), layers: [],
      decision: { target: 'discovery:encoding', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: reference(before.binding), assignment: reference(root) }));
  assert.equal(ceased.value.cause.kind, 'required-record-replaced'); assert.equal(completionSnapshot(f).complete, true);
  const close = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: [] } };
  const closed = valueOf(closeAttempt(f.store, close)); f.restart(); const history = f.store.list();
  assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
  assert.deepEqual(valueOf(closeAttempt(f.store, close)), closed);
  assert.equal((await runModelCall(f.store, f.request)).ok, false); assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 0);
});



test('LP4 (№2887 row 4, row 9, §6.8, §6.9) a node whose only step ceased on its own ground is ceased by a cycle-step-ceased cause with its assembly remainder: E4 keeps refusing the cycle, the paid need_source is never sent again, the cause and the cessation read back exactly after a restart, and nothing else proves the cause', async t => {
  const { prepareCompletionCause, writeCompletionCessation, readCompletionCause, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'node', 100_000, 0, 5000, true);
  f.steps([{ research: lp4Need(f, f.packet), usage }]);
  const { owner, cease } = await lp4CeasedStep(f), root = lp4Root(f);
  // Row 9: without a proved ground nothing is ceased — neither the step nor its root; a changed environment alone gives the root none.
  assert.deepEqual([valueOf(prepareCompletionCause(f.store, f.project, reference(root))).cause,
    valueOf(prepareCompletionCause(f.store, f.project, owner.assignment)).cause], [null, null]);
  f.environment(90_000);
  assert.equal(valueOf(prepareCompletionCause(f.store, f.project, reference(root))).cause, null);
  const step = cease();
  assert.equal(completionSnapshot(f).complete, false, 'The node still needs its assembly or its own cessation');
  f.restart();
  const work = reference(f.store.get(completionWorkId(f.project, owner.binding.id))!);
  const cause = valueOf(prepareCompletionCause(f.store, f.project, reference(root))).cause!;
  assert.deepEqual(cause, { kind: 'cycle-step-ceased', cessation: reference(step), work }, 'Row 4: the ceased step of its own cycle on the exact work');
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(root) }));
  assert.deepEqual([ceased.value.disposition, ceased.value.remainder, ceased.value.work, ceased.value.cause],
    ['branch-ceased', 'assembly', work, cause]);
  assert.equal(completionSnapshot(f).complete, true);
  const cycle = await runModelCycle(f.store, f.request);
  assert.ok(!cycle.ok && cycle.refusal.code === 'completion_ceased', 'E4 still refuses the cycle of the ceased batch');
  assert.equal(f.sent().length, 1, 'The paid need_source is never sent again');
  f.restart(); const history = f.store.list();
  assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
  valueOf(readCompletionCause(f.store, f.project, reference(root), cause));
  assert.deepEqual(valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(root) })), ceased);
  const later = reference(f.store.get(completionWorkId(f.project, owner.binding.id))!);
  const code = (target: Ref, value: unknown) => { const read = readCompletionCause(f.store, f.project, target, value as never); return read.ok ? 'ok' : read.refusal.code; };
  assert.deepEqual([
    code(reference(root), { kind: 'cycle-step-ceased', cessation: reference(step) }),
    code(reference(root), { ...cause, extra: true }),
    code(reference(root), { ...cause, cessation: reference(ceased) }),
    code(reference(root), { ...cause, work: later }),
    code(owner.assignment, cause),
  ], Array(5).fill('completion_cause_invalid'), 'No missing field, foreign field, a root\'s own cessation, a later work or a resolved target proves it');
  assert.deepEqual(f.store.list(), history, 'Reading and the repeat write nothing'); assert.equal(f.sent().length, 1);
});



test('MP2 (№2968 rows 9, 4) a refused correction ends the cycle by its own diagnostic: no third call and no second correction', async t => {
  const f = mp2Managed(t);
  f.steps([{ research: mp2Refused(f) }, { research: mp2Refused(f) }, { research: e4Node(f) }]);
  const cycle = valueOf(await mp2Cycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'outcome'); assert.equal(f.sent().length, 2);
  const last = mp2Step(f, cycle.record.value.steps[1]!);
  assert.deepEqual(cycle.record.value.diagnostic, last.diagnostic, 'The second refusal is the terminal diagnostic');
  assert.equal(mp2Ground(f.store, f.project, { packet: last.packet, call: last.call, response: last.response!, diagnostic: last.diagnostic! }).eligible, false,
    'The round is spent: the corrected chain has no second correction');
  f.restart(); valueOf(mp2ReadCycle(f.store, { project: f.project, record: reference(cycle.record) }));
});



test('MP2 (№2968 row 10) no correction for what is no repairable answer content: a wrong request id, a control answer, a transport failure, a standalone attempt', async t => {
  const cases: [string, (f: ReturnType<typeof e4Fixture>) => Record<string, unknown>, boolean][] = [
    ['request', f => ({ research: { ...e4Node(f), requestId: 'another-request' } }), true],
    ['cannot', f => ({ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'cannot_answer',
      questionIds: (f.packet.value.packet as { questions: { id: string }[] }).questions.map(question => question.id), reason: 'The fact is unknown.' } }), true],
    ['transport', () => ({ rawStdout: 'not json' }), true],
    ['standalone', f => ({ research: mp2Refused(f) }), false],
  ];
  for (const [name, answer, managed] of cases) {
    await t.test(name, async t => {
      const f = e4Fixture(t, 'node', 100_000, 0, 1000, managed);
      f.steps([answer(f), { research: e4Node(f) }]);
      const cycle = await mp2Cycle(f.store, f.request);
      assert.equal(f.sent().length, 1, `${name}: one call, no correction`);
      assert.ok(!f.store.list<QuestionPacketRecord>('question-packet').some(row => row.value.request.correction), `${name}: no correction packet`);
      if (cycle.ok) assert.equal(cycle.value.record.value.terminal, 'outcome');
    });
  }
});



test('MP2 (№2968 row 11; №3153) reads before and inside the correction carry their material; the round is one for the chain and a read does not renew it — in a first attempt and in a later one standing on a non-empty refusal journal', async t => {
  for (const retry of [false, true]) await t.test(retry ? 'attempt 2 on a non-empty journal' : 'attempt 1', async t => {
    const f = mp2Managed(t, 100_000, retry);
    if (retry) assert.ok(f.packet.value.journal, 'The chain root stands on the journal of the refused attempt');
    writeFileSync(join(f.root, 'e4-more.txt'), 'More context for the correction.');
    const needFirst = e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]);
    const needInside = e4NeedSource(f, [{ action: 'read', path: 'e4-more.txt', media: 'text/plain' }]);
    f.steps([{ research: needFirst }, { research: mp2Refused(f) }, { research: needInside }, { research: e4Node(f) }]);
    const cycle = valueOf(await mp2Cycle(f.store, f.request));
    assert.equal(cycle.record.value.terminal, 'assembled'); assert.equal(f.sent().length, 4);
    const packets = cycle.record.value.steps.map(step => f.store.get<QuestionPacketRecord>(step.packet.id)!.value);
    assert.ok(packets[1]!.request.continuation && packets[2]!.request.correction && packets[3]!.request.continuation);
    assert.equal(packets[3]!.request.correction, undefined, 'A read after the correction is a new immediate edge');
    const delivered = (packet: QuestionPacketRecord) => (packet.packet as { sourceDeliveries?: unknown[] }).sourceDeliveries ?? [];
    assert.equal(delivered(packets[2]!).length, 1, 'The correction keeps the delivered material');
    assert.equal(delivered(packets[3]!).length, 2, 'The read inside the correction adds to it');
    assert.equal(f.store.list('om-read-delivery').length, 2, 'Each read delivered once');
    const last = mp2Step(f, cycle.record.value.steps[3]!);
    assert.equal(last.diagnostic, null);
    if (retry) assert.deepEqual(packets.map(packet => packet.journal), packets.map(() => f.packet.value.journal), 'Every step stands on the chain root\'s saved journal');
  });
});



test('MP2 (№2968 row 13) join inputs are no answer check: a part whose join names only some inputs passes E3 without a correction; only the full assembly judges them', async t => {
  const f = mp2Managed(t);
  const answer = e4Node(f), node = answer.proposal.nodes[0]!;
  answer.proposal.joins = [{ id: 'mp2-partial-join', consumer: node.id, connectors: ['garden-flow'],
    failures: { missing: 'missing input', extra: 'extra input', foreign: 'foreign input', stale: 'stale input', duplicate: 'duplicate input', returnsTo: node.id } }];
  f.steps([{ research: answer }, { research: e4Node(f) }]);
  const cycle = valueOf(await mp2Cycle(f.store, f.request));
  assert.equal(f.sent().length, 1, 'No correction for what only the assembly checks');
  const first = mp2Step(f, cycle.record.value.steps[0]!);
  assert.equal(first.diagnostic, null); assert.ok(first.part, 'E3 accepted the part');
  assert.ok(['assembled', 'parts-invalid'].includes(cycle.record.value.terminal), 'The assembly decides');
  assert.ok(!f.store.list<QuestionPacketRecord>('question-packet').some(row => row.value.request.correction));
});



test('MP3 main scenario, rows 1, 2, 3, 5: one need_source of several reads delivers complete, clipped, outside and missing results with search rows; the next prompt names requested and served; the answer follows', async t => {
  const m = mp3Cycle(t), { f, length } = m;
  const root = f.packet.value.packet as Record<string, any>;
  assert.deepEqual(mp3Readings(root), { contract: 'om-brief-readings/v1', snapshots: [], entries: [] });
  const catalogued = (root.brief.manifest as { source: Ref; length: number; completeness: string }[]).find(row => canonical(row.source) === canonical(reference(m.notes)))!;
  assert.deepEqual([catalogued.length, catalogued.completeness], [length, 'omitted'], 'The catalogue knows the length, not the text');
  const reads = [m.range(0, 9), m.range(length - 5, length + 100), m.range(length + 10, length + 20), m.pointer('/list/9'),
    { action: 'read_context', record: reference(f.input), pointer: '/input/absent' }, { action: 'search', within: 'mp3-notes.txt', query: 'line two' },
    m.range(0, 1, m.empty)];
  f.steps([{ research: m.need(reads), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'outcome'); assert.equal(cycle.last.outcome?.kind, 'fact-candidates');
  const sent = f.sent(); assert.equal(sent.length, 2);
  const next = m.payload(sent[1].requestId); assert.equal(sent[1].prompt, packetPrompt(next, sent[1].requestId));
  const data = new Map((next.sourceDeliveries[0].data as { read: Record<string, any>; data: unknown }[]).map(row => [canonical(row.read), row.data]));
  const at = (read: object) => data.get(canonical(read)) as Record<string, unknown>;
  assert.deepEqual(at(reads[0]!), { contract: 'om-read-result/v1', outcome: 'complete', requested: { start: 0, end: 9 }, length, unit: 'utf16',
    served: { start: 0, end: 9 }, text: MP3_NOTES.slice(0, 9) });
  assert.deepEqual(at(reads[1]!), { contract: 'om-read-result/v1', outcome: 'clipped', requested: { start: length - 5, end: length + 100 }, length,
    unit: 'utf16', served: { start: length - 5, end: length }, text: MP3_NOTES.slice(length - 5) });
  assert.deepEqual(at(reads[2]!), { contract: 'om-read-result/v1', outcome: 'outside', requested: { start: length + 10, end: length + 20 }, length,
    unit: 'utf16', served: null, text: null });
  assert.deepEqual(at(reads[3]!), { contract: 'om-read-result/v1', outcome: 'missing', requested: { pointer: '/list/9' }, missing: '9',
    parent: { pointer: '/list', type: 'array', keys: ['0', '1'], length: 2 } });
  assert.deepEqual(at(reads[4]!), { contract: 'om-read-result/v1', outcome: 'missing', requested: { pointer: '/input/absent' }, missing: 'absent',
    parent: { pointer: '/input', type: 'object', keys: Object.keys((f.input.value as Record<string, any>).input).sort() } });
  assert.deepEqual((at(reads[5]!) as unknown as { line: number; text: string }[]).map(row => [row.line, row.text]), [[2, 'Line two: Кириллица 😀 stays.']]);
  assert.deepEqual(at(reads[6]!), { contract: 'om-read-result/v1', outcome: 'outside', requested: { start: 0, end: 1 }, length: 0, unit: 'utf16',
    served: null, text: null }, 'An empty source is a lawful read with its real length');
  for (const piece of ['"outcome":"clipped"', '"requested":{"end":', '"served":{"end":', '"served":null', '"outcome":"missing"'])
    assert.ok(sent[1].prompt.includes(piece), piece);
  assert.equal(f.store.list('call-record').length, 2);
});



test('MP3 rows 10, 22: a new attempt of the same line and full goal carries the deliveries of earlier managed attempts, after their refusal and after a cycle whose cursor was never saved', async t => {
  const m = mp3Cycle(t, 'fact', 100_000, true), { f } = m, script: Record<string, unknown>[] = [];
  const run = (steps: Record<string, unknown>[]) => { script.push(...steps); f.steps(script); };
  run([{ research: m.need([m.range(0, 9)]), usage }, { research: e4CannotAnswer(f), usage }]);
  valueOf(await runModelCycle(f.store, f.request)); mp3Close(f, 1);
  const second = mp3Open(f, 2), root2 = second.root();
  const readings2 = mp3Readings(root2.value.packet);
  assert.deepEqual(readings2.snapshots.map(row => row.kind === 'attempt' ? [row.ordinal, row.sets.length] : null), [[1, 1]]);
  assert.deepEqual(mp3Decisions(root2.value.packet), ['included']); assert.deepEqual(mp3Origins(root2), [['attempt 1']]);
  assert.deepEqual(mp3Carried(root2).map(item => item.data.text), [MP3_NOTES.slice(0, 9)], 'Row 10: the refusal of attempt 1 did not erase its material');
  // Row 22: attempt 2 delivers another slice, but its cycle cursor is never saved.
  run([{ research: m.need([m.range(20, 30)], root2), usage }, { research: e4CannotAnswer(f), usage }]);
  const write = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(row => row.kind === 'om-model-cycle')) throw Error('stop before cycle cursor');
    return write(writes, guards);
  }) as Store['writeMany'];
  try { await assert.rejects(runModelCycle(f.store, { ...f.request, packet: reference(root2) }), /stop before cycle cursor/); }
  finally { f.store.writeMany = write; }
  assert.equal(f.store.list('om-model-cycle').length, 1, 'Only attempt 1 has a cycle record');
  mp3Close(f, 2);
  const third = mp3Open(f, 3), root3 = third.root();
  assert.deepEqual(mp3Origins(root3), [['attempt 2'], ['attempt 1']], 'The later attempt first');
  assert.deepEqual(mp3Carried(root3).map(item => item.data.text), [MP3_NOTES.slice(20, 30), MP3_NOTES.slice(0, 9)]);
  const sends = f.sent().length, before = f.store.list().map(reference);
  f.restart();
  assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root3) })), root3);
  assert.deepEqual(valueOf(writeQuestionPacket(f.store, third.request)).record, root3);
  assert.deepEqual(f.store.list().map(reference), before); assert.equal(f.sent().length, sends);
});


test('MP3 №3190: a file added to the scope before the first selection — of an empty or a non-empty directory — omits the whole search delivery as unconfirmed; the text read is carried; nothing is captured, delivered or sent', async t => {
  for (const [name, files] of MP3_SCOPES) await t.test(name, async t => {
    const { f, search, second } = await mp3ScopeAttempt(t, files);
    writeFileSync(join(f.root, 'scope', 'new.txt'), 'the newneedle is here');
    const counts = () => [f.store.list('om-read-delivery').length, f.store.list('source').length, f.sent().length];
    const before = counts(), root2 = second.root();
    assert.equal(root2.value.state, 'ready');
    assert.equal(mp3DecisionOf(root2, search), 'scope-unconfirmed');
    assert.deepEqual(mp3Decisions(root2.value.packet).sort(), ['included', 'scope-unconfirmed']);
    assert.equal(mp3Carried(root2).some(item => item.read.action === 'search'), false, 'The stale result is not shown as current');
    assert.ok(packetPrompt(root2.value.packet).includes('{"omitted":{"scope-unconfirmed":1}}'), 'The omission is counted');
    assert.deepEqual(counts(), before, 'Nothing is captured, delivered or sent for the carry-over');
    f.restart();
    assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root2) })), root2);
  });
});


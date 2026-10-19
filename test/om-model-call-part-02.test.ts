import test from 'node:test';
import { briefReadings } from '../src/om/packet-brief.js';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashJson, canonical, type Json } from '../src/canonical.js';
import { runModelCycle, runModelCall, readModelCall, type OmModelCall, runModelTransport, readModelApplicationRejection, readManagedModelDiagnostic, readModelCycle, type ReadDeliveryRecord, finishModelAttempt } from '../src/om/model-call.js';
import { type Revision, Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph } from '../src/graph/model.js';
import { withHistoricalReads } from '../src/om/input.js';
import { readRecord } from '../src/om/refs.js';
import { writeQuestionPacket, readQuestionPacket, type QuestionPacketRecord } from '../src/om/question-packet.js';
import { completeAttempt, seriesRequestOf, type RepairSeries } from '../src/om/series.js';
import { prepareFrame, fillObligations, type FrameScope } from '../src/om/frame-obligations.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { recordCall } from '../src/om/call-record.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import { execFileSync } from 'node:child_process';
import { CycleCommitPhase, MP3_EMPTY_SEARCH, MP3_NOTES, completionE1, completionSnapshot, currentPacketWire, cycleCommitPhase, e4Fact, e4Fixture, e4NeedSource, e4Node, mp3Carried, mp3Cycle, mp3Decisions, mp3Origins, mp3Parts, mp3Readings, mp3SearchDelivery, usage, valueOf } from './om-model-call-fixture.js';



test('HASH1 write interception computes each pending writeRef once and drops only exact Refs (№1734, C20 kept)', t => {
  // Counting hashJson calls needs createHash patched BEFORE canonical.js is evaluated — an ESM named import of a
  // builtin binds at load time — so the probe lives in a data-URL --import of a child process running the driver.
  // The preload must reach node:crypto through createRequire: an ESM `import` would snapshot the builtin's
  // facade before the patch lands, while the CJS path leaves the shared exports object mutable for later.
  const preload = `import {createRequire} from 'node:module';
const crypto=createRequire(process.cwd()+'/x.js')('node:crypto');const real=crypto.createHash;
globalThis.__hash1Digested=[];crypto.createHash=a=>{const h=real(a),u=h.update.bind(h);
h.update=(d,e)=>{globalThis.__hash1Digested.push({b:String(d),s:new Error().stack});return u(d,e)};return h};`;
  const driver = fileURLToPath(new URL('../../test/hash1-digests-driver.mjs', import.meta.url));
  const raw = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, driver],
    { encoding: 'utf8', maxBuffer: 40_000_000, timeout: 300_000 });
  const result = JSON.parse(raw.split('\n').find(line => line.startsWith('HASH1_RESULT '))!.slice(13)) as {
    status: string;
    calls: { kinds: string[]; guards: number; refGuards: number; absentGuards: number;
      pendingSurvivors: number; sameIdKept: number; sites: Record<string, number>[]; txn: number[] }[];
  };
  assert.equal(result.status, 'succeeded', '№1734/C20: a dispatch whose pending writeRefs drop out still commits');
  assert.ok(result.calls.length > 0, 'the dispatch wrote through the intercepted store');
  let filtered = 0, manyGuarded = 0;
  for (const call of result.calls) {
    assert.equal(call.pendingSurvivors, 0, `${call.kinds}: no Ref exactly equal to a pending write reached writeMany`);
    assert.ok(call.txn.every(n => n >= 1), `${call.kinds}: every committed value is hashed by the transaction itself`);
    // A pending-ref filter (the C20 interception or externalGuards) digests each pending value once, so its
    // callsite is shared by every write of the batch with count 1. Per-guard hashing would put ~refGuards there.
    const common = Object.keys(call.sites[0] ?? {})
      .filter(site => site !== 'other' && call.sites.every(tally => tally[site] !== undefined));
    for (const site of common) {
      assert.ok(call.sites.every(tally => tally[site] === 1),
        `${call.kinds}: model-call.js:${site} digests a pending value once per write, not once per guard`);
      filtered += 1;
    }
    if (call.refGuards > 50) manyGuarded += 1;
  }
  assert.ok(filtered > 0, 'at least one batch went through a pending-ref filter shared by all its writes');
  assert.ok(manyGuarded > 0, 'the fixture exercised a batch guarded by many Refs');
  assert.ok(result.calls.reduce((n, call) => n + call.sameIdKept, 0) > 0,
    'Refs on pending ids that are not the pending write itself survive the filter (№1734, C20)');
  t.diagnostic(JSON.stringify(result.calls.map(call => ({ kinds: call.kinds, guards: call.guards,
    sameIdKept: call.sameIdKept, sites: call.sites }))));
});



test('E4 missing addressed file can be supplied and resumed without redispatching the saved source request', async t => {
  const f = e4Fixture(t);
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'later.txt', media: 'text/plain' }]) }, { research: e4Fact(f) }]);
  const missing = await runModelCycle(f.store, f.request);
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.refusal.code, 'model_read_unavailable');
  assert.equal(f.sent().length, 1);
  f.restart(); writeFileSync(join(f.root, 'later.txt'), 'The requested encoding is UTF-8.');
  const resumed = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(resumed.record.value.terminal, 'outcome'); assert.equal(f.sent().length, 2);
});



test('E4 preserves received exchange when another Store completes the attempt during dispatch or application', async t => {
  for (const phase of ['before-form', 'application'] as const) for (const kind of ['fact', 'node'] as const) {
    const f = e4Fixture(t, kind);
    f.steps([{ research: kind === 'node' ? e4Node(f) : e4Fact(f), usage }]);
    const get = f.store.get.bind(f.store), writeMany = f.store.writeMany.bind(f.store);
    let completed: Revision<unknown> | null = null;
    const complete = () => {
      const other = new Store(f.database);
      try { completed = valueOf(completeAttempt(other, { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } })); }
      finally { other.close(); }
    };
    f.store.get = ((id, revision) => {
      if (phase === 'before-form' && !completed && f.sent().length && id === f.series.id) complete();
      return get(id, revision);
    }) as Store['get'];
    f.store.writeMany = ((writes, guards) => {
      if (phase === 'application' && !completed && writes.some(write => write.kind === 'part-response')) complete();
      return writeMany(writes, guards);
    }) as Store['writeMany'];
    const actual = valueOf(await runModelCall(f.store, f.request));
    f.store.get = get; f.store.writeMany = writeMany;
    assert.ok(completed); assert.equal(actual.record.value.status, 'failed'); assert.equal(actual.outcome, null);
    assert.equal(actual.diagnostic, null); assert.equal(actual.record.value.om.part, null);
    assert.equal(f.store.list('om-model-exchange').length, 1); assert.equal(f.sent().length, 1);
    const exchange = f.store.list<{process: {stdout: string}}>('om-model-exchange')[0]!;
    assert.deepEqual(JSON.parse(exchange.value.process.stdout).usage, usage);
    assert.deepEqual(f.store.get(f.series.id), completed);
    for (const recordKind of ['part-response', 'part-result', 'layer-proposal']) assert.equal(f.store.list(recordKind).length, 0);
    const call = f.store.list<{usage: typeof usage;status: string}>('call-record')[0]!;
    assert.deepEqual(call.value.usage, usage); assert.equal(call.value.status, 'failed');
    const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
    const saved = f.store.list();
    f.restart();
    assert.deepEqual(valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) })), expected);
    assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), expected);
    assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 1);
  }
});



test('26 H1.0a raw A3 and empty G7 cannot close an unpaid managed root', t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
  const request = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'off-form' as const, achieved: [], cancelled: [], refusals: [] } };
  const raw = completeAttempt(f.store, request as never);
  assert.equal(raw.ok, false);
  if (!raw.ok) assert.equal(raw.refusal.code, 'completion_required');
  const gate = closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'off-form', accepting: [], cancelling: [], refusals: [] } });
  assert.equal(gate.ok, false);
  assert.equal(f.store.get(f.series.id)!.revision, f.series.revision);
});



test('9 H1.0a durable running, received and unapplied work retain the barrier and reuse the original dispatch',async t => {
  for (const phase of ['running','received','applied','missing-work'] as const) await t.test(`${({running:9,received:11,applied:12,'missing-work':32})[phase]} ${phase}`,async t => {
    const f=e4Fixture(t,'fact',100_000,0,1000,true); f.steps([{research:{nonsense:true},usage}]);
    const write=f.store.writeMany.bind(f.store); let stopped=false;
    f.store.writeMany=((writes,guards)=>{
      const reaches=writes.some(row=>row.kind==='model-call' && (row.value as OmModelCall).om?.application===(phase==='missing-work'?'applied':phase));
      if (reaches && phase==='missing-work') {
        assert.ok(writes.some(row=>row.kind==='om-completion-work'),'The real producer writes product and registry atomically');
        // Model the specified recovered prefix: the paid terminal survives, its registry cursor does not.
        const kept=writes.filter(row=>row.kind!=='om-completion-work');
        const result=write(kept,guards); stopped=true; throw new Error(`managed durable ${result.length}`);
      }
      const result=write(writes,guards);
      if (!stopped&&reaches) {stopped=true;throw new Error('managed durable stop');}
      return result;
    }) as Store['writeMany'];
    try { await assert.rejects(runModelCall(f.store,f.request),/managed durable/); }
    finally {f.store.writeMany=write;}
    assert.ok(stopped);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
    if (phase!=='applied') assert.equal(completionSnapshot(f).complete,false);
    f.restart();
    if (phase==='running') {
      const before=f.store.list(); const retry=await runModelCall(f.store,f.request);
      assert.equal(retry.ok,false); if (!retry.ok) assert.equal(retry.refusal.code,'model_call_in_progress');
      assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,0); return;
    }
    const resumed=valueOf(await runModelCall(f.store,f.request));
    assert.equal(resumed.record.value.om.application,'applied'); assert.equal(completionSnapshot(f).complete,true);
    const work=completionSnapshot(f); const claim={...seriesRequestOf(f.series.value),attempt:1,
      outcome:{reason:'off-form' as const,accepting:[],cancelling:[],refusals:work.refusals}};
    valueOf(closeAttempt(f.store,claim)); const before=f.store.list(); f.restart();
    valueOf(await runModelCall(f.store,f.request)); valueOf(closeAttempt(f.store,claim));
    assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,1);
  });
});



test('34 H1.0a analysis of a stopped managed ordinal remains a separate transport and preserves its closed registry',async t=>{
  const f=e4Fixture(t,'fact',100_000,2,1000,true);
  f.steps([{research:{wrong:true},usage},{research:{cause:'fixture observation',hypothesis:true},usage}]);
  valueOf(await runModelCall(f.store,f.request));
  const work=completionSnapshot(f),address=seriesRequestOf(f.series.value);
  valueOf(closeAttempt(f.store,{...address,attempt:3,outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  const series=f.store.get<RepairSeries>(f.series.id)!;assert.ok(series.value.stop);
  const closedWork=f.store.get(work.work.id),packet={task:'Diagnose this exact stop'};
  const admitted=valueOf(recordCall(f.store,f.project,{call:'managed-stop-analysis',purpose:'stop-analysis',
    basis:{kind:'series-stop',series:reference(series),attempt:3},block:series.value.block,
    gaps:[{id:'stop-analysis',goal:'stop-analysis',field:'cause-and-change',consumer:'A6:stop-analysis'}],
    series:reference(series),attempt:3,goal:{key:'stop-analysis',questions:['Why stopped?'],result:'Addressed change'},
    dispatch:f.request.dispatch,packet}));
  const request={project:f.project,call:reference(admitted.call),packet,role:'reviewer' as const};
  const called=valueOf(await runModelTransport(f.store,request));
  assert.equal(called.record.value.transport.version,'om-model-transport/v1');
  assert.equal(called.record.value.transport.completionOwner,undefined);
  f.restart();assert.equal(valueOf(await runModelTransport(f.store,request)).repeated,true);
  assert.deepEqual(f.store.get(work.work.id),closedWork);assert.deepEqual(f.store.get(series.id),series);
  assert.equal(f.sent().length,2);
});



test('33 H1.0b equivalent reconfiguration after receipt applies the same answer with a fresh environment guard',async t=>{
  const f=e4Fixture(t,'fact',100_000,0,1000,true);f.steps([{research:e4Fact(f),usage}]);
  const original=f.store.writeMany.bind(f.store);let moved=false;
  f.store.writeMany=((writes,guards)=>{
    const result=original(writes,guards);
    if(!moved && writes.some(row=>row.kind==='model-call' && (row.value as OmModelCall).om?.application==='received')){
      moved=true; f.environment();
    }
    return result;
  }) as Store['writeMany'];
  const called=valueOf(await runModelCall(f.store,f.request)); f.store.writeMany=original;
  assert.equal(moved,true);assert.equal(called.record.value.om.application,'applied');
  assert.equal(called.diagnostic,null);assert.equal(completionSnapshot(f).complete,false);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
  const saved=f.store.list();f.restart();
  assert.equal(valueOf(await runModelCall(f.store,f.request)).record.value.om.application,'applied');
  assert.deepEqual(f.store.list(),saved);assert.equal(f.sent().length,1);
});



test('35 H1.0b candidate E2 materializations preserve one executable plan selected atomically with E1', async t => {
  const { readCompletionPacketAt } = await import('../src/om/model-call.js');
  for (const kind of ['fact', 'node'] as const) await t.test(kind, async child => {
    const f = e4Fixture(child, kind, 100_000, 0, 5000, true), initial = completionSnapshot(f);
    assert.equal(initial.assignments.length, 1); assert.equal(initial.complete, false);
    const configured = f.environment(90_000), packet = valueOf(writeQuestionPacket(f.store,
      { ...f.packetRequest, environment: reference(configured) })).record;
    const candidates = f.store.list('om-completion-packet'), unselected = completionSnapshot(f);
    assert.equal(candidates.length, 2); assert.equal(unselected.assignments.length, 1);
    assert.equal(unselected.complete, false); assert.equal(f.store.list('call-record').length, 0);
    assert.equal(recordCall(f.store, f.project, completionE1(f)).ok, false);
    const admitted = valueOf(recordCall(f.store, f.project, completionE1(f, packet, configured)));
    const selected = completionSnapshot(f), plan = selected.assignments.map(reference);
    assert.equal(selected.assignments.filter(row => row.value.kind === 'part').length, packet.value.plan?.assignments.length ?? 1);
    assert.equal(selected.complete, false); assert.equal(f.store.list('model-call').length, 0);
    const before = f.store.list();
    valueOf(writeQuestionPacket(f.store, f.packetRequest));
    assert.deepEqual(f.store.list(), before, 'An exact old candidate repeats historically without changing the choice');
    const thirdConfig = f.environment(80_000);
    assert.equal(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(thirdConfig) }).ok, false);
    assert.deepEqual(completionSnapshot(f).assignments.map(reference), plan);
    f.restart();
    for (const row of candidates) valueOf(readCompletionPacketAt(f.store, f.project, reference(row)));
    assert.deepEqual(valueOf(recordCall(f.store, f.project, completionE1(f, packet, configured))).call, admitted.call);
    assert.equal((await runModelCall(f.store, f.request)).ok, false);
    assert.equal(f.sent().length, 0);
  });
});



test('32 H1.0b exact accepted frame ends a required absence and ceases only the selected unclaimed assignment', async t => {
  const { prepareCompletionCause, writeCompletionCessation, readCompletionCause, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  valueOf(recordCall(f.store, f.project, completionE1(f)));
  const before = completionSnapshot(f), assignment = before.assignments.find(row => row.value.kind === 'part')!;
  const frameRequest = structuredClone(f.gapRequest.sources.operations.frame);
  const frame = valueOf(prepareFrame(f.store, frameRequest)), graph = structuredClone(f.fullGraph);
  graph.nodes.find(row => row.id === 'garden-produce-operation')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
  graph.nodes.find(row => row.id === 'garden-consume-operation')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
  graph.connectors.find(row => row.id === 'garden-side-flow')!.bindings.push({ level: 2, producer: { node: 'garden-produce-operation', port: 'out-side' }, consumers: [{ node: 'garden-consume-operation', port: 'in-side' }], anchor: null });
  const projected = projectGraph(graph, 2);
  const fills = valueOf(fillObligations(frame.upper as Graph, frame.scope as FrameScope,
    { graph, reference: { ...reference(f.graph), hash: hashJson(graph) }, frame: null }, frame.upperRef, 2));
  const proposal = f.store.write({ id: `om-proposal:${f.project}:h10b-frame`, kind: 'layer-proposal', expected: 0, value: {
    base: { graph: reference(f.graph), frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(row => row.kind === 'operation'),
    fills: fills.fills.map(row => ({ obligation: row.obligation, node: row.node, ...(row.port === undefined ? {} : { port: row.port }) })),
    localConnectors: projected.connectors.map(row => ({ ...row, bindings: row.bindings.filter(binding => binding.level === 2) })).filter(row => row.bindings.length),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] } });
  const candidate = valueOf(writeCandidate(f.store, { frame: frameRequest, proposals: [reference(proposal)] }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') assert.fail('Full frame must be proposed');
  const accepted = valueOf(settleCandidate(f.store, { project: f.project, level: 2, candidate: reference(candidate.record),
    outcome: { gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  assert.equal(accepted.state, 'accepted');
  const cause = valueOf(prepareCompletionCause(f.store, f.project, reference(assignment))).cause!;
  assert.equal(cause.kind, 'required-absence-ended');
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: reference(before.binding), assignment: reference(assignment) }));
  assert.equal(ceased.value.disposition, 'not-dispatched'); assert.equal(completionSnapshot(f).complete, true);
  f.restart(); const history = f.store.list();
  valueOf(readCompletionCause(f.store, f.project, reference(assignment), cause));
  assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
  assert.equal((await runModelCall(f.store, f.request)).ok, false); assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 0);
});



test('34 H1.0b equivalent preclaim admission guards the current Environment against a second Store', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  const selected = valueOf(recordCall(f.store, f.project, completionE1(f)));
  f.environment(); f.steps([{ research: e4Fact(f), usage }]);
  const write = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(row => row.kind === 'model-call' && (row.value as OmModelCall).status === 'running')) {
      raced = true;
      const other = new Store(f.database);
      try {
        const head = other.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
        const { projectId: _project, ...config } = structuredClone(head.value);
        new ProductEngine(other).environments.configure(f.project, config, head.revision);
      } finally { other.close(); }
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  const first = await runModelCall(f.store, f.request); f.store.writeMany = write;
  assert.equal(raced, true); assert.equal(first.ok, false); if (!first.ok) assert.equal(first.refusal.code, 'input_stale');
  assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-call').length, 0);
  assert.deepEqual(f.store.get(selected.call.id), selected.call);
  assert.equal(f.store.list('om-completion-cessation').length, 0);
  f.restart(); assert.equal(valueOf(await runModelCall(f.store, f.request)).outcome?.kind, 'fact-candidates');
  assert.equal(f.sent().length, 1);
});



test('S1.1 the collected application basis alone proves a rejection: a dispatch adapter that moved during the application is a stale relevant source only through the transparent collector; the rejection reads the same cold, hot, warmed and after restart', async t => {
  const f = e4Fixture(t);
  f.steps([{ research: e4Fact(f), usage }]);
  const adapter = f.request.dispatch.adapter, writeMany = f.store.writeMany.bind(f.store);
  let moved: Revision<unknown> | null = null;
  f.store.writeMany = ((writes, guards) => {
    // Another Store re-registers the dispatch adapter while the application is being written: only the adapter guard moves.
    if (!moved && writes.some(write => write.kind === 'part-response')) {
      const other = new Store(f.database);
      try {
        const current = other.get(adapter.id)!;
        moved = other.write({ id: adapter.id, kind: current.kind, expected: current.revision, value: { ...(current.value as Record<string, unknown>), registered: 'again' } });
      } finally { other.close(); }
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const actual = valueOf(await runModelCall(f.store, f.request));
  f.store.writeMany = writeMany;
  assert.ok(moved); assert.equal(actual.record.value.status, 'failed'); assert.ok(actual.record.value.om.rejection);
  const rejection = actual.record.value.om.rejection!;
  const read = () => valueOf(readModelApplicationRejection(f.store, { project: f.project, record: rejection }));
  const cold = read();
  assert.equal(cold.failure.code, 'input_stale');
  assert.equal(cold.record.value.completion, null, 'No completion: the adapter guard alone proves the rejected class');
  assert.ok(cold.record.value.guards.some(ref => canonical(ref) === canonical(adapter)), 'The admitted adapter is a guard of the rejected application');
  assert.deepEqual(cold.record.value.heads.find(row => row.id === adapter.id)!.head, reference(moved!), 'The observed head is the re-registered adapter');
  const hot = withHistoricalReads(() => { read(); return read(); });
  const warmed = withHistoricalReads(() => {
    valueOf(readQuestionPacket(f.store, { project: f.project, record: f.request.packet }));
    valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
    return read();
  });
  assert.deepEqual(hot, cold); assert.deepEqual(warmed, cold);
  f.restart();
  assert.deepEqual(read(), cold);
});



// Current E3 rejects cross-domain labels before delivery; MP2 allows exactly one correction.
test('LP3 current E3 rejects a context search label before any delivery, repeats one paid call exactly, and settles one failed correction; lawful source search and context reading still deliver', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  const need = e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' },
    { action: 'search', within: reference(f.input), query: 'question' }]);
  f.steps([{ research: need, usage }, { research: need, usage }]);
  const first = valueOf(await runModelCall(f.store, f.request));
  assert.ok(first.diagnostic && first.response && first.record.value.om.failure);
  assert.deepEqual([first.record.value.om.failure.code, first.record.value.om.failure.at.field], ['answer_label_unknown', 'reads/1/within']);
  const diagnostic = valueOf(readManagedModelDiagnostic(f.store, completionSnapshot(f).binding, first.diagnostic));
  assert.deepEqual([diagnostic.request.packet, diagnostic.request.call, diagnostic.request.response, diagnostic.request.code],
    [f.request.packet, first.call, first.response, 'answer_label_unknown']);
  assert.equal(f.sent().length, 1);
  assert.deepEqual(f.store.list('om-read-delivery'), [], 'No read was performed, including the lawful read before the bad label');
  const paid = f.store.list(); f.restart();
  assert.deepEqual(valueOf(readModelCall(f.store, { project: f.project, record: reference(first.record) })).record, first.record);
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)).record, first.record);
  assert.deepEqual(f.store.list(), paid); assert.equal(f.sent().length, 1, 'Replaying the paid refusal never sends again');

  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'outcome');
  assert.equal(cycle.record.value.steps.length, 2);
  assert.deepEqual(cycle.record.value.steps[0]!.record, reference(first.record));
  assert.equal(f.sent().length, 2, 'The failed correction is sent once, with no third call');
  assert.deepEqual([cycle.last.record.value.om.failure?.code, cycle.last.record.value.om.failure?.at.field],
    ['answer_label_unknown', 'reads/1/within']);
  assert.ok(cycle.last.diagnostic && cycle.last.response);
  const secondDiagnostic = valueOf(readManagedModelDiagnostic(f.store, completionSnapshot(f).binding, cycle.last.diagnostic));
  assert.deepEqual([secondDiagnostic.request.packet, secondDiagnostic.request.call, secondDiagnostic.request.response],
    [cycle.record.value.steps[1]!.packet, cycle.last.call, cycle.last.response]);
  assert.deepEqual(f.store.list('om-read-delivery'), []);
  const work = completionSnapshot(f); assert.equal(work.complete, true); assert.ok(work.refusals.length);
  const saved = f.store.list(); f.restart();
  assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) })).record, cycle.record);
  assert.deepEqual(valueOf(await runModelCycle(f.store, f.request)).record, cycle.record);
  assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 2);

  const g = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  const contextRead = { action: 'read_context', record: reference(g.input), pointer: '/input/questions/0/question' };
  const sourceRead = { action: 'search', within: reference(g.source), query: 'UTF' };
  g.steps([{ research: e4NeedSource(g, [contextRead, sourceRead]), usage }, { research: e4Fact(g), usage }]);
  const lawful = valueOf(await runModelCycle(g.store, g.request));
  assert.equal(lawful.record.value.terminal, 'outcome'); assert.equal(g.sent().length, 2);
  const deliveries = g.store.list<ReadDeliveryRecord>('om-read-delivery');
  assert.equal(deliveries.length, 2);
  const at = (read: object) => deliveries.find(row => canonical(row.value.read as Json) === canonical(read as unknown as Json))!.value.data;
  assert.deepEqual(at(contextRead), { contract: 'om-read-result/v1', outcome: 'complete',
    requested: { pointer: contextRead.pointer }, value: g.input.value.input.questions[0]!.question });
  assert.deepEqual(at(sourceRead), g.source.value.content.split(/\r?\n/).flatMap((text, index) =>
    text.toLowerCase().includes('utf') ? [{ source: reference(g.source), line: index + 1, text }] : []));
});



test('LP3 current E3 refusal cannot be assigned reads-invalid, and a lawful need-source cannot be closed with a fabricated read refusal', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  f.steps([{ research: e4NeedSource(f, [{ action: 'search', within: reference(f.input), query: 'question' }]), usage }]);
  const call = valueOf(await runModelCall(f.store, f.request));
  assert.deepEqual([call.record.value.om.failure?.code, call.record.value.om.failure?.at.field], ['answer_label_unknown', 'reads/0/within']);
  const basis = { project: f.project, packet: f.request.packet, call: call.call, response: call.response! };
  const scope = reference(f.input), read = readRecord(f.store, scope, { unit: 'E4', target: scope.id, idPrefix: 'source:' + f.project + ':', kind: 'source' });
  assert.ok(!read.ok);
  const before = f.store.list();
  // The early E3 refusal supplies no proof of a later reads-invalid terminal, even with another record as evidence.
  const foreign = finishModelAttempt(f.store, { ...basis, code: read.refusal.code, message: read.refusal.message, reason: 'refused', evidence: [reference(f.source)] });
  assert.ok(!foreign.ok && foreign.refusal.code === 'completion_invalid');
  assert.deepEqual(f.store.list(), before, 'Nothing is written');
  const g = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  g.steps([{ research: e4NeedSource(g, [{ action: 'search', within: reference(g.source), query: 'UTF' }]), usage }]);
  const lawful = valueOf(await runModelCall(g.store, g.request));
  assert.equal(lawful.outcome?.kind, 'need-source', 'The positive control was genuinely admitted by current E3');
  const lawfulBefore = g.store.list();
  const claimed = finishModelAttempt(g.store, { project: g.project, packet: g.request.packet, call: lawful.call, response: lawful.response!,
    code: 'record_foreign', message: read.refusal.message, reason: 'refused', evidence: [reference(g.source)] });
  assert.ok(!claimed.ok && claimed.refusal.code === 'completion_invalid', 'A performable read gives no such ground');
  assert.deepEqual(g.store.list(), lawfulBefore);
});



test('MP3 rows 9, 18: a new part carries the proven deliveries of the preceding part chain as a fixed set; every packet keeps the root era and no carried read becomes another edge', async t => {
  const m = mp3Cycle(t, 'node'), { f } = m, config = f.environment(currentPacketWire(f.packet.value.packet) - 1);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  assert.equal(packet.value.plan!.mode, 'parts'); const total = packet.value.plan!.assignments.length; assert.ok(total >= 2);
  const answers = Array.from({ length: total }, (_, position) => e4Node(f, { ...packet,
    value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>));
  f.steps([{ research: m.need([m.range(0, 9)], packet), usage }, ...answers.map(research => ({ research, usage }))]);
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  const cycle = valueOf(await runModelCycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.equal(f.sent().length, total + 1, 'No call is added for carried reads');
  const steps = cycle.record.value.steps.map(step => valueOf(readQuestionPacket(f.store, { project: f.project, record: step.packet })));
  for (const step of steps) assert.ok(briefReadings(step.value.packet), 'Row 18: every packet of the chain keeps the root era');
  const [root, continuation, ...parts] = steps;
  assert.ok(continuation!.value.request.continuation); assert.deepEqual(mp3Readings(continuation!.value.packet).entries, []);
  for (const [index, part] of parts.entries()) {
    assert.equal(part.value.request.continuation, undefined, 'A carried read is no continuation edge');
    assert.equal(part.value.request.previous.length, index + 1);
    assert.deepEqual(mp3Readings(part.value.packet).snapshots, [{ kind: 'packet', packet: reference(index ? parts[index - 1]! : continuation!) }]);
    assert.deepEqual(mp3Origins(part), [['part 0']]); assert.deepEqual(mp3Decisions(part.value.packet), ['included']);
    assert.deepEqual(mp3Carried(part).map(item => item.data.text), [MP3_NOTES.slice(0, 9)]);
  }
  assert.ok(root);
  f.restart();
  for (const step of steps) assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(step) })), step);
});


test('MP3 №3171: the same reads in the first part — the next part carries the empty search with the text read and the node assembles; reopen reads every step back unchanged', async t => {
  const { m, f, packet, total, at, request, steps } = mp3Parts(t);
  mkdirSync(join(f.root, 'empty-search'));
  f.steps([{ research: m.need([MP3_EMPTY_SEARCH, m.range(0, 9)], packet), usage }, ...Array.from({ length: total }, (_, index) => ({ research: e4Node(f, at(index)), usage }))]);
  const cycle = valueOf(await runModelCycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.equal(f.sent().length, total + 1);
  const all = steps(cycle), next = all[2]!, empty = mp3SearchDelivery(f);
  assert.equal(next.value.request.previous.length, 1);
  const carried = mp3Readings(next.value.packet).entries.find(entry => entry.origins.some(origin => origin.delivery.id === empty.id))!;
  assert.deepEqual(carried.sources, []); assert.deepEqual(carried.origins.map(origin => origin.kind), ['part']);
  f.restart();
  for (const step of all) assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(step) })), step);
});



test('MP3 row 17: a stop after each saving transition of an addressed read cycle resumes exactly — one send per call, one settlement each, one delivery set', async t => {
  const script = (m: ReturnType<typeof mp3Cycle>) => [{ research: m.need([m.range(0, 9), m.range(m.length + 1, m.length + 5), m.pointer('/list/9')]), usage },
    { research: e4Fact(m.f), usage }];
  const phases: CycleCommitPhase[] = [];
  {
    const m = mp3Cycle(t), { f } = m; f.steps(script(m));
    const write = f.store.writeMany.bind(f.store);
    f.store.writeMany = ((writes, guards) => { const committed = write(writes, guards); if (writes.length) phases.push(cycleCommitPhase(writes)); return committed; }) as Store['writeMany'];
    try { valueOf(await runModelCycle(f.store, f.request)); } finally { f.store.writeMany = write; }
  }
  assert.ok(phases.includes('deliveries') && phases.includes('continuation') && phases.at(-1) === 'cycle');
  for (const [index, phase] of phases.entries()) {
    if (phase === 'running' || phase === 'authorized') continue;
    await t.test(`stop after transaction ${index + 1}: ${phase}`, async nested => {
      const m = mp3Cycle(nested), { f } = m; f.steps(script(m));
      const write = f.store.writeMany.bind(f.store);
      let count = 0;
      f.store.writeMany = ((writes, guards) => {
        const committed = write(writes, guards);
        if (writes.length && count++ === index) throw new Error('MP3 simulated stop');
        return committed;
      }) as Store['writeMany'];
      try { await assert.rejects(runModelCycle(f.store, f.request), /MP3 simulated stop/); } finally { f.store.writeMany = write; }
      f.restart();
      const resumed = valueOf(await runModelCycle(f.store, f.request));
      assert.equal(resumed.record.value.terminal, 'outcome'); assert.equal(f.sent().length, 2, 'Each call is sent once');
      const calls = f.store.list<{ status: string; usage: unknown }>('call-record');
      assert.equal(calls.length, 2);
      for (const call of calls) { assert.equal(call.value.status, 'succeeded'); assert.deepEqual(call.value.usage, usage); }
      assert.equal(f.store.list('om-read-delivery-set').length, 1); assert.equal(f.store.list('om-read-delivery').length, 3);
      const snapshot = f.store.list(); f.restart();
      assert.equal(valueOf(await runModelCycle(f.store, f.request)).repeated, true);
      assert.deepEqual(f.store.list(), snapshot); assert.equal(f.sent().length, 2);
    });
  }
});


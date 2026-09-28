import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './synthesis-session-fixture.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { researchAction } from '../src/discovery/research-protocol.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import { withInvocationAllowance } from '../src/discovery/invocation-progress.js';
import { activeSynthesisNotes, consolidatedProposal, consolidationNeeded } from '../src/discovery/conclusion-consolidation.js';
import { compactConclusions } from '../src/discovery/continuation-packet.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import type { Question } from '../src/discovery/discovery.js';
import type { ModelCall } from '../src/runtime/model-usage.js';

test('growing notes consolidate once with exact citations and unresolved items, history survives, and the same fragment resumes', async t => {
  const f = await fixture(t, 18000, 100000, 0.35, 0, {}, 45000);
  await assert.rejects(withInvocationAllowance(1, f.invoke), { code: 'research_call_allowance' });
  const after = f.store.get<any>(f.before.id)!;
  assert.equal(after.value.offset, f.before.value.offset); assert.equal(after.value.materialOffset, f.before.value.materialOffset);
  assert.deepEqual(after.value.notes.slice(0, 3), f.notes); assert.equal(after.value.notes.length, 4);
  assert.deepEqual(f.store.get(f.before.id, f.before.revision), f.before);
  const active = activeSynthesisNotes(after.value.notes); assert.equal(active.length, 1);
  const summary = active[0]!; assert.deepEqual(summary.consolidated!.replaces, f.notes.map(n => n.checkpoint));
  assert.equal(summary.proposal.action, 'checkpoint'); if (summary.proposal.action !== 'checkpoint') throw Error();
  assert.deepEqual(summary.proposal.citations, (f.notes[0]!.proposal as any).citations);
  assert.deepEqual(summary.proposal.unresolved, ['Keep unresolved-0', 'Keep unresolved-1', 'Keep unresolved-2', 'New conflict remains open']);
  const saved = f.store.get<any>(summary.checkpoint.id)!;
  assert.equal(saved.value.status, 'unassessed'); assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'open');
  const wire = f.wires().find(w => w.subject.dispatchMode === 'consolidation')!; assert.equal(wire.subject.continuation.kind, 'continuation');
  assert.ok(JSON.stringify(wire).length <= f.pilot.value.maxContinuationChars!);
  assert.equal(wire.subject.materialPage, undefined); assert.equal(wire.subject.core, undefined);
  assert.equal(wire.subject.contextWorkspace, undefined); assert.equal(wire.subject.synthesisMaterials, undefined);
  assert.ok(wire.prompt.includes('citationIds'));
  const calls = f.store.list<ModelCall>('model-call'); assert.equal(calls.length, f.setupCalls + 1);
  assert.ok(calls.every(c => c.value.purpose === 'analyst' && c.value.usage?.inputTokens === 10));
  const next = JSON.parse((await previewResearch(f.invoke)).input).subject;
  assert.equal(next.dispatchMode, 'synthesis'); assert.equal(next.materialPage.offset, f.before.value.materialOffset);
  assert.equal(next.materialPage.text, JSON.stringify(f.material).slice(f.before.value.materialOffset, next.materialPage.end));
  assert.ok(next.materialPage.end > f.before.value.materialOffset); assert.equal(next.conclusions.length, 1);
  assert.ok(!JSON.stringify(next.conclusions).includes('0'.repeat(500)));
  assert.equal(consolidationNeeded(after.value.notes, { ...f.pilot.value, conclusionShare: 0.001 }), false, 'No new page means no second paid consolidation');
});

test('coverage, missing fields, foreign note indexes and citation substitution fail without accepting a summary', async t => {
  const f = await fixture(t, 20);
  const good: any = { action: 'checkpoint', question: f.question.id, value: {
    summaries: [{ notes: [0, 1, 2], text: 'All conditions remain distinct' }], citationIds: [0] }, citations: [], unresolved: [] };
  assert.equal(consolidatedProposal(researchAction(good), f.question.id, f.notes).action, 'checkpoint');
  assert.throws(() => researchAction({ ...good, value: {} }), { code: 'research_checkpoint_empty' });
  assert.throws(() => consolidatedProposal(researchAction({ ...good, value: { ...good.value, summaries: [] } }), f.question.id, f.notes), { code: 'consolidation_response_invalid' });
  const { unresolved: _, ...answer } = { ...good, action: 'answer', citations: (f.notes[0]!.proposal as any).citations };
  assert.throws(() => consolidatedProposal(researchAction(answer), f.question.id, f.notes), { code: 'consolidation_response_invalid' });
  for (const indexes of [[0, 1], [0, 1, 99], [0, 1, 1, 2]]) {
    assert.throws(() => consolidatedProposal(researchAction({ ...good, value: { ...good.value, summaries: [{ notes: indexes, text: 'Missing or foreign' }] } }), f.question.id, f.notes),
      { code: 'consolidation_coverage_invalid' });
  }
  for (const ids of [[], [1], [0, 0], ['0']]) {
    assert.throws(() => consolidatedProposal(researchAction({ ...good, value: { ...good.value, citationIds: ids } }), f.question.id, f.notes),
      { code: 'consolidation_citations_invalid' });
  }
  assert.equal(f.store.get<any>(f.before.id)!.value.notes.length, 3); assert.equal(f.store.list('model-call').length, f.setupCalls);
});

test('an unfit next fragment triggers consolidation even below the configurable share, without raising any ceiling', async t => {
  const f = await fixture(t, 1500, 30000, 0.95);
  assert.equal(consolidationNeeded(f.notes, f.pilot.value), false);
  let found = false;
  for (let chars = 12000; chars < 15000; chars += 100) {
    f.context.request = { immutableCondition: 'x'.repeat(chars) };
    try {
      const packet = JSON.parse((await previewResearch(f.invoke)).input).subject;
      if (packet.dispatchMode === 'consolidation') { found = true; break; }
    } catch (error) {
      if (!(error instanceof EngineError && ['pilot_core_limit','research_context_capacity'].includes(error.code))) throw error;
    }
  }
  assert.ok(found, 'The actual packer must reach the fragment-not-fit path');
  await assert.rejects(withInvocationAllowance(1, f.invoke), { code: 'research_call_allowance' });
  const packet = JSON.parse((await previewResearch(f.invoke)).input).subject;
  assert.equal(packet.dispatchMode, 'synthesis'); assert.ok(packet.materialPage.end > f.before.value.materialOffset);
  assert.equal(f.store.get(f.pilot.id)!.revision, f.pilot.revision); assert.equal(f.store.list('research-limit').length, 0);
});

test('a paid summary that misses its goal but fits the actual packet continues without another compaction', async t => {
  // The summary is produced by a real paid consolidation whose text overshoots
  // the capacity goal, yet the next synthesis packet still fits (№1555 X30).
  const f = await fixture(t, 18000, 100000, 0.35, 12000, {}, 45000);
  assert.equal((await f.invoke()).action, 'pause');
  const calls = f.store.list('model-call').length;
  assert.equal(f.wires().filter(w => w.subject.dispatchMode === 'consolidation').length, 1);
  const after = f.store.get<any>(f.before.id)!;
  assert.deepEqual(after.value.notes.slice(0, 3), f.notes); assert.equal(after.value.notes.length, 4);
  const active = activeSynthesisNotes(after.value.notes); assert.equal(active.length, 1);
  assert.ok(active[0]!.consolidated!.targetChars! < JSON.stringify(compactConclusions(active).items).length);
  assert.equal(after.value.notices.length, 1); assert.equal(after.value.notices[0].code, 'consolidation_target_exceeded');
  assert.equal((await f.invoke()).action, 'pause');
  assert.equal(f.store.list('model-call').length, calls + 1, 'the fitting packet never buys a second compaction');
  assert.equal(f.wires().filter(w => w.subject.dispatchMode === 'consolidation').length, 1);
  const packet = JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(packet.subject.dispatchMode, 'synthesis'); assert.ok(JSON.stringify(packet).length <= 100000);
});

test('a non-fitting paid summary gets one tightening and then the fitting material packet continues', async t => {
  const f=await fixture(t,12000,60000,0.35,0,{},9000);
  writeFileSync(f.path,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(join(f.root,'wire.ndjson'))},JSON.stringify(r)+'\\n');
const chars=c.consolidation.tightening?14000:42000,research=c.dispatchMode==='consolidation'?{action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'X'.repeat(chars)}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]}:{action:'pause',reason:'Tightened packet fits'};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  await assert.rejects(withInvocationAllowance(2,f.invoke),{code:'research_call_allowance'});
  const session=f.store.get<any>(f.before.id)!;
  assert.equal(f.store.list('model-call').length,f.setupCalls+2);
  assert.deepEqual(session.value.notes.slice(0,3),f.notes);
  const active=activeSynthesisNotes(session.value.notes);assert.equal(active.length,1);
  assert.deepEqual(active[0]!.consolidated!.tightenedFrom,session.value.notes[3].checkpoint);
  const compactions=f.wires().filter(w=>w.subject.dispatchMode==='consolidation');assert.equal(compactions.length,2);
  assert.ok(compactions[1].subject.consolidation.tightening.deficitChars>0);
  const next=JSON.parse((await previewResearch(f.invoke)).input);
  assert.equal(next.subject.dispatchMode,'synthesis');assert.ok(JSON.stringify(next).length<=60000);
});

test('an oversized notes-only input stops before payment and never increases transport limits', async t => {
  const f = await fixture(t, 40000);
  await assert.rejects(f.invoke(), { code: 'consolidation_input_limit' });
  assert.equal(f.store.list('model-call').length, f.setupCalls); assert.deepEqual(f.store.get(f.before.id), f.before);
});

test('paid consolidation has the same explicit recovery door across the checkpoint/session write window', async t => {
  const f = await fixture(t, 18000, 100000, 0.35, 0, {}, 45000), original = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!injected && writes.some(write => write.kind === 'synthesis-session' && write.value.notes.length === 4)) {
      injected = true; throw new EngineError('fixture_consolidation_crash', 'Paid summary survived, session write was interrupted');
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(), { code: 'fixture_consolidation_crash' }); f.store.writeMany = original;
  const call = f.store.list<ModelCall>('model-call').find(c => JSON.parse(f.store.get<any>(c.value.request.record!.id)!.value.text).subject.dispatchMode === 'consolidation')!;
  const before = f.store.get<any>(f.before.id)!;
  const command = { type: 'recover-research-response' as const, project: 'p', call: reference(call), session: reference(before) };
  const receipt = await f.engine.execute(command) as any;
  assert.equal(receipt.value.state, 'applied'); assert.deepEqual(await f.engine.execute(command), receipt);
  assert.equal(f.store.list('model-call').length, f.setupCalls + 1);
  assert.equal(f.store.get<any>(before.id)!.value.materialOffset, before.value.materialOffset);
  assert.equal(f.store.get<any>(before.id)!.value.notes.length, 4);
  const next = JSON.parse((await previewResearch(f.invoke)).input).subject;
  assert.equal(next.dispatchMode, 'synthesis'); assert.equal(next.materialPage.offset, before.value.materialOffset);
});

test('conclusionShare must be a proper fraction and cannot masquerade as a transport ceiling', async t => {
  const f = await fixture(t, 20);
  for (const share of [0, -1, 1, 2, '0.35']) {
    const { projectId: _, ...settings } = f.pilot.value;
    assert.throws(() => configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings, conclusionShare: share }, f.pilot.revision), { code: 'reader_pilot_invalid' });
  }
  assert.deepEqual(f.store.get(f.pilot.id), f.pilot);
});

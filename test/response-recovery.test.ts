import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { preparedFeatures } from './product-fixture.js';
import { configureReaderPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { pilotContext } from '../src/discovery/pilot-context.js';
import { readResearchContext } from '../src/discovery/research-limits.js';
import { researchAction } from '../src/discovery/research-protocol.js';
import { synthesisSession, readSynthesisSession } from '../src/discovery/synthesis-session.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import { assessmentSession } from '../src/discovery/assessment-session.js';
import type { ResponseRecovery } from '../src/discovery/response-recovery.js';
import type { Revision } from '../src/storage/store.js';
import { digest, hashJson } from '../src/canonical.js';
import { processStart } from '../src/runtime/process-identity.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import type { Question } from '../src/discovery/discovery.js';
import type { ModelCall } from '../src/runtime/model-usage.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-synthesis-replay-')), store = new Store(join(root, 'db.sqlite')), engine = new ProductEngine(store, 'codex');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); preparedFeatures(engine, 'p');
  const path = join(root, 'fixture.mjs');
  writeFileSync(path, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));const research=r.subject.role==='assess-answer'?{verdict:'supported',reasons:[]}:{action:'checkpoint',question:r.subject.question.id,value:{note:'Keep this context-only metadata; no repository claim is accepted'},citations:[],unresolved:['Compose the final supported answer after the remaining pages']};console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [path] };
  const environment = engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 3000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 60000, maxReplyChars: 10000, maxCalls: 10, maxReportedTokens: 100000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  const material = readResearchContext(store, draft, question.id, pilot, reference(store.get('graph-layer:p:1')!), '/projection/title');
  const context = { ...pilotContext(store, draft, question), workingSelections: [{ kind: 'context', value: material }] };
  const invoke = () => synthesisSession(store, draft, question, environment, pilotEnvironment(environment.value, pilot.value), pilot, context, 'Return the declared research action');
  const recover = (call: Revision<ModelCall>, session = store.list<any>('synthesis-session')[0]!) =>
    engine.execute({ type: 'recover-research-response', project: 'p', call: reference(call), session: reference(session) }) as Promise<Revision<ResponseRecovery>>;
  return { root, store, engine, draft, question, pilot, context, invoke, recover, environment };
}

/** Previous-era history (№1555 X29): a genuine v1-id session record at this
 * exact basis. The era router continues it by the legacy producer contract, so
 * the recovery-door checks below exercise the era they were written for. */
function legacySeed(f: ReturnType<typeof fixture>) {
  const materials = [...(f.context.workingSelections ?? [])];
  const id = `synthesis-session:${hashJson([reference(f.question), reference(f.environment), f.draft.value.inputs, materials, null, null])}`;
  f.store.write({ id, kind: 'synthesis-session', expected: 0, value: { projectId: 'p', offset: 0, notes: [], result: null,
    binding: { draft: reference(f.draft), question: reference(f.question), environment: reference(f.environment), inputs: f.draft.value.inputs } } });
}

test('an explicitly uncited checkpoint is unassessed control state, while final answers and deltas still require citations', () => {
  assert.equal(researchAction({ action: 'checkpoint', question: 'q', value: { note: 'context' }, citations: [], unresolved: [] }).action, 'checkpoint');
  assert.throws(() => researchAction({ action: 'answer', question: 'q', value: {}, citations: [] }), { code: 'research_response_invalid' });
  assert.throws(() => researchAction({ action: 'answer_delta', question: 'q', base: { id: 'g', revision: 1, hash: 'a'.repeat(64) }, upserts: {}, removes: {}, citations: [] }), { code: 'research_response_invalid' });
  assert.throws(() => researchAction({ action: 'checkpoint', question: 'q', value: {}, unresolved: [] }), { code: 'research_response_invalid' });
  for (const value of [null, '', '  ', [], {}]) assert.throws(() => researchAction({ action: 'checkpoint', question: 'q', value, citations: [], unresolved: [] }),
    { code: 'research_checkpoint_empty' });
  assert.equal(researchAction({ action: 'checkpoint', question: 'q', value: {}, citations: [], unresolved: ['A concrete unresolved question'] }).action, 'checkpoint');
});

async function interruptCheckpoint(f: ReturnType<typeof fixture>, afterCheckpoint = false) {
  const original = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!injected && writes.some(write => afterCheckpoint ? write.kind === 'synthesis-session' && write.value.notes.length > 0 : write.kind === 'research-checkpoint')) {
      injected = true; throw new EngineError('fixture_checkpoint_crash', 'Interrupt after response persistence, before cursor application');
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(), { code: 'fixture_checkpoint_crash' }); f.store.writeMany = original;
  assert.equal(f.store.list('model-call').length, 1);
  return f.store.list<ModelCall>('model-call')[0]!;
}

test('a saved paid checkpoint resumes once across both storage windows without another generation or invented evidence', async t => {
  for (const afterCheckpoint of [false, true]) {
    const f = fixture(t); legacySeed(f); const call = await interruptCheckpoint(f, afterCheckpoint);
    const before = f.store.list<any>('synthesis-session')[0]!; assert.equal(before.value.offset, 0); assert.equal(before.value.notes.length, 0);
    const response = f.store.get<any>(call.value.response!.record!.id)!;
    const recovered = await f.recover(call, before);
    const session = f.store.list<any>('synthesis-session')[0]!, checkpoint = f.store.list<any>('research-checkpoint')[0]!;
    assert.equal(session.value.offset, 1); assert.equal(session.value.notes.length, 1); assert.equal(session.value.result, null);
    assert.deepEqual(recovered.value.call, reference(call)); assert.deepEqual(recovered.value.sessionAfter, reference(session));
    assert.equal(recovered.value.declaredBy, 'codex');
    assert.equal(checkpoint.value.status, 'unassessed'); assert.deepEqual(checkpoint.value.observations, []);
    assert.deepEqual(checkpoint.value.proposal, JSON.parse(response.value.text).research);
    assert.equal(f.store.list('research-checkpoint').length, 1); assert.equal(f.store.list('model-call').length, 1);
    assert.deepEqual(f.store.get(call.id), call); assert.deepEqual(f.store.get(response.id), response);
    assert.deepEqual(await f.recover(call, before), recovered);
    await assert.rejects(f.recover(call, session), { code: 'response_recovery_cursor_stale' });
    const next = await previewResearch(f.invoke);
    assert.equal(JSON.parse(next.input).subject.synthesisState.offset, 1);
    assert.equal(f.store.list<any>('synthesis-session')[0]!.value.notes.length, 1, 'An advanced cursor must not consume the same paid page again');
    assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'open', 'A checkpoint never accepts a question');
    assert.throws(() => f.engine.discovery.evidence.observe('p', reference(checkpoint), { kind: 'json-pointer', pointer: '' }));
  }
});

test('foreign paid response envelopes are refused without cursor movement or another model call', async t => {
  const f = fixture(t), call = await interruptCheckpoint(f), response = f.store.get<any>(call.value.response!.record!.id)!;
  const payload = JSON.parse(response.value.text); payload.requestId = 'another-request'; const text = JSON.stringify(payload);
  const changed = f.store.write({ id: response.id, kind: response.kind, expected: response.revision, value: { ...response.value, text } });
  f.store.write({ id: call.id, kind: call.kind, expected: call.revision, value: { ...call.value,
    response: { ...call.value.response, chars: text.length, bytes: Buffer.byteLength(text), record: reference(changed) } } });
  await assert.rejects(f.recover(f.store.get<ModelCall>(call.id)!), { code: 'response_recovery_wire_foreign' });
  assert.equal(f.store.list<any>('synthesis-session')[0]!.value.offset, 0); assert.equal(f.store.list('model-call').length, 1);
});

test('a changed question cannot receive a saved checkpoint from its prior revision', async t => {
  const f = fixture(t), call = await interruptCheckpoint(f);
  f.store.write({ id: f.question.id, kind: f.question.kind, expected: f.question.revision,
    value: { ...f.question.value, spec: { ...f.question.value.spec, prompt: 'A changed contract' } } });
  await assert.rejects(f.recover(call), { code: 'response_recovery_binding_stale' });
  assert.equal(f.store.list('model-call').length, 1); assert.equal(f.store.list('research-checkpoint').length, 0);
});

test('recovery is explicit and changed profiles, foreign hashes or sessions cannot consume a paid reply', async t => {
  const f = fixture(t); legacySeed(f); const call = await interruptCheckpoint(f), session = f.store.list<any>('synthesis-session')[0]!;
  await previewResearch(f.invoke);
  assert.equal(f.store.list('research-response-recovery').length, 0); assert.equal(f.store.get<any>(session.id)!.value.offset, 0);
  await assert.rejects(f.engine.execute({ type: 'recover-research-response', project: 'p', call: { ...reference(call), hash: '0'.repeat(64) }, session: reference(session) }) as Promise<unknown>,
    { code: 'response_recovery_call_foreign' });
  await assert.rejects(f.engine.execute({ type: 'recover-research-response', project: 'p', call: reference(call), session: { ...reference(session), id: 'foreign-session' } }) as Promise<unknown>,
    { code: 'response_recovery_session_stale' });
  f.store.write({ id: f.pilot.id, kind: f.pilot.kind, expected: f.pilot.revision, value: f.pilot.value });
  await assert.rejects(f.recover(call, session), { code: 'response_recovery_call_foreign' });
  assert.equal(f.store.list('model-call').length, 1);
});

test('the same operator mechanism reprocesses an assessor response through normal verdict validation', async t => {
  const f = fixture(t), source = f.engine.discovery.evidence.document('p', 'basis', 'The intended local result', 'text/plain', 0);
  const context = { ...f.context, role: 'assess-answer', value: { design: 'A local result' },
    observations: [f.engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: source.value.content.length })] };
  const invoke = () => assessmentSession(f.store, f.draft, f.question, f.environment, pilotEnvironment(f.environment.value, f.pilot.value), f.pilot, context, 'Assess the actual proposal');
  const original = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!injected && writes.some(write => write.kind === 'assessment-session' && write.value.result !== null)) {
      injected = true; throw new EngineError('fixture_assessment_crash', 'Interrupt after paid response, before verdict storage');
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(invoke(), { code: 'fixture_assessment_crash' }); f.store.writeMany = original;
  const call = f.store.list<ModelCall>('model-call')[0]!, session = f.store.list<any>('assessment-session')[0]!;
  const result = await f.recover(call, session);
  assert.equal(result.value.state, 'applied'); assert.equal(f.store.get<any>(session.id)!.value.result.verdict, 'supported');
  assert.equal((await invoke() as any).verdict, 'supported'); assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'open');
});

test('changed notes, workspace or archived materials cannot be applied to an unchanged cursor', async t => {
  for (const field of ['notes', 'focus'] as const) {
    const f = fixture(t); legacySeed(f); const call = await interruptCheckpoint(f), session = f.store.list<any>('synthesis-session')[0]!;
    const changed = f.store.write({ id: session.id, kind: session.kind, expected: session.revision, value: { ...session.value,
      [field]: field === 'notes' ? [{ proposal: 'different findings' }] : f.context.workingSelections[0]!.value } });
    await assert.rejects(f.recover(call, changed), { code: 'response_recovery_cursor_stale' });
    assert.equal(f.store.list('model-call').length, 1); assert.equal(f.store.list('research-response-recovery').length, 0);
  }
  const f = fixture(t); legacySeed(f); const call = await interruptCheckpoint(f), archive = f.store.get<any>(call.value.packet!.archive.id)!;
  const body = structuredClone(archive.value); body.body.synthesisMaterials[0].value.value = 'foreign material';
  const changedArchive = f.store.write({ id: archive.id, kind: archive.kind, expected: archive.revision, value: body });
  const request = f.store.get<any>(call.value.request.record!.id)!, wire = JSON.parse(request.value.text);
  wire.subject.working.archive = reference(changedArchive); const text = JSON.stringify(wire);
  const changedRequest = f.store.write({ id: request.id, kind: request.kind, expected: request.revision, value: { ...request.value, text } });
  const changedCall = f.store.write<ModelCall>({ id: call.id, kind: call.kind, expected: call.revision, value: { ...call.value,
    packet: { ...call.value.packet!, archive: reference(changedArchive) },
    request: { ...call.value.request, record: reference(changedRequest), hash: digest(text), chars: text.length, bytes: Buffer.byteLength(text) } } });
  await assert.rejects(f.recover(changedCall), { code: 'response_recovery_page_foreign' });
  assert.equal(f.store.list('model-call').length, 1);
});

test('a concurrent dispatch in the receipt write window cannot advance the recovered session', async t => {
  const f = fixture(t); legacySeed(f); const call = await interruptCheckpoint(f), session = f.store.list<any>('synthesis-session')[0]!;
  const original = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!injected && writes.some(write => write.kind === 'research-response-recovery')) {
      injected = true; const counter = f.store.list<any>('question-dispatch')[0]!;
      original([{ id: counter.id, kind: counter.kind, expected: counter.revision, value: { ...counter.value, serial: counter.value.serial + 1 } }]);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.recover(call, session), { code: 'input_stale' }); f.store.writeMany = original;
  assert.deepEqual(f.store.get(session.id), session); assert.equal(f.store.list('research-response-recovery').length, 0);
  const recovered = await f.recover(call, session);
  assert.equal(recovered.value.state, 'applied'); assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('research-checkpoint').length, 1);
});

test('a running normal consumer is not replaced, while a dead consumer leaves an explicit recovery door', async t => {
  const f = fixture(t), call = await interruptCheckpoint(f);
  const run = f.store.write<{ projectId: string; draftId: string; status: string; owner: { pid: number; started: string } }>({ id: `research-run:${hashJson(['p', f.draft.id])}`, kind: 'research-run', expected: 0,
    value: { projectId: 'p', draftId: f.draft.id, status: 'running', owner: { pid: process.pid, started: processStart(process.pid) } } });
  await assert.rejects(f.recover(call), { code: 'response_recovery_consumer_running' });
  f.store.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, owner: { pid: process.pid, started: 'a different process incarnation' } } });
  assert.equal((await f.recover(call)).value.state, 'applied'); assert.equal(f.store.list('model-call').length, 1);
});

/* ==== D8.4b — строки 44–45 и replay новой эры (договор №1499) ==== */

test('44 a legacy session keeps its own contract and the operator replay applies a v2 paid response on its exact terms', async t => {
  // Legacy era: a genuine v1-id history record (legacySeed) keeps the old
  // producer — no intents, no v2 marker, and a public repeat re-pays by the
  // old contract (№1555 X29: прежняя эра проверяется явно прежней фикстурой).
  const legacy = fixture(t); legacySeed(legacy);
  const restoreLegacy = legacy.store.writeMany.bind(legacy.store);
  let legacyInterrupted = false;
  legacy.store.writeMany = ((writes: any[], guards: any[] = []) => {
    const rows = restoreLegacy(writes, guards);
    if (!legacyInterrupted && writes.some(write => write.kind === 'model-response')) {
      legacyInterrupted = true;
      throw new EngineError('fixture_legacy_crash', 'Interrupt after response persistence');
    }
    return rows;
  }) as typeof legacy.store.writeMany;
  await assert.rejects(legacy.invoke(), { code: 'fixture_legacy_crash' });
  legacy.store.writeMany = restoreLegacy;
  const legacySession = legacy.store.list<any>('synthesis-session')[0]!;
  assert.ok(!legacySession.id.startsWith('synthesis-session:v2:'));
  assert.equal(legacySession.value.contract, undefined);
  await assert.rejects(legacy.invoke(), { code: 'synthesis_no_progress' });
  assert.equal(legacy.store.list('research-consumer-intent').length, 0, 'no intent machinery in the legacy era');
  assert.ok(legacy.store.list('model-call').length >= 2, 'the legacy contract re-pays the unsaved application');

  // New era: the same operator command consumes the exact paid response once.
  const f = fixture(t);
  const answerSource = f.engine.discovery.evidence.document('p', 'd84b-answer-basis', 'A grounded answer basis', 'text/plain', 0);
  writeFileSync(join(f.root, 'fixture.mjs'), `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
const research=c.role==='assess-answer'?{verdict:'supported',reasons:[]}:(c.conclusions??[]).length===0?{action:'checkpoint',question:c.question.id,value:{note:'First page findings'},citations:[],unresolved:['More remains']}:{action:'answer',question:c.question.id,value:{note:'Complete grounded answer'},citations:[${JSON.stringify({ source: reference(answerSource), selector: { kind: 'text-range', start: 0, end: 24 } })}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const invokeV2 = (db = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, pilotEnvironment(f.environment.value, f.pilot.value), db.get<any>(f.pilot.id)!,
    f.context, 'Return the declared research action', undefined, { delivery: null });
  const original = f.store.writeMany.bind(f.store);
  let injected = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    const rows = original(writes, guards);
    if (!injected && writes.some(write => write.kind === 'model-response')) {
      injected = true;
      throw new EngineError('fixture_checkpoint_crash', 'Interrupt after response persistence, before cursor application');
    }
    return rows;
  }) as typeof f.store.writeMany;
  await assert.rejects(invokeV2(), { code: 'fixture_checkpoint_crash' });
  f.store.writeMany = original;
  const call = f.store.list<ModelCall>('model-call')[0]!;
  const session = f.store.list<any>('synthesis-session')[0]!;
  assert.ok(session.id.startsWith('synthesis-session:v2:'));
  assert.equal(session.value.contract, 'synthesis-session/v2');
  assert.equal(session.value.offset, 0);
  const command = { type: 'recover-research-response' as const, project: 'p', call: reference(call), session: reference(session) };
  const receipt = await f.engine.execute(command) as any;
  assert.equal(receipt.value.state, 'applied');
  assert.equal(f.store.get<any>(session.id)!.value.offset, 1);
  assert.equal(f.store.get<any>(session.id)!.value.notes.length, 1);
  assert.equal(f.store.list('model-call').length, 1, 'the operator replay never buys a new call');
  assert.deepEqual(await f.engine.execute(command), receipt, 'the applied replay repeats as itself');
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'applied');
  const replayed = await invokeV2(f.store);
  assert.equal(replayed.action, 'answer', 'the applied step resumes into the next lawful step');
  assert.equal(f.store.list('model-call').length, 2, 'only the genuinely next step is paid');
});

test('45 a v2 session without its producer marker or lawful transition is an integrity refusal, never a legacy fallback', async t => {
  const f = fixture(t);
  const answerSource = f.engine.discovery.evidence.document('p', 'd84b-answer-basis', 'A grounded answer basis', 'text/plain', 0);
  writeFileSync(join(f.root, 'fixture.mjs'), `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
const research=c.role==='assess-answer'?{verdict:'supported',reasons:[]}:(c.conclusions??[]).length===0?{action:'checkpoint',question:c.question.id,value:{note:'First page findings'},citations:[],unresolved:['More remains']}:{action:'answer',question:c.question.id,value:{note:'Complete grounded answer'},citations:[${JSON.stringify({ source: reference(answerSource), selector: { kind: 'text-range', start: 0, end: 24 } })}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const invokeV2 = (db = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, pilotEnvironment(f.environment.value, f.pilot.value), db.get<any>(f.pilot.id)!,
    f.context, 'Return the declared research action', undefined, { delivery: null });
  const result = await invokeV2();
  assert.equal(result.action, 'answer');
  const session = f.store.list<any>('synthesis-session')[0]!;
  assert.equal(session.value.contract, 'synthesis-session/v2');
  const { contract: _contract, ...stripped } = f.store.get<any>(session.id)!.value;
  f.store.write({ id: session.id, kind: 'synthesis-session', expected: session.revision, value: stripped });
  await assert.rejects(invokeV2(), { code: 'synthesis_session_invalid' });
  const stillProven = readSynthesisSession(f.store, reference(f.store.get<any>(session.id, session.revision)!));
  assert.equal(stillProven.value.contract, 'synthesis-session/v2', 'the proven revision keeps its own era');
  // A forged fresh session whose address does not match its basis.
  const bogus = structuredClone(stripped);
  bogus.basis = { ...bogus.basis, previousProposal: { action: 'answer', question: f.question.id, value: { note: 'forged' } } };
  f.store.write({ id: `synthesis-session:v2:${hashJson(['bogus'])}`, kind: 'synthesis-session', expected: 0, value: bogus });
  assert.throws(() => readSynthesisSession(f.store,
    reference(f.store.get<any>(`synthesis-session:v2:${hashJson(['bogus'])}`)!)), { code: 'synthesis_session_invalid' });
});

test('X27 the v2 operator replay confirms a proven application once and rejects an arbitrary head', async t => {
  const f = fixture(t);
  const answerSource = f.engine.discovery.evidence.document('p', 'x27-answer-basis', 'A grounded answer basis', 'text/plain', 0);
  writeFileSync(join(f.root, 'fixture.mjs'), `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
const research=c.role==='assess-answer'?{verdict:'supported',reasons:[]}:(c.conclusions??[]).length===0?{action:'checkpoint',question:c.question.id,value:{note:'First page findings'},citations:[],unresolved:['More remains']}:{action:'answer',question:c.question.id,value:{note:'Complete grounded answer'},citations:[${JSON.stringify({ source: reference(answerSource), selector: { kind: 'text-range', start: 0, end: 24 } })}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const invokeV2 = (db = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, pilotEnvironment(f.environment.value, f.pilot.value), db.get<any>(f.pilot.id)!,
    f.context, 'Return the declared research action', undefined, { delivery: null });
  assert.equal((await invokeV2()).action, 'answer',
    'the v2 loop drives the checkpoint and the complete answer in one entry');
  const session = f.store.list<any>('synthesis-session')[0]!;
  const answerCall = f.store.list<ModelCall>('model-call').at(-1)!;
  const intent = f.store.list<any>('research-consumer-intent').find(row => row.value.call?.id === answerCall.id)!;
  assert.equal(intent.value.state, 'applied');
  const revisionsBefore = f.store.get<any>(session.id)!.revision;
  // The operator command names the exact pre-application state of the step.
  const command = { type: 'recover-research-response' as const, project: 'p',
    call: reference(answerCall), session: intent.value.owner as never };
  const receipt = await f.engine.execute(command) as any;
  assert.equal(receipt.value.state, 'applied');
  assert.deepEqual(receipt.value.sessionBefore, intent.value.owner);
  assert.deepEqual(receipt.value.sessionAfter, intent.value.outputs.find((output: Ref) => output.id === session.id));
  assert.equal(f.store.get<any>(session.id)!.revision, revisionsBefore, 'confirming a proven A is not a second application');
  assert.equal(f.store.list('model-call').length, 2, 'no new payment');
  assert.deepEqual(await f.engine.execute(command), receipt, 'an exact repeat returns the same receipt without a new record');
  assert.equal(f.store.list('research-response-recovery').length, 1);
  // An arbitrary current head is not the proven before-state of the step.
  await assert.rejects(f.engine.execute({ type: 'recover-research-response', project: 'p',
    call: reference(answerCall), session: reference(f.store.get<any>(session.id)!) }) as Promise<unknown>,
    { code: 'response_recovery_session_stale' });
  assert.equal(f.store.list('research-response-recovery').length, 1);
  // A foreign call has no receipt either.
  const foreign = { id: 'model-call:consumer:v1:never-existed', revision: 1, hash: '0'.repeat(64) };
  await assert.rejects(f.engine.execute({ type: 'recover-research-response', project: 'p',
    call: foreign, session: intent.value.owner }) as Promise<unknown>,
    (error: unknown) => error instanceof EngineError && error.code === 'response_recovery_call_foreign');
  assert.equal(f.store.list('research-response-recovery').length, 1);
});

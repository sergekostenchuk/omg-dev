import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { proveAttempt } from '../src/discovery/v7-plan-questions.js';
import { readResearchConsumerIntent, consumerIntentContext, preparationBinding, CONSUMER_INTENT_V2,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { CONTEXT_PREPARATION_CONTRACT, CONTEXT_PREPARATION_KIND, ARCHIVE_PARTS_CONTRACT, readPreparationRecord, prepareContextPreparation,
  readPreparedContext, readArchiveBody, type ContextPreparation } from '../src/discovery/request-parts.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import { researchContextReadEra } from '../src/discovery/research-limits.js';
import { repeatedContextRead } from '../src/discovery/research-continuation.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { discoveryFixture, rand, allAxes, questionOf, type PlanQuestion } from './discovery-v7-fixture.js';

// DRS1a2 (пул G; codex-omg №6057/№6196/№7487): the compact storage of an analyst
// call on the standard v7 path. Every record here is written by its real
// producer — the plan acceptance chain, the runner, the intent producer, the
// paid call and its application; the model is a controlled adapter process.

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, 'omg-drs1a2-');
type Fixture = ReturnType<typeof fixture>;
const validFrame = (): Json => ({ productType: 'internal', scale: '30 users across 10 sites',
  industries: ['construction'], domains: ['materials supply', 'equipment accounting'], axes: allAxes('deep'),
  budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } });
const planQuestion = (id: string, axis: string, cls = 'supporting'): PlanQuestion => ({ id, axis, domain: 'construction',
  text: `What covers ${id}?`, class: cls, criterion: `Named basis answering ${id}`, requiredDepth: 'deep',
  roles: ['domain expert'], searchPlaces: ['domain documents'] });
const validPlan = (frame: Ref, questions: PlanQuestion[], edition = 1, previous: Ref | null = null): Json =>
  ({ edition, frame, previous, questions }) as unknown as Json;
function acceptPlan(f: Fixture, project: string, questions: PlanQuestion[]) {
  const base = createPartialV7Draft(f.discovery, project, 'concept');
  const src = f.discovery.evidence.document(project, 'basis', `Exact source for ${project}`, 'text/plain', 0);
  const frame = questionOf(f.store, base, 'frame');
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, 'plan');
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, questions), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
function acceptNextPlanEdition(f: Fixture, project: string, draft: Revision<DiscoveryDraft>, frameRef: Ref,
  previous: Ref, questions: PlanQuestion[]) {
  const planQ = questionOf(f.store, f.store.get<DiscoveryDraft>(draft.id)!, 'plan');
  f.discovery.reopen(planQ.id, planQ.revision);
  const src = f.discovery.evidence.document(project, `basis-${rand()}`, `Source ${rand()}`, 'text/plain', 0);
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!, f.store.get<Question>(planQ.id)!,
    validPlan(frameRef, questions, 2, previous), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(draft.id)!, plan, planAnswer: plan.value.answer! };
}
const ended = (type = 'impossible') => ({ action: 'answer', question: '$selected',
  value: { type, code: 'source_unavailable', evidence: [], text: 'No accessible source' }, citations: [] });
/** A reply that reads the call's own working archive by its exact address. */
const readOwnArchive = { action: '$readOwnArchive' };

async function setup(t: test.TestContext, questions = [planQuestion('block', 'industry', 'blocking')], calibrated = true) {
  const f = fixture(t); f.engine.execute({ type: 'create-project', project: 'p', title: 'P' });
  const wire = join(f.root, 'wire.ndjson'), settings = join(f.root, 'reply.json'), adapter = join(f.root, 'adapter.mjs');
  const configure = (replies: unknown[] = [], tokens: number | null = 10) => writeFileSync(settings, JSON.stringify({ replies, tokens }));
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
let previous=[];try{previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const ordinal=previous.map(line=>JSON.parse(line)).filter(row=>!row.subject.assessmentSubject).length;
let research=s.replies[ordinal]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.action==='$readOwnArchive')research={action:'read_context',record:r.subject.working.archive,pointer:research.pointer??'/body/role'};
if(research.question==='$selected')research.question=r.subject.question.id;
if(s.terminalConstraint&&research.action==='answer')research.value.evidence=[s.terminalConstraint];
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 const rejected=(r.subject.value?.attempts??[]).flatMap(entry=>entry.end.type==='submitted'?entry.end.value.claims.map((claim,index)=>({claim:{project:packet.project,container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id},reason:'Insufficient corroboration'})):[]);
 research=s.assessmentReply??{verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected,newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
 if(s.terminalConstraint&&research.novelty){research.verdict='supported';research.return=null;research.novelty.noProgress=[];research.novelty.transition={outcome:'unknown',bases:[{constraint:packet.entries[0].attempt}],reason:'Source unavailable',consequence:'The named basis remains unknown',nextAction:'Obtain another source'};}
} 
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,...(s.tokens===null?{}:{usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}})}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command }, reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  const calibrate = async (tokens = 10) => {
    configure([], tokens);
    await researchCall(environment.value.implementer, environment.value, 'Calibrate', {}, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
    configure([ended(), { necessary: true, reason: 'Calibration review' }], tokens);
    await researchCall(environment.value.reviewer, environment.value, 'Calibrate reviewer', {}, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'escalation-assessor' });
    await researchCall(environment.value.reviewer, environment.value, 'Calibrate assessor', {}, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'assessor' });
    configure(); writeFileSync(wire, '');
  };
  if (calibrated) await calibrate();
  configure(); writeFileSync(wire, '');
  const v = acceptPlan(f, 'p', questions);
  let terminalConstraint: Ref | undefined;
  const finishFrontier=()=>{terminalConstraint??=reference(f.discovery.evidence.document('p','terminal-source','The requested source is unavailable','text/plain',0));writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings,'utf8')),terminalConstraint}));};
  const run = (limit = 8, store = f.store, compact = true, policy = true) =>
    new Researcher(store, new Discovery(store), new ProductEngine(store).environments).run('p', v.draft.id, limit, undefined,
      { ...(policy ? { producerPolicy: { discovery: 7 as const } } : {}), ...(compact ? { contextContract: CONTEXT_PREPARATION_CONTRACT } : {}) });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const history = () => canonical(f.store.list().map(reference));
  const intents = (store = f.store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
    .filter(row => row.value.kind === 'analyst' && row.value.draft.id === v.draft.id);
  return { ...f,finishFrontier, v, questions, run, wires, history, configure, environment, calibrate, intents };
}
const failure = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return `${(error as EngineError).code}: ${(error as EngineError).message}`;
  }
  return 'no-error';
};
/** Every saved revision of the given kinds, serialized with its metadata. */
function revisionBytes(store: Store, kinds: string[]): Record<string, { revisions: number; bytes: number }> {
  const out: Record<string, { revisions: number; bytes: number }> = {};
  for (const kind of kinds) {
    out[kind] = { revisions: 0, bytes: 0 };
    for (const head of store.list(kind)) for (const row of store.history(head.id)) {
      out[kind]!.revisions += 1;
      out[kind]!.bytes += Buffer.byteLength(JSON.stringify({ id: row.id, kind: row.kind, revision: row.revision, hash: row.hash, value: row.value }), 'utf8');
    }
  }
  return out;
}

test('DRS1a2 first compact v7 analyst send: no prior preparation, one batch publishes parts + preparation + intent, the call packs a compact archive, the attempt applies; cold repeat buys nothing', async t => {
  const f = await setup(t), write = f.store.writeMany.bind(f.store), publications: string[][] = [];
  f.store.writeMany = ((writes, guards = []) => {
    if (writes.some(w => w.kind === 'research-consumer-intent' && w.expected === 0)) publications.push(writes.map(w => `${w.kind}@${w.expected}`));
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  assert.equal(f.store.list(CONTEXT_PREPARATION_KIND).length, 0, 'the first send starts without a preparation');
  f.configure([ended('refused')]);
 f.finishFrontier();
  const done = await f.run();
  assert.equal(done.value.status, 'completed', JSON.stringify(done.value));
  f.store.writeMany = write;
  assert.equal(f.wires().length, 2);
  assert.equal(f.wires().filter(w => w.subject.assessmentSubject).length, 1);
  // One publication batch carried the new parts, the preparation and the intent, all expected:0.
  assert.equal(publications.length, 1, JSON.stringify(publications));
  assert.ok(publications[0]!.includes('context-preparation@0') && publications[0]!.includes('research-consumer-intent@0')
    && publications[0]!.every(entry => entry.endsWith('@0')), JSON.stringify(publications[0]));
  const [intent] = f.intents();
  assert.equal(intent!.value.contract, CONSUMER_INTENT_V2);
  assert.equal(Object.hasOwn(intent!.value.cursor, 'context'), false, 'a v2 cursor carries no context');
  assert.equal(intent!.value.preparation!.revision, 1);
  const prepared = readPreparedContext(f.store, intent!.value.preparation!, preparationBinding(intent!.value));
  assert.deepEqual(prepared.context['subject'], intent!.value.cursor.subject, 'the preparation holds this exact subject context');
  assert.deepEqual(consumerIntentContext(f.store, intent!.value), prepared.context);
  // Parts are stored once per project and shared: the preflight archive of the same call already holds them.
  const preparationParts = new Set(prepared.preparation.value.parts.map(part => part.id));
  assert.ok([...preparationParts].every(id => f.store.get(id, 1)?.kind === 'request-part'));
  // The paid call packed the compact archive: no whole body is saved for it.
  const call = f.store.get<any>(intent!.value.call!.id)!;
  const archive = f.store.get<any>(call.value.packet.archive.id, call.value.packet.archive.revision)!;
  assert.equal(archive.value.contract, ARCHIVE_PARTS_CONTRACT);
  assert.equal(Object.hasOwn(archive.value, 'body'), false);
  assert.deepEqual(archive.value.subject, intent!.value.cursor.subject);
  assert.equal(readArchiveBody(f.store, archive).body['role'], 'research');
  assert.ok(archive.value.parts.some((part: Ref) => preparationParts.has(part.id)), 'the archive and the preparation share parts');
  assert.equal(f.store.list('research-attempt').length, 1);
  assert.equal(intent!.value.state, 'applied');
  // Cold reopen: the exact reader proves the intent and its preparation; a second run applies nothing new.
  const cold = f.open();
  assert.deepEqual(readResearchConsumerIntent(cold, reference(intent!)).value, intent!.value);
  const saved = f.history(), calls = f.wires().length;
  const again = await f.run(8, cold, false, false);
  assert.equal(again.value.status, 'completed', JSON.stringify(again.value));
  assert.equal(f.wires().length, calls, 'the cold repeat sends nothing');
  assert.equal(f.history(), saved, 'the cold repeat writes nothing');
});

test('DRS1a2 continuation from a compact foundation: the call reads its own compact archive, the next call continues from it, and both direct archive readers find the body (era bounded, repeat key found)', async t => {
  const f = await setup(t);
  f.configure([readOwnArchive, ended()]);
 f.finishFrontier();
  const done = await f.run();
  assert.equal(done.value.status, 'completed', JSON.stringify(done.value));
  const wires = f.wires();
  assert.equal(wires.length, 3);
  assert.equal(wires.filter(w => w.subject.assessmentSubject).length, 1);
  const first = wires[0]!.subject, second = wires[1]!.subject;
  assert.equal(first.continuation.kind, 'initial');
  assert.equal(second.continuation.kind, 'continuation');
  assert.deepEqual(second.continuation.foundation, first.working.archive, 'the continuation stands on the first compact archive');
  const foundation = f.store.get<any>(first.working.archive.id, first.working.archive.revision)!;
  assert.equal(foundation.value.contract, ARCHIVE_PARTS_CONTRACT);
  // The read_context turn read the compact archive by its address (archivedContext restores its body).
  const turns = f.store.list<any>('research-turn').sort((a, b) => a.value.number - b.value.number);
  assert.equal(turns[0]!.value.action.action, 'read_context');
  assert.equal(turns[0]!.value.observation.value, 'research');
  // research-limits:26 — the paid packet's read era: bounded (was legacy: a compact archive has no value.body).
  assert.equal(researchContextReadEra(f.store, first), 'bounded');
  // research-continuation:172 — the repeat key of that read finds the original (was context_missing).
  const planQ = f.store.get<Question>(f.v.plan.id)!;
  assert.doesNotThrow(() => repeatedContextRead(f.store, turns, planQ, 0, turns[0]!.value.observation, turns[0]!.value.action));
  // Cold: the whole chain re-reads without writes or sends.
  const saved = f.history(), calls = f.wires().length;
  const again = await f.run(8, f.open(), false, false);
  assert.equal(again.value.status, 'completed', JSON.stringify(again.value));
  assert.equal(f.wires().length, calls);
  assert.equal(f.history(), saved);
});

/** A read-only Store view that serves a changed value for one exact record —
 * an in-memory input of a structural check; nothing is written. */
function viewWith(store: Store, id: string, change: (value: any) => any): Store {
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return (rid: string, revision?: number) => {
      const row = store.get<any>(rid, revision);
      if (!row || rid !== id) return row;
      const value = change(structuredClone(row.value));
      return { ...row, value, hash: hashJson(value) };
    };
    const member = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
}

test('DRS1a2 subject binding: two plan-questions of one Question and the same id in two plan editions never share a preparation, at write and at read', async t => {
  const f = await setup(t, [planQuestion('block', 'industry', 'blocking'), planQuestion('support', 'market')]);
  f.configure([ended('refused'), ended()]);
  f.finishFrontier();assert.equal((await f.run()).value.status, 'completed');
  const [a, b] = f.intents().sort((x, y) => x.value.cursor.turn - y.value.cursor.turn);
  assert.notEqual(a!.value.cursor.subject.planQuestionId, b!.value.cursor.subject.planQuestionId);
  assert.deepEqual(a!.value.question, b!.value.question, 'one physical plan Question');
  assert.notEqual(a!.value.preparation!.id, b!.value.preparation!.id);
  // Read-time binding (P2-03): a preparation is never accepted for another step.
  assert.match(failure(() => readPreparationRecord(f.store, b!.value.preparation!, preparationBinding(a!.value))),
    /^context_preparation_invalid: .*belongs to another step/);
  // The next plan edition with the same plan-question id is another subject and another preparation.
  const next = acceptNextPlanEdition(f, 'p', f.v.draft, f.v.frameRef, f.v.planAnswer, [planQuestion('block', 'industry', 'blocking')]);
  f.configure([ended()]); writeFileSync(join(f.root, 'wire.ndjson'), '');
  f.finishFrontier();assert.equal((await f.run()).value.status, 'completed');
  const edition2 = f.intents().find(row => canonical(row.value.cursor.subject.planAnswer) === canonical(next.planAnswer))!;
  assert.equal(edition2.value.cursor.subject.planQuestionId, 'block');
  assert.notEqual(edition2.value.preparation!.id, a!.value.preparation!.id);
  assert.match(failure(() => readPreparationRecord(f.store, a!.value.preparation!, preparationBinding(edition2.value))),
    /^context_preparation_invalid: .*belongs to another step/);
  // Parts are project-scoped: the same context of another project names other parts (nothing is written).
  const prepared = readPreparedContext(f.store, a!.value.preparation!, preparationBinding(a!.value));
  const other = prepareContextPreparation(f.store, { ...preparationBinding(a!.value), projectId: 'q' }, prepared.context);
  const own = new Set(prepared.preparation.value.parts.map(part => part.id));
  assert.ok(other.value.parts.every(part => !own.has(part.id)));
});

test('DRS1a2 batch atomicity: a revision_conflict injected inside the publication batch rolls the whole batch back; the repeat publishes against the existing record and pays once', async t => {
  const f = await setup(t), write = f.store.writeMany.bind(f.store);
  const seen: { injected: Write | null; batch: Write[] } = { injected: null, batch: [] };
  f.store.writeMany = ((writes, guards = []) => {
    const preparation = writes.find(w => w.kind === 'context-preparation' && w.expected === 0);
    if (!seen.injected && preparation && writes.some(w => w.kind === 'research-consumer-intent' && w.expected === 0)) {
      seen.injected = preparation; seen.batch = writes;
      write([preparation], []);
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  f.configure([ended()]);
 f.finishFrontier();
  const paused = await f.run();
  const injected = seen.injected as Write | null;
  assert.ok(injected, 'the publication batch carried the new preparation');
  assert.equal(paused.value.status, 'paused');
  assert.equal(paused.value.pauseCode, 'revision_conflict', JSON.stringify(paused.value));
  for (const row of seen.batch.filter(w => w.id !== injected!.id))
    assert.equal(f.store.get(row.id)?.revision ?? 0, row.expected, `${row.kind} ${row.id} was rolled back`);
  assert.equal(f.intents().length, 0);
  assert.equal(f.wires().length, 0, 'nothing was sent');
  f.store.writeMany = write;
  const done = await f.run();
  assert.equal(done.value.status, 'completed', JSON.stringify(done.value));
  // The paused run moved its owner revision, so the repeat is another step with its own preparation;
  // the injected record of the other writer stays untouched at its first revision.
  const [intent] = f.intents();
  assert.equal(f.intents().length, 1);
  assert.equal(intent!.value.preparation!.revision, 1);
  assert.equal(f.store.history(injected!.id).length, 1);
  assert.equal(f.wires().length, 2, 'one analyst and one assessor');
});

test('DRS1a2 budget refusal before the send: the compact intent waits prepared with its preparation, no call; the later run sends that exact intent once', async t => {
  const f = await setup(t, undefined, false);
  f.configure([ended()]);
 f.finishFrontier();
  const paused = await f.run();
  assert.equal(paused.value.status, 'paused', JSON.stringify(paused.value));
  assert.equal(f.wires().length, 0);
  assert.equal(f.store.list('model-call').filter(row => (row.value as any).draftId === f.v.draft.id).length, 0, 'the refusal created no send');
  const [prepared] = f.intents();
  assert.equal(prepared!.value.contract, CONSUMER_INTENT_V2);
  assert.equal(prepared!.value.state, 'prepared');
  await f.calibrate();
  f.configure([ended()]);f.finishFrontier();
  const done = await f.run();
  assert.equal(done.value.status, 'completed', JSON.stringify(done.value));
  assert.equal(f.wires().length, 2);
  const [sent] = f.intents();
  assert.equal(sent!.id, prepared!.id, 'the same compact intent was sent');
  assert.deepEqual(sent!.value.preparation, prepared!.value.preparation);
});

test('DRS1a2 crash after the physical outcome, before the application: the cold repeat applies the paid response by the saved contract without a new call', async t => {
  const f = await setup(t), write = f.store.writeMany.bind(f.store);
  let cut = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!cut && writes.some(w => w.kind === 'research-turn' && w.expected === 0)) { cut = true; throw new Error('cut-application'); }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  f.configure([ended()]);
  const paused = await f.run();
  assert.equal(cut, true);
  assert.equal(paused.value.status, 'paused', JSON.stringify(paused.value));
  f.store.writeMany = write;
  const calls = f.wires().length, ledger = f.store.list('research-budget-ledger');
  assert.equal(calls, 1);
  const done = await f.run(8, f.open(), false, false);
  assert.equal(done.value.status, 'paused', JSON.stringify(done.value));
  assert.equal(done.value.pauseCode, 'research_assessment_pending');
  assert.equal(f.wires().length, calls, 'no new call');
  assert.equal(f.store.list('research-attempt').length, 1);
  const attempt=f.store.list('research-attempt')[0]!;
  const exact=proveAttempt(f.open(),reference(attempt));
  assert.deepEqual(exact.attempt.value.planAnswer,f.v.planAnswer);
  assert.deepEqual(exact.attempt.value.call,f.intents()[0]!.value.call);
  assert.equal(f.store.list('research-attempt-binding').length, 1);
  assert.equal(f.store.list('v7-progress-application').length, 0);
  assert.equal(f.store.list('assessment-session').length, 0);
  const [intent] = f.intents();
  readPreparedContext(f.open(), intent!.value.preparation!, preparationBinding(intent!.value));
  readResearchConsumerIntent(f.open(), reference(intent!));
  const fullHistory = () => canonical(f.store.list().flatMap(row => f.store.history(row.id).map(reference)));
  const saved = fullHistory();
  assert.deepEqual(await f.run(8, f.open(), false, false), done);
  assert.equal(fullHistory(), saved);
  assert.equal(f.wires().length, calls); assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
});

test('DRS1a2 damage and unknown contracts are typed refusals: part, revision, preparation contract, archive contract and intent contract; the whole-body archive reads literally', async t => {
  const f = await setup(t);
  f.configure([ended()]);
  assert.equal((await f.run()).value.status, 'completed');
  const [intent] = f.intents(), binding = preparationBinding(intent!.value), ref = intent!.value.preparation!;
  const preparation = f.store.get<ContextPreparation>(ref.id, 1)!;
  const part = preparation.value.parts[0]!;
  assert.match(failure(() => readPreparedContext(viewWith(f.store, part.id, value => ({ ...value, text: value.text + ' ' })), ref, binding)),
    /^context_part_invalid: /);
  assert.match(failure(() => readPreparedContext(f.store, { ...ref, revision: 2 }, binding)), /^context_preparation_invalid: .*first revision/);
  assert.match(failure(() => readPreparedContext(viewWith(f.store, ref.id, value => ({ ...value, contract: 'context-preparation/v9' })),
    { ...ref, hash: hashJson({ ...preparation.value, contract: 'context-preparation/v9' }) }, binding)), /^context_preparation_invalid: .*unknown contract/);
  assert.match(failure(() => readPreparedContext(viewWith(f.store, ref.id, value => ({ ...value, parts: [...value.parts].reverse() })),
    { ...ref, hash: hashJson({ ...preparation.value, parts: [...preparation.value.parts].reverse() }) }, binding)), /^context_preparation_invalid: |^context_part_invalid: /);
  const call = f.store.get<any>(intent!.value.call!.id)!, archiveRef = call.value.packet.archive as Ref;
  const archive = f.store.get<any>(archiveRef.id, archiveRef.revision)!;
  assert.match(failure(() => readArchiveBody(f.store, { ...archive, value: { ...archive.value, contract: 'archive-parts/v9' },
    hash: hashJson({ ...archive.value, contract: 'archive-parts/v9' }) })), /^archive_parts_invalid: .*unknown contract/);
  const legacy = f.store.list<any>('research-context').find(row => !Object.hasOwn(row.value, 'contract') && row.value.body)!;
  assert.deepEqual(readArchiveBody(f.store, legacy).body, legacy.value.body, 'a whole-body archive reads literally');
  assert.match(failure(() => readResearchConsumerIntent(viewWith(f.store, intent!.id, value => ({ ...value, contract: 'research-consumer-intent/v9' })),
    { ...reference(intent!), hash: hashJson({ ...intent!.value, contract: 'research-consumer-intent/v9' }) })), /^research_consumer_intent_invalid: /);
  assert.match(failure(() => readResearchConsumerIntent(viewWith(f.store, intent!.id, value => ({ ...value, cursor: { ...value.cursor, context: {} } })),
    { ...reference(intent!), hash: hashJson({ ...intent!.value, cursor: { ...intent!.value.cursor, context: {} } }) })), /^research_consumer_intent_invalid: /,
  'a v2 cursor never carries a context of its own');
});

test('DRS1a2 fsck and registry: the store the compact path wrote has no findings; preparation, compact archive and v2 intent name exact references and keep JSON inside parts as data', async t => {
  const f = await setup(t);
  f.configure([readOwnArchive, ended()]);
  assert.equal((await f.run()).value.status, 'completed');
  assert.deepEqual(checkStoreIntegrity(f.store).findings, []);
  const [intent] = f.intents(), preparation = f.store.get<ContextPreparation>(intent!.value.preparation!.id, 1)!;
  const fields = referenceSites(CONTEXT_PREPARATION_KIND, preparation.value).map(site => site.field);
  assert.ok(fields.includes('draft') && fields.includes('question') && fields.includes('owner') && fields.includes('subject.planAnswer')
    && fields.includes('parts[0]'), fields.join(','));
  const intentFields = referenceSites('research-consumer-intent', intent!.value).map(site => site.field);
  assert.ok(intentFields.includes('preparation') && intentFields.includes('cursor.subject.planAnswer'), intentFields.join(','));
  const archive = f.store.list<any>('research-context').find(row => row.value.contract === ARCHIVE_PARTS_CONTRACT)!;
  const archiveFields = referenceSites('research-context', archive.value).map(site => site.field);
  assert.ok(archiveFields.includes('parts[0]') && archiveFields.includes('subject.planAnswer'), archiveFields.join(','));
  const part = f.store.get<any>(preparation.value.parts[0]!.id, 1)!;
  assert.deepEqual(referenceSites('request-part', { ...part.value, text: JSON.stringify(reference(preparation)) }), []);
});

test('DRS1a2 measurement: two identical real scenarios (12 project sources, initial + 4 continuations) — every saved revision of the affected kinds in UTF-8 with metadata, SQLite/WAL separately', async t => {
  const kinds = ['research-context', 'research-consumer-intent', 'context-preparation', 'request-part', 'request-manifest'];
  const measure = async (compact: boolean) => {
    const f = await setup(t);
    for (let i = 0; i < 12; i += 1)
      f.discovery.evidence.document('p', `market-${i}`, `Supply market note ${i}. `.repeat(80), 'text/plain', 0);
    f.configure([...['/body/role', '/body/stage', '/body/subject', '/body/inventory'].map(pointer => ({ ...readOwnArchive, pointer })), ended()]);
    f.finishFrontier();const done = await f.run(8, f.store, compact);
    assert.equal(done.value.status, 'completed', JSON.stringify(done.value));
    assert.equal(f.wires().length, 6);
    assert.equal(f.wires().filter(w => w.subject.assessmentSubject).length, 1);
    const bytes = revisionBytes(f.store, kinds);
    const file = (path: string) => existsSync(path) ? statSync(path).size : 0;
    return { bytes, sqlite: file(f.path), wal: file(`${f.path}-wal`) };
  };
  const whole = await measure(false), compact = await measure(true);
  const total = (m: typeof whole, only: string[]) => only.reduce((sum, kind) => sum + m.bytes[kind]!.bytes, 0);
  t.diagnostic(`whole: ${JSON.stringify(whole)} total=${total(whole, kinds)}`);
  t.diagnostic(`compact: ${JSON.stringify(compact)} total=${total(compact, kinds)}`);
  assert.ok(total(compact, ['research-context']) < total(whole, ['research-context']), 'the compact archives are smaller');
  assert.ok(total(compact, ['research-consumer-intent']) < total(whole, ['research-consumer-intent']), 'the v2 intent revisions carry no context');
  assert.ok(total(compact, kinds) < total(whole, kinds), 'all affected kinds together, parts and preparation included');
});

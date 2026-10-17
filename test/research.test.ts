import { executeWebTurn } from '../src/discovery/web-research.js';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { workingContext } from '../src/discovery/working-context.js';
import { digest, hashJson } from '../src/canonical.js';
import { execFileSync } from 'node:child_process';
import { EngineError } from '../src/errors.js';
import type { Write } from '../src/storage/store.js';
import { readResearchConsumerTurn } from '../src/discovery/response-recovery.js';
import { readBundle, readReaderResultAt, resumeReadBundleIntent, readerResumeStep } from '../src/discovery/reader.js';
import { configureReaderPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { latestFocus } from '../src/discovery/research-continuation.js';
import { synthesisSession, readSynthesisSession } from '../src/discovery/synthesis-session.js';
import { pilotContext, readPilotContext, retainPilotRead } from '../src/discovery/pilot-context.js';
import { preparedFeatures } from './product-fixture.js';
import { UPSTREAM_STAGES } from '../src/discovery/requirements.js';
import type { Question } from '../src/discovery/discovery.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { SOURCE_READ_CONTRACT, SOURCE_READ_CONTRACT_V2, SOURCE_READ_CONTRACT_V3, SOURCE_READ_MAX_CHARS,
  sourceReadRange, sourceReadRangeV2 } from '../src/evidence/evidence.js';
import { projectResearchSearchObservationV2 } from '../src/discovery/research-consumer-transition.js';
import { isRef, reference } from "../src/pipeline/contracts.js";
import type { ResearchRun, ResearchTurn } from "../src/discovery/research-model.js";
import type { FieldSpec } from "../src/discovery/discovery.js";
import { researchInput } from "./preparation-fixture.js";

// Protocol fixture, not a claim of live-model research quality. The assessor's
// controlled responses let the test isolate whether the engine enforces them.
const ADAPTER = `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js',import.meta.url).href)};
import {readFileSync,appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
const req=JSON.parse(readFileSync(0,'utf8')), c=req.subject, scenario=process.argv[2];
if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
if(c.currentRead)c.history=[...(c.history??[]),c.currentRead];
appendFileSync(process.argv[3],c.role+'\\n');
if(scenario==='failure') {process.stderr.write('provider unavailable');process.exit(1)}
const reply=research=>console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));
if(c.role==='assess-answer') {
 if(scenario==='assessor-retry'&&!existsSync(process.argv[3]+'.retry')) {writeFileSync(process.argv[3]+'.retry','started');process.stderr.write('assessor unavailable');process.exit(1)}
 const same=c.observations.some(o=>isDeepStrictEqual(boundDiscoveryValue(c.question.field,o.value,c.discoveryContext),c.value??c.focus?.value??c.observations[0]?.value));
 reply({verdict:scenario==='irrelevant'||!same?'insufficient':'supported',reasons:scenario==='irrelevant'||!same?['The source does not support this requested property']:[]});
} else if(c.role==='assess-escalation') {
 if(scenario==='race') {writeFileSync(process.argv[3]+'.awaiting','started');await new Promise(resolve=>setTimeout(resolve,300));}
 reply({necessary:['missing','race'].includes(scenario),reason:['missing','race'].includes(scenario)?'The owner document contains no selected destination':'The answer is already in the supplied source'});
} else {
 const q=c.questions[0], source=c.inventory.sources[0];
 if(scenario==='premature') reply({action:'need_owner',question:q.id,reason:'Ask the user',searched:[source.ref]});
 else if(['missing','race'].includes(scenario)) {
  if(!c.history.some(t=>t.action.action==='search')) reply({action:'search',query:q.field});
  else reply({action:'need_owner',question:q.id,reason:'Missing owner destination',searched:[source.ref]});
 } else if(scenario==='pause-first' && !c.history.length) reply({action:'read_source',source:source.ref,start:0,end:source.length});
 else {
  const full=c.history.find(t=>t.action.action==='read_source'&&t.action.source.hash===source.ref.hash&&t.action.start===0&&t.action.end===source.length);
  if(source.truncated&&!full) {reply({action:'read_source',source:source.ref,start:0,end:source.length});process.exit(0)}
  const values=JSON.parse(full?full.observation.value:source.excerpt);
  reply({action:'answer',question:q.id,value:boundDiscoveryValue(q.field,values[q.field],c.discoveryContext),citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]});
 }
}`;

function fixture(t: { after(fn: () => void): void }, scenario = "normal") {
  const root = mkdtempSync(join(tmpdir(), "omg-research-"));
  const path = join(root, "adapter.mjs"); writeFileSync(path, ADAPTER);
  const store = new Store(join(root, "state.sqlite")); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const configure = (project: string) => {
    if (!store.get(`project:${project}`)) engine.execute({ type: "create-project", project, title: project });
    const command = { executable: process.execPath, args: [path, scenario, join(root, "calls.txt")] };
    engine.environments.configure(project, { workspace: root,
      implementer: { actor: "researcher", model: "protocol-fixture", effort: "high", command },
      reviewer: { actor: "assessor", model: "protocol-fixture", effort: "high", command },
      fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 2000 }, 0);
  };
  return { root, store, engine, configure };
}

test('RD1 source-read/v2 serves exact bounded UTF-16 windows while v1 and reader ranges keep their era', t => {
  const { engine, configure } = fixture(t); configure('p');
  const content = 'x'.repeat(49_999) + '😀' + 'y'.repeat(9_513);
  const source = reference(engine.discovery.evidence.document('p', 'long', content, 'text/plain', 0));
  const evidence = engine.discovery.evidence;
  for (const size of [49_999, 50_000, 50_001, 59_514]) {
    const reading = evidence.readSource('p', source, { start: 0, end: size }, SOURCE_READ_CONTRACT_V2);
    assert.equal(reading.contract, SOURCE_READ_CONTRACT_V2);
    assert.deepEqual(reading.requested, { start: 0, end: size });
    assert.deepEqual(reading.served, { start: 0, end: Math.min(size, SOURCE_READ_MAX_CHARS) });
    assert.equal(reading.value, content.slice(0, Math.min(size, SOURCE_READ_MAX_CHARS)));
    assert.equal(reading.outcome, size > SOURCE_READ_MAX_CHARS ? 'clipped' : 'complete');
    assert.equal(reading.length, content.length);
    assert.equal(reading.unit, 'utf16');
    assert.equal(evidence.verifyReading(reading), true);
  }
  const first = evidence.readSource('p', source, { start: 0, end: content.length }, SOURCE_READ_CONTRACT_V2);
  const second = evidence.readSource('p', source,
    { start: first.served!.end, end: content.length }, SOURCE_READ_CONTRACT_V2);
  assert.equal(String(first.value) + String(second.value), content);
  assert.deepEqual(second.served, { start: 50_000, end: content.length });
  assert.equal(second.outcome, 'complete');
  const offset = evidence.readSource('p', source, { start: 100, end: 59_514 }, SOURCE_READ_CONTRACT_V2);
  assert.deepEqual(offset.served, { start: 100, end: 50_100 });
  assert.equal(offset.selector?.kind, 'text-range');
  const eof = evidence.readSource('p', source, { start: 59_510, end: 60_000 }, SOURCE_READ_CONTRACT_V2);
  assert.equal(eof.outcome, 'clipped'); assert.deepEqual(eof.served, { start: 59_510, end: content.length });
  const outside = evidence.readSource('p', source, { start: content.length, end: content.length + 1 }, SOURCE_READ_CONTRACT_V2);
  assert.equal(outside.outcome, 'outside'); assert.equal(outside.served, null);
  assert.equal(outside.selector, null); assert.equal(outside.value, null);
  assert.equal(evidence.verifyReading(outside), true);
  assert.equal(evidence.verifyReading({ ...first, served: { start: 1, end: 50_001 } }), false);
  assert.equal(evidence.verifyReading({ ...outside, length: 10 }), false);
  assert.throws(() => evidence.readSource('p', source, { start: 0, end: content.length }), { code: 'research_excerpt_limit' });
  assert.equal(evidence.readSource('p', source, { start: 0, end: 50_000 }).contract, SOURCE_READ_CONTRACT);
  assert.equal(sourceReadRange(content.length, { start: 0, end: content.length }).served?.end, content.length);
  assert.deepEqual(sourceReadRangeV2(Number.MAX_SAFE_INTEGER,
    { start: Number.MAX_SAFE_INTEGER - 100, end: Number.MAX_SAFE_INTEGER }).served,
    { start: Number.MAX_SAFE_INTEGER - 100, end: Number.MAX_SAFE_INTEGER });
  assert.throws(() => sourceReadRangeV2(100, { start: 2, end: 1 }), { code: 'selector_invalid' });
  assert.throws(() => evidence.readSource('p', source, { start: 1, end: 1 }, SOURCE_READ_CONTRACT_V2), { code: 'selector_invalid' });
  assert.throws(() => evidence.readSource('foreign', source, { start: 0, end: 1 }, SOURCE_READ_CONTRACT_V2),
    { code: 'source_missing' });
  assert.throws(() => evidence.readSource('p', source, { start: 0, end: 1 }, 'source-read/v9' as any),
    { code: 'research_consumer_intent_invalid' });
  engine.discovery.evidence.document('p', 'long', 'changed', 'text/plain', 1);
  assert.throws(() => evidence.readSource('p', source, { start: 0, end: 1 }, SOURCE_READ_CONTRACT_V2),
    { code: 'source_stale' });
});

test('SR1c source-read/v3 gives whole clean Markdown or a non-evidentiary overview and preserves v2 replay', async t => {
  const { store, engine, configure } = fixture(t); configure('p');
  const small = reference(await structuredWebSource({ root: '', store, engine }, '# Intro\n' + 'a'.repeat(59_500), 'small'));
  const read = engine.discovery.evidence.readSource('p', small, { start: 3, end: 12 }, SOURCE_READ_CONTRACT_V3);
  assert.equal(read.outcome, 'complete');
  assert.equal(read.value, '# Intro\n' + 'a'.repeat(59_500));
  assert.equal(read.expanded, true); assert.equal(read.documentComplete, true);
  assert.equal(engine.discovery.evidence.verifyReading(read), true);
  const bigText = '# First\n' + 'b'.repeat(3_000) + 'Needle' + 'c'.repeat(57_001);
  const big = reference(await structuredWebSource({ root: '', store, engine }, bigText, 'big'));
  const overview = engine.discovery.evidence.readSource('p', big,
    { start: 0, end: bigText.length }, SOURCE_READ_CONTRACT_V3);
  assert.equal(overview.outcome, 'overview'); assert.equal(overview.selector, null);
  assert.equal(overview.documentComplete, false);
  assert.equal(engine.discovery.evidence.verifyReading(overview), true);
  assert.equal(engine.discovery.evidence.verifyReading({ ...overview, documentComplete: true }), false);
  const addressed = engine.discovery.evidence.readSource('p', big,
    { start: 8, end: 59_500 }, SOURCE_READ_CONTRACT_V3);
  assert.equal(addressed.selector?.kind, 'text-range');
  assert.equal(addressed.value, bigText.slice(addressed.served!.start, addressed.served!.end));
  assert.equal(engine.discovery.evidence.verifyReading(addressed), true);
  const historical = engine.discovery.evidence.readSource('p', big,
    { start: 0, end: bigText.length }, SOURCE_READ_CONTRACT_V2);
  assert.equal(historical.served?.end, 50_000);
  assert.equal(engine.discovery.evidence.verifyReading(historical), true);
  const search = projectResearchSearchObservationV2('needle', [{ ref: big,
    value: store.get<any>(big.id)!.value }], { stdout: null, status: 1, signal: null, error: null });
  assert.equal(search.contract, 'research-search-capture/v2');
  assert.ok(search.sources.length > 0);
  assert.equal(search.sources[0]!.sectionPath?.at(-1)?.title, 'First');
});

test('RD1 cold restart completes one paid pending read as v2 without redispatch', async t => {
  const { root, store, engine, configure } = fixture(t); configure('p');
  const source = engine.discovery.evidence.document('p', 'large', 'A'.repeat(59_513), 'text/plain', 0);
  const draft = engine.prepare('p', 'discovery');
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(join(root, 'wire.jsonl'))},JSON.stringify(r)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_source',
source:${JSON.stringify(reference(source))},start:0,end:59513}}));`);
  const original = store.writeMany.bind(store); let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!interrupted && writes.some(write => write.kind === 'research-turn'
      && (write.value as ResearchTurn).status === 'completed'
      && ((write.value as ResearchTurn).action as { action?: string }).action === 'read_source')) {
      interrupted = true; throw new EngineError('fixture_interrupted', 'Local read completion interrupted');
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1);
  store.writeMany = original;
  assert.equal(interrupted, true);
  const before = store.list<ResearchTurn>('research-turn').find(turn =>
    (turn.value.action as { action?: string }).action === 'read_source')!;
  assert.equal(before.value.status, 'pending'); assert.equal(before.value.observation, null);
  const calls = store.list('model-call'), responses = store.list('model-response');
  assert.equal(calls.length, 1); assert.equal(responses.length, 1);
  const paidRequest = JSON.parse(readFileSync(join(root, 'wire.jsonl'), 'utf8').trim());
  assert.match(paidRequest.prompt, /50,000 UTF-16|50000 UTF-16/);
  const restarted = new Store(join(root, 'state.sqlite')); t.after(() => restarted.close());
  await new ProductEngine(restarted).researcher.run('p', draft.id, 1);
  const completed = restarted.get<ResearchTurn>(before.id)!;
  assert.equal(completed.value.status, 'completed'); assert.equal(completed.value.error, null);
  const reading = completed.value.observation as any;
  assert.equal(reading.contract, SOURCE_READ_CONTRACT_V2);
  assert.equal(reading.outcome, 'clipped');
  assert.deepEqual(reading.requested, { start: 0, end: 59_513 });
  assert.deepEqual(reading.served, { start: 0, end: 50_000 });
  assert.equal(reading.value, source.value.content.slice(0, 50_000));
  assert.deepEqual(readResearchConsumerTurn(restarted, reference(completed)), completed);
  assert.deepEqual(restarted.list('model-call'), calls);
  assert.deepEqual(restarted.list('model-response'), responses);
  assert.equal(readFileSync(join(root, 'wire.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('RD1 next analyst can request exactly the clipped tail under the delivered instruction', async t => {
  const { root, store, engine, configure } = fixture(t); configure('p');
  const content = 'A'.repeat(59_513);
  const source = engine.discovery.evidence.document('p', 'large', content, 'text/plain', 0);
  const draft = engine.prepare('p', 'discovery');
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(join(root, 'wire.jsonl'))},JSON.stringify(r)+'\\n');
const reads=[...(c.history??[]),c.currentRead].filter(t=>t?.action?.action==='read_source');
const start=reads.at(-1)?.observation?.served?.end??0;
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_source',
source:${JSON.stringify(reference(source))},start,end:59513}}));`);
  await engine.researcher.run('p', draft.id, 2);
  const turns = store.list<ResearchTurn>('research-turn').filter(turn =>
    (turn.value.action as { action?: string }).action === 'read_source').sort((a, b) => a.value.number - b.value.number);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map(turn => (turn.value.observation as any).served),
    [{ start: 0, end: 50_000 }, { start: 50_000, end: 59_513 }]);
  assert.equal(turns.map(turn => (turn.value.observation as any).value).join(''), content);
  assert.ok(turns.every(turn => turn.value.status === 'completed' && turn.value.error === null));
  const sent = readFileSync(join(root, 'wire.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(sent.length, 2);
  for (const request of sent) {
    assert.match(request.prompt, /50000 UTF-16/);
    assert.match(request.prompt, /start=served\.end/);
    assert.match(request.prompt, /Never treat a clipped result as having read all of requested/);
  }
});

test('RD1 question revision changing in the read/write window leaves the paid read pending', async t => {
  const { root, store, engine, configure } = fixture(t); configure('p');
  const source = engine.discovery.evidence.document('p', 'large', 'A'.repeat(59_513), 'text/plain', 0);
  const draft = engine.prepare('p', 'discovery');
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_source',
source:${JSON.stringify(reference(source))},start:0,end:59513}}));`);
  const other = new Store(join(root, 'state.sqlite')); t.after(() => other.close());
  const original = store.writeMany.bind(store); let changed = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.some(write => write.kind === 'research-turn'
      && (write.value as ResearchTurn).status === 'completed'
      && ((write.value as ResearchTurn).action as { action?: string }).action === 'read_source')) {
      changed = true;
      const question = other.get<Question>(draft.value.questions[0]!)!;
      new ProductEngine(other).discovery.reopen(question.id, question.revision);
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  const run = await engine.researcher.run('p', draft.id, 1);
  store.writeMany = original;
  assert.equal(changed, true);
  assert.equal(run.value.pauseCode, 'input_stale');
  const turn = store.list<ResearchTurn>('research-turn').find(item =>
    (item.value.action as { action?: string }).action === 'read_source')!;
  assert.equal(turn.value.status, 'pending'); assert.equal(turn.value.observation, null);
  assert.equal(store.list('model-call').length, 1); assert.equal(store.list('model-response').length, 1);
});

for (const stage of UPSTREAM_STAGES) test(`RD1 ${stage} serves a long source without a research_excerpt_limit pause`, async t => {
  const { root, store, engine, configure } = fixture(t);
  preparedFeatures(engine, 'p'); configure('p');
  const source = engine.discovery.evidence.document('p', 'large', 'L'.repeat(59_513), 'text/plain', 0);
  const draft = engine.prepare('p', stage);
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_source',
source:${JSON.stringify(reference(source))},start:0,end:59513}}));`);
  const run = await engine.researcher.run('p', draft.id, 1);
  const turn = store.list<ResearchTurn>('research-turn').find(item =>
    (item.value.action as { action?: string }).action === 'read_source'
    && item.value.run === run.id);
  assert.ok(turn, JSON.stringify({ stage, run: run.value }));
  assert.equal(turn.value.status, 'completed'); assert.equal(turn.value.error, null);
  assert.deepEqual((turn.value.observation as any).served, { start: 0, end: 50_000 });
  assert.equal((turn.value.observation as any).outcome, 'clipped');
  assert.deepEqual(readResearchConsumerTurn(store, reference(turn)), turn);
  assert.notEqual(run.value.pauseCode, 'research_excerpt_limit');
});

test("research command connects a process provider, evidence assessment and downstream acceptance for two products", async t => {
  const { store, engine, configure } = fixture(t);
  for (const project of ["garden", "inventory"]) {
    configure(project);
    engine.discovery.evidence.document(project, "brief", researchInput(project), "application/json", 0);
    const draft = engine.prepare(project, "discovery");
    const run = await engine.execute({ type: "research-draft", project, draftId: draft.id, maxTurns: 8 }) as { value: ResearchRun };
    assert.equal(run.value.status, "completed", JSON.stringify({run:run.value,turns:store.list<ResearchTurn>("research-turn").map(t=>({action:(t.value.action as {action:string}).action,error:t.value.error}))})); assert.equal(run.value.ownerQuestion, null);
    const content = engine.draft(project, "discovery", draft.id, 0);
    engine.pipeline.accept(project, "discovery", content.revision);
    assert.equal(engine.pipeline.inspect(project, "discovery").state, "accepted");
    const count = store.list("research-turn").length;
    await engine.researcher.run(project, draft.id, 8);
    assert.equal(store.list("research-turn").length, count, "A completed unchanged draft must not call the model again");
    const next = engine.prepare(project, "discovery");
    const reused = await engine.researcher.run(project, next.id, 8);
    assert.equal(reused.value.status, "completed",JSON.stringify(reused.value));
    const newlyAnswered=store.list<ResearchTurn>("research-turn").filter(t=>t.value.run===reused.id&&(t.value.action as any).action==='answer');
    assert.deepEqual(newlyAnswered.sort((a,b)=>a.value.number-b.value.number).map(t=>store.get<Question>((t.value.action as any).question)!.value.spec.field),
      ['researchReport','verdict','preparation'], "The plan is reused; changed exact parent refs require new downstream answers");
    const reusedCount=store.list("research-turn").length;
    await engine.researcher.run(project,next.id,8);
    assert.equal(store.list("research-turn").length,reusedCount,"The exact same v5 draft remains free to repeat");
    engine.discovery.evidence.document(project, "brief", researchInput(project, "Changed source", "Changed owner intent"), "application/json", 1);
    assert.equal(engine.pipeline.inspect(project, "discovery").state, "stale");
    const refreshed = await engine.researcher.run(project, draft.id, 8);
    assert.equal(refreshed.value.status, "completed", JSON.stringify({message:"Only changed evidence is refreshed",run:refreshed.value,turns:store.list<ResearchTurn>("research-turn").slice(-8).map(t=>({action:(t.value.action as {action:string}).action,error:t.value.error}))}));
  }
});

test("bounded research resumes without erasing answers or escalating an exhausted allowance to the owner", async t => {
  const { engine, configure } = fixture(t, "pause-first"); configure("p");
  engine.discovery.evidence.document("p", "brief", researchInput("p", "Input", "Owner outcome"), "application/json", 0);
  const draft = engine.prepare("p", "discovery");
  const first = await engine.researcher.run("p", draft.id, 1);
  assert.equal(first.value.status, "paused"); assert.equal(first.value.ownerQuestion, null);
  const second = await engine.researcher.run("p", draft.id, 1);
  assert.equal(second.value.status, "paused");
  const answered = engine.store.get(draft.value.questions[0]!)!;
  const third = await engine.researcher.run("p", draft.id, 5);
  assert.equal(third.value.status, "completed");
  assert.equal(engine.store.get(answered.id)!.revision, answered.revision);
});

test("an assessor refusal cannot be converted into an accepted answer by a valid source hash", async t => {
  const { engine, configure, store } = fixture(t, "irrelevant"); configure("p");
  engine.discovery.evidence.document("p", "brief", JSON.stringify({ brief: "Unrelated source", objective: "Unrelated value" }), "application/json", 0);
  const draft = engine.prepare("p", "discovery"); const run = await engine.researcher.run("p", draft.id, 2);
  assert.equal(run.value.status, "paused"); assert.equal(run.value.ownerQuestion, null);
  assert.equal(store.list("research-answer").length, 0);
  assert.ok(engine.discovery.gate("p", reference(store.get(draft.id)!)).findings.some(item => item.code === "question_unresolved"));
});

test("premature owner questions are refused; an assessed essential owner-only gap is exposed after source search", async t => {
  const { engine, configure, store } = fixture(t, "premature"); configure("p");
  engine.discovery.evidence.document("p", "brief", JSON.stringify({ brief: "Known input", objective: "Already chosen" }), "application/json", 0);
  const draft = engine.prepare("p", "discovery"); const run = await engine.researcher.run("p", draft.id, 1);
  assert.equal(run.value.status, "paused"); assert.equal(run.value.ownerQuestion, null);
  assert.match(store.list<ResearchTurn>("research-turn")[0]!.value.error!, /consult actual sources/);
  const other = fixture(t, "missing"); other.configure("q");
  other.engine.discovery.evidence.document("q", "brief", "The destination is intentionally undecided.", "text/plain", 0);
  const fields: FieldSpec[] = [{ field: "destination", kind: "decision", prompt: "Which destination did the owner choose?", risk: "No delivery target", schema: { type: "string", minLength: 1 } }];
  const pending = other.engine.discovery.create("q", "discovery", "R0", "concept", fields);
  const result = await other.engine.researcher.run("q", pending.id, 3);
  assert.equal(result.value.status, "needs_owner");
  assert.equal(result.value.ownerQuestion?.question, pending.value.questions[0]);
});

test("provider failure preserves unresolved work and is not an owner question", async t => {
  const { engine, configure } = fixture(t, "failure"); configure("p");
  engine.discovery.evidence.document("p", "brief", "Input", "text/plain", 0);
  const draft = engine.prepare("p", "discovery"); const run = await engine.researcher.run("p", draft.id, 2);
  assert.equal(run.value.status, "paused"); assert.equal(run.value.ownerQuestion, null);
  assert.match(run.value.error!, /provider unavailable/);
});

test("a proposed answer survives assessor outage and resumes assessment without calling its researcher again", async t => {
  const { engine, configure, store, root } = fixture(t, "assessor-retry"); configure("p");
  engine.discovery.evidence.document("p", "brief", researchInput("p", "Input", "Owner outcome"), "application/json", 0);
  const draft = engine.prepare("p", "discovery"); const first = await engine.researcher.run("p", draft.id, 8);
  assert.equal(first.value.status, "paused");
  const candidate = store.list<ResearchTurn>("research-turn").find(turn => turn.value.status === "pending")!;
  assert.equal(candidate.value.status, "pending");
  assert.equal((candidate.value.action as { value: string }).value, "Input");
  const second = await engine.researcher.run("p", draft.id, 8);
  assert.equal(second.value.status, "completed");
  assert.equal(readFileSync(join(root, "calls.txt"), "utf8").split("\n").filter(role => role === "research").length, draft.value.questions.length + 1);
  assert.equal(store.get<ResearchTurn>(candidate.id)!.value.status, "completed");
});

test("owner answer arriving during escalation assessment prevents publication of a stale question", async t => {
  const { engine, configure, root } = fixture(t, "race"); configure("p");
  engine.discovery.evidence.document("p", "brief", "Destination has not yet been selected.", "text/plain", 0);
  const draft = engine.discovery.create("p", "discovery", "R0", "concept", [{ field: "destination", kind: "decision",
    prompt: "Which destination did the owner choose?", risk: "No target", schema: { type: "string" } }]);
  const pending = engine.researcher.run("p", draft.id, 8);
  for (let attempts = 0; !existsSync(join(root, "calls.txt.awaiting")); attempts++) {
    assert.ok(attempts < 200, "Assessor did not reach the controlled await window");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  engine.discovery.decision(draft.value.questions[0]!, 1, "owner", "Local export");
  const result = await pending;
  assert.notEqual(result.value.status, "needs_owner"); assert.equal(result.value.ownerQuestion, null);
  assert.equal((await engine.researcher.run("p", draft.id, 8)).value.status, "completed");
});

for (const start of [0, 137]) test(`RS1 saved paid read ${start}..200 resumes once after restart and remains historically readable`, async t => {
  const { root, store, engine, configure } = fixture(t); configure('p');
  const source = engine.discovery.evidence.document('p', 'hx1', 'x'.repeat(137), 'text/plain', 0);
  const draft = engine.prepare('p', 'discovery');
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')); appendFileSync(${JSON.stringify(join(root, 'calls.txt'))},'call\\n');
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'read_source',source:${JSON.stringify(reference(source))},start:${start},end:200}}));`);
  const original = store.writeMany.bind(store); let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!interrupted && writes.some(write => write.kind === 'research-turn'
      && (write.value as ResearchTurn).status === 'completed')) {
      interrupted = true; throw new EngineError('input_stale', 'Crash before local read application');
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1); store.writeMany = original;
  assert.equal(interrupted, true);
  const paid = store.list('model-call'), responses = store.list('model-response');
  const reopened = new Store(join(root, 'state.sqlite')); t.after(() => reopened.close());
  const resumed = await new ProductEngine(reopened).researcher.run('p', draft.id, 1);
  assert.match(resumed.value.error!, /allowance reached/, JSON.stringify(resumed.value));
  const turn = reopened.list<ResearchTurn>('research-turn')[0]!;
  const result = readResearchConsumerTurn(reopened, reference(turn)).value.observation;
  assert.equal(turn.value.status, 'completed'); assert.equal(turn.value.error, null);
  assert.equal(result.outcome, start === 0 ? 'clipped' : 'outside'); assert.equal(result.length, 137);
  assert.equal(result.value, start === 0 ? source.value.content : null);
  assert.deepEqual(reopened.list('model-call'), paid); assert.deepEqual(reopened.list('model-response'), responses);
  assert.equal(readFileSync(join(root, 'calls.txt'), 'utf8').trim(), 'call');
  engine.discovery.evidence.document('p', 'hx1', 'new content', 'text/plain', 1);
  assert.deepEqual(readResearchConsumerTurn(reopened, reference(turn)), turn, 'Historical replay ignores today’s source head');
});

async function rs1BundleFixture(t: test.TestContext) {
  const { root, store, engine, configure } = fixture(t); preparedFeatures(engine, 'p'); configure('p');
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')); appendFileSync(${JSON.stringify(join(root, 'calls.txt'))},'reader\\n');
const sources=req.subject.sources;
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{selections:sources.flatMap(s=>s.lines.length?[{sourceIndex:s.sourceIndex,firstLine:s.lines[0][0],lastLine:s.lines.at(-1)[0]}]:[]),unresolved:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  const command = { executable: process.execPath, args: [join(root, 'adapter.mjs')] };
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 50000, maxReadChars: 20000, maxReplyChars: 10000 }, 0);
  const environment = pilotEnvironment(engine.environments.get('p').value, pilot.value);
  return { root, store, engine, draft, question, pilot, environment };
}

test('RD1 v2 outside remains source-checked by synthesis after a restart', async t => {
  const { root, store, engine, draft, question, pilot } = await rs1BundleFixture(t);
  const source = engine.discovery.evidence.document('p', 'v2-outside', 'abc', 'text/plain', 0);
  const reading = engine.discovery.evidence.readSource('p', reference(source),
    { start: 3, end: 10 }, SOURCE_READ_CONTRACT_V2);
  assert.equal(reading.selector, null); assert.equal(reading.outcome, 'outside');
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'RD1 stop'}}));`);
  const environment = engine.environments.get('p');
  const dispatch = pilotEnvironment(environment.value, pilot.value);
  const context = { ...pilotContext(store, draft, question),
    workingSelections: [{ kind: 'context', value: reading }] };
  const invoke = (view: Store) => synthesisSession(view, draft, question, environment, dispatch, pilot,
    context, 'Return one action');
  assert.equal((await invoke(store)).action, 'pause');
  const session = store.list<any>('synthesis-session')[0]!;
  const restarted = new Store(join(root, 'state.sqlite')); t.after(() => restarted.close());
  assert.deepEqual(readSynthesisSession(restarted, reference(session)), session);
  restarted.write({ id: source.id, kind: source.kind, expected: source.revision,
    value: { ...source.value, content: 'changed', sha256: digest('changed') } });
  const calls = restarted.list('model-call');
  await assert.rejects(invoke(restarted), { code: 'synthesis_evidence_stale' });
  assert.deepEqual(restarted.list('model-call'), calls);
});

for (const outsideOnly of [false, true]) test(`RS1 bundle ${outsideOnly ? 'outside only' : 'mixed clipped and outside'} preserves requested inputs and replays after restart`, async t => {
  const { root, store, engine, question, pilot, environment } = await rs1BundleFixture(t);
  const a = engine.discovery.evidence.document('p', 'a', 'header\noriginal\n', 'text/plain', 0);
  const b = engine.discovery.evidence.document('p', 'b', 'short', 'text/plain', 0);
  const inputs = [{ source: reference(a), range: { start: outsideOnly ? 200 : 0, end: 300 } },
    { source: reference(b), range: { start: 10, end: 20 } }];
  const result = await readBundle(store, environment, pilot, reference(question), 'RS1 exact windows', inputs);
  assert.deepEqual(result.value.coverage.map(item => item.reading?.outcome), outsideOnly ? ['outside', 'outside'] : ['clipped', 'outside']);
  assert.deepEqual(result.value.coverage.map(item => item.reading?.requested), inputs.map(item => item.range));
  assert.equal(result.value.observations.length, outsideOnly ? 0 : 1);
  if (!outsideOnly) assert.equal(result.value.observations[0]!.value, a.value.content);
  assert.equal(result.value.unresolved.length, outsideOnly ? 2 : 1);
  const calls = store.list('model-call'); assert.equal(calls.length, outsideOnly ? 0 : 1);
  const reopened = new Store(join(root, 'state.sqlite')); t.after(() => reopened.close());
  assert.deepEqual(readReaderResultAt(reopened, 'p', reference(result)), result);
  engine.discovery.evidence.document('p', 'a', 'changed', 'text/plain', 1);
  assert.deepEqual(await readBundle(reopened, environment, pilot, reference(question), 'RS1 exact windows', inputs), result);
  assert.deepEqual(reopened.list('model-call'), calls);
  if (outsideOnly) for (const tamper of [
    (value: any) => { delete value.request; },
    (value: any) => { value.coverage[0].reading.length++; },
    (value: any) => { value.coverage[0].reading.contract = 'unknown'; },
  ]) {
    const value = JSON.parse(JSON.stringify(result.value)); tamper(value);
    const fake = reopened.write({ id: `reader-result:v2:${hashJson(value)}`, kind: 'reader-result', expected: 0, value });
    assert.throws(() => readReaderResultAt(reopened, 'p', reference(fake)), (error: unknown) =>
      error instanceof EngineError && error.code === 'reader_result_invalid');
  }
});


test('RS1 R2 every saved outside field is proved before resume, public read or continuation, beside a valid result', async t => {
  const { root, store, engine, draft, question, pilot, environment } = await rs1BundleFixture(t);
  const source = reference(engine.discovery.evidence.document('p', 'outside-shapes', 'original', 'text/plain', 0));
  const inputs = [{ source, range: { start: 100, end: 200 } }], purpose = 'RS1 R2 outside proof';
  const result = await readBundle(store, environment, pilot, reference(question), purpose, inputs);
  assert.equal(result.value.producer, 'outside');
  assert.deepEqual(readerResumeStep(store, 'p', reference(question), purpose, inputs, null).kind, 'completed');
  assert.deepEqual(await readBundle(store, environment, pilot, reference(question), purpose, inputs), result);
  assert.equal(store.list('model-call').length, 0);
  store.close();
  const paths = ['request', 'request.child', 'request.inputs', 'request.rootSources', 'request.consumer',
    'sources', 'coverage', 'coverage.0', 'coverage.0.visibleRange', 'coverage.0.reading',
    'coverage.0.reading.requested', 'coverage.0.reading.served', 'coverage.0.reading.length', 'unresolved'];
  const mutations: [string, (value: any) => void][] = [];
  for (const path of paths) for (const form of ['missing', 'null', 'type'] as const) {
    // Null is the legal no-window / no-consumer value for an outside result.
    if (form === 'null' && ['request.consumer', 'coverage.0.reading.served'].includes(path)) continue;
    mutations.push([`${path} ${form}`, value => {
      const keys = path.split('.'), field = keys.pop()!, parent = keys.reduce((v, key) => v[key], value);
      if (form === 'missing') {
        if (Array.isArray(parent)) parent.splice(Number(field), 1); else delete parent[field];
      } else parent[field] = form === 'null' ? null : 'wrong-type';
    }]);
  }
  mutations.push(['child invalid position', value => { value.request.child = [2]; }],
    ['child impossible split', value => { value.request.child = [0]; }],
    ['input null item', value => { value.request.inputs = [null]; }],
    ['input null range', value => { value.request.inputs[0].range = null; }],
    ['root null item', value => { value.request.rootSources = [null]; }],
    ['root window null', value => { value.request.rootSources[0].window = null; }],
    ['root reading requested null', value => { value.request.rootSources[0].reading.requested = null; }],
    ['length contradictory', value => { value.coverage[0].reading.length++; }],
    ['notice forged', value => { value.unresolved = ['unproved outside']; }]);
  let index = 0;
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const database = join(root, `outside-shape-${index++}.sqlite`);
    copyFileSync(join(root, 'state.sqlite'), database);
    const copy = new Store(database), value = structuredClone(result.value); mutate(value);
    const bad = copy.write({ id: `reader-result:v2:${hashJson(value)}`, kind: 'reader-result', expected: 0, value });
    copy.close();
    const restarted = new Store(database);
    try {
      const before = restarted.list();
      const view = { id: 'research-turn:reading-view', value: { question: reference(question), status: 'completed', error: null,
        action: { action: 'read_bundle' }, observation: { ref: reference(bad), ...value } } } as unknown as ReturnType<typeof restarted.list<ResearchTurn>>[number];
      const invocations = [
        () => readReaderResultAt(restarted, 'p', reference(bad)),
        () => readerResumeStep(restarted, 'p', reference(question), purpose, inputs, null),
        () => readBundle(restarted, environment, pilot, reference(question), purpose, inputs),
        () => latestFocus(restarted, [view], question),
        () => readPilotContext(restarted, draft, reference(bad), '/observations/0', 1000),
        () => pilotContext(restarted, draft, question),
      ];
      for (let repeat = 0; repeat < 2; repeat++) for (const invoke of invocations)
        await assert.rejects(async () => invoke(), (error: unknown) => error instanceof EngineError
          && error.code === 'reader_result_invalid' && error.message.includes(bad.id));
      assert.deepEqual(restarted.list(), before, 'Refusal must not write or hide the valid neighbour');
      assert.equal(restarted.list('model-call').length, 0);
      assert.deepEqual(readReaderResultAt(restarted, 'p', reference(result)), result);
    } finally { restarted.close(); }
  });
});

for (const form of ['missing', 'null', 'type'] as const) test(`RS1 R2 outside child ${form} alone refuses without replaying the saved request`, async t => {
  const { store, engine, question, pilot, environment } = await rs1BundleFixture(t);
  const source = reference(engine.discovery.evidence.document('p', 'only-invalid', 'original', 'text/plain', 0));
  const inputs = [{ source, range: { start: 100, end: 200 } }], purpose = 'RS1 R2 no valid neighbour';
  const original = store.writeMany.bind(store);
  store.writeMany = ((writes: Write[], guards = []) => original(writes.map(write => {
    if (write.kind !== 'reader-result') return write;
    const value = structuredClone(write.value) as any;
    if (form === 'missing') delete value.request.child; else value.request.child = form === 'null' ? null : 'wrong-type';
    return { ...write, id: `reader-result:v2:${hashJson(value)}`, value };
  }), guards)) as typeof store.writeMany;
  await assert.rejects(readBundle(store, environment, pilot, reference(question), purpose, inputs), { code: 'reader_result_invalid' });
  store.writeMany = original;
  const bad = store.list('reader-result')[0]!, before = store.list();
  for (const invoke of [() => readReaderResultAt(store, 'p', reference(bad)),
    () => readerResumeStep(store, 'p', reference(question), purpose, inputs, null),
    () => readBundle(store, environment, pilot, reference(question), purpose, inputs)])
    await assert.rejects(async () => invoke(), (error: unknown) => error instanceof EngineError
      && error.code === 'reader_result_invalid' && error.message.includes(bad.id));
  assert.deepEqual(store.list(), before);
  assert.equal(store.list('model-call').length, 0);
});

for (const field of ['requested', 'served', 'length'] as const) test(`RS1 R2 malformed source reading ${field} is excluded from continuation without throwing`, async t => {
  const { store, engine, draft, question } = await rs1BundleFixture(t);
  const source = reference(engine.discovery.evidence.document('p', 'source-shapes', 'original', 'text/plain', 0));
  const action = { action: 'read_source', source, start: 0, end: 200 };
  const original = engine.discovery.evidence.readSource('p', source, { start: 0, end: 200 });
  for (const form of ['missing', 'null', 'type'] as const) {
    const observation = structuredClone(original) as any;
    if (form === 'missing') delete observation[field]; else observation[field] = form === 'null' ? null : 'wrong-type';
    assert.equal(engine.discovery.evidence.verifyReading(observation), false);
    const view = { value: { action, observation, status: 'completed', error: null, question: reference(question) } } as any;
    assert.equal(latestFocus(store, [view], question), null);
    retainPilotRead(store, 'p', question.id, action, observation);
  }
  assert.equal(pilotContext(store, draft, question).directReadings.length, 0);
  assert.equal(store.list('model-call').length, 0);
});

test('RS1 distinct requests cannot collapse into one clipped or outside source window', async t => {
  const { root, store, engine, question, pilot, environment } = await rs1BundleFixture(t);
  const source = reference(engine.discovery.evidence.document('p', 'duplicate', 'original', 'text/plain', 0));
  for (const start of [0, 100]) {
    const input = { source, range: { start, end: 200 } };
    await assert.rejects(readBundle(store, environment, pilot, reference(question), 'RS1 duplicates',
      [input, { source, range: { start, end: 300 } }]), { code: 'reader_range_ambiguous' });
    assert.equal(store.list('research-consumer-intent').length, 0);
    assert.equal(store.list('model-call').length, 0);
    assert.equal(store.list('reader-result').length, 0);
  }
  const input = { source, range: { start: 0, end: 200 } };
  const result = await readBundle(store, environment, pilot, reference(question), 'RS1 duplicates', [input, input]);
  assert.equal(result.value.observations.length, 1);
  assert.equal(result.value.observations[0]!.value, 'original');
  const reopened = new Store(join(root, 'state.sqlite')); t.after(() => reopened.close());
  assert.deepEqual(await readBundle(reopened, environment, pilot, reference(question), 'RS1 duplicates', [input, input]), result);
  assert.equal(reopened.list('model-call').length, 1);
});

test('RS1 malformed saved reading refuses both resume entries before any dispatch', async t => {
  const { root, store, engine, question, pilot, environment } = await rs1BundleFixture(t);
  const source = engine.discovery.evidence.document('p', 'corrupted-cursor', 'original', 'text/plain', 0);
  const inputs = [{ source: reference(source), range: { start: 0, end: 200 } }];
  const original = store.writeMany.bind(store);
  store.writeMany = ((writes: Write[], guards = []) => {
    const prepared = writes.find(write => write.kind === 'research-consumer-intent');
    if (!prepared) return original(writes, guards);
    const damaged = structuredClone(writes);
    (damaged.find(write => write.kind === 'research-consumer-intent')!.value as any).cursor.rootSourceOrder[0].reading = null;
    original(damaged, guards);
    throw new EngineError('fixture_stop', 'Stop after saving the damaged prepared cursor');
  }) as typeof store.writeMany;
  await assert.rejects(readBundle(store, environment, pilot, reference(question), 'RS1 malformed', inputs), { code: 'fixture_stop' });
  store.writeMany = original;
  const intent = store.list('research-consumer-intent')[0]!;
  const reopened = new Store(join(root, 'state.sqlite')); t.after(() => reopened.close());
  for (const invoke of [
    () => resumeReadBundleIntent(reopened, reference(intent), environment, pilot, undefined, []),
    () => readBundle(reopened, environment, pilot, reference(question), 'RS1 malformed', inputs),
  ]) await assert.rejects(invoke(), (error: unknown) => error instanceof EngineError
    && error.code === 'reader_intent_source_invalid');
  assert.equal(reopened.list('model-call').length, 0);
  assert.equal(reopened.list('model-response').length, 0);
});

test('RS1 split bundle retains clipped requests and addressed outside children after restart', async t => {
  const { root, store, engine, question, pilot, environment } = await rs1BundleFixture(t);
  const a = engine.discovery.evidence.document('p', 'long', 'long original line\n'.repeat(4000), 'text/plain', 0);
  const b = engine.discovery.evidence.document('p', 'outside', 'short', 'text/plain', 0);
  const inputs = [{ source: reference(a), range: { start: 0, end: 100000 } },
    { source: reference(b), range: { start: 137, end: 200 } }];
  const result = await readBundle(store, environment, pilot, reference(question), 'RS1 split', inputs);
  assert.equal(result.value.producer, 'combined');
  assert.ok(result.value.observations.length > 1);
  assert.equal(result.value.observations.map(o => o.value).join(''), a.value.content);
  assert.equal(result.value.coverage[0]!.reading!.requested.end, 100000);
  assert.equal(result.value.coverage[1]!.reading!.outcome, 'outside');
  assert.equal(result.value.unresolved.length, 1);
  const calls = store.list('model-call'); assert.ok(calls.length > 1);
  const reopened = new Store(join(root, 'state.sqlite')); t.after(() => reopened.close());
  assert.deepEqual(readReaderResultAt(reopened, 'p', reference(result)), result);
  assert.deepEqual(await readBundle(reopened, environment, pilot, reference(question), 'RS1 split', inputs), result);
  assert.deepEqual(reopened.list('model-call'), calls);
});

test('RS1 exact previous producer from Git keeps completed source and bundle outcomes in their era', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-rs1-era-')), era = join(root, 'era'), archive = join(root, 'archive.tar'); mkdirSync(era);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, '94af9c4ac0a06ca1ee911d626356e07ab7850c04']);
  try {
    execFileSync('tar', ['-xf', archive, '-C', era]);
  } finally {
    rmSync(archive, { force: true });
  }
  symlinkSync(resolve('node_modules'), join(era, 'node_modules'));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(era, 'tsconfig.json')], { cwd: era });
  const script = join(era, 'old-producer.mjs');
  writeFileSync(script, `import {writeFileSync} from 'node:fs';
import {Store} from './dist/src/storage/store.js'; import {ProductEngine} from './dist/src/product/engine.js';
import {reference} from './dist/src/pipeline/contracts.js'; import {preparedFeatures} from './dist/test/product-fixture.js';
import {readBundle} from './dist/src/discovery/reader.js';
import {configureReaderPilot,pilotEnvironment} from './dist/src/discovery/reader-pilot.js';
const root=${JSON.stringify(root)},store=new Store(root+'/state.sqlite'),engine=new ProductEngine(store);
const adapter=root+'/adapter.mjs';
writeFileSync(adapter,\`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='reader'?{selections:[{sourceIndex:0,firstLine:1,lastLine:1}],unresolved:[]}
:{action:'read_source',source:s.inventory.sources[0].ref,start:0,end:5};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research}));\`);
const command={executable:process.execPath,args:[adapter]};
engine.execute({type:'create-project',project:'p',title:'p'});
const environment=engine.environments.configure('p',{workspace:root,implementer:{actor:'i',model:'fixture',effort:'high',command},reviewer:{actor:'r',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
const source=engine.discovery.evidence.document('p','old','abcde','text/plain',0);
const draft=engine.prepare('p','discovery');await engine.researcher.run('p',draft.id,1);
const turn=store.list('research-turn')[0];
preparedFeatures(engine,'q');
const env=engine.environments.configure('q',{...environment.value,projectId:'q'},0);
const r0=engine.refinement.begin('q','R0');engine.refinement.finishResearch('q','R0',reference(r0),0);engine.refinement.sealLayer('q',1,0);
const d=engine.refinement.begin('q','R1'),q=store.get(d.value.questions[0]);
const pilot=configureReaderPilot(store,engine.environments,'q',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,maxCalls:10,maxReportedTokens:100000,maxRequestChars:50000,maxReadChars:20000,maxReplyChars:10000},0);
const original=engine.discovery.evidence.document('q','old','abcde','text/plain',0);
const result=await readBundle(store,pilotEnvironment(env.value,pilot.value),pilot,reference(q),'old',[{source:reference(original),range:{start:0,end:5}}]);
writeFileSync(root+'/expected.json',JSON.stringify({turn,result,source:reference(source)}));store.close();`);
  execFileSync(process.execPath, [script], { cwd: era, maxBuffer: 4 << 20 });
  const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'));
  const store = new Store(join(root, 'state.sqlite')); t.after(() => store.close());
  assert.equal(expected.turn.value.observation.contract, undefined);
  assert.equal(expected.result.value.coverage[0].reading, undefined);
  assert.deepEqual(readResearchConsumerTurn(store, reference(expected.turn)), expected.turn);
  assert.deepEqual(readReaderResultAt(store, 'q', reference(expected.result)), expected.result);
});


test('RS1 grouped read_source outside does not cancel the following clipped child', async t => {
  const { root, store, engine, question, pilot } = await rs1BundleFixture(t);
  const source = engine.discovery.evidence.document('p', 'grouped', 'original', 'text/plain', 0);
  const settings: Record<string, unknown> = { ...pilot.value }; delete settings.projectId;
  configureReaderPilot(store, engine.environments, 'p', { ...settings,
    planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(join(root, 'calls.txt'))},JSON.stringify(r.prompt)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_plan',question:r.subject.question.id,reads:[
{action:'read_source',source:${JSON.stringify(reference(source))},start:100,end:200},
{action:'read_source',source:${JSON.stringify(reference(source))},start:0,end:200}]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  await engine.researcher.run('p', question.value.draftId, 3);
  const children = store.list<ResearchTurn>('research-turn').filter(turn => (turn.value.action as any).action === 'read_source')
    .sort((left, right) => left.value.number - right.value.number);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(turn => (turn.value.observation as any)?.outcome), ['outside', 'clipped']);
  assert.ok(children.every(turn => turn.value.status === 'completed' && turn.value.error === null));
  for (const turn of children) assert.deepEqual(readResearchConsumerTurn(store, reference(turn)), turn);
  assert.equal(store.list('model-call').length, 1);
  assert.match(JSON.parse(readFileSync(join(root, 'calls.txt'), 'utf8').trim()), /50000 UTF-16/);
  const child = children[0]!;
  const damaged = store.write({ id: child.id, kind: child.kind, expected: child.revision,
    value: { ...child.value, observation: { ...(child.value.observation as object), length: 900 } } });
  assert.throws(() => readResearchConsumerTurn(store, reference(damaged)), (error: unknown) =>
    error instanceof EngineError && error.code === 'research_consumer_intent_invalid');
});

test('RS1 source head CAS conflict preserves the paid pending turn without another dispatch', async t => {
  const { root, store, engine, configure } = fixture(t); configure('p');
  const source = engine.discovery.evidence.document('p', 'race', 'original', 'text/plain', 0);
  const draft = engine.prepare('p', 'discovery');
  writeFileSync(join(root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_source',source:${JSON.stringify(reference(source))},start:0,end:200}}));`);
  const other = new Store(join(root, 'state.sqlite')); t.after(() => other.close());
  const original = store.writeMany.bind(store); let raced = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!raced && writes.some(write => write.kind === 'research-turn' && (write.value as ResearchTurn).status === 'completed')) {
      raced = true; new ProductEngine(other).discovery.evidence.document('p', 'race', 'changed', 'text/plain', 1);
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  const result = await engine.researcher.run('p', draft.id, 1); store.writeMany = original;
  assert.equal(raced, true); assert.equal(result.value.pauseCode, 'input_stale');
  assert.equal(store.list<ResearchTurn>('research-turn')[0]!.value.status, 'pending');
  assert.equal(store.list('model-call').length, 1); assert.equal(store.list('model-response').length, 1);
});

import { addressedWorkspace } from '../src/discovery/research-continuation.js';
import { readResearchConsumerExecution } from '../src/discovery/response-recovery.js';
import { readContextTurnHistoryAt } from '../src/discovery/response-recovery.js';
import { projectAddressedWorkspace, type ManagedResearchTurn } from '../src/discovery/research-consumer-transition.js';
import type { DiscoveryDraft } from '../src/discovery/discovery.js';
import { canonical } from '../src/canonical.js';

const RS2_ADAPTER = `import{readFileSync,writeFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject,root=process.argv[2];
appendFileSync(root+'/wire.jsonl',JSON.stringify(r)+'\\n');
let research;
if(c.role==='assess-answer') research={verdict:'supported',reasons:[]};
else {
 const n=existsSync(root+'/position')?Number(readFileSync(root+'/position','utf8')):0;
 const a=JSON.parse(readFileSync(root+'/actions.json','utf8'))[n];
 if(!a)throw Error('Unexpected fixture dispatch '+n);
 writeFileSync(root+'/position',String(n+1));
 const catalog=c.inventory?.sources??c.originals?.sources??[];
 const sources=Array.isArray(catalog)?catalog:catalog.rows.map(row=>Object.fromEntries(catalog.columns.map((key,i)=>[key,row[i]])));
 const source=sources.find(s=>s.location==='rs2-source'),q=c.question??c.questions[0];
 const citations=[{source:source.ref,selector:{kind:'text-range',start:0,end:137}}];
 if(a==='source')research={action:'read_source',source:source.ref,start:0,end:200};
 else if(a==='checkpoint')research={action:'checkpoint',question:q.id,value:{note:'Retain the source and exact context'},citations,unresolved:['Need fields']};
 else if(a==='answer')research={action:'answer',question:q.id,value:{ok:true},citations};
 else if(a==='repeat')research={action:'read_context',record:c.contextWorkspace.at(-1).record,pointer:c.contextWorkspace.at(-1).pointer};
 else research={action:'read_context',record:c.working.archive,pointer:'/body/'+a};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`;

function rs2Fixture(t:test.TestContext,actions:string[]) {
 const f=fixture(t);f.configure('p');
 const source=f.engine.discovery.evidence.document('p','rs2-source','x'.repeat(137),'text/plain',0);
 const draft=f.engine.discovery.create('p','discovery','R0','concept',[
  {field:'result',kind:'design',prompt:'Design a result from the source',risk:'Incomplete context',schema:{type:'object'}}]);
 writeFileSync(join(f.root,'adapter.mjs'),RS2_ADAPTER);
 // The existing environment dispatches [adapter, scenario, calls]; use scenario as the root.
 const env=f.engine.environments.get('p');
 const command={executable:process.execPath,args:[join(f.root,'adapter.mjs'),f.root]};
 f.engine.environments.configure('p',{...env.value,implementer:{...env.value.implementer,command},
  reviewer:{...env.value.reviewer,command}},env.revision);
 writeFileSync(join(f.root,'actions.json'),JSON.stringify(actions));
 return {...f,draft,source};
}

function rs2Prove(store:Store,draftId:string,number?:number) {
 const turns=store.list<ResearchTurn>('research-turn').sort((a,b)=>a.value.number-b.value.number);
 const last=number?turns.find(t=>t.value.number===number)!:turns.at(-1)!;
 const before=store.get<ManagedResearchTurn>(last.id,1)!;
 const draft=store.get<DiscoveryDraft>(draftId)!;
 const question=store.get<Question>(before.value.question!.id,before.value.question!.revision)!;
 const previous=turns.filter(t=>t.value.number<before.value.number);
 const exact=projectAddressedWorkspace(before.value,
  readContextTurnHistoryAt(store,'p',draft,reference(question),previous,before.value.number),reference(question));
 const current=addressedWorkspace(store,previous,question,turn=>{
  const intent=(turn.value as any).consumerIntent;
  if(!isRef(intent))return null;
  const paid=readResearchConsumerExecution(store,'p',intent);
  return paid.kind==='response'&&Array.isArray(paid.subject.contextWorkspace)?paid.subject:null;
 });
 assert.deepEqual(current,exact,'The live fold and exact historical fold use the same delivered ranges');
 return exact;
}

for(const progress of ['source','checkpoint'])test(`RS2 ${progress} then two addressed reads survive paid interruption and restart without new calls`,async t=>{
 const actions=progress==='source'?['source','sourceCatalogue','fields']:['sourceCatalogue','checkpoint','fields'];
 const f=rs2Fixture(t,actions);
 for(let n=0;n<2;n++)await f.engine.researcher.run('p',f.draft.id,1);
 const original=f.store.writeMany.bind(f.store);let interrupted=false;
 f.store.writeMany=((writes:Write[],guards=[])=>{
  if(!interrupted&&writes.some(w=>w.kind==='research-turn'&&(w.value as ResearchTurn).status==='completed'
    &&(w.value as any).action?.pointer==='/body/fields')) {
   interrupted=true;throw new EngineError('fixture_rs2_interrupted','Paid addressed read awaits completion');
  }
  return original(writes,guards);
 }) as typeof f.store.writeMany;
 const stopped=await f.engine.researcher.run('p',f.draft.id,1);f.store.writeMany=original;
 assert.ok(interrupted,JSON.stringify(stopped.value));
 const calls=f.store.list('model-call'),responses=f.store.list('model-response');
 const restarted=new Store(join(f.root,'state.sqlite'));t.after(()=>restarted.close());
 await new ProductEngine(restarted).researcher.run('p',f.draft.id,1);
 const turn=restarted.list<ResearchTurn>('research-turn').find(r=>r.value.number===3)!;
 assert.equal(turn.value.status,'completed');assert.equal(turn.value.error,null);
 assert.deepEqual(readResearchConsumerTurn(restarted,reference(turn)),turn);
 assert.deepEqual(restarted.list('model-call'),calls);assert.deepEqual(restarted.list('model-response'),responses);
 const workspace=rs2Prove(restarted,f.draft.id);
 assert.equal(workspace.checkpointedKeys!.length,progress==='source'?0:1);
 const packet=JSON.parse(readFileSync(join(f.root,'wire.jsonl'),'utf8').trim().split('\n').at(-1)!).subject;
 assert.equal(canonical(packet.contextWorkspace),canonical(workspace.entries.map(e=>e.result)));
});

test('RS2 repeated delivered lookup retains the exact refusal through the historical reader',async t=>{
 const f=rs2Fixture(t,['sourceCatalogue','repeat']);
 await f.engine.researcher.run('p',f.draft.id,1);
 const result=await f.engine.researcher.run('p',f.draft.id,1);
 assert.equal(result.value.pauseCode,'research_no_progress');
 const turn=f.store.list<ResearchTurn>('research-turn').find(r=>r.value.number===2)!;
 assert.equal((turn.value.observation as any).code,'research_no_progress');
 const restart=new Store(join(f.root,'state.sqlite'));t.after(()=>restart.close());
 assert.deepEqual(readResearchConsumerTurn(restart,reference(turn)),turn);
 rs2Prove(restart,f.draft.id);
});

import { layerDesignOf } from '../src/graph/layer-design.js';
import { layerDeltaView } from '../src/discovery/layer-delta.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';

for(const delta of [false,true])test(`RS2 accepted ${delta?'answer_delta':'answer'} and lawful question reopening keep subsequent reads consistent`,async t=>{
 let f:ReturnType<typeof rs2Fixture>;
 if(!delta)f=rs2Fixture(t,['sourceCatalogue','answer','fields','sourceCatalogue']);
 else {
  const base=fixture(t),full=enrichedGraph(exampleGraph('p'),'p');
  preparedFeatures(base.engine,'p',full);base.configure('p');
  writeFileSync(join(base.root,'README.md'),'A local stateless transformation fixture.');
  const source=base.engine.discovery.evidence.document('p','rs2-source','x'.repeat(137),'text/plain',0);
  const r0=base.engine.refinement.begin('p','R0');
  base.engine.refinement.finishResearch('p','R0',reference(r0),0);base.engine.refinement.sealLayer('p',1,0);
  const r1=base.engine.refinement.begin('p','R1');answerTechnicalFixture(base.engine,'p',r1);
  base.engine.refinement.finishResearch('p','R1',reference(base.store.get(r1.id)!),0);
  const draft=base.engine.refinement.prepareLayer('p',2);
  const question=base.store.get<Question>(draft.value.questions[0]!)!;
  const view=layerDeltaView(base.store,'p',layerDesignOf(full,2,question.value.spec.layerAssembly),2,question.value.spec.layerAssembly);
  const adapter=RS2_ADAPTER.replace("const citations=[{source:source.ref,selector:{kind:'text-range',start:0,end:137}}];",
   `const citations=${JSON.stringify([{source:reference(source),selector:{kind:'text-range',start:0,end:137}}])};`)
   .replace("else if(a==='answer')research={action:'answer',question:q.id,value:{ok:true},citations};",
   "else if(a==='answer')research={action:'answer_delta',question:q.id,...JSON.parse(readFileSync(root+'/delta.json','utf8')),citations};");
  writeFileSync(join(base.root,'delta.json'),JSON.stringify({base:view.base,upserts:view.upserts,removes:view.removes}));
  writeFileSync(join(base.root,'adapter.mjs'),adapter);
  writeFileSync(join(base.root,'actions.json'),JSON.stringify(['sourceCatalogue','answer','question','sourceCatalogue']));
  const env=base.engine.environments.get('p'),command={executable:process.execPath,args:[join(base.root,'adapter.mjs'),base.root]};
  base.engine.environments.configure('p',{...env.value,implementer:{...env.value.implementer,command},reviewer:{...env.value.reviewer,command}},env.revision);
  configureReaderPilot(base.store,base.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
   reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,
   maxCalls:40,maxReportedTokens:50000000,maxRequestChars:100000,maxReadChars:60000,maxReplyChars:100000},0);
  f={...base,draft,source};
 }
 for(let n=0;n<2;n++)await f.engine.researcher.run('p',f.draft.id,1);
 const answer=f.store.list<ResearchTurn>('research-turn').find(turn=>(turn.value.action as any).action===(delta?'answer_delta':'answer'))!;
 assert.ok(answer,JSON.stringify({responses:f.store.list('model-response'),runs:f.store.list<ResearchRun>('research-run').map(r=>({status:r.value.status,error:r.value.error})),turns:f.store.list<ResearchTurn>('research-turn').map(t=>({status:t.value.status,action:(t.value.action as any).action,error:t.value.error}))}));assert.equal(answer.value.error,null,JSON.stringify(answer.value));
 assert.equal(f.store.get<Question>(f.draft.value.questions[0]!)!.value.status,'answered',JSON.stringify({runs:f.store.list('research-run'),turn:{status:answer.value.status,assessment:answer.value.assessment,error:answer.value.error}}));
 const q=f.store.get<Question>(f.draft.value.questions[0]!)!;f.engine.discovery.reopen(q.id,q.revision);
 const restarted=new Store(join(f.root,'state.sqlite'));t.after(()=>restarted.close());
 for(let n=0;n<2;n++)await new ProductEngine(restarted).researcher.run('p',f.draft.id,1);
 const turns=restarted.list<ResearchTurn>('research-turn').sort((a,b)=>a.value.number-b.value.number);
 assert.equal(turns.length,4);assert.equal(turns.at(-1)!.value.error,null);
 assert.equal(turns.at(-1)!.value.status,'completed');
 assert.deepEqual(readResearchConsumerTurn(restarted,reference(answer)),answer);
 const current = rs2Prove(restarted,f.draft.id);
 assert.deepEqual(current.checkpointedKeys ?? [],[],'older-revision lookups are not silently made current');
 assert.equal(current.entries.length,1,'only the reopened question has an addressed current lookup');
 assert.notEqual(canonical(current.entries[0]!.result.record), canonical((turns[0]!.value.observation as any).record));
});

test('RS2 current lookup head and exact historical lookup have distinct admission, without accepting a partial history',async t=>{
 const f=rs2Fixture(t,['sourceCatalogue','fields']);
 await f.engine.researcher.run('p',f.draft.id,1);
 const first=f.store.list<ResearchTurn>('research-turn')[0]!;
 const record=(first.value.observation as any).record;
 const original=f.store.get<any>(record.id)!;
 const another=new Store(join(f.root,'state.sqlite'));t.after(()=>another.close());
 another.write({...original,expected:original.revision,value:{...original.value,body:{...original.value.body,changed:true}}});
 assert.deepEqual(readResearchConsumerTurn(another,reference(first)),first,'today’s head does not rewrite a completed exact reading');
 const question=f.store.get<Question>(f.draft.value.questions[0]!)!;
 assert.deepEqual(addressedWorkspace(f.store,[first],question).entries,[],'the changed head is not current material');
 const paidBefore=f.store.list('model-call').length;
 const run=await f.engine.researcher.run('p',f.draft.id,1);
 assert.equal(run.value.pauseCode,'research_consumer_context_stale');
 assert.equal(f.store.list('model-call').length,paidBefore,'a changed archive head is refused before a new paid call');
 assert.equal(f.store.list<ResearchTurn>('research-turn').find(turn=>turn.value.number===2),undefined);
 const currentDraft=f.store.get<DiscoveryDraft>(f.draft.id)!;
 assert.throws(()=>readContextTurnHistoryAt(f.store,'p',currentDraft,reference(question),[],2),{code:'research_consumer_intent_invalid'});
 const forged=f.store.write<ResearchTurn>({id:'research-turn:v1:rs2-forged',kind:'research-turn',expected:0,
   value:{...first.value,observation:{...(first.value.observation as any),value:'forged'}}});
 assert.throws(()=>readContextTurnHistoryAt(f.store,'p',currentDraft,reference(question),[forged],2),{code:'research_consumer_intent_invalid'});
 assert.deepEqual(readResearchConsumerTurn(another,reference(first)),first);
});

test('RS2 exact Git ecd00625 producer keeps history and packet bytes and recovers its paid pending read',async t=>{
 const root=mkdtempSync(join(tmpdir(),'omg-rs2-era-')),era=join(root,'era'),archive=join(root,'archive.tar');mkdirSync(era);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('git',['archive','--format=tar',`--output=${archive}`,'ecd006252f7102d5377d61e8c9911685c1aa4aeb']);
 try{
  execFileSync('tar',['-xf',archive,'-C',era]);
 }finally{
  rmSync(archive,{force:true});
 }
 symlinkSync(resolve('node_modules'),join(era,'node_modules'));
 execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(era,'tsconfig.json')],{cwd:era});
 const producer=join(era,'rs2-old-producer.mjs');
 writeFileSync(producer,`import{mkdirSync,writeFileSync}from'node:fs';
import{Store}from'./dist/src/storage/store.js';import{ProductEngine}from'./dist/src/product/engine.js';
import{reference}from'./dist/src/pipeline/contracts.js';
import{projectAddressedWorkspace}from'./dist/src/discovery/research-consumer-transition.js';
import{readContextTurnHistoryAt}from'./dist/src/discovery/response-recovery.js';
for(const mode of ['paid','refused']){
 const root=${JSON.stringify(root)}+'/'+mode;mkdirSync(root);const store=new Store(root+'/state.sqlite'),engine=new ProductEngine(store);
 engine.execute({type:'create-project',project:'p',title:'Old producer'});
 const adapter=root+'/adapter.mjs';writeFileSync(adapter,${JSON.stringify(RS2_ADAPTER)});
 const command={executable:process.execPath,args:[adapter,root]};
 engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'assessor',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 engine.discovery.evidence.document('p','rs2-source','x'.repeat(137),'text/plain',0);
 const draft=engine.prepare('p','discovery');
 const actions=mode==='paid'?['source','sourceCatalogue','fields']:['sourceCatalogue','repeat'];
 writeFileSync(root+'/actions.json',JSON.stringify(actions));
 let run;for(const action of actions)run=await engine.researcher.run('p',draft.id,1);
 const turns=store.list('research-turn').sort((a,b)=>a.value.number-b.value.number),last=turns.at(-1),question=store.get(last.value.question.id);
 const workspace=projectAddressedWorkspace(store.get(last.id,1).value,readContextTurnHistoryAt(store,'p',store.get(draft.id),reference(question),turns,last.value.number),reference(question));
 writeFileSync(root+'/expected.json',JSON.stringify({draft,turns,workspace,run,records:store.list().filter(r=>['model-call','model-response','research-context'].includes(r.kind))}));store.close();
}`);
 execFileSync(process.execPath,[producer],{cwd:era,maxBuffer:4<<20});
 for(const mode of ['paid','refused']){
  const dir=join(root,mode),expected=JSON.parse(readFileSync(join(dir,'expected.json'),'utf8'));
  const store=new Store(join(dir,'state.sqlite'));t.after(()=>store.close());
  for(const turn of expected.turns)assert.deepEqual(readResearchConsumerTurn(store,reference(turn)),turn);
  assert.deepEqual(rs2Prove(store,expected.draft.id),expected.workspace,'the historical fold is byte-for-byte the old formula');
  const packet=JSON.parse(readFileSync(join(dir,'wire.jsonl'),'utf8').trim().split('\n').at(-1)!).subject;
  assert.equal(canonical(packet.contextWorkspace),canonical(expected.workspace.entries.map((e:any)=>e.result)));
  if(mode==='paid'){
   assert.equal(expected.run.value.pauseCode,'research_consumer_context_stale','the actual old producer reproduces HX1');
   const result=await new ProductEngine(store).execute({type:'research-stage',project:'p',draftId:expected.draft.id,maxTurns:1}) as any;
   assert.equal(result.status,'paused');
   const completed=store.get<ResearchTurn>(expected.turns.at(-1).id)!;
   assert.equal(completed.value.status,'completed');assert.equal(completed.value.error,null);
   const restarted=new Store(join(dir,'state.sqlite'));t.after(()=>restarted.close());
   assert.deepEqual(readResearchConsumerTurn(restarted,reference(completed)),completed);
  }else assert.equal(expected.run.value.pauseCode,'research_no_progress');
  assert.deepEqual(store.list().filter(r=>['model-call','model-response','research-context'].includes(r.kind)),expected.records);
  for(const turn of expected.turns)assert.deepEqual(store.get(turn.id,turn.revision),turn);
 }
});

import { spawnSync as rs3Spawn } from "node:child_process";
import { fileURLToPath as rs3Path } from "node:url";
import { readResearchConsumerIntent as rs3ReadIntent } from "../src/discovery/response-recovery.js";
import type { ResearchConsumerIntent as Rs3Intent } from "../src/discovery/response-recovery.js";
/**
 * RS3 (№4414, №4426): what a real adapter prints when its vendor CLI fails — captured by running codex-stdio or devin-stdio
 * itself over a CLI stub: `fail` exits 1 (HX2: no usage), `fail-usage` after a measured turn, `empty` completes without a
 * final answer, `garbage` answers what the adapter cannot read. Every one prints the same bare envelope; only the adapter's
 * structured error line differs.
 */
function rs3RealFailure(t: test.TestContext, adapter: "codex" | "devin", cli: "fail" | "fail-usage" | "empty" | "garbage" = "fail") {
  const root = mkdtempSync(join(tmpdir(), "omg-rs3-adapter-")), bin = join(root, "bin"), home = join(root, "home");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(bin, { recursive: true }); mkdirSync(join(home, ".config", "devin"), { recursive: true });
  writeFileSync(join(home, ".config", "devin", "config.json"), JSON.stringify({ devin: { org_id: "rs3-org" } }));
  const usage = `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}}));`;
  const answer = (text: string) => adapter === "codex"
    ? `const args=process.argv.slice(2);writeFileSync(args[args.indexOf('-o')+1],${JSON.stringify(text)});${usage}`
    : `process.stdout.write(${JSON.stringify(text)});`;
  writeFileSync(join(bin, adapter), `#!${process.execPath}\nimport{writeFileSync}from'node:fs';\n` + (cli === "fail" || cli === "fail-usage"
    ? `${cli === "fail-usage" ? usage : ""}console.error('ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 426 Upgrade Required');process.exit(1);\n`
    : `${answer(cli === "empty" ? "" : "not json")}\n`), { mode: 0o700 });
  const script = rs3Path(new URL(`../src/adapters/${adapter}-stdio.js`, import.meta.url));
  const request = { protocol: "omg-agent/v1", requestId: "RS3-REQUEST", mode: "research", model: adapter === "codex" ? "fixture-model" : "swe-2-high",
    effort: "high", prompt: "Return the declared research action", subject: { role: "analyst", questions: [] } };
  const result = rs3Spawn(process.execPath, [script, ...(adapter === "codex" ? ["--compact-research"] : [])], { cwd: root, input: JSON.stringify(request),
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: home } });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout);
  const envelope = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope), ["protocol", "requestId", "usage"], "Only the envelope of its own request");
  assert.deepEqual([envelope["protocol"], envelope["requestId"]], ["omg-agent/v1", "RS3-REQUEST"]);
  const code = (JSON.parse(result.stderr.trim().split("\n").at(-1)!) as { error: string }).error;
  return { stdout: result.stdout.replace("RS3-REQUEST", "$REQUEST"), stderr: result.stderr, exit: 1, code };
}
type Rs3Step = { stdout: string; stderr: string; exit: number; signal?: boolean; role?: string; code?: string };
/** The research fixture's adapter that first replays the planned failures of analyst turns (rs3.json beside calls.txt). */
const RS3_ADAPTER = ADAPTER.replace("if(scenario==='failure')",
  `const rs3=process.argv[3].replace(/calls\\.txt$/,'rs3.json');
if(existsSync(rs3)){const plan=JSON.parse(readFileSync(rs3,'utf8')),role=['assess-answer','assess-escalation'].includes(c.role)?c.role:'analyst',at=plan.findIndex(s=>(s.role??'analyst')===role);
 const step=at>=0?plan.splice(at,1)[0]:null;writeFileSync(rs3,JSON.stringify(plan));
 if(step){process.stdout.write(step.stdout.replaceAll('$REQUEST',req.requestId));process.stderr.write(step.stderr);
  if(step.signal){await new Promise(r=>setTimeout(r,50));process.kill(process.pid,'SIGTERM');}else process.exit(step.exit);}}
if(scenario==='failure')`);
/** The research fixture whose analyst turns first replay the given failures, in order; later calls answer as usual. */
function rs3Fixture(t: test.TestContext, steps: Rs3Step[]) {
  const f = fixture(t); f.configure("p");
  writeFileSync(join(f.root, "adapter.mjs"), RS3_ADAPTER);
  writeFileSync(join(f.root, "rs3.json"), JSON.stringify(steps));
  f.engine.discovery.evidence.document("p", "brief", researchInput("p", "Input", "Owner outcome"), "application/json", 0);
  const draft = f.engine.prepare("p", "discovery");
  const intents = () => f.store.list<Rs3Intent>("research-consumer-intent").filter(row => row.value.kind === "analyst")
    .sort((a, b) => a.value.generation - b.value.generation || (a.id < b.id ? -1 : 1));
  const calls = () => readFileSync(join(f.root, "calls.txt"), "utf8").trim().split("\n").filter(role => role !== "assess-answer" && role !== "assess-escalation").length;
  return { ...f, draft, intents, calls };
}

for (const [name, adapter, cli, expected] of [["codex-stdio, its CLI failed (HX2)", "codex", "fail", "provider_failed"], ["codex-stdio, its CLI failed after a measured turn", "codex", "fail-usage", "provider_failed"],
  ["codex-stdio, no final answer", "codex", "empty", "provider_empty"], ["devin-stdio, its CLI failed", "devin", "fail", "provider_failed"], ["devin-stdio, no final answer", "devin", "empty", "provider_empty"]] as const)
  test(`RS3 №4414: a ${name} failure of a paid analyst turn is provider-failed — the next research-stage entry is a new generation of the same step, and the saved attempt stays byte for byte`, async t => {
    const failure = rs3RealFailure(t, adapter, cli);
    assert.equal(failure.code, expected, "The adapter's structured error line");
    const f = rs3Fixture(t, [failure]);
    const first = await f.engine.researcher.run("p", f.draft.id, 1);
    assert.deepEqual([first.value.status, first.value.pauseCode], ["paused", "research_provider_failed"]);
    const [refused] = f.intents();
    assert.deepEqual([refused!.value.generation, refused!.value.state, refused!.value.refusal?.kind, refused!.value.refusal?.code],
      [0, "refused", "provider-failed", "provider_failed_without_response"]);
    const saved = f.store.list().filter(row => ["model-call", "model-response", "model-request", "research-context", "research-consumer-intent"].includes(row.kind))
      .map(row => f.store.history(row.id).map(revision => [revision.id, revision.revision, revision.hash]));
    const second = await f.engine.execute({ type: "research-stage", project: "p", draftId: f.draft.id, maxTurns: 1 }) as { status: string };
    assert.notEqual(second.status, "failed");
    const generations = f.intents();
    assert.deepEqual(generations.map(row => [row.value.generation, row.value.state]), [[0, "refused"], [1, "applied"]], "One new generation of the same step");
    assert.deepEqual(generations[1]!.value.previous, reference(refused!));
    assert.equal(f.calls(), 2, "One new physical call");
    for (const history of saved) for (const [id, revision, hash] of history) assert.equal(f.store.get(id as string, revision as number)!.hash, hash, `${id}@${revision} is unchanged`);
    assert.deepEqual(rs3ReadIntent(new Store(join(f.root, "state.sqlite")), reference(refused!)).value.refusal?.kind, "provider-failed", "A reopened store reads the same outcome");
  });

const RS3_PRIOR: [string, Rs3Step, string][] = [
  ["an envelope with research", { stdout: '{"protocol":"omg-agent/v1","requestId":"$REQUEST","research":{"action":"pause","reason":"x"},"usage":null}\n', stderr: "", exit: 1 }, "research_provider_failed"],
  ["a foreign request's envelope", { stdout: '{"protocol":"omg-agent/v1","requestId":"another-request","usage":null}\n', stderr: '{"error":"provider_failed","message":"x"}\n', exit: 1 }, "research_provider_failed"],
  ["an envelope with another field", { stdout: '{"protocol":"omg-agent/v1","requestId":"$REQUEST","usage":null,"error":"provider_failed"}\n', stderr: '{"error":"provider_failed","message":"x"}\n', exit: 1 }, "research_provider_failed"],
  ["a signal after the envelope", { stdout: '{"protocol":"omg-agent/v1","requestId":"$REQUEST","usage":null}\n', stderr: '{"error":"provider_failed","message":"x"}\n', exit: 0, signal: true }, "research_provider_failed"],
  ["a bare envelope without the adapter's structured error line", { stdout: '{"protocol":"omg-agent/v1","requestId":"$REQUEST","usage":null}\n', stderr: "provider unavailable", exit: 1 }, "research_provider_failed"],
  ["a bare envelope under another structured error", { stdout: '{"protocol":"omg-agent/v1","requestId":"$REQUEST","usage":null}\n', stderr: '{"error":"adapter_failed","message":"Unexpected token"}\n', exit: 1 }, "research_provider_failed"],
];
for (const [name, adapter, cli, expected] of [["codex-stdio, an answer it cannot read", "codex", "garbage", "adapter_failed"], ["devin-stdio, an answer it cannot read", "devin", "garbage", "provider_result_invalid"]] as const)
  test(`RS3 №4426: the bare envelope of ${name} (${expected}) — the model may have answered: the prior terminal, restored as the run's typed pause on a repeat`, async t => {
    const failure = rs3RealFailure(t, adapter, cli);
    assert.equal(failure.code, expected);
    const f = rs3Fixture(t, [failure]);
    await f.engine.researcher.run("p", f.draft.id, 1);
    const [refused] = f.intents();
    assert.deepEqual([refused!.value.state, refused!.value.refusal?.kind, refused!.value.refusal?.code], ["refused", "terminal", "research_provider_failed"]);
    const again = await f.engine.researcher.run("p", f.draft.id, 1);
    assert.deepEqual([again.value.status, again.value.pauseCode], ["paused", "research_provider_failed"]);
    assert.equal(f.calls(), 1); assert.equal(f.intents().length, 1);
  });
for (const [name, step, code] of RS3_PRIOR)
  test(`RS3 №4414: ${name} keeps its prior terminal outcome — and a repeat research-stage restores it as the run's typed pause, never a different saved admission`, async t => {
    const f = rs3Fixture(t, [step]);
    const first = await f.engine.researcher.run("p", f.draft.id, 1);
    assert.equal(first.value.status, "paused");
    const [refused] = f.intents();
    assert.deepEqual([refused!.value.state, refused!.value.refusal?.kind], ["refused", "terminal"], `not provider-failed: ${JSON.stringify(refused!.value.refusal)}`);
    assert.equal(refused!.value.refusal?.code, step.signal ? refused!.value.refusal?.code : code);
    const before = f.store.list().map(row => [row.id, row.revision]);
    for (const attempt of [1, 2]) {
      const again = await f.engine.researcher.run("p", f.draft.id, 1);
      assert.deepEqual([again.value.status, again.value.pauseCode], ["paused", refused!.value.refusal?.code], `attempt ${attempt}: ${again.value.error}`);
      assert.doesNotMatch(again.value.error ?? "", /different saved admission/);
    }
    assert.equal(f.calls(), 1, "The saved outcome is restored; nothing is sent again");
    assert.deepEqual(f.intents().length, 1);
    const run = f.store.list<ResearchRun>("research-run")[0]!;
    assert.deepEqual(f.store.list().filter(row => row.id !== run.id).map(row => [row.id, row.revision]), before.filter(([id]) => id !== run.id));
  });

test("RS3 №4414 window: a guarded head moved by a second Store between the new generation's preparation and its write refuses it whole — no generation 1, the refused attempt unchanged", async t => {
  const f = rs3Fixture(t, [rs3RealFailure(t, "codex")]);
  await f.engine.researcher.run("p", f.draft.id, 1);
  const [refused] = f.intents();
  assert.equal(refused!.value.refusal?.kind, "provider-failed");
  const original = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = ((writes: Write[], guards?: Parameters<Store["writeMany"]>[1]) => {
    if (!raced && writes.some(write => write.kind === "research-consumer-intent" && write.expected === 0 && (write.value as { generation?: number }).generation === 1)) {
      raced = true;
      const other = new Store(join(f.root, "state.sqlite"));
      try { const head = other.get("environment:p")!; other.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value }); }
      finally { other.close(); }
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  const result = await f.engine.researcher.run("p", f.draft.id, 1);
  f.store.writeMany = original;
  assert.ok(raced);
  assert.equal(result.value.status, "paused");
  assert.deepEqual(f.intents().map(row => row.value.generation), [0], "Nothing of the lost transaction is written");
  assert.deepEqual(f.store.get(refused!.id)!.hash, refused!.hash);
  assert.equal(f.calls(), 1);
});

test("RS3 №4414 era: the base engine 8b665772 (from Git, its own process) saved the codex-stdio envelope failure as its terminal research_provider_failed; the new code reads it in its era and DS1 requires upgrade before a new paid generation", async t => {
  const failure = rs3RealFailure(t, "codex");
  const root = mkdtempSync(join(tmpdir(), "omg-rs3-era-")), era = join(root, "era"), data = join(root, "data"), archive = join(root, "archive.tar");
  mkdirSync(era); mkdirSync(data); t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, "8b665772db79"]);
  try {
    execFileSync("tar", ["-xf", archive, "-C", era]);
  } finally {
    rmSync(archive, { force: true });
  }
  symlinkSync(resolve("node_modules"), join(era, "node_modules"));
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", join(era, "tsconfig.json")], { cwd: era });
  writeFileSync(join(data, "adapter.mjs"), RS3_ADAPTER);
  writeFileSync(join(data, "rs3.json"), JSON.stringify([failure]));
  const producer = join(era, "rs3-old-producer.mjs");
  writeFileSync(producer, `import{writeFileSync}from'node:fs';
import{Store}from'./dist/src/storage/store.js';import{ProductEngine}from'./dist/src/product/engine.js';import{researchInput}from'./dist/test/preparation-fixture.js';
const root=${JSON.stringify(data)},store=new Store(root+'/state.sqlite'),engine=new ProductEngine(store);
engine.execute({type:'create-project',project:'p',title:'Old producer'});
const command={executable:process.execPath,args:[root+'/adapter.mjs','normal',root+'/calls.txt']};
engine.environments.configure('p',{workspace:root,implementer:{actor:'researcher',model:'protocol-fixture',effort:'high',command},reviewer:{actor:'assessor',model:'protocol-fixture',effort:'high',command},fullCheck:{executable:process.execPath,args:['--version']},timeoutMs:2000},0);
engine.discovery.evidence.document('p','brief',researchInput('p','Input','Owner outcome'),'application/json',0);
const draft=engine.prepare('p','discovery');const run=await engine.researcher.run('p',draft.id,1);
writeFileSync(root+'/expected.json',JSON.stringify({draft:draft.id,run,records:store.list().map(row=>store.history(row.id)).flat()}));store.close();`);
  execFileSync(process.execPath, [producer], { cwd: era, maxBuffer: 4 << 20 });
  const expected = JSON.parse(readFileSync(join(data, "expected.json"), "utf8")) as { draft: string; run: { value: ResearchRun }; records: { id: string; revision: number; hash: string }[] };
  assert.deepEqual([expected.run.value.status, expected.run.value.pauseCode], ["paused", "research_provider_failed"]);
  const store = new Store(join(data, "state.sqlite")); t.after(() => store.close());
  const intents = () => store.list<Rs3Intent>("research-consumer-intent").filter(row => row.value.kind === "analyst").sort((a, b) => a.value.generation - b.value.generation);
  const [old] = intents();
  assert.deepEqual([old!.value.generation, old!.value.state, old!.value.refusal?.kind, old!.value.refusal?.code], [0, "refused", "terminal", "research_provider_failed"],
    "The base classified the envelope failure as its terminal");
  assert.deepEqual(rs3ReadIntent(store, reference(old!)), old, "The new reader proves it in its era");
  const result = await new ProductEngine(store).execute({ type: "research-stage", project: "p", draftId: expected.draft, maxTurns: 1 }) as { status: string };
  assert.equal(result.status, "paused");
  assert.deepEqual(intents().map(row => [row.value.generation, row.value.state]), [[0, "refused"]]);
  assert.equal(readFileSync(join(data, "calls.txt"), "utf8").trim().split("\n").filter(role => !role.startsWith("assess")).length, 1);
  for (const record of expected.records) assert.equal(store.get(record.id, record.revision)!.hash, record.hash, `${record.id}@${record.revision} is unchanged`);
  const reopened = new Store(join(data, "state.sqlite")); t.after(() => reopened.close());
  assert.deepEqual(rs3ReadIntent(reopened, reference(old!)), old);
});

test("RS3 №4414: an assessor failing with the codex-stdio envelope is a provider failure of the assessment — the proposed answer survives and the next entry assesses it again without calling its researcher", async t => {
  const f = rs3Fixture(t, [{ ...rs3RealFailure(t, "codex"), role: "assess-answer" }]);
  const first = await f.engine.researcher.run("p", f.draft.id, 8);
  assert.equal(first.value.status, "paused", JSON.stringify(first.value));
  const candidate = f.store.list<ResearchTurn>("research-turn").find(turn => turn.value.status === "pending")!;
  assert.ok(candidate, "The proposed answer waits for its assessment");
  const second = await f.engine.researcher.run("p", f.draft.id, 8);
  assert.equal(second.value.status, "completed", JSON.stringify(second.value));
  const roles = readFileSync(join(f.root, "calls.txt"), "utf8").trim().split("\n");
  assert.equal(roles.filter(role => role === "research").length, f.draft.value.questions.length + 1, "The researcher is not called again for the assessed answer");
  assert.ok(roles.filter(role => role === "assess-answer").length >= 2, "The assessment is asked again");
  assert.equal(f.store.get<ResearchTurn>(candidate.id)!.value.status, "completed");
});

async function structuredWebSource(f: { root: string; store: Store; engine: ProductEngine }, content: string, key = 'web') {
  const { projectId: _project, ...old } = f.engine.environments.get('p').value;
  const environment = f.engine.environments.configure('p', { ...old,
    webResearch: { enabled: true, gatewayUrl: 'http://127.0.0.1:18890', timeoutMs: 5000,
      budgetContract: 'web-budget/v2', limits: { materialChars: 2_000_000, responseBytes: 16_000_000 } } },
  f.engine.environments.get('p').revision);
  const run = f.store.write({ id: `research-run:sr1c:${key}`, kind: 'research-run', expected: 0,
    value: { projectId: 'p', draftId: `sr1c-source:${key}` } });
  const url = `https://example.org/${key}.md`;
  const turn = f.store.write<ResearchTurn>({ id: `research-turn:sr1c:${key}`, kind: 'research-turn', expected: 0,
    value: { run: run.id, number: 1, action: { action: 'web_fetch', url, purpose: 'saved document' },
      status: 'pending', assessment: null, observation: null, error: null, question: null } });
  const bytes = Buffer.from(content);
  const result = await executeWebTurn({ store: f.store, projectId: 'p', stage: 'discovery', environment, turn,
    transport: async () => ({ status: 200, body: { contract: 'web-document/v2', requested_url: url,
      selected_url: url, final_url: url, fetched_at: '2026-10-16T00:00:00.000Z', status: 200, success: true,
      failure: null, redirects: [], attempts: [],
      raw: { encoding: 'base64', data: bytes.toString('base64'), byteLength: bytes.length, sha256: digest(bytes), mediaType: 'text/markdown' },
      clean: { text: content, utf16Length: content.length, sha256: digest(content), mediaType: 'text/markdown' },
      method: { kind: 'native-markdown', version: 'sr1c-fixture/v1' },
      signals: { rawTruncated: false, cleanTruncated: false, completeness: 'unknown' } } }) });
  return result.source!;
}

for (const stage of UPSTREAM_STAGES) test(`SR1c ${stage}: actual web Source 59513 is delivered whole and replayed after restart`, async t => {
  const f = fixture(t); preparedFeatures(f.engine, 'p'); f.configure('p');
  const source = await structuredWebSource(f, '# Intro\n' + 'z'.repeat(59_505));
  assert.equal(source.value.content.length, 59_513);
  const draft = f.engine.prepare('p', stage);
  writeFileSync(join(f.root, 'adapter.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(join(f.root, 'calls.txt'))},JSON.stringify(r)+'\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_source',source:${JSON.stringify(reference(source))},start:10,end:20}}));`.replace("+'\n'", "+'\\n'"));
  const run = await f.engine.researcher.run('p', draft.id, 1);
  const turn = f.store.list<ResearchTurn>('research-turn').find(item => item.value.run === run.id && (item.value.action as any).action === 'read_source')!;
  assert.ok(turn, JSON.stringify(run.value));
  const reading = turn.value.observation as any;
  assert.equal(reading.contract, 'source-read/v3'); assert.equal(reading.value, source.value.content);
  assert.equal(reading.documentComplete, true); assert.equal(reading.expanded, true);
  const reopened = new Store(join(f.root, 'state.sqlite')); t.after(() => reopened.close());
  assert.deepEqual(readResearchConsumerTurn(reopened, reference(turn)), turn);
  const request = JSON.parse(readFileSync(join(f.root, 'calls.txt'), 'utf8').trim());
  assert.match(request.prompt, /source-read\/v3/); assert.match(JSON.stringify(request.subject), /source-read\/v3/);
  assert.match(JSON.stringify(request.subject), /source-toc-page\/v1/);
  assert.equal(reopened.list('model-call').length, 1);
});

for (const action of ['read_source', 'search'] as const)
  test(`SR1c paid ${action} -> loss before local completion -> restart -> exact replay without new model or HTTP`, async t => {
    const f = fixture(t); f.configure('p');
    const source = await structuredWebSource(f, '# Part\n' + 'data '.repeat(12_001) + 'Needle.');
    const draft = f.engine.prepare('p', 'discovery');
    const value = action === 'read_source' ? { action, source: reference(source), start: 0, end: source.value.content.length }
      : { action, query: 'Needle' };
    writeFileSync(join(f.root, 'adapter.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(join(f.root, 'calls.txt'))},'call\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:${JSON.stringify(value)}}));`);
    const write = f.store.writeMany.bind(f.store); let lost = false;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!lost && writes.some(w => w.kind === 'research-turn' && (w.value as any).status === 'completed')) {
        lost = true; throw new EngineError('input_stale', 'Local completion interrupted');
      }
      return write(writes, guards);
    }) as typeof f.store.writeMany;
    await f.engine.researcher.run('p', draft.id, 1); f.store.writeMany = write; assert.ok(lost);
    const calls = f.store.list('model-call'), responses = f.store.list('model-response'), captures = f.store.list('web-capture');
    const reopened = new Store(join(f.root, 'state.sqlite')); t.after(() => reopened.close());
    const run = await new ProductEngine(reopened).researcher.run('p', draft.id, 1);
    const turn = reopened.list<ResearchTurn>('research-turn').find(item => item.value.run === run.id && (item.value.action as any).action === action)!;
    assert.equal(turn.value.status, 'completed', JSON.stringify(run.value));
    assert.deepEqual(readResearchConsumerTurn(reopened, reference(turn)), turn);
    assert.deepEqual(reopened.list('model-call'), calls); assert.deepEqual(reopened.list('model-response'), responses);
    assert.deepEqual(reopened.list('web-capture'), captures);
    assert.equal(readFileSync(join(f.root, 'calls.txt'), 'utf8').trim(), 'call');
    if (action === 'read_source') {
      const observation = turn.value.observation as any;
      assert.equal(observation.outcome, 'overview'); assert.equal(observation.selector, null); assert.equal(observation.documentComplete, false);
    } else assert.equal((turn.value.observation as any).contract, 'research-search-capture/v2');
  });

test('SR1c mixed-source search counts repository text, exact heading ranges and last fragment clipping in one envelope', async t => {
  const f = fixture(t); f.configure('p');
  const content = ('Needle ' + 'x'.repeat(990) + '\n\n').repeat(65);
  const source = await structuredWebSource(f, content);
  const legacy = f.engine.discovery.evidence.document('p', 'legacy', 'Needle old text', 'text/plain', 0);
  const facts = [{ ref: reference(source), value: source.value }, { ref: reference(legacy), value: legacy.value }];
  const result = projectResearchSearchObservationV2('Needle', facts,
    { stdout: 'repository matches'.repeat(4000), status: 0, signal: null, error: null });
  assert.ok(result.displayedChars <= 50_000); assert.equal(result.hasMore, true); assert.equal(result.truncated, true);
  assert.equal(result.displayedChars, result.repositoryMatches.length + result.sources.reduce((sum, row) =>
    sum + row.excerpt.length + (row.heading?.text.length ?? 0) + (row.sectionPath ?? []).reduce((n, part) => n + (part.title?.length ?? 0), 0), 0));
  const one = projectResearchSearchObservationV2('Needle', [facts[0]!], { stdout: '', status: 1, signal: null, error: null });
  assert.equal(one.delivered, 1); assert.equal(one.truncated, true, 'partial final fragment is explicit even if all fragments were selected');
});

test('SR1c grouped overview/read/search and synthesis retain exact v3 material without claiming a body read', async t => {
  const f = await rs1BundleFixture(t);
  const source = await structuredWebSource(f, '# One\n' + 'x'.repeat(60_000) + ' Needle.');
  const legacy = f.engine.discovery.evidence.document('p', 'sr1c-mixed', 'Needle legacy material', 'text/plain', 0);
  const settings: Record<string, unknown> = { ...f.pilot.value }; delete settings.projectId;
  const pilot = configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 100_000, maxRounds: 3 } }, f.pilot.revision);
  const ref = reference(source);
  writeFileSync(join(f.root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_plan',question:r.subject.question.id,reads:[
{action:'read_source',source:${JSON.stringify(ref)},start:0,end:${source.value.content.length}},
{action:'read_source',source:${JSON.stringify(ref)},start:6,end:100},
{action:'search',query:'Needle'}]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  await f.engine.researcher.run('p', f.question.value.draftId, 4);
  const children = f.store.list<ResearchTurn>('research-turn').filter(turn => turn.value.plannedBy)
    .sort((a, b) => a.value.number - b.value.number);
  assert.equal(children.length, 3);
  assert.equal((children[0]!.value.observation as any).outcome, 'overview');
  assert.equal((children[1]!.value.observation as any).contract, 'source-read/v3');
  assert.equal((children[2]!.value.observation as any).contract, 'research-search-capture/v2');
  for (const turn of children) assert.deepEqual(readResearchConsumerTurn(f.store, reference(turn)), turn);
  const overview = children[0]!.value.observation;
  writeFileSync(join(f.root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'Fixture end'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const environment = f.engine.environments.get('p');
  const context = { ...pilotContext(f.store, f.draft, f.question), workingSelections: [{ kind: 'context', value: overview },
    { kind: 'context', value: children[2]!.value.observation }] };
  const result = await synthesisSession(f.store, f.draft, f.question, environment, pilotEnvironment(environment.value, pilot.value),
    pilot, context, 'Use only delivered body evidence');
  assert.equal(result.action, 'pause');
  const session = f.store.list<any>('synthesis-session')[0]!;
  const restarted = new Store(join(f.root, 'state.sqlite')); t.after(() => restarted.close());
  assert.deepEqual(readSynthesisSession(restarted, reference(session)), session);
  const body = { inventory: new ResearchSources(f.store, 'p', f.root).inventory(), focus: overview,
    workingSelections: [{ kind: 'context', value: overview }] };
  const initial = workingContext(f.store, 'p', f.draft.id, f.question.id, body, 50_000, { common: true });
  const continued = workingContext(f.store, 'p', f.draft.id, f.question.id, body, 50_000, { continuation: true, previous: initial.working.archive });
  assert.ok(continued.sourceCatalogue); assert.match(JSON.stringify(continued), /overview/);
  assert.match(JSON.stringify(continued), /documentComplete.*false/);
  new ProductEngine(restarted).discovery.evidence.document('p', 'sr1c-mixed', 'Changed owner material', 'text/plain', legacy.revision);
  const calls = restarted.list('model-call');
  await assert.rejects(synthesisSession(restarted, f.draft, f.question, environment, pilotEnvironment(environment.value, pilot.value),
    pilot, context, 'Use only delivered body evidence'), { code: 'synthesis_evidence_stale' });
  assert.deepEqual(restarted.list('model-call'), calls);
  assert.deepEqual(readResearchConsumerTurn(restarted, reference(children[2]!)), children[2], 'historical search uses its exact source revisions');
});

test('SR1c mixed Source search applies ten-fragment cap once to the entire response', async t => {
  const f = fixture(t); f.configure('p');
  for (let i = 0; i < 4; i++) await structuredWebSource(f,
    Array.from({ length: 3 }, (_, j) => `# Section ${i}/${j}\nNeedle ${'x'.repeat(220)}\n`).join(''), `mixed-${i}`);
  const result = new ResearchSources(f.store, 'p', f.root).search('Needle') as any;
  assert.equal(result.found, 12); assert.equal(result.delivered, 10);
  assert.equal(result.sources.length, 10); assert.equal(result.hasMore, true);
  assert.ok(result.displayedChars <= 50_000);
});

for (const planned of [false, true]) test(`SR1c R2 multiprocess: ${planned ? 'planned' : 'ordinary'} search capture and turn reject a changed Source without repayment`, async t => {
  const f = planned ? await rs1BundleFixture(t) : fixture(t);
  if ('configure' in f) f.configure('p');
  await structuredWebSource(f, '# Part\nNeedle structured document.');
  const legacy = f.engine.discovery.evidence.document('p', 'changing', 'Needle original', 'text/plain', 0);
  const second = new Store(join(f.root, 'state.sqlite')); t.after(() => second.close());
  const draft = 'draft' in f ? f.draft : f.engine.prepare('p', 'discovery');
  if ('pilot' in f) {
    const settings: Record<string, unknown> = { ...f.pilot.value }; delete settings.projectId;
    configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
      planning: { fields: [f.question.value.spec.field], maxRequestChars: 100_000, maxRounds: 3 } }, f.pilot.revision);
  }
  writeFileSync(join(f.root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:
${planned ? "{action:'read_plan',question:r.subject.question.id,reads:[{action:'search',query:'Needle'}]}" : "{action:'search',query:'Needle'}"}}));`);
  const write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.some(row => row.kind === 'research-search-capture')) {
      changed = true;
      const script = `import {Store} from ${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import {ProductEngine} from ${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(process.argv[1]);try{new ProductEngine(store).discovery.evidence.document('p','changing','Needle revised','text/plain',${legacy.revision});}finally{store.close();}`;
      execFileSync(process.execPath, ['--input-type=module', '-e', script, join(f.root, 'state.sqlite')], { timeout: 10_000 });
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  const paused = await f.engine.researcher.run('p', draft.id, planned ? 2 : 1); f.store.writeMany = write;
  assert.equal(changed, true); assert.equal(paused.value.status, 'paused'); assert.equal(paused.value.pauseCode, 'input_stale');
  assert.equal(f.store.list('research-search-capture').length, 0);
  const calls = f.store.list('model-call'), responses = f.store.list('model-response');
  const resumed = await new ProductEngine(second).researcher.run('p', draft.id, planned ? 2 : 1);
  const capture = second.list<any>('research-search-capture')[0]!;
  assert.equal(capture.value.contract, 'research-search-capture/v2');
  assert.deepEqual(capture.value.sources.find((row: any) => row.id === legacy.id), reference(second.get(legacy.id)!));
  const turn = second.list<ResearchTurn>('research-turn').find(row => row.value.run === resumed.id && (row.value.action as any).action === 'search')!;
  assert.equal(turn.value.status, 'completed'); assert.deepEqual(readResearchConsumerTurn(second, reference(turn)), turn);
  assert.deepEqual(second.list('model-call'), calls); assert.deepEqual(second.list('model-response'), responses);
});

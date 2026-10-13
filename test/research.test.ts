import { hashJson } from '../src/canonical.js';
import { execFileSync } from 'node:child_process';
import { EngineError } from '../src/errors.js';
import type { Write } from '../src/storage/store.js';
import { readResearchConsumerTurn } from '../src/discovery/response-recovery.js';
import { readBundle, readReaderResultAt, resumeReadBundleIntent, readerResumeStep } from '../src/discovery/reader.js';
import { configureReaderPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { latestFocus } from '../src/discovery/research-continuation.js';
import { pilotContext, readPilotContext, retainPilotRead } from '../src/discovery/pilot-context.js';
import { preparedFeatures } from './product-fixture.js';
import type { Question } from '../src/discovery/discovery.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { reference } from "../src/pipeline/contracts.js";
import type { ResearchRun, ResearchTurn } from "../src/discovery/research-model.js";
import type { FieldSpec } from "../src/discovery/discovery.js";
import { researchInput } from "./preparation-fixture.js";

// Protocol fixture, not a claim of live-model research quality. The assessor's
// controlled responses let the test isolate whether the engine enforces them.
const ADAPTER = `import {readFileSync,appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
const req=JSON.parse(readFileSync(0,'utf8')), c=req.subject, scenario=process.argv[2];
if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
if(c.currentRead)c.history=[...(c.history??[]),c.currentRead];
appendFileSync(process.argv[3],c.role+'\\n');
if(scenario==='failure') {process.stderr.write('provider unavailable');process.exit(1)}
const reply=research=>console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));
if(c.role==='assess-answer') {
 if(scenario==='assessor-retry'&&!existsSync(process.argv[3]+'.retry')) {writeFileSync(process.argv[3]+'.retry','started');process.stderr.write('assessor unavailable');process.exit(1)}
 const same=c.observations.some(o=>isDeepStrictEqual(o.value,c.value??c.focus?.value??c.observations[0]?.value));
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
  reply({action:'answer',question:q.id,value:values[q.field],citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]});
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

test("research command connects a process provider, evidence assessment and downstream acceptance for two products", async t => {
  const { store, engine, configure } = fixture(t);
  for (const project of ["garden", "inventory"]) {
    configure(project);
    engine.discovery.evidence.document(project, "brief", researchInput(project), "application/json", 0);
    const draft = engine.prepare(project, "discovery");
    const run = await engine.execute({ type: "research-draft", project, draftId: draft.id, maxTurns: 4 }) as { value: ResearchRun };
    assert.equal(run.value.status, "completed", JSON.stringify({run:run.value,turns:store.list<ResearchTurn>("research-turn").map(t=>({action:(t.value.action as {action:string}).action,error:t.value.error}))})); assert.equal(run.value.ownerQuestion, null);
    const content = engine.draft(project, "discovery", draft.id, 0);
    engine.pipeline.accept(project, "discovery", content.revision);
    assert.equal(engine.pipeline.inspect(project, "discovery").state, "accepted");
    const count = store.list("research-turn").length;
    await engine.researcher.run(project, draft.id, 4);
    assert.equal(store.list("research-turn").length, count, "A completed unchanged draft must not call the model again");
    const next = engine.prepare(project, "discovery");
    const reused = await engine.researcher.run(project, next.id, 4);
    assert.equal(reused.value.status, "completed"); assert.equal(reused.value.turns, 0);
    assert.equal(store.list("research-turn").length, count, "The same stage questions and input versions reuse assessed evidence");
    engine.discovery.evidence.document(project, "brief", researchInput(project, "Changed source", "Changed owner intent"), "application/json", 1);
    assert.equal(engine.pipeline.inspect(project, "discovery").state, "stale");
    const refreshed = await engine.researcher.run(project, draft.id, 4);
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
  const third = await engine.researcher.run("p", draft.id, 2);
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
  const draft = engine.prepare("p", "discovery"); const first = await engine.researcher.run("p", draft.id, 4);
  assert.equal(first.value.status, "paused");
  const candidate = store.list<ResearchTurn>("research-turn").find(turn => turn.value.status === "pending")!;
  assert.equal(candidate.value.status, "pending");
  assert.equal((candidate.value.action as { value: string }).value, "Input");
  const second = await engine.researcher.run("p", draft.id, 4);
  assert.equal(second.value.status, "completed");
  assert.equal(readFileSync(join(root, "calls.txt"), "utf8").split("\n").filter(role => role === "research").length, draft.value.questions.length + 1);
  assert.equal(store.get<ResearchTurn>(candidate.id)!.value.status, "completed");
});

test("owner answer arriving during escalation assessment prevents publication of a stale question", async t => {
  const { engine, configure, root } = fixture(t, "race"); configure("p");
  engine.discovery.evidence.document("p", "brief", "Destination has not yet been selected.", "text/plain", 0);
  const draft = engine.discovery.create("p", "discovery", "R0", "concept", [{ field: "destination", kind: "decision",
    prompt: "Which destination did the owner choose?", risk: "No target", schema: { type: "string" } }]);
  const pending = engine.researcher.run("p", draft.id, 4);
  for (let attempts = 0; !existsSync(join(root, "calls.txt.awaiting")); attempts++) {
    assert.ok(attempts < 200, "Assessor did not reach the controlled await window");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  engine.discovery.decision(draft.value.questions[0]!, 1, "owner", "Local export");
  const result = await pending;
  assert.notEqual(result.value.status, "needs_owner"); assert.equal(result.value.ownerQuestion, null);
  assert.equal((await engine.researcher.run("p", draft.id, 4)).value.status, "completed");
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
  const root = mkdtempSync(join(tmpdir(), 'omg-rs1-era-')), era = join(root, 'era'); mkdirSync(era);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = execFileSync('git', ['archive', '94af9c4ac0a06ca1ee911d626356e07ab7850c04'], { maxBuffer: 80 << 20 });
  execFileSync('tar', ['-xf', '-', '-C', era], { input: archive });
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
const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(join(root, 'calls.txt'))},'planner\\n');
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

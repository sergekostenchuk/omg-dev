import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision, type Write, type ReadGuard } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES, REQUIREMENTS } from "../src/discovery/requirements.js";
import { preparedField } from "./preparation-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { buildL1, designOf } from "../src/graph/builder.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { StageResearchResult } from "../src/product/stage-research.js";
import { consumerFeedback, rejectResearch, type ConsumerFeedback } from "../src/discovery/consumer-feedback.js";
import { researchGraphContext, researchPrerequisites } from "../src/discovery/research-context.js";
import type { Json } from "../src/canonical.js";

// Controlled process provider proves routing/acceptance, not live model quality.
const ADAPTER = `import {readFileSync,appendFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
appendFileSync(process.argv[3],JSON.stringify({role:c.role,field:c.questions?.[0]?.field,feedback:c.consumerFeedback})+'\\n');
if(process.argv[4]==='fail')process.exit(1);
let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else {const q=c.questions[0],source=c.inventory.sources.find(s=>s.location==='values'),values=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const value=structuredClone(values[q.field]);
 if(q.field==='conceptSections'&&(!c.consumerFeedback.length||process.argv[4]==='stuck'))value[0].requirements[0].outcome='descriptive prose, not an outcome ID';
 if(q.field==='mapDesign'&&!c.consumerFeedback.length) {
   if(process.argv[4]==='drift')value.contracts[0].schema.description='Changed meaning of a stable connector';
   else value.nodes[0].outcome='missing-artifact';
 }
 research={action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
}console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));`;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-stage-research-"));
  const path = join(root, "state.sqlite"); const store = new Store(path); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "adapter.mjs"), ADAPTER);
  function setup(project: string, scenario = "normal") {
    engine.execute({ type: "create-project", project, title: project });
    const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
      spec.field === "mapDesign" ? designOf(enrichedGraph(exampleGraph(project), project)) : preparedField(project, spec.field)])));
    const values = join(root, `${project}.json`); writeFileSync(values, JSON.stringify(fields));
    engine.discovery.evidence.document(project, "values", JSON.stringify(fields), "application/json", 0);
    const command = { executable: process.execPath, args: [join(root, "adapter.mjs"), values, join(root, `${project}.calls`), scenario] };
    engine.environments.configure(project, { workspace: root,
      implementer: { actor: "author", model: "fixture", effort: "high", command },
      reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
      fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 4000 }, 0);
  }
  return { root, path, store, engine, setup };
}

test("stage command automatically repairs consumer rejections and accepts all upstream stages for two products", async t => {
  const { engine, store, root, setup } = fixture(t);
  for (const project of ["garden", "invoice"]) {
    setup(project);
    for (const stage of UPSTREAM_STAGES) {
      const draft = engine.prepare(project, stage);
      if (stage === "operation-map") {
        const prior = researchPrerequisites(store, draft.value).find(item => item.stage === "discovery")!;
        assert.ok((prior.fields['preparation'] as { journeys?: unknown }).journeys, "L1 receives accepted scenario obligations without a manually copied source");
      }
      const result = await engine.execute({ type: "research-stage", project, draftId: draft.id, maxTurns: 8 }) as StageResearchResult;
      assert.equal(result.status, "accepted", JSON.stringify(result));
      assert.equal(engine.pipeline.inspect(project, stage).state, "accepted");
      const count = store.list("research-turn").length;
      const again = await engine.stageResearch.run(project, draft.id, 8);
      assert.equal(again.status, "accepted"); assert.equal(store.list("research-turn").length, count);
      assert.equal(again.stage!.revision, result.stage!.revision, "Accepted stage is not republished");
    }
    const feedback = store.list<ConsumerFeedback>("research-feedback").filter(item => item.value.projectId === project);
    assert.equal(feedback.length, 2);
    assert.ok(feedback.some(item => item.value.findings.some(finding => finding.code === "requirement_outcome_missing")));
    assert.ok(feedback.some(item => item.value.findings.some(finding => finding.field === "mapDesign")));
    const concept = store.get<DiscoveryDraft>(feedback.find(item => item.value.findings[0]!.field === "conceptSections")!.value.draft.id)!;
    assert.ok(concept.value.questions.filter(id => store.get<Question>(id)!.value.spec.field !== "conceptSections")
      .every(id => store.get<Question>(id)!.revision === 2), "Unrelated answers were not reopened");
    const calls = readFileSync(join(root, `${project}.calls`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(calls.some(call => call.role === "assess-answer" && call.feedback.length), "Assessor receives the same actual rejection");
    assert.equal(store.list("source").filter(item => (item.value as {projectId:string}).projectId === project).length, 1,
      "Engine diagnostics are not mislabeled owner documents");
  }
});

test("exhausted stage allowance preserves feedback and resumes exact rejected question after reopening SQLite", async t => {
  const { store, path, engine, setup } = fixture(t); setup("p");
  const first = engine.prepare("p", "discovery"); await engine.stageResearch.run("p", first.id, 3);
  const draft = engine.prepare("p", "concept");
  const paused = await engine.stageResearch.run("p", draft.id, 4);
  assert.equal(paused.status, "paused"); assert.ok(paused.feedback);
  assert.equal(engine.pipeline.inspect("p", "concept").state, "blocked");
  const questions = draft.value.questions.map(id => store.get<Question>(id)!);
  assert.deepEqual(questions.filter(q => q.value.status === "open").map(q => q.value.spec.field), ["conceptSections"]);
  const reopened = new Store(path);
  try {
    const next = new ProductEngine(reopened); const result = await next.stageResearch.run("p", draft.id, 1);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.deepEqual(consumerFeedback(reopened, reopened.get<DiscoveryDraft>(draft.id)!.value), []);
  } finally { reopened.close(); }
});

test("stage command rejects missing/foreign inputs and provider failure never accepts or asks the owner", async t => {
  const { engine, store, setup } = fixture(t); setup("p", "fail"); setup("q");
  assert.throws(() => engine.execute({ type: "research-stage", project: "p", maxTurns: 2 }), { code: "command_invalid" });
  const draft = engine.prepare("p", "discovery");
  await assert.rejects(engine.stageResearch.run("q", draft.id, 2), { code: "discovery_foreign" });
  const result = await engine.stageResearch.run("p", draft.id, 2);
  assert.equal(result.status, "paused"); assert.equal(result.stage, null);
  assert.equal(store.list("research-feedback").length, 0);
  assert.equal((store.get(result.research!.id)!.value as {ownerQuestion:unknown}).ownerQuestion, null);
  assert.equal(engine.pipeline.inspect("p", "discovery").state, "missing");
});

test("feedback cannot reopen a foreign field or race a revised proposal", async t => {
  const { engine, store, setup } = fixture(t); setup("p");
  const draft = engine.prepare("p", "discovery"); await engine.researcher.run("p", draft.id, 3);
  const current = store.get<DiscoveryDraft>(draft.id)!;
  const invalid = [{ code: "invalid", target: draft.id, message: "No known field" }];
  assert.throws(() => rejectResearch(store, current, invalid, []), { code: "feedback_target_missing" });
  const findings = [{ ...invalid[0]!, field: "preparation" }];
  const question = current.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === "objective")!;
  engine.discovery.reopen(question.id, question.revision);
  engine.discovery.decision(question.id, question.revision + 1, "owner", "New purpose");
  assert.throws(() => rejectResearch(store, current, findings, []), { code: "input_stale" });
  assert.equal(store.list("research-feedback").length, 0, "Feedback and reopen are one transaction");
  assert.equal(store.get<Question>(current.value.questions.find(id => store.get<Question>(id)!.value.spec.field === "preparation")!)!.value.status, "answered");
});

test("repeated consumer rejection stops at the shared turn budget without accepting the proposal", async t => {
  const { engine, store, setup } = fixture(t); setup("p", "stuck");
  const initial = engine.prepare("p", "discovery"); await engine.stageResearch.run("p", initial.id, 3);
  const draft = engine.prepare("p", "concept");
  const result = await engine.stageResearch.run("p", draft.id, 6);
  assert.equal(result.status, "paused");
  assert.equal((store.get(result.research!.id)!.value as {turns:number}).turns, 6);
  assert.equal(store.list("research-feedback").length, 3);
  assert.equal(engine.pipeline.inspect("p", "concept").state, "blocked");
});

test("a competing stage revision during model work is preserved and cannot be auto-accepted", async t => {
  const { engine, store, setup } = fixture(t); setup("p");
  const draft = engine.prepare("p", "discovery");
  const research = engine.researcher.run.bind(engine.researcher);
  engine.researcher.run = async (...args) => {
    const result = await research(...args);
    engine.draft("p", "discovery", draft.id, 0);
    return result;
  };
  await assert.rejects(engine.stageResearch.run("p", draft.id, 3), { code: "revision_conflict" });
  const artifact = store.get<{status:string}>("stage:p:discovery")!;
  assert.equal(artifact.revision, 1); assert.equal(artifact.value.status, "draft");
  assert.equal(store.list("research-feedback").length, 0);
});

test("existing connector semantic drift is fed back with current L1 for model correction", async t => {
  const { engine, store, setup } = fixture(t); setup("p", "drift");
  for (const stage of ["discovery", "concept"] as const) {
    const draft = engine.prepare("p", stage); assert.equal((await engine.stageResearch.run("p", draft.id, 6)).status, "accepted");
  }
  const draft = engine.prepare("p", "operation-map");
  const graph = buildL1("p:map", "p", designOf(enrichedGraph(exampleGraph("p"), "p")),
    { preparation: preparedField("p", "preparation") }, { conceptSections: preparedField("p", "conceptSections") });
  const original = engine.graphs.save("p", graph, 0, "owner");
  const context = researchGraphContext(store, draft.value)!;
  assert.equal(context.ref.hash, original.hash);
  assert.deepEqual(context.graph.contracts, graph.contracts);
  const result = await engine.stageResearch.run("p", draft.id, 5);
  assert.equal(result.status, "accepted", JSON.stringify(result));
  assert.ok(store.list<ConsumerFeedback>("research-feedback").some(item => item.value.findings.some(finding => finding.code === "graph_semantic_drift")));
  const accepted = store.get<{content:{fields:Record<string,Json>}}>(result.stage!.id)!;
  assert.deepEqual(accepted.value.content.fields['mapDesign'], designOf(graph));
});

test("a map retry cannot adopt a competing graph written after consumer feedback", async t => {
  const { engine, store, setup } = fixture(t); setup("p");
  for (const stage of ["discovery", "concept"] as const) {
    const draft = engine.prepare("p", stage); await engine.stageResearch.run("p", draft.id, 6);
  }
  const draft = engine.prepare("p", "operation-map");
  const write = store.writeMany.bind(store); let pending = true;
  store.writeMany = function<T>(inputs: Write[], guards?: ReadGuard[]): Revision<T>[] {
    const records = write<T>(inputs, guards);
    if (pending && inputs.some(input => input.kind === "research-feedback")) {
      pending = false;
      const graph = buildL1("p:map", "p", designOf(enrichedGraph(exampleGraph("p"), "p")),
        { preparation: preparedField("p", "preparation") }, { conceptSections: preparedField("p", "conceptSections") });
      engine.graphs.save("p", graph, 0, "competing-writer");
    }
    return records;
  };
  await assert.rejects(engine.stageResearch.run("p", draft.id, 5), { code: "revision_conflict" });
  assert.equal(store.history("graph:p").length, 1);
  assert.equal(store.get("stage:p:operation-map"), null);
});

const DRY5_ADAPTER = `import{readFileSync,writeFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,statePath=process.argv[5],fault=JSON.parse(readFileSync(statePath,'utf8'));
appendFileSync(process.argv[3],JSON.stringify(r)+'\\n');
const q=s.questions?.[0]??s.question,field=q.field,values=JSON.parse(readFileSync(process.argv[2],'utf8'));
const source=(s.inventory?.sources??s.originals?.sources??[]).find(x=>x.location==='values');
let foreign=false;
let research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:
{action:'answer',question:q.id,value:values[field],citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+field}}]};
const assessor=['assessor-action','assessor-fields'].includes(fault.mode);
if(fault.remaining>0&&field===fault.field&&(assessor?s.role==='assess-answer':s.role==='research')){
 fault.remaining--;writeFileSync(statePath,JSON.stringify(fault));
 if(fault.mode==='provider'){console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,usage:null}));console.error(JSON.stringify({error:'provider_failed'}));process.exit(1);}
 const citations=research.citations??[];
 const actions={bundle:{action:'read_bundle',purpose:'Read',inputs:[{path:'irrelevant.txt',media:'text/plain'}]},
 delta:{action:'answer_delta',question:q.id,base:source?.ref,upserts:{},removes:{},citations},
 plan:{action:'read_plan',question:q.id,reads:[{action:'read',path:'irrelevant.txt',media:'text/plain'}]},
 synthesize:{action:'synthesize',question:q.id},'need-research':{action:'need_research',question:q.id,missing:['evidence']},
 unknown:{action:'need_source',question:q.id},missing:{action:'answer',question:q.id},value:{...research,value:42},
 'assessor-action':{action:'answer'},'assessor-fields':{verdict:'supported'}};
 if(fault.mode==='foreign')foreign=true;else research=actions[fault.mode];
}
const envelope=foreign?JSON.parse(readFileSync(process.argv[3]+'.responses','utf8').split('\\n')[0]):{protocol:r.protocol,requestId:r.requestId,research,usage:null};
appendFileSync(process.argv[3]+'.responses',JSON.stringify(envelope)+'\\n');
console.log(JSON.stringify(envelope));`;

function dry5StageFixture(t: test.TestContext, mode: string, field = 'preparation') {
  const f = fixture(t); f.setup('p');
  const fault = join(f.root, 'fault.json');
  writeFileSync(fault, JSON.stringify({ mode, field, remaining: 1 }));
  writeFileSync(join(f.root, 'adapter.mjs'), DRY5_ADAPTER.replace('process.argv[5]', JSON.stringify(fault)));
  const calls = () => readFileSync(join(f.root, 'p.calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const open = () => { const db = new Store(f.path); t.after(() => db.close()); return new ProductEngine(db); };
  return { ...f, fault, calls, open };
}

for (const [row, mode, code] of [
  ['M1', 'bundle', 'reader_pilot_required'], ['M2', 'delta', 'reader_pilot_required'],
  ['M3', 'plan', 'reading_plan_disabled'], ['M4', 'synthesize', 'research_question_foreign'],
  ['M4b', 'need-research', 'research_question_foreign'], ['M5', 'unknown', 'research_response_invalid'],
  ['M6', 'missing', 'research_response_invalid'], ['M7', 'value', 'answer_invalid'],
  ['M8', 'assessor-action', 'assessment_invalid'], ['M9', 'assessor-fields', 'assessment_invalid']
]) test(`DRY5FIX ${row}: public stage pauses once, new Store corrects only the failed role`, async t => {
  const f = dry5StageFixture(t, mode!); const draft = f.engine.prepare('p', 'discovery');
  const first = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.equal(first.status, 'paused');
  assert.equal((f.store.get(first.research!.id)!.value as { pauseCode: string }).pauseCode, code);
  const count = f.calls().length, assessor = mode!.startsWith('assessor');
  const before = f.store.list('model-call');
  const next = f.open(); const result = await next.stageResearch.run('p', draft.id, 20);
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(f.calls().length - count, assessor ? 1 : 2);
  const corrected = f.calls()[count].subject;
  assert.ok(corrected.failures?.some((failure: {code:string}) => failure.code === code), JSON.stringify(corrected));
  assert.ok(corrected.failures[0].responseContract);
  assert.equal(corrected.role, assessor ? 'assess-answer' : 'research');
  for (const call of before) assert.deepEqual(next.store.get(call.id), call, 'Original paid calls remain intact');
});

for (const negative of ['insufficient', 'conflicting'] as const)
test(`DRY5FIX B corrected ${negative} admits the next analyst proposal and survives restart at nine calls`, async t => {
  const f = dry5StageFixture(t, 'assessor-fields');
  writeFileSync(join(f.root, 'adapter.mjs'), `import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,wire=process.argv[3];
const prior=existsSync(wire)?readFileSync(wire,'utf8').trim().split('\\n').map(x=>JSON.parse(x)):[];
appendFileSync(wire,JSON.stringify(r)+'\\n');
const q=s.questions?.[0]??s.question,values=JSON.parse(readFileSync(process.argv[2],'utf8'));
const source=(s.inventory?.sources??s.originals?.sources??[]).find(x=>x.location==='values');
let research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:
{action:'answer',question:q.id,value:values[q.field],citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
if(q.field==='preparation'&&s.role==='assess-answer'){
 const n=prior.filter(x=>x.subject.role==='assess-answer'&&x.subject.question.field==='preparation').length;
 if(n===0)research={verdict:'supported'};
 if(n===1)research={verdict:${JSON.stringify(negative)},reasons:['Revise the proposal']};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:null}));`);
  const draft = f.engine.prepare('p', 'discovery'), first = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.equal(first.status, 'paused');
  assert.equal((f.store.get<any>(first.research!.id)!.value).pauseCode, 'assessment_invalid');
  assert.equal(f.calls().length, 6);
  const original = f.store.list<any>('assessment-barrier')[0]!;
  const second = await f.open().stageResearch.run('p', draft.id, 20);
  assert.equal(second.status, 'accepted', JSON.stringify(second));
  assert.equal(f.calls().length, 9);
  assert.deepEqual(f.calls().slice(6).map(r => r.subject.role), ['assess-answer', 'research', 'assess-answer']);
  assert.deepEqual(f.store.get(original.id, original.revision), original, 'The original refusal remains historical');
  const barrier = f.store.get<any>(original.id)!;
  assert.equal(barrier.revision, 2); assert.ok(barrier.value.completion);
  const completed = f.store.get<any>(barrier.value.completion.id, barrier.value.completion.revision)!;
  assert.equal(completed.value.state, 'applied');
  assert.equal(f.store.get<any>(completed.value.after.id, completed.value.after.revision)!.value.result.verdict, negative);
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'accepted');
  assert.equal(f.calls().length, 9);
});

for (const stage of UPSTREAM_STAGES) test(`DRY5FIX R: ordinary retry on ${stage} obeys its own current questions`, async t => {
  const f = dry5StageFixture(t, 'missing', REQUIREMENTS[stage].at(-1)!.field);
  writeFileSync(f.fault, JSON.stringify({ mode: 'missing', field: REQUIREMENTS[stage].at(-1)!.field, remaining: 0 }));
  for (const prior of UPSTREAM_STAGES.slice(0, UPSTREAM_STAGES.indexOf(stage))) {
    const draft = f.engine.prepare('p', prior);
    assert.equal((await f.engine.stageResearch.run('p', draft.id, 30)).status, 'accepted');
  }
  writeFileSync(f.fault, JSON.stringify({ mode: 'missing', field: REQUIREMENTS[stage].at(-1)!.field, remaining: 1 }));
  const draft = f.engine.prepare('p', stage);
  assert.equal((await f.engine.stageResearch.run('p', draft.id, 30)).status, 'paused');
  const count = f.calls().length;
  const result = await f.open().stageResearch.run('p', draft.id, 30);
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(f.calls().length - count, 2);
});

function dry5Stop(store: Store, match: (write: Write) => boolean, after = false) {
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!hit && writes.some(match)) {
      hit = true; if (after) original(writes, guards);
      throw new Error('DRY5FIX deliberate process boundary');
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  return () => { store.writeMany = original; assert.ok(hit, 'The real persistence boundary was reached'); };
}
for (const mode of ['bundle', 'assessor-fields']) test(`DRY5FIX O: two native reopens after ${mode} remain readable`, async t => {
  const f = dry5StageFixture(t, mode), draft = f.engine.prepare('p', 'discovery');
  const restore = mode === 'bundle' ? dry5Stop(f.store, write => write.kind === 'research-turn'
    && (write.value as any).observation?.contract === 'early-research-outcome/v1') : null;
  assert.equal((await f.engine.stageResearch.run('p', draft.id, 20)).status, 'paused'); restore?.();
  const q = draft.value.questions.map(id => f.store.get<Question>(id)!).find(q => q.value.spec.field === 'preparation')!;
  const reopened = f.engine.discovery.reopen(q.id, q.revision); f.engine.discovery.reopen(q.id, reopened.revision);
  const count = f.calls().length, engine = f.open();
  assert.equal((await engine.stageResearch.run('p', draft.id, 20)).status, 'accepted');
  assert.equal(f.calls().length - count, 2);
  const { readResearchConsumerTurn } = await import('../src/discovery/response-recovery.js');
  const { reference } = await import('../src/pipeline/contracts.js');
  for (const turn of engine.store.list('research-turn')) assert.doesNotThrow(() => readResearchConsumerTurn(engine.store, reference(turn)));
});
test('DRY5FIX P: new draft and another project coexist with genuine read_bundle/reopen history', async t => {
  const f = dry5StageFixture(t, 'bundle'), draft = f.engine.prepare('p', 'discovery');
  let restore = dry5Stop(f.store, write => write.kind === 'research-turn'
    && (write.value as any).observation?.contract === 'early-research-outcome/v1');
  await f.engine.stageResearch.run('p', draft.id, 20); restore();
  const q = draft.value.questions.map(id => f.store.get<Question>(id)!).find(q => q.value.spec.field === 'preparation')!;
  f.engine.discovery.reopen(q.id, q.revision);
  restore = dry5Stop(f.store, write => write.kind === 'research-turn'
    && (write.value as any).observation?.code === 'research_question_reopened', true);
  await f.engine.stageResearch.run('p', draft.id, 20); restore();
  const history = f.store.list('research-turn');
  const engine = f.open(), freshDraft = engine.prepare('p', 'discovery');
  assert.equal((await engine.stageResearch.run('p', freshDraft.id, 30)).status, 'accepted');
  f.setup('neighbor'); const neighbor = f.engine.prepare('neighbor', 'discovery');
  assert.equal((await f.engine.stageResearch.run('neighbor', neighbor.id, 30)).status, 'accepted');
  for (const old of history) assert.deepEqual(engine.store.get(old.id), old);
});
for (const boundary of ['receipt', 'before-outcome', 'after-outcome'])
test(`DRY5FIX A ${boundary}: resume saved bytes before permitting the corrective send`, async t => {
  const f = dry5StageFixture(t, boundary === 'receipt' ? 'missing' : 'bundle'), draft = f.engine.prepare('p', 'discovery');
  const q = draft.value.questions.map(id => f.store.get<Question>(id)!).find(q => q.value.spec.field === 'preparation')!;
  const restore = dry5Stop(f.store, write => boundary === 'receipt'
    ? write.kind === 'model-response' && (write.value as any).text?.includes('"action":"answer"')
      && (write.value as any).text?.includes(q.id)
    : write.kind === 'research-turn' && (write.value as any).observation?.contract === 'early-research-outcome/v1', boundary !== 'before-outcome');
  await f.engine.stageResearch.run('p', draft.id, 20); restore(); const count = f.calls().length;
  if (boundary !== 'after-outcome') {
    assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'paused'); assert.equal(f.calls().length, count);
  }
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'accepted');
  assert.equal(f.calls().length - count, 2);
});
test('DRY5FIX A concurrent retries make one correction and accepted replay makes no call', async t => {
  const f = dry5StageFixture(t, 'missing'), draft = f.engine.prepare('p', 'discovery');
  await f.engine.stageResearch.run('p', draft.id, 20); const count = f.calls().length;
  const outcomes = await Promise.allSettled([f.open().stageResearch.run('p', draft.id, 20), f.open().stageResearch.run('p', draft.id, 20)]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled' && result.value.status === 'accepted'));
  assert.equal(f.calls().length - count, 2);
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'accepted'); assert.equal(f.calls().length - count, 2);
});

for (const mode of ['missing', 'value', 'assessor-fields']) test(`DRY5FIX ${mode}: another erroneous correction stops at the external boundary`, async t => {
  const f = dry5StageFixture(t, mode), draft = f.engine.prepare('p', 'discovery');
  writeFileSync(f.fault, JSON.stringify({ mode, field: 'preparation', remaining: 2 }));
  assert.equal((await f.engine.stageResearch.run('p', draft.id, 20)).status, 'paused'); const count = f.calls().length;
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'paused'); assert.equal(f.calls().length - count, 1);
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'accepted');
  assert.equal(f.calls().length - count, mode === 'assessor-fields' ? 2 : 3);
});
test('DRY5FIX a genuine earlier response cannot authorize correction of a foreign requestId', async t => {
  const f = dry5StageFixture(t, 'foreign'), draft = f.engine.prepare('p', 'discovery');
  const first = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.equal(first.status, 'paused');
  assert.equal((f.store.get(first.research!.id)!.value as {pauseCode:string}).pauseCode, 'research_response_foreign');
  const count = f.calls().length;
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'paused'); assert.equal(f.calls().length, count);
});

test('DRY5FIX A correction reason survives an intervening proved provider failure', async t => {
  const f = dry5StageFixture(t, 'missing'), draft = f.engine.prepare('p', 'discovery');
  assert.equal((await f.engine.stageResearch.run('p', draft.id, 20)).status, 'paused');
  writeFileSync(f.fault, JSON.stringify({ mode: 'provider', field: 'preparation', remaining: 1 }));
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'paused'); const count = f.calls().length;
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'accepted');
  assert.equal(f.calls().length - count, 2);
  assert.equal(f.calls()[count].subject.failures[0].code, 'research_response_invalid');
});
test('DRY5FIX A native question change at refusal write cannot partially close the old attempt', async t => {
  const f = dry5StageFixture(t, 'bundle'), draft = f.engine.prepare('p', 'discovery'), other = f.open();
  const original = f.store.writeMany.bind(f.store); let moved = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!moved && writes.some(write => write.kind === 'research-turn' && (write.value as any).observation?.contract === 'early-research-outcome/v1')) {
      moved = true;
      const question = other.store.get<Question>(draft.value.questions.find(id => other.store.get<Question>(id)!.value.spec.field === 'preparation')!)!;
      other.discovery.reopen(question.id, question.revision);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  try { assert.equal((await f.engine.stageResearch.run('p', draft.id, 20)).status, 'paused'); }
  finally { f.store.writeMany = original; }
  assert.ok(moved); const count = f.calls().length;
  assert.equal(f.store.list<any>('research-turn').filter(turn => turn.value.observation?.contract === 'early-research-outcome/v1').length, 0);
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'accepted'); assert.equal(f.calls().length - count, 2);
});

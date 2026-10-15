import { execFileSync } from 'node:child_process';
import { reference } from '../src/pipeline/contracts.js';
import { buildOmInput, type InputStages, writeOmInput } from '../src/om/input.js';
import { resumeStoppedPass, stopPass } from '../src/om/run-driver.js';
import { discoveryOutcome } from '../src/discovery/discovery-outcome.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store, type Revision, type Write, type ReadGuard } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES, REQUIREMENTS } from "../src/discovery/requirements.js";
import { preparedField } from "./preparation-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { buildL1, designOf } from "../src/graph/builder.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { ResearchRun, ResearchTurn } from "../src/discovery/research-model.js";
import { executeWebTurn } from "../src/discovery/web-research.js";
import type { Environment } from "../src/runtime/environment.js";
import type { StageResearchResult } from "../src/product/stage-research.js";
import { consumerFeedback, rejectResearch, type ConsumerFeedback } from "../src/discovery/consumer-feedback.js";
import { researchGraphContext, researchPrerequisites } from "../src/discovery/research-context.js";
import { canonical, type Json } from "../src/canonical.js";

// Controlled process provider proves routing/acceptance, not live model quality.
const ADAPTER = `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js',import.meta.url).href)};
import {readFileSync,appendFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
if(!Array.isArray(c.inventory.sources)) {const t=c.inventory.sources;c.inventory.sources=t.rows.map(row=>Object.fromEntries(t.columns.map((column,i)=>[column,row[i]])));}
appendFileSync(process.argv[3],JSON.stringify({role:c.role,field:c.questions?.[0]?.field,feedback:c.consumerFeedback,failures:c.failures,context:c.discoveryContext,question:c.question,prompt:req.prompt,prerequisites:c.prerequisites,value:c.value})+'\\n');
if(process.argv[4]==='fail')process.exit(1);
let research;
if(c.role==='assess-answer')research=process.argv[4]==='opposite-constraint'&&c.question.field==='preparation'
 ?{verdict:'conflicting',reasons:['Correct address, but the rule reverses the local-only report constraint']}:{verdict:'supported',reasons:[]};
else {const q=c.questions[0],source=c.inventory.sources.find(s=>s.location==='values'),values=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const value=boundDiscoveryValue(q.field,structuredClone(values[q.field]),c.discoveryContext);
 if(values.choiceRound&&q.field==='verdict'&&c.discoveryContext?.ownerDecisions.length) {
   const round=c.discoveryContext.ownerDecisions.at(-1),declined=round.decisions.some(d=>d.option.choice==='decline');
   value.outcome=declined?'no_go':'go';value.conditions=[];value.reason=declined?'Owner declined the necessary scope':'The selected condition and report support the proposed scope';
 }
 if(process.argv[4]==='duplicate-plan'&&q.field==='researchPlan')value.startingQuestions[0].id=value.feasibilityQuestions[0].id;
 if(q.field==='preparation') {
  if(process.argv[4]==='missing-constraint')value.constraints.pop();
  if(process.argv[4]==='foreign-constraint') {const address=JSON.parse(value.constraints.at(-1).basis);address.pointer='/constraints/99';value.constraints.at(-1).basis=JSON.stringify(address);}
  if(process.argv[4]==='opposite-constraint')value.constraints.at(-1).rule='Upload all inputs to an external service';
 }

 const additional=q.field==='researchReport'?c.inventory.sources.find(s=>s.location==='additional'):null;
 if(process.argv[4]==='foreign-report'&&q.field==='verdict')value.researchReport.hash='a'.repeat(64);
 if(q.field==='conceptSections'&&(!c.consumerFeedback.length||process.argv[4]==='stuck'))value[0].requirements[0].outcome='descriptive prose, not an outcome ID';
 if(q.field==='mapDesign'&&!c.consumerFeedback.length) {
   if(process.argv[4]==='drift')value.contracts[0].schema.description='Changed meaning of a stable connector';
   else value.nodes[0].outcome='missing-artifact';
 }
 research={action:'answer',question:q.id,value,citations:[additional?{source:additional.ref,selector:{kind:'text-range',start:0,end:additional.length}}:{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
 if(values.renewal&&q.field==='researchReport') {
  if(!additional)research={action:'search',query:'New feasibility information'};
  else if(![...(c.history??[]),c.currentRead].some(t=>t?.action?.action==='read_source'&&t.action.source.id===additional.ref.id))
   research={action:'read_source',source:additional.ref,start:0,end:additional.length};
 }
}console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));`;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-stage-research-"));
  const path = join(root, "state.sqlite"); const store = new Store(path); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "adapter.mjs"), ADAPTER);
  function setup(project: string, scenario = "normal", overrides: Record<string,Json> = {}) {
    engine.execute({ type: "create-project", project, title: project });
    const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
      spec.field === "mapDesign" ? designOf(enrichedGraph(exampleGraph(project), project)) : preparedField(project, spec.field)])));
    Object.assign(fields,overrides);
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
      assert.equal(result.status, "accepted", JSON.stringify({ result, run: result.research && store.get(result.research.id)?.value }));
      assert.equal(engine.pipeline.inspect(project, stage).state, "accepted");
      const count = store.list("research-turn").length;
      const again = await engine.stageResearch.run(project, draft.id, 8);
      assert.equal(again.status, "accepted"); assert.equal(store.list("research-turn").length, count);
      assert.equal(again.stage!.revision, result.stage!.revision, "Accepted stage is not republished");
      assert.deepEqual([again.turnsUsed, again.reason], [0, null], "Current accepted replay reports zero new work");
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
  const first = engine.prepare("p", "discovery"); await engine.stageResearch.run("p", first.id, 6);
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
  const draft = engine.prepare("p", "discovery"); await engine.researcher.run("p", draft.id, 6);
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
  const initial = engine.prepare("p", "discovery"); await engine.stageResearch.run("p", initial.id, 6);
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
  await assert.rejects(engine.stageResearch.run("p", draft.id, 6), { code: "revision_conflict" });
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

// These controlled process answers exercise acceptance, not live research quality.
for (const [domain,role] of [['Subscription harness','Developer tool integrator'],['Lighting bus','Electrical lighting engineer'],['Levitating nightstand','Magnetic suspension engineer']] as const) {
 test(`DS1-02 ${domain} carries its distinct plan to report and assessor and opens concept only after go`,async t=>{
  const f=fixture(t),plan=preparedField('p','researchPlan') as any;
  plan.domain=domain;plan.roles=[{role,side:domain,why:'Investigate the concrete feasibility of this requested product'}];
  f.setup('p','normal',{researchPlan:plan});
  const draft=f.engine.prepare('p','discovery');
  const result=await f.engine.stageResearch.run('p',draft.id,6);
  assert.equal(result.status,'accepted',JSON.stringify({result,run:result.research&&f.store.get(result.research.id)?.value}));
  assert.equal(result.discovery?.state,'go');
  const paid = f.store.list('model-call').map(reference);
  const repeated = await f.engine.stageResearch.run('p', draft.id, 1);
  assert.deepEqual(repeated.discovery, result.discovery);
  assert.deepEqual(f.store.list('model-call').map(reference), paid);
  const calls=readFileSync(join(f.root,'p.calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const report=calls.find(c=>c.field==='researchReport');
  assert.deepEqual(report.context.fields.researchPlan.value,plan);
  const assessor=calls.find(c=>c.role==='assess-answer'&&c.question.field==='researchReport');
  assert.deepEqual(assessor.context.fields.researchPlan,report.context.fields.researchPlan);
  const verdict=calls.find(c=>c.field==='verdict');
  assert.ok(verdict.context.fields.researchReport.answer);
  assert.equal(calls.filter(c=>c.field==='preparation').length,1);
  assert.equal(f.engine.prepare('p','concept').value.stage,'concept');
 });
}

for(const state of ['no_go','conditional','insufficient_evidence'] as const) test(`DS1-03 supported ${state} is a saved result without preparation, concept or corrective calls`,async t=>{
 const f=fixture(t),verdict=preparedField('p','verdict') as any;
 verdict.outcome=state;verdict.reason='The investigated variant cannot currently meet the stated constraints';
 verdict.conditions=state==='conditional'?[{id:'condition-1',kind:'owner_choice',condition:'Choose the required constraint',criterion:'A new supported report and verdict establish the choice',options:[{optionId:'accept',label:'Accept constraint',consequences:['Reassess the variant'],choice:'accept'},{optionId:'decline',label:'Decline constraint',consequences:['Reassess alternatives'],choice:'decline'}]}]:[];
 f.setup('p','normal',{verdict});const draft=f.engine.prepare('p','discovery');
 const first=await f.engine.stageResearch.run('p',draft.id,10);
 assert.equal(first.status,state==='conditional'?'needs_owner':'paused',JSON.stringify(first));assert.equal(first.discovery?.state,state);
 assert.equal(first.findings[0]?.code,`discovery_${state}`);
 const preparation=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='preparation')!;
 assert.equal(preparation.value.status,'open');assert.equal(f.store.list('research-feedback').length,0);
 assert.throws(()=>f.engine.prepare('p','concept'),{code:'predecessor_not_ready'});
 const calls=f.store.list('model-call').length,answer=canonical(first.discovery);
 for(let i=0;i<2;i++) {
  const reopened=new Store(f.path);
  try {
   const repeat=await new ProductEngine(reopened).stageResearch.run('p',draft.id,10);
   assert.equal(canonical(repeat.discovery),answer);assert.equal(reopened.list('model-call').length,calls);
  }finally{reopened.close();}
 }
});

for (const state of ['no_go', 'insufficient_evidence'] as const)
test(`DS1.1 supported ${state} keeps owner conditions as report data without offering a closed choice command`, async t => {
 const f=fixture(t),verdict:any=preparedField('p','verdict');
 verdict.outcome=state;verdict.conditions=[{id:'scope',kind:'owner_choice',condition:'Consider a different scope',criterion:'A later researched conditional verdict',options:[
  {optionId:'accept',label:'Accept another scope',consequences:['Research the alternative'],choice:'accept'},
  {optionId:'decline',label:'Keep the request',consequences:['Keep the saved outcome'],choice:'decline'}]}];
 f.setup('p','normal',{verdict});const draft=f.engine.prepare('p','discovery');
 const result=await f.engine.stageResearch.run('p',draft.id,8);
 assert.equal(result.status,'paused');assert.equal(result.discovery?.state,state);
 assert.deepEqual(result.discovery?.ownerChoices,[]);assert.deepEqual(result.discovery?.conditions,verdict.conditions);
 assert.equal(result.findings[0]?.code,`discovery_${state}`);
 assert.throws(()=>f.engine.execute({type:'answer-decision',mode:'discovery-condition',project:'p',draft:draft.id,
  verdictRef:result.discovery!.verdict!,conditionId:'scope',optionId:'accept'}),{code:'discovery_choice_stale'});
 const calls=f.store.list('model-call').map(reference),reopened=new Store(f.path);
 try {
  const repeat=await new ProductEngine(reopened).stageResearch.run('p',draft.id,8);
  assert.equal(repeat.status,'paused');assert.deepEqual(repeat.discovery,result.discovery);
  assert.deepEqual(reopened.list('model-call').map(reference),calls);
  assert.equal(reopened.list('discovery-condition-decision').length,0);
 } finally {reopened.close();}
});

test('DS1-04 import and reopen report/verdict resumes after restart; retained old fields cannot decide the new outcome',async t=>{
 const f=fixture(t),verdict=preparedField('p','verdict') as any;verdict.outcome='insufficient_evidence';
 f.setup('p','normal',{verdict});const draft=f.engine.prepare('p','discovery');
 const first=await f.engine.stageResearch.run('p',draft.id,8);assert.equal(first.discovery?.state,'insufficient_evidence');
 const planQuestion=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='researchPlan')!;
 const planAnswer=planQuestion.value.answer;
 const source=f.engine.discovery.evidence.document('p','additional','New feasibility information supplied for renewed research','text/plain',0);
 assert.equal(source.value.origin.kind,'owner-document');
 for(const field of ['researchReport','verdict']) {
  const q=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field===field)!;
  f.engine.discovery.reopen(q.id,q.revision);
 }
 assert.equal(discoveryOutcome(f.store,f.store.get<DiscoveryDraft>(draft.id)!).state,'researching');
 assert.equal((f.store.get<DiscoveryDraft>(draft.id)!.value.fields.verdict as any).outcome,'insufficient_evidence');
 const values=JSON.parse(readFileSync(join(f.root,'p.json'),'utf8'));values.verdict.outcome='go';values.renewal=true;writeFileSync(join(f.root,'p.json'),JSON.stringify(values));
 const restarted=new Store(f.path);
 try {
  const engine=new ProductEngine(restarted),result=await engine.stageResearch.run('p',draft.id,5);
  assert.equal(result.status,'accepted',JSON.stringify({result,run:result.research&&restarted.get(result.research.id)?.value}));
  assert.equal(result.discovery?.state,'go');assert.notDeepEqual(result.discovery?.report,first.discovery?.report);
  assert.deepEqual(restarted.get<Question>(planQuestion.id)!.value.answer,planAnswer);
  const report=restarted.get<any>(result.discovery!.report!.id)!,assessment=restarted.get<any>(report.value.assessment.id)!;
  assert.deepEqual(assessment.value.observations[0].source,reference(source),'Renewed report actually cites the imported evidence');
  assert.equal(restarted.list('research-feedback').length,0);
 }finally{restarted.close();}
});

test('DS1-05 a verdict naming another report is refused before assessor dispatch',async t=>{
 const f=fixture(t);f.setup('p','foreign-report');const draft=f.engine.prepare('p','discovery');
 const result=await f.engine.stageResearch.run('p',draft.id,8);
 assert.equal(result.status,'paused');
 const run=f.store.get<any>(result.research!.id)!;assert.equal(run.value.pauseCode,'discovery_basis_stale');
 const q=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='verdict')!;
 assert.equal(q.value.status,'open');
 const calls=readFileSync(join(f.root,'p.calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(calls.filter(c=>c.role==='assess-answer'&&c.question.field==='verdict').length,0);
 assert.equal(f.store.list('research-feedback').length,0);
});

test('DS1-09 exact Git v4 producer: accepted stages retain their era and paid pending restores before upgrade without new calls',async t=>{
 const root=mkdtempSync(join(tmpdir(),'omg-ds1-era-')),era=join(root,'era');mkdirSync(era);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('tar',['-xf','-','-C',era],{input:execFileSync('git',['archive','e9c1ca5c41fb80508559aeab41da8f3da7422953'],{maxBuffer:80<<20})});
 symlinkSync(resolve('node_modules'),join(era,'node_modules'));
 execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(era,'tsconfig.json')],{cwd:era,maxBuffer:4<<20});
 const producer=join(era,'ds1-old-producer.mjs');
 writeFileSync(producer,`import{writeFileSync,readFileSync}from'node:fs';
 import{Store}from'./dist/src/storage/store.js';import{ProductEngine}from'./dist/src/product/engine.js';import{EngineError}from'./dist/src/errors.js';
 import{preparedFeatures}from'./dist/test/product-fixture.js';import{reference}from'./dist/src/pipeline/contracts.js';
 const root=${JSON.stringify(root)},store=new Store(root+'/state.sqlite'),engine=new ProductEngine(store);
 preparedFeatures(engine,'accepted');
 const stages=['discovery','concept','operation-map','specification','features'].map(stage=>({stage,record:store.get('stage:accepted:'+stage),inspect:engine.pipeline.inspect('accepted',stage)}));
 engine.execute({type:'create-project',project:'pending',title:'Previous paid work'});
 const source=engine.discovery.evidence.document('pending','source','Existing paid source','text/plain',0),adapter=root+'/adapter.mjs';
 writeFileSync(adapter,\`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(\${JSON.stringify(root+'/calls')},'call\\\\n');
 console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_source',source:\${JSON.stringify(reference(source))},start:0,end:20}}));\`);
 const command={executable:process.execPath,args:[adapter]};
 engine.environments.configure('pending',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'medium',command},reviewer:{actor:'assessor',model:'fixture',effort:'medium',command},fullCheck:command,timeoutMs:10000},0);
 const draft=engine.prepare('pending','discovery'),write=store.writeMany.bind(store);let interrupted=false;
 store.writeMany=(writes,guards=[])=>{const result=write(writes,guards);if(!interrupted&&writes.some(w=>w.kind==='model-response')){interrupted=true;throw new EngineError('input_stale','Stop after saved paid response');}return result;};
 await engine.researcher.run('pending',draft.id,1);store.writeMany=write;
 const pending=store.list('research-consumer-intent').find(x=>x.value.kind==='analyst'&&x.value.state==='running');
 if(!interrupted||!pending||store.get(pending.value.call.id).value.status!=='succeeded')throw Error('Paid pending was not produced');
 writeFileSync(root+'/expected.json',JSON.stringify({stages,draft,pending,records:store.list().flatMap(row=>store.history(row.id)),calls:readFileSync(root+'/calls','utf8')}));store.close();`);
 execFileSync(process.execPath,[producer],{cwd:era,maxBuffer:4<<20});
 const expected=JSON.parse(readFileSync(join(root,'expected.json'),'utf8')),store=new Store(join(root,'state.sqlite'));t.after(()=>store.close());
 const engine=new ProductEngine(store);
 for(const item of expected.stages){
  assert.deepEqual(engine.pipeline.inspect('accepted',item.stage),item.inspect);
  const repeated=await engine.stageResearch.run('accepted',item.record.value.content.draft.id,1);assert.equal(repeated.status,'accepted');
  assert.deepEqual(store.get(item.record.id),item.record);
 }
 const input=writeOmInput(store,{project:'accepted',expected:0,stages:Object.fromEntries(expected.stages.map((i:any)=>[i.stage,reference(i.record)])) as any});
 assert.ok(input.ok,JSON.stringify(input));
 const result=await engine.stageResearch.run('pending',expected.draft.id,10);
 assert.equal(result.status,'paused');assert.equal(result.findings[0]?.code,'research_contract_upgrade_required');
 const turn=store.list<any>('research-turn').find(t=>t.value.number===expected.pending.value.cursor.turn)!;
 assert.equal(turn.value.status,'completed');assert.equal(turn.value.observation.value,'Existing paid source');
 assert.equal(readFileSync(join(root,'calls'),'utf8'),expected.calls);
 const callCount=store.list('model-call').length;
 const next=await engine.stageResearch.run('pending',expected.draft.id,10);assert.equal(next.findings[0]?.code,'research_contract_upgrade_required');
 assert.equal(store.list('model-call').length,callCount);assert.equal(store.get('stage:pending:discovery'),null);
 for(const old of expected.records)assert.deepEqual(store.get(old.id,old.revision),old);
});

test('DS1-11 a paid accepted no_go recovers its unfinished turn before current admission, with no repeated model call', async t => {
 const f = fixture(t), verdict = preparedField('p', 'verdict') as any;
 verdict.outcome = 'no_go'; f.setup('p', 'normal', { verdict });
 const draft = f.engine.prepare('p', 'discovery');
 const q = draft.value.questions.map(id => f.store.get<Question>(id)!).find(q => q.value.spec.field === 'verdict')!;
 const write = f.store.writeMany.bind(f.store); let interrupted = false;
 f.store.writeMany = ((writes: Write[], guards: ReadGuard[] = []) => {
  const saved = write(writes, guards);
  if (!interrupted && writes.some(w => w.kind === 'research-answer' && (w.value as any).question === q.id)) {
   interrupted = true; throw new Error('Process lost after atomic acceptance, before turn completion');
  }
  return saved;
 }) as typeof f.store.writeMany;
 await f.engine.researcher.run('p', draft.id, 8); f.store.writeMany = write;
 assert.ok(interrupted); assert.equal(f.store.get<Question>(q.id)!.value.status, 'answered');
 const turns = f.store.list<any>('research-turn'), pending = turns.find(row => row.value.status === 'pending')!;
 assert.ok(pending); const calls = f.store.list('model-call').map(reference), answers = f.store.list('research-answer');
 const restarted = new Store(f.path);
 try {
  const result = await new ProductEngine(restarted).stageResearch.run('p', draft.id, 8);
  assert.equal(result.status, 'paused'); assert.equal(result.discovery?.state, 'no_go');
  assert.equal(restarted.get<any>(pending.id)!.value.status, 'completed');
  assert.deepEqual(restarted.list('model-call').map(reference), calls);
  assert.deepEqual(restarted.list('research-answer'), answers);
  assert.equal(restarted.list('research-feedback').length, 0);
 } finally { restarted.close(); }
});

for (const option of ['accept','decline']) test(`DS1.1 real stage conditional → ${option} → new assessed verdict after restart`, async t => {
 const f=fixture(t),verdict:any=preparedField('p','verdict');
 verdict.outcome='conditional';verdict.conditions=[{id:'scope',kind:'owner_choice',condition:'Use local execution',criterion:'Owner accepts the bounded scope',options:[
  {optionId:'accept',label:'Use local execution',consequences:['Reassess local feasibility'],choice:'accept'},
  {optionId:'decline',label:'Decline this scope',consequences:['Reassess feasibility without the condition'],choice:'decline'}]}];
 f.setup('p','normal',{verdict,choiceRound:true});const draft=f.engine.prepare('p','discovery');
 const first=await f.engine.stageResearch.run('p',draft.id,8);assert.equal(first.status,'needs_owner',JSON.stringify(first));
 const choice=first.discovery!.ownerChoices[0]!;
 const command={type:'answer-decision' as const,mode:'discovery-condition' as const,project:'p',draft:draft.id,
  verdictRef:choice.verdictRef,conditionId:choice.conditionId,optionId:option};
 const saved=f.engine.execute(command),calls=f.store.list('model-call').length;
 const restarted=new Store(f.path);
 try {
  const engine=new ProductEngine(restarted);assert.deepEqual(engine.execute(command),saved);
  assert.equal(restarted.list('model-call').length,calls);
  const next=await engine.stageResearch.run('p',draft.id,4);
  assert.equal(next.discovery?.state,option==='accept'?'go':'no_go',JSON.stringify(next));
  assert.equal(next.status,option==='accept'?'accepted':'paused',JSON.stringify({next,run:next.research&&restarted.get(next.research.id)?.value}));
  assert.notDeepEqual(next.discovery!.verdict,first.discovery!.verdict);
  assert.equal(restarted.list('research-feedback').length,0);
  const logs=readFileSync(join(f.root,'p.calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const assessed=logs.filter(c=>c.role==='assess-answer'&&c.question.field==='verdict');
  assert.equal(assessed.length,2,'The old verdict was not reused');
  const analyst=logs.find(c=>c.field==='verdict'&&c.context?.ownerDecisions.length===1);
  assert.ok(analyst);assert.deepEqual(analyst.context.ownerDecisions[0].verdict.ref,first.discovery!.verdict);
  const material=assessed[1].context;assert.deepEqual(material.ownerDecisions[0].verdict.ref,first.discovery!.verdict);
  assert.deepEqual(material.fields.researchReport.answer,first.discovery!.report);
  assert.equal(material.ownerDecisions[0].decisions[0].option.optionId,option);
  if(option==='accept') {
   const preparation=logs.find(c=>c.role==='assess-answer'&&c.question.field==='preparation');
   assert.deepEqual(preparation.context.fields.verdict.answer,next.discovery!.verdict);
   assert.equal(preparation.context.ownerDecisions[0].decisions[0].option.optionId,option);
   assert.match(preparation.prompt,/opposite meaning/);
  }
 } finally {restarted.close();}
});

for (const mode of ['missing-constraint','foreign-constraint','opposite-constraint']) test(`DS1.2 real preparation ${mode} cannot be accepted`,async t=>{
 const f=fixture(t);f.setup('p',mode);const draft=f.engine.prepare('p','discovery');
 const result=await f.engine.stageResearch.run('p',draft.id,6);assert.notEqual(result.status,'accepted',JSON.stringify(result));
 const preparation=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='preparation')!;
 assert.equal(preparation.value.status,'open');
 const logs=readFileSync(join(f.root,'p.calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const assessors=logs.filter(c=>c.role==='assess-answer'&&c.question.field==='preparation');
 if(mode==='opposite-constraint') {
  assert.equal(assessors.length,1);assert.match(assessors[0].prompt,/opposite meaning/);
  assert.equal(assessors[0].context.fields.researchReport.value.constraints[0],'Local inputs and outputs only');
  assert.equal(f.store.list<any>('research-assessment').find(a=>a.value.question.id===preparation.id)!.value.verdict,'conflicting');
 } else {
  assert.equal(assessors.length,0,'Formal coverage fails before assessor dispatch');
  assert.equal(f.store.get<any>(result.research!.id)!.value.pauseCode,mode==='missing-constraint'?'discovery_constraint_missing':'discovery_constraint_stale');
 }
});

test('DS1.2 local-only report constraint reaches all later stages and a concrete OM requirement and contract',async t=>{
 const f=fixture(t),concept:any=preparedField('p','conceptSections'),behavior:any=preparedField('p','behaviorContracts');
 concept[0].requirements[0].statement='Transform valid input entirely locally';
 concept[0].requirements[0].acceptance.push('No input or output is transmitted to an external service');
 behavior[0].forbiddenEffects.push('Transmitting input or output to an external service');
 f.setup('p','normal',{conceptSections:concept,behaviorContracts:behavior});
 const stages: any={};
 for(const stage of UPSTREAM_STAGES) {
  const draft=f.engine.prepare('p',stage);
  if(stage!=='discovery') {
   const inherited:any=researchPrerequisites(f.store,draft.value).find(p=>p.stage==='discovery')!.fields.preparation;
   assert.ok(inherited.constraints.some((c:any)=>c.rule==='Local inputs and outputs only'&&c.basis.includes('/constraints/0')));
  }
  const result=await f.engine.stageResearch.run('p',draft.id,8);assert.equal(result.status,'accepted',JSON.stringify({result,run:result.research&&f.store.get(result.research.id)?.value}));
  const artifact=f.store.get<any>(result.stage!.id)!;
  stages[stage]={ref:reference(artifact),contractVersion:5,fields:artifact.value.content.fields};
 }
 const logs=readFileSync(join(f.root,'p.calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 for(const field of ['conceptSections','mapDesign','behaviorContracts','featurePreparation']) {
  const delivered=logs.find(c=>c.field===field);assert.ok(delivered,field);
  assert.ok(delivered.prerequisites.find((p:any)=>p.stage==='discovery').fields.preparation.constraints
   .some((c:any)=>c.rule==='Local inputs and outputs only'&&c.basis.includes('/constraints/0')),field);
 }
 const built=buildOmInput(stages as InputStages);assert.deepEqual(built.refusals,[]);assert.ok(built.input);
 const requirement=built.input.requirements.find(r=>r.id==='p-R1')!;
 assert.ok(requirement);assert.ok(built.input.criteria.some(c=>c.requirement===requirement.id));
 assert.ok(built.input.contracts.some(c=>c.requirements.includes(requirement.id)&&c.forbiddenEffects.includes('Transmitting input or output to an external service')));
 assert.ok(stages.concept.fields.conceptSections[0].requirements[0].acceptance.includes('No input or output is transmitted to an external service'));
});

const DRY5_ADAPTER = `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js',import.meta.url).href)};
import{readFileSync,writeFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,statePath=process.argv[5],fault=JSON.parse(readFileSync(statePath,'utf8'));
appendFileSync(process.argv[3],JSON.stringify(r)+'\\n');
const q=s.questions?.[0]??s.question,field=q.field,values=JSON.parse(readFileSync(process.argv[2],'utf8'));
const source=(s.inventory?.sources??s.originals?.sources??[]).find(x=>x.location==='values');
let foreign=false;
let research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:
{action:'answer',question:q.id,value:boundDiscoveryValue(field,values[field],s.discoveryContext),citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+field}}]};
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
test(`DRY5FIX B corrected ${negative} admits the next analyst proposal and survives restart at nine scenario calls plus six v5 research calls`, async t => {
  const f = dry5StageFixture(t, 'assessor-fields');
  writeFileSync(join(f.root, 'adapter.mjs'), `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js',import.meta.url).href)};
import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,wire=process.argv[3];
const prior=existsSync(wire)?readFileSync(wire,'utf8').trim().split('\\n').map(x=>JSON.parse(x)):[];
appendFileSync(wire,JSON.stringify(r)+'\\n');
const q=s.questions?.[0]??s.question,values=JSON.parse(readFileSync(process.argv[2],'utf8'));
const source=(s.inventory?.sources??s.originals?.sources??[]).find(x=>x.location==='values');
let research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:
{action:'answer',question:q.id,value:boundDiscoveryValue(q.field,values[q.field],s.discoveryContext),citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
if(q.field==='preparation'&&s.role==='assess-answer'){
 const n=prior.filter(x=>x.subject.role==='assess-answer'&&x.subject.question.field==='preparation').length;
 if(n===0)research={verdict:'supported'};
 if(n===1)research={verdict:${JSON.stringify(negative)},reasons:['Revise the proposal']};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:null}));`);
  const draft = f.engine.prepare('p', 'discovery'), first = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.equal(first.status, 'paused');
  assert.equal((f.store.get<any>(first.research!.id)!.value).pauseCode, 'assessment_invalid');
  // v5 adds three assessed research fields before the unchanged preparation/retry sequence.
  const researchFields = ['researchPlan', 'researchReport', 'verdict'];
  assert.deepEqual(f.calls().filter(r => researchFields.includes((r.subject.questions?.[0] ?? r.subject.question).field))
    .map(r => [(r.subject.questions?.[0] ?? r.subject.question).field, r.subject.role]),
    researchFields.flatMap(field => [[field, 'research'], [field, 'assess-answer']]));
  assert.equal(f.calls().length, 12);
  const original = f.store.list<any>('assessment-barrier')[0]!;
  const second = await f.open().stageResearch.run('p', draft.id, 20);
  assert.equal(second.status, 'accepted', JSON.stringify(second));
  assert.equal(f.calls().length, 15);
  assert.deepEqual(f.calls().slice(12).map(r => r.subject.role), ['assess-answer', 'research', 'assess-answer']);
  assert.deepEqual(f.store.get(original.id, original.revision), original, 'The original refusal remains historical');
  const barrier = f.store.get<any>(original.id)!;
  assert.equal(barrier.revision, 2); assert.ok(barrier.value.completion);
  const completed = f.store.get<any>(barrier.value.completion.id, barrier.value.completion.revision)!;
  assert.equal(completed.value.state, 'applied');
  assert.equal(f.store.get<any>(completed.value.after.id, completed.value.after.revision)!.value.result.verdict, negative);
  assert.equal((await f.open().stageResearch.run('p', draft.id, 20)).status, 'accepted');
  assert.equal(f.calls().length, 15);
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
test('DRV1 stop restores a received early answer without sending its next assessor until exact resume', async t => {
  const f = dry5StageFixture(t, 'missing'), draft = f.engine.prepare('p', 'discovery');
  const firstQuestion = f.store.get<Question>(draft.value.questions[0]!)!;
  const restore = dry5Stop(f.store, write => write.kind === 'model-response'
    && String((write.value as {text?: string}).text).includes('"action":"answer"')
    && String((write.value as {text?: string}).text).includes(firstQuestion.id), true);
  await f.engine.stageResearch.run('p', draft.id, 20); restore();
  const calls = f.calls().length;
  const stopped = stopPass(f.store, { project: 'p' });
  if (!stopped.ok) assert.fail(stopped.refusal.message);
  const reopened = f.open();
  const result = await reopened.stageResearch.run('p', draft.id, 20);
  assert.deepEqual([result.status, result.reason?.code, f.calls().length], ['stopped', 'run_stopped', calls]);
  assert.ok(reopened.store.list<any>('research-consumer-intent').some(intent => intent.value.state === 'applied'),
    'the saved physical answer was applied');
  assert.ok(reopened.store.list<any>('research-turn').some(turn => turn.value.status === 'pending'),
    'the paid A reached its durable turn before stop blocked the unpaid B');
  const resumed = resumeStoppedPass(reopened.store, { project: 'p', stop: stopped.value.control!.value.stop!.token });
  if (!resumed.ok) assert.fail(resumed.refusal.message);
  const continued = await f.open().stageResearch.run('p', draft.id, 20);
  assert.equal(continued.status, 'paused', 'the separately injected DRY5 error still ends this external entry');
  assert.ok(f.calls().length > calls, 'new work begins only after the exact stop is resumed');
  const completed = await f.open().stageResearch.run('p', draft.id, 20);
  assert.equal(completed.status, 'accepted', JSON.stringify(completed));
});
test('DRV1 stop before a new web action blocks HTTP and its budget; exact resume admits one transport', async t => {
  const f = fixture(t); f.setup('p');
  const base = f.store.get<Environment>('environment:p')!;
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 4000, webResearch: { enabled: true, gatewayUrl: 'http://127.0.0.1:18890',
      timeoutMs: 4000, limits: { httpAttempts: 8, pages: 2, receivedChars: 10000, responseBytes: 10000 } } }, base.revision);
  const draft = f.engine.prepare('p', 'discovery'), question = f.store.get<Question>(draft.value.questions[0]!)!;
  const run = f.store.write<ResearchRun>({ id: `research-run:web-stop`, kind: 'research-run', expected: 0,
    value: { projectId: 'p', draftId: draft.id, environment: reference(environment), status: 'running', turns: 1,
      limit: 10, inputs: draft.value.inputs, ownerQuestion: null, error: null, pauseCode: null,
      owner: { pid: process.pid, started: 'fixture' }, requestChars: 0 } });
  const action = { action: 'web_search' as const, query: 'subscription harness vendor', purpose: 'find vendor material' };
  const turn = f.store.write<ResearchTurn>({ id: 'research-turn:web-stop:1', kind: 'research-turn', expected: 0,
    value: { run: run.id, number: 1, action, assessment: null, observation: null, error: null,
      status: 'pending', question: reference(question) } });
  const stopped = stopPass(f.store, { project: 'p' }); if (!stopped.ok) assert.fail(stopped.refusal.message);
  let transports = 0;
  const transport = async () => { transports++; return { status: 200, body: { query: action.query, results: [],
    engines_queried: ['fixture'], unresponsive_engines: [] } }; };
  await assert.rejects(executeWebTurn({ store: f.store, projectId: 'p', stage: 'discovery', environment, turn, transport }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'run_stopped');
  assert.deepEqual([transports, f.store.list('web-budget').length, f.store.list('web-capture').length], [0, 0, 0]);
  const resumed = resumeStoppedPass(f.store, { project: 'p', stop: stopped.value.control!.value.stop!.token });
  if (!resumed.ok) assert.fail(resumed.refusal.message);
  const completed = await executeWebTurn({ store: f.store, projectId: 'p', stage: 'discovery', environment, turn, transport });
  assert.deepEqual([completed.turn.value.status, transports], ['completed', 1]);
  const second = f.store.write<ResearchTurn>({ id: 'research-turn:web-stop:2', kind: 'research-turn', expected: 0,
    value: { ...turn.value, number: 2, status: 'pending', observation: null, error: null } });
  const original = f.store.writeMany.bind(f.store); let reservedStop: string | null = null;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!reservedStop && writes.some(write => write.kind === 'web-budget')) {
      const other = new Store(f.path);
      try {
        const result = stopPass(other, { project: 'p' }); if (!result.ok) assert.fail(result.refusal.message);
        reservedStop = result.value.control!.value.stop!.token;
      } finally { other.close(); }
    }
    return rows;
  }) as typeof f.store.writeMany;
  try {
    await assert.rejects(executeWebTurn({ store: f.store, projectId: 'p', stage: 'discovery', environment, turn: second,
      transport }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'run_stopped');
  } finally { f.store.writeMany = original; }
  assert.deepEqual([transports, f.store.list('web-capture').length, f.store.get<ResearchTurn>(second.id)!.value.status],
    [1, 1, 'pending'], 'a stop after reservation prevents the still-unstarted HTTP request');
  assert.ok(reservedStop); const resumedReserved = resumeStoppedPass(f.store, { project: 'p', stop: reservedStop });
  if (!resumedReserved.ok) assert.fail(resumedReserved.refusal.message);
  const retried = await executeWebTurn({ store: f.store, projectId: 'p', stage: 'discovery', environment, turn: second, transport });
  assert.deepEqual([retried.turn.value.status, transports, f.store.list('web-capture').length], ['completed', 2, 2]);
  const third = f.store.write<ResearchTurn>({ id: 'research-turn:web-stop:3', kind: 'research-turn', expected: 0,
    value: { ...turn.value, number: 3, status: 'pending', observation: null, error: null } });
  let entered!: () => void, release!: (reply: { status: number; body: unknown }) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const heldTransport = async () => { transports++; entered(); return new Promise<{ status: number; body: unknown }>(resolve => { release = resolve; }); };
  const inFlight = executeWebTurn({ store: f.store, projectId: 'p', stage: 'discovery', environment, turn: third,
    transport: heldTransport });
  await started;
  const stoppedDuring = stopPass(f.store, { project: 'p' }); if (!stoppedDuring.ok) assert.fail(stoppedDuring.refusal.message);
  release({ status: 200, body: { query: action.query, results: [], engines_queried: ['fixture'], unresponsive_engines: [] } });
  const saved = await inFlight;
  assert.deepEqual([saved.turn.value.status, transports, f.store.list('web-capture').length], ['completed', 3, 3],
    'an admitted HTTP answer is saved after stop');
  const fourth = f.store.write<ResearchTurn>({ id: 'research-turn:web-stop:4', kind: 'research-turn', expected: 0,
    value: { ...turn.value, number: 4, status: 'pending', observation: null, error: null } });
  await assert.rejects(executeWebTurn({ store: f.store, projectId: 'p', stage: 'discovery', environment, turn: fourth,
    transport }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'run_stopped');
  assert.equal(transports, 3, 'the next HTTP is blocked by the saved stop');
});
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


for (const [mode, field, code, count] of [
 ['foreign-report', 'verdict', 'discovery_basis_stale', 9],
 ['missing-constraint', 'preparation', 'discovery_constraint_missing', 11],
 ['foreign-constraint', 'preparation', 'discovery_constraint_stale', 11],
 ['duplicate-plan', 'researchPlan', 'discovery_research_invalid', 5],
] as const) test(`DS1-R2 ${mode}: close the failed proposal, correct once after restart and preserve paid history`, async t => {
 const f=fixture(t);f.setup('p',mode);const draft=f.engine.prepare('p','discovery');
 const first=await f.engine.stageResearch.run('p',draft.id,8);
 assert.equal(first.status,'paused');assert.equal(f.store.get<any>(first.research!.id)!.value.pauseCode,code);
 assert.equal(f.store.list('model-call').length,count);
 const question=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field===field)!;
 const failed=f.store.list<any>('research-turn').find(row=>row.value.question?.id===question.id)!;
 assert.equal(failed.value.status,'completed');assert.equal(failed.value.observation.code,code);
 assert.ok(failed.value.error.includes(question.id),'The failure names its exact question');
 const paid=f.store.list().filter(row=>['model-call','model-response','model-request'].includes(row.kind));
 writeFileSync(join(f.root,'adapter.mjs'),ADAPTER.replaceAll('process.argv[4]',"'normal'"));
 const reopened=new Store(f.path);t.after(()=>reopened.close());const engine=new ProductEngine(reopened);
 const next=await engine.stageResearch.run('p',draft.id,8);
 assert.equal(next.status,'accepted',JSON.stringify({next,run:next.research&&reopened.get(next.research.id)?.value}));
 assert.equal(reopened.list('model-call').length,13,'Twelve normal calls plus exactly one failed analyst proposal');
 const calls=readFileSync(join(f.root,'p.calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(calls.filter(call=>call.field===field).length,2,'Exactly one correcting analyst call');
 assert.equal(calls.filter(call=>call.role==='assess-answer'&&call.question.field===field).length,1);
 const correction=calls[count];assert.equal(correction.field,field);
 assert.equal(correction.failures[0].code,code);assert.deepEqual(correction.failures[0].attempt,reference(failed));
 assert.deepEqual(reopened.get(failed.id),failed,'Completed original refusal is immutable');
 for(const row of paid)assert.deepEqual(reopened.get(row.id),row);
 const {readResearchConsumerTurn}=await import('../src/discovery/response-recovery.js');
 for(const turn of reopened.list('research-turn'))assert.doesNotThrow(()=>readResearchConsumerTurn(reopened,reference(turn)));
 assert.equal((await engine.stageResearch.run('p',draft.id,8)).status,'accepted');
 assert.equal(reopened.list('model-call').length,13,'Accepted replay does not pay again');
});

test('DS1-R2 a native report change after a valid paid proposal remains stale without a corrective call', async t => {
 const f=fixture(t);f.setup('p');const draft=f.engine.prepare('p','discovery');
 const verdict=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='verdict')!;
 const restore=dry5Stop(f.store,write=>write.kind==='model-response'
  &&(write.value as any).text?.includes(verdict.id),true);
 await f.engine.stageResearch.run('p',draft.id,8);restore();
 assert.equal(f.store.list('model-call').length,9);
 const original=f.store.list<any>('research-consumer-intent').find(row=>row.value.question.id===verdict.id)!;
 const delivered=original.value.cursor.context.discoveryContext;
 const report=f.store.get<Question>(delivered.fields.researchReport.question.id)!;
 const oldAnswer=report.value.answer!;
 const open=f.engine.discovery.reopen(report.id,report.revision);
 const value=structuredClone(delivered.fields.researchReport.value);
 value.constraints.push('The changed report requires an additional local boundary');
 const source=f.engine.discovery.evidence.document('p','changed-report',JSON.stringify(value),'application/json',0);
 const {assessAnswer}=await import('../src/discovery/research-assessment.js');
 const environment=f.engine.environments.get('p');
 const assessment=await assessAnswer(f.store,open,{action:'answer',question:open.id,value,
  citations:[{source:reference(source),selector:{kind:'json-pointer',pointer:''}}]},environment,f.root);
 f.engine.discovery.researched(open.id,open.revision,reference(assessment));
 assert.notDeepEqual(f.store.get<Question>(report.id)!.value.answer,oldAnswer);
 const paid=f.store.list('model-call').map(reference),reopened=new Store(f.path);t.after(()=>reopened.close());
 const engine=new ProductEngine(reopened);
 for(let i=0;i<2;i++) {
  const result=await engine.stageResearch.run('p',draft.id,8);
  assert.equal(result.status,'paused');
  assert.equal(reopened.get<any>(result.research!.id)!.value.pauseCode,'input_stale');
  assert.deepEqual(reopened.list('model-call').map(reference),paid);
  assert.equal(reopened.list<any>('research-turn').filter(row=>row.value.observation?.contract==='early-research-outcome/v1').length,0);
 }
});


test('DS1-R2 missing delivered grounds are an input refusal, not an erroneous model answer', async t => {
 const f=fixture(t);f.setup('p');const draft=f.engine.prepare('p','discovery');
 await f.engine.researcher.run('p',draft.id,4);
 const question=draft.value.questions.map(id=>f.store.get<Question>(id)!).find(q=>q.value.spec.field==='verdict')!;
 const {discoveryContext}=await import('../src/discovery/discovery-outcome.js');
 const context=discoveryContext(f.store,f.store.get<DiscoveryDraft>(draft.id)!,question).context!;
 const {boundDiscoveryValue}=await import('./preparation-fixture.js');
 const action={action:'answer',question:question.id,value:boundDiscoveryValue('verdict',preparedField('p','verdict'),context),
  citations:[{source:reference(f.store.list('source')[0]!),selector:{kind:'json-pointer',pointer:'/verdict'}}]};
 const {earlyResearchFailure}=await import('../src/discovery/early-research-outcome.js');
 assert.equal(earlyResearchFailure(draft.value,question.value,'analyst',action,context),null);
 const incomplete=structuredClone(context);delete incomplete.fields.researchReport;
 for(const grounds of [null,incomplete])assert.throws(
  ()=>earlyResearchFailure(draft.value,question.value,'analyst',action,grounds),{code:'discovery_basis_missing'});
});


import { discoveryBasisCatalogue } from '../src/discovery/discovery-outcome.js';
import { EngineError } from '../src/errors.js';

test('DS1.2a D accepted Discovery preserves report links, owner constraints and the chosen variant as exact catalogue values', async t => {
  const f = fixture(t); f.setup('catalogue');
  const draft = f.engine.prepare('catalogue', 'discovery');
  const result = await f.engine.stageResearch.run('catalogue', draft.id, 8);
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  const stage = f.store.get<{ content: { fields: Record<string, Json> } }>(result.stage!.id, result.stage!.revision)!;
  const source = { ref: reference(stage), fields: stage.value.content.fields }, before = canonical(source);
  const calls = f.store.list('model-call').length, catalogue = discoveryBasisCatalogue(source);
  assert.equal(catalogue.contract, 'discovery-basis-catalogue/v1'); assert.deepEqual(catalogue.source, reference(stage));
  const constraints = (source.fields.preparation as any).constraints;
  assert.equal(catalogue.constraints.length, constraints.length, 'The report is not duplicated as a second obligation');
  for (const [index, entry] of catalogue.constraints.entries()) {
    assert.deepEqual(entry.address, { record: reference(stage), pointer: `/content/fields/preparation/constraints/${index}` });
    assert.deepEqual(entry.value, constraints[index]);
  }
  const reported = catalogue.constraints.find(entry => (entry.value as any).rule === 'Local inputs and outputs only')!;
  assert.deepEqual(JSON.parse((reported.value as any).basis), { report: result.discovery!.report, pointer: '/constraints/0' });
  const extra = catalogue.constraints.find(entry => (entry.value as any).basis === 'Accepted fixture scope')!;
  assert.ok(extra); assert.equal(Object.hasOwn(extra, 'report'), false); assert.equal(Object.hasOwn(reported, 'citations'), false);
  assert.deepEqual(catalogue.variant, { address: { record: reference(stage), pointer: '/content/fields/verdict/variant' },
    value: (source.fields.verdict as any).variant });
  const concept = f.engine.prepare('catalogue', 'concept'), oldMaterial = canonical(researchPrerequisites(f.store, concept.value));
  (catalogue.constraints[0]!.value as any).rule = 'caller edit';
  assert.equal(canonical(source), before); assert.notEqual((discoveryBasisCatalogue(source).constraints[0]!.value as any).rule, 'caller edit');
  assert.equal(canonical(researchPrerequisites(f.store, concept.value)), oldMaterial, 'The existing v5 context is not expanded');
  assert.equal(f.store.list('model-call').length, calls);
});

test('DS1.2a D missing material has an address; empty constraints and an exact variant remain explicit', () => {
  const valid = { ref: { id: 'stage:catalogue:discovery', revision: 1, hash: 'a'.repeat(64) },
    fields: { preparation: { constraints: [{ id: 'scope', rule: 'Local only', basis: 'owner choice' }] },
      verdict: { outcome: 'go', variant: 'local' } } };
  const cases: [string, (value: any) => void][] = [
    ['source', value => { delete value.ref; }], ['source', value => { value.ref.id = 'stage:catalogue:concept'; }],
    ['fields', value => { delete value.fields; }], ['preparation', value => { delete value.fields.preparation; }],
    ['preparation', value => { delete value.fields.preparation.constraints; }], ['preparation', value => { value.fields.preparation.constraints = null; }],
    ...['id', 'rule', 'basis'].map(field => ['preparation', (value: any) => { delete value.fields.preparation.constraints[0][field]; }] as [string, (value: any) => void]),
    ['verdict', value => { delete value.fields.verdict; }], ['verdict', value => { delete value.fields.verdict.variant; }],
    ['verdict', value => { value.fields.verdict.outcome = 'conditional'; }],
  ];
  for (const [field, change] of cases) {
    const candidate = structuredClone(valid); change(candidate);
    assert.throws(() => discoveryBasisCatalogue(candidate), (error: unknown) => error instanceof EngineError
      && error.code === 'discovery_basis_catalogue_invalid' && (error.details as any).field === field
      && typeof (error.details as any).pointer === 'string');
  }
  valid.fields.preparation.constraints = [];
  assert.deepEqual(discoveryBasisCatalogue(valid).constraints, []);
  assert.equal(discoveryBasisCatalogue(valid).variant.value, 'local');
});

test('DS1.2a D a second Store advances Discovery; old catalogue remains exact and its source guards current publication', async t => {
  const f = fixture(t); f.setup('history'); const draft = f.engine.prepare('history', 'discovery');
  const result = await f.engine.stageResearch.run('history', draft.id, 8); assert.equal(result.status, 'accepted');
  const saved = f.store.get<{ content: { fields: Record<string, Json> } }>(result.stage!.id, result.stage!.revision)!;
  const before = discoveryBasisCatalogue({ ref: reference(saved), fields: saved.value.content.fields });
  const second = new Store(f.path);
  try {
    const content = structuredClone(saved.value.content); (content.fields.verdict as any).variant = 'new draft variant';
    const revised = new ProductEngine(second).pipeline.draft('history', 'discovery', content, saved.revision);
    assert.ok(revised.revision > saved.revision);
    const historical = f.store.get<typeof saved.value>(saved.id, saved.revision)!;
    assert.deepEqual(discoveryBasisCatalogue({ ref: reference(historical), fields: historical.value.content.fields }), before);
    assert.throws(() => f.store.writeMany([], [before.source]), (error: unknown) => error instanceof EngineError
      && /stale|conflict/.test(error.code), 'The exact catalogue source participates in the consumer transaction guard');
    assert.deepEqual(reference(f.store.get(saved.id)!), reference(revised));
  } finally { second.close(); }
});

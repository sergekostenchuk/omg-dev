import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../src/canonical.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { REQUIREMENTS, UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { executeWebTurn } from "../src/discovery/web-research.js";
import { EngineError } from "../src/errors.js";
import { designOf } from "../src/graph/builder.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { gardenGraph, prepareOmFixtureStages } from "./om-fixture.js";
import { resumeStoppedPass, stopPass } from "../src/om/run-driver.js";
import { isRef, reference, uniqueRefs } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import type { EarlyStageInstruction, EarlyStageOutcome } from "../src/product/early-stage-driver.js";
import { preparedField } from "./preparation-fixture.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../src/storage/store.js";
import type { Environment } from "../src/runtime/environment.js";

const ADAPTER = `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js',import.meta.url).href)};
import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
if(!c){appendFileSync(process.argv[4],JSON.stringify({pid:process.pid})+'\\n');process.kill(process.pid,'SIGSTOP')}
if(!c.role){appendFileSync(process.argv[4],JSON.stringify({pid:process.pid})+'\\n');process.kill(process.pid,'SIGSTOP')}
if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
if(!Array.isArray(c.inventory.sources)){const t=c.inventory.sources;c.inventory.sources=t.rows.map(row=>Object.fromEntries(t.columns.map((column,i)=>[column,row[i]])));}
appendFileSync(process.argv[3],JSON.stringify({role:c.role,field:c.questions?.[0]?.field})+'\\n');
if(c?.role&&existsSync(process.argv[5])&&readFileSync(process.argv[5],'utf8').trim()===c.role){appendFileSync(process.argv[6],JSON.stringify({pid:process.pid})+'\\n');process.kill(process.pid,'SIGSTOP')}
let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.role==='assess-escalation')research={necessary:true,reason:'The owner must decide the unavailable constraint'};
else {const q=c.questions[0],source=c.inventory.sources.find(s=>s.location==='values'),values=JSON.parse(readFileSync(process.argv[2],'utf8'));
 if(values.needOwner){const read=[...(c.history??[]),c.currentRead].some(t=>t?.action?.action==='read_source');
  research=read?{action:'need_owner',question:q.id,reason:'The source does not contain the owner constraint',searched:[source.ref]}:
   {action:'read_source',source:source.ref,start:0,end:source.length};}
 else if(values.modelPause)research={action:'pause',reason:'Fixture model pause'};
 else {const value=boundDiscoveryValue(q.field,structuredClone(values[q.field]),c.discoveryContext);
  if(q.field==='conceptSections'&&c.discoveryBasisCatalogue)
   for(const [sectionIndex,section] of value.entries())for(const [requirementIndex,requirement] of section.requirements.entries())
    requirement.applications=[c.discoveryBasisCatalogue.variant,...c.discoveryBasisCatalogue.constraints].map(entry=>({contract:'basis-application/v1',basis:entry.address,
     appliedAt:['/'+sectionIndex+'/requirements/'+requirementIndex+'/'+(entry===c.discoveryBasisCatalogue.variant?'statement':'acceptance/0')]}));
  if(q.field==='behaviorContracts'&&c.discoveryBasisCatalogue)
   for(const [index,contract] of value.entries())contract.applications=[c.discoveryBasisCatalogue.variant,...c.discoveryBasisCatalogue.constraints].map(entry=>({
    contract:'basis-application/v1',basis:entry.address,appliedAt:[entry===c.discoveryBasisCatalogue.variant?'/'+index+'/entry':'/'+index+'/success/0']}));
  if(q.field==='conceptSections'&&!c.consumerFeedback.length)value[0].requirements[0].outcome='invalid-outcome';
  if(q.field==='mapDesign'&&!c.consumerFeedback.length)value.nodes[0].outcome='missing-artifact';
  research={action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};}}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));`;

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-early-driver-"));
  const database = join(root, "state.sqlite"), workspace = join(root, "repo");
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "early driver\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(database), engine = new ProductEngine(store);
  writeFileSync(join(root, "adapter.mjs"), ADAPTER);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const configure = (project: string) => {
    const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
      spec.field === "mapDesign" ? designOf(enrichedGraph(exampleGraph(project), project)) : preparedField(project, spec.field)])));
    const values = join(root, `${project}.json`), trace = join(root, `${project}.calls`), omPause = join(root, `${project}.om-pause`),
      earlyHold = join(root, `${project}.early-hold`), earlyPause = join(root, `${project}.early-pause`);
    writeFileSync(values, JSON.stringify(fields));
    engine.discovery.evidence.document(project, "values", JSON.stringify(fields), "application/json", 0);
    const command = { executable: process.execPath, args: [join(root, "adapter.mjs"), values, trace, omPause, earlyHold, earlyPause] };
    engine.environments.configure(project, { workspace,
      implementer: { actor: "author", model: "fixture", effort: "high", command },
      reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
      fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 4000, requestCapacityChars: 300_000 }, 0);
    engine.execute({ type: "configure-om-dispatch", project, protocol: "codex-stdio" });
    return { values, trace, omPause, earlyHold, earlyPause };
  };
  const setup = (project: string) => {
    engine.execute({ type: "create-project", project, title: project });
    return configure(project);
  };
  const calls = (trace: string) => existsSync(trace)
    ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { root, database, store, engine, setup, configure, calls };
}

async function pauseCount(path: string, expected: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const count = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
    if (count >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`OM adapter did not reach pause ${expected}`);
}

function stopFrom(database: string, project: string): string {
  const store = new Store(database);
  try {
    const stopped = stopPass(store, { project });
    if (!stopped.ok) assert.fail(stopped.refusal.message);
    return stopped.value.control!.value.stop!.token;
  } finally { store.close(); }
}

function acceptDiscovery(engine: ProductEngine, project: string, expected: number): Revision<DiscoveryDraft> {
  const draft = engine.prepare(project, "discovery");
  const source = engine.store.list<{ projectId: string; content: string }>("source")
    .find(row => row.value.projectId === project)!;
  for (const id of draft.value.questions) {
    const question = engine.store.get<Question>(id)!;
    const field = question.value.spec.field, value = preparedField(project, field);
    if (question.value.spec.kind === "fact") engine.discovery.fact(id, question.revision, reference(source),
      { kind: "text-range", start: 0, end: source.value.content.length });
    else if (["researchPlan", "researchReport", "verdict", "preparation"].includes(field))
      answerDiscoveryFixture(engine, project, engine.store.get<DiscoveryDraft>(draft.id)!, question, value, source);
    else engine.discovery.decision(id, question.revision, "owner", value);
  }
  const artifact = engine.draft(project, "discovery", draft.id, expected);
  engine.pipeline.accept(project, "discovery", artifact.revision);
  return engine.store.get<DiscoveryDraft>(draft.id)!;
}

function instruction(project: string, text = `Build the exact ${project} product described here.`): EarlyStageInstruction {
  return { title: project, id: "instruction", text, media: "text/plain",
    brief: { kind: "text-range", start: 0, end: text.length } };
}

test("IN1 creates the Project first and resumes after that committed boundary", async t => {
  const f = fixture(t), input = instruction("p");
  const original = f.store.writeMany.bind(f.store); let crashed = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(writes, guards);
    if (!crashed && writes.some(write => write.kind === "project" && write.id === "project:p")) {
      crashed = true; throw new Error("crash after project");
    }
    return saved;
  };
  try {
    await assert.rejects(async () => f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
      maxCalls: 1, instruction: input }), /crash after project/);
  } finally { f.store.writeMany = original; }
  const { trace } = f.configure("p"), reopened = new Store(f.database); t.after(() => reopened.close());
  const result = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 1, instruction: input }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade],
    ["stage_paused", "research_call_allowance", 1]);
  assert.deepEqual([reopened.history("project:p").length, reopened.history("source:p:instruction").length,
    reopened.history("early-stage-input:p").length, f.calls(trace).length], [1, 1, 1, 1]);
});

test("IN1 refuses missing instruction and an invalid selector before project, draft or run control", async t => {
  const f = fixture(t);
  const missing = await f.engine.execute({ type: "early-stage-run", project: "missing", maxTurns: 1,
    maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([missing.end, missing.reason?.code, missing.budget.callsMade], ["blocked", "instruction_missing", 0]);
  const invalid = await f.engine.execute({ type: "early-stage-run", project: "invalid", maxTurns: 1, maxCalls: 1,
    instruction: { ...instruction("invalid", "short"), brief: { kind: "text-range", start: 0, end: 99 } } }) as EarlyStageOutcome;
  const noBrief = { title: "missing-selector", id: "instruction", text: "Exact request", media: "text/plain" } as unknown as EarlyStageInstruction;
  const missingSelector = await f.engine.earlyStages.run({ project: "missing-selector", maxTurns: 1, maxCalls: 1,
    instruction: noBrief });
  assert.deepEqual([invalid.end, invalid.reason?.code, invalid.budget.callsMade], ["blocked", "selector_invalid", 0]);
  assert.deepEqual([missingSelector.end, missingSelector.reason?.code, missingSelector.budget.callsMade],
    ["blocked", "selector_invalid", 0]);
  for (const project of ["missing", "invalid", "missing-selector"]) {
    assert.equal(f.store.get(`project:${project}`), null);
    assert.equal(f.store.get(`om-run-control:${project}`), null);
    assert.equal(f.store.get(`early-stage-input:${project}`), null);
    assert.equal(f.store.list<DiscoveryDraft>("discovery-draft").some(row => row.value.projectId === project), false);
  }
});

test("IN1 automatic objective names the copier while ordinary answer-decision names only the local caller", async t => {
  const f = fixture(t); f.setup("p");
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 1, maxCalls: 1,
    instruction: instruction("p") });
  const draft = f.engine.discovery.create("p", "discovery", "R0", "concept", [{ field: "choice", kind: "decision",
    prompt: "Choose", risk: "Missing choice", schema: { type: "string", minLength: 1 } }]);
  const question = f.store.get<Question>(draft.value.questions[0]!)!;
  f.engine.execute({ type: "answer-decision", question: question.id, expected: question.revision, value: "chosen" });
  const answer = f.store.get<any>(f.store.get<Question>(question.id)!.value.answer!.id)!;
  assert.equal(answer.value.actor, "local-caller");
  assert.notEqual(answer.value.actor, "local-owner", "an unauthenticated command caller is not labelled as the owner");
});

for (const boundary of ["source", "early-stage-input", "discovery-draft", "fact"] as const)
test(`IN1 restart after committed ${boundary} resumes one input and one draft without duplicate calls`, async t => {
  const f = fixture(t), { trace } = f.setup("p"), input = instruction("p");
  const original = f.store.writeMany.bind(f.store); let crashed = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(writes, guards);
    if (!crashed && writes.some(write => write.kind === boundary
      && (boundary !== "source" || write.id === "source:p:instruction"))) {
      crashed = true; throw new Error(`crash after ${boundary}`);
    }
    return saved;
  };
  try {
    await assert.rejects(async () => f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
      maxCalls: 1, instruction: input }), new RegExp(`crash after ${boundary}`));
  } finally { f.store.writeMany = original; }
  const reopened = new Store(f.database); t.after(() => reopened.close());
  const result = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 1, instruction: input }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade],
    ["stage_paused", "research_call_allowance", 1]);
  assert.deepEqual([reopened.history("source:p:instruction").length, reopened.history("early-stage-input:p").length,
    reopened.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.projectId === "p" && row.value.stage === "discovery").length,
    reopened.list("fact").length, reopened.list("decision").filter(row => (row.value as any).actor === "driver:verbatim").length,
    f.calls(trace).length], [1, 1, 1, 1, 1, 1]);
});

test("IN1 refuses a competing Source at its address before the first Source commit", async t => {
  const f = fixture(t), { trace } = f.setup("p"), input = instruction("p");
  const original = f.store.writeMany.bind(f.store); let moved = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!moved && writes.some(write => write.kind === "source" && write.id === "source:p:instruction")) {
      moved = true; const other = new Store(f.database);
      try { new ProductEngine(other).execute({ type: "source-document", project: "p", id: "instruction",
        text: "A competing assignment requiring explicit review.", media: "text/plain", expected: 0 }); }
      finally { other.close(); }
    }
    return original<T>(writes, guards);
  };
  let result: EarlyStageOutcome;
  try { result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 1, instruction: input }) as EarlyStageOutcome; }
  finally { f.store.writeMany = original; }
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade, f.calls(trace).length],
    ["blocked", "instruction_stale", 0, 0]);
  assert.deepEqual([f.store.get("early-stage-input:p"), f.store.list<DiscoveryDraft>("discovery-draft")
    .some(row => row.value.projectId === "p"), f.store.list("fact").length, f.store.list("decision").length],
  [null, false, 0, 0]);
});

for (const boundary of ["early-stage-input", "discovery-draft", "fact", "decision"] as const)
test(`IN1 Source move before ${boundary} commit refuses the window without that partial answer`, async t => {
  const f = fixture(t), { trace } = f.setup("p"), input = instruction("p");
  const original = f.store.writeMany.bind(f.store); let moved = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!moved && writes.some(write => write.kind === boundary)) {
      moved = true; const other = new Store(f.database);
      try { new ProductEngine(other).execute({ type: "source-document", project: "p", id: "instruction",
        text: "A changed assignment requiring explicit review.", media: "text/plain", expected: 1 }); }
      finally { other.close(); }
    }
    return original<T>(writes, guards);
  };
  let result: EarlyStageOutcome;
  try { result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 1, instruction: input }) as EarlyStageOutcome; }
  finally { f.store.writeMany = original; }
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade, f.calls(trace).length],
    ["blocked", "input_stale", 0, 0]);
  const driverDecisions = f.store.list("decision").filter(row => (row.value as any).actor === "driver:verbatim").length;
  const expected = boundary === "early-stage-input" ? [0, 0, 0, 0]
    : boundary === "discovery-draft" ? [1, 0, 0, 0]
    : boundary === "fact" ? [1, 1, 0, 0] : [1, 1, 1, 0];
  assert.deepEqual([f.store.list("early-stage-input").length,
    f.store.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.projectId === "p").length,
    f.store.list("fact").length, driverDecisions], expected,
  "only complete earlier boundaries may survive; the raced write is atomic");
});

test("IN1 explicitly revises an unfinished input without rewriting its paid draft", async t => {
  const f = fixture(t), { trace } = f.setup("p"), first = instruction("p");
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30, maxCalls: 2, instruction: first });
  assert.equal(f.engine.pipeline.inspect("p", "discovery").state, "missing");
  const oldDraft = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.stage === "discovery")!;
  const oldQuestions = oldDraft.value.questions.map(id => reference(f.store.get<Question>(id)!));
  const calls = f.calls(trace).length, revised = instruction("p", "Build the revised unfinished assignment.");
  f.engine.execute({ type: "source-document", project: "p", id: revised.id, text: revised.text,
    media: revised.media, expected: 1 });
  const result = f.engine.execute({ type: "revise-early-stage-input", project: "p", expected: 1,
    instruction: revised }) as { binding: ReturnType<typeof reference>; discovery: null };
  assert.equal(result.discovery, null);
  assert.deepEqual(oldDraft.value.questions.map(id => reference(f.store.get<Question>(id)!)), oldQuestions);
  assert.equal(f.calls(trace).length, calls);
  const reopened = new Store(f.database); t.after(() => reopened.close());
  const continued = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p",
    maxTurns: 30, maxCalls: 1, instruction: revised }) as EarlyStageOutcome;
  assert.deepEqual([continued.end, continued.reason?.code, continued.budget.callsMade],
    ["stage_paused", "research_call_allowance", 1]);
  assert.equal(reopened.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "discovery").length, 2);
  assert.equal(f.calls(trace).length, calls + 1);
});

test("IN1 explicitly revises a changed input, marks dependent research stale and resumes from a new exact draft", async t => {
  const f = fixture(t), { trace } = f.setup("p"), originalInput = instruction("p");
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 10,
    maxCalls: 100, instruction: originalInput });
  assert.equal(f.engine.pipeline.inspect("p", "discovery").state, "accepted");
  const oldStage = f.store.get<any>("stage:p:discovery")!;
  const oldDraft = f.store.get<DiscoveryDraft>(oldStage.value.content.draft.id)!;
  const oldQuestions = oldDraft.value.questions.map(id => reference(f.store.get<Question>(id)!));
  const paid = f.store.list("model-call").map(reference), paidCount = f.calls(trace).length;

  const changed = instruction("p", "Build the first corrected product requested by the owner.");
  f.engine.execute({ type: "source-document", project: "p", id: changed.id, text: changed.text,
    media: changed.media, expected: 1 });
  const staleStore = new Store(f.database); t.after(() => staleStore.close());
  const stale = await new ProductEngine(staleStore).execute({ type: "early-stage-run", project: "p",
    maxTurns: 1, maxCalls: 1, instruction: changed }) as EarlyStageOutcome;
  assert.deepEqual([stale.end, stale.reason?.code, stale.budget.callsMade, f.calls(trace).length],
    ["blocked", "instruction_stale", 0, paidCount]);

  const finalInput = instruction("p", "Build the final corrected product requested by the owner.");
  const originalWrite = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!raced && writes.some(write => write.id === "early-stage-input:p")) {
      raced = true; const competing = new Store(f.database);
      try { new ProductEngine(competing).execute({ type: "source-document", project: "p", id: finalInput.id,
        text: finalInput.text, media: finalInput.media, expected: 2 }); }
      finally { competing.close(); }
    }
    return originalWrite<T>(writes, guards);
  };
  try {
    assert.throws(() => f.engine.execute({ type: "revise-early-stage-input", project: "p", expected: 1,
      instruction: changed }), (error: unknown) => error instanceof EngineError && error.code === "input_stale");
  } finally { f.store.writeMany = originalWrite; }
  assert.deepEqual([f.store.get("early-stage-input:p")!.revision, reference(f.store.get("stage:p:discovery")!),
    f.calls(trace).length], [1, reference(oldStage), paidCount], "the losing revision writes no partial binding or stage");

  const revisedStore = new Store(f.database); t.after(() => revisedStore.close());
  const revisedEngine = new ProductEngine(revisedStore);
  const revised = revisedEngine.execute({ type: "revise-early-stage-input", project: "p", expected: 1,
    instruction: finalInput }) as { binding: ReturnType<typeof reference>; discovery: ReturnType<typeof reference> };
  const binding = revisedStore.get<any>("early-stage-input:p")!, discovery = revisedStore.get<any>("stage:p:discovery")!;
  assert.deepEqual([revised.binding, binding.revision, binding.value.source.revision,
    revised.discovery, discovery.revision, discovery.value.status],
  [reference(binding), 2, 3, reference(discovery), oldStage.revision + 1, "draft"]);
  assert.deepEqual(oldDraft.value.questions.map(id => reference(revisedStore.get<Question>(id)!)), oldQuestions,
    "explicit revision marks prior answers for review without reopening or rewriting them");
  assert.deepEqual(revisedStore.list("model-call").map(reference), paid, "paid work remains exact history");
  const assessments = revisedEngine.projection("p").questions
    .filter(row => oldDraft.value.questions.includes(row.id)).map(row => row.assessment.state);
  assert.ok(assessments.length > 0 && assessments.every(state => state === "stale"));

  const repeated = revisedEngine.execute({ type: "revise-early-stage-input", project: "p", expected: 1,
    instruction: finalInput }) as { binding: ReturnType<typeof reference>; discovery: ReturnType<typeof reference> };
  assert.deepEqual([repeated, revisedStore.history("early-stage-input:p").length,
    revisedStore.history("stage:p:discovery").length],
  [revised, 2, oldStage.revision + 1], "a lost response repeats without another revision");

  const continuedStore = new Store(f.database); t.after(() => continuedStore.close());
  const continued = await new ProductEngine(continuedStore).execute({ type: "early-stage-run", project: "p",
    maxTurns: 10, maxCalls: 1, instruction: finalInput }) as EarlyStageOutcome;
  assert.deepEqual([continued.end, continued.stage, continued.reason?.code, continued.budget.callsMade],
    ["stage_paused", "discovery", "research_call_allowance", 1]);
  const drafts = continuedStore.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "discovery");
  const fresh = drafts.find(row => row.id !== oldDraft.id)!;
  assert.equal(drafts.length, 2);
  assert.deepEqual(fresh.value.inputs, uniqueRefs([binding.value.project, binding.value.source, reference(binding)]));
  assert.deepEqual(oldDraft.value.questions.map(id => reference(continuedStore.get<Question>(id)!)), oldQuestions);
  assert.equal(f.calls(trace).length, paidCount + 1, "only the new assignment starts one new physical call");

  const exactStore = new Store(f.database); t.after(() => exactStore.close());
  const exact = await new ProductEngine(exactStore).execute({ type: "early-stage-run", project: "p",
    draftId: fresh.id, maxTurns: 10, maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([exact.end, exact.stage, exact.draft?.id, exact.reason?.code, exact.budget.callsMade],
    ["stage_paused", "discovery", fresh.id, "research_call_allowance", 1],
    "the returned revised draft remains the exact restart door instead of conflicting with the historical stage binding");
  assert.equal(f.calls(trace).length, paidCount + 2);
});

test("IN1 revision between revised-draft selection and write refuses the old basis and restarts on the winner", async t => {
  const f = fixture(t), { trace } = f.setup("p"), first = instruction("p");
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30, maxCalls: 1, instruction: first });
  const oldDraft = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.stage === "discovery")!;
  const second = instruction("p", "Build the second exact assignment.");
  f.engine.execute({ type: "source-document", project: "p", id: second.id, text: second.text,
    media: second.media, expected: 1 });
  f.engine.execute({ type: "revise-early-stage-input", project: "p", expected: 1, instruction: second });
  const third = instruction("p", "Build the third exact assignment that wins the write window.");
  const original = f.store.writeMany.bind(f.store); let revised = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!revised && writes.some(write => write.kind === "discovery-draft")) {
      revised = true; const other = new Store(f.database);
      try {
        const engine = new ProductEngine(other);
        engine.execute({ type: "source-document", project: "p", id: third.id, text: third.text,
          media: third.media, expected: 2 });
        engine.execute({ type: "revise-early-stage-input", project: "p", expected: 2, instruction: third });
      } finally { other.close(); }
    }
    return original<T>(writes, guards);
  };
  let raced: EarlyStageOutcome;
  try { raced = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 1, instruction: second }) as EarlyStageOutcome; }
  finally { f.store.writeMany = original; }
  assert.deepEqual([revised, raced.end, raced.reason?.code, raced.budget.callsMade,
    f.store.list<DiscoveryDraft>("discovery-draft").length, f.calls(trace).length],
  [true, "blocked", "input_stale", 0, 1, 1], "the losing selector writes no draft or paid call");
  assert.equal(f.store.get<DiscoveryDraft>(oldDraft.id)!.id, oldDraft.id);

  const reopened = new Store(f.database); t.after(() => reopened.close());
  const resumed = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p",
    maxTurns: 30, maxCalls: 1, instruction: third }) as EarlyStageOutcome;
  const fresh = reopened.list<DiscoveryDraft>("discovery-draft").find(row => row.id !== oldDraft.id)!;
  assert.deepEqual([resumed.end, resumed.stage, resumed.draft?.id, resumed.reason?.code,
    resumed.budget.callsMade, reopened.list("discovery-draft").length, f.calls(trace).length],
  ["stage_paused", "discovery", fresh.id, "research_call_allowance", 1, 2, 2]);
});

for (const paid of [
  { name: "analyst A", marker: '"action":"answer"', needOwner: false },
  { name: "answer assessor B", marker: '"verdict":"supported"', needOwner: false },
  { name: "escalation assessor C", marker: '"necessary":true', needOwner: true },
] as const) test(`IN1 revised draft restores paid ${paid.name} through explicit and automatic stopped selection`, async t => {
  const f = fixture(t), { values, trace } = f.setup("p"), originalInput = instruction("p");
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 4,
    maxCalls: 100, instruction: originalInput });
  assert.equal(f.engine.pipeline.inspect("p", "discovery").state, "accepted");
  const oldDraft = f.store.get<any>("stage:p:discovery")!.value.content.draft.id;
  const revisedInput = instruction("p", "Revised instruction with its own saved research generation.");
  f.engine.execute({ type: "source-document", project: "p", id: revisedInput.id, text: revisedInput.text,
    media: revisedInput.media, expected: 1 });
  f.engine.execute({ type: "revise-early-stage-input", project: "p", expected: 1, instruction: revisedInput });
  if (paid.needOwner) {
    const fields = JSON.parse(readFileSync(values, "utf8")); fields.needOwner = true;
    writeFileSync(values, JSON.stringify(fields));
  }
  const original = f.store.writeMany.bind(f.store); let stopped = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(writes, guards);
    if (!stopped && writes.some(write => write.kind === "model-response"
      && String((write.value as { text?: string }).text).includes(paid.marker))) {
      stopped = true; stopFrom(f.database, "p");
      throw new EngineError("probe_paid_stop", "Stop after a revised paid response and before its application");
    }
    return saved;
  };
  let first: EarlyStageOutcome;
  try { first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 100, instruction: revisedInput }) as EarlyStageOutcome; }
  finally { f.store.writeMany = original; }
  assert.deepEqual([stopped, first.end, first.reason?.code], [true, "stopped", "run_stopped"]);
  const fresh = f.store.list<DiscoveryDraft>("discovery-draft")
    .find(row => row.value.stage === "discovery" && row.id !== oldDraft)!;
  const pending = ["research-consumer-intent", "assessment-application"].flatMap(kind =>
    f.store.list<any>(kind).filter(row => row.value.state === "running").map(row => row.id));
  assert.ok(pending.length > 0);
  const calls = f.calls(trace).length, reopened = new Store(f.database); t.after(() => reopened.close());
  const engine = new ProductEngine(reopened);
  const explicit = await engine.execute({ type: "early-stage-run", project: "p", draftId: fresh.id,
    maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  const automatic = await engine.execute({ type: "early-stage-run", project: "p",
    maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([explicit.end, explicit.draft?.id, explicit.stageResult?.status,
    automatic.end, automatic.draft?.id, automatic.stageResult?.status,
    f.calls(trace).length],
  ["stopped", fresh.id, "stopped", "stopped", fresh.id, "stopped", calls]);
  assert.ok(pending.some(id => reopened.get<any>(id)?.value.state === "applied"));
});

test("DRV1 one entry uses StageResearch for five stages, builds the real L1 and stops at the shared early-call boundary", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 36, instruction: instruction("p") }) as EarlyStageOutcome;
  assert.equal(result.end, "om_ready", JSON.stringify(result));
  assert.ok(UPSTREAM_STAGES.every(stage => f.engine.pipeline.inspect("p", stage).state === "accepted"));
  assert.ok(f.store.get("graph:p"), "operation-map used the existing build-map producer");
  assert.equal(result.budget.callsMade, f.store.list<any>("model-call").filter(row => row.value.draftId).length,
    "only new early physical dispatches consume maxCalls");
  assert.deepEqual([result.budget.callsMade, result.budget.callsRemaining], [36, 0]);
  assert.ok(result.budget.turnsUsed > 0 && result.budget.turnsUsed <= result.budget.maxTurns);
  assert.equal(f.calls(trace).length, 36);
  assert.equal(f.store.get("om-input:p"), null, "OM keeps its own budget and is not entered after the early allowance is spent");
});

test("DRV1 reads accepted features without a second accept or payment and hands their exact heads to coldStart", async t => {
  const f = fixture(t), project = "garden";
  // LG13-pre2: the cold OM hand-off stands on current upstream stages only — no B1, N2 or om-frame before coldStart.
  prepareOmFixtureStages(f.engine, project, gardenGraph());
  const { trace, omPause } = f.configure(project);
  const stageHeads = UPSTREAM_STAGES.map(stage => reference(f.store.get(`stage:${project}:${stage}`)!));
  const restartedStore = new Store(f.database); t.after(() => restartedStore.close());
  const driving = new ProductEngine(restartedStore).execute({ type: "early-stage-run", project, maxTurns: 10,
    maxCalls: 10 }) as Promise<EarlyStageOutcome>;
  const earlyEnd = await Promise.race([pauseCount(omPause, 1).then(() => null), driving]);
  if (earlyEnd) assert.fail(`Driver ended before OM handoff: ${JSON.stringify(earlyEnd)}`);
  const stopped = stopFrom(f.database, project);
  const result = await driving;
  assert.equal(result.end, "om_stopped", JSON.stringify(result));
  assert.deepEqual([result.budget.turnsUsed, result.budget.callsMade], [0, 0]);
  assert.equal(canonical(UPSTREAM_STAGES.map(stage => reference(f.store.get(`stage:${project}:${stage}`)!))), canonical(stageHeads),
    "accepted stages are read rather than accepted a second time");
  assert.equal(f.calls(trace).length, 0, "accepted early work is not paid again");
  assert.ok(f.store.get(`om-input:${project}`), "the existing coldStart wrote B1 from the accepted heads");
  const resumed = resumeStoppedPass(f.store, { project, stop: stopped });
  assert.equal(resumed.ok, true, "the common stop remains recoverable through the existing named door");
});

test("DRV1 saved draft selection is explicit: two compatible drafts pause, a foreign draft is refused, and no third draft is prepared", async t => {
  const f = fixture(t); f.setup("p"); f.setup("q");
  const first = f.engine.prepare("p", "discovery"), second = f.engine.prepare("p", "discovery");
  const foreign = f.engine.prepare("q", "discovery");
  const before = f.store.list<DiscoveryDraft>("discovery-draft").length;
  const ambiguous = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 10, maxCalls: 10 }) as EarlyStageOutcome;
  assert.equal(ambiguous.end, "select_draft");
  assert.deepEqual(new Set(ambiguous.candidates.map(row => row.id)), new Set([first.id, second.id]));
  assert.equal(ambiguous.budget.callsMade, 0);
  assert.equal(f.store.list("discovery-draft").length, before);
  const refused = await f.engine.execute({ type: "early-stage-run", project: "p", draftId: foreign.id,
    maxTurns: 10, maxCalls: 10 }) as EarlyStageOutcome;
  assert.deepEqual([refused.end, refused.reason?.code, refused.budget.callsMade], ["blocked", "early_draft_foreign", 0]);
  assert.equal(f.store.list("discovery-draft").length, before);
});

test("DRV1 selects the sole compatible saved draft and ignores a lawful stale sibling", async t => {
  const f = fixture(t); f.setup("p");
  acceptDiscovery(f.engine, "p", 0);
  const stale = f.engine.prepare("p", "concept");
  const discovery = f.store.get("stage:p:discovery")!;
  acceptDiscovery(f.engine, "p", discovery.revision);
  const blocked = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([blocked.end, blocked.stage, blocked.reason?.code, blocked.budget.callsMade],
    ["blocked", "concept", "early_draft_stale", 0]);
  const current = f.engine.prepare("p", "concept");

  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.stage, result.draft?.id, result.reason?.code, result.budget.callsMade],
    ["stage_paused", "concept", current.id, "research_call_allowance", 1]);
  assert.notEqual(current.value.inputs[0]?.hash, stale.value.inputs[0]?.hash,
    "the candidates are lawful drafts over different accepted predecessor revisions");
  assert.equal(f.store.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "concept").length, 2,
    "selection neither prepares a third draft nor deletes history");
});

test("DRV1 stop immediately after its guarded prepare resumes the same saved draft", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!stop && inputs.some(input => input.kind === "discovery-draft")) stop = stopFrom(f.database, "p");
    return saved;
  };
  let first: EarlyStageOutcome;
  try {
    first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
      maxCalls: 10, instruction: instruction("p") }) as EarlyStageOutcome;
  } finally { f.store.writeMany = original; }
  const prepared = f.store.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "discovery");
  assert.deepEqual([first.end, first.reason?.code, first.budget.callsMade, prepared.length, f.calls(trace).length],
    ["stopped", "run_stopped", 0, 1, 0]);
  assert.ok(stop); const resumed = resumeStoppedPass(f.store, { project: "p", stop }); assert.equal(resumed.ok, true);

  const reopened = new Store(f.database); t.after(() => reopened.close());
  const second = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([second.end, second.draft?.id, second.reason?.code, second.budget.callsMade],
    ["stage_paused", prepared[0]!.id, "research_call_allowance", 1]);
  assert.equal(reopened.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "discovery").length, 1);
});

test("DRV1 one live early executor makes a concurrent start busy; stop inside A permits no second sender", async t => {
  const f = fixture(t), { trace, earlyHold, earlyPause } = f.setup("p");
  writeFileSync(earlyHold, "research");
  const driving = f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 100, instruction: instruction("p") }) as Promise<EarlyStageOutcome>;
  await pauseCount(earlyPause, 1);
  const competingStore = new Store(f.database); t.after(() => competingStore.close());
  const competing = await new ProductEngine(competingStore).execute({ type: "early-stage-run", project: "p",
    maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([competing.end, competing.reason?.code, competing.budget.callsMade], ["busy", "run_busy", 0]);
  const stop = stopPass(competingStore, { project: "p" }); assert.equal(stop.ok, true);
  const result = await driving;
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade], ["stopped", "run_stopped", 1]);
  assert.equal(f.calls(trace).length, 1, "the busy contender and the stopped driver issue no second physical call");
  assert.equal(f.engine.pipeline.inspect("p", "discovery").state, "missing");
});

for (const role of ["assess-answer", "assess-escalation"] as const)
test(`DRV1 stop inside ${role} blocks every later physical role`, async t => {
  const f = fixture(t), { values, trace, earlyHold, earlyPause } = f.setup("p");
  if (role === "assess-escalation") {
    const fields = JSON.parse(readFileSync(values, "utf8")); fields.needOwner = true;
    writeFileSync(values, JSON.stringify(fields));
  }
  writeFileSync(earlyHold, role);
  const driving = f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 100, instruction: instruction("p") }) as Promise<EarlyStageOutcome>;
  await pauseCount(earlyPause, 1);
  stopFrom(f.database, "p");
  const result = await driving;
  const expectedRoles = role === "assess-escalation" ? ["research", "research", role] : ["research", role];
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade], ["stopped", "run_stopped", expectedRoles.length]);
  assert.deepEqual(f.calls(trace).map(row => row.role), expectedRoles);
  assert.equal(f.engine.pipeline.inspect("p", "discovery").state, "missing");
});

test("DRV1 stop written after one accepted stage blocks the next stage before prepare or dispatch", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!stop && inputs.some(input => input.id === "stage:p:discovery"
      && (input.value as { status?: string }).status === "accepted")) stop = stopFrom(f.database, "p");
    return saved;
  };
  let result: EarlyStageOutcome;
  try {
    result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
      maxCalls: 100, instruction: instruction("p") }) as EarlyStageOutcome;
  } finally { f.store.writeMany = original; }
  assert.deepEqual([result.end, result.reason?.code], ["stopped", "run_stopped"]);
  assert.equal(f.engine.pipeline.inspect("p", "discovery").state, "accepted");
  assert.equal(f.engine.pipeline.inspect("p", "concept").state, "missing");
  assert.equal(f.store.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "concept").length, 0);
  const fields = f.calls(trace).map(row => row.field);
  assert.ok(fields.length > 0);
  assert.equal(fields.includes("conceptSections"), false, "the next stage made no physical call");
  assert.ok(stop); const resumed = resumeStoppedPass(f.store, { project: "p", stop }); assert.equal(resumed.ok, true);
  const restartedStore = new Store(f.database); t.after(() => restartedStore.close());
  const continued = await new ProductEngine(restartedStore).execute({ type: "early-stage-run", project: "p",
    maxTurns: 100, maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([continued.end, continued.stage, continued.budget.callsMade], ["stage_paused", "concept", 1]);
  assert.equal(restartedStore.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "concept").length, 1);
});

test("DRV1 maxCalls counts a durable physical send once and reports its machine pause; a replay does not spend it", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const draft = f.engine.prepare("p", "discovery");
  const first = await f.engine.execute({ type: "early-stage-run", project: "p", draftId: draft.id,
    maxTurns: 100, maxCalls: 1 }) as EarlyStageOutcome;
  assert.equal(first.end, "stage_paused");
  assert.equal(first.reason?.code, "research_call_allowance");
  assert.deepEqual([first.budget.callsMade, first.budget.callsRemaining], [1, 0]);
  assert.equal(f.calls(trace).length, 1);
  const restartedStore = new Store(f.database); t.after(() => restartedStore.close());
  const second = await new ProductEngine(restartedStore).execute({ type: "early-stage-run", project: "p", draftId: draft.id,
    maxTurns: 100, maxCalls: 1 }) as EarlyStageOutcome;
  assert.equal(second.budget.callsMade, 1, "the saved first reply is applied without charging the new invocation");
  assert.equal(f.calls(trace).length, 2);
  assert.deepEqual(f.calls(trace).map(row => row.role), ["research", "assess-answer"],
    "the physical allowance counts the assessor continuation separately");
});

test("DRV1 maxTurns is one shared early-stage allowance rather than a fresh allowance per stage", async t => {
  const f = fixture(t); f.setup("p");
  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 10,
    maxCalls: 100, instruction: instruction("p") }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.reason?.code, result.budget.turnsUsed, result.budget.turnsRemaining],
    ["stage_paused", "research_turns_exhausted", 10, 0]);
  assert.equal(f.engine.pipeline.inspect("p", "discovery").state, "accepted",
    "the same allowance crossed the first stage before it was exhausted");
  assert.ok(result.stage !== "discovery", "the allowance was not reset after discovery");
});

test("DRV1 model pause has a machine reason and does not loop inside the same external entry", async t => {
  const f = fixture(t), { values, trace } = f.setup("p");
  const fields = JSON.parse(readFileSync(values, "utf8")); fields.modelPause = true;
  writeFileSync(values, JSON.stringify(fields));
  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 100, instruction: instruction("p") }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade, f.calls(trace).length],
    ["stage_paused", "research_model_paused", 1, 1], JSON.stringify(result));
});

test("DRV1 common stop blocks both the driver before prepare and direct research-stage before a physical call", async t => {
  const f = fixture(t); f.setup("p");
  const stopped = stopPass(f.store, { project: "p" }); assert.equal(stopped.ok, true);
  const before = f.store.list("discovery-draft").length;
  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 10, maxCalls: 10,
    instruction: instruction("p") }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade], ["stopped", "run_stopped", 0]);
  assert.equal(f.store.list("discovery-draft").length, before);

  f.setup("q"); const draft = f.engine.prepare("q", "discovery");
  const stop = stopPass(f.store, { project: "q" }); assert.equal(stop.ok, true);
  const direct = await f.engine.stageResearch.run("q", draft.id, 10);
  assert.deepEqual([direct.status, direct.reason?.code, direct.turnsUsed], ["stopped", "run_stopped", 0]);
  assert.equal(f.store.list<any>("model-call").filter(row => row.value.projectId === "q").length, 0);
});

test("DRV1 stop after the model claim but before dispatch sends nothing and exact resume admits one call", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!stop && inputs.some(input => input.kind === "model-call" && input.expected === 0))
      stop = stopFrom(f.database, "p");
    return saved;
  };
  let first: EarlyStageOutcome;
  try {
    first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
      maxCalls: 60, instruction: instruction("p") }) as EarlyStageOutcome;
  } finally { f.store.writeMany = original; }
  const refused = f.store.list<any>("model-call");
  assert.deepEqual([first.end, first.reason?.code, first.budget.callsMade, f.calls(trace).length],
    ["stopped", "run_stopped", 0, 0]);
  assert.deepEqual(refused.map(call => [call.value.status, call.value.error, call.value.execution?.phase]),
    [["failed", "run_stopped", "claimed"]]);
  assert.ok(stop); const resumed = resumeStoppedPass(f.store, { project: "p", stop }); assert.equal(resumed.ok, true);
  const reopened = new Store(f.database); t.after(() => reopened.close());
  const continued = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p",
    maxTurns: 30, maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([continued.end, continued.reason?.code, continued.budget.callsMade, f.calls(trace).length],
    ["stage_paused", "research_call_allowance", 1, 1]);
});

test("DRV1 stop at stdin authorization keeps its typed no-response outcome and exact resume", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!stop && inputs.some(input => input.kind === "model-call" && input.expected > 0
      && (input.value as any).execution?.phase === "authorized")) stop = stopFrom(f.database, "p");
    return original<T>(inputs, guards);
  };
  let first: EarlyStageOutcome;
  try {
    first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
      maxCalls: 60, instruction: instruction("p") }) as EarlyStageOutcome;
  } finally { f.store.writeMany = original; }
  const call = f.store.list<any>("model-call")[0]!;
  assert.deepEqual([first.end, first.reason?.code, first.budget.callsMade, f.calls(trace).length,
    call.value.status, call.value.error, call.value.execution?.phase, call.value.response],
  ["stopped", "run_stopped", 0, 0, "failed", "run_stopped", "claimed", null]);
  assert.ok(stop); const resumed = resumeStoppedPass(f.store, { project: "p", stop }); assert.equal(resumed.ok, true);
  const reopened = new Store(f.database); t.after(() => reopened.close());
  const continued = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p",
    maxTurns: 30, maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([continued.end, continued.reason?.code, continued.budget.callsMade, f.calls(trace).length],
    ["stage_paused", "research_call_allowance", 1, 1]);
});

test("DRV1 stop before B dispatch renews the same candidate only after exact resume", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!stop && inputs.some(input => input.kind === "model-call" && input.expected === 0
      && (input.value as any).assessmentApplication)) stop = stopFrom(f.database, "p");
    return saved;
  };
  let first: EarlyStageOutcome;
  try {
    first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
      maxCalls: 60, instruction: instruction("p") }) as EarlyStageOutcome;
  } finally { f.store.writeMany = original; }
  const stoppedCall = f.store.list<any>("model-call").find(call => call.value.purpose === "assessor")!;
  const before = f.store.list<any>("assessment-application").find(app => app.value.state === "retryable")!;
  assert.deepEqual([first.end, first.reason?.code, f.calls(trace).filter(call => call.role === "assess-answer").length,
    stoppedCall.value.status, stoppedCall.value.error, stoppedCall.value.execution?.phase,
    stoppedCall.value.response, before.value.received?.id],
  ["stopped", "run_stopped", 0, "failed", "run_stopped", "claimed", null, stoppedCall.id]);
  assert.ok(stop); assert.equal(resumeStoppedPass(f.store, { project: "p", stop }).ok, true);
  const reopened = new Store(f.database); t.after(() => reopened.close());
  const continued = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p",
    maxTurns: 30, maxCalls: 1 }) as EarlyStageOutcome;
  const applications = reopened.list<any>("assessment-application"), renewed = applications.find(app => app.id === before.id)!;
  const applied = applications.find(app => app.value.state === "applied")!;
  const {resultCapacity: beforeCapacity,...beforeContext}=before.value.context;
  const {resultCapacity: appliedCapacity,...appliedContext}=applied.value.context;
  assert.deepEqual([continued.budget.callsMade, f.calls(trace).filter(call => call.role === "assess-answer").length,
    renewed.value.state, applied.value.previous?.id, canonical(appliedContext), canonical(beforeContext)],
  [1, 1, "renewed", before.id, canonical(beforeContext), canonical(beforeContext)]);
  assert.equal(appliedCapacity.bindings.application,applied.id);
  assert.equal(appliedCapacity.operation,applied.id);
  assert.equal(appliedCapacity.generation,beforeCapacity.generation+1);
  assert.deepEqual({...appliedCapacity,generation:beforeCapacity.generation,operation:before.id,
    bindings:{...appliedCapacity.bindings,application:before.id}},beforeCapacity,
  'The new capacity marker changes only its exact application and generation');
});

test("DRV1 stop before C dispatch retries the same escalation only after exact resume", async t => {
  const f = fixture(t), { values, trace } = f.setup("p");
  const fields = JSON.parse(readFileSync(values, "utf8")); fields.needOwner = true;
  writeFileSync(values, JSON.stringify(fields));
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!stop && inputs.some(input => {
      if (input.kind !== "model-call" || input.expected !== 0) return false;
      const intentRef = (input.value as any).consumerIntent;
      return intentRef && f.store.get<any>(intentRef.id, intentRef.revision)?.value.kind === "escalation-assessor";
    })) stop = stopFrom(f.database, "p");
    return saved;
  };
  let first: EarlyStageOutcome;
  try {
    first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
      maxCalls: 60, instruction: instruction("p") }) as EarlyStageOutcome;
  } finally { f.store.writeMany = original; }
  const before = f.store.list<any>("research-consumer-intent")
    .find(intent => intent.value.kind === "escalation-assessor" && intent.value.state === "refused")!;
  const stoppedCall = f.store.list<any>("model-call").find(call => call.value.consumerIntent?.id === before.id)!;
  assert.deepEqual([first.end, first.reason?.code, f.calls(trace).filter(call => call.role === "assess-escalation").length,
    stoppedCall.value.status, stoppedCall.value.error, stoppedCall.value.execution?.phase, stoppedCall.value.response],
  ["stopped", "run_stopped", 0, "failed", "run_stopped", "claimed", null]);
  assert.ok(stop); assert.equal(resumeStoppedPass(f.store, { project: "p", stop }).ok, true);
  const reopened = new Store(f.database); t.after(() => reopened.close());
  const continued = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p",
    maxTurns: 30, maxCalls: 1 }) as EarlyStageOutcome;
  const after = reopened.list<any>("research-consumer-intent")
    .find(intent => intent.value.kind === "escalation-assessor" && intent.value.state === "applied")!;
  assert.deepEqual([continued.end, continued.budget.callsMade,
    f.calls(trace).filter(call => call.role === "assess-escalation").length,
    after.value.generation, before.value.generation + 1,
    canonical(after.value.cursor.pendingTurn), canonical(before.value.cursor.pendingTurn)],
  ["needs_owner", 1, 1, before.value.generation + 1, before.value.generation + 1,
    canonical(before.value.cursor.pendingTurn), canonical(before.value.cursor.pendingTurn)]);
});

test("DRV1 stopped restoration stays restore-only when another Store resumes at its stage boundary", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!stop && inputs.some(input => input.kind === "model-response"
      && String((input.value as { text?: string }).text).includes('"action":"answer"'))) {
      stop = stopFrom(f.database, "p");
      throw new EngineError("probe_paid_stop", "Stop after saved paid A before application");
    }
    return saved;
  };
  try { await f.engine.earlyStages.run({ project: "p", maxTurns: 30, maxCalls: 60,
    instruction: instruction("p") }); }
  finally { f.store.writeMany = original; }
  assert.ok(stop); const paidCalls = f.calls(trace).length;
  const draft = f.store.list<DiscoveryDraft>("discovery-draft")[0]!;
  const reopened = new Store(f.database); t.after(() => reopened.close());
  const engine = new ProductEngine(reopened), stageRun = engine.stageResearch.run.bind(engine.stageResearch);
  let resumed = false;
  engine.stageResearch.run = async (...args: Parameters<typeof stageRun>) => {
    if (!resumed) {
      resumed = true;
      const other = new Store(f.database);
      try { assert.equal(resumeStoppedPass(other, { project: "p", stop: stop! }).ok, true); }
      finally { other.close(); }
    }
    return stageRun(...args);
  };
  const result = await engine.execute({ type: "early-stage-run", project: "p", draftId: draft.id,
    maxTurns: 30, maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.reason?.code, result.stageResult?.status,
    result.budget.callsMade, result.budget.callsRemaining, f.calls(trace).length, resumed],
  ["stopped", "run_stopped", "stopped", 0, 1, paidCalls, true]);
  assert.equal(reopened.get<any>("om-run-control:p")!.value.stop, null);
  assert.ok(reopened.list<any>("research-consumer-intent").some(intent => intent.value.state === "applied"));
});

for (const paid of [
  { name: "analyst A", marker: '"action":"answer"', needOwner: false },
  { name: "answer assessor B", marker: '"verdict":"supported"', needOwner: false },
  { name: "escalation assessor C", marker: '"necessary":true', needOwner: true },
] as const) test(`DRV1 public stopped entry restores a paid ${paid.name} without another call`, async t => {
  const f = fixture(t), { values, trace } = f.setup("p");
  if (paid.needOwner) {
    const fields = JSON.parse(readFileSync(values, "utf8")); fields.needOwner = true;
    writeFileSync(values, JSON.stringify(fields));
  }
  const original = f.store.writeMany.bind(f.store); let stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!stop && inputs.some(input => input.kind === "model-response"
      && String((input.value as { text?: string }).text).includes(paid.marker))) {
      stop = stopFrom(f.database, "p");
      throw new EngineError("probe_paid_stop", "Stop after a saved paid response and before its application");
    }
    return saved;
  };
  let first: EarlyStageOutcome;
  try {
    first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
      maxCalls: 100, instruction: instruction("p") }) as EarlyStageOutcome;
  } finally { f.store.writeMany = original; }
  assert.deepEqual([first.end, first.reason?.code], ["stopped", "run_stopped"]);
  const draft = f.store.list<DiscoveryDraft>("discovery-draft")[0]!;
  const pending = ["research-consumer-intent", "assessment-application"].flatMap(kind =>
    f.store.list<any>(kind).filter(row => row.value.state === "running").map(row => row.id));
  assert.ok(stop && pending.length > 0, `paid ${paid.name} retained no restorable application`);
  const calls = f.calls(trace).length, reopened = new Store(f.database); t.after(() => reopened.close());
  const restored = await new ProductEngine(reopened).execute({ type: "early-stage-run", project: "p", draftId: draft.id,
    maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  const applied = pending.filter(id => reopened.get<any>(id)?.value.state === "applied");
  assert.deepEqual([restored.end, restored.reason?.code, restored.stage, restored.draft?.id,
    restored.stageResult?.status, restored.budget.callsMade, f.calls(trace).length],
  ["stopped", "run_stopped", "discovery", draft.id, "stopped", 0, calls]);
  assert.ok(applied.length > 0, `the paid ${paid.name} was not applied by the public driver: ${JSON.stringify({ pending,
    after: pending.map(id => ({ id, state: reopened.get<any>(id)?.value.state })), restored })}`);
  assert.equal(reopened.get<any>("om-run-control:p")!.value.stop!.token, stop);
});

test("DRV1 public stopped entry applies a saved web capture without HTTP or another model call", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const configured = f.store.get<Environment>("environment:p")!, { projectId: _projectId, ...settings } = configured.value;
  const environment = f.engine.environments.configure("p", { ...settings, webResearch: { enabled: true,
    gatewayUrl: "http://127.0.0.1:18890", timeoutMs: 4000,
    limits: { httpAttempts: 4, pages: 2, receivedChars: 10000, responseBytes: 10000 } } }, configured.revision);
  writeFileSync(join(f.root, "adapter.mjs"), `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'web_search',query:'harness vendor',purpose:'Find documentation'}}));`);
  const original = f.store.writeMany.bind(f.store); let pendingSaved = false;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(inputs, guards);
    if (!pendingSaved && inputs.some(input => input.kind === "research-turn"
      && (input.value as any).action?.action === "web_search" && (input.value as any).status === "pending")) {
      pendingSaved = true;
      throw new EngineError("probe_web_pending", "Pause after the managed web turn was saved");
    }
    return saved;
  };
  try { await f.engine.earlyStages.run({ project: "p", maxTurns: 4, maxCalls: 4,
    instruction: instruction("p") }); }
  finally { f.store.writeMany = original; }
  assert.ok(pendingSaved);
  const draft = f.store.list<DiscoveryDraft>("discovery-draft")[0]!;
  const turn = f.store.list<any>("research-turn").find(row => row.value.action?.action === "web_search")!;
  let transports = 0, stop: string | null = null;
  f.store.writeMany = function<T>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!stop && inputs.some(input => input.kind === "research-turn" && (input.value as any).status === "completed")) {
      stop = stopFrom(f.database, "p");
      throw new EngineError("probe_web_capture", "Stop after the capture and before turn application");
    }
    return original<T>(inputs, guards);
  };
  await assert.rejects(executeWebTurn({ store: f.store, projectId: "p", stage: "discovery", environment, turn,
    transport: async () => { transports++; return { status: 200, body: { query: "harness vendor", results: [],
      engines_queried: ["fixture"], unresponsive_engines: [] } }; } }), { code: "probe_web_capture" });
  f.store.writeMany = original;
  assert.deepEqual([transports, f.store.list("web-capture").length, f.store.get<any>(turn.id)!.value.status], [1, 1, "pending"]);
  const calls = f.calls(trace).length, reopened = new Store(f.database); t.after(() => reopened.close());
  const restored = await new ProductEngine(reopened).earlyStages.run({ project: "p", draftId: draft.id,
    maxTurns: 20, maxCalls: 20 });
  assert.deepEqual([restored.end, restored.reason?.code, restored.stageResult?.status, restored.budget.callsMade,
    f.calls(trace).length, transports, reopened.get<any>(turn.id)!.value.status],
  ["stopped", "run_stopped", "stopped", 0, calls, 1, "completed"]);
  assert.equal(reopened.get<any>("om-run-control:p")!.value.stop!.token, stop);
});

// DRY6-01 (contract №4961 (b)): during the assessor B of one concept question a second Store lawfully reopens its answered
// neighbour; the adapter does it itself, so the change falls inside the real assessment of the public pass. The reopen goes
// through Discovery.reopen — the exact function the 'reopen-question' command delegates to. In the r2 trace the refusal was
// kind 'call' — the provider call ended without a response (process_timeout/process_cancelled at assessment-session.ts:1148)
// before the reopen landed; a cold import(engine.js) measures ≈5.7 s here vs the unchanged 4 s provider timeout, consistent
// with the call exceeding its budget.
const NEIGHBOR_ADAPTER = ADAPTER.replace("let research;", `let research;
const order=process.argv[5]+'.neighbor';
if(c.role==='assess-answer'&&existsSync(order)){const o=JSON.parse(readFileSync(order,'utf8'));
 if(c.question?.field===o.at){(await import('node:fs')).rmSync(order);
  const {Store}=await import(${JSON.stringify(new URL("../src/storage/store.js", import.meta.url).href)});
  const {Discovery}=await import(${JSON.stringify(new URL("../src/discovery/discovery.js", import.meta.url).href)});
  const s=new Store(o.db);
  try{const d=s.list('discovery-draft').filter(r=>r.value.projectId===o.project&&r.value.stage===o.stage).at(-1);
   const q=d.value.questions.map(id=>s.get(id)).find(r=>r.value.spec.field===o.reopen);
   new Discovery(s).reopen(q.id,q.revision);}
  finally{s.close();}}}`);

test("DRY6-01 the neighbour's in-call reopen has no direct reference to the product engine; cold import cost is diagnostic only", t => {
  // Direct-route check: the adapter source holds no reference to the product engine — it performs the same lawful
  // reopen through Discovery.reopen, the function 'reopen-question' delegates to, with the store still closed in
  // finally. (Transitive imports of discovery.js itself are outside what this text check can prove.)
  assert.match(NEIGHBOR_ADAPTER, /discovery\/discovery\.js/);
  assert.match(NEIGHBOR_ADAPTER, /new Discovery\(s\)\.reopen\(q\.id,q\.revision\)/);
  assert.match(NEIGHBOR_ADAPTER, /finally\{s\.close\(\);\}/);
  assert.doesNotMatch(NEIGHBOR_ADAPTER, /product\/engine\.js|ProductEngine/);
  try {
    const dist = (name: string) => new URL(`../src/${name}`, import.meta.url).href;
    const coldCost = (specifiers: string[]) => Number(execFileSync(process.execPath, ["--input-type=module", "-e",
      `const t=performance.now();for(const s of ${JSON.stringify(specifiers)}) await import(s);console.log(Math.round(performance.now()-t));`],
      { encoding: "utf8" }).trim());
    t.diagnostic(`cold import — reopen path ${coldCost([dist("storage/store.js"), dist("discovery/discovery.js")])}ms, ` +
      `engine path ${coldCost([dist("storage/store.js"), dist("product/engine.js")])}ms (diagnostic only, never asserted)`);
  } catch (cause) { t.diagnostic(`cold-import measurement unavailable: ${cause}`); }
});

test("DRY6-01 a lawful neighbour reopen during B pauses the public pass with the exact machine door; a restart repeats it without a call; another project keeps its own door; the named command continues the same draft", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "adapter.mjs"), NEIGHBOR_ADAPTER);
  const pause = async (project: string) => {
    const { trace, earlyHold } = f.setup(project);
    writeFileSync(`${earlyHold}.neighbor`, JSON.stringify({ db: f.database, project, stage: "concept", at: "outcome", reopen: "audience" }));
    const result = await f.engine.execute({ type: "early-stage-run", project, maxTurns: 100, maxCalls: 100,
      instruction: instruction(project) }) as EarlyStageOutcome;
    const drafts = f.store.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.projectId === project && row.value.stage === "concept");
    assert.equal(drafts.length, 1);
    const byField = (field: string) => drafts[0]!.value.questions.map(id => f.store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
    return { result, trace, outcome: byField("outcome"), audience: byField("audience"), draft: drafts[0]! };
  };
  const p = await pause("p"), door = p.result.reason!.door!;
  assert.deepEqual([p.result.end, p.result.stage, p.result.reason?.code, p.result.reason?.target],
    ["stage_paused", "concept", "research_context_application_refused", p.outcome.id], "The address is the assessed question, not the neighbour");
  assert.deepEqual([door.question.id, door.current, door.changed?.kind, door.changed?.expected.id, door.command],
    [p.outcome.id, reference(p.outcome), "question", p.audience.id, { type: "reopen-question", question: p.outcome.id, expected: p.outcome.revision }]);
  assert.deepEqual(p.result.stageResult?.reason?.door, door, "StageResearch delivers the door the driver reports");
  const application = f.store.get<{ state: string }>(door.application.id)!;
  assert.equal(application.value.state, "refused");

  const calls = f.calls(p.trace).length;
  const restarted = new Store(f.database); t.after(() => restarted.close());
  const again = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([again.end, again.reason, again.budget.callsMade, f.calls(p.trace).length], [p.result.end, p.result.reason, 0, calls],
    "An unchanged repeat pays nothing and names the same door");

  const q = await pause("q"), other = q.result.reason!.door!;
  assert.deepEqual([other.question.id, other.command.question], [q.outcome.id, q.outcome.id]);
  assert.notEqual(other.application.id, door.application.id);
  const repeat = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual(repeat.reason?.door, door, "Each project keeps its own door");

  new ProductEngine(restarted).execute(door.command);
  const next = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 6 }) as EarlyStageOutcome;
  assert.ok(f.calls(p.trace).length > calls, "The reopened questions are researched again");
  assert.notEqual(next.reason?.code, "research_context_application_refused", JSON.stringify(next.reason));
  assert.equal(restarted.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.projectId === "p" && row.value.stage === "concept").length, 1,
    "The same draft continues");
  assert.equal(restarted.get<{ state: string }>(door.application.id)!.value.state, "refused", "The old supported verdict is never applied");
});

test("DRY6-01 return 1: a refusal of B's continuation after a completed lookup, before its next send, carries the exact public door; a restart repeats it without a call; the command continues the same draft", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  writeFileSync(join(f.root, "adapter.mjs"), ADAPTER.replace(
    "if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};",
    "if(c.role==='assess-answer')research=c.question?.field==='outcome'&&!c.contextWorkspace?.length?{action:'read_context',record:c.working.archive,pointer:'/body/stageNeighbors/fields/0/value'}:{verdict:'supported',reasons:[]};"));
  const original = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const saved = original<T>(writes, guards);
    const session = writes.find(write => write.kind === "assessment-session" && (write.value as any).workspace?.entries?.length);
    if (!injected && session) {
      const binding = (session.value as any).binding;
      const question = f.store.get<Question>(binding.question.id)!, draft = f.store.get<DiscoveryDraft>(binding.draft.id)!;
      if (question.value.spec.field === "outcome" && draft.value.stage === "concept") {
        injected = true; const other = new Store(f.database);
        try {
          const audience = draft.value.questions.map(id => other.get<Question>(id)!).find(q => q.value.spec.field === "audience")!;
          new ProductEngine(other).execute({ type: "reopen-question", question: audience.id, expected: audience.revision });
        } finally { other.close(); }
      }
    }
    return saved;
  };
  let result: EarlyStageOutcome;
  try { result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100, instruction: instruction("p") }) as EarlyStageOutcome; }
  finally { f.store.writeMany = original; }
  assert.ok(injected, "The neighbour moved between the lookup and the next B send");
  const refused = f.store.list<any>("assessment-application").filter(row => row.value.state === "refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.value.received, null, "The continuation was refused before any send");
  const { assessmentRefusalDoor } = await import("../src/discovery/assessment-session.js");
  const direct = assessmentRefusalDoor(f.store, refused[0]!);
  const outcome = f.store.get<Question>(direct.question.id)!;
  assert.equal(outcome.value.spec.field, "outcome");
  assert.deepEqual([result.reason?.code, result.reason?.target, result.reason?.door], ["research_context_application_refused", outcome.id, direct]);
  const count = f.calls(trace).length, restarted = new Store(f.database); t.after(() => restarted.close());
  const repeat = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([repeat.reason?.door, f.calls(trace).length], [direct, count], "The same door, no call");
  new ProductEngine(restarted).execute(direct.command);
  const next = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 6 }) as EarlyStageOutcome;
  assert.ok(f.calls(trace).length > count);
  assert.notEqual(next.reason?.code, "research_context_application_refused", JSON.stringify(next.reason));
  assert.equal(restarted.list<DiscoveryDraft>("discovery-draft").filter(row => row.value.stage === "concept").length, 1, "The same draft continues");
});

// DRY6-02 (contract №4961 (b)): the common stop stays immediate; its explicit resume admits one new generation of the
// dispatched attempt it cancelled, proved by the stop link saved with the call's terminal.
test("DRY6-02 A: a stop after the analyst received its stdin cancels it; repeats under the stop send nothing; two resumes converge and admit exactly one new generation on the same draft", async t => {
  const f = fixture(t), { trace, earlyHold, earlyPause } = f.setup("p");
  writeFileSync(earlyHold, "research");
  const driving = f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100,
    instruction: instruction("p") }) as Promise<EarlyStageOutcome>;
  await pauseCount(earlyPause, 1);
  const stop = stopFrom(f.database, "p");
  const stopped = await driving;
  assert.deepEqual([stopped.end, stopped.reason?.code], ["stopped", "run_stopped"]);
  rmSync(earlyHold);
  const [cancelled, ...others] = f.store.list<any>("model-call").filter(row => row.value.error === "process_cancelled");
  assert.ok(cancelled); assert.equal(others.length, 0);
  const link = f.store.get<any>(`call-stop-cancel:${cancelled.id}`)!;
  assert.deepEqual([link.value.stop, link.value.call], [stop, reference(cancelled)], "The cancellation is linked to exactly this stop");
  const intent = f.store.get<any>(cancelled.value.consumerIntent.id)!;
  const calls = f.calls(trace).length;
  assert.throws(() => f.engine.execute({ type: "permit-cancelled-call-retry", project: "p", call: reference(cancelled) }),
    { code: "call_retry_permit_unneeded" }, "A proved stop is lifted by its resume, not by the door");

  const restarted = new Store(f.database); t.after(() => restarted.close());
  const under = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([under.end, under.budget.callsMade, f.calls(trace).length], ["stopped", 0, calls], "Nothing is sent while the stop stands");

  for (const db of [new Store(f.database), new Store(f.database)]) {
    try { assert.equal(resumeStoppedPass(db, { project: "p", stop }).ok, true); } finally { db.close(); }
  }
  const next = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 1 }) as EarlyStageOutcome;
  assert.equal(next.budget.callsMade, 1, JSON.stringify(next.reason));
  const generations = restarted.list<any>("research-consumer-intent")
    .filter(row => row.value.kind === intent.value.kind && row.value.key === intent.value.key);
  assert.deepEqual(generations.map(row => row.value.generation).sort(), [intent.value.generation, intent.value.generation + 1],
    "One new generation of the same work");
  const fresh = generations.find(row => row.value.generation === intent.value.generation + 1)!;
  assert.deepEqual([fresh.value.draft, fresh.value.question.id], [intent.value.draft, intent.value.question.id], "The same draft and question");
  assert.equal(restarted.get<any>(cancelled.id)!.value.error, "process_cancelled", "The earlier attempt keeps its record and possible cost");

  const callsBefore = new Set(restarted.list<any>("model-call").map(row => row.id));
  const again = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 2 }) as EarlyStageOutcome;
  assert.equal(restarted.list<any>("research-consumer-intent").filter(row => row.value.kind === intent.value.kind
    && row.value.key === intent.value.key).length, 2, "The permission is not spent twice");
  assert.notEqual(again.reason?.code, "process_cancelled", JSON.stringify(again.reason));
  // A third generation would be minted inside the run, before any send (prepareResearchConsumerIntent); the
  // check above only stays meaningful if the run still pays at least one physical call of the same work —
  // a new model-call whose saved grounds name this draft and the question of the admitted generation: the
  // analyst's own consumer intent (same run and question) or the child assessor's application session.
  const sameWork = (call: any): boolean => {
    if (callsBefore.has(call.id) || call.value.projectId !== "p" || call.value.draftId !== fresh.value.draft.id) return false;
    // A reserved model-call alone is not a paid result: the call succeeded and its exact saved response is readable.
    const response = call.value.status === "succeeded" && isRef(call.value.response?.record) ? call.value.response.record : null;
    const saved = response ? restarted.get<any>(response.id, response.revision) : null;
    if (!response || !saved || saved.hash !== response.hash) return false;
    if (isRef(call.value.consumerIntent)) {
      const producer = restarted.get<any>(call.value.consumerIntent.id);
      return producer?.kind === "research-consumer-intent" && producer.value.question?.id === fresh.value.question.id
        && producer.value.cursor?.run === fresh.value.cursor.run;
    }
    if (isRef(call.value.assessmentApplication)) {
      const application = restarted.get<any>(call.value.assessmentApplication.id);
      const session = application?.kind === "assessment-application" && isRef(application.value.session)
        ? restarted.get<any>(application.value.session.id) : null;
      return session?.kind === "assessment-session" && session.value.binding?.question?.id === fresh.value.question.id;
    }
    return false;
  };
  assert.ok(restarted.list<any>("model-call").some(sameWork), "again sent at least one new physical call of the same work");
});

for (const role of ["assess-answer", "assess-escalation"] as const)
test(`DRY6-02 ${role === "assess-answer" ? "B" : "C"}: a stop after ${role} received its stdin cancels it; the explicit resume admits exactly one new attempt of that role on the same draft`, async t => {
  const f = fixture(t), { values, trace, earlyHold, earlyPause } = f.setup("p");
  if (role === "assess-escalation") {
    const fields = JSON.parse(readFileSync(values, "utf8")); fields.needOwner = true; writeFileSync(values, JSON.stringify(fields));
  }
  writeFileSync(earlyHold, role);
  const driving = f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100,
    instruction: instruction("p") }) as Promise<EarlyStageOutcome>;
  await pauseCount(earlyPause, 1);
  const stop = stopFrom(f.database, "p");
  assert.equal((await driving).end, "stopped");
  rmSync(earlyHold);
  const [cancelled] = f.store.list<any>("model-call").filter(row => row.value.error === "process_cancelled");
  assert.ok(cancelled && f.store.get(`call-stop-cancel:${cancelled.id}`), "The cancellation is linked to the stop");
  if (role === "assess-answer")
    assert.equal(f.store.get<any>(cancelled.value.assessmentApplication.id)!.value.state, "retryable", "B keeps its exact candidate");
  const roleCalls = () => f.calls(trace).filter(row => row.role === role).length, before = roleCalls();
  const restarted = new Store(f.database); t.after(() => restarted.close());
  assert.equal((await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome).end,
    "stopped");
  assert.equal(roleCalls(), before, "Nothing is sent while the stop stands");
  assert.equal(resumeStoppedPass(restarted, { project: "p", stop }).ok, true);
  const next = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 1 }) as EarlyStageOutcome;
  assert.deepEqual([next.budget.callsMade, roleCalls()], [1, before + 1], `Exactly one new ${role} attempt: ${JSON.stringify(next.reason)}`);
  const latest = restarted.list<any>("model-call").sort((a, b) => b.value.startedAt - a.value.startedAt)[0]!;
  if (role === "assess-answer") {
    const application = restarted.get<any>(latest.value.assessmentApplication.id)!, original = restarted.get<any>(cancelled.value.assessmentApplication.id)!;
    assert.equal(application.value.session.id, original.value.session.id, "The same candidate's session");
  } else {
    const intent = restarted.get<any>(latest.value.consumerIntent.id)!, first = restarted.get<any>(cancelled.value.consumerIntent.id)!;
    assert.deepEqual([intent.value.key, intent.value.generation], [first.value.key, first.value.generation + 1], "The same escalation, one generation on");
  }
  assert.equal(restarted.list<any>("discovery-draft").length, 1, "The same draft");
});

test("DRY6-02 a new stop after the resume and before any stdin sends nothing; its own resume still admits one generation", async t => {
  const f = fixture(t), { trace, earlyHold, earlyPause } = f.setup("p");
  writeFileSync(earlyHold, "research");
  const driving = f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100,
    instruction: instruction("p") }) as Promise<EarlyStageOutcome>;
  await pauseCount(earlyPause, 1);
  const first = stopFrom(f.database, "p"); await driving; rmSync(earlyHold);
  const calls = f.calls(trace).length, restarted = new Store(f.database); t.after(() => restarted.close());
  assert.equal(resumeStoppedPass(restarted, { project: "p", stop: first }).ok, true);
  const second = stopFrom(f.database, "p");
  const blocked = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([blocked.end, blocked.budget.callsMade, f.calls(trace).length], ["stopped", 0, calls], "The new stop holds the admitted attempt");
  assert.equal(resumeStoppedPass(restarted, { project: "p", stop: second }).ok, true);
  const next = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 1 }) as EarlyStageOutcome;
  assert.equal(next.budget.callsMade, 1);
  const [cancelled] = restarted.list<any>("model-call").filter(row => row.value.error === "process_cancelled");
  const intent = restarted.get<any>(cancelled!.value.consumerIntent.id)!;
  assert.equal(restarted.list<any>("research-consumer-intent").filter(row => row.value.key === intent.value.key).length, 2, "One generation, not two");
});

test("DRY6-02 an external abort is not the stop: no link and no automatic retry; the explicit addressed door permits one attempt of exactly that call once", async t => {
  const f = fixture(t), { trace, earlyHold, earlyPause } = f.setup("p");
  const draft = f.engine.prepare("p", "discovery");
  writeFileSync(earlyHold, "research");
  const controller = new AbortController(), running = f.engine.researcher.run("p", draft.id, 20, controller.signal);
  await pauseCount(earlyPause, 1); controller.abort();
  const paused = await running; rmSync(earlyHold);
  assert.deepEqual([paused.value.status, paused.value.pauseCode], ["paused", "process_cancelled"]);
  const [cancelled] = f.store.list<any>("model-call").filter(row => row.value.error === "process_cancelled");
  assert.equal(f.store.get(`call-stop-cancel:${cancelled!.id}`), null, "An external abort gains no stop link");
  const calls = f.calls(trace).length, analyst = () => f.calls(trace).filter(row => row.role === "research").length, sent = analyst();
  const repeat = await f.engine.stageResearch.run("p", draft.id, 20);
  assert.deepEqual([repeat.status, repeat.reason?.code, f.calls(trace).length], ["paused", "process_cancelled", calls], "No automatic retry");

  const door = { type: "permit-cancelled-call-retry", project: "p", call: reference(cancelled!) };
  assert.throws(() => f.engine.execute({ ...door, call: reference(f.store.get(cancelled!.id, 1)!) }), { code: "call_retry_permit_stale" });
  const permit = f.engine.execute(door) as Revision<any>;
  assert.deepEqual(permit.value.call, reference(cancelled!));
  assert.deepEqual(f.engine.execute(door), permit, "A repeated door returns the same permit");
  const resumed = await f.engine.stageResearch.run("p", draft.id, 1);
  assert.equal(analyst(), sent + 1, `One new analyst attempt: ${JSON.stringify(resumed.reason)}`);
  const intent = f.store.get<any>(cancelled!.value.consumerIntent.id)!;
  assert.equal(f.store.list<any>("research-consumer-intent").filter(row => row.value.key === intent.value.key).length, 2, "One new generation");
  assert.throws(() => f.engine.execute(door), { code: "call_retry_permit_stale" }, "A spent permit is not granted again");
  assert.equal(f.store.get<any>(cancelled!.id)!.value.error, "process_cancelled", "The earlier attempt and its possible cost stay");
});

test("DRY6-02 a timeout is not a cancellation: no link, no retry, and the door refuses it", async t => {
  const f = fixture(t), { earlyHold } = f.setup("p");
  const draft = f.engine.prepare("p", "discovery");
  writeFileSync(earlyHold, "research");
  const paused = await f.engine.researcher.run("p", draft.id, 20); rmSync(earlyHold);
  assert.equal(paused.value.pauseCode, "process_timeout");
  const [timed] = f.store.list<any>("model-call").filter(row => row.value.error === "process_timeout");
  assert.equal(f.store.get(`call-stop-cancel:${timed!.id}`), null);
  assert.throws(() => f.engine.execute({ type: "permit-cancelled-call-retry", project: "p", call: reference(timed!) }), { code: "call_retry_permit_invalid" });
});

test("DRY6-02 two Stores continuing at once after the resume spend the one permission once", async t => {
  const f = fixture(t), { earlyHold, earlyPause } = f.setup("p");
  writeFileSync(earlyHold, "research");
  const driving = f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100,
    instruction: instruction("p") }) as Promise<EarlyStageOutcome>;
  await pauseCount(earlyPause, 1);
  const stop = stopFrom(f.database, "p"); await driving; rmSync(earlyHold);
  const [cancelled] = f.store.list<any>("model-call").filter(row => row.value.error === "process_cancelled");
  const key = f.store.get<any>(cancelled!.value.consumerIntent.id)!.value.key;
  const one = new Store(f.database), two = new Store(f.database); t.after(() => { one.close(); two.close(); });
  assert.equal(resumeStoppedPass(one, { project: "p", stop }).ok, true);
  const ends = await Promise.all([one, two].map(db => new ProductEngine(db).execute({ type: "early-stage-run", project: "p",
    maxTurns: 100, maxCalls: 1 }) as Promise<EarlyStageOutcome>));
  assert.ok(ends.some(end => end.budget.callsMade === 1), JSON.stringify(ends.map(end => [end.end, end.reason?.code])));
  assert.equal(f.store.list<any>("research-consumer-intent").filter(row => row.value.key === key).length, 2, "Exactly one new generation");
});

test("DRY6-02 an external abort of B is not the stop: its refusal stays and the door names the reopen door of the assessed question", async t => {
  const f = fixture(t), { earlyHold, earlyPause } = f.setup("p");
  const draft = f.engine.prepare("p", "discovery");
  writeFileSync(earlyHold, "assess-answer");
  const controller = new AbortController(), running = f.engine.researcher.run("p", draft.id, 20, controller.signal);
  await pauseCount(earlyPause, 1); controller.abort();
  await running; rmSync(earlyHold);
  const [cancelled] = f.store.list<any>("model-call").filter(row => row.value.error === "process_cancelled");
  assert.equal(f.store.get(`call-stop-cancel:${cancelled!.id}`), null);
  assert.equal(f.store.get<any>(cancelled!.value.assessmentApplication.id)!.value.state, "refused", "The earlier refusal is not reinterpreted");
  assert.throws(() => f.engine.execute({ type: "permit-cancelled-call-retry", project: "p", call: reference(cancelled!) }),
    (error: unknown) => error instanceof EngineError && error.code === "call_retry_permit_unsupported" && /reopen/.test(error.message));
});

test("DRY6-02 return 1: the cited Source changes after the stop cancelled B — the retryable attempt becomes the proved refusal with the exact door; a restart repeats it without a call; the command continues the same draft", async t => {
  const f = fixture(t), { trace, earlyHold, earlyPause } = f.setup("p");
  writeFileSync(earlyHold, "assess-answer");
  const driving = f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100,
    instruction: instruction("p") }) as Promise<EarlyStageOutcome>;
  await pauseCount(earlyPause, 1);
  const stop = stopFrom(f.database, "p");
  assert.equal((await driving).end, "stopped");
  rmSync(earlyHold);
  const [cancelled] = f.store.list<any>("model-call").filter(row => row.value.error === "process_cancelled");
  const application = f.store.get<any>(cancelled!.value.assessmentApplication.id)!;
  assert.equal(application.value.state, "retryable");
  const source = f.store.list<any>("source").find(row => row.value.origin.location === "values")!;
  f.engine.discovery.evidence.document("p", "values", source.value.content + " ", "application/json", source.revision);
  const restarted = new Store(f.database); t.after(() => restarted.close());
  assert.equal(resumeStoppedPass(restarted, { project: "p", stop }).ok, true);
  const calls = f.calls(trace).length;
  const paused = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  const door = paused.reason?.door;
  assert.ok(door, JSON.stringify(paused.reason));
  assert.deepEqual([paused.reason!.code, door!.changed?.kind, door!.changed?.expected.id, door!.application.id],
    ["research_context_application_refused", "source", source.id, application.id], "The moved Source is named; the stale citation is never sent");
  assert.equal(paused.reason!.target, door!.question.id, "The address is the assessed question");
  assert.equal(f.calls(trace).length, calls, "Nothing is sent on the old citation");
  const again = await new ProductEngine(new Store(f.database)).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([again.reason?.door, again.budget.callsMade], [door, 0], "A restart repeats the same door without a call");
  new ProductEngine(restarted).execute(door!.command);
  const next = await new ProductEngine(restarted).execute({ type: "early-stage-run", project: "p", maxTurns: 100, maxCalls: 2 }) as EarlyStageOutcome;
  assert.ok(f.calls(trace).length > calls, JSON.stringify(next.reason));
  assert.equal(restarted.list<any>("discovery-draft").length, 1, "The same draft continues");
});

test("ENV1 DRV1 hands accepted features to OM through the same admission as om-start: a workspace without Git refuses both alike before any B1, pass or call", async t => {
  const f = fixture(t), project = "garden";
  prepareOmFixtureStages(f.engine, project, gardenGraph());
  const { trace } = f.configure(project);
  // Upstream stages only: no research phase, no B1 and no OM frame of level 2 or 3, before and after both entries.
  const stagesOnly = (when: string) => {
    assert.deepEqual(f.store.list("phase"), [], `${when}: no research phase`);
    for (const id of [`om-input:${project}`, `om-frame:${project}:2`, `om-frame:${project}:3`])
      assert.equal(f.store.get(id), null, `${when}: ${id}`);
  };
  stagesOnly("prepared");
  rmSync(join(f.root, "repo", ".git"), { recursive: true, force: true });
  const driven = await f.engine.execute({ type: "early-stage-run", project, maxTurns: 10, maxCalls: 10 }) as EarlyStageOutcome;
  const direct = await f.engine.execute({ type: "om-start", project }) as { ok: boolean; refusal?: { code: string; at: { target: string; field?: string } } };
  assert.equal(driven.reason?.code, "environment_not_ready", JSON.stringify([driven.end, driven.reason]));
  assert.equal(direct.ok, false);
  assert.deepEqual([direct.refusal!.code, direct.refusal!.at.target, direct.refusal!.at.field], [driven.reason!.code, driven.reason!.target, driven.reason!.field],
    "One admission for both entries");
  assert.equal(f.store.get(`om-input:${project}`), null, "No B1");
  assert.equal(f.calls(trace).length, 0, "No call");
  stagesOnly("after both entries");
});

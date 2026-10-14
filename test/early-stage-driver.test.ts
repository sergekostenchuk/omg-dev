import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest } from "../src/canonical.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { REQUIREMENTS, UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { executeWebTurn } from "../src/discovery/web-research.js";
import { EngineError } from "../src/errors.js";
import { designOf } from "../src/graph/builder.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { gardenGraph } from "./om-fixture.js";
import { resumeStoppedPass, stopPass } from "../src/om/run-driver.js";
import { reference, uniqueRefs } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { parseCommand } from "../src/product/commands.js";
import type { EarlyStageInstruction, EarlyStageOutcome } from "../src/product/early-stage-driver.js";
import { preparedField } from "./preparation-fixture.js";
import { answerDiscoveryFixture, preparedFeatures, refinedLayers } from "./product-fixture.js";
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

test("IN1 initializes verbatim Source, brief and fallback objective before the first researchPlan call", async t => {
  const f = fixture(t), { trace } = f.setup("p"), input = instruction("p", "Build a planting planner from this exact request.");
  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 1, instruction: input }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.stage, result.reason?.code, result.budget.callsMade],
    ["stage_paused", "discovery", "research_call_allowance", 1]);
  const source = f.store.get<any>("source:p:instruction")!, binding = f.store.get<any>("early-stage-input:p")!;
  const draft = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.stage === "discovery")!;
  const questions = draft.value.questions.map(id => f.store.get<Question>(id)!);
  const brief = questions.find(row => row.value.spec.field === "brief")!, objective = questions.find(row => row.value.spec.field === "objective")!;
  const briefAnswer = f.store.get<any>(brief.value.answer!.id)!, objectiveAnswer = f.store.get<any>(objective.value.answer!.id)!;
  assert.deepEqual([source.value.content, source.value.sha256, source.value.origin.kind,
    draft.value.fields.brief, draft.value.fields.objective, objectiveAnswer.value.actor],
  [input.text, digest(input.text), "owner-document", input.text, input.text, "driver:verbatim"]);
  assert.deepEqual(draft.value.inputs, uniqueRefs([reference(f.store.get("project:p")!), reference(source), reference(binding)]));
  assert.deepEqual(briefAnswer.value.observation.selector, input.brief);
  assert.deepEqual(f.calls(trace), [{ role: "research", field: "researchPlan" }],
    "the first physical call occurs only after verbatim input initialization");
});

test("IN1 explicit objective is selected from the same exact Source; arbitrary model prose is not an input field", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const text = "Build a planting planner.\nReduce missed watering.";
  const input: EarlyStageInstruction = { title: "p", id: "instruction", text, media: "text/plain",
    brief: { kind: "text-range", start: 0, end: 25 },
    objective: { kind: "text-range", start: 26, end: text.length } };
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 1, instruction: input });
  const draft = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.stage === "discovery")!;
  assert.deepEqual([draft.value.fields.brief, draft.value.fields.objective],
    ["Build a planting planner.", "Reduce missed watering."]);
  assert.equal(f.calls(trace)[0]?.field, "researchPlan");
  assert.throws(() => parseCommand({ type: "early-stage-run", project: "x", maxTurns: 1, maxCalls: 1,
    instruction: { ...instruction("x"), value: "A model paraphrase" } }), { code: "command_invalid" });
  assert.throws(() => parseCommand({ type: "revise-early-stage-input", project: "x", expected: 0 }),
    { code: "command_invalid" });
});

test("IN1 derives brief and explicit objective through exact JSON pointers", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const text = JSON.stringify({ assignment: "Build a planting planner.", goal: "Reduce missed watering." });
  const input: EarlyStageInstruction = { title: "p", id: "instruction", text, media: "application/json",
    brief: { kind: "json-pointer", pointer: "/assignment" },
    objective: { kind: "json-pointer", pointer: "/goal" } };
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30, maxCalls: 1, instruction: input });
  const draft = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.stage === "discovery")!;
  assert.deepEqual([f.store.get<any>("source:p:instruction")!.value.content,
    draft.value.fields.brief, draft.value.fields.objective, f.calls(trace)[0]?.field],
  [text, "Build a planting planner.", "Reduce missed watering.", "researchPlan"]);
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

test("IN1 leaves a previous-era decision and draft without present-day input authorship", async t => {
  const f = fixture(t); f.setup("p");
  const draft = f.engine.prepare("p", "discovery");
  const objective = draft.value.questions.map(id => f.store.get<Question>(id)!)
    .find(question => question.value.spec.field === "objective")!;
  f.engine.discovery.decision(objective.id, objective.revision, "legacy-owner", "Keep the historical objective");
  const before = f.store.get<Question>(objective.id)!.value.answer!;
  await f.engine.execute({ type: "early-stage-run", project: "p", draftId: draft.id, maxTurns: 1, maxCalls: 1 });
  const after = f.store.get<Question>(objective.id)!.value.answer!;
  assert.deepEqual(after, before);
  assert.equal(f.store.get<any>(after.id, after.revision)!.value.actor, "legacy-owner");
  assert.equal(f.store.get("early-stage-input:p"), null);
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

test("IN1 changed Source makes the accepted researchPlan addressed stale without another model call", async t => {
  const f = fixture(t), { trace } = f.setup("p"), input = instruction("p");
  await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 30,
    maxCalls: 2, instruction: input });
  const draft = f.store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.stage === "discovery")!;
  const plan = draft.value.questions.map(id => f.store.get<Question>(id)!)
    .find(question => question.value.spec.field === "researchPlan")!;
  assert.equal(f.store.get<Question>(plan.id)!.value.status, "answered");
  const calls = f.calls(trace).length;
  f.engine.execute({ type: "source-document", project: "p", id: "instruction",
    text: "A changed assignment requiring explicit review.", media: "text/plain", expected: 1 });
  const repeated = await new ProductEngine(f.store).execute({ type: "early-stage-run", project: "p",
    maxTurns: 30, maxCalls: 2 }) as EarlyStageOutcome;
  assert.deepEqual([repeated.end, repeated.reason?.code, repeated.budget.callsMade, f.calls(trace).length],
    ["blocked", "instruction_stale", 0, calls]);
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
  preparedFeatures(f.engine, project, gardenGraph());
  const { trace, omPause } = f.configure(project);
  refinedLayers(f.engine, project);
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

for (const state of ["no_go", "conditional", "insufficient_evidence"] as const)
test(`DRV1 returns supported ${state} as its subject outcome and repeat neither pays nor starts concept`, async t => {
  const f = fixture(t), { values, trace } = f.setup("p");
  const fields = JSON.parse(readFileSync(values, "utf8"));
  fields.verdict.outcome = state;
  fields.verdict.reason = "The investigated variant cannot currently meet the stated constraints";
  fields.verdict.conditions = state === "conditional" ? [{ id: "condition-1", kind: "owner_choice",
    condition: "Choose the required constraint", criterion: "A new supported verdict establishes the choice",
    options: [{ optionId: "accept", label: "Accept constraint", consequences: ["Reassess the variant"], choice: "accept" },
      { optionId: "decline", label: "Decline constraint", consequences: ["Reassess alternatives"], choice: "decline" }] }] : [];
  writeFileSync(values, JSON.stringify(fields));
  const expected = state === "conditional" ? "needs_owner" : state;
  const first = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 100, instruction: instruction("p") }) as EarlyStageOutcome;
  assert.deepEqual([first.end, first.stage, first.stageResult?.discovery?.state], [expected, "discovery", state]);
  const calls = f.calls(trace).length, drafts = f.store.list<DiscoveryDraft>("discovery-draft").length;
  const repeated = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([repeated.end, repeated.stage, repeated.stageResult?.discovery?.state], [expected, "discovery", state]);
  assert.deepEqual([f.calls(trace).length, f.store.list<DiscoveryDraft>("discovery-draft").length], [calls, drafts]);
  assert.equal(f.engine.pipeline.inspect("p", "concept").state, "missing");
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
  assert.deepEqual([continued.budget.callsMade, f.calls(trace).filter(call => call.role === "assess-answer").length,
    renewed.value.state, applied.value.previous?.id, canonical(applied.value.context), canonical(before.value.context)],
  [1, 1, "renewed", before.id, canonical(before.value.context), canonical(before.value.context)]);
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

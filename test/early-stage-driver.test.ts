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
import { gardenGraph } from "./om-fixture.js";
import { resumeStoppedPass, stopPass } from "../src/om/run-driver.js";
import { reference } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import type { EarlyStageOutcome } from "../src/product/early-stage-driver.js";
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

test("DRV1 one entry uses StageResearch for five stages, builds the real L1 and stops at the shared early-call boundary", async t => {
  const f = fixture(t), { trace } = f.setup("p");
  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 100,
    maxCalls: 40 }) as EarlyStageOutcome;
  assert.equal(result.end, "om_ready", JSON.stringify(result));
  assert.ok(UPSTREAM_STAGES.every(stage => f.engine.pipeline.inspect("p", stage).state === "accepted"));
  assert.ok(f.store.get("graph:p"), "operation-map used the existing build-map producer");
  assert.equal(result.budget.callsMade, f.store.list<any>("model-call").filter(row => row.value.draftId).length,
    "only new early physical dispatches consume maxCalls");
  assert.deepEqual([result.budget.callsMade, result.budget.callsRemaining], [40, 0]);
  assert.ok(result.budget.turnsUsed > 0 && result.budget.turnsUsed <= result.budget.maxTurns);
  assert.equal(f.calls(trace).length, 40);
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
      maxCalls: 10 }) as EarlyStageOutcome;
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
    maxCalls: 100 }) as EarlyStageOutcome;
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
    maxCalls: 100 }) as Promise<EarlyStageOutcome>;
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
    maxCalls: 100 }) as Promise<EarlyStageOutcome>;
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
      maxCalls: 100 }) as EarlyStageOutcome;
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
    maxCalls: 100 }) as EarlyStageOutcome;
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
    maxCalls: 100 }) as EarlyStageOutcome;
  assert.deepEqual([result.end, result.reason?.code, result.budget.callsMade, f.calls(trace).length],
    ["stage_paused", "research_model_paused", 1, 1], JSON.stringify(result));
});

test("DRV1 common stop blocks both the driver before prepare and direct research-stage before a physical call", async t => {
  const f = fixture(t); f.setup("p");
  const stopped = stopPass(f.store, { project: "p" }); assert.equal(stopped.ok, true);
  const before = f.store.list("discovery-draft").length;
  const result = await f.engine.execute({ type: "early-stage-run", project: "p", maxTurns: 10, maxCalls: 10 }) as EarlyStageOutcome;
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
      maxCalls: 60 }) as EarlyStageOutcome;
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
      maxCalls: 60 }) as EarlyStageOutcome;
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
      maxCalls: 60 }) as EarlyStageOutcome;
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
      maxCalls: 60 }) as EarlyStageOutcome;
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
  try { await f.engine.earlyStages.run({ project: "p", maxTurns: 30, maxCalls: 60 }); }
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
      maxCalls: 100 }) as EarlyStageOutcome;
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
  try { await f.engine.earlyStages.run({ project: "p", maxTurns: 4, maxCalls: 4 }); }
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    engine.execute({ type: "create-project", project, title: project });
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

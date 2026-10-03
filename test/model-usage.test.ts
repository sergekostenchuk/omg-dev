import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/storage/store.js";
import { researchCall } from "../src/discovery/research-protocol.js";
import { codexUsage } from "../src/adapters/codex-usage.js";
import { modelUsage, tokenUsage, type ModelCall } from "../src/runtime/model-usage.js";
import type { Environment } from "../src/runtime/environment.js";
import { runProcess } from "../src/runtime/process.js";

const PROVIDER = `import {readFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),scenario=process.argv[2];
if(scenario==='timeout'){await new Promise(resolve=>setTimeout(resolve,10000));}
const result={protocol:req.protocol,requestId:scenario==='foreign'?'another-request':req.requestId,research:{ok:true}};
if(scenario!=='unknown')result.usage={inputTokens:120,outputTokens:25,cachedInputTokens:80,reasoningOutputTokens:5};
if(scenario==='invalid')result.usage.cachedInputTokens=121;
console.log(JSON.stringify(result));if(scenario==='failure')process.exitCode=1;`;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-usage-")), store = new Store(join(root, "state.sqlite"));
  writeFileSync(join(root, "provider.mjs"), PROVIDER);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const environment = (scenario: string): Environment => {
    const command = { executable: process.execPath, args: [join(root, "provider.mjs"), scenario] };
    return { projectId: "p", workspace: root, implementer: { actor: "reader", model: "fixture-reader", effort: "high", speed: "fast", command },
      reviewer: { actor: "assessor", model: "fixture-assessor", effort: "high", command }, fullCheck: command, timeoutMs: scenario === "timeout" ? 150 : 3000 };
  };
  return { root, store, environment };
}

/** A fictitious personal Codex home: the isolated reader call takes its router settings from it and links its login file. */
function fictitiousCodexHome(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "omg-home-")), previous = process.env["HOME"];
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'model_catalog_json = "/fixture/models.json"\nopenai_base_url = "http://127.0.0.1:9/v1"\n');
  writeFileSync(join(home, ".codex", "auth.json"), '{"fixture":"not a credential"}');
  process.env["HOME"] = home;
  t.after(() => { if (previous === undefined) delete process.env["HOME"]; else process.env["HOME"] = previous; rmSync(home, { recursive: true, force: true }); });
}

test("usage counts every audited role and failed response without adding cached or reasoning tokens twice", async t => {
  const { store, environment } = fixture(t);
  for (const purpose of ["reader", "analyst", "assessor", "escalation-assessor"]) {
    const env = environment("normal");
    assert.deepEqual(await researchCall(env.implementer, env, "Read a fixture", { field: "runtime" }, undefined,
      { store, draftId: "draft-p", purpose }), { ok: true });
  }
  const env = environment("failure");
  await assert.rejects(researchCall(env.reviewer, env, "Assess", {}, undefined,
    { store, draftId: "draft-p", purpose: "assessor" }), { code: "research_provider_failed" });
  const report = modelUsage(store, "p", 0);
  assert.equal(report.cumulative.attempts, 5); assert.equal(report.cumulative.failed, 1);
  assert.deepEqual(report.cumulative.reportedTokens, { input: 600, output: 125, cachedInput: 400, reasoningOutput: 25 });
  assert.equal(report.roles.find(role => role.purpose === "reader")!.requestedSpeed, "fast");
  assert.deepEqual(report.roles.find(role => role.purpose === "reader")!.confirmedSpeeds, [null]);
  assert.equal(modelUsage(store, "other", 0).cumulative.attempts, 0);
  assert.equal(modelUsage(store, "p", Date.now() + 1).period.attempts, 0);
  assert.ok(store.list<ModelCall>("model-call").every(record => record.value.finishedAt !== null && record.value.request.bytes > 0));
});

test('every audited discovery call commits physical ownership and request authorization before its receipt', async t => {
  const { store, environment } = fixture(t), env = environment('normal');
  await researchCall(env.implementer, env, 'Physical execution contract', {}, undefined, { store, draftId: 'draft-p', purpose: 'reader' });
  const call = store.list<ModelCall>('model-call')[0]!, history = store.history<ModelCall>(call.id);
  assert.equal(history[0]!.value.execution!.phase, 'claimed');
  assert.equal(history[0]!.value.execution!.provider, null);
  assert.equal(history[0]!.value.ownerProcess!.pid, process.pid);
  assert.equal(history[1]!.value.execution!.phase, 'authorized');
  assert.ok(history[1]!.value.providerProcess!.pid > 0);
  assert.equal(history[1]!.value.response, null);
  assert.equal(call.value.status, 'succeeded');
  assert.equal(call.value.usage!.inputTokens, 120);
  assert.deepEqual(modelUsage(store, 'p', 0).interruptions, []);
});

test("absent, foreign, malformed and timed-out usage is never reported as a measured zero", async t => {
  const { store, environment } = fixture(t);
  for (const scenario of ["unknown", "foreign", "invalid", "timeout"]) {
    const env = environment(scenario);
    const call = researchCall(env.implementer, env, "Probe", {}, undefined, { store, draftId: "draft-p", purpose: "reader" });
    if (scenario === "unknown") await call;
    else await assert.rejects(call, { code: scenario === "foreign" ? "research_response_foreign" : scenario === "invalid" ? "usage_invalid" : "process_timeout" });
  }
  const report = modelUsage(store, "p", 0);
  assert.equal(report.cumulative.measuredCalls, 0); assert.equal(report.cumulative.unmeasuredCalls, 4);
  assert.equal(report.cumulative.reportedTokens, null); assert.equal(report.active.length, 0);
  assert.throws(() => tokenUsage({ inputTokens: 2, outputTokens: 1, cachedInputTokens: 0 }), { code: "usage_invalid" });
  assert.throws(() => tokenUsage({ inputTokens: -1, outputTokens: 1, cachedInputTokens: null, reasoningOutputTokens: null }), { code: "usage_invalid" });
});

test("Codex JSONL normalization counts terminal usage and exposes missing coverage", () => {
  const completed = { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 } };
  assert.deepEqual(codexUsage(JSON.stringify(completed)), { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, reasoningOutputTokens: 5 });
  assert.deepEqual(codexUsage([completed, completed].map(value => JSON.stringify(value)).join("\n")), { inputTokens: 200, outputTokens: 40, cachedInputTokens: 120, reasoningOutputTokens: 10 });
  assert.equal(codexUsage(JSON.stringify({ type: "turn.started" })), null);
  assert.equal(codexUsage([completed, { type: "turn.failed" }].map(value => JSON.stringify(value)).join("\n")), null);
  assert.throws(() => codexUsage(JSON.stringify({ ...completed, usage: { ...completed.usage, input_tokens: -1 } })), { code: "usage_invalid" });
});

test("Codex adapter requests JSON usage and explicit fast mode through the real subprocess boundary", async t => {
  const { root, store, environment } = fixture(t);
  const mock = `#!${process.execPath}\nimport {readFileSync,writeFileSync,existsSync} from 'node:fs';
readFileSync(0,'utf8');const args=process.argv.slice(2);writeFileSync('args.json',JSON.stringify(args));
const outcome=existsSync('outcome.txt')?readFileSync('outcome.txt','utf8'):'ok';
if(outcome!=='missing')writeFileSync(args[args.indexOf('-o')+1],outcome==='empty'?'':outcome==='malformed'?'not json':JSON.stringify({action:'pause',reason:'Fixture completed'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:200,cached_input_tokens:150,output_tokens:30,reasoning_output_tokens:10}}));
if(outcome==='failed')process.exitCode=1;`;
  writeFileSync(join(root, "codex"), mock, { mode: 0o700 });
  const previousPath = process.env['PATH']; process.env['PATH'] = `${root}:${previousPath ?? ""}`;
  try {
    const env = environment("normal");
    env.implementer.command = { executable: process.execPath, args: [fileURLToPath(new URL("../src/adapters/codex-stdio.js", import.meta.url))] };
    assert.deepEqual(await researchCall(env.implementer, env, "Fixture", {}, undefined, { store, draftId: "draft-p", purpose: "reader" }),
      { action: "pause", reason: "Fixture completed" });
    const args = JSON.parse(readFileSync(join(root, "args.json"), "utf8")) as string[];
    assert.ok(args.includes("--json")); assert.ok(args.includes('service_tier="fast"')); assert.ok(args.includes("features.fast_mode=true"));
    assert.ok(!args.includes("skills.max_context_tokens=1"), "Existing adapter invocations keep their configured context");
    const report = modelUsage(store, "p", 0);
    assert.deepEqual(report.cumulative.reportedTokens, { input: 200, output: 30, cachedInput: 150, reasoningOutput: 10 });
    assert.equal(report.roles[0]!.requestedSpeed, "fast"); assert.deepEqual(report.roles[0]!.confirmedSpeeds, [null]);
    for (const outcome of ["empty", "malformed", "missing", "failed"]) {
      writeFileSync(join(root, "outcome.txt"), outcome);
      await assert.rejects(researchCall(env.implementer, env, "Fixture", {}, undefined,
        { store, draftId: "draft-p", purpose: "reader" }), { code: "research_provider_failed" });
    }
    const failures = modelUsage(store, "p", 0).cumulative;
    assert.equal(failures.failed, 4); assert.equal(failures.measuredCalls, 5);
    assert.deepEqual(failures.reportedTokens, { input: 1000, output: 150, cachedInput: 750, reasoningOutput: 50 });
  } finally { if (previousPath === undefined) delete process.env['PATH']; else process.env['PATH'] = previousPath; }
});

test("compact research is opt-in, retains the exact request, and cannot apply to coding or review", async t => {
  const { root, store, environment } = fixture(t);
  const mock = `#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);writeFileSync('compact-args.json',JSON.stringify(args));writeFileSync('compact-input.txt',readFileSync(0,'utf8'));
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({action:'pause',reason:'Fixture only'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:30,output_tokens:5,cached_input_tokens:0,reasoning_output_tokens:0}}));`;
  writeFileSync(join(root, "codex"), mock, { mode: 0o700 });
  const previousPath = process.env['PATH']; process.env['PATH'] = `${root}:${previousPath ?? ""}`;
  try {
    const adapter = fileURLToPath(new URL("../src/adapters/codex-stdio.js", import.meta.url));
    const env = environment("normal");
    env.implementer.command = { executable: process.execPath, args: [adapter, "--compact-research"] };
    const subject = { condition: "Не менять источники.\r\n😀", source: { id: "exact-source", revision: 3, hash: "a".repeat(64) } };
    await researchCall(env.implementer, env, "Exact research instruction", subject, undefined, { store, draftId: "draft-p", purpose: "analyst" });
    const args = JSON.parse(readFileSync(join(root, "compact-args.json"), "utf8")) as string[];
    for (const setting of ["features.shell_tool=false", 'web_search="disabled"', "skills.max_context_tokens=1", "--json", 'service_tier="fast"']) assert.ok(args.includes(setting));
    for (const forbidden of ["--ignore-user-config", "project_doc_max_bytes=0", "danger-full-access"]) assert.ok(!args.includes(forbidden));
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    const sent = readFileSync(join(root, "compact-input.txt"), "utf8");
    assert.ok(sent.endsWith("Exact research instruction\nSubject:\n" + JSON.stringify(subject)));
    assert.equal(store.list<ModelCall>("model-call")[0]!.value.usage!.inputTokens, 30);
    for (const mode of ["implement", "review", "chat"]) {
      const result = await runProcess(env.implementer.command, root, JSON.stringify({ protocol: "omg-agent/v1", requestId: "probe",
        mode, model: "fixture", effort: "high", prompt: "No dispatch permitted" }), 3000);
      assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /adapter_mode_invalid/);
      assert.equal(readFileSync(join(root, "compact-input.txt"), "utf8"), sent, "Rejected mode never reaches the provider");
    }
  } finally { if (previousPath === undefined) delete process.env['PATH']; else process.env['PATH'] = previousPath; }
});

test("Codex reader uses an output schema with numeric source indices", async t => {
  const { root, store, environment } = fixture(t);
  fictitiousCodexHome(t);
  writeFileSync(join(root,'codex'),`#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';readFileSync(0,'utf8');const args=process.argv.slice(2);
writeFileSync('reader-schema-copy.json',readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({selections:[{sourceIndex:0,firstLine:1,lastLine:1}],unresolved:[]}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0,reasoning_output_tokens:0}}));`,{mode:0o700});
  const previousPath=process.env['PATH'];process.env['PATH']=`${root}:${previousPath??''}`;
  try{
    const env=environment('normal');
    env.implementer.command={executable:process.execPath,args:[fileURLToPath(new URL('../src/adapters/codex-stdio.js',import.meta.url)),'--compact-research']};
    const result=await researchCall(env.implementer,env,'Select supplied sources',{role:'reader',sources:[]},undefined,{store,draftId:'draft-p',purpose:'reader'});
    assert.deepEqual(result,{selections:[{sourceIndex:0,firstLine:1,lastLine:1}],unresolved:[]});
    const schema=JSON.parse(readFileSync(join(root,'reader-schema-copy.json'),'utf8'));
    assert.deepEqual(schema.properties.selections.items.required,['sourceIndex','firstLine','lastLine']);
    assert.equal(schema.properties.selections.items.properties.source,undefined);
  }finally{if(previousPath===undefined)delete process.env['PATH'];else process.env['PATH']=previousPath;}
});

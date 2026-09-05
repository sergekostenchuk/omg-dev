import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/storage/store.js";
import { researchCall } from "../src/discovery/research-protocol.js";
import { codexUsage } from "../src/adapters/codex-usage.js";
import { modelUsage, tokenUsage, type ModelCall } from "../src/runtime/model-usage.js";
import type { Environment } from "../src/runtime/environment.js";

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

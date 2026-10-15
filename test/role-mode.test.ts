import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Chat } from "../src/product/chat.js";
import { parseCommand } from "../src/product/commands.js";
import { researchCall } from "../src/discovery/research-protocol.js";
import { pilotEnvironment, configureReaderPilot } from "../src/discovery/reader-pilot.js";
import { callAgent } from "../src/execution/protocol.js";
import { prepareApplicationEnvironment } from "../src/om/model-call.js";
import { reference } from "../src/pipeline/contracts.js";
import { hashJson } from "../src/canonical.js";
import type { Graph } from "../src/graph/model.js";
import {
  Environments, MODE_ROLE_COMMANDS, UNIVERSAL_ROLE_COMMAND, inspectRepository, readEnvironmentAt, resolveRoleMode,
  type Environment, type RoleBinding,
} from "../src/runtime/environment.js";

const PROVIDER = `import {appendFileSync,readFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),marker=process.argv[2],log=process.argv[3];
appendFileSync(log,JSON.stringify({marker,mode:request.mode,model:request.model,effort:request.effort})+'\\n');
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,text:marker,marker,
  research:{marker,mode:request.mode,model:request.model,effort:request.effort},usage:null}));`;

// Exact environment:omg-live revision 1 from the immutable
// omg-live-091026-1800-complete.sqlite archive. It predates commandContract.
const LIVE_ENVIRONMENT_R1: Environment = {
  fullCheck: { args: ["scripts/check-backend.mjs"], executable: "/Users/kostenchuksergey/.hermes/node/bin/node" },
  implementer: { actor: "omg-author", command: {
    args: ["/Users/kostenchuksergey/OMG/.omg/live-source/dist/src/adapters/codex-stdio.js"],
    executable: "/Users/kostenchuksergey/.hermes/node/bin/node",
  }, effort: "high", model: "gpt-6-astra" },
  projectId: "omg-live",
  reviewer: { actor: "omg-independent-reviewer", command: {
    args: ["/Users/kostenchuksergey/OMG/.omg/live-source/dist/src/adapters/codex-stdio.js"],
    executable: "/Users/kostenchuksergey/.hermes/node/bin/node",
  }, effort: "high", model: "gpt-6-astra" },
  timeoutMs: 600_000,
  workspace: "/Users/kostenchuksergey/OMG/.omg/live-source",
};
const LIVE_ENVIRONMENT_R1_HASH = "f4742089fa2130a6e5b9a572654d64ec805b43fb158e7d119995b33da979d3c1";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-role-mode-")), workspace = join(root, "repo"), database = join(root, "state.sqlite");
  mkdirSync(workspace); const provider = join(workspace, "provider.mjs"), log = join(root, "calls.jsonl");
  writeFileSync(provider, PROVIDER); writeFileSync(log, "");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["add", "provider.mjs"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: workspace });
  const store = new Store(database), environments = new Environments(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = (marker: string) => ({ executable: process.execPath, args: [provider, marker, log] });
  const role = (actor: string, research: string, cells: Partial<Record<"implement" | "review" | "chat", string>>): RoleBinding => ({
    actor, model: `${actor}-model`, effort: "high", command: command(research), commandContract: MODE_ROLE_COMMANDS,
    modeCommands: Object.fromEntries(Object.entries(cells).map(([mode, marker]) => [mode, command(marker!)])),
  });
  const settings = (implementer = role("worker", "worker-research", { implement: "worker-implement", chat: "worker-chat" }),
    reviewer = role("reviewer", "reviewer-research", { review: "reviewer-review" })) => ({
      workspace, implementer, reviewer, fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5_000,
    });
  return { root, workspace, database, store, environments, command, role, settings, log };
}

function emptyGraph(): Graph {
  return { version: 2, id: "graph:p", title: "Empty", horizon: [], contracts: [], nodes: [], artifacts: [], connectors: [], anchors: [], joins: [], tests: [] };
}

test("CFG1 selects one effective command for research, OM research, implementation, review and chat", async t => {
  const f = fixture(t), environment = f.environments.configure("p", f.settings(), 0);
  assert.equal(environment.value.implementer.commandContract, MODE_ROLE_COMMANDS);
  assert.equal(resolveRoleMode("implementer", environment.value.implementer, "research").command.args[1], "worker-research");
  assert.equal(resolveRoleMode("implementer", environment.value.implementer, "implement").command.args[1], "worker-implement");
  assert.equal(resolveRoleMode("reviewer", environment.value.reviewer, "research").command.args[1], "reviewer-research");
  assert.equal(resolveRoleMode("reviewer", environment.value.reviewer, "review").command.args[1], "reviewer-review");

  const analyst = await researchCall(environment.value.implementer, environment.value, "Research", { mode: "implement" });
  const assessor = await researchCall(environment.value.reviewer, environment.value, "Assess", {});
  assert.deepEqual(analyst, { marker: "worker-research", mode: "research", model: "worker-model", effort: "high" });
  assert.deepEqual(assessor, { marker: "reviewer-research", mode: "research", model: "reviewer-model", effort: "high" });

  const usage: string[] = [], starts: number[] = [];
  const implemented = await callAgent(environment.value.implementer, environment.value, "implement", "Implement", { mode: "research" }, 30_000,
    value => usage.push(`${value.mode}:${value.model}`), child => { if (child) starts.push(child.pid); });
  const reviewed = await callAgent(environment.value.reviewer, environment.value, "review", "Review", {}, 30_000,
    value => usage.push(`${value.mode}:${value.model}`), child => { if (child) starts.push(child.pid); });
  assert.equal(implemented["marker"], "worker-implement"); assert.equal(reviewed["marker"], "reviewer-review");
  assert.deepEqual(usage, ["implement:worker-model", "implement:worker-model", "review:reviewer-model", "review:reviewer-model"]);
  assert.equal(starts.length, 2);

  const chat = await new Chat(f.store, f.environments).send("p", "Explain", {});
  assert.equal(chat.value.status, "completed"); assert.equal(chat.value.text, "worker-chat");
  const calls = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => [call.mode, call.marker]), [
    ["research", "worker-research"], ["research", "reviewer-research"],
    ["implement", "worker-implement"], ["review", "reviewer-review"], ["chat", "worker-chat"],
  ]);
  assert.ok(calls.every(call => call.model.endsWith("-model") && call.effort === "high"));
});

test("CFG1 refuses only the requested missing cell before a send or durable chat turn, while research stays available", async t => {
  const f = fixture(t);
  const missing = f.settings(f.role("worker", "worker-research", {}), f.role("reviewer", "reviewer-research", {}));
  const environment = f.environments.configure("p", missing, 0);
  assert.deepEqual(await researchCall(environment.value.implementer, environment.value, "Research", {}),
    { marker: "worker-research", mode: "research", model: "worker-model", effort: "high" });
  let usage = 0, starts = 0, sends = 0;
  await assert.rejects(() => callAgent(environment.value.implementer, environment.value, "implement", "Implement", {}, 30_000,
    () => usage++, () => starts++, undefined, () => { sends++; throw new Error("must not reserve"); }),
  (error: unknown) => (error as { code?: string; details?: unknown }).code === "role_mode_missing"
    && JSON.stringify((error as { details?: unknown }).details) === JSON.stringify({ role: "implementer", mode: "implement" }));
  await assert.rejects(() => callAgent(environment.value.reviewer, environment.value, "review", "Review", {}, 30_000,
    () => usage++, () => starts++, undefined, () => { sends++; throw new Error("must not reserve"); }),
  (error: unknown) => (error as { code?: string; details?: unknown }).code === "role_mode_missing"
    && JSON.stringify((error as { details?: unknown }).details) === JSON.stringify({ role: "reviewer", mode: "review" }));
  assert.deepEqual({ usage, starts, sends }, { usage: 0, starts: 0, sends: 0 });
  await assert.rejects(() => new Chat(f.store, f.environments).send("p", "No fallback", {}), { code: "role_mode_missing" });
  assert.equal(f.store.list("chat").length, 0);
  const findings = inspectRepository(environment.value, emptyGraph()).findings;
  assert.deepEqual(findings.filter(item => item.code === "role_mode_missing").map(item => item.target).sort(),
    ["implementer:implement", "reviewer:review"]);

  const fixed = f.environments.configure("p", f.settings(), environment.revision);
  assert.equal((await callAgent(fixed.value.implementer, fixed.value, "implement", "Implement", {}, 30_000, () => {}, () => {}))["marker"],
    "worker-implement");
  assert.equal(inspectRepository(fixed.value, emptyGraph()).findings.some(item => item.code === "role_mode_missing"), false);
});

test("CFG1 preserves universal history and explicit reader pilot overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "omg-role-era-")), workspace = join(root, "workspace"); mkdirSync(workspace);
  const provider = join(workspace, "provider.mjs"); writeFileSync(provider, PROVIDER);
  const store = new Store(join(root, "state.sqlite")), environments = new Environments(store);
  const command = { executable: process.execPath, args: [provider, "universal", join(root, "log")] };
  const plain = { workspace, implementer: { actor: "worker", model: "m", effort: "high", command },
    reviewer: { actor: "reviewer", model: "m", effort: "high", command }, fullCheck: command, timeoutMs: 1_000 };
  try {
    const configured = environments.configure("p", plain, 0);
    assert.equal(configured.value.implementer.commandContract, UNIVERSAL_ROLE_COMMAND);
    assert.deepEqual(resolveRoleMode("implementer", configured.value.implementer, "chat").command, command);
    assert.equal(hashJson(LIVE_ENVIRONMENT_R1), LIVE_ENVIRONMENT_R1_HASH);
    const historical = store.write<Environment>({ id: "environment:omg-live", kind: "environment", expected: 0,
      value: LIVE_ENVIRONMENT_R1 });
    const read = readEnvironmentAt(store, "omg-live", reference(historical));
    assert.equal(read.hash, LIVE_ENVIRONMENT_R1_HASH);
    assert.equal(read.value.implementer.commandContract, undefined);
    assert.deepEqual(resolveRoleMode("reviewer", read.value.reviewer, "review").command, LIVE_ENVIRONMENT_R1.reviewer.command);

    const pilotCommand = { executable: process.execPath, args: [provider, "pilot", join(root, "log")] };
    const pilot = configureReaderPilot(store, environments, "p", { experimental: true, active: true, stopAfter: "L2",
      reader: { actor: "reader", model: "reader-model", effort: "high", speed: "inherited", command: pilotCommand }, agentCommand: pilotCommand,
      maxRequestChars: 10_000, maxReadChars: 10_000, maxReplyChars: 10_000, maxCalls: 2, maxReportedTokens: 10_000 }, 0);
    const dispatch = pilotEnvironment(configured.value, pilot.value);
    assert.equal(dispatch.implementer.actor, "worker"); assert.deepEqual(resolveRoleMode("implementer", dispatch.implementer, "research").command, pilotCommand);
    assert.equal(dispatch.reviewer.actor, "reviewer"); assert.deepEqual(resolveRoleMode("reviewer", dispatch.reviewer, "research").command, pilotCommand);
    assert.equal(resolveRoleMode("reader", pilot.value.reader, "research").actor, "reader");
    assert.deepEqual(reference(store.get(pilot.id)!), reference(pilot));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("CFG1 recovery compatibility ignores coding-only changes and rejects a changed selected research command across Stores", t => {
  const f = fixture(t), original = f.environments.configure("p", f.settings(), 0);
  const otherStore = new Store(f.database), other = new Environments(otherStore);
  try {
    const { projectId: _projectId, ...settings } = original.value;
    const codingOnly = other.configure("p", { ...settings, implementer: { ...settings.implementer,
      modeCommands: { ...settings.implementer.modeCommands, implement: f.command("worker-implement-v2") } } }, original.revision);
    const compatible = prepareApplicationEnvironment(f.store, "p", reference(original), "implementer");
    assert.equal(compatible.ok, true); if (compatible.ok) assert.deepEqual(compatible.value.guards, [reference(codingOnly)]);
    const before = f.store.list().length;
    const changedResearch = other.configure("p", { ...settings, implementer: { ...settings.implementer,
      command: f.command("worker-research-v2") } }, codingOnly.revision);
    const stale = prepareApplicationEnvironment(f.store, "p", reference(original), "implementer");
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.refusal.code, "input_stale");
    assert.equal(f.store.list().length, before, "Compatibility preparation creates no record beside the configured heads");
    assert.equal(f.store.get(original.id)!.revision, changedResearch.revision);
    assert.equal(f.store.history(original.id).length, 3, "The only revisions are the three explicit configurations");
  } finally { otherStore.close(); }
});

test("CFG1 guards the selected chat command before its authorizing record and retries with the current cell", async t => {
  const f = fixture(t), original = f.environments.configure("p", f.settings(), 0);
  const otherStore = new Store(f.database), other = new Environments(otherStore);
  try {
    const stale = new Environments(f.store), get = stale.get.bind(stale);
    let changed = false;
    stale.get = project => {
      const selected = get(project);
      if (!changed) {
        changed = true;
        const { projectId: _projectId, ...settings } = original.value;
        other.configure("p", { ...settings, implementer: { ...settings.implementer,
          modeCommands: { ...settings.implementer.modeCommands, chat: f.command("worker-chat-v2") } } }, original.revision);
      }
      return selected;
    };
    await assert.rejects(() => new Chat(f.store, stale).send("p", "Use the guarded command", {}), { code: "input_stale" });
    assert.equal(f.store.list("chat").length, 0); assert.equal(readFileSync(f.log, "utf8"), "");

    const retried = await new Chat(f.store, f.environments).send("p", "Use the current command", {});
    assert.equal(retried.value.status, "completed"); assert.equal(retried.value.text, "worker-chat-v2");
    assert.deepEqual(readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line).marker), ["worker-chat-v2"]);
  } finally { otherStore.close(); }
});

test("CFG1 configure schema accepts declared cells and rejects undeclared role fields", t => {
  const f = fixture(t), environment = f.settings();
  assert.equal(parseCommand({ type: "configure", project: "p", expected: 0, environment }).type, "configure");
  const invalid = structuredClone(environment) as typeof environment & { implementer: RoleBinding & { modeCommands: Record<string, unknown> } };
  invalid.implementer.modeCommands["unknown"] = f.command("foreign-mode");
  assert.throws(() => parseCommand({ type: "configure", project: "p", expected: 0, environment: invalid }), { code: "command_invalid" });
  const missingTable = structuredClone(environment); delete missingTable.implementer.modeCommands;
  assert.throws(() => f.environments.configure("missing-table", missingTable, 0), { code: "role_invalid" });
  assert.equal(f.store.get("environment:missing-table"), null);
  assert.throws(() => f.environments.configure("foreign-cell", { ...environment,
    implementer: f.role("worker", "worker-research", { review: "worker-review" }) }, 0), { code: "role_invalid" });
  assert.equal(f.store.get("environment:foreign-cell"), null);
});

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineError } from "../src/errors.js";
import { configureDispatch } from "../src/om/dispatch.js";
import { omStartReadiness, readEnvironmentReadiness } from "../src/om/environment-readiness.js";
import { reference } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { git, type RoleBinding } from "../src/runtime/environment.js";
import { Store } from "../src/storage/store.js";

/** A project whose workspace is a committed Git root, with capacity and the dispatch unless told otherwise. */
function readyFixture(t: TestContext, change: { implementer?: Partial<RoleBinding>; dispatch?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omg-env1-")), workspace = join(root, "repo");
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "ENV1\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=ENV1", "-c", "user.email=env1@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: "create-project", project: "p", title: "p" });
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("p", { workspace,
    implementer: { actor: "author", model: "fixture", effort: "high", command, ...change.implementer },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: command, timeoutMs: 4000, requestCapacityChars: 100_000 }, 0);
  if (change.dispatch !== false) configureDispatch(store, { project: "p", protocol: "codex-stdio" });
  const of = (name: string) => readEnvironmentReadiness(store, { project: "p" }).conditions.find(row => row.condition === name)!;
  return { root, workspace, store, engine, of };
}

test("ENV1 the reader names every condition with its moment; a ready environment admits a new OM pass with the guards of its records", t => {
  const f = readyFixture(t), status = readEnvironmentReadiness(f.store, { project: "p" });
  assert.deepEqual(status.conditions.map(row => [row.condition, row.state, row.requiredBy]), [
    ["environment", "available", "research"], ["research:implementer", "available", "research"], ["research:reviewer", "available", "research"],
    ["repository", "available", "om-start"], ["capacity", "available", "om-start"], ["dispatch", "available", "om-start"],
    ["implement:implementer", "available", "implement"], ["review:reviewer", "available", "review"], ["check", "unverified", "check"],
    ["web-research", "missing", "web-research"]]);
  const environment = reference(f.store.get("environment:p")!);
  assert.deepEqual(f.of("environment").basis.refs, [environment], "The basis names exact records");
  const admitted = omStartReadiness(f.store, "p");
  assert.ok(admitted.ok);
  assert.ok(admitted.value.guards.some(guard => JSON.stringify(guard) === JSON.stringify(environment)), "The environment is guarded");
  assert.ok(admitted.value.guards.some(guard => guard.id === "adapter:p:active" && "absent" in guard), "So is the absent active selection");
});

test("ENV1 a research command naming a missing adapter script is a refusal of its own moment; a known adapter module is classified, never proved", t => {
  const f = readyFixture(t, { implementer: { command: { executable: process.execPath, args: ["missing-adapter.mjs"] } } });
  assert.deepEqual([f.of("research:implementer").state, f.of("research:implementer").code], ["missing", "adapter_module_missing"]);
  const refused = omStartReadiness(f.store, "p");
  assert.ok(!refused.ok);
  assert.deepEqual([refused.refusal.code, refused.refusal.at.field], ["environment_not_ready", "research:implementer"]);
  assert.equal(f.of("research:reviewer").state, "available", "The other role keeps its own runner");
  writeFileSync(join(f.workspace, "codex-stdio.js"), "");
  const known = readyFixture(t, { implementer: { command: { executable: process.execPath, args: [join(f.workspace, "codex-stdio.js")] } } });
  const runner = known.of("research:implementer");
  assert.deepEqual([runner.state, (runner.basis.observed as { adapter: string }).adapter], ["available", "codex-stdio"]);
  assert.match(runner.action, /authorization/, "Its authorization and model are not claimed");
  mkdirSync(join(f.workspace, "devin-stdio.js"));
  const disguised = readyFixture(t, { implementer: { command: { executable: process.execPath, args: [join(f.workspace, "devin-stdio.js")] } } });
  assert.deepEqual([disguised.of("research:implementer").state, disguised.of("research:implementer").code],
    ["invalid", "adapter_module_invalid"], "A directory with a known module name is not an executable adapter module");
});

test("ENV1 a mode command that is not configured has its own later moment and blocks neither research nor a new OM pass", t => {
  const command = { executable: process.execPath, args: ["--version"] };
  const f = readyFixture(t, { implementer: { commandContract: "role-command/modes-v1", modeCommands: { chat: command } } });
  assert.deepEqual([f.of("implement:implementer").state, f.of("implement:implementer").code, f.of("implement:implementer").requiredBy],
    ["missing", "role_mode_missing", "implement"]);
  assert.equal(omStartReadiness(f.store, "p").ok, true);
});

test("ENV1 uncommitted changes are shown with the repository, never refused", t => {
  const f = readyFixture(t);
  writeFileSync(join(f.workspace, "draft.txt"), "work in progress\n");
  const repository = f.of("repository");
  assert.deepEqual([repository.state, (repository.basis.observed as { dirty: boolean }).dirty], ["available", true]);
  assert.equal(omStartReadiness(f.store, "p").ok, true);
});

test("ENV1 a malformed request is a typed refusal; a project without an environment names that one condition and refuses a new pass", t => {
  const f = readyFixture(t);
  assert.throws(() => readEnvironmentReadiness(f.store, { project: "p", extra: 1 } as unknown as { project: string }),
    (error: unknown) => error instanceof EngineError && error.code === "readiness_request_invalid");
  f.engine.execute({ type: "create-project", project: "q", title: "q" });
  assert.deepEqual(readEnvironmentReadiness(f.store, { project: "q" }).conditions.map(row => [row.condition, row.state, row.code]),
    [["environment", "missing", "environment_missing"]]);
  const refused = omStartReadiness(f.store, "q");
  assert.ok(!refused.ok);
  assert.deepEqual([refused.refusal.code, refused.refusal.at.field], ["environment_not_ready", "environment"]);
  assert.deepEqual(f.engine.execute({ type: "environment-readiness", project: "p" }), readEnvironmentReadiness(f.store, { project: "p" }),
    "The product command is the same reader");
});

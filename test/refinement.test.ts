import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { git, workspacePath } from "../src/runtime/environment.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { reference } from "../src/pipeline/contracts.js";
import type { Feasibility } from "../src/graph/refinement.js";

test("R0/L1/R1/L2/R2/L3/R3 checks a real repository without a machine plan or execution results", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-refinement-")); const workspace = join(root, "repo"); mkdirSync(workspace);
  git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "Initial repository\n");
  symlinkSync(".git", join(workspace, "metadata"));
  assert.throws(() => workspacePath(workspace, "metadata/config"), /Git metadata/);
  assert.throws(() => workspacePath(workspace, "metadata/hooks/new-hook"), /Git metadata/);
  git(workspace, ["add", "README.md", "metadata"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(join(root, "state.sqlite")); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, "garden");
  assert.throws(() => engine.refinement.sealLayer("garden", 1, 0), /preceding refinement phase/);
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("garden", { workspace,
    implementer: { actor: "worker", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command },
    fullCheck: command, timeoutMs: 1000 }, 0);
  refinedLayers(engine, "garden");
  const fake = engine.discovery.create("garden", "om-g2", "R1", "compilation", [
    { field: "anything", kind: "decision", prompt: "Pretend research is complete", risk: "masquerade", schema: { type: "string" } },
  ]);
  const fakeAnswered = engine.discovery.decision(fake.value.questions[0]!, 1, "owner", "ready");
  assert.throws(() => engine.refinement.finishResearch("garden", "R1", reference(fakeAnswered), 1), /phase's contract/);
  const r3 = engine.refinement.assess("garden", 0);
  assert.equal(r3.value.ready, true); assert.equal(store.list("plan").length, 0); assert.equal(store.list("run").length, 0);
  assert.equal(r3.value.repository!.head, git(workspace, ["rev-parse", "HEAD"]));
  const artifact = engine.refinement.publish("garden", reference(r3), 0);
  engine.pipeline.accept("garden", "om-g2", artifact.revision);
  assert.equal(engine.pipeline.inspect("garden", "om-g2").state, "accepted");
  writeFileSync(join(workspace, "uncommitted.txt"), "changed");
  assert.equal(engine.pipeline.inspect("garden", "om-g2").state, "stale");
  const refused = engine.refinement.assess("garden", 1);
  assert.equal(refused.value.ready, false);
  assert.ok(refused.value.findings.some(f => f.code === "repository_dirty"));
  assert.equal(store.get<Feasibility>(r3.id, 1)!.value.ready, true);
  unlinkSync(join(workspace, "uncommitted.txt"));
  writeFileSync(join(workspace, "README.md"), "The repository architecture has changed\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "changed research source"]);
  assert.throws(() => engine.execute({ type: "assess", project: "garden", expected: 2 }), /preceding refinement phase/);
  assert.ok(engine.projection("garden").feasibilityGate!.findings.length);
});

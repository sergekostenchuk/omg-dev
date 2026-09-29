// Probe: a project whose L2 is sealed and whose L3 is not (the omg-live state) — do the machine bases of H1.1 stand?
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const D = "/tmp/omg-dryrun-code/dist";
const { Store } = await import(`${D}/src/storage/store.js`);
const { ProductEngine } = await import(`${D}/src/product/engine.js`);
const { git } = await import(`${D}/src/runtime/environment.js`);
const { reference } = await import(`${D}/src/pipeline/contracts.js`);
const { configureDispatch } = await import(`${D}/src/om/dispatch.js`);
const { writeRunBases } = await import(`${D}/src/om/run-bases.js`);
const { gardenGraph } = await import(`${D}/test/om-fixture.js`);
const { preparedFeatures } = await import(`${D}/test/product-fixture.js`);
const { preparedField } = await import(`${D}/test/preparation-fixture.js`);
const { answerTechnicalFixture } = await import(`${D}/test/technical-research-fixture.js`);
const { deriveLayerFixture } = await import(`${D}/test/layer-design-fixture.js`);
const project = "garden";
function fixture(levels) {
  const root = mkdtempSync(join(tmpdir(), "omg-probe-l3-")), workspace = join(root, "repo"); mkdirSync(workspace);
  git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "probe\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=P", "-c", "user.email=p@example.invalid", "commit", "-m", "i"]);
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store);
  preparedFeatures(engine, project, gardenGraph(), field => preparedField(project, field));
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure(project, { workspace, implementer: { actor: "a", model: "m", effort: "high", command },
    reviewer: { actor: "b", model: "m", effort: "high", command }, fullCheck: command, timeoutMs: 10000, requestCapacityChars: 100000 }, 0);
  for (const [level, layer] of [["R0", 1], ["R1", 2], ["R2", 3]].slice(0, levels)) {
    const draft = engine.refinement.begin(project, level);
    if (level !== "R0") answerTechnicalFixture(engine, project, draft);
    engine.refinement.finishResearch(project, level, reference(store.get(draft.id)), 0);
    if (layer !== 1) deriveLayerFixture(engine, project, layer);
    engine.refinement.sealLayer(project, layer, 0);
  }
  configureDispatch(store, { project, protocol: "codex-stdio" });
  return store;
}
for (const levels of [2, 3]) {
  const store = fixture(levels);
  const l3 = store.get(`graph-layer:${project}:3`);
  const phases = ["L1", "L2", "L3"].filter(p => store.get(`phase:${project}:${p}`));
  const built = writeRunBases(store, { project });
  console.log(`sealed layers 1..${levels}: phases=${phases.join(",")} graph-layer:3=${l3 ? `r${l3.revision} proofs ${JSON.stringify((l3.value.layerProofs ?? []).map(p => p.level))}` : "—"}`
    + ` → writeRunBases ${built.ok ? "ok" : `REFUSED ${built.refusal.code} ${built.refusal.at.unit} ${built.refusal.at.target} ${built.refusal.at.field}`}`);
  store.close();
}

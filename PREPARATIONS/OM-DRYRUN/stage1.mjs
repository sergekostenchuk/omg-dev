// Stage 1 of the OM dry run on a copy of omg-live: everything up to the first model dispatch, through execute only.
//
//   node stage1.mjs --code <built checkout> --db <copy.sqlite> --run <run dir> --capacity <chars> --workspace <path>
//
// The environment of the copy keeps its workspace path (the accepted L2 phase binds workspace:omg-live) and gets both roles
// on stub-adapter.mjs plus the request capacity; this is verified BEFORE om-start. The stub holds the first request; a
// second store then stops the pass. Writes are logged to <run>/writes.jsonl, command answers to <run>/stage1.json.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPass, project } from "./common.mjs";

const arg = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const code = resolve(arg("code")), db = resolve(arg("db")), run = resolve(arg("run")), capacity = Number(arg("capacity"));
// configure saves the real path of the workspace; compare with that.
const workspace = realpathSync(resolve(arg("workspace")));
const stub = join(dirname(fileURLToPath(import.meta.url)), "stub-adapter.mjs");
const outcomes = ["autonomous-knowledge"];
mkdirSync(run, { recursive: true });
writeFileSync(join(run, "mode.json"), JSON.stringify({ mode: "hold" }));
const { Store, ProductEngine, store, engine, answers, timed, since } = await openPass({ code, db, run });

// 1. The environment: the live roles and settings, both commands on the stub, the request capacity, a no-op full check.
const live = store.get(`environment:${project}`);
const stubCommand = { executable: process.execPath, args: [stub, "--dir", run] };
const { projectId: _, ...settings } = live.value;
const environment = { ...settings, workspace, fullCheck: { executable: process.execPath, args: ["--version"] },
  implementer: { ...settings.implementer, command: stubCommand }, reviewer: { ...settings.reviewer, command: stubCommand },
  requestCapacityChars: capacity };
await timed("configure", () => engine.execute({ type: "configure", project, expected: live.revision, environment }));
await timed("configure-om-dispatch", () => engine.execute({ type: "configure-om-dispatch", project, protocol: "codex-stdio" }));

// 2. The stub check, before any pass command: both roles of the exact dispatched environment run stub-adapter.mjs.
const dispatch = answers["configure-om-dispatch"].value?.dispatch;
const configured = dispatch && store.get(dispatch.config.id, dispatch.config.revision);
const adapter = dispatch && store.get(dispatch.adapter.id, dispatch.adapter.revision);
const roles = configured ? ["implementer", "reviewer"].map(role => configured.value[role].command) : [];
const verify = { dispatch, adapter: adapter?.value ?? null, environmentRevision: configured?.revision ?? null,
  commands: roles, workspace: configured?.value.workspace ?? null, capacity: configured?.value.requestCapacityChars ?? null,
  workspaceRecordRewritten: store.get(`workspace:${project}`)?.revision !== 1,
  stubOnly: roles.length === 2 && roles.every(command => command.executable === process.execPath && command.args[0] === stub
    && !JSON.stringify(command).includes("codex-stdio.js") && !/codex|claude/i.test(command.executable)) };
writeFileSync(join(run, "verify.json"), JSON.stringify(verify, null, 2));
console.log("STUB CHECK", JSON.stringify({ stubOnly: verify.stubOnly, workspace: verify.workspace, workspaceRecordRewritten: verify.workspaceRecordRewritten, commands: roles }));
if (!verify.stubOnly || verify.workspace !== workspace) { console.error("STOP: the dispatch does not point at the stub only"); process.exit(3); }

// 3. The pass: reads, then om-start until the stub holds the first dispatch (or the drive ends before any dispatch).
await timed("om-state:before", () => engine.execute({ type: "om-state", project }));
await timed("om-spend:before", () => engine.execute({ type: "om-spend", project }));
const t0 = Date.now();
let settled = false;
const driving = engine.execute({ type: "om-start", project, outcomes }).finally(() => { settled = true; });
const held = join(run, "hold-0.json");
// The poll ends with the drive too; otherwise a pass that ends before any dispatch leaves this process polling forever.
const first = await Promise.race([driving.then(() => "ended"), (async () => {
  while (!settled && !existsSync(held)) await new Promise(done => setTimeout(done, 100));
  return settled ? "ended" : "held";
})()]);
console.log(`[${since()}s] om-start reached: ${first} after ${Date.now() - t0} ms`);
answers["om-start:first-dispatch-ms"] = first === "held" ? Date.now() - t0 : null;
if (first === "held") {
  const other = new Store(db);
  try {
    const otherEngine = new ProductEngine(other);
    await timed("om-state:held", () => otherEngine.execute({ type: "om-state", project }));
    await timed("om-stop", () => otherEngine.execute({ type: "om-stop", project }));
  } finally { other.close(); }
}
await timed("om-start", () => driving);
await timed("om-state:after", () => engine.execute({ type: "om-state", project }));
await timed("om-spend:after", () => engine.execute({ type: "om-spend", project }));
writeFileSync(join(run, "stage1.json"), JSON.stringify(answers, null, 1));
store.close();
console.log(`[${since()}s] done`);

// Stage 2 of the OM dry run: the pass stopped by stage 1 is resumed by its named stop and driven with the "cannot answer"
// stub until the driver ends it (unable, waiting, stopped). Through execute only.
//
//   node stage2.mjs --code <built checkout> --db <copy.sqlite> --run <stage-1 run dir> --rules <rules module> --limit <minutes>
//
// Guards: an unrecognised request is held by the stub and the pass is stopped; a saved M8/handoff/compile step is stopped
// by common.mjs before it runs; past the time limit the pass is stopped. Answers go to <run>/stage2.json.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openPass, project } from "./common.mjs";

const arg = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const code = resolve(arg("code")), db = resolve(arg("db")), run = resolve(arg("run")), rules = resolve(arg("rules"));
const limit = Number(arg("limit") ?? 45) * 60_000;
const { Store, ProductEngine, store, engine, answers, timed, since } = await openPass({ code, db, run });
const heldBefore = new Set(readdirSync(run).filter(name => /^hold-\d+\.json$/.test(name)));
writeFileSync(join(run, "mode.json"), JSON.stringify({ mode: "respond", rules }));

const before = await timed("om-state:before", () => engine.execute({ type: "om-state", project }));
const token = before.value?.value?.control?.control?.value?.stop?.token;
if (!token) { console.error("STOP: the pass has no saved stop to resume"); process.exit(3); }
const stopFromElsewhere = async why => {
  const other = new Store(db);
  try { await timed(`om-stop:${why}`, () => new ProductEngine(other).execute({ type: "om-stop", project })); } finally { other.close(); }
};
const t0 = Date.now();
let ended = false;
const driving = engine.execute({ type: "om-continue", project, resumeStop: token }).finally(() => { ended = true; });
const watching = (async () => {
  while (!ended) {
    const held = readdirSync(run).filter(name => /^hold-\d+\.json$/.test(name) && !heldBefore.has(name));
    if (held.length) { console.log(`[${since()}s] stub held an unrecognised request: ${held.join(",")}`); await stopFromElsewhere("unrecognised"); return; }
    if (Date.now() - t0 > limit) { console.log(`[${since()}s] time limit reached`); await stopFromElsewhere("limit"); return; }
    await new Promise(done => setTimeout(done, 500));
  }
})();
await timed("om-continue:resumeStop", () => driving);
await watching;
answers["om-continue:wall-ms"] = Date.now() - t0;
await timed("om-state:after", () => engine.execute({ type: "om-state", project }));
await timed("om-spend:after", () => engine.execute({ type: "om-spend", project }));
writeFileSync(join(run, "stage2.json"), JSON.stringify(answers, null, 1));
store.close();
console.log(`[${since()}s] done; trace requests: ${existsSync(join(run, "trace.jsonl")) ? "see trace.jsonl" : "none"}`);

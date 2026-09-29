// CPU profile of the dry-run pass, one profile per H1 step, on a copy of the stage-2 snapshot.
//
//   /usr/bin/time -l node profile-steps.mjs --code <built checkout> --db <copy.sqlite> --out <dir> --until cycle --minutes 60
//
// The saved stop is lifted by its exact token (resumeStoppedPass, as om-continue{resumeStop} does), then advanceRun is
// called step by step with the E4.1 dispatch. Each call is profiled on its own through node:inspector and saved as
// <out>/step-<n>-<phase>-<action>.cpuprofile; store calls and memory are logged per step to <out>/steps.jsonl. The run
// ends after the first performed step named by --until, or when the time budget is spent between steps.
import { Session } from "node:inspector/promises";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const code = resolve(arg("code")), db = resolve(arg("db")), out = resolve(arg("out"));
const until = arg("until") ?? "cycle", budget = Number(arg("minutes") ?? 60) * 60_000, project = "omg-live";
mkdirSync(out, { recursive: true });
const { Store } = await import(`${code}/dist/src/storage/store.js`);
const { readDispatch } = await import(`${code}/dist/src/om/dispatch.js`);
const { advanceRun } = await import(`${code}/dist/src/om/run.js`);
const { resumeStoppedPass, readPass } = await import(`${code}/dist/src/om/run-driver.js`);

const calls = { get: 0, history: 0, list: 0, writeMany: 0, historyRows: 0, listRows: 0 };
class Counted extends Store {
  get(...args) { calls.get++; return super.get(...args); }
  history(...args) { calls.history++; const rows = super.history(...args); calls.historyRows += rows.length; return rows; }
  list(...args) { calls.list++; const rows = super.list(...args); calls.listRows += rows.length; return rows; }
  writeMany(...args) { calls.writeMany++; return super.writeMany(...args); }
}
const store = new Counted(db);
const session = new Session(); session.connect();
await session.post("Profiler.enable"); await session.post("Profiler.setSamplingInterval", { interval: 1000 });
const started = Date.now();
const log = row => appendFileSync(join(out, "steps.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");

const state = readPass(store, { project });
const token = state.value.control.control?.value.stop?.token;
const resumed = resumeStoppedPass(store, { project, stop: token });
log({ resume: resumed.ok ? { generation: resumed.value.value.generation } : resumed.refusal });
if (!resumed.ok) { console.error("resume refused", JSON.stringify(resumed.refusal)); process.exit(3); }
const dispatch = readDispatch(store, { project });
const request = { project, dispatch: dispatch.value.dispatch };

let peakRss = process.memoryUsage().rss;
for (let step = 1; ; step++) {
  if (Date.now() - started > budget) { log({ end: "budget" }); break; }
  const before = { ...calls };
  await session.post("Profiler.start");
  const t0 = Date.now();
  let advanced, failure = null;
  try { advanced = await advanceRun(store, request); } catch (error) { failure = { code: error.code ?? null, message: error.message }; }
  const ms = Date.now() - t0;
  const { profile } = await session.post("Profiler.stop");
  const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss);
  const record = advanced?.ok ? advanced.value.record.value : null;
  const phase = record?.state.phase ?? "refused", action = record?.state.step?.action ?? null;
  const performed = advanced?.ok ? advanced.value.performed?.action ?? null : null;
  const name = `step-${String(step).padStart(2, "0")}-${performed ? `performed-${performed}` : `${phase}-${action ?? "-"}`}`;
  writeFileSync(join(out, `${name}.cpuprofile`), JSON.stringify(profile));
  const delta = Object.fromEntries(Object.keys(calls).map(key => [key, calls[key] - before[key]]));
  const row = { step, ms, phase, action, performed, refusal: advanced && !advanced.ok ? advanced.refusal : null, failure, calls: delta,
    rssMB: Math.round(memory.rss / 1048576), heapUsedMB: Math.round(memory.heapUsed / 1048576), peakRssMB: Math.round(peakRss / 1048576), profile: name };
  log(row);
  console.log(`step ${step}: ${ms} ms ${performed ? `performed ${performed}` : `${phase} ${action ?? ""}`} rss=${row.rssMB}MB get=${delta.get} history=${delta.history}(${delta.historyRows} rows) list=${delta.list}(${delta.listRows} rows)`);
  if (!advanced?.ok || failure || ["complete", "unable", "waiting"].includes(phase) || performed === until) break;
  // The M8 guard of common.mjs: a saved step that would run git in the workspace is never performed here.
  if (phase === "step" && ["feasibility", "handoff", "compile"].includes(action)) { log({ end: `guard:${action}` }); break; }
}
session.disconnect(); store.close();
console.log(`done in ${Math.round((Date.now() - started) / 1000)} s, peak rss ${Math.round(peakRss / 1048576)} MB`);

// Shared parts of the OM dry-run stages: a store that logs every write with its time, and the M8 guard.
//
// The guard: the pass saves a step before it performs it (H1), and every advance admits the run control first. When the
// pass saves a feasibility (M8), handoff or compile step, a second store saves om-stop at once, before the next advance
// can perform it. These are the only OM steps that run git in the workspace (inspectRepository, om-g2 acceptance).
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const project = "omg-live";
export const GUARDED_STEPS = Object.freeze(["feasibility", "handoff", "compile"]);

export async function openPass({ code, db, run }) {
  const { Store } = await import(`${code}/dist/src/storage/store.js`);
  const { ProductEngine } = await import(`${code}/dist/src/product/engine.js`);
  const started = Date.now();
  const since = () => ((Date.now() - started) / 1000).toFixed(1);
  const log = (file, row) => appendFileSync(join(run, file), JSON.stringify({ t: since(), at: new Date().toISOString(), ...row }) + "\n");
  const guard = { stopped: null };
  class Logged extends Store {
    writeMany(inputs, guards = []) {
      const t0 = Date.now(), written = super.writeMany(inputs, guards);
      let guarded = null;
      log("writes.jsonl", { ms: Date.now() - t0, writes: inputs.map(write => {
        const row = { id: write.id, kind: write.kind };
        if (write.id === `om-run:${project}`) {
          const value = write.value;
          row.phase = value.state?.phase; row.step = value.state?.step?.action ?? null; row.wait = value.state?.wait?.code ?? null;
          row.reasons = value.state?.reasons?.map(reason => `${reason.kind}:${reason.code}@${reason.target}`) ?? null;
          row.last = value.last ? { step: value.last.step?.action, products: value.last.products?.length, refusal: value.last.refusal?.code ?? null } : null;
          if (row.phase === "step" && GUARDED_STEPS.includes(row.step)) guarded = row.step;
        }
        return row;
      }) });
      if (guarded && !guard.stopped) {
        const other = new Store(db);
        try { guard.stopped = { step: guarded, answer: new ProductEngine(other).execute({ type: "om-stop", project }) }; }
        finally { other.close(); }
        log("guard.jsonl", { guarded, stopped: guard.stopped.answer.ok });
        console.log(`[${since()}s] M8 GUARD: the pass saved ${guarded}; om-stop written before it can run`);
      }
      return written;
    }
  }
  const store = new Logged(db), engine = new ProductEngine(store), answers = {};
  const timed = async (name, action) => {
    const t0 = Date.now();
    try { answers[name] = { value: await action() }; }
    catch (error) { answers[name] = { error: { code: error.code ?? null, message: error.message, details: error.details ?? null } }; }
    answers[name].ms = Date.now() - t0;
    const value = answers[name].value;
    const summary = answers[name].error ? `ERROR ${answers[name].error.code}` : value && value.ok === false ? `REFUSED ${value.refusal.code}`
      : value?.value?.end ? `end=${value.value.end} refusal=${value.value.refusal?.code ?? null}` : "ok";
    console.log(`[${since()}s] ${name}: ${answers[name].ms} ms ${summary}`);
    return answers[name];
  };
  return { Store, ProductEngine, store, engine, answers, timed, since, log, guard };
}

// Dry-run stand-in for the omg-agent/v1 research adapter (the codex-stdio protocol).
// It never starts a model, a CLI or a network request: it records each request and answers from local rules only.
//
//   node stub-adapter.mjs --dir <run directory>
//
// <dir>/mode.json selects the behaviour, read anew for every request so the environment never changes between stages:
//   {"mode":"hold"}                          record the request, write <dir>/hold-<n>.json, stop this process (SIGSTOP)
//   {"mode":"respond","rules":"<module>"}    record the request, answer with the default export of <module>(request, index)
// Every request is appended to <dir>/trace.jsonl with its index, time and prompt size.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const at = process.argv.indexOf("--dir");
const dir = at > 0 ? process.argv[at + 1] : undefined;
if (!dir) { process.stderr.write("stub-adapter: --dir is required\n"); process.exit(2); }

const request = JSON.parse(readFileSync(0, "utf8"));
if (request?.protocol !== "omg-agent/v1" || typeof request.requestId !== "string" || typeof request.prompt !== "string") {
  process.stderr.write(JSON.stringify({ error: "stub_request_invalid" }) + "\n"); process.exit(2);
}
let index = 0;
try { index = readFileSync(`${dir}/trace.jsonl`, "utf8").split("\n").filter(Boolean).length; } catch { /* first request */ }
appendFileSync(`${dir}/trace.jsonl`, JSON.stringify({ index, at: new Date().toISOString(), pid: process.pid,
  requestId: request.requestId, model: request.model, effort: request.effort, promptChars: request.prompt.length, request }) + "\n");

function hold(reason) {
  const path = `${dir}/hold-${index}.json`, pending = `${path}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify({ pid: process.pid, index, requestId: request.requestId, reason }));
  renameSync(pending, path);
  process.kill(process.pid, "SIGSTOP");
}
const control = JSON.parse(readFileSync(`${dir}/mode.json`, "utf8"));
if (control.mode === "hold") hold("mode");
else if (control.mode === "respond") {
  const rules = (await import(pathToFileURL(control.rules).href)).default;
  const answer = await rules(request, index);
  // A request the rules do not recognise is held, never answered: the driver sees the hold and stops the pass.
  if (answer.hold) hold(answer.hold);
  else process.stdout.write(JSON.stringify({ protocol: "omg-agent/v1", requestId: request.requestId, research: answer.research,
    usage: answer.usage ?? null, confirmed: { model: null, effort: null, speed: null } }) + "\n");
} else {
  process.stderr.write(JSON.stringify({ error: "stub_mode_unknown", mode: control.mode }) + "\n"); process.exit(2);
}

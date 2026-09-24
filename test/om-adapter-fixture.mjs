import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);

function requireFixture(condition, message) {
  if (!condition) throw new Error(message);
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const path = args[index + 1];
    requireFixture((flag === "--scenario" || flag === "--trace")
      && typeof path === "string" && path.length > 0 && !has(result, flag),
    "Expected --scenario <JSON path> --trace <JSONL path>");
    result[flag] = path;
  }
  requireFixture(has(result, "--scenario") && has(result, "--trace"),
    "Both --scenario and --trace are required");
  return result;
}

function replaceRequestId(value, requestId) {
  if (value === "$requestId") return requestId;
  if (Array.isArray(value)) return value.map(item => replaceRequestId(item, requestId));
  if (isObject(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, replaceRequestId(item, requestId)]));
  return value;
}

function traceLength(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter(line => line.length > 0).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function pauseFixture(path, body) {
  requireFixture(typeof path === "string" && path.length > 0, "A pause checkpoint needs its own file path");
  writeFileSync(path, JSON.stringify({ pid: process.pid, parent: process.ppid, ...body }));
  // Only the test-created fixture stops itself. The controlling test resumes or kills this exact PID.
  process.kill(process.pid, "SIGSTOP");
}

function atPath(value, path) {
  return path.reduce((item, key) => item !== null && typeof item === "object" ? item[key] : undefined, value);
}

async function driver(path) {
  const spec = JSON.parse(readFileSync(path, "utf8"));
  requireFixture(isObject(spec) && typeof spec.database === "string" && typeof spec.output === "string"
    && ["call", "transport", "recover"].includes(spec.operation), "A driver needs a database, operation, request and output path");
  const [{ Store }, model, { ProductEngine }] = await Promise.all([
    import("../dist/src/storage/store.js"), import("../dist/src/om/model-call.js"), import("../dist/src/product/engine.js"),
  ]);
  const store = new Store(spec.database);
  try {
    if (spec.checkpoint) {
      const writeMany = store.writeMany.bind(store); let stopped = false;
      store.writeMany = (writes, guards) => {
        const selected = !stopped && writes.some(write => write.kind === spec.checkpoint.kind
          && spec.checkpoint.matches.every(match => JSON.stringify(atPath(write.value, match.path)) === JSON.stringify(match.value)));
        if (selected && spec.checkpoint.when === "before") {
          stopped = true;
          pauseFixture(spec.checkpoint.path, { operation: spec.operation, writes });
        }
        const saved = writeMany(writes, guards);
        if (selected && spec.checkpoint.when !== "before") {
          stopped = true;
          pauseFixture(spec.checkpoint.path, { operation: spec.operation, records: saved.map(record => ({
            id: record.id, revision: record.revision, hash: record.hash, kind: record.kind,
          })) });
        }
        return saved;
      };
    }
    const result = spec.operation === "call" ? await model.runModelCall(store, spec.request)
      : spec.operation === "transport" ? await model.runModelTransport(store, spec.request)
      : await new ProductEngine(store).execute(spec.request);
    writeFileSync(spec.output, JSON.stringify({ result }));
  } catch (error) {
    writeFileSync(spec.output, JSON.stringify({ error: { code: error.code ?? null, message: error.message } }));
    process.exitCode = 3;
  } finally { store.close(); }
}

function main() {
  const paths = options(process.argv.slice(2));
  const request = JSON.parse(readFileSync(0, "utf8"));
  requireFixture(isObject(request) && request.protocol === "omg-agent/v1" && request.mode === "research"
    && typeof request.requestId === "string" && typeof request.prompt === "string"
    && typeof request.model === "string"
    && ["low", "medium", "high", "xhigh", "max", "ultra"].includes(request.effort),
  "Invalid omg-agent/v1 research request");

  const scenario = JSON.parse(readFileSync(paths["--scenario"], "utf8"));
  requireFixture(isObject(scenario) && Array.isArray(scenario.steps), "Scenario needs a steps array");
  const stepIndex = traceLength(paths["--trace"]);
  appendFileSync(paths["--trace"], `${JSON.stringify(request)}\n`);
  const step = scenario.steps[stepIndex];
  requireFixture(isObject(step), `Missing scenario step ${stepIndex}`);
  requireFixture(!has(step, "rawStdout") || typeof step.rawStdout === "string", "rawStdout must be a string");
  requireFixture(!has(step, "stderr") || typeof step.stderr === "string", "stderr must be a string");
  requireFixture(!has(step, "exitCode") || (Number.isInteger(step.exitCode) && step.exitCode >= 0 && step.exitCode <= 255),
    "exitCode must be an integer between 0 and 255");

  if (has(step, "pauseAfterRequest")) pauseFixture(step.pauseAfterRequest, { requestId: request.requestId });
  if (has(step, "stderr")) process.stderr.write(step.stderr);
  if (has(step, "rawStdout")) process.stdout.write(step.rawStdout);
  else process.stdout.write(`${JSON.stringify({
    protocol: "omg-agent/v1",
    requestId: request.requestId,
    research: replaceRequestId(step.research, request.requestId),
    usage: has(step, "usage") ? step.usage : null,
    confirmed: has(step, "confirmed") ? step.confirmed : { model: null, effort: null, speed: null },
  })}\n`);
  process.exitCode = step.exitCode ?? 0;
}

try {
  if (process.argv[2] === "--driver") {
    requireFixture(process.argv.length === 4, "Expected --driver <JSON path>");
    await driver(process.argv[3]);
  } else main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: "om_adapter_fixture_invalid", message: error.message })}\n`);
  process.exitCode = 2;
}

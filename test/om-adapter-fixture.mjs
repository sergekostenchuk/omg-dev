import { fileURLToPath } from 'node:url';
import { appendFileSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from 'node:module';

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

function requestForm(request) {
  if (request.prompt.startsWith("{")) return JSON.parse(request.prompt);
  const marker = "# Response form — machine section is one JSON line immediately after this header\n";
  const pieces = request.prompt.split(marker);
  requireFixture(pieces.length === 2, "A brief needs exactly one declared response section");
  const form = JSON.parse(pieces[1].split("\n")[0]);
  requireFixture(form.contract === "om-brief-response/v1" && form.responseForm?.requestId === request.requestId,
    "The response section must belong to this request");
  return form;
}

// Current scenario data is authored in native engine identities. Translate only declared
// answer address fields, and only for the explicitly requested current-protocol marker.
function currentLabels(value, request, enabled, labels) {
  if (!enabled) return value;
  const form = requestForm(request);
  if (form.contract !== "om-brief-response/v1") return value;
  const lookup = (item, domain) => (labels ?? form.labels).find(label => label.domain === domain
    && (isObject(item) && isObject(label.value)
      ? ["id", "revision", "hash"].every(key => label.value[key] === item[key]) : label.value === item))?.label ?? item;
  if (!isObject(value)) return value;
  if (Array.isArray(value.questionIds)) value.questionIds = value.questionIds.map(item => lookup(item, "question"));
  for (const result of Array.isArray(value.results) ? value.results : []) {
    if (!isObject(result)) continue;
    if (has(result, "questionId")) result.questionId = lookup(result.questionId, "question");
    if (has(result, "basis")) result.basis = lookup(result.basis, "gap");
    for (const citation of Array.isArray(result.citations) ? result.citations : []) if (isObject(citation)) citation.source = lookup(citation.source, "source");
  }
  for (const key of ["fills", "replaces"]) for (const fill of Array.isArray(value.proposal?.[key]) ? value.proposal[key] : []) {
    if (!isObject(fill)) continue;
    fill.obligation = lookup(fill.obligation, "slot");
    if (key === "replaces" && fill.base) fill.base.graph = lookup(fill.base.graph, "context");
  }
  for (const read of Array.isArray(value.reads) ? value.reads : []) {
    if (!isObject(read)) continue;
    if (read.action === "read_source") read.source = lookup(read.source, "source");
    if (read.action === "read_context") read.record = lookup(read.record, "context");
    if (read.action === "search" && isObject(read.within) && !has(read.within, "label")) {
      const label = lookup(read.within, "source"); if (typeof label === "string") read.within = { label };
    }
  }
  return value;
}

function replaceRequestMarkers(value, request) {
  if (value === "$requestId") return request.requestId;
  if (value === "$answerProtocol") {
    const protocol = requestForm(request).responseForm?.protocol;
    requireFixture(typeof protocol === "string" && protocol.trim().length > 0,
      "$answerProtocol requires responseForm.protocol in the received packet");
    return protocol;
  }
  if (Array.isArray(value)) return value.map(item => replaceRequestMarkers(item, request));
  if (isObject(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, replaceRequestMarkers(item, request)]));
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
  // №28: the checkpoint appears only complete. A watcher that sees the name reads the whole JSON, never a partial write.
  const pending = `${path}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify({ pid: process.pid, parent: process.ppid, ...body }));
  renameSync(pending, path);
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
    research: fixtureResearch(request, step.research, scenario.database),
    usage: has(step, "usage") ? step.usage : null,
    confirmed: has(step, "confirmed") ? step.confirmed : { model: null, effort: null, speed: null },
  })}\n`);
  process.exitCode = step.exitCode ?? 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  if (process.argv[2] === "--driver") {
    requireFixture(process.argv.length === 4, "Expected --driver <JSON path>");
    await driver(process.argv[3]);
  } else main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: "om_adapter_fixture_invalid", message: error.message })}\n`);
  process.exitCode = 2;
}

// Direct test builders use the same addressed transformation as current adapter scenarios.
export function fixtureResearch(request, answer, database) {
  const enabled = answer?.protocol === "$answerProtocol";
  let labels;
  // Native scenario answers use the exact issued map from their explicitly named fixture database.
  // Service identities stay out of the model prompt. This reader never creates or changes a database.
  if (enabled && database && requestForm(request).contract === 'om-brief-response/v1') {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const rows = db.prepare("SELECT body FROM revisions WHERE json_extract(body, '$.packet.requestId') = ?").all(request.requestId);
      const packets = rows.map(row => JSON.parse(row.body).packet).filter(packet => packet?.brief?.text === request.prompt);
      requireFixture(packets.length === 1, 'The fixture needs one exact saved packet matching the request and text');
      labels = packets[0].brief.labels;
    } finally { db.close(); }
  }
  return currentLabels(replaceRequestMarkers(answer, request), request, enabled, labels);
}

export function fixtureAnswer(packet, answer) {
  if (!packet?.brief || !['om-question-packet/brief-v1', 'om-question-packet/works-brief-v1'].includes(packet.version)) return answer;
  return currentLabels(structuredClone(answer), { requestId: packet.requestId, prompt: packet.brief.text }, true, packet.brief.labels);
}

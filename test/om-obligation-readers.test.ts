import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineError } from "../src/errors.js";
import { OM_OBLIGATION_CONTRACT, registerOmObligationReaders, readOmObligationHandoff, readOmObligationLedger,
  type OmObligationHandoff, type OmObligationHandoffReader, type OmObligationLedgerReader, type OmObligationLedger,
  type OmObligationReaders } from "../src/graph/om-obligation-readers.js";
import type { OmResult, Sealed } from "../src/om/refusal.js";
import type { Ref } from "../src/pipeline/contracts.js";
import { Store } from "../src/storage/store.js";

// This suite never imports src/om/obligations.js: in this process the real readers must stay uninstalled so the
// empty-slot and registration probes run against the slot itself. Every check that needs the real OM unit runs in a
// cold child process, where module order is exactly what the script imports. Under the revised contract a cold
// lower consumer with OM-era inputs answers om_obligation_reader_unavailable; the readers arrive through the
// product assembly point — product/engine imports om/obligations — never through a consumer-side import.

const SRC = `${pathToFileURL(fileURLToPath(new URL("../src/", import.meta.url))).href}/`;
const TST = `${pathToFileURL(fileURLToPath(new URL("./", import.meta.url))).href}/`;
const ADAPTER = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));

const ref = (id: string): Ref => ({ id, revision: 1, hash: "a".repeat(64) });

/** A cold script gets its configuration and its dist import roots through CONFIG; the last stdout line is JSON. */
const coldConfig = (root: string) => JSON.stringify({
  src: SRC, tst: TST, adapter: ADAPTER, root, database: join(root, "state.sqlite"), probe: join(root, "probe.sqlite"),
  pause: join(root, "first-step.pause.json"), scenario: join(root, "scenario.json"), trace: join(root, "trace.jsonl"),
  workspace: join(root, "repo"), project: "garden", saved: join(root, "saved.json") });
function coldScript(root: string, name: string, source: string): string {
  const script = join(root, `${name}.mjs`);
  writeFileSync(script, source.replace("CONFIG", coldConfig(root)));
  return script;
}
function runCold(script: string): unknown {
  return JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .trim().split("\n").at(-1)!) as unknown;
}
function cold(t: TestContext, name: string, source: string): () => unknown {
  const root = mkdtempSync(join(tmpdir(), `omg-r1-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return () => runCold(coldScript(root, name, source));
}
interface ColdResult { checks: { name: string; pass: boolean; detail: unknown }[] }
function coldChecks(result: unknown): void {
  const ran = result as ColdResult;
  assert.ok(Array.isArray(ran.checks), `The cold script must report its checks: ${JSON.stringify(result)}`);
  for (const check of ran.checks)
    assert.ok(check.pass, `${check.name}: ${JSON.stringify(check.detail)}`);
}

test("R1 empty slot: both reader paths refuse with the addressed om_obligation_reader_unavailable and write nothing", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-r1-empty-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const ledger = ref("om-obligations:garden:absent"), records = () => store.list().length, before = records();
  const unavailable = (target: string) => (error: unknown) => {
    assert.ok(error instanceof EngineError, "An empty slot throws an EngineError");
    assert.equal(error.code, "om_obligation_reader_unavailable");
    const details = error.details as { unit?: string; target?: string; project?: string; ledger?: Ref };
    assert.equal(details.unit, "graph"); assert.equal(details.target, target); assert.equal(details.project, "garden");
    return true;
  };
  assert.throws(() => readOmObligationHandoff(store, "garden", []), unavailable("readOmObligationHandoff"));
  assert.throws(() => readOmObligationLedger(store, { project: "garden", ledger }),
    (error: unknown) => unavailable("readOmObligationLedger")(error)
      && (error as EngineError).details !== null
      && (error as EngineError & { details: { ledger: Ref } }).details.ledger.id === ledger.id);
  assert.equal(records(), before, "An empty slot writes no records");
});

test("R1 registration: a complete pair installs once, is not invoked by registration, and delegates identical identity", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-r1-register-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const inputs = [ref("om-obligation-basis:garden:p")], ledgerRef = ref("om-obligations:garden:r");
  const handoffSentinel: OmResult<Sealed<OmObligationHandoff | null>> = { ok: true, value: null };
  const refusal = { code: "denied", message: "m", at: { unit: "u", target: "t" }, route: "owner" } as const;
  const ledgerSentinel: OmResult<Sealed<OmObligationLedger>> = { ok: true, value: {
    producer: { id: "om-obligation-basis:garden:p", kind: "om-obligation-basis", revision: 1, hash: "b".repeat(64),
      value: { contract: OM_OBLIGATION_CONTRACT, project: "garden", request: null, ledger: ledgerRef } },
    record: { id: ledgerRef.id, kind: "om-obligations", revision: 1, hash: "c".repeat(64),
      value: { contract: OM_OBLIGATION_CONTRACT, project: "garden", request: null, assignments: [] } },
    handoff: { era: OM_OBLIGATION_CONTRACT, producer: ref("om-obligation-basis:garden:p"), scope: ledgerRef, obligations: [] },
    inputs: [] } };

  // An incomplete pair is refused and never half-installed.
  for (const incomplete of [null, {}, { handoff: () => handoffSentinel }, { handoff: "x", ledger: () => ledgerSentinel }])
    assert.throws(() => registerOmObligationReaders(incomplete as OmObligationReaders),
      (error: unknown) => error instanceof EngineError && error.code === "om_obligation_reader_invalid");
  assert.throws(() => readOmObligationHandoff(store, "garden", inputs),
    (error: unknown) => error instanceof EngineError && error.code === "om_obligation_reader_unavailable",
    "A rejected pair must not be installed");

  const calls: unknown[][] = [];
  let handoffReply: OmResult<Sealed<null>> | typeof handoffSentinel = handoffSentinel;
  const handoff: OmObligationHandoffReader = (s, project, named) => { calls.push(["handoff", s, project, named]); return handoffReply; };
  const ledger: OmObligationLedgerReader = (s, request) => { calls.push(["ledger", s, request]); return ledgerSentinel; };
  const pair = { handoff, ledger };
  registerOmObligationReaders(pair);
  assert.equal(calls.length, 0, "Registration installs function references; it never calls them");

  assert.equal(readOmObligationHandoff(store, "garden", inputs), handoffSentinel, "The result object passes through unchanged");
  assert.deepEqual(calls[0], ["handoff", store, "garden", inputs]);
  assert.ok(calls[0]![1] === store && calls[0]![3] === inputs, "The identical Store and arguments are delegated");
  calls.length = 0;
  handoffReply = { ok: false, refusal } as OmResult<Sealed<null>>;
  assert.equal(readOmObligationHandoff(store, "garden", inputs), handoffReply, "A typed refusal passes through unchanged");
  assert.equal(readOmObligationLedger(store, { project: "garden", ledger: ledgerRef }), ledgerSentinel);
  assert.deepEqual(calls[1]![2], { project: "garden", ledger: ledgerRef });

  // Repeating the same pair — the same or another object with the same functions — is a no-op.
  registerOmObligationReaders(pair); registerOmObligationReaders({ handoff, ledger });

  // Mutating the object handed to registration cannot replace the installed references.
  pair.handoff = () => { throw new EngineError("replaced", "must never run"); };
  assert.equal(readOmObligationHandoff(store, "garden", inputs), handoffReply);

  // A different complete pair conflicts; the installed pair keeps serving.
  const other: OmObligationLedgerReader = (s, request) => ledger(s, request);
  assert.throws(() => registerOmObligationReaders({ handoff, ledger: other }),
    (error: unknown) => error instanceof EngineError && error.code === "om_obligation_reader_conflict");
  calls.length = 0;
  assert.equal(readOmObligationLedger(store, { project: "garden", ledger: ledgerRef }), ledgerSentinel);
  assert.equal(calls.length, 1, "The original pair is still installed after a conflict");
});

/** The D7 fixture of om-obligations.test.ts with one retained environment-confirmation obligation, ported for a cold
 * child: B1 -> horizon -> D1 -> D2 -> owner assignment with an explicit runtime check -> writeOmObligations. */
const BUILD = String.raw`
async function build(C) {
  const { Store } = await import(C.src + "storage/store.js");
  const { ProductEngine } = await import(C.src + "product/engine.js");
  const { reference } = await import(C.src + "pipeline/contracts.js");
  const { hashJson } = await import(C.src + "canonical.js");
  const { projectGraph } = await import(C.src + "graph/project.js");
  const { UPSTREAM_STAGES } = await import(C.src + "discovery/requirements.js");
  const { writeOmInput } = await import(C.src + "om/input.js");
  const { inputDecisionWrite, writeAddressing } = await import(C.src + "om/addressing.js");
  const { writeHorizon } = await import(C.src + "om/horizon.js");
  const { writeGaps } = await import(C.src + "om/gaps.js");
  const { writeGapLines } = await import(C.src + "om/gap-lines.js");
  const om = await import(C.src + "om/obligations.js");
  const { gardenGraph } = await import(C.tst + "om-fixture.js");
  const { preparedFeatures } = await import(C.tst + "product-fixture.js");
  const { preparedField } = await import(C.tst + "preparation-fixture.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ok = value => { if (!value.ok) throw new Error("Unexpected refusal " + value.refusal.code); return value.value; };
  const store = new Store(C.database), engine = new ProductEngine(store), project = C.project;
  const desired = gardenGraph();
  const { level: _level, ...projection } = projectGraph(desired, 1);
  preparedFeatures(engine, project, projection, field => {
    const value = preparedField(project, field);
    if (field === "preparation") value.unknowns = [{ id: "late-0", question: "Which environment-confirmation is required?",
      consumer: "garden-produce-block", moment: "task-start", blocksCurrentStage: false,
      resolution: "Address the retained question during OM" }];
    return value;
  });
  // The saved base also carries a configured environment and the declared runtime subject, so product entry
  // probes can execute the retained check for real through observe-runtime.
  mkdirSync(C.workspace, { recursive: true });
  writeFileSync(join(C.workspace, "garden-produce-block"), "declared runtime subject\n");
  const commandStub = { executable: process.execPath, args: ["--version"] };
  engine.execute({ type: "configure", project, expected: 0, environment: { workspace: C.workspace,
    implementer: { actor: "r1-implementer", model: "fixture", effort: "high", command: commandStub },
    reviewer: { actor: "r1-reviewer", model: "fixture-reviewer", effort: "medium", command: commandStub },
    fullCheck: commandStub, timeoutMs: 10000, requestCapacityChars: 100000 } });
  let input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get("stage:" + project + ":" + stage))])) }));
  const graph = store.get("graph:" + project), upper = store.get("graph-layer:" + project + ":2");
  input = ok(writeAddressing(store, { project, input: reference(input), graph: reference(graph),
    decisions: [{ pending: inputDecisionWrite({ project, input: reference(input), graph: reference(graph), layers: [],
      decision: { target: "discovery:late-0", field: "address",
        value: { consumer: "garden-produce-block", kind: "environment-confirmation" } } }) }] }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: "obligation-first-pass", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const gapSource = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(upper) } };
  const gaps = ok(writeGaps(store, gapSource));
  const gapRead = { sources: structuredClone(gaps.sources), records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const gap = gaps.records.find(row => row.value.gap.target === "discovery:late-0");
  if (!gap) throw new Error("The retained late-0 gap is missing");
  // An owner-document script has no code root, so the runtime check needs no file containment.
  const script = engine.discovery.evidence.document(project, "late-proof", "process.exit(0);\n", "text/plain", 0);
  const ownerValue = structuredClone(om.normalizeOwnerGapAssignment({ contract: om.OM_OWNER_ASSIGNMENT_CONTRACT, project,
    context: { gaps: gapRead, lines: reference(lines) }, gap: reference(gap),
    assignments: gap.value.gap.consumers.map(consumer => ({ responsibleNode: consumer, responsibleConsumer: consumer,
      reason: "The owner retains this condition for " + consumer, returnCondition: "Verify " + consumer + " readiness for late-0",
      wake: null })) }));
  ownerValue.assignments[0].runtimeCheck = { script: reference(script), dependencies: [], subjects: ["garden-produce-block"],
    executables: [process.execPath], args: [], timeoutMs: 1000, purpose: "Observe the declared repository prerequisite",
    satisfies: ownerValue.assignments[0].returnCondition };
  const normalized = om.normalizeOwnerGapAssignment(ownerValue);
  const request = { project, gaps: gapRead, lines: reference(lines), assignments: [{ pending:
    { id: "om-owner-gap-assignment:" + project + ":" + hashJson(normalized), kind: om.OM_OWNER_ASSIGNMENT_KIND,
      expected: 0, value: normalized } }] };
  const saved = ok(om.writeOmObligations(store, request));
  return { store, project, saved };
}
`;

/** The shared post-registration checks: the slot delegates, every changed consumer reads through it, a required but
 * missing ledger stays a typed refusal — never an empty result. */
const CHECKS = String.raw`
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const { canonical } = await import(C.src + "canonical.js");
  const { hashJson } = await import(C.src + "canonical.js");
  const { reference } = await import(C.src + "pipeline/contracts.js");
  const same = (left, right) => canonical(left) === canonical(right);
  const slot = await import(C.src + "graph/om-obligation-readers.js");
  const { obligationHandoff } = await import(C.src + "graph/obligation-handoff.js");
  const { omRuntimeAssignment, runtimeObligationId } = await import(C.src + "runtime/runtime-observation.js");
  const { projectRuntimeCandidate } = await import(C.src + "graph/runtime-evidence.js");
  const { runtimeSource } = await import(C.src + "runtime/runtime-observation-model.js");
  const { project, saved } = built;
  const store = built.store;
  const inputs = structuredClone(saved.inputs);

  const handed = slot.readOmObligationHandoff(store, project, inputs);
  check("handoff-delegates", handed.ok === true && same(handed.value, saved.handoff), handed.ok ? "ok" : handed.refusal.code);
  const ledger = slot.readOmObligationLedger(store, { project, ledger: reference(saved.record) });
  check("ledger-delegates", ledger.ok === true && same(ledger.value.handoff, saved.handoff), ledger.ok ? "ok" : ledger.refusal.code);

  // Consumer 1 — graph/obligation-handoff: a legacy-shaped call stays null, the OM call returns the exact handoff,
  // and a producer without its required ledger is a typed refusal, not an empty result.
  check("legacy-empty-handoff", obligationHandoff(store, project, []) === null);
  check("om-handoff-through-slot", same(obligationHandoff(store, project, inputs), saved.handoff));
  const withoutLedger = inputs.filter(item => !item.id.startsWith("om-obligations:"));
  try { obligationHandoff(store, project, withoutLedger); check("missing-ledger-refused", false, "no refusal"); }
  catch (error) { check("missing-ledger-refused", error.code === "obligation_ledger_missing", error.code); }
  const missing = slot.readOmObligationLedger(store, { project, ledger: { id: "om-obligations:" + project + ":absent",
    revision: 1, hash: "0".repeat(64) } });
  check("missing-ledger-record-refused", missing.ok === false && missing.refusal.code !== "om_obligation_reader_unavailable",
    missing.ok ? "a missing ledger answered ok" : missing.refusal.code);

  // Consumer 3 — runtime/runtime-observation: the assignment is read through the slot ledger.
  const obligation = saved.handoff.obligations[0];
  const scopeRef = reference(saved.record), id = runtimeObligationId(obligation);
  let declared = null, declaredError = null;
  try { declared = omRuntimeAssignment(store, project, scopeRef, id); } catch (error) { declaredError = error; }
  check("om-runtime-assignment", declared !== null && same(declared.assignment, obligation),
    declaredError ? declaredError.code : "returned");

  // Consumer 2 — graph/runtime-evidence: the projection reaches the ledger read, then stops at the absent environment
  // record — a typed lost basis, not an empty slot and not a silent exclusion.
  const envRef = { id: "environment:" + project + ":absent", revision: 1, hash: "0".repeat(64) };
  const observation = store.write({ id: "runtime-observation:" + hashJson([project, "r1"]), kind: "runtime-observation",
    expected: 0, value: { version: 1, projectId: project, key: "r1", scope: scopeRef, requestedFor: id,
      check: obligation.runtimeCheck, environment: envRef, context: [envRef], root: "/nonexistent", codeRoot: null,
      runtimeBinding: { fixture: true }, platform: { os: "x", release: "x", arch: "x", node: "x" },
      executable: { path: "/x", hash: "x", identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 } },
      subjects: [], snapshot: null, invocation: null, owner: { pid: 1, started: "s" }, child: null,
      startedAt: 1, finishedAt: 2, status: "observed", result: { exitCode: 0, signal: null, stdout: "", stderr: "" },
      error: null } });
  const generated = runtimeSource(observation);
  const source = store.write({ id: generated.id, kind: "source", expected: 0, value: generated.value });
  const projection = projectRuntimeCandidate(store, project, obligation, reference(source));
  check("runtime-evidence-ledger-read", projection.kind === "lost" && projection.reason === "environment-missing"
    && !String(projection.message).includes("om_obligation_reader_unavailable"), JSON.stringify(projection));
  return checks;
`;

const LOWER_FIRST = String.raw`
const C = CONFIG;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
try {
  // The lower slot module loads before everything else: both readers refuse the empty slot and write nothing.
  const slot = await import(C.src + "graph/om-obligation-readers.js");
  const { Store } = await import(C.src + "storage/store.js");
  const probe = new Store(C.probe);
  try { slot.readOmObligationHandoff(probe, C.project, []); check("pre-handoff-unavailable", false, "no throw"); }
  catch (error) { check("pre-handoff-unavailable", error.code === "om_obligation_reader_unavailable"
    && error.details && error.details.target === "readOmObligationHandoff" && error.details.project === C.project
    && probe.list().length === 0, error.code); }
  try { slot.readOmObligationLedger(probe, { project: C.project,
    ledger: { id: "om-obligations:garden:absent", revision: 1, hash: "0".repeat(64) } });
    check("pre-ledger-unavailable", false, "no throw"); }
  catch (error) { check("pre-ledger-unavailable", error.code === "om_obligation_reader_unavailable"
    && error.details && error.details.target === "readOmObligationLedger" && error.details.ledger
    && error.details.ledger.id === "om-obligations:garden:absent" && probe.list().length === 0, error.code); }
  // obligation-handoff loads no OM unit: inputs naming no OM era keep their previous null without touching the slot.
  const { obligationHandoff } = await import(C.src + "graph/obligation-handoff.js");
  check("pre-consumer-handoff", obligationHandoff(probe, C.project, []) === null && probe.list().length === 0,
    "a bare consumer must keep the legacy-null result");
  // R5 (№2451): the other two lower consumers no longer reach the OM unit through their own module tree — the slot stays
  // empty and each reader is the addressed refusal that writes nothing, until the OM unit itself loads below.
  await import(C.src + "runtime/runtime-observation.js");
  await import(C.src + "graph/runtime-evidence.js");
  try { slot.readOmObligationHandoff(probe, C.project, []); check("handoff-unavailable-after-lower-consumers", false, "no throw"); }
  catch (error) { check("handoff-unavailable-after-lower-consumers", error.code === "om_obligation_reader_unavailable"
    && error.details && error.details.target === "readOmObligationHandoff" && probe.list().length === 0, error.code); }
  try { slot.readOmObligationLedger(probe, { project: C.project, ledger: { id: "om-obligations:garden:absent", revision: 1, hash: "0".repeat(64) } });
    check("ledger-unavailable-after-lower-consumers", false, "no throw"); }
  catch (error) { check("ledger-unavailable-after-lower-consumers", error.code === "om_obligation_reader_unavailable"
    && error.details && error.details.target === "readOmObligationLedger" && error.details.ledger
    && error.details.ledger.id === "om-obligations:garden:absent" && probe.list().length === 0, error.code); }
  check("legacy-handoff-after-lower-consumers", obligationHandoff(probe, C.project, []) === null && probe.list().length === 0,
    "inputs naming no OM era keep their previous null");
  const built = await build(C);
  checks.push(...await runChecks(C, built));
} catch (error) { checks.push({ name: "cold-process", pass: false, detail: String(error && (error.code || error.message) || error) }); }
console.log(JSON.stringify({ checks }));
`;

const OM_FIRST = String.raw`
const C = CONFIG;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
try {
  // The OM unit loads first and installs its readers during module initialization; only then do the lower modules load.
  await import(C.src + "om/obligations.js");
  const slot = await import(C.src + "graph/om-obligation-readers.js");
  const { Store } = await import(C.src + "storage/store.js");
  const probe = new Store(C.probe);
  const handed = slot.readOmObligationHandoff(probe, C.project, []);
  check("delegates-on-empty-store", handed.ok === true && handed.value === null, handed.ok ? "ok" : handed.refusal.code);
  const built = await build(C);
  checks.push(...await runChecks(C, built));
} catch (error) { checks.push({ name: "cold-process", pass: false, detail: String(error && (error.code || error.message) || error) }); }
console.log(JSON.stringify({ checks }));
`;

/** The OM base for the direct-entry probe is saved by a separate builder process: the probe process only reads it,
 * so the ordering it exercises stays cold — the consumer module loads before the OM unit ever runs there. */
const BUILD_BASE = String.raw`
const C = CONFIG;
const built = await build(C);
const { writeFileSync } = await import("node:fs");
writeFileSync(C.saved, JSON.stringify(built.saved));
built.store.close();
`;

const DIRECT_HANDOFF = String.raw`
const C = CONFIG;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
try {
  // Cold direct entry: only the consumer, the slot module and Store load — no ProductEngine, no OM unit anywhere.
  const { obligationHandoff } = await import(C.src + "graph/obligation-handoff.js");
  const slot = await import(C.src + "graph/om-obligation-readers.js");
  const { Store } = await import(C.src + "storage/store.js");
  const { readFileSync } = await import("node:fs");
  const { canonical } = await import(C.src + "canonical.js");
  const same = (left, right) => canonical(left) === canonical(right);
  const saved = JSON.parse(readFileSync(C.saved, "utf8"));

  // The previous result: inputs naming no OM era answer null on an empty store, without the OM unit at all.
  const probe = new Store(C.probe);
  check("cold-empty-null", obligationHandoff(probe, C.project, []) === null && probe.list().length === 0,
    "a bare consumer must keep the legacy-null result");
  // The empty slot itself still refuses both readers with its addressed failure, writing nothing.
  try { slot.readOmObligationHandoff(probe, C.project, []); check("empty-slot-handoff", false, "no throw"); }
  catch (error) { check("empty-slot-handoff", error.code === "om_obligation_reader_unavailable", error.code); }
  try { slot.readOmObligationLedger(probe, { project: C.project,
    ledger: { id: "om-obligations:" + C.project + ":absent", revision: 1, hash: "0".repeat(64) } });
    check("empty-slot-ledger", false, "no throw"); }
  catch (error) { check("empty-slot-ledger", error.code === "om_obligation_reader_unavailable", error.code); }

  // The base was saved beforehand by another process; this one still has no OM unit loaded. Under the revised
  // contract a cold graph input carrying OM references is the typed unavailable refusal — never a silent null.
  const store = new Store(C.database);
  check("saved-base-no-om-null", obligationHandoff(store, C.project, []) === null,
    "inputs without OM era refs keep the null result on a real base");
  try { obligationHandoff(store, C.project, saved.inputs); check("om-era-without-unit", false, "no throw"); }
  catch (error) { check("om-era-without-unit", error.code === "om_obligation_reader_unavailable",
    error.code + ":" + JSON.stringify(error.details)); }

  // Variant A assembly: the reader pair arrives through the product entry point, not through an om/obligations
  // import here — this process still never loads the OM unit itself. The saved era then reads exactly as before.
  const { ProductEngine } = await import(C.src + "product/engine.js");
  const engine = new ProductEngine(store);
  check("engine-constructs", engine instanceof ProductEngine);
  check("om-handoff-pre-saved", same(obligationHandoff(store, C.project, saved.inputs), saved.handoff),
    "the pre-saved OM handoff must come back identical");
  try { obligationHandoff(store, C.project, saved.inputs.filter(item => !item.id.startsWith("om-obligations:")));
    check("missing-ledger", false, "no refusal"); }
  catch (error) { check("missing-ledger", error.code === "obligation_ledger_missing", error.code); }
  store.close(); probe.close();
} catch (error) { checks.push({ name: "cold-process", pass: false, detail: String(error && (error.code || error.message) || error) }); }
console.log(JSON.stringify({ checks }));
`;

const DIRECT_RUNTIME = String.raw`
const C = CONFIG;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
try {
  // A cold direct entry of runtime/runtime-observation, alone, with no other test warming the process.
  const { omRuntimeAssignment } = await import(C.src + "runtime/runtime-observation.js");
  const { Store } = await import(C.src + "storage/store.js");
  const probe = new Store(C.probe);
  // R5 (№2451): alone, its module tree no longer reaches the OM unit — the slot is empty, so a ledger read is the slot's
  // addressed unavailable refusal with the ledger it was asked for, never an empty result and never a write.
  try { omRuntimeAssignment(probe, C.project, { id: "om-obligations:garden:absent", revision: 1, hash: "0".repeat(64) }, "x");
    check("cold-missing-ledger", false, "no throw"); }
  catch (error) { check("cold-missing-ledger", error.code === "om_obligation_reader_unavailable"
    && error.details && error.details.target === "readOmObligationLedger" && error.details.ledger
    && error.details.ledger.id === "om-obligations:garden:absent" && probe.list().length === 0,
    error.code + ":" + JSON.stringify(error.details)); }
  const built = await build(C);
  const { project, saved } = built, store = built.store;
  // Once the registrant has loaded in this process, the absent ledger is again the reader's own record_missing inside
  // runtime_check_not_declared — the slot's unavailable refusal never stands in for it.
  try { omRuntimeAssignment(probe, C.project, { id: "om-obligations:garden:absent", revision: 1, hash: "0".repeat(64) }, "x");
    check("registered-missing-ledger", false, "no throw"); }
  catch (error) { check("registered-missing-ledger", error.code === "runtime_check_not_declared"
    && error.details && error.details.code === "record_missing", error.code + ":" + JSON.stringify(error.details)); }
  const { canonical } = await import(C.src + "canonical.js");
  const { reference } = await import(C.src + "pipeline/contracts.js");
  const { runtimeObligationId } = await import(C.src + "runtime/runtime-observation.js");
  const same = (left, right) => canonical(left) === canonical(right);
  const obligation = saved.handoff.obligations[0];
  const declared = omRuntimeAssignment(store, project, reference(saved.record), runtimeObligationId(obligation));
  check("direct-runtime-assignment", same(declared.assignment, obligation));
} catch (error) { checks.push({ name: "cold-process", pass: false, detail: String(error && (error.code || error.message) || error) }); }
console.log(JSON.stringify({ checks }));
`;

const OM_START = String.raw`
const C = CONFIG;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
try {
  const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { Store } = await import(C.src + "storage/store.js");
  const { ProductEngine } = await import(C.src + "product/engine.js");
  const { preparedFeatures } = await import(C.tst + "product-fixture.js");
  const { gardenGraph } = await import(C.tst + "om-fixture.js");
  // The cold public entry is a real ProductEngine over a temporary copy: repository, prepared stages and layers.
  mkdirSync(C.workspace);
  const git = args => execFileSync("git", args, { cwd: C.workspace });
  git(["init", "-b", "main"]); writeFileSync(join(C.workspace, "README.md"), "R1 cold start\n");
  git(["add", "README.md"]); git(["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(C.database), engine = new ProductEngine(store), project = C.project;
  preparedFeatures(engine, project, gardenGraph());
  const command = { executable: process.execPath, args: [C.adapter, "--scenario", C.scenario, "--trace", C.trace] };
  engine.execute({ type: "configure", project, expected: 0, environment: { workspace: C.workspace,
    implementer: { actor: "r1-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "r1-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10000, requestCapacityChars: 100000 } });
  engine.execute({ type: "configure-om-dispatch", project, protocol: "codex-stdio" });
  // The stub adapter pauses while holding the pass's first request: the drive is exercised up to its first intended step.
  writeFileSync(C.scenario, JSON.stringify({ steps: [{ research: { held: true }, pauseAfterRequest: C.pause }] }));
  const driving = engine.execute({ type: "om-start", project });
  const deadline = Date.now() + 120000;
  while (!existsSync(C.pause)) {
    if (Date.now() > deadline) throw new Error("The first pass step never reached the stub adapter");
    await delay(50);
  }
  const paused = JSON.parse(readFileSync(C.pause, "utf8"));
  check("first-step-reached", typeof paused.pid === "number" && paused.pid > 0, paused);
  try { process.kill(paused.pid, "SIGKILL"); } catch {}
  const outcome = await driving;
  const text = JSON.stringify(outcome);
  check("om-start-no-tdz", !text.includes("om_obligation_reader_unavailable") && !text.includes("Cannot access")
    && !text.includes("ReferenceError") && !text.includes("is not defined"), text.slice(0, 400));
  check("om-input-written", store.get("om-input:" + project) !== null, "The cold start wrote the first B1");
  store.close();
} catch (error) { checks.push({ name: "cold-process", pass: false, detail: String(error && (error.code || error.message) || error) }); }
console.log(JSON.stringify({ checks }));
`;

test("R1 cold lower-first: the slot and consumers load before the OM unit, registration happens when it loads", t => {
  coldChecks(cold(t, "lower-first", `${BUILD}\nasync function runChecks(C, built) {${CHECKS}}\n${LOWER_FIRST}`)());
});

test("R1 cold om-first: the OM unit registers its readers during initialization before the consumers load", t => {
  coldChecks(cold(t, "om-first", `${BUILD}\nasync function runChecks(C, built) {${CHECKS}}\n${OM_FIRST}`)());
});

test("R1 cold direct obligationHandoff: bare inputs keep null, OM inputs wait for the assembly point", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-r1-direct-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A separate builder process saves the OM base; the probe process below never runs the builder's modules.
  execFileSync(process.execPath, [coldScript(root, "build-base", `${BUILD}\n${BUILD_BASE}`)], { encoding: "utf8" });
  coldChecks(runCold(coldScript(root, "probe", DIRECT_HANDOFF)));
});

test("R1 cold direct omRuntimeAssignment: no ProductEngine and no other test warms the registration", t => {
  coldChecks(cold(t, "direct-runtime", `${BUILD}\n${DIRECT_RUNTIME}`)());
});

test("R1 cold om-start: a public pass on a temporary copy reaches its first step without TDZ or an unavailable reader", t => {
  coldChecks(cold(t, "om-start", OM_START)());
});

/** Variant A assembly: every real product entry constructs a ProductEngine, and the engine module itself imports
 * om/obligations, so the reader pair exists before the first relevant read. The base — including the configured
 * environment and the declared runtime subject — was saved by a separate cold builder; each entry below performs
 * real reads of the saved OM records, never just a module load. */
const PRODUCT_ENTRIES = String.raw`
const C = CONFIG;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
const raw = [];
const clean = text => { raw.push(String(text)); return true; };
try {
  const { readFileSync } = await import("node:fs");
  const { canonical } = await import(C.src + "canonical.js");
  const { Store } = await import(C.src + "storage/store.js");
  const slot = await import(C.src + "graph/om-obligation-readers.js");
  const { obligationHandoff } = await import(C.src + "graph/obligation-handoff.js");
  const same = (left, right) => canonical(left) === canonical(right);
  const saved = JSON.parse(readFileSync(C.saved, "utf8"));
  const store = new Store(C.database);

  // Before the assembly point: OM-era inputs are the addressed unavailable refusal, bare inputs keep legacy null.
  check("pre-assembly-legacy-null", obligationHandoff(store, C.project, []) === null, "no-OM inputs keep null");
  try { obligationHandoff(store, C.project, saved.inputs); check("pre-assembly-unavailable", false, "no throw"); }
  catch (error) { check("pre-assembly-unavailable", error.code === "om_obligation_reader_unavailable", error.code); }

  // Cold ProductEngine: its module import installs the pair; this process never imports om/obligations itself.
  const { ProductEngine } = await import(C.src + "product/engine.js");
  const engine = new ProductEngine(store);
  check("engine-handoff-pre-saved", same(obligationHandoff(store, C.project, saved.inputs), saved.handoff),
    "the saved OM handoff reads through the installed pair");
  // A required ledger that never existed is still the prior addressed refusal; a foreign ledger reference is the
  // reader's own record_missing — neither is an empty result and neither is the slot's unavailable failure.
  const withoutLedger = saved.inputs.filter(item => !item.id.startsWith("om-obligations:"));
  try { obligationHandoff(store, C.project, withoutLedger); check("engine-missing-ledger", false, "no refusal"); }
  catch (error) { check("engine-missing-ledger", error.code === "obligation_ledger_missing"
    && error.details && error.details.target === saved.producer.id && error.details.field === "ledger",
    error.code + ":" + JSON.stringify(error.details)); }
  const missing = slot.readOmObligationLedger(store, { project: C.project,
    ledger: { id: "om-obligations:" + C.project + ":absent", revision: 1, hash: "0".repeat(64) } });
  check("engine-foreign-ledger", missing.ok === false && missing.refusal.code === "record_missing"
    && missing.refusal.at.target === "om-obligations:" + C.project + ":absent",
    missing.ok ? "answered ok" : JSON.stringify(missing.refusal));
  const { runtimeObligationId } = await import(C.src + "runtime/runtime-observation.js");
  const request = { type: "observe-runtime", project: C.project,
    scope: { id: saved.record.id, revision: saved.record.revision, hash: saved.record.hash },
    obligation: runtimeObligationId(saved.handoff.obligations[0]) };
  const observed = await engine.execute({ ...request, key: "r1-engine-entry" });
  check("engine-observe-runtime", clean(observed) && observed.observation
    && observed.observation.value.status === "observed", JSON.stringify(observed).slice(0, 300));

  // CLI command: a fresh process creates its own ProductEngine and reads the JSON command from stdin.
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cliOut = execFileSync(process.execPath, [fileURLToPath(C.src + "cli.js"), "command", C.database],
    { input: JSON.stringify({ ...request, key: "r1-cli-entry" }), encoding: "utf8" });
  const cliResult = JSON.parse(clean(cliOut) && cliOut.trim().split("\n").at(-1));
  check("cli-observe-runtime", cliResult.observation && cliResult.observation.value.status === "observed",
    cliOut.slice(0, 300));

  // The server wraps a real ProductEngine; an actual local request performs the OM read through the same path.
  const { createProductServer } = await import(C.src + "server.js");
  const server = createProductServer(engine);
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = server.address().port;
    const response = await fetch("http://127.0.0.1:" + port + "/api/command", { method: "POST",
      headers: { "content-type": "application/json", "x-omg-token": server.accessToken },
      body: JSON.stringify({ ...request, key: "r1-server-entry" }) });
    const text = await response.text(); clean(text); const body = JSON.parse(text);
    check("server-observe-runtime", response.status === 200 && body.observation
      && body.observation.value.status === "observed", response.status + ":" + text.slice(0, 300));
  } finally { await new Promise(done => server.close(done)); }

  // No normal product entry may surface the slot refusal or a module-ordering failure.
  check("entries-clean", raw.every(text => !text.includes("om_obligation_reader_unavailable")
    && !text.includes("Cannot access") && !text.includes("ReferenceError") && !text.includes("is not defined")),
    raw.map(text => text.slice(0, 120)).join(" | "));
  store.close();
} catch (error) { checks.push({ name: "product-entries", pass: false, detail: String(error && (error.code || error.message) || error) }); }
console.log(JSON.stringify({ checks }));
`;

test("R1 product entries: ProductEngine, CLI command and server read the saved OM base through the installed pair", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-r1-entries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [coldScript(root, "entries-base", `${BUILD}\n${BUILD_BASE}`)], { encoding: "utf8" });
  coldChecks(runCold(coldScript(root, "entries", PRODUCT_ENTRIES)));
});

/** R2 (№2419-6): the server entry first. In a fresh process server.js is the first product module loaded — before the
 * engine, the storage helper or any OM module — and a real request performs the OM read through the installed pair;
 * the removed transitive OM → engine imports must not leave the slot empty or a module in its TDZ. */
const SERVER_FIRST = String.raw`
const C = CONFIG;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
try {
  const { createProductServer } = await import(C.src + "server.js");
  const { readFileSync } = await import("node:fs");
  const { Store } = await import(C.src + "storage/store.js");
  const { ProductEngine } = await import(C.src + "product/engine.js");
  const { runtimeObligationId } = await import(C.src + "runtime/runtime-observation.js");
  const saved = JSON.parse(readFileSync(C.saved, "utf8"));
  const store = new Store(C.database);
  const server = createProductServer(new ProductEngine(store));
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  try {
    const request = { type: "observe-runtime", project: C.project,
      scope: { id: saved.record.id, revision: saved.record.revision, hash: saved.record.hash },
      obligation: runtimeObligationId(saved.handoff.obligations[0]), key: "r2-server-first" };
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/command", { method: "POST",
      headers: { "content-type": "application/json", "x-omg-token": server.accessToken }, body: JSON.stringify(request) });
    const text = await response.text(), body = JSON.parse(text);
    check("server-first-observe-runtime", response.status === 200 && body.observation && body.observation.value.status === "observed",
      response.status + ":" + text.slice(0, 300));
    check("server-first-clean", !text.includes("om_obligation_reader_unavailable") && !text.includes("Cannot access")
      && !text.includes("ReferenceError") && !text.includes("is not defined"), text.slice(0, 200));
  } finally { await new Promise(done => server.close(done)); store.close(); }
} catch (error) { checks.push({ name: "server-first", pass: false, detail: String(error && (error.code || error.message) || error) }); }
console.log(JSON.stringify({ checks }));
`;

test("R2 cold server-first: with no OM module importing the engine, the server entry loaded first reads the saved OM base through the installed pair", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-r2-server-first-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [coldScript(root, "server-first-base", `${BUILD}\n${BUILD_BASE}`)], { encoding: "utf8" });
  coldChecks(runCold(coldScript(root, "server-first", SERVER_FIRST)));
});

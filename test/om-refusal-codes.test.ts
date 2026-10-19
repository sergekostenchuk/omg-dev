import test, { type TestContext } from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { ProcessResult } from "../src/runtime/process.js";
import {
  REFUSAL_ROUTES, delivered, localErrors, localRefusals, refused, sealed, transfer, transferError, transferring,
  type OmResult, type Refusal, type RefusalAddress, type Sealed, type SourceCode,
} from "../src/om/refusal.js";
import { REFS_REFUSAL_CODES, writeGuarded } from "../src/om/refs.js";
import {
  INPUT_ERROR_CODES, INPUT_LOCAL_CODES, INPUT_REFUSAL_CODES, buildOmInput, prepareOmInput, readOmAdmissionGuards, readOmInput, writeOmInput,
  type BuiltOmInput, type InputCode, type InputLocalCode, type InputRefusalCode, type InputRequest, type InputResult,
} from "../src/om/input.js";
import {
  HORIZON_ERROR_CODES, HORIZON_ISSUANCE_CODES, HORIZON_ISSUANCE_KIND, HORIZON_LOCAL_CODES, HORIZON_REFUSAL_CODES,
  closeHorizon, readHorizonIssuance, type HorizonCode, type HorizonLocalCode, type HorizonOptions, type HorizonResult,
} from "../src/om/horizon.js";
import {
  MODEL_CALL_CODES, MODEL_CALL_ERROR_CODES, MODEL_CALL_LOCAL_CODES, TRANSPORT_ERROR_CODES, readAdapterResponse,
  type AdapterResult, type ModelCallCode, type ModelCallLocalCode, type ModelCallResult,
} from "../src/om/model-call.js";
import { createOmFixture, gardenGraph } from "./om-fixture.js";
import {
  ASSESSMENT_ERROR_CODES, ASSESSMENT_LOCAL_CODES, type AssessmentCode, type AssessmentLocalCode, type AssessmentResult,
} from "../src/om/assessment.js";
import {
  ATOMIC_GATE_ERROR_CODES, ATOMIC_GATE_LOCAL_CODES, type AtomicGateCode, type AtomicGateLocalCode, type AtomicGateResult,
} from "../src/om/atomic-gate.js";
import {
  FEASIBILITY_ERROR_CODES, FEASIBILITY_LOCAL_CODES, prepareFeasibility, writeFeasibility, type FeasibilityCode, type FeasibilityLocalCode,
  type FeasibilityRequest, type FeasibilityResult, type PreparedFeasibility,
} from "../src/om/feasibility.js";
import {
  HANDOFF_ERROR_CODES, HANDOFF_LOCAL_CODES, prepareHandoff, type HandoffCode, type HandoffLocalCode, type HandoffResult,
} from "../src/om/handoff.js";
import {
  SERIES_TRANSITION_ERROR_CODES, SERIES_TRANSITION_LOCAL_CODES, type SeriesTransitionCode, type SeriesTransitionLocalCode,
  type SeriesTransitionResult,
} from "../src/om/series-transition.js";
import {
  SERIES_CODES, SERIES_ERROR_CODES, SERIES_LOCAL_CODES, type SeriesLocalCode, type SeriesResult, type SeriesResultCode,
} from "../src/om/series.js";
import { RUN_CODES, RUN_ERROR_CODES, RUN_LOCAL_CODES, type RunLocalCode, type RunResult, type RunResultCode } from "../src/om/run.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { configureReaderPilot } from "../src/discovery/reader-pilot.js";
import { Environments } from "../src/runtime/environment.js";
import type { Store } from "../src/storage/store.js";

// Q2 (№2452, №2460): the codes of a module's refusals as types. The negative probes below are real TypeScript: each
// `@ts-expect-error` line fails to compile for the stated reason and nothing else on that line can fail, so an unused
// directive breaks the build (tsc over test/**). The runtime assertions pin what the typed constructors and transfers
// produce — the same bytes the re-addressed results carried before Q2.
const AT: RefusalAddress = { unit: "T", target: "probe" };
const asInput = <T>(result: InputResult<T>): InputResult<T> => result;
const asHorizon = <T>(result: HorizonResult<T>): HorizonResult<T> => result;
const asModelCall = <T>(result: ModelCallResult<T>): ModelCallResult<T> => result;
const asRefs = (refusal: Refusal<SourceCode<"refs">>): Refusal<SourceCode<"refs">> => refusal;
const asTransport = (result: AdapterResult): AdapterResult => result;
const asText = (value: string): string => value;
const has = (codes: readonly string[], code: string): boolean => codes.includes(code);
const sorted = (codes: readonly string[]): string[] => [...codes].sort();

function failed(result: OmResult<unknown, string>): Refusal<string> {
  if (result.ok) assert.fail("Expected a refusal");
  return result.refusal;
}
function deeplyFrozen(value: unknown): boolean {
  return value === null || typeof value !== "object"
    || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
}

test("Q2 catalogues: the subsets older tests pin, the full local sets, the transport and the exception sets apart", () => {
  for (const catalogue of [INPUT_REFUSAL_CODES, INPUT_LOCAL_CODES, INPUT_ERROR_CODES, HORIZON_REFUSAL_CODES,
    HORIZON_ISSUANCE_CODES, HORIZON_LOCAL_CODES, HORIZON_ERROR_CODES, MODEL_CALL_CODES, MODEL_CALL_LOCAL_CODES,
    MODEL_CALL_ERROR_CODES, TRANSPORT_ERROR_CODES]) {
    assert.ok(Object.isFrozen(catalogue));
    assert.equal(new Set(catalogue).size, catalogue.length, "A catalogue names each code once");
    assert.ok(catalogue.every(code => typeof code === "string" && code.length > 0));
  }
  // input.ts: the builder/gate subset (om-input.test.ts pins it) inside the full set of locally created codes.
  assert.ok(INPUT_REFUSAL_CODES.every(code => has(INPUT_LOCAL_CODES, code)));
  assert.deepEqual(sorted(INPUT_LOCAL_CODES), sorted([...INPUT_REFUSAL_CODES, "om_admission_guard_invalid",
    "om_admission_guard_unsupported", "input_stale", "legacy_operation_active", "record_forged", "answer_inapplicable",
    "addressing_conflict", "input_refresh_conflict"]));
  assert.deepEqual([...INPUT_ERROR_CODES], ["input_request_invalid", "om_admission_guard_invalid", "stage_not_accepted", "input_stale"]);
  // horizon.ts: the gate subset and the issuance set (om-horizon.test.ts pins them) inside the full local set.
  assert.ok(HORIZON_REFUSAL_CODES.every(code => has(HORIZON_LOCAL_CODES, code)));
  assert.ok(HORIZON_ISSUANCE_CODES.every(code => has(HORIZON_LOCAL_CODES, code)));
  assert.deepEqual(sorted(HORIZON_LOCAL_CODES), sorted([...HORIZON_REFUSAL_CODES, ...HORIZON_ISSUANCE_CODES,
    "horizon_choice_conflict", "input_stale", "record_forged"]));
  assert.deepEqual([...HORIZON_ERROR_CODES], ["horizon_request_invalid", "input_stale"]);
  // model-call.ts: MODEL_CALL_CODES stays exported and exact (№2460-7); each of its codes is either a local refusal
  // code or a transport code, never both; the transport set is data of AdapterResult, outside the refusal catalogue.
  assert.deepEqual([...MODEL_CALL_CODES], ["model_call_request_invalid", "model_adapter_response_invalid",
    "model_adapter_interrupted", "model_delivery_invalid", "model_read_unavailable", "model_parts_invalid",
    "model_parts_conflict", "model_call_record_invalid", "model_call_identity_conflict", "model_call_in_progress",
    "model_call_application_pending"]);
  for (const code of MODEL_CALL_CODES) assert.notEqual(has(MODEL_CALL_LOCAL_CODES, code), has(TRANSPORT_ERROR_CODES, code), code);
  assert.deepEqual([...TRANSPORT_ERROR_CODES], ["model_adapter_interrupted", "model_adapter_response_invalid", "process_lost"]);
  assert.ok(TRANSPORT_ERROR_CODES.every(code => !has(MODEL_CALL_LOCAL_CODES, code)));
  assert.deepEqual(sorted(MODEL_CALL_LOCAL_CODES), sorted(["model_call_request_invalid", "model_call_record_invalid",
    "model_call_identity_conflict", "model_call_in_progress", "model_call_application_pending", "model_call_foreign",
    "model_call_not_running", "model_delivery_invalid", "model_read_unavailable", "model_parts_invalid",
    "model_parts_conflict", "packet_invalid", "packet_attempt_invalid", "dispatch_contract_invalid", "ledger_invalid",
    "input_stale", "assessment_source_invalid", "completion_invalid", "completion_foreign", "completion_closed",
    "completion_conflict", "completion_ceased", "completion_claim_exists", "completion_resolved",
    "completion_cause_invalid", "completion_cause_unproved"]));
  assert.deepEqual([...MODEL_CALL_ERROR_CODES], ["model_call_request_invalid", "research_dispatch_invalid"]);
});

test("Q2 local constructor: a module's catalogue is the bound at compile time and at runtime", () => {
  const refuse = localRefusals(INPUT_LOCAL_CODES);
  const ref = { id: "om-input:garden", revision: 1, hash: hashJson({ probe: true }) };
  const result = refuse("input_stale", "A probe refusal", { ...AT, ref }, "producer");
  assert.equal(result.ok, false);
  const refusal = failed(result);
  assert.deepEqual(refusal, { code: "input_stale", message: "A probe refusal", at: { unit: "T", target: "probe", ref }, route: "producer" });
  assert.notEqual(refusal.at.ref, ref, "The reference is copied, never shared with the caller");
  assert.deepEqual(Object.keys(result), ["ok", "refusal"]);
  assert.deepEqual(Object.keys(refusal), ["code", "message", "at", "route"]);
  assert.ok(deeplyFrozen(result));
  // A literal two modules share is each module's own: three catalogues, three constructors (№2460-1).
  assert.equal(failed(localRefusals(HORIZON_LOCAL_CODES)("input_stale", "probe", AT, "owner")).route, "owner");
  assert.equal(failed(localRefusals(MODEL_CALL_LOCAL_CODES)("input_stale", "probe", AT, "producer")).code, "input_stale");
  assert.throws(() => refuse(
    // @ts-expect-error an unknown literal is no code of input (№2452-2)
    "input_unknown_probe", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => refuse(
    // @ts-expect-error another module's code is no code of input (№2452-2)
    "horizon_unclosed", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(HORIZON_LOCAL_CODES)(
    // @ts-expect-error a code of model-call is no code of horizon (№2452-2)
    "model_call_record_invalid", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(MODEL_CALL_LOCAL_CODES)(
    // @ts-expect-error a transport code is data of AdapterResult, no local refusal of model-call (№2460-7)
    "model_adapter_interrupted", "probe", AT, "producer"), { code: "refusal_invalid" });
  const plain: string = "input_stale";
  // @ts-expect-error a plain string is no code of input, whatever it holds at runtime (№2452-2)
  assert.equal(failed(refuse(plain, "probe", AT, "producer")).code, "input_stale");
  assert.throws(() => localRefusals([]), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(["input_stale", ""]), { code: "refusal_invalid" });
  // The exceptions have their own catalogue; the global EngineError is what comes out of it (№2452-3).
  const raise = localErrors(INPUT_ERROR_CODES);
  assert.throws(() => raise("input_request_invalid", "A probe exception", { field: "probe" }), (error: unknown) =>
    error instanceof EngineError && error.code === "input_request_invalid" && error.message === "A probe exception"
    && JSON.stringify(error.details) === JSON.stringify({ field: "probe" }));
  assert.throws(() => raise(
    // @ts-expect-error another module's exception code is no exception of input (№2452-3)
    "horizon_request_invalid", "probe"), { code: "refusal_invalid" });
  assert.throws(() => localErrors(MODEL_CALL_ERROR_CODES)("research_dispatch_invalid", "Invalid project dispatch counter"),
    { code: "research_dispatch_invalid" });
});

test("Q2 transfer: the source's whole refusal, the same object, the mark in the type alone", () => {
  const wide: OmResult<number> = refused("record_missing", "The source refused", AT, "producer");
  const moved = transfer("refs", wide);
  assert.equal(moved, wide, "A transfer hands over the result itself");
  if (moved.ok) assert.fail("A refusal was transferred");
  assert.deepEqual(Object.keys(moved.refusal), ["code", "message", "at", "route"]);
  assert.equal(Object.getOwnPropertySymbols(moved.refusal).length, 0, "The mark is no field of the refusal");
  assert.equal(JSON.stringify(moved), JSON.stringify(wide));
  assert.equal(typeof moved.refusal.code, "string");
  // Declared sources compile, nested transfers keep every mark; anything else does not compile (№2452-3).
  assert.equal(asInput(transfer("refs", wide)).ok, false);
  assert.equal(asInput(transfer("accepted-answer", wide)).ok, false);
  assert.equal(asHorizon(transfer("input", transfer("refs", wide))).ok, false);
  assert.equal(asModelCall(transfer("series", wide)).ok, false);
  // @ts-expect-error a result with a plain-string code enters input only through a transfer (№2452-3)
  asInput(wide);
  // @ts-expect-error series-transition is a source of horizon, not of input (№2452-3)
  asInput(transfer("series-transition", wide));
  // @ts-expect-error accepted-answer is a source of input, not of horizon (№2452-3)
  asHorizon(transfer("accepted-answer", wide));
  // @ts-expect-error the old wide result is no result of model-call without a transfer (№2452-3)
  asModelCall(wide);
  // The mark survives an identical pass-through and dies with a code copied into a plain string (№2452-4).
  assert.equal(asRefs({ ...moved.refusal }).code, "record_missing");
  // @ts-expect-error a code copied into a plain string loses the mark, however equal its bytes (№2452-4)
  asRefs({ ...moved.refusal, code: "record_missing" });
  // @ts-expect-error the refusal of a wide result carries no mark (№2452-4)
  asRefs(failed(wide));
  // A reader bound at the import boundary: its delivered values pass unchanged, its refusals carry the mark.
  const reader = (code: string): OmResult<number> => code === "ok" ? delivered(1) : refused(code, "The reader refused", AT, "producer");
  const bound = transferring("refs", reader);
  assert.deepEqual(bound("ok"), { ok: true, value: 1 });
  assert.equal(asInput(bound("record_missing")).ok, false);
  assert.equal(failed(bound("record_missing")).code, "record_missing");
  // @ts-expect-error the reader's own result stays wide: only the bound reader hands input a marked refusal (№2452-3)
  asInput(reader("record_missing"));
  // At runtime a transfer carries a whole result of a named source or nothing.
  assert.throws(() => transfer("refs", { refusal: failed(wide) } as unknown as OmResult<number>), { code: "refusal_invalid" });
  assert.throws(() => transfer("", wide), { code: "refusal_invalid" });
  assert.throws(() => transferring("refs", null as unknown as () => OmResult<number>), { code: "refusal_invalid" });
  // Sealed keeps a marked code a string: the historical arm of AdapterResult reaches its readers through Sealed values.
  const historical: Sealed<SourceCode<"exchange">> = "spawn_failed" as SourceCode<"exchange">;
  assert.equal(asText(historical), "spawn_failed");
});

test("Q2 input: re-addressed results keep their exact prior code, message, address and route", async t => {
  const guarded = readOmAdmissionGuards([{ bogus: true }], "features", "G1");
  const refusal = failed(guarded);
  assert.equal(refusal.code, "om_admission_guard_invalid");
  assert.ok(refusal.message.startsWith("features: "), refusal.message);
  assert.deepEqual(refusal.at, { unit: "G1", target: "features", field: "admissionGuards" });
  assert.equal(refusal.route, "producer");
  assert.ok(deeplyFrozen(guarded));
  assert.throws(() => readOmAdmissionGuards(undefined, "", "G1"), (error: unknown) => error instanceof EngineError
    && error.code === "om_admission_guard_invalid"
    && JSON.stringify(error.details) === JSON.stringify({ unit: "OM", target: "admissionGuards", field: "gate" }));
  // A refusal of refs comes through readOmInput whole: refs' own code, at the caller's unit and target (№2460-3).
  const f = await createOmFixture(t, "standard", "garden", { mode: "stages" });
  const missing = readOmInput(f.store, f.project, { id: `om-input:${f.project}`, revision: 7, hash: hashJson({ probe: true }) });
  const transferred = failed(missing);
  assert.ok(has(REFS_REFUSAL_CODES, transferred.code), transferred.code);
  assert.equal(transferred.at.unit, "G1");
  assert.equal(transferred.at.target, `om-input:${f.project}`);
  assert.deepEqual(Object.keys(transferred), ["code", "message", "at", "route"]);
  assert.ok(has(REFUSAL_ROUTES, transferred.route));
  assert.ok(deeplyFrozen(missing));
});

test("Q2 horizon: the closing gate's default route, an explicit route, and the saved issuance reading", async t => {
  const { level: _level, ...upper } = projectGraph(gardenGraph(), 1);
  const graph = upper as Graph;
  const options = (over: Partial<HorizonOptions> = {}): HorizonOptions => ({ choiceVersion: "choice-1",
    features: [{ outcome: "garden-result" }], excluded: [], refined: [], available: {}, ...over });
  // closeHorizon's fail defaults to the owner (№2460-2) …
  const empty = closeHorizon(graph, options({ features: [] }));
  const emptyRefusal = empty.refusals.find(item => item.code === "horizon_empty");
  assert.ok(emptyRefusal);
  assert.equal(emptyRefusal.route, "owner");
  assert.equal(emptyRefusal.message, "The selected horizon is empty");
  assert.deepEqual({ target: emptyRefusal.at.target, field: emptyRefusal.at.field }, { target: "horizon", field: "nodes" });
  // … and names the producer where it did before.
  const refined = closeHorizon(graph, options({ refined: ["unknown-block"] }));
  const unproven = refined.refusals.find(item => item.code === "horizon_refinement_unproven");
  assert.ok(unproven);
  assert.equal(unproven.route, "producer");
  assert.equal(unproven.message, "Refinement must identify an upper-layer block");
  assert.deepEqual({ target: unproven.at.target, field: unproven.at.field }, { target: "unknown-block", field: "refined" });
  for (const item of [...empty.refusals, ...refined.refusals]) {
    assert.ok(has(HORIZON_REFUSAL_CODES, item.code));
    assert.ok(has(REFUSAL_ROUTES, item.route));
  }
  // The saved issuance reading: a malformed record is horizon_issuance_record_invalid at its first absent field
  // (the record's own bad(field), №2460-5 correction), never horizon_issuance_request_invalid.
  const f = await createOmFixture(t, "standard", "garden", { mode: "stages" });
  const id = `${HORIZON_ISSUANCE_KIND}:${f.project}:probe`;
  const written = writeGuarded(f.store, { unit: "G2", target: id,
    writes: [{ id, kind: HORIZON_ISSUANCE_KIND, expected: 0, value: { bogus: true } }], guards: [] });
  if (!written.ok) assert.fail(written.refusal.message);
  const ref = reference(written.value[0]!);
  const read = readHorizonIssuance(f.store, { project: f.project, record: ref });
  const invalid = failed(read);
  assert.equal(invalid.code, "horizon_issuance_record_invalid");
  assert.deepEqual(invalid.at, { unit: "G2", target: id, field: "contract", ref });
  assert.equal(invalid.message, "The issuance must be reproduced from its exact saved prepared transition and horizon");
  assert.equal(invalid.route, "producer");
  assert.ok(deeplyFrozen(read));
});

test("Q2 model-call: transport codes are data of the parsed answer, the historical arm is the exchange's own", () => {
  const interrupted = readAdapterResponse({ requestId: "request:om-e4", process: { exitCode: 1, signal: null, stdout: "", stderr: "boom" } });
  if (!interrupted.ok || interrupted.value.kind === "answered") assert.fail("An interrupted transport was expected");
  assert.equal(interrupted.value.kind, "interrupted");
  assert.equal(interrupted.value.error.code, "model_adapter_interrupted");
  assert.equal(interrupted.value.error.field, "process");
  assert.ok(has(TRANSPORT_ERROR_CODES, interrupted.value.error.code));
  const offForm = readAdapterResponse({ requestId: "request:om-e4", process: { exitCode: 0, signal: null, stdout: "not json", stderr: "" } });
  if (!offForm.ok || offForm.value.kind === "answered") assert.fail("An off-form transport was expected");
  assert.equal(offForm.value.kind, "off-form");
  assert.deepEqual(offForm.value.error, { code: "model_adapter_response_invalid", field: "stdout", message: "The adapter must return one JSON envelope" });
  assert.ok(deeplyFrozen(offForm));
  // The three transport literals and the exchange's historical code are the two arms of AdapterResult.error.code;
  // a literal outside today's transport set and a local refusal code are neither (№2460-4, №2460-7).
  const base = { usage: null, confirmed: { model: null, effort: null, speed: null } };
  assert.equal(asTransport({ ...base, kind: "interrupted", error: { code: "process_lost", field: "process", message: "The executor was lost" } }).kind, "interrupted");
  const historical = "spawn_failed" as SourceCode<"exchange">;
  assert.equal(asTransport({ ...base, kind: "interrupted", error: { code: historical, field: "process", message: "saved" } }).kind, "interrupted");
  // @ts-expect-error a saved launch error's code is the exchange's own (SourceCode<'exchange'>), never a plain literal of today's transport (№2460-4)
  asTransport({ ...base, kind: "interrupted", error: { code: "spawn_failed", field: "process", message: "saved" } });
  // @ts-expect-error a local refusal code is no transport code (№2460-7)
  asTransport({ ...base, kind: "off-form", error: { code: "model_call_record_invalid", field: "process", message: "probe" } });
});

// Return 1 (verdict №2511): the class guard. A code of another unit reaches a result only marked with its source, so the
// UNMARKED part of each module's result code is exactly its local catalogue: a transport literal, a source's literal or a
// plain string cannot sit in the union unmarked. The builder's sealed output keeps its narrow code, too. These are facts
// for tsc alone — a union that gains an unmarked member breaks the build here, whatever probes were thought of.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Unmarked<Code extends string> = Exclude<Code, SourceCode<string>>;
const CLASS_GUARD: [
  Equals<Unmarked<InputCode>, InputLocalCode>,
  Equals<Unmarked<HorizonCode>, HorizonLocalCode>,
  Equals<Unmarked<ModelCallCode>, ModelCallLocalCode>,
  Equals<ReturnType<typeof buildOmInput>["refusals"][number]["code"], InputRefusalCode>,
  // Q2b (№2518): the same guard over the seven modules, and the produced list of M8's result refusals is all marked.
  Equals<Unmarked<AssessmentCode>, AssessmentLocalCode>,
  Equals<Unmarked<AtomicGateCode>, AtomicGateLocalCode>,
  Equals<Unmarked<FeasibilityCode>, FeasibilityLocalCode>,
  Equals<Unmarked<HandoffCode>, HandoffLocalCode>,
  Equals<Unmarked<SeriesTransitionCode>, SeriesTransitionLocalCode>,
  Equals<Unmarked<SeriesResultCode>, SeriesLocalCode>,
  Equals<Unmarked<RunResultCode>, RunLocalCode>,
  Equals<Unmarked<PreparedFeasibility["refusals"][number]["code"]>, never>,
] = [true, true, true, true, true, true, true, true, true, true, true, true];

test("Q2 return 1: a transport code reaches a model-call result only as a transferred refusal marked with its source", () => {
  const lost = transfer("transport", refused("process_lost", "The physical executor was lost", AT, "producer"));
  if (lost.ok) assert.fail("A refusal was transferred");
  // The legal transfer of the verified transport compiles, keeps the refusal whole and carries the mark in the type alone.
  assert.equal(asModelCall(lost).ok, false);
  assert.deepEqual(Object.keys(lost.refusal), ["code", "message", "at", "route"]);
  assert.equal(Object.getOwnPropertySymbols(lost.refusal).length, 0);
  assert.equal(lost.refusal.code, "process_lost");
  // The historical arm — a saved launch error, already marked as the exchange's — passes through the same transfer.
  const saved = "spawn_failed" as SourceCode<"exchange">;
  assert.equal(asModelCall(transfer("transport", refused(saved, "saved launch error", AT, "producer"))).ok, false);
  // None of the three transport codes is a model-call refusal code without the transfer of its source (№2511-1).
  // @ts-expect-error a lost executor is no model-call refusal code unmarked
  asModelCall(refused("process_lost", "probe", AT, "producer"));
  // @ts-expect-error an interrupted adapter is no model-call refusal code unmarked
  asModelCall(refused("model_adapter_interrupted", "probe", AT, "producer"));
  // @ts-expect-error an invalid adapter response is no model-call refusal code unmarked
  asModelCall(refused("model_adapter_response_invalid", "probe", AT, "producer"));
  // A plain transport literal copied over the transferred code loses the mark, however equal its bytes.
  // @ts-expect-error the substituted code is a plain literal, no transferred code
  asModelCall({ ...lost, refusal: { ...lost.refusal, code: "model_adapter_interrupted" } });
  // The codes stay data of AdapterResult: all three, and the exchange's historical arm.
  assert.deepEqual([...TRANSPORT_ERROR_CODES], ["model_adapter_interrupted", "model_adapter_response_invalid", "process_lost"]);
  const base = { usage: null, confirmed: { model: null, effort: null, speed: null } };
  for (const code of TRANSPORT_ERROR_CODES) assert.equal(asTransport({ ...base, kind: "interrupted", error: { code, field: "process", message: "probe" } }).kind, "interrupted");
});

test("Q2 return 1: the builder's list of refusals takes only the builder's own codes", () => {
  const mine: Refusal<"input_field_missing"> = { code: "input_field_missing", message: "probe", at: AT, route: "producer" };
  const foreign: Refusal<"horizon_unclosed"> = { code: "horizon_unclosed", message: "probe", at: AT, route: "producer" };
  const wide: Refusal = { code: "input_field_missing", message: "probe", at: AT, route: "producer" };
  // The probes live in a function the compiler checks and nobody calls: what the list accepts is the type's business.
  function builderList(value: BuiltOmInput): void {
    value.refusals.push(mine);
    // @ts-expect-error a refusal of another unit cannot be pushed into the builder's own list (№2511-2)
    value.refusals.push(foreign);
    // @ts-expect-error a wide refusal cannot either: an intersection would have kept the wide list's overload (№2511-2)
    value.refusals.push(wide);
  }
  void builderList;
  const own: BuiltOmInput = { input: null, hash: null, refusals: [], gaps: [] };
  own.refusals.push(mine);
  assert.deepEqual(own.refusals.map(item => item.code), ["input_field_missing"]);
  assert.equal(sealed(own).refusals.length, 1);
  assert.equal(CLASS_GUARD.length, 12, "Q2 three modules and the builder list, Q2b seven modules and the M8 result list");
});

// The pins below are read from the base before Q2 (4f8084c), not from the code under test: moving a code into a type must
// leave every code, message, address and route of a refusal exactly as it was — including the refusals a module builds
// from a source's data or re-addresses (№2452-5, №2460-5). Revisions and hashes of fixture records are not pinned.
const shape = (refusal: Refusal): unknown[] => [refusal.code, refusal.message, refusal.at.unit, refusal.at.target, refusal.at.field, refusal.route];
// [mutation, code, message, unit, target, field, ref id, route] — read from the base 4f8084c before Q2.
const STAGE_PINS = [
  ["proofs-emptied", "stage_not_accepted", "Acceptance has no matching proof: stage:garden:specification", "G1", "stage:garden:features", "proofs", "stage:garden:features", "producer"],
  ["foreign-project", "stage_not_accepted", "The exact stage must belong to this project and be accepted", "G1", "stage:garden:features", "status", "stage:garden:features", "producer"],
  ["wrong-stage", "stage_not_accepted", "The exact stage must belong to this project and be accepted", "G1", "stage:garden:features", "status", "stage:garden:features", "producer"],
] as const;
const STALE_PIN = ["input_stale", "The requested input source is no longer current", "G1", "stage:garden:specification", "head", "stage:garden:specification", "producer"] as const;
// [case, refusals [code, message, unit, target, field, route][], conflicts [code, path][]]
const HORIZON_PINS = [
  ["empty", [["horizon_empty", "The selected horizon is empty", "G2", "horizon", "nodes", "owner"]], []],
  ["feature-unknown", [["horizon_feature_unknown", "The feature needs a known outcome and a block producer", "G2", "unknown-outcome", "features", "owner"], ["horizon_empty", "The selected horizon is empty", "G2", "horizon", "nodes", "owner"]], []],
  ["exclusion-unknown", [["horizon_exclusion_unknown", "The excluded block is not in the upper layer", "G2", "unknown-block", "excluded", "owner"]], []],
  ["exclusion-unjustified-reason", [["horizon_exclusion_unjustified", "An exclusion needs its reason and return condition", "G2", "garden-later-block", "excluded", "owner"]], []],
  ["exclusion-unjustified-return", [["horizon_exclusion_unjustified", "An exclusion needs its reason and return condition", "G2", "garden-later-block", "excluded", "owner"]], []],
  ["requires-excluded", [["horizon_requires_excluded", "The owner must resolve the exclusion of a required block", "G2", "garden-produce-block", "excluded", "owner"]], [["horizon_requires_excluded", ["feature:garden-result", "garden-consume-block", "garden-flow", "garden-produce-block"]]]],
  ["available-unproven", [["horizon_available_unproven", "Availability needs an exact receipt per artifact", "G2", "garden-produce-block", "available", "readiness"]], []],
  ["available-uncovered", [["horizon_available_uncovered", "Availability does not cover this required result", "G2", "garden-produce-block:garden-data", "garden-flow", "readiness"]], []],
  ["refinement-unknown-block", [["horizon_refinement_unproven", "Refinement must identify an upper-layer block", "G2", "unknown-block", "refined", "producer"]], []],
  ["refinement-product", [["horizon_refinement_unproven", "Refinement must identify an upper-layer block", "G2", "garden-product", "refined", "producer"]], []],
  ["unclosed-producer", [["horizon_unclosed", "A required internal producer is absent from the upper layer", "G2", "missing-producer", "dependency", "producer"]], []],
  ["unclosed-artifact", [["horizon_unclosed", "A required dependency must name an existing artifact", "G2", "garden-consume-block", "garden-flow", "producer"]], []],
] as const;
// [case, kind, error code, field, message, usage retained]
const ADAPTER_PINS = [
  ["not-json", "off-form", "model_adapter_response_invalid", "stdout", "The adapter must return one JSON envelope", false],
  ["foreign-protocol", "off-form", "model_adapter_response_invalid", "requestId", "The adapter response must name this exact protocol and request", false],
  ["foreign-request", "off-form", "model_adapter_response_invalid", "requestId", "The adapter response must name this exact protocol and request", false],
  ["malformed-usage", "off-form", "model_adapter_response_invalid", "usage", "The adapter token counts are malformed", false],
  ["confirmed-missing", "off-form", "model_adapter_response_invalid", "confirmed", "The adapter must explicitly distinguish confirmed settings from unknown settings", false],
  ["extra-key", "off-form", "model_adapter_response_invalid", "envelope", "The adapter response requires exactly protocol, requestId, research, usage and confirmed", false],
  ["exit-code", "interrupted", "model_adapter_interrupted", "process", "Adapter did not complete (exit=7, signal=null)", true],
  ["signal", "interrupted", "model_adapter_interrupted", "process", "Adapter did not complete (exit=null, signal=SIGTERM)", true],
  ["research-missing", "off-form", "model_adapter_response_invalid", "envelope", "The adapter response requires exactly protocol, requestId, research, usage and confirmed", false],
] as const;

test("Q2 pins input: stage acceptance and currentness refusals keep their exact prior results", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "stages" });
  const request = (expected = 0): InputRequest => ({ project: f.project, expected,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> });
  type Stage = (typeof f.stages)[UpstreamStage]["value"];
  const revise = (stage: UpstreamStage, change: (value: Stage) => void): Ref => {
    const original = f.stages[stage], value = structuredClone(original.value);
    change(value);
    return reference(f.store.write({ id: original.id, kind: original.kind, expected: f.store.get(original.id)!.revision, value }));
  };
  const changes: Record<string, (value: Stage) => void> = {
    "proofs-emptied": value => { value.proofs = []; },
    "foreign-project": value => { value.projectId = "other"; },
    "wrong-stage": value => { value.stage = "concept"; },
  };
  for (const [name, code, message, unit, target, field, refId, route] of STAGE_PINS) {
    const bad = request(); bad.stages.features = revise("features", changes[name]!);
    for (const action of [writeOmInput, prepareOmInput]) {
      const refusal = failed(action(f.store, bad));
      assert.deepEqual(shape(refusal), [code, message, unit, target, field, route], `${action.name}: ${name}`);
      assert.equal(refusal.at.ref?.id, refId, name);
    }
  }
  assert.equal(f.store.get(`om-input:${f.project}`), null, "A refused input writes nothing");
});

test("Q2 pins input: a source that moved after the input was saved is refused with its exact prior address", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "stages" });
  const request = (expected = 0): InputRequest => ({ project: f.project, expected,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> });
  const saved = writeOmInput(f.store, request());
  if (!saved.ok) assert.fail(saved.refusal.message);
  const original = f.stages.specification, value = structuredClone(original.value);
  value.status = "draft";
  f.store.write({ id: original.id, kind: original.kind, expected: f.store.get(original.id)!.revision, value });
  const [code, message, unit, target, field, refId, route] = STALE_PIN;
  for (const action of [prepareOmInput, writeOmInput]) {
    const refusal = failed(action(f.store, request(1)));
    assert.deepEqual(shape(refusal), [code, message, unit, target, field, route], action.name);
    assert.equal(refusal.at.ref?.id, refId);
  }
});

test("Q2 pins horizon: every closing refusal and conflict keeps its exact prior code, message, address and route", () => {
  const { level: _level, ...upper } = projectGraph(gardenGraph(), 1);
  const graph = upper as Graph;
  const options = (overrides: Partial<HorizonOptions> = {}): HorizonOptions => ({ choiceVersion: "choice-1",
    features: [{ outcome: "garden-result" }], excluded: [], refined: [], available: {}, ...overrides });
  const receipt = (artifact: string, revision = 1): Ref => ({ id: `artifact-receipt:garden:${artifact}`, revision, hash: hashJson({ artifact, revision }) });
  const excluded = (block: string, reason: string, returnCondition: string) => ({ block, reason, returnCondition });
  const brokenProducer = structuredClone(graph);
  brokenProducer.connectors[0]!.bindings[0]!.producer.node = "missing-producer";
  const missingArtifact = structuredClone(graph);
  missingArtifact.artifacts = missingArtifact.artifacts.filter(artifact => artifact.id !== "garden-data");
  const cases: Record<string, { graph: Graph; options: HorizonOptions }> = {
    "empty": { graph, options: options({ features: [] }) },
    "feature-unknown": { graph, options: options({ features: [{ outcome: "unknown-outcome" }] }) },
    "exclusion-unknown": { graph, options: options({ excluded: [excluded("unknown-block", "Outside scope", "Owner expands scope")] }) },
    "exclusion-unjustified-reason": { graph, options: options({ excluded: [excluded("garden-later-block", "", "Owner expands scope")] }) },
    "exclusion-unjustified-return": { graph, options: options({ excluded: [excluded("garden-later-block", "Outside scope", "")] }) },
    "requires-excluded": { graph, options: options({ excluded: [excluded("garden-produce-block", "Outside scope", "Owner expands scope")] }) },
    "available-unproven": { graph, options: options({ available: { "garden-produce-block": receipt("garden-data") } as unknown as HorizonOptions["available"] }) },
    "available-uncovered": { graph, options: options({ available: { "garden-produce-block": { "garden-result": receipt("garden-result") } } }) },
    "refinement-unknown-block": { graph, options: options({ refined: ["unknown-block"] }) },
    "refinement-product": { graph, options: options({ refined: ["garden-product"] }) },
    "unclosed-producer": { graph: brokenProducer, options: options() },
    "unclosed-artifact": { graph: missingArtifact, options: options() },
  };
  assert.deepEqual(Object.keys(cases).sort(), HORIZON_PINS.map(row => row[0]).sort());
  for (const [name, refusals, conflicts] of HORIZON_PINS) {
    const used = cases[name]!, built = closeHorizon(used.graph, used.options);
    assert.deepEqual(built.refusals.map(shape), refusals.map(row => [...row]), name);
    assert.deepEqual(built.conflicts.map(item => [item.code, item.path]), conflicts.map(row => [...row]), name);
  }
});

test("Q2 pins model-call: every defect of an adapter answer keeps its exact prior transport error", () => {
  const requestId = "request:om-e4";
  const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
  const confirmed = { model: "fixture-confirmed", effort: "high", speed: "fast" };
  const envelope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ protocol: "omg-agent/v1", requestId,
    research: { answer: "producer" }, usage: null, confirmed: { model: null, effort: null, speed: null }, ...over });
  const without = (key: string): string => JSON.stringify(Object.fromEntries(Object.entries(envelope()).filter(([name]) => name !== key)));
  const run = (stdout: string, over: Partial<ProcessResult> = {}) =>
    readAdapterResponse({ requestId, process: { exitCode: 0, signal: null, stdout, stderr: "", ...over } });
  const measured = JSON.stringify(envelope({ usage, confirmed }));
  const cases: Record<string, ReturnType<typeof run>> = {
    "not-json": run("not json"),
    "foreign-protocol": run(JSON.stringify(envelope({ protocol: "other" }))),
    "foreign-request": run(JSON.stringify(envelope({ requestId: "other" }))),
    "malformed-usage": run(JSON.stringify(envelope({ usage: { inputTokens: -1 } }))),
    "confirmed-missing": run(without("confirmed")),
    "extra-key": run(JSON.stringify(envelope({ accepted: true }))),
    "exit-code": run(measured, { exitCode: 7 }),
    "signal": run(measured, { exitCode: null, signal: "SIGTERM" }),
    "research-missing": run(without("research")),
  };
  assert.deepEqual(Object.keys(cases).sort(), ADAPTER_PINS.map(row => row[0]).sort());
  for (const [name, kind, code, field, message, retained] of ADAPTER_PINS) {
    const result = cases[name]!;
    if (!result.ok || result.value.kind === "answered") assert.fail(`${name}: a transport defect was expected`);
    assert.equal(result.value.kind, kind, name);
    assert.deepEqual(result.value.error, { code, field, message }, name);
    assert.equal(result.value.usage !== null, retained, name);
    assert.deepEqual(result.value.confirmed, retained ? confirmed : { model: null, effort: null, speed: null }, name);
  }
});

// ---- Q2b (№2518, №2522): the same typing over assessment (E5), atomic-gate (G5), feasibility (M8), handoff (M9),
// series-transition, series and run (H1).
const asAssessment = <T>(result: AssessmentResult<T>): AssessmentResult<T> => result;
const asAtomicGate = <T>(result: AtomicGateResult<T>): AtomicGateResult<T> => result;
const asFeasibility = <T>(result: FeasibilityResult<T>): FeasibilityResult<T> => result;
const asHandoff = <T>(result: HandoffResult<T>): HandoffResult<T> => result;
const asSeriesTransition = <T>(result: SeriesTransitionResult<T>): SeriesTransitionResult<T> => result;
const asSeries = <T>(result: SeriesResult<T>): SeriesResult<T> => result;
const asRun = <T>(result: RunResult<T>): RunResult<T> => result;

test("Q2b catalogues: each module's full local set from its places of issue, the pinned subsets kept, the exceptions apart", () => {
  for (const catalogue of [ASSESSMENT_LOCAL_CODES, ASSESSMENT_ERROR_CODES, ATOMIC_GATE_LOCAL_CODES, ATOMIC_GATE_ERROR_CODES,
    FEASIBILITY_LOCAL_CODES, FEASIBILITY_ERROR_CODES, HANDOFF_LOCAL_CODES, HANDOFF_ERROR_CODES, SERIES_TRANSITION_LOCAL_CODES,
    SERIES_TRANSITION_ERROR_CODES, SERIES_CODES, SERIES_LOCAL_CODES, SERIES_ERROR_CODES, RUN_CODES, RUN_LOCAL_CODES, RUN_ERROR_CODES]) {
    assert.ok(Object.isFrozen(catalogue));
    assert.equal(new Set(catalogue).size, catalogue.length, "A catalogue names each code once");
    assert.ok(catalogue.every(code => typeof code === "string" && code.length > 0));
  }
  assert.deepEqual(sorted(ASSESSMENT_LOCAL_CODES), sorted(["assessment_cause_invalid", "assessment_cause_unproved",
    "assessment_identity_conflict", "assessment_independence_invalid", "assessment_intent_invalid", "assessment_refusal_invalid",
    "assessment_result_invalid", "assessment_set_invalid", "assessment_source_invalid", "assessment_source_stale",
    "assessment_not_supported", "completion_ceased"]));
  assert.deepEqual([...ASSESSMENT_ERROR_CODES], ["assessment_request_invalid"]);
  assert.deepEqual(sorted(ATOMIC_GATE_LOCAL_CODES), sorted(["atomic_gate_basis_unproven", "atomic_gate_bindings_unproven",
    "atomic_gate_record_forged", "atomic_gate_transaction_conflict", "input_stale", "obligation_assignment_invalid", "packet_foreign",
    "work_blocking_gap_open"]));
  assert.deepEqual([...ATOMIC_GATE_ERROR_CODES], ["atomic_gate_request_invalid", "atomic_gate_internal"]);
  assert.deepEqual(sorted(FEASIBILITY_LOCAL_CODES), sorted(["feasibility_record_invalid", "feasibility_contract_superseded",
    "feasibility_stale", "feasibility_not_ready", "input_stale"]));
  assert.deepEqual([...FEASIBILITY_ERROR_CODES], ["feasibility_request_invalid", "feasibility_internal"]);
  // M9 states the saved-record codes of its own sources itself (№2460-1): they are its local codes, not a transfer of refs.
  assert.deepEqual(sorted(HANDOFF_LOCAL_CODES), sorted(["handoff_record_invalid", "handoff_feasibility_unchanged", "feasibility_not_ready",
    "input_stale", "record_missing", "record_forged", "record_foreign", "revision_conflict"]));
  assert.deepEqual([...HANDOFF_ERROR_CODES], ["handoff_request_invalid", "handoff_internal"]);
  assert.deepEqual([...SERIES_TRANSITION_LOCAL_CODES], ["series_transition_unproven", "series_slice_unproven"]);
  assert.deepEqual([...SERIES_TRANSITION_ERROR_CODES], ["series_transition_request_invalid"]);
  // series.ts: the store-repairs subset om-series.test pins inside the full set — G7, B3 and the handed-over record codes.
  assert.equal(SERIES_CODES.length, 21);
  assert.ok(SERIES_CODES.every(code => has(SERIES_LOCAL_CODES, code)));
  assert.deepEqual(sorted(SERIES_LOCAL_CODES), sorted([...SERIES_CODES, "completion_required", "completion_conflict", "completion_invalid",
    "completion_request_invalid", "input_stale", "series_transition_refused", "record_foreign", "revision_conflict"]));
  assert.deepEqual([...SERIES_ERROR_CODES], ["series_request_invalid"]);
  // run.ts: RUN_CODES stays exported and exact; each of its codes is a local refusal or the pass's exception, never both.
  assert.deepEqual([...RUN_CODES], ["run_request_invalid", "run_record_invalid", "run_outcome_unknown", "run_intent_conflict", "horizon_empty"]);
  for (const code of RUN_CODES) assert.notEqual(has(RUN_LOCAL_CODES, code), has(RUN_ERROR_CODES, code), code);
  assert.deepEqual(sorted(RUN_LOCAL_CODES), sorted(["run_record_invalid", "run_outcome_unknown", "run_intent_conflict", "horizon_empty",
    "record_missing", "candidate_gaps", "answers_not_passed"]));
  assert.deepEqual([...RUN_ERROR_CODES], ["run_request_invalid"]);
});

test("Q2b local constructors: each module's catalogue bounds its refusals and exceptions at compile time and at runtime", () => {
  assert.equal(failed(localRefusals(ASSESSMENT_LOCAL_CODES)("completion_ceased", "probe", AT, "producer")).code, "completion_ceased");
  assert.equal(failed(localRefusals(ATOMIC_GATE_LOCAL_CODES)("packet_foreign", "probe", AT, "producer")).code, "packet_foreign");
  assert.equal(failed(localRefusals(FEASIBILITY_LOCAL_CODES)("feasibility_stale", "probe", AT, "producer")).code, "feasibility_stale");
  assert.equal(failed(localRefusals(HANDOFF_LOCAL_CODES)("record_forged", "probe", AT, "producer")).code, "record_forged");
  assert.equal(failed(localRefusals(SERIES_TRANSITION_LOCAL_CODES)("series_slice_unproven", "probe", AT, "producer")).code, "series_slice_unproven");
  assert.equal(failed(localRefusals(SERIES_LOCAL_CODES)("completion_invalid", "probe", AT, "producer")).code, "completion_invalid");
  assert.equal(failed(localRefusals(RUN_LOCAL_CODES)("candidate_gaps", "probe", AT, "owner")).route, "owner");
  assert.throws(() => localRefusals(ASSESSMENT_LOCAL_CODES)(
    // @ts-expect-error a code of series is no code of E5
    "series_conflict", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(ATOMIC_GATE_LOCAL_CODES)(
    // @ts-expect-error an exception of the compiler's source resolution is no local refusal of G5 (it is transferred)
    "external_input_missing", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(FEASIBILITY_LOCAL_CODES)(
    // @ts-expect-error a finding of the repository inspection is no local refusal of M8 (it is transferred)
    "repository_dirty", "probe", AT, "owner"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(HANDOFF_LOCAL_CODES)(
    // @ts-expect-error the stage pipeline's exception is no local refusal of M9 (it is transferred)
    "gate_rejected", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(SERIES_TRANSITION_LOCAL_CODES)(
    // @ts-expect-error a refs code is no code the prepared transition creates
    "record_missing", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(SERIES_LOCAL_CODES)(
    // @ts-expect-error a code of the pass is no code of series
    "candidate_gaps", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localRefusals(RUN_LOCAL_CODES)(
    // @ts-expect-error the pass's exception code is no refusal of the pass (№2452-5)
    "run_request_invalid", "probe", AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => localErrors(RUN_ERROR_CODES)("run_request_invalid", "A pass runs through a store"), { code: "run_request_invalid" });
  assert.throws(() => localErrors(SERIES_ERROR_CODES)(
    // @ts-expect-error another module's exception code is no exception of series
    "run_request_invalid", "probe"), { code: "refusal_invalid" });
});

test("Q2b return-1 class (№2511-1): a code of another unit reaches a module's result only marked with a declared source", () => {
  // Positive: the module's own literal, and a declared source's refusal through its transfer.
  assert.equal(asAssessment(refused("assessment_not_supported", "probe", AT, "producer")).ok, false);
  assert.equal(asAssessment(transfer("model-call", refused("model_call_in_progress", "probe", AT, "producer"))).ok, false);
  assert.equal(asAtomicGate(transfer("obligations", refused("obligation_assignment_unresolved", "probe", AT, "producer"))).ok, false);
  assert.equal(asFeasibility(transfer("frame-accept", refused("record_missing", "probe", AT, "producer"))).ok, false);
  assert.equal(asHandoff(transfer("feasibility", refused("feasibility_stale", "probe", AT, "producer"))).ok, false);
  assert.equal(asSeriesTransition(transfer("series", refused("series_missing", "probe", AT, "producer"))).ok, false);
  assert.equal(asSeries(transfer("routes", refused("route_stale", "probe", AT, "producer"))).ok, false);
  assert.equal(asRun(transfer("handoff", refused("handoff_record_invalid", "probe", AT, "producer"))).ok, false);
  // Negative: a source's literal unmarked, in each module's result.
  // @ts-expect-error a code of series is no E5 code unmarked
  asAssessment(refused("series_conflict", "probe", AT, "producer"));
  // @ts-expect-error the compiler's source exception is no G5 code unmarked
  asAtomicGate(refused("external_input_missing", "probe", AT, "producer"));
  // @ts-expect-error a finding of the repository inspection is no M8 code unmarked
  asFeasibility(refused("repository_dirty", "probe", AT, "owner"));
  // @ts-expect-error the stage pipeline's exception is no M9 code unmarked
  asHandoff(refused("gate_rejected", "probe", AT, "producer"));
  // @ts-expect-error a refs code is no code of the prepared transition unmarked
  asSeriesTransition(refused("record_missing", "probe", AT, "producer"));
  // @ts-expect-error a code of horizon is no code of series unmarked
  asSeries(refused("horizon_unclosed", "probe", AT, "producer"));
  // @ts-expect-error a model call in progress is no code of the pass unmarked
  asRun(refused("model_call_in_progress", "probe", AT, "producer"));
  // A plain string, and a plain literal copied over a transferred code, are no codes either.
  const plain: string = "run_record_invalid";
  // @ts-expect-error a plain string is no code of the pass, whatever it holds at runtime
  asRun(refused(plain, "probe", AT, "producer"));
  const compiled = transfer("stage-checks", refused("plan_input_invalid", "probe", AT, "producer"));
  if (compiled.ok) assert.fail("A refusal was transferred");
  assert.equal(asRun(compiled).ok, false);
  // @ts-expect-error the substituted code is a plain literal, no transferred code of the compiler's stage check
  asRun({ ...compiled, refusal: { ...compiled.refusal, code: "plan_input_invalid" } });
  const pilot = transfer("reader-pilot", refused("pilot_boundary_reached", "probe", AT, "producer"));
  if (pilot.ok) assert.fail("A refusal was transferred");
  assert.equal(asHandoff(pilot).ok, false);
  // @ts-expect-error the substituted code is a plain literal, no transferred code of the R3 boundary
  asHandoff({ ...pilot, refusal: { ...pilot.refusal, code: "pilot_boundary_reached" } });
  // A source a module does not declare is no source of it.
  // @ts-expect-error the compiler's stage check is no declared source of M9
  asHandoff(transfer("stage-checks", refused("plan_input_invalid", "probe", AT, "producer")));
});

test("Q2b return-2 class (№2511-2): M8's list of result refusals takes only the three producers' marked refusals", () => {
  const inspection = transfer("inspection", refused("repository_dirty", "probe", AT, "owner"));
  if (inspection.ok) assert.fail("A refusal was transferred");
  const marked = inspection.refusal;
  const foreign: Refusal<"repository_dirty"> = { code: "repository_dirty", message: "probe", at: AT, route: "owner" };
  const wide: Refusal = { code: "repository_dirty", message: "probe", at: AT, route: "owner" };
  const local: Refusal<FeasibilityLocalCode> = { code: "input_stale", message: "probe", at: AT, route: "producer" };
  function resultList(value: PreparedFeasibility): void {
    value.refusals.push(marked);
    // @ts-expect-error an unmarked refusal cannot be pushed into M8's list of result refusals
    value.refusals.push(foreign);
    // @ts-expect-error a wide refusal cannot either
    value.refusals.push(wide);
    // @ts-expect-error nor a local refusal of M8: the list holds the producers' findings only
    value.refusals.push(local);
  }
  void resultList;
});

test("Q2b transferError: a declared source's exception, its own code and message at the module's address and route, marked in the type alone", () => {
  const error = new EngineError("plan_input_invalid", "Every input needs its exact M8 producer and artifact resolution", { field: "probe" });
  const ref = { id: "stage:garden:compilation", revision: 2, hash: hashJson({ probe: true }) };
  const result = transferError("stage-checks", error, { unit: "H1", target: "stage:garden:compilation", field: "compile", ref }, "producer");
  const refusal = failed(asRun(result));
  assert.deepEqual(refusal, { code: "plan_input_invalid", message: "Every input needs its exact M8 producer and artifact resolution",
    at: { unit: "H1", target: "stage:garden:compilation", field: "compile", ref }, route: "producer" });
  assert.deepEqual(Object.keys(refusal), ["code", "message", "at", "route"]);
  assert.equal(Object.getOwnPropertySymbols(refusal).length, 0, "The mark is no field of the refusal");
  assert.ok(deeplyFrozen(result));
  assert.throws(() => transferError("stage-checks", { code: "plan_input_invalid", message: "forged", name: "EngineError", details: null } as never,
    AT, "producer"), { code: "refusal_invalid" });
  assert.throws(() => transferError("", error, AT, "producer"), { code: "refusal_invalid" });
});

// The pins below are read from the clean base 249abcb (before Q2b) with the same scenarios; revisions, hashes and the
// temporary workspace path are not pinned. [case, code, message, unit, target, field, route]
const HANDOFF_ADMISSION_PINS = [
  ["finding-code", "probe_finding", "Stage validation refused acceptance", "M9", "probe-target", "probe-field", "producer"],
  ["finding-no-field", "probe_finding", "Stage validation refused acceptance", "M9", "probe-target", "admission", "producer"],
  ["no-details", "stage_not_ready", "Stage is not ready for acceptance", "M9", "stage:garden:om-g2", "admission", "producer"],
  ["malformed-detail", "gate_rejected", "Stage validation refused acceptance", "M9", "stage:garden:om-g2", "admission", "producer"],
  ["empty-details", "gate_rejected", "Stage validation refused acceptance", "M9", "stage:garden:om-g2", "admission", "producer"],
] as const;
const HANDOFF_ADMISSION_ERRORS: Record<typeof HANDOFF_ADMISSION_PINS[number][0], EngineError> = {
  "finding-code": new EngineError("gate_rejected", "Stage validation refused acceptance", [
    { code: "probe_finding", target: "probe-target", field: "probe-field", message: "A finding message" }, { code: "second", target: "t", message: "m" }]),
  "finding-no-field": new EngineError("gate_rejected", "Stage validation refused acceptance", [{ code: "probe_finding", target: "probe-target", message: "m" }]),
  "no-details": new EngineError("stage_not_ready", "Stage is not ready for acceptance"),
  "malformed-detail": new EngineError("gate_rejected", "Stage validation refused acceptance", { code: 7, target: null, field: ["x"] }),
  "empty-details": new EngineError("gate_rejected", "Stage validation refused acceptance", []),
};
const HANDOFF_GATE_PIN = ["feasibility_stale", "Stage validation refused acceptance", "M9", "om-feasibility:garden", "result", "producer"] as const;
const HANDOFF_PILOT_PIN = ["pilot_boundary_reached", "This phase is beyond the explicitly permitted continuation boundary", "M9",
  "reader-pilot:garden", "R3", "producer"] as const;
const INSPECTION_PIN = ["repository_dirty", "Repository has uncommitted changes", "M8", "owner"] as const;

interface WorksFixture { readonly store: Store; root: string; workspace: string; project: string; feasibility: FeasibilityRequest }
/** The accepted works of om-feasibility.test, taken exactly as om-task-neighbors takes them. */
async function acceptedWorks(t: TestContext): Promise<WorksFixture> {
  const url = new URL("./om-feasibility.test.js", import.meta.url);
  let source = readFileSync(url, "utf8");
  const end = source.indexOf("const heads =");
  assert.ok(end > 0, "The declared om-feasibility fixture seam");
  source = source.slice(0, end).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
    (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
  assert.ok(!/\btest\(/.test(source));
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { acceptedWorksFixture };`).toString("base64")}`) as
    { acceptedWorksFixture(t: TestContext): WorksFixture };
  return module.acceptedWorksFixture(t);
}

test("Q2b pins M9 and M8: the stage pipeline's admission, the R3 boundary and the inspection keep their exact prior refusals (base 249abcb)", async t => {
  const f = await acceptedWorks(t);
  const m8 = writeFeasibility(f.store, f.feasibility);
  if (!m8.ok) assert.fail(`M8: ${m8.refusal.code}`);
  const request = { project: f.project, feasibility: reference(m8.value), expected: 0 };
  // The pipeline's exception is the whole input of M9's named admission adapter: its first finding's code, target and
  // field, or the exception's code, the stage and 'admission' when the finding has none (№2522-1).
  const original = Pipeline.prototype.prepareAccepted;
  try {
    for (const [name, code, message, unit, target, field, route] of HANDOFF_ADMISSION_PINS) {
      Pipeline.prototype.prepareAccepted = () => { throw HANDOFF_ADMISSION_ERRORS[name]; };
      const refusal = failed(asHandoff(prepareHandoff(f.store, request)));
      assert.deepEqual(shape(refusal), [code, message, unit, target, field, route], name);
      assert.equal(refusal.at.ref, undefined, name);
    }
  } finally { Pipeline.prototype.prepareAccepted = original; }
  // The finding differs from the exception's own code for real, too: G6 refuses the changed repository through the gate.
  const dirty = join(f.workspace, "untracked-probe.txt");
  writeFileSync(dirty, "A changed physical repository");
  assert.deepEqual(shape(failed(prepareHandoff(f.store, request))), [...HANDOFF_GATE_PIN]);
  const current = prepareFeasibility(f.store, { ...f.feasibility, expected: m8.value.revision });
  if (!current.ok) assert.fail(`M8 preparation: ${current.refusal.code}`);
  assert.deepEqual(current.value.refusals.map(refusal => [refusal.code, refusal.message, refusal.at.unit, refusal.route]), [[...INSPECTION_PIN]]);
  assert.ok(current.value.refusals.every(refusal => refusal.at.field === undefined && refusal.at.target.endsWith("workspace")));
  rmSync(dirty);
  const command = { executable: process.execPath, args: ["--version"] };
  configureReaderPilot(f.store, new Environments(f.store), f.project, { experimental: true, active: false, stopAfter: "L2",
    reader: { actor: "g2-reader", model: "fixture", effort: "high", speed: "inherited", command }, agentCommand: command,
    maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100, maxReportedTokens: 20000000 }, 0);
  assert.deepEqual(shape(failed(prepareHandoff(f.store, request))), [...HANDOFF_PILOT_PIN]);
});

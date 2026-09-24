import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store } from "../src/storage/store.js";
import { gapId, readGaps, writeGaps, type Gap, type GapRequest, type GapReadRequest } from "../src/om/gaps.js";
import { mergeLines, prepareGapLines, writeGapLines, readGapLines, gapLinesId, gapLineKey, gapLineExpectedResult, GAP_LINE_KIND,
  type GapLine, type GapLineClosure, type GapLinesRequest, type GapLinesRecord, type GapClosureRequest } from "../src/om/gap-lines.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { fillObligations, prepareFrame, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import { writeCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate, type AcceptedFrameRequest } from "../src/om/frame-accept.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { openSeries, beginAttempt, completeAttempt, readSeries, readSeriesAt, type AttemptGoal, type SeriesRequest } from "../src/om/series.js";
import { confirmResults } from "../src/om/achievements.js";
import { closeAttempt, prepareCloseAttempt } from "../src/om/repeat-gate.js";
import { readResultIdentity } from "../src/om/result-identity.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";

const clone = structuredClone;
const fakeRef = (id: string, revision = 1): Ref => ({ id, revision, hash: hashJson({ id, revision }) });
function gap(target = "garden-prep-outcome", field = "fill"): Gap {
  return {
    id: gapId(target, field), target, field, code: "frame_fill_missing", kind: "design-decision",
    routes: ["design"], moment: "om-pass", consumers: ["garden-produce-block"], origins: ["frame"],
    evidence: [{ origin: "operations", target, source: fakeRef("graph-layer:garden:1"), value: { target, field } }], blocking: true,
  };
}
function deferredGap(target = "garden-prep-outcome"): Gap {
  return { ...gap(target), blocking: false, deferral: { reason: "outside_horizon", until: "horizon-entry", blocks: ["garden-produce-block"] } };
}
function succeeded(value: ReturnType<typeof mergeLines>): readonly GapLine[] {
  assert.deepEqual(value.refusals, []); return value.lines;
}
function addressed(refusal: Refusal): void {
  assert.ok(refusal.at.target.length > 0);
  assert.ok(refusal.at.field || refusal.at.ref);
  assert.ok(["producer", "gap", "owner", "readiness"].includes(refusal.route));
}
function unchangedRefusal(value: ReturnType<typeof mergeLines>, before: readonly GapLine[], code?: string): void {
  assert.ok(value.refusals.length > 0);
  if (code) assert.ok(value.refusals.some(item => item.code === code), `${code} absent: ${value.refusals.map(item => item.code).join(", ")}`);
  value.refusals.forEach(addressed);
  assert.deepEqual(value.lines, before);
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError); assert.equal(error.code, "gap_line_request_invalid");
  assert.ok(error.details && typeof error.details === "object", "Malformed boundary input must retain an address");
  const details = error.details as Record<string, unknown>;
  assert.ok("field" in details || "at" in details || "target" in details, "Malformed boundary input must identify its field or source");
  return true;
}
const filled = (id: string, basis = fakeRef("om-frame:garden:2")): GapLineClosure => ({ id, reason: "filled", basis });

test("D2 preserves target/field identity across ordering, source revisions, and descriptive changes", () => {
  const first = gap(); const second = gap("garden-consume-outcome"); const otherField = gap(first.target, "contract");
  const initial = succeeded(mergeLines([], [first, second, otherField], 4, []));
  assert.equal(initial.length, 3); assert.equal(new Set(initial.map(item => item.id)).size, 3);
  for (const item of initial) {
    assert.deepEqual(item, { id: gapId(item.target, item.field), target: item.target, field: item.field,
      firstPass: 4, lastPass: 4, statePass: 4, passes: 1, reopened: 0, status: "open" });
  }
  const revised = clone(first); revised.code = "new-addressed-description";
  revised.evidence[0]!.source = fakeRef("graph-layer:garden:1", 2);
  revised.evidence[0]!.value = { message: "Different explanation and revision, same required field" };
  const later = succeeded(mergeLines(initial, [otherField, second, revised], 9, []));
  assert.deepEqual(later.map(item => item.id).sort(), initial.map(item => item.id).sort());
  for (const item of later) {
    assert.equal(item.firstPass, 4); assert.equal(item.lastPass, 9); assert.equal(item.statePass, 9);
    assert.equal(item.passes, 2); assert.equal(item.reopened, 0);
  }
  assert.deepEqual(mergeLines([], [second, first, otherField], 4, []), mergeLines([], [first, second, otherField], 4, []));
});

test("D2 disappearance defers a line and return preserves it without reopening", () => {
  const source = gap();
  const initial = succeeded(mergeLines([], [source], 2, []));
  const absent = succeeded(mergeLines(initial, [], 5, []));
  assert.deepEqual(absent[0], { ...initial[0], status: "deferred", scope: "absent", statePass: 5 });
  assert.equal(absent[0]!.lastPass, 2); assert.equal(absent[0]!.passes, 1);
  assert.equal(absent[0]!.basis, undefined); assert.equal(absent[0]!.closedPass, undefined);
  const stillAbsent = succeeded(mergeLines(absent, [], 8, []));
  assert.deepEqual(stillAbsent[0], { ...absent[0], statePass: 8 });
  const returned = succeeded(mergeLines(stillAbsent, [source], 11, []));
  assert.deepEqual(returned[0], { ...initial[0], lastPass: 11, statePass: 11, passes: 2 });
  assert.equal(returned[0]!.scope, undefined); assert.equal(returned[0]!.reopened, 0);
});

test("D2 distinguishes an explicitly deferred current gap from an absent one", () => {
  const source = deferredGap();
  const initial = succeeded(mergeLines([], [source], 1, []));
  assert.equal(initial[0]!.status, "deferred"); assert.equal(initial[0]!.scope, undefined);
  const present = succeeded(mergeLines(initial, [source], 3, []));
  assert.equal(present[0]!.lastPass, 3); assert.equal(present[0]!.passes, 2); assert.equal(present[0]!.scope, undefined);
  const absent = succeeded(mergeLines(present, [], 4, []));
  assert.equal(absent[0]!.scope, "absent"); assert.equal(absent[0]!.lastPass, 3); assert.equal(absent[0]!.passes, 2);
  const returned = succeeded(mergeLines(absent, [source], 7, []));
  assert.equal(returned[0]!.status, "deferred"); assert.equal(returned[0]!.scope, undefined);
  assert.equal(returned[0]!.passes, 3); assert.equal(returned[0]!.reopened, 0);
});

test("D2 pure closure requires a precise basis and preserves both filled and cancelled transitions", () => {
  for (const reason of ["filled", "cancelled"] as const) {
    const source = gap(); const basis = fakeRef(`closure:${reason}`);
    const initial = succeeded(mergeLines([], [source], 1, []));
    const closure: GapLineClosure = { id: source.id, reason, basis };
    const closed = succeeded(mergeLines(initial, [], 4, [closure]));
    assert.deepEqual(closed[0], { ...initial[0], status: "closed", statePass: 4, closedPass: 4, closedBy: reason, basis });
    assert.equal(closed[0]!.lastPass, 1); assert.equal(closed[0]!.passes, 1);
    assert.deepEqual(succeeded(mergeLines(closed, [], 4, [closure])), closed);
    const later = succeeded(mergeLines(closed, [], 8, []));
    assert.deepEqual(later[0], { ...closed[0], statePass: 8 });
    assert.equal(later[0]!.closedPass, 4); assert.deepEqual(later[0]!.basis, basis);
  }
});

test("D2 a later filled basis updates a closed filled line without inventing reappearance or cancelling a decision", () => {
  const source = gap(), initial = succeeded(mergeLines([], [source], 1, []));
  const a = filled(source.id, fakeRef("om-frame:garden:2", 1)), b = filled(source.id, fakeRef("om-frame:garden:2", 2));
  const first = succeeded(mergeLines(initial, [], 2, [a]));
  const second = succeeded(mergeLines(first, [], 4, [b]));
  assert.deepEqual(second[0], { ...first[0], statePass: 4, closedPass: 4, basis: b.basis });
  assert.deepEqual(succeeded(mergeLines(second, [], 4, [b])), second);
  unchangedRefusal(mergeLines(second, [], 4, [a]), second, "pass_conflict");
  unchangedRefusal(mergeLines(second, [], 3, [a]), second, "pass_out_of_order");
  const restored = succeeded(mergeLines(second, [], 6, [a]));
  assert.deepEqual(restored[0], { ...first[0], statePass: 6, closedPass: 6 });
  const cancelled = succeeded(mergeLines(initial, [], 2, [{ ...a, reason: "cancelled" }]));
  unchangedRefusal(mergeLines(cancelled, [], 4, [b]), cancelled, "closure_invalid");
  unchangedRefusal(mergeLines(second, [], 6, [{ ...a, reason: "cancelled" }]), second, "closure_invalid");
  unchangedRefusal(mergeLines(second, [source], 6, [b]), second, "closure_invalid");
  const reopened = succeeded(mergeLines(second, [source], 6, []))[0]!;
  assert.equal(reopened.status, "open"); assert.equal(reopened.reopened, 1); assert.equal(reopened.passes, 2);
  assert.equal(reopened.lastPass, 6); assert.equal(reopened.basis, undefined); assert.equal(reopened.closedPass, undefined);
});

test("D2 reopening counts closed returns once per pass and clears the old closure", () => {
  const source = gap();
  const initial = succeeded(mergeLines([], [source], 1, []));
  const closed = succeeded(mergeLines(initial, [], 2, [filled(source.id)]));
  const reopened = succeeded(mergeLines(closed, [source], 4, []));
  assert.deepEqual(reopened[0], { ...initial[0], lastPass: 4, statePass: 4, passes: 2, reopened: 1 });
  for (const key of ["closedPass", "closedBy", "basis", "scope"] as const) assert.equal(reopened[0]![key], undefined);
  assert.deepEqual(succeeded(mergeLines(reopened, [source], 4, [])), reopened);
  const closedAgain = succeeded(mergeLines(reopened, [], 5, [filled(source.id, fakeRef("om-frame:garden:2", 2))]));
  const deferredReturn = succeeded(mergeLines(closedAgain, [deferredGap()], 8, []));
  assert.equal(deferredReturn[0]!.reopened, 2); assert.equal(deferredReturn[0]!.passes, 3);
  assert.equal(deferredReturn[0]!.status, "deferred"); assert.equal(deferredReturn[0]!.scope, undefined);
  assert.equal(deferredReturn[0]!.firstPass, 1); assert.equal(deferredReturn[0]!.basis, undefined);
});

test("D2 late passes cannot reverse later closure or deferral, even when last occurrence is older", () => {
  const a = gap(); const b = gap("garden-consume-outcome");
  const initial = succeeded(mergeLines([], [a, b], 2, []));
  const settled = succeeded(mergeLines(initial, [], 9, [filled(a.id)]));
  for (const pass of [1, 2, 5, 8]) {
    unchangedRefusal(mergeLines(settled, [a, b], pass, []), settled, "pass_out_of_order");
    unchangedRefusal(mergeLines(settled, [], pass, [filled(b.id)]), settled, "pass_out_of_order");
  }
  assert.equal(settled.find(line => line.id === a.id)!.closedPass, 9);
  assert.equal(settled.find(line => line.id === b.id)!.scope, "absent");
});

test("D2 exact repeated passes are idempotent while conflicting same-pass state is refused atomically", () => {
  const a = gap(); const b = gap("garden-consume-outcome");
  const initial = succeeded(mergeLines([], [a, b], 3, []));
  assert.deepEqual(succeeded(mergeLines(initial, [b, a], 3, [])), initial);
  unchangedRefusal(mergeLines(initial, [a], 3, []), initial, "pass_conflict");
  unchangedRefusal(mergeLines(initial, [a, b, gap("new-outcome")], 3, []), initial, "pass_conflict");
  const settled = succeeded(mergeLines(initial, [], 6, [filled(a.id)]));
  assert.deepEqual(succeeded(mergeLines(settled, [], 6, [filled(a.id)])), settled);
  unchangedRefusal(mergeLines(settled, [b], 6, [filled(a.id)]), settled, "pass_conflict");
  unchangedRefusal(mergeLines(settled, [], 6, [filled(a.id, fakeRef("different-frame"))]), settled, "pass_conflict");
});

test("D2 invalid closures refuse the complete batch instead of partly closing other lines", () => {
  const a = gap(); const b = gap("garden-consume-outcome");
  const previous = succeeded(mergeLines([], [a, b], 1, []));
  const invalid: unknown[] = [
    { ...filled(b.id), id: "unknown-line" },
    { id: b.id, basis: fakeRef("frame") },
    { ...filled(b.id), reason: "done" },
    { id: b.id, reason: "filled" },
    { ...filled(b.id), basis: { id: "frame", revision: 1 } },
    { ...filled(b.id), basis: { ...fakeRef("frame"), revision: 0 } },
    { ...filled(b.id), basis: { ...fakeRef("frame"), hash: "claimed" } },
    { ...filled(b.id), basis: null },
  ];
  for (const closure of invalid) {
    unchangedRefusal(mergeLines(previous, [], 2, [filled(a.id), closure as GapLineClosure]), previous, "closure_invalid");
  }
  unchangedRefusal(mergeLines(previous, [b], 2, [filled(a.id), filled(b.id)]), previous, "closure_invalid");
});

test("D2 duplicate lines, current gaps, and closures never collapse their multiplicity silently", () => {
  const a = gap(); const b = gap("garden-consume-outcome");
  const previous = succeeded(mergeLines([], [a, b], 1, []));
  const duplicatePrevious = [...previous, clone(previous[0]!)];
  unchangedRefusal(mergeLines(duplicatePrevious, [a], 2, []), duplicatePrevious, "gap_line_duplicate");
  unchangedRefusal(mergeLines(previous, [a, clone(a)], 2, []), previous, "gap_line_duplicate");
  unchangedRefusal(mergeLines(previous, [], 2, [filled(a.id), filled(a.id)]), previous, "gap_line_duplicate");
});

test("D2 rejects self-consistent shapes that claim impossible line history or closure state", () => {
  const source = gap(), original = succeeded(mergeLines([], [source], 2, []))[0]!;
  const invalid: GapLine[] = [
    { ...original, id: "arbitrary-line" }, { ...original, firstPass: 3 }, { ...original, statePass: 1 },
    { ...original, passes: 2 }, { ...original, reopened: 1 }, { ...original, status: "closed" },
    { ...original, basis: fakeRef("frame") }, { ...original, closedPass: 3 }, { ...original, scope: "absent" },
  ];
  for (const line of invalid) unchangedRefusal(mergeLines([line], [], 4, []), [line], "gap_line_invalid");
  unchangedRefusal(mergeLines([], [{ ...source, id: "arbitrary-gap" }], 1, []), [], "gap_line_invalid");
});

test("D2 malformed required arguments and line fields receive addressed boundary errors", () => {
  const source = gap(); const valid = succeeded(mergeLines([], [source], 1, []))[0]!;
  const invoke = mergeLines as unknown as (...args: unknown[]) => unknown;
  for (const args of [[undefined, [], 1, []], [[], undefined, 1, []], [[], [], 1, undefined],
    [null, [], 1, []], [[], {}, 1, []], [[], [], 1, {}], [[], [], undefined, []],
    [new Array(1), [], 1, []], [[], new Array(1), 1, []],
    ...[0, -1, 1.5, NaN, Infinity, "2"].map(pass => [[], [], pass, []])]) assert.throws(() => invoke(...args), malformed);
  for (const field of ["id", "target", "field", "firstPass", "lastPass", "statePass", "passes", "reopened", "status"] as const) {
    const line = clone(valid) as unknown as Record<string, unknown>; delete line[field];
    assert.throws(() => invoke([line], [], 2, []), malformed);
  }
  for (const field of ["id", "target", "field"] as const) {
    const missing = clone(source) as unknown as Record<string, unknown>; delete missing[field];
    assert.throws(() => invoke([], [missing], 1, []), malformed);
  }
});

test("D2 returns sealed independent snapshots without freezing or mutating caller objects", () => {
  const source = gap(); const initial = clone(succeeded(mergeLines([], [source], 1, []))) as GapLine[];
  const closure = filled(source.id); const before = canonical({ initial, source, closure });
  const closed = mergeLines(initial, [], 2, [closure]);
  assert.equal(canonical({ initial, source, closure }), before);
  assert.equal(Object.isFrozen(initial), false); assert.equal(Object.isFrozen(initial[0]), false);
  assert.equal(Object.isFrozen(closure), false); assert.equal(Object.isFrozen(closure.basis), false);
  assert.ok(Object.isFrozen(closed) && Object.isFrozen(closed.lines) && Object.isFrozen(closed.refusals));
  assert.ok(Object.isFrozen(closed.lines[0]) && Object.isFrozen(closed.lines[0]!.basis));
  const snapshot = canonical(closed);
  initial[0]!.target = "caller-change"; closure.basis.id = "caller-change"; source.evidence[0]!.value = "caller-change";
  assert.equal(canonical(closed), snapshot);
});

function ok<T>(value: OmResult<T>): T {
  if (!value.ok) assert.fail(`${value.refusal.code}: ${value.refusal.message}`);
  return value.value;
}
function denied(value: OmResult<unknown>, code?: string): Refusal {
  if (value.ok) assert.fail(`Expected ${code ?? "an addressed refusal"}, received success`);
  if (code) assert.equal(value.refusal.code, code);
  addressed(value.refusal); return value.refusal;
}
const historySnapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function firstPassFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-gap-lines-")), database = join(root, "state.sqlite");
  const store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph("cross"), { level: _level, ...upper } = projectGraph(graph, 1);
  preparedFeatures(new ProductEngine(store), "garden", upper as Graph);
  const input = ok(writeOmInput(store, { project: "garden", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const horizon = ok(writeHorizon(store, { project: "garden", input: reference(input), graph: reference(store.get("graph:garden")!),
    refinement: null, choice: { choiceVersion: "gap-lines-initial", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
  const frame: FrameRequest = { project: "garden", level: 2, graph: reference(store.get("graph:garden")!),
    horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  const sources: GapRequest = { project: "garden", input: reference(input), graph: frame.graph, horizon: frame.horizon,
    operations: { frame, proposals: [] }, works: { state: "upper-not-accepted", layer: reference(store.get("graph-layer:garden:2")!) } };
  const gaps = ok(writeGaps(store, sources));
  const initial: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  return { root, database, store, graph, frame, input: reference(input), gaps, initial,
    request: { project: "garden", previous: null, pass: 1, gaps: initial, closures: [] } as GapLinesRequest };
}
function acceptOperations(f: ReturnType<typeof firstPassFixture>) {
  const { store, frame, graph } = f;
  const current = ok(prepareFrame(store, frame)), projected = projectGraph(graph, 2);
  const mapped = ok(fillObligations(current.upper as Graph, current.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, current.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: projected.nodes.filter(node => node.kind === "operation"),
    fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const offered = reference(store.write({ id: "om-proposal:garden:gap-lines", kind: "layer-proposal", expected: 0, value: proposal }));
  const written = ok(writeCandidate(store, { frame, proposals: [offered] }));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") throw new Error("Expected an operations candidate");
  const candidate = reference(written.record);
  const accepted = ok(settleCandidate(store, { project: "garden", level: 2, candidate,
    outcome: { gate: "G3", candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } }));
  const acceptance: AcceptedFrameRequest = { project: "garden", level: 2, graph: reference(accepted.graph!), layer: reference(accepted.layer!), frame: reference(accepted.frame!) };
  const next = ok(writeHorizon(store, { project: "garden", input: f.input, graph: acceptance.graph, refinement: acceptance.layer,
    choice: { choiceVersion: "gap-lines-accepted", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
  const operations: FrameRequest = { project: "garden", level: 2, graph: acceptance.graph, horizon: reference(next.gate),
    layer: acceptance.layer, frame: acceptance.frame, upper: null };
  const sources: GapRequest = { project: "garden", input: f.input, graph: acceptance.graph, horizon: reference(next.gate),
    operations: { frame: operations, proposals: [] }, works: { proposals: [], frame: { ...operations, level: 3, layer: null, frame: null,
      upper: { horizon: reference(next.gate), frame: acceptance.frame } } } };
  const saved = ok(writeGaps(store, sources));
  const gaps: GapReadRequest = { sources: structuredClone(saved.sources) as GapRequest, records: saved.records.map(reference) };
  const line = f.gaps.collection.gaps.find(item => item.field === "fill" && item.evidence.some(evidence => evidence.origin === "operations"))!;
  assert.ok(line); assert.ok(!saved.collection.gaps.some(item => item.id === line.id));
  const closure: GapClosureRequest = { id: line.id, reason: "filled", basis: acceptance.frame, acceptance, attempt: null };
  return { accepted, acceptance, candidate, gaps, closure, line };
}

test("D2 native first pass persists complete D1 lines without accepting disappearance as closure", t => {
  const f = firstPassFixture(t), before = historySnapshot(f.store);
  const prepared = ok(prepareGapLines(f.store, f.request));
  assert.deepEqual(historySnapshot(f.store), before); assert.equal(prepared.existing, null);
  assert.equal(prepared.writes.length, 1); assert.equal(prepared.writes[0]!.kind, GAP_LINE_KIND);
  assert.equal(prepared.writes[0]!.id, gapLinesId("garden")); assert.equal(prepared.writes[0]!.expected, 0);
  assert.equal(prepared.record.lines.length, f.gaps.collection.gaps.length);
  const first = ok(writeGapLines(f.store, f.request));
  assert.deepEqual(first.value, prepared.record); assert.equal(first.revision, 1);
  assert.deepEqual(ok(readGapLines(f.store, { project: "garden", record: reference(first) })), first);
  const afterFirst = historySnapshot(f.store);
  assert.deepEqual(ok(writeGapLines(f.store, f.request)), first); assert.deepEqual(historySnapshot(f.store), afterFirst);
  const next = acceptOperations(f);
  const absentRequest: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps };
  const absent = ok(writeGapLines(f.store, absentRequest));
  const line = absent.value.lines.find(item => item.id === next.line.id)!;
  assert.equal(line.status, "deferred"); assert.equal(line.scope, "absent"); assert.equal(line.basis, undefined);
  assert.equal(line.passes, 1); assert.equal(line.lastPass, 1); assert.equal(line.statePass, 2); assert.equal(line.reopened, 0);
  const request: GapLinesRequest = { ...absentRequest, previous: reference(absent), pass: 3, closures: [next.closure] };
  const closurePreparation = ok(prepareGapLines(f.store, request)), beforeClose = historySnapshot(f.store);
  assert.equal(closurePreparation.writes.length, 1); assert.equal(closurePreparation.writes[0]!.expected, 2);
  assert.deepEqual(historySnapshot(f.store), beforeClose);
  const closed = ok(writeGapLines(f.store, request));
  const finalLine = closed.value.lines.find(item => item.id === next.line.id)!;
  assert.equal(finalLine.status, "closed"); assert.equal(finalLine.closedBy, "filled"); assert.equal(finalLine.closedPass, 3);
  assert.equal(finalLine.statePass, 3); assert.equal(finalLine.lastPass, 1); assert.deepEqual(finalLine.basis, next.acceptance.frame);
  assert.equal(finalLine.scope, undefined); assert.equal(finalLine.reopened, 0);
  assert.ok(closed.value.lines.some(item => item.status === "open" && item.target === "repo-inventory"));
  assert.deepEqual(ok(readGapLines(f.store, { project: "garden", record: reference(closed) })), closed);
  const unbound = denied(confirmResults(f.store, { project: "garden", block: next.line.consumers[0]!, target: "unbound-result",
    goal: goalFor(next.line), accepting: [reference(closed)], cancelling: [] }), "achievement_unconfirmed");
  assert.match(unbound.message, /closure_unconfirmed/);
  const beforeReplay = historySnapshot(f.store);
  assert.deepEqual(ok(writeGapLines(f.store, request)), closed);
  assert.deepEqual(ok(writeGapLines(f.store, f.request)), first);
  assert.deepEqual(historySnapshot(f.store), beforeReplay);
});

test("D2 saved filled closures remain readable and replayable after heads drift and the Store restarts", t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request)), next = acceptOperations(f);
  const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps, closures: [next.closure] };
  const saved = ok(writeGapLines(f.store, request));
  for (const ref of [next.acceptance.graph, next.acceptance.layer, next.acceptance.frame, reference(f.store.get("source:garden:brief")!)]) {
    const row = f.store.get(ref.id)!;
    f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  }
  const reopened = new Store(f.database);
  try {
    const before = historySnapshot(reopened);
    assert.deepEqual(ok(readGapLines(reopened, { project: "garden", record: reference(saved) })), saved);
    assert.deepEqual(ok(readGapLines(reopened, { project: "garden", record: reference(first) })), first);
    assert.deepEqual(ok(writeGapLines(reopened, request)), saved);
    denied(prepareGapLines(reopened, { ...request, previous: reference(saved), pass: 3, closures: [] }));
    assert.deepEqual(historySnapshot(reopened), before);
  } finally { reopened.close(); }
});

test("D2 refuses invalid closure authority and exact-source masks without changing any line", t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request)), next = acceptOperations(f);
  const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps, closures: [next.closure] };
  const inventory = first.value.lines.find(item => item.target === "repo-inventory")!;
  const variants: GapClosureRequest[] = [
    { ...next.closure, reason: "cancelled" },
    { ...next.closure, acceptance: null },
    { ...next.closure, basis: next.candidate },
    { ...next.closure, acceptance: { ...next.acceptance, project: "other" } },
    { ...next.closure, acceptance: { ...next.acceptance, frame: { ...next.acceptance.frame, hash: "0".repeat(64) } }, basis: { ...next.acceptance.frame, hash: "0".repeat(64) } },
    { ...next.closure, acceptance: { ...next.acceptance, graph: { ...next.acceptance.graph, hash: "0".repeat(64) } } },
    { ...next.closure, id: inventory.id },
  ];
  const before = historySnapshot(f.store);
  for (const closure of variants) {
    for (const operation of [prepareGapLines, writeGapLines]) denied(operation(f.store, { ...request, closures: [closure] }));
    assert.deepEqual(historySnapshot(f.store), before);
  }
  for (const operation of [prepareGapLines, writeGapLines]) {
    denied(operation(f.store, { ...request, closures: [{ ...next.closure, reason: "cancelled" }] }), "closure_unsupported");
    denied(operation(f.store, { ...request, previous: { ...reference(first), hash: "0".repeat(64) } }), "input_stale");
    denied(operation(f.store, { ...request, gaps: { ...next.gaps, records: [] } }));
    denied(operation(f.store, { ...request, gaps: { ...next.gaps, records: [...next.gaps.records, next.gaps.records[0]!] } }));
  }
  assert.deepEqual(historySnapshot(f.store), before);
});

test("D2 historical reader rejects rehashed missing lines, status claims and broken predecessor links", async t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request)), next = acceptOperations(f);
  const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps, closures: [next.closure] };
  const beforeClosure = await f.store.snapshot(join(f.root, "before-valid-closure"));
  const closed = ok(writeGapLines(f.store, request));
  const validNext = ok(prepareGapLines(f.store, { ...request, previous: reference(closed), pass: 3, closures: [] })).record;
  const saved = await f.store.snapshot(join(f.root, "valid-history"));
  const forgeries: Array<(record: GapLinesRecord) => void> = [
    record => { record.lines.pop(); },
    record => { record.lines.find(item => item.id === next.line.id)!.passes += 1; },
    record => { record.request.previous = null; },
  ];
  for (const [index, forge] of forgeries.entries()) {
    const path = join(f.root, `forged-${index}.sqlite`); copyFileSync(saved.path, path);
    const store = new Store(path);
    try {
      const value = clone(validNext) as GapLinesRecord; forge(value);
      const forged = store.write({ id: closed.id, kind: GAP_LINE_KIND, expected: closed.revision, value });
      const before = historySnapshot(store);
      denied(readGapLines(store, { project: "garden", record: reference(forged) }));
      denied(prepareGapLines(store, { ...request, previous: reference(forged), pass: 3, closures: [] }));
      assert.deepEqual(ok(readGapLines(store, { project: "garden", record: reference(closed) })), closed);
      assert.deepEqual(historySnapshot(store), before);
    } finally { store.close(); }
  }
  const badClosurePath = join(f.root, "forged-closure.sqlite"); copyFileSync(beforeClosure.path, badClosurePath);
  const badClosureStore = new Store(badClosurePath);
  try {
    const value = clone(closed.value) as GapLinesRecord;
    value.request.closures[0]!.basis.hash = "0".repeat(64);
    value.request.closures[0]!.acceptance!.frame.hash = "0".repeat(64);
    value.lines.find(line => line.id === next.line.id)!.basis!.hash = "0".repeat(64);
    const forged = badClosureStore.write({ id: closed.id, kind: GAP_LINE_KIND, expected: 1, value });
    const before = historySnapshot(badClosureStore);
    denied(readGapLines(badClosureStore, { project: "garden", record: reference(forged) }));
    denied(prepareGapLines(badClosureStore, { ...request, previous: reference(forged), pass: 3, closures: [] }));
    assert.deepEqual(ok(readGapLines(badClosureStore, { project: "garden", record: reference(first) })), first);
    assert.deepEqual(historySnapshot(badClosureStore), before);
  } finally { badClosureStore.close(); }
  denied(readGapLines(f.store, { project: "other", record: reference(closed) }));
  denied(readGapLines(f.store, { project: "garden", record: { ...reference(closed), hash: "0".repeat(64) } }));
});

test("D2 prepared closure guards sources, accepted filling, and prior history in a neighbor transaction", async t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request)), next = acceptOperations(f);
  const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps, closures: [next.closure] };
  const prepared = ok(prepareGapLines(f.store, request));
  const dependencies = [reference(first), next.acceptance.graph, next.acceptance.layer, next.acceptance.frame,
    next.gaps.records[0]!, reference(f.store.get("source:garden:brief")!)];
  for (const dependency of dependencies) assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(dependency)), `Missing ${dependency.id}`);
  const saved = await f.store.snapshot(join(f.root, "before-closure"));
  for (const [index, dependency] of dependencies.entries()) {
    const path = join(f.root, `closure-race-${index}.sqlite`); copyFileSync(saved.path, path);
    const store = new Store(path);
    try {
      const row = store.get(dependency.id)!;
      store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      const changed = historySnapshot(store);
      denied(writeGuarded(store, { unit: "D2-neighbor", target: "gap-line-closure", guards: prepared.guards,
        writes: [...prepared.writes, { id: "neighbor:gap-line", kind: "neighbor", expected: 0, value: { status: "done" } }] }), "input_stale");
      assert.equal(store.get("neighbor:gap-line"), null); assert.deepEqual(historySnapshot(store), changed);
    } finally { store.close(); }
  }
});

test("D2 saved paths require explicit source sets and closure contexts and keep rejected requests read-only", t => {
  const f = firstPassFixture(t), before = historySnapshot(f.store);
  for (const field of ["project", "previous", "pass", "gaps", "closures"] as const) {
    const request = clone(f.request) as unknown as Record<string, unknown>; delete request[field];
    for (const operation of [prepareGapLines, writeGapLines]) assert.throws(() => operation(f.store, request as unknown as GapLinesRequest), malformed);
  }
  const missingRecords = clone(f.request) as unknown as { gaps: Record<string, unknown> }; delete missingRecords.gaps["records"];
  assert.throws(() => prepareGapLines(f.store, missingRecords as unknown as GapLinesRequest), malformed);
  for (const operation of [prepareGapLines, writeGapLines]) {
    assert.throws(() => operation(f.store, { ...f.request, gaps: { ...f.request.gaps, records: new Array<Ref>(1) } }), malformed);
  }
  for (const field of ["acceptance", "attempt", "basis", "reason", "id"] as const) {
    const closure = { id: f.gaps.collection.gaps[0]!.id, reason: "filled", basis: fakeRef("om-frame:garden:2"), acceptance: null, attempt: null } as Record<string, unknown>;
    delete closure[field];
    assert.throws(() => prepareGapLines(f.store, { ...f.request, closures: [closure as unknown as GapClosureRequest] }), malformed);
  }
  assert.deepEqual(historySnapshot(f.store), before);
});

test("D5 answer bases cannot close a gap still present in the complete D1 source, including pending answers", t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request));
  const line = first.value.lines[0]!;
  const pending = { id: "accepted-answer:garden:pending-line", kind: "accepted-answer", expected: 0, value: { claim: "not authority" } };
  const basis = { id: pending.id, revision: 1, hash: hashJson(pending.value) };
  const before = historySnapshot(f.store);
  for (const answer of [{ record: basis }, { pending }]) {
    const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2,
      closures: [{ id: line.id, reason: "filled", basis, acceptance: null, attempt: null, answer }] };
    for (const operation of [prepareGapLines, writeGapLines]) denied(operation(f.store, request), "closure_invalid");
    assert.equal(f.store.get(pending.id), null);
    assert.deepEqual(historySnapshot(f.store), before);
  }
});

test("D5 answer closure envelopes retain exact identity and reject mixed producers or incomplete pending records", t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request)), next = acceptOperations(f);
  const record = fakeRef("accepted-answer:garden:line");
  const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps,
    closures: [{ ...next.closure, acceptance: null, answer: { record }, basis: record }] };
  const before = historySnapshot(f.store);
  for (const operation of [prepareGapLines, writeGapLines]) {
    denied(operation(f.store, { ...request, closures: [{ ...request.closures[0]!, basis: fakeRef("accepted-answer:garden:another") }] }), "closure_unconfirmed");
    denied(operation(f.store, { ...request, closures: [{ ...request.closures[0]!, acceptance: next.acceptance }] }), "closure_unconfirmed");
    for (const answer of [null, {}, { record: null }, { record, pending: {} }, { pending: { id: record.id, kind: "accepted-answer", expected: 0 } },
      { pending: { id: record.id, kind: "accepted-answer", expected: 1, value: {} } }]) {
      const closure = { ...request.closures[0]!, answer } as unknown as GapClosureRequest;
      assert.throws(() => operation(f.store, { ...request, closures: [closure] }), malformed);
    }
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    for (const value of [() => "claim", { unsupported: undefined }, cyclic]) {
      const closure: GapClosureRequest = { ...request.closures[0]!,
        answer: { pending: { id: record.id, kind: "accepted-answer", expected: 0, value } } };
      assert.throws(() => operation(f.store, { ...request, closures: [closure] }), malformed);
    }
    assert.deepEqual(historySnapshot(f.store), before);
  }
});

test("D2 saved replay normalizes the complete source proposal sets and gap reference order", t => {
  const f = firstPassFixture(t);
  const proposal: LayerProposal = { base: { graph: f.frame.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], joins: [], anchors: [], tests: [],
    edges: [], journeys: [], packets: [], transfers: [], removes: [], replaces: [], redefines: [] };
  const proposals = ["a", "b"].map(name => reference(f.store.write({ id: `om-proposal:garden:line-order-${name}`,
    kind: "layer-proposal", expected: 0, value: proposal })));
  const sources: GapRequest = { ...f.initial.sources, operations: { frame: f.frame, proposals } };
  const gaps = ok(writeGaps(f.store, sources));
  const request: GapLinesRequest = { ...f.request, gaps: { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) } };
  const saved = ok(writeGapLines(f.store, request)), before = historySnapshot(f.store);
  const reordered: GapLinesRequest = { ...request, gaps: { sources: { ...request.gaps.sources,
    operations: { ...request.gaps.sources.operations, proposals: [...proposals].reverse() } },
    records: [...request.gaps.records].reverse() } };
  const prepared = ok(prepareGapLines(f.store, reordered));
  assert.deepEqual(prepared.existing, saved); assert.deepEqual(prepared.writes, []);
  assert.deepEqual(ok(writeGapLines(f.store, reordered)), saved); assert.deepEqual(historySnapshot(f.store), before);
});

function goalFor(line: Pick<GapLine, "target" | "field">): AttemptGoal {
  return { key: `goal:${gapLineKey("garden", line.target, line.field)}`,
    questions: [gapLineKey("garden", line.target, line.field)], result: gapLineExpectedResult("garden", line.target, line.field) };
}
function openAttempt(store: Store, address: SeriesRequest, goal: AttemptGoal) {
  ok(openSeries(store, { ...address, slice: "operations", predecessor: null, basis: null }));
  return ok(beginAttempt(store, { ...address, attempt: 1, goal }));
}

test("D2 verifies the exact earlier attempt goal and retains that historical link after completion and restart", t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request));
  const oldGap = f.gaps.collection.gaps.find(item => item.field === "fill" && item.evidence.some(evidence => evidence.origin === "operations"))!;
  const obligation = ok(prepareFrame(f.store, f.frame)).result.obligations.find(item => item.id === oldGap.target)!;
  const address: SeriesRequest = { project: "garden", block: obligation.upper.node, line: 1 };
  const initialGoal = goalFor(oldGap), goal = { ...initialGoal, questions: [...initialGoal.questions, "additional-goal-question"] };
  const attempt = openAttempt(f.store, address, goal), next = acceptOperations(f);
  assert.equal(next.line.id, oldGap.id);
  const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps,
    closures: [{ ...next.closure, attempt: { series: reference(attempt), attempt: 1 } }] };
  const prepared = ok(prepareGapLines(f.store, request));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(attempt))));
  const saved = ok(writeGapLines(f.store, request));
  const resultRequest = { project: "garden", block: address.block, target: attempt.id, goal, accepting: [reference(saved)], cancelling: [] };
  const confirmed = ok(confirmResults(f.store, resultRequest));
  const identity = ok(readResultIdentity(f.store, { acceptance: next.acceptance, obligation: oldGap.target }));
  assert.deepEqual(confirmed, { achieved: [{ key: identity.key, basis: reference(saved) }], cancelled: [] });
  assert.deepEqual(ok(confirmResults(f.store, { ...resultRequest, goal: { ...goal, questions: [...goal.questions].reverse() } })), confirmed);
  denied(confirmResults(f.store, { ...resultRequest, accepting: [next.candidate] }), "achievement_unconfirmed");
  for (const context of [{ ...resultRequest, block: "garden-unrelated-block" },
    { ...resultRequest, goal: { ...goal, key: "different-full-goal" } },
    { ...resultRequest, goal: { ...goal, result: "different-result" } }]) {
    const refused = denied(confirmResults(f.store, context), "achievement_unconfirmed");
    assert.match(refused.message, /closure_unconfirmed/);
  }
  const result = ok(closeAttempt(f.store, { ...address, attempt: 1,
    outcome: { reason: "result", accepting: [reference(saved)], cancelling: [], refusals: [] } }));
  assert.equal(result.verdict, "progress"); assert.equal(result.withoutProgress, 0);
  ok(beginAttempt(f.store, { ...address, attempt: 2, goal }));
  const repeated = ok(closeAttempt(f.store, { ...address, attempt: 2,
    outcome: { reason: "result", accepting: [reference(saved)], cancelling: [], refusals: [] } }));
  assert.equal(repeated.verdict, "none"); assert.equal(repeated.withoutProgress, 1);
  assert.notDeepEqual(reference(ok(readSeries(f.store, address))), reference(attempt));
  const reopened = new Store(f.database);
  try {
    const before = historySnapshot(reopened);
    assert.deepEqual(ok(readGapLines(reopened, { project: "garden", record: reference(saved) })), saved);
    assert.deepEqual(ok(writeGapLines(reopened, request)), saved);
    assert.deepEqual(ok(confirmResults(reopened, resultRequest)), confirmed);
    assert.equal(ok(readResultIdentity(reopened, { acceptance: next.acceptance, obligation: oldGap.target })).key, identity.key);
    denied(confirmResults(reopened, { ...resultRequest, accepting: [], cancelling: [reference(saved)] }), "cancellation_unconfirmed");
    assert.deepEqual(historySnapshot(reopened), before);
  } finally { reopened.close(); }
});

test("D2 unrelated attempts and a shifted series cannot close a line or partially write a neighbor", async t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request)), next = acceptOperations(f);
  const block = ok(prepareFrame(f.store, next.gaps.sources.operations.frame)).result.obligations.find(item => item.id === next.line.target)!.upper.node;
  const goal = goalFor(next.line), saved = await f.store.snapshot(join(f.root, "before-attempt"));
  const cases: Array<{ project?: string; block?: string; goal?: AttemptGoal; ordinal?: number; corruptHash?: boolean }> = [
    { project: "other" }, { block: "garden-other-block" },
    { goal: { ...goal, questions: ["another-question"] } },
    { goal: { ...goal, result: "another-result" } },
    { ordinal: 2 }, { corruptHash: true },
  ];
  for (const [index, variant] of cases.entries()) {
    const path = join(f.root, `bad-attempt-${index}.sqlite`); copyFileSync(saved.path, path);
    const store = new Store(path);
    try {
      const address = { project: variant.project ?? "garden", block: variant.block ?? block, line: 1 };
      const attempt = openAttempt(store, address, variant.goal ?? goal);
      const series = variant.corruptHash ? { ...reference(attempt), hash: "0".repeat(64) } : reference(attempt);
      const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps,
        closures: [{ ...next.closure, attempt: { series, attempt: variant.ordinal ?? 1 } }] };
      const before = historySnapshot(store);
      for (const operation of [prepareGapLines, writeGapLines]) denied(operation(store, request));
      assert.deepEqual(historySnapshot(store), before);
    } finally { store.close(); }
  }
  const address = { project: "garden", block, line: 1 }, attempt = openAttempt(f.store, address, goal);
  const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: next.gaps,
    closures: [{ ...next.closure, attempt: { series: reference(attempt), attempt: 1 } }] };
  const prepared = ok(prepareGapLines(f.store, request));
  ok(completeAttempt(f.store, { ...address, attempt: 1, outcome: { reason: "interrupted", achieved: [], cancelled: [], refusals: [] } }));
  const before = historySnapshot(f.store);
  denied(writeGuarded(f.store, { unit: "D2-neighbor", target: "bound-attempt", guards: prepared.guards,
    writes: [...prepared.writes, { id: "neighbor:bound-attempt", kind: "neighbor", expected: 0, value: {} }] }), "input_stale");
  denied(writeGapLines(f.store, request), "input_stale");
  assert.equal(f.store.get("neighbor:bound-attempt"), null); assert.deepEqual(historySnapshot(f.store), before);
});

/** Replace one accepted operation by a real C3/C4/C5 proposal; D1 then observes the resulting current frame. */
function replaceOperationResult(f: ReturnType<typeof firstPassFixture>, frame: FrameRequest, obligation: string,
  code: Graph["nodes"][number]["code"], version: string) {
  const current = ok(prepareFrame(f.store, frame));
  const endpoint = current.result.fills.find(fill => fill.obligation === obligation)!;
  assert.ok(endpoint);
  const node = clone(current.accepted!.graph.nodes.find(node => node.id === endpoint.node)!) as Graph["nodes"][number];
  node.code = clone(code);
  const rows = current.result.fills.filter(fill => fill.node === node.id);
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: frame.frame }, level: 2, source: "decision", status: "proposed",
    nodes: [node], fills: rows.map(fill => ({ obligation: fill.obligation, node: node.id, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], anchors: [], tests: [], edges: [], journeys: [], packets: [], transfers: [],
    removes: [node.id], redefines: [], replaces: rows.map(fill => ({ obligation: fill.obligation, base: { node: node.id, graph: frame.graph },
      with: { node: node.id, port: fill.port ?? null }, basis: "Accepted implementation of this same obligation" })) };
  const offered = reference(f.store.write({ id: `om-proposal:garden:gap-line-result-${version}`, kind: "layer-proposal", expected: 0, value: proposal }));
  const written = ok(writeCandidate(f.store, { frame, proposals: [offered] }));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") throw new Error("Expected candidate");
  const candidate = reference(written.record);
  const accepted = ok(settleCandidate(f.store, { project: "garden", level: 2, candidate,
    outcome: { gate: "G3", candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } }));
  const acceptance: AcceptedFrameRequest = { project: "garden", level: 2, graph: reference(accepted.graph!), layer: reference(accepted.layer!), frame: reference(accepted.frame!) };
  const horizon = ok(writeHorizon(f.store, { project: "garden", input: f.input, graph: acceptance.graph, refinement: acceptance.layer,
    choice: { choiceVersion: `gap-line-result-${version}`, features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
  const operations: FrameRequest = { ...acceptance, horizon: reference(horizon.gate), upper: null };
  const sources: GapRequest = { project: "garden", input: f.input, graph: acceptance.graph, horizon: operations.horizon,
    operations: { frame: operations, proposals: [] }, works: { proposals: [], frame: { ...operations, level: 3, layer: null, frame: null,
      upper: { horizon: operations.horizon, frame: acceptance.frame } } } };
  const saved = ok(writeGaps(f.store, sources));
  assert.ok(!saved.collection.gaps.some(gap => gap.target === obligation && gap.field === "fill"));
  return { acceptance, gaps: { sources: structuredClone(saved.sources) as GapRequest, records: saved.records.map(reference) } as GapReadRequest };
}

test("D2 real C5→D1→D2→G7 A→B→A keeps a closed line and counts only new semantic results after restart", t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request));
  const obligation = ok(prepareFrame(f.store, f.frame)).result.obligations
    .find(item => item.kind === "block-outcome" && item.upper.node === "garden-produce-block")!;
  const line = first.value.lines.find(item => item.target === obligation.id && item.field === "fill")!;
  assert.ok(line);
  const address = { project: "garden", block: obligation.upper.node, line: 1 }, goal = goalFor(line);
  const firstAttempt = openAttempt(f.store, address, goal), a = acceptOperations(f);
  const requestA: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: a.gaps,
    closures: [{ id: line.id, reason: "filled", basis: a.acceptance.frame, acceptance: a.acceptance,
      attempt: { series: reference(firstAttempt), attempt: 1 } }] };
  const closedA = ok(writeGapLines(f.store, requestA));
  const keyA = ok(readResultIdentity(f.store, { acceptance: a.acceptance, obligation: line.target })).key;
  const confirmedA = ok(confirmResults(f.store, { ...address, target: firstAttempt.id, goal, accepting: [reference(closedA)], cancelling: [] }));
  assert.deepEqual(confirmedA.achieved.map(item => item.key), [keyA]);
  assert.equal(ok(closeAttempt(f.store, { ...address, attempt: 1,
    outcome: { reason: "result", accepting: [reference(closedA)], cancelling: [], refusals: [] } })).verdict, "progress");

  const secondAttempt = ok(beginAttempt(f.store, { ...address, attempt: 2, goal }));
  const b = replaceOperationResult(f, a.gaps.sources.operations.frame, line.target,
    [{ path: "src/structural-result-b.ts", access: "read", status: "existing" }], "B");
  const requestB: GapLinesRequest = { ...requestA, previous: reference(closedA), pass: 4, gaps: b.gaps,
    closures: [{ id: line.id, reason: "filled", basis: b.acceptance.frame, acceptance: b.acceptance,
      attempt: { series: reference(secondAttempt), attempt: 2 } }] };
  const preparedB = ok(prepareGapLines(f.store, requestB));
  for (const ref of [reference(closedA), reference(secondAttempt), b.acceptance.graph, b.acceptance.layer, b.acceptance.frame])
    assert.ok(preparedB.guards.some(item => canonical(item) === canonical(ref)), ref.id);
  const closedB = ok(writeGapLines(f.store, requestB));
  const valueA = closedA.value.lines.find(item => item.id === line.id)!, valueB = closedB.value.lines.find(item => item.id === line.id)!;
  assert.deepEqual(valueB, { ...valueA, basis: b.acceptance.frame, closedPass: 4, statePass: 4 });
  const keyB = ok(readResultIdentity(f.store, { acceptance: b.acceptance, obligation: line.target })).key;
  assert.notEqual(keyB, keyA);
  assert.deepEqual(ok(confirmResults(f.store, { ...address, target: secondAttempt.id, goal,
    accepting: [reference(closedB)], cancelling: [] })).achieved.map(item => item.key), [keyB]);
  const changed = ok(closeAttempt(f.store, { ...address, attempt: 2,
    outcome: { reason: "result", accepting: [reference(closedB)], cancelling: [], refusals: [] } }));
  assert.equal(changed.verdict, "progress"); assert.equal(changed.withoutProgress, 0);
  const beforeReplay = historySnapshot(f.store);
  assert.deepEqual(ok(writeGapLines(f.store, requestA)), closedA);
  assert.deepEqual(historySnapshot(f.store), beforeReplay);

  f.store.close(); const reopened = new Store(f.database); t.after(() => reopened.close());
  const afterRestart = historySnapshot(reopened);
  for (const saved of [closedA, closedB]) assert.deepEqual(ok(readGapLines(reopened, { project: "garden", record: reference(saved) })), saved);
  assert.deepEqual(ok(writeGapLines(reopened, requestA)), closedA);
  assert.deepEqual(ok(writeGapLines(reopened, requestB)), closedB);
  assert.deepEqual(historySnapshot(reopened), afterRestart);
  const thirdAttempt = ok(beginAttempt(reopened, { ...address, attempt: 3, goal }));
  const restored = replaceOperationResult({ ...f, store: reopened }, b.gaps.sources.operations.frame, line.target, [], "A-restored");
  const restoredRequest: GapLinesRequest = { ...requestB, previous: reference(closedB), pass: 6, gaps: restored.gaps,
    closures: [{ id: line.id, reason: "filled", basis: restored.acceptance.frame, acceptance: restored.acceptance,
      attempt: { series: reference(thirdAttempt), attempt: 3 } }] };
  const restoredLine = ok(writeGapLines(reopened, restoredRequest));
  assert.deepEqual(restoredLine.value.lines.find(item => item.id === line.id), { ...valueA, basis: restored.acceptance.frame, closedPass: 6, statePass: 6 });
  assert.equal(ok(readResultIdentity(reopened, { acceptance: restored.acceptance, obligation: line.target })).key, keyA);
  assert.deepEqual(ok(confirmResults(reopened, { ...address, target: thirdAttempt.id, goal,
    accepting: [reference(restoredLine)], cancelling: [] })).achieved.map(item => item.key), [keyA]);
  const returned = ok(closeAttempt(reopened, { ...address, attempt: 3,
    outcome: { reason: "result", accepting: [reference(restoredLine)], cancelling: [], refusals: [] } }));
  assert.equal(returned.verdict, "none"); assert.equal(returned.withoutProgress, 1);
  const beforeRefusal = historySnapshot(reopened);
  for (const operation of [prepareGapLines, writeGapLines]) {
    denied(operation(reopened, { ...requestB, closures: requestA.closures }), "pass_conflict");
    denied(operation(reopened, { ...restoredRequest, pass: 3 }), "pass_out_of_order");
  }
  assert.deepEqual(ok(writeGapLines(reopened, requestA)), closedA);
  assert.deepEqual(ok(readGapLines(reopened, { project: "garden", record: reference(closedB) })), closedB);
  assert.deepEqual(historySnapshot(reopened), beforeRefusal);
});

test("D2 historical closure stays bound to its saved D1 context on replay, confirmation and restart", t => {
  const f = firstPassFixture(t), first = ok(writeGapLines(f.store, f.request));
  const obligation = ok(prepareFrame(f.store, f.frame)).result.obligations
    .find(item => item.kind === "block-outcome" && item.upper.node === "garden-produce-block")!;
  const line = first.value.lines.find(item => item.target === obligation.id && item.field === "fill")!;
  const address = { project: "garden", block: obligation.upper.node, line: 1 }, goal = goalFor(line);
  const firstAttempt = openAttempt(f.store, address, goal), a = acceptOperations(f);
  const requestA: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: a.gaps,
    closures: [{ id: line.id, reason: "filled", basis: a.acceptance.frame, acceptance: a.acceptance,
      attempt: { series: reference(firstAttempt), attempt: 1 } }] };
  const closedA = ok(writeGapLines(f.store, requestA));
  ok(closeAttempt(f.store, { ...address, attempt: 1,
    outcome: { reason: "result", accepting: [reference(closedA)], cancelling: [], refusals: [] } }));
  const secondAttempt = ok(beginAttempt(f.store, { ...address, attempt: 2, goal }));
  const b = replaceOperationResult(f, a.gaps.sources.operations.frame, line.target,
    [{ path: "src/B.ts", access: "read", status: "existing" }], "context-B");
  const requestB: GapLinesRequest = { ...requestA, previous: reference(closedA), pass: 4, gaps: b.gaps,
    closures: [{ id: line.id, reason: "filled", basis: b.acceptance.frame, acceptance: b.acceptance,
      attempt: { series: reference(secondAttempt), attempt: 2 } }] };
  const closedB = ok(writeGapLines(f.store, requestB));
  const bad: GapLinesRequest = { ...clone(closedB.value.request) as GapLinesRequest, previous: reference(closedB), pass: 6,
    closures: [{ ...requestB.closures[0]!, basis: a.acceptance.frame, acceptance: a.acceptance }] };
  assert.notDeepEqual(bad.gaps.sources.operations.frame.graph, bad.closures[0]!.acceptance!.graph);
  const beforeAdmission = historySnapshot(f.store);
  for (const operation of [prepareGapLines, writeGapLines])
    assert.equal(denied(operation(f.store, bad), "closure_unconfirmed").at.field, "acceptance");
  assert.deepEqual(historySnapshot(f.store), beforeAdmission);

  // Each source is genuine, and the forged snapshot has correctly rederived lines and a new hash.
  const gaps = ok(readGaps(f.store, bad.gaps));
  const lines = succeeded(mergeLines(clone(closedB.value.lines) as GapLine[], clone(gaps.collection.gaps) as Gap[], bad.pass, bad.closures));
  const forged = f.store.write({ id: closedB.id, kind: GAP_LINE_KIND, expected: closedB.revision,
    value: { project: "garden", request: bad, lines } as GapLinesRecord });
  const check = (store: Store) => {
    const before = historySnapshot(store);
    assert.equal(denied(readGapLines(store, { project: "garden", record: reference(forged) }), "closure_unconfirmed").at.field, "acceptance");
    for (const operation of [prepareGapLines, writeGapLines]) denied(operation(store, bad), "closure_unconfirmed");
    const confirmation = denied(confirmResults(store, { ...address, target: secondAttempt.id, goal,
      accepting: [reference(forged)], cancelling: [] }), "achievement_unconfirmed");
    assert.match(confirmation.message, /closure_unconfirmed.*saved D1 context/);
    for (const operation of [prepareCloseAttempt, closeAttempt]) denied(operation(store, { ...address, attempt: 2,
      outcome: { reason: "result", accepting: [reference(forged)], cancelling: [], refusals: [] } }), "achievement_unconfirmed");
    for (const saved of [closedA, closedB])
      assert.deepEqual(ok(readGapLines(store, { project: "garden", record: reference(saved) })), saved);
    assert.equal(ok(confirmResults(store, { ...address, target: secondAttempt.id, goal,
      accepting: [reference(closedB)], cancelling: [] })).achieved.length, 1);
    assert.deepEqual(historySnapshot(store), before);
  };
  check(f.store);
  for (const ref of [b.acceptance.graph, b.acceptance.layer, b.acceptance.frame, reference(f.store.get("source:garden:brief")!)]) {
    const row = f.store.get(ref.id)!;
    f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  }
  const restarted = new Store(f.database);
  try { check(restarted); } finally { restarted.close(); }
});

async function producePreF5ResultHistory() {
  // Only the child loader exports these helpers, from the immutable old test source.
  const fixture = await import('./om-gap-lines.test.js') as unknown as {
    firstPassFixture: typeof firstPassFixture; acceptOperations: typeof acceptOperations;
    goalFor: typeof goalFor; openAttempt: typeof openAttempt;
  };
  const { canonical } = await import('../src/canonical.js');
  const { reference } = await import('../src/pipeline/contracts.js');
  const { prepareFrame } = await import('../src/om/frame-obligations.js');
  const { writeGapLines, readGapLines } = await import('../src/om/gap-lines.js');
  const { readResultIdentity } = await import('../src/om/result-identity.js');
  const { confirmResults } = await import('../src/om/achievements.js');
  const { beginAttempt, readSeries } = await import('../src/om/series.js');
  const { closeAttempt } = await import('../src/om/repeat-gate.js');
  const { rmSync } = await import('node:fs');
  const take = <T>(result: OmResult<T>): T => {
    if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.message}`);
    return result.value;
  };
  const f = fixture.firstPassFixture({ after() {} } as unknown as TestContext);
  let complete = false;
  try {
    const first = take(writeGapLines(f.store, f.request));
    const line = f.gaps.collection.gaps.find(item => item.field === 'fill'
      && item.evidence.some(evidence => evidence.origin === 'operations'))!;
    const obligation = take(prepareFrame(f.store, f.frame)).result.obligations.find(item => item.id === line.target)!;
    const address = { project: 'garden', block: obligation.upper.node, line: 1 };
    const goal = fixture.goalFor(line), attempt = fixture.openAttempt(f.store, address, goal);
    const accepted = fixture.acceptOperations(f);
    const request: GapLinesRequest = { ...f.request, previous: reference(first), pass: 2, gaps: accepted.gaps,
      closures: [{ ...accepted.closure, attempt: { series: reference(attempt), attempt: 1 } }] };
    const closed = take(writeGapLines(f.store, request));
    const identityRequest = { acceptance: accepted.acceptance, obligation: line.target };
    const identityBytes = canonical(take(readResultIdentity(f.store, identityRequest)));
    const confirmationRequest = { project: 'garden', block: address.block, target: attempt.id,
      goal, accepting: [reference(closed)], cancelling: [] };
    const confirmationBytes = canonical(take(confirmResults(f.store, confirmationRequest)));
    const closeRequest = { ...address, attempt: 1,
      outcome: { reason: 'result' as const, accepting: [reference(closed)], cancelling: [], refusals: [] } };
    const firstOutcome = take(closeAttempt(f.store, closeRequest));
    if (firstOutcome.verdict !== 'progress') throw new Error('The old accepted filling did not establish progress');
    const progressed = take(readSeries(f.store, address));
    take(beginAttempt(f.store, { ...address, attempt: 2, goal }));
    const secondRequest = { ...closeRequest, attempt: 2 }, secondOutcome = take(closeAttempt(f.store, secondRequest));
    if (secondOutcome.verdict !== 'none' || secondOutcome.withoutProgress !== 1)
      throw new Error('The old repeated result did not retain its lasting identity');
    const series = take(readSeries(f.store, address));
    const rows = [first, closed, attempt, progressed, series, accepted.accepted.graph!, accepted.accepted.layer!, accepted.accepted.frame!]
      .map(row => ({ reference: reference(row), bytes: canonical(row) }));
    for (const ref of [accepted.acceptance.graph, accepted.acceptance.layer, accepted.acceptance.frame,
      reference(f.store.get('source:garden:brief')!)]) {
      const row = f.store.get(ref.id)!;
      f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
    }
    const replayBytes = canonical(take(closeAttempt(f.store, closeRequest)));
    complete = true;
    return { root: f.root, database: f.database, address, firstRequest: f.request, first: reference(first),
      firstBytes: canonical(take(readGapLines(f.store, { project: 'garden', record: reference(first) }))), request,
      closed: reference(closed), closedBytes: canonical(take(readGapLines(f.store, { project: 'garden', record: reference(closed) }))),
      identityRequest, identityBytes, confirmationRequest, confirmationBytes, closeRequest, replayBytes,
      secondRequest, secondOutcomeBytes: canonical(secondOutcome), series: reference(series), seriesBytes: canonical(series),
      progressed: reference(progressed), progressedBytes: canonical(progressed), rows };
  } finally {
    f.store.close();
    if (!complete) rmSync(f.root, { recursive: true, force: true });
  }
}

test('D2, structural identity and G7 preserve real 41fcb54 L2 producer history after restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d2-era-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url)), repositoryUrl = pathToFileURL(repository).href;
  const loader = join(root, 'pre-f5-loader.mjs'), typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root;
export function initialize(data) { root = data.root; }
export async function load(url, context, next) {
  if (url === 'node:test') return { format: 'module', shortCircuit: true,
    source: 'export const test = () => {}; export default test;' };
  const prefix = new URL('dist/', root).href;
  if (url.startsWith(prefix) && /\\.js$/.test(url)) {
    const relative = url.slice(prefix.length).replace(/\\.js$/, '.ts');
    let source = execFileSync('git', ['show', '41fcb54739d861d10b7d7324f77f5978db8d30d8:' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    if (relative === 'test/om-gap-lines.test.ts')
      source += '\\nexport { firstPassFixture, acceptOperations, goalFor, openAttempt };\\n';
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}
`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, { data: { root: ${JSON.stringify(repositoryUrl)} } });`;
  const producer = producePreF5ResultHistory.toString()
    .replace(/import\((["'])\.\.\/src\/([^"']+)\1\)/g, (_match, _quote: string, name: string) =>
      `import(${JSON.stringify(new URL(`dist/src/${name}`, repositoryUrl).href)})`)
    .replace(/import\((["'])\.\/([^"']+)\1\)/g, (_match, _quote: string, name: string) =>
      `import(${JSON.stringify(new URL(`dist/test/${name}`, repositoryUrl).href)})`);
  const output = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`,
    '--input-type=module', '--eval', `process.stdout.write(JSON.stringify(await (${producer})()));`],
  { cwd: repository, encoding: 'utf8', maxBuffer: 20_000_000 });
  const history = JSON.parse(output) as Awaited<ReturnType<typeof producePreF5ResultHistory>>;
  t.after(() => rmSync(history.root, { recursive: true, force: true }));
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(history.database);
    try {
      const before = historySnapshot(store);
      assert.equal(canonical(ok(readGapLines(store, { project: 'garden', record: history.first }))), history.firstBytes);
      assert.equal(canonical(ok(readGapLines(store, { project: 'garden', record: history.closed }))), history.closedBytes);
      assert.equal(canonical(ok(readResultIdentity(store, history.identityRequest))), history.identityBytes);
      assert.equal(canonical(ok(confirmResults(store, history.confirmationRequest))), history.confirmationBytes);
      assert.equal(canonical(ok(readSeriesAt(store, 'garden', history.progressed))), history.progressedBytes);
      assert.equal(canonical(ok(readSeriesAt(store, 'garden', history.series))), history.seriesBytes);
      assert.equal(canonical(ok(readSeries(store, history.address))), history.seriesBytes);
      assert.equal(canonical(ok(writeGapLines(store, history.firstRequest))), history.firstBytes);
      assert.equal(canonical(ok(writeGapLines(store, history.request))), history.closedBytes);
      assert.equal(canonical(ok(closeAttempt(store, history.closeRequest))), history.replayBytes);
      assert.equal(canonical(ok(closeAttempt(store, history.secondRequest))), history.secondOutcomeBytes);
      for (const row of history.rows)
        assert.equal(canonical(store.get(row.reference.id, row.reference.revision)), row.bytes);
      assert.deepEqual(historySnapshot(store), before);
    } finally { store.close(); }
  }
});

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { LEVEL, type Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { composeLayer, layerDesignOf } from "../src/graph/layer-design.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store } from "../src/storage/store.js";
import { historicalTrace, withHistoricalReads, writeOmInput } from "../src/om/input.js";
import { writeHorizon, prepareHorizon, readHorizon, type HorizonRequest } from "../src/om/horizon.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult } from "../src/om/refusal.js";
import {
  frameObligations, fillObligations, carryFrameFills, flowKey, representativeId, FRAME_REFUSAL_CODES, WORKS_FRAME_CONTRACT, workAnchorId,
  recordedWorkFillCode,
  readFrame, readFrameBasis, prepareFrame, type FrameRequest,
  type AcceptedFrame, type ConnectionFrame, type FrameLevel, type FrameScope,
} from "../src/om/frame-obligations.js";
import { explicitFills, explicitMapping, gardenGraph, createOmFixture, markedWorks, reanchor, storedAccepted,
  type OmFixture, type FixtureLayer } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { writeCandidate, gateCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { prepareGaps, writeGaps, readGaps, type GapRequest } from "../src/om/gaps.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import { readWorkZone, prepareWorkZone, type WorkZoneRequest } from "../src/om/work-zone.js";

const clone = structuredClone;
const levels = [2, 3] as const;
const fakeRef = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const graphRef = fakeRef("graph:garden");
const upperRef = fakeRef("graph-layer:garden:1");
const actualGraphRef = (graph: Graph): Ref => ({ ...graphRef, hash: hashJson(graph) });
const actualFrameRef = (frame: ConnectionFrame): Ref => ({ id: `om-frame:${frame.project}:${frame.level}`, revision: 1, hash: hashJson(frame) });
function delivered<T>(value: OmResult<T>): T {
  if (!value.ok) assert.fail(`Unexpected ${value.refusal.code}: ${value.refusal.message}`);
  return value.value;
}
function refusedAs<T>(value: OmResult<T>, code: string) {
  if (value.ok) assert.fail(`Expected ${code}, got success`);
  assert.equal(value.refusal.code, code);
  assert.ok(value.refusal.at.target.length > 0);
  assert.ok((value.refusal.at.field && value.refusal.at.field.length > 0) || value.refusal.at.ref);
  assert.ok(["producer", "gap", "owner", "readiness"].includes(value.refusal.route));
  return value.refusal;
}
function upper(graph: Graph, level: FrameLevel): Graph {
  const { level: _level, ...projected } = projectGraph(graph, level === 2 ? 1 : 2);
  return projected as Graph;
}
function scope(nodes: string[] = []): FrameScope {
  return { nodes, excluded: [], hash: hashJson({ nodes: [...nodes].sort(), excluded: [] }) };
}
function accepted(graph: Graph, frame: ConnectionFrame | null = null): AcceptedFrame {
  return { graph, reference: actualGraphRef(graph), frame: frame ? { reference: actualFrameRef(frame), value: frame } : null };
}
function allScope(graph: Graph, level: FrameLevel): FrameScope {
  return scope(graph.nodes.filter(node => LEVEL[node.kind] === level - 1).map(node => node.id));
}
function storedFrame(graph: Graph, level: FrameLevel, fills: Readonly<ConnectionFrame["fills"]>): ConnectionFrame {
  return { project: "garden", level, candidateHash: hashJson({ candidate: level }),
    layerHash: hashJson(projectGraph(graph, level)), fills: [...clone(fills)].sort((a, b) =>
      canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) as ConnectionFrame["fills"] };
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "frame_request_invalid");
  assert.equal(typeof (error.details as { target?: unknown }).target, "string");
  return true;
}

function markedWorkFrame() {
  const graph = gardenGraph("cross");
  for (const node of graph.nodes.filter(node => node.kind === "work" && node.ports.length && !node.code.length))
    node.code = [{ path: `${node.id}.ts`, access: "write", status: "planned" }];
  graph.nodes.find(node => node.id === "garden-produce-work")!.code.push({ path: "src/producer.ts", symbol: "produce", access: "write", status: "planned" });
  markedWorks(graph);
  const view = upper(graph, 3), horizon = allScope(view, 3);
  const obligations = delivered(frameObligations(view, horizon, 3));
  const fills: ConnectionFrame["fills"] = explicitFills(graph, view, obligations, 3)
    .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) }));
  const frame = storedFrame(graph, 3, fills); frame.worksContract = WORKS_FRAME_CONTRACT;
  return { graph, view, horizon, obligations, fills, frame };
}

test("works-frame saved correspondence preserves exact code references and refuses a frame without its works contract", () => {
  const { graph, view, horizon, fills, frame } = markedWorkFrame();
  const oldFrame = storedFrame(graph, 3, fills);
  assert.equal(refusedAs(fillObligations(view, horizon, accepted(graph, oldFrame), upperRef, 3), "frame_record_invalid").at.field, "worksContract");
  const current = delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, 3));
  assert.deepEqual(current.open, []);
  for (const fill of current.fills) {
    assert.deepEqual(fill.codeRef, frame.fills.find(row => row.obligation === fill.obligation && row.node === fill.node)!.codeRef);
    if (fill.port !== undefined) assert.ok(Object.isFrozen(fill.codeRef));
    else assert.ok(!Object.hasOwn(fill, "codeRef"));
  }
  assert.ok(current.fills.some(fill => fill.codeRef?.path === "src/producer.ts" && fill.codeRef.symbol === "produce"));
  assert.deepEqual(delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, 3)), current);
});

test("works-frame correspondence refuses absent or foreign code and a different declared path on the exact endpoint", () => {
  for (const mutation of ["missing", "foreign", "other-path", "outcome", "anchor-id", "anchor-owner", "anchor-test",
    "producer-inactive", "wake-foreign", "wake-distinct", "node-test-missing", "test-coverage", "sleeping-anchor-missing"] as const) {
    const { graph, horizon, frame } = markedWorkFrame();
    const row = frame.fills.find(fill => fill.node === "garden-produce-work" && fill.port === "out")!;
    if (mutation === "missing") delete row.codeRef;
    if (mutation === "foreign") row.codeRef!.path = "foreign.ts";
    if (mutation === "other-path") row.codeRef = clone(graph.nodes.find(node => node.id === row.node)!.code[0]!);
    if (mutation === "outcome") frame.fills.find(fill => fill.port === undefined)!.codeRef = clone(row.codeRef!);
    const anchor = graph.anchors[0]!;
    if (mutation === "anchor-id") {
      const binding = graph.connectors.flatMap(connector => connector.bindings).find(binding => binding.anchor === anchor.id)!;
      anchor.id = "not-mechanical"; binding.anchor = anchor.id;
    }
    if (mutation === "anchor-owner") anchor.owner = "garden-consume-work";
    if (mutation === "anchor-test") anchor.test = "garden-consume-work-test";
    if (mutation === "producer-inactive") graph.horizon = graph.horizon.filter(id => id !== "garden-produce-work");
    if (mutation === "wake-foreign") graph.connectors.find(item => item.id === "garden-flow")!.wakeTest = "garden-consume-work-test";
    if (mutation === "wake-distinct") {
      const test = { ...clone(graph.tests.find(item => item.id === anchor.test)!), id: "another-producer-wake" };
      graph.tests.push(test); graph.nodes.find(node => node.id === "garden-produce-work")!.tests.push(test.id);
      graph.connectors.find(item => item.id === "garden-flow")!.wakeTest = test.id;
    }
    if (mutation === "node-test-missing") graph.nodes.find(node => node.id === "garden-produce-work")!.tests = [];
    if (mutation === "test-coverage") graph.tests.find(test => test.id === anchor.test)!.covers = [];
    if (mutation === "sleeping-anchor-missing")
      graph.connectors.flatMap(connector => connector.bindings).find(binding => binding.anchor === anchor.id)!.anchor = null;
    const changed = { ...storedFrame(graph, 3, frame.fills), worksContract: WORKS_FRAME_CONTRACT };
    refusedAs(fillObligations(upper(graph, 3), horizon, accepted(graph, changed), upperRef, 3), "frame_record_invalid");
  }
});

test("works-frame carry preserves code and retires a complete flow when its exact endpoint code changes", () => {
  const { graph, view, horizon, obligations, frame } = markedWorkFrame();
  const source = { obligations: [...obligations], fills: frame.fills, worksContract: WORKS_FRAME_CONTRACT };
  const carried = delivered(carryFrameFills(view, horizon, accepted(graph), source, upperRef, 3));
  assert.deepEqual(carried.fills, frame.fills); assert.deepEqual(carried.retired, []); assert.deepEqual(carried.open, []);
  const changed = clone(graph), connector = changed.connectors.find(item => item.id === "garden-flow")!;
  for (const binding of connector.bindings.filter(item => item.level === 3 && item.producer.port === "out"))
    binding.producer.codeRef = clone(changed.nodes.find(node => node.id === binding.producer.node)!.code[0]!);
  const retired = delivered(carryFrameFills(upper(changed, 3), horizon, accepted(changed), source, upperRef, 3));
  const end = obligations.find(item => item.connector === connector.id && item.role === "producer" && item.upper.port === "out")!;
  const affected = obligations.filter(item => item.connector === connector.id && item.flow === end.flow);
  assert.ok(affected.every(item => retired.open.some(row => row.id === item.id)));
  assert.ok(frame.fills.filter(fill => affected.some(item => item.id === fill.obligation))
    .every(fill => retired.retired.some(row => canonical(row) === canonical(fill))));
  assert.ok(retired.fills.some(fill => obligations.find(item => item.id === fill.obligation)?.connector === "garden-prep-flow"));
});

test("saved work frame contract markers reject unknown, null, own-undefined and L2 forms", () => {
  for (const marker of ["works-frame/v2", null, undefined]) {
    const { graph, view, horizon, frame } = markedWorkFrame(), input = accepted(graph, frame);
    (input.frame!.value as unknown as Record<string, unknown>)['worksContract'] = marker;
    assert.equal(refusedAs(fillObligations(view, horizon, input, upperRef, 3), "frame_record_invalid").at.field, "worksContract");
  }
  const graph = gardenGraph(), view = upper(graph, 2), horizon = allScope(view, 2);
  const fills = explicitFills(graph, view, delivered(frameObligations(view, horizon, 2)), 2)
    .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) }));
  const frame = storedFrame(graph, 2, fills); frame.worksContract = WORKS_FRAME_CONTRACT;
  assert.equal(refusedAs(fillObligations(view, horizon, accepted(graph, frame), upperRef, 2), "frame_record_invalid").at.field, "worksContract");
});

test("works-frame identities retain no code and cannot masquerade as a coded connection end", () => {
  const view = upper(gardenGraph(), 3), horizon = scope();
  const result = delivered(fillObligations(view, horizon, null, upperRef, 3)), graph = clone(view);
  graph.nodes.push(...clone(result.representatives) as Graph["nodes"]);
  graph.joins.push(...clone(result.joins) as Graph["joins"]);
  for (const connector of graph.connectors) connector.bindings.push(...connector.bindings.filter(item => item.level === 2).map(binding => ({
    ...clone(binding), level: 3 as const, producer: { node: representativeId(binding.producer.node, 3), port: binding.producer.port },
    consumers: binding.consumers.map(endpoint => ({ node: representativeId(endpoint.node, 3), port: endpoint.port })),
  })));
  const frame = storedFrame(graph, 3, result.fills); frame.worksContract = WORKS_FRAME_CONTRACT;
  const valid = delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, 3));
  assert.ok(valid.fills.every(fill => fill.source === "identity" && !Object.hasOwn(fill, "codeRef")));
  const fill = frame.fills.find(row => row.port !== undefined)!;
  fill.codeRef = { path: "invented.ts", access: "write", status: "planned" };
  const invalid = { ...storedFrame(graph, 3, frame.fills), worksContract: WORKS_FRAME_CONTRACT };
  refusedAs(fillObligations(view, horizon, accepted(graph, invalid), upperRef, 3), "frame_record_invalid");
});

test("works-frame mechanical anchors distinguish upper flows that already have different anchors", () => {
  const { graph, frame } = markedWorkFrame();
  const id = "anchored-upper-flows", producer = graph.nodes.find(node => node.id === "garden-produce-work")!;
  const consumer = graph.nodes.find(node => node.id === "w-garden-later-operation")!;
  const operation = graph.nodes.find(node => node.id === "garden-produce-operation")!;
  operation.code = [{ path: "src/operation.ts", access: "read", status: "planned" }]; operation.tests.push("operation-wake");
  const wake = clone(graph.tests.find(test => test.id === "garden-produce-work-test")!);
  wake.id = "operation-wake"; wake.node = operation.id; wake.covers = [id]; wake.contract!.entrypoint.path = "src/operation.ts";
  graph.tests.push(wake);
  const connector: Graph["connectors"][number] = { id, artifact: "garden-data", returnsTo: "garden-produce-block",
    wakeTest: wake.id, bindings: [] };
  const workTest = graph.tests.find(test => test.id === "garden-produce-work-test")!;
  workTest.covers.push(id);
  for (const name of ["first", "second"]) {
    const binding = { level: 2 as const, producer: { node: "garden-produce-operation", port: "out" },
      consumers: [{ node: "garden-later-operation", port: "in" }], anchor: `upper-${name}` };
    graph.anchors.push({ id: binding.anchor, owner: "garden-produce-operation", outcome: connector.artifact, test: connector.wakeTest! });
    const anchor = workAnchorId(id, flowKey(binding), { node: producer.id, port: "out" });
    graph.anchors.push({ id: anchor, owner: producer.id, outcome: connector.artifact, test: workTest.id });
    connector.bindings.push(binding, { level: 3, producer: { node: producer.id, port: "out", codeRef: clone(producer.code.at(-1)!) },
      consumers: [{ node: consumer.id, port: "in", codeRef: clone(consumer.code[0]!) }], anchor });
  }
  graph.connectors.push(connector);
  const view = upper(graph, 3), horizon = allScope(view, 3);
  const additional = delivered(frameObligations(view, horizon, 3)).filter(item => item.connector === id);
  assert.equal(additional.length, 4);
  const fills = [...frame.fills, ...additional.map(item => ({ obligation: item.id,
    node: item.role === "producer" ? producer.id : consumer.id, port: item.role === "producer" ? "out" : "in",
    codeRef: clone(item.role === "producer" ? producer.code.at(-1)! : consumer.code[0]!),
    source: "accepted" as const, basis: actualGraphRef(graph) }))];
  const mapping = { ...storedFrame(graph, 3, fills), worksContract: WORKS_FRAME_CONTRACT };
  assert.deepEqual(delivered(fillObligations(view, horizon, accepted(graph, mapping), upperRef, 3)).open, []);
  assert.equal(view.connectors.find(item => item.id === id)!.wakeTest, wake.id);
  assert.notEqual(wake.id, workTest.id);
  const lower = connector.bindings.filter(binding => binding.level === 3);
  assert.notEqual(lower[0]!.anchor, lower[1]!.anchor);
  connector.bindings = connector.bindings.filter(binding => binding !== lower[1]);
  const incomplete = { ...storedFrame(graph, 3, fills), worksContract: WORKS_FRAME_CONTRACT };
  refusedAs(fillObligations(upper(graph, 3), horizon, accepted(graph, incomplete), upperRef, 3), "frame_record_invalid");
});

test("works-frame awake lower delivery preserves its anchored upper flow without inventing a sleeping anchor", () => {
  const { graph, frame } = markedWorkFrame(), id = "awake-upper-flow";
  const producer = graph.nodes.find(node => node.id === "garden-produce-work")!;
  const consumer = graph.nodes.find(node => node.id === "garden-consume-work")!;
  graph.anchors.push({ id: "upper-awake-anchor", owner: "garden-produce-operation", outcome: "garden-data", test: "garden-produce-work-test" });
  graph.connectors.push({ id, artifact: "garden-data", returnsTo: "garden-produce-block", wakeTest: "garden-produce-work-test", bindings: [
    { level: 2, producer: { node: "garden-produce-operation", port: "out" },
      consumers: [{ node: "garden-consume-operation", port: "in" }], anchor: "upper-awake-anchor" },
    { level: 3, producer: { node: producer.id, port: "out", codeRef: clone(producer.code.at(-1)!) },
      consumers: [{ node: consumer.id, port: "in", codeRef: clone(consumer.code[0]!) }], anchor: null },
  ] });
  const view = upper(graph, 3), horizon = allScope(view, 3);
  const additional = delivered(frameObligations(view, horizon, 3)).filter(item => item.connector === id);
  const fills = [...frame.fills, ...additional.map(item => ({ obligation: item.id,
    node: item.role === "producer" ? producer.id : consumer.id, port: item.role === "producer" ? "out" : "in",
    codeRef: clone(item.role === "producer" ? producer.code.at(-1)! : consumer.code[0]!), source: "accepted" as const, basis: actualGraphRef(graph) }))];
  const mapping = { ...storedFrame(graph, 3, fills), worksContract: WORKS_FRAME_CONTRACT };
  assert.deepEqual(delivered(fillObligations(view, horizon, accepted(graph, mapping), upperRef, 3)).open, []);
  refusedAs(fillObligations(view, horizon, accepted(graph, storedFrame(graph, 3, fills)), upperRef, 3), "frame_record_invalid");
});

test("works-frame recorded correspondence resolves different code on the same consumer port by exact flow", () => {
  const graph = gardenGraph("cross"), consumer = graph.nodes.find(node => node.id === "garden-consume-work")!;
  markedWorks(graph);
  consumer.code.push({ path: "src/second-consumer.ts", symbol: "consumeSecond", access: "read", status: "planned" });
  const connector = graph.connectors.find(item => item.id === "garden-flow")!;
  connector.bindings.find(item => item.level === 3 && item.producer.port === "out-alt")!.consumers[0]!.codeRef = clone(consumer.code[1]!);
  const view = upper(graph, 3), horizon = allScope(view, 3);
  const obligations = delivered(frameObligations(view, horizon, 3));
  const fills: ConnectionFrame["fills"] = explicitFills(graph, view, obligations, 3)
    .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) }));
  const frame = storedFrame(graph, 3, fills); frame.worksContract = WORKS_FRAME_CONTRACT;
  const basis = accepted(graph, frame);
  const historical = delivered(fillObligations(view, horizon, basis, upperRef, 3)), fingerprint = hashJson(historical);
  for (const producerPort of ["out", "out-alt"]) {
    const producer = historical.obligations.find(item => item.connector === connector.id && item.role === "producer"
      && item.upper.port === producerPort)!;
    const obligation = historical.obligations.find(item => item.connector === connector.id && item.flow === producer.flow
      && item.role === "consumer" && item.upper.node === "garden-consume-operation" && item.upper.port === "in")!;
    const fill = historical.fills.find(row => row.obligation === obligation.id)!;
    const code = delivered(recordedWorkFillCode(view, basis, obligation, fill));
    assert.deepEqual(code, consumer.code[producerPort === "out" ? 0 : 1]);
    assert.ok(Object.isFrozen(code));
  }
  for (const fill of historical.fills.filter(row => row.source === "accepted")) {
    const recorded = frame.fills.find(row => row.obligation === fill.obligation && row.node === fill.node)!;
    assert.deepEqual(fill.codeRef, recorded.codeRef);
  }
  assert.equal(hashJson(delivered(fillObligations(view, horizon, basis, upperRef, 3))), fingerprint);
});

test("works-frame recorded correspondence checks every producer delivery before deduplicating code references", () => {
  for (const defect of ["missing", "foreign", "distinct"] as const) {
    const graph = gardenGraph("cross"), producer = graph.nodes.find(node => node.id === "garden-produce-work")!;
    markedWorks(graph);
    producer.code.push({ path: "src/second-producer.ts", access: "write", status: "planned" });
    const connector = graph.connectors.find(item => item.id === "garden-flow")!;
    const binding = connector.bindings.find(item => item.level === 3 && item.producer.port === "out" && item.anchor === null)!;
    const split = clone(binding); split.consumers = [binding.consumers.pop()!];
    if (defect === "missing") delete split.producer.codeRef;
    if (defect === "foreign") split.producer.codeRef!.path = "foreign.ts";
    if (defect === "distinct") split.producer.codeRef = clone(producer.code[1]!);
    connector.bindings.push(split);
    const view = upper(graph, 3), horizon = allScope(view, 3);
    const obligations = delivered(frameObligations(view, horizon, 3));
    const fills: ConnectionFrame["fills"] = explicitFills(graph, view, obligations, 3)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) }));
    const frame = storedFrame(graph, 3, fills); frame.worksContract = WORKS_FRAME_CONTRACT;
    const basis = accepted(graph, frame);
    refusedAs(fillObligations(view, horizon, basis, upperRef, 3), "frame_record_invalid");
    const obligation = obligations.find(item => item.connector === connector.id && item.role === "producer"
      && item.upper.port === "out")!;
    const fill = fills.find(row => row.obligation === obligation.id)!;
    refusedAs(recordedWorkFillCode(view, basis, obligation, fill), "works_code_missing");
  }
});

test("C2 carry preserves renamed cross-flow correspondence and retires incompatible whole flows independently of open outcomes", () => {
  for (const level of levels) {
    const original = gardenGraph("cross");
    if (level === 3) markedWorks(original);
    const oldUpper = upper(original, level), horizon = allScope(oldUpper, level);
    const obligations = delivered(frameObligations(oldUpper, horizon, level));
    const previous = { obligations, fills: explicitFills(original, oldUpper, obligations, level)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(original) })) };
    const renamed = clone(original);
    for (const node of renamed.nodes.filter(item => LEVEL[item.kind] === level))
      for (const port of node.ports) port.id = `lower-${port.id}`;
    for (const connector of renamed.connectors) for (const binding of connector.bindings.filter(item => item.level === level)) {
      binding.producer.port = `lower-${binding.producer.port}`;
      for (const endpoint of binding.consumers) endpoint.port = `lower-${endpoint.port}`;
    }
    if (level === 3) reanchor(renamed, oldUpper, level);
    const source = { obligations: [...previous.obligations], fills: previous.fills.map(fill => ({ ...fill,
      ...(fill.port === undefined ? {} : { port: `lower-${fill.port}` }) })),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    const unchanged = delivered(carryFrameFills(oldUpper, horizon, accepted(renamed), source, upperRef, level));
    assert.deepEqual(unchanged.fills, storedFrame(renamed, level, source.fills).fills);
    assert.deepEqual(unchanged.retired, []);
    assert.deepEqual(unchanged.open, []);

    const producer = previous.obligations.find(item => item.connector === "garden-flow" && item.role === "producer" && item.upper.port === "out")!;
    const affected = previous.obligations.filter(item => item.connector === producer.connector && item.flow === producer.flow);
    const unaffected = previous.obligations.filter(item => item.connector === "garden-flow" && item.flow !== producer.flow);
    for (const defect of ["consumers", "delivery", "direction", "contract", "anchor", "artifact"] as const) {
      const changed = clone(renamed), flow = changed.connectors.find(item => item.id === "garden-flow")!;
      const upperBinding = flow.bindings.find(item => item.level === level - 1 && item.producer.port === "out")!;
      const lowerProducer = changed.nodes.find(item => item.id === (level === 2 ? "garden-produce-operation" : "garden-produce-work"))!;
      if (defect === "consumers") upperBinding.consumers = upperBinding.consumers.filter(item => item.port !== "in-alt");
      if (defect === "delivery") for (const binding of flow.bindings.filter(item => item.level === level && item.producer.port === "lower-out"))
        binding.consumers = binding.consumers.filter(item => item.port !== "lower-in-alt");
      if (defect === "direction") lowerProducer.ports.find(item => item.id === "lower-out")!.direction = "in";
      if (defect === "contract") lowerProducer.ports.find(item => item.id === "lower-out")!.contract = "another-contract";
      if (defect === "anchor") upperBinding.anchor = "changed-anchor";
      if (defect === "artifact") flow.artifact = "garden-prep"; // Same port contract, different required artifact.
      const outcomeNode = changed.nodes.find(item => item.id === (level === 2 ? "garden-consume-block" : "garden-consume-operation"))!;
      const outcome = previous.obligations.find(item => item.kind !== "connection-end" && item.upper.node === outcomeNode.id)!;
      outcomeNode.outcome = "garden-data";
      const view = upper(changed, level), current = delivered(frameObligations(view, horizon, level));
      assert.equal(current.find(item => item.kind !== "connection-end" && item.upper.node === outcomeNode.id)!.id, outcome.id);
      const carried = delivered(carryFrameFills(view, horizon, accepted(changed), source, upperRef, level));
      assert.ok(carried.retired.some(fill => fill.obligation === outcome.id), `${level}/${defect}: changed outcome`);
      assert.ok(carried.open.some(item => item.id === outcome.id));
      assert.ok(affected.every(item => !carried.fills.some(fill => fill.obligation === item.id)), `${level}/${defect}: whole flow`);
      assert.ok(source.fills.filter(fill => affected.some(item => item.id === fill.obligation))
        .every(fill => carried.retired.some(row => canonical(row) === canonical(fill))));
      const newAffected = current.filter(item => item.connector === "garden-flow" && (defect === "artifact" || item.flow === flowKey(upperBinding)));
      assert.ok(newAffected.every(item => carried.open.some(open => open.id === item.id)));
      if (defect !== "artifact") assert.ok(unaffected.every(item => carried.fills.some(fill => fill.obligation === item.id)), `${level}/${defect}: independent flow`);
      assert.equal(carried.fills.length + carried.retired.length, source.fills.length);
      assert.ok(Object.isFrozen(carried) && Object.isFrozen(carried.fills));
    }
  }
});

test("C2 carry requires explicit source obligations and rows instead of treating absence as an empty mapping", () => {
  const graph = gardenGraph(); markedWorks(graph);
  const view = upper(graph, 3), horizon = allScope(view, 3);
  const prior = explicitMapping(graph, view, horizon, 3);
  const priorFills = prior.fills.map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) }));
  const invoke = carryFrameFills as (...args: unknown[]) => unknown;
  const args: unknown[] = [view, horizon, accepted(graph),
    { obligations: prior.obligations, fills: priorFills, worksContract: WORKS_FRAME_CONTRACT }, upperRef, 3];
  for (const index of [0, 1, 2, 3, 4, 5]) for (const missing of [undefined, null]) {
    const bad = [...args]; bad[index] = missing;
    assert.throws(() => invoke(...bad), malformed);
  }
  for (const previous of [{ fills: priorFills }, { obligations: prior.obligations },
    { obligations: prior.obligations, fills: null }, { obligations: "wrong", fills: priorFills }]) {
    const bad = [...args]; bad[3] = previous;
    assert.throws(() => invoke(...bad), malformed);
  }
});

test("frame obligations preserve every cross-flow endpoint and port at levels two and three", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross"), view = upper(graph, level), horizon = allScope(view, level);
    const obligations = delivered(frameObligations(view, horizon, level));
    const flow = obligations.filter(item => item.connector === "garden-flow");
    assert.equal(flow.length, 6);
    assert.equal(obligations.length, level === 2 ? 10 : 13);
    const kind = level === 2 ? "block" : "operation";
    const consumer = flow.filter(item => item.role === "consumer" && item.upper.node === `garden-consume-${kind}`);
    assert.equal(consumer.length, 3);
    assert.equal(consumer.filter(item => item.upper.port === "in").length, 2);
    assert.equal(new Set(consumer.map(item => item.flow)).size, 2);
    const firstFlow = consumer.find(item => item.upper.port === "in-alt")!.flow;
    assert.deepEqual(consumer.filter(item => item.flow === firstFlow).map(item => item.upper.port).sort(), ["in", "in-alt"]);
    assert.equal(new Set(obligations.map(item => item.id)).size, obligations.length);
    assert.deepEqual(obligations.map(item => item.id), obligations.map(item => item.id).sort());
    assert.ok(obligations.every(item => item.level === level && item.zone === "horizon"));
    const reordered = clone(view); reordered.nodes.reverse(); reordered.connectors.reverse();
    for (const connector of reordered.connectors) {
      connector.bindings.reverse(); for (const binding of connector.bindings) binding.consumers.reverse();
    }
    assert.deepEqual(delivered(frameObligations(reordered, { ...horizon, nodes: [...horizon.nodes].reverse() }, level)), obligations);
    const external = clone(view); external.artifacts.find(item => item.id === "garden-data")!.external = true;
    assert.deepEqual(delivered(frameObligations(external, horizon, level)), obligations);
    assert.ok(Object.isFrozen(obligations) && Object.isFrozen(obligations[0]!.upper));
  }
});

test("an indistinguishable repeated upper consumer is refused instead of collapsing multiplicity", () => {
  for (const level of levels) {
    const graph = upper(gardenGraph("cross"), level);
    const binding = graph.connectors.find(item => item.id === "garden-flow")!.bindings.find(item => item.level === level - 1)!;
    binding.consumers.push(clone(binding.consumers[0]!));
    refusedAs(frameObligations(graph, allScope(graph, level), level), "upper_binding_ambiguous");
    refusedAs(fillObligations(graph, allScope(graph, level), null, upperRef, level), "upper_binding_ambiguous");
  }
});

test("accepted cross flows keep every port, and saved correspondence survives arbitrary lower-port names", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross");
    if (level === 3) markedWorks(graph);
    const view = upper(graph, level), horizon = allScope(view, level);
    const obligations = delivered(frameObligations(view, horizon, level));
    const first = { obligations, fills: explicitFills(graph, view, obligations, level)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) })) };
    assert.equal(first.fills.length, first.obligations.length);
    assert.ok(first.fills.every(fill => fill.source === "accepted" && canonical(fill.basis) === canonical(actualGraphRef(graph))));
    const producerObligations = first.obligations.filter(item => item.connector === "garden-flow" && item.role === "producer");
    const firstProducer = first.fills.find(fill => fill.obligation === producerObligations[0]!.id)!;
    const lostFlow = first.fills.map(fill => fill.obligation === producerObligations[1]!.id
      ? { ...fill, node: firstProducer.node, port: firstProducer.port! } : fill);
    const lostFrame = { ...storedFrame(graph, level, lostFlow),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    refusedAs(fillObligations(view, horizon, accepted(graph, lostFrame), upperRef, level), "frame_record_invalid");
    const renamed = clone(graph);
    for (const node of renamed.nodes.filter(item => LEVEL[item.kind] === level))
      for (const port of node.ports) port.id = `lower-${port.id}`;
    for (const connector of renamed.connectors) for (const binding of connector.bindings.filter(item => item.level === level)) {
      binding.producer.port = `lower-${binding.producer.port}`;
      for (const endpoint of binding.consumers) endpoint.port = `lower-${endpoint.port}`;
    }
    if (level === 3) reanchor(renamed, view, level);
    const fills = first.fills.map(fill => ({ ...fill, ...(fill.port === undefined ? {} : { port: `lower-${fill.port}` }) }));
    const frame = { ...storedFrame(renamed, level, fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    const repeated = delivered(fillObligations(view, horizon, accepted(renamed, frame), upperRef, level));
    assert.deepEqual(repeated.open, []);
    assert.deepEqual(repeated.fills.map(fill => ({ ...fill, basis: actualGraphRef(graph) })), storedFrame(renamed, level, fills).fills);
    assert.ok(repeated.fills.every(fill => canonical(fill.basis) === canonical(actualFrameRef(frame))));
    assert.deepEqual(delivered(fillObligations(view, horizon, accepted(renamed, frame), upperRef, level)), repeated);
    refusedAs(fillObligations(view, horizon, accepted(renamed), upperRef, level), "frame_record_invalid");
    const singleFlow = clone(graph);
    const connector = singleFlow.connectors.find(item => item.id === "garden-flow")!;
    connector.bindings = connector.bindings.filter(binding => binding.producer.port !== "out-alt");
    const consumer = singleFlow.nodes.find(node => node.id === (level === 2 ? "garden-consume-operation" : "garden-consume-work"))!;
    for (const port of consumer.ports) port.id = `renamed-${port.id}`;
    for (const binding of connector.bindings.filter(binding => binding.level === level))
      for (const endpoint of binding.consumers.filter(endpoint => endpoint.node === consumer.id)) endpoint.port = `renamed-${endpoint.port}`;
    refusedAs(fillObligations(upper(singleFlow, level), horizon, accepted(singleFlow), upperRef, level), "frame_record_invalid");
    renamed.nodes.find(item => LEVEL[item.kind] === level)!.title += " changed";
    refusedAs(fillObligations(view, horizon, accepted(renamed, frame), upperRef, level), "frame_layer_drift");
  }
});

test("a self-consistent saved frame cannot merge two upper flows into one surviving lower binding", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross");
    if (level === 3) markedWorks(graph);
    const view = upper(graph, level), horizon = allScope(view, level);
    const obligations = delivered(frameObligations(view, horizon, level));
    const complete = { obligations, fills: explicitFills(graph, view, obligations, level)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) })) };
    const originalFrame = { ...storedFrame(graph, level, complete.fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    assert.deepEqual(delivered(fillObligations(view, horizon, accepted(graph, originalFrame), upperRef, level)).open, []);
    const omitted = clone(graph), connector = omitted.connectors.find(item => item.id === "garden-flow")!;
    const removed = connector.bindings.find(item => item.level === level && item.producer.port === "out-alt")!;
    assert.ok(removed);
    connector.bindings = connector.bindings.filter(item => item !== removed);
    const producer = complete.obligations.find(item => item.connector === "garden-flow" && item.role === "producer" && item.upper.port === "out-alt")!;
    const fills = complete.fills.map(fill => fill.obligation === producer.id ? { ...fill, port: "out" } : fill);
    const forged = { ...storedFrame(omitted, level, fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    assert.notEqual(actualGraphRef(omitted).hash, actualGraphRef(graph).hash);
    assert.notEqual(actualFrameRef(forged).hash, actualFrameRef(originalFrame).hash);
    assert.equal(forged.layerHash, hashJson(projectGraph(omitted, level)));
    assert.equal(connector.bindings.filter(item => item.level === level && item.producer.port === "out-alt").length, 0);
    refusedAs(fillObligations(view, horizon, accepted(omitted, forged), upperRef, level), "frame_record_invalid");
  }
});

test("anchor-distinct upper flows retain separate lower bindings even with arbitrary lower port names", () => {
  for (const level of levels) {
    const graph = gardenGraph();
    const upperKind = level === 2 ? "block" : "operation", lowerKind = level === 2 ? "operation" : "work";
    const producer = `garden-produce-${lowerKind}`, consumer = `garden-consume-${lowerKind}`;
    const sleeper = `${consumer}-sleeping`;
    graph.nodes.find(node => node.id === producer)!.ports.push({ id: "named-source", direction: "out", contract: "garden-contract" });
    graph.nodes.find(node => node.id === consumer)!.ports.push({ id: "named-target", direction: "in", contract: "garden-contract" });
    if (level === 3) {
      // Under the works contract anchored deliveries are sleeping: the consumer stays outside the work horizon,
      // the anchor is the mechanical derivative of its upper flow and the producer's wake test covers the connector.
      graph.nodes.push({ ...clone(graph.nodes.find(node => node.id === consumer)!), id: sleeper, outcome: "garden-later" });
      graph.tests.find(test => test.id === "garden-produce-work-test")!.covers.push("garden-anchor-flows");
    }
    graph.connectors.push({ id: "garden-anchor-flows", artifact: "garden-data", returnsTo: "garden-produce-block", wakeTest: "garden-produce-work-test",
      bindings: ["first", "second"].flatMap(name => [
        { level: (level - 1) as 1 | 2, producer: { node: `garden-produce-${upperKind}`, port: "out" },
          consumers: [{ node: `garden-consume-${upperKind}`, port: "in" }], anchor: `anchor-${name}` },
        { level, producer: { node: producer, port: "named-source" },
          consumers: [{ node: level === 3 ? sleeper : consumer, port: "named-target" }], anchor: `anchor-${name}` },
      ]) });
    for (const name of ["first", "second"]) graph.anchors.push({ id: `anchor-${name}`,
      owner: level === 3 ? producer : `garden-produce-${upperKind}`, outcome: "garden-data", test: "garden-produce-work-test" });
    if (level === 3) markedWorks(graph);
    const view = upper(graph, level), horizon = allScope(view, level);
    const obligations = delivered(frameObligations(view, horizon, level));
    const additional = obligations.filter(item => item.connector === "garden-anchor-flows");
    assert.equal(additional.length, 4);
    assert.equal(new Set(additional.map(item => item.flow)).size, 2);
    const fills = explicitFills(graph, view, obligations, level)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) }));
    const frame = { ...storedFrame(graph, level, fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    const mapped = delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, level));
    assert.deepEqual(mapped.open, []);
    assert.equal(mapped.fills.filter(fill => additional.some(item => item.id === fill.obligation)).length, 4);
    const lost = clone(graph), connector = lost.connectors.find(item => item.id === "garden-anchor-flows")!;
    const secondAnchor = level === 3 ? workAnchorId(connector.id,
      flowKey(connector.bindings.find(item => item.level === level - 1 && item.anchor === "anchor-second")!),
      { node: producer, port: "named-source" }) : "anchor-second";
    connector.bindings = connector.bindings.filter(item => !(item.level === level && item.anchor === secondAnchor));
    const forged = { ...storedFrame(lost, level, fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    assert.notEqual(actualGraphRef(lost).hash, actualGraphRef(graph).hash);
    assert.notEqual(actualFrameRef(forged).hash, actualFrameRef(frame).hash);
    refusedAs(fillObligations(view, horizon, accepted(lost, forged), upperRef, level), "frame_record_invalid");
  }
});

test("saved fills cannot omit any accepted lower consumer even when another row still covers its obligation", () => {
  for (const level of levels) {
    const graph = gardenGraph(), kind = level === 2 ? "operation" : "work";
    const consumer = graph.nodes.find(node => node.id === `garden-consume-${kind}`)!;
    const extra = { ...clone(consumer), id: `${consumer.id}-second`, outcome: "garden-later", code: [], tests: [] };
    graph.nodes.push(extra);
    const binding = graph.connectors.find(connector => connector.id === "garden-flow")!.bindings.find(item => item.level === level)!;
    binding.consumers.push({ node: extra.id, port: "in" });
    if (level === 3) { graph.horizon.push(extra.id); markedWorks(graph); }
    const view = upper(graph, level), horizon = allScope(view, level);
    const obligations = delivered(frameObligations(view, horizon, level));
    const inferred = { obligations, fills: explicitFills(graph, view, obligations, level)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) })) };
    const obligation = inferred.obligations.find(item => item.connector === "garden-flow" && item.role === "consumer"
      && item.upper.node === (level === 2 ? "garden-consume-block" : "garden-consume-operation"))!;
    assert.equal(inferred.fills.filter(fill => fill.obligation === obligation.id).length, 2);
    const frame = { ...storedFrame(graph, level, inferred.fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    assert.deepEqual(delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, level)).open, []);
    for (const missing of ["partial", "all"] as const) {
      const incomplete = clone(frame);
      incomplete.fills = incomplete.fills.filter(fill => fill.obligation !== obligation.id || (missing === "partial" && fill.node !== extra.id));
      assert.equal(incomplete.fills.filter(fill => fill.obligation === obligation.id).length, missing === "partial" ? 1 : 0);
      assert.notEqual(actualFrameRef(incomplete).hash, actualFrameRef(frame).hash);
      assert.equal(incomplete.layerHash, frame.layerHash);
      refusedAs(fillObligations(view, horizon, accepted(graph, incomplete), upperRef, level), "frame_record_invalid");
    }
  }
});

test("accepted fills follow explicit realizes even when containment belongs to another upper node", () => {
  for (const level of levels) {
    const graph = gardenGraph(), kind = level === 2 ? "operation" : "work";
    const nodeId = level === 2 ? "garden-later-operation" : "w-garden-later-operation";
    const upperId = level === 2 ? "garden-later-block" : "garden-later-operation";
    const node = graph.nodes.find(item => item.id === nodeId)!;
    node.parent = level === 2 ? "garden-produce-block" : "garden-produce-operation";
    graph.edges!.push({ id: `realize-later-${kind}`, relation: "realizes", source: nodeId, target: upperId, condition: "Explicit role realization" });
    if (level === 3) markedWorks(graph);
    const view = upper(graph, level), horizon = allScope(view, level);
    const obligations = delivered(frameObligations(view, horizon, level));
    const inferred = { obligations, fills: explicitFills(graph, view, obligations, level)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) })) };
    const outcome = inferred.obligations.find(item => item.kind !== "connection-end" && item.upper.node === upperId)!;
    assert.ok(inferred.fills.some(fill => fill.obligation === outcome.id && fill.node === nodeId));
    const frame = { ...storedFrame(graph, level, inferred.fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    const recorded = delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, level));
    assert.deepEqual(recorded.fills.map(fill => ({ ...fill, basis: actualGraphRef(graph) })), storedFrame(graph, level, inferred.fills).fills);
    assert.deepEqual(recorded.open, []);
  }
});

test("FJ1 row 10: outside representatives carry only their own required ports and accepted identity never closes the horizon", () => {
  for (const level of levels) {
    const view = upper(gardenGraph("cross"), level);
    const later = view.nodes.find(item => item.id === (level === 2 ? "garden-later-block" : "garden-later-operation"))!;
    later.ports.push({ id: "unused", direction: "in", contract: "garden-contract" });
    view.joins.push({ id: "later-join", consumer: later.id, connectors: ["garden-flow"], failures: {
      missing: "Refuse missing input", extra: "Refuse extra input", foreign: "Refuse foreign input", stale: "Refuse stale input",
      duplicate: "Refuse duplicate input", returnsTo: "garden-produce-block",
    } });
    const identities = delivered(fillObligations(view, scope(), null, upperRef, level));
    assert.deepEqual(identities.open, []);
    assert.equal(identities.representatives.length, view.nodes.filter(item => LEVEL[item.kind] === level - 1).length);
    assert.ok(identities.fills.every(fill => fill.source === "identity" && canonical(fill.basis) === canonical(upperRef)));
    const representative = identities.representatives.find(item => item.parent === later.id)!;
    assert.equal(representative.id, representativeId(later.id, level));
    assert.equal(representative.outcome, later.outcome);
    assert.deepEqual(representative.boundary, later.boundary);
    assert.deepEqual(representative.ports.map(item => item.id), ["in"]);
    assert.ok(identities.joins.some(item => item.consumer === representative.id && item.connectors.includes("garden-flow")));
    const identityGraph = clone(view);
    identityGraph.nodes.push(...clone(identities.representatives) as Graph["nodes"]);
    identityGraph.joins.push(...clone(identities.joins) as Graph["joins"]);
    for (const connector of identityGraph.connectors) {
      const lowerBindings = connector.bindings.filter(item => item.level === level - 1).map(binding => ({
        ...clone(binding), level, producer: { ...binding.producer, node: representativeId(binding.producer.node, level) },
        consumers: binding.consumers.map(endpoint => ({ ...endpoint, node: representativeId(endpoint.node, level) })),
      }));
      connector.bindings.push(...lowerBindings);
    }
    const frame = { ...storedFrame(identityGraph, level, identities.fills),
      ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}) };
    const repeated = delivered(fillObligations(view, scope(), accepted(identityGraph, frame), upperRef, level));
    assert.ok(repeated.fills.every(fill => fill.source === "identity"));
    const entered = delivered(fillObligations(view, allScope(view, level), accepted(identityGraph, frame), upperRef, level));
    assert.deepEqual(entered.fills, []);
    assert.deepEqual(entered.representatives, []);
    assert.equal(entered.open.length, entered.obligations.length);
    const real = gardenGraph("cross");
    if (level === 3) markedWorks(real);
    const realView = upper(real, level);
    const transferred = delivered(fillObligations(realView, scope(), storedAccepted(real, realView, scope(), "garden", level), upperRef, level));
    assert.deepEqual(transferred.representatives, []);
    assert.ok(transferred.fills.every(fill => fill.source === "accepted"));
  }
});

test("only an external source may remain an identity producer outside the horizon", () => {
  for (const level of levels) {
    const graph = gardenGraph();
    if (level === 3) markedWorks(graph);
    const view = upper(graph, level);
    const consumer = level === 2 ? "garden-consume-block" : "garden-consume-operation";
    const producer = level === 2 ? "garden-produce-block" : "garden-produce-operation";
    const horizon = scope([consumer]);
    const missing = refusedAs(fillObligations(view, horizon, null, upperRef, level), "horizon_producer_unrefined");
    assert.equal(missing.route, "readiness");
    const required = delivered(frameObligations(view, horizon, level)).find(item => item.role === "producer" && item.upper.node === producer)!;
    assert.equal(missing.at.target, required.id);
    const external = clone(view); external.artifacts.find(item => item.id === "garden-data")!.external = true;
    const identity = delivered(fillObligations(external, horizon, null, upperRef, level));
    const outgoing = identity.obligations.find(item => item.role === "producer" && item.upper.node === producer)!;
    assert.ok(identity.fills.some(fill => fill.obligation === outgoing.id && fill.source === "identity"));
    assert.ok(identity.open.some(item => item.role === "consumer" && item.upper.node === consumer));
    const acceptedExternal = clone(graph); acceptedExternal.artifacts.find(item => item.id === "garden-data")!.external = true;
    const existing = delivered(fillObligations(external, horizon, storedAccepted(acceptedExternal, external, horizon, "garden", level), upperRef, level));
    assert.ok(existing.fills.some(fill => fill.obligation === outgoing.id && fill.source === "accepted"));
    assert.ok(!existing.representatives.some(item => item.parent === producer));
  }
});

test("native layer assembly retains every external-flow consumer and its accepted real producer", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross");
    graph.artifacts.find(item => item.id === "garden-data")!.external = true;
    graph.horizon = ["garden-consume-work"];
    if (level === 3) {
      // With an active producer the external artifact would become its own outcome claim; the delivery
      // stays unanchored so the works contract accepts its producer outside the work horizon.
      const delivery = graph.connectors.find(connector => connector.id === "garden-flow")!.bindings
        .find(binding => binding.level === 3 && binding.anchor !== null)!;
      graph.anchors = graph.anchors.filter(item => item.id !== delivery.anchor); delivery.anchor = null;
      markedWorks(graph);
    }
    const view = upper(graph, level), consumer = level === 2 ? "garden-consume-block" : "garden-consume-operation";
    const producer = level === 2 ? "garden-produce-block" : "garden-produce-operation";
    const horizon = scope([consumer]);
    const filled = delivered(fillObligations(view, horizon, storedAccepted(graph, view, horizon, "garden", level), upperRef, level));
    const outgoing = filled.obligations.filter(item => item.connector === "garden-flow" && item.role === "producer");
    assert.equal(outgoing.length, 2);
    assert.ok(outgoing.every(item => filled.fills.some(fill => fill.obligation === item.id && fill.source === "accepted")));
    assert.ok(!filled.representatives.some(node => node.parent === producer));
    const candidate = composeLayer(view, level, layerDesignOf(graph, level));
    const endpoints = (value: Graph) => value.connectors.find(item => item.id === "garden-flow")!.bindings
      .filter(item => item.level === level).flatMap(binding => binding.consumers.map(endpoint =>
        canonical({ producer: binding.producer, consumer: endpoint, anchor: binding.anchor }))).sort();
    assert.equal(endpoints(candidate).length, 4);
    assert.deepEqual(endpoints(candidate), endpoints(graph));
    const candidateFills = delivered(fillObligations(view, horizon, storedAccepted(candidate, view, horizon, "garden", level), upperRef, level));
    assert.deepEqual(candidateFills.open, []);
    assert.deepEqual(candidateFills.fills.map(fill => ({ ...fill, basis: actualGraphRef(graph) })), filled.fills.map(fill => ({ ...fill, basis: actualGraphRef(graph) })));
  }
});

test("a disclosed producer in one flow cannot stand in for an undisclosed producer in another", () => {
  for (const level of levels) {
    const graph = gardenGraph(), kind = level === 2 ? "block" : "operation";
    const later = `garden-later-${kind}`, consumer = `garden-consume-${kind}`;
    const lower = level === 2 ? "garden-later-operation" : "w-garden-later-operation";
    const lowerConsumer = level === 2 ? "garden-consume-operation" : "garden-consume-work";
    graph.nodes.find(item => item.id === later)!.ports.push({ id: "out-second", direction: "out", contract: "garden-contract" });
    graph.nodes.find(item => item.id === lower)!.ports.push({ id: "out-second", direction: "out", contract: "garden-contract" });
    graph.connectors.find(item => item.id === "garden-flow")!.bindings.push({
      level: level === 2 ? 1 : 2, producer: { node: later, port: "out-second" },
      consumers: [{ node: consumer, port: "in" }], anchor: null,
    }, {
      level, producer: { node: lower, port: "out-second" },
      consumers: [{ node: lowerConsumer, port: "in" }], anchor: null,
    });
    if (level === 3) {
      markedWorks(graph);
      for (const binding of graph.connectors.flatMap(item => item.bindings).filter(item => item.level === 3)) {
        if (binding.producer.node === lower) delete binding.producer.codeRef;
        for (const endpoint of binding.consumers.filter(item => item.node === lower)) delete endpoint.codeRef;
      }
    }
    const view = upper(graph, level), horizon = scope([consumer]);
    const obligations = delivered(frameObligations(view, horizon, level));
    const fills: ConnectionFrame["fills"] = explicitFills(graph, view, obligations, level)
      .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) }));
    const required = obligations.find(item => item.connector === "garden-flow" && item.role === "producer"
      && item.upper.node === later)!;
    assert.ok(fills.some(fill => fill.obligation === required.id && fill.node === lower));
    // The recorded frame discloses the lower node only as an identity representative of `later`:
    // its presence in one flow never produces the undisclosed producer of the other.
    for (const fill of fills.filter(row => row.node === lower)) {
      fill.source = "identity"; delete fill.codeRef;
    }
    const frame = storedFrame(graph, level, fills);
    if (level === 3) frame.worksContract = WORKS_FRAME_CONTRACT;
    const refusal = refusedAs(fillObligations(view, horizon, accepted(graph, frame), upperRef, level), "horizon_producer_unrefined");
    assert.equal(refusal.at.target, required.id);
    assert.equal(refusal.route, "readiness");
  }
});

test("frame boundaries reject absent sets, foreign correspondence, reserved identities and drifting upper bases", () => {
  const graph = gardenGraph(), view = upper(graph, 2), horizon = allScope(view, 2);
  for (const bad of [undefined, null, 1, "graph", []]) {
    assert.throws(() => frameObligations(bad as unknown as Graph, horizon, 2), malformed);
    assert.throws(() => frameObligations(view, bad as unknown as FrameScope, 2), malformed);
    if (bad !== null) assert.throws(() => fillObligations(view, horizon, bad as unknown as AcceptedFrame, upperRef, 2), malformed);
    assert.throws(() => fillObligations(view, horizon, null, bad as unknown as Ref, 2), malformed);
    assert.throws(() => flowKey(bad as unknown as Parameters<typeof flowKey>[0]), malformed);
    if (typeof bad !== "string") assert.throws(() => representativeId(bad as unknown as string, 2), malformed);
  }
  for (const field of ["nodes", "excluded", "hash"] as const) {
    const broken = clone(horizon) as Partial<FrameScope>; delete broken[field];
    assert.throws(() => frameObligations(view, broken as FrameScope, 2), malformed);
  }
  for (const bad of [undefined, null, 1, 4, "2"])
    assert.throws(() => frameObligations(view, horizon, bad as FrameLevel), malformed);
  const obligations = delivered(frameObligations(view, horizon, 2));
  const initial = { obligations, fills: explicitFills(graph, view, obligations, 2)
    .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(graph) })) };
  const frame = storedFrame(graph, 2, initial.fills);
  const foreign = clone(frame); foreign.project = "other";
  refusedAs(fillObligations(view, horizon, accepted(graph, foreign), upperRef, 2), "frame_record_invalid");
  const broken = clone(frame); broken.fills[0]!.obligation = "no-such-obligation";
  refusedAs(fillObligations(view, horizon, accepted(graph, broken), upperRef, 2), "frame_record_invalid");
  const drifted = clone(view); drifted.nodes.find(item => item.kind === "block")!.title += " changed";
  refusedAs(fillObligations(drifted, horizon, accepted(graph), upperRef, 2), "frame_upper_drift");
  const collision = clone(graph), colliding = collision.nodes.find(item => item.id === "garden-produce-operation")!;
  colliding.id = representativeId("garden-produce-block", 2); colliding.parent = "garden-consume-block";
  // An accepted graph without its recorded frame is refused at the boundary before identity resolution.
  refusedAs(fillObligations(view, scope(), accepted(collision), upperRef, 2), "frame_record_invalid");
  assert.deepEqual([...FRAME_REFUSAL_CODES].sort(), ["frame_request_invalid", "upper_binding_ambiguous", "accepted_binding_ambiguous",
    "frame_upper_drift", "frame_layer_drift", "frame_record_invalid", "horizon_producer_unrefined", "representative_id_conflict",
    "frame_basis_unproven", "input_stale", "works_code_missing", "works_code_foreign"].sort());
});

test("a node named like a reserved identity representative is refused when a rebased open obligation resolves it", () => {
  const original = gardenGraph(), before = upper(original, 3), horizon = scope(["garden-consume-operation"]);
  markedWorks(original);
  const obligations = delivered(frameObligations(before, horizon, 3));
  const fills: ConnectionFrame["fills"] = explicitFills(original, before, obligations, 3)
    .map(fill => ({ ...fill, source: "accepted" as const, basis: actualGraphRef(original) }));
  // The renamed consumer port retires `garden-later-operation`'s recorded fill; the leftover representative node
  // still present in the accepted graph must not silently absorb the reopened obligation's reserved identity.
  const changed = clone(original), reserved = representativeId("garden-later-operation", 3);
  changed.nodes.find(node => node.id === "garden-later-operation")!.ports.find(port => port.id === "in")!.id = "in-renamed";
  changed.connectors.find(item => item.id === "garden-flow")!.bindings.find(item => item.level === 2)!
    .consumers.find(item => item.node === "garden-later-operation")!.port = "in-renamed";
  const leftover = clone(original.nodes.find(node => node.id === "w-garden-later-operation")!);
  leftover.id = reserved; leftover.parent = "garden-later-operation";
  changed.nodes.push(leftover);
  const previous = { obligations: [...obligations], fills, worksContract: WORKS_FRAME_CONTRACT };
  const refusal = refusedAs(carryFrameFills(upper(changed, 3), horizon, { graph: changed, reference: actualGraphRef(changed) },
    previous, upperRef, 3), "representative_id_conflict");
  assert.equal(refusal.at.target, reserved);
  assert.equal(refusal.at.field, "id");
});

function acceptedInput(store: Store) {
  return store.get("om-input:garden") ?? delivered(writeOmInput(store, { project: "garden", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
}
function acceptedHorizon(store: Store, refinement: Ref | null) {
  const input = acceptedInput(store);
  return delivered(writeHorizon(store, { project: "garden", input: reference(input), graph: reference(store.get("graph:garden")!),
    refinement, choice: { choiceVersion: "frame-choice", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
}
function requestFor(f: OmFixture, horizon: Ref, level: FrameLevel): FrameRequest {
  return { project: f.project, level, horizon, graph: reference(f.graphRevision), layer: reference(f.layers[level]),
    frame: f.store.get(`om-frame:${f.project}:${level}`) ? reference(f.store.get(`om-frame:${f.project}:${level}`)!) : null,
    upper: level === 2 ? null : { horizon, frame: f.store.get(`om-frame:${f.project}:2`) ? reference(f.store.get(`om-frame:${f.project}:2`)!) : null } };
}
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function branchStore(f: OmFixture, snapshot: string, name: string): Store {
  const path = join(f.root, `${name}.sqlite`); copyFileSync(snapshot, path); return new Store(path);
}


test("C2 reads both accepted garden layers with exact OM frames and never writes the database", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" });
  const horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  assert.ok(!f.layers[1].value.layerProofs?.some(proof => proof.level === 1));
  for (const level of levels) {
    const request: FrameRequest = level === 3 ? { ...requestFor(f, reference(horizon.gate), level), workZoneContract: "accepted-l2-v1" } : requestFor(f, reference(horizon.gate), level), before = revisions(f.store);
    const historical = delivered(readFrame(f.store, request));
    const current = delivered(prepareFrame(f.store, request));
    assert.deepEqual(current.result, historical.result);
    assert.deepEqual(historical.accepted!.frame, { reference: request.frame, value: f.store.get(`om-frame:garden:${level}`)!.value });
    assert.deepEqual(historical.result.open, []);
    const identityNodes = new Set(f.store.get<ConnectionFrame>(request.frame!.id)!.value.fills
      .filter(fill => fill.source === "identity").map(fill => fill.node));
    assert.deepEqual(historical.result.representatives.map(node => node.id).sort(), [...identityNodes].sort());
    assert.ok(historical.result.fills.every(fill => fill.source === (identityNodes.has(fill.node) ? "identity" : "accepted")));
    assert.deepEqual(current.expected, { graph: f.graphRevision.revision, layer: f.layers[level].revision, frame: request.frame!.revision });
    assert.equal(historical.upperRef.id, `graph-layer:garden:${level - 1}`);
    assert.deepEqual(historical.upper, upper(f.graph, level));
    assert.ok(current.guards.some(guard => canonical(guard) === canonical(reference(f.graphRevision))));
    assert.deepEqual(revisions(f.store), before);
    assert.equal(f.store.list("connection-frame").length, 2);
    assert.ok(Object.isFrozen(current.result.fills));
  }
  const request = requestFor(f, reference(horizon.gate), 2);
  const historical = delivered(readFrame(f.store, request));
  const source = f.store.get("source:garden:brief")!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  const before = revisions(f.store);
  refusedAs(prepareFrame(f.store, request), "stage_not_accepted");
  assert.deepEqual(delivered(readFrame(f.store, request)), historical);
  assert.deepEqual(revisions(f.store), before);
  f.reopen();
  assert.deepEqual(delivered(readFrame(f.store, request)), historical);
});

test("the work scope excludes recorded operation identities after their blocks enter the horizon", t => {
  const { store, input, settled, acceptedGraph, acceptedLayer, acceptedFrame, later } = identityOperationFixture(t);
  const horizon = delivered(writeHorizon(store, { project: "garden", input, graph: acceptedGraph, refinement: acceptedLayer,
    choice: { choiceVersion: "frame-identity-entry", features: [{ outcome: "garden-result" }, { outcome: "garden-later" }], excluded: [] }, available: {} }));
  assert.ok(horizon.horizon.value.result.horizon.nodes.includes(later));
  assert.equal(horizon.horizon.value.result.horizon.execution[later]!.state, "needed");
  const identity = representativeId(later, 2);
  assert.ok(settled.frame!.value.fills.some(fill => fill.node === identity && fill.source === "identity"));
  const request: FrameRequest = { project: "garden", level: 3, graph: acceptedGraph, horizon: reference(horizon.gate),
    layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: acceptedFrame }, workZoneContract: "accepted-l2-v1" };
  const before = revisions(store);
  for (const action of [readFrame, prepareFrame]) {
    const current = delivered(action(store, request));
    assert.ok(!current.scope.nodes.includes(identity));
    assert.ok(current.scope.nodes.includes("garden-produce-operation"));
    assert.ok(current.result.fills.some(fill => fill.source === "identity"));
  }
  assert.deepEqual(revisions(store), before);
});

test("the first frame assembly uses accepted L1 and open obligations without creating an empty frame", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-first-frame-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = upper(gardenGraph(), 2), engine = new ProductEngine(store);
  preparedFeatures(engine, "garden", graph);
  const horizon = acceptedHorizon(store, null), graphRevision = store.get<Graph>("graph:garden")!;
  assert.equal(engine.graphs.layerIsDerived("garden", 2), false);
  const request: FrameRequest = { project: "garden", level: 2, horizon: reference(horizon.gate),
    graph: reference(graphRevision), layer: null, frame: null, upper: null };
  const before = revisions(store), prepared = delivered(prepareFrame(store, request));
  assert.equal(prepared.accepted, null);
  assert.ok(prepared.result.open.length > 0);
  assert.ok(prepared.result.open.every(item => item.zone === "horizon"));
  assert.ok(prepared.result.representatives.every(node => !prepared.scope.nodes.includes(node.parent!)));
  assert.deepEqual(prepared.expected, { graph: graphRevision.revision, layer: store.get("graph-layer:garden:2")!.revision, frame: 0 });
  assert.equal(store.list("connection-frame").length, 0);
  assert.deepEqual(revisions(store), before);
  const proposal = layerDesignOf(gardenGraph(), 2);
  const candidate = composeLayer(prepared.upper as Graph, 2, proposal);
  const completed = delivered(fillObligations(prepared.upper as Graph, prepared.scope as FrameScope,
    storedAccepted(candidate, prepared.upper as Graph, prepared.scope as FrameScope, "garden", 2), prepared.upperRef, 2));
  assert.deepEqual(completed.obligations, prepared.result.obligations);
  assert.deepEqual(completed.open, []);
  for (const open of prepared.result.open)
    assert.ok(completed.fills.some(fill => fill.obligation === open.id && fill.source === "accepted"), open.id);
  for (const prior of prepared.result.fills)
    assert.ok(completed.fills.some(fill => fill.obligation === prior.obligation), prior.obligation);
  assert.deepEqual(revisions(store), before);
  const frameValue = storedFrame(candidate, 2, completed.fills);
  const concurrent = store.write({ id: "om-frame:garden:2", kind: "connection-frame", expected: 0, value: frameValue });
  const beforeConflict = revisions(store);
  const transaction = writeGuarded(store, { unit: "C5-neighbor", target: "candidate:garden", guards: prepared.guards,
    writes: [{ id: "candidate:garden", kind: "candidate", expected: 0, value: candidate },
      { id: concurrent.id, kind: concurrent.kind, expected: prepared.expected.frame, value: frameValue },
      { id: "candidate-status:garden", kind: "candidate-status", expected: 0, value: { state: "accepted" } }] });
  assert.deepEqual(prepared.guards.filter(guard => guard.id === concurrent.id), [{ id: concurrent.id, absent: true }]);
  assert.equal(transaction.ok, false);
  if (transaction.ok) assert.fail("The concurrent frame must invalidate its absence guard");
  assert.equal(transaction.refusal.code, "input_stale");
  assert.equal(transaction.refusal.at.target, concurrent.id);
  assert.equal(transaction.refusal.route, "producer");
  assert.equal(store.get("candidate:garden"), null);
  assert.equal(store.get("candidate-status:garden"), null);
  assert.deepEqual(revisions(store), beforeConflict);
});

test("a prepared frame guards every mutable dependency before a neighbor can write any part of its transaction", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const request = requestFor(f, reference(horizon.gate), 2);
  const record = f.store.get("om-frame:garden:2")!;
  const saved = delivered(readFrame(f.store, request));
  assert.ok(saved.result.fills.every(fill => canonical(fill.basis) === canonical(reference(record))));
  const snapshot = await f.store.snapshot(join(f.root, "frame-guards"));
  const dependencies = [reference(f.store.get("source:garden:brief")!), request.graph, request.layer!, reference(record)];
  for (const [index, dependency] of dependencies.entries()) {
    const store = branchStore(f, snapshot.path, `frame-guard-${index}`);
    try {
      const prepared = delivered(prepareFrame(store, request));
      const current = store.get(dependency.id)!;
      store.write({ id: current.id, kind: current.kind, expected: current.revision, value: current.value });
      const before = revisions(store);
      const transaction = writeGuarded(store, { unit: "C5-neighbor", target: "candidate:garden", guards: prepared.guards,
        writes: [{ id: "candidate:garden", kind: "candidate", expected: 0, value: { horizon: request.horizon } },
          { id: "candidate-status:garden", kind: "candidate-status", expected: 0, value: { state: "accepted" } }] });
      refusedAs(transaction, "input_stale");
      assert.equal(store.get("candidate:garden"), null);
      assert.equal(store.get("candidate-status:garden"), null);
      assert.deepEqual(revisions(store), before);
      assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(dependency)), dependency.id);
      refusedAs(prepareFrame(store, request), index === 0 ? "stage_not_accepted" : "input_stale");
      assert.deepEqual(delivered(readFrame(store, request)), saved);
      assert.deepEqual(revisions(store), before);
    } finally { store.close(); }
  }
});

test("accepted upper bases come from saved acceptance rather than the latest projection or a status claim", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const request = requestFor(f, reference(horizon.gate), 2), snapshot = await f.store.snapshot(join(f.root, "frame-acceptance"));
  const cases: { code: string; field: string; change: (store: Store, current: FrameRequest) => void }[] = [
    { code: "frame_basis_unproven", field: "layerProofs", change: (store, current) => {
      const layer = store.get<FixtureLayer>(current.layer!.id)!;
      current.layer = reference(store.write({ id: layer.id, kind: layer.kind, expected: layer.revision,
        value: { ...layer.value, layerProofs: [], status: "accepted", accepted: true } }));
    } },
    { code: "frame_basis_unproven", field: "upper", change: (store, current) => {
      const l1 = store.get<FixtureLayer>("graph-layer:garden:1")!;
      const projectionOnly = store.write({ id: l1.id, kind: l1.kind, expected: l1.revision, value: l1.value });
      const layer = store.get<FixtureLayer>(current.layer!.id)!, value = clone(layer.value);
      const own = value.layerProofs!.find(proof => proof.level === 2)!;
      own.inputs = own.inputs.map(ref => ref.id === l1.id ? reference(projectionOnly) : ref);
      current.layer = reference(store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value }));
    } },
    { code: "frame_upper_drift", field: "layerProofs", change: (store, current) => {
      const layer = store.get<FixtureLayer>(current.layer!.id)!, value = clone(layer.value);
      value.layerProofs!.push({ level: 1, hash: "0".repeat(64), inputs: [] });
      current.layer = reference(store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value }));
    } },
    { code: "frame_upper_drift", field: "upper", change: (store, current) => {
      const graph = store.get<Graph>(current.graph.id)!, value = clone(graph.value);
      value.nodes.find(node => node.id === "garden-produce-block")!.title += " changed upper";
      current.graph = reference(store.write({ id: graph.id, kind: graph.kind, expected: graph.revision, value }));
      const layer = store.get<FixtureLayer>("graph-layer:garden:1")!;
      store.write({ id: layer.id, kind: layer.kind, expected: layer.revision,
        value: { ...layer.value, projection: projectGraph(value, 1) } });
    } },
  ];
  for (const [index, entry] of cases.entries()) {
    const store = branchStore(f, snapshot.path, `frame-acceptance-${index}`);
    try {
      const current = clone(request); entry.change(store, current);
      const before = revisions(store);
      for (const action of [readFrame, prepareFrame]) {
        const refusal = refusedAs(action(store, current), entry.code);
        assert.equal(refusal.at.field, entry.field);
      }
      assert.deepEqual(revisions(store), before);
      assert.deepEqual(delivered(readFrame(store, request)).result, delivered(readFrame(f.store, request)).result);
    } finally { store.close(); }
  }
  const noRefinementRequest = clone(horizon.horizon.value.request) as HorizonRequest;
  noRefinementRequest.refinement = null; noRefinementRequest.choice.choiceVersion = "frame-without-L2";
  const noRefinement = delivered(writeHorizon(f.store, noRefinementRequest));
  const noUpper = requestFor(f, reference(horizon.gate), 3);
  noUpper.upper = { horizon: reference(noRefinement.gate), frame: reference(f.store.get("om-frame:garden:2")!) };
  for (const action of [readFrame, prepareFrame]) {
    const refusal = refusedAs(action(f.store, noUpper), "frame_basis_unproven");
    assert.equal(refusal.at.field, "refinement");
  }
});


test("frame storage boundaries reject malformed refs and preserve unexpected engine exceptions without writes", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const request = requestFor(f, reference(horizon.gate), 2);
  for (const action of [readFrame, prepareFrame]) {
    for (const bad of [undefined, null, 1, "input", []]) {
      assert.throws(() => action(bad as unknown as Store, request), malformed);
      assert.throws(() => action(f.store, bad as unknown as FrameRequest), malformed);
    }
    for (const field of ["project", "level", "horizon", "graph", "layer", "frame", "upper"] as const) {
      const missing = clone(request) as Partial<FrameRequest>; delete missing[field];
      assert.throws(() => action(f.store, missing as FrameRequest), malformed);
    }
    for (const field of ["horizon", "graph", "layer"] as const) {
      const badHash = clone(request); badHash[field] = { ...badHash[field]!, hash: "0".repeat(64) };
      refusedAs(action(f.store, badHash), "record_forged");
    }
    const foreign = clone(request); foreign.graph.id = "graph:other";
    refusedAs(action(f.store, foreign), "record_foreign");
    const absent = clone(request); absent.graph.revision += 1000;
    refusedAs(action(f.store, absent), "record_missing");
  }
  const get = f.store.get.bind(f.store);
  for (const error of [new TypeError("injected frame storage failure"), new EngineError("record_corrupt", "injected corruption", { target: request.graph.id })]) {
    for (const action of [readFrame, prepareFrame]) {
      const before = revisions(f.store);
      try {
        f.store.get = ((id: string, revision?: number) => {
          if (id === request.graph.id) throw error;
          return get(id, revision);
        }) as Store["get"];
        assert.throws(() => action(f.store, request), actual => actual === error);
      } finally { f.store.get = get; }
      assert.deepEqual(revisions(f.store), before);
    }
  }
});


test("OM acceptance from L1 is consumed by C2, B2 and D1 with historical sources and current result guards", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-consumers-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(), { level: _level, ...projection } = projectGraph(graph, 1);
  preparedFeatures(new ProductEngine(store), "garden", projection as Graph);
  const initial = acceptedHorizon(store, null), input = initial.horizon.value.request.input;
  const original: FrameRequest = { project: "garden", level: 2, horizon: reference(initial.gate),
    graph: reference(store.get("graph:garden")!), layer: null, frame: null, upper: null };
  const prepared = delivered(prepareFrame(store, original)), design = projectGraph(graph, 2);
  const fills = explicitMapping(graph, prepared.upper as Graph, prepared.scope as FrameScope, 2).fills;
  const proposal: LayerProposal = { base: { graph: original.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: clone(design.nodes.filter(node => node.kind === "operation")),
    fills: fills.map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: clone(design.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0)),
    artifacts: clone(design.artifacts), contracts: clone(design.contracts), joins: clone(design.joins), tests: clone(design.tests),
    edges: clone(design.edges ?? []), journeys: clone(design.journeys ?? []), packets: clone(design.packets ?? []),
    transfers: clone(design.transfers ?? []), anchors: clone(design.anchors), removes: [], replaces: [], redefines: [] };
  const offered = store.write({ id: "om-proposal:garden:consumer-design", kind: "layer-proposal", expected: 0, value: proposal });
  const written = delivered(writeCandidate(store, { frame: original, proposals: [reference(offered)] }));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const candidate = reference(written.record), gate = delivered(gateCandidate(store, { project: "garden", candidate }));
  const settled = delivered(settleCandidate(store, { project: "garden", level: 2, candidate,
    outcome: { gate: "G3", candidate, graphHash: gate.graphHash, passed: true, codes: [] } }));
  assert.equal(settled.state, "accepted"); assert.ok(settled.graph && settled.layer && settled.frame);
  const request: FrameRequest = { ...original, graph: reference(settled.graph), layer: reference(settled.layer), frame: reference(settled.frame) };
  const current = delivered(prepareFrame(store, request));
  assert.deepEqual(current.result.open, []);
  assert.equal(current.expected.frame, 1);
  assert.ok(current.guards.some(ref => canonical(ref) === canonical(request.graph)));
  assert.ok(current.guards.some(ref => canonical(ref) === canonical(request.frame)));
  // NR1 (№3600): the accepted layer is read as written; its references name the layer's own records, not the trail of the
  // candidate's proposal that a checked reader of the earlier era named.
  assert.ok(!current.guards.some(ref => ref.id === offered.id));
  refusedAs(prepareFrame(store, { ...request, frame: null }), "frame_basis_unproven");
  const horizonRequest: HorizonRequest = { project: "garden", input, graph: request.graph, refinement: request.layer,
    choice: { choiceVersion: "after-om-acceptance", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} };
  const horizon = delivered(writeHorizon(store, horizonRequest));
  assert.equal(horizon.gate.value.state, "accepted");
  assert.ok(Object.values(horizon.horizon.value.result.horizon.refinement).every(value => value === "accepted"));
  const operations: FrameRequest = { ...request, horizon: reference(horizon.gate) };
  const works: FrameRequest = { ...operations, level: 3, layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: request.frame }, workZoneContract: "accepted-l2-v1" };
  const gapsRequest: GapRequest = { project: "garden", input, graph: request.graph, horizon: reference(horizon.gate),
    operations: { frame: operations, proposals: [] }, works: { frame: works, proposals: [] } };
  const gaps = delivered(writeGaps(store, gapsRequest));
  assert.equal(gaps.gate.passed, true);
  assert.ok(gaps.collection.gaps.some(gap => gap.field === "fill"));
  refusedAs(prepareGaps(store, { ...gapsRequest, works: { state: "upper-not-accepted", layer: request.layer! } }), "gap_record_forged");
  const historical = delivered(readFrame(store, request));
  const before = revisions(store), preparedHorizon = delivered(prepareHorizon(store, horizonRequest));
  assert.deepEqual(revisions(store), before);
  assert.ok(preparedHorizon.guards.some(ref => canonical(ref) === canonical(request.frame)));
  assert.ok(!preparedHorizon.guards.some(ref => ref.id === offered.id));
  const latestProposal = store.get(offered.id)!;
  store.write({ id: latestProposal.id, kind: latestProposal.kind, expected: latestProposal.revision, value: latestProposal.value });
  assert.deepEqual(delivered(prepareFrame(store, request)).result, current.result);
  assert.equal(delivered(prepareHorizon(store, horizonRequest)).existing?.gate.hash, horizon.gate.hash);
  const frame = store.get(settled.frame.id)!;
  store.write({ id: frame.id, kind: frame.kind, expected: frame.revision, value: frame.value });
  refusedAs(writeGuarded(store, { unit: "consumer-test", target: "neighbor", guards: preparedHorizon.guards,
    writes: [{ id: "neighbor:om-consumers", kind: "test", expected: 0, value: {} }] }), "input_stale");
  assert.equal(store.get("neighbor:om-consumers"), null);
  refusedAs(prepareFrame(store, request), "input_stale");
  refusedAs(prepareHorizon(store, horizonRequest), "input_stale");
  const source = store.get("source:garden:brief")!;
  store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  store.close(); store = new Store(database);
  assert.deepEqual(delivered(readFrame(store, request)), historical);
  assert.deepEqual(delivered(readHorizon(store, "garden", reference(horizon.gate))), horizon);
  assert.deepEqual(delivered(readGaps(store, { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) })), gaps);
});

function identityOperationFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-work-zone-c2-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(), producer = "garden-produce-block", consumer = "garden-consume-block", later = "garden-later-block";
  const outside = "garden-refusal-operation";
  graph.edges!.push({ id: "refusal-realizes-consumer", relation: "realizes", source: outside, target: consumer,
    condition: "The refusal operation also refines the consumer role" });
  const remap = (value: Json, suffix: string): Json => {
    const names: Record<string, string> = { "garden-result": `garden-${suffix}`, "garden-R1": `garden-R-${suffix}`,
      "garden-B1": `garden-B-${suffix}`, "garden-concept": `garden-concept-${suffix}`, "Deliver result": `Deliver ${suffix}` };
    if (typeof value === "string") return names[value] ?? value;
    if (Array.isArray(value)) return value.map(item => remap(item, suffix));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, suffix)]));
    return value;
  };
  const fields = (field: string): Json => {
    const basic = preparedField("garden", field), variants = [basic, ...["later", "data"].map(suffix => remap(basic, suffix))];
    if (["conceptSections", "behaviorContracts", "featurePreparation", "features"].includes(field))
      return variants.flatMap(value => value as Json[]);
    if (field === "preparation" || field === "operationRequirements") {
      const value = clone(basic) as Record<string, Json>;
      for (const key of field === "preparation" ? ["outcomes"] : ["outcomes", "conceptCoverage"])
        value[key] = variants.flatMap(item => (item as Record<string, Json>)[key] as Json[]);
      return value;
    }
    return basic;
  };
  const requirement = graph.requirements![0]!;
  graph.requirements!.push(...["later", "data"].map(suffix => remap(requirement as unknown as Json, suffix) as unknown as typeof requirement));
  for (const node of graph.nodes) node.implements!.push("garden-R-later", "garden-R-data");
  graph.journeys!.push({ id: "garden-data-feature", actor: "garden-user", variant: "success", entry: producer,
    path: [producer], outcome: "garden-data", terminal: "success" });
  const { level: _level, ...projection } = projectGraph(graph, 1);
  try { preparedFeatures(new ProductEngine(store), "garden", projection as Graph, fields); }
  catch (error) { if (error instanceof EngineError) assert.fail(JSON.stringify(error.details)); throw error; }
  const initial = acceptedHorizon(store, null), input = initial.horizon.value.request.input;
  const original: FrameRequest = { project: "garden", level: 2, horizon: reference(initial.gate),
    graph: reference(store.get("graph:garden")!), layer: null, frame: null, upper: null };
  const prepared = delivered(prepareFrame(store, original)), design = projectGraph(graph, 2);
  const realNodes = design.nodes.filter(node => node.kind === "operation" && node.parent !== later);
  const included = new Set(realNodes.map(node => node.id));
  const fills = explicitMapping(graph, prepared.upper as Graph, prepared.scope as FrameScope, 2).fills;
  const proposal: LayerProposal = { base: { graph: original.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: clone(realNodes), fills: fills.filter(fill => included.has(fill.node)).map(fill => ({ obligation: fill.obligation,
      node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: clone(design.connectors.filter(connector => !prepared.upper.connectors.some(upper => upper.id === connector.id))
      .map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))),
    artifacts: clone(design.artifacts), contracts: clone(design.contracts), joins: clone(design.joins), tests: clone(design.tests),
    edges: clone(design.edges ?? []), journeys: clone(design.journeys ?? []), packets: clone(design.packets ?? []),
    transfers: clone(design.transfers ?? []), anchors: clone(design.anchors), removes: [], replaces: [], redefines: [] };
  const offered = store.write({ id: "om-proposal:garden:work-zone-c2", kind: "layer-proposal", expected: 0, value: proposal });
  const written = delivered(writeCandidate(store, { frame: original, proposals: [reference(offered)] }));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") assert.fail("The identity fixture requires a current N2 candidate");
  const candidate = reference(written.record), gate = delivered(gateCandidate(store, { project: "garden", candidate }));
  assert.equal(gate.passed, true, JSON.stringify(gate));
  const settled = delivered(settleCandidate(store, { project: "garden", level: 2, candidate,
    outcome: { gate: "G3", candidate, graphHash: gate.graphHash, passed: gate.passed, codes: [] } }));
  assert.equal(settled.state, "accepted"); assert.ok(settled.graph && settled.layer && settled.frame);
  const acceptedGraph = reference(settled.graph), acceptedLayer = reference(settled.layer), acceptedFrame = reference(settled.frame);
  return { store, graph, input, settled, original, producer, consumer, later, outside, acceptedGraph, acceptedLayer, acceptedFrame };
}

test("C2 and F1 share the accepted operation zone across realizes roles, newly selected identities and unaccepted lower bridges", t => {
  const { store, graph, input, settled, original, producer, later, outside, acceptedGraph, acceptedLayer, acceptedFrame } = identityOperationFixture(t);
  assert.ok(settled.graph && settled.frame);
  const identity = representativeId(later, 2);
  assert.ok(settled.frame.value.fills.some(fill => fill.source === "identity" && fill.node === identity));
  const choice = (version: string, outcomes: string[], graphRef: Ref = acceptedGraph) => {
    const result = delivered(writeHorizon(store, { project: "garden", input, graph: graphRef, refinement: acceptedLayer,
      choice: { choiceVersion: version, features: outcomes.map(outcome => ({ outcome })), excluded: [] }, available: {} }));
    assert.equal(result.gate.value.state, "accepted");
    return result;
  };
  const compare = (horizon: Ref, graphRef: Ref, expected: string[]) => {
    const request: WorkZoneRequest = { project: "garden", graph: graphRef, layer: acceptedLayer, frame: acceptedFrame, horizon };
    const workFrame: FrameRequest = { project: "garden", level: 3, graph: graphRef, layer: null, frame: null, horizon,
      upper: { horizon, frame: acceptedFrame } };
    const before = revisions(store);
    assert.deepEqual(delivered(readWorkZone(store, request)).operations, expected);
    assert.deepEqual(delivered(prepareWorkZone(store, request)).operations, expected);
    const prepared = delivered(prepareFrame(store, workFrame));
    assert.equal(prepared.request.workZoneContract, "accepted-l2-v1");
    assert.ok(!Object.hasOwn(workFrame, "workZoneContract"));
    assert.deepEqual(delivered(readFrame(store, prepared.request)).scope.nodes, expected);
    assert.deepEqual(prepared.scope.nodes, expected);
    assert.deepEqual(revisions(store), before);
  };
  const expected = ["garden-consume-operation", "garden-prep-operation", "garden-produce-operation", outside];
  const same = choice("work-zone-realizes", ["garden-result"]);
  compare(reference(same.gate), acceptedGraph, expected);
  const expanded = choice("work-zone-identity-entry", ["garden-result", "garden-later"]);
  assert.ok(expanded.horizon.value.result.horizon.nodes.includes(later));
  assert.deepEqual(expanded.horizon.value.result.horizon.execution[later], { state: "needed" });
  compare(reference(expanded.gate), acceptedGraph, expected);
  const reopened = delivered(readFrame(store, { ...original, graph: acceptedGraph, layer: acceptedLayer, frame: acceptedFrame,
    horizon: reference(expanded.gate) }));
  assert.ok(reopened.result.open.some(obligation => obligation.upper.node === later),
    "Entering the horizon leaves the saved representative unrefined rather than changing its identity classification");

  const producerOnly = choice("work-zone-lower-bridge", ["garden-data"]);
  assert.deepEqual(producerOnly.horizon.value.result.horizon.nodes, [producer]);
  const lower = clone(settled.graph.value) as Graph;
  lower.nodes.push(clone(graph.nodes.find(node => node.id === "garden-produce-work")!));
  lower.edges!.push({ id: "outside-via-unaccepted-work", relation: "realizes", source: outside, target: "garden-produce-work",
    condition: "An unaccepted lower layer must not widen the operation zone" });
  assert.deepEqual(projectGraph(lower, 2), projectGraph(settled.graph.value as Graph, 2));
  const changed = store.write({ id: settled.graph.id, kind: settled.graph.kind, expected: settled.graph.revision, value: lower });
  compare(reference(producerOnly.gate), reference(changed), ["garden-prep-operation", "garden-produce-operation"]);
});


test("C2 work-zone contracts are explicit in history and unknown contracts never become current work", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const legacy = requestFor(f, reference(horizon.gate), 3), original = clone(legacy);
  const prepared = delivered(prepareFrame(f.store, legacy));
  assert.deepEqual(legacy, original);
  assert.equal(prepared.request.workZoneContract, "accepted-l2-v1");
  const historical = delivered(readFrame(f.store, prepared.request)), basis = delivered(readFrameBasis(f.store, prepared.request));
  assert.deepEqual(historical.result, prepared.result);
  assert.deepEqual(basis.references, historical.references);
  assert.deepEqual(basis.obligations, historical.result.obligations);
  const unmarkedRefusal = (error: unknown) => {
    if (!(error instanceof EngineError && error.code === "frame_request_invalid")) return false;
    assert.deepEqual(error.details, { unit: "F4", target: "frame", field: "workZoneContract" });
    return true;
  };
  const before = revisions(f.store);
  for (const action of [readFrame, readFrameBasis]) {
    assert.throws(() => action(f.store, legacy), unmarkedRefusal);
  }
  for (const contract of [undefined, null, "unknown", 1]) {
    for (const action of [readFrame, readFrameBasis, prepareFrame]) {
      assert.throws(() => action(f.store, { ...legacy, workZoneContract: contract } as unknown as FrameRequest), unmarkedRefusal);
    }
  }
  for (const action of [readFrame, readFrameBasis, prepareFrame]) {
    assert.throws(() => action(f.store, { ...requestFor(f, reference(horizon.gate), 2), workZoneContract: "accepted-l2-v1" }), unmarkedRefusal);
  }
  assert.deepEqual(revisions(f.store), before);
  f.reopen();
  for (const action of [readFrame, readFrameBasis]) {
    assert.throws(() => action(f.store, legacy), unmarkedRefusal);
  }
  assert.deepEqual(delivered(readFrame(f.store, prepared.request)).result, prepared.result);
  assert.deepEqual(delivered(readFrameBasis(f.store, prepared.request)).references, basis.references);
  assert.deepEqual(revisions(f.store), before);
});

function historicalFrameFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-frame-history-scope-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(new ProductEngine(store), "garden", upper(gardenGraph(), 2));
  const horizon = acceptedHorizon(store, null);
  const request: FrameRequest = { project: "garden", level: 2, graph: reference(store.get("graph:garden")!),
    horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  return { store, horizon, request };
}

test("C2 historical scope preserves complete requests and replays dependencies through transparent readers", t => {
  const f = historicalFrameFixture(t), nextHorizonRequest = clone(f.horizon.horizon.value.request) as HorizonRequest;
  nextHorizonRequest.choice.choiceVersion = "frame-history-next";
  const nextHorizon = delivered(writeHorizon(f.store, nextHorizonRequest));
  const nextRequest = { ...f.request, horizon: reference(nextHorizon.gate) };
  const expected = delivered(readFrame(f.store, f.request)), nextExpected = delivered(readFrame(f.store, nextRequest));
  const first: Ref[] = [], second: Ref[] = [];
  const firstView = historicalTrace(f.store, (ref, head) => { if (!head) first.push(ref); });
  const secondView = historicalTrace(f.store, (ref, head) => { if (!head) second.push(ref); });
  const before = revisions(f.store);
  withHistoricalReads(() => {
    assert.deepEqual(delivered(readFrame(firstView, f.request)), expected);
    assert.deepEqual(delivered(readFrame(secondView, f.request)), expected);
    assert.ok(first.length > 0);
    assert.deepEqual(second, first, "A proof hit must replay every exact read, including its original multiplicity");
    const basis = delivered(readFrameBasis(f.store, f.request));
    assert.deepEqual(basis.references, expected.references);
    assert.deepEqual(basis.obligations, expected.result.obligations);
    assert.deepEqual(delivered(readFrame(f.store, nextRequest)), nextExpected);
    assert.notDeepEqual(nextExpected.request, expected.request, "The same graph does not identify a complete frame request");
  });
  assert.deepEqual(revisions(f.store), before);
});

test("C2 cached history does not admit an omitted new frame or hide an opaque source view", t => {
  const f = historicalFrameFixture(t), expected = delivered(readFrame(f.store, f.request));
  const hidden = new Proxy(f.store, { get(target, key) {
    if (key === "get") return (id: string, revision?: number) => id === f.request.graph.id ? null : target.get(id, revision);
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  withHistoricalReads(() => {
    assert.deepEqual(delivered(readFrame(f.store, f.request)), expected);
    refusedAs(readFrame(hidden, f.request), "record_missing");
    assert.equal(delivered(prepareFrame(f.store, f.request)).expected.frame, 0);
    f.store.write({ id: "om-frame:garden:2", kind: "connection-frame", expected: 0, value: {} });
    const before = revisions(f.store);
    refusedAs(prepareFrame(f.store, f.request), "input_stale");
    assert.deepEqual(delivered(readFrame(f.store, f.request)), expected);
    assert.deepEqual(revisions(f.store), before);
  });
  assert.deepEqual(delivered(readFrame(f.store, f.request)), expected);
});

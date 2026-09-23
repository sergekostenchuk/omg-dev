import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { LEVEL, type Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { composeLayer, layerDesignOf } from "../src/graph/layer-design.js";
import { isRef, reference, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { ResearchAnswer, ResearchAssessment } from "../src/discovery/research-model.js";
import type { Question } from "../src/discovery/discovery.js";
import type { Source } from "../src/evidence/evidence.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store } from "../src/storage/store.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon, type HorizonRequest } from "../src/om/horizon.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult } from "../src/om/refusal.js";
import {
  frameObligations, fillObligations, flowKey, representativeId, FRAME_REFUSAL_CODES,
  readFrame, prepareFrame, type FrameRequest,
  type AcceptedFrame, type ConnectionFrame, type FrameLevel, type FrameScope,
} from "../src/om/frame-obligations.js";
import { gardenGraph, createOmFixture, type OmFixture, type FixtureLayer } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";

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

test("historical accepted cross flows keep every port, and saved correspondence survives arbitrary lower-port names", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross"), view = upper(graph, level), horizon = allScope(view, level);
    const first = delivered(fillObligations(view, horizon, accepted(graph), upperRef, level));
    assert.deepEqual(first.open, []);
    assert.deepEqual(first.representatives, []);
    assert.equal(first.fills.length, first.obligations.length);
    assert.ok(first.fills.every(fill => fill.source === "accepted" && canonical(fill.basis) === canonical(actualGraphRef(graph))));
    const producerObligations = first.obligations.filter(item => item.connector === "garden-flow" && item.role === "producer");
    const firstProducer = first.fills.find(fill => fill.obligation === producerObligations[0]!.id)!;
    const lostFlow = first.fills.map(fill => fill.obligation === producerObligations[1]!.id
      ? { ...fill, node: firstProducer.node, port: firstProducer.port! } : fill);
    refusedAs(fillObligations(view, horizon, accepted(graph, storedFrame(graph, level, lostFlow)), upperRef, level), "frame_record_invalid");
    const renamed = clone(graph);
    for (const node of renamed.nodes.filter(item => LEVEL[item.kind] === level))
      for (const port of node.ports) port.id = `lower-${port.id}`;
    for (const connector of renamed.connectors) for (const binding of connector.bindings.filter(item => item.level === level)) {
      binding.producer.port = `lower-${binding.producer.port}`;
      for (const endpoint of binding.consumers) endpoint.port = `lower-${endpoint.port}`;
    }
    const fills = first.fills.map(fill => ({ ...fill, ...(fill.port === undefined ? {} : { port: `lower-${fill.port}` }) }));
    const frame = storedFrame(renamed, level, fills);
    const repeated = delivered(fillObligations(view, horizon, accepted(renamed, frame), upperRef, level));
    assert.deepEqual(repeated.open, []);
    assert.deepEqual(repeated.fills.map(fill => ({ ...fill, basis: actualGraphRef(graph) })), fills);
    assert.ok(repeated.fills.every(fill => canonical(fill.basis) === canonical(actualFrameRef(frame))));
    assert.deepEqual(delivered(fillObligations(view, horizon, accepted(renamed, frame), upperRef, level)), repeated);
    refusedAs(fillObligations(view, horizon, accepted(renamed), upperRef, level), "accepted_binding_ambiguous");
    const singleFlow = clone(graph);
    const connector = singleFlow.connectors.find(item => item.id === "garden-flow")!;
    connector.bindings = connector.bindings.filter(binding => binding.producer.port !== "out-alt");
    const consumer = singleFlow.nodes.find(node => node.id === (level === 2 ? "garden-consume-operation" : "garden-consume-work"))!;
    for (const port of consumer.ports) port.id = `renamed-${port.id}`;
    for (const binding of connector.bindings.filter(binding => binding.level === level))
      for (const endpoint of binding.consumers.filter(endpoint => endpoint.node === consumer.id)) endpoint.port = `renamed-${endpoint.port}`;
    const ambiguousPort = refusedAs(fillObligations(upper(singleFlow, level), horizon, accepted(singleFlow), upperRef, level), "accepted_binding_ambiguous");
    assert.equal(ambiguousPort.at.field, "consumer.port");
    renamed.nodes.find(item => LEVEL[item.kind] === level)!.title += " changed";
    refusedAs(fillObligations(view, horizon, accepted(renamed, frame), upperRef, level), "frame_layer_drift");
  }
});

test("a self-consistent saved frame cannot merge two upper flows into one surviving lower binding", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross"), view = upper(graph, level), horizon = allScope(view, level);
    const complete = delivered(fillObligations(view, horizon, accepted(graph), upperRef, level));
    const originalFrame = storedFrame(graph, level, complete.fills);
    assert.deepEqual(delivered(fillObligations(view, horizon, accepted(graph, originalFrame), upperRef, level)).open, []);
    const omitted = clone(graph), connector = omitted.connectors.find(item => item.id === "garden-flow")!;
    const removed = connector.bindings.find(item => item.level === level && item.producer.port === "out-alt")!;
    assert.ok(removed);
    connector.bindings = connector.bindings.filter(item => item !== removed);
    const producer = complete.obligations.find(item => item.connector === "garden-flow" && item.role === "producer" && item.upper.port === "out-alt")!;
    const fills = complete.fills.map(fill => fill.obligation === producer.id ? { ...fill, port: "out" } : fill);
    const forged = storedFrame(omitted, level, fills);
    assert.notEqual(actualGraphRef(omitted).hash, actualGraphRef(graph).hash);
    assert.notEqual(actualFrameRef(forged).hash, actualFrameRef(originalFrame).hash);
    assert.equal(forged.layerHash, hashJson(projectGraph(omitted, level)));
    assert.equal(connector.bindings.filter(item => item.level === level && item.producer.port === "out-alt").length, 0);
    refusedAs(fillObligations(view, horizon, accepted(omitted, forged), upperRef, level), "frame_record_invalid");
  }
});

test("anchor-distinct upper flows retain separate lower bindings even with arbitrary lower port names", () => {
  for (const level of levels) {
    const graph = gardenGraph(), originalView = upper(graph, level), horizon = allScope(originalView, level);
    const existing = delivered(fillObligations(originalView, horizon, accepted(graph), upperRef, level));
    const upperKind = level === 2 ? "block" : "operation", lowerKind = level === 2 ? "operation" : "work";
    const producer = `garden-produce-${lowerKind}`, consumer = `garden-consume-${lowerKind}`;
    graph.nodes.find(node => node.id === producer)!.ports.push({ id: "named-source", direction: "out", contract: "garden-contract" });
    graph.nodes.find(node => node.id === consumer)!.ports.push({ id: "named-target", direction: "in", contract: "garden-contract" });
    graph.connectors.push({ id: "garden-anchor-flows", artifact: "garden-data", returnsTo: "garden-produce-block", wakeTest: "garden-produce-work-test",
      bindings: ["first", "second"].flatMap(name => [
        { level: (level - 1) as 1 | 2, producer: { node: `garden-produce-${upperKind}`, port: "out" },
          consumers: [{ node: `garden-consume-${upperKind}`, port: "in" }], anchor: `anchor-${name}` },
        { level, producer: { node: producer, port: "named-source" }, consumers: [{ node: consumer, port: "named-target" }], anchor: `anchor-${name}` },
      ]) });
    for (const name of ["first", "second"]) graph.anchors.push({ id: `anchor-${name}`, owner: "garden-produce-work", outcome: "garden-data", test: "garden-produce-work-test" });
    const view = upper(graph, level), obligations = delivered(frameObligations(view, horizon, level));
    const additional = obligations.filter(item => item.connector === "garden-anchor-flows");
    assert.equal(additional.length, 4);
    assert.equal(new Set(additional.map(item => item.flow)).size, 2);
    const fills = [...existing.fills, ...additional.map(item => ({ obligation: item.id,
      node: item.role === "producer" ? producer : consumer, port: item.role === "producer" ? "named-source" : "named-target",
      source: "accepted" as const, basis: actualGraphRef(graph) }))];
    const frame = storedFrame(graph, level, fills);
    const mapped = delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, level));
    assert.deepEqual(mapped.open, []);
    assert.equal(mapped.fills.filter(fill => additional.some(item => item.id === fill.obligation)).length, 4);
    const lost = clone(graph), connector = lost.connectors.find(item => item.id === "garden-anchor-flows")!;
    connector.bindings = connector.bindings.filter(item => !(item.level === level && item.anchor === "anchor-second"));
    const forged = storedFrame(lost, level, fills);
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
    const view = upper(graph, level), horizon = allScope(view, level);
    const inferred = delivered(fillObligations(view, horizon, accepted(graph), upperRef, level));
    const obligation = inferred.obligations.find(item => item.connector === "garden-flow" && item.role === "consumer"
      && item.upper.node === (level === 2 ? "garden-consume-block" : "garden-consume-operation"))!;
    assert.equal(inferred.fills.filter(fill => fill.obligation === obligation.id).length, 2);
    const frame = storedFrame(graph, level, inferred.fills);
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
    const view = upper(graph, level), horizon = allScope(view, level);
    const inferred = delivered(fillObligations(view, horizon, accepted(graph), upperRef, level));
    const outcome = inferred.obligations.find(item => item.kind !== "connection-end" && item.upper.node === upperId)!;
    assert.ok(inferred.fills.some(fill => fill.obligation === outcome.id && fill.node === nodeId));
    assert.ok(!inferred.open.some(item => item.id === outcome.id));
    const frame = storedFrame(graph, level, inferred.fills);
    const recorded = delivered(fillObligations(view, horizon, accepted(graph, frame), upperRef, level));
    assert.deepEqual(recorded.fills.map(fill => ({ ...fill, basis: actualGraphRef(graph) })), inferred.fills);
    assert.deepEqual(recorded.open, []);
  }
});

test("outside representatives carry only their own required ports and accepted identity never closes the horizon", () => {
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
    const frame = storedFrame(identityGraph, level, identities.fills);
    const repeated = delivered(fillObligations(view, scope(), accepted(identityGraph, frame), upperRef, level));
    assert.ok(repeated.fills.every(fill => fill.source === "identity"));
    const entered = delivered(fillObligations(view, allScope(view, level), accepted(identityGraph, frame), upperRef, level));
    assert.deepEqual(entered.fills, []);
    assert.deepEqual(entered.representatives, []);
    assert.equal(entered.open.length, entered.obligations.length);
    const real = gardenGraph("cross"), realView = upper(real, level);
    const transferred = delivered(fillObligations(realView, scope(), accepted(real), upperRef, level));
    assert.deepEqual(transferred.representatives, []);
    assert.ok(transferred.fills.every(fill => fill.source === "accepted"));
  }
});

test("only an external source may remain an identity producer outside the horizon", () => {
  for (const level of levels) {
    const graph = gardenGraph(), view = upper(graph, level);
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
    const existing = delivered(fillObligations(external, horizon, accepted(acceptedExternal), upperRef, level));
    assert.ok(existing.fills.some(fill => fill.obligation === outgoing.id && fill.source === "accepted"));
    assert.ok(!existing.representatives.some(item => item.parent === producer));
  }
});

test("native layer assembly retains every external-flow consumer and its accepted real producer", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross");
    graph.artifacts.find(item => item.id === "garden-data")!.external = true;
    graph.horizon = ["garden-consume-work"];
    const view = upper(graph, level), consumer = level === 2 ? "garden-consume-block" : "garden-consume-operation";
    const producer = level === 2 ? "garden-produce-block" : "garden-produce-operation";
    const horizon = scope([consumer]);
    const filled = delivered(fillObligations(view, horizon, accepted(graph), upperRef, level));
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
    const candidateFills = delivered(fillObligations(view, horizon, accepted(candidate), upperRef, level));
    assert.deepEqual(candidateFills.open, []);
    assert.deepEqual(candidateFills.fills.map(fill => ({ ...fill, basis: actualGraphRef(graph) })), filled.fills);
  }
});

test("a disclosed producer in one flow cannot stand in for an undisclosed producer in another", () => {
  for (const level of levels) {
    const graph = gardenGraph(), kind = level === 2 ? "block" : "operation";
    const later = `garden-later-${kind}`, consumer = `garden-consume-${kind}`;
    graph.nodes.find(item => item.id === later)!.ports.push({ id: "out-second", direction: "out", contract: "garden-contract" });
    graph.connectors.find(item => item.id === "garden-flow")!.bindings.push({
      level: level === 2 ? 1 : 2, producer: { node: later, port: "out-second" },
      consumers: [{ node: consumer, port: "in" }], anchor: null,
    });
    const view = upper(graph, level);
    const missingNode = level === 2 ? "garden-later-operation" : "w-garden-later-operation";
    graph.nodes = graph.nodes.filter(item => item.id !== missingNode && item.parent !== missingNode);
    for (const connector of graph.connectors) {
      connector.bindings = connector.bindings.filter(item => item.producer.node !== missingNode);
      for (const binding of connector.bindings) binding.consumers = binding.consumers.filter(item => item.node !== missingNode);
      connector.bindings = connector.bindings.filter(item => item.consumers.length > 0);
    }
    const refusal = refusedAs(fillObligations(view, scope([consumer]), accepted(graph), upperRef, level), "horizon_producer_unrefined");
    const required = delivered(frameObligations(view, scope([consumer]), level)).find(item =>
      item.connector === "garden-flow" && item.role === "producer" && item.upper.node === later)!;
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
  const initial = delivered(fillObligations(view, horizon, accepted(graph), upperRef, 2));
  const frame = storedFrame(graph, 2, initial.fills);
  const foreign = clone(frame); foreign.project = "other";
  refusedAs(fillObligations(view, horizon, accepted(graph, foreign), upperRef, 2), "frame_record_invalid");
  const broken = clone(frame); broken.fills[0]!.obligation = "no-such-obligation";
  refusedAs(fillObligations(view, horizon, accepted(graph, broken), upperRef, 2), "frame_record_invalid");
  const drifted = clone(view); drifted.nodes.find(item => item.kind === "block")!.title += " changed";
  refusedAs(fillObligations(drifted, horizon, accepted(graph), upperRef, 2), "frame_upper_drift");
  const collision = clone(graph), colliding = collision.nodes.find(item => item.id === "garden-produce-operation")!;
  colliding.id = representativeId("garden-produce-block", 2); colliding.parent = "garden-consume-block";
  refusedAs(fillObligations(view, scope(), accepted(collision), upperRef, 2), "representative_id_conflict");
  assert.deepEqual([...FRAME_REFUSAL_CODES].sort(), ["frame_request_invalid", "upper_binding_ambiguous", "accepted_binding_ambiguous",
    "frame_upper_drift", "frame_layer_drift", "frame_record_invalid", "horizon_producer_unrefined", "representative_id_conflict",
    "frame_basis_unproven", "input_stale"].sort());
});

function acceptedInput(store: Store) {
  return delivered(writeOmInput(store, { project: "garden", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
}
function acceptedHorizon(store: Store, refinement: Ref | null) {
  const input = acceptedInput(store);
  return delivered(writeHorizon(store, { project: "garden", input: reference(input), graph: reference(store.get("graph:garden")!),
    refinement, choice: { choiceVersion: "frame-choice", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
}
function requestFor(f: OmFixture, horizon: Ref, level: FrameLevel): FrameRequest {
  return { project: f.project, level, horizon, graph: reference(f.graphRevision), layer: reference(f.layers[level]),
    frame: null, upper: level === 2 ? null : { horizon, frame: null } };
}
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function branchStore(f: OmFixture, snapshot: string, name: string): Store {
  const path = join(f.root, `${name}.sqlite`); copyFileSync(snapshot, path); return new Store(path);
}
function replaceExact(value: unknown, replacements: Map<string, Ref>): unknown {
  if (isRef(value) && replacements.has(canonical(value))) return replacements.get(canonical(value))!;
  if (Array.isArray(value)) return value.map(item => replaceExact(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceExact(item, replacements)]));
  return value;
}

test("C2 reads both accepted garden layers without proof one or a frame and never writes the database", async t => {
  const f = await createOmFixture(t);
  const horizon = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
  assert.ok(!f.layers[1].value.layerProofs?.some(proof => proof.level === 1));
  for (const level of levels) {
    const request = requestFor(f, reference(horizon.gate), level), before = revisions(f.store);
    const historical = delivered(readFrame(f.store, request));
    const current = delivered(prepareFrame(f.store, request));
    assert.deepEqual(current.result, historical.result);
    assert.equal(historical.accepted!.frame, null);
    assert.deepEqual(historical.result.open, []);
    assert.deepEqual(historical.result.representatives, []);
    assert.ok(historical.result.fills.every(fill => fill.source === "accepted"));
    assert.deepEqual(current.expected, { graph: f.graphRevision.revision, layer: f.layers[level].revision, frame: 0 });
    assert.equal(historical.upperRef.id, `graph-layer:garden:${level - 1}`);
    assert.deepEqual(historical.upper, upper(f.graph, level));
    assert.ok(current.guards.some(guard => canonical(guard) === canonical(reference(f.graphRevision))));
    assert.deepEqual(revisions(f.store), before);
    assert.equal(f.store.list("connection-frame").length, 0);
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

test("the work scope excludes recorded operation identities after their blocks enter the horizon", async t => {
  const f = await createOmFixture(t), initial = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
  const horizonRequest = clone(initial.horizon.value.request) as HorizonRequest;
  horizonRequest.choice = { choiceVersion: "frame-identity-entry", features: [{ outcome: "garden-result" }], excluded: [] };
  const horizon = delivered(writeHorizon(f.store, horizonRequest));
  assert.ok(horizon.horizon.value.result.horizon.nodes.includes("garden-consume-block"));
  assert.equal(horizon.horizon.value.result.horizon.execution["garden-consume-block"]!.state, "needed");
  const request = requestFor(f, reference(horizon.gate), 3);
  const legacy = delivered(readFrame(f.store, request));
  assert.ok(legacy.scope.nodes.includes("garden-consume-operation"));
  assert.ok(legacy.scope.nodes.includes("garden-produce-operation"));
  assert.ok(legacy.result.fills.some(fill => fill.node === "w-garden-later-operation" && fill.source === "accepted"));
  const operations = delivered(readFrame(f.store, requestFor(f, reference(horizon.gate), 2)));
  const fills = operations.result.fills.map(fill => ({ ...fill,
    source: fill.node === "garden-consume-operation" ? "identity" as const : fill.source }));
  const frame = f.store.write({ id: "om-frame:garden:2", kind: "connection-frame", expected: 0,
    value: storedFrame(f.graph, 2, fills) });
  request.upper = { horizon: reference(horizon.gate), frame: reference(frame) };
  const before = revisions(f.store);
  for (const action of [readFrame, prepareFrame]) {
    const current = delivered(action(f.store, request));
    assert.ok(!current.scope.nodes.includes("garden-consume-operation"));
    assert.ok(current.scope.nodes.includes("garden-produce-operation"));
    assert.ok(current.result.fills.some(fill => fill.node === "w-garden-later-operation" && fill.source === "accepted"));
  }
  assert.deepEqual(revisions(f.store), before);
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
    accepted(candidate), prepared.upperRef, 2));
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
  refusedAs(transaction, "revision_conflict");
  assert.equal(store.get("candidate:garden"), null);
  assert.equal(store.get("candidate-status:garden"), null);
  assert.deepEqual(revisions(store), beforeConflict);
});

test("a prepared frame guards every mutable dependency before a neighbor can write any part of its transaction", async t => {
  const f = await createOmFixture(t), horizon = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
  const request = requestFor(f, reference(horizon.gate), 2);
  const inferred = delivered(readFrame(f.store, request));
  const record = f.store.write({ id: "om-frame:garden:2", kind: "connection-frame", expected: 0,
    value: storedFrame(f.graph, 2, inferred.result.fills) });
  request.frame = reference(record);
  const saved = delivered(readFrame(f.store, request));
  assert.ok(saved.result.fills.every(fill => canonical(fill.basis) === canonical(reference(record))));
  const snapshot = await f.store.snapshot(join(f.root, "frame-guards"));
  const dependencies = [reference(f.store.get("source:garden:brief")!), request.graph, request.layer!, request.frame];
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

test("accepted upper bases come from saved acceptance rather than the latest projection or a status claim", async t => {
  const f = await createOmFixture(t), horizon = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
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
  noUpper.upper = { horizon: reference(noRefinement.gate), frame: null };
  for (const action of [readFrame, prepareFrame]) {
    const refusal = refusedAs(action(f.store, noUpper), "frame_basis_unproven");
    assert.equal(refusal.at.field, "refinement");
  }
});

test("self-consistent lower proofs cannot replace saved layer research on either public path or level", async t => {
  const f = await createOmFixture(t), horizon = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
  const snapshot = await f.store.snapshot(join(f.root, "frame-lower-research")), untouched = revisions(f.store);
  for (const level of levels) for (const evidence of ["missing", "for-another-result", "guard-envelope"] as const) {
    let store = branchStore(f, snapshot.path, `frame-lower-${level}-${evidence}`);
    try {
      const historicalRequest = requestFor(f, reference(horizon.gate), level);
      const historical = delivered(readFrame(store, historicalRequest));
      assert.deepEqual(delivered(prepareFrame(store, historicalRequest)).result, historical.result);
      const graph = store.get<Graph>(historicalRequest.graph.id)!, changed = clone(graph.value);
      const node = changed.nodes.find(item => item.id === (level === 2 ? "garden-consume-operation" : "garden-consume-work"))!;
      if (evidence !== "guard-envelope") node.title += " unresearched change";
      const forgedGraph = evidence === "guard-envelope" ? graph
        : store.write({ id: graph.id, kind: graph.kind, expected: graph.revision, value: changed });
      const layer = store.get<FixtureLayer>(historicalRequest.layer!.id)!;
      const projection = projectGraph(changed, level), value = clone(layer.value);
      value.projection = projection;
      if (evidence === "missing") {
        value.inputs = [historical.upperRef]; value.obligations = [];
        value.layerProofs = [{ level, hash: hashJson(projection), inputs: [historical.upperRef] }];
      } else if (evidence === "guard-envelope") value.inputs = [];
      else value.layerProofs = value.layerProofs!.map(proof => proof.level === level ? { ...proof, hash: hashJson(projection) } : proof);
      const forgedLayer = store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value });
      const current: FrameRequest = { ...historicalRequest, graph: reference(forgedGraph), layer: reference(forgedLayer) };
      assert.equal(value.layerProofs!.find(proof => proof.level === level)!.hash, hashJson(value.projection));
      assert.deepEqual(projectGraph(changed, level === 2 ? 1 : 2), projectGraph(graph.value, level === 2 ? 1 : 2));
      const before = revisions(store);
      for (const action of [readFrame, prepareFrame]) refusedAs(action(store, current), "frame_basis_unproven");
      assert.deepEqual(revisions(store), before);
      assert.deepEqual(delivered(readFrame(store, historicalRequest)), historical);
      const path = store.path; store.close(); store = new Store(path);
      assert.deepEqual(delivered(readFrame(store, historicalRequest)), historical);
      for (const action of [readFrame, prepareFrame]) refusedAs(action(store, current), "frame_basis_unproven");
      assert.deepEqual(revisions(store), before);
    } finally { store.close(); }
  }
  for (const level of levels) {
    let store = branchStore(f, snapshot.path, `frame-layer-source-${level}`);
    try {
      const request = requestFor(f, reference(horizon.gate), level), historical = delivered(readFrame(store, request));
      delivered(prepareFrame(store, request));
      const own = f.layers[level].value.layerProofs!.find(proof => proof.level === level)!;
      const assessmentRef = own.inputs.find(ref => store.get(ref.id, ref.revision)?.kind === "research-assessment");
      assert.ok(assessmentRef);
      const assessment = store.get<ResearchAssessment>(assessmentRef.id, assessmentRef.revision)!;
      const observed = assessment.value.observations.find(observation => observation.source.id !== "source:garden:brief"
        && own.inputs.some(ref => canonical(ref) === canonical(observation.source)));
      assert.ok(observed);
      const source = store.get<Source>(observed.source.id, observed.source.revision)!;
      assert.ok(source.value.origin.kind === "owner-document" || source.value.origin.kind === "file");
      if (source.value.origin.kind === "file") {
        const capturedFile = source.value.origin.location, bytes = readFileSync(capturedFile);
        let fileStore = branchStore(f, snapshot.path, `frame-layer-file-${level}`);
        try {
          const beforeFile = revisions(fileStore);
          delivered(prepareFrame(fileStore, request));
          writeFileSync(capturedFile, Buffer.concat([bytes, Buffer.from("\nChanged after capture\n")]));
          assert.deepEqual(delivered(readFrame(fileStore, request)), historical);
          refusedAs(prepareFrame(fileStore, request), "frame_basis_unproven");
          assert.deepEqual(revisions(fileStore), beforeFile);
          const path = fileStore.path; fileStore.close(); fileStore = new Store(path);
          assert.deepEqual(delivered(readFrame(fileStore, request)), historical);
          refusedAs(prepareFrame(fileStore, request), "frame_basis_unproven");
          assert.deepEqual(revisions(fileStore), beforeFile);
        } finally { writeFileSync(capturedFile, bytes); fileStore.close(); }
      }
      store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
      const before = revisions(store);
      assert.deepEqual(delivered(readFrame(store, request)), historical);
      refusedAs(prepareFrame(store, request), "frame_basis_unproven");
      assert.deepEqual(revisions(store), before);
      const path = store.path; store.close(); store = new Store(path);
      assert.deepEqual(delivered(readFrame(store, request)), historical);
      refusedAs(prepareFrame(store, request), "frame_basis_unproven");
      assert.deepEqual(revisions(store), before);
    } finally { store.close(); }
  }
  for (const level of levels) for (const corrupt of ["environment", "origin-kind", "media-type"] as const) {
    const store = branchStore(f, snapshot.path, `frame-layer-malformed-${level}-${corrupt}`);
    try {
      const originalRequest = requestFor(f, reference(horizon.gate), level), request = clone(originalRequest);
      const historical = delivered(readFrame(store, originalRequest));
      const layer = store.get<FixtureLayer>(request.layer!.id)!;
      const own = layer.value.layerProofs!.find(proof => proof.level === level)!;
      const assessmentRef = own.inputs.find(ref => store.get(ref.id, ref.revision)?.kind === "research-assessment");
      assert.ok(assessmentRef);
      const assessment = store.get<ResearchAssessment>(assessmentRef.id, assessmentRef.revision)!;
      const replacements = new Map<string, Ref>();
      if (corrupt === "environment") {
        const target = store.get(assessment.value.environment.id)!;
        const malformed = store.write({ id: target.id, kind: target.kind, expected: target.revision, value: null });
        replacements.set(canonical(assessment.value.environment), reference(malformed));
      } else {
        const observation = assessment.value.observations.find(item => own.inputs.some(ref => canonical(ref) === canonical(item.source)));
        assert.ok(observation);
        const target = store.get<Source>(observation.source.id)!;
        const value = corrupt === "origin-kind"
          ? { ...target.value, origin: { ...target.value.origin, kind: [target.value.origin.kind] } }
          : { ...target.value, mediaType: [target.value.mediaType] };
        const malformed = store.write({ id: target.id, kind: target.kind, expected: target.revision, value });
        replacements.set(canonical(observation.source), reference(malformed));
      }
      const assessmentValue = replaceExact(assessment.value, replacements);
      const changedAssessment = store.write({ id: assessment.id, kind: assessment.kind, expected: assessment.revision, value: assessmentValue });
      replacements.set(canonical(reference(assessment)), reference(changedAssessment));
      const answerRef = own.inputs.find(ref => {
        const record = store.get<ResearchAnswer>(ref.id, ref.revision);
        return record?.kind === "research-answer" && canonical(record.value.assessment) === canonical(reference(assessment));
      });
      assert.ok(answerRef);
      const answer = store.get<ResearchAnswer>(answerRef.id, answerRef.revision)!;
      const changedAnswer = store.write({ id: answer.id, kind: answer.kind, expected: answer.revision, value: replaceExact(answer.value, replacements) });
      replacements.set(canonical(reference(answer)), reference(changedAnswer));
      const questionRef = own.inputs.find(ref => {
        const record = store.get<Question>(ref.id, ref.revision);
        return record?.kind === "question" && canonical(record.value.answer) === canonical(reference(answer));
      });
      assert.ok(questionRef);
      const question = store.get<Question>(questionRef.id, questionRef.revision)!;
      const changedQuestion = store.write({ id: question.id, kind: question.kind, expected: question.revision, value: replaceExact(question.value, replacements) });
      replacements.set(canonical(reference(question)), reference(changedQuestion));
      request.layer = reference(store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value: replaceExact(layer.value, replacements) }));
      const before = revisions(store);
      for (const action of [readFrame, prepareFrame]) refusedAs(action(store, request), "frame_basis_unproven");
      assert.deepEqual(revisions(store), before);
      assert.deepEqual(delivered(readFrame(store, originalRequest)), historical);
    } finally { store.close(); }
  }
  assert.deepEqual(revisions(f.store), untouched);
});

test("frame storage boundaries reject malformed refs and preserve unexpected engine exceptions without writes", async t => {
  const f = await createOmFixture(t), horizon = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
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

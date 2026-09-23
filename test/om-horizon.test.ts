import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { isRef, reference, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { Store, type Revision } from "../src/storage/store.js";
import { writeOmInput } from "../src/om/input.js";
import { writeGuarded } from "../src/om/refs.js";
import { REFUSAL_ROUTES, type Sealed, type OmResult } from "../src/om/refusal.js";
import {
  closeHorizon, gateHorizon, prepareHorizon, writeHorizon, readHorizon, HORIZON_REFUSAL_CODES,
  type HorizonOptions, type HorizonBuildResult, type HorizonRequest, type HorizonRecord,
} from "../src/om/horizon.js";
import { gardenGraph, createOmFixture, type OmFixture } from "./om-fixture.js";

const clone = <T>(value: T): T => structuredClone(value);
const producer = "garden-produce-block", consumer = "garden-consume-block", later = "garden-later-block";
const data = "garden-data", resultArtifact = "garden-result", flow = "garden-flow";
const receipt = (artifact: string, revision = 1): Ref => ({ id: `artifact-receipt:garden:${artifact}`, revision,
  hash: hashJson({ artifact, revision }) });
function upper(variant: "standard" | "cross" = "standard"): Graph {
  const { level: _level, ...graph } = projectGraph(gardenGraph(variant), 1);
  return graph as Graph;
}
const options = (overrides: Partial<HorizonOptions> = {}): HorizonOptions => ({ choiceVersion: "choice-1",
  features: [{ outcome: resultArtifact }], excluded: [], refined: [], available: {}, ...overrides });
function codes(value: Sealed<HorizonBuildResult>): string[] {
  return [...value.refusals.map(item => item.code), ...value.conflicts.map(item => item.code)];
}
function rejects(value: Sealed<HorizonBuildResult>, code: string): void {
  assert.ok(codes(value).includes(code), `Missing ${code}: ${codes(value).join(", ")}`);
  for (const refusal of value.refusals) {
    assert.ok(refusal.at.target.length > 0);
    assert.ok(refusal.message.length > 0);
    assert.ok(REFUSAL_ROUTES.includes(refusal.route));
  }
}
function hashOf(horizon: HorizonBuildResult['horizon']): string {
  const { hash: _hash, ...body } = horizon;
  return hashJson(body);
}
function passes(graph: Graph, opts: HorizonOptions) {
  const built = closeHorizon(graph, opts);
  assert.deepEqual(built.refusals, []);
  assert.deepEqual(built.conflicts, []);
  assert.deepEqual(gateHorizon(graph, opts, built as HorizonBuildResult), { passed: true, codes: [] });
  assert.equal(built.horizon.hash, hashOf(built.horizon as HorizonBuildResult['horizon']));
  return built.horizon;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "horizon_request_invalid");
  assert.ok(typeof (error.details as { target?: unknown })?.target === "string");
  return true;
}
const sortRows = <T>(rows: readonly T[]): T[] => [...rows].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);

test("garden horizon closes data and control prerequisites without adding behavior-return routes", () => {
  const graph = upper();
  const baseline = passes(graph, options());
  assert.deepEqual(baseline.nodes, [consumer, producer]);
  assert.deepEqual(baseline.features, [resultArtifact]);
  assert.deepEqual(baseline.refinement, { [consumer]: "needed", [producer]: "needed" });
  assert.deepEqual(baseline.execution, { [consumer]: { state: "needed" }, [producer]: { state: "needed" } });
  assert.deepEqual(baseline.boundary, []);
  assert.deepEqual(baseline.externalInputs, []);
  assert.deepEqual(baseline.excluded, []);
  graph.edges!.push(
    { id: "garden-needs-later", relation: "requires", source: consumer, target: later, condition: "Preparation is mandatory" },
    { id: "garden-retry", relation: "returns_to", source: consumer, target: "garden-refusal-block", condition: "Retry after refusal" },
  );
  const closed = passes(graph, options());
  assert.deepEqual(closed.nodes, [consumer, later, producer]);
  assert.equal(closed.nodes.includes("garden-refusal-block"), false);
  assert.equal(closed.nodes.some(node => node.endsWith("-operation") || node.endsWith("-work")), false);
});

test("a ready result remains in the horizon for refinement and becomes a boundary only with accepted refinement", () => {
  const graph = upper(), basis = { [data]: receipt(data) };
  const ready = passes(graph, options({ available: { [producer]: basis } }));
  assert.deepEqual(ready.nodes, [consumer, producer]);
  assert.equal(ready.refinement[producer], "needed");
  assert.deepEqual(ready.execution[producer], { state: "available", basis });
  assert.deepEqual(ready.boundary, []);
  const refined = passes(graph, options({ refined: [producer] }));
  assert.deepEqual(refined.nodes, [consumer, producer]);
  assert.equal(refined.refinement[producer], "accepted");
  assert.deepEqual(refined.execution[producer], { state: "needed" });
  const boundary = passes(graph, options({ refined: [producer], available: { [producer]: basis } }));
  assert.deepEqual(boundary.nodes, [consumer]);
  assert.deepEqual(boundary.boundary, [{ block: producer, basis }]);
  const selected = passes(graph, options({ features: [{ outcome: data }], refined: [producer], available: { [producer]: basis } }));
  assert.deepEqual(selected.nodes, [producer]);
  assert.deepEqual(selected.execution[producer], { state: "available", basis });
  assert.deepEqual(selected.boundary, []);
  const otherReceipt = passes(graph, options({ available: { [producer]: { [data]: receipt(data, 2) } } }));
  assert.notEqual(otherReceipt.hash, ready.hash);
});

test("every pure horizon refusal is addressed and excluded prerequisites retain their dependency path", () => {
  const graph = upper();
  const seen = new Set<string>();
  const cases: [string, HorizonOptions][] = [
    ["horizon_empty", options({ features: [] })],
    ["horizon_feature_unknown", options({ features: [{ outcome: "unknown-outcome" }] })],
    ["horizon_exclusion_unknown", options({ excluded: [{ block: "unknown-block", reason: "Outside scope", returnCondition: "Owner expands scope" }] })],
    ["horizon_exclusion_unjustified", options({ excluded: [{ block: later, reason: "", returnCondition: "Owner expands scope" }] })],
    ["horizon_exclusion_unjustified", options({ excluded: [{ block: later, reason: "Outside scope", returnCondition: "" }] })],
    ["horizon_requires_excluded", options({ excluded: [{ block: producer, reason: "Outside scope", returnCondition: "Owner expands scope" }] })],
    ["horizon_available_unproven", options({ available: { [producer]: receipt(data) } as unknown as HorizonOptions['available'] })],
    ["horizon_available_uncovered", options({ available: { [producer]: { [resultArtifact]: receipt(resultArtifact) } } })],
    ["horizon_refinement_unproven", options({ refined: ["unknown-block"] })],
    ["horizon_refinement_unproven", options({ refined: ["garden-product"] })],
  ];
  for (const [code, opts] of cases) {
    const built = closeHorizon(graph, opts);
    rejects(built, code);
    assert.equal(gateHorizon(graph, opts, built as HorizonBuildResult).passed, false);
    seen.add(code);
  }
  const broken = clone(graph);
  broken.connectors[0]!.bindings[0]!.producer.node = "missing-producer";
  rejects(closeHorizon(broken, options()), "horizon_unclosed");
  seen.add("horizon_unclosed");
  const missingArtifact = clone(graph);
  missingArtifact.artifacts = missingArtifact.artifacts.filter(artifact => artifact.id !== data);
  rejects(closeHorizon(missingArtifact, options()), "horizon_unclosed");
  assert.deepEqual([...seen].sort(), [...HORIZON_REFUSAL_CODES].sort());
  const conflict = closeHorizon(graph, cases[5]![1]);
  const path = conflict.conflicts.find(item => item.code === "horizon_requires_excluded")!.path;
  assert.ok(path[0]!.includes(resultArtifact));
  assert.ok(path.some(step => step.includes(flow)));
  assert.equal(path.at(-1), producer);
  assert.equal(conflict.horizon.nodes.includes(producer), false);
  assert.ok(gateHorizon(graph, cases[5]![1], conflict as HorizonBuildResult).codes.includes("horizon_requires_excluded"));
  const control = clone(graph);
  control.edges!.push({ id: "garden-required-later", relation: "requires", source: consumer, target: later, condition: "Mandatory result" });
  const viaControl = closeHorizon(control, options({ excluded: [{ block: later, reason: "Deferred", returnCondition: "Owner expands scope" }] }));
  const controlPath = viaControl.conflicts.find(item => item.block === later)!.path;
  assert.ok(controlPath.some(step => step.includes("garden-required-later")));
  assert.equal(controlPath.at(-1), later);
});

test("ready blocks prove every flow artifact, requires outcome and selected feature outcome", () => {
  const graph = upper();
  const extra = "garden-prep";
  graph.artifacts.push(clone(gardenGraph().artifacts.find(artifact => artifact.id === extra)!));
  graph.nodes.find(node => node.id === producer)!.ports.push({ id: "prep-out", direction: "out", contract: "garden-contract" });
  graph.nodes.find(node => node.id === consumer)!.ports.push({ id: "prep-in", direction: "in", contract: "garden-contract" });
  graph.connectors.push({ id: "garden-extra-flow", artifact: extra, returnsTo: producer, wakeTest: null,
    bindings: [{ level: 1, producer: { node: producer, port: "prep-out" }, consumers: [{ node: consumer, port: "prep-in" }], anchor: null }] });
  const partial = options({ refined: [producer], available: { [producer]: { [data]: receipt(data) } } });
  const missingFlow = closeHorizon(graph, partial);
  rejects(missingFlow, "horizon_available_uncovered");
  assert.ok(missingFlow.refusals.some(item => item.code === "horizon_available_uncovered" && item.at.target.includes(producer)
    && (item.at.target.includes(extra) || item.at.field?.includes(extra))));
  const complete = passes(graph, options({ refined: [producer], available: { [producer]: { [data]: receipt(data), [extra]: receipt(extra) } } }));
  assert.deepEqual(complete.boundary[0]!.basis, { [data]: receipt(data), [extra]: receipt(extra) });

  const required = upper();
  required.edges!.push({ id: "garden-required-later", relation: "requires", source: consumer, target: later, condition: "Mandatory later result" });
  const missingControl = closeHorizon(required, options({ available: { [later]: { [data]: receipt(data) } } }));
  rejects(missingControl, "horizon_available_uncovered");
  const coveredControl = passes(required, options({ refined: [later], available: { [later]: { "garden-later": receipt("garden-later") } } }));
  assert.deepEqual(coveredControl.boundary, [{ block: later, basis: { "garden-later": receipt("garden-later") } }]);
  const missingSelected = closeHorizon(upper(), options({ available: { [consumer]: { [data]: receipt(data) } } }));
  rejects(missingSelected, "horizon_available_uncovered");
  const coveredSelected = passes(upper(), options({ available: { [consumer]: { [resultArtifact]: receipt(resultArtifact) } } }));
  assert.deepEqual(coveredSelected.execution[consumer], { state: "available", basis: { [resultArtifact]: receipt(resultArtifact) } });
});

test("external cross flows retain every consumer and producer port of the final horizon", () => {
  const graph = upper("cross");
  graph.artifacts.find(artifact => artifact.id === data)!.external = true;
  const both = options({ features: [{ outcome: resultArtifact }, { outcome: "garden-later" }] });
  const horizon = passes(graph, both);
  assert.deepEqual(horizon.nodes, [consumer, later]);
  assert.deepEqual(horizon.boundary, []);
  assert.deepEqual(sortRows(horizon.externalInputs), sortRows([
    { consumer, connector: flow, source: producer, consumerPort: "in", sourcePort: "out", artifact: data },
    { consumer, connector: flow, source: producer, consumerPort: "in-alt", sourcePort: "out", artifact: data },
    { consumer, connector: flow, source: producer, consumerPort: "in", sourcePort: "out-alt", artifact: data },
    { consumer: later, connector: flow, source: producer, consumerPort: "in", sourcePort: "out", artifact: data },
  ]));
  const selected = passes(graph, options());
  assert.deepEqual(selected.nodes, [consumer]);
  assert.equal(selected.externalInputs.length, 3);
  assert.ok(selected.externalInputs.every(input => input.consumer === consumer));
  assert.equal(selected.nodes.includes(producer), false);
  const reverse = clone(graph);
  reverse.nodes.reverse(); reverse.connectors.reverse();
  for (const connector of reverse.connectors) {
    connector.bindings.reverse();
    for (const binding of connector.bindings) binding.consumers.reverse();
  }
  assert.deepEqual(passes(reverse, { ...both, features: [...both.features].reverse() }), horizon);
});

test("horizon hashing ignores traversal order but binds choice, exclusions and exact receipt versions", () => {
  const graph = upper("cross");
  const opts = options({ features: [{ outcome: "garden-later" }, { outcome: resultArtifact }], refined: [producer, consumer],
    excluded: [{ block: "garden-refusal-block", reason: "No invalid-input delivery selected", returnCondition: "Select refusal outcome" }],
    available: { [producer]: { [data]: receipt(data) }, [consumer]: { [resultArtifact]: receipt(resultArtifact) } } });
  const built = closeHorizon(graph, opts);
  assert.deepEqual(built.refusals, []);
  const shuffled = clone(graph); shuffled.nodes.reverse(); shuffled.artifacts.reverse(); shuffled.connectors.reverse();
  for (const connector of shuffled.connectors) { connector.bindings.reverse(); for (const binding of connector.bindings) binding.consumers.reverse(); }
  const permuted = options({ ...opts, features: [...opts.features].reverse(), refined: [...opts.refined].reverse(),
    available: { [consumer]: { [resultArtifact]: receipt(resultArtifact) }, [producer]: { [data]: receipt(data) } } });
  assert.deepEqual(closeHorizon(shuffled, permuted), built);
  assert.notEqual(closeHorizon(graph, { ...opts, choiceVersion: "choice-2" }).horizon.hash, built.horizon.hash);
  const excluded = clone(opts); excluded.excluded[0]!.reason = "Owner changed exclusion basis";
  assert.notEqual(closeHorizon(graph, excluded).horizon.hash, built.horizon.hash);
  const changed = clone(opts); changed.available[producer]![data] = receipt(data, 2);
  assert.notEqual(closeHorizon(graph, changed).horizon.hash, built.horizon.hash);
  assert.ok(Object.isFrozen(built) && Object.isFrozen(built.horizon) && Object.isFrozen(built.horizon.execution));
  opts.available[producer]![data]!.hash = "0".repeat(64);
  assert.equal(built.horizon.hash, hashOf(built.horizon as HorizonBuildResult['horizon']));
  assert.ok(Object.isFrozen(HORIZON_REFUSAL_CODES));
});

test("G2 rederives closure and rejects forged omissions even after a self-consistent hash is recomputed", () => {
  const graph = upper(), opts = options();
  const valid = closeHorizon(graph, opts);
  for (const mutate of [
    (candidate: HorizonBuildResult) => { candidate.horizon.nodes = candidate.horizon.nodes.filter(id => id !== producer); },
    (candidate: HorizonBuildResult) => { delete candidate.horizon.execution[producer]; },
    (candidate: HorizonBuildResult) => { candidate.horizon.refinement[producer] = "accepted"; },
  ]) {
    const forged = clone(valid) as HorizonBuildResult;
    mutate(forged);
    forged.horizon.hash = hashOf(forged.horizon);
    const gate = gateHorizon(graph, opts, forged);
    assert.equal(gate.passed, false);
    assert.ok(gate.codes.includes("horizon_unclosed"));
  }
  for (const value of [undefined, null, "graph", 7, []]) {
    assert.throws(() => closeHorizon(value as unknown as Graph, opts), malformed);
    assert.throws(() => closeHorizon(graph, value as unknown as HorizonOptions), malformed);
    assert.throws(() => gateHorizon(graph, opts, value as unknown as HorizonBuildResult), malformed);
  }
  for (const key of ["choiceVersion", "features", "excluded", "refined", "available"] as const) {
    const missing = clone(opts) as Partial<HorizonOptions>; delete missing[key];
    assert.throws(() => closeHorizon(graph, missing as HorizonOptions), malformed);
  }
  const missingNodes = clone(graph) as Partial<Graph>; delete missingNodes.nodes;
  assert.throws(() => closeHorizon(missingNodes as Graph, opts), malformed);
  assert.throws(() => gateHorizon(graph, opts, { horizon: valid.horizon } as HorizonBuildResult), malformed);
});

function delivered<T>(value: OmResult<T>): T {
  if (!value.ok) assert.fail(`Unexpected refusal ${value.refusal.code} at ${canonical(value.refusal.at)}: ${value.refusal.message}`);
  return value.value;
}
function refusedAs<T>(value: OmResult<T>, expected: string) {
  if (value.ok) assert.fail(`Expected ${expected}, got success`);
  assert.equal(value.refusal.code, expected);
  assert.ok(value.refusal.at.target.length > 0);
  assert.ok(REFUSAL_ROUTES.includes(value.refusal.route));
  return value.refusal;
}
async function storedFixture(t: test.TestContext) {
  const f = await createOmFixture(t);
  const input = delivered(writeOmInput(f.store, { project: f.project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const req: HorizonRequest = {
    project: f.project, input: reference(input), graph: reference(f.graphRevision), refinement: reference(f.store.get("phase:garden:L2")!),
    choice: { choiceVersion: "choice-1", features: [{ outcome: resultArtifact }], excluded: [] },
    available: { [producer]: { [data]: reference(f.receipts[data]!) } },
  };
  return { f, req };
}
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function copyStore(f: OmFixture, snapshot: string, name: string): Store {
  const path = join(f.root, `${name}.sqlite`);
  copyFileSync(snapshot, path);
  return new Store(path);
}
function rebind(value: Json, from: Ref, to: Ref): Json {
  if (isRef(value) && canonical(value) === canonical(from)) return to as unknown as Json;
  if (Array.isArray(value)) return value.map(item => rebind(item, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebind(item, from, to)]));
  return value;
}
function replaceResearch(store: Store, current: HorizonRequest, mutate: (value: Record<string, Json>) => void): void {
  const r1 = store.get<Record<string, Json>>("phase:garden:R1")!;
  const value = clone(r1.value); mutate(value);
  const changed = store.write({ id: r1.id, kind: r1.kind, expected: r1.revision, value });
  const phase = store.get<{ layer: Ref; inputs: Ref[] }>(current.refinement!.id)!;
  const layer = store.get(phase.value.layer.id)!;
  const revisedLayer = store.write({ id: layer.id, kind: layer.kind, expected: layer.revision,
    value: rebind(layer.value, reference(r1), reference(changed)) });
  const phaseValue = rebind(rebind(phase.value as unknown as Json, reference(r1), reference(changed)), reference(layer), reference(revisedLayer));
  current.refinement = reference(store.write({ id: phase.id, kind: phase.kind, expected: phase.revision, value: phaseValue }));
}

test("stored G2 binds the actual checked horizon and real artifact receipts, with stable historical replay", async t => {
  const { f, req } = await storedFixture(t);
  req.available[consumer] = { [resultArtifact]: reference(f.receipts[resultArtifact]!) };
  req.choice.excluded = [
    { block: later, reason: "Later feature is outside this delivery", returnCondition: "Owner selects later feature" },
    { block: "garden-refusal-block", reason: "Refusal result is outside this delivery", returnCondition: "Owner selects refusal result" },
  ];
  const before = revisions(f.store);
  const prepared = delivered(prepareHorizon(f.store, req));
  assert.deepEqual(revisions(f.store), before);
  assert.equal(prepared.existing, null);
  assert.equal(prepared.writes.length, 2);
  assert.deepEqual(prepared.writes.map(write => write.kind).sort(), ["horizon", "om-horizon"]);
  const saved = delivered(writeHorizon(f.store, req));
  assert.equal(saved.horizon.id, "horizon:garden:choice-1");
  assert.equal(saved.gate.id, "om-horizon:garden:choice-1");
  assert.equal(saved.gate.value.state, "accepted");
  assert.deepEqual(saved.gate.value.horizon, reference(saved.horizon));
  assert.equal(saved.gate.value.horizonHash, saved.horizon.value.result.horizon.hash);
  assert.deepEqual(saved.gate.value.codes, []);
  assert.equal(saved.horizon.hash, hashJson(saved.horizon.value));
  assert.equal(saved.gate.hash, hashJson(saved.gate.value));
  const horizon = saved.horizon.value.result.horizon;
  assert.deepEqual(horizon.nodes, [consumer]);
  assert.deepEqual(horizon.boundary, [{ block: producer, basis: { [data]: reference(f.receipts[data]!) } }]);
  assert.deepEqual(horizon.execution[consumer], { state: "available", basis: { [resultArtifact]: reference(f.receipts[resultArtifact]!) } });
  assert.deepEqual(revisions(f.store).filter(row => ![saved.horizon.id, saved.gate.id].includes(row.head.id)), before);
  const repeated = clone(req); repeated.choice.excluded.reverse();
  repeated.available = { [consumer]: clone(req.available[consumer]!), [producer]: clone(req.available[producer]!) };
  assert.deepEqual(delivered(writeHorizon(f.store, repeated)), saved);
  const reuse = delivered(prepareHorizon(f.store, repeated));
  assert.deepEqual(reuse.writes, []);
  assert.deepEqual(reuse.existing, saved);
  for (const ref of [reference(saved.horizon), reference(saved.gate)])
    assert.ok(reuse.guards.some(guard => canonical(guard) === canonical(ref)));
  const changed = clone(req); changed.choice.excluded[0]!.reason += " changed";
  refusedAs(writeHorizon(f.store, changed), "horizon_choice_conflict");
  assert.equal(f.store.history(saved.horizon.id).length, 1);
  assert.equal(f.store.history(saved.gate.id).length, 1);
  const source = f.store.get("source:garden:brief")!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  refusedAs(prepareHorizon(f.store, req), "stage_not_accepted");
  assert.deepEqual(delivered(writeHorizon(f.store, req)), saved);
  assert.deepEqual(delivered(readHorizon(f.store, f.project, reference(saved.gate))), saved);
  const environment = f.store.get("environment:garden")!;
  f.store.write({ id: environment.id, kind: environment.kind, expected: environment.revision, value: environment.value });
  f.reopen();
  assert.deepEqual(delivered(writeHorizon(f.store, req)), saved);
  assert.deepEqual(delivered(readHorizon(f.store, f.project, reference(saved.gate))), saved);
});

test("refused choices persist their conflict while forged namespaces, hashes and readiness claims cannot masquerade as accepted", async t => {
  const { f, req } = await storedFixture(t);
  const snapshot = await f.store.snapshot(join(f.root, "valid-horizon-template"));
  const excluded = clone(req);
  excluded.choice.excluded = [{ block: producer, reason: "Owner excludes producer", returnCondition: "Owner lifts exclusion" }];
  const conflict = delivered(writeHorizon(f.store, excluded));
  assert.equal(conflict.gate.value.state, "refused");
  assert.ok(conflict.gate.value.codes.includes("horizon_requires_excluded"));
  assert.deepEqual(conflict.gate.value.horizon, reference(conflict.horizon));
  assert.ok(conflict.horizon.value.result.conflicts.some(item => item.block === producer && item.path.at(-1)!.endsWith(producer)));
  assert.deepEqual(delivered(writeHorizon(f.store, excluded)), conflict);
  assert.deepEqual(delivered(readHorizon(f.store, f.project, reference(conflict.gate))), conflict);
  const validNewChoice = { ...req, choice: { ...req.choice, choiceVersion: "choice-2" } };
  assert.equal(delivered(writeHorizon(f.store, validNewChoice)).gate.value.state, "accepted");
  assert.equal(f.store.get(conflict.gate.id)!.revision, 1);

  const cases: { code: string; field?: string; change: (store: Store, current: HorizonRequest) => void }[] = [
    { code: "record_foreign", change: (_store, current) => { current.input.id = "om-input:other"; } },
    { code: "record_forged", change: (_store, current) => { current.input.hash = "0".repeat(64); } },
    { code: "record_foreign", change: (_store, current) => { current.graph.id = "graph:other"; } },
    { code: "record_forged", change: (_store, current) => { current.graph.hash = "0".repeat(64); } },
    { code: "record_missing", change: (_store, current) => { current.graph.revision = 99999; } },
    { code: "horizon_refinement_unproven", change: (store, current) => {
      const phase = store.get<Record<string, unknown>>(current.refinement!.id)!;
      current.refinement = reference(store.write({ id: phase.id, kind: phase.kind, expected: phase.revision,
        value: { ...phase.value, status: "accepted", phase: "R0" } }));
    } },
    { code: "horizon_refinement_unproven", field: "layerProofs", change: (store, current) => {
      const phase = store.get<{ layer: Ref; inputs: Ref[] }>(current.refinement!.id)!;
      const layer = store.get<Record<string, unknown>>(phase.value.layer.id)!;
      const r1 = phase.value.inputs.find(ref => ref.id === "phase:garden:R1");
      assert.ok(r1);
      const withoutProofs = store.write({ id: layer.id, kind: layer.kind, expected: layer.revision,
        value: { ...layer.value, layerProofs: [], obligations: [], inputs: [] } });
      current.refinement = reference(store.write({ id: phase.id, kind: phase.kind, expected: phase.revision,
        value: { ...phase.value, layer: reference(withoutProofs), inputs: [r1, reference(withoutProofs)] } }));
    } },
    { code: "horizon_refinement_unproven", change: (store, current) => {
      const phase = store.get<{ layer: Ref; inputs: Ref[] }>(current.refinement!.id)!;
      const layer = store.get<{ projection: Json }>(phase.value.layer.id)!;
      const hollow = store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value: { ...layer.value,
        layerProofs: [{ level: 2, hash: hashJson(layer.value.projection), inputs: [] }], obligations: [], inputs: [] } });
      current.refinement = reference(store.write({ id: phase.id, kind: phase.kind, expected: phase.revision,
        value: rebind(phase.value as unknown as Json, reference(layer), reference(hollow)) }));
    } },
    { code: "horizon_refinement_unproven", field: "draft", change: (store, current) => {
      replaceResearch(store, current, value => { value['draft'] = null; });
    } },
    { code: "horizon_refinement_unproven", field: "contractVersion", change: (store, current) => {
      replaceResearch(store, current, value => { delete value['contractVersion']; });
    } },
    { code: "horizon_available_unproven", change: (store, current) => {
      const ref = current.available[producer]![data]!;
      const proof = store.get<Record<string, unknown>>(ref.id)!;
      current.available[producer]![data] = reference(store.write({ id: proof.id, kind: proof.kind, expected: proof.revision,
        value: { ...proof.value, accepted: true, projectId: "other" } }));
    } },
    { code: "horizon_available_unproven", change: (store, current) => {
      const ref = current.available[producer]![data]!;
      const proof = store.get<Record<string, unknown>>(ref.id)!;
      current.available[producer]![data] = reference(store.write({ id: proof.id, kind: proof.kind, expected: proof.revision,
        value: { ...proof.value, accepted: true, artifact: resultArtifact } }));
    } },
  ];
  for (const role of ["draft", "question", "answer", "assessment", "source", "environment"] as const) cases.push({
    code: "horizon_refinement_unproven", change: (store, current) => {
      const phase = store.get<{ layer: Ref; inputs: Ref[] }>(current.refinement!.id)!;
      const layer = store.get<{ layerProofs: { level: number; inputs: Ref[] }[]; obligations: { inputs: Ref[] }[]; inputs: Ref[] }>(phase.value.layer.id)!;
      const value = clone(layer.value), proof = value.layerProofs.find(item => item.level === 2)!;
      const draft = proof.inputs.map(ref => store.get<{ consumer: string; fields: Record<string, Json>; questions: string[] }>(ref.id, ref.revision)!)
        .find(record => record.kind === "discovery-draft" && record.value.consumer === "garden-product" && record.value.fields['layerDesign'])!;
      const question = store.get<{ answer: Ref }>(draft.value.questions[0]!)!;
      const answer = store.get<{ assessment: Ref }>(question.value.answer.id, question.value.answer.revision)!;
      const assessment = store.get<{ observations: { source: Ref }[]; environment: Ref }>(answer.value.assessment.id, answer.value.assessment.revision)!;
      if (role === "environment") {
        const changedAssessment = store.write({ id: assessment.id, kind: assessment.kind, expected: assessment.revision,
          value: { ...assessment.value, environment: { ...assessment.value.environment, revision: 99999 } } });
        const changedAnswer = store.write({ id: answer.id, kind: answer.kind, expected: answer.revision,
          value: { ...answer.value, assessment: reference(changedAssessment) } });
        const changedQuestion = store.write({ id: question.id, kind: question.kind, expected: question.revision,
          value: { ...question.value, answer: reference(changedAnswer) } });
        const replacements = [[assessment, changedAssessment], [answer, changedAnswer], [question, changedQuestion]] as const;
        const replace = (body: Json) => replacements.reduce((previous, [from, to]) => rebind(previous, reference(from), reference(to)), body);
        const revised = store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value: replace(layer.value as unknown as Json) });
        current.refinement = reference(store.write({ id: phase.id, kind: phase.kind, expected: phase.revision,
          value: rebind(replace(phase.value as unknown as Json), reference(layer), reference(revised)) }));
        return;
      }
      const removed = { draft: reference(draft), question: reference(question), answer: reference(answer),
        assessment: reference(assessment), source: assessment.value.observations[0]!.source }[role];
      assert.ok(proof.inputs.some(ref => canonical(ref) === canonical(removed)), role);
      proof.inputs = proof.inputs.filter(ref => canonical(ref) !== canonical(removed));
      value.inputs = [...new Map([...value.layerProofs.flatMap(item => item.inputs), ...value.obligations.flatMap(item => item.inputs)]
        .map(ref => [canonical(ref), ref])).values()];
      const revised = store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value });
      current.refinement = reference(store.write({ id: phase.id, kind: phase.kind, expected: phase.revision,
        value: rebind(phase.value as unknown as Json, reference(layer), reference(revised)) }));
    },
  });
  for (const [index, entry] of cases.entries()) {
    const store = copyStore(f, snapshot.path, `bad-${index}`);
    try {
      const current = clone(req); entry.change(store, current);
      const before = revisions(store);
      const preparation = refusedAs(prepareHorizon(store, current), entry.code);
      const writing = refusedAs(writeHorizon(store, current), entry.code);
      if (entry.field) {
        assert.equal(preparation.at.field, entry.field);
        assert.equal(writing.at.field, entry.field);
      }
      assert.deepEqual(revisions(store), before);
      assert.equal(store.list("horizon").length, 0);
      assert.equal(store.list("om-horizon").length, 0);
    } finally { store.close(); }
  }
});

test("new and existing horizon preparations guard sources, graph, refinement and receipts without partial neighbor writes", async t => {
  const { f, req } = await storedFixture(t);
  const snapshot = await f.store.snapshot(join(f.root, "guarded-horizon-template"));
  const dependencies = [
    { ref: reference(f.store.get("source:garden:brief")!), code: "stage_not_accepted" },
    { ref: req.graph, code: "input_stale" },
    { ref: req.refinement!, code: "input_stale" },
    { ref: req.available[producer]![data]!, code: "input_stale" },
  ];
  for (const mode of ["new", "existing"] as const) for (const [index, dependency] of dependencies.entries()) {
    const store = copyStore(f, snapshot.path, `guard-${mode}-${index}`);
    try {
      const saved = mode === "existing" ? delivered(writeHorizon(store, req)) : null;
      const prepared = delivered(prepareHorizon(store, req));
      assert.equal(prepared.writes.length, mode === "existing" ? 0 : 2);
      assert.equal(prepared.existing !== null, mode === "existing");
      const head = store.get(dependency.ref.id)!;
      store.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
      const before = revisions(store);
      const transaction = writeGuarded(store, { unit: "horizon-neighbor", target: "neighbor:garden", guards: prepared.guards,
        writes: [...prepared.writes, { id: "neighbor:garden", kind: "neighbor", expected: 0,
          value: { choiceVersion: req.choice.choiceVersion } }] });
      refusedAs(transaction, "input_stale");
      assert.equal(store.get("neighbor:garden"), null);
      assert.deepEqual(revisions(store), before);
      assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(dependency.ref)), dependency.ref.id);
      refusedAs(prepareHorizon(store, req), dependency.code);
      if (saved) {
        assert.deepEqual(delivered(writeHorizon(store, req)), saved);
        assert.deepEqual(delivered(readHorizon(store, f.project, reference(saved.gate))), saved);
      } else refusedAs(writeHorizon(store, req), dependency.code);
      assert.equal(store.list("horizon").length, mode === "existing" ? 1 : 0);
      assert.equal(store.list("om-horizon").length, mode === "existing" ? 1 : 0);
    } finally { store.close(); }
  }
});

test("stored horizon readers rederive exact sources and all public boundaries preserve addressed failures and engine exceptions", async t => {
  const { f, req } = await storedFixture(t);
  const unrefined: HorizonRequest = { ...req, refinement: null, available: {} };
  const saved = delivered(writeHorizon(f.store, unrefined));
  const counterfeit = clone(saved.horizon.value) as HorizonRecord;
  counterfeit.request.choice.choiceVersion = "choice-forged";
  counterfeit.result.horizon.choiceVersion = "choice-forged";
  counterfeit.result.horizon.nodes = [consumer];
  delete counterfeit.result.horizon.execution[producer];
  delete counterfeit.result.horizon.refinement[producer];
  counterfeit.result.horizon.hash = hashOf(counterfeit.result.horizon);
  const forgedHorizon = f.store.write({ id: "horizon:garden:choice-forged", kind: saved.horizon.kind, expected: 0, value: counterfeit });
  const forgedGate = f.store.write({ id: "om-horizon:garden:choice-forged", kind: saved.gate.kind, expected: 0,
    value: { ...saved.gate.value, choiceVersion: "choice-forged", horizon: reference(forgedHorizon), horizonHash: counterfeit.result.horizon.hash } });
  refusedAs(readHorizon(f.store, f.project, reference(forgedGate)), "record_forged");
  assert.deepEqual(delivered(readHorizon(f.store, f.project, reference(saved.gate))), saved);
  for (const value of [undefined, null, 7, "invalid/project", []]) {
    for (const action of [prepareHorizon, writeHorizon]) {
      assert.throws(() => action(value as unknown as Store, req), malformed);
      assert.throws(() => action(f.store, value as unknown as HorizonRequest), malformed);
    }
    assert.throws(() => readHorizon(value as unknown as Store, f.project, reference(saved.gate)), malformed);
    assert.throws(() => readHorizon(f.store, value as unknown as string, reference(saved.gate)), malformed);
  }
  for (const field of ["project", "input", "graph", "refinement", "choice", "available"] as const) {
    const missing = clone(req) as Partial<HorizonRequest>; delete missing[field];
    assert.throws(() => prepareHorizon(f.store, missing as HorizonRequest), malformed);
    assert.throws(() => writeHorizon(f.store, missing as HorizonRequest), malformed);
  }
  const fresh = { ...req, choice: { ...req.choice, choiceVersion: "choice-exception" } };
  const originalGet = f.store.get;
  const before = revisions(f.store);
  for (const failure of [new TypeError("horizon validator failed"), new EngineError("record_corrupt", "horizon source corrupted", { target: req.graph.id })]) {
    f.store.get = function<T = Json>(id: string, revision?: number): Revision<T> | null {
      if (id === req.graph.id && revision === undefined) throw failure;
      return originalGet.call(f.store, id, revision) as Revision<T> | null;
    };
    try {
      for (const action of [prepareHorizon, writeHorizon]) assert.throws(() => action(f.store, fresh), error => error === failure);
      assert.throws(() => prepareHorizon(f.store, unrefined), error => error === failure);
      assert.deepEqual(delivered(writeHorizon(f.store, unrefined)), saved);
      assert.deepEqual(revisions(f.store), before);
    } finally { f.store.get = originalGet; }
  }
});

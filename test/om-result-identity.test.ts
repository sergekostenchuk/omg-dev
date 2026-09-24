import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Graph, Node } from "../src/graph/model.js";
import { fillObligations, prepareFrame, type FrameFill, type FrameObligation, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { OmResult } from "../src/om/refusal.js";
import { extractResultSlice, factResultKey, normalizeResultContent, readResultIdentity, type FactResultIdentity, type ResultIdentityRequest, type ResultDependencySlice, RESULT_SLICE_REFUSAL_CODES } from "../src/om/result-identity.js";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { projectGraph } from "../src/graph/project.js";
import { historicalTrace, withHistoricalReads, writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import { writeCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate, type AcceptedFrameRequest } from "../src/om/frame-accept.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { git } from "../src/runtime/environment.js";

const clone = structuredClone;
const fact = (): FactResultIdentity => ({
  project: "garden", target: "garden-operation", field: "input",
  contract: { establishes: "The repository's supported input format", consumer: { mechanism: "M6", uses: ["code-answer"] },
    requirements: [{ format: "JSON" }, { environment: "production" }], resultForm: { type: "object", required: ["format"] } },
  value: { format: "JSON", title: "Current format", purpose: "Feed the operation", benefit: "Structured input", beneficiary: "operator" },
});

test("fact keys use all four contract parts and value, without frame description exclusions", () => {
  const input = fact(), key = factResultKey(input);
  assert.match(key, /^om-result:[a-f0-9]{64}$/);
  assert.equal(factResultKey(clone(input)), key);
  const changes: ((value: FactResultIdentity) => void)[] = [
    value => { value.project = "other"; }, value => { value.target = "other"; }, value => { value.field = "other"; },
    value => { value.contract.establishes = "The supported streaming input format"; },
    value => { value.contract.consumer = { mechanism: "M8" }; },
    value => { value.contract.requirements = [{ format: "streaming JSON" }, { environment: "production" }]; },
    value => { value.contract.resultForm = { type: "string" }; },
    value => { (value.value as Record<string, Json>)["format"] = "streaming JSON"; },
    ...["title", "purpose", "benefit", "beneficiary"].map(field => (value: FactResultIdentity) => {
      (value.value as Record<string, Json>)[field] = "changed fact text";
    }),
  ];
  for (const change of changes) { const changed = clone(input); change(changed); assert.notEqual(factResultKey(changed), key); }
  const b = clone(input); (b.value as Record<string, Json>)["format"] = "streaming JSON";
  const bKey = factResultKey(b);
  assert.equal(factResultKey(clone(input)), key);
  assert.equal(factResultKey(clone(b)), bKey);
});

test("fact normalization sorts only top-level requirements, retaining every multiplicity and nested array order", () => {
  const input = fact(); input.value = ["first", "second", "first"];
  const key = factResultKey(input), reordered = clone(input);
  reordered.contract.requirements.reverse(); assert.equal(factResultKey(reordered), key);
  const repeated = clone(input); repeated.contract.requirements.push(clone(input.contract.requirements[0]!));
  assert.notEqual(factResultKey(repeated), key);
  const permutation = clone(input); permutation.value = ["second", "first", "first"];
  assert.notEqual(factResultKey(permutation), key);
  const multiplicity = clone(input); multiplicity.value = ["first", "second"];
  assert.notEqual(factResultKey(multiplicity), key);
  for (const part of ["consumer", "requirements", "resultForm"] as const) {
    const a = fact(), b = fact();
    if (part === "requirements") { a.contract.requirements = [["first", "second"]]; b.contract.requirements = [["second", "first"]]; }
    else { a.contract[part] = { sequence: ["first", "second"] }; b.contract[part] = { sequence: ["second", "first"] }; }
    assert.notEqual(factResultKey(a), factResultKey(b), part);
  }
});

test("fact keys retain missing versus explicit null and own __proto__ content without mutating input", () => {
  const input = fact(); input.value = {};
  const absent = factResultKey(input); input.value = { optional: null };
  assert.notEqual(factResultKey(input), absent);
  input.value = null; assert.notEqual(factResultKey(input), absent);
  input.value = JSON.parse('{"__proto__":{"format":"JSON"},"sequence":["b","a"]}') as Json;
  const before = canonical(input), key = factResultKey(input);
  assert.equal(canonical(input), before);
  assert.ok(!Object.isFrozen(input) && !Object.isFrozen(input.contract.requirements));
  assert.ok(Object.hasOwn(input.value as object, "__proto__"));
  assert.equal(Object.getPrototypeOf(input.value), Object.prototype);
  const withoutPrototypeField = clone(input); withoutPrototypeField.value = { sequence: ["b", "a"] };
  assert.notEqual(factResultKey(withoutPrototypeField), key);
  const differentPrototypeField = clone(input);
  Object.defineProperty(differentPrototypeField.value, "__proto__", { value: { format: "XML" }, enumerable: true });
  assert.notEqual(factResultKey(differentPrototypeField), key);
});

test("fact identity refuses absent, inherited, foreign metadata and invalid JSON with an address", () => {
  function rejects(input: unknown, field: string): void {
    assert.throws(() => factResultKey(input as FactResultIdentity), error => error instanceof EngineError
      && error.code === "result_identity_invalid"
      && (error.details as { unit: string; target: string; field: string }).unit === "D5"
      && (error.details as { target: string }).target === "fact-result"
      && (error.details as { field: string }).field === field);
  }
  for (const value of [undefined, null, [], 42, new Date()]) rejects(value, "input");
  for (const field of ["project", "target", "field", "contract", "value"]) {
    const missing = fact() as unknown as Record<string, unknown>; delete missing[field]; rejects(missing, field);
  }
  for (const field of ["project", "target", "field"]) rejects({ ...fact(), [field]: " " }, field);
  for (const field of ["id", "revision", "inputRevision", "pass", "assessor", "kind"])
    rejects({ ...fact(), [field]: "not content" }, "input");
  rejects(Object.create(fact()), "input");
  for (const field of ["establishes", "consumer", "requirements", "resultForm"]) {
    const missing = fact(); delete (missing.contract as unknown as Record<string, unknown>)[field];
    rejects(missing, `contract.${field}`);
  }
  const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
  for (const value of [undefined, Number.NaN, Infinity, () => null, new Date(), cyclic, ["first", undefined], Array(2)])
    rejects({ ...fact(), value }, "value");
});

function delivered<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refusedAs(result: OmResult<unknown>, code: string): void {
  if (result.ok) assert.fail(`Expected ${code}`);
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target && result.refusal.at.field);
  assert.equal(result.refusal.route, "producer");
}
function source(): { graph: Graph; obligation: FrameObligation; fills: FrameFill[] } {
  const node = (id: string, kind: Node["kind"], parent: string | null, direction?: "in" | "out"): Node => ({
    id, kind, parent, title: `${id} title`, outcome: "artifact", boundary: {
      authority: "owner", writer: "writer", rollback: "owner", state: "durable", provider: false,
    }, ports: direction ? [{ id: direction, direction, contract: "contract" }] : [],
    code: [], tests: [], purpose: `${id} purpose`, benefit: "benefit", beneficiary: "actor", implements: ["requirement"],
  });
  const operation = node("operation", "operation", "block", "out");
  operation.code = [{ path: "src/feature.ts", symbol: "run", access: "write", status: "planned" }]; operation.tests = ["test"];
  const graph: Graph = {
    version: 2, id: "product-graph", title: "product", horizon: [],
    nodes: [node("product", "product", null), node("block", "block", "product", "out"), operation,
      node("peer-block", "block", "product", "in"), node("peer", "operation", "peer-block", "in"),
      { ...node("unrelated", "block", "product"), outcome: "unrelated-artifact", implements: [] }],
    contracts: [{ id: "contract", schema: { type: "array", examples: [["first", "second"]] } },
      { id: "unrelated-contract", schema: { type: "string" } }],
    artifacts: [{ id: "artifact", contract: "contract", external: false, terminal: false,
      kind: "document", purpose: "delivered value", durability: "immutable", sensitivity: "project_internal" },
    { id: "unrelated-artifact", contract: "unrelated-contract", external: false, terminal: true,
      kind: "document", purpose: "unrelated", durability: "versioned", sensitivity: "public" }],
    connectors: [{ id: "connector", artifact: "artifact", returnsTo: "block", wakeTest: "test", bindings: [
      { level: 1, producer: { node: "block", port: "out" }, consumers: [{ node: "peer-block", port: "in" }], anchor: null },
      { level: 2, producer: { node: "operation", port: "out", codeRef: clone(operation.code[0]!) },
        consumers: [{ node: "peer", port: "in" }], anchor: "anchor" },
    ] }],
    anchors: [{ id: "anchor", owner: "operation", outcome: "artifact", test: "test" }],
    joins: [{ id: "join", consumer: "peer", connectors: ["connector"], condition: "all required", required: ["connector"], optional: [],
      failures: { missing: "missing", extra: "extra", foreign: "foreign", stale: "stale", duplicate: "duplicate", returnsTo: "block" } }],
    tests: [{ id: "test", node: "operation", command: { executable: "node", args: ["first", "second"] },
      covers: ["connector"], obligations: ["outcome", "restart_cold"], contract: {
        given: ["first premise", "second premise"], when: "run operation", then: ["first assertion", "second assertion"],
        forbiddenEffects: ["do not mutate input"], entrypoint: { kind: "api", path: "src/feature.ts", symbol: "run", status: "planned" },
        counterfactuals: [{ connector: "connector", mutation: "remove", expectedFailure: "missing", command: { executable: "node", args: ["remove", "--check"] } }],
        resourceClass: "exclusive", resources: ["resource"],
      } }],
    actors: [{ id: "actor", role: "operator", channels: ["cli", "api"] }],
    requirements: [{ id: "requirement", section: "section", outcome: "artifact", beneficiary: "actor", statement: "Deliver value" }],
    edges: [{ id: "edge", relation: "requires", source: "operation", target: "peer", condition: "input ready" }],
    journeys: [{ id: "journey", actor: "actor", variant: "normal", entry: "block", path: ["block", "peer-block", "block"], outcome: "artifact", terminal: "success" }],
    transfers: [], packets: [],
  };
  const obligation: FrameObligation = { id: "obligation", level: 2, kind: "connection-end", upper: { node: "block", port: "out" },
    artifact: "artifact", zone: "horizon", connector: "connector", role: "producer", flow: hashJson("flow") };
  return { graph, obligation, fills: [{ obligation: obligation.id, node: "operation", port: "out", source: "accepted",
    basis: { id: "graph:product", revision: 1, hash: hashJson(graph) } }] };
}
const extract = (input: ReturnType<typeof source>) => extractResultSlice(input.graph, input.obligation, input.fills);
const mutable = (input: ReturnType<typeof source>): ResultDependencySlice => clone(delivered(extract(input))) as ResultDependencySlice;

function workSource(): ReturnType<typeof source> {
  const input = source(), operation = input.graph.nodes.find(node => node.id === "operation")!, peer = input.graph.nodes.find(node => node.id === "peer")!;
  const work: Node = { ...clone(operation), id: "work", kind: "work", parent: operation.id,
    code: [{ path: "src/work.ts", symbol: "produce", access: "write", status: "planned" },
      { path: "src/work.ts", symbol: "produceAgain", access: "write", status: "planned" }], tests: [] };
  const consumer: Node = { ...clone(peer), id: "consumer-work", kind: "work", parent: peer.id,
    code: [{ path: "src/consumer.ts", symbol: "consume", access: "read", status: "existing" }], tests: [] };
  input.graph.nodes.push(work, consumer);
  input.graph.connectors[0]!.bindings.push({ level: 3,
    producer: { node: work.id, port: "out", codeRef: clone(work.code[0]!) },
    consumers: [{ node: consumer.id, port: "in", codeRef: clone(consumer.code[0]!) }], anchor: null });
  input.obligation = { ...input.obligation, level: 3, upper: { node: operation.id, port: "out" } };
  input.fills = [{ ...input.fills[0]!, node: work.id, codeRef: clone(work.code[0]!),
    basis: { id: "graph:product", revision: 1, hash: hashJson(input.graph) } }];
  return input;
}

test("N=3 result material retains full work code addresses and distinguishes their selected endpoint without changing N=2 form", () => {
  const input = workSource(), before = canonical(input), slice = delivered(extract(input));
  assert.equal(slice.level, 3); assert.deepEqual(slice.obligation, input.obligation); assert.deepEqual(slice.fills, input.fills);
  const content = delivered(normalizeResultContent(input.graph, input.obligation, input.fills));
  assert.deepEqual(content.fills, [{ node: "work", port: "out", codeRef: input.fills[0]!.codeRef }]);
  assert.ok(content.graph.nodes.some(node => node.kind === "work" && node.id === "work"));
  const alternate = clone(input);
  alternate.fills[0]!.codeRef = clone(input.graph.nodes.find(node => node.id === "work")!.code[1]!);
  assert.notDeepEqual(delivered(normalizeResultContent(alternate.graph, alternate.obligation, alternate.fills)), content,
    "The selected code endpoint is retained even when both CodeRefs already occur in the same work definition");
  const legacy = source(), legacyContent = delivered(normalizeResultContent(legacy.graph, legacy.obligation, legacy.fills));
  assert.deepEqual(legacyContent.fills, [{ node: "operation", port: "out" }]);
  assert.ok(!Object.hasOwn(legacyContent.fills[0]!, "codeRef"));
  assert.equal(canonical(input), before);
});

test("N=3 operation outcomes use real work fills without inventing a connection endpoint", () => {
  const input = workSource();
  input.obligation = { id: "work-outcome", level: 3, kind: "operation-outcome", upper: { node: "operation" },
    artifact: "artifact", zone: "horizon" };
  input.fills = [{ obligation: input.obligation.id, node: "work", source: "accepted", basis: input.fills[0]!.basis }];
  assert.deepEqual(delivered(normalizeResultContent(input.graph, input.obligation, input.fills)).fills, [{ node: "work" }]);
  input.fills[0]!.codeRef = clone(input.graph.nodes.find(node => node.id === "work")!.code[0]!);
  refusedAs(extract(input), "result_slice_invalid");
});

test("N=3 material refuses missing, incomplete, foreign and service code fields or operation masquerading as work", () => {
  const corruptions: ((input: ReturnType<typeof workSource>) => void)[] = [
    input => { delete input.fills[0]!.codeRef; },
    input => { delete (input.fills[0]!.codeRef as Partial<Node["code"][number]>).path; },
    input => { input.fills[0]!.codeRef!.path = "src/foreign.ts"; },
    input => { (input.fills[0]!.codeRef as unknown as Record<string, unknown>)["accepted"] = true; },
    input => { input.fills[0]!.node = "operation"; input.fills[0]!.codeRef = clone(input.graph.nodes.find(node => node.id === "operation")!.code[0]!); },
    input => { input.obligation.kind = "block-outcome"; },
  ];
  for (const corrupt of corruptions) { const input = workSource(); corrupt(input); refusedAs(extract(input), "result_slice_invalid"); }
  const legacy = source(); legacy.fills[0]!.codeRef = clone(legacy.graph.nodes.find(node => node.id === "operation")!.code[0]!);
  refusedAs(extract(legacy), "result_slice_invalid");
});

test("N=2 dependencies retain complete definitions and typed identities without unrelated graph bulk", () => {
  const input = source(), before = canonical(input), result = delivered(extract(input));
  assert.deepEqual(result.obligation, input.obligation); assert.deepEqual(result.fills, input.fills);
  assert.deepEqual(result.graph.nodes.find(node => node.id === "operation"), input.graph.nodes.find(node => node.id === "operation"));
  for (const part of ["artifacts", "tests", "anchors", "joins", "journeys", "requirements", "edges"] as const)
    for (const definition of result.graph[part] ?? []) assert.deepEqual(definition, input.graph[part]?.find(row => row.id === definition.id));
  const connector = result.graph.connectors[0]!, original = input.graph.connectors[0]!;
  assert.deepEqual({ ...connector, bindings: [] }, { ...original, bindings: [] });
  for (const binding of connector.bindings) assert.deepEqual(binding, original.bindings.find(row => row.level === binding.level));
  assert.ok(result.graph.nodes.some(node => node.id === "product"));
  assert.ok(!result.graph.nodes.some(node => node.id === "unrelated"));
  assert.ok(!result.graph.artifacts.some(artifact => artifact.id === "unrelated-artifact"));
  assert.ok(!result.graph.contracts.some(contract => contract.id === "unrelated-contract"));
  assert.equal(canonical(input), before);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.graph.tests[0]!.contract!.counterfactuals));
  const serialized = canonical(result);
  input.graph.nodes.find(node => node.id === "operation")!.title = "caller mutation";
  assert.equal(canonical(result), serialized);
});

test("unordered source order is irrelevant, including fills, while multiplicity reaches the slice", () => {
  const input = source();
  input.graph.nodes.find(node => node.id === "operation")!.code.push(clone(input.graph.nodes.find(node => node.id === "operation")!.code[0]!));
  input.graph.connectors[0]!.bindings[1]!.consumers.push(clone(input.graph.connectors[0]!.bindings[1]!.consumers[0]!));
  input.fills.push(clone(input.fills[0]!));
  const expected = mutable(input), permuted = clone(input);
  for (const part of ["nodes", "contracts", "artifacts", "connectors", "anchors", "joins", "tests", "actors", "requirements", "edges", "journeys"] as const)
    permuted.graph[part]!.reverse();
  permuted.graph.connectors[0]!.bindings.reverse();
  permuted.graph.tests[0]!.obligations!.reverse(); permuted.graph.actors![0]!.channels.reverse(); permuted.fills.reverse();
  assert.deepEqual(delivered(extract(permuted)), expected);
  assert.equal(expected.fills.length, 2);
  assert.equal(expected.graph.nodes.find(node => node.id === "operation")!.code.length, 2);
  assert.equal(expected.graph.connectors[0]!.bindings.find(binding => binding.level === 2)!.consumers.length, 2);
});

test("edits to an unrelated sibling and global graph metadata do not change this dependency slice", () => {
  const input = source(), before = mutable(input);
  input.graph.title = "global editorial change"; input.graph.horizon = ["unrelated"];
  input.graph.nodes.find(node => node.id === "unrelated")!.title = "another sibling title";
  input.graph.artifacts.find(artifact => artifact.id === "unrelated-artifact")!.purpose = "another sibling purpose";
  input.graph.contracts.find(contract => contract.id === "unrelated-contract")!.schema = { type: "boolean" };
  assert.deepEqual(delivered(extract(input)), before);
});

test("command args, counterfactual args, scenario paths and schema arrays preserve order", () => {
  const initial = source(), before = mutable(initial);
  const changes: ((input: ReturnType<typeof source>) => void)[] = [
    input => input.graph.tests[0]!.command.args.reverse(),
    input => input.graph.tests[0]!.contract!.counterfactuals[0]!.command.args.reverse(),
    input => { input.graph.journeys![0]!.path = ["peer-block", "block", "block"]; },
    input => { input.graph.contracts[0]!.schema = { type: "array", examples: [["second", "first"]] }; },
    input => input.graph.tests[0]!.contract!.then.reverse(),
  ];
  for (const change of changes) { const input = clone(initial); change(input); assert.notDeepEqual(delivered(extract(input)), before); }
  initial.graph.packets = [{ id: "packet", unit: "operation", purpose: "write files", writePaths: ["first.ts", "second.ts"] }];
  const paths = delivered(normalizeResultContent(initial.graph, initial.obligation, initial.fills));
  initial.graph.packets[0]!.writePaths.reverse();
  assert.notDeepEqual(delivered(normalizeResultContent(initial.graph, initial.obligation, initial.fills)), paths);
});

test("optional field absence remains distinct and equally shaped artifacts keep distinct identities", () => {
  const input = source(); delete input.graph.tests[0]!.obligations;
  const absent = mutable(input); input.graph.tests[0]!.obligations = [];
  assert.notDeepEqual(delivered(extract(input)), absent);
  const old = mutable(input), duplicate = { ...clone(input.graph.artifacts[0]!), id: "second-artifact" };
  input.graph.artifacts.push(duplicate); input.graph.nodes.find(node => node.id === "operation")!.outcome = duplicate.id;
  const changed = mutable(input);
  assert.notDeepEqual(changed, old);
  assert.ok(changed.graph.artifacts.some(artifact => artifact.id === "artifact"));
  assert.ok(changed.graph.artifacts.some(artifact => artifact.id === "second-artifact"));
});

test("block outcome extraction accepts the no-port shape without inventing connection fields", () => {
  const input = source();
  input.obligation = { id: "outcome-obligation", level: 2, kind: "block-outcome", upper: { node: "block" }, artifact: "artifact", zone: "horizon" };
  input.fills = [{ obligation: input.obligation.id, node: "operation", source: "accepted", basis: input.fills[0]!.basis }];
  const result = mutable(input);
  assert.deepEqual(result.obligation, input.obligation);
  assert.ok(!Object.hasOwn(result.fills[0]!, "port"));
  input.fills[0]!.port = "out"; refusedAs(extract(input), "result_slice_invalid");
});

test("no descriptive or behavioral field is silently excluded from dependency material", () => {
  const initial = source(), before = mutable(initial);
  const changes: ((graph: Graph) => void)[] = [
    graph => { graph.nodes[2]!.title = "new title"; }, graph => { graph.nodes[2]!.purpose = "new purpose"; },
    graph => { graph.nodes[2]!.benefit = "new benefit"; }, graph => { graph.nodes[2]!.code[0]!.access = "read"; },
    graph => { graph.nodes[2]!.code[0]!.status = "existing"; }, graph => { graph.nodes[2]!.parent = "peer-block"; },
    graph => { graph.artifacts[0]!.external = true; }, graph => { graph.artifacts[0]!.terminal = true; },
    graph => { graph.artifacts[0]!.kind = "new-kind"; }, graph => { graph.artifacts[0]!.purpose = "new purpose"; },
    graph => { graph.artifacts[0]!.durability = "recoverable"; }, graph => { graph.artifacts[0]!.sensitivity = "restricted"; },
    graph => { graph.connectors[0]!.returnsTo = "peer-block"; }, graph => { graph.connectors[0]!.wakeTest = null; },
    graph => { graph.joins[0]!.condition = "some required"; }, graph => { graph.joins[0]!.failures!.missing = "new_failure"; },
    graph => { graph.tests[0]!.contract!.when = "new trigger"; }, graph => { graph.tests[0]!.contract!.resourceClass = "pure"; },
  ];
  for (const change of changes) { const input = clone(initial); change(input.graph); assert.notDeepEqual(delivered(extract(input)), before); }
});

test("selected connector fields and transitive definitions survive existing L3 content", () => {
  const input = source(), operation = input.graph.nodes.find(node => node.id === "operation")!;
  input.graph.nodes.push({ ...clone(operation), id: "work", kind: "work", parent: operation.id, tests: [] });
  input.graph.connectors[0]!.bindings.push({ level: 3, producer: { node: "work", port: "out" }, consumers: [{ node: "work", port: "out" }], anchor: "anchor" });
  const result = mutable(input);
  assert.equal(result.graph.connectors[0]!.wakeTest, "test");
  assert.ok(result.graph.connectors[0]!.bindings.some(binding => binding.level === 3));
  assert.ok(result.graph.nodes.some(node => node.id === "work"));
});

test("missing inputs, unknown fields and non-JSON values produce addressed typed refusals", () => {
  const input = source(), invoke = extractResultSlice as (...args: unknown[]) => OmResult<unknown>;
  for (const args of [[], [input.graph], [input.graph, input.obligation], [null, input.obligation, input.fills],
    [input.graph, {}, input.fills], [input.graph, input.obligation, [null]], [input.graph, input.obligation, new Array(1)]])
    refusedAs(invoke(...args), "result_slice_invalid");
  const malformed: ((input: ReturnType<typeof source>) => void)[] = [
    value => { delete (value.graph.nodes[2] as Partial<Node>).code; },
    value => { delete (value.graph.tests[0]!.contract as Partial<NonNullable<Graph["tests"][number]["contract"]>>).given; },
    value => { (value.obligation as unknown as Record<string, unknown>)["accepted"] = true; },
    value => { value.fills[0]!.basis.hash = "forged"; },
    value => { (value.graph as unknown as Record<string, unknown>)["self"] = value.graph; },
  ];
  for (const corrupt of malformed) { const value = clone(input); corrupt(value); refusedAs(extract(value), "result_slice_invalid"); }
});

test("unsupported levels and absent or identity fills cannot masquerade as accepted result material", () => {
  const input = source(); input.obligation.level = 3; refusedAs(extract(input), "result_slice_invalid");
  (input.obligation as unknown as { level: number }).level = 4; refusedAs(extract(input), "result_slice_level_unsupported");
  input.obligation.level = 2; input.fills = []; refusedAs(extract(input), "result_slice_unfilled");
  input.fills = source().fills; input.fills[0]!.source = "identity"; refusedAs(extract(input), "result_slice_unfilled");
  input.fills[0]!.source = "accepted"; input.fills[0]!.obligation = "foreign"; refusedAs(extract(input), "result_slice_unfilled");
});

test("missing typed dependencies fail at their actual address, including qualified port identities", () => {
  const changes: ((input: ReturnType<typeof source>) => void)[] = [
    input => { input.graph.nodes[2]!.parent = "missing"; },
    input => { input.graph.nodes[2]!.outcome = "missing"; },
    input => { input.graph.nodes[2]!.ports[0]!.contract = "missing"; },
    input => { input.graph.nodes[2]!.tests = ["missing"]; },
    input => { input.graph.nodes[2]!.implements = ["missing"]; },
    input => { input.graph.connectors[0]!.wakeTest = "missing"; },
    input => { input.graph.connectors[0]!.bindings[1]!.anchor = "missing"; },
    input => { input.graph.connectors[0]!.bindings[1]!.consumers[0]!.port = "out"; },
    input => { input.graph.joins[0]!.required = ["missing"]; },
    input => { input.fills[0]!.port = "missing"; },
  ];
  for (const change of changes) { const input = source(); change(input); refusedAs(extract(input), "result_dependency_missing"); }
});

test("ambiguous definitions and same-node port collisions are rejected instead of selecting the first", () => {
  const input = source(); input.graph.artifacts.push(clone(input.graph.artifacts[0]!));
  refusedAs(extract(input), "result_dependency_ambiguous");
  const port = source(); port.graph.nodes[2]!.ports.push(clone(port.graph.nodes[2]!.ports[0]!));
  refusedAs(extract(port), "result_dependency_ambiguous");
  assert.deepEqual([...RESULT_SLICE_REFUSAL_CODES], ["result_slice_invalid", "result_slice_level_unsupported", "result_slice_unfilled",
    "result_dependency_missing", "result_dependency_ambiguous"]);
});

test("#371 excludes only node descriptions, without retaining the actor of an excluded beneficiary", () => {
  const input = source(), before = delivered(normalizeResultContent(input.graph, input.obligation, input.fills));
  input.graph.nodes[2]!.title = "editorial title"; input.graph.nodes[2]!.purpose = "editorial purpose";
  input.graph.nodes[2]!.benefit = "editorial benefit"; input.graph.nodes[2]!.beneficiary = "descriptive-actor";
  input.graph.actors!.push({ id: "descriptive-actor", role: "unrelated description", channels: ["chat"] });
  const after = delivered(normalizeResultContent(input.graph, input.obligation, input.fills));
  assert.deepEqual(after, before);
  assert.ok(!after.graph.actors!.some(actor => actor.id === "descriptive-actor"));
  input.graph.requirements![0]!.beneficiary = "descriptive-actor";
  assert.notDeepEqual(delivered(normalizeResultContent(input.graph, input.obligation, input.fills)), before);
  const artifact = source(); artifact.graph.artifacts[0]!.purpose = "different artifact purpose";
  assert.notDeepEqual(delivered(normalizeResultContent(artifact.graph, artifact.obligation, artifact.fills)), before);
  const absent = source(); delete absent.graph.nodes[2]!.code[0]!.symbol;
  const noSymbol = delivered(normalizeResultContent(absent.graph, absent.obligation, absent.fills));
  assert.notDeepEqual(noSymbol, before);
});

test("#371 structural ports, contracts, artifacts, tests, code and implements change normalized result material", () => {
  const input = source();
  const fingerprint = (value: ReturnType<typeof source>) => hashJson({ project: "garden",
    ...delivered(normalizeResultContent(value.graph, value.obligation, value.fills)) });
  const before = fingerprint(input);
  const changes: [string, (graph: Graph) => void][] = [
    ["port direction", graph => { graph.nodes[2]!.ports[0]!.direction = "in"; }],
    ["port contract identity", graph => { graph.contracts.push({ ...clone(graph.contracts[0]!), id: "other-contract" }); graph.nodes[2]!.ports[0]!.contract = "other-contract"; }],
    ["contract schema", graph => { graph.contracts[0]!.schema = { type: "array", examples: [["different"]] }; }],
    ["artifact fields", graph => { graph.artifacts[0]!.sensitivity = "restricted"; }],
    ["artifact identity with same schema", graph => { graph.artifacts.push({ ...clone(graph.artifacts[0]!), id: "other-artifact" }); graph.nodes[2]!.outcome = "other-artifact"; }],
    ["test contract", graph => { graph.tests[0]!.contract!.forbiddenEffects.push("additional forbidden effect"); }],
    ["test obligations", graph => { graph.tests[0]!.obligations = ["outcome"]; }],
    ["code access", graph => { graph.nodes[2]!.code[0]!.access = "read"; }],
    ["code status", graph => { graph.nodes[2]!.code[0]!.status = "existing"; }],
    ["implements", graph => { graph.nodes[2]!.implements = []; }],
    ["parent relation", graph => { graph.nodes[2]!.parent = "peer-block"; }],
  ];
  for (const [name, change] of changes) { const value = clone(input); change(value.graph); assert.notEqual(fingerprint(value), before, name); }
});

function identityFixture(t: TestContext, research = false, options: { thirdPort?: boolean; splitInitial?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omg-result-identity-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph("cross");
  if (options.thirdPort) for (const [kind, level] of [["block", 1], ["operation", 2], ["work", 3]] as const) {
    const producer = graph.nodes.find(node => node.id === `garden-produce-${kind}`)!;
    producer.ports.push({ ...producer.ports.find(port => port.id === "out")!, id: "out-third" });
    graph.connectors.find(connector => connector.id === "garden-flow")!.bindings.push({ level,
      producer: { node: producer.id, port: "out-third" }, consumers: [{ node: `garden-consume-${kind}`, port: "in" }], anchor: null });
  }
  const { level: _level, ...upper } = projectGraph(graph, 1);
  const engine = new ProductEngine(store);
  preparedFeatures(engine, "garden", research ? graph : upper as Graph);
  if (research) {
    const workspace = join(root, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "Identity research fixture\n");
    git(workspace, ["init", "-b", "main"]); git(workspace, ["add", "README.md"]);
    git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture baseline"]);
    const command = { executable: process.execPath, args: ["--version"] };
    engine.environments.configure("garden", { workspace, implementer: { actor: "worker", model: "fixture", effort: "high", command },
      reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 1000 }, 0);
    refinedLayers(engine, "garden");
  }
  const input = reference(delivered(writeOmInput(store, { project: "garden", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> })));
  const horizon = delivered(writeHorizon(store, { project: "garden", input, graph: reference(store.get("graph:garden")!),
    refinement: research ? reference(store.get("phase:garden:L2")!) : null,
    choice: { choiceVersion: "identity-initial", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
  let frame: FrameRequest = { project: "garden", level: 2, graph: reference(store.get("graph:garden")!), horizon: reference(horizon.gate),
    layer: research ? reference(store.get("graph-layer:garden:2")!) : null, frame: null, upper: null };
  const researchLayer = frame.layer;
  let ordinal = 0;
  const empty = (): LayerProposal => ({ base: { graph: frame.graph, frame: frame.frame }, level: 2, source: "decision", status: "proposed",
    nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], joins: [], anchors: [], tests: [], edges: [], journeys: [],
    packets: [], transfers: [], removes: [], replaces: [], redefines: [] });
  const accept = (proposal: LayerProposal): AcceptedFrameRequest => {
    ordinal++;
    const offered = reference(store.write({ id: `om-proposal:garden:identity-${ordinal}`, kind: "layer-proposal", expected: 0, value: proposal }));
    const candidate = delivered(writeCandidate(store, { frame, proposals: [offered] }));
    assert.equal(candidate.state, "candidate"); if (candidate.state !== "candidate") throw new Error("Expected candidate");
    const candidateRef = reference(candidate.record);
    const accepted = delivered(settleCandidate(store, { project: "garden", level: 2, candidate: candidateRef,
      outcome: { gate: "G3", candidate: candidateRef, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
    const request: AcceptedFrameRequest = { project: "garden", level: 2, graph: reference(accepted.graph!), layer: reference(accepted.layer!), frame: reference(accepted.frame!) };
    const next = delivered(writeHorizon(store, { project: "garden", input, graph: request.graph, refinement: request.layer,
      choice: { choiceVersion: `identity-${ordinal}`, features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
    frame = { ...request, horizon: reference(next.gate), upper: null };
    return request;
  };
  const initial = delivered(prepareFrame(store, frame)), projected = projectGraph(graph, 2);
  const mapped = delivered(fillObligations(initial.upper as Graph, initial.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, initial.upperRef, 2));
  const first = empty();
  if (!research) {
    first.nodes = projected.nodes.filter(node => node.kind === "operation");
    first.fills = mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) }));
    first.localConnectors = projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length);
    for (const part of ["artifacts", "contracts", "joins", "anchors", "tests", "edges", "journeys", "packets", "transfers"] as const)
      Object.assign(first, { [part]: projected[part] ?? [] });
  }
  if (options.splitInitial) {
    const old = first.nodes.find(node => node.id === "garden-produce-operation")!;
    first.nodes = first.nodes.filter(node => node.id !== old.id);
    first.nodes.push({ ...clone(old), id: "split-outcome", ports: [] }, { ...clone(old), id: "split-ports" });
    for (const fill of first.fills) if (fill.node === old.id) fill.node = fill.port === undefined ? "split-outcome" : "split-ports";
    for (const connector of first.localConnectors) {
      for (const binding of connector.bindings) for (const endpoint of [binding.producer, ...binding.consumers])
        if (endpoint.node === old.id) endpoint.node = "split-ports";
      if (connector.returnsTo === old.id) connector.returnsTo = "split-ports";
    }
  }
  const acceptance = accept(first);
  const obligation = mapped.obligations.find(value => value.kind === "block-outcome" && value.upper.node === "garden-produce-block")!.id;
  const replaceMany = (changes: readonly { id: string; mutate: (node: Node) => void }[]): AcceptedFrameRequest => {
    const current = delivered(prepareFrame(store, frame)), graph = clone(current.accepted!.graph) as Graph;
    const replacements = new Map(changes.map(({ id, mutate }) => {
      const before = graph.nodes.find(node => node.id === id)!; assert.ok(before, `Missing replacement source ${id}`);
      const after = clone(before); mutate(after); return [id, { before, after }] as const;
    }));
    const renamedNode = (id: string) => replacements.get(id)?.after.id ?? id;
    const portName = (id: string, port: string) => {
      const change = replacements.get(id);
      return change ? change.after.ports[change.before.ports.findIndex(value => value.id === port)]!.id : port;
    };
    const proposal = empty(); proposal.nodes = [...replacements.values()].map(({ after }) => after); proposal.removes = [...replacements.keys()];
    for (const fill of current.result.fills.filter(value => replacements.has(value.node))) {
      const after = replacements.get(fill.node)!.after, port = fill.port === undefined ? undefined : portName(fill.node, fill.port);
      proposal.fills.push({ obligation: fill.obligation, node: after.id, ...(port === undefined ? {} : { port }) });
      proposal.replaces.push({ obligation: fill.obligation, base: { node: fill.node, graph: frame.graph },
        with: { node: after.id, port: port ?? null }, basis: "Arbitrary text is never rename evidence" });
    }
    for (const connector of graph.connectors) {
      const endpoint = (value: { node: string; port: string }) => ({ ...value, node: renamedNode(value.node), port: portName(value.node, value.port) });
      const next = { ...connector, returnsTo: renamedNode(connector.returnsTo), bindings: connector.bindings.map(binding => ({ ...binding,
        producer: endpoint(binding.producer), consumers: binding.consumers.map(endpoint) })) };
      if (canonical(next) !== canonical(connector)) { proposal.localConnectors.push(next); proposal.redefines.push(connector.id); }
    }
    for (const edge of graph.edges ?? []) {
      const next = { ...edge, source: renamedNode(edge.source), target: renamedNode(edge.target) };
      if (canonical(next) !== canonical(edge)) { proposal.edges.push(next); proposal.redefines.push(edge.id); }
    }
    for (const journey of graph.journeys ?? []) {
      const next = { ...journey, entry: renamedNode(journey.entry), path: journey.path.map(renamedNode) };
      if (canonical(next) !== canonical(journey)) { proposal.journeys.push(next); proposal.redefines.push(journey.id); }
    }
    for (const test of graph.tests) if (test.node !== renamedNode(test.node)) { proposal.tests.push({ ...test, node: renamedNode(test.node) }); proposal.redefines.push(test.id); }
    for (const anchor of graph.anchors) if (anchor.owner !== renamedNode(anchor.owner)) { proposal.anchors.push({ ...anchor, owner: renamedNode(anchor.owner) }); proposal.redefines.push(anchor.id); }
    for (const join of graph.joins) {
      const next = { ...join, consumer: renamedNode(join.consumer),
        ...(join.failures === undefined ? {} : { failures: { ...join.failures, returnsTo: renamedNode(join.failures.returnsTo) } }) };
      if (canonical(next) !== canonical(join)) { proposal.joins.push(next); proposal.redefines.push(join.id); }
    }
    return accept(proposal);
  };
  const replace = (id: string, mutate: (node: Node) => void) => replaceMany([{ id, mutate }]);
  const permuteNodes = (ids: readonly string[]) => replaceMany(ids.map((id, index) => ({ id,
    mutate(node: Node) { node.id = ids[(index + 1) % ids.length]!; } })));
  const split = (): AcceptedFrameRequest => {
    const current = delivered(prepareFrame(store, frame)), graph = current.accepted!.graph;
    const old = graph.nodes.find(node => node.id === "garden-produce-operation")!;
    const outcome = { ...clone(old), id: "split-outcome", ports: [] }, ports = { ...clone(old), id: "split-ports" };
    const proposal = empty(); proposal.nodes = [outcome, ports] as Node[]; proposal.removes = [old.id];
    for (const fill of current.result.fills.filter(value => value.node === old.id)) {
      const node = fill.port === undefined ? outcome.id : ports.id;
      proposal.fills.push({ obligation: fill.obligation, node, ...(fill.port === undefined ? {} : { port: fill.port }) });
      proposal.replaces.push({ obligation: fill.obligation, base: { node: old.id, graph: frame.graph },
        with: { node, port: fill.port ?? null }, basis: "Split outcome responsibility from its ports" });
    }
    for (const connector of graph.connectors) {
      const next = clone(connector) as Graph["connectors"][number];
      for (const binding of next.bindings) for (const endpoint of [binding.producer, ...binding.consumers])
        if (endpoint.node === old.id) endpoint.node = ports.id;
      if (next.returnsTo === old.id) next.returnsTo = ports.id;
      if (canonical(next) !== canonical(connector)) { proposal.localConnectors.push(next); proposal.redefines.push(connector.id); }
    }
    return accept(proposal);
  };
  const merge = (): AcceptedFrameRequest => {
    const current = delivered(prepareFrame(store, frame)), graph = current.accepted!.graph;
    const combined = { ...clone(graph.nodes.find(node => node.id === "split-ports")!), id: "garden-produce-operation" };
    const proposal = empty(); proposal.nodes = [combined] as Node[]; proposal.removes = ["split-outcome", "split-ports"];
    for (const fill of current.result.fills.filter(value => proposal.removes.includes(value.node))) {
      proposal.fills.push({ obligation: fill.obligation, node: combined.id, ...(fill.port === undefined ? {} : { port: fill.port }) });
      proposal.replaces.push({ obligation: fill.obligation, base: { node: fill.node, graph: frame.graph },
        with: { node: combined.id, port: fill.port ?? null }, basis: "Merge two accepted responsibilities into one node" });
    }
    for (const connector of graph.connectors) {
      const next = clone(connector) as Graph["connectors"][number];
      for (const binding of next.bindings) for (const endpoint of [binding.producer, ...binding.consumers])
        if (proposal.removes.includes(endpoint.node)) endpoint.node = combined.id;
      if (proposal.removes.includes(next.returnsTo)) next.returnsTo = combined.id;
      if (canonical(next) !== canonical(connector)) { proposal.localConnectors.push(next); proposal.redefines.push(connector.id); }
    }
    return accept(proposal);
  };
  return { get store() { return store; }, acceptance, obligation, researchLayer, replace, permuteNodes, split, merge, technical: () => accept(empty()),
    reopen() { store.close(); store = new Store(database); } };
}

const identityCostName = "different result obligations share one exact C5 history per operation and read it again after the operation";
// Count completed-history bodies inside an isolated module graph, independently of physical Store reads.
const identityCostLoader = String.raw`
import ts from TYPESCRIPT;
let root;
export function initialize(data) { root = data.root; }
const bodies = {
  'src/om/layer-basis.js': { verifyHistoricalBasis: ['C5.layerBasis', 'request'] },
  'src/om/result-identity.js': { deriveIdentityHistory: ['D2.resultIdentityHistory', 'initial'] },
};
export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (!url.startsWith(root) || loaded.format !== 'module') return loaded;
  const file = decodeURIComponent(url.slice(root.length));
  if (!bodies[file] && file !== 'src/om/input.js') return loaded;
  let source = String(loaded.source);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [], found = new Set();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const name = node.name.getText(tree), entry = bodies[file]?.[name];
      if (entry) {
        const [family, key] = entry; found.add(name);
        edits.push({ pos: node.body.getStart(tree) + 1,
          text: '\nglobalThis.__identityCost?.hit(' + JSON.stringify(family) + ', store, ' + key + ');\n' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const name of Object.keys(bodies[file] ?? {})) if (!found.has(name)) throw new Error('Missing actual proof body: ' + name);
  for (const edit of edits.sort((a, b) => b.pos - a.pos)) source = source.slice(0, edit.pos) + edit.text + source.slice(edit.pos);
  if (file === 'src/om/input.js') source += '\nglobalThis.__identityCostInternals = { sourceView, footprint: () => checkingFootprint > 0 };\n';
  return { ...loaded, source };
}
`;

test(identityCostName, t => {
  const runtime = globalThis as unknown as {
    __identityCostInternals?: { sourceView(store: Store): Store; footprint(): boolean };
    __identityCost?: { hit(family: string, store: Store, key: unknown): void };
  };
  const internals = runtime.__identityCostInternals;
  if (!internals) {
    const directory = mkdtempSync(join(tmpdir(), "omg-identity-cost-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const loader = join(directory, "loader.mjs");
    const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
    writeFileSync(loader, identityCostLoader.replace("TYPESCRIPT", JSON.stringify(typescript)));
    const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, { data: { root: ${JSON.stringify(new URL('../', import.meta.url).href)} } });`;
    const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`,
      "--test", `--test-name-pattern=${identityCostName}`, fileURLToPath(import.meta.url)],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 4_000_000, env: environment });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /identity-cost-measured/, "The isolated child must execute the instrumented proof assertions");
    return;
  }
  const fixture = identityFixture(t), acceptance = fixture.acceptance;
  const fills = fixture.store.get<{ fills: FrameFill[] }>(acceptance.frame.id, acceptance.frame.revision)!.value.fills;
  const other = fills.find(fill => fill.source === "accepted" && fill.obligation !== fixture.obligation)?.obligation;
  assert.ok(other, "The real accepted frame supplies a second complete obligation");
  type Cost = { bodies: Map<string, number>; bodyReads: number; footprintReads: number };
  const fresh = (): Cost => ({ bodies: new Map(), bodyReads: 0, footprintReads: 0 });
  let sample = fresh(), nextView = 0;
  const views = new WeakMap<Store, number>();
  runtime.__identityCost = { hit(family, store, key) {
    const view = internals.sourceView(store);
    if (!views.has(view)) views.set(view, ++nextView);
    const identity = canonical([family, views.get(view), key]);
    sample.bodies.set(identity, (sample.bodies.get(identity) ?? 0) + 1);
  } };
  const base = fixture.store, get = base.get.bind(base);
  base.get = <T>(id: string, revision?: number): Revision<T> | null => {
    if (internals.footprint()) sample.footprintReads++;
    else sample.bodyReads++;
    return get<T>(id, revision);
  };
  t.after(() => { base.get = get; delete runtime.__identityCost; });
  const store = historicalTrace(base);
  const cost = () => ({ bodies: [...sample.bodies].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    bodyReads: sample.bodyReads, footprintReads: sample.footprintReads,
    physicalReads: sample.bodyReads + sample.footprintReads });
  const read = (obligation: string) => delivered(readResultIdentity(store, { acceptance, obligation }));
  const results = withHistoricalReads(() => {
    const first = read(fixture.obligation), afterFirst = cost();
    assert.ok(afterFirst.physicalReads > 0);
    assert.ok(afterFirst.bodies.some(([key]) => JSON.parse(key)[0] === "C5.layerBasis"));
    assert.ok(afterFirst.bodies.some(([key]) => JSON.parse(key)[0] === "D2.resultIdentityHistory"));
    for (const [key, count] of afterFirst.bodies) assert.equal(count, 1, `${key} must execute once per unchanged view`);
    const second = read(other);
    assert.deepEqual(cost(), afterFirst, "A different obligation must reuse the exact acceptance history without more proof bodies, physical gets or footprint reads");
    assert.deepEqual(read(fixture.obligation), first);
    assert.deepEqual(cost(), afterFirst);
    assert.notEqual(second.key, first.key, "Only shared sources are cached; each obligation still gets its own content identity");
    return { first, second };
  });
  sample = fresh();
  assert.deepEqual(read(other), results.second);
  assert.ok(cost().physicalReads > 0, "A completed external operation must read its sources again");
  assert.ok(cost().bodies.some(([key]) => JSON.parse(key)[0] === "C5.layerBasis"), "A completed external operation must not retain its proof cache");
  for (const [key, count] of cost().bodies) assert.equal(count, 1, `${key} must execute once in the new operation`);
  base.get = get; delete runtime.__identityCost;
  fixture.reopen();
  assert.deepEqual(delivered(readResultIdentity(fixture.store, { acceptance, obligation: fixture.obligation })), results.first);
  assert.deepEqual(delivered(readResultIdentity(fixture.store, { acceptance, obligation: other })), results.second);
  t.diagnostic("identity-cost-measured");
});

test("shared C5/C2 identity survives technical acceptance, editorial changes, typed rename chains and A→B→A after restart", t => {
  const fixture = identityFixture(t), read = (acceptance: AcceptedFrameRequest) => delivered(readResultIdentity(fixture.store, { acceptance, obligation: fixture.obligation }));
  const original = read(fixture.acceptance);
  assert.equal(read(fixture.acceptance).key, original.key);
  const technical = fixture.technical(); assert.equal(read(technical).key, original.key);
  const text = fixture.replace("garden-produce-operation", node => { node.title = "Edited title"; node.purpose = "Edited purpose"; node.benefit = "Edited benefit"; });
  assert.equal(read(text).key, original.key);
  const renamed = fixture.replace("garden-produce-operation", node => { node.id = "renamed-operation"; node.ports.find(port => port.id === "out")!.id = "renamed-out"; });
  assert.equal(read(renamed).key, original.key);
  const twice = fixture.replace("renamed-operation", node => { node.id = "twice-renamed-operation"; node.ports.find(port => port.id === "renamed-out")!.id = "twice-renamed-out"; });
  assert.equal(read(twice).key, original.key);
  const changed = fixture.replace("twice-renamed-operation", node => { node.code = [{ path: "src/other.ts", access: "read", status: "existing" }]; });
  const changedKey = read(changed).key; assert.notEqual(changedKey, original.key);
  const changedRename = fixture.replace("twice-renamed-operation", node => { node.id = "changed-renamed-operation"; });
  assert.equal(read(changedRename).key, changedKey);
  const restored = fixture.replace("changed-renamed-operation", node => { node.id = "restored-operation"; node.code = []; });
  fixture.reopen();
  assert.equal(read(restored).key, original.key);
  assert.equal(read(fixture.acceptance).key, original.key);
  assert.equal(read(changed).key, changedKey);
  assert.ok(Object.isFrozen(original) && Object.isFrozen(original.references));
  assert.ok(original.references.some(ref => ref.id.startsWith("om-proposal:garden:")));
});

for (const rename of ["node", "port", "node-and-port"] as const) {
  test(`issued A and B keys survive combined content replacement and ${rename} rename, both returns and restart`, t => {
    const fixture = identityFixture(t);
    const read = (acceptance: AcceptedFrameRequest) => delivered(readResultIdentity(fixture.store, { acceptance, obligation: fixture.obligation }));
    const a = fixture.acceptance, keyA = read(a).key;
    const name = rename === "port" ? "garden-produce-operation" : "review-new-operation";
    const code = (): Node["code"] => [{ path: "src/B.ts", access: "read", status: "existing" }];
    const b = fixture.replace("garden-produce-operation", node => {
      node.id = name;
      if (rename !== "node") node.ports.find(port => port.id === "out")!.id = "review-new-out";
      node.code = code();
    });
    const keyB = read(b).key;
    assert.notEqual(keyB, keyA);
    // A repeat may already have recorded canonical self-aliases for B before
    // returning A proves that the renamed addresses have an older spelling.
    if (rename === "node-and-port") assert.equal(read(fixture.technical()).key, keyB);
    const returnedA = fixture.replace(name, node => { node.code = []; });
    assert.equal(read(returnedA).key, keyA);
    const returnedB = fixture.replace(name, node => { node.code = code(); });
    assert.equal(read(returnedB).key, keyB);
    // Moving heads and discovering older aliases cannot change an already issued
    // key, even when its first event was read before that proof existed.
    assert.equal(read(a).key, keyA); assert.equal(read(b).key, keyB);
    fixture.reopen();
    assert.equal(read(returnedA).key, keyA); assert.equal(read(returnedB).key, keyB);
    assert.equal(read(b).key, keyB);
  });
}

for (const kind of ["node", "port"] as const) for (const size of ["mutual", "cyclic"] as const) {
  test(`accepted ${size} ${kind} permutation preserves issued keys through content changes, returns, historical reads and restart`, t => {
    const fixture = identityFixture(t, false, { thirdPort: kind === "port" && size === "cyclic" });
    const read = (acceptance: AcceptedFrameRequest) => delivered(readResultIdentity(fixture.store, { acceptance, obligation: fixture.obligation }));
    const a = fixture.acceptance, identityA = read(a), keyA = identityA.key;
    const nodeIds = ["garden-produce-operation", "garden-consume-operation", ...(size === "cyclic" ? ["garden-later-operation"] : [])];
    const portIds = ["out", "out-alt", ...(size === "cyclic" ? ["out-third"] : [])];
    const permuted = kind === "node" ? fixture.permuteNodes(nodeIds) : fixture.replace(nodeIds[0]!, node => {
      for (const port of node.ports) {
        const index = portIds.indexOf(port.id);
        if (index !== -1) port.id = portIds[(index + 1) % portIds.length]!;
      }
    });
    assert.equal(read(permuted).key, keyA);
    // Continue changing the same object after its address has become another
    // participant's former address; its old name now denotes a different object.
    const producer = nodeIds[kind === "node" ? 1 : 0]!;
    const code = (): Node["code"] => [{ path: "src/permutation-B.ts", access: "read", status: "existing" }];
    const b = fixture.replace(producer, node => { node.code = code(); }), keyB = read(b).key;
    assert.notEqual(keyB, keyA);
    const originalWithCode = clone(fixture.store.get<Graph>(a.graph.id, a.graph.revision)!.value);
    originalWithCode.nodes.find(node => node.id === "garden-produce-operation")!.code = code();
    const expectedB = `om-result:${hashJson({ project: "garden",
      ...delivered(normalizeResultContent(originalWithCode, identityA.obligation, identityA.fills)) })}`;
    assert.equal(keyB, expectedB, "New content uses the same canonical identities as the graph before permutation");
    const returnedA = fixture.replace(producer, node => { node.code = []; });
    assert.equal(read(returnedA).key, keyA);
    const returnedB = fixture.replace(producer, node => { node.code = code(); });
    assert.equal(read(returnedB).key, keyB);
    assert.equal(read(a).key, keyA); assert.equal(read(permuted).key, keyA); assert.equal(read(b).key, keyB);
    fixture.reopen();
    for (const historical of [a, permuted, returnedA]) assert.equal(read(historical).key, keyA);
    for (const historical of [b, returnedB]) assert.equal(read(historical).key, keyB);
  });
}

test("a different accepted node can reuse a vacated name without aliasing its former owner", t => {
  const fixture = identityFixture(t);
  const read = (acceptance: AcceptedFrameRequest) => delivered(readResultIdentity(fixture.store, { acceptance, obligation: fixture.obligation }));
  const a = fixture.acceptance, keyA = read(a).key, vacant = "garden-produce-operation", moved = "moved-producer";
  const renamed = fixture.replace(vacant, node => { node.id = moved; });
  assert.equal(read(renamed).key, keyA);
  // This is another accepted responsibility, connected to the producer. Its
  // reused address must not alias the producer still present under `moved`.
  const reused = fixture.replace("garden-consume-operation", node => {
    node.id = vacant; node.code = [{ path: "src/independent-consumer.ts", access: "read", status: "existing" }];
  });
  const keyReused = read(reused).key;
  assert.notEqual(keyReused, keyA);
  const graph = fixture.store.get<Graph>(reused.graph.id, reused.graph.revision)!.value;
  assert.equal(graph.nodes.find(node => node.id === moved)!.parent, "garden-produce-block");
  assert.equal(graph.nodes.find(node => node.id === vacant)!.parent, "garden-consume-block");
  const technical = fixture.technical(); assert.equal(read(technical).key, keyReused);
  const nextRename = fixture.replace(vacant, node => { node.id = "independent-consumer"; });
  assert.equal(read(nextRename).key, keyReused);
  assert.equal(read(renamed).key, keyA); assert.equal(read(reused).key, keyReused);
  fixture.reopen();
  assert.equal(read(a).key, keyA); assert.equal(read(renamed).key, keyA);
  for (const historical of [reused, technical, nextRename]) assert.equal(read(historical).key, keyReused);
});

test("identity accepts no caller content, mappings, keys, forged sources, unsupported levels or unfilled obligations", t => {
  const fixture = identityFixture(t), request: ResultIdentityRequest = { acceptance: fixture.acceptance, obligation: fixture.obligation };
  const invoke = readResultIdentity as (...args: unknown[]) => OmResult<unknown>;
  for (const args of [[], [fixture.store], [null, request], [fixture.store, null], [fixture.store, {}]])
    refusedAs(invoke(...args), "result_identity_invalid");
  for (const field of ["key", "graph", "mapping", "names"])
    refusedAs(invoke(fixture.store, { ...request, [field]: {} }), "result_identity_invalid");
  refusedAs(invoke(fixture.store, { ...request, acceptance: { ...fixture.acceptance, level: 3 } }), "result_identity_invalid");
  refusedAs(invoke(fixture.store, { ...request, acceptance: { ...fixture.acceptance, level: 4 } }), "result_identity_invalid");
  refusedAs(readResultIdentity(fixture.store, { ...request, obligation: "unknown" }), "result_identity_unfilled");
  const forged = readResultIdentity(fixture.store, { ...request, acceptance: { ...fixture.acceptance,
    graph: { ...fixture.acceptance.graph, hash: hashJson("forged") } } });
  assert.equal(forged.ok, false);
  const foreign = readResultIdentity(fixture.store, { ...request, acceptance: { ...fixture.acceptance, project: "foreign" } });
  assert.equal(foreign.ok, false);
});

test("identity follows a native research-accepted root without requiring an invented prior OM frame", t => {
  const fixture = identityFixture(t, true);
  const before = delivered(readResultIdentity(fixture.store, { acceptance: fixture.acceptance, obligation: fixture.obligation }));
  const renamed = fixture.replace("garden-produce-operation", node => { node.ports.find(port => port.id === "out")!.id = "research-renamed-out"; });
  const after = delivered(readResultIdentity(fixture.store, { acceptance: renamed, obligation: fixture.obligation }));
  assert.equal(after.key, before.key);
  assert.ok(after.references.some(ref => canonical(ref) === canonical(fixture.researchLayer)));
});

test("a legally accepted one-to-many node replacement refuses ambiguous identity without undoing acceptance", t => {
  const fixture = identityFixture(t), accepted = fixture.split();
  const before = fixture.store.list().map(reference);
  refusedAs(readResultIdentity(fixture.store, { acceptance: accepted, obligation: fixture.obligation }), "result_identity_ambiguous");
  assert.deepEqual(fixture.store.list().map(reference), before);
  assert.deepEqual(reference(fixture.store.get(accepted.frame.id)!), accepted.frame);
});

test("a legally accepted many-to-one node replacement still refuses ambiguous identity after restart", t => {
  const fixture = identityFixture(t, false, { splitInitial: true });
  const initialKey = delivered(readResultIdentity(fixture.store, { acceptance: fixture.acceptance, obligation: fixture.obligation })).key;
  const accepted = fixture.merge(), before = fixture.store.list().map(reference);
  refusedAs(readResultIdentity(fixture.store, { acceptance: accepted, obligation: fixture.obligation }), "result_identity_ambiguous");
  assert.deepEqual(fixture.store.list().map(reference), before);
  fixture.reopen();
  assert.equal(delivered(readResultIdentity(fixture.store, { acceptance: fixture.acceptance, obligation: fixture.obligation })).key, initialKey);
  refusedAs(readResultIdentity(fixture.store, { acceptance: accepted, obligation: fixture.obligation }), "result_identity_ambiguous");
  assert.deepEqual(reference(fixture.store.get(accepted.frame.id)!), accepted.frame);
});

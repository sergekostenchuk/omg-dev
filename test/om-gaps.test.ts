import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { LEVEL, type Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { KNOWLEDGE_KINDS, RESOLUTION_MOMENTS } from "../src/graph/obligation-policy.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Write } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { READINESS_CONTRACT, readinessQuestionId, withHistoricalReads, writeOmInput, type OmInput, type ReadinessCause } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { fillObligations, type FrameLevel, type FrameRead, type FrameScope } from "../src/om/frame-obligations.js";
import { applyProposals, openObligationsToGaps, prepareFrameProposals, type FrameGap, type ProposalRequest } from "../src/om/frame-proposals.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { collectGaps, gateGaps, gapId, prepareGaps, prepareCurrentGaps, writeGaps, readGaps, GAP_REFUSAL_CODES,
  type GapSources, type GapCollection, type GapRequest, type GapReadRequest, type GapRecord } from "../src/om/gaps.js";
import { gardenGraph, createOmFixture, sameButReferences, type OmFixture } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { answerLayerFixture } from "./layer-design-fixture.js";

const clone = structuredClone;
const fakeRef = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
type SourceQuestion = NonNullable<GapSources["inputResult"]["input"]>["questions"][number];
type SourceGap = GapSources["inputResult"]["gaps"][number];
function delivered<T>(value: OmResult<T>): T {
  if (!value.ok) assert.fail(`Unexpected ${value.refusal.code}: ${value.refusal.message}`);
  return value.value;
}
function addressed(refusal: Refusal): void {
  assert.ok(refusal.at.target.length > 0);
  assert.ok(refusal.at.field || refusal.at.ref);
  assert.ok(["producer", "gap", "owner", "readiness"].includes(refusal.route));
}
function refusedAs(value: OmResult<unknown>, code: string): Refusal {
  if (value.ok) assert.fail(`Expected ${code}, received success`);
  assert.equal(value.refusal.code, code); addressed(value.refusal); return value.refusal;
}
function hasCode(value: { refusals: readonly Refusal[] }, code: string): Refusal {
  const refusal = value.refusals.find(item => item.code === code);
  assert.ok(refusal, `${code} absent from ${value.refusals.map(item => item.code).join(", ")}`);
  addressed(refusal); return refusal;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError); assert.equal(error.code, "gap_request_invalid"); return true;
}
function sources(): GapSources {
  const graph = gardenGraph("cross");
  const input: OmInput = {
    sources: UPSTREAM_STAGES.map(stage => ({ ...fakeRef(`stage:garden:${stage}`), stage, contractVersion: 6 })),
    inventory: null, requirements: [{ id: "garden-R1", section: "garden-concept" }, { id: "garden-R2", section: "garden-concept" }],
    criteria: [], contracts: [], questions: [], features: [
      { index: 0, title: "Produce", outcome: "garden-data", behaviorIndexes: [0], requirementIds: ["garden-R1"], contracts: [] },
      { index: 1, title: "Consume", outcome: "garden-result", behaviorIndexes: [1], requirementIds: ["garden-R1"], contracts: [] },
      { index: 2, title: "Later", outcome: "garden-later", behaviorIndexes: [2], requirementIds: ["garden-R2"], contracts: [] },
    ], map: { nodes: graph.nodes.map(node => node.id), artifacts: graph.artifacts.map(item => item.id), connectors: graph.connectors.map(item => item.id) },
  };
  return { inputResult: { input, hash: hashJson(input), gaps: [], refusals: [] }, frameGaps: { operations: [], works: [] },
    horizon: { nodes: graph.nodes.filter(node => node.kind === "block").map(node => node.id) }, graph };
}
function stamp(source: GapSources): void { source.inputResult.hash = hashJson(source.inputResult.input); }
function question(id: string, kind: SourceQuestion["kind"] = "design-decision", consumer = "garden-consume-operation"): SourceQuestion {
  // Current upstream questions carry their deadline; D1 must not recover it from the kind.
  const moment = kind === "environment-confirmation" ? "task-start" : kind === "post-implementation-proof" ? "task-result" : "om-pass";
  return { id, question: `Resolve ${id}`, consumer, kind, blocks: false, moment, source: fakeRef("stage:garden:features") };
}
function inputGap(code: string, target: string, field: string, consumer: SourceGap["consumer"]): SourceGap {
  return { code, target, field, consumer, message: `Resolve ${target}/${field}`, source: fakeRef("stage:garden:concept") };
}
function inventoryGap(): SourceGap {
  return { code: "inventory_missing", target: "repo-inventory", field: "inventory", source: null,
    consumer: { mechanism: "M6", uses: ["code-answer", "project-question-package"] }, message: "Repository inventory is unavailable" };
}
function frameOf(graph: Graph, level: FrameLevel): FrameRead {
  const { level: _level, ...projected } = projectGraph(graph, level === 2 ? 1 : 2);
  const upper = projected as Graph;
  const nodes = upper.nodes.filter(node => LEVEL[node.kind] === level - 1).map(node => node.id);
  const scope: FrameScope = { nodes, excluded: [], hash: hashJson({ nodes: [...nodes].sort(), excluded: [] }) };
  const upperRef = fakeRef(`graph-layer:garden:${level - 1}`);
  const frame: FrameRead = { request: { project: "garden", level, graph: fakeRef("graph:garden"), horizon: fakeRef("om-horizon:garden:choice"),
    layer: null, frame: null, upper: level === 2 ? null : { horizon: fakeRef("om-horizon:garden:choice"), frame: null } },
    upper, upperRef, scope, accepted: null, references: [upperRef],
    result: clone(delivered(fillObligations(upper, scope, null, upperRef, level))) as FrameRead["result"] };
  return frame;
}
function frameGaps(graph: Graph, level: FrameLevel): FrameGap[] {
  const frame = frameOf(graph, level);
  return clone(delivered(openObligationsToGaps(frame, delivered(applyProposals(frame, [])) as Parameters<typeof openObligationsToGaps>[1]))) as FrameGap[];
}
function nativeRequest(f: OmFixture): GapRequest & { works: ProposalRequest } {
  const input = delivered(writeOmInput(f.store, { project: f.project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const horizon = delivered(writeHorizon(f.store, { project: f.project, input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(f.store.get(`phase:${f.project}:L2`)!), available: {},
    choice: { choiceVersion: "gaps-choice", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const frame = (level: FrameLevel): ProposalRequest => ({ proposals: [], frame: { project: f.project, level,
    graph: reference(f.graphRevision), horizon: reference(horizon.gate), layer: reference(f.layers[level]), frame: null,
    upper: level === 2 ? null : { horizon: reference(horizon.gate), frame: null } } });
  return { project: f.project, input: reference(input), graph: reference(f.graphRevision), horizon: reference(horizon.gate), operations: frame(2), works: frame(3) };
}

test("S1 D1 shares the full historical set only inside one operation and keeps current admission fresh", async t => {
  const f = await createOmFixture(t), saved = delivered(writeGaps(f.store, nativeRequest(f)));
  const request: GapReadRequest = { sources: clone(saved.sources) as GapRequest, records: saved.records.map(reference) };
  let gets = 0, recordsRead = 0;
  const gapRecords = new Set(request.records.map(ref => `${ref.id}@${ref.revision}`));
  const measured = f.store, get = measured.get.bind(measured);
  measured.get = ((id: string, revision?: number) => {
    gets++;
    if (gapRecords.has(`${id}@${revision}`)) recordsRead++;
    return get(id, revision);
  }) as Store["get"];
  const rival = new Store(f.database);
  t.after(() => rival.close());
  withHistoricalReads(() => {
    const first = delivered(readGaps(measured, request)), warmed = recordsRead;
    assert.equal(warmed, request.records.length, "the complete immutable gap set is read once");
    assert.deepEqual(delivered(readGaps(measured, { ...request, records: [...request.records].reverse() })), first);
    assert.equal(recordsRead, warmed, "cached complete-set validation does not reread its exact gap records");
    // NR1: a saved set is read as written; an incomplete set is refused where new work starts — its current admission.
    refusedAs(prepareCurrentGaps(measured, { ...request, records: request.records.slice(1) }), "input_stale");
    refusedAs(readGaps(measured, { ...request, records: [...request.records, request.records[0]!] }), "gap_duplicate");
    const prepared = delivered(prepareCurrentGaps(measured, request)), currentReads = gets;
    assert.deepEqual(delivered(prepareCurrentGaps(measured, request)), prepared);
    assert.ok(gets > currentReads, "historical reuse never replaces a fresh current admission");
    const input = rival.get(request.sources.input.id)!;
    rival.write({ id: input.id, kind: input.kind, expected: input.revision, value: input.value });
    assert.deepEqual(delivered(readGaps(measured, request)), first);
    refusedAs(prepareCurrentGaps(measured, request), "input_stale");
    refusedAs(writeGuarded(measured, { unit: "S1", target: "s1:d1-neighbor", guards: prepared.guards,
      writes: [{ id: "s1:d1-neighbor", kind: "s1-test", expected: 0, value: { gaps: request.records } }] }), "input_stale");
    assert.equal(rival.get("s1:d1-neighbor"), null);
  });
  const outside = recordsRead;
  assert.deepEqual(delivered(readGaps(measured, request)).records, saved.records);
  assert.ok(recordsRead > outside, "a new external operation reads exact gap history again");
});

test("S1 D1 separates semantic Store views and never caches a failed historical read", { todo: "NR1 №3591: записанное не перепроверяется при чтении — проверка была у производителя при записи" }, async t => {
  const f = await createOmFixture(t), saved = delivered(writeGaps(f.store, nativeRequest(f)));
  const request: GapReadRequest = { sources: clone(saved.sources) as GapRequest, records: saved.records.map(reference) };
  const sentinel = new Error("historical storage failure");
  let failRead = true, gets = 0;
  const alternate = new Proxy(f.store, { get(target, property) {
    if (property === "get") return (id: string, revision?: number) => {
      gets++;
      if (id === request.sources.input.id && revision === request.sources.input.revision && failRead) throw sentinel;
      return target.get(id, revision);
    };
    const member = Reflect.get(target, property, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
  withHistoricalReads(() => {
    const proved = delivered(readGaps(f.store, request));
    assert.throws(() => readGaps(alternate, request), error => error === sentinel,
      "a distinct semantic view cannot borrow the base Store's proof");
    failRead = false;
    const before = gets;
    assert.deepEqual(delivered(readGaps(alternate, request)), proved);
    assert.ok(gets > before, "a failed derivation must run again");
    assert.deepEqual(delivered(readGaps(alternate, request)), proved);
  });
  const reopened = new Store(f.database);
  try { assert.deepEqual(delivered(readGaps(reopened, request)).records, saved.records); }
  finally { reopened.close(); }
});

test("the four explicit gap sources merge accepted input and both real C3 outputs without losing flow neighbors", () => {
  const source = sources();
  source.inputResult.gaps = [inputGap("acceptance_kind_missing", "garden-R1#1", "checkKind", { requirement: "garden-R1" })];
  source.inputResult.input!.questions = [question("known-question", "repository-fact", "garden-produce-work")];
  source.frameGaps.operations = frameGaps(source.graph, 2); source.frameGaps.works = frameGaps(source.graph, 3);
  stamp(source);
  const result = collectGaps(source);
  assert.deepEqual(result.refusals, []);
  assert.equal(result.gaps.length, source.frameGaps.operations.length + source.frameGaps.works.length + 2);
  assert.equal(new Set(result.gaps.map(gap => gap.id)).size, result.gaps.length);
  const gate = gateGaps(result as GapCollection, source);
  assert.equal(gate.passed, true); assert.deepEqual(gate.codes, []);
  for (const frame of [...source.frameGaps.operations, ...source.frameGaps.works]) {
    const gap = result.gaps.find(item => item.target === frame.target && item.field === "fill")!;
    assert.equal(gap.id, gapId(frame.target, "fill"));
    assert.equal(gap.kind, "design-decision"); assert.deepEqual(gap.routes, ["design"]);
    assert.equal(gap.moment, "om-pass"); assert.equal(gap.blocking, true);
    assert.deepEqual(gap.neighbors, frame.neighbors);
    assert.ok(gap.evidence.some(item => canonical(item).includes(frame.target)));
    assert.ok(gap.consumers.every(id => source.graph.nodes.some(node => node.id === id && node.kind === "block")));
  }
  const multiplex = source.frameGaps.operations.filter(gap => gap.consumer === "garden-consume-block" && gap.question.port === "in");
  assert.equal(multiplex.length, 2);
  assert.notEqual(multiplex[0]!.target, multiplex[1]!.target);
  assert.ok(result.gaps.some(gap => (gap.neighbors?.length ?? 0) === 3));
  assert.ok(Object.isFrozen(result.gaps) && Object.isFrozen(result.gaps[0]!.routes));
  const before = canonical(result);
  source.frameGaps.operations[0]!.question.existing.push("caller-edit");
  source.inputResult.input!.questions[0]!.question = "caller-edit";
  assert.equal(canonical(result), before);
});

test("inventory stays open, nonblocking and code-only across horizons while ordinary repository questions retain research", () => {
  const source = sources(); source.inputResult.gaps = [inventoryGap()];
  source.inputResult.input!.questions = [question("repo-question", "repository-fact")];
  stamp(source);
  let previousInventory: unknown;
  for (const nodes of [source.horizon.nodes, [], ["garden-later-block"], ["garden-consume-block"]]) {
    source.horizon.nodes = nodes;
    const result = collectGaps(source); assert.deepEqual(result.refusals, []);
    const inventory = result.gaps.find(gap => gap.code === "inventory_missing")!;
    assert.equal(inventory.kind, "repository-fact"); assert.equal(inventory.moment, "om-pass");
    assert.equal(inventory.blocking, false); assert.equal(inventory.mechanism, "M6");
    assert.deepEqual(inventory.routes, ["code"]);
    assert.deepEqual(inventory.uses, ["code-answer", "project-question-package"]);
    assert.deepEqual(inventory.consumers, []); assert.equal(inventory.deferral, undefined);
    if (previousInventory) assert.deepEqual(inventory, previousInventory);
    previousInventory = inventory;
    const repository = result.gaps.find(gap => gap.target === "repo-question")!;
    assert.deepEqual(repository.routes, ["code", "research"]);
    assert.equal(repository.blocking, nodes.includes("garden-consume-block"));
    assert.equal(gateGaps(result as GapCollection, source).passed, true);
  }
});

test("inventory consumer uses are mandatory and every malformed form is an addressed D1 refusal on collection and G4", () => {
  const validSource = sources(); validSource.inputResult.gaps = [inventoryGap()];
  const valid = collectGaps(validSource); assert.deepEqual(valid.refusals, []);
  const cases = [
    { name: "absent", missing: true },
    { name: "null", value: null },
    { name: "string", value: "code-answer" },
    { name: "object", value: { "code-answer": true } },
    { name: "empty", value: [] },
    { name: "non-string", value: ["code-answer", 7] },
    { name: "missing package consumer", value: ["code-answer"] },
    { name: "wrong route-like consumer", value: ["research", "project-question-package"] },
    { name: "extra consumer", value: ["code-answer", "project-question-package", "M8"] },
    { name: "repeated wrong content", value: ["code-answer", "code-answer"] },
  ];
  for (const entry of cases) {
    const source = clone(validSource), consumer = source.inputResult.gaps[0]!.consumer as Record<string, unknown>;
    if (entry.missing) delete consumer.uses; else consumer.uses = entry.value;
    const refusal = hasCode(collectGaps(source), "gap_class_conflict");
    assert.equal(refusal.at.target, "repo-inventory", entry.name);
    assert.equal(refusal.at.field, "consumer.uses", entry.name);
    const gate = gateGaps(valid as GapCollection, source);
    assert.equal(gate.passed, false, entry.name);
    assert.ok(gate.codes.includes("gap_class_conflict"), entry.name);
    const gateRefusal = gate.findings.find(item => item.code === "gap_class_conflict")!;
    addressed(gateRefusal);
    assert.equal(gateRefusal.at.target, "repo-inventory", entry.name);
    assert.equal(gateRefusal.at.field, "consumer.uses", entry.name);
  }
  const reordered = clone(validSource);
  (reordered.inputResult.gaps[0]!.consumer as { uses: string[] }).uses.reverse();
  const normalized = collectGaps(reordered);
  assert.deepEqual(normalized.refusals, []); assert.deepEqual(normalized.gaps[0]!.uses, valid.gaps[0]!.uses);
  assert.equal(gateGaps(normalized as GapCollection, reordered).passed, true);
});

test("knowledge moments preserve explicit v6 deadlines including an earlier feasibility deadline", () => {
  const source = sources();
  assert.ok(source.inputResult.input!.sources.every(row => row.contractVersion === 6));
  const cases = [
    ["repository-fact", "om-pass", ["code", "research"]], ["design-decision", "om-pass", ["design"]],
    ["owner-decision", "om-pass", ["owner"]], ["environment-confirmation", "task-start", ["environment"]],
    ["post-implementation-proof", "task-result", ["task-result"]],
  ] as const;
  source.inputResult.input!.questions = cases.map(([kind]) => question(kind, kind));
  source.inputResult.input!.questions.push({ ...question("environment-before-G6", "environment-confirmation"), moment: "feasibility" });
  stamp(source);
  const result = collectGaps(source); assert.deepEqual(result.refusals, []);
  for (const [kind, moment, routes] of cases) {
    const gap = result.gaps.find(item => item.target === kind)!;
    assert.equal(gap.kind, kind); assert.equal(gap.moment, moment); assert.deepEqual(gap.routes, routes);
    assert.equal(gap.blocking, moment === "om-pass");
  }
  const existing = result.gaps.find(item => item.target === "environment-before-G6")!;
  assert.equal(existing.moment, "feasibility"); assert.equal(existing.blocking, false);
  const unaddressed = sources();
  unaddressed.inputResult.input!.questions = [{ ...question("historical-prose", "environment-confirmation", "the backend team"), moment: "feasibility" }];
  stamp(unaddressed);
  const address = collectGaps(unaddressed); assert.deepEqual(address.refusals, []);
  assert.equal(address.gaps[0]!.code, "question_unaddressed"); assert.equal(address.gaps[0]!.field, "address");
  assert.equal(address.gaps[0]!.mechanism, "M5:addressing");
  assert.ok(canonical(address.gaps[0]!.evidence).includes("feasibility"));
  assert.ok(canonical(address.gaps[0]!.evidence).includes("environment-confirmation"));
  unaddressed.inputResult.input!.questions = [question("unclassified-historical", null)];
  stamp(unaddressed);
  const unclassified = collectGaps(unaddressed); assert.deepEqual(unclassified.refusals, []);
  assert.equal(unclassified.gaps[0]!.field, "address"); assert.equal(unclassified.gaps[0]!.kind, "design-decision");
});

test("feature, requirement, operation and work consumers resolve every native parent and realizes block", () => {
  const source = sources();
  source.graph.edges!.push({ id: "work-also-realizes-later", relation: "realizes", source: "garden-consume-work",
    target: "garden-later-operation", condition: "One work fulfills both roles" });
  source.inputResult.gaps = [
    inputGap("contract_node_unbound", "feature-contract", "nodes", { features: [{ feature: 0, title: "Produce" }, { feature: 1, title: "Consume" }] }),
    inputGap("acceptance_kind_missing", "requirement-criterion", "checkKind", { requirement: "garden-R1" }),
  ];
  source.inputResult.input!.questions = [question("operation", "design-decision", "garden-consume-operation"),
    question("work", "design-decision", "garden-consume-work")];
  stamp(source);
  let result = collectGaps(source); assert.deepEqual(result.refusals, []);
  for (const target of ["feature-contract", "requirement-criterion"])
    assert.deepEqual(result.gaps.find(gap => gap.target === target)!.consumers, ["garden-consume-block", "garden-produce-block"]);
  assert.deepEqual(result.gaps.find(gap => gap.target === "operation")!.consumers, ["garden-consume-block"]);
  assert.deepEqual(result.gaps.find(gap => gap.target === "work")!.consumers, ["garden-consume-block", "garden-later-block"]);
  const partiallyUnbound = clone(source);
  partiallyUnbound.inputResult.gaps = partiallyUnbound.inputResult.gaps.filter(gap => gap.target === "requirement-criterion");
  partiallyUnbound.inputResult.input!.questions = [];
  partiallyUnbound.inputResult.input!.features[0]!.outcome = "no-such-block-outcome";
  stamp(partiallyUnbound);
  hasCode(collectGaps(partiallyUnbound), "gap_consumer_missing");
  const identities = result.gaps.map(gap => gap.id);
  source.horizon.nodes = ["garden-produce-block"];
  result = collectGaps(source); assert.deepEqual(result.refusals, []);
  assert.deepEqual(result.gaps.map(gap => gap.id), identities);
  const deferred = result.gaps.find(gap => gap.target === "work")!;
  assert.equal(deferred.blocking, false); assert.equal(deferred.deferral!.until, "horizon-entry");
  assert.deepEqual(deferred.deferral!.blocks, ["garden-consume-block", "garden-later-block"]);
  source.horizon.nodes = ["garden-later-block"];
  const awake = collectGaps(source).gaps.find(gap => gap.target === "work")!;
  assert.equal(awake.id, deferred.id); assert.equal(awake.blocking, true);
});

test("same-identity evidence merges canonically while conflicting classifications never choose the first source", () => {
  const source = sources();
  const a = inputGap("contract_node_unbound", "shared-contract", "nodes", { features: [{ feature: 0, title: "Produce" }] });
  const b = inputGap("contract_node_unbound", "shared-contract", "nodes", { features: [{ feature: 1, title: "Consume" }] });
  source.inputResult.gaps = [a, b];
  const result = collectGaps(source); assert.deepEqual(result.refusals, []); assert.equal(result.gaps.length, 1);
  assert.deepEqual(result.gaps[0]!.consumers, ["garden-consume-block", "garden-produce-block"]);
  assert.equal(result.gaps[0]!.evidence.length, 2);
  source.inputResult.gaps.reverse(); source.horizon.nodes.reverse(); source.graph.nodes.reverse();
  assert.deepEqual(collectGaps(source), result);
  const textChanged = clone(source); textChanged.inputResult.gaps[0]!.message += " clarified";
  assert.equal(collectGaps(textChanged).gaps[0]!.id, result.gaps[0]!.id);
  const differentSources = sources(), frame = frameGaps(differentSources.graph, 2)[0]!;
  differentSources.frameGaps.operations = [frame];
  differentSources.inputResult.gaps = [inputGap("obligation_open", frame.target, "fill", frame.consumer)];
  const combined = collectGaps(differentSources); assert.deepEqual(combined.refusals, []);
  assert.equal(combined.gaps.length, 1); assert.deepEqual(combined.gaps[0]!.origins, ["frame", "input"]);
  assert.equal(combined.gaps[0]!.node, frame.consumer);
  assert.equal(combined.gaps[0]!.evidence.length, 2);
  for (const mutation of [
    (q: SourceQuestion) => { q.kind = "repository-fact"; },
    (q: SourceQuestion) => { q.moment = "task-start"; },
  ]) {
    const conflicts = sources(), first = question("same-question"), second = clone(first); mutation(second);
    for (const questions of [[first, second], [second, first]]) {
      conflicts.inputResult.input!.questions = questions;
      stamp(conflicts);
      const conflict = collectGaps(conflicts); hasCode(conflict, "gap_class_conflict");
      assert.equal(gateGaps(conflict as GapCollection, conflicts).passed, false);
    }
  }
  const mechanisms = sources();
  mechanisms.inputResult.gaps = [inputGap("contract_node_unbound", "same-mechanism-slot", "nodes", { mechanism: "M3" }),
    inputGap("contract_node_unbound", "same-mechanism-slot", "nodes", { mechanism: "M6" })];
  hasCode(collectGaps(mechanisms), "gap_class_conflict");
  mechanisms.inputResult.gaps.reverse(); hasCode(collectGaps(mechanisms), "gap_class_conflict");
  for (const level of [2, 3] as const) {
    const ambiguous = sources(), origin = level === 2 ? "operations" : "works";
    const actual = frameGaps(ambiguous.graph, level), first = actual.find(gap => gap.consumer.includes("consume"))!;
    const second = clone(actual.find(gap => gap.consumer.includes("produce"))!);
    second.target = first.target;
    assert.notEqual(first.consumer, second.consumer);
    for (const frameSources of [[first, second], [second, first]]) {
      ambiguous.frameGaps[origin] = frameSources;
      const conflict = collectGaps(ambiguous);
      hasCode(conflict, "gap_class_conflict");
      assert.ok(!conflict.gaps.some(gap => gap.target === first.target));
    }
  }
});

test("all mandatory source sets are explicit and malformed classes, consumers and moments refuse with addresses", () => {
  const initial = sources();
  assert.deepEqual(collectGaps(initial).gaps, []); assert.deepEqual(collectGaps(initial).refusals, []);
  for (const field of ["inputResult", "frameGaps", "horizon", "graph"] as const) {
    const absent = clone(initial) as Partial<GapSources>; delete absent[field];
    hasCode(collectGaps(absent as GapSources), "gap_source_missing");
  }
  const absentSets = [
    (source: GapSources) => { delete (source.inputResult as Partial<GapSources["inputResult"]>).gaps; },
    (source: GapSources) => { delete (source.inputResult as Partial<GapSources["inputResult"]>).hash; },
    (source: GapSources) => { delete (source.inputResult.input! as Partial<NonNullable<GapSources["inputResult"]["input"]>>).questions; },
    (source: GapSources) => { delete (source.inputResult.input! as Partial<NonNullable<GapSources["inputResult"]["input"]>>).features; },
    (source: GapSources) => { delete (source.frameGaps as Partial<GapSources["frameGaps"]>).operations; },
    (source: GapSources) => { delete (source.frameGaps as Partial<GapSources["frameGaps"]>).works; },
    (source: GapSources) => { delete (source.horizon as Partial<GapSources["horizon"]>).nodes; },
  ];
  for (const remove of absentSets) { const absent = clone(initial); remove(absent); hasCode(collectGaps(absent), "gap_source_missing"); }
  for (const bad of [undefined, null, [], "source"])
    hasCode(collectGaps(bad as unknown as GapSources), "gap_source_missing");
  for (const field of ["blocks", "source"] as const) {
    const source = sources(), incomplete = question("incomplete") as Partial<SourceQuestion>;
    delete incomplete[field]; source.inputResult.input!.questions = [incomplete as SourceQuestion];
    stamp(source);
    hasCode(collectGaps(source), "gap_source_missing");
  }
  for (const field of ["message", "source"] as const) {
    const source = sources(), incomplete = inputGap("acceptance_kind_missing", "criterion", "checkKind", { requirement: "garden-R1" }) as Partial<SourceGap>;
    delete incomplete[field]; source.inputResult.gaps = [incomplete as SourceGap];
    hasCode(collectGaps(source), "gap_source_missing");
  }
  for (const level of [2, 3] as const) {
    const origin = level === 2 ? "operations" : "works", frame = frameGaps(initial.graph, level)[0]!;
    for (const field of ["level", "upper", "artifact", "role", "port", "portContract", "existing", "allowNew"] as const) {
      const source = sources(), incomplete = clone(frame);
      delete (incomplete.question as Partial<FrameGap["question"]>)[field];
      source.frameGaps[origin] = [incomplete]; hasCode(collectGaps(source), "gap_source_missing");
    }
    for (const field of ["id", "level", "kind", "upper", "artifact", "zone"] as const) {
      const source = sources(), incomplete = clone(frame);
      assert.ok(incomplete.neighbors.length > 0);
      delete (incomplete.neighbors[0] as Partial<FrameGap["neighbors"][number]>)[field];
      source.frameGaps[origin] = [incomplete]; hasCode(collectGaps(source), "gap_source_missing");
    }
  }
  for (const code of ["unknown-source", "constructor", "toString", "__proto__"]) {
    const source = sources(); source.inputResult.gaps = [inputGap(code, "unknown", "nodes", { requirement: "garden-R1" })];
    hasCode(collectGaps(source), "gap_class_unknown");
  }
  const unknownKind = sources(); unknownKind.inputResult.input!.questions = [question("unknown-kind", "new-model-kind")];
  stamp(unknownKind);
  hasCode(collectGaps(unknownKind), "gap_kind_unknown");
  const unknownMoment = sources(); unknownMoment.inputResult.input!.questions = [{ ...question("bad-moment"), moment: "later" as NonNullable<SourceQuestion["moment"]> }];
  stamp(unknownMoment);
  hasCode(collectGaps(unknownMoment), "gap_moment_unknown");
  const proseMoment = sources();
  proseMoment.inputResult.input!.questions = [{ ...question("prose-moment", "environment-confirmation", "the backend team"), moment: "later" as NonNullable<SourceQuestion["moment"]> }];
  stamp(proseMoment);
  hasCode(collectGaps(proseMoment), "gap_moment_unknown");
  const proseAddressing = sources();
  proseAddressing.inputResult.input!.questions = [{ ...question("prose-addressing", "design-decision", "the backend team"), addressedBy: { id: "broken-addressing" } as Ref }];
  stamp(proseAddressing);
  hasCode(collectGaps(proseAddressing), "gap_source_missing");
  const noConsumer = sources(); noConsumer.inputResult.gaps = [inputGap("contract_node_unbound", "unbound", "nodes", { features: [] })];
  hasCode(collectGaps(noConsumer), "gap_consumer_missing");
  const badField = sources(); badField.inputResult.gaps = [inputGap("contract_node_unbound", "unbound", "inventory", { requirement: "garden-R1" })];
  hasCode(collectGaps(badField), "gap_class_conflict");
  const disguised = sources(); disguised.inputResult.gaps = [{ ...inputGap("contract_node_unbound", "unbound", "nodes", { requirement: "garden-R1" }), kind: "repository-fact" }];
  hasCode(collectGaps(disguised), "gap_class_conflict");
  const hashMask = sources(); hashMask.inputResult.hash = "0".repeat(64);
  hasCode(collectGaps(hashMask), "gap_record_forged");
  const absentHash = sources(); absentHash.inputResult.hash = null;
  hasCode(collectGaps(absentHash), "gap_record_forged");
  for (const bad of [undefined, null, "", 4]) {
    assert.throws(() => gapId(bad as unknown as string, "field"), malformed);
    assert.throws(() => gapId("target", bad as unknown as string), malformed);
  }
});

test("G4 derives the whole claimed set and rejects omissions, foreign rows, duplicates and rehashed status masks", () => {
  const source = sources(); source.inputResult.gaps = [inventoryGap()];
  source.inputResult.input!.questions = [question("one"), question("two", "repository-fact", "garden-later-operation")];
  stamp(source);
  const expected = collectGaps(source); assert.deepEqual(expected.refusals, []);
  const check = (claim: unknown, code: string) => {
    const result = gateGaps(claim as GapCollection, source);
    assert.equal(result.passed, false); assert.ok(result.codes.includes(code), result.codes.join(", "));
    addressed(result.findings.find(item => item.code === code)!);
  };
  check(undefined, "gap_set_missing"); check({}, "gap_set_missing");
  check({ ...clone(expected), gaps: [] }, "gap_missing");
  const missing = clone(expected) as GapCollection; missing.gaps.pop(); check(missing, "gap_missing");
  const duplicate = clone(expected) as GapCollection; duplicate.gaps.push(clone(duplicate.gaps[0]!)); check(duplicate, "gap_duplicate");
  const foreign = clone(expected) as GapCollection, extra = clone(foreign.gaps[0]!); extra.target = "forged-target"; extra.id = gapId(extra.target, extra.field); foreign.gaps.push(extra);
  check(foreign, "gap_foreign");
  const masked = clone(expected) as GapCollection; masked.gaps[0]!.blocking = !masked.gaps[0]!.blocking; check(masked, "gap_record_forged");
  const diverted = clone(expected) as GapCollection; diverted.gaps.find(gap => gap.code === "inventory_missing")!.routes = ["research"];
  check(diverted, "gap_record_forged");
  const outside = sources(); outside.horizon.nodes = [];
  outside.inputResult.input!.questions = [question("deferred")];
  stamp(outside);
  const raw = clone(collectGaps(outside)) as GapCollection; delete raw.gaps[0]!.deferral;
  const gate = gateGaps(raw as GapCollection, outside);
  assert.equal(gate.passed, false); assert.ok(gate.codes.includes("gap_outside_horizon"));
  assert.equal(gateGaps(expected as GapCollection, source).passed, true);
});

test("gap policy is an immutable snapshot and addressed source evidence preserves own JSON keys", () => {
  const source = sources();
  const addressedBy = JSON.parse('{"id":"decision:garden:address","revision":1,"hash":"' + "a".repeat(64) + '","__proto__":{"keep":true}}');
  source.inputResult.input!.questions = [{ ...question("addressed", "repository-fact"), addressedBy }];
  stamp(source);
  const expected = collectGaps(source); assert.deepEqual(expected.refusals, []);
  assert.ok(canonical(expected.gaps[0]!.evidence).includes('"__proto__"'));
  assert.ok(canonical(expected.gaps[0]!.evidence).includes('"keep":true'));
  const kinds = KNOWLEDGE_KINDS as unknown as string[], moments = RESOLUTION_MOMENTS as unknown as string[];
  const originalKinds = [...kinds], originalMoments = [...moments];
  try {
    kinds.splice(0, kinds.length, "invented-kind"); moments.splice(0, moments.length, "whenever");
    assert.deepEqual(collectGaps(source), expected);
    source.inputResult.input!.questions.push(question("invented", "invented-kind"));
    stamp(source);
    hasCode(collectGaps(source), "gap_kind_unknown");
  } finally { kinds.splice(0, kinds.length, ...originalKinds); moments.splice(0, moments.length, ...originalMoments); }
  addressedBy.__proto__.keep = false;
  assert.ok(canonical(expected.gaps[0]!.evidence).includes('"keep":true'));
  assert.ok(Object.isFrozen(expected.gaps[0]!.evidence));
});

test("native D1 prepares without writes, persists exact B1 and C3 sources and repeats without extra revisions", async t => {
  const f = await createOmFixture(t), request = nativeRequest(f), before = revisions(f.store);
  const prepared = delivered(prepareGaps(f.store, request));
  assert.equal(prepared.gate.passed, true); assert.deepEqual(prepared.collection.refusals, []);
  assert.ok(prepared.collection.gaps.some(gap => gap.code === "inventory_missing"));
  assert.equal(prepared.existing.length, 0);
  assert.equal(prepared.writes.length, prepared.collection.gaps.length);
  assert.ok('frame' in prepared.sources.works);
  assert.equal(prepared.sources.works.frame.workZoneContract, 'accepted-l2-v1');
  assert.deepEqual(prepared.sources, { ...request, works: { ...request.works,
    frame: { ...request.works.frame, workZoneContract: 'accepted-l2-v1' } } });
  assert.equal(Object.hasOwn(request.works.frame, 'workZoneContract'), false);
  assert.deepEqual(revisions(f.store), before);
  const saved = delivered(writeGaps(f.store, request));
  assert.equal(saved.records.length, prepared.collection.gaps.length);
  assert.deepEqual(saved.sources, prepared.sources);
  assert.equal(f.store.list("gap").length, saved.records.length);
  assert.deepEqual(saved.collection, prepared.collection);
  for (const row of saved.records) {
    assert.equal(row.kind, "gap"); assert.equal(row.id, `om-gap:garden:${row.value.gap.id}`);
    assert.equal(row.revision, 1); assert.equal(row.value.project, "garden");
    assert.deepEqual(row.value.sources, prepared.sources);
    assert.equal(row.hash, hashJson(row.value));
  }
  const read = delivered(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: saved.records.map(reference) }));
  assert.deepEqual(read.collection, saved.collection); assert.deepEqual(read.records, saved.records);
  const after = revisions(f.store), repeated = delivered(writeGaps(f.store, request));
  assert.deepEqual(repeated, saved); assert.deepEqual(revisions(f.store), after);
  const reuse = delivered(prepareGaps(f.store, request));
  assert.deepEqual(reuse.writes, []); assert.equal(reuse.existing.length, saved.records.length);
  for (const row of saved.records) assert.ok(reuse.guards.some(ref => canonical(ref) === canonical(reference(row))));
  assert.deepEqual(revisions(f.store), after);
  assert.ok(Object.isFrozen(saved.records[0]!.value.gap.evidence));
});

test("stored gap history survives source and graph heads plus reopen while G4 rejects missing or self-consistent forged records", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = await createOmFixture(t), request = nativeRequest(f), saved = delivered(writeGaps(f.store, request));
  const refs = saved.records.map(reference), before = revisions(f.store);
  assert.ok(refs.length > 1, "the native input supplies several independent gaps");
  refusedAs(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: [] }), "gap_missing");
  refusedAs(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: refs.slice(1) }), "gap_missing");
  refusedAs(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: [...refs, refs[0]!] }), "gap_duplicate");
  assert.deepEqual(revisions(f.store), before);
  const victim = saved.records.find(row => row.value.gap.code === "inventory_missing")!;
  const counterfeit = clone(victim.value) as GapRecord;
  counterfeit.gap.blocking = true; counterfeit.gap.routes = ["research"];
  const forged = f.store.write<GapRecord>({ id: victim.id, kind: "gap", expected: victim.revision, value: counterfeit });
  assert.equal(forged.hash, hashJson(counterfeit));
  const forgedRefs = refs.map(ref => ref.id === forged.id ? reference(forged) : ref), afterForgery = revisions(f.store);
  refusedAs(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: forgedRefs }), "gap_record_forged");
  assert.deepEqual(delivered(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: refs })).collection, saved.collection);
  assert.deepEqual(revisions(f.store), afterForgery);
  const graph = f.store.get("graph:garden")!, source = f.store.get("source:garden:brief")!;
  f.store.write({ id: graph.id, kind: graph.kind, expected: graph.revision, value: graph.value });
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  const afterDrift = revisions(f.store);
  refusedAs(prepareGaps(f.store, request), "input_stale");
  refusedAs(writeGaps(f.store, request), "input_stale");
  const historic = delivered(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: refs }));
  assert.deepEqual(historic.collection, saved.collection);
  assert.deepEqual(revisions(f.store), afterDrift);
  f.reopen();
  assert.deepEqual(delivered(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: refs })), historic);
  assert.deepEqual(revisions(f.store), afterDrift);
});

test("new and reused gap preparations guard source, graph, proposals and saved gaps before any neighbor write", async t => {
  const f = await createOmFixture(t), request = nativeRequest(f);
  const proposal = f.store.write({ id: "om-proposal:garden:gaps", kind: "layer-proposal", expected: 0, value: {
    base: { graph: request.graph, frame: null }, level: 2, source: "input", status: "proposed", nodes: [], fills: [], localConnectors: [],
    artifacts: [], contracts: [], joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [],
  } });
  request.operations.proposals = [reference(proposal)];
  let newSnapshot = "";
  for (const mode of ["new", "existing"] as const) {
    if (mode === "existing") delivered(writeGaps(f.store, request));
    const prepared = delivered(prepareGaps(f.store, request));
    assert.equal(prepared.writes.length === 0, mode === "existing");
    const snapshot = await f.store.snapshot(join(f.root, `gap-${mode}-snapshot`));
    if (mode === "new") newSnapshot = snapshot.path;
    const dependencies = [request.input, request.graph, request.horizon, request.works.frame.layer!, reference(proposal),
      reference(f.store.get("source:garden:brief")!), ...(mode === "existing" ? [reference(prepared.existing[0]!)] : [])];
    for (const [index, dependency] of dependencies.entries()) {
      const path = join(f.root, `gap-${mode}-${index}.sqlite`); copyFileSync(snapshot.path, path);
      const store = new Store(path);
      try {
        const old = store.get(dependency.id)!;
        store.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
        const before = revisions(store);
        refusedAs(writeGuarded(store, { unit: "M5-neighbor", target: "gap-pass:garden", guards: prepared.guards,
          writes: [...prepared.writes, { id: "gap-pass:garden", kind: "gap-pass", expected: 0, value: { gaps: prepared.collection.gaps } },
            { id: "gap-pass-status:garden", kind: "gap-pass-status", expected: 0, value: { state: "accepted" } }] }), "input_stale");
        assert.equal(store.get("gap-pass:garden"), null); assert.equal(store.get("gap-pass-status:garden"), null);
        assert.deepEqual(revisions(store), before);
        assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(dependency)), `${mode}: ${dependency.id}`);
      } finally { store.close(); }
    }
  }
  const raceStorePath = join(f.root, "gap-write-race.sqlite");
  copyFileSync(newSnapshot, raceStorePath);
  const store = new Store(raceStorePath), writeMany = store.writeMany.bind(store);
  let injected = false;
  try {
    store.writeMany = ((writes, guards) => {
      if (!injected) {
        injected = true;
        const source = store.get("source:garden:brief")!;
        writeMany([{ id: source.id, kind: source.kind, expected: source.revision, value: source.value }]);
      }
      return writeMany(writes, guards);
    }) as Store["writeMany"];
    const beforeGaps = store.list("gap").map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
    const result = writeGaps(store, request);
    assert.equal(injected, true);
    refusedAs(result, "input_stale");
    assert.deepEqual(store.list("gap").map(row => ({ head: reference(row), history: store.history(row.id).map(reference) })), beforeGaps);
  } finally { store.writeMany = writeMany; store.close(); }
});

test("storage boundaries reject foreign exact references and status imitations without swallowing execution faults", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  const f = await createOmFixture(t), request = nativeRequest(f), saved = delivered(writeGaps(f.store, request));
  const records = saved.records.map(reference), fakeInput = f.store.write({ id: "om-input:foreign", kind: "om-input", expected: 0,
    value: { state: "accepted", input: {}, hash: hashJson({}), gaps: [] } });
  const before = revisions(f.store);
  for (const action of [prepareGaps, writeGaps]) {
    assert.throws(() => action(undefined as unknown as Store, request), malformed);
    for (const bad of [undefined, null, [], "request"]) assert.throws(() => action(f.store, bad as unknown as GapRequest), malformed);
    for (const field of ["project", "input", "horizon", "graph", "operations", "works"] as const) {
      const absent = clone(request) as Partial<GapRequest>; delete absent[field];
      assert.throws(() => action(f.store, absent as GapRequest), malformed);
    }
    refusedAs(action(f.store, { ...request, input: reference(fakeInput) }), "record_foreign");
    refusedAs(action(f.store, { ...request, input: { ...request.input, hash: "0".repeat(64) } }), "record_forged");
    for (const fault of [new TypeError("gap-read-fault"), new EngineError("record_corrupt", "Exact source broken", { input: request.input.id })]) {
      const get = f.store.get.bind(f.store);
      try {
        f.store.get = ((id: string, revision?: number) => { if (id === request.input.id) throw fault; return get(id, revision); }) as Store["get"];
        assert.throws(() => action(f.store, request), error => error === fault);
        assert.throws(() => readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records }), error => error === fault);
      } finally { f.store.get = get; }
    }
  }
  assert.throws(() => readGaps(undefined as unknown as Store, { sources: clone(saved.sources) as GapRequest, records }), malformed);
  assert.throws(() => readGaps(f.store, { sources: clone(saved.sources) as GapRequest } as Parameters<typeof readGaps>[1]), malformed);
  refusedAs(readGaps(f.store, { sources: clone(saved.sources) as GapRequest, records: [{ ...records[0]!, hash: "0".repeat(64) }, ...records.slice(1)] }), "record_forged");
  assert.deepEqual(revisions(f.store), before);
  assert.deepEqual([...GAP_REFUSAL_CODES].sort(), ["gap_request_invalid", "gap_source_missing", "gap_set_missing", "gap_record_forged", "gap_missing",
    "gap_foreign", "gap_duplicate", "gap_class_unknown", "gap_kind_unknown", "gap_class_conflict", "gap_consumer_missing", "gap_moment_unknown", "gap_outside_horizon"].sort());
});

test("native first-pass gaps accept an explicit unaccepted work upper, then expose works after L2 without rewriting history", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-gap-first-pass-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "README.md"), "Deterministic first-pass garden product.\n");
  const desired = gardenGraph(), { level: _level, ...projection } = projectGraph(desired, 1);
  preparedFeatures(engine, "garden", projection as Graph);
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("garden", { workspace: root,
    implementer: { actor: "first-pass-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "first-pass-reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 10_000 }, 0);
  const input = delivered(writeOmInput(store, { project: "garden", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const initialGraph = store.get<Graph>("graph:garden")!, rawLayer2 = store.get("graph-layer:garden:2")!;
  assert.ok(initialGraph.value.nodes.every(node => LEVEL[node.kind] <= 1));
  assert.equal(engine.graphs.layerIsDerived("garden", 2), false);
  assert.equal(engine.graphs.layerIsDerived("garden", 3), false);
  const firstHorizon = delivered(writeHorizon(store, { project: "garden", input: reference(input), graph: reference(initialGraph),
    refinement: null, available: {}, choice: { choiceVersion: "first-pass", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const operations: ProposalRequest = { proposals: [], frame: { project: "garden", level: 2, graph: reference(initialGraph),
    horizon: reference(firstHorizon.gate), layer: null, frame: null, upper: null } };
  const request: GapRequest = { project: "garden", input: reference(input), graph: reference(initialGraph), horizon: reference(firstHorizon.gate),
    operations, works: { state: "upper-not-accepted", layer: reference(rawLayer2) } };
  const initialState = revisions(store);
  for (const works of [null, {}, { state: "upper-not-accepted" }, { layer: reference(rawLayer2) },
    { state: "unknown", layer: reference(rawLayer2) }, { state: "upper-not-accepted", layer: null },
    { state: "upper-not-accepted", layer: reference(rawLayer2), gaps: [] }]) {
    const malformedSource = { ...request, works } as GapRequest;
    assert.throws(() => prepareGaps(store, malformedSource), malformed);
    assert.throws(() => writeGaps(store, malformedSource), malformed);
    assert.throws(() => readGaps(store, { sources: malformedSource, records: [] }), malformed);
  }
  for (const layer of [{ ...reference(rawLayer2), hash: "0".repeat(64) },
    { ...reference(rawLayer2), id: "graph-layer:other:2" }, reference(store.get("graph-layer:garden:1")!)]) {
    const foreignBasis: GapRequest = { ...request, works: { state: "upper-not-accepted", layer } };
    refusedAs(prepareGaps(store, foreignBasis), "layer_basis_unproven");
    refusedAs(writeGaps(store, foreignBasis), "layer_basis_unproven");
    refusedAs(readGaps(store, { sources: foreignBasis, records: [] }), "layer_basis_unproven");
  }
  assert.deepEqual(revisions(store), initialState);
  const operationSource = delivered(prepareFrameProposals(store, operations));
  assert.equal(operationSource.gaps.length, 4);
  const beforePreparation = revisions(store), prepared = delivered(prepareGaps(store, request));
  assert.equal(prepared.gate.passed, true);
  assert.deepEqual(prepared.collection.refusals, []);
  assert.equal(prepared.collection.gaps.length, input.value.gaps.length + operationSource.gaps.length);
  for (const gap of operationSource.gaps) assert.ok(prepared.collection.gaps.some(item => item.target === gap.target && item.field === gap.field));
  assert.ok(prepared.collection.gaps.every(gap => gap.evidence.every(evidence => evidence.origin !== "works")));
  assert.deepEqual(revisions(store), beforePreparation);
  const firstSnapshot = await store.snapshot(join(root, "initial-source-snapshot"));
  const first = delivered(writeGaps(store, request)), firstRefs = first.records.map(reference);
  assert.deepEqual(first.sources, request);
  const firstHistory = delivered(readGaps(store, { sources: clone(first.sources) as GapRequest, records: firstRefs }));
  assert.deepEqual(firstHistory.collection, first.collection);
  const reused = delivered(prepareGaps(store, request));
  assert.deepEqual(reused.writes, []);
  const reusedSnapshot = await store.snapshot(join(root, "reused-source-snapshot"));
  for (const [name, preparation, snapshot] of [["new", prepared, firstSnapshot], ["reused", reused, reusedSnapshot]] as const) {
    for (const dependency of [reference(initialGraph), reference(rawLayer2)]) {
      const path = join(root, `${name}-${dependency.id.includes("graph-layer") ? "layer" : "graph"}.sqlite`);
      copyFileSync(snapshot.path, path);
      const branch = new Store(path);
      try {
        const old = branch.get(dependency.id)!;
        branch.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
        const before = revisions(branch);
        refusedAs(writeGuarded(branch, { unit: "M5-neighbor", target: "first-pass:garden", guards: preparation.guards,
          writes: [...preparation.writes,
            { id: "first-pass:garden", kind: "first-pass", expected: 0, value: { state: "accepted" } },
            { id: "first-pass-status:garden", kind: "first-pass-status", expected: 0, value: { state: "accepted" } }] }), "input_stale");
        assert.equal(branch.get("first-pass:garden"), null);
        assert.equal(branch.get("first-pass-status:garden"), null);
        assert.deepEqual(revisions(branch), before);
        assert.ok(preparation.guards.some(ref => canonical(ref) === canonical(dependency)), `${name}: ${dependency.id}`);
      } finally { branch.close(); }
    }
  }
  const absent = clone(request) as Partial<GapRequest>; delete absent.works;
  const beforeAbsent = revisions(store);
  assert.throws(() => prepareGaps(store, absent as GapRequest), malformed);
  assert.throws(() => writeGaps(store, absent as GapRequest), malformed);
  assert.throws(() => readGaps(store, { sources: absent as GapRequest, records: firstRefs }), malformed);
  assert.deepEqual(revisions(store), beforeAbsent);

  const r0 = engine.refinement.begin("garden", "R0");
  engine.refinement.finishResearch("garden", "R0", reference(r0), 0);
  engine.refinement.sealLayer("garden", 1, 0);
  const r1 = engine.refinement.begin("garden", "R1");
  answerTechnicalFixture(engine, "garden", r1);
  engine.refinement.finishResearch("garden", "R1", reference(store.get(r1.id)!), 0);
  const design = engine.refinement.prepareLayer("garden", 2);
  const answered = answerLayerFixture(engine, "garden", design, 2, desired);
  const nextGraph = engine.refinement.buildLayer("garden", 2, reference(answered), store.get("graph:garden")!.revision, "fixture-researcher");
  const layer2 = engine.refinement.sealLayer("garden", 2, 0);
  assert.ok(nextGraph.value.nodes.some(node => node.kind === "operation"));
  assert.ok(nextGraph.value.nodes.every(node => LEVEL[node.kind] <= 2));
  assert.equal(engine.graphs.layerIsDerived("garden", 2), true);
  assert.equal(engine.graphs.layerIsDerived("garden", 3), false);
  const beforeStale = revisions(store);
  refusedAs(prepareGaps(store, request), "input_stale");
  refusedAs(writeGaps(store, request), "input_stale");
  assert.deepEqual(delivered(readGaps(store, { sources: clone(first.sources) as GapRequest, records: firstRefs })), firstHistory);
  assert.deepEqual(revisions(store), beforeStale);

  const workHorizon = delivered(writeHorizon(store, { project: "garden", input: reference(input), graph: reference(nextGraph),
    refinement: reference(layer2), available: {}, choice: { choiceVersion: "first-work-pass", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const current: GapRequest & { works: ProposalRequest } = { project: "garden", input: reference(input), graph: reference(nextGraph), horizon: reference(workHorizon.gate),
    operations: { proposals: [], frame: { project: "garden", level: 2, graph: reference(nextGraph), horizon: reference(workHorizon.gate),
      layer: reference(store.get("graph-layer:garden:2")!), frame: null, upper: null } },
    works: { proposals: [], frame: { project: "garden", level: 3, graph: reference(nextGraph), horizon: reference(workHorizon.gate),
      layer: null, frame: null, upper: { horizon: reference(workHorizon.gate), frame: null } } } };
  const workSource = delivered(prepareFrameProposals(store, current.works));
  assert.ok(workSource.gaps.length > 0);
  const falseEmpty: GapRequest = { ...current, works: { state: "upper-not-accepted", layer: reference(store.get("graph-layer:garden:2")!) } };
  const beforeMask = revisions(store);
  for (const result of [prepareGaps(store, falseEmpty), writeGaps(store, falseEmpty), readGaps(store, { sources: falseEmpty, records: [] })]) {
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("An accepted L2 cannot be presented as an unavailable work source");
    assert.ok(["gap_record_forged", "layer_basis_unproven"].includes(result.refusal.code), result.refusal.code);
    addressed(result.refusal);
  }
  assert.deepEqual(revisions(store), beforeMask);
  const next = delivered(writeGaps(store, current));
  assert.ok('frame' in next.sources.works);
  assert.equal(next.sources.works.frame.workZoneContract, 'accepted-l2-v1');
  for (const gap of workSource.gaps) {
    const saved = next.collection.gaps.find(item => item.target === gap.target && item.field === gap.field);
    assert.ok(saved, gap.target);
    assert.ok(saved.evidence.some(evidence => evidence.origin === "works"));
  }
  assert.ok(firstRefs.some(ref => next.records.some(record => record.id === ref.id && record.revision > ref.revision)));
  const nextRefs = next.records.map(reference), nextHistory = delivered(readGaps(store, { sources: clone(next.sources) as GapRequest, records: nextRefs }));
  assert.deepEqual(delivered(readGaps(store, { sources: clone(first.sources) as GapRequest, records: firstRefs })), firstHistory);
  store.close(); store = new Store(database);
  assert.deepEqual(delivered(readGaps(store, { sources: clone(first.sources) as GapRequest, records: firstRefs })), firstHistory);
  assert.deepEqual(delivered(readGaps(store, { sources: clone(next.sources) as GapRequest, records: nextRefs })), nextHistory);
});

test("current D1 admission distinguishes eras even when both legitimate derivations contain no gap records", async t => {
  const f = await createOmFixture(t), graph = reference(f.graphRevision);
  const inventory = f.store.write({ id: "repo-inventory:garden", kind: "repo-inventory", expected: 0,
    value: { projectId: f.project, paths: [...new Set(f.graph.nodes.flatMap(node => node.code.map(ref => ref.path)))].sort() } });
  const base = delivered(writeOmInput(f.store, { project: f.project, expected: 0, inventory: reference(inventory),
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  assert.deepEqual(base.value.input.questions, []);
  const decisions = base.value.gaps.map(gap => {
    assert.ok(["contract_node_unbound", "acceptance_kind_missing", "contract_boundary_prose"].includes(gap.code), gap.code);
    const field = gap.code === "contract_node_unbound" ? "nodes" : gap.code === "acceptance_kind_missing" ? "checkKind" : "state";
    const value: Json = field === "nodes" ? ["garden-produce-block", "garden-consume-block"] : field === "checkKind" ? "test"
      : { writer: "garden-produce-block", authority: "garden-user", rollback: "garden-produce-block" };
    return { pending: clone(inputDecisionWrite({ project: f.project, input: reference(base), graph, layers: [],
      decision: { target: gap.target, field, value } })) as Write };
  });
  const input = delivered(writeAddressing(f.store, { project: f.project, input: reference(base), graph, decisions }));
  assert.deepEqual(input.value.gaps, []);
  const horizon = delivered(writeHorizon(f.store, { project: f.project, input: reference(input), graph,
    refinement: reference(f.store.get("phase:garden:L2")!), available: {},
    choice: { choiceVersion: "empty-d1-era", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const frame = (level: FrameLevel): ProposalRequest => ({ proposals: [], frame: { project: f.project, level, graph,
    horizon: reference(horizon.gate), layer: reference(f.layers[level]), frame: null,
    upper: level === 2 ? null : { horizon: reference(horizon.gate), frame: null } } });
  const sources: GapRequest = { project: f.project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: frame(2), works: frame(3) };
  const saved = delivered(writeGaps(f.store, sources));
  assert.deepEqual(saved.collection, { gaps: [], refusals: [] });
  assert.deepEqual(saved.records, []);
  assert.ok("frame" in saved.sources.works);
  assert.equal(saved.sources.works.frame.workZoneContract, "accepted-l2-v1");
  const current: GapReadRequest = { sources: clone(saved.sources) as GapRequest, records: [] };
  const legacy = clone(current);
  assert.ok("frame" in legacy.sources.works);
  delete legacy.sources.works.frame.workZoneContract;
  const before = revisions(f.store);
  assert.deepEqual(delivered(readGaps(f.store, legacy)).collection, saved.collection);
  const refusal = refusedAs(prepareCurrentGaps(f.store, legacy), "input_stale");
  assert.equal(refusal.at.field, "gaps.sources");
  const admitted = delivered(prepareCurrentGaps(f.store, current));
  assert.deepEqual(admitted.sources, saved.sources);
  assert.deepEqual(admitted.collection, saved.collection);
  assert.deepEqual(admitted.writes, []);
  assert.deepEqual(admitted.existing, []);
  for (const ref of [graph, reference(input), reference(horizon.gate), reference(inventory), reference(f.layers[2]), reference(f.layers[3])])
    assert.ok(admitted.guards.some(guard => canonical(guard) === canonical(ref)), ref.id);
  assert.deepEqual(revisions(f.store), before);

  const unread = new Proxy(f.store, { get(target, key) {
    if (key === "get") return () => { throw new Error("Malformed admission must fail before any Store read"); };
    const member: unknown = Reflect.get(target, key, target); return typeof member === "function" ? member.bind(target) : member;
  } });
  for (const bad of [undefined, null, [], {}, { records: [] }, { sources: current.sources },
    { sources: null, records: [] }, { sources: current.sources, records: [{}] }])
    assert.throws(() => prepareCurrentGaps(unread, bad as unknown as GapReadRequest), malformed);
  assert.throws(() => prepareCurrentGaps(undefined as unknown as Store, current), malformed);
});

test('B1.1 D1 uses the exact question producer era and never defaults missing v4 moments', () => {
  const source = sources();
  source.inputResult.input!.sources.find(item => item.stage === 'features')!.contractVersion = 4;
  source.inputResult.input!.questions = [{ ...question('environment', 'environment-confirmation'), moment: 'feasibility' }];
  stamp(source);
  const valid = collectGaps(source);
  assert.deepEqual(valid.refusals, []);
  assert.equal(valid.gaps.find(gap => gap.target === 'environment')!.moment, 'feasibility');
  for (const addressed of [true, false]) for (const moment of ['absent', null, undefined, 'R3', 'later', 1]) {
    const changed = clone(source), q = changed.inputResult.input!.questions[0]! as unknown as Record<string, unknown>;
    if (!addressed) q.consumer = 'unresolved team';
    if (moment === 'absent') delete q.moment; else q.moment = moment;
    if (moment !== undefined) stamp(changed);
    const result = collectGaps(changed), refusal = result.refusals.find(item => item.code === 'gap_moment_unknown');
    assert.ok(refusal); assert.equal(refusal.at.target, 'environment'); assert.equal(refusal.at.field, 'moment');
    assert.ok(!result.gaps.some(gap => gap.target === 'environment'));
  }
  const mixed = clone(source), input = mixed.inputResult.input!;
  // This mixed-era regression remains explicit until its removal in LG25.
  input.sources.find(item => item.stage === 'discovery')!.contractVersion = 3;
  const prior = { ...question('old-environment', 'environment-confirmation'), source: fakeRef('stage:garden:discovery') };
  delete prior.moment;
  input.questions.push(prior); stamp(mixed);
  const history = collectGaps(mixed); assert.deepEqual(history.refusals, []);
  assert.equal(history.gaps.find(gap => gap.target === 'old-environment')!.moment, 'task-start');
  assert.equal(history.gaps.find(gap => gap.target === 'environment')!.moment, 'feasibility');
  assert.equal(Object.hasOwn(prior, 'moment'), false);
  const service = clone(source); service.inputResult.input!.questions[0]!.consumer = 'unresolved team'; stamp(service);
  const serviceGap = collectGaps(service).gaps.find(gap => gap.target === 'environment')!;
  assert.equal(serviceGap.code, 'question_unaddressed'); assert.equal(serviceGap.moment, 'om-pass');
  assert.equal(serviceGap.mechanism, 'M5:addressing');
  assert.equal((serviceGap.evidence[0]!.value as Record<string, Json>).moment, 'feasibility');
  for (const mutation of ['revision', 'hash', 'missing', 'duplicate', 'missing-era', 'unknown-era'] as const) {
    const changed = clone(source), q = changed.inputResult.input!.questions[0]!;
    if (mutation === 'revision') q.source.revision++;
    if (mutation === 'hash') q.source.hash = '0'.repeat(64);
    if (mutation === 'missing') changed.inputResult.input!.sources = [];
    if (mutation === 'duplicate') changed.inputResult.input!.sources.push(clone(changed.inputResult.input!.sources.find(item => item.stage === 'features')!));
    const producer = changed.inputResult.input!.sources.find(item => item.stage === 'features');
    if (mutation === 'missing-era') delete (producer as unknown as Record<string, unknown>).contractVersion;
    if (mutation === 'unknown-era') producer!.contractVersion = 99;
    stamp(changed); assert.ok(collectGaps(changed).refusals.some(item => item.code === 'gap_source_missing'));
  }
});

test('B1.1 the complete 1189043 producer retains v3 stages questions defaults and gap bytes after restart', async t => {
  const { execFileSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { readOmInput } = await import('../src/om/input.js');
  const root = mkdtempSync(join(tmpdir(), 'omg-b11-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url)), database = join(root, 'history.sqlite');
  const loader = join(root, 'loader.mjs'), producer = join(root, 'producer.mjs');
  const tsUrl = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(loader, String.raw`import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';let root,ts;
export async function initialize(data){root=data.root;ts=(await import(data.ts)).default;}
export async function load(url,context,next){const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  if(relative.startsWith('src/')||relative.startsWith('test/')){const source=execFileSync('git',['show','1189043f4bc71316195b2c387ff03b31689558b8:'+relative],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
   return{format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};}}
 return next(url,context);}`);
  writeFileSync(producer, String.raw`import assert from'node:assert/strict';import{pathToFileURL}from'node:url';import{join}from'node:path';
const root=process.argv[2], database=process.argv[3], load=p=>import(pathToFileURL(join(root,'dist',p)).href);
const{Store}=await load('src/storage/store.js'),{ProductEngine}=await load('src/product/engine.js');
const{reference}=await load('src/pipeline/contracts.js'),{UPSTREAM_STAGES}=await load('src/discovery/requirements.js');
const{canonical,hashJson}=await load('src/canonical.js'),{projectGraph}=await load('src/graph/project.js');
const{gardenGraph}=await load('test/om-fixture.js'),{preparedFeatures}=await load('test/product-fixture.js'),{preparedField}=await load('test/preparation-fixture.js');
const{writeOmInput}=await load('src/om/input.js'),{inputDecisionWrite,writeAddressing}=await load('src/om/addressing.js');
const{writeHorizon}=await load('src/om/horizon.js'),{writeGaps,readGaps}=await load('src/om/gaps.js');
const ok=r=>{assert.equal(r.ok,true,r.ok?'':r.refusal.code);return r.value;};
const store=new Store(database), engine=new ProductEngine(store),project='garden';
const{level,...graph}=projectGraph(gardenGraph(),1);
preparedFeatures(engine,project,graph,field=>{const value=preparedField(project,field);
 if(field==='preparation')value.unknowns=[{id:'old-environment',question:'Which environment?',consumer:'garden-produce-block',blocksCurrentStage:false,resolution:'Retain the original question'}];
 if(field==='featurePreparation')value[0].remainingQuestions=[{question:'Which implementation proof?',consumer:'garden-consume-block',blocksCurrentStage:false}];return value;});
const stages=Object.fromEntries(UPSTREAM_STAGES.map(stage=>[stage,reference(store.get('stage:'+project+':'+stage))]));
const base=ok(writeOmInput(store,{project,stages,expected:0})),graphRef=reference(store.get('graph:'+project));
assert.ok(base.value.input.sources.every(s=>s.contractVersion===3));
assert.ok(base.value.input.questions.every(q=>!Object.hasOwn(q,'moment')));
const input=ok(writeAddressing(store,{project,input:reference(base),graph:graphRef,decisions:base.value.input.questions.map(q=>({pending:inputDecisionWrite({project,input:reference(base),graph:graphRef,layers:[],decision:{target:q.id,field:'address',value:{consumer:q.consumer,kind:q.id.startsWith('discovery:')?'environment-confirmation':'post-implementation-proof'}}})}))}));
const horizon=ok(writeHorizon(store,{project,input:reference(input),graph:graphRef,refinement:null,available:{},choice:{choiceVersion:'b11-base',features:[{outcome:'garden-result'}],excluded:[]}}));
const request={project,input:reference(input),graph:graphRef,horizon:reference(horizon.gate),operations:{proposals:[],frame:{project,level:2,graph:graphRef,horizon:reference(horizon.gate),layer:null,frame:null,upper:null}},works:{state:'upper-not-accepted',layer:reference(store.get('graph-layer:garden:2'))}};
const gaps=ok(writeGaps(store,request)),readRequest={sources:gaps.sources,records:gaps.records.map(reference)},historical=ok(readGaps(store,readRequest));
assert.equal(gaps.collection.gaps.find(g=>g.target==='discovery:old-environment').moment,'task-start');
assert.equal(gaps.collection.gaps.find(g=>g.target==='feature:0:1').moment,'task-result');
const rows=store.list().flatMap(row=>store.history(row.id));for(const row of rows)assert.equal(hashJson(row.value),row.hash);
const result={base,input,gaps,readRequest,historical,rows,bytes:canonical(rows),gates:UPSTREAM_STAGES.map(stage=>engine.pipeline.inspect(project,stage))};
store.close();process.stdout.write(JSON.stringify(result));`);
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
    {data:{root:${JSON.stringify(pathToFileURL(repository).href)},ts:${JSON.stringify(tsUrl)}}});`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const previous = JSON.parse(execFileSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, database],
    { cwd: repository, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 50_000_000 }));
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(database), engine = new ProductEngine(store);
    try {
      for (const input of [previous.base, previous.input]) {
        assert.deepEqual(delivered(readOmInput(store, 'garden', reference(input))), input);
        assert.ok(input.value.input.questions.every((q: object) => !Object.hasOwn(q, 'moment')));
      }
      assert.deepEqual(delivered(readGaps(store, previous.readRequest)), previous.historical);
      assert.deepEqual(UPSTREAM_STAGES.map(stage => {
        const { closure: _closure, ...rest } = engine.pipeline.inspect('garden', stage);
        return rest;
      }), previous.gates);
      const rows = store.list().flatMap(row => store.history(row.id));
      assert.equal(canonical(rows), previous.bytes); assert.deepEqual(rows, previous.rows);
      for (const row of rows) assert.equal(hashJson(row.value), row.hash);
    } finally { store.close(); }
  }
});

// ---- PF3.1 (№3459 row 39): the history of the base code reads the same with the new one ----
const PF31_BASE = "259d7a8c3534a30211b7c29e0ac10823b46c9989";
/** The engine of the base commit, loaded from Git whole in its own process, works on the test's database. */
function atBase(root: string, database: string, body: string): unknown {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const loader = join(root, "pf31-base-loader.mjs"), producer = join(root, "pf31-base-producer.mjs"), served = join(root, "pf31-base-served.log");
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  writeFileSync(served, "");
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root, log, prefixes;
export function initialize(data) {
  root = data.root; log = data.log;
  prefixes = [root, pathToFileURL(realpathSync(fileURLToPath(root)) + '/').href].map(base => new URL('dist/src/', base).href);
}
export async function load(url, context, next) {
  const prefix = prefixes.find(item => url.startsWith(item));
  if (prefix && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    appendFileSync(log, relative + '\\n');
    const source = execFileSync('git', ['show', ${JSON.stringify(PF31_BASE)} + ':' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  if (url.startsWith('file:') && url.includes('/dist/src/') && !url.includes('/node_modules/'))
    throw new Error('An engine module outside the era checkout: ' + url);
  return next(url, context);
}`);
  writeFileSync(producer, `import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const store = new Store(database);
const take = result => { if (!result.ok) throw Error(JSON.stringify(result.refusal)); return result.value; };
const out = value => process.stdout.write(JSON.stringify(value));
try {
${body}
} finally { store.close(); }`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)}, log: ${JSON.stringify(served)} } });`;
  const output: unknown = JSON.parse(execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, database],
    { cwd: repository, encoding: "utf8", timeout: 300_000, maxBuffer: 50_000_000 }));
  const loaded = readFileSync(served, "utf8").split("\n");
  assert.ok(loaded.includes("src/om/gaps.ts") && loaded.includes("src/history/proofs.ts"), "The producer ran on the modules of the base commit");
  return output;
}

test("PF3.1 rows 35, 39: a D1 set from 259d7a8c preserves exact history and positive admission with new frame absence guards — cold, warm and after reopen", async t => {
  const f = await createOmFixture(t, undefined, undefined, PF31_BASE), request = nativeRequest(f);
  const root = mkdtempSync(join(tmpdir(), "omg-pf31-era-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = atBase(root, f.database, `const { writeGaps, readGaps, prepareCurrentGaps } = await import(src('om/gaps.js'));
const written = take(writeGaps(store, ${JSON.stringify(request)}));
const read = { sources: written.sources, records: written.records.map(row => ({ id: row.id, revision: row.revision, hash: row.hash })) };
out({ read, historical: take(readGaps(store, read)), current: take(prepareCurrentGaps(store, read)) });`) as { read: GapReadRequest; historical: Json; current: Json };
  const frameAbsence = [{ id: 'om-frame:garden:2', absent: true }, { id: 'om-frame:garden:3', absent: true }];
  const check = (store: Store, label: string) => {
    for (const round of ["cold", "warm"]) withHistoricalReads(() => {
      sameButReferences(delivered(readGaps(store, old.read)), old.historical, `${label} ${round}: historical`);
      const current = delivered(prepareCurrentGaps(store, old.read));
      const added = current.guards.filter(guard => frameAbsence.some(absent => canonical(guard) === canonical(absent)));
      assert.deepEqual(added, frameAbsence);
      sameButReferences({ ...current, guards: current.guards.filter(guard =>
        !frameAbsence.some(absent => canonical(guard) === canonical(absent))) }, old.current, `${label} ${round}: current admission`);
    });
  };
  check(f.store, "open");
  const reopened = new Store(f.database);
  t.after(() => reopened.close());
  check(reopened, "reopened");
  const current = delivered(prepareCurrentGaps(reopened, old.read));
  for (const absent of frameAbsence) {
    const saved = await reopened.snapshot(join(root, `frame-absence-${absent.id.split(':').at(-1)}`));
    const competing = new Store(saved.path);
    try {
      competing.write({ id: absent.id, kind: 'connection-frame', expected: 0, value: {} });
      const beforeRace = revisions(competing);
      const result = writeGuarded(competing, { unit: 'M5-neighbor', target: 'garden', guards: current.guards,
        writes: [{ id: 'fix-c:gap-result', kind: 'gap-result', expected: 0, value: {} },
          { id: 'fix-c:neighbor', kind: 'neighbor', expected: 0, value: {} }] });
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, 'input_stale');
      assert.equal(result.refusal.at.target, absent.id);
      assert.equal(competing.get('fix-c:gap-result'), null);
      assert.equal(competing.get('fix-c:neighbor'), null);
      assert.deepEqual(revisions(competing), beforeRace);
    } finally { competing.close(); }
  }
});

// ---- AT1 door (№4105 п.1, п.3): a readiness question names its saved G5 and is addressed to an accepted place ----
function readiness(consumer = "garden-produce-operation"): SourceQuestion {
  const cause: ReadinessCause = { contract: READINESS_CONTRACT, cause: "transition", snapshot: { commit: "a".repeat(40), tree: "b".repeat(40) },
    file: "test/loader.test.ts", line: 2, kind: "dynamic-import", expression: "import(name)", site: { start: 40, end: 52, hash: "h".repeat(64) },
    candidates: ["src/garden.ts"], works: ["garden-produce-work"], places: [consumer] };
  return { id: readinessQuestionId(cause, consumer), question: "Which files of the snapshot can import(name) load?", consumer, kind: "repository-fact",
    blocks: true, source: fakeRef("om-atomic-gate:garden:refused"), moment: "om-pass", readiness: cause };
}
test("AT1 door: a readiness question is a blocking repository fact of the block above its work, its source the saved G5 — never a stage; a forged one is refused", () => {
  const source = sources();
  source.inputResult.input!.questions.push(readiness()); stamp(source);
  const collected = collectGaps(source);
  assert.deepEqual(collected.refusals, []);
  const gap = collected.gaps.find(row => row.target === readiness().id)!;
  assert.deepEqual([gap.code, gap.field, gap.kind, gap.routes, gap.moment, gap.blocking, gap.consumers, gap.evidence[0]!.source],
    ["predecessor_question", "answer", "repository-fact", ["code", "research"], "om-pass", true, ["garden-produce-block"], fakeRef("om-atomic-gate:garden:refused")]);
  const forged: [string, (question: SourceQuestion) => void][] = [
    ["another identity", question => { question.id = "readiness:transition:other"; }],
    ["a stage source", question => { question.source = fakeRef("stage:garden:features"); }],
    ["another kind", question => { question.kind = "design-decision"; }],
    ["not blocking", question => { question.blocks = false; }],
    ["a cause without works", question => { question.readiness!.works = []; }],
  ];
  // Return №4186 P1: a transition is one question of its snapshot — its identity holds no consumer, it is placed once for all works.
  assert.equal(readinessQuestionId(readiness().readiness!, "garden-consume-operation"), readiness().id);
  // Return №4197: the one question is a gap of the block of every place its works stand in; its consumer is one of them.
  const shared = sources(), both = readiness();
  (both.readiness as { places: string[] }).places = ["garden-later-operation", "garden-produce-operation"];
  shared.inputResult.input!.questions.push(both); stamp(shared);
  const sharedGap = collectGaps(shared).gaps.find(row => row.target === both.id)!;
  assert.deepEqual([...sharedGap.consumers].sort(), ["garden-later-block", "garden-produce-block"]);
  const outside = sources(), stray = readiness();
  (stray.readiness as { places: string[] }).places = ["garden-later-operation"];
  outside.inputResult.input!.questions.push(stray); stamp(outside);
  assert.equal(hasCode(collectGaps(outside), "gap_source_missing").at.target, stray.id, "the consumer is one of its places");
  for (const [label, change] of forged) {
    const changed = sources(), asked = readiness(); change(asked);
    changed.inputResult.input!.questions.push(asked); stamp(changed);
    const result = collectGaps(changed);
    assert.equal(hasCode(result, "gap_source_missing").at.target, asked.id, label);
    assert.equal(result.gaps.some(row => row.target === asked.id), false, label);
  }
});
test("AT1 policy (№4117): a policy question is an owner decision asked at its producer — blocking for the producer's block, its source the saved G5; another kind or a moved producer is refused", () => {
  const cause: ReadinessCause = { contract: READINESS_CONTRACT, cause: "policy", policy: "appearance", producer: "garden-produce-block",
    governs: { contract: "garden-contract", hash: "h".repeat(64) }, works: ["garden-produce-work"] };
  const asked = (): SourceQuestion => ({ id: readinessQuestionId(cause, "garden-produce-block"), question: "How does the state appear?", consumer: "garden-produce-block",
    kind: "owner-decision", blocks: true, source: fakeRef("om-atomic-gate:garden:refused"), moment: "om-pass", readiness: structuredClone(cause) });
  const source = sources();
  source.inputResult.input!.questions.push(asked()); stamp(source);
  const collected = collectGaps(source);
  assert.deepEqual(collected.refusals, []);
  const gap = collected.gaps.find(row => row.target === asked().id)!;
  assert.deepEqual([gap.code, gap.kind, gap.routes, gap.blocking, gap.consumers], ["predecessor_question", "owner-decision", ["owner"], true, ["garden-produce-block"]]);
  for (const [label, change] of [
    ["a fact kind", (question: SourceQuestion) => { question.kind = "repository-fact"; }],
    ["another producer", (question: SourceQuestion) => { (question.readiness as { producer: string }).producer = "garden-consume-block"; }],
    ["an unknown policy", (question: SourceQuestion) => { (question.readiness as { policy: string }).policy = "rollback"; }],
    ["another contract", (question: SourceQuestion) => { (question.readiness as { governs: { contract: string } }).governs.contract = "other-contract"; }],
    ["no contract", (question: SourceQuestion) => { delete (question.readiness as { governs?: unknown }).governs; }],
  ] as const) {
    const changed = sources(), question = asked(); change(question);
    changed.inputResult.input!.questions.push(question); stamp(changed);
    assert.equal(hasCode(collectGaps(changed), "gap_source_missing").at.target, question.id, label);
  }
});

test("RL3 (№4205): a works frame request carries a reopening only over an accepted L3 frame, as its exact record and its works sorted and distinct; any other form is an invalid request before any derivation", () => {
  const graph = sources().graph, works = frameOf(graph, 3), operations = frameOf(graph, 2);
  const record = fakeRef("om-l3-reopen:garden");
  const naming = (read: FrameRead, reopen: unknown, frame = read.request.frame): FrameRead =>
    ({ ...read, request: { ...read.request, frame, reopen } as FrameRead["request"] });
  const invalid = (read: FrameRead) => assert.throws(() => applyProposals(read, []), (error: unknown) => error instanceof EngineError
    && error.code === "proposal_request_invalid" && (error.details as { field: string }).field === "frame.reopen");
  // On L2, or on L3 with no accepted frame, a reopening has nothing to stand on.
  invalid(naming(operations, { record, works: ["garden-produce-work"] }));
  invalid(naming(works, { record, works: ["garden-produce-work"] }));
  // Over an accepted frame: the exact record and nonempty, sorted, distinct works — nothing else.
  const frame = fakeRef("om-frame:garden:3");
  for (const reopen of [null, {}, { record }, { record, works: [] }, { record, works: ["b", "a"] }, { record, works: ["a", "a"] }, { record, works: [" "] },
    { record: { id: record.id }, works: ["a"] }, { record, works: ["a"], findings: [] }]) invalid(naming(works, reopen, frame));
  // A well-formed one passes the form; the frame read must then agree with its accepted base, which this one does not hold.
  assert.equal(refusedAs(applyProposals(naming(works, { record, works: ["garden-consume-work"] }, frame), []), "proposal_invalid").at.field, "frame.accepted");
});

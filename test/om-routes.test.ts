import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Question } from "../src/discovery/discovery.js";
import { assessAnswer } from "../src/discovery/research-assessment.js";
import { LEVEL, type Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Write } from "../src/storage/store.js";
import { readOmInput, writeOmInput, type OmInput } from "../src/om/input.js";
import { inputDecisionWrite, writeAddressing, prepareApplyAnswer, writeApplyAnswer } from "../src/om/addressing.js";
import { mc1FieldSpec, writeMc1Question, writeAcceptedAnswer, prepareAcceptedAnswer, prepareAnswerTask, answerIndexId, type AnswerQuestionContract,
  prepareAcceptedAnswers, prepareAnswerSearch, type AnswerIndex,
  type Mc1QuestionRequest, type AnswerRequest } from "../src/om/accepted-answer.js";
import { writeHorizon } from "../src/om/horizon.js";
import { fillObligations, type FrameLevel, type FrameRead, type FrameScope } from "../src/om/frame-obligations.js";
import { applyProposals, openObligationsToGaps, type FrameGap } from "../src/om/frame-proposals.js";
import { collectGaps, gateGaps, writeGaps, type GapCollection, type GapSources, type SourceGap, type GapRequest } from "../src/om/gaps.js";
import type { OmResult, Refusal, Sealed } from "../src/om/refusal.js";
import { planGapRoutes, prepareRoutes, writeRoutes, readRoutes, type RoutesRecord, type RoutesRequest, type RouteCatalog, type RoutePlan } from "../src/om/routes.js";
import { writeGuarded } from "../src/om/refs.js";
import { prepareGapLines, writeGapLines, readGapLines, type GapLinesRequest } from "../src/om/gap-lines.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

const clone = structuredClone;
const ref = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const noAddresses = (): RouteCatalog => ({ paths: [], records: [] });
const normalize = <T>(items: readonly T[]) => [...items].sort((a, b) => canonical(a).localeCompare(canonical(b)));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function rejected(result: OmResult<unknown>, code: string): Refusal {
  if (result.ok) assert.fail(`Expected ${code}, received a route plan`);
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target);
  assert.ok(result.refusal.at.field || result.refusal.at.ref);
  return result.refusal;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "route_request_invalid");
  const details = error.details as { target?: unknown; field?: unknown } | null;
  assert.ok(details?.target && details.field);
  return true;
}
function source(): GapSources {
  const graph = gardenGraph("cross");
  const input: OmInput = {
    sources: UPSTREAM_STAGES.map(stage => ({ ...ref(`stage:garden:${stage}`), stage, contractVersion: 6 })),
    inventory: null, requirements: [{ id: "garden-R1", section: "garden-concept" }, { id: "garden-R2", section: "garden-concept" }],
    criteria: [], contracts: [], questions: [], features: [
      { index: 0, title: "Produce", outcome: "garden-data", behaviorIndexes: [0], requirementIds: ["garden-R1"], contracts: [] },
      { index: 1, title: "Consume", outcome: "garden-result", behaviorIndexes: [1], requirementIds: ["garden-R1"], contracts: [] },
      { index: 2, title: "Later", outcome: "garden-later", behaviorIndexes: [2], requirementIds: ["garden-R2"], contracts: [] },
    ], map: { nodes: graph.nodes.map(node => node.id), artifacts: graph.artifacts.map(item => item.id), connectors: graph.connectors.map(item => item.id) },
  };
  return { inputResult: { input, hash: hashJson(input), gaps: [], refusals: [] }, graph,
    frameGaps: { operations: [], works: [] }, horizon: { nodes: graph.nodes.filter(node => node.kind === "block").map(node => node.id) } };
}
function question(id: string, kind: OmInput["questions"][number]["kind"] = "repository-fact", consumer = "garden-consume-operation"): OmInput["questions"][number] {
  // Current upstream questions carry their deadline; D1 must not recover it from the kind.
  const moment = kind === "environment-confirmation" ? "task-start" : kind === "post-implementation-proof" ? "task-result" : "om-pass";
  return { id, question: `Resolve ${id}`, consumer, kind, blocks: false, moment, source: ref("stage:garden:features") };
}
function missing(code: string, target: string, field: string, consumer: SourceGap["consumer"]): SourceGap {
  return { code, target, field, consumer, message: `Resolve ${target}/${field}`, source: ref("stage:garden:concept") };
}
function inventoryMissing(): SourceGap {
  return { code: "inventory_missing", target: "repo-inventory", field: "inventory", source: null,
    consumer: { mechanism: "M6", uses: ["code-answer", "project-question-package"] }, message: "Repository inventory is unavailable" };
}
function collection(sources: GapSources): GapCollection {
  sources.inputResult.hash = hashJson(sources.inputResult.input);
  const result = collectGaps(sources);
  assert.deepEqual(result.refusals, []);
  assert.equal(gateGaps(result as GapCollection, sources).passed, true);
  return clone(result) as GapCollection;
}
function plan(sources: GapSources, catalog = noAddresses()): Sealed<RoutePlan> {
  return ok(planGapRoutes(collection(sources), sources, catalog));
}
function frameGaps(graph: Graph, level: FrameLevel): FrameGap[] {
  const { level: _level, ...projection } = projectGraph(graph, level === 2 ? 1 : 2);
  const upper = projection as Graph, nodes = upper.nodes.filter(node => LEVEL[node.kind] === level - 1).map(node => node.id);
  const scope: FrameScope = { nodes, excluded: [], hash: hashJson({ nodes: [...nodes].sort(), excluded: [] }) };
  const upperRef = ref(`graph-layer:garden:${level - 1}`);
  const frame: FrameRead = { request: { project: "garden", level, graph: ref("graph:garden"), horizon: ref("om-horizon:garden:choice"),
    layer: null, frame: null, upper: level === 2 ? null : { horizon: ref("om-horizon:garden:choice"), frame: ref("om-frame:garden:2") } },
    upper, upperRef, scope, accepted: null, references: [upperRef],
    result: clone(ok(fillObligations(upper, scope, null, upperRef, level))) as FrameRead["result"] };
  return clone(ok(openObligationsToGaps(frame, ok(applyProposals(frame, [])) as Parameters<typeof openObligationsToGaps>[1]))) as FrameGap[];
}
function frozen(value: unknown): boolean {
  return value === null || typeof value !== "object" || Object.isFrozen(value) && Object.values(value).every(frozen);
}

function routesFixture(t: TestContext, withEncoding = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-routes-")), path = join(root, "state.sqlite");
  let store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = "garden", block = "garden-produce-block", target = "discovery:output-format";
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "output-format",
      question: "Which output format does the repository support?", consumer: block,
      moment: "om-pass", blocksCurrentStage: false, resolution: "Read repository facts during OM" }, ...(withEncoding ? [{ id: "encoding",
        question: "Which encoding does the repository support?", consumer: "garden-consume-block",
        moment: "om-pass", blocksCurrentStage: false, resolution: "Read repository facts during OM" }] : [])];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions: [{ pending:
    clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target, field: "address", value: { consumer: block, kind: "repository-fact" } } })) as Write },
    ...(withEncoding ? [{ pending: clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] : [])] }));
  function gapsFor(inputRef: Ref) {
    const horizon = ok(writeHorizon(store, { project, input: inputRef, graph: reference(graph), refinement: null, available: {},
      choice: { choiceVersion: `routes-fixture-${inputRef.revision}`, features: [{ outcome: "garden-result" }], excluded: [] } }));
    const sources: GapRequest = { project, input: inputRef, graph: reference(graph), horizon: reference(horizon.gate),
      operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
      works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
    const gaps = ok(writeGaps(store, sources)), gap = gaps.records.find(row => row.value.gap.target === target)!;
    assert.equal(gap.value.gap.code, "predecessor_question"); assert.equal(gap.value.gap.kind, "repository-fact");
    assert.deepEqual(gap.value.gap.routes, ["code", "research"]);
    return { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference), gap };
  }
  const gaps = gapsFor(reference(input));
  const command = { executable: process.execPath, args: ["-e",
    `const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "routes-researcher", model: "fixture", effort: "high", command },
    reviewer: { actor: "routes-assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000 }, 0);
  writeFileSync(join(root, "answer.json"), JSON.stringify({ answer: "JSON" }));
  const source = engine.discovery.evidence.file(project, "answer-source", root, "answer.json", "application/json", 0);
  function issue(current = gaps, resultForm: Json = { type: "string" }, selected?: { pointers: string[]; values: Json[] }) {
    const currentInput = ok(readOmInput(store, project, current.sources.input));
    const requestContract: AnswerQuestionContract = { establishes: currentInput.value.input.questions.find(question => question.id === target)!.question,
      consumer: { blocks: [...current.gap.value.gap.consumers] },
      requirements: selected?.values ?? [clone(currentInput.value.input.contracts[0]!) as unknown as Json], resultForm };
    const draft = engine.discovery.create(project, "om-g2", "R1", block,
      [mc1FieldSpec({ input: current.sources.input, gap: reference(current.gap), contract: requestContract })], [current.sources.input, reference(current.gap)]);
    const issued = store.get<Question>(draft.value.questions[0]!)!;
    const request: Mc1QuestionRequest = { project, input: current.sources.input, gaps: { sources: current.sources, records: current.records },
      gap: reference(current.gap), contract: requestContract, requirements: (selected?.pointers ?? ["/contracts/0"]).map(pointer => ({ pointer })),
      engineQuestion: reference(issued), draft: reference(draft) };
    const question = ok(writeMc1Question(store, request));
    return { request, question, issued, draft };
  }
  async function answer(q = issue(), attempt: AnswerRequest["attempt"] = null, value: Json = "JSON") {
    const assessment = await assessAnswer(store, q.issued, { action: "answer", question: q.issued.id, value,
      citations: [{ source: reference(store.get(source.id)!), selector: { kind: "json-pointer", pointer: "/answer" } }] }, environment, root);
    const draft = engine.discovery.researched(q.issued.id, q.issued.revision, reference(assessment)), answered = store.get<Question>(q.issued.id)!;
    const request: AnswerRequest = { project, question: reference(q.question), answer: answered.value.answer!,
      answeredQuestion: reference(answered), draft: reference(draft), attempt };
    return { ...q, assessment, answered, answeredDraft: draft, request };
  }
  async function accept(q = issue(), value: Json = "JSON") {
    const result = await answer(q, null, value);
    return { ...result, accepted: ok(writeAcceptedAnswer(store, result.request)) };
  }
  function refreshInventory(value: Json = { projectId: project, paths: [] }) {
    const id = `repo-inventory:${project}`;
    const inventory = store.write({ id, kind: "repo-inventory", expected: store.get(id)?.revision ?? 0, value });
    const refreshed = ok(writeOmInput(store, { project, stages, expected: store.get(input.id)!.revision, inventory: reference(inventory) }));
    return { inventory, input: refreshed, gaps: gapsFor(reference(refreshed)) };
  }
  return { root, path, project, block, target, stages, input, graph, gaps, source, environment,
    get store() { return store; }, get engine() { return engine; }, issue, answer, accept, gapsFor, refreshInventory,
    restart() { store.close(); store = new Store(path); engine = new ProductEngine(store); } };
}

// OWN1 (№3711, №3713): an owner question of the pass is routed to the model (design, MC2) in the bypass; a later owner
// question keeps the owner route and no batch.
test("D4 retains the source-derived knowledge routes and resolution moments", () => {
  const sources = source();
  assert.ok(sources.inputResult.input!.sources.every(row => row.contractVersion === 6));
  const cases = [
    ["repository-fact", "research", "om-pass"], ["design-decision", "design", "om-pass"],
    ["owner-decision", "design", "om-pass"], ["environment-confirmation", "environment", "task-start"],
    ["post-implementation-proof", "task-result", "task-result"],
  ] as const;
  sources.inputResult.input!.questions = cases.map(([kind]) => question(kind, kind));
  sources.inputResult.input!.questions.push({ ...question("before-feasibility", "environment-confirmation"), moment: "feasibility" });
  sources.inputResult.input!.questions.push({ ...question("owner-later", "owner-decision"), moment: "feasibility" });
  const result = plan(sources);
  const owner = result.routes.find(item => item.target === "owner-decision")!;
  assert.deepEqual(result.batches.filter(batch => batch.items.some(entry => entry.gap === owner.gap)).map(batch => [batch.model, batch.task, batch.kind]),
    [["MC2", "input-field", "owner-decision"]]);
  const later = result.routes.find(item => item.target === "owner-later")!;
  assert.deepEqual([later.route, later.moment], ["owner", "feasibility"]);
  assert.equal(result.batches.some(batch => batch.items.some(entry => entry.gap === later.gap)), false);
  for (const [kind, route, moment] of cases) {
    const item = result.routes.find(item => item.target === kind)!;
    assert.ok(item);
    assert.equal(item.kind, kind);
    assert.equal(item.route, route);
    assert.equal(item.moment, moment);
    assert.equal(item.state, "pending");
    assert.deepEqual(item.consumers, ["garden-consume-block"]);
    if (["owner", "environment", "task-result"].includes(route))
      assert.equal(result.batches.some(batch => batch.items.some(entry => entry.gap === item.gap)), false);
  }
  assert.equal(result.routes.find(item => item.target === "before-feasibility")!.moment, "feasibility");
});

test("D4 distinguishes the code-only inventory gap from research fallback for ordinary facts", () => {
  for (const inventory of [null, ref("repo-inventory:garden")]) for (const catalog of [noAddresses(),
    { paths: ["src/format.ts"], records: [ref("source:garden:format")] }]) {
    const sources = source();
    sources.inputResult.input!.inventory = inventory;
    sources.inputResult.input!.questions = [question("format")];
    if (inventory === null) sources.inputResult.gaps.push(inventoryMissing());
    const result = plan(sources, catalog);
    const fact = result.routes.find(item => item.target === "format")!;
    assert.equal(fact.route, "research", "Addresses identify places to investigate, not a proven fact");
    assert.equal(fact.state, "pending");
    const mc1 = result.batches.filter(batch => batch.model === "MC1");
    assert.equal(mc1.length, 1);
    assert.deepEqual(mc1[0]!.items.map(item => item.gap), [fact.gap]);
    if (inventory === null) {
      const missing = result.routes.find(item => item.target === "repo-inventory")!;
      assert.equal(missing.route, "code");
      assert.equal(missing.state, "pending");
      assert.equal(result.batches.some(batch => batch.items.some(item => item.gap === missing.gap)), false);
    }
  }
});

test("D4 batches ordinary facts only by exact consumer sets without duplicating partially shared gaps", () => {
  const sources = source();
  sources.inputResult.input!.questions = [question("format", "repository-fact", "garden-produce-operation"),
    question("format", "repository-fact", "garden-consume-operation"), question("encoding")];
  const gaps = collection(sources), result = ok(planGapRoutes(gaps, sources, noAddresses()));
  assert.equal(gaps.gaps.length, 2);
  assert.equal(result.routes.length, 2);
  assert.equal(result.batches.length, 2, "[produce, consume] and [consume] are distinct consumer sets");
  for (const batch of result.batches) {
    assert.equal(batch.model, "MC1"); assert.equal(batch.task, "fact"); assert.equal(batch.kind, "repository-fact");
    assert.equal(batch.node, null); assert.equal(batch.level, null); assert.equal(batch.items.length, 1);
  }
  const items = result.batches.flatMap(batch => batch.items);
  assert.deepEqual(normalize(items.map(item => item.gap)), normalize(gaps.gaps.map(item => item.id)));
  assert.equal(new Set(items.map(item => item.gap)).size, 2);
  const format = items.find(item => item.target === "format")!;
  assert.equal(format.field, "answer");
  assert.deepEqual(format.consumers, ["garden-consume-block", "garden-produce-block"]);
  assert.ok(format.addresses.records.some(item => canonical(item) === canonical(ref("stage:garden:features"))));
});

test("D4 groups missing fields by their own class and keeps question addressing separate", () => {
  const sources = source();
  sources.inputResult.gaps = [
    missing("acceptance_kind_missing", "criterion-1", "checkKind", { requirement: "garden-R1" }),
    missing("acceptance_kind_missing", "criterion-2", "checkKind", { requirement: "garden-R1" }),
    missing("contract_node_unbound", "contract-1", "nodes", { features: [{ feature: 0 }] }),
    missing("contract_node_unbound", "contract-2", "nodes", { features: [{ feature: 1 }] }),
  ];
  sources.inputResult.input!.questions = [question("unaddressed-1", null), question("unaddressed-2", "repository-fact", "the team")];
  const result = plan(sources);
  assert.equal(result.routes.length, 6);
  assert.ok(result.routes.every(item => item.route === "design" && item.state === "pending"));
  assert.equal(result.batches.length, 4);
  assert.ok(result.batches.every(batch => batch.model === "MC2" && batch.task === "input-field"
    && batch.kind === "design-decision" && batch.node === null && batch.level === null));
  assert.deepEqual(normalize(result.batches.map(batch => normalize(batch.items.map(item => item.target)))),
    normalize([["criterion-1", "criterion-2"], ["contract-1"], ["contract-2"], ["unaddressed-1", "unaddressed-2"]]));
});

test("D4 gives MC2 a complete node-expansion batch for each upper node and level", () => {
  const sources = source();
  sources.frameGaps.operations = frameGaps(sources.graph, 2);
  sources.frameGaps.works = frameGaps(sources.graph, 3);
  const gaps = collection(sources), result = ok(planGapRoutes(gaps, sources, noAddresses()));
  const expected = new Map<string, string[]>();
  for (const frame of [...sources.frameGaps.operations, ...sources.frameGaps.works]) {
    const key = `${frame.question.level}:${frame.question.upper}`;
    expected.set(key, [...(expected.get(key) ?? []), gaps.gaps.find(gap => gap.target === frame.target)!.id]);
  }
  assert.equal(result.batches.length, expected.size);
  assert.ok([...expected.values()].some(ids => ids.length > 1), "Fixture must exercise grouping several obligations of one node");
  for (const batch of result.batches) {
    assert.equal(batch.model, "MC2"); assert.equal(batch.task, "node-expansion");
    assert.equal(batch.kind, "design-decision");
    const ids = expected.get(`${batch.level}:${batch.node}`);
    assert.ok(ids);
    assert.deepEqual(normalize(batch.items.map(item => item.gap)), normalize(ids));
    assert.ok(batch.items.every(item => item.field === "fill"));
  }
  assert.equal(new Set(result.batches.map(batch => batch.id)).size, result.batches.length);
});

test("D4 leaves out-of-horizon work deferred without MC batches and accepts an explicit empty set", () => {
  const sources = source();
  sources.inputResult.input!.questions = [question("format"), question("owner-choice", "owner-decision")];
  sources.inputResult.gaps = [missing("acceptance_kind_missing", "criterion", "checkKind", { requirement: "garden-R1" })];
  sources.frameGaps.operations = frameGaps(sources.graph, 2);
  sources.horizon.nodes = [];
  const deferred = plan(sources);
  assert.ok(deferred.routes.length > 0);
  assert.ok(deferred.routes.every(item => item.state === "deferred"));
  assert.deepEqual(deferred.batches, []);
  const inventory = source(); inventory.horizon.nodes = []; inventory.inputResult.gaps = [inventoryMissing()];
  assert.equal(plan(inventory).routes[0]!.state, "pending", "The inventory exception has no horizon deferral");
  assert.deepEqual(plan(source()), { routes: [], batches: [] });
});

test("D4 rebuilds classifications through D1 and refuses forged route, knowledge, code and deferral claims", () => {
  const sources = source(); sources.inputResult.input!.questions = [question("format")];
  const original = collection(sources), forgedRoute = clone(original);
  forgedRoute.gaps[0]!.routes = ["design"];
  rejected(planGapRoutes(forgedRoute, sources, noAddresses()), "answer_route_foreign");
  const cases: ((result: GapCollection) => void)[] = [
    result => { result.gaps[0]!.kind = "owner-decision"; },
    result => { result.gaps[0]!.code = "question_unaddressed"; },
    result => { result.gaps[0]!.moment = "task-result"; },
    result => { result.gaps[0]!.deferral = { reason: "outside_horizon", until: "horizon-entry", blocks: ["garden-consume-block"] }; },
  ];
  for (const mutate of cases) {
    const fake = clone(original); mutate(fake);
    const gate = gateGaps(fake, sources);
    assert.equal(gate.passed, false);
    const failure = rejected(planGapRoutes(fake, sources, noAddresses()), gate.findings[0]!.code);
    assert.deepEqual(failure, gate.findings[0], "D4 must retain D1's original address and reason");
  }
  sources.horizon.nodes = [];
  const inactive = collection(sources); delete inactive.gaps[0]!.deferral;
  const gate = gateGaps(inactive, sources);
  assert.ok(gate.codes.includes("gap_outside_horizon"));
  rejected(planGapRoutes(inactive, sources, noAddresses()), gate.findings[0]!.code);
});

test("D4 retains D1 refusals for invalid source knowledge and missing claimed gaps", () => {
  const sources = source(); sources.inputResult.input!.questions = [question("format")];
  const original = collection(sources);
  const omitted = clone(original); omitted.gaps = [];
  rejected(planGapRoutes(omitted, sources, noAddresses()), "gap_missing");
  sources.inputResult.input!.questions[0]!.kind = "unrecognized-knowledge";
  sources.inputResult.hash = hashJson(sources.inputResult.input);
  const bad = collectGaps(sources);
  assert.equal(bad.refusals[0]!.code, "gap_kind_unknown");
  rejected(planGapRoutes(bad as GapCollection, sources, noAddresses()), "gap_kind_unknown");
});

test("D4 requires explicit well-formed catalog and collection arrays", () => {
  const sources = source(), gaps = collection(sources);
  for (const catalog of [undefined, null, {}, { paths: [] }, { records: [] }, { paths: null, records: [] },
    { paths: "src/main.ts", records: [] }, { paths: [null], records: [] }, { paths: [""], records: [] },
    { paths: [], records: null }, { paths: [], records: [null] }, { paths: [], records: [{ id: "x" }] }])
    assert.throws(() => planGapRoutes(gaps, sources, catalog as RouteCatalog), malformed);
  for (const collection of [undefined, null, {}, { gaps: [] }, { gaps: [], refusals: null }])
    assert.throws(() => planGapRoutes(collection as GapCollection, sources, noAddresses()), malformed);
});

test("D4 canonicalizes batches and catalogs without losing multiplicity or mutating callers", () => {
  const sources = source(); sources.inputResult.input!.questions = [question("z-format"), question("a-encoding")];
  const gaps = collection(sources);
  const duplicated = ref("source:garden:catalog-entry");
  const catalog: RouteCatalog = { paths: ["src/z.ts", "src/a.ts", "src/a.ts"], records: [duplicated, ref("source:garden:other"), duplicated] };
  const before = canonical({ sources, gaps, catalog });
  const result = ok(planGapRoutes(gaps, sources, catalog));
  assert.equal(canonical({ sources, gaps, catalog }), before);
  assert.ok(frozen(result));
  for (const item of [...result.routes, ...result.batches.flatMap(batch => batch.items)]) {
    assert.deepEqual(item.addresses.paths, ["src/a.ts", "src/a.ts", "src/z.ts"]);
    assert.equal(item.addresses.records.filter(item => canonical(item) === canonical(duplicated)).length, 2);
    assert.ok(item.addresses.records.some(item => canonical(item) === canonical(ref("stage:garden:features"))));
  }
  const reorderedSources = clone(sources), reorderedGaps = clone(gaps), reorderedCatalog = clone(catalog);
  reorderedSources.inputResult.input!.questions.reverse();
  reorderedSources.inputResult.hash = hashJson(reorderedSources.inputResult.input);
  reorderedSources.horizon.nodes.reverse();
  reorderedGaps.gaps.reverse();
  reorderedCatalog.paths.reverse(); reorderedCatalog.records.reverse();
  assert.deepEqual(ok(planGapRoutes(reorderedGaps, reorderedSources, reorderedCatalog)), result);
  const snapshot = canonical(result);
  catalog.paths[0] = "caller-change"; catalog.records[0]!.hash = "f".repeat(64);
  sources.graph.nodes[0]!.title = "caller-change";
  sources.inputResult.input!.questions[0]!.question = "caller-change";
  gaps.gaps[0]!.consumers.push("caller-change");
  assert.equal(canonical(result), snapshot);
});

function requestFor(f: ReturnType<typeof routesFixture>, current = f.gaps, resultForm: Json = { type: 'string' }, previous: Ref | null = null): RoutesRequest {
  const tasks = current.records.map(ref => f.store.get<{ gap: { kind: string; code: string; deferral?: unknown } }>(ref.id, ref.revision)!)
    .filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral)
    .map(row => ok(prepareAnswerTask(f.store, { project: f.project, input: current.sources.input,
      gaps: { sources: current.sources, records: current.records }, gap: reference(row), requirements: [{ pointer: '/contracts/0' }], resultForm })));
  return { project: f.project, gaps: { sources: current.sources, records: current.records },
    tasks: tasks.map(task => task.writes.length ? { pending: clone(task.writes[0]!) } : { record: reference(task.record) }), catalog: noAddresses(), previous };
}
const snapshot = (store: Store) => store.list().map(reference);
function writePrepared(store: Store, prepared: ReturnType<typeof prepareRoutes>, neighbor = false) {
  const value = ok(prepared);
  return writeGuarded(store, { unit: 'test', target: value.record.id, writes: [...value.writes,
    ...(neighbor ? [{ id: 'neighbor:route', kind: 'neighbor', expected: 0, value: {} }] : [])], guards: value.guards });
}

test('D4 persists complete source-derived routes, producer tasks and an empty answer index in one transaction', t => {
  const f = routesFixture(t), request = requestFor(f);
  request.catalog = { paths: ['src/unrelated.ts'], records: [reference(f.source)] };
  const before = snapshot(f.store), native = f.store.list('question').length;
  const prepared = ok(prepareRoutes(f.store, request));
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(prepared.writes.map(write => write.kind).sort(), ['answer-index', 'answer-task', 'route-result']);
  const saved = ok(writeRoutes(f.store, request));
  const fact = saved.value.routes.find(route => route.target === f.target)!;
  assert.equal(fact.route, 'research'); assert.equal(fact.answer, null); assert.ok(fact.task);
  assert.deepEqual(fact.input, reference(f.input)); assert.deepEqual(fact.record, reference(f.gaps.gap));
  assert.equal(f.store.list('question').length, native, 'No engine question is issued merely to search for an old fact');
  assert.equal(saved.value.batches.filter(batch => batch.model === 'MC1').length, 1);
  assert.ok(fact.addresses.records.some(item => canonical(item) === canonical(reference(f.source))));
  assert.equal(saved.value.routes.find(route => route.target === 'repo-inventory')!.route, 'code');
  assert.equal(saved.value.searches.length, 1);
  assert.deepEqual(f.store.get<{ answers: Ref[] }>(saved.value.searches[0]!.index.id)!.value.answers, []);
  assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(saved) })).record, saved);
  const after = snapshot(f.store);
  assert.deepEqual(ok(writeRoutes(f.store, request)), saved); assert.deepEqual(snapshot(f.store), after);
  assert.equal(ok(prepareRoutes(f.store, request)).writes.length, 0);
  const counterfeitRepeat = clone(request);
  if (!('pending' in counterfeitRepeat.tasks[0]!)) assert.fail('This case exercises the original pending task delivery');
  counterfeitRepeat.tasks[0]!.pending.kind = 'source';
  rejected(writeRoutes(f.store, counterfeitRepeat), 'answer_question_invalid');
  assert.ok(frozen(saved));
});

test('D4 reuses D5 without inventory and after independent input refresh; unsupported P1 format preserves the fact', async t => {
  const f = routesFixture(t), accepted = await f.accept(), request = requestFor(f), native = f.store.list('question').length;
  const graph = reference(f.store.get(f.graph.id)!), input = reference(f.store.get(f.input.id)!);
  const first = ok(writeRoutes(f.store, request));
  assert.equal(first.value.routes.find(route => route.target === f.target)!.route, 'code');
  assert.deepEqual(first.value.routes.find(route => route.target === f.target)!.answer, reference(accepted.accepted));
  assert.equal(first.value.batches.some(batch => batch.model === 'MC1'), false);
  assert.deepEqual(reference(f.store.get(f.graph.id)!), graph); assert.deepEqual(reference(f.store.get(f.input.id)!), input);
  const refreshed = f.refreshInventory({ arbitrary: 'no P1 format yet' });
  const nextRequest = requestFor(f, refreshed.gaps), next = ok(writeRoutes(f.store, nextRequest));
  assert.equal(next.value.routes.find(route => route.target === f.target)!.route, 'code');
  assert.equal(next.value.batches.some(batch => batch.model === 'MC1'), false);
  assert.equal(next.value.routes.some(route => route.target === 'repo-inventory'), false);
  assert.equal(next.value.refusals[0]!.code, 'inventory_format_unsupported');
  assert.deepEqual(next.value.refusals[0]!.at.ref, reference(refreshed.inventory));
  assert.equal(next.value.refusals[0]!.at.unit, 'P1');
  assert.equal(f.store.list('question').length, native);
  assert.deepEqual(reference(f.store.get(f.input.id)!), reference(refreshed.input));
  assert.deepEqual(reference(f.store.get(f.graph.id)!), graph);
  f.restart();
  assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(first) })).record, first);
  assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(next) })).record, next);
  assert.deepEqual(ok(writeRoutes(f.store, nextRequest)), next);
});

test('D4 same target and field with only a changed result form cannot reuse the old accepted answer', async t => {
  const f = routesFixture(t); await f.accept();
  const original = requestFor(f), changed = requestFor(f, f.gaps, { type: 'string', enum: ['JSON', 'XML'] });
  const native = f.store.list('question').length;
  const a = ok(writeRoutes(f.store, original)), b = ok(writeRoutes(f.store, changed));
  assert.equal(a.value.routes.find(route => route.target === f.target)!.route, 'code');
  assert.equal(b.value.routes.find(route => route.target === f.target)!.route, 'research');
  assert.equal(b.value.routes.find(route => route.target === f.target)!.answer, null);
  assert.equal(b.value.batches.filter(batch => batch.model === 'MC1').length, 1);
  assert.equal(f.store.list('question').length, native);
  f.restart(); assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(b) })).record, b);
});

test('D4 captures changed evidence for research fallback and preserves the negative route historically', async t => {
  const f = routesFixture(t); await f.accept(); const request = requestFor(f), first = ok(writeRoutes(f.store, request));
  writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: 'XML' }));
  const nextRequest = { ...requestFor(f), previous: reference(first) }, before = snapshot(f.store);
  const prepared = ok(prepareRoutes(f.store, nextRequest));
  assert.deepEqual(snapshot(f.store), before);
  assert.ok(prepared.writes.some(write => write.kind === 'source'));
  const next = ok(writeRoutes(f.store, nextRequest));
  assert.equal(next.value.routes.find(route => route.target === f.target)!.route, 'research');
  const cause = next.value.searches[0]!.checks[0]!.invalidation;
  assert.ok(cause && cause.sources.length === 1);
  assert.equal(cause.sources[0]!.after.revision, f.source.revision + 1);
  assert.equal(f.store.get(f.source.id)!.revision, f.source.revision + 1);
  f.restart();
  assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(first) })).record, first);
  assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(next) })).record, next);
  assert.deepEqual(ok(writeRoutes(f.store, request)), first, 'Late delivery is historical, not permission to use stale evidence');
  const after = snapshot(f.store); assert.deepEqual(ok(writeRoutes(f.store, nextRequest)), next); assert.deepEqual(snapshot(f.store), after);
});

test('D4 first-index initialization races with D5 in both orders without partial routes, tasks or answers', async t => {
  for (const first of ['answer', 'route'] as const) {
    const f = routesFixture(t), answer = await f.answer(), request = requestFor(f);
    const routing = ok(prepareRoutes(f.store, request)), acceptance = ok(prepareAcceptedAnswer(f.store, answer.request));
    const winner = first === 'answer' ? acceptance : routing, loser = first === 'answer' ? routing : acceptance;
    ok(writeGuarded(f.store, { unit: 'test', target: winner.record.id, writes: winner.writes, guards: winner.guards }));
    const after = snapshot(f.store);
    rejected(writeGuarded(f.store, { unit: 'test', target: loser.record.id, writes: loser.writes, guards: loser.guards }), 'revision_conflict');
    assert.deepEqual(snapshot(f.store), after);
    assert.equal(f.store.get(loser.record.id), null);
    if (first === 'answer') {
      const routed = ok(writeRoutes(f.store, request));
      assert.equal(routed.value.routes.find(route => route.target === f.target)!.route, 'code');
    } else {
      ok(writeAcceptedAnswer(f.store, answer.request));
      assert.deepEqual(ok(writeRoutes(f.store, request)), routing.record);
      rejected(prepareRoutes(f.store, request), 'route_stale');
      const refreshed = ok(writeRoutes(f.store, { ...request, previous: reference(routing.record) }));
      assert.equal(refreshed.value.routes.find(route => route.target === f.target)!.route, 'code');
      f.restart();
      assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(routing.record) })).record, routing.record);
      assert.deepEqual(ok(writeRoutes(f.store, request)), routing.record);
    }
  }
});

test('D4 existing index guards reject newly accepted facts and also protect a reused empty write set', async t => {
  const f = routesFixture(t), answer = await f.answer(), request = requestFor(f), first = ok(writeRoutes(f.store, request));
  const successor = { ...request, previous: reference(first) }, prepared = prepareRoutes(f.store, successor);
  const reused = ok(prepareRoutes(f.store, request)); assert.deepEqual(reused.writes, []);
  const index = answerIndexId(f.project, f.target, 'answer');
  assert.ok(reused.guards.some(guard => guard.id === index));
  ok(writeAcceptedAnswer(f.store, answer.request));
  const before = snapshot(f.store);
  rejected(writePrepared(f.store, prepared, true), 'input_stale');
  rejected(writeGuarded(f.store, { unit: 'test', target: first.id,
    writes: [{ id: 'neighbor:reused', kind: 'neighbor', expected: 0, value: {} }], guards: reused.guards }), 'input_stale');
  assert.deepEqual(snapshot(f.store), before);
});

test('D4 common transaction guards producer tasks, input, D1, inventory and evidence sources', async t => {
  for (const kind of ['task', 'input', 'gap', 'inventory', 'source'] as const) {
    const f = routesFixture(t); await f.accept();
    const refreshed = kind === 'inventory' ? f.refreshInventory() : null;
    const request = requestFor(f, refreshed?.gaps ?? f.gaps), saved = ok(writeRoutes(f.store, request));
    const prepared = ok(prepareRoutes(f.store, { ...request, previous: reference(saved) }));
    const id = kind === 'task' ? saved.value.request.tasks[0]!.id : kind === 'input' ? f.input.id : kind === 'gap' ? f.gaps.gap.id
      : kind === 'inventory' ? refreshed!.inventory.id : f.source.id;
    const row = f.store.get(id)!;
    assert.ok(prepared.guards.some(guard => guard.id === id), kind);
    f.store.write({ id, kind: row.kind, expected: row.revision, value: row.value });
    const before = snapshot(f.store);
    rejected(writePrepared(f.store, { ok: true, value: prepared }, true), 'input_stale');
    assert.deepEqual(snapshot(f.store), before, kind);
  }
});

test('D4 refuses missing or foreign tasks, incomplete D1, forged hashes and imitated record content', { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, t => {
  const f = routesFixture(t), request = requestFor(f), before = snapshot(f.store);
  rejected(prepareRoutes(f.store, { ...request, tasks: [] }), 'route_task_missing');
  rejected(prepareRoutes(f.store, { ...request, tasks: [...request.tasks, ...request.tasks] }), 'route_task_invalid');
  rejected(prepareRoutes(f.store, { ...request, project: 'foreign' }), 'route_source_invalid');
  rejected(prepareRoutes(f.store, { ...request, gaps: { ...request.gaps, records: [] } }), 'gap_missing');
  const forged = clone(request); forged.gaps.records[0]!.hash = 'a'.repeat(64);
  rejected(prepareRoutes(f.store, forged), 'record_forged');
  const fakeTask = clone(request); fakeTask.tasks = [{ record: reference(f.source) }];
  rejected(prepareRoutes(f.store, fakeTask), 'record_foreign');
  const wrongAddress = { ...request, catalog: { paths: [], records: [{ ...reference(f.source), hash: 'a'.repeat(64) }] } };
  rejected(prepareRoutes(f.store, wrongAddress), 'record_forged');
  const absentAddress = { ...request, catalog: { paths: [], records: [ref('source:garden:absent')] } };
  rejected(prepareRoutes(f.store, absentAddress), 'record_missing');
  assert.deepEqual(snapshot(f.store), before);
  const saved = ok(writeRoutes(f.store, request));
  const corrupted = clone(saved.value) as RoutesRecord;
  corrupted.request.previous = reference(saved);
  corrupted.routes.find(route => route.target === f.target)!.route = 'code';
  const forgedRow = f.store.write({ id: `om-routes:${f.project}:${hashJson(corrupted.request)}`, kind: saved.kind, expected: 0, value: corrupted });
  rejected(readRoutes(f.store, { project: f.project, record: reference(forgedRow) }), 'route_record_invalid');
  assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(saved) })).record, saved);
});

test('D4 refuses conflicting applicable facts rather than selecting the first address', async t => {
  const f = routesFixture(t); await f.accept(); await f.accept(f.issue(), 'XML');
  const request = requestFor(f), before = snapshot(f.store);
  rejected(prepareRoutes(f.store, request), 'route_answer_ambiguous');
  rejected(writeRoutes(f.store, request), 'route_answer_ambiguous');
  assert.deepEqual(snapshot(f.store), before);
});

test('D4 shared historical proofs are unfolded once per operation and fresh source heads remain visible', async t => {
  const f = routesFixture(t), accepted = await f.accept(), request = requestFor(f);
  const saved = ok(writeRoutes(f.store, request));
  let reads = 0;
  const counted = new Proxy(f.store, { get(target, property) {
    if (property === 'get') return (id: string, revision?: number) => {
      if (id === accepted.accepted.id && revision === accepted.accepted.revision) reads += 1;
      return target.get(id, revision);
    };
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  ok(prepareRoutes(counted, request));
  assert.equal(reads, 1, 'Index, applicability and the repeated route share the accepted-answer proof');
  reads = 0; ok(prepareRoutes(counted, request)); assert.equal(reads, 1, 'The next external operation reads again');
  const head = f.store.get(f.source.id)!;
  f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
  rejected(prepareRoutes(counted, request), 'route_stale');
  const successor = ok(prepareRoutes(counted, { ...request, previous: reference(saved) }));
  assert.equal(successor.record.value.routes.find(route => route.target === f.target)!.route, 'research');
});

test('D4 requires explicit source arrays and preserves unexpected storage failures', t => {
  const f = routesFixture(t), request = requestFor(f);
  for (const field of ['project', 'gaps', 'tasks', 'catalog', 'previous'] as const) {
    const malformedRequest = clone(request) as unknown as Record<string, unknown>; delete malformedRequest[field];
    assert.throws(() => prepareRoutes(f.store, malformedRequest as unknown as RoutesRequest), malformed);
    assert.throws(() => writeRoutes(f.store, malformedRequest as unknown as RoutesRequest), malformed);
  }
  assert.throws(() => readRoutes(f.store, null as never), malformed);
  const failure = new TypeError('storage is unavailable');
  const broken = new Proxy(f.store, { get(target, property) {
    if (property === 'get') return () => { throw failure; };
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  assert.throws(() => prepareRoutes(broken, request), error => error === failure);
  assert.throws(() => writeRoutes(broken, request), error => error === failure);
});


test('D4 native batched D5 answers flow through routing, application and D2 closure with guarded index races and history', async t => {
  for (const initialIndex of ['absent', 'existing'] as const) for (const winner of ['answers', 'route'] as const) {
    await t.test(`${initialIndex} index, ${winner} commits first`, async t => {
      const f = routesFixture(t), prior = { sources: f.gaps.sources, records: f.gaps.records };
      const opened = ok(writeGapLines(f.store, { project: f.project, previous: null, pass: 1, gaps: prior, closures: [] }));
      const searchRequest = { project: f.project, target: f.target, field: 'answer' };
      const indexId = answerIndexId(f.project, f.target, 'answer');
      if (initialIndex === 'existing') {
        const empty = ok(prepareAnswerSearch(f.store, searchRequest));
        ok(writeGuarded(f.store, { unit: 'D4-test', target: indexId, writes: empty.writes, guards: empty.guards }));
      }
      const a = await f.answer(), b = await f.answer(), request = requestFor(f);
      const beforePreparation = snapshot(f.store);
      const answers = ok(prepareAcceptedAnswers(f.store, [a.request, b.request]));
      const routing = ok(prepareRoutes(f.store, request));
      assert.deepEqual(snapshot(f.store), beforePreparation);
      assert.equal(answers.records.length, 2);
      assert.equal(answers.writes.filter(write => write.kind === 'accepted-answer').length, 2);
      const indices = answers.writes.filter(write => write.id === indexId);
      assert.equal(indices.length, 1, 'One batch writes one final index for both answers of the same line');
      assert.equal(indices[0]!.expected, initialIndex === 'absent' ? 0 : 1);
      assert.equal((indices[0]!.value as AnswerIndex).answers.length, 2);
      for (const source of [reference(f.input), reference(f.source), a.request.answeredQuestion, b.request.answeredQuestion])
        assert.ok(answers.guards.some(guard => canonical(guard) === canonical(source)), `Acceptance guards ${source.id}`);
      if (initialIndex === 'existing')
        assert.ok(answers.guards.some(guard => canonical(guard) === canonical(reference(f.store.get(indexId)!))));

      // A pending acceptance is not an applied fact: the agreed sequence cannot close D2 early.
      if (initialIndex === 'absent' && winner === 'answers') {
        rejected(prepareApplyAnswer(f.store, { project: f.project, input: reference(f.input),
          answer: reference(answers.records[0]!), question: answers.records[0]!.value.request.question }), 'record_missing');
        rejected(writeGapLines(f.store, { project: f.project, previous: reference(opened), pass: 2,
          gaps: prior, closures: [clone(answers.closures[0]!)] }), 'closure_invalid');
        assert.deepEqual(snapshot(f.store), beforePreparation);
      }
      let negative: typeof routing.record | null = null;
      if (winner === 'answers') {
        ok(writeGuarded(f.store, { unit: 'D5', target: f.target, writes: answers.writes, guards: answers.guards }));
        const afterWinner = snapshot(f.store);
        rejected(writeGuarded(f.store, { unit: 'M6', target: routing.record.id, writes: routing.writes, guards: routing.guards }),
          initialIndex === 'absent' ? 'revision_conflict' : 'input_stale');
        assert.deepEqual(snapshot(f.store), afterWinner, 'The losing negative route leaves neither route nor task');
        assert.equal(f.store.get(routing.record.id), null);
        for (const write of routing.writes.filter(write => write.kind === 'answer-task')) assert.equal(f.store.get(write.id), null);
      } else {
        negative = ok(writeRoutes(f.store, request));
        assert.equal(negative.value.routes.find(route => route.target === f.target)!.route, 'research');
        if (initialIndex === 'absent') {
          const afterWinner = snapshot(f.store);
          rejected(writeGuarded(f.store, { unit: 'D5', target: f.target, writes: answers.writes, guards: answers.guards }), 'revision_conflict');
          assert.deepEqual(snapshot(f.store), afterWinner, 'The losing acceptance leaves neither of the pending answers');
          for (const answer of answers.records) assert.equal(f.store.get(answer.id), null);
          const retry = ok(prepareAcceptedAnswers(f.store, [a.request, b.request]));
          assert.equal(retry.writes.filter(write => write.id === indexId).length, 1);
          assert.equal(retry.writes.find(write => write.id === indexId)!.expected, 1);
          ok(writeGuarded(f.store, { unit: 'D5', target: f.target, writes: retry.writes, guards: retry.guards }));
        } else {
          // Reading an existing index does not advance it; a later legal acceptance can commit.
          ok(writeGuarded(f.store, { unit: 'D5', target: f.target, writes: answers.writes, guards: answers.guards }));
        }
        rejected(prepareRoutes(f.store, request), 'route_stale');
        assert.deepEqual(ok(writeRoutes(f.store, request)), negative, 'The exact old request remains a historical delivery');
      }

      const index = f.store.get<AnswerIndex>(indexId)!;
      assert.deepEqual(normalize(index.value.answers), normalize(answers.records.map(reference)));
      assert.equal(index.revision, initialIndex === 'existing' || winner === 'route' ? 2 : 1);
      const routeRequest: RoutesRequest = { ...request, previous: negative ? reference(negative) : null };
      const route = ok(writeRoutes(f.store, routeRequest));
      const selected = route.value.routes.find(row => row.target === f.target)!;
      assert.equal(selected.route, 'code'); assert.equal(selected.state, 'answered'); assert.ok(selected.answer);
      assert.equal(route.value.batches.some(batch => batch.model === 'MC1'), false);
      assert.equal(route.value.searches.find(search => search.gap === f.gaps.gap.value.gap.id)!.checks.length, 2);
      const chosen = answers.records.find(row => canonical(reference(row)) === canonical(selected.answer))!;
      assert.ok(chosen, 'D4 selects an exact answer from the two records committed together');
      const applyRequest = { project: f.project, input: reference(f.input), answer: reference(chosen), question: chosen.value.request.question };
      const applied = ok(writeApplyAnswer(f.store, applyRequest));
      assert.equal(applied.value.input.questions.some(question => question.id === f.target), false);
      assert.deepEqual(applied.value.input.facts!.find(fact => fact.question.id === f.target)!.answer, reference(chosen));
      const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(applied), graph: reference(f.graph),
        refinement: null, available: {}, choice: { choiceVersion: 'routed-answer-applied', features: [{ outcome: 'garden-result' }], excluded: [] } }));
      const sources: GapRequest = { ...f.gaps.sources, input: reference(applied), horizon: reference(horizon.gate),
        operations: { ...f.gaps.sources.operations, frame: { ...f.gaps.sources.operations.frame, horizon: reference(horizon.gate) } } };
      const complete = ok(writeGaps(f.store, sources));
      assert.ok(complete.records.length > 0, 'D1 still includes all other gaps');
      assert.equal(complete.records.some(row => row.value.gap.target === f.target), false);
      const current = { sources: structuredClone(complete.sources) as GapRequest, records: complete.records.map(reference) };
      const close: GapLinesRequest = { project: f.project, previous: reference(opened), pass: 2, gaps: current,
        closures: [{ id: f.gaps.gap.value.gap.id, reason: 'filled', basis: reference(chosen), acceptance: null,
          attempt: null, answer: { record: reference(chosen) } }] };
      const beforeClosure = snapshot(f.store), closure = ok(prepareGapLines(f.store, close));
      assert.deepEqual(snapshot(f.store), beforeClosure);
      assert.deepEqual(closure.writes.map(write => write.kind), ['gap-line']);
      rejected(prepareGapLines(f.store, { ...close, closures: [close.closures[0]!, close.closures[0]!] }), 'gap_line_duplicate');
      assert.deepEqual(snapshot(f.store), beforeClosure, 'Two closing bases cannot produce two closures of the same line');
      const closed = ok(writeGapLines(f.store, close)), line = closed.value.lines.find(line => line.target === f.target)!;
      assert.equal(line.status, 'closed'); assert.deepEqual(line.basis, reference(chosen));
      assert.deepEqual(f.store.get(indexId), index, 'D2 closes a saved answer and does not rewrite D5 acceptance');
      const afterClose = ok(writeRoutes(f.store, { project: f.project, gaps: current, tasks: [], catalog: noAddresses(), previous: reference(route) }));
      assert.equal(afterClose.value.routes.some(row => row.target === f.target), false);
      assert.equal(afterClose.value.batches.some(batch => batch.items.some(item => item.target === f.target)), false);
      const search = ok(prepareAnswerSearch(f.store, searchRequest));
      assert.deepEqual(search.record, index); assert.deepEqual(search.writes, []);
      assert.deepEqual(normalize(search.answers), normalize(answers.records.map(reference)));
      f.restart();
      if (negative) assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(negative) })).record, negative);
      for (const row of [route, afterClose]) assert.deepEqual(ok(readRoutes(f.store, { project: f.project, record: reference(row) })).record, row);
      assert.deepEqual(ok(readGapLines(f.store, { project: f.project, record: reference(opened) })), opened);
      assert.deepEqual(ok(readGapLines(f.store, { project: f.project, record: reference(closed) })), closed);
      const historical = snapshot(f.store);
      assert.deepEqual(ok(writeApplyAnswer(f.store, applyRequest)), applied);
      assert.deepEqual(ok(writeGapLines(f.store, close)), closed);
      assert.deepEqual(ok(writeRoutes(f.store, routeRequest)), route);
      assert.deepEqual(snapshot(f.store), historical);
    });
  }
});

test('D4 normalizes complete consumer sets for both small task kinds without merging partial intersections', () => {
  const sources = source();
  sources.inputResult.input!.questions = [
    question('format', 'repository-fact', 'garden-produce-operation'),
    question('format', 'repository-fact', 'garden-consume-operation'),
    question('encoding', 'repository-fact', 'garden-consume-operation'),
    question('encoding', 'repository-fact', 'garden-produce-operation'),
    question('single', 'repository-fact', 'garden-consume-operation'),
  ];
  sources.inputResult.gaps = [
    missing('contract_node_unbound', 'contract-both-a', 'nodes', { features: [{ feature: 0 }, { feature: 1 }] }),
    missing('contract_node_unbound', 'contract-both-b', 'nodes', { features: [{ feature: 1 }, { feature: 0 }] }),
    missing('contract_node_unbound', 'contract-single', 'nodes', { features: [{ feature: 1 }] }),
  ];
  const result = plan(sources);
  assert.deepEqual(normalize(result.batches.map(batch => normalize(batch.items.map(item => item.target)))),
    normalize([['encoding', 'format'], ['single'], ['contract-both-a', 'contract-both-b'], ['contract-single']]));
  const gapIds = result.batches.flatMap(batch => batch.items.map(item => item.gap));
  assert.equal(gapIds.length, 6); assert.equal(new Set(gapIds).size, 6);
  for (const batch of result.batches) assert.ok(batch.items.every(item => canonical(item.consumers) === canonical(batch.items[0]!.consumers)));
  const reordered = clone(sources);
  reordered.inputResult.input!.questions.reverse();
  reordered.inputResult.gaps.reverse();
  assert.deepEqual(plan(reordered), result, 'Permuting full producer consumer sets does not change grouping or batch identity');
});

test('LG22: the one routing era is block-input-v1 — old and absent grouping are typed refusals of the public exact reader', t => {
  const f = routesFixture(t, true), request = requestFor(f), prepared = ok(prepareRoutes(f.store, request));
  assert.equal(prepared.record.value.grouping, 'block-input-v1', 'The one birth era is block-input-v1');
  // The reviewer's probe (№6871): only block-input-v1 passes the reader — consumer-set-v1, the nameless task-v1 form
  // and an unknown name are all refused by their marker, never tried as another algorithm.
  const results: { grouping: string; ok: boolean; code: string | null }[] = [];
  for (const grouping of ['block-input-v1', 'consumer-set-v1', undefined, 'unknown-era'] as const) {
    const { grouping: _ignored, ...body } = clone(prepared.record.value);
    const value = { ...body, ...(grouping === undefined ? {} : { grouping }),
      request: { ...body.request, catalog: { paths: [String(grouping)], records: [] } } } as unknown as RoutesRecord;
    const saved = f.store.write({ id: `om-routes:${f.project}:${hashJson(value.request)}`, kind: prepared.record.kind, expected: 0, value });
    const read = readRoutes(f.store, { project: f.project, record: reference(saved) });
    results.push({ grouping: grouping ?? '<absent>', ok: read.ok, code: read.ok ? null : read.refusal.code });
  }
  assert.deepEqual(results.map(row => row.ok), [true, false, false, false]);
  assert.ok(results.slice(1).every(row => row.code === 'route_record_invalid'), 'Every other marker is the same typed refusal');
  // The saved record of another era at the request's own address is the same refusal of current admission —
  // never silently reclassified, and a successor over it is refused on its basis the same way.
  const oldEra = { ...clone(prepared.record.value), grouping: 'consumer-set-v1' as const };
  const old = f.store.write({ id: prepared.record.id, kind: prepared.record.kind, expected: 0, value: oldEra });
  const unchanged = snapshot(f.store);
  rejected(prepareRoutes(f.store, request), 'route_record_invalid');
  rejected(writeRoutes(f.store, request), 'route_record_invalid');
  rejected(writeRoutes(f.store, { ...request, previous: reference(old) }), 'route_record_invalid');
  assert.deepEqual(snapshot(f.store), unchanged, 'An old era is neither promoted nor succeeded');
  assert.deepEqual(f.store.get(old.id), old, 'The historical record is neither revised nor reclassified');
});

const BLOCK_FIELDS = ['nodes', 'state', 'checkKind'];
const blockInputBatches = (record: { batches: readonly { task: string; items: readonly { field: string }[] }[] }) =>
  record.batches.filter(batch => batch.task === 'input-field' && batch.items.every(item => BLOCK_FIELDS.includes(item.field)));
const fieldsOf = (record: Parameters<typeof blockInputBatches>[0]) =>
  normalize(blockInputBatches(record).map(batch => [...new Set(batch.items.map(item => item.field))].sort().join('+')));
/** The input decision D3 applies to today's B1 of the routes fixture, and the D1 over the B1 it makes. */
function decide(f: ReturnType<typeof routesFixture>, target: string, field: 'nodes' | 'state' | 'checkKind', value: Json) {
  const graph = reference(f.graph), input = reference(f.store.get(f.input.id)!);
  ok(writeAddressing(f.store, { project: f.project, input, graph, decisions: [{ pending: clone(inputDecisionWrite({
    project: f.project, input, graph, layers: [], decision: { target, field, value } })) as Write }] }));
  return f.gapsFor(reference(f.store.get(f.input.id)!));
}
const NODES: Json = ['garden-produce-block', 'garden-consume-block'];
const STATE: Json = { writer: 'garden-produce-block', authority: 'garden-user', rollback: 'garden-produce-block' };

test('LP7 rows 1, 2, 3, 6, 7, 8, 9: the block input fields of one complete consumer set are one batch — [a], [b] and [a, b] stay apart and order changes nothing; address, answer, deferred, facts and node expansion keep their rules', t => {
  const features = (...indexes: number[]): SourceGap['consumer'] => ({ features: indexes.map(feature => ({ feature })) });
  const blockInput = [
    missing('contract_node_unbound', 'contract-a', 'nodes', features(1)), missing('contract_node_unbound', 'contract-b', 'nodes', features(1)),
    missing('contract_boundary_prose', 'contract-a', 'state', features(1)), missing('acceptance_kind_missing', 'criterion-a', 'checkKind', features(1)),
    missing('contract_node_unbound', 'contract-p', 'nodes', features(0)), missing('acceptance_kind_missing', 'criterion-p', 'checkKind', features(0)),
    missing('contract_boundary_prose', 'contract-ab', 'state', features(0, 1)), missing('acceptance_kind_missing', 'criterion-ab', 'checkKind', features(1, 0)),
    // Row 8: the same fields of a block outside the horizon.
    missing('contract_node_unbound', 'contract-later', 'nodes', features(2)), missing('contract_boundary_prose', 'contract-later', 'state', features(2)),
  ];
  const sourcesWith = (gaps: readonly SourceGap[]) => {
    const sources = source();
    sources.inputResult.gaps = clone([...gaps]);
    sources.inputResult.input!.questions = [question('format'), question('unaddressed', 'design-decision', 'nowhere-node'), question('design', 'design-decision')];
    sources.frameGaps.operations = frameGaps(sources.graph, 2);
    sources.horizon.nodes = sources.horizon.nodes.filter(node => node !== 'garden-later-block');
    return sources;
  };
  const sources = sourcesWith(blockInput), result = plan(sources), gaps = collection(sources).gaps;
  const input = blockInputBatches(result) as RoutePlan['batches'];
  // Rows 1, 2: one batch per complete consumer set; every active item of the full D1 exactly once, as D1 states it.
  assert.deepEqual(normalize(input.map(batch => normalize(batch.items.map(item => `${item.target}/${item.field}`)))), normalize([
    normalize(['contract-a/nodes', 'contract-b/nodes', 'contract-a/state', 'criterion-a/checkKind']),
    normalize(['contract-p/nodes', 'criterion-p/checkKind']), normalize(['contract-ab/state', 'criterion-ab/checkKind'])]));
  assert.equal(new Set(input.map(batch => canonical(batch.items[0]!.consumers))).size, 3, '[a], [b] and [a, b] are three groups');
  for (const batch of input) assert.ok(batch.items.every(item => canonical(item.consumers) === canonical(batch.items[0]!.consumers)));
  const active = gaps.filter(gap => BLOCK_FIELDS.includes(gap.field) && !gap.deferral);
  assert.deepEqual(normalize(input.flatMap(batch => batch.items.map(item => item.gap))), normalize(active.map(gap => gap.id)));
  for (const item of input.flatMap(batch => batch.items)) {
    const gap = active.find(row => row.id === item.gap)!;
    assert.deepEqual([item.target, item.field, item.consumers], [gap.target, gap.field, [...gap.consumers].sort()]);
  }
  // Row 8: a deferred gap is no assignment, and it stays a deferred route.
  const deferred = gaps.filter(row => row.deferral);
  assert.deepEqual(normalize(deferred.filter(row => BLOCK_FIELDS.includes(row.field)).map(row => `${row.target}/${row.field}`)),
    ['contract-later/nodes', 'contract-later/state']);
  for (const gap of deferred) {
    assert.equal(result.batches.some(batch => batch.items.some(item => item.gap === gap.id)), false);
    assert.equal(result.routes.find(route => route.gap === gap.id)!.state, 'deferred');
  }
  // Rows 6, 7, 9: address, answer, facts and node expansion are the very batches of this D1 without block input.
  const others = (value: Sealed<RoutePlan>) => normalize(value.batches.filter(batch => !input.some(row => row.id === batch.id)
    && !(batch.task === 'input-field' && batch.items.every(item => BLOCK_FIELDS.includes(item.field)))));
  assert.deepEqual(others(result), others(plan(sourcesWith(blockInput.filter(gap => gap.target === 'contract-later')))));
  const address = result.batches.find(batch => batch.items.some(item => item.field === 'address'))!;
  assert.deepEqual([address.model, address.task, address.items.map(item => [item.field, item.consumers])], ['MC2', 'input-field', [['address', []]]],
    'M5 keeps its own address batch');
  const answer = result.batches.find(batch => batch.task === 'input-field' && batch.items.some(item => item.field === 'answer'))!;
  assert.deepEqual(answer.items.map(item => [item.field, item.consumers]), [['answer', ['garden-consume-block']]],
    'An answer without a producer never shares the input batch of its consumer set');
  assert.ok(result.batches.some(batch => batch.task === 'node-expansion') && result.batches.some(batch => batch.model === 'MC1'));
  // Row 3: rows, consumers and catalog in another order give the very same batches and ids.
  const reordered = sourcesWith([...blockInput].reverse().map(gap => {
    const consumer = gap.consumer as { features?: { feature: number }[] };
    return consumer.features ? { ...gap, consumer: { features: [...consumer.features].reverse() } } : gap;
  }));
  reordered.inputResult.input!.questions.reverse();
  const catalog = { paths: ['b.ts', 'a.ts'], records: [ref('source:garden:b'), ref('source:garden:a')] };
  assert.deepEqual(plan(reordered, catalog), plan(sources, { paths: [...catalog.paths].reverse(), records: [...catalog.records].reverse() }));
  // LG22: this joined plan is the one routing era — a record born of a real D1 is marked block-input-v1, nothing else.
  const f = routesFixture(t, true), born = ok(prepareRoutes(f.store, requestFor(f))).record;
  assert.equal(born.value.grouping, 'block-input-v1');
});

test('LP7 rows 4, 5 (LG22): a new record is always marked block-input-v1 — joining nothing keeps the marker, and no batch at all is an explicit empty', t => {
  const f = routesFixture(t, true);
  decide(f, 'garden-B1', 'nodes', NODES);
  // Row 4: checkKind alone is left for its consumer set — a one-field batch under the one routing era.
  const rest = decide(f, 'garden-B1', 'state', STATE), request = requestFor(f, rest), prepared = ok(prepareRoutes(f.store, request));
  assert.deepEqual([prepared.record.value.grouping, fieldsOf(prepared.record.value)], ['block-input-v1', ['checkKind']]);
  // Row 5: no block input at all — the same marker.
  const none = requestFor(f, decide(f, 'garden-R1#1', 'checkKind', 'test')), empty = ok(prepareRoutes(f.store, none));
  assert.deepEqual([empty.record.value.grouping, fieldsOf(empty.record.value)], ['block-input-v1', []]);
  const nothing = plan(source());
  assert.deepEqual([nothing.routes, nothing.batches], [[], []], 'An empty D1 plans an explicit empty, not an absence');
});

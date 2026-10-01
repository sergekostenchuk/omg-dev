import { fillObligations, prepareFrame, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import { writeCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { readLayerAcceptance } from "../src/om/layer-basis.js";
import { createOmFixture, refusedWith } from "./om-fixture.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision } from "../src/storage/store.js";
import { writeOmInput } from "../src/om/input.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { writeHorizon, prepareHorizonIssuance, writeHorizonIssuance, readHorizonIssuance,
  type HorizonRequest } from "../src/om/horizon.js";
import { beginAttempt, completeAttempt, openSeries, readSeriesAt, type RepairSeries } from "../src/om/series.js";
import { prepareSeriesTransition, writeSeriesTransition, readPreparedSeriesTransition, comparePreparedSeriesSlices,
  type PreparedSeriesTransitionRecord } from "../src/om/series-transition.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult, Sealed } from "../src/om/refusal.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { git } from "../src/runtime/environment.js";
import { receiptId, type ArtifactReceipt } from "../src/compiler/model.js";

const project = "garden", producer = "garden-produce-block", block = "garden-consume-block", independent = "garden-later-block";
const opaqueSlice = "legacy:opaque-subject", clone = structuredClone;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function rewrite<T>(store: Store, record: Revision<T>, value: T): Revision<T> {
  const database = new DatabaseSync(store.path), hash = hashJson(value);
  try {
    database.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    database.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?")
      .run(canonical(value), hash, record.id, record.revision);
  } finally { database.close(); }
  return { ...record, hash, value };
}
function frozen(value: unknown): boolean {
  return value === null || typeof value !== "object" || Object.isFrozen(value) && Object.values(value).every(frozen);
}
class ExactOnlyStore extends Store {
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    assert.notEqual(revision, undefined, `Historical preparation may not select the current head of ${id}`);
    return super.get<T>(id, revision);
  }
  override list<T = Json>(_kind?: string): Revision<T>[] { assert.fail("Historical preparation may not enumerate today's records"); }
}
function fixture(t: TestContext, change: (graph: Graph) => void = () => {}, includeLater = false, addressing = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-series-transition-")), path = join(root, "state.sqlite");
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), source = gardenGraph();
  const { level: _level, ...upper } = projectGraph(source, 1);
  if (includeLater) {
    upper.requirements!.push({ ...clone(upper.requirements![0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    upper.nodes.find(node => node.id === independent)!.implements!.push("garden-R2");
  }
  change(upper as Graph);
  preparedFeatures(engine, project, upper as Graph, field => {
    const value = preparedField(project, field);
    if (addressing && field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "unaddressed",
      question: "Which consumer owns this question?", consumer: "unresolved-consumer", moment: "om-pass", blocksCurrentStage: false,
      resolution: "Address the question during OM" }];
    if (includeLater && field === "preparation") {
      const rows = (value as Record<string, Json>).outcomes as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), id: "garden-later", result: "The later result" });
    }
    if (includeLater && field === "conceptSections") {
      const rows = (value as { requirements: Record<string, Json>[] }[])[0]!.requirements;
      rows.push({ ...clone(rows[0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    }
    if (includeLater && field === "operationRequirements") {
      const body = value as Record<string, Json>, rows = body.outcomes as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), outcome: "garden-later" });
      (body.conceptCoverage as Json[]).push({ requirement: "garden-R2", outcome: "garden-later" });
    }
    if (includeLater && field === "behaviorContracts") {
      const rows = value as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), id: "garden-B2", requirements: ["garden-R2"], outcome: "garden-later" });
    }
    if (includeLater && (field === "features" || field === "featurePreparation")) {
      const rows = value as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), [field === "features" ? "title" : "featureTitle"]: "Deliver later result", outcome: "garden-later",
        ...(field === "featurePreparation" ? { requirements: ["garden-R2"], behaviorContracts: ["garden-B2"] } : {}) });
    }
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
    reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const horizon = (version: string, extra: Partial<HorizonRequest['choice']> = {}) => ok(writeHorizon(store, {
    project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: version, features: [{ outcome: "garden-result" }], excluded: [], ...extra },
  }));
  const series = (owner = block) => ok(openSeries(store, { project, block: owner, line: 1,
    slice: opaqueSlice, predecessor: null, basis: null }));
  return { root, path, input, graph, get store() { return store; }, horizon, series,
    restart() { store.close(); store = new Store(path); } };
}
function request(horizon: Ref, series: readonly Ref[], choiceVersion = "choice-1") {
  return { project, choiceVersion, horizon, series: [...series] };
}
function decision(record: Sealed<Revision<PreparedSeriesTransitionRecord>>, owner = block) {
  const found = record.value.decisions.find(item => item.block === owner);
  assert.ok(found, `Missing decision for ${owner}`);
  return found;
}
function stop(store: Store, owner = block) {
  let saved: Sealed<Revision<RepairSeries>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    ok(beginAttempt(store, { project, block: owner, line: 1, attempt,
      goal: { key: "produce-valid-result", questions: ["Which proposal fills the block?"], result: "accepted proposal" } }));
    saved = ok(completeAttempt(store, { project, block: owner, line: 1, attempt,
      outcome: { reason: "off-form", achieved: [], cancelled: [], refusals: [] } }));
  }
  assert.ok(saved?.value.stop);
  return saved;
}

test("prepared transition establishes an active legacy basis without changing its stopped series", t => {
  const f = fixture(t), horizon = f.horizon("choice-1");
  f.series(); const series = stop(f.store), before = snapshot(f.store);
  const prepared = ok(prepareSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  assert.deepEqual(snapshot(f.store), before, "Preparing P is read-only");
  const row = decision(prepared.record);
  assert.equal(prepared.record.value.contract, "om-series-transition/v1");
  assert.equal(prepared.record.value.state, "prepared");
  assert.equal(row.participation, "active");
  assert.equal(row.outcome, "establish-basis");
  assert.equal(row.previousSlice, opaqueSlice);
  assert.deepEqual(row.series, reference(series));
  assert.equal(row.slice?.contract, "series-slice/v1");
  assert.match(row.slice!.hash, /^[a-f0-9]{64}$/);
  assert.equal(prepared.record.hash, hashJson(prepared.record.value));
  assert.ok(frozen(prepared));
  const saved = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  assert.deepEqual(saved, prepared.record);
  assert.deepEqual(f.store.get(series.id), series);
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(series))), series);
  assert.deepEqual(ok(readPreparedSeriesTransition(f.store, { project, record: reference(saved) })).record, saved);
});

test("prepared participation retains excluded and unselected legacy lines without inventing active slices", t => {
  const f = fixture(t), a = f.series(), b = f.series(independent), c = f.series("garden-refusal-block");
  const horizon = f.horizon("choice-1", { excluded: [{ block: independent, reason: "Not selected", returnCondition: "Select later feature" }] });
  const before = [a, b, c].map(row => f.store.get(row.id));
  const prepared = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(c), reference(b), reference(a)])));
  assert.equal(decision(prepared).outcome, "establish-basis");
  for (const [owner, participation] of [[independent, "excluded"], ["garden-refusal-block", "unselected"]] as const) {
    const row = decision(prepared, owner);
    assert.equal(row.participation, participation); assert.equal(row.outcome, "inactive");
    assert.equal(row.slice, null); assert.equal(row.previousSlice, opaqueSlice);
  }
  assert.deepEqual([a, b, c].map(row => f.store.get(row.id)), before);
  const reverse = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(a), reference(b), reference(c)])));
  assert.deepEqual(reverse, prepared, "Only sets are normalized; caller ordering cannot create another P");
});

test("choice labels and independent exclusions do not change a proven active block slice", t => {
  const f = fixture(t), series = f.series();
  const first = f.horizon("choice-1"), second = f.horizon("choice-2", {
    excluded: [{ block: independent, reason: "Unrelated scope choice", returnCondition: "Select later feature" }],
  });
  const a = ok(writeSeriesTransition(f.store, request(reference(first.gate), [reference(series)])));
  const b = ok(writeSeriesTransition(f.store, request(reference(second.gate), [reference(series)], "choice-2")));
  assert.notDeepEqual(a.value.request.horizon, b.value.request.horizon);
  assert.deepEqual(decision(a).slice, decision(b).slice);
  assert.equal(ok(comparePreparedSeriesSlices(f.store, { project, previous: reference(a), next: reference(b), block })), "continue");
  assert.deepEqual(f.store.get(series.id), series, "Content comparison is not application or a new admission");
});

test("the local slice includes necessary providers but not other consumers of their shared connector", t => {
  const first = fixture(t), second = fixture(t, graph => {
    graph.nodes.find(node => node.id === independent)!.title = "A changed independent consumer";
    graph.nodes.find(node => node.id === independent)!.ports.push({ id: "second-in", direction: "in", contract: "garden-contract" });
    graph.connectors.find(connector => connector.id === "garden-flow")!.bindings[0]!.consumers.push({ node: independent, port: "second-in" });
  });
  const prepare = (f: ReturnType<typeof fixture>) => {
    const horizon = f.horizon("choice-1"), series = f.series();
    return ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  };
  const a = decision(prepare(first)), b = decision(prepare(second));
  assert.deepEqual(a.slice, b.slice);
  const text = canonical(a.slice!.body);
  assert.ok(text.includes(producer)); assert.ok(text.includes(block));
  assert.equal(text.includes("second-in"), false);
  assert.equal(text.includes("A changed independent consumer"), false);
});

test("local node and used schema changes alter the semantic slice while set ordering does not", t => {
  const base = fixture(t), reordered = fixture(t, graph => {
    graph.nodes.reverse(); graph.artifacts.reverse(); graph.contracts.reverse(); graph.connectors.reverse();
    for (const connector of graph.connectors) { connector.bindings.reverse(); for (const binding of connector.bindings) binding.consumers.reverse(); }
  });
  const title = fixture(t, graph => { graph.nodes.find(node => node.id === block)!.title += " changed"; });
  const schema = fixture(t, graph => { graph.contracts.find(contract => contract.id === "garden-contract")!.schema = { type: "string", minLength: 2 }; });
  const local = (f: ReturnType<typeof fixture>) => {
    const horizon = f.horizon("choice-1"), series = f.series();
    return decision(ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])))).slice;
  };
  const expected = local(base);
  assert.deepEqual(local(reordered), expected);
  assert.notDeepEqual(local(title), expected);
  assert.notDeepEqual(local(schema), expected);
});

test("a significant array order in a used schema is retained rather than normalized as a set", t => {
  const first = fixture(t, graph => { graph.contracts[0]!.schema = { type: "string", enum: ["first", "second"] }; });
  const second = fixture(t, graph => { graph.contracts[0]!.schema = { type: "string", enum: ["second", "first"] }; });
  const slice = (f: ReturnType<typeof fixture>) => {
    const h = f.horizon("choice-1"), s = f.series();
    return decision(ok(writeSeriesTransition(f.store, request(reference(h.gate), [reference(s)])))).slice;
  };
  assert.notDeepEqual(slice(first), slice(second));
});

test("a locally named test retains its full contract and the significant command argument order", t => {
  const withTest = (args: string[], resources = ["local-a", "local-b"]) => sharedAcceptedL2(t, graph => {
    const test = clone(gardenGraph().tests.find(item => item.node === "garden-consume-work")!);
    test.id = "garden-consume-operation-check"; test.node = "garden-consume-operation";
    test.command = { executable: "node", args }; test.covers = ["garden-flow"];
    test.contract!.resourceClass = "own_dirs"; test.contract!.resources = resources;
    const node = graph.nodes.find(node => node.id === test.node)!;
    node.code = clone(graph.nodes.find(node => node.id === "garden-consume-work")!.code);
    node.tests.push(test.id); graph.tests.push(test);
  });
  const first = withTest(["first", "second"]), second = withTest(["second", "first"]);
  const reordered = withTest(["first", "second"], ["local-b", "local-a"]);
  const slice = (f: ReturnType<typeof sharedAcceptedL2>) => decision(f.record).slice;
  const a = slice(first), b = slice(second);
  assert.notDeepEqual(a, b);
  assert.deepEqual(slice(reordered), a, "Declared resource sets are canonical, unlike command arguments");
  const body = a!.body as Record<string, Json>, selected = (body.tests as Record<string, Json>[])
    .find(item => item.id === "garden-consume-operation-check")!;
  assert.deepEqual(selected.command, { executable: "node", args: ["first", "second"] });
  assert.deepEqual(selected.contract, first.accepted.graph!.value.tests.find(item => item.id === selected.id)!.contract);
});

test("multiple incoming bindings retain their exact endpoint multiplicity without including independent consumers", t => {
  const f = fixture(t, graph => {
    const { level: _level, ...cross } = projectGraph(gardenGraph("cross"), 1); Object.assign(graph, cross);
  }), h = f.horizon("choice-1"), s = f.series();
  const row = decision(ok(writeSeriesTransition(f.store, request(reference(h.gate), [reference(s)]))));
  const body = row.slice!.body as Record<string, Json>;
  const flow = (body.connectors as Record<string, Json>[]).find(item => item.id === "garden-flow")!;
  const bindings = flow.bindings as { producer: { node: string; port: string }; consumers: { node: string; port: string }[] }[];
  assert.equal(bindings.length, 2);
  assert.equal(bindings.flatMap(binding => binding.consumers).length, 3);
  assert.ok(bindings.every(binding => binding.producer.node === producer && binding.consumers.every(consumer => consumer.node === block)));
  assert.deepEqual(bindings.map(binding => [binding.producer.port, binding.consumers.map(item => item.port).sort()]).sort(),
    [["out", ["in", "in-alt"]], ["out-alt", ["in"]]]);
});

test("P public inputs are explicit, an empty named series set is legal, and a mechanism cannot be treated as a block", t => {
  const f = fixture(t, () => {}, false, true), horizon = f.horizon("choice-1"), series = f.series();
  const given = request(reference(horizon.gate), [reference(series)]);
  const invalid = (action: () => unknown) => assert.throws(action,
    (error: unknown) => error instanceof EngineError && error.code === "series_transition_request_invalid");
  for (const key of ["project", "choiceVersion", "horizon", "series"] as const) {
    const missing = clone(given) as Record<string, unknown>; delete missing[key];
    invalid(() => prepareSeriesTransition(f.store, missing as typeof given));
    invalid(() => writeSeriesTransition(f.store, missing as typeof given));
    invalid(() => prepareSeriesTransition(f.store, { ...given, [key]: null }));
  }
  const empty = ok(writeSeriesTransition(f.store, { ...given, series: [] }));
  assert.deepEqual(empty.value.decisions, []);
  refusedWith(comparePreparedSeriesSlices(f.store, { project, previous: reference(empty), next: reference(empty), block }), "series_transition_unproven");
  invalid(() => readPreparedSeriesTransition(f.store, { project } as { project: string; record: Ref }));
  invalid(() => comparePreparedSeriesSlices(f.store, { project, previous: reference(empty), next: reference(empty) } as Parameters<typeof comparePreparedSeriesSlices>[1]));
  const sources: GapRequest = { project, input: reference(f.input), graph: reference(f.graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(f.graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(f.store, sources));
  const mechanism = ok(openSeries(f.store, { project, owner: { kind: "mechanism", mechanism: "M5:addressing" }, line: 1,
    predecessor: null, basis: null, scope: { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) } }));
  refusedWith(prepareSeriesTransition(f.store, { ...given, series: [reference(mechanism)] }), "series_transition_unproven");
  const next = ok(openSeries(f.store, { project, block, line: 2, slice: "legacy:successor", predecessor: reference(series),
    basis: { ground: "inputs-changed", text: "The legacy owner changed the subject" } }));
  refusedWith(prepareSeriesTransition(f.store, { ...given, series: [reference(series), reference(next)] }), "series_transition_unproven");
});

test("P carries graph, stage, input and evidence guards to the same final transaction", t => {
  for (const kind of ["graph", "stage", "input", "evidence"] as const) {
    const f = fixture(t), h = f.horizon("choice-1"), s = f.series();
    const prepared = ok(prepareSeriesTransition(f.store, request(reference(h.gate), [reference(s)])));
    const other = new Store(f.path), engine = new ProductEngine(other);
    try {
      if (kind === "graph") {
        const changed = clone(f.graph.value); changed.nodes.find(node => node.id === block)!.title += " revised";
        const next = engine.graphs.save(project, changed, f.graph.revision, "owner"); assert.notDeepEqual(reference(next), reference(f.graph));
      }
      if (kind === "stage") {
        const old = other.get<{ content: Json }>(`stage:${project}:features`)!;
        engine.pipeline.draft(project, "features", old.value.content, old.revision);
      }
      if (kind === "input") ok(writeAddressing(other, { project, input: reference(f.input), graph: reference(f.graph),
        decisions: [{ pending: clone(inputDecisionWrite({ project, input: reference(f.input), graph: reference(f.graph), layers: [],
          decision: { target: "garden-B1", field: "nodes", value: [block] } })) }] }));
      if (kind === "evidence") {
        const old = other.get(`source:${project}:brief`)!;
        engine.discovery.evidence.document(project, "brief", "A changed owner brief", "text/plain", old.revision);
      }
    } finally { other.close(); }
    refusedWith(writeGuarded(f.store, { unit: "B3", target: prepared.record.id,
      writes: [...prepared.writes, { id: `neighbor:${kind}`, kind: "test", expected: 0, value: {} }], guards: prepared.guards }), "input_stale");
    assert.equal(f.store.get(prepared.record.id), null, kind); assert.equal(f.store.get(`neighbor:${kind}`), null, kind);
  }
});

test("prepared source CAS rejects a series changed by a second Store and writes no neighboring record", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const prepared = ok(prepareSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  const other = new Store(f.path);
  try { ok(beginAttempt(other, { project, block, line: 1, attempt: 1,
    goal: { key: "new-attempt", questions: ["Name the result"], result: "accepted proposal" } })); }
  finally { other.close(); }
  refusedWith(writeGuarded(f.store, { unit: "B3.0a", target: prepared.record.id,
    writes: [...prepared.writes, { id: "transition-neighbor", kind: "test", expected: 0, value: {} }], guards: prepared.guards }), "input_stale");
  assert.equal(f.store.get(prepared.record.id), null); assert.equal(f.store.get("transition-neighbor"), null);
});

test("prepared history remains exact after source heads advance and the Store is reopened", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const prepared = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  ok(beginAttempt(f.store, { project, block, line: 1, attempt: 1,
    goal: { key: "later-attempt", questions: ["Later question"], result: "accepted result" } }));
  const source = f.store.get(`source:${project}:brief`)!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(prepared) })).record, prepared); }
  finally { exact.close(); }
  assert.deepEqual(ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)]))), prepared);
});

test("prepared records require exact source references and rederive decisions instead of trusting saved hashes", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const valid = request(reference(horizon.gate), [reference(series)]), before = snapshot(f.store);
  const sources: [typeof valid, string][] = [
    [{ ...valid, horizon: { ...valid.horizon, hash: "0".repeat(64) } }, "record_forged"],
    [{ ...valid, horizon: { ...valid.horizon, revision: 900 } }, "record_missing"],
    [{ ...valid, horizon: { ...valid.horizon, id: "om-horizon:other:choice-1" } }, "record_foreign"],
    [{ ...valid, series: [{ ...reference(series), hash: "0".repeat(64) }] }, "record_forged"],
    [{ ...valid, series: [{ ...reference(series), revision: 900 }] }, "record_missing"],
    [{ ...valid, series: [reference(series), reference(series)] }, "series_transition_unproven"],
    [{ ...valid, choiceVersion: "another-choice" }, "series_transition_unproven"],
  ];
  for (const [source, code] of sources) refusedWith(prepareSeriesTransition(f.store, source), code);
  assert.deepEqual(snapshot(f.store), before);
  const saved = ok(writeSeriesTransition(f.store, valid));
  const mutations: ((value: Record<string, any>) => void)[] = [
    value => { delete value.contract; },
    value => { delete value.request; },
    value => { delete value.decisions; },
    value => { value.decisions = []; },
    value => { value.decisions[0].outcome = "continue"; },
    value => { value.decisions[0].slice.body = {}; value.decisions[0].slice.hash = hashJson({}); },
    value => { value.decisions[0].slice.hash = "0".repeat(64); },
    value => { value.decisions[0].previousSlice = "invented-legacy-subject"; },
    value => { value.decisions[0].participation = "boundary"; },
  ];
  for (const mutate of mutations) {
    const value = clone(saved.value) as Record<string, any>; mutate(value);
    const changed = rewrite(f.store, saved, value as PreparedSeriesTransitionRecord);
    refusedWith(readPreparedSeriesTransition(f.store, { project, record: reference(changed) }), "series_transition_unproven");
    f.restart();
    refusedWith(readPreparedSeriesTransition(f.store, { project, record: reference(changed) }), "series_transition_unproven");
    rewrite(f.store, saved, clone(saved.value) as PreparedSeriesTransitionRecord);
    assert.deepEqual(ok(readPreparedSeriesTransition(f.store, { project, record: reference(saved) })).record, saved);
  }
  f.restart();
  assert.deepEqual(ok(readPreparedSeriesTransition(f.store, { project, record: reference(saved) })).record, saved);
});

test("G2 issuance binds the saved P and accepted H without changing either source or any series", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const transition = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  const given = { project, choiceVersion: "choice-1", horizon: reference(horizon.gate), transition: reference(transition) };
  const before = snapshot(f.store), prepared = ok(prepareHorizonIssuance(f.store, given));
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(prepared.writes.length, 1); assert.equal(prepared.writes[0]!.kind, "om-horizon-issuance");
  assert.equal(prepared.record.value.state, "accepted"); assert.deepEqual(prepared.record.value.codes, []);
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(transition))));
  const saved = ok(writeHorizonIssuance(f.store, given));
  assert.deepEqual(saved, prepared.record);
  assert.deepEqual(snapshot(f.store).filter(row => row.head.id !== saved.id), before);
  assert.ok(frozen(saved)); assert.equal(saved.hash, hashJson(saved.value));
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readHorizonIssuance(exact, { project, record: reference(saved) })).record, saved); }
  finally { exact.close(); }
  assert.deepEqual(ok(writeHorizonIssuance(f.store, given)), saved);
});

test("G2 refuses incomplete, foreign and mismatched issuance sources and recomputes saved content", t => {
  const f = fixture(t), first = f.horizon("choice-1"), second = f.horizon("choice-2"), series = f.series();
  const transition = ok(writeSeriesTransition(f.store, request(reference(first.gate), [reference(series)])));
  const given = { project, choiceVersion: "choice-1", horizon: reference(first.gate), transition: reference(transition) };
  for (const field of ["project", "choiceVersion", "horizon", "transition"] as const) {
    const missing = clone(given) as Record<string, unknown>; delete missing[field];
    refusedWith(prepareHorizonIssuance(f.store, missing as typeof given), "horizon_issuance_request_invalid");
    refusedWith(writeHorizonIssuance(f.store, missing as typeof given), "horizon_issuance_request_invalid");
  }
  for (const change of [
    { ...given, choiceVersion: "choice-2", horizon: reference(second.gate) },
    { ...given, choiceVersion: "choice-2" },
  ]) refusedWith(prepareHorizonIssuance(f.store, change), "horizon_issuance_binding_invalid");
  for (const field of ["horizon", "transition"] as const) {
    refusedWith(prepareHorizonIssuance(f.store, { ...given, [field]: { ...given[field], revision: 900 } }), "record_missing");
    refusedWith(prepareHorizonIssuance(f.store, { ...given, [field]: { ...given[field], hash: "0".repeat(64) } }), "record_forged");
    refusedWith(prepareHorizonIssuance(f.store, { ...given, [field]: { ...given[field], id: `${field}:other` } }), "record_foreign");
  }
  const refusedHorizon = f.horizon("refused", { excluded: [{ block: producer, reason: "Excluded producer", returnCondition: "Select provider" }] });
  assert.equal(refusedHorizon.gate.value.state, "refused");
  refusedWith(prepareHorizonIssuance(f.store, { ...given, choiceVersion: "refused", horizon: reference(refusedHorizon.gate) }), "horizon_issuance_binding_invalid");
  const saved = ok(writeHorizonIssuance(f.store, given));
  for (const mutate of [
    (value: Record<string, any>) => { delete value.transition; },
    (value: Record<string, any>) => { delete value.contract; },
    (value: Record<string, any>) => { delete value.codes; },
    (value: Record<string, any>) => { value.codes = ["invented-result"]; },
    (value: Record<string, any>) => { value.state = "refused"; },
  ]) {
    const value = clone(saved.value) as Record<string, any>; mutate(value);
    const changed = rewrite(f.store, saved, value as typeof saved.value);
    refusedWith(readHorizonIssuance(f.store, { project, record: reference(changed) }), "horizon_issuance_record_invalid");
    f.restart();
    refusedWith(readHorizonIssuance(f.store, { project, record: reference(changed) }), "horizon_issuance_record_invalid");
    rewrite(f.store, saved, saved.value);
  }
});

test("G2 source and target CAS are atomic and old issuance keeps its exact prepared revision", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const transition = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  const given = { project, choiceVersion: "choice-1", horizon: reference(horizon.gate), transition: reference(transition) };
  const prepared = ok(prepareHorizonIssuance(f.store, given)), other = new Store(f.path);
  const saved = (() => { try { return ok(writeHorizonIssuance(other, given)); } finally { other.close(); } })();
  refusedWith(writeGuarded(f.store, { unit: "G2", target: saved.id, writes: [...prepared.writes,
    { id: "issuance-neighbor", kind: "test", expected: 0, value: {} }], guards: prepared.guards }), "revision_conflict");
  assert.equal(f.store.get("issuance-neighbor"), null);
  const next = f.horizon("next"), p = ok(writeSeriesTransition(f.store, request(reference(next.gate), [reference(series)], "next")));
  const pending = ok(prepareHorizonIssuance(f.store, { ...given, choiceVersion: "next", horizon: reference(next.gate), transition: reference(p) }));
  const competing = new Store(f.path);
  try {
    // This is a later unproved head, not a fabricated B3 application or managed-series admission.
    competing.write({ id: p.id, kind: p.kind, expected: p.revision, value: { state: "discarded", source: reference(p) } });
    competing.write({ id: transition.id, kind: transition.kind, expected: transition.revision, value: { state: "applied", source: reference(transition) } });
  } finally { competing.close(); }
  refusedWith(writeGuarded(f.store, { unit: "G2", target: pending.record.id, writes: [...pending.writes,
    { id: "issuance-neighbor", kind: "test", expected: 0, value: {} }], guards: pending.guards }), "input_stale");
  assert.equal(f.store.get(pending.record.id), null); assert.equal(f.store.get("issuance-neighbor"), null);
  refusedWith(prepareHorizonIssuance(f.store, given), "input_stale");
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readHorizonIssuance(exact, { project, record: reference(saved) })).record, saved); }
  finally { exact.close(); }
  assert.deepEqual(ok(writeHorizonIssuance(f.store, given)), saved);
  assert.deepEqual(f.store.get(series.id), series);
});

test("active exclusion and return preserve the last comparable active content without modifying the series", t => {
  const f = fixture(t, () => {}, true), series = f.series(independent);
  const active = f.horizon("active", { features: [{ outcome: "garden-result" }, { outcome: "garden-later" }] });
  const outside = f.horizon("outside", { excluded: [{ block: independent, reason: "Outside this delivery", returnCondition: "Select later feature" }] });
  const back = f.horizon("returned", { features: [{ outcome: "garden-later" }, { outcome: "garden-result" }] });
  const a = ok(writeSeriesTransition(f.store, request(reference(active.gate), [reference(series)], "active")));
  const b = ok(writeSeriesTransition(f.store, request(reference(outside.gate), [reference(series)], "outside")));
  const c = ok(writeSeriesTransition(f.store, request(reference(back.gate), [reference(series)], "returned")));
  assert.equal(decision(b, independent).slice, null);
  assert.equal(decision(b, independent).outcome, "inactive");
  assert.equal(decision(c, independent).outcome, "establish-basis", "Preparation alone does not activate a managed series");
  assert.equal(ok(comparePreparedSeriesSlices(f.store, { project, previous: reference(a), next: reference(c), block: independent })), "continue");
  refusedWith(comparePreparedSeriesSlices(f.store, { project, previous: reference(b), next: reference(c), block: independent }), "series_transition_unproven");
  assert.deepEqual(f.store.get(series.id), series);
});

test("the whole b1143aa producer leaves its stopped legacy series and exact B1 horizon bytes unchanged", t => {
  const base = "b1143aa7343db45896a134ee3cb3a273b211057e", root = mkdtempSync(join(tmpdir(), "omg-series-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const run = (executable: string, args: string[], cwd: string) => {
    const child = spawnSync(executable, args, { cwd, env: environment, encoding: "utf8", timeout: 90_000, maxBuffer: 20_000_000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `${executable} ${args.join(" ")}\n${child.stdout}\n${child.stderr}`);
    return child.stdout;
  };
  const repository = run("git", ["rev-parse", "--show-toplevel"], dirname(fileURLToPath(import.meta.url))).trim();
  const legacy = join(root, "base"), archive = join(root, "base.tar"); mkdirSync(legacy);
  run("git", ["archive", "--format=tar", "--output", archive, base], repository);
  run("tar", ["-xf", archive, "-C", legacy], root);
  symlinkSync(join(repository, "node_modules"), join(legacy, "node_modules"), "dir");
  writeFileSync(join(legacy, "tsconfig.transition-history.json"), JSON.stringify({ extends: "./tsconfig.json",
    include: ["src/**/*.ts", "test/om-fixture.ts", "test/product-fixture.ts"], exclude: [] }));
  run(process.execPath, [join(legacy, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.transition-history.json"], legacy);
  const path = join(root, "old.sqlite"), output = join(root, "old.json"), producerFile = join(legacy, "old-producer.mjs");
  writeFileSync(producerFile, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Store } from './dist/src/storage/store.js';
import { canonical } from './dist/src/canonical.js';
import { ProductEngine } from './dist/src/product/engine.js';
import { projectGraph } from './dist/src/graph/project.js';
import { reference } from './dist/src/pipeline/contracts.js';
import { UPSTREAM_STAGES } from './dist/src/discovery/requirements.js';
import { writeOmInput } from './dist/src/om/input.js';
import { writeHorizon } from './dist/src/om/horizon.js';
import { openSeries, beginAttempt, completeAttempt } from './dist/src/om/series.js';
import { preparedFeatures } from './dist/test/product-fixture.js';
import { gardenGraph } from './dist/test/om-fixture.js';
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const project = 'garden', block = 'garden-consume-block', store = new Store(process.argv[2]);
const { level, ...upper } = projectGraph(gardenGraph(), 1);
preparedFeatures(new ProductEngine(store), project, upper);
const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get('stage:'+project+':'+stage))]));
const input = ok(writeOmInput(store,{project,expected:0,stages}));
const graph = store.get('graph:'+project);
const horizon = ok(writeHorizon(store,{project,input:reference(input),graph:reference(graph),refinement:null,available:{},
 choice:{choiceVersion:'old-choice',features:[{outcome:'garden-result'}],excluded:[]}}));
let series = ok(openSeries(store,{project,block,line:1,slice:'legacy:opaque-subject',predecessor:null,basis:null}));
for(let attempt=1;attempt<=3;attempt++){
 ok(beginAttempt(store,{project,block,line:1,attempt,goal:{key:'legacy-question',questions:['Which proposal works?'],result:'accepted proposal'}}));
 series=ok(completeAttempt(store,{project,block,line:1,attempt,outcome:{reason:'off-form',achieved:[],cancelled:[],refusals:[]}}));
}
assert.ok(series.value.stop);
const rows=store.list().flatMap(row=>store.history(row.id));
writeFileSync(process.argv[3],JSON.stringify({input,horizon,series,rows,bytes:canonical(rows)}));store.close();
`);
  run(process.execPath, [producerFile, path, output], legacy);
  const previous = JSON.parse(readFileSync(output, "utf8")) as {
    input: Revision; horizon: { gate: Revision }; series: Revision<RepairSeries>; rows: Revision[]; bytes: string;
  };
  let store = new Store(path);
  try {
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), previous.bytes);
    assert.deepEqual(ok(readSeriesAt(store, project, reference(previous.series))), previous.series);
    const saved = ok(writeSeriesTransition(store, request(reference(previous.horizon.gate), [reference(previous.series)], "old-choice")));
    assert.equal(decision(saved).outcome, "establish-basis");
    for (const row of previous.rows) assert.deepEqual(store.get(row.id, row.revision), row);
    store.close(); store = new Store(path);
    assert.deepEqual(ok(readPreparedSeriesTransition(store, { project, record: reference(saved) })).record, saved);
    assert.deepEqual(ok(readSeriesAt(store, project, reference(previous.series))), previous.series);
  } finally { store.close(); }
});

// Append below the existing fixture/request/decision helpers. No accepted records
// are fabricated: the proposal is accepted by the ordinary C3/C5 producers.
function sharedAcceptedL2(t: TestContext, change: (graph: Graph) => void = () => {}) {
  const f = fixture(t), graph = gardenGraph();
  change(graph);
  const initial = f.horizon("shared-l2-open"), series = f.series();
  const before = ok(writeSeriesTransition(f.store,
    request(reference(initial.gate), [reference(series)], "shared-l2-open")));
  const frame: FrameRequest = { project, level: 2, graph: reference(f.graph), horizon: reference(initial.gate),
    layer: null, frame: null, upper: null };
  const base = ok(prepareFrame(f.store, frame)), projected = projectGraph(graph, 2);
  // This pure mapping is only proposal construction, as in om-frame-accept.test.ts.
  const mapped = ok(fillObligations(base.upper as Graph, base.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, base.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: projected.nodes.filter(node => node.kind === "operation"),
    fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const offered = f.store.write({ id: "om-proposal:garden:shared-l2-slice", kind: "layer-proposal", expected: 0, value: proposal });
  const candidate = ok(writeCandidate(f.store, { frame, proposals: [reference(offered)] }));
  assert.equal(candidate.state, "candidate");
  if (candidate.state !== "candidate") assert.fail("The genuine shared L2 proposal must form a candidate");
  const candidateRef = reference(candidate.record);
  const accepted = ok(settleCandidate(f.store, { project, level: 2, candidate: candidateRef,
    outcome: { gate: "G3", candidate: candidateRef, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  assert.ok(accepted.graph && accepted.layer && accepted.frame);
  assert.equal(ok(readLayerAcceptance(f.store, { project, level: 2,
    graph: reference(accepted.graph), layer: reference(accepted.layer) })).producer, "om");
  const horizon = ok(writeHorizon(f.store, { project, input: reference(f.input), graph: reference(accepted.graph),
    refinement: reference(accepted.layer), available: {},
    choice: { choiceVersion: "shared-l2-accepted", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const record = ok(writeSeriesTransition(f.store,
    request(reference(horizon.gate), [reference(series)], "shared-l2-accepted")));
  return { f, before, record, accepted, horizon };
}

test("accepted shared L2 frame changes for independent C without changing B while local B refinement changes its slice", t => {
  const base = sharedAcceptedL2(t);
  const changedC = sharedAcceptedL2(t, graph => {
    graph.nodes.find(node => node.id === "garden-later-operation")!.title = "Independent C operation changed";
  });
  const changedB = sharedAcceptedL2(t, graph => {
    graph.nodes.find(node => node.id === "garden-consume-operation")!.title = "Local B operation changed";
  });
  assert.notEqual(base.accepted.graph!.hash, changedC.accepted.graph!.hash);
  assert.notEqual(base.accepted.layer!.hash, changedC.accepted.layer!.hash);
  assert.notEqual(base.accepted.frame!.hash, changedC.accepted.frame!.hash,
    "The unrelated edit must actually change the shared accepted frame source");
  assert.deepEqual(decision(base.record).slice, decision(changedC.record).slice,
    "A common graph/layer/frame hash is evidence identity, not B's local semantic content");
  assert.notDeepEqual(decision(base.record).slice, decision(changedB.record).slice,
    "A real accepted change to B's operation must change both local body and hash");
  assert.ok(canonical(decision(base.record).slice!.body).includes("garden-consume-operation"));
  assert.equal(canonical(decision(changedC.record).slice!.body).includes("Independent C operation changed"), false);
  assert.equal(ok(comparePreparedSeriesSlices(base.f.store, { project,
    previous: reference(base.before), next: reference(base.record), block })), "new-work",
  "Newly accepted L2 disclosure differs from the proved no-L2 basis in the same history");
  assert.deepEqual(ok(readPreparedSeriesTransition(base.f.store,
    { project, record: reference(base.before) })).record, base.before,
  "The earlier exact graph/horizon remains readable after C5 changes their heads");
});

test("boundary slices ignore unrelated real receipt revisions but bind consumed receipts and preserve a stopped supplier", async t => {
  const f = await createOmFixture(t), store = f.store;
  const input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const consumerSeries = ok(openSeries(store, { project, block, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  ok(openSeries(store, { project, block: producer, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  const supplierSeries = stop(store, producer), series = [reference(consumerSeries), reference(supplierSeries)];
  const data = f.receipts["garden-data"]!, extra = f.receipts["garden-prep"]!;
  assert.ok(data.value.run && extra.value.run, "Both receipts come from real fixture execution");
  const preparedAt = (version: string, dataRef: Ref, extraRef: Ref) => {
    const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(f.graphRevision),
      refinement: reference(store.get("phase:garden:L2")!),
      choice: { choiceVersion: version, features: [{ outcome: "garden-result" }], excluded: [] },
      available: { [producer]: { "garden-data": dataRef, "garden-prep": extraRef } } }));
    assert.deepEqual(horizon.horizon.value.result.horizon.nodes, [block]);
    assert.deepEqual(horizon.horizon.value.result.horizon.boundary,
      [{ block: producer, basis: { "garden-data": dataRef, "garden-prep": extraRef } }]);
    return { horizon, record: ok(writeSeriesTransition(store, request(reference(horizon.gate), series, version))) };
  };
  const first = preparedAt("boundary-receipts-1", reference(data), reference(extra));
  // A new exact revision of genuine bytes tests Ref semantics, not a claim of new execution.
  const nextExtra = store.write({ id: extra.id, kind: extra.kind, expected: extra.revision, value: extra.value });
  const unrelated = preparedAt("boundary-receipts-2", reference(data), reference(nextExtra));
  assert.notEqual(first.horizon.horizon.hash, unrelated.horizon.horizon.hash);
  assert.deepEqual(decision(first.record).slice, decision(unrelated.record).slice);
  assert.equal(ok(comparePreparedSeriesSlices(store, { project,
    previous: reference(first.record), next: reference(unrelated.record), block })), "continue");
  assert.equal(canonical(decision(first.record).slice!.body).includes(extra.id), false,
    "The supplier's unconsumed prep receipt is not part of B's subject");
  const nextData = store.write({ id: data.id, kind: data.kind, expected: data.revision, value: data.value });
  const consumed = preparedAt("boundary-receipts-3", reference(nextData), reference(nextExtra));
  assert.notDeepEqual(decision(unrelated.record).slice, decision(consumed.record).slice);
  assert.equal(ok(comparePreparedSeriesSlices(store, { project,
    previous: reference(unrelated.record), next: reference(consumed.record), block })), "new-work");
  for (const item of [first, unrelated, consumed]) {
    const boundaryDecision = decision(item.record, producer);
    assert.equal(boundaryDecision.participation, "boundary");
    assert.equal(boundaryDecision.outcome, "inactive");
    assert.equal(boundaryDecision.slice, null);
    assert.equal(boundaryDecision.previousSlice, opaqueSlice);
    assert.deepEqual(boundaryDecision.series, reference(supplierSeries));
  }
  assert.deepEqual(store.get(supplierSeries.id), supplierSeries,
    "Boundary participation does not reset the supplier's stop, ladder or no-progress history");
  assert.deepEqual(store.get(consumerSeries.id), consumerSeries);
  assert.deepEqual(ok(readPreparedSeriesTransition(store, { project, record: reference(first.record) })).record, first.record,
    "Historical P reads use the original receipt revisions after both receipt heads advance");
});

test("a separate provider flow to independent C changes neither B's frame obligations nor its slice", t => {
  const base = fixture(t), unrelated = fixture(t, graph => {
    const source = graph.connectors.find(item => item.id === "garden-flow")!;
    graph.connectors.push({ ...clone(source), id: "garden-independent-flow", bindings: [{
      level: 1, producer: { node: producer, port: "out" }, consumers: [{ node: independent, port: "in" }], anchor: null,
    }] });
  });
  const selected = fixture(t, graph => {
    const source = graph.connectors.find(item => item.id === "garden-flow")!;
    graph.connectors.push({ ...clone(source), id: "garden-local-flow", bindings: [{
      level: 1, producer: { node: producer, port: "out" }, consumers: [{ node: block, port: "in" }], anchor: null,
    }] });
  });
  const local = (f: ReturnType<typeof fixture>) => {
    const horizon = f.horizon("choice-1"), series = f.series();
    return decision(ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])))).slice!;
  };
  const expected = local(base), excluded = local(unrelated), added = local(selected);
  assert.deepEqual(excluded, expected, "Excluded producer-end obligations must not retain a separate unrelated flow");
  assert.equal(canonical(excluded.body).includes("garden-independent-flow"), false);
  assert.notDeepEqual(added, expected, "A second genuinely selected flow changes the block's subject");
  const oldBody = expected.body as Record<string, any>, nextBody = added.body as Record<string, any>;
  assert.equal(nextBody.connectors.length, oldBody.connectors.length + 1);
  assert.equal(nextBody.obligations.length, oldBody.obligations.length + 2,
    "The distinct selected flow retains both its producer and consumer connection-end obligations");
  assert.equal(nextBody.open.length, oldBody.open.length + 2);
  assert.deepEqual(nextBody.obligations.filter((item: { kind: string }) => item.kind === "block-outcome"),
    oldBody.obligations.filter((item: { kind: string }) => item.kind === "block-outcome"));
  const ports = (graph: Graph) => {
    graph.nodes.find(node => node.id === producer)!.ports.push({ id: "other-out", direction: "out", contract: "garden-contract" });
    graph.nodes.find(node => node.id === independent)!.ports.push({ id: "other-in", direction: "in", contract: "garden-contract" });
  };
  const oneConnector = fixture(t, ports), extraBinding = fixture(t, graph => {
    ports(graph);
    graph.connectors.find(item => item.id === "garden-flow")!.bindings.push({ level: 1,
      producer: { node: producer, port: "other-out" }, consumers: [{ node: independent, port: "other-in" }], anchor: null });
  });
  assert.deepEqual(local(extraBinding), local(oneConnector),
    "A different producer-end flow of an otherwise selected connector is still unrelated to B");
});

test("a genuinely refused horizon has an exact prepared transition and negative issuance without asserting block participation", t => {
  const f = fixture(t); f.series(); const series = stop(f.store), savedSeries = f.store.history(series.id);
  const horizon = f.horizon("refused-choice", { excluded: [{ block: producer,
    reason: "The owner excluded a required provider", returnCondition: "Select the provider again" }] });
  assert.equal(horizon.gate.value.state, "refused");
  assert.ok(horizon.gate.value.codes.includes("horizon_requires_excluded"));
  const given = request(reference(horizon.gate), [reference(series)], "refused-choice"), before = snapshot(f.store);
  refusedWith(prepareSeriesTransition(f.store, { ...given, series: [{ ...reference(series), revision: 900 }] }), "record_missing");
  const prepared = ok(prepareSeriesTransition(f.store, given));
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(prepared.record.value.decisions, [], "Refusal does not prove active, boundary or excluded participation");
  const transition = ok(writeSeriesTransition(f.store, given));
  assert.deepEqual(transition, prepared.record);
  const issuanceRequest = { project, choiceVersion: "refused-choice", horizon: reference(horizon.gate), transition: reference(transition) };
  const beforeIssuance = snapshot(f.store), ready = ok(prepareHorizonIssuance(f.store, issuanceRequest));
  assert.deepEqual(snapshot(f.store), beforeIssuance);
  const issued = ok(writeHorizonIssuance(f.store, issuanceRequest));
  assert.deepEqual(issued, ready.record);
  assert.equal(issued.value.state, "refused");
  assert.deepEqual(issued.value.codes, horizon.gate.value.codes);
  assert.deepEqual(issued.value.horizon, reference(horizon.gate));
  assert.deepEqual(issued.value.transition, reference(transition));
  assert.deepEqual(f.store.history(series.id), savedSeries);
  assert.deepEqual(f.store.get(transition.id), transition);
  const accepted = f.horizon("other-accepted"), otherTransition = ok(writeSeriesTransition(f.store,
    request(reference(accepted.gate), [reference(series)], "other-accepted")));
  const emptyAccepted = ok(writeSeriesTransition(f.store, request(reference(accepted.gate), [], "other-accepted")));
  assert.deepEqual(emptyAccepted.value.decisions, []);
  const emptyIssued = ok(writeHorizonIssuance(f.store, { project, choiceVersion: "other-accepted",
    horizon: reference(accepted.gate), transition: reference(emptyAccepted) }));
  assert.equal(emptyIssued.value.state, "accepted", "The exact H outcome determines G; an empty decision set does not imply refusal");
  assert.deepEqual(emptyIssued.value.codes, []);
  refusedWith(comparePreparedSeriesSlices(f.store, { project, previous: reference(otherTransition), next: reference(transition), block }), "series_transition_unproven");
  refusedWith(prepareHorizonIssuance(f.store, { ...issuanceRequest, transition: reference(otherTransition) }), "horizon_issuance_binding_invalid");
  refusedWith(prepareHorizonIssuance(f.store, { ...issuanceRequest, horizon: reference(accepted.gate), choiceVersion: "other-accepted" }), "horizon_issuance_binding_invalid");
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try {
    assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(transition) })).record, transition);
    assert.deepEqual(ok(readHorizonIssuance(exact, { project, record: reference(issued) })).record, issued);
  } finally { exact.close(); }
  assert.deepEqual(ok(writeSeriesTransition(f.store, given)), transition);
  assert.deepEqual(ok(writeHorizonIssuance(f.store, issuanceRequest)), issued);
  assert.deepEqual(f.store.history(series.id), savedSeries);
});

test("a genuinely executed provider permits omitted external receipt and retains every explicit exact external receipt", async t => {
  for (const onlyExternal of [false, true]) await t.test(onlyExternal ? "external-only provider outside the horizon" : "internal and external inputs from the same provider", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-transition-external-")), workspace = join(root, "workspace"), database = join(root, "state.sqlite");
  mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "Local external-flow regression fixture.\n");
  git(workspace, ["init", "-b", "main"]); git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture baseline"]);
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(), external = "garden-external-input", flowId = "garden-external-flow";
  graph.artifacts.push({ ...clone(graph.artifacts.find(item => item.id === "garden-data")!), id: external, external: true });
  const flow = graph.connectors.find(item => item.id === "garden-flow")!;
  graph.connectors.push({ ...clone(flow), id: flowId, artifact: external, wakeTest: null,
    bindings: ([1,2,3] as const).map(level => {
      const binding = clone(flow.bindings.find(item => item.level === level && item.anchor === null)!);
      binding.consumers = binding.consumers.filter(endpoint => endpoint.node.includes("consume")); return binding;
    }) });
  graph.tests.find(item => item.id === "garden-produce-work-test")!.covers.push(flowId);
  if (onlyExternal) {
    for (const binding of flow.bindings) binding.consumers = binding.consumers.filter(endpoint => !endpoint.node.includes("consume"));
    flow.bindings = flow.bindings.filter(binding => binding.consumers.length > 0);
  }
  preparedFeatures(engine, project, graph);
  engine.discovery.evidence.document(project, external, "Declared external fixture input", "text/plain", 0);
  const agent = join(root, "agent.mjs");
  writeFileSync(agent, `
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject.context;
const response={protocol:request.protocol,requestId:request.requestId};
if(request.mode==='implement'){
 for(const ref of context.scope.code.filter(item=>item.access==='write')){
  mkdirSync(dirname(ref.path),{recursive:true});writeFileSync(ref.path,'fixture:'+context.binding.task+'\\n');
 }
 response.text='Implemented deterministic fixture';response.artifacts=context.produces.map(id=>({id}));
}else response.review={verdict:'pass',kind:'none',findings:[]};
process.stdout.write(JSON.stringify(response));
`);
  const command = { executable: process.execPath, args: [agent] };
  engine.environments.configure(project, { workspace,
    implementer: { actor: "fixture-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "fixture-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000 }, 0);
  refinedLayers(engine, project);
  const feasibility = engine.refinement.assess(project, 0), om = engine.refinement.publish(project, reference(feasibility), 0);
  engine.pipeline.accept(project, "om-g2", om.revision);
  const plan = engine.compiler.compile(project), compilation = engine.compiler.publish(project, reference(plan), 0);
  engine.pipeline.accept(project, "compilation", compilation.revision);
  const runs = await engine.executor.run(project, reference(plan), { retry: false, maxContextChars: 100_000, maxCorrections: 0 });
  const supplierTask = plan.value.tasks.find(task => task.node === "garden-produce-work")!;
  const supplierRun = runs.find(run => run.value.taskId === supplierTask.id)!;
  assert.equal(supplierRun.value.state, "committed");
  const consumerTask = plan.value.tasks.find(task => task.node === "garden-consume-work")!;
  const consumerRun = runs.find(run => run.value.taskId === consumerTask.id)!;
  // V3 executes the external consumer; B3 still consumes the exact committed supplier evidence below.
  assert.equal(consumerRun.value.state, "committed");
  assert.equal(consumerRun.value.error, null);
  const dataReceipt = store.get<ArtifactReceipt>(receiptId(project, "garden-data"))!;
  const externalReceipt = store.get<ArtifactReceipt>(receiptId(project, external))!;
  assert.ok(dataReceipt?.value.run && externalReceipt?.value.run, "Both named receipts are produced by actual committed fixture execution");
  for (const receipt of [dataReceipt, externalReceipt]) {
    assert.deepEqual(receipt.value.plan, reference(plan));
    assert.deepEqual(receipt.value.run, reference(supplierRun));
    assert.equal(receipt.value.node, supplierTask.node);
    assert.equal(receipt.value.commit, supplierRun.value.commit);
    assert.equal(receipt.value.tree, supplierRun.value.tree);
  }
  const input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const series = ok(openSeries(store, { project, block, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  const prepare = (version: string, namedExternal: Ref | null) => {
    const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
      refinement: reference(store.get(`phase:${project}:L2`)!),
      choice: { choiceVersion: version, features: [{ outcome: "garden-result" }], excluded: [] },
      available: onlyExternal && !namedExternal ? {} : { [producer]: {
        ...(onlyExternal ? {} : { "garden-data": reference(dataReceipt) }),
        ...(namedExternal ? { [external]: namedExternal } : {}) } } }));
    assert.equal(horizon.gate.value.state, "accepted");
    assert.deepEqual(horizon.horizon.value.result.horizon.nodes, [block]);
    if (onlyExternal) {
      assert.deepEqual(horizon.horizon.value.result.horizon.boundary, []);
      assert.equal(Object.hasOwn(horizon.horizon.value.result.horizon.execution, producer), false,
        "The explicit receipt belongs to a supplier outside both the selected horizon and its ready boundary");
    }
    assert.equal(horizon.horizon.value.result.horizon.externalInputs.some(item => item.artifact === external && item.source === producer), true);
    const record = ok(writeSeriesTransition(store, request(reference(horizon.gate), [reference(series)], version)));
    return { horizon, record };
  };
  const without = prepare("external-unnamed", null), withReceipt = prepare("external-named", reference(externalReceipt));
  const receipts = (record: typeof without.record) => (decision(record).slice!.body as Record<string, Json>).receipts;
  const internalReceipts = onlyExternal ? [] : [{ source: producer, artifact: "garden-data", receipt: reference(dataReceipt) }];
  assert.deepEqual(receipts(without.record), internalReceipts);
  assert.deepEqual(receipts(withReceipt.record), [...internalReceipts,
    { source: producer, artifact: external, receipt: reference(externalReceipt) },
  ]);
  assert.notDeepEqual(decision(without.record).slice, decision(withReceipt.record).slice);
  assert.equal(ok(comparePreparedSeriesSlices(store, { project, previous: reference(without.record), next: reference(withReceipt.record), block })), "new-work");
  // A new exact revision of the genuine receipt bytes exercises Ref identity, not a claim of another execution.
  const nextReceipt = store.write({ id: externalReceipt.id, kind: externalReceipt.kind, expected: externalReceipt.revision, value: externalReceipt.value });
  const revised = prepare("external-next-exact", reference(nextReceipt));
  assert.deepEqual(receipts(revised.record), [...internalReceipts, { source: producer, artifact: external, receipt: reference(nextReceipt) }]);
  assert.equal(ok(comparePreparedSeriesSlices(store, { project, previous: reference(withReceipt.record), next: reference(revised.record), block })), "new-work");
  store.close(); store = new Store(database);
  const exact = new ExactOnlyStore(database);
  try {
    assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(without.record) })).record, without.record);
    assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(withReceipt.record) })).record, withReceipt.record);
    assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(revised.record) })).record, revised.record);
  } finally { exact.close(); }
  assert.deepEqual(store.get(series.id), series);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store, type Revision } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import {
  confirmResults, ACCEPTANCE_CODES, ACCEPTANCE_PROVIDERS, CANCELLATION_PROVIDERS, type ConfirmRequest,
} from "../src/om/achievements.js";
import { beginAttempt, completeAttempt, openSeries, readSeries, readSeriesAt, type AttemptGoal } from "../src/om/series.js";
import { gapLineKey, gapLinesId, gapLinesNamespace, type GapLinesRecord } from "../src/om/gap-lines.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph, Node } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { ProductEngine } from "../src/product/engine.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { fillObligations, prepareFrame, readFrame, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import { writeCandidate } from "../src/om/frame-candidate.js";
import { readAcceptedFrame, settleCandidate, type AcceptedFrameRequest } from "../src/om/frame-accept.js";
import { readAcceptedFrameLayer, type FrameAttemptBinding } from "../src/om/layer-basis.js";
import { writeWorksAcceptance, type WorksAcceptanceRequest } from "../src/om/atomic-gate.js";
import { readResultIdentity } from "../src/om/result-identity.js";
import { closeAttempt, prepareCloseAttempt } from "../src/om/repeat-gate.js";
import { recordCall, settleCall } from "../src/om/call-record.js";
import { readSpendReport, spendReport, type SpendReport } from "../src/om/spend-report.js";
import { writeGuarded } from "../src/om/refs.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";

const UNIT = "om-acceptance";
const PROJECT = "alpha";
const TARGET = "repair-series:alpha:1:block:cart";
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-om-acceptance-"));
  const store = new Store(join(root, "live.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store };
}

function refusalOf<T>(result: OmResult<T>): Refusal {
  if (result.ok) assert.fail("expected a refusal, got a delivered value");
  return result.refusal;
}

function deliveredOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`unexpected refusal ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(deeplyFrozen);
}

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
let unique = 0;
const next = (): number => (unique += 1);

const goal: AttemptGoal = { key: "gap:cart:price", questions: ["which node produces the price?"], result: "an accepted proposal" };

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest =>
  ({ project: PROJECT, block: "block:cart", target: TARGET, goal, accepting: [], cancelling: [], ...over });

/** A record of a kind, holding content that SAYS it accepted something — the store holds whatever it is given. */
const written = (store: Store, kind: string, value: Record<string, unknown> = { accepted: true, keys: ["line:cart:price"] }): Ref =>
  reference(store.write({ id: `${kind}:${PROJECT}:${next()}`, kind, expected: 0, value: value as Json }));

test("the D2, D5, C5 and M5 acceptance providers and empty cancellation table are frozen and closed to callers", () => {
  for (const table of [ACCEPTANCE_PROVIDERS, CANCELLATION_PROVIDERS]) {
    // H1.0d adds the applied E4 (model-call) provider of M5 addressing; it confirms for a mechanism owner only.
    const expected = table === ACCEPTANCE_PROVIDERS ? ["gap-line", "accepted-answer", "connection-frame", "model-call"] : [];
    assert.deepEqual(Object.keys(table), expected);
    assert.ok(Object.isFrozen(table));
    for (const provider of Object.values(table)) assert.ok(Object.isFrozen(provider));
    // No prototype: a kind that names a member of Object.prototype finds nothing there.
    assert.equal(Object.getPrototypeOf(table), null);
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      assert.equal(Object.hasOwn(table, kind), false, kind);
      assert.equal((table as Record<string, unknown>)[kind], undefined, kind);
    }
    // A caller cannot connect a provider of its own: the table is not a parameter of anything, and it does not change.
    const own = { namespace: () => `om-gap-line:${PROJECT}:`, confirm: () => ({ keys: ["line:cart:price"] }) };
    assert.throws(() => { (table as Record<string, unknown>)["om-gap-line"] = own; }, TypeError);
    assert.throws(() => Object.defineProperty(table, "om-gap-line", { value: own }), TypeError);
    assert.deepEqual(Object.keys(table), expected);
  }
  const provider = ACCEPTANCE_PROVIDERS["gap-line"]!;
  assert.equal(provider.namespace(PROJECT), gapLinesNamespace(PROJECT));
  const m5 = ACCEPTANCE_PROVIDERS["model-call"]!;
  assert.equal(m5.namespace(PROJECT), `model-call:${PROJECT}:om:`);
  assert.equal(m5.confirm, undefined); assert.equal(typeof m5.confirmMechanism, "function");
  assert.equal(provider.confirmMechanism, undefined);
  assert.throws(() => { (provider as unknown as Record<string, unknown>)["confirm"] = () => ({ keys: ["forged"] }); }, TypeError);
  assert.ok(Object.isFrozen(ACCEPTANCE_CODES));
  assert.throws(() => { (ACCEPTANCE_CODES as unknown as string[]).push("invented"); }, TypeError);
});

test("every refusal code of the contract is produced, addressed and routed", t => {
  const { store } = fixture(t);
  const seen: string[] = [];
  const record = (refusal: Refusal, expected: string): void => {
    assert.equal(refusal.code, expected);
    assert.equal(refusal.at.unit, UNIT);
    assert.equal(refusal.at.target, TARGET);
    assert.ok(refusal.message.length > 0);
    assert.ok(REFUSAL_ROUTES.includes(refusal.route));
    seen.push(refusal.code);
  };
  const line = written(store, "om-gap-line");
  record(refusalOf(confirmResults(store, request({ accepting: [line] }))), "achievement_unconfirmed");
  record(refusalOf(confirmResults(store, request({ cancelling: [line] }))), "cancellation_unconfirmed");
  assert.deepEqual([...new Set(seen)].sort(), [...ACCEPTANCE_CODES].sort());
});

test("unsupported kinds cannot confirm a result or cancellation, including the distinct om-gap-line kind", t => {
  const { store } = fixture(t);
  // A refusal as the ground of "acceptance", a candidate, a gap line, and records whose kinds name members of a
  // prototype: none of them has a provider, and no content they carry is read.
  const kinds = ["om-unit-refusal", "om-candidate", "om-gap-line", "om-accepted-frame", "constructor", "__proto__", "toString", "hasOwnProperty"];
  for (const kind of kinds) {
    const ref = written(store, kind);
    const accepted = refusalOf(confirmResults(store, request({ accepting: [ref] })));
    assert.equal(accepted.code, "achievement_unconfirmed", kind);
    assert.equal(accepted.at.field, "outcome.accepting.0.kind", kind);
    assert.deepEqual(accepted.at.ref, ref, kind);
    assert.ok(accepted.message.includes(kind), kind);
    const cancelled = refusalOf(confirmResults(store, request({ cancelling: [ref] })));
    assert.equal(cancelled.code, "cancellation_unconfirmed", kind);
    assert.equal(cancelled.at.field, "outcome.cancelling.0.kind", kind);
  }
  // A reference that does not stand, or stands with other content, is no record at all.
  const line = written(store, "om-gap-line");
  for (const ref of [{ ...line, hash: hex("d") }, { ...line, revision: 2 }, { id: `om-gap-line:${PROJECT}:gone`, revision: 1, hash: hex("e") }]) {
    const found = refusalOf(confirmResults(store, request({ accepting: [written(store, "om-candidate"), ref] })));
    assert.equal(found.code, "achievement_unconfirmed");
    // The first record already refuses the set: one unconfirmed result refuses the whole outcome.
    assert.equal(found.at.field, "outcome.accepting.0.kind");
    assert.equal(refusalOf(confirmResults(store, request({ accepting: [ref] }))).at.field, "outcome.accepting.0");
  }
  // Without an attempt to confirm for, nothing is confirmed either.
  assert.equal(refusalOf(confirmResults(store, request({ goal: null, accepting: [line] }))).code, "achievement_unconfirmed");
});

test("the registered gap-line provider requires real historical sources despite fabricated acceptance fields", t => {
  const { store } = fixture(t);
  const ref = (id: string): Ref => ({ id, revision: 1, hash: hex("a") });
  const graph = ref(`graph:${PROJECT}`), horizon = ref(`om-horizon:${PROJECT}:choice`);
  const value: GapLinesRecord = { project: PROJECT, lines: [], request: { project: PROJECT, previous: null, pass: 1,
    gaps: { records: [], sources: { project: PROJECT, input: ref(`om-input:${PROJECT}`), graph, horizon,
      operations: { proposals: [], frame: { project: PROJECT, level: 2, graph, horizon, layer: null, frame: null, upper: null } },
      works: { state: "upper-not-accepted", layer: ref(`graph-layer:${PROJECT}:2`) },
    } }, closures: [] } };
  const line = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { ...value, accepted: true, status: "closed", keys: ["fabricated-result"] } as unknown as Json }));
  const result = refusalOf(confirmResults(store, request({ accepting: [line] })));
  assert.equal(result.code, "achievement_unconfirmed");
  assert.equal(result.at.field, "outcome.accepting.0");
  assert.match(result.message, /record_missing/);
  assert.deepEqual(result.at.ref, line);
  assert.equal(refusalOf(confirmResults(store, request({ goal: null, accepting: [line] }))).at.field, "attempt");
});

test("the registered gap-line provider refuses an absent saved request", t => {
  const { store } = fixture(t);
  const line = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { project: PROJECT, lines: [], accepted: true, keys: ["fabricated-result"] } }));
  const result = refusalOf(confirmResults(store, request({ accepting: [line] })));
  assert.equal(result.code, "achievement_unconfirmed");
  assert.equal(result.at.field, "outcome.accepting.0");
  assert.match(result.message, /gap_line_forged.*request/i);
});

test("gap-line project namespace and saved project cannot be substituted", t => {
  const { store } = fixture(t);
  const foreign = reference(store.write({ id: gapLinesId(`${PROJECT}bet`), kind: "gap-line", expected: 0,
    value: { project: `${PROJECT}bet`, lines: [], accepted: true } }));
  const result = refusalOf(confirmResults(store, request({ accepting: [foreign] })));
  assert.equal(result.code, "achievement_unconfirmed");
  assert.equal(result.at.field, "outcome.accepting.0.id");
  assert.match(result.message, /outside/);
  const forged = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { project: "foreign", lines: [], accepted: true } }));
  const body = refusalOf(confirmResults(store, request({ accepting: [forged] })));
  assert.equal(body.code, "achievement_unconfirmed");
  assert.match(body.message, /gap_line_forged/);
});

test("registered gap-line acceptance does not grant cancellation authority", t => {
  const { store } = fixture(t);
  const line = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { project: PROJECT, lines: [], closedBy: "cancelled", accepted: true } }));
  const result = refusalOf(confirmResults(store, request({ cancelling: [line] })));
  assert.equal(result.code, "cancellation_unconfirmed");
  assert.equal(result.at.field, "outcome.cancelling.0.kind");
  assert.match(result.message, /gap-line/);
});

test("an outcome that names no result is confirmed as exactly that, and handed out as a frozen copy", t => {
  const { store } = fixture(t);
  const none = deliveredOf(confirmResults(store, request()));
  assert.deepEqual(none, { achieved: [], cancelled: [] });
  assert.ok(deeplyFrozen(none));
  assert.deepEqual(deliveredOf(confirmResults(store, request({ goal: null }))), { achieved: [], cancelled: [] });
});

test("every argument is checked before the store is touched, as a typed defect and never a TypeError", t => {
  const { store } = fixture(t);
  // No default argument stands in for a broken one: a helper that quietly substituted the real store would test itself.
  const confirmIn = (where: unknown, value: unknown): void => { confirmResults(where as Store, value as ConfirmRequest); };
  const confirm = (value: unknown): void => confirmIn(store, value);
  for (const broken of [null, undefined, "store", 7, {}, { get: () => null }]) {
    assert.throws(() => confirmIn(broken, request()), code("acceptance_request_invalid"));
  }
  for (const value of [null, undefined, "request", 7, [request()]]) assert.throws(() => confirm(value), code("acceptance_request_invalid"));
  for (const field of ["project", "block", "target"] as const) {
    for (const broken of [undefined, null, "", 7, {}]) assert.throws(() => confirm({ ...request(), [field]: broken }), code("acceptance_request_invalid"));
  }
  for (const broken of [undefined, "goal", 7, []]) assert.throws(() => confirm({ ...request(), goal: broken }), code("acceptance_request_invalid"));
  for (const field of ["accepting", "cancelling"] as const) {
    // An absent set is not an empty one, and a set of anything but exact references names no record.
    for (const broken of [undefined, null, {}, "ref", [null], ["om-gap-line:alpha:1"], [{ id: "x", revision: 1 }], [{ id: "x", revision: 0, hash: hex("a") }]]) {
      assert.throws(() => confirm({ ...request(), [field]: broken }), code("acceptance_request_invalid"));
    }
  }
});


test("the accepted-answer provider rejects status imitations and unconfirmed cancellation", t => {
  const { store } = fixture(t);
  const row = store.write({ id: `om-answer:${PROJECT}:fake`, kind: "accepted-answer", expected: 0,
    value: { project: PROJECT, accepted: true, status: "supported", key: "caller-result" } });
  assert.equal(refusalOf(confirmResults(store, request({ accepting: [reference(row)] }))).code, "achievement_unconfirmed");
  assert.equal(refusalOf(confirmResults(store, request({ cancelling: [reference(row)] }))).code, "cancellation_unconfirmed");
  assert.equal(ACCEPTANCE_PROVIDERS["accepted-answer"]!.namespace(PROJECT), `om-answer:${PROJECT}:`);
});

const clone = structuredClone;
const heads = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
const outcomeOf = (frame: Ref) => ({ reason: "result" as const, accepting: [frame], cancelling: [], refusals: [] });
const c51Usage = { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 1 };

function boundFrameRequest(acceptance: AcceptedFrameRequest, block: string, goal: AttemptGoal, binding: FrameAttemptBinding): ConfirmRequest {
  return { project: acceptance.project, block, target: binding.series.id, goal,
    attempt: { series: binding.series, ordinal: binding.ordinal }, accepting: [acceptance.frame], cancelling: [] };
}

class ExactAcceptanceStore extends Store {
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    assert.notEqual(revision, undefined, `Historical acceptance consulted the current head of ${id}`);
    return super.get<T>(id, revision);
  }
  override list<T = Json>(_kind?: string): Revision<T>[] { assert.fail("Historical acceptance enumerated current records"); }
}

function n2Fixture(t: test.TestContext, identities = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-c51-achievements-")), path = join(root, "state.sqlite"), store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = "garden", block = "garden-produce-block", address = { project, block, line: 1 };
  const graph = gardenGraph("cross"), { level: _level, ...upper } = projectGraph(graph, 1);
  preparedFeatures(new ProductEngine(store), project, upper as Graph);
  const input = reference(deliveredOf(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> })));
  const initial = deliveredOf(writeHorizon(store, { project, input, graph: reference(store.get(`graph:${project}`)!),
    refinement: null, choice: { choiceVersion: "achievement-initial", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
  let frame: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!), horizon: reference(initial.gate),
    layer: null, frame: null, upper: null };
  const read = deliveredOf(prepareFrame(store, frame)), projected = projectGraph(graph, 2);
  const mapped = deliveredOf(fillObligations(read.upper as Graph, read.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, read.upperRef, 2));
  const obligations = read.result.obligations.filter(item => item.upper.node === block).map(item => item.id).sort();
  const goal: AttemptGoal = { key: "declared-frame-result", questions: obligations.map(id => gapLineKey(project, id, "fill")), result: "accepted-gap-fill" };
  deliveredOf(openSeries(store, { ...address, slice: "achievement-input", predecessor: null, basis: null }));
  const adapter = reference(store.write({ id: `adapter:${project}:achievement`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio" } }));
  const config = reference(store.write({ id: `config:${project}:achievement`, kind: "dispatch-config", expected: 0,
    value: { projectId: project, model: "fixture", transport: "stdio" } }));
  const empty = (): LayerProposal => ({ base: { graph: frame.graph, frame: frame.frame }, level: 2, source: "decision", status: "proposed",
    nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], joins: [], anchors: [], tests: [], edges: [], journeys: [],
    packets: [], transfers: [], removes: [], replaces: [], redefines: [] });
  const first = empty();
  first.nodes = projected.nodes.filter(node => node.kind === "operation" && (!identities || read.scope.nodes.includes(node.parent!)));
  const included = new Set(first.nodes.map(node => node.id));
  first.fills = mapped.fills.filter(fill => included.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
    ...(fill.port === undefined ? {} : { port: fill.port }) }));
  first.localConnectors = projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
    .filter(connector => connector.bindings.length && (!identities || !read.upper.connectors.some(upper => upper.id === connector.id)));
  for (const part of ["artifacts", "contracts", "joins", "anchors", "tests", "edges", "journeys", "packets", "transfers"] as const)
    Object.assign(first, { [part]: projected[part] ?? [] });
  let ordinal = 0;
  function accept(proposal = ordinal ? empty() : first, bound = true) {
    ordinal++;
    const series = deliveredOf(beginAttempt(store, { ...address, attempt: ordinal, goal }));
    const binding: FrameAttemptBinding = { series: reference(series), ordinal, obligations };
    const call = deliveredOf(recordCall(store, project, { call: `frame-${ordinal}`, purpose: "model-design", basis: null, block,
      gaps: obligations.map(id => ({ id, goal: id, field: "fill", consumer: block })), series: reference(series), attempt: ordinal, goal,
      dispatch: { adapter, config }, packet: { question: "Fill the previously declared frame obligations" } }));
    const offered = reference(store.write({ id: `om-proposal:${project}:achievement-${ordinal}`, kind: "layer-proposal", expected: 0, value: proposal }));
    const candidate = deliveredOf(writeCandidate(store, { frame, proposals: [offered] }));
    assert.equal(candidate.state, "candidate"); if (candidate.state !== "candidate") throw new Error("Expected genuine candidate");
    const ref = reference(candidate.record), saved = deliveredOf(settleCandidate(store, { project, level: 2, candidate: ref,
      binding: bound ? binding : null, outcome: { gate: "G3", candidate: ref, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
    assert.ok(saved.graph && saved.layer && saved.frame);
    const acceptance: AcceptedFrameRequest = { project, level: 2, graph: reference(saved.graph), layer: reference(saved.layer), frame: reference(saved.frame) };
    deliveredOf(settleCall(store, reference(call.call), c51Usage, "succeeded"));
    const next = deliveredOf(writeHorizon(store, { project, input, graph: acceptance.graph, refinement: acceptance.layer,
      choice: { choiceVersion: `achievement-${ordinal}`, features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
    frame = { ...acceptance, horizon: reference(next.gate), upper: null };
    return { acceptance, binding, candidate: ref, saved, call: reference(call.call),
      confirmation: boundFrameRequest(acceptance, block, goal, binding) };
  }
  function replacement(id: string, mutate: (node: Node) => void) {
    const current = deliveredOf(prepareFrame(store, frame)), graph = clone(current.accepted!.graph) as Graph;
    const before = graph.nodes.find(node => node.id === id)!; assert.ok(before);
    const after = clone(before); mutate(after);
    const nodeName = (value: string) => value === before.id ? after.id : value;
    const portName = (node: string, port: string) => node === before.id ? after.ports[before.ports.findIndex(item => item.id === port)]!.id : port;
    const proposal = empty(); proposal.nodes = [after]; proposal.removes = [before.id];
    for (const fill of current.result.fills.filter(item => item.node === before.id)) {
      const port = fill.port === undefined ? undefined : portName(fill.node, fill.port);
      proposal.fills.push({ obligation: fill.obligation, node: after.id, ...(port === undefined ? {} : { port }) });
      proposal.replaces.push({ obligation: fill.obligation, base: { node: before.id, graph: frame.graph },
        with: { node: after.id, port: port ?? null }, basis: "The exact prior obligation names its replacement" });
    }
    for (const connector of graph.connectors) {
      const endpoint = (item: { node: string; port: string }) => ({ ...item, node: nodeName(item.node), port: portName(item.node, item.port) });
      const next = { ...connector, returnsTo: nodeName(connector.returnsTo), bindings: connector.bindings.map(binding => ({ ...binding,
        producer: endpoint(binding.producer), consumers: binding.consumers.map(endpoint) })) };
      if (canonical(next) !== canonical(connector)) { proposal.localConnectors.push(next); proposal.redefines.push(connector.id); }
    }
    for (const edge of graph.edges ?? []) {
      const next = { ...edge, source: nodeName(edge.source), target: nodeName(edge.target) };
      if (canonical(next) !== canonical(edge)) { proposal.edges.push(next); proposal.redefines.push(edge.id); }
    }
    for (const journey of graph.journeys ?? []) {
      const next = { ...journey, entry: nodeName(journey.entry), path: journey.path.map(nodeName) };
      if (canonical(next) !== canonical(journey)) { proposal.journeys.push(next); proposal.redefines.push(journey.id); }
    }
    for (const item of graph.tests) if (item.node === before.id) { proposal.tests.push({ ...item, node: after.id }); proposal.redefines.push(item.id); }
    for (const item of graph.anchors) if (item.owner === before.id) { proposal.anchors.push({ ...item, owner: after.id }); proposal.redefines.push(item.id); }
    for (const item of graph.joins) {
      const next = { ...item, consumer: nodeName(item.consumer),
        ...(item.failures === undefined ? {} : { failures: { ...item.failures, returnsTo: nodeName(item.failures.returnsTo) } }) };
      if (canonical(next) !== canonical(item)) { proposal.joins.push(next); proposal.redefines.push(item.id); }
    }
    return proposal;
  }
  return { store, root, path, project, block, address, goal, obligations, accept, replacement };
}

test("C5.1b real N2 frame bindings reach G7 and E6 through later exact series revisions and restart", t => {
  const f = n2Fixture(t), accepted = f.accept(), before = heads(f.store);
  const confirmed = deliveredOf(confirmResults(f.store, accepted.confirmation));
  const expected = f.obligations.map(obligation => deliveredOf(readResultIdentity(f.store, { acceptance: accepted.acceptance, obligation })).key).sort();
  assert.ok(expected.length > 1); assert.deepEqual(confirmed.achieved.map(item => item.key).sort(), expected);
  assert.ok(confirmed.achieved.every(item => canonical(item.basis) === canonical(accepted.acceptance.frame)));
  assert.ok(accepted.saved.frame!.value.fills.some(fill => !f.obligations.includes(fill.obligation)), "The common layer also contains foreign fillings");
  const request = { ...f.address, attempt: 1, outcome: outcomeOf(accepted.acceptance.frame) };
  const prepared = deliveredOf(prepareCloseAttempt(f.store, request)); assert.deepEqual(heads(f.store), before);
  assert.ok(prepared.writes.length > 0);
  assert.equal(deliveredOf(closeAttempt(f.store, request)).verdict, "progress");
  const completed = deliveredOf(readSeries(f.store, f.address));
  assert.ok(completed.revision > accepted.binding.series.revision);
  const report = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.deepEqual(report.rows[0]!.result, { series: reference(completed), attempt: 1, verdict: "progress", achieved: completed.value.attempts[0]!.outcome!.achieved });
  assert.equal(report.totals.calls, 1); assert.deepEqual(report.rows[0]!.usage, c51Usage);
  deliveredOf(beginAttempt(f.store, { ...f.address, attempt: 2, goal: f.goal }));
  const later = deliveredOf(readSeries(f.store, f.address));
  assert.deepEqual(deliveredOf(confirmResults(f.store, { ...accepted.confirmation, attempt: { series: reference(later), ordinal: 1 } })), confirmed);
  assert.equal(deliveredOf(closeAttempt(f.store, request)).verdict, "progress");
  const reopened = new ExactAcceptanceStore(f.path);
  try {
    assert.deepEqual(deliveredOf(readSpendReport(reopened, report.snapshot)), report);
    assert.deepEqual(deliveredOf(confirmResults(reopened, { ...accepted.confirmation, attempt: { series: reference(later), ordinal: 1 } })), confirmed);
  } finally { reopened.close(); }
});

test("C5.1b technical and editorial repeats, typed renames and A to B to A retain semantic novelty", t => {
  const f = n2Fixture(t), results: { acceptance: AcceptedFrameRequest; keys: string[] }[] = [];
  const finish = (item: ReturnType<typeof f.accept>, verdict: string) => {
    const result = deliveredOf(confirmResults(f.store, item.confirmation));
    assert.equal(deliveredOf(closeAttempt(f.store, { ...f.address, attempt: item.binding.ordinal, outcome: outcomeOf(item.acceptance.frame) })).verdict, verdict);
    const keys = result.achieved.map(value => value.key).sort(); results.push({ acceptance: item.acceptance, keys }); return keys;
  };
  const a = finish(f.accept(), "progress");
  assert.deepEqual(finish(f.accept(), "none"), a);
  assert.deepEqual(finish(f.accept(f.replacement("garden-produce-operation", node => { node.title = "Editorial title"; node.purpose = "Editorial purpose"; })), "none"), a);
  const b = finish(f.accept(f.replacement("garden-produce-operation", node => { node.code = [{ path: "src/changed.ts", access: "read", status: "existing" }]; })), "progress");
  assert.notDeepEqual(b, a);
  assert.deepEqual(finish(f.accept(f.replacement("garden-produce-operation", node => { node.id = "renamed-operation"; node.ports.find(port => port.id === "out")!.id = "renamed-out"; })), "none"), b);
  assert.deepEqual(finish(f.accept(f.replacement("renamed-operation", node => { node.code = []; })), "none"), a);
  const report = deliveredOf(spendReport(f.store, { project: f.project }));
  assert.equal(report.totals.calls, 6); assert.equal(report.rows.length, 6);
  const reopened = new ExactAcceptanceStore(f.path);
  try {
    assert.deepEqual(deliveredOf(readSpendReport(reopened, report.snapshot)), report);
    for (const item of results) assert.deepEqual(f.obligations.map(obligation => deliveredOf(readResultIdentity(reopened,
      { acceptance: item.acceptance, obligation })).key).sort(), item.keys);
  } finally { reopened.close(); }
});

test("C5.1b another goal, ordinal or successor cannot claim a genuine bound frame", t => {
  const f = n2Fixture(t), accepted = f.accept(), original = accepted.confirmation, before = heads(f.store);
  const noAttempt = { ...original } as Record<string, unknown>; delete noAttempt.attempt;
  for (const change of [noAttempt, { ...original, goal: { ...f.goal, key: "foreign-key" } },
    { ...original, goal: { ...f.goal, questions: f.goal.questions.slice(1) } }, { ...original, goal: { ...f.goal, result: "foreign-result" } },
    { ...original, block: "garden-consume-block" },
    { ...original, attempt: { series: accepted.binding.series, ordinal: 2 } }])
    assert.equal(refusalOf(confirmResults(f.store, change as unknown as ConfirmRequest)).code, "achievement_unconfirmed");
  assert.equal(refusalOf(confirmResults(f.store, { ...original, accepting: [], cancelling: original.accepting })).code, "cancellation_unconfirmed");
  assert.deepEqual(heads(f.store), before);
  deliveredOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: outcomeOf(accepted.acceptance.frame) }));
  const second = deliveredOf(beginAttempt(f.store, { ...f.address, attempt: 2, goal: f.goal }));
  assert.equal(refusalOf(confirmResults(f.store, { ...original, attempt: { series: reference(second), ordinal: 2 } })).code, "achievement_unconfirmed");
  const denied = { ...f.address, attempt: 2, outcome: outcomeOf(accepted.acceptance.frame) }, still = heads(f.store);
  for (const action of [prepareCloseAttempt, closeAttempt]) assert.equal(refusalOf<unknown>(action(f.store, denied)).code, "achievement_unconfirmed");
  assert.deepEqual(heads(f.store), still);
  const stopped = deliveredOf(completeAttempt(f.store, { ...f.address, attempt: 2,
    outcome: { reason: "interrupted", achieved: [], cancelled: [], refusals: [] } }));
  const successor = deliveredOf(openSeries(f.store, { ...f.address, line: 2, slice: "next-source", predecessor: reference(stopped),
    basis: { ground: "inputs-changed", text: "The source slice moved" } }));
  const back = new Store(f.path);
  try {
    assert.equal(refusalOf(confirmResults(back, { ...original, target: successor.id, attempt: { series: reference(successor), ordinal: 1 } })).code, "achievement_unconfirmed");
    assert.equal(deliveredOf(closeAttempt(back, { ...f.address, attempt: 1, outcome: outcomeOf(accepted.acceptance.frame) })).verdict, "progress");
  } finally { back.close(); }
});

test("C5.1b a self-consistent later series cannot replace the bound slice while retaining its id ordinal and goal", t => {
  const f = n2Fixture(t), accepted = f.accept();
  const expected = deliveredOf(confirmResults(f.store, accepted.confirmation));
  assert.ok(expected.achieved.length > 1);
  const original = deliveredOf(readSeriesAt(f.store, f.project, accepted.binding.series));
  const changed = f.store.write({ id: original.id, kind: original.kind, expected: original.revision,
    value: { ...clone(original.value), slice: "another-self-consistent-source-slice" } });
  assert.equal(changed.id, original.id); assert.ok(changed.revision > original.revision);
  assert.notEqual(changed.hash, original.hash);
  const checked = deliveredOf(readSeriesAt(f.store, f.project, reference(changed)));
  assert.deepEqual(checked, changed); assert.deepEqual(checked.value.attempts, original.value.attempts);
  const before = heads(f.store), reopened = new ExactAcceptanceStore(f.path);
  try {
    assert.equal(refusalOf(confirmResults(reopened, { ...accepted.confirmation,
      attempt: { series: reference(changed), ordinal: accepted.binding.ordinal } })).code, "achievement_unconfirmed");
    assert.deepEqual(deliveredOf(confirmResults(reopened, accepted.confirmation)), expected);
  } finally { reopened.close(); }
  assert.deepEqual(heads(f.store), before);
});

test("C5.1b a prepared G7 closure cannot overwrite a concurrent completion from a second Store", t => {
  const f = n2Fixture(t), accepted = f.accept();
  const prepared = deliveredOf(prepareCloseAttempt(f.store, { ...f.address, attempt: 1, outcome: outcomeOf(accepted.acceptance.frame) }));
  const other = new Store(f.path);
  try { deliveredOf(closeAttempt(other, { ...f.address, attempt: 1,
    outcome: { reason: "interrupted", accepting: [], cancelling: [], refusals: [] } })); }
  finally { other.close(); }
  const before = heads(f.store);
  assert.equal(refusalOf(writeGuarded(f.store, { unit: "C5.1b-test", target: accepted.binding.series.id,
    writes: prepared.writes, guards: prepared.guards })).code, "input_stale");
  assert.deepEqual(heads(f.store), before);
});

test("C5.1b missing attempt context and unbound or identity-only history confer no achievement", t => {
  const f = n2Fixture(t, true), accepted = f.accept(undefined, false);
  const checked = deliveredOf(readAcceptedFrameLayer(f.store, { project: f.project, level: 2, frame: accepted.acceptance.frame }));
  assert.equal(checked.frame.value.acceptance.binding, null);
  assert.ok(checked.frame.value.fills.some(fill => fill.source === "identity"));
  const before = heads(f.store);
  assert.equal(refusalOf(confirmResults(f.store, accepted.confirmation)).code, "achievement_unconfirmed");
  assert.equal(refusalOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: outcomeOf(accepted.acceptance.frame) })).code, "achievement_unconfirmed");
  assert.deepEqual(heads(f.store), before);
  const source = deliveredOf(readFrame(f.store, f.store.get<{ request: { frame: FrameRequest } }>(accepted.candidate.id)!.value.request.frame));
  const identity = checked.frame.value.fills.find(fill => fill.source === "identity")!;
  const obligation = source.result.obligations.find(item => item.id === identity.obligation)!;
  assert.ok(obligation);
  const address = { project: f.project, block: obligation.upper.node, line: 1 };
  deliveredOf(openSeries(f.store, { ...address, slice: "identity-only", predecessor: null, basis: null }));
  const goal = { key: "identity-only", questions: [gapLineKey(f.project, obligation.id, "fill")], result: "accepted-gap-fill" };
  const series = deliveredOf(beginAttempt(f.store, { ...address, attempt: 1, goal }));
  const frame = clone(checked.frame.value) as unknown as { acceptance: Record<string, unknown> };
  const binding = { series: reference(series), ordinal: 1, obligations: [obligation.id] };
  frame.acceptance.binding = binding;
  const forged = f.store.write({ id: checked.frame.id, kind: checked.frame.kind, expected: checked.frame.revision, value: frame as unknown as Json });
  const attempted = boundFrameRequest({ ...accepted.acceptance, frame: reference(forged) }, address.block, goal, binding);
  assert.equal(refusalOf(confirmResults(f.store, attempted)).code, "achievement_unconfirmed");
  assert.deepEqual(deliveredOf(readAcceptedFrame(f.store, accepted.acceptance)).frame, accepted.saved.frame);
});

test("C5.1b malformed new context fails before storage while missing saved binding cannot masquerade as legacy", t => {
  const f = n2Fixture(t), accepted = f.accept(), original = f.store.get.bind(f.store);
  const sparse = new Array<string>(1);
  const malformed: unknown[] = [null, {}, { series: accepted.binding.series }, { ordinal: 1 },
    { series: null, ordinal: 1 }, { series: accepted.binding.series, ordinal: 0 },
    { series: accepted.binding.series, ordinal: "1" }, { series: { id: accepted.binding.series.id, revision: 1 }, ordinal: 1 }];
  let reads = 0;
  try {
    f.store.get = (() => { reads++; throw new Error("Malformed C5 context reached storage"); }) as Store['get'];
    for (const attempt of malformed) assert.throws(() => confirmResults(f.store, { ...accepted.confirmation, attempt } as ConfirmRequest), code("acceptance_request_invalid"));
    const provider = ACCEPTANCE_PROVIDERS["connection-frame"]!;
    for (const goal of [{ ...f.goal, questions: sparse }, { ...f.goal, extra: "not-a-goal-field" }])
      assert.throws(() => provider.confirm!(accepted.saved.frame as unknown as Revision<Json>,
        { project: f.project, block: f.block, goal, attempt: accepted.confirmation.attempt! }, f.store), code("acceptance_request_invalid"));
    assert.equal(reads, 0);
  } finally { f.store.get = original; }
  const source = accepted.saved.frame!, value = clone(source.value) as unknown as { acceptance: Record<string, unknown> };
  delete value.acceptance.binding;
  const broken = f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: value as unknown as Json });
  const back = new Store(f.path);
  try {
    assert.equal(refusalOf(confirmResults(back, { ...accepted.confirmation, accepting: [reference(broken)] })).code, "achievement_unconfirmed");
    assert.ok(deliveredOf(confirmResults(back, accepted.confirmation)).achieved.length > 1);
  } finally { back.close(); }
});

interface WorksSeed {
  root: string; database: string; trace: string; traceBytes: string; project: string;
  request: WorksAcceptanceRequest; goal: { block: string; ordinal: number; series: Ref; goal: AttemptGoal };
  obligations: string[]; realizedObligations: string[]; upper: AcceptedFrameRequest;
}
interface ProducerHistory {
  root: string; database: string; acceptance: AcceptedFrameRequest; confirmation: ConfirmRequest;
  close: Parameters<typeof closeAttempt>[1]; closed: unknown; report: SpendReport;
  series: Ref; bytes: { ref: Ref; body: string }[];
}

function gitProducer(t: test.TestContext, mode: "works", base?: string): WorksSeed;
function gitProducer(t: test.TestContext, mode: "history", base?: string): ProducerHistory;
function gitProducer(t: test.TestContext, mode: "works" | "history", base = "9c22e4a46dc712242d8f307b13f1aceaeb317186"): WorksSeed | ProducerHistory {
  const directory = mkdtempSync(join(tmpdir(), "omg-c51b-producer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../../", import.meta.url)), root = pathToFileURL(repository).href;
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href, loader = join(directory, "producer-loader.mjs");
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
const root = ${JSON.stringify(root)};
export async function load(url, context, next) {
  if (url === 'node:test') return { format: 'module', shortCircuit: true, source: 'export const test = () => {}; export const after = () => {}; export default test;' };
  const prefix = new URL('dist/', root).href;
  if (!url.startsWith(prefix) || !/\\.js$/.test(url)) return next(url, context);
  const relative = url.slice(prefix.length).replace(/\\.js$/, '.ts');
  const body = execFileSync('git', ['show', ${JSON.stringify(base)} + ':' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
  let source = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText;
  const exposed = { 'test/om-atomic-gate.test.ts': 'produceAtomicSeed', 'test/om-gap-lines.test.ts': 'firstPassFixture, acceptOperations, goalFor, openAttempt' }[relative];
  if (exposed) {
    const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    source = tree.statements.filter(statement => !(ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && ['test', 'after'].includes(statement.expression.expression.getText(tree))))
      .map(statement => source.slice(statement.pos, statement.end)).join('\\n');
    source += '\\nexport { ' + exposed + ' };\\n';
  }
  return { format: 'module', shortCircuit: true, source };
}
`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`;
  const script = `
const root = ${JSON.stringify(new URL("dist/", root).href)};
const { canonical } = await import(root + 'src/canonical.js');
const { reference } = await import(root + 'src/pipeline/contracts.js');
const { Store } = await import(root + 'src/storage/store.js');
const { readFrame, prepareFrame } = await import(root + 'src/om/frame-obligations.js');
const { gapLineKey, writeGapLines } = await import(root + 'src/om/gap-lines.js');
const { closeAttempt } = await import(root + 'src/om/repeat-gate.js');
const { confirmResults } = await import(root + 'src/om/achievements.js');
const { recordCall, settleCall } = await import(root + 'src/om/call-record.js');
const { spendReport } = await import(root + 'src/om/spend-report.js');
function ok(result) { if (!result.ok) throw new Error(result.refusal.code + ': ' + result.refusal.message); return result.value; }
if (${JSON.stringify(mode)} === 'works') {
  const { produceAtomicSeed } = await import(root + 'test/om-atomic-gate.test.js');
  const seed = await produceAtomicSeed(), f = seed.data, store = new Store(seed.database);
  try {
    const frame = ok(readFrame(store, f.gapRead.sources.works.frame));
    const obligations = frame.result.obligations.filter(item => f.openGoal.goal.questions.includes(gapLineKey(f.project, item.id, 'fill'))).map(item => item.id).sort();
    const realizedObligations = frame.result.obligations.filter(item => item.upper.node === 'garden-produce-operation').map(item => item.id).sort();
    process.stdout.write(JSON.stringify({ root: seed.root, database: seed.database, trace: seed.trace, traceBytes: seed.traceBytes,
      project: f.project, request: f.request, goal: f.openGoal, obligations, realizedObligations,
      upper: { project: f.project, level: 2, graph: f.graph, layer: f.layer2, frame: f.upperFrame } }));
  } finally { store.close(); }
} else {
  const { firstPassFixture, acceptOperations, goalFor, openAttempt } = await import(root + 'test/om-gap-lines.test.js');
  const f = firstPassFixture({ after() {} }), store = f.store;
  try {
    const first = ok(writeGapLines(store, f.request));
    const gap = f.gaps.collection.gaps.find(item => item.field === 'fill' && item.evidence.some(source => source.origin === 'operations'));
    const obligation = ok(prepareFrame(store, f.frame)).result.obligations.find(item => item.id === gap.target);
    const address = { project: 'garden', block: obligation.upper.node, line: 1 }, goal = goalFor(gap), attempt = openAttempt(store, address, goal);
    const adapter = reference(store.write({ id: 'adapter:garden:c51-history', kind: 'dispatch-adapter', expected: 0, value: { projectId: 'garden', protocol: 'codex-stdio' } }));
    const config = reference(store.write({ id: 'config:garden:c51-history', kind: 'dispatch-config', expected: 0, value: { projectId: 'garden', model: 'fixture', transport: 'stdio' } }));
    const call = ok(recordCall(store, 'garden', { call: 'c51-history', purpose: 'model-design', basis: null, block: address.block,
      gaps: [{ id: gap.target, goal: gap.target, field: gap.field, consumer: address.block }], series: reference(attempt), attempt: 1, goal,
      dispatch: { adapter, config }, packet: { question: 'Fill the declared obligation' } }));
    const accepted = acceptOperations(f), lines = ok(writeGapLines(store, { ...f.request, previous: reference(first), pass: 2, gaps: accepted.gaps,
      closures: [{ ...accepted.closure, attempt: { series: reference(attempt), attempt: 1 } }] }));
    const confirmation = { project: 'garden', block: address.block, target: attempt.id, goal, accepting: [reference(lines)], cancelling: [] };
    const confirmed = ok(confirmResults(store, confirmation));
    const close = { ...address, attempt: 1, outcome: { reason: 'result', accepting: [reference(lines)], cancelling: [], refusals: [] } }, closed = ok(closeAttempt(store, close));
    ok(settleCall(store, reference(call.call), ${JSON.stringify(c51Usage)}, 'succeeded'));
    const report = ok(spendReport(store, { project: 'garden' }));
    if (closed.verdict !== 'progress' || confirmed.achieved.length === 0 || report.rows[0].result === null) throw new Error('The genuine producer did not establish D2/G7/E6 history');
    const bytes = store.list().flatMap(row => store.history(row.id)).map(row => ({ ref: reference(row), body: canonical(row) }));
    process.stdout.write(JSON.stringify({ root: f.root, database: f.database, acceptance: accepted.acceptance, confirmation,
      close, closed, report, series: reference(attempt), bytes }));
  } finally { store.close(); }
}
`;
  const produced = JSON.parse(execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`,
    "--input-type=module", "--eval", script], { cwd: repository, encoding: "utf8", maxBuffer: 20_000_000 })) as WorksSeed | ProducerHistory;
  t.after(() => rmSync(produced.root, { recursive: true, force: true }));
  return produced;
}

test("C5.1b genuine N3 bound work passes G7 and physical E6 history without attributing foreign fillings", t => {
  const seed = gitProducer(t, "works"), realizedPath = join(seed.root, "realized.sqlite");
  copyFileSync(seed.database, realizedPath);
  const store = new Store(seed.database);
  t.after(() => store.close());
  const binding: FrameAttemptBinding = { series: seed.goal.series, ordinal: seed.goal.ordinal, obligations: seed.obligations };
  const saved = deliveredOf(writeWorksAcceptance(store, { ...seed.request, binding })); assert.ok(saved.acceptance);
  const confirmation = boundFrameRequest(saved.acceptance, seed.goal.block, seed.goal.goal, binding);
  const confirmed = deliveredOf(confirmResults(store, confirmation));
  assert.deepEqual(confirmed.achieved.map(item => item.key).sort(), seed.obligations.map(obligation =>
    deliveredOf(readResultIdentity(store, { acceptance: saved.acceptance!, obligation })).key).sort());
  const accepted = deliveredOf(readAcceptedFrameLayer(store, { project: seed.project, level: 3, frame: saved.acceptance.frame }));
  assert.ok(accepted.frame.value.fills.some(fill => !seed.obligations.includes(fill.obligation)));
  const close = { project: seed.project, block: seed.goal.block, line: 1, attempt: binding.ordinal, outcome: outcomeOf(saved.acceptance.frame) };
  assert.equal(deliveredOf(closeAttempt(store, close)).verdict, "progress");
  const report = deliveredOf(spendReport(store, { project: seed.project }));
  const matching = report.rows.filter(row => row.series?.id === binding.series.id && row.attempt === binding.ordinal);
  assert.ok(matching.length > 0 && matching.every(row => row.physical !== null && row.result !== null));
  for (const row of matching) assert.deepEqual(row.result!.achieved.map(item => item.key).sort(), confirmed.achieved.map(item => item.key).sort());
  assert.ok(report.totals.reportedTokens!.inputTokens > 0);
  const reopened = new ExactAcceptanceStore(seed.database);
  try { assert.deepEqual(deliveredOf(readSpendReport(reopened, report.snapshot)), report); }
  finally { reopened.close(); }
  assert.equal(deliveredOf(closeAttempt(store, close)).verdict, "progress");
  assert.equal(readFileSync(seed.trace, "utf8"), seed.traceBytes, "Achievement confirmation and historical E6 never dispatch again");
  const realized = new Store(realizedPath);
  try {
    const graph = realized.get<Graph>(seed.upper.graph.id, seed.upper.graph.revision)!.value;
    assert.notEqual(graph.nodes.find(node => node.id === "garden-produce-operation")!.parent, seed.goal.block);
    assert.ok(graph.edges!.some(edge => edge.relation === "realizes" && edge.source === "garden-produce-operation" && edge.target === seed.goal.block));
    const address = { project: seed.project, block: seed.goal.block, line: 1 };
    deliveredOf(completeAttempt(realized, { ...address, attempt: seed.goal.ordinal,
      outcome: { reason: "interrupted", achieved: [], cancelled: [], refusals: [] } }));
    const ordinal = seed.goal.ordinal + 1, goal = { key: "realized-work", questions: seed.realizedObligations.map(id => gapLineKey(seed.project, id, "fill")), result: "accepted-gap-fill" };
    const attempt = deliveredOf(beginAttempt(realized, { ...address, attempt: ordinal, goal }));
    const binding = { series: reference(attempt), ordinal, obligations: seed.realizedObligations };
    const result = deliveredOf(writeWorksAcceptance(realized, { ...seed.request, binding })); assert.ok(result.acceptance);
    const confirmed = deliveredOf(confirmResults(realized, boundFrameRequest(result.acceptance, seed.goal.block, goal, binding)));
    assert.equal(confirmed.achieved.length, seed.realizedObligations.length);
    assert.equal(deliveredOf(closeAttempt(realized, { ...address, attempt: ordinal, outcome: outcomeOf(result.acceptance.frame) })).verdict, "progress");
  } finally { realized.close(); }
});

test("C5.1b exact old producer D2 and E6 history survives while its unbound frame cannot invent an achievement", t => {
  for (const base of ["9c22e4a46dc712242d8f307b13f1aceaeb317186", "eb90700587b23375012a98217dc80010031ab8b8",
    "b1143aa7343db45896a134ee3cb3a273b211057e"]) {
    const history = gitProducer(t, "history", base), reopened = new ExactAcceptanceStore(history.database);
    try {
      assert.deepEqual(deliveredOf(readSpendReport(reopened, history.report.snapshot)), history.report);
      assert.ok(deliveredOf(confirmResults(reopened, history.confirmation)).achieved.length > 0);
      assert.ok(deliveredOf(readAcceptedFrame(reopened, history.acceptance)).frame);
      const attempt = { series: history.report.snapshot.series[0]!, ordinal: 1 };
      assert.equal(refusalOf(confirmResults(reopened, { ...history.confirmation, accepting: [history.acceptance.frame], attempt })).code, "achievement_unconfirmed");
      for (const row of history.bytes) assert.equal(canonical(reopened.get(row.ref.id, row.ref.revision)), row.body);
    } finally { reopened.close(); }
    const store = new Store(history.database);
    try { assert.deepEqual(deliveredOf(closeAttempt(store, history.close)), history.closed); }
    finally { store.close(); }
  }
});

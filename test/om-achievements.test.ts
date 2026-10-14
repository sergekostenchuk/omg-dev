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
  confirmResults, confirmModelCallInputFields, ACCEPTANCE_CODES, ACCEPTANCE_PROVIDERS, CANCELLATION_PROVIDERS, type ConfirmRequest,
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
    // H1.0d adds the applied E4 (model-call) provider of M5 addressing; LP6 gives it the block's input fields too.
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
  // LP6 (№3325 §2): the applied E4 also confirms the input fields of a block — its own provider, beside the M5 one.
  assert.equal(m5.confirm, confirmModelCallInputFields); assert.equal(typeof m5.confirmMechanism, "function");
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

test("the registered gap-line provider requires real historical sources despite fabricated acceptance fields", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
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

test("the registered gap-line provider refuses an absent saved request", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const { store } = fixture(t);
  const line = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { project: PROJECT, lines: [], accepted: true, keys: ["fabricated-result"] } }));
  const result = refusalOf(confirmResults(store, request({ accepting: [line] })));
  assert.equal(result.code, "achievement_unconfirmed");
  assert.equal(result.at.field, "outcome.accepting.0");
  assert.match(result.message, /gap_line_forged.*request/i);
});

test("gap-line project namespace and saved project cannot be substituted", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
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


test("the accepted-answer provider rejects status imitations and unconfirmed cancellation", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
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

// ---- LP6 (№3325 §2): the fields of a block's own input decided by its own applied E4 ----
import { seedCopy } from "./om-seed.js";
import { preparedField } from "./preparation-fixture.js";
import { existsSync } from "node:fs";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { writeRoutes, type RoutesRecord } from "../src/om/routes.js";
import { writeQuestionPacket } from "../src/om/question-packet.js";
import { runModelCall } from "../src/om/model-call.js";
import { openAttempt as managedOpenAttempt, prepareManagedClaim } from "../src/om/repeat-gate.js";
import { gapLineKey as lp6LineKey, gapLineExpectedResult } from "../src/om/gap-lines.js";
import { readInputFieldResult } from "../src/om/achievements.js";
import { INPUT_FIELD_KEY_PREFIX } from "../src/om/series.js";

const LP6_ADAPTER = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const LP6_BLOCK = "garden-consume-block";
type Lp6Field = "nodes" | "state" | "checkKind";
const lp6Usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
/** The routes of today's B1 of the garden project: horizon, D1 and M6, no catalog. */
import { dirname } from "node:path";
const LP7_BASE = "7c7d3cccb88d0a6c17b21051069f0244d98248f9";
/**
 * The route the base code 7c7d3ccc writes, every engine module served from Git in its own process (LP7, №3393 §6 F1): the
 * subject of these tests is several E4s of one block, which its genuine split routing keeps — today's routing joins them.
 */
function routesAtBase(store: Store, request: unknown): Revision<RoutesRecord> {
  const root = dirname(store.path), repository = fileURLToPath(new URL("../../", import.meta.url));
  const loader = join(root, "lp7-base-loader.mjs"), producer = join(root, "lp7-base-producer.mjs"), input = join(root, "lp7-base-input.json");
  const served = join(root, "lp7-base-served.log"), typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
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
    const source = execFileSync('git', ['show', ${JSON.stringify(LP7_BASE)} + ':' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  if (url.startsWith('file:') && url.includes('/dist/src/') && !url.includes('/node_modules/'))
    throw new Error('An engine module outside the era checkout: ' + url);
  return next(url, context);
}`);
  writeFileSync(producer, `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database, input] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { writeRoutes } = await import(src('om/routes.js'));
const store = new Store(database);
try {
  const written = writeRoutes(store, JSON.parse(readFileSync(input, 'utf8')));
  if (!written.ok) throw Error(JSON.stringify(written.refusal));
  process.stdout.write(JSON.stringify(written.value));
} finally { store.close(); }`);
  writeFileSync(input, JSON.stringify(request));
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)}, log: ${JSON.stringify(served)} } });`;
  const output = JSON.parse(execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, store.path, input],
    { cwd: repository, encoding: "utf8", timeout: 180_000, maxBuffer: 10_000_000 })) as Revision<RoutesRecord>;
  assert.ok(readFileSync(served, "utf8").split("\n").includes("src/om/routes.ts"), "The route was written by the modules of the base code");
  return output;
}
function lp6Routes(store: Store, project: string, joined = false): Revision<RoutesRecord> {
  const input = store.get(`om-input:${project}`)!, graph = store.get(`graph:${project}`)!;
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: `lp6-${input.revision}`, features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = deliveredOf(writeGaps(store, sources));
  const request = { project, gaps: { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) },
    tasks: [], catalog: { paths: [], records: [] }, previous: null };
  return joined ? deliveredOf(writeRoutes(store, request)) as Revision<RoutesRecord> : routesAtBase(store, request);
}
/**
 * A block whose B1 leaves its contract's nodes and state and its criterion's checkKind open, so the split routing of the
 * base code gives it one MC2 input-field batch per field. A round opens a managed attempt of its line on the routes of today's B1 with the batches
 * of the named fields, and the scripted model answers each of them: the block's own E4 applies the decisions by D3.
 */
function lp6Fields(t: test.TestContext, block = LP6_BLOCK) {
  const seeded = seedCopy("lp6:block-fields", store => {
    const engine = new ProductEngine(store), project = "garden", { level: _level, ...l1 } = projectGraph(gardenGraph("cross"), 1);
    preparedFeatures(engine, project, l1 as Graph, field => preparedField(project, field), LP7_BASE);
    const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
    deliveredOf(writeOmInput(store, { project, expected: 0, stages }));
    return null;
  }, "omg-lp6-fields-");
  const { root, database } = seeded, project = "garden";
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [LP6_ADAPTER, "--scenario", scenario, "--trace", trace] };
  const configured = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "lp6-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "lp6-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 100_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:lp6`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const address = { project, block, line: 1 };
  deliveredOf(openSeries(store, { ...address, slice: "lp6", predecessor: null, basis: null } as never));
  const steps: unknown[] = [];
  const f = {
    root, database, project, address, adapter, configured,
    get store() { return store; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    sent(): unknown[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; },
    /**
     * One managed attempt: the batches of these fields on today's routes, every packet written first. Only the answered
     * ones are sent, in order: an applied E4 replaces B1, and the remaining work of the attempt is no longer current.
     */
    async round(ordinal: number, answers: readonly { field: Lp6Field; value?: Json; cannot?: string; unsent?: true; refused?: string }[]) {
      const routes = lp6Routes(store, project);
      const batches = answers.map(answer => routes.value.batches.find(batch => batch.model === "MC2" && batch.task === "input-field"
        && batch.items.some(item => item.field === answer.field && item.consumers.includes(block)))!);
      assert.ok(batches.every(Boolean), `M6 gives ${block} a batch of every named field`);
      const items = batches.flatMap(batch => batch.items);
      const goal: AttemptGoal = { key: `lp6:${answers.map(answer => answer.field).join("+")}`, questions: items.map(item => lp6LineKey(project, item.target, item.field)).sort(),
        result: gapLineExpectedResult(project, items[0]!.target, items[0]!.field) };
      const series = deliveredOf(managedOpenAttempt(store, { ...address, attempt: ordinal, goal,
        completion: { routes: reference(routes), batches: batches.map(batch => batch.id).sort() } } as never));
      const e4: Ref[] = [];
      const packets = batches.map(batch => deliveredOf(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
        environment: reference(configured), attempt: { series: reference(series), ordinal }, previous: [] })).record);
      for (const [index, batch] of batches.entries()) {
        const packet = packets[index]!, answer = answers[index]!;
        if (answer.unsent) continue;
        steps.push({ research: answer.cannot !== undefined
          ? { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap), action: "cannot_answer", reason: answer.cannot }
          : { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
            results: batch.items.map(item => ({ target: item.target, field: item.field, basis: (item as unknown as { record: Ref }).record, value: answer.value })) }, usage: lp6Usage });
        writeFileSync(scenario, JSON.stringify({ database, steps }));
        const sent = await runModelCall(store, { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: "implementer" });
        if (answer.refused !== undefined) {
          assert.equal(sent.ok ? "applied" : sent.refusal.code, answer.refused);
          e4.push(reference(store.list<{ om?: { request: { packet: Ref } } }>("model-call").find(row => row.value.om?.request.packet.id === packet.id)!));
          continue;
        }
        if (!sent.ok) assert.fail(`${sent.refusal.code} at ${JSON.stringify(sent.refusal.at)}: ${sent.refusal.message}`);
        e4.push(reference(sent.value.record));
      }
      return { goal, e4, routes: reference(routes), series: reference(store.get(series.id)!) };
    },
    /** LP7: one managed attempt on today's routing, where the block's open input fields are one batch; the model answers the named ones. */
    async joined(ordinal: number, values: Partial<Record<Lp6Field, Json>>) {
      const routes = lp6Routes(store, project, true);
      const batch = routes.value.batches.find(row => row.task === "input-field" && row.items.some(item => item.consumers.includes(block))
        && new Set(row.items.map(item => item.field)).size > 1)!;
      assert.ok(batch, `Today's routing joins the open input fields of ${block}`);
      const goal: AttemptGoal = { key: `lp7:${ordinal}`, questions: batch.items.map(item => lp6LineKey(project, item.target, item.field)).sort(),
        result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
      const series = deliveredOf(managedOpenAttempt(store, { ...address, attempt: ordinal, goal, completion: { routes: reference(routes), batches: [batch.id] } } as never));
      const packet = deliveredOf(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
        environment: reference(configured), attempt: { series: reference(series), ordinal }, previous: [] })).record;
      steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: batch.items.filter(item => Object.hasOwn(values, item.field))
        .map(item => ({ target: item.target, field: item.field, basis: (item as unknown as { record: Ref }).record, value: values[item.field as Lp6Field]! })) }, usage: lp6Usage });
      writeFileSync(scenario, JSON.stringify({ database, steps }));
      const sent = await runModelCall(store, { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: "implementer" });
      if (!sent.ok) assert.fail(`${sent.refusal.code} at ${JSON.stringify(sent.refusal.at)}: ${sent.refusal.message}`);
      return { goal, e4: [reference(sent.value.record)], routes, batch, outcome: sent.value.outcome };
    },
    /** Closes the attempt by the claim its registry derives (H1 №1737 п.5) — the one producer of a full claim. */
    close(ordinal: number) {
      const claim = deliveredOf(prepareManagedClaim(store, { ...address, attempt: ordinal, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
      return deliveredOf(closeAttempt(store, { ...address, attempt: ordinal, outcome: claim.outcome } as never));
    },
    context(goal: AttemptGoal, ordinal: number, accepting: readonly Ref[]) {
      return { project, block, goal, attempt: { series: reference(store.get(`repair-series:${project}:1:${block}`)!), ordinal }, accepting: [...accepting] };
    },
  };
  return f;
}
const lp6Keys = (store: Store, e4: Ref, context: Parameters<typeof readInputFieldResult>[2]) => {
  const read = deliveredOf(readInputFieldResult(store, e4, context));
  assert.equal(read.relevant, true, "An applied input decision of the block is relevant");
  return read as Extract<typeof read, { relevant: true }>;
};

test("LP6 rows 4, 5, 7, 9: the block's own applied E4 accepts exactly the fields it filled anew — nodes, state, checkKind — whatever their order, packaging, revision or composite goal; an E3 without its own applied D3 accepts nothing", async t => {
  const f = lp6Fields(t);
  const nodes = await f.round(1, [{ field: "nodes", value: ["garden-produce-block", "garden-consume-block"] }]);
  const read = lp6Keys(f.store, nodes.e4[0]!, f.context(nodes.goal, 1, nodes.e4));
  assert.deepEqual(read.filled, [{ target: "garden-B1", field: "nodes", component: null, accepted: ["garden-consume-block", "garden-produce-block"] }]);
  assert.equal(read.keys.length, 1); assert.ok(read.keys[0]!.startsWith(INPUT_FIELD_KEY_PREFIX));
  // Row 4: the provider confirms it for its own attempt and full goal, and the v2 close takes it as a result.
  const confirmed = deliveredOf(confirmResults(f.store, { ...f.context(nodes.goal, 1, nodes.e4), target: f.address.block, cancelling: [] } as never));
  assert.deepEqual(confirmed.achieved.map(item => item.key), read.keys);
  assert.deepEqual(f.close(1).verdict, "progress");
  const state = await f.round(2, [{ field: "state", value: { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-consume-block" } }]);
  const stateKeys = lp6Keys(f.store, state.e4[0]!, f.context(state.goal, 2, state.e4));
  assert.equal(f.close(2).verdict, "progress");
  const check = await f.round(3, [{ field: "checkKind", value: "test" }]);
  const checkKeys = lp6Keys(f.store, check.e4[0]!, f.context(check.goal, 3, check.e4));
  // Row 4: three own applied fields in a row are three results — no false stop of the n-research kind.
  assert.equal(f.close(3).verdict, "progress");
  assert.equal(deliveredOf(readSeries(f.store, f.address as never)).value.stop, null);
  assert.deepEqual(stateKeys.filled.map(item => item.component), ["authority", "rollback", "writer"], "One key per filled component of state");
  assert.equal(stateKeys.keys.length, 3);
  assert.deepEqual(checkKeys.filled, [{ target: "garden-R1#1", field: "checkKind", component: null, accepted: "test" }]);
  // Row 5: the same accepted nodes in another order, in another package (two fields asked together under another
  // composite goal), from another store, revision and E4 id: the same semantic key.
  const g = lp6Fields(t);
  const both = await g.round(1, [{ field: "nodes", value: ["garden-consume-block", "garden-produce-block"] }, { field: "checkKind", unsent: true }]);
  assert.notEqual(both.goal.key, nodes.goal.key); assert.notDeepEqual(both.e4[0], nodes.e4[0]);
  assert.deepEqual(lp6Keys(g.store, both.e4[0]!, g.context(both.goal, 1, both.e4)).keys, read.keys);
  g.restart();
  assert.deepEqual(lp6Keys(g.store, both.e4[0]!, g.context(both.goal, 1, both.e4)).keys, read.keys, "A new Store derives the same key");
  assert.equal(checkKeys.keys.length, 1);
  // Row 7: a part of the assigned fields is applied — the state E4 of a package that also asked checkKind, whose answer
  // was refused by the model: only the applied state gives keys, the open checkKind has no achievement.
  const h = lp6Fields(t);
  const partial = await h.round(1, [{ field: "checkKind", cannot: "The criterion is not decidable here" }, { field: "state", value: { writer: "garden-produce-block" } }]);
  assert.deepEqual(lp6Keys(h.store, partial.e4[1]!, h.context(partial.goal, 1, partial.e4)).filled.map(item => item.component), ["writer"]);
  // Row 9: the refused E4 has no applied D3 of its own: it is no result of this kind, and as accepting it is refused.
  assert.deepEqual(deliveredOf(readInputFieldResult(h.store, partial.e4[0]!, h.context(partial.goal, 1, partial.e4))), { relevant: false });
  const refused = refusalOf(confirmResults(h.store, { ...h.context(partial.goal, 1, [partial.e4[0]!]), target: h.address.block, cancelling: [] } as never));
  assert.deepEqual([refused.code, refused.at.field], ["achievement_unconfirmed", "outcome.accepting.0"]);
});

test("LP6 rows 6, 8: state filled in parts and filled at once give one set of keys; a component known before the E4 is no new key, and an own E4 that filled nothing anew accepts nothing", async t => {
  const parts = lp6Fields(t), whole = lp6Fields(t);
  const all = { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-consume-block" };
  const once = await whole.round(1, [{ field: "state", value: all }]);
  const onceKeys = lp6Keys(whole.store, once.e4[0]!, whole.context(once.goal, 1, once.e4)).keys;
  const first = await parts.round(1, [{ field: "state", value: { writer: all.writer } }]);
  const firstKeys = lp6Keys(parts.store, first.e4[0]!, parts.context(first.goal, 1, first.e4)).keys;
  parts.close(1);
  // The writer is known on the new B1: deciding it again with the two others makes keys of the two others only.
  const second = await parts.round(2, [{ field: "state", value: all }]);
  const secondRead = lp6Keys(parts.store, second.e4[0]!, parts.context(second.goal, 2, second.e4));
  assert.deepEqual(secondRead.filled.map(item => item.component), ["authority", "rollback"]);
  assert.deepEqual([...firstKeys, ...secondRead.keys].sort(), [...onceKeys].sort(), "The union does not depend on the packaging");
  parts.close(2);
  // Row 8: an own answer deciding only what B1 already holds is not applied by D3 at all, so it never reaches a B1
  // replacement it could hide behind: no applied E4, no key, and as accepting it is refused. (The provider also reads an
  // applied E4 that filled nothing anew as relevant without keys — the no-op the close requires of every own E4.)
  const none = lp6Fields(t);
  const writer = await none.round(1, [{ field: "state", value: { writer: all.writer, authority: all.authority } }]);
  none.close(1);
  const again = await none.round(2, [{ field: "state", value: { writer: all.writer }, refused: "record_missing" }]);
  assert.equal(none.store.get("om-input:garden")!.revision, 2, "The answer that filled nothing replaced no B1");
  assert.deepEqual(deliveredOf(readInputFieldResult(none.store, again.e4[0]!, none.context(again.goal, 2, again.e4))), { relevant: false });
  const refused = refusalOf(confirmResults(none.store, { ...none.context(again.goal, 2, again.e4), target: none.address.block, cancelling: [] } as never));
  assert.equal(refused.code, "achievement_unconfirmed");
  assert.equal(writer.e4.length, 1);
});

test("LP6 row 10: a genuine applied E4 confirms nothing for another attempt, block, line or full goal, nor under another binding — the whole result is refused at its address", async t => {
  const f = lp6Fields(t);
  const nodes = await f.round(1, [{ field: "nodes", value: ["garden-produce-block", "garden-consume-block"] }]);
  const own = f.context(nodes.goal, 1, nodes.e4);
  const cases: [string, Record<string, unknown>][] = [
    ["another attempt", { ...own, attempt: { ...own.attempt, ordinal: 2 } }],
    ["another block", { ...own, block: "garden-produce-block" }],
    ["another full goal", { ...own, goal: { ...nodes.goal, questions: [...nodes.goal.questions, "another-question"] } }],
    ["another key of the goal", { ...own, goal: { ...nodes.goal, key: "lp6:other" } }],
    ["another binding", { ...own, managedClosure: { binding: f.adapter, work: f.adapter, additions: [], journal: null } }],
  ];
  for (const [name, context] of cases) {
    const refused = refusalOf(readInputFieldResult(f.store, nodes.e4[0]!, context as never));
    assert.deepEqual([refused.code, refused.at.ref], ["achievement_unconfirmed", nodes.e4[0]], name);
  }
  // Another line of the same block is another series: the record is read under its own exact attempt only.
  const line2 = { ...own, attempt: { series: { ...own.attempt.series, id: "repair-series:garden:2:garden-consume-block" }, ordinal: 1 } };
  assert.equal(readInputFieldResult(f.store, nodes.e4[0]!, line2 as never).ok, false);
  // A record that is no E4 of this project is not even read as one.
  assert.equal(refusalOf(readInputFieldResult(f.store, f.adapter, own)).code, "achievement_unconfirmed");
});

test("LP7 rows 23, 24: one answer to the joined input fields proves exactly the LP6 keys the split routing proves by parts, state components included; an answer of some proves only theirs, and their rest is joined again on the next B1", async t => {
  const values: Record<Lp6Field, Json> = { nodes: ["garden-produce-block", "garden-consume-block"], checkKind: "test",
    state: { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-consume-block" } };
  // The split packaging: the base code's routing, one E4 and one B1 revision per field.
  const split = lp6Fields(t), splitKeys: string[] = [];
  for (const [index, field] of (["nodes", "state", "checkKind"] as const).entries()) {
    const round = await split.round(index + 1, [{ field, value: values[field] }]);
    splitKeys.push(...lp6Keys(split.store, round.e4[0]!, split.context(round.goal, index + 1, round.e4)).keys);
    split.close(index + 1);
  }
  assert.equal(split.store.get("om-input:garden")!.revision, 4);
  // Row 23: today's routing joins them — one answer, one E4, one B1 revision, the very same set of keys.
  const joined = lp6Fields(t), before = joined.store.get("om-input:garden")!.revision, once = await joined.joined(1, values);
  assert.deepEqual([once.routes.value.grouping, [...new Set(once.batch.items.map(item => item.field))].sort()], ["block-input-v1", ["checkKind", "nodes", "state"]]);
  assert.deepEqual([once.outcome?.kind, once.outcome?.unanswered], ["input-decisions", []]);
  assert.equal(joined.store.get("om-input:garden")!.revision, before + 1, "One application, one B1 revision");
  const onceRead = lp6Keys(joined.store, once.e4[0]!, joined.context(once.goal, 1, once.e4));
  assert.deepEqual([...onceRead.keys].sort(), [...splitKeys].sort(), "Packaging does not change the subject keys");
  assert.deepEqual(onceRead.filled.filter(item => item.field === "state").map(item => item.component).sort(), ["authority", "rollback", "writer"]);
  // Row 24: nodes and a part of state are proved alone; checkKind and the rest of state stay open and join on the new B1.
  const some = lp6Fields(t), part = await some.joined(1, { nodes: values.nodes, state: { writer: "garden-produce-block" } });
  assert.deepEqual(part.outcome?.unanswered, part.batch.items.filter(item => item.field === "checkKind").map(item => item.gap));
  const partRead = lp6Keys(some.store, part.e4[0]!, some.context(part.goal, 1, part.e4));
  assert.deepEqual(partRead.filled.map(item => `${item.field}/${item.component}`).sort(), ["nodes/null", "state/writer"]);
  some.close(1);
  const rest = await some.joined(2, { state: values.state, checkKind: values.checkKind });
  assert.deepEqual([...new Set(rest.batch.items.map(item => item.field))].sort(), ["checkKind", "state"], "The rest is one batch again");
  const restRead = lp6Keys(some.store, rest.e4[0]!, some.context(rest.goal, 2, rest.e4));
  assert.deepEqual(restRead.filled.filter(item => item.field === "state").map(item => item.component).sort(), ["authority", "rollback"], "A component decided before is no new key");
  assert.deepEqual([...partRead.keys, ...restRead.keys].sort(), [...splitKeys].sort());
});

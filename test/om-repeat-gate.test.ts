import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import { writeGuarded } from "../src/om/refs.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { ProductEngine } from "../src/product/engine.js";
import { fillObligations, prepareFrame, readFrame, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { LayerProposal, ProposalRequest } from "../src/om/frame-proposals.js";
import { writeCandidate, readCandidate, gateCandidate, type FrameCandidateRecord } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { gardenGraph, createOmFixture } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { writeGaps, type GapReadRequest, type GapRequest } from "../src/om/gaps.js";
import { gapLineKey, gapLineExpectedResult } from "../src/om/gap-lines.js";
import { writeRoutes } from "../src/om/routes.js";
import {
  classifyRefusal, journalId, normalizeOriginSource, originSourceKey, recordRefusal, unitRefusalNamespace,
  REFUSAL_JOURNAL_KIND, UNIT_REFUSAL_KIND, type RefusalJournal, type OriginSource,
} from "../src/om/refusal-journal.js";
import {
  beginAttempt, completeAttempt, openSeries, resumeSeries, seriesId,
  STOP_REVIEW_KIND, stopReviewNamespace,
  type AttemptGoal, type BeginAttemptRequest, type ClaimedOutcome, type ClaimedRefusal, type RepairSeries, type SeriesRequest,
} from "../src/om/series.js";
import {
  readDefinitions, readOriginHoldAt, closeAttempt, liftOriginHold, openAttempt, prepareCloseAttempt, prepareLiftOriginHold, prepareOpenAttempt, readStopContext, stopContext,
  originAnalysisNamespace, originDecisionNamespace, originHoldId, originHoldNamespace,
  ADDRESSEE_KINDS, GATE_REFUSAL_CODES, LIFT_GROUNDS, ORIGIN_ANALYSIS_KIND, ORIGIN_DECISION_KIND, ORIGIN_HOLD_KIND,
  ORIGIN_ROLES, REFUSAL_CLASSES, REFUSAL_STAGES, REPEAT_GATE_CODES, SUBJECT_DECISIONS,
  type CloseAttemptRequest, type GateOutcome, type LiftOriginHoldRequest, type OriginHold, type RefusalClass,
  type RepeatOutcome, type RoutedRefusal,
} from "../src/om/repeat-gate.js";

const UNIT = "gate-repeat";
const PROJECT = "alpha";
const BLOCK = "block:cart";
const SLICE = "slice:cart@1";
const SUBJECT = "artifact:cart";
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;
const typedDefect = (error: unknown): boolean =>
  error instanceof EngineError
  && ["repeat_request_invalid", "series_request_invalid", "journal_request_invalid"].includes(error.code);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-om-gate-"));
  const path = join(root, "live.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store };
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

function addressed(refusal: Refusal, expected: string, target: string): Refusal {
  assert.equal(refusal.code, expected);
  assert.equal(refusal.at.unit, UNIT);
  assert.equal(refusal.at.target, target);
  assert.ok(refusal.message.length > 0);
  assert.ok(REFUSAL_ROUTES.includes(refusal.route));
  return refusal;
}

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
let unique = 0;
const next = (): number => (unique += 1);

const address = (project: string, line = 1): SeriesRequest => ({ project, block: BLOCK, line });
const at = (project: string, line = 1): string => seriesId(project, BLOCK, line);

/** Exact accepted sources: the initial L1 has no local operation artifact; accepted OM L2 does. */
interface DefinitionFixture { first: FrameRequest; accepted: FrameRequest; upper: Graph; subject?: string; baseAbsent?: Ref }
const definitionFixtures = new WeakMap<Store, Map<string, DefinitionFixture>>();
const sourceContexts = new Map<string, Record<string, unknown>>();
function remember(ref: Ref, context: Record<string, unknown>): Ref {
  sourceContexts.set(`${ref.id}@${ref.revision}:${ref.hash}`, context); return ref;
}
function initialFrame(store: Store, project: string) {
  const graph = gardenGraph("standard", project);
  const oldArtifact = `${project}-prep`;
  graph.artifacts.find(item => item.id === oldArtifact)!.id = SUBJECT;
  for (const node of graph.nodes) if (node.outcome === oldArtifact) node.outcome = SUBJECT;
  for (const connector of graph.connectors) if (connector.artifact === oldArtifact) connector.artifact = SUBJECT;
  const { level: _level, ...upper } = projectGraph(graph, 1);
  preparedFeatures(new ProductEngine(store), project, upper as Graph);
  const input = deliveredOf(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, choice: { choiceVersion: "origin-initial", features: [{ outcome: `${project}-result` }], excluded: [] }, available: {} }));
  const first: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!),
    horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  return { graph, upper: upper as Graph, input, first };
}
function definitionFixture(store: Store, project: string): DefinitionFixture {
  const cache = definitionFixtures.get(store) ?? new Map<string, DefinitionFixture>(); definitionFixtures.set(store, cache);
  const previous = cache.get(project); if (previous) return previous;
  const { graph, upper, input, first } = initialFrame(store, project);
  const read = deliveredOf(prepareFrame(store, first)), projected = projectGraph(graph, 2);
  const mapped = deliveredOf(fillObligations(read.upper as Graph, read.scope as FrameScope,
    { graph, reference: { ...first.graph, hash: hashJson(graph) }, frame: null }, read.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: first.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: projected.nodes.filter(node => node.kind === "operation"), fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const offered = reference(store.write({ id: `om-proposal:${project}:origin-accepted`, kind: "layer-proposal", expected: 0, value: proposal }));
  const candidate = deliveredOf(writeCandidate(store, { frame: first, proposals: [offered] }));
  assert.equal(candidate.state, "candidate"); if (candidate.state !== "candidate") throw new Error("No candidate");
  const ref = reference(candidate.record);
  const applied = deliveredOf(settleCandidate(store, { project, level: 2, candidate: ref,
    outcome: { gate: "G3", candidate: ref, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  const nextHorizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(applied.graph!),
    refinement: reference(applied.layer!), choice: { choiceVersion: "origin-accepted", features: [{ outcome: `${project}-result` }], excluded: [] }, available: {} }));
  const accepted: FrameRequest = { ...first, graph: reference(applied.graph!), horizon: reference(nextHorizon.gate),
    layer: reference(applied.layer!), frame: reference(applied.frame!) };
  remember(first.graph, { kind: "frame", request: first }); remember(accepted.graph, { kind: "frame", request: accepted });
  const built = { first, accepted, upper: upper as Graph }; cache.set(project, built); return built;
}

/** Actual stored sections are observed, even when the payload is semantically unfit for acceptance. */
function carries(store: Store, project: string, role: string, definitions: readonly string[], over: Record<string, unknown> = {}): Ref {
  if (role === "workspace") return reference(store.write({ id: `workspace:${project}:${next()}`, kind: "workspace", expected: 0, value: over as Json }));
  const f = definitionFixture(store, project);
  if (role === "base" || role === "basis") return definitions.includes(f.subject ?? SUBJECT) ? f.accepted.graph : f.baseAbsent ?? f.first.graph;
  const artifacts = definitions.map(id => ({ ...structuredClone(f.upper.artifacts[0]!), id }));
  const request: ProposalRequest = { frame: f.first, proposals: [] };
  if (role === "proposal") {
    const value: LayerProposal = { base: { graph: f.first.graph, frame: null }, level: 2, source: "decision", status: "proposed",
      nodes: [], fills: [], localConnectors: [], artifacts, contracts: [], joins: [], tests: [], edges: [], journeys: [], packets: [],
      transfers: [], anchors: [], removes: [], replaces: [], redefines: [], ...over };
    const ref = reference(store.write({ id: `om-proposal:${project}:${next()}`, kind: "layer-proposal", expected: 0, value }));
    return remember(ref, { kind: "proposal", request: { ...request, proposals: [ref] } });
  }
  const graph = structuredClone(f.upper);
  graph.artifacts = [...graph.artifacts.filter(item => !definitions.includes(item.id)), ...artifacts];
  const value: FrameCandidateRecord = { project, level: 2, graph, graphHash: hashJson(graph), layerHash: hashJson(projectGraph(graph, 2)),
    upperHash: hashJson(projectGraph(f.upper, 1)), base: { graph: f.first.graph, frame: null }, proposals: [], fills: [], request, ...over };
  const id = `om-candidate:${project}:${hashJson([value.graphHash, value.base, value.proposals])}`;
  const current = store.get(id);
  return reference(current ?? store.write({ id, kind: "frame-candidate", expected: 0, value }));
}

const source = (role: string, ref: Ref): Record<string, unknown> => {
  const context = sourceContexts.get(`${ref.id}@${ref.revision}:${ref.hash}`);
  return { role, ref, ...(context ? { context } : {}) };
};

/** Build one explicitly linked assembly; no journal or gate helper repairs its supplied sources. */
function assembly(store: Store, project: string, shape: {
  proposals?: readonly (readonly string[])[]; bases?: readonly boolean[]; derived?: readonly (readonly string[])[]; frame?: FrameRequest;
}): OriginSource[] {
  const f = definitionFixture(store, project), frame = shape.frame ?? (shape.bases?.some(Boolean) ? f.accepted : f.first);
  const artifacts = (definitions: readonly string[]) => definitions.map(id => ({ ...structuredClone(f.upper.artifacts[0]!), id }));
  const proposals = (shape.proposals ?? []).map(definitions => reference(store.write({ id: `om-proposal:${project}:assembly-${next()}`,
    kind: "layer-proposal", expected: 0, value: { base: { graph: frame.graph, frame: frame.frame }, level: frame.level,
      source: "decision", status: "proposed", nodes: [], fills: [], localConnectors: [], artifacts: artifacts(definitions), contracts: [],
      joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] } })));
  const request: ProposalRequest = { frame, proposals: [...proposals].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1) };
  const proposalSources: OriginSource[] = proposals.map(ref => ({ role: "proposal", ref, context: { kind: "proposal", request } }));
  const absentBase = shape.bases?.some(holds => !holds)
    ? f.baseAbsent ?? deliveredOf(readFrame(store, frame)).upperRef : null;
  const baseSources: OriginSource[] = (shape.bases ?? []).map(holds => ({ role: "base",
    ref: holds ? frame.graph : absentBase!, context: { kind: "frame", request: frame } }));
  const derivedSources: OriginSource[] = (shape.derived ?? []).map(definitions => {
    const graph = structuredClone(f.upper);
    graph.artifacts = [...graph.artifacts.filter(item => !definitions.includes(item.id)), ...artifacts(definitions)];
    const value: FrameCandidateRecord = { project, level: 2, graph, graphHash: hashJson(graph), layerHash: hashJson(projectGraph(graph, 2)),
      upperHash: hashJson(projectGraph(f.upper, 1)), base: { graph: frame.graph, frame: frame.frame }, proposals: request.proposals,
      fills: [], request };
    const id = `om-candidate:${project}:${hashJson([value.graphHash, value.base, value.proposals])}`;
    return { role: "derived", ref: reference(store.get(id) ?? store.write({ id, kind: "frame-candidate", expected: 0, value })) };
  });
  return [...proposalSources, ...baseSources, ...derivedSources];
}

/** A refusal a gate really wrote, journalled through the accepted API of A2, with the origin G7 weighs. */
function journalled(store: Store, project: string, origin: Record<string, unknown> = {}, over: Record<string, unknown> = {}): ClaimedRefusal {
  const name = String(over['code'] ?? `graph_invalid:${next()}`);
  const goal = String(over['goal'] ?? "every artifact an operation consumes is produced somewhere in the layer");
  const record = store.write({
    id: `${unitRefusalNamespace(project)}g:${next()}`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: {
      gate: String(over['gate'] ?? "G3"),
      refusals: [{
        code: name, goal, remedy: "add the producer of the artifact to the proposal",
        origin: {
          name: "artifact_missing", stage: "layer-check", subject: SUBJECT, sources: [],
          ...origin,
        },
      }],
    } as Json,
  });
  const journal = deliveredOf(recordRefusal(store, { project, source: reference(record) }));
  return { name, goal, row: journal.value.rows[journal.value.rows.length - 1]!.id };
}

/** The refusal of the rules' own example, in each of the three shapes the origin can take. */
function artifactMissing(store: Store, project: string, shape: "proposal" | "derivation" | "input"): ClaimedRefusal {
  const sources = shape === "proposal" ? assembly(store, project, { proposals: [["artifact:tax"]], bases: [false], derived: [["artifact:tax"]] })
    : shape === "derivation" ? assembly(store, project, { proposals: [[SUBJECT]], bases: [false], derived: [["artifact:order"]] })
    : assembly(store, project, { bases: [true], derived: [[SUBJECT]] });
  return journalled(store, project, { sources });
}

const goal = (over: Partial<AttemptGoal> = {}): AttemptGoal => ({
  key: "gap:cart:price",
  questions: ["which node produces the price of a cart line?"],
  result: "an accepted layer proposal naming the producer",
  ...over,
});

/** The outcome of a cycle as the gate takes it: its results named by the records that accepted them, never by keys. */
const outcome = (over: Partial<GateOutcome> = {}): GateOutcome =>
  ({ reason: "result", accepting: [], cancelling: [], refusals: [], ...over }) as GateOutcome;

const refusedBy = (...refusals: readonly ClaimedRefusal[]): GateOutcome =>
  outcome({ reason: "refused", refusals: [...refusals] });

/** The outcome as the SERIES takes it directly — only for scaffolding a state around the gate, as a rival would. */
const seriesOutcome = (reason: ClaimedOutcome["reason"]): ClaimedOutcome =>
  ({ reason, achieved: [], cancelled: [], refusals: [] }) as ClaimedOutcome;

function opened(store: Store, project = PROJECT, line = 1, over: Record<string, unknown> = {}) {
  return deliveredOf(openSeries(store, {
    ...address(project, line), slice: SLICE, predecessor: null, basis: null, ...over,
  } as Parameters<typeof openSeries>[1]));
}

const heldSeries = (store: Store, project = PROJECT, line = 1): Revision<RepairSeries> | null =>
  store.get<RepairSeries>(at(project, line));

const heldJournal = (store: Store, project = PROJECT): Revision<RefusalJournal> | null =>
  store.get<RefusalJournal>(journalId(project));

const ordinalOf = (store: Store, project = PROJECT, line = 1): number => {
  const value = heldSeries(store, project, line)!.value;
  return value.inherited.length + value.attempts.length + 1;
};

/** One completed cycle, closed AT THE GATE: the goal named first, then the outcome handed to G7 once. */
function closed(store: Store, project: string, g: AttemptGoal, o: GateOutcome, line = 1): RepeatOutcome {
  const attempt = ordinalOf(store, project, line);
  deliveredOf(openAttempt(store, { ...address(project, line), attempt, goal: g }));
  return deliveredOf(closeAttempt(store, { ...address(project, line), attempt, outcome: o }));
}

const routeOf = (result: RepeatOutcome, row: string): RoutedRefusal =>
  result.routed.find(item => item.row === row) ?? assert.fail(`no route for ${row}`);

const classes = (result: RepeatOutcome): string[] => result.routed.map(item => item.class).sort();

/** The record of a review of a stop with an independent reviewer — what A6 will write, as A3 reads it. */
const review = (project: string, stop: number, goals: readonly string[]) => ({
  projectId: project, block: BLOCK, stop, goals: [...goals],
  reviewer: { name: "a reviewer who is not the executor", independent: true },
  cause: "the same question goes to the same producer every cycle",
  change: { text: "ask M5 to address the gap before a layer is proposed", addresses: ["M5"] },
});

const byReview = (store: Store, project: string, stop: number, goals: readonly string[]) => ({
  ground: "review-record" as const, text: "the review named a cause and a change",
  review: {
    ref: reference(store.write({
      id: `${stopReviewNamespace(project)}${next()}`, kind: STOP_REVIEW_KIND, expected: 0,
      value: review(project, stop, goals) as unknown as Json,
    })),
  },
});

/**
 * The record of the analysis of an origin — what A6 will write, and all this gate reads of it. "independent" and
 * "final" are in it on purpose: the gate must not lift a hold because a record says so about itself.
 */
const analysisOf = (hold: OriginHold, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId: hold.projectId, block: hold.block, attempt: hold.attempt, row: hold.row,
  class: "conditions", basis: [], reviewer: { independent: true }, final: true, ...over,
});

/** The record of the owner's decision about one hold — what the command API of H2 will write. */
const decisionOf = (hold: OriginHold, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId: hold.projectId, block: hold.block, attempt: hold.attempt, row: hold.row,
  decided: "go on: I have read the origin and the facts, and the refusal stays where it is", approved: true, ...over,
});

const storedAs = (store: Store, kind: string, namespace: string, value: Record<string, unknown>): Ref =>
  reference(store.write({ id: `${namespace}${next()}`, kind, expected: 0, value: value as Json }));

const holdAt = (store: Store, ref: Ref): OriginHold => store.get<OriginHold>(ref.id)!.value;

/** A cycle that ran into a refusal of unknown origin, closed at the gate, and the hold it raised. */
function heldBy(store: Store, project: string, line = 1): { refusal: ClaimedRefusal; result: RepeatOutcome; hold: Ref } {
  const refusal = journalled(store, project, { sources: [] });
  const result = closed(store, project, goal(), refusedBy(refusal), line);
  assert.equal(result.holds.length, 1);
  return { refusal, result, hold: result.holds[0]! };
}

const liftBy = (project: string, hold: Ref, ground: LiftOriginHoldRequest["ground"], record: LiftOriginHoldRequest["record"]): LiftOriginHoldRequest =>
  ({ project, hold, ground, record });

test("a refusal of the proposal reaches the gate with its class, its addressee and its route, in one transaction", t => {
  const { store } = fixture(t);
  opened(store);
  const refusal = artifactMissing(store, PROJECT, "proposal");
  const journalBefore = heldJournal(store)!;
  const seriesBefore = heldSeries(store)!;

  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const result = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) }));

  // The class comes from the origin: the definition is in neither the proposal nor the base, so the proposal is what
  // is corrected, and the question goes to M5 and MC2 by THIS node.
  assert.equal(result.routed.length, 1);
  const routed = result.routed[0]!;
  assert.equal(routed.row, refusal.row);
  assert.equal(routed.class, "proposal");
  assert.equal(routed.addressee, `${ADDRESSEE_KINDS.proposal}:${SUBJECT}`);
  assert.equal(routed.toModel, true);
  assert.deepEqual(result.question, [SUBJECT]);
  assert.deepEqual(routed.basis.map(item => item.role), ["base", "derived", "proposal"]);

  // The verdict, the count and the stop are the series' own findings, reported here and not counted again.
  assert.equal(result.attempt, 1);
  assert.equal(result.verdict, "none");
  assert.equal(result.withoutProgress, 1);
  assert.equal(result.stop, null);
  assert.equal(result.ladder, null);
  assert.equal(result.context, null);
  // A refusal of the proposal is the gate's pass to M5, not a refusal of the gate itself.
  assert.deepEqual(result.refusals, []);

  // Both records moved, by ONE transaction and by one revision each.
  const journal = heldJournal(store)!;
  const series = heldSeries(store)!;
  assert.equal(journal.revision, journalBefore.revision + 1);
  assert.deepEqual(journal.value.classifications, [{
    row: refusal.row, class: "proposal", addressee: `${ADDRESSEE_KINDS.proposal}:${SUBJECT}`,
    basis: [...routed.basis],
  }]);
  // The row itself is untouched: a classification stands beside what the gate reported, never inside it.
  assert.deepEqual(journal.value.rows, journalBefore.value.rows);
  assert.equal(series.value.attempts[0]!.outcome!.reason, "refused");
  assert.equal(series.value.attempts[0]!.verdict, "none");
  assert.ok(series.revision > seriesBefore.revision);

  // Delivering the same cycle again is a repeat: no revision of either record, and the same report.
  const again = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) }));
  assert.deepEqual(again, result);
  assert.equal(heldJournal(store)!.revision, journal.revision);
  assert.equal(heldSeries(store)!.revision, series.revision);

  // And still a repeat after a LATER event has moved both records on: a delivery that arrives late finds its own
  // cycle already closed and changes nothing (T5). What it is told about the SERIES is the series as it stands —
  // the count is the series' finding now, not a copy of the count this cycle once left behind.
  closed(store, PROJECT, goal(), refusedBy(artifactMissing(store, PROJECT, "input")));
  const later = { series: heldSeries(store)!.revision, journal: heldJournal(store)!.revision };
  const late = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) }));
  assert.deepEqual(late.routed, result.routed);
  assert.deepEqual(late.question, result.question);
  assert.equal(late.attempt, 1);
  assert.equal(late.verdict, "none");
  assert.equal(late.withoutProgress, 2);
  assert.equal(heldSeries(store)!.revision, later.series);
  assert.equal(heldJournal(store)!.revision, later.journal);
});

test("the refusals of a cycle are an unordered set: another order is the same decisions, written the same way (T6)", t => {
  const { store, path } = fixture(t);
  opened(store);
  const refusals = [
    artifactMissing(store, PROJECT, "proposal"),
    artifactMissing(store, PROJECT, "input"),
    artifactMissing(store, PROJECT, "derivation"),
  ];
  const result = closed(store, PROJECT, goal(), refusedBy(...refusals));
  const written = heldJournal(store)!;

  // The same set in another order is the same cycle: no revision of either record, and the same report.
  const again = deliveredOf(closeAttempt(store, {
    ...address(PROJECT), attempt: 1, outcome: refusedBy(refusals[2]!, refusals[0]!, refusals[1]!),
  }));
  assert.deepEqual(again.routed, result.routed);
  assert.deepEqual(again.question, result.question);
  assert.equal(heldJournal(store)!.hash, written.hash);
  assert.equal(heldJournal(store)!.revision, written.revision);

  // One row named twice in ONE cycle is one refusal and one class. The SERIES keeps the multiplicity it was given, so
  // the same rows named a different number of times are a different outcome — that is the series' rule, not a class
  // decided twice here.
  const twice = artifactMissing(store, PROJECT, "input");
  const doubled = closed(store, PROJECT, goal(), refusedBy(twice, twice, refusals[0]!));
  assert.deepEqual(doubled.routed.map(item => item.row).sort(), [twice.row, refusals[0]!.row].sort());
  assert.deepEqual(heldSeries(store)!.value.attempts[1]!.outcome!.refusals.map(item => item.row).sort(),
    [twice.row, twice.row, refusals[0]!.row].sort());
  assert.equal(heldJournal(store)!.value.classifications.length, 4);
  assert.equal(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 2, outcome: refusedBy(twice, refusals[0]!) })).code, "outcome_conflict");
  store.close();

  // What makes the FIRST write order-independent too: the decisions are written in the canonical order of the rows,
  // whatever order they were delivered in, and each decision is a function of its row alone.
  const rows = refusals.map(item => item.row);
  assert.deepEqual(result.routed.map(item => item.row), [...rows].sort());
  assert.deepEqual(written.value.classifications.slice(0, 3).map(item => item.row), [...rows].sort());

  // A journal whose very first write came from the other order holds them in that same canonical order.
  const other = new Store(join(path, "..", "other.sqlite"));
  t.after(() => other.close());
  opened(other);
  const mirrored = [
    artifactMissing(other, PROJECT, "proposal"),
    artifactMissing(other, PROJECT, "input"),
    artifactMissing(other, PROJECT, "derivation"),
  ];
  const order = mirrored.map(item => item.row).sort();
  const first = closed(other, PROJECT, goal(), refusedBy(mirrored[1]!, mirrored[2]!, mirrored[0]!));
  assert.deepEqual(first.routed.map(item => item.row), order);
  assert.deepEqual(other.get<RefusalJournal>(journalId(PROJECT))!.value.classifications.map(item => item.row), order);
});

test("the rules' own example: missing from the proposal is a project refusal, lost by the assembly is an error of derivation", t => {
  const { store } = fixture(t);
  opened(store);
  const missing = artifactMissing(store, PROJECT, "proposal");
  const lost = artifactMissing(store, PROJECT, "derivation");
  const unfit = artifactMissing(store, PROJECT, "input");

  const first = closed(store, PROJECT, goal(), refusedBy(missing));
  assert.equal(routeOf(first, missing.row).class, "proposal");
  assert.equal(routeOf(first, missing.row).toModel, true);
  assert.deepEqual(first.question, [SUBJECT]);

  // It WAS in the proposal and is not in what the code assembled. The assembler is corrected, and the model is not
  // asked to put back what it already gave: this refusal does not travel to it.
  const second = closed(store, PROJECT, goal(), refusedBy(lost));
  const derived = routeOf(second, lost.row);
  assert.equal(derived.class, "derivation");
  assert.equal(derived.toModel, false);
  assert.deepEqual(second.question, []);
  // The addressee names the record that lost it, so the code to correct is identified, not merely described.
  const candidate = derived.basis.find(item => item.role === "derived")!;
  assert.equal(derived.addressee, `${ADDRESSEE_KINDS.derivation}:${candidate.ref.id}`);

  // An accepted record of a producer holds it and nothing lost it: the producer of that record is corrected.
  const third = closed(store, PROJECT, goal(), refusedBy(unfit));
  const input = routeOf(third, unfit.row);
  assert.equal(input.class, "input");
  assert.equal(input.toModel, false);
  assert.deepEqual(third.question, []);
  assert.equal(input.addressee, `${ADDRESSEE_KINDS.input}:${input.basis.find(item => item.role === "base")!.ref.id}`);

  // The same three names, the same three goals — the class came from the origin, never from the name.
  const names = [missing, lost, unfit].map(item => item.name.split(":")[0]);
  assert.deepEqual([...new Set(names)], ["graph_invalid"]);
  assert.deepEqual(heldJournal(store)!.value.classifications.map(item => item.class), ["proposal", "derivation", "input"]);
});

test("a mixed set gives every refusal its own class and route, and none of them is lost behind another", t => {
  const { store } = fixture(t);
  opened(store);
  const project = artifactMissing(store, PROJECT, "proposal");
  const derivation = artifactMissing(store, PROJECT, "derivation");
  const input = artifactMissing(store, PROJECT, "input");
  const conditions = journalled(store, PROJECT, {
    stage: "feasibility", subject: "workspace",
    sources: [source("environment", carries(store, PROJECT, "workspace", [], { dirty: true }))],
  }, { gate: "G6", code: "repository_dirty" });
  const readiness = journalled(store, PROJECT, {
    stage: "readiness", subject: "block:cart",
    sources: [source("base", carries(store, PROJECT, "basis", ["block:cart"]))],
  }, { gate: "M2", code: "readiness_stale" });
  const unknown = journalled(store, PROJECT, { sources: [] }, { gate: "G5", code: "work_not_atomic" });

  const all = [project, derivation, input, conditions, readiness, unknown];
  const result = closed(store, PROJECT, goal(), refusedBy(...all));

  // Every refusal is routed, and no class is missing from the set.
  assert.equal(result.routed.length, all.length);
  assert.deepEqual(classes(result), [...REFUSAL_CLASSES].sort());
  assert.deepEqual([...new Set(result.routed.map(item => item.row))].length, all.length);
  assert.equal(routeOf(result, project.row).class, "proposal");
  assert.equal(routeOf(result, derivation.row).class, "derivation");
  assert.equal(routeOf(result, input.row).class, "input");
  assert.equal(routeOf(result, conditions.row).class, "conditions");
  assert.equal(routeOf(result, readiness.row).class, "readiness");
  assert.equal(routeOf(result, unknown.row).class, "unknown");

  // The errors of the input and of the derivation do not travel to the model with the project ones.
  assert.deepEqual(result.question, [SUBJECT]);
  assert.deepEqual(result.routed.filter(item => item.toModel).map(item => item.class), ["proposal"]);

  // Each class keeps its own addressee, and every decision is saved in the journal.
  assert.equal(routeOf(result, conditions.row).addressee, `${ADDRESSEE_KINDS.conditions}:workspace`);
  assert.equal(routeOf(result, readiness.row).addressee, `${ADDRESSEE_KINDS.readiness}:${BLOCK}`);
  assert.equal(routeOf(result, unknown.row).addressee, `${ADDRESSEE_KINDS.unknown}:${at(PROJECT)}`);
  const stored = heldJournal(store)!.value.classifications;
  assert.equal(stored.length, all.length);
  for (const item of result.routed) {
    assert.equal(stored.find(entry => entry.row === item.row)!.class, item.class);
    assert.equal(stored.find(entry => entry.row === item.row)!.addressee, item.addressee);
  }

  // The gate's own refusals name what it did with them, each addressed and routed.
  const own = new Map(result.refusals.map(item => [item.at.field, item]));
  assert.equal(own.get(input.row)!.code, "handed_to_producer");
  assert.equal(own.get(input.row)!.route, "producer");
  assert.equal(own.get(derivation.row)!.code, "handed_to_producer");
  assert.equal(own.get(conditions.row)!.code, "beyond_block");
  assert.equal(own.get(conditions.row)!.route, "owner");
  assert.equal(own.get(unknown.row)!.code, "origin_unestablished");
  assert.deepEqual(own.get(unknown.row)!.at.ref, result.holds[0]);
  assert.equal(result.holds.length, 1);
  // A project refusal and a review of readiness are passes of the gate, not refusals of it.
  assert.equal(own.has(project.row), false);
  assert.equal(own.has(readiness.row), false);
  assert.deepEqual([...new Set(result.refusals.map(item => item.code))].sort(),
    ["beyond_block", "handed_to_producer", "origin_unestablished"]);
});

test("an origin that cannot be placed raises a hold AT ONCE, and no project question is raised for it", t => {
  const { store, path } = fixture(t);
  const both = () => assembly(store, PROJECT, { proposals: [[SUBJECT]], bases: [true] });
  const cases: [string, Record<string, unknown>][] = [
    ["an origin that names no source at all", { sources: [] }],
    ["a stage this gate does not name", { stage: "somewhere-else", sources: both() }],
    ["a role this gate does not name", { sources: [source("hearsay", carries(store, PROJECT, "proposal", [SUBJECT]))] }],
    ["nothing of the map to weigh the subject against", { sources: [source("environment", carries(store, PROJECT, "workspace", []))] }],
    ["two accepted holders of one definition", { sources: both() }],
    // The reviewer's two: what the assembly holds says nothing about the proposal, and two holders single out nobody.
    ["only what the code assembled, holding the subject", { sources: [source("derived", carries(store, PROJECT, "candidate", [SUBJECT]))] }],
    ["two accepted records both holding the subject", {
      sources: [source("base", carries(store, PROJECT, "base", [SUBJECT])), source("base", carries(store, PROJECT, "base", [SUBJECT]))],
    }],
  ];
  opened(store);
  const refusals = cases.map(([, origin]) => journalled(store, PROJECT, origin));
  const result = closed(store, PROJECT, goal(), refusedBy(...refusals));

  cases.forEach(([name], index) => {
    const routed = routeOf(result, refusals[index]!.row);
    assert.equal(routed.class, "unknown", name);
    // The address for the analysis is the series the hold is raised in, so whoever takes it knows where to look.
    assert.equal(routed.addressee, `${ADDRESSEE_KINDS.unknown}:${at(PROJECT)}`, name);
    assert.equal(routed.toModel, false, name);
  });
  assert.deepEqual(result.question, []);
  assert.equal(result.refusals.every(item => item.code === "origin_unestablished"), true);

  // Not a classification alone: a HOLD per refusal, raised by the transaction that recorded the cycle. The series has
  // no stop without progress — one cycle is far from three — and it is held all the same.
  assert.equal(result.withoutProgress, 1);
  assert.equal(result.stop, null);
  assert.equal(result.holds.length, cases.length);
  refusals.forEach(refusal => {
    const hold = store.get<OriginHold>(originHoldId(PROJECT, BLOCK, 1, refusal.row))!;
    assert.equal(hold.kind, ORIGIN_HOLD_KIND);
    assert.equal(hold.revision, 1);
    assert.deepEqual(hold.value, {
      projectId: PROJECT, block: BLOCK, series: reference(heldSeries(store)!), attempt: 1, row: refusal.row,
      address: `${ADDRESSEE_KINDS.unknown}:${at(PROJECT)}`, lift: null,
    });
  });
  // Each of the gate's own refusals points at the hold whose analysis is to lift it.
  assert.deepEqual(result.refusals.map(item => item.at.ref!.id).sort(), result.holds.map(hold => hold.id).sort());
  const saved = heldJournal(store)!.value.classifications;
  assert.equal(saved.length, cases.length);
  // An origin that named no source at all carries no grounds, and says so; an ambiguous one carries the records that
  // made it ambiguous, for whoever takes the analysis.
  assert.deepEqual(saved.find(item => item.row === refusals[0]!.row)!.basis, []);
  assert.equal(saved.find(item => item.row === refusals[4]!.row)!.basis.length, 2);
  assert.equal(saved.find(item => item.row === refusals[6]!.row)!.basis.length, 2);

  // The very next attempt is refused — not after two more — and the context of the hold is there to be read.
  const next_ = { ...address(PROJECT), attempt: 2, goal: goal() };
  addressed(refusalOf(openAttempt(store, next_)), "origin_held", at(PROJECT));
  addressed(refusalOf(openAttempt(store, next_)), "origin_held", at(PROJECT));
  assert.equal(heldSeries(store)!.value.attempts.length, 1);
  const context = deliveredOf(stopContext(store, address(PROJECT)));
  assert.equal(context.stop, null);
  assert.equal(context.holds.length, cases.length);
  assert.deepEqual(context.holds.map(item => item.row).sort(), refusals.map(item => item.row).sort());
  assert.equal(context.holds.every(item => item.attempt === 1 && item.address === `${ADDRESSEE_KINDS.unknown}:${at(PROJECT)}`), true);
  assert.deepEqual(context.holds.find(item => item.row === refusals[1]!.row)!.origin.stage, "somewhere-else");
  assert.deepEqual(context.endings, [{ attempt: 1, reason: "refused" }]);
  store.close();

  // A restart does not lift it: the hold is in a record, not in a process.
  const back = new Store(path);
  t.after(() => back.close());
  addressed(refusalOf(openAttempt(back, next_)), "origin_held", at(PROJECT));
  assert.deepEqual(deliveredOf(stopContext(back, address(PROJECT))).holds, context.holds);
});

test("the classes decided by the stage keep their own addressees, and the refusal switches nothing (T8)", t => {
  const { store } = fixture(t);
  const untouched = [
    store.write({ id: "om-readiness:alpha", kind: "om-readiness", expected: 0, value: { ready: true, basis: "b1" } }),
    store.write({ id: "graph:untouched", kind: "graph", expected: 0, value: { horizon: [BLOCK] } }),
    store.write({ id: "om-gaps:alpha", kind: "om-gaps", expected: 0, value: { open: ["gap:1"] } }),
    store.write({ id: "om-queue:alpha", kind: "om-queue", expected: 0, value: { order: [BLOCK], weights: { [BLOCK]: 3 } } }),
  ];
  opened(store);
  const conditions = journalled(store, PROJECT, {
    stage: "feasibility", subject: "workspace",
    sources: [source("environment", carries(store, PROJECT, "workspace", [], { clean: false }))],
  }, { gate: "G6", code: "repository_dirty" });
  const readiness = journalled(store, PROJECT, {
    stage: "readiness", subject: BLOCK,
    sources: [source("base", carries(store, PROJECT, "basis", [BLOCK]))],
  }, { gate: "M2", code: "readiness_not_named" });
  const before = store.list().length;

  const result = closed(store, PROJECT, goal(), refusedBy(conditions, readiness));
  // The conditions of repository, environment and executor go to the owner; a ground of readiness goes to M2.
  assert.equal(routeOf(result, conditions.row).addressee, `${ADDRESSEE_KINDS.conditions}:workspace`);
  assert.equal(routeOf(result, readiness.row).addressee, `${ADDRESSEE_KINDS.readiness}:${BLOCK}`);
  assert.equal(result.refusals.find(item => item.at.field === conditions.row)!.route, "owner");
  assert.equal(routeOf(result, conditions.row).toModel, false);
  assert.equal(routeOf(result, readiness.row).toModel, false);

  // Nothing else moved: readiness is still what it was, and so are the graph, the gaps and the queue.
  for (const record of untouched) {
    const now = store.get(record.id)!;
    assert.equal(now.revision, 1, record.id);
    assert.equal(now.hash, record.hash, record.id);
    assert.equal(store.history(record.id).length, 1, record.id);
  }
  // A refusal of readiness does not switch readiness off: the review of its ground is M2's to make.
  assert.equal(store.get<{ ready: boolean }>("om-readiness:alpha")!.value.ready, true);
  // Exactly two records were written, and they are the series and the journal.
  assert.equal(store.list().length, before);
  assert.equal(store.history(at(PROJECT)).length, 3);
  assert.equal(store.history(journalId(PROJECT)).length, 3);

  // A feasibility refusal that names records of the MAP is the other case the rules put on that path — a defect of
  // the map — and it is placed by its subject like any other.
  const defect = journalled(store, PROJECT, {
    stage: "feasibility", subject: SUBJECT,
    sources: [
      source("proposal", carries(store, PROJECT, "proposal", ["artifact:tax"])),
      source("base", carries(store, PROJECT, "base", [])),
    ],
  }, { gate: "G6", code: "not_feasible" });
  const mapped = closed(store, PROJECT, goal(), refusedBy(defect));
  assert.equal(routeOf(mapped, defect.row).class, "proposal");
});

test("a cycle that called no model and came back with the same refusal is an attempt without progress", t => {
  const { store } = fixture(t);
  opened(store);
  const refusal = artifactMissing(store, PROJECT, "proposal");
  const first = closed(store, PROJECT, goal(), refusedBy(refusal));
  assert.equal(first.verdict, "none");
  assert.equal(first.withoutProgress, 1);
  const journal = heldJournal(store)!;

  // The very same row again: a repeat of the refusal, one decision about it, and no new revision of the journal.
  const second = closed(store, PROJECT, goal(), refusedBy(refusal));
  assert.equal(second.verdict, "none");
  assert.equal(second.withoutProgress, 2);
  assert.equal(routeOf(second, refusal.row).class, "proposal");
  assert.equal(heldJournal(store)!.revision, journal.revision);
  assert.equal(heldJournal(store)!.value.classifications.length, 1);

  // A cycle may not name a result that no provider of acceptance confirms: the claim is refused, nothing is written,
  // and the count is not cleared by it.
  const attempt = ordinalOf(store, PROJECT);
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt, goal: goal() }));
  const claimed = reference(store.write({ id: `om-gap-line:${PROJECT}:1`, kind: "om-gap-line", expected: 0, value: { closed: "line:cart:price" } }));
  const before = heldSeries(store)!;
  assert.equal(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt, outcome: outcome({ accepting: [claimed] }) })).code, "achievement_unconfirmed");
  assert.equal(heldSeries(store)!.revision, before.revision);
  // The same cycle closed with what it really achieved — nothing — is the third without progress, and it stops.
  const third = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt, outcome: outcome() }));
  assert.equal(third.verdict, "none");
  assert.equal(third.withoutProgress, 3);
  assert.equal(third.stop!.attempt, 3);
});

test("after a stop the gate names the rung the SERIES derived, and the direct routes are not replaced by the ladder", t => {
  const { store } = fixture(t);
  opened(store);
  const refusals = [0, 1, 2].map(() => artifactMissing(store, PROJECT, "input"));
  closed(store, PROJECT, goal(), refusedBy(refusals[0]!));
  closed(store, PROJECT, goal(), refusedBy(refusals[1]!));
  assert.equal(heldSeries(store)!.value.stop, null);
  const stopped = closed(store, PROJECT, goal(), refusedBy(refusals[2]!));

  assert.equal(stopped.withoutProgress, 3);
  assert.equal(stopped.stop!.attempt, 3);
  assert.deepEqual(stopped.stop!.attempts, [1, 2, 3]);
  // The rung is the one the series derived, and the gate repeats what it asks for.
  assert.equal(stopped.ladder!.rung, 1);
  assert.deepEqual(stopped.ladder!.grounds, ["inputs-fixed", "owner-decision", "review-record"]);
  assert.deepEqual(stopped.ladder, heldSeries(store)!.value.ladder);
  assert.ok(stopped.refusals.some(item => item.code === "stopped_without_progress" && item.route === "owner"));

  // The ladder replaces no direct route: the refusal of this cycle still goes to the producer of its record.
  assert.equal(routeOf(stopped, refusals[2]!.row).class, "input");
  assert.ok(stopped.refusals.some(item => item.at.field === refusals[2]!.row && item.code === "handed_to_producer"));

  // The context is assembled by code from the records of the attempts, and it names the responsible of each obstacle.
  const context = stopped.context!;
  assert.equal(context.series, at(PROJECT));
  assert.deepEqual(context.goals.map(item => item.key), ["gap:cart:price"]);
  assert.deepEqual(context.accepted, []);
  assert.deepEqual(context.endings, [1, 2, 3].map(attempt => ({ attempt, reason: "refused" })));
  assert.equal(context.repeated.length, 3);
  assert.equal(context.repeated.every(item => item.class === "input"), true);
  assert.equal(context.repeated.every(item => item.addressee!.startsWith(`${ADDRESSEE_KINDS.input}:`)), true);
  assert.equal(context.repeated.every(item => item.times === 1), true);
  assert.deepEqual(context.grounds, []);
  // The reviewer of the first rung and the owner of the second are handed the same context, by one function.
  assert.deepEqual(deliveredOf(stopContext(store, address(PROJECT))), context);

  // A continuation opens a new window and spends the rung; the next stop is the owner's, and the gate says so.
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...byReview(store, PROJECT, 3, stopped.stop!.goals) }));
  const again = [0, 1, 2].map(() => artifactMissing(store, PROJECT, "proposal"));
  closed(store, PROJECT, goal(), refusedBy(again[0]!));
  closed(store, PROJECT, goal(), refusedBy(again[1]!));
  const owners = closed(store, PROJECT, goal(), refusedBy(again[2]!));
  assert.equal(owners.stop!.attempt, 6);
  assert.equal(owners.ladder!.rung, 2);
  assert.deepEqual(owners.ladder!.grounds, ["owner-decision"]);
  assert.ok(owners.stop!.resume.includes("owner"));
  assert.deepEqual(owners.context!.grounds.map(item => item.after), [3]);
  // Even at the owner's rung a project refusal is still a question about its node.
  assert.deepEqual(owners.question, [SUBJECT]);

  // A restart does not lift the stop, and the context reads the same out of the stored records.
  const read = deliveredOf(stopContext(store, address(PROJECT)));
  assert.deepEqual(read.stop, owners.stop);
  assert.equal(read.ladder.rung, 2);
});

test("a stop whose own cycle carried no refusal is still explained with the classes decided earlier", t => {
  const { store } = fixture(t);
  opened(store);
  const refusal = artifactMissing(store, PROJECT, "input");
  closed(store, PROJECT, goal(), refusedBy(refusal));
  closed(store, PROJECT, goal(), refusedBy(refusal));
  const stopped = closed(store, PROJECT, goal(), outcome({ reason: "off-form" }));

  assert.deepEqual(stopped.routed, []);
  assert.equal(stopped.stop!.attempt, 3);
  const repeated = stopped.context!.repeated;
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]!.row, refusal.row);
  // The same refusal met by two attempts is the one that repeats, and it keeps the class decided for it earlier.
  assert.equal(repeated[0]!.times, 2);
  assert.equal(repeated[0]!.class, "input");
  assert.ok(repeated[0]!.addressee!.startsWith(`${ADDRESSEE_KINDS.input}:`));
  assert.deepEqual(stopped.context!.endings.map(item => item.reason), ["refused", "refused", "off-form"]);
});

test("every refusal code of this unit is produced, addressed and routed", t => {
  const { store } = fixture(t);
  const seen: string[] = [];
  const record = (refusal: Refusal, expected: string, target: string): void => { seen.push(addressed(refusal, expected, target).code); };

  // No journal at all: there is nothing a refusal of a cycle could stand in.
  opened(store, "p1");
  deliveredOf(openAttempt(store, { ...address("p1"), attempt: 1, goal: goal() }));
  record(refusalOf(closeAttempt(store, {
    ...address("p1"), attempt: 1, outcome: refusedBy({ name: "graph_invalid", goal: "g", row: "om-refusal:invented" }),
  })), "refusals_unlinked", at("p1"));

  // A journal that holds other refusals, and a row that stands in none of them.
  opened(store, "p2");
  journalled(store, "p2");
  deliveredOf(openAttempt(store, { ...address("p2"), attempt: 1, goal: goal() }));
  record(refusalOf(closeAttempt(store, {
    ...address("p2"), attempt: 1, outcome: refusedBy({ name: "graph_invalid", goal: "g", row: "om-refusal:invented" }),
  })), "refusal_unknown", at("p2"));

  // An origin whose source does not stand at the exact reference it names.
  opened(store, "p3");
  const gone = carries(store, "p3", "proposal", [SUBJECT]);
  const broken = journalled(store, "p3", { sources: [source("proposal", { ...gone, hash: hex("d") })] });
  deliveredOf(openAttempt(store, { ...address("p3"), attempt: 1, goal: goal() }));
  record(refusalOf(closeAttempt(store, { ...address("p3"), attempt: 1, outcome: refusedBy(broken) })), "origin_unreadable", at("p3"));

  // A context of a stop asked for where no stop stands.
  opened(store, "p4");
  record(refusalOf(stopContext(store, address("p4"))), "stop_absent", at("p4"));

  // An attempt opened while a hold of unknown origin stands.
  opened(store, "p5");
  const held = heldBy(store, "p5");
  record(refusalOf(openAttempt(store, { ...address("p5"), attempt: 2, goal: goal() })), "origin_held", at("p5"));
  assert.deepEqual(refusalOf(openAttempt(store, { ...address("p5"), attempt: 2, goal: goal() })).at.ref, held.hold);

  // A hold whose lift was written by hand, on a record that lifts nothing of it.
  opened(store, "p6");
  const forged = heldBy(store, "p6");
  const standing = holdAt(store, forged.hold);
  const elsewhere = storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace("p6"), decisionOf({ ...standing, row: "om-refusal:other" }));
  store.write({
    id: forged.hold.id, kind: ORIGIN_HOLD_KIND, expected: 1,
    value: { ...standing, lift: { ground: "owner-decision", record: elsewhere, class: null, addressee: null, basis: [] } } as unknown as Json,
  });
  record(refusalOf(openAttempt(store, { ...address("p6"), attempt: 2, goal: goal() })), "hold_invalid", forged.hold.id);

  // A lift on the analysis of another refusal.
  opened(store, "p7");
  const other = heldBy(store, "p7");
  const wrong = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("p7"), analysisOf({ ...holdAt(store, other.hold), row: "om-refusal:other" }));
  record(refusalOf(liftOriginHold(store, liftBy("p7", other.hold, "origin-analysis", { ref: wrong }))), "lift_unusable", other.hold.id);

  // A second lift of a hold lifted already, on another ground.
  opened(store, "p8");
  const twice = heldBy(store, "p8");
  const owner = storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace("p8"), decisionOf(holdAt(store, twice.hold)));
  deliveredOf(liftOriginHold(store, liftBy("p8", twice.hold, "owner-decision", { ref: owner })));
  const later = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("p8"), analysisOf(holdAt(store, twice.hold)));
  record(refusalOf(liftOriginHold(store, liftBy("p8", twice.hold, "origin-analysis", { ref: later }))), "lift_conflict", twice.hold.id);

  assert.deepEqual([...new Set(seen)].sort(), [...REPEAT_GATE_CODES].sort());
  // None of them wrote anything: a refusal switches nothing (T8).
  for (const project of ["p1", "p2", "p3", "p4"]) {
    assert.equal(heldSeries(store, project)!.value.attempts[0]?.outcome ?? null, null);
  }
  assert.equal(heldJournal(store, "p2")!.value.classifications.length, 0);
  assert.equal(heldJournal(store, "p3")!.value.classifications.length, 0);
});

test("an absent field, source or set is a typed refusal that names the address, while an explicit emptiness is not (T4)", t => {
  const { store } = fixture(t);
  const standing = carries(store, PROJECT, "base", [SUBJECT]);

  // Every case in a series of its own, so that nothing but the origin under test stands in the way.
  const fails = (origin: Record<string, unknown>, expected: string): Refusal => {
    const project = `t4-${next()}`;
    opened(store, project);
    const refusal = journalled(store, project, origin);
    deliveredOf(openAttempt(store, { ...address(project), attempt: 1, goal: goal() }));
    const found = addressed(refusalOf(closeAttempt(store, { ...address(project), attempt: 1, outcome: refusedBy(refusal) })), expected, at(project));
    // The cycle stays open: a refused close leaves neither an outcome, nor a classification, nor a hold.
    assert.equal(heldSeries(store, project)!.value.attempts[0]!.outcome, null);
    assert.deepEqual(heldJournal(store, project)!.value.classifications, []);
    assert.deepEqual(store.list(ORIGIN_HOLD_KIND).filter(record => record.id.startsWith(originHoldNamespace(project))), []);
    return found;
  };

  // A record of the map that does not name the definitions it carries answers nothing, and is not read as "none".
  assert.equal(fails({ sources: [source("base", reference(store.write({ id: `om-base:${PROJECT}:${next()}`, kind: "om-base", expected: 0, value: { rows: [SUBJECT] } })))] },
    "origin_unreadable").at.field, "outcome.refusals.0.origin.sources.0.kind");
  assert.equal(fails({ sources: [source("base", reference(store.write({ id: `om-base:${PROJECT}:${next()}`, kind: "om-base", expected: 0, value: { defines: null } })))] },
    "origin_unreadable").at.field, "outcome.refusals.0.origin.sources.0.kind");
  assert.equal(fails({ sources: [source("base", reference(store.write({ id: `om-base:${PROJECT}:${next()}`, kind: "om-base", expected: 0, value: { defines: [SUBJECT, 7] } })))] },
    "origin_unreadable").at.field, "outcome.refusals.0.origin.sources.0.kind");
  assert.equal(fails({ sources: [source("base", reference(store.write({ id: `om-base:${PROJECT}:${next()}`, kind: "om-base", expected: 0, value: "a base" })))] },
    "origin_unreadable").at.field, "outcome.refusals.0.origin.sources.0.kind");
  // A source that stands at no such revision, and one whose record was never written at all.
  assert.equal(fails({ sources: [source("base", { ...standing, revision: 9 })] },
    "origin_unreadable").at.field, "outcome.refusals.0.origin.sources.0.ref");
  assert.equal(fails({ sources: [source("environment", { id: `om-workspace:${PROJECT}:absent`, revision: 1, hash: hex("e") })] },
    "origin_unreadable").at.field, "outcome.refusals.0.origin.sources.0");
  // The address of the refused source travels with the refusal, so the gate that wrote the origin knows which one.
  assert.deepEqual(fails({ sources: [source("base", { ...standing, revision: 9 })] }, "origin_unreadable").at.ref,
    { ...standing, revision: 9 });

  // The address points at the place in the set the CALLER gave, whatever order the gate weighs them in.
  opened(store);
  const sound = artifactMissing(store, PROJECT, "proposal");
  const lame = journalled(store, PROJECT, { sources: [source("base", { ...standing, revision: 9 })] });
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const found = addressed(refusalOf(closeAttempt(store, {
    ...address(PROJECT), attempt: 1, outcome: refusedBy(sound, lame),
  })), "origin_unreadable", at(PROJECT));
  assert.equal(found.at.field, "outcome.refusals.1.origin.sources.0.ref");
  assert.equal(addressed(refusalOf(closeAttempt(store, {
    ...address(PROJECT), attempt: 1, outcome: refusedBy(lame, sound),
  })), "origin_unreadable", at(PROJECT)).at.field, "outcome.refusals.0.origin.sources.0.ref");

  // An absent set of refusals, of accepting records or of cancelling ones is the calling code's defect; an explicitly
  // empty one is a cycle that ran into none and achieved none.
  for (const over of [{ refusals: undefined }, { refusals: null }, { refusals: "none" }, { refusals: {} },
    { accepting: undefined }, { accepting: null }, { cancelling: undefined }, { cancelling: {} }]) {
    assert.throws(() => closeAttempt(store, {
      ...address(PROJECT), attempt: 1, outcome: { ...outcome(), ...over } as unknown as GateOutcome,
    }), code("repeat_request_invalid"));
  }
  assert.deepEqual(deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: outcome() })).routed, []);

  // An explicitly empty set of sources, and an explicitly empty set of definitions, are answers and not absences: the
  // first is an origin not established; the second, beside the one proposal named, says the subject is in neither.
  const empty = journalled(store, PROJECT, { sources: [] });
  const nothing = journalled(store, PROJECT, {
    sources: [source("base", carries(store, PROJECT, "base", [])), source("proposal", carries(store, PROJECT, "proposal", []))],
  });
  const result = closed(store, PROJECT, goal(), refusedBy(empty, nothing));
  assert.equal(routeOf(result, empty.row).class, "unknown");
  assert.equal(routeOf(result, nothing.row).class, "proposal");
});

test("a forged input is refused: a foreign namespace, a substituted hash and an imitated verdict", t => {
  const { store } = fixture(t);
  opened(store);
  opened(store, "beta");

  // A row that stands in ANOTHER project's journal stands in none of this one's, however well it reads — and this
  // project has a journal of its own, so what is missing is the row and not the journal.
  journalled(store, PROJECT, { sources: [source("base", carries(store, PROJECT, "base", [SUBJECT]))] });
  const elsewhere = journalled(store, "beta", { sources: [source("base", carries(store, "beta", "base", [SUBJECT]))] });
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  addressed(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(elsewhere) })), "refusal_unknown", at(PROJECT));
  assert.equal(heldJournal(store, "beta")!.value.classifications.length, 0);

  // Identical content hashes alike, so a hash is no identity: what is read is the record the id names.
  const mine = carries(store, PROJECT, "base", [SUBJECT]);
  const twin = carries(store, "beta", "base", [SUBJECT]);
  const borrowed = journalled(store, PROJECT, {
    sources: [source("base", twin), source("derived", carries(store, PROJECT, "candidate", [SUBJECT]))],
  });
  addressed(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(borrowed) })), "origin_unreadable", at(PROJECT));
  const swapped = journalled(store, PROJECT, { sources: [source("base", { ...mine, hash: hex("e") })] });
  addressed(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(swapped) })), "origin_unreadable", at(PROJECT));
  deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: outcome() }));
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() }));

  // A record that declares a verdict about itself gains nothing by it: only the definitions it carries are read.
  const plain = carries(store, PROJECT, "proposal", ["artifact:tax"]);
  const boastful = carries(store, PROJECT, "proposal", ["artifact:tax"], {
    class: "input", addressee: "producer:someone", accepted: true, verdict: "not the assembler's fault",
  });
  const empty = carries(store, PROJECT, "base", []);
  const honest = journalled(store, PROJECT, { sources: [source("proposal", plain), source("base", empty)] });
  const loud = journalled(store, PROJECT, { sources: [source("proposal", boastful), source("base", empty)] });
  const both = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 2, outcome: refusedBy(honest, loud) }));
  assert.equal(routeOf(both, honest.row).class, "proposal");
  assert.equal(routeOf(both, loud.row).class, routeOf(both, honest.row).class);
  assert.equal(routeOf(both, loud.row).addressee, routeOf(both, honest.row).addressee);

  // And a record that carries ONLY such a verdict, without the definitions, answers nothing at all.
  const verdictOnly = reference(store.write({
    id: `om-proposal:${PROJECT}:loud`, kind: "om-proposal", expected: 0, value: { class: "input", accepted: true },
  }));
  const hollow = journalled(store, PROJECT, { sources: [source("proposal", verdictOnly)] });
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 3, goal: goal() }));
  addressed(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 3, outcome: refusedBy(hollow) })), "origin_unreadable", at(PROJECT));

  // The gate that refused may not hand the class down either: A2 refuses a record that declares one.
  const declared = store.write({
    id: `${unitRefusalNamespace(PROJECT)}declared`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: {
      gate: "G3",
      refusals: [{
        code: "graph_invalid", goal: "g", remedy: "r", class: "proposal",
        origin: { name: "artifact_missing", stage: "layer-check", subject: SUBJECT, sources: [] },
      }],
    } as Json,
  });
  assert.equal(refusalOf(recordRefusal(store, { project: PROJECT, source: reference(declared) })).code, "refusal_entry_invalid");
});

// A second writer commits between this unit's read and its own write. The store is synchronous, so the only way to
// stand in that window is to write from another connection while a read is being answered.
class RacingStore extends Store {
  armed = false;
  target = "";
  run: ((store: Store) => void) | null = null;
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    const found = super.get<T>(id, revision);
    if (this.armed && id === this.target && this.run) {
      this.armed = false;
      const other = new Store(this.path);
      try { this.run(other); } finally { other.close(); }
    }
    return found;
  }
}

test("a guarded record that changes between the reading and the write leaves neither an outcome nor a classification (T7)", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-gate-race-"));
  const path = join(root, "live.sqlite");
  const store = new RacingStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  opened(store);
  const refusal = artifactMissing(store, PROJECT, "proposal");
  const other = artifactMissing(store, PROJECT, "input");
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const series = heldSeries(store)!;
  const journal = heldJournal(store)!;

  // The competitor classifies another refusal between the reading of the journal and the write.
  store.target = journalId(PROJECT);
  store.armed = true;
  store.run = rival => {
    deliveredOf(classifyRefusal(rival, { project: PROJECT, row: other.row, class: "input", addressee: "producer:x", basis: [] }));
  };
  const clash = addressed(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) })), "input_stale", journalId(PROJECT));
  assert.deepEqual(clash.at.ref, reference(journal));
  // Neither record moved for us: no outcome in the series, and only the competitor's decision in the journal.
  assert.equal(heldSeries(store)!.revision, series.revision);
  assert.equal(heldSeries(store)!.value.attempts[0]!.outcome, null);
  assert.deepEqual(heldJournal(store)!.value.classifications.map(item => item.row), [other.row]);

  // The same window on the SERIES: the competitor closes the cycle while this call is preparing it.
  store.target = at(PROJECT);
  store.armed = true;
  store.run = rival => {
    deliveredOf(completeAttempt(rival, { ...address(PROJECT), attempt: 1, outcome: seriesOutcome("interrupted") }));
  };
  const lost = refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) }));
  assert.ok(["input_stale", "revision_conflict", "outcome_conflict"].includes(lost.code));
  assert.equal(heldJournal(store)!.value.classifications.length, 1);
  assert.equal(heldSeries(store)!.value.attempts[0]!.outcome!.reason, "interrupted");

  // Nothing was lost: the next cycle carries the refusal through once the current heads are read again.
  store.armed = false;
  const done = closed(store, PROJECT, goal(), refusedBy(refusal));
  assert.equal(routeOf(done, refusal.row).class, "proposal");
  assert.deepEqual(heldJournal(store)!.value.classifications.map(item => item.row).sort(), [other.row, refusal.row].sort());
});

test("the outcome of a cycle and the classes of its refusals are one transaction: a refusal of either leaves neither", t => {
  const { store } = fixture(t);
  opened(store);
  const refusal = artifactMissing(store, PROJECT, "proposal");
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));

  // Prepared and not written: two records, the series first, and the store still holds neither change.
  const transition = deliveredOf(prepareCloseAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) }));
  assert.deepEqual(transition.writes.map(write => write.id), [at(PROJECT), journalId(PROJECT)]);
  assert.equal(heldSeries(store)!.value.attempts[0]!.outcome, null);
  assert.deepEqual(heldJournal(store)!.value.classifications, []);
  assert.equal(transition.value.routed.length, 1);

  // A caller that writes more than these two puts them into one guarded transaction of its own.
  const ledger = { id: "om-call-ledger:alpha", kind: "om-ledger", expected: 0, value: { closed: 1 } };
  const applied = deliveredOf(writeGuarded(store, {
    unit: "mc2", target: ledger.id, writes: [...transition.writes, ledger], guards: [...transition.guards],
  }));
  assert.deepEqual(applied.map(record => record.id), [at(PROJECT), journalId(PROJECT), ledger.id]);
  assert.equal(heldJournal(store)!.value.classifications.length, 1);

  // A refusal of the SERIES leaves no classification: a different outcome for a cycle already closed.
  const late = artifactMissing(store, PROJECT, "input");
  const journal = heldJournal(store)!;
  assert.equal(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(late) })).code, "outcome_conflict");
  assert.equal(heldJournal(store)!.revision, journal.revision);
  assert.equal(heldJournal(store)!.value.classifications.length, 1);

  // A refusal of the JOURNAL leaves no outcome: a row somebody classified otherwise by hand.
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() }));
  deliveredOf(classifyRefusal(store, { project: PROJECT, row: late.row, class: "derivation", addressee: "code:elsewhere", basis: [] }));
  const series = heldSeries(store)!;
  assert.equal(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 2, outcome: refusedBy(late) })).code, "classification_conflict");
  assert.equal(heldSeries(store)!.revision, series.revision);
  assert.equal(heldSeries(store)!.value.attempts[1]!.outcome, null);

  // Several refusals of one cycle are ONE revision of the journal, not one per refusal.
  const many = [0, 1, 2].map(() => artifactMissing(store, PROJECT, "proposal"));
  const before = heldJournal(store)!.revision;
  const result = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 2, outcome: refusedBy(...many) }));
  assert.equal(result.routed.length, 3);
  assert.equal(heldJournal(store)!.revision, before + 1);
  assert.equal(heldJournal(store)!.value.classifications.length, 5);
});

test("every exported function refuses a missing, null or mistyped argument as a typed defect, never a TypeError", t => {
  const { store } = fixture(t);
  opened(store);
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const good: CloseAttemptRequest = { ...address(PROJECT), attempt: 1, outcome: outcome() };
  const goodDefinitions = { project: PROJECT, source: { role: "environment", ref: { id: "workspace:alpha:x", revision: 1, hash: hex("a") } } };
  for (const request of [undefined, null, "request", 7, {}, { project: PROJECT },
    { ...goodDefinitions, project: null }, { ...goodDefinitions, source: null }, { ...goodDefinitions, source: { role: "base" } },
    { ...goodDefinitions, source: { ...goodDefinitions.source, context: {} } },
    { ...goodDefinitions, source: { ...goodDefinitions.source, context: { kind: "frame", request: {} } } }])
    assert.throws(() => readDefinitions(store, request as unknown as Parameters<typeof readDefinitions>[1]), typedDefect);
  for (const invalid of [null, undefined, "store", {}, 7])
    assert.throws(() => readDefinitions(invalid as unknown as Store, goodDefinitions), typedDefect);
  const calls: ((request: unknown, gate: unknown) => void)[] = [
    (request, gate) => { closeAttempt(gate as Store, request as CloseAttemptRequest); },
    (request, gate) => { prepareCloseAttempt(gate as Store, request as CloseAttemptRequest); },
  ];

  for (const call of calls) {
    for (const request of [null, undefined, "request", 7, [good]]) assert.throws(() => call(request, store), typedDefect);
    for (const broken of [null, undefined, "store", 7, {}, { get: () => null, writeMany: () => [] }]) {
      assert.throws(() => call(good, broken), typedDefect);
    }
    for (const attempt of [undefined, null, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => call({ ...good, attempt }, store), typedDefect);
    }
    for (const project of [undefined, null, "", 7, "alpha:beta", "a".repeat(200)]) {
      assert.throws(() => call({ ...good, project }, store), typedDefect);
    }
    for (const block of [undefined, null, "", 7]) assert.throws(() => call({ ...good, block }, store), typedDefect);
    for (const line of [undefined, null, 0, "1", 1.5]) assert.throws(() => call({ ...good, line }, store), typedDefect);
    for (const item of [undefined, null, "row", 7, {}, { row: "" }, { name: "n", goal: "g" }]) {
      assert.throws(() => call({ ...good, outcome: { ...outcome(), refusals: [item] } }, store), typedDefect);
    }
    for (const broken of [undefined, null, "outcome", 7]) {
      assert.throws(() => call({ ...good, outcome: broken }, store), typedDefect);
    }
    // A result named by a key of the caller's is no part of an outcome at all, and neither is a set of refs that is not.
    for (const over of [{ achieved: [] }, { cancelled: [] }, { verdict: "progress" }]) {
      assert.throws(() => call({ ...good, outcome: { ...outcome(), ...over } }, store), typedDefect);
    }
    for (const accepting of [[null], ["om-gap-line:alpha:1"], [{ id: "x", revision: 1 }], [{ id: "x", revision: 0, hash: hex("a") }]]) {
      assert.throws(() => call({ ...good, outcome: { ...outcome(), accepting } }, store), typedDefect);
      assert.throws(() => call({ ...good, outcome: { ...outcome(), cancelling: accepting } }, store), typedDefect);
    }
  }
  const opens: ((request: unknown, gate: unknown) => void)[] = [
    (request, gate) => { openAttempt(gate as Store, request as BeginAttemptRequest); },
    (request, gate) => { prepareOpenAttempt(gate as Store, request as BeginAttemptRequest); },
  ];
  const opening = { ...address(PROJECT), attempt: 2, goal: goal() };
  for (const call of opens) {
    for (const request of [null, undefined, "request", 7, [opening]]) assert.throws(() => call(request, store), typedDefect);
    for (const broken of [null, undefined, "store", 7, {}]) assert.throws(() => call(opening, broken), typedDefect);
    for (const project of [undefined, null, "", 7, "alpha:beta", "a".repeat(121)]) assert.throws(() => call({ ...opening, project }, store), typedDefect);
    for (const attempt of [undefined, null, 0, "2"]) assert.throws(() => call({ ...opening, attempt }, store), typedDefect);
    for (const goal_ of [undefined, null, {}, { key: "k" }]) assert.throws(() => call({ ...opening, goal: goal_ }, store), typedDefect);
  }
  const lifts: ((request: unknown, gate: unknown) => void)[] = [
    (request, gate) => { liftOriginHold(gate as Store, request as LiftOriginHoldRequest); },
    (request, gate) => { prepareLiftOriginHold(gate as Store, request as LiftOriginHoldRequest); },
  ];
  const holdRef = { id: `${originHoldNamespace(PROJECT)}x`, revision: 1, hash: hex("a") };
  const lifting = liftBy(PROJECT, holdRef, "owner-decision", { ref: { id: `${originDecisionNamespace(PROJECT)}x`, revision: 1, hash: hex("b") } });
  for (const call of lifts) {
    for (const request of [null, undefined, "request", 7, [lifting]]) assert.throws(() => call(request, store), typedDefect);
    for (const broken of [null, undefined, "store", 7, {}]) assert.throws(() => call(lifting, broken), typedDefect);
    for (const project of [undefined, null, "", 7, "alpha:beta"]) assert.throws(() => call({ ...lifting, project }, store), typedDefect);
    for (const hold of [undefined, null, "hold", { id: "x", revision: 1 }]) assert.throws(() => call({ ...lifting, hold }, store), typedDefect);
    for (const ground of [undefined, null, "", "review-record", "the approach has changed"]) assert.throws(() => call({ ...lifting, ground }, store), typedDefect);
    for (const record of [undefined, null, {}, { ref: holdRef, pending: { id: "x", kind: "k", value: {} } }, { pending: { id: "x", kind: "k" } },
      { pending: { id: "x", kind: "k", value: undefined } }, { ref: { id: "x", revision: 1 } }]) {
      assert.throws(() => call({ ...lifting, record }, store), typedDefect);
    }
  }
  for (const request of [null, undefined, "request", 7]) {
    assert.throws(() => stopContext(store, request as unknown as SeriesRequest), typedDefect);
  }
  for (const broken of [null, undefined, "store", 7, {}]) {
    assert.throws(() => stopContext(broken as Store, address(PROJECT)), typedDefect);
  }
  for (const [project, block, attempt, row] of [["", BLOCK, 1, "r"], [PROJECT, "", 1, "r"], [PROJECT, BLOCK, 0, "r"], [PROJECT, BLOCK, 1, ""]] as const) {
    assert.throws(() => originHoldId(project, block, attempt, row), typedDefect);
  }
  // Not one of them wrote anything.
  assert.equal(heldSeries(store)!.value.attempts[0]!.outcome, null);
  assert.equal(heldJournal(store), null);
});

test("the vocabulary of classes and addressees is this gate's, closed and unchangeable while it works (T11)", t => {
  const { store } = fixture(t);
  // Every class named has an addressee kind and a place in the gate's own report; nothing is named twice or left out.
  assert.deepEqual([...REFUSAL_CLASSES].sort(), Object.keys(ADDRESSEE_KINDS).sort());
  assert.equal(new Set(REFUSAL_CLASSES).size, REFUSAL_CLASSES.length);
  assert.equal(new Set(Object.values(ADDRESSEE_KINDS)).size, REFUSAL_CLASSES.length);
  assert.equal(new Set(REFUSAL_STAGES).size, REFUSAL_STAGES.length);
  assert.equal(new Set(ORIGIN_ROLES).size, ORIGIN_ROLES.length);
  for (const table of [REFUSAL_CLASSES, REFUSAL_STAGES, ORIGIN_ROLES, GATE_REFUSAL_CODES, REPEAT_GATE_CODES, ADDRESSEE_KINDS, LIFT_GROUNDS, SUBJECT_DECISIONS]) {
    assert.ok(Object.isFrozen(table));
    assert.throws(() => { (table as unknown as string[]).push("invented"); }, TypeError);
  }
  assert.throws(() => {
    // @ts-expect-error a policy table does not change while the module works, at compile time as well
    REFUSAL_CLASSES[0] = "invented";
  }, TypeError);

  // What a consumer is handed is a deep frozen copy, sharing no object with the store or with a policy table.
  opened(store);
  const result = closed(store, PROJECT, goal(), refusedBy(artifactMissing(store, PROJECT, "proposal")));
  assert.ok(deeplyFrozen(result));
  assert.throws(() => {
    // @ts-expect-error a delivered report is readonly at compile time, not only frozen at run time
    result.routed[0]!.class = "input";
  }, TypeError);
  assert.throws(() => { (result.routed as unknown as unknown[]).push({}); }, TypeError);
  assert.equal(heldJournal(store)!.value.classifications[0]!.class, "proposal");
  // And what was reported is what was written.
  assert.equal(hashJson(heldJournal(store)!.value.classifications[0]!), hashJson({
    row: result.routed[0]!.row, class: result.routed[0]!.class,
    addressee: result.routed[0]!.addressee, basis: result.routed[0]!.basis,
  }));
});

test("the gate writes the series and the journal and nothing else, whatever the class of the refusal (T8)", t => {
  const { store } = fixture(t);
  opened(store);
  const every: RefusalClass[] = [...REFUSAL_CLASSES];
  const refusals = [
    artifactMissing(store, PROJECT, "proposal"),
    artifactMissing(store, PROJECT, "input"),
    artifactMissing(store, PROJECT, "derivation"),
    journalled(store, PROJECT, { stage: "feasibility", subject: "workspace", sources: [source("environment", carries(store, PROJECT, "workspace", []))] }),
    journalled(store, PROJECT, { stage: "readiness", subject: BLOCK, sources: [source("base", carries(store, PROJECT, "basis", [BLOCK]))] }),
    journalled(store, PROJECT, { sources: [] }),
  ];
  const kinds = new Map(store.list().map(record => [record.id, { head: reference(record), history: store.history(record.id).map(reference) }]));
  const result = closed(store, PROJECT, goal(), refusedBy(...refusals));
  assert.deepEqual(classes(result), [...every].sort());

  for (const [id, before] of kinds) {
    if (id === at(PROJECT) || id === journalId(PROJECT)) continue;
    assert.deepEqual(reference(store.get(id)!), before.head, id);
    assert.deepEqual(store.history(id).map(reference), before.history, id);
  }
  assert.deepEqual(store.list(REFUSAL_JOURNAL_KIND).map(record => record.id), [journalId(PROJECT)]);
  // The one record added is the gate's own hold of the refusal of unknown origin: no graph, input, readiness or gap.
  const added = store.list().map(record => record.id).filter(id => !kinds.has(id));
  assert.deepEqual(added, result.holds.map(hold => hold.id));
  assert.deepEqual(store.list(ORIGIN_HOLD_KIND).map(record => record.id), result.holds.map(hold => hold.id));
});

test("the classes of the gate are re-derived at every reading, and a stored decision is never undone by a later one (T5)", t => {
  const { store } = fixture(t);
  opened(store);
  const refusal = artifactMissing(store, PROJECT, "input");
  const first = closed(store, PROJECT, goal(), refusedBy(refusal));
  assert.equal(routeOf(first, refusal.row).class, "input");
  const journal = heldJournal(store)!;

  // The records the origin stood on move on. The origin names EXACT revisions, so the class derived earlier still
  // reads the records it was derived from, and the decision already taken is not revisited.
  const base = routeOf(first, refusal.row).basis.find(item => item.role === "base")!;
  const oldBase = store.get<Graph>(base.ref.id)!;
  store.write({ id: oldBase.id, kind: oldBase.kind, expected: oldBase.revision, value: { ...oldBase.value, title: "Later unaccepted graph" } });
  const second = closed(store, PROJECT, goal(), refusedBy(refusal));
  assert.equal(routeOf(second, refusal.row).class, "input");
  assert.equal(heldJournal(store)!.revision, journal.revision);
  assert.deepEqual(heldJournal(store)!.value.classifications, journal.value.classifications);

  // A refusal whose origin names the NEW revision is a different row, and it is placed on what that revision holds.
  const later = journalled(store, PROJECT, {
    sources: [source("base", reference(store.get(base.ref.id)!)), source("proposal", carries(store, PROJECT, "proposal", []))],
  });
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 3, goal: goal() }));
  assert.equal(refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 3, outcome: refusedBy(later) })).code, "origin_unreadable");
  assert.equal(heldSeries(store)!.value.attempts[2]!.outcome, null);
});

test("a result is never taken on the caller's word: five invented keys on one real record move nothing (P1)", t => {
  const { store, path } = fixture(t);
  opened(store);
  // The reviewer's scenario: one real record — a refusal of G3, which accepted nothing — offered as the ground of a
  // result in five cycles, under five invented keys. In the old words of an outcome it is not even an outcome.
  const refusal = store.write({
    id: `${unitRefusalNamespace(PROJECT)}g3:real`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: "G3", refusals: [{ code: "graph_invalid", goal: "g", remedy: "r", origin: { name: "n", stage: "layer-check", subject: SUBJECT, sources: [] } }] },
  });
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const before = heldSeries(store)!;
  for (let round = 1; round <= 5; round += 1) {
    assert.throws(() => closeAttempt(store, {
      ...address(PROJECT), attempt: 1,
      outcome: { reason: "result", achieved: [{ key: `invented-${round}`, basis: reference(refusal) }], cancelled: [], refusals: [] } as unknown as GateOutcome,
    }), code("repeat_request_invalid"));
    // Named as what it is — a record offered as accepting a result — it is refused: nothing accepted it.
    const refused_ = refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: outcome({ accepting: [reference(refusal)] }) }));
    assert.equal(refused_.code, "achievement_unconfirmed");
    assert.equal(refused_.at.field, "outcome.accepting.0.kind");
    assert.equal(refused_.at.target, at(PROJECT));
    assert.deepEqual(refused_.at.ref, reference(refusal));
  }
  // The series did not move: no outcome, no progress, no count cleared.
  assert.equal(heldSeries(store)!.revision, before.revision);
  assert.equal(heldSeries(store)!.value.attempts[0]!.outcome, null);

  // The whole class: a record of any kind no provider is connected for, a record that does not stand, a candidate the
  // store holds, and a cancellation with no transition that confirms it.
  const candidate = reference(store.write({ id: `om-candidate:${PROJECT}:1`, kind: "om-candidate", expected: 0, value: { accepted: true, keys: ["line:cart:price"] } }));
  const line = reference(store.write({ id: `om-gap-line:${PROJECT}:1`, kind: "om-gap-line", expected: 0, value: { closed: "line:cart:price", accepted: true } }));
  const cases: [Partial<GateOutcome>, string, string][] = [
    [{ accepting: [candidate] }, "achievement_unconfirmed", "outcome.accepting.0.kind"],
    [{ accepting: [line] }, "achievement_unconfirmed", "outcome.accepting.0.kind"],
    [{ accepting: [{ ...line, hash: hex("d") }] }, "achievement_unconfirmed", "outcome.accepting.0"],
    [{ accepting: [{ ...line, revision: 2 }] }, "achievement_unconfirmed", "outcome.accepting.0"],
    [{ cancelling: [line] }, "cancellation_unconfirmed", "outcome.cancelling.0.kind"],
    [{ cancelling: [reference(refusal)] }, "cancellation_unconfirmed", "outcome.cancelling.0.kind"],
  ];
  for (const [over, expected, field] of cases) {
    const found = refusalOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: outcome(over) }));
    assert.equal(found.code, expected, field);
    assert.equal(found.at.field, field);
  }
  assert.equal(heldSeries(store)!.revision, before.revision);

  // What the cycle really achieved — nothing — still closes it, and three such cycles stop the series.
  assert.equal(deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: outcome() })).verdict, "none");
  closed(store, PROJECT, goal(), outcome());
  const third = closed(store, PROJECT, goal(), outcome());
  assert.equal(third.withoutProgress, 3);
  assert.equal(third.stop!.attempt, 3);
  store.close();

  // A restart changes none of it: the stop stands, and a claimed result is refused as before.
  const back = new Store(path);
  t.after(() => back.close());
  assert.equal(refusalOf(openAttempt(back, { ...address(PROJECT), attempt: 4, goal: goal() })).code, "series_stopped");
  assert.equal(deliveredOf(stopContext(back, address(PROJECT))).stop!.attempt, 3);
  assert.equal(refusalOf(closeAttempt(back, { ...address(PROJECT), attempt: 3, outcome: outcome({ accepting: [line] }) })).code, "achievement_unconfirmed");
});

test("a hold is lifted on the analysis of ITS refusal, which routes it by the class it established — stored or written with it", t => {
  const { store } = fixture(t);
  const readiness = store.write({ id: "om-readiness:alpha", kind: "om-readiness", expected: 0, value: { ready: true } });

  // Stored: the analysis established an error of the input, and names the one accepted record at fault.
  opened(store, "stored");
  const one = heldBy(store, "stored");
  const culprit = carries(store, "stored", "base", [SUBJECT]);
  const analysis = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("stored"),
    analysisOf(holdAt(store, one.hold), { class: "input", basis: [source("base", culprit)] }));
  const lifted = deliveredOf(liftOriginHold(store, liftBy("stored", one.hold, "origin-analysis", { ref: analysis })));
  assert.equal(lifted.revision, 2);
  assert.deepEqual(lifted.value.lift, {
    ground: "origin-analysis", record: analysis, class: "input",
    addressee: `${ADDRESSEE_KINDS.input}:${culprit.id}`, basis: [source("base", culprit)],
  });
  // The hold no longer holds: the next attempt opens, and nothing else changed — readiness included (T8).
  assert.equal(deliveredOf(openAttempt(store, { ...address("stored"), attempt: 2, goal: goal() })).value.attempts.length, 2);
  assert.equal(store.get(readiness.id)!.revision, 1);

  // Written WITH the lift: nothing of the analysis stands before, both stand after, by one transaction.
  // The grounds are the ones the class is WEIGHED out of: the subject is looked for in the one proposal and in the
  // accepted base, and found in neither — the claim "proposal" is what those grounds say, not what lifts the hold.
  opened(store, "pending");
  const two = heldBy(store, "pending");
  const id = `${originAnalysisNamespace("pending")}${next()}`;
  const value = analysisOf(holdAt(store, two.hold), {
    class: "proposal",
    basis: [
      source("proposal", carries(store, "pending", "proposal", [])),
      source("base", carries(store, "pending", "base", [])),
    ],
  });
  const prepared = deliveredOf(prepareLiftOriginHold(store, liftBy("pending", two.hold, "origin-analysis", { pending: { id, kind: ORIGIN_ANALYSIS_KIND, value: value as Json } })));
  assert.deepEqual(prepared.writes.map(write => write.id), [two.hold.id, id]);
  assert.equal(store.get(id), null);
  assert.equal(holdAt(store, two.hold).lift, null);
  const written = deliveredOf(liftOriginHold(store, liftBy("pending", two.hold, "origin-analysis", { pending: { id, kind: ORIGIN_ANALYSIS_KIND, value: value as Json } })));
  assert.equal(store.get(id)!.revision, 1);
  assert.deepEqual(written.value.lift!.record, reference(store.get(id)!));
  // A project refusal established by the analysis is a question about its node, as the gate's own table says.
  assert.equal(written.value.lift!.addressee, `${ADDRESSEE_KINDS.proposal}:${SUBJECT}`);
  deliveredOf(openAttempt(store, { ...address("pending"), attempt: 2, goal: goal() }));

  // The context names the hold while it stands, and no hold once it is lifted.
  assert.equal(refusalOf(stopContext(store, address("stored"))).code, "stop_absent");
});

test("a hold is lifted on the owner's decision about it — stored or written with the lift — and on nothing less", t => {
  const { store } = fixture(t);
  opened(store, "own");
  const held = heldBy(store, "own");
  const decision = storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace("own"), decisionOf(holdAt(store, held.hold)));
  const lifted = deliveredOf(liftOriginHold(store, liftBy("own", held.hold, "owner-decision", { ref: decision })));
  // The owner decided to go on; no class was established, so the refusal is not re-routed by the lift.
  assert.deepEqual(lifted.value.lift, { ground: "owner-decision", record: decision, class: null, addressee: null, basis: [] });
  deliveredOf(openAttempt(store, { ...address("own"), attempt: 2, goal: goal() }));

  opened(store, "ownp");
  const later = heldBy(store, "ownp");
  const id = `${originDecisionNamespace("ownp")}${next()}`;
  deliveredOf(liftOriginHold(store, liftBy("ownp", later.hold, "owner-decision", {
    pending: { id, kind: ORIGIN_DECISION_KIND, value: decisionOf(holdAt(store, later.hold)) as Json },
  })));
  assert.equal(store.get(id)!.revision, 1);
  deliveredOf(openAttempt(store, { ...address("ownp"), attempt: 2, goal: goal() }));

  // Nothing less lifts one: a record of another kind or another project, a decision that says nothing, an analysis
  // that established no class, one without grounds, grounds that do not stand, or that single nobody out.
  opened(store, "none");
  const { hold } = heldBy(store, "none");
  const base = holdAt(store, hold);
  const lift = (ground: LiftOriginHoldRequest["ground"], record: LiftOriginHoldRequest["record"]) => refusalOf(liftOriginHold(store, liftBy("none", hold, ground, record)));
  const wrongKind = storedAs(store, "om-stop-review", originAnalysisNamespace("none"), analysisOf(base));
  assert.equal(lift("origin-analysis", { ref: wrongKind }).code, "record_foreign");
  const foreign = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("beta"), analysisOf(base));
  assert.equal(lift("origin-analysis", { ref: foreign }).code, "record_foreign");
  assert.equal(lift("origin-analysis", { pending: { id: `${originAnalysisNamespace("beta")}x`, kind: ORIGIN_ANALYSIS_KIND, value: analysisOf(base) as Json } }).code, "record_foreign");
  assert.equal(lift("owner-decision", { pending: { id: `${originDecisionNamespace("none")}x`, kind: ORIGIN_ANALYSIS_KIND, value: decisionOf(base) as Json } }).code, "record_foreign");
  const unusable: [LiftOriginHoldRequest["ground"], string, Record<string, unknown>, string][] = [
    ["owner-decision", ORIGIN_DECISION_KIND, decisionOf(base, { decided: "" }), "record.decided"],
    ["owner-decision", ORIGIN_DECISION_KIND, decisionOf(base, { row: "om-refusal:other" }), "record.row"],
    ["owner-decision", ORIGIN_DECISION_KIND, decisionOf(base, { attempt: 2 }), "record.attempt"],
    ["owner-decision", ORIGIN_DECISION_KIND, decisionOf(base, { block: "block:checkout" }), "record.block"],
    ["origin-analysis", ORIGIN_ANALYSIS_KIND, analysisOf(base, { class: "unknown" }), "record.class"],
    ["origin-analysis", ORIGIN_ANALYSIS_KIND, analysisOf(base, { class: "invented" }), "record.class"],
    ["origin-analysis", ORIGIN_ANALYSIS_KIND, analysisOf(base, { basis: [] }), "record.basis"],
    ["origin-analysis", ORIGIN_ANALYSIS_KIND, analysisOf(base, { basis: [{ role: "base", ref: { id: "om-base:none:gone", revision: 1, hash: hex("e") } }] }), "record.basis.0.ref"],
    ["origin-analysis", ORIGIN_ANALYSIS_KIND, analysisOf(base, { basis: [source("hearsay", carries(store, "none", "base", []))] }), "record.basis.0.role"],
    ["origin-analysis", ORIGIN_ANALYSIS_KIND, analysisOf(base, { class: "input", basis: [source("base", carries(store, "none", "base", [])), source("base", carries(store, "none", "base", []))] }), "record.basis"],
    ["origin-analysis", ORIGIN_ANALYSIS_KIND, analysisOf(base, { class: "derivation", basis: [source("base", carries(store, "none", "base", []))] }), "record.basis"],
  ];
  for (const [ground, kind, value, field] of unusable) {
    const namespace = ground === "owner-decision" ? originDecisionNamespace("none") : originAnalysisNamespace("none");
    const pendingId = `${namespace}${next()}`;
    const found = lift(ground, { pending: { id: pendingId, kind, value: value as Json } });
    assert.equal(found.code, "lift_unusable", field);
    assert.equal(found.at.field, field);
    assert.equal(found.at.target, hold.id);
    // A ground refused is a ground not written.
    assert.equal(store.get(pendingId), null, field);
  }
  assert.equal(holdAt(store, hold).lift, null);
  addressed(refusalOf(openAttempt(store, { ...address("none"), attempt: 2, goal: goal() })), "origin_held", at("none"));
});

test("a lift applies to its own hold and once: a repeat changes nothing, a later ground is refused, and a restart keeps it (T5)", t => {
  const { store, path } = fixture(t);
  opened(store);
  const first = heldBy(store, PROJECT);
  const decision = storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace(PROJECT), decisionOf(holdAt(store, first.hold)));
  const request = liftBy(PROJECT, first.hold, "owner-decision", { ref: decision });
  const lifted = deliveredOf(liftOriginHold(store, request));

  // The same lift again: no revision, and the prepared change carries no write.
  assert.equal(deliveredOf(liftOriginHold(store, request)).revision, lifted.revision);
  assert.deepEqual(deliveredOf(prepareLiftOriginHold(store, request)).writes, []);
  // Another ground for the same hold, even a good one, does not replace the first.
  const analysis = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(PROJECT), analysisOf(holdAt(store, first.hold)));
  assert.equal(refusalOf(liftOriginHold(store, liftBy(PROJECT, first.hold, "origin-analysis", { ref: analysis }))).code, "lift_conflict");

  // Later events: another attempt, another refusal of unknown origin, another hold. The late repeat of the first lift
  // still finds its own hold lifted, and lifts nothing else — and the first ground does not lift the second hold.
  const second = heldBy(store, PROJECT);
  assert.notEqual(second.hold.id, first.hold.id);
  assert.equal(deliveredOf(liftOriginHold(store, request)).revision, lifted.revision);
  assert.equal(refusalOf(liftOriginHold(store, liftBy(PROJECT, second.hold, "owner-decision", { ref: decision }))).code, "lift_unusable");
  assert.equal(holdAt(store, second.hold).lift, null);
  addressed(refusalOf(openAttempt(store, { ...address(PROJECT), attempt: 3, goal: goal() })), "origin_held", at(PROJECT));

  // A late repeat of the FIRST close, after its hold was lifted, raises nothing again.
  const again = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(first.refusal) }));
  assert.deepEqual(again.holds, []);
  assert.equal(store.history(first.hold.id).length, 2);
  store.close();

  // After a restart: the lifted hold stays lifted, the standing one stands, and the repeat is still a repeat.
  const back = new Store(path);
  t.after(() => back.close());
  assert.equal(deliveredOf(liftOriginHold(back, request)).revision, lifted.revision);
  assert.deepEqual(deliveredOf(stopContext(back, address(PROJECT))).holds.map(item => item.hold), [second.hold]);
  const decisionTwo = storedAs(back, ORIGIN_DECISION_KIND, originDecisionNamespace(PROJECT), decisionOf(holdAt(back, second.hold)));
  deliveredOf(liftOriginHold(back, liftBy(PROJECT, second.hold, "owner-decision", { ref: decisionTwo })));
  deliveredOf(openAttempt(back, { ...address(PROJECT), attempt: 3, goal: goal() }));
});

test("a hold or a lift written by hand is refused: each is derived again from what it stands on (T3)", t => {
  const { store } = fixture(t);
  const forge = (project: string, build: (hold: OriginHold) => Record<string, unknown>): Ref => {
    opened(store, project);
    const { hold } = heldBy(store, project);
    store.write({ id: hold.id, kind: ORIGIN_HOLD_KIND, expected: 1, value: build(holdAt(store, hold)) as Json });
    return hold;
  };
  const cases: [string, (hold: OriginHold, project: string) => Record<string, unknown>][] = [
    ["a lift with no record of its ground at all", hold => ({ ...hold, lift: { ground: "owner-decision", record: { id: `${originDecisionNamespace(hold.projectId)}gone`, revision: 1, hash: hex("a") }, class: null, addressee: null, basis: [] } })],
    ["a lift that re-routes where its analysis did not", (hold, project) => {
      const analysis = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(project), analysisOf(hold));
      return { ...hold, lift: { ground: "origin-analysis", record: analysis, class: "proposal", addressee: `node:${SUBJECT}`, basis: [] } };
    }],
    ["a lift on the executor's own word", hold => ({ ...hold, lift: { ground: "the approach has changed", record: { id: "x", revision: 1, hash: hex("a") }, class: null, addressee: null, basis: [] } })],
    ["a hold that names another refusal", hold => ({ ...hold, row: "om-refusal:other" })],
    ["a hold that names a series revision which never recorded it", hold => ({ ...hold, series: { ...hold.series, revision: 1 } })],
    ["a hold carrying a field of its own", hold => ({ ...hold, lifted: true })],
    ["a hold at another address than the one for the analysis", hold => ({ ...hold, address: "analysis:elsewhere" })],
  ];
  cases.forEach(([name, build], index) => {
    const project = `forged${index}`;
    const hold = forge(project, hold_ => build(hold_, project));
    const found = refusalOf(openAttempt(store, { ...address(project), attempt: 2, goal: goal() }));
    assert.equal(found.code, "hold_invalid", name);
    assert.equal(found.at.target, hold.id, name);
    assert.equal(refusalOf(stopContext(store, address(project))).code, "hold_invalid", name);
  });

  // A cycle closed AROUND the gate — the series and the journal written by hand — leaves a refusal of unknown origin
  // with no hold: the series is held all the same, and closing the cycle through the gate raises the hold.
  opened(store, "around");
  const refusal = journalled(store, "around", { sources: [] });
  deliveredOf(beginAttempt(store, { ...address("around"), attempt: 1, goal: goal() }));
  deliveredOf(completeAttempt(store, { ...address("around"), attempt: 1, outcome: { ...seriesOutcome("refused"), refusals: [refusal] } }));
  deliveredOf(classifyRefusal(store, { project: "around", row: refusal.row, class: "unknown", addressee: `${ADDRESSEE_KINDS.unknown}:${at("around")}`, basis: [] }));
  const held = refusalOf(openAttempt(store, { ...address("around"), attempt: 2, goal: goal() }));
  assert.equal(held.code, "origin_held");
  assert.equal(held.at.ref, undefined);
  const raised = deliveredOf(closeAttempt(store, { ...address("around"), attempt: 1, outcome: refusedBy(refusal) }));
  assert.equal(raised.holds.length, 1);
  assert.deepEqual(holdAt(store, raised.holds[0]!).series, reference(heldSeries(store, "around")!));
  addressed(refusalOf(openAttempt(store, { ...address("around"), attempt: 2, goal: goal() })), "origin_held", at("around"));
});

// A second writer commits between this unit's read and its own write, from another connection.
class HoldRace extends Store {
  armed = false;
  target = "";
  run: ((store: Store) => void) | null = null;
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    const found = super.get<T>(id, revision);
    if (this.armed && id === this.target && this.run) {
      this.armed = false;
      const other = new Store(this.path);
      try { this.run(other); } finally { other.close(); }
    }
    return found;
  }
}

test("a hold, its lift and the opening it guards leave no window between the check and the write (T7)", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-hold-race-"));
  const store = new HoldRace(join(root, "live.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  // A lift prepared with an analysis written with it; the owner lifts the hold first. Neither of ours is written.
  opened(store);
  const { hold } = heldBy(store, PROJECT);
  const id = `${originAnalysisNamespace(PROJECT)}${next()}`;
  const value = analysisOf(holdAt(store, hold), {
    class: "input", basis: [source("base", carries(store, PROJECT, "base", [SUBJECT]))],
  });
  const prepared = deliveredOf(prepareLiftOriginHold(store, liftBy(PROJECT, hold, "origin-analysis", { pending: { id, kind: ORIGIN_ANALYSIS_KIND, value: value as Json } })));
  const decision = storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace(PROJECT), decisionOf(holdAt(store, hold)));
  deliveredOf(liftOriginHold(store, liftBy(PROJECT, hold, "owner-decision", { ref: decision })));
  assert.ok(["input_stale", "revision_conflict"].includes(refusalOf(writeGuarded(store, {
    unit: "a6", target: hold.id, writes: [...prepared.writes], guards: [...prepared.guards],
  })).code));
  assert.equal(store.get(id), null);
  assert.equal(holdAt(store, hold).lift!.ground, "owner-decision");

  // An opening weighed while no refusal of unknown origin was known; the journal comes to hold one before the write.
  opened(store, "late");
  const refusal = journalled(store, "late", { sources: [] });
  deliveredOf(beginAttempt(store, { ...address("late"), attempt: 1, goal: goal() }));
  deliveredOf(completeAttempt(store, { ...address("late"), attempt: 1, outcome: { ...seriesOutcome("refused"), refusals: [refusal] } }));
  const opening = deliveredOf(prepareOpenAttempt(store, { ...address("late"), attempt: 2, goal: goal() }));
  assert.ok(opening.guards.some(guard => guard.id === journalId("late")));
  deliveredOf(classifyRefusal(store, { project: "late", row: refusal.row, class: "unknown", addressee: `${ADDRESSEE_KINDS.unknown}:${at("late")}`, basis: [] }));
  assert.equal(refusalOf(writeGuarded(store, { unit: "h1", target: at("late"), writes: [...opening.writes], guards: [...opening.guards] })).code, "input_stale");
  assert.equal(heldSeries(store, "late")!.value.attempts.length, 1);

  // The same window inside openAttempt itself: the journal moves while the gate is reading it.
  opened(store, "race");
  const other = journalled(store, "race", { sources: [] });
  deliveredOf(beginAttempt(store, { ...address("race"), attempt: 1, goal: goal() }));
  deliveredOf(completeAttempt(store, { ...address("race"), attempt: 1, outcome: { ...seriesOutcome("refused"), refusals: [other] } }));
  store.target = journalId("race");
  store.armed = true;
  store.run = rival => {
    deliveredOf(classifyRefusal(rival, { project: "race", row: other.row, class: "unknown", addressee: `${ADDRESSEE_KINDS.unknown}:${at("race")}`, basis: [] }));
  };
  assert.equal(refusalOf(openAttempt(store, { ...address("race"), attempt: 2, goal: goal() })).code, "input_stale");
  assert.equal(heldSeries(store, "race")!.value.attempts.length, 1);
});

test("a hold outlives a successor of the series: one change of the slice does not establish an origin", t => {
  const { store } = fixture(t);
  opened(store);
  const { hold } = heldBy(store, PROJECT);
  // The slice moves; the successor carries the attempt that raised the hold, and the hold with it.
  const successor = deliveredOf(openSeries(store, {
    ...address(PROJECT, 2), slice: "slice:cart@2", predecessor: reference(heldSeries(store)!),
    basis: { ground: "inputs-changed", text: "a dependency left the closure of this block" },
  }));
  assert.equal(successor.value.inherited.length, 1);
  const held = refusalOf(openAttempt(store, { ...address(PROJECT, 2), attempt: 2, goal: goal() }));
  assert.equal(held.code, "origin_held");
  assert.deepEqual(held.at.ref, hold);
  assert.deepEqual(deliveredOf(stopContext(store, address(PROJECT, 2))).holds.map(item => item.hold), [hold]);

  // Lifted once, it is lifted for the whole lineage.
  const decision = storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace(PROJECT), decisionOf(holdAt(store, hold)));
  deliveredOf(liftOriginHold(store, liftBy(PROJECT, hold, "owner-decision", { ref: decision })));
  deliveredOf(openAttempt(store, { ...address(PROJECT, 2), attempt: 2, goal: goal() }));
});

test("the table of decision: every tally of roles and holders gets the class its sources suffice for, and no other", async t => {
  // This exhaustive table uses native acceptance once; dedicated integration tests also cover OM acceptance.
  const native = await createOmFixture(t, "standard", "pool"), template = native.store, root = native.root, path = native.database;
  const matrixSubject = "pool-prep";
  const input = deliveredOf(writeOmInput(template, { project: "pool", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(native.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const makeHorizon = (choiceVersion: string, refinement: Ref | null) => deliveredOf(writeHorizon(template,
    { project: "pool", input: reference(input), graph: reference(native.graphRevision), refinement,
      choice: { choiceVersion, features: [{ outcome: "pool-result" }], excluded: [] }, available: {} }));
  const first: FrameRequest = { project: "pool", level: 2, graph: reference(native.graphRevision), horizon: reference(makeHorizon("table-upper", null).gate),
    layer: null, frame: null, upper: null };
  const accepted: FrameRequest = { ...first, horizon: reference(makeHorizon("table-lower", reference(template.get("phase:pool:L2")!)).gate),
    layer: reference(native.layers[2]) };
  const read = deliveredOf(readFrame(template, first)), upper = structuredClone(read.upper) as Graph;
  const baseAbsent = remember(read.upperRef, { kind: "frame", request: first });
  remember(accepted.graph, { kind: "frame", request: accepted });
  definitionFixtures.set(template, new Map([["pool", { first, accepted, upper, subject: matrixSubject, baseAbsent }]]));
  // The rule in its own words: blamed on a holder — that holder named, exactly one; blamed on an absence — every place
  // looked in. Written here independently of the gate's table, so that a change of either shows up as a disagreement.
  const expected = (p: number, hp: number, b: number, hb: number, d: number, hd: number): RefusalClass => {
    if (p + b + d === 0) return "unknown";
    const lostOnTheWay = d === 1 && hd === 0 && hp + hb === 1;
    const unfitInTheBase = hb === 1 && hp === 0 && hd === d;
    const unfitInTheProposal = p === 1 && hp === 1 && hb === 0 && hd === d;
    const missingFromTheProposal = p === 1 && hp === 0 && b >= 1 && hb === 0 && hd === 0;
    return lostOnTheWay ? "derivation" : unfitInTheBase ? "input" : unfitInTheProposal || missingFromTheProposal ? "proposal" : "unknown";
  };
  // And a few by hand, among them the reviewer's two.
  const pinned: Record<string, RefusalClass> = {
    "0 0 0 0 1 1": "unknown", // only the assembly, holding it: nothing says the proposal lacked it
    "0 0 2 2 0 0": "unknown", // two accepted records hold it: nobody is singled out
    "1 0 1 0 1 0": "proposal", // looked for in the proposal and the base, found in neither
    "1 0 0 0 0 0": "unknown", // not in the proposal, but the base was never looked in
    "1 1 0 0 0 0": "proposal", // in the one proposal, unfit there
    "2 1 1 0 0 0": "unknown", // in one of two proposals: which proposal is the question's is not said
    "1 1 1 0 1 0": "derivation", // proposed, and not in what the one assembly produced
    "1 1 1 0 2 1": "unknown", // one of two assemblies lost it: which one is not said
    "0 0 1 1 1 1": "input", // in the one accepted record, and nothing lost it
    "0 0 2 1 0 0": "input", // in one of two accepted records: that one is singled out
    "1 1 1 1 1 1": "unknown", // proposed and accepted both: whose definition is unfit is not said
  };

  // A closed, legitimately built snapshot preserves exact source histories for every table row.
  // Each row gets an independent journal, so the truth table does not repeatedly replay unrelated refusals.
  template.close();
  const seen = new Map<string, RefusalClass>();
  for (let p = 0; p <= 2; p += 1) for (let hp = 0; hp <= p; hp += 1)
  for (let b = 0; b <= 2; b += 1) for (let hb = 0; hb <= b; hb += 1)
  for (let d = 0; d <= 2; d += 1) for (let hd = 0; hd <= d; hd += 1) {
    const key = `${p} ${hp} ${b} ${hb} ${d} ${hd}`;
    const database = join(root, `row-${p}${hp}${b}${hb}${d}${hd}.sqlite`);
    copyFileSync(path, database);
    const store = new Store(database);
    try {
      definitionFixtures.set(store, new Map([["pool", { first, accepted, upper, subject: matrixSubject, baseAbsent }]]));
      const named = (total: number, holders: number) => Array.from({ length: total }, (_, index) => index < holders ? [matrixSubject] : ["artifact:other"]);
      const sources = assembly(store, "pool", { frame: hb > 0 ? accepted : first, proposals: named(p, hp), bases: Array.from({ length: b }, (_, index) => index < hb),
        derived: named(d, hd) });
      const project = "pool", block = `tally:${p}${hp}${b}${hb}${d}${hd}`;
      const request = { project, block, line: 1 };
      deliveredOf(openSeries(store, { ...request, slice: SLICE, predecessor: null, basis: null }));
      const refusal = journalled(store, project, { subject: matrixSubject, sources: sources.length > 0 ? sources : [source("environment", carries(store, project, "workspace", []))] });
      deliveredOf(openAttempt(store, { ...request, attempt: 1, goal: goal() }));
      const result = deliveredOf(closeAttempt(store, { ...request, attempt: 1, outcome: refusedBy(refusal) }));
      const routed = routeOf(result, refusal.row);
      seen.set(key, routed.class);
      assert.equal(routed.class, expected(p, hp, b, hb, d, hd), key);
      // No positive class without the role it blames, and its responsible is the one record the rule singles out.
      if (routed.class === "derivation") {
        assert.ok(d === 1, key);
        assert.equal(routed.addressee, `${ADDRESSEE_KINDS.derivation}:${sources.find(item => item.role === "derived")!.ref.id}`, key);
      }
      if (routed.class === "input") {
        assert.ok(b >= 1 && hb === 1, key);
        assert.equal(routed.addressee, `${ADDRESSEE_KINDS.input}:${sources.find(item => item.role === "base")!.ref.id}`, key);
      }
      if (routed.class === "proposal") assert.ok(p === 1, key);
      // Whatever is not placed is held at once, and only a placed refusal of the proposal reaches the model.
      assert.equal(result.holds.length, routed.class === "unknown" ? 1 : 0, key);
      assert.equal(routed.toModel, routed.class === "proposal", key);
    } finally { store.close(); rmSync(database); }
  }
  assert.equal(seen.size, 216);
  for (const [key, want] of Object.entries(pinned)) assert.equal(seen.get(key), want, key);
  // Every row of the table is reachable, and most tallies are not enough to say anything.
  assert.deepEqual([...new Set(seen.values())].sort(), ["derivation", "input", "proposal", "unknown"]);
  assert.deepEqual(SUBJECT_DECISIONS.map(row => row.class), ["derivation", "input", "proposal"]);
});

// ---------------------------------------------------------------------------
// ONE mechanism for one class: the lift of a hold is weighed by the function the ordinary classification uses (№180).

/** A cycle that ran into a refusal of the given origin — one this gate cannot place — and the hold it raised. */
function heldOn(store: Store, project: string, origin: Record<string, unknown>, beside: readonly ClaimedRefusal[] = []) {
  const refusal = journalled(store, project, origin);
  const result = closed(store, project, goal(), refusedBy(refusal, ...beside));
  assert.equal(result.holds.length, 1);
  return { refusal, result, hold: result.holds[0]!, standing: holdAt(store, result.holds[0]!) };
}

const asLift = (call: (store: Store, request: LiftOriginHoldRequest) => OmResult<unknown>) => call;
const LIFT_CALLS = [asLift(liftOriginHold), asLift(prepareLiftOriginHold)];

/**
 * The same analysis offered on EVERY path a lift has — stored beforehand or written with the lift, prepared or applied
 * — and refused on each. After a refusal the base holds neither the lift nor the record of the analysis.
 */
function liftRefused(store: Store, project: string, hold: Ref, value: Record<string, unknown>, field: string, note: string): void {
  const stored = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(project), value);
  for (const call of LIFT_CALLS) {
    const found = addressed(refusalOf(call(store, liftBy(project, hold, "origin-analysis", { ref: stored }))), "lift_unusable", hold.id);
    assert.equal(found.at.field, field, note);
    assert.equal(holdAt(store, hold).lift, null, note);
  }
  for (const call of LIFT_CALLS) {
    const id = `${originAnalysisNamespace(project)}${next()}`;
    const found = addressed(refusalOf(call(store, liftBy(project, hold, "origin-analysis", {
      pending: { id, kind: ORIGIN_ANALYSIS_KIND, value: value as Json },
    }))), "lift_unusable", hold.id);
    assert.equal(found.at.field, field, note);
    // A refused ground is a ground not written: no lift, and no analysis standing to be found later.
    assert.equal(store.get(id), null, note);
    assert.equal(holdAt(store, hold).lift, null, note);
  }
}

test("the reviewer's reproduction: an analysis whose grounds establish ANOTHER class lifts nothing, on every path (№180)", t => {
  const { store, path } = fixture(t);
  opened(store);
  // A proposal that DEFINES the subject, and the candidate the code assembled without it: the definition stood and the
  // one assembly lost it. The ordinary classification of a refusal weighed against these two says so.
  const grounds = assembly(store, PROJECT, { proposals: [[SUBJECT]], derived: [["artifact:order"]] });
  const candidate = grounds.find(item => item.role === "derived")!.ref;
  const ordinary = journalled(store, PROJECT, { sources: grounds });
  // The first cycle also ran into a refusal of unknown origin: its hold stands, and it is what an analysis would lift.
  const held = heldOn(store, PROJECT, { sources: [] }, [ordinary]);
  const table = routeOf(held.result, ordinary.row);
  assert.equal(table.class, "derivation");
  assert.equal(table.addressee, `${ADDRESSEE_KINDS.derivation}:${candidate.id}`);
  assert.equal(table.toModel, false);

  // The same two records, the same subject and the same stage, handed to the lift inside an analysis that CLAIMS the
  // definition is missing from the proposal. The claim is compared with what the grounds say, and loses.
  const claimed = analysisOf(held.standing, { class: "proposal", basis: grounds });
  liftRefused(store, PROJECT, held.hold, claimed, "record.class", "a claim of proposal over grounds that establish derivation");
  // The refusal names the class the grounds really establish, so whoever wrote the analysis is told what they say.
  const found = refusalOf(liftOriginHold(store, liftBy(PROJECT, held.hold,
    "origin-analysis", { ref: storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(PROJECT), claimed) })));
  assert.ok(found.message.includes("derivation"), found.message);

  // Neither the hold nor the journal moved, and the next attempt does not open — not before the analysis, not after it.
  assert.equal(holdAt(store, held.hold).lift, null);
  assert.deepEqual(store.list(ORIGIN_HOLD_KIND).map(record => record.id), [held.hold.id]);
  assert.equal(heldJournal(store)!.value.classifications.length, 2);
  addressed(refusalOf(openAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() })), "origin_held", at(PROJECT));
  assert.equal(heldSeries(store)!.value.attempts.length, 1);
  store.close();

  // A restart does not make the claim true either.
  const back = new Store(path);
  t.after(() => back.close());
  assert.equal(holdAt(back, held.hold).lift, null);
  addressed(refusalOf(openAttempt(back, { ...address(PROJECT), attempt: 2, goal: goal() })), "origin_held", at(PROJECT));
  assert.equal(refusalOf(liftOriginHold(back, liftBy(PROJECT, held.hold, "origin-analysis", {
    pending: { id: `${originAnalysisNamespace(PROJECT)}${next()}`, kind: ORIGIN_ANALYSIS_KIND, value: claimed as Json },
  }))).code, "lift_unusable");
});

test("grounds the table of decision cannot place lift nothing: an absent role and several holders are both 'unknown'", t => {
  const { store } = fixture(t);
  const cases: [string, string, (project: string) => readonly unknown[]][] = [
    ["proposal", "only what the code assembled, holding the subject",
      project => [source("derived", carries(store, project, "candidate", [SUBJECT]))]],
    ["input", "two accepted records both holding the subject",
      project => [source("base", carries(store, project, "base", [SUBJECT])), source("base", carries(store, project, "base", [SUBJECT]))]],
    ["proposal", "a proposal that lacks it, and no accepted record looked in",
      project => [source("proposal", carries(store, project, "proposal", []))]],
    ["derivation", "two assemblies, one of which lost it",
      project => assembly(store, project, { proposals: [[SUBJECT]], derived: [[SUBJECT], []] })],
  ];
  cases.forEach(([claim, note, build], index) => {
    const project = `unplaced${index}`;
    opened(store, project);
    const held = heldOn(store, project, { sources: [] });
    liftRefused(store, project, held.hold, analysisOf(held.standing, { class: claim, basis: build(project) }), "record.basis", note);
    addressed(refusalOf(openAttempt(store, { ...address(project), attempt: 2, goal: goal() })), "origin_held", at(project));
    assert.equal(store.list(ORIGIN_ANALYSIS_KIND).filter(record => record.id.startsWith(originAnalysisNamespace(project))).length, 1, note);
  });
  // A source of the map among the grounds that does not name the definitions it carries answers nothing here either.
  opened(store, "mute");
  const mute = heldOn(store, "mute", { sources: [] });
  const silent = reference(store.write({ id: `om-base:mute:${next()}`, kind: "om-base", expected: 0, value: { rows: [SUBJECT] } }));
  liftRefused(store, "mute", mute.hold, analysisOf(mute.standing, { class: "input", basis: [source("base", silent)] }),
    "record.basis.0.kind", "an unsupported kind cannot witness map definitions");
});

test("an analysis whose grounds establish the class it claims lifts the hold, and says exactly what the table said", t => {
  const { store } = fixture(t);
  // In one project and one cycle: a refusal of unknown origin, and beside it a refusal weighed against the very
  // records the analysis will name. The lift and the ordinary classification must be the same finding, hash for hash.
  const cases: [string, string, (project: string) => readonly unknown[]][] = [
    ["input", "the one accepted record holds it, and nothing lost it",
      project => assembly(store, project, { bases: [true], derived: [[SUBJECT]] })],
    ["proposal", "looked for in the one proposal and the one accepted record, found in neither",
      project => assembly(store, project, { proposals: [[]], bases: [false] })],
    ["derivation", "proposed, and not in what the one assembly produced",
      project => assembly(store, project, { proposals: [[SUBJECT]], derived: [[]] })],
  ];
  cases.forEach(([claim, note, build], index) => {
    // The same case twice: the analysis stored beforehand, and the analysis written WITH the lift.
    for (const written of [false, true]) {
      const project = `agree${index}${written ? "p" : "s"}`;
      opened(store, project);
      const basis = build(project);
      const ordinary = journalled(store, project, { sources: basis });
      const held = heldOn(store, project, { sources: [] }, [ordinary]);
      const table = routeOf(held.result, ordinary.row);
      assert.equal(table.class, claim, note);

      const value = analysisOf(held.standing, { class: claim, basis });
      const id = `${originAnalysisNamespace(project)}${next()}`;
      const request = liftBy(project, held.hold, "origin-analysis", written
        ? { pending: { id, kind: ORIGIN_ANALYSIS_KIND, value: value as Json } }
        : { ref: storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(project), value) });
      // Prepared: both records are in one transaction, and the base still holds neither change.
      const prepared = deliveredOf(prepareLiftOriginHold(store, request));
      assert.deepEqual(prepared.writes.map(write => write.id), written ? [held.hold.id, id] : [held.hold.id]);
      assert.equal(holdAt(store, held.hold).lift, null, note);
      const lifted = deliveredOf(liftOriginHold(store, request));

      // What the lift established is what the ordinary classification of the same sources established — not merely
      // the same class, but the same addressee and the same grounds, compared by hash (T3).
      const decided = heldJournal(store, project)!.value.classifications.find(item => item.row === ordinary.row)!;
      assert.equal(hashJson({ class: lifted.value.lift!.class, addressee: lifted.value.lift!.addressee, basis: lifted.value.lift!.basis }),
        hashJson({ class: decided.class, addressee: decided.addressee, basis: decided.basis }), note);
      assert.equal(lifted.value.lift!.ground, "origin-analysis");
      // The hold no longer holds: the next attempt of the series opens.
      assert.equal(deliveredOf(openAttempt(store, { ...address(project), attempt: 2, goal: goal() })).value.attempts.length, 2);

      // The grounds are an unordered set: the same analysis with them reversed is weighed to the same finding.
      const mirror = project;
      const mirrorRefusal = journalled(store, mirror, { sources: [] });
      const mirrorResult = deliveredOf(closeAttempt(store, { ...address(mirror), attempt: 2, outcome: refusedBy(mirrorRefusal) }));
      assert.equal(mirrorResult.holds.length, 1);
      const other = { hold: mirrorResult.holds[0]!, standing: holdAt(store, mirrorResult.holds[0]!) };
      const reversed = analysisOf(other.standing, { class: claim, basis: [...basis].reverse() });
      const twin = deliveredOf(liftOriginHold(store, liftBy(mirror, other.hold, "origin-analysis",
        { ref: storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(mirror), reversed) })));
      assert.deepEqual(twin.value.lift!.basis, lifted.value.lift!.basis, note);
      assert.equal(twin.value.lift!.class, lifted.value.lift!.class, note);
    }
  });
});

test("the classes decided by the STAGE go through the same function on a lift: no branch that takes the claim on trust", t => {
  const { store } = fixture(t);
  // A refusal of the readiness stage that named no source at all is not placed, so it is held; the analysis supplies
  // the grounds, and the stage of the journalled refusal — not the claim — still decides the class and its addressee.
  opened(store, "rdy");
  const readiness = heldOn(store, "rdy", { stage: "readiness", subject: BLOCK, sources: [] });
  const ground = [source("base", carries(store, "rdy", "basis", [BLOCK]))];
  // The stage rules are not bypassed by a claim: an accepted record holding the subject does not make this an error of
  // the input, because the stage of THIS refusal decides the class.
  liftRefused(store, "rdy", readiness.hold, analysisOf(readiness.standing, { class: "input", basis: ground }),
    "record.class", "a claim of input on a refusal of the readiness stage");
  const lifted = deliveredOf(liftOriginHold(store, liftBy("rdy", readiness.hold, "origin-analysis",
    { ref: storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("rdy"), analysisOf(readiness.standing, { class: "readiness", basis: ground })) })));
  assert.equal(lifted.value.lift!.class, "readiness");
  assert.equal(lifted.value.lift!.addressee, `${ADDRESSEE_KINDS.readiness}:${BLOCK}`);
  deliveredOf(openAttempt(store, { ...address("rdy"), attempt: 2, goal: goal() }));

  // A refusal of the feasibility stage whose grounds name no record of the MAP is the conditions of the repository,
  // the environment or the executor, and it goes to the owner — again by the stage, at the subject of the refusal.
  opened(store, "cond");
  const conditions = heldOn(store, "cond", { stage: "feasibility", subject: "workspace", sources: [] });
  const environment = [source("environment", carries(store, "cond", "workspace", [], { dirty: true }))];
  liftRefused(store, "cond", conditions.hold, analysisOf(conditions.standing, { class: "derivation", basis: environment }),
    "record.class", "a claim of derivation on grounds that name nothing of the map");
  const owned = deliveredOf(liftOriginHold(store, liftBy("cond", conditions.hold, "origin-analysis",
    { ref: storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("cond"), analysisOf(conditions.standing, { class: "conditions", basis: environment })) })));
  assert.equal(owned.value.lift!.class, "conditions");
  assert.equal(owned.value.lift!.addressee, `${ADDRESSEE_KINDS.conditions}:workspace`);
  deliveredOf(openAttempt(store, { ...address("cond"), attempt: 2, goal: goal() }));

  // The other case the rules put on the feasibility path — a refusal that turned out to be a defect of the map — is
  // placed by its subject there as everywhere: the grounds name records of the map, and the table weighs them.
  opened(store, "defect");
  const defect = heldOn(store, "defect", { stage: "feasibility", subject: SUBJECT, sources: [] });
  const mapped = [source("proposal", carries(store, "defect", "proposal", [])), source("base", carries(store, "defect", "base", []))];
  liftRefused(store, "defect", defect.hold, analysisOf(defect.standing, { class: "conditions", basis: mapped }),
    "record.class", "a claim of conditions on grounds that name records of the map");
  const byMap = deliveredOf(liftOriginHold(store, liftBy("defect", defect.hold, "origin-analysis",
    { ref: storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("defect"), analysisOf(defect.standing, { class: "proposal", basis: mapped })) })));
  assert.equal(byMap.value.lift!.addressee, `${ADDRESSEE_KINDS.proposal}:${SUBJECT}`);

  // A stage this gate does not name has no defined effect, and an analysis cannot give it one: such a hold is lifted
  // by the owner's decision (H2) and by nothing an analysis claims.
  opened(store, "nostage");
  const nameless = heldOn(store, "nostage", { stage: "somewhere-else", sources: [] });
  liftRefused(store, "nostage", nameless.hold,
    analysisOf(nameless.standing, { class: "input", basis: [source("base", carries(store, "nostage", "base", [SUBJECT]))] }),
    "record.basis", "an analysis of a refusal whose stage this gate does not name");
  deliveredOf(liftOriginHold(store, liftBy("nostage", nameless.hold, "owner-decision",
    { ref: storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace("nostage"), decisionOf(nameless.standing)) })));
  deliveredOf(openAttempt(store, { ...address("nostage"), attempt: 2, goal: goal() }));
});

test("a saved lift whose grounds no longer establish its class is refused at the next opening, and after a restart", t => {
  const { store, path } = fixture(t);
  // The forgery the reviewer's defect made possible, written straight into the base: a REAL analysis record of this
  // project, about this very hold, whose grounds establish an error of derivation — and a lift that says "proposal",
  // with the addressee and the grounds recomputed to agree with itself. The store hashes it, so it is self-consistent.
  opened(store);
  const held = heldOn(store, PROJECT, { sources: [] });
  const basis = assembly(store, PROJECT, { proposals: [[SUBJECT]], derived: [[]] });
  const analysis = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(PROJECT),
    analysisOf(held.standing, { class: "proposal", basis }));
  const forged = { ...held.standing, lift: { ground: "origin-analysis", record: analysis, class: "proposal", addressee: `${ADDRESSEE_KINDS.proposal}:${SUBJECT}`, basis } };
  const written = store.write({ id: held.hold.id, kind: ORIGIN_HOLD_KIND, expected: 1, value: forged as unknown as Json });
  assert.equal(written.revision, 2);

  // It opens nothing: the lift is weighed AGAIN out of the record it names, by the function that lifted it (T3).
  const refused_ = addressed(refusalOf(openAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() })), "hold_invalid", held.hold.id);
  assert.equal(refused_.at.field, "lift.record");
  assert.equal(heldSeries(store)!.value.attempts.length, 1);
  assert.equal(refusalOf(stopContext(store, address(PROJECT))).code, "hold_invalid");
  // And a lift offered on top of it is refused too: the hold it would lift does not read as one.
  assert.equal(refusalOf(liftOriginHold(store, liftBy(PROJECT, reference(store.get(held.hold.id)!), "owner-decision",
    { ref: storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace(PROJECT), decisionOf(held.standing)) }))).code, "hold_invalid");
  store.close();

  // A restart reads the same records and reaches the same finding: a silent opening is exactly what it must not be.
  const back = new Store(path);
  t.after(() => back.close());
  assert.equal(refusalOf(openAttempt(back, { ...address(PROJECT), attempt: 2, goal: goal() })).code, "hold_invalid");
  assert.equal(refusalOf(stopContext(back, address(PROJECT))).code, "hold_invalid");

  // The same again where the CLASS agrees with the analysis but the grounds saved beside it were trimmed: what the
  // record establishes is the whole finding, and a lift that holds part of it does not hold the finding.
  opened(back, "trimmed");
  const other = heldOn(back, "trimmed", { sources: [] });
  const grounds = assembly(back, "trimmed", { bases: [true], derived: [[SUBJECT]] });
  const culprit = grounds.find(item => item.role === "base")!.ref;
  const record = storedAs(back, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace("trimmed"),
    analysisOf(other.standing, { class: "input", basis: grounds }));
  back.write({
    id: other.hold.id, kind: ORIGIN_HOLD_KIND, expected: 1,
    value: {
      ...other.standing,
      lift: {
        ground: "origin-analysis", record, class: "input",
        addressee: `${ADDRESSEE_KINDS.input}:${culprit.id}`, basis: grounds.filter(item => item.role === "base"),
      },
    } as unknown as Json,
  });
  const trimmed = addressed(refusalOf(openAttempt(back, { ...address("trimmed"), attempt: 2, goal: goal() })), "hold_invalid", other.hold.id);
  assert.equal(trimmed.at.field, "lift");
  // Lifted through the gate instead, the very same analysis opens the next attempt.
  back.write({ id: other.hold.id, kind: ORIGIN_HOLD_KIND, expected: 2, value: other.standing as unknown as Json });
  deliveredOf(liftOriginHold(back, liftBy("trimmed", reference(back.get(other.hold.id)!), "origin-analysis", { ref: record })));
  deliveredOf(openAttempt(back, { ...address("trimmed"), attempt: 2, goal: goal() }));
});

// ---------------------------------------------------------------------------
// The heads a context was read from, handed over for whoever writes on it (journal record №184, interface of A5).

test("the gate hands over the mutable heads a context was read from, the LIFTED holds among them", t => {
  const { store } = fixture(t);
  opened(store);
  const held = heldBy(store, PROJECT);
  const standing = holdAt(store, held.hold);
  // The owner decided about that origin; the hold is lifted and the series goes on to its stop.
  const decision = storedAs(store, ORIGIN_DECISION_KIND, originDecisionNamespace(PROJECT), decisionOf(standing));
  deliveredOf(liftOriginHold(store, liftBy(PROJECT, held.hold, "owner-decision", { ref: decision })));
  for (let index = 0; index < 2; index += 1) closed(store, PROJECT, goal(), outcome({ reason: "off-form" }));

  const reading = deliveredOf(readStopContext(store, address(PROJECT)));
  // The context is the one context, assembled by the one function; the reading only says what it was read from.
  assert.deepEqual(reading.context, deliveredOf(stopContext(store, address(PROJECT))));
  assert.equal(reading.context.stop!.attempt, 3);
  assert.deepEqual(reading.context.holds, []);

  // Every head, each at the revision it stands at: the series, the journal, and the hold — lifted, and still read.
  assert.deepEqual([...reading.reads].map(ref => ref.id).sort(),
    [at(PROJECT), journalId(PROJECT), held.hold.id].sort());
  for (const ref of reading.reads) {
    const current = store.get(ref.id)!;
    assert.equal(ref.revision, current.revision);
    assert.equal(ref.hash, current.hash);
  }
  // The HISTORICAL records a context names are not heads: the record the hold was lifted on is read at its exact
  // reference, and a newer revision of it makes the lift no less true.
  assert.equal(reading.reads.some(ref => ref.id === decision.id), false);

  // A series no gate has refused anything in keeps no journal, and the reading says so instead of naming an absent one.
  opened(store, "beta");
  for (let index = 0; index < 3; index += 1) closed(store, "beta", goal(), outcome({ reason: "interrupted" }), 1);
  const quiet = deliveredOf(readStopContext(store, address("beta")));
  assert.deepEqual([...quiet.reads].map(ref => ref.id), [at("beta")]);

  // Both entrances refuse a series nothing stops, with the same code and the same address.
  opened(store, "gamma");
  assert.equal(refusalOf(readStopContext(store, address("gamma"))).code, "stop_absent");
  assert.equal(refusalOf(stopContext(store, address("gamma"))).code, "stop_absent");
  assert.throws(() => readStopContext(store, undefined as unknown as SeriesRequest), typedDefect);
  assert.ok(deeplyFrozen(reading));
});


test("G7 observes real first-pass and accepted bases of both producers through their historical contracts", async t => {
  const { store, path } = fixture(t);
  const initial = initialFrame(store, "initial");
  assert.equal(store.get("om-frame:initial:2"), null);
  assert.ok(store.get<Graph>(initial.first.graph.id)!.value.nodes.every(node => node.kind !== "operation" && node.kind !== "work"));
  assert.ok(deliveredOf(readDefinitions(store, { project: "initial", source: { role: "base", ref: initial.first.graph,
    context: { kind: "frame", request: initial.first } } })).definitions.includes("initial-produce-block"));
  const f = definitionFixture(store, PROJECT);
  assert.equal(f.first.layer, null); assert.equal(f.first.frame, null);
  const read = (record: Record<string, unknown>) => deliveredOf(readDefinitions(store, { project: PROJECT, source: record as unknown as OriginSource }));
  assert.ok(!read(source("base", f.first.graph)).definitions.includes(SUBJECT));
  assert.ok(read(source("base", f.accepted.graph)).definitions.includes(SUBJECT));
  assert.ok(read({ role: "base", ref: f.accepted.frame!, context: { kind: "frame", request: f.accepted } }).definitions.includes(SUBJECT));
  const graphHead = store.get(f.accepted.graph.id)!;
  store.write({ id: graphHead.id, kind: graphHead.kind, expected: graphHead.revision, value: graphHead.value });
  const sourceHead = store.get(`source:${PROJECT}:brief`)!;
  store.write({ id: sourceHead.id, kind: sourceHead.kind, expected: sourceHead.revision, value: sourceHead.value });
  assert.ok(read(source("base", f.accepted.graph)).definitions.includes(SUBJECT));
  const saved = source("base", f.accepted.graph);
  store.close();
  const back = new Store(path); t.after(() => back.close());
  assert.ok(deliveredOf(readDefinitions(back, { project: PROJECT, source: saved as unknown as OriginSource })).definitions.includes(SUBJECT));

  const native = "native", nativeFixture = await createOmFixture(t, "standard", native);
  const nativeStore = nativeFixture.store;
  const input = deliveredOf(writeOmInput(nativeStore, { project: native, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(nativeStore.get(`stage:${native}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const horizon = deliveredOf(writeHorizon(nativeStore, { project: native, input: reference(input), graph: reference(nativeStore.get(`graph:${native}`)!),
    refinement: reference(nativeStore.get(`phase:${native}:L2`)!), choice: { choiceVersion: "origin-native", features: [{ outcome: `${native}-result` }], excluded: [] }, available: {} }));
  const request: FrameRequest = { project: native, level: 2, graph: reference(nativeStore.get(`graph:${native}`)!), horizon: reference(horizon.gate),
    layer: reference(nativeStore.get(`graph-layer:${native}:2`)!), frame: null, upper: null };
  const definitions = deliveredOf(readDefinitions(nativeStore, { project: native, source: { role: "base", ref: request.graph,
    context: { kind: "frame", request } } })).definitions;
  assert.ok(definitions.includes(`${native}-prep-operation`));
  assert.ok(definitions.includes(`${native}-prep`));
});

test("G7 refuses missing or alien observation contexts and unreadable modern sections without falling back to defines", t => {
  const { store } = fixture(t), f = definitionFixture(store, PROJECT);
  const offered = carries(store, PROJECT, "proposal", [SUBJECT]), normal = source("proposal", offered);
  const check = (origin: Record<string, unknown>) => {
    const before = store.list().map(reference);
    const found = refusalOf(readDefinitions(store, { project: PROJECT, source: origin as unknown as OriginSource }));
    assert.ok(["origin_unreadable", "proposal_invalid", "proposal_base_stale", "proposal_foreign", "record_foreign", "record_forged", "candidate_graph_mismatch", "frame_basis_unproven", "candidate_missing"].includes(found.code), found.code);
    assert.ok(found.at.field || found.at.ref); assert.deepEqual(store.list().map(reference), before);
  };
  check({ role: "proposal", ref: offered });
  check({ ...normal, context: { kind: "proposal", request: { frame: f.first, proposals: [] } } });
  check({ ...normal, context: { kind: "proposal", request: { frame: f.accepted, proposals: [offered] } } });
  const foreign = definitionFixture(store, "foreign");
  check({ ...normal, context: { kind: "proposal", request: { frame: foreign.first, proposals: [offered] } } });
  check({ ...normal, ref: { ...offered, hash: hex("d") } });
  check({ role: "base", ref: f.accepted.graph });
  check({ role: "base", ref: f.accepted.graph, context: { kind: "frame", request: f.first } });
  for (const field of ["nodes", "artifacts", "contracts", "localConnectors", "fills"]) {
    const value = structuredClone(store.get(offered.id)!.value) as unknown as Record<string, Json>;
    delete value[field]; value["defines"] = [SUBJECT];
    const ref = reference(store.write({ id: `om-proposal:${PROJECT}:missing-${field}`, kind: "layer-proposal", expected: 0, value }));
    check({ role: "proposal", ref, context: { kind: "proposal", request: { frame: f.first, proposals: [ref] } } });
  }
  const candidate = carries(store, PROJECT, "candidate", [SUBJECT]);
  const savedRequest = store.get<FrameCandidateRecord>(candidate.id)!.value.request;
  assert.ok(deliveredOf(readDefinitions(store, { project: PROJECT, source: { role: "derived", ref: candidate,
    context: { kind: "proposal", request: savedRequest } } })).definitions.includes(SUBJECT));
  check({ role: "derived", ref: candidate, context: { kind: "proposal", request: { ...savedRequest, proposals: [offered] } } });
  check({ role: "derived", ref: candidate, context: { kind: "frame", request: savedRequest.frame } });
  for (const field of ["nodes", "artifacts", "contracts", "connectors"]) {
    const value = structuredClone(store.get(candidate.id)!.value) as unknown as Record<string, Json>;
    const graph = value["graph"] as Record<string, Json>; delete graph[field]; value["defines"] = [SUBJECT];
    const ref = reference(store.write({ id: `om-candidate:${PROJECT}:missing-${field}`, kind: "frame-candidate", expected: 0, value }));
    check({ role: "derived", ref });
  }
  const legacy = reference(store.write({ id: `om-proposal:${PROJECT}:legacy`, kind: "om-proposal", expected: 0, value: { defines: [SUBJECT] } }));
  check({ role: "proposal", ref: legacy });
  const get = store.get.bind(store);
  try {
    for (const fault of [new TypeError("source read failed"), new EngineError("record_corrupt", "source corrupt")]) {
      store.get = ((id: string, revision?: number) => { if (id === f.first.graph.id) throw fault; return get(id, revision); }) as Store["get"];
      assert.throws(() => readDefinitions(store, { project: PROJECT, source: source("base", f.first.graph) as unknown as OriginSource }), error => error === fault);
    }
  } finally { store.get = get; }
});

test("G7 source context participates in identity and ordering, and different assemblies cannot share a classification", t => {
  const { store } = fixture(t); opened(store);
  const first = carries(store, PROJECT, "proposal", [SUBJECT]), second = carries(store, PROJECT, "proposal", []);
  const frame = definitionFixture(store, PROJECT).first;
  const a: OriginSource = { role: "proposal", ref: first, context: { kind: "proposal", request: { frame, proposals: [first] } } };
  const b: OriginSource = { role: "proposal", ref: first, context: { kind: "proposal", request: { frame,
    proposals: [first, second].sort((x, y) => canonical(x) < canonical(y) ? -1 : 1) } } };
  const incompatible = journalled(store, PROJECT, { sources: [b, a, b] });
  const stored = heldJournal(store)!.value.rows.find(item => item.id === incompatible.row)!.origin.sources;
  assert.equal(stored.length, 3); assert.equal(stored.filter(item => canonical(item) === canonical(b)).length, 2);
  assert.deepEqual(stored, [a, b, b].sort((x, y) => canonical(x) < canonical(y) ? -1 : 1));
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const before = store.list().map(reference);
  for (const close of [prepareCloseAttempt, closeAttempt]) {
    assert.equal(refusalOf(close(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(incompatible) }) as OmResult<unknown>).code, "origin_unreadable");
    assert.deepEqual(store.list().map(reference), before);
  }
  const refusal = journalled(store, PROJECT, { sources: [a, a, a] });
  const result = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) }));
  assert.deepEqual(routeOf(result, refusal.row).basis, [a, a, a]);
  assert.equal(routeOf(result, refusal.row).class, "unknown");
  const journal = heldJournal(store)!;
  const again = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(refusal) }));
  assert.deepEqual(again.routed, result.routed); assert.equal(heldJournal(store)!.revision, journal.revision);
  const analysis = analysisOf(holdAt(store, result.holds[0]!), { class: "proposal", basis: [a] });
  const lifted = deliveredOf(liftOriginHold(store, liftBy(PROJECT, result.holds[0]!, "origin-analysis",
    { pending: { id: `${originAnalysisNamespace(PROJECT)}context`, kind: ORIGIN_ANALYSIS_KIND, value: analysis as Json } })));
  assert.deepEqual(lifted.value.lift!.basis, [a]);
  const secondRow = journalled(store, PROJECT, { sources: [b] }, { code: "same-context-test", goal: "same-context-goal" });
  const firstRow = journalled(store, PROJECT, { sources: [a] }, { code: "same-context-test", goal: "same-context-goal" });
  assert.notEqual(firstRow.row, secondRow.row);
});


test("G7 routes a saved refusal candidate that lost a definition from its actual proposal without accepting it", t => {
  const { store, path } = fixture(t), f = definitionFixture(store, PROJECT);
  const accepted = store.get<{ acceptance: { candidate: Ref } }>(f.accepted.frame!.id, f.accepted.frame!.revision)!;
  const original = store.get<FrameCandidateRecord>(accepted.value.acceptance.candidate.id)!;
  const value = structuredClone(original.value);
  value.graph.artifacts = value.graph.artifacts.filter(item => item.id !== SUBJECT);
  value.graphHash = hashJson(value.graph); value.layerHash = hashJson(projectGraph(value.graph, 2));
  const candidate = reference(store.write({ id: `om-candidate:${PROJECT}:${hashJson([value.graphHash, value.base, value.proposals])}`,
    kind: "frame-candidate", expected: 0, value }));
  const proposal = original.value.proposals[0]!;
  const grounds: OriginSource[] = [
    { role: "proposal", ref: proposal, context: { kind: "proposal", request: original.value.request } },
    source("base", f.first.graph) as unknown as OriginSource,
    { role: "derived", ref: candidate },
  ];
  assert.ok(deliveredOf(readDefinitions(store, { project: PROJECT, source: grounds[0]! })).definitions.includes(SUBJECT));
  assert.ok(!deliveredOf(readDefinitions(store, { project: PROJECT, source: grounds[2]! })).definitions.includes(SUBJECT));
  assert.equal(readCandidate(store, { project: PROJECT, candidate }).ok, false);
  assert.equal(gateCandidate(store, { project: PROJECT, candidate }).ok, false);
  opened(store);
  const ordinary = journalled(store, PROJECT, { sources: grounds });
  const held = heldOn(store, PROJECT, { sources: [] }, [ordinary]);
  assert.equal(routeOf(held.result, ordinary.row).class, "derivation");
  assert.equal(routeOf(held.result, ordinary.row).addressee, `${ADDRESSEE_KINDS.derivation}:${candidate.id}`);
  const analysis = analysisOf(held.standing, { class: "derivation", basis: grounds });
  const lifted = deliveredOf(liftOriginHold(store, liftBy(PROJECT, held.hold, "origin-analysis",
    { pending: { id: `${originAnalysisNamespace(PROJECT)}lost-definition`, kind: ORIGIN_ANALYSIS_KIND, value: analysis as Json } })));
  assert.deepEqual(lifted.value.lift!.basis, routeOf(held.result, ordinary.row).basis);
  // The proposal is now accepted at its head; its original proposed revision is still the historical source.
  assert.equal(store.get<LayerProposal>(proposal.id)!.value.status, "accepted");
  assert.equal(store.get<LayerProposal>(proposal.id, proposal.revision)!.value.status, "proposed");
  store.close(); const back = new Store(path); t.after(() => back.close());
  assert.equal(refusalOf(stopContext(back, address(PROJECT))).code, "stop_absent");
  deliveredOf(openAttempt(back, { ...address(PROJECT), attempt: 2, goal: goal() }));
});


test("G7 refuses individually valid sources from another assembly on close, lift and historical reread", t => {
  const { store, path } = fixture(t), f = definitionFixture(store, PROJECT);
  const actual = assembly(store, PROJECT, { proposals: [[]], bases: [false], derived: [[]] });
  const foreignProposal = assembly(store, PROJECT, { proposals: [[SUBJECT]] }).find(item => item.role === "proposal")!;
  const foreignBase = source("base", f.accepted.graph) as unknown as OriginSource;
  const bad = [
    { name: "proposal", sources: actual.map(item => item.role === "proposal" ? foreignProposal : item) },
    { name: "base", sources: actual.map(item => item.role === "base" ? foreignBase : item) },
  ];
  const derived = actual.find(item => item.role === "derived")!;
  assert.ok(deliveredOf(readDefinitions(store, { project: PROJECT, source: foreignProposal })).definitions.includes(SUBJECT));
  assert.ok(deliveredOf(readDefinitions(store, { project: PROJECT, source: foreignBase })).definitions.includes(SUBJECT));
  for (const item of actual) assert.ok(!deliveredOf(readDefinitions(store, { project: PROJECT, source: item })).definitions.includes(SUBJECT));
  const snapshot = (db: Store) => db.list().map(row => ({ head: reference(row), history: db.history(row.id).map(reference) }));
  opened(store); deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  for (const entry of bad) {
    const row = journalled(store, PROJECT, { sources: entry.sources });
    const before = snapshot(store);
    for (const close of [prepareCloseAttempt, closeAttempt]) {
      const result = close(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(row) });
      const found = refusalOf(result as OmResult<unknown>);
      assert.equal(found.code, "origin_unreadable", entry.name); assert.ok(found.at.field?.includes("origin.sources"));
      assert.ok(found.at.field?.includes("context")); assert.deepEqual(snapshot(store), before);
    }
  }
  const valid = journalled(store, PROJECT, { sources: actual });
  const placed = deliveredOf(closeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusedBy(valid) }));
  assert.equal(routeOf(placed, valid.row).class, "proposal");
  const held = heldBy(store, PROJECT), standing = holdAt(store, held.hold);
  for (const entry of bad) {
    const value = analysisOf(standing, { class: "derivation", basis: entry.sources });
    const record = storedAs(store, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace(PROJECT), value);
    for (const apply of [prepareLiftOriginHold, liftOriginHold]) for (const pending of [false, true]) {
      const id = `${originAnalysisNamespace(PROJECT)}unlinked-${entry.name}-${next()}`;
      const before = snapshot(store);
      const result = apply(store, liftBy(PROJECT, reference(store.get(held.hold.id)!), "origin-analysis", pending
        ? { pending: { id, kind: ORIGIN_ANALYSIS_KIND, value: value as Json } } : { ref: record }));
      const found = refusalOf(result as OmResult<unknown>);
      assert.equal(found.code, "lift_unusable", entry.name); assert.ok(found.at.field?.includes("record.basis"));
      assert.ok(found.at.field?.includes("context")); assert.deepEqual(snapshot(store), before);
      if (pending) assert.equal(store.get(id), null);
    }
    const current = store.get(held.hold.id)!;
    const savedBasis = entry.sources.map(normalizeOriginSource)
      .sort((left, right) => originSourceKey(left) < originSourceKey(right) ? -1 : originSourceKey(left) > originSourceKey(right) ? 1 : 0);
    const forged = store.write({ id: current.id, kind: current.kind, expected: current.revision,
      value: { ...standing, lift: { ground: "origin-analysis", record, class: "derivation",
        addressee: `${ADDRESSEE_KINDS.derivation}:${derived.ref.id}`, basis: savedBasis } } as unknown as Json });
    const before = snapshot(store);
    for (const open of [prepareOpenAttempt, openAttempt]) {
      const found = refusalOf(open(store, { ...address(PROJECT), attempt: 3, goal: goal() }) as OmResult<unknown>);
      assert.equal(found.code, "hold_invalid"); assert.equal(found.at.field, "lift.record");
    }
    for (const read of [readStopContext, stopContext]) {
      const found = refusalOf(read(store, address(PROJECT)) as OmResult<unknown>);
      assert.equal(found.code, "hold_invalid"); assert.equal(found.at.field, "lift.record");
    }
    assert.deepEqual(snapshot(store), before);
    // A new connection must reject the same saved lift from the exact historical grounds.
    const reopened = new Store(path);
    try {
      assert.equal(refusalOf(openAttempt(reopened, { ...address(PROJECT), attempt: 3, goal: goal() })).code, "hold_invalid");
      assert.equal(refusalOf(stopContext(reopened, address(PROJECT))).code, "hold_invalid");
      assert.deepEqual(snapshot(reopened), before);
    } finally { reopened.close(); }
    store.write({ id: forged.id, kind: forged.kind, expected: forged.revision, value: standing as unknown as Json });
  }
  // Current heads do not rewrite which assembly the saved references witnessed.
  for (const ref of new Map([...actual, foreignProposal, foreignBase].map(item => [item.ref.id, item.ref])).values()) {
    const head = store.get(ref.id)!;
    store.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
  }
  const request = liftBy(PROJECT, reference(store.get(held.hold.id)!), "origin-analysis", { pending: {
    id: `${originAnalysisNamespace(PROJECT)}linked`, kind: ORIGIN_ANALYSIS_KIND,
    value: analysisOf(standing, { class: "proposal", basis: actual }) as Json } });
  const lifted = deliveredOf(liftOriginHold(store, request));
  assert.equal(lifted.value.lift!.class, "proposal");
  store.close(); const back = new Store(path); t.after(() => back.close());
  const before = snapshot(back);
  assert.equal(deliveredOf(liftOriginHold(back, request)).hash, lifted.hash);
  assert.deepEqual(snapshot(back), before);
  deliveredOf(openAttempt(back, { ...address(PROJECT), attempt: 3, goal: goal() }));
});


// A3.3 uses the same D1/M6 path as the first real addressing pass. No series field stands in for a D1 source.
const addressingOwner = { kind: "mechanism", mechanism: "M5:addressing" } as const;
function mechanismFixture(t: test.TestContext, names = ["format-a", "format-b"]) {
  const root = mkdtempSync(join(tmpdir(), "omg-g7-mechanism-")), path = join(root, "state.sqlite"), project = "garden";
  let store = new Store(path), version = 0;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...upper } = projectGraph(gardenGraph(), 1);
  preparedFeatures(new ProductEngine(store), project, upper as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = names.map(id => ({ id,
      question: `Which ${id} is required?`, consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false,
      resolution: "Address this question during OM" }));
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  let input = deliveredOf(writeOmInput(store, { project, expected: 0, stages }));
  const graph = reference(store.get(`graph:${project}`)!);
  function refresh() {
    const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph, refinement: null,
      choice: { choiceVersion: `mechanism-${++version}`, features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
    const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
      operations: { proposals: [], frame: { project, level: 2, graph, horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
      works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
    const gaps = deliveredOf(writeGaps(store, sources));
    const scope: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
    const routes = deliveredOf(writeRoutes(store, { project, gaps: scope, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
    const batch = routes.value.batches.find(item => item.model === "MC2" && item.task === "input-field"
      && item.items.every(gap => gap.field === "address"));
    const goal: AttemptGoal | null = batch ? { key: "address-questions", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) } : null;
    return { scope, routes: reference(routes), batch, goal };
  }
  function addressQuestions(ids: string[]) {
    input = deliveredOf(writeAddressing(store, { project, input: reference(input), graph,
      decisions: ids.map(id => ({ pending: structuredClone(inputDecisionWrite({ project, input: reference(input), graph, layers: [],
        decision: { target: `discovery:${id}`, field: "address", value: { consumer: "garden-consume-block", kind: "owner-decision" } },
      })) as Write })) }));
    return refresh();
  }
  const initial = refresh();
  assert.ok(initial.batch && initial.goal, "native D1 must expose the real unaddressed batch");
  const address = (line = 1) => ({ project, owner: addressingOwner, line });
  const begin = (state: ReturnType<typeof refresh>, attempt: number, line = 1) => {
    assert.ok(state.batch && state.goal);
    return { ...address(line), attempt, goal: state.goal, admission: { gaps: state.scope, routes: state.routes, batch: state.batch.id } };
  };
  return { project, path, graph, initial, address, begin, refresh, addressQuestions,
    get store() { return store; }, get input() { return input; },
    restart() { store.close(); store = new Store(path); } };
}
const mechanismSnapshot = (store: Store) => store.list().map(record => ({ ref: reference(record), history: store.history(record.id).map(reference) }));

test("A3.3 G7 mechanism cycles inherit the count, stop, ladder and context across a changed D1 slice and restart", t => {
  const f = mechanismFixture(t), initial = deliveredOf(openSeries(f.store,
    { ...f.address(), scope: f.initial.scope, predecessor: null, basis: null }));
  let stopped: RepeatOutcome | undefined;
  for (const attempt of [1, 2, 3]) {
    const opened = deliveredOf(openAttempt(f.store, f.begin(f.initial, attempt)));
    assert.equal(opened.value.attempts.at(-1)!.outcome, null);
    const result = deliveredOf(closeAttempt(f.store, { ...f.address(), attempt, outcome: outcome() }));
    assert.equal(result.verdict, "none"); assert.equal(result.withoutProgress, attempt);
    assert.deepEqual(result.routed, []); assert.deepEqual(result.holds, []);
    stopped = result as RepeatOutcome;
  }
  assert.ok(stopped?.stop && stopped.ladder && stopped.context);
  assert.equal(stopped.stop.attempt, 3); assert.equal(stopped.ladder.rung, 1);
  assert.deepEqual(stopped.context.accepted, []);
  const sourceSeries = f.store.get(initial.id)!;
  const nextScope = f.addressQuestions(["format-a"]);
  const successor = deliveredOf(openSeries(f.store, { ...f.address(2), scope: nextScope.scope,
    predecessor: reference(sourceSeries), basis: { ground: "inputs-changed", text: "D3 addressed the first producer question" } }));
  assert.equal(successor.value.inherited.length, 3);
  const inherited = deliveredOf(stopContext(f.store, f.address(2)));
  assert.deepEqual(inherited.stop, stopped.stop); assert.equal(inherited.ladder.rung, 1);
  assert.deepEqual(inherited.endings, stopped.context.endings);
  assert.equal(refusalOf(openAttempt(f.store, f.begin(nextScope, 4, 2))).code, "series_stopped");
  const reviewValue = { ...review(f.project, 3, stopped.stop.goals), owner: addressingOwner } as Record<string, unknown>;
  delete reviewValue.block;
  const reviewRef = storedAs(f.store, STOP_REVIEW_KIND, stopReviewNamespace(f.project), reviewValue);
  deliveredOf(resumeSeries(f.store, { ...f.address(2), stop: 3, ground: "review-record", text: "Review changed the addressing approach", review: { ref: reviewRef } }));
  let second: typeof stopped;
  for (const attempt of [4, 5, 6]) {
    deliveredOf(openAttempt(f.store, f.begin(nextScope, attempt, 2)));
    second = deliveredOf(closeAttempt(f.store, { ...f.address(2), attempt, outcome: outcome() })) as RepeatOutcome;
  }
  assert.equal(second!.stop!.attempt, 6); assert.equal(second!.ladder!.rung, 2);
  assert.deepEqual(second!.ladder!.grounds, ["owner-decision"]);
  const current = f.store.get(successor.id)!, context = deliveredOf(readStopContext(f.store, f.address(2)));
  assert.ok(context.reads.some(ref => canonical(ref) === canonical(reference(current))));
  const before = mechanismSnapshot(f.store);
  assert.equal(deliveredOf(closeAttempt(f.store, { ...f.address(), attempt: 1, outcome: outcome() })).verdict, "none");
  assert.deepEqual(mechanismSnapshot(f.store), before, "late closure cannot alter the successor or the old series");
  f.restart();
  assert.deepEqual(deliveredOf(stopContext(f.store, f.address(2))), context.context);
  assert.equal(refusalOf(openAttempt(f.store, f.begin(nextScope, 7, 2))).code, "series_stopped");
});

test("A3.3 G7 mechanism unknown-origin hold survives succession and only its own owner decision lifts it historically", t => {
  const f = mechanismFixture(t), first = deliveredOf(openSeries(f.store,
    { ...f.address(), scope: f.initial.scope, predecessor: null, basis: null }));
  const refusal = journalled(f.store, f.project, { sources: [] }, { goal: f.initial.goal!.result });
  deliveredOf(openAttempt(f.store, f.begin(f.initial, 1)));
  const readiness = journalled(f.store, f.project, { stage: "readiness", subject: "garden-consume-block",
    sources: [source("base", remember(f.graph, { kind: "frame", request: f.initial.scope.sources.operations.frame }))] },
    { gate: "M2", code: "readiness_stale" });
  const beforeReadiness = mechanismSnapshot(f.store);
  const noBlock = refusalOf(closeAttempt(f.store, { ...f.address(), attempt: 1, outcome: refusedBy(readiness) }));
  assert.equal(noBlock.code, "origin_unreadable"); assert.equal(noBlock.at.field, "owner");
  assert.deepEqual(mechanismSnapshot(f.store), beforeReadiness);
  const closed = deliveredOf(closeAttempt(f.store, { ...f.address(), attempt: 1, outcome: refusedBy(refusal) }));
  assert.equal(closed.holds.length, 1); assert.equal(closed.routed[0]!.class, "unknown");
  const hold = closed.holds[0]!, content = f.store.get<{ projectId: string; owner: typeof addressingOwner; attempt: number; row: string; lift: unknown }>(hold.id)!.value;
  assert.deepEqual(content.owner, addressingOwner);
  assert.equal(Object.hasOwn(content, "block"), false);
  assert.equal(originHoldId(f.project, addressingOwner, 1, refusal.row), hold.id);
  const nextScope = f.addressQuestions(["format-a"]);
  deliveredOf(openSeries(f.store, { ...f.address(2), scope: nextScope.scope, predecessor: reference(f.store.get(first.id)!),
    basis: { ground: "inputs-changed", text: "Only the second question still needs addressing" } }));
  assert.equal(refusalOf(openAttempt(f.store, f.begin(nextScope, 2, 2))).code, "origin_held");
  assert.deepEqual(deliveredOf(stopContext(f.store, f.address(2))).holds.map(item => item.hold), [hold]);
  const decision = { projectId: f.project, owner: addressingOwner, attempt: 1, row: refusal.row,
    decided: "Continue addressing after reviewing the origin", approved: true };
  for (const substitution of [{ ...decision, owner: { kind: "mechanism", mechanism: "M6" } },
    { projectId: f.project, block: "M5:addressing", attempt: 1, row: refusal.row, decided: decision.decided, approved: true }]) {
    const id = `${originDecisionNamespace(f.project)}mechanism-foreign-${next()}`, before = mechanismSnapshot(f.store);
    assert.equal(refusalOf(liftOriginHold(f.store, { project: f.project, hold, ground: "owner-decision",
      record: { pending: { id, kind: ORIGIN_DECISION_KIND, value: substitution as Json } } })).code, "lift_unusable");
    assert.deepEqual(mechanismSnapshot(f.store), before);
  }
  // The reverse substitution fails too: an explicit mechanism owner is not the block whose name resembles it.
  opened(f.store, f.project);
  const blockHeld = heldBy(f.store, f.project), block = holdAt(f.store, blockHeld.hold);
  const wrongForBlock = { ...decision, attempt: block.attempt, row: block.row };
  assert.equal(refusalOf(liftOriginHold(f.store, { project: f.project, hold: blockHeld.hold, ground: "owner-decision",
    record: { pending: { id: `${originDecisionNamespace(f.project)}mechanism-for-block`, kind: ORIGIN_DECISION_KIND,
      value: wrongForBlock as Json } } })).code, "lift_unusable");
  const decisionRef = storedAs(f.store, ORIGIN_DECISION_KIND, originDecisionNamespace(f.project), decision);
  const request = { project: f.project, hold, ground: "owner-decision" as const, record: { ref: decisionRef } };
  const lifted = deliveredOf(liftOriginHold(f.store, request));
  assert.equal(deliveredOf(readOriginHoldAt(f.store, f.project, hold)).value.lift, null);
  assert.deepEqual(reference(deliveredOf(readOriginHoldAt(f.store, f.project, reference(lifted)))), reference(lifted));
  deliveredOf(openAttempt(f.store, f.begin(nextScope, 2, 2)));
  deliveredOf(closeAttempt(f.store, { ...f.address(2), attempt: 2, outcome: outcome() }));
  const before = mechanismSnapshot(f.store);
  assert.equal(deliveredOf(liftOriginHold(f.store, request)).revision, lifted.revision);
  assert.deepEqual(deliveredOf(closeAttempt(f.store, { ...f.address(), attempt: 1, outcome: refusedBy(refusal) })).holds, []);
  assert.deepEqual(mechanismSnapshot(f.store), before);
  f.restart();
  assert.equal(deliveredOf(liftOriginHold(f.store, request)).revision, lifted.revision);
  assert.equal(deliveredOf(readOriginHoldAt(f.store, f.project, hold)).value.lift, null);
  deliveredOf(openAttempt(f.store, f.begin(nextScope, 3, 2)));
  // A stored lift is checked against the same owner contract again; a rehashed body cannot launder substitution.
  const substituted = storedAs(f.store, ORIGIN_DECISION_KIND, originDecisionNamespace(f.project),
    { ...decision, owner: { kind: "mechanism", mechanism: "M6" } });
  const currentHold = f.store.get<Record<string, Json>>(hold.id)!;
  f.store.write({ id: hold.id, kind: ORIGIN_HOLD_KIND, expected: currentHold.revision,
    value: { ...currentHold.value, lift: { ...(currentHold.value.lift as Record<string, Json>), record: substituted as unknown as Json } } });
  f.restart();
  assert.equal(refusalOf(stopContext(f.store, f.address(2))).code, "hold_invalid");
  assert.equal(refusalOf(liftOriginHold(f.store, request)).code, "hold_invalid");
  assert.equal(refusalOf(readOriginHoldAt(f.store, f.project, reference(f.store.get(hold.id)!))).code, "hold_invalid");
  assert.equal(deliveredOf(readOriginHoldAt(f.store, f.project, hold)).value.lift, null);
});

test("A3.3 G7 closes the saved mechanism goal after D3 has removed its gaps without inventing an achievement or cancellation", t => {
  const f = mechanismFixture(t), series = deliveredOf(openSeries(f.store,
    { ...f.address(), scope: f.initial.scope, predecessor: null, basis: null }));
  deliveredOf(openAttempt(f.store, f.begin(f.initial, 1)));
  const filled = f.addressQuestions(["format-a", "format-b"]);
  assert.equal(filled.batch, undefined);
  const before = mechanismSnapshot(f.store);
  for (const [field, code] of [["accepting", "acceptance_unconfirmed"], ["cancelling", "cancellation_unconfirmed"]] as const) {
    const rejection = refusalOf(closeAttempt(f.store, { ...f.address(), attempt: 1,
      outcome: outcome({ [field]: [reference(f.input)] }) }));
    assert.equal(rejection.code, code); assert.ok(rejection.at.target);
    assert.deepEqual(mechanismSnapshot(f.store), before);
  }
  const request = { ...f.address(), attempt: 1, outcome: outcome() };
  const result = deliveredOf(closeAttempt(f.store, request));
  assert.equal(result.verdict, "none"); assert.equal(result.withoutProgress, 1);
  const current = f.store.get<{ attempts: { goal: AttemptGoal; outcome: { achieved: unknown[]; cancelled: unknown[] } }[] }>(series.id)!;
  assert.deepEqual(current.value.attempts[0]!.goal, f.initial.goal);
  assert.deepEqual(current.value.attempts[0]!.outcome.achieved, []);
  assert.deepEqual(current.value.attempts[0]!.outcome.cancelled, []);
  const beforeRepeat = mechanismSnapshot(f.store);
  assert.deepEqual(deliveredOf(prepareCloseAttempt(f.store, request)).writes, []);
  assert.equal(openSeries(f.store, { ...f.address(2), scope: filled.scope, predecessor: reference(current),
    basis: { ground: "inputs-changed", text: "Every question was addressed" } }).ok, false, "empty mechanism work cannot erase the chain");
  assert.deepEqual(mechanismSnapshot(f.store), beforeRepeat);
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), result);
  assert.deepEqual(mechanismSnapshot(f.store), beforeRepeat);
});

test("A3.3 G7 prepared mechanism admission and closure guard their whole transaction against concurrent changes", t => {
  const f = mechanismFixture(t), series = deliveredOf(openSeries(f.store,
    { ...f.address(), scope: f.initial.scope, predecessor: null, basis: null }));
  const prepared = deliveredOf(prepareOpenAttempt(f.store, f.begin(f.initial, 1)));
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(f.input))));
  f.addressQuestions(["format-a"]);
  const noAttempt = mechanismSnapshot(f.store), neighbor = { id: "mechanism-race-neighbor", kind: "test-neighbor", expected: 0, value: {} };
  assert.equal(refusalOf(writeGuarded(f.store, { unit: "G7", target: series.id,
    writes: [...prepared.writes, neighbor], guards: [...prepared.guards] })).code, "input_stale");
  assert.equal(f.store.get(neighbor.id), null); assert.deepEqual(mechanismSnapshot(f.store), noAttempt);

  const nextScope = f.refresh(), successor = deliveredOf(openSeries(f.store, { ...f.address(2), scope: nextScope.scope,
    predecessor: reference(f.store.get(series.id)!), basis: { ground: "inputs-changed", text: "The first question is now addressed" } }));
  deliveredOf(openAttempt(f.store, f.begin(nextScope, 1, 2)));
  const refusal = journalled(f.store, f.project, { sources: [] }, { goal: nextScope.goal!.result });
  const closing = deliveredOf(prepareCloseAttempt(f.store, { ...f.address(2), attempt: 1, outcome: refusedBy(refusal) }));
  const winner = deliveredOf(closeAttempt(f.store, { ...f.address(2), attempt: 1, outcome: outcome() })), beforeRace = mechanismSnapshot(f.store);
  assert.ok(["input_stale", "revision_conflict"].includes(refusalOf(writeGuarded(f.store, { unit: "G7", target: successor.id,
    writes: [...closing.writes, neighbor], guards: [...closing.guards] })).code));
  assert.equal(f.store.get(neighbor.id), null); assert.deepEqual(mechanismSnapshot(f.store), beforeRace);
  assert.deepEqual(f.store.list(ORIGIN_HOLD_KIND), []); assert.equal(winner.verdict, "none");
});

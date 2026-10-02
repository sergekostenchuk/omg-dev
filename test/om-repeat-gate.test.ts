import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { seedCopy } from "./om-seed.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { inputDecisionWrite, writeAddressing, writeApplyAnswer } from "../src/om/addressing.js";
import { writeGaps, type GapReadRequest, type GapRequest } from "../src/om/gaps.js";
import { gapLineKey, gapLineExpectedResult, writeGapLines, prepareGapLines } from "../src/om/gap-lines.js";
import { writeRoutes, type RoutesRecord } from "../src/om/routes.js";
import { prepareQuestionTasks, writeQuestionPacket } from "../src/om/question-packet.js";
import { runModelCall } from "../src/om/model-call.js";
import { assessAnswer } from "../src/discovery/research-assessment.js";
import type { Question } from "../src/discovery/discovery.js";
import { mc1FieldSpec, readAcceptedAnswer, writeAcceptedAnswer, writeMc1Question,
  acceptedAnswerRepresents, confirmAnswerGapClosure, type Mc1QuestionRecord } from "../src/om/accepted-answer.js";
import { CALL_LEDGER_KIND, callLedgerId, readCallLedger, recordCall } from "../src/om/call-record.js";
import { assessFact, assessmentAttemptReason, assessmentRefusalId,
  finishAssessmentAttempt, readAssessmentIntentAt, readAssessmentRefusalAt, readAssessmentTerminalAt, writeAssessmentIntent,
  readAssessmentSet, readCurrentAssessmentAttemptClosure, ASSESSMENT_RESULT_KIND,
  type AssessmentIntentRequest, type AssessmentResultRecord } from "../src/om/assessment.js";
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
  type OriginTally, type RepeatOutcome, type RoutedRefusal,
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
  const ledger = { id: "mc2-ledger:alpha", kind: "om-ledger", expected: 0, value: { closed: 1 } };
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

test("a cycle closed around the gate is held all the same, and closing it through the gate raises the hold", t => {
  const { store } = fixture(t);
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

  // Every tally on the table itself (Т3): at most one row suffices, and the class is the independent rule's.
  const classes = new Map<string, RefusalClass>();
  for (let p = 0; p <= 2; p += 1) for (let hp = 0; hp <= p; hp += 1)
  for (let b = 0; b <= 2; b += 1) for (let hb = 0; hb <= b; hb += 1)
  for (let d = 0; d <= 2; d += 1) for (let hd = 0; hd <= d; hd += 1) {
    const key = `${p} ${hp} ${b} ${hb} ${d} ${hd}`;
    const tally: OriginTally = { named: { proposal: p, base: b, derived: d }, holding: { proposal: hp, base: hb, derived: hd } };
    const rows = SUBJECT_DECISIONS.filter(row => row.sufficient(tally));
    assert.ok(rows.length <= 1, `${key}: two rows of the table admit one tally`);
    classes.set(key, rows[0]?.class ?? "unknown");
    assert.equal(classes.get(key), expected(p, hp, b, hb, d, hd), key);
  }
  assert.equal(classes.size, 216);
  for (const [key, want] of Object.entries(pinned)) assert.equal(classes.get(key), want, key);
  assert.deepEqual([...new Set(classes.values())].sort(), ["derivation", "input", "proposal", "unknown"]);
  assert.deepEqual(SUBJECT_DECISIONS.map(row => row.class), ["derivation", "input", "proposal"]);

  // The gate counts the real sources itself: the pinned rows, and a proposal and a derived role each held twice, end to end.
  // A closed, legitimately built snapshot preserves exact source histories for every row; each row gets its own journal.
  template.close();
  for (const key of [...Object.keys(pinned), "2 2 0 0 0 0", "0 0 0 0 2 2"]) {
    const [p, hp, b, hb, d, hd] = key.split(" ").map(Number) as [number, number, number, number, number, number];
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
      assert.equal(routed.class, classes.get(key), key);
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
  for (const [field, code] of [["accepting", "achievement_unconfirmed"], ["cancelling", "cancellation_unconfirmed"]] as const) {
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

const e51Adapter = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const e51Usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
type E51Verdict = "supported" | "insufficient" | "conflicting" | "off-form" | "interrupted";
function e51AssessorStep(verdict: E51Verdict) {
  if (verdict === "off-form") return { research: { answer: "untyped reviewer reply" }, usage: e51Usage };
  if (verdict === "interrupted") return { rawStdout: "{broken", exitCode: 7, stderr: "intentional assessor failure" };
  return { research: { verdict, reasons: verdict === "supported" ? [] : ["source does not settle this fact"] },
    usage: e51Usage };
}

/** The directory-independent prefix of e51Fixture — stages, B1, M5 addresses, G2, D1, routes and the open attempt — per fact count. */
function e51Prefix(store: Store, factCount: number) {
  const facts = ["encoding", "transport", "retention"].slice(0, factCount);
  const project = "garden", engine = new ProductEngine(store), desired = gardenGraph("cross");
  desired.nodes.find(node => node.id === "garden-produce-block")!.ports.push({ id: "out-side", direction: "out", contract: "garden-contract" });
  desired.nodes.find(node => node.id === "garden-consume-block")!.ports.push({ id: "in-side", direction: "in", contract: "garden-contract" });
  desired.connectors.push({ id: "garden-side-flow", artifact: "garden-data", returnsTo: "garden-produce-block", wakeTest: null,
    bindings: [{ level: 1, producer: { node: "garden-produce-block", port: "out-side" },
      consumers: [{ node: "garden-consume-block", port: "in-side" }], anchor: null }] });
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = facts.map(id => ({ id,
      question: `What ${id} is supported?`, consumer: "garden-consume-block", moment: "om-pass",
      blocksCurrentStage: false, resolution: "Resolve the addressed question during OM" }));
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = deliveredOf(writeOmInput(store, { project, expected: 0, stages }));
  const graph = store.get<Graph>(`graph:${project}`)!;
  const input = deliveredOf(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: facts.map(id => `discovery:${id}`).map(target => ({ pending:
      structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
        decision: { target, field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write })) }));
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: "e51-fact", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = deliveredOf(writeGaps(store, sources));
  const gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = deliveredOf(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing"
      && !row.value.gap.deferral).map(gap => ({ gap: reference(gap), requirements: [{ pointer: "/contracts/0" }],
        resultForm: { type: "string" } })) }));
  const routes = deliveredOf(writeRoutes(store, { project, gaps: gapRequest,
    tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ["e51-source.txt"], records: [] }, previous: null }));
  const batch = routes.value.batches.find(item => item.model === "MC1" && item.items.some(question => question.target === "discovery:encoding"))!;
  assert.ok(batch);
  const block = "garden-consume-block", source = store.get<{ content: string }>(`source:${project}:brief`)!;
  const attemptGoal: AttemptGoal = { key: "e51:fact", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  deliveredOf(openSeries(store, { project, block, line: 1, slice: "e51-fact", predecessor: null, basis: null }));
  const series = deliveredOf(beginAttempt(store, { project, block, line: 1, attempt: 1, goal: attemptGoal }));
  return { frame: sources.operations.frame, routes, batch, source, attemptGoal, series };
}

/** An issued one-to-three-question MC1 response, with the real E1 transport and D1 attempt behind E5. */
function e51Fixture(t: test.TestContext, twoFacts: boolean | number = true) {
  const factCount = typeof twoFacts === "boolean" ? twoFacts ? 2 : 1 : twoFacts;
  assert.ok(Number.isInteger(factCount) && factCount >= 1 && factCount <= 3);
  const seeded = seedCopy(`e51:${factCount}`, store => e51Prefix(store, factCount), "omg-e51-g7-");
  const { root, database: path } = seeded, { frame, routes, batch, source, attemptGoal, series } = seeded.data;
  const project = "garden", block = "garden-consume-block";
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [e51Adapter, "--scenario", scenario, "--trace", trace] };
  const config = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "e51-researcher", model: "fixture", effort: "high", command },
    reviewer: { actor: "e51-assessor", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: 100_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:e51`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio" } });
  const packet = deliveredOf(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
    environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  writeFileSync(join(root, "e51-source.txt"), "UTF-8 is the supported encoding.");
  const originalStep = { research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ questionId: item.gap, value: "UTF-8", citations: [{ source: reference(source),
      selector: { kind: "text-range", start: 0, end: source.value.content.length } }] })) }, usage: e51Usage };
  let secondOriginalStep = originalStep;
  const dispatch = { adapter: reference(adapter), config: reference(config) };
  writeFileSync(scenario, JSON.stringify({ steps: [originalStep] }));
  return { root, path, project, block, series, attemptGoal, frame,
    engine, config, scenario, originalStep,
    questionIds: batch.items.map(item => item.gap),
    get store() { return store; },
    async original(): Promise<AssessmentIntentRequest> {
      const model = deliveredOf(await runModelCall(store, { project, packet: reference(packet), dispatch, role: "implementer" }));
      assert.equal(model.outcome?.kind, "fact-candidates");
      return { project, modelCall: reference(model.record), questionId: batch.items[0]!.gap, dispatch };
    },
    async secondOriginal(value = "UTF-8"): Promise<AssessmentIntentRequest> {
      const prior = routes.value.request;
      const successor = deliveredOf(writeRoutes(store, { project, gaps: structuredClone(prior.gaps) as GapReadRequest,
        tasks: prior.tasks.map(record => ({ record })),
        catalog: { paths: [...prior.catalog.paths], records: [...prior.catalog.records] },
        previous: reference(routes) }));
      const nextBatch = successor.value.batches.find(item => item.model === "MC1" && item.items.some(row => row.gap === batch.items[0]!.gap));
      assert.ok(nextBatch);
      const nextPacket = deliveredOf(writeQuestionPacket(store, { project, routes: reference(successor),
        batch: nextBatch.id, environment: reference(config), attempt: { series: reference(series), ordinal: 1 },
        previous: [] })).record;
      secondOriginalStep = { ...originalStep, research: { ...originalStep.research,
        results: originalStep.research.results.map(item => ({ ...item, value })) } };
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, secondOriginalStep] }));
      const model = deliveredOf(await runModelCall(store, { project, packet: reference(nextPacket), dispatch, role: "implementer" }));
      assert.equal(model.outcome?.kind, "fact-candidates");
      return { project, modelCall: reference(model.record), questionId: nextBatch.items[0]!.gap, dispatch };
    },
    assessor(...verdicts: E51Verdict[]) {
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, ...verdicts.map(e51AssessorStep)] }));
    },
    assessorsForTwoOriginals(...verdicts: E51Verdict[]) {
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, secondOriginalStep,
        ...verdicts.map(e51AssessorStep)] }));
    },
    sent() { return readFileSync(trace, "utf8").trim().split("\n").filter(Boolean); },
    restart() { store.close(); store = new Store(path); },
  };
}

function e51Outcome(f: ReturnType<typeof e51Fixture>) {
  return f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome;
}

function e51Claim(store: Store, project: string, sourceRef: Ref): ClaimedRefusal {
  const journal = store.get<RefusalJournal>(journalId(project))!;
  const row = journal.value.rows.find(item => canonical(item.source) === canonical(sourceRef));
  assert.ok(row, `no journal row for ${sourceRef.id}`);
  return { name: row.code, goal: row.goal, row: row.id };
}

function e51AdmitAssessorE1(store: Store, request: AssessmentIntentRequest) {
  const intent = deliveredOf(writeAssessmentIntent(store, request));
  const admission = deliveredOf(readAssessmentIntentAt(store, request.project, reference(intent)));
  const call = recordCall(store, request.project, { call: admission.call, purpose: "fact-assessment",
    basis: admission.basis, block: admission.block, gaps: admission.gaps, series: admission.series,
    attempt: admission.attempt, goal: admission.goal, dispatch: admission.dispatch,
    packet: admission.packet as Json });
  return { intent, admission, call };
}

test("E5.1 closes a real insufficient or conflicting fact as one proved G7 refusal", async t => {
  for (const verdict of ["insufficient", "conflicting"] as const) await t.test(verdict, async child => {
    const f = e51Fixture(child, false), request = await f.original();
    f.assessor(verdict);
    const result = deliveredOf(await assessFact(f.store, request));
    assert.equal(result.value.verdict, verdict);
    assert.equal(result.value.accepted, null);
    assert.equal(result.value.index, null, "No D5 index for a negative fact");
    const sourceId = assessmentRefusalId(f.project, reference(result));
    const source = f.store.get(sourceId)!;
    const proved = deliveredOf(readAssessmentRefusalAt(f.store, f.project, reference(source)));
    assert.equal(proved.result.id, result.id);
    assert.equal(proved.intent.fact.questionId, f.questionIds[0]);
    assert.equal(proved.consumer, f.block);
    const claim = e51Claim(f.store, f.project, reference(source));
    assert.equal(claim.name, `fact_assessment_${verdict}`);
    assert.equal(claim.goal, f.attemptGoal.result);
    const classification = f.store.get<RefusalJournal>(journalId(f.project))!.value.classifications
      .find(item => item.row === claim.row);
    assert.equal(classification?.class, "proposal");
    assert.equal(classification?.addressee, `node:${proved.target}`);
    const row = f.store.get<RefusalJournal>(journalId(f.project))!.value.rows.find(item => item.id === claim.row);
    assert.deepEqual([row?.gate, row?.code], ["E5", `fact_assessment_${verdict}`]);
    const attempt = e51Outcome(f);
    assert.ok(attempt);
    assert.equal(attempt.reason, "refused");
    assert.deepEqual(attempt.achieved, []);
    assert.deepEqual(attempt.refusals, [{ row: claim.row }]);
    const line = f.store.get<RepairSeries>(f.series.id)!;
    assert.equal(line.value.withoutProgress, 1);
    const before = f.store.list().map(reference), calls = f.sent().length;
    f.restart();
    assert.deepEqual(deliveredOf(readAssessmentTerminalAt(f.store, f.project, reference(result))), result);
    assert.deepEqual(deliveredOf(await assessFact(f.store, request)), result);
    assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, result.value.intent)),
      { complete: true, closed: true, results: [reference(result)] });
    assert.deepEqual(f.store.list().map(reference), before);
    assert.equal(f.sent().length, calls);
  });
});

test("E5.1 closes a mixed set with exactly the supported fact and negative refusal", async t => {
  const f = e51Fixture(t), request = await f.original();
  assert.equal(f.questionIds.length, 2);
  f.assessor("supported", "insufficient");
  const positive = deliveredOf(await assessFact(f.store, request));
  assert.ok(positive.value.accepted);
  assert.equal(deliveredOf(readAssessmentSet(f.store, f.project, positive.value.intent)).complete, false);
  assert.equal(e51Outcome(f), null);
  const negative = deliveredOf(await assessFact(f.store, { ...request, questionId: f.questionIds[1]! }));
  const set = deliveredOf(readAssessmentSet(f.store, f.project, positive.value.intent));
  assert.equal(set.complete, true);
  assert.equal(set.allSupported, false);
  assert.deepEqual(set.accepted, [positive.value.accepted]);
  const source = f.store.get(assessmentRefusalId(f.project, reference(negative)))!;
  const claim = e51Claim(f.store, f.project, reference(source));
  const attempt = e51Outcome(f);
  assert.ok(attempt);
  assert.equal(attempt.reason, "result");
  assert.deepEqual(attempt.refusals, [{ row: claim.row }]);
  assert.equal(attempt.achieved.length, 1);
  assert.equal(attempt.achieved[0]!.basis.id, positive.value.accepted!.id);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 0);
  const before = f.store.list().map(reference), calls = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(await assessFact(f.store, request)), positive);
  assert.deepEqual(deliveredOf(await assessFact(f.store, { ...request, questionId: f.questionIds[1]! })), negative);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, calls);
});

test("E5.1 preserves the positive path and counts a negative first cycle toward the third no-progress stop", async t => {
  const positive = e51Fixture(t, false), request = await positive.original();
  positive.assessor("supported");
  const accepted = deliveredOf(await assessFact(positive.store, request));
  assert.ok(accepted.value.accepted);
  assert.equal(e51Outcome(positive)?.reason, "result");
  assert.equal(e51Outcome(positive)?.achieved.length, 1);
  assert.equal(positive.store.list(UNIT_REFUSAL_KIND).length, 0);
  const calls = positive.sent().length;
  assert.deepEqual(deliveredOf(await assessFact(positive.store, request)), accepted);
  assert.equal(positive.sent().length, calls);

  const negative = e51Fixture(t, false), original = await negative.original();
  negative.assessor("insufficient");
  deliveredOf(await assessFact(negative.store, original));
  deliveredOf(openAttempt(negative.store, { project: negative.project, block: negative.block, line: 1,
    attempt: 2, goal: negative.attemptGoal }));
  const second = deliveredOf(closeAttempt(negative.store, { project: negative.project, block: negative.block, line: 1,
    attempt: 2, outcome: outcome() }));
  assert.equal(second.withoutProgress, 2);
  deliveredOf(openAttempt(negative.store, { project: negative.project, block: negative.block, line: 1,
    attempt: 3, goal: negative.attemptGoal }));
  const third = deliveredOf(closeAttempt(negative.store, { project: negative.project, block: negative.block, line: 1,
    attempt: 3, outcome: outcome() }));
  assert.equal(third.withoutProgress, 3);
  assert.ok(third.stop);
  assert.equal(third.stop!.attempt, 3);
});

/** Persist both E5 terminals and their A2 rows, then interrupt only the final G7 series write. */
async function e51BeforeGate(f: ReturnType<typeof e51Fixture>) {
  const request = await f.original();
  f.assessor("supported", "insufficient");
  const positive = deliveredOf(await assessFact(f.store, request));
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop at final E5 to G7 write");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try {
    await assert.rejects(() => assessFact(f.store, { ...request, questionId: f.questionIds[1]! }),
      /stop at final E5 to G7 write/);
  } finally { f.store.writeMany = originalWrite; }
  const negatives = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)
    .filter(row => row.value.verdict === "insufficient");
  assert.equal(negatives.length, 1);
  const negative = negatives[0]!;
  const source = f.store.get(assessmentRefusalId(f.project, reference(negative)))!;
  assert.ok(source);
  assert.equal(e51Outcome(f), null);
  return { request, positive, negative, source, refusal: e51Claim(f.store, f.project, reference(source)) };
}

test("E5.1 rejects a partial two-refusal claim and closes the full negative set once", async t => {
  const f = e51Fixture(t), request = await f.original();
  f.assessor("insufficient", "conflicting");
  deliveredOf(await assessFact(f.store, request));
  assert.equal(e51Outcome(f), null);
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before the two-refusal G7 write");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try {
    await assert.rejects(() => assessFact(f.store, { ...request, questionId: f.questionIds[1]! }),
      /stop before the two-refusal G7 write/);
  } finally { f.store.writeMany = originalWrite; }
  const results = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND);
  assert.equal(results.length, 2);
  const refusals = results.map(result => {
    const source = f.store.get(assessmentRefusalId(f.project, reference(result)))!;
    assert.ok(source);
    return e51Claim(f.store, f.project, reference(source));
  });
  const before = f.store.get<RepairSeries>(f.series.id)!;
  const partial = closeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: refusedBy(refusals[0]!) });
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.refusal.code, "origin_unreadable");
  const duplicated = closeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: refusedBy(refusals[0]!, refusals[1]!, refusals[0]!) });
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.equal(duplicated.refusal.code, "origin_unreadable");
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  const calls = f.sent().length;
  const full = deliveredOf(closeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: refusedBy(...refusals) }));
  assert.equal(full.withoutProgress, 1);
  assert.equal(full.routed.length, 2);
  assert.deepEqual(e51Outcome(f)?.refusals.map(item => item.row).sort(), refusals.map(item => item.row).sort());
  const closed = f.store.get<RepairSeries>(f.series.id)!;
  const repeated = deliveredOf(finishAssessmentAttempt(f.store, f.project, results[0]!.value.intent));
  assert.equal(repeated.complete, true);
  assert.equal(repeated.closed, true);
  assert.deepEqual(repeated.results.map(item => item.id).sort(), results.map(item => item.id).sort());
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), closed);
  assert.equal(f.sent().length, calls);
});

test("E5.1 refuses a second Store changing an assessed result in the final G7 write window", async t => {
  const f = e51Fixture(t), before = await e51BeforeGate(f);
  const originalWrite = f.store.writeMany.bind(f.store);
  const open = f.store.get<RepairSeries>(f.series.id)!;
  const calls = f.sent().length;
  let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0)) {
      raced = true;
      const second = new Store(f.path);
      try {
        const current = second.get<AssessmentResultRecord>(before.negative.id)!;
        second.write({ id: current.id, kind: current.kind, expected: current.revision, value: current.value });
      } finally { second.close(); }
    }
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try {
    const result = finishAssessmentAttempt(f.store, f.project, before.positive.value.intent);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "input_stale");
  } finally { f.store.writeMany = originalWrite; }
  assert.equal(raced, true);
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), open);
  assert.equal(f.sent().length, calls);
});

async function e51SingleBeforeGate(f: ReturnType<typeof e51Fixture>) {
  assert.equal(f.questionIds.length, 1);
  const request = await f.original();
  f.assessor("insufficient");
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before G7 closure");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => assessFact(f.store, request), /stop before G7 closure/); }
  finally { f.store.writeMany = originalWrite; }
  const terminal = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND);
  assert.equal(terminal.length, 1);
  const result = terminal[0]!;
  const source = f.store.get(assessmentRefusalId(f.project, reference(result)))!;
  assert.ok(source);
  assert.equal(e51Outcome(f), null);
  return { request, result, source, refusal: e51Claim(f.store, f.project, reference(source)) };
}

test("E5.1 binds a refusal to its exact consumer and attempt ordinal", async t => {
  for (const changed of ["consumer", "ordinal"] as const) await t.test(changed, async child => {
    const f = e51Fixture(child, false), saved = await e51SingleBeforeGate(f);
    const otherBlock = "garden-foreign-block";
    if (changed === "consumer") {
      deliveredOf(openSeries(f.store, { project: f.project, block: otherBlock, line: 1,
        slice: "foreign-consumer", predecessor: null, basis: null }));
      deliveredOf(openAttempt(f.store, { project: f.project, block: otherBlock, line: 1,
        attempt: 1, goal: f.attemptGoal }));
    } else {
      const real = deliveredOf(finishAssessmentAttempt(f.store, f.project, saved.result.value.intent));
      assert.equal(real.closed, true);
      deliveredOf(openAttempt(f.store, { project: f.project, block: f.block, line: 1,
        attempt: 2, goal: f.attemptGoal }));
    }
    const block = changed === "consumer" ? otherBlock : f.block;
    const attempt = changed === "ordinal" ? 2 : 1;
    const line = f.store.get<RepairSeries>(seriesId(f.project, block, 1))!;
    const rejection = closeAttempt(f.store, { project: f.project, block, line: 1, attempt,
      outcome: refusedBy(saved.refusal) });
    assert.equal(rejection.ok, false, changed);
    if (!rejection.ok) assert.equal(rejection.refusal.code, "origin_unreadable", changed);
    assert.deepEqual(f.store.get<RepairSeries>(line.id), line);
  });
});

test("E5.1 a stop between the negative terminal and its A2 source is completed by the next run without another call", async t => {
  const f = e51Fixture(t, false), request = await f.original();
  f.assessor("insufficient");
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === UNIT_REFUSAL_KIND)) throw new Error("stop before E5 refusal source");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => assessFact(f.store, request), /stop before E5 refusal source/); }
  finally { f.store.writeMany = originalWrite; }
  const result = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)[0]!;
  assert.equal(f.store.get(assessmentRefusalId(f.project, reference(result))), null);
  assert.equal(e51Outcome(f), null);
  const calls = f.sent().length;
  f.restart();
  assert.deepEqual(reference(deliveredOf(await assessFact(f.store, request))), reference(result));
  const source = f.store.get(assessmentRefusalId(f.project, reference(result)));
  assert.ok(source);
  const claim = e51Claim(f.store, f.project, reference(source));
  assert.deepEqual([e51Outcome(f)?.reason, e51Outcome(f)?.refusals], ["refused", [{ row: claim.row }]]);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 1);
  assert.equal(f.sent().length, calls);
});

/** A normal G3 row from an observed proposal and its actual upper frame, independent of E5. */
function e51OrdinaryG3(f: ReturnType<typeof e51Fixture>): ClaimedRefusal {
  const proposal: LayerProposal = { base: { graph: f.frame.graph, frame: null }, level: 2,
    source: "decision", status: "proposed", nodes: [], fills: [], localConnectors: [], artifacts: [],
    contracts: [], joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
    removes: [], replaces: [], redefines: [] };
  const record = f.store.write({ id: `om-proposal:${f.project}:e51-g3-${next()}`, kind: "layer-proposal", expected: 0, value: proposal });
  const proposalRef = reference(record);
  const request: ProposalRequest = { frame: f.frame, proposals: [proposalRef] };
  const sources: OriginSource[] = [
    { role: "base", ref: f.frame.graph, context: { kind: "frame", request: f.frame } },
    { role: "proposal", ref: proposalRef, context: { kind: "proposal", request } },
  ];
  return journalled(f.store, f.project, { stage: "layer-check", subject: "artifact:e51-missing", sources },
    { gate: "G3", code: `graph_invalid:e51:${next()}`, goal: f.attemptGoal.result });
}

test("E5.1 requires its full negative or mixed set even when direct G7 is given only a valid G3 refusal", async t => {
  for (const shape of ["negative", "mixed"] as const) await t.test(shape, async child => {
    const f = e51Fixture(child, shape === "mixed");
    const e5 = shape === "mixed" ? await e51BeforeGate(f) : await e51SingleBeforeGate(f);
    const g3 = e51OrdinaryG3(f);
    const before = f.store.get<RepairSeries>(f.series.id)!;
    const request = { project: f.project, block: f.block, line: 1, attempt: 1,
      outcome: refusedBy(g3) };
    const direct = closeAttempt(f.store, request);
    assert.equal(direct.ok, false, shape);
    if (!direct.ok) assert.equal(direct.refusal.code, "origin_unreadable", shape);
    assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
    const supported = "positive" in e5 ? e5.positive.value.accepted! : null;
    const full = deliveredOf(closeAttempt(f.store, { ...request, outcome: supported
      ? outcome({ reason: "result", accepting: [supported], refusals: [e5.refusal, g3] })
      : refusedBy(e5.refusal, g3) }));
    assert.equal(full.routed.length, 2);
    assert.deepEqual(full.routed.map(item => item.row).sort(), [e5.refusal.row, g3.row].sort());
    assert.equal(full.routed.every(item => item.class === "proposal" && item.toModel), true);
    assert.equal(e51Outcome(f)?.reason, supported ? "result" : "refused");
    assert.equal(e51Outcome(f)?.achieved.length, supported ? 1 : 0);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, supported ? 0 : 1);
    const closed = f.store.get<RepairSeries>(f.series.id)!, calls = f.sent().length;
    f.restart();
    assert.deepEqual(deliveredOf(closeAttempt(f.store, { ...request, outcome: supported
      ? outcome({ reason: "result", accepting: [supported], refusals: [e5.refusal, g3] })
      : refusedBy(e5.refusal, g3) })), full);
    assert.deepEqual(f.store.get<RepairSeries>(f.series.id), closed);
    assert.equal(f.sent().length, calls);
  });
});

test("E5.1 refuses an incomplete E1 set and guards the final terminal after successful G7 preparation", async t => {
  const f = e51Fixture(t), request = await f.original();
  f.assessor("supported", "insufficient");
  const positive = deliveredOf(await assessFact(f.store, request));
  const g3 = e51OrdinaryG3(f);
  const early = prepareCloseAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: refusedBy(g3) });
  assert.equal(early.ok, false, "the second E5 candidate has no terminal result yet");
  assert.equal(e51Outcome(f), null);

  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop after the final terminal");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try {
    await assert.rejects(() => assessFact(f.store, { ...request, questionId: f.questionIds[1]! }),
      /stop after the final terminal/);
  } finally { f.store.writeMany = originalWrite; }
  const terminal = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)
    .find(item => item.value.verdict === "insufficient")!;
  assert.ok(terminal);
  const refusalSource = f.store.get(assessmentRefusalId(f.project, reference(terminal)))!;
  const e5 = e51Claim(f.store, f.project, reference(refusalSource));
  const prepared = deliveredOf(prepareCloseAttempt(f.store, { project: f.project, block: f.block, line: 1,
    attempt: 1, outcome: outcome({ reason: "result", accepting: [positive.value.accepted!], refusals: [e5, g3] }) }));
  assert.ok(prepared.writes.some(write => write.kind === "repair-series"));
  const before = f.store.get<RepairSeries>(f.series.id)!, calls = f.sent().length;
  const second = new Store(f.path);
  try {
    const current = second.get<AssessmentResultRecord>(terminal.id)!;
    second.write({ id: current.id, kind: current.kind, expected: current.revision, value: current.value });
  } finally { second.close(); }
  const stale = writeGuarded(f.store, { unit: "G7", target: f.series.id,
    writes: [...prepared.writes], guards: [...prepared.guards] });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.refusal.code, "input_stale");
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  assert.equal(f.sent().length, calls);
});

test("E5.1 joins two distinct original MC1 sets on one attempt before closing it", async t => {
  const f = e51Fixture(t, false), first = await f.original(), second = await f.secondOriginal();
  assert.notEqual(first.modelCall.id, second.modelCall.id);
  const admittedFirst = e51AdmitAssessorE1(f.store, first);
  const admittedSecond = e51AdmitAssessorE1(f.store, second);
  deliveredOf(admittedFirst.call);
  deliveredOf(admittedSecond.call);
  assert.notEqual(admittedFirst.intent.id, admittedSecond.intent.id);
  f.assessorsForTwoOriginals("insufficient", "conflicting");
  const firstResult = deliveredOf(await assessFact(f.store, first));
  assert.equal(firstResult.value.verdict, "insufficient");
  assert.equal(e51Outcome(f), null, "the second issued MC1 set still has no terminal result");
  const secondResult = deliveredOf(await assessFact(f.store, second));
  assert.equal(secondResult.value.verdict, "conflicting");
  const refusalIds = [firstResult, secondResult].map(result => assessmentRefusalId(f.project, reference(result)));
  assert.equal(new Set(refusalIds).size, 2);
  const attempt = e51Outcome(f);
  assert.ok(attempt);
  assert.equal(attempt.reason, "refused");
  assert.equal(attempt.refusals.length, 2);
  assert.deepEqual(attempt.refusals.map(item => item.row).sort(), refusalIds.map(id => {
    const source = f.store.get(id)!;
    return e51Claim(f.store, f.project, reference(source)).row;
  }).sort());
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 1);
  const before = f.store.list().map(reference), calls = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(await assessFact(f.store, first)), firstResult);
  assert.deepEqual(deliveredOf(await assessFact(f.store, second)), secondResult);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, calls);
});

test("E5.1 guards a prepared G7 close against a new assessor E1 in a second Store", async t => {
  const f = e51Fixture(t, false), first = await f.original(), secondRequest = await f.secondOriginal();
  f.assessorsForTwoOriginals("insufficient");
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before E1 race");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => assessFact(f.store, first), /stop before E1 race/); }
  finally { f.store.writeMany = originalWrite; }
  const terminal = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)[0]!;
  const source = f.store.get(assessmentRefusalId(f.project, reference(terminal)))!;
  const refusal = e51Claim(f.store, f.project, reference(source));
  const prepared = deliveredOf(prepareCloseAttempt(f.store, { project: f.project, block: f.block, line: 1,
    attempt: 1, outcome: refusedBy(refusal) }));
  assert.ok(prepared.writes.some(write => write.kind === "repair-series"));
  const before = f.store.get<RepairSeries>(f.series.id)!, calls = f.sent().length;
  const second = new Store(f.path);
  try { deliveredOf(e51AdmitAssessorE1(second, secondRequest).call); }
  finally { second.close(); }
  const stale = writeGuarded(f.store, { unit: "G7", target: f.series.id,
    writes: [...prepared.writes], guards: [...prepared.guards] });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.refusal.code, "input_stale");
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  assert.equal(f.sent().length, calls);
});

test("E5.1 lets G7 win first and then refuses a late assessor E1 without another paid call", async t => {
  const f = e51Fixture(t, false), first = await f.original(), second = await f.secondOriginal();
  const laterIntent = deliveredOf(writeAssessmentIntent(f.store, second));
  const later = deliveredOf(readAssessmentIntentAt(f.store, f.project, reference(laterIntent)));
  f.assessorsForTwoOriginals("insufficient");
  const result = deliveredOf(await assessFact(f.store, first));
  const source = f.store.get(assessmentRefusalId(f.project, reference(result)))!;
  const refusal = e51Claim(f.store, f.project, reference(source));
  const closed = f.store.get<RepairSeries>(f.series.id)!;
  assert.equal(e51Outcome(f)?.reason, "refused");
  const calls = f.sent().length;
  const late = recordCall(f.store, f.project, { call: later.call, purpose: "fact-assessment",
    basis: later.basis, block: later.block, gaps: later.gaps, series: later.series,
    attempt: later.attempt, goal: later.goal, dispatch: later.dispatch, packet: later.packet as Json });
  assert.equal(late.ok, false);
  assert.equal((await assessFact(f.store, second)).ok, false);
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), closed);
  assert.equal(f.sent().length, calls);
  f.restart();
  const repeated = deliveredOf(closeAttempt(f.store, { project: f.project, block: f.block, line: 1,
    attempt: 1, outcome: refusedBy(refusal) }));
  assert.equal(repeated.withoutProgress, 1);
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), closed);
  assert.equal(f.sent().length, calls);
});

test("E5.1 keeps an earlier G3 attempt with no assessor E1 closeable and exactly repeatable", async t => {
  const f = e51Fixture(t, false);
  await f.original();
  const g3 = e51OrdinaryG3(f);
  const request = { project: f.project, block: f.block, line: 1, attempt: 1, outcome: refusedBy(g3) };
  const first = deliveredOf(closeAttempt(f.store, request));
  assert.equal(first.withoutProgress, 1);
  assert.deepEqual(first.routed.map(item => item.row), [g3.row]);
  const before = f.store.list().map(reference), calls = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), first);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, calls);
});

test("E5.1 checks the full E1 ledger even when its head is missing, foreign, or malformed", async t => {
  for (const variant of ["missing", "foreign", "malformed"] as const) await t.test(variant, async child => {
    const f = e51Fixture(child, false);
    await e51SingleBeforeGate(f);
    const g3 = e51OrdinaryG3(f);
    const request = { project: f.project, block: f.block, line: 1, attempt: 1, outcome: refusedBy(g3) };
    const ledgerId = callLedgerId(f.project);
    const before = f.store.get<RepairSeries>(f.series.id)!;
    const sent = f.sent().length;
    let view: Store;
    if (variant === "malformed") {
      const current = f.store.get(ledgerId)!;
      f.store.write({ id: ledgerId, kind: CALL_LEDGER_KIND, expected: current.revision,
        value: { projectId: f.project, calls: [] } });
      f.restart();
      view = f.store;
    } else {
      class AlteredLedgerView extends Store {
        override get<T = Json>(id: string, revision?: number): Revision<T> | null {
          const saved = super.get<T>(id, revision);
          if (id !== ledgerId || revision !== undefined || saved === null) return saved;
          return variant === "missing" ? null : { ...saved, kind: "foreign-ledger" };
        }
      }
      view = new AlteredLedgerView(f.path);
      child.after(() => view.close());
    }
    const checked = readCallLedger(view, f.project);
    assert.equal(refusalOf(checked).code, "ledger_invalid", variant);
    for (const close of [prepareCloseAttempt, closeAttempt]) {
      const attempted = close(view, request);
      assert.equal(attempted.ok, false, variant);
      if (attempted.ok) assert.fail(`expected ${variant} ledger to refuse G7`);
      const rejected = attempted.refusal;
      assert.equal(rejected.code, "origin_unreadable", variant);
      assert.equal(rejected.at.field, "ledger", variant);
      assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before, variant);
      assert.equal(f.sent().length, sent, variant);
    }
  });
});

test("E5.1 proves an absent E1 ledger for a new G3 closure and does not revisit it on exact repeat", t => {
  const { store, path } = fixture(t);
  opened(store);
  deliveredOf(openAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const g3 = journalled(store, PROJECT, { sources: [] });
  const request = { ...address(PROJECT), attempt: 1, outcome: refusedBy(g3) };
  assert.equal(deliveredOf(readCallLedger(store, PROJECT)), null);
  const prepared = deliveredOf(prepareCloseAttempt(store, request));
  assert.ok(prepared.guards.some(guard => "absent" in guard && guard.id === callLedgerId(PROJECT)));
  const first = deliveredOf(closeAttempt(store, request));
  const closed = store.get<RepairSeries>(at(PROJECT))!;
  store.write({ id: callLedgerId(PROJECT), kind: "foreign-ledger", expected: 0, value: {} });
  assert.equal(refusalOf(readCallLedger(store, PROJECT)).code, "ledger_invalid");
  const reopened = new Store(path);
  t.after(() => reopened.close());
  assert.deepEqual(deliveredOf(closeAttempt(reopened, request)), first);
  assert.deepEqual(reopened.get<RepairSeries>(at(PROJECT)), closed);
});

test("E5.1 the one S/N/T reason table over every one-to-three-fact multiset, with G7's own results and independent refusals", () => {
  // Т3: the table is walked on the exported rule G7 and the finalizer share; each producer, write window and restart
  // keeps its end-to-end row (N, S, SN, NN, TT, SNT, T+G3, T+D5, I, SI, NI, TI).
  type Kind = "S" | "N" | "To" | "Ti";
  const kinds: Kind[] = ["S", "N", "To", "Ti"], rows: Kind[][] = [];
  const add = (prefix: Kind[], start: number, count: number) => {
    if (prefix.length === count) { rows.push(prefix); return; }
    for (let index = start; index < kinds.length; index++) add([...prefix, kinds[index]!], index, count);
  };
  for (const count of [1, 2, 3]) add([], 0, count);
  assert.equal(rows.length, 34);
  const ref = (index: number): Ref => ({ id: `om-assessment-result:e51:${index}`, revision: 1, hash: hex(index.toString(16)) });
  for (const row of rows) for (const otherResult of [false, true]) for (const independentRefusal of [false, true]) {
    let index = 0;
    const accepting = row.filter(kind => kind === "S").map(() => ref(index++));
    const negatives = row.filter(kind => kind === "N").map(() => ref(index++));
    const technical = row.filter(kind => kind === "To" || kind === "Ti")
      .map(kind => ({ result: ref(index++), verdict: kind === "Ti" ? "interrupted" as const : "off-form" as const }));
    const reason: GateOutcome["reason"] = accepting.length || otherResult ? "result" : negatives.length || independentRefusal ? "refused"
      : technical.some(item => item.verdict === "interrupted") ? "interrupted" : "off-form";
    for (const order of [technical, [...technical].reverse()])
      assert.equal(assessmentAttemptReason(accepting, negatives, order, otherResult, independentRefusal), reason,
        `${row.join("+")} otherResult=${otherResult} independentRefusal=${independentRefusal}`);
  }
});

test("E5.1 an incomplete set with a negative or a technical fact cannot be closed around its missing terminal (NI, TI)", async t => {
  for (const verdict of ["insufficient", "interrupted"] as const) await t.test(verdict === "insufficient" ? "NI" : "TI", async child => {
    const f = e51Fixture(child, 2), original = await f.original();
    f.assessor(verdict);
    deliveredOf(await assessFact(f.store, original));
    const results = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND);
    assert.deepEqual(results.map(row => row.value.verdict), [verdict]);
    assert.equal(e51Outcome(f), null, "the attempt stays open while a fact has no terminal");
    const incomplete = closeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1, outcome: outcome() });
    assert.equal(incomplete.ok, false, "a missing terminal cannot be hidden by another reason");
    if (!incomplete.ok) assert.equal(incomplete.refusal.code, "origin_unreadable");
    assert.equal(e51Outcome(f), null);
  });
});

test("E5.1 selects interrupted when technical facts include both interrupted and off-form", async t => {
  const f = e51Fixture(t, 2), original = await f.original();
  f.assessor("off-form", "interrupted");
  deliveredOf(await assessFact(f.store, original));
  deliveredOf(await assessFact(f.store, { ...original, questionId: f.questionIds[1]! }));
  const at = { project: f.project, block: f.block, line: 1, attempt: 1 };
  const before = f.store.list().map(reference), calls = f.sent().length;
  const wrong = closeAttempt(f.store, { ...at, outcome: outcome({ reason: "off-form" }) });
  assert.equal(wrong.ok, false, "a caller cannot hide an interrupted terminal behind off-form");
  if (!wrong.ok) assert.equal(wrong.refusal.code, "origin_unreadable");
  assert.deepEqual(f.store.list().map(reference), before);
  const request = { ...at, outcome: outcome({ reason: "interrupted" }) };
  const closed = deliveredOf(closeAttempt(f.store, request));
  assert.equal(e51Outcome(f)?.reason, "interrupted");
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), closed);
  assert.equal(f.sent().length, calls);
});

test("E5.1 gives the same mixed result across fact order and two original MC1 sets", async t => {
  for (const order of [[2, 1, 0]] as const) await t.test(`fact order ${order.join("")}`, async child => {
    const f = e51Fixture(child, 3), original = await f.original();
    f.assessor("supported", "conflicting", "interrupted");
    const results = [];
    for (const index of order) results.push(deliveredOf(await assessFact(f.store,
      { ...original, questionId: f.questionIds[index]! })));
    assert.deepEqual(results.map(row => row.value.verdict), ["supported", "conflicting", "interrupted"]);
    const finished = deliveredOf(finishAssessmentAttempt(f.store, f.project, results[0]!.value.intent));
    assert.equal(finished.closed, true);
    const saved = e51Outcome(f);
    assert.ok(saved);
    assert.equal(saved.reason, "result");
    assert.equal(saved.achieved.length, 1);
    assert.equal(saved.refusals.length, 1);
    assert.equal(f.store.list(UNIT_REFUSAL_KIND).length, 1);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 0);
  });
  for (const reverse of [true]) await t.test(`MC1 discovery ${reverse ? "reverse" : "forward"}`, async child => {
    const f = e51Fixture(child, false), first = await f.original(), second = await f.secondOriginal();
    deliveredOf(e51AdmitAssessorE1(f.store, first).call);
    deliveredOf(e51AdmitAssessorE1(f.store, second).call);
    f.assessorsForTwoOriginals(...(reverse ? ["off-form", "supported"] as const
      : ["supported", "off-form"] as const));
    const requests = reverse ? [second, first] : [first, second];
    const results = [];
    for (const request of requests) results.push(deliveredOf(await assessFact(f.store, request)));
    assert.deepEqual(results.map(row => row.value.verdict), reverse
      ? ["off-form", "supported"] : ["supported", "off-form"]);
    const finished = deliveredOf(finishAssessmentAttempt(f.store, f.project, results[0]!.value.intent));
    assert.equal(finished.closed, true);
    const saved = e51Outcome(f);
    assert.ok(saved);
    assert.equal(saved.reason, "result");
    assert.equal(saved.achieved.length, 1);
    assert.deepEqual(saved.refusals, []);
    const accepted = results.find(row => row.value.verdict === "supported")!.value.accepted!;
    const request = { project: f.project, block: f.block, line: 1, attempt: 1,
      outcome: outcome({ accepting: [accepted] }) };
    const closed = deliveredOf(closeAttempt(f.store, request));
    const before = f.store.list().map(reference), calls = f.sent().length;
    f.restart();
    assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), closed);
    assert.deepEqual(f.store.list().map(reference), before);
    assert.equal(f.sent().length, calls);
  });
});

test("E5.1 rejects a hidden S, a missing N and a wrong reason in S+N+T", async t => {
  const f = e51Fixture(t, 3), original = await f.original();
  f.assessor("supported", "insufficient", "off-form");
  const positive = deliveredOf(await assessFact(f.store, original));
  deliveredOf(await assessFact(f.store, { ...original, questionId: f.questionIds[1]! }));
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before mixed technical G7 closure");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try {
    await assert.rejects(() => assessFact(f.store, { ...original, questionId: f.questionIds[2]! }),
      /stop before mixed technical G7 closure/);
  } finally { f.store.writeMany = originalWrite; }
  const results = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND);
  const negative = results.find(row => row.value.verdict === "insufficient")!;
  const source = f.store.get(assessmentRefusalId(f.project, reference(negative)))!;
  assert.ok(source);
  const real = e51Claim(f.store, f.project, reference(source));
  const accepted = positive.value.accepted!;
  const at = { project: f.project, block: f.block, line: 1, attempt: 1 };
  const proposals: GateOutcome[] = [
    refusedBy(real),
    outcome({ reason: "result", refusals: [real] }),
    outcome({ accepting: [accepted] }),
    outcome({ reason: "off-form", accepting: [accepted], refusals: [real] }),
  ];
  const before = f.store.get<RepairSeries>(f.series.id)!;
  for (const proposed of proposals) {
    const rejected = closeAttempt(f.store, { ...at, outcome: proposed });
    assert.equal(rejected.ok, false);
    assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  }
  const correct = deliveredOf(closeAttempt(f.store, { ...at,
    outcome: outcome({ accepting: [accepted], refusals: [real] }) }));
  assert.equal(correct.withoutProgress, 0);
  assert.equal(e51Outcome(f)?.reason, "result");
});

test("E5.1 lets an independent G3 refusal close a technical E5 set as refused", async t => {
  const f = e51Fixture(t, false), original = await f.original();
  f.assessor("interrupted");
  const terminal = deliveredOf(await assessFact(f.store, original));
  assert.equal(terminal.value.verdict, "interrupted");
  const g3 = e51OrdinaryG3(f);
  const request = { project: f.project, block: f.block, line: 1, attempt: 1, outcome: refusedBy(g3) };
  const closed = deliveredOf(closeAttempt(f.store, request));
  assert.equal(e51Outcome(f)?.reason, "refused");
  assert.equal(e51Outcome(f)?.refusals.length, 1);
  assert.equal(f.store.list(UNIT_REFUSAL_KIND).length, 1);
  const before = f.store.list().map(reference), calls = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), closed);
  assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent)),
    { complete: true, closed: true, results: [reference(terminal)] });
  assert.deepEqual(deliveredOf(await assessFact(f.store, original)), terminal);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, calls);
});

test("E5.1 lets a proved native D5 achievement close a technical E5 set as result", async t => {
  const f = e51Fixture(t, false), original = await f.original();
  const intent = deliveredOf(writeAssessmentIntent(f.store, original));
  const admission = deliveredOf(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const mc1Ref = admission.question.record;
  const mc1 = f.store.get<Mc1QuestionRecord>(mc1Ref.id, mc1Ref.revision)!;
  const source = f.store.get<{ content: string }>(`source:${f.project}:brief`)!;
  const nativeDraft = f.engine.discovery.create(f.project, "om-g2", "R1", f.block,
    [mc1FieldSpec({ input: mc1.value.request.input, gap: mc1.value.request.gap,
      contract: mc1.value.request.contract })],
    [mc1.value.request.input, mc1.value.request.gap,
      ...(mc1.value.request.task ? [mc1.value.request.task] : []), reference(source)]);
  const issued = f.store.get<Question>(nativeDraft.value.questions[0]!)!;
  assert.ok(issued);
  const nativeQuestion = deliveredOf(writeMc1Question(f.store, { ...mc1.value.request,
    engineQuestion: reference(issued), draft: reference(nativeDraft) }));
  writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep,
    e51AssessorStep("supported"), e51AssessorStep("off-form")] }));
  const assessment = await assessAnswer(f.store, issued, { action: "answer", question: issued.id, value: "UTF-8",
    citations: [{ source: reference(source), selector: { kind: "text-range", start: 0,
      end: source.value.content.length } }] }, f.config, f.root);
  const researchedDraft = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment));
  const answered = f.store.get<Question>(issued.id)!;
  assert.ok(answered.value.answer);
  const accepted = deliveredOf(writeAcceptedAnswer(f.store, { project: f.project, question: reference(nativeQuestion),
    answer: answered.value.answer!, answeredQuestion: reference(answered), draft: reference(researchedDraft),
    attempt: { series: reference(f.series), attempt: 1 } }));
  const terminal = deliveredOf(await assessFact(f.store, original));
  assert.equal(terminal.value.verdict, "off-form");
  assert.equal(e51Outcome(f), null);
  const request = { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: outcome({ accepting: [reference(accepted)] }) };
  const closed = deliveredOf(closeAttempt(f.store, request));
  const saved = e51Outcome(f);
  assert.ok(saved);
  assert.equal(saved.reason, "result");
  assert.equal(saved.achieved.length, 1);
  assert.equal(saved.achieved[0]!.basis.id, accepted.id);
  assert.deepEqual(saved.refusals, []);
  const before = f.store.list().map(reference), calls = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), closed);
  assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent)),
    { complete: true, closed: true, results: [reference(terminal)] });
  assert.deepEqual(deliveredOf(await assessFact(f.store, original)), terminal);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, calls);
});

test("E5.1 checks both supported MC1 sources but records one achievement for their shared key", async t => {
  const f = e51Fixture(t, false), first = await f.original(), second = await f.secondOriginal();
  deliveredOf(e51AdmitAssessorE1(f.store, first).call);
  deliveredOf(e51AdmitAssessorE1(f.store, second).call);
  f.assessorsForTwoOriginals("supported", "supported");
  const firstResult = deliveredOf(await assessFact(f.store, first));
  assert.equal(e51Outcome(f), null, "the second admitted MC1 remains unfinished");
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before duplicate-key G7 write");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => assessFact(f.store, second), /stop before duplicate-key G7 write/); }
  finally { f.store.writeMany = originalWrite; }
  const terminals = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND);
  assert.equal(terminals.length, 2);
  assert.equal(terminals.every(row => row.value.verdict === "supported"), true);
  const accepted = terminals.map(row => row.value.accepted!);
  assert.equal(new Set(accepted.map(ref => ref.id)).size, 2);
  const keys = accepted.map(ref => deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: ref })).key);
  assert.equal(keys[0], keys[1], "the semantic fact is identical across two paid MC1 calls");
  const current = f.store.get<RepairSeries>(f.series.id)!;
  const closure = deliveredOf(readCurrentAssessmentAttemptClosure(f.store, { project: f.project,
    block: f.block, series: reference(current), attempt: 1, goal: f.attemptGoal }));
  assert.equal(closure.status, "ready");
  assert.equal(closure.intents.length, 2);
  assert.equal(closure.results.length, 2);
  assert.deepEqual(closure.accepting, [...accepted].sort((left, right) =>
    canonical(left) < canonical(right) ? -1 : canonical(left) > canonical(right) ? 1 : 0));
  const request = { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: outcome({ accepting: closure.accepting }) };
  const forward = deliveredOf(prepareCloseAttempt(f.store, request));
  const reversed = deliveredOf(prepareCloseAttempt(f.store, { ...request,
    outcome: outcome({ accepting: [...closure.accepting].reverse() }) }));
  assert.deepEqual(reversed.writes, forward.writes,
    "the aggregate and canonical representative cannot depend on caller order");
  const closed = deliveredOf(closeAttempt(f.store, request));
  const saved = e51Outcome(f);
  assert.ok(saved);
  assert.equal(saved.reason, "result");
  assert.equal(saved.achieved.length, 1);
  assert.equal(saved.achieved[0]!.key, keys[0]);
  assert.deepEqual(saved.achieved[0]!.basis, closure.accepting[0], "the representative is canonical");
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 0);
  const before = f.store.list().map(reference), sends = f.sent().length;
  assert.equal(sends, 4);
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), closed);
  assert.deepEqual(deliveredOf(await assessFact(f.store, first)), firstResult);
  const secondResult = terminals.find(row => row.id !== firstResult.id)!;
  assert.deepEqual(deliveredOf(await assessFact(f.store, second)), secondResult);
  for (const terminal of terminals) {
    const replay = deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent));
    assert.equal(replay.complete, true);
    assert.equal(replay.closed, true);
    assert.deepEqual(replay.results, [reference(terminal)]);
  }
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
});

test("E5.1 does not let duplicate supported keys hide an incomplete original MC1 set", async t => {
  const f = e51Fixture(t, 2), first = await f.original(), second = await f.secondOriginal();
  deliveredOf(e51AdmitAssessorE1(f.store, first).call);
  deliveredOf(e51AdmitAssessorE1(f.store, second).call);
  f.assessorsForTwoOriginals("supported", "supported");
  const firstResult = deliveredOf(await assessFact(f.store, first));
  const secondResult = deliveredOf(await assessFact(f.store, second));
  const accepting = [firstResult.value.accepted!, secondResult.value.accepted!];
  assert.equal(deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: accepting[0]! })).key,
    deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: accepting[1]! })).key);
  const current = f.store.get<RepairSeries>(f.series.id)!;
  const closure = deliveredOf(readCurrentAssessmentAttemptClosure(f.store, { project: f.project,
    block: f.block, series: reference(current), attempt: 1, goal: f.attemptGoal }));
  assert.equal(closure.status, "incomplete");
  assert.equal(closure.results.length, 2);
  const request = { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: outcome({ accepting }) };
  const before = f.store.list().map(reference), sends = f.sent().length;
  assert.equal(closeAttempt(f.store, request).ok, false);
  assert.equal(e51Outcome(f), null);
  f.restart();
  assert.equal(closeAttempt(f.store, request).ok, false);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
});

test("E5.1 replays each local technical MC1 set against the shared interrupted outcome", async t => {
  const f = e51Fixture(t, false), first = await f.original(), second = await f.secondOriginal();
  deliveredOf(e51AdmitAssessorE1(f.store, first).call);
  deliveredOf(e51AdmitAssessorE1(f.store, second).call);
  f.assessorsForTwoOriginals("off-form", "interrupted");
  const offForm = deliveredOf(await assessFact(f.store, first));
  const interrupted = deliveredOf(await assessFact(f.store, second));
  assert.equal(offForm.value.verdict, "off-form");
  assert.equal(interrupted.value.verdict, "interrupted");
  assert.equal(e51Outcome(f), null);
  const request = { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: outcome({ reason: "interrupted" }) };
  const closed = deliveredOf(closeAttempt(f.store, request));
  assert.equal(e51Outcome(f)?.reason, "interrupted");
  assert.deepEqual(e51Outcome(f)?.achieved, []);
  assert.deepEqual(e51Outcome(f)?.refusals, []);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 1);
  const before = f.store.list().map(reference), sends = f.sent().length;
  assert.equal(sends, 4);
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, request)), closed);
  for (const [original, terminal] of [[first, offForm], [second, interrupted]] as const) {
    const replay = deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent));
    assert.equal(replay.complete, true);
    assert.equal(replay.closed, true);
    assert.deepEqual(replay.results, [reference(terminal)]);
    assert.deepEqual(deliveredOf(await assessFact(f.store, original)), terminal);
  }
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
});

test("E5.1 keeps a supported fact and a separate negative result for the same question across MC1 calls", async t => {
  const f = e51Fixture(t, false), first = await f.original(), second = await f.secondOriginal();
  deliveredOf(e51AdmitAssessorE1(f.store, first).call);
  deliveredOf(e51AdmitAssessorE1(f.store, second).call);
  f.assessorsForTwoOriginals("supported", "insufficient");
  const supported = deliveredOf(await assessFact(f.store, first));
  assert.equal(e51Outcome(f), null);
  const insufficient = deliveredOf(await assessFact(f.store, second));
  const source = f.store.get(assessmentRefusalId(f.project, reference(insufficient)))!;
  const claim = e51Claim(f.store, f.project, reference(source));
  const saved = e51Outcome(f);
  assert.ok(saved);
  assert.equal(saved.reason, "result");
  assert.equal(saved.achieved.length, 1);
  assert.deepEqual(saved.achieved[0]!.basis, supported.value.accepted);
  assert.deepEqual(saved.refusals, [{ row: claim.row }]);
  assert.deepEqual(saved.cancelled, []);
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  for (const [original, terminal] of [[first, supported], [second, insufficient]] as const) {
    assert.deepEqual(deliveredOf(await assessFact(f.store, original)), terminal);
    const replay = deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent));
    assert.equal(replay.complete, true);
    assert.equal(replay.closed, true);
    assert.deepEqual(replay.results, [reference(terminal)]);
  }
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
});

test("E5.1 keeps distinct supported values of one question as distinct semantic achievements", async t => {
  const f = e51Fixture(t, false), first = await f.original(), second = await f.secondOriginal("UTF-16");
  deliveredOf(e51AdmitAssessorE1(f.store, first).call);
  deliveredOf(e51AdmitAssessorE1(f.store, second).call);
  f.assessorsForTwoOriginals("supported", "supported");
  const firstResult = deliveredOf(await assessFact(f.store, first));
  assert.equal(e51Outcome(f), null);
  const secondResult = deliveredOf(await assessFact(f.store, second));
  const firstKey = deliveredOf(readAcceptedAnswer(f.store, { project: f.project,
    record: firstResult.value.accepted! })).key;
  const secondKey = deliveredOf(readAcceptedAnswer(f.store, { project: f.project,
    record: secondResult.value.accepted! })).key;
  assert.notEqual(firstKey, secondKey, "the question identity does not vote away a different supported value");
  const saved = e51Outcome(f);
  assert.ok(saved);
  assert.equal(saved.reason, "result");
  assert.deepEqual(saved.achieved.map(item => item.key).sort(), [firstKey, secondKey].sort());
  assert.deepEqual(saved.refusals, []);
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(await assessFact(f.store, first)), firstResult);
  assert.deepEqual(deliveredOf(await assessFact(f.store, second)), secondResult);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
});

test("E5.1 gives two negative MC1 terminals of one question separate A2 rows", async t => {
  const f = e51Fixture(t, false), first = await f.original(), second = await f.secondOriginal();
  deliveredOf(e51AdmitAssessorE1(f.store, first).call);
  deliveredOf(e51AdmitAssessorE1(f.store, second).call);
  f.assessorsForTwoOriginals("insufficient", "insufficient");
  const firstResult = deliveredOf(await assessFact(f.store, first));
  assert.equal(e51Outcome(f), null);
  const secondResult = deliveredOf(await assessFact(f.store, second));
  const rows = [firstResult, secondResult].map(result => {
    const source = f.store.get(assessmentRefusalId(f.project, reference(result)))!;
    return e51Claim(f.store, f.project, reference(source)).row;
  });
  assert.equal(new Set(rows).size, 2);
  const saved = e51Outcome(f);
  assert.ok(saved);
  assert.equal(saved.reason, "refused");
  assert.deepEqual(saved.achieved, []);
  assert.deepEqual(saved.refusals.map(item => item.row).sort(), rows.sort());
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(await assessFact(f.store, first)), firstResult);
  assert.deepEqual(deliveredOf(await assessFact(f.store, second)), secondResult);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
});

test("E5.1 does not transfer an identical fact key to another attempt", async t => {
  const f = e51Fixture(t, false), first = await f.original();
  f.assessor("supported");
  const terminal = deliveredOf(await assessFact(f.store, first));
  const accepted = terminal.value.accepted!;
  assert.equal(e51Outcome(f)?.reason, "result");
  deliveredOf(openAttempt(f.store, { project: f.project, block: f.block, line: 1,
    attempt: 2, goal: f.attemptGoal }));
  const key = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: accepted })).key;
  assert.equal(acceptedAnswerRepresents(f.store, { project: f.project, block: f.block,
    goal: f.attemptGoal, attempt: { series: reference(f.store.get<RepairSeries>(f.series.id)!), ordinal: 2 },
    accepting: [accepted] }, accepted, key), false,
  "the E5 provider does not confirm its first-attempt result for another attempt");
  const before = f.store.get<RepairSeries>(f.series.id)!;
  const foreign = closeAttempt(f.store, { project: f.project, block: f.block, line: 1,
    attempt: 2, outcome: outcome({ accepting: [accepted] }) });
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.refusal.code, "achievement_unconfirmed");
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  f.restart();
  assert.equal(closeAttempt(f.store, { project: f.project, block: f.block, line: 1,
    attempt: 2, outcome: outcome({ accepting: [accepted] }) }).ok, false);
  assert.equal(f.sent().length, 2);
});

test("E5.1 confirms both E5 and native D5 of one fact but advances the goal once", async t => {
  const f = e51Fixture(t, false), original = await f.original();
  const intent = deliveredOf(writeAssessmentIntent(f.store, original));
  const admission = deliveredOf(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const mc1Ref = admission.question.record;
  const mc1 = f.store.get<Mc1QuestionRecord>(mc1Ref.id, mc1Ref.revision)!;
  const source = f.store.get<{ content: string }>(`source:${f.project}:brief`)!;
  const nativeDraft = f.engine.discovery.create(f.project, "om-g2", "R1", f.block,
    [mc1FieldSpec({ input: mc1.value.request.input, gap: mc1.value.request.gap,
      contract: mc1.value.request.contract })],
    [mc1.value.request.input, mc1.value.request.gap,
      ...(mc1.value.request.task ? [mc1.value.request.task] : []), reference(source)]);
  const issued = f.store.get<Question>(nativeDraft.value.questions[0]!)!;
  const nativeQuestion = deliveredOf(writeMc1Question(f.store, { ...mc1.value.request,
    engineQuestion: reference(issued), draft: reference(nativeDraft) }));
  writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep, e51AssessorStep("supported")] }));
  const assessment = await assessAnswer(f.store, issued, { action: "answer", question: issued.id, value: "UTF-8",
    citations: [{ source: reference(source), selector: { kind: "text-range", start: 0,
      end: source.value.content.length } }] }, f.config, f.root);
  const researchedDraft = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment));
  const answered = f.store.get<Question>(issued.id)!;
  assert.ok(answered.value.answer);
  const native = deliveredOf(writeAcceptedAnswer(f.store, { project: f.project, question: reference(nativeQuestion),
    answer: answered.value.answer!, answeredQuestion: reference(answered), draft: reference(researchedDraft),
    attempt: { series: reference(f.series), attempt: 1 } }));
  // Native assessment consumed the second fixture response; E5's independent assessor gets the third.
  writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep,
    e51AssessorStep("supported"), e51AssessorStep("supported")] }));
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before native and E5 G7 write");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(async () => {
    const result = await assessFact(f.store, original);
    assert.fail(`expected interrupted G7 write, got ${JSON.stringify(result)}`);
  }, /stop before native and E5 G7 write/); }
  finally { f.store.writeMany = originalWrite; }
  const terminal = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)[0]!;
  assert.equal(terminal.value.verdict, "supported");
  const e5 = terminal.value.accepted!;
  const nativeRef = reference(native);
  assert.notEqual(e5.id, nativeRef.id);
  const e5Key = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: e5 })).key;
  const nativeKey = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: nativeRef })).key;
  assert.equal(e5Key, nativeKey);
  const at = { project: f.project, block: f.block, line: 1, attempt: 1 };
  const one = deliveredOf(prepareCloseAttempt(f.store, { ...at,
    outcome: outcome({ accepting: [e5, nativeRef] }) }));
  const opposite = deliveredOf(prepareCloseAttempt(f.store, { ...at,
    outcome: outcome({ accepting: [nativeRef, e5] }) }));
  assert.deepEqual(one.writes, opposite.writes);
  const closing = { ...at, outcome: outcome({ accepting: [e5, nativeRef] }) };
  const closed = deliveredOf(closeAttempt(f.store, closing));
  const saved = e51Outcome(f);
  assert.ok(saved);
  assert.equal(saved.reason, "result");
  assert.equal(saved.achieved.length, 1);
  assert.equal(saved.achieved[0]!.key, e5Key);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 0);
  const nativeFact = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: nativeRef }));
  const prior = mc1.value.request.gaps;
  const initial = deliveredOf(writeGapLines(f.store, { project: f.project, previous: null,
    pass: 1, gaps: prior, closures: [] }));
  const applied = deliveredOf(writeApplyAnswer(f.store, { project: f.project,
    input: mc1.value.request.input, answer: nativeRef, question: reference(mc1) }));
  const nextHorizon = deliveredOf(writeHorizon(f.store, { project: f.project, input: reference(applied),
    graph: prior.sources.graph, refinement: null, available: {},
    choice: { choiceVersion: "e51-native-d2", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const nextSources: GapRequest = { ...structuredClone(prior.sources), input: reference(applied),
    horizon: reference(nextHorizon.gate), operations: { ...structuredClone(prior.sources.operations),
      frame: { ...structuredClone(prior.sources.operations.frame), horizon: reference(nextHorizon.gate) } } };
  const nextGaps = deliveredOf(writeGaps(f.store, nextSources));
  const current: GapReadRequest = { sources: structuredClone(nextGaps.sources) as GapRequest,
    records: nextGaps.records.map(reference) };
  const nativeAttempt = { series: nativeFact.attempt!.series, attempt: nativeFact.attempt!.ordinal };
  const confirmation = { project: f.project, basis: { record: nativeRef }, target: nativeFact.gap.target,
    field: nativeFact.gap.field, prior, current, attempt: nativeAttempt, currentOnly: true };
  assert.equal(deliveredOf(confirmAnswerGapClosure(f.store, confirmation)).key, nativeFact.key);
  const closure = { id: nativeFact.gap.id, reason: "filled" as const, basis: nativeRef, acceptance: null,
    attempt: nativeAttempt, answer: { record: nativeRef } };
  deliveredOf(writeGapLines(f.store, { project: f.project, previous: reference(initial),
    pass: 2, gaps: current, closures: [closure] }));
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, closing)), closed);
  assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent)),
    { complete: true, closed: true, results: [reference(terminal)] });
  assert.equal(deliveredOf(confirmAnswerGapClosure(f.store, confirmation)).key, nativeFact.key);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
});

async function crossProviderAttempt(t: test.TestContext, managed: boolean) {
  const f = e51Fixture(t, false), first = await f.original();
  const intent = deliveredOf(writeAssessmentIntent(f.store, first));
  const admission = deliveredOf(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const mc1 = f.store.get<Mc1QuestionRecord>(admission.question.record.id, admission.question.record.revision)!;
  writeFileSync(join(f.root, "native-proof.txt"), "UTF-8 is supported.");
  const nativeSource = f.engine.discovery.evidence.file(f.project, "native-proof", f.root, "native-proof.txt", "text/plain", 0);
  const source = f.store.get<{ content: string }>(nativeSource.id)!;
  const nativeDraft = f.engine.discovery.create(f.project, "om-g2", "R1", f.block,
    [mc1FieldSpec({ input: mc1.value.request.input, gap: mc1.value.request.gap,
      contract: mc1.value.request.contract })],
    [mc1.value.request.input, mc1.value.request.gap,
      ...(mc1.value.request.task ? [mc1.value.request.task] : []), reference(source)]);
  const issued = f.store.get<Question>(nativeDraft.value.questions[0]!)!;
  const nativeQuestion = deliveredOf(writeMc1Question(f.store, { ...mc1.value.request,
    engineQuestion: reference(issued), draft: reference(nativeDraft) }));
  writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep, e51AssessorStep("supported")] }));
  const assessment = await assessAnswer(f.store, issued, { action: "answer", question: issued.id, value: "UTF-8",
    citations: [{ source: reference(source), selector: { kind: "text-range", start: 0,
      end: source.value.content.length } }] }, f.config, f.root);
  const researchedDraft = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment));
  const answered = f.store.get<Question>(issued.id)!;
  assert.ok(answered.value.answer);
  const native = deliveredOf(writeAcceptedAnswer(f.store, { project: f.project, question: reference(nativeQuestion),
    answer: answered.value.answer, answeredQuestion: reference(answered), draft: reference(researchedDraft),
    attempt: { series: reference(f.series), attempt: 1 } }));
  const nativeRef = reference(native), at = { project: f.project, block: f.block, line: 1 };
  deliveredOf(closeAttempt(f.store, { ...at, attempt: 1, outcome: outcome({ accepting: [nativeRef] }) }));
  let secondSeries = managed ? null : deliveredOf(openAttempt(f.store, { ...at, attempt: 2, goal: f.attemptGoal }));

  writeFileSync(join(f.root, "native-proof.txt"), "This evidence no longer supports the old encoding.");
  const oldRoutes = f.store.list<RoutesRecord>("route-result")[0]!;
  const priorRoutes = oldRoutes.value.request;
  const routes = deliveredOf(writeRoutes(f.store, { project: f.project, gaps: priorRoutes.gaps,
    tasks: priorRoutes.tasks.map(record => ({ record })), catalog: priorRoutes.catalog,
    previous: reference(oldRoutes) }));
  const batch = routes.value.batches.find(row => row.model === "MC1"
    && row.items.some(item => item.gap === first.questionId));
  assert.ok(batch);
  if (managed) secondSeries = deliveredOf(openAttempt(f.store, { ...at, attempt:2, goal:f.attemptGoal,
    completion:{routes:reference(routes),batches:[batch.id]} }));
  const packet = deliveredOf(writeQuestionPacket(f.store, { project: f.project, routes: reference(routes),
    batch: batch.id, environment: reference(f.config),
    attempt: { series: reference(secondSeries!), ordinal: 2 }, previous: [] })).record;
  writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep, e51AssessorStep("supported"),
    f.originalStep, e51AssessorStep("supported")] }));
  const model = deliveredOf(await runModelCall(f.store, { project: f.project, packet: reference(packet),
    dispatch: first.dispatch, role: "implementer" }));
  const second = { ...first, modelCall: reference(model.record) };
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before cross-attempt G7 write");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try {
    if (managed) deliveredOf(await assessFact(f.store, second));
    else await assert.rejects(() => assessFact(f.store, second), /stop before cross-attempt G7 write/);
  }
  finally { f.store.writeMany = originalWrite; }
  const terminal = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)[0]!;
  const e5 = terminal.value.accepted!;
  const e5Fact = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: e5 }));
  const nativeFact = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: nativeRef }));
  assert.equal(nativeFact.key, e5Fact.key);
  const closing = { ...at, attempt: 2, outcome: outcome({ accepting: [e5, nativeRef] }) };
  deliveredOf(closeAttempt(f.store, closing));
  const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[1]!.outcome!;
  assert.equal(saved.achieved.length, 1);
  assert.equal(saved.achieved[0]!.key, e5Fact.key);
  const context = { project: f.project, block: f.block, goal: f.attemptGoal,
    attempt: { series: reference(f.store.get<RepairSeries>(f.series.id)!), ordinal: 2 },
    accepting: [nativeRef, e5] };
  assert.equal(acceptedAnswerRepresents(f.store, context, nativeRef, e5Fact.key), true);
  assert.equal(acceptedAnswerRepresents(f.store, context, e5, e5Fact.key), true);
  assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent)),
    { complete: true, closed: true, results: [reference(terminal)] });
  assert.deepEqual(deliveredOf(await assessFact(f.store, second)), terminal);

  const mc1Second = f.store.get<Mc1QuestionRecord>(deliveredOf(readAssessmentIntentAt(f.store,
    f.project, terminal.value.intent)).question.record.id)!;
  const prior = mc1Second.value.request.gaps;
  const initial = deliveredOf(writeGapLines(f.store, { project: f.project, previous: null,
    pass: 1, gaps: prior, closures: [] }));
  const applied = deliveredOf(writeApplyAnswer(f.store, { project: f.project,
    input: mc1Second.value.request.input, answer: e5, question: reference(mc1Second) }));
  const horizon = deliveredOf(writeHorizon(f.store, { project: f.project, input: reference(applied),
    graph: prior.sources.graph, refinement: null, available: {},
    choice: { choiceVersion: "e51-cross-attempt-d2", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { ...structuredClone(prior.sources), input: reference(applied),
    horizon: reference(horizon.gate), operations: { ...structuredClone(prior.sources.operations),
      frame: { ...structuredClone(prior.sources.operations.frame), horizon: reference(horizon.gate) } } };
  const gaps = deliveredOf(writeGaps(f.store, sources));
  const current: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest,
    records: gaps.records.map(reference) };
  const answerAttempt = { series: e5Fact.attempt!.series, attempt: e5Fact.attempt!.ordinal };
  const confirmation = { project: f.project, basis: { record: e5 }, target: e5Fact.gap.target,
    field: e5Fact.gap.field, prior, current, attempt: answerAttempt, currentOnly: true };
  assert.equal(deliveredOf(confirmAnswerGapClosure(f.store, confirmation)).key, e5Fact.key);
  const closure = { id: e5Fact.gap.id, reason: "filled" as const, basis: e5, acceptance: null,
    attempt: answerAttempt, answer: { record: e5 } };
  const next = { project: f.project, previous: reference(initial), pass: 2, gaps: current, closures: [closure] };
  assert.ok(deliveredOf(prepareGapLines(f.store, next)).guards.some(ref => ref.id === f.series.id));
  deliveredOf(writeGapLines(f.store, next));
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, closing)).attempt, 2);
  assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent)),
    { complete: true, closed: true, results: [reference(terminal)] });
  assert.deepEqual(deliveredOf(await assessFact(f.store, second)), terminal);
  assert.equal(deliveredOf(confirmAnswerGapClosure(f.store, confirmation)).key, e5Fact.key);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
}
test("E5.1 repeats a completed fact after a native D5 of another attempt represented the same key", t => crossProviderAttempt(t,false));
test("C28 H1.0a managed E5 and D2 preserve the native representative of another attempt", t => crossProviderAttempt(t,true));

test("E5.1 refuses an off-form claim with an admitted but unterminated MC1 set", async t => {
  const f = e51Fixture(t, false), original = await f.original();
  deliveredOf(e51AdmitAssessorE1(f.store, original).call);
  assert.deepEqual(f.store.list(ASSESSMENT_RESULT_KIND), []);
  const request = { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: outcome({ reason: "off-form" }) };
  const before = f.store.get<RepairSeries>(f.series.id)!, sends = f.sent().length;
  for (const close of [prepareCloseAttempt, closeAttempt]) {
    const attempted = close(f.store, request);
    assert.equal(attempted.ok, false);
    if (!attempted.ok) assert.equal(attempted.refusal.code, "origin_unreadable");
    assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  }
  f.restart();
  const repeated = closeAttempt(f.store, request);
  assert.equal(repeated.ok, false);
  if (!repeated.ok) assert.equal(repeated.refusal.code, "origin_unreadable");
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  assert.equal(f.sent().length, sends);
});

// ---- H1.0d: the M5 addressing provider through real producers (№1449, №1688) ----
import { readModelCallState, prepareModelAttemptFinish, finishModelAttempt, type ModelCallRequest } from "../src/om/model-call.js";
import { confirmResults, acceptanceRepresents } from "../src/om/achievements.js";
import { readCompletionCloseAt } from "../src/om/repeat-gate.js";
import { readMechanismAdmission } from "../src/om/series.js";
import { spendReport, readSpendReport } from "../src/om/spend-report.js";

const m5Adapter = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const m5Owner = { kind: "mechanism", mechanism: "M5:addressing" } as const;
function m5Fixture(t: test.TestContext, managed = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-h10d-m5-")), database = join(root, "state.sqlite"), project = "garden";
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...upper } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, upper as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = ["encoding", "spare"].map(id => ({ id,
      question: `Which ${id} is supported?`, consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false,
      resolution: "Address this question during OM" }));
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = deliveredOf(writeOmInput(store, { project, expected: 0, stages }));
  const graph = reference(store.get(`graph:${project}`)!);
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph, refinement: null,
    choice: { choiceVersion: "h10d-m5", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
  const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph, horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = deliveredOf(writeGaps(store, sources));
  const scope: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const routes = deliveredOf(writeRoutes(store, { project, gaps: scope, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(item => item.model === "MC2" && item.task === "input-field"
    && item.items.some(gap => gap.target === "discovery:encoding"))!;
  assert.ok(batch && batch.items.length === 2, "one real MC2 input-field batch addresses both questions");
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [m5Adapter, "--scenario", scenario, "--trace", trace] };
  const environment = (amount = 100_000) => engine.environments.configure(project, { workspace: root,
    implementer: { actor: "m5-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "m5-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: amount },
  store.get(`environment:${project}`)?.revision ?? 0);
  const configured = environment();
  const adapter = store.write({ id: `adapter:${project}:m5`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const goal: AttemptGoal = { key: "h10d-m5", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const address = { project, owner: m5Owner, line: 1 };
  const admission = { gaps: scope, routes: reference(routes), batch: batch.id };
  deliveredOf(openSeries(store, { ...address, scope, predecessor: null, basis: null }));
  const series = deliveredOf(openAttempt(store, { ...address, attempt: 1, goal, admission,
    ...(managed ? { completion: { routes: reference(routes), batches: [batch.id] } } : {}) } as never));
  const call = (config = configured): ModelCallRequest => {
    const packet = deliveredOf(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
      environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
    return { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(config) }, role: "implementer" };
  };
  const answer = (targets = batch.items.map(item => item.target), kind = "repository-fact") => ({ research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer",
    results: batch.items.filter(item => targets.includes(item.target)).map(item => ({ target: item.target, field: item.field, basis: item.record,
      value: { consumer: "garden-consume-block", kind } })) } });
  return { root, database, project, address, admission, goal, batch, routes, series, environment, call, answer,
    get store() { return store; },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); } };
}
/** The key formula of №1449 §2, over the admitted slice row and the accepted consumer/kind. */
function m5Key(f: ReturnType<typeof m5Fixture>, target: string): string {
  const proof = deliveredOf(readMechanismAdmission(f.store, { project: f.project, series: reference(f.series), attempt: 1,
    admission: f.admission as never, current: false }));
  const row = proof.value.questions.find(item => item.target === target && item.field === "address")!;
  return `om-result:${hashJson({ kind: "addressing", project: f.project, target: row.target, field: "address", task: row.task,
    producer: row.producer, protected: row.protected, accepted: { consumer: "garden-consume-block", kind: "repository-fact" } } as Json)}`;
}
const m5Context = (f: ReturnType<typeof m5Fixture>, series: Ref = reference(f.series)) => ({ project: f.project, owner: m5Owner,
  target: f.series.id, goal: f.goal, attempt: { series, ordinal: 1 }, cancelling: [] as Ref[] });

test("O1 O2 O4 O11 C1 C3 C6 C11 E1 E2 E5 X8 H1.0d an applied M5 E4 confirms every addressing of its batch under the typed owner, and G7 closes with them", async t => {
  const f = m5Fixture(t);
  f.steps([f.answer()]);
  const sent = deliveredOf(await runModelCall(f.store, f.call()));
  assert.equal(sent.outcome?.kind, "input-decisions");
  const e4 = reference(sent.record);
  const keys = f.batch.items.map(item => m5Key(f, item.target));
  const confirmed = deliveredOf(confirmResults(f.store, { ...m5Context(f), accepting: [e4] }));
  assert.deepEqual(confirmed.achieved.map(item => item.key).sort(), [...keys].sort());
  assert.ok(confirmed.achieved.every(item => canonical(item.basis) === canonical(e4)));
  const closing = { ...f.address, attempt: 1, outcome: outcome({ accepting: [e4] }) };
  const closed = deliveredOf(closeAttempt(f.store, closing));
  assert.equal(closed.verdict, "progress");
  const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome!;
  assert.equal(saved.reason, "result");
  assert.deepEqual(saved.achieved.map(item => item.key).sort(), [...keys].sort());
  // O4, C3: the exact repeat names no new result; the same E4 twice is one ground.
  const before = mechanismSnapshot(f.store);
  assert.deepEqual(deliveredOf(prepareCloseAttempt(f.store, closing)).writes, []);
  assert.equal(deliveredOf(confirmResults(f.store, { ...m5Context(f), accepting: [e4, e4] })).achieved.length, 2);
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, closing)), closed);
  // C11: a later revision of the same series names the same attempt; the provider still reads only its E1 lineage.
  const later = reference(f.store.get(f.series.id)!);
  assert.deepEqual(deliveredOf(confirmResults(f.store, { ...m5Context(f, later), accepting: [e4] })).achieved, confirmed.achieved);
  assert.equal(acceptanceRepresents(f.store, { project: f.project, owner: m5Owner, goal: f.goal, attempt: { series: later, ordinal: 1 } }, e4, keys[0]!), true);
  assert.deepEqual(mechanismSnapshot(f.store), before);
});

test("O3 C28 H1.0d a partial applied answer accepts only its addressed question; the unanswered one is neither accepted nor refused", async t => {
  const f = m5Fixture(t);
  f.steps([f.answer(["discovery:encoding"])]);
  const sent = deliveredOf(await runModelCall(f.store, f.call()));
  assert.equal(sent.outcome?.kind, "input-decisions");
  if (sent.outcome?.kind === "input-decisions") assert.equal(sent.outcome.unanswered.length, 1);
  const e4 = reference(sent.record);
  const confirmed = deliveredOf(confirmResults(f.store, { ...m5Context(f), accepting: [e4] }));
  assert.deepEqual(confirmed.achieved.map(item => item.key), [m5Key(f, "discovery:encoding")]);
  const closed = deliveredOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome({ accepting: [e4] }) }));
  assert.equal(closed.verdict, "progress");
  const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome!;
  assert.deepEqual(saved.achieved.map(item => item.key), [m5Key(f, "discovery:encoding")]);
  assert.deepEqual(saved.refusals, []);
});

test("C15 X3 H1.0d a new standalone close cannot omit an accepted M5 result, nor hide its results behind another reason", async t => {
  const f = m5Fixture(t);
  f.steps([f.answer()]);
  const e4 = reference(deliveredOf(await runModelCall(f.store, f.call())).record);
  const before = mechanismSnapshot(f.store);
  const omitted = refusalOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome() }));
  assert.deepEqual([omitted.code, omitted.at.field, omitted.at.ref], ["origin_unreadable", "outcome.accepting", e4]);
  const hidden = refusalOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome({ reason: "interrupted", accepting: [e4] }) }));
  assert.deepEqual([hidden.code, hidden.at.field], ["origin_unreadable", "outcome.reason"]);
  assert.deepEqual(mechanismSnapshot(f.store), before);
});

test("C01 O6 C8 C13 O13 H1.0d owners select their providers: no block provider reads a mechanism, no M5 result serves a block or another attempt", async t => {
  const f = m5Fixture(t);
  f.steps([f.answer()]);
  const e4 = reference(deliveredOf(await runModelCall(f.store, f.call())).record);
  const input = reference(f.store.list("om-input").at(-1)!);
  const foreignKind = refusalOf(confirmResults(f.store, { ...m5Context(f), accepting: [input] }));
  assert.deepEqual([foreignKind.code, foreignKind.at.field], ["achievement_unconfirmed", "outcome.accepting.0.kind"]);
  const asBlock = refusalOf(confirmResults(f.store, { project: f.project, block: "garden-consume-block", target: f.series.id,
    goal: f.goal, attempt: { series: reference(f.series), ordinal: 1 }, accepting: [e4], cancelling: [] }));
  assert.deepEqual([asBlock.code, asBlock.at.field], ["achievement_unconfirmed", "outcome.accepting.0.kind"]);
  for (const other of [{ ...m5Context(f), goal: { ...f.goal, key: "another-goal" } },
    { ...m5Context(f), attempt: { series: reference(f.series), ordinal: 2 } }]) {
    const refused = refusalOf(confirmResults(f.store, { ...other, accepting: [e4] }));
    assert.deepEqual([refused.code, refused.at.field], ["achievement_unconfirmed", "outcome.accepting.0"]);
  }
  assert.throws(() => confirmResults(f.store, { ...m5Context(f), block: "garden-consume-block", accepting: [e4] } as never),
    (error: unknown) => error instanceof EngineError && error.code === "acceptance_request_invalid");
  const { attempt: _attempt, ...unbound } = m5Context(f);
  assert.throws(() => confirmResults(f.store, { ...unbound, accepting: [e4] } as never),
    (error: unknown) => error instanceof EngineError && error.code === "acceptance_request_invalid");
  const standing = deliveredOf(readModelCallState(f.store, { project: f.project, record: e4 }));
  assert.equal(standing.state, "applied");
});

test("C43 O7 O8 O10 C15 E6 X13 X14 H1.0d a standalone finish of another call keeps the addressings its attempt already applied", async t => {
  const f = m5Fixture(t);
  const second = f.call(f.environment(90_000));
  f.steps([f.answer(), f.answer()]);
  // The second call is answered first, but stops after its receipt and before its application (lesson 39).
  const original = f.store.writeMany.bind(f.store);
  let stopped = false;
  f.store.writeMany = ((writes, guards) => {
    if (!stopped && writes.some(write => write.kind === "model-call"
      && (write.value as { om?: { application?: string } }).om?.application === "applied")) {
      stopped = true; throw new Error("stop before application");
    }
    return original(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => runModelCall(f.store, second), /stop before application/); }
  finally { f.store.writeMany = original; }
  // O7: a saved but unapplied answer accepts nothing.
  const received = reference(f.store.list("model-call")[0]!);
  assert.equal(deliveredOf(readModelCallState(f.store, { project: f.project, record: received })).state, "received");
  assert.equal(refusalOf(confirmResults(f.store, { ...m5Context(f), accepting: [received] })).code, "achievement_unconfirmed");
  const first = f.call(f.environment(80_000));
  const applied = deliveredOf(await runModelCall(f.store, first));
  assert.equal(applied.outcome?.kind, "input-decisions");
  const e4 = reference(f.store.get(applied.record.id)!);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  // C15 window: a G7 close prepared while the other call is only received fails once that call is applied.
  const prepared = deliveredOf(prepareCloseAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome({ accepting: [e4] }) }));
  assert.ok(prepared.guards.some(guard => "revision" in guard && guard.id === received.id && guard.revision === received.revision));
  // After D3 of the first call the second one can only end without its own result; the attempt keeps the first's.
  const late = await runModelCall(f.store, second);
  const stale = writeGuarded(f.store, { unit: "G7", target: f.series.id, writes: [...prepared.writes], guards: [...prepared.guards] });
  assert.equal(stale.ok, false);
  // O8, O10: the other call ends with its own diagnostic or refused application, and accepts no result.
  const ended = reference(f.store.get(received.id)!);
  assert.equal(refusalOf(confirmResults(f.store, { ...m5Context(f), accepting: [ended] })).code, "achievement_unconfirmed");
  const series = f.store.get<RepairSeries>(f.series.id)!;
  const saved = series.value.attempts[0]!.outcome!;
  assert.ok(saved, `the finishing call closes the standalone attempt (${late.ok ? "applied" : late.refusal.code})`);
  assert.equal(saved.reason, "result");
  assert.deepEqual(saved.achieved.map(item => item.key).sort(), f.batch.items.map(item => m5Key(f, item.target)).sort());
  assert.ok(saved.achieved.every(item => canonical(item.basis) === canonical(e4)));
  assert.ok(saved.refusals.length > 0, "the local diagnostic of the other call is kept");
  const before = mechanismSnapshot(f.store), sends = readFileSync(join(f.root, "trace.jsonl"), "utf8").trim().split("\n").length;
  f.restart();
  for (const record of f.store.list("model-call")) assert.ok(readModelCallState(f.store, { project: f.project, record: reference(record) }).ok);
  assert.deepEqual(deliveredOf(confirmResults(f.store, { ...m5Context(f, reference(series)), accepting: [e4] })).achieved.map(item => item.key).sort(),
    saved.achieved.map(item => item.key).sort());
  const report = deliveredOf(spendReport(f.store, { project: f.project }));
  const results = report.rows.filter(row => row.result !== null);
  assert.ok(results.length >= 1 && results.every(row => canonical(row.result!.achieved) === canonical(saved.achieved)));
  assert.deepEqual(deliveredOf(readSpendReport(f.store, report.snapshot)), report);
  // №1688-8: the finish and a direct G7 repeat of the same outcome are one transition: the E4 diagnostics were classified
  // by the finish (never unknown), and the repeat writes nothing — no class, no origin hold.
  const journal = f.store.get<RefusalJournal>(journalId(f.project))!;
  const claims = saved.refusals.map(({ row }) => { const entry = journal.value.rows.find(item => item.id === row)!;
    return { row, name: entry.code, goal: entry.goal }; });
  const classes = journal.value.classifications.filter(item => claims.some(claim => claim.row === item.row));
  assert.equal(classes.length, claims.length);
  assert.ok(classes.every(item => item.class !== "unknown"), JSON.stringify(classes));
  assert.deepEqual(deliveredOf(prepareCloseAttempt(f.store, { ...f.address, attempt: 1,
    outcome: { reason: saved.reason, accepting: [e4], cancelling: [], refusals: claims } })).writes, []);
  assert.equal(f.store.list(ORIGIN_HOLD_KIND).length, 0);
  assert.deepEqual(mechanismSnapshot(f.store), before);
  assert.equal(readFileSync(join(f.root, "trace.jsonl"), "utf8").trim().split("\n").length, sends);
});

test("C13 C14 C45 E3 E7 X3 E10 E11 E12 X15 H1.0d a managed M5 close retains every applied addressing of its registry and E6 re-derives it", async t => {
  const f = m5Fixture(t, true);
  f.steps([f.answer()]);
  const applied = deliveredOf(await runModelCall(f.store, f.call()));
  const e4 = reference(f.store.get(applied.record.id)!);
  // The managed finalizer never closes A3 itself (E7).
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const before = mechanismSnapshot(f.store);
  const omitted = refusalOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome() }));
  assert.deepEqual([omitted.code, omitted.at.field], ["completion_invalid", "accepting"]);
  assert.deepEqual(mechanismSnapshot(f.store), before);
  const closed = deliveredOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome({ accepting: [e4] }) }));
  assert.equal(closed.verdict, "progress");
  const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome!;
  const keys = f.batch.items.map(item => m5Key(f, item.target)).sort();
  assert.deepEqual(saved.achieved.map(item => item.key).sort(), keys);
  const close = f.store.list().find(record => record.kind === "om-completion-close")!;
  const report = deliveredOf(spendReport(f.store, { project: f.project }));
  f.restart();
  const byKey = (items: readonly { key: string; basis: Ref }[]) => [...items].map(item => canonical(item)).sort();
  assert.deepEqual(byKey(deliveredOf(readCompletionCloseAt(f.store, f.project, reference(close))).outcome.achieved), byKey(saved.achieved));
  const row = report.rows.find(item => item.result !== null)!;
  assert.deepEqual(row.result!.achieved.map(item => item.key).sort(), keys);
  assert.deepEqual(deliveredOf(readSpendReport(f.store, report.snapshot)), report);
});

/**
 * №1449 §7, №1688-13 (C10, C22, E8, E9): supported E5 with its D5 stops before G7; D3 and D2 then close its line while
 * the attempt is open; G7 confirms each basis of the shared key through its own provider, and the pair keeps one
 * canonical minimum in any order — checked on the unwritten prepared close (T48, №2590). The supported-E5 attempt
 * must keep every supported E5 fact in accepting, so the D2 variant is proved on the next attempt, whose supported
 * set is empty: it closes offering the D2 basis alone, its provider proves it, and the close repeats exactly after a
 * new Store. Note (№2619): the E5 repeat and consumption below read the representative saved on the E5 fact's own
 * attempt — attempt 2 — so the D2 variant does not exercise the D2 branch of the product repeat path; that coverage
 * lives in the seeded net test right after these two.
 */
async function representativeAttempt(t: test.TestContext, variant: "D2" | "D5"): Promise<void> {
  const f = e51Fixture(t, false), first = await f.original();
  const at = { project: f.project, block: f.block, line: 1 };
  deliveredOf(closeAttempt(f.store, { ...at, attempt: 1, outcome: outcome() }));
  const secondSeries = deliveredOf(openAttempt(f.store, { ...at, attempt: 2, goal: f.attemptGoal }));
  const oldRoutes = f.store.list<RoutesRecord>("route-result")[0]!;
  const priorRoutes = oldRoutes.value.request;
  const routes = deliveredOf(writeRoutes(f.store, { project: f.project, gaps: priorRoutes.gaps,
    tasks: priorRoutes.tasks.map(record => ({ record })), catalog: priorRoutes.catalog, previous: reference(oldRoutes) }));
  const batch = routes.value.batches.find(row => row.model === "MC1" && row.items.some(item => item.gap === first.questionId));
  assert.ok(batch);
  const packet = deliveredOf(writeQuestionPacket(f.store, { project: f.project, routes: reference(routes),
    batch: batch.id, environment: reference(f.config), attempt: { series: reference(secondSeries), ordinal: 2 }, previous: [] })).record;
  writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep, f.originalStep, e51AssessorStep("supported")] }));
  const model = deliveredOf(await runModelCall(f.store, { project: f.project, packet: reference(packet), dispatch: first.dispatch, role: "implementer" }));
  const second = { ...first, modelCall: reference(model.record) };
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before G7");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => assessFact(f.store, second), /stop before G7/); }
  finally { f.store.writeMany = originalWrite; }
  const terminal = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)[0]!;
  const e5 = terminal.value.accepted!;
  const e5Fact = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: e5 }));
  // O12: an applied E4 of another kind (this MC1 call) is no M5 addressing, whatever owner names it.
  assert.equal(refusalOf(confirmResults(f.store, { project: f.project, owner: m5Owner, target: f.series.id, goal: f.attemptGoal,
    attempt: { series: reference(secondSeries), ordinal: 2 }, accepting: [reference(model.record)], cancelling: [] })).code, "achievement_unconfirmed");
  // D3 and D2 consume the supported E5 while its attempt is still open.
  const mc1 = f.store.get<Mc1QuestionRecord>(deliveredOf(readAssessmentIntentAt(f.store, f.project, terminal.value.intent)).question.record.id)!;
  const prior = mc1.value.request.gaps;
  const initial = deliveredOf(writeGapLines(f.store, { project: f.project, previous: null, pass: 1, gaps: prior, closures: [] }));
  const applied = deliveredOf(writeApplyAnswer(f.store, { project: f.project, input: mc1.value.request.input, answer: e5, question: reference(mc1) }));
  const horizon = deliveredOf(writeHorizon(f.store, { project: f.project, input: reference(applied), graph: prior.sources.graph,
    refinement: null, available: {}, choice: { choiceVersion: "t48-fixed", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { ...structuredClone(prior.sources), input: reference(applied), horizon: reference(horizon.gate),
    operations: { ...structuredClone(prior.sources.operations), frame: { ...structuredClone(prior.sources.operations.frame), horizon: reference(horizon.gate) } } };
  const gaps = deliveredOf(writeGaps(f.store, sources));
  const current: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const answerAttempt = { series: e5Fact.attempt!.series, attempt: e5Fact.attempt!.ordinal };
  const closure = { id: e5Fact.gap.id, reason: "filled" as const, basis: e5, acceptance: null, attempt: answerAttempt, answer: { record: e5 } };
  const lines = deliveredOf(writeGapLines(f.store, { project: f.project, previous: reference(initial), pass: 2, gaps: current, closures: [closure] }));
  const d2 = reference(lines);
  // The pair of bases in any order: one result and one canonical minimum — checked on the prepared close, unwritten.
  const pairClose = (accepting: Ref[]) => prepareCloseAttempt(f.store, { ...at, attempt: 2, outcome: outcome({ accepting }) });
  const forward = deliveredOf(pairClose([e5, d2])), reversed = deliveredOf(pairClose([d2, e5]));
  assert.deepEqual(reversed.writes, forward.writes, "the aggregate and its canonical representative cannot depend on caller order");
  const aggregate = (forward.writes.find(write => write.id === f.series.id)!.value as RepairSeries).attempts[1]!.outcome!;
  assert.deepEqual(aggregate.achieved.map(item => item.key), [e5Fact.key]);
  assert.equal(canonical(aggregate.achieved[0]!.basis), [canonical(e5), canonical(d2)].sort()[0]);
  // The supported E5 cycle closes on its own attempt with its supported basis: accepting's E5 part must
  // be exactly the supported set, so the scenario's D2 close belongs to the next attempt (an empty
  // supported set) — both representatives are deterministic by exact Ref, no hash order involved.
  const closing2 = { ...at, attempt: 2, outcome: outcome({ accepting: [e5] }) };
  deliveredOf(closeAttempt(f.store, closing2));
  const saved2 = f.store.get<RepairSeries>(f.series.id)!.value.attempts[1]!.outcome!;
  assert.deepEqual(saved2.achieved, [{ key: e5Fact.key, basis: e5 }]);
  const chosen = variant === "D2" ? d2 : e5;
  assert.ok(chosen.id.startsWith("om-gap-line") === (variant === "D2"), "the chosen basis is in the expected namespace");
  let saved = saved2, closing = closing2, ordinal = 2;
  if (variant === "D2") {
    deliveredOf(openAttempt(f.store, { ...at, attempt: 3, goal: f.attemptGoal }));
    closing = { ...at, attempt: 3, outcome: outcome({ accepting: [d2] }) };
    deliveredOf(closeAttempt(f.store, closing));
    saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[2]!.outcome!;
    ordinal = 3;
  }
  assert.deepEqual(saved.achieved, [{ key: e5Fact.key, basis: chosen }]);
  // Each basis proves the same semantic key through its own provider in the named attempt context
  // (for the D2 variant d2 was accepted on attempt 3; for the D5 variant it is checked in attempt 2's context).
  const contextOf = (attemptOrdinal: number) => ({ project: f.project, block: f.block, goal: f.attemptGoal,
    attempt: { series: reference(f.store.get<RepairSeries>(f.series.id)!), ordinal: attemptOrdinal }, accepting: [e5, d2] });
  assert.equal(acceptanceRepresents(f.store, contextOf(2), e5, e5Fact.key), true);
  assert.equal(acceptanceRepresents(f.store, contextOf(ordinal), d2, e5Fact.key), true);
  const confirmation = { project: f.project, basis: { record: e5 }, target: e5Fact.gap.target, field: e5Fact.gap.field,
    prior, current, attempt: answerAttempt, currentOnly: true };
  const repeat = async () => {
    assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent)),
      { complete: true, closed: true, results: [reference(terminal)] });
    assert.deepEqual(deliveredOf(await assessFact(f.store, second)), terminal);
    assert.equal(deliveredOf(confirmAnswerGapClosure(f.store, confirmation)).key, e5Fact.key);
  };
  await repeat();
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  if (variant === "D2") assert.deepEqual(deliveredOf(closeAttempt(f.store, closing2)).attempt, 2);
  assert.deepEqual(deliveredOf(closeAttempt(f.store, closing)).attempt, ordinal);
  await repeat();
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
}
test("C22 C2 C10 C12 O12 E8 E9 H1.0d an attempt whose supported set is empty closes on the D2 basis of the equal key, its provider proves it, and the close repeats exactly after a restart",
  t => representativeAttempt(t, "D2"));
test("C22 C2 C10 C12 O12 E8 E9 H1.0d the E5 repeat and its consumption accept the D5 representative saved on the equal key, after restart too",
  t => representativeAttempt(t, "D5"));

/**
 * №1688-13 opportunistic net (T48, №2619-B): the two product places that read the saved representative of the E5
 * fact's own attempt — the repeat in finishAssessmentAttempt and the consumption in currentAcceptedAttempt — take
 * the D2 provider branch only when the canonical minimum of the pair happens to be the D2 record. Neither a fixed
 * order nor a lone [d2] close on that attempt is lawful, so the old scenario is run under a seeded search: bounded
 * to 12 choiceVersion values, it stops on the first D2 win and on the first failing subtest, and skips — never
 * passes silently — when no D2 win occurs.
 */
async function d2RepresentedAttempt(t: test.TestContext, choice: string): Promise<"D2" | "D5"> {
  const f = e51Fixture(t, false), first = await f.original();
  const at = { project: f.project, block: f.block, line: 1 };
  deliveredOf(closeAttempt(f.store, { ...at, attempt: 1, outcome: outcome() }));
  const secondSeries = deliveredOf(openAttempt(f.store, { ...at, attempt: 2, goal: f.attemptGoal }));
  const oldRoutes = f.store.list<RoutesRecord>("route-result")[0]!;
  const priorRoutes = oldRoutes.value.request;
  const routes = deliveredOf(writeRoutes(f.store, { project: f.project, gaps: priorRoutes.gaps,
    tasks: priorRoutes.tasks.map(record => ({ record })), catalog: priorRoutes.catalog, previous: reference(oldRoutes) }));
  const batch = routes.value.batches.find(row => row.model === "MC1" && row.items.some(item => item.gap === first.questionId));
  assert.ok(batch);
  const packet = deliveredOf(writeQuestionPacket(f.store, { project: f.project, routes: reference(routes),
    batch: batch.id, environment: reference(f.config), attempt: { series: reference(secondSeries), ordinal: 2 }, previous: [] })).record;
  writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep, f.originalStep, e51AssessorStep("supported")] }));
  const model = deliveredOf(await runModelCall(f.store, { project: f.project, packet: reference(packet), dispatch: first.dispatch, role: "implementer" }));
  const second = { ...first, modelCall: reference(model.record) };
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === "repair-series" && write.id === f.series.id && write.expected > 0))
      throw new Error("stop before G7");
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => assessFact(f.store, second), /stop before G7/); }
  finally { f.store.writeMany = originalWrite; }
  const terminal = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND)[0]!;
  const e5 = terminal.value.accepted!;
  const e5Fact = deliveredOf(readAcceptedAnswer(f.store, { project: f.project, record: e5 }));
  // O12: an applied E4 of another kind (this MC1 call) is no M5 addressing, whatever owner names it.
  assert.equal(refusalOf(confirmResults(f.store, { project: f.project, owner: m5Owner, target: f.series.id, goal: f.attemptGoal,
    attempt: { series: reference(secondSeries), ordinal: 2 }, accepting: [reference(model.record)], cancelling: [] })).code, "achievement_unconfirmed");
  // D3 and D2 consume the supported E5 while its attempt is still open.
  const mc1 = f.store.get<Mc1QuestionRecord>(deliveredOf(readAssessmentIntentAt(f.store, f.project, terminal.value.intent)).question.record.id)!;
  const prior = mc1.value.request.gaps;
  const initial = deliveredOf(writeGapLines(f.store, { project: f.project, previous: null, pass: 1, gaps: prior, closures: [] }));
  const applied = deliveredOf(writeApplyAnswer(f.store, { project: f.project, input: mc1.value.request.input, answer: e5, question: reference(mc1) }));
  const horizon = deliveredOf(writeHorizon(f.store, { project: f.project, input: reference(applied), graph: prior.sources.graph,
    refinement: null, available: {}, choice: { choiceVersion: choice, features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { ...structuredClone(prior.sources), input: reference(applied), horizon: reference(horizon.gate),
    operations: { ...structuredClone(prior.sources.operations), frame: { ...structuredClone(prior.sources.operations.frame), horizon: reference(horizon.gate) } } };
  const gaps = deliveredOf(writeGaps(f.store, sources));
  const current: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const answerAttempt = { series: e5Fact.attempt!.series, attempt: e5Fact.attempt!.ordinal };
  const closure = { id: e5Fact.gap.id, reason: "filled" as const, basis: e5, acceptance: null, attempt: answerAttempt, answer: { record: e5 } };
  const lines = deliveredOf(writeGapLines(f.store, { project: f.project, previous: reference(initial), pass: 2, gaps: current, closures: [closure] }));
  const d2 = reference(lines);
  // G7 confirms both through their providers; the canonical minimum of the full Ref represents the shared key.
  const closing = { ...at, attempt: 2, outcome: outcome({ accepting: [e5, d2] }) };
  deliveredOf(closeAttempt(f.store, closing));
  const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[1]!.outcome!;
  assert.deepEqual(saved.achieved.map(item => item.key), [e5Fact.key]);
  const representative = saved.achieved[0]!.basis.id.startsWith("om-gap-line") ? "D2" : "D5";
  assert.equal(canonical(saved.achieved[0]!.basis), [canonical(e5), canonical(d2)].sort()[0]);
  const context = { project: f.project, block: f.block, goal: f.attemptGoal,
    attempt: { series: reference(f.store.get<RepairSeries>(f.series.id)!), ordinal: 2 }, accepting: [e5, d2] };
  assert.equal(acceptanceRepresents(f.store, context, saved.achieved[0]!.basis, e5Fact.key), true);
  const confirmation = { project: f.project, basis: { record: e5 }, target: e5Fact.gap.target, field: e5Fact.gap.field,
    prior, current, attempt: answerAttempt, currentOnly: true };
  const repeat = async () => {
    assert.deepEqual(deliveredOf(finishAssessmentAttempt(f.store, f.project, terminal.value.intent)),
      { complete: true, closed: true, results: [reference(terminal)] });
    assert.deepEqual(deliveredOf(await assessFact(f.store, second)), terminal);
    assert.equal(deliveredOf(confirmAnswerGapClosure(f.store, confirmation)).key, e5Fact.key);
  };
  await repeat();
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.deepEqual(deliveredOf(closeAttempt(f.store, closing)).attempt, 2);
  await repeat();
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, sends);
  return representative;
}
test("C22 C2 C10 C12 O12 E8 E9 H1.0d when the pair's canonical minimum is the D2 basis, the E5 repeat and its consumption prove it through its own provider (seeded search)", async t => {
  let covered = false, failed = false;
  for (const seed of Array.from({ length: 12 }, (_, index) => `t48-net-${index}`)) {
    if (covered || failed) break;
    await t.test(seed, async child => {
      try { covered = (await d2RepresentedAttempt(child, seed)) === "D2"; }
      catch (error) { failed = true; throw error; }
    });
  }
  if (!covered && !failed) t.skip("a D2 canonical minimum did not occur in 12 seeded fixtures");
});

test("C6 C7 H1.0d the key is the semantic addressing: another accepted kind is another result, the call and revisions are not", async t => {
  const keys: string[][] = [];
  for (const kind of ["repository-fact", "owner-decision"]) await t.test(kind, async child => {
    const f = m5Fixture(child);
    f.steps([f.answer(undefined, kind)]);
    const e4 = reference(deliveredOf(await runModelCall(f.store, f.call())).record);
    keys.push(deliveredOf(confirmResults(f.store, { ...m5Context(f), accepting: [e4] })).achieved.map(item => item.key).sort());
  });
  assert.equal(keys.length, 2);
  assert.equal(keys[0]!.length, 2); assert.equal(keys[1]!.length, 2);
  assert.ok(keys[0]!.every(key => !keys[1]!.includes(key)), "a different accepted kind is a different addressing result");
});

test("O9 O17 H1.0d owner control accepts no addressing: the standalone finish keeps its own reason when no call of the attempt applied one", async t => {
  const f = m5Fixture(t);
  f.steps([{ research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: [f.batch.items[0]!.gap],
    action: "need_owner", reason: "The consumer is the owner's choice", decision: "Choose the consumer" } }]);
  const sent = await runModelCall(f.store, f.call());
  const e4 = reference(f.store.list("model-call")[0]!);
  const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome!;
  assert.ok(saved, `the owner-control finish closes the standalone attempt (${sent.ok ? "applied" : sent.refusal.code})`);
  assert.deepEqual([saved.reason, saved.achieved], ["awaiting-owner", []]);
  assert.equal(refusalOf(confirmResults(f.store, { ...m5Context(f), accepting: [e4] })).code, "achievement_unconfirmed");
  f.restart();
  assert.ok(readModelCallState(f.store, { project: f.project, record: e4 }).ok);
});

/** Stops a real dispatch after its E1 and before its E4 claim (the review probe of №1704). */
async function m5CallWithoutE4(f: ReturnType<typeof m5Fixture>, request: ModelCallRequest): Promise<void> {
  const original = f.store.writeMany.bind(f.store);
  let stop = true;
  f.store.writeMany = ((writes, guards) => {
    if (stop && writes.some(write => write.kind === "model-call")) { stop = false; throw new Error("stop before E4 claim"); }
    return original(writes, guards);
  }) as Store["writeMany"];
  try { await assert.rejects(() => runModelCall(f.store, request), /stop before E4 claim/); }
  finally { f.store.writeMany = original; }
}
test("C15 H1.0d a close prepared before the first E1 guards the absent ledger: the later applied M5 result fails it", async t => {
  const f = m5Fixture(t);
  f.steps([f.answer()]);
  const request = f.call();
  const prepared = deliveredOf(prepareCloseAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome() }));
  assert.ok(prepared.guards.some(guard => "absent" in guard && guard.id === callLedgerId(f.project)));
  assert.equal(deliveredOf(await runModelCall(f.store, request)).outcome?.kind, "input-decisions");
  const second = new Store(f.database); t.after(() => second.close());
  const written = writeGuarded(second, { unit: "G7", target: f.series.id, writes: [...prepared.writes], guards: [...prepared.guards] });
  assert.equal(written.ok, false, "the prepared no-result close must not erase a subsequently applied M5 result");
  assert.equal(second.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
});
test("C15 H1.0d an E1 without E4 guards the absence of its E4, which unknown usage never settles in the ledger", async t => {
  const f = m5Fixture(t);
  f.steps([f.answer()]);
  const request = f.call();
  await m5CallWithoutE4(f, request);
  assert.equal(f.store.list("model-call").length, 0); assert.equal(f.store.list("call-record").length, 1);
  const prepared = deliveredOf(prepareCloseAttempt(f.store, { ...f.address, attempt: 1, outcome: outcome() }));
  assert.ok(prepared.guards.some(guard => "absent" in guard && guard.id.startsWith(`model-call:${f.project}:om:`)));
  const ledgerBefore = reference(f.store.list(CALL_LEDGER_KIND)[0]!);
  assert.equal(deliveredOf(await runModelCall(f.store, request)).outcome?.kind, "input-decisions");
  assert.deepEqual(reference(f.store.list(CALL_LEDGER_KIND)[0]!), ledgerBefore, "unknown usage leaves the E1 ledger unchanged");
  const second = new Store(f.database); t.after(() => second.close());
  const written = writeGuarded(second, { unit: "G7", target: f.series.id, writes: [...prepared.writes], guards: [...prepared.guards] });
  assert.equal(written.ok, false, "the exact absence of the E4 guards the close");
});
test("C15 C43 H1.0d the public finish entry carries the absence of another admitted E4: it finishes without that call, fails in the window, keeps its later K", async t => {
  const finishOf = (f: ReturnType<typeof m5Fixture>, request: ModelCallRequest) => {
    const requestId = f.store.get<{ packet: { requestId: string } }>(request.packet.id, request.packet.revision)!.value.packet.requestId;
    const call = f.store.list<{ call: string }>("call-record").find(record => record.value.call === requestId)!;
    return { project: f.project, packet: request.packet, call: reference(call), response: null,
      code: "model_no_progress", message: "The addressed reads add no information to this attempt", reason: "refused" as const };
  };
  // The finishing call B was admitted on the older environment; the other call A on the current one, both before E4.
  const scenario = async (child: test.TestContext) => {
    const f = m5Fixture(child);
    f.steps([f.answer()]);
    const b = f.call();
    await m5CallWithoutE4(f, b);
    const a = f.call(f.environment(90_000));
    await m5CallWithoutE4(f, a);
    return { f, a, finish: finishOf(f, b) };
  };
  await t.test("without a competing write the finish completes and never dispatches the other call", async child => {
    const { f, finish } = await scenario(child);
    const prepared = deliveredOf(prepareModelAttemptFinish(f.store, finish));
    assert.ok(prepared.guards.some(guard => "absent" in guard && guard.id.startsWith(`model-call:${f.project}:om:`)));
    deliveredOf(finishModelAttempt(f.store, finish));
    const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome!;
    assert.deepEqual([saved.reason, saved.achieved], ["refused", []]);
    assert.equal(f.store.list("model-call").length, 0);
    const before = mechanismSnapshot(f.store);
    f.restart();
    assert.deepEqual(deliveredOf(prepareModelAttemptFinish(f.store, finish)).writes, [], "the repeat does not depend on today's absence");
    assert.deepEqual(mechanismSnapshot(f.store), before);
  });
  await t.test("an E4 applied with unknown usage in the window fails the prepared finish atomically; a fresh finish keeps its K", async child => {
    const { f, a, finish } = await scenario(child);
    const prepared = deliveredOf(prepareModelAttemptFinish(f.store, finish));
    const ledger = reference(f.store.list(CALL_LEDGER_KIND)[0]!);
    const applied = deliveredOf(await runModelCall(f.store, a));
    assert.equal(applied.outcome?.kind, "input-decisions");
    assert.deepEqual(reference(f.store.list(CALL_LEDGER_KIND)[0]!), ledger, "unknown usage settles nothing in the E1 ledger");
    const before = mechanismSnapshot(f.store);
    const second = new Store(f.database); child.after(() => second.close());
    assert.equal(writeGuarded(second, { unit: "E4", target: finish.call.id, writes: [...prepared.writes], guards: [...prepared.guards] }).ok, false);
    assert.deepEqual(mechanismSnapshot(f.store), before, "no partial diagnostic, journal or A3");
    deliveredOf(finishModelAttempt(f.store, finish));
    const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome!;
    assert.equal(saved.reason, "result");
    assert.deepEqual(saved.achieved.map(item => item.key).sort(), f.batch.items.map(item => m5Key(f, item.target)).sort());
    const closed = mechanismSnapshot(f.store);
    f.restart();
    assert.deepEqual(deliveredOf(prepareModelAttemptFinish(f.store, finish)).writes, []);
    assert.deepEqual(mechanismSnapshot(f.store), closed);
  });
});

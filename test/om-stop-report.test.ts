import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import { writeGuarded } from "../src/om/refs.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { ProductEngine } from "../src/product/engine.js";
import { fillObligations, prepareFrame, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { LayerProposal, ProposalRequest } from "../src/om/frame-proposals.js";
import { writeCandidate, type FrameCandidateRecord } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";

import { journalId, recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND, normalizeOriginSource } from "../src/om/refusal-journal.js";
import {
  beginAttempt, completeAttempt, escalateSeries, openSeries, ownerDecisionNamespace, resumeSeries, seriesId, stopReviewNamespace,
  COMPLETION_REASONS, REPAIR_SERIES_KIND, STOP_REVIEW_KIND, OWNER_DECISION_KIND,
  type AttemptGoal, type ClaimedOutcome, type ClaimedRefusal, type RepairSeries, type SeriesRequest,
} from "../src/om/series.js";
import {
  closeAttempt, liftOriginHold, openAttempt, originAnalysisNamespace, originDecisionNamespace, readStopContext, stopContext,
  ADDRESSEE_KINDS, ORIGIN_ANALYSIS_KIND, ORIGIN_DECISION_KIND, ORIGIN_HOLD_KIND, REFUSAL_CLASSES,
  type GateOutcome, type OriginHold, type RefusalClass, type RepeatOutcome,
} from "../src/om/repeat-gate.js";
import {
  checkStanding, stopReport,
  CLAIM_SUBJECTS, REMEDY_KINDS, REPORT_AUDIENCES, STOP_REPORT_CODES, STOP_SUBJECTS, STOP_SUBJECT_DECISIONS, STOP_SUBJECT_DECISIONS_V2, REMEDY_OUTCOMES,
  type StopFacts, type StopReport,
} from "../src/om/stop-report.js";

const UNIT = "om-stop-report";
const PROJECT = "alpha";
const BLOCK = "block:cart";
const SLICE = "slice:cart@1";
const SUBJECT = "artifact:cart";
const typedDefect = (error: unknown): boolean =>
  error instanceof EngineError
  && ["stop_report_invalid", "repeat_request_invalid", "series_request_invalid", "journal_request_invalid"].includes(error.code);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-om-report-"));
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
const definitionFixtures = new WeakMap<Store, Map<string, { first: FrameRequest; accepted: FrameRequest; upper: Graph; subject: string }>>();
const sourceContexts = new Map<string, Record<string, unknown>>();
function remember(ref: Ref, context: Record<string, unknown>): Ref {
  sourceContexts.set(`${ref.id}@${ref.revision}@${ref.hash}`, context); return ref;
}
function definitionFixture(store: Store, project: string, subject = SUBJECT) {
  const cache = definitionFixtures.get(store) ?? new Map(); definitionFixtures.set(store, cache);
  const previous = cache.get(project); if (previous) return previous;
  const graph = gardenGraph("standard", project);
  const oldArtifact = `${project}-prep`;
  graph.artifacts.find(item => item.id === oldArtifact)!.id = subject;
  for (const node of graph.nodes) if (node.outcome === oldArtifact) node.outcome = subject;
  for (const connector of graph.connectors) if (connector.artifact === oldArtifact) connector.artifact = subject;
  const { level: _level, ...upper } = projectGraph(graph, 1);
  preparedFeatures(new ProductEngine(store), project, upper as Graph);
  const input = deliveredOf(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const horizon = deliveredOf(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, choice: { choiceVersion: "origin-initial", features: [{ outcome: `${project}-result` }], excluded: [] }, available: {} }));
  const first: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!),
    horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
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
  const built = { first, accepted, upper: upper as Graph, subject }; cache.set(project, built); return built;
}

/** Every named source belongs to this one explicit saved assembly, including its complete proposal set. */
function assembly(store: Store, project: string, base: "first" | "accepted",
  proposalDefinitions: readonly (readonly string[])[], derivedDefinitions: readonly string[]) {
  const f = definitionFixture(store, project), frame = f[base];
  const artifacts = (definitions: readonly string[]) => definitions.map(id => ({ ...structuredClone(f.upper.artifacts[0]!), id }));
  const proposals = proposalDefinitions.map(definitions => {
    const value: LayerProposal = { base: { graph: frame.graph, frame: frame.frame }, level: 2, source: "decision", status: "proposed",
      nodes: [], fills: [], localConnectors: [], artifacts: artifacts(definitions), contracts: [], joins: [], tests: [], edges: [], journeys: [], packets: [],
      transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
    return reference(store.write({ id: `om-proposal:${project}:${next()}`, kind: "layer-proposal", expected: 0, value }));
  });
  const request: ProposalRequest = { frame, proposals };
  for (const ref of proposals) remember(ref, { kind: "proposal", request });
  const graph = structuredClone(store.get<Graph>(frame.graph.id, frame.graph.revision)!.value);
  graph.artifacts = [...graph.artifacts.filter(item => !derivedDefinitions.includes(item.id)), ...artifacts(derivedDefinitions)];
  const value: FrameCandidateRecord = { project, level: 2, graph, graphHash: hashJson(graph), layerHash: hashJson(projectGraph(graph, 2)),
    upperHash: hashJson(projectGraph(f.upper, 1)), base: { graph: frame.graph, frame: frame.frame }, proposals, fills: [], request };
  const id = `om-candidate:${project}:${hashJson([value.graphHash, value.base, value.proposals])}`;
  const candidate = reference(store.get(id) ?? store.write({ id, kind: "frame-candidate", expected: 0, value }));
  const proposalSources = proposals.map(ref => source("proposal", ref));
  return { proposalSources, sources: [...proposalSources, source("base", frame.graph), source("derived", candidate)] };
}

const source = (role: string, ref: Ref): Record<string, unknown> => {
  const context = sourceContexts.get(`${ref.id}@${ref.revision}@${ref.hash}`);
  return { role, ref, ...(context ? { context } : {}) };
};

/** A refusal a gate really wrote, journalled through the accepted API of A2, with the origin G7 weighs. */
function journalled(store: Store, project: string, origin: Record<string, unknown> = {}, over: Record<string, string> = {}): ClaimedRefusal {
  const name = over['code'] ?? `graph_invalid:${next()}`;
  const goalText = over['goal'] ?? "every artifact an operation consumes is produced somewhere in the layer";
  const record = store.write({
    id: `${unitRefusalNamespace(project)}g:${next()}`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: {
      gate: over['gate'] ?? "G3",
      refusals: [{
        code: name, goal: goalText, remedy: over['remedy'] ?? "add the producer of the artifact to the proposal",
        origin: { name: "artifact_missing", stage: "layer-check", subject: SUBJECT, sources: [], ...origin },
      }],
    } as Json,
  });
  const journal = deliveredOf(recordRefusal(store, { project, source: reference(record) }));
  return { name, goal: goalText, row: journal.value.rows[journal.value.rows.length - 1]!.id };
}

/** The refusal of the rules' own example, in the shapes whose origin places them. */
function artifactMissing(store: Store, project: string, shape: "proposal" | "input"): ClaimedRefusal {
  if (shape === "proposal") {
    return journalled(store, project, {
      sources: assembly(store, project, "first", [["artifact:tax"]], ["artifact:tax"]).sources,
    });
  }
  return journalled(store, project, {
    sources: assembly(store, project, "accepted", [], [SUBJECT]).sources,
  });
}

/** A refusal of the CONDITIONS: the feasibility check stood on the repository and the environment, not on the map. */
const conditionsRefusal = (store: Store, project: string): ClaimedRefusal => journalled(store, project, {
  stage: "feasibility", subject: "worktree:cart",
  sources: [source("environment", reference(store.write({
    id: `om-workspace:${project}:${next()}`, kind: "om-workspace", expected: 0, value: { worktree: "detached, and the executor is gone" } as Json,
  })))],
});

/** A refusal whose origin names nothing to weigh it against: G7 establishes none, and holds it for analysis. */
const unplacedRefusal = (store: Store, project: string): ClaimedRefusal => journalled(store, project, { sources: [] });

const goal = (over: Partial<AttemptGoal> = {}): AttemptGoal => ({
  key: "gap:cart:price",
  questions: ["which node produces the price of a cart line?"],
  result: "an accepted layer proposal naming the producer",
  ...over,
});

const outcome = (over: Partial<GateOutcome> = {}): GateOutcome =>
  ({ reason: "result", accepting: [], cancelling: [], refusals: [], ...over }) as GateOutcome;

const refusedBy = (...refusals: readonly ClaimedRefusal[]): GateOutcome =>
  outcome({ reason: "refused", refusals: [...refusals] });

function opened(store: Store, project = PROJECT, line = 1) {
  return deliveredOf(openSeries(store, { ...address(project, line), slice: SLICE, predecessor: null, basis: null }));
}

const heldSeries = (store: Store, project = PROJECT, line = 1): Revision<RepairSeries> | null =>
  store.get<RepairSeries>(at(project, line));

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

/** The record of an analysis of a stop — what A6 will write, and all this unit reads of it. */
const reviewValue = (project: string, stop: number, goals: readonly string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId: project, block: BLOCK, stop, goals: [...goals],
  reviewer: { name: "a reviewer who is not the executor", independent: true },
  cause: "the same question goes to the same producer every cycle",
  change: { text: "ask M5 to address the gap before a layer is proposed", addresses: ["M5"] },
  ...over,
});

const storedAs = (store: Store, kind: string, id: string, value: Record<string, unknown>): Ref =>
  reference(store.write({ id, kind, expected: 0, value: value as Json }));

const storedReview = (store: Store, project: string, value: Record<string, unknown>): Ref =>
  storedAs(store, STOP_REVIEW_KIND, `${stopReviewNamespace(project)}${next()}`, value);

/** A series stopped after its third cycle without progress, every cycle refused by the SAME refusal of the input. */
function stoppedAtThree(store: Store, project = PROJECT): { refusal: ClaimedRefusal; stopped: RepeatOutcome } {
  opened(store, project);
  const refusal = artifactMissing(store, project, "input");
  closed(store, project, goal(), refusedBy(refusal));
  closed(store, project, goal(), refusedBy(refusal));
  const stopped = closed(store, project, goal(), refusedBy(refusal));
  assert.equal(stopped.stop!.attempt, 3);
  return { refusal, stopped };
}

/** Rewrites the record of a series by hand — the rival nobody's API would let through. */
function forgeSeries(store: Store, project: string, change: (held: RepairSeries) => Record<string, unknown>, line = 1): void {
  const held = heldSeries(store, project, line)!;
  store.write({ id: held.id, kind: REPAIR_SERIES_KIND, expected: held.revision, value: change(held.value) as unknown as Json });
}

const reportOf = (store: Store, project = PROJECT, line = 1): StopReport => deliveredOf(stopReport(store, address(project, line)));

// ---------------------------------------------------------------------------

test("the explanation of a stop is assembled by code from the records, and both rungs are handed the SAME context", t => {
  const { store, path } = fixture(t);
  const { refusal, stopped } = stoppedAtThree(store);

  const report = reportOf(store);
  assert.equal(report.series, at(PROJECT));
  assert.equal(report.project, PROJECT);
  assert.equal(report.block, BLOCK);
  assert.equal(report.line, 1);
  // The rung and the audience are the SERIES' finding, reported here and derived again nowhere.
  assert.equal(report.rung, 1);
  assert.equal(report.audience, "reviewer");
  assert.equal(report.rung, heldSeries(store)!.value.ladder.rung);
  // One and the same context: the one the gate assembles, handed on without a second assembly of its own.
  assert.deepEqual(report.context, deliveredOf(stopContext(store, address(PROJECT))));
  assert.deepEqual(report.context.stop, stopped.stop);

  // The subject of the stop: one obstacle, met by all three cycles, with the one responsible its class gave it.
  assert.equal(report.finding.subject, "obstacle");
  assert.ok(report.finding.addressee!.startsWith(`${ADDRESSEE_KINDS.input}:`));
  assert.deepEqual(report.finding.rows, [refusal.row]);
  assert.equal(report.finding.facts.attempts, 3);
  assert.equal(report.finding.facts.obstacles, 1);
  assert.equal(report.finding.facts.repeating, 1);
  assert.equal(report.finding.facts.classes.input, 1);
  assert.equal(report.finding.facts.addressees, 1);
  assert.equal(report.finding.facts.accepted, 0);
  assert.equal(report.finding.facts.endings.refused, 3);
  assert.deepEqual(report.remedies, []);
  assert.deepEqual(report.proposed, []);

  // The explanation says what the rules ask for, and nothing in it is anybody's invention.
  const text = report.lines.join("\n");
  assert.ok(text.includes("gap:cart:price"));                            // the goals that were named
  assert.ok(text.includes("Accepted results of these goals: none."));    // what was accepted
  assert.ok(text.includes(refusal.row) && text.includes("met by 3"));    // the refusals that repeat
  assert.ok(text.includes(report.finding.addressee!));                   // the address and the responsible
  assert.ok(text.includes("attempt 3 — refused"));                       // why the cycles ended
  assert.ok(text.includes("Proposed change: none is on record."));
  assert.ok(text.includes(report.context.stop!.resume));

  // Every record read is named at the exact revision it was read at, for whoever writes on this explanation (T7).
  const series = heldSeries(store)!;
  assert.ok(report.guards.some(ref => ref.id === series.id && ref.revision === series.revision && ref.hash === series.hash));
  assert.equal(new Set(report.guards.map(ref => ref.id)).size, report.guards.length);
  assert.ok(deeplyFrozen(report));

  // The same records give the same explanation, byte for byte, after a restart: nothing outside them is consulted.
  store.close();
  const back = new Store(path);
  t.after(() => back.close());
  assert.deepEqual(reportOf(back), report);
  assert.equal(hashJson(reportOf(back) as unknown as Json), hashJson(report as unknown as Json));
});

test("a stop the environment broke off is explained as a failure of the ENVIRONMENT, not of the product", t => {
  const { store } = fixture(t);
  // Three cycles broken off, and not one refusal of the product recorded.
  opened(store);
  for (let index = 0; index < 3; index += 1) closed(store, PROJECT, goal(), outcome({ reason: "interrupted" }));
  assert.equal(heldSeries(store)!.value.stop!.attempt, 3);

  const broken = reportOf(store);
  assert.equal(broken.finding.subject, "environment");
  assert.equal(broken.finding.addressee, `${ADDRESSEE_KINDS.conditions}:${at(PROJECT)}`);
  assert.equal(broken.finding.facts.endings.interrupted, 3);
  assert.ok(broken.finding.text.includes("ENVIRONMENT"));
  assert.ok(broken.finding.text.includes("not by the construction of the product"));
  assert.ok(broken.lines.join("\n").includes(broken.finding.addressee!));
  // "Interrupted" is a cause of ending, and this unit says nothing about the construction of the product for it.
  assert.equal(broken.finding.rows.length, 0);

  // The same when the refusals themselves are refusals of the CONDITIONS — repository, workspace, executor.
  opened(store, "beta");
  const conditions = conditionsRefusal(store, "beta");
  for (let index = 0; index < 3; index += 1) closed(store, "beta", goal(), refusedBy(conditions), 1);
  const owned = reportOf(store, "beta");
  assert.equal(owned.finding.subject, "environment");
  assert.deepEqual(owned.finding.rows, [conditions.row]);
  assert.equal(owned.finding.facts.classes.conditions, 1);
  assert.equal(owned.finding.addressee, `${ADDRESSEE_KINDS.conditions}:${at("beta")}`);
  assert.ok(owned.finding.text.includes("repository"));

  // Neither explanation blames the construction of the product, and neither names a responsible of the product.
  for (const report of [broken, owned]) {
    assert.equal(report.finding.text.includes(`${ADDRESSEE_KINDS.input}:`), false);
    assert.equal(report.finding.text.includes(`${ADDRESSEE_KINDS.proposal}:`), false);
  }
});

test("a cause the records do not establish is written down as NOT established, with the known facts", t => {
  const { store } = fixture(t);
  opened(store);
  // Two obstacles of two classes with two responsibles, and a cycle that came back off-form: nothing is singled out.
  closed(store, PROJECT, goal(), refusedBy(artifactMissing(store, PROJECT, "input")));
  closed(store, PROJECT, goal(), refusedBy(artifactMissing(store, PROJECT, "proposal")));
  closed(store, PROJECT, goal(), outcome({ reason: "off-form" }));

  const report = reportOf(store);
  assert.equal(report.finding.subject, "unknown");
  assert.equal(report.finding.addressee, null);
  assert.equal(report.finding.facts.addressees, 2);
  assert.ok(report.finding.text.includes("NOT established"));
  assert.ok(report.finding.text.includes("none is invented"));
  // Not established is not empty: the known facts travel with it, and so do the obstacles themselves.
  assert.equal(report.finding.rows.length, 2);
  assert.ok(report.finding.text.includes("3 cycle(s) ended in the window"));
  assert.ok(report.finding.text.includes("2 responsible(s) named"));
  assert.equal(report.context.repeated.length, 2);
  const text = report.lines.join("\n");
  assert.ok(text.includes("attempt 3 — off-form"));
  assert.ok(text.includes("none — each of the 2 refusal(s) of the window was met by one cycle only"));

  // The obstacles keep the class and the addressee the GATE decided for them: this unit derives neither again.
  const journalled = new Map(report.context.repeated.map(item => [item.row, item]));
  for (const row of report.finding.rows) assert.ok(journalled.get(row)!.class !== null);

  // A refusal of the CONDITIONS beside a refusal of the product's own construction is not an environment failure:
  // the explanation would then send the owner to the environment while an obstacle of the product stands as well.
  opened(store, "gamma");
  const conditions = conditionsRefusal(store, "gamma");
  closed(store, "gamma", goal(), refusedBy(conditions));
  closed(store, "gamma", goal(), refusedBy(artifactMissing(store, "gamma", "input")));
  closed(store, "gamma", goal(), outcome({ reason: "off-form" }));
  const mixed = reportOf(store, "gamma");
  assert.equal(mixed.finding.facts.classes.conditions, 1);
  assert.equal(mixed.finding.facts.classes.input, 1);
  assert.equal(mixed.finding.subject, "unknown");
  assert.equal(mixed.finding.addressee, null);
  assert.equal(mixed.finding.text.includes("ENVIRONMENT"), false);

  // A window with no refusal at all and no cycle broken off is not an environment failure either.
  opened(store, "beta");
  for (let index = 0; index < 3; index += 1) closed(store, "beta", goal(), outcome({ reason: "off-form" }));
  const silent = reportOf(store, "beta");
  assert.equal(silent.finding.subject, "unknown");
  assert.equal(silent.finding.facts.obstacles, 0);
  assert.ok(silent.finding.text.includes("0 obstacle(s)"));
});

test("the owner is handed the analysis that was made and why it did not help, and its cause stays a VERSION", t => {
  const { store } = fixture(t);
  const { stopped } = stoppedAtThree(store);
  const first = reportOf(store);
  assert.equal(first.audience, "reviewer");

  // The reviewer of the first rung could name no cause, so the stop goes to the owner.
  const undecided = storedReview(store, PROJECT, reviewValue(PROJECT, 3, stopped.stop!.goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: undecided } }));

  const owner = reportOf(store);
  assert.equal(owner.rung, 2);
  assert.equal(owner.audience, "owner");
  // The SAME context, assembled by the same one function: the rung changes who reads it, not what it says.
  assert.deepEqual(owner.context, deliveredOf(stopContext(store, address(PROJECT))));
  assert.deepEqual(owner.context.goals, first.context.goals);
  assert.deepEqual(owner.context.repeated, first.context.repeated);

  // Beside it, the record of the analysis and why it did not help.
  assert.equal(owner.remedies.length, 1);
  const remedy = owner.remedies[0]!;
  assert.equal(remedy.after, 3);
  assert.equal(remedy.kind, "escalation");
  assert.deepEqual(remedy.records, [undecided]);
  assert.equal(remedy.outcome, "ended-undecided");
  assert.ok(remedy.explained.includes("named no cause"));
  // The record is read at the exact reference the series holds — history, not a head, so it is not guarded.
  assert.deepEqual(remedy.records[0], undecided);
  assert.equal(owner.guards.some(ref => ref.id === undecided.id), false);

  // What the reviewer named is a VERSION with the record it was said in, never a fact of this unit's.
  assert.deepEqual(remedy.claims.map(claim => claim.what), [...CLAIM_SUBJECTS]);
  assert.equal(remedy.claims.every(claim => claim.standing === "version"), true);
  assert.equal(remedy.claims.every(claim => claim.record.id === undecided.id), true);
  assert.equal(remedy.claims[0]!.stated, null);                      // no cause was named, and that is said so
  assert.deepEqual(remedy.claims[1]!.stated, { text: "ask M5 to address the gap before a layer is proposed", addresses: ["M5"] });
  assert.deepEqual(owner.proposed, [remedy.claims[1]!]);
  // The version never becomes the finding: what this unit established stands on the records alone.
  assert.equal(owner.finding.subject, "obstacle");
  assert.equal(owner.finding.text.includes("the same question goes to the same producer"), false);
  const text = owner.lines.join("\n");
  assert.ok(text.includes("as a VERSION of the reviewer who named it and not as a fact"));
  assert.ok(text.includes(undecided.id));
  assert.ok(text.includes("went to the owner"));

  // A window opened by a decided analysis that stopped again says exactly that, with the stop that closed it.
  const { stopped: second } = stoppedAtThree(store, "beta");
  const decided = storedReview(store, "beta", reviewValue("beta", 3, second.stop!.goals));
  deliveredOf(resumeSeries(store, {
    ...address("beta"), stop: 3, ground: "review-record", text: "the review named a cause and a change", review: { ref: decided },
  }));
  const again = artifactMissing(store, "beta", "input");
  for (let index = 0; index < 3; index += 1) closed(store, "beta", goal(), refusedBy(again));
  const spent = reportOf(store, "beta");
  assert.equal(spent.audience, "owner");
  assert.equal(spent.remedies.length, 1);
  assert.equal(spent.remedies[0]!.kind, "review-record");
  assert.equal(spent.remedies[0]!.outcome, "window-stopped-again");
  assert.ok(spent.remedies[0]!.explained.includes("closed in the stop after attempt 6"));
  assert.equal(spent.remedies[0]!.claims.every(claim => claim.stated !== null), true);
  assert.equal(spent.proposed.length, 1);

  // A window that has not stopped again, where a HELD origin is what stands in the way, says that instead.
  const { stopped: third } = stoppedAtThree(store, "gamma");
  const allowed = storedReview(store, "gamma", reviewValue("gamma", 3, third.stop!.goals));
  deliveredOf(resumeSeries(store, {
    ...address("gamma"), stop: 3, ground: "review-record", text: "the review named a cause and a change", review: { ref: allowed },
  }));
  closed(store, "gamma", goal(), refusedBy(unplacedRefusal(store, "gamma")));
  const held = reportOf(store, "gamma");
  assert.equal(held.context.stop, null);
  assert.equal(held.finding.subject, "origin");
  assert.equal(held.finding.addressee, held.context.holds[0]!.address);
  assert.equal(held.remedies[0]!.outcome, "standing");
  assert.ok(held.lines.join("\n").includes("only its analysis or the owner's decision lifts the hold"));
});

test("every refusal code of this unit is produced, addressed and routed", t => {
  const { store } = fixture(t);
  const seen: string[] = [];
  const record = (refusal: Refusal, expected: string, target: string): void => { seen.push(addressed(refusal, expected, target).code); };

  // An analysis the series names that does not stand at the reference the series holds.
  const { stopped } = stoppedAtThree(store, "p1");
  const gone = storedReview(store, "p1", reviewValue("p1", 3, stopped.stop!.goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address("p1"), stop: 3, review: { ref: gone } }));
  forgeSeries(store, "p1", held => ({ ...held, escalations: [{ after: 3, review: { ...gone, hash: hex("d") } }] }));
  record(refusalOf(stopReport(store, address("p1"))), "analysis_unreadable", at("p1"));

  // An analysis that stands, and whose content is not the outcome the series placed it as.
  const { stopped: second } = stoppedAtThree(store, "p2");
  const undecided = storedReview(store, "p2", reviewValue("p2", 3, second.stop!.goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address("p2"), stop: 3, review: { ref: undecided } }));
  const decided = storedReview(store, "p2", reviewValue("p2", 3, second.stop!.goals));
  forgeSeries(store, "p2", held => ({ ...held, escalations: [{ after: 3, review: decided }] }));
  record(refusalOf(stopReport(store, address("p2"))), "analysis_invalid", at("p2"));

  // A report weighed again after a record it was assembled from has moved: the stop it explained is the owner's now.
  const { stopped: third } = stoppedAtThree(store, "p3");
  const report = reportOf(store, "p3");
  const sent = storedReview(store, "p3", reviewValue("p3", 3, third.stop!.goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address("p3"), stop: 3, review: { ref: sent } }));
  record(refusalOf(checkStanding(store, report)), "report_stale", at("p3"));

  // A report the unchanged records do not give.
  stoppedAtThree(store, "p4");
  const standing = reportOf(store, "p4");
  record(refusalOf(checkStanding(store, { ...standing, lines: [...standing.lines, "and the owner agreed"] })), "report_forged", at("p4"));

  // A journal row the series names and the journal does not hold.
  stoppedAtThree(store, "p5");
  forgeSeries(store, "p5", held => ({
    ...held,
    attempts: held.attempts.map((item, index) => (index === 0
      ? { ...item, outcome: { ...item.outcome!, refusals: [{ row: "om-refusal:invented" }] } } : item)),
  }));
  record(refusalOf(stopReport(store, address("p5"))), "obstacle_unrecorded", at("p5"));

  assert.deepEqual(seen.sort(), [...STOP_REPORT_CODES].sort());
});

test("an absent argument, an absent record and an absent set are typed refusals with an address (T4)", t => {
  const { store } = fixture(t);

  // The shape of every argument is weighed before a field of it is touched or the store is read.
  for (const request of [undefined, null, "alpha", 42, [], {}, { project: PROJECT }, { project: PROJECT, block: BLOCK },
    { project: "", block: BLOCK, line: 1 }, { project: "a:b", block: BLOCK, line: 1 }, { project: PROJECT, block: BLOCK, line: "1" }]) {
    assert.throws(() => stopReport(store, request as unknown as SeriesRequest), typedDefect, String(request));
  }
  for (const broken of [undefined, null, {}, { get: () => null }]) {
    assert.throws(() => stopReport(broken as unknown as Store, address(PROJECT)), typedDefect);
    assert.throws(() => checkStanding(broken as unknown as Store, reportShape()), typedDefect);
  }

  // A series that does not stand, and one where nothing stops the work: the gate refuses both, with an address.
  const missing = refusalOf(stopReport(store, address(PROJECT)));
  assert.equal(missing.at.target, at(PROJECT));
  assert.ok(missing.message.length > 0);
  opened(store);
  closed(store, PROJECT, goal(), outcome({ reason: "interrupted" }));
  const quiet = refusalOf(stopReport(store, address(PROJECT)));
  assert.equal(quiet.code, "stop_absent");
  assert.equal(quiet.at.target, at(PROJECT));

  // A report weighed again is weighed as the report this unit assembles: a missing key, an extra one, an absent set
  // of guards and a guard that is not an exact reference are defects of the calling code, not values to read round.
  const { stopped } = stoppedAtThree(store, "beta");
  assert.equal(stopped.stop!.attempt, 3);
  const report = reportOf(store, "beta");
  const { lines: _lines, ...without } = report;
  for (const broken of [undefined, null, [], "report", without, { ...report, extra: 1 }, { ...report, guards: undefined },
    { ...report, guards: "none" }, { ...report, guards: [{ id: report.series }] }, { ...report, project: "" },
    { ...report, line: 1.5 }, { ...report, series: 7 }]) {
    assert.throws(() => checkStanding(store, broken as unknown as StopReport), typedDefect, JSON.stringify(broken)?.slice(0, 60));
  }
  // A whole report, unchanged, comes back from the same records.
  assert.deepEqual(deliveredOf(checkStanding(store, report)), report);

  // An analysis whose record names no cause and no change at all is a broken record, not an outcome.
  const { stopped: third } = stoppedAtThree(store, "p3");
  const usable = storedReview(store, "p3", reviewValue("p3", 3, third.stop!.goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address("p3"), stop: 3, review: { ref: usable } }));
  for (const [part, value] of [["cause", undefined], ["change", undefined], ["cause", ""], ["change", []], ["change", {}]] as const) {
    const over: Record<string, unknown> = { cause: null };
    if (value === undefined) delete over[part]; else over[part] = value;
    if (value === undefined) {
      const bare = reviewValue("p3", 3, third.stop!.goals, { cause: null }) as Record<string, unknown>;
      delete bare[part];
      const broken = storedReview(store, "p3", bare);
      forgeSeries(store, "p3", held => ({ ...held, escalations: [{ after: 3, review: broken }] }));
    } else {
      const broken = storedReview(store, "p3", reviewValue("p3", 3, third.stop!.goals, { cause: null, [part]: value }));
      forgeSeries(store, "p3", held => ({ ...held, escalations: [{ after: 3, review: broken }] }));
    }
    const found = addressed(refusalOf(stopReport(store, address("p3"))), "analysis_invalid", at("p3"));
    assert.equal(found.at.field, `escalations.3.${part}`, `${part} ${String(value)}`);
  }

  // An analysis that names no goals at all: an absent set is not a set that matches, and not an empty one either.
  for (const goals of [undefined, [], "gap:cart:price", [1]]) {
    const bare = reviewValue("p3", 3, third.stop!.goals, { cause: null }) as Record<string, unknown>;
    if (goals === undefined) delete bare['goals']; else bare['goals'] = goals;
    const nameless = storedReview(store, "p3", bare);
    forgeSeries(store, "p3", held => ({ ...held, escalations: [{ after: 3, review: nameless }] }));
    const found = addressed(refusalOf(stopReport(store, address("p3"))), "analysis_invalid", at("p3"));
    assert.equal(found.at.field, "escalations.3.goals", JSON.stringify(goals));
  }
});

const reportShape = (): StopReport => ({
  project: PROJECT, block: BLOCK, line: 1, series: at(PROJECT), rung: 1, audience: "reviewer",
  context: {
    series: at(PROJECT), stop: null, holds: [], ladder: { rung: 1, goals: [], windows: [], grounds: [] },
    goals: [], accepted: [], repeated: [], endings: [], grounds: [],
  },
  obstacles: [],
  finding: { subject: "unknown", addressee: null, rows: [], facts: facts(), text: "" },
  remedies: [], proposed: [], guards: [], lines: [],
});

test("a forged analysis is refused: another namespace, another kind, a changed hash, another stop, a status field", t => {
  const { store } = fixture(t);
  const { stopped } = stoppedAtThree(store);
  const goals = stopped.stop!.goals;
  const honest = storedReview(store, PROJECT, reviewValue(PROJECT, 3, goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: honest } }));
  const escalatedOn = (review: Ref): void => {
    forgeSeries(store, PROJECT, held => ({ ...held, escalations: [{ after: 3, review }] }));
  };
  const unreadable = (review: Ref, note: string): Refusal => {
    escalatedOn(review);
    const found = addressed(refusalOf(stopReport(store, address(PROJECT))), "analysis_unreadable", at(PROJECT));
    assert.ok(found.message.includes("cannot be read at the reference the series holds"), note);
    return found;
  };
  const invalid = (value: Record<string, unknown>, field: string, note: string): void => {
    escalatedOn(storedReview(store, PROJECT, value));
    const found = addressed(refusalOf(stopReport(store, address(PROJECT))), "analysis_invalid", at(PROJECT));
    assert.equal(found.at.field, `escalations.3.${field}`, note);
  };

  // Another project's namespace, however well the record reads.
  opened(store, "beta");
  const foreign = storedReview(store, "beta", reviewValue(PROJECT, 3, goals, { cause: null }));
  assert.equal(unreadable(foreign, "another project").at.ref!.id, foreign.id);
  // The right namespace and another kind: a decision of the owner is not an analysis.
  const wrongKind = storedAs(store, OWNER_DECISION_KIND, `${stopReviewNamespace(PROJECT)}${next()}`,
    reviewValue(PROJECT, 3, goals, { cause: null }));
  unreadable(wrongKind, "another kind");
  // The exact reference with a changed hash, and one that stands nowhere at all.
  unreadable({ ...honest, hash: hex("b") }, "a changed hash");
  unreadable({ id: `${stopReviewNamespace(PROJECT)}never`, revision: 1, hash: hex("c") }, "no record");

  // Another block and another stop of the same series: an analysis of something else explains nothing about this one.
  invalid({ ...reviewValue(PROJECT, 3, goals, { cause: null }), block: "block:orders" }, "block", "another block");
  invalid(reviewValue(PROJECT, 9, goals, { cause: null }), "stop", "another stop");
  invalid({ ...reviewValue(PROJECT, 3, goals, { cause: null }), projectId: "beta" }, "block", "another project inside the record");

  // A STATUS FIELD that claims an outcome the content does not have changes nothing: how an analysis ended is where
  // the series put it, and a record that says otherwise is a contradiction, not a second opinion.
  invalid(reviewValue(PROJECT, 3, goals, { ended: "undecided", final: true, helped: false }), "cause", "a decided review escalated on");
  escalatedOn(honest);
  const straight = reportOf(store);
  assert.equal(straight.remedies[0]!.outcome, "ended-undecided");
  const boastful = storedReview(store, PROJECT, reviewValue(PROJECT, 3, goals, {
    cause: null, change: null, ended: "decided", final: true, reviewer: { independent: true, approved: true },
  }));
  escalatedOn(boastful);
  const ignored = reportOf(store);
  assert.equal(ignored.remedies[0]!.outcome, "ended-undecided");
  assert.equal(ignored.remedies[0]!.claims.every(claim => claim.stated === null), true);
  assert.equal(ignored.remedies[0]!.claims.every(claim => claim.standing === "version"), true);
  assert.ok(ignored.remedies[0]!.explained.includes("named no cause and no change"));
  assert.deepEqual(ignored.proposed, []);
  // Not one of the fields the record claims about itself travels into the explanation: only the cause and the change.
  const dump = JSON.stringify(ignored);
  for (const claimed of ['"ended"', '"final"', '"approved"', '"independent"', '"reviewer"']) {
    assert.equal(dump.includes(claimed), false, claimed);
  }

  // The same the other way round: an analysis that decided nothing is not the one a stop was CONTINUED on.
  const { stopped: second } = stoppedAtThree(store, "p2");
  const usable = storedReview(store, "p2", reviewValue("p2", 3, second.stop!.goals));
  deliveredOf(resumeSeries(store, {
    ...address("p2"), stop: 3, ground: "review-record", text: "the review named a cause and a change", review: { ref: usable },
  }));
  const hollow = storedReview(store, "p2", reviewValue("p2", 3, second.stop!.goals, { cause: null, ended: "decided" }));
  forgeSeries(store, "p2", held => ({
    ...held,
    continuations: [{ ground: "review-record", text: "the review named a cause and a change", review: hollow, after: 3 }],
  }));
  closed(store, "p2", goal(), refusedBy(artifactMissing(store, "p2", "input")));
  closed(store, "p2", goal(), refusedBy(artifactMissing(store, "p2", "input")));
  closed(store, "p2", goal(), refusedBy(artifactMissing(store, "p2", "input")));
  const found = addressed(refusalOf(stopReport(store, address("p2"))), "analysis_invalid", at("p2"));
  assert.equal(found.at.field, "continuations.3.cause");
});

test("a record that moved between this reading and a write on it is refused, never written through (T7)", t => {
  const { store } = fixture(t);
  const { stopped } = stoppedAtThree(store);
  const report = reportOf(store);
  assert.deepEqual(deliveredOf(checkStanding(store, report)), report);

  // The series moves on between the reading and the write: the analysis of A6 would be written on a stop that is no
  // longer the one it was assembled for.
  const undecided = storedReview(store, PROJECT, reviewValue(PROJECT, 3, stopped.stop!.goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: undecided } }));

  const stale = addressed(refusalOf(checkStanding(store, report)), "report_stale", at(PROJECT));
  assert.equal(stale.at.ref!.id, at(PROJECT));
  assert.equal(stale.at.field, "guards");

  // And the guards close the window in the transaction itself: a write that stands on this explanation does not
  // commit against records that moved, so there is no silent write either.
  const analysis = `${ORIGIN_ANALYSIS_KIND}:${PROJECT}:${next()}`;
  const written = writeGuarded(store, {
    unit: "a6", target: analysis, guards: [...report.guards],
    writes: [{ id: analysis, kind: ORIGIN_ANALYSIS_KIND, expected: 0, value: { cause: "circles" } as Json }],
  });
  assert.equal(refusalOf(written).code, "input_stale");
  assert.equal(store.get(analysis), null);

  // The explanation as the records give it NOW carries guards that do commit.
  const fresh = reportOf(store);
  assert.notDeepEqual(fresh.guards, report.guards);
  const again = writeGuarded(store, {
    unit: "a6", target: analysis, guards: [...fresh.guards],
    writes: [{ id: analysis, kind: ORIGIN_ANALYSIS_KIND, expected: 0, value: { cause: "circles" } as Json }],
  });
  assert.equal(deliveredOf(again).length, 1);

  // A moved record is answered as moved, and a report the unchanged records do not give as forged: two answers, and
  // neither of them is a quiet acceptance.
  const now = reportOf(store);
  for (const lying of [{ ...now, finding: { ...now.finding, subject: "environment" as const, addressee: "owner:anyone" } },
    { ...now, rung: 1, audience: "reviewer" as const }, { ...now, remedies: [] },
    { ...now, context: { ...now.context, accepted: ["a result nobody accepted"] } }]) {
    assert.equal(refusalOf(checkStanding(store, lying as StopReport)).code, "report_forged");
  }
});

test("no model is called to assemble the explanation", t => {
  const { store, path } = fixture(t);
  // The unit imports the engine's own records and nothing that could reach a vendor, a process or the network.
  const source = readFileSync(new URL("../../src/om/stop-report.ts", import.meta.url), "utf8");
  const imported = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]!);
  assert.deepEqual(imported.sort(), [
    "../canonical.js", "../errors.js", "../pipeline/contracts.js", "../storage/store.js",
    "./refs.js", "./refusal-journal.js", "./refusal.js", "./repeat-gate.js", "./series.js",
  ]);
  for (const forbidden of ["adapters/", "runtime/", "execution/", "node:child_process", "fetch(", "Date.now", "Math.random"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }

  // And the explanation is a function of the records alone: the same records, read twice and read again out of a
  // reopened base, give the same bytes. Nothing dated, random or answered by anybody enters it.
  stoppedAtThree(store);
  const first = reportOf(store);
  assert.equal(hashJson(reportOf(store) as unknown as Json), hashJson(first as unknown as Json));
  store.close();
  const back = new Store(path);
  t.after(() => back.close());
  assert.deepEqual(reportOf(back), first);
});

const facts = (over: Partial<StopFacts> = {}): StopFacts => ({
  attempts: 3,
  endings: counts(COMPLETION_REASONS, {}),
  obstacles: 0, repeating: 0,
  classes: counts(REFUSAL_CLASSES, {}),
  unclassified: 0, addressees: 0, holds: 0, accepted: 0,
  ...over,
});

function counts<Key extends string>(keys: readonly Key[], over: Partial<Record<Key, number>>): Record<Key, number> {
  const table = {} as Record<Key, number>;
  for (const key of keys) table[key] = over[key] ?? 0;
  return table;
}

test("the table of decision admits one subject for a tally at most, and every row of it is reachable", () => {
  assert.deepEqual(STOP_SUBJECT_DECISIONS.map(row => row.subject), ["obstacle", "environment", "origin"]);
  const seen = new Set<string>();
  for (const proposal of [0, 1, 2]) for (const input of [0, 1]) for (const derivation of [0, 1]) for (const readiness of [0, 1]) {
    for (const conditions of [0, 1]) for (const unknown of [0, 1]) for (const unclassified of [0, 1]) {
      for (const holds of [0, 1, 2]) for (const addressees of [0, 1, 2]) {
        for (const interrupted of [0, 1]) for (const refused of [0, 1]) for (const offForm of [0, 1]) {
          const classes: Record<RefusalClass, number> = { proposal, input, derivation, readiness, conditions, unknown };
          const obstacles = REFUSAL_CLASSES.reduce((sum, item) => sum + classes[item], 0) + unclassified;
          const tally = facts({
            classes, unclassified, holds, addressees, obstacles,
            repeating: obstacles, attempts: interrupted + refused + offForm,
            endings: counts(COMPLETION_REASONS, { interrupted, refused, "off-form": offForm }),
          });
          const admitted = STOP_SUBJECT_DECISIONS.filter(row => row.sufficient(tally));
          const key = JSON.stringify(tally);
          assert.ok(admitted.length <= 1, key);
          seen.add(admitted[0]?.subject ?? "unknown");
        }
      }
    }
  }
  // LP6: the old table never says input-transition; that subject belongs to a report of the new era (below).
  assert.deepEqual([...seen].sort(), STOP_SUBJECTS.filter(subject => subject !== "input-transition").sort());

  // The rows that matter, pinned: one responsible says a subject, two of them say nothing.
  const oneObstacle = facts({ classes: counts(REFUSAL_CLASSES, { input: 2 }), obstacles: 2, addressees: 1 });
  assert.equal(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient(oneObstacle))[0]!.subject, "obstacle");
  assert.deepEqual(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient({ ...oneObstacle, addressees: 2 })), []);
  // An obstacle that is classified by nobody, or a held origin beside it, singles nobody out either.
  assert.deepEqual(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient({ ...oneObstacle, unclassified: 1, obstacles: 3 })), []);
  assert.deepEqual(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient({ ...oneObstacle, holds: 1 })), []);
  // Two held origins are two candidates for one analysis, so the origin is not said either.
  const oneHold = facts({ classes: counts(REFUSAL_CLASSES, { unknown: 1 }), obstacles: 1, addressees: 1, holds: 1 });
  assert.equal(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient(oneHold))[0]!.subject, "origin");
  assert.deepEqual(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient({ ...oneHold, holds: 2 })), []);
  // A refusal of the conditions beside one of the product blames both, so it singles out neither.
  assert.deepEqual(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient(facts({
    classes: counts(REFUSAL_CLASSES, { conditions: 1, input: 1 }), obstacles: 2, addressees: 2,
  }))), []);
  assert.deepEqual(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient(facts({
    classes: counts(REFUSAL_CLASSES, { conditions: 2, readiness: 1 }), obstacles: 3, addressees: 2,
  }))), []);
  // A cycle broken off beside a refusal of the product is not an environment failure on its own.
  const broken = facts({ attempts: 3, endings: counts(COMPLETION_REASONS, { interrupted: 3 }) });
  assert.equal(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient(broken))[0]!.subject, "environment");
  assert.deepEqual(STOP_SUBJECT_DECISIONS.filter(row => row.sufficient({
    ...broken, classes: counts(REFUSAL_CLASSES, { input: 1 }), obstacles: 1, addressees: 1,
  })), []);
});

test("the vocabulary of this unit is closed, and what it hands out is a deep frozen copy (T11)", t => {
  const { store } = fixture(t);
  for (const table of [REPORT_AUDIENCES, STOP_SUBJECTS, REMEDY_KINDS, REMEDY_OUTCOMES, STOP_REPORT_CODES, CLAIM_SUBJECTS, STOP_SUBJECT_DECISIONS]) {
    assert.ok(Object.isFrozen(table));
    assert.throws(() => { (table as unknown as string[]).push("invented"); }, TypeError);
    assert.equal(new Set(table as readonly unknown[]).size, (table as readonly unknown[]).length);
  }
  assert.throws(() => {
    // @ts-expect-error a policy table does not change while the module works, at compile time as well
    STOP_SUBJECTS[0] = "invented";
  }, TypeError);
  for (const row of STOP_SUBJECT_DECISIONS) assert.ok(STOP_SUBJECTS.includes(row.subject));

  stoppedAtThree(store);
  const report = reportOf(store);
  assert.ok(deeplyFrozen(report));
  // A copy, sharing no object with the store or with the context the gate assembled.
  const context = deliveredOf(stopContext(store, address(PROJECT)));
  assert.notEqual(report.context, context);
  assert.deepEqual(report.context, context);
  assert.ok(REPORT_AUDIENCES.includes(report.audience));
});

// ---------------------------------------------------------------------------
// Journal record №184: history and heads, a later stop as no proof, belonging, and the content of a refusal.

/** A cycle the SERIES records as having reached a new accepted result — a fixture of history: G7's providers are empty. */
function progressed(store: Store, project: string, g: AttemptGoal, key: string, line = 1): number {
  const attempt = ordinalOf(store, project, line);
  const basis = reference(store.write({
    id: `om-gap-line:${project}:${next()}`, kind: "om-gap-line", expected: 0, value: { closed: key } as Json,
  }));
  deliveredOf(beginAttempt(store, { ...address(project, line), attempt, goal: g }));
  deliveredOf(completeAttempt(store, {
    ...address(project, line), attempt,
    outcome: { reason: "result", achieved: [{ key, basis }], cancelled: [], refusals: [] } as ClaimedOutcome,
  }));
  return attempt;
}

const onReview = (store: Store, project: string, stop: number, goals: readonly string[]) => ({
  ground: "review-record" as const, text: "the review named a cause and a change",
  review: { ref: storedReview(store, project, reviewValue(project, stop, goals)) },
});

test("a historical ground is read at its exact reference: a newer revision of an analysis leaves the report standing", t => {
  const { store } = fixture(t);
  const { stopped } = stoppedAtThree(store);
  const goals = stopped.stop!.goals;
  const undecided = storedReview(store, PROJECT, reviewValue(PROJECT, 3, goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: undecided } }));
  const report = reportOf(store);
  // The analysis the series has already moved on is HISTORY, not a head: it is read at its exact revision, and it is
  // not guarded. Guarding it would make every later revision of it a permanent staleness of this series' reports.
  assert.equal(report.guards.some(ref => ref.id === undecided.id), false);
  assert.equal(report.remedies[0]!.records[0]!.revision, 1);

  // A second, legitimate revision of that same analysis — one that even reads as the other outcome — changes nothing.
  store.write({
    id: undecided.id, kind: STOP_REVIEW_KIND, expected: 1,
    value: reviewValue(PROJECT, 3, goals, { cause: "a later reading of the same stop names one after all" }) as Json,
  });
  assert.deepEqual(reportOf(store), report);
  assert.deepEqual(deliveredOf(checkStanding(store, report)), report);

  // The same for the analysis a CONTINUATION stands on, and the other way round: a later revision without a change.
  const { stopped: second } = stoppedAtThree(store, "beta");
  const decided = storedReview(store, "beta", reviewValue("beta", 3, second.stop!.goals));
  deliveredOf(resumeSeries(store, {
    ...address("beta"), stop: 3, ground: "review-record", text: "the review named a cause and a change", review: { ref: decided },
  }));
  const again = artifactMissing(store, "beta", "input");
  for (let index = 0; index < 3; index += 1) closed(store, "beta", goal(), refusedBy(again));
  const spent = reportOf(store, "beta");
  assert.equal(spent.guards.some(ref => ref.id === decided.id), false);
  assert.equal(spent.remedies[0]!.outcome, "window-stopped-again");
  store.write({
    id: decided.id, kind: STOP_REVIEW_KIND, expected: 1,
    value: reviewValue("beta", 3, second.stop!.goals, { change: null }) as Json,
  });
  assert.deepEqual(reportOf(store, "beta"), spent);
  assert.deepEqual(deliveredOf(checkStanding(store, spent)), spent);
});

test("the guards are every mutable head that was read, the LIFTED hold of the gate's own reading among them", t => {
  const { store } = fixture(t);
  opened(store);
  const refusal = unplacedRefusal(store, PROJECT);
  const first = closed(store, PROJECT, goal(), refusedBy(refusal));
  const hold = first.holds[0]!;
  const raised = store.get<OriginHold>(hold.id)!.value;
  // The owner decided about that origin, so the hold is lifted and the series goes on.
  const decision = storedAs(store, ORIGIN_DECISION_KIND, `${originDecisionNamespace(PROJECT)}${next()}`, {
    projectId: PROJECT, block: BLOCK, attempt: raised.attempt, row: raised.row,
    decided: "go on: I have read the origin and the facts, and the refusal stays where it is",
  });
  deliveredOf(liftOriginHold(store, { project: PROJECT, hold, ground: "owner-decision", record: { ref: decision } }));
  for (let index = 0; index < 2; index += 1) closed(store, PROJECT, goal(), outcome({ reason: "off-form" }));

  const report = reportOf(store);
  assert.equal(report.context.stop!.attempt, 3);
  assert.deepEqual(report.context.holds, []);            // it was lifted: it stands no more
  // The gate reads it all the same, so it is a head this explanation depends on — and the report says which heads
  // those are by asking the gate, not by guessing what it touched.
  const lifted = store.get(hold.id)!;
  assert.ok(report.guards.some(ref => ref.id === hold.id && ref.revision === lifted.revision && ref.hash === lifted.hash));
  assert.ok(report.guards.some(ref => ref.id === at(PROJECT)));
  assert.ok(report.guards.some(ref => ref.id === journalId(PROJECT)));
  const reads = deliveredOf(readStopContext(store, address(PROJECT))).reads;
  assert.deepEqual(reads.filter(ref => report.guards.every(guard => guard.id !== ref.id)), []);
  // The record the hold was lifted ON is history, and is not among them.
  assert.equal(report.guards.some(ref => ref.id === decision.id), false);

  // That head moves between the reading and the write: the hold stands again, and the explanation is another one.
  store.write({
    id: hold.id, kind: ORIGIN_HOLD_KIND, expected: lifted.revision,
    value: { ...(lifted.value as object), lift: null } as Json,
  });
  const stale = addressed(refusalOf(checkStanding(store, report)), "report_stale", at(PROJECT));
  assert.equal(stale.at.ref!.id, hold.id);
  const analysis = `${ORIGIN_ANALYSIS_KIND}:${PROJECT}:${next()}`;
  const written = writeGuarded(store, {
    unit: "a6", target: analysis, guards: [...report.guards],
    writes: [{ id: analysis, kind: ORIGIN_ANALYSIS_KIND, expected: 0, value: { cause: "circles" } as Json }],
  });
  assert.equal(refusalOf(written).code, "input_stale");
  assert.equal(store.get(analysis), null);

  // The explanation as the records give it now sees the hold standing, and its guards do commit.
  const fresh = reportOf(store);
  assert.equal(fresh.context.holds.length, 1);
  assert.equal(deliveredOf(writeGuarded(store, {
    unit: "a6", target: analysis, guards: [...fresh.guards],
    writes: [{ id: analysis, kind: ORIGIN_ANALYSIS_KIND, expected: 0, value: { cause: "circles" } as Json }],
  })).length, 1);
});

test("a continuation an accepted result followed is not the remedy that failed, whatever stopped the series later", t => {
  const { store } = fixture(t);
  const { stopped } = stoppedAtThree(store);
  const goals = stopped.stop!.goals;
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...onReview(store, PROJECT, 3, goals) }));
  // Attempt 4 reaches a new accepted result of the very goal the ladder stood for: the window opened by the
  // continuation ends THERE, and the ladder goes back to its start.
  assert.equal(progressed(store, PROJECT, goal(), "line:cart:price"), 4);
  const later = artifactMissing(store, PROJECT, "input");
  for (let index = 0; index < 3; index += 1) closed(store, PROJECT, goal(), refusedBy(later));

  const report = reportOf(store);
  assert.equal(report.context.stop!.attempt, 7);
  assert.deepEqual(report.context.accepted, ["line:cart:price"]);
  assert.equal(report.rung, 1);
  assert.equal(report.audience, "reviewer");
  assert.equal(report.remedies.length, 1);
  const remedy = report.remedies[0]!;
  assert.equal(remedy.after, 3);
  // The later stop by itself proves nothing about this remedy: what stopped the series then was counted in the
  // window that the accepted result opened.
  assert.equal(remedy.outcome, "result-followed");
  assert.ok(remedy.explained.includes("ended at attempt 4"));
  assert.ok(remedy.explained.includes("line:cart:price"));
  assert.ok(remedy.explained.includes("the goal the ladder stands for") === false || report.rung === 1);
  assert.equal(remedy.explained.includes("without"), false);
  assert.equal(remedy.explained.includes("closed in the stop after attempt 7"), false);
  const text = report.lines.join("\n");
  assert.ok(text.includes("not in this one"));
  assert.ok(text.includes("Accepted results of these goals: line:cart:price."));

  // And the same when the history is INHERITED by a successor of the series: the result is still in it.
  const predecessor = reference(heldSeries(store, PROJECT)!);
  deliveredOf(openSeries(store, {
    ...address(PROJECT, 2), slice: "slice:cart@2", predecessor,
    basis: { ground: "inputs-changed", text: "the slice of the horizon moved" },
  }));
  const inherited = reportOf(store, PROJECT, 2);
  assert.equal(inherited.context.stop!.attempt, 7);
  assert.deepEqual(inherited.context.accepted, ["line:cart:price"]);
  assert.equal(inherited.remedies.length, 1);
  assert.equal(inherited.remedies[0]!.outcome, "result-followed");
  assert.ok(inherited.remedies[0]!.explained.includes("ended at attempt 4"));

  // A window that no accepted result followed is still reported as closed by the stop that closed it.
  const { stopped: second } = stoppedAtThree(store, "beta");
  deliveredOf(resumeSeries(store, { ...address("beta"), stop: 3, ...onReview(store, "beta", 3, second.stop!.goals) }));
  const dry = artifactMissing(store, "beta", "input");
  for (let index = 0; index < 3; index += 1) closed(store, "beta", goal(), refusedBy(dry));
  const nothing = reportOf(store, "beta");
  assert.equal(nothing.remedies[0]!.outcome, "window-stopped-again");
  assert.ok(nothing.remedies[0]!.explained.includes("closed in the stop after attempt 6"));
  assert.deepEqual(nothing.context.accepted, []);
});

/** A stop counted over cycles of TWO goals: the run ends at an attempt of the second one. */
function stoppedOnTwoGoals(store: Store, project: string): RepeatOutcome {
  opened(store, project);
  const refusal = artifactMissing(store, project, "input");
  closed(store, project, goal(), refusedBy(refusal));
  closed(store, project, goal(), refusedBy(refusal));
  const stopped = closed(store, project, goal({ key: "gap:cart:tax" }), refusedBy(refusal));
  assert.deepEqual(stopped.stop!.goals, ["gap:cart:price", "gap:cart:tax"]);
  return stopped;
}

test("an analysis of other goals is no explanation of this stop, however exact its reference", t => {
  const { store } = fixture(t);
  const { stopped } = stoppedAtThree(store);
  const goals = stopped.stop!.goals;
  const honest = storedReview(store, PROJECT, reviewValue(PROJECT, 3, goals, { cause: null }));
  deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: honest } }));
  const report = reportOf(store);
  assert.equal(report.proposed.length, 1);

  // Right namespace, right kind, right revision, right hash, right project, right block, right stop — other goals.
  const stranger = storedReview(store, PROJECT, reviewValue(PROJECT, 3, ["goal:unrelated"], {
    cause: null, change: { text: "rewrite the layer of another block", addresses: ["M9"] },
  }));
  forgeSeries(store, PROJECT, held => ({ ...held, escalations: [{ after: 3, review: stranger }] }));
  const found = addressed(refusalOf(stopReport(store, address(PROJECT))), "analysis_invalid", at(PROJECT));
  assert.equal(found.at.field, "escalations.3.goals");
  assert.deepEqual(found.at.ref, stranger);
  // There is no explanation at all, so nothing of the stranger's became one — and the earlier report is stale, not
  // quietly still valid, because the series it was read from has moved.
  assert.equal(refusalOf(checkStanding(store, report)).code, "report_stale");

  // The goals of a stop are an unordered set: the same two in the other order are the same goals (T6).
  stoppedOnTwoGoals(store, "delta");
  const reversed = storedReview(store, "delta", reviewValue("delta", 3, ["gap:cart:tax", "gap:cart:price"], { cause: null }));
  deliveredOf(escalateSeries(store, { ...address("delta"), stop: 3, review: { ref: reversed } }));
  const fine = reportOf(store, "delta");
  assert.equal(fine.remedies[0]!.outcome, "ended-undecided");
  // Dropping one of them is another set, and another stop's analysis.
  const partial = storedReview(store, "delta", reviewValue("delta", 3, ["gap:cart:price"], { cause: null }));
  forgeSeries(store, "delta", held => ({ ...held, escalations: [{ after: 3, review: partial }] }));
  assert.equal(refusalOf(stopReport(store, address("delta"))).at.field, "escalations.3.goals");

  // A stop already ANSWERED keeps its exact goals in the history of the line, so the comparison stays exact there too.
  const answered = stoppedOnTwoGoals(store, "eps");
  const both = answered.stop!.goals;
  deliveredOf(resumeSeries(store, { ...address("eps"), stop: 3, ...onReview(store, "eps", 3, both) }));
  const elsewhere = artifactMissing(store, "eps", "input");
  for (let index = 0; index < 3; index += 1) closed(store, "eps", goal({ key: "gap:cart:ship" }), refusedBy(elsewhere));
  const continued = reportOf(store, "eps");
  assert.equal(continued.context.stop!.attempt, 6);
  assert.deepEqual(continued.context.stop!.goals, ["gap:cart:ship"]);   // the ladder says THIS stop's goals, not those
  assert.equal(continued.remedies[0]!.claims.length, 2);
  assert.equal(continued.proposed.length, 1);

  const withGoals = (goals: readonly string[]): OmResult<StopReport> => {
    const review = storedReview(store, "eps", reviewValue("eps", 3, goals));
    forgeSeries(store, "eps", held => ({
      ...held,
      continuations: [{ ground: "review-record", text: "the review named a cause and a change", review, after: 3 }],
    }));
    return stopReport(store, address("eps"));
  };
  // A goal LOST, a goal ADDED from another window of the same series, a goal of nobody's, and one named twice — each
  // of them is another set than the one that stop was counted over.
  for (const goals of [["gap:cart:price"], ["gap:cart:tax"], [...both, "gap:cart:ship"], ["goal:unrelated"],
    ["gap:cart:price", "gap:cart:price", "gap:cart:tax"]]) {
    const found = addressed(refusalOf(withGoals(goals)), "analysis_invalid", at("eps"));
    assert.equal(found.at.field, "continuations.3.goals", JSON.stringify(goals));
  }
  // The same set in another order is the same set (T6), and its change is proposed again.
  const reordered = deliveredOf(withGoals([...both].reverse()));
  assert.equal(reordered.remedies[0]!.claims.length, 2);
  assert.equal(reordered.proposed.length, 1);
  assert.deepEqual(reordered.remedies[0]!.claims.map(claim => claim.what), [...CLAIM_SUBJECTS]);
});

test("the explanation carries the content of the journal rows of the window, and a recorded remedy is not a proven cause", t => {
  const { store } = fixture(t);
  definitionFixture(store, PROJECT, "artifact:price");
  opened(store);
  const refusal = journalled(store, PROJECT, {
    name: "artifact_missing", subject: "artifact:price",
    sources: assembly(store, PROJECT, "accepted", [], ["artifact:price"]).sources,
  }, {
    code: "missing_price_producer", gate: "G3",
    goal: "every artifact an operation consumes is produced somewhere in the layer",
    remedy: "name the node that produces artifact:price",
  });
  for (let index = 0; index < 3; index += 1) closed(store, PROJECT, goal(), refusedBy(refusal));

  const report = reportOf(store);
  assert.equal(report.obstacles.length, 1);
  const row = report.obstacles[0]!;
  assert.equal(row.row, refusal.row);
  assert.equal(row.gate, "G3");
  assert.equal(row.code, "missing_price_producer");
  assert.equal(row.goal, "every artifact an operation consumes is produced somewhere in the layer");
  assert.equal(row.remedy, "name the node that produces artifact:price");
  assert.equal(row.origin.name, "artifact_missing");
  assert.equal(row.origin.stage, "layer-check");
  assert.equal(row.origin.subject, "artifact:price");
  assert.equal(row.origin.sources.length, 2);
  assert.equal(row.times, 3);
  // The class and the addressee are G7's findings, read beside the row and derived again nowhere.
  assert.equal(row.class, "input");
  assert.ok(row.addressee!.startsWith(`${ADDRESSEE_KINDS.input}:`));
  // The link back is unambiguous: the row id is the hash of the row's content, and `source` is the gate's own record.
  const source0 = store.get(row.source.id, row.source.revision)!;
  assert.equal(source0.kind, UNIT_REFUSAL_KIND);
  assert.equal(source0.hash, row.source.hash);

  // What the receiver is handed really contains the obstacle, not only a hash of it.
  const dump = JSON.stringify(report);
  for (const part of ["missing_price_producer", "artifact:price", "name the node that produces artifact:price",
    "every artifact an operation consumes is produced somewhere in the layer", "layer-check"]) {
    assert.ok(dump.includes(part), part);
  }
  const text = report.lines.join("\n");
  assert.ok(text.includes('G3 refused "missing_price_producer"'));
  assert.ok(text.includes('over "artifact:price"'));
  assert.ok(text.includes('recorded way to fix it: "name the node that produces artifact:price"'));
  assert.ok(text.includes("met by 3 cycle(s)"));
  assert.ok(report.finding.text.includes("missing_price_producer"));
  assert.ok(report.finding.text.includes('recorded way to fix it "name the node that produces artifact:price"'));
  // The recorded way to fix it is told apart from a cause anybody proved.
  assert.ok(text.includes("not a cause anybody has proved"));

  // A row the journal does not hold is no obstacle anybody can be sent to work on.
  forgeSeries(store, PROJECT, held => ({
    ...held,
    attempts: held.attempts.map((item, index) => (index === 0
      ? { ...item, outcome: { ...item.outcome!, refusals: [{ row: "om-refusal:invented" }] } } : item)),
  }));
  const broken = addressed(refusalOf(stopReport(store, address(PROJECT))), "obstacle_unrecorded", at(PROJECT));
  assert.equal(broken.at.field, "repeated.om-refusal:invented");
});

test("after a result resets the ladder no stop is lost, and every window is judged by its own boundary", t => {
  const { store } = fixture(t);
  const { stopped } = stoppedAtThree(store);
  const goals = stopped.stop!.goals;
  // Stop after attempt 3, continued on the analysis of it.
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...onReview(store, PROJECT, 3, goals) }));
  const dry = artifactMissing(store, PROJECT, "input");
  for (let index = 0; index < 3; index += 1) closed(store, PROJECT, goal(), refusedBy(dry));
  const owners = heldSeries(store)!.value;
  assert.equal(owners.stop!.attempt, 6);
  assert.equal(owners.ladder.rung, 2);
  // The owner allows one more window, and attempt 7 reaches a new accepted result of the same goal.
  const decision = storedAs(store, OWNER_DECISION_KIND, `${ownerDecisionNamespace(PROJECT)}${next()}`, {
    projectId: PROJECT, block: BLOCK, stop: 6, goals: [...owners.stop!.goals],
    decided: "go on: I have read what was tried and I want one more window",
  });
  deliveredOf(resumeSeries(store, {
    ...address(PROJECT), stop: 6, ground: "owner-decision", text: "the owner decided to go on", decision: { ref: decision },
  }));
  assert.equal(progressed(store, PROJECT, goal(), "line:cart:price"), 7);
  // That result returned the ladder to its start, and with it the windows the ladder had spent are gone from the state.
  assert.deepEqual(heldSeries(store)!.value.ladder.windows, []);
  const last = artifactMissing(store, PROJECT, "input");
  for (let index = 0; index < 3; index += 1) closed(store, PROJECT, goal(), refusedBy(last));

  const report = reportOf(store);
  assert.equal(report.context.stop!.attempt, 10);
  // Neither stop of the earlier ladder is lost, and each window is judged by what really ended IT.
  assert.equal(report.remedies.length, 2);
  const first = report.remedies[0]!;
  const second = report.remedies[1]!;
  assert.equal(first.after, 3);
  assert.equal(first.kind, "review-record");
  assert.equal(first.outcome, "window-stopped-again");
  assert.ok(first.explained.includes("closed in the stop after attempt 6"));
  assert.equal(first.explained.includes("attempt 7"), false);
  assert.equal(second.after, 6);
  assert.equal(second.kind, "owner-decision");
  assert.equal(second.outcome, "result-followed");
  assert.ok(second.explained.includes("ended at attempt 7"));
  assert.ok(second.explained.includes("line:cart:price"));
  assert.deepEqual(second.claims, []);          // an owner's decision names no cause and no change
  const text = report.lines.join("\n");
  assert.ok(text.includes("after attempt 3, the stop was continued"));
  assert.ok(text.includes("after attempt 6, the stop was continued"));

  // And the same in a successor of the series: the history travels with the attempts, so both windows keep their own
  // boundaries there too.
  const predecessor = reference(heldSeries(store, PROJECT)!);
  deliveredOf(openSeries(store, {
    ...address(PROJECT, 2), slice: "slice:cart@2", predecessor,
    basis: { ground: "inputs-changed", text: "the slice of the horizon moved" },
  }));
  const inherited = reportOf(store, PROJECT, 2);
  assert.equal(inherited.context.stop!.attempt, 10);
  assert.deepEqual(inherited.remedies.map(item => [item.after, item.outcome]), [[3, "window-stopped-again"], [6, "result-followed"]]);
  assert.ok(inherited.remedies[1]!.explained.includes("ended at attempt 7"));
  // The analysis of the INHERITED stop after attempt 3 is still the analysis of that stop in the successor.
  assert.equal(inherited.remedies[0]!.claims.length, 2);
  assert.deepEqual(inherited.remedies[0]!.records, report.remedies[0]!.records);
});

test("the complete modern source context survives A2, an origin hold and analysis, A5, moved historical heads and restart", t => {
  const { store, path } = fixture(t);
  opened(store);
  const observed = assembly(store, PROJECT, "first", [["artifact:tax"]], ["artifact:tax"]);
  const proposal = observed.proposalSources[0]!;
  const refused = journalled(store, PROJECT, { sources: [proposal] });
  const stopped = closed(store, PROJECT, goal(), refusedBy(refused));
  assert.equal(stopped.holds.length, 1);
  const hold = stopped.holds[0]!, raised = store.get<OriginHold>(hold.id)!.value;
  const original = normalizeOriginSource(proposal);
  assert.equal(original.context!.kind, "proposal");
  assert.deepEqual(reportOf(store).obstacles[0]!.origin.sources, [original]);
  const basis = observed.sources;
  const analysis = storedAs(store, ORIGIN_ANALYSIS_KIND, `${originAnalysisNamespace(PROJECT)}${next()}`, {
    projectId: PROJECT, block: BLOCK, attempt: raised.attempt, row: raised.row, class: "proposal", basis,
  });
  deliveredOf(liftOriginHold(store, { project: PROJECT, hold, ground: "origin-analysis", record: { ref: analysis } }));
  const lifted = store.get<OriginHold>(hold.id)!;
  assert.ok(lifted.value.lift!.basis.some(item => item.context?.kind === "proposal"));
  assert.ok(lifted.value.lift!.basis.some(item => item.context?.kind === "frame"));
  for (let index = 0; index < 2; index += 1) closed(store, PROJECT, goal(), outcome({ reason: "off-form" }));
  const report = reportOf(store);
  assert.deepEqual(report.obstacles[0]!.origin.sources, [original]);
  assert.equal(report.guards.some(ref => ref.id === original.ref.id), false);
  const frame = original.context!.request.frame;
  for (const ref of [original.ref, frame.graph, frame.horizon, analysis]) {
    const latest = store.get(ref.id)!;
    store.write({ id: latest.id, kind: latest.kind, expected: latest.revision, value: latest.value });
  }
  assert.deepEqual(reportOf(store), report);
  assert.deepEqual(deliveredOf(checkStanding(store, report)), report);
  store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  assert.deepEqual(reportOf(reopened), report);
});

test("LP6 row 30: the table of the new era keeps one subject per tally — input-transition only when every cycle of the window ended by its own input moving and nothing else stands — and an interruption by a moved input is never an environment", () => {
  assert.deepEqual(STOP_SUBJECT_DECISIONS_V2.map(row => row.subject), ["obstacle", "environment", "origin", "input-transition"]);
  assert.ok(Object.isFrozen(STOP_SUBJECT_DECISIONS_V2));
  const seen = new Set<string>();
  for (const transitions of [0, 1, 2, 3]) for (const proposal of [0, 1]) for (const conditions of [0, 1]) for (const unknown of [0, 1])
    for (const holds of [0, 1]) for (const addressees of [0, 1, 2]) for (const interrupted of [0, 1]) for (const refused of [0, 1]) {
      const classes: Record<RefusalClass, number> = { proposal, input: 0, derivation: 0, readiness: 0, conditions, unknown };
      const obstacles = REFUSAL_CLASSES.reduce((sum, item) => sum + classes[item], 0);
      const tally = facts({ classes, holds, addressees, obstacles, repeating: obstacles, transitions,
        attempts: transitions + interrupted + refused, endings: counts(COMPLETION_REASONS, { interrupted, refused }) });
      const admitted = STOP_SUBJECT_DECISIONS_V2.filter(row => row.sufficient(tally));
      assert.ok(admitted.length <= 1, JSON.stringify(tally));
      seen.add(admitted[0]?.subject ?? "unknown");
    }
  assert.deepEqual([...seen].sort(), [...STOP_SUBJECTS].sort());
  // Three proved input transitions and nothing else: an input transition, never an environment of three broken cycles.
  const moved = facts({ attempts: 3, transitions: 3 });
  assert.deepEqual(STOP_SUBJECT_DECISIONS_V2.filter(row => row.sufficient(moved)).map(row => row.subject), ["input-transition"]);
  // A mixed window keeps its real obstacle as the subject when one responsible stands behind it; two say nothing.
  const mixed = facts({ attempts: 3, transitions: 2, classes: counts(REFUSAL_CLASSES, { input: 1 }), obstacles: 1, addressees: 1 });
  assert.deepEqual(STOP_SUBJECT_DECISIONS_V2.filter(row => row.sufficient(mixed)).map(row => row.subject), ["obstacle"]);
  assert.deepEqual(STOP_SUBJECT_DECISIONS_V2.filter(row => row.sufficient({ ...mixed, addressees: 2 })), []);
});

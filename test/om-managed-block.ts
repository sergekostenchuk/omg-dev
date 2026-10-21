import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Revision, Store, Write } from "../src/storage/store.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { OmResult } from "../src/om/refusal.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { ProductEngine } from "../src/product/engine.js";
import { fillObligations, prepareFrame, readFrame, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { LayerProposal, ProposalRequest } from "../src/om/frame-proposals.js";
import { writeCandidate, type FrameCandidateRecord } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { prepareAnswerTask } from "../src/om/accepted-answer.js";
import { writeGaps, type GapReadRequest, type GapRequest } from "../src/om/gaps.js";
import { gapLineExpectedResult, gapLineKey } from "../src/om/gap-lines.js";
import { assessFact } from "../src/om/assessment.js";
import { runModelCall } from "../src/om/model-call.js";
import { writeQuestionPacket } from "../src/om/question-packet.js";
import { writeRoutes, type RoutesRecord } from "../src/om/routes.js";
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND, type OriginSource } from "../src/om/refusal-journal.js";
import { seriesId, type AttemptGoal, type BeginAttemptRequest, type ClaimedRefusal, type RepairSeries, type SeriesRequest } from "../src/om/series.js";
import { closeAttempt, openAttempt, prepareManagedClaim, type GateOutcome, type RepeatOutcome } from "../src/om/repeat-gate.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

/**
 * LG07: one block of one project whose attempts open and close only as the managed contract allows. The exact M6 plan
 * opens an attempt, its real E2 packet pays E1+E4 through the scenario adapter, the independent E5 verdict ends every
 * fact of the batch, and G7 derives the outcome from that composition. Nothing here writes an owner, an assignment, a
 * close or an achievement by hand; a refusal is a row the A2 journal really took from a gate's record.
 */
export const MANAGED_SUBJECT = "artifact:cart";
export const managedUsage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const UNKNOWNS = ["cart-price", "price-1", "price-2", "price-3", "price-4", "price-5", "price-6", "price-7", "price-8"];
const targetOf = (unknown: number): string => `discovery:${UNKNOWNS[unknown]!}`;

/** How the paid work of one attempt ends: the E5 verdict on every fact, or the implementer's own request for the owner. */
export type ManagedEnding = "supported" | "insufficient" | "off-form" | "interrupted" | "need-owner";
type Batch = RoutesRecord["batches"][number];
interface Plan { input: Ref; routes: Revision<RoutesRecord>; batch: Batch; unknown: number; spent: boolean }
interface Definition { first: FrameRequest; accepted: FrameRequest; upper: Graph; source: Revision<{ content: string }>;
  graph: Ref; layer: Ref; frame: Ref }
interface Opened { plan: Plan; routes: Revision<RoutesRecord>; batch: Batch; series: Ref }

let unique = 0;
const next = (): number => (unique += 1);
function take<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`unexpected refusal ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

function definition(store: Store, project: string, block: string): Definition {
  const graph = gardenGraph("standard", project);
  const oldArtifact = `${project}-prep`;
  graph.artifacts.find(item => item.id === oldArtifact)!.id = MANAGED_SUBJECT;
  for (const node of graph.nodes) if (node.outcome === oldArtifact) node.outcome = MANAGED_SUBJECT;
  for (const connector of graph.connectors) if (connector.artifact === oldArtifact) connector.artifact = MANAGED_SUBJECT;
  const { level: _level, ...upper } = projectGraph(graph, 1);
  // The repository-fact questions of the block's own M6: one stands behind each attempt until a result answers it.
  preparedFeatures(new ProductEngine(store), project, upper as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = UNKNOWNS.map(id => ({ id,
      question: "which node produces the price of a cart line?", consumer: block, moment: "om-pass", blocksCurrentStage: false,
      resolution: "Resolve the addressed question during OM" }));
    return value;
  });
  const base = take(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const graphRef = reference(store.get<Graph>(`graph:${project}`)!);
  const horizon = take(writeHorizon(store, { project, input: reference(base), graph: graphRef,
    refinement: null, choice: { choiceVersion: "managed-initial", features: [{ outcome: `${project}-result` }], excluded: [] }, available: {} }));
  const first: FrameRequest = { project, level: 2, graph: graphRef, horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  const read = take(prepareFrame(store, first)), projected = projectGraph(graph, 2);
  const mapped = take(fillObligations(read.upper as Graph, read.scope as FrameScope,
    { graph, reference: { ...first.graph, hash: hashJson(graph) }, frame: null }, read.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: first.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: projected.nodes.filter(node => node.kind === "operation"), fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const offered = reference(store.write({ id: `om-proposal:${project}:managed-accepted`, kind: "layer-proposal", expected: 0, value: proposal }));
  const candidate = take(writeCandidate(store, { frame: first, proposals: [offered] }));
  if (candidate.state !== "candidate") assert.fail("The accepted layer of the managed block needs a candidate");
  const ref = reference(candidate.record);
  const applied = take(settleCandidate(store, { project, level: 2, candidate: ref,
    outcome: { gate: "G3", candidate: ref, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  const acceptedHorizon = take(writeHorizon(store, { project, input: reference(base), graph: reference(applied.graph!),
    refinement: reference(applied.layer!), choice: { choiceVersion: "managed-accepted", features: [{ outcome: `${project}-result` }], excluded: [] }, available: {} }));
  const accepted: FrameRequest = { ...first, graph: reference(applied.graph!), horizon: reference(acceptedHorizon.gate),
    layer: reference(applied.layer!), frame: reference(applied.frame!) };
  return { first, accepted, upper: upper as Graph, source: store.get<{ content: string }>(`source:${project}:brief`)!,
    graph: reference(applied.graph!), layer: reference(applied.layer!), frame: reference(applied.frame!) };
}

/**
 * The plan of the next named unknown: a new input addressing it to this block, its horizon, its gaps, the task of every
 * open fact gap and the successor routes. An accepted answer closes its gap for good, so every attempt after a result
 * stands on the next unknown, and the MC1 batch of this consumer holds the still open work only.
 */
function advance(store: Store, project: string, block: string, f: Definition, plan: Plan | null, facts: number): Plan {
  const firstUnknown = plan === null ? 0 : plan.unknown + 1, unknown = firstUnknown + facts - 1;
  if (unknown >= UNKNOWNS.length) assert.fail("The managed block has answered every unknown it prepared");
  const previousInput = plan?.input ?? reference(store.get(`om-input:${project}`)!);
  const input = take(writeAddressing(store, { project, input: previousInput, graph: f.graph,
    decisions: Array.from({ length: facts }, (_, index) => ({ pending: structuredClone(inputDecisionWrite({ project, input: previousInput,
      graph: f.graph, layers: [], decision: { target: targetOf(firstUnknown + index), field: "address",
        value: { consumer: block, kind: "repository-fact" } } })) as Write })) }));
  const horizon = take(writeHorizon(store, { project, input: reference(input), graph: f.graph, refinement: f.layer,
    choice: { choiceVersion: `managed-${unknown}`, features: [{ outcome: `${project}-result` }], excluded: [] }, available: {} }));
  const sources: GapRequest = { project, input: reference(input), graph: f.graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: f.graph, horizon: reference(horizon.gate), layer: f.layer, frame: f.frame, upper: null } },
    works: { proposals: [], frame: { project, level: 3, graph: f.graph, horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: f.frame } } } };
  const gaps = take(writeGaps(store, sources));
  const gapRead: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing" && !row.value.gap.deferral)
    .map(row => take(prepareAnswerTask(store, { project, input: reference(input), gaps: gapRead,
      gap: reference(row), requirements: [{ pointer: "/contracts/0" }], resultForm: { type: "string" } })))
    .map(task => task.writes.length ? { pending: structuredClone(task.writes[0]!) as Write } : { record: reference(task.record) });
  const routes = take(writeRoutes(store, { project, gaps: gapRead, tasks, catalog: { paths: [], records: [] },
    previous: plan === null ? null : reference(plan.routes) })) as Revision<RoutesRecord>;
  const batch = routes.value.batches.find(item => item.model === "MC1" && item.items.some(row => row.consumers.includes(block)));
  if (!batch) assert.fail(`No MC1 batch of ${block} stands on the routes of unknown ${unknown}`);
  return { input: reference(input), routes, batch, unknown, spent: false };
}

const IMPLEMENTER_STEP = (f: Definition, batch: Batch) => ({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
  results: batch.items.map(item => ({ questionId: item.gap, value: f.source.value.content.slice(0, 8),
    citations: [{ source: reference(f.source), selector: { kind: "text-range", start: 0, end: f.source.value.content.length } }] })) },
usage: managedUsage });
const OWNER_STEP = (batch: Batch) => ({ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap),
  action: "need_owner", reason: "Only the owner knows which node prices a cart line", decision: "Name the producer of the price" }, usage: managedUsage });
const ASSESSOR_STEPS: Record<Exclude<ManagedEnding, "need-owner">, unknown> = {
  supported: { research: { verdict: "supported", reasons: [] }, usage: managedUsage },
  insufficient: { research: { verdict: "insufficient", reasons: ["The cited brief does not name the producer of the price"] }, usage: managedUsage },
  "off-form": { research: { answer: "untyped reviewer reply" }, usage: managedUsage },
  interrupted: { rawStdout: "{broken", exitCode: 7 },
};

export interface ManagedSteps {
  readonly store: Store;
  /** The next ordinal the series of this line would open. */
  ordinal(line?: number): number;
  /** The goal the current M6 batch dictates; the caller keeps only the key it tracks the attempt by. */
  goal(key?: string): AttemptGoal;
  /** The complete opening of an attempt under the current plan: its goal and its exact completion. */
  opening(attempt: number, key?: string, line?: number): BeginAttemptRequest;
  /** Opens the attempt through G7; `reshape` changes the complete request first, as a caller naming it otherwise would. */
  open(attempt: number, key?: string, line?: number, reshape?: (request: BeginAttemptRequest) => BeginAttemptRequest): Revision<RepairSeries>;
  /** The paid work of an opened attempt: its E2 packet, the E1+E4 call and the E5 verdict of each fact. */
  pay(attempt: number, ending: ManagedEnding, line?: number): Promise<void>;
  /** The full claim G7 derives for the attempt: what its registry requires, and these independent refusal rows. */
  claim(attempt: number, refusals?: readonly ClaimedRefusal[], line?: number): GateOutcome;
  close(attempt: number, outcome: GateOutcome, line?: number): RepeatOutcome;
  /** The exact claim the attempt was closed with here — what a late delivery of its close repeats. */
  claimed(attempt: number, line?: number): GateOutcome;
  /** One completed cycle: opened, paid, claimed and closed at the gate. */
  cycle(key: string, ending: ManagedEnding, refusals?: readonly ClaimedRefusal[], line?: number): Promise<RepeatOutcome>;
}
export interface ManagedBlock extends ManagedSteps {
  readonly project: string;
  readonly block: string;
  address(line?: number): SeriesRequest;
  /** The same block worked on through another Store over the same database: a rival, or the process after a restart. */
  on(store: Store): ManagedSteps;
  /** A refusal of the rules' own example, journalled through A2 with an origin G7 can weigh, in one of its three shapes. */
  refusal(shape: "proposal" | "derivation" | "input", over?: { code?: string; goal?: string }): ClaimedRefusal;
  /** The keys the accepted answers of this attempt carry, derived by their producer. */
  achieved(attempt: number, line?: number): string[];
}

/**
 * The managed block of one project, on a Store whose database file is `workspace.path`. The series itself is opened by
 * the caller (openSeries), as a block's line is; everything an attempt of it owns is produced here.
 */
export function managedBlock(store: Store, workspace: { root: string; path: string }, project: string,
  { block = `${project}-consume-block`, facts = 1 }: { block?: string; facts?: number } = {}): ManagedBlock {
  const f = definition(store, project, block);
  const scenario = join(workspace.root, `managed-scenario-${project}.json`);
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", join(workspace.root, `managed-trace-${project}.jsonl`)] };
  const config = reference(new ProductEngine(store).environments.configure(project, { workspace: workspace.root,
    implementer: { actor: "managed-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "managed-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: 100_000,
  }, store.get(`environment:${project}`)?.revision ?? 0));
  const adapter = reference(store.write({ id: `adapter:${project}:managed`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio" } }));
  const dispatch = { adapter, config };
  const steps: unknown[] = [];
  let plan = advance(store, project, block, f, null, facts);
  const opened = new Map<string, Opened>(), claims = new Map<string, GateOutcome>();
  const address = (line = 1): SeriesRequest => ({ project, block, line });
  const slot = (line: number, attempt: number): string => `${line}:${attempt}`;

  const bound = (s: Store): ManagedSteps => {
    const current = (): Plan => { if (plan.spent) plan = advance(s, project, block, f, plan, facts); return plan; };
    const goalOf = (batch: Batch, key: string): AttemptGoal => ({ key,
      questions: batch.items.map(item => gapLineKey(project, item.target, item.field)).sort(),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) });
    const ordinal = (line = 1): number => {
      const held = s.get<RepairSeries>(seriesId(project, block, line))!.value;
      return held.inherited.length + held.attempts.length + 1;
    };
    const opening = (attempt: number, key = "gap:cart:price", line = 1): BeginAttemptRequest => {
      const p = opened.get(slot(line, attempt))?.plan ?? current();
      const routes = opened.get(slot(line, attempt))?.routes ?? p.routes, batch = opened.get(slot(line, attempt))?.batch ?? p.batch;
      return { ...address(line), attempt, goal: goalOf(batch, key), completion: { routes: reference(routes), batches: [batch.id] } };
    };
    const api: ManagedSteps = {
      store: s,
      ordinal,
      goal: (key = "gap:cart:price") => goalOf(current().batch, key),
      opening,
      open(attempt, key = "gap:cart:price", line = 1, reshape = request => request) {
        const request = reshape(opening(attempt, key, line)), p = current();
        const series = take(openAttempt(s, request));
        if (!opened.has(slot(line, attempt))) opened.set(slot(line, attempt), { plan: p, routes: p.routes, batch: p.batch, series: reference(series) });
        return series;
      },
      async pay(attempt, ending, line = 1) {
        const at = opened.get(slot(line, attempt));
        if (!at) assert.fail(`Attempt ${attempt} of line ${line} was not opened through this block`);
        const packet = take(writeQuestionPacket(s, { project, routes: reference(at.routes), batch: at.batch.id, environment: config,
          attempt: { series: at.series, ordinal: attempt }, previous: [] })).record;
        steps.push(...(ending === "need-owner" ? [OWNER_STEP(at.batch)] : [IMPLEMENTER_STEP(f, at.batch), ...at.batch.items.map(() => ASSESSOR_STEPS[ending])]));
        writeFileSync(scenario, JSON.stringify({ database: workspace.path, steps }));
        const call = take(await runModelCall(s, { project, packet: reference(packet), dispatch, role: "implementer" }));
        if (ending === "need-owner") return;
        assert.equal(call.outcome?.kind, "fact-candidates");
        for (const item of at.batch.items) take(await assessFact(s, { project, modelCall: reference(call.record), questionId: item.gap, dispatch }));
      },
      claim(attempt, refusals = [], line = 1) {
        return take(prepareManagedClaim(s, { ...address(line), attempt,
          outcome: { reason: "result", accepting: [], cancelling: [], refusals: [...refusals] } })).outcome;
      },
      close(attempt, outcome, line = 1) {
        const closed = take(closeAttempt(s, { ...address(line), attempt, outcome }));
        if (!claims.has(slot(line, attempt))) claims.set(slot(line, attempt), outcome);
        const at = opened.get(slot(line, attempt));
        // A result answers the unknown of its plan: the next attempt stands on the one after it.
        if (outcome.reason === "result" && at && at.plan === plan) plan.spent = true;
        return closed;
      },
      claimed(attempt, line = 1) {
        const claim = claims.get(slot(line, attempt));
        if (!claim) assert.fail(`Attempt ${attempt} of line ${line} was not closed through this block`);
        return claim;
      },
      async cycle(key, ending, refusals = [], line = 1) {
        const attempt = ordinal(line);
        api.open(attempt, key, line);
        await api.pay(attempt, ending, line);
        return api.close(attempt, api.claim(attempt, refusals, line), line);
      },
    };
    return api;
  };

  const own = bound(store);
  return {
    ...own, project, block, address,
    on: bound,
    refusal(shape, over = {}) {
      const sources = shape === "proposal" ? assembly(store, project, f, { proposals: [["artifact:tax"]], bases: [false], derived: [["artifact:tax"]] })
        : shape === "derivation" ? assembly(store, project, f, { proposals: [[MANAGED_SUBJECT]], bases: [false], derived: [["artifact:order"]] })
        : assembly(store, project, f, { bases: [true], derived: [[MANAGED_SUBJECT]] });
      return journalled(store, project, { sources }, over);
    },
    achieved(attempt, line = 1) {
      const held = store.get<RepairSeries>(seriesId(project, block, line))!.value;
      return [...held.inherited, ...held.attempts].find(item => item.ordinal === attempt)!.outcome!.achieved.map(item => item.key);
    },
  };
}

/** One explicitly linked assembly of definitions; no journal or gate helper repairs the sources it names. */
function assembly(store: Store, project: string, f: Definition, shape: {
  proposals?: readonly (readonly string[])[]; bases?: readonly boolean[]; derived?: readonly (readonly string[])[];
}): OriginSource[] {
  const frame = shape.bases?.some(Boolean) ? f.accepted : f.first;
  const artifacts = (definitions: readonly string[]) => definitions.map(id => ({ ...structuredClone(f.upper.artifacts[0]!), id }));
  const proposals = (shape.proposals ?? []).map(definitions => reference(store.write({ id: `om-proposal:${project}:managed-${next()}`,
    kind: "layer-proposal", expected: 0, value: { base: { graph: frame.graph, frame: frame.frame }, level: frame.level,
      source: "decision", status: "proposed", nodes: [], fills: [], localConnectors: [], artifacts: artifacts(definitions), contracts: [],
      joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] } })));
  const request: ProposalRequest = { frame, proposals: [...proposals].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1) };
  const absentBase = shape.bases?.some(holds => !holds) ? take(readFrame(store, frame)).upperRef : null;
  return [
    ...proposals.map(ref => ({ role: "proposal", ref, context: { kind: "proposal", request } }) as OriginSource),
    ...(shape.bases ?? []).map(holds => ({ role: "base", ref: holds ? frame.graph : absentBase!, context: { kind: "frame", request: frame } }) as OriginSource),
    ...(shape.derived ?? []).map(definitions => {
      const graph = structuredClone(f.upper);
      graph.artifacts = [...graph.artifacts.filter(item => !definitions.includes(item.id)), ...artifacts(definitions)];
      const value: FrameCandidateRecord = { project, level: 2, graph, graphHash: hashJson(graph), layerHash: hashJson(projectGraph(graph, 2)),
        upperHash: hashJson(projectGraph(f.upper, 1)), base: { graph: frame.graph, frame: frame.frame }, proposals: request.proposals,
        fills: [], request };
      const id = `om-candidate:${project}:${hashJson([value.graphHash, value.base, value.proposals])}`;
      return { role: "derived", ref: reference(store.get(id) ?? store.write({ id, kind: "frame-candidate", expected: 0, value })) } as OriginSource;
    }),
  ];
}

/** A refusal a gate really wrote, journalled through the accepted API of A2. */
function journalled(store: Store, project: string, origin: Record<string, unknown>, over: { code?: string; goal?: string }): ClaimedRefusal {
  const name = over.code ?? `graph_invalid:${next()}`;
  const goal = over.goal ?? "every artifact an operation consumes is produced somewhere in the layer";
  const record = store.write({ id: `${unitRefusalNamespace(project)}managed:${next()}`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: "G3", refusals: [{ code: name, goal, remedy: "add the producer of the artifact to the proposal",
      origin: { name: "artifact_missing", stage: "layer-check", subject: MANAGED_SUBJECT, sources: [], ...origin } }] } as Json });
  const journal = take(recordRefusal(store, { project, source: reference(record) }));
  return { name, goal, row: journal.value.rows[journal.value.rows.length - 1]!.id };
}

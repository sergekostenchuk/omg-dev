import { recoverModelCall } from "../discovery/model-call-recovery.js";
import { recoverOmModelCall } from "../om/model-call.js";
import { readOmInput } from '../om/input.js';
import { configureDispatch } from '../om/dispatch.js';
import { continuePass, readPass, resumeStoppedPass, startPass, stopPass } from '../om/run-driver.js';
import { spendReport } from '../om/spend-report.js';
import { isPlainObject } from '../om/refusal.js';
import { writeGuarded } from '../om/refs.js';
import { prepareFeasibility, readFeasibility, type OmFeasibility } from '../om/feasibility.js';
import type { LayerBasis } from '../om/layer-basis.js';
// The product assembly point: loading ProductEngine installs the OM obligation
// reader pair into the lower graph slot before any consumer reads an OM era.
import '../om/obligations.js';
import { declareAdapterLineage } from '../adapters/adapter-lineage.js';
import { recoverResearchResponse } from '../discovery/response-recovery.js';
import { recoverContextSession } from '../discovery/context-recovery.js';
import { allocateResearchTrial } from '../discovery/research-trial.js';
import { retryPlannedRead } from '../discovery/reading-plan.js';
import { applyObligationPolicy } from '../graph/obligation-application.js';
import { observeRuntime, recoverRuntimeObservation } from '../runtime/runtime-observation.js';
import { continuePreparation, recoverLegacyOperation } from "./preparation-run.js";
import { mapStatus, saveMapStatus } from "../graph/map-status.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { STAGES, predecessor, reference, isRef, stageId, type Stage, type StageArtifact, type StageValidators,
  type GateContext, type GateResult, type Ref } from "../pipeline/contracts.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { REQUIREMENTS, LEGACY_REQUIREMENTS, VERSION2_REQUIREMENTS, VERSION3_REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import { GraphRepository } from "../graph/repository.js";
import { canonical, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { parseCommand } from "./commands.js";
import type { Graph } from "../graph/model.js";
import { Environments, transactionGuardsCurrent, uniqueTransactionGuards, workspacePath, type Environment } from "../runtime/environment.js";
import { Refinement, PHASES, type Feasibility } from "../graph/refinement.js";
import { buildL1 } from "../graph/builder.js";
import { projectGraph } from "../graph/project.js";
import type { ChatTurn } from "./chat.js";
import type { Source } from "../evidence/evidence.js";
import { Compiler, type MachinePlan } from "../compiler/compiler.js";
import { Executor } from "../execution/runner.js";
import { resultGate } from "../execution/result.js";
import type { TaskRun } from "../execution/model.js";
import type { ExecutionRoot } from "../runtime/environment.js";
import { Researcher } from "../discovery/research-runner.js";
import type { ResearchRun } from "../discovery/research-model.js";
import { preparationFindings } from "../discovery/preparation-validation.js";
import { PlanRepairs } from "./repairs.js";
import { StageResearch } from "./stage-research.js";
import { RefinementResearch } from "./refinement-research.js";
import { modelUsage } from "../runtime/model-usage.js";
import { configureReaderPilot, assertPilotBoundary } from "../discovery/reader-pilot.js";
import { configureSavedSynthesis } from "../discovery/saved-synthesis.js";

export interface Project { id: string; title: string }
export interface StageContent { draft: Ref; fields: Record<string, Json>; graph: Ref | null }

// These producer address spaces require B1 even when their saved envelope is incomplete.
// Shared pre-B1 records are handled below by their provenance fields, never by arbitrary text.
const recordObject = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const B1_PRODUCERS = Object.freeze([
  'horizon', 'om-horizon', 'series-transition', 'om-horizon-issuance', 'om-series-applied', 'om-series-discarded', 'om-series-era', 'om-analysis-admission',
  'block-weight', 'om-input-decision', 'om-gap', 'om-gap-lines', 'om-candidate',
  'om-answer-task', 'om-mc1-question', 'om-answer', 'om-answer-index', 'om-routes', 'om-answers-gate',
  'om-owner-gap-assignment', 'om-obligation-transfer', 'om-obligation-basis', 'om-obligations',
  'om-question-packet', 'om-part-response', 'om-part-result', 'om-part-assembly',
  'om-assessment-intent', 'om-assessment-result',
  'om-completion-owner', 'om-completion-era', 'om-completion-assignment', 'om-completion-work', 'om-completion-close', 'om-completion-cessation', 'om-completion-packet',
  'om-read-delivery', 'om-read-deliveries', 'om-model-cycle', 'om-model-exchange',
  'om-model-application-rejection', 'om-neighbors', 'om-atomic-gate', 'om-works-acceptance', 'om-work-rejection',
]);
function b1Address(project: string, id: unknown): boolean {
  // H1: the one pass of a project starts from its exact first B1, so its record is B1-born even when incomplete.
  return typeof id === 'string' && (id === `om-input:${project}` || id === `om-feasibility:${project}` || id === `om-series-current:${project}`
    || id === `om-run:${project}`
    || B1_PRODUCERS.some(namespace => id.startsWith(`${namespace}:${project}:`))
    || [2, 3].some(level => id === `om-frame:${project}:${level}`)
    || ['part', 'assembly'].some(source => id.startsWith(`om-proposal:${project}:${source}:`))
    || id.startsWith(`repair-series:${project}:mechanism:`));
}
// Paths end at declared Ref slots; * expands arrays only. Never descend into a leaf's contents.
function provenanceValues(value: unknown, path: string): unknown[] {
  let values: unknown[] = [value];
  for (const field of path.split('.')) values = values.flatMap(item => field === '*'
    ? Array.isArray(item) ? item : [] : recordObject(item) && Object.hasOwn(item, field) ? [item[field]] : []);
  return values;
}
function b1Reference(project: string, value: unknown): boolean {
  // Incomplete references still name lost dependencies, but arbitrary nested ids do not.
  return recordObject(value) && b1Address(project, value['id']);
}
const under = (prefix: string, paths: readonly string[]) => paths.map(path => `${prefix}.${path}`);
const FRAME_ORIGIN_REFS = Object.freeze(['graph', 'horizon', 'layer', 'frame', 'upper.horizon', 'upper.frame']);
const PROPOSAL_ORIGIN_REFS = Object.freeze([...under('frame', FRAME_ORIGIN_REFS), 'proposals.*']);
const GAP_ORIGIN_REFS = Object.freeze(['records.*', 'sources.input', 'sources.horizon', 'sources.graph',
  ...under('sources.operations', PROPOSAL_ORIGIN_REFS), 'sources.works.layer',
  ...under('sources.works', PROPOSAL_ORIGIN_REFS)]);
const CALL_ORIGIN_REFS = Object.freeze(['series', 'basis.series', 'basis.hold', 'basis.assessment', 'admission.routes',
  ...under('admission.gaps', GAP_ORIGIN_REFS)]);
interface ProvenanceFields {
  readonly refs: readonly string[];
  readonly sources: readonly string[];
  readonly owners: readonly string[];
}
function provenance(refs: readonly string[], sources: readonly string[] = [], owners: readonly string[] = []): ProvenanceFields {
  return Object.freeze({ refs: Object.freeze([...refs]), sources: Object.freeze([...sources]), owners: Object.freeze([...owners]) });
}
// Closed producer schema map. Unknown namespaces are not evidence of B1; fixed B1 addresses above are.
const B1_SHARED_ORIGINS: Readonly<Record<string, ProvenanceFields>> = Object.freeze({
  'om-assessment-intent': provenance(['source.modelCall', 'source.call', 'source.packet', 'source.response',
    'source.question', 'candidates.*.question', 'fact.question', 'originalSeries', 'series',
    'dispatch.adapter', 'dispatch.config', 'originalGuards.*']),
  'om-assessment-result': provenance(['intent', 'assessor', 'accepted', 'index', 'binding', 'assignment', 'work', 'call', 'receipt',
    'cause.source', 'cause.prerequisite.source', 'cause.prerequisite.context', 'cause.prerequisite.physical', 'cause.prerequisite.packet', 'cause.replacement', 'cause.proof', 'cause.appeared', 'cause.graph', 'cause.change.currentPointer']),
  'om-completion-owner': provenance(['series', 'previous', 'plan.routes']),
  'om-completion-era': provenance(['opening', 'binding']),
  'om-completion-assignment': provenance(['binding', 'parent', 'source']),
  'om-completion-packet': provenance(['binding', 'root', 'packet']),
  'om-completion-work': provenance(['binding', 'previous', 'assignments.*', 'products.*', 'journal', 'closed']),
  'om-completion-cessation': provenance(['binding', 'assignment', 'work', 'packet', 'call', 'ledger', 'physical', 'exchange', 'rejection',
    'cause.source', 'cause.prerequisite.source', 'cause.prerequisite.context', 'cause.prerequisite.physical', 'cause.prerequisite.packet', 'cause.replacement', 'cause.proof', 'cause.appeared', 'cause.graph', 'cause.change.currentPointer']),
  'om-completion-close': provenance(['binding', 'work', 'series', 'ledger', 'journal', 'claim.accepting.*', 'claim.cancelling.*', 'waiting.*']),
  'om-series-era': provenance(['firstManaged', 'origin.applied', 'origin.membership', 'origin.pointer']),
  'om-series-membership': provenance(['activation', 'roots.*.root']),
  'om-analysis-intent': provenance(['request.series', 'request.hold', 'sources.series', 'sources.journal', 'sources.holds.*',
    'report.guards.*', ...under('call', CALL_ORIGIN_REFS)], [], ['call.owner']),
  'om-proposal': provenance(['base.graph', 'base.frame', 'replaces.*.base.graph', 'verdict.candidate', 'verdict.gate',
    'verdict.refusal.at.ref', ...under('verdict.request', PROPOSAL_ORIGIN_REFS)]),
  'repair-series': provenance(['predecessor', 'inherited.*.outcome.achieved.*.basis', 'attempts.*.outcome.achieved.*.basis',
    'activation.registered', 'activation.applied', 'activation.prepared', 'activation.activeBasis', 'attempts.*.terminal',
    'continuations.*.review', 'continuations.*.input', 'continuations.*.confirmation', 'continuations.*.decision',
    'escalations.*.review', ...under('scope', GAP_ORIGIN_REFS), 'admissions.*.basis.routes',
    ...under('admissions.*.basis.gaps', GAP_ORIGIN_REFS)], [], ['owner']),
  'call-record': provenance([...CALL_ORIGIN_REFS, 'dispatch.adapter', 'dispatch.config'], [], ['owner']),
  'om-call-ledger': provenance(['calls.*.call', ...under('calls.*', CALL_ORIGIN_REFS)], [], ['calls.*.owner']),
  'om-origin-hold': provenance(['series', 'lift.record'], ['lift.basis.*'], ['owner']),
  'om-origin-analysis': provenance([], ['basis.*'], ['owner']),
  'om-origin-decision': provenance([], [], ['owner']),
  'om-stop-review': provenance([], [], ['owner']),
  'om-owner-decision': provenance([], [], ['owner']),
  'om-input-fix': provenance(['input']),
  'om-unit-refusal': provenance([], ['refusals.*.origin.sources.*']),
  'om-refusal-journal': provenance(['rows.*.source'], ['rows.*.origin.sources.*', 'classifications.*.basis.*']),
  'model-call': provenance(['request.record', 'response.record', 'recovery', 'profile', 'packet.archive', 'budget.segment',
    'runtime.declaration', 'om.request.dispatch.adapter', 'om.request.dispatch.config', 'om.input', 'om.call', 'om.exchange', 'om.part.proposal', 'om.part.result', 'om.diagnostic',
    'om.completionOwner.binding', 'om.completionOwner.assignment', 'om.completionOwner.call', 'om.completionOwner.packetBasis',
    'transport.completionOwner.binding', 'transport.completionOwner.assignment', 'transport.completionOwner.call', 'transport.completionOwner.packetBasis',
    'om.rejection', 'om.completion', 'om.failure.at.ref', 'om.request.packet', 'transport.exchange', 'transport.request.call',
    'om.admission.series', 'om.admission.pointer', 'om.terminal.source', 'om.terminal.call', 'om.terminal.series',
    'om.terminal.admission.series', 'om.terminal.admission.pointer', 'om.terminal.change.series', 'om.terminal.change.pointer',
    'om.terminal.change.applied', 'om.terminal.change.currentPointer']),
  'om-model-transport': provenance(['request.call', 'call']),
  'graph-layer': provenance(['acceptance.frame', 'inputs.*', 'obligations.*.inputs.*', 'layerProofs.*.inputs.*',
    'projection.researchObligations.*.scope']),
  'graph': provenance(['researchObligations.*.scope']),
  'discovery': provenance(['inputs.*', 'derivations.*.source']),
  'stage': provenance(['inputs.*', 'proofs.*']),
  'plan': provenance(['graph', 'environment', 'stage', 'feasibility', 'guards.*', 'tasks.*.inputs.*.receipt',
    'tasks.*.inputs.*.source', 'tasks.*.ownership.*.receipt', 'graphSnapshot.researchObligations.*.scope',
    'tasks.*.researchObligations.*.requirement.scope',
    'tasks.*.researchObligations.*.requirement.original.record',
    'tasks.*.researchObligations.*.requirement.documentaryAllowance.sources.*',
    'tasks.*.researchObligations.*.requirement.runtimeCheck.script',
    'tasks.*.researchObligations.*.requirement.runtimeCheck.dependencies.*']),
  'runtime-observation': provenance(['scope', 'environment', 'context.*', 'check.script', 'check.dependencies.*']),
  'writer-index': provenance([]),
});
const STAGE_CONTENT_ORIGINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'om-g2': Object.freeze(['content.feasibility']), compilation: Object.freeze(['content.plan']),
  execution: Object.freeze(['content.result']),
});
function namedB1References(project: string, value: unknown, paths: readonly string[]): boolean {
  return paths.some(path => provenanceValues(value, path).some(ref => b1Reference(project, ref)));
}
function b1OriginSource(project: string, value: unknown): boolean {
  if (!recordObject(value)) return false;
  if (b1Reference(project, value['ref'])) return true;
  const context = value['context'];
  if (!recordObject(context)) return false;
  if (context['kind'] === 'frame') return namedB1References(project, context['request'], FRAME_ORIGIN_REFS);
  if (context['kind'] === 'proposal') return namedB1References(project, context['request'], PROPOSAL_ORIGIN_REFS);
  return false;
}
/**
 * S1.5 (№2363): every address whose record savedB1Origin can accept in any revision — the fixed B1 addresses and the
 * namespaces of the producer table: those the project owns through the address itself, and the two whose ownership
 * is claimed only by a body, taken whatever project their current head names. Decided by the address alone, never by
 * a kind or by the text of a body, so the search below reads bodies and histories of these records only.
 */
function b1Candidate(project: string, id: string): boolean {
  if (b1Address(project, id)) return true;
  const namespace = id.split(':')[0]!;
  if (!Object.hasOwn(B1_SHARED_ORIGINS, namespace)) return false;
  return namespace === 'runtime-observation' || namespace === 'writer-index'
    || id.startsWith(`${namespace}:${project}:`) || id === `${namespace}:${project}`;
}
function savedB1Origin(project: string, record: Revision<unknown>): boolean {
  if (b1Address(project, record.id)) return true;
  const value = record.value;
  if (!recordObject(value)) return false;
  const namespace = record.id.split(':')[0]!;
  const belongs = namespace === 'runtime-observation' ? value['projectId'] === project
    : namespace === 'writer-index' ? value['project'] === project
    : record.id.startsWith(`${namespace}:${project}:`) || record.id === `${namespace}:${project}`;
  if (!belongs || !Object.hasOwn(B1_SHARED_ORIGINS, namespace)) return false;
  if (namespace === 'model-call' && !record.id.startsWith(`model-call:${project}:om:`)) return false;
  const fields = B1_SHARED_ORIGINS[namespace]!;
  return namedB1References(project, value, fields.refs)
    || fields.sources.some(path => provenanceValues(value, path).some(source => b1OriginSource(project, source)))
    || fields.owners.some(path => provenanceValues(value, path).some(owner => recordObject(owner)
      && owner['kind'] === 'mechanism' && owner['mechanism'] === 'M5:addressing'))
    || namespace === 'model-call' && b1Address(project, value['draftId'])
    || namespace === 'stage' && (Object.entries(STAGE_CONTENT_ORIGINS).some(([stage, paths]) =>
      record.id === stageId(project, stage as Stage) && namedB1References(project, value, paths))
      || UPSTREAM_STAGES.some(stage => record.id === stageId(project, stage))
        && namedB1References(project, value, ['content.draft', 'content.graph']))
    || namespace === 'writer-index' && value['contract'] === 'writer-index/om-m8-v1'
    || namespace === 'repair-series' && (value['contract'] === 'om-repair-series/v2'
      || recordObject(value['activation']) && value['activation']['contract'] === 'om-series-activation/v1')
    || namespace === 'om-series-membership' && value['mode'] === 'transition-managed';
}
export class ProductEngine {
  readonly discovery: Discovery;
  readonly graphs: GraphRepository;
  readonly pipeline: Pipeline;
  readonly environments: Environments;
  readonly refinement: Refinement;
  readonly compiler: Compiler;
  readonly executor: Executor;
  readonly researcher: Researcher;
  readonly repairs: PlanRepairs;
  readonly stageResearch: StageResearch;
  readonly refinementResearch: RefinementResearch;
  constructor(readonly store: Store, private readonly actor = "local-owner") {
    this.discovery = new Discovery(store); this.graphs = new GraphRepository(store, this.discovery);
    const validators = Object.fromEntries(STAGES.map(stage => [stage, (context: GateContext) => this.validateStage(stage, context)])) as unknown as StageValidators;
    this.pipeline = new Pipeline(store, validators);
    this.environments = new Environments(store);
    this.refinement = new Refinement(store, this.discovery, this.graphs, this.environments, this.pipeline);
    this.compiler = new Compiler(store, this.pipeline, this.refinement, this.environments);
    this.executor = new Executor(store, this.compiler, this.environments);
    this.researcher = new Researcher(store, this.discovery, this.environments);
    this.repairs = new PlanRepairs(this);
    this.stageResearch = new StageResearch(this);
    this.refinementResearch = new RefinementResearch(this, actor);
  }
  protected validateStage(stage: Stage, context: GateContext): GateResult {
    const rejected = (code: string, message: string): GateResult => ({ findings: [{ code, target: stage, message }], guards: [] });
    if (stage === "om-g2") {
      const content = context.content as { feasibility?: unknown } | null;
      if (!content || Object.keys(content).join(",") !== "feasibility" || !isRef(content.feasibility)) return rejected("feasibility_missing", "This stage requires a bound R3 result");
      return this.refinement.feasibilityGate(context.projectId, content.feasibility, context.accepted === true);
    }
    if (stage === "compilation") {
      const content = context.content as { plan?: unknown } | null;
      if (!content || Object.keys(content).join(",") !== "plan" || !isRef(content.plan)) return rejected("plan_missing", "Compilation stage requires a generated plan");
      return this.compiler.gate(context.projectId, content.plan, context.accepted === true);
    }
    if (stage === "execution") {
      const content = context.content as { result?: unknown } | null;
      if (!content || !isRef(content.result) || Object.keys(content).join(",") !== "result") return rejected("execution_result_missing", "Execution requires a complete committed result");
      return resultGate(this.store, context.projectId, content.result);
    }
    if (!UPSTREAM_STAGES.includes(stage as UpstreamStage)) return rejected("stage_not_available", "This execution-stage module is not connected yet");
    const content = context.content as unknown as StageContent;
    if (!content || typeof content !== "object" || !isRef(content.draft) || !content.fields
      || !Object.hasOwn(content, "graph") || Object.keys(content).sort().join(",") !== "draft,fields,graph") return rejected("stage_content_invalid", "Stage content must bind a discovery result and its fields");
    const draft = this.store.get<DiscoveryDraft>(content.draft.id);
    if (!draft || draft.value.stage !== stage || draft.value.projectId !== context.projectId
      || canonical(draft.value.fields) !== canonical(content.fields)) return rejected("discovery_foreign", "Research does not belong to this stage or its fields changed");
    const result = this.discovery.gate(context.projectId, content.draft);
    const version = draft.value.contractVersion ?? 1;
    const legacy = version === 1;
    if ((version !== RESEARCH_CONTRACT_VERSION && !context.accepted) || ![1, 2, 3, RESEARCH_CONTRACT_VERSION].includes(version))
      result.findings.push({ code: "research_contract_upgrade_required", target: stage, message: "New stage acceptance requires the enriched research contract; legacy history remains readable" });
    const expected = (legacy ? LEGACY_REQUIREMENTS : version === 2 ? VERSION2_REQUIREMENTS : version === 3 ? VERSION3_REQUIREMENTS : REQUIREMENTS)[stage as UpstreamStage];
    const specs = draft.value.questions.map(id => this.store.get<Question>(id)?.value.spec);
    if (canonical(specs) !== canonical(expected)) result.findings.push({ code: "research_contract_mismatch", target: stage, message: "Research questions do not match the stage's required fields" });
    if (!legacy && result.findings.length === 0) {
      const outcomes = this.store.get<{ projection: { artifacts: Graph['artifacts'] } }>(`graph-layer:${context.projectId}:1`);
      result.findings.push(...preparationFindings(stage, content.fields, name => {
        const source = this.store.get<StageArtifact>(stageId(context.projectId, name));
        return (source?.value.content as unknown as StageContent | undefined)?.fields ?? null;
      }, outcomes?.value.projection.artifacts.map(artifact => artifact.id) ?? []));
    }
    const prior = context.inputs[0];
    if (prior && !draft.value.inputs.some(input => input.id === prior.id && input.hash === prior.hash && input.revision === prior.revision)) result.findings.push({ code: "research_context_stale", target: stage, message: "Research must bind the accepted prerequisite used by this stage" });
    if (stage === "operation-map") {
      if (!isRef(content.graph)) result.findings.push({ code: "graph_missing", target: stage, message: "An operation map is required" });
      else { const graphResult = this.graphs.layerGate(context.projectId, 1, content.graph); result.findings.push(...graphResult.findings); result.guards.push(...graphResult.guards); }
      if ([3, 4].includes(version) && result.findings.length === 0) {
        const graph = this.store.get<Graph>(`graph:${context.projectId}`)!;
        const initial = this.store.get<StageArtifact>(stageId(context.projectId, "discovery"))!.value.content as unknown as StageContent;
        const concept = this.store.get<StageArtifact>(stageId(context.projectId, "concept"))!.value.content as unknown as StageContent;
        try {
          const proposed = buildL1(graph.value.id, graph.value.title, content.fields['mapDesign'], initial.fields, concept.fields);
          if (canonical(projectGraph(graph.value, 1)) !== canonical(projectGraph(proposed, 1))) result.findings.push({ code: "map_design_drift", target: graph.id, message: "Stored L1 must match the researched design and accepted concept" });
        } catch (error) { result.findings.push({ code: "map_design_invalid", target: stage, message: error instanceof Error ? error.message : "Invalid researched map" }); }
      }
    } else if (content.graph !== null) result.findings.push({ code: "graph_binding_unexpected", target: stage, message: "This stage inherits its map through the accepted prerequisite" });
    if (stage === "features") {
      const specification = prior?.value.content as unknown as StageContent;
      const behavior = specification?.fields['behavior'];
      const graph = this.store.get<{ projection: { artifacts: Graph['artifacts'] } }>(`graph-layer:${context.projectId}:1`);
      const features = content.fields['features'];
      const covered = new Set<number>();
      if (!Array.isArray(features) || !Array.isArray(behavior) || !graph) result.findings.push({ code: "feature_binding_missing", target: stage, message: "Features require a specification and operation map" });
      else for (const raw of features) {
        const feature = raw as { title: string; outcome: string; requirements: number[] };
        if (!graph.value.projection.artifacts.some(artifact => artifact.id === feature.outcome)) result.findings.push({ code: "feature_outcome_missing", target: feature.title, field: "features", message: "Feature outcome must exist in the operation map" });
        for (const index of feature.requirements) {
          if (!Number.isSafeInteger(index) || index < 0 || index >= behavior.length) result.findings.push({ code: "feature_requirement_missing", target: feature.title, field: "features", message: "Feature refers to a nonexistent requirement" });
          else covered.add(index);
        }
      }
      if (Array.isArray(behavior) && covered.size !== behavior.length) result.findings.push({ code: "requirement_uncovered", target: stage, field: "features", message: "Every specified behavior needs a feature" });
      const layer = this.graphs.layerGate(context.projectId, 1); result.findings.push(...layer.findings); result.guards.push(...layer.guards);
    }
    return result;
  }
  #project(id: string): Revision<Project> {
    const project = this.store.get<Project>(`project:${id}`);
    requireCondition(project && project.kind === "project", "project_missing", "Project does not exist"); return project;
  }
  prepare(project: string, stage: UpstreamStage): Revision<DiscoveryDraft> {
    this.#project(project);
    const prior = predecessor(stage); const inputs: Ref[] = [];
    if (prior) { const status = this.pipeline.inspect(project, prior); requireCondition(status.state === "accepted", "predecessor_not_ready", `${prior} must be accepted`); inputs.push(...status.guards); }
    const consumer = STAGES[STAGES.indexOf(stage) + 1]!;
    return this.discovery.forStage(project, stage, consumer, inputs);
  }
  draft(project: string, stage: UpstreamStage, draftId: string, expected: number): Revision<StageArtifact> {
    this.#project(project);
    const draft = this.store.get<DiscoveryDraft>(draftId);
    requireCondition(draft && draft.kind === "discovery-draft" && draft.value.stage === stage && draft.value.projectId === project,
      "discovery_foreign", "Research must belong to this project and stage");
    requireCondition(draft.value.contractVersion === RESEARCH_CONTRACT_VERSION, "research_contract_upgrade_required",
      "Prepare enriched research before creating a new stage result; previous accepted versions remain historical");
    const layer = stage === "operation-map" ? this.store.get(`graph-layer:${project}:1`) : null;
    const content = { draft: reference(draft), fields: draft.value.fields, graph: layer ? reference(layer) : null };
    return this.pipeline.draft(project, stage, content as unknown as Json, expected);
  }
  projection(project: string) {
    const currentPlan = this.store.get<Ref>(`current-plan:${project}`);
    const om = this.#omProject(project);
    const feasibilityId = `${om ? 'om-feasibility' : 'feasibility'}:${project}`;
    const feasibility = this.store.get<Feasibility>(feasibilityId);
    const drafts = this.store.list<DiscoveryDraft>("discovery-draft").filter(item => item.value.projectId === project);
    const research = new Map(drafts.map(draft => [draft.id, this.discovery.gate(project, reference(draft))]));
    const questions = this.store.list<Question>("question").filter(item => item.value.projectId === project).map(question => {
      const findings = (research.get(question.value.draftId)?.findings ?? []).filter(finding => finding.target === question.id
        || ["discovery_stale", "research_context_stale"].includes(finding.code));
      return { ...question, assessment: { state: question.value.status === "answered" && findings.length ? "stale" : question.value.status, findings } };
    });
    return { project: this.#project(project), stages: this.pipeline.project(project), graph: this.store.get<Graph>(`graph:${project}`),
      mapStatus: mapStatus(this.store, project),
      graphGate: this.graphs.gate(project),
      drafts, questions,
      sources: this.store.list<Source>("source").filter(item => item.value.projectId === project),
      environment: this.store.get<Environment>(`environment:${project}`),
      phases: PHASES.filter(phase => phase !== "R3").map(phase => ({ phase, record: this.store.get(`phase:${project}:${phase}`), gate: this.refinement.gate(project, phase) })),
      feasibility, feasibilityGate: feasibility ? this.refinement.feasibilityGate(project, reference(feasibility))
        : om ? { findings: [{ code: 'feasibility_missing', target: feasibilityId, message: 'The OM project requires an M8 assessment' }], guards: [] } : null,
      plans: this.store.list<MachinePlan>("plan").filter(item => item.value.projectId === project), currentPlan,
      planGate: currentPlan ? this.compiler.gate(project, currentPlan.value) : null,
      runs: this.store.list<TaskRun>("task-run").filter(item => item.value.projectId === project),
      executionRoot: this.store.get<ExecutionRoot>(`execution-root:${project}`),
      executionRunning: this.executor.isRunning(project),
      preparationRun: this.store.get(`preparation-run:${project}`),
      researchRuns: this.store.list<ResearchRun>("research-run").filter(item => item.value.projectId === project),
      chat: this.store.list<ChatTurn>("chat").filter(item => item.value.projectId === project).sort((a,b) => a.value.createdAt - b.value.createdAt),
    };
  }
  /** Capture the absent dependency before resolving the project era. It belongs only to new production. */
  legacyRoute(project: string): { om: boolean; guards: TransactionGuard[] } {
    const guards: TransactionGuard[] = [{ id: `om-input:${project}`, absent: true }];
    return { om: this.#omProject(project), guards };
  }
  #legacyProductionGuards(project: string): TransactionGuard[] {
    const route = this.legacyRoute(project);
    if (route.om)
      throw new EngineError('legacy_route_closed', 'New legacy production is closed after the first OM input',
        { unit: 'product', target: `om-input:${project}` });
    return route.guards;
  }
  #production<T>(project: string, guards: TransactionGuard[], produce: () => T): T {
    try { return produce(); }
    catch (error) {
      const id = `om-input:${project}`;
      if (error instanceof EngineError && error.code === 'input_stale'
        && guards.some(guard => guard.id === id && 'absent' in guard)
        && !transactionGuardsCurrent(this.store, [{ id, absent: true }]))
        throw new EngineError(error.code, error.message, { unit: 'product', target: id });
      throw error;
    }
  }
  #planProductionGuards(project: string, planRef: Ref): TransactionGuard[] {
    const plan = this.store.get<MachinePlan>(planRef.id, planRef.revision);
    // The publisher still proves this exact plan. Only the declared producer address selects the route.
    return plan?.value?.feasibility?.id === `om-feasibility:${project}` ? []
      : this.#legacyProductionGuards(project);
  }
  compile(project: string, extraGuards: TransactionGuard[] = []) {
    assertPilotBoundary(this.store, project, 'R3');
    this.#project(project);
    const route = this.legacyRoute(project);
    const basis = this.store.get<StageArtifact>(stageId(project, 'om-g2'));
    const feasibility = (basis?.value?.content as unknown as { feasibility?: Ref } | undefined)?.feasibility;
    const guards = uniqueTransactionGuards([...extraGuards,
      ...(feasibility?.id === `om-feasibility:${project}` && basis ? [reference(basis)] : route.guards)]);
    // Core compile/accept keep their existing no-write repeats. The negative dependency is checked
    // only if this command actually creates a plan, publishes a stage, or accepts a draft.
    return this.#production(project, guards, () => {
      const plan = this.compiler.compile(project, guards);
      const current = this.store.get<StageArtifact>(stageId(project, 'compilation'));
      if (current?.value.status === 'accepted' && (current.value.content as unknown as { plan?: Ref }).plan?.hash === plan.hash) return plan;
      const stage = this.compiler.publish(project, reference(plan), current?.revision ?? 0, guards);
      this.pipeline.accept(project, 'compilation', stage.revision, guards);
      return plan;
    });
  }
  /** The first B1 is an immutable era boundary, independent of current stage or layer readiness. */
  #omProject(project: string): boolean {
    const id = `om-input:${project}`;
    const first = this.store.get(id, 1);
    if (first) {
      const checked = readOmInput(this.store, project, reference(first));
      if (!checked.ok) throw new EngineError(checked.refusal.code, checked.refusal.message, checked.refusal.at);
      return true;
    }
    // S1.5 (№2363): without a first B1 the saved provenance is sought only where the predicate can find it. On a proven
    // genuine Store the candidates are chosen by identity, without decoding the bodies of foreign namespaces; any other
    // view — pending, trace, Proxy, subclass — keeps the full walk through its own reads, which its identities do not
    // describe. The predicate, its history walk and the refusal stay the same; a corrupt candidate still surfaces.
    const genuine = provenStore(this.store);
    const records = genuine
      ? genuine.identities('list').filter(row => b1Candidate(project, row.id)).flatMap(row => { const head = this.store.get(row.id); return head ? [head] : []; })
      : this.store.list();
    const savedOrigin = records.some(record => savedB1Origin(project, record)
      || this.store.history(record.id).some(revision => savedB1Origin(project, revision)));
    if (savedOrigin)
      throw new EngineError('record_missing', 'OM provenance requires the exact first B1 input',
        { unit: 'product', target: id, field: 'revision' });
    return false;
  }
  #assess(project: string, expected: number) {
    // Capture the negative dependency before selecting the legacy route, and keep it until its transaction.
    const legacyGuards: TransactionGuard[] = [{ id: `om-input:${project}`, absent: true }];
    if (!this.#omProject(project)) return this.refinement.assess(project, expected, legacyGuards);
    const id = `om-feasibility:${project}`;
    // This scalar command has no original source Refs: stale callers must reload the projection.
    const current = this.store.get(id);
    const original: TransactionGuard = current ? reference(current) : { id, absent: true };
    if ((current?.revision ?? 0) !== expected)
      throw new EngineError('revision_conflict', 'Reload the OM assessment before writing', { target: id, id, field: 'expected' });
    if (current) {
      const checked = readFeasibility(this.store, { project, record: reference(current) });
      if (!checked.ok) throw new EngineError(checked.refusal.code, checked.refusal.message, checked.refusal.at);
    }
    const graph = this.store.get<Graph>(`graph:${project}`);
    const layer = this.store.get<LayerBasis>(`graph-layer:${project}:3`);
    const environment = this.store.get<Environment>(`environment:${project}`);
    const frame = layer?.value?.acceptance?.frame;
    if (!graph || !environment || !layer || !isRef(frame))
      throw new EngineError('feasibility_source_missing', 'M8 requires an environment and the exact accepted work layer',
        { unit: 'M8', target: !graph ? `graph:${project}` : !environment ? `environment:${project}` : `graph-layer:${project}:3`,
          field: !graph ? 'graph' : !environment ? 'environment' : 'acceptance.frame' });
    const prepared = prepareFeasibility(this.store, { project, graph: reference(graph), layer: reference(layer), frame,
      environment: reference(environment), expected });
    if (!prepared.ok) {
      if (!transactionGuardsCurrent(this.store, [original]))
        throw new EngineError('revision_conflict', 'Reload the OM assessment before writing', { target: id, id, field: 'expected' });
      throw new EngineError(prepared.refusal.code, prepared.refusal.message, prepared.refusal.at);
    }
    const guards = uniqueTransactionGuards([original, ...prepared.value.guards]);
    try {
      // Even a current, unchanged result checks the captured head in a transaction. The explicit-Ref
      // producer's historical repeat is not the scalar command's concurrency contract.
      if (!prepared.value.writes.length) {
        this.store.writeMany([], guards);
        return prepared.value.record;
      }
      const written = writeGuarded<OmFeasibility>(this.store, { unit: 'M8', target: id, writes: prepared.value.writes, guards });
      if (!written.ok) throw new EngineError(written.refusal.code, written.refusal.message, written.refusal.at);
      return written.value[0]!;
    } catch (error) {
      if (!(error instanceof EngineError) || !['input_stale', 'revision_conflict'].includes(error.code)) throw error;
      if (!transactionGuardsCurrent(this.store, [original]))
        throw new EngineError('revision_conflict', 'Reload the OM assessment before writing', { target: id, id, field: 'expected' });
      const stale = guards.find(guard => !transactionGuardsCurrent(this.store, [guard]));
      throw new EngineError(error.code, error.message, { unit: 'M8', target: stale?.id ?? id,
        ...stale && !('absent' in stale) ? { ref: stale } : {} });
    }
  }
  exportStage(project: string, stage: Stage): string {
    this.#project(project); const projection = this.pipeline.inspect(project, stage);
    requireCondition(projection.artifact, "artifact_missing", "Stage has no artifact yet");
    return `# ${stage}\n\nState: ${projection.state}\nRevision: ${projection.artifact.revision}\nSHA-256: ${projection.artifact.hash}\n\n\`\`\`json\n${JSON.stringify(projection.artifact.value.content, null, 2)}\n\`\`\`\n`;
  }
  execute(input: unknown): unknown {
    const command = parseCommand(input);
    switch (command.type) {
      case 'recover-research-response': this.#project(command.project); return recoverResearchResponse(this.store, this.environments, command.project, command.call, command.session, this.actor);
      case 'declare-adapter-lineage': this.#project(command.project); return declareAdapterLineage(this.store, command.project, command, this.actor);
      case 'observe-runtime': this.#project(command.project); return observeRuntime(this.store,command.project,command);
      case 'recover-runtime-observation': this.#project(command.project); return recoverRuntimeObservation(this.store,command.project,command.observation);
      case 'apply-obligation-policy': this.#project(command.project); return applyObligationPolicy(this.store,command.project,command.scope,command.policy);
      case "recover-model-call": {
        this.#project(command.project);
        const value = this.store.get<Record<string, unknown>>(command.call.id)?.value;
        return value && ('om' in value || 'transport' in value)
          ? recoverOmModelCall(this.store, command.project, command.call)
          : recoverModelCall(this.store, command.project, command.call);
      }
      case 'recover-context-session': this.#project(command.project); return recoverContextSession(this.store,command.project,command.session,command.selector);
      case 'retry-planned-read': this.#project(command.project); return retryPlannedRead(this.store,command.project,command.child);
      case 'allocate-research-trial': this.#project(command.project); return allocateResearchTrial(this.store,command.project,command);
      case "recover-legacy-operation": this.#project(command.project); return recoverLegacyOperation(this,command);
      case "continue-preparation": this.#project(command.project); return continuePreparation(this,command.project,command.maxCalls);
      case "set-map-status": this.#project(command.project); return saveMapStatus(this.store,
        { projectId: command.project, base: command.base, nodes: command.nodes, actor: this.actor }, command.expected, this.environments.effective(command.project).root);
      case "research-stage": this.#project(command.project); return this.stageResearch.run(command.project, command.draftId, command.maxTurns);
      case "research-phase": this.#project(command.project); return this.refinementResearch.run(command.project, command.phase, command.draftId, command.maxTurns);
      case "model-usage": this.#project(command.project); return modelUsage(this.store, command.project, command.since);
      case "configure-reader-pilot": this.#project(command.project); return configureReaderPilot(this.store, this.environments, command.project, command.settings, command.expected);
      case "configure-saved-synthesis": {
        this.#project(command.project);
        const question = this.store.get<Question>(command.question);
        const draft = question && this.store.get<DiscoveryDraft>(question.value.draftId);
        requireCondition(question?.kind === "question" && question.value.projectId === command.project
          && draft?.kind === "discovery-draft" && draft.value.projectId === command.project && draft.value.questions.includes(question.id),
          "research_question_foreign", "Saved synthesis must target a question and draft of this project");
        return configureSavedSynthesis(this.store, question.id, command.expected);
      }
      case "research-draft": this.#project(command.project); return this.researcher.run(command.project, command.draftId, command.maxTurns);
      case "execute-plan": this.#project(command.project); assertPilotBoundary(this.store, command.project, "execution"); return this.executor.run(command.project, command.plan, command);
      case "stop-execution": this.#project(command.project); return { stopped: this.executor.stop(command.project) };
      case "recover-execution": this.#project(command.project); return this.executor.recover(command.project);
      case "repair-plan": this.#project(command.project); return this.repairs.run(command.project, command.run, command.maxTurns);
      case "configure": this.#project(command.project); return this.environments.configure(command.project, command.environment, command.expected);
      case "configure-om-dispatch": {
        // Legal before and after the first B1: the adapter is a setting, never evidence of the OM era.
        this.#project(command.project);
        const configured = configureDispatch(this.store, { project: command.project, protocol: command.protocol });
        if (!configured.ok) throw new EngineError(configured.refusal.code, configured.refusal.message, configured.refusal.at);
        return configured.value;
      }
      // H2: the pass of a project through the common H1.3 driver and F8.3 report; their outcomes and refusals are the answer.
      case "om-start": this.#project(command.project);
        return startPass(this.store, { project: command.project, ...(command.outcomes ? { outcomes: command.outcomes } : {}) });
      case "om-continue": {
        this.#project(command.project);
        // The named resume is decided first, and only its success continues; no transaction spans both (№2131-2).
        if (command.resumeStop !== undefined) {
          const resumed = resumeStoppedPass(this.store, { project: command.project, stop: command.resumeStop });
          if (!resumed.ok) return Promise.resolve(resumed);
        }
        return continuePass(this.store, { project: command.project });
      }
      case "om-state": this.#project(command.project); return readPass(this.store, { project: command.project });
      case "om-spend": this.#project(command.project); return spendReport(this.store, { project: command.project });
      case "om-stop": this.#project(command.project); return stopPass(this.store, { project: command.project });
      case "begin-research": this.#project(command.project); return this.refinement.begin(command.project, command.level);
      case "finish-research": this.#project(command.project); return this.refinement.finishResearch(command.project, command.level, command.draft, command.expected);
      case "seal-layer": this.#project(command.project); return this.refinement.sealLayer(command.project, command.level, command.expected);
      case "prepare-layer": this.#project(command.project); return this.refinement.prepareLayer(command.project, command.level);
      case "build-layer": this.#project(command.project); return this.refinement.buildLayer(command.project, command.level, command.draft, command.expected, this.actor);
      case "task-context": this.#project(command.project); return this.compiler.context(command.project, command.plan, command.task, command.maxChars);
      case "task-detail": this.#project(command.project); return this.compiler.detail(command.project, command.plan, command.task, command.kind, command.selector, command.maxChars);
      case "assess": this.#project(command.project); return this.#assess(command.project, command.expected);
      case "draft-om": {
        this.#project(command.project);
        const guards = command.feasibility.id === `om-feasibility:${command.project}` ? [] : this.#legacyProductionGuards(command.project);
        return this.#production(command.project, guards, () => this.refinement.publish(command.project, command.feasibility, command.expected, guards));
      }
      case "compile": return this.compile(command.project);
      case "draft-plan": {
        this.#project(command.project); assertPilotBoundary(this.store, command.project, "R3");
        const guards = this.#planProductionGuards(command.project, command.plan);
        return this.#production(command.project, guards, () => this.compiler.publish(command.project, command.plan, command.expected, guards));
      }
      case "create-project": return this.store.write<Project>({ id: `project:${command.project}`, kind: "project", expected: 0, value: { id: command.project, title: command.title } });
      case "prepare-stage": return this.prepare(command.project, command.stage);
      case "source-document": this.#project(command.project); return this.discovery.evidence.document(command.project, command.id, command.text, command.media, command.expected);
      case "source-file": {
        this.#project(command.project); const effective = this.environments.effective(command.project);
        workspacePath(effective.root, command.path);
        return this.discovery.evidence.file(command.project, command.id, effective.root, command.path, command.media, command.expected);
      }
      case "answer-decision": return this.discovery.decision(command.question, command.expected, this.actor, command.value);
      case "answer-fact": return this.discovery.fact(command.question, command.expected, command.source, command.selector);
      case "reopen-question": return this.discovery.reopen(command.question, command.expected);
      case "save-graph": this.#project(command.project); return this.graphs.save(command.project, command.graph, command.expected, this.actor);
      case "build-map": {
        const project = this.#project(command.project); const draft = this.store.get<DiscoveryDraft>(command.draftId);
        requireCondition(draft && draft.kind === "discovery-draft" && draft.value.stage === "operation-map"
          && draft.value.projectId === command.project, "discovery_foreign", "Map construction needs this project's map-stage research");
        requireCondition(this.discovery.gate(command.project, reference(draft)).findings.length === 0,
          "research_unresolved", "Resolve the map-stage questions first");
        const prerequisite = this.pipeline.inspect(command.project, "concept");
        requireCondition(prerequisite.state === "accepted" && prerequisite.artifact
          && draft.value.contractVersion === RESEARCH_CONTRACT_VERSION
          && draft.value.inputs.some(ref => canonical(ref) === canonical(reference(prerequisite.artifact!)))
          && canonical(draft.value.questions.map(id => this.store.get<Question>(id)!.value.spec)) === canonical(REQUIREMENTS['operation-map']),
        "research_context_stale", "Map construction must use the current accepted concept and complete research contract");
        const initial = this.store.get<StageArtifact>(stageId(command.project, "discovery"))!.value.content as unknown as StageContent;
        const concept = this.store.get<StageArtifact>(stageId(command.project, "concept"))!.value.content as unknown as StageContent;
        const existing = this.store.get<Graph>(`graph:${command.project}`);
        const graph = buildL1(existing?.value.id ?? `${command.project}:map`, project.value.title, draft.value.fields['mapDesign'], initial.fields, concept.fields);
        return this.graphs.saveDerived(command.project, graph, command.expected, this.actor, reference(draft));
      }
      case "refine-graph": this.#project(command.project); return this.graphs.refine(command.project, command.expected, command.draft, this.actor);
      case "draft-stage": return this.draft(command.project, command.stage, command.draftId, command.expected);
      case "accept-stage": {
        this.#project(command.project);
        if (["om-g2", "compilation", "execution"].includes(command.stage)) assertPilotBoundary(this.store, command.project, "R3");
        let guards: TransactionGuard[] = [];
        if (command.stage === 'om-g2' || command.stage === 'compilation') {
          const route = this.legacyRoute(command.project);
          const artifact = this.store.get<StageArtifact>(stageId(command.project, command.stage));
          const content = artifact?.value?.content as unknown as { feasibility?: Ref; plan?: Ref } | undefined;
          const plan = isRef(content?.plan) ? this.store.get<MachinePlan>(content.plan.id, content.plan.revision) : null;
          const om = command.stage === 'om-g2' ? content?.feasibility?.id === `om-feasibility:${command.project}`
            : plan?.value?.feasibility?.id === `om-feasibility:${command.project}`;
          guards = uniqueTransactionGuards([...(artifact ? [reference(artifact)] : []), ...(om ? [] : route.guards)]);
        }
        return this.#production(command.project, guards, () => this.pipeline.accept(command.project, command.stage, command.expected, guards));
      }
      case "project": return this.projection(command.project);
      case "export-stage": return this.exportStage(command.project, command.stage);
    }
  }
}

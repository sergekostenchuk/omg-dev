import { discoveryOutcome } from '../discovery/discovery-outcome.js';
import { readOmInput } from '../om/input.js';
import { isPlainObject } from '../om/refusal.js';
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { STAGES, reference, isRef, stageId, type Stage, type StageArtifact, type StageValidators,
  type GateContext, type GateResult, type Ref, type Finding } from "../pipeline/contracts.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { REQUIREMENTS, LEGACY_REQUIREMENTS, VERSION2_REQUIREMENTS, VERSION3_REQUIREMENTS, VERSION4_REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import { GraphRepository } from "../graph/repository.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import type { Graph } from "../graph/model.js";
import { Environments, transactionGuardsCurrent, uniqueTransactionGuards } from "../runtime/environment.js";
import { Refinement } from "../graph/refinement.js";
import { buildL1 } from "../graph/builder.js";
import { projectGraph } from "../graph/project.js";
import { Compiler, type MachinePlan } from "../compiler/compiler.js";
import { resultGate } from "../execution/result.js";
import { preparationFindings } from "../discovery/preparation-validation.js";
import { assertPilotBoundary } from "../discovery/reader-pilot.js";
import { readModelCallRecovery } from "../discovery/model-call-recovery.js";

/**
 * R2 (№2419): the stage checks, the era of a project and compile — one lower kit, so the OM modules that inspect a
 * stage, gate a layer or a refinement, or compile, never build a ProductEngine. ProductEngine holds these same
 * instances and delegates; this module never imports it. Its state is the Store or view it was given: no global
 * instance, no cache, and a traced or guarded view is never unwrapped. The validators are only bound here; the
 * Pipeline calls them after the kit is complete.
 */
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
/**
 * Q4 (№2563-3, №2568-1): the literal head prefixes whose union is a superset of b1Candidate. A shared namespace's
 * `${namespace}:${project}` covers its exact address and every deeper one; the two spaces whose owner lives in the
 * body are selected whole — bare `runtime-observation`/`writer-index` ids included — because savedB1Origin decides
 * ownership from any revision, never from the address alone. The fixed B1 addresses stand as their own prefixes.
 */
function b1CandidatePrefixes(project: string): string[] {
  return [`om-input:${project}`, `om-feasibility:${project}`, `om-series-current:${project}`, `om-run:${project}`,
    `om-frame:${project}:`, 'runtime-observation', 'writer-index',
    ...new Set([...B1_PRODUCERS, ...Object.keys(B1_SHARED_ORIGINS)].map(namespace => `${namespace}:${project}`))];
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
export class StageChecks {
  readonly discovery: Discovery;
  readonly graphs: GraphRepository;
  readonly pipeline: Pipeline;
  readonly environments: Environments;
  readonly refinement: Refinement;
  readonly compiler: Compiler;
  constructor(readonly store: Store) {
    this.discovery = new Discovery(store); this.graphs = new GraphRepository(store, this.discovery);
    const validators = Object.fromEntries(STAGES.map(stage => [stage, (context: GateContext) => this.validateStage(stage, context)])) as unknown as StageValidators;
    this.pipeline = new Pipeline(store, validators);
    this.environments = new Environments(store);
    this.refinement = new Refinement(store, this.discovery, this.graphs, this.environments, this.pipeline);
    this.compiler = new Compiler(store, this.pipeline, this.refinement, this.environments);
  }
  validateStage(stage: Stage, context: GateContext): GateResult {
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
    let outcome: ReturnType<typeof discoveryOutcome>;
    try { outcome = discoveryOutcome(this.store, draft); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return rejected(error.code, error.message);
    }
    const result = this.discovery.gate(context.projectId, content.draft);
    result.findings.push(...outcome.findings); result.guards.push(...outcome.guards);
    const version = draft.value.contractVersion ?? 1;
    const legacy = version === 1;
    if ((version !== RESEARCH_CONTRACT_VERSION && !context.accepted) || ![1, 2, 3, 4, RESEARCH_CONTRACT_VERSION].includes(version))
      result.findings.push({ code: "research_contract_upgrade_required", target: stage, message: "New stage acceptance requires the enriched research contract; legacy history remains readable" });
    const expected = (legacy ? LEGACY_REQUIREMENTS : version === 2 ? VERSION2_REQUIREMENTS : version === 3 ? VERSION3_REQUIREMENTS : version === 4 ? VERSION4_REQUIREMENTS : REQUIREMENTS)[stage as UpstreamStage];
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
      if ([3, 4, 5].includes(version) && result.findings.length === 0) {
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
  project(id: string): Revision<Project> {
    const project = this.store.get<Project>(`project:${id}`);
    requireCondition(project && project.kind === "project", "project_missing", "Project does not exist"); return project;
  }
  /** Capture the absent dependency before resolving the project era. It belongs only to new production. */
  legacyRoute(project: string): { om: boolean; guards: TransactionGuard[] } {
    const guards: TransactionGuard[] = [{ id: `om-input:${project}`, absent: true }];
    return { om: this.omProject(project), guards };
  }
  legacyProductionGuards(project: string): TransactionGuard[] {
    const route = this.legacyRoute(project);
    if (route.om)
      throw new EngineError('legacy_route_closed', 'New legacy production is closed after the first OM input',
        { unit: 'product', target: `om-input:${project}` });
    return route.guards;
  }
  production<T>(project: string, guards: TransactionGuard[], produce: () => T): T {
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
  planProductionGuards(project: string, planRef: Ref): TransactionGuard[] {
    const plan = this.store.get<MachinePlan>(planRef.id, planRef.revision);
    // The publisher still proves this exact plan. Only the declared producer address selects the route.
    return plan?.value?.feasibility?.id === `om-feasibility:${project}` ? []
      : this.legacyProductionGuards(project);
  }
  compile(project: string, extraGuards: TransactionGuard[] = []) {
    assertPilotBoundary(this.store, project, 'R3');
    this.project(project);
    const route = this.legacyRoute(project);
    const basis = this.store.get<StageArtifact>(stageId(project, 'om-g2'));
    const feasibility = (basis?.value?.content as unknown as { feasibility?: Ref } | undefined)?.feasibility;
    const guards = uniqueTransactionGuards([...extraGuards,
      ...(feasibility?.id === `om-feasibility:${project}` && basis ? [reference(basis)] : route.guards)]);
    // Core compile/accept keep their existing no-write repeats. The negative dependency is checked
    // only if this command actually creates a plan, publishes a stage, or accepts a draft.
    return this.production(project, guards, () => {
      const plan = this.compiler.compile(project, guards);
      const current = this.store.get<StageArtifact>(stageId(project, 'compilation'));
      if (current?.value.status === 'accepted' && (current.value.content as unknown as { plan?: Ref }).plan?.hash === plan.hash) return plan;
      const stage = this.compiler.publish(project, reference(plan), current?.revision ?? 0, guards);
      this.pipeline.accept(project, 'compilation', stage.revision, guards);
      return plan;
    });
  }
  /** The first B1 is an immutable era boundary, independent of current stage or layer readiness. */
  omProject(project: string): boolean {
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
    const seen = new Set<string>(), records: Revision<unknown>[] = [];
    if (genuine) {
      for (const prefix of b1CandidatePrefixes(project))
        for (const row of genuine.identities('prefix', prefix))
          if (b1Candidate(project, row.id) && !seen.has(row.id)) {
            seen.add(row.id);
            const head = this.store.get(row.id);
            if (head) records.push(head);
          }
    } else records.push(...this.store.list());
    const savedOrigin = records.some(record => savedB1Origin(project, record)
      || this.store.history(record.id).some(revision => savedB1Origin(project, revision)));
    if (savedOrigin)
      throw new EngineError('record_missing', 'OM provenance requires the exact first B1 input',
        { unit: 'product', target: id, field: 'revision' });
    return false;
  }
}

/* R2 (№2427): the reader of a legacy operation and its whole proof chain, moved unchanged from preparation-run so OM
 * reads it without the product layer above; begin/finish/recover stay there and call these same checks. */
export interface PreparationRun {projectId:string;status:'running'|'paused'|'accepted';phase:string;draft:Ref|null;plan:Ref|null;
  owner:{pid:number;started:string};error:string|null;code:string|null;findings:Finding[];calls:number}
export interface LegacyOperation {
 contract:'legacy-operation/v1'; projectId:string; operation:'prepare'|'repair'; token:string;
 basis:Ref; owner:{pid:number;started:string}; state:'active'|'released'; previous:Ref|null;
 release:null|{from:Ref;reason:'returned'|'failed'|'recovered';result:Ref|null;error:{code:string;message:string}|null;
  dispatch:TransactionGuard;calls:Ref[];parking:Ref|null};
}
export const legacyObject=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const legacySame=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
export function legacyFailure(project:string,code:string,message:string):never{
 throw new EngineError(code,message,{unit:'product',target:`legacy-operation:${project}`});
}
export function legacyExact(store:Store,project:string,ref:Ref,kind?:string):Revision<any>{
 if(!isRef(ref))legacyFailure(project,'legacy_operation_invalid','An exact operation source is required');
 const record=store.get(ref.id,ref.revision);
 if(!record||!legacyObject(record.value)||!legacySame(reference(record),ref)||hashJson(record.value)!==ref.hash||(kind&&record.kind!==kind))
  legacyFailure(project,'legacy_operation_invalid','An exact operation source is unavailable');
 return record;
}
function preparationResultShape(value:unknown):value is PreparationRun{
 return legacyObject(value)&&typeof value.projectId==='string'&&['running','paused','accepted'].includes(value.status)
  &&['R2','L3','R3','compilation'].includes(value.phase)&&(value.draft===null||isRef(value.draft))
  &&(value.plan===null||isRef(value.plan))&&legacyObject(value.owner)&&Number.isSafeInteger(value.owner.pid)&&value.owner.pid>0
  &&typeof value.owner.started==='string'&&value.owner.started.length>0&&(value.error===null||typeof value.error==='string')
  &&(value.code===null||typeof value.code==='string')&&Number.isSafeInteger(value.calls)&&value.calls>=0
  &&Array.isArray(value.findings)&&value.findings.every(item=>legacyObject(item)&&typeof item.code==='string'
   &&typeof item.target==='string'&&typeof item.message==='string'&&(item.field===undefined||typeof item.field==='string'));
}
// The release writer and historical reader use this same completion contract.
function checkedLegacyResult(store:Store,project:string,operation:LegacyOperation,proof:NonNullable<LegacyOperation['release']>):void{
 const failure=legacyObject(proof.error)&&typeof proof.error.code==='string'&&proof.error.code.length>0
  &&typeof proof.error.message==='string'&&proof.error.message.length>0;
 if(!(proof.reason==='returned'?isRef(proof.result)&&proof.error===null
  :proof.reason==='failed'?failure:proof.reason==='recovered'&&proof.result===null&&proof.error===null))
  legacyFailure(project,'legacy_operation_invalid','Release reason requires its saved result or failure');
 if(proof.result===null)return;
 const result=legacyExact(store,project,proof.result),value=result.value;
 if(operation.operation==='prepare'){
  if(result.kind!=='preparation-run'||result.id!==operation.basis.id||result.revision<=operation.basis.revision
   ||!preparationResultShape(value)||value.projectId!==project||!legacySame(value.owner,operation.owner)
   ||!['paused','accepted'].includes(value.status)
   ||(value.status==='accepted'?value.phase!=='compilation'||value.draft!==null||!isRef(value.plan)||value.error!==null||value.code!==null:value.plan!==null))
   legacyFailure(project,'legacy_operation_invalid','Release needs this preparation\'s complete terminal result');
  // A later invocation may have the same pid. Its result cannot finish this one:
  // the first terminal revision ends the preparation that began at basis.
  for(let revision=operation.basis.revision;revision<result.revision;revision++){
   const prior=store.get<PreparationRun>(result.id,revision);
   if(!prior||prior.kind!=='preparation-run'||hashJson(prior.value)!==prior.hash||!preparationResultShape(prior.value)
    ||prior.value.projectId!==project||prior.value.status!=='running'||!legacySame(prior.value.owner,operation.owner))
    legacyFailure(project,'legacy_operation_invalid','The result must end this exact preparation invocation');
  }
  if(value.draft&&legacyExact(store,project,value.draft,'discovery-draft').value.projectId!==project)
   legacyFailure(project,'legacy_operation_invalid','The preparation result has a foreign draft');
 }else{
  if(result.kind!=='plan-repair'||result.id!==`plan-repair:${hashJson(operation.basis)}`||value.projectId!==project
   ||!isRef(value.run)||!legacySame(value.run,operation.basis)||!isRef(value.defect)||!isRef(value.parked)
   ||![1,2].includes(value.level)||!['research','design','compile','reissued'].includes(value.phase)
   ||typeof value.draftId!=='string'||!value.draftId.trim()||!(value.plan===null||isRef(value.plan))
   ||!(value.error===null||typeof value.error==='string')||!legacySame(value.parked,proof.parking)
   ||(value.phase==='reissued'?!isRef(value.plan)||value.error!==null||value.level!==2:value.plan!==null))
   legacyFailure(project,'legacy_operation_invalid','Release needs this repair\'s complete saved result');
  const failed=legacyExact(store,project,operation.basis,'task-run'),defect=legacyExact(store,project,value.defect,'plan-defect');
  const parked=legacyExact(store,project,value.parked,'parked-candidate');
  if(defect.id!==`plan-defect:${hashJson(operation.basis)}`||defect.value.projectId!==project||!isRef(defect.value.run)
   ||!legacySame(defect.value.run,operation.basis)||!isRef(failed.value.plan)||!isRef(defect.value.plan)||!legacySame(defect.value.plan,failed.value.plan)
   ||!isRef(defect.value.parked)||!legacySame(defect.value.parked,value.parked)||parked.value.projectId!==project
   ||!isRef(parked.value.run)||!legacySame(parked.value.run,operation.basis)||parked.value.state!=='parked')
   legacyFailure(project,'legacy_operation_invalid','The repair result has foreign defect or parking grounds');
 }
 if(value.plan&&legacyExact(store,project,value.plan,'plan').value.projectId!==project)
  legacyFailure(project,'legacy_operation_invalid','The saved result has a foreign plan');
}
export function checkedLegacyOperation(store:Store,project:string,record:Revision<LegacyOperation>):Revision<LegacyOperation>{
 const v=record.value,id=`legacy-operation:${project}`;
 if(record.id!==id||record.kind!=='legacy-operation'||!legacyObject(v)||hashJson(v)!==record.hash
  ||v.contract!=='legacy-operation/v1'||v.projectId!==project||!['prepare','repair'].includes(v.operation)
  ||typeof v.token!=='string'||!v.token.trim()||!isRef(v.basis)||!legacyObject(v.owner)
  ||!Number.isSafeInteger(v.owner.pid)||v.owner.pid<=0||typeof v.owner.started!=='string'||!v.owner.started
  ||!['active','released'].includes(v.state)||!Object.hasOwn(v,'previous')||!Object.hasOwn(v,'release'))
  legacyFailure(project,'legacy_operation_invalid','The operation marker has an invalid contract');
 const source=legacyExact(store,project,v.basis,v.operation==='prepare'?'preparation-run':'task-run');
 if(source.value?.projectId!==project||(v.operation==='prepare'
  ?source.id!==`preparation-run:${project}`||source.value.status!=='running'||!legacyObject(source.value.owner)||!legacySame(source.value.owner,v.owner)
  :source.value.state!=='needs_plan'))legacyFailure(project,'legacy_operation_invalid','The operation has a foreign starting basis');
 const active=v.state==='active'?record:legacyExact(store,project,v.release?.from as Ref,'legacy-operation') as Revision<LegacyOperation>;
 if(v.state==='released'){
  const proof=v.release;
  if(!legacyObject(proof)||!isRef(proof.from)||proof.from.id!==id||proof.from.revision!==record.revision-1
   ||active.value.state!=='active'||!legacySame({...active.value,state:'released',release:proof},v)
   ||!['returned','failed','recovered'].includes(proof.reason)||!(proof.result===null||isRef(proof.result))
   ||!(proof.parking===null||isRef(proof.parking))||!Array.isArray(proof.calls)||!proof.calls.every(isRef)
   ||!(proof.error===null||legacyObject(proof.error)&&typeof proof.error.code==='string'&&typeof proof.error.message==='string'))
   legacyFailure(project,'legacy_operation_invalid','Release must retain the exact completed ownership');
  if(!legacyObject(proof.dispatch))legacyFailure(project,'legacy_operation_invalid','Release has no dispatch boundary');
  try{uniqueTransactionGuards([proof.dispatch]);}
  catch{legacyFailure(project,'legacy_operation_invalid','Release has an invalid dispatch boundary');}
  if(proof.dispatch.id!==`project-dispatch:${hashJson(project)}`
   ||new Set(proof.calls.map(ref=>ref.id)).size!==proof.calls.length)
   legacyFailure(project,'legacy_operation_invalid','Release must retain its dispatch boundary and complete call identities');
  if(!('absent' in proof.dispatch))legacyExact(store,project,proof.dispatch,'project-dispatch');
  for(const ref of proof.calls){const call=legacyExact(store,project,ref,'model-call');
   if(call.value.projectId!==project||!['succeeded','failed'].includes(call.value.status)||!Number.isFinite(call.value.finishedAt))
    legacyFailure(project,'legacy_operation_invalid','A released operation cannot retain unfinished calls');
   if(call.value.error==='process_lost'&&call.value.execution)readModelCallRecovery(store,project,ref);
  }
  checkedLegacyResult(store,project,v,proof);
  if(proof.parking){const parked=legacyExact(store,project,proof.parking,'parked-candidate');
   if(v.operation!=='repair'||parked.value.projectId!==project||parked.value.state!=='parked'||!isRef(parked.value.run)||!legacySame(parked.value.run,v.basis))
    legacyFailure(project,'legacy_operation_invalid','Release has a foreign parking result');
  }
 }
 if(active.value.release!==null||active.value.state!=='active')legacyFailure(project,'legacy_operation_invalid','Ownership must begin active');
 if(active.revision===1){if(active.value.previous!==null)legacyFailure(project,'legacy_operation_invalid','Initial ownership has no predecessor');}
 else{
  if(!isRef(active.value.previous)||active.value.previous.id!==id||active.value.previous.revision!==active.revision-1)
   legacyFailure(project,'legacy_operation_invalid','Ownership must follow its exact released predecessor');
  const prior=legacyExact(store,project,active.value.previous,'legacy-operation') as Revision<LegacyOperation>;
  if(prior.value.state!=='released'||prior.value.token===v.token)legacyFailure(project,'legacy_operation_invalid','Ownership cannot replace active or reuse its token');
  checkedLegacyOperation(store,project,prior);
 }
 return record;
}
export function readLegacyOperation(store:Store,project:string):Revision<LegacyOperation>|null{
 if(!store||typeof store.get!=='function'||typeof project!=='string'||!project.trim())
  throw new EngineError('legacy_operation_invalid','A project and Store are required');
 const record=store.get<LegacyOperation>(`legacy-operation:${project}`);
 return record?checkedLegacyOperation(store,project,record):null;
}

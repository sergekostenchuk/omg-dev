import { provenStore } from "../storage/store-view.js";
import { researchScope, scopedQuestions, researchGapDeferred, type ResearchScope } from "./research-scope.js";
import { Store, storeObserved, type Revision, type TransactionGuard } from "../storage/store.js";
import { Discovery, type ResearchLevel } from "../discovery/discovery.js";
import { orderedSpecs, readDraft, type DiscoveryDraft, type FieldSpec }
  from "../discovery/projection-reader.js";
import { GraphRepository } from "./repository.js";
import { Environments, git, inspectRepository, uniqueTransactionGuards, transactionGuardsCurrent, type Environment, type ExecutionRoot, type RepositoryState } from "../runtime/environment.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { STAGE_CLOSURE_CONTRACT, reference, isRef, uniqueRefs, stageId, type StageArtifact, type Ref, type GateResult, type Finding, type ExternalCheckHandlers } from "../pipeline/contracts.js";
import { canonical, type Json } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import type { Graph } from "./model.js";
import { sourceIsCurrent, withSourceMemo, type Source } from "../evidence/evidence.js";
import { derivedDraft, type Derivation } from "../discovery/derived-draft.js";
import { REFINEMENT_CONTRACT_VERSION, refinementQuestions, deferredGap, type TechnicalGap, type TechnicalReport } from "./research-contracts.js";
import { technicalResearchFindings } from "./research-evidence.js";
import { layerDesignSpec, LAYER_DESIGN_VERSION } from "./layer-design.js";
import { defectGaps, defectInputs } from "./plan-defects.js";
import { assertPilotBoundary } from "../discovery/reader-pilot.js";
import { withTypedBasis } from './research-basis.js';
import { carriedObligations, type CarriedObligation } from './obligation-policy.js';
import { withObligationEvidence } from './obligation-evidence.js';
import { readinessObligations, type ReadinessObligations } from './obligation-readiness.js';
import { obligationHandoff } from './obligation-handoff.js';
import { requireTaskObligations, TASK_OBLIGATION_CONTRACT } from './task-obligations.js';
import { gateFeasibility as gateOmFeasibility } from '../compiler/om-readers.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeContext, runtimeExecutableIdentity, runtimeSubjectPath } from '../runtime/runtime-observation.js';
import type { RuntimeObservation } from '../runtime/runtime-observation-model.js';
import type { ArtifactReceipt } from '../compiler/model.js';
import type { TaskRun } from '../execution/model.js';
import type { WriterIndex } from '../ownership/writer-index.js';

export const PHASES = ["R0", "L1", "R1", "L2", "R2", "L3", "R3"] as const;
export type Phase = typeof PHASES[number];
interface RefinementReadMemo { gates: Map<string, GateResult>; inputs: Map<string, boolean> }
let refinementReadScope: WeakMap<Store, RefinementReadMemo> | null = null;
/** One synchronous read, with no writes: share exact results across its neighboring gates.
 * A Store view has its own key. Neither a successful read nor an exception leaves a cache behind. */
export function withRefinementRead<T>(read: () => T): T {
  if (refinementReadScope) return read();
  return withSourceMemo(() => {
    refinementReadScope = new WeakMap();
    try { return read(); } finally { refinementReadScope = null; }
  });
}
function refinementMemo(store: Store): RefinementReadMemo {
  let memo = refinementReadScope!.get(store);
  if (!memo) { memo = { gates: new Map(), inputs: new Map() }; refinementReadScope!.set(store, memo); }
  return memo;
}

interface Milestone { projectId: string; phase: Phase; inputs: Ref[]; draft: Ref | null; layer: Ref | null; contractVersion?: number;
  carried?: CarriedObligation[]; carriedContract?: 'r3-v1'; taskObligationContract?: string }
export interface Feasibility { contractVersion?: number; projectId: string; ready: boolean; graph: Ref; environment: Ref; repository: RepositoryState | null; inputs: Ref[]; findings: GateResult['findings'];
  obligations?: ReadinessObligations }

/** Only the saved external comparison slice of M8; importing its producer would invert the graph/OM boundary. */
interface ExternalFeasibility extends Feasibility {
  producer?: { contract: string; inspection: { root: string; executionRoot: Ref | null; workspace: Ref | null };
    deliveries: { resolved: { receipt: Ref | null }[]; ownership: { indexes: Record<string, Ref> } | null } };
}
function externalBasis(store: Store, project: string, ref: Ref): Revision<ExternalFeasibility> {
  requireCondition(isRef(ref), 'feasibility_not_ready', 'An exact feasibility basis is required');
  const record = store.get<ExternalFeasibility>(ref.id, ref.revision);
  requireCondition(record?.kind === 'feasibility' && record.hash === ref.hash && record.value.projectId === project
    && [ `feasibility:${project}`, `om-feasibility:${project}` ].includes(record.id)
    && record.value.ready && isRef(record.value.environment) && isRef(record.value.graph)
    && record.value.repository && Array.isArray(record.value.inputs),
  'feasibility_not_ready', 'The exact accepted feasibility basis is missing or foreign');
  if (record.id === `om-feasibility:${project}`) requireCondition(record.value.producer?.contract === 'om-m8/v2'
    && record.value.producer.inspection && record.value.producer.deliveries,
  'feasibility_record_invalid', 'The saved M8 inspection is required');
  return record;
}
function basisEnvironment(store: Store, project: string, basis: Revision<ExternalFeasibility>) {
  const ref = basis.value.environment, environment = store.get<Environment>(ref.id, ref.revision);
  requireCondition(environment?.kind === 'environment' && environment.hash === ref.hash
    && environment.id === `environment:${project}` && environment.value.projectId === project,
  'environment_missing', 'The exact environment of the inspection is unavailable');
  return environment;
}
const externalFailure = (error: unknown, target: string): Finding => ({
  code: error instanceof EngineError ? error.code : 'environment_missing', target,
  message: error instanceof Error ? error.message : 'The saved external basis is unavailable',
});
/** Files and executables are read afresh. No stage, research or feasibility validator is called here. */
export const REFINEMENT_EXTERNAL_CHECKS: ExternalCheckHandlers = {
  repository(check, { store, projectId }) {
    try {
      const basis = externalBasis(store, projectId, check.basis), value = basis.value;
      const environment = basisEnvironment(store, projectId, basis);
      const graph = store.get<Graph>(value.graph.id, value.graph.revision);
      requireCondition(graph?.kind === 'graph' && graph.hash === value.graph.hash,
        'feasibility_not_ready', 'The exact inspected graph is unavailable');
      const inspected = inspectRepository({ ...environment.value, workspace: value.repository!.root }, graph.value);
      if (inspected.findings.length) return inspected.findings[0]!;
      return canonical(inspected.state) === canonical(value.repository) ? null : {
        code: value.producer ? 'feasibility_stale' : 'repository_stale', target: basis.id,
        message: 'Repository state changed after the saved inspection',
      };
    } catch (error) { return externalFailure(error, check.basis.id); }
  },
  environment(check, { store, projectId }) {
    try {
      const basis = externalBasis(store, projectId, check.basis), value = basis.value;
      const environment = basisEnvironment(store, projectId, basis);
      const root = value.repository!.root;
      const executionRef = value.producer ? value.producer.inspection.executionRoot
        : value.inputs.find(ref => ref.id === `execution-root:${projectId}`) ?? null;
      if (executionRef) {
        const execution = store.get<ExecutionRoot>(executionRef.id, executionRef.revision);
        requireCondition(execution?.kind === 'execution-root' && execution.hash === executionRef.hash
          && execution.value.projectId === projectId && execution.value.state === 'ready'
          && execution.value.path === root && execution.value.sourceRoot === environment.value.workspace,
        'execution_root_recovery', 'The saved managed worktree basis is unavailable');
        const saved = execution.value;
        requireCondition(git(root, ['rev-parse', 'HEAD']) === saved.head
          && git(root, ['symbolic-ref', 'HEAD']) === `refs/heads/${saved.branch}`,
        'execution_root_recovery', 'The managed worktree head differs from its accepted state');
        const common = (path: string) => realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir'])));
        requireCondition(common(root) === common(saved.sourceRoot), 'execution_root_foreign', 'Worktree belongs to another repository');
      } else requireCondition(realpathSync(environment.value.workspace) === root,
        'environment_missing', 'The inspection root differs from its saved environment');
      // These are external runtime identities, not a second proof of the saved assessment.
      for (const confirmation of value.obligations?.confirmations ?? []) {
        const observation = store.get<RuntimeObservation>(confirmation.observation.id, confirmation.observation.revision);
        requireCondition(observation?.kind === 'runtime-observation' && observation.hash === confirmation.observation.hash
          && observation.value.projectId === projectId, 'environment_confirmation_required', 'The exact runtime comparison basis is unavailable');
        const old = observation.value, current = runtimeContext(store, projectId);
        const executable = realpathSync(process.execPath);
        const subjects = old.subjects.map(subject => {
          const path = runtimeSubjectPath(current.root, subject.requested, subject.kind);
          return { requested: subject.requested, kind: subject.kind, path, identity: runtimeExecutableIdentity(path) };
        });
        requireCondition(canonical(current.binding) === canonical(old.runtimeBinding)
          && executable === old.executable.path
          && canonical(runtimeExecutableIdentity(executable)) === canonical(old.executable.identity)
          && canonical(subjects) === canonical(old.subjects.map(({ requested, kind, path, identity }) => ({ requested, kind, path, identity }))),
        'environment_confirmation_required', 'A declared runtime subject changed since its accepted observation');
      }
      return null;
    } catch (error) { return externalFailure(error, check.basis.id); }
  },
  'om-feasibility'(check, { store, projectId }) {
    try {
      const basis = externalBasis(store, projectId, check.ref);
      requireCondition(basis.value.producer, 'feasibility_record_invalid', 'This external check needs a saved M8 inspection');
      const repository = basis.value.repository!;
      for (const ref of uniqueRefs(basis.value.producer.deliveries.resolved.flatMap(item => item.receipt ? [item.receipt] : []))) {
        const receipt = store.get<ArtifactReceipt>(ref.id, ref.revision);
        requireCondition(receipt?.kind === 'artifact' && receipt.hash === ref.hash && receipt.value.projectId === projectId,
          'artifact_foreign', 'The exact accepted delivery receipt is unavailable');
        git(repository.root, ['merge-base', '--is-ancestor', receipt.value.commit, repository.head]);
        requireCondition(git(repository.root, ['rev-parse', `${receipt.value.commit}^{tree}`]) === receipt.value.tree,
          'artifact_foreign', 'The delivery commit no longer agrees with its saved tree');
      }
      const writers: Ref[] = [];
      const ownership = basis.value.producer.deliveries.ownership;
      requireCondition(ownership && ownership.indexes, 'feasibility_record_invalid', 'A ready M8 basis requires its saved ownership slice');
      for (const [path, ref] of Object.entries(ownership.indexes)) {
        const index = store.get<WriterIndex>(ref.id, ref.revision);
        requireCondition(index?.kind === 'writer-index' && index.hash === ref.hash
          && index.value.project === projectId && index.value.path === path,
        'ownership_proof_foreign', 'The exact accepted writer slice is unavailable');
        writers.push(...index.value.writers);
      }
      // No walk through previous indexes or run reviews: their producer already established the slice.
      for (const ref of uniqueRefs(writers)) {
        const run = store.get<TaskRun>(ref.id, ref.revision);
        requireCondition(run?.kind === 'task-run' && run.hash === ref.hash && run.value.projectId === projectId
          && run.value.commit && run.value.tree, 'ownership_proof_foreign', 'The exact accepted writer is unavailable');
        git(repository.root, ['merge-base', '--is-ancestor', run.value.commit, repository.head]);
        requireCondition(git(repository.root, ['rev-parse', `${run.value.commit}^{tree}`]) === run.value.tree
          && git(repository.root, ['rev-list', '--parents', '-n', '1', run.value.commit]) === `${run.value.commit} ${run.value.parent}`,
        'ownership_proof_foreign', 'The accepted writer no longer has its saved commit ancestry');
      }
      return null;
    } catch (error) { return externalFailure(error, check.ref.id); }
  },
};

function declareFeasibility(store: Store, ref: Ref, result: GateResult): GateResult {
  if (result.findings.length) return result;
  const sources = result.guards.filter(input => store.get(input.id, input.revision)?.kind === 'source');
  result.closure = { contract: STAGE_CLOSURE_CONTRACT, external: [
    { kind: 'repository', basis: ref }, { kind: 'environment', basis: ref },
    ...(ref.id.startsWith('om-feasibility:') ? [{ kind: 'om-feasibility' as const, ref }] : []),
    ...sources.map(source => ({ kind: 'source' as const, ref: source })),
  ] };
  return result;
}

export class Refinement {
  constructor(private readonly store: Store, private readonly discovery: Discovery, private readonly graphs: GraphRepository,
    private readonly environments: Environments, private readonly pipeline: Pipeline) {}
  #milestone(id: string, expected: number, value: Milestone, guards: TransactionGuard[]): Revision<Milestone> {
    const previous = this.store.get<Milestone>(id);
    if (previous?.revision === expected && canonical(previous.value) === canonical(value)) {
      requireCondition(transactionGuardsCurrent(this.store, guards), "input_stale", "A phase admission input changed before its exact repeat");
      return previous;
    }
    return this.store.writeMany<Milestone>([{ id, kind: "phase", expected, value }], uniqueTransactionGuards(guards))[0]!;
  }
  #inputs(project: string, phase: Phase, admissionGuards: TransactionGuard[] = []): Ref[] {
    const features = this.pipeline.inspect(project, "features");
    requireCondition(features.state === "accepted", "features_not_ready", "Prepared features must be current and accepted");
    const index = PHASES.indexOf(phase); requireCondition(index >= 0, "phase_invalid", "Unknown refinement phase");
    const guards = [...features.guards];
    admissionGuards.push(...(features.admissionGuards ?? []));
    if (index > 0) {
      const previous = this.gate(project, PHASES[index - 1]!);
      requireCondition(previous.findings.length === 0, "phase_not_ready", "The preceding refinement phase is missing or stale");
      const milestone = this.store.get<Milestone>(`phase:${project}:${PHASES[index - 1]!}`);
      requireCondition(milestone?.value.contractVersion === REFINEMENT_CONTRACT_VERSION,
        "refinement_upgrade_required", "New refinement needs the enriched predecessor; accepted historical phases remain readable");
      guards.push(...previous.guards);
      admissionGuards.push(...(previous.admissionGuards ?? []));
    }
    return uniqueRefs(guards);
  }
  #r0Entries(project: string): Derivation[] {
    const source = this.store.get<StageArtifact>(stageId(project, "discovery"));
    const concept = this.store.get<StageArtifact>(stageId(project, "concept"));
    requireCondition(source && concept, "r0_inputs_missing", "R0 needs accepted initial research and concept");
    return [...["actors", "outcomes", "journeys", "externalSystems"].map(field => ({ field, source: reference(source), path: ["fields", "preparation", field] })),
      { field: "conceptSections", source: reference(concept), path: ["fields", "conceptSections"] }];
  }
  #gaps(project: string): TechnicalGap[] {
    const phase = this.store.get<Milestone>(`phase:${project}:R1`);
    if (!phase?.value.draft) return [];
    const draft = readDraft(this.store, phase.value.draft.id, phase.value.draft.revision);
    requireCondition(draft && draft.hash === phase.value.draft.hash, "research_foreign", "R1 report is unavailable");
    const graph = this.store.get<Graph>(`graph:${project}`);
    return Object.values(draft.value.fields).flatMap(value => (value as unknown as TechnicalReport).gaps)
      .filter(gap => !graph || !deferredGap(graph.value, gap));
  }
  #questions(project: string, level: "R1" | "R2", imported: Ref[] = [], grouping: "target" | "target-field" = "target", typed = false, obligationEvidence = false): FieldSpec[] {
    const scope = level === "R2" ? researchScope(this.store, project) : null;
    const specs = scope ? scopedQuestions(scope.value, defectGaps(this.store, project, imported), grouping)
      : refinementQuestions(level, [...(level === "R2" ? this.#gaps(project) : []), ...defectGaps(this.store, project, imported)], grouping);
    const based = typed ? specs.map(withTypedBasis) : specs;
    return obligationEvidence ? based.map(withObligationEvidence) : based;
  }
  #matchesQuestions(project: string, level: "R1" | "R2", specs: unknown, imported: Ref[], typed = false, obligationEvidence = false): boolean {
    // Stored field-grouped R2 remains valid for exactly the same obligations.
    // A changed horizon must still invalidate both layouts; no history rewrite.
    return canonical(specs) === canonical(this.#questions(project, level, imported, 'target', typed, obligationEvidence))
      || (level === "R2" && canonical(specs) === canonical(this.#questions(project, level, imported, "target-field", typed, obligationEvidence)));
  }
  begin(project: string, level: Exclude<ResearchLevel, "R3">): Revision<DiscoveryDraft> {
    assertPilotBoundary(this.store, project, level);
    requireCondition(["R0", "R1", "R2"].includes(level), "phase_invalid", "Use the feasibility checker for R3");
    const inputs = this.#inputs(project, level);
    const scope = level === "R2" ? researchScope(this.store, project) : null;
    if (scope) inputs.push(reference(scope));
    if (level === "R0") return derivedDraft(this.store, project, "om-g2", level, "compilation", this.#r0Entries(project), inputs, REFINEMENT_CONTRACT_VERSION);
    const effective = this.environments.effective(project);
    const workspace = this.store.get(`workspace:${project}`)!;
    return this.discovery.create(project, "om-g2", level, "compilation", this.#questions(project, level, [], 'target', level === 'R2', Boolean(scope?.value.policy)),
      uniqueRefs([...inputs, reference(workspace), ...effective.guards, ...defectInputs(this.store, project)]), REFINEMENT_CONTRACT_VERSION);
  }
  finishResearch(project: string, level: Exclude<ResearchLevel, "R3">, draftRef: Ref, expected: number): Revision<Milestone> {
    assertPilotBoundary(this.store, project, level);
    const graphAtStart = this.store.get<Graph>(`graph:${project}`);
    const scope = level === "R2" ? researchScope(this.store, project) : null;
    const admissionGuards: TransactionGuard[] = [];
    const inputs = uniqueRefs([...this.#inputs(project, level, admissionGuards), ...(scope ? [reference(scope)] : []), ...(level === "R0" ? [] : defectInputs(this.store, project))]); const checked = this.discovery.gate(project, draftRef);
    requireCondition(checked.findings.length === 0, "research_unresolved", "Research is unresolved or stale");
    const draft = readDraft(this.store, draftRef.id)!;
    requireCondition(draft.value.level === level && draft.value.stage === "om-g2" && draft.value.consumer === "compilation", "research_foreign", "Research belongs to a different refinement phase");
    requireCondition(draft.value.contractVersion === REFINEMENT_CONTRACT_VERSION,
      "research_contract_upgrade_required", "New research completion requires the enriched contract");
    const specs = orderedSpecs(this.store, draft.value);
    requireCondition((level === "R0" ? specs.length === 0 && canonical(draft.value.derivations) === canonical(this.#r0Entries(project))
      : this.#matchesQuestions(project, level, specs, draft.value.inputs, draft.value.basisContract === 'typed-v1', draft.value.obligationContract === 'evidence-v1'))
      && inputs.every(input => draft.value.inputs.some(ref => ref.id === input.id && ref.revision === input.revision && ref.hash === input.hash)),
    "research_contract_mismatch", "Research must use this phase's contract and actual predecessor context");
    const runtimeAdmissionGuards:TransactionGuard[]=[];
    if (level !== "R0") {
      const effective = this.environments.effective(project);
      admissionGuards.push(...effective.admissionGuards);
      const graph = this.store.get<Graph>(`graph:${project}`);
      requireCondition(graph, "graph_missing", "Technical research needs the current operation map");
      const findings = technicalResearchFindings(this.store, this.discovery, draft.value, graph.value, effective.root,runtimeAdmissionGuards);
      if (findings.length) throw new EngineError("technical_research_incomplete", findings.map(item => `${item.code}: ${item.message}`).join("; "), findings);
      inputs.push(reference(this.store.get(`workspace:${project}`)!), ...effective.guards);
    }
    const guards = uniqueRefs([...inputs, ...checked.guards]);
    return this.#milestone(`phase:${project}:${level}`, expected,
      { contractVersion: REFINEMENT_CONTRACT_VERSION, projectId: project, phase: level, inputs: guards, draft: draftRef, layer: null,
        ...(scope?.value.policy ? { carried: carriedObligations(scope), carriedContract: 'r3-v1' as const } : {}) },
      uniqueTransactionGuards([...guards, ...admissionGuards, ...runtimeAdmissionGuards, ...(checked.admissionGuards ?? []), ...(graphAtStart ? [reference(graphAtStart)] : [])]));
  }
  sealLayer(project: string, level: 1 | 2 | 3, expected: number, expectedGraph?: Ref): Revision<Milestone> {
    assertPilotBoundary(this.store, project, `L${level}`);
    const graphAtStart = this.store.get<Graph>(`graph:${project}`);
    requireCondition(!expectedGraph || (graphAtStart && canonical(reference(graphAtStart)) === canonical(expectedGraph)),
      "graph_stale", "The constructed graph changed before layer acceptance");
    const admissionGuards: TransactionGuard[] = [];
    const phase = `L${level}` as Phase; const inputs = this.#inputs(project, phase, admissionGuards);
    const checked = this.graphs.layerGate(project, level);
    requireCondition(checked.findings.length === 0, "layer_not_ready", "Graph layer is missing or stale");
    const graph = this.store.get<Graph>(`graph:${project}`);
    requireCondition(graph && (level !== 3 || graph.value.horizon.length > 0), "horizon_empty", "Choose the nearest L3 execution horizon");
    const handoff = level === 3 ? obligationHandoff(this.store, project, inputs) : null;
    if (handoff) requireTaskObligations(this.store, project, graph.value, handoff);
    requireCondition(graph.value.version !== 2 || level === 1 || this.graphs.layerIsDerived(project, level),
      "layer_design_required", "Build this layer from assessed research before sealing it");
    const layer = this.store.get(`graph-layer:${project}:${level}`)!;
    const guards = uniqueRefs([...inputs, ...checked.guards]);
    return this.#milestone(`phase:${project}:${phase}`, expected,
      { contractVersion: REFINEMENT_CONTRACT_VERSION, projectId: project, phase, inputs: guards, draft: null, layer: reference(layer),
        ...(handoff ? { taskObligationContract: TASK_OBLIGATION_CONTRACT } : {}) },
      uniqueTransactionGuards([...guards, ...admissionGuards, ...(checked.admissionGuards ?? []), ...(graphAtStart ? [reference(graphAtStart)] : [])]));
  }
  prepareLayer(project: string, level: 2 | 3): Revision<DiscoveryDraft> {
    assertPilotBoundary(this.store, project, `L${level}`);
    const inputs = this.#inputs(project, `L${level}`);
    const graph = this.store.get<Graph>(`graph:${project}`);
    requireCondition(graph?.value.version === 2, "graph_upgrade_required", "Layer research needs the enriched operation map");
    const effective = this.environments.effective(project);
    const upper = this.store.get(`graph-layer:${project}:${level - 1}`)!;
    const scope = level === 3 ? researchScope(this.store, project) : null;
    if (scope) inputs.push(reference(scope));
    return this.discovery.create(project, "om-g2", level === 2 ? "R1" : "R2", graph.value.nodes.find(node => node.kind === "product")!.id,
      [layerDesignSpec(level, level === 3 ? obligationHandoff(this.store, project, inputs) : null)], uniqueRefs([...inputs, reference(upper), ...effective.guards]), LAYER_DESIGN_VERSION);
  }
  buildLayer(project: string, level: 2 | 3, draft: Ref, expected: number, actor: string): Revision<Graph> {
    assertPilotBoundary(this.store, project, `L${level}`);
    const inputs = this.#inputs(project, `L${level}`);
    const record = readDraft(this.store, draft.id);
    requireCondition(record && inputs.every(input => record.value.inputs.some(ref => canonical(ref) === canonical(input))),
      "layer_research_foreign", "Layer design must use all current refinement prerequisites");
    return this.graphs.deriveLayer(project, level, expected, draft, actor, inputs);
  }
  gate(project: string, phase: Phase): GateResult {
    return withRefinementRead(() => {
      const milestone = this.store.get<Milestone>(`phase:${project}:${phase}`);
      // Active application proofs must observe every read, in their historical order.
      const physical = provenStore(this.store);
      const memo = physical && !storeObserved(physical) ? refinementMemo(this.store) : undefined;
      const key = milestone?.kind === 'phase' ? canonical(reference(milestone)) : null;
      const cached = key ? memo?.gates.get(key) : undefined;
      if (cached) return structuredClone(cached);
      const result = this.#phaseGate(project, phase, milestone, memo, physical ?? this.store);
      if (key) memo?.gates.set(key, structuredClone(result));
      return result;
    });
  }
  #phaseGate(project: string, phase: Phase, milestone: Revision<Milestone> | null, memo: RefinementReadMemo | undefined, physical: Store): GateResult {
    const result: GateResult = { findings: [], guards: [] };
    if (!milestone || milestone.kind !== "phase") { result.findings.push({ code: "phase_missing", target: phase, message: "Refinement phase is not complete" }); return result; }
    result.guards.push(reference(milestone));
    const inputs = uniqueRefs(milestone.value.inputs);
    const moved = memo ? new Set(physical.headsMatch(inputs).mismatches.map(item => item.id)) : null;
    for (const ref of inputs) {
      let current: boolean;
      if (!memo) {
        // Compatibility for captured/replayed application reads: no hidden dependency reads.
        const record = this.store.get(ref.id);
        current = !!record && record.revision === ref.revision && record.hash === ref.hash
          && (record.kind !== 'source' || sourceIsCurrent(record.value as unknown as Source));
      } else if (moved!.has(ref.id)) current = false;
      else {
        const key = canonical(ref);
        if (!memo.inputs.has(key)) {
          // headsMatch compares heads without bodies; exact identity selects only actual Source bodies.
          const identity = physical.identities('get', ref.id, ref.revision)[0];
          let valid = !!identity && identity.hash === ref.hash && identity.revision === ref.revision;
          if (valid && identity!.kind === 'source') {
            const source = this.store.get<Source>(ref.id, ref.revision);
            valid = !!source && source.kind === 'source' && source.hash === ref.hash && sourceIsCurrent(source.value, ref);
          }
          memo.inputs.set(key, valid);
        }
        current = memo.inputs.get(key)!;
      }
      if (!current) result.findings.push({ code: "phase_stale", target: ref.id, message: "An input to this phase changed" });
      else result.guards.push({ id: ref.id, revision: ref.revision, hash: ref.hash });
    }
    if (milestone.value.contractVersion === REFINEMENT_CONTRACT_VERSION) {
      const index = PHASES.indexOf(phase);
      if (index > 0) {
        const prior = this.gate(project, PHASES[index - 1]!);
        result.findings.push(...prior.findings); result.guards.push(...prior.guards);
        if (prior.admissionGuards?.length) result.admissionGuards = uniqueTransactionGuards(prior.admissionGuards);
      }
      if (phase === "R2" && milestone.value.draft) {
        const draft = readDraft(this.store, milestone.value.draft.id, milestone.value.draft.revision);
        const policyRef = draft?.value.inputs.find(ref => ref.id === `research-scope:${project}:R2`);
        const policyScope = policyRef ? this.store.get<ResearchScope>(policyRef.id, policyRef.revision) : null;
        if (policyScope?.hash === policyRef?.hash && policyScope?.value.policy
          && (!Array.isArray(milestone.value.carried) || canonical(milestone.value.carried) !== canonical(carriedObligations(policyScope))))
          result.findings.push({ code: 'research_obligation_handoff_invalid', target: 'R2',
            message: 'R2 must retain every exact carried obligation from its own scope revision, including its owner and deadline' });
        const specs = draft ? orderedSpecs(this.store, draft.value) : undefined;
        if (!draft || !this.#matchesQuestions(project, "R2", specs, draft.value.inputs, draft.value.basisContract === 'typed-v1', draft.value.obligationContract === 'evidence-v1')) result.findings.push({
          code: "research_horizon_changed", target: "R2", message: "Current horizon requires research obligations absent from the accepted R2 result" });
        const graph = this.store.get<Graph>(`graph:${project}`);
        if (draft && graph) for (const gap of Object.values(draft.value.fields).flatMap(value => (value as unknown as TechnicalReport).gaps)) {
          if (!researchGapDeferred(this.store, project, graph.value, gap)) result.findings.push({ code: "research_horizon_changed", target: gap.id,
            message: "A gap reported by R2 is now required by the current horizon and must be resolved" });
        }
      }
    }
    result.guards = uniqueRefs(result.guards);
    if (!result.findings.length && result.admissionGuards?.length && !transactionGuardsCurrent(this.store, [...result.guards, ...result.admissionGuards]))
      result.findings.push({ code: "phase_stale", target: milestone.id, message: "A phase input changed while its admission was checked" });
    return result;
  }
  assess(project: string, expected: number, extraGuards: TransactionGuard[] = []): Revision<Feasibility> {
    assertPilotBoundary(this.store, project, "R3");
    const admissionGuards: TransactionGuard[] = [];
    const inputs = this.#inputs(project, "R3", admissionGuards); const effective = this.environments.effective(project); const environment = effective.environment;
    const graph = this.store.get<Graph>(`graph:${project}`);
    requireCondition(graph && graph.kind === "graph", "graph_missing", "Operation map is missing");
    const graphGate = this.graphs.gate(project); const inspected = inspectRepository({ ...environment.value, workspace: effective.root }, graph.value);
    const obligations = readinessObligations(this.store, project, inputs);
    const findings = [...graphGate.findings, ...inspected.findings, ...obligations.findings];
    const guards = uniqueRefs([...inputs, reference(environment), ...graphGate.guards, ...effective.guards, ...obligations.dependencies]);
    return this.store.writeMany<Feasibility>([{ id: `feasibility:${project}`, kind: "feasibility", expected,
      value: { contractVersion: REFINEMENT_CONTRACT_VERSION, projectId: project, ready: findings.length === 0, graph: reference(graph), environment: reference(environment),
        repository: inspected.state, inputs: guards, findings, ...(obligations.value ? { obligations: obligations.value } : {}) } }],
      uniqueTransactionGuards([...guards, ...admissionGuards, ...(graphGate.admissionGuards ?? []), ...effective.admissionGuards, ...obligations.guards, ...obligations.admissionGuards, ...extraGuards]))[0]!;
  }
  feasibilityGate(project: string, ref: Ref, allowHistorical = false, declareClosure = false): GateResult {
    if (!isRef(ref)) return { findings: [{ code: "feasibility_missing", target: project, message: "R3 result reference is required" }], guards: [] };
    if (ref.id.startsWith('om-feasibility:')) {
      const checked = gateOmFeasibility(this.store, { project, record: ref });
      if (!checked.ok) return { findings: [{ code: checked.refusal.code, target: checked.refusal.at.target,
        message: checked.refusal.message, ...(checked.refusal.at.field === undefined ? {} : { field: checked.refusal.at.field }) }], guards: [] };
      const admissionGuards = uniqueTransactionGuards(checked.value.guards);
      const guards: Ref[] = [];
      // The M8 closure is historical evidence; only its current positive guards become stage proofs.
      for (const guard of admissionGuards) if (!('absent' in guard)) guards.push(guard);
      const result: GateResult = { findings: [], guards, admissionGuards };
      return declareClosure ? declareFeasibility(this.store, ref, result) : result;
    }
    const record = this.store.get<Feasibility>(ref.id);
    if (!record || record.kind !== "feasibility" || record.value.projectId !== project || record.hash !== ref.hash || record.revision !== ref.revision || !record.value.ready) {
      return { findings: [{ code: "feasibility_not_ready", target: project, message: "R3 is missing, stale or not ready" }], guards: [] };
    }
    if (record.value.contractVersion !== REFINEMENT_CONTRACT_VERSION && !(allowHistorical && record.value.contractVersion === undefined)) return {
      findings: [{ code: "refinement_upgrade_required", target: project, message: "New compilation requires enriched R0/R1/R2 and current R3" }], guards: [] };
    const result: GateResult = { findings: [], guards: [reference(record)] };
    const obligations = readinessObligations(this.store, project, record.value.inputs, record.value.obligations, 'consume', allowHistorical);
    result.findings.push(...obligations.findings);
    const admissionGuards = uniqueTransactionGuards([...obligations.guards, ...obligations.admissionGuards]);
    for (const input of uniqueRefs(record.value.inputs)) {
      const current = this.store.get(input.id);
      if (!current || current.revision !== input.revision || current.hash !== input.hash
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "feasibility_stale", target: input.id, message: "An R3 input changed" });
      else result.guards.push(reference(current));
    }
    const graph = this.store.get<Graph>(`graph:${project}`);
    try {
      const effective = this.environments.effective(project);
      admissionGuards.push(...effective.admissionGuards);
      const inspected = inspectRepository({ ...effective.environment.value, workspace: effective.root }, graph!.value);
      result.findings.push(...inspected.findings);
      if (canonical(inspected.state) !== canonical(record.value.repository)) result.findings.push({ code: "repository_stale", target: project, message: "Repository state changed after R3" });
    } catch { result.findings.push({ code: "environment_missing", target: project, message: "Environment is unavailable" }); }
    if (admissionGuards.length) result.admissionGuards = uniqueTransactionGuards(admissionGuards);
    if (!result.findings.length && !transactionGuardsCurrent(this.store, [...result.guards, ...admissionGuards]))
      result.findings.push({ code: "feasibility_stale", target: ref.id, message: "An R3 input changed while its admission was checked" });
    return declareClosure ? declareFeasibility(this.store, ref, result) : result;
  }
  publish(project: string, ref: Ref, expected: number, extraGuards: TransactionGuard[] = []) {
    assertPilotBoundary(this.store, project, "R3");
    const result = this.feasibilityGate(project, ref);
    requireCondition(result.findings.length === 0, "feasibility_not_ready", "The current R3 result is not ready");
    return this.pipeline.draft(project, "om-g2", { feasibility: ref } as unknown as Json, expected,
      uniqueTransactionGuards([...result.guards, ...(result.admissionGuards ?? []), ...extraGuards]));
  }
}

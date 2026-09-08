import { researchScope, scopedQuestions, researchGapDeferred, type ResearchScope } from "./research-scope.js";
import { Store, type Revision } from "../storage/store.js";
import { Discovery, type DiscoveryDraft, type ResearchLevel, type FieldSpec, type Question } from "../discovery/discovery.js";
import { GraphRepository } from "./repository.js";
import { Environments, inspectRepository, type RepositoryState } from "../runtime/environment.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { reference, isRef, uniqueRefs, stageId, type StageArtifact, type Ref, type GateResult } from "../pipeline/contracts.js";
import { canonical, type Json } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import type { Graph } from "./model.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
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

export const PHASES = ["R0", "L1", "R1", "L2", "R2", "L3", "R3"] as const;
export type Phase = typeof PHASES[number];
interface Milestone { projectId: string; phase: Phase; inputs: Ref[]; draft: Ref | null; layer: Ref | null; contractVersion?: number;
  carried?: CarriedObligation[]; carriedContract?: 'r3-v1'; taskObligationContract?: string }
export interface Feasibility { contractVersion?: number; projectId: string; ready: boolean; graph: Ref; environment: Ref; repository: RepositoryState | null; inputs: Ref[]; findings: GateResult['findings'];
  obligations?: ReadinessObligations }

export class Refinement {
  constructor(private readonly store: Store, private readonly discovery: Discovery, private readonly graphs: GraphRepository,
    private readonly environments: Environments, private readonly pipeline: Pipeline) {}
  #milestone(id: string, expected: number, value: Milestone, guards: Ref[]): Revision<Milestone> {
    const previous = this.store.get<Milestone>(id);
    if (previous?.revision === expected && canonical(previous.value) === canonical(value)) return previous;
    return this.store.writeMany<Milestone>([{ id, kind: "phase", expected, value }], uniqueRefs(guards))[0]!;
  }
  #inputs(project: string, phase: Phase): Ref[] {
    const features = this.pipeline.inspect(project, "features");
    requireCondition(features.state === "accepted", "features_not_ready", "Prepared features must be current and accepted");
    const index = PHASES.indexOf(phase); requireCondition(index >= 0, "phase_invalid", "Unknown refinement phase");
    const guards = [...features.guards];
    if (index > 0) {
      const previous = this.gate(project, PHASES[index - 1]!);
      requireCondition(previous.findings.length === 0, "phase_not_ready", "The preceding refinement phase is missing or stale");
      const milestone = this.store.get<Milestone>(`phase:${project}:${PHASES[index - 1]!}`);
      requireCondition(milestone?.value.contractVersion === REFINEMENT_CONTRACT_VERSION,
        "refinement_upgrade_required", "New refinement needs the enriched predecessor; accepted historical phases remain readable");
      guards.push(...previous.guards);
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
    const draft = this.store.get<DiscoveryDraft>(phase.value.draft.id, phase.value.draft.revision);
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
    const inputs = uniqueRefs([...this.#inputs(project, level), ...(scope ? [reference(scope)] : []), ...(level === "R0" ? [] : defectInputs(this.store, project))]); const checked = this.discovery.gate(project, draftRef);
    requireCondition(checked.findings.length === 0, "research_unresolved", "Research is unresolved or stale");
    const draft = this.store.get<DiscoveryDraft>(draftRef.id)!;
    requireCondition(draft.value.level === level && draft.value.stage === "om-g2" && draft.value.consumer === "compilation", "research_foreign", "Research belongs to a different refinement phase");
    requireCondition(draft.value.contractVersion === REFINEMENT_CONTRACT_VERSION,
      "research_contract_upgrade_required", "New research completion requires the enriched contract");
    const specs = draft.value.questions.map(id => this.store.get<Question>(id)?.value.spec);
    requireCondition((level === "R0" ? specs.length === 0 && canonical(draft.value.derivations) === canonical(this.#r0Entries(project))
      : this.#matchesQuestions(project, level, specs, draft.value.inputs, draft.value.basisContract === 'typed-v1', draft.value.obligationContract === 'evidence-v1'))
      && inputs.every(input => draft.value.inputs.some(ref => ref.id === input.id && ref.revision === input.revision && ref.hash === input.hash)),
    "research_contract_mismatch", "Research must use this phase's contract and actual predecessor context");
    const runtimeAdmissionGuards:Ref[]=[];
    if (level !== "R0") {
      const effective = this.environments.effective(project);
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
      uniqueRefs([...guards,...runtimeAdmissionGuards, ...(graphAtStart ? [reference(graphAtStart)] : [])]));
  }
  sealLayer(project: string, level: 1 | 2 | 3, expected: number, expectedGraph?: Ref): Revision<Milestone> {
    assertPilotBoundary(this.store, project, `L${level}`);
    const graphAtStart = this.store.get<Graph>(`graph:${project}`);
    requireCondition(!expectedGraph || (graphAtStart && canonical(reference(graphAtStart)) === canonical(expectedGraph)),
      "graph_stale", "The constructed graph changed before layer acceptance");
    const phase = `L${level}` as Phase; const inputs = this.#inputs(project, phase);
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
      [...guards, ...(graphAtStart ? [reference(graphAtStart)] : [])]);
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
    const record = this.store.get<DiscoveryDraft>(draft.id);
    requireCondition(record && inputs.every(input => record.value.inputs.some(ref => canonical(ref) === canonical(input))),
      "layer_research_foreign", "Layer design must use all current refinement prerequisites");
    return this.graphs.deriveLayer(project, level, expected, draft, actor, inputs);
  }
  gate(project: string, phase: Phase): GateResult {
    const milestone = this.store.get<Milestone>(`phase:${project}:${phase}`);
    const result: GateResult = { findings: [], guards: [] };
    if (!milestone || milestone.kind !== "phase") { result.findings.push({ code: "phase_missing", target: phase, message: "Refinement phase is not complete" }); return result; }
    result.guards.push(reference(milestone));
    for (const ref of uniqueRefs(milestone.value.inputs)) {
      const current = this.store.get(ref.id);
      if (!current || current.revision !== ref.revision || current.hash !== ref.hash
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "phase_stale", target: ref.id, message: "An input to this phase changed" });
      else result.guards.push(reference(current));
    }
    if (milestone.value.contractVersion === REFINEMENT_CONTRACT_VERSION) {
      const index = PHASES.indexOf(phase);
      if (index > 0) {
        const prior = this.gate(project, PHASES[index - 1]!);
        result.findings.push(...prior.findings); result.guards.push(...prior.guards);
      }
      if (phase === "R2" && milestone.value.draft) {
        const draft = this.store.get<DiscoveryDraft>(milestone.value.draft.id, milestone.value.draft.revision);
        const policyRef = draft?.value.inputs.find(ref => ref.id === `research-scope:${project}:R2`);
        const policyScope = policyRef ? this.store.get<ResearchScope>(policyRef.id, policyRef.revision) : null;
        if (policyScope?.hash === policyRef?.hash && policyScope?.value.policy
          && (!Array.isArray(milestone.value.carried) || canonical(milestone.value.carried) !== canonical(carriedObligations(policyScope))))
          result.findings.push({ code: 'research_obligation_handoff_invalid', target: 'R2',
            message: 'R2 must retain every exact carried obligation from its own scope revision, including its owner and deadline' });
        const specs = draft?.value.questions.map(id => this.store.get<Question>(id)?.value.spec);
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
    return result;
  }
  assess(project: string, expected: number): Revision<Feasibility> {
    assertPilotBoundary(this.store, project, "R3");
    const inputs = this.#inputs(project, "R3"); const effective = this.environments.effective(project); const environment = effective.environment;
    const graph = this.store.get<Graph>(`graph:${project}`);
    requireCondition(graph && graph.kind === "graph", "graph_missing", "Operation map is missing");
    const graphGate = this.graphs.gate(project); const inspected = inspectRepository({ ...environment.value, workspace: effective.root }, graph.value);
    const obligations = readinessObligations(this.store, project, inputs);
    const findings = [...graphGate.findings, ...inspected.findings, ...obligations.findings];
    const guards = uniqueRefs([...inputs, reference(environment), ...graphGate.guards, ...effective.guards, ...obligations.dependencies]);
    return this.store.writeMany<Feasibility>([{ id: `feasibility:${project}`, kind: "feasibility", expected,
      value: { contractVersion: REFINEMENT_CONTRACT_VERSION, projectId: project, ready: findings.length === 0, graph: reference(graph), environment: reference(environment),
        repository: inspected.state, inputs: guards, findings, ...(obligations.value ? { obligations: obligations.value } : {}) } }],
      uniqueRefs([...guards, ...obligations.guards]))[0]!;
  }
  feasibilityGate(project: string, ref: Ref, allowHistorical = false): GateResult {
    if (!isRef(ref)) return { findings: [{ code: "feasibility_missing", target: project, message: "R3 result reference is required" }], guards: [] };
    const record = this.store.get<Feasibility>(ref.id);
    if (!record || record.kind !== "feasibility" || record.value.projectId !== project || record.hash !== ref.hash || record.revision !== ref.revision || !record.value.ready) {
      return { findings: [{ code: "feasibility_not_ready", target: project, message: "R3 is missing, stale or not ready" }], guards: [] };
    }
    if (record.value.contractVersion !== REFINEMENT_CONTRACT_VERSION && !(allowHistorical && record.value.contractVersion === undefined)) return {
      findings: [{ code: "refinement_upgrade_required", target: project, message: "New compilation requires enriched R0/R1/R2 and current R3" }], guards: [] };
    const result: GateResult = { findings: [], guards: [reference(record)] };
    const obligations = readinessObligations(this.store, project, record.value.inputs, record.value.obligations, 'consume', allowHistorical);
    result.findings.push(...obligations.findings);
    if (obligations.guards.length) result.admissionGuards = obligations.guards;
    for (const input of uniqueRefs(record.value.inputs)) {
      const current = this.store.get(input.id);
      if (!current || current.revision !== input.revision || current.hash !== input.hash
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "feasibility_stale", target: input.id, message: "An R3 input changed" });
      else result.guards.push(reference(current));
    }
    const graph = this.store.get<Graph>(`graph:${project}`);
    try {
      const effective = this.environments.effective(project);
      const inspected = inspectRepository({ ...effective.environment.value, workspace: effective.root }, graph!.value);
      result.findings.push(...inspected.findings);
      if (canonical(inspected.state) !== canonical(record.value.repository)) result.findings.push({ code: "repository_stale", target: project, message: "Repository state changed after R3" });
    } catch { result.findings.push({ code: "environment_missing", target: project, message: "Environment is unavailable" }); }
    return result;
  }
  publish(project: string, ref: Ref, expected: number) {
    assertPilotBoundary(this.store, project, "R3");
    const result = this.feasibilityGate(project, ref);
    requireCondition(result.findings.length === 0, "feasibility_not_ready", "The current R3 result is not ready");
    return this.pipeline.draft(project, "om-g2", { feasibility: ref } as unknown as Json, expected,
      uniqueRefs([...result.guards, ...(result.admissionGuards ?? [])]));
  }
}

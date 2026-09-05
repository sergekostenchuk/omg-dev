import { Store, type Revision } from "../storage/store.js";
import { Discovery, type DiscoveryDraft, type ResearchLevel, type FieldSpec, type Question, type Fact } from "../discovery/discovery.js";
import { GraphRepository } from "./repository.js";
import { Environments, inspectRepository, type RepositoryState } from "../runtime/environment.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { reference, isRef, type Ref, type GateResult } from "../pipeline/contracts.js";
import { canonical, type Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import type { Graph } from "./model.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { relative } from "node:path";
import { readFileSync } from "node:fs";
import { digest } from "../canonical.js";
import { workspacePath } from "../runtime/environment.js";

export const PHASES = ["R0", "L1", "R1", "L2", "R2", "L3", "R3"] as const;
export type Phase = typeof PHASES[number];
interface Milestone { projectId: string; phase: Phase; inputs: Ref[]; draft: Ref | null; layer: Ref | null }
export interface Feasibility { projectId: string; ready: boolean; graph: Ref; environment: Ref; repository: RepositoryState | null; inputs: Ref[]; findings: GateResult['findings'] }

const RESEARCH: Record<"R0" | "R1" | "R2", FieldSpec[]> = {
  R0: [{ field: "rolesAndOutcome", kind: "decision", prompt: "Какие роли и результат должна обеспечивать карта?", risk: "Не согласованы участники и результат", schema: { type: "string", minLength: 1 } }],
  R1: [{ field: "repositoryContext", kind: "fact", prompt: "Какие данные выбранного репозитория задают архитектурный контекст?", risk: "Архитектура опирается на неподтверждённый контекст", schema: { anyOf: [{ type: "object", minProperties: 1 }, { type: "string", minLength: 1 }, { type: "array", minItems: 1 }] } }],
  R2: [{ field: "implementationFacts", kind: "fact", prompt: "Какие точные исходные данные нужны ближайшей реализации?", risk: "Пути и контракты ближайшей работы не исследованы", schema: { anyOf: [{ type: "object", minProperties: 1 }, { type: "string", minLength: 1 }, { type: "array", minItems: 1 }] } }],
};

export class Refinement {
  constructor(private readonly store: Store, private readonly discovery: Discovery, private readonly graphs: GraphRepository,
    private readonly environments: Environments, private readonly pipeline: Pipeline) {}
  #inputs(project: string, phase: Phase): Ref[] {
    const features = this.pipeline.inspect(project, "features");
    requireCondition(features.state === "accepted", "features_not_ready", "Prepared features must be current and accepted");
    const index = PHASES.indexOf(phase); requireCondition(index >= 0, "phase_invalid", "Unknown refinement phase");
    const guards = [...features.guards];
    if (index > 0) {
      const previous = this.gate(project, PHASES[index - 1]!);
      requireCondition(previous.findings.length === 0, "phase_not_ready", "The preceding refinement phase is missing or stale");
      guards.push(...previous.guards);
    }
    return guards;
  }
  begin(project: string, level: Exclude<ResearchLevel, "R3">): Revision<DiscoveryDraft> {
    requireCondition(Object.hasOwn(RESEARCH, level), "phase_invalid", "Use the feasibility checker for R3");
    return this.discovery.create(project, "om-g2", level, "compilation", RESEARCH[level], this.#inputs(project, level));
  }
  finishResearch(project: string, level: Exclude<ResearchLevel, "R3">, draftRef: Ref, expected: number): Revision<Milestone> {
    const inputs = this.#inputs(project, level); const checked = this.discovery.gate(project, draftRef);
    requireCondition(checked.findings.length === 0, "research_unresolved", "Research is unresolved or stale");
    const draft = this.store.get<DiscoveryDraft>(draftRef.id)!;
    requireCondition(draft.value.level === level && draft.value.stage === "om-g2" && draft.value.consumer === "compilation", "research_foreign", "Research belongs to a different refinement phase");
    const specs = draft.value.questions.map(id => this.store.get<Question>(id)?.value.spec);
    requireCondition(canonical(specs) === canonical(RESEARCH[level])
      && inputs.every(input => draft.value.inputs.some(ref => ref.id === input.id && ref.revision === input.revision && ref.hash === input.hash)),
    "research_contract_mismatch", "Research must use this phase's contract and actual predecessor context");
    if (level !== "R0") {
      const environment = this.environments.get(project);
      for (const id of draft.value.questions) {
        const question = this.store.get<Question>(id)!;
        const fact = this.store.get<Fact>(question.value.answer!.id)!;
        const source = this.store.get<Source>(fact.value.observation.source.id)!;
        requireCondition(source.value.origin.kind === "file", "repository_evidence_required", "R1/R2 require an actual file from the selected repository");
        const path = workspacePath(environment.value.workspace, relative(environment.value.workspace, source.value.origin.location));
        requireCondition(digest(readFileSync(path)) === source.value.sha256, "source_stale", "Repository source changed after research capture");
      }
      inputs.push(reference(this.store.get(`workspace:${project}`)!));
    }
    return this.store.writeMany<Milestone>([{ id: `phase:${project}:${level}`, kind: "phase", expected,
      value: { projectId: project, phase: level, inputs: [...inputs, ...checked.guards], draft: draftRef, layer: null } }], [...inputs, ...checked.guards])[0]!;
  }
  sealLayer(project: string, level: 1 | 2 | 3, expected: number): Revision<Milestone> {
    const phase = `L${level}` as Phase; const inputs = this.#inputs(project, phase);
    const checked = this.graphs.layerGate(project, level);
    requireCondition(checked.findings.length === 0, "layer_not_ready", "Graph layer is missing or stale");
    const graph = this.store.get<Graph>(`graph:${project}`);
    requireCondition(graph && (level !== 3 || graph.value.horizon.length > 0), "horizon_empty", "Choose the nearest L3 execution horizon");
    const layer = this.store.get(`graph-layer:${project}:${level}`)!;
    return this.store.writeMany<Milestone>([{ id: `phase:${project}:${phase}`, kind: "phase", expected,
      value: { projectId: project, phase, inputs: [...inputs, ...checked.guards], draft: null, layer: reference(layer) } }], [...inputs, ...checked.guards])[0]!;
  }
  gate(project: string, phase: Phase): GateResult {
    const milestone = this.store.get<Milestone>(`phase:${project}:${phase}`);
    const result: GateResult = { findings: [], guards: [] };
    if (!milestone || milestone.kind !== "phase") { result.findings.push({ code: "phase_missing", target: phase, message: "Refinement phase is not complete" }); return result; }
    result.guards.push(reference(milestone));
    for (const ref of milestone.value.inputs) {
      const current = this.store.get(ref.id);
      if (!current || current.revision !== ref.revision || current.hash !== ref.hash
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "phase_stale", target: ref.id, message: "An input to this phase changed" });
      else result.guards.push(reference(current));
    }
    return result;
  }
  assess(project: string, expected: number): Revision<Feasibility> {
    const inputs = this.#inputs(project, "R3"); const environment = this.environments.get(project);
    const graph = this.store.get<Graph>(`graph:${project}`);
    requireCondition(graph && graph.kind === "graph", "graph_missing", "Operation map is missing");
    const graphGate = this.graphs.gate(project); const inspected = inspectRepository(environment.value, graph.value);
    const findings = [...graphGate.findings, ...inspected.findings];
    const guards = [...inputs, reference(environment), ...graphGate.guards];
    return this.store.writeMany<Feasibility>([{ id: `feasibility:${project}`, kind: "feasibility", expected,
      value: { projectId: project, ready: findings.length === 0, graph: reference(graph), environment: reference(environment),
        repository: inspected.state, inputs: guards, findings } }], guards)[0]!;
  }
  feasibilityGate(project: string, ref: Ref): GateResult {
    if (!isRef(ref)) return { findings: [{ code: "feasibility_missing", target: project, message: "R3 result reference is required" }], guards: [] };
    const record = this.store.get<Feasibility>(ref.id);
    if (!record || record.kind !== "feasibility" || record.value.projectId !== project || record.hash !== ref.hash || record.revision !== ref.revision || !record.value.ready) {
      return { findings: [{ code: "feasibility_not_ready", target: project, message: "R3 is missing, stale or not ready" }], guards: [] };
    }
    const result: GateResult = { findings: [], guards: [reference(record)] };
    for (const input of record.value.inputs) {
      const current = this.store.get(input.id);
      if (!current || current.revision !== input.revision || current.hash !== input.hash
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "feasibility_stale", target: input.id, message: "An R3 input changed" });
      else result.guards.push(reference(current));
    }
    const graph = this.store.get<Graph>(`graph:${project}`);
    try {
      const inspected = inspectRepository(this.environments.get(project).value, graph!.value);
      result.findings.push(...inspected.findings);
      if (canonical(inspected.state) !== canonical(record.value.repository)) result.findings.push({ code: "repository_stale", target: project, message: "Repository state changed after R3" });
    } catch { result.findings.push({ code: "environment_missing", target: project, message: "Environment is unavailable" }); }
    return result;
  }
  publish(project: string, ref: Ref, expected: number) {
    const result = this.feasibilityGate(project, ref);
    requireCondition(result.findings.length === 0, "feasibility_not_ready", "The current R3 result is not ready");
    return this.pipeline.draft(project, "om-g2", { feasibility: ref } as unknown as Json, expected);
  }
}

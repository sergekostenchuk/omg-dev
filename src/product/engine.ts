import { Store, type Revision } from "../storage/store.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { STAGES, predecessor, reference, isRef, type Stage, type StageArtifact, type StageValidators,
  type GateContext, type GateResult, type Ref } from "../pipeline/contracts.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { REQUIREMENTS, UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import { GraphRepository } from "../graph/repository.js";
import { canonical, type Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { parseCommand } from "./commands.js";
import type { Graph } from "../graph/model.js";
import { Environments } from "../runtime/environment.js";
import { Refinement } from "../graph/refinement.js";

export interface Project { id: string; title: string }
export interface StageContent { draft: Ref; fields: Record<string, Json>; graph: Ref | null }
export class ProductEngine {
  readonly discovery: Discovery;
  readonly graphs: GraphRepository;
  readonly pipeline: Pipeline;
  readonly environments: Environments;
  readonly refinement: Refinement;
  constructor(readonly store: Store, private readonly actor = "local-owner") {
    this.discovery = new Discovery(store); this.graphs = new GraphRepository(store, this.discovery);
    const validators = Object.fromEntries(STAGES.map(stage => [stage, (context: GateContext) => this.validateStage(stage, context)])) as unknown as StageValidators;
    this.pipeline = new Pipeline(store, validators);
    this.environments = new Environments(store);
    this.refinement = new Refinement(store, this.discovery, this.graphs, this.environments, this.pipeline);
  }
  protected validateStage(stage: Stage, context: GateContext): GateResult {
    const rejected = (code: string, message: string): GateResult => ({ findings: [{ code, target: stage, message }], guards: [] });
    if (stage === "om-g2") {
      const content = context.content as { feasibility?: unknown } | null;
      if (!content || Object.keys(content).join(",") !== "feasibility" || !isRef(content.feasibility)) return rejected("feasibility_missing", "This stage requires a bound R3 result");
      return this.refinement.feasibilityGate(context.projectId, content.feasibility);
    }
    if (!UPSTREAM_STAGES.includes(stage as UpstreamStage)) return rejected("stage_not_available", "This execution-stage module is not connected yet");
    const content = context.content as unknown as StageContent;
    if (!content || typeof content !== "object" || !isRef(content.draft) || !content.fields
      || !Object.hasOwn(content, "graph") || Object.keys(content).sort().join(",") !== "draft,fields,graph") return rejected("stage_content_invalid", "Stage content must bind a discovery result and its fields");
    const draft = this.store.get<DiscoveryDraft>(content.draft.id);
    if (!draft || draft.value.stage !== stage || draft.value.projectId !== context.projectId
      || canonical(draft.value.fields) !== canonical(content.fields)) return rejected("discovery_foreign", "Research does not belong to this stage or its fields changed");
    const result = this.discovery.gate(context.projectId, content.draft);
    const expected = REQUIREMENTS[stage as UpstreamStage];
    const specs = draft.value.questions.map(id => this.store.get<Question>(id)?.value.spec);
    if (canonical(specs) !== canonical(expected)) result.findings.push({ code: "research_contract_mismatch", target: stage, message: "Research questions do not match the stage's required fields" });
    const prior = context.inputs[0];
    if (prior && !draft.value.inputs.some(input => input.id === prior.id && input.hash === prior.hash && input.revision === prior.revision)) result.findings.push({ code: "research_context_stale", target: stage, message: "Research must bind the accepted prerequisite used by this stage" });
    if (stage === "operation-map") {
      if (!isRef(content.graph)) result.findings.push({ code: "graph_missing", target: stage, message: "An operation map is required" });
      else { const graphResult = this.graphs.layerGate(context.projectId, 1, content.graph); result.findings.push(...graphResult.findings); result.guards.push(...graphResult.guards); }
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
        if (!graph.value.projection.artifacts.some(artifact => artifact.id === feature.outcome)) result.findings.push({ code: "feature_outcome_missing", target: feature.title, message: "Feature outcome must exist in the operation map" });
        for (const index of feature.requirements) {
          if (!Number.isSafeInteger(index) || index < 0 || index >= behavior.length) result.findings.push({ code: "feature_requirement_missing", target: feature.title, message: "Feature refers to a nonexistent requirement" });
          else covered.add(index);
        }
      }
      if (Array.isArray(behavior) && covered.size !== behavior.length) result.findings.push({ code: "requirement_uncovered", target: stage, message: "Every specified behavior needs a feature" });
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
    const layer = stage === "operation-map" ? this.store.get(`graph-layer:${project}:1`) : null;
    const content = { draft: reference(draft), fields: draft.value.fields, graph: layer ? reference(layer) : null };
    return this.pipeline.draft(project, stage, content as unknown as Json, expected);
  }
  projection(project: string) {
    return { project: this.#project(project), stages: this.pipeline.project(project), graph: this.store.get<Graph>(`graph:${project}`),
      graphGate: this.graphs.gate(project),
      drafts: this.store.list<DiscoveryDraft>("discovery-draft").filter(item => item.value.projectId === project),
      questions: this.store.list<Question>("question").filter(item => item.value.projectId === project),
      sources: this.store.list<{ projectId: string }>("source").filter(item => item.value.projectId === project),
      environment: this.store.get(`environment:${project}`), phases: this.store.list<{ projectId: string }>("phase").filter(item => item.value.projectId === project),
      feasibility: this.store.get(`feasibility:${project}`),
    };
  }
  exportStage(project: string, stage: Stage): string {
    this.#project(project); const projection = this.pipeline.inspect(project, stage);
    requireCondition(projection.artifact, "artifact_missing", "Stage has no artifact yet");
    return `# ${stage}\n\nState: ${projection.state}\nRevision: ${projection.artifact.revision}\nSHA-256: ${projection.artifact.hash}\n\n\`\`\`json\n${JSON.stringify(projection.artifact.value.content, null, 2)}\n\`\`\`\n`;
  }
  execute(input: unknown): unknown {
    const command = parseCommand(input);
    switch (command.type) {
      case "configure": this.#project(command.project); return this.environments.configure(command.project, command.environment, command.expected);
      case "begin-research": this.#project(command.project); return this.refinement.begin(command.project, command.level);
      case "finish-research": this.#project(command.project); return this.refinement.finishResearch(command.project, command.level, command.draft, command.expected);
      case "seal-layer": this.#project(command.project); return this.refinement.sealLayer(command.project, command.level, command.expected);
      case "assess": this.#project(command.project); return this.refinement.assess(command.project, command.expected);
      case "draft-om": this.#project(command.project); return this.refinement.publish(command.project, command.feasibility, command.expected);
      case "create-project": return this.store.write<Project>({ id: `project:${command.project}`, kind: "project", expected: 0, value: { id: command.project, title: command.title } });
      case "prepare-stage": return this.prepare(command.project, command.stage);
      case "source-document": this.#project(command.project); return this.discovery.evidence.document(command.project, command.id, command.text, command.media, command.expected);
      case "answer-decision": return this.discovery.decision(command.question, command.expected, this.actor, command.value);
      case "answer-fact": return this.discovery.fact(command.question, command.expected, command.source, command.selector);
      case "reopen-question": return this.discovery.reopen(command.question, command.expected);
      case "save-graph": this.#project(command.project); return this.graphs.save(command.project, command.graph, command.expected, this.actor);
      case "refine-graph": this.#project(command.project); return this.graphs.refine(command.project, command.expected, command.draft, this.actor);
      case "draft-stage": return this.draft(command.project, command.stage, command.draftId, command.expected);
      case "accept-stage": this.#project(command.project); return this.pipeline.accept(command.project, command.stage, command.expected);
      case "project": return this.projection(command.project);
      case "export-stage": return this.exportStage(command.project, command.stage);
    }
  }
}

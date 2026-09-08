import { recoverModelCall } from "../discovery/model-call-recovery.js";
import { recoverContextSession } from '../discovery/context-recovery.js';
import { allocateResearchTrial } from '../discovery/research-trial.js';
import { retryPlannedRead } from '../discovery/reading-plan.js';
import { applyObligationPolicy } from '../graph/obligation-application.js';
import { continuePreparation } from "./preparation-run.js";
import { mapStatus, saveMapStatus } from "../graph/map-status.js";
import { Store, type Revision } from "../storage/store.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { STAGES, predecessor, reference, isRef, stageId, type Stage, type StageArtifact, type StageValidators,
  type GateContext, type GateResult, type Ref } from "../pipeline/contracts.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { REQUIREMENTS, LEGACY_REQUIREMENTS, VERSION2_REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import { GraphRepository } from "../graph/repository.js";
import { canonical, type Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { parseCommand } from "./commands.js";
import type { Graph } from "../graph/model.js";
import { Environments, workspacePath, type Environment } from "../runtime/environment.js";
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
    if ((version !== RESEARCH_CONTRACT_VERSION && !context.accepted) || ![1, 2, RESEARCH_CONTRACT_VERSION].includes(version))
      result.findings.push({ code: "research_contract_upgrade_required", target: stage, message: "New stage acceptance requires the enriched research contract; legacy history remains readable" });
    const expected = (legacy ? LEGACY_REQUIREMENTS : version === 2 ? VERSION2_REQUIREMENTS : REQUIREMENTS)[stage as UpstreamStage];
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
      if (version === RESEARCH_CONTRACT_VERSION && result.findings.length === 0) {
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
    const feasibility = this.store.get<Feasibility>(`feasibility:${project}`);
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
      feasibility, feasibilityGate: feasibility ? this.refinement.feasibilityGate(project, reference(feasibility)) : null,
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
  exportStage(project: string, stage: Stage): string {
    this.#project(project); const projection = this.pipeline.inspect(project, stage);
    requireCondition(projection.artifact, "artifact_missing", "Stage has no artifact yet");
    return `# ${stage}\n\nState: ${projection.state}\nRevision: ${projection.artifact.revision}\nSHA-256: ${projection.artifact.hash}\n\n\`\`\`json\n${JSON.stringify(projection.artifact.value.content, null, 2)}\n\`\`\`\n`;
  }
  execute(input: unknown): unknown {
    const command = parseCommand(input);
    switch (command.type) {
      case 'apply-obligation-policy': this.#project(command.project); return applyObligationPolicy(this.store,command.project,command.scope,command.policy);
      case "recover-model-call": this.#project(command.project); return recoverModelCall(this.store,command.project,command.call);
      case 'recover-context-session': this.#project(command.project); return recoverContextSession(this.store,command.project,command.session,command.selector);
      case 'retry-planned-read': this.#project(command.project); return retryPlannedRead(this.store,command.project,command.child);
      case 'allocate-research-trial': this.#project(command.project); return allocateResearchTrial(this.store,command.project,command);
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
      case "begin-research": this.#project(command.project); return this.refinement.begin(command.project, command.level);
      case "finish-research": this.#project(command.project); return this.refinement.finishResearch(command.project, command.level, command.draft, command.expected);
      case "seal-layer": this.#project(command.project); return this.refinement.sealLayer(command.project, command.level, command.expected);
      case "prepare-layer": this.#project(command.project); return this.refinement.prepareLayer(command.project, command.level);
      case "build-layer": this.#project(command.project); return this.refinement.buildLayer(command.project, command.level, command.draft, command.expected, this.actor);
      case "task-context": this.#project(command.project); return this.compiler.context(command.project, command.plan, command.task, command.maxChars);
      case "task-detail": this.#project(command.project); return this.compiler.detail(command.project, command.plan, command.task, command.kind, command.selector, command.maxChars);
      case "assess": this.#project(command.project); return this.refinement.assess(command.project, command.expected);
      case "draft-om": this.#project(command.project); return this.refinement.publish(command.project, command.feasibility, command.expected);
      case "compile": {
        assertPilotBoundary(this.store, command.project, "R3");
        this.#project(command.project); const plan = this.compiler.compile(command.project);
        const current = this.store.get<StageArtifact>(stageId(command.project, "compilation"));
        if (current?.value.status === "accepted" && (current.value.content as unknown as { plan?: Ref }).plan?.hash === plan.hash) return plan;
        const stage = this.compiler.publish(command.project, reference(plan), current?.revision ?? 0);
        this.pipeline.accept(command.project, "compilation", stage.revision); return plan;
      }
      case "draft-plan": this.#project(command.project); assertPilotBoundary(this.store, command.project, "R3"); return this.compiler.publish(command.project, command.plan, command.expected);
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
      case "accept-stage": this.#project(command.project);
        if (["om-g2", "compilation", "execution"].includes(command.stage)) assertPilotBoundary(this.store, command.project, "R3");
        return this.pipeline.accept(command.project, command.stage, command.expected);
      case "project": return this.projection(command.project);
      case "export-stage": return this.exportStage(command.project, command.stage);
    }
  }
}

import { answerDiscoveryCondition } from '../discovery/discovery-decision.js';
import { runIntegrityCheck } from "../om/integrity.js";
import { listBypassDecisions } from "../om/addressing.js";
import { recoverModelCall } from "../discovery/model-call-recovery.js";
import { recoverOmModelCall } from "../om/model-call.js";
import { configureDispatch } from '../om/dispatch.js';
import { recoverOmCapacity, permitOmLimitedCallRetry } from '../om/capacity-delivery.js';
import { continuePass, readPass, resumeStoppedPass, startPass, stopPass } from '../om/run-driver.js';
import { readEnvironmentReadiness } from '../om/environment-readiness.js';
import { regateRun, releaseRegateWait } from '../om/run.js';
import { spendReport } from '../om/spend-report.js';
import { writeGuarded } from '../om/refs.js';
import { prepareFeasibility, readFeasibility, type OmFeasibility } from '../om/feasibility.js';
import type { LayerBasis } from '../om/layer-basis.js';
// The product assembly point: loading ProductEngine installs the OM obligation
// reader pair into the lower graph slot before any consumer reads an OM era.
import '../om/obligations.js';
// …and the OM readers of the compiler, its context, refinement and task
// obligations into the lower compiler slot (R3+R4).
import '../om/compiler-readers.js';
import { declareAdapterLineage } from '../adapters/adapter-lineage.js';
import { recoverResearchResponse, permitCancelledCallRetry, permitLimitedCallRetry } from '../discovery/response-recovery.js';
import { recoverContextSession } from '../discovery/context-recovery.js';
import { allocateResearchTrial } from '../discovery/research-trial.js';
import { retryPlannedRead } from '../discovery/reading-plan.js';
import { applyObligationPolicy } from '../graph/obligation-application.js';
import { observeRuntime, recoverRuntimeObservation } from '../runtime/runtime-observation.js';
import { continuePreparation, recoverLegacyOperation } from "./preparation-run.js";
import { mapStatus, saveMapStatus } from "../graph/map-status.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { StageChecks, type Project, type StageContent } from "./stage-checks.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { STAGES, predecessor, reference, isRef, stageId, type Stage, type StageArtifact,
  type GateContext, type GateResult, type Ref } from "../pipeline/contracts.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import { GraphRepository } from "../graph/repository.js";
import { canonical, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { parseCommand } from "./commands.js";
import type { Graph } from "../graph/model.js";
import { Environments, transactionGuardsCurrent, uniqueTransactionGuards, workspacePath, type Environment } from "../runtime/environment.js";
import { Refinement, PHASES, type Feasibility } from "../graph/refinement.js";
import { buildL1 } from "../graph/builder.js";
import type { ChatTurn } from "./chat.js";
import type { Source } from "../evidence/evidence.js";
import { Compiler, type MachinePlan } from "../compiler/compiler.js";
import { Executor, planCurrentGuards } from "../execution/runner.js";
import type { TaskRun } from "../execution/model.js";
import type { ExecutionRoot } from "../runtime/environment.js";
import { Researcher } from "../discovery/research-runner.js";
import type { ResearchRun } from "../discovery/research-model.js";
import { PlanRepairs } from "./repairs.js";
import { StageResearch } from "./stage-research.js";
import { EarlyStageDriver } from "./early-stage-driver.js";
import { RefinementResearch } from "./refinement-research.js";
import { modelUsage } from "../runtime/model-usage.js";
import { configureReaderPilot, assertPilotBoundary } from "../discovery/reader-pilot.js";
import { configureSavedSynthesis } from "../discovery/saved-synthesis.js";
import { OwnerSessions, issueOwnerInvitation, type OwnerAuthority } from "./owner-authority.js";
import { listOwnerQuestions, writeOwnerResult, type OwnerReaders } from "../om/owner-result.js";
import { readOmInput } from "../om/input.js";
import { readRoutes } from "../om/routes.js";
import { RunControlGate, type RunControlHold } from "../om/run-control.js";
import { renderStageSummary, stageSummary } from "./stage-summary.js";

export type { Project, StageContent } from "./stage-checks.js";
/** H2.0: the om readers the owner producer shares with the G4b gate — handed in so om/owner-result stays off the ring. */
const ENGINE_OWNER_READERS: OwnerReaders = { routes: readRoutes, input: readOmInput };

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
  readonly earlyStages: EarlyStageDriver;
  readonly refinementResearch: RefinementResearch;
  /** The lower kit of stage checks, era and compile (R2, №2419): the fields above are its very instances. */
  readonly checks: StageChecks;
  /** H2.0: the in-memory owner-session registry — its bearer map dies with this engine (and its server). */
  readonly owners: OwnerSessions;
  constructor(readonly store: Store, private readonly actor = "local-caller") {
    this.owners = new OwnerSessions(store);
    this.checks = new StageChecks(store);
    this.discovery = this.checks.discovery; this.graphs = this.checks.graphs; this.pipeline = this.checks.pipeline;
    this.environments = this.checks.environments; this.refinement = this.checks.refinement; this.compiler = this.checks.compiler;
    this.executor = new Executor(store, this.compiler, this.environments);
    this.researcher = new Researcher(store, this.discovery, this.environments);
    this.repairs = new PlanRepairs(this);
    this.stageResearch = new StageResearch(this);
    this.earlyStages = new EarlyStageDriver(this);
    this.refinementResearch = new RefinementResearch(this, actor);
  }
  protected validateStage(stage: Stage, context: GateContext): GateResult { return this.checks.validateStage(stage, context); }
  #project(id: string): Revision<Project> { return this.checks.project(id); }
  #prepare(project: string, stage: UpstreamStage, entryInputs: Ref[]): Revision<DiscoveryDraft> {
    this.#project(project);
    const prior = predecessor(stage); const inputs: Ref[] = [];
    if (prior) { const status = this.pipeline.inspect(project, prior); requireCondition(status.state === "accepted", "predecessor_not_ready", `${prior} must be accepted`); inputs.push(...status.guards); }
    requireCondition(stage === "discovery" || entryInputs.length === 0, "research_context_invalid",
      "Only Discovery accepts the exact early-stage input basis");
    inputs.push(...entryInputs);
    const consumer = STAGES[STAGES.indexOf(stage) + 1]!;
    return this.discovery.forStage(project, stage, consumer, inputs);
  }
  prepare(project: string, stage: UpstreamStage): Revision<DiscoveryDraft> { return this.#prepare(project, stage, []); }
  /** DRV1: prepare's one transaction carries the early executor's exact durable control. */
  prepareEarlyStage(project: string, stage: UpstreamStage, hold: RunControlHold, entryInputs: Ref[] = []): Revision<DiscoveryDraft> {
    return new ProductEngine(new RunControlGate(this.store, project, hold).view(), this.actor).#prepare(project, stage, entryInputs);
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
    const ownerQuestions = om ? listOwnerQuestions(this.store, project, ENGINE_OWNER_READERS) : null;
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
      // H2.0 (№2719-7): the owner-question detail for the UI — om-state names the wait, this projection names the
      // exact questions and their answered state. Listing proves nothing and grants nothing. The key exists only
      // where it has content (or a refusal to report): era tests compare old-producer projections byte-for-byte,
      // and a database without owner-routed questions must keep its exact historical shape (G1.2, B3).
      ...(ownerQuestions === null || ownerQuestions.ok && ownerQuestions.value.length === 0 ? {}
        : { ownerQuestions }),
    };
  }
  /**
   * H2.0 owner authority — deliberately outside execute(): no ProductCommand, actor name, `owner:true` field, record
   * hash or transport header is a credential. The CLI issues an invitation; the server exchanges it once for a bearer;
   * the producer accepts only the opaque OwnerAuthority object these calls mint.
   */
  ownerInvitation(project: string) { return issueOwnerInvitation(this.store, { project }); }
  ownerSessionExchange(request: unknown) { return this.owners.exchange(request); }
  ownerAuthority(bearer: unknown): OwnerAuthority | null { return this.owners.authority(bearer); }
  ownerLogout(bearer: unknown) { return this.owners.revoke(bearer); }
  ownerDecision(authority: unknown, request: unknown) {
    return writeOwnerResult(this.store, authority, request, ENGINE_OWNER_READERS);
  }
  /** Capture the absent dependency before resolving the project era. It belongs only to new production. */
  legacyRoute(project: string): { om: boolean; guards: TransactionGuard[] } { return this.checks.legacyRoute(project); }
  #legacyProductionGuards(project: string): TransactionGuard[] { return this.checks.legacyProductionGuards(project); }
  #production<T>(project: string, guards: TransactionGuard[], produce: () => T): T { return this.checks.production(project, guards, produce); }
  #planProductionGuards(project: string, planRef: Ref): TransactionGuard[] { return this.checks.planProductionGuards(project, planRef); }
  compile(project: string, extraGuards: TransactionGuard[] = []) { return this.checks.compile(project, extraGuards); }
  /** The first B1 is an immutable era boundary, independent of current stage or layer readiness. */
  #omProject(project: string): boolean { return this.checks.omProject(project); }
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
    this.#project(project);
    if (UPSTREAM_STAGES.includes(stage as UpstreamStage)) {
      const summary = stageSummary(this.store, project, stage);
      const ref = summary.accepted?.artifact ?? summary.currentStage;
      if (!ref) return renderStageSummary(summary);
      const artifact = this.store.get<StageArtifact>(ref.id, ref.revision);
      requireCondition(artifact?.hash === ref.hash, "artifact_missing", "The summarized stage artifact is unavailable");
      return `${renderStageSummary(summary)}\n## Исходный JSON\n\n\`\`\`json\n${JSON.stringify(artifact.value.content, null, 2)}\n\`\`\`\n`;
    }
    const projection = this.pipeline.inspect(project, stage);
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
      // DRY6-02: the explicit addressed door of an older cancelled attempt — one new attempt of exactly that call.
      case "permit-cancelled-call-retry": this.#project(command.project); return permitCancelledCallRetry(this.store, command, this.actor);
      case "recover-om-capacity": this.#project(command.project); return recoverOmCapacity(this.store, command, this.actor);
      case "permit-limited-call-retry": {
        this.#project(command.project);
        const value = this.store.get<Record<string, unknown>>(command.call.id)?.value;
        return value && 'om' in value
          ? permitOmLimitedCallRetry(this.store, command, this.actor)
          : permitLimitedCallRetry(this.store, command, this.actor);
      }
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
      case "early-stage-run": return this.earlyStages.run(command);
      case "revise-early-stage-input": return this.earlyStages.reviseInput(command.project, command.expected, command.instruction);
      case "research-phase": this.#project(command.project); return this.refinementResearch.run(command.project, command.phase, command.draftId, command.maxTurns);
      case "model-usage": this.#project(command.project); return modelUsage(this.store, command.project, command.since);
      case "configure-reader-pilot": this.#project(command.project); return configureReaderPilot(this.store, this.environments, command.project, command.settings, command.expected,
        plan => planCurrentGuards(this.store, this.compiler, plan));
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
      case "execute-plan": this.#project(command.project); assertPilotBoundary(this.store, command.project, "execution", command.plan); return this.executor.run(command.project, command.plan, command);
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
        // RL3 (№4218): the owner's release of the wait on their reopening's policies is decided first, like a named resume.
        if (command.release !== undefined) {
          const released = releaseRegateWait(this.store, { project: command.project });
          if (!released.ok) return Promise.resolve(released);
        }
        return continuePass(this.store, { project: command.project });
      }
      case "om-state": this.#project(command.project); return readPass(this.store, { project: command.project });
      // ENV1: the read-only conditions of the environment, each with its moment; it writes and admits nothing.
      case "environment-readiness": this.#project(command.project); return readEnvironmentReadiness(this.store, { project: command.project });
      case "om-spend": this.#project(command.project); return spendReport(this.store, { project: command.project });
      case "om-stop": this.#project(command.project); return stopPass(this.store, { project: command.project });
      // NR1 (№3646): the integrity check of the database on request; it also runs by itself at every om-start and om-continue.
      case "om-fsck": this.#project(command.project); return runIntegrityCheck(this.store, { project: command.project });
      // OWN1 (№3714): read only — the questions the pass decided in the bypass, with the model's choice and its alternatives.
      case "om-decisions": this.#project(command.project); return listBypassDecisions(this.store, { project: command.project });
      case "om-regate": this.#project(command.project); return regateRun(this.store, { project: command.project });
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
      case "answer-decision":
        if ('mode' in command) { this.#project(command.project); return answerDiscoveryCondition(this.store, command, this.actor); }
        return this.discovery.decision(command.question, command.expected, this.actor, command.value);
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
      case "stage-summary": this.#project(command.project); return stageSummary(this.store, command.project, command.stage, command.draftId);
      case "export-stage": return this.exportStage(command.project, command.stage);
    }
  }
}

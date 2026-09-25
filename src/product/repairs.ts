import type { ProductEngine } from "./engine.js";
import type { Revision, TransactionGuard } from "../storage/store.js";
import type { TaskRun } from "../execution/model.js";
import { runId } from "../execution/model.js";
import { acquire, release } from "../execution/lock.js";
import { parkCandidate } from "../execution/park.js";
import { canonical, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { reference, isRef, stageId, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { git } from "../runtime/environment.js";
import type { Source } from "../evidence/evidence.js";
import type { PlanDefect, PlanReissue } from "../graph/plan-defects.js";
import type { Graph } from "../graph/model.js";
import type { DiscoveryDraft, Question } from "../discovery/discovery.js";
import type { ResearchRun } from "../discovery/research-model.js";
import type { Feasibility } from "../graph/refinement.js";
import { composeLayer } from "../graph/layer-design.js";
import { nodeSignature } from "../compiler/model.js";
import { reopenRejectedRepair } from "./repair-feedback.js";
import { beginLegacyOperation, finishLegacyOperation } from "./preparation-run.js";

export interface PlanRepair {
  projectId: string; run: Ref; defect: Ref; parked: Ref; level: 1 | 2;
  phase: "research" | "design" | "compile" | "reissued"; draftId: string;
  plan: Ref | null; error: string | null;
}

export class PlanRepairs {
  constructor(private readonly engine: ProductEngine) {}
  async prepare(project: string, runRef: Ref): Promise<Revision<PlanRepair>> {
    const route = this.engine.legacyRoute(project);
    return this.#withOperation(project, runRef, route, () => this.#prepare(project, runRef, route));
  }
  async #withOperation(project: string, runRef: Ref, route: { om: boolean; guards: TransactionGuard[] },
    work: () => Promise<Revision<PlanRepair>>): Promise<Revision<PlanRepair>> {
    requireCondition(isRef(runRef), "repair_run_foreign", "Repair needs an exact failed plan attempt");
    if (route.om) return work();
    const { store } = this.engine;
    const previous = store.get<PlanRepair>(`plan-repair:${hashJson(runRef)}`);
    if (previous?.value.phase === "reissued") {
      requireCondition(previous.kind === "plan-repair" && previous.value.projectId === project,
        "repair_foreign", "Repair belongs to another project");
      return previous;
    }
    const run = store.get<TaskRun>(runRef.id);
    requireCondition(run?.kind === "task-run" && canonical(reference(run)) === canonical(runRef)
      && run.value.projectId === project && run.value.state === "needs_plan",
    "repair_run_foreign", "Repair needs this project's exact plan defect");
    const lease = beginLegacyOperation(store, project, "repair", runRef, [], [runRef, ...route.guards]);
    let result: Revision<PlanRepair> | null = null;
    let failure: unknown = null;
    try {
      result = await work();
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      finishLegacyOperation(store, lease, result ? reference(result) : null, failure);
    }
  }
  async #prepare(project: string, runRef: Ref, route: { om: boolean; guards: TransactionGuard[] }): Promise<Revision<PlanRepair>> {
    const { store, compiler, discovery, graphs, refinement } = this.engine;
    requireCondition(isRef(runRef), "repair_run_foreign", "Repair needs an exact failed plan attempt");
    const id = `plan-repair:${hashJson(runRef)}`;
    if (route.om) {
      const previous = store.get<PlanRepair>(id);
      if (previous?.kind === "plan-repair" && previous.value?.projectId === project && previous.value.phase === "reissued"
        && isRef(previous.value.run) && canonical(previous.value.run) === canonical(runRef) && isRef(previous.value.plan) && isRef(previous.value.defect)) {
        const plan = compiler.read(previous.value.plan.id);
        const result: PlanReissue = { projectId: project, defect: previous.value.defect, plan: previous.value.plan };
        const reissue = store.get<PlanReissue>(`plan-reissue:${hashJson(result)}`);
        const defect = store.get<PlanDefect>(previous.value.defect.id, previous.value.defect.revision);
        const failed = store.get<TaskRun>(runRef.id, runRef.revision);
        const accepted = store.history<StageArtifact>(stageId(project, "compilation")).some(stage => stage.kind === "stage"
          && stage.value?.projectId === project && stage.value.stage === "compilation" && stage.value.status === "accepted"
          && canonical(stage.value.content ?? null) === canonical({ plan: previous.value.plan })
          && Array.isArray(stage.value.inputs) && stage.value.inputs.length === 1 && canonical(stage.value.inputs[0]) === canonical(plan.value.stage)
          && Array.isArray(stage.value.proofs) && stage.value.proofs.some(ref => canonical(ref) === canonical(previous.value.plan)));
        if (plan.value.projectId === project && canonical(reference(plan)) === canonical(previous.value.plan) && accepted
          && reissue?.kind === "plan-reissue" && canonical(reissue.value) === canonical(result)
          && defect?.kind === "plan-defect" && canonical(reference(defect)) === canonical(previous.value.defect)
          && defect.value?.projectId === project && isRef(defect.value.run) && canonical(defect.value.run) === canonical(runRef)
          && failed?.kind === "task-run" && canonical(reference(failed)) === canonical(runRef)
          && failed.value?.projectId === project && failed.value.state === "needs_plan"
          && isRef(failed.value.plan) && canonical(defect.value.plan ?? null) === canonical(failed.value.plan)) return previous;
      }
      throw new EngineError("legacy_route_closed", "OM projects cannot continue legacy plan repair", { unit: "product", target: `om-input:${project}` });
    }
    const lock = acquire(store, project);
    try {
      const previous = store.get<PlanRepair>(id);
      if (previous) { requireCondition(previous.value.projectId === project, "repair_foreign", "Repair belongs to another project"); return previous; }
      const run = store.get<TaskRun>(runRef.id);
      requireCondition(run?.kind === "task-run" && canonical(reference(run)) === canonical(runRef) && run.value.projectId === project
        && run.value.state === "needs_plan", "repair_run_foreign", "Repair needs this project's exact plan defect");
      const plan = compiler.read(run.value.plan.id);
      const task = plan.value.tasks.find(task => task.id === run.value.taskId)!;
      const currentGraph = store.get<Graph>(`graph:${project}`)!;
      const completed = plan.value.tasks.filter(task => store.get<TaskRun>(runId(plan.value.hash, task.id))?.value.state === "committed").map(task => task.node);
      const remaining = plan.value.graphSnapshot.horizon.filter(node => !completed.includes(node));
      requireCondition(hashJson({ ...currentGraph.value, horizon: plan.value.graphSnapshot.horizon }) === hashJson(plan.value.graphSnapshot)
        && (canonical(currentGraph.value.horizon) === canonical(plan.value.graphSnapshot.horizon) || canonical(currentGraph.value.horizon) === canonical(remaining)),
      "repair_graph_changed", "The map changed after this failure; its new meaning cannot be overwritten by old repair work");
      const parked = await parkCandidate(store, compiler, project, runRef);
      const sourceId = `failure-${hashJson(runRef).slice(0, 32)}`;
      const text = canonical({ kind: "reported-plan-defect", acceptedImplementation: false, run: runRef, plan: run.value.plan,
        node: task.node, parent: run.value.parent, candidate: parked.value.tree, findings: run.value.review?.findings ?? [run.value.error],
        patch: git(parked.value.previous.path, ["diff", "--binary", run.value.parent, parked.value.tree]),
        checks: run.value.checks.map(check => ({ command: check.command, exitCode: check.result.exitCode, signal: check.result.signal })) });
      const oldSource = store.get<Source>(`source:${project}:${sourceId}`);
      requireCondition(!oldSource || oldSource.value.content === text, "repair_evidence_changed", "The recorded failure evidence was replaced");
      const source = oldSource ?? discovery.evidence.document(project, sourceId, text, "application/json", 0);
      const defectId = `plan-defect:${hashJson(runRef)}`;
      const defect = store.get<PlanDefect>(defectId) ?? store.writeMany<PlanDefect>([{ id: defectId, kind: "plan-defect", expected: 0,
        value: { projectId: project, run: runRef, plan: run.value.plan, node: task.node,
          question: `Исполнение не смогло подтвердить результат «${task.title}»: ${run.value.review?.findings.join("; ") ?? run.value.error}. Исправь причину в плане, а не повторяй то же задание.`,
          source: reference(source), parked: reference(parked) } }], [runRef, reference(source), reference(parked), ...route.guards])[0]!;
      if (canonical(currentGraph.value.horizon) !== canonical(remaining)) graphs.save(project, { ...currentGraph.value, horizon: remaining }, currentGraph.revision, "engine:plan-repair");
      const level = refinement.gate(project, "L2").findings.length ? 1 : 2;
      const draft = refinement.begin(project, level === 1 ? "R1" : "R2");
      return store.writeMany<PlanRepair>([{ id, kind: "plan-repair", expected: 0, value: { projectId: project, run: runRef,
        defect: reference(defect), parked: reference(parked), level, phase: "research", draftId: draft.id, plan: null, error: null } }],
      [runRef, reference(defect), reference(parked), ...route.guards])[0]!;
    } finally { release(store, lock); }
  }
  async run(project: string, runRef: Ref, maxTurns: number): Promise<Revision<PlanRepair>> {
    requireCondition(Number.isInteger(maxTurns) && maxTurns > 0 && maxTurns <= 100, "research_budget_invalid", "Repair needs a bounded research allowance");
    const route = this.engine.legacyRoute(project);
    return this.#withOperation(project, runRef, route, () => this.#run(project, runRef, maxTurns, route));
  }
  async #run(project: string, runRef: Ref, maxTurns: number, route: { om: boolean; guards: TransactionGuard[] }): Promise<Revision<PlanRepair>> {
    let repair = await this.#prepare(project, runRef, route);
    if (repair.value.phase === "reissued") return repair;
    const { store, researcher, refinement, compiler, pipeline } = this.engine;
    const lock = acquire(store, project); let remaining = maxTurns;
    const save = (patch: Partial<PlanRepair>) => { repair = store.write({ id: repair.id, kind: repair.kind, expected: repair.revision, value: { ...repair.value, ...patch } }); };
    try {
      while (repair.value.phase !== "reissued") {
        const phase = repair.value.phase, level = repair.value.level;
        if (phase === "research" || phase === "design") {
          if (!remaining) { save({ error: "Research allowance reached; the repair is saved for continuation" }); return repair; }
          const before = store.list<ResearchRun>("research-run").find(run => run.value.draftId === repair.value.draftId)?.value.turns ?? 0;
          const research = await researcher.run(project, repair.value.draftId, remaining);
          remaining -= research.value.turns - before;
          if (research.value.status !== "completed") { save({ error: research.value.error ?? research.value.status }); return repair; }
          const draft = store.get<DiscoveryDraft>(repair.value.draftId)!;
          if (phase === "research") {
            const target = level === 1 ? "R1" : "R2";
            refinement.finishResearch(project, target, reference(draft), store.get(`phase:${project}:${target}`)?.revision ?? 0);
            const design = refinement.prepareLayer(project, level === 1 ? 2 : 3);
            save({ phase: "design", draftId: design.id, error: null });
          } else {
            const layer = level === 1 ? 2 : 3;
            const graph = store.get<Graph>(`graph:${project}`)!;
            if (layer === 3) {
              const question = draft.value.questions.map(id => store.get<Question>(id)).find(item => item?.value.spec.field === 'layerDesign');
              requireCondition(question, 'research_contract_mismatch', 'Repair must retain the producing layer-design question');
              const proposed = composeLayer(graph.value, 3, draft.value.fields['layerDesign'], question.value.spec.layerAssembly);
              const failed = store.get<TaskRun>(runRef.id, runRef.revision)!;
              const oldPlan = compiler.read(failed.value.plan.id);
              for (const task of oldPlan.value.tasks) if (store.get<TaskRun>(runId(oldPlan.value.hash, task.id))?.value.state === "committed" && proposed.horizon.includes(task.node)) {
                requireCondition(nodeSignature(proposed, proposed.nodes.find(node => node.id === task.node)!) !== task.signature,
                  "accepted_prefix_repeated", "Repair cannot repeat an unchanged accepted unit; preserve its existing result");
              }
            }
            refinement.buildLayer(project, layer, reference(draft), graph.revision, "engine:plan-repair");
            refinement.sealLayer(project, layer, store.get(`phase:${project}:L${layer}`)?.revision ?? 0);
            if (level === 1) { const next = refinement.begin(project, "R2"); save({ level: 2, phase: "research", draftId: next.id, error: null }); }
            else save({ phase: "compile", error: null });
          }
        } else {
          const old = store.get<Feasibility>(`feasibility:${project}`);
          const feasibility = old && refinement.feasibilityGate(project, reference(old)).findings.length === 0 ? old : refinement.assess(project, old?.revision ?? 0, route.guards);
          requireCondition(feasibility.value.ready, "repair_not_feasible", "The corrected map still has unresolved feasibility findings");
          const stage = store.get<StageArtifact>(stageId(project, "om-g2"));
          if (canonical(stage?.value.content ?? null) !== canonical({ feasibility: reference(feasibility) }) || stage?.value.status !== "accepted") {
            const artifact = refinement.publish(project, reference(feasibility), stage?.revision ?? 0, route.guards); pipeline.accept(project, "om-g2", artifact.revision, route.guards);
          }
          const plan = compiler.compile(project, route.guards);
          const prior = store.get<StageArtifact>(stageId(project, "compilation"));
          if (canonical(prior?.value.content ?? null) !== canonical({ plan: reference(plan) }) || prior?.value.status !== "accepted") {
            const artifact = compiler.publish(project, reference(plan), prior?.revision ?? 0, route.guards); pipeline.accept(project, "compilation", artifact.revision, route.guards);
          }
          const result: PlanReissue = { projectId: project, defect: repair.value.defect, plan: reference(plan) };
          repair = store.writeMany<PlanRepair>([
            { id: repair.id, kind: repair.kind, expected: repair.revision, value: { ...repair.value, phase: "reissued", plan: reference(plan), error: null } },
            { id: `plan-reissue:${hashJson(result)}`, kind: "plan-reissue", expected: 0, value: result },
          ], [reference(plan), repair.value.defect, ...route.guards])[0]!;
        }
      }
      return repair;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Repair paused";
      const phase = reopenRejectedRepair(store, this.engine.discovery, repair.value, repair.id, error);
      save({ ...(phase ? { phase } : {}), error: message });
      return repair;
    }
    finally { release(store, lock); }
  }
}

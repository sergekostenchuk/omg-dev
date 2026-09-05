import { Store, type Revision } from "../storage/store.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { Refinement, type Feasibility } from "../graph/refinement.js";
import { Environments, type Environment } from "../runtime/environment.js";
import { requireGraph } from "../graph/validate.js";
import type { Graph } from "../graph/model.js";
import { hashJson, type Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { isRef, reference, type Ref, type GateResult } from "../pipeline/contracts.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import type { MachinePlan } from "./model.js";
import { deriveTasks } from "./derive.js";
import { resolveArtifact } from "./inputs.js";
import { requireBasis } from "./basis.js";
import { REFINEMENT_CONTRACT_VERSION } from "../graph/research-contracts.js";
import { taskContext, boundedContext, selectDetail, type DetailSelector, type EvidenceDetail } from "./context.js";
import { Owners } from "../ownership/owners.js";
export type { MachinePlan } from "./model.js";

export class Compiler {
  constructor(private readonly store: Store, private readonly pipeline: Pipeline, private readonly refinement: Refinement,
    private readonly environments: Environments) {}
  compile(project: string): Revision<MachinePlan> {
    const stage = this.pipeline.inspect(project, "om-g2");
    requireCondition(stage.state === "accepted" && stage.artifact, "om_not_ready", "OM-G2 must be accepted and current");
    const feasibilityRef = (stage.artifact.value.content as unknown as { feasibility: Ref }).feasibility;
    const feasibility = this.store.get<Feasibility>(feasibilityRef.id)!;
    const checked = this.refinement.feasibilityGate(project, feasibilityRef);
    requireCondition(checked.findings.length === 0 && feasibility.value.repository, "feasibility_not_ready", "Current R3 proof is required");
    const record = this.store.get<Graph>(`graph:${project}`)!; const graph = requireGraph(record.value);
    const environment = this.environments.get(project);
    const owners = new Owners(this.store, project, feasibility.value.repository!);
    const derived = deriveTasks(project, record.hash, graph, (producer, artifact) =>
      resolveArtifact(this.store, project, graph, feasibility.value.repository!, producer, artifact), { version: 2, owner: path => owners.latest(path) });
    const guards = [...new Map([...stage.guards, ...checked.guards, ...derived.guards].map(ref => [`${ref.id}:${ref.revision}`, ref])).values()];
    const body = { version: 2 as const, projectId: project, graph: reference(record), environment: reference(environment),
      stage: reference(stage.artifact), feasibility: feasibilityRef, base: feasibility.value.repository,
      guards, tasks: derived.tasks, graphSnapshot: graph };
    const value: MachinePlan = { ...body, hash: hashJson(body) }; const id = `plan:${project}:${value.hash}`;
    const existing = this.store.get<MachinePlan>(id);
    if (existing) return existing;
    const pointer = this.store.get<Ref>(`current-plan:${project}`);
    return this.store.writeMany<MachinePlan>([
      { id, kind: "plan", expected: 0, value },
      { id: `current-plan:${project}`, kind: "current-plan", expected: pointer?.revision ?? 0,
        value: { id, revision: 1, hash: hashJson(value) } },
    ], guards)[0]!;
  }
  read(id: string): Revision<MachinePlan> {
    const plan = this.store.get<MachinePlan>(id);
    requireCondition(plan && plan.kind === "plan", "plan_missing", "Machine plan is missing");
    requireBasis(this.store, plan.value);
    const { hash, ...body } = plan.value;
    requireCondition(hashJson(body) === hash, "plan_corrupt", "Machine plan checksum mismatch");
    const graph = this.store.get<Graph>(plan.value.graph.id, plan.value.graph.revision);
    requireCondition(graph?.kind === "graph" && graph.hash === plan.value.graph.hash
      && hashJson(graph.value) === hashJson(plan.value.graphSnapshot), "plan_foreign", "Plan must bind its exact graph version");
    const owners = plan.value.version === 2 ? new Owners(this.store, plan.value.projectId, plan.value.base) : null;
    const derived = deriveTasks(plan.value.projectId, graph.hash, requireGraph(graph.value), (producer, artifact) =>
      resolveArtifact(this.store, plan.value.projectId, graph.value, plan.value.base, producer, artifact, plan.value.guards),
    { version: plan.value.version, owner: path => owners?.latest(path) ?? null });
    requireCondition(hashJson(derived.tasks) === hashJson(plan.value.tasks), "plan_derivation_mismatch", "Tasks must be derived from the bound map without manual edits");
    return plan;
  }
  gate(project: string, ref: Ref, allowHistorical = false): GateResult {
    requireCondition(isRef(ref), "plan_ref_invalid", "A versioned plan reference is required");
    const plan = this.read(ref.id); const result: GateResult = { findings: [], guards: [reference(plan)] };
    if (plan.value.projectId !== project || plan.hash !== ref.hash || plan.revision !== ref.revision) {
      result.findings.push({ code: "plan_foreign", target: ref.id, message: "Plan binding is foreign or changed" }); return result;
    }
    if (plan.value.version !== 2 && !allowHistorical) result.findings.push({ code: "plan_version_upgrade_required", target: ref.id,
      message: "New plan admission requires version 2 write grants; historical accepted plans remain readable" });
    const basis = this.store.get<Feasibility>(plan.value.feasibility.id, plan.value.feasibility.revision)!;
    if (basis.value.contractVersion !== REFINEMENT_CONTRACT_VERSION && !(allowHistorical && basis.value.contractVersion === undefined))
      result.findings.push({ code: "refinement_upgrade_required", target: plan.value.feasibility.id, message: "New plan admission requires the enriched refinement contract" });
    for (const input of plan.value.guards) {
      const current = this.store.get(input.id);
      if (!current || current.revision !== input.revision || current.hash !== input.hash
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "plan_stale", target: input.id, message: "A source used to compile this plan changed" });
      else result.guards.push(reference(current));
    }
    return result;
  }
  publish(project: string, planRef: Ref, expected: number) {
    const checked = this.gate(project, planRef); requireCondition(checked.findings.length === 0, "plan_stale", "Plan inputs are not current");
    return this.pipeline.draft(project, "compilation", { plan: planRef } as unknown as Json, expected);
  }
  #contextPlan(project: string, planRef: Ref, task: string): Revision<MachinePlan> {
    const checked = this.gate(project, planRef);
    requireCondition(checked.findings.length === 0, "plan_stale", "Task context needs current exact plan inputs");
    const plan = this.store.get<MachinePlan>(planRef.id)!;
    requireCondition(plan.value.tasks.some(item => item.id === task), "task_foreign", "Task does not belong to this machine plan");
    return plan;
  }
  context(project: string, planRef: Ref, task: string, maxChars: number) {
    const plan = this.#contextPlan(project, planRef, task);
    const ref = plan.value.environment;
    const environment = this.store.get<Environment>(ref.id, ref.revision);
    requireCondition(environment?.kind === "environment" && environment.hash === ref.hash && environment.value.projectId === project,
      "context_environment_foreign", "Full-run criteria must come from the exact plan environment");
    return taskContext(plan, environment.value.fullCheck, task, maxChars);
  }
  detail(project: string, planRef: Ref, task: string, kind: "graph" | "evidence" | "evidence-index", selector: DetailSelector, maxChars: number) {
    const plan = this.#contextPlan(project, planRef, task);
    const evidence = plan.value.guards.flatMap(ref => {
      const record = this.store.get(ref.id, ref.revision);
      return record && record.hash === ref.hash && (record.value as { projectId?: string }).projectId === project
        && ["source", "stage", "discovery-draft", "research-assessment", "task-run"].includes(record.kind)
        ? [{ ref, kind: record.kind } satisfies EvidenceDetail] : [];
    });
    let value: unknown; let source = plan.value.graph;
    if (kind === "evidence-index") { value = evidence; source = reference(plan); }
    else if (kind === "evidence") {
      const found = evidence.find(item => item.ref.id === selector.id);
      requireCondition(found, "context_evidence_foreign", "Evidence must be an exact input of this plan");
      source = found.ref; value = this.store.get(found.ref.id, found.ref.revision)!.value;
    } else {
      const graph = plan.value.graphSnapshot;
      value = [graph.nodes, graph.artifacts, graph.contracts, graph.connectors, graph.tests, graph.joins, graph.anchors,
        graph.actors ?? [], graph.requirements ?? [], graph.edges ?? [], graph.transfers ?? [], graph.packets ?? [], graph.journeys ?? []]
        .flat().find(item => item.id === selector.id);
      requireCondition(value, "context_detail_missing", "Graph entity is absent from this exact plan");
    }
    return boundedContext({ binding: { plan: reference(plan), task, source }, kind, selector, value: selectDetail(value, selector) }, maxChars);
  }
}

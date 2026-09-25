import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { Refinement, type Feasibility } from "../graph/refinement.js";
import { Environments, transactionGuardsCurrent, uniqueTransactionGuards, type Environment } from "../runtime/environment.js";
import { requireGraph } from "../graph/validate.js";
import type { Graph } from "../graph/model.js";
import { hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, uniqueRefs, type Ref, type GateResult } from "../pipeline/contracts.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import type { MachinePlan } from "./model.js";
import { deriveTasks } from "./derive.js";
import { resolveArtifact } from "./inputs.js";
import { requireBasis } from "./basis.js";
import { REFINEMENT_CONTRACT_VERSION } from "../graph/research-contracts.js";
import { taskContext, boundedContext, selectDetail, type DetailSelector, type EvidenceDetail } from "./context.js";
import { Owners, selectWriter } from "../ownership/owners.js";
import { readWriterIndex } from "../ownership/writer-index.js";
import { readFeasibility, type OmFeasibility } from "../om/feasibility.js";
import { historicalTrace } from "../om/input.js";
import { readinessObligations } from '../graph/obligation-readiness.js';
import { taskObligationHandoff, requireTaskObligations } from '../graph/task-obligations.js';
export type { MachinePlan } from "./model.js";

export class Compiler {
  constructor(private readonly store: Store, private readonly pipeline: Pipeline, private readonly refinement: Refinement,
    private readonly environments: Environments) {}
  compile(project: string, extraGuards: TransactionGuard[] = []): Revision<MachinePlan> {
    const stage = this.pipeline.inspect(project, "om-g2");
    requireCondition(stage.state === "accepted" && stage.artifact, "om_not_ready", "OM-G2 must be accepted and current");
    const feasibilityRef = (stage.artifact.value.content as unknown as { feasibility: Ref }).feasibility;
    const om = feasibilityRef.id.startsWith('om-feasibility:');
    const feasibility = this.store.get<Feasibility>(feasibilityRef.id, om ? feasibilityRef.revision : undefined)!;
    const checked = this.refinement.feasibilityGate(project, feasibilityRef);
    requireCondition(checked.findings.length === 0 && feasibility.value.repository, "feasibility_not_ready", "Current R3 proof is required");
    const record = this.store.get<Graph>(`graph:${project}`)!; const graph = requireGraph(record.value);
    const environment = this.environments.get(project);
    const owners = new Owners(this.store, project, feasibility.value.repository!);
    const handoff = om ? (feasibility.value as OmFeasibility).obligations.handoff
      : taskObligationHandoff(this.store, project, feasibility.value.inputs);
    const researchObligations = handoff ? requireTaskObligations(this.store, project, graph, handoff) : undefined;
    const derived = deriveTasks(project, record.hash, graph, (producer, artifact) =>
      resolveArtifact(this.store, project, graph, feasibility.value.repository!, producer, artifact), { version: 2, owner: path => owners.latest(path),
        ...(researchObligations ? { researchObligations } : {}) });
    const inputs = [...stage.guards, ...checked.guards, ...derived.guards];
    // M8's historical closure is proved by its reader, not pinned as a collection of current heads.
    const guards = om ? uniqueRefs([...inputs, reference(stage.artifact), feasibilityRef, reference(record), reference(environment)])
      : [...new Map(inputs.map(ref => [`${ref.id}:${ref.revision}`, ref])).values()];
    const body = { version: 2 as const, projectId: project, graph: reference(record), environment: reference(environment),
      stage: reference(stage.artifact), feasibility: feasibilityRef, base: feasibility.value.repository,
      guards, tasks: derived.tasks, graphSnapshot: graph };
    const value: MachinePlan = { ...body, hash: hashJson(body) }; const id = `plan:${project}:${value.hash}`;
    const admissionGuards = uniqueTransactionGuards([...guards, ...(stage.admissionGuards ?? []), ...(checked.admissionGuards ?? [])]);
    const existing = this.store.get<MachinePlan>(id);
    if (existing) {
      requireCondition(transactionGuardsCurrent(this.store, admissionGuards), "plan_stale", "Plan admission changed while compiling");
      return existing;
    }
    const pointer = this.store.get<Ref>(`current-plan:${project}`);
    return this.store.writeMany<MachinePlan>([
      { id, kind: "plan", expected: 0, value },
      { id: `current-plan:${project}`, kind: "current-plan", expected: pointer?.revision ?? 0,
        value: { id, revision: 1, hash: hashJson(value) } },
    ], uniqueTransactionGuards([...admissionGuards, ...extraGuards]))[0]!;
  }
  read(id: string): Revision<MachinePlan> {
    const plan = this.store.get<MachinePlan>(id);
    requireCondition(plan && plan.kind === "plan", "plan_missing", "Machine plan is missing");
    const om = requireBasis(this.store, plan.value);
    const { hash, ...body } = plan.value;
    requireCondition(hashJson(body) === hash, "plan_corrupt", "Machine plan checksum mismatch");
    const graph = this.store.get<Graph>(plan.value.graph.id, plan.value.graph.revision);
    requireCondition(graph?.kind === "graph" && graph.hash === plan.value.graph.hash
      && hashJson(graph.value) === hashJson(plan.value.graphSnapshot), "plan_foreign", "Plan must bind its exact graph version");
    const derived = (() => {
      if (om) {
        const deliveries = om.value.producer.deliveries, ownership = deliveries.ownership;
        requireCondition(ownership, 'plan_basis_incomplete', 'An M8 plan requires its exact ownership slice');
        const handoff = structuredClone(om.value.obligations.handoff) as OmFeasibility['obligations']['handoff'];
        const researchObligations = requireTaskObligations(this.store, plan.value.projectId, graph.value, handoff);
        const writers = new Map<string, ReturnType<typeof selectWriter>>();
        const owner = (path: string) => {
          if (writers.has(path)) return writers.get(path)!;
          const ref = ownership.indexes[path];
          requireCondition(ref, 'plan_basis_incomplete', 'Every write path needs its exact M8 writer index');
          const index = readWriterIndex(this.store, plan.value.projectId, path, ref, ownership.root);
          const writer = selectWriter(this.store, plan.value.projectId, plan.value.base, index.value.writers, path);
          writers.set(path, writer);
          return writer;
        };
        return deriveTasks(plan.value.projectId, graph.hash, requireGraph(graph.value), (producer, artifact) => {
          const matches = deliveries.resolved.filter(item => item.producer === producer && item.artifact === artifact);
          requireCondition(matches.length === 1, 'plan_input_invalid', 'Every input needs its exact M8 producer and artifact resolution');
          const input = matches[0]!;
          return resolveArtifact(this.store, plan.value.projectId, graph.value, plan.value.base, producer, artifact,
            [...(input.source ? [input.source] : []), ...(input.receipt ? [input.receipt] : [])]);
        }, { version: plan.value.version, owner, researchObligations });
      }
      const owners = plan.value.version === 2 ? new Owners(this.store, plan.value.projectId, plan.value.base) : null;
      const basis = this.store.get<Feasibility>(plan.value.feasibility.id, plan.value.feasibility.revision)!;
      const handoff = taskObligationHandoff(this.store, plan.value.projectId, basis.value.inputs);
      const researchObligations = handoff ? requireTaskObligations(this.store, plan.value.projectId, graph.value, handoff) : undefined;
      return deriveTasks(plan.value.projectId, graph.hash, requireGraph(graph.value), (producer, artifact) =>
        resolveArtifact(this.store, plan.value.projectId, graph.value, plan.value.base, producer, artifact, plan.value.guards),
      { version: plan.value.version, owner: path => owners?.latest(path) ?? null, ...(researchObligations ? { researchObligations } : {}) });
    })();
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
    if (plan.value.feasibility.id.startsWith('om-feasibility:')) {
      const current = this.refinement.feasibilityGate(project, plan.value.feasibility);
      result.findings.push(...current.findings);
      result.guards.push(...current.guards);
      result.admissionGuards = uniqueTransactionGuards([...current.guards, ...(current.admissionGuards ?? [])]);
    } else {
      const obligations = readinessObligations(this.store, project, basis.value.inputs, basis.value.obligations, 'consume', allowHistorical);
      result.findings.push(...obligations.findings);
      if (obligations.guards.length || obligations.admissionGuards.length)
        result.admissionGuards = uniqueTransactionGuards([...obligations.guards, ...obligations.admissionGuards]);
      if (basis.value.contractVersion !== REFINEMENT_CONTRACT_VERSION && !(allowHistorical && basis.value.contractVersion === undefined))
        result.findings.push({ code: "refinement_upgrade_required", target: plan.value.feasibility.id, message: "New plan admission requires the enriched refinement contract" });
    }
    for (const input of plan.value.guards) {
      const current = this.store.get(input.id);
      if (!current || current.revision !== input.revision || current.hash !== input.hash
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "plan_stale", target: input.id, message: "A source used to compile this plan changed" });
      else result.guards.push(reference(current));
    }
    if (!result.findings.length && result.admissionGuards?.length && !transactionGuardsCurrent(this.store, [...result.guards, ...result.admissionGuards]))
      result.findings.push({ code: "plan_stale", target: ref.id, message: "An admission dependency changed while this plan was checked" });
    return result;
  }
  publish(project: string, planRef: Ref, expected: number, extraGuards: TransactionGuard[] = []) {
    const checked = this.gate(project, planRef); requireCondition(checked.findings.length === 0, "plan_stale", "Plan inputs are not current");
    return this.pipeline.draft(project, "compilation", { plan: planRef } as unknown as Json, expected,
      uniqueTransactionGuards([...checked.guards, ...(checked.admissionGuards ?? []), ...extraGuards]));
  }
  #contextPlan(project: string, planRef: Ref, task: string) {
    const checked = this.gate(project, planRef);
    requireCondition(checked.findings.length === 0, "plan_stale", "Task context needs current exact plan inputs");
    const plan = this.store.get<MachinePlan>(planRef.id)!;
    requireCondition(plan.value.tasks.some(item => item.id === task), "task_foreign", "Task does not belong to this machine plan");
    return { plan, admissionGuards: uniqueTransactionGuards([...checked.guards, ...(checked.admissionGuards ?? [])]) };
  }
  context(project: string, planRef: Ref, task: string, maxChars: number) {
    const { plan, admissionGuards } = this.#contextPlan(project, planRef, task);
    const ref = plan.value.environment;
    const environment = this.store.get<Environment>(ref.id, ref.revision);
    requireCondition(environment?.kind === "environment" && environment.hash === ref.hash && environment.value.projectId === project,
      "context_environment_foreign", "Full-run criteria must come from the exact plan environment");
    const context = taskContext(plan, environment.value.fullCheck, task, maxChars);
    requireCondition(transactionGuardsCurrent(this.store, admissionGuards), "plan_stale", "Plan admission changed while preparing task context");
    return context;
  }
  detail(project: string, planRef: Ref, task: string, kind: "graph" | "evidence" | "evidence-index", selector: DetailSelector, maxChars: number) {
    const { plan, admissionGuards } = this.#contextPlan(project, planRef, task);
    const om = plan.value.feasibility.id.startsWith('om-feasibility:');
    let inputs = plan.value.guards;
    if (om) {
      const history: Ref[] = [];
      const checked = readFeasibility(historicalTrace(this.store, ref => { history.push(ref); }, 'distinct'),
        { project, record: plan.value.feasibility });
      if (!checked.ok) throw new EngineError(checked.refusal.code, checked.refusal.message, checked.refusal.at);
      inputs = uniqueRefs([...inputs, ...checked.value.value.inputs, ...history]);
    }
    const evidence = inputs.flatMap(ref => {
      const record = this.store.get(ref.id, ref.revision);
      return record && record.hash === ref.hash && (record.value as { projectId?: string }).projectId === project
        && ["source", "stage", "discovery-draft", "research-assessment", "task-run"].includes(record.kind)
        ? [{ ref, kind: record.kind } satisfies EvidenceDetail] : [];
    });
    let value: unknown; let source = plan.value.graph;
    if (kind === "evidence-index") { value = evidence; source = reference(plan); }
    else if (kind === "evidence") {
      if (om) requireCondition(evidence.filter(item => item.ref.id === selector.id).length <= 1,
        "context_evidence_ambiguous", "This evidence ID has several exact revisions; an unqualified ID cannot select one");
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
    const detail = boundedContext({ binding: { plan: reference(plan), task, source }, kind, selector, value: selectDetail(value, selector) }, maxChars);
    requireCondition(transactionGuardsCurrent(this.store, admissionGuards), "plan_stale", "Plan admission changed while preparing task detail");
    return detail;
  }
}

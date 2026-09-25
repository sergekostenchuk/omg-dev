import { canonical, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { reference } from '../pipeline/contracts.js';
import type { Store, TransactionGuard } from '../storage/store.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { checkedPlanDerivation, type CompiledTask, type MachinePlan } from '../compiler/model.js';
import type { Feasibility } from '../graph/refinement.js';
import type { Graph } from '../graph/model.js';
import type { TaskRun } from './model.js';
import { taskObligationHandoff, requireTaskObligations } from '../graph/task-obligations.js';
import { findObligationConfirmation, frozenObligationConfirmation, type ObligationConfirmation } from '../graph/obligation-readiness.js';
import type { OmFeasibility } from '../om/feasibility.js';
import { requireBasis } from '../compiler/basis.js';

export interface TaskRuntimeProof { binding: string; subject: string; kind: 'runtime'; confirmation: ObligationConfirmation }
export interface TaskImplementationProof { binding: string; subject: string; kind: 'implementation';
  tests: { id: string; definition: string; checks: { command: string; result: string }[] }[] }
export type TaskObligationProof = TaskRuntimeProof | TaskImplementationProof;
export const taskStartSubject = (run: TaskRun) => hashJson({ plan: run.plan, task: run.taskId, parent: run.parent, attempt: run.attempt });
const resultSubject = (run: TaskRun) => hashJson({ plan: run.plan, task: run.taskId, parent: run.parent, tree: run.tree });

export function requirePlanTaskObligations(store: Store, plan: MachinePlan, task?: CompiledTask): void {
  const basis = store.get<Feasibility>(plan.feasibility.id, plan.feasibility.revision);
  requireCondition(basis?.kind === 'feasibility' && basis.hash === plan.feasibility.hash && basis.value.projectId === plan.projectId,
    'task_obligation_plan_foreign', 'Task obligations need the exact feasibility basis');
  let handoff: ReturnType<typeof taskObligationHandoff>;
  if (plan.feasibility.id.startsWith('om-feasibility:')) {
    const checked = requireBasis(store, plan);
    requireCondition(checked, 'task_obligation_plan_foreign', 'An M8 plan needs its proved compilation basis');
    handoff = structuredClone(checked.value.obligations.handoff) as OmFeasibility['obligations']['handoff'];
  } else handoff = taskObligationHandoff(store, plan.projectId, basis.value.inputs);
  if (!handoff) return;
  const graph = store.get<Graph>(plan.graph.id, plan.graph.revision);
  requireCondition(graph?.kind === 'graph' && graph.hash === plan.graph.hash && canonical(graph.value) === canonical(plan.graphSnapshot),
    'task_obligation_plan_foreign', 'The task obligation graph must be the actual sealed graph');
  const byNode = requireTaskObligations(store, plan.projectId, graph.value, handoff);
  for (const item of task ? [task] : plan.tasks) {
    requireCondition(plan.tasks.some(saved => canonical(saved) === canonical(item))
      && canonical(item.researchObligations ?? null) === canonical(byNode.get(item.node) ?? []),
    'task_obligation_plan_foreign', 'A task cannot omit or replace the exact obligations derived from its bound L3');
  }
}

export function taskStartProofs(store: Store, run: TaskRun, task: CompiledTask) {
  const proofs: TaskRuntimeProof[] = [], guards: TransactionGuard[] = [];
  for (const bound of task.researchObligations ?? []) if (bound.requirement.moment === 'task-start') {
    const found = findObligationConfirmation(store, run.projectId, bound.requirement);
    requireCondition(found, 'task_obligation_start_required', `[${bound.requirement.obligation}] Actual confirmation is required before this task starts`);
    proofs.push({ binding: bound.binding, subject: taskStartSubject(run), kind: 'runtime', confirmation: found.proof });
    guards.push(...found.guards, ...found.admissionGuards);
  }
  return { proofs, guards: uniqueTransactionGuards(guards) };
}

export function requireCurrentTaskStart(store: Store, run: TaskRun, task: CompiledTask): void {
  for (const bound of task.researchObligations ?? []) if (bound.requirement.moment === 'task-start') {
    const saved = run.obligationStartProofs?.find(proof => proof.binding === bound.binding);
    requireCondition(saved?.kind === 'runtime' && saved.subject === taskStartSubject(run)
      && findObligationConfirmation(store, run.projectId, bound.requirement, saved.confirmation),
    'task_obligation_start_stale', `[${bound.requirement.obligation}] Start confirmation changed before dispatch; preserve a technical pause`);
  }
}

function implementationProof(run: TaskRun, task: CompiledTask, binding: string, tests: string[]): TaskImplementationProof {
  requireCondition(run.tree && tests.length, 'task_obligation_result_required', 'Implementation proof needs the candidate and concrete tests');
  return { binding, subject: resultSubject(run), kind: 'implementation', tests: tests.map(id => {
    const test = task.tests.find(test => test.id === id);
    requireCondition(test?.contract, 'task_obligation_result_required', 'The selected proof test is absent from this task');
    return { id, definition: hashJson(test), checks: [test.command, ...test.contract.counterfactuals.map(item => item.command)].map(command => {
      const check = run.checks.find(check => hashJson(check.command) === hashJson(command));
      requireCondition(check?.result.exitCode === 0 && check.result.signal === null,
        'task_obligation_result_required', 'Every selected proof command must have actually passed on this candidate');
      return { command: hashJson(command), result: hashJson(check.result) };
    }) };
  }) };
}

export function taskResultProofs(store: Store, run: TaskRun, task: CompiledTask) {
  const proofs: TaskObligationProof[] = [], guards: TransactionGuard[] = [];
  for (const bound of task.researchObligations ?? []) if (bound.requirement.moment === 'task-result') {
    if (bound.requirement.kind === 'post-implementation-proof') proofs.push(implementationProof(run, task, bound.binding, bound.tests));
    else {
      const found = findObligationConfirmation(store, run.projectId, bound.requirement);
      requireCondition(found, 'task_obligation_result_required', `[${bound.requirement.obligation}] Actual confirmation is required before accepting this result`);
      proofs.push({ binding: bound.binding, subject: resultSubject(run), kind: 'runtime', confirmation: found.proof });
      guards.push(...found.guards, ...found.admissionGuards);
    }
  }
  return { proofs, guards: uniqueTransactionGuards(guards) };
}

/** Before an unpublished intent moves Git, its late runtime evidence must
 * still be current. Once published, recovery preserves that historical fact. */
export function requireCurrentTaskResult(store: Store, run: TaskRun, task: CompiledTask): void {
  for (const bound of task.researchObligations ?? []) if (bound.requirement.moment === 'task-result' && bound.requirement.kind === 'environment-confirmation') {
    const saved = run.obligationResultProofs?.find(proof => proof.binding === bound.binding);
    requireCondition(saved?.kind === 'runtime' && saved.subject === resultSubject(run)
      && findObligationConfirmation(store, run.projectId, bound.requirement, saved.confirmation),
    'task_obligation_result_required', `[${bound.requirement.obligation}] Result confirmation changed before publication; preserve the candidate and its checks`);
  }
}

export function requireTaskObligationProofs(store: Store, run: TaskRun, task: CompiledTask): void {
  const plan = store.get<MachinePlan>(run.plan.id, run.plan.revision);
  requireCondition(plan?.kind === 'plan' && canonical(reference(plan)) === canonical(run.plan) && plan.value.projectId === run.projectId
    && run.taskId === task.id, 'task_obligation_plan_foreign', 'Proofs must belong to the exact project, plan and named task');
  checkedPlanDerivation(plan, run.projectId);
  requirePlanTaskObligations(store, plan.value, task);
  if (task.researchObligations === undefined) return;
  for (const [moment, saved] of [['task-start', run.obligationStartProofs], ['task-result', run.obligationResultProofs]] as const) {
    const required = task.researchObligations.filter(item => item.requirement.moment === moment);
    requireCondition(Array.isArray(saved) && saved.every(item => item && typeof item.binding === 'string')
      && saved.length === required.length && new Set(saved.map(item => item.binding)).size === saved.length,
      'task_obligation_proof_missing', `The exact ${moment} proof set is missing, duplicated or contains extras`);
    for (const bound of required) {
      const proof = saved.find(proof => proof.binding === bound.binding);
      requireCondition(proof, 'task_obligation_proof_missing', 'A named obligation proof was lost');
      if (bound.requirement.kind === 'post-implementation-proof') requireCondition(moment === 'task-result'
        && canonical(proof) === canonical(implementationProof(run, task, bound.binding, bound.tests)),
      'task_obligation_proof_foreign', 'Implementation evidence must bind the exact tests, candidate and consumer');
      else requireCondition(proof.kind === 'runtime' && proof.subject === (moment === 'task-start' ? taskStartSubject(run) : resultSubject(run))
        && frozenObligationConfirmation(store, run.projectId, bound.requirement, proof.confirmation),
      'task_obligation_proof_foreign', 'Runtime evidence must be the genuine confirmation admitted for this exact task moment');
    }
  }
}

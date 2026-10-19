import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { STAGE_CLOSURE_CONTRACT, isRef, reference, uniqueRefs, stageId, type Ref, type GateResult, type ExternalCheckHandlers, type StageArtifact } from "../pipeline/contracts.js";
import { hashJson } from "../canonical.js";
import type { ExecutionResult, TaskRun } from "./model.js";
import type { ArtifactReceipt, MachinePlan } from "../compiler/model.js";
import { git, type Environment } from "../runtime/environment.js";
import { requireGates } from "./commit.js";
import { EngineError, requireCondition } from '../errors.js';

/** A closed result has already proved its checks and review. Only its git facts are external. */
export const EXECUTION_EXTERNAL_CHECKS: ExternalCheckHandlers = {
  'git-ancestry'(check, { store, projectId }) {
    const refused = (code: string, message: string) => ({ code, target: check.basis.id, message });
    let committedResult = false;
    try {
      requireCondition(isRef(check.basis), 'execution_result_foreign', 'An exact git comparison basis is required');
      const basis = store.get<ExecutionResult | MachinePlan>(check.basis.id, check.basis.revision);
      requireCondition(basis && basis.hash === check.basis.hash && basis.value.projectId === projectId,
        'execution_result_foreign', 'The saved git comparison basis is missing or foreign');
      if (basis.kind === 'plan') {
        const plan = basis.value as MachinePlan;
        const receipts = uniqueRefs(plan.tasks.flatMap(task => [...task.inputs, ...(task.ownership ?? [])]
          .flatMap(input => input.receipt ? [input.receipt] : [])));
        for (const ref of receipts) {
          const record = store.get<ArtifactReceipt | TaskRun>(ref.id, ref.revision);
          requireCondition(record && record.hash === ref.hash && record.value.projectId === projectId
            && ['artifact', 'task-run'].includes(record.kind), 'plan_input_invalid', 'The exact committed input is unavailable');
          const { commit, tree } = record.value;
          requireCondition(commit && tree, 'plan_input_invalid', 'An accepted input must name its commit and tree');
          git(plan.base.root, ['merge-base', '--is-ancestor', commit, plan.base.head]);
          requireCondition(git(plan.base.root, ['rev-parse', `${commit}^{tree}`]) === tree,
            record.kind === 'task-run' ? 'ownership_commit_foreign' : 'artifact_foreign', 'The committed input tree changed');
        }
        return null;
      }
      requireCondition(basis.kind === 'execution-result', 'execution_result_foreign', 'The git basis must be a plan or execution result');
      committedResult = true;
      const result = basis.value as ExecutionResult;
      const plan = store.get<MachinePlan>(result.plan.id, result.plan.revision);
      requireCondition(plan?.kind === 'plan' && plan.hash === result.plan.hash && plan.value.projectId === projectId,
        'execution_plan_foreign', 'The exact result plan is unavailable');
      let parent = plan.value.base.head;
      for (const ref of result.runs) {
        const run = store.get<TaskRun>(ref.id, ref.revision);
        requireCondition(run?.kind === 'task-run' && run.hash === ref.hash && run.value.commit,
          'execution_incomplete', 'The exact committed run is unavailable');
        if (git(plan.value.base.root, ['rev-list', '--parents', '-n', '1', run.value.commit]) !== `${run.value.commit} ${parent}`
          || git(plan.value.base.root, ['rev-parse', `${run.value.commit}^{tree}`]) !== run.value.tree)
          return refused('execution_commit_foreign', 'The committed result no longer has its saved parent and tree');
        parent = run.value.commit;
      }
      return parent === result.head ? null : refused('execution_head_foreign', 'The result head differs from its exact run chain');
    } catch (error) {
      return refused(error instanceof EngineError && !(committedResult && error.code === 'git_failed') ? error.code : 'execution_proof_invalid',
        error instanceof Error ? error.message : 'The git evidence is unavailable');
    }
  },
};

export function resultGate(store: Store, project: string, ref: Ref, declareClosure = false): GateResult {
  const result = store.get<ExecutionResult>(ref.id, ref.revision);
  const rejected = (code: string): GateResult => ({ findings: [{ code, target: ref.id, message: "Execution result is missing or does not bind the complete committed plan" }], guards: [] });
  if (result?.kind !== "execution-result" || result.hash !== ref.hash || result.value.projectId !== project) return rejected("execution_result_foreign");
  const plan = store.get<MachinePlan>(result.value.plan.id, result.value.plan.revision);
  if (plan?.kind !== "plan" || plan.hash !== result.value.plan.hash || plan.value.projectId !== project
    || result.value.runs.length !== plan.value.tasks.length) return rejected("execution_plan_foreign");
  const environment = store.get<Environment>(plan.value.environment.id, plan.value.environment.revision);
  if (environment?.kind !== "environment" || environment.hash !== plan.value.environment.hash) return rejected("execution_environment_foreign");
  let parent = plan.value.base.head;
  for (const [index, item] of result.value.runs.entries()) {
    const run = store.get<TaskRun>(item.id, item.revision);
    if (run?.kind !== "task-run" || run.hash !== item.hash || run.value.state !== "committed"
      || hashJson(run.value.plan) !== hashJson(result.value.plan) || run.value.taskId !== plan.value.tasks[index]?.id
      || run.value.parent !== parent || !run.value.commit) return rejected("execution_incomplete");
    try {
      requireGates(run.value, plan.value.tasks[index]!, environment.value, store);
      if (git(plan.value.base.root, ["rev-list", "--parents", "-n", "1", run.value.commit]) !== `${run.value.commit} ${parent}`
        || git(plan.value.base.root, ["rev-parse", `${run.value.commit}^{tree}`]) !== run.value.tree) return rejected("execution_commit_foreign");
    } catch { return rejected("execution_proof_invalid"); }
    parent = run.value.commit;
  }
  return parent === result.value.head ? { findings: [], guards: [reference(result)],
    ...(declareClosure ? { closure: { contract: STAGE_CLOSURE_CONTRACT, external: [{ kind: 'git-ancestry' as const, basis: reference(result) }] } } : {}),
  } : rejected("execution_head_foreign");
}

/** The executor's direct producer commits its own completed proof once. Compilation is
 * an exact predecessor, not a request to repeat its pre-execution repository inspection. */
export function writeSealedExecutionStage(store: Store, project: string, compilation: Ref, resultRef: Ref,
  expected: number): Revision<StageArtifact> {
  requireCondition(isRef(compilation) && isRef(resultRef), 'execution_result_foreign', 'Sealing needs exact compilation and result references');
  const result = store.get<ExecutionResult>(resultRef.id, resultRef.revision);
  const stage = store.get<StageArtifact>(compilation.id, compilation.revision);
  requireCondition(result?.kind === 'execution-result' && result.hash === resultRef.hash && result.value.projectId === project
    && isRef(result.value.plan),
    'execution_result_foreign', 'The exact completed execution result is unavailable');
  const content = stage?.value.content;
  const plan = content && typeof content === 'object' && !Array.isArray(content) ? content['plan'] : null;
  requireCondition(stage?.kind === 'stage' && stage.id === stageId(project, 'compilation') && stage.hash === compilation.hash
    && stage.value.projectId === project && stage.value.stage === 'compilation' && stage.value.status === 'accepted'
    && isRef(plan) && plan.id === result.value.plan.id && plan.revision === result.value.plan.revision && plan.hash === result.value.plan.hash,
  'execution_plan_foreign', 'The result must consume this exact accepted compilation');
  const checked = resultGate(store, project, resultRef, true);
  if (checked.findings.length) throw new EngineError('gate_rejected', 'The completed execution proof was refused', checked.findings);
  requireCondition(checked.closure, 'stage_closure_invalid', 'The result producer must declare its complete external checks');
  // Keep every original result/run proof and the predecessor dependency checked by the old reader.
  const proofs = uniqueRefs([resultRef, ...result.value.runs, compilation]);
  const id = stageId(project, 'execution'), previous = expected > 0 ? store.get(id, expected) : null;
  requireCondition(expected === 0 || previous, 'revision_conflict', 'The expected execution stage is unavailable');
  const admission = checked.admissionGuards ?? [];
  const writeGuards: TransactionGuard[] = [...proofs, ...admission, previous ? reference(previous) : { id, absent: true }];
  const value: StageArtifact = { projectId: project, stage: 'execution', status: 'accepted', content: { result: { ...resultRef } },
    inputs: [compilation], proofs, closure: { contract: STAGE_CLOSURE_CONTRACT, proofs, admission,
      inherited: [], external: checked.closure.external, writeGuards } };
  // The write's expected revision remains the own-stage CAS (and its revision_conflict code).
  return store.writeMany<StageArtifact>([{ id, kind: 'stage', expected, value }], [...proofs, ...admission])[0]!;
}

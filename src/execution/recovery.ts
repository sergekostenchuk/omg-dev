import type { Store, Revision } from "../storage/store.js";
import type { Compiler } from "../compiler/compiler.js";
import { git, type Environment, type ExecutionRoot } from "../runtime/environment.js";
import { requireCondition } from "../errors.js";
import type { TaskRun } from "./model.js";
import { publishCommit, finishCommit, requireGates } from "./commit.js";
import { stopOrphan } from "./process.js";
import { taskResultProofs } from './task-obligations.js';
import { reference } from '../pipeline/contracts.js';

/** A durable acceptance intent predates later edits to product research. */
export async function recoverCommits(store: Store, compiler: Compiler, project: string): Promise<Revision<TaskRun>[]> {
  const recovered: Revision<TaskRun>[] = [];
  for (let run of store.list<TaskRun>("task-run").filter(run => run.value.projectId === project && run.value.state === "commit_pending")) {
    const root = store.get<ExecutionRoot>(`execution-root:${project}`);
    const plan = compiler.read(run.value.plan.id);
    requireCondition(root?.kind === "execution-root" && plan.value.projectId === project
      && plan.hash === run.value.plan.hash && plan.revision === run.value.plan.revision,
    "recovery_basis_foreign", "Recovery must use the accepted intent's exact root and plan");
    const task = plan.value.tasks.find(task => task.id === run.value.taskId);
    const ref = plan.value.environment;
    const environment = store.get<Environment>(ref.id, ref.revision);
    requireCondition(task && environment?.kind === "environment" && environment.hash === ref.hash && environment.value.projectId === project,
      "recovery_basis_foreign", "Recovery must use the task and environment accepted by this intent");
    await stopOrphan(run.value.child);
    // The original gates and exact parent/tree are re-bound; agents and checks do not rerun.
    requireGates(run.value, task, environment.value, store);
    if (task.researchObligations?.some(item => item.requirement.moment === 'task-result' && item.requirement.kind === 'environment-confirmation')
      && git(root.value.path, ['rev-parse', 'HEAD']) === run.value.parent) {
      const proof = taskResultProofs(store, run.value, task);
      run = store.writeMany<TaskRun>([{ id: run.id, kind: run.kind, expected: run.revision,
        value: { ...run.value, obligationResultProofs: proof.proofs, updatedAt: Date.now() } }], [reference(run), reference(root), ...proof.guards])[0]!;
    }
    publishCommit(root.value, run.value, store, task);
    recovered.push(finishCommit(store, root, run, plan.value, task, environment.value));
  }
  return recovered;
}

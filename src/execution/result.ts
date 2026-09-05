import { Store } from "../storage/store.js";
import { reference, type Ref, type GateResult } from "../pipeline/contracts.js";
import { hashJson } from "../canonical.js";
import type { ExecutionResult, TaskRun } from "./model.js";
import type { MachinePlan } from "../compiler/model.js";
import { git, type Environment } from "../runtime/environment.js";
import { requireGates } from "./commit.js";

export function resultGate(store: Store, project: string, ref: Ref): GateResult {
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
      requireGates(run.value, plan.value.tasks[index]!, environment.value);
      if (git(plan.value.base.root, ["rev-list", "--parents", "-n", "1", run.value.commit]) !== `${run.value.commit} ${parent}`
        || git(plan.value.base.root, ["rev-parse", `${run.value.commit}^{tree}`]) !== run.value.tree) return rejected("execution_commit_foreign");
    } catch { return rejected("execution_proof_invalid"); }
    parent = run.value.commit;
  }
  return parent === result.value.head ? { findings: [], guards: [reference(result)] } : rejected("execution_head_foreign");
}

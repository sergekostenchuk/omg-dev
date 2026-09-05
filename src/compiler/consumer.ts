import type { MachinePlan, CompiledTask } from "./model.js";
import { canonical, digest } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";

export async function consumePlan(plan: MachinePlan, consumer: { execute(task: CompiledTask): Promise<{ taskId: string; outcome: string }> }) {
  const completed = new Set<string>(); const results: { taskId: string; outcome: string }[] = [];
  for (const task of plan.tasks) {
    requireCondition(task.dependencies.every(id => completed.has(id)), "dependency_not_ready", "Plan order does not satisfy dependencies");
    const result = await consumer.execute(task);
    if (result.taskId !== task.id || result.outcome !== task.outcome) throw new EngineError("outcome_foreign", "Consumer returned a result for a different task");
    completed.add(task.id); results.push(result);
  }
  return { mode: "preview" as const, hash: digest(canonical(results)), results };
}

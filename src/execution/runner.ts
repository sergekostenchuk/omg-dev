import { Store, type Revision } from "../storage/store.js";
import type { Compiler } from "../compiler/compiler.js";
import { Environments, git, type Environment, type ExecutionRoot } from "../runtime/environment.js";
import { requireCondition, EngineError } from "../errors.js";
import { reference, stageId, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { acquire, release } from "./lock.js";
import { ensureWorktree, requireWorktree } from "./worktree.js";
import { capture, requireWritePaths } from "./candidate.js";
import { currentBasis } from "./basis.js";
import { callAgent, implementation, review } from "./protocol.js";
import { executeProcess, stopOrphan, type ProcessObserver } from "./process.js";
import { checkCommands, commitIntent, publishCommit, finishCommit, subjectHash } from "./commit.js";
import { runId, type TaskRun, type ExecutionResult, type ExecutionOptions, type AgentUsage } from "./model.js";
import { executionInputs } from "./inputs.js";
import { taskContext } from "../compiler/context.js";
import { canonical } from "../canonical.js";
import { recoverCommits } from "./recovery.js";

export class Executor {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly store: Store, private readonly compiler: Compiler, private readonly environments: Environments,
    private readonly afterGitPublish?: (run: TaskRun) => void) {}

  async run(project: string, planRef: Ref, options: ExecutionOptions, signal?: AbortSignal): Promise<Revision<TaskRun>[]> {
    requireCondition(options && typeof options.retry === "boolean" && Number.isSafeInteger(options.maxContextChars) && options.maxContextChars > 0
      && Number.isSafeInteger(options.maxCorrections) && options.maxCorrections >= 0, "execution_options_invalid", "Execution needs explicit context and correction allowances");
    const lock = acquire(this.store, project);
    const control = new AbortController(); this.active.set(project, control);
    signal = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
    try {
      await recoverCommits(this.store, this.compiler, project);
      const plan = this.compiler.read(planRef.id);
      requireCondition(plan.value.projectId === project && plan.hash === planRef.hash && plan.revision === planRef.revision,
        "plan_foreign", "Execution must use the exact generated plan");
      const stage = this.store.get<StageArtifact>(stageId(project, "compilation"));
      requireCondition(stage?.kind === "stage" && stage.value.projectId === project && stage.value.stage === "compilation"
        && stage.value.status === "accepted" && canonical((stage.value.content as unknown as { plan: Ref }).plan) === canonical(reference(plan)),
        "plan_not_accepted", "Execution requires the accepted compilation result");
      const existingRoot = this.store.get<ExecutionRoot>(`execution-root:${project}`);
      if (existingRoot?.value.state === "ready") currentBasis(this.store, plan.value, existingRoot.value);
      else requireCondition(this.compiler.gate(project, planRef).findings.length === 0, "plan_stale", "Refresh changed plan inputs before creating its worktree");
      let root = ensureWorktree(this.store, this.environments, plan.value);
      const environment = this.store.get<Environment>(plan.value.environment.id, plan.value.environment.revision)!;
      const results: Revision<TaskRun>[] = []; let parent = plan.value.base.head;
      const corrections = new Map<string, number>();
      for (let taskIndex = 0; taskIndex < plan.value.tasks.length; taskIndex++) {
        const task = plan.value.tasks[taskIndex]!;
        let run = this.store.get<TaskRun>(runId(plan.value.hash, task.id));
        if (run?.value.state === "committed") {
          requireCondition(run.value.parent === parent && run.value.commit && run.value.tree
            && git(root.value.path, ["rev-list", "--parents", "-n", "1", run.value.commit]) === `${run.value.commit} ${parent}`,
          "execution_chain_foreign", "Committed tasks must form the exact plan's parent chain");
          parent = run.value.commit; results.push(run); continue;
        }
        requireCondition(parent === root.value.head, "execution_parent_changed", "The next task must extend the last accepted result");
        requireWorktree(root.value, parent);
        if (run && ["implementing", "checking", "reviewing"].includes(run.value.state)) {
          await stopOrphan(run.value.child);
          run = this.save(run, { state: "interrupted", child: null, error: "Previous process stopped before acceptance. Candidate files are preserved; retry explicitly." });
        }
        if (run && (run.value.state === "needs_plan" || !options.retry && !corrections.has(task.id))) { results.push(run); return results; }
        const guards = currentBasis(this.store, plan.value, root.value);
        if (!run) requireCondition(!git(root.value.path, ["status", "--porcelain", "--untracked-files=all"]),
          "worktree_dirty", "The managed worktree contains an unfinished change; recover that attempt first");
        const previous = run?.value;
        run = this.store.writeMany<TaskRun>([{ id: runId(plan.value.hash, task.id), kind: "task-run", expected: run?.revision ?? 0,
          value: { projectId: project, plan: reference(plan), taskId: task.id, attempt: (previous?.attempt ?? 0) + 1,
            state: "implementing", parent, tree: null, commit: null, implementation: null, artifacts: [], checks: [], review: null,
            reviewSubject: null, child: null, error: null, inputs: [], usage: previous?.usage ?? [], createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() } }],
        [reference(lock), reference(root), ...guards])[0]!;
        const observe: ProcessObserver = child => { run = this.save(run!, { child }); };
        const measure = (value: AgentUsage) => {
          const usage = [...run!.value.usage]; const index = usage.findIndex(item => item.requestHash === value.requestHash);
          if (index < 0) usage.push(value); else usage[index] = value;
          run = this.save(run!, { usage });
        };
        const actual = { ...environment.value, workspace: root.value.path };
        try {
          requireWritePaths(root.value.path, task.writePaths);
          const inputs = executionInputs(this.store, plan, task, root.value);
          run = this.save(run, { inputs: inputs.guards });
          const context = JSON.parse(taskContext(plan, actual.fullCheck, task.id, options.maxContextChars).text);
          const response = await callAgent(actual.implementer, actual, "implement", "Implement the supplied atomic result. Preserve unrelated files. Return text and artifacts as an array of {id} naming all implemented output contracts. The engine records code evidence; do not fabricate business artifact values. Do not commit.",
            { context, parent, inputs: inputs.inputs, correction: previous ? { error: previous.error, review: previous.review } : null },
            options.maxContextChars, measure, observe, signal);
          const output = implementation(response, task);
          const tree = capture(root.value, parent, task);
          run = this.save(run, { state: "checking", implementation: output.text, artifacts: output.artifacts, tree });
          for (const command of checkCommands(task, actual)) {
            const result = await executeProcess(command, actual.workspace, "", actual.timeoutMs, observe, signal);
            run = this.save(run, { checks: [...run.value.checks, { command, result }] });
            requireCondition(result.exitCode === 0 && result.signal === null, "full_check_failed", result.stderr.slice(-2000) || "A required check failed");
            requireCondition(capture(root.value, parent, task) === tree, "candidate_changed", "A check changed the candidate bytes");
          }
          const subject = subjectHash(reference(plan), task.id, parent, tree);
          run = this.save(run, { state: "reviewing", reviewSubject: subject });
          const verdict = review(await callAgent(actual.reviewer, actual, "review", "Independently review the exact supplied task and candidate tree. Read the actual diff and tests. Return a structured pass or request_changes verdict; use kind=plan only when the plan needs correction, kind=code for implementation defects.",
            { binding: subject, context, parent, tree, artifacts: run.value.artifacts, checks: run.value.checks },
            options.maxContextChars, measure, observe, signal));
          requireCondition(capture(root.value, parent, task) === tree, "candidate_changed", "The candidate changed during independent review");
          run = this.save(run, { review: verdict });
          if (verdict.verdict === "request_changes") {
            throw new EngineError(verdict.kind === "plan" ? "plan_review_failed" : "code_review_failed", verdict.findings.join("\n"));
          }
          run = commitIntent(this.store, root, run, plan.value, task, actual, [reference(lock), ...currentBasis(this.store, plan.value, root.value)]);
          publishCommit(root.value, run.value);
          this.afterGitPublish?.(run.value);
          run = finishCommit(this.store, root, run, plan.value, task, actual);
          root = this.store.get<ExecutionRoot>(root.id)!;
          parent = run.value.commit!; results.push(run);
        } catch (error) {
          // A pending Git intent is durable. It must be recovered, never retried as implementation.
          if (run.value.state === "commit_pending") throw error;
          const code = error instanceof EngineError ? error.code : "implementation_failed";
          const interrupted = ["process_cancelled", "process_timeout", "process_failed", "executor_failed", "executor_protocol_invalid", "executor_response_foreign", "process_output_limit",
            "context_budget_exceeded", "write_scope_exceeded", "worktree_changed", "candidate_bytes_mismatch", "candidate_bytes_changed", "candidate_entry_unsupported"].includes(code);
          const planDefect = ["plan_review_failed", "plan_stale", "execution_input_missing", "execution_input_foreign", "producer_not_ready", "implementation_proof_foreign", "artifact_stale"].includes(code);
          run = this.save(run, { state: interrupted ? "interrupted" : planDefect ? "needs_plan" : "needs_code",
            child: null, error: error instanceof Error ? error.message : "Execution failed" });
          if (run.value.state === "needs_code" && (corrections.get(task.id) ?? 0) < options.maxCorrections) {
            corrections.set(task.id, (corrections.get(task.id) ?? 0) + 1); taskIndex--; continue;
          }
          results.push(run); return results;
        }
      }
      const value: ExecutionResult = { projectId: project, plan: reference(plan), runs: results.map(reference), head: parent };
      const id = `execution-result:${project}:${plan.value.hash}`;
      const result = this.store.get<ExecutionResult>(id) ?? this.store.write<ExecutionResult>({ id, kind: "execution-result", expected: 0, value });
      const previousStage = this.store.get<StageArtifact>(stageId(project, "execution"));
      if ((previousStage?.value.content as unknown as { result?: Ref } | undefined)?.result?.hash !== result.hash)
        this.store.write<StageArtifact>({ id: stageId(project, "execution"), kind: "stage", expected: previousStage?.revision ?? 0,
          value: { projectId: project, stage: "execution", status: "accepted", content: { result: reference(result) },
            inputs: [reference(stage)], proofs: [reference(result), ...results.map(reference)] } });
      return results;
    } finally { this.active.delete(project); release(this.store, lock); }
  }
  isRunning(project: string): boolean { return this.active.has(project); }
  async recover(project: string): Promise<Revision<TaskRun>[]> {
    const lock = acquire(this.store, project);
    try { return await recoverCommits(this.store, this.compiler, project); }
    finally { release(this.store, lock); }
  }
  stop(project: string): boolean { const control = this.active.get(project); control?.abort(); return Boolean(control); }
  private save(run: Revision<TaskRun>, patch: Partial<TaskRun>): Revision<TaskRun> {
    return this.store.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, ...patch, updatedAt: Date.now() } });
  }
}

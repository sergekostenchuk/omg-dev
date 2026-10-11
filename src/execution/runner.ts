import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import type { Compiler } from "../compiler/compiler.js";
import type { MachinePlan, CompiledTask } from "../compiler/model.js";
import { Environments, git, type Environment, type ExecutionRoot } from "../runtime/environment.js";
import { requireCondition, EngineError } from "../errors.js";
import { reference, stageId, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { acquire, release } from "./lock.js";
import { ensureWorktree, requireWorktree } from "./worktree.js";
import { capture, requireWritePaths } from "./candidate.js";
import { currentBasis } from "./basis.js";
import { callAgent, implementation, review, ExecutionSendHandle, EXECUTION_SEND_KIND, UNSENT, executionSendPrefix, lostSendClosure,
  type ExecutionSend } from "./protocol.js";
import { executeProcess, stopOrphan, type ProcessObserver } from "./process.js";
import { isProcessStopRefusal, writeProcessStopWitness, evaluateProcessStopWitnesses } from "../runtime/process-identity.js";
import { checkCommands, commitIntent, publishCommit, finishCommit, subjectHash } from "./commit.js";
import { runId, type TaskRun, type ExecutionResult, type ExecutionOptions, type AgentUsage, type CheckResult, type ReviewResult } from "./model.js";
import { executionInputs } from "./inputs.js";
import { loadTaskContextSources, taskContext } from "../compiler/context.js";
import { readCapacity } from "../om/capacity.js";
import { canonical, hashJson } from "../canonical.js";
import { recoverCommits } from "./recovery.js";
import { executionOwnership } from "./ownership.js";
import { taskStartProofs, requireCurrentTaskStart, requirePlanTaskObligations } from './task-obligations.js';
import { assertPilotBoundary, type ExecutionAdmission } from "../discovery/reader-pilot.js";
import { acquireRunExecution, releaseRunExecution, runOwnerState, RunControlGate, type RunExecution } from "../om/run-control.js";

/**
 * The currency of an exact plan, read the same way by the admission's writer and by execution (№3953-1): the compiler gate
 * before an execution root exists; the execution's own progress after it, so its own commits never make it stale.
 */
export function planCurrentGuards(store: Store, compiler: Compiler, planRef: Ref): TransactionGuard[] {
  const plan = compiler.read(planRef.id);
  requireCondition(plan.revision === planRef.revision && plan.hash === planRef.hash, "plan_foreign", "Execution must use the exact generated plan");
  const root = store.get<ExecutionRoot>(`execution-root:${plan.value.projectId}`);
  if (root?.value.state === "ready") return currentBasis(store, plan, root.value);
  const gate = compiler.gate(plan.value.projectId, planRef, true);
  requireCondition(gate.findings.length === 0, "plan_stale", "Refresh changed plan inputs before creating its worktree");
  return [...gate.guards, ...(gate.admissionGuards ?? [])];
}

/** The launches of exactly this plan (and task, attempt, role): read by their own id range, so the cost of a decision never
 * grows with the launches of other plans or tasks (№3606, №3961-3). */
const sendsOf = (store: Store, plan: Revision<MachinePlan>, scope = ""): Revision<ExecutionSend>[] =>
  store.identities("prefix", `${executionSendPrefix(plan.value.projectId, plan.value.hash)}${scope}`)
    .filter(row => row.kind === EXECUTION_SEND_KIND).map(row => store.get<ExecutionSend>(row.id, row.revision)!);
/** The outcome of a negative review: a plan finding stops, a code finding asks a correction. */
const negativeReview = (verdict: ReviewResult): Partial<TaskRun> =>
  ({ review: verdict, state: verdict.kind === "plan" ? "needs_plan" : "needs_code", child: null, error: verdict.findings.join("\n") });
const taskScope = (task: CompiledTask): string => `${task.id.replace(/^task:/, "")}:`;

/**
 * The admission's budget over the saved outcomes of this plan's launches (№3590: read, never re-derived). Every launch that
 * may have reached a provider counts; a proved gate refusal or a launch that never started does not (№3951-3). Input is the
 * measured input, or the role's reserve where none was measured; the forecast of this launch is the largest measured input
 * of its role, or its reserve before the first measurement — an agent reads the repository itself, so request characters
 * are no measure of it.
 */
export function requireExecutionBudget(store: Store, admission: ExecutionAdmission, plan: Revision<MachinePlan>, role: "implement" | "review"): void {
  const sends = sendsOf(store, plan).filter(row => !UNSENT.includes(row.value.status));
  const { roleLaunches, softInput, roleReserve } = admission.execution;
  if (sends.length + 1 > roleLaunches) throw new EngineError("execution_budget_exhausted", "The admitted role launches are used up",
    { target: plan.id, field: "roleLaunches", launches: sends.length, limit: roleLaunches });
  let committed = 0;
  for (const send of sends) committed += send.value.usage ? send.value.usage.inputTokens : roleReserve[send.value.role];
  const measured = sends.filter(row => row.value.role === role && row.value.usage).map(row => row.value.usage!.inputTokens);
  const forecast = measured.length ? Math.max(...measured) : roleReserve[role];
  if (committed + forecast > softInput) throw new EngineError("execution_budget_exhausted", "The admitted input would be exceeded by this launch",
    { target: plan.id, field: "softInput", committed, forecast, limit: softInput });
}
/** Correction attempts this task of this plan has already launched: durable, so a retry never opens another (№3947). */
export function correctionsUsed(store: Store, plan: Revision<MachinePlan>, task: CompiledTask): number {
  return new Set(sendsOf(store, plan, taskScope(task)).filter(row => row.value.role === "implement" && row.value.correction
    && !UNSENT.includes(row.value.status)).map(row => row.value.attempt)).size;
}
/** A new attempt corrects code when the latest settled outcome of its task, past interruptions, asked for a code change. */
function pendingCorrection(store: Store, id: string): boolean {
  for (const revision of store.history<TaskRun>(id).reverse()) {
    if (["interrupted", "implementing", "checking", "reviewing"].includes(revision.value.state)) continue;
    return revision.value.state === "needs_code";
  }
  return false;
}
/**
 * The stage an earlier attempt already paid for, resumed rather than bought again (№3953-3): its applied implementation,
 * when the managed candidate is still exactly its tree, resumes at the checks; a passed review of that tree resumes at the
 * commit. Anything else is a new attempt.
 */
function paidStage(root: ExecutionRoot, parent: string, task: CompiledTask, run: TaskRun): "checks" | "commit" | null {
  if (!["interrupted", "checking", "reviewing"].includes(run.state) || run.implementation === null || run.tree === null || run.parent !== parent) return null;
  try { if (capture(root, parent, task) !== run.tree) return null; } catch { return null; }
  return run.review?.verdict === "pass" && run.reviewSubject === subjectHash(run.plan, task.id, parent, run.tree) ? "commit" : "checks";
}

export class Executor {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly store: Store, private readonly compiler: Compiler, private readonly environments: Environments,
    private readonly afterGitPublish?: (run: TaskRun) => void) {}

  async run(project: string, planRef: Ref, options: ExecutionOptions, signal?: AbortSignal): Promise<Revision<TaskRun>[]> {
    requireCondition(options && typeof options.retry === "boolean" && Number.isSafeInteger(options.maxContextChars) && options.maxContextChars > 0
      && Number.isSafeInteger(options.maxCorrections) && options.maxCorrections >= 0, "execution_options_invalid", "Execution needs explicit context and correction allowances");
    // Every path into execution passes the continuation boundary; beyond compilation only the owner's admission of this plan.
    const admission = assertPilotBoundary(this.store, project, "execution", planRef);
    if (admission && options.maxCorrections > admission.execution.maxCorrections)
      throw new EngineError("execution_corrections_exceeded", "A command cannot raise the admitted correction limit",
        { target: project, field: "maxCorrections", admitted: admission.execution.maxCorrections, requested: options.maxCorrections });
    const lock = acquire(this.store, project);
    const control = new AbortController(); this.active.set(project, control);
    signal = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
    let held: RunExecution | null = null, unwatch: (() => void) | null = null;
    try {
      if (admission) {
        // An admitted execution holds the project's one control: a stop from any process reaches its live calls and checks.
        const taken = acquireRunExecution(this.store, { project });
        if (!taken.ok) throw new EngineError(taken.refusal.code, taken.refusal.message, taken.refusal.at);
        held = taken.value; unwatch = new RunControlGate(this.store, project, held.hold).watch(control);
      }
      await recoverCommits(this.store, this.compiler, project);
      const plan = this.compiler.read(planRef.id);
      requirePlanTaskObligations(this.store, plan.value);
      requireCondition(plan.value.projectId === project && plan.hash === planRef.hash && plan.revision === planRef.revision,
        "plan_foreign", "Execution must use the exact generated plan");
      const stage = this.store.get<StageArtifact>(stageId(project, "compilation"));
      requireCondition(stage?.kind === "stage" && stage.value.projectId === project && stage.value.stage === "compilation"
        && stage.value.status === "accepted" && canonical((stage.value.content as unknown as { plan: Ref }).plan) === canonical(reference(plan)),
        "plan_not_accepted", "Execution requires the accepted compilation result");
      planCurrentGuards(this.store, this.compiler, planRef);
      let root = ensureWorktree(this.store, this.environments, plan.value);
      const environment = this.store.get<Environment>(plan.value.environment.id, plan.value.environment.revision)!;
      const results: Revision<TaskRun>[] = []; let parent = plan.value.base.head;
      const corrections = new Map<string, number>();
      const maxCorrections = options.maxCorrections;
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
        if (run) {
          // The unfinished-process check precedes candidate creation and covers
          // every unfinished state — including interrupted/needs_code re-entry.
          if (run.value.child) {
            await stopOrphan(run.value.child);
            run = this.save(run, ["implementing", "checking", "reviewing"].includes(run.value.state)
              ? { state: "interrupted", child: null, error: "Previous process stopped before acceptance. Candidate files are preserved; retry explicitly." }
              : { child: null });
          } else {
            // Stop witnesses are addressed per exact attempt revision, so an
            // earlier attempt's witness can never be inherited by this entry.
            // The shared reader proves each witness's form and exact subject
            // revision before trusting it; an already resolved end stays
            // resolved even when a foreign process reuses its pid, while any
            // still-live or unverifiable spawned pid keeps blocking the next
            // executor.
            for (const verdict of evaluateProcessStopWitnesses(this.store, run.id)) {
              if (verdict.state === "ended") continue;
              throw new EngineError(
                verdict.state === "unavailable" ? "process_identity_unavailable" : "executor_still_running",
                "The interrupted launch left an unproven process; retry only after it provably ended",
                { pid: verdict.witness.pid, observedStarted: verdict.observedStarted, errno: verdict.errno });
            }
          }
        }
        // A launch left open by a lost process is closed before anything else: the gate's own saved refusal, a launch never
        // observed, or an unknown outcome kept at its reserve. Its group must be proved over first.
        const open = sendsOf(this.store, plan, taskScope(task)).filter(row => row.value.status === "sent");
        for (const send of open) if (send.value.group && runOwnerState(send.value.group) !== "gone")
          throw new EngineError("executor_still_running", "A launch of this task is still running; its end is not proved", { target: send.id, field: "group" });
        if (open.length) this.store.writeMany(open.map(send => lostSendClosure(this.store, send)));
        // A negative review of this attempt's exact tree, saved but not applied (an earlier era's lost process): its outcome is
        // applied — a plan finding stops, a code finding asks its correction — never bought again (№3961-1).
        if (run && ["interrupted", "checking", "reviewing"].includes(run.value.state) && run.value.review?.verdict === "request_changes"
          && run.value.tree && run.value.reviewSubject === subjectHash(run.value.plan, task.id, run.value.parent, run.value.tree))
          run = this.save(run, negativeReview(run.value.review));
        if (run && (run.value.state === "needs_plan" || !options.retry && !corrections.has(task.id))) { results.push(run); return results; }
        const guards = currentBasis(this.store, plan, root.value);
        const actual = { ...environment.value, workspace: root.value.path };
        if (run?.value.state === 'awaiting_obligation' && run.value.tree) {
          // The candidate, complete checks and independent review are already
          // paid work. A missing late confirmation must not regenerate them.
          try {
            requireCondition(capture(root.value, parent, task) === run.value.tree,
              'task_obligation_candidate_changed', 'The waiting candidate changed; do not reuse its accepted checks/review');
            run = commitIntent(this.store, root, run, plan.value, task, actual, [reference(lock), ...guards]);
            publishCommit(root.value, run.value, this.store, task); this.afterGitPublish?.(run.value);
            run = finishCommit(this.store, root, run, plan.value, task, actual);
            root = this.store.get<ExecutionRoot>(root.id)!; parent = run.value.commit!; results.push(run); continue;
          } catch (error) {
            if (run.value.state === 'commit_pending') throw error;
            const code = error instanceof EngineError ? error.code : 'task_obligation_resume_failed';
            run = this.save(run, { state: code === 'task_obligation_result_required' ? 'awaiting_obligation' : 'interrupted',
              error: `${code}: ${error instanceof Error ? error.message : 'Unable to accept the waiting result'}` });
            results.push(run); return results;
          }
        }
        if (!run) requireCondition(!git(root.value.path, ["status", "--porcelain", "--untracked-files=all"]),
          "worktree_dirty", "The managed worktree contains an unfinished change; recover that attempt first");
        const om = plan.value.feasibility.id.startsWith('om-feasibility:');
        let maxRequestChars = options.maxContextChars;
        let capacityGuards: readonly Ref[] = [];
        if (om) {
          const capacity = readCapacity(this.store, { project, environment: plan.value.environment, current: true });
          if (!capacity.ok) throw new EngineError(capacity.refusal.code, capacity.refusal.message, capacity.refusal.at);
          maxRequestChars = capacity.value.maxRequestChars;
          capacityGuards = capacity.value.guards;
          if (options.maxContextChars !== maxRequestChars) throw new EngineError('capacity_mismatch',
            'Execution must use the technical capacity of its exact plan environment',
            { unit: 'G3', target: environment.id, field: 'maxContextChars', expected: maxRequestChars, actual: options.maxContextChars });
        }
        const contextSources = loadTaskContextSources(this.store, plan);
        const previous = run?.value;
        const resume = run ? paidStage(root.value, parent, task, run.value) : null;
        let correction = false;
        if (resume) {
          // The paid implementation (and a passed review) are kept; only the free stages after them run again.
          run = this.save(run!, resume === "commit" ? { state: "reviewing", child: null, error: null }
            : { state: "checking", child: null, error: null, checks: [], review: null, reviewSubject: null });
        } else {
          correction = run ? pendingCorrection(this.store, run.id) : false;
          if (correction && correctionsUsed(this.store, plan, task) >= maxCorrections)
            throw new EngineError("execution_corrections_exhausted", "This task already used its correction; a retry opens no other",
              { target: task.id, field: "maxCorrections", limit: maxCorrections });
          if (admission) {
            // A refused budget spends no attempt: the task keeps its state and the command answers with the refusal.
            try { requireExecutionBudget(this.store, admission, plan, "implement"); }
            catch (error) {
              if (!run || !(error instanceof EngineError)) throw error;
              run = this.save(run, { state: "interrupted", child: null, error: `${error.code}: ${error.message}` });
              results.push(run); return results;
            }
          }
          const candidate: TaskRun = { projectId: project, plan: reference(plan), taskId: task.id, attempt: (previous?.attempt ?? 0) + 1,
            state: "implementing", parent, tree: null, commit: null, implementation: null, artifacts: [], checks: [], review: null,
            reviewSubject: null, child: null, error: null, inputs: [], usage: previous?.usage ?? [], createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() };
          const starts = taskStartProofs(this.store, candidate, task);
          run = this.store.writeMany<TaskRun>([{ id: runId(plan.value.hash, task.id), kind: "task-run", expected: run?.revision ?? 0,
            value: { ...candidate, ...(task.researchObligations !== undefined ? { obligationStartProofs: starts.proofs } : {}) } }],
          [reference(lock), reference(root), ...guards, ...capacityGuards, ...starts.guards])[0]!;
        }
        let launched: ExecutionSendHandle | null = null;
        const closure = (): Write[] => { const write = launched?.take() ?? null; launched = null; return write ? [write] : []; };
        const send = (role: "implement" | "review") => (request: { hash: string; chars: number }): ExecutionSendHandle => {
          const ordinal = sendsOf(this.store, plan, `${taskScope(task)}${run!.value.attempt}:${role}:`).length + 1;
          return launched = new ExecutionSendHandle(this.store, { project, plan: reference(plan), task: task.id, attempt: run!.value.attempt, role, ordinal,
            correction: role === "implement" && correction, admission: admission?.pilot ?? null }, plan.value.hash, request);
        };
        const observe: ProcessObserver = child => { run = this.save(run!, { child }); };
        const measure = (value: AgentUsage) => {
          const usage = [...run!.value.usage]; const index = usage.findIndex(item => item.requestHash === value.requestHash);
          if (index < 0) usage.push(value); else usage[index] = value;
          run = this.save(run!, { usage });
        };
        try {
          requireWritePaths(root.value.path, task.writePaths);
          const inputs = executionInputs(this.store, plan, task, root.value);
          const ownership = executionOwnership(this.store, plan, task, root.value);
          if (!resume) run = this.save(run, { inputs: [...inputs.guards, ...ownership.guards] });
          const context = JSON.parse(taskContext(plan, actual.fullCheck, task.id, maxRequestChars, contextSources).text);
          if (!resume) {
            requireCurrentTaskStart(this.store, run.value, task);
            const response = await callAgent(actual.implementer, actual, "implement", "Implement the supplied atomic result. Preserve unrelated files. Return text and artifacts as an array of {id} naming all implemented output contracts. The engine records code evidence; do not fabricate business artifact values. Do not commit.",
              { context, parent, inputs: inputs.inputs, ownership: ownership.grants, correction: previous ? { error: previous.error, review: previous.review } : null },
              maxRequestChars, measure, observe, signal, send("implement"));
            const output = implementation(response, task);
            const tree = capture(root.value, parent, task);
            // The answered launch and its application are one transaction.
            run = this.save(run, { state: "checking", implementation: output.text, artifacts: output.artifacts, tree }, closure());
          }
          const tree = run.value.tree!;
          if (resume !== "commit") {
            // The full check runs first: it builds the candidate (dist) the task's own commands read. The saved list keeps the
            // order every reader checks (checkCommands), so the task-run record keeps its form.
            const commands = checkCommands(task, actual), full = hashJson(actual.fullCheck);
            const order = [...commands.filter(command => hashJson(command) === full), ...commands.filter(command => hashJson(command) !== full)];
            const done = new Map<string, CheckResult>();
            for (const command of order) {
              const result = await executeProcess(command, actual.workspace, "", actual.timeoutMs, observe, signal);
              done.set(hashJson(command), { command, result });
              run = this.save(run, { checks: commands.filter(item => done.has(hashJson(item))).map(item => done.get(hashJson(item))!) });
              requireCondition(result.exitCode === 0 && result.signal === null, "full_check_failed", result.stderr.slice(-2000) || "A required check failed");
              requireCondition(capture(root.value, parent, task) === tree, "candidate_changed", "A check changed the candidate bytes");
            }
            const subject = subjectHash(reference(plan), task.id, parent, tree);
            run = this.save(run, { state: "reviewing", reviewSubject: subject });
            if (admission) requireExecutionBudget(this.store, admission, plan, "review");
            const answered = await callAgent(actual.reviewer, actual, "review", "Independently review the exact supplied task and candidate tree. Read the actual diff and tests. Return a structured pass or request_changes verdict; use kind=plan only when the plan needs correction, kind=code for implementation defects.",
              { binding: subject, context, parent, tree, artifacts: run.value.artifacts, checks: run.value.checks },
              maxRequestChars, measure, observe, signal, send("review"));
            const verdict = review(answered);
            requireCondition(capture(root.value, parent, task) === tree, "candidate_changed", "The candidate changed during independent review");
            if (verdict.verdict === "request_changes") {
              // The negative review, its launch and the state it decides are one transaction: a lost process after it buys no
              // second review of the same tree (№3961-1).
              run = this.save(run, negativeReview(verdict), closure());
              if (run.value.state === "needs_code" && correctionsUsed(this.store, plan, task) < maxCorrections) {
                corrections.set(task.id, (corrections.get(task.id) ?? 0) + 1); taskIndex--; continue;
              }
              results.push(run); return results;
            }
            run = this.save(run, { review: verdict }, closure());
          }
          run = commitIntent(this.store, root, run, plan.value, task, actual, [reference(lock), ...currentBasis(this.store, plan, root.value)]);
          publishCommit(root.value, run.value, this.store, task);
          this.afterGitPublish?.(run.value);
          run = finishCommit(this.store, root, run, plan.value, task, actual);
          root = this.store.get<ExecutionRoot>(root.id)!;
          parent = run.value.commit!; results.push(run);
        } catch (error) {
          // A pending Git intent is durable. It must be recovered, never retried as implementation.
          if (run.value.state === "commit_pending") throw error;
          const code = error instanceof EngineError ? error.code : "implementation_failed";
          const stopRefusal = error instanceof EngineError && isProcessStopRefusal(error) ? error : null;
          if (stopRefusal)
            writeProcessStopWitness(this.store, reference(run), { child: run.value.child }, stopRefusal);
          const interrupted = ["process_cancelled", "process_timeout", "process_failed", "executor_failed", "executor_protocol_invalid", "executor_response_foreign", "process_output_limit",
            "process_stop_denied", "process_stop_unconfirmed", "process_stop_failed", "process_identity_unavailable",
            "context_budget_exceeded", "write_scope_exceeded", "worktree_changed", "candidate_bytes_mismatch", "candidate_bytes_changed", "candidate_entry_unsupported",
            "execution_budget_exhausted"].includes(code);
          const planDefect = ["plan_review_failed", "plan_stale", "execution_input_missing", "execution_input_foreign", "producer_not_ready", "implementation_proof_foreign", "artifact_stale"].includes(code);
          const obligationPause = ['task_obligation_start_stale', 'task_obligation_result_required'].includes(code);
          // The outcome of the launch that failed is written with the state it decided.
          run = this.save(run, { state: obligationPause ? 'awaiting_obligation' : interrupted ? "interrupted" : planDefect ? "needs_plan" : "needs_code",
            // A refused or unproven stop keeps the last committed child identity;
            // the next entry repeats the check instead of trusting a bare null.
            child: stopRefusal ? run.value.child : null, error: om && code === 'context_budget_exceeded' && error instanceof EngineError
              ? `${code}: ${task.id}: ${error.message}; ${canonical(error.details)}`
              : obligationPause || code === "execution_budget_exhausted" ? `${code}: ${error instanceof Error ? error.message : 'Missing obligation evidence'}`
                : error instanceof Error ? error.message : "Execution failed" }, closure());
          if (run.value.state === "needs_code" && correctionsUsed(this.store, plan, task) < maxCorrections) {
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
    } finally {
      unwatch?.(); if (held) releaseRunExecution(this.store, held);
      this.active.delete(project); release(this.store, lock);
    }
  }
  isRunning(project: string): boolean { return this.active.has(project); }
  async recover(project: string): Promise<Revision<TaskRun>[]> {
    const lock = acquire(this.store, project);
    try { return await recoverCommits(this.store, this.compiler, project); }
    finally { release(this.store, lock); }
  }
  stop(project: string): boolean { const control = this.active.get(project); control?.abort(); return Boolean(control); }
  private save(run: Revision<TaskRun>, patch: Partial<TaskRun>, also: Write[] = []): Revision<TaskRun> {
    const write: Write = { id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, ...patch, updatedAt: Date.now() } as never };
    // A launch's closure joins the outcome it applies in one transaction; a plain save keeps its single write.
    return also.length ? this.store.writeMany<TaskRun>([write, ...also])[0]! : this.store.write<TaskRun>(write);
  }
}

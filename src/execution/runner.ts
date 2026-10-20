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
import { callAgent, implementationOutcome, review, planDefectOf, ExecutionSendHandle, EXECUTION_SEND_KIND, UNSENT, executionSendPrefix, lostSendClosure,
  ANSWER_FORM, type AddressContext, type ExecutionSend, type ExecutionSendFeedback } from "./protocol.js";
import type { Command } from "../graph/model.js";
import type { ProcessResult } from "../runtime/process.js";
import { executeProcess, stopOrphan, type ProcessObserver } from "./process.js";
import { isProcessStopRefusal, writeProcessStopWitness, evaluateProcessStopWitnesses } from "../runtime/process-identity.js";
import { checkCommands, commitIntent, publishCommit, finishCommit, subjectHash } from "./commit.js";
import { runId, findingText, EXECUTION_REVIEW_CONTRACT, type TaskRun, type ExecutionResult, type ExecutionOptions, type AgentUsage, type CheckResult,
  type ReviewResult } from "./model.js";
import { executionInputs } from "./inputs.js";
import { loadTaskContextSources, taskContext } from "../compiler/context.js";
import { readCapacity } from "../om/capacity.js";
import { canonical, hashJson } from "../canonical.js";
import { recoverCommits } from "./recovery.js";
import { executionOwnership } from "./ownership.js";
import { taskStartProofs, requireCurrentTaskStart, requirePlanTaskObligations } from './task-obligations.js';
import { assertPilotBoundary, type ExecutionAdmission } from "../discovery/reader-pilot.js";
import { acquireRunExecution, releaseRunExecution, runOwnerState, RunControlGate, type RunExecution } from "../om/run-control.js";
import { writeSealedExecutionStage } from './result.js';

/**
 * The currency of an exact plan, read the same way by the admission's writer and by execution (№3953-1): the compiler gate
 * before an execution root exists; the execution's own progress after it, so its own commits never make it stale.
 */
export function planCurrentGuards(store: Store, compiler: Compiler, planRef: Ref): TransactionGuard[] {
  const plan = compiler.read(planRef.id);
  requireCondition(plan.revision === planRef.revision && plan.hash === planRef.hash, "plan_foreign", "Execution must use the exact generated plan");
  const root = store.get<ExecutionRoot>(`execution-root:${plan.value.projectId}`);
  if (root?.value.state === "ready") return currentBasis(store, plan, root.value);
  const gate = compiler.gate(plan.value.projectId, planRef);
  requireCondition(gate.findings.length === 0, "plan_stale", "Refresh changed plan inputs before creating its worktree");
  return [...gate.guards, ...(gate.admissionGuards ?? [])];
}

/** The launches of exactly this plan (and task, attempt, role): read by their own id range, so the cost of a decision never
 * grows with the launches of other plans or tasks (№3606, №3961-3). */
const sendsOf = (store: Store, plan: Revision<MachinePlan>, scope = ""): Revision<ExecutionSend>[] =>
  store.identities("prefix", `${executionSendPrefix(plan.value.projectId, plan.value.hash)}${scope}`)
    .filter(row => row.kind === EXECUTION_SEND_KIND).map(row => store.get<ExecutionSend>(row.id, row.revision)!);
/** The outcome of a negative review of the era before AT3a: a plan finding stops, a code finding asks a correction. */
const negativeReview = (verdict: ReviewResult): Partial<TaskRun> =>
  ({ review: verdict, state: verdict.kind === "plan" ? "needs_plan" : "needs_code", child: null, error: verdict.findings.map(findingText).join("\n") });
const failing = (check: CheckResult): boolean => check.result.exitCode !== 0 || check.result.signal !== null;
/**
 * AT3a (№4125): the one outcome of a review verdict, by its producer and on every repeat of a saved one. A verdict of the
 * earlier era goes its own way. In the addressed era: pass with a failed check is refused and the code goes on; a plan
 * stops the attempt only when every addressed finding names this exact attempt (planDefectOf), else the code goes on with
 * the refusal named; a code verdict asks its correction. The verdict itself is always kept.
 */
export function reviewOutcome(verdict: ReviewResult, context: AddressContext): Partial<TaskRun> | null {
  if (verdict.contract !== EXECUTION_REVIEW_CONTRACT) return verdict.verdict === "request_changes" ? negativeReview(verdict) : null;
  const failed = context.checks.findIndex(failing);
  if (verdict.verdict === "pass") return failed < 0 ? null : { review: verdict, state: "needs_code", child: null,
    error: `review_pass_on_failed_check: the review passed a candidate whose check ${failed} failed; the failed check stands` };
  const texts = verdict.findings.map(findingText).join("\n");
  if (verdict.kind !== "plan") return { review: verdict, state: "needs_code", child: null, error: texts };
  const checked = planDefectOf(verdict.findings, context);
  return checked.ok ? { review: verdict, state: "needs_plan", child: null, error: texts, planDefect: checked.defect }
    : { review: verdict, state: "needs_code", child: null, error: `${checked.code}: ${checked.message}\n${texts}` };
}
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
// ---- EX2 (№3980): a correction sees the saved check that failed. ----

const TAP_SUMMARY = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/;
const tail = (text: string, limit: number): string => text.length <= limit ? text : text.slice(text.length - limit);
/** The failed check's excerpt fits the request it joins: at most 12 000 characters, at most an eighth of the allowance. */
export const feedbackLimit = (maxRequestChars: number): number => Math.max(1000, Math.min(12_000, Math.floor(maxRequestChars / 8)));
/**
 * What a correction is told of a failed check (№3980): its command, exit code or signal, where its full result is saved, and a
 * bounded excerpt of both streams — every TAP `not ok` with its diagnostic block (expected/actual) and the TAP summary, then the
 * stderr tail; output that is not TAP gives the tails of both streams. A cut is marked; the full result stays in the checks.
 */
/** Every TAP `not ok` line of an output with its diagnostic block (the lines indented below it). */
function notOkBlocks(stdout: string): string[] {
  const lines = stdout.split("\n"), indent = (line: string) => line.length - line.trimStart().length, blocks: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const match = /^(\s*)not ok \d+/.exec(lines[at]!);
    if (!match) continue;
    let end = at + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || indent(lines[end]!) > match[1]!.length)) end++;
    blocks.push(lines.slice(at, end).join("\n").trimEnd());
  }
  return blocks;
}
export function checkFeedback(command: Command, result: ProcessResult, index: number, limit: number): { text: string; truncated: boolean } {
  const head = `failed check: ${[command.executable.split("/").at(-1), ...command.args].join(" ")} → `
    + `${result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`} (its full stdout and stderr are saved in this attempt's checks[${index}])`;
  const lines = result.stdout.split("\n"), blocks = notOkBlocks(result.stdout);
  const parts = [head];
  let cut = false;
  if (blocks.length) {
    let room = Math.floor(limit * 0.7), shown = 0;
    for (const block of blocks) {
      if (room <= 0) break;
      const part = block.length > Math.min(3000, room) ? `${block.slice(0, Math.min(3000, room))}\n…` : block;
      if (part !== block) cut = true;
      parts.push(part); room -= part.length; shown++;
    }
    if (shown < blocks.length) { cut = true; parts.push(`… ${blocks.length - shown} more failing test(s) not shown`); }
    const summary = lines.map(line => line.trim()).filter(line => TAP_SUMMARY.test(line));
    if (summary.length) parts.push(summary.join("\n"));
    if (result.stderr.trim()) { const stderr = tail(result.stderr.trim(), 1000); cut ||= stderr.length < result.stderr.trim().length; parts.push(`stderr (tail):\n${stderr}`); }
  } else {
    const stdout = tail(result.stdout.trim(), Math.floor(limit * 0.6)), stderr = tail(result.stderr.trim(), Math.floor(limit * 0.3));
    cut = stdout.length < result.stdout.trim().length || stderr.length < result.stderr.trim().length;
    if (stdout) parts.push(`stdout (tail):\n${stdout}`);
    if (stderr) parts.push(`stderr (tail):\n${stderr}`);
  }
  let text = parts.join("\n");
  if (cut) text += "\n[cut: the excerpt is shortened; the full output is in the saved check]";
  if (text.length > limit) { text = `${text.slice(0, limit - 60)}\n[cut: the excerpt is shortened; see the saved check]`; cut = true; }
  return { text, truncated: cut };
}
/** The failed check of an attempt's saved checks, if one failed: the excerpt a correction of it is shown. */
function failedCheck(run: TaskRun, limit: number): (Omit<ExecutionSendFeedback, "basis"> & { text: string }) | null {
  const index = run.checks.findIndex(check => check.result.exitCode !== 0 || check.result.signal !== null);
  if (index < 0) return null;
  const check = run.checks[index]!, excerpt = checkFeedback(check.command, check.result, index, limit);
  return { check: index, chars: excerpt.text.length, truncated: excerpt.truncated, text: excerpt.text };
}

/** Correction attempts this task of this plan has already launched: durable, so a retry never opens another (№3947). */
export function correctionsUsed(store: Store, plan: Revision<MachinePlan>, task: CompiledTask): number {
  return new Set(sendsOf(store, plan, taskScope(task)).filter(row => row.value.role === "implement" && row.value.correction
    && !UNSENT.includes(row.value.status)).map(row => row.value.attempt)).size;
}
/** Every branch deciding whether to correct uses the same durable count. */
function correctionRoom(store: Store, plan: Revision<MachinePlan>, task: CompiledTask, limit: number): boolean {
  return correctionsUsed(store, plan, task) < limit;
}
/**
 * EX4 (№4016): the corrections one task may use in all — the command's limit, within the task's own limit the owner
 * addressed or else the admission's ordinary one. Every branch that opens or refuses a correction reads this one value.
 */
export function correctionLimit(options: ExecutionOptions, admission: ExecutionAdmission | null, task: string): number {
  if (!admission) return options.maxCorrections;
  const addressed = admission.execution.taskCorrections?.find(entry => entry.task === task);
  return Math.min(options.maxCorrections, addressed ? addressed.maxCorrections : admission.execution.maxCorrections);
}
/**
 * EX5 (№4035): the five classes of self-review — ПУТИ, ОТСУТСТВИЕ, МАСКАРАД, ОКНА, СОСЕДИ — in one place, given to both
 * roles. By the review statistics they bring ~90% of first findings; a role not asked to sweep them stops at the defect it
 * sees first, and every review buys the next one. They are questions about the behaviour the task promises, never new
 * requirements of their own.
 */
export const FIVE_CLASSES = "Five classes, applied to this task's own contract (its boundary, contracts, criteria and write paths in the context): "
  + "PATHS: every entry point and place that reaches the promised behaviour (engine calls, CLI commands, server routes and their requests, retries and recovery); "
  + "ABSENCE: a missing, empty or unreadable input, field, source or state gives a typed refusal or keeps its uncertainty, never a silent default or a skipped check; "
  + "MASQUERADE: a forged or foreign input or state (renamed or substituted file, another namespace, substituted hash, imitated status, structure of another kind) is told apart; "
  + "WINDOWS: the gap between a check or read and its write or commit, a lost response, a repeat, a concurrent writer; "
  + "NEIGHBOURS: callers and modules next to the change keep their contracts and tests. "
  + "These classes question the behaviour the task promises; they add no requirement of their own, such as recovering every kind of corruption.";
export const IMPLEMENT_CLASSES = "Before answering make five substantive passes over your change, one per class, fix what they find and add regressions on the real paths. "
  + "Targeted diagnostic checks of your change are allowed; the engine runs the full check once on the final bytes. "
  + "End the returned text with a short self-check: per class, the paths and tests checked, or why the class does not apply.";
export const CORRECTION_CLASSES = "This is a correction. correction.review holds every finding of the review and correction.error the failed check; "
  + "each is one instance of a class: name the requirement it violates and close that class on every path of the task, not only the place it cites. "
  + "Then pass the five classes again over your own correction: it must bring no new defect. The self-check names each finding with the paths and tests that now close it.";
/** The exact forms of a review answer the protocol accepts (protocol.review): the brief shows these, never its own variant (№4045). */
export const REVIEW_PASS = { verdict: "pass", kind: "none", findings: [] };
export const REVIEW_CHANGES = { verdict: "request_changes", kind: "code", findings: ["<class: requirement, place, scenario and consequence>"] };
/**
 * The review rules in the form the request asks for — one exact form of a finding and of each verdict, never two (№4045).
 * AT3a (№4125): the addressed form gives every plan finding its address; a code finding has none.
 */
export function reviewClasses(form: typeof ANSWER_FORM | null): string {
  return "Review in one pass over all five classes and return every confirmed blocking defect as a finding; after the first one keep reviewing. "
    + (form ? "Each finding is {text, address}: text is its class, the requirement it violates, the place, and the scenario with its consequence; address is null for a code finding. "
      : "Each finding is one string: its class, the requirement it violates, the place, and the scenario with its consequence. ")
    + "One root cause on several entries is one finding that lists them; independent roots are separate findings. A class may not apply; a hypothesis or a matter of style is no finding. "
    + `With no confirmed blocking defect after the whole review the answer is exactly ${JSON.stringify(REVIEW_PASS)}: verdict pass, kind none, no findings at all. `
    + `Otherwise it is ${JSON.stringify(form ? REVIEW_CHANGES_ADDRESSED : REVIEW_CHANGES)} with one finding or more; `
    + (form ? `kind is "plan" instead of "code" only when the plan itself is contradictory or cannot be executed: then every plan finding carries its address, `
      + "which the engine checks against this exact attempt, and the code findings go with it. A test outside the write paths is no plan defect by itself: "
      + `name the norm the contract contradicts or the path it needs. ${ADDRESS_FORM} `
      : `kind is "plan" instead of "code" only when the plan itself is contradictory or cannot be executed, and then all findings, code ones too, go with it. `)
    + "The full check already ran on these bytes: read its results in checks; a targeted check of a suspected defect is allowed.";
}
export const REVIEW_CLASSES = reviewClasses(null);
const listed = (items: readonly string[]): string => !items.length ? "none"
  : items.slice(0, 8).join(", ") + (items.length > 8 ? ` and ${items.length - 8} more` : "");
/** The five classes made concrete on one task's own contract: short questions from its boundary, contracts, criteria and paths. */
export function riskMap(task: CompiledTask): string {
  const entries = [...new Set((task.tests ?? []).flatMap(test => test.contract?.entrypoint ? [`${test.contract.entrypoint.kind} ${test.contract.entrypoint.path}`] : []))];
  const inputs = [...new Set((task.inputs ?? []).map(input => input.artifact))], criteria = (task.requirements ?? []).map(requirement => requirement.id);
  const { boundary } = task;
  return [`Risk map of ${task.id} (${boundary.state} state owned by ${boundary.authority}, written by ${boundary.writer}${boundary.provider ? ", through an external provider" : ""}):`,
    `PATHS: do all entries (${listed(entries)}) and write paths (${listed(task.writePaths ?? [])}) deliver ${listed(task.produces ?? [])} and the criteria (${listed(criteria)}) the same way?`,
    `ABSENCE: what does each entry do when an input (${listed(inputs)}) or its state is missing, empty or unreadable?`,
    `MASQUERADE: what when that input or state is foreign, renamed, substituted or of another structure?`,
    boundary.state === "durable"
      ? `WINDOWS: a lost response, a repeat, a concurrent writer, the window between read and commit: does ${boundary.authority} stay the one truth (rollback: ${boundary.rollback})?`
      : `WINDOWS: a repeat or a concurrent call: the same result, nothing half-written?`,
    `NEIGHBOURS: do the callers of what changes and the existing tests (${listed((task.tests ?? []).map(test => test.id))}) keep their contracts?`].join("\n");
}
const selfReview = (task: CompiledTask): string => `${FIVE_CLASSES}\n${riskMap(task)}`;
/**
 * EX6 (№4068): the owner's clarification of this exact task, from its admission — part of the task's contract, given to the
 * implementation, its correction and its review alike. Without one the requests stay exactly as they were.
 */
export const CLARIFICATION_HEAD = "Owner's clarification of this task's contract — part of the contract: it settles what the plan leaves ambiguous and never overrides an explicit requirement of the plan.";
export const CLARIFICATION_REVIEW = "Judge the candidate against the plan with this clarification: behaviour it prescribes is the contract, not a defect of any class.";
export function clarificationOf(admission: ExecutionAdmission | null, task: string): string | null {
  return admission?.execution.taskClarifications?.find(entry => entry.task === task)?.text ?? null;
}
const clarified = (text: string | null, review: boolean): string => text === null ? ""
  : `\n${CLARIFICATION_HEAD}${review ? ` ${CLARIFICATION_REVIEW}` : ""}\n${text}`;
/**
 * AT3a (№4125): what an execution under admission tells its roles of the addressed form. The address names this exact
 * attempt; the template in the request carries its plan, task, attempt and tree, the role adds the rest.
 */
export const ADDRESS_FORM = "An address is {plan, task, attempt, tree, requirement, norm, path, check}: plan, task, attempt and tree exactly as in "
  + "subject.address; requirement — a requirement or test id of this task; exactly one of norm (the existing expectation or rule the contract "
  + "contradicts) and path (a file outside the task's write paths the result needs), the other null; check — {index, failure} quoting the "
  + "failing line of that saved check when the finding rests on one, else null.";
export const IMPLEMENT_UNEXECUTABLE = "If the contract cannot be executed as planned — an existing expectation it cancels lies outside your write paths, "
  + "the result needs a file outside them, or the plan contradicts itself — do not work around it and do not change other files: answer instead "
  + `exactly {"outcome":"contract_unexecutable","findings":[{"text":"<requirement, contradiction and consequence>","address":{...}}]} with tree null and check null. ${ADDRESS_FORM}`;
export const REVIEW_CHANGES_ADDRESSED = { verdict: "request_changes", kind: "code", findings: [{ text: "<class: requirement, place, scenario and consequence>", address: null }] };
export const REVIEW_FAILED_CHECK = "The full check FAILED on these bytes (see checks and the excerpt below). pass is not allowed. Answer code when the "
  + "code must change; answer plan only with addressed findings when the failure shows the plan contradicts an existing expectation it cannot "
  + "change or needs a path outside the write paths.";
const IMPLEMENT = "Implement the supplied atomic result. Preserve unrelated files. Return text and artifacts as an array of {id} naming all implemented output contracts. The engine records code evidence; do not fabricate business artifact values. Do not commit.";
/** A new attempt corrects code when the latest settled outcome of its task, past interruptions, asked for a code change. */
/**
 * The outcome a new attempt corrects: the latest settled outcome of its task, past interruptions and launches that never got an
 * answer, when it asked for a code change — its failed check and findings are what the correction is shown, however many
 * attempts were refused or interrupted on the way (№3986-1). Read once, when the new attempt is produced.
 */
function correctionBasis(store: Store, id: string): Revision<TaskRun> | null {
  for (const revision of store.history<TaskRun>(id).reverse()) {
    if (["interrupted", "implementing", "checking", "reviewing"].includes(revision.value.state)) continue;
    return revision.value.state === "needs_code" ? revision : null;
  }
  return null;
}
/**
 * The stage an earlier attempt already paid for, resumed rather than bought again (№3953-3): its applied implementation,
 * when the managed candidate is still exactly its tree, resumes at the checks; a passed review of that tree resumes at the
 * commit. Anything else is a new attempt.
 */
function paidStage(root: ExecutionRoot, parent: string, task: CompiledTask, run: TaskRun, addressed: { reviewed: boolean } | null): "checks" | "commit" | "review" | null {
  // AT3a return №4141 P2-1, P2-2: under admission a completed failed check of this candidate that no review has answered
  // is reviewed as saved — never run again, never replaced, and no correction slot is opened for it — whatever state the
  // attempt stopped in, an earlier era's needs_code included.
  const failed = run.checks.some(failing);
  if (addressed && failed && run.review === null && !addressed.reviewed && run.implementation !== null && run.tree !== null && run.parent === parent
    && ["interrupted", "checking", "reviewing", "needs_code"].includes(run.state)) {
    try { return capture(root, parent, task) === run.tree ? "review" : null; } catch { return null; }
  }
  if (!["interrupted", "checking", "reviewing"].includes(run.state) || run.implementation === null || run.tree === null || run.parent !== parent) return null;
  try { if (capture(root, parent, task) !== run.tree) return null; } catch { return null; }
  return run.review?.verdict === "pass" && run.reviewSubject === subjectHash(run.plan, task.id, parent, run.tree) && !failed ? "commit" : "checks";
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
    // The command asks no more than some limit of the admission: its ordinary one or a task's addressed one (EX4).
    const admitted = admission ? Math.max(admission.execution.maxCorrections, ...(admission.execution.taskCorrections ?? []).map(entry => entry.maxCorrections)) : null;
    if (admitted !== null && options.maxCorrections > admitted)
      throw new EngineError("execution_corrections_exceeded", "A command cannot raise the admitted correction limit",
        { target: project, field: "maxCorrections", admitted, requested: options.maxCorrections });
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
      for (let taskIndex = 0; taskIndex < plan.value.tasks.length; taskIndex++) {
        const task = plan.value.tasks[taskIndex]!, limit = correctionLimit(options, admission, task.id), clarification = clarificationOf(admission, task.id);
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
        const capacity = readCapacity(this.store, { project, environment: plan.value.environment, current: true });
        if (!capacity.ok) throw new EngineError(capacity.refusal.code, capacity.refusal.message, capacity.refusal.at);
        const maxRequestChars = capacity.value.maxRequestChars, capacityGuards = capacity.value.guards;
        if (options.maxContextChars !== maxRequestChars) throw new EngineError('capacity_mismatch',
          'Execution must use the technical capacity of its exact plan environment',
          { unit: 'G3', target: environment.id, field: 'maxContextChars', expected: maxRequestChars, actual: options.maxContextChars });
        const contextSources = loadTaskContextSources(this.store, plan);
        const previous = run?.value;
        // A review this attempt already answered is never bought again for the same saved check (its outcome stands).
        const addressed = admission && run ? { reviewed: sendsOf(this.store, plan, `${taskScope(task)}${run.value.attempt}:review:`)
          .some(row => row.value.status === "answered") } : null;
        const resume = run ? paidStage(root.value, parent, task, run.value, addressed) : null;
        let correction = false, basis: Revision<TaskRun> | null = null;
        if (resume) {
          // The paid implementation (and a passed review) are kept; only the free stages after them run again — but a
          // completed failed check is the basis of its review and is kept as saved.
          run = this.save(run!, resume === "commit" || resume === "review" ? { state: "reviewing", child: null, error: null }
            : { state: "checking", child: null, error: null, checks: [], review: null, reviewSubject: null });
        } else {
          basis = run ? correctionBasis(this.store, run.id) : null;
          correction = basis !== null;
          if (correction && correctionsUsed(this.store, plan, task) >= limit)
            throw new EngineError("execution_corrections_exhausted", "This task already used its corrections; a retry opens no other",
              { target: task.id, field: "maxCorrections", limit });
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
            obligationStartProofs: [], obligationResultProofs: [],
            reviewSubject: null, child: null, error: null, inputs: [], usage: previous?.usage ?? [], createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() };
          const starts = taskStartProofs(this.store, candidate, task);
          run = this.store.writeMany<TaskRun>([{ id: runId(plan.value.hash, task.id), kind: "task-run", expected: run?.revision ?? 0,
            value: { ...candidate, obligationStartProofs: starts.proofs } }],
          [reference(lock), reference(root), ...guards, ...capacityGuards, ...starts.guards])[0]!;
        }
        // What the correction is shown of the attempt it corrects: the excerpt of its failed check, from the saved result (№3980).
        const shown = basis ? failedCheck(basis.value, feedbackLimit(maxRequestChars)) : null;
        let launched: ExecutionSendHandle | null = null;
        const closure = (): Write[] => { const write = launched?.take() ?? null; launched = null; return write ? [write] : []; };
        const send = (role: "implement" | "review") => (request: { hash: string; chars: number }): ExecutionSendHandle => {
          const ordinal = sendsOf(this.store, plan, `${taskScope(task)}${run!.value.attempt}:${role}:`).length + 1;
          return launched = new ExecutionSendHandle(this.store, { project, plan: reference(plan), task: task.id, attempt: run!.value.attempt, role, ordinal,
            correction: role === "implement" && correction, admission: admission?.pilot ?? null,
            feedback: role === "implement" && shown && basis ? { check: shown.check, chars: shown.chars, truncated: shown.truncated, basis: reference(basis) } : null },
            plan.value.hash, request);
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
          // AT3a: an execution under admission asks the addressed form of both roles; without one the requests stay as they were.
          const form = admission ? ANSWER_FORM : null;
          const address = (tree: string | null) => form ? { answerForm: form, address: { plan: reference(plan), task: task.id, attempt: run!.value.attempt, tree } } : {};
          if (!resume) {
            requireCurrentTaskStart(this.store, run.value, task);
            const response = await callAgent(actual.implementer, actual, "implement", `${IMPLEMENT} ${IMPLEMENT_CLASSES}${correction ? ` ${CORRECTION_CLASSES}` : ""}${form ? ` ${IMPLEMENT_UNEXECUTABLE}` : ""}\n${selfReview(task)}${clarified(clarification, false)}`,
              { context, parent, inputs: inputs.inputs, ownership: ownership.grants,
                correction: basis ? { error: shown ? shown.text : basis.value.error, review: basis.value.review }
                  : previous ? { error: previous.error, review: previous.review } : null, ...address(null) },
              maxRequestChars, measure, observe, signal, send("implement"));
            const output = implementationOutcome(response, task, form);
            if (output.kind === "unexecutable") {
              // The contract cannot be executed: its address is proved here, before anything is checked or reviewed; no check is
              // asked for or invented. What the working copy holds is established first (return №4141 P2-3): a change outside
              // the task's write paths is refused as any candidate's; an existing candidate — this answer's or a paid earlier
              // one still in place — is recorded by its exact tree in the attempt and in every address; none means none.
              let candidate: string | null = null;
              try { candidate = capture(root.value, parent, task); }
              catch (error) { if (!(error instanceof EngineError && error.code === "candidate_empty")) throw error; }
              const checked = planDefectOf(output.findings, { plan: reference(plan), task, attempt: run.value.attempt, tree: null, checks: [], source: "implementation" });
              const defect = checked.ok ? { ...checked.defect, findings: checked.defect.findings.map(item => item.address === null ? item
                : { ...item, address: { ...item.address, tree: candidate } }) } : null;
              const texts = output.findings.map(item => item.text).join("\n");
              run = this.save(run, defect ? { state: "needs_plan", child: null, error: texts, planDefect: defect, tree: candidate }
                : { state: "needs_code", child: null, error: `${checked.ok ? "" : `${checked.code}: ${checked.message}`}\n${texts}`, tree: candidate }, closure());
              if (run.value.state === "needs_code" && correctionRoom(this.store, plan, task, limit)) {
                corrections.set(task.id, (corrections.get(task.id) ?? 0) + 1); taskIndex--; continue;
              }
              results.push(run); return results;
            }
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
            // A completed failed check kept as saved is what its review reads (return №4141 P2-2); otherwise the checks run.
            let failed: string | null = resume === "review" ? failedCheck(run.value, feedbackLimit(maxRequestChars))!.text : null;
            for (const command of resume === "review" ? [] : order) {
              const result = await executeProcess(command, actual.workspace, "", actual.timeoutMs, observe, signal);
              done.set(hashJson(command), { command, result });
              run = this.save(run, { checks: commands.filter(item => done.has(hashJson(item))).map(item => done.get(hashJson(item))!) });
              const feedback = () => checkFeedback(command, result, run!.value.checks.findIndex(check => hashJson(check.command) === hashJson(command)), feedbackLimit(maxRequestChars)).text;
              // AT3a (№4125): under admission a failed check no longer ends the attempt before the review — the existing reviewer
              // reads the saved candidate and checks and decides code or an addressed plan, before any correction is bought.
              if (!form) requireCondition(result.exitCode === 0 && result.signal === null, "full_check_failed", feedback());
              requireCondition(capture(root.value, parent, task) === tree, "candidate_changed", "A check changed the candidate bytes");
              if (result.exitCode !== 0 || result.signal !== null) { failed = feedback(); break; }
            }
            const subject = subjectHash(reference(plan), task.id, parent, tree);
            run = this.save(run, { state: "reviewing", reviewSubject: subject });
            if (admission) requireExecutionBudget(this.store, admission, plan, "review");
            const answered = await callAgent(actual.reviewer, actual, "review", `Independently review the exact supplied task and candidate tree. Read the actual diff and tests. Return a structured pass or request_changes verdict. ${reviewClasses(form)}${failed !== null ? `\n${REVIEW_FAILED_CHECK}\n${failed}` : ""}\n${selfReview(task)}${clarified(clarification, true)}`,
              { binding: subject, context, parent, tree, artifacts: run.value.artifacts, checks: run.value.checks, ...address(tree) },
              maxRequestChars, measure, observe, signal, send("review"));
            const verdict = review(answered, form);
            requireCondition(capture(root.value, parent, task) === tree, "candidate_changed", "The candidate changed during independent review");
            const outcome = reviewOutcome(verdict, { plan: reference(plan), task, attempt: run.value.attempt, tree, checks: run.value.checks, source: "review" });
            if (outcome) {
              // The negative review, its launch and the state it decides are one transaction: a lost process after it buys no
              // second review of the same tree (№3961-1).
              run = this.save(run, outcome, closure());
              if (run.value.state === "needs_code" && correctionRoom(this.store, plan, task, limit)) {
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
            child: stopRefusal ? run.value.child : null, error: code === 'context_budget_exceeded' && error instanceof EngineError
              ? `${code}: ${task.id}: ${error.message}; ${canonical(error.details)}`
              : obligationPause || code === "execution_budget_exhausted" ? `${code}: ${error instanceof Error ? error.message : 'Missing obligation evidence'}`
                : error instanceof Error ? error.message : "Execution failed" }, closure());
          if (run.value.state === "needs_code" && correctionRoom(this.store, plan, task, limit)) {
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
        writeSealedExecutionStage(this.store, project, reference(stage), reference(result), previousStage?.revision ?? 0);
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

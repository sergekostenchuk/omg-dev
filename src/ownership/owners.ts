import type { Store } from "../storage/store.js";
import type { MachinePlan, CompiledTask } from "../compiler/model.js";
import type { TaskRun } from "../execution/model.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { git, type RepositoryState, type Environment } from "../runtime/environment.js";
import { treeFile } from "../runtime/git-files.js";
import { canonical, digest } from "../canonical.js";
import { requireCondition } from "../errors.js";
import type { Boundary } from "../graph/model.js";
import { requireGates } from "../execution/commit.js";

export interface WriterProof { ref: Ref; node: string; path: string; boundary: Boundary; commit: string; tree: string; hash: string | null }
type Repository = Pick<RepositoryState, "root" | "head">;
interface WriterSource { run: Ref; value: TaskRun; plan: MachinePlan; task: CompiledTask }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function requireContext(store: Store, project: string, repository: Repository, path?: string): void {
  requireCondition(store && typeof store.get === "function" && text(project) && object(repository)
    && text(repository.root) && text(repository.head) && (path === undefined || text(path)),
  "ownership_proof_foreign", "Ownership needs a project, exact repository slice and path");
}
function writerSource(store: Store, project: string, ref: Ref): WriterSource {
  requireCondition(isRef(ref), "ownership_proof_foreign", "An accepted writer needs an exact run reference");
  const run = store.get<TaskRun>(ref.id, ref.revision);
  requireCondition(run?.kind === "task-run" && run.hash === ref.hash && object(run.value)
    && run.value.projectId === project && run.value.state === "committed" && text(run.value.commit)
    && isRef(run.value.plan), "ownership_proof_foreign", "The exact accepted writer is missing or foreign");
  const plan = store.get<MachinePlan>(run.value.plan.id, run.value.plan.revision);
  requireCondition(plan?.kind === "plan" && plan.hash === run.value.plan.hash && object(plan.value)
    && plan.value.projectId === project && Array.isArray(plan.value.tasks),
  "ownership_proof_foreign", "An accepted writer has no matching plan");
  const task = plan.value.tasks.find(task => object(task) && task.id === run.value.taskId);
  requireCondition(task && Array.isArray(task.writePaths) && task.writePaths.every(text),
    "ownership_proof_foreign", "An accepted writer has no matching task");
  return { run: reference(run), value: run.value, plan: plan.value, task };
}


/** Shape guards only: acceptance remains entirely in the common gate checker. */
function requireGateShape(writer: WriterSource, environment: Environment): void {
  const command = (value: unknown) => object(value) && text(value.executable)
    && Array.isArray(value.args) && value.args.every(arg => typeof arg === "string");
  const { value: run, task, plan } = writer;
  requireCondition(Array.isArray(run.artifacts) && run.artifacts.every(item => object(item) && text(item.id))
    && Array.isArray(run.checks) && run.checks.every(check => object(check) && command(check.command) && object(check.result)
      && (check.result.exitCode === null || typeof check.result.exitCode === "number")
      && (check.result.signal === null || typeof check.result.signal === "string"))
    && (run.review === null || (object(run.review) && Array.isArray(run.review.findings)))
    && text(run.parent) && Number.isSafeInteger(run.attempt)
    && Array.isArray(task.produces) && task.produces.every(text)
    && Array.isArray(task.tests) && task.tests.every(test => object(test) && command(test.command)
      && (test.contract === undefined || (object(test.contract) && Array.isArray(test.contract.counterfactuals)
        && test.contract.counterfactuals.every(item => object(item) && command(item.command)))))
    && (task.researchObligations === undefined || (Array.isArray(task.researchObligations)
      && task.researchObligations.every(item => object(item) && object(item.requirement)
        && Array.isArray(item.tests) && item.tests.every(text))))
    && command(environment.fullCheck) && isRef(plan.feasibility) && isRef(plan.graph),
  "ownership_proof_foreign", "The accepted writer has malformed gate sources");
}

/** Check one immutable writer against a supplied repository slice; never select a current head. */
export function readWriter(store: Store, project: string, repository: Repository, run: Ref, path: string): WriterProof {
  requireContext(store, project, repository, path);
  requireCondition(text(path), "ownership_proof_foreign", "An accepted writer needs an exact path");
  const writer = writerSource(store, project, run);
  requireCondition(writer.task.writePaths.includes(path)
    && new Set(git(repository.root, ["rev-list", repository.head]).split("\n")).has(writer.value.commit!),
  "ownership_proof_foreign", "The accepted writer does not own this path in the repository slice");
  requireCondition(writer.value.tree && git(repository.root, ["rev-parse", `${writer.value.commit}^{tree}`]) === writer.value.tree,
    "ownership_proof_foreign", "The accepted writer must bind its exact commit tree");
  requireCondition(isRef(writer.plan.environment), "ownership_proof_foreign", "The accepted writer needs an exact check environment");
  const environment = store.get<Environment>(writer.plan.environment.id, writer.plan.environment.revision);
  requireCondition(environment?.kind === "environment" && environment.hash === writer.plan.environment.hash
    && object(environment.value) && environment.value.projectId === project,
  "ownership_proof_foreign", "The accepted writer has no matching check environment");
  requireGateShape(writer, environment.value);
  requireGates(writer.value, writer.task, environment.value, store);
  const bytes = treeFile(repository.root, writer.value.commit!, path);
  const current = treeFile(repository.root, repository.head, path);
  const hash = bytes === null ? null : digest(bytes);
  requireCondition(hash === (current === null ? null : digest(current)), "ownership_code_changed", "The file changed outside its accepted writer's result");
  return { ref: writer.run, node: writer.task.node, path, boundary: writer.task.boundary,
    commit: writer.value.commit!, tree: writer.value.tree, hash };
}

/** The caller proves the set's completeness; selection and acceptance use only these exact revisions. */
export function selectWriter(store: Store, project: string, repository: Repository, refs: readonly Ref[], path: string): WriterProof | null {
  requireContext(store, project, repository, path);
  requireCondition(text(path) && Array.isArray(refs) && refs.every(isRef),
    "ownership_proof_foreign", "Writer selection needs exact run references and a path");
  const candidates = refs.map(ref => writerSource(store, project, ref)).filter(writer => writer.task.writePaths.includes(path));
  if (!candidates.length) return null;
  const ancestors = new Set(git(repository.root, ["rev-list", repository.head]).split("\n"));
  const accepted = candidates.filter(writer => ancestors.has(writer.value.commit!));
  if (!accepted.length) return null;
  let latest = accepted[0]!;
  for (const candidate of accepted.slice(1)) {
    if (candidate.value.commit === latest.value.commit) {
      requireCondition(canonical(candidate.run) === canonical(latest.run), "ownership_ambiguous", "Different accepted runs claim the same write commit"); continue;
    }
    try { git(repository.root, ["merge-base", "--is-ancestor", latest.value.commit!, candidate.value.commit!]); latest = candidate; }
    catch { try { git(repository.root, ["merge-base", "--is-ancestor", candidate.value.commit!, latest.value.commit!]); }
      catch { requireCondition(false, "ownership_ambiguous", "Parallel writers need an accepted integration before ownership can transfer"); } }
  }
  return readWriter(store, project, repository, latest.run, path);
}

/** Ownership is a projection of immutable accepted runs, not a second mutable truth. */
export class Owners {
  private readonly writers: Ref[] = [];
  private readonly cache = new Map<string, WriterProof | null>();
  constructor(private readonly store: Store, private readonly project: string, private readonly repository: Repository) {
    requireContext(store, project, repository);
    let ancestors: Set<string> | null = null;
    for (const run of store.list<TaskRun>("task-run")) {
      if (run.value.projectId !== project || run.value.state !== "committed") continue;
      ancestors ??= new Set(git(repository.root, ["rev-list", repository.head]).split("\n"));
      if (!run.value.commit || !ancestors.has(run.value.commit)) continue;
      this.writers.push(writerSource(store, project, reference(run)).run);
    }
  }
  latest(path: string): WriterProof | null {
    if (this.cache.has(path)) return this.cache.get(path)!;
    const result = selectWriter(this.store, this.project, this.repository, this.writers, path);
    this.cache.set(path, result); return result;
  }
}

import { Store, type Revision, type Write } from "../storage/store.js";
import { git, type Environment, type ExecutionRoot } from "../runtime/environment.js";
import { treeFile } from "../runtime/git-files.js";
import { digest, hashJson } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { receiptId, type ArtifactReceipt, type MachinePlan, type CompiledTask } from "../compiler/model.js";
import type { TaskRun } from "./model.js";
import { requireWorktree } from "./worktree.js";

export const subjectHash = (plan: Ref, task: string, parent: string, tree: string): string => hashJson({ plan, task, parent, tree });
export function checkCommands(task: CompiledTask, environment: Environment) {
  return [...new Map([...task.tests.flatMap(test => [test.command, ...(test.contract?.counterfactuals.map(item => item.command) ?? [])]), environment.fullCheck]
    .map(command => [hashJson(command), command])).values()];
}
export function requireGates(run: TaskRun, task: CompiledTask, environment: Environment): void {
  requireCondition(run.artifacts.length === task.produces.length && new Set(run.artifacts.map(item => item.id)).size === task.produces.length
    && task.produces.every(id => run.artifacts.some(item => item.id === id)), "artifact_set_invalid", "Acceptance must preserve all implemented contracts");
  requireCondition(run.tree && run.checks.length === checkCommands(task, environment).length
    && run.checks.every((check, index) => hashJson(check.command) === hashJson(checkCommands(task, environment)[index])
      && check.result.exitCode === 0 && check.result.signal === null), "checks_not_passed", "The complete configured check set must pass on the candidate");
  requireCondition(run.review?.verdict === "pass" && run.review.kind === "none" && run.review.findings.length === 0
    && run.reviewSubject === subjectHash(run.plan, task.id, run.parent, run.tree),
    "review_not_passed", "Independent review must pass on this exact candidate");
}
export function commitIntent(store: Store, root: Revision<ExecutionRoot>, run: Revision<TaskRun>, plan: MachinePlan,
  task: CompiledTask, environment: Environment, guards: Ref[]): Revision<TaskRun> {
  requireGates(run.value, task, environment); requireWorktree(root.value, run.value.parent);
  const commit = git(root.value.path, ["-c", "user.name=OMG Engine", "-c", "user.email=engine@omg.local", "commit-tree", run.value.tree!, "-p", run.value.parent],
    `${task.title}\n\nOMG plan: ${plan.hash}\nOMG task: ${task.id}\n`);
  return store.writeMany<TaskRun>([{ id: run.id, kind: run.kind, expected: run.revision,
    value: { ...run.value, state: "commit_pending", commit, updatedAt: Date.now() } }], [reference(root), reference(run), ...run.value.inputs, ...guards])[0]!;
}
export function publishCommit(root: ExecutionRoot, run: TaskRun): void {
  requireCondition(run.commit && run.tree, "commit_intent_missing", "Recovery needs an exact commit intent");
  const head = git(root.path, ["rev-parse", "HEAD"]);
  requireWorktree(root, head);
  requireCondition(git(root.path, ["rev-list", "--parents", "-n", "1", run.commit]) === `${run.commit} ${run.parent}`
    && git(root.path, ["rev-parse", `${run.commit}^{tree}`]) === run.tree, "commit_foreign", "Commit does not match its recorded parent and reviewed tree");
  if (head === run.commit) return;
  requireCondition(head === run.parent, "commit_parent_changed", "Branch changed outside this commit intent; no reset was performed");
  git(root.path, ["update-ref", `refs/heads/${root.branch}`, run.commit, run.parent]);
}
export function finishCommit(store: Store, root: Revision<ExecutionRoot>, run: Revision<TaskRun>, plan: MachinePlan,
  task: CompiledTask, environment: Environment): Revision<TaskRun> {
  requireGates(run.value, task, environment);
  requireCondition(run.value.state === "commit_pending" && run.value.commit && run.value.tree, "commit_intent_missing", "An exact pending commit is required");
  requireWorktree(root.value, run.value.commit);
  const accepted: TaskRun = { ...run.value, state: "committed", child: null, updatedAt: Date.now() };
  const acceptedRef = { id: run.id, revision: run.revision + 1, hash: hashJson(accepted) };
  const writes: Write[] = [
    { id: run.id, kind: run.kind, expected: run.revision, value: accepted },
    { id: root.id, kind: root.kind, expected: root.revision, value: { ...root.value, head: run.value.commit } },
  ];
  const files = task.writePaths.map(path => { const bytes = treeFile(root.value.path, run.value.commit!, path); return { path, hash: bytes === null ? null : digest(bytes) }; });
  for (const output of run.value.artifacts) {
    const artifact = plan.graphSnapshot.artifacts.find(item => item.id === output.id)!;
    const contract = plan.graphSnapshot.contracts.find(item => item.id === artifact.contract)!;
    const id = receiptId(plan.projectId, output.id); const old = store.get(id);
    const value: ArtifactReceipt = { projectId: plan.projectId, artifact: output.id, node: task.node,
      signature: task.signature, contractHash: hashJson(contract.schema), commit: run.value.commit, tree: run.value.tree,
      value: { files }, plan: run.value.plan, run: acceptedRef };
    writes.push({ id, kind: "artifact", expected: old?.revision ?? 0, value });
  }
  return store.writeMany<TaskRun>(writes)[0]!;
}

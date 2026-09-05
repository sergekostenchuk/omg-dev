import { dirname, join } from "node:path";
import type { Store, Revision } from "../storage/store.js";
import type { Compiler } from "../compiler/compiler.js";
import { git, type ExecutionRoot } from "../runtime/environment.js";
import { canonical, hashJson } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import type { TaskRun } from "./model.js";
import { capture } from "./candidate.js";
import { stopOrphan } from "./process.js";
import { materializeWorktree, requireWorktree } from "./worktree.js";

export interface ParkedCandidate {
  projectId: string; run: Ref; root: Ref; previous: ExecutionRoot; next: ExecutionRoot;
  tree: string; archiveRef: string; state: "preparing" | "parked";
}

/** Called while holding the project's execution lock. No old files are reset or removed. */
export async function parkCandidate(store: Store, compiler: Compiler, project: string, runRef: Ref): Promise<Revision<ParkedCandidate>> {
  const run = store.get<TaskRun>(runRef.id);
  requireCondition(run?.kind === "task-run" && run.hash === runRef.hash && run.revision === runRef.revision
    && run.value.projectId === project && run.value.state === "needs_plan", "repair_run_foreign", "Only this project's exact failed plan attempt can be parked");
  const id = `parked:${hashJson(runRef)}`;
  let parked = store.get<ParkedCandidate>(id);
  if (parked?.value.state === "parked") return parked;
  const root = store.get<ExecutionRoot>(`execution-root:${project}`);
  requireCondition(root?.kind === "execution-root" && root.value.state === "ready" && root.value.head === run.value.parent,
    "repair_root_changed", "Repair must start from the failed attempt's accepted parent");
  const plan = compiler.read(run.value.plan.id);
  requireCondition(canonical(reference(plan)) === canonical(run.value.plan), "repair_plan_foreign", "The candidate needs its exact original plan");
  const task = plan.value.tasks.find(task => task.id === run.value.taskId);
  requireCondition(task, "repair_task_foreign", "The failed task is absent from its original plan");
  await stopOrphan(run.value.child);
  requireWorktree(root.value, run.value.parent);
  const tree = run.value.tree ?? git(root.value.path, ["rev-parse", `${run.value.parent}^{tree}`]);
  if (run.value.tree) requireCondition(capture(root.value, run.value.parent, task) === tree, "repair_candidate_changed", "New edits appeared after the plan failure; they were preserved");
  else requireCondition(!git(root.value.path, ["status", "--porcelain", "--untracked-files=all"]), "repair_candidate_unknown", "Unrecorded files must not be attributed to a failed plan");
  if (!parked) {
    const key = hashJson([store.databaseId, runRef]).slice(0, 24);
    const next: ExecutionRoot = { ...root.value, path: join(dirname(store.path), "worktrees", key), branch: `omg/${key}`,
      base: root.value.head, head: root.value.head, state: "ready" };
    parked = store.writeMany<ParkedCandidate>([{ id, kind: "parked-candidate", expected: 0, value: {
      projectId: project, run: runRef, root: reference(root), previous: root.value, next, tree, archiveRef: `refs/omg/candidates/${key}`, state: "preparing",
    } }], [runRef, reference(root)])[0]!;
  }
  requireCondition(canonical(parked.value.root) === canonical(reference(root)) && parked.value.tree === tree,
    "repair_root_changed", "The root no longer matches the saved parking intent");
  const existing = git(root.value.path, ["for-each-ref", "--format=%(objectname)", parked.value.archiveRef]);
  requireCondition(!existing || existing === tree, "repair_archive_foreign", "An archive reference already names different code");
  if (!existing) git(root.value.path, ["update-ref", parked.value.archiveRef, tree, "0".repeat(tree.length)]);
  materializeWorktree(parked.value.next);
  return store.writeMany<ParkedCandidate>([
    { id: parked.id, kind: parked.kind, expected: parked.revision, value: { ...parked.value, state: "parked" } },
    { id: root.id, kind: root.kind, expected: root.revision, value: parked.value.next },
  ], [runRef, reference(root)])[0]!;
}

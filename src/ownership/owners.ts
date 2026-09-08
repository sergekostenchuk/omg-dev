import type { Store } from "../storage/store.js";
import type { MachinePlan, CompiledTask } from "../compiler/model.js";
import type { TaskRun } from "../execution/model.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { git, type RepositoryState, type Environment } from "../runtime/environment.js";
import { treeFile } from "../runtime/git-files.js";
import { canonical, digest } from "../canonical.js";
import { requireCondition } from "../errors.js";
import type { Boundary } from "../graph/model.js";
import { requireGates } from "../execution/commit.js";

export interface WriterProof { ref: Ref; node: string; path: string; boundary: Boundary; commit: string; tree: string; hash: string | null }

/** Ownership is a projection of immutable accepted runs, not a second mutable truth. */
export class Owners {
  private readonly writers: { run: Ref; value: TaskRun; task: CompiledTask }[] = [];
  private ancestors: Set<string> | null = null;
  private readonly cache = new Map<string, WriterProof | null>();
  constructor(private readonly store: Store, project: string, private readonly repository: Pick<RepositoryState, "root" | "head">) {
    for (const run of store.list<TaskRun>("task-run")) {
      if (run.value.projectId !== project || run.value.state !== "committed") continue;
      this.ancestors ??= new Set(git(repository.root, ["rev-list", repository.head]).split("\n"));
      if (!run.value.commit || !this.ancestors.has(run.value.commit)) continue;
      const plan = store.get<MachinePlan>(run.value.plan.id, run.value.plan.revision);
      requireCondition(plan?.kind === "plan" && plan.hash === run.value.plan.hash && plan.value.projectId === project,
        "ownership_proof_foreign", "An accepted writer has no matching plan");
      const task = plan.value.tasks.find(task => task.id === run.value.taskId);
      requireCondition(task, "ownership_proof_foreign", "An accepted writer has no matching task");
      this.writers.push({ run: reference(run), value: run.value, task });
    }
  }
  latest(path: string): WriterProof | null {
    if (this.cache.has(path)) return this.cache.get(path)!;
    const candidates = this.writers.filter(writer => writer.task.writePaths.includes(path));
    if (!candidates.length) { this.cache.set(path, null); return null; }
    this.ancestors ??= new Set(git(this.repository.root, ["rev-list", this.repository.head]).split("\n"));
    const accepted = candidates.filter(writer => writer.value.commit && this.ancestors!.has(writer.value.commit));
    if (!accepted.length) return null;
    let latest = accepted[0]!;
    for (const candidate of accepted.slice(1)) {
      if (candidate.value.commit === latest.value.commit) {
        requireCondition(canonical(candidate.run) === canonical(latest.run), "ownership_ambiguous", "Different accepted runs claim the same write commit"); continue;
      }
      try { git(this.repository.root, ["merge-base", "--is-ancestor", latest.value.commit!, candidate.value.commit!]); latest = candidate; }
      catch { try { git(this.repository.root, ["merge-base", "--is-ancestor", candidate.value.commit!, latest.value.commit!]); }
        catch { requireCondition(false, "ownership_ambiguous", "Parallel writers need an accepted integration before ownership can transfer"); } }
    }
    requireCondition(latest.value.tree && git(this.repository.root, ["rev-parse", `${latest.value.commit}^{tree}`]) === latest.value.tree,
      "ownership_proof_foreign", "The accepted writer must bind its exact commit tree");
    const plan = this.store.get<MachinePlan>(latest.value.plan.id, latest.value.plan.revision)!;
    const environment = this.store.get<Environment>(plan.value.environment.id, plan.value.environment.revision);
    requireCondition(environment?.kind === "environment" && environment.hash === plan.value.environment.hash,
      "ownership_proof_foreign", "The accepted writer has no matching check environment");
    requireGates(latest.value, latest.task, environment.value, this.store);
    const bytes = treeFile(this.repository.root, latest.value.commit!, path);
    const current = treeFile(this.repository.root, this.repository.head, path);
    const hash = bytes === null ? null : digest(bytes);
    requireCondition(hash === (current === null ? null : digest(current)), "ownership_code_changed", "The file changed outside its accepted writer's result");
    const result = { ref: latest.run, node: latest.task.node, path, boundary: latest.task.boundary, commit: latest.value.commit!, tree: latest.value.tree, hash };
    this.cache.set(path, result); return result;
  }
}

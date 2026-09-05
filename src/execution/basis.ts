import { relative, isAbsolute } from "node:path";
import { Store } from "../storage/store.js";
import type { MachinePlan } from "../compiler/model.js";
import type { Ref } from "../pipeline/contracts.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { gitBytes, type ExecutionRoot } from "../runtime/environment.js";
import { digest } from "../canonical.js";
import { requireCondition } from "../errors.js";

// Executing a sealed plan changes its own code. Those changes are evaluated by the
// execution gates; they do not retroactively rewrite the repository facts used by R3.
export function currentBasis(store: Store, plan: MachinePlan, root: ExecutionRoot): Ref[] {
  const guards: Ref[] = [];
  for (const ref of plan.guards) {
    if (ref.id === `execution-root:${plan.projectId}`) continue; // Exact progress is checked against committed task parents.
    const current = store.get(ref.id);
    requireCondition(current && current.hash === ref.hash && current.revision === ref.revision,
      "plan_stale", `A sealed plan input changed: ${ref.id}`);
    if (current.kind === "source") {
      const source = current.value as unknown as Source;
      const path = source.origin.kind === "file" ? relative(root.path, source.origin.location) : null;
      const owned = path && path !== ".." && !path.startsWith("../") && !isAbsolute(path)
        && plan.tasks.some(task => task.writePaths.includes(path));
      if (owned) requireCondition(digest(gitBytes(root.path, ["show", `${plan.base.head}:${path}`])) === source.sha256,
        "plan_stale", "Repository evidence is not from the sealed execution base");
      else requireCondition(sourceIsCurrent(source), "plan_stale", "A source outside the planned changes is no longer current");
    }
    guards.push(ref);
  }
  return guards;
}

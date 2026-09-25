import { relative, isAbsolute } from "node:path";
import { Store, type Revision } from "../storage/store.js";
import type { MachinePlan } from "../compiler/model.js";
import { isRef, reference, uniqueRefs, type Ref } from "../pipeline/contracts.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { gitBytes, type ExecutionRoot } from "../runtime/environment.js";
import { canonical, digest } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { artifactProgress } from "./artifact-progress.js";
import type { TaskRun } from "./model.js";
import { readWriterIndex, writerIndexId, type WriterIndex } from "../ownership/writer-index.js";
import { readWriter } from "../ownership/owners.js";
import { readFeasibility } from "../om/feasibility.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

function omExecutionRoot(store: Store, record: Revision<MachinePlan>, root: ExecutionRoot): Revision<ExecutionRoot> {
  const plan = record.value;
  // Capture before the M8 proof, including its mutable right-boundary checks. The same revision protects admission.
  const captured = store.get<ExecutionRoot>(`execution-root:${plan.projectId}`);
  requireCondition(captured?.kind === "execution-root" && object(captured.value) && captured.value.projectId === plan.projectId
    && captured.value.state === "ready" && same(captured.value, root),
  "plan_stale", "The execution root changed before checking the sealed plan's progress");
  const feasibility = readFeasibility(store, { project: plan.projectId, record: plan.feasibility });
  if (!feasibility.ok) throw new EngineError(feasibility.refusal.code, feasibility.refusal.message, feasibility.refusal.at);
  requireCondition(plan.version === 2 && feasibility.value.value.producer.contract === "om-m8/v2",
    "plan_stale", "Own writer progress requires the proved M8/v2 producer");
  return captured;
}

/** Only additions by this exact plan may retire a writer-index guard; the entire previous chain is checked. */
function writerProgress(store: Store, plan: Revision<MachinePlan>, root: Revision<ExecutionRoot>,
  original: Ref, current: Revision): Ref[] {
  const project = plan.value.projectId, before = store.get<WriterIndex>(original.id, original.revision);
  requireCondition(before?.kind === "writer-index" && before.hash === original.hash && object(before.value)
    && before.value.project === project && typeof before.value.path === "string" && before.value.path.length > 0
    && original.id === writerIndexId(project, before.value.path) && current.revision > original.revision,
  "plan_stale", "Writer progress must extend this exact project's original path index");
  const path = before.value.path, currentRef = reference(current), planRef = reference(plan);
  // The common reader proves every selected commit-origin on its own root, with full writer gates.
  let cursor = readWriterIndex(store, project, path, currentRef, reference(root));
  const accepted: Ref[] = [];
  while (cursor.revision > original.revision) {
    requireCondition(cursor.value.origin.kind === "commit" && isRef(cursor.value.previous),
      "plan_stale", "Each writer-index extension needs its exact commit and previous index");
    const runRef = cursor.value.origin.run, run = store.get<TaskRun>(runRef.id, runRef.revision);
    const task = run && object(run.value) ? plan.value.tasks.find(item => item.id === run.value.taskId) : undefined;
    requireCondition(run?.kind === "task-run" && run.hash === runRef.hash && object(run.value) && run.value.state === "committed"
      && run.value.projectId === project && same(run.value.plan, planRef) && task?.writePaths.includes(path),
    "plan_stale", "Every intervening writer must be an accepted task of this exact plan and path");
    accepted.push(runRef);
    const previous = store.get<WriterIndex>(cursor.value.previous.id, cursor.value.previous.revision);
    requireCondition(previous && same(reference(previous), cursor.value.previous),
      "plan_stale", "The writer-index chain must preserve every exact previous revision");
    cursor = previous;
  }
  requireCondition(same(reference(cursor), original), "plan_stale", "Writer progress must reach the sealed original index");
  // The last path writer must also belong to the captured execution slice; older writers were checked at their own roots.
  readWriter(store, project, { root: root.value.path, head: root.value.head }, accepted[0]!, path);
  return [currentRef, ...accepted];
}

// Executing a sealed plan changes its own code. Those changes are evaluated by the
// execution gates; they do not retroactively rewrite the repository facts used by R3.
export function currentBasis(store: Store, record: Revision<MachinePlan>, root: ExecutionRoot): Ref[] {
  const plan = record.value;
  const execution = plan.feasibility.id.startsWith("om-feasibility:") ? omExecutionRoot(store, record, root) : null;
  const guards: Ref[] = execution ? [reference(execution)] : [];
  for (const ref of plan.guards) {
    if (ref.id === `execution-root:${plan.projectId}`) continue; // Exact progress is checked against committed task parents.
    const current = store.get(ref.id);
    if (current && (current.hash !== ref.hash || current.revision !== ref.revision)) {
      if (execution && current.kind === "writer-index") {
        guards.push(...writerProgress(store, record, execution, ref, current)); continue;
      }
      const accepted = artifactProgress(store, record, root, ref, current);
      if (accepted) { guards.push(...accepted); continue; }
    }
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
  return uniqueRefs(guards);
}

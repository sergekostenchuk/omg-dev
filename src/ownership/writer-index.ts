import { canonical, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import type { CompiledTask, MachinePlan } from "../compiler/model.js";
import type { TaskRun } from "../execution/model.js";
import { isRef, reference, uniqueRefs, type Ref } from "../pipeline/contracts.js";
import { git, type ExecutionRoot } from "../runtime/environment.js";
import type { Revision, Store, Write } from "../storage/store.js";
import { readWriter } from "./owners.js";

export interface WriterIndex {
  contract: "writer-index/v1" | "writer-index/om-m8-v1";
  project: string;
  path: string;
  writers: Ref[];
  previous: Ref | null;
  root: Ref | null;
  origin: { kind: "bootstrap" } | { kind: "commit"; run: Ref };
}
export interface PendingWriter { ref: Ref; run: TaskRun; task: CompiledTask; root: Revision<ExecutionRoot> }
export interface WriterIndexPreparation { record: Revision<WriterIndex>; writes: Write[]; guards: Ref[] }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
export function writerIndexId(project: string, path: string): string {
  address(project, path);
  return `writer-index:${hashJson({ project, path })}`;
}
function invalid(project: string, path: string, field: string, code = "writer_index_invalid"): never {
  throw new EngineError(code, "Writer ownership needs a complete, exact path index for its repository slice", { project, target: path, field });
}
function address(project: string, path: string): void {
  if (!text(project) || !text(path)) invalid(project, path, "address");
}
function source(store: Store, project: string, path: string): void {
  if (!store || typeof store.get !== "function" || typeof store.list !== "function") invalid(project, path, "store");
  address(project, path);
}
function rootAt(store: Store, project: string, path: string, ref: Ref | null): Revision<ExecutionRoot> | null {
  if (ref === null) return null;
  if (!isRef(ref) || ref.id !== `execution-root:${project}`) invalid(project, path, "root");
  const record = store.get<ExecutionRoot>(ref.id, ref.revision);
  if (!record || record.kind !== "execution-root" || record.hash !== ref.hash || !object(record.value)
    || record.value.projectId !== project || record.value.state !== "ready" || !text(record.value.path)
    || !text(record.value.sourceRoot) || !text(record.value.branch) || !text(record.value.base)
    || !text(record.value.head) || !isRef(record.value.workspace)) invalid(project, path, "root");
  return record;
}
function writerSource(store: Store, project: string, path: string, ref: Ref): { record: Revision<TaskRun>; task: CompiledTask; plan: Revision<MachinePlan> } {
  const record = store.get<TaskRun>(ref.id, ref.revision);
  if (!record || record.kind !== "task-run" || record.hash !== ref.hash || !object(record.value)
    || record.value.projectId !== project || record.value.state !== "committed" || !text(record.value.commit)
    || !text(record.value.tree) || !isRef(record.value.plan) || !text(record.value.taskId)) invalid(project, path, "writers.run");
  const plan = store.get<MachinePlan>(record.value.plan.id, record.value.plan.revision);
  if (!plan || plan.kind !== "plan" || plan.hash !== record.value.plan.hash || !object(plan.value)
    || plan.value.projectId !== project || !Array.isArray(plan.value.tasks)) invalid(project, path, "writers.plan");
  const task = plan.value.tasks.find(item => object(item) && item.id === record.value.taskId);
  if (!task || !Array.isArray(task.writePaths) || !task.writePaths.every(text)) invalid(project, path, "writers.task");
  return { record, task, plan };
}
/** The exact plan's namespace chooses the era; a missing index marker cannot downgrade an OM writer. */
function writerContract(store: Store, project: string, path: string, ref: Ref): WriterIndex["contract"] {
  const { plan } = writerSource(store, project, path, ref);
  const feasibility: unknown = plan.value.feasibility;
  if (object(feasibility) && text(feasibility.id) && feasibility.id.startsWith("om-feasibility:")) {
    if (plan.value.version !== 2 || !isRef(feasibility) || feasibility.id !== `om-feasibility:${project}`)
      invalid(project, path, "index.contract");
    return "writer-index/om-m8-v1";
  }
  return "writer-index/v1";
}
function committedTransition(store: Store, project: string, path: string, ref: Ref): Revision<TaskRun> {
  const { record, task } = writerSource(store, project, path, ref);
  const previous = store.get<TaskRun>(ref.id, ref.revision - 1);
  if (!previous || previous.kind !== "task-run" || !object(previous.value) || previous.value.state !== "commit_pending"
    || !same({ ...previous.value, state: "committed", child: null, updatedAt: record.value.updatedAt }, record.value)
    || !task.writePaths.includes(path)) invalid(project, path, "origin.run");
  return record;
}
/** The date is the root transition of this exact accepted run, not an author-supplied later checkpoint. */
function commitOrigin(store: Store, project: string, path: string, root: Revision<ExecutionRoot> | null, runRef: Ref, repository?: string,
  boundaryOnly = false): void {
  if (!root || root.revision < 2) invalid(project, path, "origin.root");
  const run = committedTransition(store, project, path, runRef);
  const previous = store.get<ExecutionRoot>(root.id, root.revision - 1);
  if (!previous) invalid(project, path, "origin.previousRoot");
  rootAt(store, project, path, reference(previous));
  if (previous.value.head !== run.value.parent || root.value.head !== run.value.commit
    || !same({ ...previous.value, head: run.value.commit }, root.value)) invalid(project, path, "origin.root");
  const directory = repository ?? root.value.sourceRoot;
  // A future OM writer dates the interval, but its gate depends on the very M8 slice being read.
  // The selected index still uses the full common writer proof; a boundary proves only the transition.
  if (boundaryOnly) {
    if (git(directory, ["rev-parse", `${run.value.commit}^{tree}`]) !== run.value.tree) invalid(project, path, "origin.tree");
  } else readWriter(store, project, { root: directory, head: root.value.head }, runRef, path);
  if (git(directory, ["rev-list", "--parents", "-n", "1", run.value.commit!]) !== `${run.value.commit} ${run.value.parent}`)
    invalid(project, path, "origin.parent");
}
function checked(store: Store, project: string, path: string, record: Revision<WriterIndex>,
  checkedWriters = new Set<string>(), repository?: string, checkedIndexes = new Set<string>(), boundaryOnly = false): Revision<WriterIndex> {
  const key = canonical(reference(record));
  if (!boundaryOnly && checkedIndexes.has(key)) return record;
  const value = record.value;
  if (record.id !== writerIndexId(project, path) || record.kind !== "writer-index" || !isRef(record)
    || !object(value) || Object.keys(value).length !== 7 || !["writer-index/v1", "writer-index/om-m8-v1"].includes(value.contract)
    || value.project !== project || value.path !== path || !Array.isArray(value.writers) || !value.writers.every(isRef)
    || !same(uniqueRefs(value.writers), value.writers) || hashJson(value) !== record.hash
    || !(value.previous === null || isRef(value.previous)) || !(value.root === null || isRef(value.root))
    || !object(value.origin) || !(value.origin.kind === "bootstrap" && Object.keys(value.origin).length === 1
      || value.origin.kind === "commit" && Object.keys(value.origin).length === 2 && isRef(value.origin.run))) invalid(project, path, "index");
  const contract = value.origin.kind === "commit" ? writerContract(store, project, path, value.origin.run) : "writer-index/v1";
  if (value.contract !== contract || boundaryOnly && contract !== "writer-index/om-m8-v1") invalid(project, path, "index.contract");
  const root = rootAt(store, project, path, value.root);
  let previous: Revision<WriterIndex> | null = null;
  if (record.revision === 1) {
    if (value.previous !== null) invalid(project, path, "previous");
  } else {
    const ref = value.previous;
    if (!ref || ref.id !== record.id || ref.revision !== record.revision - 1) invalid(project, path, "previous");
    previous = store.get<WriterIndex>(ref.id, ref.revision);
    if (!previous || previous.hash !== ref.hash) invalid(project, path, "previous");
    checked(store, project, path, previous, checkedWriters, repository, checkedIndexes);
    if (value.origin.kind !== "commit" || !root || root.revision <= (previous.value.root?.revision ?? 0)
      || value.writers.length !== previous.value.writers.length + 1
      || previous.value.writers.some(ref => !value.writers.some(item => same(item, ref)))
      || previous.value.writers.some(ref => same(ref, value.origin.kind === "commit" ? value.origin.run : null)))
      invalid(project, path, "writers.history");
  }
  if (!root && (record.revision !== 1 || value.writers.length !== 0 || value.origin.kind !== "bootstrap")) invalid(project, path, "root");
  if (value.origin.kind === "commit") {
    if (!value.writers.some(ref => same(ref, value.origin.kind === "commit" ? value.origin.run : null))) invalid(project, path, "origin.run");
    commitOrigin(store, project, path, root, value.origin.run, repository, boundaryOnly);
  }
  for (const ref of value.writers) {
    const key = canonical(ref);
    if (checkedWriters.has(key)) continue;
    if (!writerSource(store, project, path, ref).task.writePaths.includes(path)) invalid(project, path, "writers.path");
    if (value.origin.kind === "bootstrap" && writerContract(store, project, path, ref) !== "writer-index/v1")
      invalid(project, path, "index.contract");
    checkedWriters.add(key);
  }
  if (!boundaryOnly) checkedIndexes.add(key);
  return record;
}
function interval(store: Store, project: string, path: string, record: Revision<WriterIndex>, root: Ref | null): Revision<WriterIndex> {
  const repository = rootAt(store, project, path, root)?.value.path;
  const writers = new Set<string>(), indexes = new Set<string>();
  checked(store, project, path, record, writers, repository, indexes);
  if ((record.value.root?.revision ?? 0) > (root?.revision ?? 0)) invalid(project, path, "root.interval");
  const next = store.get<WriterIndex>(record.id, record.revision + 1);
  if (next) {
    checked(store, project, path, next, writers, repository, indexes, next.value?.contract === "writer-index/om-m8-v1");
    if (!same(next.value.previous, reference(record)) || (next.value.root?.revision ?? 0) <= (root?.revision ?? 0))
      invalid(project, path, "root.interval");
  }
  return record;
}

/** History checks only the selected exact index and its immediate right boundary, never today's heads. */
export function readWriterIndex(store: Store, project: string, path: string, ref: Ref, root: Ref | null): Revision<WriterIndex> {
  source(store, project, path);
  if (!isRef(ref) || ref.id !== writerIndexId(project, path)) invalid(project, path, "index");
  const record = store.get<WriterIndex>(ref.id, ref.revision);
  if (!record || record.hash !== ref.hash) invalid(project, path, "index");
  return interval(store, project, path, record, root);
}
function pendingView(store: Store, pending: PendingWriter): Store {
  return new Proxy(store, { get(target, property) {
    if (property === "get") return (id: string, revision?: number) => {
      if (id === pending.ref.id && revision === pending.ref.revision)
        return { id, kind: "task-run", revision, hash: pending.ref.hash, value: pending.run };
      if (id === pending.root.id && revision === pending.root.revision) return pending.root;
      return target.get(id, revision);
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** Bootstrap uses the full current source and captured root; only finishCommit can extend an existing index. */
export function prepareWriterIndex(store: Store, project: string, path: string, root: Ref | null, pending?: PendingWriter): WriterIndexPreparation {
  source(store, project, path);
  const currentRoot = store.get<ExecutionRoot>(`execution-root:${project}`);
  if (!(root === null || isRef(root)) || !same(currentRoot ? reference(currentRoot) : null, root)) invalid(project, path, "root.current");
  const before = rootAt(store, project, path, root);
  let view = store;
  if (pending !== undefined) {
    if (!object(pending) || !isRef(pending.ref) || !object(pending.run) || !object(pending.task) || !object(pending.root)
      || !isRef(pending.root) || !before || pending.root.id !== before.id || pending.root.kind !== before.kind
      || pending.root.revision !== before.revision + 1 || !object(pending.root.value)
      || hashJson(pending.root.value) !== pending.root.hash || hashJson(pending.run) !== pending.ref.hash
      || before.value.head !== pending.run.parent
      || !same({ ...before.value, head: pending.run.commit }, pending.root.value)) invalid(project, path, "pending.writer");
    view = pendingView(store, pending);
    if (!same(writerSource(view, project, path, pending.ref).task, pending.task)) invalid(project, path, "pending.task");
    committedTransition(view, project, path, pending.ref);
  }
  const head = store.get<WriterIndex>(writerIndexId(project, path));
  const old = head ? interval(store, project, path, head, root) : null;
  const current: Ref[] = [];
  for (const record of store.list<TaskRun>("task-run")) {
    if (!object(record.value) || record.value.projectId !== project || record.value.state !== "committed") continue;
    const ref = reference(record);
    if (writerSource(store, project, path, ref).task.writePaths.includes(path)) current.push(ref);
  }
  if (!before && current.length) invalid(project, path, "root");
  if (old && current.some(ref => !old.value.writers.some(item => same(item, ref)))) invalid(project, path, "writers", "writer_index_incomplete");
  const writers = uniqueRefs([...(old?.value.writers ?? current), ...(pending ? [pending.ref] : [])]);
  const guards = uniqueRefs([...(root ? [root] : []), ...(old ? [reference(old)] : []), ...current]);
  if (old && same(old.value.writers, writers)) return { record: old, writes: [], guards };
  const value: WriterIndex = { contract: pending ? writerContract(view, project, path, pending.ref) : "writer-index/v1",
    project, path, writers, previous: old ? reference(old) : null,
    root: pending ? reference(pending.root) : root, origin: pending ? { kind: "commit", run: pending.ref } : { kind: "bootstrap" } };
  const write: Write = { id: writerIndexId(project, path), kind: "writer-index", expected: old?.revision ?? 0, value };
  const record = checked(view, project, path, { id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(value), value }, new Set<string>(), pending?.root.value.path ?? before?.value.path);
  return { record, writes: [write], guards };
}

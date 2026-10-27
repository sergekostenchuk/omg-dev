import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionFixture } from "./execution-fixture.js";
import { canonical, digest, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { checkedPlanDerivation, type CompiledTask, type MachinePlan } from "../src/compiler/model.js";
import type { TaskRun } from "../src/execution/model.js";
import { readWriter, selectWriter } from "../src/ownership/owners.js";
import { readWriterIndex, writerIndexId, type WriterIndex } from "../src/ownership/writer-index.js";
import { isRef, reference, uniqueRefs, type Ref } from "../src/pipeline/contracts.js";
import { git, gitBytes, gitIsAncestor, type ExecutionRoot } from "../src/runtime/environment.js";
import { treeFile } from "../src/runtime/git-files.js";
import { Store, type Revision } from "../src/storage/store.js";

/*
 * OMG-NATIVE-WRITERS-HOTSPOT-SPEED. The native-writers scenario (test/ownership.test.ts) spends its time re-proving the same accepted
 * writers: (1) one writer-index pass read a writer's run/plan/task three times, (2) every proof of the head writer asked Git
 * whether a commit is an ancestor of itself. Both are removed without changing what is proved; this file pins what stays.
 */

const children = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
/** The git processes started while the test runs (the arguments after the common `--literal-pathspecs -c core.hooksPath=` prefix). */
function spawnLog(t: TestContext) {
  const original = children.spawnSync, calls: string[][] = [];
  children.spawnSync = ((...args: unknown[]) => {
    if (args[0] === "git" && Array.isArray(args[1])) calls.push([...args[1] as string[]].slice(3));
    return Reflect.apply(original, children, args);
  }) as typeof original;
  syncBuiltinESMExports(); t.after(() => { children.spawnSync = original; syncBuiltinESMExports(); });
  return { calls, count(args: string[], from = 0) { return calls.slice(from).filter(row => JSON.stringify(row) === JSON.stringify(args)).length; } };
}
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// ---- The previous writer-index pass, verbatim (before the pass-local memo of exact writers). ----
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
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
  checkedPlanDerivation(plan, project);
  const task = plan.value.tasks.find(item => object(item) && item.id === record.value.taskId);
  if (!task || !Array.isArray(task.writePaths) || !task.writePaths.every(text)) invalid(project, path, "writers.task");
  return { record, task, plan };
}
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
  if (boundaryOnly) {
    if (git(directory, ["rev-parse", `${run.value.commit}^{tree}`]) !== run.value.tree) invalid(project, path, "origin.tree");
  } else readWriter(store, project, { root: directory, head: root.value.head }, runRef, path);
  const oid = run.value.commit!;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) invalid(project, path, "origin.parent");
  const bytes = gitBytes(directory, ["cat-file", "--batch"], Buffer.from(oid + "\n"));
  const line = bytes.indexOf(10), header = bytes.subarray(0, line).toString("utf8").split(" "), size = Number(header[2]);
  if (line < 0 || header.length !== 3 || header[0] !== oid || header[1] !== "commit" || !Number.isSafeInteger(size) || size < 0
    || bytes.length !== line + 1 + size + 1 || bytes.at(-1) !== 10) invalid(project, path, "origin.parent");
  const body = bytes.subarray(line + 1, line + 1 + size), separator = body.indexOf("\n\n");
  if (separator < 0) invalid(project, path, "origin.parent");
  const fields = body.subarray(0, separator).toString("utf8").split("\n");
  const parents = fields.filter(field => field.startsWith("parent ")).map(field => field.slice(7));
  if (fields[0] !== `tree ${run.value.tree}` || parents.length !== 1 || parents[0] !== run.value.parent)
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
function legacyReadWriterIndex(store: Store, project: string, path: string, ref: Ref, root: Ref | null): Revision<WriterIndex> {
  source(store, project, path);
  if (!isRef(ref) || ref.id !== writerIndexId(project, path)) invalid(project, path, "index");
  const record = store.get<WriterIndex>(ref.id, ref.revision);
  if (!record || record.hash !== ref.hash) invalid(project, path, "index");
  return interval(store, project, path, record, root);
}
/** The previous reachability rule of an accepted writer, verbatim: an ancestor query, then the exact-commit identity read. */
function legacyReachable(repository: { root: string; head: string }, commit: string): boolean {
  if (!OID.test(commit)) return false;
  if (!gitIsAncestor(repository.root, commit, repository.head)) return false;
  return git(repository.root, ["rev-list", "--parents", "-n", "1", commit]).split(" ")[0] === commit;
}

// ---- Outcomes, compared by what a caller can observe. ----
type Outcome = { ok: unknown } | { refused: string; field?: string; action?: string };
function outcome(action: () => unknown): Outcome {
  try { return { ok: action() }; } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    const details = (error.details ?? {}) as { field?: string; action?: string };
    return { refused: error.code, ...(details.field === undefined ? {} : { field: details.field }), ...(details.action === undefined ? {} : { action: details.action }) };
  }
}
/** How often the task-run and plan records `ids` are read through Store.get while the action runs. */
function countReads(ids: ReadonlySet<string>, action: () => unknown): number {
  const { get } = Store.prototype;
  let reads = 0;
  Store.prototype.get = function (this: Store, id: string, revision?: number) { if (ids.has(id)) reads++; return get.call(this, id, revision); } as typeof Store.prototype.get;
  try { action(); } finally { Store.prototype.get = get; }
  return reads;
}
function copyOf(from: Store, t: TestContext): { path: string; store: Store } {
  const directory = mkdtempSync(join(tmpdir(), "omg-nwh-copy-")), path = join(directory, "state.sqlite");
  const origin = new DatabaseSync(from.path, { readOnly: true });
  try { origin.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); } finally { origin.close(); }
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, store };
}
function rawRewrite(database: string, id: string, revision: number, value: unknown): void {
  const raw = new DatabaseSync(database);
  try {
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?").run(canonical(value), hashJson(value), id, revision);
  } finally { raw.close(); }
}

test("native writers: the exact-commit proof of the head writer and the single read of each writer in a pass keep every outcome", async t => {
  const f = executionFixture(t, "normal", { route: "om" });
  const runs = await f.engine.executor.run("p", reference(f.plan), f.options);
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"], JSON.stringify(runs.map(run => run.value.error)));
  const [writer, later] = runs as [Revision<TaskRun>, Revision<TaskRun>], path = "produce.mjs", ref = reference(writer);
  const root = f.store.get<ExecutionRoot>("execution-root:p")!.value;
  const commit = writer.value.commit!, head = later.value.commit!;
  const repositoryAt = (at: string) => ({ root: root.path, head: at });
  const cold = () => git(root.path, ["update-ref", "refs/nwh/cold", head]); // a non-memo command: the next Git read asks Git
  const forged = (over: Partial<TaskRun>): Ref => reference(f.store.write({ id: `task-run:nwh-forged-${Math.random().toString(16).slice(2)}`,
    kind: "task-run", expected: 0, value: { ...writer.value, ...over } }));
  assert.ok(OID.test(commit) && OID.test(head) && commit !== head && gitIsAncestor(root.path, commit, head));

  await t.test("the head writer: an equal head asks no ancestor query yet still reads the exact commit; an unequal head asks one", sub => {
    const expected = readWriter(f.store, "p", repositoryAt(commit), ref, path), task = f.plan.value.tasks.find(item => item.id === writer.value.taskId)!;
    assert.deepEqual(expected, { ref, node: task.node, path, boundary: task.boundary, commit, tree: writer.value.tree!, hash: digest(treeFile(root.path, commit, path)!) },
      "the exact run, node, boundary, commit, tree and the hash of the file in the writer's commit");
    const log = spawnLog(sub);
    cold();
    const equal = readWriter(f.store, "p", repositoryAt(commit), ref, path);
    assert.deepEqual(equal, expected, "the same proof, byte for byte");
    (equal as { tree: string }).tree = "mutated by the caller";
    assert.deepEqual(readWriter(f.store, "p", repositoryAt(commit), ref, path), expected, "a proof handed out is the caller's own: changing it changes nothing later");
    assert.equal(log.count(["merge-base", "--is-ancestor", commit, commit]), 0, "a commit is not asked whether it is its own ancestor");
    assert.equal(log.count(["rev-list", "--parents", "-n", "1", commit]), 1, "the exact commit is read before the proof is returned");
    cold();
    const unequal = readWriter(f.store, "p", repositoryAt(head), ref, path);
    assert.deepEqual(unequal, expected, "the slice head does not change what is proved about the writer");
    assert.equal(log.count(["merge-base", "--is-ancestor", commit, head]), 1, "an unequal head keeps its single ancestor query");
    // A symbolic head is never turned into an OID to find an equality: it takes the ordinary path with its own spelling.
    assert.equal(git(root.path, ["rev-parse", "HEAD"]), head, "HEAD of the execution root is the later commit");
    cold(); const symbolic = log.calls.length;
    assert.deepEqual(readWriter(f.store, "p", repositoryAt("HEAD"), ref, path), expected, "the same proof for a symbolic head");
    assert.equal(log.count(["merge-base", "--is-ancestor", commit, "HEAD"], symbolic), 1, "the ancestor query is asked with the head as given");
    assert.equal(log.count(["rev-parse", "HEAD"], symbolic), 0, "no rev-parse of the head to find an equality");
    // The previous rule asked both for the equal head: this is the process the change removes.
    cold(); const before = log.count(["merge-base", "--is-ancestor", commit, commit]);
    assert.equal(legacyReachable(repositoryAt(commit), commit), true);
    assert.equal(log.count(["merge-base", "--is-ancestor", commit, commit]) - before, 1, "the previous rule's self query");
    assert.deepEqual(selectWriter(f.store, "p", repositoryAt(commit), [ref], path), expected, "selection shares the rule");
  });

  await t.test("equal and unequal heads that are not a proved commit: tag, tree, blob and missing never become success", sub => {
    const tag = (() => { git(root.path, ["-c", "user.name=NWH", "-c", "user.email=nwh@example.invalid", "tag", "-a", "-m", "nwh", "nwh-tag", commit]); return git(root.path, ["rev-parse", "nwh-tag"]); })();
    const tree = git(root.path, ["rev-parse", `${commit}^{tree}`]), blob = git(root.path, ["rev-parse", `${commit}:${path}`]), missing = "0123456789".repeat(4);
    const rows: { name: string; oid: string; refused: string; action: string }[] = [
      { name: "annotated tag", oid: tag, refused: "ownership_proof_foreign", action: "" },
      { name: "tree", oid: tree, refused: "git_failed", action: "merge-base" },
      { name: "blob", oid: blob, refused: "git_failed", action: "merge-base" },
      { name: "missing object", oid: missing, refused: "git_failed", action: "rev-list" },
    ];
    const log = spawnLog(sub);
    for (const row of rows) {
      assert.ok(OID.test(row.oid), row.name);
      cold(); const mark = log.calls.length;
      const result = outcome(() => readWriter(f.store, "p", repositoryAt(row.oid), forged({ commit: row.oid }), path));
      const asked = log.count(["merge-base", "--is-ancestor", row.oid, row.oid], mark); // before the previous rule runs its own query below
      assert.ok(!("ok" in result), `${row.name}: an equal head that is not an exact commit is never accepted`);
      assert.equal((result as { refused: string }).refused, row.refused, row.name);
      if (row.action) assert.equal((result as { action?: string }).action, row.action, `${row.name}: the command that failed`);
      const previous = outcome(() => legacyReachable(repositoryAt(row.oid), row.oid));
      // The previous rule: a tag is refused as a non-commit, a tree or blob fails in merge-base; a missing object fails in merge-base
      // where the identity read now fails first (the one disclosed difference: details.action).
      if (row.name === "annotated tag") assert.deepEqual(previous, { ok: false });
      else assert.deepEqual(previous, { refused: "git_failed", action: "merge-base" }, `${row.name}: the previous rule`);
      assert.equal(asked > 0, row.name !== "missing object",
        `${row.name}: the ordinary ancestor query is kept except where the exact-commit read already failed`);
    }
    // Unequal heads: the order and the answer of the ancestor query are those of the previous rule.
    cold(); const mark = log.calls.length;
    const unreachable = outcome(() => readWriter(f.store, "p", repositoryAt(f.initial), ref, path));
    assert.deepEqual(unreachable, { refused: "ownership_proof_foreign" });
    assert.equal(log.count(["merge-base", "--is-ancestor", commit, f.initial], mark), 1);
    assert.equal(log.count(["rev-list", "--parents", "-n", "1", commit], mark), 0, "an unreachable commit is refused by the ancestor query alone");
    assert.deepEqual(outcome(() => selectWriter(f.store, "p", repositoryAt("f".repeat(40)), [ref], path)), { refused: "git_failed", action: "merge-base" });
  });

  await t.test("a changed Git context is read again: a removed object and a replacement do not reuse an earlier success", () => {
    const object = join(git(root.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "objects", commit.slice(0, 2), commit.slice(2));
    const proves = () => "ok" in outcome(() => readWriter(f.store, "p", repositoryAt(commit), ref, path));
    assert.ok(proves(), "the writer is proved before the context changes");
    const bytes = readFileSync(object);
    rmSync(object);
    try {
      cold();
      const removed = outcome(() => readWriter(f.store, "p", repositoryAt(commit), ref, path));
      assert.ok(!("ok" in removed), "a success is not remembered across a removed commit object");
      assert.equal((removed as { refused: string }).refused, "git_failed");
    } finally { writeFileSync(object, bytes); }
    const other = git(root.path, ["-c", "user.name=NWH", "-c", "user.email=nwh@example.invalid", "commit-tree", writer.value.tree!, "-p", head, "-m", "replacement"]);
    git(root.path, ["replace", commit, other]);
    try {
      cold();
      const now = outcome(() => readWriter(f.store, "p", repositoryAt(commit), ref, path)), previous = outcome(() => legacyReachable(repositoryAt(commit), commit));
      // Whatever Git says under the replacement, the writer is accepted only where the previous rule reaches its commit.
      if ("ok" in now) assert.deepEqual(previous, { ok: true }, "no acceptance beyond the previous rule");
    } finally { git(root.path, ["replace", "-d", commit]); }
    cold();
    assert.ok(proves(), "the restored world proves the writer again");
  });

  await t.test("a writer-index pass equals the previous pass in every result and refusal and reads each exact writer once", sub => {
    const ids = new Set<string>([...runs.map(run => run.id), f.plan.id]);
    let saved = 0, previousTotal = 0, nowTotal = 0, passes = 0;
    for (const indexPath of ["produce.mjs", "consume.mjs"]) {
      const id = writerIndexId("p", indexPath), last = f.store.get<WriterIndex>(id)!;
      assert.ok(last.revision >= 2, `${indexPath}: the world has an accepted-writer index revision`);
      for (let revision = 1; revision <= last.revision; revision++) {
        const index = f.store.get<WriterIndex>(id, revision)!;
        const roots: (Ref | null)[] = [index.value.root, reference(f.store.get<ExecutionRoot>("execution-root:p")!)];
        for (const at of roots) {
          const run = () => readWriterIndex(f.store, "p", indexPath, reference(index), at), before = () => legacyReadWriterIndex(f.store, "p", indexPath, reference(index), at);
          const now = outcome(run), previous = outcome(before);
          assert.deepEqual(now, previous, `${indexPath}@${revision} against ${at === null ? "no root" : `root@${at.revision}`}`);
          if (!("ok" in now)) continue;
          // k commit-origin revisions are walked by the pass: each used to read its writer three times and now reads it once.
          const origins = Array.from({ length: revision }, (_, i) => f.store.get<WriterIndex>(id, i + 1)!).filter(item => item.value.origin.kind === "commit").length;
          const boundary = f.store.get<WriterIndex>(id, revision + 1) ? 1 : 0;
          const reads = { now: countReads(ids, run), previous: countReads(ids, before) };
          assert.equal(reads.previous - reads.now, 4 * (origins + boundary), `${indexPath}@${revision}: two reads of two records saved per walked revision`);
          saved += reads.previous - reads.now; previousTotal += reads.previous; nowTotal += reads.now; passes++;
        }
      }
    }
    assert.ok(saved > 0, "the world walks at least one commit-origin revision");
    sub.diagnostic(`task-run and plan reads over ${passes} passes: previous pass ${previousTotal}, this pass ${nowTotal} (${saved} fewer)`);
  });

  await t.test("a pass keeps nothing: edited run, plan and origin transition are refused as before, on a fresh handle after a success", () => {
    const run0 = f.store.get<TaskRun>(writer.id, writer.revision)!, plan0 = f.store.get<MachinePlan>(f.plan.id, f.plan.revision)!;
    const id = writerIndexId("p", path), last = f.store.get<WriterIndex>(id)!;
    const cases: { name: string; edit(database: string): void }[] = [
      { name: "the run body", edit: database => rawRewrite(database, writer.id, writer.revision, { ...run0.value, state: "commit_pending" }) },
      { name: "the plan body", edit: database => rawRewrite(database, f.plan.id, f.plan.revision, { ...plan0.value, tasks: [] }) },
      { name: "the origin transition", edit: database => rawRewrite(database, writer.id, writer.revision - 1, { ...f.store.get<TaskRun>(writer.id, writer.revision - 1)!.value, parent: "f".repeat(40) }) },
    ];
    for (const row of cases) {
      const copy = copyOf(f.store, t);
      const warm = outcome(() => readWriterIndex(copy.store, "p", path, reference(last), reference(f.store.get<ExecutionRoot>("execution-root:p")!)));
      assert.ok("ok" in warm, `${row.name}: the copy proves the writers before the edit`);
      row.edit(copy.path);
      const fresh = new Store(copy.path);
      try {
        const edited = (store: Store) => ({ now: outcome(() => readWriterIndex(store, "p", path, reference(last), reference(f.store.get<ExecutionRoot>("execution-root:p")!))),
          previous: outcome(() => legacyReadWriterIndex(store, "p", path, reference(last), reference(f.store.get<ExecutionRoot>("execution-root:p")!))) });
        const result = edited(fresh);
        assert.ok(!("ok" in result.now), `${row.name}: refused`);
        assert.deepEqual(result.now, result.previous, `${row.name}: the same refusal as the previous pass`);
      } finally { fresh.close(); }
    }
  });
});

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitBytes, gitCalls, gitIsAncestor, type ExecutionRoot } from '../src/runtime/environment.js';
import { treeFile } from '../src/runtime/git-files.js';
import { capture } from '../src/execution/candidate.js';
import { Owners, readWriter, selectWriter } from '../src/ownership/owners.js';
import { readWriterIndex, writerIndexId, type WriterIndex } from '../src/ownership/writer-index.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import type { CompiledTask } from '../src/compiler/model.js';
import { executionFixture } from './execution-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';
import { requireGraph } from '../src/graph/validate.js';

const children = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function privateConfiguration(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-gitsrc4-')));
  const home = process.env['HOME'], xdg = process.env['XDG_CONFIG_HOME'];
  process.env['HOME'] = root; process.env['XDG_CONFIG_HOME'] = join(root, 'xdg');
  t.after(() => {
    if (home === undefined) delete process.env['HOME']; else process.env['HOME'] = home;
    if (xdg === undefined) delete process.env['XDG_CONFIG_HOME']; else process.env['XDG_CONFIG_HOME'] = xdg;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function raw(root: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=GITSRC4', '-c', 'user.email=gitsrc4@example.invalid', ...args],
  { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function fixture(t: TestContext) {
  const directory = privateConfiguration(t), root = join(directory, 'repo'); mkdirSync(root);
  raw(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'a.txt'), 'one\n'); writeFileSync(join(root, 'same.txt'), 'one\n');
  mkdirSync(join(root, 'dir')); writeFileSync(join(root, 'dir/file'), 'nested\n');
  symlinkSync('a.txt', join(root, 'link'));
  const commit = () => { raw(root, ['add', '--all']); raw(root, ['commit', '-qm', 'fixture']); return raw(root, ['rev-parse', 'HEAD']); };
  const head = commit(), tree = raw(root, ['rev-parse', `${head}^{tree}`]);
  return { directory, root, head, tree, commit };
}
function trace(t: TestContext) {
  const original = children.spawnSync, calls: string[][] = [];
  type Result = ReturnType<typeof children.spawnSync>;
  let after: ((args: string[]) => void) | undefined;
  let replace: ((args: string[], result: Result) => Result) | undefined;
  children.spawnSync = ((...args: unknown[]) => {
    const argv = args[0] === 'git' && Array.isArray(args[1]) ? [...args[1] as string[]].slice(3) : null;
    const result = Reflect.apply(original, children, args) as Result;
    if (argv) {
      calls.push(argv);
      const path = process.env['GITSRC4_TRACE'];
      if (path) appendFileSync(path, JSON.stringify({ test: t.name, args: argv }) + '\n');
      after?.(argv);
      return replace?.(argv, result) ?? result;
    }
    return result;
  }) as typeof original;
  syncBuiltinESMExports(); t.after(() => { children.spawnSync = original; syncBuiltinESMExports(); });
  return { calls, after(fn: (args: string[]) => void) { after = fn; },
    replace(fn: (args: string[], result: Result) => Result) { replace = fn; },
    count(args: string[]) { return calls.filter(row => JSON.stringify(row) === JSON.stringify(args)).length; } };
}

test('GITSRC4 treeFile shares a blob across paths and commits, preserves null/non-file and independent buffers', t => {
  const f = fixture(t), log = trace(t), oid = raw(f.root, ['rev-parse', `${f.head}:a.txt`]);
  const before = gitCalls();
  const bytes = treeFile(f.root, f.head, 'a.txt')!; bytes.fill(0);
  assert.equal(treeFile(f.root, f.head, 'a.txt')!.toString(), 'one\n');
  assert.equal(treeFile(f.root, f.head, 'same.txt')!.toString(), 'one\n');
  assert.equal(log.count(['cat-file', 'blob', oid]), 1);
  assert.equal(gitCalls() - before, 6, 'all three reads traverse the common API even on memo hits');
  const descendant = raw(f.root, ['commit-tree', f.tree, '-p', f.head], 'unchanged descendant\n');
  // Warm after object creation: both different commit/path names still address the same blob.
  treeFile(f.root, f.head, 'a.txt'); const count = log.count(['cat-file', 'blob', oid]);
  assert.equal(treeFile(f.root, descendant, 'same.txt')!.toString(), 'one\n');
  assert.equal(log.count(['cat-file', 'blob', oid]), count);
  assert.equal(treeFile(f.root, f.head, 'missing'), null);
  assert.throws(() => treeFile(f.root, f.head, 'dir'), code('tree_file_invalid'));
  assert.equal(treeFile(f.root, f.head, 'link')!.toString(), 'a.txt');
  raw(f.root, ['update-index', '--add', '--cacheinfo', `160000,${f.head},module`]);
  const submodule = raw(f.root, ['write-tree']);
  assert.throws(() => treeFile(f.root, submodule, 'module'), code('tree_file_invalid'));
  assert.throws(() => treeFile(f.root, 'f'.repeat(40), 'a.txt'), code('git_failed'));
  assert.equal(log.calls.some(args => args[0] === 'show'), false);
});

test('GITSRC4 treeFile binds bytes to its ls-tree entry when a symbolic revision moves between reads', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a.txt'), 'two\n'); const next = f.commit(); raw(f.root, ['reset', '--hard', f.head]);
  const log = trace(t);
  log.after(args => { if (args[0] === 'ls-tree') raw(f.root, ['update-ref', 'refs/heads/main', next]); });
  assert.equal(treeFile(f.root, 'HEAD', 'a.txt')!.toString(), 'one\n');
  assert.equal(treeFile(f.root, 'HEAD', 'a.txt')!.toString(), 'two\n');
});

test('GITSRC4 gitIsAncestor distinguishes status 1 from missing objects, config and process failures', t => {
  const f = fixture(t), next = raw(f.root, ['commit-tree', f.tree, '-p', f.head], 'next\n'), log = trace(t);
  const before = gitCalls();
  assert.equal(gitIsAncestor(f.root, f.head, next), true);
  assert.equal(gitIsAncestor(f.root, next, f.head), false);
  assert.equal(gitIsAncestor(f.root, next, f.head), false);
  assert.equal(log.count(['merge-base', '--is-ancestor', next, f.head]), 2, 'negative answers are not cached');
  assert.equal(gitCalls() - before, 3);
  assert.throws(() => gitIsAncestor(f.root, 'f'.repeat(40), f.head), code('git_failed'));
  assert.throws(() => gitIsAncestor(join(f.directory, 'absent'), f.head, next), code('git_failed'));
  const config = join(f.root, '.git/config'), saved = readFileSync(config);
  writeFileSync(config, '[broken\n');
  assert.throws(() => gitIsAncestor(f.root, f.head, next), code('git_failed')); writeFileSync(config, saved);
  log.replace((args, result) => args[0] === 'merge-base' ? { ...result, status: 1, error: new Error('') } : result);
  assert.throws(() => gitIsAncestor(f.root, next, f.head), code('git_failed'), 'even an empty process-error message is not a negative proof');
  log.replace((args, result) => args[0] === 'merge-base' ? { ...result, status: 1, signal: 'SIGTERM' } : result);
  assert.throws(() => gitIsAncestor(f.root, next, f.head), code('git_failed'));
});

test('GITSRC4 exact diff and immediate-parent memo observes replacements, shallow and config changes', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a.txt'), 'two\n'); const next = f.commit(), log = trace(t);
  const diff = ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', f.head, next];
  const parents = ['rev-list', '--parents', '-n', '1', next];
  for (const args of [diff, parents]) {
    const first = gitBytes(f.root, args); assert.deepEqual(gitBytes(f.root, args), first); assert.equal(log.count(args), 1);
  }
  raw(f.root, ['replace', next, f.head]);
  assert.equal(git(f.root, parents), raw(f.root, parents)); assert.equal(git(f.root, diff), raw(f.root, diff));
  raw(f.root, ['pack-refs', '--all']); rmSync(join(f.root, '.git/refs/replace'), { recursive: true, force: true });
  const count = log.count(diff); gitBytes(f.root, diff); gitBytes(f.root, diff); assert.equal(log.count(diff), count + 2);
  raw(f.root, ['replace', '-d', next]);
  writeFileSync(join(f.root, '.git/shallow'), next + '\n');
  assert.equal(git(f.root, parents), next); rmSync(join(f.root, '.git/shallow'));
  assert.equal(git(f.root, parents), `${next} ${f.head}`);
  const config = join(f.root, '.git/config'), saved = readFileSync(config);
  writeFileSync(config, '[broken\n'); assert.throws(() => git(f.root, parents), code('git_failed')); writeFileSync(config, saved);
  assert.equal(git(f.root, parents), `${next} ${f.head}`);
  const object = join(f.root, '.git/objects', next.slice(0, 2), next.slice(2)), bytes = readFileSync(object);
  rmSync(object); assert.throws(() => git(f.root, parents), code('git_failed')); writeFileSync(object, bytes);
});

test('GITSRC4 repeated full capture reuses two immutable reads and still checks changed bytes and scope', t => {
  const f = fixture(t), path = join(f.directory, 'work'); raw(f.root, ['worktree', 'add', '-qb', 'task', path, f.head]);
  const root: ExecutionRoot = { projectId: 'p', sourceRoot: f.root, path, branch: 'task', base: f.head, head: f.head,
    state: 'ready', workspace: { id: 'workspace:p', revision: 1, hash: 'fixture' } };
  const task = { writePaths: ['a.txt'] } as CompiledTask;
  writeFileSync(join(path, 'a.txt'), 'two\n'); const log = trace(t), first = capture(root, f.head, task);
  const before = log.calls.length, entries = gitCalls();
  assert.equal(capture(root, f.head, task), first);
  assert.equal(log.calls.length - before, 6, 'two worktree reads + diff + untracked + add + write-tree; two derived reads hit memo');
  assert.equal(gitCalls() - entries, 8, 'all eight Git reads remain observable to PF4');
  assert.equal(log.count(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', f.head, first]), 1);
  assert.equal(log.count(['ls-tree', '-r', '-z', first]), 1);
  // GITSRC3: the actual diff is the empty check, so capture reads no parent tree at all.
  assert.equal(log.count(['rev-parse', `${f.head}^{tree}`]), 0);
  writeFileSync(join(path, 'a.txt'), 'three\n'); const changed = capture(root, f.head, task); assert.notEqual(changed, first);
  assert.equal(treeFile(path, changed, 'a.txt')!.toString(), 'three\n');
  assert.throws(() => capture(root, f.head, { writePaths: ['same.txt'] } as CompiledTask), code('write_scope_exceeded'));
  raw(path, ['config', 'filter.gitsrc4.clean', 'cat']);
  writeFileSync(join(path, '.gitattributes'), '*.txt filter=gitsrc4\n');
  assert.throws(() => capture(root, f.head, task), code('write_scope_exceeded'));
});

test('GITSRC4 failed add/write-tree and nonstandard write forms keep the conservative memo clearing boundary', t => {
  const f = fixture(t), log = trace(t), args = ['rev-parse', `${f.head}^{tree}`];
  git(f.root, args); git(f.root, args); assert.equal(log.count(args), 1);
  const lock = join(f.root, '.git/index.lock'); writeFileSync(lock, 'owned elsewhere');
  assert.throws(() => git(f.root, ['add', '--all', '--', '.']), code('git_failed')); rmSync(lock);
  git(f.root, args); assert.equal(log.count(args), 2);
  const index = join(f.root, '.git/index'), saved = readFileSync(index); writeFileSync(index, 'not an index');
  assert.throws(() => git(f.root, ['write-tree']), code('git_failed')); writeFileSync(index, saved);
  git(f.root, args); assert.equal(log.count(args), 3);
  git(f.root, ['add', '--all']); git(f.root, args); assert.equal(log.count(args), 4, 'other argument forms still clear');
});

/** The same current producers as the ownership transfer scenario; both writers are natively accepted. */
async function upgrade(f: ReturnType<typeof executionFixture>) {
  const graph = structuredClone(f.plan.value.graphSnapshot);
  const successors = ['produce', 'consume'].map(name => {
    const old = graph.nodes.find(node => node.id === `p-${name}-work`)!;
    const node = structuredClone(old); node.id = `p-upgrade-${name}`;
    node.title = name === 'produce' ? 'Upgrade producer safety' : 'Upgrade consumer safety';
    node.code = node.code.map(ref => ({ ...ref, status: 'existing' }));
    const check = structuredClone(graph.tests.find(check => check.node === old.id)!);
    check.id = `${node.id}-test`; check.node = node.id; check.contract!.entrypoint.status = 'existing'; check.covers = ['p-flow'];
    check.contract!.counterfactuals.push({ connector: 'p-flow', mutation: 'substitute',
      expectedFailure: name === 'produce' ? 'output_overflow' : 'result_overflow',
      command: { executable: process.execPath, args: ['check.mjs', `overflow-${name}`] } });
    node.tests = [check.id]; graph.nodes.push(node); graph.tests.push(check);
    graph.transfers!.push({ id: `transfer-${name}`, path: node.code[0]!.path, from: old.id, to: node.id, condition: 'producer_committed' });
    return node;
  });
  graph.horizon = successors.map(node => node.id);
  const binding = graph.connectors[0]!.bindings.find(binding => binding.level === 3)!;
  binding.producer = { node: successors[0]!.id, port: 'out', codeRef: successors[0]!.code[0]! };
  binding.consumers = [{ node: successors[1]!.id, port: 'in', codeRef: successors[1]!.code[0]! }];
  graph.edges!.push({ id: 'use-previous-data', relation: 'requires', source: successors[0]!.id, target: 'p-produce-work',
    condition: 'Use the accepted producer version as the implementation baseline' });
  requireGraph(graph);
  f.engine.graphs.save('p', graph, f.store.get('graph:p')!.revision, 'fixture-researcher');
  const research = f.engine.refinement.begin('p', 'R2'); answerTechnicalFixture(f.engine, 'p', research);
  f.engine.refinement.finishResearch('p', 'R2', reference(f.store.get(research.id)!), f.store.get('phase:p:R2')!.revision);
  deriveLayerFixture(f.engine, 'p', 3); f.engine.refinement.sealLayer('p', 3, f.store.get('phase:p:L3')!.revision);
  const feasibility = f.engine.refinement.assess('p', f.store.get('feasibility:p')!.revision);
  const om = f.engine.refinement.publish('p', reference(feasibility), f.store.get('stage:p:om-g2')!.revision);
  f.engine.pipeline.accept('p', 'om-g2', om.revision);
  const plan = f.engine.compiler.compile('p');
  const compilation = f.engine.compiler.publish('p', reference(plan), f.store.get('stage:p:compilation')!.revision);
  f.engine.pipeline.accept('p', 'compilation', compilation.revision);
  const runs = await f.engine.executor.run('p', reference(plan), f.options);
  assert.deepEqual(runs.map(run => run.value.state), ['committed', 'committed']);
  return runs;
}

test('GITSRC4 native writers keep gates and exact parents while selection uses a bounded number of Git processes', async t => {
  privateConfiguration(t);
  const f = executionFixture(t), original = await f.engine.executor.run('p', reference(f.plan), f.options);
  assert.deepEqual(original.map(run => run.value.state), ['committed', 'committed']);
  const path = 'produce.mjs', writer = original[0]!, ref = reference(writer);
  const firstIndex = f.store.get<WriterIndex>(writerIndexId('p', path))!;
  const firstRoot = f.store.get<ExecutionRoot>(firstIndex.value.root!.id, firstIndex.value.root!.revision)!;
  const repository = { root: firstRoot.value.path, head: firstRoot.value.head };
  const common = raw(repository.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  await t.test('one writer uses one ancestry query, absent paths use none, failures remain failures', sub => {
    const log = trace(sub), proof = readWriter(f.store, 'p', repository, ref, path);
    assert.equal(proof.commit, writer.value.commit);
    assert.equal(log.count(['merge-base', '--is-ancestor', writer.value.commit!, repository.head]), 1);
    assert.equal(log.calls.filter(args => args[0] === 'rev-list' && args.length !== 5).length, 0, 'no full-history walk for a single writer');
    const count = log.calls.length;
    assert.equal(selectWriter(f.store, 'p', repository, [ref], 'not-owned.txt'), null);
    assert.equal(log.calls.length, count);
    assert.throws(() => readWriter(f.store, 'p', repository, ref, 'not-owned.txt'), code('ownership_proof_foreign'));
    assert.equal(log.calls.length, count);
    assert.equal(selectWriter(f.store, 'p', { ...repository, head: f.initial }, [ref], path), null);
    assert.throws(() => readWriter(f.store, 'p', { ...repository, head: f.initial }, ref, path), code('ownership_proof_foreign'));
    assert.throws(() => selectWriter(f.store, 'p', { ...repository, head: 'f'.repeat(40) }, [ref], path), code('git_failed'));
  });

  await t.test('commitOrigin keeps the single immediate parent and rejects transitive/merge parents after memo warming', sub => {
    git(repository.root, ['update-ref', 'refs/gitsrc4/parent-control', writer.value.commit!]);
    const log = trace(sub), args = ['rev-list', '--parents', '-n', '1', writer.value.commit!];
    readWriterIndex(f.store, 'p', path, reference(firstIndex), reference(firstRoot));
    readWriterIndex(f.store, 'p', path, reference(firstIndex), reference(firstRoot));
    assert.equal(log.count(args), 1, 'the exact-parent command is reused through common memo, not replaced by ancestry');
    const extra = raw(repository.root, ['commit-tree', writer.value.tree!, '-p', writer.value.parent], 'extra ancestor\n');
    for (const parents of [[extra], [writer.value.parent, extra]]) {
      const replacement = raw(repository.root, ['commit-tree', writer.value.tree!, ...parents.flatMap(parent => ['-p', parent])], 'parent counterexample\n');
      raw(repository.root, ['replace', writer.value.commit!, replacement]);
      try {
        assert.equal(gitIsAncestor(repository.root, writer.value.parent, writer.value.commit!), true);
        assert.throws(() => readWriterIndex(f.store, 'p', path, reference(firstIndex), reference(firstRoot)), error =>
          code('writer_index_invalid')(error) && (error as EngineError).details !== null
          && ((error as EngineError).details as { field: string }).field === 'origin.parent');
      } finally { raw(repository.root, ['replace', '-d', writer.value.commit!]); }
    }
  });

  const upgraded = await upgrade(f), latest = upgraded[0]!, refs = [ref, reference(latest)];
  const root = f.store.get<ExecutionRoot>('execution-root:p')!.value;
  const current = { root: root.path, head: root.head };

  await t.test('multiple candidates and repeated latest each use one fresh shared graph; no per-candidate Git walk', sub => {
    const log = trace(sub);
    assert.equal(selectWriter(f.store, 'p', current, refs, path)!.commit, latest.value.commit);
    assert.equal(selectWriter(f.store, 'p', current, [...refs].reverse(), path)!.commit, latest.value.commit);
    const many = Array.from({ length: 20 }, () => refs).flat(), before = log.calls.length;
    assert.equal(selectWriter(f.store, 'p', current, many, path)!.commit, latest.value.commit);
    assert.equal(log.calls.slice(before).filter(args => args[0] === 'rev-list').length, 1);
    assert.equal(log.calls.slice(before).filter(args => args[0] === 'merge-base').length, 0);
    const start = log.calls.length, owners = new Owners(f.store, 'p', current);
    assert.equal(owners.latest(path)!.commit, latest.value.commit);
    const entries = gitCalls(); assert.equal(owners.latest(path)!.commit, latest.value.commit);
    assert.ok(gitCalls() > entries, 'a repeated owner read cannot escape PF4');
    assert.equal(log.calls.slice(start).filter(args => args[0] === 'rev-list').length, 3, 'constructor + two latest calls, independent of candidate count');
    const config = join(common, 'config'), saved = readFileSync(config); writeFileSync(config, '[broken\n');
    try { assert.throws(() => owners.latest(path), code('git_failed')); }
    finally { writeFileSync(config, saved); }
    assert.equal(owners.latest(path)!.commit, latest.value.commit);
  });

  await t.test('the same Owners instance rechecks null and selected results after Git reachability changes', () => {
    const detached = raw(root.path, ['commit-tree', latest.value.tree!], 'independent slice\n');
    const owners = new Owners(f.store, 'p', { root: root.path, head: detached });
    assert.equal(owners.latest(path), null);
    raw(root.path, ['replace', detached, root.head]);
    try { assert.equal(owners.latest(path)!.commit, latest.value.commit); }
    finally { raw(root.path, ['replace', '-d', detached]); }
    assert.equal(owners.latest(path), null);
    const shallow = join(common, 'shallow'); writeFileSync(shallow, latest.value.commit! + '\n');
    try {
      assert.equal(selectWriter(f.store, 'p', current, refs, path)!.commit, latest.value.commit);
      assert.throws(() => readWriter(f.store, 'p', current, ref, path), code('ownership_proof_foreign'));
    } finally { rmSync(shallow); }
  });

  await t.test('parallel writers remain ambiguous; an accepted integration restores ordering', () => {
    const parallel = raw(root.path, ['commit-tree', latest.value.tree!, '-p', f.initial], 'parallel writer\n');
    raw(root.path, ['replace', latest.value.commit!, parallel]);
    const merge = raw(root.path, ['commit-tree', latest.value.tree!, '-p', writer.value.commit!, '-p', latest.value.commit!], 'merge slice\n');
    try { assert.throws(() => selectWriter(f.store, 'p', { root: root.path, head: merge }, refs, path), code('ownership_ambiguous')); }
    finally { raw(root.path, ['replace', '-d', latest.value.commit!]); }
    assert.equal(selectWriter(f.store, 'p', { root: root.path, head: merge }, refs, path)!.commit, latest.value.commit);
  });

  await t.test('a second claimed run at the same commit does not become an accepted owner', () => {
    const duplicate = f.store.write({ id: 'task-run:duplicate-claim', kind: latest.kind, expected: 0, value: latest.value });
    assert.throws(() => selectWriter(f.store, 'p', current, [reference(latest), reference(duplicate)], path), code('ownership_ambiguous'));
  });

  await t.test('symbolic names and annotated tag OIDs cannot masquerade as exact commit members', () => {
    raw(root.path, ['tag', '-a', 'claimed-writer', '-m', 'tag is not the commit', latest.value.commit!]);
    const tag = raw(root.path, ['rev-parse', 'refs/tags/claimed-writer']);
    for (const [name, commit] of [['symbolic', 'HEAD'], ['tag', tag]] as const) {
      const symbolic = f.store.write({ id: `task-run:${name}-claim`, kind: latest.kind, expected: 0,
        value: { ...latest.value, commit } });
      assert.throws(() => readWriter(f.store, 'p', current, reference(symbolic), path), code('ownership_proof_foreign'));
      assert.equal(selectWriter(f.store, 'p', current, [reference(symbolic)], path), null);
      assert.equal(selectWriter(f.store, 'p', current, [reference(symbolic), reference(latest)], path)!.commit, latest.value.commit);
    }
  });
});

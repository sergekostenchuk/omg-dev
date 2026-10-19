import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, gitBytes, gitCalls, inspectRepository, type Environment } from '../src/runtime/environment.js';
import { EngineError } from '../src/errors.js';
import { historicalProof } from '../src/history/proofs.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import type { Graph } from '../src/graph/model.js';

const children = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const emptyGraph: Graph = { version: 2, id: 'graph:p', title: 'Empty', horizon: [], contracts: [], nodes: [], artifacts: [], connectors: [], anchors: [], joins: [], tests: [] };
function fixture(t: TestContext, objectFormat?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-gitsrc2-'))), repo = join(root, 'repo');
  mkdirSync(repo);
  // Private Git configuration in this test process; never modify the developer's configuration files.
  const oldHome = process.env['HOME'], oldXdg = process.env['XDG_CONFIG_HOME'];
  process.env['HOME'] = root; process.env['XDG_CONFIG_HOME'] = join(root, 'xdg');
  t.after(() => {
    if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome;
    if (oldXdg === undefined) delete process.env['XDG_CONFIG_HOME']; else process.env['XDG_CONFIG_HOME'] = oldXdg;
    rmSync(root, { recursive: true, force: true });
  });
  const raw = (args: string[], input?: string | Buffer, cwd = repo) => execFileSync('git',
    ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  raw(['init', '-q', '-b', 'main', ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]);
  writeFileSync(join(repo, 'a.txt'), 'one\n'); writeFileSync(join(repo, 'b.txt'), 'two\n');
  const commit = () => { raw(['add', '-A']); return raw(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']); };
  commit();
  const head = raw(['rev-parse', 'HEAD']), tree = raw(['rev-parse', 'HEAD^{tree}']);
  const command = { executable: process.execPath, args: ['--version'] };
  const environment: Environment = { projectId: 'p', workspace: repo, timeoutMs: 1000, fullCheck: command,
    implementer: { actor: 'a', model: 'fixture', effort: 'high', command }, reviewer: { actor: 'b', model: 'fixture', effort: 'high', command } };
  return { root, repo, raw, commit, head, tree, environment };
}
function trace(t: TestContext) {
  const original = children.spawnSync, calls: string[][] = [];
  let after: ((args: string[]) => void) | undefined;
  children.spawnSync = ((...args: unknown[]) => {
    const argv = args[0] === 'git' && Array.isArray(args[1]) ? [...args[1] as string[]].slice(3) : null;
    const result = Reflect.apply(original, children, args);
    if (argv) {
      calls.push(argv);
      const path = process.env['GITSRC2_TRACE'];
      if (path) appendFileSync(path, JSON.stringify({ test: t.name, args: argv }) + '\n');
      after?.(argv);
    }
    return result;
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(() => { children.spawnSync = original; syncBuiltinESMExports(); });
  return { calls, after(fn: (args: string[]) => void) { after = fn; }, count(args: string[]) { return calls.filter(a => JSON.stringify(a) === JSON.stringify(args)).length; } };
}
const failed = (error: unknown) => error instanceof EngineError && error.code === 'git_failed';

test('GITSRC2 inspectRepository keeps exact root, clean/detached/unborn results; warm read uses two Git processes', t => {
  const f = fixture(t), log = trace(t);
  const first = inspectRepository(f.environment, emptyGraph);
  assert.deepEqual(first, { state: { root: f.repo, head: f.head, tree: f.tree, files: [] }, findings: [] });
  const before = log.calls.length, entries = gitCalls();
  assert.deepEqual(inspectRepository(f.environment, emptyGraph), first);
  assert.equal(log.calls.length - before, 2, 'root and status are fresh; the exact tree is reused');
  assert.equal(gitCalls() - entries, 3, 'the memo hit still counts as a Git read');
  assert.equal(log.count(['rev-parse', `${f.head}^{tree}`]), 1);
  assert.equal(log.count(['rev-parse', 'HEAD']), 0);
  f.raw(['checkout', '--detach', '-q', f.head]);
  assert.deepEqual(inspectRepository(f.environment, emptyGraph), first);
  mkdirSync(join(f.repo, 'sub'));
  const nested = inspectRepository({ ...f.environment, workspace: join(f.repo, 'sub') }, emptyGraph);
  assert.equal(nested.state, null); assert.equal(nested.findings[0]!.message, 'Select the Git repository root');
  const unborn = join(f.root, 'unborn'); mkdirSync(unborn); f.raw(['init', '-q'], undefined, unborn);
  const missing = inspectRepository({ ...f.environment, workspace: unborn }, emptyGraph);
  assert.equal(missing.state, null); assert.equal(missing.findings[0]!.code, 'repository_unavailable');
  assert.equal(missing.findings[0]!.message, 'Git command failed');
});

test('GITSRC2 status NUL parsing preserves staged, unstaged, deleted, nested untracked, rename and conflict dirtiness', t => {
  const f = fixture(t);
  const dirty = () => assert.equal(inspectRepository(f.environment, emptyGraph).findings[0]?.code, 'repository_dirty');
  writeFileSync(join(f.repo, 'a.txt'), 'changed\n'); dirty();
  f.raw(['add', 'a.txt']); dirty();
  f.raw(['reset', '--hard', '-q', f.head]); rmSync(join(f.repo, 'b.txt')); dirty();
  f.raw(['reset', '--hard', '-q', f.head]); mkdirSync(join(f.repo, 'untracked'));
  writeFileSync(join(f.repo, 'untracked', '# branch.oid fake\nname'), 'data'); dirty();
  rmSync(join(f.repo, 'untracked'), { recursive: true });
  f.raw(['mv', 'a.txt', '# branch.oid fake\nrenamed']); dirty();
  f.raw(['reset', '--hard', '-q', f.head]);
  f.raw(['checkout', '-qb', 'other']); writeFileSync(join(f.repo, 'a.txt'), 'other\n'); f.commit();
  f.raw(['checkout', '-q', 'main']); writeFileSync(join(f.repo, 'a.txt'), 'main\n'); f.commit();
  assert.throws(() => f.raw(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'merge', 'other'])); dirty();
});

test('GITSRC2 tree belongs to the status OID even when HEAD moves between subprocesses; earlier findings stay', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'a.txt'), 'next\n'); f.commit(); const next = f.raw(['rev-parse', 'HEAD']);
  f.raw(['reset', '--hard', '-q', f.head]);
  const log = trace(t);
  log.after(args => { if (args[0] === 'status') f.raw(['reset', '--hard', '-q', next]); });
  const result = inspectRepository({ ...f.environment, reviewer: f.environment.implementer,
    fullCheck: { executable: 'missing-gitsrc2-check', args: [] } }, emptyGraph);
  assert.deepEqual([result.state?.head, result.state?.tree], [f.head, f.tree]);
  assert.deepEqual(result.findings.map(finding => finding.code), ['reviewer_not_independent', 'check_unavailable']);
});

test('GITSRC2 immutable forms reuse bytes; buffers are independent and input/HEAD/abbreviations/options bypass', t => {
  const f = fixture(t), log = trace(t), blob = f.raw(['rev-parse', `${f.head}:a.txt`]);
  const forms = [['rev-parse', `${f.head}^{tree}`], ['ls-tree', '-r', '-z', f.tree],
    ['ls-tree', '-z', f.head, '--', 'a.txt'], ['show', `${f.head}:a.txt`], ['cat-file', 'blob', blob],
    ['rev-list', '--parents', '-n', '1', f.head], ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', f.head, f.tree]];
  for (const args of forms) {
    const first = gitBytes(f.repo, args), expected = Buffer.from(first); first.fill(0);
    const count = gitCalls(), second = gitBytes(f.repo, args); assert.deepEqual(second, expected);
    second.fill(1); assert.deepEqual(gitBytes(f.repo, args), expected);
    assert.equal(gitCalls(), count + 2); assert.equal(log.count(args), 1, args.join(' '));
  }
  for (const args of [['rev-parse', 'HEAD'], ['rev-parse', `${f.head.slice(0, 10)}^{tree}`],
    ['rev-parse', '--verify', `${f.head}^{tree}`], ['rev-list', '--parents', '-n', '2', f.head],
    ['merge-base', '--is-ancestor', f.head, f.head], ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD', f.tree]]) {
    const count = log.count(args); gitBytes(f.repo, args); gitBytes(f.repo, args); assert.equal(log.count(args), count + 2);
  }
  const args = forms[0]!; const before = log.count(args);
  gitBytes(f.repo, args, Buffer.alloc(0)); assert.equal(log.count(args), before + 1);
});

test('GITSRC2 replacements including packed refs, shallow/grafts and alternates bypass the memo', t => {
  const f = fixture(t), log = trace(t), args = ['rev-parse', `${f.head}^{tree}`];
  git(f.repo, args);
  writeFileSync(join(f.repo, 'a.txt'), 'replacement\n'); f.commit(); const replacement = f.raw(['rev-parse', 'HEAD']);
  f.raw(['replace', f.head, replacement]);
  for (let i = 0; i < 2; i++) assert.equal(git(f.repo, args), f.raw(args));
  f.raw(['pack-refs', '--all']); rmSync(join(f.repo, '.git/refs/replace'), { recursive: true, force: true });
  const before = log.count(args); git(f.repo, args); git(f.repo, args); assert.equal(log.count(args), before + 2);
  f.raw(['replace', '-d', f.head]);
  for (const [path, value] of [['shallow', f.head + '\n'], ['info/grafts', ''], ['objects/info/alternates', '']] as const) {
    const file = join(f.repo, '.git', path); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, value);
    const count = log.count(args); git(f.repo, args); git(f.repo, args); assert.equal(log.count(args), count + 2, path); rmSync(file);
  }
});

test('GITSRC2 local/global configuration changes invalidate, includes bypass, and a race does not retain the earlier answer', t => {
  const f = fixture(t), log = trace(t), args = ['show', `${f.head}:a.txt`];
  gitBytes(f.repo, args); gitBytes(f.repo, args); assert.equal(log.count(args), 1);
  f.raw(['config', 'core.quotePath', 'false']); gitBytes(f.repo, args); assert.equal(log.count(args), 2);
  writeFileSync(join(f.root, '.gitconfig'), '[core]\n quotePath = true\n'); gitBytes(f.repo, args); assert.equal(log.count(args), 3);
  writeFileSync(join(f.root, 'included'), '[core]\n quotePath = false\n');
  f.raw(['config', 'include.path', join(f.root, 'included')]);
  gitBytes(f.repo, args); gitBytes(f.repo, args); assert.equal(log.count(args), 5);
  f.raw(['config', '--unset', 'include.path']);
  const unseen = ['show', `${f.head}:b.txt`];
  log.after(argv => { if (JSON.stringify(argv) === JSON.stringify(unseen)) f.raw(['config', 'gitsrc2.sequence', String(log.count(unseen))]); });
  gitBytes(f.repo, unseen); gitBytes(f.repo, unseen); assert.equal(log.count(unseen), 2, 'post-read metadata differs; no entry retained');
});

// Reviewer GITSRC2-01: warm show <full OID>:a.txt, then create a malformed effective config.
// The original positive cache assertion is kept for ordinary paths; ambiguous paths may bypass.
for (const [source, separator] of [
  ['XDG_CONFIG_HOME', ''], ['XDG_CONFIG_HOME', '\n'], ['XDG_CONFIG_HOME', '\r'], ['XDG_CONFIG_HOME', '\r\n'],
  ['HOME', '\n'], ['HOME', '\r'], ['HOME', '\r\n'],
] as const) test(`GITSRC2 global configuration creation remains observable: ${source}, separator=${JSON.stringify(separator)}`, t => {
  const f = fixture(t);
  const directory = join(f.root, `config${separator}`, f.root.replace(/^\//, ''), 'tail');
  process.env[source] = directory;
  const config = source === 'HOME' ? join(directory, '.gitconfig') : join(directory, 'git/config');
  mkdirSync(resolve(config, '..'), { recursive: true });
  const args = ['show', `${f.head}:a.txt`], log = trace(t), start = gitCalls();
  assert.equal(gitBytes(f.repo, args).toString(), 'one\n');
  assert.equal(gitBytes(f.repo, args).toString(), 'one\n');
  assert.equal(log.count(args), separator ? 2 : 1, 'ordinary paths hit; CR/LF paths use Git every time');
  assert.equal(gitCalls() - start, 2);
  writeFileSync(config, '[broken\n');
  assert.throws(() => f.raw(args), 'direct Git observes the new malformed configuration');
  assert.throws(() => gitBytes(f.repo, args), failed, 'memo cannot hide the effective Git configuration');
});

for (const separator of ['\n', '\r']) test(`GITSRC2 an ambiguous system configuration path bypasses memo: ${JSON.stringify(separator)}`, t => {
  const f = fixture(t), original = children.spawnSync;
  const systemPath = join(f.root, `system${separator}`, f.root.replace(/^\//, ''), 'gitconfig');
  // git-var has no NUL mode. Supply its legal raw path response without changing system files.
  children.spawnSync = ((...args: unknown[]) => {
    const result = Reflect.apply(original, children, args);
    if (args[0] === 'git' && Array.isArray(args[1]) && args[1].at(-1) === 'GIT_CONFIG_SYSTEM')
      return { ...result, stdout: Buffer.from(systemPath + '\n') };
    return result;
  }) as typeof original;
  syncBuiltinESMExports();
  const log = trace(t);
  t.after(() => { children.spawnSync = original; syncBuiltinESMExports(); });
  const args = ['show', `${f.head}:a.txt`];
  assert.equal(gitBytes(f.repo, args).toString(), 'one\n');
  assert.equal(gitBytes(f.repo, args).toString(), 'one\n');
  assert.equal(log.count(args), 2, 'ambiguous system paths do not produce a memo key');
});

test('GITSRC2 an unknown HOME bypasses memo and preserves the ordinary Git result', t => {
  const f = fixture(t), args = ['show', `${f.head}:a.txt`], log = trace(t);
  delete process.env['HOME'];
  const expected = f.raw(args);
  assert.equal(git(f.repo, args), expected); assert.equal(git(f.repo, args), expected);
  assert.equal(log.count(args), 2);
});

test('GITSRC2 repository/worktree recreation, symlink aliases and object removal cannot reuse a foreign answer', t => {
  const f = fixture(t), log = trace(t), args = ['rev-parse', `${f.head}^{tree}`];
  git(f.repo, args); git(f.repo, args); assert.equal(log.count(args), 1);
  const alias = join(f.root, 'alias'); symlinkSync(f.repo, alias, 'dir');
  assert.equal(git(alias, args), f.tree); assert.equal(log.count(args), 1, 'realpath aliases share the same repository identity');
  const refs = join(f.repo, '.git/refs'), savedRefs = join(f.root, 'refs');
  renameSync(refs, savedRefs); assert.throws(() => git(f.repo, args), failed); renameSync(savedRefs, refs);
  const headFile = join(f.repo, '.git/HEAD'), savedHead = readFileSync(headFile);
  writeFileSync(headFile, 'malformed HEAD\n'); assert.throws(() => git(f.repo, args), failed); writeFileSync(headFile, savedHead);
  const linked = join(f.root, 'linked'); f.raw(['worktree', 'add', '--detach', '-q', linked, f.head]);
  assert.equal(git(linked, args), f.tree); assert.equal(git(linked, args), f.tree);
  mkdirSync(join(f.repo, 'sub'));
  git(join(f.repo, 'sub'), args); git(join(f.repo, 'sub'), args); // Deliberately uncached: cwd prefix belongs to Git.
  const old = join(f.root, 'old.git'); renameSync(join(f.repo, '.git'), old);
  f.raw(['init', '-q']); assert.throws(() => git(f.repo, args), failed);
  rmSync(join(f.repo, '.git'), { recursive: true }); renameSync(old, join(f.repo, '.git'));
  assert.equal(git(f.repo, args), f.tree);
  const object = join(f.repo, '.git/objects', f.head.slice(0, 2), f.head.slice(2));
  const bytes = readFileSync(object); rmSync(object); assert.throws(() => git(f.repo, args), failed);
  writeFileSync(object, bytes); assert.equal(git(f.repo, args), f.tree);
});

test('GITSRC2 failures are never cached; an absent object can appear later; SHA-256 OIDs are accepted', t => {
  const f = fixture(t, 'sha256'), log = trace(t), content = 'new object\n';
  const blob = f.raw(['hash-object', '--stdin'], content), args = ['cat-file', 'blob', blob];
  assert.equal(blob.length, 64);
  assert.throws(() => gitBytes(f.repo, args), failed); assert.throws(() => gitBytes(f.repo, args), failed);
  assert.equal(log.count(args), 2);
  f.raw(['hash-object', '-w', '--stdin'], content);
  assert.equal(git(f.repo, args), content.trim()); assert.equal(git(f.repo, args), content.trim()); assert.equal(log.count(args), 3);
  assert.equal(inspectRepository(f.environment, emptyGraph).state?.tree, f.tree);
});

test('GITSRC2 cached responses remain Git-dependent for PF4 historical proof reuse', t => {
  const f = fixture(t), log = trace(t), args = ['rev-parse', `${f.head}^{tree}`];
  git(f.repo, args);
  const store = new Store(join(f.root, 'proof.sqlite'));
  try {
    const row = store.write({ id: 'proof:git', kind: 'proof', expected: 0, value: {} }); let reads = 0;
    const read = () => historicalProof(store, { reader: 'GITSRC2', project: 'p', ref: reference(row), parameters: {} }, source => {
      reads++; git(f.repo, args); return reference(source.get(row.id, 1)!);
    }, () => { throw new Error('cycle'); });
    read(); read(); assert.equal(reads, 2); assert.equal(log.count(args), 1, 'proof reruns, immutable Git subprocess does not');
  } finally { store.close(); }
});

test('GITSRC2 byte bound evicts responses and a command that can write clears the memo', t => {
  const f = fixture(t), log = trace(t);
  const blobs = ['a', 'b', 'c'].map(letter => f.raw(['hash-object', '-w', '--stdin'], Buffer.alloc(3 * 1024 * 1024, letter)));
  for (const oid of blobs) assert.equal(gitBytes(f.repo, ['cat-file', 'blob', oid]).length, 3 * 1024 * 1024);
  const args = ['cat-file', 'blob', blobs[0]!]; gitBytes(f.repo, args); assert.equal(log.count(args), 2, '9 MiB cannot remain in an 8 MiB memo');
  gitBytes(f.repo, args); assert.equal(log.count(args), 2);
  git(f.repo, ['update-ref', 'refs/heads/memo-check', f.head]); gitBytes(f.repo, args); assert.equal(log.count(args), 3);
});

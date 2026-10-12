import test from "node:test";
import ts from "typescript";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { declares, deriveImpact, deriveTestMap, readSnapshot, resolveSnapshot, snapshotFiles, isTestFile, unanalyzedSite, type RepositorySnapshot } from "../src/om/impact.js";
import { hashJson } from "../src/canonical.js";

const SNAPSHOT: RepositorySnapshot = { commit: "a".repeat(40), tree: "b".repeat(40) };
const view = (files: Record<string, string>) => snapshotFiles(SNAPSHOT, Object.keys(files), new Map(Object.entries(files)));
/** The base product of the live plan, small: a test reaches commands only through engine; another launches the CLI. */
const PRODUCT: Record<string, string> = {
  "src/product/commands.ts": "export const parse = (x: unknown) => x;\n",
  "src/product/engine.ts": 'import { parse } from "./commands.js";\nexport class Engine { run(x: unknown) { return parse(x); } }\n',
  "src/cli.ts": 'import { Engine } from "./product/engine.js";\nnew Engine();\n',
  "src/server.ts": 'import { Engine } from "./product/engine.js";\nexport const serve = () => new Engine();\n',
  "test/product.test.ts": 'import test from "node:test";\nimport { Engine } from "../src/product/engine.js";\n'
    + 'const cli = new URL("../src/cli.js", import.meta.url);\ntest("CLI command interface persists commands", () => { new Engine(); void cli; });\n',
  "test/server.test.ts": 'import test from "node:test";\nimport { serve } from "../src/server.js";\ndescribe("server", () => { test("serves", () => serve()); });\n',
  "test/unrelated.test.ts": 'import test from "node:test";\ntest("alone", () => {});\n',
  "package.json": JSON.stringify({ scripts: { dev: "node dist/src/server.js", build: "tsc -p tsconfig.json" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }),
};

test("AT1 П1 the walk to a fixed point runs through src: a test that reaches commands only through engine is a consumer of a work that changes commands alone", () => {
  const inventory = deriveImpact(view(PRODUCT), [{ work: "w-commands", writes: ["src/product/commands.ts"] }]);
  const [work] = inventory.works;
  assert.deepEqual(work!.affected, ["src/product/commands.ts"]);
  assert.deepEqual(work!.entries.map(entry => entry.test), ["test/product.test.ts", "test/server.test.ts"]);
  assert.deepEqual(work!.entries[0]!.reaches, ["src/product/commands.ts"]);
  assert.ok(work!.consumers.includes("src/product/engine.ts") && work!.consumers.includes("src/cli.ts"), "the src entries on the way are listed");
  assert.ok(work!.consumers.includes("package.json#scripts.dev"), "a package script that runs a consumer is an entry");
  assert.ok(!work!.entries.some(entry => entry.test === "test/unrelated.test.ts"));
});

test("AT1 П1 a file exists by the tree, whatever label the proposal gives it: an existing path declared planned is affected; an absent one is not", () => {
  const inventory = deriveImpact(view(PRODUCT), [{ work: "w", writes: ["src/cli.ts", "src/product/intake.ts", "test/intake.test.ts"] }]);
  assert.deepEqual(inventory.works[0]!.affected, ["src/cli.ts"]);
  const entry = inventory.works[0]!.entries.find(item => item.test === "test/product.test.ts")!;
  assert.deepEqual(entry.via, ["launch"], "the CLI is launched by its literal path: a launch, not an import");
  assert.deepEqual(deriveImpact(view(PRODUCT), [{ work: "w", writes: ["src/new.ts"] }]).works[0], { work: "w", affected: [], entries: [], consumers: [], unknowns: [] });
});

test("AT1 П1 the supported transitions: a fixture's tests are consumers through it; dist names its source; a launch path by literal; comments and strings are no transitions", () => {
  const files = {
    "src/a.ts": "export const a = 1;\n",
    "test/helper.ts": 'export { a } from "../dist/src/a.js";\n',
    "test/a.test.ts": 'import test from "node:test";\nimport { a } from "./helper.js";\ntest("uses a", () => a);\n',
    "test/spawn.test.ts": 'import test from "node:test";\nimport { spawnSync } from "node:child_process";\ntest("runs", () => spawnSync(process.execPath, ["dist/src/a.js"]));\n',
    "test/quiet.test.ts": 'import test from "node:test";\n// import("../src/a.js") and require(x) in a comment\nconst code = `require(\'node:fs\').readFileSync(${"x"})`;\ntest("quiet", () => code);\n',
    "tsconfig.json": '{ // the build output is mapped by the snapshot\'s own config\n "compilerOptions": { "rootDir": ".", "outDir": "dist" } }',
    // Return №4180: the run its package defines selects the tests; the helper beside them is test support, not a test.
    "package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.ts" } }),
  };
  const work = deriveImpact(view(files), [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
  assert.deepEqual(work.entries.map(entry => [entry.test, entry.via]), [["test/a.test.ts", ["import"]], ["test/spawn.test.ts", ["launch"]]]);
  assert.deepEqual(work.consumers, ["test/helper.ts"]);
  assert.deepEqual(work.unknowns, [], "a transition written inside a string or a comment is none");
  // Return №4163: without the config's outDir and rootDir nothing proves where dist comes from — the import is unknown.
  const { ["tsconfig.json"]: _config, ...unmapped } = files;
  const open = deriveImpact(view(unmapped), [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
  assert.deepEqual(open.unknowns.map(item => [item.file, item.kind, item.text]), [["test/helper.ts", "unresolved", 'export { a } from "../dist/src/a.js";']]);
});

test("AT1 П2 an unresolved transition is an addressed unknown of every work — no text of its expression bounds its path (return №4186 P1); an accepted resolution turns it into an edge or closes it", () => {
  const files = {
    ...PRODUCT,
    "test/loader.test.ts": 'import test from "node:test";\ntest("loads", async () => { const name = process.env.M!; await import(name); });\n',
    "test/elsewhere.test.ts": 'import test from "node:test";\ntest("other", async () => { await import(`../src/other/${process.env.X}.js`); });\n',
  };
  const work = deriveImpact(view(files), [{ work: "w", writes: ["src/cli.ts"] }]).works[0]!;
  assert.deepEqual(work.unknowns.map(item => [item.file, item.line, item.kind]), [["test/elsewhere.test.ts", 2, "dynamic-import"], ["test/loader.test.ts", 2, "dynamic-import"]],
    "`../src/other/${X}` may climb out of src/other: no prefix is proved");
  const loader = work.unknowns.find(item => item.file === "test/loader.test.ts")!;
  const reached = deriveImpact(view(files), [{ work: "w", writes: ["src/cli.ts"] }], [{ file: "test/loader.test.ts", line: 2, site: loader.site, resolves: ["src/cli.ts"] }]).works[0]!;
  assert.deepEqual(reached.unknowns.map(item => item.file), ["test/elsewhere.test.ts"]);
  assert.deepEqual(reached.entries.find(entry => entry.test === "test/loader.test.ts")?.via, ["resolution"]);
  const none = deriveImpact(view(files), [{ work: "w", writes: ["src/cli.ts"] }], [{ file: "test/loader.test.ts", line: 2, site: loader.site, resolves: [] }]).works[0]!;
  assert.deepEqual([none.unknowns.map(item => item.file), none.entries.some(entry => entry.test === "test/loader.test.ts")], [["test/elsewhere.test.ts"], false]);
});

test("AT1 door (№4105 п.4, return №4186 P1): an unknown names every other file of its snapshot as a candidate — JSON, files without an extension, unread formats included; a resolution of an unanalyzed file is its edge", () => {
  const files = {
    ...PRODUCT,
    "test/loader.test.ts": 'import test from "node:test";\ntest("loads", async () => { const name = process.env.M!; await import(name); });\n',
    "test/plugin.test.ts": 'import test from "node:test";\ntest("plugin", async () => { await import(`../src/cli${process.env.X}.js`); });\n',
    "test/data.test.ts": 'import test from "node:test";\nconst at = new URL(process.env.F!, import.meta.url);\ntest("data", () => at);\n',
  };
  const work = deriveImpact(view(files), [{ work: "w", writes: ["src/cli.ts"] }]).works[0]!;
  const others = (path: string) => Object.keys(files).filter(other => other !== path).sort();
  assert.deepEqual(work.unknowns.map(item => [item.file, item.candidates]), [
    ["test/data.test.ts", others("test/data.test.ts")], ["test/loader.test.ts", others("test/loader.test.ts")], ["test/plugin.test.ts", others("test/plugin.test.ts")]]);
  const large = snapshotFiles(SNAPSHOT, [...Object.keys(PRODUCT), "test/huge.test.ts"], new Map(Object.entries(PRODUCT)), new Set(["test/huge.test.ts"]));
  const open = deriveImpact(large, [{ work: "w", writes: ["src/cli.ts"] }]).works[0]!;
  assert.deepEqual(open.unknowns.map(item => [item.file, item.line, item.kind]), [["test/huge.test.ts", 0, "unanalyzed"]]);
  const resolved = deriveImpact(large, [{ work: "w", writes: ["src/cli.ts"] }], [{ file: "test/huge.test.ts", line: 0, site: unanalyzedSite("test/huge.test.ts"), resolves: ["src/cli.ts"] }]).works[0]!;
  assert.deepEqual([resolved.unknowns, resolved.entries.find(entry => entry.test === "test/huge.test.ts")?.via], [[], ["resolution"]]);
});

test("AT1 П4 a case is addressed by its file and the full chain of its groups; a file with a computed or repeated name has no reliable case address", () => {
  const files = {
    "src/a.ts": "export const a = 1;\n",
    "test/nested.test.ts": 'import test, { describe } from "node:test";\nimport { a } from "../src/a.js";\n'
      + 'describe("outer", () => {\n  describe("inner", () => { test("one", () => a); });\n  test("two", () => a);\n});\ntest("three", () => a);\n',
    "test/repeated.test.ts": 'import test, { describe } from "node:test";\nimport { a } from "../src/a.js";\ndescribe("g", () => { test("same", () => a); });\ndescribe("g", () => { test("same", () => a); });\n',
    "test/computed.test.ts": 'import test from "node:test";\nimport { a } from "../src/a.js";\nfor (const n of [1, 2]) test(`case ${n}`, () => a);\n',
  };
  const work = deriveImpact(view(files), [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
  const nested = work.entries.find(entry => entry.test === "test/nested.test.ts")!;
  assert.deepEqual(nested.cases.map(item => [item.path, item.line]), [[["outer", "inner", "one"], 4], [["outer", "two"], 5], [["three"], 7]]);
  assert.equal(nested.addressable, true);
  assert.equal(work.entries.find(entry => entry.test === "test/repeated.test.ts")!.addressable, false, "the same chain twice is no address");
  assert.equal(work.entries.find(entry => entry.test === "test/computed.test.ts")!.addressable, false, "a computed name is no address");
  assert.ok(isTestFile("test/a.test.ts") && isTestFile("x/b.spec.mjs") && !isTestFile("test/helper.ts"));
});

test("AT1 П1 the inventory is deterministic: the same files in another order give the same bytes", () => {
  const reversed = Object.fromEntries(Object.entries(PRODUCT).reverse());
  const works = [{ work: "b", writes: ["src/cli.ts"] }, { work: "a", writes: ["src/product/commands.ts", "src/server.ts"] }];
  assert.equal(hashJson(deriveImpact(view(reversed), [...works].reverse())), hashJson(deriveImpact(view(PRODUCT), works)));
});

test("AT1 П5 the snapshot is one exact commit and tree, read through Git objects only: a later commit or an edited working file changes nothing read; a foreign tree and a missing repository are typed refusals", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omg-impact-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  run("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(PRODUCT)) put(path, text);
  run("add", "."); run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
  const snapshot = resolveSnapshot(root);
  assert.equal(snapshot.commit, run("rev-parse", "HEAD"));
  put("test/product.test.ts", 'import test from "node:test";\ntest("rewritten", () => {});\n');
  run("add", "."); run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "later");
  put("test/server.test.ts", "// dirty working file\n");
  const files = readSnapshot(root, snapshot);
  assert.equal(files.text("test/product.test.ts"), PRODUCT["test/product.test.ts"], "the saved tree, not HEAD or the working file");
  assert.equal(hashJson(deriveImpact(files, [{ work: "w", writes: ["src/cli.ts"] }])), hashJson(deriveImpact(view(PRODUCT), [{ work: "w", writes: ["src/cli.ts"] }]).works.length
    ? { ...deriveImpact(view(PRODUCT), [{ work: "w", writes: ["src/cli.ts"] }]), snapshot } : null));
  assert.throws(() => readSnapshot(root, { commit: snapshot.commit, tree: "c".repeat(40) }), { code: "impact_snapshot_invalid" });
  assert.throws(() => readSnapshot(root, { commit: snapshot.commit } as never), { code: "impact_snapshot_invalid" });
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "omg-impact-none-")));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => resolveSnapshot(empty), { code: "impact_repository_unavailable" });
});

// ---- AT1 (№4098): the one coverage of a work's exact inventory by its decisions ----
import { impactCoverage } from "../src/om/impact.js";
import type { ImpactDecision } from "../src/graph/model.js";
const covering = (writes: string[], decisions: ImpactDecision[], files: Record<string, string> = PRODUCT, known: string[] = []) =>
  impactCoverage(deriveImpact(view(files), [{ work: "w", writes }]).works[0]!, decisions, new Set(known));
const codesOf = (result: ReturnType<typeof impactCoverage>) => result.findings.map(item => [item.code, item.field]);

test("AT1 rows 2, 4 and №4098 п.1 a direct test needs the work's own decision: one keep by a finite list of files covers it; nothing, or the transitive keep alone, leaves it undecided", () => {
  const product = { test: "test/product.test.ts" };
  assert.deepEqual(deriveImpact(view(PRODUCT), [{ work: "w", writes: ["src/cli.ts"] }]).works[0]!.entries.map(entry => [entry.test, entry.direct]), [[product.test, true]]);
  assert.deepEqual(codesOf(covering(["src/cli.ts"], [{ entry: { files: [product.test] }, decision: "keep", requirement: "p-R1" }])), []);
  assert.deepEqual(codesOf(covering(["src/cli.ts"], [])), [["work_impact_undecided", product.test]]);
  assert.deepEqual(codesOf(covering(["src/cli.ts"], [{ entry: { transitive: true }, decision: "keep", requirement: "p-R1" }])), [["work_impact_undecided", product.test]],
    "the transitive keep never covers a direct test");
});

test("AT1 №4098 п.1, п.3 the transitive keep covers exactly the remainder of this inventory — never a known contradiction or an unknown; a test reached through a fixture alone stays direct", () => {
  const transitive: ImpactDecision[] = [{ entry: { transitive: true }, decision: "keep", requirement: "p-R1" }];
  const remainder = covering(["src/product/commands.ts"], transitive);
  assert.deepEqual([codesOf(remainder), remainder.covered.map(item => [item.test, item.by])],
    [[], [["test/product.test.ts", "transitive"], ["test/server.test.ts", "transitive"]]]);
  assert.deepEqual(codesOf(covering(["src/product/commands.ts"], transitive, PRODUCT, ["test/product.test.ts"])), [["work_impact_undecided", "test/product.test.ts"]]);
  const loader = { ...PRODUCT, "test/loader.test.ts": 'import test from "node:test";\ntest("loads", async () => { await import(process.env.M!); });\n' };
  const at = loader["test/loader.test.ts"].indexOf("import(process.env.M!)");
  assert.deepEqual(codesOf(covering(["src/product/commands.ts"], transitive, loader)), [["work_impact_unresolved", `test/loader.test.ts:2#${at}-${at + "import(process.env.M!)".length}`]],
    "no keep closes an unknown; its address is its exact span");
  // Return №4180: the run its package defines selects the tests; the helper beside them is test support, not a test.
  const fixture = { "src/a.ts": "export const a = 1;\n", "test/helper.ts": 'export { a } from "../src/a.js";\n', "package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.ts" } }),
    "test/a.test.ts": 'import test from "node:test";\nimport { a } from "./helper.js";\ntest("a", () => a);\n' };
  assert.deepEqual(codesOf(covering(["src/a.ts"], transitive, fixture)), [["work_impact_undecided", "test/a.test.ts"]], "a fixture between the test and its subject keeps it direct");
});

test("AT1 rows 5, 16 an addressed update is a reliable case of this inventory and leaves the rest of its file kept explicitly; a decision outside the inventory is refused", () => {
  const update: ImpactDecision = { entry: { file: "test/product.test.ts", case: ["CLI command interface persists commands"] }, decision: "update", requirement: "p-R1", expectation: "t-new" };
  const rest: ImpactDecision = { entry: { file: "test/product.test.ts", rest: true }, decision: "keep", requirement: "p-R1" };
  assert.deepEqual(codesOf(covering(["src/cli.ts", "test/product.test.ts"], [update])), [["work_impact_undecided", "test/product.test.ts"]], "row 5: the rest is not kept");
  const both = covering(["src/cli.ts", "test/product.test.ts"], [update, rest]);
  assert.deepEqual([codesOf(both), both.covered], [[], [{ test: "test/product.test.ts", by: "cases" }]], "row 16");
  const unknown = { ...update, entry: { file: "test/product.test.ts", case: ["no such case"] } };
  assert.deepEqual(codesOf(covering(["src/cli.ts", "test/product.test.ts"], [unknown, rest])), [["work_impact_case_unknown", "test/product.test.ts#no such case"]]);
  assert.deepEqual(codesOf(covering(["src/cli.ts"], [{ entry: { files: ["test/product.test.ts", "test/unrelated.test.ts"] }, decision: "keep", requirement: "p-R1" }])),
    [["work_impact_entry_foreign", "test/unrelated.test.ts"]], "a decision about another inventory's expectation is no decision of this work");
});

test("AT1 return №4124 P2-3: a test the work itself writes is its own direct entry — reached by nothing, or beside a new product file it does not import yet", () => {
  const files = { ...PRODUCT, "test/alone.test.ts": 'import test from "node:test";\ntest("old expectation", () => {});\n' };
  const own = deriveImpact(view(files), [{ work: "w", writes: ["test/alone.test.ts"] }]).works[0]!;
  assert.deepEqual(own.entries.map(entry => [entry.test, entry.direct, entry.via, entry.reaches]), [["test/alone.test.ts", true, ["write"], ["test/alone.test.ts"]]]);
  assert.deepEqual(impactCoverage(own, []).findings.map(item => [item.code, item.field]), [["work_impact_undecided", "test/alone.test.ts"]]);
  const updated = impactCoverage(own, [{ entry: { file: "test/alone.test.ts" }, decision: "update", requirement: "r", expectation: "t" }]);
  assert.deepEqual([updated.findings, updated.covered], [[], [{ test: "test/alone.test.ts", by: "file" }]], "the explicit update of its own test is a decision of this inventory");
  const beside = deriveImpact(view(files), [{ work: "w", writes: ["src/brand-new.ts", "test/alone.test.ts"] }]).works[0]!;
  assert.deepEqual(beside.entries.map(entry => entry.test), ["test/alone.test.ts"]);
});

test("AT1 return №4124 P2-4: a transition is the exact expression — resolving one of two on the same line leaves the other unknown", () => {
  const files = { ...PRODUCT, "src/a/one.ts": "export const one = 1;\n", "src/b/two.ts": "export const two = 2;\n",
    "test/load.test.ts": 'import test from "node:test";\ntest("loads", async () => { await import("../src/a/" + process.env.A); await import("../src/b/" + process.env.B); });\n' };
  const works = [{ work: "a", writes: ["src/a/one.ts"] }, { work: "b", writes: ["src/b/two.ts"] }];
  const open = deriveImpact(view(files), works).works;
  // Return №4186 P1: each work is asked about both — "../src/a/" + A may climb anywhere; each is one question of the snapshot.
  assert.deepEqual(open.map(work => work.unknowns.map(item => [item.file, item.line])), [[["test/load.test.ts", 2], ["test/load.test.ts", 2]], [["test/load.test.ts", 2], ["test/load.test.ts", 2]]]);
  const [first, second] = open[0]!.unknowns as [typeof open[0]["unknowns"][0], typeof open[0]["unknowns"][0]];
  assert.notEqual(first.text, second.text, "two expressions on one line");
  const after = deriveImpact(view(files), works, [{ file: first.file, line: first.line, site: first.site, resolves: [] }]).works;
  assert.deepEqual(after.map(work => work.unknowns.map(item => item.text)), [[second.text], [second.text]], "the answer about one proves nothing about the other");
});

test("AT1 return №4124 P2-5: a URL is known only when one literal is its whole first argument — a computed one with a literal prefix stays an unknown", () => {
  const files = { "src/a.ts": "export const a = 1;\n",
    "test/fixed.test.ts": 'import test from "node:test";\nconst at = new URL("../src/a.js", import.meta.url);\ntest("fixed", () => at);\n',
    "test/computed.test.ts": 'import test from "node:test";\nconst at = new URL("../src/" + process.env.NAME, import.meta.url);\ntest("computed", () => at.pathname);\n' };
  const work = deriveImpact(view(files), [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
  assert.deepEqual(work.entries.map(entry => [entry.test, entry.via]), [["test/fixed.test.ts", ["launch"]]]);
  assert.deepEqual(work.unknowns.map(item => [item.file, item.kind, item.candidates]), [["test/computed.test.ts", "dynamic-url", ["src/a.ts", "test/fixed.test.ts"]]]);
});

test("AT1 return №4135 P2-3: a transition is its exact place in the snapshot — two long expressions sharing their shown excerpt stay two, and resolving one leaves the other", () => {
  const prefix = "resolveRepositoryModule(repositoryRoot, selectedBackend, runtimeEnvironment, platformArchitecture, moduleRegistryVersion, enabledFeatures, selectedNamespace, resolutionOptions, ";
  const files = view({ "src/a.ts": "export const a=1;", "src/b.ts": "export const b=1;", "test/load.test.ts": `import(${prefix}left)); import(${prefix}right));` });
  const before = deriveImpact(files, [{ work: "w", writes: ["src/b.ts"] }]).works[0]!;
  assert.equal(before.unknowns.length, 2);
  assert.equal(before.unknowns[0]!.text, before.unknowns[1]!.text, "the shown excerpts are the same");
  assert.notDeepEqual(before.unknowns[0]!.site, before.unknowns[1]!.site, "their places are not");
  const [first, second] = before.unknowns as [typeof before.unknowns[0], typeof before.unknowns[0]];
  const after = deriveImpact(files, [{ work: "w", writes: ["src/b.ts"] }], [{ file: first.file, line: first.line, site: first.site, resolves: [] }]).works[0]!;
  assert.deepEqual(after.unknowns.map(item => item.site), [second.site], "the answer about the first proves nothing about the second");
  assert.deepEqual(impactCoverage(after, []).findings.map(item => item.code), ["work_impact_unresolved"]);
});

test("AT1 return №4143: declares reads the syntax tree of the parser — declarations, lists and binding patterns, export lists, methods — never a regular expression, a comment, a string or a call; a file the parser does not take proves nothing", () => {
  const read = (text: string, symbol: string, path = "src/a.ts") => declares(view({ [path]: text }), path, symbol);
  for (const [text, symbol, expected] of [
    ["export function commit() {}", "commit", "declared"], ["export default class Commit {}", "Commit", "declared"], ["export interface Commit {}", "Commit", "declared"],
    ["export type Commit = 1;", "Commit", "declared"], ["const commit = 1;", "commit", "declared"], ["export { a as commit } from './x.js';", "commit", "declared"],
    ["class S { commit(x: number): void { } }", "commit", "declared"], ["export const store = { commit() { return 1; } };", "commit", "declared"],
    ["export namespace Store { export function commit() {} }", "commit", "declared"],
    // №4143: a list and a binding pattern declare; a regular expression and a call followed by a block do not.
    ["const other = 1, commit = () => 1;", "commit", "declared"], ["const { commit } = require('./b.js');", "commit", "declared"],
    ["const [first, commit] = pair;", "commit", "declared"],
    ["export const pattern = /function commit/;", "commit", "absent"], ["commit()\n{ const x = 1; }", "commit", "absent"],
    ["// function commit() {}", "commit", "absent"], ["const s = 'function commit() {}';", "commit", "absent"], ["commit(1);", "commit", "absent"],
    ["export const recommit = 1;", "commit", "absent"], ["export { committed };", "commit", "absent"], ["import { commit } from './b.js';\ncommit();", "commit", "absent"],
  ] as const) assert.equal(read(text, symbol), expected, text);
  // A signature without a body, an ambient declaration: the point exists elsewhere, not here — unless the file is a declaration file.
  for (const text of ["export function commit(): void;", "export declare function commit(): void;", "declare const commit: () => void;",
    "export declare class Commit { commit(): void; }", "export class Store { commit(): void; }", "declare namespace Store { function commit(): void; }"])
    assert.equal(read(text, "commit"), "absent", text);
  assert.equal(read("export declare function commit(): void;", "commit", "src/a.d.ts"), "declared", "a declaration file declares types");
  assert.match((read("obj.commit() {}", "commit") as { unknown: string }).unknown, /^The parser does not take the file: /, "a parse diagnostic proves nothing");
  assert.match((read("def commit(): pass", "commit", "src/a.py") as { unknown: string }).unknown, /JavaScript and TypeScript only/, "another language proves nothing");
  const large = snapshotFiles(SNAPSHOT, ["src/big.ts"], new Map(), new Set(["src/big.ts"]));
  assert.deepEqual(declares(large, "src/big.ts", "commit"), { unknown: "The file exceeds the analyzed size" });
});

// ---- Return №4145/№4147: the transitions of JS/TS read from the syntax tree, nested expressions included ----
const SOURCE_A = { "src/a.ts": "export const a = 1;\n" };
const reached = (test: string, files: Record<string, string> = {}) =>
  deriveImpact(view({ ...SOURCE_A, ...files, "test/t.test.ts": test }), [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
test("AT1 return №4145: a transition inside a template substitution is found as one outside it — a literal import and a new URL are edges, a computed import is an addressed unknown", () => {
  const head = 'import test from "node:test";\n';
  for (const [label, inside, outside] of [
    ["await import", 'test("t", async () => { const value = `${(await import("../src/a.js")).a}`; void value; });\n',
      'test("t", async () => { const value = (await import("../src/a.js")).a; void value; });\n'],
    ["new URL", 'test("t", () => { const value = `${new URL("../src/a.js", import.meta.url)}`; void value; });\n',
      'test("t", () => { const value = new URL("../src/a.js", import.meta.url); void value; });\n'],
  ] as const) {
    const control = reached(head + outside), work = reached(head + inside);
    assert.deepEqual(control.entries.map(entry => [entry.test, entry.direct]), [["test/t.test.ts", true]], `${label}: the direct control`);
    assert.deepEqual(work.entries.map(entry => [entry.test, entry.direct, entry.via]), control.entries.map(entry => [entry.test, entry.direct, entry.via]), label);
    assert.deepEqual(impactCoverage(work, []).findings.map(item => item.code), ["work_impact_undecided"], `${label}: the test needs the work's decision`);
  }
  const computed = reached(head + 'test("t", async () => { const value = `${await import(process.env.M!)}`; void value; });\n');
  assert.deepEqual(computed.entries, []);
  assert.deepEqual(computed.unknowns.map(item => [item.file, item.line, item.kind, item.text, item.candidates]),
    [["test/t.test.ts", 2, "dynamic-import", "import(process.env.M!)", ["src/a.ts"]]], "the computed import inside the template is an addressed unknown");
  const source = head + 'test("t", async () => { const value = `${await import(process.env.M!)}`; void value; });\n';
  assert.equal(source.slice(computed.unknowns[0]!.site.start, computed.unknowns[0]!.site.end), "import(process.env.M!)", "its exact place");
  assert.deepEqual(impactCoverage(computed, []).findings.map(item => [item.code, item.field]),
    [["work_impact_unresolved", `test/t.test.ts:2#${computed.unknowns[0]!.site.start}-${computed.unknowns[0]!.site.end}`]]);
});
test("AT1 return №4145: a regular expression, a comment or a string that only shows an import is no transition — no edge, no unknown", () => {
  for (const text of [
    'const pattern = /import\\("\\.\\.\\/src\\/a\\.js"\\)/;\nconst other = /require\\(name\\)/;\nvoid pattern; void other;\n',
    '// import("../src/a.js")\n/* await import(process.env.M) */\nexport {};\n',
    'const shown = "import(\\"../src/missing\\")";\nconst computed = `import(${"x"})`;\nvoid shown; void computed;\n',
  ]) {
    const work = reached(text);
    assert.deepEqual([work.entries, work.unknowns], [[], []], text);
  }
  // Return №4186 P2: a word of a string that is a path to a file of the tree is a literal launch or read — one more consumer,
  // the cautious side; the shown import itself asks nothing.
  const shown = reached('const shown = "import(\\"../src/a\\")";\nvoid shown;\n');
  assert.deepEqual([shown.entries.map(entry => entry.via), shown.unknowns], [[["launch"]], []]);
});
test("AT1 return №4147: a file the parser takes only with a diagnostic, or a package file JSON does not take, is one addressed unknown of the whole file — its answer through the door decides it; another content is another question", () => {
  const broken = 'import test from "node:test";\nconst = ;\ntest("t", () => {});\n';
  const work = reached(broken);
  assert.deepEqual(work.unknowns.map(item => [item.file, item.line, item.kind, item.candidates, item.site.start, item.site.end]),
    [["test/t.test.ts", 2, "unparsed", ["src/a.ts"], 0, broken.length]]);
  assert.match(work.unknowns[0]!.text, /^The parser does not take the file: /);
  const answered = (resolves: string[]) => deriveImpact(view({ ...SOURCE_A, "test/t.test.ts": broken }), [{ work: "w", writes: ["src/a.ts"] }],
    [{ file: "test/t.test.ts", line: 2, site: work.unknowns[0]!.site, resolves }]).works[0]!;
  assert.deepEqual(answered(["src/a.ts"]).entries.map(entry => [entry.test, entry.via, entry.addressable]), [["test/t.test.ts", ["resolution"], false]],
    "resolved to the file: an entry, decided by file");
  assert.deepEqual([answered([]).entries, answered([]).unknowns], [[], []], "resolved to nothing");
  const changed = deriveImpact(view({ ...SOURCE_A, "test/t.test.ts": broken + "// more\n" }), [{ work: "w", writes: ["src/a.ts"] }],
    [{ file: "test/t.test.ts", line: 2, site: work.unknowns[0]!.site, resolves: [] }]).works[0]!;
  assert.equal(changed.unknowns.length, 1, "an answer about another content resolves nothing");
  // The literal transitions of the recovered tree stay edges: a broken file that imports the work's file is its consumer.
  assert.deepEqual(reached('import { a } from "../src/a.js";\nconst = ;\n').entries.map(entry => [entry.test, entry.via]), [["test/t.test.ts", ["import"]]]);
  const pkg = deriveImpact(view({ ...SOURCE_A, "package.json": '{ "scripts": { "start": "node src/a.js" ' }), [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
  assert.deepEqual(pkg.unknowns.map(item => [item.file, item.kind, item.text]), [["package.json", "unparsed", "The package file is not JSON"]]);
});
test("AT1 return №4147: the parser's exact version is part of the inventory's basis", () => {
  const inventory = deriveImpact(view(SOURCE_A), [{ work: "w", writes: ["src/a.ts"] }]);
  assert.equal(inventory.parser, "typescript@6.0.3");
});

// ---- Return №4155/№4160: not recognized — unknown; the class of syntactic forms closed by the principle ----
const kindsOf = (text: string, files: Record<string, string> = {}) => {
  const work = reached(text, files);
  return { edges: work.entries.map(entry => entry.via.join("+")), unknowns: work.unknowns.map(item => [item.kind, text.slice(item.site.start, item.site.end)]) };
};
test("AT1 return №4155 п.1: a transparent wrapper changes no transition — it is recognized through the wrapper, its place the whole original expression", () => {
  for (const [control, wrapped, kind] of [
    ['new URL("../src/" + process.env.M + ".js", import.meta.url);', 'new URL("../src/" + process.env.M + ".js", (import.meta.url));', "dynamic-url"],
    ['new URL("../src/" + process.env.M + ".js", import.meta.url);', 'new (URL)("../src/" + process.env.M + ".js", import.meta.url);', "dynamic-url"],
    ["require(process.env.M);", "(require)(process.env.M);", "dynamic-require"],
    ["require(process.env.M);", "(0, require)(process.env.M);", "dynamic-require"],
    ["require(process.env.M);", "(require as NodeRequire)(process.env.M);", "dynamic-require"],
  ] as const) {
    assert.deepEqual(kindsOf(control), { edges: [], unknowns: [[kind, control.slice(0, -1)]] }, control);
    assert.deepEqual(kindsOf(wrapped), { edges: [], unknowns: [[kind, wrapped.slice(0, -1)]] }, wrapped);
  }
  for (const text of ['(await import(("../src/a.js" as string))).a;', 'require(("../src/a.js"));', 'new (URL)("../src/a.js", (import.meta.url as string));'])
    assert.deepEqual(kindsOf(text).unknowns, [], `${text}: a wrapped literal is an edge`);
  assert.deepEqual(kindsOf('new (URL)("../src/a.js", (import.meta.url as string));').edges, ["launch"]);
});
test("AT1 return №4160 п.1: every possible transition of the code is an edge, an addressed unknown, or a recognized value of the file's own place — never nothing; a mention in a string, a comment, a regular expression or a type is none", () => {
  const unknownOf = (text: string) => kindsOf(text).unknowns;
  for (const [text, expected] of [
    ["const r = require; r(process.env.M);", [["unrecognized", "require"]]],
    ["globalThis.require(process.env.M);", [["dynamic-require", "globalThis.require(process.env.M)"]]],
    ["require<any>(process.env.M);", [["dynamic-require", "require<any>(process.env.M)"]]],
    ["import.meta.resolve(process.env.M!);", [["dynamic-import", "import.meta.resolve(process.env.M!)"]]],
    ['(import.meta as any).glob("../src/*.ts");', [["unrecognized", '(import.meta as any).glob("../src/*.ts")']]],
    ["Module.createRequire(import.meta.url)(process.env.M);", [["dynamic-require", "Module.createRequire(import.meta.url)(process.env.M)"]]],
    ["const req = createRequire(import.meta.url); req(process.env.M);", [["dynamic-require", "createRequire(import.meta.url)"]]],
    ["require.resolve(process.env.M);", [["dynamic-require", "require.resolve(process.env.M)"]]],
    ["require`x`;", [["unrecognized", "require"]]],
    ["new URL(process.env.M!);", [["dynamic-url", "new URL(process.env.M!)"]]],
    ["const base = pathToFileURL(process.cwd()); new URL(process.env.M!, base);", [["dynamic-url", "new URL(process.env.M!, base)"]]],
    ["const s = String(import.meta.url);", [["unrecognized", "import.meta.url"]]],
    // Return №4163 п.1: an absolute spec replaces the base — a remote base proves nothing about a computed or file: spec.
    ['new URL(process.env.M!, "https://example.com/base/");', [["dynamic-url", 'new URL(process.env.M!, "https://example.com/base/")']]],
    ['new URL("file:///snapshot/src/a.ts", "https://example.com/base/");', [["dynamic-url", 'new URL("file:///snapshot/src/a.ts", "https://example.com/base/")']]],
    ['new URL("file:///snapshot/src/a.ts", import.meta.url);', [["dynamic-url", 'new URL("file:///snapshot/src/a.ts", import.meta.url)']]],
    ['new URL("/src/a.js", import.meta.url);', [["dynamic-url", 'new URL("/src/a.js", import.meta.url)']]],
    // Return №4163 п.2: a member reference to the constructor is a reference too.
    ["const C = globalThis.URL; new C(process.env.M!, import.meta.url);", [["unrecognized", "globalThis.URL"], ["unrecognized", "import.meta.url"]]],
    ["const ok = URL.canParse(process.env.M!);", [["unrecognized", "URL.canParse(process.env.M!)"]]],
    // Return №4163 п.4: a literal inside a computation proves nothing about its result.
    ['const resolveModule = (_: string) => "../src/" + "a.js"; await import(resolveModule("backend"));', [["dynamic-import", 'import(resolveModule("backend"))']]],
    ['require(resolveModule("backend"));', [["dynamic-require", 'require(resolveModule("backend"))']]],
    ['new URL(resolveModule("backend"), import.meta.url);', [["dynamic-url", 'new URL(resolveModule("backend"), import.meta.url)']]],
    ["const U = URL; new U(process.env.M!, import.meta.url);", [["unrecognized", "URL"], ["unrecognized", "import.meta.url"]]],
    // One cause per transition: the computed specifier of an unknown asks nothing more inside it.
    ["await import(new URL(process.env.M!, import.meta.url).href);", [["dynamic-import", "import(new URL(process.env.M!, import.meta.url).href)"]]],
    ["await import(require.resolve(process.env.M!));", [["dynamic-import", "import(require.resolve(process.env.M!))"]]],
  ] as const) assert.deepEqual(unknownOf(text), expected, text);
  assert.deepEqual(kindsOf('await import(new URL("../src/a.js", import.meta.url).href);'), { edges: ["import+launch"], unknowns: [] }, "the href of a URL a literal names is the file (return №4181)");
  for (const [text, edges] of [
    ['import.meta.resolve("../src/a.js");', ["import"]], ['createRequire(import.meta.url)("../src/a.js");', ["import"]], ['require.resolve("../src/a.js");', ["import"]],
    ['const w = new Worker(new URL("../src/a.js", import.meta.url));', ["launch"]],
  ] as const) assert.deepEqual(kindsOf(text), { edges, unknowns: [] }, text);
  // One cause per transition, and the recognized values of the file's own place load nothing.
  for (const text of [
    'const here = fileURLToPath(import.meta.url); const d = import.meta.dirname; const f = import.meta.filename; if (import.meta.url === process.argv[1]) {}',
    'const host = "h"; new URL("api/x", `http://${host}`); new URL("https://example.com/x"); new URL("../x", "http://localhost/a/");',
    'const p = /require\\(x\\)|import\\.meta\\.url/; // import(process.env.M)\nconst q = "import.meta.url require(x) new URL(x)";',
    'let r: typeof require; const ok = (x: unknown) => x instanceof URL; const o = { require: true };',
  ]) assert.deepEqual(kindsOf(text), { edges: [], unknowns: [] }, text);
  assert.deepEqual(kindsOf('const typescript = createRequire(import.meta.url).resolve("typescript"); const require = createRequire(import.meta.url); require("node:fs");',
    { "package.json": JSON.stringify({ dependencies: { typescript: "6.0.3" } }) }), { edges: [], unknowns: [] }, "a declared registry package and a built-in leave the tree by proof");
});
test("AT1 return №4155 п.2, №4160 п.2: the five forms declare; a place that may declare in a form the analysis does not read, or an opaque export, is unknown — absence only where every form is read", () => {
  const read = (text: string) => declares(view({ "src/a.ts": text }), "src/a.ts", "commit");
  for (const text of [
    "interface Writer { commit(): number; } export const service = { commit() { return 1; } } satisfies Writer;",
    "export const service = ({ commit() { return 1; } } as const);", "export default { commit() { return 1; } };",
    "export namespace A.B { export function commit() { return 1; } }", 'export const service = { ["commit"]() { return 1; } };',
    "export const service = { commit: impl };", 'export * as commit from "./b.js";', "module.exports = { commit() { return 1; } };", "exports.commit = () => 1;",
    "export default class { commit() {} }",
  ]) assert.equal(read(text), "declared", text);
  for (const [text, reason] of [
    ['export * from "./b.js";', /exports through a form/], ["export default createStore();", /exports through a form/], ['module.exports = require("./b.js");', /exports through a form/],
    ["Object.assign(exports, impl);", /exports through a form/], ["export function make() { return { commit() { return 1; } }; }", /may declare commit/],
    ["Store.prototype.commit = function () {};", /may declare commit/], ['Object.defineProperty(target, "commit", { value: 1 });', /may declare commit/],
    ["interface Writer { commit(): void }", /may declare commit/], ["export const service = new (class { commit() {} })();", /may declare commit/],
    // Return №4163 п.3: a computed name, a spread, an inheritance or a reflective write makes the file no fully static container.
    ['export const service = { ["com" + "mit"]() { return 1; } };', /exports through a form|does not read/], ['import { base } from "./b.js"; export const service = { ...base };', /does not read/],
    ['import { Base } from "./b.js"; export class Store extends Base {}', /does not read/], ["export const service = {}; service[key()] = () => 1;", /does not read/],
    ['export const service = Object.fromEntries([["commit", 1]]);', /does not read|may declare/],
  ] as const) assert.match((read(text) as { unknown: string }).unknown, reason, text);
  for (const text of ['commit(); obj.commit(); import { commit } from "./b.js";', "function f(commit: number) { const local = commit; }",
    "function g() { const commit = 1; return commit; }", "export function commit(): void;", "declare const commit: () => void;", "export const pattern = /function commit/;"])
    assert.equal(read(text), "absent", text);
});
test("AT1 return №4155 п.3: an accepted answer applies its edges whatever unknown it answers — an unparsed package file resolved to a source links it, the test that imports the package file enters the inventory", () => {
  const files = view({ ...SOURCE_A, "package.json": '{"scripts":', "test/load.test.ts": 'import pkg from "../package.json" with { type: "json" };\nvoid pkg;\n' });
  const before = deriveImpact(files, [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
  const [unknown] = before.unknowns;
  assert.deepEqual([unknown!.file, unknown!.kind], ["package.json", "unparsed"]);
  const after = deriveImpact(files, [{ work: "w", writes: ["src/a.ts"] }], [{ file: "package.json", line: 0, site: unknown!.site, resolves: ["src/a.ts"] }]).works[0]!;
  assert.deepEqual([after.unknowns, after.consumers, after.entries.map(entry => [entry.test, entry.direct, entry.via])],
    [[], ["package.json"], [["test/load.test.ts", false, ["import"]]]]);
  assert.deepEqual(impactCoverage(after, []).findings.map(item => [item.code, item.field]), [["work_impact_undecided", "test/load.test.ts"]]);
});
test("AT1 return №4155 п.4: a file of a code kind the parser does not read is an addressed unknown of the whole file — the inventory and the test map never throw", () => {
  for (const extension of ["mtsx", "ctsx", "mjsx", "cjsx"]) {
    const file = `test/load.${extension}`, files = view({ ...SOURCE_A, [file]: 'import "../src/a.js";' });
    const work = deriveImpact(files, [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
    assert.deepEqual(work.unknowns.map(item => [item.file, item.kind, item.text]), [[file, "unparsed", `The parser does not read files of the kind .${extension}`]]);
    assert.doesNotThrow(() => deriveTestMap(files));
    assert.match((declares(files, file, "a") as { unknown: string }).unknown, /does not read files of the kind/);
  }
});

// ---- Return №4163/№4170: a literal leaves the tree only by proof ----
const bareOf = (specifier: string, files: Record<string, string>) => {
  const work = deriveImpact(view({ ...SOURCE_A, ...files, "test/t.test.ts": `import x from "${specifier}";\nvoid x;\n` }), [{ work: "w", writes: ["src/a.ts"] }]).works[0]!;
  return { edges: work.entries.map(entry => entry.via.join("+")), unknowns: work.unknowns.map(item => [item.kind, item.text]) };
};
test("AT1 return №4170 п.4: a bare name passes the snapshot's local mappings first — Codex's util-lib probe resolves into the tree; a declared registry package or a built-in leaves it; a package import, a local or own package, an unread mapping, an undeclared name are unknown", () => {
  const declared = JSON.stringify({ name: "product", dependencies: { "util-lib": "1.0.0", linked: "file:../linked", ws: "workspace:*" } });
  const config = (options: Record<string, unknown>, more: Record<string, unknown> = {}) => JSON.stringify({ ...more, compilerOptions: options });
  const none = { edges: [], unknowns: [] };
  assert.deepEqual(bareOf("util-lib", { "package.json": declared, "tsconfig.json": config({ paths: { "util-lib": ["./src/a.ts"] } }) }), { edges: ["import"], unknowns: [] },
    "paths maps the declared dependency into the tree (TypeScript 6.0.3 resolves it to src/a.ts)");
  assert.deepEqual(bareOf("@app/a", { "package.json": declared, "tsconfig.json": config({ baseUrl: ".", paths: { "@app/*": ["src/*"] } }) }), { edges: ["import"], unknowns: [] });
  assert.deepEqual(bareOf("src/a", { "package.json": declared, "tsconfig.json": config({ baseUrl: "." }) }), { edges: ["import"], unknowns: [] }, "baseUrl");
  assert.deepEqual(bareOf("util-lib", { "package.json": declared, "tsconfig.json": config({ paths: { "util-lib": ["./src/missing.ts"] } }) }), none,
    "a mapping none of whose targets is in the tree falls back: the declared registry package");
  assert.deepEqual(bareOf("node:fs", {}), none);
  assert.deepEqual(bareOf("fs/promises", {}), none);
  assert.deepEqual(bareOf("https://example.com/m.js", {}), none);
  const unknown = (specifier: string, files: Record<string, string>) => assert.deepEqual(bareOf(specifier, files).unknowns, [["unresolved", `import x from "${specifier}";`]], specifier);
  unknown("undeclared", { "package.json": declared });
  unknown("#internal", { "package.json": declared });
  unknown("product/sub", { "package.json": declared });
  unknown("sibling", { "package.json": declared, "packages/sibling/package.json": JSON.stringify({ name: "sibling" }) });
  // A local package wins over the same name declared from a registry: the workspace resolves it into the tree.
  unknown("sibling", { "package.json": JSON.stringify({ dependencies: { sibling: "1.0.0" } }), "packages/sibling/package.json": JSON.stringify({ name: "sibling" }) });
  unknown("linked", { "package.json": declared });
  unknown("ws", { "package.json": declared });
  unknown("util-lib", { "package.json": declared, "tsconfig.json": config({}, { extends: "./base.json" }) });
  unknown("util-lib", { "package.json": declared, "vite.config.ts": "export default {};" });
  unknown("file:///snapshot/src/a.ts", {});
});
test("AT1 return №4170 п.4: a relative literal is absent only after the supported extensions and the proved build mapping, and only where the tree holds its directory", () => {
  const of = (specifier: string, files: Record<string, string> = {}) => bareOf(specifier, files);
  assert.deepEqual(of("../src/a.js"), { edges: ["import"], unknowns: [] }, "the .js of a .ts source");
  assert.deepEqual(of("../src/missing.js"), { edges: [], unknowns: [] }, "the tree holds src/: no supported name of the file is in it");
  assert.deepEqual(of("../dist/src/a.js").unknowns, [["unresolved", 'import x from "../dist/src/a.js";']], "an output the tree does not hold, no mapping proved");
  assert.deepEqual(of("../dist/src/a.js", { "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }) }), { edges: ["import"], unknowns: [] });
  assert.deepEqual(of("./gone/x.js").unknowns, [["unresolved", 'import x from "./gone/x.js";']], "a directory the tree does not hold");
  // A mere string naming a path is no load: unresolved, it is nothing.
  assert.deepEqual(reached('const shown = "../src/missing.js";\nvoid shown;\n').unknowns, []);
  // The proved build runs the test from dist/test: a path is also read from there, an output place by its source.
  const built = { "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }) };
  const url = (spec: string) => kindsOf(`const at = new URL("${spec}", import.meta.url);\nvoid at;\n`, built);
  assert.deepEqual(url("../../src/a.js"), { edges: ["launch"], unknowns: [] }, "from dist/test the source file of the tree");
  assert.deepEqual(url("../../src/"), { edges: [], unknowns: [] }, "a directory of the tree is no file a URL names");
  assert.deepEqual(url("./"), { edges: [], unknowns: [] });
  assert.deepEqual(url("../../../outside/a.js"), { edges: [], unknowns: [] }, "beyond the root from every place: outside the tree");
  assert.deepEqual(kindsOf('const m = await import("../src/");\nvoid m;\n', built).unknowns, [["unresolved", 'import("../src/")']], "a load of a directory goes through a manifest not read");
});
test("AT1 return №4163 п.4: the unknown of a file already known to consume stays — its answer may make it direct or reach more", () => {
  const work = reached('import { a } from "../src/a.js";\nconst more = await import(process.env.M!);\nvoid a; void more;\n');
  assert.deepEqual([work.entries.map(entry => entry.test), work.unknowns.map(item => [item.file, item.kind])], [["test/t.test.ts"], [["test/t.test.ts", "dynamic-import"]]]);
});
test("AT1 №4170: the inventory saves its declared boundary — what it does not establish", () => {
  assert.deepEqual(deriveImpact(view(SOURCE_A), [{ work: "w", writes: ["src/a.ts"] }]).boundary, ["computed-process-targets", "computed-file-reads", "future-file-consumers"]);
});

// ---- Return №4173–№4182: the adversarial sweep G1–G15 ----
const work = (rows: Record<string, string>, writes: string[], resolutions: Parameters<typeof deriveImpact>[2] = []) =>
  deriveImpact(view(rows), [{ work: "w", writes }], resolutions).works[0]!;
const shape = (row: ReturnType<typeof work>) => ({ entries: row.entries.map(entry => entry.test), unknowns: row.unknowns.map(item => [item.kind, item.candidates]) });
test("AT1 sweep G1, return №4186 P1: a computed specifier is one question of the snapshot for every work — its candidates are every file, no text around the computed part bounds them", () => {
  const rows = { "src/cli/run.ts": "export const run = (n: string) => import(`./commands/${n}.js`);", "src/cli/commands/build.ts": 'import { a } from "../../a.js";\nexport default a;',
    "src/a.ts": "export const a = 1;", "src/other.ts": "export const o = 1;", "test/cli.test.ts": 'import { run } from "../src/cli/run.js";\nrun("build");' };
  const all = Object.keys(rows).filter(path => path !== "src/cli/run.ts").sort();
  for (const writes of ["src/cli/commands/build.ts", "src/a.ts", "src/other.ts"])
    assert.deepEqual(shape(work(rows, [writes])).unknowns, [["dynamic-import", all]], writes);
  // The probes of №4183: '..' in the computed part and a ?query tail — the true target stays a candidate, the question stays.
  const climbing = { "src/cli.js": "exports.run = (n) => require(__dirname + '/../lib/' + n);", "lib/add.js": "module.exports = 1;", "lib/sub/x.js": "module.exports = 2;",
    "test/a.test.js": "const { run } = require('../src/cli.js'); run('add');" };
  assert.ok(work(climbing, ["lib/add.js"]).unknowns.some(item => item.candidates.includes("lib/add.js")));
  const query = { "src/a.json": "{}", "test/q.test.mjs": "const at = new URL(`../src/a.json?x=${Date.now()}`, import.meta.url); void at;" };
  assert.deepEqual(shape(work(query, ["src/a.json"])).unknowns, [["dynamic-url", ["src/a.json"]]]);
  assert.deepEqual(work({ "src/a.js": "export const a = 1;", "test/q.test.mjs": "import { a } from '../src/a.js?v=1';\nvoid a;" }, ["src/a.js"]).entries.map(entry => entry.test), ["test/q.test.mjs"],
    "an ESM literal names its file without the query");
});
test("AT1 sweep G2: the supported spellings resolve a relative literal — .jsx, an index, a .d.ts, a .json; a directory load and a symbolic link are unknown, an unmapped output too", () => {
  const edge = (rows: Record<string, string>, writes: string) => work(rows, [writes]).entries.map(entry => entry.test);
  assert.deepEqual(edge({ "src/Button.jsx": "export default 1;", "src/Button.test.jsx": 'import B from "./Button";\nvoid B;' }, "src/Button.jsx"), ["src/Button.test.jsx"]);
  assert.deepEqual(edge({ "src/Button.jsx": "export default 1;", "src/Button.test.jsx": 'import B from "./Button.js";\nvoid B;' }, "src/Button.jsx"), ["src/Button.test.jsx"], ".js of a .jsx");
  assert.deepEqual(edge({ "src/components/index.tsx": "export const c = 1;", "test/page.test.ts": 'import { c } from "../src/components";\nvoid c;' }, "src/components/index.tsx"), ["test/page.test.ts"]);
  assert.deepEqual(edge({ "src/types.d.ts": "export type T = 1;", "test/t.test.ts": 'import type { T } from "../src/types.js";\nlet t: T;' }, "src/types.d.ts"), ["test/t.test.ts"]);
  assert.deepEqual(edge({ "config/default.json": "{}", "test/c.test.ts": 'import c from "../config/default.json" with { type: "json" };\nvoid c;' }, "config/default.json"), ["test/c.test.ts"]);
  assert.deepEqual(edge({ "src/a.ts": "export const a = 1;", "src/cli.ts": 'import { a } from "./a.js"; a;', "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } }),
    "test/c.test.ts": 'import { spawnSync } from "node:child_process";\nspawnSync("node", ["dist/cli.js"]);' }, "src/a.ts"), ["test/c.test.ts"], "the output of another layout by the config");
  assert.deepEqual(shape(work({ "lib/index.js": "module.exports = 1;", "lib/package.json": '{"main":"main.js"}', "lib/main.js": "module.exports = 2;",
    "test/l.test.js": 'const l = require("../lib");\nvoid l;' }, ["lib/main.js"])).unknowns.map(item => item[0]), [], "an index found by its spelling is an edge");
  const linked = { ...snapshotFiles(SNAPSHOT, ["src/a.ts", "src/alias.ts", "test/a.test.ts"], new Map([["src/a.ts", "export const a = 1;"], ["test/a.test.ts", 'import { a } from "../src/alias.js";\nvoid a;']])),
    links: new Set(["src/alias.ts"]) };
  assert.deepEqual(deriveImpact(linked, [{ work: "w", writes: ["src/a.ts"] }]).works[0]!.unknowns.map(item => [item.file, item.kind, item.text]),
    [["src/alias.ts", "unparsed", "A symbolic link the analysis does not follow"]]);
});
test("AT1 sweep G4: a literal launch or read is an edge from the file and from the working directory; a command line's words; npm run, npm test and a chain of scripts; a script the package does not have is unknown", () => {
  const A = "export const a = 1;", G = 'import { a } from "../src/a.js"; a;';
  const entries = (rows: Record<string, string>, writes = "src/a.ts") => work(rows, [writes]).entries.map(entry => entry.test);
  assert.deepEqual(entries({ "src/a.ts": A, "scripts/gen.mjs": G, "test/c.test.ts": 'import { fork } from "node:child_process";\nfork("./scripts/gen.mjs");' }), ["test/c.test.ts"]);
  assert.deepEqual(entries({ "src/a.ts": A, "scripts/gen.mjs": G, "test/c.test.ts": 'import { execSync } from "node:child_process";\nexecSync("node scripts/gen.mjs --flag");' }), ["test/c.test.ts"]);
  const pkg = JSON.stringify({ scripts: { gen: "node scripts/gen.mjs", all: "npm run gen && echo done", test: "node --test test/*.test.ts" } });
  assert.deepEqual(entries({ "src/a.ts": A, "scripts/gen.mjs": G, "package.json": pkg, "test/c.test.ts": 'import { execSync } from "node:child_process";\nexecSync("npm run all");' }), ["test/c.test.ts"], "through the chain all → gen");
  assert.deepEqual(entries({ "src/a.ts": A, "scripts/gen.mjs": G, "package.json": pkg, "test/c.test.ts": 'import { spawnSync } from "node:child_process";\nspawnSync("npm", ["run", "gen"]);' }), ["test/c.test.ts"]);
  assert.deepEqual(entries({ "test/fixtures/d.json": "{}", "test/d.test.ts": 'import { readFileSync } from "node:fs";\nreadFileSync("test/fixtures/d.json", "utf8");' }, "test/fixtures/d.json"), ["test/d.test.ts"]);
  assert.deepEqual(shape(work({ "src/a.ts": A, "package.json": pkg, "test/c.test.ts": 'import { execSync } from "node:child_process";\nexecSync("npm run missing");' }, ["src/a.ts"])).unknowns.map(item => item[0]), ["unresolved"]);
});
test("AT1 sweep G5: the candidates of a module load are every file of the snapshot, a JSON locale included — the true answer is admissible and becomes the edge", () => {
  const rows = { "src/locales/en.json": "{}", "src/i18n.ts": "export const m = (l: string) => require(`./locales/${l}.json`);", "test/i18n.test.ts": 'import { m } from "../src/i18n.js";\nm("en");' };
  const open = work(rows, ["src/locales/en.json"]);
  assert.deepEqual(shape(open).unknowns, [["dynamic-require", ["src/locales/en.json", "test/i18n.test.ts"]]]);
  assert.deepEqual(work(rows, ["src/locales/en.json"], [{ file: "src/i18n.ts", line: 1, site: open.unknowns[0]!.site, resolves: ["src/locales/en.json"] }]).entries.map(entry => entry.test), ["test/i18n.test.ts"]);
});
test("AT1 sweep G6–G9: a file nested deeper than the walk is a typed unknown; a component of another language on the way is unknown; a triple-slash reference and a JSDoc import are edges; code from a string is unknown", () => {
  const deep = `export const x = ${"[".repeat(20000)}${"]".repeat(20000)};`;
  assert.doesNotThrow(() => deriveTestMap(view({ "src/deep.ts": deep, "test/d.test.ts": 'import { x } from "../src/deep.js";\nvoid x;' })));
  assert.match((work({ "src/deep.ts": deep, "src/a.ts": "export const a = 1;", "test/d.test.ts": 'import { x } from "../src/deep.js";\nvoid x;' }, ["src/a.ts"])
    .unknowns.find(item => item.file === "src/deep.ts")?.text ?? ""), /nests deeper|does not take/);
  assert.deepEqual(shape(work({ "src/a.ts": "export const a = 1;", "src/Comp.vue": '<script>import { a } from "./a.js"</script>', "test/c.test.ts": 'import C from "../src/Comp.vue";\nvoid C;' }, ["src/a.ts"])).unknowns,
    [["unparsed", ["src/a.ts", "test/c.test.ts"]]]);
  assert.deepEqual(work({ "src/a.ts": "export const a = 1;", "test/r.test.ts": '/// <reference path="../src/a.ts" />\nexport {};' }, ["src/a.ts"]).entries.map(entry => entry.test), ["test/r.test.ts"]);
  assert.deepEqual(work({ "src/a.js": "export const a = 1;", "test/j.test.js": "/** @type {import('../src/a.js').a} */\nlet x;\nvoid x;" }, ["src/a.js"]).entries.map(entry => entry.test), ["test/j.test.js"]);
  for (const code of ['const f = new Function("return import(process.env.M)");', '(0, eval)("import(process.env.M)");'])
    assert.deepEqual(shape(work({ "src/a.ts": "export const a = 1;", "test/e.test.ts": code }, ["src/a.ts"])).unknowns.map(item => item[0]), ["unrecognized"], code);
});
test("AT1 sweep G10–G12: default, parameter properties and export import declare; a qualified point is proved by its owner's member — never by the first name", () => {
  const read = (text: string, symbol: string) => declares(view({ "src/a.ts": text }), "src/a.ts", symbol);
  assert.equal(read("export default function () { return 1; }", "default"), "declared");
  assert.equal(read("export default { commit() { return 1; } };", "default"), "declared");
  assert.equal(read("export class Store { constructor(private readonly commit: () => void) {} }", "commit"), "declared");
  assert.equal(read('export import helpers = require("./helpers");', "helpers"), "declared");
  assert.equal(read("export class Store { commit() { return 1; } }", "Store.commit"), "declared");
  assert.equal(typeof read("export class Store { save() { return 1; } }", "Store.commit"), "object", "the owner exists, the member is not proved: unknown, never present");
  assert.equal(read("export class Other { commit() { return 1; } }", "Store.commit"), "absent");
});
test("AT1 sweep G13–G15: the tests are what node --test selects for a package run — its defaults, files and globs on the exact tree; another runner or an unsettled argument is an unknown selection whose answer makes tests; a preload reaches the tests of its run; a configuration reaches every file", () => {
  const A = "export const a = 1;", uses = 'import { a } from "../src/a.js"; a;';
  const tests = (scripts: Record<string, string>, extra: Record<string, string> = {}) =>
    work({ "src/a.ts": A, "package.json": JSON.stringify({ scripts }), "test/parse.js": uses, "a-test.mjs": 'import { a } from "./src/a.js"; a;', "test/helper.ts": uses, ...extra }, ["src/a.ts"]);
  assert.deepEqual(tests({ test: "node --test" }).entries.map(entry => entry.test), ["a-test.mjs", "test/helper.ts", "test/parse.js"], "node 22.23.1 defaults, checked on a sealed example");
  assert.deepEqual(tests({ test: "node --test test/*.js" }).entries.map(entry => entry.test), ["test/parse.js"], "an explicit selection is not widened by the defaults");
  const vitest = tests({ test: "vitest run" });
  assert.deepEqual(vitest.unknowns.map(item => [item.file, item.kind]), [["package.json#scripts.test", "selection"]]);
  const answered = work({ "src/a.ts": A, "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "test/parse.js": uses, "a-test.mjs": 'import { a } from "./src/a.js"; a;', "test/helper.ts": uses },
    ["src/a.ts"], [{ file: "package.json#scripts.test", line: 0, site: vitest.unknowns[0]!.site, resolves: ["test/parse.js"] }]);
  assert.deepEqual([answered.unknowns, answered.entries.map(entry => entry.test)], [[], ["test/parse.js"]], "the answer makes test entries");
  assert.deepEqual(impactCoverage(answered, []).findings.map(item => item.code), ["work_impact_undecided"]);
  assert.deepEqual(tests({ test: "node --test test/" }).unknowns.map(item => item.kind), ["selection"], "a directory argument is unsettled across node versions");
  const preload = work({ "src/a.ts": A, "test/setup.mjs": uses, "package.json": JSON.stringify({ scripts: { test: "node --import ./test/setup.mjs --test test/*.test.mjs" } }),
    "test/a.test.mjs": 'import test from "node:test";\ntest("x", () => {});' }, ["src/a.ts"]);
  assert.deepEqual(preload.entries.map(entry => [entry.test, entry.direct]), [["test/a.test.mjs", true]], "the preload of its run reaches the test");
  const config = work({ "src/a.ts": A, "tsconfig.json": "{}", "package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.ts" } }), "test/a.test.ts": uses }, ["tsconfig.json"]);
  assert.deepEqual(config.entries.map(entry => [entry.test, entry.direct, entry.via]), [["test/a.test.ts", false, ["config"]]], "a work that writes the configuration reaches every test, transitively");
  assert.deepEqual(work({ "src/a.ts": A, "test/parse.js": uses }, ["src/a.ts"]).unknowns.map(item => [item.file, item.kind]), [[".", "selection"]], "no run defined, the default would select more than the names");
});
test("AT1 №4181 G1: the href of a URL a literal names is the file — import(new URL('…', import.meta.url).href) is an edge, not a question", () => {
  assert.deepEqual(shape(work({ "src/a.ts": "export const a = 1;", "test/u.test.ts": 'const m = await import(new URL("../src/a.js", import.meta.url).href);\nvoid m;' }, ["src/a.ts"])),
    { entries: ["test/u.test.ts"], unknowns: [] });
});

// ---- Return №4186 (Codex №4183 + second sweep): P1–P5 ----
const ent = (rows: Record<string, string>, writes: string[], resolutions: Parameters<typeof deriveImpact>[2] = []) => {
  const row = work(rows, writes, resolutions);
  return { e: row.entries.map(entry => entry.test), u: row.unknowns.map(item => `${item.kind}@${item.file}`) };
};
test("AT1 return №4186 P1: no text around a computed part bounds its path — '..' in the part, a root-anchored tail, a ?query; an ESM literal names its file without the query, require keeps it literal", () => {
  const pkg = { "package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.js" } }) };
  const climb = ent({ ...pkg, "lib/add.js": "module.exports = 1;", "src/cli.js": "exports.run = (n) => require(__dirname + '/../lib/' + n);",
    "test/a.test.js": "const { run } = require('../src/cli.js'); run('add');" }, ["lib/add.js"]);
  assert.deepEqual(climb.u, ["dynamic-require@src/cli.js"]);
  const cwd = work({ ...pkg, "src/a.js": "exports.a = 1;", "pkg/src/a.js": "exports.a = 1;", "t/c.test.js": "require(`${process.cwd()}/src/a.js`);" }, ["src/a.js"]);
  assert.ok(cwd.unknowns[0]!.candidates.includes("src/a.js"));
  assert.deepEqual(ent({ "src/a.js": "export const a = 1;", "test/q.test.mjs": "import '../src/a.js#frag';" }, ["src/a.js"]).e, ["test/q.test.mjs"]);
  assert.deepEqual(ent({ "src/a.js": "export const a = 1;", "test/q.test.mjs": "await import(`../src/a.js?t=${Date.now()}`);" }, ["src/a.js"]).u, ["dynamic-import@test/q.test.mjs"]);
  assert.deepEqual(ent({ "src/a.cjs": "module.exports = 1;", "test/r.test.cjs": "require('../src/a.cjs?x');" }, ["src/a.cjs"]), { e: [], u: [] },
    "require loads the file named a.cjs?x — the tree holds none (node 22.23.1)");
  assert.deepEqual(ent({ "src/a.ts": "export const a = 1;", "package.json": JSON.stringify({ imports: { "#src/*": "./src/*" } }), "test/a.test.ts": 'import { a } from "#src/a.js";\na;' }, ["src/a.ts"]).u,
    ["unresolved@test/a.test.ts"], "a leading # is a package import, never a fragment");
});
test("AT1 return №4186 P2: every place and spelling that resolves is an edge; a directory loads by its main; an extensionless launch; a name matching but for case is unknown; paths prefer the exact key as TypeScript 6.0.3", () => {
  assert.deepEqual(ent({ "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.mjs" } }), "scripts/gen.mjs": "1;", "test/scripts/gen.mjs": "2;",
    "test/c.test.mjs": "import { execSync } from 'node:child_process';\nexecSync('node ./scripts/gen.mjs');" }, ["scripts/gen.mjs"]).e, ["test/c.test.mjs"], "the working directory's file beside the decoy");
  assert.deepEqual(ent({ "package.json": JSON.stringify({ workspaces: ["packages/app"] }), "packages/app/package.json": JSON.stringify({ scripts: { test: "node --test" } }), "scripts/run.js": "",
    "packages/app/scripts/run.js": "", "packages/app/test/r.test.js": "require('node:child_process').spawnSync(process.execPath, ['scripts/run.js']);" }, ["packages/app/scripts/run.js"]).e,
    ["packages/app/test/r.test.js"]);
  assert.deepEqual(ent({ "src/a.js": "exports.a = 1;", "bin/www": "require('../src/a.js');", "test/c.test.js": "require('node:child_process').spawnSync(process.execPath, ['bin/www']);" }, ["bin/www"]).e,
    ["test/c.test.js"], "an extensionless launch file");
  assert.deepEqual(ent({ "src/a.js": "export const a = 1;", "test/k.test.mjs": "import { a } from '../src/A.js';\nvoid a;" }, ["src/a.js"]).u, ["unresolved@test/k.test.mjs"], "a case-insensitive file system loads it");
  const main = { "lib/package.json": '{"main":"main.js"}', "lib/main.js": "module.exports = 1;", "lib/index.js": "module.exports = 2;", "test/a.test.cjs": 'const lib = require("../lib");' };
  assert.deepEqual([ent(main, ["lib/main.js"]).e, ent(main, ["lib/index.js"]).e], [["test/a.test.cjs"], []], "node loads the main, never the index");
  const { ["lib/main.js"]: _main, ...missing } = main;
  assert.deepEqual(ent(missing, ["lib/index.js"]).u, ["unresolved@test/a.test.cjs"]);
  assert.deepEqual(ent({ "src/legacy.js": "export function first(xs) { return xs[0]; }", "src/legacy.d.ts": "export declare function first(xs: number[]): number;",
    "test/a.test.ts": 'import { first } from "../src/legacy.js";\nfirst([1]);' }, ["src/legacy.d.ts"]).e, ["test/a.test.ts"], "the .d.ts beside the .js");
  assert.deepEqual(ent({ "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }), "src/a.ts": "export const a = (): number => 1;", "dist/src/a.js": "export const a = () => 1;",
    "test/a.test.mjs": 'import { a } from "../dist/src/a.js";\na();' }, ["src/a.ts"]).e, ["test/a.test.mjs"], "a committed output and its source");
  const paths = { "util-lib*": ["./src/a.ts"], "util-lib": ["./src/b.ts"] };
  const rows = { "src/a.ts": "export const a = 1;", "src/b.ts": "export const b = 1;", "test/load.test.ts": 'import "util-lib";', "tsconfig.json": JSON.stringify({ compilerOptions: { paths } }) };
  const host = { fileExists: (file: string) => Object.hasOwn(rows, file.replace("/snapshot/", "")), readFile: (file: string) => (rows as Record<string, string>)[file.replace("/snapshot/", "")],
    directoryExists: () => true, realpath: (file: string) => file, getCurrentDirectory: () => "/snapshot" };
  const typescript = ts.resolveModuleName("util-lib", "/snapshot/test/load.test.ts", { moduleResolution: ts.ModuleResolutionKind.Bundler, pathsBasePath: "/snapshot", paths }, host);
  assert.equal(typescript.resolvedModule?.resolvedFileName, "/snapshot/src/b.ts");
  assert.deepEqual([ent(rows, ["src/b.ts"]).e, ent(rows, ["src/a.ts"]).e], [["test/load.test.ts"], []], "the same file TypeScript 6.0.3 resolves");
});
test("AT1 return №4186 P3: a run is read by the narrow grammar only — env and NODE_OPTIONS, cross-env, a node path, node options by arity, a script with its words; anything else that carries a run is an unknown selection, and its proved edges stay", () => {
  const A = "export const a = 1;\n", T = (up: string) => `import { test } from 'node:test';\nimport { a } from '${up}src/a.js';\ntest('t', () => a);\n`;
  const run = (scripts: Record<string, string>, extra: Record<string, string> = {}, writes = ["src/a.ts"]) => ent({ "src/a.ts": A, "package.json": JSON.stringify({ type: "module", scripts }), ...extra }, writes);
  for (const script of ['sh -c "node --test integration/*.js"', "time node --test integration/*.js", "dotenv -e .env.test -- node --test integration/*.js",
    "cd integration && node --test *.js", "node --test --made-up-option integration/*.js", "node --test 'integration/@(db|x).js'", "node --test 'integration/@(db|x)*.js'",
    "node --test integration/", "mocha"])
    assert.deepEqual(run({ test: script }, { "integration/db.js": T("../") }).u.filter(item => item.startsWith("selection@")), ["selection@package.json#scripts.test"], script);
  for (const script of ["node --test integration/*.js", `${process.execPath} --test integration/*.js`, 'node --test --test-name-pattern="user login" integration/*.js',
    "node --test --unhandled-rejections strict integration/*.js", "node --test 'integration/{db,{x,y}}.js'", "NODE_OPTIONS=--no-warnings node --test integration/*.js"])
    assert.deepEqual(run({ test: script }, { "integration/db.js": T("../") }).e, ["integration/db.js"], script);
  assert.deepEqual(run({ test: "npm run base -- integration/*.js", base: "node --test" }, { "integration/db.js": T("../") }).e, ["integration/db.js"], "a script's words after --");
  assert.deepEqual(run({ build: "node scripts/build.mjs --test" }, { "test/cli.js": T("../"), "scripts/build.mjs": "1;" }).u, ["selection@package.json"], "a script's own --test is no run");
  const setup = { "test/setup.cjs": "require('../src/a.ts');", "test/a.test.cjs": "require('node:test');" };
  for (const script of ["NODE_OPTIONS=--require=./test/setup.cjs node --test test/*.test.cjs", "cross-env NODE_OPTIONS='--require ./test/setup.cjs' node --test test/*.test.cjs"])
    assert.deepEqual(run({ test: script }, setup).e, ["test/a.test.cjs"], script);
  assert.deepEqual(run({ test: "node --env-file=.env --test test/*.test.cjs" }, { ...setup, ".env": "MODE=mock\n" }, [".env"]), { e: ["test/a.test.cjs"], u: [] }, "an env file reaches its run's tests");
  assert.deepEqual(run({ test: "node --test packages/a/test/*.test.mjs" }, { "packages/a/package.json": "{}", "packages/a/test/a.test.mjs": "1;" }, ["package.json"]).e,
    ["packages/a/test/a.test.mjs"], "the manifest that defines the run reaches its tests");
  assert.deepEqual(run({ test: "node --test test/{*.test.mjs,*.spec.mjs}" }, { "test/u.test.mjs": "1;", "test/e.spec.mjs": "1;" }).e, [], "no crash; the tests named reach nothing here");
  assert.deepEqual(run({ test: "node --test test/{unit-*,zz}.mjs" }, { "test/unit-x.mjs": T("../") }).e, ["test/unit-x.mjs"]);
  assert.deepEqual(run({ test: "tsc -p test && node --test" }, { "test/tsconfig.json": "{}", "test/a.test.ts": T("../") }, ["test/tsconfig.json"]).e, ["test/a.test.ts"], "a nested tsconfig");
  assert.deepEqual(run({ test: "node --test" }, { ".npmrc": "node-options=--import ./x.mjs\n", "test/a.test.ts": T("../") }).u, ["selection@.npmrc"]);
});
test("AT1 return №4186 P4: an answer's edges go the one way literal edges go — an unread format it names is asked, a runner's configuration and preloads reach the tests it names", () => {
  const rows = { "src/a.js": "export const a = 1;", "src/C.vue": '<script>import "./a.js";</script>', "test/load.test.js": "await import(process.env.COMPONENT);" };
  const open = work(rows, ["src/a.js"]), loader = open.unknowns.find(item => item.kind === "dynamic-import")!;
  assert.deepEqual(ent(rows, ["src/a.js"], [{ file: loader.file, line: loader.line, site: loader.site, resolves: ["src/C.vue"] }]).u, ["unparsed@src/C.vue"]);
  const preload = { "tools/preload.mjs": "globalThis.ready = true;\n", "test/api.test.js": "import { test } from 'node:test';\n", "package.json": JSON.stringify({ scripts: { test: "c8 node --import ./tools/preload.mjs --test" } }) };
  const c8 = work(preload, ["tools/preload.mjs"]).unknowns.find(item => item.kind === "selection")!;
  assert.deepEqual(ent(preload, ["tools/preload.mjs"], [{ file: c8.file, line: 0, site: c8.site, resolves: ["test/api.test.js"] }]).e, ["test/api.test.js"]);
  const vitest = { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "vitest.config.ts": 'export default { test: { setupFiles: ["./test/setup.ts"] } };',
    "test/setup.ts": "(globalThis as any).MODE = 1;", "test/a.test.ts": "1;" };
  const asked = work(vitest, ["vitest.config.ts"]).unknowns.filter(item => item.kind === "selection");
  const answers = asked.map(item => ({ file: item.file, line: 0, site: item.site, resolves: ["test/a.test.ts"] }));
  assert.deepEqual([ent(vitest, ["vitest.config.ts"], answers).e, ent(vitest, ["test/setup.ts"], answers).e], [["test/a.test.ts"], ["test/a.test.ts"]]);
});
test("AT1 return №4186 P5: NS.x is only a member the body of NS exports — not a local of it, a nested namespace's member, or a member of a class or object in it", () => {
  const read = (text: string, symbol: string) => declares(view({ "src/a.ts": text }), "src/a.ts", symbol);
  assert.equal(read("export namespace Store { export function commit() { return 1; } }", "Store.commit"), "declared");
  assert.equal(read("export namespace A { export namespace B { export function commit() { return 1; } } }", "A.B.commit"), "declared");
  for (const [text, symbol] of [["export namespace Store { export class Impl { rollback() { return 2; } } }", "Store.rollback"],
    ["export namespace A { export namespace B { export function commit() { return 1; } } }", "A.commit"], ["export namespace Store { export const helpers = { commit() { return 1; } }; }", "Store.commit"],
    ["export namespace Store { function commit() { return 1; } }", "Store.commit"]] as const)
    assert.notEqual(read(text, symbol), "declared", `${text} ${symbol}`);
});

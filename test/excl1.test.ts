import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { parseExclusionList, topLevelTestRegistrations, verifyExclusionKeys, exclusionNamesFor, exclusionReason } from "./excl1-wrap.js";

const LIST = `# comment
a.test.ts :: first name # вид 1: эра 111aaa1
a.test.ts :: second name # вид 1: эра 222bbb2
b.test.ts :: other name # вид 1: старая форма
`;

test("EXCL1 parseExclusionList parses file :: name # reason rows and skips comments", () => {
  const keys = parseExclusionList(LIST);
  assert.deepEqual(keys, [
    { file: "a.test.ts", name: "first name", reason: "вид 1: эра 111aaa1" },
    { file: "a.test.ts", name: "second name", reason: "вид 1: эра 222bbb2" },
    { file: "b.test.ts", name: "other name", reason: "вид 1: старая форма" },
  ]);
});

test("EXCL1 parseExclusionList refuses a malformed line and a duplicate key", () => {
  assert.throws(() => parseExclusionList("a.test.ts first name # x"), /expected '<file>\.test\.ts :: <test name> # <reason>'/);
  assert.throws(() => parseExclusionList("a.test.ts :: n\n"), /expected/);
  assert.throws(() => parseExclusionList("a.test.ts :: n # r\na.test.ts :: n # other"), /duplicate key/);
});

const SRC = `import test from "node:test";
test("alpha", () => {});
test("dup", () => {});
test("dup", () => {});
test(\`templated \${x}\`, () => {});
test.skip("already skipped", () => {});
test("parent", t => { t.test("inner", () => {}); });
describe("block", () => { test("nested", () => {}); });
`;

test("EXCL1 topLevelTestRegistrations collects direct registrations and marks every other form unsupported", () => {
  const { supported, unsupported, nonLiteral } = topLevelTestRegistrations(SRC, "a.test.ts");
  assert.deepEqual(supported, ["alpha", "dup", "dup", "parent"]);
  assert.deepEqual(unsupported, ["already skipped", "block"]); // test.skip/describe are not supported forms
  assert.equal(nonLiteral, 1);
});

test("EXCL1 topLevelTestRegistrations classifies unsupported test bindings", () => {
  const { supported, unsupported } = topLevelTestRegistrations(`import test from "./helper.js";
test("helper bound", () => {});
`, "h.test.ts");
  assert.deepEqual(supported, []);
  assert.deepEqual(unsupported, ["helper bound"]);
  const local = topLevelTestRegistrations(`const test = () => {};
test("local bound", () => {});
`, "l.test.ts");
  assert.deepEqual(local.supported, []);
  assert.deepEqual(local.unsupported, ["local bound"]);
  const unbound = topLevelTestRegistrations(`test("unbound", () => {});`, "u.test.ts");
  assert.deepEqual(unbound.supported, []);
  assert.deepEqual(unbound.unsupported, ["unbound"]);
  const alias = topLevelTestRegistrations(`import { test as tt } from "node:test";
test("via plain name", () => {});
`, "al.test.ts");
  assert.deepEqual(alias.supported, []);
  assert.deepEqual(alias.unsupported, ["via plain name"]);
});

test("EXCL1 topLevelTestRegistrations marks property and element calls on the bound test unsupported", () => {
  // EXCL1-03: test.only/skip/todo, element calls and it() reach the runner without the skip wrapper's
  // decision — a listed name there must be rejected, not silently run.
  const { supported, unsupported } = topLevelTestRegistrations(`import test, { it } from "node:test";
test("direct", () => {});
test.only("only", () => {});
test.skip("skipped", () => {});
test.todo("later");
test["only"]("element", () => {});
it("via it", () => {});
`, "p.test.ts");
  assert.deepEqual(supported, ["direct"]);
  assert.deepEqual(unsupported, ["only", "skipped", "later", "element", "via it"]);
});

test("EXCL1 topLevelTestRegistrations expands a for-of of literals over a template name", () => {
  // The om-compiler-readers shape: one call site registering a name per array element.
  const { supported, unsupported } = topLevelTestRegistrations(`import test from "node:test";
for (const entry of ["engine", "server-first"] as const) {
  test(\`R3+R4 cold \${entry} entry: reads the base\`, () => {});
}
for (const v of ["x"]) test.only(\`only \${v}\`, () => {});
`, "l.test.ts");
  assert.deepEqual(supported, ["R3+R4 cold engine entry: reads the base", "R3+R4 cold server-first entry: reads the base"]);
  assert.deepEqual(unsupported, ["only x"]);
});

const runSet = new Set(["a.test.ts", "b.test.ts", "c.test.ts"]);
const sources: Record<string, string> = { "a.test.ts": `import test from "node:test";\ntest("alpha", () => {});\ntest("dup", () => {});\ntest("dup", () => {});` };
const verify = (text: string, run = runSet) => {
  const keys = parseExclusionList(text);
  verifyExclusionKeys(keys, file => sources[file] ?? null, run);
};

test("EXCL1 verify accepts a key that is a single supported registration in a run file", () => {
  verify("a.test.ts :: alpha # вид 1");
});

test("EXCL1 verify fails an unknown name and an ambiguous name in the same report", () => {
  assert.throws(() => verify("a.test.ts :: gone # x\na.test.ts :: dup # x"),
    /gone — no supported top-level test\('\.\.\.'\) registration[\s\S]*dup — 2 registrations share this name/);
});

test("EXCL1 verify fails a key whose file is not in this run — the legacy-listed case", () => {
  assert.throws(() => verify("z.test.ts :: anything # x"), /not in this run/);
  assert.throws(() => verify("missing.test.ts :: anything # x", new Set(["missing.test.ts"])), /no such test file/);
});

test("EXCL1 verify rejects a registration without this file's own 'node:test' import", () => {
  const bare = `test("orphan", () => {});`; // unbound — nothing the resolve hook replaces
  assert.throws(() => verifyExclusionKeys(parseExclusionList("bare.test.ts :: orphan # x"), () => bare, new Set(["bare.test.ts"])),
    /no supported top-level test/);
});

test("EXCL1 verify rejects a registration bound through a helper re-export — the bypass of EXCL1-02", () => {
  const helperBound = `import test from "./support.js";\ntest("listed", () => {});`;
  assert.throws(() => verifyExclusionKeys(parseExclusionList("hb.test.ts :: listed # x"), () => helperBound, new Set(["hb.test.ts"])),
    /no supported top-level test/);
});

test("EXCL1 verify rejects a listed name that appears in a property/element-call registration", () => {
  // EXCL1-03: any listed-name registration that is not the direct test('<name>') is refused before a
  // run — whether it stands alone or sits beside a same-named direct registration.
  const only = `import test from "node:test";\ntest.only("listed", () => {});`;
  assert.throws(() => verifyExclusionKeys(parseExclusionList("o.test.ts :: listed # x"), () => only, new Set(["o.test.ts"])),
    /no supported top-level test[\s\S]*unsupported/);
  const beside = `import test from "node:test";\ntest("listed", () => {});\ntest.only("listed", () => {});`;
  assert.throws(() => verifyExclusionKeys(parseExclusionList("b.test.ts :: listed # x"), () => beside, new Set(["b.test.ts"])),
    /unsupported/);
  const element = `import test from "node:test";\ntest("listed", () => {});\ntest["skip"]("listed", () => {});`;
  assert.throws(() => verifyExclusionKeys(parseExclusionList("e.test.ts :: listed # x"), () => element, new Set(["e.test.ts"])),
    /unsupported/);
});

test("EXCL1 verify accepts each expanded name of a for-of template registration", () => {
  const looped = `import test from "node:test";\nfor (const entry of ["engine", "server-first"]) test(\`cold \${entry} entry\`, () => {});`;
  const verify2 = (name: string) => verifyExclusionKeys(parseExclusionList(`lp.test.ts :: ${name} # x`), () => looped, new Set(["lp.test.ts"]));
  assert.doesNotThrow(() => verify2("cold engine entry"));
  assert.doesNotThrow(() => verify2("cold server-first entry"));
  assert.throws(() => verify2("cold cli entry"), /no supported top-level test/);
});

test("EXCL1 verify rejects a same-named registration through an unsupported binding beside the supported one", () => {
  const mixed = `import test from "node:test";\ntest("both", () => {});\n`;
  const masked = `import test from "./helper.js";\ntest("both", () => {});\n`;
  assert.doesNotThrow(() => verifyExclusionKeys(parseExclusionList("m.test.ts :: both # x"), () => mixed, new Set(["m.test.ts"])));
  assert.throws(() => verifyExclusionKeys(parseExclusionList("m.test.ts :: both # x"), () => masked, new Set(["m.test.ts"])));
  const dual = `import test from "node:test";\nimport test2 from "./helper.js";\ntest("both", () => {});\ntest2("both", () => {});`;
  assert.throws(() => verifyExclusionKeys(parseExclusionList("m.test.ts :: both # x"), () => dual, new Set(["m.test.ts"])),
    /unsupported 'test' binding|registration\(s\) through an unsupported/);
});

test("EXCL exclusionReason skips a listed name once with its list tag, refuses its duplicate, passes others", () => {
  const names = exclusionNamesFor("a.test.ts", parseExclusionList(LIST));
  assert.equal(names.size, 2);
  const seen = new Set<string>();
  assert.equal(exclusionReason(names, seen, "a.test.ts", "first name"), "EXCL1 вид 1: эра 111aaa1");
  assert.equal(exclusionReason(names, seen, "a.test.ts", "unlisted"), null);
  assert.throws(() => exclusionReason(names, seen, "a.test.ts", "first name"), /ambiguous exclusion name/);
  const two = exclusionNamesFor("a.test.ts", parseExclusionList(LIST), "EXCL2");
  assert.equal(two.get("first name"), "EXCL2 вид 1: эра 111aaa1");
});

// The reviewer probe of №6713 (EXCL1-02), verbatim shape: a minimal project that runs the real hook
// and wrapper — the bypass fixture is now rejected by validation before any process spawns.
const base = resolve(fileURLToPath(import.meta.url), "../../..");
const fixture = (t: TestContext, sources: Record<string, string>, manifest: string, tag = "EXCL1") => {
  const root = mkdtempSync(join(tmpdir(), "excl1-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist/test"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}");
  for (const [name, code] of Object.entries(sources)) writeFileSync(join(root, "dist/test", name), code);
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const listTag of ["EXCL1", "EXCL2"]) {
    const list = join(root, `${listTag}-TESTS.txt`);
    writeFileSync(list, listTag === tag ? manifest : "");
    childEnv[`OMG_${listTag}`] = list;
  }
  const runFiles = new Set(Object.keys(sources).filter(n => n.endsWith(".test.js")).map(n => n.replace(/\.js$/, ".ts")));
  const check = () => verifyExclusionKeys(parseExclusionList(manifest), name => sources[name.replace(/\.ts$/, ".js")] ?? null, runFiles);
  delete childEnv.NODE_TEST_CONTEXT;
  const run = (hook = true) => spawnSync(process.execPath,
    [...(hook ? ["--import", join(base, "scripts/excl1-register.mjs")] : []), "--test", "--test-reporter=tap",
      ...Object.keys(sources).filter(n => n.endsWith(".test.js")).map(n => join(root, "dist/test", n))],
    { cwd: root, env: childEnv, encoding: "utf8" });
  return { root, check, run };
};

test("EXCL1 e2e: a direct import is skipped, the same-name neighbor runs, plain node --test runs both", t => {
  const f = fixture(t, {
    "a.test.js": `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('listed',()=>writeFileSync('a-ran','yes'));`,
    "b.test.js": `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('listed',()=>writeFileSync('b-ran','yes'));`,
  }, "a.test.ts :: listed # legacy\n");
  f.check();
  const hooked = f.run(); assert.equal(hooked.status, 0, hooked.stderr); assert.match(hooked.stdout, /# SKIP EXCL1 legacy/);
  assert.equal(existsSync(join(f.root, "a-ran")), false); assert.equal(existsSync(join(f.root, "b-ran")), true);
  const plain = f.run(false); assert.equal(plain.status, 0, plain.stderr); assert.equal(existsSync(join(f.root, "a-ran")), true);
});

test("EXCL1 e2e: a helper re-export binding is refused by validation before any spawn", t => {
  const f = fixture(t, {
    "a.test.js": `import test from './support.js'; import { writeFileSync } from 'node:fs'; test('listed',()=>writeFileSync('excluded-body-ran','yes'));`,
    "support.js": `export { default } from 'node:test';`,
  }, "a.test.ts :: listed # legacy\n");
  assert.throws(f.check, /no supported top-level test/);
  assert.equal(existsSync(join(f.root, "excluded-body-ran")), false, "the excluded body never ran");
});

test("EXCL1 e2e: the EXCL1-03 probe — a listed name through test.only is refused by validation and never reaches the runner", t => {
  // The reviewer counterexample: a same-named test.only beside the direct registration would run the
  // body past the wrapper. Validation refuses it before a spawn; the runtime probe below shows the
  // same accounting also stops it when the wrapper is engaged without the gate.
  const f = fixture(t, {
    "a.test.js": `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('listed',()=>{}); test.only('listed',()=>writeFileSync('only-ran','yes'));`,
  }, "a.test.ts :: listed # legacy\n");
  assert.throws(f.check, /unsupported/);
  assert.equal(existsSync(join(f.root, "only-ran")), false, "the excluded body never ran");
  const gatedOff = fixture(t, {
    "b.test.js": `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test.only('listed',()=>writeFileSync('b-only-ran','yes')); test('other',()=>writeFileSync('b-other-ran','yes'));`,
  }, "b.test.ts :: listed # legacy\n");
  const run = gatedOff.run(); assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /SKIP/);
  assert.equal(existsSync(join(gatedOff.root, "b-only-ran")), false, "test.* of a listed name never reached the real test");
});

test("EXCL2 e2e: a name listed in the second list is skipped with the EXCL2 tag", t => {
  const f = fixture(t, {
    "a.test.js": `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('listed',()=>writeFileSync('a-ran','yes')); test('other',()=>{});`,
  }, "a.test.ts :: listed # вид 2\n", "EXCL2");
  f.check();
  const hooked = f.run(); assert.equal(hooked.status, 0, hooked.stderr); assert.match(hooked.stdout, /# SKIP EXCL2 вид 2/);
  assert.equal(existsSync(join(f.root, "a-ran")), false);
});

test("EXCL probes isolate both inherited lists while preserving NODE_OPTIONS in hooked and plain children", t => {
  const root = mkdtempSync(join(tmpdir(), "excl1-outer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outer = join(root, "outer.txt"); writeFileSync(outer, "a.test.ts :: other # outside this probe\n");
  const previous = [process.env.OMG_EXCL1, process.env.OMG_EXCL2];
  const options = process.env.NODE_OPTIONS ?? null;
  process.env.OMG_EXCL1 = outer; process.env.OMG_EXCL2 = outer;
  try {
    for (const tag of ["EXCL1", "EXCL2"]) {
      const f = fixture(t, {
        "a.test.js": `import test from 'node:test'; import assert from 'node:assert/strict';
          import { writeFileSync } from 'node:fs';
          assert.equal(process.env.NODE_OPTIONS ?? null, ${JSON.stringify(options)});
          test('listed',()=>writeFileSync('listed-ran','yes'));
          test('other',()=>writeFileSync('other-ran','yes'));`,
      }, "a.test.ts :: listed # local probe\n", tag);
      f.check();
      const hooked = f.run(); assert.equal(hooked.status, 0, hooked.stdout + hooked.stderr);
      assert.match(hooked.stdout, new RegExp(`# SKIP ${tag} local probe`));
      assert.equal(existsSync(join(f.root, "listed-ran")), false);
      assert.equal(existsSync(join(f.root, "other-ran")), true, "The other inherited list must not skip this probe's neighbor");
      const plain = f.run(false); assert.equal(plain.status, 0, plain.stdout + plain.stderr);
      assert.match(plain.stdout, /# pass 2/); assert.match(plain.stdout, /# skipped 0/);
      assert.equal(existsSync(join(f.root, "listed-ran")), true);
    }
  } finally {
    for (const [index, tag] of ["EXCL1", "EXCL2"].entries()) {
      if (previous[index] === undefined) delete process.env[`OMG_${tag}`];
      else process.env[`OMG_${tag}`] = previous[index];
    }
  }
});

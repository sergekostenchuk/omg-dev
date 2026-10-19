// EXCL (№6687 п.1): tests listed in test/EXCL1-TESTS.txt and test/EXCL2-TESTS.txt — keys = file + exact
// registered name — are skipped only inside `npm run check:backend`, tagged 'EXCL1'/'EXCL2' in the TAP
// output. `npm test` never loads this module: the resolve hook (scripts/excl1-resolve.mjs) redirects
// 'node:test' imports of dist/test/*.test.js here, one module instance per importing file via the ?f=
// query. Validation of every key is done beforehand by scripts/check-backend.mjs through
// parseExclusionList + verifyExclusionKeys (AST, not the import).
import realTest, { after } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

export { after, before, beforeEach, afterEach, describe, it, mock, run, skip, suite, todo } from "node:test";
export type { TestContext, SuiteContext, TestOptions, HookOptions } from "node:test";

export interface ExclusionKey {
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}

// test/EXCLn-TESTS.txt: one key per line — `<file>.test.ts :: <exact registered test name> # <reason>`;
// `#` alone on a line starts a comment, blanks are ignored.
export const parseExclusionList = (text: string, listName = "test/EXCL1-TESTS.txt"): ExclusionKey[] => {
  const keys: ExclusionKey[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const sep = line.indexOf(" :: ");
    const hash = line.lastIndexOf(" #");
    if (sep <= 0 || hash <= sep) throw new Error(`${listName}:${index + 1}: expected '<file>.test.ts :: <test name> # <reason>'`);
    const file = line.slice(0, sep).trim(), reason = line.slice(hash + 2).trim();
    const name = line.slice(sep + 4, hash).trim();
    if (!file.endsWith(".test.ts") || !name || !reason)
      throw new Error(`${listName}:${index + 1}: expected '<file>.test.ts :: <test name> # <reason>'`);
    const id = `${file}\u0000${name}`;
    if (seen.has(id)) throw new Error(`${listName}:${index + 1}: duplicate key ${file} :: ${name}`);
    seen.add(id);
    keys.push({ file, name, reason });
  });
  return keys;
};

// Direct top-level `test('<name>', ...)` registrations of one source, split by binding and call form.
// EXCL1-02: a call counts as a supported registration only when its callee binds directly to the
// 'node:test' import of this very file — the default import or the named `test` import — i.e. exactly
// what the resolve hook replaces. A local same-named binding, an import through a helper module, an
// aliased or unbound `test` makes the call unsupported. EXCL1-03: the same holds for every other
// registration form — test.only/test.skip/test.todo, element calls like test['only'], it/describe —
// a listed name appearing there is an unsupported registration and an error, never a pass. Simple
// `for (const v of ['a', ...])` loops expand literal/template names per element; nested t.test bodies
// inside a test callback are not registrations.
export interface TopLevelRegistrations {
  readonly supported: string[];
  readonly unsupported: string[];
  readonly nonLiteral: number;
}
export const topLevelTestRegistrations = (sourceText: string, fileName = "test.ts"): TopLevelRegistrations => {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const supportedIds = new Set<string>(), unsupportedIds = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause, fromNodeTest = st.moduleSpecifier.text === "node:test";
      if (clause?.name) (fromNodeTest ? supportedIds : unsupportedIds).add(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const el of clause.namedBindings.elements)
          (fromNodeTest && !el.propertyName && el.name.text === "test" ? supportedIds : unsupportedIds).add(el.name.text);
      continue;
    }
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === "test") unsupportedIds.add("test");
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === "test") unsupportedIds.add("test");
  }
  // The name of one call, resolved for one loop variable: a string literal is taken as is, a template
  // made of `${loopVar}` parts only expands per value, anything else is unresolvable.
  const nameFor = (call: ts.CallExpression, loopVar: string | null, loopValue: string | null): string | null => {
    const arg = call.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) return arg.text;
    if (arg && ts.isTemplateExpression(arg) && loopVar !== null && loopValue !== null) {
      let name = arg.head.text;
      for (const span of arg.templateSpans) {
        if (!ts.isIdentifier(span.expression) || span.expression.text !== loopVar) return null;
        name += loopValue + span.literal.text;
      }
      return name;
    }
    return null;
  };
  // One call site, one loop value: supported only for a direct identifier callee bound to this file's
  // own 'node:test' default/named test import; every other call form with a resolvable literal name —
  // test.only/test.skip/test.todo, test['...'], it/describe, a helper or local binding — is unsupported
  // and must not satisfy a key (EXCL1-02/-03).
  const addCall = (call: ts.CallExpression, loopVar: string | null, loopValue: string | null): number => {
    const callee = call.expression;
    const supportedForm = ts.isIdentifier(callee) && supportedIds.has(callee.text) && !unsupportedIds.has(callee.text);
    const literal = nameFor(call, loopVar, loopValue);
    if (literal === null) return supportedForm ? 1 : 0;
    (supportedForm ? supported : unsupported).push(literal);
    return 0;
  };
  const supported: string[] = [], unsupported: string[] = [];
  let nonLiteral = 0;
  const scanStatement = (st: ts.Statement, loopVar: string | null, loopValue: string | null): void => {
    if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) { nonLiteral += addCall(st.expression, loopVar, loopValue); return; }
    if (ts.isForOfStatement(st)) {
      const decl = st.initializer;
      const loopId = ts.isVariableDeclarationList(decl) && decl.declarations.length === 1 && ts.isIdentifier(decl.declarations[0]!.name)
        ? decl.declarations[0]!.name.text : null;
      let iterable: ts.Expression = st.expression;
      while (ts.isAsExpression(iterable) || ts.isSatisfiesExpression(iterable) || ts.isParenthesizedExpression(iterable))
        iterable = iterable.expression;
      const values = ts.isArrayLiteralExpression(iterable) && iterable.elements.every(el => ts.isStringLiteralLike(el))
        ? iterable.elements.map(el => (el as ts.StringLiteral).text) : null;
      if (loopId !== null && values !== null)
        for (const value of values) for (const inner of ts.isBlock(st.statement) ? [...st.statement.statements] : [st.statement])
          scanStatement(inner, loopId, value);
      else nonLiteral += 1;
    }
  };
  for (const st of sf.statements) scanStatement(st, null, null);
  return { supported, unsupported, nonLiteral };
};

// Every listed key is checked before the run, without importing node:test and without running anything:
// the file exists and is in the actual run set (a legacy-listed file is not), and the name is exactly
// one SUPPORTED top-level registration — a call whose callee binds to this file's own 'node:test'
// default/named test import. Zero supported matches is unknown, two or more is ambiguous, and a
// same-named registration through an unsupported binding (helper import, local or aliased `test`)
// is an error as well — it would run the excluded body.
export const verifyExclusionKeys = (
  keys: readonly ExclusionKey[],
  readSource: (file: string) => string | null,
  runFiles: ReadonlySet<string>,
  listName = "test/EXCL1-TESTS.txt",
): void => {
  const errors: string[] = [];
  const regsByFile = new Map<string, TopLevelRegistrations>();
  for (const key of keys) {
    if (!runFiles.has(key.file)) { errors.push(`${key.file} :: ${key.name} — the file is not in this run (legacy-listed or absent)`); continue; }
    let regs = regsByFile.get(key.file);
    if (regs === undefined) {
      const source = readSource(key.file);
      if (source === null) { errors.push(`${key.file} :: ${key.name} — no such test file`); continue; }
      regs = topLevelTestRegistrations(source, key.file);
      regsByFile.set(key.file, regs);
    }
    const supported = regs.supported.filter(name => name === key.name).length;
    const unsupported = regs.unsupported.filter(name => name === key.name).length;
    if (supported === 0)
      errors.push(`${key.file} :: ${key.name} — no supported top-level test('...') registration (the callee must bind to this file's own 'node:test' import)`);
    if (supported > 1) errors.push(`${key.file} :: ${key.name} — ${supported} registrations share this name`);
    if (unsupported) errors.push(`${key.file} :: ${key.name} — ${unsupported} registration(s) through an unsupported 'test' binding would still run`);
  }
  if (errors.length) throw new Error(`${listName} has ${errors.length} invalid key(s):\n  ${errors.join("\n  ")}`);
};

// Names listed for one file with their list tag: name → 'EXCLn <reason>'. One map per wrapper instance.
export const exclusionNamesFor = (file: string, keys: readonly ExclusionKey[], tag = "EXCL1"): ReadonlyMap<string, string> =>
  new Map(keys.filter(key => key.file === file).map(key => [key.name, `${tag} ${key.reason}`]));

// The skip decision of one registration: null = run normally; a string = the stored skip reason.
// A second registration of the same listed name in one file is ambiguous and is an error — the same
// accounting covers test.only/test.skip/test.todo and every other test.* entry point (EXCL1-03).
export const exclusionReason = (
  names: ReadonlyMap<string, string>, seen: Set<string>, file: string, name: string,
): string | null => {
  const reason = names.get(name);
  if (reason === undefined) return null;
  if (seen.has(name)) throw new Error(`EXCL: ambiguous exclusion name in ${file}: ${name}`);
  seen.add(name);
  return reason;
};

const fileParam = new URL(import.meta.url).searchParams.get("f");
const file = fileParam ? fileParam.replace(/\.js$/, ".ts") : null;
const names = new Map<string, string>();
if (file)
  for (const [env, tag] of [["OMG_EXCL1", "EXCL1"], ["OMG_EXCL2", "EXCL2"]] as const) {
    const listPath = process.env[env];
    if (listPath && existsSync(listPath))
      for (const [name, reason] of exclusionNamesFor(file, parseExclusionList(readFileSync(listPath, "utf8")), tag)) {
        if (names.has(name)) throw new Error(`EXCL: the name is listed in both exclusion lists — ${file}: ${name}`);
        names.set(name, reason);
      }
  }
const seen = new Set<string>();

// Every call shape goes through the same accounting: a listed name registers with skip and counts,
// never reaches the real test — whichever test.* entry point issued it.
const wrapCall = (orig: (...rest: unknown[]) => unknown) => (...args: unknown[]): unknown => {
  const [name, options] = args;
  if (typeof name === "string") {
    const reason = exclusionReason(names, seen, file ?? "", name);
    if (reason !== null)
      args[1] = { ...(typeof options === "object" && options !== null ? options : {}), skip: reason };
  }
  return orig.apply(realTest, args);
};
function test(...args: unknown[]): unknown {
  return wrapCall(realTest as (...rest: unknown[]) => unknown)(...args);
}
for (const key of Object.getOwnPropertyNames(realTest)) {
  if (["length", "name", "prototype", "arguments", "caller"].includes(key)) continue;
  const value = (realTest as unknown as Record<string, unknown>)[key];
  (test as unknown as Record<string, unknown>)[key] = typeof value === "function" ? wrapCall(value as (...rest: unknown[]) => unknown) : value;
}
export default test;
export { test };

// A listed name that never registered fails this run itself — a renamed or removed test cannot drift away.
if (names.size) after(() => {
  const missing = [...names.keys()].filter(name => !seen.has(name));
  if (missing.length) throw new Error(`EXCL: unknown exclusion names in ${file}: ${missing.join(", ")}`);
});

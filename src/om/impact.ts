import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { posix } from 'node:path';
import { EngineError } from '../errors.js';
import { git, gitBytes } from '../runtime/environment.js';
import { safeRelativePath } from '../graph/topology.js';
import type { ImpactDecision } from '../graph/model.js';

/**
 * AT1 (№4084, №4091): the impact of a work on the existing product, derived from one exact repository tree. Who consumes
 * the files a work changes is found by a reverse walk to a fixed point over the supported static transitions — imports,
 * process launches by literal path, package scripts and entries — through src as well as the tests, so a test reached only
 * through engine → commands is not lost. A file exists when the tree holds it, whatever label a proposal gives it. A
 * transition the parser's tree cannot resolve on the affected path is an addressed unknown, never an absent consumer. The
 * inventory widens no write scope: it is what a work has to decide about (keep or update), not a grant.
 */
export const IMPACT_CONTRACT = 'om-impact/v1' as const;
export const IMPACT_CODES = Object.freeze(['impact_repository_unavailable', 'impact_snapshot_invalid'] as const);
export interface RepositorySnapshot { commit: string; tree: string }
export type ImpactVia = 'import' | 'launch' | 'script' | 'resolution' | 'write' | 'config';
/** A test case addressed by its file and the full chain of its enclosing groups; `null` path when no reliable address exists. */
export interface CaseAddress { file: string; path: string[]; line: number }
/**
 * `direct`: the test reaches an affected file through test support only — itself, or helpers and fixtures of the tests —
 * never through other product code (№4098 п.1, п.5): a fixture between a test and the CLI changes nothing; the analyzer
 * derives it, the model is never asked to.
 */
export interface ImpactEntry { test: string; direct: boolean; cases: CaseAddress[]; addressable: boolean; via: ImpactVia[]; reaches: string[] }
/**
 * A transition the analyzer cannot resolve. `candidates` are the files of the snapshot it could load — every code file
 * (every file for a URL) when the expression is wholly computed, else those a literal part of it names: an accepted
 * resolution names a subset of them (AT1 door, №4105 п.4).
 */
/**
 * Return №4135 P2-3: the exact place of a transition in the snapshot's file — the offsets of the whole expression and the
 * hash of its full text. It is the transition's identity; `text` is only a bounded excerpt for showing it.
 */
export interface TransitionSite { start: number; end: number; hash: string }
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** A file too large to analyze is one transition as a whole: its place is the file itself in the tree. */
export const unanalyzedSite = (path: string): TransitionSite => ({ start: 0, end: 0, hash: sha256(`unanalyzed:${path}`) });
/** The address of an unresolved transition in a finding: its file, line and exact span — two on one line stay two. */
export const transitionField = (unknown: { file: string; line: number; site: TransitionSite }): string =>
  `${unknown.file}:${unknown.line}#${unknown.site.start}-${unknown.site.end}`;
export interface ImpactUnknown { file: string; line: number; kind: 'dynamic-import' | 'dynamic-require' | 'dynamic-url' | 'unanalyzed' | 'unparsed' | 'declaration' | 'unrecognized' | 'unresolved' | 'selection'; text: string; site: TransitionSite;
  candidates: string[] }
type ScannedUnknown = Omit<ImpactUnknown, 'candidates'>;
/** An accepted answer to an unknown: the exact transition and every file it reaches (empty: it reaches none). */
/** An accepted resolution of one exact transition — its file, line and expression text (several may share a line). */
export interface ImpactResolution { file: string; line: number; site: TransitionSite; resolves: string[] }
export interface WorkImpact { work: string; affected: string[]; entries: ImpactEntry[]; consumers: string[]; unknowns: ImpactUnknown[] }
/**
 * The declared boundary of this analysis (№4165/№4166/№4170): the computed targets of processes and workers, computed file
 * reads and the consumers of files that do not exist yet are not established by it. A limit of its completeness, never a
 * proof that nothing is influenced: a transitive keep covers the listed expectations only; a new work's own tests,
 * connection points and the interfaces of its predecessors stay required whatever this inventory holds.
 */
export const IMPACT_BOUNDARY = Object.freeze(['computed-process-targets', 'computed-file-reads', 'future-file-consumers'] as const);
export interface ImpactInventory { contract: typeof IMPACT_CONTRACT; snapshot: RepositorySnapshot; parser: string; boundary: string[]; works: WorkImpact[] }
export interface ImpactWork { work: string; writes: readonly string[] }
/** The files of one exact tree; `text` is null for a path the tree does not hold or a file not analyzed. */
export interface SnapshotFiles { readonly snapshot: RepositorySnapshot; readonly paths: readonly string[]; text(path: string): string | null }

const HEX = /^[0-9a-f]{40}$/;
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const UNANALYZED = 'The file exceeds the analyzed size';
const TEST = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/;
const ANALYZED_LIMIT = 2_000_000, BATCH_LIMIT = 6_000_000;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: Iterable<T>, key: (value: T) => string = value => String(value)) => [...values].sort((a, b) => compare(key(a), key(b)));
const unavailable = (workspace: string, message: string, details: Record<string, unknown> = {}): never => {
  throw new EngineError('impact_repository_unavailable', message, { unit: 'AT1', target: workspace, field: 'workspace', ...details });
};
export const isTestFile = (path: string): boolean => TEST.test(path);
/** Test support: a test, or any file of a test directory — the helpers and fixtures a test reaches its subject through. */
export const isTestSupport = (path: string): boolean => isTestFile(path) || /(?:^|\/)(?:test|tests|__tests__|fixtures?)\//.test(path);

/** Whether the workspace is a Git work tree at all; a broken repository is no absence and is refused by the readers below. */
export function isRepository(workspace: string): boolean {
  try { return git(workspace, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}
/** The one resolution of the tree the whole chain uses: HEAD is read once, the tree comes from that exact commit. */
export function resolveSnapshot(workspace: string): RepositorySnapshot {
  let commit = '', tree = '';
  try { commit = git(workspace, ['rev-parse', '--verify', 'HEAD^{commit}']); tree = git(workspace, ['rev-parse', '--verify', `${commit}^{tree}`]); }
  catch (error) { unavailable(workspace, 'The repository snapshot cannot be resolved', { cause: error instanceof EngineError ? error.code : 'git_failed' }); }
  if (!HEX.test(commit) || !HEX.test(tree)) unavailable(workspace, 'The repository snapshot is not an exact commit and tree');
  return { commit, tree };
}
export function validSnapshot(value: unknown): value is RepositorySnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'commit,tree'
    && HEX.test((value as RepositorySnapshot).commit) && HEX.test((value as RepositorySnapshot).tree);
}
/** Reads exactly the saved tree through Git objects only: no index, no working file, no current head. */
export function readSnapshot(workspace: string, snapshot: RepositorySnapshot): SnapshotFiles & { readonly unanalyzed: ReadonlySet<string>; readonly links: ReadonlySet<string> } {
  if (!validSnapshot(snapshot)) throw new EngineError('impact_snapshot_invalid', 'A snapshot is an exact commit and tree', { unit: 'AT1', target: workspace, field: 'snapshot' });
  let listing: Buffer;
  try {
    if (git(workspace, ['rev-parse', '--verify', `${snapshot.commit}^{tree}`]) !== snapshot.tree)
      throw new EngineError('impact_snapshot_invalid', 'The commit does not hold this tree', { unit: 'AT1', target: snapshot.commit, field: 'tree' });
    listing = gitBytes(workspace, ['ls-tree', '-r', '-l', '-z', snapshot.tree]);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'impact_snapshot_invalid') throw error;
    return unavailable(workspace, 'The repository snapshot cannot be read', { tree: snapshot.tree });
  }
  const entries: { path: string; object: string; size: number }[] = [], links = new Set<string>();
  for (const row of listing.toString('utf8').split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), [mode, type, object, size] = row.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;
    // Return №4173 G2: a committed symbolic link is a path of the tree the analysis does not follow.
    if (mode === '120000') { links.add(row.slice(tab + 1)); continue; }
    entries.push({ path: row.slice(tab + 1), object: object!, size: Number(size) });
  }
  const wanted = entries.filter(entry => (CODE.test(entry.path) || ['package.json', '.npmrc'].includes(posix.basename(entry.path)) || /(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/.test(entry.path)) && entry.size <= ANALYZED_LIMIT);
  const texts = new Map<string, string>(), unanalyzed = new Set(entries.filter(entry => CODE.test(entry.path) && entry.size > ANALYZED_LIMIT).map(entry => entry.path));
  for (let start = 0; start < wanted.length;) {
    let end = start, bytes = 0;
    while (end < wanted.length && (end === start || bytes + wanted[end]!.size <= BATCH_LIMIT)) bytes += wanted[end++]!.size;
    const batch = wanted.slice(start, end);
    let output: Buffer;
    try { output = gitBytes(workspace, ['cat-file', '--batch'], new TextEncoder().encode(batch.map(entry => entry.object).join('\n') + '\n')); }
    catch { return unavailable(workspace, 'The repository snapshot cannot be read', { tree: snapshot.tree }); }
    let offset = 0;
    for (const entry of batch) {
      const header = output.indexOf(10, offset), size = Number(output.subarray(offset, header).toString('utf8').split(' ')[2]);
      texts.set(entry.path, output.subarray(header + 1, header + 1 + size).toString('utf8'));
      offset = header + 1 + size + 1;
    }
    start = end;
  }
  return { ...snapshotFiles(snapshot, [...entries.map(entry => entry.path), ...links], texts, unanalyzed), links };
}
/** The same view over files already in hand (a fixture, or a reading done once). */
export function snapshotFiles(snapshot: RepositorySnapshot, paths: readonly string[], texts: ReadonlyMap<string, string>,
  unanalyzed: ReadonlySet<string> = new Set()): SnapshotFiles & { readonly unanalyzed: ReadonlySet<string> } {
  const all = sorted(new Set(paths));
  return { snapshot: { commit: snapshot.commit, tree: snapshot.tree }, paths: all, unanalyzed, text: path => texts.get(path) ?? null };
}

// ---- reading: one parse of each code file by the TypeScript parser ----
/**
 * Return №4143/№4147: the facts of a code file are read from the syntax tree of the TypeScript parser — the transitions
 * (static import/export, import(), require(), new URL(…, import.meta.url)) wherever they stand, inside template
 * substitutions too, and the names the file declares. A parse diagnostic proves nothing: the file becomes one addressed
 * unknown, answered through the readiness door. The parser's exact version is part of the inventory's basis.
 */
export const IMPACT_PARSER: string = `typescript@${ts.version}`;
const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = { '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX };
interface Reference { target: string; via: ImpactVia; line: number }
/** A literal transition: `operation` when a load or a URL takes it (an unresolved one is then unknown), not for a mere string naming a path. */
interface Specifier { value: string; via: ImpactVia; line: number; operation: boolean; site: TransitionSite; text: string; cwd?: boolean; script?: boolean; bin?: boolean }
interface FileFacts { specifiers: Specifier[]; unknowns: ScannedUnknown[]; cases: CaseAddress[]; addressable: boolean }
/** One parse of a file: its transitions and test cases, the names it declares, and the first parse diagnostic (or none). */
interface Analysis { facts: FileFacts; names: ReadonlySet<string>; members: ReadonlySet<string>; possible: ReadonlyMap<string, string>; opaque: string | null; diagnostic: string | null }
const PATH_LIKE = /^(?:\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z0-9]+$/;
/** Return №4186 P2: a path with a directory and no extension (bin/www) names a file too, when the tree holds it. */
const PATH_SLASHED = /^(?:\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+$/;
const pathWord = (word: string): boolean => PATH_LIKE.test(word) || PATH_SLASHED.test(word);
/** The runs of a package script or bin a command's words name: npm run/test/start…, yarn, pnpm, npx and exec. */
function scriptRuns(tokens: readonly string[]): { name: string; bin: boolean }[] {
  const out: { name: string; bin: boolean }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const [tool, first, second] = [tokens[index]!, tokens[index + 1], tokens[index + 2]];
    const name = tool === 'npm' ? (first === 'run' || first === 'run-script' ? second : ['test', 't', 'start', 'stop', 'restart'].includes(first ?? '') ? (first === 't' ? 'test' : first) : undefined)
      : (tool === 'yarn' || tool === 'pnpm') && first !== 'exec' ? (first === 'run' ? second : first) : undefined;
    if (name && !name.startsWith('-')) out.push({ name, bin: false });
    const bin = tool === 'npx' ? first : (tool === 'pnpm' || tool === 'yarn') && first === 'exec' ? second : undefined;
    if (bin && !bin.startsWith('-')) out.push({ name: bin, bin: true });
  }
  return out;
}
/** The words of a literal command line: whitespace, quotes and `--flag=` are separators. */
const words = (value: string): string[] => value.split(/[\s"'`;&|<>()]+|=/).filter(Boolean);
const TEST_CALLS = new Set(['describe', 'suite', 'test', 'it']);
const excerpt = (value: string): string => value.slice(0, 160).replace(/\s+/g, ' ');
/** The whole file as one unknown: its place is its full text, so another content is another question. */
const wholeFile = (path: string, text: string, line: number, message: string): ScannedUnknown =>
  ({ file: path, line, kind: 'unparsed', text: excerpt(message), site: { start: 0, end: text.length, hash: sha256(text) } });
/**
 * Return №4155 п.1: the transparent wrappers of an operand — parentheses, `as`, `satisfies`, `<T>`, `!`, an instantiation
 * and the last value of a comma ((0, require)) — change no transition; it is recognized through them, its place stays the
 * whole original expression.
 */
function strip(node: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isPartiallyEmittedExpression(node) || ts.isExpressionWithTypeArguments(node)) node = node.expression;
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) node = node.right;
    else return node;
  }
}
const staticText = (node: ts.Expression | undefined): string | null => {
  const value = node && strip(node);
  return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) ? value.text : null;
};
/** An ESM or URL specifier without its ?query and #hash; a leading # is a package import, never a fragment (require keeps both). */
const withoutQuery = (value: string): string => value.replace(/^(.+?)[?#].*$/s, '$1');
const isName = (node: ts.Expression | undefined, name: string): boolean => { const value = node && strip(node); return !!value && ts.isIdentifier(value) && value.text === name; };
/** `object.name` through wrappers, with `object` matching. */
const isMember = (node: ts.Expression | undefined, name: string, object: (value: ts.Expression) => boolean): boolean => {
  const value = node && strip(node);
  return !!value && ts.isPropertyAccessExpression(value) && value.name.text === name && object(value.expression);
};
const isImportMeta = (node: ts.Expression): boolean => { const value = strip(node); return ts.isMetaProperty(value) && value.keywordToken === ts.SyntaxKind.ImportKeyword; };
const isImportMetaUrl = (node: ts.Expression | undefined): boolean => isMember(node, 'url', isImportMeta);
/** A callee that is a URL constructor: URL, or URL of an object (globalThis.URL, url.URL). */
const isUrl = (node: ts.Expression): boolean => isName(node, 'URL') || isMember(node, 'URL', () => true);
const LOADERS = new Set(['require', 'createRequire']);
/** The literal text an expression begins with: a literal, a template's head, the left of a concatenation. */
function leading(node: ts.Expression | undefined): string {
  const value = node && strip(node);
  if (!value) return '';
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isTemplateExpression(value)) return value.head.text;
  return ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken ? leading(value.left) : '';
}
/** URL as a value that may construct (an alias, an argument, any member) — not a type and not the right side of instanceof. */
function urlValue(node: ts.Identifier): boolean {
  const parent = node.parent;
  return !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node);
}
const schemeOf = (value: string): string | undefined => /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
/** describe/suite/test/it, or one of them with .only/.skip/.todo — never a member of another object (t.test). */
function testCall(node: ts.Expression): string | null {
  const callee = strip(node);
  if (ts.isIdentifier(callee)) return TEST_CALLS.has(callee.text) ? callee.text : null;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && TEST_CALLS.has(callee.expression.text)
    && ['only', 'skip', 'todo'].includes(callee.name.text)) return callee.expression.text;
  return null;
}
/** Whether an identifier stands where a value is referred to — not a name of a member, a declaration, a label or a type. */
function referenced(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent || ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent) || ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)) return false;
  const named = parent as { name?: ts.Node; propertyName?: ts.Node; label?: ts.Node };
  return named.name !== node && named.propertyName !== node && named.label !== node;
}
/** An access to a member that is the target of an assignment (exports.commit = …, this.commit = …, Store.prototype.commit = …). */
function assigned(access: ts.Node): boolean {
  let node = access;
  while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isAsExpression(node.parent)
    || ts.isSatisfiesExpression(node.parent) || ts.isTypeAssertionExpression(node.parent))) node = node.parent;
  const parent = node.parent;
  return !!parent && ts.isBinaryExpression(parent) && parent.left === node
    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}
/**
 * Return №4143/№4155 п.2: the names a file declares — a top-level function, class, interface, type, enum or namespace (and
 * what a namespace, nested ones included, declares); every name a variable declaration binds, lists and binding patterns
 * included; a name of an export list; a member of a declared class, or of an object literal or class expression a variable,
 * `export default` or a CommonJS export holds, through the transparent wrappers (`satisfies`, `as const`, parentheses); a
 * literal computed name is its text. Outside a declaration file a function or method counts with its body only, and an
 * ambient `declare` declaration not at all: a signature says a point exists elsewhere, never here.
 *
 * Absence is proved only where the analysis reads every form: any other place that may declare a name — a member of another
 * container, an assignment to a member, a string naming it — makes it `possible`, an unknown answered through the readiness
 * door, never an absence (№4160 п.2). References, parameters, imports, locals and labels declare no point.
 */
function declarations(source: ts.SourceFile): { names: Set<string>; members: Set<string>; possible: Map<string, string>; opaque: string | null } {
  const names = new Set<string>(), members_ = new Set<string>(), possible = new Map<string, string>(), typings = source.isDeclarationFile, targets = new Set<ts.Node>();
  let opaque: string | null = null;
  const shown = (node: ts.Node) => excerpt(source.text.slice(node.getStart(source), node.getEnd()));
  const ambient = (node: ts.Node) => !typings && (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0;
  const bodied = (node: { body?: ts.Node | undefined }) => typings || node.body !== undefined;
  const nameText = (name: ts.Node | undefined): string | null => {
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    return ts.isComputedPropertyName(name) ? staticText(name.expression) : null;
  };
  const bound = (name: ts.BindingName): string[] => ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)
    ? name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bound(element.name)) : [name.text];
  const bind = (name: ts.BindingName): void => {
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) { for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name); }
    else names.add(name.text);
  };
  // A member counts under its own name and, qualified, under its owner's (Store.commit — return №4173 G12).
  const members = (list: readonly (ts.ClassElement | ts.ObjectLiteralElementLike)[], owner?: string): void => {
    const add = (text: string) => { names.add(text); if (owner) members_.add(`${owner}.${text}`); };
    for (const member of list) {
      const counted = (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) ? bodied(member)
        : ts.isPropertyDeclaration(member) ? !ambient(member) : ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member);
      const text = counted ? nameText(member.name) : null;
      if (text !== null) add(text);
      // Return №4173 G11: a constructor's parameter property is a member of its class.
      if (ts.isConstructorDeclaration(member) && bodied(member))
        for (const parameter of member.parameters) if (ts.isIdentifier(parameter.name)
          && (ts.getCombinedModifierFlags(parameter) & (ts.ModifierFlags.ParameterPropertyModifier)) !== 0) add(parameter.name.text);
    }
  };
  const holder = (value: ts.Expression | undefined, owner?: string): boolean => {
    const held = value && strip(value);
    if (held && ts.isObjectLiteralExpression(held)) members(held.properties, owner);
    if (held && ts.isClassExpression(held)) members(held.members, owner);
    return !!held && (ts.isObjectLiteralExpression(held) || ts.isClassExpression(held) || ts.isFunctionExpression(held) || ts.isArrowFunction(held));
  };
  const exportsObject = (node: ts.Expression): boolean => isName(node, 'exports') || isMember(node, 'exports', value => isName(value, 'module'));
  const statements = (list: readonly ts.Statement[], prefix?: string): void => {
    for (const statement of list) {
      if (ambient(statement)) continue;
      // Return №4173 G10: `export default function/class` declares the point `default` as well.
      const isDefault = (ts.getCombinedModifierFlags(statement as unknown as ts.Declaration) & ts.ModifierFlags.Default) !== 0;
      if (ts.isFunctionDeclaration(statement) && bodied(statement)) { if (statement.name) names.add(statement.name.text); if (isDefault) names.add('default'); }
      if ((ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.add(statement.name.text);
      const owned = (name: string | undefined) => name === undefined ? undefined : prefix ? `${prefix}.${name}` : name;
      if (ts.isClassDeclaration(statement)) { if (isDefault) names.add('default'); members(statement.members, owned(statement.name?.text ?? (isDefault ? 'default' : undefined))); }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
        { bind(declaration.name); holder(declaration.initializer, owned(ts.isIdentifier(declaration.name) ? declaration.name.text : undefined)); }
      // Return №4173 G11: `export import x = …` declares x.
      if (ts.isImportEqualsDeclaration(statement) && (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0) names.add(statement.name.text);
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamespaceExport(statement.exportClause)) names.add(statement.exportClause.name.text);
      // What a file exports through another module or an opaque value may hold any name: no absence is proved in it.
      if (ts.isExportDeclaration(statement) && !statement.exportClause && statement.moduleSpecifier) opaque ??= shown(statement);
      if (ts.isExportAssignment(statement)) { names.add('default'); if (!holder(statement.expression, 'default')) opaque ??= shown(statement); }
      if (ts.isModuleDeclaration(statement)) {
        // A dotted namespace A.B is a chain of declarations; each name is declared, the innermost block read.
        let module: ts.ModuleDeclaration = statement, chain = prefix ?? '';
        for (;;) {
          if (ts.isIdentifier(module.name)) {
            names.add(module.name.text);
            const inner = chain ? `${chain}.${module.name.text}` : module.name.text;
            if (chain) members_.add(inner);
            chain = inner;
          }
          if (module.body && ts.isModuleDeclaration(module.body)) { module = module.body; continue; }
          if (module.body && ts.isModuleBlock(module.body)) {
            // Return №4186 P5: NS.x is only what the body of NS exports — never a local of it, nor a member of a class or object in it.
            for (const inner of module.body.statements) {
              if (!(ts.getCombinedModifierFlags(inner as unknown as ts.Declaration) & ts.ModifierFlags.Export) && !ts.isExportDeclaration(inner)) continue;
              if ((ts.isFunctionDeclaration(inner) && bodied(inner) || ts.isClassDeclaration(inner) || ts.isInterfaceDeclaration(inner) || ts.isTypeAliasDeclaration(inner)
                || ts.isEnumDeclaration(inner)) && inner.name) members_.add(`${chain}.${inner.name.text}`);
              if (ts.isVariableStatement(inner)) for (const declaration of inner.declarationList.declarations)
                for (const name of bound(declaration.name)) members_.add(`${chain}.${name}`);
              if (ts.isExportDeclaration(inner) && inner.exportClause && ts.isNamedExports(inner.exportClause))
                for (const element of inner.exportClause.elements) members_.add(`${chain}.${element.name.text}`);
            }
            statements(module.body.statements, chain);
          }
          break;
        }
      }
      if (ts.isExpressionStatement(statement)) {
        const value = strip(statement.expression);
        if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const target = strip(value.left);
          if (exportsObject(target)) { targets.add(target); names.add('default'); if (!holder(value.right, 'default')) opaque ??= shown(statement); }
          else if (ts.isPropertyAccessExpression(target) && exportsObject(target.expression)) { targets.add(target.expression); names.add(target.name.text); }
        }
      }
    }
  };
  statements(source.statements);
  const memberish = (node: ts.Node) => ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodSignature(node)
    || ts.isPropertySignature(node) || ts.isEnumMember(node);
  // A signature or an ambient member declares no point here: its absence is proved.
  const signature = (node: ts.Node) => (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && !bodied(node) || ambient(node);
  const mayDeclare = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (!parent || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent)) return false;
    if (ts.isComputedPropertyName(parent)) return !!parent.parent && memberish(parent.parent) && !signature(parent.parent);
    if (memberish(parent) && (parent as { name?: ts.Node }).name === node) return !signature(parent);
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return assigned(parent);
    if (ts.isElementAccessExpression(parent) && strip(parent.argumentExpression) === node) return assigned(parent);
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
  };
  const scan = (node: ts.Node): void => {
    // Return №4163 п.3: a name produced by computation, inherited, spread in or written by reflection — the file is no fully
    // static container, so no absence is proved in it.
    if (ts.isComputedPropertyName(node) && staticText(node.expression) === null || ts.isSpreadAssignment(node)
      || ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent)
      || ts.isElementAccessExpression(node) && staticText(node.argumentExpression) === null && assigned(node)
      || ts.isIdentifier(node) && ['Object', 'Reflect', 'Proxy', 'eval', 'Function'].includes(node.text) && referenced(node)) opaque ??= shown(node.parent ?? node);
    // Any other use of the CommonJS exports object (Object.assign(exports, …), a computed key) may export any name.
    if (!targets.has(node) && (ts.isIdentifier(node) && node.text === 'exports' && referenced(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || ts.isPropertyAccessExpression(node) && node.name.text === 'exports' && isName(node.expression, 'module'))) opaque ??= shown(node.parent ?? node);
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && !names.has(node.text) && !possible.has(node.text) && mayDeclare(node))
      possible.set(node.text, excerpt(source.text.slice(node.parent.getStart(source), node.parent.getEnd())));
    ts.forEachChild(node, scan);
  };
  scan(source);
  return { names, members: members_, possible, opaque };
}
/**
 * The transitions and test cases of a parsed file, every node of code walked. Return №4155/№4160 п.1: what is not
 * recognized is unknown — after the transparent wrappers are taken off, every call of import(), require (module.require,
 * require.resolve, a require createRequire made), import.meta.resolve and every URL constructor is either a supported form
 * (a literal: an edge; a computed specifier: an unknown at its exact place) or an unknown; and every other reference to
 * require, createRequire or import.meta left unexplained is an unknown of its own. The value of the file's own place —
 * fileURLToPath(import.meta.url), import.meta.dirname and .filename, a comparison with import.meta.url — loads nothing.
 * One cause per transition: a recognized form takes the import.meta of its base with it.
 */
function facts(path: string, text: string, source: ts.SourceFile): FileFacts {
  const specifiers: FileFacts['specifiers'] = [], unknowns: ScannedUnknown[] = [], cases: CaseAddress[] = [], taken = new Set<ts.Node>(), explained = new Set<ts.Node>();
  let addressable = true;
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node: ts.Node, via: ImpactVia, value: string, specifier: ts.Expression | null, operation = true, extra: Partial<Specifier> = {}) => {
    const start = node.getStart(source), end = node.getEnd();
    if (specifier) taken.add(strip(specifier));
    specifiers.push({ value, via, line: at(node), operation, site: { start, end, hash: sha256(text.slice(start, end)) }, text: text.slice(start, end), ...extra });
  };
  /** Return №4173 G4: a run of a package script or bin named by the literal words of a call — npm run/test/start, yarn, pnpm, npx. */
  const runs = (node: ts.CallExpression | ts.NewExpression) => {
    const tokens: string[] = [];
    for (const argument of node.arguments ?? []) {
      const value = strip(argument);
      const items = ts.isArrayLiteralExpression(value) ? value.elements : [value];
      for (const item of items) { const word = staticText(item as ts.Expression); if (word !== null) tokens.push(...words(word)); }
    }
    for (const run of scriptRuns(tokens)) literal(node, 'launch', run.name, null, true, run.bin ? { bin: true } : { script: true });
  };
  // One cause per transition: an unknown covers its whole expression, no second unknown is asked inside it (literal edges stay).
  const covered = new Set<ts.Node>();
  const cover = (node: ts.Node): void => { covered.add(node); ts.forEachChild(node, cover); };
  const unknown = (node: ts.Node, kind: ScannedUnknown['kind']) => {
    if (covered.has(node)) return;
    const start = node.getStart(source), end = node.getEnd();
    unknowns.push({ file: path, line: at(node), kind, text: excerpt(text.slice(start, end)), site: { start, end, hash: sha256(text.slice(start, end)) } });
    cover(node);
  };
  /** The parts of a transition already given its one cause: require, createRequire and import.meta inside it. */
  const explain = (node: ts.Node | undefined): void => {
    if (!node) return;
    if (ts.isMetaProperty(node) || ts.isIdentifier(node) && (LOADERS.has(node.text) || node.text === 'URL')) explained.add(node);
    ts.forEachChild(node, explain);
  };
  const load = (node: ts.Node, kind: 'dynamic-import' | 'dynamic-require' | 'dynamic-url', via: ImpactVia, specifier: ts.Expression | undefined) => {
    const value = staticText(specifier);
    // Return №4186 P1: an ESM specifier names its file without ?query or #hash (require reads them as part of the name).
    if (value !== null) literal(node, via, kind === 'dynamic-require' ? value : withoutQuery(value), specifier!);
    else unknown(node, kind);
  };
  /**
   * new URL(spec, base) / URL.parse(spec, base), excluded only where the resulting URL is proved not a file of the tree
   * (return №4163 п.1): an absolute literal spec decides the scheme whatever the base; a relative literal one takes the
   * base's, proved by its literal head (`http://${host}`). A literal relative to this file is a launch; a file: URL, a
   * computed spec and any other base are unknown.
   */
  const url = (node: ts.CallExpression | ts.NewExpression, args: readonly ts.Expression[]) => {
    explain(node.expression);
    const [spec, base] = args, value = staticText(spec);
    const own = value === null ? undefined : schemeOf(value);
    if (value !== null && own !== undefined) { explain(node); if (own === 'file') unknown(node, 'dynamic-url'); return; }
    if (value !== null && !value.startsWith('/') && base) {
      // Relative to this file: a bare path ('x.js') is its sibling, never a path from the root.
      const plain = withoutQuery(value);
      if (isImportMetaUrl(base)) { explain(base); literal(node, 'launch', /^\.{1,2}\//.test(plain) ? plain : `./${plain}`, spec!); return; }
      const inherited = schemeOf(leading(base));
      if (inherited !== undefined && inherited !== 'file') { explain(node); return; }
    }
    // A relative literal without a base throws before it loads anything.
    if (value !== null && !value.startsWith('/') && !base) return;
    explain(node); unknown(node, 'dynamic-url');
  };
  /** The require function createRequire makes, when its base is this file. */
  const created = (node: ts.Expression): ts.CallExpression | null => {
    const value = strip(node);
    return ts.isCallExpression(value) && (isName(value.expression, 'createRequire') || isMember(value.expression, 'createRequire', () => true)) ? value : null;
  };
  const visit = (node: ts.Node, chain: readonly string[]): void => {
    let inner = chain;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      literal(node, 'import', withoutQuery(node.moduleSpecifier.text), node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression))
      literal(node, 'import', node.moduleReference.expression.text, node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
      literal(node, 'import', node.argument.literal.text, node.argument.literal);
    else if (ts.isCallExpression(node)) {
      const callee = strip(node.expression), spec = node.arguments[0];
      const requireOf = (value: ts.Expression) => isName(value, 'require') || isMember(value, 'require', () => true);
      const maker = ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' ? created(callee.expression) : created(callee);
      // The href of a URL a literal names relative to this file is that file: import(new URL('./x.js', import.meta.url).href).
      const located = spec && strip(spec), wrapped = located && ts.isPropertyAccessExpression(located) && located.name.text === 'href' ? strip(located.expression) : null;
      const fixed = wrapped && ts.isNewExpression(wrapped) && isUrl(wrapped.expression) && isImportMetaUrl(wrapped.arguments?.[1]) ? staticText(wrapped.arguments![0]) : null;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && fixed !== null && !schemeOf(fixed) && !fixed.startsWith('/'))
        literal(node, 'import', /^\.{1,2}\//.test(fixed) ? fixed : `./${fixed}`, null);
      else if (callee.kind === ts.SyntaxKind.ImportKeyword) load(node, 'dynamic-import', 'import', spec);
      else if (requireOf(callee) || isMember(callee, 'resolve', value => requireOf(value))) { explain(node.expression); load(node, 'dynamic-require', 'import', spec); }
      else if (maker) {
        explain(node.expression);
        if (isImportMetaUrl(maker.arguments[0])) load(node, 'dynamic-require', 'import', spec);
        else unknown(node, 'dynamic-require');
      } else if (isMember(callee, 'resolve', isImportMeta)) { explain(node.expression); load(node, 'dynamic-import', 'import', spec); }
      else if (isMember(callee, 'parse', isUrl)) url(node, node.arguments);
      else if ((isName(callee, 'fileURLToPath') || isMember(callee, 'fileURLToPath', () => true)) && isImportMetaUrl(spec)) explain(spec);
      else if (created(node) && !explained.has(ts.isPropertyAccessExpression(callee) ? callee.name : callee)) { explain(node); unknown(node, 'dynamic-require'); }
      // Every file keeps its case addresses: which files are tests the runner's selection decides (return №4180).
      const called = testCall(node.expression);
      if (called) {
        const title = staticText(spec);
        if (title === null) addressable = false;
        else if (called === 'describe' || called === 'suite') inner = [...chain, title];
        else cases.push({ file: path, path: [...chain, title], line: at(node) });
      }
    } else if (ts.isNewExpression(node) && isUrl(node.expression)) url(node, node.arguments ?? []);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) runs(node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'require' && node.initializer) {
      // const require = createRequire(import.meta.url): the calls of this require are recognized where they stand.
      const maker = created(node.initializer);
      if (maker && isImportMetaUrl(maker.arguments[0])) explain(node.initializer);
    } else if (ts.isPropertyAccessExpression(node) && isImportMeta(node.expression) && ['dirname', 'filename'].includes(node.name.text)) explain(node);
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind) && (isImportMetaUrl(node.left) || isImportMetaUrl(node.right)))
      explain(isImportMetaUrl(node.left) ? node.left : node.right);
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !taken.has(node)) {
      // A literal path to a file anywhere else — a launch or a read, written whole or as a word of a command line — is a
      // reference, from the file and from the package root (the working directory) alike (return №4173 G4).
      for (const word of words(node.text)) if (pathWord(word)) literal(node, 'launch', word, null, false, { cwd: true });
    }
    // What is left unexplained: a reference to require, createRequire (of any object too), import.meta, or the URL constructor
    // as a value (an alias), outside any form above.
    if (!explained.has(node) && (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node) && LOADERS.has(node.text) && (referenced(node) || ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || ts.isIdentifier(node) && node.text === 'URL' && (referenced(node) && urlValue(node) || ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      // Return №4173 G9: code from a string — eval, the Function constructor — loads what this analysis cannot see.
      || ts.isIdentifier(node) && (node.text === 'eval' || node.text === 'Function') && referenced(node))) {
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) explain(node.parent.expression);
      let whole: ts.Node = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
      // The whole expression it heads: a member chain, a call of it, the wrappers around it.
      while (whole.parent && (ts.isPropertyAccessExpression(whole.parent) && whole.parent.expression === whole
        || ts.isElementAccessExpression(whole.parent) && whole.parent.expression === whole || ts.isCallExpression(whole.parent) && whole.parent.expression === whole
        || ts.isNewExpression(whole.parent) && whole.parent.expression === whole
        || ts.isBinaryExpression(whole.parent) && whole.parent.operatorToken.kind === ts.SyntaxKind.CommaToken && whole.parent.right === whole
        || ts.isParenthesizedExpression(whole.parent) || ts.isNonNullExpression(whole.parent) || ts.isAsExpression(whole.parent))) whole = whole.parent;
      // What an unrecognized operation does with its arguments is unknown: their literals narrow nothing.
      explain(whole);
      unknown(whole, 'unrecognized');
    }
    ts.forEachChild(node, child => visit(child, inner));
    // Return №4173 G8: the JSDoc of a JavaScript file types through import('…') too.
    for (const doc of (node as { jsDoc?: ts.Node[] }).jsDoc ?? []) visit(doc, inner);
  };
  visit(source, []);
  // Return №4173 G8: /// <reference path> and <reference types> are transitions of the file as well.
  const directive = (reference: ts.FileReference, value: string) => {
    const start = reference.pos, end = reference.end;
    specifiers.push({ value, via: 'import', line: source.getLineAndCharacterOfPosition(start).line + 1, operation: true,
      site: { start, end, hash: sha256(text.slice(start, end)) }, text: text.slice(start, end) });
  };
  for (const reference of source.referencedFiles) directive(reference, /^\.{1,2}\//.test(reference.fileName) ? reference.fileName : `./${reference.fileName}`);
  for (const reference of source.typeReferenceDirectives) directive(reference, `@types/${reference.fileName}`);
  const keys = cases.map(item => JSON.stringify(item.path));
  if (new Set(keys).size !== keys.length) addressable = false;
  return { specifiers, unknowns, cases, addressable };
}
/** One parse of a file of a kind the selection takes as code; a kind the parser does not read is one unknown of the file. */
function analyze(path: string, text: string): Analysis {
  const kind = SCRIPT_KINDS[posix.extname(path)];
  const unread = (line: number, message: string): Analysis =>
    ({ facts: { specifiers: [], unknowns: [wholeFile(path, text, line, message)], cases: [], addressable: false }, names: new Set(), members: new Set(), possible: new Map(), opaque: null, diagnostic: message });
  if (kind === undefined) return unread(0, `The parser does not read files of the kind ${posix.extname(path)}`);
  try { return parsed(path, text, kind, unread); }
  catch (error) {
    // Return №4173 G6: a file nested deeper than the walk goes is one unknown of the file, never a crash of the inventory.
    if (error instanceof RangeError) return unread(0, 'The file nests deeper than the analysis walks');
    throw error;
  }
}
function parsed(path: string, text: string, kind: ts.ScriptKind, unread: (line: number, message: string) => Analysis): Analysis {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  // The parse diagnostics are the parser's own list; a parser that keeps none proves nothing either.
  const listed = (source as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  const first = Array.isArray(listed) ? listed[0] as ts.Diagnostic | undefined : { messageText: 'the parser keeps no diagnostics', start: 0 };
  const found = facts(path, text, source);
  if (!first) return { facts: found, ...declarations(source), diagnostic: null };
  const diagnostic = ts.flattenDiagnosticMessageText(first.messageText, ' ');
  // The recovered tree's literal transitions stay edges (one more consumer is the cautious side); what it may hide is the one
  // unknown of the whole file.
  const analysis = unread(source.getLineAndCharacterOfPosition(first.start ?? 0).line + 1, `The parser does not take the file: ${diagnostic}`);
  return { ...analysis, facts: { ...analysis.facts, specifiers: found.specifiers } };
}
/** One analysis per file of one snapshot view: the inventory and the connection points read the same parse. */
const analyses = new WeakMap<SnapshotFiles, Map<string, Analysis>>();
function analysisOf(files: SnapshotFiles, path: string, text: string): Analysis {
  let cache = analyses.get(files);
  if (!cache) { cache = new Map(); analyses.set(files, cache); }
  let analysis = cache.get(path);
  if (!analysis) { analysis = analyze(path, text); cache.set(path, analysis); }
  return analysis;
}
/** Whether a file of a snapshot declares a name: proved, absent, or unknown with the reason the analysis proves nothing. */
export type Declaration = 'declared' | 'absent' | { unknown: string };
export function declares(files: SnapshotFiles & { readonly unanalyzed?: ReadonlySet<string> }, path: string, symbol: string): Declaration {
  const text = files.text(path);
  if (text === null || !CODE.test(path)) return { unknown: files.unanalyzed?.has(path) ? UNANALYZED : 'The parser reads JavaScript and TypeScript only' };
  const analysis = analysisOf(files, path, text);
  if (analysis.diagnostic !== null) return { unknown: analysis.diagnostic };
  // Return №4173 G12: a qualified point (Store.commit) is proved by the member of that very owner, never by its first name;
  // an owner of an unread form leaves it unknown, an absent owner absent.
  const [first, ...rest] = symbol.split('.');
  if (rest.length) {
    if (analysis.members.has(symbol)) return 'declared';
    const owner = declares(files, path, first!);
    return owner === 'absent' ? 'absent' : { unknown: `The member ${rest.join('.')} of ${first} is not read from a fully static owner` };
  }
  if (analysis.names.has(symbol)) return 'declared';
  const may = analysis.possible.get(symbol);
  if (may !== undefined) return { unknown: `A form the analysis does not read may declare ${symbol}: ${may}` };
  return analysis.opaque === null ? 'absent' : { unknown: `The file exports through a form the analysis does not read, ${symbol} may come from it: ${analysis.opaque}` };
}
/**
 * A connection point whose file the parser proves nothing about: one addressed unknown at the point itself, asked through
 * the readiness door — its only candidate is the point; resolving it to the point says the code of the snapshot declares
 * it, resolving it to nothing says it does not.
 */
export const declarationUnknown = (entry: string, reason: string): ImpactUnknown =>
  ({ file: entry, line: 0, kind: 'declaration', text: excerpt(`${entry}: ${reason}`), site: { start: 0, end: 0, hash: sha256(`declaration:${entry}`) }, candidates: [entry] });
interface PackageReference { from: string; value: string; line: number; script?: string; bin?: string }
function packageReferences(path: string, text: string): PackageReference[] | null {
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const out: PackageReference[] = [], value = parsed as Record<string, unknown>;
  const visit = (from: string, item: unknown) => {
    if (typeof item === 'string') {
      const tokens = item.split(/[\s"'=;&|<>()]+/).filter(Boolean);
      for (const token of tokens) if (pathWord(token)) out.push({ from, value: posix.join(posix.dirname(path), token), line: 1 });
      // Return №4173 G4: a script that runs another script or a bin (npm run b, npm test, npx x) reaches it.
      for (const run of scriptRuns(tokens)) out.push({ from, value: run.name, line: 1, ...(run.bin ? { bin: run.name } : { script: run.name }) });
    }
    else if (item && typeof item === 'object') for (const [key, inner] of Object.entries(item)) visit(`${from}.${key}`, inner);
  };
  for (const field of ['scripts', 'bin', 'main', 'module', 'exports']) if (field in value) visit(`${path}#${field}`, value[field]);
  return out;
}
/**
 * Return №4163: the build output of the snapshot's own tsconfig.json — `outDir` and `rootDir` written explicitly — maps
 * an output path to its source. Without them nothing is mapped: a path into an output the tree does not hold is unknown.
 */
interface OutputMap { out: string; root: string; held: boolean }
function outputMap(files: SnapshotFiles): OutputMap | null {
  const text = files.text('tsconfig.json');
  if (text === null) return null;
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text);
  const options = (parsed.config as { extends?: unknown; compilerOptions?: { outDir?: unknown; rootDir?: unknown } } | undefined);
  const out = options?.compilerOptions?.outDir, root = options?.compilerOptions?.rootDir;
  if (parsed.error || options?.extends !== undefined || typeof out !== 'string' || typeof root !== 'string') return null;
  const normal = (value: string) => posix.normalize(value.replace(/^\.\//, '')).replace(/\/$/, '');
  const mapped = { out: normal(out), root: normal(root) };
  // An output the tree does not hold is named by its source alone; a committed one is a place of its own too.
  return safeRelativePath(mapped.out) && (mapped.root === '.' || safeRelativePath(mapped.root))
    ? { ...mapped, held: files.paths.some(path => path.startsWith(`${mapped.out}/`)) } : null;
}
/**
 * The places of the tree a path literal of `from` may name: from the file itself and — when the proved build runs it from
 * its output — from there too, an output place mapped back to its source. A place beyond the root is outside the tree.
 */
function placesOf(from: string, value: string, rooted: boolean, output: OutputMap | null, extra: readonly string[] = []): string[] {
  const relative = value.startsWith('./') || value.startsWith('../'), file = from.split('#')[0]!;
  if (!relative && !rooted) return [];
  // A process launched or a file read by a literal path resolves it from the working directory too (G4): the package's own.
  const origins = relative ? [posix.dirname(file), ...extra] : ['.', ...extra];
  if (relative && output && (output.root === '.' || file.startsWith(`${output.root}/`)))
    origins.push(posix.dirname(posix.join(output.out, output.root === '.' ? file : file.slice(output.root.length + 1))));
  const places: string[] = [];
  for (const origin of origins) {
    const base = posix.normalize(posix.join(origin, value)).replace(/\/$/, '') || '.';
    if (base !== '.' && !safeRelativePath(base)) continue;
    const built = !!output && (base === output.out || base.startsWith(`${output.out}/`));
    if (!built || output!.held) places.push(base);
    if (built) places.push(posix.normalize(posix.join(output!.root, base.slice(output!.out.length + 1))) || '.');
  }
  return [...new Set(places)];
}
/** What the resolution reads from the tree: its files and its package manifests (a directory's main). */
interface Tree { present: ReadonlySet<string>; output: OutputMap | null; manifests: ReadonlyMap<string, Record<string, unknown> | null> }
/**
 * Return №4186 P2: every file of the tree a path literal of `from` may name — at every place (from the file, from its working
 * directory, from its built place) and in every spelling present (a .js and its .d.ts, a committed output and its source), never
 * the first found alone: one more consumer is the cautious side. A directory with a package.json resolves by its main as node
 * does; one whose main the tree does not resolve is unknown. Null when nothing resolves.
 */
function resolveAll(tree: Tree, from: string, value: string, rooted: boolean, origins: readonly string[] = []): string[] | 'unknown' | null {
  const found = new Set<string>();
  for (const stem of placesOf(from, value, rooted, tree.output, origins)) {
    const manifest = tree.manifests.get(`${stem}/package.json`);
    if (manifest !== undefined && !CODE.test(stem) && !tree.present.has(stem)) {
      const main = manifest?.['main'];
      const targets = typeof main === 'string' ? spellings(posix.normalize(posix.join(stem, main))).filter(path => tree.present.has(path)) : [];
      if (typeof main === 'string' && !targets.length || manifest === null) return 'unknown';
      for (const target of typeof main === 'string' ? targets : spellings(stem).filter(path => path.startsWith(`${stem}/index`) && tree.present.has(path))) found.add(target);
      continue;
    }
    for (const candidate of spellings(stem)) if (tree.present.has(candidate)) found.add(candidate);
  }
  return found.size ? [...found].sort() : null;
}
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'];
/**
 * Return №4173 G2: the files a path may name under the supported resolution — itself; for a JavaScript name its TypeScript
 * sources and declarations (.js → .ts/.tsx/.d.ts, .jsx, .mjs → .mts, .cjs → .cts); for a name without a code extension every
 * supported extension and the index of a directory.
 */
function spellings(stem: string): string[] {
  const js = /\.([cm]?)jsx?$/.exec(stem);
  if (js) {
    const base = stem.slice(0, js.index), flavour = js[1] ?? '';
    return [stem, ...(flavour ? [`${base}.${flavour}ts`, `${base}.d.${flavour}ts`] : [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.jsx`])];
  }
  return [stem, ...(CODE.test(stem) ? [] : [...SOURCE_EXTENSIONS.map(ext => `${stem}${ext}`), ...SOURCE_EXTENSIONS.filter(ext => ext !== '.json').map(ext => `${stem}/index${ext}`)])];
}
const BUILTINS = new Set(builtinModules);
const LOCAL_SPEC = /^(?:file:|link:|workspace:|portal:|\.|\/)/;
/** Configurations that may map a bare name to a file of the tree and that this analysis does not read. */
const MAPPING_CONFIG = /(?:^|\/)(?:(?:tsconfig|jsconfig)[^/]*\.json|(?:vite|vitest|webpack|rollup|jest|babel)\.config\.[cm]?[jt]s|\.babelrc[^/]*)$/;
interface Local { base: string | null; paths: [string, string[]][]; unproven: string | null; names: ReadonlySet<string>;
  manifests: ReadonlyMap<string, Record<string, unknown> | null> }
/** The local mappings of the snapshot a bare name passes before it may leave the tree (Codex №4170 п.4). */
function localMappings(files: SnapshotFiles, manifests: ReadonlyMap<string, Record<string, unknown> | null>): Local {
  const names = new Set([...manifests.values()].map(manifest => manifest?.['name']).filter((name): name is string => typeof name === 'string'));
  const other = files.paths.find(path => path !== 'tsconfig.json' && MAPPING_CONFIG.test(path));
  const local: Local = { base: null, paths: [], unproven: other ? `${other} may map names and is not read` : null, names, manifests };
  const text = files.text('tsconfig.json');
  if (text === null) return local;
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text);
  const config = parsed.config as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | undefined;
  if (parsed.error || config?.extends !== undefined) return { ...local, unproven: 'tsconfig.json extends a configuration this analysis does not read' };
  const { baseUrl, paths } = config?.compilerOptions ?? {};
  if (baseUrl !== undefined && typeof baseUrl !== 'string' || paths !== undefined && (typeof paths !== 'object' || paths === null || Array.isArray(paths)))
    return { ...local, unproven: 'tsconfig.json maps names in a form this analysis does not read' };
  const entries = Object.entries((paths ?? {}) as Record<string, unknown>);
  if (entries.some(([, targets]) => !Array.isArray(targets) || !targets.every(target => typeof target === 'string')))
    return { ...local, unproven: 'tsconfig.json maps names in a form this analysis does not read' };
  return { ...local, base: typeof baseUrl === 'string' ? posix.normalize(baseUrl.replace(/^\.\//, '')) : paths !== undefined ? '.' : null,
    paths: entries as [string, string[]][] };
}
/**
 * Return №4163, №4170 п.4: where a bare name of a load leads — a file of the tree a local mapping proves (tsconfig paths, its
 * baseUrl), or outside the tree by proof (a URL of another scheme, the node: scheme, a built-in, a package a package.json on
 * the way to the root declares from a registry), or unknown: a package import, a local or workspace package, the package's
 * own name, a mapping this analysis does not read, an undeclared name.
 */
function bare(local: Local, tree: Tree, from: string, value: string): string[] | 'external' | 'unknown' {
  const scheme = schemeOf(value);
  if (scheme !== undefined) return scheme === 'file' || scheme.length === 1 ? 'unknown' : 'external';
  if (value.startsWith('#') || local.unproven) return 'unknown';
  // tsconfig paths: the longest matching pattern, its targets in order; when none of them is in the tree TypeScript goes on.
  // As TypeScript 6.0.3 matches paths: an exact pattern first, then the wildcard pattern with the longest head.
  const fitting = local.paths.map(([pattern, targets]) => {
    const star = pattern.indexOf('*'), head = star < 0 ? pattern : pattern.slice(0, star), tail = star < 0 ? '' : pattern.slice(star + 1);
    const fits = star < 0 ? value === pattern : value.startsWith(head) && value.endsWith(tail) && value.length >= head.length + tail.length;
    return fits ? { exact: star < 0, head, targets, rest: star < 0 ? '' : value.slice(head.length, value.length - tail.length) } : null;
  }).filter(item => item !== null);
  const match = fitting.find(item => item.exact) ?? fitting.sort((a, b) => b.head.length - a.head.length)[0];
  for (const target of match?.targets ?? []) {
    const found = resolveAll(tree, 'tsconfig.json', posix.join(local.base ?? '.', target.replace('*', match!.rest)), true);
    if (found) return found;
  }
  if (local.base !== null) { const found = resolveAll(tree, 'tsconfig.json', posix.join(local.base, value), true); if (found) return found; }
  const name = value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0]!;
  if (local.names.has(name)) return 'unknown';
  if (BUILTINS.has(value) || BUILTINS.has(name)) return 'external';
  for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
    const manifest = local.manifests.get(dir === '.' ? 'package.json' : `${dir}/package.json`);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const spec = (manifest?.[field] as Record<string, unknown> | undefined)?.[name];
      if (typeof spec === 'string' && !LOCAL_SPEC.test(spec)) return 'external';
    }
    if (dir === '.') return 'unknown';
  }
}
/**
 * Return №4170 п.4: a path literal no supported extension and no proved build mapping resolves is closed only by proof, at
 * every place it may name: beyond the root it is outside the tree; a directory of the tree is no file a URL names (a load of a
 * directory goes through a manifest this analysis does not read — unknown); a file the tree's own directory does not hold is
 * absent. A place in a directory the tree does not hold (an output it does not map) and an absolute path are unknown.
 */
function proved(paths: readonly string[], from: string, value: string, rooted: boolean, output: OutputMap | null, load: boolean, origins: readonly string[] = []): boolean {
  if (value.startsWith('/')) return false;
  const directory = (place: string) => place === '.' || paths.some(path => path.startsWith(`${place}/`));
  // Return №4186 P2: on a case-insensitive file system a name that matches a file of the tree but for case loads it.
  const lower = new Set(paths.map(path => path.toLowerCase()));
  return placesOf(from, value, rooted, output, origins).every(place => !spellings(place).some(spelling => lower.has(spelling.toLowerCase()))
    && (directory(place) ? !load : directory(posix.dirname(place))));
}
/** Formats without a mechanism that loads another file: a file of them is a leaf of the walk. */
const INERT = /\.(?:json|md|txt|csv|ya?ml|png|jpe?g|gif|webp|ico|bmp|snap|map|lock|log|pdf|woff2?|ttf|otf|eot|mp3|mp4|wav)$|(?:^|\/)\.env(?:\.[^/]*)?$/i;
const LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
/** Configurations that choose the tests of a run and that this analysis does not read: runners' own and CI's. */
const SELECTION_CONFIG = /(?:^|\/)(?:\.mocharc(?:\.[a-z]+)?|(?:vitest|jest|ava|playwright|cypress)\.config\.[cm]?[jt]s|karma\.conf\.[cm]?js|\.taprc|\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile)$/;
/** Runners whose selection this analysis does not reproduce: a run of them is an unknown selection, answered through the door. */
const OTHER_RUNNERS = new Set(['mocha', 'vitest', 'jest', 'ava', 'tap', 'tape', 'playwright', 'cypress', 'karma', 'jasmine', 'uvu', 'borp', 'c8', 'nyc', 'lab', 'qunit', 'zora', 'japa', 'poku']);
/**
 * Return №4186 P3: the options of node 22 a test run may carry, by arity — the narrow grammar. An option outside it makes the run
 * unknown, never a pattern. The preloads and env files among them reach every test the run selects.
 */
const NODE_VALUE_OPTIONS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--test-reporter', '--test-reporter-destination',
  '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--test-shard', '--conditions', '-C', '--env-file', '--env-file-if-exists',
  '--input-type', '--watch-path', '--test-coverage-include', '--test-coverage-exclude', '--test-coverage-branches', '--test-coverage-functions',
  '--test-coverage-lines', '--experimental-test-isolation', '--test-isolation', '--disable-warning', '--title', '--stack-size', '--max-old-space-size',
  '--unhandled-rejections', '--experimental-default-type', '--localstorage-file']);
const NODE_FLAGS = new Set(['--test', '--test-only', '--watch', '--experimental-strip-types', '--no-experimental-strip-types', '--experimental-transform-types',
  '--no-warnings', '--enable-source-maps', '--experimental-test-coverage', '--test-force-exit', '--experimental-vm-modules', '--expose-gc', '--trace-warnings',
  '--trace-uncaught', '--experimental-test-module-mocks', '--experimental-test-snapshots', '--test-update-snapshots', '--experimental-require-module',
  '--no-experimental-require-module', '--experimental-detect-module', '--no-deprecation', '--pending-deprecation', '--preserve-symlinks', '--experimental-sqlite',
  '--abort-on-uncaught-exception', '--frozen-intrinsics']);
const PRELOADS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
const ENV_FILES = new Set(['--env-file', '--env-file-if-exists']);
/** node --test with no file argument, as node 22.23.1 selects (checked on a sealed example): names and test/ directories of js/ts. */
const NODE_DEFAULT = /(?:^|\/)(?:[^/]*[._-]test|test-[^/]*|test)\.[cm]?[jt]s$|(?:^|\/)test\/(?:.*\/)?[^/]*\.[cm]?[jt]s$/;
/** A glob as node 22 reads it — *, **, ?, {a,b} (nested) — or null for a form this analysis does not read (classes, negation, extglobs). */
function globRegex(pattern: string): RegExp | null {
  if (/[[\]!]|[@+*?!]\(/.test(pattern)) return null;
  const escape = (char: string) => char.replace(/[.+^$()|\\]/g, '\\$&');
  const translate = (part: string): string | null => {
    let out = '';
    for (let index = 0; index < part.length; index++) {
      const char = part[index]!;
      if (char === '*' && part[index + 1] === '*') { index++; if (part[index + 1] === '/') { index++; out += '(?:.*/)?'; } else out += '.*'; }
      else if (char === '*') out += '[^/]*';
      else if (char === '?') out += '[^/]';
      else if (char === '{') {
        let depth = 0, end = -1;
        const cuts: number[] = [];
        for (let at = index; at < part.length; at++) {
          if (part[at] === '{') depth++;
          else if (part[at] === '}' && --depth === 0) { end = at; break; }
          else if (part[at] === ',' && depth === 1) cuts.push(at);
        }
        if (end < 0) return null;
        const bounds = [index, ...cuts, end], alternatives: string[] = [];
        for (let k = 0; k + 1 < bounds.length; k++) { const alternative = translate(part.slice(bounds[k]! + 1, bounds[k + 1]!)); if (alternative === null) return null; alternatives.push(alternative); }
        out += `(?:${alternatives.join('|')})`; index = end;
      } else out += escape(char);
    }
    return out;
  };
  const body = translate(pattern);
  if (body === null) return null;
  try { return new RegExp(`^${body}$`); } catch { return null; }
}
/** The words of a command line as a shell without expansion reads them — quotes joined into words; null where it would expand. */
function shellWords(command: string): string[] | null {
  const out: string[] = [];
  let word: string | null = null, quote: string | null = null;
  for (const char of command) {
    if (quote) { if (char === quote) quote = null; else if (quote === '"' && /[$`\\]/.test(char)) return null; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; word ??= ''; continue; }
    if (/[$`\\*?]/.test(char) && char !== '*' && char !== '?') return null;
    if (/\s/.test(char)) { if (word !== null) out.push(word); word = null; continue; }
    word = (word ?? '') + char;
  }
  if (quote) return null;
  if (word !== null) out.push(word);
  return out;
}
/** The commands of a script, split at &&, ||, ;, | and & outside quotes; null where the quoting is unbalanced. */
function commandsIn(script: string): string[] | null {
  const out: string[] = [];
  let current = '', quote: string | null = null;
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!;
    if (quote) { if (char === quote) quote = null; current += char; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if ('&|;'.includes(char)) { out.push(current); current = ''; if ((char === '&' || char === '|') && script[index + 1] === char) index++; continue; }
    current += char;
  }
  if (quote) return null;
  out.push(current);
  return out.map(command => command.trim()).filter(Boolean);
}
type Run = { kind: 'node'; patterns: string[]; preloads: string[]; envFiles: string[] } | { kind: 'npm'; script: string; args: string[] }
  | { kind: 'other'; runner: string; preloads: string[] } | { kind: 'plain' } | { kind: 'unknown'; why: string };
/** The options of node in `words` before its first positional, by the narrow grammar. */
function nodeOptions(words: readonly string[]): { rest: string[]; test: boolean; preloads: string[]; envFiles: string[] } | string {
  const preloads: string[] = [], envFiles: string[] = [];
  let test = false, index = 0;
  for (; index < words.length && words[index]!.startsWith('-'); index++) {
    const [option, attached] = words[index]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (option === '--experimental-config-file') return 'node reads a configuration file this analysis does not read';
    if (NODE_FLAGS.has(option) && attached === undefined) { if (option === '--test') test = true; continue; }
    if (!NODE_VALUE_OPTIONS.has(option)) return `the option ${option} is outside the grammar this analysis reads`;
    const value = attached ?? words[++index];
    if (value === undefined) return `the option ${option} has no value`;
    if (PRELOADS.has(option)) preloads.push(value);
    if (ENV_FILES.has(option)) envFiles.push(value);
  }
  return { rest: words.slice(index), test, preloads, envFiles };
}
/**
 * Return №4186 P3: one command of a script, classified by the narrow grammar only — [NAME=literal]* [cross-env NAME=literal…]
 * (node | a path ending in node) [node options]* --test [patterns]*, or npm/yarn/pnpm running a script [-- words]. A command
 * that carries a runner but does not fit the grammar whole is unknown; one that carries none is no run.
 */
function classify(command: string): Run {
  const runner = /(?:^|\s)--test(?:\s|=|$)|\b(?:node|nodejs)\b/.test(command) || [...OTHER_RUNNERS].some(name => new RegExp(`(?:^|[\\s/])${name}(?:\\s|$)`).test(command));
  const words = shellWords(command);
  if (!words) return runner ? { kind: 'unknown', why: 'the command is computed or quoted in a form this analysis does not read' } : { kind: 'plain' };
  let index = 0;
  const preloads: string[] = [], envFiles: string[] = [];
  const environment = (word: string): boolean | string => {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
    if (!assignment) return false;
    if (assignment[1] !== 'NODE_OPTIONS') return true;
    const options = shellWords(assignment[2]!), parsed = options ? nodeOptions(options) : 'NODE_OPTIONS is computed';
    if (typeof parsed === 'string') return parsed;
    if (parsed.rest.length || parsed.test) return 'NODE_OPTIONS carries what node does not take there';
    preloads.push(...parsed.preloads); envFiles.push(...parsed.envFiles);
    return true;
  };
  for (;;) {
    const word = words[index];
    if (word === 'cross-env') { index++; continue; }
    const env = word === undefined ? false : environment(word);
    if (typeof env === 'string') return { kind: 'unknown', why: env };
    if (!env) break;
    index++;
  }
  const head = words[index], rest = words.slice(index + 1);
  if (head === undefined) return { kind: 'plain' };
  if (/^(?:.*\/)?node(?:js)?$/.test(head)) {
    const parsed = nodeOptions(rest);
    if (typeof parsed === 'string') return runner ? { kind: 'unknown', why: parsed } : { kind: 'plain' };
    // Options end at the first positional: after it come the script's own words (node script.js --test is no test run).
    if (!parsed.test) return { kind: 'plain' };
    if (parsed.rest.some(word => word.startsWith('-'))) return { kind: 'unknown', why: 'an option follows the patterns of the run' };
    return { kind: 'node', patterns: parsed.rest, preloads: [...preloads, ...parsed.preloads], envFiles: [...envFiles, ...parsed.envFiles] };
  }
  if (['npm', 'yarn', 'pnpm'].includes(head)) {
    const [first, second] = rest;
    const dash = rest.indexOf('--'), named = head === 'npm' ? (first === 'run' || first === 'run-script' ? second : ['test', 't', 'start', 'stop', 'restart'].includes(first ?? '') ? (first === 't' ? 'test' : first) : undefined)
      : first === 'run' ? second : first !== 'exec' ? first : undefined;
    if (!named) return runner ? { kind: 'unknown', why: `${head} ${first ?? ''} is outside the grammar this analysis reads` } : { kind: 'plain' };
    const after = head === 'npm' ? (dash < 0 ? [] : rest.slice(dash + 1)) : rest.slice(first === 'run' ? 2 : 1);
    if (head === 'npm' && rest.slice(first === 'run' || first === 'run-script' ? 2 : 1, dash < 0 ? undefined : dash).length) return { kind: 'unknown', why: 'npm takes options this analysis does not read' };
    return { kind: 'npm', script: named, args: after };
  }
  if (OTHER_RUNNERS.has(head) || ['bun', 'deno'].includes(head) && rest[0] === 'test' || ['tsx', 'ts-node'].includes(head) && rest.includes('--test')) {
    // Its own selection is not read; its literal preloads still reach the tests an answer names.
    const carried = rest.flatMap((word, at) => PRELOADS.has(word) && rest[at + 1] ? [rest[at + 1]!] : PRELOADS.has(word.split('=')[0]!) && word.includes('=') ? [word.split('=').slice(1).join('=')] : []);
    return { kind: 'other', runner: head, preloads: [...preloads, ...carried] };
  }
  return runner ? { kind: 'unknown', why: `${head} wraps a run this analysis does not read` } : { kind: 'plain' };
}
interface Selection { tests: Set<string>; unknowns: (ScannedUnknown & { carries: string[] })[]; edges: [string, string, ImpactVia][] }
/**
 * Return №4180, №4186 P3: the tests are the files a supported runner selects for a run written in a package script — its
 * working directory, its arguments, files, globs and the runner's defaults read on the exact tree (an output path by its proved
 * source) — never by running anything. node --test is the runner read; another runner, a computed or unread part, an unread
 * configuration that chooses tests (a runner's own, CI's, npm's node-options), a run whose working directory a command changes, is
 * an unknown selection; its answer names the tests. Each selected test reaches the run's preloads, env files and the manifest
 * that defines it. A file named *.test.* or *.spec.* stays a test as well: one more test is the cautious side.
 */
function selection(files: SnapshotFiles, manifests: ReadonlyMap<string, Record<string, unknown> | null>, output: OutputMap | null, present: ReadonlySet<string>, local: Local): Selection {
  const tree: Tree = { present, output, manifests };
  const tests = new Set(files.paths.filter(isTestFile)), unknowns: Selection['unknowns'] = [], edges: Selection['edges'] = [], defining = new Set<string>();
  const ask = (file: string, text: string, basis: string, carries: string[] = []) =>
    unknowns.push({ file, line: 0, kind: 'selection', text: excerpt(text), site: { start: 0, end: 0, hash: sha256(`selection:${file}:${basis}`) }, carries });
  for (const path of files.paths.filter(path => SELECTION_CONFIG.test(path))) ask(path, `${path} chooses tests and is not read`, path, [path]);
  for (const path of files.paths.filter(path => posix.basename(path) === '.npmrc'))
    if (/node[-_]options/i.test(files.text(path) ?? 'node-options')) ask(path, `${path} passes node options to every run`, files.text(path) ?? path, [path]);
  const built = (path: string): string | null => {
    if (!output || !(output.root === '.' || path.startsWith(`${output.root}/`))) return null;
    const rest = output.root === '.' ? path : path.slice(output.root.length + 1), js = rest.replace(/\.([cm]?)tsx?$/, (_m, flavour: string) => `.${flavour}js`);
    return js === rest && !/\.[cm]?jsx?$/.test(rest) ? null : posix.join(output.out, js);
  };
  /** Files resolved for a run: relative to its working directory, a bare name as a module; unresolved — null. */
  const resolved = (cwd: string, value: string): string[] | null => {
    const from = `${cwd}/package.json`, target = /^\.{0,2}\//.test(value) || !/^[@\w]/.test(value) ? resolveAll(tree, from, /^\.{1,2}\//.test(value) ? value : `./${value}`, false)
      : resolveAll(tree, from, `./${value}`, false) ?? bare(local, tree, from, value);
    return Array.isArray(target) ? target : target === 'external' ? [] : null;
  };
  for (const [manifest, value] of manifests) {
    if (!value) continue;
    for (const field of ['mocha', 'jest', 'ava']) if (field in value) { defining.add(manifest); ask(`${manifest}#${field}`, `${manifest} configures ${field}`, JSON.stringify(value[field]), [manifest]); }
    const cwd = posix.dirname(manifest), scripts = (value['scripts'] ?? {}) as Record<string, unknown>;
    const evaluate = (name: string, script: string, appended: readonly string[], seen: ReadonlySet<string>): void => {
      const node = `${manifest}#scripts.${name}`;
      const unknown = (why: string, carries: string[] = []) => { defining.add(manifest); ask(node, `${name}: ${script} — ${why}`, `${script} ${appended.join(' ')}`, [manifest, ...carries]); };
      const commands = commandsIn(script);
      if (!commands) { if (/--test|\bnode\b/.test(script)) unknown('the quoting is not read'); return; }
      let moved = false;
      commands.forEach((command, at) => {
        const words = at === commands.length - 1 && appended.length ? `${command} ${appended.map(word => `'${word}'`).join(' ')}` : command;
        const run = classify(words);
        if (/^\s*(?:cd|pushd)\s/.test(command)) { moved = true; return; }
        if (run.kind === 'plain') return;
        if (moved) return unknown('a command before the run changes its working directory');
        if (run.kind === 'unknown') return unknown(run.why);
        if (run.kind === 'other') { const carries = run.preloads.flatMap(item => resolved(cwd, item) ?? []); return unknown(`${run.runner} selects its tests by rules this analysis does not read`, carries); }
        if (run.kind === 'npm') {
          if (!run.args.length) return;
          const target = scripts[run.script];
          if (typeof target !== 'string' || seen.has(run.script)) return unknown(`the run of ${run.script} with its words is not read`);
          return evaluate(run.script, target, run.args, new Set([...seen, run.script]));
        }
        defining.add(manifest);
        const reach: string[] = [], unresolvedCarried: string[] = [];
        for (const item of [...run.preloads, ...run.envFiles]) { const found = resolved(cwd, item); if (found === null) unresolvedCarried.push(item); else reach.push(...found); }
        const chosen = new Set<string>();
        for (const pattern of run.patterns) {
          const regex = globRegex(posix.normalize(pattern).replace(/\/$/, ''));
          if (regex === null) return unknown(`the glob ${pattern} is a form this analysis does not read`, reach);
          const literal = !/[*?{]/.test(pattern);
          const before = chosen.size;
          for (const path of files.paths) {
            if (path.split('/').includes('node_modules')) continue;
            const out = built(path);
            if ([posix.relative(cwd, path), out === null ? null : posix.relative(cwd, out)].some(form => form !== null && regex.test(form))) chosen.add(path);
          }
          // A literal argument that names no file of the tree — a directory (node 22.23.1 loads it as a module), an output the
          // tree does not map — or a glob of an output directory the tree does not hold: unsettled.
          const normal = posix.normalize(posix.join(cwd, pattern)).replace(/\/$/, ''), head = normal.split(/[*?{]/)[0]!;
          const dir = /[*?{]/.test(normal) ? (head.endsWith('/') ? head.slice(0, -1) : posix.dirname(head)) : normal;
          const held = dir === '.' || files.paths.some(path => path.startsWith(`${dir}/`));
          if (literal && chosen.size === before || !literal && chosen.size === before && !held) return unknown(`the argument ${pattern} is not settled on the tree`, reach);
        }
        if (!run.patterns.length) for (const path of files.paths) {
          if (path.split('/').includes('node_modules')) continue;
          const own = posix.relative(cwd, path), out = built(path);
          if (own.startsWith('..')) continue;
          if ([own, out === null ? null : posix.relative(cwd, out)].some(form => form !== null && !form.startsWith('..') && NODE_DEFAULT.test(form))) chosen.add(path);
        }
        for (const test of chosen) { tests.add(test); edges.push([test, manifest, 'config']); for (const target of reach) edges.push([test, target, 'import']); }
        // What the run carries and the tree does not resolve is asked; the selection proved stays (№4188 P3).
        if (unresolvedCarried.length) unknown(`${unresolvedCarried.join(', ')} is not resolved`, reach);
      });
    };
    for (const [name, script] of Object.entries(scripts)) if (typeof script === 'string') evaluate(name, script, [], new Set([name]));
  }
  // A package that defines no run at all, while node's own default from it would select files the names do not: which are
  // tests there is not established.
  const scopes = [...manifests.keys()].map(manifest => posix.dirname(manifest));
  if (!manifests.has('package.json')) scopes.push('.');
  for (const scope of scopes) {
    const manifest = scope === '.' ? 'package.json' : `${scope}/package.json`;
    if (defining.has(manifest)) continue;
    const owner = (path: string) => scopes.filter(other => other === '.' || path.startsWith(`${other}/`)).sort((a, b) => b.length - a.length)[0];
    if (files.paths.some(path => owner(path) === scope && !path.split('/').includes('node_modules') && NODE_DEFAULT.test(scope === '.' ? path : path.slice(scope.length + 1)) && !tests.has(path)))
      ask(manifests.has(manifest) ? manifest : '.', 'No package script defines a test run: which files are tests is not established', `no-run:${scope}`, manifests.has(manifest) ? [manifest] : []);
  }
  return { tests, unknowns, edges };
}
/**
 * Return №4186 P1: the files a computed load may name are every file of the snapshot but its own — the text around a
 * computed part proves no bound of the path ('..' in the part, a ?query or #hash in the tail). Its question is one of the
 * snapshot, and its answer serves every work.
 */
const candidatesOf = (paths: readonly string[], file: string): string[] => paths.filter(path => path !== file);
/**
 * The one impact derivation, shared by the brief that shows it and G5 that checks a work against it. Deterministic over
 * the exact files: sorted, with no time and no current head.
 */
export function deriveImpact(files: SnapshotFiles & { readonly unanalyzed?: ReadonlySet<string>; readonly links?: ReadonlySet<string> }, works: readonly ImpactWork[],
  resolutions: readonly ImpactResolution[] = []): ImpactInventory {
  const present = new Set(files.paths), facts_ = new Map<string, FileFacts>(), reverse = new Map<string, Reference[]>(), output = outputMap(files);
  const manifests = new Map(files.paths.filter(path => posix.basename(path) === 'package.json').map(path => {
    let value: unknown = null; try { value = JSON.parse(files.text(path) ?? 'null'); } catch { value = null; }
    return [path, typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null] as const;
  }));
  const local = localMappings(files, manifests), links = files.links ?? new Set<string>(), unanalyzed = files.unanalyzed ?? new Set<string>();
  const tree: Tree = { present, output, manifests };
  const link = (from: string, to: string | null, via: ImpactVia, line: number) => {
    if (!to || to === from) return;
    const list = reverse.get(to) ?? []; list.push({ target: from, via, line }); reverse.set(to, list);
  };
  // The identity of a transition is its exact place in the file of the snapshot — never the excerpt shown for it.
  const transition = (file: string, site: TransitionSite) => JSON.stringify([file, site.start, site.end, site.hash]);
  const resolved = new Map(resolutions.map(item => [transition(item.file, item.site), item]));
  /** The package.json the file belongs to (the nearest on the way to the root), or none. */
  const manifestOf = (path: string): string | null => {
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      const manifest = dir === '.' ? 'package.json' : `${dir}/package.json`;
      if (present.has(manifest)) return manifest;
      if (dir === '.') return null;
    }
  };
  /** A run of a package script or bin: its node in the nearest package that has it; a registry bin leaves the tree. */
  const run = (from: string, name: string, bin: boolean): string | 'external' | null => {
    for (let dir = posix.dirname(from.split('#')[0]!); ; dir = posix.dirname(dir)) {
      const manifest = dir === '.' ? 'package.json' : `${dir}/package.json`, value = manifests.get(manifest);
      if (value && !bin && typeof (value['scripts'] as Record<string, unknown> | undefined)?.[name] === 'string') return `${manifest}#scripts.${name}`;
      if (value && bin) {
        const bins = value['bin'];
        if (typeof bins === 'string' && value['name'] === name) return `${manifest}#bin`;
        if (bins && typeof bins === 'object' && name in bins) return `${manifest}#bin.${name}`;
        if (bare(local, tree, from.split('#')[0]!, name) === 'external') return 'external';
      }
      if (dir === '.') return null;
    }
  };
  /** Return №4173 G15, №4186: what builds and runs a file — its package, every tsconfig/jsconfig on its way to the root, the locks. */
  const configs = files.paths.filter(path => /(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/.test(path) || LOCKS.includes(posix.basename(path)));
  const configsOf = (path: string): string[] => {
    const owner = manifestOf(path);
    return [...(owner ? [owner] : []), ...configs.filter(config => { const dir = posix.dirname(config); return dir === '.' || path.startsWith(`${dir}/`); })];
  };
  const chosen = selection(files, manifests, output, present, local);
  const tests = new Set(chosen.tests);
  // An answered selection names tests; each reaches what its run carries (the manifest, preloads, a runner's configuration).
  for (const unknown of chosen.unknowns) for (const test of resolved.get(transition(unknown.file, unknown.site))?.resolves ?? []) if (present.has(test)) {
    tests.add(test);
    for (const carried of unknown.carries) link(test, carried, carried.endsWith('package.json') ? 'config' : 'import', 0);
  }
  const isTestSupport_ = (path: string) => tests.has(path) || isTestSupport(path);
  for (const [test, target, via] of chosen.edges) link(test, target, via, 0);
  for (const path of files.paths) {
    const text = files.text(path);
    if (text === null) continue;
    let found: FileFacts | null = null;
    if (posix.basename(path) === 'package.json') {
      const references = packageReferences(path, text);
      // A package file JSON does not take hides its scripts and entries: it is the one unknown of the whole file.
      if (!references) found = { specifiers: [], unknowns: [wholeFile(path, text, 0, 'The package file is not JSON')], cases: [], addressable: false };
      for (const ref of references ?? []) {
        if (ref.script || ref.bin) { const target = run(path, ref.value, !!ref.bin); if (target && target !== 'external') link(ref.from, target, 'script', ref.line); continue; }
        const targets = resolveAll(tree, path, ref.value, true);
        for (const target of Array.isArray(targets) ? targets : []) link(ref.from, target, 'script', ref.line);
      }
    } else if (CODE.test(path)) {
      const parsed = analysisOf(files, path, text).facts, unresolved: ScannedUnknown[] = [], cwd = manifestOf(path);
      const origins = cwd ? [posix.dirname(cwd)] : ['.'];
      for (const item of parsed.specifiers) {
        if (item.script || item.bin) {
          const target = run(path, item.value, !!item.bin);
          if (target && target !== 'external') link(path, target, item.via, item.line);
          else if (target === null) unresolved.push({ file: path, line: item.line, kind: 'unresolved', text: excerpt(item.text), site: item.site });
          continue;
        }
        const rooted = item.via === 'launch', relative = item.value.startsWith('./') || item.value.startsWith('../') || item.value.startsWith('/');
        const extra = item.cwd ? origins : [];
        const target = resolveAll(tree, path, item.value, rooted, extra) ?? (item.operation && !relative && !rooted ? bare(local, tree, path, item.value) : null);
        if (Array.isArray(target)) { for (const found of target) link(path, found, item.via, item.line); continue; }
        // A literal a load takes and no file resolves: outside the tree only by proof, otherwise an unknown at its place.
        const closed = target === 'external' || target === null && (!item.operation || proved(files.paths, path, item.value, rooted, output, item.via !== 'launch', extra));
        if (!closed) unresolved.push({ file: path, line: item.line, kind: 'unresolved', text: excerpt(item.text), site: item.site });
      }
      // Return №4173 G15: a file is built and run under its package, the project's tsconfig and the lock — a change to them
      // reaches it (never directly: a test that only depends on the configuration is a transitive entry).
      for (const config of configsOf(path)) link(path, config, 'config', 0);
      found = unresolved.length ? { ...parsed, unknowns: [...parsed.unknowns, ...unresolved] } : parsed;
    }
    if (!found) continue;
    facts_.set(path, found);
  }
  // Return №4173 G7, №4186 P4: one way for every edge, literal or answered — a file an edge reaches that this analysis does not
  // read and whose format can load another file (a component of another language, a symbolic link) is one unknown of the whole
  // file; an accepted answer applies its edges whatever kind of unknown it answers, and the files it names go the same way.
  const unread = (target: string) => {
    if (facts_.has(target) || target.includes('#') || posix.basename(target) === 'package.json' || unanalyzed.has(target) || INERT.test(target)) return false;
    if (CODE.test(target) && files.text(target) !== null) return false;
    const ext = posix.extname(target);
    facts_.set(target, { specifiers: [], cases: [], addressable: false, unknowns: [{ file: target, line: 0, kind: 'unparsed', site: { start: 0, end: 0, hash: sha256(`unread:${target}`) },
      text: links.has(target) ? 'A symbolic link the analysis does not follow' : `The analysis does not read files of the kind ${ext || 'without an extension'}` }] });
    return true;
  };
  const applied = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const target of [...reverse.keys()]) if (unread(target)) grew = true;
    for (const [path, found] of facts_) for (const unknown of found.unknowns) {
      const key = transition(unknown.file, unknown.site), answer = resolved.get(key);
      if (!answer || applied.has(key)) continue;
      applied.add(key); grew = true;
      for (const target of answer.resolves) link(path, present.has(target) ? target : null, 'resolution', unknown.line);
    }
  }
  for (const path of unanalyzed) for (const target of resolved.get(transition(path, unanalyzedSite(path)))?.resolves ?? [])
    link(path, present.has(target) ? target : null, 'resolution', 0);
  // Every unresolved transition of the snapshot with the files it may name, computed once for every work.
  const open: ImpactUnknown[] = [];
  for (const found of facts_.values()) for (const unknown of found.unknowns)
    if (!resolved.has(transition(unknown.file, unknown.site))) open.push({ ...unknown, candidates: candidatesOf(files.paths, unknown.file) });
  for (const path of unanalyzed) if (!resolved.has(transition(path, unanalyzedSite(path))))
    open.push({ file: path, line: 0, kind: 'unanalyzed', text: UNANALYZED, site: unanalyzedSite(path), candidates: files.paths.filter(other => other !== path) });
  const selections = chosen.unknowns.filter(unknown => !resolved.has(transition(unknown.file, unknown.site)))
    .map(({ carries: _carries, ...unknown }) => ({ ...unknown, candidates: files.paths.filter(path => CODE.test(path)) }));
  const result: WorkImpact[] = [];
  for (const work of sorted(works, item => item.work)) {
    const affected = sorted(new Set(work.writes.filter(path => present.has(path))));
    const reach = new Map<string, { via: Set<ImpactVia>; reaches: Set<string>; direct: boolean }>();
    for (const origin of affected) {
      // Two walks: everything that reaches the origin, and what reaches it through test support alone (the direct ones).
      const queue = [origin], visited = new Set([origin]);
      while (queue.length) {
        const current = queue.shift()!;
        for (const edge of reverse.get(current) ?? []) {
          const row = reach.get(edge.target) ?? { via: new Set<ImpactVia>(), reaches: new Set<string>(), direct: false };
          if (current === origin || !reach.has(edge.target)) row.via.add(edge.via);
          row.reaches.add(origin); reach.set(edge.target, row);
          if (!visited.has(edge.target)) { visited.add(edge.target); queue.push(edge.target); }
        }
      }
      const near = [origin], close = new Set([origin]);
      while (near.length) {
        const current = near.shift()!;
        for (const edge of reverse.get(current) ?? []) {
          if (edge.via === 'config' || !isTestSupport_(edge.target) || close.has(edge.target)) continue;
          close.add(edge.target); near.push(edge.target); reach.get(edge.target)!.direct = true;
        }
      }
    }
    // A test the work itself writes is an entry of its own (reached or not): changing an existing expectation is a decision
    // of this inventory, never a foreign one.
    for (const test of affected.filter(path => tests.has(path))) {
      const row = reach.get(test) ?? { via: new Set<ImpactVia>(), reaches: new Set<string>(), direct: true };
      row.via.add('write'); row.reaches.add(test); row.direct = true; reach.set(test, row);
    }
    const affectedSet = new Set(affected);
    const consumers = sorted([...reach.keys()].filter(path => !affectedSet.has(path)));
    const entries = sorted([...reach.keys()].filter(path => tests.has(path))).map(test => {
      const own = facts_.get(test);
      const row = reach.get(test)!;
      return { test, direct: row.direct, cases: own?.cases ?? [], addressable: own?.addressable ?? false, via: sorted(row.via), reaches: sorted(row.reaches) };
    });
    // Return №4186 P1: an unresolved transition of the snapshot is asked of every work that changes an existing file — no text
    // of its expression proves which files it cannot name; its one answer serves them all.
    const unknowns: ImpactUnknown[] = affected.length ? [...selections, ...open] : [];
    result.push({ work: work.work, affected, entries, consumers: consumers.filter(path => !tests.has(path)),
      unknowns: sorted(unknowns, item => `${item.file}:${String(item.site.start).padStart(10, '0')}:${item.site.hash}`) });
  }
  return { contract: IMPACT_CONTRACT, snapshot: { commit: files.snapshot.commit, tree: files.snapshot.tree }, parser: IMPACT_PARSER, boundary: [...IMPACT_BOUNDARY], works: result };
}

/**
 * The map a works brief shows before the work's own write scope exists (№4091 п.5): for each code file a test reaches, the
 * tests that import or launch it directly and how many reach it only through other code. The same derivation as G5's,
 * by file; G5 checks the exact inventory of the scope the answer chooses.
 */
export interface TestMapRow { file: string; direct: string[]; transitive: number }
/** The case addresses of every test the map names, once: what an addressed update may name. */
export interface TestCasesRow { test: string; addressable: boolean; cases: string[][] }
export function deriveTestMap(files: SnapshotFiles & { readonly unanalyzed?: ReadonlySet<string> }, resolutions: readonly ImpactResolution[] = []):
  { map: TestMapRow[]; tests: TestCasesRow[] } {
  const candidates = files.paths.filter(path => CODE.test(path) && !isTestSupport(path));
  const inventory = deriveImpact(files, candidates.map(path => ({ work: path, writes: [path] })), resolutions);
  const tests = new Map<string, TestCasesRow>();
  for (const work of inventory.works) for (const entry of work.entries)
    tests.set(entry.test, { test: entry.test, addressable: entry.addressable, cases: entry.cases.map(item => item.path) });
  return { map: inventory.works.filter(work => work.entries.length).map(work => ({ file: work.work,
    direct: work.entries.filter(entry => entry.direct).map(entry => entry.test), transitive: work.entries.filter(entry => !entry.direct).length })),
  tests: sorted(tests.values(), row => row.test) };
}

/**
 * The one coverage of a work's exact inventory by its decisions (№4098), computed by G5's producer and saved with it —
 * never computed again by a reader. A direct test and a test with a known contradiction need the work's explicit decision;
 * the transitive keep covers exactly the remainder of this inventory, nothing a later inventory adds; an addressed case
 * must be a reliable address of this inventory and leaves the rest of its file kept explicitly; no decision closes an
 * unknown; a decision about an expectation outside this work's inventory is refused.
 */
export const IMPACT_GATE_CODES = Object.freeze(['work_impact_case_unknown', 'work_impact_entry_foreign', 'work_impact_undecided', 'work_impact_unresolved',
  'work_policy_open', 'work_integration_unproven'] as const);
export interface ImpactFinding { code: typeof IMPACT_GATE_CODES[number]; target: string; field: string; message: string }
export interface ImpactCoverage { work: string; covered: { test: string; by: 'file' | 'cases' | 'transitive' }[]; findings: ImpactFinding[] }
export function impactCoverage(work: WorkImpact, decisions: readonly ImpactDecision[], known: ReadonlySet<string> = new Set()): ImpactCoverage {
  const findings: ImpactFinding[] = [], covered: ImpactCoverage['covered'] = [];
  const add = (code: ImpactFinding['code'], field: string, message: string) => findings.push({ code, target: work.work, field, message });
  const entries = new Map(work.entries.map(entry => [entry.test, entry]));
  const transitive = decisions.some(item => 'transitive' in item.entry && item.decision === 'keep');
  for (const item of decisions) {
    const files = 'files' in item.entry ? item.entry.files : 'file' in item.entry ? [item.entry.file] : [];
    for (const file of files) if (!entries.has(file))
      add('work_impact_entry_foreign', file, `A decision names an expectation outside this work's exact inventory: ${file}`);
  }
  for (const entry of work.entries) {
    const whole = decisions.some(item => ('files' in item.entry && item.entry.files.includes(entry.test))
      || ('file' in item.entry && item.entry.file === entry.test && !('case' in item.entry) && !('rest' in item.entry)));
    const addressed = decisions.filter(item => 'file' in item.entry && item.entry.file === entry.test && 'case' in item.entry);
    const rest = decisions.some(item => 'file' in item.entry && item.entry.file === entry.test && 'rest' in item.entry && item.decision === 'keep');
    if (whole) { covered.push({ test: entry.test, by: 'file' }); continue; }
    if (addressed.length) {
      for (const item of addressed) {
        const path = (item.entry as { case: string[] }).case;
        if (!entry.addressable || !entry.cases.some(found => JSON.stringify(found.path) === JSON.stringify(path)))
          add('work_impact_case_unknown', `${entry.test}#${path.join(' > ')}`, `An addressed case must be a reliable address of this inventory: ${entry.test}`);
      }
      if (!rest) add('work_impact_undecided', entry.test, `The other expectations of ${entry.test} are not kept explicitly after its addressed updates`);
      else covered.push({ test: entry.test, by: 'cases' });
      continue;
    }
    if (transitive && !entry.direct && !known.has(entry.test)) { covered.push({ test: entry.test, by: 'transitive' }); continue; }
    add('work_impact_undecided', entry.test, entry.direct ? `${entry.test} reaches ${entry.reaches.join(', ')} directly: it needs this work's explicit keep or update`
      : known.has(entry.test) ? `${entry.test} holds a known contradiction: it needs this work's explicit decision` : `${entry.test} is undecided: keep it, update it, or keep the transitive remainder`);
  }
  for (const unknown of work.unknowns)
    add('work_impact_unresolved', transitionField(unknown), `An unresolved transition may reach this work's files: ${unknown.text}`);
  return { work: work.work, covered, findings };
}

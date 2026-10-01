import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

// №32: the import ring is a ratchet — it may only shrink. The limits are the
// largest strongly connected component sizes measured on om/module = a574007.
const LOAD_RING_LIMIT = 83;
const FULL_RING_LIMIT = 133;

type Graph = Map<string, string[]>;

// Relative './x.js' specifiers resolve to './x.ts' inside the source tree;
// non-relative specifiers and targets outside the tree are not ring members.
function edgeTarget(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const body = specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.ts` : specifier;
  const resolved = normalize(join(dirname(from), body)).replaceAll('\\', '/');
  return resolved === '..' || resolved.startsWith('../') ? null : resolved;
}

// Static edges: `import … from`, `export … from`, bare `import`. Type-only
// imports and exports exist only in the full graph, never in the load graph.
function collectEdges(files: Map<string, string>): { load: Graph; full: Graph } {
  const load: Graph = new Map(); const full: Graph = new Map();
  for (const name of files.keys()) { load.set(name, []); full.set(name, []); }
  for (const [name, content] of files) {
    const source = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      let specifier: string | undefined; let typeOnly = false;
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        typeOnly = clause?.isTypeOnly ?? false;
        // `import { type B }` with every named element type-only emits nothing —
        // it is a full-graph edge only. A default binding, a namespace import
        // or any value element keeps the load edge; an empty list stays load.
        if (!typeOnly && clause !== undefined && clause.name === undefined
          && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0
          && clause.namedBindings.elements.every(element => element.isTypeOnly)) typeOnly = true;
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
        && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text;
        const clause = statement.exportClause;
        typeOnly = statement.isTypeOnly
          || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0
            && clause.elements.every(element => element.isTypeOnly));
      } else if (ts.isImportEqualsDeclaration(statement)
        && ts.isExternalModuleReference(statement.moduleReference)
        && ts.isStringLiteral(statement.moduleReference.expression)) {
        specifier = statement.moduleReference.expression.text;
        typeOnly = statement.isTypeOnly;
      }
      if (specifier === undefined) continue;
      const target = edgeTarget(name, specifier);
      if (target === null || !files.has(target)) continue;
      full.get(name)!.push(target);
      if (!typeOnly) load.get(name)!.push(target);
    }
  }
  return { load, full };
}

// Tarjan: the largest strongly connected component, members sorted; ties are
// broken by the joined member list so the report is deterministic.
function largestComponent(graph: Graph): string[] {
  const index = new Map<string, number>(); const low = new Map<string, number>();
  const onStack = new Set<string>(); const stack: string[] = [];
  let next = 0; let largest: string[] = [];
  const visit = (node: string) => {
    index.set(node, next); low.set(node, next); next += 1;
    stack.push(node); onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!index.has(target)) { visit(target); low.set(node, Math.min(low.get(node)!, low.get(target)!)); }
      else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!));
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = []; let member: string;
      do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== node);
      component.sort();
      if (component.length > largest.length
        || (component.length === largest.length && component.join() < largest.join())) largest = component;
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return largest;
}

function sources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true })) {
    const name = String(entry).replaceAll('\\', '/');
    if (name.endsWith('.ts')) files.set(name, readFileSync(join(root, name), 'utf8'));
  }
  return files;
}

test('the import ring is a ratchet: the largest strongly connected component of src imports must not grow', t => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const { load, full } = collectEdges(sources(root));
  for (const [label, graph, limit] of [['load', load, LOAD_RING_LIMIT], ['full', full, FULL_RING_LIMIT]] as const) {
    const ring = largestComponent(graph);
    t.diagnostic(`${label}: largest import ring has ${ring.length} file(s), limit ${limit}`);
    assert.ok(ring.length <= limit, `${label} import ring grew to ${ring.length} (limit ${limit}): ${ring.join(', ')}`);
    if (ring.length < limit) t.diagnostic(`${label}: the ring shrank to ${ring.length} — lower the limit; the ratchet only moves down`);
  }
});

test('ring detection is exact: a synthetic a→b→c→a ring is found and type-only edges count only in the full graph', () => {
  const files = new Map([
    ['a.ts', "import './b.js';\nexport const a = 1;\n"],
    ['b.ts', "import './c.js';\nexport const b = 1;\n"],
    ['c.ts', "import './a.js';\nimport type { D } from './d.js';\nexport const c = 1;\n"],
    ['d.ts', "import './a.js';\nexport type D = number;\n"],
  ]);
  const { load, full } = collectEdges(files);
  assert.deepEqual(largestComponent(load), ['a.ts', 'b.ts', 'c.ts']);
  assert.deepEqual(largestComponent(full), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
});

test('edge extraction is complete: import-equals closes a ring, fully type-only named forms stay out of the load graph, mixed forms keep it', () => {
  const equals = collectEdges(new Map([
    ['a.ts', "import b = require('./b.js');\nexport const a = 1;\n"],
    ['b.ts', "import './a.js';\nexport const b = 1;\n"],
  ]));
  assert.deepEqual(largestComponent(equals.load), ['a.ts', 'b.ts']);
  assert.deepEqual(largestComponent(equals.full), ['a.ts', 'b.ts']);
  const typeEquals = collectEdges(new Map([
    ['a.ts', "import type b = require('./b.js');\nexport const a = 1;\n"],
    ['b.ts', "import './a.js';\nexport const b = 1;\n"],
  ]));
  assert.equal(largestComponent(typeEquals.load).length, 1);
  assert.deepEqual(largestComponent(typeEquals.full), ['a.ts', 'b.ts']);
  for (const [label, statement] of [
    ['import', "import { type B } from './b.js';\nexport type A = B;\n"],
    ['export', "export { type B } from './b.js';\n"],
  ] as const) {
    const graphs = collectEdges(new Map([
      ['a.ts', statement],
      ['b.ts', "import './a.js';\nexport type B = number;\n"],
    ]));
    assert.equal(largestComponent(graphs.load).length, 1, `${label} { type B } must be absent from the load graph`);
    assert.deepEqual(largestComponent(graphs.full), ['a.ts', 'b.ts'], `${label} { type B } must stay in the full graph`);
  }
  for (const [label, statement] of [
    ['import', "import { type B, c } from './b.js';\nexport const a = c;\n"],
    ['export', "export { type B, c } from './b.js';\n"],
  ] as const) {
    const graphs = collectEdges(new Map([
      ['a.ts', statement],
      ['b.ts', "import './a.js';\nexport type B = number;\nexport const c = 1;\n"],
    ]));
    assert.deepEqual(largestComponent(graphs.load), ['a.ts', 'b.ts'], `mixed ${label} keeps its load edge`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { canonical, type Json } from '../src/canonical.js';
import { Evidence } from '../src/evidence/evidence.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { packetAnswerSchema } from '../src/om/question-packet.js';
import { BRIEF_VERSION, deriveBrief, briefMaterial, packetPrompt, type BriefBasis } from '../src/om/packet-brief.js';
import { gardenGraph } from './om-fixture.js';

// SAMPLE-SPEED: the MC1 example of a resultForm is kept for an ordinary stable JSON schema only. Every brief equals the one
// the uncached derivation gives — a transparent Proxy over the same schema is never keyed and so is that derivation.
let unique = 0;
const described = (schema: Record<string, unknown>) => ({ ...schema, description: `sample-speed ${process.pid} ${++unique}` });

function world(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-sample-speed-'))), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  new Evidence(store).document('garden', 'reference', 'Кириллица 😀 sample source', 'text/plain', 0);
  const context = store.write({ id: 'om-input:garden', kind: 'om-input', expected: 0, value: { known: true } });
  const basis: BriefBasis = { project: 'garden', graph: gardenGraph(), node: 'garden-consume-block',
    gaps: [{ question: 'q-native', target: 'criterion', field: 'checkKind', ref: { id: 'gap:garden:one', revision: 1, hash: '1'.repeat(64) }, evidence: [] }],
    contexts: [reference(context)], accepted: [], input: { requirements: [], criteria: [], contracts: [], questions: [] },
    material: briefMaterial(store, 'garden', root, false), materialBudget: 45000, codes: [] };
  const brief = (resultForm: unknown) => deriveBrief({ version: BRIEF_VERSION, requestId: 'brief-request', task: 'fact', model: 'MC1', purpose: 'model-research',
    questions: [{ id: 'q-native', target: 'criterion', field: 'answer', contract: { establishes: 'Какова форма?', resultForm } }],
    responseForm: { protocol: 'omg-answer/v3', requestId: 'brief-request', schema: packetAnswerSchema('fact') }, refusals: [] }, basis);
  return { brief };
}
const example = (payload: Record<string, any>): Json | undefined =>
  payload.brief.examples.find((row: { action: string }) => row.action === 'answer')?.results[0].value;
const bytes = (payload: Record<string, any>) => canonical(payload) + packetPrompt(payload);
const transparent = <T extends object>(value: T): T => new Proxy(value, {});

/** Counts strict-Ajv compilations of one schema content on the prototype, leaving instances untouched; restored by t.after. */
function compilations(t: test.TestContext) {
  const previous = Ajv.prototype.compile, seen: { schema: unknown; text: string | null }[] = [];
  const stringify = JSON.stringify, text = (schema: unknown) => { try { return stringify(schema); } catch { return null; } };
  Ajv.prototype.compile = function (this: Ajv, schema: unknown, meta?: boolean) {
    seen.push({ schema, text: text(schema) });
    return previous.call(this, schema as never, meta);
  } as typeof previous;
  let done = false;
  const restore = () => { if (!done) { done = true; Ajv.prototype.compile = previous; } };
  t.after(restore);
  // By content, or by identity where the content cannot be serialized (a cycle).
  return { of: (schema: unknown) => seen.filter(row => row.schema === schema || row.text !== null && row.text === text(schema)).length, restore };
}

test('SAMPLE-SPEED: ordinary schemas compile once and every repeat equals the uncached derivation byte for byte', async t => {
  const f = world(t), counted = compilations(t);
  const schemas = [
    { type: 'string', minLength: 3 }, { type: 'string', maxLength: 4 }, { type: 'integer', minimum: 2.5 }, { type: 'number', maximum: -3 },
    { type: 'boolean' }, { type: 'null' }, { enum: ['first', { z: 1 }] }, { const: [1, 'two', null] },
    { type: 'array', minItems: 2, items: { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 7 } } } },
    { type: 'object', minProperties: 2, properties: { b: { type: 'string' }, a: { type: 'number' }, c: { type: 'null' } } },
    { type: 'object', required: ['z', 'a'], properties: { a: { enum: [3] }, z: { type: 'array', minItems: 0 } } },
    { type: 'object', required: ['inner'], properties: { inner: { type: 'object', required: ['deep'], properties: { deep: { const: 'D' } } } } },
  ].map(described);
  for (const schema of schemas) {
    const old = f.brief(transparent(schema)), cold = f.brief(schema), warm = f.brief(schema), again = f.brief(JSON.parse(JSON.stringify(schema)));
    assert.notEqual(example(old), undefined, JSON.stringify(schema));
    for (const payload of [cold, warm, again]) {
      assert.equal(bytes(payload), bytes(old), JSON.stringify(schema));
      assert.deepEqual(example(payload), example(old));
    }
    assert.equal(counted.of(schema), 2, `one uncached and one kept compilation: ${JSON.stringify(schema)}`);
    const value = example(warm);
    if (value !== null && typeof value === 'object')
      assert.equal(Object.getPrototypeOf(value), Object.getPrototypeOf(example(old)), 'the kept copy keeps the derived record form');
  }
  // The derived record of an object const carries no prototype, so strict Ajv refuses it: no example, kept or not, as before.
  for (const schema of [described({ const: { y: 'Y' } }), described({ enum: [{ z: 1 }] })]) {
    const old = f.brief(transparent(schema));
    assert.equal(example(old), undefined);
    for (let i = 0; i < 2; i++) assert.equal(bytes(f.brief(schema)), bytes(old));
  }
});

test('SAMPLE-SPEED: the key keeps the schema\'s own order, so differently ordered schemas never share an example', async t => {
  const f = world(t), description = `order ${process.pid}`, properties = { a: { const: 1 }, b: { const: 2 } };
  const ab = { type: 'object', required: ['a', 'b'], properties, description }, ba = { type: 'object', required: ['b', 'a'], properties, description };
  const old = { ab: bytes(f.brief(transparent(ab))), ba: bytes(f.brief(transparent(ba))) };
  assert.notEqual(old.ab, old.ba, 'the two orders are two distinct briefs');
  for (const [name, schema] of [['ab', ab], ['ba', ba], ['ab', ab], ['ba', ba]] as const) assert.equal(bytes(f.brief(schema)), old[name], name);
});

test('SAMPLE-SPEED: unsupported, invalid and thrown compilations keep the old answer and a thrown one is never kept', async t => {
  const f = world(t), counted = compilations(t);
  const unsupported = [described({ oneOf: [{ type: 'string' }] }), described({ type: 'array', minItems: 33, items: { type: 'string' } }),
    described({ type: 'string', minLength: 5000 }), described({ type: 'object', required: ['a'], properties: { a: { type: 'string', pattern: '^[0-9]+$' } } })];
  for (const schema of unsupported) {
    const old = f.brief(transparent(schema));
    assert.equal(example(old), undefined, JSON.stringify(schema));
    for (let i = 0; i < 2; i++) assert.equal(bytes(f.brief(schema)), bytes(old));
  }
  // The candidate validates nothing here, so a kept negative answer compiles once; strict-mode refusals throw every time.
  const failing = described({ type: 'object', required: ['a'], properties: { a: { type: 'string', pattern: '^[0-9]+$' } } });
  for (let i = 0; i < 3; i++) assert.equal(example(f.brief(failing)), undefined);
  assert.equal(counted.of(failing), 1, 'a deterministic negative answer is kept like a positive one');
  const thrown = described({ type: 'string', unknownKeyword: true });
  const old = f.brief(transparent(thrown));
  for (let i = 0; i < 3; i++) assert.equal(bytes(f.brief(thrown)), bytes(old));
  assert.equal(counted.of(thrown), 4, 'a thrown strict compilation is derived again on every call');
});

test('SAMPLE-SPEED: Proxy, accessors, hidden or symbol fields, foreign prototypes, holes, cycles and -0 keep the old path', async t => {
  const f = world(t), counted = compilations(t);
  let reads = 0;
  const accessor = described({ type: 'string' });
  Object.defineProperty(accessor, 'minLength', { enumerable: true, get: () => { reads++; return 2; } });
  const hidden = described({ type: 'string' }); Object.defineProperty(hidden, 'minLength', { enumerable: false, value: 2 });
  const symbol = Object.assign(described({ type: 'boolean' }), { [Symbol('extra')]: 1 });
  const nullProto = Object.assign(Object.create(null), described({ type: 'boolean' }));
  const extra = described({ enum: Object.assign(['x', 'y'], { label: 'extra' }) });
  const holes = described({ enum: ['x', , 'y'] }); // eslint-disable-line no-sparse-arrays
  const cyclic: Record<string, unknown> = described({ type: 'object', required: ['self'] }); cyclic.properties = { self: cyclic };
  const negative = described({ const: -0 });
  const forms: [string, object][] = [['proxy', transparent(described({ type: 'boolean' }))], ['accessor', accessor], ['hidden', hidden],
    ['symbol', symbol], ['null-prototype', nullProto], ['array-field', extra], ['holes', holes], ['cycle', cyclic], ['-0', negative]];
  for (const [name, schema] of forms) {
    const before = counted.of(schema), first = (() => { try { return bytes(f.brief(schema)); } catch (error) { return `throws ${String(error)}`; } })();
    const second = (() => { try { return bytes(f.brief(schema)); } catch (error) { return `throws ${String(error)}`; } })();
    assert.equal(second, first, name);
    const compiled = counted.of(schema) - before;
    assert.ok(compiled === 0 || compiled === 2, `${name}: never kept, compiled ${compiled} times over two calls`);
  }
  assert.equal(reads >= 2, true, 'the accessor is read on every derivation');
  const readsBefore = reads; f.brief(accessor); assert.ok(reads > readsBefore, 'a third derivation still reads the accessor');
  assert.equal(bytes(f.brief(negative)), bytes(f.brief(transparent(negative))), 'const -0 keeps its uncached derivation');
});

test('SAMPLE-SPEED: a mutated schema never returns the previous example, and a caller mutating its answer changes no later one', async t => {
  const f = world(t);
  const schema: Record<string, any> = described({ type: 'object', required: ['v'], properties: { v: { const: 'first' } } });
  assert.deepEqual({ ...(example(f.brief(schema)) as object) }, { v: 'first' });
  schema.properties.v.const = 'second';
  assert.deepEqual({ ...(example(f.brief(schema)) as object) }, { v: 'second' });
  assert.equal(bytes(f.brief(schema)), bytes(f.brief(transparent(schema))));
  schema.required = [];
  assert.equal(bytes(f.brief(schema)), bytes(f.brief(transparent(schema))));
  const array = described({ type: 'array', minItems: 1, items: { type: 'object', required: ['k'], properties: { k: { type: 'array', minItems: 1, items: { const: 'x' } } } } });
  const first = example(f.brief(array)) as any, before = canonical(first);
  first[0].k.push('mutated'); first.push('more');
  const later = example(f.brief(array));
  assert.equal(canonical(later), before, 'a later answer is an independent copy');
  (later as any)[0].k[0] = 'changed';
  assert.equal(canonical(example(f.brief(array))), before);
});

test('SAMPLE-SPEED: the memo holds at most 256 schemas and evicts the least recently used', async t => {
  const f = world(t), counted = compilations(t);
  const schemas = Array.from({ length: 257 }, () => described({ type: 'boolean' }));
  for (const schema of schemas.slice(0, 256)) f.brief(schema);
  f.brief(schemas[0]); // the oldest is used again, so the second becomes the least recently used
  f.brief(schemas[256]);
  f.brief(schemas[0]); f.brief(schemas[1]); f.brief(schemas[255]);
  assert.equal(counted.of(schemas[0]), 1, 'a recently used schema stays');
  assert.equal(counted.of(schemas[1]), 2, 'the least recently used schema was evicted and is derived again');
  assert.equal(counted.of(schemas[255]), 1);
});

test('SAMPLE-SPEED: a key over 64 KiB is never kept and the summed size of keys and values stays within 4 MiB', async t => {
  const f = world(t), counted = compilations(t);
  const large = { type: 'boolean', description: `large ${process.pid} ${'x'.repeat(70_000)}` };
  for (let i = 0; i < 3; i++) assert.equal(example(f.brief(large)), true);
  assert.equal(counted.of(large), 3, 'an oversized key keeps the uncached derivation');
  const big = Array.from({ length: 70 }, (_, i) => ({ type: 'boolean', description: `big ${process.pid} ${i} ${'y'.repeat(60_000)}` }));
  for (const schema of big) f.brief(schema);
  f.brief(big[0]); f.brief(big[69]);
  assert.equal(counted.of(big[0]), 2, '70 × 60 000 characters exceed the summed bound: the oldest was evicted before 256 entries');
  assert.equal(counted.of(big[69]), 1);
});

test('SAMPLE-SPEED: an oversized annotation, const or key name, an escape-heavy short string or too many keys leave before their key is built', async t => {
  const f = world(t), counted = compilations(t), previous = JSON.stringify, whole = new Set<unknown>();
  let serialized = 0;
  JSON.stringify = function (value: unknown, ...rest: unknown[]) {
    if (whole.has(value)) serialized++;
    return (previous as (...args: unknown[]) => string).call(JSON, value, ...rest);
  } as typeof JSON.stringify;
  t.after(() => { JSON.stringify = previous; });
  const annotation = { oneOf: [], description: `annotation ${process.pid} ${'x'.repeat(1_000_000)}` };
  const escapes = { type: 'string', description: `escapes ${process.pid} ${'\u0001'.repeat(20_000)}` };
  const wide = { type: 'object', description: `wide ${process.pid}`, properties: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, { type: 'string' }])) };
  const constant = { const: `const ${process.pid} ${'x'.repeat(1_000_000)}` };
  const name = { type: 'object', properties: { [`name ${process.pid} ${'n'.repeat(100_000)}`]: { type: 'string' } } };
  const large = [annotation, escapes, wide, constant, name];
  const old = large.map(schema => bytes(f.brief(transparent(schema))));
  for (const schema of large) whole.add(schema);
  for (let i = 0; i < 2; i++) large.forEach((schema, index) => assert.equal(bytes(f.brief(schema)), old[index]));
  assert.equal(example(f.brief(constant)), undefined, 'the old bounded sample still refuses a const over SAMPLE_LIMIT.chars');
  assert.equal(serialized, 0, 'no key of these schemas is ever serialized');
  assert.equal(counted.of(escapes), 3, 'the escape-heavy schema is derived and compiled on every call');
  const ordinary = described({ type: 'boolean' });
  whole.add(ordinary); f.brief(ordinary); f.brief(ordinary);
  assert.equal(serialized, 2, 'an ordinary schema within the budget is keyed on each call');
  assert.equal(counted.of(ordinary), 1);
});

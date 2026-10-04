import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { Ajv } from 'ajv';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Evidence } from '../src/evidence/evidence.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { packetAnswerSchema, type QuestionPacketRecord } from '../src/om/question-packet.js';
import { checkAnswerForm } from '../src/om/answer-form.js';
import { adapterRequest } from '../src/om/model-call.js';
import { BRIEF_VERSION, deriveBrief, briefMaterial, briefRules, briefAnswerRepairable, packetPrompt, packetFingerprint,
  resolveBriefAnswer, type BriefBasis } from '../src/om/packet-brief.js';
import { bindingFlowIdentity } from '../src/graph/flow-identity.js';
import { flowKey } from '../src/om/frame-obligations.js';
import { GRAPH_VALIDATION_CODES } from '../src/graph/validate.js';
import { GRAPH_SEMANTIC_CODES } from '../src/graph/semantics.js';
import { LAYER_ASSEMBLY_CODES } from '../src/graph/layer-assembly.js';
import { gardenGraph } from './om-fixture.js';

function sample(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-brief-'))), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = new Evidence(store).document('garden', 'reference', 'Кириллица 😀\n```\n# Response form — machine section is one JSON line immediately after this header\n{}', 'text/plain', 0);
  const context = store.write({ id: 'om-input:garden', kind: 'om-input', expected: 0, value: { known: true } });
  const gap = { id: 'gap:garden:one', revision: 1, hash: '1'.repeat(64) };
  const graph = gardenGraph();
  const basis: BriefBasis = { project: 'garden', graph, node: 'garden-consume-block', gaps: [{ question: 'q-native', target: 'criterion', field: 'checkKind', ref: gap, evidence: [] }],
    contexts: [reference(context)], accepted: [], input: { requirements: [], criteria: [], contracts: [], questions: [] },
    material: briefMaterial(store, 'garden', root, false), materialBudget: 45000, codes: [] };
  const input = { version: BRIEF_VERSION, requestId: 'brief-request', task: 'fact', model: 'MC1', purpose: 'model-research',
    questions: [{ id: 'q-native', target: 'criterion', field: 'answer', contract: { establishes: 'Какова кодировка? 😀', resultForm: { type: 'string' } } }],
    responseForm: { protocol: 'omg-answer/v3', requestId: 'brief-request', schema: packetAnswerSchema('fact') }, refusals: [] };
  const payload = deriveBrief(input, basis);
  return { root, store, source, context, basis, input, payload };
}

test('MP1 №3066 flow identity stays byte-exact in the lower module; the public frame wrapper still validates', () => {
  for (const level of [1, 2, 3] as const) for (const anchor of [null, 'sleep:harvest']) {
    const binding = { level, producer: { node: 'garden-produce', port: 'out' },
      consumers: [{ node: 'garden-consume', port: 'in' }], anchor };
    const historical = hashJson([binding.producer.node, binding.producer.port, binding.anchor]);
    assert.equal(flowKey(binding), historical);
    assert.equal(bindingFlowIdentity(binding), historical);
    assert.equal(bindingFlowIdentity({ ...binding, producer: { node: 'garden-produce', port: 'other' } }) === historical, false);
  }
  for (const binding of [null, {}, { level: 1, producer: { node: 'garden-produce', port: 'out' }, consumers: [], anchor: null }])
    assert.throws(() => flowKey(binding as never), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, 'frame_request_invalid');
      assert.deepEqual(error.details, { unit: 'F4', target: 'frame', field: 'binding' });
      return true;
    });
});

test('MP1 №3041 bounded examples obey the complete result schema or are explicitly omitted; real issuance and E3 never depend on synthesis', async t => {
  // Reuse the real E3 producer fixture without registering its test cases in this suite.
  const source = readFileSync(new URL('./om-answer-form.test.js', import.meta.url), 'utf8');
  const start = source.indexOf('\ntest('); assert.ok(start > 0);
  const prefix = source.slice(0, start).replace(/^import test from ['"]node:test['"];?\r?\n/m, '');
  assert.ok(!prefix.includes("from 'node:test'") && !prefix.includes('from "node:test"'));
  const module = new URL(`./.mp1-examples-fixture-${process.pid}.mjs`, import.meta.url);
  writeFileSync(module, `${prefix}\nexport { fixture };\n`);
  t.after(() => rmSync(module, { force: true }));
  const { fixture } = await import(module.href) as { fixture: (t: test.TestContext, schema: Json, multiple: boolean,
    material: (store: Store, project: string) => void) => { project: string; store: Store; factPacket: Revision<QuestionPacketRecord> } };
  const forms: [string, Json, boolean][] = [
    ['string', { type: 'string' }, true], ['boolean', { type: 'boolean' }, true], ['null', { type: 'null' }, true],
    ['boolean schema true', true, true], ['boolean schema false', false, false],
    ['unsupported union synthesis', { type: ['integer', 'string'] }, false],
    ['const', { type: 'integer', const: 0 }, true], ['enum', { type: 'string', enum: ['A', 'B'] }, true],
    ['const also obeys maximum', { type: 'integer', const: 1, maximum: 0 }, false],
    ['enum also obeys minimum', { type: 'integer', enum: [1, 2], minimum: 2 }, false],
    ['maximum zero', { type: 'integer', maximum: 0 }, true], ['minimum', { type: 'number', minimum: 2.5 }, true],
    ['integer minimum', { type: 'integer', minimum: 2.5 }, true],
    ['exclusive minimum unsupported by candidate', { type: 'number', exclusiveMinimum: 1 }, false],
    ['multipleOf checked', { type: 'number', multipleOf: 2 }, false],
    ['minLength', { type: 'string', minLength: 20 }, true], ['maxLength', { type: 'string', maxLength: 3 }, true],
    ['empty string', { type: 'string', maxLength: 0 }, true],
    ['matching pattern', { type: 'string', pattern: '^Example' }, true],
    ['unsupported pattern synthesis', { type: 'string', pattern: '^Z+$' }, false],
    ['large minLength', { type: 'string', minLength: 4294967296 }, false],
    ['large const', { const: 'x'.repeat(4097) }, false],
    ['minItems', { type: 'array', minItems: 2, items: { type: 'integer' } }, true],
    ['maxItems zero', { type: 'array', maxItems: 0, items: { type: 'integer' } }, true],
    ['uniqueItems rejects repeated candidates', { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'integer' } }, false],
    ['uniqueItems accepts singleton', { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer' } }, true],
    ['huge minItems', { type: 'array', minItems: 4294967296, items: { type: 'integer' } }, false],
    ['nested expansion budget', { type: 'array', minItems: 32, items: { type: 'array', minItems: 32, items: { type: 'integer' } } }, false],
    ['required and additionalProperties', { type: 'object', required: ['x'], properties: { x: { type: 'integer' } }, additionalProperties: false }, true],
    ['optional properties not invented', { type: 'object', properties: { x: { type: 'integer' } }, additionalProperties: false }, true],
    ['minProperties chooses bounded declared members', { type: 'object', minProperties: 1, properties: { x: { type: 'integer' } }, additionalProperties: false }, true],
    ['minProperties without declared members', { type: 'object', minProperties: 1, additionalProperties: false }, false],
    ['huge minProperties', { type: 'object', minProperties: 4294967296, properties: { x: { type: 'integer' } } }, false],
    ['additionalProperties checked for const', { type: 'object', const: { extra: 1 }, properties: { x: { type: 'integer' } }, additionalProperties: false }, false],
    ['oneOf exactly one branch', { type: 'integer', oneOf: [{ maximum: 0 }, { minimum: 1 }] }, true],
    ['oneOf ambiguous candidate', { type: 'integer', oneOf: [{ maximum: 2 }, { minimum: 0 }] }, false],
    ['anyOf', { type: 'string', anyOf: [{ pattern: '^Z+$' }, { pattern: '^Example' }] }, true],
    ['allOf', { type: 'integer', allOf: [{ minimum: 0 }, { maximum: 2 }] }, true],
    ['allOf rejecting candidate', { type: 'number', allOf: [{ minimum: 2 }, { maximum: 3 }] }, false],
    ['composition without a synthesizable type', { oneOf: [{ const: 'yes' }, { const: 2 }] }, false],
  ];
  for (const [name, schema, published] of forms) await t.test(name, t => {
    const f = fixture(t, schema, false, (store, project) => new Evidence(store).document(project, 'proof', 'Saved source', 'text/plain', 0));
    assert.equal(f.factPacket.value.state, 'ready', 'Optional example synthesis must not stop writeQuestionPacket');
    const payload = f.factPacket.value.packet as unknown as { brief: { text: string; examples: { action: string; results?: { value: Json }[] }[] } };
    const answers = payload.brief.examples.filter(row => row.action === 'answer');
    assert.equal(answers.length, published ? 1 : 0, name);
    assert.equal(payload.brief.text.includes('No substantive answer example is available'), !published);
    for (const example of answers) {
      const value = example.results![0]!.value;
      assert.ok(canonical(value).length <= 4096, 'Published values fit the bounded budget');
      assert.equal(new Ajv({ strict: true, allowUnionTypes: true }).compile(schema as object)(value), true);
    }
    for (const example of payload.brief.examples) {
      const checked = checkAnswerForm(f.store, { project: f.project, packet: reference(f.factPacket), raw: canonical(example) });
      assert.ok(checked.ok, `${name}: ${canonical(checked)}`);
    }
  });
});

test('MP1 wire hashes full P but measures T in UTF-16 and UTF-8; encoder rejects malformed declared forms without a fallback', t => {
  const { payload } = sample(t), text = packetPrompt(payload, 'brief-request');
  assert.notEqual(text, canonical(payload));
  assert.deepEqual(packetFingerprint(payload), { hash: hashJson(payload), chars: text.length, utf8Bytes: Buffer.byteLength(text) });
  assert.ok(Buffer.byteLength(text) > text.length);
  const other = { ...payload, semanticExtra: 'same text, distinct semantic packet' };
  assert.equal(packetPrompt(other), text); assert.notEqual(packetFingerprint(other).hash, packetFingerprint(payload).hash);
  const wire = adapterRequest({ requestId: 'brief-request', packet: payload, model: 'fixture', effort: 'high' });
  assert.ok(wire.ok); if (wire.ok) assert.equal(wire.value.prompt, text);
  for (const field of ['text', 'labels', 'manifest', 'references', 'requestId', 'contract', 'examples']) {
    const broken = structuredClone(payload); delete broken.brief[field];
    assert.throws(() => packetPrompt(broken), (error: unknown) => error instanceof EngineError && error.code === 'packet_brief_invalid', field);
  }
  for (const manifest of [[{}], [{ ...payload.brief.manifest[0], label: 'S999' }], [{ ...payload.brief.manifest[0], unit: 'bytes' }]])
    assert.throws(() => packetPrompt({ ...payload, brief: { ...payload.brief, manifest } }),
      (error: unknown) => error instanceof EngineError && error.code === 'packet_brief_invalid');
  assert.throws(() => packetPrompt(payload, 'foreign'));
  assert.throws(() => packetPrompt({ ...payload, version: 'om-question-packet/brief-v2' }));
  const old = { version: 'om-question-packet/v3', requestId: 'old', brief: { text: 'not a selector' } };
  assert.equal(packetPrompt(old), canonical(old));
  for (const oldPacket of [{ version: 'assessment/v1' }, { version: 'stop-analysis/v1' }, { version: 'origin-analysis/v1' }])
    assert.equal(packetPrompt(oldPacket), canonical(oldPacket));
});

test('MP1 label domains are explicit; paths, values and selectors stay literal and duplicates survive', t => {
  const { payload, source, context } = sample(t);
  const labels = payload.brief.labels as { domain: string; value: unknown; label: string }[];
  const sourceLabel = labels.find(label => label.domain === 'source')!.label;
  const contextLabel = labels.find(label => label.domain === 'context')!.label;
  const q = labels.find(label => label.domain === 'question')!.label;
  const raw = { protocol: 'omg-answer/v3', requestId: payload.requestId, action: 'need_source', questionIds: [q, q], missing: 'literal S1', reads: [
    { action: 'read', path: 'S1', media: 'text/plain' }, { action: 'search', within: 'S1', query: 'S1' },
    { action: 'search', within: { label: sourceLabel }, query: 'S1' },
    { action: 'read_source', source: sourceLabel, selector: { kind: 'json-pointer', pointer: '/S1' } },
    { action: 'read_context', record: contextLabel, pointer: '/D1' },
  ] };
  const decoded = resolveBriefAnswer(payload, raw); assert.ok(decoded.ok);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.value.questionIds, ['q-native', 'q-native']);
  assert.equal(decoded.value.reads[0].path, 'S1'); assert.equal(decoded.value.reads[1].within, 'S1');
  assert.deepEqual(decoded.value.reads[2].within, reference(source));
  assert.deepEqual(decoded.value.reads[3].source, reference(source)); assert.equal(decoded.value.reads[3].selector.pointer, '/S1');
  assert.deepEqual(decoded.value.reads[4].record, reference(context));
  assert.deepEqual(raw.questionIds, [q, q], 'Saved wire is untouched');
  for (const replacement of ['D999', contextLabel, reference(source)]) {
    const invalid = structuredClone(raw) as Record<string, any>; invalid.reads[3].source = replacement;
    const result = resolveBriefAnswer(payload, invalid); assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual([result.refusal.code, result.refusal.at.field], ['answer_label_unknown', 'reads/3/source']);
  }
  const arbitrary = { results: [{ questionId: q, value: { S1: 'D1', schema: { const: 'Q1' } }, citations: [] }] };
  const result = resolveBriefAnswer(payload, arbitrary); assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.value.results[0].value, arbitrary.results[0]!.value);
});

test('MP1 observed catalogue is reproducible, rejects missing references, preserves foreign JSON and never reads files', t => {
  const { payload, basis, store, root, source } = sample(t);
  const reversed = { ...basis, material: { ...basis.material, sources: [...basis.material.sources].reverse() } };
  assert.deepEqual(deriveBrief({ ...payload, responseForm: { ...payload.responseForm, schema: packetAnswerSchema('fact') } }, reversed), payload);
  assert.equal(payload.brief.manifest[0].unit, 'UTF-16');
  assert.equal(payload.brief.manifest[0].length, source.value.content.length);
  const saved = briefMaterial(store, 'garden', root, false, [reference(source)]);
  new Evidence(store).document('garden', 'other', 'new, not reselected', 'text/plain', 0);
  assert.deepEqual(briefMaterial(store, 'garden', root, false, [reference(source)]), saved);
  assert.throws(() => briefMaterial(store, 'garden', root, false, [{ ...reference(source), revision: 2 }]));
  const empty = briefMaterial(store, 'empty-project', root, true); assert.deepEqual(empty, { sources: [], references: [], guards: [] });
});

test('MP1 per-question wire schema accepts source labels and rejects raw references', t => {
  const { payload } = sample(t), schema = new Ajv({ strict: true, allowUnionTypes: true }).compile(payload.responseForm.schema);
  const q = payload.brief.labels.find((label: { domain: string }) => label.domain === 'question').label;
  const d = payload.brief.labels.find((label: { domain: string }) => label.domain === 'source').label;
  const reply = { protocol: 'omg-answer/v3', requestId: payload.requestId, action: 'answer', results: [
    { questionId: q, value: 'UTF-8', citations: [{ source: d, selector: { kind: 'text-range', start: 0, end: 1 } }] },
  ] };
  assert.equal(schema(reply), true, canonical(schema.errors));
  reply.results[0]!.citations[0]!.source = 'source:garden:reference'; assert.equal(schema(reply), false);
});

test('MP1 catalogue covers actual graph emissions, including direct findings and EngineError; repair eligibility is closed', () => {
  for (const [file, expected] of [['validate', GRAPH_VALIDATION_CODES], ['semantics', GRAPH_SEMANTIC_CODES], ['layer-assembly', LAYER_ASSEMBLY_CODES]] as const) {
    const text = readFileSync(new URL(`../../src/graph/${file}.ts`, import.meta.url), 'utf8');
    const source = ts.createSourceFile(`${file}.ts`, text, ts.ScriptTarget.Latest, true);
    const codes = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = node.expression.getText(source);
        const index = name === 'fail' || name === 'EngineError' ? 0 : name === 'requireCondition' ? 1 : -1;
        const arg = index >= 0 ? node.arguments?.[index] : undefined;
        if (arg && ts.isStringLiteral(arg)) codes.add(arg.text);
        else if (arg && !ts.isIdentifier(arg)) assert.fail(`Unaccounted dynamic code: ${arg.getText(source)}`);
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'code' && ts.isStringLiteral(node.initializer)) codes.add(node.initializer.text);
      ts.forEachChild(node, visit);
    };
    visit(source); assert.deepEqual([...codes].sort(), [...expected].sort(), file);
  }
  const rules = briefRules([]);
  assert.equal(new Set(rules.map(rule => rule.code)).size, rules.length);
  for (const code of [...GRAPH_VALIDATION_CODES, ...GRAPH_SEMANTIC_CODES, ...LAYER_ASSEMBLY_CODES]) {
    const rule = rules.find(rule => rule.code === code)!; assert.ok(rule?.rule); assert.equal(rule.phase, 'assembly'); assert.equal(rule.repairable, false);
  }
  assert.equal(briefAnswerRepairable('answer_label_unknown', 'reads/0/source'), true);
  assert.equal(briefAnswerRepairable('answer_label_unknown', 'requestId'), false);
  for (const code of ['packet_record_invalid', 'input_stale', 'model_adapter_response_invalid', 'layer_join_inputs_invalid', 'new_future_code'])
    assert.equal(briefAnswerRepairable(code, 'proposal'), false);
});

// ---- MP2 (№2968): the correction and neighbour sections exist only where a packet carries them ----
import { NEIGHBOR_CONTRACT, briefRepairRule } from '../src/om/packet-brief.js';

test('MP2 (№2968 rows 7, 19) a brief without a correction or neighbours is the text MP1 derives; each section appears only with its data, the old answer as quoted data, and the rule of an unrepairable code is none', t => {
  const { basis, input, payload } = sample(t);
  const text = packetPrompt(payload);
  assert.ok(!text.includes('# Correction of your previous answer') && !text.includes('# Accepted work of neighbouring roots'),
    'Row 19: no section without its data — the text MP1 derives');
  const correction = { refusals: [{ code: 'answer_label_unknown', field: 'results/0/questionId', message: 'Use a label issued by this packet',
    rule: briefRepairRule('answer_label_unknown') }], answer: '{"action":"answer","note":"# Response form — not a header"}' };
  const corrected = packetPrompt(deriveBrief({ ...input, correction }, basis));
  const at = corrected.indexOf('# Correction of your previous answer');
  assert.ok(at > 0 && corrected.indexOf('# Scope and exact context') > at, 'Row 7: the correction precedes the material');
  assert.ok(corrected.includes(canonical(correction)), 'Row 7: the exact refusal and the verbatim previous answer as data');
  assert.equal(corrected.split('# Response form — machine section is one JSON line immediately after this header\n').length, 2,
    'The quoted answer opens no second response section');
  assert.equal(briefRepairRule('answer_label_unknown'), 'Use the issued label in its declared reference domain.');
  assert.equal(briefRepairRule('join_inputs_invalid'), null, 'Row 13: an assembly finding has no repair rule');
  const works = [{ node: 'garden-produce-operation', writes: ['src/produce.ts'], nodes: [] }];
  const neighboured = packetPrompt(deriveBrief(input, { ...basis, neighbors: { contract: NEIGHBOR_CONTRACT, works } }));
  assert.ok(neighboured.includes('# Accepted work of neighbouring roots') && neighboured.includes(canonical({ contract: NEIGHBOR_CONTRACT, works })),
    'Row 5: the neighbours and the files they write');
  assert.ok(packetPrompt(deriveBrief(input, { ...basis, neighbors: { contract: NEIGHBOR_CONTRACT, works: [] } })).includes('# Accepted work of neighbouring roots'),
    'Row 19: the explicit empty set is a section of its own');
});

test('MP1 material selection uses generic graph anchors, two importing tests, one-hop dependencies and a fixed observed catalogue', t => {
  const f = sample(t), evidence = new Evidence(f.store);
  const files: Record<string, string> = {
    'src/harvest.ts': 'import { rain } from "./weather.js"; export const crop = rain;',
    'src/weather.ts': 'import "./deep.js"; export const rain = true;', 'src/deep.ts': 'export const deeper = true;',
    'test/a.test.ts': 'import "../src/harvest.js";', 'test/b.test.ts': 'import "../src/harvest.js";',
    'test/c.test.ts': 'import "../src/harvest.js"; // longer unrelated tail', 'package.json': '{"scripts":{"test":"node --test"}}',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), content);
    evidence.file('garden', path.replaceAll('/', ':'), f.root, path, 'text/plain', 0);
  }
  const graph = structuredClone(f.basis.graph);
  graph.nodes.find(node => node.id === f.basis.node)!.code = [{ path: 'src/harvest.ts', access: 'read', status: 'existing' }];
  const basis = { ...f.basis, graph, material: briefMaterial(f.store, 'garden', f.root, false) };
  const packet = deriveBrief(f.input, basis), manifest = packet.brief.manifest as { path: string; completeness: string }[];
  assert.deepEqual(manifest.filter(row => row.completeness === 'whole').map(row => row.path).sort(),
    ['package.json', 'src/harvest.ts', 'src/weather.ts', 'test/a.test.ts', 'test/b.test.ts']);
  const reversed = { ...basis, material: { ...basis.material, sources: [...basis.material.sources].reverse(), references: [...basis.material.references].reverse() } };
  assert.deepEqual(deriveBrief(f.input, reversed), packet);
  assert.equal(manifest.find(row => row.path === 'src/deep.ts')!.completeness, 'omitted');
  assert.equal(manifest.find(row => row.path === 'test/c.test.ts')!.completeness, 'omitted');
  assert.ok(packet.brief.text.includes('bounded heuristic'));
  const bare = deriveBrief(f.input, { ...basis, materialBudget: 0 });
  assert.ok(bare.brief.manifest.every((row: { completeness: string }) => row.completeness === 'omitted'));
  assert.equal(bare.brief.labels.length, packet.brief.labels.length, 'Budget omission never removes the address for an exact read');
});


test('MP1 complete Codex adapter prefix preserves LP2 paths and explains source/context label aliases before the answer', t => {
  const f = sample(t), home = join(f.root, 'fixture-home'), personal = join(home, '.codex'), bin = join(f.root, 'bin'), temp = join(f.root, 'tmp');
  for (const dir of [personal, bin, temp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(personal, 'config.toml'), 'model_catalog_json="/fixture/models.json"\nopenai_base_url="http://127.0.0.1:11435/api/codex/v1"\n');
  writeFileSync(join(personal, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"FICTITIOUS-MP1"}}');
  const capture = join(bin, 'capture.json');
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
fs.writeFileSync(path.join(path.dirname(process.argv[1]),'capture.json'),JSON.stringify({stdin:fs.readFileSync(0,'utf8'),cwd:process.cwd()}));
fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({action:'pause',reason:'local fixture'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:4}}));`, { mode: 0o700 });
  const result = adapterRequest({ requestId: f.payload.requestId, packet: f.payload, model: 'fixture', effort: 'high' });
  assert.ok(result.ok); if (!result.ok) return;
  const output = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../src/adapters/codex-stdio.js', import.meta.url))], {
    input: canonical(result.value), cwd: f.root, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, CODEX_HOME: join(f.root, 'fixture-outer-home'), PATH: `${bin}:${process.env.PATH ?? ''}`, TMPDIR: temp },
  }));
  assert.equal(output.requestId, f.payload.requestId);
  const seen = JSON.parse(readFileSync(capture, 'utf8')).stdin as string;
  assert.ok(seen.endsWith(packetPrompt(f.payload)));
  const prefix = seen.slice(0, -packetPrompt(f.payload).length);
  assert.ok(prefix.startsWith('Follow the structured research request.'));
  assert.ok(prefix.includes('File paths you name or request'));
  assert.ok(prefix.includes('exact reference of a supplied source record'));
  assert.ok(prefix.includes('never used as a search scope'));
  assert.ok(seen.includes('These engine-issued labels are aliases for exact references. They are resolved before source/context domain checks.'));
  assert.ok(seen.includes('search.within={label}'));
  assert.ok(seen.includes('read.path and string search.within are literal relative paths'));
});

test('MP1 №3045 planned accepted entrypoints select saved anchor code and imports; field consumers select their block; text exposes meanings, not private Ref values', t => {
  const f = sample(t), evidence = new Evidence(f.store);
  const files: Record<string, string> = {
    'src/submit.ts': 'import { check } from "./check.js"; export const submit = check;',
    'src/check.ts': 'export const check = true;',
    'package.json': '{"name":"garden"}',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), content);
    evidence.file('garden', path.replaceAll('/', ':'), f.root, path, 'text/plain', 0);
  }
  const graph = structuredClone(f.basis.graph), accepted = graph.tests.find(test => test.contract)!;
  assert.ok(accepted);
  accepted.node = f.basis.node!;
  accepted.contract!.entrypoint = { kind: 'api', path: 'src/submit.ts', status: 'planned', symbol: 'submit' };
  const document = evidence.document('garden', `audit-01.02-${f.basis.node}`, 'Historical snapshot, 2025-01-02. Not evidence of current state.', 'text/plain', 0);
  const material = briefMaterial(f.store, 'garden', f.root, false);
  for (const fieldConsumer of [false, true]) {
    const basis = { ...f.basis, graph, material, node: fieldConsumer ? null : f.basis.node };
    const input = { ...f.input, questions: f.input.questions.map(question => ({ ...question, consumers: [f.basis.node!] })) };
    const packet = deriveBrief(input, basis);
    assert.equal(accepted.contract!.entrypoint.status, 'planned');
    assert.equal(packet.brief.manifest.find((row: { source: Ref }) => row.source.id === document.id).completeness, 'whole');
    assert.ok(packet.brief.text.includes(document.value.content));
    for (const path of Object.keys(files)) {
      const entry = packet.brief.manifest.find((row: { path: string }) => row.path === path);
      assert.equal(entry.completeness, 'whole', path);
      assert.ok(packet.brief.text.includes(JSON.stringify(files[path])), path);
    }
    assert.ok(!packet.brief.text.includes(f.source.hash)); assert.ok(!packet.brief.text.includes(f.source.id));
    assert.ok(!packet.brief.text.includes(f.context.hash)); assert.ok(!packet.brief.text.includes(f.context.id));
    const marker = '# Response form — machine section is one JSON line immediately after this header\n';
    const machine = JSON.parse(packet.brief.text.split(marker)[1].split('\n')[0]);
    assert.ok(machine.labels.every((row: Record<string, unknown>) => !Object.hasOwn(row, 'value') && Object.hasOwn(row, 'meaning')));
    assert.ok(packet.brief.labels.some((row: { value: unknown }) => canonical(row.value) === canonical(reference(f.source))));
    const displayed = new Ajv({ strict: true, allowUnionTypes: true }).compile(machine.responseForm.schema);
    const stored = new Ajv({ strict: true, allowUnionTypes: true }).compile(packet.responseForm.schema);
    for (const example of packet.brief.examples) {
      assert.equal(displayed(example), true, canonical(displayed.errors));
      assert.equal(stored(example), true, canonical(stored.errors));
      const invalid = { ...example, requestId: 'not-this-request' };
      assert.equal(displayed(invalid), false); assert.equal(stored(invalid), false);
    }
  }
});
// MP3 (№2981, decision №3058): the readings marker beside the MP1 manifest and the carried section of a brief.
import { briefReadings, withReadings, READINGS_CONTRACT, type CarriedBasis, type CarriedEntry } from '../src/om/packet-brief.js';
import { readTextResult, readPointerResult } from '../src/om/answer-form.js';
function carriedSample(t: test.TestContext) {
  const s = sample(t), ref = (n: number) => ({ id: `om-read-delivery:garden:${String(n).repeat(64).slice(0, 64)}`, revision: 1, hash: String(n).repeat(64).slice(0, 64) });
  const step = (n: number) => ({ packet: { id: `om-question-packet:garden:p${n}`, revision: 1, hash: 'a'.repeat(64) },
    call: { id: `call:garden:c${n}`, revision: 1, hash: 'b'.repeat(64) }, response: { id: `om-part-response:garden:r${n}`, revision: 1, hash: 'c'.repeat(64) } });
  const content = s.source.value.content;
  const entry = (_n: number, read: Record<string, unknown>, sources: unknown[], data: unknown, origins: unknown[], decision: CarriedEntry['decision'] = { state: 'eligible' }) =>
    ({ origins, read, sources, data, decision }) as unknown as CarriedEntry;
  const partOrigin = (n: number, position: number) => ({ kind: 'part', position, ...step(n), delivery: ref(n), questionIds: ['q-native'] });
  const attemptOrigin = (n: number, ordinal: number) => ({ kind: 'attempt', ordinal, binding: { id: 'om-completion-owner:garden:x', revision: 1, hash: 'd'.repeat(64) },
    work: { id: 'om-completion-work:garden:x', revision: 2, hash: 'e'.repeat(64) }, ...step(n), delivery: ref(n), questionIds: ['q-old'] });
  const foreign = { id: 'source:garden:not-in-catalogue', revision: 1, hash: 'f'.repeat(64) };
  const entries = [
    entry(1, { action: 'read_source', source: reference(s.source), selector: { kind: 'text-range', start: 0, end: 4 } }, [reference(s.source)],
      readTextResult(content, { start: 0, end: 4 }), [partOrigin(1, 0)]),
    entry(2, { action: 'read_context', record: reference(s.context), pointer: '/absent' }, [reference(s.context)],
      readPointerResult(s.context.value, '/absent'), [partOrigin(2, 1), attemptOrigin(3, 2)]),
    entry(4, { action: 'read_source', source: reference(s.source), selector: { kind: 'text-range', start: 4, end: 900000 } }, [reference(s.source)],
      { ...readTextResult(content, { start: 4, end: 900000 }), text: 'x'.repeat(20_000) }, [attemptOrigin(4, 1)]),
    entry(5, { action: 'read_source', source: foreign, selector: { kind: 'text-range', start: 0, end: 1 } }, [foreign],
      readTextResult('z', { start: 0, end: 1 }), [attemptOrigin(5, 1)]),
    entry(6, { action: 'read_source', source: reference(s.source), selector: { kind: 'text-range', start: 1, end: 2 } }, [reference(s.source)],
      readTextResult(content, { start: 1, end: 2 }), [attemptOrigin(6, 1)],
      { state: 'omitted', reason: 'head-changed', source: reference(s.source), observed: { ...reference(s.source), revision: 2, hash: '9'.repeat(64) } }),
  ];
  const carried: CarriedBasis = { snapshots: [{ kind: 'packet', packet: step(9).packet }], entries };
  return { ...s, carried, base: packetPrompt(s.payload).length };
}
const section = (text: string, base: string) => text.slice(base.length);

test('MP3 row 19 (wire): readings are optional; a declared null, unknown or damaged marker is refused before any text is sent', t => {
  const { payload, carried } = carriedSample(t);
  assert.equal(briefReadings(payload), null, 'An MP1 brief without readings stays its own era');
  const marked = withReadings(payload, { snapshots: [], entries: [] }, 100_000);
  assert.equal(packetPrompt(marked), packetPrompt(payload), 'An empty carried set changes no text');
  assert.deepEqual(briefReadings(marked), { contract: READINGS_CONTRACT, snapshots: [], entries: [] });
  const full = withReadings(payload, carried, 1_000_000);
  assert.ok(briefReadings(full));
  const readings = full.brief.readings;
  for (const broken of [null, { ...readings, contract: 'om-brief-readings/v2' }, { contract: READINGS_CONTRACT, snapshots: [] },
    { ...readings, extra: true }, { ...readings, snapshots: [{ kind: 'attempt', ordinal: 1, binding: readings.entries[1].origins[1].binding, work: readings.entries[1].origins[1].work }] },
    { ...readings, entries: [{ ...readings.entries[0], decision: { state: 'included', why: 'free text' } }] },
    { ...readings, entries: [{ ...readings.entries[0], decision: { state: 'omitted', reason: 'head-changed', source: readings.entries[0].sources[0] } }] },
    { ...readings, entries: [{ ...readings.entries[0], origins: [] }] },
    { ...readings, entries: [{ ...readings.entries[0], origins: [{ ...readings.entries[0].origins[0], delivery: 'r1' }] }] },
    { ...readings, entries: [{ ...readings.entries[0], sources: [] }] }]) {
    const packet = { ...full, brief: { ...full.brief, readings: broken } };
    for (const check of [() => packetPrompt(packet), () => briefReadings(packet)])
      assert.throws(check, (error: unknown) => error instanceof EngineError && error.code === 'packet_brief_invalid', canonical(broken));
  }
});

test('MP3 №3171 (brief): the readings marker takes every source list a lawful delivery has — none for a search over an empty directory — and still refuses a missing or extra source of read_source, read_context, read and a search inside a named source', t => {
  const s = carriedSample(t), origin = s.carried.entries[0]!.origins[0]!, source = reference(s.source);
  const entry = (read: Record<string, unknown>, sources: unknown[], data: unknown) => ({ origins: [origin], read, sources, data, decision: { state: 'eligible' } }) as unknown as CarriedEntry;
  const full = withReadings(s.payload, { snapshots: s.carried.snapshots, entries: [
    entry({ action: 'search', within: 'empty-dir', query: 'absent' }, [], []), entry({ action: 'search', within: source, query: 'absent' }, [source], [])] }, 1_000_000);
  const readings = briefReadings(full)!;
  assert.deepEqual(readings.entries.map(row => row.decision.state), ['included', 'included']);
  const shown = packetPrompt(full).slice(packetPrompt(s.payload).length);
  assert.ok(shown.includes('"within":"empty-dir"') && shown.includes('"data":[]'), 'The empty search is shown by its path with no rows');
  const selector = { kind: 'text-range', start: 0, end: 1 };
  for (const [read, sources] of [
    [{ action: 'read_source', source, selector }, []], [{ action: 'read_source', source, selector }, [source, source]],
    [{ action: 'read_context', record: reference(s.context), pointer: '/a' }, []], [{ action: 'read', path: 'x.txt', media: 'text/plain' }, []],
    [{ action: 'read', path: 'x.txt', media: 'text/plain' }, [source, source]], [{ action: 'search', within: source, query: 'absent' }, []],
    [{ action: 'list', within: 'empty-dir' }, [source]]] as [Record<string, unknown>, unknown[]][]) {
    const packet = { ...full, brief: { ...full.brief, readings: { ...readings, entries: [{ ...readings.entries[1]!, read, sources }] } } };
    for (const check of [() => packetPrompt(packet), () => briefReadings(packet)])
      assert.throws(check, (error: unknown) => error instanceof EngineError && error.code === 'packet_brief_invalid', canonical([read, sources]));
  }
});

test('MP3 №3171 (view): a literal path stays as asked — a read of a file without a label here and a search over a path with such a file in its scope are shown; a found line of a file without a label is not', t => {
  const s = carriedSample(t), origin = s.carried.entries[0]!.origins[0]!, source = reference(s.source);
  const unlabelled = { id: 'source:garden:not-in-catalogue', revision: 1, hash: 'f'.repeat(64) };
  const entry = (read: Record<string, unknown>, sources: unknown[], data: unknown) => ({ origins: [origin], read, sources, data, decision: { state: 'eligible' } }) as unknown as CarriedEntry;
  const line = s.source.value.content.split('\n')[0]!;
  const full = withReadings(s.payload, { snapshots: s.carried.snapshots, entries: [
    entry({ action: 'read', path: 'other.txt', media: 'text/plain' }, [unlabelled], 'other text'),
    entry({ action: 'search', within: 'docs', query: 'absent' }, [unlabelled], []),
    entry({ action: 'search', within: 'docs', query: 'other' }, [unlabelled], [{ source: unlabelled, line: 1, text: 'other text' }]),
    entry({ action: 'search', within: '.', query: line }, [unlabelled, source], [{ source, line: 1, text: line }])] }, 1_000_000);
  assert.deepEqual(briefReadings(full)!.entries.map(row => 'reason' in row.decision ? row.decision.reason : row.decision.state),
    ['included', 'included', 'unaddressed', 'included']);
  const shown = packetPrompt(full).slice(packetPrompt(s.payload).length);
  assert.ok(shown.includes('"path":"other.txt"') && shown.includes('"within":"docs"'), 'Literal paths are shown as asked');
  assert.equal(shown.includes(unlabelled.id), false, 'A file without a label is never shown by its reference');
});

test('MP3 №3190 (brief): an unconfirmed scope is an omission of a search over a workspace path only, counted in the summary', t => {
  const s = carriedSample(t), origin = s.carried.entries[0]!.origins[0]!, source = reference(s.source);
  const omitted = { state: 'omitted', reason: 'scope-unconfirmed' };
  const full = withReadings(s.payload, { snapshots: s.carried.snapshots, entries: [
    { origins: [origin], read: { action: 'search', within: 'empty-dir', query: 'absent' }, sources: [], data: [], decision: omitted } as unknown as CarriedEntry] }, 1_000_000);
  const readings = briefReadings(full)!;
  assert.deepEqual(readings.entries.map(row => row.decision), [omitted]);
  assert.ok(packetPrompt(full).includes('{"omitted":{"scope-unconfirmed":1}}'));
  for (const [read, sources] of [[{ action: 'read_source', source, selector: { kind: 'text-range', start: 0, end: 1 } }, [source]],
    [{ action: 'search', within: source, query: 'absent' }, [source]]] as [Record<string, unknown>, unknown[]][]) {
    const packet = { ...full, brief: { ...full.brief, readings: { ...readings, entries: [{ ...readings.entries[0]!, read, sources }] } } };
    for (const check of [() => packetPrompt(packet), () => briefReadings(packet)])
      assert.throws(check, (error: unknown) => error instanceof EngineError && error.code === 'packet_brief_invalid', canonical(read));
  }
});

test('MP3 rows 14–15 (brief): carried items are whole, in their given order, by the labels of this packet, after the fitting text; capacity omits them first with a counted summary', t => {
  const { payload, carried, base } = carriedSample(t), text = packetPrompt(payload);
  const decisions = (packet: Record<string, any>) => packet.brief.readings.entries.map((entry: { decision: { state: string; reason?: string } }) => entry.decision.reason ?? entry.decision.state);
  const roomy = withReadings(payload, carried, 1_000_000);
  assert.deepEqual(decisions(roomy), ['included', 'included', 'included', 'unaddressed', 'head-changed']);
  const shown = section(packetPrompt(roomy), text);
  assert.ok(packetPrompt(roomy).startsWith(text), 'The fitting MP1 text is kept as it is');
  assert.ok(shown.startsWith('\n# Carried reads'));
  assert.equal(/[0-9a-f]{64}/.test(shown), false, 'The model sees labels, never references or hashes');
  const items = JSON.parse(shown.split('\n')[3]!) as { origins: unknown[]; read: Record<string, unknown> }[];
  const sourceLabel = payload.brief.labels.find((label: { domain: string; value: unknown }) => label.domain === 'source' && canonical(label.value) === canonical(carried.entries[0]!.sources[0]))!.label;
  assert.equal(items[0]!.read.source, sourceLabel);
  assert.deepEqual(items[1]!.origins, [{ kind: 'part', part: 2 }, { kind: 'attempt', attempt: 2 }], 'One shown item lists both origins');
  assert.deepEqual(JSON.parse(shown.split('\n')[4]!), { omitted: { 'head-changed': 1, unaddressed: 1 } });
  const tight = withReadings(payload, carried, base + section(packetPrompt(withReadings(payload, { ...carried,
    entries: carried.entries.filter((_, index) => index !== 2) }, 1_000_000)), text).length + 20);
  assert.deepEqual(decisions(tight), ['included', 'included', 'capacity', 'unaddressed', 'head-changed']);
  assert.ok(packetPrompt(tight).length <= base + section(packetPrompt(tight), text).length);
  assert.deepEqual(JSON.parse(section(packetPrompt(tight), text).split('\n')[4]!), { omitted: { capacity: 1, 'head-changed': 1, unaddressed: 1 } });
  const none = withReadings(payload, carried, base);
  assert.equal(packetPrompt(none), text, 'Without remaining capacity nothing is shown and the packet is not blocked');
  assert.deepEqual(decisions(none), ['capacity', 'capacity', 'capacity', 'unaddressed', 'head-changed']);
  for (const limit of [base + 100, base + 2_000, base + 30_000]) {
    const bounded = withReadings(payload, carried, limit);
    assert.ok(packetPrompt(bounded).length <= limit, String(limit));
    const included = decisions(bounded).filter((value: string) => value === 'included').length;
    assert.equal(included === 0 ? 0 : JSON.parse(section(packetPrompt(bounded), text).split('\n')[3]!).length, included, 'Included means shown');
  }
});

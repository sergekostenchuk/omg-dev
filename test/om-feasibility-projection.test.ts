import { DatabaseSync } from "node:sqlite";
import { runIntegrityCheck, integrityGate } from "../src/om/integrity.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { b1OriginCheck } from "../src/om/b1-origin.js";
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonical, hashJson } from '../src/canonical.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { EngineError } from '../src/errors.js';
import type { Graph } from '../src/graph/model.js';
import type { Feasibility } from '../src/graph/refinement.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { readFeasibility, writeFeasibility, type FeasibilityRequest, type OmFeasibility } from '../src/om/feasibility.js';
import { readOmInput, writeOmInput, type OmInputRecord } from '../src/om/input.js';
import { recordRefusal, UNIT_REFUSAL_KIND, unitRefusalNamespace } from '../src/om/refusal-journal.js';
import { beginAttempt, openSeries, type AttemptGoal } from '../src/om/series.js';
import { readCall, recordCall } from '../src/om/call-record.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { executionFixture } from './execution-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';
import { writeHorizon } from '../src/om/horizon.js';

function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} ${canonical(result.refusal.at)}`);
  return result.value;
}
const history = (store: Store) => canonical(store.list().flatMap(row => store.history(row.id)));
function firstInput(store: Store, project: string) {
  return ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
}
function b1Fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g12-b1-')), database = join(directory, 'state.sqlite'), project = 'garden';
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  preparedFeatures(engine, project);
  const input = firstInput(store, project);
  return { directory, project, input, get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); } };
}
interface WorksFixture {
  readonly store: Store; readonly project: string; readonly workspace: string;
  readonly feasibility: FeasibilityRequest;
  restart(): void;
}
let worksModule: Promise<{ acceptedWorksFixture(t: TestContext): WorksFixture }> | undefined;
function worksFixture(t: TestContext): Promise<WorksFixture> {
  worksModule ??= (async () => {
    const url = new URL('./om-feasibility.test.js', import.meta.url), source = readFileSync(url, 'utf8');
    const boundary = source.indexOf('const heads =');
    assert.ok(boundary > 0, 'The native fixture ends before the original test suite');
    const prefix = source.slice(0, boundary).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix), 'Importing the native producer does not register its tests');
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedWorksFixture };`).toString('base64')}`);
  })();
  return worksModule.then(module => module.acceptedWorksFixture(t));
}
interface MixedLayerHead { readonly acceptance?: { readonly producer: string }; readonly layerProofs?: readonly { readonly level: number }[] }
interface MixedNativeFixture {
  readonly store: Store; readonly engine: ProductEngine; readonly project: string; readonly workspace: string;
  readonly legacy: Revision<Feasibility>;
  readonly basis: OmResult<unknown>;
  readonly omLayer: Revision<MixedLayerHead>;
  readonly beforeRefusal: string;
  readonly attempt: (store: Store) => OmResult<unknown>;
  restart(): void;
}
let mixedModule: Promise<{ acceptedOperationsFixture(t: TestContext): unknown }> | undefined;
async function mixedNativeFixture(t: TestContext): Promise<MixedNativeFixture> {
  mixedModule ??= (async () => {
    const url = new URL('./om-feasibility.test.js', import.meta.url), source = readFileSync(url, 'utf8');
    const boundary = source.indexOf('const heads ='); assert.ok(boundary > 0);
    let prefix = source.slice(0, boundary);
    const once = (before: string, after: string) => {
      assert.equal(prefix.split(before).length - 1, 1, `One native-to-OM fixture seam: ${before.slice(0, 60)}`);
      prefix = prefix.replace(before, after);
    };
    once("import { preparedFeatures } from './product-fixture.js';", "import { preparedFeatures, refinedLayers } from './product-fixture.js';");
    once('preparedFeatures(engine, project, l1, field => {', "desired.horizon = ['garden-consume-work']; preparedFeatures(engine, project, desired, field => {");
    const input = '  let input = ok(writeOmInput(store, { project, expected: 0,';
    once(input, `    const nativeCommand = { executable: process.execPath, args: ['--version'] };
    engine.environments.configure(project, { workspace,
      implementer: { actor: 'external-producer', model: 'fixture', effort: 'high', command: nativeCommand },
      reviewer: { actor: 'external-reviewer', model: 'fixture', effort: 'high', command: nativeCommand },
      fullCheck: nativeCommand, timeoutMs: 5_000, requestCapacityChars: 200000 }, 0);
    refinedLayers(engine, project);
    const legacy = engine.refinement.assess(project, 0);
    assert.equal(legacy.id, 'feasibility:' + project); assert.equal(legacy.value.ready, true);
    assert.deepEqual(engine.refinement.feasibilityGate(project, reference(legacy), true).findings, []);
    for (const inputRef of legacy.value.inputs) { const rec = store.get(inputRef.id, inputRef.revision); assert.ok(rec, 'native input missing: ' + inputRef.id); assert.deepEqual(reference(rec), inputRef); }
${input}`);
    // The complete native history stays in this database; the OM N2 candidate names its exact research basis.
    once('    layer: null, frame: null, upper: null };',
      '    layer: reference(store.get(`graph-layer:${project}:2`)), frame: null, upper: null };');
    // The next works-basis step is where the contract refuses: keep the refusal instead of throwing it.
    once('const basis = ok(prepareFrame(', 'const basis = prepareFrame(');
    once('frame: upperFrame } }));', 'frame: upperFrame } });');
    const proposal = '        return reference(store.write({ id: `om-proposal:garden:external-${level}`';
    once(proposal, `        value.replaces = value.fills.flatMap(fill => frame.result.fills
          .filter(old => old.obligation === fill.obligation && old.source === 'accepted')
          .map(old => ({ obligation: fill.obligation, base: { node: old.node, graph: frame.request.graph },
            with: { node: fill.node, port: fill.port ?? null }, basis: 'Preserve the exact accepted fill in the OM contract' })));
${proposal}`);
    once('return { root, workspace, database, project, desired, basis, frame2, graph, layer, upperFrame, input, horizon, proposal,',
      'return { root, workspace, database, project, desired, basis, frame2, graph, layer, upperFrame, input, horizon, proposal, legacy,');
    prefix = prefix.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix), 'The mixed native producer does not import the original test registrations');
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedOperationsFixture };`).toString('base64')}`);
  })();
  const base = (await mixedModule).acceptedOperationsFixture(t) as Omit<MixedNativeFixture, 'basis'> & { basis: OmResult<unknown> };
  const { store, engine, project } = base;
  const omLayer = store.get<MixedLayerHead>(`graph-layer:${project}:2`)!;
  // The one remaining continuation rebuilds the research work layer over the OM basis by the real producers.
  engine.refinement.sealLayer(project, 2, 1);
  const rebuiltR2 = engine.refinement.begin(project, 'R2');
  answerTechnicalFixture(engine, project, rebuiltR2);
  engine.refinement.finishResearch(project, 'R2', reference(store.get(rebuiltR2.id)!), 1);
  deriveLayerFixture(engine, project, 3);
  const beforeRefusal = history(store);
  const attempt = (s: Store) => writeHorizon(s, { project, input: reference(s.get(`om-input:${project}`)!),
    graph: reference(s.get(`graph:${project}`)!), refinement: reference(omLayer), available: {},
    choice: { choiceVersion: 'mixed-works-retry', features: [{ outcome: 'garden-result' }], excluded: [] } });
  return { ...base, omLayer, basis: base.basis, beforeRefusal, attempt,
    get store() { return base.store; }, get engine() { return base.engine; }, restart: () => base.restart() };
}
function missingM8(engine: ProductEngine, project: string) {
  const view = engine.projection(project);
  assert.equal(view.feasibility, null);
  assert.ok(view.feasibilityGate);
  assert.ok(view.feasibilityGate.findings.some(finding => finding.code === 'feasibility_missing' && finding.target === `om-feasibility:${project}`));
  assert.deepEqual(view.feasibilityGate.guards, []);
  return view;
}
function addressed(error: unknown): boolean {
  assert.ok(error instanceof EngineError, 'An invalid saved origin has a typed refusal');
  assert.ok(error.code.length > 0);
  assert.ok(error.details && typeof error.details === 'object');
  assert.ok(typeof (error.details as { target?: unknown }).target === 'string');
  return true;
}
function hidden(store: Store, id: string, onlyRevision?: number): Store {
  const get = store.get.bind(store), list = store.list.bind(store), historical = store.history.bind(store);
  return new Proxy(store, { get(target, property) {
    if (property === 'get') return (key: string, revision?: number) => key === id && (onlyRevision === undefined || revision === onlyRevision) ? null : get(key, revision);
    if (property === 'list') return (kind?: string) => list(kind).filter(row => row.id !== id || onlyRevision !== undefined && row.revision !== onlyRevision);
    if (property === 'history') return (key: string) => historical(key).filter(row => row.id !== id || onlyRevision !== undefined && row.revision !== onlyRevision);
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('G1.2 a genuine first B1 selects the OM projection before any accepted works or M8', t => {
  const f = b1Fixture(t), before = history(f.store);
  assert.equal(f.input.revision, 1);
  assert.equal(f.store.get('om-frame:garden:3'), null);
  assert.equal(f.store.get('om-feasibility:garden'), null);
  const view = missingM8(f.engine, f.project);
  assert.deepEqual(f.engine.execute({ type: 'project', project: f.project }), view);
  assert.equal(history(f.store), before, 'Both public projection paths are read-only');
  f.restart();
  assert.deepEqual(missingM8(f.engine, f.project), view);
  assert.equal(history(f.store), before);
});

test('G1.2 historical B1 selects the OM era after its accepted source stages become stale', t => {
  const f = b1Fixture(t), original = reference(f.input);
  const brief = f.store.get(`source:${f.project}:brief`)!;
  assert.ok(brief);
  f.engine.discovery.evidence.document(f.project, 'brief', 'A later version of the brief', 'text/plain', brief.revision);
  assert.equal(f.engine.pipeline.inspect(f.project, 'features').state, 'stale');
  assert.deepEqual(ok(readOmInput(f.store, f.project, original)), f.input);
  const before = history(f.store);
  missingM8(f.engine, f.project);
  f.restart();
  missingM8(f.engine, f.project);
  assert.equal(history(f.store), before);
});

test('G1.2 assess before accepted works refuses the missing L3 source without creating either feasibility', t => {
  const f = b1Fixture(t), command = { executable: process.execPath, args: ['--version'] };
  f.engine.environments.configure(f.project, { workspace: f.directory,
    implementer: { actor: 'implementer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const before = history(f.store);
  assert.throws(() => f.engine.execute({ type: 'assess', project: f.project, expected: 0 }), (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'feasibility_source_missing');
    assert.deepEqual(error.details, { unit: 'M8', target: `graph-layer:${f.project}:3`, field: 'acceptance.frame' });
    return true;
  });
  assert.equal(f.store.get(`feasibility:${f.project}`), null);
  assert.equal(f.store.get(`om-feasibility:${f.project}`), null);
  assert.equal(history(f.store), before);
});

test('G1.2 a native legacy project with a new B1 never falls back to its saved R3 and plan', t => {
  const f = executionFixture(t), legacy = f.store.get<Feasibility>('feasibility:p')!;
  const oldPlan = f.plan, oldStage = f.store.get('stage:p:om-g2')!, oldProjection = f.engine.projection('p');
  assert.equal(f.store.get('om-input:p'), null);
  assert.equal(oldProjection.feasibility, null);
  assert.equal(oldProjection.feasibilityGate, null);
  assert.equal(oldProjection.ownerQuestions, null);
  const input = firstInput(f.store, 'p');
  assert.equal(input.revision, 1);
  assert.equal(f.store.get('om-frame:p:3'), null, 'Native L3 acceptance cannot decide the project era');
  const before = history(f.store);
  missingM8(f.engine, 'p');
  assert.throws(() => f.engine.execute({ type: 'assess', project: 'p', expected: legacy.revision }),
    (error: unknown) => addressed(error) && (error as EngineError).code === 'revision_conflict'
      && ((error as EngineError).details as { target: string }).target === 'om-feasibility:p');
  assert.equal(history(f.store), before, 'A native revision outside the M8 revision space cannot write either result');
  f.reopen();
  missingM8(f.engine, 'p');
  assert.deepEqual(f.store.get(legacy.id, legacy.revision), legacy);
  assert.deepEqual(f.engine.compiler.read(oldPlan.id), oldPlan);
  assert.deepEqual(f.store.get(oldStage.id, oldStage.revision), oldStage);
  assert.deepEqual(f.engine.refinement.feasibilityGate('p', reference(legacy), true).findings, []);
  assert.equal(history(f.store), before, 'Changing the selected producer never rewrites either historical era');
});

test('LG30-C assess before B1 refuses instead of producing another native R3, including after restart', t => {
  const f = executionFixture(t), legacy = f.store.get<Feasibility>('feasibility:p')!;
  const before = history(f.store);
  for (const restart of [false, true]) {
    if (restart) f.reopen();
    assert.throws(() => f.engine.execute({ type: 'assess', project: 'p', expected: legacy.revision }), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, 'feasibility_source_missing');
      assert.deepEqual(error.details, { unit: 'M8', target: 'om-input:p', field: 'input' });
      return true;
    });
    assert.equal(f.store.get('om-input:p'), null);
    assert.equal(f.store.get('om-feasibility:p'), null);
    assert.deepEqual(f.store.get(legacy.id), legacy);
    assert.equal(history(f.store), before);
  }
});

test('G1.2 the projection and assess command select the genuine accepted-works M8 producer and its revision space', async t => {
  const f = await worksFixture(t), engine = new ProductEngine(f.store);
  const saved = ok(writeFeasibility(f.store, f.feasibility));
  assert.equal(f.store.get(`feasibility:${f.project}`), null);
  const projected = engine.projection(f.project);
  assert.deepEqual(projected.feasibility, saved);
  assert.deepEqual(projected.feasibilityGate, engine.refinement.feasibilityGate(f.project, reference(saved)));
  assert.deepEqual(projected.feasibilityGate?.findings, []);
  const assessed = engine.execute({ type: 'assess', project: f.project, expected: saved.revision }) as Revision<OmFeasibility>;
  assert.deepEqual(assessed, saved, 'An unchanged assessment is the native M8 idempotent result');
  assert.equal(f.store.get(`feasibility:${f.project}`), null, 'OM assess never creates a native R3 record');
  f.restart();
  const reopened = new ProductEngine(f.store);
  assert.deepEqual(reopened.projection(f.project).feasibility, assessed);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
  const before = history(f.store);
  assert.throws(() => reopened.execute({ type: 'assess', project: f.project, expected: assessed.revision + 1 }),
    (error: unknown) => error instanceof EngineError && error.code === 'revision_conflict');
  assert.equal(history(f.store), before, 'An unmatched M8 expected revision cannot write in either namespace');
  const environment = reopened.environments.get(f.project), { projectId: _project, ...settings } = environment.value;
  reopened.environments.configure(f.project, { ...settings, timeoutMs: settings.timeoutMs + 1 }, environment.revision);
  f.restart();
  const later = new ProductEngine(f.store), afterChange = history(f.store);
  assert.throws(() => later.execute({ type: 'assess', project: f.project, expected: 0 }),
    (error: unknown) => error instanceof EngineError && error.code === 'revision_conflict',
    'The public command requires the current M8 revision even when an older result can be read historically');
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeFeasibility(f.store, f.feasibility)), saved,
    'The explicit original source tuple remains a valid historical repeat of the M8 producer API');
  assert.equal(history(f.store), afterChange, 'Historical repetition does not save a new result or restore old environment heads');
});

test('G1.2 a first assess command creates M8 while the public projection initially reports it missing', async t => {
  const f = await worksFixture(t), engine = new ProductEngine(f.store);
  missingM8(engine, f.project);
  const saved = engine.execute({ type: 'assess', project: f.project, expected: 0 }) as Revision<OmFeasibility>;
  assert.equal(saved.id, `om-feasibility:${f.project}`); assert.equal(saved.revision, 1);
  assert.equal(saved.value.producer.contract, 'om-m8/v2');
  assert.equal(saved.value.ready, true);
  assert.deepEqual(engine.projection(f.project).feasibility, saved);
  assert.equal(f.store.get(`feasibility:${f.project}`), null);
  assert.deepEqual(engine.execute({ type: 'assess', project: f.project, expected: saved.revision }), saved,
    'An exact repeat of the current M8 revision is the idempotent result');
  const environment = engine.environments.get(f.project), { projectId: _projectId, ...settings } = environment.value;
  engine.environments.configure(f.project, { ...settings, timeoutMs: settings.timeoutMs + 1 }, environment.revision);
  const second = engine.execute({ type: 'assess', project: f.project, expected: saved.revision }) as Revision<OmFeasibility>;
  assert.equal(second.id, saved.id); assert.equal(second.revision, 2);
  assert.notDeepEqual(second.value.environment, saved.value.environment);
  f.restart();
  const reopened = new ProductEngine(f.store);
  assert.deepEqual(reopened.projection(f.project).feasibility, second);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(second) })), second);
  const before = history(f.store);
  assert.throws(() => reopened.execute({ type: 'assess', project: f.project, expected: saved.revision }),
    (error: unknown) => error instanceof EngineError && error.code === 'revision_conflict'
      && (error.details as { target: string }).target === second.id);
  assert.equal(history(f.store), before, 'A stale M8 expected revision writes nothing');
});

test('G1.2 a genuine mixed project preserves native R3 while the OM continuation stops at the exact incompatible step', async t => {
  const f = await mixedNativeFixture(t), engine = f.engine, legacyBytes = canonical(f.legacy);
  // The complete native history lives in this database: R3 is revision 1 and every exact input still resolves.
  assert.equal(f.legacy.id, `feasibility:${f.project}`); assert.equal(f.legacy.revision, 1);
  for (const input of f.legacy.value.inputs)
    assert.deepEqual(reference(f.store.get(input.id, input.revision)!), input);
  // The first B1 already selected the OM space: the projection reports the missing M8, never the saved R3.
  missingM8(engine, f.project);
  const beforeAssess = history(f.store);
  assert.throws(() => engine.execute({ type: 'assess', project: f.project, expected: f.legacy.revision }),
    (error: unknown) => addressed(error) && (error as EngineError).code === 'revision_conflict'
      && ((error as EngineError).details as { target: string }).target === `om-feasibility:${f.project}`);
  assert.equal(history(f.store), beforeAssess, 'A native revision is not an expected revision of the M8 record');
  // The real OM N2 acceptance happened on the exact research basis inside the fixture.
  assert.equal(f.omLayer.value.acceptance?.producer, 'om');
  // The next continuation step is refused at its exact contract point: the works frame cannot omit
  // the saved research L3 (its head carries level-3 proofs).
  assert.equal(f.basis.ok, false);
  if (!f.basis.ok) {
    assert.equal(f.basis.refusal.code, 'frame_basis_unproven');
    assert.deepEqual(f.basis.refusal.at, { unit: 'F4', target: `graph-layer:${f.project}:3`, field: 'layer' });
  }
  // The remaining bridge — a fresh research L3 derived over the OM L2 by real producers — also cannot
  // proceed: its graph write supersedes the accepted L2 head, so the works horizon names a non-head.
  const refused = f.attempt(f.store);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.refusal.code, 'input_stale');
    assert.deepEqual(refused.refusal.at, { unit: 'G2', target: `graph-layer:${f.project}:2`, field: 'head', ref: reference(f.omLayer) });
  }
  assert.equal(history(f.store), f.beforeRefusal, 'The refused step writes nothing');
  const repeat = f.attempt(f.store);
  assert.equal(repeat.ok, false);
  if (!repeat.ok) assert.equal(repeat.refusal.code, 'input_stale');
  assert.equal(history(f.store), f.beforeRefusal, 'A repeat of the refused step writes nothing');
  // After the OM N2 acceptance the native gate names the superseded L2 input; the record itself is untouched.
  const stale = engine.refinement.feasibilityGate(f.project, reference(f.legacy), true);
  assert.ok(stale.findings.some(finding => finding.code === 'feasibility_stale' && finding.target === `graph-layer:${f.project}:2`),
    'The native gate addresses the exact layer revision the OM acceptance superseded');
  assert.ok(!stale.findings.some(finding => finding.code === 'feasibility_contract_superseded'),
    'An explicit native reference retains its own producer contract in a mixed project');
  assert.equal(canonical(f.store.get(f.legacy.id)), legacyBytes);
  f.restart();
  assert.equal(canonical(f.store.get(f.legacy.id, f.legacy.revision)), legacyBytes);
  for (const input of f.legacy.value.inputs)
    assert.deepEqual(reference(f.store.get(input.id, input.revision)!), input);
  const cold = f.attempt(f.store);
  assert.equal(cold.ok, false);
  if (!cold.ok) assert.equal(cold.refusal.code, 'input_stale');
  assert.equal(history(f.store), f.beforeRefusal, 'A cold repeat of the refused step adds no records');
});

test('G1.2 B1 revision one remains mandatory with a derived head and retained M8 references', async t => {
  const f = await worksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  const input = f.store.get<OmInputRecord>(`om-input:${f.project}`)!;
  assert.ok(input.revision > 1, 'The real fixture records D3 decisions after the first B1');
  const before = history(f.store), lost = lostB1Copy(t, f.store, f.project);
  assert.equal(lost.get(input.id, 1), null);
  assert.deepEqual(lost.get(input.id), input); assert.deepEqual(lost.get(saved.id), saved);
  assertMissingB1(lost, f.project);
  const cold = new Store(lost.path); t.after(() => cold.close());
  assertMissingB1(cold, f.project);
  assert.equal(history(f.store), before);
  f.restart();
  assert.deepEqual(new ProductEngine(f.store).projection(f.project).feasibility, saved);
});

test('G1.2 invalid first B1 refuses projection and assess through the common exact historical reader', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = await worksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  const input = f.store.get<OmInputRecord>(`om-input:${f.project}`, 1)!;
  for (const value of [{ ...structuredClone(input.value), projectId: 'another-project' },
    { ...structuredClone(input.value), hash: '0'.repeat(64) },
    { ...structuredClone(input.value), input: { ...structuredClone(input.value.input), sources: [] } }]) {
    const replacement = { ...input, value, hash: hashJson(value) }, get = f.store.get.bind(f.store);
    const view = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return (id: string, revision?: number) => id === input.id && revision === 1 ? replacement : get(id, revision);
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    const checked = readOmInput(view, f.project, reference(replacement));
    assert.equal(checked.ok, false); if (checked.ok) throw new Error('Invalid first B1 unexpectedly passed its shared reader');
    const engine = new ProductEngine(view), before = history(f.store);
    for (const action of [() => engine.projection(f.project), () => engine.execute({ type: 'assess', project: f.project, expected: saved.revision })])
      assert.throws(action, (error: unknown) => addressed(error) && (error as EngineError).code === checked.refusal.code);
    assert.equal(history(f.store), before);
  }
});

/** The integrity boundary reads committed SQLite rows: make a damaged copy instead of hiding get() through a Proxy. */
function lostB1Copy(t: TestContext, source: Store, project: string, keep?: string[], alsoMissing: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g7-lost-')), path = join(directory, 'state.sqlite');
  const original = new DatabaseSync(source.path);
  try { original.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); } finally { original.close(); }
  const raw = new DatabaseSync(path);
  try {
    raw.exec('PRAGMA foreign_keys=OFF');
    for (const name of ['revisions_no_delete', 'events_no_delete']) raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
    if (keep) for (const table of ['revisions', 'events', 'heads'])
      raw.prepare(`DELETE FROM ${table} WHERE entity_id NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
    const id = `om-input:${project}`;
    raw.prepare('DELETE FROM revisions WHERE entity_id=? AND revision=1').run(id);
    raw.prepare('DELETE FROM events WHERE entity_id=? AND revision=1').run(id);
    raw.prepare('DELETE FROM heads WHERE entity_id=? AND revision=1').run(id);
    for (const removed of alsoMissing) for (const table of ['revisions', 'events', 'heads'])
      raw.prepare(`DELETE FROM ${table} WHERE entity_id=?`).run(removed);
  } finally { raw.close(); }
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function assertMissingB1(store: Store, project: string) {
  const retained = () => canonical(store.list().filter(row => row.id !== `om-integrity:${project}`).flatMap(row => store.history(row.id)));
  const before = retained();
  const report = runIntegrityCheck(store, { project }); assert.ok(report.ok);
  assert.ok(report.value.value.findings.some(f => f.code === 'record_missing' && f.id === `om-input:${project}` && f.revision === 1));
  assert.equal(integrityGate(store, project)?.ok, false);
  assert.equal(retained(), before, 'Only the addressed integrity report may be saved');
}

test('G1.2 a retained OM stage reference without B1 refuses fsck and the integrity gate', async t => {
  const f = await worksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility)), engine = new ProductEngine(f.store);
  const stage = engine.refinement.publish(f.project, reference(saved), 0);
  engine.pipeline.accept(f.project, 'om-g2', stage.revision);
  const before = history(f.store);
  const lost = lostB1Copy(t, f.store, f.project, undefined, [saved.id]);
  assert.ok(lost.get(stage.id)); assert.equal(lost.get(`om-input:${f.project}`, 1), null); assert.equal(lost.get(saved.id), null);
  assertMissingB1(lost, f.project);
  assert.equal(history(f.store), before, 'The intact source fixture is unchanged');
});

test('G1.2 every retained native B1-dependent record refuses a missing first input independently', async t => {
  const f = await worksFixture(t);
  ok(writeFeasibility(f.store, f.feasibility));
  const kinds = ['om-input', 'horizon', 'om-horizon', 'input-decision', 'gap', 'gap-line', 'frame-candidate',
    'connection-frame', 'layer-proposal', 'om-neighbors', 'om-obligation-basis', 'om-obligations', 'om-atomic-gate'];
  const records = f.store.list();
  for (const phase of ['initial', 'reopened']) {
    if (phase === 'reopened') f.restart();
    for (const kind of kinds) await t.test(`${kind}/${phase}`, () => {
      const retained = records.find(row => row.kind === kind);
      assert.ok(retained, `The genuine accepted-works fixture has a ${kind} record`);
      if (kind === 'om-input') assert.ok(retained.revision > 1, 'The native D3 producer retained a later B1 revision');
      const before = history(f.store), lost = lostB1Copy(t, f.store, f.project, [retained.id, `project:${f.project}`]);
      assert.equal(lost.get(`om-input:${f.project}`, 1), null);
      assert.deepEqual(lost.get(retained.id), retained);
      assertMissingB1(lost, f.project);
      assert.equal(history(f.store), before);
    });
  }
});

test('G1.2 pre-B1 refusal journals and document text do not establish an OM era', t => {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g12-pre-input-')), store = new Store(join(directory, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), project = 'garden';
  engine.execute({ type: 'create-project', project, title: 'A project before B1' });
  const source = engine.discovery.evidence.document(project, 'discussion',
    'A discussion of om-input:garden and om-feasibility:garden is not a saved input or producer reference.', 'text/plain', 0);
  const failure = store.write({ id: `${unitRefusalNamespace(project)}before-input`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: 'G1', refusals: [{ code: 'input_missing', goal: 'Prepare the first input', remedy: 'Provide accepted sources',
      origin: { name: 'input_missing', stage: 'G1', subject: project, sources: [{ role: 'base', ref: reference(source) }] } }] } });
  ok(recordRefusal(store, { project, source: reference(failure) }));
  assert.equal(store.get(`om-input:${project}`), null);
  const before = history(store), view = engine.projection(project);
  assert.equal(view.feasibility, null); assert.equal(view.feasibilityGate, null);
  assert.equal(history(store), before);
});

test('G1.2 a saved call input reference requires first B1 at fsck when its call marker is missing', t => {
  const f = b1Fixture(t);
  // Deliberately incomplete physical record: this tests the era boundary, never the validity of a call or response.
  const callId = `model-call:${f.project}:om:lost-input`;
  for (const input of [reference(f.input), { id: f.input.id, revision: f.input.revision }]) {
    f.store.write({ id: callId, kind: 'model-call', expected: f.store.get(callId)?.revision ?? 0,
      value: { om: { input } } });
    const before = history(f.store), lost = lostB1Copy(t, f.store, f.project, [callId, `project:${f.project}`]);
    assertMissingB1(lost, f.project);
    assert.equal(history(f.store), before);
  }
  f.restart();
  assertMissingB1(lostB1Copy(t, f.store, f.project, [callId, `project:${f.project}`]), f.project);
});

test('G1.2 a missing M8 stays an addressed absence even after a genuine M8 was saved', async t => {
  const f = await worksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  const before = history(f.store);
  missingM8(new ProductEngine(hidden(f.store, saved.id)), f.project);
  f.restart();
  missingM8(new ProductEngine(hidden(f.store, saved.id)), f.project);
  assert.equal(history(f.store), before);
});

test('G1.2 present M8 integrity failures remain visible and never select another producer', async t => {
  const f = await worksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  const changes: [string, (value: Record<string, any>) => void][] = [
    ['producer marker', value => { delete value.producer.contract; }],
    ['producer ledger', value => { delete value.producer.obligations.ledger; }],
    ['producer handoff', value => { delete value.producer.obligations.producer; }],
    ['readiness', value => { delete value.producer.readiness; }],
  ];
  for (const [label, change] of changes) await t.test(label, () => {
    const value = structuredClone(saved.value) as unknown as Record<string, any>; change(value);
    const row = f.store.write({ id: saved.id, kind: saved.kind, expected: f.store.get(saved.id)!.revision, value });
    const before = history(f.store), projected = new ProductEngine(f.store).projection(f.project);
    assert.deepEqual(projected.feasibility, row);
    assert.ok(projected.feasibilityGate?.findings.some(finding => finding.code === 'feasibility_record_invalid' && finding.target === row.id));
    assert.throws(() => new ProductEngine(f.store).execute({ type: 'assess', project: f.project, expected: row.revision }),
      (error: unknown) => addressed(error) && (error as EngineError).code === 'feasibility_record_invalid');
    assert.equal(f.store.get(`feasibility:${f.project}`), null);
    assert.equal(history(f.store), before);
  });
});

test('G1.2 ordinary graph authoring cannot return a proven OM project to the legacy projection', async t => {
  const f = await worksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility)), engine = new ProductEngine(f.store);
  const original = f.store.get<Graph>(f.feasibility.graph.id)!, graph = structuredClone(original.value);
  graph.nodes.find(node => node.kind === 'work')!.title += ' — revised authoring';
  engine.graphs.save(f.project, graph, original.revision, 'owner');
  const currentLayer = f.store.get(`graph-layer:${f.project}:3`)!;
  assert.notEqual(currentLayer.hash, f.feasibility.layer.hash);
  const before = history(f.store), view = engine.projection(f.project);
  assert.deepEqual(view.feasibility, saved);
  assert.ok(view.feasibilityGate && view.feasibilityGate.findings.length > 0);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(f.store.get(`om-input:${f.project}`, 1)!))).id, `om-input:${f.project}`);
  assert.equal(history(f.store), before);
});

async function assessCasRace(t: TestContext, options: {
  existing: boolean; window: 'captured-head' | 'prepared-transaction'; noWrites?: boolean;
}) {
  const f = await worksFixture(t), id = `om-feasibility:${f.project}`;
  const initial = options.existing ? ok(writeFeasibility(f.store, f.feasibility)) : null;
  const request = { ...f.feasibility, expected: initial?.revision ?? 0 };
  const dirty = () => writeFileSync(join(f.workspace, 'competing-assessment.txt'), 'A new physical condition observed by the competing M8 producer');
  if (options.existing && !options.noWrites) dirty();
  const other = new Store(f.store.path), get = f.store.get.bind(f.store), writeMany = f.store.writeMany.bind(f.store);
  const competitor: { row: Sealed<Revision<OmFeasibility>> | null; history: string | null } = { row: null, history: null };
  let fired = false;
  const compete = () => {
    assert.equal(fired, false); fired = true;
    if (options.noWrites) dirty();
    competitor.row = ok(writeFeasibility(other, request));
    assert.equal(competitor.row.revision, request.expected + 1, 'The second Store performs an actual creation or advancement');
    assert.equal(competitor.row.id, id);
    if (initial) assert.notEqual(competitor.row.hash, initial.hash, 'An existing M8 changes through a real new assessment');
    competitor.history = history(other);
  };
  if (options.window === 'captured-head') {
    f.store.get = (<T>(recordId: string, revision?: number): Revision<T> | null => {
      const row = get<T>(recordId, revision);
      if (!fired && recordId === id && revision === undefined) {
        assert.deepEqual(row, initial, 'The public command has captured the original absent or exact M8 head');
        compete();
      }
      return row;
    }) as Store['get'];
  } else {
    f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
      if (!fired && (writes.some(write => write.id === id) || guards.some(guard => guard.id === id))) {
        assert.deepEqual(get(id), initial, 'No competitor has run before the prepared transaction');
        assert.equal(writes.filter(write => write.id === id).length, options.noWrites ? 0 : 1,
          'The fixture distinguishes a prepared write from an unchanged result with no writes');
        if (options.noWrites) assert.deepEqual(writes, [], 'The no-write result still has a final public CAS transaction');
        compete();
      }
      return writeMany<T>(writes, guards);
    }) as Store['writeMany'];
  }
  try {
    assert.throws(() => new ProductEngine(f.store).execute({ type: 'assess', project: f.project, expected: request.expected }),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.equal(error.code, 'revision_conflict', 'The original M8 CAS fails even when common preparation recognizes an identical result');
        assert.equal((error.details as { target?: unknown }).target, id);
        return true;
      });
    assert.equal(fired, true, 'The competing producer was invoked in the selected public command window');
    assert.ok(competitor.row); assert.ok(competitor.history);
    assert.deepEqual(get(id), competitor.row);
    assert.equal(history(f.store), competitor.history, 'The losing command does not change the competitor or save a partial preparation');
  } finally { f.store.get = get; f.store.writeMany = writeMany; other.close(); }
  assert.ok(competitor.row); assert.ok(competitor.history);
  const winner = competitor.row;
  assert.deepEqual(ok(writeFeasibility(f.store, request)), winner,
    'The common API keeps its explicit historical source-tuple repeat independently of the strict public command CAS');
  if (initial) assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(initial) })), initial);
  assert.equal(history(f.store), competitor.history);
  f.restart();
  assert.deepEqual(f.store.get(id), winner);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(winner) })), winner);
  assert.deepEqual(ok(writeFeasibility(f.store, request)), winner);
  assert.equal(history(f.store), competitor.history, 'Restart and exact history do not alter the winning transition');
}

test('G1.2 assess retains its captured M8 CAS against a real producer before preparation', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'existing M8 advancement' : 'first M8 creation', async child => {
    await assessCasRace(child, { existing, window: 'captured-head' });
  });
});

test('G1.2 assess retains its original M8 CAS through the prepared write transaction', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'existing M8 advancement' : 'first M8 creation', async child => {
    await assessCasRace(child, { existing, window: 'prepared-transaction' });
  });
});

test('G1.2 assess validates the original M8 CAS when preparation returns no writes', async t => {
  await assessCasRace(t, { existing: true, window: 'prepared-transaction', noWrites: true });
});

interface EraBoundaryEnvelope { name: string; id: string; kind: string; value: unknown; later?: unknown[] }
function eraBoundaryFixture(t: TestContext, project = 'p') {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g12-era-boundary-')), database = join(directory, 'state.sqlite');
  let store = new Store(database);
  new ProductEngine(store).execute({ type: 'create-project', project, title: 'Era boundary' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, restart() { store.close(); store = new Store(database); } };
}
function nativeAssessFailure(engine: ProductEngine, project: string) {
  try { engine.execute({ type: 'assess', project, expected: 0 }); }
  catch (error) {
    assert.ok(error instanceof EngineError);
    return { code: error.code, details: error.details };
  }
  assert.fail('The empty native project has a missing-prerequisite refusal');
}
function retainsNativeEra(t: TestContext, envelope: EraBoundaryEnvelope) {
  const f = eraBoundaryFixture(t), engine = new ProductEngine(f.store);
  const native = engine.projection('p'), nativeError = nativeAssessFailure(engine, 'p');
  f.store.write({ id: envelope.id, kind: envelope.kind, expected: 0, value: envelope.value });
  const before = history(f.store);
  for (const restarted of [false, true]) {
    if (restarted) f.restart();
    const current = new ProductEngine(f.store);
    assert.ok(!checkStoreIntegrity(f.store, b1OriginCheck('p')).findings.some(f => f.code === 'record_missing'), envelope.name);
    assert.deepEqual(current.projection('p'), native, envelope.name);
    assert.deepEqual(current.execute({ type: 'project', project: 'p' }), native, envelope.name);
    assert.deepEqual(nativeAssessFailure(current, 'p'), nativeError, envelope.name);
    assert.equal(history(f.store), before, 'Reading an ordinary envelope leaves every saved revision unchanged');
  }
}

test('G1.2 a genuine pre-B1 E1 call accepts a B1-shaped gap id without changing native projection or assess', t => {
  const project = 'alpha', block = 'block:cart', f = eraBoundaryFixture(t, project);
  const engine = new ProductEngine(f.store), native = engine.projection(project);
  const nativeError = nativeAssessFailure(engine, project);
  const adapter = f.store.write({ id: `adapter:${project}`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio', status: 'configured-not-accepted' } });
  const config = f.store.write({ id: `config:${project}`, kind: 'dispatch-config', expected: 0,
    value: { projectId: project, model: 'fixture', transport: 'stdio', status: 'configured-not-accepted' } });
  ok(openSeries(f.store, { project, block, line: 1, slice: 'slice:cart@1', predecessor: null, basis: null }));
  const goal: AttemptGoal = { key: 'gap:price', questions: ['Which operation produces the price?'], result: 'Accepted producer and contract' };
  const series = ok(beginAttempt(f.store, { project, block, line: 1, attempt: 1, goal }));
  assert.deepEqual(engine.projection(project), native, 'A native block series has no B1 requirement');
  const saved = ok(recordCall(f.store, project, { call: 'research-price', purpose: 'model-research', basis: null, block,
    gaps: [{ id: 'om-input:alpha', goal: 'Price contract', field: 'contract', consumer: block }],
    series: reference(series), attempt: 1, goal, dispatch: { adapter: reference(adapter), config: reference(config) },
    packet: { question: 'Which operation produces the price?' } }));
  assert.equal(saved.repeated, false);
  assert.equal(saved.call.value.gaps[0]!.id, 'om-input:alpha');
  assert.equal(saved.ledger.value.calls[0]!.gaps[0]!.id, 'om-input:alpha');
  const before = history(f.store);
  for (const restarted of [false, true]) {
    if (restarted) f.restart();
    const current = new ProductEngine(f.store);
    assert.deepEqual(ok(readCall(f.store, project, reference(saved.call))), saved.call, 'The normal E1 reader accepts its own saved record');
    assert.equal(f.store.get(`om-input:${project}`), null, 'The genuine E1 producer never created B1');
    assert.deepEqual(current.projection(project), native);
    assert.deepEqual(current.execute({ type: 'project', project }), native);
    assert.deepEqual(nativeAssessFailure(current, project), nativeError, 'The native assess prerequisite failure remains identical');
    assert.equal(f.store.get(`om-feasibility:${project}`), null);
    assert.equal(history(f.store), before);
  }
});

function requiresFirstB1(t: TestContext, envelope: EraBoundaryEnvelope) {
  const f = eraBoundaryFixture(t);
  f.store.write({ id: envelope.id, kind: envelope.kind, expected: 0, value: envelope.value });
  for (const [index, value] of (envelope.later ?? []).entries())
    f.store.write({ id: envelope.id, kind: envelope.kind, expected: index + 1, value });
  const retained = () => canonical(f.store.list().filter(row => row.kind !== 'om-integrity').flatMap(row => f.store.history(row.id)));
  const before = retained();
  for (const restarted of [false, true]) {
    if (restarted) f.restart();
    assertMissingB1(f.store, 'p');
    assert.equal(retained(), before, 'The report leaves the retained envelope and its history unchanged');
  }
}

test('G1.2 B1 producer address matrix rejects lost origin', async t => {
  // Independent expected addresses: these are intentionally incomplete negative envelopes, not successful producer fixtures.
  const addresses: readonly [string, string][] = [
    ['horizon:p:proof', 'horizon'], ['om-horizon:p:proof', 'om-horizon'],
    ['om-input-decision:p:proof', 'input-decision'], ['om-gap:p:proof', 'gap'], ['om-gap-lines:p:proof', 'gap-line'],
    ['om-candidate:p:proof', 'frame-candidate'], ['om-answer-task:p:proof', 'answer-task'],
    ['om-mc1-question:p:proof', 'mc1-question'], ['om-answer:p:proof', 'accepted-answer'],
    ['om-answer-index:p:proof', 'answer-index'], ['om-routes:p:proof', 'route-result'],
    ['om-owner-gap-assignment:p:proof', 'om-owner-gap-assignment'], ['om-obligation-transfer:p:proof', 'om-obligation-transfer'],
    ['om-obligation-basis:p:proof', 'om-obligation-basis'], ['om-obligations:p:proof', 'om-obligations'],
    ['om-question-packet:p:proof', 'question-packet'], ['om-part-response:p:proof', 'part-response'],
    ['om-part-result:p:proof', 'part-result'], ['om-part-assembly:p:proof', 'om-part-assembly'],
    ['om-read-delivery:p:proof', 'om-read-delivery'], ['om-read-deliveries:p:proof', 'om-read-delivery-set'],
    ['om-model-cycle:p:proof', 'om-model-cycle'], ['om-model-exchange:p:proof', 'om-model-exchange'],
    ['om-model-application-rejection:p:proof', 'om-model-application-rejection'], ['om-neighbors:p:proof', 'om-neighbors'],
    ['om-atomic-gate:p:proof', 'om-atomic-gate'], ['om-works-acceptance:p:proof', 'om-works-acceptance'],
    ['om-work-rejection:p:proof', 'om-work-rejection'], ['om-feasibility:p', 'feasibility'],
    ['om-frame:p:2', 'connection-frame'], ['om-frame:p:3', 'connection-frame'],
    ['om-proposal:p:part:proof', 'layer-proposal'], ['om-proposal:p:assembly:proof', 'layer-proposal'],
    ['repair-series:p:mechanism:1:M5:addressing', 'repair-series'],
  ];
  for (const [id, kind] of addresses) for (const actualKind of [kind, 'unrelated-boundary-kind']) {
    await t.test(`${id} / ${actualKind}`, child => requiresFirstB1(child,
      { name: id, id, kind: actualKind, value: {} }));
  }
});

test('G1.2 shared provenance matrix rejects lost origin', async t => {
  const input = { id: 'om-input:p' }, frame = { id: 'om-frame:p:3' }, candidate = { id: 'om-candidate:p:proof' };
  const horizon = { id: 'horizon:p:proof' }, packet = { id: 'om-question-packet:p:proof' };
  const mechanism = { kind: 'mechanism', mechanism: 'M5:addressing' };
  const source = { role: 'frame', ref: { id: 'graph:p', revision: 1 },
    context: { kind: 'frame', request: { horizon } } };
  const rows: EraBoundaryEnvelope[] = [
    { name: 'external proposal base.frame', id: 'om-proposal:p:external', kind: 'layer-proposal', value: { base: { frame } } },
    { name: 'external proposal verdict candidate', id: 'om-proposal:p:external', kind: 'layer-proposal', value: { verdict: { candidate } } },
    { name: 'historical proposal origin remains when its head no longer names OM', id: 'om-proposal:p:external', kind: 'layer-proposal',
      value: { verdict: { candidate } }, later: [{ status: 'proposed', base: { frame: null } }] },
    { name: 'assembly refusal request frame horizon', id: 'om-proposal:p:external', kind: 'layer-proposal', value: { verdict: { kind: 'assembly-refusal', request: { frame: { horizon } } } } },
    { name: 'block series achieved basis', id: 'repair-series:p:block:proof', kind: 'repair-series', value: { attempts: [{ outcome: { achieved: [{ key: 'result', basis: frame }] } }] } },
    { name: 'block series inputs continuation', id: 'repair-series:p:block:proof', kind: 'repair-series', value: { continuations: [{ ground: 'inputs-fixed', input }] } },
    { name: 'block series admission gaps', id: 'repair-series:p:block:proof', kind: 'repair-series', value: { admissions: [{ basis: { gaps: { records: [{ id: 'om-gap:p:proof' }] } } }] } },
    { name: 'call record admission', id: 'call-record:p:proof', kind: 'call-record', value: { admission: { gaps: { records: [{ id: 'om-gap:p:proof' }] } } } },
    { name: 'call record mechanism', id: 'call-record:p:proof', kind: 'call-record', value: { owner: mechanism } },
    { name: 'ledger call basis', id: 'om-call-ledger:p:block', kind: 'om-call-ledger', value: { calls: [{ basis: { kind: 'series-stop', series: input } }] } },
    { name: 'ledger mechanism without references', id: 'om-call-ledger:p:block', kind: 'om-call-ledger', value: { calls: [{ owner: mechanism }] } },
    { name: 'model call packet when input is null', id: 'model-call:p:om:proof', kind: 'model-call', value: { om: { input: null, request: { packet } } } },
    { name: 'model call incomplete input reference', id: 'model-call:p:om:proof', kind: 'model-call', value: { om: { input: { id: 'om-input:p', revision: 1 } } } },
    { name: 'model call transport explicit call', id: 'model-call:p:om:proof', kind: 'model-call', value: { transport: { request: { call: { id: 'om-part-result:p:proof' } } } } },
    { name: 'model call transport exchange', id: 'model-call:p:om:proof', kind: 'model-call', value: { transport: { exchange: { id: 'om-model-exchange:p:proof' } } } },
    { name: 'model transport exact call slot', id: 'om-model-transport:p:proof', kind: 'om-model-exchange', value: { request: { call: packet } } },
    { name: 'origin hold mechanism', id: 'om-origin-hold:p:proof', kind: 'om-origin-hold', value: { owner: mechanism } },
    { name: 'origin hold series', id: 'om-origin-hold:p:proof', kind: 'om-origin-hold', value: { series: { id: 'repair-series:p:mechanism:1:M5:addressing' } } },
    { name: 'owner decision mechanism', id: 'om-owner-decision:p:proof', kind: 'om-owner-decision', value: { owner: mechanism } },
    { name: 'stop review mechanism', id: 'om-stop-review:p:proof', kind: 'om-stop-review', value: { owner: mechanism } },
    { name: 'origin decision mechanism', id: 'om-origin-decision:p:proof', kind: 'om-origin-decision', value: { owner: mechanism } },
    { name: 'origin analysis basis', id: 'om-origin-analysis:p:proof', kind: 'om-origin-analysis', value: { basis: [{ role: 'frame', ref: frame }] } },
    { name: 'input fix input', id: 'om-input-fix:p:proof', kind: 'om-input-fix', value: { input } },
    { name: 'unit refusal origin context', id: 'om-unit-refusal:p:proof', kind: 'om-unit-refusal', value: { refusals: [{ origin: { sources: [source] } }] } },
    { name: 'refusal journal origin context', id: 'om-refusal-journal:p:proof', kind: 'om-refusal-journal', value: { rows: [{ origin: { sources: [source] } }] } },
    { name: 'refusal journal source', id: 'om-refusal-journal:p:proof', kind: 'om-refusal-journal', value: { rows: [{ source: input }] } },
    { name: 'refusal journal classification', id: 'om-refusal-journal:p:proof', kind: 'om-refusal-journal', value: { classifications: [{ basis: [source] }] } },
    { name: 'layer acceptance frame', id: 'graph-layer:p:3', kind: 'graph-layer', value: { acceptance: { frame } } },
    { name: 'layer inputs', id: 'graph-layer:p:3', kind: 'graph-layer', value: { inputs: [input] } },
    { name: 'layer obligations', id: 'graph-layer:p:3', kind: 'graph-layer', value: { obligations: [{ inputs: [{ id: 'om-obligation-basis:p:proof' }] }] } },
    { name: 'layer proofs', id: 'graph-layer:p:3', kind: 'graph-layer', value: { layerProofs: [{ inputs: [candidate] }] } },
    { name: 'discovery input basis', id: 'discovery:p:proof', kind: 'discovery-draft', value: { inputs: [input] } },
    { name: 'graph obligation scope', id: 'graph:p', kind: 'graph', value: { researchObligations: [{ scope: { id: 'om-obligations:p:proof' } }] } },
    { name: 'om-g2 stage feasibility', id: 'stage:p:om-g2', kind: 'stage', value: { content: { feasibility: { id: 'om-feasibility:p' } } } },
    { name: 'stage inputs', id: 'stage:p:features', kind: 'stage', value: { inputs: [input] } },
    { name: 'stage proofs', id: 'stage:p:features', kind: 'stage', value: { proofs: [frame] } },
    { name: 'plan feasibility', id: 'plan:p:proof', kind: 'plan', value: { feasibility: { id: 'om-feasibility:p' } } },
    { name: 'plan guards', id: 'plan:p:proof', kind: 'plan', value: { guards: [input] } },
    { name: 'plan task obligation scope', id: 'plan:p:proof', kind: 'plan', value: { tasks: [{ researchObligations: [{ requirement: { scope: { id: 'om-obligations:p:proof' } } }] }] } },
    { name: 'runtime observation scope', id: `runtime-observation:${hashJson(['p', 'proof'])}`, kind: 'runtime-observation', value: { projectId: 'p', scope: { id: 'om-obligations:p:proof' } } },
    { name: 'runtime observation context', id: `runtime-observation:${hashJson(['p', 'proof'])}`, kind: 'runtime-observation', value: { projectId: 'p', context: [input] } },
    { name: 'writer index OM contract', id: `writer-index:${hashJson({ project: 'p', path: 'src/work.ts' })}`, kind: 'writer-index', value: { project: 'p', path: 'src/work.ts', contract: 'writer-index/om-m8-v1' } },
  ];
  for (const row of rows) await t.test(row.name, child => requiresFirstB1(child, row));
});

test('G1.2 pre-B1 ordinary content and foreign project provenance do not select the OM era', async t => {
  const arbitrary = { nested: [{ id: 'om-input:p' }] };
  const ordinary: EraBoundaryEnvelope[] = [
    { name: 'undeclared OM namespace does not infer a producer from content', id: 'om-unknown:p:proof', kind: 'om-unknown',
      value: { input: { id: 'om-input:p' }, owner: { kind: 'mechanism', mechanism: 'M5:addressing' } } },
    ...[
      ['om-proposal:p:external', 'layer-proposal'], ['repair-series:p:block:proof', 'repair-series'],
      ['call-record:p:proof', 'call-record'], ['om-call-ledger:p:proof', 'om-call-ledger'],
      ['om-origin-hold:p:proof', 'om-origin-hold'], ['om-origin-analysis:p:proof', 'om-origin-analysis'],
      ['om-owner-decision:p:proof', 'om-owner-decision'], ['om-stop-review:p:proof', 'om-stop-review'],
      ['om-origin-decision:p:proof', 'om-origin-decision'], ['om-input-fix:p:proof', 'om-input-fix'],
      ['om-unit-refusal:p:proof', 'om-unit-refusal'], ['om-refusal-journal:p:proof', 'om-refusal-journal'],
      ['model-call:p:om:proof', 'model-call'], ['om-model-transport:p:proof', 'om-model-exchange'],
    ].map(([id, kind]) => ({ name: `${id} ordinary content/decided/raw`, id: id!, kind: kind!,
      value: { content: arbitrary, decided: arbitrary, raw: arbitrary, text: 'om-input:p is ordinary text' } })),
    { name: 'journal ordinary row text', id: 'om-refusal-journal:p:proof', kind: 'om-refusal-journal', value: { rows: [{ text: 'om-input:p', content: arbitrary, raw: arbitrary }] } },
    { name: 'transport analysis packet JSON', id: 'model-call:p:om:proof', kind: 'model-call', value: { transport: { exchange: null, request: { call: { id: 'call-record:p:proof' }, packet: arbitrary } } } },
    { name: 'transport exchange analysis packet JSON', id: 'om-model-transport:p:proof', kind: 'om-model-exchange', value: { request: { call: { id: 'call-record:p:proof' }, packet: arbitrary } } },
    { name: 'legacy writer index contract', id: `writer-index:${hashJson({ project: 'p', path: 'src/work.ts' })}`, kind: 'writer-index', value: { project: 'p', path: 'src/work.ts', contract: 'writer-index/v1' } },
    { name: 'foreign fixed address', id: 'om-part-result:other:proof', kind: 'part-result', value: {} },
    { name: 'foreign shared project', id: 'om-proposal:other:external', kind: 'layer-proposal', value: { base: { frame: { id: 'om-frame:p:3' } } } },
    { name: 'foreign observation project', id: `runtime-observation:${hashJson(['other', 'proof'])}`, kind: 'runtime-observation', value: { projectId: 'other', scope: { id: 'om-obligations:p:proof' } } },
    { name: 'foreign writer index project', id: `writer-index:${hashJson({ project: 'other', path: 'src/work.ts' })}`, kind: 'writer-index', value: { project: 'other', path: 'src/work.ts', contract: 'writer-index/om-m8-v1' } },
  ];
  for (const row of ordinary) await t.test(row.name, child => retainsNativeEra(child, row));
});

test('G1.2 shared envelopes distinguish subject ids and unknown nested data from declared provenance', async t => {
  const id = 'om-input:p', subject = { id }, arbitrary = { nested: [subject] };
  const nativeRef = { id: 'stage:p:idea', revision: 1, hash: '0'.repeat(64), metadata: arbitrary };
  const source = { role: 'frame', ref: nativeRef, context: { kind: 'frame', request: { graph: nativeRef, metadata: arbitrary } }, metadata: arbitrary };
  // These structural boundary cases intentionally omit unrelated required producer fields. The real E1 test above
  // separately proves that a fully admitted producer can persist a subject id matching the first B1 address.
  const ordinary: EraBoundaryEnvelope[] = [
    { name: 'proposal subject ids in contents', id: 'om-proposal:p:external', kind: 'layer-proposal',
      value: { nodes: [subject], artifacts: [subject], contracts: [subject], tests: [subject], base: { graph: nativeRef, frame: null } } },
    { name: 'proposal base unknown datum', id: 'om-proposal:p:external', kind: 'layer-proposal', value: { base: { graph: nativeRef, frame: null, metadata: arbitrary } } },
    { name: 'proposal verdict refusal and finding subject ids', id: 'om-proposal:p:external', kind: 'layer-proposal',
      value: { verdict: { kind: 'assembly-refusal', refusal: { at: subject, findings: [subject] }, metadata: arbitrary } } },
    { name: 'series attempt goal datum id', id: 'repair-series:p:block:proof', kind: 'repair-series', value: { attempts: [{ goal: { key: id, questions: [id], result: id, metadata: arbitrary } }] } },
    { name: 'series outcome subject ids and arbitrary data', id: 'repair-series:p:block:proof', kind: 'repair-series',
      value: { attempts: [{ outcome: { achieved: [{ key: id, basis: nativeRef, metadata: arbitrary }], cancelled: [id], refusals: [{ row: id, metadata: arbitrary }], metadata: arbitrary } }] } },
    { name: 'series inherited attempt goal datum id', id: 'repair-series:p:block:proof', kind: 'repair-series', value: { inherited: [{ goal: { metadata: arbitrary }, outcome: { metadata: arbitrary } }] } },
    { name: 'series admission scope arbitrary data', id: 'repair-series:p:block:proof', kind: 'repair-series', value: { scope: { metadata: arbitrary }, admissions: [{ basis: { gaps: { metadata: arbitrary }, metadata: arbitrary } }] } },
    { name: 'series continuation and escalation arbitrary data', id: 'repair-series:p:block:proof', kind: 'repair-series',
      value: { continuations: [{ ground: 'review-record', review: nativeRef, metadata: arbitrary }], escalations: [{ review: nativeRef, metadata: arbitrary }] } },
    { name: 'call record goal datum id', id: 'call-record:p:proof', kind: 'call-record', value: { goal: { key: id, metadata: arbitrary } } },
    { name: 'call record basis and admission arbitrary data', id: 'call-record:p:proof', kind: 'call-record',
      value: { series: nativeRef, basis: { kind: 'series-stop', series: nativeRef, metadata: arbitrary }, admission: { gaps: { metadata: arbitrary }, metadata: arbitrary }, dispatch: { adapter: nativeRef, config: nativeRef, metadata: arbitrary } } },
    { name: 'ledger gap subject id', id: 'om-call-ledger:p:proof', kind: 'om-call-ledger', value: { calls: [{ gaps: [{ id, goal: 'Question', field: 'contract', consumer: 'block:cart' }] }] } },
    { name: 'ledger goal and entry subject ids', id: 'om-call-ledger:p:proof', kind: 'om-call-ledger',
      value: { calls: [{ id, goal: { metadata: arbitrary }, call: nativeRef, series: nativeRef, basis: { kind: 'origin-hold', hold: nativeRef, metadata: arbitrary }, metadata: arbitrary }] } },
    { name: 'origin hold lift unknown nested data', id: 'om-origin-hold:p:proof', kind: 'om-origin-hold', value: { series: nativeRef, lift: { record: nativeRef, basis: [source], metadata: arbitrary } } },
    { name: 'origin analysis source context unknown nested data', id: 'om-origin-analysis:p:proof', kind: 'om-origin-analysis', value: { basis: [source] } },
    { name: 'input fix reference extra data and undeclared owner', id: 'om-input-fix:p:proof', kind: 'om-input-fix', value: { input: nativeRef, owner: { kind: 'mechanism', mechanism: 'M5:addressing' } } },
    { name: 'unit refusal source context unknown request data', id: 'om-unit-refusal:p:proof', kind: 'om-unit-refusal', value: { refusals: [{ origin: { sources: [source] } }] } },
    { name: 'unit refusal unknown source context variant', id: 'om-unit-refusal:p:proof', kind: 'om-unit-refusal', value: { refusals: [{ origin: { sources: [{ ref: nativeRef, context: { kind: 'ordinary', request: { horizon: subject } } }] } }] } },
    { name: 'journal source reference extra data', id: 'om-refusal-journal:p:proof', kind: 'om-refusal-journal', value: { rows: [{ id, source: nativeRef, origin: { sources: [source] } }] } },
    { name: 'journal classification subject and source context data', id: 'om-refusal-journal:p:proof', kind: 'om-refusal-journal', value: { classifications: [{ id, row: id, basis: [source], metadata: arbitrary }] } },
    { name: 'model call request and reference extra data', id: 'model-call:p:om:proof', kind: 'model-call', value: { om: { input: nativeRef, request: { packet: nativeRef, metadata: arbitrary } }, transport: { exchange: nativeRef, request: { call: nativeRef, packet: arbitrary } } } },
    { name: 'model transport call extra data', id: 'om-model-transport:p:proof', kind: 'om-model-exchange', value: { call: nativeRef, request: { call: nativeRef, packet: arbitrary } } },
    { name: 'layer acceptance and proof subject ids', id: 'graph-layer:p:proof', kind: 'graph-layer', value: { acceptance: { frame: nativeRef, metadata: arbitrary }, inputs: [nativeRef], obligations: [{ id, inputs: [nativeRef] }], layerProofs: [{ id, inputs: [nativeRef] }] } },
    { name: 'graph obligation binding subject id', id: 'graph:p:proof', kind: 'graph', value: { researchObligations: [{ id, scope: nativeRef, obligation: id, consumers: [{ node: id, tests: [id] }] }] } },
    { name: 'discovery input and derivation source extra data', id: 'discovery:p:proof', kind: 'discovery-draft', value: { inputs: [nativeRef], derivations: [{ source: nativeRef, metadata: arbitrary }] } },
    { name: 'stage input and proof extra data', id: 'stage:p:proof', kind: 'stage', value: { inputs: [nativeRef], proofs: [nativeRef], content: arbitrary } },
    { name: 'plan obligation and task subject ids', id: 'plan:p:proof', kind: 'plan', value: { feasibility: nativeRef, guards: [nativeRef], tasks: [{ id, researchObligations: [{ binding: id, requirement: { id, scope: nativeRef, metadata: arbitrary } }], inputs: [{ source: nativeRef, metadata: arbitrary }] }] } },
    { name: 'runtime context reference extra data', id: `runtime-observation:${hashJson(['p', 'proof'])}`, kind: 'runtime-observation', value: { projectId: 'p', scope: nativeRef, context: [nativeRef], check: { script: nativeRef, dependencies: [nativeRef], metadata: arbitrary } } },
  ];
  for (const row of ordinary) await t.test(row.name, child => retainsNativeEra(child, row));
});

test('G1.2 declared nested provenance detects B1 even when its reference has no hash', async t => {
  const input = { id: 'om-input:p', revision: 1 };
  const source = { role: 'frame', ref: { id: 'graph:p', revision: 1 }, context: { kind: 'proposal', request: { frame: { upper: { horizon: input } } } } };
  const rows: EraBoundaryEnvelope[] = [
    { name: 'ledger exact call', id: 'om-call-ledger:p:proof', kind: 'om-call-ledger', value: { calls: [{ call: input }] } },
    { name: 'ledger exact series', id: 'om-call-ledger:p:proof', kind: 'om-call-ledger', value: { calls: [{ series: input }] } },
    { name: 'ledger mechanism admission routes', id: 'om-call-ledger:p:proof', kind: 'om-call-ledger', value: { calls: [{ admission: { routes: input } }] } },
    { name: 'series inherited achievement basis', id: 'repair-series:p:block:proof', kind: 'repair-series', value: { inherited: [{ outcome: { achieved: [{ basis: input }] } }] } },
    { name: 'call dispatch adapter', id: 'call-record:p:proof', kind: 'call-record', value: { dispatch: { adapter: input } } },
    { name: 'call dispatch config', id: 'call-record:p:proof', kind: 'call-record', value: { dispatch: { config: input } } },
    { name: 'origin hold lift basis source', id: 'om-origin-hold:p:proof', kind: 'om-origin-hold', value: { lift: { basis: [source] } } },
    { name: 'unit refusal proposal source upper horizon', id: 'om-unit-refusal:p:proof', kind: 'om-unit-refusal', value: { refusals: [{ origin: { sources: [source] } }] } },
    { name: 'journal classification basis source reference', id: 'om-refusal-journal:p:proof', kind: 'om-refusal-journal', value: { classifications: [{ basis: [{ ref: input }] }] } },
    ...['request', 'response'].map(field => ({ name: `model call ${field} record`, id: 'model-call:p:om:proof', kind: 'model-call', value: { [field]: { record: input } } })),
    ...['recovery', 'profile'].map(field => ({ name: `model call ${field}`, id: 'model-call:p:om:proof', kind: 'model-call', value: { [field]: input } })),
    ...[['packet', 'archive'], ['budget', 'segment'], ['runtime', 'declaration']].map(([field, slot]) => ({ name: `model call ${field}.${slot}`, id: 'model-call:p:om:proof', kind: 'model-call', value: { [field!]: { [slot!]: input } } })),
    { name: 'model call OM request dispatch config', id: 'model-call:p:om:proof', kind: 'model-call', value: { om: { request: { dispatch: { config: input } } } } },
    { name: 'transport direct call', id: 'om-model-transport:p:proof', kind: 'om-model-exchange', value: { call: input } },
    { name: 'discovery derivation source', id: 'discovery:p:proof', kind: 'discovery-draft', value: { derivations: [{ source: input }] } },
    { name: 'layer projection obligation scope', id: 'graph-layer:p:3', kind: 'graph-layer', value: { projection: { researchObligations: [{ scope: input }] } } },
    ...['graph', 'environment', 'stage'].map(field => ({ name: `plan ${field}`, id: 'plan:p:proof', kind: 'plan', value: { [field]: input } })),
    ...['receipt', 'source'].map(field => ({ name: `plan task input ${field}`, id: 'plan:p:proof', kind: 'plan', value: { tasks: [{ inputs: [{ [field]: input }] }] } })),
    { name: 'plan ownership receipt', id: 'plan:p:proof', kind: 'plan', value: { tasks: [{ ownership: [{ receipt: input }] }] } },
    { name: 'plan graph snapshot obligation scope', id: 'plan:p:proof', kind: 'plan', value: { graphSnapshot: { researchObligations: [{ scope: input }] } } },
    { name: 'runtime environment', id: `runtime-observation:${hashJson(['p', 'proof'])}`, kind: 'runtime-observation', value: { projectId: 'p', environment: input } },
    { name: 'runtime check script', id: `runtime-observation:${hashJson(['p', 'proof'])}`, kind: 'runtime-observation', value: { projectId: 'p', check: { script: input } } },
    { name: 'runtime check dependencies', id: `runtime-observation:${hashJson(['p', 'proof'])}`, kind: 'runtime-observation', value: { projectId: 'p', check: { dependencies: [input] } } },
  ];
  for (const row of rows) await t.test(row.name, child => requiresFirstB1(child, row));
});

import { discoveryOutcome } from '../src/discovery/discovery-outcome.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { preparedField } from './preparation-fixture.js';
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { PHASES } from "../src/graph/refinement.js";
import { STAGES, reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { beginLegacyOperation, finishLegacyOperation, readLegacyOperation as productRead, type LegacyOperation } from "../src/product/preparation-run.js";
import { readLegacyOperation as lowerRead, StageChecks } from "../src/product/stage-checks.js";
import { processStart } from "../src/runtime/process-identity.js";
import { Store, observeStore, type Revision, type StoreObserver, type TransactionGuard, type Write } from "../src/storage/store.js";
import { captureView, storeView } from "../src/storage/store-view.js";
import { writeFeasibility, type FeasibilityRequest } from "../src/om/feasibility.js";
import { preparedFeatures, refinedLayers, answerDiscoveryFixture } from "./product-fixture.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const project = "p";

/** A legacy project with its accepted R3 stage, compiled by nobody yet: the base both kits start from. */
function legacyBase(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "omg-r2-stage-checks-")), workspace = join(directory, "repo");
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]);
  writeFileSync(join(workspace, "README.md"), "R2 stage checks fixture\n");
  git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(join(directory, "state.sqlite")), engine = new ProductEngine(store);
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  preparedFeatures(engine, project);
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure(project, { workspace, implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000 }, 0);
  refinedLayers(engine, project);
  const feasibility = engine.refinement.assess(project, 0);
  const stage = engine.refinement.publish(project, reference(feasibility), 0);
  engine.pipeline.accept(project, "om-g2", stage.revision);
  return { directory, store };
}
/** An identical copy of the committed state of a Store, as a separate file. */
function twin(source: Store, directory: string, name: string): Store {
  const target = join(directory, name), database = new DatabaseSync(source.path);
  try { database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); } finally { database.close(); }
  return new Store(target);
}
const heads = (store: Store) => store.list().map(row => canonical([row.id, row.kind, row.revision, row.hash])).sort();
const history = (store: Store) => store.list().reduce((sum, row) => sum + row.revision, 0);
/** Every write attempt of an action with its guards, through the prototype so the Store stays genuine. */
function writesOf<T>(action: () => T): { value: T | EngineError; writes: string[] } {
  const original = Store.prototype.writeMany, writes: string[] = [];
  Store.prototype.writeMany = function (this: Store, inputs: Write[], guards: TransactionGuard[] = []) {
    writes.push(canonical([inputs.map(input => [input.id, input.kind, input.expected]), guards] as never));
    return original.call(this, inputs, guards);
  } as typeof original;
  try { return { value: action(), writes }; }
  catch (error) { if (error instanceof EngineError) return { value: error, writes }; throw error; }
  finally { Store.prototype.writeMany = original; }
}
const outcome = (value: unknown) => value instanceof EngineError ? { code: value.code, details: value.details } : value;
const same = (left: () => unknown, right: () => unknown) => {
  const read = (action: () => unknown) => { try { return action(); } catch (error) { return outcome(error); } };
  assert.deepEqual(read(left), read(right));
};

test("R2 №2419-4 rows 1–2: the lower kit inspects every stage and gates every layer and phase exactly as ProductEngine — states, findings, guards, admissionGuards — writing nothing; an absent project and a stale basis give the same answer", t => {
  const { directory, store } = legacyBase(t);
  const second = new Store(store.path); t.after(() => second.close());
  const compare = () => {
    const checks = new StageChecks(store), engine = new ProductEngine(store);
    for (const stage of STAGES) same(() => checks.pipeline.inspect(project, stage), () => engine.pipeline.inspect(project, stage));
    for (const level of [1, 2, 3] as const) same(() => checks.graphs.layerGate(project, level), () => engine.graphs.layerGate(project, level));
    for (const phase of PHASES) same(() => checks.refinement.gate(project, phase), () => engine.refinement.gate(project, phase));
    same(() => checks.pipeline.inspect("absent", "features"), () => engine.pipeline.inspect("absent", "features"));
    same(() => checks.omProject(project), () => (engine.legacyRoute(project)).om);
  };
  const before = heads(store);
  compare();
  const accepted = new StageChecks(store).pipeline.inspect(project, "om-g2");
  assert.equal(accepted.state, "accepted");
  assert.ok((accepted.admissionGuards ?? []).length > 0, "The accepted stage carries its admission guards");
  // The basis moves through a second Store: both kits now see the same stale result.
  const environment = second.get(`environment:${project}`)!;
  second.write({ id: environment.id, kind: environment.kind, expected: environment.revision, value: { ...environment.value as object, timeoutMs: 20_000 } });
  const stale = new StageChecks(store).pipeline.inspect(project, "om-g2");
  assert.notDeepEqual(stale, accepted, "The moved environment is seen");
  compare();
  assert.deepEqual(heads(store).filter(row => !row.includes(`environment:${project}`)), before.filter(row => !row.includes(`environment:${project}`)),
    "Inspection and gates write nothing");
  void directory;
});

test("R2 №2419-4 rows 3–4 (legacy): compile by the lower kit equals ProductEngine.compile — the same plan, pointer and stages with the same guards on every write, the absent first B1 among them; after a restart the repeat writes nothing", t => {
  const { directory, store } = legacyBase(t);
  const left = twin(store, directory, "engine.sqlite"), right = twin(store, directory, "checks.sqlite");
  t.after(() => { left.close(); right.close(); });
  const viaEngine = writesOf(() => new ProductEngine(left).compile(project));
  const viaChecks = writesOf(() => new StageChecks(right).compile(project));
  assert.ok(!(viaChecks.value instanceof EngineError), JSON.stringify(outcome(viaChecks.value)));
  assert.deepEqual(viaChecks.writes, viaEngine.writes, "The same writes with the same guards, in order");
  assert.ok(viaChecks.writes.every(write => write.includes(`"id":"om-input:${project}","absent":true`) || write.includes(`{"absent":true,"id":"om-input:${project}"}`)),
    "Every legacy production write guards the absent first B1");
  assert.deepEqual(viaChecks.value, viaEngine.value);
  assert.deepEqual(heads(right), heads(left), "The same plan, current-plan pointer and stages");
  assert.equal(right.get(`stage:${project}:compilation`)!.value && (right.get(`stage:${project}:compilation`)!.value as { status: string }).status, "accepted");
  const path = right.path; right.close();
  const reopened = new Store(path);
  try {
    const before = history(reopened);
    const repeat = writesOf(() => new StageChecks(reopened).compile(project));
    assert.deepEqual(repeat.value, viaChecks.value, "The repeat answers the saved plan");
    assert.deepEqual(repeat.writes, [], "and writes nothing");
    assert.equal(history(reopened), before);
  } finally { reopened.close(); }
});

interface M8Fixture { readonly store: Store; readonly project: string; readonly feasibility: FeasibilityRequest; restart(): void }
let m8Fixtures: Promise<{ acceptedWorksFixture(t: TestContext): M8Fixture }> | undefined;
/** The real M8 producer fixture of om-feasibility.test.js, loaded as its route-closure neighbour does. */
function m8Fixture(t: TestContext): Promise<M8Fixture> {
  m8Fixtures ??= (async () => {
    const url = new URL("./om-feasibility.test.js", import.meta.url), source = readFileSync(url, "utf8");
    const boundary = source.indexOf("const heads =");
    assert.ok(boundary > 0, "The real M8 fixture precedes its test registrations");
    const prefix = source.slice(0, boundary).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix));
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedWorksFixture };`).toString("base64")}`);
  })();
  return m8Fixtures.then(fixtures => fixtures.acceptedWorksFixture(t));
}

test("R2 №2419-4 rows 3–4 (OM): compile of an M8 project by the lower kit equals ProductEngine.compile — the exact accepted OM stage guards it, no absent-B1 guard — and repeats without writes after a restart", async t => {
  const f = await m8Fixture(t), om = f.project;
  const saved = writeFeasibility(f.store, f.feasibility);
  if (!saved.ok) assert.fail(`${saved.refusal.code}: ${saved.refusal.message}`);
  const engine = new ProductEngine(f.store);
  const stage = engine.execute({ type: "draft-om", project: om, feasibility: reference(saved.value), expected: 0 }) as Revision<unknown>;
  engine.execute({ type: "accept-stage", project: om, stage: "om-g2", expected: stage.revision });
  const directory = mkdtempSync(join(tmpdir(), "omg-r2-om-twins-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const left = twin(f.store, directory, "engine.sqlite"), right = twin(f.store, directory, "checks.sqlite");
  t.after(() => { left.close(); right.close(); });
  const accepted = reference(right.get(`stage:${om}:om-g2`)!);
  const viaEngine = writesOf(() => new ProductEngine(left).compile(om));
  const viaChecks = writesOf(() => new StageChecks(right).compile(om));
  assert.ok(!(viaChecks.value instanceof EngineError), JSON.stringify(outcome(viaChecks.value)));
  assert.deepEqual(viaChecks.writes, viaEngine.writes);
  assert.deepEqual(viaChecks.value, viaEngine.value);
  assert.deepEqual(heads(right), heads(left));
  assert.ok(viaChecks.writes.length > 0 && viaChecks.writes.every(write => write.includes(canonical(accepted as never)) && !write.includes('"absent":true,"id":"om-input:')),
    "The exact accepted OM stage guards every write; the closed legacy absence never does");
  assert.deepEqual((viaChecks.value as { value: { feasibility: Ref } }).value.feasibility, reference(saved.value));
  const path = right.path; right.close();
  const reopened = new Store(path);
  try {
    const before = history(reopened);
    const repeat = writesOf(() => new StageChecks(reopened).compile(om));
    assert.deepEqual([repeat.value, repeat.writes, history(reopened)], [viaChecks.value, [], before]);
  } finally { reopened.close(); }
});

test("R2 №2419-4 row 5 and №2419-5: a first B1 created by a second Store between preparation and write is the product's addressed input_stale, and a refusing write facade publishes nothing — the same through the lower kit and ProductEngine", t => {
  const { directory, store } = legacyBase(t);
  for (const [name, kit] of [["engine", (s: Store) => new ProductEngine(s).compile(project)], ["checks", (s: Store) => new StageChecks(s).compile(project)]] as const) {
    const copy = twin(store, directory, `${name}-race.sqlite`), second = new Store(copy.path);
    try {
      const before = heads(copy);
      // The facade lets the second Store create the first B1 just before the first guarded write reaches the Store.
      let raced = false;
      const racing = storeView(copy, { write: (writes, guards) => {
        if (!raced) { raced = true; second.write({ id: `om-input:${project}`, kind: "om-input", expected: 0, value: { raced: true } }); }
        return copy.writeMany(writes, guards);
      } });
      const error = (() => { try { kit(racing); return null; } catch (caught) { return caught; } })();
      assert.ok(error instanceof EngineError && error.code === "input_stale", `${name}: ${String(error)}`);
      assert.deepEqual(error.details, { unit: "product", target: `om-input:${project}` }, `${name}: the product's own address`);
      assert.deepEqual(heads(copy).filter(row => !row.includes(`om-input:${project}`)), before, `${name}: nothing else was written`);
    } finally { second.close(); copy.close(); }
    const refused = twin(store, directory, `${name}-refused.sqlite`);
    try {
      const before = heads(refused);
      const facade = storeView(refused, { write: () => { throw new EngineError("policy_refused", "This view never writes"); } });
      assert.throws(() => kit(facade), (error: unknown) => error instanceof EngineError && error.code === "policy_refused", name);
      assert.deepEqual(heads(refused), before, `${name}: the refused facade published nothing`);
    } finally { refused.close(); }
  }
});

test("R2 №2419-5: a compile produced by the code of base 4c2d5b3 in its own process is read by the lower kit as by ProductEngine, and its repeat after a restart writes nothing", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-r2-base-compile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const run = (executable: string, args: string[], cwd: string) => {
    const child = spawnSync(executable, args, { cwd, env: environment, encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
    assert.equal(child.status, 0, `${executable} ${args.join(" ")}\n${child.stdout}\n${child.stderr}`);
    return child.stdout;
  };
  const repository = run("git", ["rev-parse", "--show-toplevel"], dirname(fileURLToPath(import.meta.url))).trim();
  const base = join(root, "base"), archive = join(root, "base.tar");
  mkdirSync(base);
  run("git", ["archive", "--format=tar", "--output", archive, "4c2d5b3"], repository);
  run("tar", ["-xf", archive, "-C", base], root);
  symlinkSync(join(repository, "node_modules"), join(base, "node_modules"), "dir");
  writeFileSync(join(base, "tsconfig.r2-history.json"), JSON.stringify({ extends: "./tsconfig.json", include: ["src/**/*.ts", "test/product-fixture.ts"], exclude: [] }));
  run(process.execPath, [join(base, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.r2-history.json"], base);
  const workspace = join(root, "repo"); mkdirSync(workspace); git(workspace, ["init", "-b", "main"]);
  writeFileSync(join(workspace, "README.md"), "R2 base compile\n"); git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
  const database = join(root, "base.sqlite"), producer = join(base, "r2-base-producer.mjs");
  writeFileSync(producer, `
import { writeFileSync } from 'node:fs';
import { Store } from './dist/src/storage/store.js';
import { ProductEngine } from './dist/src/product/engine.js';
import { reference } from './dist/src/pipeline/contracts.js';
import { preparedFeatures, refinedLayers } from './dist/test/product-fixture.js';
const [database, workspace, output] = process.argv.slice(2), project = 'p';
const store = new Store(database), engine = new ProductEngine(store);
preparedFeatures(engine, project);
const command = { executable: process.execPath, args: ['--version'] };
engine.environments.configure(project, { workspace, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
  reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 10000 }, 0);
refinedLayers(engine, project);
const feasibility = engine.refinement.assess(project, 0);
const stage = engine.refinement.publish(project, reference(feasibility), 0); engine.pipeline.accept(project, 'om-g2', stage.revision);
const plan = engine.compile(project);
writeFileSync(output, JSON.stringify({ plan, compilation: engine.pipeline.inspect(project, 'compilation') }));
store.close();
`);
  const output = join(root, "base.json");
  run(process.execPath, [producer, database, workspace, output], base);
  const produced = JSON.parse(readFileSync(output, "utf8")) as { plan: unknown; compilation: unknown };
  const store = new Store(database);
  try {
    const before = history(store);
    assert.deepEqual(new StageChecks(store).pipeline.inspect(project, "compilation"), new ProductEngine(store).pipeline.inspect(project, "compilation"));
    assert.deepEqual(JSON.parse(JSON.stringify(new StageChecks(store).pipeline.inspect(project, "compilation"))), produced.compilation,
      "Today's kit reads the base's compilation stage as the base did");
    const repeat = writesOf(() => new StageChecks(store).compile(project));
    assert.deepEqual([JSON.parse(JSON.stringify(repeat.value)), repeat.writes, history(store)], [produced.plan, [], before]);
  } finally { store.close(); }
});

test("R2 №2427-4: the old export and the new lower entry read one lawful active and released legacy-operation chain alike after a restart, and refuse alike when its required basis is damaged", t => {
  const { store } = legacyBase(t);
  const pending = () => {
    const prior = store.get(`preparation-run:${project}`), value = { projectId: project, status: "running", phase: "R2", draft: null, plan: null,
      owner: { pid: process.pid, started: processStart(process.pid) }, error: null, code: null, findings: [], calls: 0 };
    const write: Write = { id: `preparation-run:${project}`, kind: "preparation-run", expected: prior?.revision ?? 0, value };
    return { write, basis: { id: write.id, revision: write.expected + 1, hash: hashJson(value) } as Ref };
  };
  const first = pending();
  const active = beginLegacyOperation(store, project, "prepare", first.basis, [first.write]);
  const reads = (s: Store) => { const read = (reader: typeof lowerRead) => { try { return reader(s, project); } catch (error) { return outcome(error); } }; return [read(productRead), read(lowerRead)]; };
  const [activeOld, activeNew] = reads(store);
  assert.deepEqual(activeNew, activeOld); assert.equal((activeNew as Revision<LegacyOperation>).value.state, "active");
  const run = store.get<Record<string, unknown>>(`preparation-run:${project}`)!;
  const paused = store.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, status: "paused", error: "Fixture pause", code: "fixture_pause" } });
  finishLegacyOperation(store, active, reference(paused));
  const path = store.path; store.close();
  const reopened = new Store(path);
  try {
    const [releasedOld, releasedNew] = reads(reopened);
    assert.deepEqual(releasedNew, releasedOld); assert.equal((releasedNew as Revision<LegacyOperation>).value.state, "released");
  } finally { reopened.close(); }
  // Damage the exact required basis — the bytes of the running preparation the lease names — beneath both readers.
  const database = new DatabaseSync(path);
  try {
    database.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    database.prepare("UPDATE revisions SET body=? WHERE entity_id=? AND revision=?").run("{}", first.basis.id, first.basis.revision);
  }
  finally { database.close(); }
  const damaged = new Store(path);
  try {
    const [oldRefusal, newRefusal] = reads(damaged);
    assert.deepEqual(newRefusal, oldRefusal);
    assert.ok(!(newRefusal as { value?: unknown }).value, `A damaged basis is refused alike: ${JSON.stringify(newRefusal)}`);
  } finally { damaged.close(); }
});

test("Q4 №2563-3: on a proven Store omProject picks era candidates by indexed prefix identities — a foreign namespace is never listed or decoded, a corrupt non-candidate stays unread; an opaque view keeps the conservative full walk", t => {
  const directory = mkdtempSync(join(tmpdir(), "omg-q4-era-")), store = new Store(join(directory, "state.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const era = "era44";
  const recordMissing = (error: unknown) => error instanceof EngineError && error.code === "record_missing";
  // Foreign neighbors a whole-Store walk would meet: a candidate namespace of another project, an unknown
  // namespace, and a shared namespace whose body names a foreign project.
  store.write({ id: "repair-series:other:m1", kind: "repair-series", expected: 0, value: { contract: "om-repair-series/v2" } });
  store.write({ id: "foreign-ns:z", kind: "foreign", expected: 0, value: { v: 1 } });
  store.write({ id: "writer-index:other", kind: "writer-index", expected: 0, value: { project: "other", contract: "writer-index/om-m8-v1" } });
  const reads: [string, string, string | null][] = [];
  const watcher: StoreObserver = { begin: () => ({}), write: () => {}, untraced: () => {},
    end: (_token, _source, method, mode, id) => { reads.push([method, mode, id ?? null]); } };
  const previous = observeStore(watcher);
  try {
    assert.equal(new StageChecks(store).omProject(era), false, "No provenance marker of this project exists");
    assert.ok(reads.some(row => row[0] === "identities" && row[1] === "prefix"), "Candidates are selected by indexed prefix identities");
    assert.ok(!reads.some(row => row[0] === "list"), "No body list over the Store");
    assert.ok(!reads.some(row => row[0] === "identities" && row[1] === "list"), "No identity enumeration of the whole Store");
    assert.ok(!reads.some(row => row[0] === "get" && (row[2] === "repair-series:other:m1" || row[2] === "foreign-ns:z")),
      "A foreign project's candidate-namespace row and an unknown namespace are never decoded");
    assert.ok(reads.some(row => row[0] === "get" && row[2] === "writer-index:other"),
      "A shared namespace whose owner lives in the body is still read as a candidate — and rejected by the predicate");
    // Positive control: a lawful marker of THIS project is found by the same prefix selection and still refuses.
    store.write({ id: "writer-index:ours", kind: "writer-index", expected: 0, value: { project: era, contract: "writer-index/om-m8-v1" } });
    assert.throws(() => new StageChecks(store).omProject(era), recordMissing, "A saved B1 origin still demands the exact first B1");
    // F3 (№2568-1): a bare namespace address — no colon at all — is still a candidate whose body owns the project;
    // the era search must reach it and keep the previous record_missing refusal.
    store.write({ id: "writer-index", kind: "probe", expected: 0, value: { project: era, contract: "writer-index/om-m8-v1" } });
    assert.throws(() => new StageChecks(store).omProject(era), recordMissing,
      "A bare 'writer-index' record whose body names the project is an era marker without an address shape");
    try { new StageChecks(store).omProject(era); assert.fail('the bare marker must refuse'); }
    catch (error) {
      assert.ok(error instanceof EngineError);
      assert.deepEqual(error.details, { unit: "product", target: `om-input:${era}`, field: "revision" },
        "The refusal is the same first-B1 address as before the era search existed");
    }
    // An opaque view keeps the conservative complete read traversal — a capture Proxy proves nothing.
    reads.length = 0;
    const opaque = captureView(store, { rows: new Map() }).view;
    assert.throws(() => new StageChecks(opaque).omProject(era), recordMissing, "The view sees the same marker through its own walk");
    assert.ok(reads.some(row => row[0] === "list"), "An opaque view keeps its own complete read traversal");
    assert.ok(!reads.some(row => row[0] === "identities"), "The optimized identity selection never runs under an unproven view");
    // A corrupt row outside every candidate prefix never reaches a decoder.
    const database = new DatabaseSync(store.path);
    try {
      database.exec("DROP TRIGGER IF EXISTS revisions_no_update");
      database.prepare("UPDATE revisions SET body=? WHERE entity_id=?").run("null", "repair-series:other:m1");
    } finally { database.close(); }
    assert.throws(() => new StageChecks(store).omProject(era), recordMissing, "A corrupt foreign row is invisible to the era search");
    assert.equal(new StageChecks(store).omProject("era45"), false, "And a second unmarked project still answers cleanly");
  } finally { observeStore(previous); }
});

function discoveryV5Base(t:TestContext) {
 const root=mkdtempSync(join(tmpdir(),'omg-ds1-gate-')),store=new Store(join(root,'state.sqlite')),engine=new ProductEngine(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 engine.execute({type:'create-project',project:'p',title:'Controlled Discovery'});
 const source=engine.discovery.evidence.document('p','request','Controlled local transformation scope','text/plain',0);
 const command={executable:process.execPath,args:['--version']};
 engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'medium',command},reviewer:{actor:'assessor',model:'fixture',effort:'medium',command},fullCheck:command,timeoutMs:1000},0);
 const draft=engine.prepare('p','discovery');
 for(const id of draft.value.questions) {
  const q=store.get<Question>(id)!,field=q.value.spec.field;
  if(field==='brief')engine.discovery.fact(id,q.revision,reference(source),{kind:'text-range',start:0,end:source.value.content.length});
  else if(['researchPlan','researchReport','verdict','preparation'].includes(field))answerDiscoveryFixture(engine,'p',store.get<DiscoveryDraft>(draft.id)!,q,preparedField('p',field),source);
  else engine.discovery.decision(id,q.revision,'owner',preparedField('p',field));
 }
 return {root,store,engine,draft,source,question:(field:string)=>store.get<Question>(draft.value.questions.find(id=>store.get<Question>(id)!.value.spec.field===field)!)!};
}

for(const change of ['plan','report','foreign-draft','bare-go'] as const) test(`DS1-06 ${change} cannot masquerade as current accepted research before dispatch or stage acceptance`,async t=>{
 const f=discoveryV5Base(t);
 if(change==='bare-go') {
  const q=f.question('verdict'),value=f.store.get<DiscoveryDraft>(f.draft.id)!.value.fields.verdict!;
  f.engine.discovery.reopen(q.id,q.revision);f.engine.discovery.decision(q.id,q.revision+1,'owner',value);
 }else if(change==='foreign-draft'){
  const q=f.question('researchPlan');f.store.write({id:q.id,kind:q.kind,expected:q.revision,value:{...q.value,draftId:'discovery:foreign'}});
 }else{
  const field=change==='plan'?'researchPlan':'researchReport',q=f.question(field),a=f.store.get<any>(q.value.answer!.id)!;
  const value={...a.value.value,...(change==='plan'?{domain:'Substituted domain'}:{variant:'Substituted result'})};
  const replacement=f.store.write({id:a.id+':replacement',kind:a.kind,expected:0,value:{...a.value,value}});
  f.store.write({id:q.id,kind:q.kind,expected:q.revision,value:{...q.value,answer:reference(replacement)}});
  const draft=f.store.get<DiscoveryDraft>(f.draft.id)!;
  f.store.write({id:draft.id,kind:draft.kind,expected:draft.revision,value:{...draft.value,fields:{...draft.value.fields,[field]:value}}});
 }
 assert.throws(()=>discoveryOutcome(f.store,f.store.get<DiscoveryDraft>(f.draft.id)!),(e:any)=>e instanceof EngineError&&/question:|discovery:/.test(e.message));
 const artifact=f.engine.draft('p','discovery',f.draft.id,0);
 assert.throws(()=>f.engine.pipeline.accept('p','discovery',artifact.revision));
 await f.engine.researcher.run('p',f.draft.id,1).catch(error=>assert.ok(error instanceof EngineError));
 assert.equal(f.store.list('model-call').length,0);
 assert.throws(()=>f.engine.prepare('p','concept'),{code:'predecessor_not_ready'});
});

for(const field of ['researchPlan','researchReport','verdict']) test(`DS1-07 reopening ${field} invalidates its old value and a second Store wins the pre-dispatch window`,async t=>{
 const f=discoveryV5Base(t),prep=f.question('preparation');f.engine.discovery.reopen(prep.id,prep.revision);
 const before=f.question(field),other=new Store(f.store.path);t.after(()=>other.close());
 const write=f.store.writeMany.bind(f.store);let raced=false;
 f.store.writeMany=((writes:Write[],guards:TransactionGuard[]=[])=>{
  if(!raced&&writes.some(w=>w.kind==='research-consumer-intent'&&w.expected===0)){
   raced=true;new ProductEngine(other).discovery.reopen(before.id,before.revision);
  }
  return write(writes,guards);
 }) as typeof f.store.writeMany;
 const run=await f.engine.researcher.run('p',f.draft.id,1);f.store.writeMany=write;
 assert.ok(raced);assert.equal(run.value.pauseCode,'input_stale');assert.equal(f.store.list('model-call').length,0);
 assert.equal(f.store.list('research-consumer-intent').length,0,'the failed preparation is atomic');
 assert.equal(discoveryOutcome(f.store,f.store.get<DiscoveryDraft>(f.draft.id)!).state,'researching');
 const artifact=f.engine.draft('p','discovery',f.draft.id,0);assert.throws(()=>f.engine.pipeline.accept('p','discovery',artifact.revision));
});

for (const missing of ['answer', 'answer-null', 'value', 'assessment', 'assessment-null', 'questions', 'fields', 'question-status']) {
 test(`DS1-10 absent ${missing} is an addressed refusal at the outcome and stage gate, not an exception or a new call`, async t => {
  const f = discoveryV5Base(t), q = f.question('researchPlan');
  const artifact = f.engine.draft('p', 'discovery', f.draft.id, 0);
  if (missing === 'questions' || missing === 'fields') {
   const draft = f.store.get<any>(f.draft.id)!, value = { ...draft.value }; delete value[missing];
   f.store.write({ id: draft.id, kind: draft.kind, expected: draft.revision, value });
  } else if (missing.startsWith('answer') || missing === 'question-status') {
   const value: any = { ...q.value };
   if (missing === 'answer-null') value.answer = null;
   else delete value[missing === 'question-status' ? 'status' : 'answer'];
   f.store.write({ id: q.id, kind: q.kind, expected: q.revision, value });
  } else {
   const a = f.store.get<any>(q.value.answer!.id)!, value = { ...a.value };
   if (missing === 'assessment-null') value.assessment = null; else delete value[missing];
   const damaged = f.store.write({ id: a.id + ':damaged', kind: a.kind, expected: 0, value });
   f.store.write({ id: q.id, kind: q.kind, expected: q.revision, value: { ...q.value, answer: reference(damaged) } });
  }
  const before = f.store.list().map(reference);
  const refused = (error: any) => error instanceof EngineError && error.code.startsWith('discovery_') && /question:|discovery:/.test(error.message);
  assert.throws(() => discoveryOutcome(f.store, f.store.get<DiscoveryDraft>(f.draft.id)!), refused);
  const reopened = new Store(f.store.path);
  try { assert.throws(() => discoveryOutcome(reopened, reopened.get<DiscoveryDraft>(f.draft.id)!), refused); }
  finally { reopened.close(); }
  assert.throws(() => f.engine.pipeline.accept('p', 'discovery', artifact.revision), (e: any) => e instanceof EngineError);
  await assert.rejects(f.engine.researcher.run('p', f.draft.id, 1), refused);
  assert.deepEqual(f.store.list().map(reference), before); assert.equal(f.store.list('model-call').length, 0);
 });
}

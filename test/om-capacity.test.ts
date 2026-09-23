import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { boundedContext } from "../src/compiler/context.js";
import { callAgent } from "../src/execution/protocol.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Environments, isRequestCapacityChars, type Environment } from "../src/runtime/environment.js";
import { Store } from "../src/storage/store.js";
import { readCapacity, CAPACITY_REFUSAL_CODES, type CapacityRequest } from "../src/om/capacity.js";
import { type OmResult, type Refusal } from "../src/om/refusal.js";
import { writeGuarded } from "../src/om/refs.js";
import { executionFixture } from "./execution-fixture.js";

const PROJECT = "capacity-test";
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "omg-capacity-")), path = join(directory, "state.sqlite");
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = { executable: process.execPath, args: ["--version"] };
  const settings: Omit<Environment, "projectId"> = { workspace: directory,
    implementer: { actor: "worker", model: "local-fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "local-fixture", effort: "high", command }, fullCheck: command, timeoutMs: 5000 };
  return { directory, path, settings, get store() { return store; },
    configure: (value: Omit<Environment, "projectId">, expected = 0, project = PROJECT) => new Environments(store).configure(project, value, expected),
    reopen: () => { store.close(); store = new Store(path); } };
}
function valueOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refusalOf<T>(result: OmResult<T>, code: string, field?: string): Refusal {
  if (result.ok) assert.fail(`Expected ${code}`);
  assert.equal(result.refusal.code, code);
  assert.equal(result.refusal.at.unit, "V1");
  assert.ok(result.refusal.at.target.length);
  assert.ok(result.refusal.message.length);
  assert.equal(result.refusal.route, "producer");
  if (field !== undefined) assert.equal(result.refusal.at.field, field);
  return result.refusal;
}
function request(environment: Ref, current = true, project = PROJECT): CapacityRequest { return { project, environment, current }; }
const codeIs = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;

// The configured scalar is physical capacity, not a budget, a profile suggestion or an inferred default.
test("V1 returns the exact positive configured capacity without clamping or a budget override", t => {
  const f = fixture(t);
  let expected = 0;
  for (const amount of [1, 2, 300_001, 2_000_000, Number.MAX_SAFE_INTEGER]) {
    const environment = f.configure({ ...f.settings, requestCapacityChars: amount }, expected++);
    const before = f.store.list();
    const capacity = valueOf(readCapacity(f.store, request(reference(environment))));
    assert.equal(capacity.maxRequestChars, amount);
    assert.deepEqual(capacity.environment, reference(environment));
    assert.deepEqual(capacity.references, [reference(environment)]);
    assert.deepEqual(capacity.guards, [reference(environment)]);
    assert.deepEqual(f.store.list(), before, "Capacity reading never writes or changes source records");
    assert.ok(isRequestCapacityChars(amount));
  }
  assert.ok(Object.isFrozen(CAPACITY_REFUSAL_CODES));
});

test("V1 rejects every invalid configured scalar before IO and leaves environment and workspace untouched", t => {
  const f = fixture(t), environment = f.configure(f.settings), before = f.store.list();
  const invalid: unknown[] = [undefined, null, false, true, "1000", 0, -1, 0.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, {}, [], 1n, Symbol("capacity"), () => 1];
  let touches = 0;
  const noIo = new Proxy(f.store, { get(target, key, receiver) {
    if (["get", "list", "write", "writeMany"].includes(String(key))) return () => { touches++; throw new Error("Unexpected store access"); };
    return Reflect.get(target, key, receiver);
  } });
  for (const amount of invalid) {
    assert.equal(isRequestCapacityChars(amount), false);
    const settings = { ...f.settings, workspace: join(f.directory, "absent-workspace"), requestCapacityChars: amount } as unknown as Omit<Environment, "projectId">;
    assert.throws(() => new Environments(noIo).configure(PROJECT, settings, environment.revision), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, "environment_invalid");
      assert.deepEqual(error.details, { target: `environment:${PROJECT}`, field: "requestCapacityChars" });
      return true;
    });
  }
  assert.equal(touches, 0);
  assert.deepEqual(f.store.list(), before);
});

test("V1 missing capacity never falls back to reader pilot, planning, physicalLimits or caller budgets", t => {
  const f = fixture(t), environment = f.configure(f.settings);
  const legacyBody = { ...f.settings, workspace: realpathSync(f.settings.workspace), projectId: PROJECT };
  assert.deepEqual(environment.value, legacyBody);
  assert.equal(environment.hash, hashJson(legacyBody));
  f.store.write({ id: `reader-pilot:${PROJECT}`, kind: "reader-pilot", expected: 0,
    value: { projectId: PROJECT, maxRequestChars: 111, maxReportedTokens: 9999999,
      physicalLimits: { maxRequestChars: 222, maxReplyChars: 333, basis: "another consumer" }, planning: { maxRequestChars: 444 } } });
  const before = f.store.list();
  const result = refusalOf(readCapacity(f.store, request(reference(environment))), "capacity_missing", "requestCapacityChars");
  assert.equal(result.at.target, environment.id);
  assert.deepEqual(result.at.ref, reference(environment));
  for (const override of [{ maxRequestChars: 1000 }, { requestCapacityChars: 1000 }, { budget: 1000 }])
    assert.throws(() => readCapacity(f.store, { ...request(reference(environment)), ...override }), codeIs("capacity_request_invalid"));
  assert.deepEqual(f.store.list(), before);
});

test("V1 all own refusal codes are addressed and stored malformed capacity cannot impersonate a setting", t => {
  const f = fixture(t), seen = new Set<string>();
  const check = (result: ReturnType<typeof readCapacity>, code: string, field: string) => seen.add(refusalOf(result, code, field).code);
  const absent = f.configure(f.settings);
  check(readCapacity(f.store, request(reference(absent))), "capacity_missing", "requestCapacityChars");
  let expected = absent.revision;
  for (const amount of [null, "2048", 0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    const invalid = f.store.write({ id: absent.id, kind: "environment", expected: expected++, value: { ...absent.value, requestCapacityChars: amount, status: "accepted" } });
    check(readCapacity(f.store, request(reference(invalid))), "capacity_invalid", "requestCapacityChars");
  }
  for (const body of [null, [], "environment", {}, { ...absent.value, projectId: "another-project", requestCapacityChars: 500 }]) {
    const foreign = f.store.write({ id: absent.id, kind: "environment", expected: expected++, value: body });
    check(readCapacity(f.store, request(reference(foreign))), "capacity_source_invalid", "projectId");
  }
  const current = f.configure({ ...f.settings, requestCapacityChars: 900 }, expected++);
  f.configure({ ...f.settings, requestCapacityChars: 900 }, expected);
  check(readCapacity(f.store, request(reference(current))), "input_stale", "environment");
  assert.deepEqual([...seen].sort(), [...CAPACITY_REFUSAL_CODES].sort());
});

test("V1 rejects malformed requests and exact references before accessing the store", t => {
  const f = fixture(t), environment = f.configure({ ...f.settings, requestCapacityChars: 1000 });
  let touches = 0;
  const noIo = new Proxy(f.store, { get(target, key, receiver) {
    if (["get", "list", "write", "writeMany"].includes(String(key))) return () => { touches++; throw new Error("Unexpected store access"); };
    return Reflect.get(target, key, receiver);
  } });
  const valid = request(reference(environment));
  const invalid: unknown[] = [undefined, null, false, [], "capacity", {},
    { ...valid, project: undefined }, { ...valid, project: null }, { ...valid, project: 4 }, { ...valid, project: " " },
    { ...valid, current: undefined }, { ...valid, current: null }, { ...valid, current: "true" },
    { ...valid, environment: undefined }, { ...valid, environment: null }, { ...valid, environment: [] },
    { ...valid, environment: { id: environment.id } }, { ...valid, environment: { ...reference(environment), revision: 0 } },
    { ...valid, environment: { ...reference(environment), hash: "wrong" } },
    { ...valid, environment: { ...reference(environment), id: "" } },
    { ...valid, unknown: true }, JSON.parse(canonical({ ...valid, extra: { value: 2 } })).extra,
    Object.assign(JSON.parse('{"__proto__":{"requestCapacityChars":999}}'), valid)];
  for (const item of invalid) assert.throws(() => readCapacity(noIo, item as CapacityRequest), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "capacity_request_invalid");
    const details = error.details as { unit: string; target: string; field: string };
    assert.equal(details.unit, "V1"); assert.equal(details.target, "capacity"); assert.ok(details.field);
    return true;
  });
  for (const store of [undefined, null, {}, false])
    assert.throws(() => readCapacity(store as Store, valid), codeIs("capacity_request_invalid"));
  assert.equal(touches, 0);
});

test("V1 exact source rejects missing, foreign namespace or kind, substituted hash and status imitation", t => {
  const f = fixture(t), environment = f.configure({ ...f.settings, requestCapacityChars: 2048 });
  const missing = { ...reference(environment), revision: 999 };
  refusalOf(readCapacity(f.store, request(missing)), "record_missing");
  const twin = f.store.write({ id: "environment:foreign", kind: "environment", expected: 0, value: environment.value });
  const wrongKind = f.store.write({ id: "environment:imitation", kind: "gate-pass", expected: 0,
    value: { projectId: "imitation", requestCapacityChars: 2048, status: "accepted" } });
  const wrongNamespace = f.store.write({ id: `source:${PROJECT}`, kind: "environment", expected: 0, value: environment.value });
  assert.equal(twin.hash, environment.hash);
  refusalOf(readCapacity(f.store, request(reference(twin))), "record_foreign", "id");
  refusalOf(readCapacity(f.store, request(reference(wrongNamespace))), "record_foreign", "id");
  refusalOf(readCapacity(f.store, request(reference(wrongKind), true, "imitation")), "record_foreign", "kind");
  refusalOf(readCapacity(f.store, request({ ...reference(environment), hash: "0".repeat(64) })), "record_forged", "hash");
  assert.equal(f.store.history(environment.id).length, 1);
});

test("V1 current freshness is guarded while exact historical capacity survives updates and restart", t => {
  const f = fixture(t), oldWorkspace = mkdtempSync(join(f.directory, "previous-workspace-"));
  const old = f.configure({ ...f.settings, workspace: oldWorkspace, requestCapacityChars: 1000 }), oldRef = reference(old);
  const fresh = f.configure({ ...f.settings, requestCapacityChars: 4000 }, old.revision);
  rmSync(oldWorkspace, { recursive: true }); // Exact history must not require its workspace to exist today.
  for (const reopen of [false, true]) {
    if (reopen) f.reopen();
    refusalOf(readCapacity(f.store, request(oldRef)), "input_stale", "environment");
    const gets: { id: string; revision?: number }[] = [];
    const onlyHistorical = new Proxy(f.store, { get(target, key) {
      if (key === "get") return (id: string, revision?: number) => { gets.push({ id, ...(revision === undefined ? {} : { revision }) }); return target.get(id, revision); };
      const field = Reflect.get(target, key); return typeof field === "function" ? field.bind(target) : field;
    } });
    const history = valueOf(readCapacity(onlyHistorical, request(oldRef, false)));
    assert.equal(history.maxRequestChars, 1000);
    assert.deepEqual(history.references, [oldRef]); assert.deepEqual(history.guards, []);
    assert.deepEqual(gets, [{ id: old.id, revision: old.revision }], "History does not require today's head");
    const current = valueOf(readCapacity(f.store, request(reference(fresh))));
    assert.equal(current.maxRequestChars, 4000); assert.deepEqual(current.guards, [reference(fresh)]);
    assert.deepEqual(f.store.get(old.id, old.revision), old);
  }
});

test("V1 guards the complete neighboring transaction against a changed environment even with equal content", t => {
  const f = fixture(t), environment = f.configure({ ...f.settings, requestCapacityChars: 1024 });
  const prepared = valueOf(readCapacity(f.store, request(reference(environment))));
  const competing = new Store(f.path);
  const updated = new Environments(competing).configure(PROJECT, { ...f.settings, requestCapacityChars: 1024 }, environment.revision);
  competing.close();
  assert.equal(updated.hash, environment.hash);
  const writes = ["capacity-consumer:one", "capacity-consumer:two"].map(id => ({ id, kind: "capacity-consumer", expected: 0,
    value: { capacity: prepared.maxRequestChars, environment: prepared.environment } }));
  const refused = writeGuarded(f.store, { unit: "V1-neighbor", target: "capacity-consumer", writes, guards: prepared.guards });
  assert.equal(refused.ok, false);
  if (!refused.ok) { assert.equal(refused.refusal.code, "input_stale"); assert.deepEqual(refused.refusal.at.ref, reference(environment)); }
  for (const write of writes) assert.equal(f.store.get(write.id), null);
  refusalOf(readCapacity(f.store, request(reference(environment))), "input_stale");
  const latest = valueOf(readCapacity(f.store, request(reference(updated))));
  const refreshed = writes.map(write => ({ ...write, value: { capacity: latest.maxRequestChars, environment: latest.environment } }));
  const committed = valueOf(writeGuarded(f.store, { unit: "V1-neighbor", target: "capacity-consumer", writes: refreshed, guards: latest.guards }));
  assert.equal(committed.length, 2);
});

test("V1 delivers independent deeply frozen references and preserves dangerous JSON keys in legacy environment bytes", t => {
  const f = fixture(t);
  const settings = { ...f.settings, requestCapacityChars: 9876, ...JSON.parse('{"__proto__":{"capacity":999},"metadata":{"constructor":"data"}}') };
  const environment = f.configure(settings), ref = reference(environment), before = canonical(environment);
  const result = valueOf(readCapacity(f.store, request(ref)));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.environment));
  assert.ok(Object.isFrozen(result.guards)); assert.ok(Object.isFrozen(result.guards[0]));
  assert.ok(Object.isFrozen(result.references)); assert.ok(Object.isFrozen(result.references[0]));
  assert.notEqual(result.environment, ref);
  assert.throws(() => { (result as { maxRequestChars: number }).maxRequestChars = 1; }, TypeError);
  assert.throws(() => { (result.environment as Ref).revision = 800; }, TypeError);
  assert.throws(() => { (result.guards as Ref[]).push(ref); }, TypeError);
  ref.hash = "0".repeat(64);
  assert.equal(result.environment.hash, environment.hash);
  assert.equal(canonical(f.store.get(environment.id)), before);
  assert.equal(environment.hash, hashJson(environment.value));
  assert.ok(Object.hasOwn(environment.value, "__proto__"));
  assert.equal(({} as { capacity?: number }).capacity, undefined);
});

test("V1 propagates unexpected storage failures instead of disguising them as absent capacity", t => {
  const f = fixture(t), environment = f.configure({ ...f.settings, requestCapacityChars: 1000 });
  for (const error of [new TypeError("storage failure"), new EngineError("record_corrupt", "corrupt")]) {
    const broken = new Proxy(f.store, { get(target, key, receiver) {
      if (key === "get") return () => { throw error; };
      return Reflect.get(target, key, receiver);
    } });
    assert.throws(() => readCapacity(broken, request(reference(environment))), received => received === error);
  }
});

test("V1 retains legacy environment bytes, accepted plan hash and guards across opt-in and restart", t => {
  const f = executionFixture(t), environment = f.engine.environments.get("p"), plan = f.engine.compiler.read(f.plan.id);
  assert.equal(Object.hasOwn(environment.value, "requestCapacityChars"), false);
  assert.equal(environment.value.workspace, realpathSync(f.workspace));
  assert.equal(hashJson(environment.value), environment.hash);
  const baseline = canonical(plan), guards = canonical(plan.value.guards), environmentBytes = canonical(environment);
  refusalOf(readCapacity(f.store, request(reference(environment), true, "p")), "capacity_missing");
  assert.deepEqual(f.engine.environments.effective("p").environment, environment);
  assert.equal(canonical(f.engine.compiler.read(plan.id)), baseline);
  assert.deepEqual(f.engine.compiler.gate("p", reference(plan)).findings, []);
  assert.ok(plan.value.guards.some(guard => canonical(guard) === canonical(reference(environment))));
  const { projectId: _projectId, ...settings } = environment.value;
  const changed = f.engine.environments.configure("p", { ...settings, requestCapacityChars: 100_000 }, environment.revision);
  assert.equal(valueOf(readCapacity(f.store, request(reference(changed), true, "p"))).maxRequestChars, 100_000);
  assert.equal(canonical(f.store.get(environment.id, environment.revision)), environmentBytes);
  assert.equal(canonical(f.engine.compiler.read(plan.id)), baseline);
  assert.equal(canonical(f.engine.compiler.read(plan.id).value.guards), guards);
  assert.ok(f.engine.compiler.gate("p", reference(plan)).findings.some(item => item.code === "plan_stale" && item.target === environment.id));
  f.reopen();
  assert.equal(canonical(f.store.get(environment.id, environment.revision)), environmentBytes);
  assert.equal(canonical(f.engine.compiler.read(plan.id)), baseline);
  assert.equal(canonical(f.engine.compiler.read(plan.id).value.guards), guards);
  refusalOf(readCapacity(f.store, request(reference(environment), false, "p")), "capacity_missing");
});

test("V1 one configured character capacity supplies exact bounded context and real local protocol transport without truncation", async t => {
  const f = fixture(t);
  const script = "const fs=require('node:fs');const text=fs.readFileSync(0,'utf8');const r=JSON.parse(text);process.stdout.write(JSON.stringify({protocol:r.protocol,requestId:r.requestId,chars:text.length,subject:r.subject}));";
  const role = { ...f.settings.implementer, command: { executable: process.execPath, args: ["-e", script] } };
  const subject = { obligations: [{ id: "must-deliver", text: "Сохранить каждое обязательство" }], data: "я".repeat(320_000) };
  const envelope = { protocol: "omg-agent/v1", requestId: "0".repeat(36), mode: "implement", model: role.model, effort: role.effort, prompt: "Do the complete task", subject };
  const exact = canonical(envelope).length;
  const environment = f.configure({ ...f.settings, implementer: role, requestCapacityChars: exact });
  const capacity = valueOf(readCapacity(f.store, request(reference(environment))));
  const context = boundedContext(envelope, capacity.maxRequestChars);
  assert.equal(context.chars, exact); assert.ok(context.utf8Bytes > capacity.maxRequestChars);
  assert.equal(context.text, canonical(envelope));
  let observedStarts = 0, measured = 0;
  const result = await callAgent(role, environment.value, "implement", "Do the complete task", subject, capacity.maxRequestChars,
    value => { assert.equal(value.requestChars, exact); measured++; }, child => { if (child) observedStarts++; });
  assert.equal(result['chars'], exact); assert.deepEqual(result['subject'], subject);
  assert.equal(measured, 2); assert.equal(observedStarts, 1);
  const tooLarge = { ...subject, data: `${subject.data}x` };
  assert.throws(() => boundedContext({ ...envelope, subject: tooLarge }, capacity.maxRequestChars), codeIs("context_budget_exceeded"));
  await assert.rejects(() => callAgent(role, environment.value, "implement", "Do the complete task", tooLarge, capacity.maxRequestChars,
    () => assert.fail("No usage before over-capacity refusal"), () => assert.fail("No process before over-capacity refusal")), codeIs("context_budget_exceeded"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, refused, sealed, type OmResult, type Refusal, type RefusalAddress, type RefusalRoute } from "../src/om/refusal.js";
import { readRecord, writeGuarded, REFS_REFUSAL_CODES, type GuardedWrite, type RecordRequest } from "../src/om/refs.js";

const UNIT = "A1";
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-om-refs-"));
  const path = join(root, "live.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store };
}

function refusalOf<T>(result: OmResult<T>): Refusal {
  if (result.ok) assert.fail("expected a refusal, got a delivered value");
  return result.refusal;
}

function deliveredOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`unexpected refusal ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(deeplyFrozen);
}

function addressed(refusal: Refusal, expected: string): Refusal {
  assert.equal(refusal.code, expected);
  assert.equal(refusal.at.unit, UNIT);
  assert.ok(refusal.at.target.length > 0);
  assert.ok(refusal.message.length > 0);
  assert.ok(REFUSAL_ROUTES.includes(refusal.route));
  return refusal;
}

test("an exact reference delivers the record and a guarded transaction commits every write at once", t => {
  const { store } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { status: "accepted", claim: "x" } });
  const read = deliveredOf(readRecord<{ status: string; claim: string }>(store, reference(base),
    { unit: UNIT, target: "input", kind: "om-input", id: base.id }));
  assert.equal(read.revision, 1);
  assert.equal(read.kind, "om-input");
  assert.equal(read.value.claim, "x");
  const written = deliveredOf(writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", guards: [reference(read)],
    writes: [
      { id: "om-answers:alpha", kind: "om-answers", expected: 0, value: { from: base.id } },
      { id: "om-gaps:alpha", kind: "om-gaps", expected: 0, value: { open: [] } },
    ],
  }));
  assert.equal(written.length, 2);
  assert.deepEqual(written.map(record => record.revision), [1, 1]);
  assert.deepEqual(store.get<{ from: string }>("om-answers:alpha")!.value, { from: base.id });
  assert.deepEqual(store.get("om-gaps:alpha")!.value, { open: [] });
});

test("every refusal code of this unit is produced, addressed and routed", t => {
  const { store, path } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x" } });
  const disguised = store.write({ id: "om-input:gate", kind: "gate-pass", expected: 0, value: { verdict: "pass" } });
  const request = { unit: UNIT, target: "input", kind: "om-input", idPrefix: "om-input:" };
  const answer = { id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} };
  const seen: string[] = [];
  const record = (refusal: Refusal, expected: string): void => { seen.push(addressed(refusal, expected).code); };

  record(refusalOf(readRecord(store, { id: base.id, revision: 1 }, request)), "reference_invalid");
  record(refusalOf(readRecord(store, { id: "om-input:absent", revision: 1, hash: base.hash }, request)), "record_missing");
  record(refusalOf(readRecord(store, reference(disguised), request)), "record_foreign");
  record(refusalOf(readRecord(store, { ...reference(base), hash: disguised.hash }, request)), "record_forged");
  record(refusalOf(writeGuarded(store, { unit: UNIT, target: "answers:alpha", writes: [], guards: [] })), "writes_missing");

  const second = new Store(path);
  try { second.write({ id: base.id, kind: "om-input", expected: 1, value: { claim: "moved" } }); } finally { second.close(); }
  record(refusalOf(writeGuarded(store, { unit: UNIT, target: "answers:alpha", writes: [answer], guards: [reference(base)] })), "input_stale");
  record(refusalOf(writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", guards: [],
    writes: [{ id: base.id, kind: "om-input", expected: 1, value: { claim: "mine" } }],
  })), "revision_conflict");

  assert.deepEqual([...new Set(seen)].sort(), [...REFS_REFUSAL_CODES].sort());
});

test("an absent reference field or record is a typed refusal that names the address (T4)", t => {
  const { store } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x" } });
  const request = { unit: UNIT, target: "input", kind: "om-input", idPrefix: "om-input:" };
  const field = (value: unknown): string | undefined => addressed(refusalOf(readRecord(store, value, request)), "reference_invalid").at.field;
  assert.equal(field(null), "reference");
  assert.equal(field("om-input:alpha"), "reference");
  assert.equal(field({ revision: 1, hash: base.hash }), "id");
  assert.equal(field({ id: base.id, hash: base.hash }), "revision");
  assert.equal(field({ id: base.id, revision: 0, hash: base.hash }), "revision");
  assert.equal(field({ id: base.id, revision: 1 }), "hash");

  const missing = addressed(refusalOf(readRecord(store, { id: "om-input:absent", revision: 3, hash: base.hash }, request)), "record_missing");
  assert.deepEqual(missing.at.ref, { id: "om-input:absent", revision: 3, hash: base.hash });
  assert.equal(missing.at.target, "input");

  const malformed = addressed(refusalOf(writeGuarded(store, {
    unit: UNIT, target: "answers:alpha",
    writes: [{ id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} }],
    guards: [{ id: base.id, revision: 1, hash: "not-a-hash" } as Ref],
  })), "reference_invalid");
  assert.equal(malformed.at.field, "hash");
  assert.equal(store.get("om-answers:alpha"), null);
});

test("an explicitly empty write set is an addressed refusal while an absent one is a typed defect (T4)", t => {
  const { store } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x" } });
  const writes = [
    { id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} },
    { id: "om-gaps:alpha", kind: "om-gaps", expected: 0, value: {} },
  ];
  const empty = addressed(refusalOf(writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", writes: [], guards: [reference(base)],
  })), "writes_missing");
  assert.equal(empty.at.target, "answers:alpha");
  assert.equal(empty.at.field, "writes");

  // An absent set is not an empty one, and an absent guard set is never read as "this write depends on nothing".
  assert.throws(() => writeGuarded(store, { unit: UNIT, target: "answers:alpha", guards: [] } as unknown as GuardedWrite),
    code("write_request_invalid"));
  assert.throws(() => writeGuarded(store, { unit: UNIT, target: "answers:alpha", writes } as unknown as GuardedWrite),
    code("write_request_invalid"));
  assert.throws(() => writeGuarded(store, { unit: UNIT, target: "answers:alpha", writes, guards: null } as unknown as GuardedWrite),
    code("write_request_invalid"));
  for (const write of writes) assert.equal(store.get(write.id), null);
});

test("a forged input is refused: foreign project, foreign namespace, substituted hash, declared status", t => {
  const { store } = fixture(t);
  const body = { status: "accepted", claim: "x" };
  const real = store.write({ id: "layer-proposal:alpha:1", kind: "om-input", expected: 0, value: body });
  const twin = store.write({ id: "layer-proposal:beta:1", kind: "om-input", expected: 0, value: body });
  const cousin = store.write({ id: "layer-proposal:alphabet:1", kind: "om-input", expected: 0, value: body });
  const disguised = store.write({ id: "layer-proposal:alpha:2", kind: "gate-pass", expected: 0, value: body });
  // Identical content hashes alike, so neither the hash nor a status field inside the body is an identity.
  assert.equal(twin.hash, real.hash);
  assert.equal(disguised.hash, real.hash);

  const exact = { unit: UNIT, target: "input", kind: "om-input", id: real.id };
  const scoped = { unit: UNIT, target: "input", kind: "om-input", idPrefix: "layer-proposal:alpha:" };
  // A twin of the same kind under another project's address is refused under both forms of the expected address.
  assert.equal(addressed(refusalOf(readRecord(store, reference(twin), exact)), "record_foreign").at.field, "id");
  assert.equal(addressed(refusalOf(readRecord(store, reference(twin), scoped)), "record_foreign").at.field, "id");
  // The ':' in the prefix is what keeps project "alpha" from admitting project "alphabet".
  assert.equal(addressed(refusalOf(readRecord(store, reference(cousin), scoped)), "record_foreign").at.field, "id");
  assert.ok(cousin.id.startsWith("layer-proposal:alpha"));
  assert.throws(() => readRecord(store, reference(cousin), { ...scoped, idPrefix: "layer-proposal:alpha" }), code("read_request_invalid"));
  // Right project, foreign namespace.
  assert.equal(addressed(refusalOf(readRecord(store, reference(disguised), scoped)), "record_foreign").at.field, "kind");
  assert.equal(addressed(refusalOf(readRecord(store, { ...reference(real), hash: "0".repeat(64) }, exact)), "record_forged").at.field, "hash");

  // The body's own status decides nothing in either direction: an exactly addressed draft is delivered as it stands.
  const draft = store.write({ id: "layer-proposal:alpha:3", kind: "om-input", expected: 0, value: { status: "draft" } });
  assert.equal(deliveredOf(readRecord<{ status: string }>(store, reference(draft), { ...exact, id: draft.id })).value.status, "draft");
  assert.equal(deliveredOf(readRecord<{ status: string }>(store, reference(draft), scoped)).value.status, "draft");
});

test("a guarded record that changes between check and write is refused, not written over (T7)", t => {
  const { store, path } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x" } });
  const read = deliveredOf(readRecord(store, reference(base), { unit: UNIT, target: "input", kind: "om-input", id: base.id }));
  const guard = reference(read);

  const other = new Store(path);
  try { other.write({ id: base.id, kind: "om-input", expected: 1, value: { claim: "moved" } }); } finally { other.close(); }

  const refusal = addressed(refusalOf(writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", guards: [guard],
    writes: [
      { id: "om-answers:alpha", kind: "om-answers", expected: 0, value: { from: base.id } },
      { id: "om-gaps:alpha", kind: "om-gaps", expected: 0, value: {} },
    ],
  })), "input_stale");
  assert.deepEqual(refusal.at.ref, guard);
  assert.equal(refusal.at.target, base.id);
  assert.equal(store.get("om-answers:alpha"), null);
  assert.equal(store.get("om-gaps:alpha"), null);
  assert.equal(store.get<{ claim: string }>(base.id)!.value.claim, "moved");
  assert.equal(store.history(base.id).length, 2);
});

test("a reference with the right id and revision but a foreign hash is refused", t => {
  const { store } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x" } });
  const foreign = store.write({ id: "om-input:beta", kind: "om-input", expected: 0, value: { claim: "y" } });
  const request = { unit: UNIT, target: "input", kind: "om-input", id: base.id };
  const refusal = addressed(refusalOf(readRecord(store, { id: base.id, revision: base.revision, hash: foreign.hash }, request)), "record_forged");
  assert.deepEqual(refusal.at.ref, { id: base.id, revision: 1, hash: foreign.hash });
  assert.equal(refusal.at.field, "hash");
  assert.equal(deliveredOf(readRecord<{ claim: string }>(store, reference(base), request)).value.claim, "x");
});

test("a delivered record is a deep frozen copy, independent of its source and of the policy tables (T11)", t => {
  const { store } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x", parts: [{ n: 1 }] } });
  const request = { unit: UNIT, target: "input", kind: "om-input", id: base.id };
  const first = deliveredOf(readRecord<{ claim: string; parts: { n: number }[] }>(store, reference(base), request));
  const again = deliveredOf(readRecord<{ claim: string; parts: { n: number }[] }>(store, reference(base), request));
  assert.notEqual(first.value, again.value);
  assert.deepEqual(first.value, again.value);
  assert.throws(() => {
    // @ts-expect-error a delivered record is readonly at compile time, not only frozen at run time
    first.value.claim = "changed";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error the copy is readonly all the way down, not only at its first level
    first.value.parts[0]!.n = 2;
  }, TypeError);
  assert.equal(store.get<{ claim: string }>(base.id)!.value.claim, "x");

  const source: { rows: { id: string }[] } = { rows: [{ id: "one" }] };
  const copy = sealed(source);
  source.rows.push({ id: "two" });
  source.rows[0]!.id = "changed";
  assert.deepEqual(copy, { rows: [{ id: "one" }] });
  assert.throws(() => { (copy.rows as unknown as { id: string }[]).push({ id: "three" }); }, TypeError);

  assert.ok(Object.isFrozen(REFUSAL_ROUTES));
  assert.ok(Object.isFrozen(REFS_REFUSAL_CODES));
  assert.throws(() => { (REFS_REFUSAL_CODES as unknown as string[]).push("invented"); }, TypeError);
  assert.throws(() => {
    // @ts-expect-error a policy table does not change while the module works, at compile time as well
    REFS_REFUSAL_CODES[0] = "invented";
  }, TypeError);

  const handed = { id: base.id, revision: 1, hash: base.hash };
  const refusal = refusalOf(readRecord(store, handed, { unit: UNIT, target: "input", kind: "gate-pass", id: base.id }));
  handed.hash = "0".repeat(64);
  assert.equal(refusal.at.ref!.hash, base.hash);
  assert.throws(() => { (refusal.at as unknown as { unit: string }).unit = "M5"; }, TypeError);

  assert.throws(() => sealed({ when: new Date() }), code("unsealable_value"));
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.throws(() => sealed(cyclic), code("unsealable_value"));
});

test("input_stale and revision_conflict become addressed refusals while other engine refusals keep their own error", t => {
  const { store, path } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x" } });
  const guard = reference(base);
  const second = new Store(path);
  try { second.write({ id: base.id, kind: "om-input", expected: 1, value: { claim: "moved" } }); } finally { second.close(); }

  const stale = addressed(refusalOf(writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", guards: [guard],
    writes: [{ id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} }],
  })), "input_stale");
  assert.deepEqual(stale.at.ref, guard);
  assert.equal(stale.at.target, base.id);

  const conflict = addressed(refusalOf(writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", guards: [],
    writes: [
      { id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} },
      { id: base.id, kind: "om-input", expected: 1, value: { claim: "mine" } },
    ],
  })), "revision_conflict");
  assert.equal(conflict.at.target, base.id);
  assert.equal(conflict.at.field, "expected");
  assert.equal(store.get("om-answers:alpha"), null);
  assert.equal(store.get<{ claim: string }>(base.id)!.value.claim, "moved");

  assert.throws(() => writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", guards: [],
    writes: [{ id: base.id, kind: "om-answers", expected: 2, value: {} }],
  }), code("kind_mismatch"));
  assert.throws(() => writeGuarded(store, {
    unit: UNIT, target: "answers:alpha", guards: [],
    writes: [
      { id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} },
      { id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} },
    ],
  }), code("duplicate_write"));
});

test("a read or a guarded write that does not name its unit, target or namespace is refused as a defect", t => {
  const { store } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: {} });
  const request = { unit: UNIT, target: "input", kind: "om-input", id: base.id };
  assert.throws(() => readRecord(store, reference(base), { ...request, unit: "" }), code("read_request_invalid"));
  assert.throws(() => readRecord(store, reference(base), { ...request, target: "" }), code("read_request_invalid"));
  // An empty namespace would make the masquerade check vacuous, so it is a defect rather than a permissive default.
  assert.throws(() => readRecord(store, reference(base), { ...request, kind: "" }), code("read_request_invalid"));
  // T1/T4: the expected address is mandatory and singular, at compile time as well as at run time.
  assert.throws(() => {
    // @ts-expect-error a read that names no expected address does not compile
    readRecord(store, reference(base), { unit: UNIT, target: "input", kind: "om-input" });
  }, code("read_request_invalid"));
  assert.throws(() => {
    // @ts-expect-error a read that names both an exact id and a prefix does not compile
    readRecord(store, reference(base), { unit: UNIT, target: "input", kind: "om-input", id: base.id, idPrefix: "om-input:" });
  }, code("read_request_invalid"));
  assert.throws(() => readRecord(store, reference(base), { ...request, id: "" }), code("read_request_invalid"));
  assert.throws(() => readRecord(store, reference(base), { unit: UNIT, target: "input", kind: "om-input", idPrefix: "om-input" }), code("read_request_invalid"));
  assert.throws(() => readRecord(store, reference(base), { unit: UNIT, target: "input", kind: "om-input", idPrefix: ":" }), code("read_request_invalid"));
  assert.throws(() => writeGuarded(store, {
    unit: UNIT, target: "", guards: [],
    writes: [{ id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} }],
  }), code("write_request_invalid"));
});

// Keys a plain assignment would mishandle, or that live on Object.prototype. "__proto__" is the dangerous one:
// assigning it calls the prototype setter, so the field would vanish and its value would become the copy's prototype.
const AWKWARD_RECORDS = [
  '{"__proto__":null,"field":"v"}',
  '{"__proto__":{"status":"accepted"},"field":"v"}',
  '{"__proto__":"text","field":"v"}',
  '{"constructor":"c","prototype":"p","toString":"t","hasOwnProperty":false,"valueOf":0}',
  '{"0":"a","10":"b","2":"c","":"empty"}',
  '{"rows":[{"__proto__":{"status":"accepted"},"n":1},{"toString":"t"}],"deep":{"nested":{"__proto__":null,"x":1}}}',
];

test("a copy carries the exact content of the record on both paths, the write result and the read (T11)", t => {
  const { store } = fixture(t);
  AWKWARD_RECORDS.forEach((text, index) => {
    const original: unknown = JSON.parse(text);
    const id = `om-input:case-${index}`;
    const written = deliveredOf(writeGuarded(store, {
      unit: UNIT, target: id, guards: [],
      writes: [{ id, kind: "om-input", expected: 0, value: original }],
    }));
    const stored = store.get(id)!;
    assert.equal(canonical(stored.value), canonical(original), `the store itself keeps ${text}`);
    const read = deliveredOf(readRecord(store, reference(stored), { unit: UNIT, target: "input", kind: "om-input", id }));

    const paths: [string, unknown][] = [["write result", written[0]!.value], ["read", read.value]];
    for (const [path, value] of paths) {
      const subject = `${path} of ${text}`;
      const object = value as Record<string, unknown>;
      const source = original as Record<string, unknown>;
      assert.equal(canonical(value), canonical(original), subject);
      assert.equal(hashJson(value), stored.hash, subject);
      assert.deepEqual(Object.keys(object).sort(), Object.keys(source).sort(), subject);
      // The copy inherits nothing from the content it copies: its only prototype is Object.prototype.
      assert.equal(Object.getPrototypeOf(object), Object.prototype, subject);
      assert.equal("status" in object, false, subject);
      assert.ok(deeplyFrozen(value), subject);
      assert.notEqual(value, stored.value);

      if (Object.prototype.hasOwnProperty.call(source, "__proto__")) {
        const descriptor = Object.getOwnPropertyDescriptor(object, "__proto__");
        assert.ok(descriptor, `${subject}: __proto__ stays an own field`);
        assert.equal(descriptor.enumerable, true, subject);
        assert.deepEqual(descriptor.value, source['__proto__'], subject);
      }
      const rows = object['rows'];
      if (Array.isArray(rows)) {
        assert.ok(Object.prototype.hasOwnProperty.call(rows[0], "__proto__"), subject);
        assert.equal("status" in (rows[0] as object), false, subject);
      }
    }
  });
});

test("every exported function refuses a missing, null or mistyped argument as a typed defect, never a TypeError", t => {
  const { store } = fixture(t);
  const base = store.write({ id: "om-input:alpha", kind: "om-input", expected: 0, value: { claim: "x" } });
  const ref = reference(base);
  const read = (request: unknown): void => { readRecord(store, ref, request as RecordRequest); };
  const write = (request: unknown): void => { writeGuarded(store, request as GuardedWrite); };
  const good = { unit: UNIT, target: "input", kind: "om-input", id: base.id };
  const writes = [{ id: "om-answers:alpha", kind: "om-answers", expected: 0, value: {} }];
  const transaction = { unit: UNIT, target: "answers:alpha", writes, guards: [] };

  for (const request of [null, undefined, "request", 7, [good]]) {
    assert.throws(() => read(request), code("read_request_invalid"));
  }
  for (const field of ["unit", "target", "kind"] as const) {
    for (const broken of [undefined, null, "", 7, {}]) {
      assert.throws(() => read({ ...good, [field]: broken }), code("read_request_invalid"));
    }
  }
  for (const broken of [null, 7, {}]) {
    assert.throws(() => read({ unit: UNIT, target: "input", kind: "om-input", id: broken }), code("read_request_invalid"));
    assert.throws(() => read({ unit: UNIT, target: "input", kind: "om-input", idPrefix: broken }), code("read_request_invalid"));
  }

  for (const request of [null, undefined, "request", 7, [transaction]]) {
    assert.throws(() => write(request), code("write_request_invalid"));
  }
  for (const field of ["unit", "target"] as const) {
    for (const broken of [undefined, null, "", 7]) {
      assert.throws(() => write({ ...transaction, [field]: broken }), code("write_request_invalid"));
    }
  }
  for (const broken of [undefined, null, "set", 7, {}]) {
    assert.throws(() => write({ ...transaction, writes: broken }), code("write_request_invalid"));
    assert.throws(() => write({ ...transaction, guards: broken }), code("write_request_invalid"));
  }
  const entry = writes[0]!;
  for (const broken of [null, undefined, "write", 7, {}, { ...entry, id: "" }, { ...entry, id: 7 }, { ...entry, kind: undefined },
    { ...entry, expected: undefined }, { ...entry, expected: -1 }, { ...entry, expected: 1.5 }, { ...entry, expected: "0" },
    { id: entry.id, kind: entry.kind, expected: 0 }, { ...entry, value: undefined }]) {
    assert.throws(() => write({ ...transaction, writes: [broken] }), code("write_request_invalid"));
  }
  assert.equal(store.get("om-answers:alpha"), null);

  // A refusal without an address is not a refusal (T8).
  const at = { unit: UNIT, target: "input" };
  assert.throws(() => refused("", "message", at, "producer"), code("refusal_invalid"));
  assert.throws(() => refused("code", "", at, "producer"), code("refusal_invalid"));
  assert.throws(() => refused("code", "message", null as unknown as RefusalAddress, "producer"), code("refusal_invalid"));
  assert.throws(() => refused("code", "message", { unit: "", target: "input" }, "producer"), code("refusal_invalid"));
  assert.throws(() => refused("code", "message", { unit: UNIT, target: "" }, "producer"), code("refusal_invalid"));
  assert.throws(() => refused("code", "message", { ...at, ref: "ref" as unknown as Ref }, "producer"), code("refusal_invalid"));
  assert.throws(() => refused("code", "message", at, "elsewhere" as unknown as RefusalRoute), code("refusal_invalid"));

  // sealed() hands out JSON only: undefined and functions are not values a unit can deliver.
  assert.throws(() => sealed(undefined), code("unsealable_value"));
  assert.throws(() => sealed(() => 1), code("unsealable_value"));
  assert.throws(() => sealed({ field: undefined }), code("unsealable_value"));
  assert.throws(() => sealed({ nested: { call: () => 1 } }), code("unsealable_value"));
  assert.throws(() => sealed([undefined]), code("unsealable_value"));
});

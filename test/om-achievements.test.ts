import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import type { Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import {
  confirmResults, ACCEPTANCE_CODES, ACCEPTANCE_PROVIDERS, CANCELLATION_PROVIDERS, type ConfirmRequest,
} from "../src/om/achievements.js";
import type { AttemptGoal } from "../src/om/series.js";
import { gapLinesId, gapLinesNamespace, type GapLinesRecord } from "../src/om/gap-lines.js";

const UNIT = "om-acceptance";
const PROJECT = "alpha";
const TARGET = "repair-series:alpha:1:block:cart";
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-om-acceptance-"));
  const store = new Store(join(root, "live.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store };
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

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
let unique = 0;
const next = (): number => (unique += 1);

const goal: AttemptGoal = { key: "gap:cart:price", questions: ["which node produces the price?"], result: "an accepted proposal" };

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest =>
  ({ project: PROJECT, block: "block:cart", target: TARGET, goal, accepting: [], cancelling: [], ...over });

/** A record of a kind, holding content that SAYS it accepted something — the store holds whatever it is given. */
const written = (store: Store, kind: string, value: Record<string, unknown> = { accepted: true, keys: ["line:cart:price"] }): Ref =>
  reference(store.write({ id: `${kind}:${PROJECT}:${next()}`, kind, expected: 0, value: value as Json }));

test("the D2 and D5 acceptance providers and empty cancellation table are frozen and closed to callers", () => {
  for (const table of [ACCEPTANCE_PROVIDERS, CANCELLATION_PROVIDERS]) {
    const expected = table === ACCEPTANCE_PROVIDERS ? ["gap-line", "accepted-answer"] : [];
    assert.deepEqual(Object.keys(table), expected);
    assert.ok(Object.isFrozen(table));
    for (const provider of Object.values(table)) assert.ok(Object.isFrozen(provider));
    // No prototype: a kind that names a member of Object.prototype finds nothing there.
    assert.equal(Object.getPrototypeOf(table), null);
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      assert.equal(Object.hasOwn(table, kind), false, kind);
      assert.equal((table as Record<string, unknown>)[kind], undefined, kind);
    }
    // A caller cannot connect a provider of its own: the table is not a parameter of anything, and it does not change.
    const own = { namespace: () => `om-gap-line:${PROJECT}:`, confirm: () => ({ keys: ["line:cart:price"] }) };
    assert.throws(() => { (table as Record<string, unknown>)["om-gap-line"] = own; }, TypeError);
    assert.throws(() => Object.defineProperty(table, "om-gap-line", { value: own }), TypeError);
    assert.deepEqual(Object.keys(table), expected);
  }
  const provider = ACCEPTANCE_PROVIDERS["gap-line"]!;
  assert.equal(provider.namespace(PROJECT), gapLinesNamespace(PROJECT));
  assert.throws(() => { (provider as unknown as Record<string, unknown>)["confirm"] = () => ({ keys: ["forged"] }); }, TypeError);
  assert.ok(Object.isFrozen(ACCEPTANCE_CODES));
  assert.throws(() => { (ACCEPTANCE_CODES as unknown as string[]).push("invented"); }, TypeError);
});

test("every refusal code of the contract is produced, addressed and routed", t => {
  const { store } = fixture(t);
  const seen: string[] = [];
  const record = (refusal: Refusal, expected: string): void => {
    assert.equal(refusal.code, expected);
    assert.equal(refusal.at.unit, UNIT);
    assert.equal(refusal.at.target, TARGET);
    assert.ok(refusal.message.length > 0);
    assert.ok(REFUSAL_ROUTES.includes(refusal.route));
    seen.push(refusal.code);
  };
  const line = written(store, "om-gap-line");
  record(refusalOf(confirmResults(store, request({ accepting: [line] }))), "achievement_unconfirmed");
  record(refusalOf(confirmResults(store, request({ cancelling: [line] }))), "cancellation_unconfirmed");
  assert.deepEqual([...new Set(seen)].sort(), [...ACCEPTANCE_CODES].sort());
});

test("unsupported kinds cannot confirm a result or cancellation, including the distinct om-gap-line kind", t => {
  const { store } = fixture(t);
  // A refusal as the ground of "acceptance", a candidate, a gap line, and records whose kinds name members of a
  // prototype: none of them has a provider, and no content they carry is read.
  const kinds = ["om-unit-refusal", "om-candidate", "om-gap-line", "om-accepted-frame", "constructor", "__proto__", "toString", "hasOwnProperty"];
  for (const kind of kinds) {
    const ref = written(store, kind);
    const accepted = refusalOf(confirmResults(store, request({ accepting: [ref] })));
    assert.equal(accepted.code, "achievement_unconfirmed", kind);
    assert.equal(accepted.at.field, "outcome.accepting.0.kind", kind);
    assert.deepEqual(accepted.at.ref, ref, kind);
    assert.ok(accepted.message.includes(kind), kind);
    const cancelled = refusalOf(confirmResults(store, request({ cancelling: [ref] })));
    assert.equal(cancelled.code, "cancellation_unconfirmed", kind);
    assert.equal(cancelled.at.field, "outcome.cancelling.0.kind", kind);
  }
  // A reference that does not stand, or stands with other content, is no record at all.
  const line = written(store, "om-gap-line");
  for (const ref of [{ ...line, hash: hex("d") }, { ...line, revision: 2 }, { id: `om-gap-line:${PROJECT}:gone`, revision: 1, hash: hex("e") }]) {
    const found = refusalOf(confirmResults(store, request({ accepting: [written(store, "om-candidate"), ref] })));
    assert.equal(found.code, "achievement_unconfirmed");
    // The first record already refuses the set: one unconfirmed result refuses the whole outcome.
    assert.equal(found.at.field, "outcome.accepting.0.kind");
    assert.equal(refusalOf(confirmResults(store, request({ accepting: [ref] }))).at.field, "outcome.accepting.0");
  }
  // Without an attempt to confirm for, nothing is confirmed either.
  assert.equal(refusalOf(confirmResults(store, request({ goal: null, accepting: [line] }))).code, "achievement_unconfirmed");
});

test("the registered gap-line provider requires real historical sources despite fabricated acceptance fields", t => {
  const { store } = fixture(t);
  const ref = (id: string): Ref => ({ id, revision: 1, hash: hex("a") });
  const graph = ref(`graph:${PROJECT}`), horizon = ref(`om-horizon:${PROJECT}:choice`);
  const value: GapLinesRecord = { project: PROJECT, lines: [], request: { project: PROJECT, previous: null, pass: 1,
    gaps: { records: [], sources: { project: PROJECT, input: ref(`om-input:${PROJECT}`), graph, horizon,
      operations: { proposals: [], frame: { project: PROJECT, level: 2, graph, horizon, layer: null, frame: null, upper: null } },
      works: { state: "upper-not-accepted", layer: ref(`graph-layer:${PROJECT}:2`) },
    } }, closures: [] } };
  const line = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { ...value, accepted: true, status: "closed", keys: ["fabricated-result"] } as unknown as Json }));
  const result = refusalOf(confirmResults(store, request({ accepting: [line] })));
  assert.equal(result.code, "achievement_unconfirmed");
  assert.equal(result.at.field, "outcome.accepting.0");
  assert.match(result.message, /record_missing/);
  assert.deepEqual(result.at.ref, line);
  assert.equal(refusalOf(confirmResults(store, request({ goal: null, accepting: [line] }))).at.field, "attempt");
});

test("the registered gap-line provider refuses an absent saved request", t => {
  const { store } = fixture(t);
  const line = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { project: PROJECT, lines: [], accepted: true, keys: ["fabricated-result"] } }));
  const result = refusalOf(confirmResults(store, request({ accepting: [line] })));
  assert.equal(result.code, "achievement_unconfirmed");
  assert.equal(result.at.field, "outcome.accepting.0");
  assert.match(result.message, /gap_line_forged.*request/i);
});

test("gap-line project namespace and saved project cannot be substituted", t => {
  const { store } = fixture(t);
  const foreign = reference(store.write({ id: gapLinesId(`${PROJECT}bet`), kind: "gap-line", expected: 0,
    value: { project: `${PROJECT}bet`, lines: [], accepted: true } }));
  const result = refusalOf(confirmResults(store, request({ accepting: [foreign] })));
  assert.equal(result.code, "achievement_unconfirmed");
  assert.equal(result.at.field, "outcome.accepting.0.id");
  assert.match(result.message, /outside/);
  const forged = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { project: "foreign", lines: [], accepted: true } }));
  const body = refusalOf(confirmResults(store, request({ accepting: [forged] })));
  assert.equal(body.code, "achievement_unconfirmed");
  assert.match(body.message, /gap_line_forged/);
});

test("registered gap-line acceptance does not grant cancellation authority", t => {
  const { store } = fixture(t);
  const line = reference(store.write({ id: gapLinesId(PROJECT), kind: "gap-line", expected: 0,
    value: { project: PROJECT, lines: [], closedBy: "cancelled", accepted: true } }));
  const result = refusalOf(confirmResults(store, request({ cancelling: [line] })));
  assert.equal(result.code, "cancellation_unconfirmed");
  assert.equal(result.at.field, "outcome.cancelling.0.kind");
  assert.match(result.message, /gap-line/);
});

test("an outcome that names no result is confirmed as exactly that, and handed out as a frozen copy", t => {
  const { store } = fixture(t);
  const none = deliveredOf(confirmResults(store, request()));
  assert.deepEqual(none, { achieved: [], cancelled: [] });
  assert.ok(deeplyFrozen(none));
  assert.deepEqual(deliveredOf(confirmResults(store, request({ goal: null }))), { achieved: [], cancelled: [] });
});

test("every argument is checked before the store is touched, as a typed defect and never a TypeError", t => {
  const { store } = fixture(t);
  // No default argument stands in for a broken one: a helper that quietly substituted the real store would test itself.
  const confirmIn = (where: unknown, value: unknown): void => { confirmResults(where as Store, value as ConfirmRequest); };
  const confirm = (value: unknown): void => confirmIn(store, value);
  for (const broken of [null, undefined, "store", 7, {}, { get: () => null }]) {
    assert.throws(() => confirmIn(broken, request()), code("acceptance_request_invalid"));
  }
  for (const value of [null, undefined, "request", 7, [request()]]) assert.throws(() => confirm(value), code("acceptance_request_invalid"));
  for (const field of ["project", "block", "target"] as const) {
    for (const broken of [undefined, null, "", 7, {}]) assert.throws(() => confirm({ ...request(), [field]: broken }), code("acceptance_request_invalid"));
  }
  for (const broken of [undefined, "goal", 7, []]) assert.throws(() => confirm({ ...request(), goal: broken }), code("acceptance_request_invalid"));
  for (const field of ["accepting", "cancelling"] as const) {
    // An absent set is not an empty one, and a set of anything but exact references names no record.
    for (const broken of [undefined, null, {}, "ref", [null], ["om-gap-line:alpha:1"], [{ id: "x", revision: 1 }], [{ id: "x", revision: 0, hash: hex("a") }]]) {
      assert.throws(() => confirm({ ...request(), [field]: broken }), code("acceptance_request_invalid"));
    }
  }
});


test("the accepted-answer provider rejects status imitations and unconfirmed cancellation", t => {
  const { store } = fixture(t);
  const row = store.write({ id: `om-answer:${PROJECT}:fake`, kind: "accepted-answer", expected: 0,
    value: { project: PROJECT, accepted: true, status: "supported", key: "caller-result" } });
  assert.equal(refusalOf(confirmResults(store, request({ accepting: [reference(row)] }))).code, "achievement_unconfirmed");
  assert.equal(refusalOf(confirmResults(store, request({ cancelling: [reference(row)] }))).code, "cancellation_unconfirmed");
  assert.equal(ACCEPTANCE_PROVIDERS["accepted-answer"]!.namespace(PROJECT), `om-answer:${PROJECT}:`);
});

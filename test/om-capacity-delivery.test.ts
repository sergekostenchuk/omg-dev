import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision } from "../src/storage/store.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { processStart } from "../src/runtime/process-identity.js";
import { ProductEngine } from "../src/product/engine.js";
import {
  planOmCapacityDelivery,
  requireOmCapacityDelivery,
  measureAdapterWire,
  fitsWire,
  readOmCapacityRecovery,
  readOmLimitedCallRetryPermit,
  registerSuccessorDeriver,
  OM_CAPACITY_DELIVERY_CONTRACT,
  OM_CAPACITY_RECOVERY_CONTRACT,
  OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT,
  type AddressedOmOriginal,
  type OmCapacityRecoveryRecord,
  type OmLimitedCallRetryPermit,
} from "../src/om/capacity-delivery.js";
import { deriveCapacitySuccessorPacket, type QuestionPacketRecord } from "../src/om/question-packet.js";
import { advanceRun, cycleStartOf, recoveredSuccessorPacket, startRun } from "../src/om/run.js";
import { readOmContextPage } from "../src/om/model-call.js";
import { withReadings, packetPrompt, BRIEF_VERSION, type CarriedBasis } from "../src/om/packet-brief.js";

function fixtureStore(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-cap-test-"));
  const path = join(root, "store.sqlite");
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path, store };
}

test("Capacity delivery planner: small text fits in a single page", () => {
  const text = "Hello, world! This is a compact delivery.";
  const packetRef: Ref = { id: "packet:test:1", revision: 1, hash: "a".repeat(64) };
  const original: AddressedOmOriginal = {
    record: packetRef,
    pointer: "/read_context/data",
    value: text,
  };

  const delivery = planOmCapacityDelivery(
    original,
    1000,
    1000,
    (d) => (typeof d.value === "string" ? d.value.length : 0) <= 1000
  );

  assert.ok(delivery !== null);
  assert.equal(delivery.contract, OM_CAPACITY_DELIVERY_CONTRACT);
  assert.deepEqual(delivery.original.record, packetRef);
  assert.equal(delivery.original.pointer, "/read_context/data");
  assert.equal(delivery.original.valueHash, hashJson(text));
  assert.equal(delivery.served.unit, "utf16");
  assert.equal(delivery.served.total, text.length);
  assert.equal(delivery.served.offset, 0);
  assert.equal(delivery.served.end, text.length);
  assert.equal(delivery.served.next, null);
  assert.equal(delivery.value, text);

  // Validate with requireOmCapacityDelivery
  requireOmCapacityDelivery(original, delivery);
});

test("Capacity delivery planner: multi-page pagination for large text with surrogate pairs", () => {
  const packetRef: Ref = { id: "packet:test:1", revision: 1, hash: "a".repeat(64) };
  const emoji = "🚀🌟🎉🔥";
  const text = "Prefix_".repeat(20) + emoji + "_Suffix_".repeat(20);

  const pages: string[] = [];
  let pageOffset = 0;
  const pageSize = 50;

  for (let i = 0; i < 20; i++) {
    const original: AddressedOmOriginal = {
      record: packetRef,
      pointer: "/sources/0/content",
      value: text,
      page: { offset: pageOffset, end: text.length, total: text.length, unit: "utf16", next: pageOffset },
    };

    const delivery = planOmCapacityDelivery(
      original,
      pageSize,
      pageSize,
      (d) => (typeof d.value === "string" ? d.value.length : 0) <= pageSize
    );

    assert.ok(delivery !== null);
    requireOmCapacityDelivery(original, delivery);
    assert.equal(typeof delivery.value, "string");
    pages.push(delivery.value as string);

    if (delivery.served.next === null) break;
    assert.ok(delivery.served.next > pageOffset, "Next offset must strictly advance");
    pageOffset = delivery.served.next;
  }

  const reconstructed = pages.join("");
  assert.equal(reconstructed, text);
  assert.ok(pages.length > 1, "Should have been split into multiple pages");
});

test("Capacity delivery planner: multi-page pagination for arrays", () => {
  const packetRef: Ref = { id: "packet:test:1", revision: 1, hash: "b".repeat(64) };
  const items = Array.from({ length: 25 }, (_, i) => ({ id: i, label: `Item #${i}`, payload: "X".repeat(50) }));

  const collected: unknown[] = [];
  let pageOffset = 0;
  const maxItemsPerPage = 5;

  for (let step = 0; step < 30; step++) {
    const original: AddressedOmOriginal = {
      record: packetRef,
      pointer: "/matches",
      value: items,
      page: { offset: pageOffset, end: items.length, total: items.length, unit: "items", next: pageOffset },
    };

    const delivery = planOmCapacityDelivery(
      original,
      500,
      500,
      (d) => (Array.isArray(d.value) ? d.value.length : 0) <= maxItemsPerPage
    );

    assert.ok(delivery !== null);
    requireOmCapacityDelivery(original, delivery);
    assert.equal(delivery.served.unit, "items");
    assert.ok(Array.isArray(delivery.value));
    collected.push(...(delivery.value as unknown[]));

    if (delivery.served.next === null) break;
    assert.ok(delivery.served.next > pageOffset, "Array offset must strictly advance");
    pageOffset = delivery.served.next;
  }

  assert.deepEqual(collected, items);
});

test("RD3: a whole-array JSON fragment advances on the same canonical original", () => {
  const record: Ref = { id: "om-read-delivery:test:array", revision: 1, hash: "f".repeat(64) };
  const value = [{ text: "X".repeat(8000) }];
  const original: AddressedOmOriginal = { record, pointer: "/data", value };
  const fits = (delivery: { text?: string; value?: unknown }) =>
    delivery.text !== undefined ? delivery.text.length <= 500 :
      !Array.isArray(delivery.value) || canonical(delivery.value as Json).length <= 500;
  const first = planOmCapacityDelivery(original, 1000, 1000, fits);
  assert.ok(first);
  requireOmCapacityDelivery(original, first);
  assert.equal(first.original.pointer, "/data");
  assert.equal(first.original.valueHash, hashJson(value));
  assert.equal(first.served.unit, "utf16");
  assert.ok(first.served.next !== null);
  const secondOriginal: AddressedOmOriginal = { ...original,
    page: { offset: first.served.next, end: first.served.total, total: first.served.total, unit: "utf16", next: null } };
  const second = planOmCapacityDelivery(secondOriginal, 1000, 1000, fits);
  assert.ok(second);
  requireOmCapacityDelivery(secondOriginal, second);
  assert.equal(second.served.offset, first.served.next);
  assert.equal(second.text, readOmContextPage({ data: value }, "/data",
    { offset: second.served.offset, end: second.served.end, total: second.served.total, unit: "utf16" }));
  assert.equal(first.text! + second.text!, canonical(value as Json).slice(0, second.served.end));
});

test("RD3: an oversized selected array item keeps one pointer and one UTF-16 cursor through exact rereads", () => {
  const record: Ref = { id: "om-read-delivery:test:1", revision: 1, hash: "d".repeat(64) };
  const data = [{ checkpoint: "UNREQUESTED_PREFIX" }, { checkpoint: "V".repeat(8000) }];
  const original: AddressedOmOriginal = { record, pointer: "/data", value: data,
    page: { offset: 1, end: 2, total: 2, unit: "items", next: null } };
  const fits = (delivery: { text?: string; value?: unknown }) =>
    delivery.text !== undefined ? delivery.text.length <= 500 :
      !Array.isArray(delivery.value) || canonical(delivery.value as Json).length <= 500;
  const first = planOmCapacityDelivery(original, 1000, 1000, fits);
  assert.ok(first);
  requireOmCapacityDelivery(original, first);
  assert.equal(first.original.pointer, "/data/1");
  assert.equal(first.original.valueHash, hashJson(data[1]));
  assert.equal(first.served.unit, "utf16");
  assert.equal(first.served.offset, 0);
  assert.ok(first.served.next !== null);
  assert.equal(first.text, readOmContextPage({ data }, first.original.pointer,
    { offset: first.served.offset, end: first.served.end, total: first.served.total, unit: "utf16" }));
  const fragments = [first.text!];
  let next: number | null = first.served.next;
  for (let step = 0; next !== null && step < 100; step++) {
    const source: AddressedOmOriginal = { record, pointer: first.original.pointer, value: data[1],
      page: { offset: next, end: first.served.total, total: first.served.total, unit: "utf16", next: null } };
    const fragment = planOmCapacityDelivery(source, 1000, 1000, fits);
    assert.ok(fragment);
    requireOmCapacityDelivery(source, fragment);
    assert.equal(fragment.original.pointer, first.original.pointer);
    assert.equal(fragment.text, readOmContextPage({ data }, fragment.original.pointer,
      { offset: fragment.served.offset, end: fragment.served.end, total: fragment.served.total, unit: "utf16" }));
    fragments.push(fragment.text!);
    next = fragment.served.next;
  }
  assert.equal(next, null, "The declared next cursor reaches the end of its exact item");
  assert.equal(fragments.join(""), canonical(data[1] as Json));
  assert.ok(!fragments.join("").includes("UNREQUESTED_PREFIX"));
});

test("RD3: carried reads and their omitted notice fit the final adapter wire", () => {
  const ref: Ref = { id: "om-read-delivery:test:2", revision: 1, hash: "e".repeat(64) };
  const requestId = "capacity-carried";
  const packet = { version: BRIEF_VERSION, requestId, responseForm: { protocol: 'omg-answer/v3', requestId, schema: {} },
    brief: { contract: 'om-brief/v1', requestId, text: 'Base with escaped \"quotes\"\n',
      labels: [], manifest: [], references: [], examples: [] } };
  const carried: CarriedBasis = { snapshots: [], entries: [{
    origins: [{ kind: "part", position: 0, packet: ref, call: ref, response: ref, delivery: ref, questionIds: [] }],
    read: { action: "read", path: "src/main.ts", media: "text/plain" }, sources: [ref],
    data: "RD3_CARRIED_VALUE_".repeat(100), decision: { state: "eligible" },
  }] };
  const unlimited = withReadings(packet, carried, 100000);
  const limit = measureAdapterWire(unlimited, requestId) - 1;
  assert.ok(measureAdapterWire(packet, requestId) < limit);
  assert.ok(packetPrompt(unlimited).length <= limit, "The old prompt-only check would accept this packet");
  const fitted = withReadings(packet, carried, limit, value => measureAdapterWire(value, requestId) <= limit);
  assert.ok(measureAdapterWire(fitted, requestId) <= limit);
  assert.equal(fitted.brief.readings.entries[0].decision.state, "omitted");
  assert.equal(fitted.brief.text.includes("RD3_CARRIED_VALUE_"), false);
});

test("Capacity delivery planner: large scalar/object chunking", () => {
  const packetRef: Ref = { id: "packet:test:1", revision: 1, hash: "c".repeat(64) };
  const largeObject = {
    nested: { field: "V".repeat(500), number: 12345 },
    extra: "E".repeat(500),
  };
  const maxChunk = 200;

  const original: AddressedOmOriginal = {
    record: packetRef,
    pointer: "/response",
    value: largeObject,
  };

  const delivery = planOmCapacityDelivery(
    original,
    maxChunk,
    maxChunk,
    (d) => (d.text ? d.text.length : 0) <= maxChunk
  );

  assert.ok(delivery !== null);
  requireOmCapacityDelivery(original, delivery);
  assert.equal(delivery.encoding, "json-string-fragment");
  assert.equal(delivery.served.unit, "utf16");
  assert.ok(delivery.text && delivery.text.length <= maxChunk);
  assert.equal(delivery.text, canonical(largeObject as unknown as Json).slice(0, delivery.served.end));
});

test("measureAdapterWire and fitsWire accurately track full serialized size", () => {
  const packet = { question: "What is the answer?", context: "A".repeat(500) };
  const requestId = "req-12345";
  const wireSize = measureAdapterWire(packet, requestId);
  assert.ok(wireSize > 500, "Wire size must include JSON syntax, keys, and values");
  assert.ok(fitsWire(packet, requestId, wireSize));
  assert.ok(!fitsWire(packet, requestId, wireSize - 1));
});

test("requireOmCapacityDelivery rejects invalid delivery shapes", () => {
  const packetRef: Ref = { id: "packet:test:1", revision: 1, hash: "a".repeat(64) };
  const original: AddressedOmOriginal = {
    record: packetRef,
    pointer: "/data",
    value: "hello",
  };
  const valid = planOmCapacityDelivery(original, 1000, 1000, () => true);
  assert.ok(valid !== null);

  // Invalid contract
  assert.throws(
    () => requireOmCapacityDelivery(original, { ...valid, contract: "wrong-contract" as never }),
    (err: unknown) => err instanceof EngineError && err.code === "om_capacity_delivery_invalid"
  );

  // Missing packet record
  assert.throws(
    () => requireOmCapacityDelivery(original, { ...valid, original: { ...valid.original, record: null as never } }),
    (err: unknown) => err instanceof EngineError && err.code === "om_capacity_delivery_invalid"
  );

  // Mismatched pointer
  assert.throws(
    () => requireOmCapacityDelivery(original, { ...valid, original: { ...valid.original, pointer: "/other" } }),
    (err: unknown) => err instanceof EngineError && err.code === "om_capacity_delivery_invalid"
  );

  // Mismatched value hash
  assert.throws(
    () => requireOmCapacityDelivery(original, { ...valid, original: { ...valid.original, valueHash: "wrong" } }),
    (err: unknown) => err instanceof EngineError && err.code === "om_capacity_delivery_invalid"
  );

  const linked = { ...original, packet: packetRef, delivery: packetRef };
  const linkedPage = planOmCapacityDelivery(linked, 1000, 1000, () => true)!;
  assert.throws(
    () => requireOmCapacityDelivery(linked, { ...linkedPage, original: { ...linkedPage.original,
      delivery: { ...packetRef, hash: "b".repeat(64) } } }),
    (err: unknown) => err instanceof EngineError && err.code === "om_capacity_delivery_invalid"
  );
});

test("recover-om-capacity: validation, rejection of non-blocked and non-capacity packets", (t) => {
  const { store } = fixtureStore(t);
  const project = "garden";

  // Create project record and running om-run
  store.writeMany([
    {
      id: `project:${project}`,
      kind: "project",
      expected: 0,
      value: { id: project, title: "Garden project" },
    },
    {
      id: `om-run:${project}`,
      kind: "om-run",
      expected: 0,
      value: { state: { phase: "waiting" } },
    },
  ]);

  const engine = new ProductEngine(store);

  // 1. Missing packet
  assert.throws(
    () => engine.execute({ type: "recover-om-capacity", project, packet: { id: "packet:nonexistent", revision: 1, hash: "0".repeat(64) } } as never),
    (err: unknown) => err instanceof EngineError && err.code === "capacity_recovery_invalid"
  );

  // 2. Non-blocked packet
  const [readyPacketRev] = store.writeMany([
    {
      id: `question-packet:${project}:1`,
      kind: "question-packet",
      expected: 0,
      value: {
        project,
        state: "ready",
        refusal: null,
        request: {
          project,
          routes: { id: "routes:1", revision: 1, hash: "1".repeat(64) },
          batch: "b1",
          environment: { id: "env", revision: 1, hash: "1".repeat(64) },
          attempt: null,
          previous: [],
        },
      },
    },
  ]);
  const readyPacketRef = reference(readyPacketRev!);

  assert.throws(
    () => engine.execute({ type: "recover-om-capacity", project, packet: readyPacketRef } as never),
    (err: unknown) => err instanceof EngineError && err.code === "capacity_recovery_invalid"
  );

  // 3. Blocked packet with non-capacity refusal
  const [otherBlockedRev] = store.writeMany([
    {
      id: `question-packet:${project}:2`,
      kind: "question-packet",
      expected: 0,
      value: {
        project,
        state: "blocked",
        refusal: { code: "packet_chain_invalid", message: "Invalid chain", at: { unit: "E2", target: "b1" }, route: "producer" },
        request: {
          project,
          routes: { id: "routes:1", revision: 1, hash: "1".repeat(64) },
          batch: "b1",
          environment: { id: "env", revision: 1, hash: "1".repeat(64) },
          attempt: null,
          previous: [],
        },
      },
    },
  ]);
  const otherBlockedRef = reference(otherBlockedRev!);

  assert.throws(
    () => engine.execute({ type: "recover-om-capacity", project, packet: otherBlockedRef } as never),
    (err: unknown) => err instanceof EngineError && err.code === "capacity_recovery_unsupported"
  );
});

test("recover-om-capacity: recovers capacity-blocked packet and ensures idempotency", (t) => {
  const { store } = fixtureStore(t);
  const project = "garden";

  store.writeMany([
    {
      id: `project:${project}`,
      kind: "project",
      expected: 0,
      value: { id: project, title: "Garden project" },
    },
    {
      id: `om-run:${project}`,
      kind: "om-run",
      expected: 0,
      value: { state: { phase: "waiting" } },
    },
  ]);

  // Write a blocked question-packet with packet_too_large
  const [blockedRev] = store.writeMany([
    {
      id: `question-packet:${project}:blocked`,
      kind: "question-packet",
      expected: 0,
      value: {
        project,
        contract: "question-packet/v1",
        state: "blocked",
        refusal: { code: "packet_too_large", message: "Packet exceeds capacity limit 20000 chars", at: { unit: "E2", target: "batch:test:1" }, route: "producer" },
        request: {
          project,
          routes: { id: "routes:1", revision: 1, hash: "1".repeat(64) },
          batch: "batch:test:1",
          environment: { id: "env:test", revision: 1, hash: "1".repeat(64) },
          attempt: null,
          previous: [],
        },
      },
    },
  ]);
  const blockedRef = reference(blockedRev!);

  // Successor packet mock deriver for isolated command testing
  const successorPacketRef: Ref = { id: `question-packet:${project}:successor`, revision: 1, hash: "9".repeat(64) };
  registerSuccessorDeriver({
    deriveCapacitySuccessorPacket: (_s, p, _blocked, _actor) => {
      const mockRecord: Revision<QuestionPacketRecord> = {
        id: successorPacketRef.id,
        kind: "question-packet",
        revision: 1,
        hash: successorPacketRef.hash,
        value: {
          project: p,
          state: "ready",
          refusal: null,
          request: {
            project: p,
            routes: { id: "routes:1", revision: 1, hash: "1".repeat(64) },
            batch: "batch:test:1",
            environment: { id: "env:test", revision: 1, hash: "1".repeat(64) },
            attempt: null,
            previous: [],
          },
          packet: null,
          fingerprint: null,
          native: [],
          plan: null,
          fullChars: null,
          journal: null,
        },
      };
      return {
        reference: successorPacketRef,
        writes: [{
          id: successorPacketRef.id,
          kind: "question-packet",
          expected: 0,
          value: mockRecord.value as unknown as Json,
        }],
        guards: [],
        record: mockRecord,
      };
    },
  });

  const engine = new ProductEngine(store);

  // Execute recover-om-capacity
  const recovery1 = engine.execute({
    type: "recover-om-capacity",
    project,
    packet: blockedRef,
  }) as OmCapacityRecoveryRecord;

  assert.ok(recovery1);
  assert.equal(recovery1.contract, OM_CAPACITY_RECOVERY_CONTRACT);
  assert.deepEqual(recovery1.blockedPacket, blockedRef);
  assert.deepEqual(recovery1.successorPacket, successorPacketRef);
  assert.equal(recovery1.actor, "local-caller");

  // Successor packet record was written to store
  const writtenSuccessor = store.get(successorPacketRef.id);
  assert.ok(writtenSuccessor);

  // Idempotency: repeated call returns identical recovery record
  const recovery2 = engine.execute({
    type: "recover-om-capacity",
    project,
    packet: blockedRef,
  }) as OmCapacityRecoveryRecord;

  assert.deepEqual(recovery1, recovery2);

  // Store lookup helper
  const readRec = readOmCapacityRecovery(store, project, blockedRef);
  assert.ok(readRec);
  assert.deepEqual(readRec, recovery1);
});

test("recover-om-capacity: throws needs_owner when irreducible core exceeds capacity", (t) => {
  const { store } = fixtureStore(t);
  const project = "garden";

  store.writeMany([
    {
      id: `project:${project}`,
      kind: "project",
      expected: 0,
      value: { id: project, title: "Garden project" },
    },
    {
      id: `om-run:${project}`,
      kind: "om-run",
      expected: 0,
      value: { state: { phase: "waiting" } },
    },
  ]);

  const [blockedRev] = store.writeMany([
    {
      id: `question-packet:${project}:huge-blocked`,
      kind: "question-packet",
      expected: 0,
      value: {
        project,
        contract: "question-packet/v1",
        state: "blocked",
        refusal: { code: "packet_too_large", message: "Packet exceeds capacity", at: { unit: "E2", target: "batch:test:huge" }, route: "producer" },
        request: {
          project,
          routes: { id: "routes:1", revision: 1, hash: "1".repeat(64) },
          batch: "batch:test:huge",
          environment: { id: "env:test", revision: 1, hash: "1".repeat(64) },
          attempt: null,
          previous: [],
        },
      },
    },
  ]);
  const blockedRef = reference(blockedRev!);

  // Successor packet mock deriver that returns a blocked packet because irreducible core exceeds capacity
  registerSuccessorDeriver({
    deriveCapacitySuccessorPacket: (_s, p, _blocked, _actor) => {
      const mockRecord: Revision<QuestionPacketRecord> = {
        id: `question-packet:${p}:successor-failed`,
        kind: "question-packet",
        revision: 1,
        hash: "e".repeat(64),
        value: {
          project: p,
          state: "blocked",
          refusal: { code: "packet_too_large", message: "Irreducible core exceeds available capacity 1000: required 50000", at: { unit: "E2", target: "batch:test:huge" }, route: "producer" },
          request: {
            project: p,
            routes: { id: "routes:1", revision: 1, hash: "1".repeat(64) },
            batch: "batch:test:huge",
            environment: { id: "env:test", revision: 1, hash: "1".repeat(64) },
            attempt: null,
            previous: [],
          },
          packet: null,
          fingerprint: null,
          native: [],
          plan: null,
          fullChars: null,
          journal: null,
        },
      };
      return {
        reference: reference(mockRecord),
        writes: [],
        guards: [],
        record: mockRecord,
      };
    },
  });

  const engine = new ProductEngine(store);

  assert.throws(
    () => engine.execute({ type: "recover-om-capacity", project, packet: blockedRef }),
    (err: unknown) => {
      assert.ok(err instanceof EngineError);
      assert.equal(err.code, "needs_owner");
      assert.match(err.message, /Irreducible core/);
      assert.equal((err.details as Record<string, unknown>).assignment, "batch:test:huge");
      return true;
    }
  );
});

test("permit-limited-call-retry: validation, finishReason checks, and idempotency", (t) => {
  const { store } = fixtureStore(t);
  const project = "garden";

  store.writeMany([
    {
      id: `project:${project}`,
      kind: "project",
      expected: 0,
      value: { id: project, title: "Garden project" },
    },
    {
      id: `om-run:${project}`,
      kind: "om-run",
      expected: 0,
      value: { state: { phase: "waiting" } },
    },
  ]);

  const engine = new ProductEngine(store);

  // 1. Missing call
  assert.throws(
    () => engine.execute({ type: "permit-limited-call-retry", project, call: { id: "call:nonexistent", revision: 1, hash: "0".repeat(64) } } as never),
    (err: unknown) => err instanceof EngineError && err.code === "limited_call_retry_stale"
  );

  // 2. Call not finished with process_output_limit
  const [normalCallRev] = store.writeMany([
    {
      id: `model-call:${project}:normal`,
      kind: "model-call",
      expected: 0,
      value: {
        projectId: project,
        status: "finished",
        finishReason: "process_exit",
        execution: { phase: "finished" },
        om: { admission: { root: { id: "root:1", revision: 1, hash: "1".repeat(64) } } },
      },
    },
  ]);
  const normalCallRef = reference(normalCallRev!);

  assert.throws(
    () => engine.execute({ type: "permit-limited-call-retry", project, call: normalCallRef } as never),
    (err: unknown) => err instanceof EngineError && err.code === "limited_call_retry_invalid"
  );

  // 3. Active running call in project causes limited_call_retry_busy
  const realStarted = processStart(process.pid) ?? new Date().toISOString();
  const [activeCallRev, targetCallRev] = store.writeMany([
    {
      id: `model-call:${project}:active-running`,
      kind: "model-call",
      expected: 0,
      value: {
        projectId: project,
        status: "running",
        ownerProcess: { pid: process.pid, started: realStarted },
      },
    },
    {
      id: `model-call:${project}:target-under-busy`,
      kind: "model-call",
      expected: 0,
      value: {
        projectId: project,
        status: "failed",
        error: "process_output_limit",
        finishReason: "process_output_limit",
        execution: { phase: "finished" },
        om: { admission: { root: { id: "root:1", revision: 1, hash: "1".repeat(64) } } },
      },
    },
  ]);

  assert.throws(
    () => engine.execute({ type: "permit-limited-call-retry", project, call: reference(targetCallRev!) } as never),
    (err: unknown) => err instanceof EngineError && err.code === "limited_call_retry_busy"
  );

  // Mark active call completed so busy check clears
  store.write({
    id: activeCallRev!.id,
    kind: "model-call",
    expected: activeCallRev!.revision,
    value: { ...(activeCallRev!.value as Record<string, unknown>), status: "finished" },
  });

  // 4. Valid output-limited call
  const [limitedCallRev] = store.writeMany([
    {
      id: `model-call:${project}:limited`,
      kind: "model-call",
      expected: 0,
      value: {
        projectId: project,
        status: "failed",
        error: "process_output_limit",
        finishReason: "process_output_limit",
        execution: { phase: "finished" },
        om: { admission: { root: { id: "root:1", revision: 1, hash: "1".repeat(64) } } },
      },
    },
  ]);
  const limitedCallRef = reference(limitedCallRev!);

  const permit1 = engine.execute({
    type: "permit-limited-call-retry",
    project,
    call: limitedCallRef,
  }) as OmLimitedCallRetryPermit;

  assert.ok(permit1);
  assert.equal(permit1.contract, OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT);
  assert.deepEqual(permit1.call, limitedCallRef);
  assert.equal(permit1.project, project);
  assert.equal(permit1.actor, "local-caller");

  // Idempotency
  const permit2 = engine.execute({
    type: "permit-limited-call-retry",
    project,
    call: limitedCallRef,
  }) as OmLimitedCallRetryPermit;

  assert.deepEqual(permit1, permit2);

  // Store lookup helper
  const readPermit = readOmLimitedCallRetryPermit(store, project, limitedCallRef);
  assert.ok(readPermit);
  assert.deepEqual(readPermit, permit1);
});

test("recoveredSuccessorPacket follows chain of recoveries", (t) => {
  const { store } = fixtureStore(t);
  const project = "garden";

  const p1: Ref = { id: `question-packet:${project}:p1`, revision: 1, hash: "1".repeat(64) };
  const p2: Ref = { id: `question-packet:${project}:p2`, revision: 1, hash: "2".repeat(64) };
  const p3: Ref = { id: `question-packet:${project}:p3`, revision: 1, hash: "3".repeat(64) };

  // p1 -> p2
  store.writeMany([
    {
      id: `om-capacity-recovery:${project}:${hashJson(p1)}`,
      kind: "om-capacity-recovery",
      expected: 0,
      value: {
        contract: OM_CAPACITY_RECOVERY_CONTRACT,
        project,
        blockedPacket: p1,
        successorPacket: p2,
        actor: "operator",
        recoveredAt: Date.now(),
      },
    },
    // p2 -> p3
    {
      id: `om-capacity-recovery:${project}:${hashJson(p2)}`,
      kind: "om-capacity-recovery",
      expected: 0,
      value: {
        contract: OM_CAPACITY_RECOVERY_CONTRACT,
        project,
        blockedPacket: p2,
        successorPacket: p3,
        actor: "operator",
        recoveredAt: Date.now(),
      },
    },
  ]);

  const mockWork = { products: [] } as never;
  const successor = recoveredSuccessorPacket(store, project, mockWork, p1);
  assert.deepEqual(successor, p3);
});

test("FSCK and Reference-Sites: written recovery and permit records have 0 integrity findings", (t) => {
  const { store } = fixtureStore(t);
  const project = "garden";

  // Pre-create dependencies so references are valid
  const [envRev, routesRev, rootRev] = store.writeMany([
    {
      id: `project:${project}`,
      kind: "project",
      expected: 0,
      value: { id: project, title: "Garden project" },
    },
    {
      id: `om-run:${project}`,
      kind: "om-run",
      expected: 0,
      value: { state: { phase: "waiting" } },
    },
    {
      id: `env:fsck`,
      kind: "environment",
      expected: 0,
      value: { project, config: {} },
    },
    {
      id: `routes:1`,
      kind: "routes",
      expected: 0,
      value: { project, batches: [] },
    },
    {
      id: `root:1`,
      kind: "completion-root",
      expected: 0,
      value: { project },
    },
  ]);

  const envRef = reference(envRev!);
  const routesRef = reference(routesRev!);
  const rootRef = reference(rootRev!);

  const [blockedRev, callRev] = store.writeMany([
    {
      id: `question-packet:${project}:fsck-test`,
      kind: "question-packet",
      expected: 0,
      value: {
        project,
        contract: "question-packet/v1",
        state: "blocked",
        refusal: { code: "packet_too_large", message: "too large", at: { unit: "E2", target: "batch:fsck" }, route: "producer" },
        request: {
          project,
          routes: routesRef,
          batch: "batch:fsck",
          environment: envRef,
          attempt: null,
          previous: [],
        },
      },
    },
    {
      id: `model-call:${project}:fsck-test`,
      kind: "model-call",
      expected: 0,
      value: {
        projectId: project,
        status: "failed",
        error: "process_output_limit",
        execution: { phase: "finished" },
        om: { admission: { root: rootRef } },
      },
    },
  ]);

  registerSuccessorDeriver({
    deriveCapacitySuccessorPacket: (s, p, _blocked, _actor) => {
      const succValue = {
        project: p,
        state: "ready" as const,
        refusal: null,
        request: {
          project: p,
          routes: routesRef,
          batch: "batch:fsck",
          environment: envRef,
          attempt: null,
          previous: [],
        },
        packet: null,
        fingerprint: null,
        native: [],
        plan: null,
        fullChars: null,
        journal: null,
      };
      const [written] = s.writeMany([{
        id: `question-packet:${p}:fsck-succ`,
        kind: "question-packet",
        expected: 0,
        value: succValue as unknown as Json,
      }]);
      return {
        reference: reference(written!),
        writes: [],
        guards: [],
        record: written! as unknown as Revision<QuestionPacketRecord>,
      };
    },
  });

  const engine = new ProductEngine(store);
  engine.execute({ type: "recover-om-capacity", project, packet: reference(blockedRev!) });
  engine.execute({ type: "permit-limited-call-retry", project, call: reference(callRev!) });

  // Verify referenceSites on recovery records
  const recoveryRow = store.list("om-capacity-recovery")[0]!;
  const recoverySites = referenceSites("om-capacity-recovery", recoveryRow.value);
  assert.ok(recoverySites.some(s => s.field === "blockedPacket" && s.ref.id === blockedRev!.id));
  assert.ok(recoverySites.some(s => s.field === "successorPacket"));

  // Store integrity check
  const fsck = checkStoreIntegrity(store);
  assert.equal(fsck.findings.length, 0, `Store fsck findings should be 0, got: ${JSON.stringify(fsck.findings)}`);
});

test("RD3: a recovered blocked root executes its exact successor once, including after a cold restart", async (t) => {
  // Earlier command tests install a mock deriver; this scenario exercises the real packet producer.
  registerSuccessorDeriver({ deriveCapacitySuccessorPacket });
  // Reuse the real managed-pass fixture without registering the neighbouring suite's tests.
  const module = new URL(`./.rd3-run-fixture-${process.pid}.mjs`, import.meta.url);
  const source = readFileSync(new URL("./om-run.test.js", import.meta.url), "utf8")
    .replace(/import test from ["']node:test["'];/, "const test = () => {};");
  writeFileSync(module, `${source}\nexport { runFixture, addressAll };\n`);
  t.after(() => rmSync(module, { force: true }));
  const { runFixture, addressAll } = await import(module.href);
  const f = runFixture(t, ["encoding"]);
  const bases = f.bases();
  f.environment(5_000);
  f.steps([addressAll(f, bases.routes)]);
  const started = startRun(f.store, { project: "garden" });
  assert.equal(started.ok, true);

  let waiting = false;
  for (let i = 0; i < 15; i++) {
    const step = await advanceRun(f.store, f.request());
    if (!step.ok) assert.fail(`${step.refusal.code}: ${step.refusal.message}`);
    if (step.value.record.value.state.phase === "waiting") { waiting = true; break; }
  }
  assert.equal(waiting, true, "The real root first stops on its proved capacity refusal");
  const blocked = (f.store.list("question-packet") as Revision<QuestionPacketRecord>[])
    .find(row => row.value.state === "blocked");
  assert.ok(blocked && blocked.value.refusal?.code === "packet_too_large");

  f.environment(500_000);
  const recovery = f.engine.execute({ type: "recover-om-capacity", project: "garden", packet: reference(blocked) }) as OmCapacityRecoveryRecord;
  const successor = f.store.get(recovery.successorPacket.id, recovery.successorPacket.revision) as Revision<QuestionPacketRecord> | undefined;
  assert.ok(successor && successor.value.state === "ready");
  const completions = (f.store.list("om-completion-packet") as Revision<{ root: Ref; packet: Ref }>[])
    .filter(row => [blocked.id, successor.id].includes(row.value.packet.id));
  assert.equal(completions.length, 2, "The blocked root and its successor are two real products of one assignment");
  assert.deepEqual(completions[0]!.value.root, completions[1]!.value.root);
  assert.deepEqual(cycleStartOf(f.store, "garden", completions.map(row => row.value.packet)),
    { ok: true, value: reference(blocked) }, "The recovery is a step of the blocked root's cycle");

  let cycled = false;
  for (let i = 0; i < 20; i++) {
    const step = await advanceRun(f.store, f.request());
    if (!step.ok) assert.fail(`${step.refusal.code}: ${step.refusal.message}`);
    if (step.value.performed?.action === "cycle") { cycled = true; break; }
  }
  assert.equal(cycled, true, "The pass actually dispatches the successor");
  const cycles = f.store.list("om-model-cycle") as Revision<{ request: { packet: Ref } }>[];
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]!.value.request.packet, recovery.successorPacket);
  assert.equal(f.sent().length, 1, "Only the successor paid for a model call");

  f.restart();
  assert.deepEqual(f.engine.execute({ type: "recover-om-capacity", project: "garden", packet: reference(blocked) }), recovery);
  for (let i = 0; i < 3; i++) {
    const step = await advanceRun(f.store, f.request());
    if (!step.ok) assert.fail(`${step.refusal.code}: ${step.refusal.message}`);
    if (step.value.performed?.action === "close") break;
  }
  assert.equal(f.sent().length, 1, "Cold continuation never repays the recovered cycle");
  assert.equal(f.store.list("om-model-cycle").length, 1);
});

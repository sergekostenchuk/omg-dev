import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Store, observeStore, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import {
  REQUEST_MANIFEST_CONTRACT,
  REQUEST_PART_CONTRACT,
  REQUEST_MANIFEST_KIND,
  REQUEST_PART_KIND,
  requestPartId,
  partitionResearchWire,
  prepareRequestPartsAndManifest,
  readRequestWire,
  type RequestPart,
  type RequestManifest,
  type ResearchEnvelopeFrame,
} from "../src/discovery/request-parts.js";
import { researchCall, prepareResearchEnvelope } from "../src/discovery/research-protocol.js";
import {
  prepareResearchConsumerIntent,
  resumeResearchConsumerExecution,
  readResearchConsumerExecution,
  type ResearchConsumerIntent,
} from "../src/discovery/response-recovery.js";
import { uniqueTransactionGuards } from "../src/runtime/environment.js";
import { configureReaderPilot } from "../src/discovery/reader-pilot.js";
import { pilotContext } from "../src/discovery/pilot-context.js";
import { preparedFeatures } from "./product-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { projectGraph } from "../src/graph/project.js";
import { digest, hashJson } from "../src/canonical.js";
import { reference, isRef } from "../src/pipeline/contracts.js";
import type { Question } from "../src/discovery/discovery.js";
import type { ModelCall } from "../src/runtime/model-usage.js";
import type { ResearchRun, ResearchTurn } from "../src/discovery/research-model.js";


function setupFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-"));
  const store = new Store(join(root, "state.sqlite"));
  const engine = new ProductEngine(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const full = enrichedGraph(exampleGraph("p"), "p");
  preparedFeatures(engine, "p", full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save("p", initial, store.get("graph:p")!.revision, "fixture");

  const counterPath = join(root, "adapter-launches.log");
  const adapterPath = join(root, "adapter.mjs");
  writeFileSync(
    adapterPath,
    `import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(counterPath)}, 'launch\\n');
const raw = readFileSync(0, 'utf8');
const r = JSON.parse(raw);
const research = {
  action: 'checkpoint',
  question: r.subject.question.id,
  value: { note: 'DRS1a verified execution' },
  citations: [],
  unresolved: ['Next phase']
};
console.log(JSON.stringify({
  protocol: r.protocol,
  requestId: r.requestId,
  research,
  usage: { inputTokens: 42, outputTokens: 12, cachedInputTokens: 0, reasoningOutputTokens: 0 }
}));`
  );

  const command = { executable: process.execPath, args: [adapterPath] };
  const environment = engine.environments.configure("p", {
    workspace: root,
    implementer: { actor: "author", model: "fixture-author", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture-assessor", effort: "high", command },
    fullCheck: command,
    timeoutMs: 5000,
  }, 0);

  const pilot = configureReaderPilot(store, engine.environments, "p", {
    experimental: true,
    active: true,
    stopAfter: "L2",
    reader: { actor: "reader", model: "fixture-reader", effort: "high", speed: "inherited", command },
    agentCommand: command,
    maxCalls: 10,
    maxReportedTokens: 100000,
    maxRequestChars: 100000,
    maxReadChars: 50000,
    maxReplyChars: 10000,
  }, 0);

  const r0 = engine.refinement.begin("p", "R0");
  engine.refinement.finishResearch("p", "R0", reference(r0), 0);
  engine.refinement.sealLayer("p", 1, 0);

  const draft = engine.refinement.begin("p", "R1");
  const question = store.get<Question>(draft.value.questions[0]!)!;

  return { root, store, engine, environment, pilot, draft, question, adapterPath, counterPath };
}

function countAdapterLaunches(counterPath: string): number {
  if (!existsSync(counterPath)) return 0;
  return readFileSync(counterPath, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
}

function captureSnapshot(store: Store) {
  const modelCalls = store.list<ModelCall>("model-call").map((c) => ({
    id: c.id,
    revision: c.revision,
    status: c.value.status,
    error: c.value.error ?? null,
    hasResponse: isRef(c.value.response?.record),
  }));
  const manifests = store.list<RequestManifest>(REQUEST_MANIFEST_KIND).map((m) => ({
    id: m.id,
    revision: m.revision,
    partsCount: m.value.parts.length,
  }));
  const parts = store.list<RequestPart>(REQUEST_PART_KIND).map((p) => ({
    id: p.id,
    revision: p.revision,
  }));
  const legacyRequests = store.list("model-request").map((r) => ({
    id: r.id,
    revision: r.revision,
  }));
  const consumerIntents = store.list<ResearchConsumerIntent>("research-consumer-intent").map((i) => ({
    id: i.id,
    revision: i.revision,
    state: i.value.state,
    outputsCount: i.value.outputs?.length ?? 0,
  }));
  const projectDispatches = store.list<any>("project-dispatch").map((d) => ({
    id: d.id,
    revision: d.revision,
    serial: d.value.serial,
  }));
  const questionDispatches = store.list<any>("question-dispatch").map((d) => ({
    id: d.id,
    revision: d.revision,
    serial: d.value.serial,
  }));
  return {
    pilotDispatches: store.list("pilot-dispatch"),
    measuredUsage: store.list<ModelCall>("model-call").map((c) => ({ id: c.id, usage: c.value.usage })),
    modelCalls,
    manifests,
    parts,
    legacyRequests,
    consumerIntents,
    projectDispatches,
    questionDispatches,
  };
}

async function prepareStandardRunAndIntent(
  f: ReturnType<typeof setupFixture>
): Promise<{ run: Revision<ResearchRun>; intent: Revision<ResearchConsumerIntent> }> {
  const origWriteMany = f.store.writeMany.bind(f.store);
  let captured: Revision<ResearchConsumerIntent> | null = null;
  f.store.writeMany = ((writes: any, guards: any): any => {
    if (captured && writes.some((w: any) => w.kind === "research-run")) throw new Error("INTENT_PREPARED_STOP");
    const res = origWriteMany(writes, guards);
    const found = writes.find((w: any) => w.kind === "research-consumer-intent");
    if (found) {
      captured = f.store.get<ResearchConsumerIntent>(found.id)!;
      throw new Error("INTENT_PREPARED_STOP");
    }
    return res;
  }) as any;
  try {
    await f.engine.researcher.run("p", f.draft.id, 1);
  } catch (e: any) {
    if (e?.message !== "INTENT_PREPARED_STOP") throw e;
  } finally {
    f.store.writeMany = origWriteMany;
  }
  const run = f.store.get<ResearchRun>(captured!.value.owner.id)!;
  return { run: f.store.get<ResearchRun>(run.id)!, intent: captured! };
}

// -----------------------------------------------------------------------------
// 1. partitionResearchWire
// -----------------------------------------------------------------------------
test("partitionResearchWire deterministically decomposes envelope into exact joinable wire with Unicode", () => {
  const envelope: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-1234-uuid",
    mode: "research",
    model: "claude-3-7-sonnet",
    effort: "high",
    speed: "fast",
    prompt: "Анализ требований и инвариантов 🚀: \"quotes\", \\escapes\\ and \nnewlines.",
  };

  const subject = {
    zeta: "последний ключ",
    alpha: 12345,
    beta: { nested: true, text: "Unicode текст: Привет мир!" },
    empty: null,
  };

  const parts = partitionResearchWire(envelope, subject);
  assert.ok(parts.length >= 4, "Must partition into header, prompt, subject prefix, entries, and suffix");

  const wire = parts.join("");
  // Must be valid JSON
  const parsed = JSON.parse(wire);
  assert.equal(parsed.protocol, envelope.protocol);
  assert.equal(parsed.requestId, envelope.requestId);
  assert.equal(parsed.prompt, envelope.prompt);
  assert.equal(parsed.mode, envelope.mode);
  assert.equal(parsed.model, envelope.model);
  assert.equal(parsed.effort, envelope.effort);
  assert.equal(parsed.speed, envelope.speed);
  assert.deepEqual(parsed.subject, subject);

  // Re-partitioning same input gives identical parts
  const parts2 = partitionResearchWire(envelope, subject);
  assert.deepEqual(parts, parts2);

  // Subject keys must preserve insertion order in parts
  const subjectKeysInOrder: string[] = [];
  for (const p of parts) {
    const match = p.match(/^,?\"([^\"]+)\":/);
    if (match && match[1] !== 'prompt' && match[1] !== 'subject') {
      subjectKeysInOrder.push(match[1]!);
    }
  }
  assert.deepEqual(subjectKeysInOrder, Object.keys(subject));
  assert.equal(wire, JSON.stringify({ ...envelope, subject }));
});

test("DRS1a-02: partitionResearchWire exactly matches JSON.stringify with undefined, numeric keys, functions, symbols, and empty objects", () => {
  const envelope: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-serializer-test",
    mode: "research",
    model: "test-model",
    effort: "high",
    speed: "fast",
    prompt: "Prompt with escapes \n\t\"quotes\" and Unicode 🚀",
  };

  const testSubjects: unknown[] = [
    { kept: "ok", optional: undefined },
    { "0": "zero", "10": "ten", "2": "two", b: "b", a: "a", undef: undefined },
    { onlyUndef: undefined },
    {},
    { fn: () => {}, sym: Symbol("skip"), valid: 123 },
    { nested: { a: 1, b: undefined }, array: [1, 2, undefined, null] },
    null,
    "plain-string",
    12345,
    [1, 2, 3],
  ];

  for (const subject of testSubjects) {
    const expected = JSON.stringify({ ...envelope, subject });
    const parts = partitionResearchWire(envelope, subject);
    const actual = parts.join("");
    assert.equal(actual, expected, `Parts joined must match JSON.stringify for subject: ${JSON.stringify(subject)}`);
    // Verify valid JSON parse
    const parsed = JSON.parse(actual);
    assert.deepEqual(parsed, JSON.parse(expected));
  }

  // Also verify prepareResearchEnvelope produces exact wire under REQUEST_MANIFEST_CONTRACT
  const role = { actor: "author", model: "fixture", effort: "high" };
  const envMock = { projectId: "p", workspace: "/tmp" };
  const prep = prepareResearchEnvelope(
    role as any,
    envMock as any,
    "prompt",
    { kept: "ok", optional: undefined },
    undefined,
    undefined,
    "same-id",
    REQUEST_MANIFEST_CONTRACT
  );
  assert.ok(prep.input);
  assert.equal(prep.input, JSON.stringify({ ...prep.envelope, subject: prep.subject }));
});

// -----------------------------------------------------------------------------
// 2. prepareRequestPartsAndManifest deduplication & verification
// -----------------------------------------------------------------------------
test("prepareRequestPartsAndManifest writes parts once and reuses existing shared parts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-parts-"));
  const store = new Store(join(root, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const prompt = "Common fixed system instruction for discovery analyst.";
  const sharedSubject = {
    discoveryContext: { version: 1, domain: "financial-ledger" },
    phasePolicy: { level: "R1", rules: ["immutable-history", "typed-refusal"] },
  };

  const envelope1: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-call-1",
    mode: "research",
    model: "claude-3-7-sonnet",
    effort: "high",
    prompt,
  };
  const subject1 = { ...sharedSubject, questionId: "q-1" };

  const first = prepareRequestPartsAndManifest({
    store,
    projectId: "p",
    draftId: "d-1",
    requestId: envelope1.requestId,
    envelope: envelope1,
    subject: subject1,
  });

  assert.equal(first.sharedPartCount, 0, "No parts shared initially");
  assert.ok(first.partCount > 0);
  assert.equal(first.writes.length, first.partCount + 1, "Writes include all parts plus manifest");

  // Commit first call's writes
  store.writeMany(first.writes);

  const totalPartsAfterFirst = store.list(REQUEST_PART_KIND).length;
  assert.equal(totalPartsAfterFirst, first.partCount);

  // Second call shares prompt and sharedSubject keys, but has unique requestId and questionId
  const envelope2: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-call-2",
    mode: "research",
    model: "claude-3-7-sonnet",
    effort: "high",
    prompt,
  };
  const subject2 = { ...sharedSubject, questionId: "q-2" };

  const second = prepareRequestPartsAndManifest({
    store,
    projectId: "p",
    draftId: "d-1",
    requestId: envelope2.requestId,
    envelope: envelope2,
    subject: subject2,
  });

  assert.ok(second.sharedPartCount > 0, "Common prompt and shared subject keys must be reused");
  assert.ok(second.writes.length < second.partCount + 1, "Only new parts and manifest are written");
  assert.equal(second.writes.length + second.sharedPartCount, second.partCount + 1);

  // Commit second call's writes
  store.writeMany(second.writes);

  const totalPartsAfterSecond = store.list(REQUEST_PART_KIND).length;
  assert.ok(
    totalPartsAfterSecond < first.partCount + second.partCount,
    `Total parts in store (${totalPartsAfterSecond}) must be less than sum of both calls (${first.partCount + second.partCount})`
  );
});

test("DRS1a-01: multi-project parts sharing and isolation in single Store", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-multiproject-"));
  const store = new Store(join(root, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const prompt = "Common instruction for multi-project test.";
  const commonSubject = { material: "same-common-material", rubric: "strict" };

  const envA: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-project-a",
    mode: "research",
    model: "test-model",
    effort: "high",
    prompt,
  };

  const envB: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-project-b",
    mode: "research",
    model: "test-model",
    effort: "high",
    prompt,
  };

  // 1. Prepare and commit project-a
  const first = prepareRequestPartsAndManifest({
    store,
    projectId: "project-a",
    draftId: "draft-a",
    requestId: envA.requestId,
    envelope: envA,
    subject: commonSubject,
  });
  store.writeMany(first.writes, first.guards);

  // 2. Prepare project-b with identical common subject in the same store
  // Must NOT throw request_part_invalid or collide on part IDs
  const second = prepareRequestPartsAndManifest({
    store,
    projectId: "project-b",
    draftId: "draft-b",
    requestId: envB.requestId,
    envelope: envB,
    subject: commonSubject,
  });
  store.writeMany(second.writes, second.guards);

  // 3. Verify each project owns its own part IDs
  const partsA = store.list<RequestPart>(REQUEST_PART_KIND).filter((p) => p.value.projectId === "project-a");
  const partsB = store.list<RequestPart>(REQUEST_PART_KIND).filter((p) => p.value.projectId === "project-b");
  assert.ok(partsA.length > 0);
  assert.ok(partsB.length > 0);
  assert.equal(partsA.length, partsB.length);

  for (const part of partsA) {
    assert.ok(part.id.startsWith("request-part:project-a:"));
  }
  for (const part of partsB) {
    assert.ok(part.id.startsWith("request-part:project-b:"));
  }

  // 4. Verify both manifests can be read cleanly
  const wireA = readRequestWire(store, first.manifestRef, { projectId: "project-a" });
  const wireB = readRequestWire(store, second.manifestRef, { projectId: "project-b" });
  assert.equal(wireA.text, first.input);
  assert.equal(wireB.text, second.input);
});

test("DRS1a-01: concurrent store part creation handles transaction conflict cleanly", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-concurrent-"));
  const dbPath = join(root, "db.sqlite");
  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  t.after(() => {
    storeA.close();
    storeB.close();
    rmSync(root, { recursive: true, force: true });
  });

  const prompt = "Concurrent instructions";
  const envelope: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-concurrent-1",
    mode: "research",
    model: "claude-3-7-sonnet",
    effort: "high",
    prompt,
  };
  const subject = { invariant: "must not leave partial state" };

  // Both stores prepare the same call concurrently before either writes
  const prepA = prepareRequestPartsAndManifest({
    store: storeA,
    projectId: "p",
    draftId: "d-1",
    requestId: envelope.requestId,
    envelope,
    subject,
  });

  const prepB = prepareRequestPartsAndManifest({
    store: storeB,
    projectId: "p",
    draftId: "d-1",
    requestId: envelope.requestId,
    envelope,
    subject,
  });

  // Store A commits first
  storeA.writeMany(prepA.writes, prepA.guards);

  // Store B attempts to commit with expected: 0 on parts that now exist
  // It must fail atomically with store_conflict / revision mismatch without corrupting the store
  assert.throws(
    () => storeB.writeMany(prepB.writes, prepB.guards),
    { code: "revision_conflict" }
  );

  // Store B re-prepares: it now detects the existing parts, guards them, and avoids duplicate writes
  const prepB2 = prepareRequestPartsAndManifest({
    store: storeB,
    projectId: "p",
    draftId: "d-1",
    requestId: "req-concurrent-2",
    envelope: { ...envelope, requestId: "req-concurrent-2" },
    subject,
  });

  assert.ok(prepB2.sharedPartCount > 0);
  storeB.writeMany(prepB2.writes, prepB2.guards);
});

test("prepareRequestPartsAndManifest rejects existing part if corrupted in store", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-corrupt-"));
  const store = new Store(join(root, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const prompt = "Instruction text";
  const envelope: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-corrupt",
    mode: "research",
    model: "claude-3-7-sonnet",
    effort: "high",
    prompt,
  };

  const text = `"prompt":${JSON.stringify(prompt)},`;
  const hash = digest(text);
  const partId = requestPartId("p", text);

  // Intentionally write a corrupt part with tampered text
  store.writeMany([
    {
      id: partId,
      kind: REQUEST_PART_KIND,
      expected: 0,
      value: {
        contract: REQUEST_PART_CONTRACT,
        projectId: "p",
        hash,
        text: "tampered content",
      },
    },
  ]);

  assert.throws(
    () =>
      prepareRequestPartsAndManifest({
        store,
        projectId: "p",
        draftId: "d-1",
        requestId: envelope.requestId,
        envelope,
        subject: { key: "value" },
      }),
    { code: "request_part_invalid" }
  );
});

// -----------------------------------------------------------------------------
// 3. readRequestWire universal reader & tamper tests
// -----------------------------------------------------------------------------
test("readRequestWire seamlessly reads both legacy model-request and request-manifest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-reader-"));
  const store = new Store(join(root, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  // 1. Legacy model-request
  const legacyText = JSON.stringify({ protocol: "omg-agent/v1", requestId: "leg-1", prompt: "legacy" });
  const [legacyRec] = store.writeMany([
    {
      id: "model-request:leg-1",
      kind: "model-request",
      expected: 0,
      value: { projectId: "p", draftId: "d-1", text: legacyText },
    },
  ]);
  const legacyRead = readRequestWire(store, reference(legacyRec!), { projectId: "p", draftId: "d-1" });
  assert.equal(legacyRead.contract, "model-request");
  assert.equal(legacyRead.text, legacyText);

  // 2. Wire manifest with parts
  const envelope: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "man-1",
    mode: "research",
    model: "test-model",
    effort: "low",
    prompt: "Modern manifest prompt",
  };
  const subject = { foo: "bar", num: 42 };

  const prepared = prepareRequestPartsAndManifest({
    store,
    projectId: "p",
    draftId: "d-1",
    requestId: envelope.requestId,
    envelope,
    subject,
  });
  store.writeMany(prepared.writes);

  const manifestRead = readRequestWire(store, prepared.manifestRef, {
    projectId: "p",
    draftId: "d-1",
    requestId: "man-1",
  });
  assert.equal(manifestRead.contract, REQUEST_MANIFEST_CONTRACT);
  assert.equal(manifestRead.text, prepared.input);
  assert.deepEqual(JSON.parse(manifestRead.text), JSON.parse(prepared.input));
});

test("readRequestWire enforces checksums, foreign boundary, and catches tampering", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-tamper-"));
  const store = new Store(join(root, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const envelope: ResearchEnvelopeFrame = {
    protocol: "omg-agent/v1",
    requestId: "req-tamper-1",
    mode: "research",
    model: "claude-3-7-sonnet",
    effort: "high",
    prompt: "Tamper testing prompt",
  };
  const subject = { a: 1, b: 2 };

  const prepared = prepareRequestPartsAndManifest({
    store,
    projectId: "p",
    draftId: "d-1",
    requestId: envelope.requestId,
    envelope,
    subject,
  });
  store.writeMany(prepared.writes);

  // 1. Foreign project refusal
  assert.throws(
    () => readRequestWire(store, prepared.manifestRef, { projectId: "foreign-proj" }),
    { code: "response_recovery_wire_invalid" }
  );

  // 2. Foreign draft refusal
  assert.throws(
    () => readRequestWire(store, prepared.manifestRef, { draftId: "foreign-draft" }),
    { code: "response_recovery_wire_invalid" }
  );

  // 3. Foreign requestId refusal
  assert.throws(
    () => readRequestWire(store, prepared.manifestRef, { requestId: "foreign-req" }),
    { code: "response_recovery_wire_invalid" }
  );

  // 4. Missing part record
  const badManifestValue: RequestManifest = {
    ...prepared.manifestValue,
    parts: [
      ...prepared.manifestValue.parts,
      { id: "request-part:nonexistent", revision: 1, hash: "0".repeat(64) },
    ],
  };
  const [badManifestRef] = store.writeMany([
    {
      id: "request-manifest:bad-missing-part",
      kind: REQUEST_MANIFEST_KIND,
      expected: 0,
      value: badManifestValue,
    },
  ]);
  assert.throws(
    () => readRequestWire(store, reference(badManifestRef!)),
    { code: "response_recovery_wire_invalid" }
  );

  // 5. Tampered part ordering (causes SHA256 / content mismatch)
  const reorderedParts = [...prepared.manifestValue.parts].reverse();
  const reorderedManifestValue: RequestManifest = {
    ...prepared.manifestValue,
    parts: reorderedParts,
  };
  const [reorderedRef] = store.writeMany([
    {
      id: "request-manifest:reordered",
      kind: REQUEST_MANIFEST_KIND,
      expected: 0,
      value: reorderedManifestValue,
    },
  ]);
  assert.throws(
    () => readRequestWire(store, reference(reorderedRef!)),
    { code: "response_recovery_wire_invalid" }
  );

  // 6. Tampered checksums in manifest (sha256 mismatch)
  const tamperedChecksumValue: RequestManifest = {
    ...prepared.manifestValue,
    sha256: "0".repeat(64),
    wire: {
      chars: prepared.manifestValue.chars,
      bytes: prepared.manifestValue.bytes,
      sha256: "0".repeat(64),
    },
  };
  const [tamperedChecksumRef] = store.writeMany([
    {
      id: "request-manifest:bad-hash",
      kind: REQUEST_MANIFEST_KIND,
      expected: 0,
      value: tamperedChecksumValue,
    },
  ]);
  assert.throws(
    () => readRequestWire(store, reference(tamperedChecksumRef!)),
    { code: "response_recovery_wire_invalid" }
  );
});

// -----------------------------------------------------------------------------
// 4. Contract Gate & Role Boundaries in researchCall
// -----------------------------------------------------------------------------
test("researchCall enforces requestContract validation and rejects unsupported contracts/roles", async (t) => {
  const f = setupFixture(t);
  const context = pilotContext(f.store, f.draft, f.question);

  // 1. Unknown requestContract -> request_contract_invalid
  await assert.rejects(
    researchCall(
      f.environment.value.implementer,
      f.environment.value,
      "Test prompt",
      context,
      undefined,
      {
        store: f.store,
        draftId: f.draft.id,
        questionId: f.question.id,
        purpose: "analyst",
        pilot: f.pilot,
        requestContract: "unsupported-contract/v99",
      }
    ),
    { code: "request_contract_invalid" }
  );

  // 2. request-manifest/v1 without consumerIntent -> request_contract_unsupported
  await assert.rejects(
    researchCall(
      f.environment.value.implementer,
      f.environment.value,
      "Test prompt",
      context,
      undefined,
      {
        store: f.store,
        draftId: f.draft.id,
        questionId: f.question.id,
        purpose: "analyst",
        pilot: f.pilot,
        requestContract: REQUEST_MANIFEST_CONTRACT,
      }
    ),
    { code: "request_contract_unsupported" }
  );

  // 3. Prepare reading-planner consumer intent -> request-manifest/v1 rejected as unsupported role
  const plannerRunId = `research-run:${randomUUID()}`;
  const [plannerRun] = f.store.writeMany<ResearchRun>([
    {
      id: plannerRunId,
      kind: "research-run",
      expected: 0,
      value: {
        projectId: "p",
        draftId: f.draft.id,
        question: reference(f.question),
        environment: reference(f.environment),
        turns: 0,
        status: "running",
        inputs: f.draft.value.inputs,
      },
    },
  ]);
  const plannerIntent = prepareResearchConsumerIntent(f.store, {
    projectId: "p",
    kind: "reading-planner",
    key: "planner-key-1",
    owner: reference(plannerRun!),
    draft: reference(f.draft),
    question: reference(f.question),
    role: f.environment.value.implementer,
    dispatch: f.environment.value,
    profile: reference(f.pilot),
    cursor: { run: plannerRunId, turn: 1, instruction: "Plan reads", context },
    basis: f.draft.value.inputs,
    guards: uniqueTransactionGuards([
      reference(plannerRun!),
      reference(f.draft),
      reference(f.question),
      reference(f.environment),
      reference(f.pilot),
      ...f.draft.value.inputs,
    ]),
  });

  await assert.rejects(
    researchCall(
      f.environment.value.implementer,
      f.environment.value,
      "Plan reads",
      context,
      undefined,
      {
        store: f.store,
        draftId: f.draft.id,
        questionId: f.question.id,
        purpose: "reading-planner",
        pilot: f.pilot,
        consumerIntent: reference(plannerIntent),
        requestContract: REQUEST_MANIFEST_CONTRACT,
      }
    ),
    { code: "request_contract_unsupported" }
  );

  // 4. DRS1a-03: Ordinary context containing wireProtocol or requestContract does NOT trigger contract switch
  const result = await researchCall(
    f.environment.value.implementer,
    f.environment.value,
    "Test prompt without audit opt-in",
    { ...context, wireProtocol: "ordinary-context-data", requestContract: "ordinary-context-data" },
    undefined,
    {
      store: f.store,
      draftId: f.draft.id,
      questionId: f.question.id,
      purpose: "analyst",
      pilot: f.pilot,
    }
  );
  assert.ok(result);
  const requests = f.store.list("model-request");
  assert.ok(requests.length > 0, "Legacy model-request must be produced when no audit opt-in was requested");
});

test("researchCall with request-manifest/v1 reserves parts and manifest in same transaction for analyst", async (t) => {
  const f = setupFixture(t);
  const context = pilotContext(f.store, f.draft, f.question);
  const prompt = "Analyst instruction for research.";

  // Create genuine analyst run and intent
  const runId = `research-run:${randomUUID()}`;
  const [run] = f.store.writeMany<ResearchRun>([
    {
      id: runId,
      kind: "research-run",
      expected: 0,
      value: {
        projectId: "p",
        draftId: f.draft.id,
        question: reference(f.question),
        environment: reference(f.environment),
        turns: 0,
        status: "running",
        inputs: f.draft.value.inputs,
      },
    },
  ]);

  const intent = prepareResearchConsumerIntent(f.store, {
    projectId: "p",
    kind: "analyst",
    key: "analyst-turn-0",
    owner: reference(run!),
    draft: reference(f.draft),
    question: reference(f.question),
    role: f.environment.value.implementer,
    dispatch: f.environment.value,
    profile: reference(f.pilot),
    cursor: { run: runId, turn: 1, instruction: prompt, context },
    basis: f.draft.value.inputs,
    guards: uniqueTransactionGuards([
      reference(run!),
      reference(f.draft),
      reference(f.question),
      reference(f.environment),
      reference(f.pilot),
      ...f.draft.value.inputs,
    ]),
  });

  // Call researchCall with requestContract: REQUEST_MANIFEST_CONTRACT
  const result = await researchCall(
    f.environment.value.implementer,
    f.environment.value,
    prompt,
    context,
    undefined,
    {
      store: f.store,
      draftId: f.draft.id,
      questionId: f.question.id,
      purpose: "analyst",
      pilot: f.pilot,
      consumerIntent: reference(intent),
      requestContract: REQUEST_MANIFEST_CONTRACT,
    }
  );

  assert.ok(result, "Analyst call must return payload");

  // Verify call record in store
  const calls = f.store.list<ModelCall>("model-call");
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.value.status, "succeeded");

  // Crucial invariant: call request record MUST point to request-manifest, NOT model-request
  assert.ok(call.value.request.record, "Call must have request record");
  assert.ok(call.value.request.record!.id.startsWith("request-manifest:"));
  assert.equal(f.store.list("model-request").length, 0, "No model-request record must be written");

  // Verify manifest and parts exist in store
  const manifests = f.store.list<RequestManifest>(REQUEST_MANIFEST_KIND);
  assert.equal(manifests.length, 1);
  const manifest = manifests[0]!;
  assert.equal(manifest.value.contract, REQUEST_MANIFEST_CONTRACT);
  assert.equal(manifest.value.projectId, "p");
  assert.equal(manifest.value.draftId, f.draft.id);
  assert.equal(manifest.value.requestId, call.value.requestId);

  const parts = f.store.list<RequestPart>(REQUEST_PART_KIND);
  assert.ok(parts.length > 0);
  assert.equal(parts.length, manifest.value.parts.length);

  // Verify wire can be reassembled and matches call record
  const wireRead = readRequestWire(f.store, reference(manifest));
  assert.equal(wireRead.text.length, call.value.request.chars);
  assert.equal(Buffer.byteLength(wireRead.text), call.value.request.bytes);
  assert.equal(digest(wireRead.text), call.value.request.hash);
});

// -----------------------------------------------------------------------------
// 5. Recovery Windows & Cold Restarts without repurchasing
// -----------------------------------------------------------------------------
async function runChildEngine(
  dbPath: string,
  mode: "prepare_and_dispatch" | "crash_lost_process",
  params: { draftId: string; envId: string; pilotId: string; contract?: string }
): Promise<number> {
  const storeModule = new URL("../src/storage/store.js", import.meta.url).pathname;
  const engineModule = new URL("../src/product/engine.js", import.meta.url).pathname;
  const protocolModule = new URL("../src/discovery/research-protocol.js", import.meta.url).pathname;
  const contractsModule = new URL("../src/pipeline/contracts.js", import.meta.url).pathname;
  const partsModule = new URL("../src/discovery/request-parts.js", import.meta.url).pathname;

  const childScript = join(tmpdir(), `child-engine-${randomUUID()}.mjs`);
  const code = `import { Store } from ${JSON.stringify(storeModule)};
import { ProductEngine } from ${JSON.stringify(engineModule)};
import { researchCall } from ${JSON.stringify(protocolModule)};
import { reference } from ${JSON.stringify(contractsModule)};
import { REQUEST_MANIFEST_CONTRACT } from ${JSON.stringify(partsModule)};

const store = new Store(${JSON.stringify(dbPath)});
const engine = new ProductEngine(store);

const origWriteMany = store.writeMany.bind(store);
let capturedIntent = null;

if (${JSON.stringify(mode)} === "prepare_and_dispatch") {
  store.writeMany = (writes, guards) => {
    if (capturedIntent && writes.some(w => w.kind === "research-run")) throw new Error("INTENT_PREPARED_STOP");
    const res = origWriteMany(writes, guards);
    const found = writes.find(w => w.kind === "research-consumer-intent");
    if (found) {
      capturedIntent = store.get(found.id);
      throw new Error("INTENT_PREPARED_STOP");
    }
    return res;
  };

  try {
    await engine.researcher.run("p", ${JSON.stringify(params.draftId)}, 1);
  } catch (e) {
    if (e?.message !== "INTENT_PREPARED_STOP") throw e;
  }
  store.writeMany = origWriteMany;

  const env = store.get(${JSON.stringify(params.envId)});
  const pilot = store.get(${JSON.stringify(params.pilotId)});
  await researchCall(
    env.value.implementer,
    env.value,
    capturedIntent.value.cursor.instruction,
    capturedIntent.value.cursor.context,
    undefined,
    {
      store,
      draftId: ${JSON.stringify(params.draftId)},
      questionId: capturedIntent.value.question.id,
      purpose: capturedIntent.value.kind,
      pilot,
      consumerIntent: reference(capturedIntent),
      ${params.contract ? `requestContract: ${JSON.stringify(params.contract)},` : ""}
    }
  );
  store.close();
  process.exit(0);
} else if (${JSON.stringify(mode)} === "crash_lost_process") {
  store.writeMany = (writes, guards) => {
    if (capturedIntent && writes.some(w => w.kind === "research-run")) throw new Error("INTENT_PREPARED_STOP");
    const res = origWriteMany(writes, guards);
    const found = writes.find(w => w.kind === "research-consumer-intent");
    if (found) {
      capturedIntent = store.get(found.id);
      throw new Error("INTENT_PREPARED_STOP");
    }
    return res;
  };
  try {
    await engine.researcher.run("p", ${JSON.stringify(params.draftId)}, 1);
  } catch (e) {
    if (e?.message !== "INTENT_PREPARED_STOP") throw e;
  }

  store.writeMany = origWriteMany;

  store.writeMany = (writes, guards) => {
    if (writes.some(w => w.kind === "model-response" || (w.kind === "model-call" && w.value?.finishedAt))) {
      process.exit(73);
    }
    return origWriteMany(writes, guards);
  };

  const env = store.get(${JSON.stringify(params.envId)});
  const pilot = store.get(${JSON.stringify(params.pilotId)});
  await researchCall(
    env.value.implementer,
    env.value,
    capturedIntent.value.cursor.instruction,
    capturedIntent.value.cursor.context,
    undefined,
    {
      store,
      draftId: ${JSON.stringify(params.draftId)},
      questionId: capturedIntent.value.question.id,
      purpose: capturedIntent.value.kind,
      pilot,
      consumerIntent: reference(capturedIntent),
      ${params.contract ? `requestContract: ${JSON.stringify(params.contract)},` : ""}
    }
  );
  process.exit(0);
}
`;
  writeFileSync(childScript, code);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript], { stdio: "inherit" });
    child.on("exit", (code) => {
      try { rmSync(childScript, { force: true }); } catch {}
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      try { rmSync(childScript, { force: true }); } catch {}
      reject(err);
    });
  });
}

test("recovery of succeeded analyst call via resumeResearchConsumerExecution restores payload and consumer applies result after cold restart", async (t) => {
  const f = setupFixture(t);
  f.store.close();
  const dbPath = join(f.root, "state.sqlite");

  const exitCode = await runChildEngine(dbPath, "prepare_and_dispatch", {
    draftId: f.draft.id,
    envId: f.environment.id,
    pilotId: f.pilot.id,
    contract: REQUEST_MANIFEST_CONTRACT,
  });
  assert.equal(exitCode, 0, "Child engine must exit cleanly");
  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter launched exactly once in child");

  // 1. Cold start 1: ProductEngine.researcher.run applies result
  const coldStore1 = new Store(dbPath);
  t.after(() => { try { coldStore1.close(); } catch {} });

  const snapCold1Before = captureSnapshot(coldStore1);
  assert.equal(snapCold1Before.modelCalls.length, 1);
  assert.equal(snapCold1Before.modelCalls[0]!.status, "succeeded");
  assert.equal(snapCold1Before.modelCalls[0]!.hasResponse, true);
  assert.equal(snapCold1Before.manifests.length, 1);
  assert.ok(snapCold1Before.parts.length > 0);
  assert.equal(snapCold1Before.legacyRequests.length, 0);

  const intent = coldStore1.list<ResearchConsumerIntent>("research-consumer-intent")[0]!;
  const coldEngine1 = new ProductEngine(coldStore1);
  const finishedRun = await coldEngine1.researcher.run("p", f.draft.id, 1);
  assert.ok(finishedRun);
  assert.equal(finishedRun.value.turns, 1, "Run turns counter advanced to 1");

  const turn1 = coldStore1.list<ResearchTurn>("research-turn")[0]!;
  assert.ok(turn1);
  assert.equal(turn1.value.status, "completed");

  const appliedIntent1 = coldStore1.get<ResearchConsumerIntent>(intent.id)!;
  assert.equal(appliedIntent1.value.state, "applied");
  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter NOT launched during cold application");

  const snapCold1After = captureSnapshot(coldStore1);
  assert.deepEqual(snapCold1After.pilotDispatches, snapCold1Before.pilotDispatches);
  assert.deepEqual(snapCold1After.measuredUsage, snapCold1Before.measuredUsage);
  coldStore1.close();

  // 2. Cold start 2: repeat recovery of the SAME paid action
  const coldStore2 = new Store(dbPath);
  t.after(() => { try { coldStore2.close(); } catch {} });

  const recovered2 = resumeResearchConsumerExecution(coldStore2, "p", reference(intent));
  assert.equal(recovered2.kind, "response");

  const read2 = readResearchConsumerExecution(coldStore2, "p", reference(intent));
  assert.equal(read2.kind, "response");
  assert.deepEqual(read2.payload, recovered2.payload, "read and resume return identical payload");

  const appliedIntent2 = coldStore2.get<ResearchConsumerIntent>(intent.id)!;
  assert.equal(appliedIntent2.revision, appliedIntent1.revision, "Intent revision must not advance on second recovery");

  const turn2 = coldStore2.list<ResearchTurn>("research-turn")[0]!;
  assert.equal(turn2.revision, turn1.revision, "Turn revision must not advance on second recovery");
  assert.deepEqual(turn2.value.action, turn1.value.action, "Action must be byte-for-byte identical");
  assert.equal(turn2.hash, turn1.hash, "Turn hash identical");

  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter NOT launched during second recovery");

  const snapCold2After = captureSnapshot(coldStore2);
  assert.deepEqual(snapCold2After.pilotDispatches, snapCold1After.pilotDispatches);
  assert.deepEqual(snapCold2After.measuredUsage, snapCold1After.measuredUsage);
  assert.deepEqual(snapCold2After.modelCalls, snapCold1After.modelCalls);
  assert.deepEqual(snapCold2After.projectDispatches, snapCold1After.projectDispatches);
  assert.deepEqual(snapCold2After.questionDispatches, snapCold1After.questionDispatches);
});

test("crash window: engine process lost after confirmed dispatch before terminal write recovers lost/terminal without fake answer or extra spend on recovery", async (t) => {
  const f = setupFixture(t);
  f.store.close();
  const dbPath = join(f.root, "state.sqlite");

  const exitCode = await runChildEngine(dbPath, "crash_lost_process", {
    draftId: f.draft.id,
    envId: f.environment.id,
    pilotId: f.pilot.id,
    contract: REQUEST_MANIFEST_CONTRACT,
  });
  assert.equal(exitCode, 73, "Child engine crashed as expected with code 73");
  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter was dispatched exactly once before crash");

  const coldStore = new Store(dbPath);
  t.after(() => { try { coldStore.close(); } catch {} });

  const snapColdBefore = captureSnapshot(coldStore);
  assert.equal(snapColdBefore.modelCalls.length, 1);
  assert.equal(snapColdBefore.modelCalls[0]!.status, "running", "Model call remained running on crash");
  assert.equal(snapColdBefore.modelCalls[0]!.hasResponse, false);
  assert.equal(snapColdBefore.manifests.length, 1);
  assert.ok(snapColdBefore.parts.length > 0);

  const intent = coldStore.list<ResearchConsumerIntent>("research-consumer-intent")[0]!;

  // Standard recovery proves process loss and marks terminal refused
  let resumeError: any = null;
  try {
    resumeResearchConsumerExecution(coldStore, "p", reference(intent));
  } catch (e: any) {
    resumeError = e;
  }
  assert.ok(resumeError);
  assert.equal(resumeError.code, "research_consumer_execution_refused");

  const snapColdAfter = captureSnapshot(coldStore);
  assert.deepEqual(snapColdAfter.pilotDispatches, snapColdBefore.pilotDispatches);
  assert.deepEqual(snapColdAfter.measuredUsage, snapColdBefore.measuredUsage);
  assert.equal(snapColdAfter.modelCalls[0]!.status, "failed");
  assert.equal(snapColdAfter.modelCalls[0]!.error, "process_lost");
  assert.equal(snapColdAfter.consumerIntents[0]!.state, "running");

  // Read execution also sees terminal refusal
  let readError: any = null;
  try {
    readResearchConsumerExecution(coldStore, "p", reference(intent));
  } catch (e: any) {
    readError = e;
  }
  assert.ok(readError);
  assert.equal(readError.code, "research_consumer_execution_refused");

  // Re-entry in ProductEngine pauses with refused code without re-launching adapter
  const coldEngine = new ProductEngine(coldStore);
  const pausedRun = await coldEngine.researcher.run("p", f.draft.id, 1);
  assert.equal(pausedRun.value.status, "paused");
  assert.equal(pausedRun.value.pauseCode, "research_consumer_execution_refused");

  // Counters remain strictly 1 launch; no additional spend on recovery (original usage remains unknown upon process_lost)
  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter must NOT be re-launched");
  assert.deepEqual(captureSnapshot(coldStore).pilotDispatches, snapColdBefore.pilotDispatches);
  assert.deepEqual(captureSnapshot(coldStore).projectDispatches, snapColdBefore.projectDispatches);
  assert.deepEqual(captureSnapshot(coldStore).questionDispatches, snapColdBefore.questionDispatches);
});

test("crash window: in-process interruption before terminal write preserves pending physical call without fake answer or extra spend on recovery", async (t) => {
  const f = setupFixture(t);
  const { intent } = await prepareStandardRunAndIntent(f);
  assert.equal(countAdapterLaunches(f.counterPath), 0, "Adapter must not launch during intent preparation");

  const snapBeforeDispatch = captureSnapshot(f.store);
  assert.equal(snapBeforeDispatch.modelCalls.length, 0, "No model calls before dispatch");

  const origWriteMany = f.store.writeMany.bind(f.store);
  let faultInjected = false;
  f.store.writeMany = ((writes: any, guards: any): any => {
    if (
      writes.some(
        (w: any) =>
          w.kind === "model-response" ||
          (w.kind === "model-call" && (w.value as any)?.finishedAt)
      )
    ) {
      faultInjected = true;
      throw new Error("injected_fault_before_terminal_write");
    }
    return origWriteMany(writes, guards);
  }) as any;

  let callError: any = null;
  try {
    await researchCall(
      f.environment.value.implementer,
      f.environment.value,
      intent.value.cursor.instruction,
      intent.value.cursor.context,
      undefined,
      {
        store: f.store,
        draftId: f.draft.id,
        questionId: intent.value.question.id,
        purpose: intent.value.kind,
        pilot: f.pilot,
        consumerIntent: reference(intent),
        requestContract: REQUEST_MANIFEST_CONTRACT,
      }
    );
  } catch (e: any) {
    callError = e;
  }
  assert.ok(faultInjected, "Injected fault must trigger before terminal write");
  assert.ok(callError);
  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter was dispatched exactly once before crash");

  f.store.close();

  const coldStore = new Store(join(f.root, "state.sqlite"));
  t.after(() => { try { coldStore.close(); } catch {} });

  const snapColdBeforeResume = captureSnapshot(coldStore);
  assert.equal(snapColdBeforeResume.modelCalls.length, 1);
  assert.equal(snapColdBeforeResume.modelCalls[0]!.status, "running", "Model call remains running because terminal write crashed");
  assert.equal(snapColdBeforeResume.modelCalls[0]!.hasResponse, false);
  assert.equal(snapColdBeforeResume.manifests.length, 1);
  assert.ok(snapColdBeforeResume.parts.length > 0);

  // Recovery preserves the bound physical call since owner process is current process (still running)
  let resumeError: any = null;
  try {
    resumeResearchConsumerExecution(coldStore, "p", reference(intent));
  } catch (e: any) {
    resumeError = e;
  }
  assert.ok(resumeError);
  assert.equal(resumeError.code, "research_consumer_execution_running", "Preserve bound physical call while process is running");

  let readExecError: any = null;
  try {
    readResearchConsumerExecution(coldStore, "p", reference(intent));
  } catch (e: any) {
    readExecError = e;
  }
  assert.ok(readExecError);
  assert.equal(readExecError.code, "research_consumer_execution_running");

  const coldEngine = new ProductEngine(coldStore);
  let runError: any = null;
  try {
    await coldEngine.researcher.run("p", f.draft.id, 1);
  } catch (e: any) {
    runError = e;
  }
  assert.ok(runError);
  assert.equal(runError.code, "research_busy");

  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter must NOT be re-launched");
  const snapColdAfterResume = captureSnapshot(coldStore);
  assert.deepEqual(snapColdAfterResume.projectDispatches, snapColdBeforeResume.projectDispatches);
  assert.deepEqual(snapColdAfterResume.questionDispatches, snapColdBeforeResume.questionDispatches);
});

test("stored adapter refusal: exit 1 failure is durably recorded and does not invent response", async (t) => {
  const f = setupFixture(t);
  const { intent } = await prepareStandardRunAndIntent(f);
  writeFileSync(
    f.adapterPath,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(f.counterPath)}, 'launch\\n');\nprocess.exit(1);`
  );

  let callError: any = null;
  try {
    await researchCall(
      f.environment.value.implementer,
      f.environment.value,
      intent.value.cursor.instruction,
      intent.value.cursor.context,
      undefined,
      {
        store: f.store,
        draftId: f.draft.id,
        questionId: intent.value.question.id,
        purpose: intent.value.kind,
        pilot: f.pilot,
        consumerIntent: reference(intent),
        requestContract: REQUEST_MANIFEST_CONTRACT,
      }
    );
  } catch (e: any) {
    callError = e;
  }
  assert.ok(callError);
  assert.equal(callError.code, "research_provider_failed");
  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter was launched once");

  f.store.close();

  const coldStore = new Store(join(f.root, "state.sqlite"));
  t.after(() => { try { coldStore.close(); } catch {} });

  const snap = captureSnapshot(coldStore);
  assert.equal(snap.modelCalls.length, 1);
  assert.equal(snap.modelCalls[0]!.status, "failed");
  assert.equal(snap.modelCalls[0]!.error, "research_provider_failed");
  assert.equal(snap.consumerIntents[0]!.state, "refused");

  const terminal = readResearchConsumerExecution(coldStore, "p", reference(intent));
  assert.equal(terminal.kind, "provider-failed");
  assert.equal(terminal.code, "provider_failed_without_response");

  assert.throws(
    () => resumeResearchConsumerExecution(coldStore, "p", reference(intent)),
    { code: "research_consumer_execution_refused" }
  );
});

test("concurrent race on reservation batch: conflict rolls back manifest, parts, and model-call atomically without dispatch", async (t) => {
  const f = setupFixture(t);
  const { intent } = await prepareStandardRunAndIntent(f);
  assert.equal(countAdapterLaunches(f.counterPath), 0);

  const snapBeforeConflict = captureSnapshot(f.store);
  assert.equal(snapBeforeConflict.modelCalls.length, 0, "No model calls before conflict");

  let conflictInjected = false;
  const projectCounterId = `project-dispatch:${hashJson(f.environment.value.projectId)}`;
  const prevObserver = observeStore({
    begin: () => undefined,
    end: () => {},
    untraced: () => {},
    write: (s) => {
      if (!conflictInjected) {
        conflictInjected = true;
        s.writeMany([
          {
            id: projectCounterId,
            kind: "project-dispatch",
            expected: 0,
            value: { projectId: f.environment.value.projectId, serial: 999 },
          },
        ]);
      }
    },
  });

  try {
    await assert.rejects(
      researchCall(
        f.environment.value.implementer,
        f.environment.value,
        intent.value.cursor.instruction,
        intent.value.cursor.context,
        undefined,
        {
          store: f.store,
          draftId: f.draft.id,
          questionId: intent.value.question.id,
          purpose: intent.value.kind,
          pilot: f.pilot,
          consumerIntent: reference(intent),
          requestContract: REQUEST_MANIFEST_CONTRACT,
        }
      ),
      { code: "revision_conflict" }
    );
  } finally {
    observeStore(prevObserver);
  }

  // Assert atomic rollback:
  // 1. Adapter was NEVER dispatched (append-counter is 0)
  assert.equal(countAdapterLaunches(f.counterPath), 0, "Adapter must NOT be launched when reservation conflicts");

  // 2. Snapshot comparison: parts, manifest, calls, and intent state are unchanged except for injected project-dispatch
  const snapAfterConflict = captureSnapshot(f.store);
  assert.deepEqual(snapAfterConflict.pilotDispatches, snapBeforeConflict.pilotDispatches);
  assert.equal(f.store.get<any>(projectCounterId)!.revision, 1);
  assert.equal(f.store.get<any>(projectCounterId)!.value.serial, 999);
  assert.equal(snapAfterConflict.modelCalls.length, 0, "No model-call must be saved on conflict");
  assert.equal(snapAfterConflict.manifests.length, 0, "No request-manifest must be saved on conflict");
  assert.equal(snapAfterConflict.parts.length, 0, "No request-parts must be saved on conflict");
  assert.equal(snapAfterConflict.legacyRequests.length, 0, "No model-request must be saved on conflict");

  const intentAfterConflict = f.store.get<ResearchConsumerIntent>(intent.id)!;
  assert.equal(intentAfterConflict.revision, intent.revision, "Intent revision must remain unchanged on conflict");
  assert.equal(intentAfterConflict.value.state, "prepared", "Intent state must remain prepared on conflict");
  assert.equal(intentAfterConflict.hash, intent.hash, "Intent hash must remain unchanged on conflict");

  assert.deepEqual(snapAfterConflict.questionDispatches, snapBeforeConflict.questionDispatches, "Question dispatches must remain unchanged");

  // 3. Subsequent authorized call succeeds
  const result = await researchCall(
    f.environment.value.implementer,
    f.environment.value,
    intent.value.cursor.instruction,
    intent.value.cursor.context,
    undefined,
    {
      store: f.store,
      draftId: f.draft.id,
      questionId: intent.value.question.id,
      purpose: intent.value.kind,
      pilot: f.pilot,
      consumerIntent: reference(intentAfterConflict),
      requestContract: REQUEST_MANIFEST_CONTRACT,
    }
  );
  assert.ok(result);

  // Exactly ONE launch occurred in total across failure and retry
  assert.equal(countAdapterLaunches(f.counterPath), 1, "Adapter was launched exactly once across failure and retry");

  const snapAfterSuccess = captureSnapshot(f.store);
  assert.equal(snapAfterSuccess.modelCalls.length, 1);
  assert.equal(snapAfterSuccess.manifests.length, 1);
  assert.ok(snapAfterSuccess.parts.length > 0);
  assert.equal(snapAfterSuccess.legacyRequests.length, 0);
  assert.equal(snapAfterSuccess.consumerIntents[0]!.state, "running");
});

test("DRS1a-04: legacy terminal recovery preserves exact read order ['request', 'archive', 'request', 'archive']", async (t) => {
  const f = setupFixture(t);
  writeFileSync(f.adapterPath, "setTimeout(()=>{}, 10000);");
  const context = pilotContext(f.store, f.draft, f.question);
  const prompt = "Analyst instruction for legacy read order verification.";

  const runId = `research-run:${randomUUID()}`;
  const [run] = f.store.writeMany<ResearchRun>([
    {
      id: runId,
      kind: "research-run",
      expected: 0,
      value: {
        projectId: "p",
        draftId: f.draft.id,
        question: reference(f.question),
        environment: reference(f.environment),
        turns: 0,
        status: "running",
        inputs: f.draft.value.inputs,
      },
    },
  ]);

  const intent = prepareResearchConsumerIntent(f.store, {
    projectId: "p",
    kind: "analyst",
    key: "analyst-turn-legacy-order",
    owner: reference(run!),
    draft: reference(f.draft),
    question: reference(f.question),
    role: f.environment.value.implementer,
    dispatch: f.environment.value,
    profile: reference(f.pilot),
    cursor: { run: runId, turn: 1, instruction: prompt, context },
    basis: f.draft.value.inputs,
    guards: uniqueTransactionGuards([
      reference(run!),
      reference(f.draft),
      reference(f.question),
      reference(f.environment),
      reference(f.pilot),
      ...f.draft.value.inputs,
    ]),
  });

  // Execute call WITHOUT requestContract (legacy model-request path)
  await researchCall(
    f.environment.value.implementer,
    f.environment.value,
    prompt,
    context,
    undefined,
    {
      store: f.store,
      draftId: f.draft.id,
      questionId: f.question.id,
      purpose: "analyst",
      pilot: f.pilot,
      consumerIntent: reference(intent),
    }
  ).catch((e) => assert.equal(e.code, "process_timeout"));

  const savedCall = f.store.list<ModelCall>("model-call")[0]!;
  const requestId = savedCall.value.request.record!.id;
  const archiveId = savedCall.value.packet!.archive.id;

  // Cold start
  f.store.close();
  const coldStore = new Store(join(f.root, "state.sqlite"));
  t.after(() => coldStore.close());

  const calls: string[] = [];
  const origGet = coldStore.get.bind(coldStore);
  coldStore.get = (id: string, ...args: any[]) => {
    if (id === requestId || id === archiveId) {
      calls.push(id === requestId ? "request" : "archive");
    }
    return origGet(id, ...args);
  };

  const result = readResearchConsumerExecution(coldStore, "p", reference(intent));
  assert.equal(result.kind, "terminal");
  assert.deepEqual(calls, ["request", "archive", "request", "archive"], "Legacy read order must be strictly preserved");
});

// -----------------------------------------------------------------------------
// 6. Reference Sites & fsck Completeness
// -----------------------------------------------------------------------------
test("referenceSites and checkStoreIntegrity correctly validate request-manifest and detect corruptions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-fsck-"));
  const store = new Store(join(root, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const REF_SHAPED_JSON = { id: "question:bogus", revision: 1, hash: "0".repeat(64) };

  // Part with text containing JSON that resembles a Ref object
  const partText = JSON.stringify({ candidate: REF_SHAPED_JSON, label: "Should not be parsed as ref" });
  const partHash = digest(partText);
  const partId = requestPartId("p", partText);

  const partValue: RequestPart = {
    contract: REQUEST_PART_CONTRACT,
    projectId: "p",
    hash: partHash,
    text: partText,
    chars: partText.length,
    bytes: Buffer.byteLength(partText),
  };

  const [partRef] = store.writeMany([
    {
      id: partId,
      kind: REQUEST_PART_KIND,
      expected: 0,
      value: partValue,
    },
  ]);

  // referenceSites on request-part must return NO refs, treating text as data
  const sitesPart = referenceSites(REQUEST_PART_KIND, partValue);
  assert.deepEqual(sitesPart, [], "request-part text must not produce engine refs");

  // Manifest pointing to part
  const manifestId = "request-manifest:req-fsck-1";
  const manifestValue: RequestManifest = {
    contract: REQUEST_MANIFEST_CONTRACT,
    projectId: "p",
    draftId: "d-1",
    requestId: "req-fsck-1",
    parts: [reference(partRef!)],
    chars: partText.length,
    bytes: Buffer.byteLength(partText),
    sha256: partHash,
    wire: {
      chars: partText.length,
      bytes: Buffer.byteLength(partText),
      sha256: partHash,
    },
  };

  store.writeMany([
    {
      id: manifestId,
      kind: REQUEST_MANIFEST_KIND,
      expected: 0,
      value: manifestValue,
    },
  ]);

  const sitesManifest = referenceSites(REQUEST_MANIFEST_KIND, manifestValue);
  assert.equal(sitesManifest.length, 1);
  assert.equal(sitesManifest[0]!.ref.id, partId);

  // fsck integrity check must pass cleanly
  const integrity = checkStoreIntegrity(store);
  assert.equal(integrity.findings.length, 0, "Store integrity must pass with valid manifest and parts");

  // FSCK corruption check: manifest with missing part reference
  const brokenManifestId = "request-manifest:req-fsck-broken";
  store.writeMany([
    {
      id: brokenManifestId,
      kind: REQUEST_MANIFEST_KIND,
      expected: 0,
      value: {
        ...manifestValue,
        requestId: "req-fsck-broken",
        parts: [{ id: "request-part:p:missing-hash", revision: 1, hash: "0".repeat(64) }],
      },
    },
  ]);

  const brokenIntegrity = checkStoreIntegrity(store);
  assert.ok(brokenIntegrity.findings.length > 0, "fsck must report findings for missing referenced parts");
});

// -----------------------------------------------------------------------------
// 7. Storage Volume Savings Benchmark (Raw Text + Serialized Records)
// -----------------------------------------------------------------------------
test("storage benchmark: request-manifest achieves substantial deduplication savings across raw text and serialized DB", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omg-drs1a-bench-"));
  const legacyDbPath = join(root, "legacy.sqlite");
  const manifestDbPath = join(root, "manifest.sqlite");
  const legacyStore = new Store(legacyDbPath);
  const manifestStore = new Store(manifestDbPath);
  t.after(() => {
    legacyStore.close();
    manifestStore.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Fixed large prompt (~10 KB) and common context (~20 KB)
  const largePrompt = "Detailed analytical instructions and architectural rubric.\n".repeat(200);
  const largeCommonSubject = {
    repositoryMap: { files: Array.from({ length: 150 }, (_, i) => `src/module_${i}.ts`) },
    invariants: Array.from({ length: 50 }, (_, i) => ({ id: i, rule: `Invariant rule ${i}` })),
  };

  const N = 10;

  // 1. Store N calls with legacy model-request
  for (let i = 0; i < N; i++) {
    const requestId = `call-legacy-${i}`;
    const envelope: ResearchEnvelopeFrame = {
      protocol: "omg-agent/v1",
      requestId,
      mode: "research",
      model: "claude-3-7-sonnet",
      effort: "high",
      prompt: largePrompt,
    };
    const subject = { ...largeCommonSubject, turn: i, callSpecificNote: `Unique note for turn ${i}` };
    const wire = JSON.stringify({ ...envelope, subject });
    legacyStore.writeMany([
      {
        id: `model-request:${requestId}`,
        kind: "model-request",
        expected: 0,
        value: { projectId: "p", draftId: "d-1", text: wire },
      },
    ]);
  }

  // 2. Store N calls with request-manifest/v1
  for (let i = 0; i < N; i++) {
    const requestId = `call-manifest-${i}`;
    const envelope: ResearchEnvelopeFrame = {
      protocol: "omg-agent/v1",
      requestId,
      mode: "research",
      model: "claude-3-7-sonnet",
      effort: "high",
      prompt: largePrompt,
    };
    const subject = { ...largeCommonSubject, turn: i, callSpecificNote: `Unique note for turn ${i}` };
    const prepared = prepareRequestPartsAndManifest({
      store: manifestStore,
      projectId: "p",
      draftId: "d-1",
      requestId,
      envelope,
      subject,
    });
    manifestStore.writeMany(prepared.writes, prepared.guards);
  }

  // 1. Count raw text bytes stored in request-part vs model-request
  const legacyStoredRecords = legacyStore.list<{ text: string }>("model-request");
  const legacyTotalTextBytes = legacyStoredRecords.reduce(
    (acc, r) => acc + Buffer.byteLength(r.value.text, "utf8"),
    0
  );

  const manifestStoredParts = manifestStore.list<RequestPart>(REQUEST_PART_KIND);
  const manifestTotalPartBytes = manifestStoredParts.reduce(
    (acc, r) => acc + Buffer.byteLength(r.value.text, "utf8"),
    0
  );

  const rawSavingsRatio = legacyTotalTextBytes / manifestTotalPartBytes;

  // 2. Count total serialized DB bytes across all created records and revisions
  const legacyAllRecords = legacyStore.list();
  const legacyTotalRecordBytes = legacyAllRecords.reduce(
    (acc, r) => acc + Buffer.byteLength(JSON.stringify(r.value), "utf8"),
    0
  );

  const manifestAllRecords = manifestStore.list();
  const manifestTotalRecordBytes = manifestAllRecords.reduce(
    (acc, r) => acc + Buffer.byteLength(JSON.stringify(r.value), "utf8"),
    0
  );

  const serializedSavingsRatio = legacyTotalRecordBytes / manifestTotalRecordBytes;

  // 3. Physical SQLite file size
  const legacyDbBytes = statSync(legacyDbPath).size;
  const manifestDbBytes = statSync(manifestDbPath).size;
  const sqliteRatio = legacyDbBytes / manifestDbBytes;

  console.log(`[DRS1a Storage Benchmark]:
  Raw Text:       legacy=${legacyTotalTextBytes} B, manifest=${manifestTotalPartBytes} B, savings=${rawSavingsRatio.toFixed(2)}x (${((1 - 1/rawSavingsRatio)*100).toFixed(1)}%)
  Serialized DB:  legacy=${legacyTotalRecordBytes} B, manifest=${manifestTotalRecordBytes} B, savings=${serializedSavingsRatio.toFixed(2)}x (${((1 - 1/serializedSavingsRatio)*100).toFixed(1)}%)
  SQLite File:    legacy=${legacyDbBytes} B, manifest=${manifestDbBytes} B, savings=${sqliteRatio.toFixed(2)}x`);

  assert.ok(
    rawSavingsRatio > 3.0,
    `Expected raw text savings (>3x), got ${rawSavingsRatio.toFixed(2)}x (legacy: ${legacyTotalTextBytes} B, manifest parts: ${manifestTotalPartBytes} B)`
  );
  assert.ok(
    serializedSavingsRatio > 1.5,
    `Expected total serialized DB savings (>1.5x), got ${serializedSavingsRatio.toFixed(2)}x (legacy: ${legacyTotalRecordBytes} B, manifest: ${manifestTotalRecordBytes} B)`
  );
});

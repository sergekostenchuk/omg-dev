import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../src/errors.js";
import { canonical, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { Selector } from "../src/evidence/evidence.js";
import type { Revision, Store } from "../src/storage/store.js";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_FRAME_INTERPRETATIONS_CONTRACT,
  V7_FRAME_INTERPRETATIONS_KIND } from "../src/discovery/v7-contracts.js";
import { projectFrameInterpretations } from "../src/discovery/frame-interpretations.js";
import type { FrameSubjectRequest } from "../src/discovery/frame-interpretation-subject.js";
import { readArchiveBody } from "../src/discovery/request-parts.js";
import { requirePacketMaterialDelivery } from "../src/discovery/research-delivery.js";
import { contextValue, prepareFrameInterpretationContextPacker
  } from "../src/discovery/working-context.js";
import { prepareFrameInterpretationEnvelope, checkFrameInterpretationEnvelope,
  FRAME_INTERPRETATION_ENVELOPE_CONTRACT } from "../src/discovery/frame-interpretation-packing.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, questionOf, validFrame, validPlan, planQuestion,
  type DiscoveryFixture } from "./discovery-v7-fixture.js";

// DR2b 2b-PACK (codex-omg №15201/№15208): packing the complete interpretation
// request into the exact archive and bounded wire — proven draft/question
// metadata, no head guards, atomic staging after a full measurement, restore
// of every byte including the previous-set chain. No model call, ledger,
// provider, payment, choice or set publication.

const TEXT_BRIEF = "XX Учёт материалов ведётся на центральном складе и списание идёт на каждом объекте. YY";
const RANGE = { kind: "text-range", start: 3, end: 62 } as const;

const state = (store: Store, wireFile: string) => ({
  heads: canonical(store.list()),
  revisions: canonical(store.list().map(row => [row.id, store.history(row.id)])),
  calls: canonical(store.list("model-call")),
  ledger: canonical(store.list("research-budget-ledger")),
  wire: existsSync(wireFile) ? readFileSync(wireFile, "utf8") : null,
});
function noWrite<T>(store: Store, wireFile: string, action: () => Promise<T>): Promise<T>;
function noWrite<T>(store: Store, wireFile: string, action: () => T): T;
function noWrite(store: Store, wireFile: string, action: () => unknown): unknown {
  const before = state(store, wireFile);
  const verify = () => assert.deepEqual(state(store, wireFile), before,
    "a read-only block changed the saved state");
  try {
    const result = action();
    if (result instanceof Promise) return result.finally(verify);
    verify();
    return result;
  } catch (error) {
    verify();
    throw error;
  }
}
const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};
const field = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    return ((error as EngineError).details as { field?: string } | null)?.field ?? "?";
  }
  return "no-error";
};

interface Base {
  src: Revision<{ content: string }>;
  draft: Revision<DiscoveryDraft>;
  briefQ: Revision<Question>;
  planQ: Revision<Question>;
  frameQ: Revision<Question>;
  frameRef: Ref;
  mandate: { source: Ref; selector: Selector };
}

/** A real v7 D1 draft: the exact Source, the brief fact observed verbatim, the
 * owner objective and the assessed frame — each through its own producer. */
function base(f: DiscoveryFixture, project: string, sourceKey = "brief-src"): Base {
  const selector: Selector = { ...RANGE };
  const src = f.discovery.evidence.document(project, sourceKey, TEXT_BRIEF, "text/plain", 0);
  const draft = createPartialV7Draft(f.discovery, project, "concept", [reference(src)]);
  const briefQ = questionOf(f.store, draft, "brief");
  f.engine.discovery.fact(briefQ.id, briefQ.revision, reference(src), selector);
  const objective = questionOf(f.store, draft, "objective");
  f.engine.discovery.decision(objective.id, f.store.get<Question>(objective.id)!.revision,
    "owner", `Deliver ${project} outcome`);
  const frameQ = questionOf(f.store, draft, "frame");
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!,
    f.store.get<Question>(frameQ.id)!, validFrame(), src);
  const planQ = questionOf(f.store, draft, "plan");
  const frameRef = f.store.get<Question>(frameQ.id)!.value.answer!;
  return { src, draft, briefQ, planQ, frameQ, frameRef, mandate: { source: reference(src), selector } };
}

const requestOf = (project: string, b: Base, previousSet?: Ref | null): FrameSubjectRequest =>
  ({ project, frame: b.frameRef, mandate: b.mandate as FrameSubjectRequest["mandate"],
    ...(previousSet !== undefined ? { previousSet } : {}) });
const envelopeInput = { prompt: "Build the interpretations set for this frame.",
  packetChars: 150000, limitChars: 200000 };

function writeStructuralSet(store: Store, value: Record<string, unknown>): Ref {
  const projected = projectFrameInterpretations(value);
  const row = store.write({ id: projected.id, kind: V7_FRAME_INTERPRETATIONS_KIND,
    expected: 0, value: projected.value });
  return reference(row);
}
const plainSet = (project: string, brief: { source: Ref; selector: Json }, frame: Ref,
  previousSet: Ref | null = null): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project,
  brief: { source: { ...brief.source }, selector: structuredClone(brief.selector) },
  frame, previousSet, outcome: "no_divergence",
  reason: "One warehouse reading, no divergence", interpretations: [] });

test("2b-P a small request packs whole into the exact archive: proven metadata, bounded packet, measured capacity, cold restore of every byte", (t) => {
  const f = discoveryFixture(t, "omg-2bp-main-"), project = "garden";
  const wireFile = join(f.root, "wire.ndjson");
  const first = base(f, project, "brief-src");
  const prev = writeStructuralSet(f.store, plainSet(project, first.mandate, first.frameRef));
  const b = base(f, project, "brief-src-2");
  const req = requestOf(project, b, prev);
  const before = state(f.store, wireFile);
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput);
  // Packing writes only research-context archives — no calls, ledger, wire,
  // set publication or choice.
  const after = state(f.store, wireFile);
  assert.equal(after.calls, "[]"); assert.equal(after.ledger, "[]"); assert.equal(after.wire, null);
  const newIds = (JSON.parse(after.heads) as { id: string; kind: string }[])
    .filter(row => !(JSON.parse(before.heads) as { id: string }[]).some(o => o.id === row.id));
  assert.ok(newIds.length >= 1 && newIds.every(row => row.kind === "research-context"),
    "packing staged only context archives");
  assert.equal(env.contract, FRAME_INTERPRETATION_ENVELOPE_CONTRACT);
  // Proven exact metadata — the draft/question revisions the subject proves.
  const row = f.store.get(env.archive.id, env.archive.revision)!;
  const rowValue = row.value as Record<string, any>;
  assert.equal(row.kind, "research-context");
  assert.equal(rowValue.draft.revision, (env.request.subject.frame.draft as { revision: number }).revision);
  assert.equal(rowValue.question.revision, (env.request.subject.frame.question as { revision: number }).revision);
  // The whole request — linkage, subject, instruction and schema — inside the
  // archived body byte for byte; the previous set chain travels inside it.
  const restored = readArchiveBody(f.store, row).body;
  assert.equal(canonical(restored['frameRequest']), canonical(env.request));
  assert.equal(canonical(restored['frameRequest'].subject.previous?.record
    ? reference(restored['frameRequest'].subject.previous.record) : null), canonical(prev));
  // The bounded packet names its archive and keeps the request inline.
  assert.equal(canonical(env.packet.working.archive), canonical(env.archive));
  assert.ok(env.packet.frameRequest !== undefined, "small material crosses inline");
  assert.ok(env.capacity.forms[0]!.minimumChars > 0 && env.measuredChars > 0
    && env.measuredChars <= envelopeInput.limitChars);
  assert.equal(env.capacity.bindings.request, env.request.request);
  // A cold store restores the same bytes; check verifies a presented copy.
  const cold = f.open();
  assert.equal(canonical(readArchiveBody(cold, cold.get(env.archive.id, env.archive.revision)!).body['frameRequest']),
    canonical(env.request));
  noWrite(cold, wireFile,
    () => assert.deepEqual(checkFrameInterpretationEnvelope(cold, req, envelopeInput,
      structuredClone(env)), env));
});

test("2b-P a large request names its exact address and a nonempty bounded page — every byte still restores", (t) => {
  const f = discoveryFixture(t, "omg-2bp-page-"), project = "yard";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const tight = { prompt: "Build the interpretations set.", packetChars: 6000, limitChars: 20000 };
  const env = prepareFrameInterpretationEnvelope(f.store, req, tight);
  const addresses = env.packet.working.materialAddresses as { field: string; pointer: string }[] | undefined;
  assert.ok(Array.isArray(addresses) && addresses.some(a => a.field === "frameRequest"),
    "the oversized request is addressed, not inlined");
  assert.ok(env.packet.frameRequest === undefined, "the full field left the packet");
  const delivery = env.packet.materialDelivery as { contract: string }[] | undefined;
  assert.ok(Array.isArray(delivery) && delivery.length === 1
    && delivery[0]!.contract === "research-delivery/v1",
    "a nonempty bounded page rides beside the address");
  // The address resolves to the saved bytes on a cold store; a substituted
  // page is refused by the shared delivery check.
  const cold = f.open();
  const row = cold.get(env.archive.id, env.archive.revision)!;
  const restored = readArchiveBody(cold, row).body['frameRequest'];
  assert.equal(canonical(restored), canonical(env.request));
  const resolve = (_record: Ref, pointer: string) =>
    contextValue({ ...(row.value as Record<string, any>), body: readArchiveBody(cold, row).body }, pointer);
  noWrite(cold, wireFile, () => {
    requirePacketMaterialDelivery(env.packet, env.archive, resolve);
    const tampered = structuredClone(env.packet);
    tampered.materialDelivery[0] = { ...tampered.materialDelivery[0], text: "retold" };
    assert.equal(code(() => requirePacketMaterialDelivery(tampered, env.archive, resolve)),
      "research_context_undelivered");
    // A page addressed at another archive refuses as foreign material.
    assert.equal(code(() => requirePacketMaterialDelivery(env.packet,
      { ...env.archive, hash: "0".repeat(64) } as Ref, resolve)),
      "research_context_undelivered");
  });
});

test("2b-P the physical limit refuses with zero staged writes — heads, calls, ledger and wire untouched", (t) => {
  const f = discoveryFixture(t, "omg-2bp-limit-"), project = "shed";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  noWrite(f.store, wireFile, () => {
    // A bound that cannot admit the mandatory grounds: the staged archive is
    // prepared, capacity refuses, and commit never runs.
    const refused = code(() => prepareFrameInterpretationEnvelope(f.store, req,
      { prompt: "Build the interpretations set.", packetChars: 1999, limitChars: 2000 }));
    assert.ok(["pilot_core_limit", "research_capacity_configuration"].includes(refused), refused);
    assert.equal(f.store.list().filter(row => row.kind === "research-context").length, 0,
      "a refused envelope left no staged archive");
    // A bound the packet itself cannot keep refuses the same way.
    assert.equal(code(() => prepareFrameInterpretationEnvelope(f.store, req,
      { prompt: "Build the interpretations set.", packetChars: 200, limitChars: 300 })),
      "pilot_core_limit");
  });
});

test("2b-P missing, null, truncated and tampered envelopes refuse at their field", (t) => {
  const f = discoveryFixture(t, "omg-2bp-form-"), project = "barn";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput);
  // An envelope of another real draft — its own exact archive.
  const alien = base(f, "other-yard", "alien-src");
  const alienEnv = prepareFrameInterpretationEnvelope(f.store, requestOf("other-yard", alien), envelopeInput);
  noWrite(f.store, wireFile, () => {
    for (const presented of [null, 42, "envelope", []])
      assert.equal(code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput, presented)),
        "frame_pack_invalid");
    const at = (mutate: (v: Record<string, unknown>) => void): [string, string] => {
      const bad = structuredClone(env) as unknown as Record<string, unknown>;
      mutate(bad);
      return [code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput, bad)),
        field(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput, bad))];
    };
    assert.deepEqual(at(v => { delete v.packet; }), ["frame_pack_invalid", "envelope.packet"]);
    assert.deepEqual(at(v => { v.paid = true; }), ["frame_pack_invalid", "envelope.paid"]);
    // A truncated request inside the envelope fails the closed request form.
    const cut = structuredClone(env) as unknown as Record<string, unknown>;
    delete (cut.request as Record<string, unknown>).instruction;
    assert.equal(code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput, cut)),
      "frame_request_invalid");
    // A changed instruction reaches the request decoder, never the compare.
    const instr = structuredClone(env) as unknown as Record<string, unknown>;
    (instr.request as Record<string, unknown>).instruction = "Pick the winner";
    assert.equal(code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput, instr)),
      "frame_request_invalid");
    // A swapped archive address is a binding mismatch.
    assert.deepEqual(at(v => { v.archive = alienEnv.archive; }),
      ["frame_pack_mismatch", "archive"]);
  });
});

test("2b-P heads moved before preparation and by a second store between staging and commit: proven metadata and the whole request survive", (t) => {
  const f = discoveryFixture(t, "omg-2bp-heads-"), project = "attic";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const provenDraft = f.store.get<DiscoveryDraft>(b.draft.id)!;
  const provenQuestion = f.store.get<Question>(b.frameQ.id)!;
  // Move heads BEFORE preparation: the plan answer advancing the same draft
  // head and the brief question reopened. The mandate's Source head moves
  // only afterwards — a new input revision would stale every later answer.
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(b.draft.id)!,
    f.store.get<Question>(b.planQ.id)!,
    validPlan(b.frameRef, [planQuestion("q-site", "industry", "blocking")]), b.src);
  f.discovery.reopen(b.briefQ.id, f.store.get<Question>(b.briefQ.id)!.revision);
  const headDraft = f.store.get<DiscoveryDraft>(b.draft.id)!;
  const headQuestion = f.store.get<Question>(b.briefQ.id)!;
  assert.ok(headDraft.revision > provenDraft.revision, "the draft head moved");
  assert.ok(headQuestion.revision > b.briefQ.revision, "the brief question head moved");
  // The packer's staged records; a second store moves the mandate's Source
  // head between staging and commit — no head guard exists to refuse it, and
  // the archive keeps the proven revision.
  const packer = prepareFrameInterpretationContextPacker(f.store, project, req);
  const packet = packer.pack(packer.context, 200000,
    { purpose: "frame-interpretation-request", common: true });
  const moving = f.open();
  const movingDiscovery = new Discovery(moving);
  movingDiscovery.reopen(b.frameQ.id, moving.get<Question>(b.frameQ.id)!.revision);
  movingDiscovery.evidence.document(project, "brief-src", "Поздняя редакция", "text/plain",
    moving.get<{ content: string }>(b.src.id)!.revision);
  assert.ok(f.store.get<Question>(b.frameQ.id)!.revision > provenQuestion.revision,
    "the metadata question head moved mid-staging");
  assert.ok(f.store.get<{ content: string }>(b.src.id)!.revision > b.src.revision,
    "the mandate's source head moved mid-staging");
  packer.commit();
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput);
  const row = f.store.get(env.archive.id, env.archive.revision)!;
  const rowValue = row.value as Record<string, any>;
  assert.equal(canonical(rowValue.draft), canonical(reference(provenDraft)),
    "archive metadata keeps the proven draft revision, not the moved head");
  assert.equal(canonical(rowValue.question), canonical(reference(provenQuestion)));
  assert.equal(canonical(readArchiveBody(f.store, row).body['frameRequest']),
    canonical(env.request));
  // The other packed archive from the same staged batch carries the same
  // proven metadata.
  const staged = f.store.get((packet.working.archive as Ref).id)!;
  assert.equal(canonical((staged.value as Record<string, any>).draft), canonical(reference(provenDraft)));
  // Cold Store after all movement restores the identical request.
  const cold = f.open();
  assert.equal(canonical(readArchiveBody(cold, cold.get(env.archive.id, env.archive.revision)!).body['frameRequest']),
    canonical(env.request));
  assert.equal(state(f.store, wireFile).wire, null, "no wire record appeared");
});

test("2b-P foreign and substituted grounds refuse before any archive write", (t) => {
  const f = discoveryFixture(t, "omg-2bp-foreign-"), project = "loft";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput);
  const other = base(f, "cellar", "cellar-src");
  const cellarEnv = prepareFrameInterpretationEnvelope(f.store, requestOf("cellar", other), envelopeInput);
  const sibling = f.discovery.evidence.document(project, "sibling", "Другой документ", "text/plain", 0);
  const archivesBefore = f.store.list().filter(row => row.kind === "research-context").length;
  noWrite(f.store, wireFile, () => {
    // A presented request of another project under this request.
    assert.equal(code(() => prepareFrameInterpretationEnvelope(f.store, req, envelopeInput,
      cellarEnv.request)), "frame_request_mismatch");
    // A forged request linkage — substituted source inside the package.
    const forged = structuredClone(env.request) as unknown as Record<string, unknown>;
    (forged.brief as { source: Ref }).source = reference(sibling);
    assert.equal(code(() => prepareFrameInterpretationEnvelope(f.store, req, envelopeInput, forged)),
      "frame_request_mismatch");
    // No archive record appeared for the refused inputs.
    assert.equal(f.store.list().filter(row => row.kind === "research-context").length,
      archivesBefore);
  });
});

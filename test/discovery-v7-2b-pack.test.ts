import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../src/errors.js";
import { canonical, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { Selector } from "../src/evidence/evidence.js";
import { Store, type Revision } from "../src/storage/store.js";
import type { Environment, RoleBinding } from "../src/runtime/environment.js";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_FRAME_INTERPRETATIONS_CONTRACT,
  V7_FRAME_INTERPRETATIONS_KIND } from "../src/discovery/v7-contracts.js";
import { projectFrameInterpretations } from "../src/discovery/frame-interpretations.js";
import type { FrameSubjectRequest } from "../src/discovery/frame-interpretation-subject.js";
import { prepareFrameInterpretationRequest } from "../src/discovery/frame-interpretation-request.js";
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
// The existing role/environment the shared omg-agent/v1 envelope is declared
// over — explicit parameters of the packing API; their presence admits
// nothing (no dispatch and no payment inside preparation).
const ROLE: RoleBinding = { actor: "frame-interpreter", model: "managed-model",
  effort: "high", command: { executable: "managed", args: [] } };
const environmentOf = (project: string): Environment => ({
  projectId: project, workspace: "/tmp/omg-2bp", implementer: ROLE, reviewer: ROLE,
  fullCheck: { executable: "true", args: [] }, timeoutMs: 60000 });
const envelopeInput = (project: string) => ({
  prompt: "Build the interpretations set for this frame.",
  packetChars: 150000, limitChars: 200000, role: ROLE, environment: environmentOf(project) });

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
  const input = envelopeInput(project);
  const before = state(f.store, wireFile);
  const env = prepareFrameInterpretationEnvelope(f.store, req, input);
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
  // The actual complete omg-agent/v1 input — model, effort, requestId, the
  // packed context as subject, the admission and the response bound — is
  // returned and measured, not the admission alone.
  const wire = JSON.parse(env.input) as Record<string, any>;
  assert.equal(wire.protocol, "omg-agent/v1");
  assert.equal(wire.model, ROLE.model); assert.equal(wire.effort, ROLE.effort);
  assert.ok(typeof wire.requestId === "string" && wire.requestId.length > 0);
  assert.equal(canonical(wire.subject.resultCapacity), canonical(env.capacity));
  assert.equal(wire.subject.responseOutputLimit.contract, "research-output-limit/v1");
  assert.equal(wire.subject.working.archive.id, env.archive.id);
  assert.ok(!Object.hasOwn(wire.subject, "question"), "no D1 question schema in the wire subject");
  assert.equal(env.measuredChars, env.input.length);
  assert.ok(env.capacity.forms[0]!.minimumChars > 0 && env.measuredChars > 0
    && env.measuredChars <= input.limitChars);
  assert.equal(env.capacity.bindings.request, env.request.request);
  // A cold store restores the same bytes; check verifies a presented copy.
  const cold = f.open();
  assert.equal(canonical(readArchiveBody(cold, cold.get(env.archive.id, env.archive.revision)!).body['frameRequest']),
    canonical(env.request));
  noWrite(cold, wireFile,
    () => assert.deepEqual(checkFrameInterpretationEnvelope(cold, req, input,
      structuredClone(env)), env));
});

test("2b-P a large request names its exact address and a nonempty bounded page — every byte still restores", (t) => {
  const f = discoveryFixture(t, "omg-2bp-page-"), project = "yard";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const tight = { prompt: "Build the interpretations set.", packetChars: 6000, limitChars: 20000,
    role: ROLE, environment: environmentOf(project) };
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
      { prompt: "Build the interpretations set.", packetChars: 1999, limitChars: 2000,
        role: ROLE, environment: environmentOf(project) }));
    assert.ok(["pilot_core_limit", "research_capacity_configuration"].includes(refused), refused);
    assert.equal(f.store.list().filter(row => row.kind === "research-context").length, 0,
      "a refused envelope left no staged archive");
    // The shared envelope builder's own physical check: the complete input
    // exceeding the declared bound refuses before any archive write.
    assert.equal(code(() => prepareFrameInterpretationEnvelope(f.store, req,
      { prompt: "Build the interpretations set.", packetChars: 4500, limitChars: 5000,
        role: ROLE, environment: environmentOf(project) })),
      "pilot_request_limit");
    assert.equal(f.store.list().filter(row => row.kind === "research-context").length, 0);
    // A bound the packet itself cannot keep refuses the same way.
    assert.equal(code(() => prepareFrameInterpretationEnvelope(f.store, req,
      { prompt: "Build the interpretations set.", packetChars: 200, limitChars: 300,
        role: ROLE, environment: environmentOf(project) })),
      "pilot_core_limit");
  });
});

test("2b-P missing, null, truncated and tampered envelopes refuse at their field", (t) => {
  const f = discoveryFixture(t, "omg-2bp-form-"), project = "barn";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput(project));
  // An envelope of another real draft — its own exact archive.
  const alien = base(f, "other-yard", "alien-src");
  const alienEnv = prepareFrameInterpretationEnvelope(f.store, requestOf("other-yard", alien), envelopeInput("other-yard"));
  noWrite(f.store, wireFile, () => {
    for (const presented of [null, 42, "envelope", []])
      assert.equal(code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput(project), presented)),
        "frame_pack_invalid");
    const at = (mutate: (v: Record<string, unknown>) => void): [string, string] => {
      const bad = structuredClone(env) as unknown as Record<string, unknown>;
      mutate(bad);
      return [code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput(project), bad)),
        field(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput(project), bad))];
    };
    assert.deepEqual(at(v => { delete v.packet; }), ["frame_pack_invalid", "envelope.packet"]);
    assert.deepEqual(at(v => { delete v.input; }), ["frame_pack_invalid", "envelope.input"]);
    assert.deepEqual(at(v => { v.paid = true; }), ["frame_pack_invalid", "envelope.paid"]);
    // A truncated request inside the envelope fails the closed request form.
    const cut = structuredClone(env) as unknown as Record<string, unknown>;
    delete (cut.request as Record<string, unknown>).instruction;
    assert.equal(code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput(project), cut)),
      "frame_request_invalid");
    // A changed instruction reaches the request decoder, never the compare.
    const instr = structuredClone(env) as unknown as Record<string, unknown>;
    (instr.request as Record<string, unknown>).instruction = "Pick the winner";
    assert.equal(code(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput(project), instr)),
      "frame_request_invalid");
    // A swapped archive address is a binding mismatch.
    assert.deepEqual(at(v => { v.archive = alienEnv.archive; }),
      ["frame_pack_mismatch", "archive"]);
    // A foreign request and a changed complete input reach the field compare.
    assert.deepEqual(at(v => { v.request = alienEnv.request; }),
      ["frame_pack_mismatch", "request"]);
    assert.deepEqual(at(v => { v.input = `${v.input} `; }),
      ["frame_pack_mismatch", "input"]);
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
  const packet = packer.pack(200000);
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
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput(project));
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
  // 2B-PACK-03: an already-saved exact archive resolves identically on a
  // re-pack — reopening the metadata question head must not push the
  // addressed material through the current-basis reader (context_reference_stale).
  f.discovery.reopen(b.frameQ.id, f.store.get<Question>(b.frameQ.id)!.revision);
  const again = prepareFrameInterpretationEnvelope(f.store, req,
    { prompt: "Build the interpretations set.", packetChars: 6000, limitChars: 20000,
      role: ROLE, environment: environmentOf(project) });
  assert.equal(canonical(again.archive), canonical(env.archive),
    "the re-pack names the same content-addressed archive");
  const addresses = again.packet.working.materialAddresses as { field: string }[] | undefined;
  assert.ok(addresses?.some(a => a.field === "frameRequest"), "the oversized request stays addressed");
  assert.ok(Array.isArray(again.packet.materialDelivery), "a nonempty page rides again");
  noWrite(f.open(), wireFile, () => checkFrameInterpretationEnvelope(f.open(), req,
    { prompt: "Build the interpretations set.", packetChars: 6000, limitChars: 20000,
      role: ROLE, environment: environmentOf(project) }, structuredClone(again)));
});

test("2b-P the checking door never commits: a presented envelope with null capacity refuses leaving zero archives on a fresh set", (t) => {
  const f = discoveryFixture(t, "omg-2bp-check-"), project = "vault";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  // A plausibly closed envelope over the real proven request — but never
  // prepared here, so the archive set is still empty. The saved-archive gate
  // runs before capacity: without the exact archive nothing can be admitted.
  const presented = {
    contract: FRAME_INTERPRETATION_ENVELOPE_CONTRACT,
    request: prepareFrameInterpretationRequest(f.store, req),
    archive: { id: `research-context:${"1".repeat(64)}`, revision: 1, hash: "1".repeat(64) },
    packet: { working: {} },
    capacity: null,
    input: "{}",
    measuredChars: 2,
  };
  noWrite(f.store, wireFile, () => {
    assert.deepEqual([code(() => checkFrameInterpretationEnvelope(f.store, req,
      envelopeInput(project), presented)),
      field(() => checkFrameInterpretationEnvelope(f.store, req, envelopeInput(project), presented))],
      ["frame_pack_mismatch", "archive"]);
    assert.equal(f.store.list().filter(row => row.kind === "research-context").length, 0,
      "the checking door left zero staged archives");
    assert.equal(f.store.list("model-call").length, 0);
    assert.equal(f.store.list("research-budget-ledger").length, 0);
  });
  // With the archive physically saved, a null capacity reaches its own door —
  // still a read-only refusal.
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput(project));
  const archives = f.store.list().filter(row => row.kind === "research-context").length;
  const nullCapacity = { ...structuredClone(env), capacity: null };
  noWrite(f.store, wireFile, () => {
    assert.equal(code(() => checkFrameInterpretationEnvelope(f.store, req,
      envelopeInput(project), nullCapacity)), "research_capacity_invalid");
    assert.equal(f.store.list().filter(row => row.kind === "research-context").length, archives,
      "the capacity refusal left the saved set untouched");
  });
});

test("2b-P packer surfaces stay sealed: a mutated packet, staged write or record can never reach the committed archive", (t) => {
  const f = discoveryFixture(t, "omg-2bp-sealed-"), project = "vault2";
  const b = base(f, project);
  const req = requestOf(project, b);
  const packer = prepareFrameInterpretationContextPacker(f.store, project, req);
  const packet = packer.pack(200000);
  const archiveRef = packet.working.archive as Ref;
  // Probe 1 (the inline packet): the returned packet is a detached copy —
  // its mutation must not reach the closed commit payload.
  (packet as any).frameRequest.instruction = "Pick the winner";
  // Probe 2 (staged writes) and probe 3 (the records map): returned values
  // are copies, so their mutation lands outside the internal batch.
  const exposed = packer.staged();
  (exposed.writes[0]!.value as any).body.frameRequest.instruction = "Pick the winner";
  ([...exposed.records.values()][0]!.value as any).body.frameRequest.instruction = "Pick the winner";
  packer.commit();
  const row = f.store.get(archiveRef.id, archiveRef.revision)!;
  assert.equal((row.value as any).body.frameRequest.instruction,
    packer.request.instruction, "the committed archive kept the proven instruction");
  assert.equal(row.hash, archiveRef.hash,
    "the stored bytes still match the content-addressed Ref");
});

test("2b-P a lawful check needs the really saved archive: a cold snapshot with every ground but no archive refuses read-only", async (t) => {
  const f = discoveryFixture(t, "omg-2bp-snap-"), project = "freezer";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  // A byte copy of the real database while the grounds exist and the archive
  // does not — the missing-archive door is provable on real saved state.
  const snap = await f.store.snapshot(join(f.root, "snapshots"));
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput(project));
  // A lawful check returns the fresh envelope unchanged.
  assert.deepEqual(checkFrameInterpretationEnvelope(f.store, req, envelopeInput(project),
    structuredClone(env)), env);
  const cold = new Store(snap.path);
  t.after(() => cold.close());
  const tight = { prompt: "Build the interpretations set.", packetChars: 6000,
    limitChars: 20000, role: ROLE, environment: environmentOf(project) };
  const addressed = prepareFrameInterpretationEnvelope(f.store, req, tight);
  noWrite(cold, wireFile, () => {
    // Inline material: the missing exact archive refuses at the binding.
    assert.deepEqual([code(() => checkFrameInterpretationEnvelope(cold, req,
      envelopeInput(project), structuredClone(env))),
      field(() => checkFrameInterpretationEnvelope(cold, req, envelopeInput(project),
        structuredClone(env)))], ["frame_pack_mismatch", "archive"]);
    assert.equal(cold.get(env.archive.id, env.archive.revision), null,
      "the staged form never became a saved record");
    // Addressed material: same door, the page can never resolve unsaved bytes.
    assert.equal(code(() => checkFrameInterpretationEnvelope(cold, req, tight,
      structuredClone(addressed))), "frame_pack_mismatch");
    assert.equal(cold.get(addressed.archive.id, addressed.archive.revision), null);
  });
});

test("2b-P foreign and substituted grounds refuse before any archive write", (t) => {
  const f = discoveryFixture(t, "omg-2bp-foreign-"), project = "loft";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const env = prepareFrameInterpretationEnvelope(f.store, req, envelopeInput(project));
  const other = base(f, "cellar", "cellar-src");
  const cellarEnv = prepareFrameInterpretationEnvelope(f.store, requestOf("cellar", other), envelopeInput("cellar"));
  const sibling = f.discovery.evidence.document(project, "sibling", "Другой документ", "text/plain", 0);
  const archivesBefore = f.store.list().filter(row => row.kind === "research-context").length;
  noWrite(f.store, wireFile, () => {
    // A presented request of another project under this request.
    assert.equal(code(() => prepareFrameInterpretationEnvelope(f.store, req, envelopeInput(project),
      cellarEnv.request)), "frame_request_mismatch");
    // A forged request linkage — substituted source inside the package.
    const forged = structuredClone(env.request) as unknown as Record<string, unknown>;
    (forged.brief as { source: Ref }).source = reference(sibling);
    assert.equal(code(() => prepareFrameInterpretationEnvelope(f.store, req, envelopeInput(project), forged)),
      "frame_request_mismatch");
    // No archive record appeared for the refused inputs.
    assert.equal(f.store.list().filter(row => row.kind === "research-context").length,
      archivesBefore);
  });
});

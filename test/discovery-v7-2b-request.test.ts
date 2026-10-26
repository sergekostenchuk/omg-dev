import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { Selector } from "../src/evidence/evidence.js";
import type { Revision, Store } from "../src/storage/store.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_FRAME_INTERPRETATIONS_CONTRACT,
  V7_FRAME_INTERPRETATIONS_KIND } from "../src/discovery/v7-contracts.js";
import { projectFrameInterpretations } from "../src/discovery/frame-interpretations.js";
import type { FrameSubjectRequest } from "../src/discovery/frame-interpretation-subject.js";
import { prepareFrameInterpretationRequest, checkFrameInterpretationRequest,
  checkFrameInterpretationAnswer, FRAME_INTERPRETATION_REQUEST_CONTRACT,
  FRAME_INTERPRETATION_INSTRUCTION, FRAME_INTERPRETATIONS_SCHEMA,
  type FrameInterpretationRequest } from "../src/discovery/frame-interpretation-request.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, questionOf, validFrame, type DiscoveryFixture } from "./discovery-v7-fixture.js";

// DR2b 2b-REQUEST (codex-omg №15141): the read-only preparatory projector of
// the interpretations request — the complete proven subject verbatim, exact
// linkage derived from it, the fixed instruction and the closed answer schema
// under one derived identity. Preparing is not sending: no write, no model
// call, no choice, no paid or accepted mark; a previous set stays structural.

const TEXT_BRIEF = "XX Учёт материалов ведётся на центральном складе и списание идёт на каждом объекте. YY";
const RANGE = { kind: "text-range", start: 3, end: 62 } as const;
const JSON_DOC = JSON.stringify({ meta: { author: "owner" },
  brief: "Учёт материалов: склад и списание на объектах", extra: { notes: ["a", "b"] } });

/** A read-only block boundary: full heads, full revision rows, model calls,
 * the research-budget-ledger and the wire file's absence stay byte-identical
 * across the action — also when the action refuses. */
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
  frameQ: Revision<Question>;
  frameRef: Ref;
  mandate: { source: Ref; selector: Selector };
}

/** A real v7 D1 draft: the exact Source, the brief fact observed verbatim, the
 * owner objective and the assessed frame — each through its own producer. */
function base(f: DiscoveryFixture, project: string, variant: "text" | "json" = "text",
  sourceKey = "brief-src"): Base {
  const json = variant === "json";
  const content = json ? JSON_DOC : TEXT_BRIEF;
  const selector: Selector = json ? { kind: "json-pointer", pointer: "/brief" } : { ...RANGE };
  const src = f.discovery.evidence.document(project, sourceKey, content,
    json ? "application/json" : "text/plain", 0);
  const draft = createPartialV7Draft(f.discovery, project, "concept", [reference(src)]);
  const briefQ = questionOf(f.store, draft, "brief");
  f.engine.discovery.fact(briefQ.id, briefQ.revision, reference(src), selector);
  const objective = questionOf(f.store, draft, "objective");
  f.engine.discovery.decision(objective.id, f.store.get<Question>(objective.id)!.revision,
    "owner", `Deliver ${project} outcome`);
  const frameQ = questionOf(f.store, draft, "frame");
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!,
    f.store.get<Question>(frameQ.id)!, validFrame(), src);
  const frameRef = f.store.get<Question>(frameQ.id)!.value.answer!;
  return { src, draft, briefQ, frameQ, frameRef, mandate: { source: reference(src), selector } };
}

const requestOf = (project: string, b: Base, previousSet?: Ref | null): FrameSubjectRequest =>
  ({ project, frame: b.frameRef, mandate: b.mandate as FrameSubjectRequest["mandate"],
    ...(previousSet !== undefined ? { previousSet } : {}) });

function writeStructuralSet(store: Store, value: Record<string, unknown>): Ref {
  const projected = projectFrameInterpretations(value);
  const row = store.write({ id: projected.id, kind: V7_FRAME_INTERPRETATIONS_KIND,
    expected: 0, value: projected.value });
  return reference(row);
}
const subSupports = (sel: Selector): Selector[] =>
  sel.kind === "text-range"
    ? [{ kind: "text-range", start: sel.start, end: Math.floor((sel.start + sel.end) / 2) },
       { kind: "text-range", start: Math.floor((sel.start + sel.end) / 2), end: sel.end }]
    : [sel];
const materialSet = (project: string, brief: { source: Ref; selector: Json }, frame: Ref,
  previousSet: Ref | null = null,
  supports: { warehouse?: Selector; sites?: Selector[] } = {}): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project,
  brief: { source: { ...brief.source }, selector: structuredClone(brief.selector) },
  frame, previousSet, outcome: "material",
  reason: "«Учёт материалов» reads as the warehouse only or also the sites, and the result changes",
  interpretations: [
    { id: "warehouse", meaning: "Central warehouse only",
      consequences: [{ affects: "boundaries", text: "Sites are out of scope" }],
      support: [supports.warehouse ?? structuredClone(brief.selector)] },
    { id: "sites", meaning: "Warehouse and the site write-off",
      consequences: [{ affects: "acceptance", text: "Each site closes its write-off" },
        { affects: "result", text: "The report lists write-offs per site" }],
      support: supports.sites ?? subSupports(brief.selector as Selector) }] });
const plainSet = (project: string, brief: { source: Ref; selector: Json }, frame: Ref,
  previousSet: Ref | null = null): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project,
  brief: { source: { ...brief.source }, selector: structuredClone(brief.selector) },
  frame, previousSet, outcome: "no_divergence",
  reason: "One warehouse reading, no divergence", interpretations: [] });

test("2b-R prepare builds the request over the proven subject: full material verbatim, exact linkage, fixed instruction and schema under one identity", (t) => {
  const f = discoveryFixture(t, "omg-2br-main-"), project = "garden";
  const wireFile = join(f.root, "wire.ndjson");
  const first = base(f, project, "text", "brief-src");
  const prev = writeStructuralSet(f.store, plainSet(project, first.mandate, first.frameRef));
  const b = base(f, project, "text", "brief-src-2");
  const req = requestOf(project, b, prev);
  const request = noWrite(f.store, wireFile,
    () => prepareFrameInterpretationRequest(f.store, req));
  assert.equal(request.contract, FRAME_INTERPRETATION_REQUEST_CONTRACT);
  // The exact linkage is derived from the subject, not the caller's copy.
  assert.equal(request.project, project);
  assert.equal(canonical(request.brief.source), canonical(b.mandate.source));
  assert.deepEqual(request.brief.selector, b.mandate.selector);
  assert.equal(canonical(request.frame), canonical(b.frameRef));
  assert.equal(canonical(request.previousSet), canonical(prev));
  // The whole material inventory: mandate verbatim, frame provenance, the
  // previous set chain — explicitly structural, never a paid mark.
  assert.equal(request.subject.project, project);
  assert.equal(request.subject.mandate.observation.value,
    TEXT_BRIEF.slice(RANGE.start, RANGE.end));
  assert.equal(request.subject.previous!.verification, "structural");
  assert.equal(canonical(reference(request.subject.previous!.record)), canonical(prev));
  assert.ok(request.subject.frame.acceptance.kind === "discovery-acceptance-act");
  // Fixed instruction and closed schema describe the existing contract.
  assert.equal(request.instruction, FRAME_INTERPRETATION_INSTRUCTION);
  assert.equal(request.instruction.includes("no_divergence"), true);
  assert.equal(request.instruction.includes("at least two interpretations"), true);
  assert.equal(request.instruction.includes("do not choose a winner"), true);
  assert.deepEqual(request.schema, FRAME_INTERPRETATIONS_SCHEMA);
  assert.equal(request.schema.contract, V7_FRAME_INTERPRETATIONS_CONTRACT);
  // The derived identity covers material, instruction and schema together.
  const { request: id, ...rest } = request;
  assert.equal(id, hashJson(rest as never));
  assert.match(id, /^[a-f0-9]{64}$/);
});

test("2b-R check verifies a presented request byte for byte and answers through the accepted transport: both lawful forms", (t) => {
  const f = discoveryFixture(t, "omg-2br-answer-"), project = "yard";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const prepared = prepareFrameInterpretationRequest(f.store, req);
  for (const answer of [materialSet(project, b.mandate, b.frameRef),
    plainSet(project, b.mandate, b.frameRef)]) {
    const out = noWrite(f.store, wireFile,
      () => checkFrameInterpretationAnswer(f.store, req, structuredClone(prepared), answer));
    assert.equal(out.request.request, prepared.request);
    assert.deepEqual(out.request.subject, prepared.subject);
    assert.equal(out.result.verification, "proven");
    assert.equal(canonical(out.result.subject.subject), canonical(prepared.subject.subject));
    // The answer keeps its outcome, texts, consequences and supports.
    const projected = projectFrameInterpretations(answer);
    assert.equal(out.result.answer.id, projected.id);
    assert.deepEqual(out.result.answer.value, projected.value);
    assert.equal(out.result.supports.length,
      projected.value.interpretations.reduce((n, i) => n + i.support.length, 0));
  }
});

test("2b-R missing, null, truncated or tampered request fields are refused at their field — instruction and schema are fixed", (t) => {
  const f = discoveryFixture(t, "omg-2br-form-"), project = "shed";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const prepared = prepareFrameInterpretationRequest(f.store, req);
  const good = () => structuredClone(prepared) as unknown as Record<string, unknown>;
  noWrite(f.store, wireFile, () => {
    for (const presented of [null, 42, "request", []])
      assert.equal(code(() => checkFrameInterpretationRequest(f.store, req, presented)),
        "frame_request_invalid");
    for (const [at, mutate] of [
      ["request.contract", (v: Record<string, unknown>) => { v.contract = "other/v9"; }],
      ["request.subject", (v: Record<string, unknown>) => { delete v.subject; }],
      ["request.instruction", (v: Record<string, unknown>) => { v.instruction = "Pick the best interpretation"; }],
      ["request.schema", (v: Record<string, unknown>) => { v.schema = { contract: "x" }; }],
      ["request.paid", (v: Record<string, unknown>) => { v.paid = true; }]] as const) {
      const bad = good(); mutate(bad);
      assert.equal(code(() => checkFrameInterpretationRequest(f.store, req, bad)),
        "frame_request_invalid", at);
      assert.equal(field(() => checkFrameInterpretationRequest(f.store, req, bad)), at);
    }
    // A truncated material package is refused inside the subject decoder.
    const cut = good();
    delete ((cut.subject as Record<string, unknown>).frame as Record<string, unknown>).grounds;
    assert.equal(code(() => checkFrameInterpretationRequest(f.store, req, cut)),
      "frame_subject_invalid");
    // A forged derived identity or a tampered field under a stale identity.
    const forged = good(); forged.request = "0".repeat(64);
    assert.equal(code(() => checkFrameInterpretationRequest(f.store, req, forged)),
      "frame_request_mismatch");
    assert.equal(field(() => checkFrameInterpretationRequest(f.store, req, forged)), "request");
  });
});

test("2b-R linkage follows the caller's exact addresses: another project, source, selector, frame or previous set is a mismatch", (t) => {
  const f = discoveryFixture(t, "omg-2br-links-"), project = "barn";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const prepared = prepareFrameInterpretationRequest(f.store, req);
  const sibling = f.discovery.evidence.document(project, "sibling",
    "Другой документ того же проекта", "text/plain", 0);
  const otherSet = writeStructuralSet(f.store,
    plainSet(project, b.mandate, reference(b.draft)));
  noWrite(f.store, wireFile, () => {
    const at = (mutate: (v: Record<string, unknown>) => void): [string, string] => {
      const bad = structuredClone(prepared) as unknown as Record<string, unknown>;
      mutate(bad);
      return [code(() => checkFrameInterpretationRequest(f.store, req, bad)),
        field(() => checkFrameInterpretationRequest(f.store, req, bad))];
    };
    // Any single-field change breaks the derived identity first.
    assert.deepEqual(at(v => { v.project = "other-proj"; }),
      ["frame_request_mismatch", "request"]);
    assert.deepEqual(at(v => { (v.brief as { source: Ref }).source = reference(sibling); }),
      ["frame_request_mismatch", "request"]);
    assert.deepEqual(at(v => { v.frame = reference(b.draft); }),
      ["frame_request_mismatch", "request"]);
    assert.deepEqual(at(v => { v.previousSet = otherSet; }),
      ["frame_request_mismatch", "request"]);
    // A consistent forgery recomputing the identity reaches the field diff.
    const rehash = (v: Record<string, unknown>) => {
      const { request: _i, ...rest } = v as unknown as FrameInterpretationRequest;
      v.request = hashJson(rest as never);
    };
    const bad = structuredClone(prepared) as unknown as Record<string, unknown>;
    (bad.brief as { source: Ref }).source = reference(sibling); rehash(bad);
    assert.deepEqual(
      [code(() => checkFrameInterpretationRequest(f.store, req, bad)),
        field(() => checkFrameInterpretationRequest(f.store, req, bad))],
      ["frame_request_mismatch", "brief"]);
    const mixed = structuredClone(prepared) as unknown as Record<string, unknown>;
    (mixed.brief as { source: Ref }).source = reference(sibling);
    mixed.frame = reference(b.draft); rehash(mixed);
    assert.equal(field(() => checkFrameInterpretationRequest(f.store, req, mixed)), "brief");
  });
});

test("2b-R a nested absent support in the answer refuses through the transport, bound to the verified request", (t) => {
  const f = discoveryFixture(t, "omg-2br-ptr-"), project = "loft";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project, "json");
  const req = requestOf(project, b);
  const prepared = prepareFrameInterpretationRequest(f.store, req);
  // A good request of another real draft — lawful bytes bound elsewhere.
  const other = base(f, "cellar", "json", "brief-src-2");
  const otherReq = prepareFrameInterpretationRequest(f.store, requestOf("cellar", other));
  noWrite(f.store, wireFile, () => {
    const bad = materialSet(project, b.mandate, b.frameRef, null,
      { warehouse: { kind: "json-pointer", pointer: "/brief/missing" } });
    assert.equal(code(() => checkFrameInterpretationAnswer(f.store, req,
      structuredClone(prepared), bad)), "frame_transport_invalid");
    assert.equal(field(() => checkFrameInterpretationAnswer(f.store, req,
      structuredClone(prepared), bad)), "interpretations.0.support.0");
    // And a good request cannot be swapped for another package either.
    assert.equal(code(() => checkFrameInterpretationAnswer(f.store, req,
      structuredClone(otherReq), materialSet(project, b.mandate, b.frameRef))),
      "frame_request_mismatch");
  });
});

test("2b-R the same request is restored hot and cold after a new revision of the same Source and moved frame/brief heads", (t) => {
  const f = discoveryFixture(t, "omg-2br-cold-"), project = "attic";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const first = noWrite(f.store, wireFile,
    () => prepareFrameInterpretationRequest(f.store, req));
  // A new revision of the very same Source entity and a second real draft
  // with its own brief and frame move the heads.
  f.discovery.evidence.document(project, "brief-src", "Поздняя редакция", "text/plain", 1);
  const later = base(f, project, "text", "brief-src-later");
  assert.notEqual(later.frameRef.id, b.frameRef.id);
  // The historical request restores byte-identically, hot and cold.
  const hot = noWrite(f.store, wireFile,
    () => checkFrameInterpretationRequest(f.store, req, structuredClone(first)));
  assert.deepEqual(hot, first, "later revisions never rewrite a historical request");
  const cold = f.open();
  const restored = noWrite(cold, wireFile,
    () => checkFrameInterpretationRequest(cold, req, structuredClone(first)));
  assert.deepEqual(restored, first, "a cold store restores the same request");
  // And the new frame prepares its own distinct request.
  const second = prepareFrameInterpretationRequest(cold, requestOf(project, later));
  assert.notEqual(second.request, first.request);
  assert.notEqual(second.subject.subject, first.subject.subject);
});

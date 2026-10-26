import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../src/errors.js";
import { canonical, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { Selector } from "../src/evidence/evidence.js";
import type { Revision, Store } from "../src/storage/store.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_FRAME_INTERPRETATIONS_CONTRACT,
  V7_FRAME_INTERPRETATIONS_KIND } from "../src/discovery/v7-contracts.js";
import { projectFrameInterpretations } from "../src/discovery/frame-interpretations.js";
import type { FrameSubjectRequest } from "../src/discovery/frame-interpretation-subject.js";
import { checkFrameInterpretationResult, FRAME_RESULT_CONTRACT
  } from "../src/discovery/frame-interpretation-transport.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, questionOf, validFrame, type DiscoveryFixture } from "./discovery-v7-fixture.js";

// DR2b 2b-RESULT-TRANSPORT (codex-omg №15094): the read-only executable half of
// 2b.1 — a closed FrameInterpretations answer is checked against the freshly
// proven exact subject of its frame and returned as one transport package for
// a future producer (2b.2+). Form never suffices: project/brief/frame/
// previousSet equal the proven package byte for byte and every support resolves
// through the shared historicalObservation on the saved source bytes. No write,
// no model call, no choice, no paid or accepted mark — 'proven' is form and
// exact sources only, never semantic correctness or an owner act.

const TEXT_BRIEF = "XX Учёт материалов ведётся на центральном складе и списание идёт на каждом объекте. YY";
const RANGE = { kind: "text-range", start: 3, end: 62 } as const;
const JSON_DOC = JSON.stringify({ meta: { author: "owner" },
  brief: "Учёт материалов: склад и списание на объектах", extra: { notes: ["a", "b"] } });

/** A read-only block boundary: the FULL head rows and the FULL revision rows of
 * every entity, the model calls, the research-budget-ledger and the wire state
 * (for this fixture the provable state is the wire file's absence) stay
 * byte-identical across the action — the comparison also runs when the action
 * refuses. One algorithm serves sync and async actions. */
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
/** Default supports of the second interpretation: two disjoint subranges of a
 * text excerpt, or the pointer itself — each inside the brief selector and
 * named once. */
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

test("2b-T a closed material answer is verified against the proven subject: verbatim mandate, resolved supports, canonical address", (t) => {
  const f = discoveryFixture(t, "omg-2bt-main-"), project = "garden";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const answer = materialSet(project, b.mandate, b.frameRef);
  const result = noWrite(f.store, wireFile, () => checkFrameInterpretationResult(f.store, req, answer));
  assert.equal(result.contract, FRAME_RESULT_CONTRACT);
  assert.equal(result.verification, "proven");
  // The proven subject is the fresh package, bound to the exact request.
  assert.equal(result.subject.project, project);
  assert.equal(canonical(reference(result.subject.frame.record)), canonical(req.frame));
  assert.equal(canonical(result.subject.mandate.observation.source), canonical(b.mandate.source));
  // The closed answer is kept byte for byte at its canonical address —
  // outcome, reason, every interpretation, consequences and support texts.
  assert.equal(result.answer.id, projectFrameInterpretations(answer).id);
  assert.deepEqual(result.answer.value, projectFrameInterpretations(answer).value);
  assert.equal(result.answer.value.outcome, "material");
  // Every support resolved verbatim on the saved source bytes, in order.
  assert.equal(result.supports.length, 3);
  assert.deepEqual(result.supports.map(s => [s.interpretation, s.index]),
    [["warehouse", 0], ["sites", 0], ["sites", 1]]);
  for (const s of result.supports) {
    assert.equal(s.observation.projectId, project);
    assert.equal(canonical(s.observation.source), canonical(b.mandate.source));
    const sel = s.observation.selector as Extract<Selector, { kind: "text-range" }>;
    assert.equal(sel.kind, "text-range");
    assert.equal(s.observation.value, TEXT_BRIEF.slice(sel.start, sel.end));
  }
  // The presented object is never returned: mutating it after the fact does
  // not touch the result.
  (answer as { reason: string }).reason = "retold";
  assert.notEqual(result.answer.value.reason, "retold");
});

test("2b-T a no_divergence answer is a lawful closed result; a previous set binds by its exact structural ref", (t) => {
  const f = discoveryFixture(t, "omg-2bt-nodiv-"), project = "yard";
  const wireFile = join(f.root, "wire.ndjson");
  const first = base(f, project, "text", "brief-src");
  const prev = writeStructuralSet(f.store, plainSet(project, first.mandate, first.frameRef));
  const b = base(f, project, "text", "brief-src-2");
  const req = requestOf(project, b, prev);
  const result = noWrite(f.store, wireFile,
    () => checkFrameInterpretationResult(f.store, req, plainSet(project, b.mandate, b.frameRef, prev)));
  assert.equal(result.verification, "proven");
  assert.equal(result.answer.value.outcome, "no_divergence");
  assert.equal(result.answer.value.interpretations.length, 0);
  assert.equal(result.supports.length, 0);
  assert.equal(canonical(result.answer.value.previousSet), canonical(prev));
  assert.equal(canonical(reference(result.subject.previous!.record)), canonical(prev));
  assert.equal(result.subject.previous!.verification, "structural");
});

test("2b-T missing, null, malformed and truncated answers are refused at their field; extra marks are no part of the form", (t) => {
  const f = discoveryFixture(t, "omg-2bt-form-"), project = "shed";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const good = () => materialSet(project, b.mandate, b.frameRef);
  noWrite(f.store, wireFile, () => {
    for (const presented of [null, 42, "set", []])
      assert.equal(code(() => checkFrameInterpretationResult(f.store, req, presented)),
        "frame_interpretations_invalid");
    for (const [at, mutate] of [
      ["contract", (v: Record<string, unknown>) => { v.contract = "other/v9"; }],
      ["set.projectId", (v: Record<string, unknown>) => { delete v.projectId; }],
      ["set.interpretations", (v: Record<string, unknown>) => { delete v.interpretations; }],
      ["interpretations.1.support", (v: Record<string, unknown>) => {
        delete (v.interpretations as Record<string, unknown>[])[1]!.support; }],
      ["set.selected", (v: Record<string, unknown>) => { v.selected = "warehouse"; }]] as const) {
      const bad = good(); mutate(bad);
      assert.equal(code(() => checkFrameInterpretationResult(f.store, req, bad)),
        "frame_interpretations_invalid", at);
      assert.equal(field(() => checkFrameInterpretationResult(f.store, req, bad)), at);
    }
    // A material outcome with a single interpretation is refused; a support
    // outside the declared excerpt is refused structurally before any read.
    const one = good(); (one.interpretations as unknown[]).length = 1;
    assert.equal(code(() => checkFrameInterpretationResult(f.store, req, one)),
      "frame_interpretations_invalid");
    const outside = materialSet(project, b.mandate, b.frameRef, null,
      { sites: [{ kind: "text-range", start: 10, end: 80 }] });
    assert.equal(code(() => checkFrameInterpretationResult(f.store, req, outside)),
      "frame_interpretations_invalid");
  });
});

test("2b-T a nested absent pointer is refused on the saved bytes — structural nesting never suffices", (t) => {
  const f = discoveryFixture(t, "omg-2bt-ptr-"), project = "loft";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project, "json");
  const req = requestOf(project, b);
  // The positive pointer case on another real draft: /brief is a string in
  // the saved document; the whole excerpt pointer resolves verbatim.
  const b2 = base(f, "cellar", "json", "brief-src-2");
  const req2 = requestOf("cellar", b2);
  noWrite(f.store, wireFile, () => {
    // /brief/missing is canonically below the brief pointer — the form admits
    // it; the saved bytes do not.
    const bad = materialSet(project, b.mandate, b.frameRef, null,
      { warehouse: { kind: "json-pointer", pointer: "/brief/missing" } });
    assert.equal(code(() => checkFrameInterpretationResult(f.store, req, bad)),
      "frame_transport_invalid");
    assert.equal(field(() => checkFrameInterpretationResult(f.store, req, bad)),
      "interpretations.0.support.0");
    // /meta/author exists in the saved bytes but is outside the /brief
    // excerpt — the form itself refuses it before any resolution.
    const beyond = materialSet(project, b.mandate, b.frameRef, null,
      { warehouse: { kind: "json-pointer", pointer: "/meta/author" } });
    assert.equal(code(() => checkFrameInterpretationResult(f.store, req, beyond)),
      "frame_interpretations_invalid");
    const ok = materialSet("cellar", b2.mandate, b2.frameRef);
    const result = checkFrameInterpretationResult(f.store, req2, ok);
    assert.equal(result.supports.length, 2);
    assert.equal(result.supports[0]!.observation.value, "Учёт материалов: склад и списание на объектах");
  });
});

test("2b-T foreign, missing and mixed exact grounds are refused: another project, source, selector, frame or previous set", (t) => {
  const f = discoveryFixture(t, "omg-2bt-grounds-"), project = "barn";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const foreign = f.discovery.evidence.document("other-proj", "alien",
    "Чужой документ", "text/plain", 0);
  const sibling = f.discovery.evidence.document(project, "sibling",
    "Другой документ того же проекта", "text/plain", 0);
  // A real saved set of this project the subject does not name — a structural
  // previousSet ref that passes the form but not the proven binding.
  const otherSet = writeStructuralSet(f.store,
    plainSet(project, b.mandate, reference(b.draft)));
  noWrite(f.store, wireFile, () => {
    const at = (mutate: (v: Record<string, unknown>) => void): [string, string] => {
      const bad = materialSet(project, b.mandate, b.frameRef); mutate(bad);
      return [code(() => checkFrameInterpretationResult(f.store, req, bad)),
        field(() => checkFrameInterpretationResult(f.store, req, bad))];
    };
    // Another project entirely.
    assert.deepEqual(at(v => { v.projectId = "other-proj"; }),
      ["frame_transport_mismatch", "projectId"]);
    // The brief is not the proven mandate: foreign source, sibling source or a
    // shifted selector — each is a 'brief' refusal.
    assert.deepEqual(at(v => { (v.brief as { source: Ref }).source = reference(foreign); }),
      ["frame_transport_mismatch", "brief"]);
    assert.deepEqual(at(v => { (v.brief as { source: Ref }).source = reference(sibling); }),
      ["frame_transport_mismatch", "brief"]);
    // A shifted selector: supports are moved inside the new excerpt so the
    // refusal is the brief binding, never the form.
    assert.deepEqual(at(v => {
      (v.brief as { selector: Json }).selector = { kind: "text-range", start: 4, end: 62 };
      const list = v.interpretations as { support: Selector[] }[];
      list[0]!.support = [{ kind: "text-range", start: 10, end: 50 }];
      list[1]!.support = [{ kind: "text-range", start: 10, end: 20 },
        { kind: "text-range", start: 30, end: 40 }]; }),
      ["frame_transport_mismatch", "brief"]);
    // Another frame revision — the draft ref stands in for "not this frame".
    assert.deepEqual(at(v => { v.frame = reference(b.draft); }),
      ["frame_transport_mismatch", "frame"]);
    // A ref that is no interpretations set is refused by the form itself; a
    // real saved set the subject does not name is a binding mismatch.
    assert.deepEqual(at(v => { v.previousSet = reference(sibling); }),
      ["frame_interpretations_invalid", "previousSet"]);
    assert.deepEqual(at(v => { v.previousSet = otherSet; }),
      ["frame_transport_mismatch", "previousSet"]);
    // Mixed exact grounds: brief and frame both wrong — the first failing
    // field reports.
    assert.deepEqual(at(v => {
      (v.brief as { source: Ref }).source = reference(sibling); v.frame = reference(b.draft); }),
      ["frame_transport_mismatch", "brief"]);
    // A truncated or substituted request fails on the subject side, not as a
    // transport mismatch.
    assert.equal(code(() => checkFrameInterpretationResult(f.store,
      { ...req, mandate: { ...req.mandate, selector: { kind: "text-range", start: 4, end: 62 } } },
      materialSet(project, { source: b.mandate.source,
        selector: { kind: "text-range", start: 4, end: 62 } as Json }, b.frameRef))),
      "frame_subject_mismatch");
  });
});

test("2b-T the same result is restored hot and cold after heads move; no write, call or ledger entry appears", (t) => {
  const f = discoveryFixture(t, "omg-2bt-cold-"), project = "attic";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const answer = materialSet(project, b.mandate, b.frameRef);
  const first = noWrite(f.store, wireFile,
    () => checkFrameInterpretationResult(f.store, req, answer));
  // Move heads: a second real draft with its own sources, brief and frame.
  const later = base(f, project, "text", "brief-src-later");
  assert.notEqual(later.frameRef.id, b.frameRef.id);
  // The historical check still restores byte-identically, hot and on a cold
  // store opened after the movement.
  const hot = noWrite(f.store, wireFile,
    () => checkFrameInterpretationResult(f.store, req, structuredClone(answer)));
  assert.deepEqual(hot, first, "heads moving never rewrites a historical result");
  const cold = f.open();
  const restored = noWrite(cold, wireFile,
    () => checkFrameInterpretationResult(cold, req, structuredClone(answer)));
  assert.deepEqual(restored, first, "a cold store restores the same result");
  // And the new frame is its own subject — never confused with the first.
  const second = checkFrameInterpretationResult(cold, requestOf(project, later),
    materialSet(project, later.mandate, later.frameRef));
  assert.notEqual(second.subject.subject, first.subject.subject);
});

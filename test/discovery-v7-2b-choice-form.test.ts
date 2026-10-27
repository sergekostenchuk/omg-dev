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
import { checkFrameInterpretationResult } from "../src/discovery/frame-interpretation-transport.js";
import { checkFrameInterpretationChoice, decodeFrameInterpretationChoice,
  FRAME_INTERPRETATION_CHOICE, FRAME_INTERPRETATION_CHOICE_PROJECTION,
  FRAME_INTERPRETATION_CHOICE_SUBJECT, prepareFrameInterpretationChoiceSubject,
  projectFrameInterpretationChoice } from "../src/discovery/frame-interpretation-choice.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, questionOf, validFrame, type DiscoveryFixture } from "./discovery-v7-fixture.js";

// DR2b 2b-CHOICE-FORM (codex-omg2 №15533): the closed form and pure projection
// of one future interpretation choice. The set is proven only by the accepted
// checkFrameInterpretationResult over the original request+answer — a caller
// 'proven' flag is never read. The choice's previous is a structural input of
// its own, never the set's previousSet and never an authority act; a
// no_divergence set yields its lawful 'none' with no artificial alternatives;
// a material set demands a real member id. Everything read-only: no record,
// call, ledger entry or wire write.

const TEXT_BRIEF = "XX Учёт материалов ведётся на центральном складе и списание идёт на каждом объекте. YY";
const RANGE = { kind: "text-range", start: 3, end: 62 } as const;

/** A read-only block boundary: heads, revision rows, model calls, ledger and
 * wire stay byte-identical across the action — on refusal as well. */
const state = (store: Store, wireFile: string) => ({
  heads: canonical(store.list()),
  revisions: canonical(store.list().map(row => [row.id, store.history(row.id)])),
  calls: canonical(store.list("model-call")),
  ledger: canonical(store.list("research-budget-ledger")),
  wire: existsSync(wireFile) ? readFileSync(wireFile, "utf8") : null,
});
function noWrite<T>(store: Store, wireFile: string, action: () => T): T {
  const before = state(store, wireFile);
  const verify = () => assert.deepEqual(state(store, wireFile), before,
    "a read-only block changed the saved state");
  try { const result = action(); verify(); return result; }
  catch (error) { verify(); throw error; }
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
function base(f: DiscoveryFixture, project: string, sourceKey = "brief-src"): Base {
  const src = f.discovery.evidence.document(project, sourceKey, TEXT_BRIEF, "text/plain", 0);
  const draft = createPartialV7Draft(f.discovery, project, "concept", [reference(src)]);
  const briefQ = questionOf(f.store, draft, "brief");
  f.engine.discovery.fact(briefQ.id, briefQ.revision, reference(src), { ...RANGE });
  const objective = questionOf(f.store, draft, "objective");
  f.engine.discovery.decision(objective.id, f.store.get<Question>(objective.id)!.revision,
    "owner", `Deliver ${project} outcome`);
  const frameQ = questionOf(f.store, draft, "frame");
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!,
    f.store.get<Question>(frameQ.id)!, validFrame(), src);
  const frameRef = f.store.get<Question>(frameQ.id)!.value.answer!;
  return { src, draft, briefQ, frameQ, frameRef,
    mandate: { source: reference(src), selector: { ...RANGE } } };
}
const requestOf = (project: string, b: Base, previousSet?: Ref | null): FrameSubjectRequest =>
  ({ project, frame: b.frameRef, mandate: b.mandate as FrameSubjectRequest["mandate"],
    ...(previousSet !== undefined ? { previousSet } : {}) });
const subSupports = (sel: Selector): Selector[] =>
  sel.kind === "text-range"
    ? [{ kind: "text-range", start: sel.start, end: Math.floor((sel.start + sel.end) / 2) },
       { kind: "text-range", start: Math.floor((sel.start + sel.end) / 2), end: sel.end }]
    : [sel];
const materialSet = (project: string, brief: { source: Ref; selector: Json }, frame: Ref,
  previousSet: Ref | null = null): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project,
  brief: { source: { ...brief.source }, selector: structuredClone(brief.selector) },
  frame, previousSet, outcome: "material",
  reason: "«Учёт материалов» reads as the warehouse only or also the sites, and the result changes",
  interpretations: [
    { id: "warehouse", meaning: "Central warehouse only",
      consequences: [{ affects: "boundaries", text: "Sites are out of scope" }],
      support: [structuredClone(brief.selector)] },
    { id: "sites", meaning: "Warehouse and the site write-off",
      consequences: [{ affects: "acceptance", text: "Each site closes its write-off" },
        { affects: "result", text: "The report lists write-offs per site" }],
      support: subSupports(brief.selector as Selector) }] });
const plainSet = (project: string, brief: { source: Ref; selector: Json }, frame: Ref,
  previousSet: Ref | null = null): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project,
  brief: { source: { ...brief.source }, selector: structuredClone(brief.selector) },
  frame, previousSet, outcome: "no_divergence",
  reason: "One warehouse reading, no divergence", interpretations: [] });

/** The closed choice answer with its derived identity recomputed — a lawful
 * 'chosen' over a material set or 'none' over a no_divergence set. */
const choiceBody = (project: string, set: ReturnType<typeof projectFrameInterpretations>,
  previous: Ref | null, outcome: "chosen" | "none",
  interpretation: string | null, justification: string | null): Record<string, unknown> => ({
  contract: FRAME_INTERPRETATION_CHOICE, project,
  set: { id: set.id, value: structuredClone(set.value) },
  mandate: structuredClone(set.value.brief), frame: structuredClone(set.value.frame),
  previous, outcome, interpretation, justification });
const choice = (...args: Parameters<typeof choiceBody>): Record<string, unknown> => {
  const body = choiceBody(...args);
  return { ...body, identity: `frame-interpretation-choice:${hashJson(body as never)}` };
};

test("2b-C a chosen member of a material set is bound to the exact proven package; output is isolated", (t) => {
  const f = discoveryFixture(t, "omg-2bc-main-"), project = "garden";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const answer = materialSet(project, b.mandate, b.frameRef);
  const projected = projectFrameInterpretations(answer);
  // The choice's own previous is a structural input — here a real saved record,
  // never the set's previousSet and never declared an authority act.
  const prev = reference(b.frameQ);
  const result = noWrite(f.store, wireFile, () =>
    checkFrameInterpretationChoice(f.store, req, structuredClone(answer), prev,
      choice(project, projected, prev, "chosen", "sites",
        "The sites reading keeps the per-object write-off truthful")));
  assert.equal(result.contract, FRAME_INTERPRETATION_CHOICE_PROJECTION);
  assert.equal(result.verification, "proven");
  assert.equal(result.subject.contract, FRAME_INTERPRETATION_CHOICE_SUBJECT);
  // The basis is the freshly re-proven transport package — byte for byte.
  const transport = checkFrameInterpretationResult(f.store, req, structuredClone(answer));
  assert.deepEqual(result.subject.result, transport);
  assert.equal(canonical(result.subject.previous), canonical(prev));
  assert.deepEqual(result.choice.value.set, projected);
  assert.equal(result.choice.value.outcome, "chosen");
  assert.equal(result.choice.value.interpretation, "sites");
  // The mandate and frame are the set's own — never retold model text, and the
  // complete set with every value, consequence and support is preserved.
  assert.deepEqual(result.choice.value.mandate, transport.answer.value.brief);
  assert.equal(canonical(result.choice.value.frame), canonical(transport.answer.value.frame));
  assert.equal(result.choice.value.set.value.interpretations.length, 2);
  // Deterministic derived identities; a repeat yields the same package.
  const repeat = noWrite(f.store, wireFile, () =>
    checkFrameInterpretationChoice(f.store, req, structuredClone(answer), prev,
      choice(project, projected, prev, "chosen", "sites",
        "The sites reading keeps the per-object write-off truthful")));
  assert.deepEqual(repeat, result);
  // Input and output isolation: mutating the presented object or the returned
  // package never touches the prepared subject or a later projection.
  const mutable = choice(project, projected, prev, "chosen", "sites", "kept");
  const presentedSet = mutable.set as { value: { interpretations: unknown[] } };
  presentedSet.value.interpretations.length = 0;
  assert.equal(code(() => checkFrameInterpretationChoice(f.store, req, answer, prev, mutable)),
    "frame_interpretations_invalid", "a truncated presented set is refused, not carried");
  const isolated = result.choice.value as unknown as { set: { value: { interpretations: unknown[] } } };
  isolated.set.value.interpretations.length = 0;
  const again = noWrite(f.store, wireFile, () =>
    checkFrameInterpretationChoice(f.store, req, structuredClone(answer), prev,
      choice(project, projected, prev, "chosen", "sites",
        "The sites reading keeps the per-object write-off truthful")));
  assert.equal(again.choice.value.set.value.interpretations.length, 2);
});

test("2b-C a no_divergence set yields its lawful none result; a material set refuses none", (t) => {
  const f = discoveryFixture(t, "omg-2bc-nodiv-"), project = "yard";
  const wireFile = join(f.root, "wire.ndjson");
  const first = base(f, project, "brief-src");
  const seed = projectFrameInterpretations(plainSet(project, first.mandate, first.frameRef));
  const prevRef = f.store.write({ id: seed.id, kind: V7_FRAME_INTERPRETATIONS_KIND,
    expected: 0, value: seed.value });
  const b = base(f, project, "brief-src-2");
  const req = requestOf(project, b, reference(prevRef));
  const nodiv = projectFrameInterpretations(plainSet(project, b.mandate, b.frameRef, reference(prevRef)));
  noWrite(f.store, wireFile, () => {
    // No alternatives exist: the lawful result is 'none' — a preparation
    // outcome, not a choice and not a model decision.
    const result = checkFrameInterpretationChoice(f.store, req,
      structuredClone(nodiv.value), null, choice(project, nodiv, null, "none", null, null));
    assert.equal(result.choice.value.outcome, "none");
    assert.equal(result.choice.value.interpretation, null);
    assert.equal(result.choice.value.justification, null);
    assert.deepEqual(result.choice.value.set, nodiv);
    // A 'chosen' answer over a no_divergence set fabricates alternatives.
    const forged = choice(project, nodiv, null, "chosen", "warehouse", "invented alternative");
    assert.equal(code(() => checkFrameInterpretationChoice(f.store, req, nodiv.value, null, forged)),
      "frame_choice_mismatch");
    assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, nodiv.value, null, forged)),
      "outcome");
  });
  // And a material set refuses 'none' — the member must be chosen explicitly.
  const mat = base(f, project, "brief-src-3");
  const reqM = requestOf(project, mat);
  const matSet = projectFrameInterpretations(materialSet(project, mat.mandate, mat.frameRef));
  noWrite(f.store, wireFile, () => {
    const none = choice(project, matSet, null, "none", null, null);
    assert.equal(code(() => checkFrameInterpretationChoice(f.store, reqM, matSet.value, null, none)),
      "frame_choice_mismatch");
    assert.equal(field(() => checkFrameInterpretationChoice(f.store, reqM, matSet.value, null, none)),
      "outcome");
  });
});

test("2b-C missing, null, malformed and extra fields are refused at their field; identity is no proof", (t) => {
  const f = discoveryFixture(t, "omg-2bc-form-"), project = "shed";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const answer = materialSet(project, b.mandate, b.frameRef);
  const projected = projectFrameInterpretations(answer);
  const good = () => choice(project, projected, null, "chosen", "warehouse", "warehouse only");
  noWrite(f.store, wireFile, () => {
    // The decoder alone returns the closed form with its derived identity.
    const decoded = decodeFrameInterpretationChoice(good());
    assert.equal(decoded.contract, FRAME_INTERPRETATION_CHOICE);
    assert.ok(decoded.identity.startsWith("frame-interpretation-choice:"));
    for (const presented of [null, 42, "choice", []])
      assert.equal(code(() => checkFrameInterpretationChoice(f.store, req, answer, null, presented)),
        "frame_choice_invalid");
    for (const [at, mutate] of [
      ["contract", (v: Record<string, unknown>) => { v.contract = "other/v9"; }],
      ["choice.project", (v: Record<string, unknown>) => { delete v.project; }],
      ["set", (v: Record<string, unknown>) => { v.set = null; }],
      ["set.id", (v: Record<string, unknown>) => { (v.set as { id: string }).id = "elsewhere:1"; }],
      ["mandate.source", (v: Record<string, unknown>) => { v.mandate = {}; }],
      ["frame", (v: Record<string, unknown>) => { v.frame = "x"; }],
      ["previous", (v: Record<string, unknown>) => { v.previous = 7; }],
      ["outcome", (v: Record<string, unknown>) => { v.outcome = "maybe"; }],
      ["interpretation", (v: Record<string, unknown>) => { v.interpretation = " "; }],
      ["choice.justification", (v: Record<string, unknown>) => { delete v.justification; }],
      ["choice.selected", (v: Record<string, unknown>) => { v.selected = "warehouse"; }],
      ["choice.paid", (v: Record<string, unknown>) => { v.paid = true; }],
    ] as const) {
      const bad = good(); mutate(bad);
      assert.equal(code(() => checkFrameInterpretationChoice(f.store, req, answer, null, bad)),
        "frame_choice_invalid", at);
      assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, null, bad)), at);
    }
    // A 'none' outcome that still carries a member or a justification is no
    // lawful form.
    for (const [at, mutate] of [
      ["interpretation", (v: Record<string, unknown>) => { v.interpretation = "warehouse"; }],
      ["justification", (v: Record<string, unknown>) => { v.justification = "still explained"; }],
    ] as const) {
      const bad = choice(project, projected, null, "none", null, null); mutate(bad);
      assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, null, bad)), at);
    }
    // Content changed, identity left stale — the derived identity refuses.
    // (Changing set.value alone trips 'set.id' earlier: the address no longer
    // derives from the presented content.)
    const stale = good(); stale.justification = "retold";
    assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, null, stale)),
      "identity");
    // Identity recomputed over changed bindings rescues nothing: a foreign
    // member, project, mandate, frame or previous still refuses at its field.
    const reId = (v: Record<string, unknown>) => {
      const { identity: _i, ...body } = v;
      v.identity = `frame-interpretation-choice:${hashJson(body as never)}`;
    };
    const cases: [string, (v: Record<string, unknown>) => void][] = [
      ["project", v => { v.project = "other-proj"; }],
      ["interpretation", v => { v.interpretation = "basement"; }],
      ["frame", v => { v.frame = reference(b.draft); }],
      ["previous", v => { v.previous = reference(b.briefQ); }],
      ["mandate", v => { (v.mandate as { selector: Json }).selector =
        { kind: "text-range", start: 4, end: 62 } as Json; }],
    ];
    for (const [at, mutate] of cases) {
      const bad = good(); mutate(bad); reId(bad);
      assert.equal(code(() => checkFrameInterpretationChoice(f.store, req, answer, null, bad)),
        "frame_choice_mismatch", at);
      assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, null, bad)), at);
    }
    // A lawful other set — same member ids, different content — is not the
    // proven set; a choice bound to it refuses at 'set'.
    const other = projectFrameInterpretations({
      ...materialSet(project, b.mandate, b.frameRef), reason: "same ids, different content" });
    const swapped = choice(project, other, null, "chosen", "warehouse", "warehouse only");
    assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, null, swapped)),
      "set");
  });
});

test("2b-C a caller proven package is never trusted — raw answer is re-verified; foreign grounds refuse", (t) => {
  const f = discoveryFixture(t, "omg-2bc-door-"), project = "barn";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const answer = materialSet(project, b.mandate, b.frameRef);
  const projected = projectFrameInterpretations(answer);
  const lawful = checkFrameInterpretationChoice(f.store, req, structuredClone(answer), null,
    choice(project, projected, null, "chosen", "sites", "sites close per object"));
  noWrite(f.store, wireFile, () => {
    // Handing a caller-'proven' package as the answer is no shortcut: the door
    // re-runs the transport checker on raw bytes — an extra-field package with
    // a verification flag is refused like any other malformed answer.
    const fakedProven = { contract: "frame-interpretation-result/v1", verification: "proven",
      subject: lawful.subject.result.subject, answer: lawful.subject.result.answer,
      supports: lawful.subject.result.supports };
    assert.equal(code(() => checkFrameInterpretationChoice(f.store, req, fakedProven, null,
      choice(project, projected, null, "chosen", "sites", "x"))), "frame_interpretations_invalid");
    // A substituted request fails inside the proven grounds, before the choice.
    assert.equal(code(() => checkFrameInterpretationChoice(f.store,
      { ...req, mandate: { ...req.mandate, selector: { kind: "text-range", start: 4, end: 62 } } },
      materialSet(project, { source: b.mandate.source,
        selector: { kind: "text-range", start: 4, end: 62 } as Json }, b.frameRef),
      null, choice(project, projected, null, "chosen", "sites", "x"))),
      "frame_subject_mismatch");
    // A previous the subject was not prepared with is refused at 'previous'.
    const foreign = choice(project, projected, reference(b.briefQ), "chosen", "sites", "x");
    assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, null, foreign)),
      "previous");
    // A tampered subject handed to the pure projector is refused on identity.
    const tampered = structuredClone(lawful.subject);
    (tampered.result.answer.value as { reason: string }).reason = "retold";
    assert.equal(field(() => projectFrameInterpretationChoice(tampered,
      choice(project, projected, null, "chosen", "sites", "x"))), "subject.result.answer.id");
  });
});

test("2b-C a changing external object is bound to one detached snapshot — a second read never leaks (CHOICE-FORM-01)", (t) => {
  const f = discoveryFixture(t, "omg-2bc-snap-"), project = "attic";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const answer = materialSet(project, b.mandate, b.frameRef);
  const projected = projectFrameInterpretations(answer);
  const lawful = () => choice(project, projected, null, "chosen", "sites", "sites close per object");
  const idFor = (v: Record<string, unknown>): string => {
    const { identity: _i, ...body } = v;
    return `frame-interpretation-choice:${hashJson(body as never)}`;
  };
  /** First read yields the field's lawful value, every later read `later`. */
  const mutating = (base: Record<string, unknown>, key: string, later: unknown): Record<string, unknown> => {
    const box = { ...base }; let reads = 0; const first = base[key];
    Object.defineProperty(box, key, { enumerable: true, configurable: true,
      get: () => (++reads === 1 ? first : later) });
    return box;
  };
  const prev = reference(b.frameQ);
  /** A Ref whose hash reads the real bytes once, then flips. */
  const flipPrev = (): Ref => {
    const box = { id: prev.id, revision: prev.revision } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(box, "hash", { enumerable: true,
      get: () => (++reads === 1 ? prev.hash : "f".repeat(64)) });
    return box as unknown as Ref;
  };
  /** One invocation of a getter-armed input: code and field of the same call —
   * each call takes its own snapshot, so probing twice would read the getter
   * again. */
  const probe = (fn: () => unknown): [string, string] => {
    try { fn(); } catch (error) {
      assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
      return [(error as EngineError).code,
        ((error as EngineError).details as { field?: string } | null)?.field ?? "?"];
    }
    return ["no-error", "no-error"];
  };
  noWrite(f.store, wireFile, () => {
    // contract reads lawful once, then 'other/v9'; the identity is precomputed
    // for the second-read body — the snapshot binds the first read and the
    // stale derived identity refuses.
    const ghostC = mutating(lawful(), "contract", "other/v9");
    ghostC.identity = idFor({ ...lawful(), contract: "other/v9" });
    assert.deepEqual(probe(() => checkFrameInterpretationChoice(f.store, req, answer, null, ghostC)),
      ["frame_choice_mismatch", "identity"]);
    // The justification probe: 'because' on first read, '' on second — the
    // nonempty check and the identity both work on the same snapshot.
    const ghostJ = mutating(lawful(), "justification", "");
    ghostJ.identity = idFor({ ...lawful(), justification: "" });
    assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, null, ghostJ)),
      "identity");
    // A nested changing basis: the previous Ref's hash flips on second read.
    // An identity computed over the flipped world refuses on the snapshot.
    const flippedBody = choiceBody(project, projected,
      { id: prev.id, revision: prev.revision, hash: "f".repeat(64) }, "chosen", "sites", "x");
    const ghostP = { ...flippedBody, previous: flipPrev(), identity: idFor(flippedBody) };
    assert.equal(field(() => checkFrameInterpretationChoice(f.store, req, answer, prev, ghostP)),
      "identity");
    // Bound to the snapshot's single read, the same trick is consistent: the
    // first-read previous is what the returned bytes carry and re-decode.
    const steady = { ...choice(project, projected, prev, "chosen", "sites", "x"),
      previous: flipPrev() };
    const ok = checkFrameInterpretationChoice(f.store, req, answer, prev, steady);
    assert.equal(canonical(ok.choice.value.previous), canonical(prev),
      "the snapshot's single-read bytes are the returned bytes");
    assert.equal(decodeFrameInterpretationChoice(ok.choice.value).identity, ok.choice.id,
      "the returned choice re-decodes against its identity");
    // The door's own previous input is snapshotted once as well.
    const okDoor = checkFrameInterpretationChoice(f.store, req, answer, flipPrev(),
      choice(project, projected, prev, "chosen", "sites", "x"));
    assert.equal(canonical(okDoor.subject.previous), canonical(prev));
    // And the pure projector's subject is bound to its single snapshot: a
    // previous that flips on the second read never leaks into the projection.
    const subject = prepareFrameInterpretationChoiceSubject(f.store, req, structuredClone(answer), prev);
    const shifted = mutating(subject as unknown as Record<string, unknown>,
      "previous", reference(b.briefQ));
    const proj = projectFrameInterpretationChoice(shifted as never,
      choice(project, projected, prev, "chosen", "sites", "x"));
    assert.equal(canonical(proj.subject.previous), canonical(prev));
    assert.equal(decodeFrameInterpretationChoice(proj.choice.value).outcome, "chosen");
  });
});

test("2b-C the same projection is restored hot and cold after heads move; no write, call or ledger entry", (t) => {
  const f = discoveryFixture(t, "omg-2bc-cold-"), project = "attic";
  const wireFile = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const answer = materialSet(project, b.mandate, b.frameRef);
  const projected = projectFrameInterpretations(answer);
  const prev = reference(b.frameQ);
  const first = noWrite(f.store, wireFile, () =>
    checkFrameInterpretationChoice(f.store, req, structuredClone(answer), prev,
      choice(project, projected, prev, "chosen", "warehouse", "warehouse only")));
  // Move heads: a second real draft with its own source, brief and frame.
  const later = base(f, project, "brief-src-later");
  assert.notEqual(later.frameRef.id, b.frameRef.id);
  const hot = noWrite(f.store, wireFile, () =>
    checkFrameInterpretationChoice(f.store, req, structuredClone(answer), prev,
      choice(project, projected, prev, "chosen", "warehouse", "warehouse only")));
  assert.deepEqual(hot, first, "heads moving never rewrites a historical projection");
  const cold = f.open();
  const restored = noWrite(cold, wireFile, () =>
    checkFrameInterpretationChoice(cold, req, structuredClone(answer), prev,
      choice(project, projected, prev, "chosen", "warehouse", "warehouse only")));
  assert.deepEqual(restored, first, "a cold store restores the same projection");
  // The later frame's set is its own package — same member ids, different
  // grounds — and never stands in for the first.
  const laterSet = projectFrameInterpretations(materialSet(project, later.mandate, later.frameRef));
  const foreign = choice(project, laterSet, prev, "chosen", "warehouse", "warehouse only");
  const codeAt = code(() => checkFrameInterpretationChoice(cold, req, answer, prev, foreign));
  assert.equal(codeAt, "frame_choice_mismatch");
});

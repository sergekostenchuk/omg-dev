import { validPlan, planQuestion } from "./discovery-v7-fixture.js";
import { V7_AXES } from "../src/discovery/v7-contracts.js";
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
import { createPartialV7Draft, discoveryAcceptanceActId, isDiscoveryV7Draft,
  V7_BRIEF_FIELD, V7_FRAME_FIELD, V7_FRAME_INTERPRETATIONS_CONTRACT,
  V7_FRAME_INTERPRETATIONS_KIND, V7_OBJECTIVE_FIELD, V7_PLAN_FIELD,
  type DiscoveryAcceptanceAct } from "../src/discovery/v7-contracts.js";
import { discoveryPrefixClosureId } from "../src/discovery/discovery.js";
import { reuseResearch } from "../src/discovery/research-reuse.js";
import { managedAnswerId } from "../src/discovery/research-consumer-transition.js";
import { savedAcceptanceAct } from "../src/discovery/projection-reader.js";
import { projectFrameInterpretations } from "../src/discovery/frame-interpretations.js";
import { collectFrameInterpretationSubject, checkFrameInterpretationSubject,
  decodeFrameInterpretationSubject  , FRAME_SUBJECT_CONTRACT,
  type FrameSubjectRequest } from "../src/discovery/frame-interpretation-subject.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, questionOf, validFrame, type DiscoveryFixture } from "./discovery-v7-fixture.js";

// DR2b 2b.1-SOURCES (codex-omg №14475): the read-only preparer of the complete
// source subject of one exact accepted D1 frame — real v7 producers write the
// draft, the brief fact, the owner objective and the assessed frame; the sets
// below are structural records of the accepted 2b.1-F form, never chosen, paid
// or owner-approved. Interpretation choice, owner act and payment semantics
// stay 2b.2–2b.6 and are neither produced nor faked here.

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
function base(f: DiscoveryFixture, project: string, variant: "text" | "json" | "unbriefed" = "text",
  sourceKey = "brief-src"): Base {
  const json = variant === "json";
  const content = json ? JSON_DOC : TEXT_BRIEF;
  const selector: Selector = json ? { kind: "json-pointer", pointer: "/brief" } : { ...RANGE };
  const src = f.discovery.evidence.document(project, sourceKey, content,
    json ? "application/json" : "text/plain", 0);
  const draft = createPartialV7Draft(f.discovery, project, "concept", [reference(src)]);
  const briefQ = questionOf(f.store, draft, "brief");
  if (variant !== "unbriefed")
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

/** A structural set of the accepted 2b.1-F form, written as a plain record —
 * structural only, never paid or owner-approved. */
function writeStructuralSet(store: Store, value: Record<string, unknown>): Ref {
  const projected = projectFrameInterpretations(value);
  const row = store.write({ id: projected.id, kind: V7_FRAME_INTERPRETATIONS_KIND,
    expected: 0, value: projected.value });
  return reference(row);
}
const materialSet = (project: string, brief: { source: Ref; selector: Json }, frame: Ref,
  previousSet: Ref | null = null): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project, brief,
  frame, previousSet, outcome: "material",
  reason: "«Учёт материалов» reads as the warehouse only or also the sites, and the result changes",
  interpretations: [
    { id: "warehouse", meaning: "Central warehouse only",
      consequences: [{ affects: "boundaries", text: "Sites are out of scope" }],
      support: [brief.selector] },
    { id: "sites", meaning: "Warehouse and the site write-off",
      consequences: [{ affects: "acceptance", text: "Each site closes its write-off" }],
      support: [brief.selector] }] });
const plainSet = (project: string, brief: { source: Ref; selector: Json }, frame: Ref,
  previousSet: Ref | null = null): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project, brief,
  frame, previousSet, outcome: "no_divergence",
  reason: "One warehouse reading, no divergence", interpretations: [] });

test("2b.1-S collects the complete subject of a real accepted frame: provenance, verbatim mandate, resolved grounds and derived identity", (t) => {
  const f = discoveryFixture(t, "omg-2bs-main-"), project = "garden";
  const b = base(f, project);
  const req = requestOf(project, b);
  const pkg = collectFrameInterpretationSubject(f.store, req);
  assert.equal(pkg.contract, FRAME_SUBJECT_CONTRACT);
  assert.deepEqual(Object.keys(pkg).sort(),
    ["contract", "frame", "mandate", "previous", "project", "subject"]);
  assert.match(pkg.subject, /^[a-f0-9]{64}$/);
  const { subject: _subject, ...body } = pkg;
  assert.equal(hashJson(body as never), pkg.subject, "identity covers every field");
  assert.equal(pkg.project, project);
  // The frame record and its whole D1 chain at the saved acceptance revisions.
  assert.equal(canonical(reference(pkg.frame.record)), canonical(req.frame));
  assert.equal(pkg.frame.record.kind, "research-answer");
  assert.equal(pkg.frame.record.value.projectId, project);
  assert.equal(pkg.frame.question.kind, "question");
  assert.equal(pkg.frame.question.value.spec.field, "frame");
  assert.equal(pkg.frame.question.value.status, "answered");
  assert.equal(canonical(pkg.frame.question.value.answer as Ref), canonical(req.frame));
  assert.equal(pkg.frame.draft.kind, "discovery-draft");
  assert.deepEqual(pkg.frame.draft.value.fields.frame, pkg.frame.record.value.value);
  assert.equal(pkg.frame.acceptance.kind, "discovery-acceptance-act");
  assert.equal(pkg.frame.acceptance.value.field, "frame");
  assert.equal(canonical(pkg.frame.acceptance.value.answer), canonical(req.frame));
  assert.equal(pkg.frame.assessment?.kind, "research-assessment");
  assert.equal(pkg.frame.binding, null);
  // Sources: the draft's inputs and the assessment's observations, each resolved to bytes.
  assert.equal(pkg.frame.inputs.length, 1);
  assert.equal(canonical(reference(pkg.frame.inputs[0]!)), canonical(reference(b.src)));
  assert.equal(pkg.frame.inputs[0]!.value && (pkg.frame.inputs[0]!.value as { content?: string }).content,
    TEXT_BRIEF, "the input source carries its saved content");
  assert.equal(pkg.frame.grounds.length, 1);
  const ground = pkg.frame.grounds[0]!;
  assert.equal(canonical(reference(ground.source)), canonical(reference(b.src)));
  assert.equal(ground.observation.value, TEXT_BRIEF, "the ground resolves the whole excerpt verbatim");
  assert.equal(canonical(ground.observation.source), canonical(reference(b.src)));
  // The mandate is the draft's own accepted brief, resolved verbatim.
  assert.equal(pkg.mandate.observation.value, TEXT_BRIEF.slice(RANGE.start, RANGE.end));
  assert.equal(canonical(pkg.mandate.observation.source), canonical(b.mandate.source));
  assert.deepEqual(pkg.mandate.observation.selector, RANGE);
  assert.equal(reference(pkg.mandate.source).hash, b.src.hash);
  assert.equal(pkg.previous, null);
});

test("2b.1-S resolves a JSON-pointer mandate the same way — the pointer is walked over the saved JSON, not prefix-matched", (t) => {
  const f = discoveryFixture(t, "omg-2bs-json-"), project = "harbor";
  const b = base(f, project, "json");
  const pkg = collectFrameInterpretationSubject(f.store, requestOf(project, b));
  assert.equal(pkg.mandate.observation.value, "Учёт материалов: склад и списание на объектах");
  assert.deepEqual(pkg.mandate.observation.selector, { kind: "json-pointer", pointer: "/brief" });
  assert.equal(pkg.mandate.source.value.mediaType, "application/json");
  assert.equal(code(() => collectFrameInterpretationSubject(f.store,
    { project, frame: b.frameRef, mandate: { source: b.mandate.source, selector: { kind: "json-pointer", pointer: "/missing" } } })),
    "research_consumer_intent_invalid", "a missing JSON path is its own addressed refusal");
  assert.equal(code(() => collectFrameInterpretationSubject(f.store,
    { project, frame: b.frameRef, mandate: { source: b.mandate.source, selector: { kind: "json-pointer", pointer: "/extra" } } })),
    "frame_subject_mismatch", "a resolved-but-different excerpt is not the accepted brief");
});

test("2b.1-S a previous structural set is read by the structural reader with its own sources resolved; the chain stays structural end to end", (t) => {
  const f = discoveryFixture(t, "omg-2bs-prev-"), project = "meadow";
  const b = base(f, project);
  const second = base(f, project, "text", "brief-src-2");
  const first = writeStructuralSet(f.store,
    plainSet(project, { source: reference(b.src), selector: RANGE }, b.frameRef));
  const later = writeStructuralSet(f.store,
    materialSet(project, { source: reference(second.src), selector: { ...RANGE, end: RANGE.end - 2 } },
      second.frameRef, first));
  const pkg = collectFrameInterpretationSubject(f.store, requestOf(project, b, later));
  const prev = pkg.previous!;
  assert.equal(prev.verification, "structural", "a previous set stays structural, never promoted");
  assert.equal(canonical(reference(prev.record)), canonical(later));
  assert.equal(prev.record.value.outcome, "material");
  assert.equal(prev.brief.observation.value, TEXT_BRIEF.slice(RANGE.start, RANGE.end - 2));
  assert.equal(canonical(reference(prev.brief.source)), canonical(reference(second.src)));
  assert.equal(canonical(reference(prev.frame.record)), canonical(second.frameRef),
    "the set's own frame is resolved with its provenance");
  const earlier = prev.previous!;
  assert.equal(earlier.verification, "structural");
  assert.equal(canonical(reference(earlier.record)), canonical(first));
  assert.equal(earlier.record.value.outcome, "no_divergence");
  assert.equal(earlier.previous, null);
  for (const mark of ["selected", "accepted", "paid", "ownerApproved"])
    assert.ok(!Object.keys(pkg).includes(mark), `no ${mark} mark is part of the subject`);
  assert.ok(!Object.keys(pkg.previous as object).includes("selected"),
    "the structural previous set adds no choice mark");
  assert.equal(code(() => collectFrameInterpretationSubject(f.store,
    requestOf(project, b, { ...later, id: `${V7_FRAME_INTERPRETATIONS_KIND}:other:${"0".repeat(8)}` }))),
    "frame_interpretations_invalid", "a foreign or missing previous set is the structural reader's refusal");
  assert.equal(code(() => collectFrameInterpretationSubject(f.store,
    requestOf(project, b, { id: `${V7_FRAME_INTERPRETATIONS_KIND}:${project}:missing`, revision: 1, hash: "0".repeat(64) }))),
    "frame_interpretations_invalid");
});

test("2b.1-S the same subject is restored after heads move and after a cold reopen; another frame or mandate is another subject", (t) => {
  const f = discoveryFixture(t, "omg-2bs-heads-"), project = "orchard";
  const b = base(f, project);
  const req = requestOf(project, b);
  const first = collectFrameInterpretationSubject(f.store, req);
  // Move the draft head and write more records: exact historical material does not move.
  const planQ = questionOf(f.store, b.draft, "plan");
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(b.draft.id)!,
    f.store.get<Question>(planQ.id)!, validPlan(b.frameRef, V7_AXES.map(axis => planQuestion(`q-${axis}`, axis,
      ['rules', 'feasibility'].includes(axis) ? 'blocking' : 'supporting'))), b.src);
  assert.notEqual(f.store.get<DiscoveryDraft>(b.draft.id)!.revision, first.frame.draft.revision,
    "the head really moved past the proven revision");
  const again = collectFrameInterpretationSubject(f.store, req);
  assert.deepEqual(again, first, "the package is restored byte-identically after head moves");
  const cold = f.open();
  const reopened = collectFrameInterpretationSubject(cold, req);
  assert.deepEqual(reopened, first, "a cold store restores the same historical subject");
  const other = base(f, "orchard2");
  const different = collectFrameInterpretationSubject(f.store, requestOf("orchard2", other));
  assert.notEqual(different.subject, first.subject, "another frame is another subject");
  const json = base(f, "orchard3", "json");
  const jsonSubject = collectFrameInterpretationSubject(f.store, requestOf("orchard3", json));
  assert.notEqual(jsonSubject.subject, first.subject, "another mandate is another subject");
});

test("2b.1-S check re-proves a presented package against the saved material and returns the proven one; truncation, substitution, marks and foreign linkage are refused", (t) => {
  const f = discoveryFixture(t, "omg-2bs-check-"), project = "field";
  const b = base(f, project);
  const req = requestOf(project, b);
  const pkg = collectFrameInterpretationSubject(f.store, req);
  const presented = structuredClone(pkg);
  const checked = checkFrameInterpretationSubject(f.store, req, presented);
  assert.notEqual(checked, presented, "the proven package is delivered, never the presented object");
  assert.deepEqual(checked, pkg);
  const cases: [string, (s: Record<string, any>) => void, string, string][] = [
    ["truncated grounds", s => { s.frame.grounds = []; }, "frame_subject_mismatch", "subject"],
    ["a substituted observation", s => { s.mandate.observation.value = "пересказ"; }, "frame_subject_mismatch", "subject"],
    ["a substituted source record", s => { s.mandate.source.value.content = "changed"; },
      "frame_subject_invalid", "package.mandate.source"],
    ["a paid mark", s => { s.frame.paid = true; }, "frame_subject_invalid", "package.frame.paid"],
    ["an acceptance mark", s => { s.accepted = true; }, "frame_subject_invalid", "package.accepted"],
    ["a selected interpretation", s => { s.previous = { verification: "structural", record: {}, brief: {}, frame: {}, previous: null, selected: "x" }; },
      "frame_subject_invalid", "package.previous.selected"],
    ["a wrong subject identity", s => { s.subject = "0".repeat(64); }, "frame_subject_mismatch", "subject"],
    ["a foreign project", s => { s.project = "other"; }, "frame_subject_mismatch", "project"],
    ["no draft", s => { delete s.frame.draft; }, "frame_subject_invalid", "package.frame.draft"],
  ];
  for (const [name, damage, expected, at] of cases) {
    const value = structuredClone(pkg) as Record<string, any>;
    damage(value);
    assert.equal(code(() => checkFrameInterpretationSubject(f.store, req, value)), expected, name);
    assert.equal(field(() => checkFrameInterpretationSubject(f.store, req, value)), at, `${name} is refused at its field`);
  }
  // A package internally consistent — its recomputed identity covers its own
  // mutated content — still differs from the proven subject at the real field.
  const crafted = structuredClone(pkg) as Record<string, any>;
  crafted.frame.grounds = [];
  crafted.subject = hashJson(((value: Record<string, any>) => {
    const { subject: _s, ...rest } = value; return rest;
  })(crafted) as never);
  assert.equal(code(() => checkFrameInterpretationSubject(f.store, req, crafted)), "frame_subject_mismatch");
  assert.equal(field(() => checkFrameInterpretationSubject(f.store, req, crafted)), "frame");
  // Request linkage: another frame, another mandate address, another previous set.
  const second = base(f, "field2");
  assert.equal(code(() => checkFrameInterpretationSubject(f.store,
    requestOf(project, b), { ...structuredClone(pkg), project: project })), "no-error");
  assert.equal(field(() => checkFrameInterpretationSubject(f.store,
    { ...req, frame: second.frameRef }, structuredClone(pkg))), "frame");
  assert.equal(field(() => checkFrameInterpretationSubject(f.store,
    { ...req, mandate: { ...req.mandate, selector: { kind: "text-range", start: 0, end: 1 } } },
    structuredClone(pkg))), "mandate");
  assert.equal(field(() => checkFrameInterpretationSubject(f.store,
    { ...req, previousSet: b.frameRef }, structuredClone(pkg))), "previous");
  // The decoder alone holds the closed form.
  assert.equal(code(() => decodeFrameInterpretationSubject(null)), "frame_subject_invalid");
  assert.equal(field(() => decodeFrameInterpretationSubject({ ...structuredClone(pkg), contract: "v2" })), "package.contract");
});

test("2b.1-S foreign, missing and mismatched inputs refuse at their typed address; the verbatim mandate must be the draft's own accepted brief", (t) => {
  const f = discoveryFixture(t, "omg-2bs-foreign-"), project = "quarry";
  const b = base(f, project);
  const other = base(f, "other");
  const req = requestOf(project, b);
  const cases: [string, () => unknown, string, string][] = [
    ["a missing frame record", () => collectFrameInterpretationSubject(f.store,
      { ...req, frame: { id: `research-answer:${project}:none`, revision: 1, hash: "0".repeat(64) } }),
      "research_acceptance_binding_invalid", "?"],
    ["another project's frame", () => collectFrameInterpretationSubject(f.store,
      { ...req, frame: other.frameRef }), "research_acceptance_binding_invalid", "?"],
    ["a fact instead of the frame", () => {
      const briefAnswer = f.store.get<Question>(b.briefQ.id)!.value.answer!;
      return collectFrameInterpretationSubject(f.store, { ...req, frame: briefAnswer }); },
      "research_acceptance_binding_invalid", "?"],
    ["a source instead of the frame", () => collectFrameInterpretationSubject(f.store,
      { ...req, frame: reference(b.src) }), "research_acceptance_binding_invalid", "?"],
    ["another project's mandate source", () => collectFrameInterpretationSubject(f.store,
      { ...req, mandate: { source: reference(other.src), selector: RANGE } }), "frame_subject_mismatch", "mandate.source"],
    ["an out-of-range mandate", () => collectFrameInterpretationSubject(f.store,
      { ...req, mandate: { source: b.mandate.source, selector: { kind: "text-range", start: 3, end: 10_000 } } }),
      "research_consumer_intent_invalid", "?"],
    ["a reduced mandate", () => collectFrameInterpretationSubject(f.store,
      { ...req, mandate: { source: b.mandate.source, selector: { kind: "text-range", start: 3, end: 61 } } }),
      "frame_subject_mismatch", "mandate"],
    ["a malformed selector", () => collectFrameInterpretationSubject(f.store,
      { ...req, mandate: { source: b.mandate.source, selector: { kind: "paraphrase", text: "склад" } as never } }),
      "frame_subject_invalid", "request.mandate.selector.kind"],
    ["a malformed frame ref", () => collectFrameInterpretationSubject(f.store,
      { ...req, frame: { id: "x" } as never }), "frame_subject_invalid", "request.frame.revision"],
    ["a malformed previousSet ref", () => collectFrameInterpretationSubject(f.store,
      { ...req, previousSet: { id: "x" } as never }), "frame_subject_invalid", "request.previousSet.revision"],
    ["an extra request field", () => collectFrameInterpretationSubject(f.store,
      { ...req, paid: true } as never), "frame_subject_invalid", "request.paid"],
  ];
  for (const [name, fn, expected, at] of cases) {
    assert.equal(code(fn), expected, name);
    if (at !== "?") assert.equal(field(fn), at, `${name} is refused at its field`);
  }
  // The 'plan' answer is a real research-answer — but not the frame field's.
  const planQ = questionOf(f.store, b.draft, "plan");
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(b.draft.id)!,
    f.store.get<Question>(planQ.id)!, validPlan(b.frameRef, V7_AXES.map(axis => planQuestion(`q-${axis}`, axis,
      ['rules', 'feasibility'].includes(axis) ? 'blocking' : 'supporting'))), b.src);
  const planRef = f.store.get<Question>(planQ.id)!.value.answer!;
  assert.equal(code(() => collectFrameInterpretationSubject(f.store, { ...req, frame: planRef })),
    "frame_subject_missing", "a non-frame answer has no saved frame acceptance");
  assert.equal(field(() => collectFrameInterpretationSubject(f.store, { ...req, frame: planRef })),
    "frame.acceptance");
  // A draft whose frame is accepted with no accepted brief: the linkage door is named, not faked.
  const bare = base(f, "unbriefed", "unbriefed");
  assert.equal(code(() => collectFrameInterpretationSubject(f.store,
    { project: "unbriefed", frame: bare.frameRef, mandate: bare.mandate })),
    "frame_subject_missing");
  assert.equal(field(() => collectFrameInterpretationSubject(f.store,
    { project: "unbriefed", frame: bare.frameRef, mandate: bare.mandate })), "mandate");
});

test("2b.1-S collecting and checking write no records and send nothing: heads, history, calls and ledger stay byte-identical", (t) => {
  const f = discoveryFixture(t, "omg-2bs-readonly-"), project = "forest";
  const b = base(f, project);
  const set = writeStructuralSet(f.store, plainSet(project, { source: reference(b.src), selector: RANGE }, b.frameRef));
  const snapshot = () => canonical(f.store.list().map(row => reference(row)));
  const history = () => canonical(f.store.list().map(row => [row.id,
    f.store.history(row.id).map(revision => revision.revision)]));
  const before = snapshot(), beforeHistory = history();
  const req = requestOf(project, b, set);
  const pkg = collectFrameInterpretationSubject(f.store, req);
  checkFrameInterpretationSubject(f.store, req, structuredClone(pkg));
  decodeFrameInterpretationSubject(structuredClone(pkg));
  assert.equal(snapshot(), before, "no head was created or moved");
  assert.equal(history(), beforeHistory, "no revision was appended anywhere");
  assert.equal(f.store.list("model-call").length, 0);
  assert.equal(f.store.list("ledger").length, 0);
  assert.equal(f.store.list(V7_FRAME_INTERPRETATIONS_KIND).length, 1,
    "the only set record is the structural one the test itself wrote");
});

test("2b.1-S the local refusal catalogue is exactly the three subject codes; foreign readers keep their own typed refusals", (t) => {
  const f = discoveryFixture(t, "omg-2bs-catalog-"), project = "pond";
  const b = base(f, project);
  const req = requestOf(project, b);
  const pkg = collectFrameInterpretationSubject(f.store, req);
  const local = new Set<string>(), foreign = new Set<string>();
  const watch = (fn: () => unknown) => {
    try { fn(); } catch (error) {
      const c = (error as EngineError).code;
      (c.startsWith("frame_subject_") ? local : foreign).add(c);
    }
  };
  watch(() => collectFrameInterpretationSubject(f.store, { ...req, frame: { id: "x" } as never }));
  watch(() => collectFrameInterpretationSubject(f.store, { ...req,
    mandate: { source: b.mandate.source, selector: { kind: "text-range", start: 3, end: 61 } } }));
  watch(() => collectFrameInterpretationSubject(f.store, { ...req, frame: otherFrame(f, project) }));
  watch(() => collectFrameInterpretationSubject(f.store, { ...req,
    mandate: { source: b.mandate.source, selector: { kind: "text-range", start: 0, end: 10_000 } } }));
  watch(() => collectFrameInterpretationSubject(f.store,
    { project: "absent-draft", frame: b.frameRef, mandate: b.mandate }));
  watch(() => checkFrameInterpretationSubject(f.store, req, { ...structuredClone(pkg), extra: 1 }));
  watch(() => checkFrameInterpretationSubject(f.store, req, { ...structuredClone(pkg), subject: "0".repeat(64) }));
  watch(() => checkFrameInterpretationSubject(f.store, req, (() => { const p = structuredClone(pkg); p.mandate.observation.value = "x"; return p; })()));
  assert.deepEqual([...local].sort(), ["frame_subject_invalid", "frame_subject_mismatch", "frame_subject_missing"]);
  assert.ok(foreign.has("research_acceptance_binding_invalid"), "the acceptance reader keeps its refusal");
  assert.ok(foreign.has("research_consumer_intent_invalid"), "the selector mechanism keeps its addressed refusal");
});

test("2b.1-S a rebound frame accepted through real reuse still resolves its own accepted brief; hot and cold reads agree", async (t) => {
  const f = discoveryFixture(t, "omg-2bs-reuse-"), project = "reuse", wire = join(f.root, "wire.ndjson");
  const first = base(f, project);
  // The second v7 draft of the same project, stage, specs, consumer and
  // inputs — the exact reuse candidate of the first one's answered frame.
  const draft2 = createPartialV7Draft(f.discovery, project, "concept", [reference(first.src)]);
  const briefQ2 = questionOf(f.store, draft2, "brief");
  f.engine.discovery.fact(briefQ2.id, briefQ2.revision, reference(first.src), { ...RANGE });
  const objective2 = questionOf(f.store, draft2, "objective");
  f.engine.discovery.decision(objective2.id, f.store.get<Question>(objective2.id)!.revision,
    "owner", `Deliver ${project} outcome`);
  const environment = reference(f.store.get(`fixture-research-environment:${project}`)!);
  assert.equal(reuseResearch(f.store, f.discovery, f.store.get<DiscoveryDraft>(draft2.id)!, environment), 1,
    "the real reuse door rebinds the first draft's paid frame assessment");
  const frameQ2 = questionOf(f.store, draft2, "frame");
  const frameRef2 = f.store.get<Question>(frameQ2.id)!.value.answer!;
  const draftAfter = f.store.get<DiscoveryDraft>(draft2.id)!;
  assert.equal(f.store.get(discoveryPrefixClosureId(draft2.id, draftAfter.revision)), null,
    "a rebound frame assessment deliberately leaves the draft revision unclosed");
  const req = requestOf(project, { ...first, draft: draft2, frameRef: frameRef2 });
  const pkg = collectFrameInterpretationSubject(f.store, req);
  assert.equal(pkg.mandate.observation.value, TEXT_BRIEF.slice(RANGE.start, RANGE.end),
    "the accepted brief is proven by its own saved act without a prefix closure");
  assert.equal(canonical(reference(pkg.frame.draft)), canonical(reference(draftAfter)));
  assert.equal(pkg.frame.assessment?.value.reusedFrom !== undefined, true,
    "the resolved frame really is the rebound acceptance");
  assert.deepEqual(collectFrameInterpretationSubject(f.open(), req), pkg,
    "a cold reopen resolves the same historical subject");
  const checked = checkFrameInterpretationSubject(f.open(), req, structuredClone(pkg));
  assert.deepEqual(checked, pkg);
  // A late brief re-acceptance after the frame is real history — but the
  // mandate stays the acceptance in effect at the frame's saved draft
  // revision: the late source never stands in for it.
  const late = f.discovery.evidence.document(project, "late-src", TEXT_BRIEF, "text/plain", 0);
  const briefHead = f.store.get<Question>(briefQ2.id)!;
  f.discovery.reopen(briefHead.id, briefHead.revision);
  f.engine.discovery.fact(briefQ2.id, f.store.get<Question>(briefQ2.id)!.revision, reference(late), { ...RANGE });
  assert.deepEqual(await noWrite(f.store, wire, () => collectFrameInterpretationSubject(f.store, req)), pkg,
    "the historical package is unchanged by the late acceptance");
  assert.deepEqual(collectFrameInterpretationSubject(f.open(), req), pkg, "a cold store agrees");
  const cold = f.open();
  assert.deepEqual(await noWrite(cold, wire, () => checkFrameInterpretationSubject(cold, req, structuredClone(pkg))), pkg);
  const lateReq = { project, frame: frameRef2, mandate: { source: reference(late), selector: { ...RANGE } } };
  assert.equal(await noWrite(f.store, wire, () => code(() => collectFrameInterpretationSubject(f.store, lateReq))),
    "frame_subject_mismatch", "the late source is not the historical mandate");
  assert.equal(await noWrite(f.store, wire, () => field(() => collectFrameInterpretationSubject(f.store, lateReq))), "mandate");
});

test("2b.1-S a hidden before-revision of the saved brief act refuses; the acceptance is proven through the shared reader, not borrowed fields", async (t) => {
  const f = discoveryFixture(t, "omg-2bs-brief-"), project = "brick", wire = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const req = requestOf(project, b);
  const pkg = collectFrameInterpretationSubject(f.store, req);
  assert.equal(pkg.mandate.observation.value, TEXT_BRIEF.slice(RANGE.start, RANGE.end));
  // Hide the exact questionBefore revision the saved brief acceptance act names:
  // a collect that returned the package anyway was trusting act fields, not history.
  const briefAnswer = f.store.get<Question>(b.briefQ.id)!.value.answer!;
  const act = f.store.get<DiscoveryAcceptanceAct>(
    discoveryAcceptanceActId(project, b.draft.id, "brief", briefAnswer), 1)!;
  const before = act.value.questionBefore!;
  const get = f.store.get;
  f.store.get = ((id: string, revision?: number) =>
    (id === before.id && revision === before.revision ? null : get.call(f.store, id, revision))) as typeof f.store.get;
  try {
    for (const fn of [() => collectFrameInterpretationSubject(f.store, req),
      () => checkFrameInterpretationSubject(f.store, req, structuredClone(pkg))]) {
      assert.equal(await noWrite(f.store, wire, () => code(fn)), "frame_subject_missing");
      assert.equal(await noWrite(f.store, wire, () => field(fn)), "mandate");
    }
  } finally { delete (f.store as { get?: unknown }).get; }
});

test("2b.1-S the shared reader still refuses a malformed managed research-answer address and a fact masked by a managed address; only proven non-managed answers at their own address carry no turn", async (t) => {
  const f = discoveryFixture(t, "omg-2bs-managed-"), project = "managed-x", wire = join(f.root, "wire.ndjson");
  const b = base(f, project);
  const head = f.store.get<DiscoveryDraft>(b.draft.id)!;
  // Positive right beside it: the real fact acceptance of this draft proves
  // through the same shared door — absence of a managed turn is its lawful form.
  const briefQ = f.store.get<Question>(b.briefQ.id)!;
  assert.equal(await noWrite(f.store, wire,
    () => savedAcceptanceAct(f.store, head, briefQ, "brief", briefQ.value.answer!, head.value.fields.brief!)), true);
  // A consistent crafted act — real transitions, real assessment — but its
  // answer carries a malformed managed research-answer address: the shared
  // reader must refuse it, not read it as a binding-less acceptance.
  const planQ = questionOf(f.store, b.draft, "plan");
  const planted = { planted: true } as unknown as Json;
  const fakeAssessment = f.store.write({ id: `research-assessment:${project}:planted`, kind: "research-assessment",
    expected: 0, value: { projectId: project, question: reference(planQ), value: planted,
      observations: [{}], verdict: "supported", reasons: [], researcher: "a", assessor: "b",
      environment: reference(b.src) } as never });
  const fakeAnswer = f.store.write({ id: `research-answer:${project}:managed-v1:%`, kind: "research-answer",
    expected: 0, value: { projectId: project, question: planQ.id, value: planted,
      assessment: reference(fakeAssessment) } as never });
  const badRef = reference(fakeAnswer);
  const qAfter = f.store.write<Question>({ id: planQ.id, kind: "question", expected: planQ.revision,
    value: { ...planQ.value, status: "answered", answer: badRef } });
  const dAfter = f.store.write<DiscoveryDraft>({ id: b.draft.id, kind: "discovery-draft", expected: head.revision,
    value: { ...head.value, fields: { ...head.value.fields, plan: planted } } });
  const realAct = f.store.get<DiscoveryAcceptanceAct>(discoveryAcceptanceActId(project, b.draft.id, "frame", b.frameRef), 1)!;
  f.store.write({ id: discoveryAcceptanceActId(project, b.draft.id, "plan", badRef), kind: "discovery-acceptance-act",
    expected: 0, value: { ...realAct.value, field: "plan", draftBefore: reference(head), draftAfter: reference(dAfter),
      questionBefore: reference(planQ), questionAfter: reference(qAfter), answer: badRef,
      assessment: reference(fakeAssessment), binding: null } });
  assert.equal(await noWrite(f.store, wire,
    () => savedAcceptanceAct(f.store, dAfter, f.store.get<Question>(planQ.id)!, "plan", badRef, planted)), false,
    "a malformed managed research-answer address is refused, not read as a binding-less acceptance");
  // The namespace masquerade beside it: a real fact record at a VALID managed
  // research-answer address, a consistent act with binding:null — the proven
  // kind is fact but the address is not the fact address of its project.
  const masked = { masked: true } as unknown as Json;
  const maskedFact = f.store.write({ id: managedAnswerId(project, "research-turn:v1:fact-mask"), kind: "fact",
    expected: 0, value: { projectId: project, question: b.briefQ.id,
      observation: { projectId: project, source: reference(b.src), selector: { ...RANGE }, value: masked } } as never });
  const maskedRef = reference(maskedFact);
  const reopened = f.discovery.reopen(b.briefQ.id, f.store.get<Question>(b.briefQ.id)!.revision);
  const qAfter2 = f.store.write<Question>({ id: b.briefQ.id, kind: "question", expected: reopened.revision,
    value: { ...reopened.value, status: "answered", answer: maskedRef } });
  const dAfter2 = f.store.write<DiscoveryDraft>({ id: b.draft.id, kind: "discovery-draft", expected: dAfter.revision,
    value: { ...dAfter.value, fields: { ...dAfter.value.fields, brief: masked } } });
  f.store.write({ id: discoveryAcceptanceActId(project, b.draft.id, "brief", maskedRef), kind: "discovery-acceptance-act",
    expected: 0, value: { ...realAct.value, field: "brief", draftBefore: reference(dAfter), draftAfter: reference(dAfter2),
      questionBefore: reference(reopened), questionAfter: reference(qAfter2), answer: maskedRef,
      assessment: null, binding: null } });
  assert.equal(await noWrite(f.store, wire,
    () => savedAcceptanceAct(f.store, dAfter2, f.store.get<Question>(b.briefQ.id)!, "brief", maskedRef, masked)), false,
    "a fact masked by a valid managed research-answer address is refused — the address must be of its own kind");
});

test("2b.1-S an accepted frame of another stage is not a D1 subject: the saved draft and question must stand at the Discovery v7 boundary", (t) => {
  const f = discoveryFixture(t, "omg-2bs-stage-"), project = "stage-x";
  const src = f.discovery.evidence.document(project, "brief-src", TEXT_BRIEF, "text/plain", 0);
  // A concept-stage draft stamped era 7 through the public producer surface,
  // answered by the ordinary producers — its frame is really saved and accepted.
  const draft = f.discovery.create(project, "concept", "R0", "concept",
    [V7_BRIEF_FIELD, V7_OBJECTIVE_FIELD, V7_FRAME_FIELD, V7_PLAN_FIELD], [reference(src)], 7);
  assert.equal(isDiscoveryV7Draft(draft.value), false, "the draft is era 7 but not a Discovery draft");
  const briefQ = questionOf(f.store, draft, "brief");
  f.engine.discovery.fact(briefQ.id, briefQ.revision, reference(src), { ...RANGE });
  const objectiveQ = questionOf(f.store, draft, "objective");
  f.engine.discovery.decision(objectiveQ.id, f.store.get<Question>(objectiveQ.id)!.revision,
    "owner", `Deliver ${project} outcome`);
  const frameQ = questionOf(f.store, draft, "frame");
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!,
    f.store.get<Question>(frameQ.id)!, validFrame(), src);
  const frameRef = f.store.get<Question>(frameQ.id)!.value.answer!;
  assert.equal(code(() => collectFrameInterpretationSubject(f.store,
    { project, frame: frameRef, mandate: { source: reference(src), selector: { ...RANGE } } })),
    "frame_subject_mismatch");
  assert.equal(field(() => collectFrameInterpretationSubject(f.store,
    { project, frame: frameRef, mandate: { source: reference(src), selector: { ...RANGE } } })), "frame");
});

/** A non-frame research-answer of the same project: the accepted plan answer. */
function otherFrame(f: DiscoveryFixture, project: string): Ref {
  return base(f, project, "unbriefed", `${project}-aux-src`).frameRef;
}

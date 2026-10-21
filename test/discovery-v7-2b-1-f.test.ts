import test from "node:test";
import assert from "node:assert/strict";
import { decodeFrameInterpretations, frameInterpretationsId, projectFrameInterpretations,
  readFrameInterpretationsStructural } from "../src/discovery/frame-interpretations.js";
import { V7_FRAME_INTERPRETATIONS_CONTRACT, V7_FRAME_INTERPRETATIONS_KIND } from "../src/discovery/v7-contracts.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import type { Ref } from "../src/pipeline/contracts.js";
import type { Revision } from "../src/storage/store.js";

// DR2b 2b.1-F (codex-omg №9189, №9532): the closed structural form of one exact set
// of material interpretations of the brief. The sets below are in-memory inputs of
// the pure form, the projector and the exact structural reader over an in-memory
// view — no paid, owner or chosen record is written or faked; the meaning of the
// support and the origin of a real set are 2b.2/2b.4.

const at = (id: string, revision = 1): Ref => ({ id, revision, hash: hashJson(`${id}@${revision}`) });
const previous = at(`${V7_FRAME_INTERPRETATIONS_KIND}:p:earlier`);
/** «Учёт материалов» — only the warehouse, or also the write-off on the building sites? */
const material = (): Record<string, any> => ({ contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: "p",
  brief: { source: at("source:p:brief"), selector: { kind: "text-range", start: 10, end: 90 } },
  frame: at("research-answer:frame-proposal", 2), previousSet: previous, outcome: "material",
  reason: "«Учёт материалов» reads as the warehouse only or also the write-off on the sites, and the result changes",
  interpretations: [
    { id: "warehouse", meaning: "Material accounting is the central warehouse only",
      consequences: [{ affects: "boundaries", text: "Site write-off is out of scope" },
        { affects: "result", text: "One warehouse register" }],
      support: [{ kind: "text-range", start: 10, end: 30 }] },
    { id: "sites", meaning: "Material accounting includes the write-off on every building site",
      consequences: [{ affects: "acceptance", text: "Each site closes its monthly write-off" }],
      support: [{ kind: "text-range", start: 10, end: 30 }, { kind: "text-range", start: 60, end: 90 }] }] });
const plain = (): Record<string, any> => ({ ...material(), previousSet: null, outcome: "no_divergence",
  reason: "The brief names one warehouse and no sites; the ordinary reading stays in the frame", interpretations: [] });
const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};
const field = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return ((error as EngineError).details as { field?: string } | null)?.field ?? "?"; }
  return "no-error";
};
const refused = (make: () => Record<string, any>, cases: [string, (s: Record<string, any>) => void, string][]) => {
  for (const [name, damage, expected] of cases) {
    const value = make(); damage(value);
    assert.equal(code(() => decodeFrameInterpretations(value)), "frame_interpretations_invalid", name);
    assert.equal(field(() => decodeFrameInterpretations(value)), expected, `${name} is refused at its field`);
  }
};
const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const view = (rows: Revision<unknown>[]) => ({ get: <T,>(id: string, revision?: number) =>
  (rows.find(row => row.id === id && (revision === undefined || row.revision === revision)) ?? null) as Revision<T> | null });
const row = (id: string, value: unknown, revision = 1, kind: string = V7_FRAME_INTERPRETATIONS_KIND): Revision<unknown> =>
  ({ id, kind, revision, hash: hashJson(value as Json), value });

test("2b.1-F no material divergence is its own outcome with a reason and no alternatives; an artificial alternative is refused", () => {
  const value = plain();
  assert.deepEqual(decodeFrameInterpretations(value), JSON.parse(canonical(value as Json)));
  assert.deepEqual(decodeFrameInterpretations(value).interpretations, [], "no invented alternative");
  refused(plain, [
    ["an artificial alternative", s => { s.interpretations = [material().interpretations[0]]; }, "interpretations"],
    ["two artificial alternatives", s => { s.interpretations = material().interpretations; }, "interpretations"],
    ["no reason", s => { delete s.reason; }, "set.reason"],
    ["a blank reason", s => { s.reason = " "; }, "reason"]]);
});

test("2b.1-F a lawful material set keeps its exact composition: at least two interpretations distinct by id with meaning, consequences and support inside the verbatim brief — on the decoder, the non-mutating projector and the exact structural reader", () => {
  const original = material(), frozen = deepFreeze(material());
  const decoded = decodeFrameInterpretations(frozen);
  assert.deepEqual(decoded, JSON.parse(canonical(original as Json)), "the exact composition is kept");
  assert.deepEqual(original, material(), "the input is not mutated");
  const projected = projectFrameInterpretations(frozen);
  assert.equal(projected.id, `${V7_FRAME_INTERPRETATIONS_KIND}:p:${hashJson(original as Json)}`);
  assert.equal(projected.id, frameInterpretationsId(original as { projectId: string }));
  assert.notEqual(projected.value.interpretations, frozen.interpretations, "the projected set is a copy");
  const pointerBrief = { ...material(), brief: { source: at("source:p:brief-json"), selector: { kind: "json-pointer", pointer: "/brief" } },
    interpretations: material().interpretations.map((item: Record<string, any>, i: number) =>
      ({ ...item, support: [{ kind: "json-pointer", pointer: i ? "/brief/sites" : "/brief" }] })) };
  assert.equal(decodeFrameInterpretations(pointerBrief).interpretations.length, 2, "a JSON brief is supported by its pointer or one below it");
  const changes: [string, (s: Record<string, any>) => void][] = [
    ["another brief source", s => { s.brief.source = at("source:p:brief", 2); }],
    ["another brief excerpt", s => { s.brief.selector = { kind: "text-range", start: 10, end: 91 }; }],
    ["another frame revision", s => { s.frame = at("research-answer:frame-proposal", 3); }],
    ["another previous set", s => { s.previousSet = null; }],
    ["another meaning", s => { s.interpretations[1].meaning = "Only the largest site"; }]];
  for (const [name, change] of changes) {
    const value = material(); change(value);
    assert.notEqual(projectFrameInterpretations(value).id, projected.id, `${name} is another set`);
  }
  const good = row(projected.id, projected.value);
  const read = readFrameInterpretationsStructural(view([good]), "p", { id: projected.id, revision: 1, hash: good.hash });
  assert.equal(read.verification, "structural", "a structural set, never a chosen or accepted one");
  assert.deepEqual(read.record.value, decoded);
  const ref = (id = projected.id, revision = 1, hash = good.hash): Ref => ({ id, revision, hash });
  const cases: [string, Revision<unknown>[], Ref, string][] = [
    ["another kind", [row(projected.id, projected.value, 1, "discovery-variant-set")], ref(), "p"],
    ["a later revision", [row(projected.id, projected.value, 2)], ref(projected.id, 2), "p"],
    ["another project", [good], ref(), "q"],
    ["a noncanonical address", [row(`${V7_FRAME_INTERPRETATIONS_KIND}:p:elsewhere`, projected.value)],
      ref(`${V7_FRAME_INTERPRETATIONS_KIND}:p:elsewhere`), "p"],
    ["a hash mismatch", [good], ref(projected.id, 1, "0".repeat(64)), "p"],
    ["a missing record", [], ref(), "p"],
    ["a record without its value", [(({ value: _value, ...rest }) => rest as Revision<unknown>)(good)], ref(), "p"]];
  for (const [name, rows, target, project] of cases)
    assert.equal(code(() => readFrameInterpretationsStructural(view(rows), project, target)), "frame_interpretations_invalid", name);
});

test("2b.1-F every interpretation carries its meaning, named consequences and support inside the exact brief; one alternative or a repeated id is no material divergence", () => {
  refused(material, [
    ["one interpretation", s => { s.interpretations = [s.interpretations[0]]; }, "interpretations"],
    ["no interpretations", s => { s.interpretations = []; }, "interpretations"],
    ["interpretations not a list", s => { s.interpretations = {}; }, "interpretations"],
    ["an id twice", s => { s.interpretations[1].id = "warehouse"; }, "interpretations.1.id"],
    ["a blank id", s => { s.interpretations[0].id = ""; }, "interpretations.0.id"],
    ["no meaning", s => { delete s.interpretations[0].meaning; }, "interpretations.0.meaning"],
    ["a blank meaning", s => { s.interpretations[1].meaning = " "; }, "interpretations.1.meaning"],
    ["no consequences", s => { delete s.interpretations[0].consequences; }, "interpretations.0.consequences"],
    ["empty consequences", s => { s.interpretations[0].consequences = []; }, "interpretations.0.consequences"],
    ["a consequence without its area", s => { delete s.interpretations[1].consequences[0].affects; }, "interpretations.1.consequences.0.affects"],
    ["a consequence of an unknown area", s => { s.interpretations[1].consequences[0].affects = "mood"; }, "interpretations.1.consequences.0.affects"],
    ["a blank consequence", s => { s.interpretations[1].consequences[0].text = ""; }, "interpretations.1.consequences.0.text"],
    ["a consequence twice", s => { s.interpretations[1].consequences.push({ ...s.interpretations[1].consequences[0] }); }, "interpretations.1.consequences"],
    ["no support", s => { delete s.interpretations[0].support; }, "interpretations.0.support"],
    ["empty support", s => { s.interpretations[0].support = []; }, "interpretations.0.support"],
    ["support before the brief", s => { s.interpretations[0].support = [{ kind: "text-range", start: 0, end: 30 }]; }, "interpretations.0.support.0"],
    ["support past the brief", s => { s.interpretations[1].support[1] = { kind: "text-range", start: 60, end: 91 }; }, "interpretations.1.support.1"],
    ["support of another selector kind", s => { s.interpretations[0].support = [{ kind: "json-pointer", pointer: "" }]; }, "interpretations.0.support.0"],
    ["an empty text range", s => { s.interpretations[0].support = [{ kind: "text-range", start: 20, end: 20 }]; }, "interpretations.0.support.0"],
    ["an unknown selector kind", s => { s.interpretations[0].support = [{ kind: "paraphrase", text: "the warehouse" }]; }, "interpretations.0.support.0.kind"],
    ["a support twice", s => { s.interpretations[1].support = [s.interpretations[1].support[0], s.interpretations[1].support[0]]; }, "interpretations.1.support"],
    ["a quote instead of an address", s => { s.interpretations[0].quote = "учёт материалов"; }, "interpretations.0.quote"]]);
  const json = (): Record<string, any> => ({ ...material(), brief: { source: at("source:p:brief-json"), selector: { kind: "json-pointer", pointer: "/brief" } },
    interpretations: material().interpretations.map((item: Record<string, any>) => ({ ...item, support: [{ kind: "json-pointer", pointer: "/brief" }] })) });
  refused(json, [
    ["a sibling pointer", s => { s.interpretations[0].support = [{ kind: "json-pointer", pointer: "/briefing" }]; }, "interpretations.0.support.0"],
    ["a pointer above the brief", s => { s.interpretations[0].support = [{ kind: "json-pointer", pointer: "" }]; }, "interpretations.0.support.0"],
    ["a bad pointer escape", s => { s.interpretations[0].support = [{ kind: "json-pointer", pointer: "/brief/~2" }]; }, "interpretations.0.support.0.pointer"]]);
});

test("2b.1-F the set is closed and its addresses exact: an absent field, a retold brief, a damaged or foreign reference, an unknown version and an acceptance masquerade are refused at their field", () => {
  refused(material, [
    ["no brief", s => { delete s.brief; }, "set.brief"],
    ["a retold brief", s => { s.brief = "Учёт материалов на складе и объектах"; }, "brief"],
    ["a brief with its text", s => { s.brief.text = "Учёт материалов"; }, "brief.text"],
    ["a brief source not a Ref", s => { s.brief.source = "source:p:brief"; }, "brief.source"],
    ["a brief source without hash", s => { delete s.brief.source.hash; }, "brief.source.hash"],
    ["a brief without its excerpt", s => { delete s.brief.selector; }, "brief.selector"],
    ["no frame", s => { delete s.frame; }, "set.frame"],
    ["a frame with revision zero", s => { s.frame.revision = 0; }, "frame"],
    ["a frame with a short hash", s => { s.frame.hash = "abc"; }, "frame"],
    ["a frame with an extra field", s => { s.frame.head = true; }, "frame.head"],
    ["no previous set", s => { delete s.previousSet; }, "set.previousSet"],
    ["a previous set of another kind", s => { s.previousSet = at("discovery-variant-set:p:earlier"); }, "previousSet"],
    ["a previous set of another project", s => { s.previousSet = at(`${V7_FRAME_INTERPRETATIONS_KIND}:q:earlier`); }, "previousSet"],
    ["a previous decision instead", s => { s.previous = at("interpretation-decision:p:d1"); }, "set.previous"],
    ["an unknown outcome", s => { s.outcome = "maybe"; }, "outcome"],
    ["a blank project", s => { s.projectId = " "; }, "projectId"],
    ["a selected interpretation", s => { s.selected = "warehouse"; }, "set.selected"],
    ["an accepted mark", s => { s.accepted = true; }, "set.accepted"],
    ["an owner approval", s => { s.ownerApproved = true; }, "set.ownerApproved"],
    ["an interpretation marked chosen", s => { s.interpretations[0].selected = true; }, "interpretations.0.selected"],
    ["owner words", s => { s.interpretations[1].ownerSays = "Склад и объекты"; }, "interpretations.1.ownerSays"]]);
  const versions: [string, unknown][] = [
    ["older contract", { ...material(), contract: "frame-interpretations/v0" }],
    ["newer contract", { ...material(), contract: "frame-interpretations/v2" }],
    ["no contract", (({ contract: _c, ...rest }) => rest)(material())],
    ["null", null], ["array", []]];
  for (const [name, value] of versions) {
    assert.equal(code(() => decodeFrameInterpretations(value)), "frame_interpretations_invalid", name);
    assert.equal(field(() => decodeFrameInterpretations(value)), "contract", `${name} is refused at the contract`);
  }
});

test("2b.1-F reference sites: the set declares exactly its brief source, its frame proposal and its previous set; meanings, consequences and support selectors are data", () => {
  assert.deepEqual(referenceSites(V7_FRAME_INTERPRETATIONS_KIND, material()).map(site => site.field).sort(),
    ["brief.source", "frame", "previousSet"]);
  assert.deepEqual(referenceSites(V7_FRAME_INTERPRETATIONS_KIND, plain()).map(site => site.field).sort(),
    ["brief.source", "frame"], "a first set names no previous set");
});

import test from "node:test";
import assert from "node:assert/strict";
import { coverageCellKey, decodeCoverageCell, DISCOVERY_COVERAGE_CELL_CONTRACT, DISCOVERY_COVERAGE_CELL_KIND } from "../src/discovery/coverage.js";
import { V7_PLAN_SUBJECT_CONTRACT } from "../src/discovery/v7-managed-attempt.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import type { Ref } from "../src/pipeline/contracts.js";

// DR5 5.1-F (codex-omg №9189, №9576): the closed form and the pure key of one coverage
// cell. The cells below are unsaved structural values only — no plan, variant or
// coverage confirmation is written or presented as accepted; what is missing and
// whether the question belongs to the accepted plan is the main 5.1.

const at = (id: string, revision = 1): Ref => ({ id, revision, hash: hashJson(`${id}@${revision}`) });
const cell = (): Record<string, any> => ({ contract: DISCOVERY_COVERAGE_CELL_CONTRACT, projectId: "p",
  subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: at("research-answer:plan", 3), planQuestionId: "q-retention" },
  variant: { set: at("discovery-variant-set:p:s1"), member: at("discovery-variant:p:v2") },
  requiredDepth: "deep", criterion: "Retention periods of the primary documents with the article of the law" });
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
const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
const refused = (cases: [string, (c: Record<string, any>) => void, string][]) => {
  for (const [name, damage, expected] of cases) {
    const value = cell(); damage(value);
    assert.equal(code(() => coverageCellKey(value)), "discovery_coverage_invalid", name);
    assert.equal(field(() => decodeCoverageCell(value)), expected, `${name} is refused at its field`);
  }
};

test("5.1-F one key for the same cell whatever the JSON key order; a frozen input is copied, never mutated; depth and criterion are kept verbatim", () => {
  const original = cell(), frozen = deepFreeze(cell());
  const expected = `${DISCOVERY_COVERAGE_CELL_KIND}:p:${hashJson(original as Json)}`;
  assert.equal(coverageCellKey(original), expected);
  assert.equal(coverageCellKey(reorder(original)), expected, "the JSON key order does not change the key");
  assert.equal(coverageCellKey(frozen), expected, "a deep-frozen input is read");
  assert.deepEqual(original, cell(), "the input is not mutated");
  const decoded = decodeCoverageCell(frozen);
  assert.deepEqual(decoded, JSON.parse(canonical(original as Json)));
  assert.notEqual(decoded.variant, frozen.variant, "the decoded cell is a copy");
  const verbatim = decodeCoverageCell({ ...cell(), requiredDepth: " Deep ", criterion: "  As the plan says.  " });
  assert.deepEqual([verbatim.requiredDepth, verbatim.criterion], [" Deep ", "  As the plan says.  "], "no ranking, trimming or parsing");
});

test("5.1-F another project, question, exact plan answer, set or member, depth or criterion never gets the previous key", () => {
  const variants: [string, (c: Record<string, any>) => void][] = [
    ["project", c => { c.projectId = "q"; c.variant = { set: at("discovery-variant-set:q:s1"), member: at("discovery-variant:q:v2") }; }],
    ["plan question", c => { c.subject.planQuestionId = "q-forms"; }],
    ["plan answer id", c => { c.subject.planAnswer = at("research-answer:plan-2", 3); }],
    ["plan answer revision", c => { c.subject.planAnswer = { ...c.subject.planAnswer, revision: 4 }; }],
    ["plan answer hash", c => { c.subject.planAnswer = { ...c.subject.planAnswer, hash: "0".repeat(64) }; }],
    ["set id", c => { c.variant.set = at("discovery-variant-set:p:s2"); }],
    ["set revision", c => { c.variant.set = { ...c.variant.set, revision: 2 }; }],
    ["set hash", c => { c.variant.set = { ...c.variant.set, hash: "f".repeat(64) }; }],
    ["member id", c => { c.variant.member = at("discovery-variant:p:v3"); }],
    ["member revision", c => { c.variant.member = { ...c.variant.member, revision: 2 }; }],
    ["member hash", c => { c.variant.member = { ...c.variant.member, hash: "e".repeat(64) }; }],
    ["depth", c => { c.requiredDepth = "brief"; }],
    ["criterion", c => { c.criterion = "Retention periods with the article and the regional act"; }]];
  const keys = new Map<string, string>([[coverageCellKey(cell()), "original"]]);
  for (const [name, change] of variants) {
    const value = cell(); change(value);
    const next = coverageCellKey(value);
    assert.equal(keys.has(next), false, `${name} gets its own key, not the key of ${keys.get(next)}`);
    keys.set(next, name);
  }
});

test("5.1-F the form is closed: every absent field, a wrong type, an unknown version and a status, assessment, claim or admission ground are refused at their field", () => {
  refused([
    ["no project", c => { delete c.projectId; }, "cell.projectId"],
    ["no subject", c => { delete c.subject; }, "cell.subject"],
    ["no variant", c => { delete c.variant; }, "cell.variant"],
    ["no depth", c => { delete c.requiredDepth; }, "cell.requiredDepth"],
    ["no criterion", c => { delete c.criterion; }, "cell.criterion"],
    ["a blank project", c => { c.projectId = ""; }, "projectId"],
    ["a depth not text", c => { c.requiredDepth = 2; }, "requiredDepth"],
    ["a blank depth", c => { c.requiredDepth = " "; }, "requiredDepth"],
    ["a criterion not text", c => { c.criterion = { text: "law" }; }, "criterion"],
    ["a blank criterion", c => { c.criterion = ""; }, "criterion"],
    ["a covered mark", c => { c.covered = true; }, "cell.covered"],
    ["an accepted mark", c => { c.accepted = true; }, "cell.accepted"],
    ["a supported mark", c => { c.supported = true; }, "cell.supported"],
    ["a ready mark", c => { c.ready = true; }, "cell.ready"],
    ["a computed status", c => { c.status = "missing"; }, "cell.status"],
    ["an assessment", c => { c.assessment = at("discovery-assessment:p1"); }, "cell.assessment"],
    ["claims", c => { c.claims = []; }, "cell.claims"],
    ["a decision", c => { c.decision = at("discovery-variant-owner-decision:p:d1"); }, "cell.decision"],
    ["a mode", c => { c.mode = "owner"; }, "cell.mode"],
    ["a grant", c => { c.grant = at("owner-grant:g1"); }, "cell.grant"],
    ["a session", c => { c.session = at("assessment-session:s1"); }, "cell.session"]]);
  const versions: [string, unknown][] = [
    ["older contract", { ...cell(), contract: "discovery-coverage-cell/v0" }],
    ["newer contract", { ...cell(), contract: "discovery-coverage-cell/v2" }],
    ["no contract", (({ contract: _c, ...rest }) => rest)(cell())],
    ["null", null], ["array", []], ["text", "coverage"]];
  for (const [name, value] of versions) {
    assert.equal(code(() => coverageCellKey(value)), "discovery_coverage_invalid", name);
    assert.equal(field(() => decodeCoverageCell(value)), "contract", `${name} is refused at the contract`);
  }
});

test("5.1-F the subject is the exact v7-plan-subject/v1 and the variant the exact set and member: common, a name, a bare id, a missing member and incomplete Refs never stand for them", () => {
  refused([
    ["a subject not an object", c => { c.subject = "q-retention"; }, "subject"],
    ["a subject of another contract", c => { c.subject.contract = "v6-question-subject/v1"; }, "subject.contract"],
    ["a subject without contract", c => { delete c.subject.contract; }, "subject.contract"],
    ["a subject without plan answer", c => { delete c.subject.planAnswer; }, "subject.planAnswer"],
    ["a subject without question", c => { delete c.subject.planQuestionId; }, "subject.planQuestionId"],
    ["a blank question", c => { c.subject.planQuestionId = " "; }, "subject.planQuestionId"],
    ["a subject with an extra field", c => { c.subject.question = at("question:p:q1"); }, "subject.question"],
    ["a plan answer as a bare id", c => { c.subject.planAnswer = "research-answer:plan"; }, "subject.planAnswer"],
    ["a plan answer without hash", c => { delete c.subject.planAnswer.hash; }, "subject.planAnswer.hash"],
    ["a plan answer with revision zero", c => { c.subject.planAnswer.revision = 0; }, "subject.planAnswer"],
    ["a plan answer with an extra field", c => { c.subject.planAnswer.head = true; }, "subject.planAnswer.head"],
    ["the common variant", c => { c.variant = "common"; }, "variant"],
    ["a variant name", c => { c.variant = { name: "Склад и объекты" }; }, "variant.set"],
    ["a bare variant id", c => { c.variant = { variantId: "v2" }; }, "variant.set"],
    ["a set without its member", c => { delete c.variant.member; }, "variant.member"],
    ["a member without its set", c => { delete c.variant.set; }, "variant.set"],
    ["a member as a bare id", c => { c.variant.member = "discovery-variant:p:v2"; }, "variant.member"],
    ["a set with a short hash", c => { c.variant.set.hash = "abc"; }, "variant.set"],
    ["a member with revision as text", c => { c.variant.member.revision = "1"; }, "variant.member"],
    ["a variant with an extra field", c => { c.variant.common = true; }, "variant.common"],
    ["set and member swapped", c => { c.variant = { set: c.variant.member, member: c.variant.set }; }, "variant.set"],
    ["a set of another project", c => { c.variant.set = at("discovery-variant-set:q:s1"); }, "variant.set"],
    ["a member of another project", c => { c.variant.member = at("discovery-variant:q:v2"); }, "variant.member"],
    ["a variant snapshot as the set", c => { c.variant.set = at("discovery-variant-snapshot:p:x"); }, "variant.set"]]);
});

test("5.1-F reference sites: the cell names exactly its plan answer and its exact set and member; the question id, depth and criterion are data", () => {
  assert.deepEqual(referenceSites(DISCOVERY_COVERAGE_CELL_KIND, cell()).map(site => site.field).sort(),
    ["subject.planAnswer", "variant.member", "variant.set"]);
  const smuggled = { ...cell(), confirmation: at("discovery-assessment:p1") };
  assert.deepEqual(referenceSites(DISCOVERY_COVERAGE_CELL_KIND, smuggled).map(site => site.field).sort(),
    ["subject.planAnswer", "variant.member", "variant.set"], "a Ref-like value outside the declared paths is not a reference");
});

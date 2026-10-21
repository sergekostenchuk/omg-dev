import test from "node:test";
import assert from "node:assert/strict";
import { decodeDeepPreparation, deepPreparationId, projectDeepPreparation,
  DISCOVERY_DEEP_PREPARATION_CONTRACT, DISCOVERY_DEEP_PREPARATION_KIND } from "../src/discovery/deep-research.js";
import { coverageCellKey, DISCOVERY_COVERAGE_CELL_CONTRACT } from "../src/discovery/coverage.js";
import { V7_PLAN_SUBJECT_CONTRACT } from "../src/discovery/v7-managed-attempt.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import type { Ref } from "../src/pipeline/contracts.js";

// DR5 5.2-F (codex-omg №9189, №9615): the closed form and the pure address of the
// preparation of one deep step — the exact 5.1-F coverage cell and the exact variant
// scope of its project. Unsaved structural values only: no paid, accepted or dispatch
// record is written or faked; the origin of the scope is the main 5.2 through 4P.

const at = (id: string, revision = 1): Ref => ({ id, revision, hash: hashJson(`${id}@${revision}`) });
const cellOf = (project = "p"): Record<string, any> => ({ contract: DISCOVERY_COVERAGE_CELL_CONTRACT, projectId: project,
  subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: at("research-answer:plan", 3), planQuestionId: "q-retention" },
  variant: { set: at(`discovery-variant-set:${project}:s1`), member: at(`discovery-variant:${project}:v2`) },
  requiredDepth: "deep", criterion: "Retention periods of the primary documents with the article of the law" });
const preparation = (): Record<string, any> => ({ contract: DISCOVERY_DEEP_PREPARATION_CONTRACT, cell: cellOf(),
  scope: at("discovery-variant-scope:p:owner-choice") });
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
const refused = (cases: [string, (p: Record<string, any>) => void, string][]) => {
  for (const [name, damage, expected] of cases) {
    const value = preparation(); damage(value);
    assert.equal(code(() => deepPreparationId(value)), "discovery_deep_preparation_invalid", name);
    assert.equal(field(() => decodeDeepPreparation(value)), expected, `${name} is refused at its field`);
  }
};

test("5.2-F a lawful structural preparation: one address whatever the JSON key order, a frozen input copied and never mutated, the cell kept verbatim, the projected record at revision 1", () => {
  const original = preparation(), frozen = deepFreeze(preparation());
  const expected = `${DISCOVERY_DEEP_PREPARATION_KIND}:p:${hashJson(original as Json)}`;
  assert.equal(deepPreparationId(original), expected);
  assert.equal(deepPreparationId(reorder(original)), expected, "the JSON key order does not change the address");
  assert.equal(deepPreparationId(frozen), expected, "a deep-frozen input is read");
  assert.deepEqual(original, preparation(), "the input is not mutated");
  const projected = projectDeepPreparation(frozen);
  assert.deepEqual({ kind: projected.kind, id: projected.id, revision: projected.revision },
    { kind: DISCOVERY_DEEP_PREPARATION_KIND, id: expected, revision: 1 });
  assert.deepEqual(projected.value, JSON.parse(canonical(original as Json)));
  assert.notEqual(projected.value.cell, frozen.cell, "the projected preparation is a copy");
  const verbatim = decodeDeepPreparation({ ...preparation(), cell: { ...cellOf(), requiredDepth: " Deep ", criterion: "  As planned.  " } });
  assert.deepEqual([verbatim.cell.requiredDepth, verbatim.cell.criterion], [" Deep ", "  As planned.  "], "no depth check by the text");
});

test("5.2-F every component of the cell and every id, revision and hash of the scope changes the preparation address; the same cell with another scope keeps the cell key and gets another preparation", () => {
  const changes: [string, (p: Record<string, any>) => void][] = [
    ["project", p => { p.cell = cellOf("q"); p.scope = at("discovery-variant-scope:q:owner-choice"); }],
    ["plan question", p => { p.cell.subject.planQuestionId = "q-forms"; }],
    ["plan answer id", p => { p.cell.subject.planAnswer = at("research-answer:plan-2", 3); }],
    ["plan answer revision", p => { p.cell.subject.planAnswer.revision = 4; }],
    ["plan answer hash", p => { p.cell.subject.planAnswer.hash = "0".repeat(64); }],
    ["set id", p => { p.cell.variant.set = at("discovery-variant-set:p:s2"); }],
    ["set revision", p => { p.cell.variant.set.revision = 2; }],
    ["set hash", p => { p.cell.variant.set.hash = "f".repeat(64); }],
    ["member id", p => { p.cell.variant.member = at("discovery-variant:p:v3"); }],
    ["member revision", p => { p.cell.variant.member.revision = 2; }],
    ["member hash", p => { p.cell.variant.member.hash = "e".repeat(64); }],
    ["depth", p => { p.cell.requiredDepth = "brief"; }],
    ["criterion", p => { p.cell.criterion = "Retention periods with the regional act"; }],
    ["scope id", p => { p.scope = at("discovery-variant-scope:p:model-choice"); }],
    ["scope revision", p => { p.scope.revision = 2; }],
    ["scope hash", p => { p.scope.hash = "d".repeat(64); }]];
  const ids = new Map<string, string>([[deepPreparationId(preparation()), "original"]]);
  for (const [name, change] of changes) {
    const value = preparation(); change(value);
    const next = deepPreparationId(value);
    assert.equal(ids.has(next), false, `${name} gets its own preparation, not the one of ${ids.get(next)}`);
    ids.set(next, name);
  }
  const other: Record<string, any> = { ...preparation(), scope: at("discovery-variant-scope:p:model-choice") };
  assert.equal(coverageCellKey(other.cell), coverageCellKey(preparation().cell), "the cell key stays the same");
  assert.notEqual(deepPreparationId(other), deepPreparationId(preparation()), "another exact scope is another preparation");
});

test("5.2-F the scope is required and exact: absent, null, common, a bare id, an incomplete Ref, another kind or project are refused at the scope — never a fall back to a broad step", () => {
  refused([
    ["no scope", p => { delete p.scope; }, "preparation.scope"],
    ["a null scope", p => { p.scope = null; }, "scope"],
    ["the common scope", p => { p.scope = "common"; }, "scope"],
    ["a scope as a bare id", p => { p.scope = "discovery-variant-scope:p:owner-choice"; }, "scope"],
    ["a broad step instead", p => { p.scope = { broad: true }; }, "scope.id"],
    ["a scope without hash", p => { delete p.scope.hash; }, "scope.hash"],
    ["a scope with revision zero", p => { p.scope.revision = 0; }, "scope"],
    ["a scope with a short hash", p => { p.scope.hash = "abc"; }, "scope"],
    ["a scope with an extra field", p => { p.scope.decision = at("discovery-variant-owner-decision:p:d1"); }, "scope.decision"],
    ["a scope of another project", p => { p.scope = at("discovery-variant-scope:q:owner-choice"); }, "scope"],
    ["a variant set as the scope", p => { p.scope = at("discovery-variant-set:p:s1"); }, "scope"],
    ["a variant decision as the scope", p => { p.scope = at("discovery-variant-owner-decision:p:d1"); }, "scope"]]);
});

test("5.2-F the form is closed: an absent cell, another version and ready, accepted or paid marks are refused; a refused cell keeps the address of its nested field", () => {
  refused([
    ["no cell", p => { delete p.cell; }, "preparation.cell"],
    ["a ready mark", p => { p.ready = true; }, "preparation.ready"],
    ["an accepted mark", p => { p.accepted = true; }, "preparation.accepted"],
    ["a paid mark", p => { p.paid = true; }, "preparation.paid"],
    ["a project copy", p => { p.projectId = "p"; }, "preparation.projectId"],
    ["a subject copy", p => { p.subject = p.cell.subject; }, "preparation.subject"],
    ["a dispatch permission", p => { p.dispatch = true; }, "preparation.dispatch"],
    ["a cell not an object", p => { p.cell = "q-retention"; }, "cell.contract"],
    ["a cell of another version", p => { p.cell.contract = "discovery-coverage-cell/v2"; }, "cell.contract"],
    ["a cell without project", p => { delete p.cell.projectId; }, "cell.projectId"],
    ["a cell with a blank project", p => { p.cell.projectId = " "; }, "cell.projectId"],
    ["a cell without variant", p => { delete p.cell.variant; }, "cell.variant"],
    ["a cell on the common variant", p => { p.cell.variant = "common"; }, "cell.variant"],
    ["a cell without member", p => { delete p.cell.variant.member; }, "cell.variant.member"],
    ["a cell plan answer without hash", p => { delete p.cell.subject.planAnswer.hash; }, "cell.subject.planAnswer.hash"],
    ["a covered cell", p => { p.cell.covered = true; }, "cell.covered"],
    ["a cell without criterion", p => { delete p.cell.criterion; }, "cell.criterion"]]);
  const versions: [string, unknown][] = [
    ["older contract", { ...preparation(), contract: "discovery-deep-preparation/v0" }],
    ["newer contract", { ...preparation(), contract: "discovery-deep-preparation/v2" }],
    ["no contract", (({ contract: _c, ...rest }) => rest)(preparation())],
    ["null", null], ["array", []], ["text", "deep"]];
  for (const [name, value] of versions) {
    assert.equal(code(() => deepPreparationId(value)), "discovery_deep_preparation_invalid", name);
    assert.equal(field(() => decodeDeepPreparation(value)), "contract", `${name} is refused at the contract`);
  }
});

test("5.2-F reference sites: exactly the plan answer, set and member of the cell and the scope; the cell texts are data", () => {
  assert.deepEqual(referenceSites(DISCOVERY_DEEP_PREPARATION_KIND, preparation()).map(site => site.field).sort(),
    ["cell.subject.planAnswer", "cell.variant.member", "cell.variant.set", "scope"]);
  const smuggled = { ...preparation(), grant: at("owner-grant:g1") };
  assert.equal(referenceSites(DISCOVERY_DEEP_PREPARATION_KIND, smuggled).length, 4, "a Ref-like value outside the declared paths is not a reference");
});

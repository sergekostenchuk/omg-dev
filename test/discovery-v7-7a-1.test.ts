import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Discovery, type DiscoveryDraft, type FieldSpec, type Question } from "../src/discovery/discovery.js";
import type { Revision } from "../src/storage/store.js";
import { checkV7FieldAnswer, createPartialV7Draft, v7FinalState, V7_CONTRACT_ERA, V7_FINAL_FIELD,
  V7_REQUIREMENTS } from "../src/discovery/v7-contracts.js";
import { checkV7Final, V7_FINAL_CONTRACT, V7_FINAL_SCHEMA } from "../src/discovery/v7-final-contracts.js";
import { NEXT_CONTRACT_ERA, producerRequirements } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { canonical, type Json } from "../src/canonical.js";
import { Store } from "../src/storage/store.js";

// DR7 7a.1 (codex-omg №9189, раздел DR7): the structural form of the D7 bundle.
// Structural only — no paid, accepted or authority proof; the bundles below are
// in-memory inputs of the pure form checks, never saved as records. The initial
// draft comes from its real producer (Discovery via createPartialV7Draft).

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-7a1-"));
  const store = new Store(join(root, "state.sqlite")), discovery = new Discovery(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, discovery };
}
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
const schema = new Ajv({ strict: true, allowUnionTypes: true }).compile(V7_FINAL_SCHEMA as object);

const dossier = { id: "discovery-dossier:example", revision: 1, hash: "a".repeat(64) };
const positive = (outcome: "go" | "conditional", conditions: Json[] = []): Record<string, any> => ({
  contract: V7_FINAL_CONTRACT, dossier,
  verdict: { outcome, reason: "The researched variant holds within its constraints", conditions },
  summary: { what: "A shared materials ledger", forWhom: "Site foremen and the supply office",
    why: "Orders are lost between sites", firstResult: "One site orders through the ledger",
    successCriterion: "No lost order in a month", nonGoals: ["Payroll"] },
  projection: { users: ["Site foreman"], payers: ["Construction company"], rules: ["Procurement policy"],
    externalSystems: ["Accounting system"], unresolved: ["Supplier API access"] },
  constitution: { goal: "Orders reach suppliers without loss", consumers: ["Site foremen"],
    nonGoals: ["Payroll"], successCriterion: "No lost order in a month" } });
const negative = (outcome: "no_go" | "insufficient_evidence"): Record<string, any> => ({
  contract: V7_FINAL_CONTRACT, dossier,
  verdict: { outcome, reason: "Every variant was rejected on its researched constraints", conditions: [] },
  summary: { reasons: ["The regulation forbids the required data transfer"], found: ["Two incumbent products"],
    needed: ["A regional legal opinion"] },
  projection: null, constitution: null });
const evidence = { id: "c-1", kind: "evidence", condition: "The supplier API is available", criterion: "A signed access agreement" };

test("7a.1 the form tells a positive bundle from a negative one: go and conditional carry summary, projection and constitution; no_go and insufficient_evidence carry reasons with lawful null projection and constitution", () => {
  for (const bundle of [positive("go"), positive("conditional", [evidence]), negative("no_go"), negative("insufficient_evidence")]) {
    assert.equal(schema(bundle), true, `${bundle.verdict.outcome}: ${JSON.stringify(schema.errors)}`);
    assert.deepEqual(checkV7Final(bundle), JSON.parse(canonical(bundle as Json)), bundle.verdict.outcome);
  }
  const rejected = checkV7Final(negative("no_go"));
  assert.equal(rejected.projection, null, "a rejected project has no product image");
  assert.equal(rejected.constitution, null, "and no constitution");
});

test("7a.1 a negative bundle has no fabricated answers: a filled-in projection or constitution, a positive summary or conditions are refused, and a missing key is an absence, not a lawful null", () => {
  const cases: [string, (bundle: Record<string, any>) => void, string][] = [
    ["projection filled in", bundle => { bundle.projection = positive("go").projection; }, "final.projection"],
    ["constitution filled in", bundle => { bundle.constitution = positive("go").constitution; }, "final.constitution"],
    ["positive summary", bundle => { bundle.summary = positive("go").summary; }, "final.summary.reasons"],
    ["conditions", bundle => { bundle.verdict.conditions = [evidence]; }, "final.verdict.conditions"],
    ["missing projection", bundle => { delete bundle.projection; }, "final.projection"],
    ["missing constitution", bundle => { delete bundle.constitution; }, "final.constitution"],
    ["no reasons", bundle => { bundle.summary.reasons = []; }, "final.summary.reasons"]];
  for (const outcome of ["no_go", "insufficient_evidence"] as const)
    for (const [name, damage, at] of cases) {
      const bundle = negative(outcome); damage(bundle);
      assert.equal(code(() => checkV7Final(bundle)), "answer_invalid", `${outcome}: ${name}`);
      assert.equal(field(() => checkV7Final(bundle)), at, `${outcome}: ${name} is refused at its field`);
      assert.equal(schema(bundle), false, `${outcome}: ${name} fails the schema too`);
    }
});

test("7a.1 a positive bundle carries its own parts: null projection or constitution, a negative summary, conditions of go, a conditional without conditions and duplicate condition ids are refused", () => {
  const cases: [string, () => Record<string, any>, string][] = [
    ["null projection", () => ({ ...positive("go"), projection: null }), "final.projection"],
    ["null constitution", () => ({ ...positive("go"), constitution: null }), "final.constitution"],
    ["negative summary", () => ({ ...positive("go"), summary: negative("no_go").summary }), "final.summary.what"],
    ["go with a condition", () => positive("go", [evidence]), "final.verdict.conditions"],
    ["conditional without conditions", () => positive("conditional"), "final.verdict.conditions"],
    ["duplicate condition ids", () => positive("conditional", [evidence, evidence]), "final.verdict.conditions"],
    ["no users", () => ({ ...positive("go"), projection: { ...positive("go").projection, users: [] } }), "final.projection.users"],
    ["no non-goals", () => ({ ...positive("go"), constitution: { ...positive("go").constitution, nonGoals: [] } }),
      "final.constitution.nonGoals"]];
  for (const [name, make, at] of cases) {
    assert.equal(code(() => checkV7Final(make())), "answer_invalid", name);
    assert.equal(field(() => checkV7Final(make())), at, `${name} is refused at its field`);
    // Unique condition ids are a code check; every other rule is the schema's too.
    if (name !== "duplicate condition ids") assert.equal(schema(make()), false, `${name} fails the schema too`);
  }
  // A condition outside the v6 forms is refused by the same rule set.
  assert.equal(code(() => checkV7Final(positive("conditional", [{ id: "c-1", kind: "wish", condition: "x", criterion: "y" }]))),
    "answer_invalid");
});

test("7a.1 an unknown version, outcome or field and a non-object are typed refusals — never read as the known form", () => {
  const cases: [string, unknown, string][] = [
    ["older contract", { ...negative("no_go"), contract: "discovery-final/v6" }, "final.contract"],
    ["newer contract", { ...negative("no_go"), contract: "discovery-final/v8" }, "final.contract"],
    ["missing contract", (({ contract: _contract, ...rest }) => rest)(negative("no_go")), "final.contract"],
    ["unknown outcome", { ...negative("no_go"), verdict: { ...negative("no_go").verdict, outcome: "maybe" } }, "final.verdict.outcome"],
    ["extra field", { ...positive("go"), accepted: true }, "final.accepted"],
    ["dossier not a Ref", { ...positive("go"), dossier: "the dossier" }, "final.dossier"],
    ["missing dossier", (({ dossier: _dossier, ...rest }) => rest)(positive("go")), "final.dossier"],
    ["null", null, "final"], ["array", [], "final"]];
  for (const [name, value, at] of cases) {
    assert.equal(code(() => checkV7Final(value)), "answer_invalid", name);
    assert.equal(field(() => checkV7Final(value)), at, `${name} is refused at its field`);
  }
  // A Ref-shaped dossier whose hash is not a hash fails the same rule set.
  assert.equal(code(() => checkV7Final({ ...positive("go"), dossier: { ...dossier, hash: "not-a-hash" } })), "answer_invalid");
});

test("7a.1 the initial D1/D2 draft is not an incomplete D7: it keeps exactly D1–D2 with no D7 question, its D7 state is absent, the D7 contract is declared beside the slice, and production stays closed", t => {
  const { store, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p-initial", "concept");
  const specs = draft.value.questions.map(id => store.get<Question>(id)!.value.spec);
  assert.equal(canonical(specs), canonical([...V7_REQUIREMENTS.fields.discovery!]), "the initial slice is unchanged");
  assert.deepEqual(specs.map(spec => spec.field), ["brief", "objective", "frame", "plan"]);
  assert.equal(Object.hasOwn(draft.value.fields, "final"), false, "no D7 field in the initial draft");
  assert.deepEqual(v7FinalState(store, draft), { state: "absent" }, "no D7 has begun — nothing is incomplete");
  assert.deepEqual(V7_REQUIREMENTS.final, V7_FINAL_FIELD, "the D7 contract is declared beside the initial slice");
  assert.equal(V7_REQUIREMENTS.complete.discovery, false);
  assert.equal(code(() => producerRequirements("discovery", { discovery: NEXT_CONTRACT_ERA })), "discovery_v7_producer_not_ready",
    "declaring D7 does not open the v7 producer");
});

test("7a.1 a draft with the D7 question reads open until answered and present with its proven form; a saved value that fails the form is a typed refusal, and the field check refuses it before acceptance", t => {
  const { store, discovery } = fixture(t);
  // The real producer accepts the D7 FieldSpec beside D1–D2 (its schema compiles under Discovery's validator).
  const draft = discovery.create("p-final", "discovery", "R0", "concept",
    [...V7_REQUIREMENTS.fields.discovery!, V7_FINAL_FIELD] as unknown as FieldSpec[], [], V7_CONTRACT_ERA);
  const finalQuestion = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === "final")!;
  assert.deepEqual(finalQuestion.value.spec, V7_FINAL_FIELD);
  assert.deepEqual(v7FinalState(store, draft), { state: "open" }, "asked and not yet answered");
  // In-memory draft values over the real question records (no write).
  const withFinal = (value: unknown): Revision<DiscoveryDraft> =>
    ({ ...draft, value: { ...draft.value, fields: { ...draft.value.fields, final: value as Json } } });
  assert.deepEqual(v7FinalState(store, withFinal(negative("no_go"))),
    { state: "present", bundle: JSON.parse(canonical(negative("no_go") as Json)) });
  assert.equal(v7FinalState(store, withFinal(positive("go"))).state, "present");
  const damaged = { ...negative("no_go"), projection: positive("go").projection };
  assert.equal(code(() => v7FinalState(store, withFinal(damaged))), "discovery_final_invalid", "a damaged saved bundle is never read as open or absent");
  assert.equal(code(() => v7FinalState(store, withFinal({ ...negative("no_go"), contract: "discovery-final/v9" }))), "discovery_final_invalid");
  const prove = () => null;
  assert.equal(code(() => checkV7FieldAnswer(draft.value, V7_FINAL_FIELD, damaged as Json, prove)), "answer_invalid",
    "the field check of an answer refuses a negative bundle with a fabricated projection");
  assert.equal(code(() => checkV7FieldAnswer(draft.value, V7_FINAL_FIELD, negative("insufficient_evidence") as Json, prove)), "no-error");
  // Not a v7 Discovery draft: no D7 state at all.
  assert.equal(code(() => v7FinalState(store, { ...draft, value: { ...draft.value, contractVersion: 6 } })), "discovery_final_invalid");
});

/* ---------- круг 2 (codex-omg №9274): owner-choice options and the D7 declaration ---------- */

const ownerChoice = (options: Json[]): Json => ({ id: "c-owner", kind: "owner_choice", condition: "The owner chooses the pilot region",
  criterion: "A recorded owner choice", options });
const option = (optionId: string, choice: "accept" | "decline"): Json =>
  ({ optionId, label: `Option ${optionId}`, consequences: [`Consequence of ${optionId}`], choice });

test("7a.1-01 an owner condition keeps the v6 rules: distinct stable option ids and both an acceptance and a refusal; a duplicated id or a one-sided choice is refused at its options", () => {
  assert.equal(checkV7Final(positive("conditional", [ownerChoice([option("yes", "accept"), option("no", "decline")])])).verdict.outcome,
    "conditional", "a lawful owner choice");
  for (const [name, options] of [["duplicated option ids", [option("same", "accept"), option("same", "decline")]],
    ["no refusal", [option("yes-1", "accept"), option("yes-2", "accept")]],
    ["no acceptance", [option("no-1", "decline"), option("no-2", "decline")]]] as [string, Json[]][]) {
    const bundle = positive("conditional", [evidence, ownerChoice(options)]);
    assert.equal(code(() => checkV7Final(bundle)), "answer_invalid", name);
    assert.equal(field(() => checkV7Final(bundle)), "final.verdict.conditions.1.options", `${name} is refused at its options`);
  }
});

test("7a.1-02 the D7 state follows the declared D7 question, not the presence of a value: a lost field of a declared question, a field without its question, a question claiming the field with another spec and a lost question record are typed refusals", t => {
  const { store, discovery } = fixture(t);
  const full = discovery.create("p-declared", "discovery", "R0", "concept",
    [...V7_REQUIREMENTS.fields.discovery!, V7_FINAL_FIELD] as unknown as FieldSpec[], [], V7_CONTRACT_ERA);
  const initial = createPartialV7Draft(discovery, "p-initial", "concept");
  assert.deepEqual(v7FinalState(store, full), { state: "open" });
  assert.deepEqual(v7FinalState(store, initial), { state: "absent" });
  const { final: _final, ...withoutFinal } = full.value.fields;
  const lost: Revision<DiscoveryDraft> = { ...full, value: { ...full.value, fields: withoutFinal } };
  assert.equal(code(() => v7FinalState(store, lost)), "discovery_final_invalid", "a declared D7 question without its field");
  const undeclared: Revision<DiscoveryDraft> = { ...initial, value: { ...initial.value, fields: { ...initial.value.fields, final: null } } };
  assert.equal(code(() => v7FinalState(store, undeclared)), "discovery_final_invalid", "a D7 field without its declared question");
  // A question that claims the D7 field with another spec is not the D7 declaration.
  const forgedSpec = discovery.create("p-forged", "discovery", "R0", "concept",
    [...V7_REQUIREMENTS.fields.discovery!, { ...V7_FINAL_FIELD, schema: { type: "object" } }] as unknown as FieldSpec[], [], V7_CONTRACT_ERA);
  assert.equal(code(() => v7FinalState(store, forgedSpec)), "discovery_final_invalid");
  // A lost question record is no declaration either way.
  const lostQuestion: Revision<DiscoveryDraft> = { ...full, value: { ...full.value, questions: [...full.value.questions, "question:p-declared:lost"] } };
  assert.equal(code(() => v7FinalState(store, lostQuestion)), "discovery_final_invalid");
});

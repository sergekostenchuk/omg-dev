import { Ajv } from "ajv";
import { EngineError } from "../errors.js";
import { canonical, HASH_PATTERN, type Json } from "../canonical.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import { discoveryVerdictSchema } from "./preparation-contracts.js";

/** DR7 7a.1 (codex-omg №9189, раздел DR7): the structural form of the Discovery
 * v7 D7 bundle — итог, проекция, конституция и вердикт — accepted later as one
 * exact bundle (7b), never field by field. Structural only: no paid, accepted or
 * authority proof is claimed here; the producer (7a.2), the assessment (7a.3/4)
 * and the manifest (7b) prove where a bundle comes from.
 *
 * The form tells a positive bundle from a negative one by its verdict:
 * - positive (go, conditional): a summary of what is built, for whom, why, the
 *   first result, the success criterion and non-goals; the projection of the
 *   chosen product for the next stages; the constitution the keeper holds;
 * - negative (no_go, insufficient_evidence; rejected variants are a no_go):
 *   the reasons, what was found and what is needed — and the lawful nulls of
 *   projection and constitution, present as null: no product image and no
 *   constitution exist for a rejected project, so nothing is filled in to look
 *   like an answer, and a missing key is an absence, not a lawful null. */
export const V7_FINAL_CONTRACT = "discovery-final/v7" as const;
/** The same four outcomes as the v6 verdict (preparation-contracts discoveryVerdictSchema). */
export const V7_FINAL_POSITIVE_OUTCOMES = Object.freeze(["go", "conditional"] as const);
export const V7_FINAL_NEGATIVE_OUTCOMES = Object.freeze(["no_go", "insufficient_evidence"] as const);
export type V7FinalPositiveOutcome = typeof V7_FINAL_POSITIVE_OUTCOMES[number];
export type V7FinalNegativeOutcome = typeof V7_FINAL_NEGATIVE_OUTCOMES[number];

const text: Json = { type: "string", minLength: 1 };
const texts = (minimum = 0): Json => ({ type: "array", minItems: minimum, items: text });
const object = (properties: Record<string, Json>): Json => ({
  type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const refSchema: Json = object({ id: text, revision: { type: "integer", minimum: 1 },
  hash: { type: "string", pattern: HASH_PATTERN } });
/** The condition forms of the v6 verdict, unchanged: evidence or owner_choice. */
const conditionSchema = (discoveryVerdictSchema as { properties: { conditions: { items: Json } } })
  .properties.conditions.items;

export const V7_FINAL_POSITIVE_SUMMARY_SCHEMA: Json = object({
  what: text, forWhom: text, why: text, firstResult: text, successCriterion: text, nonGoals: texts(1) });
export const V7_FINAL_NEGATIVE_SUMMARY_SCHEMA: Json = object({ reasons: texts(1), found: texts(), needed: texts() });
export const V7_FINAL_PROJECTION_SCHEMA: Json = object({
  users: texts(1), payers: texts(), rules: texts(), externalSystems: texts(), unresolved: texts() });
export const V7_FINAL_CONSTITUTION_SCHEMA: Json = object({
  goal: text, consumers: texts(1), nonGoals: texts(1), successCriterion: text });
const verdictSchema = (outcomes: readonly string[], conditions: Json): Json =>
  object({ outcome: { enum: [...outcomes] }, reason: text, conditions });

const positiveBundle = (outcome: V7FinalPositiveOutcome, conditions: Json, contract: string = V7_FINAL_CONTRACT): Json => object({
  contract: { const: contract }, dossier: refSchema, verdict: verdictSchema([outcome], conditions),
  summary: V7_FINAL_POSITIVE_SUMMARY_SCHEMA, projection: V7_FINAL_PROJECTION_SCHEMA,
  constitution: V7_FINAL_CONSTITUTION_SCHEMA });

/** The JSON schema of the D7 field: exactly one of the bundles — go has no
 * conditions, conditional keeps at least one, a negative bundle has none and
 * its lawful null projection and constitution. Unique condition ids are a code check. */
export const V7_FINAL_SCHEMA: Json = { oneOf: [
  positiveBundle("go", { type: "array", maxItems: 0 }),
  positiveBundle("conditional", { type: "array", minItems: 1, items: conditionSchema }),
  object({ contract: { const: V7_FINAL_CONTRACT }, dossier: refSchema,
    verdict: verdictSchema(V7_FINAL_NEGATIVE_OUTCOMES, { type: "array", maxItems: 0 }),
    summary: V7_FINAL_NEGATIVE_SUMMARY_SCHEMA, projection: { type: "null" }, constitution: { type: "null" } }),
] };

/** DR7 7b.3-class (codex-omg2 №16183): the next, explicitly versioned D7 form. It differs from discovery-final/v7 only
 * in the owner_choice condition, which must carry its class and the model's reason for it: choice — a choice inside the
 * already defined bundle; boundary — the choice changes the bounds, the constitution or the projection; risk — the
 * choice takes on a new risk. Only a choice may later be resolved inside the accepted bundle; boundary and risk need a
 * new D7. discovery-final/v7 stays its own historical contract: no class is added to it, and a missing class is never
 * read as a choice. The version of a bundle is fixed by its saved preparation, never by a model answer. */
export const V8_FINAL_CONTRACT = "discovery-final/v8" as const;
export const FINAL_BUNDLE_CONTRACTS = Object.freeze([V7_FINAL_CONTRACT, V8_FINAL_CONTRACT] as const);
export type FinalBundleContract = typeof FINAL_BUNDLE_CONTRACTS[number];
export const FINAL_CONDITION_CLASSES = Object.freeze(["choice", "boundary", "risk"] as const);
export type FinalConditionClass = typeof FINAL_CONDITION_CLASSES[number];
const [evidenceSchema, ownerChoiceSchema] = (conditionSchema as { oneOf: [Json, { required: string[]; properties: Record<string, Json> }] }).oneOf;
const classedOwnerChoiceSchema: Json = { ...ownerChoiceSchema, required: [...ownerChoiceSchema.required, "class", "classReason"],
  properties: { ...ownerChoiceSchema.properties,
    class: { enum: [...FINAL_CONDITION_CLASSES], description: "choice — выбор внутри уже определённого комплекта: границы, конституция и проекция не меняются, новый риск не принимается; boundary — любой вариант меняет границы, конституцию или проекцию комплекта; risk — вариант принимает новый риск. При сомнении это не choice." },
    classReason: { type: "string", minLength: 1, description: "Обоснование класса по точному условию и последствиям каждого варианта." } } };
/** The JSON schema of the classed D7 form: the same bundles, with the classed owner_choice. */
export const V8_FINAL_SCHEMA: Json = { oneOf: [
  positiveBundle("go", { type: "array", maxItems: 0 }, V8_FINAL_CONTRACT),
  positiveBundle("conditional", { type: "array", minItems: 1, items: { oneOf: [evidenceSchema, classedOwnerChoiceSchema] } }, V8_FINAL_CONTRACT),
  object({ contract: { const: V8_FINAL_CONTRACT }, dossier: refSchema,
    verdict: verdictSchema(V7_FINAL_NEGATIVE_OUTCOMES, { type: "array", maxItems: 0 }),
    summary: V7_FINAL_NEGATIVE_SUMMARY_SCHEMA, projection: { type: "null" }, constitution: { type: "null" } }),
] };
/** The schema of one D7 form version. */
export function finalBundleSchema(contract: FinalBundleContract): Json {
  return contract === V8_FINAL_CONTRACT ? V8_FINAL_SCHEMA : V7_FINAL_SCHEMA;
}

// The same validator options as Discovery's field schemas: one rule set for the schema and the code check.
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
const validators = { [V7_FINAL_CONTRACT]: ajv.compile(V7_FINAL_SCHEMA as object), [V8_FINAL_CONTRACT]: ajv.compile(V8_FINAL_SCHEMA as object) };

export interface V7FinalVerdict<O extends string> { outcome: O; reason: string; conditions: Json[] }
export interface V7FinalPositiveBundle {
  contract: FinalBundleContract; dossier: Ref; verdict: V7FinalVerdict<V7FinalPositiveOutcome>;
  summary: { what: string; forWhom: string; why: string; firstResult: string; successCriterion: string; nonGoals: string[] };
  projection: { users: string[]; payers: string[]; rules: string[]; externalSystems: string[]; unresolved: string[] };
  constitution: { goal: string; consumers: string[]; nonGoals: string[]; successCriterion: string };
}
export interface V7FinalNegativeBundle {
  contract: FinalBundleContract; dossier: Ref; verdict: V7FinalVerdict<V7FinalNegativeOutcome>;
  summary: { reasons: string[]; found: string[]; needed: string[] };
  projection: null; constitution: null;
}
export type V7FinalBundle = V7FinalPositiveBundle | V7FinalNegativeBundle;

const obj = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// A function declaration — const arrow `never` loses narrowing under this compiler.
function refuse(rule: string, reason: string): never {
  throw new EngineError("answer_invalid", `[${rule}] ${reason}`, { field: rule, reason });
}
/** Exactly these keys: a missing key is an absence, an extra one is no part of the form. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[], rule: string): void {
  for (const key of keys) if (!Object.hasOwn(value, key)) refuse(`${rule}.${key}`, "the field is part of the form and is missing");
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse(`${rule}.${key}`, "the field is not part of the form");
}
function textList(value: unknown, rule: string, minimum: number): void {
  if (!Array.isArray(value) || value.length < minimum || !value.every(nonempty))
    refuse(rule, minimum > 0 ? "a nonempty list of nonempty texts is required" : "a list of nonempty texts is required");
}
function textFields(value: Record<string, unknown>, rule: string, required: Record<string, number>, single: readonly string[]): void {
  exactKeys(value, [...single, ...Object.keys(required)], rule);
  for (const key of single) if (!nonempty(value[key])) refuse(`${rule}.${key}`, "a nonempty text is required");
  for (const [key, minimum] of Object.entries(required)) textList(value[key], `${rule}.${key}`, minimum);
}

/** The code checks of the D7 form — the same rules as V7_FINAL_SCHEMA, stated
 * with addressed refusals. The verdict alone selects the bundle; its summary,
 * projection and constitution must be that bundle's own forms. Only discovery-final/v7. */
export function checkV7Final(value: unknown): V7FinalBundle {
  return checkFinalBundle(value, V7_FINAL_CONTRACT);
}
/** The code checks of one D7 form version. With `expected`, the bundle must be exactly that version — the version of
 * its saved preparation; without it, a historical bundle is read by its own known version. An unknown version, and in
 * discovery-final/v8 an owner_choice without a known class or its reason, is an addressed refusal. */
export function checkFinalBundle(value: unknown, expected?: FinalBundleContract): V7FinalBundle {
  if (!obj(value)) refuse("final", "the D7 bundle is an object");
  const contract = value["contract"];
  if (expected !== undefined ? contract !== expected : !(FINAL_BUNDLE_CONTRACTS as readonly unknown[]).includes(contract))
    refuse("final.contract", expected !== undefined ? `only ${expected} is a known D7 form; another version is never read as this one`
      : `the D7 form version ${JSON.stringify(contract ?? null)} is unknown`);
  const classed = contract === V8_FINAL_CONTRACT;
  exactKeys(value, ["contract", "dossier", "verdict", "summary", "projection", "constitution"], "final");
  if (!isRef(value["dossier"])) refuse("final.dossier", "the bundle names the exact Ref of its dossier snapshot");
  const verdict = value["verdict"];
  if (!obj(verdict)) refuse("final.verdict", "the verdict is an object");
  exactKeys(verdict, ["outcome", "reason", "conditions"], "final.verdict");
  const outcome = verdict["outcome"];
  const positive = (V7_FINAL_POSITIVE_OUTCOMES as readonly unknown[]).includes(outcome);
  if (!positive && !(V7_FINAL_NEGATIVE_OUTCOMES as readonly unknown[]).includes(outcome))
    refuse("final.verdict.outcome", "the outcome is go, conditional, no_go or insufficient_evidence");
  if (!nonempty(verdict["reason"])) refuse("final.verdict.reason", "the verdict states its reason");
  const conditions = verdict["conditions"];
  if (!Array.isArray(conditions) || !conditions.every(obj)) refuse("final.verdict.conditions", "the conditions are a list of objects");
  if (outcome === "go" && conditions.length) refuse("final.verdict.conditions", "a go verdict has no conditions");
  if (outcome === "conditional" && !conditions.length) refuse("final.verdict.conditions", "a conditional verdict keeps its conditions");
  if (!positive && conditions.length) refuse("final.verdict.conditions", "a negative bundle has no conditions to fulfil");
  const ids = conditions.map(condition => (condition as Record<string, unknown>)["id"]);
  if (!ids.every(nonempty) || new Set(ids).size !== ids.length)
    refuse("final.verdict.conditions", "every condition has its own unique id");
  // 7a.1-01: the owner-choice rules of the v6 verdict (discovery-outcome.ts) — distinct
  // stable options, among them an acceptance and a refusal; an ambiguous or one-sided choice is refused.
  conditions.forEach((condition, index) => {
    const entry = condition as Record<string, unknown>;
    if (entry["kind"] !== "owner_choice") return;
    const options = entry["options"];
    const rule = `final.verdict.conditions.${index}.options`;
    if (!Array.isArray(options) || !options.every(obj)) refuse(rule, "an owner condition lists its options");
    const optionIds = options.map(option => (option as Record<string, unknown>)["optionId"]);
    if (!optionIds.every(nonempty) || new Set(optionIds).size !== optionIds.length)
      refuse(rule, "an owner condition needs distinct stable option ids");
    for (const choice of ["accept", "decline"])
      if (!options.some(option => (option as Record<string, unknown>)["choice"] === choice))
        refuse(rule, `an owner condition offers both acceptance and refusal; the ${choice} option is missing`);
    // 7b.3-class: the classed form states the class of every owner condition and the model's reason for it.
    if (classed) {
      const at = `final.verdict.conditions.${index}`;
      if (!(FINAL_CONDITION_CLASSES as readonly unknown[]).includes(entry["class"]))
        refuse(`${at}.class`, `an owner condition of ${V8_FINAL_CONTRACT} has the class choice, boundary or risk`);
      if (!nonempty(entry["classReason"])) refuse(`${at}.classReason`, "the class of an owner condition states its reason");
    }
  });
  const summary = value["summary"];
  if (!obj(summary)) refuse("final.summary", "the summary is an object");
  if (positive) {
    textFields(summary, "final.summary", { nonGoals: 1 }, ["what", "forWhom", "why", "firstResult", "successCriterion"]);
    const projection = value["projection"], constitution = value["constitution"];
    if (!obj(projection)) refuse("final.projection", "a positive bundle carries the projection of the chosen product");
    textFields(projection, "final.projection", { users: 1, payers: 0, rules: 0, externalSystems: 0, unresolved: 0 }, []);
    if (!obj(constitution)) refuse("final.constitution", "a positive bundle carries the constitution the keeper holds");
    textFields(constitution, "final.constitution", { consumers: 1, nonGoals: 1 }, ["goal", "successCriterion"]);
  } else {
    textFields(summary, "final.summary", { reasons: 1, found: 0, needed: 0 }, []);
    // The lawful nulls of a negative bundle: no product image and no constitution exist.
    if (value["projection"] !== null) refuse("final.projection", "a negative bundle has no projection: it is null, not filled in");
    if (value["constitution"] !== null) refuse("final.constitution", "a negative bundle has no constitution: it is null, not filled in");
  }
  // The schema is the same rule set, also for the condition forms and the exact Ref shape.
  const validate = validators[contract as FinalBundleContract];
  if (!validate(value)) refuse("final", `the bundle does not match the D7 form: ${JSON.stringify(validate.errors?.[0] ?? null)}`);
  return JSON.parse(canonical(value as Json)) as V7FinalBundle;
}

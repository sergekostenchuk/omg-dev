import { EngineError } from "../errors.js";
import { canonical, HASH_PATTERN, type Json } from "../canonical.js";
import { JOURNEY_VARIANTS, QUESTION_MOMENTS } from "./preparation-contracts.js";

/** OMG-V7-A1 (codex-omg2 №16384, map ndisc.d7.n7, #nd-handoff «Договор проекции», ND-02): the full structural
 * projection of the chosen product, produced by the D7 model in the form discovery-final/v9 and accepted with the whole
 * bundle. It is the preparation form of the existing consumers made addressable: actors and outcomes with stable ids,
 * journeys as the object of named paths, constraints with the content and the exact address of their dossier grounds
 * and their scope, external systems with their actor, availability, documents and environment needs, risks with their
 * grounds, consequence, affected outcome and mitigation, and unknowns in the full ND-02 form with their origin.
 *
 * The code checks the form and every link between the ids, and — against the exact proven dossier of the bundle — that
 * each ground is a claim of that dossier quoted verbatim and each unknown origin is an unknown of that dossier or an
 * evidence condition of the bundle. Meaning and completeness are the assessor's. An unknown is never made a fact or an
 * outcome; an address never stands for the content it grounds. */
const text: Json = { type: "string", minLength: 1 };
const texts = (minimum = 0): Json => ({ type: "array", minItems: minimum, items: text });
const list = (items: Json, minimum = 0): Json => ({ type: "array", minItems: minimum, items });
const object = (properties: Record<string, Json>): Json => ({
  type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const exactRef: Json = object({ id: text, revision: { type: "integer", minimum: 1 }, hash: { type: "string", pattern: HASH_PATTERN } });
const claimAddress: Json = object({ project: text, container: exactRef, containerKind: text, pointer: text, claimId: text });
/** A ground: the exact address of a dossier claim and its verbatim content — an address never stands alone. */
const ground: Json = object({ claim: claimAddress, content: text });
const unknownLink: Json = object({ unknown: text });
const scenario: Json = object({ actor: text, outcome: text, entry: text, steps: texts(1), success: texts(1), failure: texts(1), recovery: texts() });
const journey: Json = { oneOf: [
  object({ applicability: { const: "applicable" }, reason: text, scenarios: list(scenario, 1) }),
  object({ applicability: { const: "not_applicable" }, reason: text, scenarios: { type: "array", maxItems: 0 } }),
] };
const nullableText: Json = { oneOf: [text, { type: "null" }] };

export const FINAL_PROJECTION_SCHEMA: Json = object({
  actors: list(object({ id: text, role: text, benefit: text, channels: texts(1) }), 1),
  outcomes: list(object({ id: text, beneficiary: text, result: text, success: texts(1) }), 1),
  journeys: object(Object.fromEntries(JOURNEY_VARIANTS.map(name => [name, journey]))),
  constraints: list(object({ id: text, rule: text, basis: list(ground, 1),
    scope: object({ variant: nullableText, region: nullableText, date: nullableText }) })),
  externalSystems: list(object({ id: text, actor: text, purpose: text, inputs: texts(), outputs: texts(),
    availability: object({ text, basis: { oneOf: [ground, unknownLink] } }), documents: list(ground), environment: texts() })),
  risks: list(object({ id: text, risk: text, basis: list(ground, 1), consequence: text,
    affectedOutcome: { oneOf: [object({ outcome: text }), unknownLink] },
    mitigation: { oneOf: [object({ text }), unknownLink] } })),
  unknowns: list(object({ id: text, origin: { oneOf: [object({ claim: claimAddress }), object({ condition: text })] },
    question: text, affects: texts(1), consumer: text, blocksCurrentStage: { type: "boolean" },
    moment: { enum: [...QUESTION_MOMENTS] }, closeCriterion: text })),
});

/** The exact address of a dossier claim (ClaimAddress) with its verbatim content. */
export interface FinalProjectionGround { claim: { project: string; container: { id: string; revision: number; hash: string };
  containerKind: string; pointer: string; claimId: string }; content: string }
export interface FinalProjectionScenario { actor: string; outcome: string; entry: string; steps: string[]; success: string[]; failure: string[]; recovery: string[] }
export interface FinalProductProjection {
  actors: { id: string; role: string; benefit: string; channels: string[] }[];
  outcomes: { id: string; beneficiary: string; result: string; success: string[] }[];
  journeys: Record<typeof JOURNEY_VARIANTS[number], { applicability: 'applicable' | 'not_applicable'; reason: string; scenarios: FinalProjectionScenario[] }>;
  constraints: { id: string; rule: string; basis: FinalProjectionGround[]; scope: { variant: string | null; region: string | null; date: string | null } }[];
  externalSystems: { id: string; actor: string; purpose: string; inputs: string[]; outputs: string[];
    availability: { text: string; basis: FinalProjectionGround | { unknown: string } }; documents: FinalProjectionGround[]; environment: string[] }[];
  risks: { id: string; risk: string; basis: FinalProjectionGround[]; consequence: string;
    affectedOutcome: { outcome: string } | { unknown: string }; mitigation: { text: string } | { unknown: string } }[];
  unknowns: { id: string; origin: { claim: FinalProjectionGround['claim'] } | { condition: string }; question: string; affects: string[];
    consumer: string; blocksCurrentStage: boolean; moment: typeof QUESTION_MOMENTS[number]; closeCriterion: string }[];
}
type Obj = Record<string, unknown>;
const obj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
function refuse(rule: string, reason: string): never {
  throw new EngineError("answer_invalid", `[${rule}] ${reason}`, { field: rule, reason });
}
/** Ids unique inside their list; every link names an existing id of its kind. */
export function checkFinalProjectionLinks(projection: Obj, rule = "final.projection"): void {
  const ids = (key: string) => {
    const values = (projection[key] as Obj[]).map(item => item.id as string);
    if (new Set(values).size !== values.length) refuse(`${rule}.${key}`, "every entry has its own unique id");
    return new Set(values);
  };
  const actors = ids("actors"), outcomes = ids("outcomes"), unknowns = ids("unknowns");
  ids("constraints"); ids("externalSystems"); ids("risks");
  const link = (set: Set<string>, value: unknown, at: string, kind: string) => {
    if (typeof value !== "string" || !set.has(value)) refuse(at, `the ${kind} ${JSON.stringify(value)} is no ${kind} of this projection`);
  };
  (projection.outcomes as Obj[]).forEach((item, i) => link(actors, item.beneficiary, `${rule}.outcomes.${i}.beneficiary`, "actor"));
  for (const [name, path] of Object.entries(projection.journeys as Record<string, Obj>))
    (path.scenarios as Obj[]).forEach((item, i) => {
      link(actors, item.actor, `${rule}.journeys.${name}.scenarios.${i}.actor`, "actor");
      link(outcomes, item.outcome, `${rule}.journeys.${name}.scenarios.${i}.outcome`, "outcome");
    });
  (projection.externalSystems as Obj[]).forEach((item, i) => {
    link(actors, item.actor, `${rule}.externalSystems.${i}.actor`, "actor");
    const basis = (item.availability as Obj).basis as Obj;
    if (Object.hasOwn(basis, "unknown")) link(unknowns, basis.unknown, `${rule}.externalSystems.${i}.availability.basis.unknown`, "unknown");
  });
  (projection.risks as Obj[]).forEach((item, i) => {
    const affected = item.affectedOutcome as Obj, mitigation = item.mitigation as Obj;
    if (Object.hasOwn(affected, "outcome")) link(outcomes, affected.outcome, `${rule}.risks.${i}.affectedOutcome.outcome`, "outcome");
    else link(unknowns, affected.unknown, `${rule}.risks.${i}.affectedOutcome.unknown`, "unknown");
    if (Object.hasOwn(mitigation, "unknown")) link(unknowns, mitigation.unknown, `${rule}.risks.${i}.mitigation.unknown`, "unknown");
  });
  (projection.unknowns as Obj[]).forEach((item, i) =>
    (item.affects as unknown[]).forEach((value, j) => link(outcomes, value, `${rule}.unknowns.${i}.affects.${j}`, "outcome")));
}

/** The grounds of the dossier a projection may cite: its claims with their verbatim texts and its unknown claims. */
export interface FinalProjectionDossier {
  materials: { address: unknown; value: unknown }[];
  unknowns: { unknown: { claim: unknown } }[];
}
/** Every ground is a claim of the exact proven dossier, quoted verbatim; every unknown origin is an unknown of that
 * dossier or an evidence condition of the bundle. */
export function checkFinalProjectionGrounds(projection: Obj, conditions: readonly Obj[], dossier: FinalProjectionDossier,
  rule = "final.projection"): void {
  const claims = new Map(dossier.materials.map(material => [canonical(material.address as Json),
    obj(material.value) ? material.value.text : undefined]));
  const dossierUnknowns = new Set(dossier.unknowns.map(row => canonical(row.unknown.claim as Json)));
  const evidence = new Set(conditions.filter(condition => condition.kind === "evidence").map(condition => condition.id));
  const grounded = (value: Obj, at: string) => {
    const content = claims.get(canonical(value.claim as Json));
    if (content === undefined) refuse(`${at}.claim`, "the ground is no claim of the exact dossier of this bundle");
    if (content !== value.content) refuse(`${at}.content`, "the ground quotes its dossier claim verbatim");
  };
  (projection.constraints as Obj[]).forEach((item, i) => (item.basis as Obj[]).forEach((value, j) => grounded(value, `${rule}.constraints.${i}.basis.${j}`)));
  (projection.risks as Obj[]).forEach((item, i) => (item.basis as Obj[]).forEach((value, j) => grounded(value, `${rule}.risks.${i}.basis.${j}`)));
  (projection.externalSystems as Obj[]).forEach((item, i) => {
    const basis = (item.availability as Obj).basis as Obj;
    if (Object.hasOwn(basis, "claim")) grounded(basis, `${rule}.externalSystems.${i}.availability.basis`);
    (item.documents as Obj[]).forEach((value, j) => grounded(value, `${rule}.externalSystems.${i}.documents.${j}`));
  });
  (projection.unknowns as Obj[]).forEach((item, i) => {
    const origin = item.origin as Obj, at = `${rule}.unknowns.${i}.origin`;
    if (Object.hasOwn(origin, "claim")) {
      if (!dossierUnknowns.has(canonical(origin.claim as Json))) refuse(`${at}.claim`, "the origin is no unknown of the exact dossier of this bundle");
    } else if (!evidence.has(origin.condition as string)) refuse(`${at}.condition`, "the origin is no evidence condition of this bundle");
  });
}

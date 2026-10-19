import { sealed } from "../om/refusal.js";
import { EngineError } from "../errors.js";
import { canonical, hashJson, HASH_PATTERN, type Json } from "../canonical.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import type { Revision } from "../storage/store.js";
import type { Discovery, DiscoveryDraft, FieldSpec } from "./discovery.js";
import type { IssuedAnswerProof, AnswerProvenance, ResearchProvenance } from "./projection-reader.js";

/** Era-7 contract facts of the new Discovery map (Стадия 1 · Discovery, D1–D2). */
export const V7_CONTRACT_ERA = 7;
export const V7_AXES = Object.freeze(["industry", "as-is", "people", "language", "rules", "market",
  "money", "data", "scale", "risks", "feasibility", "outcome"] as const);
export type V7Axis = typeof V7_AXES[number];
export const V7_DEPTHS = Object.freeze(["deep", "brief", "inapplicable"] as const);
export type V7AxisDepth = typeof V7_DEPTHS[number];
export const V7_PRODUCT_TYPES = Object.freeze(["personal", "internal", "commercial", "public"] as const);
/** P3: tokens, the initial total limit of every paid role of the stage. */
export const V7_STAGE_TOKEN_CEILING = 20_000_000;
const BLOCKING_DEFAULT_AXES: readonly string[] = ["rules", "feasibility"];

/** Producer stages the era-7 table must cover before production may open. */
export const V7_STAGES = Object.freeze(["discovery", "concept", "operation-map", "specification", "features"] as const);
export type V7Stage = typeof V7_STAGES[number];

const text: Json = { type: "string", minLength: 1 };
const texts = (minimum = 0): Json => ({ type: "array", minItems: minimum, items: text });
const object = (properties: Record<string, Json>, optional: readonly string[] = []): Json => ({
  type: "object", additionalProperties: false,
  required: Object.keys(properties).filter(key => !optional.includes(key)), properties,
});
const refSchema: Json = object({ id: text, revision: { type: "integer", minimum: 1 },
  hash: { type: "string", pattern: HASH_PATTERN } });

const axisEntrySchema = object({ depth: { enum: [...V7_DEPTHS] }, reason: text }, ["reason"]);
export const V7_FRAME_SCHEMA: Json = object({
  productType: { enum: [...V7_PRODUCT_TYPES] },
  scale: text,
  industries: texts(1),
  domains: texts(1),
  axes: { type: "object", additionalProperties: false, required: [...V7_AXES],
    properties: Object.fromEntries(V7_AXES.map(axis => [axis, axisEntrySchema])) },
  budget: object({
    ceiling: { const: V7_STAGE_TOKEN_CEILING },
    axisHints: { type: "object", additionalProperties: false,
      properties: Object.fromEntries(V7_AXES.map(axis => [axis, { type: "integer", minimum: 0 }])) },
    completionReserve: { type: "integer", minimum: 0 },
  }),
});

const planQuestionSchema = object({
  id: text, axis: { enum: [...V7_AXES] }, domain: text, text: text,
  class: { enum: ["blocking", "supporting"] }, criterion: text,
  requiredDepth: { enum: ["deep", "brief"] },
  roles: texts(1), searchPlaces: texts(1),
  classRevision: object({ from: { enum: ["blocking", "supporting"] }, basis: text }),
}, ["classRevision"]);
export const V7_PLAN_SCHEMA: Json = object({
  edition: { type: "integer", minimum: 1 },
  frame: refSchema,
  previous: { anyOf: [refSchema, { type: "null" }] },
  questions: { type: "array", minItems: 1, items: planQuestionSchema },
});

// DS2, verbatim from the v6 researchPlan prompt: analogues belong to the plan's search places.
const ANALOGUES_PROMPT = "В план исследования включи проверку того, что уже существует в этой области: аналоги, готовые решения и подходы, которые можно использовать или адаптировать. Выбирай места поиска по домену. Иллюстрации, не исчерпывающий и не обязательный список: для программы — открытые проекты, документация и трекеры; для сайта — победители профессиональных премий текущего и прошлого года и портфолио студий; для исследования — обзоры и свежие работы; для услуги или продукта — конкуренты, цены и отзывы; для мероприятия — прошедшие аналогичные события и отчёты о них. Если домен не похож на эти примеры, определи свои места поиска и объясни выбор. На шаге плана укажи, что и где предстоит проверить; не выдавай запланированный поиск за выполненный. Если при исследовании аналоги не найдены, скажи об этом прямо, укажи границы проведённого поиска и оставшиеся неизвестные; не придумывай примеры, ссылки или доказательство того, что аналогов вообще не существует. Наличие найденного аналога само по себе не является обязательным условием принятия плана или отчёта.";

export const V7_BRIEF_FIELD = { field: "brief", kind: "fact",
  prompt: "Какой исходный текст описывает задачу? Выберите его в источнике.",
  risk: "Нет проверяемого исходного поручения", schema: text } satisfies FieldSpec;
export const V7_OBJECTIVE_FIELD = { field: "objective", kind: "decision",
  prompt: "Какой результат вы хотите получить?",
  risk: "Не выбрана цель продукта", schema: text } satisfies FieldSpec;
export const V7_FRAME_FIELD = { field: "frame", kind: "design", proof: "assessment",
  prompt: "Построй рамку исследования по принятому поручению: productType — масштабный тип продукта (personal — личный, internal — внутренний, commercial — коммерческий, public — публичный); scale — число пользователей, объёмы и ресурсы владельца; industries — отрасль(и); domains — домены и поддомены поручения. В axes задай глубину каждой из 12 осей: deep — исследовать глубоко, brief — кратко, inapplicable — ось неприменима; для inapplicable обязательна предметная reason — «не относится» без обоснования не принимается. В budget: ceiling — исходный общий предел расхода всех оплачиваемых ролей стадии в токенах (20000000); axisHints — рекомендуемое распределение по осям, ориентир, а не жёсткий лимит; completionReserve — резерв на завершающие вызовы стадии. Владельца спрашивают, только когда трактовки расходятся и меняют результат — молча не сужай и не расширяй поручение.",
  risk: "Исследуется не та область реального мира, или поручение молча сужено",
  schema: V7_FRAME_SCHEMA } satisfies FieldSpec;
export const V7_PLAN_FIELD = { field: "plan", kind: "design", proof: "assessment",
  prompt: "Составь план исследования по принятой рамке: questions — вопросы по домену и оси с устойчивыми id. У каждого вопроса: axis — одна из 12 осей рамки; domain; text — формулировка; class — blocking (держит переход к досье) или supporting; criterion — что считать ответом, без критерия исследование выходит по усталости; requiredDepth — deep или brief; roles — роли-перспективы, чьим взглядом проверяется вопрос (отрасль, юрист региона, экономист, пользователи, инженер); searchPlaces — где искать основания. edition — номер редакции, начиная с 1; frame — точный Ref принятого ответа рамки; previous — точный Ref принятой предыдущей редакции плана или null для первой. Новый вопрос получает новый id; id прежнего вопроса нельзя присвоить другому тексту; пересмотр класса существующего вопроса — только с основанием в classRevision. Вопросы по правилам (rules) и реализуемости (feasibility) — блокирующие по умолчанию.\n\n" + ANALOGUES_PROMPT,
  risk: "План не покрывает оси рамки блокирующими вопросами или выходит по усталости",
  schema: V7_PLAN_SCHEMA } satisfies FieldSpec;

const discoveryFields: readonly FieldSpec[] = Object.freeze([
  V7_BRIEF_FIELD, V7_OBJECTIVE_FIELD, V7_FRAME_FIELD, V7_PLAN_FIELD]);

/** The part of the era-7 requirements table written so far — the D1–D2 fields
 * of the discovery stage. D3–D8 fields join with their own packets.
 * Completeness is stated per stage against that stage's own producer
 * contract — Discovery's readiness never depends on other stages moving to
 * v7; the flag flips only when the stage's whole contract is written. The
 * partial table never becomes the acceptance/issuance contract — it is not
 * listed among the supported contract eras. */
const fields: Partial<Record<V7Stage, readonly FieldSpec[]>> = { discovery: discoveryFields };
export const V7_REQUIREMENTS = sealed({ fields,
  complete: { discovery: false } as Partial<Record<V7Stage, boolean>> });
export type V7RequirementsTable = typeof V7_REQUIREMENTS;

/** Test-only entry of DR2: builds a partial v7 draft on the D1–D2 slice via
 * Discovery.create, without touching the producer admission. Era 7 marks the
 * saved draft so its answers are checked by the v7 rules of this module. */
export function createPartialV7Draft(discovery: Discovery, projectId: string, consumer: string,
  inputs: Ref[] = []): Revision<DiscoveryDraft> {
  return discovery.create(projectId, "discovery", "R0", consumer, [...discoveryFields], inputs, V7_CONTRACT_ERA);
}

/** The proof reader of an accepted answer of one field's question in the
 * same draft, injected by the intake so this module never opens a second
 * interpretation of the acceptance chain. It returns the interpreted proof
 * (IssuedAnswerProof) or null when the ref is not the proven accepted answer
 * of that field's question — foreign draft, another question, a record that
 * was never accepted. */
export type FieldAnswerProver = (field: string, ref: Ref) => IssuedAnswerProof | null;

const obj = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// A function declaration — const arrow `never` loses narrowing under this compiler.
function refuse(rule: string, reason: string): never {
  throw new EngineError("answer_invalid", `[${rule}] ${reason}`, { field: rule, reason });
}

/** Code checks of the v7 D1–D2 contract, called by Discovery.#answer for a
 * draft of this era after the JSON schema passed. Presence of a rule's data
 * is checked here; whether a reason or a class is justified stays with the
 * assessor. */
export function checkV7FieldAnswer(draft: DiscoveryDraft, spec: FieldSpec, value: Json,
  prove: FieldAnswerProver): void {
  if (spec.field === V7_FRAME_FIELD.field) return checkV7Frame(value);
  if (spec.field === V7_PLAN_FIELD.field) return checkV7Plan(draft, value, prove);
}

function checkV7Frame(value: Json): void {
  if (!obj(value)) refuse("frame", "the frame is not an object");
  const axes: Record<string, Json> = obj(value["axes"]) ? value["axes"] : {};
  for (const axis of V7_AXES) {
    const entry = axes[axis];
    if (!obj(entry)) refuse(`frame.axes.${axis}`, "every one of the 12 axes is represented");
    if (entry["depth"] === "inapplicable" && !nonempty(entry["reason"]))
      refuse(`frame.axes.${axis}.reason`, "an inapplicable axis needs its subject reason");
  }
  const budget: Record<string, Json> = obj(value["budget"]) ? value["budget"] : {};
  if (budget["ceiling"] !== V7_STAGE_TOKEN_CEILING)
    refuse("frame.budget.ceiling", `the initial stage token ceiling is ${V7_STAGE_TOKEN_CEILING}`);
  if (obj(budget["axisHints"]))
    for (const key of Object.keys(budget["axisHints"]))
      if (!(V7_AXES as readonly string[]).includes(key))
        refuse(`frame.budget.axisHints.${key}`, "axis hints exist only for the 12 axes");
  const reserve = budget["completionReserve"];
  if (reserve !== undefined && (typeof reserve !== "number" || !Number.isSafeInteger(reserve) || reserve < 0))
    refuse("frame.budget.completionReserve", "the completion reserve is a non-negative token count");
}

/** The fields that make a plan question the same question between editions:
 * its subject (axis, domain, text) and its acceptance criterion. Under one
 * id they are immutable — a different question takes a new id; under a new
 * id an unchanged question is a rename and is refused. */
const QUESTION_IDENTITY = ["axis", "domain", "text", "criterion"] as const;

function checkV7Plan(draft: DiscoveryDraft, value: Json, prove: FieldAnswerProver): void {
  if (!obj(value)) refuse("plan", "the plan is not an object");
  const priorField = draft.fields["plan"];
  const prior = obj(priorField) ? priorField : null;
  const priorById = new Map<string, Record<string, Json>>();
  if (prior !== null && Array.isArray(prior["questions"]))
    for (const question of prior["questions"])
      if (obj(question) && nonempty(question["id"])) priorById.set(question["id"], question);

  if (prior === null) {
    if (value["previous"] !== null)
      refuse("plan.previous", "the first plan edition has previous: null");
    if (value["edition"] !== 1)
      refuse("plan.edition", "the first plan edition is numbered 1");
  } else {
    const previous = value["previous"];
    if (!isRef(previous)) refuse("plan.previous", "a next edition names the exact Ref of the accepted previous edition");
    const proven = prove("plan", previous);
    if (proven === null || canonical(proven.value) !== canonical(prior))
      refuse("plan.previous", "the Ref is not the proven accepted plan edition saved in this draft");
    if (value["edition"] !== (prior["edition"] as number) + 1)
      refuse("plan.edition", "a next edition continues the saved edition exactly");
  }

  const frameField = draft.fields["frame"];
  if (!obj(frameField)) refuse("plan.frame", "the plan needs the accepted frame of this draft first");
  const frameRef = value["frame"];
  if (!isRef(frameRef)) refuse("plan.frame", "the plan names the exact Ref of the accepted frame");
  const frameProven = prove("frame", frameRef);
  if (frameProven === null || canonical(frameProven.value) !== canonical(frameField))
    refuse("plan.frame", "the Ref is not the proven accepted frame saved in this draft");

  const questions = Array.isArray(value["questions"]) ? value["questions"].filter(obj) : [];
  const seen = new Set<string>();
  for (const [index, question] of questions.entries()) {
    const at = `plan.questions.${index}`;
    const id = question["id"], axis = question["axis"];
    if (!nonempty(id)) refuse(at, "a plan question needs its stable id");
    if (seen.has(id)) refuse(at, `question id "${id}" is duplicated inside the plan`);
    seen.add(id);
    if (typeof axis !== "string" || !(V7_AXES as readonly string[]).includes(axis))
      refuse(`${at}.axis`, `question "${id}" addresses an axis outside the 12`);
    for (const key of ["domain", "text", "class", "criterion", "requiredDepth"] as const)
      if (!nonempty(question[key])) refuse(`${at}.${key}`, `question "${id}" needs its ${key}`);
    if (!Array.isArray(question["roles"]) || question["roles"].length === 0)
      refuse(`${at}.roles`, `question "${id}" needs its role perspectives`);
    if (!Array.isArray(question["searchPlaces"]) || question["searchPlaces"].length === 0)
      refuse(`${at}.searchPlaces`, `question "${id}" needs its search places`);
    const old = priorById.get(id);
    if (old === undefined) {
      const renamed = [...priorById.entries()]
        .find(([, priorQ]) => QUESTION_IDENTITY.every(key => priorQ[key] === question[key]));
      if (renamed !== undefined)
        refuse(`${at}.id`, `the question of id "${renamed[0]}" is unchanged; it keeps its id, a renamed question is refused`);
      if (BLOCKING_DEFAULT_AXES.includes(axis) && question["class"] !== "blocking")
        refuse(`${at}.class`, `a new ${axis} question is blocking by default; the assessor revises the class`);
    } else {
      for (const key of QUESTION_IDENTITY)
        if (old[key] !== question[key])
          refuse(`${at}.${key}`, `question "${id}" keeps its id but changed its ${key}; a different question takes a new id`);
      if (old["class"] !== question["class"]) {
        const revision = question["classRevision"];
        if (!obj(revision) || revision["from"] !== old["class"] || !nonempty(revision["basis"]))
          refuse(`${at}.classRevision`, `question "${id}" changes its class only with a saved basis`);
      }
    }
  }
}

/** Договор отдельной неизменяемой записи акта принятия Discovery (DR2, №6009/6010). */
export const DISCOVERY_ACCEPTANCE_ACT_KIND = "discovery-acceptance-act";
export const DISCOVERY_ACCEPTANCE_ACT_CONTRACT = "discovery-acceptance-act/v1";

export interface DiscoveryAcceptanceAct {
  contract: "discovery-acceptance-act/v1";
  projectId: string;
  draftId: string;
  field: string;
  draftBefore: Ref;
  draftAfter: Ref;
  questionBefore: Ref;
  questionAfter: Ref;
  answer: Ref;
  assessment: Ref | null;
  binding?: Ref | null;
}

export function discoveryAcceptanceActId(projectId: string, draftId: string, field: string, answer: Ref): string {
  return `${DISCOVERY_ACCEPTANCE_ACT_KIND}:${projectId}:${hashJson({ draftId, field, answer: { id: answer.id, revision: answer.revision, hash: answer.hash } })}`;
}
export const acceptanceActId = discoveryAcceptanceActId;

/* ---------- DR3a1: research attempts (research-attempt / v7-attempt/v1) ---------- */

/** The record contract marking a claims collection: at the body root of a
 * claims-carrying research answer (DR2), and at the submitted end of a
 * research attempt (DR3a1). A marker inside an arbitrary payload does not
 * make a record this contract. */
export const DISCOVERY_CLAIMS_CONTRACT = "discovery-claims/v7";

/** The new base-layer record kind and body contract of one v7 research
 * attempt on a plan-question — an immutable record per (project, accepted
 * plan-question, generating call); its claims live only in the end. */
export const V7_ATTEMPT_KIND = "research-attempt";
export const V7_ATTEMPT_CONTRACT = "v7-attempt/v1";

/** The closed list of refused/impossible end codes — the agreed minimum of
 * the DR3a packet; extending it is a DR3b review decision. */
export const V7_ATTEMPT_END_CODES = Object.freeze(["source_unavailable",
  "outside_plan_scope", "needs_owner_authority"] as const);
export type V7AttemptEndCode = typeof V7_ATTEMPT_END_CODES[number];

/** The discriminated claim kinds of discovery-claims/v7 and the unknown's
 * moment enum. */
export const V7_CLAIM_KINDS = Object.freeze(["fact", "inference", "hypothesis",
  "unknown", "owner-decision"] as const);
export const V7_UNKNOWN_MOMENTS = Object.freeze(["om-pass", "feasibility",
  "task-start", "task-result"] as const);
/** The ClaimAddress pointer shape inside claims — /claims/<index>, no padding. */
export const V7_CLAIM_POINTER = /^\/claims\/(0|[1-9][0-9]*)$/;

const CLAIM_FIELDS: readonly string[] = ["id", "kind", "text", "axis", "planQuestions",
  "scope", "basis", "contradicts", "refutedBy", "supersedes"];
const CLAIM_REQUIRED: readonly string[] = ["id", "kind", "text", "axis", "planQuestions",
  "scope", "basis"];
const CLAIM_ADDRESS_FIELDS: readonly string[] = ["project", "container", "containerKind",
  "pointer", "claimId"];

/** What the claims check needs from the attempt it belongs to. */
export interface V7ClaimsContext {
  /** Every declared Ref and every ClaimAddress names a record of this project. */
  project: string;
  /** The attempt's own plan-question: the exact accepted plan-answer Ref and
   * the stable plan-question id inside it — every claim must serve it. */
  planAnswer: Ref;
  planQuestionId: string;
  /** Existence prover injected by the reader: true when `ref` names a record
   * present at its exact revision and hash and carrying context.project. */
  projectRef: (ref: Ref) => boolean;
}

// A function declaration — const arrow `never` loses narrowing under this compiler.
function attemptRefuse(field: string, reason: string): never {
  throw new EngineError("attempt_invalid", `[${field}] ${reason}`, { field, reason });
}

const exactFields = (value: Record<string, Json>, allowed: readonly string[], at: string) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) attemptRefuse(`${at}.${key}`, "only the contracted fields are carried");
};

/** A ClaimAddress link inside claims: the exact fields, this project, a
 * /claims/<i> pointer and an existing container of this project. */
function checkClaimAddress(value: unknown, context: V7ClaimsContext, at: string): void {
  if (!obj(value)) attemptRefuse(at, "a claim link is a ClaimAddress object");
  exactFields(value, CLAIM_ADDRESS_FIELDS, at);
  if (value["project"] !== context.project)
    attemptRefuse(`${at}.project`, "a link addresses claims of this project");
  if (!isRef(value["container"]) || !context.projectRef(value["container"]))
    attemptRefuse(`${at}.container`, "the addressed container is missing, changed or foreign");
  if (!nonempty(value["containerKind"]))
    attemptRefuse(`${at}.containerKind`, "the link names the container kind");
  if (typeof value["pointer"] !== "string" || !V7_CLAIM_POINTER.test(value["pointer"]))
    attemptRefuse(`${at}.pointer`, "the pointer is /claims/<index>");
  if (!nonempty(value["claimId"])) attemptRefuse(`${at}.claimId`, "the link names the claim id");
}

function checkClaimPlanQuestions(value: unknown, context: V7ClaimsContext, at: string): void {
  if (!Array.isArray(value) || value.length === 0)
    attemptRefuse(`${at}.planQuestions`, "a claim names the plan questions it serves");
  let own = false;
  for (const [index, entry] of value.entries()) {
    const field = `${at}.planQuestions.${index}`;
    if (!obj(entry)) attemptRefuse(field, "a plan-question link is an object");
    exactFields(entry, ["planAnswer", "planQuestionId"], field);
    if (!isRef(entry["planAnswer"]) || !context.projectRef(entry["planAnswer"]))
      attemptRefuse(`${field}.planAnswer`, "the plan answer is missing, changed or foreign");
    if (!nonempty(entry["planQuestionId"]))
      attemptRefuse(`${field}.planQuestionId`, "the link needs its plan-question id");
    if (canonical(entry["planAnswer"]) === canonical(context.planAnswer)
      && entry["planQuestionId"] === context.planQuestionId) own = true;
  }
  if (!own)
    attemptRefuse(`${at}.planQuestions`, "every claim of an attempt serves the attempt's own plan-question");
}

function checkClaimScope(value: unknown, context: V7ClaimsContext, at: string): void {
  if (!obj(value)) attemptRefuse(`${at}.scope`, "a claim needs its scope");
  exactFields(value, ["variants", "region", "asOf"], `${at}.scope`);
  const variants = value["variants"];
  if (variants !== "common") {
    if (!Array.isArray(variants) || variants.length === 0)
      attemptRefuse(`${at}.scope.variants`, "scope is 'common' or a non-empty list of exact variant Refs");
    for (const [index, ref] of variants.entries())
      if (!isRef(ref) || !context.projectRef(ref))
        attemptRefuse(`${at}.scope.variants.${index}`, "a variant names an existing exact Ref of this project");
  }
  for (const key of ["region", "asOf"] as const)
    if (value[key] !== undefined && !nonempty(value[key]))
      attemptRefuse(`${at}.scope.${key}`, `${key} is a non-empty string`);
}

/** The basis form discriminated by the claim kind — the DR2 shape taken over
 * to the attempt: fact's pinned source, inference's proven links, the
 * unknown's full ND-02 form and the owner-decision's saved authority. */
function checkClaimBasis(kind: string, basis: unknown, context: V7ClaimsContext, at: string): void {
  const b = `${at}.basis`;
  if (!obj(basis)) attemptRefuse(b, `a ${kind} claim needs its basis`);
  const projectRef = (ref: unknown, field: string) => {
    if (!isRef(ref) || !context.projectRef(ref))
      attemptRefuse(field, "the exact Ref is missing, changed or foreign");
  };
  switch (kind) {
    case "fact": {
      exactFields(basis, ["source", "limit", "asOf", "apiVersion", "region"], b);
      const source = basis["source"];
      if (!obj(source)) attemptRefuse(`${b}.source`, "a fact names its pinned source");
      exactFields(source, ["ref", "range", "valueHash"], `${b}.source`);
      projectRef(source["ref"], `${b}.source.ref`);
      const range = source["range"];
      if (!obj(range)) attemptRefuse(`${b}.source.range`, "a fact's source names its pinned range");
      exactFields(range, ["start", "end"], `${b}.source.range`);
      if (!Number.isSafeInteger(range["start"]) || (range["start"] as number) < 0
        || !Number.isSafeInteger(range["end"]) || (range["end"] as number) <= (range["start"] as number))
        attemptRefuse(`${b}.source.range`, "a fact's range is whole offsets 0 <= start < end");
      if (typeof source["valueHash"] !== "string" || !new RegExp(HASH_PATTERN).test(source["valueHash"]))
        attemptRefuse(`${b}.source.valueHash`, "a fact's source value is hash-pinned");
      if (!nonempty(basis["limit"])) attemptRefuse(`${b}.limit`, "a fact names its limitation");
      if (!nonempty(basis["asOf"])) attemptRefuse(`${b}.asOf`, "a fact names its as-of date");
      for (const key of ["apiVersion", "region"] as const)
        if (basis[key] !== undefined && !nonempty(basis[key]))
          attemptRefuse(`${b}.${key}`, `${key} is a non-empty string`);
      break;
    }
    case "inference": {
      exactFields(basis, ["from", "reasoning"], b);
      const from = basis["from"];
      if (!Array.isArray(from) || from.length === 0)
        attemptRefuse(`${b}.from`, "an inference names the claims it follows from");
      for (const [index, entry] of from.entries())
        checkClaimAddress(entry, context, `${b}.from.${index}`);
      if (!nonempty(basis["reasoning"]))
        attemptRefuse(`${b}.reasoning`, "an inference states its reasoning");
      break;
    }
    case "hypothesis": {
      exactFields(basis, ["howToVerify"], b);
      if (!nonempty(basis["howToVerify"]))
        attemptRefuse(`${b}.howToVerify`, "a hypothesis states how it is verified");
      break;
    }
    case "unknown": {
      exactFields(basis, ["origin", "unknownId", "question", "affects", "consumer",
        "blocksCurrentStage", "moment", "closeCriterion"], b);
      for (const key of ["origin", "unknownId", "question", "consumer", "closeCriterion"] as const)
        if (!nonempty(basis[key])) attemptRefuse(`${b}.${key}`, `an unknown needs its ${key}`);
      const affects = basis["affects"];
      if (!Array.isArray(affects) || affects.length === 0 || affects.some(item => !nonempty(item)))
        attemptRefuse(`${b}.affects`, "an unknown names the affected areas — a non-empty list of texts");
      if (typeof basis["blocksCurrentStage"] !== "boolean")
        attemptRefuse(`${b}.blocksCurrentStage`, "an unknown states whether it blocks the current stage");
      if (typeof basis["moment"] !== "string"
        || !(V7_UNKNOWN_MOMENTS as readonly string[]).includes(basis["moment"]))
        attemptRefuse(`${b}.moment`, `a moment is one of ${V7_UNKNOWN_MOMENTS.join(", ")}`);
      break;
    }
    case "owner-decision": {
      exactFields(basis, ["authority"], b);
      projectRef(basis["authority"], `${b}.authority`);
      break;
    }
    default:
      attemptRefuse(b, `kind "${kind}" has no basis form`);
  }
}

/** The structural half of discovery-claims/v7 on an attempt (POOL Р-4): a
 * non-empty collection, unique ids, only the contracted fields, an axis of
 * the 12, planQuestions naming the attempt's own plan-question, a 'common'
 * or explicit variant scope and a basis discriminated by the claim kind.
 * Every declared exact Ref must exist at its revision and hash inside the
 * project — the check is structural; whether a from/contradicts link names
 * ACCEPTED claims is the DR3b semantic layer. */
export function checkV7Claims(claims: unknown, context: V7ClaimsContext): void {
  if (!Array.isArray(claims) || claims.length === 0)
    throw new EngineError("attempt_claims_empty",
      "[claims] a submitted attempt carries a non-empty claims collection",
      { field: "claims", reason: "empty claims" });
  const seen = new Set<string>();
  for (const [index, raw] of claims.entries()) {
    const at = `claims.${index}`;
    if (!obj(raw)) attemptRefuse(at, "a claim is an object");
    exactFields(raw, CLAIM_FIELDS, at);
    for (const key of CLAIM_REQUIRED)
      if (raw[key] === undefined) attemptRefuse(`${at}.${key}`, `a claim needs its ${key}`);
    if (!nonempty(raw["id"])) attemptRefuse(`${at}.id`, "a claim needs its id");
    if (seen.has(raw["id"]))
      attemptRefuse(`${at}.id`, `claim id "${raw["id"]}" is not unique inside the attempt`);
    seen.add(raw["id"]);
    const kind = raw["kind"];
    if (typeof kind !== "string" || !(V7_CLAIM_KINDS as readonly string[]).includes(kind))
      attemptRefuse(`${at}.kind`, "a claim kind is fact, inference, hypothesis, unknown or owner-decision");
    if (!nonempty(raw["text"])) attemptRefuse(`${at}.text`, "a claim needs its text");
    if (typeof raw["axis"] !== "string" || !(V7_AXES as readonly string[]).includes(raw["axis"]))
      attemptRefuse(`${at}.axis`, "a claim addresses one of the 12 axes");
    checkClaimPlanQuestions(raw["planQuestions"], context, at);
    checkClaimScope(raw["scope"], context, at);
    for (const link of ["contradicts", "refutedBy"] as const) {
      const list = raw[link];
      if (list === undefined) continue;
      if (!Array.isArray(list))
        attemptRefuse(`${at}.${link}`, `${link} is a list of ClaimAddress links`);
      for (const [i, entry] of list.entries()) checkClaimAddress(entry, context, `${at}.${link}.${i}`);
    }
    if (raw["supersedes"] !== undefined && raw["supersedes"] !== null)
      checkClaimAddress(raw["supersedes"], context, `${at}.supersedes`);
    checkClaimBasis(kind, raw["basis"], context, at);
  }
}

/** The acceptance half of an interpreted answer provenance — the shared
 * contract for every consumer of a saved research-answer acceptance: a
 * managed acceptance is proven by its saved binding K; every other research
 * answer needs its own supported, well-formed assessment of this exact value
 * by an independent assessor, bound to the named question, with well-formed
 * observations. The record's existence alone is never an acceptance. */
export function provenAcceptance(provenance: AnswerProvenance): provenance is ResearchProvenance {
  if (provenance.kind !== "research-answer") return false;
  if (provenance.binding !== null) return true;
  return provenance.supported && provenance.wellFormed && provenance.independent
    && provenance.valueMatches && provenance.bindsQuestion === true && provenance.hasObservations
    && provenance.observations.every(item => obj(item)
      && typeof item["projectId"] === "string" && isRef(item["source"])
      && obj(item["selector"]) && item["value"] !== undefined);
}

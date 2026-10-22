import { EngineError } from "../errors.js";
import { currentPlan, planOwnerSubject, provePlanQuestions } from "./v7-plan-questions.js";
import { readResearchConsumerTurn } from "./response-recovery.js";
import { turnAction, type ManagedResearchTurn } from "./research-consumer-transition.js";
import { planSubjectOf, type V7PlanSubject } from "./v7-managed-attempt.js";
/**
 * projection-reader — единая граница чтения модуля Discovery.
 *
 * Каждое чтение внутренних записей Discovery (discovery-draft, question и
 * записи их ответов), выполняемое вне src/discovery, идёт через этот модуль.
 * Здесь же живёт знание эр исследовательского контракта (v1–v6 и оба
 * замороженных v6-издания: издание различается сохранёнными specs, а не
 * новой веткой версии у потребителя) и три операции выдачи:
 *   1. acceptedIssuance    — принятая выдача принятого материала;
 *   2. outcomeSummary      — сводка любого сохранённого исхода, включая
 *                            отказы и неполные исторические формы;
 *   3. executionAdmission  — допуск к новому выполнению или восстановлению;
 *                            не требует уже принятой проекции.
 *
 * Граница ничего не пишет и не выбирает новой семантики: чтения возвращают
 * запись или null, проверки и коды отказов остаются на местах вызова,
 * порядок чтений не меняется.
 */

import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { canonical, hashJson, type Json } from "../canonical.js";
import { sealed } from "../om/refusal.js";
import { isRef, reference, stageId, type Ref, type Stage, type StageArtifact } from "../pipeline/contracts.js";
import { Store, storeObserved, type Revision } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import type { Observation } from "../evidence/evidence.js";
import { runtimeEvidenceDependencies } from "../graph/runtime-evidence.js";
import { QUESTION_MOMENT_CONTRACT_VERSION } from "./preparation-contracts.js";
import {
  LEGACY_REQUIREMENTS, NEXT_CONTRACT_ERA, producerContractEra, REQUIREMENTS, RESEARCH_CONTRACT_VERSION,
  selectResearchRequirements, VERSION2_REQUIREMENTS, VERSION3_REQUIREMENTS, VERSION4_REQUIREMENTS,
  VERSION5_REQUIREMENTS, VERSION6_REQUIREMENTS, type ProducerPolicy, type UpstreamStage,
} from "./requirements.js";
import {
  DISCOVERY_ACCEPTANCE_ACT_KIND, DISCOVERY_ACCEPTANCE_ACT_CONTRACT,
  discoveryAcceptanceActId, type DiscoveryAcceptanceAct,
} from "./v7-contracts.js";
import { readAcceptedResearchAnswer } from "./discovery.js";
import type { Decision, DiscoveryDraft, Fact, FieldSpec, Question } from "./discovery.js";
import { managedAnswerTurn, type ResearchAcceptanceBinding } from "./research-consumer-transition.js";
import { readResearchAcceptanceBinding } from "./response-recovery.js";
import type { ResearchAnswer, ResearchAssessment, ResearchRun } from "./research-model.js";
import { discoveryOutcome, discoveryTraversal, type DiscoveryConditionDecision, type DiscoveryOutcome,
  type V7Traversal } from "./discovery-outcome.js";

// Потребителям вне модуля внутренние читатели доступны только через эту границу.
export {
  type Decision, type DiscoveryDraft, type Fact, type FieldSpec, type Question,
} from "./discovery.js";
export type { ResearchAnswer } from "./research-model.js";
export {
  discoveryContext, discoveryOutcome, discoveryInspection, discoveryTraversal, readDiscoveryConditionDecision, V7_TRAVERSAL_CONTRACT,
  type DiscoveryChoice, type DiscoveryConditionDecision, type DiscoveryOutcome, type V7Traversal, type V7TraversalEnd,
  type V7TraversalSubject,
} from "./discovery-outcome.js";
export type { ResearchRun } from "./research-model.js";
export { REQUIREMENTS, selectResearchRequirements, UPSTREAM_STAGES, type ProducerPolicy, type UpstreamStage } from "./requirements.js";

// ---------------------------------------------------------------------------
// Эры контракта. Единственное место, где внешний потребитель узнаёт,
// что означает сохранённая версия драфта.
// ---------------------------------------------------------------------------

/** Все исторически легальные эры upstream-контракта: v1–v6 включительно. */
export const SUPPORTED_CONTRACT_ERAS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6]);
/** Эры, для которых вообще существует допуск к новому выполнению. */
export const ADMISSION_CONTRACT_ERAS: readonly number[] = Object.freeze([4, 5, 6]);
/** Эра текущей таблицы контракта (v6). Эру нового производителя по стадии
 * выбирает producerContractEra — при включённом производителе v7 она выше. */
export const CURRENT_CONTRACT_ERA: number = RESEARCH_CONTRACT_VERSION;
/** С этой эры у контракта есть researchPlan/researchReport/verdict/preparation. */
export const PREPARATION_CONTRACT_ERA = 5;
/** Эра базисных применений (conceptSections/behaviorContracts ведут каталог). */
export const BASIS_APPLICATION_CONTRACT_ERA = 6;
/** Эра, с которой producer обязан сохранять момент вопроса. */
export const QUESTION_MOMENT_CONTRACT_ERA: number = QUESTION_MOMENT_CONTRACT_VERSION;

export { QUESTION_MOMENTS } from "./preparation-contracts.js";
/** Эра оплаченного восстановления (run восстанавливается через researcher). */
export const PAID_RESTORE_CONTRACT_ERA = 4;

/** Эра сохранённого драфта; у самых ранних форм contractVersion отсутствует → 1. */
export function contractEraOf(draft: { contractVersion?: number | null }): number {
  return draft.contractVersion ?? 1;
}

/** Точная сохранённая эра: present — записана ли вовсе, version — сырое
 * сохранённое значение (включая malformed/undefined — отказ на месте вызова). */
export function explicitContractEraOf(draft: { contractVersion?: number | null }):
  { present: boolean; version: number | null | undefined } {
  return { present: Object.hasOwn(draft, "contractVersion"), version: draft.contractVersion };
}

const CONTRACTS_BY_ERA = sealed({
  1: LEGACY_REQUIREMENTS, 2: VERSION2_REQUIREMENTS, 3: VERSION3_REQUIREMENTS,
  4: VERSION4_REQUIREMENTS, 5: VERSION5_REQUIREMENTS, 6: VERSION6_REQUIREMENTS,
});

/** Таблица контракта по одной эре (без выбора издания по сохранённым specs). */
export function requirementsForEra(version: number | null | undefined) {
  return CONTRACTS_BY_ERA[(version ?? 1) as keyof typeof CONTRACTS_BY_ERA] ?? null;
}

/** Полный набор ожидаемых specs по эре и сохранённому набору — выбирает и оба
 * v6-издания; null — неизвестная или неполная историческая форма. */
export function expectedRequirements(stage: UpstreamStage, version: number, savedSpecs: unknown): FieldSpec[] | null {
  return selectResearchRequirements(stage, version, savedSpecs);
}

/** Допуск и таблица требований по сохранённой эре — прежний stageResearchContract
 * из product/stage-checks, перенесённый за границу без изменения семантики. */
export function researchContract(stage: UpstreamStage, version: number, accepted: boolean,
  policy?: ProducerPolicy) {
  const requirements = requirementsForEra(version);
  return { supported: !!requirements && (accepted || version === producerContractEra(stage, policy)),
    requirements: structuredClone((requirements ?? REQUIREMENTS)[stage] as FieldSpec[]),
    checkMapDesign: [3, 4, 5, 6].includes(version) };
}

// ---------------------------------------------------------------------------
// Правила эр — единственное место, где номер версии превращается в поведение.
// Потребители читают эти предикаты, а не сравнивают contractVersion с числом.
// ---------------------------------------------------------------------------

/** Сохранённая эра известна как историческая форма (v1–v6). */
export function isSupportedEra(version: number | null | undefined): boolean {
  return typeof version === "number" && SUPPORTED_CONTRACT_ERAS.includes(version);
}

/** Эра допускает новое выполнение по admission-правилу (v4–v6). */
export function isAdmissionEra(version: number | null | undefined): boolean {
  return typeof version === "number" && ADMISSION_CONTRACT_ERAS.includes(version);
}

/** Эра — текущее производимое издание контракта этой стадии по политике
 * производителя (бесстадийного «текущего» нет: у каждой стадии свой производитель). */
export function isCurrentEra(stage: UpstreamStage, version: number | null | undefined,
  policy?: ProducerPolicy): boolean {
  return version === producerContractEra(stage, policy);
}

/** Эра самой ранней формы (v1, включая отсутствующую contractVersion после contractEraOf). */
export function isLegacyEra(version: number | null | undefined): boolean {
  return version === 1;
}

/** Контракт этой эры несёт researchPlan/researchReport/verdict/preparation. */
export function isPreparationEra(version: number | null | undefined): boolean {
  return (version ?? 0) >= PREPARATION_CONTRACT_ERA;
}

/** Не-legacy ветка replay (прежняя форма `!((contractVersion ?? 1) < 5)`):
 * сюда попадает и нечисловая malformed-эра — отказ/ветвление как раньше. */
export function isPostPreparationForm(version: number | null | undefined): boolean {
  return !((version ?? 1) < PREPARATION_CONTRACT_ERA);
}

/** Эра базисных применений (v6, оба издания). */
export function isBasisApplicationEra(version: number | null | undefined): boolean {
  return version === BASIS_APPLICATION_CONTRACT_ERA;
}

/** Эра оплаченного восстановления (run удерживается через researcher). */
export function isPaidRestoreEra(version: number | null | undefined): boolean {
  return version === PAID_RESTORE_CONTRACT_ERA;
}

/** Producer этой эры обязан сохранять момент вопроса (moment). */
export function questionMomentRequired(version: number | null | undefined): boolean {
  return (version ?? 0) >= QUESTION_MOMENT_CONTRACT_ERA;
}

/** Эры 3–4: B1 воспроизводит сохранённую L1-проекцию по полям стадий. */
export function requiresMapDesignReconstruction(version: number | null | undefined): boolean {
  return version === 3 || version === 4;
}

/** Общее сравнение «эра не ниже порога»; null — неизвестная эра. */
export function contractEraAtLeast(version: number | null, threshold: number): boolean {
  return version !== null && version >= threshold;
}

/** Правило эры базисного каталога (перенесено из om/selected-specification):
 * ровно одна строка каждого из трёх производителей и все три — эры v6. */
export function hasBasisApplications(sources: readonly { stage: string; contractVersion?: number | null }[]): boolean {
  return ['discovery', 'concept', 'specification'].every(stage => {
    const rows = sources.filter(source => source.stage === stage);
    return rows.length === 1 && isBasisApplicationEra(rows[0]!.contractVersion);
  });
}

// ---------------------------------------------------------------------------
// Точечные чтения записей. Принимают минимальный вид чтения — его удовлетворяют
// и Store, и сохранённые proof-view. Записи возвращаются как сохранены; проверка
// kind/identity/hash — на месте вызова, с его кодами отказов.
// ---------------------------------------------------------------------------

export interface RecordView {
  get<T>(id: string, revision?: number): Revision<T> | null;
}

export function readDraft(view: RecordView, id: string, revision?: number): Revision<DiscoveryDraft> | null {
  return view.get<DiscoveryDraft>(id, revision);
}

/** Точное чтение по полной ссылке {id, revision, hash}; null при любом расхождении. */
export function readDraftExact(view: RecordView, ref: Ref): Revision<DiscoveryDraft> | null {
  const record = view.get<DiscoveryDraft>(ref.id, ref.revision);
  return record && record.hash === ref.hash ? record : null;
}

export function listDrafts(store: Store, projectId: string, stage?: string): Revision<DiscoveryDraft>[] {
  return store.list<DiscoveryDraft>("discovery-draft").filter(draft =>
    draft.value.projectId === projectId && (stage === undefined || draft.value.stage === stage));
}

export function readQuestion(view: RecordView, id: string, revision?: number): Revision<Question> | null {
  return view.get<Question>(id, revision);
}

export function readQuestionExact(view: RecordView, ref: Ref): Revision<Question> | null {
  const record = view.get<Question>(ref.id, ref.revision);
  return record && record.hash === ref.hash ? record : null;
}

export function listQuestions(store: Store, projectId: string): Revision<Question>[] {
  const physical = provenStore(store);
  if (!physical || storeObserved(physical))
    return store.list<Question>('question').filter(question => question.value.projectId === projectId);
  return physical.identities('prefix', `question:${projectId}:`).filter(row => row.kind === 'question')
    .map(row => physical.get<Question>(row.id, row.revision)!)
    .filter(question => question?.kind === 'question' && question.value.projectId === projectId);
}

/** Вопросы драфта в его сохранённом порядке; отсутствующие — null на месте.
 * Порядок и поведение .map прежние: не-массив questions падает, как раньше. */
export function orderedQuestions(view: RecordView, draft: Pick<DiscoveryDraft, "questions">): (Revision<Question> | null)[] {
  return draft.questions.map(id => readQuestion(view, id));
}

export function orderedSpecs(view: RecordView, draft: Pick<DiscoveryDraft, "questions">): (FieldSpec | undefined)[] {
  return orderedQuestions(view, draft).map(question => question?.value.spec);
}

/** Запись ответа вопроса (Decision | Fact | ResearchAnswer) — по ссылке точно,
 * по строке id — головная ревизия. */
export function readAnswer<T = Decision | Fact | Record<string, unknown>>(view: RecordView,
  ref: Ref | string): Revision<T> | null {
  return typeof ref === "string" ? view.get<T>(ref) : isRef(ref) ? view.get<T>(ref.id, ref.revision) : null;
}

/** Общее точное чтение зависимости по полной ссылке; null при расхождении. */
export function readExact<T>(view: RecordView, ref: Ref): Revision<T> | null {
  if (!isRef(ref)) return null;
  const record = view.get<T>(ref.id, ref.revision);
  return record && record.hash === ref.hash ? record : null;
}

export function readStageArtifact<T = unknown>(view: RecordView, id: string, revision?: number): Revision<T> | null {
  return view.get<T>(id, revision);
}

/** Общее чтение записи модуля по id (+ревизия). Для специализированных
 * видов есть readDraft/readQuestion/readAnswer/readResearchRun. */
export function readRecord<T>(view: RecordView, id: string, revision?: number): Revision<T> | null {
  return view.get<T>(id, revision);
}

/** Сохранённое решение по условию вердикта (owner-discovery-choice). */
export function readConditionDecision(store: Store, id: string): Revision<DiscoveryConditionDecision> | null {
  return store.get<DiscoveryConditionDecision>(id);
}

export function researchRunId(projectId: string, draftId: string): string {
  return `research-run:${hashJson([projectId, draftId])}`;
}

export function readResearchRun(store: Store, projectId: string, draftId: string): Revision<ResearchRun> | null {
  return store.get<ResearchRun>(researchRunId(projectId, draftId));
}

/** Прогон по сохранённой точной ссылке (id+revision), без проверки hash — как было. */
export function readRun(view: RecordView, ref: Ref): Revision<ResearchRun> | null {
  return isRef(ref) ? view.get<ResearchRun>(ref.id, ref.revision) : null;
}

export function listRuns(store: Store, projectId: string): Revision<ResearchRun>[] {
  return store.list<ResearchRun>("research-run").filter(run => run.value.projectId === projectId);
}

// ---------------------------------------------------------------------------
// Интерпретация форм записей. Потребители получают готовые значения с
// происхождением и точными основаниями, а не разбирают сырые поля записей.
// ---------------------------------------------------------------------------

const object = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Поля контента уже прочитанной записи стадии (content.fields); null — форма
 * content не та. Запись обязана существовать: отсутствующая запись даёт ту же
 * ошибку обращения .value, что был у прямого разбора потребителя. */
export function artifactFields(artifact: Revision<StageArtifact>): Record<string, Json> | null {
  const content = artifact.value?.content;
  return object(content) && object(content.fields) ? content.fields : null;
}

/** Поля контента принятой записи стадии (content.fields); null — записи нет
 * или форма не та. Чтение и разбор content выполняет граница. */
export function stageFields(view: RecordView, projectId: string, stage: string): Record<string, Json> | null {
  const record = view.get<StageArtifact>(stageId(projectId, stage as Stage));
  return record === null ? null : artifactFields(record);
}

/** Акторы сохранённой подготовки Discovery-стадии проекта
 * (content.fields.preparation.actors); [] когда подготовки нет. */
export function discoveryActors(view: RecordView, projectId: string): readonly { id: string }[] {
  const preparation = stageFields(view, projectId, "discovery")?.["preparation"] as { actors?: { id: string }[] } | undefined;
  return preparation?.actors ?? [];
}

// ---------------------------------------------------------------------------
// Сохранённая форма вопросов драфта. Один прочитанный элемент — FormEntry: его
// поля уже интерпретированы — потребитель получает статус, имя поля, дверь
// ответа, точную ссылку ответа и флаги принадлежности, не разбирая внутренние
// поля записи question. Дефект формы (запись отсутствует, чужая или не
// question-вида) возвращается данными; отказ остаётся на позиции потребителя.
// ---------------------------------------------------------------------------

export interface FormEntry {
  /** Позиция идентификатора в draft.questions. */
  readonly index: number;
  /** Сохранённый идентификатор вопроса из драфта. */
  readonly id: string;
  /** Opaque-запись по сохранённому id — для reference() и операций границы;
   * null — записи нет. Чужая/не-question запись всё равно возвращается как есть. */
  readonly question: Revision<Question> | null;
  /** Точная ссылка записи по сохранённому id; null — записи нет. */
  readonly ref: Ref | null;
  /** Имя поля из сохранённого spec; undefined при дефекте или сломанном spec. */
  readonly field: string | undefined;
  /** Вид ответа из сохранённого spec; null при дефекте или сломанном spec. */
  readonly specKind: FieldSpec["kind"] | null;
  /** Сохранённый статус вопроса; undefined при дефекте. */
  readonly status: Question["status"] | undefined;
  /** Запись не принадлежит этой выдаче: отсутствует, не question-вида,
   * чужой проект или чужой драфт. */
  readonly foreign: boolean;
  /** Статус answered и ссылка ответа имеет форму Ref. */
  readonly answered: boolean;
  /** Точная ссылка ответа; null пока ответа нет или форма ссылки нарушена. */
  readonly answerRef: Ref | null;
  /** Дверь ответа по виду spec; null при дефекте или сломанном spec. */
  readonly door: "answer-fact" | "answer-decision" | null;
}

export interface IssuedForm {
  /** Прочитанный префикс формы до первого дефекта (дефектная позиция не входит). */
  readonly entries: readonly FormEntry[];
  /** Дефект формы: отсутствующая, чужая или не-question запись вопроса. */
  readonly defect: { readonly index: number; readonly id: string } | null;
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

/** Интерпретация одной уже прочитанной записи вопроса — без повторного чтения. */
function formEntryOf(draft: Revision<DiscoveryDraft>, index: number, id: string,
  question: Revision<Question> | null): FormEntry {
  const q = question !== null && object(question.value) ? question.value : null;
  const foreign = question === null || question.kind !== "question" || q === null
    || q.projectId !== draft.value.projectId || q.draftId !== draft.id;
  const spec = !foreign && object(q!.spec) ? q!.spec : null;
  const status = foreign ? undefined : q!.status;
  const answerRef = status === "answered" && isRef(q!.answer) ? q!.answer : null;
  return { index, id, question, ref: question ? reference(question) : null,
    field: spec?.field as string | undefined, specKind: spec === null ? null : spec.kind,
    status, foreign, answered: answerRef !== null, answerRef,
    door: spec === null ? null : spec.kind === "fact" ? "answer-fact" : "answer-decision" };
}

/** Сохранённая форма вопросов драфта: читает вопросы в порядке драфта и стоит
 * на первом дефекте — прежняя последовательность обращений потребителей.
 * questions не-массив падает той же ошибкой итерации, что раньше. */
export function issuedForm(view: RecordView, draft: Revision<DiscoveryDraft>): IssuedForm {
  const entries: FormEntry[] = [];
  const ids = draft.value.questions as string[];
  for (const [index, id] of ids.entries()) {
    const entry = formEntryOf(draft, index, id, view.get<Question>(id));
    if (entry.foreign) return { entries, defect: { index, id } };
    entries.push(entry);
  }
  return { entries, defect: null };
}

/** Вопрос драфта по его сохранённому id — только член этого драфта (бывшая
 * member-проверка потребителя); null, когда id не входит в draft.questions. */
export function issuedEntry(view: RecordView, draft: Revision<DiscoveryDraft>, id: string): FormEntry | null {
  const index = (draft.value.questions as string[]).indexOf(id);
  return index < 0 ? null : formEntryOf(draft, index, id, view.get<Question>(id));
}

/** Вопросы принятого драфта сместились относительно доказательств приёмки:
 * сохранённой ссылки нет, записи нет или текущая head не та ревизия.
 * Тот же порядок сравнения, что был у потребителя. */
export function savedQuestionsMoved(view: RecordView, draft: Revision<DiscoveryDraft>,
  saved: (id: string) => Ref | undefined): boolean {
  return (draft.value.questions as string[]).some(id => {
    const proof = saved(id), question = view.get<Question>(id);
    return !proof || !question || !same(proof, reference(question));
  });
}

/** Сохранённый вердикт-ответ: research-answer своего проекта и вопроса с
 * массивом conditions; null — любое расхождение, отказ на месте вызова. */
export function verdictConditions(record: Revision<Record<string, unknown>>,
  expected: { project: string; question: string }): readonly Json[] | null {
  const value = object(record.value) ? record.value : null;
  return record.kind === "research-answer" && value !== null
    && value.projectId === expected.project && value.question === expected.question
    && object(value.value) && Array.isArray(value.value.conditions)
    ? value.value.conditions : null;
}

// ---------------------------------------------------------------------------
// Доказанный ответ выданного вопроса. proveIssuedAnswer — единственная точка,
// где форма записи ответа (Fact | Decision | ResearchAnswer) превращается в
// значение поля и происхождение. Точность ссылок и цепочка принятия — прежние:
// research-answer проходит общий читатель readAcceptedResearchAnswer, его
// отказы (research_acceptance_binding_invalid, research_reuse_source_invalid)
// пробрасываются на место вызова как раньше. Схемы исторических specs
// компилируются по каноническому ключу — валидатор переиспользуется без утечки
// по объектной идентичности декодированных копий.
// ---------------------------------------------------------------------------

const answerSchemas = new Ajv({ strict: true, allowUnionTypes: true });
const answerValidators = new Map<string, ValidateFunction>();
function schemaValidator(schema: unknown): ValidateFunction {
  const key = canonical(schema);
  let validator = answerValidators.get(key);
  if (!validator) { validator = answerSchemas.compile(schema as AnySchema); answerValidators.set(key, validator); }
  return validator;
}

export interface FactProvenance {
  readonly kind: "fact";
  /** Сохранённое наблюдение ответа — проверка источника остаётся у потребителя. */
  readonly observation: Observation;
}
export interface ResearchProvenance {
  readonly kind: "research-answer";
  /** Запись оценки из цепочки принятия; null — адрес эры до K, оценка не разрешилась. */
  readonly assessment: Revision<ResearchAssessment> | null;
  /** Точная ссылка оценки, сохранённая в ответе (answer.assessment). */
  readonly assessmentRef: Ref | null;
  /** Запись принятия K для адресов новой эры; null для адресов прежних эр. */
  readonly binding: Revision<ResearchAcceptanceBinding> | null;
  /** verdict === 'supported'. */
  readonly supported: boolean;
  /** Оценка этого проекта с участниками исследования и ссылкой вопроса. */
  readonly wellFormed: boolean;
  /** researcher и assessor различны. */
  readonly independent: boolean;
  /** Значение оценки воспроизводит значение ответа. */
  readonly valueMatches: boolean;
  readonly hasObservations: boolean;
  /** Оценка доказанно отвечает выданному вопросу (только с verifyIssuedQuestion); иначе null. */
  readonly bindsQuestion: boolean | null;
  readonly researcher: string | null;
  readonly observations: readonly Observation[];
  readonly runtimeDependencies: readonly Ref[];
}
export interface DecisionProvenance {
  readonly kind: "decision" | "design" | "other";
  readonly actor: string | null;
  readonly hasAuthor: boolean;
}
export type AnswerProvenance = FactProvenance | ResearchProvenance | DecisionProvenance;

export interface IssuedAnswerProof {
  /** Opaque-запись ответа — для reference()/id адресов и отказов потребителя. */
  readonly record: Revision<Record<string, unknown>>;
  /** Точная ссылка ответа, как её сохранил вопрос. */
  readonly ref: Ref;
  readonly kind: string;
  /** Запись лежит в пространстве имён ответов этого проекта (kind:project:…). */
  readonly namespaced: boolean;
  /** kind ответа совпадает со spec.kind вопроса. */
  readonly matchesSpec: boolean;
  /** Сохранённое значение поля (fact → observation.value, остальные → answer.value). */
  readonly value: Json;
  /** Значение воспроизводит draft.fields[field] и проходит spec.schema. */
  readonly reproduces: boolean;
  readonly provenance: AnswerProvenance;
}

/** 'question' — вопрос дефектен или не отвечен точной ссылкой;
 *  'foreign' — запись ответа отсутствует или указывает на чужой проект/вопрос. */
export type IssuedAnswer =
  | { readonly ok: true; readonly proof: IssuedAnswerProof }
  | { readonly ok: false; readonly failure: "question" | "foreign";
      readonly record: Revision<Record<string, unknown>> | null };

/** Доказанный ответ одного вопроса выдачи. record — уже прочитанная запись
 * (accepted-пути: proof-map/captured view); опущенный record читается точно
 * через цепочку принятия — прежний readAcceptedResearchAnswer с его отказами.
 * verifyIssuedQuestion повторяет прежнюю проверку B1: оценка привязана именно
 * к записи вопроса этой выдачи (точное чтение assessment.question). */
export function proveIssuedAnswer(view: Store, draft: Revision<DiscoveryDraft>,
  entry: Pick<FormEntry, "question" | "foreign" | "answered" | "answerRef" | "field">,
  record?: Revision<Record<string, unknown>> | null,
  opts: { verifyIssuedQuestion?: boolean } = {}): IssuedAnswer {
  const question = entry.question;
  if (question === null || question.kind !== "question" || entry.foreign
    || !entry.answered || entry.answerRef === null)
    return { ok: false, failure: "question", record: record ?? null };
  const projectId = draft.value.projectId;
  let accepted: { answer: Revision<ResearchAnswer>; assessment: Revision<ResearchAssessment> | null;
    binding: Revision<ResearchAcceptanceBinding> | null } | null = null;
  let row = record;
  if (row === undefined) {
    accepted = readAcceptedResearchAnswer(view, projectId, entry.answerRef);
    row = accepted.answer as unknown as Revision<Record<string, unknown>>;
  }
  const value = row !== null && object(row.value) ? row.value : null;
  if (row === null || value === null || value.projectId !== projectId || value.question !== question.id)
    return { ok: false, failure: "foreign", record: row };
  const kind = row.kind, spec = object(question.value.spec) ? question.value.spec : null;
  let provenance: AnswerProvenance, fieldValue: Json;
  if (kind === "fact") {
    const observation = value.observation as unknown as Observation;
    provenance = { kind, observation };
    fieldValue = observation.value;
  } else if (kind === "research-answer") {
    accepted ??= readAcceptedResearchAnswer(view, projectId, entry.answerRef);
    const assessment = accepted.assessment;
    const av = object(assessment?.value) ? assessment.value : null;
    const researcher = av !== null && text(av.researcher) ? av.researcher as string : null;
    const assessor = av !== null && text(av.assessor) ? av.assessor as string : null;
    let bindsQuestion: boolean | null = null;
    if (opts.verifyIssuedQuestion && assessment !== null && isRef(av!.question)) {
      const issued = readExact<Record<string, Json>>(view, av!.question as Ref);
      bindsQuestion = issued?.kind === "question" && issued.id === question.id
        && issued.hash === (av!.question as Ref).hash && object(issued.value)
        && canonical(issued.value.spec) === canonical(question.value.spec);
    }
    provenance = { kind, assessment, assessmentRef: isRef(value.assessment) ? value.assessment as Ref : null,
      binding: accepted.binding, supported: av?.verdict === "supported",
      wellFormed: av !== null && av.projectId === projectId && researcher !== null && assessor !== null
        && isRef(av.question),
      independent: researcher !== null && assessor !== null && researcher !== assessor,
      valueMatches: same(av?.value, value.value), hasObservations: Array.isArray(av?.observations) && av.observations.length > 0,
      bindsQuestion, researcher,
      observations: Array.isArray(av?.observations) ? av.observations as Observation[] : [],
      runtimeDependencies: av !== null ? runtimeEvidenceDependencies(av.runtimeProofs ?? []) : [] };
    fieldValue = value.value as Json;
  } else {
    const actor = text(value.actor) ? value.actor as string : null;
    provenance = { kind: kind === "decision" || kind === "design" ? kind : "other", actor, hasAuthor: actor !== null };
    fieldValue = value.value as Json;
  }
  const reproduces = spec !== null && entry.field !== undefined
    && schemaValidator(spec.schema)(fieldValue) && same(fieldValue, draft.value.fields[entry.field]);
  return { ok: true, proof: { record: row, ref: entry.answerRef, kind, namespaced: row.id.startsWith(`${kind}:${projectId}:`),
    matchesSpec: kind === spec?.kind, value: fieldValue, reproduces, provenance } };
}

/** spec.schema вопроса над интерпретированным значением поля — форма ответа
 * без обращения к текущей голове драфта (proof.reproduces читает голову). */
export function issuedAnswerSchemaHolds(question: Revision<Question>, value: Json): boolean {
  const spec = object(question.value.spec) ? question.value.spec : null;
  return spec !== null && schemaValidator(spec.schema)(value);
}

/** Сохранённый акт принятия exact Ref: доказывает связанный переход одного акта
 * принятия:
 *   1. Для managed-пути: K несёт exact after-ревизии вопроса и драфта.
 *   2. Для обычного пути: переход вопроса beforeQ -> afterQ (где afterQ отвечен
 *      именно ref); для research-answer assessment.question обязана совпадать
 *      с exact Ref вопроса до именно этого принятия (reference(beforeQ));
 *      связанный переход драфта beforeDraft -> afterDraft, где beforeDraft
 *      согласован с beforeQ.beforeHash, а afterDraft получен установкой поля.
 * Читается только сохранённая история: текущая голова может быть open после
 * reopen или держать следующий ответ — это не отменяет прошлого принятия.
 * Свойства оценки/цепочки доказываются отдельно (proveIssuedAnswer); факт
 * принятия — только здесь, по сохранённым ревизиям, а не по флагу вызывающего. */
export function savedAcceptanceAct(view: RecordView, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, field: string, ref: Ref, value: Json): boolean {
  if (draft.kind !== "discovery-draft" || question.kind !== "question") return false;
  if (question.value.draftId !== draft.id || question.value.spec.field !== field) return false;

  // Для черновиков v7: проверка неизменяемой записи discovery-acceptance-act (DR2, №6009/6010)
  if (draft.value.contractVersion === NEXT_CONTRACT_ERA) {
    const actId = discoveryAcceptanceActId(draft.value.projectId, draft.id, field, ref);
    const act = view.get<DiscoveryAcceptanceAct>(actId);
    if (!act || act.kind !== DISCOVERY_ACCEPTANCE_ACT_KIND || act.revision !== 1
      || typeof act.value !== "object" || act.value === null
      || hashJson(act.value) !== act.hash) {
      return false;
    }
    const a = act.value;
    if (a.contract !== DISCOVERY_ACCEPTANCE_ACT_CONTRACT
      || a.projectId !== draft.value.projectId
      || a.draftId !== draft.id
      || a.field !== field
      || !isRef(a.answer) || canonical(a.answer) !== canonical(ref)
      || !isRef(a.draftBefore) || a.draftBefore.id !== draft.id
      || !isRef(a.draftAfter) || a.draftAfter.id !== draft.id
      || a.draftAfter.revision !== a.draftBefore.revision + 1
      || !isRef(a.questionBefore) || a.questionBefore.id !== question.id
      || !isRef(a.questionAfter) || a.questionAfter.id !== question.id
      || a.questionAfter.revision !== a.questionBefore.revision + 1) {
      return false;
    }

    // Загружаем связанные ревизии через view.get (существующая поверхность чтения Store view)
    const qBefore = view.get<Question>(a.questionBefore.id, a.questionBefore.revision);
    const qAfter = view.get<Question>(a.questionAfter.id, a.questionAfter.revision);
    const dBefore = view.get<DiscoveryDraft>(a.draftBefore.id, a.draftBefore.revision);
    const dAfter = view.get<DiscoveryDraft>(a.draftAfter.id, a.draftAfter.revision);

    if (!qBefore || qBefore.kind !== "question" || qBefore.hash !== a.questionBefore.hash
      || !qAfter || qAfter.kind !== "question" || qAfter.hash !== a.questionAfter.hash
      || !dBefore || dBefore.kind !== "discovery-draft" || dBefore.hash !== a.draftBefore.hash
      || !dAfter || dAfter.kind !== "discovery-draft" || dAfter.hash !== a.draftAfter.hash) {
      return false;
    }

    // Вопрос принадлежит draft и его field; questionBefore — open или unresolved (как у производителя), не answered; questionAfter — answered с exact answer
    if (qBefore.value.draftId !== draft.id || qBefore.value.spec.field !== field
      || (qBefore.value.status !== "open" && qBefore.value.status !== "unresolved")
      || qAfter.value.draftId !== draft.id || qAfter.value.spec.field !== field
      || qAfter.value.status !== "answered" || canonical(qAfter.value.answer) !== canonical(ref)) {
      return false;
    }

    // draftAfter.fields[field] равно интерпретированному значению ответа
    if (!same(dAfter.value.fields[field], value)) {
      return false;
    }

    // Пары before/after воспроизводят переход производителя
    if (hashJson(dBefore.value.fields[field]) !== qBefore.value.beforeHash) {
      return false;
    }
    const expectedDraftAfter = {
      ...dBefore.value,
      fields: { ...dBefore.value.fields, [field]: value },
    };
    if (canonical(expectedDraftAfter) !== canonical(dAfter.value)) {
      return false;
    }
    const expectedQAfter = {
      ...qBefore.value,
      status: "answered" as const,
      answer: ref,
    };
    if (canonical(expectedQAfter) !== canonical(qAfter.value)) {
      return false;
    }

    // Оценка (assessment)
    if (a.assessment !== null) {
      if (!isRef(a.assessment)) return false;
      const assessment = view.get<ResearchAssessment>(a.assessment.id, a.assessment.revision);
      if (!assessment || assessment.kind !== "research-assessment" || assessment.hash !== a.assessment.hash) {
        return false;
      }
      if (assessment.value.projectId !== draft.value.projectId
        || assessment.value.verdict !== "supported"
        || canonical(assessment.value.question) !== canonical(a.questionBefore)
        || !same(assessment.value.value, value)
        || assessment.value.researcher === assessment.value.assessor
        || !Array.isArray(assessment.value.observations) || assessment.value.observations.length === 0) {
        return false;
      }
      const ansRec = view.get<ResearchAnswer>(ref.id, ref.revision);
      if (!ansRec || ansRec.kind !== "research-answer" || canonical(ansRec.value.assessment) !== canonical(a.assessment)) {
        return false;
      }
    } else {
      // Для brief/fact и objective/decision: assessment равен null
      // План и ClaimAddress по-прежнему требуют исследовательское доказательство (assessment)
      if (question.value.spec.proof === "assessment") {
        return false;
      }
      const ansRec = view.get<Fact | Decision | ResearchAnswer>(ref.id, ref.revision);
      if (!ansRec || ansRec.kind === "research-answer") {
        return false;
      }
      if (ansRec.kind === "fact") {
        if (!same((ansRec.value as Fact).observation.value, value)) return false;
      } else if (ansRec.kind === "decision" || ansRec.kind === "design") {
        if (!same((ansRec.value as Decision).value, value)) return false;
      } else {
        return false;
      }
    }

    // Managed binding
    let turnId: string | null = null;
    try {
      turnId = managedAnswerTurn(ref.id, draft.value.projectId);
    } catch {
      return false;
    }
    if (turnId !== null) {
      if (!a.binding || !isRef(a.binding)) return false;
      const bindingRecord = view.get<ResearchAcceptanceBinding>(a.binding.id, a.binding.revision);
      if (!bindingRecord || bindingRecord.kind !== "research-acceptance-binding"
        || bindingRecord.hash !== a.binding.hash
        || hashJson(bindingRecord.value) !== bindingRecord.hash) {
        return false;
      }
      const b = bindingRecord.value;
      if (canonical(b.draftBefore) !== canonical(a.draftBefore)
        || canonical(b.draftAfter) !== canonical(a.draftAfter)
        || canonical(b.questionBefore) !== canonical(a.questionBefore)
        || canonical(b.questionAfter) !== canonical(a.questionAfter)
        || canonical(b.answer) !== canonical(a.answer)
        || canonical(b.assessment) !== canonical(a.assessment)) {
        return false;
      }
    } else {
      if (a.binding !== null && a.binding !== undefined) return false;
    }

    return true;
  }

  // Для старых эр (не v7): managed-путь через readResearchAcceptanceBinding
  let turnId: string | null = null;
  try {
    turnId = managedAnswerTurn(ref.id, draft.value.projectId);
  } catch {
    return false;
  }
  if (turnId !== null) {
    const proven = readResearchAcceptanceBinding(view as unknown as Store, draft.value.projectId, turnId);
    if (proven !== null) {
      const b = proven.binding.value;
      if (canonical(b.answer) === canonical(ref)
        && b.questionBefore.id === question.id
        && b.questionAfter.id === question.id
        && b.questionAfter.revision === b.questionBefore.revision + 1
        && b.draftBefore.id === draft.id
        && b.draftAfter.id === draft.id
        && b.draftAfter.revision === b.draftBefore.revision + 1) {
        const dAfter = view.get<DiscoveryDraft>(draft.id, b.draftAfter.revision);
        if (dAfter !== null && dAfter.kind === "discovery-draft"
          && same(dAfter.value.fields[field], value)) {
          return true;
        }
      }
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Операция 1 — принятая выдача.
// ---------------------------------------------------------------------------

/** Один вопрос принятой выдачи — интерпретированная FormEntry плюс флаги
 * расположения ответа. staged — stage совпадает с драфтом; namespaced — id
 * лежит в пространстве имён вопросов проекта; valid — вопрос принадлежит
 * выдаче, своего вида и отвечён точной ссылкой. */
export interface IssuanceEntry extends FormEntry {
  readonly staged: boolean;
  readonly namespaced: boolean;
  readonly valid: boolean;
}

export interface IssuedProjection {
  readonly issued: true;
  readonly era: number;
  readonly explicitEra: number | null | undefined;
  /** Эра — известная историческая форма (v1–v6). */
  readonly supported: boolean;
  /** Контракт несёт researchPlan/researchReport/verdict/preparation (эра ≥5). */
  readonly prepared: boolean;
  /** Эра базисных применений (v6, оба издания). */
  readonly basis: boolean;
  /** Сохранённые specs совпадают с текущим изданием контракта этой стадии. */
  readonly matchesCurrentContract: boolean;
  /** Имена полей контракта эры в порядке выдачи. */
  readonly fields: readonly string[];
  readonly entries: readonly IssuanceEntry[];
}

/** Отказ выдачи данными: missing — записи вопроса нет; contract — сохранённые
 * specs не совпадают с контрактом эры (сообщается раньше неотвеченности —
 * прежний приоритет); incomplete — контракт совпал, но вопрос не отвечен. */
export interface IssuanceRefusal {
  readonly issued: false;
  readonly era: number;
  readonly explicitEra: number | null | undefined;
  readonly supported: boolean;
  readonly prepared: boolean;
  readonly basis: boolean;
  readonly matchesCurrentContract: boolean;
  readonly failure: "missing" | "contract" | "incomplete";
  /** Адрес отказа: id записи вопроса или draft.id при отсутствующей записи. */
  readonly question: string;
  readonly field: string | undefined;
}

export type IssuanceResult = IssuedProjection | IssuanceRefusal;

/** Принятая выдача: драфт + упорядоченные вопросы + контракт его эры.
 * Доказывает принятие и возвращает результат-отказ (прежние приоритеты:
 * отсутствующий вопрос — раньше контракта, несовпадение контракта — раньше
 * неотвеченности). Порядок чтений прежний: все вопросы в сохранённом порядке
 * через переданный view; ответы не читаются — их доказательство —
 * proveIssuedAnswer по entry.answerRef. */
export function acceptedIssuance(view: RecordView, draft: Revision<DiscoveryDraft>): IssuanceResult {
  const era = contractEraOf(draft.value);
  const questions = orderedQuestions(view, draft.value);
  const projectId = draft.value.projectId, stage = draft.value.stage;
  const entries: IssuanceEntry[] = questions.map((question, index) => {
    const base = formEntryOf(draft, index, draft.value.questions[index] as string, question);
    const q = object(question?.value) ? question.value : null;
    return { ...base, staged: q?.stage === stage,
      namespaced: question !== null && question.id.startsWith(`question:${projectId}:`),
      valid: question !== null && question.kind === "question" && !base.foreign && base.answered };
  });
  const base = { era, explicitEra: explicitContractEraOf(draft.value).version,
    supported: requirementsForEra(era) !== null, prepared: isPreparationEra(era), basis: isBasisApplicationEra(era) };
  // Отсутствующая запись вопроса — как отказ строгого view при чтении: до
  // проверки контракта и до каноникализации specs (прежний порядок отказов).
  for (const entry of entries)
    if (entry.question === null)
      return { issued: false, ...base, matchesCurrentContract: false,
        failure: "missing", question: draft.id, field: entry.field };
  const specs = questions.map(question => question!.value.spec);
  const meta = { ...base,
    matchesCurrentContract: canonical(specs) === canonical(REQUIREMENTS[stage as UpstreamStage] ?? null) };
  const expected = expectedRequirements(stage as UpstreamStage, era, specs);
  const contractMatches = expected !== null && canonical(specs) === canonical(expected);
  // Прежний приоритет отказов: несовпадение контракта сообщается раньше неотвеченности.
  if (!contractMatches)
    return { issued: false, ...meta, failure: "contract", question: draft.id, field: undefined };
  for (const [index, question] of questions.entries()) {
    const q = question!.value;
    if (q.status !== "answered" || !isRef(q.answer))
      return { issued: false, ...meta, failure: "incomplete", question: question!.id, field: entries[index]!.field };
  }
  return { issued: true, ...meta, fields: expected!.map(spec => spec.field), entries };
}

// ---------------------------------------------------------------------------
// Операция 2 — сводка любого сохранённого исхода.
// ---------------------------------------------------------------------------

export interface OutcomeSummary {
  readonly era: number;
  readonly prepared: boolean;
  /** discoveryOutcome(draft): legacy | researching | go | conditional | no_go | insufficient_evidence. */
  readonly outcome: DiscoveryOutcome;
  /** Сохранённый прогон этого драфта, если был (paid/recovery форма).
   * Ленивый: читается при первом обращении — сводка не сдвигает порядок
   * чтений потребителя, которому нужен только исход. */
  readonly run: Revision<ResearchRun> | null;
  /** R.3: доказанный исход обхода плана v7 (discoveryTraversal), null вне v7 и до ответа плана. Ленивый, как run:
   * сводка не добавляет чтений потребителю, которому нужен только исход; ни один исход не принимает Discovery. */
  readonly traversal: V7Traversal | null;
  /** Интерпретированная сохранённая форма вопросов (принимается от вызывающего,
   * чтобы не дублировать уже выполненные чтения). */
  readonly form: IssuedForm;
}

/** Сводка любого исхода: принципиальный исход + сохранённый прогон,
 * без требования принятой проекции. Форма принимается прочитанной — сама
 * сводка не добавляет чтений вопросов к прежнему порядку. */
export function outcomeSummary(store: Store, draft: Revision<DiscoveryDraft>, form: IssuedForm): OutcomeSummary {
  const era = contractEraOf(draft.value), projectId = draft.value.projectId;
  return { era, prepared: era >= PREPARATION_CONTRACT_ERA, outcome: discoveryOutcome(store, draft),
    get run() { return readResearchRun(store, projectId, draft.id); },
    get traversal() { return discoveryTraversal(store, draft); }, form };
}

// ---------------------------------------------------------------------------
// Операция 3 — допуск к новому выполнению или восстановлению.
// ---------------------------------------------------------------------------

export type AdmissionPurpose =
  /** Новое стадийное исследование (stage-research). */
  | "new-research"
  /** Новый результат стадии по принятому исследованию (engine.draft/build-map). */
  | "stage-result"
  /** Допуск драфта к раннему драйву (early-stage-driver). */
  | "early-drive";

export interface ExecutionAdmission {
  readonly era: number;
  readonly explicitEra: number | null | undefined;
  /** Допуск разрешён: new-research/stage-result — только текущая эра,
   * early-drive — любая admission-эра. */
  readonly admitted: boolean;
  /** Эра не допускает новую работу (upgrade-required; история остаётся читаемой). */
  readonly upgradeRequired: boolean;
  /** 'new-research': оплаченная работа v4/v5 удерживается — ответ paused+restore, а не отказ. */
  readonly paused: boolean;
  /** 'new-research': эра v4 — обязательное восстановление оплаченного хода через researcher. */
  readonly paidRestore: boolean;
  /** Текст upgrade-required именно этой эры (как раньше, v4 отличается от v5/v6). */
  readonly message: string | null;
  /** 'early-drive' && admitted: интерпретация незавершённой формы драфта
   * (читает вопросы — прежняя проверка драйва): 'lost' — questions не массив;
   * 'mismatch' — набор не совпадает с контрактом эры; 'valid' — полная форма.
   * Иные purpose/admitted — null, лишних чтений операция не делает. */
  readonly form: "valid" | "lost" | "mismatch" | null;
}

/** Допуск к выполнению/восстановлению. Не требует принятой проекции: отвечает
 * и для неполных исторических форм — отказ типизирован в флагах результата.
 * Для admitted early-drive читает вопросы — тот же обход, что делал драйв
 * после допуска; для остальных назначений по-прежнему ничего не читает —
 * чтение сохранённого прогона остаётся на прежнем месте вызова (readResearchRun). */
export function executionAdmission(store: Store, draft: Revision<DiscoveryDraft>,
  purpose: AdmissionPurpose, policy?: ProducerPolicy): ExecutionAdmission {
  const era = contractEraOf(draft.value), explicitEra = explicitContractEraOf(draft.value).version;
  const producerEra = producerContractEra(draft.value.stage as UpstreamStage, policy);
  const v7 = era === 7 && draft.value.stage === "discovery";
  const admitted = v7 ? purpose !== "stage-result" && producerEra === 7
    : purpose === "early-drive" ? ADMISSION_CONTRACT_ERAS.includes(era) : era === producerEra;
  if (v7 && admitted) {
    const plan = currentPlan(store, draft.value.projectId);
    if (canonical(reference(plan.draft)) !== canonical(reference(draft)))
      throw new EngineError("plan_questions_invalid", "Admission requires the exact current plan draft");
  }
  const paused = purpose === "new-research" && ADMISSION_CONTRACT_ERAS.includes(era) && !admitted;
  const message = admitted || !ADMISSION_CONTRACT_ERAS.includes(era) ? null
    : era === PAID_RESTORE_CONTRACT_ERA
    ? `Paid v${era} work is retained; prepare Discovery v5 before new research or acceptance`
    : `Paid v${era} work is retained; prepare Discovery v${producerEra} before new research or acceptance`;
  let form: ExecutionAdmission["form"] = null;
  if (v7 && admitted) form = "valid";
  else if (admitted && purpose === "early-drive") {
    if (!Array.isArray(draft.value.questions)) form = "lost";
    else {
      const questions = orderedQuestions(store, draft.value);
      const expected = expectedRequirements(draft.value.stage as UpstreamStage, era,
        questions.map(question => question?.value.spec));
      form = expected !== null && questions.every((question, index) =>
        question?.kind === "question" && question.value.projectId === draft.value.projectId
        && question.value.draftId === draft.id && question.value.stage === draft.value.stage
        && question.value.level === "R0" && question.value.consumer === draft.value.consumer
        && canonical(question.value.spec) === canonical(expected[index])) ? "valid" : "mismatch";
    }
  }
  return { era, explicitEra, admitted, upgradeRequired: !admitted, paused,
    paidRestore: purpose === "new-research" && era === PAID_RESTORE_CONTRACT_ERA, message, form };
}

/** Logical owner subjects are interpreted inside the Discovery boundary. */
export { planOwnerSubject };

/** S6.9 (codex-omg №9689): the logical question a saved v7 run stop belongs to,
 * read only from its proven basis — the summary reproduces the saved meaning of
 * the run and never chooses the next work. `owner` — the proven owner pause
 * (planOwnerSubject); `model-pause` — the unique paid pause turn of the run,
 * proven with its producing intent (readResearchConsumerTurn), equal to the
 * saved pause reason; `unbound` — the run stopped before a plan subject was
 * fixed (a pause of the engine, or a paid pause on a field question): no
 * subject is shown, never the next question of today's plan. The text comes
 * from the exact plan edition of the subject, so a newer accepted edition never
 * readdresses an older pause. A damaged declared binding is a typed refusal. */
export interface PlanStopSubject {
  binding: "owner" | "model-pause" | "unbound";
  subject: V7PlanSubject | null; question: Ref | null; text: string | null;
}
export function planStopSubject(store: Store, draft: Revision<DiscoveryDraft>, run: Revision<ResearchRun>): PlanStopSubject {
  const invalid = (message: string): never => {
    throw new EngineError("research_stop_subject_invalid", `[${run.id}] ${message}`, { run: reference(run) });
  };
  const planned = (binding: "owner" | "model-pause", subject: V7PlanSubject, question: Ref): PlanStopSubject => {
    const entry = provePlanQuestions(store, draft, subject.planAnswer)
      .find(item => item.planQuestionId === subject.planQuestionId);
    if (!entry) invalid("The saved subject names no question of its exact plan edition");
    const element = entry!.question;
    const text = element && typeof element === "object" && !Array.isArray(element) && typeof element["text"] === "string"
      ? element["text"] : null;
    return { binding, subject, question, text };
  };
  if (run.value.status === "needs_owner") {
    const proven = planOwnerSubject(store, run);
    return planned("owner", proven.subject, proven.question);
  }
  if (run.value.status !== "paused" || run.value.pauseCode !== "research_model_paused")
    return { binding: "unbound", subject: null, question: null, text: null };
  const candidates = store.list<ManagedResearchTurn>("research-turn")
    .filter(turn => turn.value.run === run.id && turn.value.number === run.value.turns);
  if (candidates.length !== 1) invalid("The paid pause lost its unique paid turn");
  const turn = readResearchConsumerTurn(store, reference(candidates[0]!)) as Revision<ManagedResearchTurn>;
  const action = turnAction(turn.value);
  if (turn.value.status !== "completed" || action.action !== "pause" || !isRef(turn.value.question)
    || run.value.error !== action.reason)
    invalid("The paid pause differs from its paid turn");
  const subject = planSubjectOf(turn.value);
  if (!subject) return { binding: "unbound", subject: null, question: turn.value.question, text: null };
  return planned("model-pause", subject, turn.value.question as Ref);
}
export function hasPlanQuestions(draft: DiscoveryDraft): boolean {
  return draft.stage === "discovery" && contractEraOf(draft) === 7;
}

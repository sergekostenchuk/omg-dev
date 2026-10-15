import { sealed } from "../om/refusal.js";
import { HASH_PATTERN, type Json } from "../canonical.js";
import type { FieldSpec } from "./discovery.js";

export const JOURNEY_VARIANTS = ["success", "first_use", "repeated_use", "reload_restart_resume", "cancel_stop_retry",
  "invalid_incomplete_input", "partial_success", "dependency_unavailable", "safe_failure", "crash_recovery",
  "unauthorized_adversarial", "operator_admin", "cli_api_agent", "migration_compatibility", "concurrent_replayed",
  "export_retention_deletion", "accessibility"] as const;
export const QUESTION_MOMENTS = Object.freeze(["om-pass", "feasibility", "task-start", "task-result"] as const);
export const QUESTION_MOMENT_CONTRACT_VERSION = 4;
const text: Json = { type: "string", minLength: 1 };
const list = (items: Json, minItems = 0): Json => ({ type: "array", minItems, items });
const texts = (minimum = 0): Json => list(text, minimum);
const object = (properties: Record<string, Json>): Json => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const actor = object({ id: text, role: text, benefit: text, channels: texts(1) });
const outcome = object({ id: text, beneficiary: text, result: text, success: texts(1) });
const scenario = object({ actor: text, outcome: text, entry: text, steps: texts(1), success: texts(1), failure: texts(1), recovery: texts() });
const variant: Json = { oneOf: [
  object({ applicability: { const: "applicable" }, reason: text, scenarios: list(scenario, 1) }),
  object({ applicability: { const: "not_applicable" }, reason: text, scenarios: { type: "array", maxItems: 0 } }),
] };

const unknownQuestion = { id: text, question: text, consumer: text, blocksCurrentStage: { type: "boolean" }, resolution: text };
const remainingQuestion = { question: text, consumer: text, blocksCurrentStage: { type: "boolean" } };
const moment: Json = { enum: [...QUESTION_MOMENTS] };
const preparation = {
  problem: text, existingSituation: text,
  actors: list(actor, 1), outcomes: list(outcome, 1),
  journeys: object(Object.fromEntries(JOURNEY_VARIANTS.map(name => [name, variant]))),
  constraints: list(object({ id: text, rule: text, basis: text })),
  externalSystems: list(object({ id: text, purpose: text, inputs: texts(), outputs: texts(), availability: text })),
  risks: list(object({ id: text, consequence: text, affectedOutcome: text, mitigation: text })),
  unknowns: list(object(unknownQuestion)),
};
// These schemas remain the contract of already saved version 2/3 questions.
export const preparationSchema = object(preparation);
export const preparationMomentSchema = object({ ...preparation, unknowns: list(object({ ...unknownQuestion, moment })) });

export const sectionSchema = list(object({ id: text, title: text, requirements: list(object({ id: text, statement: text,
  benefit: text, beneficiary: text, outcome: text, acceptance: texts(1) }), 1) }), 1);

const basisApplication = object({
  contract: { const: 'basis-application/v1' },
  basis: object({ record: object({ id: text, revision: { type: 'integer', minimum: 1 },
    hash: { type: 'string', pattern: HASH_PATTERN } }), pointer: { type: 'string' } }),
  appliedAt: texts(1),
});
export const conceptApplicationsSchema = list(object({ id: text, title: text,
  requirements: list(object({ id: text, statement: text, benefit: text, beneficiary: text,
    outcome: text, acceptance: texts(1), applications: list(basisApplication) }), 1),
}), 1);

export const operationRequirementsSchema = object({
  outcomes: list(object({ outcome: text, producerResponsibility: text, consumers: texts(1), prerequisites: texts(),
    success: texts(1), failure: texts(1), recoveryResponsibility: text }), 1),
  conceptCoverage: list(object({ requirement: text, outcome: text }), 1),
});

export const behaviorContractsSchema = list(object({
  id: text, requirements: texts(1), actor: text, entry: text, inputs: texts(), outcome: text,
  success: texts(1), failures: texts(1), forbiddenEffects: texts(1),
  state: object({ durability: { enum: ["durable", "reconstructible", "external", "none"] }, writer: text,
    authority: text, rollback: text, restart: text, replay: text }),
  compatibility: text, proof: text,
}), 1);

const featurePreparation = {
  featureTitle: text, outcome: text, requirements: texts(1), behaviorContracts: texts(1), beneficiary: text, benefit: text,
  success: texts(1), failures: texts(1), interactions: list(object({ outcome: text, condition: text })),
  remainingQuestions: list(object(remainingQuestion)),
};
export const featurePreparationSchema = list(object(featurePreparation), 1);
export const featurePreparationMomentSchema = list(object({ ...featurePreparation,
  remainingQuestions: list(object({ ...remainingQuestion, moment })),
}), 1);

export function preparationField(field: string, prompt: string, risk: string, schema: Json): FieldSpec {
  return { field, kind: "design", proof: "assessment", prompt, risk, schema };
}

export const UPSTREAM_DETAILS = {
  discovery: preparationField("preparation", "Исследуй проблему и существующую ситуацию, участников и пользу, результаты, все применимые варианты journeys, ограничения, внешние системы, риски и неизвестные. Для каждого неприменимого сценария дай основание. Используй документы и доступные источники; проектное предложение не выдавай за факт существующей реализации.", "Первоначальная карта не получает достаточных исходных данных", preparationSchema),
  concept: preparationField("conceptSections", "Сформируй адресуемые разделы и требования концепции из накопленного исследования: для каждого требования укажи пользу, получателя, результат и критерии. Сохраняй исходный смысл и выбранные ограничения.", "Требования невозможно проследить от концепции до полезного результата", sectionSchema),
  "operation-map": preparationField("operationRequirements", "Для каждого результата концепции раскрой ответственность производителя, потребителей, предпосылки, успех, отказ и восстановление. Покрой адресуемые требования концепции; не назначай произвольные одинаковые контракты всем блокам.", "Карта состоит из названий блоков без содержательных связей", operationRequirementsSchema),
  specification: preparationField("behaviorContracts", "Уточни проверяемое поведение: вход, участник, результат, успех/отказ, запрещённые последствия, полномочия, запись/восстановление/повтор, совместимость и способ доказательства. Ссылайся на требования концепции и исходы карты.", "Фичи и атомарные работы не имеют точного проверяемого поведения", behaviorContractsSchema),
  features: preparationField("featurePreparation", "Подготовь фичи с пользой и потребителем, требованиями концепции, контрактами ТЗ, критериями успеха/отказа, взаимодействиями и оставшимися адресными вопросами. Существенное неизвестное нельзя объявлять разрешённым.", "Детализация фич теряет ограничения, взаимодействия и основания", featurePreparationSchema),
} satisfies Record<string, FieldSpec>;

const momentInstruction = " Для каждого вопроса явно укажи moment: om-pass (до завершения OM), feasibility (до проверки выполнимости), task-start (до начала работы) или task-result (при подтверждении результата работы). Срок задаётся этим вопросом и не выводится из его текста или blocksCurrentStage.";
export const UPSTREAM_MOMENT_DETAILS = { ...UPSTREAM_DETAILS,
  discovery: { ...UPSTREAM_DETAILS.discovery, schema: preparationMomentSchema, prompt: UPSTREAM_DETAILS.discovery.prompt + momentInstruction },
  features: { ...UPSTREAM_DETAILS.features, schema: featurePreparationMomentSchema, prompt: UPSTREAM_DETAILS.features.prompt + momentInstruction },
} satisfies Record<string, FieldSpec>;

// A plan proposes research; its sources name work to do, not acquired evidence.
const researchRef = object({ id: text, revision: { type: "integer", minimum: 1 },
  hash: { type: "string", pattern: "^[a-f0-9]{64}$" } });
const researchQuestion = object({ id: text, question: text, why: text });
export const discoveryResearchPlanSchema = object({
  domain: text, roles: list(object({ role: text, side: text, why: text }), 1),
  startingQuestions: list(researchQuestion, 1),
  sources: list(object({ id: text, kind: text, what: text, why: text }), 1),
  feasibilityQuestions: list(researchQuestion, 1), deliverable: text,
});
export const discoveryResearchReportSchema = object({
  researchPlan: researchRef,
  results: list(object({ id: text, question: text, conclusion: text,
    citations: list({ type: "integer", minimum: 0 }, 1), limits: texts() })),
  openQuestions: list(object({ id: text, question: text, reason: text })),
  variant: text, constraints: texts(),
});
export const discoveryVerdictSchema = object({
  researchReport: researchRef,
  outcome: { enum: ["go", "conditional", "no_go", "insufficient_evidence"] },
  reason: text, variant: text,
  bases: list(object({ result: text, reason: text }), 1),
  conditions: list({ oneOf: [
    object({ id: text, kind: { const: "evidence" }, condition: text, criterion: text }),
    object({ id: text, kind: { const: "owner_choice" }, condition: text, criterion: text,
      options: list(object({ optionId: text, label: text, consequences: texts(1), choice: { enum: ["accept", "decline"] } }), 2) }),
  ] }),
});
export const DISCOVERY_RESEARCH_FIELDS = [
  preparationField("researchPlan", "Определи домен поручения и профессиональные роли людей, которые исследовали бы его разные стороны. От этих позиций предложи, с чего начать, что изучить, какие источники искать, какие вопросы решают реализуемость и что будет конкретным результатом исследования. У startingQuestions и feasibilityQuestions должны быть разные устойчивые id. sources — непустой план поиска материалов, а не доказательство их получения; URL заранее выдумывать не нужно. Цитаты на этом шаге подтверждают исходное поручение и ограничения. Не выдавай план, предположения о спросе или экономике за исследованные факты. Исследование должно зависеть от домена задачи, без заранее назначенной роли. Исходное поручение и цель находятся в discoveryContext.",
    "Исследование не определяет предмет, профессиональные перспективы, необходимые источники и результат", discoveryResearchPlanSchema),
  preparationField("researchReport", "Исследуй вопросы принятого researchPlan из discoveryContext. В researchPlan скопируй точный answer Ref плана. Каждый results[].question и openQuestions[].question ссылается на id его startingQuestions или feasibilityQuestions. results[].citations — индексы точных citations этого ответа; свяжи каждый существенный вывод с прочитанными источниками и обозначь пределы доказательства. Объясни варианты, доступные интеграции и ограничения, сравнение использовать/адаптировать/построить и экономику, где они существенны для задачи. Не выдумывай применимость, спрос, стоимость или отсутствие решений: при нехватке данных сохрани конкретные openQuestions. Дай исследованный вариант и ограничения, включая невозможность исходного варианта при имеющихся условиях. План и поручение сами по себе не доказывают внешних фактов.",
    "Выводы о вариантах и реализуемости не связаны с вопросами исследования и источниками", discoveryResearchReportSchema),
  preparationField("verdict", "По принятым researchPlan и researchReport из discoveryContext вынеси обоснованный вердикт; в researchReport скопируй точный answer Ref отчёта. bases[].result ссылается на id результата или открытого вопроса отчёта. go допускает обычную подготовку; conditional сохраняет существенные условия; no_go означает невозможность в исследованных условиях, а не ошибку ответа; insufficient_evidence сохраняет недостаточность основания, а не выдуманное отсутствие решений. У go условия пусты. Для каждого owner_choice дай options с устойчивыми optionId, label, consequences и choice: accept или decline; обязательно предложи отказ и принятие. Решения из discoveryContext.ownerDecisions относятся только к указанному прежнему conditional: не переноси их на новое условие по совпадению id и не выдавай за проверку внешнего факта. После выбора выпусти новый обоснованный вердикт. У conditional условия непусты: evidence требует проверяемого материала, owner_choice требует выбора условий владельцем. criterion говорит, что именно подтвердит условие; одного модельного fulfilled:true недостаточно. Утвердительный вердикт должен относиться к текущему исследованному варианту, ограничения сохраняются. supported у оценщика означает обоснованность любого из четырёх выводов, а не автоматическое разрешение проекта.",
    "Discovery идёт в концепцию без обоснованного разрешения или гоняет отрицательный вывод по кругу", discoveryVerdictSchema),
] satisfies FieldSpec[];

// V5 is first released with the research-to-preparation handoff; v4 stays literal.
export const DISCOVERY_PREPARATION = { ...UPSTREAM_MOMENT_DETAILS.discovery,
  prompt: UPSTREAM_MOMENT_DETAILS.discovery.prompt + " Разверни выбранный verdict.variant из discoveryContext в результаты, сценарии и внешние системы. Каждое ограничение принятого researchReport перенеси в preparation.constraints: rule сохраняет его смысл, basis точно копирует готовый адрес из discoveryContext.reportConstraints. Ограничение нельзя отбросить молча: для ошибочного или чужого варианту ограничения сначала переоткрывается отчёт. Дополнительные ограничения поручения сохраняй со своим основанием. Сохрани риски и оставшиеся неизвестные исследованного варианта с их moment. Учитывай точные решения владельца из discoveryContext.ownerDecisions, но выбор владельца не доказывает реализуемость.",
} satisfies FieldSpec;

// V6 preparation is filled by its stage tasks without mutating released schemas/prompts.
export const VERSION6_UPSTREAM_DETAILS = sealed({ ...UPSTREAM_MOMENT_DETAILS, discovery: DISCOVERY_PREPARATION,
  concept: { ...UPSTREAM_MOMENT_DETAILS.concept, schema: conceptApplicationsSchema,
    prompt: UPSTREAM_MOMENT_DETAILS.concept.prompt +
      ' Для каждого requirement явно укажи applications (в том числе [] при отсутствии назначения). basis копирует точный адрес из discoveryBasisCatalogue; appliedAt указывает только на собственные statement, benefit или acceptance. Покрой выбранный вариант и каждое ограничение каталога хотя бы одним предметным применением. Не меняй смысл ограничения: объясни в требовании, как оно действует на результат и критерий принятия.' },
}) as unknown as typeof UPSTREAM_MOMENT_DETAILS;

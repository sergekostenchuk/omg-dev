import type { Json } from "../canonical.js";
import type { FieldSpec } from "./discovery.js";

export const JOURNEY_VARIANTS = ["success", "first_use", "repeated_use", "reload_restart_resume", "cancel_stop_retry",
  "invalid_incomplete_input", "partial_success", "dependency_unavailable", "safe_failure", "crash_recovery",
  "unauthorized_adversarial", "operator_admin", "cli_api_agent", "migration_compatibility", "concurrent_replayed",
  "export_retention_deletion", "accessibility"] as const;
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

export const preparationSchema = object({
  problem: text, existingSituation: text,
  actors: list(actor, 1), outcomes: list(outcome, 1),
  journeys: object(Object.fromEntries(JOURNEY_VARIANTS.map(name => [name, variant]))),
  constraints: list(object({ id: text, rule: text, basis: text })),
  externalSystems: list(object({ id: text, purpose: text, inputs: texts(), outputs: texts(), availability: text })),
  risks: list(object({ id: text, consequence: text, affectedOutcome: text, mitigation: text })),
  unknowns: list(object({ id: text, question: text, consumer: text, blocksCurrentStage: { type: "boolean" }, resolution: text })),
});

export const sectionSchema = list(object({ id: text, title: text, requirements: list(object({ id: text, statement: text,
  benefit: text, beneficiary: text, outcome: text, acceptance: texts(1) }), 1) }), 1);

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

export const featurePreparationSchema = list(object({
  featureTitle: text, outcome: text, requirements: texts(1), behaviorContracts: texts(1), beneficiary: text, benefit: text,
  success: texts(1), failures: texts(1), interactions: list(object({ outcome: text, condition: text })),
  remainingQuestions: list(object({ question: text, consumer: text, blocksCurrentStage: { type: "boolean" } })),
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

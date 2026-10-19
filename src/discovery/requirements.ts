import { sealed } from "../om/refusal.js";
import { EngineError } from "../errors.js";
import type { FieldSpec } from "./discovery.js";
import { UPSTREAM_DETAILS, UPSTREAM_MOMENT_DETAILS, DISCOVERY_RESEARCH_FIELDS, DISCOVERY_PREPARATION, VERSION6_UPSTREAM_DETAILS, DISCOVERY_ANALOGUES_PROMPTS } from "./preparation-contracts.js";
import { mapDesignSchema } from "../graph/builder.js";
import { canonical, type Json } from "../canonical.js";
import { V7_CONTRACT_ERA, V7_REQUIREMENTS } from "./v7-contracts.js";

const text = { type: "string", minLength: 1 };
const texts = { type: "array", minItems: 1, uniqueItems: true, items: text };
export const UPSTREAM_STAGES = ["discovery", "concept", "operation-map", "specification", "features"] as const;
export type UpstreamStage = typeof UPSTREAM_STAGES[number];
// The same contracts generate research questions and validate their resulting stage fields.
export const LEGACY_REQUIREMENTS: Record<UpstreamStage, FieldSpec[]> = {
  discovery: [
    { field: "brief", kind: "fact", prompt: "Какой исходный текст описывает задачу? Выберите его в источнике.", risk: "Нет проверяемого исходного поручения", schema: text },
    { field: "objective", kind: "decision", prompt: "Какой результат вы хотите получить?", risk: "Не выбрана цель продукта", schema: text },
  ],
  concept: [
    { field: "audience", kind: "decision", prompt: "Для кого создаётся продукт?", risk: "Не определён пользователь", schema: text },
    { field: "outcome", kind: "decision", prompt: "Что пользователь сможет сделать?", risk: "Нет наблюдаемого результата", schema: text },
    { field: "acceptance", kind: "decision", prompt: "По каким признакам вы примете результат?", risk: "Не определены условия принятия", schema: texts },
  ],
  "operation-map": [
    { field: "journey", kind: "decision", prompt: "Какие действия приводят пользователя к результату?", risk: "Карта не связана с пользовательским путём", schema: texts },
  ],
  specification: [
    { field: "behavior", kind: "decision", prompt: "Какое поведение требуется реализовать?", risk: "Поведение не определено", schema: texts },
    { field: "constraints", kind: "decision", prompt: "Какие ограничения обязательны?", risk: "Не выбраны границы реализации", schema: texts },
  ],
  features: [
    { field: "features", kind: "decision", prompt: "Какие фичи обеспечивают это поведение?", risk: "Фичи не связаны с требованиями", schema: {
      type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["title", "outcome", "requirements"], properties: { title: text, outcome: text,
          requirements: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 0 } } } },
    } },
  ],
};
export const RESEARCH_CONTRACT_VERSION = 6;
export const VERSION2_REQUIREMENTS = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
  [...LEGACY_REQUIREMENTS[stage].map(spec => ({ ...spec, kind: spec.kind === "decision" && spec.field !== "objective" ? "design" as const : spec.kind })), UPSTREAM_DETAILS[stage]],
])) as Record<UpstreamStage, FieldSpec[]>;
export const VERSION3_REQUIREMENTS = { ...VERSION2_REQUIREMENTS, "operation-map": [...VERSION2_REQUIREMENTS['operation-map'], {
  field: "mapDesign", kind: "design", proof: "assessment", schema: mapDesignSchema as unknown as Json,
  prompt: "Построй полную L1-топологию из принятых участников, результатов, требований и сценариев. Выбери осмысленные блоки и контракты артефактов; свяжи их коннекторами и явными переходами успеха/отказа. Укажи пользу и получателя каждого блока, пути к успешному результату и безопасному отказу. Ссылайся на точные идентификаторы actors и requirements из предшествующих данных. Их реестры и идентичность графа подставляет движок, не копируй их в ответ. Не добавляй code refs, executable tests, L2/L3 или атомарные задачи на этом этапе.",
  risk: "Карта является линейным списком названий, а не исследованной топологией продукта",
} satisfies FieldSpec] };
export const VERSION4_REQUIREMENTS = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
  VERSION3_REQUIREMENTS[stage].map(spec => spec.field === UPSTREAM_DETAILS[stage].field ? UPSTREAM_MOMENT_DETAILS[stage] : spec),
])) as Record<UpstreamStage, FieldSpec[]>;

export const VERSION5_REQUIREMENTS: Record<UpstreamStage, FieldSpec[]> = { ...VERSION4_REQUIREMENTS,
  discovery: [...VERSION4_REQUIREMENTS.discovery.filter(spec => spec.field !== "preparation"),
    ...DISCOVERY_RESEARCH_FIELDS, DISCOVERY_PREPARATION],
};

// Future producers use separate values; changing v6 cannot alter paid v5 material.
export const VERSION6_REQUIREMENTS = sealed(Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
  VERSION5_REQUIREMENTS[stage].map(spec => spec.field === VERSION6_UPSTREAM_DETAILS[stage].field
    ? VERSION6_UPSTREAM_DETAILS[stage] : spec),
]))) as unknown as Record<UpstreamStage, FieldSpec[]>;
export const VERSION6_ANALOGUES_REQUIREMENTS = sealed(structuredClone({ ...VERSION6_REQUIREMENTS,
  discovery: VERSION6_REQUIREMENTS.discovery.map(spec => Object.hasOwn(DISCOVERY_ANALOGUES_PROMPTS, spec.field)
    ? { ...spec, prompt: DISCOVERY_ANALOGUES_PROMPTS[spec.field as keyof typeof DISCOVERY_ANALOGUES_PROMPTS] } : spec),
})) as unknown as Record<UpstreamStage, FieldSpec[]>;
export const REQUIREMENTS = VERSION6_ANALOGUES_REQUIREMENTS;

/** A saved complete question set selects one known edition; no prompt or schema is exempt. */
export function selectResearchRequirements(stage: UpstreamStage, version: number, specs: unknown): FieldSpec[] | null {
  if (!Array.isArray(specs) || !specs.every(spec => spec !== null && typeof spec === "object" && !Array.isArray(spec))) return null;
  const historical = { 1: LEGACY_REQUIREMENTS, 2: VERSION2_REQUIREMENTS, 3: VERSION3_REQUIREMENTS,
    4: VERSION4_REQUIREMENTS, 5: VERSION5_REQUIREMENTS };
  const tables = version === 6 ? [VERSION6_REQUIREMENTS, VERSION6_ANALOGUES_REQUIREMENTS]
    : Object.hasOwn(historical, version) ? [historical[version as keyof typeof historical]] : [];
  const saved = canonical(specs);
  for (const table of tables) {
    const expected = table[stage];
    if (expected && canonical(expected) === saved) return sealed(expected) as unknown as FieldSpec[];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Выбор эры производителя по стадии. Только новая подготовка читает это
// правило; эры сохранённых записей читаются таблицами выше и политикой
// производителя не переоцениваются.
// ---------------------------------------------------------------------------

/** Эра следующего исследовательского контракта; её таблица требований
 * появилась в DR2, но частична (D1–D2 стадии discovery), поэтому включённый
 * производитель по-прежнему отказывает до записи. */
export const NEXT_CONTRACT_ERA = V7_CONTRACT_ERA;

/** Кодовый выключатель производителя v7 по стадиям: последняя правка
 * программы (DR9) перечисляет здесь стадии с новым производителем. Тестовая
 * подмена идёт только явным параметром ProducerPolicy вызывающего пути —
 * обычная команда или ответ модели политику не переключают. */
const PRODUCER_V7_STAGES: readonly UpstreamStage[] = Object.freeze([]);

/** Политика производителя: какую эру новая подготовка пишет по стадии.
 * Стадия без записи — текущая RESEARCH_CONTRACT_VERSION. */
export type ProducerPolicy = Readonly<Partial<Record<UpstreamStage, number>>>;

const CODE_PRODUCER_POLICY: ProducerPolicy = Object.freeze(
  Object.fromEntries(PRODUCER_V7_STAGES.map(stage => [stage, NEXT_CONTRACT_ERA])));

/** Эра, которую сейчас производит новая подготовка этой стадии. */
export function producerContractEra(stage: UpstreamStage, policy?: ProducerPolicy): number {
  return (policy ?? CODE_PRODUCER_POLICY)[stage] ?? RESEARCH_CONTRACT_VERSION;
}

/** Таблица требований новой подготовки стадии по политике производителя.
 * Выбранная эра без своей ПОЛНОЙ таблицы — типизированный отказ
 * discovery_v7_producer_not_ready, а не драфт с чужим набором вопросов.
 * Частичная таблица v7 (DR2: D1–D2 стадии discovery) производства не открывает:
 * готовность выводится из покрытия всех стадий, не из наличия записей. */
export function producerRequirements(stage: UpstreamStage, policy?: ProducerPolicy): FieldSpec[] {
  const era = producerContractEra(stage, policy);
  if (era !== RESEARCH_CONTRACT_VERSION) {
    const table = era === NEXT_CONTRACT_ERA && V7_REQUIREMENTS.complete[stage] === true
      ? V7_REQUIREMENTS.fields[stage] : undefined;
    if (!table)
      throw new EngineError("discovery_v7_producer_not_ready",
        `The v${era} research producer for stage "${stage}" is not ready: its requirements table is incomplete`,
        { stage, era });
    return [...table] as FieldSpec[];
  }
  return REQUIREMENTS[stage];
}

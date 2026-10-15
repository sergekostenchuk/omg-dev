import { sealed } from "../om/refusal.js";
import type { FieldSpec } from "./discovery.js";
import { UPSTREAM_DETAILS, UPSTREAM_MOMENT_DETAILS, DISCOVERY_RESEARCH_FIELDS, DISCOVERY_PREPARATION, VERSION6_UPSTREAM_DETAILS } from "./preparation-contracts.js";
import { mapDesignSchema } from "../graph/builder.js";
import type { Json } from "../canonical.js";

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
export const REQUIREMENTS = VERSION6_REQUIREMENTS;

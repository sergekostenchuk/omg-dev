import type { FieldSpec } from "./discovery.js";

const text = { type: "string", minLength: 1 };
const texts = { type: "array", minItems: 1, uniqueItems: true, items: text };
export const UPSTREAM_STAGES = ["discovery", "concept", "operation-map", "specification", "features"] as const;
export type UpstreamStage = typeof UPSTREAM_STAGES[number];
// The same contracts generate research questions and validate their resulting stage fields.
export const REQUIREMENTS: Record<UpstreamStage, FieldSpec[]> = {
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

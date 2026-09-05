import type { FieldSpec } from "../discovery/discovery.js";
import type { Json } from "../canonical.js";
import { digest, canonical } from "../canonical.js";
import type { Graph } from "./model.js";
import { RefinementRelations } from "./relations.js";

export const REFINEMENT_CONTRACT_VERSION = 2;
const text: Json = { type: "string", minLength: 1 };
const object = (properties: Record<string, Json>): Json => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const list = (items: Json): Json => ({ type: "array", items });
export interface TechnicalGap { id: string; target: string; field: string; question: string; consumer: string; requiredFor: "current" | "next" }
export interface TechnicalReport {
  applicability: "applicable" | "not_applicable"; reason: string;
  facts: { id: string; claim: string; path: string }[];
  designs: { id: string; decision: string; benefit: string; consumer: string }[];
  gaps: TechnicalGap[];
}
export function deferredGap(graph: Graph, gap: TechnicalGap): boolean {
  if (gap.requiredFor !== "next") return false;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const relations = new RefinementRelations(graph);
  const inside = (child: string, ancestor: string) => relations.refines(child, ancestor);
  if (!nodes.has(gap.target) || !nodes.has(gap.consumer)
    || graph.horizon.some(node => inside(node, gap.target) || inside(node, gap.consumer))) return false;
  return graph.connectors.some(connector => connector.wakeTest && graph.tests.some(test => test.id === connector.wakeTest)
    && connector.bindings.some(binding => binding.anchor && graph.anchors.some(anchor => anchor.id === binding.anchor && anchor.outcome === connector.artifact)
      && inside(binding.producer.node, gap.target) && binding.consumers.some(consumer => inside(consumer.node, gap.consumer))));
}
export const technicalReportSchema: Json = object({ applicability: { enum: ["applicable", "not_applicable"] }, reason: text,
  facts: list(object({ id: text, claim: text, path: text })),
  designs: list(object({ id: text, decision: text, benefit: text, consumer: text })),
  gaps: list(object({ id: text, target: text, field: text, question: text, consumer: text, requiredFor: { enum: ["current", "next"] } })),
});
const question = (field: string, prompt: string, risk: string): FieldSpec => ({ field, kind: "design", proof: "assessment",
  prompt: `${prompt} Раздели наблюдаемые факты с реальными путями источников и проектируемые решения. Для решения укажи пользу и потребителя. Неизвестное сохрани адресным gap; неприменимость обоснуй.`, risk, schema: technicalReportSchema });
export const TECHNICAL_RESEARCH: Record<"R1" | "R2", FieldSpec[]> = {
  R1: [
    question("productDomain", "Исследуй сущности, инварианты, самостоятельные результаты, границы и владельцев изменений.", "Декомпозиция не соответствует предметной области"),
    question("actorsAndChannels", "Исследуй UI/CLI/API/агентские входы, операторов и все пути к защищаемым действиям.", "Пропущен пользователь или обходной вход"),
    question("runtime", "Исследуй процессы, workers, адаптеры, запуск, остановку, владение процессами и resume.", "Не определён жизненный цикл исполнения"),
    question("persistence", "Исследуй хранилища, схемы, миграции, sole writers, транзакции и восстановимые/производные данные.", "Конфликт записей и потеря состояния"),
    question("authority", "Исследуй идентичности, полномочия, проверки доступа, доверенные входы, внешние и необратимые действия.", "Полномочия или внешние действия не ограничены"),
    question("integrations", "Исследуй провайдеров, API, границы файловой системы, сети и процессов, версии контрактов и сред.", "Несовместимый или недоступный внешний потребитель"),
    question("recovery", "Исследуй аварийные окна, идемпотентность, повтор, откат, диагностику, cold reopen и двери восстановления оператора.", "Отказ оставляет продукт без восстановления"),
    question("delivery", "Исследуй поддерживаемые версии, миграции, развёртывание и обратную совместимость.", "Поставка нарушает существующее поведение"),
    question("evidenceAndTests", "Исследуй реальные product entrypoints, runners, fixtures, глубокие observables и известные классы дефектов.", "Тесты не доказывают рабочий продуктовый путь"),
  ],
  R2: [
    question("contractsAndConsumers", "Проследи текущий блок от production entrypoint до outcome и обратно к каждому producer/consumer. Раскрой схемы/версии, точные пути/символы, первые и дополнительные потребители.", "Ближайшая работа не имеет точных контрактов и потребителей"),
    question("authorityPaths", "Найди создание, проверку и завершение полномочий, все входы, возможные подмены и обходы в текущем блоке.", "Защищён только один путь вызова"),
    question("stateAndRecovery", "Раскрой state/writer/transaction/commit, retry/replay, check-then-act, аварии до/после записи, cold reopen, typed failures, correction owner и восстановление оператора.", "Граница атомарности или восстановления неизвестна"),
    question("connectivityAndProof", "Раскрой missing/extra/foreign/stale/forged/replay outcomes, положительные и контрфактические проверки, настоящие test entrypoints, OS-process/network/paid требования, локальные альтернативы, будущие зависимости, anchors и условия пробуждения.", "Результат нельзя доказать или интегрировать без будущей работы"),
  ],
};
export function refinementQuestions(level: "R1" | "R2", gaps: TechnicalGap[] = []): FieldSpec[] {
  const groups = new Map<string, TechnicalGap[]>();
  if (level === "R2") for (const gap of gaps) {
    const key = canonical([gap.target, gap.field]); const group = groups.get(key) ?? [];
    if (!group.some(item => canonical(item) === canonical(gap))) group.push(gap);
    groups.set(key, group);
  }
  const extra = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => {
    const targets = group.map(({ target, field, consumer, question }) => ({ target, field, consumer, question }))
      .sort((left, right) => canonical(left).localeCompare(canonical(right)));
    return { ...question(`gap_${digest(key).slice(0, 24)}`, targets.map(target =>
      `Разреши пробел ${target.target}/${target.field} для потребителя ${target.consumer}: ${target.question}`).join("\n"), "Не разрешены обязательства потребителей из R1"), targets };
  });
  return [...TECHNICAL_RESEARCH[level], ...extra];
}

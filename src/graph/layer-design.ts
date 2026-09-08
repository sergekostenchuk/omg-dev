import { canonical, type Json } from "../canonical.js";
import type { FieldSpec } from "../discovery/discovery.js";
import { requireCondition } from "../errors.js";
import { mapDesignSchema } from "./builder.js";
import { LEVEL, type Graph } from "./model.js";
import { projectGraph } from "./project.js";
import { requireGraph } from "./validate.js";
import { RefinementRelations } from "./relations.js";
import type { ObligationHandoff } from './obligation-handoff.js';
import { taskObligationBindingSchema } from './task-obligation-model.js';
import { taskBindingId, taskObligations } from './task-obligations.js';
import { L3_ASSEMBLY, assembleL3, encodeLayerRelations, connectorRefSchema, type LayerAssembly } from './layer-assembly.js';

export const LAYER_DESIGN_VERSION = 1;
export function layerDesignSpec(level: 2 | 3, handoff: ObligationHandoff | null = null): FieldSpec {
  const schema = structuredClone(mapDesignSchema);
  if (level === 3) {
    const node = schema.properties['nodes'].items;
    const work = structuredClone(node); work.properties.kind = { const: 'work' };
    work.required = work.required.filter((key: string) => !['tests', 'implements'].includes(key));
    node.properties.kind = { enum: ['product', 'block', 'operation'] };
    schema.properties['nodes'].items = { oneOf: [node, work] };
    const refs = { type: 'array', uniqueItems: true, items: connectorRefSchema };
    const test = schema.properties['tests'].items;
    test.properties.covers = refs;
    test.properties.contract.properties.counterfactuals.items.properties.connector = connectorRefSchema;
    const join = schema.properties['joins'].items;
    join.properties.condition = { type: 'string', minLength: 1, maxLength: 4000 };
    for (const key of ['connectors', 'required', 'optional']) join.properties[key] = refs;
    join.required = join.required.filter((key: string) => key !== 'connectors');
  }
  if (level === 3) schema.properties['horizon'] = { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } };
  const carried = level === 3 && handoff ? taskObligations(handoff) : null;
  if (carried) {
    schema.properties['researchObligations'] = { type: 'array', maxItems: carried.length, items: carried.length ? { oneOf: carried.map(item => {
      const binding = structuredClone(taskObligationBindingSchema);
      binding.properties.id = { const: taskBindingId(item) }; binding.properties.scope = { const: item.scope }; binding.properties.obligation = { const: item.obligation };
      return binding;
    }) } : false };
    schema.required.push('researchObligations');
  }
  const spec: FieldSpec = { field: "layerDesign", kind: "design", proof: "assessment", schema: schema as Json, ...(level === 3 ? { layerAssembly: L3_ASSEMBLY } : {}),
    risk: "Исследование не превращается в полную связную декомпозицию с проверяемыми результатами",
    prompt: `Построй L${level} той же карты по принятым результатам R${level - 1}, ТЗ и фичам. Верни полный граф до L${level}, без полей version/id/title/actors/requirements: их наследует движок. Сохрани верхние уровни без изменения. ${level === 2
      ? "Раскрой операции, полномочия, данные, входы/выходы и пути отказа. Не придумывай атомарные задачи L3 заранее."
      : "Раскрой текущий горизонт атомарных результатов с точными code refs, тестовыми контрактами, ресурсами, последовательными и отложенными связями. Planned код обозначай planned. Не подставляй фиктивные доказательства существующего кода."} Внутренние связи допустимы внутри одного родителя; межблочные связи уточняют прежние connectors. Не закрывай пробелы статусом ready: сохрани неизвестное в исследовании и верни его в R${level - 1}.` + (carried ? `\nresearchObligations связывает исходные переносы с конкретными work и их тестами. Используй только выданные id/scope/obligation. Сохрани kind, moment, ответственного, wake и полный returnCondition; модель их не меняет. Для post-implementation-proof выбери тестовые контракты, действительно проверяющие всё условие при приёмке соответствующей реализации; доказательство исполнения сейчас не требуется. Не пробуждённое обязательство остаётся в исходном handoff и не требует реализации вне текущей области. Назначения: ${JSON.stringify(carried.map(item => ({ id: taskBindingId(item), requirement: item })))}` : ''),
  };
  if (level === 3) spec.prompt += '\nСборка typed-relations-v1: test.covers, counterfactual.connector и ссылки join имеют вид {kind:"connector",id:"точный id"}; {kind:"journey",id:"..."} принадлежит другому типу и здесь запрещён. У теста один владелец test.node. work.tests код выводит по владельцу; не приписывай групповой тест другим узлам. Обязательные implements по outcome и явно реализуемым ролям добавляет код. У нового join задай condition, required, optional и все failures: required/optional точно разделяют входы, обязательных по умолчанию нет. Поле connectors код выводит из входящих связей; смысл условия и восстановления сохраняется без подстановок.';
  return spec;
}

export function layerDesignOf(graph: Graph, level: 2 | 3, assembly?: LayerAssembly): Json {
  const { id: _id, title: _title, level: _level, version: _version, actors: _actors, requirements: _requirements, ...design } = projectGraph(graph, level);
  return (assembly === L3_ASSEMBLY ? encodeLayerRelations(design) : structuredClone(design)) as unknown as Json;
}

export function composeLayer(base: Graph, level: 2 | 3, design: unknown, assembly?: LayerAssembly): Graph {
  requireCondition(base.version === 2, "graph_upgrade_required", "Automatic refinement needs an enriched map");
  requireCondition(design && typeof design === "object" && !Array.isArray(design), "layer_design_missing", "A researched layer design is required");
  requireCondition(!["version", "id", "title", "actors", "requirements"].some(key => Object.hasOwn(design, key)),
    "derived_field_conflict", "Layer identity, actors and requirements are inherited from the accepted map");
  requireCondition(assembly === undefined || level === 3 && assembly === L3_ASSEMBLY,
    'layer_assembly_invalid', 'Typed assembly belongs only to the declared L3 contract');
  const assembled = assembly ? assembleL3(base, design as Record<string, any>) : design;
  const graph = requireGraph({ ...assembled, version: base.version, id: base.id, title: base.title, actors: base.actors, requirements: base.requirements });
  requireCondition(graph.nodes.some(node => LEVEL[node.kind] === level) && graph.nodes.every(node => LEVEL[node.kind] <= level),
    "layer_detail_invalid", `The design must contain L${level} and cannot author future layers`);
  requireCondition(level !== 3 || graph.horizon.length > 0, "horizon_empty", "L3 needs a researched nearest execution horizon");
  const upper = (level - 1) as 1 | 2;
  requireCondition(canonical(projectGraph(base, upper)) === canonical(projectGraph(graph, upper)),
    "upper_layer_drift", "Refinement cannot silently rewrite accepted upper-layer results, contracts or responsibility");
  const relations = new RefinementRelations(graph);
  if (level === 2) {
    for (const block of graph.nodes.filter(node => node.kind === "block")) requireCondition(graph.nodes.some(node => node.kind === "operation"
      && relations.refines(node.id, block.id) && node.outcome === block.outcome), "layer_outcome_uncovered", `L2 does not realize the result of ${block.id}`);
  }
  const active = graph.nodes.filter(node => graph.horizon.includes(node.id));
  for (const connector of graph.connectors) for (const binding of connector.bindings.filter(binding => binding.level === upper)) {
    // An upper dependency remains represented even when its other end is sleeping.
    // `realizes` may fold both endpoint roles into one atomic implementation.
    if (level === 2 || active.some(node => [binding.producer, ...binding.consumers].some(endpoint => relations.refines(node.id, endpoint.node)))) {
      const lower = connector.bindings.filter(binding => binding.level === level);
      requireCondition(lower.some(item => relations.refines(item.producer.node, binding.producer.node))
        && binding.consumers.every(consumer => lower.some(item => item.consumers.some(node => relations.refines(node.node, consumer.node)))),
      "layer_connector_uncovered", `L${level} loses a producer or consumer of ${connector.id}`);
    }
  }
  if (level === 3) for (const node of active) for (const port of node.ports.filter(port => port.direction === "in")) {
    requireCondition(graph.connectors.some(connector => connector.bindings.some(binding => binding.level === 3
      && binding.consumers.some(endpoint => endpoint.node === node.id && endpoint.port === port.id))),
    "layer_port_unbound", `The active input ${node.id}/${port.id} has no producer binding`);
  }
  // Reconfirming an unchanged layer preserves its already authored descendants.
  // A changed layer replaces only the current graph revision; prior graphs remain in SQLite.
  return canonical(projectGraph(base, level)) === canonical(projectGraph(graph, level)) ? structuredClone(base) : graph;
}

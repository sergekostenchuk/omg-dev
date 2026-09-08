import { canonical } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import type { Graph } from './model.js';

export const L3_ASSEMBLY = 'typed-relations-v1' as const;
export type LayerAssembly = typeof L3_ASSEMBLY;
export const connectorRef = (id: string) => ({ kind: 'connector' as const, id });
export const connectorRefSchema = { type: 'object', additionalProperties: false, required: ['kind', 'id'],
  properties: { kind: { const: 'connector' }, id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' } } };

function incoming(graph: Pick<Graph, 'connectors'>, level: number) {
  const result = new Map<string, Set<string>>();
  for (const connector of graph.connectors) for (const binding of connector.bindings) if (binding.level === level && binding.anchor === null)
    for (const consumer of binding.consumers) {
      const ids = result.get(consumer.node) ?? new Set<string>(); ids.add(connector.id); result.set(consumer.node, ids);
    }
  return result;
}

/** The designer sees distinct reference domains and the already known joins
 * before its first call. Lower ownership and join conditions remain its design. */
export function layerRelationContext(graph: Graph, level: 1 | 2 | 3) {
  return { connectors: graph.connectors.map(item => connectorRef(item.id)),
    journeys: (graph.journeys ?? []).map(item => ({ kind: 'journey' as const, id: item.id })),
    joinRequirements: [...incoming(graph, level)].filter(([, inputs]) => inputs.size >= 3).map(([consumer, inputs]) => ({
      consumer, connectors: [...inputs].sort().map(connectorRef),
      requested: ['condition', 'required', 'optional', 'failures'],
      instruction: 'When refining this consumer, define the actual join condition and classify its inputs; no input is required by default.' })) };
}

/** Encode only the authoring view. Stored graphs and historical layers retain
 * their string identities; no canonical schema migration is needed. */
export function encodeLayerRelations(design: Record<string, any>): Record<string, any> {
  const result = structuredClone(design);
  for (const test of result['tests'] ?? []) {
    test.covers = test.covers.map(connectorRef);
    for (const pair of test.contract?.counterfactuals ?? []) pair.connector = connectorRef(pair.connector);
  }
  for (const join of result['joins'] ?? []) for (const key of ['connectors', 'required', 'optional'])
    if (join[key] !== undefined) join[key] = join[key].map(connectorRef);
  return result;
}

export function assembleL3(base: Graph, input: Record<string, any>): Record<string, any> {
  const design = structuredClone(input);
  requireCondition(['nodes', 'tests', 'connectors', 'joins', 'edges'].every(key => Array.isArray(design[key])
    && design[key].every((item: unknown) => item && typeof item === 'object' && !Array.isArray(item))),
    'layer_design_invalid', 'Typed L3 needs its complete collections after delta assembly');
  const connectors = new Set<string>(design['connectors'].map((item: any) => item.id));
  const decode = (value: any): string => {
    requireCondition(value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'id,kind' && value.kind === 'connector' && typeof value.id === 'string'
      && connectors.has(value.id), 'layer_connector_ref_invalid', 'A connector reference must name a connector, never a journey or foreign identity');
    return value.id;
  };
  for (const test of design['tests']) {
    requireCondition(Array.isArray(test.covers) && test.contract && Array.isArray(test.contract.counterfactuals),
      'layer_connector_ref_invalid', 'A test needs explicit connector references and its counterfactual contract');
    test.covers = test.covers.map(decode);
    for (const pair of test.contract.counterfactuals) {
      requireCondition(pair && typeof pair === 'object' && !Array.isArray(pair), 'layer_counterfactual_ref_invalid', 'A counterfactual needs an explicit connector');
      pair.connector = decode(pair.connector);
      requireCondition(test.covers.includes(pair.connector), 'layer_counterfactual_ref_invalid', 'A counterfactual belongs to this same test connector set');
    }
  }
  const nodes = new Map<string, any>(design['nodes'].map((node: any) => [node.id, node]));
  for (const node of nodes.values()) if (node.kind === 'work') {
    node.tests = design['tests'].filter((test: any) => test.node === node.id).map((test: any) => test.id);
    const known = (base.requirements ?? []).filter(item => item.outcome === node.outcome).map(item => item.id);
    for (const edge of design['edges']) if (edge.relation === 'realizes' && edge.source === node.id)
      known.push(...(nodes.get(edge.target)?.implements ?? []));
    requireCondition(node.implements === undefined || Array.isArray(node.implements), 'layer_requirement_invalid', 'Additional requirement identities must be an array');
    node.implements = [...new Set([...(node.implements ?? []), ...known])].sort();
  }
  const inputs = incoming({ connectors: design['connectors'] }, 3);
  for (const join of design['joins']) {
    for (const key of ['connectors', 'required', 'optional']) if (join[key] !== undefined) {
      requireCondition(Array.isArray(join[key]), 'layer_join_inputs_invalid', 'Join inputs must be typed connector arrays');
      join[key] = join[key].map(decode);
    }
    if (nodes.get(join.consumer)?.kind !== 'work') continue;
    const actual = [...(inputs.get(join.consumer) ?? [])].sort();
    requireCondition(typeof join.condition === 'string' && join.condition.trim() && Array.isArray(join.required) && Array.isArray(join.optional),
      'layer_join_design_required', 'A concrete join needs a designed condition and explicit required/optional inputs');
    requireCondition(canonical([...join.required, ...join.optional].sort()) === canonical(actual),
      'layer_join_inputs_invalid', 'Required and optional inputs must partition the actual incoming connectors exactly once');
    if (join.connectors !== undefined) requireCondition(canonical([...join.connectors].sort()) === canonical(actual),
      'layer_join_inputs_invalid', 'Declared join identities must agree with the actual incoming connectors');
    join.connectors = actual; // Only identities are derived; conditions/failures remain untouched.
  }
  const missing = [...inputs].filter(([consumer, ids]) => ids.size >= 3 && !design['joins'].some((join: any) => join.consumer === consumer));
  if (missing.length) throw new EngineError('layer_join_design_required', 'Describe the missing joins before structural graph validation',
    missing.map(([consumer, ids]) => ({ consumer, connectors: [...ids].sort().map(connectorRef), requested: ['condition', 'required', 'optional', 'failures'] })));
  return design;
}

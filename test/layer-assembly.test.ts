import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { layerDesignOf, layerDesignSpec, composeLayer } from '../src/graph/layer-design.js';
import { L3_ASSEMBLY, layerRelationContext, assembleL3 } from '../src/graph/layer-assembly.js';
import { projectGraph } from '../src/graph/project.js';
import { validateGraph } from '../src/graph/validate.js';
import type { Graph } from '../src/graph/model.js';

function fixture() {
  const full = enrichedGraph(exampleGraph('p'), 'p');
  const { level: _level, ...upper } = projectGraph(full, 2);
  return { full, base: upper as Graph, design: layerDesignOf(full, 3, L3_ASSEMBLY) as any };
}

test('the L3 authoring schema distinguishes connector references from journey references without changing L2', () => {
  const f = fixture(), validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(layerDesignSpec(3).schema as object);
  assert.equal(validate(f.design), true);
  const wrong = structuredClone(f.design); wrong.tests.find((item: any) => item.covers.length).covers[0].kind = 'journey';
  assert.equal(validate(wrong), false);
  const l2 = layerDesignSpec(2);
  assert.equal(l2.layerAssembly, undefined);
  assert.equal(new Ajv({ strict: true, allowUnionTypes: true }).compile(l2.schema as object)(layerDesignOf(f.full, 2)), true);
  assert.equal((l2.schema as any).properties.joins.items.properties.condition, undefined);
});

test('the builder derives work test ownership and known outcome requirements, while preserving upper layers and planned code', () => {
  const f = fixture(), nodes = f.design.nodes.filter((node: any) => node.kind === 'work');
  for (const node of nodes) {
    delete node.tests;
    // Only requirements fixed by this declared outcome are mechanically known.
    // An intermediate result still needs the designer's explicit traceability.
    if (f.base.requirements!.some(item => item.outcome === node.outcome)) delete node.implements;
  }
  nodes[1].tests = [nodes[0].id + '-test'];
  const before = structuredClone(f.design);
  const built = composeLayer(f.base, 3, f.design, L3_ASSEMBLY);
  for (const node of built.nodes.filter(node => node.kind === 'work')) {
    assert.deepEqual(node.tests, built.tests.filter(item => item.node === node.id).map(item => item.id));
    for (const requirement of built.requirements!.filter(item => item.outcome === node.outcome)) assert.ok(node.implements!.includes(requirement.id));
    assert.deepEqual(node.code, f.full.nodes.find(item => item.id === node.id)!.code);
  }
  assert.deepEqual(projectGraph(built, 2), projectGraph(f.base, 2));
  assert.deepEqual(f.design, before, 'Assembly must not rewrite the paid source answer');
  const drift = structuredClone(f.design); drift.nodes.find((node: any) => node.kind === 'operation').purpose = 'changed accepted purpose';
  assert.throws(() => composeLayer(f.base, 3, drift, L3_ASSEMBLY), { code: 'upper_layer_drift' });
});

test('a journey disguised as a connector and a counterfactual borrowed from another test set are rejected before graph findings', () => {
  const f = fixture();
  const disguised = structuredClone(f.design); disguised.tests.find((item: any) => item.covers.length).covers[0].id = f.full.journeys![0]!.id;
  assert.throws(() => composeLayer(f.base, 3, disguised, L3_ASSEMBLY), { code: 'layer_connector_ref_invalid' });
  const unbound = structuredClone(f.design), chosen = unbound.tests.find((item: any) => item.contract.counterfactuals.length);
  chosen.covers = [];
  assert.throws(() => composeLayer(f.base, 3, unbound, L3_ASSEMBLY), { code: 'layer_counterfactual_ref_invalid' });
});

function joined() {
  const full = enrichedGraph(exampleGraph('p'), 'p'), flow = full.connectors[0]!;
  const ids = [flow.id, 'p-flow-second', 'p-flow-third'];
  for (const id of ids.slice(1)) full.connectors.push({ ...structuredClone(flow), id });
  for (const check of full.tests) if (check.covers.includes(flow.id)) check.covers.push(...ids.slice(1));
  const failures = { missing: 'Missing required input: recover independently of optional data', extra: 'Reject extra input', foreign: 'Reject foreign input',
    stale: 'Refuse stale input', duplicate: 'Reject duplicate input', returnsTo: 'p-refusal-block' };
  for (const binding of flow.bindings) for (const consumer of binding.consumers) full.joins.push({ id: 'join-' + consumer.node, consumer: consumer.node,
    connectors: [...ids], failures: structuredClone(failures), ...(binding.level === 3 ? {
      condition: 'Proceed with the primary input; use optional inputs only when present and valid', required: [ids[0]!], optional: ids.slice(1) } : {}) });
  assert.deepEqual(validateGraph(full).findings, []);
  const { level: _level, ...base } = projectGraph(full, 2);
  const design = layerDesignOf(full, 3, L3_ASSEMBLY) as any;
  return { full, base: base as Graph, design, join: design.joins.find((item: any) => item.consumer === 'p-consume-work'), ids };
}

test('known join requests are present before design and assembly derives identities without changing optionality or recovery', () => {
  const f = joined(), context = layerRelationContext(f.base, 2);
  assert.deepEqual(context.joinRequirements[0]!.connectors.map(item => item.id), [...f.ids].sort());
  assert.ok(context.connectors.every(item => item.kind === 'connector')); assert.ok(context.journeys.every(item => item.kind === 'journey'));
  const { connectors: _connectors, ...meaning } = structuredClone(f.join); delete f.join.connectors;
  const built = composeLayer(f.base, 3, f.design, L3_ASSEMBLY), join = built.joins.find(item => item.consumer === 'p-consume-work')!;
  assert.deepEqual(join.connectors, [...f.ids].sort());
  assert.equal(join.condition, meaning.condition); assert.deepEqual(join.failures, meaning.failures);
  assert.deepEqual(join.required, [f.ids[0]]); assert.deepEqual(join.optional, f.ids.slice(1));
  assert.deepEqual(projectGraph(built, 2), projectGraph(f.base, 2));
  const missing = structuredClone(f.design); missing.joins = missing.joins.filter((item: any) => item.consumer !== 'p-consume-work');
  assert.throws(() => composeLayer(f.base, 3, missing, L3_ASSEMBLY), (error: any) =>
    error.code === 'layer_join_design_required' && error.details[0].consumer === 'p-consume-work');
  const unspecified = structuredClone(f.design); delete unspecified.joins.find((item: any) => item.consumer === 'p-consume-work').required;
  assert.throws(() => composeLayer(f.base, 3, unspecified, L3_ASSEMBLY), { code: 'layer_join_design_required' });
});

test('FJ1 rows 7/8/11: native works remain strict inside and outside the horizon, including identity-looking JSON', () => {
  for (const outside of [false, true]) {
    const f = joined(); if (outside) f.design.horizon = [];
    for (const field of ['condition', 'required', 'optional']) {
      const bad = structuredClone(f.design), join = bad.joins.find((item: any) => item.consumer === f.join.consumer);
      delete join[field]; join.identity = true; bad.identityJoins = [join.consumer];
      assert.throws(() => assembleL3(f.base, bad), { code: 'layer_join_design_required' });
    }
    const bad = structuredClone(f.design); bad.joins.find((item: any) => item.consumer === f.join.consumer).required = [];
    assert.throws(() => assembleL3(f.base, bad), { code: 'layer_join_inputs_invalid' });
    const missing = structuredClone(f.design); missing.joins = missing.joins.filter((item: any) => item.consumer !== f.join.consumer);
    assert.throws(() => assembleL3(f.base, missing), { code: 'layer_join_design_required' });
    for (const count of [1, 2]) {
      const few = structuredClone(missing);
      for (const connector of few.connectors.filter((item: any) => f.ids.slice(count).includes(item.id)))
        connector.bindings = connector.bindings.filter((binding: any) => binding.level !== 3);
      assert.doesNotThrow(() => assembleL3(f.base, few));
    }
  }
});

test('FJ1 row 16: identity direct inputs deduplicate flows and ignore self and sleeping deliveries; ordinary native inputs retain their era', () => {
  const f = joined(), id = f.join.consumer, ids = [...f.ids].sort();
  const expected: Graph['joins'][number] = { id: f.join.id, consumer: id, connectors: ids, failures: structuredClone(f.join.failures) };
  f.join.connectors = ids.map(id => ({ kind: 'connector', id }));
  delete f.join.condition; delete f.join.required; delete f.join.optional;
  const source = f.design.connectors.find((item: any) => item.id === f.ids[0]);
  const direct = source.bindings.find((binding: any) => binding.level === 3);
  source.bindings.push(structuredClone(direct), { ...structuredClone(direct), anchor: 'sleeping' });
  const self = structuredClone(source); self.id = 'self-only';
  self.bindings = [{ ...structuredClone(direct), producer: { ...direct.producer, node: id } }];
  f.design.connectors.push(self);
  const context = new Map([[id, expected]]), before = structuredClone(f.design);
  const actual = assembleL3(f.base, f.design, context);
  assert.deepEqual(actual.joins.find((join: any) => join.consumer === id), expected);
  assert.deepEqual(f.design, before);
  const reverse = structuredClone(f.design); reverse.connectors.reverse();
  for (const connector of reverse.connectors) connector.bindings.reverse();
  assert.deepEqual(assembleL3(f.base, reverse, context).joins, actual.joins);
  assert.throws(() => assembleL3(f.base, f.design), { code: 'layer_join_design_required' });
  assert.throws(() => assembleL3(f.base, f.design, new Map([[id, { ...expected, connectors: [] }]])), { code: 'layer_join_inputs_invalid' });
});

const text = { type: "string", minLength: 1, maxLength: 4000 };
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" };
const ids = { type: "array", uniqueItems: true, maxItems: 10000, items: id };
const array = (items: object) => ({ type: "array", maxItems: 10000, items });
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false,
  required: Object.keys(properties), properties });
const nullableId = { anyOf: [id, { type: "null" }] };
const endpoint = object({ node: id, port: id });

export const commandSchema = object({ executable: text, args: array({ type: "string" }) });
const testSchema = object({ id, node: id, command: commandSchema, covers: ids });
testSchema.properties['obligations'] = { type: "array", uniqueItems: true, items: { enum: ["outcome", "durable_cold_read", "restart_cold", "provider_safety"] } };
export const graphSchema = object({
  version: { const: 1 }, id, title: text, horizon: ids,
  contracts: array(object({ id, schema: { type: ["object", "boolean"] } })),
  nodes: array(object({ id, kind: { enum: ["product", "block", "operation", "work"] }, parent: nullableId,
    title: text, outcome: id,
    boundary: object({ authority: id, writer: id, rollback: id, state: { enum: ["transient", "durable"] }, provider: { type: "boolean" } }),
    ports: array(object({ id, direction: { enum: ["in", "out"] }, contract: id })),
    code: array(object({ path: text, access: { enum: ["read", "write"] }, status: { enum: ["existing", "planned"] } })),
    tests: ids,
  })),
  artifacts: array(object({ id, contract: id, external: { type: "boolean" }, terminal: { type: "boolean" } })),
  connectors: array(object({ id, artifact: id, returnsTo: id, wakeTest: nullableId,
    bindings: { ...array(object({ level: { enum: [1, 2, 3] }, producer: endpoint,
      consumers: { ...array(endpoint), minItems: 1 }, anchor: nullableId })), minItems: 1 },
  })),
  anchors: array(object({ id, owner: id, outcome: id, test: id })),
  joins: array(object({ id, consumer: id, connectors: { ...ids, minItems: 1 } })),
  tests: array(testSchema),
});

export const graphV2Schema = structuredClone(graphSchema) as { type: string; additionalProperties: boolean; required: string[]; properties: Record<string, any> };
graphV2Schema.properties['version'] = { const: 2 };
const properties = graphV2Schema.properties;
const texts = { type: "array", items: text, minItems: 1 };
const addRequired = (schema: { properties: Record<string, unknown>; required: string[] }, fields: Record<string, unknown>) => {
  Object.assign(schema.properties, fields); schema.required.push(...Object.keys(fields));
};
addRequired(properties['nodes'].items, { purpose: text, benefit: text, beneficiary: id, implements: ids });
properties['nodes'].items.properties.code.items.properties.symbol = text;
const codeRefSchema = properties['nodes'].items.properties.code.items;
properties['connectors'].items.properties.bindings.items.properties.producer.properties.codeRef = structuredClone(codeRefSchema);
properties['connectors'].items.properties.bindings.items.properties.consumers.items.properties.codeRef = structuredClone(codeRefSchema);
addRequired(properties['artifacts'].items, { kind: id, purpose: text,
  durability: { enum: ["durable_source", "durable_draft", "versioned", "immutable", "reconstructible", "evidence", "recoverable", "capability"] },
  sensitivity: { enum: ["public", "project_internal", "restricted"] } });
addRequired(properties['joins'].items, { failures: object({ missing: text, extra: text, foreign: text, stale: text, duplicate: text, returnsTo: id }) });
addRequired(properties['tests'].items, { contract: object({ given: texts, when: text, then: texts, forbiddenEffects: texts,
  entrypoint: object({ kind: { enum: ["cli", "api", "route", "product_caller"] }, path: text, symbol: { anyOf: [text, { type: "null" }] }, status: { enum: ["existing", "planned"] } }),
  counterfactuals: array(object({ connector: id, mutation: { enum: ["remove", "revoke", "substitute"] }, expectedFailure: text, command: commandSchema })),
  resourceClass: { enum: ["pure", "own_dirs", "exclusive"] }, resources: ids,
}) });
addRequired(graphV2Schema, {
  actors: array(object({ id, role: text, channels: texts })),
  requirements: array(object({ id, section: id, outcome: id, beneficiary: id, statement: text })),
  edges: array(object({ id, relation: { enum: ["requires", "realizes", "on_success", "on_failure", "returns_to"] }, source: id, target: id, condition: text })),
  journeys: array(object({ id, actor: id, variant: text, entry: id, path: { ...ids, minItems: 1, uniqueItems: false }, outcome: id, terminal: { enum: ["success", "safe_failure", "recovery"] } })),
  transfers: array(object({ id, path: text, from: id, to: id, condition: { const: "producer_committed" } })),
  packets: array(object({ id, unit: id, purpose: text, writePaths: { ...array(text), minItems: 1, uniqueItems: true } })),
});

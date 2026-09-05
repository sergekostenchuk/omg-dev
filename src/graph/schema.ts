const text = { type: "string", minLength: 1, maxLength: 4000 };
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" };
const ids = { type: "array", uniqueItems: true, maxItems: 10000, items: id };
const array = (items: object) => ({ type: "array", maxItems: 10000, items });
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false,
  required: Object.keys(properties), properties });
const nullableId = { anyOf: [id, { type: "null" }] };
const endpoint = object({ node: id, port: id });

export const commandSchema = object({ executable: text, args: array({ type: "string" }) });
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
  tests: array(object({ id, node: id, command: commandSchema, covers: ids })),
});

/** One wire contract shared by the action parser and the model's read instructions. */
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const text = { type: 'string', minLength: 1 };
const ref = object({ id: text, revision: { type: 'integer', minimum: 1 },
  hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
const bundleItem = (properties: Record<string, unknown>) => {
  const schema = object(properties);
  schema.properties['range'] = object({ start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 0 } });
  return schema;
};
const contextRead = object({ action: { const: 'read_context' }, record: ref, pointer: { type: 'string' } });
contextRead.properties['purpose'] = text;
const contextReadPage = object({ offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1 } });
contextReadPage.properties['encoding'] = { const: 'canonical-json' };
contextRead.properties['page'] = contextReadPage;
export const RESEARCH_READ_SCHEMAS = [
  object({ action: { const: 'read_bundle' }, purpose: text,
    inputs: { type: 'array', minItems: 1, items: { oneOf: [
      bundleItem({ path: text, media: { enum: ['text/plain', 'application/json'] } }),
      bundleItem({ source: ref })] } } }), contextRead,
  object({ action: { const: 'search' }, query: text }),
  object({ action: { const: 'read_source' }, source: ref,
    start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } }),
  object({ action: { const: 'read' }, path: text, media: { enum: ['text/plain', 'application/json'] } })
];

export const RESEARCH_READ_INSTRUCTION = '\nAllowed read actions follow this exact JSON Schema. Required fields are listed in required; every other field is forbidden unless listed in properties. '
  + 'Use exact saved references from the inventory. Text start/end and string page offsets/limits count UTF-16 code units; ranges are half-open [start,end). Array pages count items. '
  + 'read_source requires source, start and end; purpose is not allowed on read_source. read_bundle requires purpose; read_context permits an optional purpose and page. '
  + JSON.stringify({ oneOf: RESEARCH_READ_SCHEMAS });

import { RESEARCH_READ_SCHEMAS } from './research-read-contract.js';

/** Unchanged parser forms, also delivered to new research requests. */
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const text = { type: 'string', minLength: 1 };
const ref = object({ id: text, revision: { type: 'integer', minimum: 1 },
  hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
const selector = { oneOf: [object({ kind: { const: 'json-pointer' }, pointer: { type: 'string' } }),
  object({ kind: { const: 'text-range' }, start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 1 } })] };
// Keep the wire schema here so both the producer and historical reader use
// this parser without importing layer-delta (which imports consumer modules).
const deltaKeys = ['nodes', 'connectors', 'contracts', 'artifacts', 'edges', 'journeys',
  'joins', 'anchors', 'tests', 'packets', 'transfers', 'researchObligations'] as const;
const deltaCollections = (items: object) => ({ type: 'object', additionalProperties: false,
  properties: Object.fromEntries(deltaKeys.map(key => [key, { type: 'array', items }])) });
const answerDelta = object({ action: { const: 'answer_delta' }, question: text, base: ref,
  upserts: deltaCollections({ type: 'object', required: ['id'], properties: { id: text } }),
  removes: deltaCollections(text),
  citations: { type: 'array', minItems: 1, items: object({ source: ref, selector }) } });
answerDelta.properties['revises'] = ref;
answerDelta.properties['horizon'] = { type: 'array', minItems: 1, uniqueItems: true, items: text };

export const RESEARCH_ACTION_SCHEMA = { oneOf: [
  ...RESEARCH_READ_SCHEMAS,
  object({ action: { const: 'read_plan' }, question: text,
    reads: { type: 'array', minItems: 1, maxItems: 16, items: { oneOf: RESEARCH_READ_SCHEMAS } } }),
  object({ action: { const: 'synthesize' }, question: text }),
  object({ action: { const: 'need_research' }, question: text,
    missing: { type: 'array', minItems: 1, items: text } }),
  answerDelta,
  object({ action: { const: 'checkpoint' }, question: text, value: {},
    citations: { type: 'array', items: object({ source: ref, selector }) },
    unresolved: { type: 'array', items: text } }),
  object({ action: { const: 'answer' }, question: text, value: {},
    citations: { type: 'array', minItems: 1, items: object({ source: ref, selector }) } }),
  object({ action: { const: 'need_owner' }, question: text, reason: text,
    searched: { type: 'array', minItems: 1, items: ref } }),
  object({ action: { const: 'pause' }, reason: text })
] };
export const READER_REPLY_SCHEMA = object({
    selections: { type: 'array', items: { oneOf: [
      object({ source: ref, firstLine: { type: 'integer', minimum: 1 }, lastLine: { type: 'integer', minimum: 1 } }),
      object({ sourceIndex: { type: 'integer', minimum: 0 },
        firstLine: { type: 'integer', minimum: 1 }, lastLine: { type: 'integer', minimum: 1 } })] } },
    unresolved: { type: 'array', items: text } });

/** Share repeated schema nodes without changing any accepted response. In particular the
 * action alternatives otherwise repeat full Source/selector forms on every physical call. */
export function compactResponseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions = { ...(schema.$defs as Record<string, unknown> | undefined) };
  const names = new Map(Object.entries(definitions).map(([name, value]) => [JSON.stringify(value), name]));
  const counts = new Map<string, { count: number; value: Record<string, unknown> }>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>, encoded = JSON.stringify(node);
    if ((node.type || node.oneOf || node.anyOf) && encoded.length >= 140) {
      const entry = counts.get(encoded); if (entry) entry.count++; else counts.set(encoded, { count: 1, value: node });
    }
    Object.values(node).forEach(visit);
  };
  for (const [key, value] of Object.entries(schema)) if (key !== '$defs') visit(value);
  for (const [encoded, entry] of counts) if (entry.count > 1 && !names.has(encoded)) {
    const name = `responseShape${names.size}`; names.set(encoded, name); definitions[name] = entry.value;
  }
  const replace = (value: unknown, root = false): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => replace(item));
    const name = !root && names.get(JSON.stringify(value));
    return name ? { $ref: `#/$defs/${name}` }
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
  };
  const body = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$defs'));
  return { ...replace(body, true) as Record<string, unknown>, ...(Object.keys(definitions).length
    ? { $defs: Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, replace(value, true)])) } : {}) };
}

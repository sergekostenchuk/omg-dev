import type { Ref } from '../pipeline/contracts.js';
import type { CarriedObligation } from './obligation-policy.js';

/** L3 selects concrete consumers; the scope remains the immutable authority. */
export interface TaskObligationBinding {
  id: string; scope: Ref; obligation: string;
  consumers: { node: string; tests: string[] }[];
}
export interface BoundTaskObligation { binding: string; requirement: CarriedObligation; tests: string[] }

const text = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const ref = object({ id: text, revision: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
export const taskObligationBindingSchema = object({ id: text, scope: ref, obligation: text,
  consumers: { type: 'array', minItems: 1, items: object({ node: text, tests: { type: 'array', uniqueItems: true, items: text } }) } });

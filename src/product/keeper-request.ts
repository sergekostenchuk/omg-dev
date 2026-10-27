import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { decodeKeeperPair, KEEPER_RESULT_CONTRACT, projectKeeperResult,
  type KeeperPair, type KeeperResultProjection } from './keeper-result.js';
import type { KeeperCheckKey } from './keeper.js';

/** A structural request over caller-supplied full containers. A future consumer
 * must prove that the exact pair is accepted and that a check was paid; this
 * module does not read or write a Store, send, pay, grant reuse, or block. */
export const KEEPER_REQUEST_CONTRACT = 'keeper-request/v1' as const;
export const KEEPER_REQUEST_INSTRUCTION = 'Check the complete supplied artifact against the selected constitution of the exact key. Answer in the declared keeper-result form with that exact key. Preserve every reason and remark. A rejection requires at least one violation with an existing constitution item, an existing artifact place and a nonempty description of the unmet result; recommendations alone never reject. Pointers are relative to the selected material. Do not assert acceptance, payment, authority or execution.' as const;

export interface KeeperRequest extends KeeperPair {
  contract: typeof KEEPER_REQUEST_CONTRACT;
  requestId: string;
  instruction: typeof KEEPER_REQUEST_INSTRUCTION;
  responseSchema: Json;
}
export interface KeeperAnsweredRequest { request: KeeperRequest; result: KeeperResultProjection }

function invalid(field: string, message: string): never {
  throw new EngineError('keeper_request_invalid', `[${field}] ${message}`, { field });
}
function mismatch(): never {
  throw new EngineError('keeper_request_mismatch', 'The presented request is not the complete request for this exact pair',
    { field: 'request' });
}

/** A closed declaration of the accepted result form. This describes syntax;
 * the shared result projector still resolves every pointer in the material. */
function responseSchema(key: KeeperCheckKey): Json {
  const pointer: Json = { type: 'string', pattern: '^(?:/(?:[^~/]|~[01])*)*$' };
  const nullablePointer: Json = { anyOf: [pointer, { type: 'null' }] };
  const remark = (kind: 'violation' | 'recommendation'): Json => ({
    type: 'object', additionalProperties: false,
    required: ['kind', 'description', 'constitutionPointer', 'artifactPointer'],
    properties: {
      kind: { const: kind }, description: { type: 'string', pattern: '\\S' },
      constitutionPointer: kind === 'violation' ? pointer : nullablePointer,
      artifactPointer: kind === 'violation' ? pointer : nullablePointer,
    },
  });
  return {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    type: 'object', additionalProperties: false,
    required: ['contract', 'key', 'outcome', 'reason', 'remarks'],
    properties: {
      contract: { const: KEEPER_RESULT_CONTRACT },
      key: { const: key as unknown as Json },
      outcome: { enum: ['conforms', 'reject'] },
      reason: { anyOf: [{ type: 'string', pattern: '\\S' }, { type: 'null' }] },
      remarks: { type: 'array', items: { oneOf: [remark('violation'), remark('recommendation')] } },
    },
    allOf: [
      { if: { type: 'object', properties: { outcome: { const: 'conforms' } } },
        then: { type: 'object', properties: { remarks: { type: 'array', items: {
          type: 'object', properties: { kind: { const: 'recommendation' } },
        } } } } },
      { if: { type: 'object', properties: { outcome: { const: 'reject' } } },
        then: { type: 'object', properties: { remarks: { type: 'array', contains: {
          type: 'object', required: ['kind'], properties: { kind: { const: 'violation' } },
        } } } } },
    ],
  };
}

/** Preserve both complete containers and the exact declared check version.
 * Preparation is structural, not an accepted act, payment or dispatch. */
export function prepareKeeperRequest(input: unknown): KeeperRequest {
  const pair = decodeKeeperPair(input);
  const body = { contract: KEEPER_REQUEST_CONTRACT, ...pair,
    instruction: KEEPER_REQUEST_INSTRUCTION, responseSchema: responseSchema(pair.key) };
  return JSON.parse(canonical({ ...body, requestId: `keeper-request:${pair.key.projectId}:${hashJson(body)}` })) as KeeperRequest;
}

/** Snapshot all untrusted arguments once, re-derive the complete request from
 * its original pair and compare every field, then use the accepted result
 * projector on that same pair and answer. No caller-proven flag is authority. */
export function checkKeeperAnswer(input: unknown, presentedRequest: unknown, answer: unknown): KeeperAnsweredRequest {
  let snapshot: { pair: unknown; request: unknown; answer: unknown };
  try { snapshot = JSON.parse(canonical({ pair: input, request: presentedRequest, answer })); }
  catch { invalid('input', 'Expected one complete JSON snapshot of pair, request and answer'); }
  const request = prepareKeeperRequest(snapshot.pair);
  if (canonical(snapshot.request) !== canonical(request)) mismatch();
  const result = projectKeeperResult({ key: request.key, artifact: request.artifact,
    constitution: request.constitution, result: snapshot.answer });
  return { request, result };
}

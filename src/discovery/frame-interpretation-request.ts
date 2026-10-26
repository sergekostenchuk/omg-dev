import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Selector } from '../evidence/evidence.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import { FRAME_INTERPRETATION_AFFECTS, FRAME_INTERPRETATION_OUTCOMES } from './frame-interpretations.js';
import { collectFrameInterpretationSubject, decodeFrameInterpretationSubject,
  type FrameInterpretationSubject, type FrameSubjectRequest } from './frame-interpretation-subject.js';
import { checkFrameInterpretationResult, type FrameInterpretationResult
  } from './frame-interpretation-transport.js';
import { V7_FRAME_INTERPRETATIONS_CONTRACT, V7_FRAME_INTERPRETATIONS_KIND } from './v7-contracts.js';

/** DR2b 2b-REQUEST (codex-omg №15141): the read-only preparatory projector of
 * the request a future producer will answer with a FrameInterpretations set —
 * the part of 2b.1 before the paid line. The request carries the complete
 * proven material verbatim — the full FrameInterpretationSubject collected
 * fresh: the mandate with its Source/selector, the frame with its grounds and
 * the whole previousSet chain — plus a fixed instruction and the closed schema
 * of the answer form. Its exact linkage fields are derived from that subject,
 * never chosen by the caller: no reduced inventory, no retelling. The derived
 * identity covers everything — material, instruction and schema — so a changed
 * word of any of them is another request. The instruction admits both lawful
 * outcomes (material and no_divergence), keeps consequences and supports of
 * every interpretation, asks for no artificial alternatives and never asks to
 * pick a winner. Preparing is not sending: no record is written, no model call
 * is made, nothing is chosen, paid or made an owner act, and a previous set
 * stays explicitly structural. The positive package fakes no paid origin —
 * physical delivery, capacity, payment, choice and publication stay 2b.2–2b.6. */
export const FRAME_INTERPRETATION_REQUEST_CONTRACT = 'frame-interpretation-request/v1' as const;

/** The fixed instruction of every request: read the verbatim excerpt, name a
 * material divergence only where the brief reads differently and the result
 * changes, keep every consequence and support, never invent alternatives and
 * never choose. */
export const FRAME_INTERPRETATION_INSTRUCTION = 'Read the verbatim brief excerpt at the given Source and selector and answer with the closed FrameInterpretations form of the named contract: outcome no_divergence with its reason when the brief reads one way, or outcome material with at least two interpretations distinct by id — each with its meaning, its consequences for result, boundaries, constraints or acceptance, and its verbatim support selectors inside the excerpt. Preserve the interpretation texts and their supports exactly; do not invent alternatives the brief does not support, do not choose a winner and do not mark any interpretation selected, accepted, paid or owner-approved.' as const;

/** The closed schema of the answer — a description of the existing
 * FrameInterpretations contract. It is descriptive: the shared projector stays
 * the source of runtime refusals on a presented answer. */
export const FRAME_INTERPRETATIONS_SCHEMA = Object.freeze({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT,
  fields: Object.freeze(['contract', 'projectId', 'brief', 'frame', 'previousSet',
    'outcome', 'reason', 'interpretations']),
  outcomes: FRAME_INTERPRETATION_OUTCOMES,
  affects: FRAME_INTERPRETATION_AFFECTS,
  selectors: Object.freeze(['json-pointer', 'text-range']),
  briefFields: Object.freeze(['source', 'selector']),
  interpretationFields: Object.freeze(['id', 'meaning', 'consequences', 'support']),
  consequenceFields: Object.freeze(['affects', 'text']),
  rules: Object.freeze([
    'material carries at least two interpretations with distinct ids',
    'no_divergence carries no interpretations',
    'every support lies inside the brief excerpt and is named once',
    'each consequence is named once',
    'no selected, accepted, paid or owner mark is part of the form',
  ]),
});

/** One prepared request: the complete proven material, the exact linkage
 * derived from it, the fixed instruction, the closed answer schema and the
 * derived identity of all of it together. Never sent, paid, chosen or an
 * owner act. */
export interface FrameInterpretationRequest {
  contract: typeof FRAME_INTERPRETATION_REQUEST_CONTRACT;
  /** Derived identity — the hash of every other field: material, instruction and schema. */
  request: string;
  project: string;
  /** The verbatim mandate address — the subject's own proven brief excerpt. */
  brief: { source: Ref; selector: Selector };
  /** The exact frame proposal revision the subject proves. */
  frame: Ref;
  /** The previous structural set ref, or null. */
  previousSet: Ref | null;
  /** The complete freshly proven subject — the whole material inventory. */
  subject: FrameInterpretationSubject;
  instruction: typeof FRAME_INTERPRETATION_INSTRUCTION;
  schema: typeof FRAME_INTERPRETATIONS_SCHEMA;
}

/** A presented request verified against its re-prepared self, and the closed
 * answer verified against the same proven subject by the accepted result
 * transport. */
export interface FrameInterpretationAnsweredRequest {
  request: FrameInterpretationRequest;
  result: FrameInterpretationResult;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const HASH = /^[a-f0-9]{64}$/;
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_request_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function mismatch(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_request_mismatch', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
const same = (left: unknown, right: unknown): boolean => canonical(left as never) === canonical(right as never);
const body = (value: FrameInterpretationRequest) => {
  const { request: _request, ...rest } = value;
  return rest;
};

function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed request form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the request form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'Expected an exact reference');
}
function selectorForm(value: unknown, at: string): asserts value is Selector {
  if (!object(value) || (value.kind !== 'json-pointer' && value.kind !== 'text-range'))
    invalid(`${at}.kind`, 'A selector is a json-pointer or a text-range');
  if (value.kind === 'json-pointer') {
    shape(value, ['kind', 'pointer'], at);
    if (typeof value.pointer !== 'string' || !POINTER.test(value.pointer)) invalid(`${at}.pointer`, 'Expected a canonical JSON Pointer');
  } else {
    shape(value, ['kind', 'start', 'end'], at);
    if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
      || (value.start as number) < 0 || (value.end as number) <= (value.start as number))
      invalid(at, 'A text range is ordered nonnegative UTF-16 offsets, start < end');
  }
}

/** Prepare the request over one exact accepted frame: collect the complete
 * proven subject fresh, derive the exact linkage from it and bind the fixed
 * instruction and closed schema under one derived identity. Read-only — the
 * collector proves sources and material only; nothing is written or sent. */
export function prepareFrameInterpretationRequest(store: Store,
  request: FrameSubjectRequest): FrameInterpretationRequest {
  if (!store || typeof store.get !== 'function') invalid('store', 'An exact record reader is required');
  const subject = collectFrameInterpretationSubject(store, request);
  const value: FrameInterpretationRequest = {
    contract: FRAME_INTERPRETATION_REQUEST_CONTRACT,
    request: '',
    project: subject.project,
    brief: { source: subject.mandate.observation.source, selector: subject.mandate.observation.selector },
    frame: reference(subject.frame.record),
    previousSet: subject.previous === null ? null : reference(subject.previous.record),
    subject,
    instruction: FRAME_INTERPRETATION_INSTRUCTION,
    schema: FRAME_INTERPRETATIONS_SCHEMA,
  };
  value.request = hashJson(body(value) as never);
  return JSON.parse(canonical(value as never)) as FrameInterpretationRequest;
}

/** The closed form of a presented request. An absent field, an extra one, a
 * shortened material package, a changed instruction or schema is refused at
 * its field — the instruction and schema are fixed constants of this form. */
export function decodeFrameInterpretationRequest(value: unknown): FrameInterpretationRequest {
  shape(value, ['contract', 'request', 'project', 'brief', 'frame', 'previousSet',
    'subject', 'instruction', 'schema'], 'request');
  if (value.contract !== FRAME_INTERPRETATION_REQUEST_CONTRACT)
    invalid('request.contract', `Only ${FRAME_INTERPRETATION_REQUEST_CONTRACT} is a known request form`);
  if (typeof value.request !== 'string' || !HASH.test(value.request))
    invalid('request.request', 'The derived request identity is a sha256 hex');
  text(value.project, 'request.project');
  shape(value.brief, ['source', 'selector'], 'request.brief');
  ref(value.brief.source, 'request.brief.source'); selectorForm(value.brief.selector, 'request.brief.selector');
  ref(value.frame, 'request.frame');
  if (value.previousSet !== null) {
    ref(value.previousSet, 'request.previousSet');
    if (!value.previousSet.id.startsWith(`${V7_FRAME_INTERPRETATIONS_KIND}:${value.project}:`))
      invalid('request.previousSet', 'A previous set is an interpretations set of this project');
  }
  decodeFrameInterpretationSubject(value.subject);
  if (value.instruction !== FRAME_INTERPRETATION_INSTRUCTION)
    invalid('request.instruction', 'The instruction is the fixed request text, never a paraphrase');
  if (!same(value.schema, FRAME_INTERPRETATIONS_SCHEMA))
    invalid('request.schema', 'The answer schema is the fixed closed description');
  return structuredClone(value) as unknown as FrameInterpretationRequest;
}

/** Re-verify a presented request against the saved material: decode it closed,
 * check its derived identity and its linkage against the caller's exact
 * addresses, re-prepare from the proven subject and compare field by field.
 * What is delivered is the freshly prepared request — never the presented
 * object. */
export function checkFrameInterpretationRequest(store: Store, request: FrameSubjectRequest,
  presented: unknown): FrameInterpretationRequest {
  const decoded = decodeFrameInterpretationRequest(presented);
  if (decoded.request !== hashJson(body(decoded) as never))
    mismatch('request', 'The derived identity does not cover the request');
  const prepared = prepareFrameInterpretationRequest(store, request);
  for (const field of ['contract', 'project', 'brief', 'frame', 'previousSet',
    'subject', 'instruction', 'schema'] as const)
    if (!same(decoded[field], prepared[field]))
      mismatch(field, 'The presented request does not match the prepared request',
        field === 'frame' && isRef(decoded.frame) ? decoded.frame : undefined);
  return prepared;
}

/** Verify a presented request and its presented answer together: the request
 * is re-prepared and compared, the answer is bound to the same proven subject
 * by the accepted result transport, and the two subjects are required to be
 * the same package. */
export function checkFrameInterpretationAnswer(store: Store, request: FrameSubjectRequest,
  presentedRequest: unknown, answer: unknown): FrameInterpretationAnsweredRequest {
  const req = checkFrameInterpretationRequest(store, request, presentedRequest);
  const result = checkFrameInterpretationResult(store, request, answer);
  if (!same(result.subject, req.subject))
    mismatch('subject', 'The answer is proven over another subject than the request');
  return { request: req, result };
}

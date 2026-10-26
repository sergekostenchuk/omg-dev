import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import { contextValue, prepareFrameInterpretationContextPacker } from './working-context.js';
import { readArchiveBody } from './request-parts.js';
import { buildResearchResultCapacity, requirePacketMaterialDelivery,
  requireResearchResultCapacity, type ResearchResultCapacity,
  type ResearchResultCapacityInput } from './research-delivery.js';
import { decodeFrameInterpretationRequest, type FrameInterpretationRequest
  } from './frame-interpretation-request.js';
import type { FrameSubjectRequest } from './frame-interpretation-subject.js';
import type { Revision } from '../storage/store.js';

/** DR2b 2b-PACK (codex-omg №15201, уточнение №15208): the read-only preparatory
 * packing of a complete frame-interpretation request into the exact context
 * archive and its bounded wire packet — the packaging before the paid line.
 * The request arrives only through the accepted preparation/check: the whole
 * proven subject is collected fresh, and project, exact frame, brief and
 * previousSet plus the derived request.request identity are bound to the
 * archive and to the measured capacity. The archive keeps the FULL request
 * byte for byte — small material crosses the packet inline, large material
 * names its exact /body address and carries a nonempty bounded page; every
 * byte stays restorable on a cold store, the previous set chain included.
 * Archive records are staged and written atomically in one writeMany only
 * after the whole envelope is measured: a capacity or form refusal leaves
 * zero staged writes. Archive metadata carries the proven draft/question
 * revisions — never today's heads — and no head guard is taken: the exact
 * revisions are proven by the shared reader, a reused content-addressed
 * record is verified by kind, revision, hash and full bytes, never by id
 * alone. Nothing here admits payment: no model call, ledger row, provider
 * contact, choice, publication or paid mark — the paid 2b.2 line keeps its
 * own later admission and continuation. */
export const FRAME_INTERPRETATION_ENVELOPE_CONTRACT =
  'frame-interpretation-envelope/v1' as const;

/** What the caller supplies for one measured envelope: the prompt text, the
 * bound of the bounded wire packet itself and the physical character bound
 * of the complete serialized input — prompt, metadata, capacity data and the
 * declared response bound, never the packet body alone. */
export interface FrameEnvelopeInput {
  prompt: string;
  /** The bounded packet's own share; strictly below the complete bound so a
   * bounded page never consumes the room the admission needs. */
  packetChars: number;
  /** The physical limit of the whole input in UTF-16 units. */
  limitChars: number;
}

/** One prepared envelope: the verified request, the exact archive ref, the
 * bounded packet, the measured capacity and the measured input size. Staged
 * archives are already committed — never returned unwritten. */
export interface FrameInterpretationEnvelope {
  contract: typeof FRAME_INTERPRETATION_ENVELOPE_CONTRACT;
  request: FrameInterpretationRequest;
  archive: Ref;
  packet: Record<string, any>;
  capacity: ResearchResultCapacity;
  measuredChars: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_pack_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function mismatch(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_pack_mismatch', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
const same = (left: unknown, right: unknown): boolean => canonical(left as never) === canonical(right as never);

function checkInput(input: unknown): FrameEnvelopeInput {
  if (!object(input)) invalid('input', 'Expected an envelope input object');
  for (const key of Object.keys(input))
    if (!['prompt', 'packetChars', 'limitChars'].includes(key)) invalid(`input.${key}`, 'The field is not part of the envelope input');
  if (typeof input.prompt !== 'string' || !input.prompt.trim())
    invalid('input.prompt', 'Expected nonempty prompt text');
  for (const key of ['packetChars', 'limitChars'] as const)
    if (!Number.isSafeInteger(input[key]) || (input[key] as number) <= 0)
      invalid(`input.${key}`, 'Expected a positive physical character bound');
  if ((input.packetChars as number) >= (input.limitChars as number))
    invalid('input.packetChars', 'The packet share must stay strictly below the complete bound');
  return input as unknown as FrameEnvelopeInput;
}

/** The complete measured input of one request envelope: prompt, exact
 * metadata derived from the proven request — never today's heads — the packed
 * bounded context, and the response-form table. buildResearchResultCapacity
 * measures the serialized {mandatoryEnvelope, capacity, form, result} itself,
 * so the size covers capacity and the declared reply bound, not the body
 * alone. */
function capacityInput(request: FrameInterpretationRequest,
  packet: Record<string, any>, input: FrameEnvelopeInput): ResearchResultCapacityInput {
  const draft = request.subject.frame.draft as Revision<unknown>;
  const question = request.subject.frame.question as Revision<unknown>;
  return {
    operation: request.request,
    generation: 0,
    bindings: {
      projectId: request.project,
      frame: request.frame,
      brief: request.brief,
      previousSet: request.previousSet,
      request: request.request,
    },
    role: 'analyst',
    purpose: 'frame-interpretation-request',
    actionMode: 'frame-interpretation-request',
    envelopeLimitChars: input.limitChars,
    mandatoryEnvelope: {
      prompt: input.prompt,
      metadata: {
        projectId: request.project,
        draft: { id: draft.id, revision: draft.revision, hash: draft.hash },
        question: { id: question.id, revision: question.revision, hash: question.hash },
        frame: request.frame,
        brief: request.brief,
        previousSet: request.previousSet,
        request: request.request,
      },
      context: packet,
    },
    forms: [{ kind: 'frame-interpretations' }],
  };
}

/** Resolve an addressed /body/... pointer over the saved bytes of one exact
 * archive record — the staged row of the same batch first, then the store. */
const archiveValue = (store: Store, staged: Map<string, Revision<any>> | null,
  record: Ref, pointer: string): unknown => {
  const row = staged?.get(record.id) ?? store.get<Record<string, any>>(record.id, record.revision);
  if (!row) throw new EngineError('frame_pack_mismatch',
    '[archive] The addressed archive record is missing', record);
  return contextValue({ ...row.value, body: readArchiveBody(store, row).body }, pointer);
};

/** Prepare one measured envelope over a fresh proven request: collect and
 * verify the request through the accepted preparation, pack the whole
 * request context into the staged archive through the request branch of the
 * shared packer — proven draft/question metadata, no head guards — measure
 * the complete input with prompt, metadata, capacity and response bound,
 * and only then commit every staged record atomically. A refusal leaves
 * nothing written. */
export function prepareFrameInterpretationEnvelope(store: Store,
  request: FrameSubjectRequest, input: FrameEnvelopeInput,
  presented?: unknown): FrameInterpretationEnvelope {
  if (!store || typeof store.get !== 'function') invalid('store', 'An exact record reader is required');
  const inRequest = checkInput(input);
  const packer = prepareFrameInterpretationContextPacker(store, request.project, request, presented);
  const packet = packer.pack(packer.context, inRequest.packetChars,
    { purpose: 'frame-interpretation-request', common: true });
  const prepared = packer.request;
  const inputCapacity = capacityInput(prepared, packet, inRequest);
  const capacity = buildResearchResultCapacity(inputCapacity);
  const archive = packet.working?.archive;
  if (!isRef(archive)) invalid('packet.working.archive', 'The packed context lost its exact archive');
  requirePacketMaterialDelivery(packet, archive,
    (record, pointer) => archiveValue(store, packer.staged().records, record, pointer));
  // The complete physical input: the capacity record already carries the
  // mandatory projection (prompt, metadata, bounded context) and the response
  // bound, so the serialized admission with its empty result slot is the
  // honest size — it must fit the declared limit before anything is written.
  const measured = JSON.stringify({ capacity, form: 'frame-interpretations', result: null }).length;
  if (measured > inRequest.limitChars)
    throw new EngineError('pilot_core_limit',
      'The complete request envelope exceeds its declared physical bound',
      { required: measured, envelopeLimitChars: inRequest.limitChars });
  packer.commit();
  const value: FrameInterpretationEnvelope = {
    contract: FRAME_INTERPRETATION_ENVELOPE_CONTRACT,
    request: prepared, archive, packet, capacity, measuredChars: measured,
  };
  return JSON.parse(canonical(value as never)) as FrameInterpretationEnvelope;
}

function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed envelope form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the envelope form');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'Expected an exact reference');
}

/** The closed form of a presented envelope: an absent field, an extra one, a
 * malformed archive address or a truncated request is refused at its field. */
export function decodeFrameInterpretationEnvelope(value: unknown): FrameInterpretationEnvelope {
  shape(value, ['contract', 'request', 'archive', 'packet', 'capacity', 'measuredChars'], 'envelope');
  if (value.contract !== FRAME_INTERPRETATION_ENVELOPE_CONTRACT)
    invalid('envelope.contract', `Only ${FRAME_INTERPRETATION_ENVELOPE_CONTRACT} is a known envelope form`);
  decodeFrameInterpretationRequest(value.request);
  ref(value.archive, 'envelope.archive');
  if (!object(value.packet)) invalid('envelope.packet', 'Expected the bounded packed context');
  if (!Number.isSafeInteger(value.measuredChars) || (value.measuredChars as number) <= 0)
    invalid('envelope.measuredChars', 'Expected the measured input size');
  return structuredClone(value) as unknown as FrameInterpretationEnvelope;
}

/** Re-verify a presented envelope: decode it closed, re-prepare from the
 * proven request at the same input bound, verify the saved capacity against
 * the rebuilt admission and the packet delivery against the saved archive
 * bytes, then compare field by field. What is delivered is the freshly
 * prepared envelope — never the presented object. */
export function checkFrameInterpretationEnvelope(store: Store,
  request: FrameSubjectRequest, input: FrameEnvelopeInput,
  presented: unknown): FrameInterpretationEnvelope {
  const decoded = decodeFrameInterpretationEnvelope(presented);
  const prepared = prepareFrameInterpretationEnvelope(store, request, checkInput(input));
  const rebuilt = capacityInput(prepared.request, prepared.packet, input);
  requireResearchResultCapacity(decoded.capacity, rebuilt);
  requirePacketMaterialDelivery(decoded.packet, decoded.archive,
    (record, pointer) => archiveValue(store, null, record, pointer));
  for (const field of ['contract', 'request', 'archive', 'packet', 'capacity', 'measuredChars'] as const)
    if (!same(decoded[field], prepared[field]))
      mismatch(field, 'The presented envelope does not match the prepared envelope',
        field === 'archive' && isRef(decoded.archive) ? decoded.archive : undefined);
  return prepared;
}

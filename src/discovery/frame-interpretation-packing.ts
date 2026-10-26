import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import type { Environment, RoleBinding } from '../runtime/environment.js';
import { contextValue, prepareFrameInterpretationContextPacker } from './working-context.js';
import { readArchiveBody } from './request-parts.js';
import { buildResearchResultCapacity, requirePacketMaterialDelivery,
  requireResearchResultCapacity, type ResearchResultCapacity,
  type ResearchResultCapacityInput } from './research-delivery.js';
import { researchResponseOutputLimit } from './early-research-outcome.js';
import { prepareResearchEnvelope } from './research-protocol.js';
import { decodeFrameInterpretationRequest, type FrameInterpretationRequest
  } from './frame-interpretation-request.js';
import type { FrameSubjectRequest } from './frame-interpretation-subject.js';

/** DR2b 2b-PACK (codex-omg №15201, уточнение №15208, дожим №15229): the
 * read-only preparatory packing of a complete frame-interpretation request
 * into the exact context archive and its bounded wire — the packaging before
 * the paid line. The request arrives only through the accepted
 * preparation/check: the whole proven subject is collected fresh, and
 * project, exact frame, brief and previousSet plus the derived
 * request.request identity are bound to the archive and to the measured
 * capacity. The archive keeps the FULL request byte for byte — small
 * material crosses the packet inline, large material names its exact /body
 * address and carries a nonempty bounded page; every byte stays restorable
 * on a cold store, the previous set chain included. Archive records are
 * staged and written atomically in one writeMany only after the complete
 * omg-agent/v1 input — envelope with model/effort/requestId, bounded subject
 * and its responseOutputLimit — measured by the shared envelope builder;
 * a capacity or form refusal leaves zero staged writes, and the checking
 * door verifies the prepared staged records without ever committing.
 * Archive metadata carries the proven draft/question revisions — never
 * today's heads — and no head guard is taken: the exact revisions are proven
 * by the shared reader, a reused content-addressed record is verified by
 * kind, revision, hash and full bytes, never by id alone, and it resolves
 * identically on the first pack, a re-pack and a cold store. Nothing here
 * admits payment: no model call, ledger row, provider contact, choice,
 * publication or paid mark — the paid 2b.2 line keeps its own later
 * admission and continuation. */
export const FRAME_INTERPRETATION_ENVELOPE_CONTRACT =
  'frame-interpretation-envelope/v1' as const;

/** What the caller supplies for one measured envelope: the prompt text, the
 * bound of the bounded wire packet itself, the physical character bound of
 * the complete serialized input, and the existing role/environment the
 * shared envelope is declared over. Their presence admits nothing — no
 * dispatch and no payment happens inside this preparation. */
export interface FrameEnvelopeInput {
  prompt: string;
  /** The bounded packet's own share; strictly below the complete bound so a
   * bounded page never consumes the room the admission needs. */
  packetChars: number;
  /** The physical limit of the whole omg-agent/v1 input in UTF-16 units —
   * envelope fields, bounded subject, capacity and the declared response
   * bound, never the packet body alone. */
  limitChars: number;
  role: RoleBinding;
  environment: Environment;
}

/** One prepared envelope: the verified request, the exact archive ref, the
 * bounded packet, the measured capacity, the actual complete wire input the
 * shared envelope builder produced and its measured size. Staged archives
 * are already committed — never returned unwritten. */
export interface FrameInterpretationEnvelope {
  contract: typeof FRAME_INTERPRETATION_ENVELOPE_CONTRACT;
  request: FrameInterpretationRequest;
  archive: Ref;
  packet: Record<string, any>;
  capacity: ResearchResultCapacity;
  /** The complete omg-agent/v1 input bytes — the shared envelope over the
   * packed context, including model, effort, requestId and
   * responseOutputLimit. */
  input: string;
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

const ENVELOPE_FIELDS = ['contract', 'request', 'archive', 'packet', 'capacity', 'input', 'measuredChars'] as const;

function checkInput(input: unknown): FrameEnvelopeInput {
  if (!object(input)) invalid('input', 'Expected an envelope input object');
  for (const key of Object.keys(input))
    if (!['prompt', 'packetChars', 'limitChars', 'role', 'environment'].includes(key))
      invalid(`input.${key}`, 'The field is not part of the envelope input');
  if (typeof input.prompt !== 'string' || !input.prompt.trim())
    invalid('input.prompt', 'Expected nonempty prompt text');
  for (const key of ['packetChars', 'limitChars'] as const)
    if (!Number.isSafeInteger(input[key]) || (input[key] as number) <= 0)
      invalid(`input.${key}`, 'Expected a positive physical character bound');
  if ((input.packetChars as number) >= (input.limitChars as number))
    invalid('input.packetChars', 'The packet share must stay strictly below the complete bound');
  const role = input.role, environment = input.environment;
  if (!object(role) || typeof role['model'] !== 'string' || !role['model']
    || typeof role['effort'] !== 'string' || !role['effort'])
    invalid('input.role', 'Expected the existing role binding with model and effort');
  if (!object(environment) || typeof environment['projectId'] !== 'string' || !environment['projectId'])
    invalid('input.environment', 'Expected the existing environment with its project');
  return input as unknown as FrameEnvelopeInput;
}

/** The mandatory admission projection in the shared omg-agent/v1 shape:
 * protocol, requestId, mode, model and effort from the declared role, the
 * prompt, and the subject carrying the exact provenance — project, the
 * proven draft/question revisions, frame, brief, previousSet and the
 * request identity — plus the declared response bound and access flags. */
function mandatoryEnvelope(request: FrameInterpretationRequest,
  input: FrameEnvelopeInput): Record<string, unknown> {
  return {
    protocol: 'omg-agent/v1', requestId: '00000000-0000-0000-0000-000000000000',
    mode: 'research', model: input.role.model, effort: input.role.effort,
    ...(input.role.speed ? { speed: input.role.speed } : {}),
    prompt: input.prompt,
    subject: {
      projectId: request.project,
      draft: reference(request.subject.frame.draft as Revision<unknown>),
      question: reference(request.subject.frame.question as Revision<unknown>),
      frame: request.frame, brief: request.brief, previousSet: request.previousSet,
      request: request.request,
      responseOutputLimit: researchResponseOutputLimit(null),
      access: { exactOriginals: true, incompletePagesAreNotComplete: true },
    },
  };
}

function capacityInput(request: FrameInterpretationRequest, input: FrameEnvelopeInput): ResearchResultCapacityInput {
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
    mandatoryEnvelope: mandatoryEnvelope(request, input),
    forms: [{ kind: 'frame-interpretations' }],
  };
}

/** Resolve an addressed /body/... pointer over the saved bytes of one exact
 * archive record — the staged row of the same batch first, then the store.
 * A verified existing archive is already in the staged map, so a re-pack and
 * a cold store resolve it identically to the first pack. */
const archiveValue = (store: Store, staged: Map<string, Revision<any>> | null,
  record: Ref, pointer: string): unknown => {
  const row = staged?.get(record.id) ?? store.get<Record<string, any>>(record.id, record.revision);
  if (!row) throw new EngineError('frame_pack_mismatch',
    '[archive] The addressed archive record is missing', record);
  return contextValue({ ...row.value, body: readArchiveBody(store, row).body }, pointer);
};

/** Pack and measure one request envelope WITHOUT writing anything: the
 * proven request through the request branch of the shared packer, capacity
 * over the mandatory omg-agent/v1 projection, the packet's material
 * delivery against the staged records, then the complete wire input from
 * the shared envelope builder — its own physical check enforces the bound.
 * The caller decides whether the staged archives are committed (prepare) or
 * stay unwritten (check). */
function stageEnvelope(store: Store, request: FrameSubjectRequest,
  input: FrameEnvelopeInput, presented?: unknown) {
  if (!store || typeof store.get !== 'function') invalid('store', 'An exact record reader is required');
  const inRequest = checkInput(input);
  const packer = prepareFrameInterpretationContextPacker(store, request.project, request, presented);
  const packet = packer.pack(inRequest.packetChars);
  const prepared = packer.request;
  const inputCapacity = capacityInput(prepared, inRequest);
  const capacity = buildResearchResultCapacity(inputCapacity);
  const archive = packet.working?.archive;
  if (!isRef(archive)) invalid('packet.working.archive', 'The packed context lost its exact archive');
  requirePacketMaterialDelivery(packet, archive,
    (record, pointer) => archiveValue(store, packer.staged().records, record, pointer));
  if (inRequest.environment.projectId !== prepared.project)
    mismatch('environment.projectId', 'The environment names another project');
  const built = prepareResearchEnvelope(inRequest.role, inRequest.environment,
    inRequest.prompt, packet, undefined, capacity as unknown as Record<string, any>);
  return { inRequest, packer, prepared, packet, archive, capacity, inputCapacity,
    input: built.input as string, measured: built.input.length };
}

const envelopeValue = (staged: ReturnType<typeof stageEnvelope>): FrameInterpretationEnvelope =>
  JSON.parse(canonical({
    contract: FRAME_INTERPRETATION_ENVELOPE_CONTRACT,
    request: staged.prepared, archive: staged.archive, packet: staged.packet,
    capacity: staged.capacity, input: staged.input, measuredChars: staged.measured,
  } as never)) as FrameInterpretationEnvelope;

/** Prepare one measured envelope over a fresh proven request and commit the
 * staged archives atomically — only after the complete omg-agent/v1 input
 * was built and measured by the shared envelope builder. A refusal leaves
 * nothing written. */
export function prepareFrameInterpretationEnvelope(store: Store,
  request: FrameSubjectRequest, input: FrameEnvelopeInput,
  presented?: unknown): FrameInterpretationEnvelope {
  const staged = stageEnvelope(store, request, input, presented);
  staged.packer.commit();
  return envelopeValue(staged);
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
 * malformed archive address, a missing input or a truncated request is
 * refused at its field. */
export function decodeFrameInterpretationEnvelope(value: unknown): FrameInterpretationEnvelope {
  shape(value, ENVELOPE_FIELDS, 'envelope');
  if (value.contract !== FRAME_INTERPRETATION_ENVELOPE_CONTRACT)
    invalid('envelope.contract', `Only ${FRAME_INTERPRETATION_ENVELOPE_CONTRACT} is a known envelope form`);
  decodeFrameInterpretationRequest(value.request);
  ref(value.archive, 'envelope.archive');
  if (!object(value.packet)) invalid('envelope.packet', 'Expected the bounded packed context');
  if (typeof value.input !== 'string' || !value.input.length)
    invalid('envelope.input', 'Expected the complete measured input');
  if (!Number.isSafeInteger(value.measuredChars) || (value.measuredChars as number) <= 0)
    invalid('envelope.measuredChars', 'Expected the measured input size');
  return structuredClone(value) as unknown as FrameInterpretationEnvelope;
}

/** Re-verify a presented envelope: decode it closed, re-prepare from the
 * proven request at the same input bound — staged only, the checking door
 * never commits — verify the saved capacity against the rebuilt admission
 * and the packet delivery against the prepared staged records and saved
 * archive bytes, then compare field by field including the complete input.
 * What is delivered is the freshly prepared envelope — never the presented
 * object — and no archive appears on a refusal or a match. */
export function checkFrameInterpretationEnvelope(store: Store,
  request: FrameSubjectRequest, input: FrameEnvelopeInput,
  presented: unknown): FrameInterpretationEnvelope {
  const decoded = decodeFrameInterpretationEnvelope(presented);
  const staged = stageEnvelope(store, request, input);
  const prepared = envelopeValue(staged);
  requireResearchResultCapacity(decoded.capacity, staged.inputCapacity);
  requirePacketMaterialDelivery(decoded.packet, decoded.archive,
    (record, pointer) => archiveValue(store, staged.packer.staged().records, record, pointer));
  for (const field of ENVELOPE_FIELDS)
    if (!same(decoded[field], prepared[field]))
      mismatch(field, 'The presented envelope does not match the prepared envelope',
        field === 'archive' && isRef(decoded.archive) ? decoded.archive : undefined);
  return prepared;
}

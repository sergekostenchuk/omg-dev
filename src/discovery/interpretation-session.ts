import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { readEnvironmentAt, type Environment, type RoleBinding } from '../runtime/environment.js';
import type { Selector } from '../evidence/evidence.js';
import { decodeFrameInterpretationRequest, type FrameInterpretationRequest
  } from './frame-interpretation-request.js';
import type { FrameSubjectRequest } from './frame-interpretation-subject.js';
import { checkFrameInterpretationEnvelope, decodeFrameInterpretationEnvelope,
  FRAME_INTERPRETATION_ENVELOPE_CONTRACT, type FrameEnvelopeInput,
  type FrameInterpretationEnvelope } from './frame-interpretation-packing.js';

/** DR2b 2b-GENERATION-SESSION (codex-omg №15271): the persisted prepared
 * session of a frame-interpretation generation on top of the accepted PACK.
 * The session binds the exact request and the whole preparation — the saved
 * envelope, its archive and capacity, the original role and the exact saved
 * environment — so the prepared state survives repeats and cold reopens with
 * deterministic identity. It is the prepared generation cell only: there is
 * no paid call, no result, no choice and no publication (2b.2–2b.6); a
 * session is neither admission to payment nor a proof of the interpretations'
 * correctness. */

export const FRAME_INTERPRETATION_SESSION_CONTRACT = 'frame-interpretation-session/v1' as const;
export const FRAME_INTERPRETATION_SESSION_KIND = 'frame-interpretation-session' as const;

/** The closed prepared form: bound grounds, the complete request with its
 * derived identity, the verified saved envelope, the preparation parameters,
 * the original role, the exact environment revision, an initial cursor and
 * `result: null`. Any paid/applied/selected/published or foreign-purpose
 * field is outside the form and refusals are typed. */
export interface FrameInterpretationSession {
  contract: typeof FRAME_INTERPRETATION_SESSION_CONTRACT;
  project: string;
  /** The verbatim mandate address — equals `request.brief`. */
  brief: { source: Ref; selector: Selector };
  /** The exact frame proposal revision — equals `request.frame`. */
  frame: Ref;
  /** The previous structural set ref — equals `request.previousSet`. */
  previousSet: Ref | null;
  /** The exact archive the envelope names — equals `envelope.archive`. */
  archive: Ref;
  /** The exact saved environment revision the preparation measured under. */
  environment: Ref;
  /** The original preparation role — equals `input.role` and one of the saved environment's roles. */
  role: RoleBinding;
  /** The complete verified request, with its derived identity. */
  request: FrameInterpretationRequest;
  /** The complete preparation parameters — prompt, bounds, role and the environment value. */
  input: FrameEnvelopeInput;
  /** The verified saved envelope — archive, bounded packet, capacity, measured input. */
  envelope: FrameInterpretationEnvelope;
  state: 'prepared';
  /** The initial read position — the generation has consumed nothing yet. */
  cursor: { offset: 0 };
  result: null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => canonical(left as never) === canonical(right as never);

function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_session_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function mismatch(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_session_mismatch', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function missing(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_session_missing', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}

const SESSION_FIELDS = ['contract', 'project', 'brief', 'frame', 'previousSet', 'archive', 'environment',
  'role', 'request', 'input', 'envelope', 'state', 'cursor', 'result'] as const;

/** The deterministic identity of the whole bound session — derived, never taken from input. */
const sessionId = (project: string, session: FrameInterpretationSession): string =>
  `${FRAME_INTERPRETATION_SESSION_KIND}:${project}:${hashJson(session)}`;

function decodeSession(value: unknown): FrameInterpretationSession {
  if (!object(value)) invalid('session', 'Expected a session object');
  for (const key of SESSION_FIELDS)
    if (!Object.hasOwn(value, key)) invalid(`session.${key}`, 'The field is part of the session form and is missing');
  for (const key of Object.keys(value))
    if (!(SESSION_FIELDS as readonly string[]).includes(key))
      invalid(`session.${key}`, 'The field is not part of the prepared session form');
  if (value.contract !== FRAME_INTERPRETATION_SESSION_CONTRACT)
    invalid('session.contract', 'Unknown session contract');
  if (typeof value.project !== 'string' || !value.project.length)
    invalid('session.project', 'The session needs its project');
  // Bound grounds in closed form.
  if (!object(value.brief) || !isRef(value.brief.source) || !object(value.brief.selector))
    invalid('session.brief', 'The session names the mandate Source and selector');
  if (!isRef(value.frame)) invalid('session.frame', 'The session names the exact frame revision', value.frame as Ref);
  if (value.previousSet !== null && !isRef(value.previousSet))
    invalid('session.previousSet', 'The session names the exact previous set or null');
  if (!isRef(value.archive)) invalid('session.archive', 'The session names the exact request archive', value.archive as Ref);
  if (!isRef(value.environment))
    invalid('session.environment', 'The session names the exact environment revision', value.environment as Ref);
  if (!object(value.role)) invalid('session.role', 'The session keeps the original role binding');
  // The prepared request and its envelope decode under their own closed forms.
  const request = decodeFrameInterpretationRequest(value.request);
  const envelope = decodeFrameInterpretationEnvelope(value.envelope);
  if (envelope.contract !== FRAME_INTERPRETATION_ENVELOPE_CONTRACT)
    invalid('session.envelope.contract', 'Unknown envelope contract');
  if (!object(value.input)) invalid('session.input', 'The session keeps its preparation parameters');
  const input = value.input as Record<string, unknown>;
  for (const key of ['prompt', 'packetChars', 'limitChars', 'role', 'environment'] as const)
    if (!Object.hasOwn(input, key)) invalid(`session.input.${key}`, 'The preparation parameter is missing');
  for (const key of Object.keys(input))
    if (!['prompt', 'packetChars', 'limitChars', 'role', 'environment'].includes(key))
      invalid(`session.input.${key}`, 'The field is not a preparation parameter');
  if (typeof input.prompt !== 'string' || !input.prompt.length)
    invalid('session.input.prompt', 'The preparation prompt is a nonempty string');
  if (!Number.isSafeInteger(input.packetChars) || (input.packetChars as number) <= 0
    || !Number.isSafeInteger(input.limitChars) || (input.limitChars as number) <= 0)
    invalid('session.input.bounds', 'The preparation bounds are positive safe integers');
  if (!object(input.role)) invalid('session.input.role', 'The preparation keeps the original role');
  if (!object(input.environment)) invalid('session.input.environment', 'The preparation keeps the environment value');
  // Only the prepared state exists: initial cursor, null result, nothing else.
  if (value.state !== 'prepared')
    invalid('session.state', 'Only the prepared state is part of this session');
  if (!same(value.cursor, { offset: 0 }))
    invalid('session.cursor', 'The session cursor stays at its initial offset');
  if (value.result !== null)
    invalid('session.result', 'A prepared session carries no result');
  // Bound fields must be the same grounds the request and envelope carry —
  // a session with a substituted binding is not this session.
  const session = value as unknown as FrameInterpretationSession;
  if (!same(session.brief, request.brief)) mismatch('session.brief', 'The bound brief differs from the request');
  if (!same(session.frame, request.frame)) mismatch('session.frame', 'The bound frame differs from the request', session.frame);
  if (!same(session.previousSet, request.previousSet))
    mismatch('session.previousSet', 'The bound previous set differs from the request');
  if (!same(session.archive, envelope.archive))
    mismatch('session.archive', 'The bound archive differs from the envelope', session.archive);
  if (!same(envelope.request, request))
    mismatch('session.envelope.request', 'The envelope was prepared for another request');
  if (!same(session.role, input.role))
    mismatch('session.role', 'The bound role differs from the preparation parameters');
  if (session.project !== request.project || envelope.request.project !== session.project)
    mismatch('session.project', 'The session belongs to another project');
  return session;
}

/** The exact saved environment revision the caller's value names — proven by
 * Ref and bytes, never a head read. The project and the original role bind to
 * it; a value that is no saved environment of this project refuses. */
function provenEnvironment(store: Store, project: string, input: FrameEnvelopeInput): Revision<Environment> {
  const exact = store.history<Environment>(`environment:${project}`)
    .find(row => same(row.value, input.environment));
  if (!exact) missing('environment', 'The presented environment is not a saved environment revision of this project');
  const proven = readEnvironmentAt(store, project, reference(exact));
  if (!same(input.role, proven.value.implementer) && !same(input.role, proven.value.reviewer))
    mismatch('role', 'The original role is not a declared role of the proven environment');
  return proven;
}

const subjectOf = (request: FrameInterpretationRequest): FrameSubjectRequest => ({
  project: request.project, frame: request.frame, mandate: request.brief, previousSet: request.previousSet,
});

/** Prepare the session over an already saved envelope: the envelope is
 * verified by the shared checker (a missing archive is never rebuilt), the
 * environment is proven by exact revision and bytes, every check runs before
 * the single atomic expected:0 write. A repeat returns the same exact session
 * with no writes; a second-Store race re-reads the winner instead of
 * duplicating or overwriting it. */
export function prepareFrameInterpretationSession(store: Store,
  request: FrameSubjectRequest, input: FrameEnvelopeInput,
  presented: unknown): Revision<FrameInterpretationSession> {
  const checked = checkFrameInterpretationEnvelope(store, request, input, presented);
  const environment = provenEnvironment(store, request.project, input);
  const session: FrameInterpretationSession = {
    contract: FRAME_INTERPRETATION_SESSION_CONTRACT, project: request.project,
    brief: structuredClone(checked.request.brief), frame: structuredClone(checked.request.frame),
    previousSet: checked.request.previousSet === null ? null : structuredClone(checked.request.previousSet),
    archive: structuredClone(checked.archive), environment: reference(environment),
    role: structuredClone(input.role), request: structuredClone(checked.request),
    input: structuredClone(input), envelope: structuredClone(checked),
    state: 'prepared', cursor: { offset: 0 }, result: null,
  };
  const id = sessionId(request.project, session);
  const existing = store.get<FrameInterpretationSession>(id);
  if (existing) return readFrameInterpretationSession(store, request.project, reference(existing));
  try {
    const saved = store.writeMany<FrameInterpretationSession>(
      [{ id, kind: FRAME_INTERPRETATION_SESSION_KIND, expected: 0, value: session }])[0]!;
    return { ...saved, value: structuredClone(saved.value) };
  } catch (error) {
    if (error instanceof EngineError && error.code === 'revision_conflict') {
      const winner = store.get<FrameInterpretationSession>(id);
      if (winner) return readFrameInterpretationSession(store, request.project, reference(winner));
    }
    throw error;
  }
}

/** The exact reader: immutable bytes first, then the complete closed form and
 * a fresh re-bind of every saved ground through the common request/envelope
 * readers and the saved environment — historical Revisions, never today's
 * heads. The returned object is isolated from any future write. */
export function readFrameInterpretationSession(store: Store, project: string,
  ref: Ref): Revision<FrameInterpretationSession> {
  if (!isRef(ref)) invalid('ref', 'The session needs its exact reference');
  const row = store.get<FrameInterpretationSession>(ref.id, ref.revision);
  if (!row || row.kind !== FRAME_INTERPRETATION_SESSION_KIND)
    missing('record', 'The exact session record is missing', ref);
  if (row.revision !== ref.revision || row.hash !== ref.hash || hashJson(row.value) !== ref.hash)
    mismatch('record', 'The exact session revision, hash or bytes do not match', ref);
  const session = decodeSession(row.value);
  if (session.project !== project || row.id !== sessionId(project, session) || row.revision !== 1)
    mismatch('record', 'Foreign project or noncanonical session address', ref);
  // Re-bind the saved grounds: the request, the envelope and its archive are
  // verified again by the common readers over their exact revisions.
  const rebound = checkFrameInterpretationEnvelope(store, subjectOf(session.request),
    session.input, session.envelope);
  if (!same(rebound, session.envelope))
    mismatch('envelope', 'The saved envelope no longer proves this session', session.archive);
  const environment = readEnvironmentAt(store, project, session.environment);
  if (!same(environment.value, session.input.environment))
    mismatch('environment', 'The proven environment revision differs from the preparation value', session.environment);
  if (!same(session.role, environment.value.implementer) && !same(session.role, environment.value.reviewer))
    mismatch('role', 'The bound role is not a declared role of the proven environment');
  return { ...row, value: session };
}

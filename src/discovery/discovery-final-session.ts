import { FINAL_MATERIAL_CONTRACT } from './final-material.js';
import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { RoleBinding } from '../runtime/environment.js';
import type { Revision, Store } from '../storage/store.js';
import type { DiscoveryFinalSubject } from './discovery-final.js';
import { decodeDiscoveryFinalEnvelopeInput, requireSavedDiscoveryFinalArchive,
  stageDiscoveryFinalEnvelope, type DiscoveryFinalEnvelope, type DiscoveryFinalEnvelopeInput,
  type StagedDiscoveryFinalEnvelope } from './discovery-final-packing.js';

export const DISCOVERY_FINAL_SESSION = 'discovery-final-session/v1' as const;
export const DISCOVERY_FINAL_SESSION_KIND = 'discovery-final-session' as const;

/** A prepared cell only: no call, payment, verdict or acceptance exists here. */
export interface DiscoveryFinalSession {
  contract: typeof DISCOVERY_FINAL_SESSION;
  project: string;
  subject: DiscoveryFinalSubject;
  archive: Ref;
  environment: Ref;
  role: RoleBinding;
  input: DiscoveryFinalEnvelopeInput;
  envelope: DiscoveryFinalEnvelope;
  state: 'prepared';
  cursor: { offset: 0 };
  result: null;
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (left: unknown, right: unknown) => canonical(left as never) === canonical(right as never);
const keys = (value: unknown, names: readonly string[]): value is Record<string, any> => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
function valid(value: unknown, message: string): asserts value {
  requireCondition(value, 'discovery_final_session_invalid', message);
}
const sessionId = (project: string, value: DiscoveryFinalSession) =>
  `${DISCOVERY_FINAL_SESSION_KIND}:${project}:${hashJson(value as never)}`;

function valueFor(project: string, input: DiscoveryFinalEnvelopeInput,
  staged: StagedDiscoveryFinalEnvelope): DiscoveryFinalSession {
  return { contract: DISCOVERY_FINAL_SESSION, project, subject: structuredClone(staged.envelope.subject),
    archive: structuredClone(staged.envelope.archive), environment: reference(staged.environment),
    role: structuredClone(input.role), input: structuredClone(input),
    envelope: structuredClone(staged.envelope), state: 'prepared', cursor: { offset: 0 }, result: null };
}

function decode(value: unknown): DiscoveryFinalSession {
  valid(keys(value, ['contract', 'project', 'subject', 'archive', 'environment', 'role', 'input',
    'envelope', 'state', 'cursor', 'result']) && value.contract === DISCOVERY_FINAL_SESSION
    && typeof value.project === 'string' && value.project.length > 0,
  'The prepared final session has an unknown or incomplete form');
  valid(isRef(value.archive) && keys(value.archive, ['id', 'revision', 'hash'])
    && isRef(value.environment) && keys(value.environment, ['id', 'revision', 'hash'])
    && object(value.role) && object(value.subject) && object(value.envelope),
  'The prepared final session lost its exact grounds');
  const input = decodeDiscoveryFinalEnvelopeInput(value.input);
  valid(value.state === 'prepared' && same(value.cursor, { offset: 0 }) && value.result === null,
    'The session has no paid, applied or accepted state');
  valid(same(value.environment, input.environment) && same(value.role, input.role),
    'The session role and environment differ from the preparation');
  return structuredClone(value) as DiscoveryFinalSession;
}

/** Read the exact immutable prepared session, re-proving D6, the historical
 * brief, saved environment, full archive and actual serialized envelope. */
export async function readDiscoveryFinalSessionAt(store: Store, project: string,
  ref: Ref): Promise<Revision<DiscoveryFinalSession>> {
  valid(isRef(ref) && keys(ref, ['id', 'revision', 'hash']), 'The final session needs an exact reference');
  const row = store.get<DiscoveryFinalSession>(ref.id, ref.revision);
  valid(row?.kind === DISCOVERY_FINAL_SESSION_KIND && same(reference(row), ref)
    && row.revision === 1 && hashJson(row.value as never) === ref.hash,
  'The exact final session is missing or has changed');
  const saved = decode(row.value);
  valid(saved.project === project && row.id === sessionId(project, saved),
    'The final session has another project or a noncanonical identity');
  const staged = await stageDiscoveryFinalEnvelope(store, project, saved.subject, saved.input);
  requireSavedDiscoveryFinalArchive(store, staged.envelope, staged.projection);
  valid(same(saved, valueFor(project, saved.input, staged)),
    'The final session differs from its freshly proven preparation');
  return { ...row, value: structuredClone(saved) };
}

/** Atomically save only the archive and the prepared cell after all proofs
 * and physical bounds pass. A race/restart reads the same winning cell. */
export async function prepareDiscoveryFinalSession(store: Store, project: string,
  subject: unknown, rawInput: unknown): Promise<Revision<DiscoveryFinalSession>> {
  const input = decodeDiscoveryFinalEnvelopeInput({materialContract:FINAL_MATERIAL_CONTRACT,...rawInput as object});
  const staged = await stageDiscoveryFinalEnvelope(store, project, subject, input);
  const value = valueFor(project, input, staged), id = sessionId(project, value);
  const existing = store.get<DiscoveryFinalSession>(id);
  if (existing) return readDiscoveryFinalSessionAt(store, project, reference(existing));
  try {
    const rows = store.writeMany([...staged.writes,
      { id, kind: DISCOVERY_FINAL_SESSION_KIND, expected: 0, value }], staged.guards);
    const saved = rows.find(row => row.id === id);
    valid(saved, 'The atomic preparation did not save its session');
    return { ...saved, value: structuredClone(value) } as Revision<DiscoveryFinalSession>;
  } catch (error) {
    if (error instanceof EngineError && error.code === 'revision_conflict') {
      const winner = store.get<DiscoveryFinalSession>(id);
      if (winner) return readDiscoveryFinalSessionAt(store, project, reference(winner));
    }
    throw error;
  }
}

import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { RoleBinding } from '../runtime/environment.js';
import type { Revision, Store } from '../storage/store.js';
import type { DiscoveryFinalAssessmentSubject } from './discovery-final-assessment-subject.js';
import { decodeDiscoveryFinalAssessmentEnvelopeInput, requireSavedDiscoveryFinalAssessmentArchive,
  stageDiscoveryFinalAssessmentEnvelope, type DiscoveryFinalAssessmentEnvelope, type DiscoveryFinalAssessmentEnvelopeInput,
  type StagedDiscoveryFinalAssessmentEnvelope } from './discovery-final-assessment-packing.js';

/** DR7 7a.3 (codex-omg2 №15630): the immutable saved basis of the complete request to the D7 assessor. It records
 * only that the request is prepared — the exact proven subject, the whole request and its archive, the exact saved
 * Environment and its reviewer, the separate request and reply limits with their original parameters. No call,
 * ledger, payment, supported or accepted mark exists here; it is no execution cursor and permits no send. The paid
 * evaluation of 7a.4 proves its own payment later. */
export const DISCOVERY_FINAL_ASSESSMENT_SESSION = 'discovery-final-assessment-session/v1' as const;
export const DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND = 'discovery-final-assessment-session' as const;

export interface DiscoveryFinalAssessmentSession {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_SESSION;
  kind: 'final-assessment';
  project: string;
  subject: DiscoveryFinalAssessmentSubject;
  archive: Ref;
  environment: Ref;
  role: RoleBinding;
  limits: { request: number; reply: number };
  input: DiscoveryFinalAssessmentEnvelopeInput;
  envelope: DiscoveryFinalAssessmentEnvelope;
  state: 'prepared';
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (left: unknown, right: unknown) => canonical(left as never) === canonical(right as never);
const keys = (value: unknown, names: readonly string[]): value is Record<string, any> => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
function valid(value: unknown, message: string): asserts value {
  requireCondition(value, 'discovery_final_assessment_session_invalid', message);
}
const exactRef = (value: unknown): value is Ref => isRef(value) && keys(value, ['id', 'revision', 'hash']);
/** One plain JSON snapshot of a caller value: an accessor or Proxy answering differently later is never read again. */
function snapshot(value: unknown, field: string): unknown {
  try { return JSON.parse(canonical(value)); }
  catch { throw new EngineError('discovery_final_assessment_session_invalid', `The ${field} is not a plain JSON value`, { field }); }
}
/** The identity derives from the project and the whole prepared value — never from caller input. */
const sessionId = (project: string, value: DiscoveryFinalAssessmentSession) =>
  `${DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND}:${project}:${hashJson(value as never)}`;

function valueFor(project: string, input: DiscoveryFinalAssessmentEnvelopeInput,
  staged: StagedDiscoveryFinalAssessmentEnvelope): DiscoveryFinalAssessmentSession {
  return { contract: DISCOVERY_FINAL_ASSESSMENT_SESSION, kind: 'final-assessment', project,
    subject: structuredClone(staged.envelope.subject), archive: structuredClone(staged.envelope.archive),
    environment: reference(staged.environment), role: structuredClone(input.role),
    limits: { request: input.limitChars, reply: input.resultLimitChars }, input: structuredClone(input),
    envelope: structuredClone(staged.envelope), state: 'prepared' };
}

function decode(value: unknown): DiscoveryFinalAssessmentSession {
  valid(keys(value, ['contract', 'kind', 'project', 'subject', 'archive', 'environment', 'role', 'limits', 'input', 'envelope', 'state'])
    && value.contract === DISCOVERY_FINAL_ASSESSMENT_SESSION && value.kind === 'final-assessment'
    && typeof value.project === 'string' && value.project.length > 0,
  'The prepared final assessment session has an unknown or incomplete form');
  valid(exactRef(value.archive) && exactRef(value.environment) && object(value.role) && object(value.subject) && object(value.envelope),
    'The prepared final assessment session lost its exact grounds');
  const input = decodeDiscoveryFinalAssessmentEnvelopeInput(value.input);
  valid(value.state === 'prepared', 'The session is prepared only: it has no paid, applied or accepted state');
  valid(same(value.environment, input.environment) && same(value.role, input.role)
    && keys(value.limits, ['request', 'reply']) && value.limits.request === input.limitChars && value.limits.reply === input.resultLimitChars,
    'The session role, environment or limits differ from its preparation');
  return structuredClone(value) as DiscoveryFinalAssessmentSession;
}

/** Read the exact immutable prepared session: the accepted preparation is derived again — the exact subject, the
 * verbatim assignment and the paid D6, the saved Environment, every saved archive part and the whole wire — and the
 * saved value must equal it. Late foreign heads never replace the historical references. The answer is a copy. */
export async function readDiscoveryFinalAssessmentSessionAt(store: Store, project: string,
  ref: unknown): Promise<Revision<DiscoveryFinalAssessmentSession>> {
  const at = snapshot(ref, 'session reference');
  valid(exactRef(at), 'The final assessment session needs an exact reference');
  const row = store.get<DiscoveryFinalAssessmentSession>(at.id, at.revision);
  valid(row?.kind === DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND && same(reference(row), at)
    && row.revision === 1 && hashJson(row.value as never) === at.hash,
  'The exact final assessment session is missing or has changed');
  const saved = decode(row.value);
  valid(saved.project === project && row.id === sessionId(project, saved),
    'The final assessment session has another project or a noncanonical identity');
  const staged = await stageDiscoveryFinalAssessmentEnvelope(store, project, saved.subject, saved.input);
  requireSavedDiscoveryFinalAssessmentArchive(store, staged.envelope, staged.projection);
  valid(same(saved, valueFor(project, saved.input, staged)),
    'The final assessment session differs from its freshly proven preparation');
  return structuredClone({ ...row, value: saved });
}

/** Save the archive, its missing parts and the prepared session in one guarded write, only after every proof and
 * physical bound passes; nothing is written before. A repeat, a restart or a lost race reads the same exact winner. */
export async function prepareDiscoveryFinalAssessmentSession(store: Store, project: string,
  subject: unknown, rawInput: unknown): Promise<Revision<DiscoveryFinalAssessmentSession>> {
  const input = decodeDiscoveryFinalAssessmentEnvelopeInput(snapshot(rawInput, 'preparation input'));
  const staged = await stageDiscoveryFinalAssessmentEnvelope(store, project, snapshot(subject, 'subject'), input);
  const value = valueFor(project, input, staged), id = sessionId(project, value);
  const existing = store.get<DiscoveryFinalAssessmentSession>(id);
  if (existing) return readDiscoveryFinalAssessmentSessionAt(store, project, reference(existing));
  try {
    const rows = store.writeMany([...staged.writes,
      { id, kind: DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND, expected: 0, value }], staged.guards);
    const saved = rows.find(row => row.id === id);
    valid(saved, 'The atomic preparation did not save its session');
    return structuredClone({ ...saved, value }) as Revision<DiscoveryFinalAssessmentSession>;
  } catch (error) {
    if (error instanceof EngineError && error.code === 'revision_conflict') {
      const winner = store.get<DiscoveryFinalAssessmentSession>(id);
      if (winner) return readDiscoveryFinalAssessmentSessionAt(store, project, reference(winner));
    }
    throw error;
  }
}

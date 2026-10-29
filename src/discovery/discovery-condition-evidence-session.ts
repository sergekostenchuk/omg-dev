import { FINAL_MATERIAL_CONTRACT, finalMaterialAdmission, finalMaterialArchive, finalMaterialEra, finalMaterialPointer, packFinalMaterial, type FinalMaterialContract } from './final-material.js';
import { contextWorkspace } from './context-workspace.js';
import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { readEnvironmentAt, type Environment, type RoleBinding } from '../runtime/environment.js';
import type { Revision, Store, TransactionGuard, Write } from '../storage/store.js';
import { readArchiveBody } from './request-parts.js';
import { contextValue } from './working-context.js';
import { addressArchivedMaterials, requirePacketMaterialDelivery, serveArchivedMaterial,
  type ResearchResultCapacity } from './research-delivery.js';
import { prepareResearchEnvelope } from './research-protocol.js';
import { prepareConditionEvidenceTransport, type ConditionEvidenceSubject } from './discovery-condition-evidence-subject.js';

/** OMG-V7-B3: the immutable prepared basis of the request to the evidence assessor — the exact subject, the whole
 * request and its archive, the saved Environment and its reviewer, the request and reply limits. It records only that
 * the request is prepared: no call, payment or resolution exists here. The physical request goes through the common
 * archive, delivery and envelope helpers; an oversized request is sent as positive addressed fragments. */
export const CONDITION_EVIDENCE_ENVELOPE = 'discovery-condition-evidence-envelope/v1' as const;
export const CONDITION_EVIDENCE_SESSION = 'discovery-condition-evidence-session/v1' as const;
export const CONDITION_EVIDENCE_SESSION_KIND = 'discovery-condition-evidence-session' as const;
const DELIVERY_INSTRUCTION = 'The full original request is retained in working.archive. '
  + 'Read every omitted exact address with read_context and continue through every page; '
  + 'a fragment is not the complete original and omitted material is not absent.';

export interface ConditionEvidenceEnvelopeInput {
  materialContract?: FinalMaterialContract;
  prompt: string; packetChars: number; limitChars: number; resultLimitChars: number; environment: Ref; role: RoleBinding;
}
export interface ConditionEvidenceEnvelope {
  contract: typeof CONDITION_EVIDENCE_ENVELOPE; subject: ConditionEvidenceSubject; archive: Ref;
  packet: Record<string, unknown>; capacity: ResearchResultCapacity; input: string; measuredChars: number;
}
export interface ConditionEvidenceSession {
  contract: typeof CONDITION_EVIDENCE_SESSION; kind: 'condition-evidence'; project: string; subject: ConditionEvidenceSubject;
  archive: Ref; environment: Ref; role: RoleBinding; limits: { request: number; reply: number };
  input: ConditionEvidenceEnvelopeInput; envelope: ConditionEvidenceEnvelope; state: 'prepared';
}
interface Staged { envelope: ConditionEvidenceEnvelope; environment: Revision<Environment>; projection: Record<string, unknown>;
  writes: Write[]; guards: TransactionGuard[] }

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (left: unknown, right: unknown) => canonical(left as never) === canonical(right as never);
const keys = (value: unknown, names: readonly string[]): value is Record<string, any> => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
function valid(value: unknown, message: string): asserts value {
  requireCondition(value, 'discovery_condition_evidence_session_invalid', message);
}
const exactRef = (value: unknown): value is Ref => keys(value, ['id', 'revision', 'hash']) && isRef(value);
function snapshot(value: unknown, field: string): unknown {
  try { return JSON.parse(canonical(value as never)); }
  catch { throw new EngineError('discovery_condition_evidence_session_invalid', `The ${field} is not a plain JSON value`, { field }); }
}

export function decodeConditionEvidenceEnvelopeInput(value: unknown): ConditionEvidenceEnvelopeInput {
  valid(keys(value, ['prompt', 'packetChars', 'limitChars', 'resultLimitChars', 'environment', 'role'])
    || keys(value, ['prompt', 'packetChars', 'limitChars', 'resultLimitChars', 'environment', 'role','materialContract']),
    'The evidence preparation needs its complete closed input');
  finalMaterialEra(value);
  valid(typeof value.prompt === 'string' && value.prompt.trim().length > 0, 'The evidence instruction is required');
  for (const field of ['packetChars', 'limitChars', 'resultLimitChars'] as const)
    valid(Number.isSafeInteger(value[field]) && value[field] > 0, 'Evidence bounds must be positive safe integers');
  valid(value.packetChars < value.limitChars, 'The packet must leave room for the physical envelope');
  valid(exactRef(value.environment), 'The preparation needs an exact saved environment');
  valid(object(value.role), 'The preparation needs a saved role');
  return structuredClone(value) as ConditionEvidenceEnvelopeInput;
}
const limitRefusal = (details: Record<string, number>) => new EngineError('discovery_condition_evidence_envelope_limit',
  'The complete physical evidence request exceeds its declared limit', details);

/** Plan the exact archive and the complete physical wire without writing. The role is the reviewer of the exact saved
 * environment, an actor other than its implementer. */
export function stageConditionEvidenceEnvelope(store: Store, project: string, subject: unknown, rawInput: unknown): Staged {
  const input = decodeConditionEvidenceEnvelopeInput(rawInput);
  const environment = readEnvironmentAt(store, project, input.environment);
  valid(same(input.role, environment.value.reviewer), 'The role is not the assessor of the exact saved environment');
  valid(environment.value.implementer.actor !== environment.value.reviewer.actor, 'The evidence assessment requires an actor other than the implementer');
  const result = prepareConditionEvidenceTransport(store, project, subject, input.resultLimitChars, { archive: 'staged', ...(input.materialContract ? {materialContract:input.materialContract} : {}) });
  valid(result.archive && 'archive' in result.capacity.mandatory, 'The result admission lost its exact staged projection');
  const original = result.archive.projection, body = finalMaterialArchive(original, finalMaterialEra(input));
  const staged = { archive: result.archive.ref, writes: result.archive.writes, guards: result.archive.guards };
  const pack = (limit: number): Record<string, any> => {
    const packet: Record<string, any> = { contract: CONDITION_EVIDENCE_ENVELOPE, subject: structuredClone(result.subject),
      schema: structuredClone(result.schema), request: structuredClone(original),
      working: { archive: staged.archive, deliveryContract: 'research-delivery/v1', instruction: DELIVERY_INSTRUCTION } };
    if (finalMaterialEra(input)) packFinalMaterial(packet, original, staged.archive, staged.archive, limit, contextWorkspace());
    else {
    const addressed = addressArchivedMaterials(packet, staged.archive, ['request'], limit, () => staged.archive, 1024);
    serveArchivedMaterial(packet, addressed, limit, 512);
    }
    requireCondition(JSON.stringify(packet).length <= limit, 'discovery_condition_evidence_packet_limit',
      'The bounded evidence packet exceeds its declared physical share');
    requirePacketMaterialDelivery(packet, staged.archive, (record, pointer) => {
      valid(same(record, staged.archive), 'An addressed original belongs to another archive');
      return contextValue({ body }, pointer);
    });
    return packet;
  };
  let packet = pack(input.packetChars);
  let wire: ReturnType<typeof prepareResearchEnvelope>;
  try {
    wire = prepareResearchEnvelope(input.role, environment.value, input.prompt, packet, undefined,
      result.capacity as unknown as Record<string, any>, undefined, undefined, input.limitChars, finalMaterialEra(input) ? limit => {
        // Count the actual capacity wrapper, then let the common wire builder
        // refine the complete physical envelope without changing saved bounds.
        packet = pack(Math.min(input.packetChars, limit - JSON.stringify({resultCapacity:result.capacity}).length - 32));
        return {...packet,resultCapacity:result.capacity};
      } : undefined);
  } catch (error) {
    if (error instanceof EngineError && (error.code === 'pilot_request_limit' || finalMaterialEra(input)
      && ['pilot_core_limit','research_context_capacity','discovery_condition_evidence_packet_limit'].includes(error.code))) throw limitRefusal({ limitChars: input.limitChars });
    throw error;
  }
  if (wire.input.length > input.limitChars) throw limitRefusal({ limitChars: input.limitChars, measuredChars: wire.input.length });
  const envelope: ConditionEvidenceEnvelope = { contract: CONDITION_EVIDENCE_ENVELOPE, subject: structuredClone(result.subject),
    archive: structuredClone(staged.archive), packet: structuredClone(packet), capacity: structuredClone(result.capacity),
    input: wire.input, measuredChars: wire.input.length };
  return { envelope, environment, projection: original, writes: staged.writes, guards: staged.guards };
}
/** The saved archive and every one of its parts hold the original the reconstructed packet addresses. */
function requireSavedArchive(store: Store, expected: ConditionEvidenceEnvelope, projection: Record<string, unknown>): void {
  const row = store.get(expected.archive.id, expected.archive.revision);
  valid(row?.kind === 'research-context' && same(reference(row), expected.archive) && hashJson(row.value as never) === expected.archive.hash,
    'The exact evidence archive is missing or changed');
  const body = readArchiveBody(store, row).body, mandatory = expected.capacity.mandatory;
  valid('archive' in mandatory && same(mandatory.archive.record, expected.archive) && mandatory.archive.pointer === finalMaterialPointer(finalMaterialEra((expected.packet.request as any) ?? {}))
    && mandatory.archive.hash === hashJson((mandatory.archive.pointer === '/body/admission' ? finalMaterialAdmission(projection) : projection) as never) && same(body.request, projection),
  'The saved evidence archive does not contain the proven complete request');
  requirePacketMaterialDelivery(expected.packet, expected.archive, (record, pointer) => {
    valid(same(record, expected.archive), 'The material address names another archive');
    return contextValue({ body }, pointer);
  });
}

const sessionId = (project: string, value: ConditionEvidenceSession) => `${CONDITION_EVIDENCE_SESSION_KIND}:${project}:${hashJson(value as never)}`;
function valueFor(project: string, input: ConditionEvidenceEnvelopeInput, staged: Staged): ConditionEvidenceSession {
  return { contract: CONDITION_EVIDENCE_SESSION, kind: 'condition-evidence', project, subject: structuredClone(staged.envelope.subject),
    archive: structuredClone(staged.envelope.archive), environment: reference(staged.environment), role: structuredClone(input.role),
    limits: { request: input.limitChars, reply: input.resultLimitChars }, input: structuredClone(input),
    envelope: structuredClone(staged.envelope), state: 'prepared' };
}
/** Read the exact immutable prepared session: the preparation is derived again and the saved value must equal it. */
export function readConditionEvidenceSessionAt(store: Store, project: string, ref: unknown): Revision<ConditionEvidenceSession> {
  const at = snapshot(ref, 'session reference');
  valid(exactRef(at), 'The evidence session needs an exact reference');
  const row = store.get<ConditionEvidenceSession>(at.id, at.revision);
  valid(row?.kind === CONDITION_EVIDENCE_SESSION_KIND && same(reference(row), at) && row.revision === 1 && hashJson(row.value as never) === at.hash
    && object(row.value), 'The exact evidence session is missing or has changed');
  const saved = row.value;
  valid(keys(saved, ['contract', 'kind', 'project', 'subject', 'archive', 'environment', 'role', 'limits', 'input', 'envelope', 'state'])
    && saved.contract === CONDITION_EVIDENCE_SESSION && saved.kind === 'condition-evidence' && saved.state === 'prepared'
    && saved.project === project && row.id === sessionId(project, saved), 'The evidence session has an unknown form, another project or identity');
  const input = decodeConditionEvidenceEnvelopeInput(saved.input);
  const staged = stageConditionEvidenceEnvelope(store, project, saved.subject, input);
  requireSavedArchive(store, staged.envelope, staged.projection);
  valid(same(saved, valueFor(project, input, staged)), 'The evidence session differs from its freshly proven preparation');
  return structuredClone(row);
}
/** Save the archive, its parts and the prepared session in one guarded write after every proof; a repeat, a restart
 * or a lost race reads the same exact winner. */
export function prepareConditionEvidenceSession(store: Store, project: string, subject: unknown, rawInput: unknown): Revision<ConditionEvidenceSession> {
  const input = decodeConditionEvidenceEnvelopeInput({materialContract:FINAL_MATERIAL_CONTRACT,...snapshot(rawInput, 'preparation input') as object});
  const staged = stageConditionEvidenceEnvelope(store, project, snapshot(subject, 'subject'), input);
  const value = valueFor(project, input, staged), id = sessionId(project, value);
  const existing = store.get<ConditionEvidenceSession>(id);
  if (existing) return readConditionEvidenceSessionAt(store, project, reference(existing));
  try {
    const rows = store.writeMany([...staged.writes, { id, kind: CONDITION_EVIDENCE_SESSION_KIND, expected: 0, value }], staged.guards);
    const saved = rows.find(row => row.id === id);
    valid(saved, 'The atomic preparation did not save its session');
    return structuredClone({ ...saved, value }) as Revision<ConditionEvidenceSession>;
  } catch (error) {
    if (error instanceof EngineError && error.code === 'revision_conflict') {
      const winner = store.get<ConditionEvidenceSession>(id);
      if (winner) return readConditionEvidenceSessionAt(store, project, reference(winner));
    }
    throw error;
  }
}

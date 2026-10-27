import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { readEnvironmentAt, type Environment, type RoleBinding } from '../runtime/environment.js';
import type { Revision, Store, Write, TransactionGuard } from '../storage/store.js';
import { readArchiveBody } from './request-parts.js';
import { contextValue } from './working-context.js';
import { addressArchivedMaterials, requirePacketMaterialDelivery, serveArchivedMaterial,
  type ResearchResultCapacity } from './research-delivery.js';
import { prepareResearchEnvelope } from './research-protocol.js';
import { prepareDiscoveryFinalAssessmentTransport } from './discovery-final-assessment-request.js';
import type { DiscoveryFinalAssessmentSubject } from './discovery-final-assessment-subject.js';

/** DR7 7a.3 (codex-omg2 №15531): the physical request to the D7 assessor through the common archive, delivery and
 * envelope helpers — no second transport. The archive keeps the whole proven request; an oversized request is
 * sent as positive addressed fragments with exact pages, never replaced by a hash, a heading or a first window.
 * Nothing here pays, runs, accepts or opens a session: it is the preparation and check of the delivery. */
export const DISCOVERY_FINAL_ASSESSMENT_ENVELOPE = 'discovery-final-assessment-envelope/v1' as const;
const DELIVERY_INSTRUCTION = 'The full original request is retained in working.archive. '
  + 'Read every omitted exact address with read_context and continue through every page; '
  + 'a fragment is not the complete original and omitted material is not absent.';

export interface DiscoveryFinalAssessmentEnvelopeInput {
  prompt: string;
  packetChars: number;
  limitChars: number;
  resultLimitChars: number;
  environment: Ref;
  role: RoleBinding;
}
export interface DiscoveryFinalAssessmentEnvelope {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_ENVELOPE;
  subject: DiscoveryFinalAssessmentSubject;
  archive: Ref;
  packet: Record<string, unknown>;
  capacity: ResearchResultCapacity;
  input: string;
  measuredChars: number;
}
export interface StagedDiscoveryFinalAssessmentEnvelope {
  envelope: DiscoveryFinalAssessmentEnvelope;
  environment: Revision<Environment>;
  projection: Record<string, unknown>;
  writes: Write[];
  guards: TransactionGuard[];
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (left: unknown, right: unknown) => canonical(left as never) === canonical(right as never);
const keys = (value: unknown, names: readonly string[]): value is Record<string, any> => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
function valid(value: unknown, message: string): asserts value {
  requireCondition(value, 'discovery_final_assessment_packing_invalid', message);
}
function exactRef(value: unknown): value is Ref {
  return keys(value, ['id', 'revision', 'hash']) && isRef(value);
}
const limitRefusal = (details: Record<string, number>) => new EngineError('discovery_final_assessment_envelope_limit',
  'The complete physical final assessment request exceeds its declared limit', details);

/** Validate every caller-controlled preparation parameter before anything is staged. */
export function decodeDiscoveryFinalAssessmentEnvelopeInput(value: unknown): DiscoveryFinalAssessmentEnvelopeInput {
  valid(keys(value, ['prompt', 'packetChars', 'limitChars', 'resultLimitChars', 'environment', 'role']),
    'The final assessment preparation needs its complete closed input');
  valid(typeof value.prompt === 'string' && value.prompt.trim().length > 0, 'The assessment instruction is required');
  for (const field of ['packetChars', 'limitChars', 'resultLimitChars'] as const)
    valid(Number.isSafeInteger(value[field]) && value[field] > 0, 'Assessment bounds must be positive safe integers');
  valid(value.packetChars < value.limitChars, 'The packet must leave room for the physical envelope');
  valid(exactRef(value.environment), 'The preparation needs an exact saved environment');
  valid(object(value.role), 'The preparation needs a saved role');
  return structuredClone(value) as DiscoveryFinalAssessmentEnvelopeInput;
}

/** Plan the exact archive and the complete physical wire without writing. The role is the assessor of the exact
 * saved environment, an actor other than its implementer. */
export async function stageDiscoveryFinalAssessmentEnvelope(store: Store, project: string, subject: unknown,
  rawInput: unknown): Promise<StagedDiscoveryFinalAssessmentEnvelope> {
  const input = decodeDiscoveryFinalAssessmentEnvelopeInput(rawInput);
  const environment = readEnvironmentAt(store, project, input.environment);
  valid(same(input.role, environment.value.reviewer), 'The role is not the assessor of the exact saved environment');
  valid(environment.value.implementer.actor !== environment.value.reviewer.actor,
    'The final assessment requires an actor other than the implementer');
  const result = await prepareDiscoveryFinalAssessmentTransport(store, project, subject, input.resultLimitChars, { archive: 'staged' });
  valid(result.archive && 'archive' in result.capacity.mandatory, 'The result admission lost its exact staged projection');
  const original = result.archive.projection, body = { request: original };
  const staged = { archive: result.archive.ref, writes: result.archive.writes, guards: result.archive.guards };
  const packet: Record<string, any> = { contract: DISCOVERY_FINAL_ASSESSMENT_ENVELOPE,
    subject: structuredClone(result.subject), schema: structuredClone(result.schema),
    request: structuredClone(original), working: { archive: staged.archive,
      deliveryContract: 'research-delivery/v1', instruction: DELIVERY_INSTRUCTION } };
  const addressed = addressArchivedMaterials(packet, staged.archive, ['request'], input.packetChars, () => staged.archive, 1024);
  serveArchivedMaterial(packet, addressed, input.packetChars, 512);
  requireCondition(JSON.stringify(packet).length <= input.packetChars, 'discovery_final_assessment_packet_limit',
    'The bounded assessment packet exceeds its declared physical share');
  requirePacketMaterialDelivery(packet, staged.archive, (record, pointer) => {
    valid(same(record, staged.archive), 'An addressed original belongs to another archive');
    return contextValue({ body }, pointer);
  });
  let wire: ReturnType<typeof prepareResearchEnvelope>;
  try {
    wire = prepareResearchEnvelope(input.role, environment.value, input.prompt, packet,
      undefined, result.capacity as unknown as Record<string, any>, undefined, undefined, input.limitChars);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'pilot_request_limit') throw limitRefusal({ limitChars: input.limitChars });
    throw error;
  }
  if (wire.input.length > input.limitChars) throw limitRefusal({ limitChars: input.limitChars, measuredChars: wire.input.length });
  const envelope: DiscoveryFinalAssessmentEnvelope = { contract: DISCOVERY_FINAL_ASSESSMENT_ENVELOPE,
    subject: structuredClone(result.subject), archive: structuredClone(staged.archive), packet: structuredClone(packet),
    capacity: structuredClone(result.capacity), input: wire.input, measuredChars: wire.input.length };
  return { envelope, environment, projection: original, writes: staged.writes, guards: staged.guards };
}

/** Prove that the actual saved archive and every one of its parts hold the original the reconstructed packet addresses. */
export function requireSavedDiscoveryFinalAssessmentArchive(store: Store, expected: DiscoveryFinalAssessmentEnvelope,
  projection: Record<string, unknown>): void {
  const row = store.get(expected.archive.id, expected.archive.revision);
  valid(row?.kind === 'research-context' && same(reference(row), expected.archive)
    && hashJson(row.value as never) === expected.archive.hash, 'The exact final assessment archive is missing or changed');
  const body = readArchiveBody(store, row).body;
  const mandatory = expected.capacity.mandatory;
  valid('archive' in mandatory && same(mandatory.archive.record, expected.archive)
    && mandatory.archive.pointer === '/body/request' && mandatory.archive.hash === hashJson(projection as never)
    && same(body.request, projection), 'The saved final assessment archive does not contain the proven complete request');
  requirePacketMaterialDelivery(expected.packet, expected.archive, (record, pointer) => {
    valid(same(record, expected.archive), 'The material address names another archive');
    return contextValue({ body }, pointer);
  });
}

/** Commit the exact staged archive and all of its parts in one guarded write, only after the complete wire fits;
 * a repeat or a cold Store reads the same exact addresses. */
export async function prepareDiscoveryFinalAssessmentEnvelope(store: Store, project: string, subject: unknown,
  input: unknown): Promise<DiscoveryFinalAssessmentEnvelope> {
  const staged = await stageDiscoveryFinalAssessmentEnvelope(store, project, subject, input);
  if (staged.writes.length) {
    try { store.writeMany(staged.writes, staged.guards); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'revision_conflict') throw error;
    }
  }
  requireSavedDiscoveryFinalAssessmentArchive(store, staged.envelope, staged.projection);
  return structuredClone(staged.envelope);
}

/** Re-prove the subject and compare every byte of the presented envelope against the common physical builder and
 * the saved archive. */
export async function requireDiscoveryFinalAssessmentEnvelope(store: Store, project: string, subject: unknown,
  input: unknown, presented: unknown): Promise<DiscoveryFinalAssessmentEnvelope> {
  valid(keys(presented, ['contract', 'subject', 'archive', 'packet', 'capacity', 'input', 'measuredChars'])
    && presented.contract === DISCOVERY_FINAL_ASSESSMENT_ENVELOPE && exactRef(presented.archive)
    && typeof presented.input === 'string' && Number.isSafeInteger(presented.measuredChars)
    && presented.measuredChars === presented.input.length, 'The final assessment envelope has a foreign or incomplete form');
  const staged = await stageDiscoveryFinalAssessmentEnvelope(store, project, subject, input);
  requireSavedDiscoveryFinalAssessmentArchive(store, staged.envelope, staged.projection);
  valid(same(presented, staged.envelope), 'The final assessment envelope differs from its proven complete request');
  return structuredClone(staged.envelope);
}

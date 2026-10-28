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
import { prepareDiscoveryFinalResultTransport } from './discovery-final-result.js';
import type { DiscoveryFinalSubject } from './discovery-final.js';
import { V7_FINAL_CONTRACT, V8_FINAL_CONTRACT, V9_FINAL_CONTRACT } from './v7-final-contracts.js';

/** A prepared request is not a paid result or an accepted Discovery stage. */
export const DISCOVERY_FINAL_ENVELOPE = 'discovery-final-envelope/v1' as const;
const DELIVERY_INSTRUCTION = 'The full original request is retained in working.archive. '
  + 'Read every omitted exact address with read_context and continue through every page; '
  + 'a fragment is not the complete original and omitted material is not absent.';

export interface DiscoveryFinalEnvelopeInput {
  /** 7b.3-class: the D7 form version, present only for a form after discovery-final/v7; its absence is v7, so the
   * saved preparations and identities of v7 are unchanged. Fixed in the immutable preparation before any payment. */
  form?: typeof V8_FINAL_CONTRACT | typeof V9_FINAL_CONTRACT;
  prompt: string;
  packetChars: number;
  limitChars: number;
  resultLimitChars: number;
  environment: Ref;
  role: RoleBinding;
}
export interface DiscoveryFinalEnvelope {
  contract: typeof DISCOVERY_FINAL_ENVELOPE;
  subject: DiscoveryFinalSubject;
  archive: Ref;
  packet: Record<string, unknown>;
  capacity: ResearchResultCapacity;
  input: string;
  measuredChars: number;
}
export interface StagedDiscoveryFinalEnvelope {
  envelope: DiscoveryFinalEnvelope;
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
  requireCondition(value, 'discovery_final_packing_invalid', message);
}
function exactRef(value: unknown): value is Ref {
  return keys(value, ['id', 'revision', 'hash']) && isRef(value);
}

/** Validate all caller-controlled preparation parameters before staging writes. */
export function decodeDiscoveryFinalEnvelopeInput(value: unknown): DiscoveryFinalEnvelopeInput {
  const base = ['prompt', 'packetChars', 'limitChars', 'resultLimitChars', 'environment', 'role'];
  valid(keys(value, base) || keys(value, [...base, 'form']), 'The final preparation needs its complete closed input');
  valid(!Object.hasOwn(value, 'form') || value.form === V8_FINAL_CONTRACT || value.form === V9_FINAL_CONTRACT,
    'The final preparation names an unknown D7 form version; discovery-final/v7 is named by the absence of form');
  valid(typeof value.prompt === 'string' && value.prompt.trim().length > 0, 'The final instruction is required');
  for (const field of ['packetChars', 'limitChars', 'resultLimitChars'] as const)
    valid(Number.isSafeInteger(value[field]) && value[field] > 0, 'Final bounds must be positive safe integers');
  valid(value.packetChars < value.limitChars, 'The packet must leave room for the physical envelope');
  valid(exactRef(value.environment), 'The preparation needs an exact saved environment');
  valid(object(value.role), 'The preparation needs a saved role');
  return structuredClone(value) as DiscoveryFinalEnvelopeInput;
}

/** Plan the exact archive and complete physical wire without writing. The
 * archive retains the whole proven request; an oversized request is sent as
 * a positive addressed fragment, never represented as a complete summary. */
export async function stageDiscoveryFinalEnvelope(store: Store, project: string, subject: unknown,
  rawInput: unknown): Promise<StagedDiscoveryFinalEnvelope> {
  const input = decodeDiscoveryFinalEnvelopeInput(rawInput);
  const environment = readEnvironmentAt(store, project, input.environment);
  valid(same(input.role, environment.value.implementer) || same(input.role, environment.value.reviewer),
    'The role is not declared by the exact saved environment');
  const result = await prepareDiscoveryFinalResultTransport(store, project, subject, input.resultLimitChars,
    { archive: 'staged' }, input.form ?? V7_FINAL_CONTRACT);
  valid(result.archive && 'archive' in result.capacity.mandatory,
    'The result admission lost its exact staged projection');
  const original = result.archive.projection;
  const body = { request: original };
  const staged = { archive: result.archive.ref, writes: result.archive.writes, guards: result.archive.guards };
  const packet: Record<string, any> = { contract: DISCOVERY_FINAL_ENVELOPE,
    subject: structuredClone(result.subject), schema: structuredClone(result.schema),
    request: structuredClone(original), working: { archive: staged.archive,
      deliveryContract: 'research-delivery/v1', instruction: DELIVERY_INSTRUCTION } };
  const addressed = addressArchivedMaterials(packet, staged.archive, ['request'], input.packetChars,
    () => staged.archive, 1024);
  serveArchivedMaterial(packet, addressed, input.packetChars, 512);
  requireCondition(JSON.stringify(packet).length <= input.packetChars, 'discovery_final_packet_limit',
    'The bounded request packet exceeds its declared physical share');
  requirePacketMaterialDelivery(packet, staged.archive, (record, pointer) => {
    valid(same(record, staged.archive), 'An addressed original belongs to another archive');
    return contextValue({ body }, pointer);
  });
  const capacity = result.capacity;
  let wire: ReturnType<typeof prepareResearchEnvelope>;
  try {
    wire = prepareResearchEnvelope(input.role, environment.value, input.prompt, packet,
      undefined, capacity as unknown as Record<string, any>, undefined, undefined, input.limitChars);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'pilot_request_limit')
      throw new EngineError('discovery_final_envelope_limit',
        'The complete physical final request exceeds its declared limit', { limitChars: input.limitChars });
    throw error;
  }
  if (wire.input.length > input.limitChars) throw new EngineError('discovery_final_envelope_limit',
    'The complete physical final request exceeds its declared limit',
    { limitChars: input.limitChars, measuredChars: wire.input.length });
  const envelope: DiscoveryFinalEnvelope = { contract: DISCOVERY_FINAL_ENVELOPE,
    subject: structuredClone(result.subject), archive: structuredClone(staged.archive),
    packet: structuredClone(packet), capacity: structuredClone(capacity), input: wire.input,
    measuredChars: wire.input.length };
  return { envelope, environment, projection: original, writes: staged.writes, guards: staged.guards };
}

/** Prove that the actual saved archive and all of its parts contain the
 * original that the freshly reconstructed packet addresses. */
export function requireSavedDiscoveryFinalArchive(store: Store, expected: DiscoveryFinalEnvelope,
  projection: Record<string, unknown>): void {
  const row = store.get(expected.archive.id, expected.archive.revision);
  valid(row?.kind === 'research-context' && same(reference(row), expected.archive)
    && hashJson(row.value as never) === expected.archive.hash, 'The exact final archive is missing or changed');
  const body = readArchiveBody(store, row).body;
  const mandatory = expected.capacity.mandatory;
  valid('archive' in mandatory && same(mandatory.archive.record, expected.archive)
    && mandatory.archive.pointer === '/body/request' && mandatory.archive.hash === hashJson(projection)
    && same(body.request, projection),
    'The saved final archive does not contain the proven complete request');
  requirePacketMaterialDelivery(expected.packet, expected.archive, (record, pointer) => {
    valid(same(record, expected.archive), 'The material address names another archive');
    return contextValue({ body }, pointer);
  });
}

/** Commit the exact staged archive only after the complete wire fits. */
export async function prepareDiscoveryFinalEnvelope(store: Store, project: string, subject: unknown,
  input: unknown): Promise<DiscoveryFinalEnvelope> {
  const staged = await stageDiscoveryFinalEnvelope(store, project, subject, input);
  if (staged.writes.length) {
    try { store.writeMany(staged.writes, staged.guards); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'revision_conflict') throw error;
    }
  }
  requireSavedDiscoveryFinalArchive(store, staged.envelope, staged.projection);
  return structuredClone(staged.envelope);
}

/** Re-prove the historical D6 packet and compare every byte of the presented
 * envelope against the common physical builder and the saved archive. */
export async function requireDiscoveryFinalEnvelope(store: Store, project: string, subject: unknown,
  input: unknown, presented: unknown): Promise<DiscoveryFinalEnvelope> {
  valid(keys(presented, ['contract', 'subject', 'archive', 'packet', 'capacity', 'input', 'measuredChars'])
    && presented.contract === DISCOVERY_FINAL_ENVELOPE && exactRef(presented.archive)
    && typeof presented.input === 'string' && Number.isSafeInteger(presented.measuredChars)
    && presented.measuredChars === presented.input.length, 'The final envelope has a foreign or incomplete form');
  const staged = await stageDiscoveryFinalEnvelope(store, project, subject, input);
  requireSavedDiscoveryFinalArchive(store, staged.envelope, staged.projection);
  valid(same(presented, staged.envelope), 'The final envelope differs from its proven complete request');
  return structuredClone(staged.envelope);
}

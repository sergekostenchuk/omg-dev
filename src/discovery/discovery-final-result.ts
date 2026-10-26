import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Store, TransactionGuard, Write } from '../storage/store.js';
import { DISCOVERY_FINAL_PACKET, requireDiscoveryFinalPacket, requireDiscoveryFinalSubject,
  type DiscoveryFinalPacket, type DiscoveryFinalSubject } from './discovery-final.js';
import { V7_FINAL_SCHEMA, checkV7Final, type V7FinalBundle } from './v7-final-contracts.js';
import { buildResearchResultCapacity, requireResearchResultCapacity, measureResearchResult,
  type ResearchResultCapacity, type ResearchResultCapacityInput } from './research-delivery.js';
import { RESULT_CAPACITY_REFUSAL } from './early-research-outcome.js';
import { prepareArchiveParts, readArchiveBody } from './request-parts.js';

/** A structural D7 reply, not a payment, publication or acceptance. */
export const DISCOVERY_FINAL_RESULT = 'discovery-final-result/v1' as const;
export const DISCOVERY_FINAL_RESULT_PROJECTION = 'discovery-final-result-projection/v1' as const;
const FORM = 'discovery_final';

export interface DiscoveryFinalResult {
  contract: typeof DISCOVERY_FINAL_RESULT;
  subject: DiscoveryFinalSubject;
  bundle: V7FinalBundle;
}
export interface DiscoveryFinalResultProjection {
  contract: typeof DISCOVERY_FINAL_RESULT_PROJECTION;
  packet: DiscoveryFinalPacket;
  result: DiscoveryFinalResult;
}
export interface DiscoveryFinalResultTransport {
  contract: typeof DISCOVERY_FINAL_RESULT;
  subject: DiscoveryFinalSubject;
  packet: DiscoveryFinalPacket;
  schema: Record<string, unknown>;
  capacity: ResearchResultCapacity;
  /** Only the explicitly requested staged form has archive writes. */
  archive?: { ref: Ref; projection: Record<string, unknown>; writes: Write[]; guards: TransactionGuard[] };
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const keys = (value: unknown, expected: readonly string[]) => object(value)
  && same(Object.keys(value).sort(), [...expected].sort());
function valid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'discovery_final_result_invalid', message);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Exact subject plus the unchanged shared D7 schema. Each declaration owns its
 * immutable copy, so callers cannot modify the shared D7 contract or another call. */
function declaration(packet: DiscoveryFinalPacket): Record<string, unknown> {
  return deepFreeze({ type: 'object', additionalProperties: false,
    required: ['contract', 'subject', 'bundle'], properties: {
      contract: { const: DISCOVERY_FINAL_RESULT }, subject: { const: structuredClone(packet.subject) },
      bundle: structuredClone(V7_FINAL_SCHEMA) } });
}
function admission(packet: DiscoveryFinalPacket, schema: Record<string, unknown>, limit: number): ResearchResultCapacityInput {
  return { operation: packet.subject.identity, generation: 0,
    bindings: { projectId: packet.subject.projectId, subject: packet.subject },
    role: 'synthesizer', purpose: 'discovery-final', actionMode: 'final-result-preflight',
    envelopeLimitChars: limit,
    mandatoryEnvelope: { contract: DISCOVERY_FINAL_RESULT, subject: packet.subject, packet, schema },
    forms: [{ kind: FORM }] };
}

/** The shared archive producer derives its address solely from the freshly
 * proven final packet and its unchanged result declaration. */
function archiveFor(store: Store, packet: DiscoveryFinalPacket, minimum: Record<string, unknown>) {
  const staged = prepareArchiveParts(store, { projectId: packet.subject.projectId,
    draft: packet.subject.basis.draft, question: packet.subject.basis.brief.question }, { request: minimum });
  valid(staged.archive.revision === 1, 'The final result archive must be immutable');
  return { staged, address: { record: staged.archive, pointer: '/body/request', hash: hashJson(minimum) } };
}

function savedArchiveProjection(store: Store, address: { record: Ref; pointer: string; hash: string },
  minimum: Record<string, unknown>): Record<string, unknown> {
  const row = store.get(address.record.id, address.record.revision);
  valid(row?.kind === 'research-context' && row.revision === 1
    && same(reference(row), address.record) && hashJson(row.value as never) === address.record.hash,
  'The exact final result archive is missing or changed');
  const body = readArchiveBody(store, row).body;
  valid(address.pointer === '/body/request' && same(body.request, minimum)
    && hashJson(body.request) === address.hash,
  'The saved final result minimum differs from the proven packet and schema');
  return body.request;
}

/** Pure projection of a candidate over its supplied packet. It does not prove
 * the packet or claim the candidate was paid or accepted; use the checked door
 * below when an independently proven packet is needed. */
export function projectDiscoveryFinal(packet: DiscoveryFinalPacket, reply: unknown): DiscoveryFinalResultProjection {
  valid(keys(packet, ['contract', 'subject', 'assessment', 'dossier', 'basis', 'brief', 'terminal'])
    && packet.contract === DISCOVERY_FINAL_PACKET && object(packet.subject)
    && object(packet.dossier) && object(packet.dossier.manifest) && object(packet.assessment)
    && object(packet.assessment.value) && object(packet.assessment.value.result)
    && keys(packet.brief, ['question', 'fact', 'acceptance', 'source', 'observation', 'text'])
    && typeof packet.brief.text === 'string'
    && keys(packet.terminal, ['session', 'application', 'call', 'request', 'response'])
    && Object.values(packet.terminal).every(object), 'A complete final packet is required');
  valid(same(packet.dossier, packet.assessment.value.result.packet) && same(packet.basis, packet.dossier.basis),
    'The final packet must retain the complete assessed dossier');
  valid(object(reply) && keys(reply, ['bundle', 'contract', 'subject'])
    && reply.contract === DISCOVERY_FINAL_RESULT && same(reply.subject, packet.subject),
    'The result must name the complete exact final subject');
  const bundle = checkV7Final(reply.bundle);
  valid(same(bundle.dossier, packet.dossier.manifest.ref), 'The D7 bundle must name the exact dossier manifest');
  const result: DiscoveryFinalResult = { contract: DISCOVERY_FINAL_RESULT,
    subject: structuredClone(packet.subject), bundle: structuredClone(bundle) };
  return { contract: DISCOVERY_FINAL_RESULT_PROJECTION, packet: structuredClone(packet), result };
}

/** Prepare a read-only transport from the common exact paid-D6 subject reader.
 * The limit comes from the caller's admission; it is not a physical wire claim. */
export async function prepareDiscoveryFinalResultTransport(store: Store, project: string,
  subject: unknown, envelopeLimitChars: number,
  options?: { archive: 'staged' }): Promise<DiscoveryFinalResultTransport> {
  const packet = await requireDiscoveryFinalSubject(store, project, subject);
  const schema = declaration(packet);
  valid(options === undefined || keys(options, ['archive']) && options.archive === 'staged',
    'The final result archive option has an unknown form');
  const input = admission(packet, schema, envelopeLimitChars);
  if (options) {
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope);
    // `subject` is reserved by the common physical builder for a V7PlanSubject.
    // A D7 subject is a different contract, so retain its complete value under
    // its own name rather than masquerading as an admitted plan question.
    const bindings = { projectId: packet.subject.projectId, finalSubject: packet.subject };
    const capacity = buildResearchResultCapacity({ ...input, bindings, mandatoryArchive: prepared.address });
    return { contract: DISCOVERY_FINAL_RESULT, subject: structuredClone(packet.subject), packet, schema, capacity,
      archive: { ref: prepared.staged.archive, projection: structuredClone(input.mandatoryEnvelope),
        writes: prepared.staged.writes, guards: prepared.staged.guards } };
  }
  const capacity = buildResearchResultCapacity(input);
  return { contract: DISCOVERY_FINAL_RESULT, subject: structuredClone(packet.subject), packet, schema, capacity };
}

/** Re-prove the entire supplied packet once, rederive its exact admission using
 * the caller's independently known limit, then measure the complete serialized
 * reply. No session or model call is created. */
export async function checkDiscoveryFinalResearchReply(store: Store, project: string,
  packetInput: unknown, envelopeLimitChars: number, saved: unknown, reply: unknown) {
  const packet = await requireDiscoveryFinalPacket(store, project, packetInput);
  const schema = declaration(packet);
  const input = admission(packet, schema, envelopeLimitChars);
  const mandatory = object(saved) && object(saved.mandatory) ? saved.mandatory : null;
  if (mandatory && Object.hasOwn(mandatory, 'archive')) {
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope);
    valid(same(mandatory.archive, prepared.address), 'The result capacity names another archive or pointer');
    const projection = savedArchiveProjection(store, prepared.address, input.mandatoryEnvelope);
    const bindings = { projectId: packet.subject.projectId, finalSubject: packet.subject };
    requireResearchResultCapacity(saved, { ...input, bindings, mandatoryArchive: prepared.address },
      (record, pointer) => {
        valid(same(record, prepared.address.record) && pointer === prepared.address.pointer,
          'The result capacity resolved another archive');
        return projection;
      });
  } else requireResearchResultCapacity(saved, input);
  const projection = projectDiscoveryFinal(packet, reply);
  const measurement = measureResearchResult(saved, FORM, projection.result);
  if (!measurement.fits) throw new EngineError(RESULT_CAPACITY_REFUSAL,
    'The complete final reply exceeds its admitted serialized envelope', measurement);
  return { kind: FORM, terminal: true, normalized: projection.result, measurement, projection };
}

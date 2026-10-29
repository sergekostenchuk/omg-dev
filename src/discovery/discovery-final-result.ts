import { finalMaterialAdmission, finalMaterialArchive, finalMaterialEra, finalMaterialPointer, type FinalMaterialContract } from './final-material.js';
import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import type { Ref } from '../pipeline/contracts.js';
import type { Store, TransactionGuard, Write } from '../storage/store.js';
import { DISCOVERY_FINAL_PACKET, requireDiscoveryFinalPacket, requireDiscoveryFinalSubject,
  type DiscoveryFinalPacket, type DiscoveryFinalSubject } from './discovery-final.js';
import { checkFinalProjectionGrounds } from './discovery-final-projection.js';
import { FINAL_BUNDLE_CONTRACTS, V7_FINAL_CONTRACT, V9_FINAL_CONTRACT, checkFinalBundle, finalBundleSchema, type FinalBundleContract,
  type V7FinalBundle } from './v7-final-contracts.js';
import { buildResearchResultCapacity, requireResearchResultCapacity, measureResearchResult,
  type ResearchResultCapacity, type ResearchResultCapacityInput } from './research-delivery.js';
import { RESULT_CAPACITY_REFUSAL, readFinalCapacityProjection } from './early-research-outcome.js';
import { prepareArchiveParts } from './request-parts.js';

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

/** Exact subject plus the unchanged shared D7 schema of the prepared form version. Each declaration owns its
 * immutable copy, so callers cannot modify the shared D7 contract or another call. */
function declaration(packet: DiscoveryFinalPacket, form: FinalBundleContract): Record<string, unknown> {
  return deepFreeze({ type: 'object', additionalProperties: false,
    required: ['contract', 'subject', 'bundle'], properties: {
      contract: { const: DISCOVERY_FINAL_RESULT }, subject: { const: structuredClone(packet.subject) },
      bundle: structuredClone(finalBundleSchema(form)) } });
}
/** 7b.3-class: the D7 form version of a preparation — discovery-final/v7 unless the saved preparation names another. */
function formOf(form: unknown): FinalBundleContract {
  valid((FINAL_BUNDLE_CONTRACTS as readonly unknown[]).includes(form), 'The final result names an unknown D7 form version');
  return form as FinalBundleContract;
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
function archiveFor(store: Store, packet: DiscoveryFinalPacket, minimum: Record<string, unknown>, era = false) {
  const staged = prepareArchiveParts(store, { projectId: packet.subject.projectId,
    draft: packet.subject.basis.draft, question: packet.subject.basis.brief.question }, finalMaterialArchive(minimum, era));
  valid(staged.archive.revision === 1, 'The final result archive must be immutable');
  return { staged, address: { record: staged.archive, pointer: finalMaterialPointer(era), hash: hashJson(era ? finalMaterialAdmission(minimum) : minimum) } };
}

function savedArchiveProjection(store: Store, address: { record: Ref; pointer: string; hash: string },
  minimum: Record<string, unknown>): Record<string, unknown> {
  const projection = readFinalCapacityProjection(store, address.record, address.pointer);
  valid(same(projection, minimum) && hashJson(projection) === address.hash,
  'The saved final result minimum differs from the proven packet and schema');
  return projection;
}

/** Pure projection of a candidate over its supplied packet. It does not prove
 * the packet or claim the candidate was paid or accepted; use the checked door
 * below when an independently proven packet is needed. */
export function projectDiscoveryFinal(packet: DiscoveryFinalPacket, reply: unknown,
  form: FinalBundleContract = V7_FINAL_CONTRACT): DiscoveryFinalResultProjection {
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
  const bundle = checkFinalBundle(reply.bundle, formOf(form));
  valid(same(bundle.dossier, packet.dossier.manifest.ref), 'The D7 bundle must name the exact dossier manifest');
  // A1: the grounds of a full projection are claims of exactly this proven dossier, quoted verbatim.
  if (bundle.contract === V9_FINAL_CONTRACT && bundle.projection)
    checkFinalProjectionGrounds(bundle.projection as never, bundle.verdict.conditions as never, packet.dossier as never);
  const result: DiscoveryFinalResult = { contract: DISCOVERY_FINAL_RESULT,
    subject: structuredClone(packet.subject), bundle: structuredClone(bundle) };
  return { contract: DISCOVERY_FINAL_RESULT_PROJECTION, packet: structuredClone(packet), result };
}

/** Prepare a read-only transport from the common exact paid-D6 subject reader.
 * The limit comes from the caller's admission; it is not a physical wire claim. */
export async function prepareDiscoveryFinalResultTransport(store: Store, project: string,
  subject: unknown, envelopeLimitChars: number,
  options?: { archive: 'staged'; materialContract?: FinalMaterialContract }, form: FinalBundleContract = V7_FINAL_CONTRACT): Promise<DiscoveryFinalResultTransport> {
  const version = formOf(form);
  const packet = await requireDiscoveryFinalSubject(store, project, subject);
  const schema = declaration(packet, version);
  valid(options === undefined || (keys(options, ['archive']) || keys(options, ['archive','materialContract'])) && options.archive === 'staged',
    'The final result archive option has an unknown form');
  const input = admission(packet, schema, envelopeLimitChars);
  if (options) {
    const original = input.mandatoryEnvelope;
    const era = finalMaterialEra(options);
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope, era);
    if (era) input.mandatoryEnvelope = finalMaterialAdmission(input.mandatoryEnvelope);
    // `subject` is reserved by the common physical builder for a V7PlanSubject.
    // A D7 subject is a different contract, so retain its complete value under
    // its own name rather than masquerading as an admitted plan question.
    const bindings = { projectId: packet.subject.projectId, finalSubject: packet.subject };
    const capacity = buildResearchResultCapacity({ ...input, bindings, mandatoryArchive: prepared.address });
    return { contract: DISCOVERY_FINAL_RESULT, subject: structuredClone(packet.subject), packet, schema, capacity,
      archive: { ref: prepared.staged.archive, projection: structuredClone(original),
        writes: prepared.staged.writes, guards: prepared.staged.guards } };
  }
  const capacity = buildResearchResultCapacity(input);
  return { contract: DISCOVERY_FINAL_RESULT, subject: structuredClone(packet.subject), packet, schema, capacity };
}

/** Re-prove a saved final admission without trusting a caller-supplied archive
 * resolver or a structurally plausible D6 packet. The same paid D6 reader,
 * declaration and capacity builder used by the producer own this proof. */
export async function requireDiscoveryFinalResultCapacity(store: Store, project: string,
  subject: unknown, limit: number, saved: unknown, form: FinalBundleContract = V7_FINAL_CONTRACT): Promise<DiscoveryFinalResultTransport> {
  let subjectSnapshot: unknown, capacitySnapshot: unknown;
  try { subjectSnapshot = JSON.parse(canonical(subject)); }
  catch { throw new EngineError('discovery_final_subject_invalid', 'The final subject must be a stable data value'); }
  try { capacitySnapshot = JSON.parse(canonical(saved)); }
  catch { throw new EngineError('research_capacity_invalid', 'The result admission must be a stable data value'); }
  const proven = await prepareDiscoveryFinalResultTransport(store, project, subjectSnapshot, limit, { archive: 'staged', ...(typeof capacitySnapshot === 'object' && capacitySnapshot !== null
    && (capacitySnapshot as any).mandatory?.archive?.pointer === '/body/admission' ? {materialContract:'discovery-final-material/v1' as const} : {}) }, form);
  valid(proven.archive && 'archive' in proven.capacity.mandatory,
    'The final result admission lost its exact archive');
  const address = proven.capacity.mandatory.archive;
  const input = admission(proven.packet, proven.schema, limit);
  if (address.pointer === '/body/admission') input.mandatoryEnvelope = finalMaterialAdmission(input.mandatoryEnvelope);
  const projection = savedArchiveProjection(store, address, input.mandatoryEnvelope);
  const bindings = { projectId: proven.subject.projectId, finalSubject: proven.subject };
  requireResearchResultCapacity(capacitySnapshot, { ...input, bindings, mandatoryArchive: address }, (record, pointer) => {
    valid(same(record, address.record) && pointer === address.pointer,
      'The result admission resolved another archive');
    return projection;
  });
  return proven;
}

/** Re-prove the entire supplied packet once, rederive its exact admission using
 * the caller's independently known limit, then measure the complete serialized
 * reply. No session or model call is created. */
export async function checkDiscoveryFinalResearchReply(store: Store, project: string,
  packetInput: unknown, envelopeLimitChars: number, saved: unknown, reply: unknown,
  form: FinalBundleContract = V7_FINAL_CONTRACT) {
  const version = formOf(form);
  let packetSnapshot: unknown;
  try { packetSnapshot = JSON.parse(canonical(packetInput)); }
  catch { throw new EngineError('discovery_final_subject_invalid', 'The final packet must be a stable data value'); }
  // Capacity is caller input at this public door. Snapshot it once so that
  // the checked declaration and the later measurement cannot observe
  // different values from an accessor or other mutable object.
  let capacity: unknown;
  try { capacity = JSON.parse(canonical(saved)); }
  catch { throw new EngineError('research_capacity_invalid', 'The result admission must be a stable data value'); }
  // Preserve the projector's plain-object requirement, then capture all
  // nested JSON values once without normalizing a foreign prototype.
  valid(object(reply), 'The final reply must be a plain object');
  let replySnapshot: unknown;
  try { replySnapshot = JSON.parse(canonical(reply)); }
  catch { throw new EngineError('discovery_final_result_invalid', 'The final reply must be a stable data value'); }
  const packet = await requireDiscoveryFinalPacket(store, project, packetSnapshot);
  const schema = declaration(packet, version);
  const input = admission(packet, schema, envelopeLimitChars);
  const mandatory = object(capacity) && object(capacity.mandatory) ? capacity.mandatory : null;
  if (mandatory && Object.hasOwn(mandatory, 'archive')) {
    const era = mandatory.archive?.pointer === '/body/admission';
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope, era);
    if (era) input.mandatoryEnvelope = finalMaterialAdmission(input.mandatoryEnvelope);
    valid(same(mandatory.archive, prepared.address), 'The result capacity names another archive or pointer');
    const projection = savedArchiveProjection(store, prepared.address, input.mandatoryEnvelope);
    const bindings = { projectId: packet.subject.projectId, finalSubject: packet.subject };
    requireResearchResultCapacity(capacity, { ...input, bindings, mandatoryArchive: prepared.address },
      (record, pointer) => {
        valid(same(record, prepared.address.record) && pointer === prepared.address.pointer,
          'The result capacity resolved another archive');
        return projection;
      });
  } else requireResearchResultCapacity(capacity, input);
  const projection = projectDiscoveryFinal(packet, replySnapshot, version);
  const measurement = measureResearchResult(capacity as ResearchResultCapacity, FORM, projection.result);
  if (!measurement.fits) throw new EngineError(RESULT_CAPACITY_REFUSAL,
    'The complete final reply exceeds its admitted serialized envelope', measurement);
  return { kind: FORM, terminal: true, normalized: projection.result, measurement, projection };
}

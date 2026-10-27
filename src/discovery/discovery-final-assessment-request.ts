import { canonical, hashJson, HASH_PATTERN } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Store, TransactionGuard, Write } from '../storage/store.js';
import { requireDiscoveryFinalAssessmentSubject,
  type DiscoveryFinalAssessmentPacket, type DiscoveryFinalAssessmentSubject } from './discovery-final-assessment-subject.js';
import { DISCOVERY_FINAL_ASSESSMENT_RESULT, projectDiscoveryFinalAssessment, reviewedConditionClasses,
  type DiscoveryFinalAssessmentProjection, type DiscoveryFinalAssessmentResult } from './discovery-final-assessment-result.js';
import { buildResearchResultCapacity, requireResearchResultCapacity, measureResearchResult,
  type ResearchResultCapacity, type ResearchResultCapacityInput } from './research-delivery.js';
import { RESULT_CAPACITY_REFUSAL } from './early-research-outcome.js';
import { prepareArchiveParts, readArchiveBody } from './request-parts.js';

/** DR7 7a.3 (codex-omg2 №15531): the complete request to the D7 assessor and the check of its terminal reply.
 * The request is derived only from the exact prepared assessment subject, proven again through the accepted
 * reader: the whole candidate, the verbatim assignment, the whole paid D6 with its material, contradictions,
 * unknowns and partial reasons, and the closed answer schema of the accepted RESULT. Supported of a negative D7
 * is lawful; the code does not judge meaning. A prepared request is not a paid or accepted assessment. */
const FORM = 'discovery_final_assessment';

export interface DiscoveryFinalAssessmentTransport {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_RESULT;
  subject: DiscoveryFinalAssessmentSubject;
  packet: DiscoveryFinalAssessmentPacket;
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
  requireCondition(condition, 'discovery_final_assessment_request_invalid', message);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const text = { type: 'string', minLength: 1 };
const closed = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const exactRef = closed({ id: text, revision: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: HASH_PATTERN } });
/** The address forms of the accepted RESULT; which places exist is the decoder's check over the proven packet. */
const address = { oneOf: [closed({ candidate: { type: 'string' } }), closed({ record: exactRef }), closed({ claim: { type: 'object' } }),
  closed({ unknown: { type: 'object' } }), closed({ contradiction: text }), closed({ partialReason: { type: 'integer', minimum: 0 } }),
  closed({ axis: text })] };
const addresses = { type: 'array', minItems: 1, uniqueItems: true, items: address };

/** The closed answer schema over the exact subject. Each declaration owns its immutable copy. A classed candidate's
 * answer also reviews the class of every owner condition, in its order (7b.3-class); an unclassed one has no review. */
function declaration(packet: DiscoveryFinalAssessmentPacket): Record<string, unknown> {
  const reviewed = reviewedConditionClasses(packet.candidate);
  const classes = reviewed ? { classes: { type: 'array', minItems: reviewed.length, maxItems: reviewed.length,
    description: 'Для каждого owner_choice кандидата по порядку: подтверди класс (confirmed) или отклони (rejected). choice подтверждается, только если ни один вариант не меняет границы, конституцию или проекцию комплекта и не принимает новый риск; иначе отклони. Отклонённый класс — это return.',
    items: closed({ conditionId: text, class: { enum: ['choice', 'boundary', 'risk'] }, judgement: { enum: ['confirmed', 'rejected'] },
      reason: text, bases: structuredClone(addresses) }) } } : {};
  return deepFreeze(closed({ contract: { const: DISCOVERY_FINAL_ASSESSMENT_RESULT }, subject: { const: structuredClone(packet.subject) },
    verdict: { enum: ['supported', 'return'] }, reasons: { type: 'array', minItems: 1, uniqueItems: true, items: text },
    bases: structuredClone(addresses),
    return: { oneOf: [{ type: 'null' }, closed({ targets: structuredClone(addresses), reason: text, bases: structuredClone(addresses) })] },
    ...classes }));
}
/** `subject` of the common physical builder is reserved for a V7PlanSubject; the assessment subject keeps its own name. */
function admission(packet: DiscoveryFinalAssessmentPacket, schema: Record<string, unknown>, limit: number): ResearchResultCapacityInput {
  return { operation: packet.subject.identity, generation: 0,
    bindings: { projectId: packet.subject.projectId, finalAssessmentSubject: packet.subject },
    role: 'assessor', purpose: 'discovery-final-assessment', actionMode: 'final-assessment-preflight',
    envelopeLimitChars: limit,
    mandatoryEnvelope: { contract: DISCOVERY_FINAL_ASSESSMENT_RESULT, subject: packet.subject, packet, schema },
    forms: [{ kind: FORM }] };
}

/** The shared archive producer derives its address solely from the freshly proven packet and its declaration. */
function archiveFor(store: Store, packet: DiscoveryFinalAssessmentPacket, minimum: Record<string, unknown>) {
  const staged = prepareArchiveParts(store, { projectId: packet.subject.projectId,
    draft: packet.final.subject.basis.draft, question: packet.final.subject.basis.brief.question }, { request: minimum });
  valid(staged.archive.revision === 1, 'The final assessment archive must be immutable');
  return { staged, address: { record: staged.archive, pointer: '/body/request', hash: hashJson(minimum as never) } };
}
function savedArchiveProjection(store: Store, address: { record: Ref; pointer: string; hash: string },
  minimum: Record<string, unknown>): Record<string, unknown> {
  const row = store.get(address.record.id, address.record.revision);
  valid(row?.kind === 'research-context' && row.revision === 1
    && same(reference(row), address.record) && hashJson(row.value as never) === address.record.hash,
  'The exact final assessment archive is missing or changed');
  const body = readArchiveBody(store, row).body;
  valid(address.pointer === '/body/request' && same(body.request, minimum) && hashJson(body.request as never) === address.hash,
    'The saved final assessment request differs from the proven packet and schema');
  return body.request;
}

/** A read-only transport from the exact subject, proven again; the limit is the caller's result admission. */
export async function prepareDiscoveryFinalAssessmentTransport(store: Store, project: string, subject: unknown,
  envelopeLimitChars: number, options?: { archive: 'staged' }): Promise<DiscoveryFinalAssessmentTransport> {
  const packet = await requireDiscoveryFinalAssessmentSubject(store, project, subject);
  valid(options === undefined || keys(options, ['archive']) && options.archive === 'staged',
    'The final assessment archive option has an unknown form');
  const schema = declaration(packet), input = admission(packet, schema, envelopeLimitChars);
  if (options) {
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope);
    const capacity = buildResearchResultCapacity({ ...input, mandatoryArchive: prepared.address });
    return { contract: DISCOVERY_FINAL_ASSESSMENT_RESULT, subject: structuredClone(packet.subject), packet, schema, capacity,
      archive: { ref: prepared.staged.archive, projection: structuredClone(input.mandatoryEnvelope),
        writes: prepared.staged.writes, guards: prepared.staged.guards } };
  }
  return { contract: DISCOVERY_FINAL_ASSESSMENT_RESULT, subject: structuredClone(packet.subject), packet, schema,
    capacity: buildResearchResultCapacity(input) };
}

/** Re-prove the whole packet once from the saved grounds, rederive its admission with the caller's independently
 * known limit (an archived admission is read back from the exact saved archive, never from a caller resolver),
 * decode and project the reply through the accepted RESULT, then measure the complete serialized answer. */
export async function checkDiscoveryFinalAssessmentReply(store: Store, project: string, subject: unknown,
  envelopeLimitChars: number, saved: unknown, reply: unknown): Promise<{ kind: typeof FORM; terminal: true;
    normalized: DiscoveryFinalAssessmentResult; measurement: ReturnType<typeof measureResearchResult>;
    projection: DiscoveryFinalAssessmentProjection }> {
  const packet = await requireDiscoveryFinalAssessmentSubject(store, project, subject);
  const input = admission(packet, declaration(packet), envelopeLimitChars);
  // FINAL-ASSESSMENT-PACK-01: one plain snapshot of the presented capacity serves the check, the archive read and the
  // measurement alike — an accessor answering one limit to the check and another to the measurement is never read again.
  let capacity: unknown;
  try { capacity = JSON.parse(canonical(saved)); } catch { valid(false, 'The result capacity is not a plain JSON value'); }
  const mandatory = object(capacity) && object(capacity.mandatory) ? capacity.mandatory : null;
  if (mandatory && Object.hasOwn(mandatory, 'archive')) {
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope);
    valid(same(mandatory.archive, prepared.address), 'The result capacity names another archive or pointer');
    const projection = savedArchiveProjection(store, prepared.address, input.mandatoryEnvelope);
    requireResearchResultCapacity(capacity, { ...input, mandatoryArchive: prepared.address }, (record, pointer) => {
      valid(same(record, prepared.address.record) && pointer === prepared.address.pointer,
        'The result capacity resolved another archive');
      return projection;
    });
  } else requireResearchResultCapacity(capacity, input);
  const projection = projectDiscoveryFinalAssessment({ packet, result: reply });
  const measurement = measureResearchResult(capacity, FORM, projection.result);
  if (!measurement.fits) throw new EngineError(RESULT_CAPACITY_REFUSAL,
    'The complete final assessment reply exceeds its admitted serialized envelope', measurement);
  return { kind: FORM, terminal: true, normalized: structuredClone(projection.result), measurement, projection };
}

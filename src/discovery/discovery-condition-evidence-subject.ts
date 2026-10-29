import { finalMaterialAdmission, finalMaterialArchive, finalMaterialEra, finalMaterialPointer, type FinalMaterialContract } from './final-material.js';
import { canonical, hashJson, HASH_PATTERN, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store, TransactionGuard, Write } from '../storage/store.js';
import { proveClaimAddress, type ClaimAddress } from './claim-address.js';
import { readDiscoveryManifestStructural } from './discovery-manifest.js';
import type { DiscoveryFinalSubject } from './discovery-final.js';
import { checkFinalBundle, type V7FinalBundle } from './v7-final-contracts.js';
import { buildResearchResultCapacity, requireResearchResultCapacity, measureResearchResult,
  type ResearchResultCapacity, type ResearchResultCapacityInput } from './research-delivery.js';
import { RESULT_CAPACITY_REFUSAL } from './early-research-outcome.js';
import { prepareArchiveParts, readArchiveBody } from './request-parts.js';

/** OMG-V7-B3 (codex-omg2 №16508, ndisc.d7.n4, 7b.3e): the subject of the independent paid assessment of whether
 * material fulfils one evidence condition of an accepted bundle. It binds the exact accepted edition of the manifest,
 * its saved whole bundle, the evidence condition with its verbatim criterion, and the accepted claims of this project
 * offered as material — each with its full content. That a claim is accepted proves nothing about the criterion; the
 * assessor decides that on the whole subject. The subject is read-only: nothing here pays, resolves or publishes.
 *
 * The subject is proven without the reader of accepted Discovery (no import cycle with discovery-acceptance.ts): the
 * structural manifest, the exact saved bundle and its paid D7, the condition and the proven claims. Whether the edition
 * is accepted is proven by the callers — the preparation door and the reader of the edition a resolution publishes. */
export const CONDITION_EVIDENCE_SUBJECT = 'discovery-condition-evidence-subject/v1' as const;
export const CONDITION_EVIDENCE_PACKET = 'discovery-condition-evidence-packet/v1' as const;
export const CONDITION_EVIDENCE_RESULT = 'discovery-condition-evidence-result/v1' as const;
export const CONDITION_EVIDENCE_PROJECTION = 'discovery-condition-evidence-projection/v1' as const;
export const CONDITION_EVIDENCE_PURPOSE = 'discovery-condition-evidence' as const;
const FORM = 'discovery_condition_evidence';

export interface ConditionEvidenceCondition { id: string; kind: 'evidence'; condition: string; criterion: string }
export interface ConditionEvidenceSubject {
  contract: typeof CONDITION_EVIDENCE_SUBJECT; kind: 'condition-evidence'; identity: string; projectId: string;
  manifest: Ref; bundle: Ref; condition: ConditionEvidenceCondition; claims: ClaimAddress[]; final: DiscoveryFinalSubject;
}
/** The material: every offered claim with its full content and the exact container it was proven accepted in. */
export interface ConditionEvidenceMaterial { address: ClaimAddress; claim: Json; container: Ref }
export interface ConditionEvidencePacket {
  contract: typeof CONDITION_EVIDENCE_PACKET; subject: ConditionEvidenceSubject; bundle: V7FinalBundle;
  material: ConditionEvidenceMaterial[];
}
export type ConditionEvidenceBasis = { claim: ClaimAddress } | { criterion: true };
export interface ConditionEvidenceResult {
  contract: typeof CONDITION_EVIDENCE_RESULT; subject: ConditionEvidenceSubject; verdict: 'supported' | 'return';
  reasons: string[]; bases: ConditionEvidenceBasis[]; return: null | { reason: string; needed: string[] };
}
export interface ConditionEvidenceProjection {
  contract: typeof CONDITION_EVIDENCE_PROJECTION; identity: string; subject: ConditionEvidenceSubject;
  verdict: ConditionEvidenceResult['verdict']; packet: ConditionEvidencePacket; result: ConditionEvidenceResult;
}
export interface ConditionEvidenceTransport {
  contract: typeof CONDITION_EVIDENCE_RESULT; subject: ConditionEvidenceSubject; packet: ConditionEvidencePacket;
  schema: Record<string, unknown>; capacity: ResearchResultCapacity;
  archive?: { ref: Ref; projection: Record<string, unknown>; writes: Write[]; guards: TransactionGuard[] };
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown) => canonical(left as never) === canonical(right as never);
const keys = (value: unknown, names: readonly string[]): value is Record<string, any> => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
const exactRef = (value: unknown): value is Ref => isRef(value) && keys(value, ['id', 'revision', 'hash']);
function invalid(field: string, message: string, code = 'discovery_condition_evidence_invalid'): never {
  throw new EngineError(code, `[${field}] ${message}`, { field });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(value: unknown, field: string): unknown {
  try { return JSON.parse(canonical(value as never)); }
  catch { return invalid(field, 'Expected a plain JSON value'); }
}
function exactRow<T>(store: Store, ref: unknown, kind: string, field: string): Revision<T> {
  if (!exactRef(ref)) invalid(field, 'Expected an exact reference');
  const row = store.get<T>(ref.id, ref.revision);
  if (!row || row.kind !== kind || !same(reference(row), ref) || row.hash !== hashJson(row.value as never) || !object(row.value))
    invalid(field, `The exact ${field} record is missing, foreign or changed`);
  return row;
}
const identity = (basis: Omit<ConditionEvidenceSubject, 'identity'>) => `discovery-condition-evidence:${hashJson(basis as unknown as Json)}`;

/** The input of a subject: the exact edition, the evidence condition of its bundle and the offered accepted claims. */
export interface ConditionEvidenceInput { manifest: Ref; conditionId: string; claims: ClaimAddress[] }
function decodeInput(value: unknown): ConditionEvidenceInput {
  const input = snapshot(value, 'input');
  if (!keys(input, ['manifest', 'conditionId', 'claims']) || !exactRef(input.manifest) || typeof input.conditionId !== 'string'
    || !input.conditionId.trim() || !Array.isArray(input.claims) || input.claims.length === 0)
    invalid('input', 'An evidence subject names the exact edition, the condition and at least one accepted claim');
  if (new Set(input.claims.map((claim: unknown) => canonical(claim as never))).size !== input.claims.length)
    invalid('claims', 'Each claim is offered once');
  return input as ConditionEvidenceInput;
}

/** Prove the whole subject from its input: the structural edition of this project, its exact saved bundle and paid D7,
 * the evidence condition with its criterion, and every offered claim proven accepted in this project. */
export function prepareConditionEvidenceSubject(store: Store, project: string, rawInput: unknown): ConditionEvidencePacket {
  if (typeof project !== 'string' || !project) invalid('projectId', 'An evidence subject needs its project');
  const input = decodeInput(rawInput);
  const manifest = readDiscoveryManifestStructural(store, project, input.manifest).record;
  const saved = exactRow<{ contract: string; projectId: string; paid: Ref; bundle: unknown }>(store, manifest.value.bundle,
    'discovery-final-bundle', 'bundle');
  if (saved.value.projectId !== project || !exactRef(saved.value.paid)) invalid('bundle', 'The saved bundle belongs to another project');
  const bundle = checkFinalBundle(saved.value.bundle);
  const paid = exactRow<{ projectId: string; subject: DiscoveryFinalSubject; projection: { result: { bundle: unknown } } }>(store,
    saved.value.paid, 'discovery-final-paid-result', 'paid');
  if (paid.value.projectId !== project || !same(paid.value.projection?.result?.bundle, bundle) || !object(paid.value.subject))
    invalid('paid', 'The saved bundle is not the paid D7 result it names');
  const condition = (bundle.verdict.conditions as unknown[]).find(item => object(item) && item.id === input.conditionId) as Record<string, unknown> | undefined;
  if (!condition) invalid('conditionId', 'The condition is not one of this accepted bundle');
  if (condition.kind !== 'evidence')
    invalid('conditionId', 'Only an evidence condition is fulfilled by material; an owner condition is the owner\'s choice');
  const material = input.claims.map((address, index) => {
    if (!object(address) || address.project !== project) invalid(`claims.${index}`, 'A claim address names a claim of this project');
    const proven = proveClaimAddress(store, address);
    return { address: structuredClone(address), claim: structuredClone(proven.claim), container: reference(proven.container) };
  });
  const base: Omit<ConditionEvidenceSubject, 'identity'> = { contract: CONDITION_EVIDENCE_SUBJECT, kind: 'condition-evidence',
    projectId: project, manifest: reference(manifest), bundle: reference(saved),
    condition: { id: condition.id as string, kind: 'evidence', condition: condition.condition as string, criterion: condition.criterion as string },
    claims: structuredClone(input.claims), final: structuredClone(paid.value.subject) };
  const subject: ConditionEvidenceSubject = { ...base, identity: identity(base) };
  return structuredClone({ contract: CONDITION_EVIDENCE_PACKET, subject, bundle, material });
}
/** Re-prove the whole presented subject from its own input; a recomputed identity never replaces that proof. */
export function requireConditionEvidenceSubject(store: Store, project: string, subject: unknown): ConditionEvidencePacket {
  const presented = snapshot(subject, 'subject');
  if (!keys(presented, ['contract', 'kind', 'identity', 'projectId', 'manifest', 'bundle', 'condition', 'claims', 'final'])
    || presented.contract !== CONDITION_EVIDENCE_SUBJECT || presented.kind !== 'condition-evidence' || presented.projectId !== project
    || !object(presented.condition))
    invalid('subject', 'Only a complete condition evidence subject of this project is read here');
  const packet = prepareConditionEvidenceSubject(store, project,
    { manifest: presented.manifest, conditionId: presented.condition.id, claims: presented.claims });
  if (!same(packet.subject, presented)) invalid('subject', 'The evidence subject differs from its proven saved input', 'discovery_condition_evidence_mismatch');
  return packet;
}

const text = { type: 'string', minLength: 1 };
const closed = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const exactRefSchema = closed({ id: text, revision: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: HASH_PATTERN } });
const claimSchema = closed({ project: text, container: exactRefSchema, containerKind: text, pointer: text, claimId: text });
/** The closed answer schema over the exact subject. Each declaration owns its immutable copy. */
function declaration(packet: ConditionEvidencePacket): Record<string, unknown> {
  return deepFreeze(closed({ contract: { const: CONDITION_EVIDENCE_RESULT }, subject: { const: structuredClone(packet.subject) },
    verdict: { enum: ['supported', 'return'],
      description: 'supported — материал удовлетворяет критерию условия дословно и полностью; return — не удовлетворяет или недостаточен. Принятость утверждения сама по себе критерий не доказывает.' },
    reasons: { type: 'array', minItems: 1, uniqueItems: true, items: text },
    bases: { type: 'array', minItems: 1, uniqueItems: true, items: { oneOf: [closed({ claim: claimSchema }), closed({ criterion: { const: true } })] } },
    return: { oneOf: [{ type: 'null' }, closed({ reason: text, needed: { type: 'array', minItems: 1, items: text } })] } }));
}
function admission(packet: ConditionEvidencePacket, schema: Record<string, unknown>, limit: number): ResearchResultCapacityInput {
  return { operation: packet.subject.identity, generation: 0,
    bindings: { projectId: packet.subject.projectId, conditionEvidenceSubject: packet.subject },
    role: 'assessor', purpose: CONDITION_EVIDENCE_PURPOSE, actionMode: 'condition-evidence-preflight',
    envelopeLimitChars: limit, mandatoryEnvelope: { contract: CONDITION_EVIDENCE_RESULT, subject: packet.subject, packet, schema },
    forms: [{ kind: FORM }] };
}
function archiveFor(store: Store, packet: ConditionEvidencePacket, minimum: Record<string, unknown>, era = false) {
  const staged = prepareArchiveParts(store, { projectId: packet.subject.projectId, draft: packet.subject.final.basis.draft,
    question: packet.subject.final.basis.brief.question }, finalMaterialArchive(minimum, era));
  requireCondition(staged.archive.revision === 1, 'discovery_condition_evidence_invalid', 'The evidence archive must be immutable');
  return { staged, address: { record: staged.archive, pointer: finalMaterialPointer(era), hash: hashJson((era ? finalMaterialAdmission(minimum) : minimum) as never) } };
}
function savedArchiveProjection(store: Store, address: { record: Ref; pointer: string; hash: string }, minimum: Record<string, unknown>) {
  const row = store.get(address.record.id, address.record.revision);
  if (row?.kind !== 'research-context' || row.revision !== 1 || !same(reference(row), address.record) || hashJson(row.value as never) !== address.record.hash)
    invalid('archive', 'The exact evidence archive is missing or changed');
  const body = readArchiveBody(store, row!).body;
  const projection = address.pointer === '/body/admission' ? body.admission : body.request;
  if (!same(projection, minimum) || hashJson(projection as never) !== address.hash)
    invalid('archive', 'The saved evidence request differs from the proven packet and schema');
  return projection as Record<string, unknown>;
}

/** The closed decoder of the assessor's answer against the exact proven packet. */
export function decodeConditionEvidenceResult(value: unknown, packet: ConditionEvidencePacket): ConditionEvidenceResult {
  const input = snapshot(value, 'result') as Record<string, any>;
  if (!keys(input, ['contract', 'subject', 'verdict', 'reasons', 'bases', 'return']) || input.contract !== CONDITION_EVIDENCE_RESULT)
    invalid('result', `Only ${CONDITION_EVIDENCE_RESULT} is a known evidence answer`, 'discovery_condition_evidence_result_invalid');
  if (!same(input.subject, packet.subject)) invalid('subject', 'The answer names another evidence subject', 'discovery_condition_evidence_mismatch');
  if (input.verdict !== 'supported' && input.verdict !== 'return') invalid('verdict', 'The assessor answers supported or return', 'discovery_condition_evidence_result_invalid');
  const texts = (list: unknown, at: string) => {
    if (!Array.isArray(list) || list.length === 0 || !list.every(item => typeof item === 'string' && item.trim()))
      invalid(at, 'A nonempty list of reasons is required', 'discovery_condition_evidence_result_invalid');
  };
  texts(input.reasons, 'reasons');
  const offered = new Set(packet.subject.claims.map(claim => canonical(claim as never)));
  if (!Array.isArray(input.bases) || input.bases.length === 0) invalid('bases', 'The answer names its bases', 'discovery_condition_evidence_result_invalid');
  input.bases.forEach((basis: unknown, index: number) => {
    const ok = keys(basis, ['claim']) && offered.has(canonical((basis as any).claim)) || keys(basis, ['criterion']) && (basis as any).criterion === true;
    if (!ok) invalid(`bases.${index}`, 'A basis is an offered claim of this subject or its criterion', 'discovery_condition_evidence_result_invalid');
  });
  if (input.verdict === 'supported') {
    if (input.return !== null) invalid('return', 'A supported answer has no return', 'discovery_condition_evidence_result_invalid');
    if (!input.bases.some((basis: any) => Object.hasOwn(basis, 'claim')))
      invalid('bases', 'A supported answer names the material that fulfils the criterion', 'discovery_condition_evidence_result_invalid');
  } else {
    if (!keys(input.return, ['reason', 'needed']) || typeof input.return.reason !== 'string' || !input.return.reason.trim())
      invalid('return', 'A return explains what is missing', 'discovery_condition_evidence_result_invalid');
    texts(input.return.needed, 'return.needed');
  }
  return input as ConditionEvidenceResult;
}
export function projectConditionEvidence(input: { packet: ConditionEvidencePacket; result: unknown }): ConditionEvidenceProjection {
  const result = decodeConditionEvidenceResult(input.result, input.packet);
  const value = { contract: CONDITION_EVIDENCE_PROJECTION, subject: input.packet.subject, verdict: result.verdict, packet: input.packet, result };
  return structuredClone({ ...value, identity: `discovery-condition-evidence-projection:${hashJson(value as unknown as Json)}` });
}

/** A read-only transport from the exact subject, proven again; the limit is the caller's result admission. */
export function prepareConditionEvidenceTransport(store: Store, project: string, subject: unknown, envelopeLimitChars: number,
  options?: { archive: 'staged'; materialContract?: FinalMaterialContract }): ConditionEvidenceTransport {
  const packet = requireConditionEvidenceSubject(store, project, subject);
  const schema = declaration(packet), input = admission(packet, schema, envelopeLimitChars);
  if (options) {
    const original = input.mandatoryEnvelope;
    const era = finalMaterialEra(options);
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope, era);
    if (era) input.mandatoryEnvelope = finalMaterialAdmission(input.mandatoryEnvelope);
    const capacity = buildResearchResultCapacity({ ...input, mandatoryArchive: prepared.address });
    return { contract: CONDITION_EVIDENCE_RESULT, subject: structuredClone(packet.subject), packet, schema, capacity,
      archive: { ref: prepared.staged.archive, projection: structuredClone(original),
        writes: prepared.staged.writes, guards: prepared.staged.guards } };
  }
  return { contract: CONDITION_EVIDENCE_RESULT, subject: structuredClone(packet.subject), packet, schema, capacity: buildResearchResultCapacity(input) };
}
/** Re-prove the whole packet, rederive its admission with the caller's limit, decode and project the reply and measure it. */
export function checkConditionEvidenceReply(store: Store, project: string, subject: unknown, envelopeLimitChars: number,
  saved: unknown, reply: unknown) {
  const packet = requireConditionEvidenceSubject(store, project, subject);
  const input = admission(packet, declaration(packet), envelopeLimitChars);
  const capacity = snapshot(saved, 'capacity') as Record<string, any>;
  const mandatory = object(capacity) && object(capacity.mandatory) ? capacity.mandatory : null;
  if (mandatory && Object.hasOwn(mandatory, 'archive')) {
    const era = mandatory.archive?.pointer === '/body/admission';
    const prepared = archiveFor(store, packet, input.mandatoryEnvelope, era);
    if (era) input.mandatoryEnvelope = finalMaterialAdmission(input.mandatoryEnvelope);
    if (!same(mandatory.archive, prepared.address)) invalid('capacity', 'The result capacity names another archive or pointer');
    const projection = savedArchiveProjection(store, prepared.address, input.mandatoryEnvelope);
    requireResearchResultCapacity(capacity, { ...input, mandatoryArchive: prepared.address }, (record, pointer) => {
      if (!same(record, prepared.address.record) || pointer !== prepared.address.pointer) invalid('capacity', 'The result capacity resolved another archive');
      return projection;
    });
  } else requireResearchResultCapacity(capacity, input);
  const projection = projectConditionEvidence({ packet, result: reply });
  const measurement = measureResearchResult(capacity as ResearchResultCapacity, FORM, projection.result);
  if (!measurement.fits) throw new EngineError(RESULT_CAPACITY_REFUSAL, 'The complete evidence reply exceeds its admitted serialized envelope', measurement);
  return { kind: FORM, terminal: true as const, normalized: structuredClone(projection.result), measurement, projection };
}

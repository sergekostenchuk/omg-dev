import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision } from '../storage/store.js';

/** DR4-M describes structures, never paid lineage, accepted claims, authority or sweep readiness.
 * T/B/O/P supply those proofs. A structural result is deliberately not a ProvenVariant. */
export const VARIANT_SUBJECT_CONTRACT = 'discovery-variant-subject/v1' as const;
export const VARIANT_SNAPSHOT_CONTRACT = 'discovery-variant-snapshot/v1' as const;
export const VARIANT_CONTRACT = 'discovery-variant/v1' as const;
export const VARIANT_SET_CONTRACT = 'discovery-variant-set/v1' as const;
export const VARIANT_NONE_CONTRACT = 'discovery-variant-none/v1' as const;
export const VARIANT_SCOPE_CONTRACT = 'discovery-variant-scope/v1' as const;
export const VARIANT_CRITERIA = ['value', 'user', 'payer', 'costAndTime', 'risk', 'mandateFit'] as const;
export type VariantCriterion = typeof VARIANT_CRITERIA[number];
export type VariantSubject = { contract: typeof VARIANT_SUBJECT_CONTRACT; mode: Ref; expectedSelection: Ref | null } &
  ({ kind: 'proposal'; snapshot: Ref } | { kind: 'decision'; set: Ref });
export interface VariantOrigin { intent: Ref; call: Ref; response: Ref }
export interface VariantReason { code: string; message: string; grounds: Ref[] }
export interface VariantSnapshot {
  contract: typeof VARIANT_SNAPSHOT_CONTRACT; projectId: string; draft: Ref; frame: Ref; plan: Ref;
  questions: { planQuestionId: string; question: Ref; blocking: boolean; progress: Ref | null;
    applications: Ref[]; reason: VariantReason | null }[];
}
export interface VariantJudgement {
  conclusion: string; grounds: Ref[]; assumptions: string[]; unknowns: string[];
  quantity: { unit: string; minimum: number; maximum: number; limitations: string; grounds: Ref[] } | null;
}
export type VariantScale = Record<VariantCriterion, string>;
export type VariantJudgements = Record<VariantCriterion, VariantJudgement>;
export interface DiscoveryVariant {
  contract: typeof VARIANT_CONTRACT; projectId: string; draft: Ref; snapshot: Ref; origin: VariantOrigin;
  key: string; title: string; proposal: Json; scale: VariantScale; criteria: VariantJudgements;
}
export interface VariantSet {
  contract: typeof VARIANT_SET_CONTRACT; projectId: string; draft: Ref; snapshot: Ref; origin: VariantOrigin;
  members: Ref[]; scale: VariantScale; comparison: string; recommendation: { member: Ref; reason: string };
  searchLimits: string[]; unknowns: string[];
}
export interface VariantNone {
  contract: typeof VARIANT_NONE_CONTRACT; projectId: string; draft: Ref; snapshot: Ref; origin: VariantOrigin;
  reasons: VariantReason[]; searchLimits: string[]; unknowns: string[];
}
/** 4T.3: the closed wire answer of a variant generation call (purpose variant-proposal). Local keys only: turning them
 * into immutable member Refs and publishing the set belong to 4B.1, never to the transport. */
export interface VariantGenerationMember { key: string; title: string; proposal: Json; criteria: VariantJudgements }
export type VariantGenerationAnswer = {
  action: 'variants'; variants: VariantGenerationMember[]; scale: VariantScale; comparison: string;
  recommendation: { key: string; reason: string }; searchLimits: string[]; unknowns: string[];
} | { action: 'no_variants'; reasons: VariantReason[]; searchLimits: string[]; unknowns: string[] };
export interface VariantRecordView { get<T = Json>(id: string, revision?: number): Revision<T> | null }
export interface StructuralVariantRecord<T> { verification: 'structural'; record: Revision<T> }

export function variantInvalid(field: string, message: string, code = 'discovery_variant_invalid', ref?: Ref): never {
  throw new EngineError(code, message, { field, ...(ref ? { ref } : {}) });
}
export function variantObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function variantShape(value: unknown, fields: readonly string[], at: string,
  code = 'discovery_variant_invalid'): asserts value is Record<string, unknown> {
  if (!variantObject(value) || Object.keys(value).length !== fields.length
    || !fields.every(key => Object.hasOwn(value, key))) variantInvalid(at, 'Expected the complete closed variant form', code);
}
export function variantText(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) variantInvalid(at, 'Expected nonempty text');
}
export function variantRef(value: unknown, at: string): asserts value is Ref {
  variantShape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) variantInvalid(at, 'Expected an exact reference');
}
export function variantNullableRef(value: unknown, at: string): asserts value is Ref | null {
  if (value !== null) variantRef(value, at);
}
export function variantRefs(value: unknown, at: string, minimum = 0): asserts value is Ref[] {
  if (!Array.isArray(value) || value.length < minimum) variantInvalid(at, 'Expected a reference list');
  for (let i = 0; i < value.length; i++) variantRef(value[i], `${at}.${i}`);
  if (new Set(value.map(ref => canonical(ref))).size !== value.length) variantInvalid(at, 'Duplicate exact references');
}
export function variantTexts(value: unknown, at: string, minimum = 0): asserts value is string[] {
  if (!Array.isArray(value) || value.length < minimum) variantInvalid(at, 'Expected a text list');
  for (let i = 0; i < value.length; i++) variantText(value[i], `${at}.${i}`);
}
export function variantSame(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
export function variantReason(value: unknown, at: string): asserts value is VariantReason {
  variantShape(value, ['code', 'message', 'grounds'], at);
  variantText(value.code, `${at}.code`); variantText(value.message, `${at}.message`);
  variantRefs(value.grounds, `${at}.grounds`, 1);
}
export function variantOrigin(value: unknown, at: string): asserts value is VariantOrigin {
  variantShape(value, ['intent', 'call', 'response'], at);
  for (const key of ['intent', 'call', 'response']) variantRef(value[key], `${at}.${key}`);
}
export function variantBasis(value: Record<string, unknown>, contract: string): void {
  if (value.contract !== contract) variantInvalid('contract', 'Unknown variant contract');
  variantText(value.projectId, 'projectId'); variantRef(value.draft, 'draft');
}
function scale(value: unknown, at: string): asserts value is VariantScale {
  variantShape(value, VARIANT_CRITERIA, at);
  for (const criterion of VARIANT_CRITERIA) variantText(value[criterion], `${at}.${criterion}`);
}
function json(value: unknown, at: string): void {
  try { canonical(value); }
  catch (error) {
    if (!(error instanceof EngineError) || error.code !== 'invalid_json') throw error;
    variantInvalid(at, 'Expected finite acyclic JSON data');
  }
}

export function decodeVariantSubject(value: unknown): VariantSubject {
  if (!variantObject(value) || (value.kind !== 'proposal' && value.kind !== 'decision'))
    variantInvalid('variantSubject.kind', 'Expected proposal or decision', 'discovery_variant_subject_invalid');
  const basis = value.kind === 'proposal' ? 'snapshot' : 'set';
  variantShape(value, ['contract', 'kind', basis, 'mode', 'expectedSelection'], 'variantSubject', 'discovery_variant_subject_invalid');
  if (value.contract !== VARIANT_SUBJECT_CONTRACT)
    variantInvalid('variantSubject.contract', 'Unknown variant subject contract', 'discovery_variant_subject_invalid');
  try {
    variantRef(value[basis], `variantSubject.${basis}`); variantRef(value.mode, 'variantSubject.mode');
    variantNullableRef(value.expectedSelection, 'variantSubject.expectedSelection');
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    throw new EngineError('discovery_variant_subject_invalid', error.message, error.details);
  }
  return structuredClone(value) as VariantSubject;
}
export const VARIANT_SESSION_CONTRACT = 'discovery-variant-session/v1' as const;
export const VARIANT_SESSION_KIND = 'discovery-variant-session' as const;
/** 4T.4 (codex-worker №11290): the minimal execution session that owns a variant intent, written by the common preparer
 * before the first intent. Cursor 0 with no result at the start; cursor 1 with the applied receipt of the single
 * generation or decision step of this exact identity. No ready or proven flag; members, set and state are not published
 * by it. The address of a session and its historical proof belong to its producer, not to this structural decoder. */
export interface VariantExecutionSession {
  contract: typeof VARIANT_SESSION_CONTRACT; projectId: string; draft: Ref; question: Ref; variantSubject: VariantSubject;
  purpose: 'variant-proposal' | 'variant-decision'; actor: string; cursor: 0 | 1; result: VariantOrigin | null;
}
export function decodeVariantExecutionSession(value: unknown): VariantExecutionSession {
  const code = 'discovery_variant_session_invalid';
  try {
    variantShape(value, ['contract', 'projectId', 'draft', 'question', 'variantSubject', 'purpose', 'actor', 'cursor', 'result'],
      'variantSession', code);
    if (value.contract !== VARIANT_SESSION_CONTRACT) variantInvalid('variantSession.contract', 'Unknown variant session contract', code);
    variantText(value.projectId, 'variantSession.projectId');
    variantRef(value.draft, 'variantSession.draft'); variantRef(value.question, 'variantSession.question');
    const subject = decodeVariantSubject(value.variantSubject);
    if (value.purpose !== `variant-${subject.kind}`) variantInvalid('variantSession.purpose', 'The purpose names the kind of its subject', code);
    variantText(value.actor, 'variantSession.actor');
    if (!(value.cursor === 0 && value.result === null || value.cursor === 1 && value.result !== null))
      variantInvalid('variantSession.cursor', 'Cursor 0 has no result; cursor 1 has the applied receipt of its step', code);
    if (value.result !== null) variantOrigin(value.result, 'variantSession.result');
  } catch (error) {
    if (!(error instanceof EngineError) || error.code === code) throw error;
    throw new EngineError(code, error.message, error.details);
  }
  return structuredClone(value) as unknown as VariantExecutionSession;
}

export function decodeVariantSnapshot(value: unknown): VariantSnapshot {
  variantShape(value, ['contract', 'projectId', 'draft', 'frame', 'plan', 'questions'], 'snapshot');
  variantBasis(value, VARIANT_SNAPSHOT_CONTRACT); variantRef(value.frame, 'frame'); variantRef(value.plan, 'plan');
  if (!Array.isArray(value.questions) || value.questions.length === 0) variantInvalid('questions', 'Expected the applicable plan questions');
  const ids = new Set<string>();
  Array.from(value.questions).forEach((entry: unknown, i: number) => {
    const at = `questions.${i}`;
    variantShape(entry, ['planQuestionId', 'question', 'blocking', 'progress', 'applications', 'reason'], at);
    variantText(entry.planQuestionId, `${at}.planQuestionId`);
    if (ids.has(entry.planQuestionId)) variantInvalid(`${at}.planQuestionId`, 'Duplicate plan-question');
    ids.add(entry.planQuestionId); variantRef(entry.question, `${at}.question`);
    if (typeof entry.blocking !== 'boolean') variantInvalid(`${at}.blocking`, 'Expected the explicit blocking flag');
    variantNullableRef(entry.progress, `${at}.progress`); variantRefs(entry.applications, `${at}.applications`);
    if (entry.reason !== null) variantReason(entry.reason, `${at}.reason`);
    if (entry.applications.length === 0 && entry.reason === null)
      variantInvalid(at, 'An uncovered question needs an addressed reason');
    if (entry.applications.length > 0 && entry.progress === null)
      variantInvalid(`${at}.progress`, 'Applications name their exact progress');
  });
  return structuredClone(value) as unknown as VariantSnapshot;
}
function judgements(value: unknown, at: string): asserts value is VariantJudgements {
  variantShape(value, VARIANT_CRITERIA, at);
  for (const criterion of VARIANT_CRITERIA) {
    const field = `${at}.${criterion}`, judgement = value[criterion];
    variantShape(judgement, ['conclusion', 'grounds', 'assumptions', 'unknowns', 'quantity'], field);
    variantText(judgement.conclusion, `${field}.conclusion`); variantRefs(judgement.grounds, `${field}.grounds`);
    variantTexts(judgement.assumptions, `${field}.assumptions`); variantTexts(judgement.unknowns, `${field}.unknowns`);
    if (!judgement.grounds.length && !judgement.assumptions.length && !judgement.unknowns.length)
      variantInvalid(field, 'A conclusion exposes grounds, assumptions or unknowns');
    if (judgement.quantity !== null) {
      const q = judgement.quantity;
      variantShape(q, ['unit', 'minimum', 'maximum', 'limitations', 'grounds'], `${field}.quantity`);
      variantText(q.unit, `${field}.quantity.unit`); variantText(q.limitations, `${field}.quantity.limitations`);
      if (typeof q.minimum !== 'number' || !Number.isFinite(q.minimum) || typeof q.maximum !== 'number'
        || !Number.isFinite(q.maximum) || q.minimum > q.maximum) variantInvalid(`${field}.quantity`, 'Expected a finite ordered range');
      variantRefs(q.grounds, `${field}.quantity.grounds`, 1);
    }
  }
}
export function decodeDiscoveryVariant(value: unknown): DiscoveryVariant {
  variantShape(value, ['contract', 'projectId', 'draft', 'snapshot', 'origin', 'key', 'title', 'proposal', 'scale', 'criteria'], 'variant');
  variantBasis(value, VARIANT_CONTRACT); variantRef(value.snapshot, 'snapshot'); variantOrigin(value.origin, 'origin');
  variantText(value.key, 'key'); variantText(value.title, 'title'); json(value.proposal, 'proposal'); scale(value.scale, 'scale');
  judgements(value.criteria, 'criteria');
  return structuredClone(value) as unknown as DiscoveryVariant;
}
/** 4T.3: the closed generation answer — one to three variants with unique local keys on one shared scale and a
 * recommendation naming an existing key; no_variants is a separate result with its reasons. */
export function decodeVariantGeneration(value: unknown): VariantGenerationAnswer {
  const code = 'discovery_variant_answer_invalid';
  try {
    if (!variantObject(value) || (value.action !== 'variants' && value.action !== 'no_variants'))
      variantInvalid('action', 'Expected variants or no_variants', code);
    if (value.action === 'no_variants') {
      variantShape(value, ['action', 'reasons', 'searchLimits', 'unknowns'], 'answer', code);
      if (!Array.isArray(value.reasons) || value.reasons.length === 0) variantInvalid('reasons', 'no_variants explains its result', code);
      Array.from(value.reasons).forEach((reason, i) => variantReason(reason, `reasons.${i}`));
    } else {
      variantShape(value, ['action', 'variants', 'scale', 'comparison', 'recommendation', 'searchLimits', 'unknowns'], 'answer', code);
      if (!Array.isArray(value.variants) || value.variants.length < 1 || value.variants.length > 3)
        variantInvalid('variants', 'A generation proposes one to three variants', code);
      const keys = new Set<string>();
      Array.from(value.variants).forEach((member: unknown, i: number) => {
        const at = `variants.${i}`;
        variantShape(member, ['key', 'title', 'proposal', 'criteria'], at, code);
        variantText(member.key, `${at}.key`); variantText(member.title, `${at}.title`);
        if (keys.has(member.key)) variantInvalid(`${at}.key`, 'Local variant keys are unique', code);
        keys.add(member.key); json(member.proposal, `${at}.proposal`); judgements(member.criteria, `${at}.criteria`);
      });
      scale(value.scale, 'scale'); variantText(value.comparison, 'comparison');
      variantShape(value.recommendation, ['key', 'reason'], 'recommendation', code);
      variantText(value.recommendation.key, 'recommendation.key'); variantText(value.recommendation.reason, 'recommendation.reason');
      if (!keys.has(value.recommendation.key)) variantInvalid('recommendation.key', 'The recommendation names an existing local key', code);
    }
    variantTexts(value.searchLimits, 'searchLimits', 1); variantTexts(value.unknowns, 'unknowns');
  } catch (error) {
    if (!(error instanceof EngineError) || error.code === code) throw error;
    throw new EngineError(code, error.message, error.details);
  }
  return structuredClone(value) as unknown as VariantGenerationAnswer;
}
export function decodeVariantSet(value: unknown): VariantSet {
  variantShape(value, ['contract', 'projectId', 'draft', 'snapshot', 'origin', 'members', 'scale', 'comparison', 'recommendation', 'searchLimits', 'unknowns'], 'set');
  variantBasis(value, VARIANT_SET_CONTRACT); variantRef(value.snapshot, 'snapshot'); variantOrigin(value.origin, 'origin');
  variantRefs(value.members, 'members', 1);
  if (value.members.length > 3 || new Set(value.members.map(ref => ref.id)).size !== value.members.length)
    variantInvalid('members', 'A set has one to three distinct immutable members');
  scale(value.scale, 'scale'); variantText(value.comparison, 'comparison');
  variantShape(value.recommendation, ['member', 'reason'], 'recommendation');
  variantRef(value.recommendation.member, 'recommendation.member'); variantText(value.recommendation.reason, 'recommendation.reason');
  const recommended = value.recommendation.member;
  if (!value.members.some(ref => variantSame(ref, recommended)))
    variantInvalid('recommendation.member', 'The recommendation names an exact member of the set');
  variantTexts(value.searchLimits, 'searchLimits', 1); variantTexts(value.unknowns, 'unknowns');
  return structuredClone(value) as unknown as VariantSet;
}
export function decodeVariantNone(value: unknown): VariantNone {
  variantShape(value, ['contract', 'projectId', 'draft', 'snapshot', 'origin', 'reasons', 'searchLimits', 'unknowns'], 'no_variants');
  variantBasis(value, VARIANT_NONE_CONTRACT); variantRef(value.snapshot, 'snapshot'); variantOrigin(value.origin, 'origin');
  if (!Array.isArray(value.reasons) || value.reasons.length === 0) variantInvalid('reasons', 'no_variants explains its result');
  Array.from(value.reasons).forEach((reason, i) => variantReason(reason, `reasons.${i}`));
  variantTexts(value.searchLimits, 'searchLimits', 1); variantTexts(value.unknowns, 'unknowns');
  return structuredClone(value) as unknown as VariantNone;
}

export function variantRecordId(kind: string, value: { projectId: string }): string {
  return `${kind}:${value.projectId}:${hashJson(value)}`;
}
/** Shared exact structural reader, not an injectable provenance verifier. Only immutable bytes are checked here. */
export function readVariantStructure<T extends { projectId: string }>(view: VariantRecordView, ref: Ref, project: string,
  kind: string, decode: (value: unknown) => T, mutableId?: string): StructuralVariantRecord<T> {
  variantRef(ref, 'record');
  if (!view || typeof view.get !== 'function') variantInvalid('view', 'An exact record reader is required', 'discovery_variant_basis_invalid');
  const row = view.get<unknown>(ref.id, ref.revision);
  if (!row || row.kind !== kind || !variantSame(reference(row), ref) || hashJson(row.value) !== ref.hash)
    variantInvalid('record', 'The exact record kind, revision or content hash does not match', 'discovery_variant_basis_invalid', ref);
  const value = decode(row.value);
  if (value.projectId !== project || row.id !== (mutableId ?? variantRecordId(kind, value)) || (!mutableId && row.revision !== 1))
    variantInvalid('record', 'Foreign project or noncanonical record address', 'discovery_variant_basis_invalid', ref);
  return { verification: 'structural', record: { ...row, value } };
}
export function readVariantSnapshotStructural(view: VariantRecordView, project: string, ref: Ref) {
  return readVariantStructure(view, ref, project, 'discovery-variant-snapshot', decodeVariantSnapshot);
}
export function readDiscoveryVariantStructural(view: VariantRecordView, project: string, ref: Ref) {
  const result = readVariantStructure(view, ref, project, 'discovery-variant', decodeDiscoveryVariant);
  const snapshot = readVariantSnapshotStructural(view, project, result.record.value.snapshot);
  if (!variantSame(snapshot.record.value.draft, result.record.value.draft)) variantInvalid('draft', 'Member and snapshot belong to different drafts', 'discovery_variant_basis_invalid');
  return result;
}
export function readVariantSetStructural(view: VariantRecordView, project: string, ref: Ref) {
  const result = readVariantStructure(view, ref, project, 'discovery-variant-set', decodeVariantSet), set = result.record.value;
  const snapshot = readVariantSnapshotStructural(view, project, set.snapshot);
  if (!variantSame(snapshot.record.value.draft, set.draft)) variantInvalid('draft', 'Set and snapshot belong to different drafts', 'discovery_variant_basis_invalid');
  const keys = new Set<string>();
  for (const member of set.members) {
    const item = readDiscoveryVariantStructural(view, project, member).record.value;
    if (!variantSame(item.snapshot, set.snapshot) || !variantSame(item.draft, set.draft)
      || !variantSame(item.origin, set.origin) || !variantSame(item.scale, set.scale) || keys.has(item.key))
      variantInvalid('members', 'Members share the exact snapshot, draft, producer and scale, with unique local keys', 'discovery_variant_basis_invalid', member);
    keys.add(item.key);
  }
  return result;
}
export function readVariantNoneStructural(view: VariantRecordView, project: string, ref: Ref) {
  const result = readVariantStructure(view, ref, project, 'discovery-variant-none', decodeVariantNone);
  const snapshot = readVariantSnapshotStructural(view, project, result.record.value.snapshot);
  if (!variantSame(snapshot.record.value.draft, result.record.value.draft)) variantInvalid('draft', 'Negative result and snapshot belong to different drafts', 'discovery_variant_basis_invalid');
  return result;
}

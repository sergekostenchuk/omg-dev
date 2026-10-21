import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision } from '../storage/store.js';
import type { ClaimAddress } from './claim-address.js';
import { decodeDossierContradictions, type DossierContradiction } from './dossier-contradictions.js';
import { V7_ATTEMPT_KIND, V7_AXES, V7_DEPTHS, V7_UNKNOWN_MOMENTS, V7_CLAIM_POINTER, type V7Axis } from './v7-contracts.js';

/** DR6 6.1 (codex-omg №9189, раздел DR6): the closed structural form of the
 * exact dossier snapshot of one v7 Discovery draft (D6, «манифест досье»). The
 * snapshot fixes the exact set of claims by axis and the addressed unknowns,
 * complete for a positive path or partial with its reasons on every path up to
 * the final (D7). Structural only: it proves its own immutable bytes and form,
 * never a paid producer, an accepted claim, an assessment or an acceptance —
 * a structural snapshot is not accepted and carries no acceptance fields.
 * Contradictions (6.2), the coverage semantics of complete/partial (6.3) and
 * the assessment of the snapshot (6.4–6.6) build on this form. */
export const DOSSIER_MANIFEST_KIND = 'discovery-dossier-manifest' as const;
export const DOSSIER_MANIFEST_CONTRACT = 'discovery-dossier-manifest/v1' as const;
/** The containers a v7 claim lives in — the two routes of resolveClaimAddress (ClaimAddress.containerKind). */
export const DOSSIER_CLAIM_CONTAINERS = Object.freeze(['research-answer', V7_ATTEMPT_KIND] as const);
/** The reasons a snapshot is partial (карта, ndisc.d6.n4): every variant rejected,
 * no grounded variant, the budget limit, no progress. */
export const DOSSIER_PARTIAL_REASONS = Object.freeze(['reject_all', 'no_variants', 'budget', 'stall'] as const);
export type DossierPartialReason = typeof DOSSIER_PARTIAL_REASONS[number];

export type DossierClaimAddress = ClaimAddress;
export interface DossierAxis { depth: typeof V7_DEPTHS[number]; reason: string | null; claims: DossierClaimAddress[] }
export interface DossierUnknown { claim: DossierClaimAddress; unknownId: string; consumer: string;
  moment: typeof V7_UNKNOWN_MOMENTS[number]; blocksCurrentStage: boolean }
export interface DossierReason { code: DossierPartialReason; message: string; grounds: Ref[] }
export interface DossierManifest {
  contract: typeof DOSSIER_MANIFEST_CONTRACT; projectId: string; draft: Ref; frame: Ref; plan: Ref;
  completeness: 'complete' | 'partial'; reasons: DossierReason[];
  axes: Record<V7Axis, DossierAxis>; unknowns: DossierUnknown[]; contradictions: DossierContradiction[];
}
export interface DossierRecordView { get<T = unknown>(id: string, revision?: number): Revision<T> | null }
/** A structural read result — deliberately not a proven or accepted dossier. */
export interface StructuralDossier { verification: 'structural'; record: Revision<DossierManifest> }

function invalid(field: string, message: string, code = 'discovery_dossier_invalid', ref?: Ref): never {
  throw new EngineError(code, `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: a missing key is an absence, an extra one (such as an acceptance mark) is no part of the form. */
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed dossier form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the dossier form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value) || !/^[a-f0-9]{64}$/.test(value.hash)) invalid(at, 'Expected an exact reference');
}
function refs(value: unknown, at: string, minimum: number): asserts value is Ref[] {
  if (!Array.isArray(value) || value.length < minimum) invalid(at, minimum ? 'Expected a nonempty reference list' : 'Expected a reference list');
  value.forEach((item, i) => ref(item, `${at}.${i}`));
  if (new Set(value.map(item => canonical(item))).size !== value.length) invalid(at, 'Duplicate exact references');
}
function claimAddress(value: unknown, at: string, project: string): asserts value is DossierClaimAddress {
  shape(value, ['project', 'container', 'containerKind', 'pointer', 'claimId'], at);
  if (value.project !== project) invalid(`${at}.project`, 'A dossier claim belongs to the snapshot project');
  ref(value.container, `${at}.container`);
  if (!(DOSSIER_CLAIM_CONTAINERS as readonly unknown[]).includes(value.containerKind))
    invalid(`${at}.containerKind`, `A claim lives in ${DOSSIER_CLAIM_CONTAINERS.join(' or ')}`);
  if (typeof value.pointer !== 'string' || !V7_CLAIM_POINTER.test(value.pointer) || !Number.isSafeInteger(Number(value.pointer.slice(8))))
    invalid(`${at}.pointer`, 'A claim pointer is /claims/<index>');
  text(value.claimId, `${at}.claimId`);
}
const addressKey = (address: DossierClaimAddress) => canonical([address.container, address.pointer, address.claimId]);

/** The closed form of one snapshot. Every axis of the 12 is present: an
 * inapplicable axis keeps its reason and no claims; an investigated one has no
 * reason and, in a complete snapshot, at least one claim. A claim belongs to one
 * axis. Every unknown is addressed — what (its claim and id), to which consumer,
 * by which moment, whether it blocks the stage — and names a claim of the axes.
 * A complete snapshot has no partial reasons; a partial one names at least one,
 * each with its code, message and exact grounds. Contradictions keep both sides
 * by their full axis addresses (dossier-contradictions). An unknown contract is refused. */
export function decodeDossierManifest(value: unknown): DossierManifest {
  if (!object(value) || value.contract !== DOSSIER_MANIFEST_CONTRACT)
    invalid('contract', `Only ${DOSSIER_MANIFEST_CONTRACT} is a known dossier form; another version is never read as this one`);
  shape(value, ['contract', 'projectId', 'draft', 'frame', 'plan', 'completeness', 'reasons', 'axes', 'unknowns', 'contradictions'], 'dossier');
  text(value.projectId, 'projectId');
  const project = value.projectId;
  ref(value.draft, 'draft'); ref(value.frame, 'frame'); ref(value.plan, 'plan');
  if (value.completeness !== 'complete' && value.completeness !== 'partial') invalid('completeness', 'A snapshot is complete or partial');
  const complete = value.completeness === 'complete';
  if (!Array.isArray(value.reasons)) invalid('reasons', 'Expected the list of partial reasons');
  if (complete && value.reasons.length) invalid('reasons', 'A complete snapshot has no partial reasons');
  if (!complete && !value.reasons.length) invalid('reasons', 'A partial snapshot names why it is partial');
  const codes = new Set<unknown>();
  value.reasons.forEach((reason: unknown, i: number) => {
    const at = `reasons.${i}`;
    shape(reason, ['code', 'message', 'grounds'], at);
    if (!(DOSSIER_PARTIAL_REASONS as readonly unknown[]).includes(reason.code))
      invalid(`${at}.code`, `A partial reason is one of ${DOSSIER_PARTIAL_REASONS.join(', ')}`);
    if (codes.has(reason.code)) invalid(`${at}.code`, 'Each partial reason is named once');
    codes.add(reason.code);
    text(reason.message, `${at}.message`); refs(reason.grounds, `${at}.grounds`, 1);
  });
  shape(value.axes, V7_AXES, 'axes');
  const axes = value.axes as Record<string, unknown>;
  const claims = new Map<string, DossierClaimAddress>();
  for (const axis of V7_AXES) {
    const at = `axes.${axis}`, entry = axes[axis];
    shape(entry, ['depth', 'reason', 'claims'], at);
    if (!(V7_DEPTHS as readonly unknown[]).includes(entry.depth)) invalid(`${at}.depth`, `A depth is one of ${V7_DEPTHS.join(', ')}`);
    if (!Array.isArray(entry.claims)) invalid(`${at}.claims`, 'Expected the list of the axis claims');
    if (entry.depth === 'inapplicable') {
      text(entry.reason, `${at}.reason`);
      if (entry.claims.length) invalid(`${at}.claims`, 'An inapplicable axis carries no claims');
    } else {
      if (entry.reason !== null) invalid(`${at}.reason`, 'Only an inapplicable axis carries a reason');
      if (complete && !entry.claims.length) invalid(`${at}.claims`, 'A complete snapshot has a claim on every investigated axis');
    }
    entry.claims.forEach((address: unknown, i: number) => {
      claimAddress(address, `${at}.claims.${i}`, project);
      const key = addressKey(address);
      if (claims.has(key)) invalid(`${at}.claims.${i}`, 'A claim belongs to one axis and is named once');
      claims.set(key, address);
    });
  }
  /** The identity key of a claim of the axes named by its full address, containerKind included (6.1-01). */
  const axisClaim = (address: unknown, at: string, whose: string): string => {
    claimAddress(address, at, project);
    const key = addressKey(address), named = claims.get(key);
    if (!named || canonical(named) !== canonical(address)) invalid(at, `${whose} names a claim of the snapshot axes by its full address`);
    return key;
  };
  if (!Array.isArray(value.unknowns)) invalid('unknowns', 'Expected the list of addressed unknowns');
  const unknownIds = new Set<unknown>(), unknownClaims = new Set<string>();
  value.unknowns.forEach((unknown: unknown, i: number) => {
    const at = `unknowns.${i}`;
    shape(unknown, ['claim', 'unknownId', 'consumer', 'moment', 'blocksCurrentStage'], at);
    const key = axisClaim(unknown.claim, `${at}.claim`, 'An unknown');
    if (unknownClaims.has(key)) invalid(`${at}.claim`, 'An unknown claim is listed once');
    unknownClaims.add(key);
    text(unknown.unknownId, `${at}.unknownId`);
    if (unknownIds.has(unknown.unknownId)) invalid(`${at}.unknownId`, 'Each unknown has its own id');
    unknownIds.add(unknown.unknownId);
    text(unknown.consumer, `${at}.consumer`);
    if (!(V7_UNKNOWN_MOMENTS as readonly unknown[]).includes(unknown.moment))
      invalid(`${at}.moment`, `A moment is one of ${V7_UNKNOWN_MOMENTS.join(', ')}`);
    if (typeof unknown.blocksCurrentStage !== 'boolean') invalid(`${at}.blocksCurrentStage`, 'An unknown states whether it blocks the stage');
  });
  decodeDossierContradictions(value.contradictions, { axisClaim: (address, at) => axisClaim(address, at, 'A side') });
  return structuredClone(value) as unknown as DossierManifest;
}

/** The canonical address of a snapshot: immutable, content-addressed, revision 1. */
export function dossierManifestId(value: { projectId: string }): string {
  return `${DOSSIER_MANIFEST_KIND}:${value.projectId}:${hashJson(value as never)}`;
}
/** The pure projector of a snapshot record — its closed form and its address.
 * Structural: the caller that writes it proves where its claims come from. */
export function projectDossierManifest(value: unknown): { id: string; value: DossierManifest } {
  const decoded = decodeDossierManifest(value);
  return { id: dossierManifestId(decoded), value: decoded };
}
/** The exact structural reader: the record at its exact Ref, of this kind and
 * project, at its canonical address and first revision, in the closed form.
 * Only immutable bytes are checked — the result is structural, not accepted. */
export function readDossierManifestStructural(view: DossierRecordView, project: string, at: Ref): StructuralDossier {
  ref(at, 'record');
  if (!view || typeof view.get !== 'function') invalid('view', 'An exact record reader is required');
  const row = view.get<unknown>(at.id, at.revision);
  if (!row || row.kind !== DOSSIER_MANIFEST_KIND || !Object.hasOwn(row, 'value') || canonical(reference(row)) !== canonical(at)
    || hashJson(row.value as never) !== at.hash)
    invalid('record', 'The exact record kind, revision or content hash does not match', 'discovery_dossier_invalid', at);
  const value = decodeDossierManifest(row.value);
  if (value.projectId !== project || row.id !== dossierManifestId(value) || row.revision !== 1)
    invalid('record', 'Foreign project or noncanonical snapshot address', 'discovery_dossier_invalid', at);
  return { verification: 'structural', record: { ...row, value } };
}

import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { ClaimAddress } from './claim-address.js';

/** DR6 6.2-F (codex-omg №9189, №9412): the closed structural form of the
 * contradictions of one dossier snapshot (карта, ndisc.d6.n2 — sources disagree,
 * the dossier keeps both sides). The model proposes the incompatibility; this
 * form keeps both sides with their stated status, why they are incompatible,
 * the plan questions they bear on, whether they block, and the resolution with
 * its exact grounds. Structural only: the statuses, the grounds and the
 * completeness of the explicit contradicts/refutedBy links are proven by real
 * producers in 6.2-D; blocking against the snapshot criteria and the ban on a
 * complete snapshot are 6.3. contradicts is symmetric; refutes is directed —
 * A.refutedBy = B is sides [B, A]. */
export const DOSSIER_CONTRADICTION_RELATIONS = Object.freeze(['contradicts', 'refutes'] as const);
/** The status of a side as its classification states it; unassessed — no classification in the snapshot grounds. */
export const DOSSIER_SIDE_STATUSES = Object.freeze(['accepted', 'rejected', 'unassessed'] as const);
/** The dimensions on which two claims may differ without conflicting — a newer
 * date or version or another region or variant scope is never by itself a
 * conflict, nor a win. */
export const DOSSIER_SCOPE_DIMENSIONS = Object.freeze(['asOf', 'apiVersion', 'region', 'variants'] as const);

export interface DossierContradictionSide { claim: ClaimAddress;
  status: typeof DOSSIER_SIDE_STATUSES[number]; assessment: Ref | null }
/** open — not resolved; side — the side at holds stands, the other stays with its
 * own status; scoped — an explicitly grounded difference of one dimension, no conflict. */
export type DossierResolution = { state: 'open' }
  | { state: 'side'; holds: 0 | 1; reason: string; grounds: Ref[] }
  | { state: 'scoped'; dimension: typeof DOSSIER_SCOPE_DIMENSIONS[number]; reason: string; grounds: Ref[] };
export interface DossierContradiction { id: string; relation: typeof DOSSIER_CONTRADICTION_RELATIONS[number];
  sides: [DossierContradictionSide, DossierContradictionSide]; reason: string; planQuestionIds: string[];
  blocking: boolean; resolution: DossierResolution }
/** What the contradictions form needs from its snapshot. */
export interface DossierContradictionContext {
  /** The identity key of a claim of the snapshot axes named by its full ClaimAddress; a typed refusal at `at` otherwise. */
  axisClaim(address: unknown, at: string): string;
}

function invalid(field: string, message: string): never {
  throw new EngineError('discovery_dossier_invalid', `[${field}] ${message}`, { field });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed contradiction form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the contradiction form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value) || !/^[a-f0-9]{64}$/.test(value.hash)) invalid(at, 'Expected an exact reference');
}
function grounds(value: unknown, at: string): void {
  if (!Array.isArray(value) || !value.length) invalid(at, 'A resolution names its exact grounds');
  value.forEach((item, i) => ref(item, `${at}.${i}`));
  if (new Set(value.map(item => canonical(item))).size !== value.length) invalid(at, 'Duplicate exact references');
}

/** One side: a claim of the snapshot axes by its full address with its status.
 * An unassessed side names no assessment; a classified attempt claim names the
 * exact chosen assessment; a research answer keeps its own proof route and may
 * name none. */
function side(value: unknown, at: string, context: DossierContradictionContext): string {
  shape(value, ['claim', 'status', 'assessment'], at);
  const key = context.axisClaim(value.claim, `${at}.claim`);
  if (!(DOSSIER_SIDE_STATUSES as readonly unknown[]).includes(value.status))
    invalid(`${at}.status`, `A side status is one of ${DOSSIER_SIDE_STATUSES.join(', ')}`);
  if (value.status === 'unassessed') {
    if (value.assessment !== null) invalid(`${at}.assessment`, 'An unassessed side names no assessment');
  } else if (value.assessment === null) {
    if ((value.claim as ClaimAddress).containerKind !== 'research-answer')
      invalid(`${at}.assessment`, 'A classified attempt claim names its exact chosen assessment');
  } else ref(value.assessment, `${at}.assessment`);
  return key;
}

function resolution(value: unknown, at: string, sides: DossierContradictionSide[]): void {
  if (!object(value) || !['open', 'side', 'scoped'].includes(value.state as string))
    invalid(`${at}.state`, 'A resolution is open, side or scoped');
  if (value.state === 'open') { shape(value, ['state'], at); return; }
  if (value.state === 'side') {
    shape(value, ['state', 'holds', 'reason', 'grounds'], at);
    if (value.holds !== 0 && value.holds !== 1) invalid(`${at}.holds`, 'The standing side is 0 or 1');
    if (sides[value.holds]?.status !== 'accepted') invalid(`${at}.holds`, 'Only an accepted side stands');
  } else {
    shape(value, ['state', 'dimension', 'reason', 'grounds'], at);
    if (!(DOSSIER_SCOPE_DIMENSIONS as readonly unknown[]).includes(value.dimension))
      invalid(`${at}.dimension`, `A scoped difference is one of ${DOSSIER_SCOPE_DIMENSIONS.join(', ')}`);
  }
  text(value.reason, `${at}.reason`); grounds(value.grounds, `${at}.grounds`);
}

/** The closed form of the contradictions list. Both sides are kept — an
 * unaccepted counter-argument never disappears from its entry; the standing side
 * of a resolution is an accepted one and the other keeps its status. A pair is
 * one contradiction: unordered for contradicts, directed for refutes. A scoped
 * difference is no conflict and blocks nothing. */
export function decodeDossierContradictions(value: unknown, context: DossierContradictionContext): DossierContradiction[] {
  if (!Array.isArray(value)) invalid('contradictions', 'Expected the list of contradictions');
  const ids = new Set<unknown>(), pairs = new Set<string>();
  value.forEach((entry: unknown, i: number) => {
    const at = `contradictions.${i}`;
    shape(entry, ['id', 'relation', 'sides', 'reason', 'planQuestionIds', 'blocking', 'resolution'], at);
    text(entry.id, `${at}.id`);
    if (ids.has(entry.id)) invalid(`${at}.id`, 'Each contradiction has its own id');
    ids.add(entry.id);
    if (!(DOSSIER_CONTRADICTION_RELATIONS as readonly unknown[]).includes(entry.relation))
      invalid(`${at}.relation`, `A relation is one of ${DOSSIER_CONTRADICTION_RELATIONS.join(', ')}`);
    if (!Array.isArray(entry.sides) || entry.sides.length !== 2) invalid(`${at}.sides`, 'A contradiction keeps both of its sides');
    const sides = entry.sides as unknown[];
    const keys = sides.map((item, s) => side(item, `${at}.sides.${s}`, context));
    if (keys[0] === keys[1]) invalid(`${at}.sides`, 'The two sides are different claims');
    const pair = canonical([entry.relation as string, ...(entry.relation === 'contradicts' ? [...keys].sort() : keys)]);
    if (pairs.has(pair)) invalid(`${at}.sides`, 'A pair of claims is one contradiction of its relation');
    pairs.add(pair);
    text(entry.reason, `${at}.reason`);
    const questions = entry.planQuestionIds;
    if (!Array.isArray(questions) || !questions.length) invalid(`${at}.planQuestionIds`, 'A contradiction names the plan questions it bears on');
    questions.forEach((id: unknown, q: number) => text(id, `${at}.planQuestionIds.${q}`));
    if (new Set(questions).size !== questions.length) invalid(`${at}.planQuestionIds`, 'Each plan question is named once');
    if (typeof entry.blocking !== 'boolean') invalid(`${at}.blocking`, 'A contradiction states whether it blocks the stage');
    resolution(entry.resolution, `${at}.resolution`, sides as DossierContradictionSide[]);
    if (entry.blocking && (entry.resolution as DossierResolution).state === 'scoped')
      invalid(`${at}.blocking`, 'A difference of time, version or area is no conflict and blocks nothing');
  });
  return value as DossierContradiction[];
}

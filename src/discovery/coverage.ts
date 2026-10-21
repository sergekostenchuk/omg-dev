import { hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from './v7-managed-attempt.js';

/** DR5 5.1-F (codex-omg №9189, №9576): the closed form and the pure key of one
 * coverage cell — one plan question (the exact v7-plan-subject/v1 subject) on
 * one exact variant (the exact set and its member), with the required depth and
 * criterion kept verbatim: no depth ranking and no reading of the criterion.
 * Common, a variant name, a bare variant id or a set without its member never
 * stands for the exact variant. The identity carries no decision, mode, grant
 * or session — those are admission grounds (4P) a consumer proves on its own.
 * Structural only: no covered, accepted, supported or ready mark, no
 * assessment, claim or computed status; the key confirms no coverage and
 * permits no dispatch. That the question belongs to the accepted plan with
 * this depth and criterion, and what is missing, the main 5.1 proves. */
export const DISCOVERY_COVERAGE_CELL_KIND = 'discovery-coverage-cell' as const;
export const DISCOVERY_COVERAGE_CELL_CONTRACT = 'discovery-coverage-cell/v1' as const;

export interface CoverageVariant { set: Ref; member: Ref }
export interface CoverageCell {
  contract: typeof DISCOVERY_COVERAGE_CELL_CONTRACT; projectId: string;
  subject: V7PlanSubject; variant: CoverageVariant; requiredDepth: string; criterion: string;
}

function invalid(field: string, message: string): never {
  throw new EngineError('discovery_coverage_invalid', `[${field}] ${message}`, { field });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: a missing key is an absence, an extra one (such as a covered mark) is no part of the form. */
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed coverage cell form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the coverage cell form');
}
/** Nonempty text kept verbatim. */
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'Expected an exact reference');
}

/** The closed form of a coverage cell; the input is never mutated — the result is a copy. */
export function decodeCoverageCell(value: unknown): CoverageCell {
  if (!object(value) || value.contract !== DISCOVERY_COVERAGE_CELL_CONTRACT)
    invalid('contract', `Only ${DISCOVERY_COVERAGE_CELL_CONTRACT} is a known coverage cell form; another version is never read as this one`);
  shape(value, ['contract', 'projectId', 'subject', 'variant', 'requiredDepth', 'criterion'], 'cell');
  text(value.projectId, 'projectId');
  shape(value.subject, ['contract', 'planAnswer', 'planQuestionId'], 'subject');
  if (value.subject.contract !== V7_PLAN_SUBJECT_CONTRACT)
    invalid('subject.contract', `The subject is the exact ${V7_PLAN_SUBJECT_CONTRACT} subject`);
  ref(value.subject.planAnswer, 'subject.planAnswer');
  text(value.subject.planQuestionId, 'subject.planQuestionId');
  shape(value.variant, ['set', 'member'], 'variant');
  ref(value.variant.set, 'variant.set');
  if (!value.variant.set.id.startsWith(`discovery-variant-set:${value.projectId}:`))
    invalid('variant.set', 'The set is a variant set of this project');
  ref(value.variant.member, 'variant.member');
  if (!value.variant.member.id.startsWith(`discovery-variant:${value.projectId}:`))
    invalid('variant.member', 'The member is a variant of this project');
  text(value.requiredDepth, 'requiredDepth');
  text(value.criterion, 'criterion');
  return structuredClone(value) as unknown as CoverageCell;
}

/** The pure key: the same content gives the same key whatever its JSON key order; another
 * project, question, exact plan, set or member, depth or criterion gives another key. */
export function coverageCellKey(value: unknown): string {
  const decoded = decodeCoverageCell(value);
  return `${DISCOVERY_COVERAGE_CELL_KIND}:${decoded.projectId}:${hashJson(decoded as unknown as Json)}`;
}

import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store } from '../storage/store.js';
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from './v7-managed-attempt.js';
import { proveClaimAddress, type ClaimAddress } from './claim-address.js';
import { claimContentKey, v7ProgressStateId } from './v7-attempt-assessment.js';
import { readVariantScope } from './variant-scope.js';
import { proveAttempt, provePlanQuestions, type V7PlanQuestion } from './v7-plan-questions.js';
import { readV7ProgressStateAt } from './v7-progress.js';
import { readDiscoveryAssessment } from './research-assessment.js';
import type { V7ProgressApplication, V7QuestionTransition } from './research-model.js';
import { V7_ATTEMPT_CONTRACT, V7_ATTEMPT_KIND } from './v7-contracts.js';
import type { V7Attempt } from './v7-plan-questions.js';
import type { DiscoveryDraft } from './discovery.js';

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

/* ---------- the main 5.1: the proof-based computation of the missing coverage ---------- */

/** One applied coverage ground: a claim proven accepted by the first application of its paid assessment
 * (proveClaimAddress — the one door that proves acceptance, the applied progress and the original paid assessment
 * together), kept with its exact address, its verbatim variant scope and its semantic content key. */
export interface AppliedCoverageGround {
  claim: ClaimAddress; kind: string; text: string; contentKey: string;
  /** The claim's own variants scope, verbatim: common material or exact variant Refs. */
  variants: 'common' | Ref[];
}
/** The addressed reason a cell is not covered. */
export type CoverageMissing =
  | { code: 'coverage_no_applied_grounds'; message: string }
  | { code: 'coverage_no_variant_ground'; message: string }
  | { code: 'coverage_no_sufficiency'; message: string };
/** The proven applied sufficiency that closed a cell: the exact applied assessment and its saved transition. */
export interface AppliedSufficiency { assessment: Ref; transition: V7QuestionTransition }
export interface CellCoverage {
  cell: CoverageCell; key: string; covered: boolean;
  /** The variant-specific applied grounds of this exact cell — material until a proven sufficiency closes on them. */
  grounds: AppliedCoverageGround[];
  /** The applied common material — kept for provenance, never closing a variant cell. */
  common: AppliedCoverageGround[];
  /** The proven applied closed sufficiency standing on this member's own ground, when the cell is covered. */
  sufficiency: AppliedSufficiency | null;
  missing: CoverageMissing | null;
}
export interface CoverageComputation {
  verification: 'proven'; project: string; scope: Ref; planAnswer: Ref;
  draft: Ref; set: Ref; member: Ref; cells: CellCoverage[]; missing: CellCoverage[];
}

/** The closed cell of one proven plan question over the proven variant. */
function cellOf(project: string, planAnswer: Ref, question: V7PlanQuestion, variant: CoverageVariant): CoverageCell {
  const value = question.question as Record<string, Json>;
  return decodeCoverageCell({ contract: DISCOVERY_COVERAGE_CELL_CONTRACT, projectId: project,
    subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId: question.planQuestionId },
    variant, requiredDepth: value['requiredDepth'], criterion: value['criterion'] });
}

/** The claim serves exactly this plan edition's question — its own planQuestions link names the exact plan
 * answer; the same planQuestionId of another edition proves nothing. */
function servesPlanQuestion(claim: Record<string, unknown>, planAnswer: Ref, planQuestionId: string): boolean {
  const links = claim['planQuestions'];
  if (!Array.isArray(links)) return false;
  return links.some(link => {
    if (!object(link)) return false;
    const named = link['planAnswer'];
    return typeof link['planQuestionId'] === 'string' && link['planQuestionId'] === planQuestionId
      && isRef(named) && canonical(named) === canonical(planAnswer);
  });
}

/** The main 5.1 (codex-omg2 №12393, the №9147 line): the proof-based computation of what is missing — one cell per
 * plan question of the exact accepted plan (question, requiredDepth and criterion verbatim from it, proven by
 * provePlanQuestions) over the exact chosen variant (the proven scope of 4P.1: the exact set, member, decision and
 * its paid generation). A cell is covered only by a ground proven through proveClaimAddress — acceptance by the
 * first application of a paid assessment; a structural record, a merely paid but unapplied assessment, a rejected
 * claim or a closed summary without its proven application give no coverage. Common material stays common and never
 * closes a variant cell; a foreign member, set, plan edition or a matching variant name substitutes nothing — the
 * member is matched by its exact Ref. No depth ranking or criterion meaning is read from the text. The computation
 * is a read-only projection over the named proven grounds: it writes nothing, pays nothing, authorizes no dispatch,
 * and a later head never rewrites an earlier projection. */
export function computeMissingCoverage(store: Store, project: string, scope: Ref, planAnswer: Ref): CoverageComputation {
  if (!(store instanceof Store) || typeof project !== 'string' || project.length === 0)
    invalid('store', 'A coverage computation requires its Store and project');
  if (!isRef(scope)) invalid('scope', 'The coverage names the exact Ref of its proven variant scope');
  if (!isRef(planAnswer)) invalid('planAnswer', 'The coverage names the exact Ref of its accepted plan answer');
  const proven = readVariantScope(store, project, scope);
  const value = proven.scope.value, variant: CoverageVariant = { set: value.set, member: value.member };
  const draft = store.get<DiscoveryDraft>(value.draft.id, value.draft.revision);
  if (draft === null || draft.kind !== 'discovery-draft' || draft.hash !== value.draft.hash)
    invalid('scope', 'The scope names its exact draft revision');
  const questions = provePlanQuestions(store, draft, planAnswer);
  const attempts = store.list<V7Attempt>(V7_ATTEMPT_KIND)
    .filter(row => row.value?.project === project && row.value?.contract === V7_ATTEMPT_CONTRACT
      && row.value.planQuestionId !== undefined && isRef(row.value.planAnswer)
      && canonical(row.value.planAnswer) === canonical(planAnswer));
  const cells: CellCoverage[] = questions.map(question => {
    const cell = cellOf(project, planAnswer, question, variant);
    const grounds: AppliedCoverageGround[] = [], common: AppliedCoverageGround[] = [];
    let serving = 0;
    for (const row of attempts.filter(item => item.value.planQuestionId === question.planQuestionId)) {
      // A structural candidate only: every ground below proves itself through its own door.
      const proof = proveAttempt(store, reference(row));
      const claims = proof.claims ?? [];
      for (const [index, raw] of claims.entries()) {
        if (!object(raw)) continue;
        const address: ClaimAddress = { project, container: reference(row), containerKind: V7_ATTEMPT_KIND,
          pointer: `/claims/${index}`, claimId: String(raw['id']) };
        let resolved: ReturnType<typeof proveClaimAddress>;
        try { resolved = proveClaimAddress(store, address); }
        catch (error) {
          // Rejected or not-yet-applied acceptance is the lawful negative answer, never coverage. A broken applied
          // chain (a hidden or damaged application) is a proof failure, not a negative: it keeps its own refusal.
          if (error instanceof EngineError && error.code === 'claim_attempt_not_accepted') continue;
          throw error;
        }
        const claim = resolved.claim as Record<string, unknown>;
        if (!servesPlanQuestion(claim, planAnswer, question.planQuestionId)) continue;
        serving++;
        const scopeValue = object(claim['scope']) ? claim['scope']['variants'] : undefined;
        const ground: AppliedCoverageGround = { claim: address, kind: String(claim['kind']),
          text: String(claim['text']), contentKey: claimContentKey(store, address),
          variants: scopeValue === 'common' ? 'common' : Array.isArray(scopeValue) ? scopeValue as Ref[] : [] };
        if (ground.variants === 'common') { common.push(ground); continue; }
        if (ground.variants.some(item => canonical(item) === canonical(variant.member))) grounds.push(ground);
      }
    }
    // Acceptance alone is material, never sufficiency: a cell closes only on a proven applied transition to closed
    // whose saved sufficiency names this plan question's own criterion and depth, and whose bases stand on this
    // member's own variant ground — the applied chain is proven by the MR/P door, the paid assessment by its own.
    const sufficiency = provenSufficiency(store, project, planAnswer, question, grounds);
    const covered = sufficiency !== null;
    return { cell, key: coverageCellKey(cell), covered, grounds, common, sufficiency,
      missing: covered ? null : grounds.length > 0
        ? { code: 'coverage_no_sufficiency', message: 'The applied variant grounds are material; no proven applied closed sufficiency of this exact depth and criterion stands on this member' }
        : serving > 0
          ? { code: 'coverage_no_variant_ground', message: 'The applied grounds serve the question but none is scoped to this exact member; common material and a foreign member never close it' }
          : { code: 'coverage_no_applied_grounds', message: 'No claim of this question was accepted by the first application of a paid assessment' } };
  });
  return { verification: 'proven', project, scope, planAnswer, draft: value.draft,
    set: value.set, member: value.member, cells, missing: cells.filter(cell => !cell.covered) };
}

/** The operative applied decision of the subject: the FIRST transition-bearing application on the proven chain from
 * the head — a later open/unknown decision supersedes an earlier closed one, and plain acceptances are walked through.
 * The head state is proven by readV7ProgressStateAt — which re-derives the whole application, its prior chain and
 * every account and event from the paid assessment — and each applied assessment is proven paid by its own reader. */
function operativeDecision(store: Store, project: string, stateId: string):
  { transition: V7QuestionTransition | null; assessment: Ref } | null {
  const head = store.get(stateId);
  if (head === null) return null;
  let state: Ref = reference(readV7ProgressStateAt(store, reference(head)));
  while (true) {
    // The state record's bytes are proven by the chain; its application names the applied paid assessment.
    const record = store.get<{ application: Ref }>(state.id, state.revision);
    if (record === null || !isRef(record.value.application))
      invalid('state', 'The proven progress state names its exact application');
    const application = store.get<V7ProgressApplication>(record.value.application.id, record.value.application.revision);
    if (application === null || !isRef(application.value.assessment))
      invalid('state', 'The proven application names its exact paid assessment');
    const paid = readDiscoveryAssessment(store, project, application.value.assessment);
    const transition: V7QuestionTransition | null = paid.value.novelty?.transition ?? null;
    if (transition !== null) return { transition, assessment: application.value.assessment };
    const previous = application.value.previous;
    if (previous === null || !isRef(previous)) return null;
    state = reference(readV7ProgressStateAt(store, previous));
  }
}

/** The cell's sufficiency: the operative applied decision must close against the plan question's own criterion and
 * depth and stand on one of the member's own grounds. An open or unknown decision — however many closed ones preceded
 * it — leaves the cell uncovered with its material grounds; a closing on common or a foreign member substitutes
 * nothing. */
function provenSufficiency(store: Store, project: string, planAnswer: Ref, question: V7PlanQuestion,
  grounds: AppliedCoverageGround[]): AppliedSufficiency | null {
  if (grounds.length === 0) return null;
  const groundAddresses = new Set(grounds.map(ground => canonical(ground.claim)));
  const decision = operativeDecision(store, project,
    v7ProgressStateId({ project, planAnswer, planQuestionId: question.planQuestionId }));
  if (decision === null || decision.transition === null) return null;
  const transition = decision.transition, assessment = decision.assessment;
  const own = question.question as Record<string, Json>;
  if (transition.outcome === 'closed' && transition.sufficiency !== undefined
    && typeof own['criterion'] === 'string' && typeof own['requiredDepth'] === 'string'
    && transition.sufficiency.criterion === own['criterion']
    && transition.sufficiency.requiredDepth === own['requiredDepth']
    && transition.bases.some(basis => 'claim' in basis && groundAddresses.has(canonical(basis.claim))))
    return { assessment, transition };
  return null;
}

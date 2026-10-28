import { canonical, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { Evidence, type Observation } from '../evidence/evidence.js';
import { isRef, reference, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { proveIssuedAnswer, savedAcceptanceAct } from './projection-reader.js';
import { isDiscoveryV7Draft } from './v7-contracts.js';

export const V7_FRAME_ASSESSMENT = 'discovery-frame-assessment/v1' as const;
export const V7_FRAME_ASSESSMENT_INSTRUCTION =
  ' For this Discovery frame, v7Frame contains the independently selected accepted owner brief and objective. '
  + 'Read both in full; author-selected citations do not replace or limit them. '
  + 'Check that productType, scale, industries and domains preserve the entire mandate without silent narrowing or expansion. '
  + 'Evaluate all 12 axis depths against the actual users, volumes, resources and consequences in the mandate. '
  + 'Personal use can justify brief research, never inapplicability by itself; inapplicable needs a subject-specific reason. '
  + 'A company website and an internal resource ledger need different depths even in the same industry: '
  + 'do not impose a fixed productType-to-depth table. Check the explanations in axes.*.reason and the budget allocation. '
  + 'If this product belongs to a larger organization or system, check that its constraints are reflected in '
  + 'axis 05 (rules) and its main consumer\'s measurable success in axis 12 (outcome), including their reasons. '
  + 'If that relationship or its requirements are unknown, require an explicit research need instead of invented rules. '
  + 'Return insufficient for missing scope, unjustified depth or missing larger-system requirements, conflicting for '
  + 'contradiction of the mandate, and supported only when the whole frame is justified. Explain the affected axes and scope.';

interface AcceptedText { question: Ref; answer: Ref; value: string }
export interface V7FrameAssessmentContext {
  contract: typeof V7_FRAME_ASSESSMENT;
  draft: Ref;
  question: Ref;
  brief: AcceptedText & { observation: Observation };
  objective: AcceptedText;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireFrame(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'discovery_frame_basis_invalid', message);
}

/** Select the mandate independently of candidate citations. The managed caller
 * supplies its captured read view on recovery, so current heads never replace
 * the grounds of an already paid assessment. */
export function v7FrameAssessment(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>): {
  context: V7FrameAssessmentContext; guards: Ref[];
} | null {
  if (!isDiscoveryV7Draft(draft.value) || question.value.spec.field !== 'frame') return null;
  requireFrame(question.value.projectId === draft.value.projectId && question.value.draftId === draft.id
    && draft.value.questions.includes(question.id), 'The frame question must belong to its Discovery draft');
  const before = draft.value.questions.slice(0, draft.value.questions.indexOf(question.id))
    .map(id => store.get<Question>(id));
  const guards = [reference(draft), reference(question)];
  const accepted = (field: 'brief' | 'objective') => {
    const matches = before.filter(row => row?.kind === 'question' && row.value.spec.field === field);
    requireFrame(matches.length === 1, `The frame needs exactly one accepted ${field} before it`);
    const q = matches[0]!;
    requireFrame(q.value.projectId === draft.value.projectId && q.value.draftId === draft.id
      && q.value.status === 'answered' && isRef(q.value.answer),
    `The frame needs its accepted ${field}; an absent or reopened mandate cannot support a new assessment`);
    const answer = store.get<Record<string, unknown>>(q.value.answer.id, q.value.answer.revision);
    requireFrame(answer && same(reference(answer), q.value.answer) && hashJson(answer.value) === answer.hash,
      `The frame's accepted ${field} answer is missing or changed`);
    const proven = proveIssuedAnswer(store, draft, { question: q, foreign: false, answered: true,
      answerRef: q.value.answer, field }, answer);
    requireFrame(proven.ok && proven.proof.namespaced && proven.proof.matchesSpec && proven.proof.reproduces
      && typeof proven.proof.value === 'string' && proven.proof.value.trim().length > 0
      && savedAcceptanceAct(store, draft, q, field, q.value.answer, proven.proof.value),
    `The frame's ${field} has no proven acceptance`);
    guards.push(reference(q), q.value.answer);
    return { entry: { question: reference(q), answer: q.value.answer, value: proven.proof.value },
      provenance: proven.proof.provenance };
  };
  const brief = accepted('brief'), objective = accepted('objective');
  requireFrame(brief.provenance.kind === 'fact' && objective.provenance.kind === 'decision'
    && objective.provenance.hasAuthor, 'The mandate must retain its original fact and owner decision');
  const original = brief.provenance.observation;
  const observation = new Evidence(store).observe(draft.value.projectId, original.source, original.selector);
  requireFrame(same(observation, original), 'The accepted brief must reproduce its original source bytes');
  guards.push(observation.source);
  return { context: { contract: V7_FRAME_ASSESSMENT, draft: reference(draft), question: reference(question),
    brief: { ...brief.entry, observation }, objective: objective.entry }, guards: uniqueRefs(guards) };
}

/** The direct acceptance uses the same prefix the assessor saw. Reading it is
 * historical; only the acceptance transaction requires those heads current. */
export function v7FrameAssessmentBasis(value: unknown): Ref[] {
  requireFrame(object(value) && value.contract === V7_FRAME_ASSESSMENT && isRef(value.draft)
    && isRef(value.question), 'The saved frame assessment lost its mandate context');
  for (const field of ['brief', 'objective']) {
    const row: unknown = value[field];
    requireFrame(object(row) && isRef(row.question) && isRef(row.answer)
      && typeof row.value === 'string' && row.value.trim().length > 0,
    `The saved frame assessment lost its accepted ${field}`);
  }
  requireFrame(object(value.brief.observation) && isRef(value.brief.observation.source)
    && value.brief.observation.value === value.brief.value, 'The saved frame assessment lost its original brief observation');
  return uniqueRefs([value.brief.question, value.brief.answer, value.brief.observation.source,
    value.objective.question, value.objective.answer]);
}

import { canonical, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store, TransactionGuard } from '../storage/store.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { PaidDiscoveryAttemptsAssessment, ResearchAnswer, ResearchRun, V7ProgressApplication, V7ProgressState } from './research-model.js';
import { currentPlan, provePlanQuestions } from './v7-plan-questions.js';
import { discoveryTraversal, type V7TraversalBudget } from './discovery-outcome.js';
import { discoveryAcceptanceActId, provenAcceptance, type DiscoveryAcceptanceAct } from './v7-contracts.js';
import { proveIssuedAnswer, readExact, researchRunId, savedAcceptanceAct } from './projection-reader.js';
import { readV7AssessmentReplay, readV7ProgressStateAt } from './v7-progress.js';
import { readDiscoveryAssessment } from './research-assessment.js';
import { DISCOVERY_ASSESSMENT_KIND, v7ProgressStateId } from './v7-attempt-assessment.js';
import { planSubjectOf, questionDispatchId, type V7PlanSubject } from './v7-managed-attempt.js';
import { readResearchConsumerIntent, consumerIntentContext, readResearchConsumerTurn, type ResearchConsumerIntent } from './response-recovery.js';
import { readSynthesisSessionV3 } from './synthesis-session.js';
import { synthesisReservationConsumed, SYNTHESIS_SESSION_V3_PREFIX } from './research-consumer-transition.js';
import { stageBudgetSegmentId } from './stage-token-budget.js';
import { VARIANT_SNAPSHOT_CONTRACT, readVariantSnapshotStructural, variantRecordId,
  type VariantSnapshot, type VariantReason } from './discovery-variants.js';

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function invalid(field: string, message: string): never {
  throw new EngineError('discovery_variant_basis_invalid', `[${field}] ${message}`, { field });
}
function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  const row = isRef(ref) ? readExact<T>(store, ref) : null;
  if (!row || row.kind !== kind) invalid(kind, 'The exact saved basis is missing or belongs to another kind');
  return row;
}
/** The saved acceptance binds the field Question revision; an answer Ref is not a Question Ref. */
function acceptedField(store: Store, draft: Revision<DiscoveryDraft>, field: string, answerRef: Ref) {
  const act = store.get<DiscoveryAcceptanceAct>(discoveryAcceptanceActId(draft.value.projectId, draft.id, field, answerRef));
  if (!act || !isRef(act.value.questionAfter)) invalid(field, 'The field has no saved acceptance');
  const question = exact<Question>(store, act.value.questionAfter, 'question');
  const answer = exact<ResearchAnswer>(store, answerRef, 'research-answer');
  if (!savedAcceptanceAct(store, draft, question, field, answerRef, answer.value.value))
    invalid(field, 'The field does not belong to this exact accepted draft');
  const issued = proveIssuedAnswer(store, draft,
    { question, foreign: false, answered: true, answerRef, field },
    answer as unknown as Revision<Record<string, Json>>, { verifyIssuedQuestion: true });
  if (!issued.ok || !provenAcceptance(issued.proof.provenance)) invalid(field, 'The accepted answer has no complete provenance');
  return { question, answer };
}
function planBasis(store: Store, draft: Revision<DiscoveryDraft>, plan: Ref) {
  const questions = provePlanQuestions(store, draft, plan);
  // provePlanQuestions has proved this exact acceptance and answer already; retain its bound Question.
  const act = store.get<DiscoveryAcceptanceAct>(discoveryAcceptanceActId(draft.value.projectId, draft.id, 'plan', plan))!;
  const value = exact<ResearchAnswer>(store, plan, 'research-answer').value.value as Record<string, Json>;
  if (!isRef(value.frame)) invalid('frame', 'The accepted plan must name its exact frame');
  acceptedField(store, draft, 'frame', value.frame);
  return { questions, question: act.value.questionAfter, frame: value.frame };
}
/** Historical evidence only: every state/application is re-derived by P's common reader. No HEAD comparison. */
function appliedQuestion(store: Store, project: string, plan: Ref, question: Ref,
  planQuestionId: string, blocking: boolean, progress: Ref): VariantSnapshot['questions'][number] {
  const state = readV7ProgressStateAt(store, progress), applications: Ref[] = [];
  const subject = { project, planAnswer: plan, planQuestionId };
  if (!same(state.value.subject, subject)) invalid(planQuestionId, 'Progress belongs to another exact subject');
  const seen = new Set<string>();
  for (let row: Revision<V7ProgressState> | null = state; row;) {
    if (seen.has(canonical(reference(row)))) invalid(planQuestionId, 'Cyclic progress chain');
    seen.add(canonical(reference(row)));
    if (!same(row.value.subject, subject)) invalid(planQuestionId, 'A predecessor belongs to another subject');
    const app: Revision<V7ProgressApplication> = exact<V7ProgressApplication>(store, row.value.application, 'v7-progress-application');
    applications.unshift(reference(app));
    // The common reader above already proved this whole predecessor chain. Keep its exact rows here.
    row = app.value.previous ? exact<V7ProgressState>(store, app.value.previous, 'v7-progress-state') : null;
  }
  const summary = state.value.summary;
  const reason: VariantReason | null = summary.outcome === 'open' || summary.outcome === 'stalled'
    ? { code: `progress_${summary.outcome}`,
      message: summary.reason ?? `Applied progress remains ${summary.outcome} after ${summary.count} accounted attempts; no-progress streak ${summary.streak}`,
      grounds: [progress, state.value.application] } : null;
  return { planQuestionId, question, blocking, progress, applications, reason };
}

export interface VariantSnapshotRefusal {
  status: 'not_ready' | 'early_limit'; reasons: VariantReason[]; generationAllowed: false;
  budget: V7TraversalBudget | null;
}
export interface VariantSnapshotReady {
  status: 'ready'; snapshot: VariantSnapshot; guards: TransactionGuard[];
  /** Coverage is independent of permission for another paid generation. The caller must still use its budget admission. */
  generationAllowed: boolean; generationRefusal: VariantReason | null; budget: V7TraversalBudget | null;
}
export type VariantSnapshotReadiness = VariantSnapshotReady | VariantSnapshotRefusal;

/** Each consumer keeps its subject at its own declared producer address. No structural-field fallback. */
function planConsumerSubject(store: Store, row: Revision<ResearchConsumerIntent>, plan: Ref):
  { intent: Revision<ResearchConsumerIntent>; subject: V7PlanSubject } | null {
  const value = row.value;
  // Producing the initial plan uses the same Question ID as later research,
  // but its proven historical basis predates the accepted planAnswer.
  if (!Object.hasOwn(value.cursor ?? {}, 'subject')) {
    const producer = readResearchConsumerIntent(store, reference(row));
    const original = exact<DiscoveryDraft>(store, producer.value.draft, 'discovery-draft');
    const anchor = exact<Question>(store, producer.value.question, 'question');
    if (original.value.projectId === producer.value.projectId && anchor.value.projectId === producer.value.projectId
      && anchor.value.draftId === original.id && original.value.questions.includes(anchor.id)
      && original.value.stage === 'discovery' && original.value.contractVersion === 7
      && anchor.value.spec.field === 'plan' && anchor.value.status === 'open' && anchor.value.answer === null
      && original.value.fields.plan === null) return null;
  }
  let intent: Revision<ResearchConsumerIntent>, subject: V7PlanSubject | null;
  if (value.kind === 'escalation-assessor' || value.kind === 'reader') {
    intent = readResearchConsumerIntent(store, reference(row));
    let turn;
    if (value.kind === 'escalation-assessor') {
      subject = planSubjectOf(consumerIntentContext(store, intent.value, intent.id));
      if (!isRef(intent.value.cursor.pendingTurn)) invalid(row.id, 'Owner review lost its original pending turn');
      turn = readResearchConsumerTurn(store, intent.value.cursor.pendingTurn);
      if (turn.value.run !== intent.value.owner.id || turn.value.number !== intent.value.cursor.turn
        || !same(subject, planSubjectOf(turn.value))) invalid(row.id, 'Owner review lost its exact pending subject/position');
    } else {
      const consumer = intent.value.cursor.consumer;
      if (!consumer || !isRef(consumer.run) || !isRef(consumer.turn)
        || !same(intent.value.owner, consumer.turn)) invalid(row.id, 'Reader lost its original consumer run/turn');
      const run = exact<ResearchRun>(store, consumer.run, 'research-run');
      turn = readResearchConsumerTurn(store, consumer.turn);
      subject = planSubjectOf(turn.value);
      if (run.value.projectId !== intent.value.projectId || run.value.draftId !== intent.value.draft.id
        || turn.value.run !== run.id) invalid(row.id, 'Reader consumer belongs to another run/project/draft');
    }
    const anchor = exact<Question>(store, intent.value.question, 'question');
    if (!subject || !same(turn.value.question, intent.value.question)
      || anchor.value.projectId !== intent.value.projectId || anchor.value.draftId !== intent.value.draft.id
      || anchor.value.spec.field !== 'plan' || !same(anchor.value.answer, subject.planAnswer))
      invalid(row.id, 'The saved consumer lost its exact subject/Question/turn binding');
  } else {
    // Lawful abandoned ordinary work of an older edition is not current work.
    const savedPlan = value.cursor?.subject?.planAnswer;
    if (isRef(savedPlan) && !same(savedPlan, plan)) return null;
    subject = planSubjectOf(value.cursor);
    if (!subject) invalid(row.id, 'An own plan consumer lost its exact subject');
    intent = readResearchConsumerIntent(store, reference(row));
  }
  return same(subject.planAnswer, plan) ? { intent, subject } : null;
}

/** Unfinished work of this exact edition, including a persisted session before its first intent. */
function pendingOperations(store: Store, project: string, draft: Revision<DiscoveryDraft>, question: Ref, plan: Ref,
  guards: TransactionGuard[]): VariantReason[] {
  const reasons: VariantReason[] = [];
  for (const row of store.list<ResearchConsumerIntent>('research-consumer-intent')) {
    const value = row.value;
    if (value?.projectId !== project || value.draft?.id !== draft.id || value.question?.id !== question.id) continue;
    // Variant execution has its own subject and restore-first runner path. Prove the exact
    // consumer before separating it from MR/P; a renamed or structurally decorated intent is no bypass.
    if (value.kind === 'variant-proposal' || value.kind === 'variant-decision') {
      readResearchConsumerIntent(store, reference(row));
      continue;
    }
    const consumer = planConsumerSubject(store, row, plan);
    if (!consumer) continue;
    const { intent, subject } = consumer;
    guards.push(reference(intent));
    if (intent.value.state === 'prepared' || intent.value.state === 'running') reasons.push({
      code: 'consumer_pending', message: `Plan question ${subject.planQuestionId} has an unfinished ${value.kind}`,
      grounds: [reference(intent)] });
  }
  for (const row of store.list<any>('synthesis-session')) {
    const value = row.value;
    if (!row.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX) || value?.projectId !== project
      || value.binding?.draft?.id !== draft.id || value.binding?.question?.id !== question.id) continue;
    const savedPlan = value.binding?.subject?.planAnswer;
    if (isRef(savedPlan) && !same(savedPlan, plan)) continue;
    const session = readSynthesisSessionV3(store, reference(row));
    guards.push(reference(session));
    if (session.value.result === null || session.value.delivery != null && !synthesisReservationConsumed(session.value)) reasons.push({ code: 'session_pending',
      message: `Plan question ${session.value.binding.subject.planQuestionId} has an unfinished synthesis session`,
      grounds: [reference(session)] });
  }
  return reasons;
}

/** The shared D4 admission reads producers, never run.status, a caller's ready flag or caller-supplied reasons.
 * R.3 supplies the current traversal; this module does not substitute its own traversal classifier. */
export function variantSnapshotReadiness(store: Store, project: string): VariantSnapshotReadiness {
  const stamp = store.changeStamp();
  const plan = currentPlan(store, project), basis = planBasis(store, plan.draft, plan.planAnswer);
  const guards: TransactionGuard[] = [reference(plan.draft), reference(plan.question)];
  const headGuard = (id: string) => {
    const head = store.get(id); guards.push(head ? reference(head) : { id, absent: true });
  };
  // The run reservation and physical dispatch counter serialize new producer work with publication.
  headGuard(researchRunId(project, plan.draft.id));
  headGuard(stageBudgetSegmentId(project));
  const traversal = discoveryTraversal(store, plan.draft);
  if (!traversal || !same(traversal.plan, plan.planAnswer)) invalid('plan', 'No traversal of this accepted plan');
  if (traversal.budget) guards.push(traversal.budget.segment, traversal.budget.ledger, ...traversal.budget.calls);
  const reasons = pendingOperations(store, project, plan.draft, reference(plan.question), plan.planAnswer, guards);
  const questions: VariantSnapshot['questions'] = [], appliedAssessments = new Set<string>();
  for (const entry of plan.questions) {
    const row = traversal.subjects.find(item => item.subject.planQuestionId === entry.planQuestionId
      && item.subject.project === project && same(item.subject.planAnswer, plan.planAnswer));
    if (!row) invalid(entry.planQuestionId, 'Traversal omitted an applicable plan question');
    const subject: V7PlanSubject = { contract: 'v7-plan-subject/v1', planAnswer: plan.planAnswer, planQuestionId: entry.planQuestionId };
    headGuard(questionDispatchId(project, plan.question.id, subject));
    guards.push(row.state ?? { id: v7ProgressStateId(row.subject), absent: true });
    if (row.pending.length) reasons.push({ code: row.assessments.length ? 'assessment_unapplied' : 'assessment_unpaid',
      message: `Plan question ${entry.planQuestionId} has unaccounted attempts`, grounds: [...row.pending, ...row.assessments] });
    if (!row.state) {
      reasons.push({ code: 'question_uncovered', message: `Plan question ${entry.planQuestionId} has no applied result or proven absence reason`,
        grounds: [plan.planAnswer, basis.question] });
      continue;
    }
    const question = appliedQuestion(store, project, plan.planAnswer, basis.question, entry.planQuestionId,
      (entry.question as Record<string, Json>).class === 'blocking', row.state);
    if (!same(question.applications, row.applications)) invalid(entry.planQuestionId, 'Traversal and saved application chain differ');
    for (const ref of question.applications)
      appliedAssessments.add(canonical(exact<V7ProgressApplication>(store, ref, 'v7-progress-application').value.assessment));
    questions.push(question);
  }
  // A paid reassessment can contain an unaccounted remainder even when earlier K already have accounts.
  // The traversal's pending-K selection alone cannot classify every paid result. P.3's read-only replay proof also permits a fully accounted packet whose
  // unchanged acceptance was established by the original applications, without creating another application.
  for (const row of store.list<PaidDiscoveryAttemptsAssessment>(DISCOVERY_ASSESSMENT_KIND)) {
    if (row.value?.projectId !== project || !same(row.value.subject?.packet?.planAnswer, plan.planAnswer)) continue;
    if (appliedAssessments.has(canonical(reference(row)))) continue; // already proved through its P application
    const assessment = readDiscoveryAssessment(store, project, reference(row));
    if (readV7AssessmentReplay(store, project, reference(assessment))) continue;
    if (!reasons.some(reason => reason.grounds.some(ref => same(ref, reference(assessment)))))
      reasons.push({ code: 'assessment_unapplied', message: `Plan question ${assessment.value.subject.packet.planQuestionId} has an unapplied paid assessment`,
        grounds: [reference(assessment)] });
  }
  if (stamp !== store.changeStamp()) throw new EngineError('discovery_variant_snapshot_stale', 'Snapshot inputs changed during the current read');
  const generationRefusal: VariantReason | null = traversal.budget?.exhausted ? { code: 'research_budget_exhausted',
    message: `Stage budget ${traversal.budget.segment.id} admits no new paid generation`,
    grounds: [traversal.budget.segment, traversal.budget.ledger, ...traversal.budget.calls] } : null;
  if (reasons.length) return { status: generationRefusal ? 'early_limit' : 'not_ready',
    reasons: generationRefusal ? [...reasons, generationRefusal] : reasons, generationAllowed: false, budget: traversal.budget };
  const snapshot: VariantSnapshot = { contract: VARIANT_SNAPSHOT_CONTRACT, projectId: project,
    draft: reference(plan.draft), plan: plan.planAnswer, frame: basis.frame, questions };
  return { status: 'ready', snapshot, guards: uniqueTransactionGuards(guards),
    generationAllowed: generationRefusal === null, generationRefusal, budget: traversal.budget };
}

/** Historical proof follows the sealed exact plan/frame and every applied chain, even after HEADs have moved. */
export function readVariantSnapshot(store: Store, project: string, ref: Ref): Revision<VariantSnapshot> {
  try {
    const record = readVariantSnapshotStructural(store, project, ref).record, value = record.value;
    const draft = exact<DiscoveryDraft>(store, value.draft, 'discovery-draft');
    if (draft.value.projectId !== project) invalid('draft', 'Foreign snapshot draft');
    const basis = planBasis(store, draft, value.plan);
    if (!same(value.frame, basis.frame) || value.questions.length !== basis.questions.length)
      invalid('plan', 'Snapshot does not retain the exact frame and all applicable questions');
    const questions = basis.questions.map(entry => {
      const saved = value.questions.find(row => row.planQuestionId === entry.planQuestionId);
      if (!saved?.progress) invalid(entry.planQuestionId, 'No supported absence-reason producer exists for this uncovered question');
      return appliedQuestion(store, project, value.plan, basis.question, entry.planQuestionId,
        (entry.question as Record<string, Json>).class === 'blocking', saved.progress);
    });
    if (!same(questions, value.questions)) invalid('questions', 'The ordered questions, explanations or applications differ from their exact producers');
    return record;
  } catch (error) {
    if (error instanceof EngineError && error.code !== 'discovery_variant_basis_invalid')
      invalid('snapshot', `The saved snapshot cannot be proven: ${error.code}: ${error.message}`);
    throw error;
  }
}

/** The write-lock is acquired before readiness is derived, including selection of sessions/intents. A new session
 * cannot appear between this read and publication. No model or recovery operation is run by this callback. */
export function produceVariantSnapshot(store: Store, project: string):
  VariantSnapshotReady & { record: Revision<VariantSnapshot>; repeated: boolean } {
  try {
    const published = store.atomicWrite(view => {
      const ready = variantSnapshotReadiness(view, project);
      if (ready.status !== 'ready') throw new EngineError(`discovery_variant_${ready.status}`,
        'The current plan traversal is not ready for a complete variant snapshot', { reasons: ready.reasons });
      const id = variantRecordId('discovery-variant-snapshot', ready.snapshot), existing = view.get(id);
      const record = existing ? readVariantSnapshot(view, project, reference(existing)) : null;
      return { value: { ready, record, repeated: record !== null }, guards: ready.guards,
        writes: record ? [] : [{ id, kind: 'discovery-variant-snapshot', expected: 0, value: ready.snapshot }] };
    });
    return { ...published.value.ready, repeated: published.value.repeated,
      record: published.value.record ?? published.records[0]! as Revision<VariantSnapshot> };
  } catch (error) {
    if (error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code))
      throw new EngineError('discovery_variant_snapshot_stale', 'The snapshot publication guards did not hold');
    throw error;
  }
}

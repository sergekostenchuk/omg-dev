import type { Store, Revision } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { Evidence } from '../evidence/evidence.js';
import { canonical, hashJson } from '../canonical.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { requireCondition } from '../errors.js';
import type { ResearchAnswer } from './research-model.js';
import { activeSynthesisNotes } from './conclusion-consolidation.js';
import { planQuestionContract } from './continuation-packet.js';
import { isDiscoveryV7Draft } from './v7-contracts.js';
import { sameSubject, type V7PlanSubject } from './v7-managed-attempt.js';
import { proveCheckpointRecord, projectSavedSynthesisV2, requirePlanSubject, researchCheckpointV2Holds,
  savedSynthesisV2Id, savedSynthesisV2Shape, synthesisSessionSubject, SYNTHESIS_SESSION_V3_PREFIX,
  type SavedSynthesisV2, type SynthesisSessionStateV3 } from './research-consumer-transition.js';
import { readSynthesisSessionV3 } from './synthesis-session.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
interface SavedSynthesis { projectId: string; question: Ref; inputs: Ref[]; checkpoints: Ref[] }
export function configureSavedSynthesis(store: Store, questionId: string, expected: number) {
  const question=store.get<Question>(questionId),draft=question && store.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(question?.kind==='question' && draft?.kind==='discovery-draft' && question.value.status!=='answered',
    'research_question_foreign','Saved recovery needs its open question');
  // DR3a3-S4: a v7 draft chooses saved-only by its plan subject only; its
  // subject-bound v2 notes share the physical plan Question and are never
  // adopted by this field-path selection.
  requireCondition(!isDiscoveryV7Draft(draft.value),'research_question_foreign',
    'A v7 draft chooses saved-only notes by its plan subject (configure-v7-saved-synthesis)');
  const checkpoints=store.list<any>('research-checkpoint').filter(c=>c.value.projectId===draft.value.projectId
    && canonical(c.value.question)===canonical(reference(question)) && !researchCheckpointV2Holds(c.value)
    && !c.id.startsWith('research-checkpoint:v2:'));
  requireCondition(checkpoints.length>0,'saved_synthesis_missing','No paid checkpoint exists for this exact question');
  const evidence=new Evidence(store);
  requireCondition(checkpoints.every(c=>c.value.observations.every((o:any)=>evidence.verify(o))),
    'synthesis_evidence_stale','Saved checkpoint source versions must still be available');
  return store.writeMany<SavedSynthesis>([{id:`saved-synthesis:${questionId}`,kind:'saved-synthesis',expected,
    value:{projectId:draft.value.projectId,question:reference(question),inputs:draft.value.inputs,checkpoints:checkpoints.map(reference)}}],
    [reference(question),reference(draft),...draft.value.inputs,...checkpoints.map(reference)])[0]!;
}
export function savedSynthesisMaterials(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>) {
  const saved=store.get<SavedSynthesis>(`saved-synthesis:${question.id}`);
  if(!saved)return null;
  requireCondition(saved.kind==='saved-synthesis' && saved.value.projectId===draft.value.projectId
    && canonical(saved.value.question)===canonical(reference(question)) && canonical(saved.value.inputs)===canonical(draft.value.inputs),
    'saved_synthesis_stale','Recovery cannot use checkpoints of a different question or basis');
  return saved.value.checkpoints.map(ref=>{
    const record=store.get<any>(ref.id,ref.revision);
    requireCondition(record?.kind==='research-checkpoint' && record.hash===ref.hash
      && record.value.observations.every((o:any)=>new Evidence(store).verify(o)), 'synthesis_evidence_stale','Saved findings lost their original evidence');
    return {kind:'saved-findings',value:{checkpoint:ref,proposal:record.value.proposal,unresolved:record.value.unresolved,
      evidence:record.value.observations.map((o:any,index:number)=>({source:o.source,selector:o.selector,original:{record:ref,pointer:`/observations/${index}`}})),
      instruction:'Already paid proposed findings; reconcile all saved pieces. Page-pending notices are not new research questions.'}};
  });
}

/* ---------- DR3a3-S4 (codex-omg №7690, решения 3, 6): saved-only of one v7 subject ----------
 * A separate command and address space from the v1 configure above (which is
 * unchanged). The real Question is derived from the exact plan answer, never
 * passed as an overloaded string; the notes are the exact checkpoints of the
 * subject's own proven session, never selected by Question id or text. */

/** The exact basis of one v7 subject: the plan answer at its exact revision,
 * the physical plan Question it answers and that Question's draft, all of this
 * project. Missing, null, damaged or foreign is research_plan_subject_invalid
 * on every path (command parser → engine and the direct API alike). */
export function savedSubjectBasis(store: Store, project: string, subject: unknown) {
  const exact = requirePlanSubject(subject, 'saved-synthesis');
  const answer = store.get<ResearchAnswer>(exact.planAnswer.id, exact.planAnswer.revision);
  const question = answer?.kind === 'research-answer' && answer.hash === exact.planAnswer.hash && hashJson(answer.value) === answer.hash
    && typeof answer.value?.question === 'string' ? store.get<Question>(answer.value.question) : null;
  const draft = question?.kind === 'question' && typeof question.value?.draftId === 'string'
    ? store.get<DiscoveryDraft>(question.value.draftId) : null;
  requireCondition(answer?.value.projectId === project && question?.kind === 'question' && question.value.projectId === project
    && question.value.spec?.field === 'plan' && draft?.kind === 'discovery-draft' && draft.value.projectId === project
    && isDiscoveryV7Draft(draft.value) && Array.isArray(draft.value.questions) && draft.value.questions.includes(question.id),
  'research_plan_subject_invalid', "The saved-only subject must name a plan answer of this project's v7 plan Question");
  return { subject: exact, question: question!, draft: draft! };
}

/** The saved notes of one subject: the active notes of its single proven
 * session that holds any, in that session's proven order. Pure over the given
 * proven session heads; another subject or plan edition is never selected,
 * and several noted sessions of one subject are ambiguous (решение 4). */
export function selectSavedCheckpointsV2(sessions: readonly Revision<SynthesisSessionStateV3>[], subject: V7PlanSubject):
  { session: Revision<SynthesisSessionStateV3>; checkpoints: Ref[] } | null {
  const own = sessions.filter(session => sameSubject(session.value.binding.subject, subject)
    && activeSynthesisNotes(session.value.notes).length > 0);
  requireCondition(own.length <= 1, 'research_synthesis_ambiguous',
    'Several sessions of this subject hold notes; the saved-only choice needs one exact session');
  if (!own.length) return null;
  return { session: own[0]!, checkpoints: activeSynthesisNotes(own[0]!.value.notes).map(note => note.checkpoint) };
}

/** One saved v2 note of the subject at its exact version: the subject-bound
 * form, the same plan Question, its observations re-derived from their exact
 * sources and still current. A lost or replaced version refuses. */
function savedNoteV2(store: Store, project: string, question: Revision<Question>, subject: V7PlanSubject, ref: Ref) {
  const record = isRef(ref) ? store.get<Record<string, any>>(ref.id, ref.revision) : null;
  requireCondition(record?.kind === 'research-checkpoint' && canonical(reference(record)) === canonical(ref)
    && researchCheckpointV2Holds(record.value) && record.value.projectId === project
    && sameSubject(record.value.subject, subject) && record.value.question.id === question.id,
  'synthesis_evidence_stale', 'A saved note of this subject lost its exact version');
  proveCheckpointRecord(store, record);
  const evidence = new Evidence(store);
  requireCondition(record.value.observations.every((observation: any) => evidence.verify(observation)),
    'synthesis_evidence_stale', 'Saved note source versions must still be available');
  return record;
}

/** S4-01: the proven sessions of one subject and every note their paid
 * transitions wrote. Each v3 session of the subject is read by its exact
 * historical chain reader (every revision a lawful paid transition, its
 * checkpoint equal to the transition's), on saved bases only — not today's
 * plan and not today's active frontier: the append-only notes keep every
 * note ever written. A damaged session of unknown subject refuses. */
export function provenSubjectSessions(store: Store, subject: V7PlanSubject) {
  const sessions = store.list<SynthesisSessionStateV3>('synthesis-session')
    .filter(head => head.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX) && sameSubject(synthesisSessionSubject(head), subject))
    .map(head => readSynthesisSessionV3(store, reference(head)));
  const notes = new Set(sessions.flatMap(session => session.value.notes.map(note => canonical(note.checkpoint))));
  return { sessions, notes };
}

/** The chosen notes, in order, within one session's append-only notes — a
 * subsequence: never reordered, never mixed with another session's notes. */
export function notesInProvenOrder(sessionNotes: readonly Ref[], chosen: readonly Ref[]): boolean {
  let next = 0;
  for (const note of sessionNotes) if (next < chosen.length && canonical(note) === canonical(chosen[next])) next += 1;
  return chosen.length > 0 && next === chosen.length;
}

/** configure-v7-saved-synthesis: a new saved-only choice of one subject needs
 * its current accepted plan answer (the answered plan anchor is normal here);
 * the notes come from the subject's proven session. No eligible note is
 * saved_synthesis_missing; a moved session, Question, draft or note is a
 * guarded conflict that changes nothing. */
export function configureV7SavedSynthesis(store: Store, project: string, subject: unknown, expected: number): Revision<SavedSynthesisV2> {
  const basis = savedSubjectBasis(store, project, subject);
  planQuestionContract(store, basis.draft, basis.question, basis.subject);
  const { sessions } = provenSubjectSessions(store, basis.subject);
  const picked = selectSavedCheckpointsV2(sessions, basis.subject);
  requireCondition(picked, 'saved_synthesis_missing', 'No paid note of this exact subject exists');
  const notes = picked.checkpoints.map(ref => savedNoteV2(store, project, basis.question, basis.subject, ref));
  const projected = projectSavedSynthesisV2({ projectId: project, draft: reference(basis.draft), question: reference(basis.question),
    inputs: basis.draft.value.inputs, subject: basis.subject, checkpoints: notes.map(note => reference(note)) });
  return store.writeMany<SavedSynthesisV2>([{ id: projected.id, kind: 'saved-synthesis', expected, value: projected.value }],
    uniqueTransactionGuards([reference(basis.question), reference(basis.draft), basis.subject.planAnswer,
      ...basis.draft.value.inputs, reference(picked.session), ...notes.map(note => reference(note))]))[0]!;
}

/** The saved-only materials of one subject for its synthesis: null without a
 * choice; a choice of another basis, Question or subject is stale; every note
 * is read at its exact version. The v1 reader above never reads this form. */
export function savedV7SynthesisMaterials(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  subject: V7PlanSubject) {
  const exact = requirePlanSubject(subject, 'saved-synthesis');
  const saved = store.get<SavedSynthesisV2>(savedSynthesisV2Id(draft.value.projectId, exact));
  if (!saved) return null;
  requireCondition(saved.kind === 'saved-synthesis' && hashJson(saved.value) === saved.hash,
    'saved_synthesis_stale', 'The saved-only choice of this subject lost its exact form');
  savedSynthesisV2Shape(saved.value, saved.id);
  requireCondition(sameSubject(saved.value.subject, exact) && saved.value.projectId === draft.value.projectId
    && saved.value.draft.id === draft.id && canonical(saved.value.question) === canonical(reference(question))
    && canonical(saved.value.inputs) === canonical(draft.value.inputs),
  'saved_synthesis_stale', 'Recovery cannot use notes of a different subject, question or basis');
  // S4-01: the form of a note is not its origin — the chosen notes are notes
  // that paid transitions of ONE proven session of this subject wrote, in that
  // session's proven order (its append-only history, not today's frontier).
  requireCondition(provenSubjectSessions(store, exact).sessions
    .some(session => notesInProvenOrder(session.value.notes.map(note => note.checkpoint), saved.value.checkpoints)), 'saved_synthesis_stale',
    'The chosen notes are not the paid notes of one proven session of this subject in their proven order');
  return saved.value.checkpoints.map(ref => savedFindingMaterial(ref, savedNoteV2(store, draft.value.projectId, question, exact, ref).value));
}

/** DR3a3-S5 (круг 3): the one projection of a paid v2 note into its saved-only
 * material — the producer above and the v3 session's basis proof compare it. */
export function savedFindingMaterial(ref: Ref, note: Record<string, any>) {
  return { kind: 'saved-findings', value: { checkpoint: ref, proposal: note.proposal, unresolved: note.unresolved,
    evidence: (note.observations as any[]).map((o: any, index: number) => ({ source: o.source, selector: o.selector,
      original: { record: ref, pointer: `/observations/${index}` } })),
    instruction: 'Already paid proposed findings of this exact plan-question; reconcile all saved pieces. Page-pending notices are not new research questions.' } };
}

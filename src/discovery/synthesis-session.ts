import { synthesisControls } from './synthesis-controls.js';
import { compactConclusions } from './continuation-packet.js';
import { activeSynthesisNotes, consolidationNeeded, consolidationLimits, consolidationNotice, COMPACT_CHECKPOINT_INSTRUCTION } from './conclusion-consolidation.js';
import { contextWorkspace,
  foldContextEvent, recordContextPacket, type ContextWorkspace, type ContextLookup } from "./context-workspace.js";
import { requireCurrentPriorContext } from "./research-limits.js";
import type { Store, Revision, Write, TransactionGuard } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Environment } from "../runtime/environment.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import type { ReaderPilot } from "./reader-pilot.js";
import type { ResearchAction, ResearchRun, ResearchTurn } from "./research-model.js";
import { canonical, hashJson } from "../canonical.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";
import { researchCall } from "./research-protocol.js";
import { Evidence, projectSourceReading, sourceIsCurrent, SOURCE_READ_CONTRACT, SOURCE_READ_CONTRACT_V2,
  SOURCE_READ_CONTRACT_V3 } from "../evidence/evidence.js";
import { readReaderResultAt, readerResultCurrent } from "./reader.js";
import { recoveredResponseBoundary, recoverySessionWrites, markRecoveredSessionWritten,
  isResponseRecovery, prepareResearchConsumerIntent, readResearchConsumerIntent, findResearchConsumerIntent,
  listResearchConsumerIntents, prepareResearchConsumerApplication, resumeResearchConsumerExecution,
  refuseResearchConsumerIntent, captureResearchConsumerRetryPermits, projectPaidSynthesisTransition,
  readResearchConsumerExecution, readResearchConsumerTurn, readContextIdentityAt, subjectContextRecordHolds,
  type ResearchConsumerIntent, type ResearchConsumerIntentInput } from './response-recovery.js';
import { turnAction, contextReadIdentity, projectSynthesisTransition, projectContextRecoveryTransition, SYNTHESIS_TRANSITION_REFUSAL_CODES,
  isReservationOnlySessionStep, synthesisReservationConsumed,
  SYNTHESIS_SESSION_CONTRACT, CONTEXT_RECOVERY_SUPERSEDE_REASON, exactContextLookup, readerDraftEquivalent,
  projectResearchContextSelection, exactObservation,
  SYNTHESIS_SESSION_CONTRACT_V3, SYNTHESIS_SESSION_V2_PREFIX, SYNTHESIS_SESSION_V3_PREFIX, synthesisSessionV3Address,
  projectSynthesisSessionV3Initial, synthesisSessionSubject, synthesisStepSubject, requirePlanSubject,
  type SynthesisSessionState, type SynthesisSessionStateV3, type SynthesisSessionDelivery, type SynthesisTransition } from './research-consumer-transition.js';
import { isResearchPreview } from './research-preview.js';
import { planSubjectOf, sameSubject, type V7PlanSubject } from './v7-managed-attempt.js';
import { provePlanQuestions } from './v7-plan-questions.js';
import { planQuestionContract } from './continuation-packet.js';
import { provenSubjectSessions, savedFindingMaterial } from './saved-synthesis.js';

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function basis(draft: Revision<DiscoveryDraft>, question: Revision<Question>, context: Record<string, any>) {
  // New selections set the order, but do not replace the paid investigation.
  // One question can need a prior reader result again after a rejected answer.
  const seen = new Set<string>();
  const materials = (context.savedMaterials ?? [...(context.workingSelections ?? []),
    ...(context.readings ?? []).map((value: any) => ({ kind: "reader", value }))]).filter((selection: any) => {
    const key = selection.kind === "reader" && isRef(selection.value?.ref)
      ? canonical(["reader", selection.value.ref]) : canonical([selection.kind, selection.value]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { materials,
    v2Id: v2TaskAddress(draft, question, materials, context.previousProposal ?? null, context.previousProposalRef ?? null) };
}

/** The v2 task address (№1658 К3): project/draft/question membership, the exact
 * materials and previousProposal with its exact sources — never the
 * environment Ref or value and never a bare question revision bump. */
function v2TaskAddress(draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  materials: unknown, previousProposal: unknown, previousProposalRef: Ref | null): string {
  return `synthesis-session:v2:${hashJson([draft.id, { id: question.id, hash: question.hash }, draft.value.inputs,
    materials, previousProposal ?? null, previousProposalRef ?? null])}`;
}

/** An old need_research may describe data already read but evicted from the
 * request. Give those materials one resumable synthesis before buying another
 * reading plan. A completed session's need_research never triggers itself. */
export function pendingSynthesis(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  _environment: Revision<Environment>, context: Record<string, any>) {
  const { materials, v2Id } = basis(draft, question, context);
  if (!materials.length) return false;
  return !store.get<SynthesisSessionState>(v2Id)?.value.result;
}

const instruction = "\nmaterialPage may carry a finite JSON fragment of one large saved material; its cursor must advance before the next source. Synthesis uses finite pages of the materials already requested. synthesisPage gives the range actually supplied; omitted pages are not missing research. If synthesisPage.complete is false, return checkpoint with findings from this page, exact citations and remaining uncertainties; do not ask the reading planner to retrieve later pages. The engine saves your checkpoint and supplies the next page. An early answer is only an unassessed checkpoint. synthesisNotes contains earlier proposed answers and source citations, not authoritative facts; reconcile exceptions and contradictions across them. After the last page, compose the complete answer using these notes and supplied evidence. Only then request new research if essential information is still absent. All original materials remain at working.archive /body/synthesisMaterials. Never infer absence from an unshown page.";
const checkpointInstruction = " A context-only page without primary Source evidence may use citations:[] only to record substantive missing-primary-text questions in unresolved, not to establish findings. Do not invent or borrow an irrelevant citation. Keep progress counts out of unresolved; the engine records them. Final answers still require sufficient primary citations and evidence.";

/** Reading results retain their request/window metadata; answer observations
 * still take verifyReading's strict Observation branch. Outside results have
 * no selector, but must prove the same source and request as delivered reads.
 * Both name their exact source; a reader window's bare range does not. A
 * delivered value is verified source content, so the walk does not look inside
 * it for engine material. Returns the children still to walk. */
function verifyMaterialReading(store: Store, draft: Revision<DiscoveryDraft>, value: Record<string, any>): unknown[] {
  if (value.contract === 'research-search-capture/v2') {
    requireCondition(Array.isArray(value.sources), 'synthesis_evidence_stale', 'The structured search lost its Source catalogue');
    for (const fragment of value.sources) {
      const source = isRef(fragment.source) ? store.get<any>(fragment.source.id) : null;
      requireCondition(source?.kind === 'source' && canonical(reference(source)) === canonical(fragment.source)
        && source.value.projectId === draft.value.projectId && sourceIsCurrent(source.value),
      'synthesis_evidence_stale', 'A searched Source changed before synthesis continued');
      if (fragment.selector) requireCondition(canonical(new Evidence(store).observe(draft.value.projectId,
        fragment.source, fragment.selector).value) === canonical(fragment.excerpt),
      'synthesis_evidence_stale', 'A search fragment must retain its exact clean Source slice');
    }
    return [];
  }
  if (!isRef(value.source)
    || !(value.contract === SOURCE_READ_CONTRACT || value.contract === SOURCE_READ_CONTRACT_V2
      || value.contract === SOURCE_READ_CONTRACT_V3
      || (value.selector && Object.hasOwn(value, 'value'))))
    return Object.values(value);
  requireCondition(value.projectId === draft.value.projectId && new Evidence(store).verifyReading(value),
    'synthesis_evidence_stale', 'A material source changed; do not reuse stale synthesis notes');
  return Object.entries(value).flatMap(([key, child]) => key === 'value' ? [] : [child]);
}

/** Current admission for a new send or application: today's heads plus the
 * currency of every saved material. History itself never re-checks these. */
function verifySynthesisMaterials(store: Store, draft: Revision<DiscoveryDraft>, materials: unknown): void {
  const verify = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (isRef(value.record) && typeof value.pointer === 'string' && Object.hasOwn(value, 'value'))
      requireCurrentPriorContext(store, draft, value);
    const children = verifyMaterialReading(store, draft, value);
    if (isRef(value.ref)) {
      const reader = store.get<any>(value.ref.id, value.ref.revision);
      if (reader?.kind === "reader-result") {
        requireCondition(reader.hash === value.ref.hash, "synthesis_evidence_stale", "A reader bundle changed before synthesis continued");
        readReaderResultAt(store, draft.value.projectId, value.ref);
        requireCondition(readerResultCurrent(store, draft.value.projectId, reader.value), "synthesis_evidence_stale", "A reader bundle changed before synthesis continued");
      }
      if (reader?.kind === "source") {
        const current = store.get<any>(reader.id);
        requireCondition(current && current.revision === value.ref.revision && current.hash === value.ref.hash
          && sourceIsCurrent(current.value), "synthesis_evidence_stale", "A directly read source changed before synthesis continued");
      }
    }
    for (const child of children) verify(child);
  };
  verify(materials);
}

/** Capture every head read during admission as a transaction guard. */
function admissionRecording(store: Store): { store: Store; reads: Map<string, Ref> } {
  const reads = new Map<string, Ref>();
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => {
      const record = store.get(id, revision);
      if (record && revision === undefined) reads.set(id, reference(record));
      return record;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? (value as Function).bind(target) : value;
  } });
  return { store: view, reads };
}

/** The current admission of a new send/application for this session: binding
 * compatibility (value equality tolerates bare revision bumps), today's pilot,
 * and the live currency of saved materials. Guards cover every head read. */
function synthesisAdmission(store: Store, session: Revision<SynthesisSessionState>, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot>,
  intent: Revision<ResearchConsumerIntent> | null): TransactionGuard[] {
  const { store: view, reads } = admissionRecording(store);
  const binding = session.value.binding;
  requireCondition(environment.id === binding.environment.id && environment.value.projectId === session.value.projectId,
    'input_stale', 'The session environment identity changed');
  const boundEnvironment = view.get<Environment>(binding.environment.id, binding.environment.revision);
  requireCondition(boundEnvironment?.kind === 'environment'
    && canonical(boundEnvironment.value) === canonical(environment.value),
    'synthesis_dispatch_stale', 'The current environment value differs from the session binding');
  const boundQuestion = view.get<Question>(binding.question.id, binding.question.revision);
  requireCondition(boundQuestion?.kind === 'question' && canonical(boundQuestion.value) === canonical(question.value)
    && question.value.draftId === draft.id,
    'question_stale', 'The current question content differs from the session binding');
  if (canonical(reference(draft)) !== canonical(binding.draft))
    requireCondition(readerDraftEquivalent(view, binding.draft, reference(draft), binding.question),
      'reader_draft_stale', 'The current draft changed the synthesis task');
  if (intent) {
    requireCondition(canonical(dispatch) === canonical(intent.value.dispatch)
      && canonical(dispatch.implementer) === canonical(intent.value.role)
      && canonical(reference(pilot)) === canonical(intent.value.profile),
    'synthesis_dispatch_stale', 'The paid synthesis step cannot be rebound to another dispatch, role or profile');
  }
  verifySynthesisMaterials(view, draft, session.value.basis.materials);
  verifySynthesisMaterials(view, draft, session.value.workspace?.entries ?? []);
  return uniqueTransactionGuards([...reads.values(), reference(session), reference(draft), reference(question),
    reference(environment), reference(pilot), ...draft.value.inputs]);
}

function synthesisSessionInvalid(id: string, message: string): never {
  throw new EngineError('synthesis_session_invalid', `[${id}] ${message}`);
}

/** DR3a3-S5 (S5-01, решение 4): the admission of applying an already paid v3
 * step after its plan moved on — its own exact history only: the binding's
 * exact draft, plan Question and environment revisions. The binding need not
 * be today's head: the step's prepare-time guards are refreshed to today's
 * heads (as C61 refreshes mutable admission heads), so the session CAS and an
 * unchanged state between this read and the write keep it exact; the next
 * step still needs a current send admission. */
function historicalAdmission(store: Store, session: Revision<SynthesisSessionState>,
  intent: Revision<ResearchConsumerIntent> | null): TransactionGuard[] {
  const binding = session.value.binding;
  for (const source of [binding.draft, binding.question, binding.environment]) {
    const exact = store.get(source.id, source.revision);
    requireCondition(exact && canonical(reference(exact)) === canonical(source) && hashJson(exact.value) === exact.hash,
      'synthesis_session_invalid', `[${session.id}] The paid step lost an exact basis record: ${source.id}`);
  }
  // No intent (an operator pre-send admission) has no step guards; a guarded
  // record of the paid step that is missing is a typed refusal, never a dropped guard.
  const heads = (intent ? intent.value.guards : []).flatMap(guard => {
    if ('absent' in guard || guard.id === session.id) return [];
    const head = store.get(guard.id);
    if (!head) synthesisSessionInvalid(session.id, `A guarded basis record of the paid step is missing: ${guard.id}`);
    return [reference(head)];
  });
  return uniqueTransactionGuards([reference(session), ...heads]);
}

/** DR3a3-S5 (S5-02, круг 3; проход ОТСУТСТВИЕ): the one historical proof of
 * every v3 basis material, by its kind — a missing or damaged reference is
 * never a material without a subject. A material is lawful only in a form its
 * producers write, re-derived from its proven source:
 * - saved-findings: exactly the projection of a paid note of this subject
 *   (savedFindingMaterial over a note that passes subjectContextRecordHolds);
 * - reader: exactly the projection of its exact reader result of this project;
 * - context lookup: exactly the lookup of its exact record (a note or archive
 *   passes subjectContextRecordHolds), as the chain reader re-derives a recovery;
 * - context search: exactly the observation of the paid search turn whose completion
 *   produced its capture (the common turn reader proves that completion);
 * - context whole-file read: exactly its exact Source's read projection;
 * - context Source observation: exactly its pinned Source slice (exactObservation);
 * - context Source reading of a read contract: exactly that contract's projection of
 *   the pinned Source bytes (projectSourceReading).
 * Any other kind or form refuses. The writer applies it before any record, the
 * chain reader to the saved first record. */
function subjectMaterialsHold(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  subject: V7PlanSubject, materials: unknown): boolean {
  const projectId = draft.value.projectId;
  const exact = (ref: unknown): Revision<Record<string, any>> | null => {
    const record = isRef(ref) ? store.get<Record<string, any>>(ref.id, ref.revision) : null;
    return record && canonical(reference(record)) === canonical(ref) && hashJson(record.value) === record.hash ? record : null;
  };
  const holds = (material: unknown): boolean => {
    if (!object(material) || !object(material.value)) return false;
    const value = material.value;
    if (material.kind === 'saved-findings') {
      // S5-07: the named record must be a note (research-checkpoint) before its projection is read.
      const note = exact(value.checkpoint);
      return note?.kind === 'research-checkpoint' && subjectContextRecordHolds(store, projectId, draft.id, subject, note)
        && canonical(value) === canonical(savedFindingMaterial(value.checkpoint, note.value).value);
    }
    if (material.kind === 'reader') {
      // Its origin and era are the common reader's (readReaderResultAt: paid or outside producer, reader-result/v2 only).
      if (!isRef(value.ref)) return false;
      readReaderResultAt(store, projectId, value.ref);
      const result = exact(value.ref);
      return result?.kind === 'reader-result' && result.value.projectId === projectId
        && canonical(value) === canonical({ ref: reference(result), purpose: result.value.purpose,
          observations: result.value.observations, coverage: result.value.coverage, unresolved: result.value.unresolved });
    }
    if (material.kind !== 'context') return false;
    if (Object.hasOwn(value, 'record')) {
      // A lookup has the legacy form (no contract) or the bounded one; an unknown contract is no lookup.
      if (Object.hasOwn(value, 'contract') && value.contract !== 'research-context-read/v2') return false;
      const record = exact(value.record);
      if (!record || typeof value.pointer !== 'string' || !subjectContextRecordHolds(store, projectId, draft.id, subject, record))
        return false;
      const prove = (found: Revision<Record<string, any>>) => { readReaderResultAt(store, projectId, reference(found)); };
      const lookup = value.contract === 'research-context-read/v2'
        ? projectResearchContextSelection(exactContextLookup(store, draft, question, value.record, value.pointer, undefined, prove).value,
          value.record, value.pointer, value.requested, value.envelopeLimitChars ?? 0, 'bounded')
        : exactContextLookup(store, draft, question, value.record, value.pointer, object(value.page)
          ? { offset: value.page.offset, limit: value.page.end - value.page.offset,
            ...(value.page.encoding === 'canonical-json' ? { encoding: value.page.encoding } : {}) } : undefined, prove);
      return canonical(lookup) === canonical(value);
    }
    // S5-08: a search is exactly the observation of the paid search turn whose completion
    // produced this capture — the completion directly following the capture's pending turn,
    // proven by the common turn reader (readManagedSearchCompletion: the full
    // projectSearchTurnCompletion formula over historical Sources, the two known contracts),
    // in a run of this project and draft, on this plan Question and subject.
    if (Object.hasOwn(value, 'capture')) {
      const capture = exact(value.capture);
      const pending = capture?.kind === 'research-search-capture' && object(capture.value) ? capture.value.turn : null;
      if (!isRef(pending)) return false;
      const completed = store.get<Record<string, any>>(pending.id, pending.revision + 1);
      if (completed?.kind !== 'research-turn' || !object(completed.value) || completed.value.status !== 'completed'
        || completed.value.error !== null || canonical(completed.value.observation?.capture) !== canonical(value.capture)) return false;
      const proven = readResearchConsumerTurn(store, reference(completed));
      const run = typeof proven.value.run === 'string' ? store.get<ResearchRun>(proven.value.run) : null;
      return run?.kind === 'research-run' && run.value.projectId === projectId && run.value.draftId === draft.id
        && isRef(proven.value.question) && proven.value.question.id === question.id
        && sameSubject(planSubjectOf(proven.value), subject) && canonical(value) === canonical(proven.value.observation);
    }
    // S5-06: a whole-file read is exactly its exact Source's read projection.
    if (Object.hasOwn(value, 'ref')) {
      const read = exact(value.ref);
      if (read?.kind !== 'source' || read.value.projectId !== projectId || typeof read.value.content !== 'string') return false;
      const content: string = read.value.content;
      return canonical(value) === canonical({ ref: value.ref, length: content.length, excerpt: content.slice(0, 3000),
        truncated: content.length > 3000 });
    }
    const source = exact(value.source);
    if (source?.kind !== 'source' || source.value.projectId !== projectId || value.projectId !== projectId) return false;
    // A read names one of the three known read contracts; an unknown one is no reading (never "otherwise v1").
    if (Object.hasOwn(value, 'contract')
      && ![SOURCE_READ_CONTRACT, SOURCE_READ_CONTRACT_V2, SOURCE_READ_CONTRACT_V3].includes(value.contract)) return false;
    // A read of a contract is exactly that contract's projection of the pinned Source bytes.
    if ([SOURCE_READ_CONTRACT, SOURCE_READ_CONTRACT_V2, SOURCE_READ_CONTRACT_V3].includes(value.contract))
      return object(value.requested) && canonical(projectSourceReading(projectId, value.source, source.value as any,
        value.requested as { start: number; end: number }, value.contract)) === canonical(value);
    return object(value.selector) && canonical(exactObservation(store, projectId, value.source,
      value.selector as Parameters<typeof exactObservation>[3])) === canonical(value);
  };
  // An input the proof cannot read in its producer's form is no lawful material (a
  // typed refusal by the caller), never a crash: EngineError and TypeError alike.
  try { return Array.isArray(materials) && materials.every(holds); }
  catch (error) { if (error instanceof EngineError || error instanceof TypeError) return false; throw error; }
}

/** S5 class (решение 6; S5-05): the previous proposal a v3 session stands on is
 * its own subject's paid turn — the exact turn proven by the common turn reader,
 * of a research run of this project and draft, read by its own subject; an
 * unaddressed proposal is never adopted. */
function subjectProposalHolds(store: Store, projectId: string, draftId: string, subject: V7PlanSubject,
  previousProposal: unknown, previousProposalRef: unknown): boolean {
  if (previousProposalRef === null || previousProposalRef === undefined)
    return previousProposal === null || previousProposal === undefined;
  if (!isRef(previousProposalRef)) return false;
  try {
    const turn = readResearchConsumerTurn(store, previousProposalRef);
    const run = typeof turn.value.run === 'string' ? store.get<ResearchRun>(turn.value.run) : null;
    return run?.kind === 'research-run' && run.value.projectId === projectId && run.value.draftId === draftId
      && sameSubject(planSubjectOf(turn.value), subject) && canonical(turnAction(turn.value)) === canonical(previousProposal);
  } catch (error) { if (error instanceof EngineError) return false; throw error; }
}

/** DR3a3-S5 (S5-04): a reserved runner position is proven, not a bare number —
 * the research run of this project and draft whose saved history advanced its
 * counter by one step to exactly that position. */
function reservationReached(store: Store, projectId: string, draftId: string, delivery: unknown): boolean {
  if (!object(delivery) || typeof delivery.run !== 'string' || !Number.isSafeInteger(delivery.turn) || delivery.turn < 1) return false;
  const history = store.history<ResearchRun>(delivery.run);
  return history.length > 0 && history.every(step => step.kind === 'research-run' && object(step.value)
    && hashJson(step.value) === step.hash && step.value.projectId === projectId && step.value.draftId === draftId)
    && history.some((step, index) => index > 0 && step.value.turns === delivery.turn
      && history[index - 1]!.value.turns === delivery.turn - 1);
}

/** The writer half of reservationReached: a v3 delivery is written only with
 * the caller's own one-step reservation of exactly that position of this run
 * (the same transaction), or on a position the run's history already reached. */
function requireReservation(store: Store, projectId: string, draftId: string, delivery: SynthesisSessionDelivery,
  reserve: SynthesisSessionOptions['reserve']): void {
  if (!reserve) {
    requireCondition(reservationReached(store, projectId, draftId, delivery), 'synthesis_session_invalid',
      'A v3 delivery names no proven reservation of its research run');
    return;
  }
  const run = store.get<ResearchRun>(delivery.run);
  const next = reserve.write.value as ResearchRun;
  requireCondition(reserve.write.id === delivery.run && reserve.write.kind === 'research-run' && object(next)
    && next.projectId === projectId && next.draftId === draftId && next.turns === delivery.turn
    && run?.kind === 'research-run' && run.revision === reserve.write.expected && run.value.turns === delivery.turn - 1
    && run.value.projectId === projectId && run.value.draftId === draftId,
  'synthesis_session_invalid', 'A v3 delivery needs the one-step reservation of exactly its position in its research run');
}

/** Follow the saved split queue back to the child admitted by read_plan.
 * Each intermediate split must name the next child's exact first revision. */
function plannedQueueOrigin(store: Store, child: Revision<ResearchTurn>, parent: Revision<ResearchTurn>,
  run: string): Revision<ResearchTurn> {
  let current = child;
  const seen = new Set<string>();
  while (isRef(current.value.splitFrom)) {
    if (seen.has(current.id)) synthesisSessionInvalid(current.id, 'The planned split queue contains a cycle');
    seen.add(current.id);
    const sourceRef = current.value.splitFrom;
    const source = store.get<ResearchTurn>(sourceRef.id, sourceRef.revision);
    const completed = store.get<ResearchTurn>(sourceRef.id);
    const first = store.get<ResearchTurn>(current.id, 1);
    const parts = (completed?.value.observation as { splitInto?: unknown } | null)?.splitInto;
    requireCondition(source?.kind === 'research-turn' && canonical(reference(source)) === canonical(sourceRef)
      && completed?.kind === 'research-turn' && completed.value.status === 'completed' && !completed.value.error
      && Array.isArray(parts) && first?.kind === 'research-turn'
      && parts.some(ref => isRef(ref) && canonical(ref) === canonical(reference(first)))
      && source.value.run === run && current.value.run === run
      && canonical(source.value.question) === canonical(current.value.question)
      && canonical(source.value.plannedBy) === canonical(reference(parent))
      && canonical(current.value.plannedBy) === canonical(reference(parent)),
    'synthesis_session_invalid', 'The planned lookup lacks an exact split-queue parent');
    readResearchConsumerTurn(store, reference(completed));
    current = source;
  }
  return current;
}

/** Rebuild the runner prefix by historical projections only. Current material
 * heads decide admission of a NEW synthesis step, never the authenticity of
 * the initial workspace after a graph or Source has lawfully advanced. */
function runnerWorkspaceAt(store: Store, delivery: SynthesisSessionDelivery,
  question: Revision<Question>, bindingDraft: Ref, subject: V7PlanSubject | null = null): ContextWorkspace {
  const run = store.get<ResearchRun>(delivery.run, 1);
  requireCondition(run?.kind === 'research-run' && hashJson(run.value) === run.hash
    && run.value.projectId === question.value.projectId && run.value.draftId === question.value.draftId,
    'synthesis_session_invalid', 'The inherited context has no exact runner origin');
  const turns = store.list<ResearchTurn>('research-turn')
    .filter(turn => turn.value.run === delivery.run && turn.value.number < delivery.turn)
    .sort((a, b) => a.value.number - b.value.number)
    .map(turn => readResearchConsumerTurn(store, reference(turn)) as Revision<ResearchTurn>);
  requireCondition(turns.length === delivery.turn - 1
    && turns.every((turn, index) => turn.value.number === index + 1),
    'synthesis_session_invalid', 'The inherited context lost its complete exact turn prefix');
  let workspace: ContextWorkspace = { entries: [], sinceProgress: 0 };
  for (const turn of turns) {
    if (!isRef(turn.value.question)
      || canonical(turn.value.question) !== canonical(reference(question))
      || turn.value.status !== 'completed' || turn.value.error) continue;
    // DR3a3-S1 (решение 6): a v3 session inherits only its own subject's
    // turns; one physical Question at another plan-question is not its history.
    if (subject && !sameSubject(planSubjectOf(turn.value), subject)) continue;
    const origin = (turn.value as ResearchTurn & { consumerIntent?: unknown }).consumerIntent;
    requireCondition(turn.value.plannedBy === undefined || isRef(turn.value.plannedBy),
      'synthesis_session_invalid', 'A planned lookup needs its exact parent Ref');
    const parent = isRef(turn.value.plannedBy)
      ? store.get<ResearchTurn>(turn.value.plannedBy.id, turn.value.plannedBy.revision) : null;
    if (isRef(turn.value.plannedBy)) {
      requireCondition(parent && canonical(reference(parent)) === canonical(turn.value.plannedBy)
        && parent.value.run === delivery.run && parent.value.number < turn.value.number,
        'synthesis_session_invalid', 'A planned lookup lost its exact paid queue');
      const queued = plannedQueueOrigin(store, turn, parent!, delivery.run);
      const firstChild = store.get<ResearchTurn>(queued.id, 1);
      const completed = store.history<ResearchTurn>(parent!.id).find(step => {
        const children = (step.value.observation as { children?: unknown } | null)?.children;
        return step.value.status === 'completed' && Array.isArray(children) && firstChild
          && children.some((child: unknown) => isRef(child) && child.id === queued.id
            && child.revision === 1 && canonical(child) === canonical(reference(firstChild)));
      });
      // S5-03: a v7 turn is read by its own saved subject (turnAction); a field turn as before.
      const parentAction = completed && turnAction(completed.value);
      requireCondition(completed?.value.status === 'completed' && parentAction?.action === 'read_plan'
        && firstChild,
        'synthesis_session_invalid', 'The planned lookup is not a child of its exact completed plan');
      readResearchConsumerTurn(store, reference(completed!));
    }
    const parentOrigin = (parent?.value as ResearchTurn & { consumerIntent?: unknown } | undefined)?.consumerIntent;
    const intent = isRef(origin) ? readResearchConsumerIntent(store, origin)
      : isRef(parentOrigin) ? readResearchConsumerIntent(store, parentOrigin) : null;
    let packet: Record<string, any> | null = null;
    if (isRef(origin) && intent && ['analyst', 'reading-planner'].includes(intent.value.kind)) {
      const paid = readResearchConsumerExecution(store, question.value.projectId, origin);
      if (paid.kind === 'response' && Array.isArray(paid.subject.contextWorkspace)) packet = paid.subject;
    }
    requireCondition(packet === null || packet.working?.deliveryContract === 'research-delivery/v1',
      'synthesis_session_invalid', 'A paid analyst or planner packet names its research-delivery/v1 contract');
    if (packet !== null) workspace = recordContextPacket(workspace, packet);
    const action = turnAction(turn.value);
    if (action.action !== 'read_context') {
      workspace = foldContextEvent(workspace, action.action);
      continue;
    }
    // A divided queue entry records its children, not a delivered lookup.
    if (turn.value.observation && typeof turn.value.observation === 'object'
      && 'splitInto' in turn.value.observation) continue;
    const draftRef = intent?.value.draft ?? bindingDraft;
    const draft = store.get<DiscoveryDraft>(draftRef.id, draftRef.revision);
    requireCondition(draft?.kind === 'discovery-draft' && canonical(reference(draft)) === canonical(draftRef)
      && isRef(turn.value.question),
      'synthesis_session_invalid', 'The planned lookup lost its exact draft or question');
    const checked = readContextIdentityAt(store, question.value.projectId, draft!, turn.value.question!,
      action, turn.value.observation);
    contextReadIdentity(checked);
    workspace = foldContextEvent(workspace, action.action, turn.value.observation as ContextLookup);
  }
  return workspace;
}

function synthesisSessionShape(value: unknown, id: string): asserts value is SynthesisSessionState {
  // DR3a3-S1: the era is the address prefix; v3 adds only its mandatory
  // subject and its own address formula to the common v2 conditions.
  const v3 = id.startsWith(SYNTHESIS_SESSION_V3_PREFIX);
  if (!object(value) || value.contract !== (v3 ? SYNTHESIS_SESSION_CONTRACT_V3 : SYNTHESIS_SESSION_CONTRACT)
    || typeof value.projectId !== 'string' || !value.projectId
    || !Number.isSafeInteger(value.offset) || value.offset < 0
    || !(value.materialOffset === undefined || Number.isSafeInteger(value.materialOffset) && (value.materialOffset as number) >= 0)
    || !object(value.binding) || !isRef(value.binding.draft) || !isRef(value.binding.question) || !isRef(value.binding.environment)
    || !Array.isArray(value.binding.inputs) || !value.binding.inputs.every(isRef)
    || !object(value.basis) || !Array.isArray(value.basis.materials)
    || !Object.hasOwn(value.basis, 'previousProposal')
    || !(value.basis.previousProposalRef === null || isRef(value.basis.previousProposalRef))
    || !Array.isArray(value.notes)
    || !(value.notices === undefined || Array.isArray(value.notices))
    || !(value.finalization === undefined || object(value.finalization)
      && Number.isSafeInteger(value.finalization.lookups) && value.finalization.lookups >= 0)
    || !(value.result === null || object(value.result))
    || !(value.pause === undefined || value.pause === null || object(value.pause))
    || !(value.delivery === undefined || value.delivery === null || object(value.delivery)
      && typeof value.delivery.run === 'string' && Number.isSafeInteger(value.delivery.turn))
    || !(value.delivered === undefined || value.delivered === null || isRef(value.delivered))
    || !(value.blockedCode === undefined || typeof value.blockedCode === 'string')
    || !(value.recoveries === undefined || Array.isArray(value.recoveries))
    || !(value.contextCorrection === undefined || value.contextCorrection === null
      || object(value.contextCorrection) && value.contextCorrection.code === 'research_context_incomplete'
        && isRef(value.contextCorrection.record) && typeof value.contextCorrection.pointer === 'string'
        && ['items', 'utf16'].includes(value.contextCorrection.unit)
        && Number.isSafeInteger(value.contextCorrection.total) && value.contextCorrection.total > 0
        && Number.isSafeInteger(value.contextCorrection.next) && value.contextCorrection.next >= 0
        && Array.isArray(value.contextCorrection.ranges)))
    synthesisSessionInvalid(id, 'The saved synthesis session lost its producer contract');
  const subject = synthesisSessionSubject({ id, value });
  const address = subject
    ? synthesisSessionV3Address({ projectId: value.projectId, draft: value.binding.draft, question: value.binding.question,
      inputs: value.binding.inputs, subject, materials: value.basis.materials,
      previousProposal: value.basis.previousProposal, previousProposalRef: value.basis.previousProposalRef })
    : `synthesis-session:v2:${hashJson([value.binding.draft.id, { id: value.binding.question.id, hash: value.binding.question.hash },
      value.binding.inputs, value.basis.materials, value.basis.previousProposal, value.basis.previousProposalRef])}`;
  if (id !== address)
    synthesisSessionInvalid(id, 'The session address does not match its saved producer basis');
}

/** DR3a3-S1: the subject of a session, proven on exact saved records only
 * (an old plan need not be current today): none for v2; for v3 the plan
 * answer at its exact revision, the bound Question is the draft's plan anchor
 * answered by exactly that answer, and the plan-question id belongs to that
 * accepted edition. Reads only the exact records the binding names; writes
 * nothing. The exact session reader applies it to the saved head. */
export function proveSynthesisSessionSubject(store: Store, session: { id: string; value: unknown }): V7PlanSubject | null {
  const subject = synthesisSessionSubject(session);
  if (!subject) return null;
  const refuse = (message: string): never => {
    throw new EngineError('research_plan_subject_invalid', `[${session.id}] ${message}`, { reason: 'subject' });
  };
  const value = session.value as SynthesisSessionState;
  const answer = store.get(subject.planAnswer.id, subject.planAnswer.revision);
  if (!answer || canonical(reference(answer)) !== canonical(subject.planAnswer) || hashJson(answer.value) !== answer.hash)
    refuse('The exact plan answer of the session subject is missing or changed');
  const binding = value.binding;
  const draft = isRef(binding?.draft) ? store.get<DiscoveryDraft>(binding.draft.id, binding.draft.revision) : null;
  const question = isRef(binding?.question) ? store.get<Question>(binding.question.id, binding.question.revision) : null;
  if (!draft || draft.kind !== 'discovery-draft' || canonical(reference(draft)) !== canonical(binding.draft)
    || !question || question.kind !== 'question' || canonical(reference(question)) !== canonical(binding.question)
    || !object(question.value) || question.value.spec?.field !== 'plan'
    || question.value.draftId !== draft.id || question.value.projectId !== value.projectId
    || canonical(question.value.answer ?? null) !== canonical(subject.planAnswer))
    refuse('The session plan anchor is not the plan Question answered by its subject plan answer');
  let known = false;
  try {
    known = provePlanQuestions(store, draft!, subject.planAnswer)
      .some(item => item.planQuestionId === subject.planQuestionId);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'plan_questions_invalid')
      refuse(`The subject plan answer has no accepted plan of this draft: ${error.message}`);
    throw error;
  }
  if (!known) refuse('The subject plan-question is not in its accepted plan edition');
  return subject;
}

/** The historical reader: proves the whole session chain on exact saved
 * bases — the initial cursor, every paid application (re-derived by the same
 * transition the producer used), one-time delivery marks and operator context
 * recoveries. No current heads participate. */
export function readSynthesisSession(store: Store, ref: Ref): Revision<SynthesisSessionState> {
  return readSynthesisSessionChain(store, ref, SYNTHESIS_SESSION_V2_PREFIX);
}

/** DR3a3-S1: the exact reader of a v3 session — the same historical chain
 * proof on saved bases, plus its proven subject: every step intent of the
 * session names that subject, and the inherited runner context holds only
 * turns of that subject. A v2 Ref is not a v3 session. */
export function readSynthesisSessionV3(store: Store, ref: Ref): Revision<SynthesisSessionStateV3> {
  return readSynthesisSessionChain(store, ref, SYNTHESIS_SESSION_V3_PREFIX) as unknown as Revision<SynthesisSessionStateV3>;
}

function readSynthesisSessionChain(store: Store, ref: Ref, era: string): Revision<SynthesisSessionState> {
  if (!store || typeof store.get !== 'function' || !isRef(ref))
    synthesisSessionInvalid('synthesis-session', 'An exact saved session is required');
  const head = store.get<SynthesisSessionState>(ref.id, ref.revision);
  if (!head || head.kind !== 'synthesis-session' || !head.id.startsWith(era)
    || canonical(reference(head)) !== canonical(ref) || hashJson(head.value) !== head.hash)
    synthesisSessionInvalid(ref.id, 'The exact synthesis session is missing or changed');
  synthesisSessionShape(head.value, head.id);
  for (const source of [head.value.binding.draft, head.value.binding.question, head.value.binding.environment,
    ...head.value.binding.inputs]) {
    const exact = store.get(source.id, source.revision);
    if (!exact || canonical(reference(exact)) !== canonical(source) || hashJson(exact.value) !== exact.hash)
      synthesisSessionInvalid(head.id, `An exact session binding source is missing: ${source.id}`);
  }
  const subject = proveSynthesisSessionSubject(store, head);
  const intents = listResearchConsumerIntents(store, head.value.projectId, head.value.binding.draft.id)
    .filter(intent => ['synthesis', 'consolidation'].includes(intent.value.kind) && intent.value.owner.id === head.id);
  // Session → intent: a step of this session names exactly the session's
  // subject (none for v2); another subject never becomes this session's step.
  for (const intent of intents) synthesisStepSubject(intent.value, head);
  const byOutput = new Map<number, Revision<ResearchConsumerIntent>>();
  for (const intent of intents) {
    if (intent.value.state !== 'applied' || !intent.value.outputs) continue;
    for (const output of intent.value.outputs) {
      if (output.id !== head.id) continue;
      if (byOutput.has(output.revision)) synthesisSessionInvalid(head.id, 'Two paid steps claim the same session revision');
      byOutput.set(output.revision, intent);
    }
  }
  const initial = store.get<SynthesisSessionState>(head.id, 1);
  if (!initial || initial.revision !== 1 || initial.kind !== head.kind || hashJson(initial.value) !== initial.hash)
    synthesisSessionInvalid(head.id, 'The initial session revision is missing');
  synthesisSessionShape(initial.value, head.id);
  // S5-02/04: a v3 basis is proven by the writer's own predicates — material
  // and previous proposal of its subject, a proven runner reservation.
  if (subject) {
    const bound = { draft: store.get<DiscoveryDraft>(initial.value.binding.draft.id, initial.value.binding.draft.revision)!,
      question: store.get<Question>(initial.value.binding.question.id, initial.value.binding.question.revision)! };
    if (!subjectMaterialsHold(store, bound.draft, bound.question, subject, initial.value.basis.materials)
      || !subjectProposalHolds(store, initial.value.projectId, initial.value.binding.draft.id, subject,
        initial.value.basis.previousProposal, initial.value.basis.previousProposalRef))
      synthesisSessionInvalid(head.id, 'The v3 basis names material of another subject or an unproven previous proposal');
    if (initial.value.delivery != null
      && !reservationReached(store, initial.value.projectId, initial.value.binding.draft.id, initial.value.delivery))
      synthesisSessionInvalid(head.id, 'The v3 runner position is not a proven reservation of its research run');
  }
  // A v3 first record is re-derived by the producer's own projector.
  const expectedInitial: Record<string, any> = subject
    ? projectSynthesisSessionV3Initial({ projectId: initial.value.projectId,
      binding: initial.value.binding as SynthesisSessionStateV3['binding'], basis: initial.value.basis,
      delivery: initial.value.delivery ?? null }).value
    : { contract: SYNTHESIS_SESSION_CONTRACT,
      projectId: initial.value.projectId, offset: 0, notes: [], result: null,
      basis: initial.value.basis, binding: initial.value.binding,
      // The runner's reserved position is part of the first record (№1658 К2).
      ...(initial.value.delivery != null ? { delivery: initial.value.delivery } : {}) };
  if (initial.value.workspace !== undefined) {
    if (!initial.value.delivery) synthesisSessionInvalid(head.id, 'A direct session cannot inherit a runner context');
    const question = store.get<Question>(initial.value.binding.question.id, initial.value.binding.question.revision);
    if (!question || canonical(reference(question)) !== canonical(initial.value.binding.question)
      || canonical(initial.value.workspace) !== canonical(runnerWorkspaceAt(store, initial.value.delivery,
        question, initial.value.binding.draft, subject)))
      synthesisSessionInvalid(head.id, 'The initial context differs from the exact completed runner prefix');
    expectedInitial.workspace = initial.value.workspace;
  }
  if (canonical(initial.value) !== canonical(expectedInitial))
    synthesisSessionInvalid(head.id, 'The initial session is not the declared initial cursor');
  const bindingDraft = store.get<DiscoveryDraft>(head.value.binding.draft.id, head.value.binding.draft.revision)!;
  const bindingQuestion = store.get<Question>(head.value.binding.question.id, head.value.binding.question.revision)!;
  let before = initial;
  for (let revision = 2; revision <= head.revision; revision += 1) {
    const step = store.get<SynthesisSessionState>(head.id, revision);
    if (!step || step.revision !== revision || step.kind !== head.kind || hashJson(step.value) !== step.hash)
      synthesisSessionInvalid(head.id, 'A saved session revision is missing or changed');
    synthesisSessionShape(step.value, head.id);
    const intent = byOutput.get(revision);
    if (intent) {
      // The owner may precede the produced revision by reservation-only steps
      // (№1658 К2): walk the exact chain back through them, never further.
      let predecessor = before;
      for (;;) {
        if (canonical(intent.value.owner) === canonical(reference(predecessor))) break;
        const prior = predecessor.revision > 1
          ? store.get<SynthesisSessionState>(head.id, predecessor.revision - 1) : null;
        if (prior && predecessor.revision - 1 >= intent.value.owner.revision
          && isReservationOnlySessionStep(predecessor.value, prior.value)) predecessor = prior;
        else synthesisSessionInvalid(head.id, 'A paid step does not follow its exact session predecessor');
      }
      const transition = projectPaidSynthesisTransition(store, intent);
      if (canonical(transition.session) !== canonical(step.value))
        synthesisSessionInvalid(head.id, 'The saved session revision differs from the exact paid transition');
      if (transition.checkpoint) {
        const record = store.get(transition.checkpoint.id, 1);
        if (!record || record.kind !== 'research-checkpoint' || hashJson(record.value) !== record.hash
          || canonical(record.value) !== canonical(transition.checkpoint.value))
          synthesisSessionInvalid(head.id, 'The saved checkpoint differs from the exact paid transition');
      }
    } else if (isReservationOnlySessionStep(step.value, before.value)) {
      // A reservation revision (№1658 К2): the next position of the same task is
      // reserved before its intent — lawful only when the previous reservation
      // was consumed by its delivery mark or never existed; nothing else moves.
      if (subject && !reservationReached(store, head.value.projectId, bindingDraft.id, step.value.delivery))
        synthesisSessionInvalid(head.id, 'A v3 reservation is not a proven position of its research run');
    } else if (isRef(step.value.delivered) && step.value.delivered !== null) {
      const outcome = before.value.result ?? before.value.pause ?? null;
      const turn = store.get<ResearchTurnView>(step.value.delivered.id, step.value.delivered.revision);
      if (!outcome || before.value.delivered != null
        || canonical({ ...before.value, delivered: step.value.delivered }) !== canonical(step.value)
        || !turn || turn.kind !== 'research-turn' || hashJson(turn.value) !== turn.hash
        || canonical(reference(turn)) !== canonical(step.value.delivered)
        || canonical(turn.value.action) !== canonical(outcome)
        || (before.value.delivery
          && (turn.value.run !== before.value.delivery.run || turn.value.number !== before.value.delivery.turn)))
        synthesisSessionInvalid(head.id, 'A delivery mark does not bind the exact outcome turn');
    } else if (Array.isArray(step.value.recoveries) && step.value.recoveries.length === (before.value.recoveries?.length ?? 0) + 1) {
      const recovery = step.value.recoveries.at(-1) as Record<string, any>;
      let valid = object(recovery) && recovery.origin === 'operator'
        && canonical(recovery.session) === canonical(reference(before))
        && object(recovery.selector) && isRef(recovery.selector.record) && typeof recovery.selector.pointer === 'string';
      if (valid) {
        try {
          const prove = (record: Revision<Record<string, any>>) => {
            readReaderResultAt(store, head.value.projectId, reference(record));
          };
          const savedResult = step.value.workspace?.entries.at(-1)?.result as Record<string, any> | undefined;
          const result = savedResult?.contract === 'research-context-read/v2'
            ? projectResearchContextSelection(
              exactContextLookup(store, bindingDraft, bindingQuestion,
                recovery.selector.record, recovery.selector.pointer, undefined, prove).value,
              recovery.selector.record, recovery.selector.pointer, recovery.selector.page,
              savedResult.envelopeLimitChars, 'bounded')
            : exactContextLookup(store, bindingDraft, bindingQuestion,
              recovery.selector.record, recovery.selector.pointer, recovery.selector.page, prove);
          const blocked = typeof before.value.workspace?.blocked === 'string' ? before.value.workspace.blocked : null;
          const reason = blocked ?? CONTEXT_RECOVERY_SUPERSEDE_REASON;
          if (blocked === null)
            requireCondition(intents.some(intent => intent.value.state === 'prepared'
              && intent.value.owner.revision === before.revision),
              'context_session_not_blocked', 'A supersede recovery needs the merely-prepared step of its head');
          const transition = projectContextRecoveryTransition({ before: before.value,
            beforeRef: reference(before), selector: recovery.selector, result, reason });
          // DR3a3-S4→S5: a v3 recovery names only its subject's own lawful
          // material — the writer's predicate, and a note's paid origin.
          const named = store.get<Record<string, any>>(recovery.selector.record.id, recovery.selector.record.revision);
          if (subject) requireCondition(named && subjectContextRecordHolds(store, head.value.projectId, bindingDraft.id,
            subject, named), 'context_reference_foreign', 'The recovered v3 material is not its subject\'s own');
          valid = recovery.reason === reason && recovery.key === transition.key
            && canonical(transition.session) === canonical(step.value)
            && canonical(before.value.recoveries ?? []) === canonical(step.value.recoveries.slice(0, -1));
        } catch { valid = false; }
      }
      if (!valid) synthesisSessionInvalid(head.id, 'An operator context recovery does not derive from its exact predecessor');
    } else {
      synthesisSessionInvalid(head.id, 'A late session revision has no lawful transition');
    }
    before = step;
  }
  // The consolidation notice of every active compact note is part of the same
  // atomic application; a missing notice is an integrity failure, not a task.
  for (const note of activeSynthesisNotes(head.value.notes)) {
    const notice = consolidationNotice(note);
    if (notice && !(head.value.notices ?? []).some(saved => canonical(saved) === canonical(notice)))
      synthesisSessionInvalid(head.id, 'A saved consolidation notice is missing');
  }
  return head;
}

interface ResearchTurnView { run: string; number: number; action: unknown; status: string }

function synthesisOutcomeOf(value: SynthesisSessionState): ResearchAction | null {
  if (value.result) return value.result;
  if (value.pause && value.delivered == null) return value.pause;
  return null;
}

export interface UnfinishedSynthesisOperation {
  session: Revision<SynthesisSessionState>; questionId: string;
  outcomePending: boolean; deliveryTurn: number | null;
  /** DR3a3-S5 (решение 4): the saved subject of a v3 operation — not only its Question id. */
  subject?: V7PlanSubject;
}

/** Resume-first lookup (№1499-2/3): before any new basis is computed, the
 * unfinished synthesis/consolidation operation of this draft's questions is
 * found by proven session binding — never by store listing order alone. */
export function findUnfinishedSynthesisSession(store: Store, projectId: string, draftId: string): UnfinishedSynthesisOperation | null {
  if (!store || typeof store.list !== 'function' || typeof projectId !== 'string' || !projectId
    || typeof draftId !== 'string' || !draftId)
    throw new EngineError('research_synthesis_ambiguous', 'Unfinished synthesis lookup needs its project and draft');
  const draft = store.get<DiscoveryDraft>(draftId);
  requireCondition(draft?.kind === 'discovery-draft' && draft.value.projectId === projectId,
    'research_synthesis_ambiguous', 'The synthesis draft is missing or foreign');
  const unfinished = store.list<SynthesisSessionState>('synthesis-session')
    .filter(record => record.id.startsWith('synthesis-session:v2:') && record.value && object(record.value)
      && record.value.projectId === projectId && object(record.value.binding)
      && record.value.binding.draft.id === draftId)
    .map(record => readSynthesisSession(store, reference(record)))
    .filter(session => {
      const value = session.value;
      if (value.result === null) return true;
      // A direct entry delivers its outcome by returning it; only a session
      // bound to a reserved runner position can have an undelivered outcome.
      return value.delivery != null && value.delivered == null;
    });
  if (!unfinished.length) return null;
  const order = (session: Revision<SynthesisSessionState>) => {
    const index = draft.value.questions.indexOf(session.value.binding.question.id);
    requireCondition(index >= 0, 'research_synthesis_ambiguous', 'The unfinished synthesis question left the draft');
    return index;
  };
  unfinished.sort((a, b) => order(a) - order(b));
  const first = unfinished[0]!;
  if (unfinished.length > 1 && order(unfinished[1]!) === order(first))
    throw new EngineError('research_synthesis_ambiguous',
      `[${first.id}] Several unfinished synthesis operations share this task without a proven order`);
  return unfinishedOperation(store, projectId, draftId, first);
}

/** The pending state of one proven unfinished session: its undelivered
 * outcome and the reserved position its live step carries. Shared by the v2
 * and v3 lookups. */
function unfinishedOperation(store: Store, projectId: string, draftId: string,
  first: Revision<SynthesisSessionState>): UnfinishedSynthesisOperation {
  const value = first.value;
  const outcomePending = value.delivery != null && value.delivered == null
    && (value.result !== null || value.pause != null);
  // A position whose outcome was already delivered is consumed; a genuinely
  // next task gets a new position (№1555 X32). The reserved position rides the
  // step's cursor from its preparation through running and refused states —
  // «A ещё нет» after a received response is not a new logical action, so the
  // saved delivery of any live terminal-or-pending step of this head counts.
  let ownerRevision = first.revision;
  for (let revision = first.revision; revision > 1; revision -= 1) {
    const step = store.get<SynthesisSessionState>(first.id, revision);
    const prior = store.get<SynthesisSessionState>(first.id, revision - 1);
    if (step && prior && isReservationOnlySessionStep(step.value, prior.value)) ownerRevision = revision - 1;
    else break;
  }
  const pendingDelivery = listResearchConsumerIntents(store, projectId, draftId)
    .filter(intent => ['synthesis', 'consolidation'].includes(intent.value.kind)
      && intent.value.owner.id === first.id && intent.value.owner.revision >= ownerRevision
      && intent.value.owner.revision <= first.revision
      && ['prepared', 'running', 'refused'].includes(intent.value.state))
    .sort((a, b) => b.revision - a.revision)
    .map(intent => intent.value.cursor.delivery)
    .find((delivery): delivery is SynthesisSessionDelivery => object(delivery)
      && typeof delivery.run === 'string' && Number.isSafeInteger(delivery.turn));
  // Consumption is per-reservation (№1676): the old outcome's delivery mark is
  // the previous reservation's history; the current reservation is consumed
  // only when its own outcome is delivered into its own turn. The saved new
  // reservation is therefore found even before its intent exists.
  const activeDelivery = value.delivery != null && !synthesisReservationConsumed(value) ? value.delivery : null;
  const subject = synthesisSessionSubject(first);
  return { session: first, questionId: value.binding.question.id,
    outcomePending, deliveryTurn: activeDelivery?.turn ?? pendingDelivery?.turn ?? null, ...(subject ? { subject } : {}) };
}

/** DR3a3-S5 (решение 4): the unfinished v3 operation of one exact subject.
 * Every v3 session of the draft is read by its exact chain reader; only the
 * subject's own sessions count. Several unfinished ones are ordered only by
 * their proven reserved runner positions — never by Question, time or hash;
 * without such an order the lookup is research_synthesis_ambiguous. */
export function findUnfinishedSynthesisSessionV3(store: Store, projectId: string, draftId: string,
  subject: V7PlanSubject): UnfinishedSynthesisOperation | null {
  requireCondition(store && typeof store.list === 'function' && typeof projectId === 'string' && !!projectId
    && typeof draftId === 'string' && !!draftId, 'research_synthesis_ambiguous', 'Unfinished synthesis lookup needs its project and draft');
  const unfinished = store.list<SynthesisSessionState>('synthesis-session')
    .filter(record => record.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX) && object(record.value)
      && record.value.projectId === projectId && object(record.value.binding) && record.value.binding.draft?.id === draftId
      && sameSubject(synthesisSessionSubject(record), subject))
    .map(record => readSynthesisSessionV3(store, reference(record)) as unknown as Revision<SynthesisSessionState>)
    .filter(session => session.value.result === null || session.value.delivery != null && session.value.delivered == null);
  if (!unfinished.length) return null;
  if (unfinished.length > 1) {
    // S5-04: an order is proven only by reserved positions of one research run —
    // each a one-step reservation its history shows, still unoccupied by a turn;
    // bare numbers, other runs or missing runs are no order.
    const turns = store.list<ResearchTurn>('research-turn');
    const positions = unfinished.map(session => {
      const delivery = session.value.delivery;
      return object(delivery) && reservationReached(store, projectId, draftId, delivery)
        && !turns.some(turn => turn.value.run === delivery.run && turn.value.number === delivery.turn) ? delivery : null;
    });
    requireCondition(positions.every(Boolean) && new Set(positions.map(position => position!.run)).size === 1
      && new Set(positions.map(position => position!.turn)).size === positions.length,
      'research_synthesis_ambiguous', `[${unfinished[0]!.id}] Several unfinished sessions of this subject have no proven order`);
    unfinished.sort((a, b) => a.value.delivery!.turn - b.value.delivery!.turn);
  }
  return unfinishedOperation(store, projectId, draftId, unfinished[0]!);
}

/** The undelivered outcome of a finished-application session, for the runner's
 * one-time delivery into the reserved pending turn (№1499-38). */
export function synthesisOutcomeDelivery(store: Store, projectId: string, draftId: string):
  { session: Revision<SynthesisSessionState>; action: ResearchAction; turn: number | null } | null {
  const operation = findUnfinishedSynthesisSession(store, projectId, draftId);
  if (!operation || !operation.outcomePending) return null;
  return { session: operation.session, action: synthesisOutcomeOf(operation.session.value)!,
    turn: operation.deliveryTurn };
}

/** The delivered mark rides the same transaction as the pending turn. The
 * chain reader proves it against the exact outcome and reserved position. */
export function synthesisDeliveryMarks(session: Revision<SynthesisSessionState>, turnWrite: Write):
  { write: Write; guards: TransactionGuard[] } {
  const value = session.value;
  requireCondition(synthesisOutcomeOf(value) !== null && value.delivered == null,
    'synthesis_session_invalid', 'Only an undelivered synthesis outcome takes a delivery mark');
  const turnRef: Ref = { id: turnWrite.id, revision: turnWrite.expected + 1, hash: hashJson(turnWrite.value) };
  return { write: { id: session.id, kind: 'synthesis-session', expected: session.revision,
      value: { ...value, delivered: turnRef } },
    guards: [reference(session)] };
}

export interface SynthesisSessionOptions {
  /** Restore paid work without preparing or dispatching a new logical step. */
  restoreOnly?: boolean;
  retryPermits?: readonly Ref[];
  delivery?: SynthesisSessionDelivery | null;
  initialWorkspace?: ContextWorkspace;
  initialWorkspaceGuards?: readonly Ref[];
  /** The caller's own reservation record, written atomically with the session
   * revision that carries the reservation (first record or next reservation
   * after a delivered outcome) — one guarded transition, no window (№1658 К2). */
  reserve?: { write: Write; guards: TransactionGuard[] };
}

/** Current step key: one logical step per exact session head per variant. */
export function synthesisStepKey(head: Revision<SynthesisSessionState>): string {
  return `synthesis-step:${hashJson([head.id, reference(head)])}`;
}

export async function synthesisSession(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot>,
  context: Record<string, any>, prompt: string, signal?: AbortSignal,
  opts?: SynthesisSessionOptions): Promise<ResearchAction> {
  requireCondition(store && typeof store.get === 'function' && isRef(draft) && object(draft.value)
    && isRef(question) && object(question.value) && isRef(environment) && object(environment.value)
    && object(dispatch) && object(dispatch.implementer) && isRef(pilot) && object(pilot.value)
    && object(context) && typeof prompt === 'string'
    && question.value.draftId === draft.id && draft.value.projectId === question.value.projectId
    && environment.value.projectId === draft.value.projectId && pilot.value.projectId === draft.value.projectId,
    'synthesis_session_invalid', 'A synthesis session needs its exact draft, question, environment, pilot and context');
  // DR3a3-S5: a v7 plan-question synthesis is a v3 session of the context's
  // exact subject; new work needs that subject current (its accepted plan
  // edition). The v2 and address-less eras below are unchanged.
  if (Object.hasOwn(context, 'subject')) {
    const subject = requirePlanSubject(context.subject, 'synthesis-session');
    // S5-01 (решение 4): the entry stands on the caller's exact basis — a plan
    // Question revision answered by the subject's plan answer, current or
    // historical. Only a NEW send needs today's plan (requireCurrent in the
    // producer): a finished result returns and a paid step applies by its own history.
    planQuestionContract(store, draft, question, subject);
    // ОТСУТСТВИЕ (круг 3): every material list of a v3 basis is a list of material
    // objects; a missing or non-object item is a typed refusal, never a crash or a skip.
    requireCondition(['savedMaterials', 'workingSelections', 'readings'].every(field => context[field] === undefined
      || Array.isArray(context[field]) && context[field].every(object)), 'context_reference_foreign',
    'A v3 synthesis basis lists only material objects');
    const { materials } = basis(draft, question, context);
    // S5-02: the materials and previous proposal of a new basis are its subject's
    // own; an operator replay names its proven session and computes no basis.
    if (!(isResponseRecovery() && typeof context.synthesisSession === 'string')) {
      requireCondition(subjectMaterialsHold(store, draft, question, subject, materials),
        'context_reference_foreign', 'A v3 synthesis carries only material of its own plan subject');
      requireCondition(subjectProposalHolds(store, draft.value.projectId, draft.id, subject,
        context.previousProposal ?? null, context.previousProposalRef ?? null),
        'context_reference_foreign', 'A v3 synthesis stands only on a previous proposal of its own plan subject');
    }
    const taskAddress = synthesisSessionV3Address({ projectId: draft.value.projectId, draft: reference(draft),
      question: reference(question), inputs: draft.value.inputs, subject, materials,
      previousProposal: context.previousProposal ?? null, previousProposalRef: context.previousProposalRef ?? null });
    return synthesisSessionV2(store, draft, question, environment, dispatch, pilot, context, prompt, taskAddress, materials,
      signal, opts ?? {}, subject);
  }
  const { materials, v2Id } = basis(draft, question, context);
  // Every entry — runner, direct, preview, recovery — produces the v2 era
  // (№1499, возврат №1575-4).
  return synthesisSessionV2(store, draft, question, environment, dispatch, pilot, context, prompt, v2Id, materials, signal, opts ?? {});
}

/** The v2 producer: every entry — runner, direct, repeat, recovery — passes
 * the same deduction: proven history → current step state → one transaction
 * that writes exactly the deduction. */
async function synthesisSessionV2(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot>,
  context: Record<string, any>, prompt: string, taskAddress: string, basisMaterials: Record<string, any>[],
  signal: AbortSignal | undefined, opts: SynthesisSessionOptions, subject: V7PlanSubject | null = null): Promise<ResearchAction> {
  const projectId = draft.value.projectId;
  // DR3a3-S5: the era of this producer — v3 (subject) or v2 — fixes its address
  // space, unfinished lookup, first record, step cursor and exact reader.
  const eraPrefix = subject ? SYNTHESIS_SESSION_V3_PREFIX : 'synthesis-session:v2:';
  const readEra = (ref: Ref): Revision<SynthesisSessionState> => subject
    ? readSynthesisSessionV3(store, ref) as unknown as Revision<SynthesisSessionState> : readSynthesisSession(store, ref);
  // S5-01 (решение 4): today's plan admits only a NEW send of a v3 task — its
  // first record, a new reservation, a new step and the send of a prepared one.
  // A finished result, a received paid response and a pause stand on the
  // session's own exact history. v2 has no subject and keeps its admission.
  const subjectCurrent = (): boolean => {
    if (!subject) return true;
    const draftHead = store.get<DiscoveryDraft>(draft.id), questionHead = store.get<Question>(question.id);
    if (draftHead?.kind !== 'discovery-draft' || questionHead?.kind !== 'question'
      || canonical(reference(questionHead)) !== canonical(reference(question))) return false;
    try { planQuestionContract(store, draftHead, questionHead, subject); return true; }
    catch (error) { if (error instanceof EngineError) return false; throw error; }
  };
  const requireCurrent = () => {
    requireCondition(!opts.restoreOnly, 'research_restore_complete', 'Saved synthesis is restored; a new step needs explicit current admission');
    requireCondition(subjectCurrent(), 'research_plan_subject_invalid',
      'A new v3 synthesis step needs the current plan Question of its subject');
    if (subject) {
      const currentPilot = store.get<ReaderPilot>(pilot.id);
      requireCondition(currentPilot?.kind === 'reader-pilot' && currentPilot.value.active
        && canonical(reference(currentPilot)) === canonical(reference(pilot)),
      'reader_pilot_stale', 'A new v3 synthesis step requires the current active reader profile');
    }
  };
  // The application of a paid step: today's admission while its subject is
  // current; once the plan moved on, its exact saved history and the session CAS.
  const applicationAdmission = (head: Revision<SynthesisSessionState>, intent: Revision<ResearchConsumerIntent> | null) => {
    if (subject && !subjectCurrent()) return historicalAdmission(store, head, intent);
    const guards = synthesisAdmission(store, head, draft, question, environment, dispatch, pilot, intent);
    if (!subject || !intent) return guards;
    // The paid profile is immutable provenance, not a current send admission.
    // Preserve material currency, but CAS the application against today's
    // profile head; the next send still passes requireCurrent separately.
    const currentPilot = store.get<ReaderPilot>(pilot.id);
    requireCondition(currentPilot?.kind === 'reader-pilot' && currentPilot.value.projectId === projectId,
      'reader_pilot_invalid', 'The paid synthesis step lost its reader profile head');
    return uniqueTransactionGuards([...guards.filter(guard => guard.id !== pilot.id), reference(currentPilot)]);
  };
  const permits = JSON.parse(canonical(opts.retryPermits
    ?? captureResearchConsumerRetryPermits(store, projectId))) as Ref[];
  // Resume-first: an unfinished operation of this task is continued before any
  // new basis is computed (№1499-2); ambiguity is an addressed refusal (№1499-3).
  // An exact repeat of a FINISHED task returns its proven result before any
  // other unfinished operation of the question is considered (№1555 X45/X04).
  let sessionId: string;
  const recovering = isResponseRecovery();
  const named = recovering && typeof context.synthesisSession === 'string'
    && context.synthesisSession.startsWith(eraPrefix) ? context.synthesisSession : null;
  const operation = subject ? findUnfinishedSynthesisSessionV3(store, projectId, draft.id, subject)
    : findUnfinishedSynthesisSession(store, projectId, draft.id);
  const own = operation && operation.questionId === question.id ? operation : null;
  const exactHit = store.get<SynthesisSessionState>(taskAddress);
  const exactFinished = exactHit && exactHit.value.result !== null
    && (exactHit.value.delivered != null || exactHit.value.delivery == null);
  if (named) {
    requireCondition(!own || own.session.id === named, 'research_synthesis_ambiguous',
      'The recovery names one session while another unfinished operation owns this task');
    sessionId = named;
  } else if (exactFinished) sessionId = exactHit.id;
  else if (exactHit && !own) sessionId = exactHit.id;
  else if (own) sessionId = own.session.id;
  else sessionId = taskAddress;
  let previewSeed: Revision<SynthesisSessionState> | null = null;
  if (!store.get(sessionId)) {
    requireCondition(!recovering, 'response_recovery_session_stale', 'The selected recovery session is missing');
    // A new v3 task is new work of today's plan, on a proven reservation (S5-04).
    requireCurrent();
    if (subject && opts.delivery) requireReservation(store, projectId, draft.id, opts.delivery, opts.reserve);
    // S5-03: the writer derives the inherited prefix by the reader's own formula —
    // with the subject, so a v3 task inherits only its subject's turns.
    if (opts.delivery && opts.initialWorkspace
      && (opts.initialWorkspace.entries.length || opts.initialWorkspace.deliveryCoverage?.length))
      requireCondition(canonical(opts.initialWorkspace) === canonical(runnerWorkspaceAt(store, opts.delivery,
        question, reference(draft), subject)),
        'synthesis_session_invalid', 'The runner context changed before the synthesis session was created');
    const inherited = opts.delivery && opts.initialWorkspace
      && (opts.initialWorkspace.entries.length || opts.initialWorkspace.deliveryCoverage?.length) ? opts.initialWorkspace : undefined;
    // DR3a3-S5 (перенос S1→S5): the v3 first record is exactly the shared
    // projector's value at exactly its address, written atomically with the
    // caller's reservation — no intermediate session record.
    const projectedV3 = subject ? projectSynthesisSessionV3Initial({ projectId, binding: { draft: reference(draft),
      question: reference(question), environment: reference(environment), inputs: draft.value.inputs, subject },
      basis: { materials: basisMaterials, previousProposal: context.previousProposal ?? null,
        previousProposalRef: context.previousProposalRef ?? null },
      delivery: opts.delivery ?? null, ...(inherited ? { workspace: inherited } : {}) }) : null;
    requireCondition(!projectedV3 || projectedV3.id === sessionId, 'synthesis_session_invalid',
      'The v3 session address does not match its exact subject and basis');
    const initial: SynthesisSessionState = projectedV3 ? projectedV3.value as unknown as SynthesisSessionState : { contract: SYNTHESIS_SESSION_CONTRACT, projectId,
      offset: 0, notes: [], result: null,
      basis: { materials: basisMaterials, previousProposal: context.previousProposal ?? null,
        previousProposalRef: context.previousProposalRef ?? null },
      binding: { draft: reference(draft), question: reference(question), environment: reference(environment),
        inputs: draft.value.inputs },
      // The runner's reserved position and logical budget belong to the task
      // from its FIRST record — one guarded transition with the caller's
      // reservation write, never a separate intent-stage window (№1658 К2).
      ...(opts.delivery ? { delivery: opts.delivery } : {}),
      ...(opts.delivery && opts.initialWorkspace
        && (opts.initialWorkspace.entries.length || opts.initialWorkspace.deliveryCoverage?.length)
        ? { workspace: opts.initialWorkspace } : {}) };
    if (isResearchPreview()) {
      // Preview leaves no durable records of the new era (№1555 X29): the
      // fresh session seed stays in memory; the intent stays virtual.
      synthesisSessionShape(initial, sessionId);
      previewSeed = { id: sessionId, kind: 'synthesis-session', revision: 1, hash: hashJson(initial), value: initial };
    } else try {
      const writes: Write[] = [...(opts.reserve ? [opts.reserve.write] : []),
        { id: sessionId, kind: 'synthesis-session', expected: 0, value: initial }];
      store.writeMany<SynthesisSessionState>(writes,
        [...(opts.reserve?.guards ?? []), ...(opts.initialWorkspaceGuards ?? []),
          reference(draft), reference(question), reference(environment), ...draft.value.inputs]);
    } catch (error) {
      if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)
        || !store.get(sessionId)) throw error;
    }
  }

  const buildCallContext = (head: Revision<SynthesisSessionState>): Record<string, any> => {
    const current = head.value;
    const workspace = contextWorkspace(current.workspace);
    const final = current.offset === current.basis.materials.length;
    const controls = synthesisControls(final, workspace, current.finalization);
    return { ...context, dispatchMode: 'synthesis', synthesisMaterials: current.basis.materials,
      synthesisSession: sessionId, synthesisState: { offset: current.offset, materialOffset: current.materialOffset ?? 0 },
      synthesisNotes: current.notes, contextWorkspace: workspace.entries.map(entry => entry.result), focus: null,
      contextControls: controls, contextCheckpointedKeys: workspace.checkpointedKeys ?? [],
      ...(current.contextCorrection ? { contextCorrection: current.contextCorrection } : {}) };
  };

  const consolidate = async (head: Revision<SynthesisSessionState>, target = consolidationLimits(pilot.value).target,
    fullTarget?: number, allowTightening = false, packetDeficit = 0): Promise<void> => {
    const current = head.value;
    const active = activeSynthesisNotes(current.notes), regular = consolidationNeeded(current.notes, pilot.value, true);
    const candidate = active.length === 1 ? active[0] : undefined;
    const tightening = !regular && allowTightening && candidate?.consolidated?.format === 2 && !candidate.consolidated.tightenedFrom
      ? { from: candidate.checkpoint, currentItemsChars: JSON.stringify(compactConclusions(active).items).length,
        currentFullChars: JSON.stringify(compactConclusions(active)).length, targetChars: target, fullTargetChars: fullTarget!,
        packetDeficitChars: packetDeficit,
        deficitChars: Math.max(1, packetDeficit, JSON.stringify(compactConclusions(active).items).length - target,
          JSON.stringify(compactConclusions(active)).length - fullTarget!) } : undefined;
    requireCondition(regular || tightening, 'consolidation_capacity_exhausted',
      'The paid summary still does not fit after its one tightening; no further compaction is allowed without new findings');
    requireCondition(Number.isSafeInteger(target) && target > 0 && Number.isSafeInteger(fullTarget) && fullTarget! > 0,
      'research_context_capacity', 'Exact context and unresolved obligations leave no summary capacity inside the fixed limit');
    const goal = { targetChars: tightening ? target : Math.min(target, consolidationLimits(pilot.value).target),
      fullTargetChars: fullTarget!, format: 2 as const,
      ...(tightening ? { tightening } : {}) };
    const callContext = { ...buildCallContext(head), dispatchMode: 'consolidation', consolidation: goal };
    await prepareAndDrive(head, 'consolidation', callContext, '');
  };

  const prepareAndDrive = async (head: Revision<SynthesisSessionState>, kind: 'synthesis' | 'consolidation',
    callContext: Record<string, any>, stepPrompt: string): Promise<SynthesisTransition | null> => {
    const value = head.value;
    requireCurrent(); // a new step is new work of today's plan (S5-01)
    const admissionGuards = synthesisAdmission(store, head, draft, question, environment, dispatch, pilot, null);
    const material = value.basis.materials[value.offset];
    const cursor = { sessionId, offset: value.offset, materialOffset: value.materialOffset ?? 0,
      materialEncoding: value.offset < value.basis.materials.length && object(material) && Object.hasOwn(material, 'value')
        ? JSON.stringify(material.value) : null,
      // Intents take the reservation from the proven task state; a mismatched
      // recipient delivery of the entry never substitutes it (№1658 К2).
      context: callContext, prompt: stepPrompt, delivery: value.delivery ?? null,
      // A v3 step names exactly its session's subject (synthesisStepSubject).
      ...(subject ? { subject } : {}) };
    const input: ResearchConsumerIntentInput = { projectId, kind, key: synthesisStepKey(head),
      owner: reference(head), draft: reference(draft), question: reference(question), role: dispatch.implementer,
      dispatch, profile: reference(pilot), cursor, basis: [reference(head)],
      guards: uniqueTransactionGuards([...admissionGuards, ...draft.value.inputs]) };
    let intent: Revision<ResearchConsumerIntent>;
    try { intent = prepareResearchConsumerIntent(store, input, permits); }
    catch (error) {
      if (!(error instanceof EngineError) || !['input_stale', 'revision_conflict'].includes(error.code)) throw error;
      const competing = findResearchConsumerIntent(store, projectId, kind, input.key);
      requireCondition(competing && canonical(competing.value.cursor) === canonical(cursor)
        && canonical(competing.value.basis) === canonical(input.basis),
        'synthesis_intent_claim_conflict', 'A concurrent synthesis intent has a different saved basis');
      intent = competing;
    }
    return driveIntent(head, intent, admissionGuards);
  };

  const driveIntent = async (head: Revision<SynthesisSessionState>, intentInput: Revision<ResearchConsumerIntent>,
    preparedGuards: TransactionGuard[] | null): Promise<SynthesisTransition | null> => {
    let intent = intentInput;
    const cursor = intent.value.cursor;
    let admissionGuards = preparedGuards;
    if (intent.value.state === 'prepared' || isResponseRecovery()) {
      // Current admission precedes the new send; history was already proven.
      // Recovery passes the same boundary through the operator replay in
      // researchCall instead of a new dispatch. S5-01: sending a prepared step
      // is new work; an operator replay applies paid history.
      if (intent.value.state === 'prepared' && !isResponseRecovery()) requireCurrent();
      admissionGuards ??= applicationAdmission(head, null);
      if (intent.value.state === 'prepared' && !isResponseRecovery()) {
        // An unsent step may be re-prepared under a compatible new environment
        // head or profile (№1499-5): the task, materials and logical position
        // are preserved; only refreshed admission and guards change.
        const refreshed: ResearchConsumerIntentInput = { projectId, kind: intent.value.kind, key: intent.value.key,
          owner: intent.value.owner, draft: intent.value.draft, question: intent.value.question,
          role: dispatch.implementer, dispatch, profile: reference(pilot), cursor, basis: intent.value.basis,
          guards: uniqueTransactionGuards([...admissionGuards,
            ...intent.value.guards.filter(guard => ![pilot.id, environment.id, draft.id, question.id].includes(guard.id))]) };
        intent = prepareResearchConsumerIntent(store, refreshed);
      }
      // A preview-seeded session has no durable record to guard (№1555 X29).
      const durableHead = store.get(sessionId) ? reference(head) : undefined;
      try {
        await researchCall(dispatch.implementer, dispatch, cursor.prompt, cursor.context, signal,
          { store, draftId: draft.id, questionId: question.id, purpose: 'analyst', pilot,
            ...(durableHead ? { session: durableHead } : {}), consumerIntent: reference(intent), ...(isResearchPreview() ? { previewIntent: intent } : {}) });
      } catch (error) {
        if (!isResponseRecovery() && error instanceof EngineError
          && ['input_stale', 'revision_conflict', 'pilot_call_active'].includes(error.code)) {
          const competing = findResearchConsumerIntent(store, projectId, intent.value.kind, intent.value.key);
          requireCondition(competing && canonical(competing.value.cursor) === canonical(cursor),
          'synthesis_intent_claim_conflict', 'A concurrent synthesis claim has a different saved basis');
          if (competing.value.state === 'prepared') throw error; // a shared counter moved: the loop re-admits and retries
          return null; // a competitor moved the step forward; the loop re-reads the winner
        }
        throw error;
      }
    }
    const latest = readResearchConsumerIntent(store,
      reference(store.get<ResearchConsumerIntent>(intent.id) ?? intent));
    if (latest.value.state === 'applied') return null;
    if (latest.value.state === 'refused' && latest.value.refusal?.kind === 'consumer-invalid') {
      const refusal = latest.value.refusal;
      // A saved unresumable refusal of a received reply repeats as itself (№1499-11).
      throw new EngineError(refusal.code, `[${latest.id}] The saved synthesis refusal cannot be repurchased`,
        { intent: reference(latest), refusal });
    }
    // Settling the one bound physical call (incl. a lost process) never resends;
    // a proved terminal outcome is saved as the intent's refusal on this path.
    const paid = resumeResearchConsumerExecution(store, projectId, reference(latest));
    requireCondition(paid.kind === 'response', 'research_consumer_execution_refused',
      'The saved physical result did not contain a research answer');
    const archive = store.get<Record<string, any>>(paid.archive.id, paid.archive.revision);
    requireCondition(archive?.kind === 'research-context' && canonical(reference(archive)) === canonical(paid.archive)
      && object(archive.value) && object(archive.value.body),
      'synthesis_session_invalid', 'The paid archive is missing or foreign');
    const profile = latest.value.profile
      ? store.get<ReaderPilot>(latest.value.profile.id, latest.value.profile.revision) : null;
    requireCondition(!latest.value.profile || profile?.kind === 'reader-pilot'
      && canonical(reference(profile)) === canonical(latest.value.profile),
      'synthesis_dispatch_stale', 'The paid synthesis step lost its exact reader profile');
    let transition: SynthesisTransition;
    try {
      transition = projectSynthesisTransition({ store, projectId,
        kind: latest.value.kind === 'consolidation' ? 'consolidation' : 'synthesis',
        sessionId, before: head.value, draft: latest.value.draft, question: latest.value.question,
        delivery: object(cursor.delivery) && typeof cursor.delivery.run === 'string' && Number.isSafeInteger(cursor.delivery.turn)
          ? { run: cursor.delivery.run, turn: cursor.delivery.turn } : null,
        subject: paid.subject, payload: paid.payload, archive: archive.value.body,
        readLimit: profile?.value.maxRequestChars ?? 300000,
        // The origin of every lookup material is proven before the subject
        // write — the write path and the historical reader use one deduction.
        proveRecord: record => { readReaderResultAt(store, projectId, reference(record)); },
        subjectRecord: (record, bound) => subjectContextRecordHolds(store, projectId, draft.id, bound, record) });
    } catch (error) {
      if (error instanceof EngineError && SYNTHESIS_TRANSITION_REFUSAL_CODES.has(error.code)) {
        // A capacity refusal is an application of the paid result too. Re-admit
        // its exact sources before writing; if its CAS races, the outer retry
        // observes the moved basis instead of looping on the old guards.
        if (error.code === 'research_result_capacity') applicationAdmission(head, latest);
        const refused = refuseResearchConsumerIntent(store, reference(latest), error.code);
        throw new EngineError(error.code, error.message, { intent: reference(refused), refusal: refused.value.refusal });
      }
      throw error;
    }
    // The paid response is proven and the outcome derived; only now the
    // current admission of the application is checked (№1499-8..10). Every
    // new application re-admits: guards taken before the send do not cover
    // materials that moved while the provider was running.
    admissionGuards = applicationAdmission(head, latest);
    const writes: Write[] = [];
    if (transition.checkpoint) {
      const existing = store.get(transition.checkpoint.id);
      if (existing) {
        requireCondition(existing.kind === 'research-checkpoint' && hashJson(existing.value) === existing.hash
          && canonical(existing.value) === canonical(transition.checkpoint.value),
          'synthesis_checkpoint_foreign', 'The checkpoint address is occupied by foreign content');
        // An already existing exact C is referenced, not rewritten; its guard
        // rides the same application transaction (№1555 X12).
        admissionGuards = uniqueTransactionGuards([...admissionGuards, reference(existing)]);
      } else {
        writes.push({ id: transition.checkpoint.id, kind: 'research-checkpoint', expected: 0,
          value: transition.checkpoint.value });
      }
    }
    const sessionWrite: Write = { id: sessionId, kind: 'synthesis-session', expected: head.revision,
      value: transition.session };
    if (isResponseRecovery()) {
      const recovery = recoverySessionWrites(sessionWrite, writes);
      store.writeMany([sessionWrite, ...recovery.writes],
        uniqueTransactionGuards([...(subject && !subjectCurrent() ? []
          : [reference(draft), reference(question), reference(environment), ...draft.value.inputs]),
          ...admissionGuards, ...recovery.guards]));
      markRecoveredSessionWritten(recovery);
      return transition;
    }
    writes.push(sessionWrite);
    const application = prepareResearchConsumerApplication(store, reference(latest), reference(paid.call),
      writes, admissionGuards);
    try { store.writeMany(application.writes, application.guards); }
    catch (error) {
      if (!(error instanceof EngineError) || !['input_stale', 'revision_conflict'].includes(error.code)) throw error;
      return null; // A concurrent store committed; the loop re-reads the winner.
    }
    return transition;
  };

  for (;;) {
    recoveredResponseBoundary();
    const current = store.get<SynthesisSessionState>(sessionId) ?? previewSeed;
    requireCondition(current?.kind === 'synthesis-session', 'synthesis_session_invalid',
      'The synthesis session disappeared');
    const head = previewSeed && canonical(reference(current!)) === canonical(reference(previewSeed))
      ? previewSeed
      : readEra(reference(current!));
    const value = head.value;
    // An exact/equivalent repeat of a FINISHED outcome returns it by the saved
    // bases — historical, no current file or head check, no new P/A (№1658 К4).
    // The current admission applies to the next step or a new application only.
    if (value.result) return value.result;
    if (value.pause) {
      // A pause is control flow, not a cached answer. Its single delivery goes
      // to the reserved turn; a new explicit entry opens the next step.
      if (value.delivered == null && value.delivery) return value.pause;
    }
    const workspace = contextWorkspace(value.workspace);
    requireCondition(!workspace.blocked, 'research_no_progress', workspace.blocked ?? 'Saved context session is blocked');
    // A runner entry whose proven reservation was consumed (delivered outcome)
    // or never existed reserves the next position in one guarded transition
    // with the caller's reservation record — before any intent (№1658 К2).
    if (!previewSeed && !recovering && opts.delivery && value.result === null
      && (value.delivery == null || synthesisReservationConsumed(value))
      && canonical(value.delivery ?? null) !== canonical(opts.delivery)) {
      // A new reservation is new work of today's plan on a proven position (S5-01/04).
      requireCurrent();
      if (subject) requireReservation(store, projectId, draft.id, opts.delivery, opts.reserve);
      const reservationWrite: Write = { id: sessionId, kind: 'synthesis-session', expected: head.revision,
        value: { ...value, delivery: opts.delivery } };
      try {
        store.writeMany(opts.reserve ? [opts.reserve.write, reservationWrite] : [reservationWrite],
          [...(opts.reserve?.guards ?? []), reference(head)]);
      } catch (error) {
        if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
      }
      continue; // re-read the head with the proven reservation in place
    }
    // A step may be prepared before or after a reservation-only revision.
    // Both exact owners share the same logical state; a reservation must not
    // orphan either producer when its paid response is resumed.
    let ownerRevision = head.revision;
    for (let revision = head.revision; revision > 1; revision -= 1) {
      const step = store.get<SynthesisSessionState>(sessionId, revision)!;
      const prior = store.get<SynthesisSessionState>(sessionId, revision - 1)!;
      if (isReservationOnlySessionStep(step.value, prior.value)) ownerRevision = revision - 1;
      else break;
    }
    const pending = listResearchConsumerIntents(store, projectId, draft.id)
      .filter(intent => ['synthesis', 'consolidation'].includes(intent.value.kind)
        && intent.value.owner.id === head.id && intent.value.owner.revision >= ownerRevision
        && intent.value.owner.revision <= head.revision
        && ['prepared', 'running'].includes(intent.value.state));
    const pendingConsolidation = pending.find(intent => intent.value.kind === 'consolidation') ?? null;
    const pendingSynthesis = pending.find(intent => intent.value.kind === 'synthesis') ?? null;
    if (pendingConsolidation) {
      await driveIntent(head, pendingConsolidation, null);
      continue;
    }
    if (pendingSynthesis) {
      try {
        const transition = await driveIntent(head, pendingSynthesis, null);
        if (transition?.kind === 'pause') return (transition.session.pause)!;
      } catch (error) {
        if (error instanceof EngineError && ['continuation_carry_limit', 'consolidation_required'].includes(error.code)) {
          const capacity = error.details as { targetChars?: number; fullTargetChars?: number; deficitChars?: number } | null;
          await consolidate(head, capacity?.targetChars, capacity?.fullTargetChars ?? pilot.value.maxRequestChars,
            true, capacity?.deficitChars ?? 0);
          continue;
        }
        if (error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code)) continue;
        throw error;
      }
      continue;
    }
    // DR3a3-S4→S5: a saved-only v3 synthesis re-checks before a new payment that
    // its notes still come from one noted session of the subject — a session
    // noted after the choice makes the saved-only basis ambiguous.
    if (subject && context.savedOnly === true)
      requireCondition(provenSubjectSessions(store, subject).sessions
        .filter(session => session.id !== sessionId && activeSynthesisNotes(session.value.notes).length > 0).length <= 1,
      'research_synthesis_ambiguous', 'Several sessions of this subject hold notes; the saved-only basis is ambiguous');
    try {
      const transition = await prepareAndDrive(head, 'synthesis', buildCallContext(head),
        prompt + instruction + checkpointInstruction + COMPACT_CHECKPOINT_INSTRUCTION);
      if (transition?.kind === 'pause') return transition.session.pause!;
    } catch (error) {
      if (error instanceof EngineError && ['continuation_carry_limit', 'consolidation_required'].includes(error.code)) {
        const capacity = error.details as { targetChars?: number; fullTargetChars?: number; deficitChars?: number } | null;
        await consolidate(head, capacity?.targetChars, capacity?.fullTargetChars ?? pilot.value.maxRequestChars,
          true, capacity?.deficitChars ?? 0);
        continue;
      }
      if (error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code)) continue;
      throw error;
    }
  }
}

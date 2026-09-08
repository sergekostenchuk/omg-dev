import { synthesisControls, type FinalizationState } from './synthesis-controls.js';
import { compactConclusions } from './continuation-packet.js';
import { activeSynthesisNotes, consolidationNeeded, consolidationLimits, consolidatedProposal, consolidationNotice, COMPACT_CHECKPOINT_INSTRUCTION, type SynthesisNote, type ConsolidationNotice } from './conclusion-consolidation.js';
import { contextWorkspace, addContextLookup, contextProgress, contextLookupKey, type ContextWorkspace } from "./context-workspace.js";
import { readResearchContext, requireCurrentPriorContext } from "./research-limits.js";
import type { Store, Revision, Write } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Environment } from "../runtime/environment.js";
import type { ReaderPilot } from "./reader-pilot.js";
import type { ResearchAction } from "./research-model.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";
import { researchAction, researchCall } from "./research-protocol.js";
import { checkpoint } from "./research-continuation.js";
import { Evidence, sourceIsCurrent } from "../evidence/evidence.js";
import { readerResultCurrent } from "./reader.js";
import { isRef } from "../pipeline/contracts.js";
import { recoveredResponseBoundary, recoveryConsolidationMode, recoverySessionWrites, markRecoveredSessionWritten } from './response-recovery.js';

interface Session {
  projectId: string; offset: number; materialOffset?: number; focus?: unknown; workspace?: ContextWorkspace;
  binding?: { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] };
  notes: SynthesisNote[]; notices?: ConsolidationNotice[]; finalization?: FinalizationState;
  result: ResearchAction | null;
}

function basis(draft: Revision<DiscoveryDraft>, question: Revision<Question>, environment: Revision<Environment>, context: Record<string, any>) {
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
  return { materials, id: `synthesis-session:${hashJson([reference(question), reference(environment), draft.value.inputs,
    materials, context.previousProposal ?? null, context.previousProposalRef ?? null])}` };
}

/** An old need_research may describe data already read but evicted from the
 * request. Give those materials one resumable synthesis before buying another
 * reading plan. A completed session's need_research never triggers itself. */
export function pendingSynthesis(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, context: Record<string, any>) {
  const { id, materials } = basis(draft, question, environment, context);
  return materials.length > 0 && !store.get<Session>(id)?.value.result;
}

const instruction = "\nmaterialPage may carry a finite JSON fragment of one large saved material; its cursor must advance before the next source. Synthesis uses finite pages of the materials already requested. synthesisPage gives the range actually supplied; omitted pages are not missing research. If synthesisPage.complete is false, return checkpoint with findings from this page, exact citations and remaining uncertainties; do not ask the reading planner to retrieve later pages. The engine saves your checkpoint and supplies the next page. An early answer is only an unassessed checkpoint. synthesisNotes contains earlier proposed answers and source citations, not authoritative facts; reconcile exceptions and contradictions across them. After the last page, compose the complete answer using these notes and supplied evidence. Only then request new research if essential information is still absent. All original materials remain at working.archive /body/synthesisMaterials. Never infer absence from an unshown page.";
const checkpointInstruction = " A checkpoint is an unassessed note and may explicitly use citations:[] for a context-only page without Source evidence. Do not invent or borrow an irrelevant citation to satisfy its format. This does not waive the citations and evidence required for a final answer.";

export async function synthesisSession(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot>,
  context: Record<string, any>, prompt: string, signal?: AbortSignal): Promise<ResearchAction> {
  const { id, materials } = basis(draft, question, environment, context);
  let session = store.get<Session>(id);
  const guards = [reference(draft), reference(question), reference(environment), ...draft.value.inputs];
  const save = (value: Session, extra: Ref[] = []) => {
    const write: Write = { id, kind: 'synthesis-session', expected: session?.revision ?? 0,
      value: { ...value, binding: { draft: reference(draft), question: reference(question), environment: reference(environment), inputs: draft.value.inputs } } };
    const recovery = recoverySessionWrites(write);
    session = store.writeMany<Session>([write, ...recovery.writes], [...guards, ...extra, ...recovery.guards])[0]!;
    markRecoveredSessionWritten(recovery); return session;
  };
  if (!session) save({ projectId: draft.value.projectId, offset: 0, notes: [], result: null });
  for (;;) {
    recoveredResponseBoundary();
    requireCondition(guards.every(ref => {
      const current = store.get(ref.id);
      return current?.revision === ref.revision && current.hash === ref.hash;
    }), "input_stale", "The question or research inputs changed before synthesis continued");
    const verify = (value: any): void => {
      if (!value || typeof value !== "object") return;
      if(isRef(value.record)&&typeof value.pointer==='string'&&Object.hasOwn(value,'value'))
        requireCurrentPriorContext(store,draft,value);
      if (isRef(value.source) && value.selector && Object.hasOwn(value, "value")) {
        requireCondition(new Evidence(store).verify(value), "synthesis_evidence_stale", "A material source changed; do not reuse stale synthesis notes");
      }
      if (isRef(value.ref)) {
        const reader = store.get<any>(value.ref.id, value.ref.revision);
        if (reader?.kind === "reader-result") requireCondition(reader.hash === value.ref.hash
          && readerResultCurrent(store, draft.value.projectId, reader.value), "synthesis_evidence_stale", "A reader bundle changed before synthesis continued");
        if (reader?.kind === "source") {
          const current = store.get<any>(reader.id);
          requireCondition(current && current.revision === value.ref.revision && current.hash === value.ref.hash
            && sourceIsCurrent(current.value), "synthesis_evidence_stale", "A directly read source changed before synthesis continued");
        }
      }
      for (const child of Object.values(value)) verify(child);
    };
    verify(materials);
    if (session!.value.result) return session!.value.result!;
    if (recoveryConsolidationMode() === undefined) {
      const value=session!.value;
      requireCondition(value.notices===undefined||Array.isArray(value.notices),'consolidation_state_invalid','Saved consolidation notices must remain an array');
      const notice=activeSynthesisNotes(value.notes).map(consolidationNotice).find(n=>n && !(value.notices??[]).some(old=>canonical(old.checkpoint)===canonical(n.checkpoint)));
      if(notice){save({...value,notices:[...(value.notices??[]),notice]});continue;}
    }
    const current = session!.value;
    const workspace=contextWorkspace(current.workspace,current.focus);
    requireCondition(!workspace.blocked,'research_no_progress',workspace.blocked??'Saved context session is blocked');
    verify(workspace.entries);
    const recovering = recoveryConsolidationMode() !== undefined;
    const final = current.offset === materials.length;
    let controls = recovering ? context.contextControls : synthesisControls(final, workspace, pilot.value.contextLimits?.maxLookups ?? 3, current.finalization);
    const callContext = { ...context, dispatchMode: 'synthesis', synthesisMaterials: materials,
      synthesisSession: id, synthesisState: { offset: current.offset, materialOffset: current.materialOffset ?? 0 }, synthesisNotes: current.notes,
      contextWorkspace: workspace.entries.map(e => e.result), focus: null,
      ...(controls ? {contextControls:controls} : {}),
      ...(!recovering || Object.hasOwn(context,'contextCheckpointedKeys') ? {contextCheckpointedKeys:workspace.checkpointedKeys??[]} : {}) };
    const consolidate = async (target = consolidationLimits(pilot.value).target, fullTarget?: number, allowTightening = false, packetDeficit = 0) => {
      const active=activeSynthesisNotes(current.notes),regular=consolidationNeeded(current.notes,pilot.value,true);
      const candidate=active.length===1?active[0]:undefined;
      const tightening=recovering?context.consolidation.tightening:!regular && allowTightening && candidate?.consolidated?.format===2 && !candidate.consolidated.tightenedFrom
        ? {from:candidate.checkpoint,currentItemsChars:JSON.stringify(compactConclusions(active).items).length,
          currentFullChars:JSON.stringify(compactConclusions(active)).length,targetChars:target,fullTargetChars:fullTarget!,
          packetDeficitChars:packetDeficit,deficitChars:Math.max(1,packetDeficit,JSON.stringify(compactConclusions(active).items).length-target,JSON.stringify(compactConclusions(active)).length-fullTarget!)} : undefined;
      requireCondition(recovering || regular || tightening, 'consolidation_capacity_exhausted',
        'The paid summary still does not fit after its one tightening; no further compaction is allowed without new findings');
      requireCondition(Number.isSafeInteger(target) && target > 0 && (recovering || Number.isSafeInteger(fullTarget) && fullTarget!>0),'research_context_capacity',
        'Exact context and unresolved obligations leave no summary capacity inside the fixed limit');
      const goal=recovering?context.consolidation:{targetChars:tightening?target:Math.min(target,consolidationLimits(pilot.value).target),fullTargetChars:fullTarget!,format:2,
        ...(tightening?{tightening}:{})};
      const response = researchAction(await researchCall(dispatch.implementer, dispatch, '',
        { ...callContext, dispatchMode: 'consolidation', consolidation: goal }, signal,
        { store, draftId: draft.id, questionId: question.id, purpose: 'analyst', pilot, session: reference(session!) }));
      const proposal = consolidatedProposal(response, question.id, current.notes);
      const saved = checkpoint(store, draft, question, { ...proposal, value: proposal as unknown as Json });
      const note: SynthesisNote = { checkpoint: reference(saved), proposal, page: { offset: current.offset, end: current.offset },
        consolidated: { replaces: active.map(note => note.checkpoint),
          ...(!recovering || goal.format === 2 ? {format:2 as const,targetChars:goal.targetChars,fullTargetChars:goal.fullTargetChars} : {}),
          ...(tightening?{tightenedFrom:tightening.from}:{}) } };
      const notice=consolidationNotice(note);
      save({ ...current, notes: [...current.notes, note],...(notice?{notices:[...(current.notices??[]),notice]}:{}) }, [reference(saved)]);
      // A size goal is observational. The next real packet decides admission;
      // it retains mandatory context and is checked before any next payment.
    };
    if (recoveryConsolidationMode()) { await consolidate(context.consolidation.targetChars,context.consolidation.fullTargetChars); continue; }
    let sent: Record<string, any> | undefined, action: ResearchAction;
    try {
      action = researchAction(await researchCall(dispatch.implementer, dispatch, prompt + instruction + checkpointInstruction + COMPACT_CHECKPOINT_INSTRUCTION,
        callContext, signal, { store, draftId: draft.id, questionId: question.id, purpose: 'analyst', pilot,
          session: reference(session!), onContext: packet => {
            sent = packet;
            if (packet.contextControls) {controls=packet.contextControls;callContext.contextControls=controls;}
            if (!recovering && consolidationNeeded(current.notes,pilot.value)) throw new EngineError('consolidation_required',
              'Compact findings within the capacity remaining after exact addressed context',
              {targetChars:packet.conclusionCapacity?.items??consolidationLimits(pilot.value).target,fullTargetChars:packet.conclusionCapacity?.total??pilot.value.maxRequestChars});
          } }));
    } catch (error) {
      if (error instanceof EngineError && ['continuation_carry_limit','consolidation_required'].includes(error.code)) {
        const capacity = error.details as {targetChars?:number;fullTargetChars?:number;deficitChars?:number}|null;
        await consolidate(capacity?.targetChars,capacity?.fullTargetChars??Math.min(pilot.value.maxRequestChars,pilot.value.maxContinuationChars??100000),true,capacity?.deficitChars??0); continue;
      }
      if (error instanceof EngineError && ['research_context_undelivered','research_context_capacity'].includes(error.code)) save({ ...current, workspace: { ...workspace, blocked: error.message } });
      throw error;
    }
    const page = sent?.synthesisPage;
    requireCondition(["answer", "answer_delta", "checkpoint", "read_context", "need_research", "need_owner", "pause"].includes(action.action),
      "research_mode_invalid", "Synthesis must answer, checkpoint, or identify missing information");
    requireCondition(!("question" in action) || action.question === question.id,
      "research_question_foreign", "Synthesis must target its bound question");
    requireCondition(page && page.offset === current.offset && page.end >= page.offset && page.total === materials.length,
      "synthesis_cursor_invalid", "The analyst must receive the saved material continuation");
    // A pause is control flow, not a reusable answer. Explicit resume must be
    // able to call again with the unchanged saved material cursor.
    if (action.action === "pause") return action;
    if (action.action === "read_context") {
      try {
        if (controls?.version === 2 && controls.stage === 'final') {
          requireCondition(controls.remainingLookups > 0,'research_no_progress','Finalization cannot purchase another context search after its declared allowance');
          requireCondition(typeof action.purpose === 'string' && action.purpose.trim().length > 0,
            'synthesis_context_purpose_missing','A final-stage lookup must identify the concrete missing fact or exception before another lookup can be delivered');
        }
        const result=readResearchContext(store,draft,question.id,pilot,action.record,action.pointer,action.page);
        save({...current,focus:null,workspace:addContextLookup(workspace,result,sent!.contextWorkspace,pilot.value.contextLimits?.maxLookups),
          ...(controls?.stage === 'final' ? {finalization:{lookups:(pilot.value.contextLimits?.maxLookups??3)-controls.remainingLookups+1}} : final ? {finalization:{lookups:(current.finalization?.lookups??workspace.sinceProgress)+1}} : {})});
      } catch(error) {
        save({...current,workspace:{...workspace,blocked:error instanceof Error?error.message:'Context lookup refused'}});
        throw error;
      }
      continue;
    }
    requireCondition(!context.savedOnly || action.action !== "need_research", "research_saved_only", "Finish from saved findings; new source reads are disabled for this recovery");
    if (page.complete && action.action !== "checkpoint") {
      save({ ...current, offset: page.end, materialOffset: page.nextMaterialOffset ?? 0, focus: null, workspace:contextProgress(workspace), result: action }); return action;
    }
    requireCondition(["checkpoint", "answer", "answer_delta"].includes(action.action),
      "synthesis_checkpoint_required", "Save partial findings before continuing the remaining already-read materials");
    const deliveredKeys = (sent?.contextWorkspace ?? []).map(contextLookupKey);
    const newContext = controls?.version === 2 && deliveredKeys.some((key:string) => !(workspace.checkpointedKeys??[]).includes(key));
    requireCondition(page.end > current.offset || (page.nextMaterialOffset ?? 0) > (current.materialOffset ?? 0) || newContext,
      'synthesis_no_progress','A checkpoint must advance material or record newly delivered context; repeated prose is not progress');
    const proposal = action as Extract<ResearchAction, { action: "checkpoint" | "answer" | "answer_delta" }>;
    requireCondition(proposal.question === question.id, "research_question_foreign", "Partial synthesis must target its bound question");
    const saved = checkpoint(store, draft, question, { action: "checkpoint", question: question.id,
      value: proposal as unknown as Json, citations: proposal.citations,
      unresolved: proposal.action === "checkpoint" ? proposal.unresolved : ["Complete the remaining material pages before accepting this proposal"] });
    save({ ...current, offset: page.end, materialOffset: page.nextMaterialOffset ?? 0, focus: null, workspace:contextProgress(workspace),
      ...(page.end === materials.length ? {finalization:{lookups:controls?.version === 2 && controls.stage === 'final'
        ? (pilot.value.contextLimits?.maxLookups??3)-controls.remainingLookups : final ? current.finalization?.lookups??workspace.sinceProgress : 0}} : {}), notes: [...current.notes,
      { checkpoint: reference(saved), proposal, page: { offset: current.offset, end: page.end } }] }, [reference(saved)]);
  }
}

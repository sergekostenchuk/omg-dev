import { contextWorkspace, addContextLookup, contextProgress, type ContextWorkspace } from "./context-workspace.js";
import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Environment } from "../runtime/environment.js";
import type { ReaderPilot } from "./reader-pilot.js";
import { hashJson, type Json } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";
import { researchAction, researchCall } from "./research-protocol.js";
import { readResearchContext, requireCurrentPriorContext } from "./research-limits.js";

interface Session { projectId: string; offset: number; candidateOffset?:number; notes: Json[]; focus: unknown; workspace?: ContextWorkspace; result: unknown;
  binding?: { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] } }
const instruction = "candidatePage may contain an exact serialized fragment of the candidate; compare it with saved judgments and evidence. Do not issue a final verdict until both candidatePage and evidencePage are complete. Evidence is sent in bounded pages. evidencePage.text is a fragment of the JSON-serialized COMPLETE observations array, at UTF-16 offsets; it is not a complete quote. observations, when populated, contains the whole array. All exact originals are in working.archive; you may request read_context with record,pointer,page. Keep intermediate judgments as {action:'assessment_checkpoint',notes:[string]} with source/requirement references in each note. Notes are unassessed judgments, not source substitutes. You may revisit any earlier page. A terminal verdict is accepted only after every evidence character has been supplied; examine applicable exceptions, global constraints and cross-page contradictions before the final judgment.";

export async function assessmentSession(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined, context: Record<string, any>,
  prompt: string, signal?: AbortSignal): Promise<unknown> {
  // Additional readings and contradictions can change a verdict even when the
  // proposed value and its citations did not change.
  const basis = JSON.parse(JSON.stringify(context));
  const id = `assessment-session:${hashJson([reference(question), reference(environment), draft.value.inputs, basis])}`;
  let session = store.get<Session>(id);
  const guards = [reference(question), reference(environment), ...draft.value.inputs, ...context.observations.map((o: any) => o.source)];
  const save = (value: Session) => session = store.writeMany<Session>([{ id, kind: "assessment-session", expected: session?.revision ?? 0,
    value:{...value,binding:{draft:reference(draft),question:reference(question),environment:reference(environment),inputs:draft.value.inputs}} }], guards)[0]!;
  if (!session) save({ projectId: draft.value.projectId, offset: 0, notes: [], focus: null, result: null });
  if (session!.value.result) return session!.value.result;
  for (;;) {
    const current = session!.value;
    const workspace=contextWorkspace(current.workspace,current.focus);
    for(const entry of workspace.entries)requireCurrentPriorContext(store,draft,entry.result);
    requireCondition(!workspace.blocked,'research_no_progress',workspace.blocked??'Saved assessment is blocked');
    let sent: Record<string, any> | undefined;
    const response = await researchCall(dispatch.reviewer, dispatch, prompt + "\n" + instruction,
      { ...context, assessmentSession:id, assessmentState: { offset: current.offset, candidateOffset:current.candidateOffset??0, total: JSON.stringify(context.observations).length },
        assessmentNotes: current.notes, contextWorkspace:workspace.entries.map(e=>e.result), focus:null }, signal,
      { store, draftId: draft.id, questionId: question.id, purpose: "assessor", ...(pilot?{pilot}:{}), session:reference(session!), onContext: packet => { sent = packet; } }).catch(error=>{
        if(error instanceof EngineError&&error.code==='research_context_undelivered')save({...current,workspace:{...workspace,blocked:error.message}});
        throw error;
      }) as any;
    requireCondition(sent?.evidencePage && sent.evidencePage.offset === current.offset,
      "assessment_invalid", "Assessment did not receive its expected evidence continuation");
    const offset = sent.evidencePage.end;
    const candidate=sent.candidatePage;
    requireCondition(candidate && candidate.total===JSON.stringify(context.value).length
      && (candidate.offset===(current.candidateOffset??0)||candidate.offset===0&&candidate.complete),
      'assessment_invalid','Candidate must be fully supplied through the saved assessment cursor');
    const candidateOffset=candidate.end;
    if (response?.action === "read_context") {
      const action = researchAction(response);
      requireCondition(action.action === "read_context", "assessment_invalid", "Expected an addressed read");
      try {
        const result=readResearchContext(store,draft,question.id,pilot,action.record,action.pointer,action.page);
        save({...current,focus:null,workspace:addContextLookup(workspace,result,sent.contextWorkspace,pilot?.value.contextLimits?.maxLookups)});
      } catch(error) {
        save({...current,workspace:{...workspace,blocked:error instanceof Error?error.message:'Context lookup refused'}});
        throw error;
      }
      continue; // A context lookup is not an assessment of the evidence page just sent.
    } else if (response?.action === "assessment_checkpoint") {
      requireCondition(Object.keys(response).sort().join(",") === "action,notes" && Array.isArray(response.notes)
        && response.notes.every((n: unknown) => typeof n === "string"), "assessment_invalid", "Assessment checkpoint needs explicit notes");
    } else {
      requireCondition(response && ["supported", "insufficient", "conflicting"].includes(response.verdict)
        && Array.isArray(response.reasons) && response.reasons.every((r: unknown) => typeof r === "string")
        && (response.verdict === "supported" || response.reasons.length > 0), "assessment_invalid", "Expected an assessment verdict or continuation");
      if (offset === sent.evidencePage.total && candidate.complete) {
        save({ ...current, offset, candidateOffset, focus: null, workspace:contextProgress(workspace), result: response }); return response;
      }
    }
    save({ ...current, offset, candidateOffset, focus:null, workspace:contextProgress(workspace), notes: [...current.notes,
      { packet: sent.working.archive, evidence: { offset: current.offset, end: offset }, response } as Json] });
  }
}

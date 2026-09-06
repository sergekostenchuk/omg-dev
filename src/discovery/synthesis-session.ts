import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Environment } from "../runtime/environment.js";
import type { ReaderPilot } from "./reader-pilot.js";
import type { ResearchAction } from "./research-model.js";
import { hashJson, type Json } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { researchAction, researchCall } from "./research-protocol.js";
import { checkpoint } from "./research-continuation.js";
import { Evidence, sourceIsCurrent } from "../evidence/evidence.js";
import { readerResultCurrent } from "./reader.js";
import { isRef } from "../pipeline/contracts.js";

interface Session {
  projectId: string; offset: number;
  notes: { checkpoint: Ref; proposal: ResearchAction; page: { offset: number; end: number } }[];
  result: ResearchAction | null;
}

function basis(draft: Revision<DiscoveryDraft>, question: Revision<Question>, environment: Revision<Environment>, context: Record<string, any>) {
  const materials = context.workingSelections?.length ? context.workingSelections
    : (context.readings ?? []).map((value: any) => ({ kind: "reader", value }));
  return { materials, id: `synthesis-session:${hashJson([reference(question), reference(environment), draft.value.inputs,
    materials, context.previousProposal ?? null])}` };
}

/** An old need_research may describe data already read but evicted from the
 * request. Give those materials one resumable synthesis before buying another
 * reading plan. A completed session's need_research never triggers itself. */
export function pendingSynthesis(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, context: Record<string, any>) {
  const { id, materials } = basis(draft, question, environment, context);
  return materials.length > 0 && !store.get<Session>(id)?.value.result;
}

const instruction = "\nSynthesis uses finite pages of the materials already requested. synthesisPage gives the range actually supplied; omitted pages are not missing research. If synthesisPage.complete is false, return checkpoint with findings from this page, exact citations and remaining uncertainties; do not ask the reading planner to retrieve later pages. The engine saves your checkpoint and supplies the next page. An early answer is only an unassessed checkpoint. synthesisNotes contains earlier proposed answers and source citations, not authoritative facts; reconcile exceptions and contradictions across them. After the last page, compose the complete answer using these notes and supplied evidence. Only then request new research if essential information is still absent. All original materials remain at working.archive /body/synthesisMaterials. Never infer absence from an unshown page.";

export async function synthesisSession(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot>,
  context: Record<string, any>, prompt: string, signal?: AbortSignal): Promise<ResearchAction> {
  const { id, materials } = basis(draft, question, environment, context);
  let session = store.get<Session>(id);
  const guards = [reference(draft), reference(question), reference(environment), ...draft.value.inputs];
  const save = (value: Session, extra: Ref[] = []) => session = store.writeMany<Session>([
    { id, kind: "synthesis-session", expected: session?.revision ?? 0, value }], [...guards, ...extra])[0]!;
  if (!session) save({ projectId: draft.value.projectId, offset: 0, notes: [], result: null });
  for (;;) {
    requireCondition(guards.every(ref => {
      const current = store.get(ref.id);
      return current?.revision === ref.revision && current.hash === ref.hash;
    }), "input_stale", "The question or research inputs changed before synthesis continued");
    const verify = (value: any): void => {
      if (!value || typeof value !== "object") return;
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
    const current = session!.value;
    let sent: Record<string, any> | undefined;
    const action = researchAction(await researchCall(dispatch.implementer, dispatch, prompt + instruction,
      { ...context, dispatchMode: "synthesis", synthesisMaterials: materials,
        synthesisState: { offset: current.offset }, synthesisNotes: current.notes }, signal,
      { store, draftId: draft.id, questionId: question.id, purpose: "analyst", pilot, onContext: packet => { sent = packet; } }));
    const page = sent?.synthesisPage;
    requireCondition(["answer", "answer_delta", "checkpoint", "need_research", "need_owner", "pause"].includes(action.action),
      "research_mode_invalid", "Synthesis must answer, checkpoint, or identify missing information");
    requireCondition(!("question" in action) || action.question === question.id,
      "research_question_foreign", "Synthesis must target its bound question");
    requireCondition(page && page.offset === current.offset && page.end >= page.offset && page.total === materials.length,
      "synthesis_cursor_invalid", "The analyst must receive the saved material continuation");
    // A pause is control flow, not a reusable answer. Explicit resume must be
    // able to call again with the unchanged saved material cursor.
    if (action.action === "pause") return action;
    if (page.complete && action.action !== "checkpoint") {
      save({ ...current, offset: page.end, result: action }); return action;
    }
    requireCondition(["checkpoint", "answer", "answer_delta"].includes(action.action),
      "synthesis_checkpoint_required", "Save partial findings before continuing the remaining already-read materials");
    requireCondition(page.end > current.offset, "synthesis_no_progress", "All material pages were supplied; compose the final answer instead of another checkpoint");
    const proposal = action as Extract<ResearchAction, { action: "checkpoint" | "answer" | "answer_delta" }>;
    requireCondition(proposal.question === question.id, "research_question_foreign", "Partial synthesis must target its bound question");
    const saved = checkpoint(store, draft, question, { action: "checkpoint", question: question.id,
      value: proposal as unknown as Json, citations: proposal.citations,
      unresolved: proposal.action === "checkpoint" ? proposal.unresolved : ["Complete the remaining material pages before accepting this proposal"] });
    save({ ...current, offset: page.end, notes: [...current.notes,
      { checkpoint: reference(saved), proposal, page: { offset: current.offset, end: page.end } }] }, [reference(saved)]);
  }
}

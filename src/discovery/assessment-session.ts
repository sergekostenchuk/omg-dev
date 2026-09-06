import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Environment } from "../runtime/environment.js";
import type { ReaderPilot } from "./reader-pilot.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { reference } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { researchAction, researchCall } from "./research-protocol.js";
import { readResearchContext } from "./research-limits.js";

interface Session { projectId: string; offset: number; notes: Json[]; focus: unknown; result: unknown }
const instruction = "Evidence is sent in bounded pages. evidencePage.text is a fragment of the JSON-serialized COMPLETE observations array, at UTF-16 offsets; it is not a complete quote. observations, when populated, contains the whole array. All exact originals are in working.archive; you may request read_context with record,pointer,page. Keep intermediate judgments as {action:'assessment_checkpoint',notes:[string]} with source/requirement references in each note. Notes are unassessed judgments, not source substitutes. You may revisit any earlier page. A terminal verdict is accepted only after every evidence character has been supplied; examine applicable exceptions, global constraints and cross-page contradictions before the final judgment.";

export async function assessmentSession(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined, context: Record<string, any>,
  prompt: string, signal?: AbortSignal): Promise<unknown> {
  // Additional readings and contradictions can change a verdict even when the
  // proposed value and its citations did not change.
  const basis = JSON.parse(JSON.stringify(context));
  const id = `assessment-session:${hashJson([reference(question), reference(environment), draft.value.inputs, basis])}`;
  let session = store.get<Session>(id);
  const guards = [reference(question), reference(environment), ...draft.value.inputs, ...context.observations.map((o: any) => o.source)];
  const save = (value: Session) => session = store.writeMany<Session>([{ id, kind: "assessment-session", expected: session?.revision ?? 0, value }], guards)[0]!;
  if (!session) save({ projectId: draft.value.projectId, offset: 0, notes: [], focus: null, result: null });
  if (session!.value.result) return session!.value.result;
  for (;;) {
    const current = session!.value;
    let sent: Record<string, any> | undefined;
    const response = await researchCall(dispatch.reviewer, dispatch, prompt + "\n" + instruction,
      { ...context, assessmentState: { offset: current.offset, total: JSON.stringify(context.observations).length },
        assessmentNotes: current.notes, focus: current.focus }, signal,
      { store, draftId: draft.id, questionId: question.id, purpose: "assessor", ...(pilot?{pilot}:{}), onContext: packet => { sent = packet; } }) as any;
    requireCondition(sent?.evidencePage && sent.evidencePage.offset === current.offset,
      "assessment_invalid", "Assessment did not receive its expected evidence continuation");
    const offset = sent.evidencePage.end;
    const focusDelivered = current.focus === null || (sent.focus !== undefined && canonical(current.focus) === canonical(sent.focus));
    let focus: unknown = focusDelivered ? null : current.focus;
    if (response?.action === "read_context") {
      const action = researchAction(response);
      requireCondition(action.action === "read_context", "assessment_invalid", "Expected an addressed read");
      focus = readResearchContext(store, draft, question.id, pilot, action.record, action.pointer, action.page);
      requireCondition(current.focus === null || canonical(current.focus) !== canonical(focus),
        "assessment_no_progress", "The same addressed context was requested again without assessing the current evidence page");
      save({ ...current, focus });
      continue; // A context lookup is not an assessment of the evidence page just sent.
    } else if (response?.action === "assessment_checkpoint") {
      requireCondition(Object.keys(response).sort().join(",") === "action,notes" && Array.isArray(response.notes)
        && response.notes.every((n: unknown) => typeof n === "string"), "assessment_invalid", "Assessment checkpoint needs explicit notes");
    } else {
      requireCondition(response && ["supported", "insufficient", "conflicting"].includes(response.verdict)
        && Array.isArray(response.reasons) && response.reasons.every((r: unknown) => typeof r === "string")
        && (response.verdict === "supported" || response.reasons.length > 0), "assessment_invalid", "Expected an assessment verdict or continuation");
      if (offset === sent.evidencePage.total) {
        requireCondition(focusDelivered,
          "assessment_invalid", "The requested context was not delivered; request a smaller page before a verdict");
        save({ ...current, offset, focus: null, result: response }); return response;
      }
    }
    save({ ...current, offset, focus, notes: [...current.notes,
      { packet: sent.working.archive, evidence: { offset: current.offset, end: offset }, response } as Json] });
  }
}

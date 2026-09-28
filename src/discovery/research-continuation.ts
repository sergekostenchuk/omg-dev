import type { Store, Revision, Write, TransactionGuard } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchAction, ResearchTurn } from "./research-model.js";
import { Evidence, sourceIsCurrent } from "../evidence/evidence.js";
import { canonical } from "../canonical.js";
import { reference, isRef } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { archivedContext, contextValue } from "./working-context.js";
import { readerResultCurrent } from "./reader.js";
import { contextLookupKey, contextProgress, type ContextWorkspace, type ContextLookup } from './context-workspace.js';
import { requireCurrentPriorContext } from './research-limits.js';
import { projectCheckpointValue } from './research-consumer-transition.js';

/** Keep one latest proposal even after many reads push its turn out of the
 * compact conversation history. Its identity also stabilizes synthesis resume. */
export function latestProposal(turns: Revision<ResearchTurn>[], questionId: string) {
  return [...turns].reverse().find(turn => (turn.value.action as { question?: string })?.question === questionId
    && ["answer", "answer_delta"].includes(String((turn.value.action as { action?: string })?.action)))?.value.action ?? null;
}

export interface PreparedCheckpoint {
  id: string; value: Record<string, any>;
  writes: Write[]; guards: TransactionGuard[]; existing: Revision | null;
}

/** Preparation is separate from the write: the synthesis application includes
 * the prepared checkpoint in its own atomic transaction (№1188-3). The live
 * observation here is the producer's current admission; the shared value
 * formula lives in the transition leaf. */
export function prepareCheckpoint(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  action: Extract<ResearchAction, { action: "checkpoint" }>): PreparedCheckpoint {
  requireCondition(action.question === question.id && question.value.draftId === draft.id,
    "research_question_foreign", "Checkpoint belongs to another question");
  const projected = projectCheckpointValue(draft.value.projectId, reference(draft), reference(question),
    { question: action.question, value: action.value, citations: action.citations, unresolved: action.unresolved },
    (source, selector) => new Evidence(store).observe(draft.value.projectId, source, selector));
  const existing = store.get(projected.id);
  if (existing) return { ...projected, writes: [], guards: [reference(existing)], existing };
  return { ...projected, existing: null,
    writes: [{ id: projected.id, kind: "research-checkpoint", expected: 0, value: projected.value }],
    guards: [reference(draft), reference(question), ...draft.value.inputs,
      ...projected.value.observations.map((observation: any) => observation.source)] };
}

export function checkpoint(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  action: Extract<ResearchAction, { action: "checkpoint" }>) {
  const prepared = prepareCheckpoint(store, draft, question, action);
  return prepared.existing ?? store.writeMany(prepared.writes, prepared.guards)[0]!;
}

export function latestFocus(store: Store, turns: Revision<ResearchTurn>[], question: Revision<Question>) {
  for (const turn of [...turns].reverse()) {
    const observation = turn.value.observation as any;
    if(observation?.splitInto)continue; // Queue expansion is not a delivered reading.
    const reader = observation?.ref ? store.get<any>(observation.ref.id) : null;
    if (turn.value.question?.id !== question.id && reader?.value.question?.id !== question.id) continue;
    if (turn.value.status !== "completed" || turn.value.error) return null;
    if (turn.value.question && canonical(turn.value.question) !== canonical(reference(question))) return null;
    const action = (turn.value.action as { action?: string })?.action;
    const materialRef = observation?.value?.ref ?? observation?.ref;
    const material = isRef(materialRef) ? store.get<any>(materialRef.id, materialRef.revision) : null;
    if (material?.kind === "reader-result" && (material.hash !== materialRef.hash
      || !readerResultCurrent(store, question.value.projectId, material.value))) return null;
    const evidence = new Evidence(store);
    if (action === "read_bundle" && !observation.observations.every((o: any) => evidence.verify(o))) return null;
    if (action === "read_source" && !evidence.verify(observation)) return null;
    if (action === "read" && (!reader || canonical(reference(reader)) !== canonical(observation.ref) || !sourceIsCurrent(reader.value))) return null;
    if (action === "read_context") {
      const record = store.get(observation.record.id);
      if (!record || canonical(reference(record)) !== canonical(observation.record)) return null;
      if(record.kind==='reader-result'){
        try{requireCurrentPriorContext(store,store.get<DiscoveryDraft>(question.value.draftId)!,observation);}catch{return null;}
      }
      if (record.kind === "research-context") {
        try { archivedContext(store, store.get<DiscoveryDraft>(question.value.draftId)!, observation.record); } catch { return null; }
      }
    }
    return ["read", "read_source", "read_context", "read_bundle", "search"].includes(action ?? "") ? turn.value.observation : null;
  }
  return null;
}

function readerSelection(store: Store, focus: any, question: Revision<Question>) {
  const view = focus?.value?.ref ? focus.value : focus;
  const ref = view?.ref;
  const record = isRef(ref) ? store.get<any>(ref.id, ref.revision) : null;
  if (record?.kind !== "reader-result" || record.hash !== ref.hash || record.value.question.id !== question.id
    || record.value.projectId !== question.value.projectId || !view.observations
    || canonical(view.observations) !== canonical(record.value.observations)) return null;
  if (!readerResultCurrent(store, question.value.projectId, record.value)) return null;
  return { key: canonical(reference(record)), kind: "reader", value: { ref: reference(record), purpose: record.value.purpose,
    observations: record.value.observations, coverage: record.value.coverage, unresolved: record.value.unresolved } };
}

/** A comparison needs multiple explicitly requested materials at once. Use
 * most-recent-first order; the wire packer, not a fixed item count, limits size. */
export function workingSelections(store: Store, turns: Revision<ResearchTurn>[], question: Revision<Question>) {
  const selected: { key: string; kind: string; value: unknown }[] = [], seen = new Set<string>();
  for (const turn of [...turns].reverse()) {
    if (turn.value.question?.id === question.id && ["answer", "answer_delta", "checkpoint"].includes(String((turn.value.action as any)?.action))) break;
    const focus = latestFocus(store, [turn], question);
    if (!focus) continue;
    const item = readerSelection(store, focus, question) ?? { key: canonical(focus), kind: "context", value: focus };
    if (!seen.has(item.key)) { seen.add(item.key); selected.push(item); }
  }
  return selected;
}

/** Reconstruct this question's addressed originals across run boundaries.
 * Old turns are read as history, not re-executed or retroactively rejected. */
export function addressedWorkspace(store:Store,turns:Revision<ResearchTurn>[],question:Revision<Question>):ContextWorkspace {
  let workspace:ContextWorkspace={entries:[],sinceProgress:0};
  for(const turn of turns){
    if(turn.value.question?.id!==question.id||turn.value.status!=='completed'||turn.value.error)continue;
    const action=(turn.value.action as ResearchAction).action;
    if(['checkpoint','answer','answer_delta','read_bundle','read_source'].includes(action))workspace=contextProgress(workspace);
    if(action!=='read_context')continue;
    const result=latestFocus(store,[turn],question) as ContextLookup|null;
    if(!result)continue;
    const key=contextLookupKey(result);
    workspace={entries:[...workspace.entries.filter(e=>e.key!==key),{key,result}],sinceProgress:workspace.sinceProgress+1};
  }
  return workspace;
}

function contextReadKey(store: Store, observation: any, action: Extract<ResearchAction, { action: "read_context" }>, question: Revision<Question>) {
  const reading = readerSelection(store, observation, question);
  if (reading) return reading.key;
  const page = observation.page ?? null;
  const archive = store.get<any>(action.record.id, action.record.revision);
  if (archive?.kind !== "research-context") return canonical([action.record, action.pointer, page]);
  const parts = action.pointer.split("/");
  for (let end = parts.length; end > 1; end--) {
    const parent = contextValue(archive.value, parts.slice(0, end).join("/")) as any;
    const origin = parent?.source ?? parent?.ref;
    if (isRef(origin)) return canonical([origin, parts.slice(end), page, observation.value]);
  }
  return canonical([archive.value.draft.id, archive.value.question.id, action.pointer, page, observation.value]);
}

/** Compare the underlying reading, not its newly generated archive wrapper.
 * A/A and A/B/A both stop on the second unchanged request without a checkpoint. */
export function repeatedContextRead(store: Store, turns: Revision<ResearchTurn>[], question: Revision<Question>,
  afterTurn: number, observation: unknown, action: Extract<ResearchAction, { action: "read_context" }>) {
  const key = contextReadKey(store, observation, action, question);
  for (const turn of [...turns].reverse()) {
    if (turn.value.number <= afterTurn) break;
    if (turn.value.question?.id !== question.id) continue;
    const prior = turn.value.action as ResearchAction;
    if (prior.action === "checkpoint" || prior.action === "answer" || prior.action === "answer_delta") break;
    if (turn.value.error || turn.value.status !== "completed" || prior.action !== "read_context") continue;
    const oldFocus = latestFocus(store, [turn], question);
    if (!oldFocus) continue;
    const previous = contextReadKey(store, oldFocus, prior, question);
    if (key === previous) return reference(turn);
  }
  return null;
}

/** Compatibility for the saved pre-fix authority answer: append a replay, never
 * rewrite its history or reinterpret a semantic rejection as transport failure. */
export function recoverableAnswer(turns: Revision<ResearchTurn>[], question: Revision<Question>) {
  const latest = [...turns].reverse().find(turn => (turn.value.action as { question?: string })?.question === question.id
    && ["answer", "answer_delta"].includes(String((turn.value.action as { action?: string })?.action)));
  return latest?.value.status === "completed" && latest.value.error === "An input changed before the transaction could commit"
    && latest.value.assessment === null && latest.value.observation === null && latest.value.question
    && canonical(latest.value.question) === canonical(reference(question)) ? latest : null;
}

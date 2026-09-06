import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";
import { planningContext } from "./planning-context.js";
import { contextTable } from "./context-tables.js";

interface Archive { projectId: string; draft: Ref; question: Ref; body: Record<string, Json> }
export interface ContextPage { offset: number; limit: number }
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const instruction = "Full context is retained in working.archive in SQLite. sourceCatalogue is the complete inventory in column/row form, including exact source refs and locations; use it without reloading the inventory. Omitted collections are NOT empty, irrelevant or disproved. Use read_context with that record, a /body/... pointer and optional page:{offset,limit} to retrieve exact array items or UTF-16 string characters. working.sections gives addresses and sizes. readings and selectedContext retain recently requested materials together, newest first, within the fixed budget. Use these supplied materials for comparison instead of requesting them again; repeated unchanged reads without a checkpoint pause research. focus is the latest non-reader material, not the entire research. Save intermediate proposed findings using checkpoint with question,value,citations,unresolved; checkpoints are unassessed and never replace source evidence. Re-read exact sources for exceptions or contradictions. Never infer absence from the current window.";

export function contextValue(value: unknown, pointer: string): unknown {
  requireCondition(typeof pointer === "string" && (pointer === "" || pointer.startsWith("/")), "selector_invalid", "Use a JSON pointer");
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
    requireCondition(!/~(?![01])/.test(part), "selector_invalid", "Invalid pointer escape");
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    requireCondition(value !== null && typeof value === "object" && Object.hasOwn(value, key), "context_missing", "Context pointer does not exist");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function contextPage(value: unknown, page?: ContextPage) {
  if (!page) return { value };
  requireCondition(Number.isSafeInteger(page.offset) && page.offset >= 0 && Number.isSafeInteger(page.limit) && page.limit > 0
    && (typeof value === "string" || Array.isArray(value)), "context_page_invalid", "Page a string or array with nonnegative offset and positive limit");
  requireCondition(page.offset <= value.length, "context_page_invalid", "Page offset exceeds the original value");
  const end = Math.min(value.length, page.offset + page.limit);
  return { value: value.slice(page.offset, end), page: { offset: page.offset, end, total: value.length,
    unit: typeof value === "string" ? "utf16" : "items", next: end < value.length ? end : null } };
}

export function archivedContext(store: Store, draft: Revision<DiscoveryDraft>, ref: Ref) {
  const record = store.get<Archive>(ref.id, ref.revision);
  requireCondition(record?.kind === "research-context" && record.hash === ref.hash && record.value.projectId === draft.value.projectId
    && record.value.draft.id === draft.id && draft.value.questions.includes(record.value.question.id),
    "context_reference_foreign", "The context archive belongs to another research basis");
  const original = store.get<DiscoveryDraft>(record.value.draft.id, record.value.draft.revision);
  const question = store.get<Question>(record.value.question.id);
  requireCondition(original?.hash === record.value.draft.hash && canonical(original.value.inputs) === canonical(draft.value.inputs)
    && question?.revision === record.value.question.revision && question.hash === record.value.question.hash,
    "context_reference_stale", "The question or its research basis has changed");
  return record.value;
}

/** The complete request is a product journal entry, not a replacement source.
 * Only its bounded working projection crosses the provider boundary. */
export function workingContext(store: Store, projectId: string, draftId: string, questionId: string,
  context: unknown, maxChars: number): Record<string, any> {
  const draft = store.get<DiscoveryDraft>(draftId), question = store.get<Question>(questionId);
  requireCondition(draft?.kind === "discovery-draft" && question?.kind === "question" && draft.value.projectId === projectId
    && question.value.draftId === draftId && draft.value.questions.includes(questionId), "context_basis_missing", "A working set needs its exact question and draft");
  const body = JSON.parse(JSON.stringify(context)) as Record<string, Json>;
  const inventory = body['inventory'] as any;
  if (inventory?.sources && inventory.files) body['sourceCatalogue'] = {
    sources: contextTable(inventory.sources), files: inventory.files, filesTruncated: inventory.filesTruncated,
  } as Json;
  body['unresolvedEvidence'] = (Array.isArray(body['readings']) ? body['readings'] : []).flatMap((entry: any) =>
    Array.isArray(entry.unresolved) && entry.unresolved.length ? [{ reading: entry.ref ?? null, purpose: entry.purpose ?? null, unresolved: entry.unresolved }] : []);
  const value: Archive = { projectId, draft: reference(draft), question: reference(question), body };
  const id = `research-context:${hashJson(value)}`;
  const archive = store.get(id) ?? store.writeMany([{ id, kind: "research-context", expected: 0, value }],
    [reference(draft), reference(question), ...draft.value.inputs])[0]!;
  if (body['dispatchMode'] === "planning") return planningContext(body, reference(archive), maxChars);
  const mandatory = ["mapStatusFindings", "mapStatus", "researchScope", "role", "stage", "level", "consumer", "contextEncoding", "allowedConsumers", "gapFields", "graphBase",
    "core", "map", "draft", "question", "value", "representation", "consumerFeedback", "assessmentState", "openGaps", "failures", "unresolvedEvidence", "dispatchMode", "readPlanStatus", "sourceCatalogue", "sourceLocations", "synthesisState", "synthesisNotes", "previousProposalRef"];
  const packet: Record<string, any> = Object.fromEntries(mandatory.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  packet.working = { archive: reference(archive), instruction,
    sections: Object.entries(body).filter(([key]) => !mandatory.includes(key)).map(([key, v]) => ({
      pointer: `/body/${escape(key)}`, chars: JSON.stringify(v).length,
      count: Array.isArray(v) || typeof v === "string" ? v.length : null })), omitted: [] as string[] };
  // Defaults preserve the action protocol's collection shapes, not completeness.
  Object.assign(packet, { readings: [], directReadings: [], history: [], observations: [], checkpoints: [] });
  if (body['synthesisState']) {
    packet.previousProposal = body['previousProposal'] ?? null;
    packet.history = body['history'] ?? [];
  }
  const length = () => JSON.stringify(packet).length;
  if (length() > maxChars) throw new EngineError("pilot_core_limit", "Required intent, constraints or candidate exceed the working limit", { required: length() });
  const add = (key: string, v: unknown) => {
    const prior = packet[key]; packet[key] = v;
    if (length() <= maxChars - 512) return true;
    if (prior === undefined) delete packet[key]; else packet[key] = prior;
    return false;
  };
  // Reserve room for the addresses even when a value cannot be included.
  packet.working.omitted = Object.keys(body).filter(key => !mandatory.includes(key));
  if (length() > maxChars) throw new EngineError("pilot_core_limit", "Required context index exceeds the working limit", { required: length() });
  const isAssessor = Object.hasOwn(body, "assessmentState");
  packet.working.maxPageChars = Math.max(1, maxChars - length() - 512);
  if (body['synthesisState']) {
    const materials = body['synthesisMaterials'] as any[];
    const offset = (body['synthesisState'] as { offset: number }).offset;
    requireCondition(Array.isArray(materials) && Number.isSafeInteger(offset) && offset >= 0 && offset <= materials.length,
      "synthesis_cursor_invalid", "Invalid saved material cursor");
    packet.selectedContext = [];
    packet.synthesisPage = { offset, end: offset, total: materials.length, complete: offset === materials.length };
    for (let index = offset; index < materials.length; index++) {
      const selection = materials[index];
      const included = selection.kind === "reader" ? add("readings", [...packet.readings, selection.value])
        : add("selectedContext", [...packet.selectedContext, selection.value]);
      if (!included) break;
      packet.synthesisPage.end = index + 1;
      packet.synthesisPage.complete = index + 1 === materials.length;
    }
    if (packet.synthesisPage.end === offset && offset !== materials.length) {
      const first = materials[offset];
      const minimal = { ...packet, ...(first.kind === "reader" ? { readings: [first.value] } : { selectedContext: [first.value] }) };
      throw new EngineError("synthesis_material_limit", "One addressed material does not fit beside mandatory context", { required: JSON.stringify(minimal).length + 512 });
    }
    requireCondition(length() <= maxChars, "pilot_request_limit", "The synthesis page exceeds its fixed limit");
    return packet;
  }
  if (!isAssessor && Array.isArray(body['workingSelections']) && body['workingSelections'].length) {
    packet.selectedContext = [];
    for (const [index, selection] of (body['workingSelections'] as any[]).entries()) {
      if (body['sourceCatalogue'] && selection.value?.pointer === "/body/inventory"
        && canonical(selection.value.value) === canonical(inventory)) continue;
      const included = selection.kind === "reader" ? add("readings", [...packet.readings, selection.value])
        : packet.focus === undefined ? add("focus", selection.value) : add("selectedContext", [...packet.selectedContext, selection.value]);
      if (!included && index === 0) {
        packet.working.focusContinuation = { record: reference(archive), pointer: "/body/workingSelections/0/value",
          reason: "The newest requested material needs a smaller page; older material must not displace it" };
        break;
      }
    }
  } else if (body['focus']) {
    const focus = body['focus'];
    if (!isAssessor && typeof focus === "object" && !Array.isArray(focus) && Object.hasOwn(focus, "observations")) add("readings", [focus]);
    else add("focus", focus);
  }
  for (const key of isAssessor ? ["assessmentNotes"] : ["previousProposal", "currentProposal", "checkpoint", "inventory", "catalogue", "answers", "history", "openGaps", "failures"]) {
    if (key === "inventory" && body['sourceCatalogue']) continue;
    if (Object.hasOwn(body, key) && add(key, body[key])) packet.working.omitted = packet.working.omitted.filter((k: string) => k !== key);
  }
  // Explicitly requested materials coexist while they fit. Oldest materials
  // yield first; the full archive remains addressable.
  // Evidence pages for the assessor: concatenate fragments to recover the exact
  // serialized observations. No fragment is presented as a complete observation.
  if (Array.isArray(body['observations'])) {
    const encoded = JSON.stringify(body['observations']);
    const state = body['assessmentState'] as { offset?: number } | undefined;
    const offset = state?.offset ?? 0;
    requireCondition(Number.isSafeInteger(offset) && offset >= 0 && offset <= encoded.length, "assessment_cursor_invalid", "Invalid evidence cursor");
    const room = maxChars - length() - 512;
    if (offset === 0 && JSON.stringify(body['observations']).length + length() + 150 <= maxChars && add("observations", body['observations'])) {
      packet.evidencePage = { offset: 0, end: encoded.length, total: encoded.length, complete: true };
    } else {
      let lo = 0, hi = Math.max(0, Math.min(encoded.length - offset, room));
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (add("evidencePage", { offset, end: offset + mid, total: encoded.length, encoding: "json-string-fragment", text: encoded.slice(offset, offset + mid) })) lo = mid;
        else hi = mid - 1;
      }
      requireCondition(lo > 0 || offset === encoded.length, "pilot_evidence_limit", "No room for evidence; continue with a smaller working selection");
      add("evidencePage", { offset, end: offset + lo, total: encoded.length, encoding: "json-string-fragment", text: encoded.slice(offset, offset + lo) });
    }
  }
  requireCondition(length() <= maxChars, "pilot_request_limit", "The working request exceeds its fixed limit");
  return packet;
}

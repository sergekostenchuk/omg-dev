import { activeSynthesisNotes, consolidationInput } from './conclusion-consolidation.js';
import { FOUNDATION_FIELDS, contextSections, selectedQuestion, replaceFoundationCopies, candidateDelta, originalIndex, compactConclusions, CONCLUSION_ENCODING, correctionIndex } from "./continuation-packet.js";
import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";
import { planningContext } from "./planning-context.js";
import { contextTable } from "./context-tables.js";
import { packContextWorkspace } from "./context-workspace.js";
import { priorEvidenceSources, packPriorEvidence } from './prior-evidence-summary.js';

interface Archive { projectId: string; draft: Ref; question: Ref; body: Record<string, Json> }
export interface ContextPage { offset: number; limit: number }
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
  context: unknown, maxChars: number, options: { continuation?: boolean; common?: boolean; previous?: Ref; contextChars?: number; extractedChars?:number; purpose?: string } = {}): Record<string, any> {
  const draft = store.get<DiscoveryDraft>(draftId), question = store.get<Question>(questionId);
  requireCondition(draft?.kind === "discovery-draft" && question?.kind === "question" && draft.value.projectId === projectId
    && question.value.draftId === draftId && draft.value.questions.includes(questionId), "context_basis_missing", "A working set needs its exact question and draft");
  let body = JSON.parse(JSON.stringify(context)) as Record<string, any>;
  const priorSources=priorEvidenceSources(body['priorEvidence']??[]);
  if(priorSources.length)body['priorEvidenceSources']=priorSources;
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
  const archivedBody = body;
  const relatedResearch = body['discoveryContext'];
  const hasQuestion = Object.hasOwn(body, 'question') || Object.hasOwn(body, 'questions') || (options.purpose ?? body['role']) !== 'reader';
  const selected = hasQuestion ? selectedQuestion(question, archivedBody) : null;
  const contract = selected ? { id: question.id, ...question.value.spec } : null;
  const projectedQuestion = selected ? { ...selected.question,
    ...(selected.schemaPointer && body['dispatchMode'] !== 'consolidation'
      ? { schemaAddress: { record: reference(archive), pointer: selected.schemaPointer } } : {}) } : null;
  if (projectedQuestion) body = { ...body, question: projectedQuestion,
    ...(Object.hasOwn(body, 'questions') ? { questions: [projectedQuestion] } : {}) };
  const finish = (packet: Record<string, any>) => {
    if (relatedResearch !== undefined) requireCondition(packet.discoveryContext
      && canonical(packet.discoveryContext) === canonical(relatedResearch),
    'context_discovery_incomplete', `[${question.id}] The packed question lost its accepted research grounds`);
    if (contract) {
      for (const [field, expected] of Object.entries(contract))
        requireCondition(packet.question && Object.hasOwn(packet.question, field)
          && canonical(packet.question[field]) === canonical(expected),
        'context_question_incomplete', `[${question.id}] The packed question lost ${field}`);
    }
    requireCondition(JSON.stringify(packet).length <= maxChars, 'pilot_core_limit',
      `[${question.id}] The complete question and required material exceed the working limit`);
    return packet;
  };
  if (body['dispatchMode'] === 'consolidation') {
    requireCondition(Array.isArray(body['synthesisNotes']) && body['consolidation']
      && Number.isSafeInteger(body['consolidation'].targetChars) && body['consolidation'].targetChars > 0,
    'consolidation_context_invalid', 'Consolidation needs its saved notes and bounded output target');
    const packet = { dispatchMode: 'consolidation', question: projectedQuestion,
      ...(relatedResearch === undefined ? {} : { discoveryContext: relatedResearch }),
      synthesisSession: body['synthesisSession'], synthesisState: body['synthesisState'],
      consolidation: {...consolidationInput(body['synthesisNotes'], body['consolidation'].targetChars, body['consolidation'].format === 2 ? 2 : 1),
        ...(body['consolidation'].tightening ? {tightening:body['consolidation'].tightening} : {})},
      working: { archive: reference(archive), instruction: 'Original notes are immutable at /body/synthesisNotes. No new material is delivered in this step.',
        sections: [{ pointer: '/body/synthesisNotes' }] } };
    requireCondition(JSON.stringify(packet).length <= maxChars, 'consolidation_input_limit',
      'The notes-only consolidation request exceeds the fixed ceiling; do not raise it or repeat a paid call');
    return finish(packet);
  }
  if (options.common && !options.continuation && !body['core'] && !body['synthesisState'] && !body['assessmentState']) {
    const {priorEvidence:_priorEvidence,priorEvidenceSources:_priorEvidenceSources,...initialBody}=body;
    const initial:Record<string,any>={...initialBody,working:{archive:reference(archive),instruction,sections:contextSections(archivedBody)}};
    if (initial.inventory) delete initial.sourceCatalogue;
    packContextWorkspace(initial,maxChars,options.contextChars);
    packPriorEvidence(initial,priorSources,reference(archive),maxChars);
    requireCondition(JSON.stringify(initial).length<=maxChars,'pilot_core_limit','Initial question context exceeds its declared envelope bound');
    return finish(initial);
  }
  if (options.continuation) {
    const previousBody=options.previous?store.get<Archive>(options.previous.id,options.previous.revision)?.value.body:undefined;
    const mapMaterial = (value: Record<string, any> | undefined) => Array.isArray(value?.['prerequisites'])
      ? value['prerequisites'].find((item: any) => item.stage === 'concept')?.operationMapMaterial : undefined;
    const currentMapMaterial = mapMaterial(body);
    // A previously delivered request may predate L1A. Its archive is not evidence
    // that this catalogue (or the external systems accompanying it) was sent.
    const newMapPrerequisites = currentMapMaterial
      && canonical(currentMapMaterial) !== canonical(mapMaterial(previousBody) ?? null) ? body['prerequisites'] : undefined;
    const originals=originalIndex(body,previousBody);
    const dynamic: Record<string, any> = Object.fromEntries(Object.entries(body).filter(([key]) => !FOUNDATION_FIELDS.includes(key as typeof FOUNDATION_FIELDS[number])));
    if (body['previousProposal']) {
      const changes=previousBody?candidateDelta(previousBody['previousProposal'],body['previousProposal']):[];
      dynamic['proposalChanges']={current:{record:reference(archive),pointer:'/body/previousProposal'},base:options.previous??null,changes};
    }
    if (Object.hasOwn(body,'value') && !body['assessmentState']) {
      const previous=options.previous ? store.get<Archive>(options.previous.id, options.previous.revision) : null;
      if(previous) requireCondition(previous.hash===options.previous!.hash && previous.value.projectId===projectId
        && previous.value.question.id===questionId,'continuation_foreign','Candidate delta requires the same question');
      dynamic['candidate']={current:{record:reference(archive),pointer:'/body/value'},
        previous:options.previous??null,changes:previous?candidateDelta(previous.value.body['value'],body['value']):[],
        instruction:'Only changed candidate fields are supplied; exact full candidates remain at their addresses.'};
    }
    if(body['assessmentState']) dynamic['value']=body['value'];
    dynamic['answerContext']={allowedConsumers:body['allowedConsumers']??[],gapFields:body['gapFields']??[],
      scope:body['researchScope']?{outcome:body['researchScope'].outcome,nodes:body['researchScope'].nodes,
        deferred:body['researchScope'].obligations.filter((o:any)=>o.state==='deferred').map((o:any)=>({id:o.gap.id,target:o.gap.target,wake:o.wake,
          ...(o.assignment?{moment:o.assignment.moment,consumer:o.assignment.responsibleConsumer,returnCondition:o.assignment.returnCondition}: {})}))}:null};
    dynamic['originals']=originals;
    const candidate=dynamic['candidate'],proposalChanges=dynamic['proposalChanges'],assessmentValue=dynamic['value'];
    const original=body;
    body = replaceFoundationCopies(dynamic, body, reference(archive), store);
    if (newMapPrerequisites) body['prerequisites'] = newMapPrerequisites;
    if (projectedQuestion) { body['question'] = projectedQuestion; if (Object.hasOwn(original, 'questions')) body['questions'] = [projectedQuestion]; }
    if(original['assessmentState'])body['value']=assessmentValue;
    if(relatedResearch !== undefined)body['discoveryContext']=relatedResearch;
    if(candidate) body['candidate']=replaceFoundationCopies(candidate,{...original,value:undefined},reference(archive),store);
    if(proposalChanges) body['proposalChanges']=replaceFoundationCopies(proposalChanges,{...original,previousProposal:undefined},reference(archive),store);
  }
  if (options.common && options.continuation && body['dispatchMode']==='planning') {
    body['corrections']=(body['history'] as any[] ?? []).filter(t=>t.error).map(t=>({number:t.number,action:t.action,error:t.error,feedback:t.feedback}));
    delete body['history'];
  }
  if (options.common) {
    const conclusions=compactConclusions((body['synthesisNotes'] ? activeSynthesisNotes(body['synthesisNotes']) : undefined) ?? body['assessmentNotes'] ?? body['checkpoints'] ?? body['previousProposal'] ?? (body['history'] as any[] ?? []).filter(h=>h.action?.question===questionId && ['checkpoint','answer','answer_delta'].includes(h.action.action)).map(h=>({proposal:h.action})));
    body['conclusions']=conclusions.items; body['conclusionCitations']=conclusions.citations;
    body['conclusionRefs']=conclusions.references; body['conclusionUnresolved']=conclusions.unresolved; body['conclusionEncoding']=CONCLUSION_ENCODING;
    if(body['history']) {
      const history=body['history'] as any[];
      const read=[...history].reverse().find(h=>h.action && typeof h.action==='object' && ['read','read_source','read_context','search','web_search','web_fetch'].includes(h.action.action));
      if(read) body['currentRead']=read;
      body['corrections']=correctionIndex(history,reference(archive));delete body['history'];
    }
    delete body['synthesisNotes']; delete body['assessmentNotes']; delete body['checkpoints'];
  }
  if (body['dispatchMode'] === "planning" && !options.continuation) {
    const reserved = relatedResearch === undefined ? 0 : JSON.stringify({discoveryContext:relatedResearch}).length;
    const packet = planningContext(body,reference(archive),maxChars-reserved,options.contextChars,archivedBody);
    if(relatedResearch !== undefined)packet.discoveryContext=relatedResearch;
    return finish(packet);
  }
  const mandatory = ["discoveryContext", "webResearch", "answerContext", "contextWorkspace", "savedEvidence", "conclusions", "conclusionCitations", "conclusionRefs", "conclusionUnresolved", "conclusionEncoding", "contextControls", "currentRead", "originals", "corrections", "request", "candidate", "proposalChanges", "purpose", "sources", "questions", "prerequisites", "operationMap", "researchMissing", "fields", "mapStatusFindings", "mapStatus", "researchScope", "role", "stage", "level", "consumer", "contextEncoding", "allowedConsumers", "gapFields", "graphBase",
    "core", "map", "draft", "question", "value", "representation", "consumerFeedback", "assessmentState", "openGaps", "failures", "unresolvedEvidence", "dispatchMode", "readPlanStatus", "sourceCatalogue", "sourceLocations", "bases", "runtimeProofs", "synthesisState", "synthesisNotes", "previousProposalRef"];
  if(body['assessmentState']) mandatory.splice(mandatory.indexOf("value"),1);
  const ordered = options.common && !options.continuation
    ? [...mandatory.filter(key=>FOUNDATION_FIELDS.includes(key as any)),...mandatory.filter(key=>!FOUNDATION_FIELDS.includes(key as any))] : mandatory;
  const packet: Record<string, any> = Object.fromEntries(ordered.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  packet.working = { archive: reference(archive), instruction,
    sections: contextSections(archivedBody, Object.keys(archivedBody).filter(key => !mandatory.includes(key))).map(section => {
      const value = contextValue({ body: archivedBody }, section.pointer);
      return { ...section, chars: JSON.stringify(value).length,
        count: Array.isArray(value) || typeof value === 'string' ? value.length : null };
    }), omitted: [] as string[] };
  // Defaults preserve the action protocol's collection shapes, not completeness.
  Object.assign(packet, { readings: [], directReadings: [], history: [], observations: [], checkpoints: [] });
  const retained = body['contextControls']?.version === 2 && body['synthesisState'];
  const conclusionKeys = ['conclusions','conclusionCitations','conclusionRefs','conclusionUnresolved','conclusionEncoding'];
  const carry = Object.fromEntries(conclusionKeys.filter(key => Object.hasOwn(packet,key)).map(key => [key,packet[key]]));
  if (retained) for (const key of conclusionKeys) delete packet[key];
  packContextWorkspace(packet,maxChars,options.contextChars,retained ? {checkpointedKeys:body['contextCheckpointedKeys']??[]} : undefined);
  if (retained) {
    const total = Math.max(0,maxChars-JSON.stringify(packet).length-2176);
    const dictionaries = {...carry}; delete dictionaries['conclusions'];
    const items = Math.max(0,total-JSON.stringify(dictionaries).length-128);
    Object.assign(packet,carry);
    packet.conclusionCapacity = {total,items};
    if (JSON.stringify(packet).length > maxChars-1024) throw new EngineError('consolidation_required',
      'Preserve the delivered context and compact the conclusions before the next paid call', {targetChars:items,fullTargetChars:total,requiredChars:JSON.stringify(packet).length,maxChars,limitChars:maxChars-1024,deficitChars:JSON.stringify(packet).length-(maxChars-1024)});
  }
  packPriorEvidence(packet,priorSources,reference(archive),maxChars);
  if (body['synthesisState']) {
    if (!options.common) {packet.previousProposal = body['previousProposal'] ?? null; packet.history = body['history'] ?? [];}
  }
  if (options.common && body['synthesisState'] && body['focus'] && !body['contextWorkspace']) packet.focus=body['focus'];
  const length = () => JSON.stringify(packet).length;
  if (length() > maxChars) throw new EngineError("pilot_core_limit", "Required intent, constraints or candidate exceed the working limit", { required: length() });
  const add = (key: string, v: unknown) => {
    const prior = packet[key]; packet[key] = v;
    if (length() <= maxChars - 512) return true;
    if (prior === undefined) delete packet[key]; else packet[key] = prior;
    return false;
  };
  // Reserve room for the addresses even when a value cannot be included.
  packet.working.omitted = Object.keys(archivedBody).filter(key => !mandatory.includes(key));
  if (length() > maxChars) throw new EngineError("pilot_core_limit", "Required context index exceeds the working limit", { required: length() });
  const isAssessor = Object.hasOwn(body, "assessmentState");
  packet.working.maxPageChars = Math.max(1, maxChars - length() - 512);
  if (body['synthesisState']) {
    const materials = body['synthesisMaterials'] as any[];
    const offset = (body['synthesisState'] as { offset: number }).offset;
    const materialOffset = (body['synthesisState'] as { materialOffset?: number }).materialOffset ?? 0;
    requireCondition(Array.isArray(materials) && Number.isSafeInteger(offset) && offset >= 0 && offset <= materials.length,
      "synthesis_cursor_invalid", "Invalid saved material cursor");
    packet.selectedContext = [];
    packet.synthesisPage = { offset, end: offset, total: materials.length, complete: offset === materials.length };
    for (let index = offset; index < materials.length; index++) {
      const selection = materials[index];
      if(selection.kind==='reader'&&JSON.stringify(selection.value).length>(options.extractedChars??Number.MAX_SAFE_INTEGER))break;
      const included = materialOffset === 0 && (selection.kind === "reader" ? add("readings", [...packet.readings, selection.value])
        : add("selectedContext", [...packet.selectedContext, selection.value]));
      if (!included) break;
      packet.synthesisPage.end = index + 1;
      packet.synthesisPage.complete = index + 1 === materials.length;
    }
    if (packet.synthesisPage.end === offset && offset !== materials.length) {
      const first = materials[offset];
      if (!options.common) {
        const minimal = { ...packet, ...(first.kind === "reader" ? { readings: [first.value] } : { selectedContext: [first.value] }) };
        throw new EngineError("synthesis_material_limit", "One addressed material does not fit beside mandatory context", { required: JSON.stringify(minimal).length + 512 });
      }
      const encoded = JSON.stringify(first.value);
      const pageLimit=first.kind==='reader'?(options.extractedChars??Number.MAX_SAFE_INTEGER):Number.MAX_SAFE_INTEGER;
      requireCondition(Number.isSafeInteger(materialOffset) && materialOffset >= 0 && materialOffset < encoded.length,
        "synthesis_cursor_invalid", "Invalid character cursor in a saved material");
      let lo = 0, hi = encoded.length - materialOffset;
      const piece = (n: number) => ({ index: offset, offset: materialOffset, end: materialOffset + n, total: encoded.length,
        encoding: "json-string-fragment", original: { record: reference(archive), pointer: `/body/synthesisMaterials/${offset}/value` },
        text: encoded.slice(materialOffset, materialOffset + n) });
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (JSON.stringify(piece(mid)).length<=pageLimit&&add("materialPage", piece(mid))) lo = mid; else hi = mid - 1;
      }
      requireCondition(lo > 0, "continuation_carry_limit", "Saved conclusions leave no room for the next material; compact conclusions instead of increasing the ceiling");
      add("materialPage", piece(lo));
      packet.synthesisPage.nextMaterialOffset = materialOffset + lo === encoded.length ? 0 : materialOffset + lo;
      packet.synthesisPage.end = packet.synthesisPage.nextMaterialOffset === 0 ? offset + 1 : offset;
      packet.synthesisPage.complete = packet.synthesisPage.end === materials.length;
    }
    if (packet.contextControls?.version === 2 && packet.synthesisPage.complete) {
      packet.contextControls = {...packet.contextControls,stage:'final',
        mode:'finalization'};
    }
    requireCondition(length() <= maxChars, "pilot_request_limit", "The synthesis page exceeds its fixed limit");
    return finish(packet);
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
  for (const key of isAssessor ? (options.common ? [] : ["assessmentNotes"]) : ["previousProposal", "currentProposal", "checkpoint", "inventory", "catalogue", "answers", "history", "openGaps", "failures"]) {
    if (options.continuation && FOUNDATION_FIELDS.includes(key as typeof FOUNDATION_FIELDS[number])) continue;
    if (key === "inventory" && body['sourceCatalogue']) continue;
    if (Object.hasOwn(body, key) && add(key, body[key])) packet.working.omitted = packet.working.omitted.filter((k: string) => k !== key);
  }
  // Explicitly requested materials coexist while they fit. Oldest materials
  // yield first; the full archive remains addressable.
  if(isAssessor && Object.hasOwn(body,'value')) {
    const encoded=JSON.stringify(body['value']);
    const offset=(body['assessmentState'] as {candidateOffset?:number}).candidateOffset??0;
    requireCondition(Number.isSafeInteger(offset)&&offset>=0&&offset<=encoded.length,'assessment_cursor_invalid','Invalid candidate cursor');
    if(encoded.length+length()+512<maxChars/1.2 && add('value',body['value'])) {
      packet.candidatePage={offset:0,end:encoded.length,total:encoded.length,complete:true};
    }else{
      const limit=length()+Math.max(0,Math.floor((maxChars-length()-1024)/2));
      let lo=0,hi=encoded.length-offset;
      const piece=(n:number)=>({offset,end:offset+n,total:encoded.length,complete:offset+n===encoded.length,encoding:'json-string-fragment',text:encoded.slice(offset,offset+n),original:{record:reference(archive),pointer:'/body/value'}});
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);packet.candidatePage=piece(mid);if(length()<=limit)lo=mid;else hi=mid-1;}
      packet.candidatePage=piece(lo);
      requireCondition(lo>0||offset===encoded.length,'continuation_packet_limit','No room for candidate evidence; split the assessment contract');
    }
  }
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
        if (add("evidencePage", { offset, end: offset + mid, total: encoded.length, complete:offset+mid===encoded.length, encoding: "json-string-fragment", text: encoded.slice(offset, offset + mid) })) lo = mid;
        else hi = mid - 1;
      }
      requireCondition(lo > 0 || offset === encoded.length, "pilot_evidence_limit", "No room for evidence; continue with a smaller working selection");
      add("evidencePage", { offset, end: offset + lo, total: encoded.length, complete:offset+lo===encoded.length, encoding: "json-string-fragment", text: encoded.slice(offset, offset + lo) });
    }
  }
  requireCondition(length() <= maxChars, "pilot_request_limit", "The working request exceeds its fixed limit");
  return finish(packet);
}

import { sameSubject, type V7PlanSubject } from './v7-managed-attempt.js';
import { STAGE_NEIGHBOR_CONTEXT } from './stage-neighbors.js';
import { activeSynthesisNotes, consolidationInput, consolidationPage, consolidationFragment,
  CONSOLIDATION_DELIVERY, CONSOLIDATION_FRAGMENT } from './conclusion-consolidation.js';
import { proveAssessmentTransportSubject, sameAssessmentSubject, assessmentQuestionContract, type AssessmentTransportSubject, FOUNDATION_FIELDS, contextSections, selectedQuestion, packetPlanSubject, planQuestionContract, replaceFoundationCopies, candidateDelta, originalIndex, compactConclusions, CONCLUSION_ENCODING, correctionIndex } from "./continuation-packet.js";
import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { isRef, reference, stageId, type Ref } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";
import { planningContext, requirePlanningNavigation } from "./planning-context.js";
import { contextTable } from "./context-tables.js";
import { contextLookupKey, packContextWorkspace, requireExactContextWorkspace, type ContextLookup } from "./context-workspace.js";
import { exactContextLookup, projectResearchContextSelection, type ProjectedContextRead } from './research-consumer-transition.js';
import { readReaderResultAt } from './reader.js';
import { priorEvidenceSources, packPriorEvidence } from './prior-evidence-summary.js';
import { addressArchivedMaterials, serveArchivedMaterial, packAddressedValue,
  requirePacketMaterialDelivery, planResearchDelivery, type AddressedOriginal } from './research-delivery.js';

interface Archive { projectId: string; draft: Ref; question: Ref; subject?: V7PlanSubject; body: Record<string, Json> }
export interface ContextPage { offset: number; limit: number; encoding?: 'canonical-json' }
const instruction = "Full context is retained in working.archive in SQLite. sourceCatalogue lists exact source refs and locations; a structured source TOC may be paged, with total, next and the exact archive address of every section. A heading is navigation, not a reading of its body. Omitted collections are NOT empty, irrelevant or disproved. Use read_context with that record, a /body/... pointer and optional page:{offset,limit} to retrieve exact array items or UTF-16 string characters. An oversized requested page is delivered as a positive bounded range with its exact requested, served page and next; the original remains unchanged. The read envelope limit is declared in the result as envelopeLimitChars when clipping occurs. For an oversized object or single array item, page:{offset,limit,encoding:'canonical-json'} reads exact UTF-16 characters of its canonical JSON; continue at served.next without treating a fragment as the complete value. working.sections gives addresses and sizes. readings and selectedContext retain recently requested materials together, newest first, within the fixed budget. Use these supplied materials for comparison instead of requesting them again; repeated unchanged reads without a checkpoint pause research. focus is the latest non-reader material, not the entire research. Save intermediate proposed findings using checkpoint with question,value,citations,unresolved; checkpoints are unassessed and never replace source evidence. Re-read exact sources for exceptions or contradictions. Never infer absence from the current window.";

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
    && (page.encoding === undefined || page.encoding === 'canonical-json')
    && (page.encoding === 'canonical-json' || typeof value === "string" || Array.isArray(value)),
    "context_page_invalid", "Page a string, array, or canonical JSON with nonnegative offset and positive limit");
  const original = page.encoding === 'canonical-json' ? canonical(value) : value as string | unknown[];
  requireCondition(page.offset <= original.length, "context_page_invalid", "Page offset exceeds the original value");
  const end = Math.min(original.length, page.offset + page.limit);
  return { value: original.slice(page.offset, end), page: { offset: page.offset, end, total: original.length,
    unit: (page.encoding === 'canonical-json' || typeof original === "string" ? "utf16" : "items") as 'utf16' | 'items',
    next: end < original.length ? end : null,
    ...(page.encoding === 'canonical-json' ? { encoding: page.encoding } : {}) } };
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
function structuredCatalogue(inventory: any, archive: Ref, maxChars: number): Record<string, any> {
  const sources = inventory.sources.map((source: any, index: number) => {
    if (source.toc?.contract !== 'source-toc/v1') return source;
    requireCondition(Array.isArray(source.toc.sections) && typeof source.structureHash === 'string',
      'source_toc_invalid', 'A structured source needs its exact section index and hash');
    const sections = source.toc.sections as Record<string, any>[];
    return { ...source, toc: { contract: 'source-toc-page/v1', structureHash: source.structureHash,
      total: sections.length, next: sections.length ? 0 : null, sections: [],
      address: { record: archive, pointer: `/body/inventory/sources/${index}/toc/sections` } } };
  });
  const catalogue = { sources, ...(Object.hasOwn(inventory, 'files') ? { files: inventory.files } : {}),
    ...(Object.hasOwn(inventory, 'filesTruncated') ? { filesTruncated: inventory.filesTruncated } : {}) };
  const target = Math.max(512, Math.floor(maxChars / 4));
  for (const [index, source] of inventory.sources.entries()) {
    if (source.toc?.contract !== 'source-toc/v1') continue;
    const page = sources[index].toc;
    for (const section of source.toc.sections) {
      page.sections.push(section);
      if (JSON.stringify(catalogue).length > target) { page.sections.pop(); break; }
    }
    page.next = page.sections.length < page.total ? page.sections.length : null;
  }
  return { ...catalogue, sources: contextTable(sources) };
}

function conclusionSources(body: Record<string, any>, archive: Ref, questionId: string): AddressedOriginal[] {
  for (const field of ['synthesisNotes', 'assessmentNotes', 'checkpoints', 'previousProposal']) {
    if (body[field] !== undefined) return [{ record: archive, pointer: `/body/${field}`, value: body[field] }];
  }
  return (Array.isArray(body['history']) ? body['history'] : []).flatMap((turn: any, index: number) =>
    turn.action?.question === questionId && ['checkpoint', 'answer', 'answer_delta'].includes(turn.action.action)
      ? [{ record: archive, pointer: `/body/history/${index}/action`, value: turn.action }] : []);
}

export function workingContext(store: Store, projectId: string, draftId: string, questionId: string,
  context: unknown, maxChars: number, options: { continuation?: boolean; common?: boolean; previous?: Ref; contextChars?: number; extractedChars?:number; purpose?: string; subject?: V7PlanSubject | null; assessmentSubject?: AssessmentTransportSubject | null } = {}): Record<string, any> {
  const draft = store.get<DiscoveryDraft>(draftId), question = store.get<Question>(questionId);
  requireCondition(draft?.kind === "discovery-draft" && question?.kind === "question" && draft.value.projectId === projectId
    && question.value.draftId === draftId && draft.value.questions.includes(questionId), "context_basis_missing", "A working set needs its exact question and draft");
  let body = JSON.parse(JSON.stringify(context)) as Record<string, any>;
  const planSubject = packetPlanSubject(options);
  const assessmentSubject = proveAssessmentTransportSubject(store, body, projectId, reference(question));
  requireCondition(sameAssessmentSubject(body, options.assessmentSubject ? {assessmentSubject:options.assessmentSubject} : {}),
    'discovery_assessment_subject_invalid', 'The packer must retain its admitted assessment subject');
  requireCondition(!assessmentSubject || !planSubject && options.purpose === 'assessor',
    'discovery_assessment_subject_invalid', 'An assessment packet belongs only to its assessor');
  const assessmentContract = assessmentSubject ? assessmentQuestionContract(assessmentSubject) : null;
  if (assessmentContract) {
    for (const supplied of [body['question'], ...(Array.isArray(body['questions']) ? body['questions'] : [])].filter(q => q !== undefined))
      requireCondition(supplied && typeof supplied === 'object' && !Array.isArray(supplied)
        && Object.entries(supplied).every(([key,value]) => Object.hasOwn(assessmentContract,key)
          && canonical(value) === canonical(assessmentContract[key as keyof typeof assessmentContract])),
        'discovery_assessment_subject_invalid', 'An assessment cannot use the plan FieldSpec as its result contract');
    body = {...body, question:assessmentContract};
  }
  const planContract = planSubject ? planQuestionContract(store, draft, question, planSubject) : null;
  if (planSubject && Object.hasOwn(body, 'subject')) requireCondition(sameSubject(packetPlanSubject(body), planSubject),
    'research_plan_subject_invalid', 'Context cannot select a different plan subject');
  if (planContract) {
    requireCondition(!Object.hasOwn(body,'questions') || Array.isArray(body['questions']),
      'research_plan_subject_invalid','The supplied plan-question collection must be an array');
    if (Array.isArray(body['history'])) body['history'] = body['history'].filter((turn:any) =>
      turn && sameSubject(packetPlanSubject(turn),planSubject));
    // Validate supplied question fields against the accepted plan item, never
    // reinterpret the plan Question's FieldSpec as an attempt schema.
    for (const supplied of [body['question'], ...(body['questions'] ?? [])].filter(q => q !== undefined)) {
      requireCondition(supplied && typeof supplied === 'object' && !Array.isArray(supplied)
        && Object.entries(supplied).every(([key,value]) => Object.hasOwn(planContract,key)
          && canonical(value) === canonical(planContract[key as keyof typeof planContract])),
        'research_plan_subject_invalid', 'The supplied question differs from its accepted plan question');
    }
    body = {...body, subject:planSubject, question:planContract,
      ...(Object.hasOwn(body,'questions')?{questions:[planContract]}:{})};
  }
  if ((planSubject || assessmentSubject) && options.previous) {
    const previous = store.get<Archive>(options.previous.id,options.previous.revision);
    requireCondition(previous?.hash === options.previous.hash && previous.value.projectId === projectId
      && previous.value.question.id === questionId && sameAssessmentSubject(previous.value.body,body) && sameSubject(packetPlanSubject(previous.value),planSubject),
      'continuation_foreign','The previous archive belongs to another exact subject');
  }

  if (Object.hasOwn(body, 'contextWorkspace')) requireExactContextWorkspace(body['contextWorkspace'], result => {
    const delivered = result as ProjectedContextRead;
    const clipped = delivered.contract === 'research-context-read/v2';
    const selected = clipped ? delivered.requested : delivered.page;
    const page = selected ? { offset: selected.offset,
      limit: clipped ? (selected as NonNullable<ProjectedContextRead['requested']>).limit
        : Math.max(1, selected.end - selected.offset),
      ...(selected.encoding ? { encoding: selected.encoding } : {}) } : undefined;
    try {
      const original = exactContextLookup(store, draft, question, result.record, result.pointer,
        clipped ? undefined : page,
        record => { readReaderResultAt(store, projectId, reference(record)); });
      return clipped
        ? projectResearchContextSelection(original.value, result.record, result.pointer, page,
          delivered.envelopeLimitChars ?? 0, 'bounded') : original;
    } catch (error) {
      if (error instanceof EngineError && ['context_reference_foreign', 'context_missing',
        'selector_invalid', 'context_page_invalid'].includes(error.code))
        throw new EngineError('research_context_undelivered',
          'The supplied context lookup is not an exact saved original');
      throw error;
    }
  });
  // The archive that owns a newly paid step fixes its context-read era. A
  // historical archive without this marker keeps the original size refusal.
  body['contextReadContract'] = 'research-context-read/v2';
  if (draft.value.contractVersion === 6 && ['concept', 'specification'].includes(draft.value.stage)) requireCondition(
    body['discoveryBasisCatalogue']?.contract === 'discovery-basis-catalogue/v1'
      && isRef(body['discoveryBasisCatalogue'].source)
      && Array.isArray(body['discoveryBasisCatalogue'].constraints)
      && body['discoveryBasisCatalogue'].variant !== undefined,
    'context_discovery_incomplete', `[${question.id}] ${draft.value.stage} v6 needs the exact accepted Discovery basis catalogue`);
  if (draft.value.contractVersion === 6 && draft.value.stage === 'specification') requireCondition(
    draft.value.inputs.filter(ref => ref.id === stageId(projectId, 'concept')).length === 1
      && Array.isArray(body['prerequisites']) && body['prerequisites'].filter((row: any) => row?.stage === 'concept'
        && isRef(row?.ref) && draft.value.inputs.some(ref => canonical(ref) === canonical(row.ref))
        && Array.isArray(row?.fields?.conceptSections)).length === 1,
    'context_discovery_incomplete', `[${question.id}] Specification v6 needs its exact accepted concept requirements`);
  const priorSources=priorEvidenceSources(body['priorEvidence']??[]);
  if(priorSources.length)body['priorEvidenceSources']=priorSources;
  const inventory = body['inventory'] as any;
  const hasStructuredSources = Array.isArray(inventory?.sources)
    && inventory.sources.some((source: any) => source?.toc?.contract === 'source-toc/v1');
  if (!hasStructuredSources && inventory?.sources && inventory.files) body['sourceCatalogue'] = {
    sources: contextTable(inventory.sources), files: inventory.files, filesTruncated: inventory.filesTruncated,
  } as Json;
  body['unresolvedEvidence'] = (Array.isArray(body['readings']) ? body['readings'] : []).flatMap((entry: any) =>
    Array.isArray(entry.unresolved) && entry.unresolved.length ? [{ reading: entry.ref ?? null, purpose: entry.purpose ?? null, unresolved: entry.unresolved }] : []);
  const value: Archive = { projectId, draft: reference(draft), question: reference(question), ...(planSubject?{subject:planSubject}:{}), body };
  const id = `research-context:${hashJson(value)}`;
  let archive = store.get(id) ?? store.writeMany([{ id, kind: "research-context", expected: 0, value }],
    [reference(draft), reference(question), ...draft.value.inputs])[0]!;
  let archivedBody = body;
  const exactArchivedFields = (packet: Record<string, any>, fields: string[]) => fields.filter(field =>
    Object.hasOwn(packet, field) && packet[field] !== undefined
      && Object.hasOwn(archivedBody, field)
      && canonical(packet[field]) === canonical(archivedBody[field]));
  const materialRecord = (field: string, material: unknown): Ref => {
    const stable: Archive = { projectId, draft: reference(draft), question: reference(question), ...(planSubject?{subject:planSubject}:{}),
      body: { [field]: material as Json } };
    const stableId = `research-context:${hashJson(stable)}`;
    const saved = store.get(stableId) ?? store.writeMany([
      { id: stableId, kind: 'research-context', expected: 0, value: stable }],
      [reference(draft), reference(question), ...draft.value.inputs])[0]!;
    return reference(saved);
  };
  const sourceNavigation = hasStructuredSources ? structuredCatalogue(inventory, reference(archive), maxChars) : null;
  const plannerCorrections = options.common && options.continuation && body['dispatchMode'] === 'planning'
    ? correctionIndex(body['history'] as any[] ?? [], reference(archive)) : null;
  if (sourceNavigation || plannerCorrections?.length) {
    // Computed transport projections are immutable originals too. Keep the
    // raw first archive for their embedded source pointers, then bind the
    // projected values to a second exact archive before measuring any packet.
    const first = reference(archive);
    archivedBody = { ...body,
      ...(sourceNavigation ? { sourceCatalogue: sourceNavigation } : {}),
      ...(plannerCorrections?.length ? { corrections: plannerCorrections } : {}) };
    const projected: Archive = { projectId, draft: reference(draft), question: reference(question), ...(planSubject?{subject:planSubject}:{}), body: archivedBody };
    const projectedId = `research-context:${hashJson(projected)}`;
    archive = store.get(projectedId) ?? store.writeMany([
      { id: projectedId, kind: 'research-context', expected: 0, value: projected }],
      [reference(draft), reference(question), ...draft.value.inputs, first])[0]!;
    body = archivedBody;
  }
  const relatedResearch = body['discoveryContext'];
  const relatedCatalogue = body['discoveryBasisCatalogue'];
  const neighborMaterial = body['assessmentContextContract'] === STAGE_NEIGHBOR_CONTEXT
    ? { assessmentContextContract: STAGE_NEIGHBOR_CONTEXT, stageNeighbors: body['stageNeighbors'] } : null;
  if (neighborMaterial) requireCondition(neighborMaterial.stageNeighbors?.contract === 'stage-neighbors/v1',
    'context_stage_neighbors_incomplete', `[${question.id}] The assessor needs its declared stage material`);
  const hasQuestion = Object.hasOwn(body, 'question') || Object.hasOwn(body, 'questions') || (options.purpose ?? body['role']) !== 'reader';
  const responseContract = assessmentContract ?? planContract;
  const selected = responseContract ? {question:responseContract,schemaPointer:'/body/question/schema'} : hasQuestion ? selectedQuestion(question, archivedBody) : null;
  const contract = responseContract ?? (selected ? { id: question.id, ...question.value.spec } : null);
  const projectedQuestion = selected ? { ...selected.question,
    ...(selected.schemaPointer && body['dispatchMode'] !== 'consolidation'
      ? { schemaAddress: { record: reference(archive), pointer: selected.schemaPointer } } : {}) } : null;
  if (projectedQuestion) body = { ...body, question: projectedQuestion,
    ...(Object.hasOwn(body, 'questions') ? { questions: [projectedQuestion] } : {}) };
  const finish = (packet: Record<string, any>) => {
    requireCondition(sameAssessmentSubject(packet, archivedBody), 'discovery_assessment_subject_invalid',
      'Every initial or continuation packet must preserve packet and baseline');
    if (planSubject) packet.subject = planSubject;
    requirePacketMaterialDelivery(packet, reference(archive), (record, pointer) =>
      contextValue(archivedContext(store, draft, record), pointer));
    requirePlanningNavigation(packet, reference(archive), archivedBody);
    if (Object.hasOwn(archivedBody, 'resultCapacity')) requireCondition(
      Object.hasOwn(packet, 'resultCapacity')
        && canonical(packet.resultCapacity) === canonical(archivedBody['resultCapacity']),
      'research_capacity_invalid', 'The paid packet lost its saved result admission');
    if (sourceNavigation) requireCondition(packet.sourceCatalogue !== undefined
      && canonical(packet.sourceCatalogue) === canonical(sourceNavigation)
      || packet.working?.navigationAddresses?.some((item: {field:string;record:Ref;pointer:string;sourceHash:string}) =>
        item.field === 'sourceCatalogue' && canonical(item.record) === canonical(reference(archive))
        && item.pointer === '/body/inventory' && item.sourceHash === hashJson(inventory))
      || packet.working?.materialAddresses?.some((item: {field:string;pointer:string;valueHash:string}) =>
        item.field === 'sourceCatalogue' && item.pointer === '/body/sourceCatalogue'
        && item.valueHash === hashJson(sourceNavigation)),
      'source_toc_undelivered', 'The packed request lost its exact structured source catalogue');
    if (relatedResearch !== undefined) requireCondition(
      packet.discoveryContext !== undefined && canonical(packet.discoveryContext) === canonical(relatedResearch)
      || packet.working?.materialAddresses?.some((item: {field:string;valueHash:string}) =>
        item.field === 'discoveryContext' && item.valueHash === hashJson(relatedResearch)),
    'context_discovery_incomplete', `[${question.id}] The packed question lost its accepted research grounds`);
    if (relatedCatalogue !== undefined) requireCondition(
      packet.discoveryBasisCatalogue !== undefined && canonical(packet.discoveryBasisCatalogue) === canonical(relatedCatalogue)
      || packet.working?.materialAddresses?.some((item: {field:string;valueHash:string}) =>
        item.field === 'discoveryBasisCatalogue' && item.valueHash === hashJson(relatedCatalogue)),
    'context_discovery_incomplete', `[${question.id}] The packed question lost its exact Discovery basis catalogue`);
    if (neighborMaterial) requireCondition(packet.assessmentContextContract === STAGE_NEIGHBOR_CONTEXT
      && (packet.stageNeighbors !== undefined && canonical(packet.stageNeighbors) === canonical(neighborMaterial.stageNeighbors)
        || packet.working?.materialAddresses?.some((item: {field:string;valueHash:string}) =>
          item.field === 'stageNeighbors' && item.valueHash === hashJson(neighborMaterial.stageNeighbors))),
    'context_stage_neighbors_incomplete', `[${question.id}] The packed assessor lost its accepted stage neighbors`);
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
    const goal = body['consolidation'];
    const active = activeSynthesisNotes(body['synthesisNotes']);
    const makePacket = (count: number, bounded: boolean) => ({ dispatchMode: 'consolidation', question: projectedQuestion, ...neighborMaterial,
      ...(Object.hasOwn(body, 'resultCapacity') ? { resultCapacity: body['resultCapacity'] } : {}),
      ...(relatedResearch === undefined ? {} : { discoveryContext: relatedResearch }),
      synthesisSession: body['synthesisSession'], synthesisState: body['synthesisState'],
      consolidation: {...consolidationInput(bounded ? active.slice(0, count) : active,
        goal.targetChars, goal.format === 2 ? 2 : 1),
        ...(bounded ? { deliveryContract: CONSOLIDATION_DELIVERY,
          selection: active.slice(0, count).map(note => note.checkpoint),
          page: { offset: 0, end: count, total: active.length, next: count < active.length ? count : null },
        } : {}),
        ...(goal.tightening ? {tightening:goal.tightening} : {})},
      working: { archive: reference(archive), deliveryContract: 'research-delivery/v1', instruction:
        bounded
          ? 'Original notes are immutable at /body/synthesisNotes. This packet covers only consolidation.page; the remaining active notes require later consolidation. No new source material is delivered.'
          : 'Original notes are immutable at /body/synthesisNotes. No new material is delivered in this step.',
        sections: [{ pointer: '/body/synthesisNotes' }] } });
    let count = active.length;
    let packet = makePacket(count, false);
    if (JSON.stringify(packet).length > maxChars) {
      packet = makePacket(count, true);
      while (JSON.stringify(packet).length > maxChars && count > 1) packet = makePacket(--count, true);
      if (JSON.stringify(packet).length > maxChars && count === 1
        && typeof body['synthesisSession'] === 'string'
        && body['synthesisSession'].startsWith('synthesis-session:v2:')) {
        const original = active[0]!;
        const previous = active.find(note => note.consolidated?.partial
          && canonical(note.consolidated.partial.original) === canonical(original.checkpoint)) ?? null;
        requireCondition(original.proposal.action === 'checkpoint'
          && (!previous || previous.proposal.action === 'checkpoint'),
        'consolidation_coverage_invalid', 'Partial consolidation needs saved checkpoint proposals');
        const sourceIndex = body['synthesisNotes'].findIndex((note: typeof original) =>
          canonical(note.checkpoint) === canonical(original.checkpoint));
        const offset = previous?.consolidated?.partial?.end ?? 0;
        const encoded = canonical(original.proposal), pointer = `/body/synthesisNotes/${sourceIndex}/proposal`;
        const originalPage = { record: reference(archive), pointer, value: original.proposal,
          page: { offset, end: encoded.length, total: encoded.length, unit: 'utf16', next: null,
            encoding: 'canonical-json' as const } };
        const fragmentPacket: Record<string, any> = {
          dispatchMode: 'consolidation', question: projectedQuestion, ...neighborMaterial,
          ...(Object.hasOwn(body, 'resultCapacity') ? { resultCapacity: body['resultCapacity'] } : {}),
          ...(relatedResearch === undefined ? {} : { discoveryContext: relatedResearch }),
          synthesisSession: body['synthesisSession'], synthesisState: body['synthesisState'],
          consolidation: { targetChars: goal.targetChars, deliveryContract: CONSOLIDATION_FRAGMENT,
            notes: [{ original: original.checkpoint,
              previous: previous ? { checkpoint: previous.checkpoint,
                value: previous.proposal.action === 'checkpoint' ? previous.proposal.value : null } : null }],
            citations: [], references: [], unresolved: [],
            fragment: { original: original.checkpoint, previous: previous?.checkpoint ?? null,
              sourceIndex, offset, total: encoded.length },
            ...(goal.tightening ? { tightening: goal.tightening } : {}) },
          working: { archive: reference(archive), deliveryContract: 'research-delivery/v1',
            instruction: 'This is one exact UTF-16 fragment of the saved note. Summarize only the supplied fragment together with previous, retaining every finding and uncertainty. Return a checkpoint with summaries for note index 0 and citationIds:[]. The engine retains the original note and its citations/unresolved until every fragment has been delivered; never infer the unseen remainder.',
            sections: [{ pointer: '/body/synthesisNotes' }] },
        };
        const key = hashJson({ record: originalPage.record, pointer, value: originalPage.value });
        const available = maxChars - JSON.stringify(fragmentPacket).length - 1024;
        const delivery = available > 0 ? planResearchDelivery(originalPage, key, maxChars, available, candidate => {
          fragmentPacket.materialDelivery = [candidate];
          return JSON.stringify(fragmentPacket).length <= maxChars - 1024;
        }) : null;
        requireCondition(delivery, 'research_context_capacity',
          'The mandatory consolidation question and prior partial summary leave no room for a positive saved note fragment');
        fragmentPacket.materialDelivery = [delivery];
        consolidationFragment(body['synthesisNotes'], goal, fragmentPacket);
        return finish(fragmentPacket);
      }
      consolidationPage(body['synthesisNotes'], goal, packet.consolidation);
    }
    requireCondition(JSON.stringify(packet).length <= maxChars, 'consolidation_input_limit',
      'The notes-only consolidation request exceeds the fixed ceiling; do not raise it or repeat a paid call');
    return finish(packet);
  }
  if (options.common && !options.continuation && !body['core'] && !body['synthesisState'] && !body['assessmentState']) {
    const {priorEvidence:_priorEvidence,priorEvidenceSources:_priorEvidenceSources,...initialBody}=body;
    const initial:Record<string,any>={...initialBody,working:{archive:reference(archive),deliveryContract:'research-delivery/v1',instruction,sections:contextSections(archivedBody)}};
    if (initial.inventory) {
      if (sourceNavigation) delete initial.inventory;
      else delete initial.sourceCatalogue;
    }
    // Two saved collections can each exceed the packet. Remove the full
    // history while planning context pages, then page history from its exact
    // archive address in the remaining space. Neither can crowd the other's
    // positive first fragment out before the planner measures it.
    const fullHistory = Object.hasOwn(initial, 'history') ? initial.history : undefined;
    if (fullHistory !== undefined) delete initial.history;
    const addressed = addressArchivedMaterials(initial, reference(archive),
      exactArchivedFields(initial, ['fields', 'discoveryContext', 'discoveryBasisCatalogue',
        'prerequisites', 'operationMap', 'inventory', 'consumerFeedback', 'request', 'sourceCatalogue']),
      maxChars, materialRecord);
    packContextWorkspace(initial,maxChars,options.contextChars,undefined,
      addressed.length || fullHistory !== undefined ? 4096 : 1024);
    if (fullHistory !== undefined) {
      initial.history = fullHistory;
      addressed.push(...addressArchivedMaterials(initial, reference(archive),
        exactArchivedFields(initial, ['history']), maxChars, materialRecord));
    }
    serveArchivedMaterial(initial, addressed, maxChars);
    packPriorEvidence(initial,priorSources,reference(archive),maxChars);
    requireCondition(JSON.stringify(initial).length<=maxChars,'pilot_core_limit','Initial question context exceeds its declared envelope bound');
    return finish(initial);
  }
  if (options.continuation) {
    const exactWorkspace = body['contextWorkspace'];
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
    // A saved lookup is an original, not a repeat of the foundation. Replacing
    // its value inside the copy-removal walk changes its identity and makes a
    // valid paid read fail the delivery proof (including inventory lookups).
    if (assessmentSubject) body['assessmentSubject'] = assessmentSubject;
    if (exactWorkspace !== undefined) body['contextWorkspace'] = exactWorkspace;
    if (newMapPrerequisites) body['prerequisites'] = newMapPrerequisites;
    if (projectedQuestion) { body['question'] = projectedQuestion; if (Object.hasOwn(original, 'questions')) body['questions'] = [projectedQuestion]; }
    if(original['assessmentState'])body['value']=assessmentValue;
    if(relatedResearch !== undefined)body['discoveryContext']=relatedResearch;
    if(relatedCatalogue !== undefined)body['discoveryBasisCatalogue']=relatedCatalogue;
    if(neighborMaterial)Object.assign(body,neighborMaterial);
    if(sourceNavigation) body['sourceCatalogue']=sourceNavigation;
    if(candidate) body['candidate']=replaceFoundationCopies(candidate,{...original,value:undefined},reference(archive),store);
    if(proposalChanges) body['proposalChanges']=replaceFoundationCopies(proposalChanges,{...original,previousProposal:undefined},reference(archive),store);
  }
  if (options.common && options.continuation && body['dispatchMode']==='planning') {
    body['corrections'] = archivedBody['corrections'] ?? [];
    delete body['history'];
  }
  if (options.common) {
    const conclusions=compactConclusions((body['synthesisNotes'] ? activeSynthesisNotes(body['synthesisNotes']) : undefined) ?? body['assessmentNotes'] ?? body['checkpoints'] ?? body['previousProposal'] ?? (body['history'] as any[] ?? []).filter(h=>h.action?.question===(planSubject?.planQuestionId??questionId) && ['checkpoint','answer','answer_delta'].includes(h.action.action)).map(h=>({proposal:h.action})));
    body['conclusions']=conclusions.items; body['conclusionCitations']=conclusions.citations;
    body['conclusionRefs']=conclusions.references; body['conclusionUnresolved']=conclusions.unresolved; body['conclusionEncoding']=CONCLUSION_ENCODING;
    if(body['history']) {
      const history=body['history'] as any[];
      const readIndex=history.findLastIndex(h=>h.action && typeof h.action==='object'
        && ['read','read_source','read_context','search','web_search','web_fetch'].includes(h.action.action));
      if(readIndex >= 0) {
        const read = history[readIndex];
        const originalRead = (archivedBody['history'] as any[] | undefined)?.[readIndex];
        const observation = originalRead?.observation;
        const key = originalRead?.action?.action === 'read_context' && !originalRead?.error
          && observation && isRef(observation.record) && typeof observation.pointer === 'string'
          && Object.hasOwn(observation, 'value')
          ? contextLookupKey(observation as ContextLookup) : null;
        const alreadyAddressed = key && Array.isArray(body['contextWorkspace'])
          && (body['contextWorkspace'] as ContextLookup[]).some(item => contextLookupKey(item) === key);
        body['currentRead'] = alreadyAddressed
          ? { action: read.action, original: { record: reference(archive), pointer: `/body/history/${readIndex}` },
              contextKey: key, delivery: 'contextWorkspace/contextDelivery' }
          : read;
      }
      body['corrections']=correctionIndex(history,reference(archive));delete body['history'];
    }
    delete body['synthesisNotes']; delete body['assessmentNotes']; delete body['checkpoints'];
  }
  if (body['dispatchMode'] === "planning" && !options.continuation) {
    const side = { ...(relatedResearch === undefined ? {} : { discoveryContext: relatedResearch }),
      ...(relatedCatalogue === undefined ? {} : { discoveryBasisCatalogue: relatedCatalogue }),
      ...(neighborMaterial ?? {}) };
    const fullReserved = (relatedResearch === undefined ? 0 : JSON.stringify({discoveryContext:relatedResearch}).length)
      + (relatedCatalogue === undefined ? 0 : JSON.stringify({discoveryBasisCatalogue:relatedCatalogue}).length)
      + (neighborMaterial ? JSON.stringify(neighborMaterial).length : 0);
    const reserved = Math.min(fullReserved, 8192);
    const packet = planningContext(sourceNavigation ? body : { ...body, sourceCatalogue: undefined },
      reference(archive),maxChars-reserved,
      options.contextChars,archivedBody);
    Object.assign(packet, side);
    const addressed = addressArchivedMaterials(packet, reference(archive),
      exactArchivedFields(packet, ['discoveryContext', 'discoveryBasisCatalogue', 'stageNeighbors']),
      maxChars, materialRecord);
    if (!packet.materialDelivery) serveArchivedMaterial(packet, addressed, maxChars);
    return finish(packet);
  }
  const mandatory = ["assessmentSubject", "resultCapacity", "assessmentContextContract", "stageNeighbors", "discoveryContext", "discoveryBasisCatalogue", "webResearch", "answerContext", "contextWorkspace", "savedEvidence", "conclusions", "conclusionCitations", "conclusionRefs", "conclusionUnresolved", "conclusionEncoding", "contextControls", "contextCorrection", "currentRead", "originals", "corrections", "request", "candidate", "proposalChanges", "purpose", "sources", "questions", "prerequisites", "operationMap", "researchMissing", "fields", "mapStatusFindings", "mapStatus", "researchScope", "role", "stage", "level", "consumer", "contextEncoding", "allowedConsumers", "gapFields", "graphBase",
    "core", "map", "draft", "question", "value", "representation", "consumerFeedback", "assessmentState", "openGaps", "failures", "unresolvedEvidence", "dispatchMode", "readPlanStatus", "sourceCatalogue", "sourceLocations", "bases", "runtimeProofs", "synthesisState", "synthesisNotes", "previousProposalRef"];
  if(body['assessmentState']) mandatory.splice(mandatory.indexOf("value"),1);
  const ordered = options.common && !options.continuation
    ? [...mandatory.filter(key=>FOUNDATION_FIELDS.includes(key as any)),...mandatory.filter(key=>!FOUNDATION_FIELDS.includes(key as any))] : mandatory;
  const packet: Record<string, any> = Object.fromEntries(ordered.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  packet.working = { archive: reference(archive), deliveryContract: 'research-delivery/v1', instruction,
    sections: contextSections(archivedBody, Object.keys(archivedBody).filter(key => !mandatory.includes(key))).map(section => {
      const value = contextValue({ body: archivedBody }, section.pointer);
      return { ...section, chars: JSON.stringify(value).length,
        count: Array.isArray(value) || typeof value === 'string' ? value.length : null };
    }), omitted: [] as string[] };
  // Defaults preserve the action protocol's collection shapes, not completeness.
  Object.assign(packet, { readings: [], directReadings: [], history: [], observations: [], checkpoints: [] });
  const addressedCore = addressArchivedMaterials(packet, reference(archive),
    exactArchivedFields(packet, ['fields', 'discoveryContext', 'discoveryBasisCatalogue', 'stageNeighbors',
      'prerequisites', 'operationMap', 'inventory', 'request', 'consumerFeedback',
      'answerContext', 'currentRead', 'originals', 'corrections', 'researchScope',
      'mapStatus', 'mapStatusFindings', 'readPlanStatus', 'openGaps', 'failures', 'sourceCatalogue',
      'savedEvidence', 'unresolvedEvidence', 'webResearch', 'synthesisNotes',
      'candidate', 'proposalChanges']).filter(field => field !== 'failures'
        || !body['assessmentState'] || JSON.stringify(body['failures']).length > Math.floor(maxChars / 3)),
    maxChars, materialRecord);
  const retained = body['contextControls']?.version === 2 && body['synthesisState'];
  const conclusionKeys = ['conclusions','conclusionCitations','conclusionRefs','conclusionUnresolved','conclusionEncoding'];
  const carry = Object.fromEntries(conclusionKeys.filter(key => Object.hasOwn(packet,key)).map(key => [key,packet[key]]));
  if (retained) for (const key of conclusionKeys) delete packet[key];
  const addressedConclusions = !retained && packet.conclusions && (JSON.stringify(packet).length > maxChars - 1024
    || JSON.stringify(packet.conclusions).length > Math.floor(maxChars / 3))
    ? conclusionSources(archivedBody, reference(archive), planSubject?.planQuestionId??questionId) : [];
  if (addressedConclusions.length) {
    packet.working.conclusionOrigins = addressedConclusions.map(item => ({ record: item.record, pointer: item.pointer,
      chars: JSON.stringify(item.value).length }));
    delete packet.conclusions;
    packet.working.omitted = [...new Set([...packet.working.omitted, 'conclusions'])];
    packet.working.instruction += ' conclusionOrigins names the exact saved material behind the omitted conclusions; read those addresses before relying on an incomplete conclusion.';
  }
  packContextWorkspace(packet,maxChars,options.contextChars,
    retained ? {checkpointedKeys:body['contextCheckpointedKeys']??[]} : undefined,
    addressedConclusions.length || addressedCore.length ? 4096 : 1024);
  // Only one material fragment occupies this slot. If a full saved field is
  // already addressed, its first fragment has priority; conclusions retain
  // their exact source addresses without consuming that same space twice.
  if (addressedCore.length) serveArchivedMaterial(packet, addressedCore, maxChars);
  else if (addressedConclusions.length) packAddressedValue(packet, 'conclusions',
    addressedConclusions[addressedConclusions.length - 1]!, maxChars);
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
  packet.working.omitted = [...new Set([...packet.working.omitted,
    ...Object.keys(archivedBody).filter(key => !mandatory.includes(key))])];
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
      requireCondition(lo > 0 || offset === encoded.length,
        options.continuation ? 'continuation_packet_limit' : 'pilot_core_limit',
        'No room for candidate evidence beside the required assessment context');
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

import { Ajv } from 'ajv';
import { canonical, digest, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { tokenUsage, type ModelCall } from '../runtime/model-usage.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { normalizeResearchAction } from './research-action-normalization.js';
import type { ReaderResult } from './reader.js';
import type { ResearchAction } from './research-model.js';
import type { Observation, Selector, Source } from '../evidence/evidence.js';
import type { ReaderSelection } from './reader.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { Revision, Store } from '../storage/store.js';
import { activeSynthesisNotes, consolidationNotice, consolidatedProposal,
  type ConsolidationNotice, type SynthesisNote } from './conclusion-consolidation.js';
import { addContextLookup, contextLookupKey, contextProgress, contextWorkspace,
  type ContextLookup, type ContextWorkspace } from './context-workspace.js';
import { archivedContext, contextPage, contextValue, type ContextPage } from './working-context.js';
import type { Json } from '../canonical.js';

/* This module is the dependency leaf for paid consumer transitions. Its inputs
 * are exact records already checked by their respective historical readers;
 * it never looks up a mutable HEAD, a source path, or a consumer module. The
 * synthesis deduction below reads Store only through exact pinned revisions
 * (intent/session/archive/source references carried by the proven inputs). */
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const text = { type: 'string', minLength: 1 };
const ref = object({ id: text, revision: { type: 'integer', minimum: 1 },
  hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
const selector = { oneOf: [object({ kind: { const: 'json-pointer' }, pointer: { type: 'string' } }),
  object({ kind: { const: 'text-range' }, start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 1 } })] };
// Keep the wire schema here so both the producer and historical reader use
// this parser without importing layer-delta (which imports consumer modules).
const deltaKeys = ['nodes', 'connectors', 'contracts', 'artifacts', 'edges', 'journeys',
  'joins', 'anchors', 'tests', 'packets', 'transfers', 'researchObligations'] as const;
const deltaCollections = (items: object) => ({ type: 'object', additionalProperties: false,
  properties: Object.fromEntries(deltaKeys.map(key => [key, { type: 'array', items }])) });
const bundleItem = (properties: Record<string, unknown>) => {
  const schema = object(properties);
  schema.properties['range'] = object({ start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 0 } });
  return schema;
};
const contextRead = object({ action: { const: 'read_context' }, record: ref, pointer: { type: 'string' } });
contextRead.properties['purpose'] = text;
contextRead.properties['page'] = object({ offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1 } });
const readSchemas = [
  object({ action: { const: 'read_bundle' }, purpose: text,
    inputs: { type: 'array', minItems: 1, items: { oneOf: [
      bundleItem({ path: text, media: { enum: ['text/plain', 'application/json'] } }),
      bundleItem({ source: ref })] } } }), contextRead,
  object({ action: { const: 'search' }, query: text }),
  object({ action: { const: 'read_source' }, source: ref,
    start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } }),
  object({ action: { const: 'read' }, path: text, media: { enum: ['text/plain', 'application/json'] } })
];
const answerDelta = object({ action: { const: 'answer_delta' }, question: text, base: ref,
  upserts: deltaCollections({ type: 'object', required: ['id'], properties: { id: text } }),
  removes: deltaCollections(text),
  citations: { type: 'array', minItems: 1, items: object({ source: ref, selector }) } });
answerDelta.properties['revises'] = ref;
answerDelta.properties['horizon'] = { type: 'array', minItems: 1, uniqueItems: true, items: text };
const validateAction = new Ajv({ allErrors: true }).compile<ResearchAction>({ oneOf: [
  ...readSchemas,
  object({ action: { const: 'read_plan' }, question: text,
    reads: { type: 'array', minItems: 1, maxItems: 16, items: { oneOf: readSchemas } } }),
  object({ action: { const: 'synthesize' }, question: text }),
  object({ action: { const: 'need_research' }, question: text,
    missing: { type: 'array', minItems: 1, items: text } }),
  answerDelta,
  object({ action: { const: 'checkpoint' }, question: text, value: {},
    citations: { type: 'array', items: object({ source: ref, selector }) },
    unresolved: { type: 'array', items: text } }),
  object({ action: { const: 'answer' }, question: text, value: {},
    citations: { type: 'array', minItems: 1, items: object({ source: ref, selector }) } }),
  object({ action: { const: 'need_owner' }, question: text, reason: text,
    searched: { type: 'array', minItems: 1, items: ref } }),
  object({ action: { const: 'pause' }, reason: text })
] });

const validateReaderReply = new Ajv({ allErrors: true }).compile<{
  selections: ReaderSelection[]; unresolved: string[] }>(object({
  selections: { type: 'array', items: { oneOf: [
    object({ source: ref, firstLine: { type: 'integer', minimum: 1 }, lastLine: { type: 'integer', minimum: 1 } }),
    object({ sourceIndex: { type: 'integer', minimum: 0 },
      firstLine: { type: 'integer', minimum: 1 }, lastLine: { type: 'integer', minimum: 1 } })] } },
  unresolved: { type: 'array', items: text } }));

/** A sibling field may advance the draft without changing this reader task. */
export function readerDraftEquivalent(store: Store, before: Ref, after: Ref, question: Ref): boolean {
  const earlier = store.get<DiscoveryDraft>(before.id, before.revision);
  const later = store.get<DiscoveryDraft>(after.id, after.revision);
  const selected = store.get<Question>(question.id, question.revision);
  requireCondition(earlier?.kind === 'discovery-draft' && later?.kind === 'discovery-draft'
    && selected?.kind === 'question' && canonical(reference(earlier)) === canonical(before)
    && canonical(reference(later)) === canonical(after)
    && canonical(reference(selected)) === canonical(question)
    && earlier.id === later.id && selected.value.draftId === earlier.id
    && earlier.value.questions.includes(question.id) && later.value.questions.includes(question.id),
  'reader_draft_stale', 'The reader task lost its exact draft or question');
  const relevant = (value: DiscoveryDraft) => ({
    projectId: value.projectId, createdAt: value.createdAt, stage: value.stage, level: value.level,
    consumer: value.consumer, questions: value.questions, inputs: value.inputs,
    contractVersion: value.contractVersion ?? null, basisContract: value.basisContract ?? null,
    obligationContract: value.obligationContract ?? null, derivations: value.derivations ?? null,
    field: value.fields[selected.value.spec.field] });
  return canonical(relevant(earlier.value)) === canonical(relevant(later.value));
}

/** Pure selection admission shared by paid extraction and historical refusal.
 * Original byte extraction remains the reader's separate source projection. */
export function projectReaderSelection(sources: readonly { ref: Ref; lines: readonly { line: number }[] }[],
  reply: unknown): { response: { selections: ReaderSelection[]; unresolved: string[] }; sourceIndices: number[] } {
  if (!validateReaderReply(reply)) throw new EngineError('reader_response_invalid',
    'Reader must return only source/line selections and unresolved questions', validateReaderReply.errors);
  requireCondition(reply.selections.length > 0 || reply.unresolved.length > 0,
    'reader_response_empty', 'An empty reader response does not establish absence of relevant information');
  const sourceIndices = reply.selections.map(selection => {
    const index = 'sourceIndex' in selection ? selection.sourceIndex
      : sources.findIndex(source => canonical(source.ref) === canonical(selection.source));
    const source = sources[index];
    requireCondition(source && selection.firstLine <= selection.lastLine
      && source.lines.some(line => line.line === selection.firstLine)
      && source.lines.some(line => line.line === selection.lastLine),
    'reader_selection_foreign', 'Reader selected an unavailable source version or line range');
    return index;
  });
  return { response: reply, sourceIndices };
}

/** Interpret one exact physical reply for both the transport writer and the
 * historical consumer reader. A process failure can still carry measured usage. */
export function projectResearchPhysicalReply(raw: string, requestId: string,
  exitCode: number | null, stderr: string, maxReplyChars: number | null): {
    status: 'succeeded' | 'failed'; error: string | null; message: string | null;
    usage: ModelCall['usage']; usageSource: ModelCall['usageSource'];
    confirmed: ModelCall['confirmed']; payload: unknown } {
  let response: { protocol?: unknown; requestId?: unknown; research?: unknown;
    usage?: unknown; confirmed?: unknown } | null = null;
  try { response = JSON.parse(raw); } catch { /* Process status and envelope follow below. */ }
  let usage: ModelCall['usage'] = null;
  let usageSource: ModelCall['usageSource'] = 'unavailable';
  let confirmed: ModelCall['confirmed'] = { model: null, effort: null, speed: null };
  try {
    if (response?.protocol === 'omg-agent/v1' && response.requestId === requestId) {
      usage = tokenUsage(response.usage);
      usageSource = usage ? 'adapter' : 'unavailable';
      const stated = response.confirmed as Record<string, unknown> | undefined;
      if (stated) {
        requireCondition(Object.keys(stated).sort().join(',') === 'effort,model,speed'
          && Object.values(stated).every(value => value === null || typeof value === 'string' && value.length > 0),
        'usage_invalid', 'Confirmed runtime fields must be explicit strings or null');
        confirmed = stated as ModelCall['confirmed'];
      }
    }
    requireCondition(exitCode === 0, 'research_provider_failed', stderr.slice(-2000) || 'Research provider failed');
    requireCondition(response, 'research_response_invalid', 'Research adapter must return a protocol response');
    requireCondition(response.protocol === 'omg-agent/v1' && response.requestId === requestId
      && Object.hasOwn(response, 'research'), 'research_response_foreign',
    'Research response is missing or belongs to another invocation');
    requireCondition(maxReplyChars === null || JSON.stringify(response.research).length <= maxReplyChars,
      'budget_transport_limit', 'Response exceeds the declared physical response capacity');
    return { status: 'succeeded', error: null, message: null, usage, usageSource, confirmed,
      payload: response.research };
  } catch (error) {
    return { status: 'failed', error: error instanceof EngineError ? error.code : 'research_call_failed',
      message: error instanceof Error ? error.message : 'Research call failed', usage, usageSource, confirmed,
      payload: null };
  }
}

/** One action parser for transport, writes, and historical transition proofs. */
export function researchAction(value: unknown): ResearchAction {
  value = normalizeResearchAction(value);
  if (!validateAction(value)) throw new EngineError('research_response_invalid',
    'Research action has missing or invalid fields', validateAction.errors);
  if (value.action === 'checkpoint' && value.citations.length === 0) {
    const note = value.value;
    const meaningful = typeof note === 'string' ? note.trim().length > 0
      : Array.isArray(note) ? note.length > 0
        : note !== null && (typeof note !== 'object' || Object.keys(note).length > 0);
    requireCondition(meaningful || value.unresolved.some(item => item.trim().length > 0),
      'research_checkpoint_empty',
      'An uncited checkpoint needs actual proposed content or an explicit unresolved question');
  }
  return value;
}

export interface PaidReaderResultInput {
  projectId: string; question: Ref; pilot: Ref; purpose: string; intent: Ref;
  sources: Ref[]; coverage: ReaderResult['coverage'];
  observations: Observation[]; unresolved: string[]; reusedFrom?: Ref[];
}

/** Assemble the complete paid reader result after exact extraction. The
 * producer and historical reader supply the same checked extracted ranges. */
export function projectPaidReaderResult(input: PaidReaderResultInput): ReaderResult {
  requireCondition(typeof input.projectId === 'string' && input.projectId.length > 0
    && isRef(input.question) && isRef(input.pilot) && isRef(input.intent)
    && typeof input.purpose === 'string' && input.purpose.trim().length > 0
    && Array.isArray(input.sources) && input.sources.every(isRef)
    && Array.isArray(input.coverage) && Array.isArray(input.observations)
    && Array.isArray(input.unresolved) && input.unresolved.every(item => typeof item === 'string')
    && (input.reusedFrom === undefined || Array.isArray(input.reusedFrom)
      && input.reusedFrom.every(isRef)),
  'reader_intent_output_invalid', 'The paid reader result has incomplete checked inputs');
  return { projectId: input.projectId, question: input.question, pilot: input.pilot,
    purpose: input.purpose, contract: 'reader-result/v2', producer: 'paid',
    intent: input.intent, sources: input.sources, coverage: input.coverage,
    observations: input.observations, unresolved: input.unresolved,
    ...(input.reusedFrom?.length ? { reusedFrom: input.reusedFrom } : {}) };
}

/* ==== Synthesis/consolidation family (D8.4b, contract №1499) ====
 * One deduction for the producer, the application validator and the
 * historical session reader. Units stay separate: L (one logical step of a
 * session, addressed by exact session head + variant), P (its physical call),
 * A (the atomic application of the proved response), C (checkpoint record),
 * Y (delivery of the outcome). Everything below is a pure function of exact
 * pinned inputs; current admission is checked by callers before a new P/A. */


const recordValue = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const SYNTHESIS_SESSION_CONTRACT = 'synthesis-session/v2' as const;

export interface SynthesisSessionBasis {
  materials: Record<string, any>[]; previousProposal: unknown; previousProposalRef: Ref | null;
}
export interface SynthesisSessionDelivery { run: string; turn: number }
export interface SynthesisSessionState {
  contract: typeof SYNTHESIS_SESSION_CONTRACT; projectId: string;
  offset: number; materialOffset?: number; focus?: unknown;
  workspace?: ContextWorkspace; blockedCode?: string;
  binding: { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] };
  basis: SynthesisSessionBasis;
  notes: SynthesisNote[]; notices?: ConsolidationNotice[]; finalization?: { lookups: number };
  result: ResearchAction | null; pause?: ResearchAction | null;
  delivery?: SynthesisSessionDelivery | null; delivered?: Ref | null;
  recoveries?: unknown[];
}

/** Payload/proof failures of a received synthesis reply are saved as the
 * step's unresumable refusal; exact-read and integrity failures are not: an
 * origin-proof failure (reader_result_invalid / context_lookup_integrity)
 * propagates with the prior session and the physical response preserved and
 * the intent still running — a repeat re-derives the same refusal from the
 * proven execution without a new P (№1658-1). */
export const SYNTHESIS_TRANSITION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'research_response_invalid', 'research_checkpoint_empty', 'research_mode_invalid',
  'research_question_foreign', 'synthesis_cursor_invalid', 'synthesis_checkpoint_required',
  'synthesis_no_progress', 'research_saved_only', 'consolidation_response_invalid',
  'consolidation_coverage_invalid', 'consolidation_citations_invalid']);

/** Semantic lookup failures become the saved blocked outcome; anything else
 * (integrity, unexpected exceptions) propagates without a session write. */
const LOOKUP_BLOCKED_CODES: ReadonlySet<string> = new Set([
  'synthesis_context_purpose_missing', 'context_read_limit', 'context_reference_foreign',
  'context_reference_stale', 'selector_invalid', 'context_missing', 'context_page_invalid',
  'research_no_progress', 'research_context_invalid']);

function exactObservation(store: Store, projectId: string, sourceRef: Ref, selector: Selector): Observation {
  requireCondition(isRef(sourceRef) && selector && typeof selector === 'object',
    'evidence_input_invalid', 'Evidence needs a versioned source reference and selector');
  const source = store.get<Source>(sourceRef.id, sourceRef.revision);
  requireCondition(source?.kind === 'source' && source.value.projectId === projectId
    && canonical(reference(source)) === canonical(sourceRef)
    && digest(source.value.content) === source.value.sha256,
  'source_missing', 'The exact cited source revision is missing or changed');
  let value: unknown;
  if (selector.kind === 'json-pointer') {
    requireCondition(source.value.mediaType === 'application/json', 'selector_invalid', 'JSON selection requires a JSON source');
    value = JSON.parse(source.value.content);
    requireCondition(typeof selector.pointer === 'string' && (selector.pointer === '' || selector.pointer.startsWith('/')),
      'selector_invalid', 'Invalid JSON pointer');
    if (selector.pointer) for (const encoded of selector.pointer.slice(1).split('/')) {
      requireCondition(!/~(?![01])/.test(encoded), 'selector_invalid', 'Invalid JSON pointer escape');
      const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      requireCondition(value !== null && typeof value === 'object' && Object.hasOwn(value, key),
        'evidence_missing', 'Selected field does not exist in the source');
      value = (value as Record<string, unknown>)[key];
    }
  } else {
    requireCondition(selector.kind === 'text-range' && Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)
      && selector.start >= 0 && selector.end > selector.start && selector.end <= source.value.content.length,
    'selector_invalid', 'Text evidence needs a valid nonempty range');
    value = source.value.content.slice(selector.start, selector.end);
  }
  return { projectId, source: reference(source), selector, value: JSON.parse(canonical(value)) as Json };
}

export interface CheckpointProposalInput {
  question: string; value: Json;
  citations: { source: Ref; selector: Selector }[]; unresolved: string[];
}

/** The single checkpoint value formula: producer (live observe) and the
 * historical/atomic application path (exact pinned observe) share it. */
export function projectCheckpointValue(projectId: string, draft: Ref, question: Ref,
  action: CheckpointProposalInput, observe: (source: Ref, selector: Selector) => Observation): { id: string; value: Record<string, any> } {
  requireCondition(recordValue(action) && typeof action.question === 'string' && action.question === question.id
    && Object.hasOwn(action, 'value') && Array.isArray(action.citations) && Array.isArray(action.unresolved)
    && action.citations.every(citation => recordValue(citation) && isRef(citation.source) && recordValue(citation.selector)),
  'research_question_foreign', 'Checkpoint belongs to another question');
  const observations = action.citations.map(citation => observe(citation.source, citation.selector));
  const value = { projectId, draft, question, status: 'unassessed',
    proposal: action.value, observations, unresolved: action.unresolved };
  return { id: `research-checkpoint:${hashJson(value)}`, value };
}

function exactCheckpoint(projectId: string, draft: Ref, question: Ref,
  action: CheckpointProposalInput, store: Store): { id: string; value: Record<string, any> } {
  return projectCheckpointValue(projectId, draft, question, action,
    (source, selector) => exactObservation(store, projectId, source, selector));
}

/** Proof that a lookup record stands on its own producer chain (the general
 * reader of its kind), not only on an exact store address. Injected because
 * the reader-result reader lives outside this leaf. Mandatory at every writing
 * entry and in historical reading (№1658 К1): a record that fails its own
 * reader is never projected, recorded or recovered. */
export type ContextRecordProver = (record: Revision<Record<string, any>>) => void;

/** The checkpoint branch of the origin proof, exported for the operator
 * context-recovery producer: every observation re-derives from its exact
 * pinned source and the content address matches the value. */
export function proveCheckpointRecord(store: Store, record: Revision<Record<string, any>>): void {
  requireCondition(record.id === `research-checkpoint:${hashJson(record.value)}`
    && Array.isArray(record.value.observations)
    && record.value.observations.every((observation: any) => recordValue(observation)
      && observation.projectId === record.value.projectId
      && canonical(exactObservation(store, record.value.projectId, observation.source, observation.selector))
        === canonical(observation)),
  'context_lookup_integrity', 'A saved checkpoint observation does not re-derive from its exact source');
}

/** Read the exact pinned revision the lookup names and derive the same value
 * the producer delivered. No current heads, no filesystem, no live Evidence. */
export function exactContextLookup(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  recordRef: Ref, pointer: string, page: ContextPage | undefined, proveRecord: ContextRecordProver): ContextLookup {
  requireCondition(isRef(recordRef) && typeof pointer === 'string',
    'research_context_invalid', 'A context lookup requires exact origin and selector');
  const record = store.get<Record<string, any>>(recordRef.id, recordRef.revision);
  requireCondition(record && recordValue(record.value) && record.hash === recordRef.hash
    && canonical(reference(record)) === canonical(recordRef) && hashJson(record.value) === record.hash,
  'context_lookup_integrity', 'The exact lookup record is missing or changed');
  let content: unknown;
  if (record.kind === 'reader-result') {
    proveRecord(record);
    requireCondition(record.value.projectId === draft.value.projectId
      && record.value.question?.id === question.id
      && /^\/observations\/(0|[1-9]\d*)(?:\/.*)?$/.test(pointer),
    'context_reference_foreign', 'Prior reading access is limited to exact observations of this project');
    content = contextValue(record.value, pointer);
  } else if (record.kind === 'research-checkpoint') {
    requireCondition(record.value.projectId === draft.value.projectId
      && record.value.draft?.id === draft.id && draft.value.questions.includes(record.value.question?.id),
    'context_reference_foreign', 'Saved evidence must belong to this question and draft');
    proveCheckpointRecord(store, record);
    content = contextValue(record.value, pointer);
  } else if (record.kind === 'research-context') {
    const pinned = {
      get: <T>(id: string, revision?: number): Revision<T> | null => {
        if (revision === undefined) {
          if (id === question.id) return question as Revision<T>;
          if (id === draft.id) return draft as Revision<T>;
        }
        return store.get<T>(id, revision);
      },
    } as Store;
    content = contextValue(archivedContext(pinned, draft, recordRef), pointer);
  } else if (['stage', 'graph-layer', 'discovery-draft', 'research-scope'].includes(record.kind)) {
    requireCondition(canonical(reference(draft)) === canonical(recordRef)
      || draft.value.inputs.some(input => canonical(input) === canonical(recordRef)),
    'context_reference_foreign', 'Only the bound draft and its exact context records can be read');
    content = contextValue(record.value, pointer);
  } else {
    throw new EngineError('context_reference_foreign', 'The lookup record kind is not readable research context');
  }
  return { record: recordRef, pointer, ...contextPage(content, page) };
}

export interface SynthesisTransitionInput {
  store: Store;
  projectId: string;
  kind: 'synthesis' | 'consolidation';
  sessionId: string;
  before: SynthesisSessionState;
  draft: Ref;
  question: Ref;
  delivery: SynthesisSessionDelivery | null;
  subject: Record<string, any>;
  payload: unknown;
  archive: Record<string, any>;
  readLimit: number;
  /** Mandatory origin proof for lookup materials (№1658 К1) — supplied by the
   * caller because the reader-result reader lives outside this leaf. */
  proveRecord: ContextRecordProver;
}

export interface SynthesisTransition {
  kind: 'consolidation' | 'pause' | 'lookup' | 'blocked' | 'result' | 'page';
  session: SynthesisSessionState;
  checkpoint: { id: string; value: Record<string, any> } | null;
}

/** The complete lawful result (or typed refusal) of one paid synthesis-family
 * step, derived only from the exact session state, the exact archived packet
 * and the exact paid payload. Callers supply the identical inputs for write
 * and for historical proof, so one formula governs both. */
export function projectSynthesisTransition(input: SynthesisTransitionInput): SynthesisTransition {
  const { store, projectId, kind, before, archive, subject } = input;
  requireCondition(recordValue(before) && Array.isArray(before.notes) && Number.isSafeInteger(before.offset)
    && recordValue(archive) && recordValue(subject),
  'research_context_invalid', 'The synthesis transition needs its exact saved state, packet and archive');
  const questionId = input.question.id;
  const workspace = contextWorkspace(before.workspace, before.focus);
  requireCondition(!workspace.blocked, 'research_no_progress', workspace.blocked ?? 'Saved context session is blocked');

  if (kind === 'consolidation') {
    const goal = archive.consolidation;
    requireCondition(recordValue(goal) && Number.isSafeInteger(goal.targetChars) && goal.targetChars > 0
      && Number.isSafeInteger(goal.fullTargetChars) && goal.fullTargetChars > 0
      && (goal.tightening === undefined || recordValue(goal.tightening) && isRef(goal.tightening.from)),
    'consolidation_state_invalid', 'The saved consolidation goal lost its exact capacity contract');
    const action = researchAction(input.payload);
    const proposal = consolidatedProposal(action, questionId, before.notes);
    const checkpoint = exactCheckpoint(projectId, input.draft, input.question, {
      question: questionId, value: proposal as unknown as Json,
      citations: proposal.citations, unresolved: proposal.unresolved }, store);
    const active = activeSynthesisNotes(before.notes);
    const note: SynthesisNote = {
      checkpoint: { id: checkpoint.id, revision: 1, hash: hashJson(checkpoint.value) }, proposal,
      page: { offset: before.offset, end: before.offset },
      consolidated: { replaces: active.map(item => item.checkpoint),
        ...(goal.format === 2 ? { format: 2 as const, targetChars: goal.targetChars, fullTargetChars: goal.fullTargetChars } : {}),
        ...(goal.tightening ? { tightenedFrom: goal.tightening.from } : {}) } };
    const notice = consolidationNotice(note);
    return { kind: 'consolidation', checkpoint, session: { ...before, notes: [...before.notes, note],
      ...(notice ? { notices: [...(before.notices ?? []), notice] } : {}) } };
  }

  const materials = archive.synthesisMaterials;
  requireCondition(Array.isArray(materials) && materials.every(recordValue),
    'research_context_invalid', 'The archived synthesis materials are missing');
  const action = researchAction(input.payload);
  const page = subject.synthesisPage;
  requireCondition(['answer', 'answer_delta', 'checkpoint', 'read_context', 'need_research', 'need_owner', 'pause'].includes(action.action),
    'research_mode_invalid', 'Synthesis must answer, checkpoint, or identify missing information');
  requireCondition(!('question' in action) || action.question === questionId,
    'research_question_foreign', 'Synthesis must target its bound question');
  requireCondition(recordValue(page) && page.offset === before.offset && Number.isSafeInteger(page.end)
    && page.end >= page.offset && page.total === materials.length,
  'synthesis_cursor_invalid', 'The analyst must receive the saved material continuation');
  const final = before.offset === materials.length;
  const controls = recordValue(subject.contextControls) ? subject.contextControls : null;
  const outcomeDelivery = { delivered: null as Ref | null, delivery: input.delivery ?? before.delivery ?? null };

  if (action.action === 'pause') return { kind: 'pause', checkpoint: null, session: { ...before, pause: action, ...outcomeDelivery } };

  if (action.action === 'read_context') {
    try {
      if (controls?.version === 2 && controls.stage === 'final') {
        requireCondition(typeof action.purpose === 'string' && action.purpose.trim().length > 0,
          'synthesis_context_purpose_missing', 'A final-stage lookup must identify the concrete missing fact or exception before another lookup can be delivered');
      }
      const draftRecord = store.get<DiscoveryDraft>(input.draft.id, input.draft.revision);
      const questionRecord = store.get<Question>(input.question.id, input.question.revision);
      requireCondition(draftRecord && questionRecord
        && canonical(reference(draftRecord)) === canonical(input.draft)
        && canonical(reference(questionRecord)) === canonical(input.question),
      'context_lookup_integrity', 'The exact lookup draft or question is missing');
      const result = exactContextLookup(store, draftRecord, questionRecord, action.record, action.pointer, action.page,
        input.proveRecord);
      requireCondition(canonical(result).length <= input.readLimit, 'context_read_limit', 'Use a smaller addressed context page');
      const delivered = Array.isArray(subject.contextWorkspace) ? subject.contextWorkspace as ContextLookup[] : [];
      return { kind: 'lookup', checkpoint: null, session: { ...before, focus: null,
        workspace: addContextLookup(workspace, result, delivered),
        ...(controls?.stage === 'final' || final
          ? { finalization: { lookups: (before.finalization?.lookups ?? workspace.sinceProgress) + 1 } } : {}) } };
    } catch (error) {
      if (error instanceof EngineError && LOOKUP_BLOCKED_CODES.has(error.code)) {
        return { kind: 'blocked', checkpoint: null, session: { ...before, blockedCode: error.code,
          workspace: { ...workspace, blocked: error.message } } };
      }
      throw error;
    }
  }

  requireCondition(!archive.savedOnly || action.action !== 'need_research', 'research_saved_only',
    'Finish from saved findings; new source reads are disabled for this recovery');
  if (page.complete && action.action !== 'checkpoint') {
    return { kind: 'result', checkpoint: null, session: { ...before, offset: page.end,
      materialOffset: page.nextMaterialOffset ?? 0, focus: null,
      workspace: contextProgress(workspace), result: action, ...outcomeDelivery } };
  }
  requireCondition(['checkpoint', 'answer', 'answer_delta'].includes(action.action),
    'synthesis_checkpoint_required', 'Save partial findings before continuing the remaining already-read materials');
  const proposal = action as Extract<ResearchAction, { action: 'checkpoint' | 'answer' | 'answer_delta' }>;
  const deliveredKeys = (Array.isArray(subject.contextWorkspace) ? subject.contextWorkspace as ContextLookup[] : [])
    .map(contextLookupKey);
  const newContext = controls?.version === 2
    && deliveredKeys.some(key => !(workspace.checkpointedKeys ?? []).includes(key));
  requireCondition(page.end > before.offset || (page.nextMaterialOffset ?? 0) > (before.materialOffset ?? 0) || newContext,
    'synthesis_no_progress', 'A checkpoint must advance material or record newly delivered context; repeated prose is not progress');
  requireCondition(proposal.question === questionId, 'research_question_foreign', 'Partial synthesis must target its bound question');
  const checkpoint = exactCheckpoint(projectId, input.draft, input.question, {
    question: questionId, value: proposal as unknown as Json, citations: proposal.citations,
    unresolved: proposal.action === 'checkpoint' ? proposal.unresolved
      : ['Complete the remaining material pages before accepting this proposal'] }, store);
  const note: SynthesisNote = { checkpoint: { id: checkpoint.id, revision: 1, hash: hashJson(checkpoint.value) },
    proposal, page: { offset: before.offset, end: page.end } };
  return { kind: 'page', checkpoint, session: { ...before, offset: page.end, materialOffset: page.nextMaterialOffset ?? 0,
    focus: null, workspace: contextProgress(workspace),
    ...(page.end === materials.length
      ? { finalization: { lookups: before.finalization?.lookups ?? workspace.sinceProgress } } : {}),
    notes: [...before.notes, note] } };
}

/** Shared parse of a v2 synthesis session's producer contract and binding
 * (№1555 X52): used by response-recovery and context-recovery; reads nothing. */
export function parseSynthesisSessionV2(value: unknown): {
  contract: typeof SYNTHESIS_SESSION_CONTRACT; projectId: string; offset: number; materialOffset: number;
  binding: { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] };
  notes: unknown[]; result: unknown;
} | null {
  if (!recordValue(value) || value.contract !== SYNTHESIS_SESSION_CONTRACT
    || typeof value.projectId !== 'string' || !value.projectId
    || !Number.isSafeInteger(value.offset) || value.offset < 0
    || !Number.isSafeInteger(value.materialOffset ?? 0) || (value.materialOffset ?? 0) < 0
    || !recordValue(value.binding) || !isRef(value.binding.draft) || !isRef(value.binding.question)
    || !isRef(value.binding.environment) || !Array.isArray(value.binding.inputs)
    || !value.binding.inputs.every(isRef)
    || !Array.isArray(value.notes) || !(value.result === null || recordValue(value.result))) return null;
  return value as { contract: typeof SYNTHESIS_SESSION_CONTRACT; projectId: string; offset: number;
    materialOffset: number; binding: { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] };
    notes: unknown[]; result: unknown };
}

/** A reservation is consumed only by a delivery INTO ITS OWN turn (№1676):
 * the delivery mark's address is derived from the reservation itself, so the
 * previous reservation's mark stays history and never consumes the new one.
 * No store read needed — the turn id is content-addressed by [run, number]. */
export function synthesisReservationConsumed(value: { delivery?: { run: string; turn: number } | null;
  delivered?: Ref | null }): boolean {
  return value.delivery != null && value.delivered != null
    && value.delivered.id === `research-turn:${hashJson([value.delivery.run, value.delivery.turn])}`;
}

/** A reservation-only session step (№1658 К2): the same task, unfinished, with
 * a new proven reservation written before the next intent — lawful only when
 * the previous reservation was consumed by its own delivery or never existed.
 * Shared by the chain reader, the application validator and the producer. */
export function isReservationOnlySessionStep(step: Record<string, any>, before: Record<string, any>): boolean {
  const delivery = before.delivery ?? null;
  return step.result === null && recordValue(step.delivery)
    && (before.delivery == null || synthesisReservationConsumed(before))
    && canonical({ ...step, delivery }) === canonical({ ...before, delivery });
}

export interface ContextRecoveryTransitionInput {
  before: SynthesisSessionState;
  beforeRef: Ref;
  selector: { record: Ref; pointer: string; page?: { offset: number; limit: number } };
  result: ContextLookup;
  /** The exact blocked message, or CONTEXT_RECOVERY_SUPERSEDE_REASON when the
   * recovery lawfully supersedes a merely-prepared step of this head (X31). */
  reason: string;
}

/** The operator context replacement of a pending prepared step is a proven
 * transition to the next step, never a new generation of the old one. */
export const CONTEXT_RECOVERY_SUPERSEDE_REASON = 'operator context supersedes a prepared step';

/** The single formula of the v2 operator context-recovery transition: the
 * producer (context-recovery.ts) computes the lookup by current admission and
 * calls this; the session chain reader re-derives the same revision from the
 * exact saved predecessor and selector. No paid answer, note, cursor or prior
 * application changes; only the workspace gains the exact new original. */
export function projectContextRecoveryTransition(input: ContextRecoveryTransitionInput):
  { session: SynthesisSessionState; key: string } {
  const before = input.before;
  requireCondition(recordValue(before) && isRef(input.beforeRef) && recordValue(input.selector)
    && isRef(input.selector.record) && typeof input.selector.pointer === 'string'
    && recordValue(input.result) && typeof input.reason === 'string' && input.reason.length > 0,
    'context_recovery_invalid', 'Recovery requires an exact session, record, pointer and reason');
  const beforeWorkspace = contextWorkspace(before.workspace, before.focus);
  const blocked = typeof beforeWorkspace.blocked === 'string' && beforeWorkspace.blocked.length > 0
    ? beforeWorkspace.blocked : null;
  requireCondition(blocked !== null ? input.reason === blocked : input.reason === CONTEXT_RECOVERY_SUPERSEDE_REASON,
    'context_session_not_blocked', 'Only a blocked context session or a supersede of a merely-prepared step needs explicit recovery');
  requireCondition(Number.isSafeInteger(input.selector.page?.offset ?? 0)
    && (input.selector.page === undefined || Number.isSafeInteger(input.selector.page.limit) && input.selector.page.limit > 0),
    'context_recovery_invalid', 'Recovery requires an exact record and JSON pointer');
  const key = contextLookupKey(input.result);
  requireCondition(!input.result.page || input.result.page.end > input.result.page.offset,
    'context_recovery_empty', 'An empty page cannot establish new context material');
  requireCondition(!beforeWorkspace.entries.some(entry => entry.key === key),
    'context_recovery_unchanged', 'Select genuinely different material or a different page to recover this session');
  const { blocked: _blocked, ...unblocked } = beforeWorkspace;
  const finalization = { lookups: Math.max(before.finalization?.lookups ?? 0, beforeWorkspace.sinceProgress) };
  const recovery = { origin: 'operator', session: input.beforeRef, reason: input.reason,
    selector: input.selector, key };
  return { key, session: { ...before, finalization,
    workspace: { ...unblocked, entries: [...unblocked.entries, { key, result: input.result }], sinceProgress: 0 },
    recoveries: [...(before.recoveries ?? []), recovery] } };
}

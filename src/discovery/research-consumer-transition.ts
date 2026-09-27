import { Ajv } from 'ajv';
import { canonical } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { tokenUsage, type ModelCall } from '../runtime/model-usage.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { normalizeResearchAction } from './research-action-normalization.js';
import type { ReaderResult } from './reader.js';
import type { ResearchAction } from './research-model.js';
import type { Observation } from '../evidence/evidence.js';
import type { ReaderSelection } from './reader.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { Store } from '../storage/store.js';
import { reference } from '../pipeline/contracts.js';

/* This module is the dependency leaf for paid consumer transitions. Its inputs
 * are exact records already checked by their respective historical readers;
 * it never looks up a mutable HEAD, a source path, or a consumer module. */
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

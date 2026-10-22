import { decodeVariantExecutionSession, decodeVariantGeneration, type VariantExecutionSession } from './discovery-variants.js';
import type { AssessmentTransportSubject } from './continuation-packet.js';
import { DISCOVERY_ASSESSMENT_CONTRACT_V2, DISCOVERY_ASSESSMENT_CONTRACT_V3, type DiscoveryAttemptsAssessmentV2, type DiscoveryAttemptsAssessmentV3, type PaidDiscoveryAttemptsAssessment } from './research-model.js';
import { earlyResearchFailure, deliveredConceptSections, EARLY_RESEARCH_OUTCOME, researchResultFailure, requireAttemptsAssessmentReply,
  type EarlyUnknownAdmission } from './early-research-outcome.js';
import { Ajv, type ValidateFunction } from 'ajv';
import { canonical, digest, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { tokenUsage, type ModelCall } from '../runtime/model-usage.js';
import { isRef, reference, type Ref, type Finding, type StageArtifact } from '../pipeline/contracts.js';
import { normalizeResearchAction } from './research-action-normalization.js';
import { webAction, WEB_ACTIONS, projectWebApplication, WEB_CAPTURE_CONTRACT, WEB_CAPTURE_CONTRACT_V2,
  WEB_CAPTURE_CONTRACT_V3, type WebMaterialBudget, type WebCapture } from './web-research.js';
import { queuedChildReached } from './reading-plan.js';
import type { ReaderResult } from './reader.js';
import type { EarlyUnknown, ResearchAction, ResearchAnswer, ResearchAssessment, ResearchRun, ResearchTurn } from './research-model.js';
import { projectSourceReading, SOURCE_READ_CONTRACT, SOURCE_READ_CONTRACT_V2, SOURCE_READ_CONTRACT_V3,
  sourceReadContract, type SourceReadContract, type Observation, type Selector, type Source } from '../evidence/evidence.js';
import { searchStructuredSource, STRUCTURED_SEARCH_CONTRACT, SEARCH_TEXT_LIMIT, SEARCH_FRAGMENT_LIMIT,
  safeTextEnd, type StructuredFragment } from '../evidence/source-navigation.js';
import type { ReaderSelection } from './reader.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { Revision, Store } from '../storage/store.js';
import { consolidationNotice, consolidatedProposal, consolidationPage,
  consolidationFragment, partialConsolidatedProposal, CONSOLIDATION_FRAGMENT,
  type ConsolidationNotice, type SynthesisNote } from './conclusion-consolidation.js';
import { addContextLookup, contextLookupKey, contextProgress, contextWorkspace, foldContextEvent, recordContextPacket,
  requireCompleteContextPacket,
  type ContextLookup, type ContextWorkspace } from './context-workspace.js';
import { archivedContext, contextPage, contextValue, type ContextPage } from './working-context.js';
import type { Graph } from '../graph/model.js';
import type { ResearchConsumerIntent } from './response-recovery.js';
import type { V7Attempt } from './v7-plan-questions.js';
import { ATTEMPT_BINDING_CONTRACT, addressedQuestionId, attemptBindingId, attemptEndOfAction, planSubjectOf, sameSubject,
  type ResearchAttemptBinding, type V7PlanSubject } from './v7-managed-attempt.js';
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
const contextReadPage = object({ offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1 } });
contextReadPage.properties['encoding'] = { const: 'canonical-json' };
contextRead.properties['page'] = contextReadPage;
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
let actionValidator: ValidateFunction<ResearchAction> | undefined;
const validateAction = (value: unknown): value is ResearchAction =>
  (actionValidator ??= new Ajv({ allErrors: true }).compile<ResearchAction>({ oneOf: [
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
] }))(value);

let readerReplyValidator: ValidateFunction<{ selections: ReaderSelection[]; unresolved: string[] }> | undefined;
const validateReaderReply = (value: unknown): value is { selections: ReaderSelection[]; unresolved: string[] } =>
  (readerReplyValidator ??= new Ajv({ allErrors: true }).compile<{
    selections: ReaderSelection[]; unresolved: string[] }>(object({
    selections: { type: 'array', items: { oneOf: [
      object({ source: ref, firstLine: { type: 'integer', minimum: 1 }, lastLine: { type: 'integer', minimum: 1 } }),
      object({ sourceIndex: { type: 'integer', minimum: 0 },
        firstLine: { type: 'integer', minimum: 1 }, lastLine: { type: 'integer', minimum: 1 } })] } },
    unresolved: { type: 'array', items: text } })))(value);

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
    'Reader must return only source/line selections and unresolved questions', readerReplyValidator?.errors);
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

/**
 * UNK1 (№4686 §3): the early analyst action era that admits the unknown door — `need_research` on the current question
 * completes the turn with observation.unknown. Fixed in the intent cursor before the send; every producer, classifier,
 * projection and historical reader takes it from there. An intent without it keeps the DRY5FIX era: a refusal.
 */
export const EARLY_ACTIONS = 'early-research-actions/v2' as const;
export const EARLY_UNKNOWN = 'early-research-unknown/v1' as const;
export const earlyUnknownEra = (cursor: unknown): boolean =>
  cursor !== null && typeof cursor === 'object' && (cursor as { earlyActions?: unknown }).earlyActions === EARLY_ACTIONS;
let earlyNeedValidator: ValidateFunction<Extract<ResearchAction, { action: 'need_research' }>> | undefined;
const validateEarlyNeed = (value: unknown): value is Extract<ResearchAction, { action: 'need_research' }> =>
  (earlyNeedValidator ??= new Ajv({ allErrors: true }).compile<Extract<ResearchAction, { action: 'need_research' }>>({
    type: 'object', additionalProperties: false, required: ['action', 'question', 'missing'], properties: {
      action: { const: 'need_research' }, question: text, missing: { type: 'array', minItems: 1, items: text },
      upstream: object({ stage: ref, field: text }) } }))(value);
const isNeedResearch = (value: unknown): boolean => value !== null && typeof value === 'object'
  && (value as { action?: unknown }).action === 'need_research';
/** The early need_research of the unknown era — the global planning schema is not widened after the fact. */
function earlyNeedResearch(value: unknown): Extract<ResearchAction, { action: 'need_research' }> {
  value = normalizeResearchAction(value);
  if (!validateEarlyNeed(value)) throw new EngineError('research_response_invalid',
    'An early need_research names its question, the missing material and optionally an exact upstream stage and field',
    earlyNeedValidator?.errors);
  return value;
}

/** One action parser for transport, writes, and historical transition proofs. */
export function researchAction(value: unknown): ResearchAction {
  value = normalizeResearchAction(value);
  if (!validateAction(value)) throw new EngineError('research_response_invalid',
    'Research action has missing or invalid fields', actionValidator?.errors);
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

/** WB1 (№4639): web research is a capability of one call — the Discovery analyst whose SAVED dispatch enabled it.
 * Today's environment never reclassifies a saved call. */
export function webResearchCapability(stage: unknown, role: unknown, dispatch: { webResearch?: { enabled?: unknown } } | null | undefined): boolean {
  return stage === 'discovery' && role === 'analyst' && dispatch?.webResearch?.enabled === true;
}
const isWebPayload = (value: unknown): boolean => value !== null && typeof value === 'object'
  && WEB_ACTIONS.includes((value as { action?: unknown }).action as string);
/** DR3a3-K: a paid answer of an attempt subject is parsed by the subject/end contract the saved intent
 * selected (an end of its plan-question; bases live inside the end, so the envelope has no citations) —
 * never by the uncited-answer rule of the field path. Every other action keeps its own parser. */
function subjectAnswer(value: unknown, subject: V7PlanSubject | null): ResearchAction | null {
  if (!subject || value === null || typeof value !== 'object') return null;
  const kind = (value as { action?: unknown }).action;
  if (kind !== 'answer' && kind !== 'answer_delta') return null;
  attemptEndOfAction(value, subject);
  return value as ResearchAction;
}
/** A paid reply classified by its own call: without the capability the shared parser — and its original
 * research_response_invalid — is unchanged; with it a web action is checked by its own contract. */
export function responseAction(value: unknown, web: boolean, unknown = false,
  subject: V7PlanSubject | null = null): ResearchAction {
  const attempt = subjectAnswer(value, subject);
  if (attempt) return attempt;
  if (unknown && isNeedResearch(value)) return earlyNeedResearch(value);
  if (!web || !isWebPayload(value)) return researchAction(value);
  try { return webAction(value); }
  catch (error) {
    if (error instanceof EngineError) throw new EngineError('research_response_invalid', error.message, error.details);
    throw error;
  }
}
/** The action of a turn that already exists: a web turn exists only after its call was admitted with the capability. */
export function admittedResearchAction(value: unknown, subject: V7PlanSubject | null = null): ResearchAction {
  const attempt = subjectAnswer(value, subject);
  if (attempt) return attempt;
  // UNK1: an upstream address exists only in a turn admitted by the unknown era.
  if (isNeedResearch(value) && Object.hasOwn(value as object, 'upstream')) return earlyNeedResearch(value);
  return isWebPayload(value) ? webAction(value) : researchAction(value);
}
/** DR3a3-K: the action of a saved turn, read by the turn's own immutable subject (O@1 of the attempt era
 * carries the subject its producer proved against the intent; a field turn carries none). */
export function turnAction(turn: { action?: unknown }): ResearchAction {
  return admittedResearchAction(turn.action, planSubjectOf(turn));
}
/** DR3a3-K: the logical question a managed turn addresses — the plan-question id of its attempt subject, the
 * Question record id of a field turn (turn.question stays the Question basis); null without a selected question. */
export function turnQuestionId(turn: { question?: unknown }): string | null {
  return isRef(turn.question) ? addressedQuestionId(turn.question, planSubjectOf(turn)) : null;
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
  contextCorrection?: { code: 'research_context_incomplete'; record: Ref; pointer: string;
    unit: string; total: number; next: number; ranges: { offset: number; end: number }[] } | null;
}

/* ---------- DR3a3-S1 (codex-omg №7690, решения 2, 3, 8): the subject forms ----------
 * A v7 plan-question is one subject of one physical plan Question. Its session,
 * partial note and saved-only selection are separately typed forms with a
 * mandatory exact subject and their own address space; the v2/v1 forms keep
 * their formulas and meaning. One projector serves the writer and the reader. */

export const SYNTHESIS_SESSION_CONTRACT_V3 = 'synthesis-session/v3' as const;
export const SYNTHESIS_SESSION_V2_PREFIX = 'synthesis-session:v2:' as const;
export const SYNTHESIS_SESSION_V3_PREFIX = 'synthesis-session:v3:' as const;
export interface SynthesisSessionBindingV3 { draft: Ref; question: Ref; environment: Ref; inputs: Ref[]; subject: V7PlanSubject }
export type SynthesisSessionStateV3 = Omit<SynthesisSessionState, 'contract' | 'binding'>
  & { contract: typeof SYNTHESIS_SESSION_CONTRACT_V3; binding: SynthesisSessionBindingV3 };

/** The exact subject of a saved subject-bearing form. Missing, null, damaged
 * or unknown-contract is research_plan_subject_invalid — never "no subject". */
export function requirePlanSubject(value: unknown, where: string): V7PlanSubject {
  let subject: V7PlanSubject | null = null;
  try { subject = planSubjectOf({ subject: value }); } catch { subject = null; }
  if (!subject) throw new EngineError('research_plan_subject_invalid',
    `[${where}] The form needs its exact v7-plan-subject/v1 subject`, { reason: 'subject' });
  return subject;
}

/** The v3 task address (решение 8): project, draft, the exact subject, the
 * Question's semantic basis (id/hash), inputs, materials and the previous
 * proposal with its exact Ref. The environment stays out of the task identity
 * (it lives in the binding), as in v2; the v2 formula is unchanged. */
export function synthesisSessionV3Address(input: { projectId: string; draft: Ref; question: Ref; inputs: readonly Ref[];
  subject: V7PlanSubject; materials: unknown; previousProposal: unknown; previousProposalRef: Ref | null }): string {
  return `${SYNTHESIS_SESSION_V3_PREFIX}${hashJson([input.projectId, input.draft.id, input.subject,
    { id: input.question.id, hash: input.question.hash }, input.inputs, input.materials,
    input.previousProposal ?? null, input.previousProposalRef ?? null])}`;
}

export interface SynthesisSessionV3Origin {
  projectId: string; binding: SynthesisSessionBindingV3; basis: SynthesisSessionBasis;
  delivery?: SynthesisSessionDelivery | null; workspace?: ContextWorkspace;
}

/** The first record of a v3 session and its address. The producer writes
 * exactly this value; the exact reader re-derives it from the saved binding,
 * basis, reservation and inherited runner context. */
export function projectSynthesisSessionV3Initial(origin: SynthesisSessionV3Origin): { id: string; value: SynthesisSessionStateV3 } {
  requireCondition(recordValue(origin) && typeof origin.projectId === 'string' && !!origin.projectId
    && recordValue(origin.binding) && isRef(origin.binding.draft) && isRef(origin.binding.question)
    && isRef(origin.binding.environment) && Array.isArray(origin.binding.inputs) && origin.binding.inputs.every(isRef)
    && recordValue(origin.basis) && Array.isArray(origin.basis.materials)
    && (origin.basis.previousProposalRef === null || isRef(origin.basis.previousProposalRef)),
  'synthesis_session_invalid', 'A v3 synthesis session needs its exact binding and basis');
  const subject = requirePlanSubject(origin.binding.subject, 'synthesis-session');
  requireCondition(origin.workspace === undefined || origin.delivery != null,
    'synthesis_session_invalid', 'A direct session cannot inherit a runner context');
  const binding: SynthesisSessionBindingV3 = { draft: origin.binding.draft, question: origin.binding.question,
    environment: origin.binding.environment, inputs: [...origin.binding.inputs], subject };
  const basis: SynthesisSessionBasis = { materials: origin.basis.materials,
    previousProposal: origin.basis.previousProposal ?? null, previousProposalRef: origin.basis.previousProposalRef ?? null };
  const value: SynthesisSessionStateV3 = { contract: SYNTHESIS_SESSION_CONTRACT_V3, projectId: origin.projectId,
    offset: 0, notes: [], result: null, basis, binding,
    ...(origin.delivery != null ? { delivery: origin.delivery } : {}),
    ...(origin.workspace !== undefined ? { workspace: origin.workspace } : {}) };
  return { id: synthesisSessionV3Address({ projectId: origin.projectId, draft: binding.draft, question: binding.question,
    inputs: binding.inputs, subject, materials: basis.materials, previousProposal: basis.previousProposal,
    previousProposalRef: basis.previousProposalRef }), value };
}

/** The subject a saved synthesis session is bound to: none for v2 and the
 * earlier eras, the mandatory exact subject for v3. The era is the address
 * prefix together with the contract: a contract that disagrees with its
 * address, or a pre-v3 record carrying a subject, is not a lawful session. */
export function synthesisSessionSubject(session: { id: string; value: unknown }): V7PlanSubject | null {
  const value = session.value as Record<string, any>;
  const v3 = typeof session.id === 'string' && session.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX);
  if (!recordValue(value) || (value.contract === SYNTHESIS_SESSION_CONTRACT_V3) !== v3 || !recordValue(value.binding))
    throw new EngineError('synthesis_session_invalid',
      `[${session.id}] The saved session contract does not match its address era`);
  if (!v3) {
    if (Object.hasOwn(value.binding, 'subject'))
      throw new EngineError('synthesis_session_invalid',
        `[${session.id}] A pre-v3 synthesis session cannot carry a v7 plan subject`);
    return null;
  }
  return requirePlanSubject(value.binding.subject, session.id);
}

/** DR3a3-S1: the subject of one synthesis/consolidation step of a session —
 * the step intent's saved cursor and the exact session must agree (none for
 * v2). The exact session reader applies it to every step, and the synthesis
 * handoff — the second producer of O@1 — fixes exactly this subject on its
 * turn: never a caller's context or today's selected question. */
export function synthesisStepSubject(intent: { cursor: unknown }, session: { id: string; value: unknown }): V7PlanSubject | null {
  let declared: V7PlanSubject | null;
  try { declared = planSubjectOf(intent.cursor); }
  catch { throw new EngineError('research_consumer_intent_invalid', `[${session.id}] The synthesis step carries a damaged plan subject`); }
  const bound = synthesisSessionSubject(session);
  if (!sameSubject(declared, bound))
    throw new EngineError('research_consumer_intent_invalid',
      `[${session.id}] The synthesis step names another subject than its exact session`);
  return bound;
}

/** Payload/proof failures of a received synthesis reply are saved as the
 * step's unresumable refusal; exact-read and integrity failures are not: an
 * origin-proof failure (reader_result_invalid / context_lookup_integrity)
 * propagates with the prior session and the physical response preserved and
 * the intent still running — a repeat re-derives the same refusal from the
 * proven execution without a new P (№1658-1). */
export const SYNTHESIS_TRANSITION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'research_result_capacity', 'research_response_invalid', 'research_checkpoint_empty', 'research_mode_invalid',
  'research_question_foreign', 'synthesis_cursor_invalid', 'synthesis_checkpoint_required',
  'synthesis_no_progress', 'research_saved_only', 'consolidation_response_invalid',
  'consolidation_coverage_invalid', 'consolidation_citations_invalid']);

/** Semantic lookup failures become the saved blocked outcome; anything else
 * (integrity, unexpected exceptions) propagates without a session write. */
const LOOKUP_BLOCKED_CODES: ReadonlySet<string> = new Set([
  'synthesis_context_purpose_missing', 'context_read_limit', 'context_reference_foreign',
  'context_reference_stale', 'selector_invalid', 'context_missing', 'context_page_invalid',
  'research_no_progress', 'research_context_invalid']);

/** Exported (DR3a3-S5, круг 3): the v3 basis proof re-derives a Source
 * observation material by the same historical formula as a note's evidence. */
export function exactObservation(store: Store, projectId: string, sourceRef: Ref, selector: Selector): Observation {
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

/** DR3a3-S1 (решение 2): the saved partial note of a v7 plan-question —
 * proposed, unassessed findings with checked sources, never accepted claims
 * and never an attempt end. The wire checkpoint addresses the plan-question
 * id; the record keeps the real Question Ref and the exact subject. One
 * formula for the writer and the exact reader, like v1 above. */
export const RESEARCH_CHECKPOINT_V2_CONTRACT = 'research-checkpoint/v2' as const;
export const RESEARCH_CHECKPOINT_V2_PREFIX = 'research-checkpoint:v2:' as const;
const CHECKPOINT_V2_FIELDS = ['contract', 'projectId', 'draft', 'question', 'subject', 'status',
  'proposal', 'observations', 'unresolved'].sort().join(',');
/** The wire checkpoint's unresolved list (schema above: array of non-empty
 * text) — one rule for the v2 projector input and the saved v2 form. */
export const checkpointUnresolvedHolds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
export function projectCheckpointValueV2(projectId: string, draft: Ref, question: Ref, subject: V7PlanSubject,
  action: CheckpointProposalInput, observe: (source: Ref, selector: Selector) => Observation): { id: string; value: Record<string, any> } {
  const exact = requirePlanSubject(subject, 'research-checkpoint');
  requireCondition(recordValue(action) && typeof action.question === 'string' && action.question === exact.planQuestionId
    && Object.hasOwn(action, 'value') && Array.isArray(action.citations) && Array.isArray(action.unresolved)
    && action.citations.every(citation => recordValue(citation) && isRef(citation.source) && recordValue(citation.selector)),
  'research_question_foreign', 'Checkpoint belongs to another plan-question');
  requireCondition(checkpointUnresolvedHolds(action.unresolved), 'research_response_invalid',
    'Checkpoint unresolved items must be non-empty texts');
  const observations = action.citations.map(citation => observe(citation.source, citation.selector));
  const value = { contract: RESEARCH_CHECKPOINT_V2_CONTRACT, projectId, draft, question, subject: exact,
    status: 'unassessed', proposal: action.value, observations, unresolved: action.unresolved };
  return { id: `${RESEARCH_CHECKPOINT_V2_PREFIX}${hashJson(value)}`, value };
}
/** The exact form of a saved v2 note: its fields, project-bound refs and subject. */
export function researchCheckpointV2Holds(value: unknown): boolean {
  if (!recordValue(value) || Object.keys(value).sort().join(',') !== CHECKPOINT_V2_FIELDS
    || value.contract !== RESEARCH_CHECKPOINT_V2_CONTRACT || typeof value.projectId !== 'string' || !value.projectId
    || !isRef(value.draft) || !isRef(value.question) || value.status !== 'unassessed'
    || !Array.isArray(value.observations) || !checkpointUnresolvedHolds(value.unresolved)) return false;
  try { requirePlanSubject(value.subject, 'research-checkpoint'); return true; } catch { return false; }
}

/** DR3a3-S1 (решение 3): the saved-only selection of one subject — its own
 * address space from project+subject, the exact Question/draft/inputs, the
 * subject and the exact v2 checkpoints of that subject in their proven order.
 * Choosing and proving the checkpoints belongs to the command (S4); this is
 * the one form its writer and readers share. */
export const SAVED_SYNTHESIS_V2_CONTRACT = 'saved-synthesis/v2' as const;
export interface SavedSynthesisV2 {
  contract: typeof SAVED_SYNTHESIS_V2_CONTRACT; projectId: string; draft: Ref; question: Ref; inputs: Ref[];
  subject: V7PlanSubject; checkpoints: Ref[];
}
const SAVED_SYNTHESIS_V2_FIELDS = ['contract', 'projectId', 'draft', 'question', 'inputs', 'subject', 'checkpoints'].sort().join(',');
export const savedSynthesisV2Id = (projectId: string, subject: V7PlanSubject): string =>
  `saved-synthesis:v2:${hashJson([projectId, subject])}`;
export function projectSavedSynthesisV2(input: Omit<SavedSynthesisV2, 'contract'>): { id: string; value: SavedSynthesisV2 } {
  const value: SavedSynthesisV2 = { contract: SAVED_SYNTHESIS_V2_CONTRACT, projectId: input?.projectId,
    draft: input?.draft, question: input?.question, inputs: input?.inputs,
    subject: requirePlanSubject(input?.subject, 'saved-synthesis'), checkpoints: input?.checkpoints };
  const id = savedSynthesisV2Id(value.projectId, value.subject);
  savedSynthesisV2Shape(value, id);
  return { id, value };
}
/** The saved-only form and its address. No eligible checkpoint is
 * saved_synthesis_missing; any other deviation is saved_synthesis_stale. */
export function savedSynthesisV2Shape(value: unknown, id: string): asserts value is SavedSynthesisV2 {
  if (!recordValue(value) || Object.keys(value).sort().join(',') !== SAVED_SYNTHESIS_V2_FIELDS
    || value.contract !== SAVED_SYNTHESIS_V2_CONTRACT || typeof value.projectId !== 'string' || !value.projectId
    || !isRef(value.draft) || !isRef(value.question) || !Array.isArray(value.inputs) || !value.inputs.every(isRef)
    || !Array.isArray(value.checkpoints))
    throw new EngineError('saved_synthesis_stale', `[${id}] The saved-only selection lost its exact form`);
  const subject = requirePlanSubject(value.subject, id);
  requireCondition(id === savedSynthesisV2Id(value.projectId, subject),
    'saved_synthesis_stale', 'The saved-only selection address does not match its project and subject');
  requireCondition(value.checkpoints.length > 0, 'saved_synthesis_missing', 'No paid checkpoint of this exact subject is selected');
  requireCondition(value.checkpoints.every(ref => isRef(ref) && ref.id.startsWith(RESEARCH_CHECKPOINT_V2_PREFIX))
    && new Set(value.checkpoints.map(ref => ref.id)).size === value.checkpoints.length,
  'saved_synthesis_stale', 'The saved-only selection names only distinct v2 checkpoints');
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
  // DR3a3-S1: a research-checkpoint/v2 note keeps its own address space and
  // exact form (with its subject); the v1 branch is unchanged.
  const v2 = recordValue(record.value) && record.value.contract === RESEARCH_CHECKPOINT_V2_CONTRACT;
  requireCondition(!v2 || researchCheckpointV2Holds(record.value),
    'context_lookup_integrity', 'A saved v2 checkpoint lost its exact subject form');
  requireCondition(record.id === `${v2 ? RESEARCH_CHECKPOINT_V2_PREFIX : 'research-checkpoint:'}${hashJson(record.value)}`
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
  /** DR3a3-S5 (S5-02): mandatory for a v3 session — the one subject predicate
   * (a note of exactly this subject with its paid origin, an archive of no or
   * this subject), supplied identically by the writer and the paid reader. */
  subjectRecord?: (record: Revision<Record<string, any>>, subject: V7PlanSubject) => boolean;
}

export interface SynthesisTransition {
  kind: 'consolidation' | 'pause' | 'lookup' | 'blocked' | 'result' | 'page' | 'context-incomplete';
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
  const capacityFailure = researchResultFailure(archive.resultCapacity, input.payload);
  if (capacityFailure) throw capacityFailure;
  // DR3a3-S5: a v3 session answers its exact plan-question — its actions address
  // the plan-question id, its notes are subject-bound v2 checkpoints and its end
  // is a V7AttemptEnd. The subject is the session's own saved binding (one
  // projection for the writer and the paid-transition reader); v2 is unchanged.
  const planSubject = typeof input.sessionId === 'string' && input.sessionId.startsWith(SYNTHESIS_SESSION_V3_PREFIX)
    ? synthesisSessionSubject({ id: input.sessionId, value: before }) : null;
  requireCondition(!planSubject || typeof input.subjectRecord === 'function',
    'research_context_invalid', 'A v3 synthesis transition needs its subject record proof');
  const questionId = planSubject ? planSubject.planQuestionId : input.question.id;
  const checkpointOf = (proposal: CheckpointProposalInput) => planSubject
    ? projectCheckpointValueV2(projectId, input.draft, input.question, planSubject, proposal,
      (source, selector) => exactObservation(store, projectId, source, selector))
    : exactCheckpoint(projectId, input.draft, input.question, proposal, store);
  const workspace = contextWorkspace(before.workspace, before.focus);
  requireCondition(!workspace.blocked, 'research_no_progress', workspace.blocked ?? 'Saved context session is blocked');

  if (kind === 'consolidation') {
    const goal = archive.consolidation;
    requireCondition(recordValue(goal) && Number.isSafeInteger(goal.targetChars) && goal.targetChars > 0
      && Number.isSafeInteger(goal.fullTargetChars) && goal.fullTargetChars > 0
      && (goal.tightening === undefined || recordValue(goal.tightening) && isRef(goal.tightening.from)),
    'consolidation_state_invalid', 'The saved consolidation goal lost its exact capacity contract');
    const action = researchAction(input.payload);
    const fragment = subject.consolidation?.deliveryContract === CONSOLIDATION_FRAGMENT
      ? consolidationFragment(before.notes, goal, subject) : null;
    const selected = fragment ? null : consolidationPage(before.notes, goal, subject.consolidation);
    const proposal = fragment
      ? partialConsolidatedProposal(action, questionId, fragment.original, fragment.previous,
          fragment.delivery, fragment.complete)
      : consolidatedProposal(action, questionId, before.notes, selected!);
    const checkpoint = checkpointOf({
      question: questionId, value: proposal as unknown as Json,
      citations: proposal.citations, unresolved: proposal.unresolved });
    const note: SynthesisNote = {
      checkpoint: { id: checkpoint.id, revision: 1, hash: hashJson(checkpoint.value) }, proposal,
      page: { offset: before.offset, end: before.offset },
      consolidated: { replaces: fragment
        ? [...(fragment.complete ? [fragment.original.checkpoint] : []),
            ...(fragment.previous ? [fragment.previous.checkpoint] : [])]
        : selected!.map(item => item.checkpoint),
        ...(goal.format === 2 ? { format: 2 as const, targetChars: goal.targetChars, fullTargetChars: goal.fullTargetChars } : {}),
        ...(fragment && !fragment.complete ? { partial: { original: fragment.original.checkpoint,
          offset: 0, end: fragment.delivery.served.end, total: fragment.delivery.served.total,
          valueHash: hashJson(fragment.original.proposal) } } : {}),
        ...(goal.tightening ? { tightenedFrom: goal.tightening.from } : {}) } };
    const notice = fragment && !fragment.complete ? null : consolidationNotice(note);
    return { kind: 'consolidation', checkpoint, session: { ...before, notes: [...before.notes, note],
      ...(notice ? { notices: [...(before.notices ?? []), notice] } : {}) } };
  }

  const materials = archive.synthesisMaterials;
  requireCondition(Array.isArray(materials) && materials.every(recordValue),
    'research_context_invalid', 'The archived synthesis materials are missing');
  // A v3 answer is read by its subject: exactly one attempt end, citations:[].
  const action = planSubject ? admittedResearchAction(input.payload, planSubject) : researchAction(input.payload);
  const page = subject.synthesisPage;
  requireCondition((planSubject ? ['answer', 'checkpoint', 'read_context', 'need_research', 'need_owner', 'pause']
    : ['answer', 'answer_delta', 'checkpoint', 'read_context', 'need_research', 'need_owner', 'pause']).includes(action.action),
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
      const bounded = archive.contextReadContract === 'research-context-read/v2';
      const original = exactContextLookup(store, draftRecord, questionRecord,
        action.record, action.pointer, bounded ? undefined : action.page, input.proveRecord);
      // S5-02: a v3 lookup carries only its subject's own material — never
      // another subject's note or archive on the shared plan Question.
      if (planSubject) requireCondition(input.subjectRecord!(store.get<Record<string, any>>(action.record.id,
        action.record.revision)!, planSubject), 'context_reference_foreign',
      'A v3 synthesis reads only notes and archives of its own plan subject');
      const result = bounded
        ? projectResearchContextSelection(original.value, action.record, action.pointer,
          action.page, input.readLimit, 'bounded')
        : (requireCondition(canonical(original).length <= input.readLimit,
          'context_read_limit', 'Use a smaller addressed context page'), original);
      const delivered = Array.isArray(subject.contextWorkspace) ? subject.contextWorkspace as ContextLookup[] : [];
      return { kind: 'lookup', checkpoint: null, session: { ...before, focus: null,
        ...(before.contextCorrection ? { contextCorrection: null } : {}),
        workspace: addContextLookup(workspace, result, delivered, undefined, subject),
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
    try { requireCompleteContextPacket(workspace, subject); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'research_context_incomplete') throw error;
      const detail = error.details as { record: Ref; pointer: string; unit: string; total: number;
        next: number; ranges: { offset: number; end: number }[] };
      return { kind: 'context-incomplete', checkpoint: null,
        session: { ...before, workspace: contextProgress(workspace, subject),
          contextCorrection: { code: 'research_context_incomplete', ...detail }, ...outcomeDelivery } };
    }
    return { kind: 'result', checkpoint: null, session: { ...before, offset: page.end,
      materialOffset: page.nextMaterialOffset ?? 0, focus: null,
      workspace: contextProgress(workspace, subject), result: action,
      ...(before.contextCorrection ? { contextCorrection: null } : {}), ...outcomeDelivery } };
  }
  // Decision 2: in v3 an early answer is not turned into a note — undelivered
  // materials need a checkpoint first; the paid payload stays with its refusal.
  requireCondition((planSubject ? ['checkpoint'] : ['checkpoint', 'answer', 'answer_delta']).includes(action.action),
    'synthesis_checkpoint_required', 'Save partial findings before continuing the remaining already-read materials');
  const proposal = action as Extract<ResearchAction, { action: 'checkpoint' | 'answer' | 'answer_delta' }>;
  const deliveredKeys = (Array.isArray(subject.contextWorkspace) ? subject.contextWorkspace as ContextLookup[] : [])
    .map(contextLookupKey);
  const newContext = controls?.version === 2
    && deliveredKeys.some(key => !(workspace.checkpointedKeys ?? []).includes(key));
  requireCondition(page.end > before.offset || (page.nextMaterialOffset ?? 0) > (before.materialOffset ?? 0) || newContext,
    'synthesis_no_progress', 'A checkpoint must advance material or record newly delivered context; repeated prose is not progress');
  requireCondition(proposal.question === questionId, 'research_question_foreign', 'Partial synthesis must target its bound question');
  const checkpoint = checkpointOf({
    question: questionId, value: proposal as unknown as Json, citations: proposal.citations,
    unresolved: proposal.action === 'checkpoint' ? proposal.unresolved
      : ['Complete the remaining material pages before accepting this proposal'] });
  const note: SynthesisNote = { checkpoint: { id: checkpoint.id, revision: 1, hash: hashJson(checkpoint.value) },
    proposal, page: { offset: before.offset, end: page.end } };
  return { kind: 'page', checkpoint, session: { ...before, offset: page.end, materialOffset: page.nextMaterialOffset ?? 0,
    focus: null, workspace: contextProgress(workspace, subject),
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

/** DR3a3-S1: the same shared parse for the v3 form — the v2 conditions plus
 * the mandatory exact subject; reads nothing. */
export function parseSynthesisSessionV3(value: unknown): {
  contract: typeof SYNTHESIS_SESSION_CONTRACT_V3; projectId: string; offset: number; materialOffset: number;
  binding: SynthesisSessionBindingV3; notes: unknown[]; result: unknown;
} | null {
  if (!recordValue(value) || value.contract !== SYNTHESIS_SESSION_CONTRACT_V3
    || !parseSynthesisSessionV2({ ...value, contract: SYNTHESIS_SESSION_CONTRACT })) return null;
  try { planSubjectOf({ subject: value.binding.subject }); } catch { return null; }
  return value as { contract: typeof SYNTHESIS_SESSION_CONTRACT_V3; projectId: string; offset: number;
    materialOffset: number; binding: SynthesisSessionBindingV3; notes: unknown[]; result: unknown };
}

/** A reservation is consumed only by a delivery INTO ITS OWN turn (№1676):
 * the delivery mark's address is derived from the reservation itself, so the
 * previous reservation's mark stays history and never consumes the new one.
 * No store read needed — the turn id is content-addressed by [run, number]. */
export function synthesisReservationConsumed(value: { delivery?: { run: string; turn: number } | null;
  delivered?: Ref | null }): boolean {
  return value.delivery != null && value.delivered != null
    && (value.delivered.id === `research-turn:${hashJson([value.delivery.run, value.delivery.turn])}`
      || value.delivered.id === managedTurnId(value.delivery.run, value.delivery.turn));
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

/* ==== D8.4c: managed consumer turns ====
 * The paid analyst/planner/escalation families below share the dependency-leaf
 * rule above: every projection consumes exact checked records, never a mutable
 * HEAD or a caller-supplied error. */

export type ContextReadPage = ContextPage;
export interface ProjectedContextRead {
  record: Ref; pointer: string; value: unknown;
  contract?: 'research-context-read/v2';
  outcome?: 'clipped';
  envelopeLimitChars?: number;
  requested?: { offset: number; limit: number; end: number; total: number; unit: 'utf16' | 'items';
    encoding?: 'canonical-json' };
  page?: { offset: number; end: number; total: number; unit: 'utf16' | 'items'; next: number | null;
    encoding?: 'canonical-json' };
}

/** The paid selector remains intact. Only its transport projection is made
 * smaller, and the served range is derived from the immutable original. */
export function projectResearchContextSelection(value: unknown, record: Ref, pointer: string,
  page: ContextReadPage | undefined, maxChars: number,
  mode: 'legacy' | 'bounded' = 'legacy'): ProjectedContextRead {
  const original: ProjectedContextRead = { record, pointer, ...contextPage(value, page) };
  requireCondition(Number.isSafeInteger(maxChars) && maxChars > 0,
    'context_read_limit', 'Addressed context needs a positive character limit');
  if (canonical(original).length <= maxChars) return original;
  requireCondition(mode === 'bounded' && page !== undefined,
    'context_read_limit', 'Use a smaller addressed context page');
  const source = page.encoding === 'canonical-json' ? canonical(value) : value as string | unknown[];
  const requestedEnd = Math.min(source.length, page.offset + page.limit);
  const requested = { offset: page.offset, limit: page.limit, end: requestedEnd, total: source.length,
    unit: (typeof source === 'string' ? 'utf16' : 'items') as 'utf16' | 'items',
    ...(page.encoding ? { encoding: page.encoding } : {}) };
  const fit = (text: string | unknown[], offset: number, total: number,
    encoding?: 'canonical-json'): ProjectedContextRead | null => {
    let low = 0, high = text.length;
    const candidate = (size: number): ProjectedContextRead => {
      const end = offset + size;
      return { contract: 'research-context-read/v2', outcome: 'clipped', requested,
        envelopeLimitChars: maxChars,
        record, pointer, value: text.slice(0, size),
        page: { offset, end, total, unit: typeof text === 'string' ? 'utf16' : 'items',
          next: end < total ? end : null, ...(encoding ? { encoding } : {}) } };
    };
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (canonical(candidate(middle)).length <= maxChars) low = middle;
      else high = middle - 1;
    }
    return low > 0 ? candidate(low) : null;
  };
  const selected = source.slice(page.offset, requestedEnd);
  const direct = fit(selected, page.offset, source.length, page.encoding);
  if (direct) return direct;
  // One array item may exceed the entire envelope. Its exact canonical JSON
  // is addressable by UTF-16 offset, so an item-sized refusal is unnecessary.
  if (Array.isArray(source) && requestedEnd > page.offset) {
    const encoded = canonical(source);
    const start = page.offset === 0 ? 0 : canonical(source.slice(0, page.offset)).length;
    const end = requestedEnd === source.length ? encoded.length
      : canonical(source.slice(0, requestedEnd)).length - 1;
    const fragment = fit(encoded.slice(start, end), start, encoded.length, 'canonical-json');
    if (fragment) return fragment;
  }
  throw new EngineError('context_read_limit', 'The addressed context page has no deliverable positive fragment',
    { requested, maxChars });
}

/** Selects a value from an already checked exact record, for both live writing
 * and historical proof. The record's provenance is checked by the caller. */
export function projectResearchContextRead(recordValue: unknown, record: Ref, pointer: string,
  page: ContextReadPage | undefined, maxChars: number,
  mode: 'legacy' | 'bounded' = 'legacy'): ProjectedContextRead {
  requireCondition(typeof pointer === 'string' && (pointer === '' || pointer.startsWith('/')),
    'selector_invalid', 'Use a JSON pointer');
  let value = recordValue;
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    requireCondition(!/~(?![01])/.test(part), 'selector_invalid', 'Invalid pointer escape');
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    requireCondition(value !== null && typeof value === 'object' && Object.hasOwn(value, key),
      'context_missing', 'Context pointer does not exist');
    value = (value as Record<string, unknown>)[key];
  }
  return projectResearchContextSelection(value, record, pointer, page, maxChars, mode);
}

export interface ContextReadIdentityInput {
  projectId: string;
  action: Extract<ResearchAction, { action: 'read_context' }>;
  observation: ProjectedContextRead;
  recordKind: string;
  recordValue: unknown;
  question: Ref;
  /** Supplied only when the projected value itself points to a reader result. */
  readerResult?: { ref: Ref; value: ReaderResult };
}

/** A repeat compares the exact addressed original. Archives may be rebuilt
 * around the same underlying source, so their wrapper Ref is not the key. */
export function contextReadIdentity(input: ContextReadIdentityInput): string {
  const { action, observation, recordKind, recordValue, question } = input;
  requireCondition(action.action === 'read_context' && isRef(action.record)
    && typeof input.projectId === 'string' && input.projectId.length > 0
    && isRef(question) && canonical(observation) === canonical(projectResearchContextRead(
      recordValue, action.record, action.pointer, action.page,
      observation.contract === 'research-context-read/v2'
        ? observation.envelopeLimitChars ?? 0 : Number.MAX_SAFE_INTEGER,
      observation.contract === 'research-context-read/v2' ? 'bounded' : 'legacy')),
  'research_consumer_intent_invalid', 'The repeated context is not its exact addressed result');
  const view = observation.value && typeof observation.value === 'object'
    && !Array.isArray(observation.value) && isRef((observation.value as Record<string, unknown>).ref)
    ? observation.value as Record<string, unknown> : observation as unknown as Record<string, unknown>;
  const viewRef = view.ref;
  if (isRef(viewRef) && viewRef.id.startsWith('reader-result:')) {
    const reader = input.readerResult;
    requireCondition(reader && canonical(reader.ref) === canonical(viewRef)
      && reader.value.projectId === input.projectId
      && reader.value.question.id === question.id
      && canonical(view.observations) === canonical(reader.value.observations),
    'research_consumer_intent_invalid', 'The repeated reader selection lacks its exact result');
    return canonical(reader.ref);
  }
  const page = observation.page ?? null;
  if (recordKind !== 'research-context') return canonical([action.record, action.pointer, page]);
  requireCondition(recordValue && typeof recordValue === 'object' && !Array.isArray(recordValue)
    && (recordValue as Record<string, unknown>).projectId === input.projectId
    && isRef((recordValue as Record<string, unknown>).draft)
    && isRef((recordValue as Record<string, unknown>).question)
    && (recordValue as { question: Ref }).question.id === question.id,
  'research_consumer_intent_invalid', 'The repeated archive lost its exact draft and question');
  const parts = action.pointer.split('/');
  for (let end = parts.length; end > 1; end -= 1) {
    const parent = projectResearchContextRead(recordValue, action.record,
      parts.slice(0, end).join('/'), undefined, Number.MAX_SAFE_INTEGER).value;
    const candidate = parent && typeof parent === 'object' && !Array.isArray(parent)
      ? parent as Record<string, unknown> : null;
    const origin = candidate?.source ?? candidate?.ref;
    if (isRef(origin)) return canonical([origin, parts.slice(end), page, observation.value]);
  }
  const archive = recordValue as { draft: Ref; question: Ref };
  return canonical([archive.draft.id, archive.question.id, action.pointer, page, observation.value]);
}

/** №1745-2: the exact records that made up this turn's accepted paid answer.
 * Persisted on the completed managed turn so historical readers consume the
 * named chain instead of rescanning a draft that may have moved on. */
export interface AcceptedAnswerChain {
  draftBefore: Ref; draftAfter: Ref; questionBefore: Ref; questionAfter: Ref;
  answer: Ref; assessment: Ref;
}
/** D8.4e (№2211 §4): the acceptance contract of a managed paid turn is fixed
 * by the producer of the ORIGINAL turn (O@1) — projectPaidTurnAdmission and
 * the synthesis handoff — as an explicit field, independent of any later
 * acceptance record. Readers select the era by this field alone: a turn that
 * names the binding contract completes only through a proven K; a turn
 * without it (written before the field existed) keeps the earlier rules.
 * The field is immutable across the turn's revisions like the paid action. */
export const ACCEPTANCE_BINDING_CONTRACT = 'research-acceptance-binding/v1' as const;
export type ManagedResearchTurn = ResearchTurn & { contract: 'research-consumer-turn/v1'; consumerIntent: Ref;
  acceptanceContract?: typeof ACCEPTANCE_BINDING_CONTRACT;
  acceptance?: AcceptedAnswerChain;
  /** D8.4e: the exact K the completed turn was derived from (new era only). */
  acceptanceBinding?: Ref;
  /** DR3a3-K: the attempt era of O@1 — fixed by the producer together with the
   * subject, immutable across revisions like the paid action. */
  attemptContract?: typeof ATTEMPT_BINDING_CONTRACT;
  subject?: V7PlanSubject;
  /** DR3a3-K: the recorded attempt and its binding, on the completed turn only. */
  attempt?: Ref;
  attemptBinding?: Ref };
/** The era of a managed turn, read from its own immutable producer field —
 * never from the presence of K, a completed acceptance chain or a scan. */
export function acceptanceEraOf(turn: { acceptanceContract?: unknown }): 'binding' | 'legacy' {
  return turn.acceptanceContract === ACCEPTANCE_BINDING_CONTRACT ? 'binding' : 'legacy';
}
/** DR3a3-K: the attempt era of a managed turn — its own immutable producer
 * field. A turn of this era answers a plan-question, never a field question. */
export function attemptEraOf(turn: { attemptContract?: unknown }): 'attempt' | 'answer' {
  return turn.attemptContract === ATTEMPT_BINDING_CONTRACT ? 'attempt' : 'answer';
}
/** D8.4e: K — the acceptance record written atomically with the draft, the
 * research-answer and the answered question. It names the exact original
 * turn (O@1), the pending revision actually consumed (P), the producing
 * intent (I), the adjacent draft/question pair, the answer, the supported
 * assessment (R) and its managed proof (B). K never references the completed
 * turn T; T references K. */
export interface ResearchAcceptanceBinding {
  contract: typeof ACCEPTANCE_BINDING_CONTRACT; projectId: string;
  turn: Ref; pending: Ref; intent: Ref;
  draftBefore: Ref; draftAfter: Ref; questionBefore: Ref; questionAfter: Ref;
  answer: Ref; assessment: Ref; assessmentProof: Ref;
}
export const ACCEPTANCE_BINDING_FIELDS = ['contract', 'projectId', 'turn', 'pending', 'intent',
  'draftBefore', 'draftAfter', 'questionBefore', 'questionAfter', 'answer', 'assessment', 'assessmentProof'] as const;
export const acceptanceBindingId = (projectId: string, turnId: string) =>
  `research-acceptance-binding:v1:${hashJson({ projectId, turnId })}`;
/** D8.4.2 (№2230-1): the address of a NEW managed research answer names its exact paid turn — the
 * only lawful way a consumer without a saved turn learns provenance from the record itself. */
export const managedAnswerId = (projectId: string, turnId: string) =>
  `research-answer:${projectId}:managed-v1:${encodeURIComponent(turnId)}`;
/** D8.4.2 (№2276-4): recognition of a research-answer address against the known project. A legacy
 * address of this project (any tail that is not a managed- form) returns null — the previous era by
 * its producer's saved form. A managed- form is parsed strictly: another project, an unknown
 * version, a missing or non-managed turn, a broken or non-canonical encoding — each is an
 * addressed typed refusal with its reason, never a downgrade to the previous era and never an
 * untyped exception. An address outside this project's prefix is refused as well. */
export function managedAnswerTurn(id: string, projectId: string): string | null {
  const refuse = (reason: string): never => {
    throw new EngineError('research_acceptance_binding_invalid',
      `[${id}] The research answer address is not this project's exact address: ${reason}`, { ref: { id }, reason });
  };
  if (typeof id !== 'string' || !id.startsWith('research-answer:')) refuse('address-form');
  const rest = id.slice('research-answer:'.length);
  const sep = rest.indexOf(':managed-');
  if (sep === -1) {
    if (!rest.startsWith(`${projectId}:`) || rest.length === `${projectId}:`.length) refuse('address-project');
    return null;
  }
  if (rest.slice(0, sep) !== projectId) refuse('address-project');
  const tail = rest.slice(sep + ':managed-'.length);
  const versionEnd = tail.indexOf(':');
  if (versionEnd === -1 || tail.slice(0, versionEnd) !== 'v1') refuse('address-version');
  const encoded = tail.slice(versionEnd + 1);
  if (!encoded) refuse('address-turn');
  let turnId: string;
  try { turnId = decodeURIComponent(encoded); } catch { return refuse('address-encoding'); }
  if (encodeURIComponent(turnId) !== encoded) refuse('address-encoding');
  if (!turnId.startsWith('research-turn:v1:') || turnId.length <= 'research-turn:v1:'.length) refuse('address-turn');
  return turnId;
}
/** Payload-level failures of a saved paid action/escalation response that
 * terminate as a typed `consumer-invalid` outcome instead of a fabricated
 * action or a transport refusal (C13/C62). Context-level failures that occur
 * after the turn was written keep completing that turn with their typed error. */
export const ACTION_RESPONSE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'research_result_capacity', 'research_response_invalid', 'research_checkpoint_empty', 'escalation_assessment_invalid']);

export const managedTurnId = (run: string, number: number) =>
  `research-turn:v1:${hashJson([run, number])}`;
const exactRef = (record: Revision<unknown>): Ref => ({ id: record.id,
  revision: record.revision, hash: record.hash });

export interface ContextTurnHistoryProof {
  turn: Revision<ResearchTurn>;
  /** Required for a completed, successful read_context in this run. */
  context?: Omit<ContextReadIdentityInput, 'action' | 'observation' | 'question'>;
  /** Exact paid subject of a new delivery-era turn, when it carried pages. */
  packet?: Record<string, any>;
}

/** Rebuild the addressed workspace from complete exact turn history. Current
 * Source heads and today's file contents are not historical inputs. */
export function projectAddressedWorkspace(before: ManagedResearchTurn,
  history: ContextTurnHistoryProof[], question: Ref): ContextWorkspace {
  requireCondition(before.status === 'pending' && isRef(question)
    && canonical(before.question) === canonical(question)
    && Number.isSafeInteger(before.number) && before.number > 0
    && Array.isArray(history) && history.length === before.number - 1,
  'research_consumer_intent_invalid',
  'An addressed workspace needs the complete original run history');
  let workspace: ContextWorkspace = { entries: [], sinceProgress: 0 };
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]!, turn = entry.turn;
    requireCondition(turn.kind === 'research-turn' && hashJson(turn.value) === turn.hash
      && turn.value.run === before.run && turn.value.number === index + 1,
    'research_consumer_intent_invalid',
    'An addressed workspace omitted or substituted an earlier run turn');
    const prior = turn.value;
    if (!isRef(prior.question) || canonical(prior.question) !== canonical(question)
      || prior.status !== 'completed' || prior.error) continue;
    if (entry.packet?.working?.deliveryContract === 'research-delivery/v1')
      workspace = recordContextPacket(workspace, entry.packet);
    const kind = (prior.action as { action?: unknown } | null)?.action;
    if (kind !== 'read_context') { workspace = foldContextEvent(workspace, String(kind)); continue; }
    if (canonical(prior.question) !== canonical(question)) continue;
    requireCondition(entry.context,
      'research_consumer_intent_invalid',
      'An earlier addressed read lost its exact checked original');
    const action = turnAction(prior);
    requireCondition(action.action === 'read_context',
      'research_consumer_intent_invalid', 'The original addressed action is invalid');
    const result = prior.observation as ProjectedContextRead;
    contextReadIdentity({ ...entry.context, action, observation: result, question });
    workspace = foldContextEvent(workspace, kind, result);
  }
  return workspace;
}

/** Return null only when a complete, checked run history contains no earlier
 * delivery of this addressed original. Malformed history is never absence. */
export function projectRepeatedContextRead(before: ManagedResearchTurn,
  current: ContextReadIdentityInput,
  history: ContextTurnHistoryProof[]): { previous: Ref; history: Ref[] } | null {
  const action = turnAction(before);
  requireCondition(action.action === 'read_context' && isRef(before.question)
    && canonical(action) === canonical(current.action)
    && canonical(before.question) === canonical(current.question)
    && Number.isSafeInteger(before.number) && before.number > 0
    && Array.isArray(history) && history.length === before.number - 1,
  'research_consumer_intent_invalid',
  'A repeated context page needs its complete original turn history');
  const key = contextReadIdentity(current);
  for (let index = 0; index < history.length; index += 1) {
    const prior = history[index]!.turn;
    requireCondition(prior.kind === 'research-turn' && hashJson(prior.value) === prior.hash
      && prior.value.run === before.run && prior.value.number === index + 1,
    'research_consumer_intent_invalid', 'The repeat omitted or substituted a prior run turn');
  }
  let previous: Ref | null = null;
  for (const entry of [...history].reverse()) {
    const prior = entry.turn.value;
    if (prior.question?.id !== before.question.id) continue;
    const priorAction = turnAction(prior);
    if (priorAction.action === 'checkpoint' || priorAction.action === 'answer'
      || priorAction.action === 'answer_delta') break;
    if (prior.error || prior.status !== 'completed' || priorAction.action !== 'read_context') continue;
    requireCondition(entry.context,
      'research_consumer_intent_invalid', 'A prior completed context read lost its checked original');
    const priorKey = contextReadIdentity({ ...entry.context, action: priorAction,
      observation: prior.observation as ProjectedContextRead,
      question: before.question });
    if (key === priorKey) { previous = exactRef(entry.turn); break; }
  }
  return previous ? { previous, history: history.map(entry => exactRef(entry.turn)) } : null;
}

export interface ResearchSearchProcess {
  stdout: string | null; status: number | null; signal: string | null;
  error: { name: string; message: string; code: string | null } | null;
}
export interface ResearchSearchObservation {
  sources: { source: Ref; offset: number; excerpt: string }[];
  repositoryMatches: string;
  repositoryStatus: 'matches' | 'no_matches' | 'unavailable_or_truncated';
}
export interface ResearchSearchCaptureInput {
  projectId: string; turn: Revision<ResearchTurn>; store: Store;
  /** Required when a read_plan child inherits its paid action from a parent. */
  parent?: { original: Revision<ResearchTurn>; queued: Revision<ResearchTurn> };
  query: string; workspace: string;
  sources: { ref: Ref; value: Source }[];
  process: ResearchSearchProcess;
  searchContract?: 'research-search-capture/v1' | typeof STRUCTURED_SEARCH_CONTRACT;
}
export interface ResearchSearchCaptureValue {
  contract: 'research-search-capture/v1' | typeof STRUCTURED_SEARCH_CONTRACT; projectId: string;
  turn: Ref; run: string; question: Ref | null; consumerIntent: Ref;
  plannedBy: Ref | null; query: string; workspace: string;
  sources: Ref[]; process: ResearchSearchProcess;
  observation: ResearchSearchObservation | StructuredResearchSearchObservation;
}

export interface StructuredResearchSearchObservation {
  contract: typeof STRUCTURED_SEARCH_CONTRACT;
  sources: ({ source: Ref; offset: number; excerpt: string; selector?: { kind: 'text-range'; start: number; end: number };
    sectionPath?: StructuredFragment['sectionPath']; heading?: StructuredFragment['heading']; sentenceSplit?: boolean })[];
  repositoryMatches: string; repositoryStatus: ResearchSearchObservation['repositoryStatus'];
  found: number; delivered: number; truncated: boolean; hasMore: boolean; displayedChars: number;
}

/** New mixed search counts every displayed Source and repository character in one envelope. */
export function projectResearchSearchObservationV2(query: string,
  sources: readonly { ref: Ref; value: Source }[], process: ResearchSearchProcess): StructuredResearchSearchObservation {
  requireSearchQuery(query);
  const old = projectResearchSearchObservation(query, sources, process);
  const delivered: StructuredResearchSearchObservation['sources'] = [];
  let found = 0, displayedChars = 0, clipped = false;
  const sorted = [...sources].sort((left, right) => canonical(left.ref).localeCompare(canonical(right.ref)));
  for (const source of sorted) {
    const slots = SEARCH_FRAGMENT_LIMIT - delivered.length, room = SEARCH_TEXT_LIMIT - displayedChars;
    if (sourceReadContract(source.value, source.ref) === SOURCE_READ_CONTRACT_V3) {
      const result = searchStructuredSource(source.value.content, source.value.structure!, query, slots, room);
      found += result.found; displayedChars += result.displayedChars; clipped ||= result.truncated;
      for (const fragment of result.fragments) delivered.push({ source: source.ref, offset: fragment.matchOffsets[0]!, excerpt: fragment.text,
        ...(fragment.range.end > fragment.range.start ? { selector: { kind: 'text-range' as const, ...fragment.range } } : {}),
        sectionPath: fragment.sectionPath, heading: fragment.heading, sentenceSplit: fragment.sentenceSplit });
    } else {
      const legacy = old.sources.find(row => canonical(row.source) === canonical(source.ref));
      if (!legacy) continue;
      found++;
      const end = safeTextEnd(legacy.excerpt, Math.min(legacy.excerpt.length, room));
      if (slots <= 0 || end <= 0) { clipped = true; continue; }
      delivered.push({ ...legacy, excerpt: legacy.excerpt.slice(0, end) }); displayedChars += end;
      clipped ||= end < legacy.excerpt.length;
    }
  }
  const repositoryText = process.stdout ?? '';
  const repositoryMatches = repositoryText.slice(0,
    safeTextEnd(repositoryText, Math.min(repositoryText.length, SEARCH_TEXT_LIMIT - displayedChars)));
  displayedChars += repositoryMatches.length;
  const truncated = clipped || repositoryMatches.length < repositoryText.length || old.repositoryStatus === 'unavailable_or_truncated';
  return { contract: STRUCTURED_SEARCH_CONTRACT, sources: delivered, repositoryMatches,
    repositoryStatus: old.repositoryStatus, found, delivered: delivered.length,
    truncated, hasMore: truncated, displayedChars };
}

/** Shared query admission for the ordinary search and managed capture. */
export function requireSearchQuery(query: unknown): asserts query is string {
  requireCondition(typeof query === 'string' && query.trim().length > 0 && query.length <= 1000,
    'research_query_invalid', 'Use a nonempty bounded search query');
}

export function projectResearchSearchObservation(query: string,
  sources: readonly { ref: Ref; value: Source }[], process: ResearchSearchProcess): ResearchSearchObservation {
  requireSearchQuery(query);
  requireCondition(Array.isArray(sources) && sources.every(source => isRef(source.ref)
      && typeof source.value.content === 'string'
      && digest(source.value.content) === source.value.sha256
      && hashJson(source.value) === source.ref.hash)
    && process && (typeof process.stdout === 'string' || process.stdout === null)
    && (Number.isSafeInteger(process.status) || process.status === null)
    && (typeof process.signal === 'string' || process.signal === null)
    && (process.error === null || process.error && typeof process.error.name === 'string'
      && typeof process.error.message === 'string'
      && (typeof process.error.code === 'string' || process.error.code === null)),
  'research_search_capture_invalid', 'The search lost its exact query, Source bytes or process result');
  return { sources: sources.flatMap(source => {
      const offset = source.value.content.toLowerCase().indexOf(query.toLowerCase());
      return offset < 0 ? [] : [{ source: source.ref, offset,
        excerpt: source.value.content.slice(Math.max(0, offset - 200), offset + 1200) }];
    }),
    repositoryMatches: (process.stdout ?? '').slice(0, 20_000),
    repositoryStatus: process.status === 0 ? 'matches' : process.status === 1
      ? 'no_matches' : 'unavailable_or_truncated' };
}

/** One search projection for the original producer and exact historical read.
 * Repository matches remain a navigation hint, never accepted Source evidence. */
export function projectResearchSearchCapture(input: ResearchSearchCaptureInput):
  { id: string; ref: Ref; value: ResearchSearchCaptureValue } {
  const { projectId, turn, parent, query, workspace, sources, process } = input;
  requireSearchQuery(query);
  const action = turnAction(turn.value);
  requireCondition(turn.kind === 'research-turn' && hashJson(turn.value) === turn.hash
    && turn.value.status === 'pending' && action.action === 'search'
    && action.query === query && typeof projectId === 'string' && projectId.length > 0
    && typeof workspace === 'string' && workspace.length > 0
    && Array.isArray(sources) && sources.every(source => isRef(source.ref)
      && source.ref.id.startsWith(`source:${projectId}:`)
      && source.value.projectId === projectId && typeof source.value.content === 'string'
      && digest(source.value.content) === source.value.sha256
      && hashJson(source.value) === source.ref.hash)
    && new Set(sources.map(source => source.ref.id)).size === sources.length,
  'research_search_capture_invalid', 'The search capture lost exact action, sources or process facts');
  let consumerIntent: Ref;
  let plannedBy: Ref | null = null;
  if (isRef(turn.value.plannedBy)) {
    const parentRef = turn.value.plannedBy;
    const original = parent?.original, queued = parent?.queued;
    const parentAction = original ? turnAction(original.value) : null;
    const rawChildren = queued?.value.observation && typeof queued.value.observation === 'object'
      ? (queued.value.observation as { children?: unknown }).children : null;
    const children: unknown[] | null = Array.isArray(rawChildren) ? rawChildren : null;
    const index = children ? children.findIndex(child =>
      queuedChildReached(input.store, child, turn)) : -1;
    const parentIntent = (original?.value as ManagedResearchTurn | undefined)?.consumerIntent;
    requireCondition(original && queued && canonical(exactRef(original)) === canonical(parentRef)
      && original.kind === 'research-turn' && hashJson(original.value) === original.hash
      && original.value.status === 'pending' && parentAction?.action === 'read_plan'
      && queued.kind === 'research-turn' && queued.id === original.id
      && queued.revision === original.revision + 1 && hashJson(queued.value) === queued.hash
      && queued.value.status === 'completed'
      && canonical(queued.value.action) === canonical(original.value.action)
      && canonical(queued.value.question) === canonical(original.value.question)
      && queued.value.run === original.value.run
      && original.value.run === turn.value.run
      && index >= 0 && parentAction.reads.length === children!.length
      && turn.id === `research-turn:${hashJson([original.id, 'read', index])}`
      && turn.value.number === original.value.number + index + 1
      && canonical(turn.value.question) === canonical(original.value.question)
      && canonical(action) === canonical(parentAction.reads[index])
      && (original.value as ManagedResearchTurn).contract === 'research-consumer-turn/v1'
      && isRef(parentIntent),
    'research_search_capture_invalid', 'The planned search is not an exact child of its paid queue');
    consumerIntent = parentIntent;
    plannedBy = parentRef;
  } else {
    const managed = turn.value as ManagedResearchTurn;
    requireCondition(!parent && managed.contract === 'research-consumer-turn/v1'
      && isRef(managed.consumerIntent),
    'research_search_capture_invalid', 'The search has no paid consumer origin');
    consumerIntent = managed.consumerIntent;
  }
  const contract = input.searchContract ?? 'research-search-capture/v1';
  requireCondition(contract === 'research-search-capture/v1' || contract === STRUCTURED_SEARCH_CONTRACT,
    'research_search_capture_invalid', 'Unknown saved search projection');
  const observation = contract === STRUCTURED_SEARCH_CONTRACT
    ? projectResearchSearchObservationV2(query, sources, process)
    : projectResearchSearchObservation(query, sources, process);
  const value: ResearchSearchCaptureValue = { contract,
    projectId, turn: exactRef(turn), run: turn.value.run, question: turn.value.question,
    consumerIntent, plannedBy, query, workspace,
    sources: sources.map(source => source.ref), process, observation };
  const hash = hashJson(value), id = `research-search-capture:${contract === STRUCTURED_SEARCH_CONTRACT ? 'v2' : 'v1'}:${hash}`;
  return { id, ref: { id, revision: 1, hash }, value };
}

/** A search completion always points at the exact immutable capture. The
 * planned child has no managed marker of its own, but inherits the checked
 * parent queue's paid intent in the capture projection above. */
export function projectSearchTurnCompletion(input: ResearchSearchCaptureInput):
  { turn: ResearchTurn; capture: ReturnType<typeof projectResearchSearchCapture> } {
  const capture = projectResearchSearchCapture(input);
  return { capture, turn: { ...input.turn.value, status: 'completed',
    assessment: null, error: null,
    observation: { ...capture.value.observation, capture: capture.ref } } };
}

const correctableLayerDesignCodes = new Set([
  'answer_invalid', 'graph_invalid', 'layer_design_missing', 'layer_design_invalid',
  'derived_field_conflict', 'layer_delta_required',
  'layer_delta_ambiguous', 'layer_delta_missing', 'layer_connector_ref_invalid',
  'layer_counterfactual_ref_invalid', 'layer_requirement_invalid',
  'layer_join_inputs_invalid', 'layer_join_design_required', 'layer_detail_invalid',
  'horizon_empty', 'upper_layer_drift', 'layer_outcome_uncovered',
  'layer_connector_uncovered', 'layer_port_unbound', 'task_obligation_bindings_invalid'
]);
export function isCorrectableLayerDesignFailure(error: EngineError): boolean {
  return correctableLayerDesignCodes.has(error.code);
}
export interface LayerDesignRefusalProof {
  kind: 'layer-design-refusal'; projectId: string;
  draft: Revision<DiscoveryDraft>; question: Revision<Question>; graph: Revision<Graph>;
  failure: { code: string; message: string; details: unknown };
}
export type PaidLocalRefusalKind = 'mode-refusal' | 'reading-plan-refusal'
  | 'reading-mode-refusal' | 'search-query-refusal';
type PaidLocalRefusalReason = { kind: PaidLocalRefusalKind; code: string; message: string };

/** The order matches the paid consumer's local admission: dispatch mode is
 * checked before a plan, mode transition or search can run. A failure outside
 * this finite set stays pending instead of acquiring an invented completion. */
function paidLocalRefusalReason(before: ManagedResearchTurn,
  action: ResearchAction, unknown: boolean): PaidLocalRefusalReason | null {
  const mode = before.dispatchMode;
  // DR3a3-K: the turn's logical question (plan-question id of an attempt subject).
  const questionId = turnQuestionId(before);
  // UNK1: in the unknown era an early need_research on the current question is the unknown door, not a mode transition.
  if (unknown && action.action === 'need_research' && questionId !== null && action.question === questionId) return null;
  if (!before.plannedBy && (mode === 'planning' || mode === 'synthesis')) {
    const allowed = mode === 'planning'
      ? ['read_plan', 'synthesize', 'pause']
      : ['answer', 'answer_delta', 'checkpoint', 'read_context', 'need_research', 'need_owner', 'pause'];
    if (!allowed.includes(action.action)) return { kind: 'mode-refusal',
      code: 'research_mode_invalid',
      message: 'Planning only selects reads; synthesis answers or identifies explicit missing information' };
  }
  if (action.action === 'read_plan' && mode === 'planning'
    && (questionId === null || action.question !== questionId
      || new Set(action.reads.map(canonical)).size !== action.reads.length))
    return { kind: 'reading-plan-refusal', code: 'reading_plan_invalid',
      message: 'Reading plan must target this question without duplicate requests' };
  if ((action.action === 'synthesize' || action.action === 'need_research')
    && (mode !== 'planning' && mode !== 'synthesis'
      || questionId === null || action.question !== questionId))
    return { kind: 'reading-mode-refusal', code: 'research_question_foreign',
      message: 'Mode transition must target the current question' };
  if (action.action === 'search'
    && (action.query.trim().length === 0 || action.query.length > 1000))
    return { kind: 'search-query-refusal', code: 'research_query_invalid',
      message: 'Use a nonempty bounded search query' };
  return null;
}

export function projectPaidLocalRefusal(before: ManagedResearchTurn, unknown = false): {
  proof: { kind: PaidLocalRefusalKind }; turn: ManagedResearchTurn; failure: EngineError;
} | null {
  const reason = paidLocalRefusalReason(before, turnAction(before), unknown);
  if (!reason) return null;
  const proof = { kind: reason.kind, ...(unknown ? { unknown: true as const } : {}) };
  return { proof, turn: projectResearchTurnRevision(before, proof),
    failure: new EngineError(reason.code, reason.message) };
}

export interface PaidTurnAdmission {
  runId: string; intent: Ref; response: unknown; question: Ref | null;
  owner: ResearchRun['owner']; limit: number; context: unknown;
  mode?: 'planning' | 'synthesis';
  /** WB1: the capability of the producing call, from its saved dispatch (webResearchCapability). */
  web?: boolean;
  /** UNK1: the early-actions era of the producing intent, from its saved cursor (earlyUnknownEra). */
  unknown?: boolean;
  /** DR3a3-K: the attempt subject of the producing intent, from its saved cursor (planSubjectOf). */
  subject?: V7PlanSubject;
}

export interface AcceptedPaidAnswerInputs {
  projectId: string;
  draftBefore: Revision<DiscoveryDraft>; draftAfter: Revision<DiscoveryDraft>;
  questionBefore: Revision<Question>; questionAfter: Revision<Question>;
  answer: Revision<ResearchAnswer>; assessment: Revision<ResearchAssessment>;
  action: unknown;
  /** Required only for answer_delta; derived with the checked original graph. */
  expandedProposal?: unknown;
}

/** The exact historical acceptance pair is independent of today's draft HEAD.
 * Callers load adjacent revisions from the acceptance's own sources, and may
 * separately check current admission before starting subsequent work. */
export function matchAcceptedPaidAnswer(input: AcceptedPaidAnswerInputs):
  { assessment: Ref; observation: { verdict: 'supported'; reasons: string[] } } | null {
  const { projectId, draftBefore, draftAfter, questionBefore, questionAfter, answer, assessment } = input;
  const action = admittedResearchAction(input.action);
  if (action.action !== 'answer' && action.action !== 'answer_delta') return null;
  const field = questionBefore.value.spec.field;
  const proposal = action.action === 'answer' ? action.value : input.expandedProposal;
  if (proposal === undefined || draftBefore.kind !== 'discovery-draft' || draftAfter.kind !== 'discovery-draft'
    || questionBefore.kind !== 'question' || questionAfter.kind !== 'question'
    || answer.kind !== 'research-answer' || assessment.kind !== 'research-assessment'
    || draftAfter.id !== draftBefore.id || draftAfter.revision !== draftBefore.revision + 1
    || questionAfter.id !== questionBefore.id || questionAfter.revision !== questionBefore.revision + 1
    || draftBefore.value.projectId !== projectId || draftAfter.value.projectId !== projectId
    || questionBefore.value.projectId !== projectId || questionAfter.value.projectId !== projectId
    || questionBefore.value.draftId !== draftBefore.id || questionAfter.value.draftId !== draftBefore.id
    || !draftBefore.value.questions.includes(questionBefore.id)
    || canonical({ ...questionBefore.value, status: 'answered', answer: exactRef(answer) })
      !== canonical(questionAfter.value)
    || questionBefore.value.status === 'answered' || questionBefore.value.answer !== null
    || answer.value.projectId !== projectId || answer.value.question !== questionBefore.id
    || canonical(questionAfter.value.answer) !== canonical(exactRef(answer))
    || canonical(answer.value.assessment) !== canonical(exactRef(assessment))
    || canonical(answer.value.value) !== canonical(assessment.value.value)
    || assessment.value.projectId !== projectId || assessment.value.verdict !== 'supported'
    || assessment.value.researcher === assessment.value.assessor
    || !Array.isArray(assessment.value.observations) || assessment.value.observations.length === 0
    || !Array.isArray(assessment.value.reasons)
    || canonical(assessment.value.question) !== canonical(exactRef(questionBefore))
    || !Object.hasOwn(draftBefore.value.fields, field)
    || hashJson(draftBefore.value.fields[field]) !== questionBefore.value.beforeHash
    || canonical(draftAfter.value) !== canonical({ ...draftBefore.value,
      fields: { ...draftBefore.value.fields, [field]: answer.value.value } })
    || canonical(action.citations) !== canonical(assessment.value.observations.map(item =>
      ({ source: item.source, selector: item.selector })))
    || canonical(proposal) !== canonical(assessment.value.value)) return null;
  return { assessment: exactRef(assessment),
    observation: { verdict: 'supported', reasons: assessment.value.reasons } };
}

/** D8.4e: the one projection of K shared by the producer (Discovery.#answer,
 * on the prepared writes) and the historical reader (on the loaded exact
 * records). It composes the shared acceptance formula with the full-value
 * checks of R13: the research-answer body is exactly {projectId, question,
 * assessment, value} at revision 1 under its own address, the assessment is
 * the content-addressed revision 1, and the adjacent pair is the acceptance's
 * own. Belonging of O/P/I/B (R12) is the caller's proof; here their links are
 * checked for form and mutual consistency. */
export function projectAcceptanceBinding(inputs: AcceptedPaidAnswerInputs,
  links: { turn: Ref; pending: Ref; intent: Ref; assessmentProof: Ref }): ResearchAcceptanceBinding {
  const refuse = (reason: string): never => {
    throw new EngineError('research_acceptance_binding_invalid',
      `[${links.turn?.id ?? 'research-turn'}] The acceptance record does not derive from its exact sources: ${reason}`,
      { ref: links.turn ?? null, reason });
  };
  if (!isRef(links.turn) || !isRef(links.pending) || !isRef(links.intent) || !isRef(links.assessmentProof))
    refuse('links');
  if (links.turn.revision !== 1 || links.pending.id !== links.turn.id || links.pending.revision < 1
    || links.intent.revision !== 1) refuse('turn-links');
  const { projectId, answer, assessment, draftAfter, questionAfter } = inputs;
  if (!matchAcceptedPaidAnswer(inputs)) refuse('acceptance-formula');
  if (answer.revision !== 1 || !answer.id.startsWith(`research-answer:${projectId}:`)
    || hashJson(answer.value) !== answer.hash
    || Object.keys(answer.value).sort().join(',') !== 'assessment,projectId,question,value') refuse('answer-form');
  // D8.4.2 (№2276-1): the era of the answer is its producer's saved address. The managed address
  // is required of the new producer only: a managed- form must name THIS turn. A K of the accepted
  // D8.4e producer with a UUID answer keeps the previous full contract — no migration, no bypass.
  let managedTurn: string | null;
  try { managedTurn = managedAnswerTurn(answer.id, projectId); }
  catch (error) { return refuse(error instanceof EngineError && typeof (error.details as { reason?: unknown })?.reason === 'string'
    ? (error.details as { reason: string }).reason : 'answer-address'); }
  if (managedTurn !== null && answer.id !== managedAnswerId(projectId, links.turn.id)) refuse('answer-address');
  if (assessment.revision !== 1 || assessment.id !== `research-assessment:${hashJson(assessment.value)}`
    || assessment.hash !== hashJson(assessment.value)) refuse('assessment-form');
  if (hashJson(draftAfter.value) !== draftAfter.hash || hashJson(questionAfter.value) !== questionAfter.hash
    || hashJson(inputs.draftBefore.value) !== inputs.draftBefore.hash
    || hashJson(inputs.questionBefore.value) !== inputs.questionBefore.hash) refuse('pair-form');
  return { contract: ACCEPTANCE_BINDING_CONTRACT, projectId,
    turn: links.turn, pending: links.pending, intent: links.intent,
    draftBefore: exactRef(inputs.draftBefore), draftAfter: exactRef(draftAfter),
    questionBefore: exactRef(inputs.questionBefore), questionAfter: exactRef(questionAfter),
    answer: exactRef(answer), assessment: exactRef(assessment), assessmentProof: links.assessmentProof };
}

/** Analyst/planner application writes this run and pending turn together. The
 * number and request charge derive from the exact prior run and saved context. */
export function projectPaidTurnAdmission(before: ResearchRun, input: PaidTurnAdmission):
  { run: ResearchRun; turn: ManagedResearchTurn } {
  requireCondition(typeof input.runId === 'string' && input.runId && Number.isSafeInteger(before.turns)
    && before.turns >= 0 && Number.isSafeInteger(before.requestChars) && before.requestChars >= 0
    && Number.isSafeInteger(input.limit) && input.limit > 0 && input.intent.revision === 1,
  'research_consumer_intent_invalid', 'A paid turn needs its exact prior run and original intent');
  // DR3a3-K: a paid answer of an attempt subject states exactly one attempt
  // end of its plan-question; anything else is a typed payload refusal before
  // any turn exists (no attempt, no second payment).
  const action = responseAction(input.response, input.web === true, input.unknown === true, input.subject ?? null);
  const next = before.turns + 1;
  const run: ResearchRun = { ...before, status: 'running', turns: next,
    limit: input.limit, owner: input.owner,
    requestChars: before.requestChars + canonical(input.context).length,
    error: null, pauseCode: null };
  const turn: ManagedResearchTurn = { contract: 'research-consumer-turn/v1',
    consumerIntent: input.intent, acceptanceContract: ACCEPTANCE_BINDING_CONTRACT,
    run: input.runId, number: next,
    action, assessment: null, observation: null, error: null,
    status: 'pending', question: input.question,
    ...(input.mode ? { dispatchMode: input.mode } : {}),
    ...(input.subject ? { attemptContract: ATTEMPT_BINDING_CONTRACT, subject: input.subject } : {}) };
  return { run, turn };
}

/** D8.4e: the synthesis handoff's original turn — the second producer of O.
 * The same immutable fields and the same acceptance era marker as the runner
 * application; the caller supplies only the exact handoff sources. */
export function projectSynthesisHandoffTurn(input: { intent: Ref; runId: string; number: number;
  action: unknown; question: Ref | null; subject?: V7PlanSubject }): ManagedResearchTurn {
  requireCondition(isRef(input.intent) && input.intent.revision === 1 && typeof input.runId === 'string'
    && !!input.runId && Number.isSafeInteger(input.number) && input.number > 0,
  'research_consumer_intent_invalid', 'A synthesis handoff needs its original intent and exact turn position');
  // DR3a3-K: the same immutable subject as the runner application (O@1 of
  // either producer); a handoff answer of a subject is an attempt end.
  if (input.subject && typeof input.action === 'object' && input.action !== null
    && ['answer', 'answer_delta'].includes((input.action as { action?: unknown }).action as string))
    attemptEndOfAction(input.action, input.subject);
  return { contract: 'research-consumer-turn/v1', consumerIntent: input.intent,
    acceptanceContract: ACCEPTANCE_BINDING_CONTRACT, run: input.runId, number: input.number,
    action: input.action, assessment: null, observation: null, error: null,
    status: 'pending', question: input.question, dispatchMode: 'synthesis',
    ...(input.subject ? { attemptContract: ATTEMPT_BINDING_CONTRACT, subject: input.subject } : {}) };
}

/** The once-only delivery extension of a proved paid synthesis application.
 * Re-preparation may add prepared revisions before the one physical claim;
 * delivery follows its first applied revision, never an already extended one. */
export function projectSynthesisHandoffIntent(applied: Revision<ResearchConsumerIntent>,
  prior: Revision<ResearchConsumerIntent>, turn: Ref): ResearchConsumerIntent {
  const value = applied?.value, before = prior?.value, delivery = value?.cursor?.delivery;
  requireCondition(applied?.kind === 'research-consumer-intent' && prior?.kind === applied.kind
    && applied.id === prior.id && applied.revision === prior.revision + 1
    && ['synthesis', 'consolidation'].includes(value?.kind)
    && value.state === 'applied' && before?.state === 'running' && before.outputs === null
    && Array.isArray(value.outputs) && value.outputs.length > 0
    && isRef(value.call) && value.call.revision === 1
    && canonical({ ...value, state: before.state, outputs: before.outputs }) === canonical(before)
    && typeof delivery === 'object' && delivery !== null && typeof delivery.run === 'string'
    && Number.isSafeInteger(delivery.turn) && delivery.turn > 0
    && isRef(turn) && turn.revision === 1 && turn.id === managedTurnId(delivery.run, delivery.turn)
    && value.outputs.every(output => output.id !== turn.id),
    'research_consumer_intent_invalid', 'Only the first paid synthesis application may append its exact reserved turn');
  return { ...value, outputs: [...value.outputs!, turn] };
}

/** DR3a3-K: the exact records one recorded attempt turn derives from. */
export interface AttemptTurnInputs {
  projectId: string;
  /** P — the pending revision the completion consumes. */
  pending: Revision<ManagedResearchTurn>;
  /** I@1 — the producing intent's first revision; its cursor names the subject. */
  intent: Revision<ResearchConsumerIntent>;
  /** The paid call of that intent — the call its application revision names. */
  call: Ref;
  /** The attempt the DR3a2 door recorded, proven by the caller (proveAttempt). */
  attempt: Revision<V7Attempt>;
}

/** DR3a3-K: the formula of an attempt turn. It ties the exact paid payload of
 * P, the producing intent and its paid call, the subject and the end of the
 * proven attempt: the end must DERIVE from the saved payload by the one
 * mapping (attemptEndOfAction) — matching call, plan or id alone is not enough.
 * null when the records do not satisfy it. */
export function matchAttemptPaidTurn(input: AttemptTurnInputs): { end: Json } | null {
  const { projectId, pending, intent, call, attempt } = input;
  if (!pending || pending.kind !== 'research-turn' || !intent || intent.kind !== 'research-consumer-intent'
    || !attempt || attempt.kind !== 'research-attempt' || !isRef(call)
    || intent.revision !== 1 || intent.value.projectId !== projectId
    || pending.value.contract !== 'research-consumer-turn/v1' || pending.value.status !== 'pending'
    || attemptEraOf(pending.value) !== 'attempt'
    || canonical(pending.value.consumerIntent) !== canonical(exactRef(intent))) return null;
  let subject: V7PlanSubject | null, turnSubject: V7PlanSubject | null, end: unknown;
  try {
    subject = planSubjectOf(intent.value.cursor);
    turnSubject = planSubjectOf({ subject: pending.value.subject });
    end = subject ? attemptEndOfAction(pending.value.action, subject) : null;
  } catch (error) {
    if (error instanceof EngineError) return null;
    throw error;
  }
  if (!subject || !sameSubject(subject, turnSubject) || end === null) return null;
  const value = attempt.value as unknown as Record<string, unknown>;
  if (value === null || typeof value !== 'object' || value['project'] !== projectId
    || !isRef(value['planAnswer']) || canonical(value['planAnswer']) !== canonical(subject.planAnswer)
    || value['planQuestionId'] !== subject.planQuestionId
    || !isRef(value['call']) || canonical(value['call']) !== canonical(call)
    || !isRef(value['draft']) || (value['draft'] as Ref).id !== intent.value.draft.id
    || canonical(value['end'] as Json) !== canonical(end as Json)) return null;
  return { end: end as Json };
}

/** DR3a3-K: the one projection of the attempt binding shared by the producer
 * (on prepared records) and the historical reader (on loaded exact records).
 * Belonging of O/P/I and the proof of the attempt are the caller's; here the
 * formula, the exact forms and the links are checked. */
export function projectAttemptBinding(inputs: AttemptTurnInputs, links: { turn: Ref }): ResearchAttemptBinding {
  const refuse = (reason: string): never => {
    throw new EngineError('research_attempt_binding_invalid',
      `[${links?.turn?.id ?? 'research-turn'}] The attempt record does not derive from its exact sources: ${reason}`,
      { ref: links?.turn ?? null, reason });
  };
  if (!links || !isRef(links.turn) || links.turn.revision !== 1 || !inputs?.pending
    || links.turn.id !== inputs.pending.id) refuse('links');
  if (hashJson(inputs.pending.value) !== inputs.pending.hash) refuse('pending-form');
  if (inputs.attempt?.revision !== 1 || hashJson(inputs.attempt.value) !== inputs.attempt.hash) refuse('attempt-form');
  if (!matchAttemptPaidTurn(inputs)) refuse('attempt-formula');
  const subject = planSubjectOf(inputs.intent.value.cursor)!;
  return { contract: ATTEMPT_BINDING_CONTRACT, projectId: inputs.projectId,
    turn: links.turn, pending: exactRef(inputs.pending), intent: exactRef(inputs.intent),
    planAnswer: subject.planAnswer, planQuestionId: subject.planQuestionId, attempt: exactRef(inputs.attempt) };
}

export type TurnTransitionProof =
  | { kind: 'pause' }
  /** UNK1: `unknown` names the unknown era of the producing intent; absent in the DRY5FIX era. */
  | { kind: PaidLocalRefusalKind; unknown?: true }
  /** UNK1 (№4686 §3): an early need_research on the current question of the unknown era — the turn completes with
   * observation.unknown. searched are the run's actually saved reads, derived by the caller's common reader. */
  | { kind: 'early-unknown'; draft: Revision<DiscoveryDraft>; question: Revision<Question>;
      producer: Revision<ResearchConsumerIntent>; searched: Ref[]; upstream?: { stage: Revision<StageArtifact>; field: string } }
  | LayerDesignRefusalProof
  | { kind: 'technical-refusal'; result: { ref: Ref; value: {
      contract: 'research-proposal-refusal/v1'; projectId: string; turn: Ref;
      pending: Ref; question: Ref; findings: Finding[] } } }
  | { kind: 'read-context'; recordValue: unknown; record: Ref; maxChars: number }
  | { kind: 'context-refusal'; recordValue: unknown; record: Ref; maxChars: number;
      projection?: 'bounded' }
  | { kind: 'delivery-refusal'; recordValue: unknown; record: Ref; maxChars: number;
      workspace: ContextWorkspace; delivered: ContextLookup[]; maxLookups?: number }
  | { kind: 'context-incomplete'; workspace: ContextWorkspace; subject: Record<string, any> }
  | { kind: 'read-bundle'; result: { ref: Ref; value: ReaderResult } }
  | { kind: 'checkpoint'; checkpoint: { ref: Ref; value: {
      projectId: string; draft: Ref; question: Ref; status: 'unassessed';
      proposal: unknown; observations: Observation[];
      unresolved: string[] } } }
  | { kind: 'source-excerpt'; readContract?: SourceReadContract; projectId: string; source: { ref: Ref; value: Source } }
  | { kind: 'source-read'; projectId: string; source: { ref: Ref; value: Source } }
  | { kind: 'reading-plan-queued'; children: Ref[] }
  | { kind: 'reading-mode' }
  | { kind: 'premature-owner'; consulted: readonly Ref[]; hadPriorRead: boolean }
  | { kind: 'owner-review'; verdict: { necessary: boolean; reason: string; [key: string]: unknown } }
  | { kind: 'assessed-answer'; question: Revision<Question>;
      assessment: Revision<ResearchAssessment>; expandedProposal?: unknown }
  | { kind: 'accepted-answer'; inputs: AcceptedPaidAnswerInputs;
      /** D8.4e: the proven K; mandatory for a turn of the binding era. */
      binding?: { ref: Ref; value: ResearchAcceptanceBinding } }
  /** DR3a3-K: a paid answer of the attempt era completes only from the attempt
   * the DR3a2 door recorded and its binding, written with the completed turn. */
  | { kind: 'attempt-recorded'; inputs: AttemptTurnInputs;
      binding: { ref: Ref; value: ResearchAttemptBinding } }
  | { kind: 'early-model-refusal'; draft: Revision<DiscoveryDraft>; question: Revision<Question>;
      producer: Revision<ResearchConsumerIntent>; web?: boolean;
      /** UNK1: the unknown-era admission of the producer (earlyUnknownAdmission); absent in the DRY5FIX era. */
      unknown?: EarlyUnknownAdmission;
      /** DRS1a2: the producer's exact call context, read by its own contract
       * (consumerIntentContext); a v2 producer carries none in its cursor. */
      context?: Record<string, any> }
  /** WB1: a web turn completes only from its saved capture (gateway answer or local refusal). */
  | { kind: 'web'; projectId: string; capture: Revision<WebCapture>; budget?: Revision<WebMaterialBudget> | null }
  | { kind: 'question-reopened'; original: Revision<Question>;
      reopened: Revision<Question>; draft: Revision<DiscoveryDraft> }
  | { kind: 'repeat-context'; current: ContextReadIdentityInput;
      history: ContextTurnHistoryProof[] };

/** Includes queued children whose historical addresses predate managed turns. */
export function projectSourceReadingTurn<T extends ResearchTurn>(before: T, projectId: string,
  source: { ref: Ref; value: Source }, readContract: SourceReadContract = SOURCE_READ_CONTRACT): T {
  const action = turnAction(before);
  requireCondition(before.status === 'pending' && before.error === null && before.assessment === null
    && action.action === 'read_source' && canonical(action.source) === canonical(source.ref),
    'research_consumer_intent_invalid', 'Only an exact pending source read can produce this result');
  return { ...before, status: 'completed', error: null,
    observation: projectSourceReading(projectId, source.ref, source.value,
      { start: action.start, end: action.end }, readContract) };
}

/** Pure producer projection. Callers must first prove each supplied record by
 * its exact historical reader; no code/message supplied by the caller is used
 * as an authority for a local refusal. */
export function projectResearchTurnRevision(before: ManagedResearchTurn,
  proof: TurnTransitionProof): ManagedResearchTurn {
  requireCondition(before.status === 'pending' && before.error === null
    && before.contract === 'research-consumer-turn/v1',
  'research_consumer_intent_invalid', 'Only a pending paid turn can be completed');
  const action = turnAction(before);
  // DR3a3-K: a paid answer of the attempt era completes only through its
  // attempt record — never by a proof of the field path (assessed, accepted,
  // FieldSpec/early, layer, technical, reopened or context refusals).
  if (attemptEraOf(before) === 'attempt' && action.action === 'answer')
    requireCondition(proof.kind === 'attempt-recorded', 'research_consumer_intent_invalid',
      'A paid answer of the attempt era completes only through its attempt record');
  if (proof.kind === 'context-incomplete') {
    requireCondition(action.action === 'answer' || action.action === 'answer_delta',
      'research_consumer_intent_invalid', 'Only a final paid answer can claim incomplete context');
    let failure: EngineError | null = null;
    try { requireCompleteContextPacket(proof.workspace, proof.subject); }
    catch (error) { if (error instanceof EngineError) failure = error; else throw error; }
    requireCondition(failure?.code === 'research_context_incomplete',
      'research_consumer_intent_invalid', 'The saved packet does not prove incomplete delivery');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: failure.code, details: failure.details }, error: failure.message };
  }
  if (proof.kind === 'mode-refusal' || proof.kind === 'reading-plan-refusal'
    || proof.kind === 'reading-mode-refusal' || proof.kind === 'search-query-refusal') {
    const reason = paidLocalRefusalReason(before, action, 'unknown' in proof && proof.unknown === true);
    requireCondition(reason?.kind === proof.kind, 'research_consumer_intent_invalid',
      'The original paid action does not produce this local refusal');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: reason.code, details: null }, error: reason.message };
  }
  if (proof.kind === 'layer-design-refusal') {
    const { draft, question, graph, failure, projectId } = proof;
    requireCondition((action.action === 'answer' || action.action === 'answer_delta')
      && isRef(before.question) && action.question === before.question.id
      && canonical(before.question) === canonical(exactRef(question))
      && draft.kind === 'discovery-draft' && question.kind === 'question' && graph.kind === 'graph'
      && hashJson(draft.value) === draft.hash && hashJson(question.value) === question.hash
      && hashJson(graph.value) === graph.hash
      && draft.value.projectId === projectId && question.value.projectId === projectId
      && question.value.draftId === draft.id && draft.value.questions.includes(question.id)
      && draft.value.stage === 'om-g2' && ['R1', 'R2'].includes(draft.value.level)
      && question.value.spec.field === 'layerDesign'
      && (action.action === 'answer_delta' || draft.value.level === 'R2'
        || failure.code === 'layer_delta_required')
      && graph.id === `graph:${projectId}`
      && (action.action !== 'answer_delta' || canonical(action.base) === canonical(exactRef(graph)))
      && typeof failure.message === 'string' && failure.message.length > 0
      && isCorrectableLayerDesignFailure(new EngineError(failure.code, failure.message, failure.details)),
    'research_consumer_intent_invalid', 'A layer refusal needs its exact paid draft, question, graph and correctable design failure');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: failure.code, details: failure.details }, error: failure.message };
  }
  if (proof.kind === 'technical-refusal') {
    const result = proof.result;
    requireCondition((action.action === 'answer' || action.action === 'answer_delta')
      && result.value.contract === 'research-proposal-refusal/v1'
      && result.value.projectId.length > 0
      && isRef(result.ref) && result.ref.revision === 1
      && result.ref.id === `research-proposal-refusal:v1:${hashJson({
        projectId: result.value.projectId,
        turnId: `research-turn:v1:${hashJson([before.run, before.number])}` })}`
      && result.ref.hash === hashJson(result.value)
      && isRef(result.value.turn) && result.value.turn.revision === 1
      && result.value.turn.id === `research-turn:v1:${hashJson([before.run, before.number])}`
      && isRef(result.value.pending) && result.value.pending.id === result.value.turn.id
      && canonical(result.value.question) === canonical(before.question)
      && action.question === result.value.question.id
      && Array.isArray(result.value.findings) && result.value.findings.length > 0,
    'research_consumer_intent_invalid', 'A technical refusal needs the checked exact original paid answer');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: 'research_proposal_invalid', details: result.value.findings,
        refusal: result.ref },
      error: 'Correct the typed proposal findings before model assessment' };
  }
  if (proof.kind === 'pause') {
    requireCondition(action.action === 'pause', 'research_consumer_intent_invalid',
      'Only a paid pause can produce a paused run');
    return { ...before, status: 'completed', error: null, observation: null };
  }
  if (proof.kind === 'read-context') {
    requireCondition(action.action === 'read_context'
      && canonical(action.record) === canonical(proof.record),
    'research_consumer_intent_invalid', 'The addressed read changed its exact paid request');
    return { ...before, status: 'completed', error: null, observation:
      projectResearchContextRead(proof.recordValue, proof.record, action.pointer,
        action.page, proof.maxChars, 'bounded') };
  }
  if (proof.kind === 'context-refusal') {
    requireCondition(action.action === 'read_context'
      && canonical(action.record) === canonical(proof.record),
    'research_consumer_intent_invalid', 'The refused context read changed its exact paid request');
    let failure: EngineError | null = null;
    try {
      projectResearchContextRead(proof.recordValue, proof.record, action.pointer,
        action.page, proof.maxChars, proof.projection ?? 'legacy');
    } catch (error) {
      if (error instanceof EngineError) failure = error;
      else throw error;
    }
    requireCondition(failure, 'research_consumer_intent_invalid',
      'A successful context projection cannot be saved as a refusal');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: failure.code, details: failure.details }, error: failure.message };
  }
  if (proof.kind === 'delivery-refusal') {
    requireCondition(action.action === 'read_context'
      && canonical(action.record) === canonical(proof.record),
    'research_consumer_intent_invalid', 'The refused delivery changed its paid context request');
    const result = projectResearchContextRead(proof.recordValue, proof.record,
      action.pointer, action.page, proof.maxChars, 'bounded');
    let failure: EngineError | null = null;
    try { addContextLookup(proof.workspace, result, proof.delivered, proof.maxLookups); }
    catch (error) { if (error instanceof EngineError) failure = error; else throw error; }
    requireCondition(failure, 'research_consumer_intent_invalid',
      'A deliverable context result cannot be saved as a local refusal');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: failure.code, requested: result }, error: failure.message };
  }
  if (proof.kind === 'read-bundle') {
    requireCondition(action.action === 'read_bundle'
      && canonical(before.question) === canonical(proof.result.value.question)
      && proof.result.value.purpose === action.purpose,
    'research_consumer_intent_invalid', 'The checked reader result belongs to another paid bundle');
    const value = proof.result.value;
    return { ...before, status: 'completed', error: null,
      observation: { ref: proof.result.ref, observations: value.observations,
        coverage: value.coverage, unresolved: value.unresolved } };
  }
  if (proof.kind === 'checkpoint') {
    requireCondition(action.action === 'checkpoint'
      && proof.checkpoint.value.status === 'unassessed'
      && proof.checkpoint.value.question.id === action.question
      && canonical(before.question) === canonical(proof.checkpoint.value.question)
      && canonical(proof.checkpoint.value.proposal) === canonical(action.value)
      && canonical(proof.checkpoint.value.unresolved) === canonical(action.unresolved)
      && canonical(proof.checkpoint.value.observations.map(item =>
        ({ source: item.source, selector: item.selector }))) === canonical(action.citations),
    'research_consumer_intent_invalid', 'The checked checkpoint differs from the paid proposal');
    return { ...before, status: 'completed', error: null,
      observation: { ref: proof.checkpoint.ref, ...proof.checkpoint.value } };
  }
  if (proof.kind === 'source-excerpt') {
    requireCondition(action.action === 'read_source'
      && canonical(action.source) === canonical(proof.source.ref)
      && proof.source.value.projectId === proof.projectId
      && proof.source.ref.id.startsWith(`source:${proof.projectId}:`)
      && digest(proof.source.value.content) === proof.source.value.sha256,
    'research_consumer_intent_invalid', 'The source excerpt differs from its checked paid source');
    if (proof.readContract !== undefined) {
      requireCondition(proof.readContract === SOURCE_READ_CONTRACT || proof.readContract === SOURCE_READ_CONTRACT_V2
        || proof.readContract === SOURCE_READ_CONTRACT_V3,
        'research_consumer_intent_invalid', 'Unknown source read contract');
      return projectSourceReadingTurn(before, proof.projectId, proof.source, proof.readContract);
    }
    requireCondition(action.end - action.start <= 50_000 && action.end <= proof.source.value.content.length,
      'research_consumer_intent_invalid', 'The historical excerpt exceeds its source');
    return { ...before, status: 'completed', error: null,
      observation: { projectId: proof.source.value.projectId,
        source: proof.source.ref,
        selector: { kind: 'text-range', start: action.start, end: action.end },
        value: proof.source.value.content.slice(action.start, action.end) } };
  }
  if (proof.kind === 'source-read') {
    requireCondition(action.action === 'read'
      && proof.source.value.projectId === proof.projectId
      && proof.source.ref.id === `source:${proof.projectId}:research-${digest(action.path).slice(0, 32)}`
      && proof.source.value.origin.kind === 'file'
      && action.media === proof.source.value.mediaType
      && digest(proof.source.value.content) === proof.source.value.sha256,
    'research_consumer_intent_invalid', 'The source read differs from its checked paid source');
    const content = proof.source.value.content;
    return { ...before, status: 'completed', error: null,
      observation: { ref: proof.source.ref, length: content.length,
        excerpt: content.slice(0, 3000), truncated: content.length > 3000 } };
  }
  if (proof.kind === 'reading-plan-queued') {
    requireCondition(action.action === 'read_plan' && proof.children.length === action.reads.length,
      'research_consumer_intent_invalid', 'The checked child queue differs from the paid plan');
    return { ...before, status: 'completed', error: null,
      observation: { state: 'queued', children: proof.children } };
  }
  if (proof.kind === 'reading-mode') {
    requireCondition(action.action === 'synthesize' || action.action === 'need_research',
      'research_consumer_intent_invalid', 'Only a paid planning action can select a reading mode');
    return { ...before, status: 'completed', error: null,
      observation: { nextMode: action.action === 'synthesize' ? 'synthesis' : 'planning' } };
  }
  if (proof.kind === 'premature-owner') {
    requireCondition(action.action === 'need_owner', 'research_consumer_intent_invalid',
      'A local owner refusal needs the paid need_owner action');
    const covered = action.searched.every(searched => proof.consulted.some(source => canonical(source) === canonical(searched)));
    requireCondition(!covered || !proof.hadPriorRead, 'research_consumer_intent_invalid',
      'A sourced owner request must proceed to the reviewer');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: 'owner_escalation_premature' },
      error: 'Research must consult actual sources before involving the owner' };
  }
  if (proof.kind === 'owner-review') {
    requireCondition(action.action === 'need_owner' && typeof proof.verdict.necessary === 'boolean'
      && typeof proof.verdict.reason === 'string' && proof.verdict.reason.trim().length > 0,
    'research_consumer_intent_invalid',
    'The owner verdict needs the paid request and checked reviewer reason');
    return { ...before, status: 'completed', assessment: null,
      observation: proof.verdict, error: null };
  }
  if (proof.kind === 'attempt-recorded') {
    requireCondition(attemptEraOf(before) === 'attempt' && action.action === 'answer',
      'research_attempt_binding_invalid',
      `[${before.run}] Only a pending paid answer of the attempt era completes through an attempt record`);
    const { inputs, binding } = proof;
    requireCondition(!!inputs?.pending && canonical(inputs.pending.value) === canonical(before),
      'research_attempt_binding_invalid', `[${before.run}] The attempt record names another pending turn`);
    // The supplied binding must be the exact record of THIS pending revision:
    // its address, revision 1, its hash, P = before (by value hash; the
    // caller's CAS names the revision), I = before.consumerIntent, O = the
    // first revision of this turn, and a value re-derived from the same inputs.
    const expected = projectAttemptBinding(inputs, { turn: binding?.value?.turn });
    requireCondition(isRef(binding.ref) && binding.ref.revision === 1
      && binding.ref.id === attemptBindingId(binding.value.projectId, binding.value.turn.id)
      && binding.ref.hash === hashJson(binding.value)
      && canonical(binding.value) === canonical(expected)
      && binding.value.turn.revision === 1 && binding.value.turn.id === managedTurnId(before.run, before.number)
      && binding.value.pending.hash === hashJson(before)
      && canonical(binding.value.intent) === canonical(before.consumerIntent),
    'research_attempt_binding_invalid',
    `[${binding?.value?.turn?.id ?? before.run}] The attempt record names another pending turn, intent or attempt`);
    const end = (inputs.attempt.value.end as unknown as { type: string }).type;
    return { ...before, status: 'completed', assessment: null,
      observation: { attempt: binding.value.attempt, end }, error: null,
      attempt: binding.value.attempt, attemptBinding: binding.ref };
  }
  if (proof.kind === 'assessed-answer') {
    const assessment = proof.assessment, question = proof.question;
    const proposal = action.action === 'answer' ? action.value
      : action.action === 'answer_delta' ? proof.expandedProposal : undefined;
    requireCondition((action.action === 'answer' || action.action === 'answer_delta')
      && proposal !== undefined && action.question === question.id
      && canonical(before.question) === canonical(exactRef(question))
      && question.kind === 'question' && hashJson(question.value) === question.hash
      && assessment.kind === 'research-assessment' && assessment.revision === 1
      && assessment.id === `research-assessment:${hashJson(assessment.value)}`
      && assessment.hash === hashJson(assessment.value)
      && assessment.value.projectId === question.value.projectId
      && canonical(assessment.value.question) === canonical(exactRef(question))
      && (assessment.value.verdict === 'insufficient' || assessment.value.verdict === 'conflicting')
      && Array.isArray(assessment.value.reasons) && assessment.value.reasons.length > 0
      && assessment.value.reasons.every(reason => typeof reason === 'string')
      && assessment.value.researcher !== assessment.value.assessor
      && canonical(assessment.value.value) === canonical(proposal)
      && canonical(assessment.value.observations.map(item =>
        ({ source: item.source, selector: item.selector }))) === canonical(action.citations),
    'research_consumer_intent_invalid',
    'The checked assessment does not classify the original paid answer');
    // The caller proves this exact assessment's producer before supplying it.
    return { ...before, status: 'completed', assessment: exactRef(assessment),
      observation: { verdict: assessment.value.verdict, reasons: assessment.value.reasons }, error: null };
  }
  if (proof.kind === 'accepted-answer') {
    requireCondition(canonical(proof.inputs.action) === canonical(before.action)
      && canonical(before.question) === canonical(exactRef(proof.inputs.questionBefore))
      && (action.action === 'answer' || action.action === 'answer_delta')
      && action.question === proof.inputs.questionBefore.id,
    'research_consumer_intent_invalid',
    'The accepted result does not belong to the original paid action');
    // The caller supplies the acceptance's own exact source pair, not a pair
    // guessed from today's draft head or a neighbouring revision number.
    const matched = matchAcceptedPaidAnswer(proof.inputs);
    requireCondition(matched, 'research_consumer_intent_invalid',
      'The checked acceptance does not derive from the paid answer');
    // D8.4e: a turn whose producer fixed the binding contract completes only
    // from its proven K; the era is the turn's own immutable field, never the
    // presence of a record. K names this exact pending revision (P), the
    // original turn and intent of `before`, and the same chain the completed
    // turn persists. A legacy-era turn accepted by new code links its K too.
    requireCondition(acceptanceEraOf(before) === 'legacy' || proof.binding,
      'research_acceptance_binding_invalid',
      `[${before.run}] A managed turn of the binding era completes only through its exact acceptance record`);
    const chain: AcceptedAnswerChain = {
      draftBefore: exactRef(proof.inputs.draftBefore), draftAfter: exactRef(proof.inputs.draftAfter),
      questionBefore: exactRef(proof.inputs.questionBefore), questionAfter: exactRef(proof.inputs.questionAfter),
      answer: exactRef(proof.inputs.answer), assessment: exactRef(proof.inputs.assessment) };
    let bindingRef: Ref | undefined;
    if (proof.binding) {
      const saved = proof.binding.value;
      // The supplied K must be the exact record of THIS pending revision: its
      // address, revision 1, its hash, P = `before` (by value hash; the
      // caller's CAS names the revision), I = before.consumerIntent, O = the
      // first revision of this turn, and a value that re-derives from the same
      // inputs (chain and links alike).
      const expected = projectAcceptanceBinding(proof.inputs, { turn: saved.turn, pending: saved.pending,
        intent: saved.intent, assessmentProof: saved.assessmentProof });
      requireCondition(isRef(proof.binding.ref) && proof.binding.ref.revision === 1
        && proof.binding.ref.id === acceptanceBindingId(saved.projectId, saved.turn.id)
        && proof.binding.ref.hash === hashJson(saved)
        && canonical(saved) === canonical(expected)
        && saved.pending.id === saved.turn.id && saved.turn.revision === 1
        && canonical(saved.intent) === canonical(before.consumerIntent)
        && saved.pending.hash === hashJson(before)
        && saved.turn.id === managedTurnId(before.run, before.number),
      'research_acceptance_binding_invalid',
      `[${saved.turn?.id ?? before.run}] The acceptance record names another pending turn, intent or chain`);
      bindingRef = proof.binding.ref;
    }
    // Persist the exact chain: later readers consume these references instead
    // of rescanning a draft that may have accepted further answers since.
    return { ...before, status: 'completed', assessment: matched.assessment,
      observation: matched.observation, error: null, acceptance: chain,
      ...(bindingRef ? { acceptanceBinding: bindingRef } : {}) };
  }
  if (proof.kind === 'web') {
    const { capture, projectId } = proof;
    requireCondition(capture.kind === 'web-capture' && hashJson(capture.value) === capture.hash
      && (capture.value.contract === WEB_CAPTURE_CONTRACT || capture.value.contract === WEB_CAPTURE_CONTRACT_V2
        || capture.value.contract === WEB_CAPTURE_CONTRACT_V3)
      && capture.value.projectId === projectId
      && capture.value.turn.hash === hashJson(before) && canonical(capture.value.action) === canonical(before.action)
      && (action.action === 'web_search' || action.action === 'web_fetch' || capture.value.response.kind === 'refused'),
    'research_consumer_intent_invalid', 'The web completion lost its exact capture of this pending turn');
    return projectWebApplication(projectId, before, capture, proof.budget).turn as ManagedResearchTurn;
  }
  if (proof.kind === 'early-unknown') {
    const { draft, question, producer, searched } = proof;
    requireCondition(producer.kind === 'research-consumer-intent' && hashJson(producer.value) === producer.hash
      && canonical(exactRef(producer)) === canonical(before.consumerIntent) && producer.value.kind === 'analyst'
      && earlyUnknownEra(producer.value.cursor)
      && canonical(producer.value.draft) === canonical(exactRef(draft))
      && canonical(producer.value.question) === canonical(exactRef(question))
      && draft.kind === 'discovery-draft' && question.kind === 'question'
      && hashJson(draft.value) === draft.hash && hashJson(question.value) === question.hash
      && canonical(before.question) === canonical(exactRef(question))
      && question.value.draftId === draft.id && draft.value.questions.includes(question.id)
      && action.action === 'need_research' && action.question === question.id
      && Array.isArray(searched) && searched.every(isRef),
    'research_consumer_intent_invalid', 'The early unknown lost its exact producer, draft and current question');
    let upstream: EarlyUnknown['upstream'];
    if (action.upstream) {
      const stage = proof.upstream?.stage, fields = (stage?.value.content as { fields?: unknown } | undefined)?.fields;
      requireCondition(stage?.kind === 'stage' && hashJson(stage.value) === stage.hash
        && canonical(exactRef(stage)) === canonical(action.upstream.stage)
        && draft.value.inputs.some(ref => canonical(ref) === canonical(exactRef(stage)))
        && stage.value.status === 'accepted' && stage.value.projectId === draft.value.projectId
        && proof.upstream!.field === action.upstream.field && fields !== null && typeof fields === 'object'
        && Object.hasOwn(fields, action.upstream.field),
      'research_consumer_intent_invalid', 'The upstream address is not an exact accepted input stage and field of this draft');
      upstream = { stage: exactRef(stage), field: action.upstream.field };
    } else requireCondition(proof.upstream === undefined, 'research_consumer_intent_invalid',
      'An upstream stage needs the explicit upstream address of the paid action');
    const unknown: EarlyUnknown = { contract: EARLY_UNKNOWN, draft: exactRef(draft), question: exactRef(question),
      field: question.value.spec.field, missing: [...action.missing], searched: [...searched],
      door: upstream ? 'upstream' : 'research', ...(upstream ? { upstream } : {}) };
    return { ...before, status: 'completed', assessment: null, error: null, observation: { contract: EARLY_UNKNOWN, unknown } };
  }
  if (proof.kind === 'early-model-refusal') {
    const { draft, question, producer } = proof;
    requireCondition(producer.kind === 'research-consumer-intent' && hashJson(producer.value) === producer.hash
      && canonical(exactRef(producer)) === canonical(before.consumerIntent)
      && canonical(producer.value.draft) === canonical(exactRef(draft))
      && canonical(producer.value.question) === canonical(exactRef(question))
      && draft.kind === 'discovery-draft' && question.kind === 'question'
      && hashJson(draft.value) === draft.hash && hashJson(question.value) === question.hash
      && canonical(before.question) === canonical(exactRef(question))
      && question.value.draftId === draft.id && draft.value.questions.includes(question.id)
      && (!('question' in action) || action.question === question.id),
    'research_consumer_intent_invalid', 'The early refusal lost its exact draft and selected question');
    // UNK1: the refusal is classified in the action era of its own producer — the same admission the runner classified with.
    const unknown = proof.unknown ?? null;
    requireCondition((producer.value.kind === 'analyst' && earlyUnknownEra(producer.value.cursor)) === (unknown !== null)
      && (!unknown || unknown.questionId === question.id && unknown.targets.every(row =>
        draft.value.inputs.some(input => canonical(input) === canonical(row.stage)))),
    'research_consumer_intent_invalid', 'The early refusal names the action era of its own producer');
    requireCondition(producer.value.contract === 'research-consumer-intent/v1' || recordValue(proof.context),
      'research_consumer_intent_invalid', 'The early refusal of a compact producer needs its exact restored context');
    const context = proof.context ?? producer.value.cursor.context;
    const failure = earlyResearchFailure(draft.value, question.value, 'analyst', action,
      context?.discoveryContext ?? null, proof.web === true, unknown,
      context?.discoveryBasisCatalogue ?? null,
      deliveredConceptSections(context, draft.value),
      context?.prerequisites ?? null);
    requireCondition(failure, 'research_consumer_intent_invalid', 'A valid early reply cannot become a model refusal');
    return { ...before, status: 'completed', assessment: null,
      observation: { contract: EARLY_RESEARCH_OUTCOME, code: failure.code, details: failure.details ?? null,
        draft: exactRef(draft), question: exactRef(question) }, error: failure.message };
  }
  if (proof.kind === 'question-reopened') {
    const { original, reopened, draft } = proof;
    const field = original.value.spec.field;
    requireCondition(original.kind === 'question' && reopened.kind === 'question'
      && draft.kind === 'discovery-draft'
      && hashJson(original.value) === original.hash
      && hashJson(reopened.value) === reopened.hash
      && hashJson(draft.value) === draft.hash
      && canonical(before.question) === canonical(exactRef(original))
      && (!('question' in action) || action.question === original.id)
      && reopened.id === original.id && reopened.revision === original.revision + 1
      && draft.id === original.value.draftId
      && draft.value.projectId === original.value.projectId
      && draft.value.questions.includes(original.id)
      && Object.hasOwn(draft.value.fields, field)
      && canonical(reopened.value) === canonical({ ...original.value,
        beforeHash: hashJson(draft.value.fields[field]), status: 'open', answer: null }),
    'research_consumer_intent_invalid',
    'The reopened question does not derive from its exact original and draft');
    return { ...before, status: 'completed', assessment: null,
      observation: { code: 'research_question_reopened', question: exactRef(reopened),
        draft: exactRef(draft) },
      error: 'The original question was reopened before this paid turn completed' };
  }
  if (proof.kind === 'repeat-context') {
    const repeated = projectRepeatedContextRead(before, proof.current, proof.history);
    requireCondition(repeated, 'research_consumer_intent_invalid',
      'The addressed page is not a repeat of an earlier completed read');
    return { ...before, status: 'pending',
      observation: { code: 'research_no_progress', ...repeated } };
  }
  throw new EngineError('research_consumer_intent_invalid',
    'The paid turn has no checked transition for its result');
}

/** Compare the complete requested transition, including unchanged paid action
 * and binding. The caller re-derives `proof` from exact records, not a saved
 * observation or caller-provided error code. */
export function assertResearchTurnTransition(before: ManagedResearchTurn,
  after: ManagedResearchTurn, proof: TurnTransitionProof): void {
  const expected = projectResearchTurnRevision(before, proof);
  requireCondition(canonical(after) === canonical(expected),
    'research_consumer_intent_invalid', 'The saved turn differs from its exact checked transition');
}

/** The paid pause is a terminal turn and a paused run in the same transaction. */
export function projectPaidPause(beforeRun: ResearchRun, beforeTurn: ManagedResearchTurn):
  { run: ResearchRun; turn: ManagedResearchTurn } {
  const action = turnAction(beforeTurn);
  requireCondition(action.action === 'pause', 'research_consumer_intent_invalid',
    'Only the exact paid pause can pause its run');
  return { run: { ...beforeRun, status: 'paused', error: action.reason, pauseCode: null },
    turn: projectResearchTurnRevision(beforeTurn, { kind: 'pause' }) };
}

/** A paid reviewer verdict completes the original need_owner turn and changes
 * the run together; neither outcome is inferred from a caller-supplied status. */
export function projectPaidOwnerReview(beforeRun: ResearchRun, beforeTurn: ManagedResearchTurn,
  verdict: { necessary: boolean; reason: string; [key: string]: unknown },
  owner: ResearchRun['owner'], limit: number):
  { run: ResearchRun; turn: ManagedResearchTurn } {
  const action = turnAction(beforeTurn);
  // DR3a3-K-01 (№7543): the owner is asked about the turn's logical question —
  // the plan-question id of an attempt subject, the Question id of a field turn.
  const questionId = turnQuestionId(beforeTurn);
  requireCondition(action.action === 'need_owner' && typeof verdict.necessary === 'boolean'
    && typeof verdict.reason === 'string' && verdict.reason.trim().length > 0
    && questionId !== null && questionId === action.question
    && Number.isSafeInteger(limit) && limit > 0,
  'escalation_assessment_invalid', 'An owner review needs the exact paid request and verdict');
  const turn = projectResearchTurnRevision(beforeTurn, { kind: 'owner-review', verdict });
  return { turn, run: { ...beforeRun,
    status: verdict.necessary ? 'needs_owner' : 'running',
    ownerQuestion: verdict.necessary
      ? { question: questionId, reason: verdict.reason, searched: action.searched }
      : null,
    limit, owner, error: null, pauseCode: null } };
}

/** A projector consumes already proven physical/session inputs. It neither
 * proves a caller's Ref nor accepts claims; the historical reader does both
 * structural and provenance checks before exposing the resulting assessment. */
export function projectPaidAttemptsAssessment(input: { subject: AssessmentTransportSubject;
  session: Ref; application: Ref; environment: Ref; assessor: string; result: unknown }):
  { id: string; value: PaidDiscoveryAttemptsAssessment } {
  const contract = input.subject?.assessment?.contract;
  requireCondition((contract === DISCOVERY_ASSESSMENT_CONTRACT_V2 || contract === DISCOVERY_ASSESSMENT_CONTRACT_V3)
    && isRef(input.session) && isRef(input.application) && isRef(input.environment)
    && typeof input.assessor === 'string' && input.assessor.trim().length > 0,
    'discovery_assessment_invalid', 'A projected assessment needs its exact paid inputs and explicit versioned subject');
  requireAttemptsAssessmentReply(input.result, input.subject);
  requireCondition(input.result !== null && typeof input.result === 'object' && !Object.hasOwn(input.result, 'action'),
    'discovery_assessment_invalid', 'A continuation is not a terminal packet assessment');
  const origin = { projectId: input.subject.packet.project,
    subject: { kind: 'attempts' as const, packet: input.subject.packet }, baseline: input.subject.baseline,
    session: input.session, application: input.application, assessor: input.assessor, environment: input.environment };
  // The exact declared wire schema above proves the correlated policy/novelty
  // form. A saved v2 response always retains its original form and address.
  let value: PaidDiscoveryAttemptsAssessment;
  if (contract === DISCOVERY_ASSESSMENT_CONTRACT_V3) {
    const result = input.result as Pick<DiscoveryAttemptsAssessmentV3, 'verdict'|'reasons'|'return'|'novelty'|'methodology'>;
    value = { ...origin, contract, verdict: result.verdict, reasons: result.reasons, return: result.return,
      novelty: result.novelty, methodology: result.methodology };
  } else {
    const result = input.result as Pick<DiscoveryAttemptsAssessmentV2, 'verdict'|'reasons'|'return'|'novelty'|'methodology'>;
    value = { ...origin, contract, verdict: result.verdict, reasons: result.reasons, return: result.return,
      novelty: result.novelty, methodology: result.methodology };
  }
  return { id: discoveryAssessmentId(value), value };
}
export const discoveryAssessmentId = (value: Pick<PaidDiscoveryAttemptsAssessment, 'contract'|'projectId'|'session'|'application'>) =>
  `discovery-assessment:${value.contract === DISCOVERY_ASSESSMENT_CONTRACT_V3 ? 'v3' : 'v2'}:${hashJson({ projectId: value.projectId, session: value.session, application: value.application })}`;

/* 4T.4: execution owns a logical variant dispatch, independently of D3 and of the
 * product set/state published by 4B. The receipt pins the running intent, never
 * its simultaneously-created terminal revision. No current mode is read here. */
export function variantExecutionSessionId(value: Pick<VariantExecutionSession,
  'projectId' | 'draft' | 'question' | 'variantSubject' | 'purpose' | 'actor'>): string {
  return `discovery-variant-session:${hashJson({projectId:value.projectId,draft:value.draft,
    question:value.question,variantSubject:value.variantSubject,purpose:value.purpose,actor:value.actor})}`;
}
export function projectPaidVariantSession(session: Revision<VariantExecutionSession>,
  intent: Revision<ResearchConsumerIntent>, paid: {call:Ref;response:Ref;payload:unknown}): VariantExecutionSession {
  const before=decodeVariantExecutionSession(session.value), v=intent.value;
  requireCondition(session.kind==='discovery-variant-session' && session.revision===1 && before.cursor===0
    && session.hash===hashJson(before) && session.id===variantExecutionSessionId(before)
    && intent.kind==='research-consumer-intent' && intent.hash===hashJson(v) && v.state==='running'
    && canonical(v.owner)===canonical(reference(session)) && v.projectId===before.projectId
    && canonical(v.draft)===canonical(before.draft) && canonical(v.question)===canonical(before.question)
    && v.kind===before.purpose && v.role.actor===before.actor
    && canonical(v.cursor.variantSubject)===canonical(before.variantSubject) && v.cursor.sessionId===session.id
    && v.cursor.offset===0 && isRef(paid.call) && isRef(paid.response),
  'discovery_variant_session_invalid','The variant receipt needs its exact initial session and paid running intent');
  const capacityFailure=researchResultFailure(v.cursor.resultCapacity,paid.payload);
  if(capacityFailure) throw capacityFailure;
  if(before.variantSubject.kind==='proposal') decodeVariantGeneration(paid.payload);
  return {...before,cursor:1,result:{intent:reference(intent),call:paid.call,response:paid.response}};
}

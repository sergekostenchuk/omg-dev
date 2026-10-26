import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Observation, Selector, Source } from '../evidence/evidence.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { type DiscoveryDraft, type DiscoveryPrefixClosure, DISCOVERY_PREFIX_CLOSURE_KIND,
  discoveryPrefixClosureId, type Fact, type Question, readAcceptedResearchAnswer } from './discovery.js';
import { type FrameInterpretations, readFrameInterpretationsStructural } from './frame-interpretations.js';
import { proveIssuedAnswer, savedAcceptanceAct } from './projection-reader.js';
import { historicalObservation } from './response-recovery.js';
import type { ResearchAcceptanceBinding } from './research-consumer-transition.js';
import type { ResearchAnswer, ResearchAssessment } from './research-model.js';
import { DISCOVERY_ACCEPTANCE_ACT_KIND, discoveryAcceptanceActId, provenAcceptance,
  type DiscoveryAcceptanceAct } from './v7-contracts.js';

/** DR2b 2b.1-SOURCES (codex-omg №14475, residue of №9569): the public read-only
 * preparer of the complete source subject of one exact accepted D1 frame — the
 * material a lawful interpretations set (2b.1-F) is made over, resolved before a
 * choice exists. The request names the project, the exact frame proposal
 * revision, the verbatim mandate as a Source + selector address, and an optional
 * previous structural set. The collector proves the project, the frame's real
 * D1 question/draft/acceptance chain and the sources the frame rests on: the
 * assessment observations are re-resolved against the saved source bytes, the
 * mandate is resolved verbatim through the shared selector mechanism and must
 * be the draft's own proven accepted brief — the caller never selects a reduced
 * excerpt — and a previous set is read by the structural reader and has its own
 * sources resolved the same way. Everything is proven at exact saved revisions:
 * a later head never stands in for a historical revision. The boundary is
 * explicit: this resolves the sources and the material only — it is not proof
 * of payment or of the set's semantic correctness, it chooses no interpretation
 * and it is no owner act (2b.2–2b.6); a structural set stays structural, and the
 * API writes no records and sends no model calls. */

export const FRAME_SUBJECT_CONTRACT = 'frame-interpretation-subject/v1' as const;

/** The caller's part: exact addresses only — never lists of members or bytes. */
export interface FrameSubjectRequest {
  project: string;
  /** The exact frame proposal revision — an accepted `research-answer` of the draft's `frame` question. */
  frame: Ref;
  /** The verbatim mandate: the draft's own accepted brief as Source + selector. */
  mandate: { source: Ref; selector: Selector };
  previousSet?: Ref | null;
}

/** One resolved source excerpt: the exact source record and the observation the selector yields over its saved bytes. */
export interface ResolvedSource {
  source: Revision<Source>;
  observation: Observation;
}

/** The frame proposal with its whole proven provenance: the exact answer, the
 * D1 question revision it closed, the draft revision carrying the field, the
 * saved acceptance act, its assessment and binding, the draft's inputs resolved
 * and every assessment observation re-resolved against the saved bytes. */
export interface FrameProvenance {
  record: Revision<ResearchAnswer>;
  question: Revision<Question>;
  draft: Revision<DiscoveryDraft>;
  acceptance: Revision<DiscoveryAcceptanceAct>;
  assessment: Revision<ResearchAssessment> | null;
  binding: Revision<ResearchAcceptanceBinding> | null;
  inputs: Revision<unknown>[];
  grounds: ResolvedSource[];
}

/** A previous interpretations set — structural exactly as the structural
 * reader returns it — with its own sources resolved: its verbatim brief, the
 * frame it names with that frame's own provenance, and its own previous set. */
export interface PreviousSetSubject {
  verification: 'structural';
  record: Revision<FrameInterpretations>;
  brief: ResolvedSource;
  frame: FrameProvenance;
  previous: PreviousSetSubject | null;
}

/** The complete resolved subject: closed form, content-derived identity. */
export interface FrameInterpretationSubject {
  contract: typeof FRAME_SUBJECT_CONTRACT;
  /** Derived identity of the whole package — the hash of every field except this one. */
  subject: string;
  project: string;
  frame: FrameProvenance;
  mandate: ResolvedSource;
  previous: PreviousSetSubject | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const HASH = /^[a-f0-9]{64}$/;
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_subject_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function missing(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_subject_missing', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function mismatch(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_subject_mismatch', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}

const same = (left: unknown, right: unknown): boolean => canonical(left as never) === canonical(right as never);

function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the subject form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'Expected an exact reference');
}
function selectorForm(value: unknown, at: string): asserts value is Selector {
  if (!object(value) || (value.kind !== 'json-pointer' && value.kind !== 'text-range'))
    invalid(`${at}.kind`, 'A selector is a json-pointer or a text-range');
  if (value.kind === 'json-pointer') {
    shape(value, ['kind', 'pointer'], at);
    if (typeof value.pointer !== 'string' || !POINTER.test(value.pointer)) invalid(`${at}.pointer`, 'Expected a canonical JSON Pointer');
  } else {
    shape(value, ['kind', 'start', 'end'], at);
    if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
      || (value.start as number) < 0 || (value.end as number) <= (value.start as number))
      invalid(at, 'A text range is ordered nonnegative UTF-16 offsets, start < end');
  }
}

function checkRequest(request: unknown): FrameSubjectRequest {
  if (!object(request)) invalid('request', 'Expected a subject request object');
  for (const key of ['project', 'frame', 'mandate'] as const)
    if (!Object.hasOwn(request, key)) invalid(`request.${key}`, 'The field is part of the request and is missing');
  for (const key of Object.keys(request))
    if (!['project', 'frame', 'mandate', 'previousSet'].includes(key))
      invalid(`request.${key}`, 'The field is not part of the subject request');
  text(request.project, 'request.project');
  ref(request.frame, 'request.frame');
  shape(request.mandate, ['source', 'selector'], 'request.mandate');
  ref(request.mandate.source, 'request.mandate.source');
  selectorForm(request.mandate.selector, 'request.mandate.selector');
  if (request.previousSet !== undefined && request.previousSet !== null)
    ref(request.previousSet, 'request.previousSet');
  return request as unknown as FrameSubjectRequest;
}

/** An exact saved revision: the record at the ref, of the declared kind when one
 * is given, its revision and content hash matching — never the current head. */
function exact<T>(store: Store, at: Ref, kind: string | null, field: string): Revision<T> {
  const row = store.get<T>(at.id, at.revision);
  if (!row) missing(field, 'The exact record is missing', at);
  if (canonical(reference(row)) !== canonical(at) || hashJson(row.value as never) !== at.hash)
    mismatch(field, 'The exact record revision or content hash does not match', at);
  if (kind !== null && row.kind !== kind)
    mismatch(field, `The exact record is a ${row.kind}, not a ${kind}`, at);
  return row;
}

/** A caller- or set-supplied excerpt resolved verbatim over the saved source
 * bytes through the shared selector mechanism. Out-of-range, missing-path,
 * foreign or changed source failures keep their own addressed refusals. */
function resolveObservation(store: Store, project: string,
  at: { source: Ref; selector: Selector }, field: string): ResolvedSource {
  if (!isRef(at.source)) invalid(`${field}.source`, 'Expected an exact source reference', at.source as Ref);
  const source = exact<Source>(store, at.source, 'source', `${field}.source`);
  if (source.value.projectId !== project)
    mismatch(`${field}.source`, 'The source belongs to another project', at.source);
  const observation = historicalObservation(store, project, { source: at.source, selector: at.selector });
  return { source, observation };
}

/** A saved observation re-resolved: the excerpt must still reproduce the saved
 * source bytes exactly — a substituted or stale observation is a mismatch. */
function resolveStored(store: Store, project: string, value: unknown, field: string): ResolvedSource {
  if (!object(value) || typeof value.projectId !== 'string' || !isRef(value.source)
    || !object(value.selector) || value.value === undefined)
    invalid(field, 'A saved observation needs its project, exact source, selector and value');
  const resolved = resolveObservation(store, project, { source: value.source, selector: value.selector as Selector }, field);
  if (value.projectId !== project || !same(resolved.observation, value))
    mismatch(field, 'A saved observation does not reproduce its saved bytes', value.source);
  return resolved;
}

/** The full proven provenance of one accepted `frame` research-answer: the
 * exact answer, its D1 question and draft at the revisions the saved
 * acceptance act names, the act itself, the assessment chain, the draft's
 * resolved inputs and the assessment's re-resolved observations. */
function resolveFrame(store: Store, project: string, frameRef: Ref, at: string): FrameProvenance {
  const { answer, assessment, binding } = readAcceptedResearchAnswer(store, project, frameRef);
  const issued = store.get<Question>(answer.value.question);
  if (!issued || issued.kind !== 'question' || issued.value.projectId !== project)
    missing(`${at}.question`, 'The frame names no saved D1 question of this project', frameRef);
  const head = store.get<DiscoveryDraft>(issued.value.draftId);
  if (!head || head.kind !== 'discovery-draft' || head.value.projectId !== project)
    missing(`${at}.draft`, 'The frame\'s question names no saved D1 draft of this project', frameRef);
  const act = store.get<DiscoveryAcceptanceAct>(discoveryAcceptanceActId(project, head.id, 'frame', frameRef), 1);
  if (!act || act.kind !== DISCOVERY_ACCEPTANCE_ACT_KIND || !isRef(act.value.questionAfter))
    missing(`${at}.acceptance`, 'The exact frame has no saved acceptance', frameRef);
  const question = exact<Question>(store, act.value.questionAfter, 'question', `${at}.question`);
  const draft = exact<DiscoveryDraft>(store, act.value.draftAfter, 'discovery-draft', `${at}.draft`);
  if (!savedAcceptanceAct(store, draft, question, 'frame', frameRef, answer.value.value))
    mismatch(at, 'The frame does not belong to this exact draft', frameRef);
  const proven = proveIssuedAnswer(store, draft,
    { question, foreign: false, answered: true, answerRef: frameRef, field: 'frame' },
    answer as unknown as Revision<Record<string, unknown>>, { verifyIssuedQuestion: true });
  if (!proven.ok || !provenAcceptance(proven.proof.provenance))
    mismatch(at, 'The frame has no proven accepted origin', frameRef);
  const inputs = draft.value.inputs.map((input, i) => {
    if (!isRef(input)) invalid(`${at}.inputs.${i}`, 'A draft input is not an exact reference');
    return exact<unknown>(store, input, null, `${at}.inputs.${i}`);
  });
  const grounds = (assessment && Array.isArray(assessment.value.observations) ? assessment.value.observations : [])
    .map((observation, i) => resolveStored(store, project, observation, `${at}.grounds.${i}`));
  return { record: answer, question, draft, acceptance: act, assessment, binding, inputs, grounds };
}

/** The brief acceptance in effect at the frame's draft revision, proven by the
 * draft's own saved prefix closure — the producer record written in the same
 * transaction as the frame's own revision. The closure names the accepted
 * brief answer and its act; the fact is read exactly, its observation must
 * still reproduce the saved source bytes and be the excerpt the frame's draft
 * carried. Returns null when the saved material proves no accepted brief —
 * the door does not exist for a non-closable acceptance and is never
 * replaced by a head read. */
function provenBrief(store: Store, project: string, frame: FrameProvenance): Observation | null {
  const draft = frame.draft;
  const closure = store.get<DiscoveryPrefixClosure>(discoveryPrefixClosureId(draft.id, draft.revision), 1);
  if (!closure || closure.kind !== DISCOVERY_PREFIX_CLOSURE_KIND || hashJson(closure.value) !== closure.hash
    || closure.value.draftId !== draft.id || closure.value.projectId !== project
    || !same(closure.value.draft, reference(draft)))
    return null;
  const entry = closure.value.questions.find(item => item.answer !== null
    && item.answer.field === 'brief' && item.answer.kind === 'fact' && isRef(item.question));
  const accepted = entry?.answer;
  if (!entry || !accepted || !isRef(accepted.answer) || !isRef(accepted.act)) return null;
  const act = exact<DiscoveryAcceptanceAct>(store, accepted.act, DISCOVERY_ACCEPTANCE_ACT_KIND, 'mandate.brief');
  if (act.value.projectId !== project || act.value.draftId !== draft.id || act.value.field !== 'brief'
    || !same(act.value.answer, accepted.answer) || !same(act.value.questionAfter, entry.question))
    return null;
  const fact = exact<Fact>(store, accepted.answer, 'fact', 'mandate.brief');
  if (fact.value.projectId !== project || fact.value.question !== entry.question.id) return null;
  const observation = fact.value.observation as unknown;
  if (!object(observation) || !isRef(observation.source) || !object(observation.selector)
    || observation.value === undefined || !same(observation.value, accepted.value)
    || !same(observation.value, draft.value.fields['brief'])
    || accepted.observations !== 1 || !same(accepted.sources, [observation.source]))
    return null;
  resolveStored(store, project, observation, 'mandate.brief');
  return fact.value.observation;
}

function resolvePrevious(store: Store, project: string, at: Ref, field: string,
  seen: Set<string>): PreviousSetSubject {
  if (seen.has(at.id)) mismatch(field, 'A previous set chain crosses itself', at);
  seen.add(at.id);
  const set = readFrameInterpretationsStructural(store, project, at);
  const value = set.record.value;
  const brief = resolveObservation(store, project, value.brief, `${field}.brief`);
  const frame = resolveFrame(store, project, value.frame, `${field}.frame`);
  const previous = value.previousSet === null ? null
    : resolvePrevious(store, project, value.previousSet, `${field}.previous`, seen);
  return { verification: set.verification, record: set.record, brief, frame, previous };
}

const body = (value: Omit<FrameInterpretationSubject, 'subject'> | FrameInterpretationSubject) => {
  const { subject: _subject, ...rest } = value as FrameInterpretationSubject;
  return rest;
};

/** Collect the complete resolved subject of one exact accepted frame: the frame
 * with its provenance, the verbatim mandate — which must be the draft's own
 * proven accepted brief — the resolved grounds, the previous structural set
 * with its own resolved sources, and the derived identity of the whole
 * subject. Read-only: no record is written and nothing is sent. */
export function collectFrameInterpretationSubject(store: Store, request: FrameSubjectRequest): FrameInterpretationSubject {
  if (!store || typeof store.get !== 'function') invalid('store', 'An exact record reader is required');
  const req = checkRequest(request);
  const frame = resolveFrame(store, req.project, req.frame, 'frame');
  const mandate = resolveObservation(store, req.project, req.mandate, 'mandate');
  const brief = provenBrief(store, req.project, frame);
  if (brief === null)
    missing('mandate', 'The frame\'s own draft has no proven accepted brief', req.mandate.source);
  if (!same({ source: brief.source, selector: brief.selector }, req.mandate)
    || !same(brief.value, mandate.observation.value))
    mismatch('mandate', 'The verbatim mandate is not the accepted brief of the frame\'s own draft', req.mandate.source);
  const previous = req.previousSet ? resolvePrevious(store, req.project, req.previousSet, 'previous', new Set()) : null;
  const value: FrameInterpretationSubject = { contract: FRAME_SUBJECT_CONTRACT, subject: '',
    project: req.project, frame, mandate, previous };
  value.subject = hashJson(body(value) as never);
  return JSON.parse(canonical(value as never)) as FrameInterpretationSubject;
}

/** The closed form of a presented subject package. An absent field, an extra
 * one (a selected, paid or owner mark is never part of the subject), a
 * malformed record or a truncated structure is refused at its field. */
export function decodeFrameInterpretationSubject(value: unknown): FrameInterpretationSubject {
  shape(value, ['contract', 'subject', 'project', 'frame', 'mandate', 'previous'], 'package');
  if (value.contract !== FRAME_SUBJECT_CONTRACT)
    invalid('package.contract', `Only ${FRAME_SUBJECT_CONTRACT} is a known subject form`);
  if (typeof value.subject !== 'string' || !HASH.test(value.subject))
    invalid('package.subject', 'The derived subject identity is a sha256 hex');
  text(value.project, 'package.project');
  const revision = (row: unknown, at: string) => {
    shape(row, ['id', 'kind', 'revision', 'hash', 'value'], at);
    if (typeof row.id !== 'string' || !row.id || typeof row.kind !== 'string' || !row.kind
      || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
      || typeof row.hash !== 'string' || !HASH.test(row.hash)) invalid(at, 'Expected an exact saved revision');
    if (hashJson(row.value as never) !== row.hash)
      invalid(at, 'The presented revision content does not match its saved hash');
  };
  const resolved = (item: unknown, at: string) => {
    shape(item, ['source', 'observation'], at);
    revision(item.source, `${at}.source`);
    const observation = item.observation;
    shape(observation, ['projectId', 'source', 'selector', 'value'], `${at}.observation`);
    text(observation.projectId, `${at}.observation.projectId`);
    ref(observation.source, `${at}.observation.source`);
    selectorForm(observation.selector, `${at}.observation.selector`);
  };
  const frame = (item: unknown, at: string) => {
    shape(item, ['record', 'question', 'draft', 'acceptance', 'assessment', 'binding', 'inputs', 'grounds'], at);
    for (const key of ['record', 'question', 'draft', 'acceptance'] as const)
      revision(item[key], `${at}.${key}`);
    if (item.assessment !== null) revision(item.assessment, `${at}.assessment`);
    if (item.binding !== null) revision(item.binding, `${at}.binding`);
    if (!Array.isArray(item.inputs)) invalid(`${at}.inputs`, 'Expected the resolved draft inputs');
    item.inputs.forEach((input, i) => revision(input, `${at}.inputs.${i}`));
    if (!Array.isArray(item.grounds)) invalid(`${at}.grounds`, 'Expected the resolved grounds');
    item.grounds.forEach((ground, i) => resolved(ground, `${at}.grounds.${i}`));
  };
  const previous = (item: unknown, at: string) => {
    shape(item, ['verification', 'record', 'brief', 'frame', 'previous'], at);
    if (item.verification !== 'structural')
      invalid(`${at}.verification`, 'A previous set is resolved structural-only');
    revision(item.record, `${at}.record`);
    resolved(item.brief, `${at}.brief`);
    frame(item.frame, `${at}.frame`);
    if (item.previous !== null) previous(item.previous, `${at}.previous`);
  };
  frame(value.frame, 'package.frame');
  resolved(value.mandate, 'package.mandate');
  if (value.previous !== null) previous(value.previous, 'package.previous');
  return structuredClone(value) as unknown as FrameInterpretationSubject;
}

/** Re-verify a presented subject package against the saved sources: the
 * package is decoded closed, its request linkage and derived identity are
 * checked, the subject is collected again from the exact saved material and
 * the two are compared field by field. What is delivered is the freshly
 * proven package — never the presented object. */
export function checkFrameInterpretationSubject(store: Store, request: FrameSubjectRequest,
  presented: unknown): FrameInterpretationSubject {
  const decoded = decodeFrameInterpretationSubject(presented);
  const req = checkRequest(request);
  if (decoded.project !== req.project) mismatch('project', 'The package is of another project');
  if (!same(reference(decoded.frame.record), req.frame))
    mismatch('frame', 'The package names another frame proposal', req.frame);
  if (!same({ source: decoded.mandate.observation.source, selector: decoded.mandate.observation.selector },
    { source: req.mandate.source, selector: req.mandate.selector }))
    mismatch('mandate', 'The package names another verbatim mandate', req.mandate.source);
  const named = decoded.previous === null ? null : reference(decoded.previous.record);
  if (!same(named, req.previousSet ?? null))
    mismatch('previous', 'The package names another previous set', req.previousSet ?? undefined);
  if (decoded.subject !== hashJson(body(decoded) as never))
    mismatch('subject', 'The derived identity does not cover the package');
  const proven = collectFrameInterpretationSubject(store, req);
  for (const field of ['contract', 'project', 'frame', 'mandate', 'previous', 'subject'] as const)
    if (!same(decoded[field], proven[field]))
      mismatch(field, 'The presented package does not match the proven subject');
  return proven;
}

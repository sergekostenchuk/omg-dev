import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { Store, Revision } from '../storage/store.js';
import type { Selector, Source } from '../evidence/evidence.js';
import { resolveClaimAddress, type ClaimAddress } from './claim-address.js';
import { readResearchConsumerTurn } from './response-recovery.js';

/** M2 is a structural, historical reader. A proves the paid assessor; P checks the
 * semantics against the plan before accepting claims. A reference or a search is
 * not evidence that a claim is true. None of these annotations enters contentKey. */
export const ASSESSMENT_METHODOLOGY_CONTRACT = 'assessment-methodology/v1' as const;
export const ASSESSMENT_METHODOLOGY_POLICY = 'assessment-methodology-policy/v1' as const;
export interface MethodEvidence { source: Ref; selector: Selector }
export type MethodKnowledge = { status: 'known'; value: string; evidence: MethodEvidence[] }
  | { status: 'unknown'; reason: string };
export interface MethodSource {
  source: Ref;
  role: 'primary' | 'secondary';
  reason: string;
  evidence: MethodEvidence[];
  /** The saved original Source, shared by retellings/mirrors of that original.
   * The semantic attribution is the assessor's; known identical origins cannot
   * be asserted independent. An unavailable original stays null with a reason.
   * A/P must also judge undeclared dependencies. */
  original: Ref | null;
  originalReason: string;
  limitation: string | null;
  publicationDate: MethodKnowledge;
  eventDate: MethodKnowledge;
  version: MethodKnowledge;
  /** Derived from the web capture's fetchedAt, never publication/event time. */
  retrievedAt: string | null;
}
export interface FactMethodology {
  claim: ClaimAddress;
  significance: { kind: 'blocking' | 'material' | 'supporting'; reason: string };
  sources: MethodSource[];
  temporalApplicability: { status: 'established' | 'limited' | 'unknown'; scope: string;
    reason: string; evidence: MethodEvidence[] };
  corroboration: { status: 'independent'; sources: Ref[]; reason: string }
    | { status: 'single_confirmation'; reason: string; limitation: string };
  refutation: { status: 'performed' | 'not_performed' | 'unavailable'; reason: string;
    traces: { turn: Ref; capture: Ref }[]; counterarguments: MethodEvidence[]; limitations: string[] };
}
export interface AssessmentMethodology {
  contract: typeof ASSESSMENT_METHODOLOGY_CONTRACT;
  policy: typeof ASSESSMENT_METHODOLOGY_POLICY;
  facts: FactMethodology[];
}
export interface MethodologySubject {
  project: string; planAnswer: Ref; planQuestionId: string; blocking: boolean;
  accepted: readonly ClaimAddress[];
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && canonical(a) === canonical(b);
function invalid(field: string, reason: string): never {
  throw new EngineError('discovery_novelty_invalid', `[${field}] ${reason}`, { field, reason });
}
function shape(v: unknown, fields: readonly string[], at: string): asserts v is Record<string, unknown> {
  if (!obj(v) || Object.keys(v).length !== fields.length || !fields.every(k => Object.hasOwn(v, k)))
    invalid(at, 'The methodology needs exactly its contracted fields');
}
function words(v: unknown, at: string): asserts v is string {
  if (!text(v)) invalid(at, 'A nonempty reason or value is required');
}
interface SourceReads { store: Store; project: string; sources: Map<string, Revision<Source>> }
function sourceAt(reads: SourceReads, ref: unknown, at: string): Revision<Source> {
  if (!isRef(ref)) invalid(at, 'An exact Source Ref is required');
  const key = canonical(ref), cached = reads.sources.get(key);
  if (cached) return cached;
  const row = reads.store.get<Source>(ref.id, ref.revision);
  if (!row || row.kind !== 'source' || row.hash !== ref.hash || !obj(row.value)
    || hashJson(row.value) !== row.hash || row.value.projectId !== reads.project
    || typeof row.value.content !== 'string' || digest(row.value.content) !== row.value.sha256)
    invalid(at, 'The exact Source bytes are absent, changed or foreign');
  const origin: unknown = row.value.origin;
  if (!obj(origin) || !['file','owner-document','web'].includes(String(origin.kind))
    || typeof origin.location !== 'string') invalid(at, 'The Source origin is malformed');
  if (origin.kind === 'web' && (!isRef(origin.capture)
    || !text(origin.fetchedAt) || !Number.isFinite(Date.parse(origin.fetchedAt))
    || !text(origin.finalUrl))) invalid(at, 'The web Source lost its capture or retrieval metadata');
  reads.sources.set(key, row);
  return row;
}
/** Exact historical selection; deliberately does not call Evidence.observe,
 * which admits new observations against CURRENT source/file heads. */
function evidence(reads: SourceReads, value: unknown, at: string): Json {
  shape(value, ['source', 'selector'], at);
  const src = sourceAt(reads, value.source, `${at}.source`), sel = value.selector;
  if (!obj(sel)) invalid(`${at}.selector`, 'An exact selector is required');
  if (sel.kind === 'text-range') {
    shape(sel, ['kind', 'start', 'end'], `${at}.selector`);
    if (!Number.isSafeInteger(sel.start) || !Number.isSafeInteger(sel.end)
      || (sel.start as number) < 0 || (sel.end as number) <= (sel.start as number)
      || (sel.end as number) > src.value.content.length) invalid(`${at}.selector`, 'Invalid source range');
    return src.value.content.slice(sel.start as number, sel.end as number);
  }
  shape(sel, ['kind', 'pointer'], `${at}.selector`);
  if (sel.kind !== 'json-pointer' || typeof sel.pointer !== 'string'
    || (sel.pointer !== '' && !sel.pointer.startsWith('/')) || /~(?![01])/.test(sel.pointer)
    || src.value.mediaType !== 'application/json') invalid(`${at}.selector`, 'Invalid JSON source pointer');
  let selected: unknown;
  try { selected = JSON.parse(src.value.content); } catch { invalid(at, 'The saved JSON Source is malformed'); }
  if (sel.pointer) for (const encoded of sel.pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key))
      invalid(`${at}.selector`, 'The selected source field is absent');
    selected = (selected as Record<string, unknown>)[key];
  }
  return selected as Json;
}
function evidences(reads: SourceReads, value: unknown, at: string, required: boolean): Json[] {
  if (!Array.isArray(value) || required && value.length === 0) invalid(at, 'Exact source evidence is required');
  const seen = new Set<string>();
  return value.map((item, i) => {
    const selected = evidence(reads, item, `${at}.${i}`), key = canonical(item);
    if (seen.has(key)) invalid(at, 'An evidence address appears twice');
    seen.add(key); return selected;
  });
}
function validDate(value: string): boolean {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(T.*)?)?)?$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]), month = Number(m[2] ?? 1), day = Number(m[3] ?? 1);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(y, month, 0)).getUTCDate()) return false;
  return !m[4] || /^T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(m[4]) && Number.isFinite(Date.parse(value));
}
function knowledge(reads: SourceReads, value: unknown, at: string, date: boolean) {
  if (!obj(value)) invalid(at, 'Known evidence or an explicit unknown reason is required');
  if (value.status === 'unknown') {
    shape(value, ['status', 'reason'], at); words(value.reason, `${at}.reason`); return;
  }
  shape(value, ['status', 'value', 'evidence'], at);
  if (value.status !== 'known') invalid(`${at}.status`, 'The status is known or unknown');
  words(value.value, `${at}.value`);
  if (date && !validDate(value.value))
    invalid(`${at}.value`, 'A date uses a stated ISO year, month, day or instant');
  const proofs = evidences(reads, value.evidence, `${at}.evidence`, true);
  // An exact selected value, not a loose substring of unrelated prose. The
  // model can use a narrower selector when a date/version occurs in text.
  if (!proofs.some(item => typeof item === 'string' && item.trim() === value.value
    || typeof item === 'number' && String(item) === value.value))
    invalid(`${at}.evidence`, 'The asserted date/version is not present in its selected Source bytes');
}
function identity(row: Revision<Source>): string[] {
  const origin = row.value.origin;
  const ids = [`record:${row.id}`, `content:${row.value.sha256}`];
  if (origin.kind === 'web') {
    let url: URL;
    try { url = new URL(origin.finalUrl); } catch { invalid('methodology.sources', 'The saved Source URL is malformed'); }
    url.hash = '';
    ids.push(`url:${url.href}`, `capture:${canonical(origin.capture)}`);
  } else ids.push(`origin:${origin.kind}:${origin.location}`);
  return ids;
}
function checkSources(reads: SourceReads, values: unknown, at: string) {
  if (!Array.isArray(values) || values.length === 0) invalid(at, 'Every fact lists its exact sources');
  const sources = new Map<string, { row: Revision<Source>; original: Revision<Source> | null }>();
  for (const [i, value] of values.entries()) {
    const p = `${at}.${i}`;
    shape(value, ['source','role','reason','evidence','original','originalReason','limitation','publicationDate','eventDate','version','retrievedAt'], p);
    const row = sourceAt(reads, value.source, `${p}.source`);
    const original = value.original === null ? null : sourceAt(reads, value.original, `${p}.original`);
    words(value.originalReason, `${p}.originalReason`);
    const key = canonical(value.source);
    if (sources.has(key)) invalid(`${p}.source`, 'A source appears twice');
    if (value.role !== 'primary' && value.role !== 'secondary') invalid(`${p}.role`, 'State primary or secondary');
    if (value.role === 'primary' && !same(value.source, value.original))
      invalid(`${p}.original`, 'A primary source names itself as its original');
    words(value.reason, `${p}.reason`);
    evidences(reads, value.evidence, `${p}.evidence`, true);
    if (!(value.evidence as MethodEvidence[]).some(item => same(item.source, value.source)))
      invalid(`${p}.evidence`, "The source description needs its own exact bytes");
    if (value.role === 'secondary') words(value.limitation, `${p}.limitation`);
    else if (value.limitation !== null && !text(value.limitation)) invalid(`${p}.limitation`, 'State a limitation or null');
    const fetched = row.value.origin.kind === 'web' ? row.value.origin.fetchedAt : null;
    if (value.retrievedAt !== fetched) invalid(`${p}.retrievedAt`, 'Retrieval time is exactly the capture time, separately from publication/event');
    knowledge(reads, value.publicationDate, `${p}.publicationDate`, true);
    knowledge(reads, value.eventDate, `${p}.eventDate`, true);
    knowledge(reads, value.version, `${p}.version`, false);
    sources.set(key, { row, original });
  }
  return sources;
}
function checkTrace(store: Store, subject: MethodologySubject, value: unknown, at: string, performed: boolean) {
  shape(value, ['turn', 'capture'], at);
  if (!isRef(value.turn) || !isRef(value.capture)) invalid(at, 'Search names its exact action and saved result');
  const turn = readResearchConsumerTurn(store, value.turn);
  const t = turn.value;
  const parent = isRef(t.plannedBy) ? readResearchConsumerTurn(store, t.plannedBy).value : t;
  if (t.status !== 'completed' || performed && t.error !== null || !['search', 'web_search'].includes(t.action?.action)
    || parent.contract !== 'research-consumer-turn/v1' || !obj(parent.subject)
    || !same(parent.subject.planAnswer, subject.planAnswer) || parent.subject.planQuestionId !== subject.planQuestionId)
    invalid(at, 'The trace must prove the completed search and this exact plan-question');
  // The proven web refusal puts its capture in details; successful searches
  // put it at the observation root. Both shapes come from the shared producer.
  const recordedCapture = t.observation?.capture ?? (t.error !== null ? t.observation?.details?.capture : undefined);
  const capture = store.get<Record<string, unknown>>(value.capture.id, value.capture.revision);
  if (!capture || capture.hash !== value.capture.hash || hashJson(capture.value) !== capture.hash
    || !obj(capture.value) || capture.value.projectId !== subject.project
    || !['research-search-capture', 'web-capture'].includes(capture.kind)
    || !same(recordedCapture, value.capture)) invalid(`${at}.capture`, 'The result is not the action\'s own saved search capture');
  const webSucceeded = obj(capture.value.response) && capture.value.response.kind === 'search'
    && ['ok', 'partial'].includes(t.observation?.outcome);
  if (performed && capture.kind === 'web-capture' && !webSucceeded)
    invalid(`${at}.capture`, 'A refused or unavailable web search is not a performed search');
  const localSucceeded = obj(capture.value.process) && capture.value.process.error === null
    && capture.value.process.signal === null && (capture.value.process.status === 0 || capture.value.process.status === 1);
  if (performed && capture.kind === 'research-search-capture' && !localSucceeded)
    invalid(at, 'An unavailable or interrupted repository search is not a performed search');
  if (!performed && t.error === null && (capture.kind === 'web-capture'
    ? webSucceeded : localSucceeded))
    invalid(at, 'A successful search cannot be described as unavailable');
}

export function checkAssessmentMethodology(store: Store, value: unknown, subject: MethodologySubject): AssessmentMethodology {
  const at = 'methodology';
  const reads: SourceReads = { store, project: subject.project, sources: new Map() };
  shape(value, ['contract', 'policy', 'facts'], at);
  if (value.contract !== ASSESSMENT_METHODOLOGY_CONTRACT || value.policy !== ASSESSMENT_METHODOLOGY_POLICY)
    invalid(at, 'An explicit supported methodology contract and policy are required');
  if (!Array.isArray(value.facts)) invalid(`${at}.facts`, 'The methodology lists its accepted facts');
  const expected = new Map<string, Record<string, unknown>>();
  for (const address of subject.accepted) {
    if (address.project !== subject.project) invalid(`${at}.facts`, 'An accepted address belongs to another project');
    const { claim } = resolveClaimAddress(store, address);
    if (obj(claim) && claim.kind === 'fact') expected.set(canonical(address), claim);
  }
  const seen = new Set<string>();
  for (const [index, row] of value.facts.entries()) {
    const p = `${at}.facts.${index}`;
    shape(row, ['claim','significance','sources','temporalApplicability','corroboration','refutation'], p);
    const key = canonical(row.claim), fact = expected.get(key);
    if (!fact || seen.has(key)) invalid(`${p}.claim`, 'Each accepted fact has exactly one methodology row; foreign/rejected claims are forbidden');
    seen.add(key);
    shape(row.significance, ['kind','reason'], `${p}.significance`);
    if (!['blocking','material','supporting'].includes(String(row.significance.kind))
      || subject.blocking && row.significance.kind !== 'blocking') invalid(`${p}.significance`, 'A blocking question cannot downgrade its fact significance');
    words(row.significance.reason, `${p}.significance.reason`);
    const sources = checkSources(reads, row.sources, `${p}.sources`);
    const basis = fact.basis;
    if (!obj(basis) || !obj(basis.source) || !sources.has(canonical(basis.source.ref)))
      invalid(`${p}.sources`, 'The fact\'s pinned Source must be included');
    const temporal = row.temporalApplicability;
    shape(temporal, ['status','scope','reason','evidence'], `${p}.temporalApplicability`);
    if (!['established','limited','unknown'].includes(String(temporal.status))) invalid(`${p}.temporalApplicability.status`, 'State temporal applicability explicitly');
    words(temporal.scope, `${p}.temporalApplicability.scope`); words(temporal.reason, `${p}.temporalApplicability.reason`);
    evidences(reads, temporal.evidence, `${p}.temporalApplicability.evidence`, temporal.status === 'established');
    const corroboration = row.corroboration;
    if (!obj(corroboration)) invalid(`${p}.corroboration`, 'State independent confirmation or its explicit limitation');
    if (corroboration.status === 'single_confirmation') {
      shape(corroboration, ['status','reason','limitation'], `${p}.corroboration`);
      words(corroboration.limitation, `${p}.corroboration.limitation`);
    } else {
      shape(corroboration, ['status','sources','reason'], `${p}.corroboration`);
      if (corroboration.status !== 'independent' || !Array.isArray(corroboration.sources) || corroboration.sources.length < 2)
        invalid(`${p}.corroboration`, 'Independence needs at least two exact source bases');
      const identities = new Set<string>();
      for (const ref of corroboration.sources) {
        const item = sources.get(canonical(ref));
        if (!item) invalid(`${p}.corroboration.sources`, 'A confirmation names one of this fact\'s sources');
        if (!item.original) invalid(`${p}.corroboration.sources`, "An unknown original cannot prove independent confirmation");
        const ids = [...new Set([...identity(item.row), ...identity(item.original)])];
        if (ids.some(id => identities.has(id))) invalid(`${p}.corroboration.sources`, 'Mirrors, repeated captures or one original are not independent');
        ids.forEach(id => identities.add(id));
      }
      if (!corroboration.sources.some(ref => same(ref, basis.source && (basis.source as Record<string, unknown>).ref)))
        invalid(`${p}.corroboration.sources`, 'The independent comparison includes the fact\'s own source');
    }
    words(corroboration.reason, `${p}.corroboration.reason`);
    const refutation = row.refutation;
    shape(refutation, ['status','reason','traces','counterarguments','limitations'], `${p}.refutation`);
    if (!['performed','not_performed','unavailable'].includes(String(refutation.status))) invalid(`${p}.refutation.status`, 'Search has an explicit status, never a boolean');
    words(refutation.reason, `${p}.refutation.reason`);
    if (!Array.isArray(refutation.traces) || (refutation.status === 'performed' && refutation.traces.length === 0
      || refutation.status === 'not_performed' && refutation.traces.length !== 0))
      invalid(`${p}.refutation.traces`, 'A performed search needs a trace; not_performed has none');
    const traces = new Set<string>();
    refutation.traces.forEach((trace, i) => {
      checkTrace(store, subject, trace, `${p}.refutation.traces.${i}`, refutation.status === 'performed');
      const key = canonical(trace); if (traces.has(key)) invalid(`${p}.refutation.traces`, 'A trace appears twice'); traces.add(key);
    });
    evidences(reads, refutation.counterarguments, `${p}.refutation.counterarguments`, false);
    if (!Array.isArray(refutation.limitations) || !refutation.limitations.every(text))
      invalid(`${p}.refutation.limitations`, 'Search limitations are an explicit list of reasons');
  }
  if (seen.size !== expected.size) invalid(`${at}.facts`, 'Every accepted fact needs its methodology');
  return value as unknown as AssessmentMethodology;
}

/** P supplies the requirements proven against the plan. A structural limitation
 * never satisfies one: callers must keep the question open or prove unknown.
 * This helper does not decide the semantic requirements, accept or write. */
export function methodologyClosureGaps(fact: FactMethodology, requirements: {
  dated: boolean; versioned: boolean; independentConfirmation: boolean;
}): string[] {
  const gaps: string[] = [];
  const dated = fact.sources.some(s => s.publicationDate.status === 'known' || s.eventDate.status === 'known');
  if (requirements.dated && (!dated || fact.temporalApplicability.status !== 'established')) gaps.push('date_unproven');
  if (requirements.versioned && !fact.sources.some(s => s.version.status === 'known')) gaps.push('version_unproven');
  if (requirements.independentConfirmation && fact.corroboration.status !== 'independent') gaps.push('single_confirmation');
  return gaps;
}

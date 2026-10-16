import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { Store, type Revision } from "../storage/store.js";
import { digest, canonical, hashJson, type Json } from "../canonical.js";
import { buildSourceStructure, verifySourceStructure, type SourceStructure } from "./source-structure.js";
import { selectStructuredRead, requireNavigationStructure, STRUCTURED_READ_CONTRACT, type StructuredReadSelection } from './source-navigation.js';
import { EngineError, requireCondition } from "../errors.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { safeRelativePath } from "../graph/topology.js";

/** A received web page, kept as one immutable snapshot of its capture. HTTP success does not prove the extraction
 * complete and the digest does not prove the page true: completeness is reported as unknown. */
export interface WebSnapshotOrigin {
  kind: 'web'; location: string; requestedUrl: string; finalUrl: string; fetchedAt: string; status: number | null;
  capture: Ref; extraction: string; completeness: 'unknown'; truncated: { gateway: boolean; local: boolean };
}
export const WEB_DOCUMENT_CONTRACT = 'web-document/v2' as const;
export interface WebDocumentMethod { kind: string; version: string; [key: string]: Json }
export interface WebDocumentSignals { rawTruncated: boolean; cleanTruncated: boolean; completeness: 'unknown'; [key: string]: Json }
export interface WebDocument {
  requestedUrl: string; selectedUrl: string; finalUrl: string; fetchedAt: string; status: number | null;
  redirects: Json[]; attempts: Json[];
  raw: { encoding: 'base64'; data: string; mediaType: string; byteLength: number; sha256: string };
  clean: { text: string; mediaType: 'text/markdown'; utf16Length: number; sha256: string };
  method: WebDocumentMethod; signals: WebDocumentSignals;
}
export interface WebDocumentOrigin {
  kind: 'web'; documentContract: typeof WEB_DOCUMENT_CONTRACT; location: string;
  requestedUrl: string; selectedUrl: string; finalUrl: string; fetchedAt: string; status: number | null;
  capture: Ref; raw: { pointer: '/response/reply/raw'; sha256: string; byteLength: number; mediaType: string };
  method: WebDocumentMethod; extraction: string; completeness: 'unknown';
  truncated: { gateway: boolean; local: boolean };
}
export interface Source {
  provenance?: { kind: 'runtime-observation'; record: Ref };
  projectId: string; origin: { kind: "file" | "owner-document"; location: string } | WebSnapshotOrigin | WebDocumentOrigin;
  content: string; mediaType: "text/plain" | "application/json" | "text/markdown"; sha256: string;
  structure?: SourceStructure;
}
export const SOURCE_MAX_BYTES = 5_000_000;
export interface WebPage { requestedUrl: string; finalUrl: string; fetchedAt: string; status: number | null;
  text: string; extraction: string; truncated: boolean }
/** Pure: the snapshot write of one capture. Its id carries the capture, so fetching again makes a new snapshot. */
export function projectWebSource(projectId: string, capture: Ref, page: WebPage): { id: string; kind: 'source'; value: Source } {
  requireCondition(typeof projectId === 'string' && projectId.length > 0 && isRef(capture) && page
    && typeof page.text === 'string' && typeof page.requestedUrl === 'string' && typeof page.finalUrl === 'string'
    && typeof page.fetchedAt === 'string' && (page.status === null || Number.isSafeInteger(page.status))
    && typeof page.extraction === 'string' && typeof page.truncated === 'boolean',
    'source_invalid', 'A web snapshot needs its capture, URLs, time, status, extraction and text');
  let content = page.text;
  const local = Buffer.byteLength(content) > SOURCE_MAX_BYTES;
  if (local) content = Buffer.from(content, 'utf8').subarray(0, SOURCE_MAX_BYTES).toString('utf8').replace(/�+$/, '');
  return { id: `source:${projectId}:web:${capture.hash}`, kind: 'source', value: { projectId,
    origin: { kind: 'web', location: page.finalUrl, requestedUrl: page.requestedUrl, finalUrl: page.finalUrl,
      fetchedAt: page.fetchedAt, status: page.status, capture, extraction: page.extraction, completeness: 'unknown',
      truncated: { gateway: page.truncated, local } },
    content, mediaType: 'text/plain', sha256: digest(content) } };
}
const webUrl = (value: string): boolean => {
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:')
    && !url.username && !url.password && !!url.hostname; }
  catch { return false; }
};
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** A failed extraction may still carry selected bytes; those bytes require the same checksum proof. */
export function requireWebDocumentParts(rawValue: unknown, cleanValue: unknown, methodValue: unknown,
  signalsValue: unknown, complete: boolean): void {
  requireCondition(plainRecord(signalsValue) && typeof signalsValue.rawTruncated === 'boolean'
    && typeof signalsValue.cleanTruncated === 'boolean' && signalsValue.completeness === 'unknown',
    'web_gateway_response_invalid', 'A web document needs declared completeness and truncation signals');
  if (complete || rawValue !== null) {
    const raw = rawValue as WebDocument['raw'];
    requireCondition(plainRecord(raw) && raw.encoding === 'base64' && typeof raw.data === 'string'
      && typeof raw.mediaType === 'string' && !!raw.mediaType
      && Number.isSafeInteger(raw.byteLength) && raw.byteLength >= (complete ? 1 : 0)
      && typeof raw.sha256 === 'string',
      'web_gateway_response_invalid', 'The selected raw bytes need encoding, media, length and SHA-256');
    const bytes = Buffer.from(raw.data, 'base64');
    requireCondition(bytes.toString('base64') === raw.data && bytes.length === raw.byteLength && digest(bytes) === raw.sha256,
      'web_gateway_response_invalid', 'The web raw bytes do not match their declared length and SHA-256');
  }
  if (complete || cleanValue !== null) {
    const clean = cleanValue as WebDocument['clean'];
    requireCondition(plainRecord(clean) && clean.mediaType === 'text/markdown'
      && typeof clean.text === 'string' && (!complete || !!clean.text.trim())
      && Number.isSafeInteger(clean.utf16Length) && typeof clean.sha256 === 'string'
      && clean.text.length === clean.utf16Length && digest(clean.text) === clean.sha256,
      'web_gateway_response_invalid', 'The clean Markdown does not match its declared UTF-16 length and SHA-256');
  }
  if (complete || methodValue !== null) {
    const method = methodValue as WebDocumentMethod;
    requireCondition(plainRecord(method) && typeof method.kind === 'string' && !!method.kind
      && typeof method.version === 'string' && !!method.version,
      'web_gateway_response_invalid', 'The extraction method needs its kind and version');
  }
  canonical({ method: methodValue, signals: signalsValue });
}

/** Validate the untrusted gateway representation before it becomes an immutable capture. */
export function requireWebDocument(value: unknown): asserts value is WebDocument {
  const page = value as WebDocument;
  requireCondition(plainRecord(page) && webUrl(page.requestedUrl) && webUrl(page.selectedUrl) && webUrl(page.finalUrl)
    && typeof page.fetchedAt === 'string' && !!page.fetchedAt
    && (page.status === null || Number.isSafeInteger(page.status))
    && Array.isArray(page.redirects) && Array.isArray(page.attempts),
    'web_gateway_response_invalid', 'A web document needs exact raw, clean, method, URLs and truncation provenance');
  requireWebDocumentParts(page.raw, page.clean, page.method, page.signals, true);
  canonical({ redirects: page.redirects, attempts: page.attempts, method: page.method, signals: page.signals });
}

/** The gateway envelope is evidence of received bytes; the Source is the final, locally bounded clean text. */
export function projectWebDocumentSource(projectId: string, capture: Ref, page: WebDocument):
  { id: string; kind: 'source'; value: Source } {
  requireCondition(typeof projectId === 'string' && !!projectId && isRef(capture),
    'source_invalid', 'A web document needs this project and exact capture');
  requireWebDocument(page);
  const raw = page.raw;
  let content = page.clean.text, local = false;
  if (Buffer.byteLength(content, 'utf8') > SOURCE_MAX_BYTES) {
    local = true;
    let end = 0, bytesUsed = 0;
    for (const character of content) {
      const size = Buffer.byteLength(character, 'utf8');
      if (bytesUsed + size > SOURCE_MAX_BYTES) break;
      bytesUsed += size; end += character.length;
    }
    content = content.slice(0, end);
  }
  const structure = buildSourceStructure(content);
  return { id: `source:${projectId}:web:${capture.hash}`, kind: 'source', value: { projectId,
    origin: { kind: 'web', documentContract: WEB_DOCUMENT_CONTRACT, location: page.finalUrl,
      requestedUrl: page.requestedUrl, selectedUrl: page.selectedUrl, finalUrl: page.finalUrl,
      fetchedAt: page.fetchedAt, status: page.status, capture,
      raw: { pointer: '/response/reply/raw', sha256: raw.sha256, byteLength: raw.byteLength, mediaType: raw.mediaType },
      method: page.method, extraction: page.method.kind, completeness: 'unknown',
      truncated: { gateway: page.signals.cleanTruncated, local } },
    content, mediaType: 'text/markdown', sha256: digest(content), structure } };
}

export type Selector = { kind: "json-pointer"; pointer: string } | { kind: "text-range"; start: number; end: number };
export interface Observation { projectId: string; source: Ref; selector: Selector; value: Json }
export const SOURCE_READ_CONTRACT = 'source-read/v1' as const;
export const SOURCE_READ_CONTRACT_V2 = 'source-read/v2' as const;
export const SOURCE_READ_CONTRACT_V3 = STRUCTURED_READ_CONTRACT;
export const SOURCE_READ_MAX_CHARS = 50_000;
const SOURCE_READ_V1_MAX_CHARS = 50_000;
export type SourceReadContract = typeof SOURCE_READ_CONTRACT | typeof SOURCE_READ_CONTRACT_V2 | typeof SOURCE_READ_CONTRACT_V3;
/** New operations select their policy from the declared Source era, never from a missing index. */
export function sourceReadContract(value: Source, source?: Ref): SourceReadContract {
  if (Object.hasOwn(value, 'structure') || (value.origin.kind === 'web' && 'documentContract' in value.origin)) {
    try { requireNavigationStructure(value.content, value.structure!); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'source_structure_invalid')
        throw new EngineError(error.code, error.message, { source: source ?? null });
      throw error;
    }
    return SOURCE_READ_CONTRACT_V3;
  }
  return SOURCE_READ_CONTRACT_V2;
}
export interface SourceReadRange {
  contract: SourceReadContract; outcome: 'complete' | 'clipped' | 'outside' | 'overview';
  requested: { start: number; end: number }; served: { start: number; end: number } | null;
  length: number; unit: 'utf16';
  selectionReason?: StructuredReadSelection['selectionReason']; expanded?: boolean;
  requestedCovered?: boolean; documentComplete?: boolean; paragraphSplit?: boolean;
  nextAction?: StructuredReadSelection['nextAction'];
}
export interface SourceReading extends SourceReadRange {
  projectId: string; source: Ref; selector: Selector | null; value: Json;
}
/** Request coordinates are not evidence coordinates. Only the served bytes may become a citation. */
export function sourceReadRange(length: number, requested: { start: number; end: number }): SourceReadRange {
  requireCondition(Number.isSafeInteger(length) && length >= 0 && requested
    && Number.isSafeInteger(requested.start) && Number.isSafeInteger(requested.end)
    && requested.start >= 0 && requested.end >= requested.start,
    'selector_invalid', 'A source read needs ordered nonnegative UTF-16 coordinates');
  const common = { contract: SOURCE_READ_CONTRACT, requested: { start: requested.start, end: requested.end },
    length, unit: 'utf16' as const };
  if (requested.start >= length) return { ...common, outcome: 'outside', served: null };
  const end = Math.min(requested.end, length);
  return { ...common, outcome: end < requested.end ? 'clipped' : 'complete', served: { start: requested.start, end } };
}
/** A new local reading keeps the original request and bounds only the text actually served. */
export function sourceReadRangeV2(length: number, requested: { start: number; end: number }): SourceReadRange {
  requireCondition(Number.isSafeInteger(length) && length >= 0 && requested
    && Number.isSafeInteger(requested.start) && Number.isSafeInteger(requested.end)
    && requested.start >= 0 && requested.end >= requested.start,
    'selector_invalid', 'A source read needs ordered nonnegative UTF-16 coordinates');
  const common = { contract: SOURCE_READ_CONTRACT_V2, requested: { start: requested.start, end: requested.end },
    length, unit: 'utf16' as const };
  if (requested.start >= length) return { ...common, outcome: 'outside', served: null };
  // The three differences are safe integers; adding their minimum cannot exceed length.
  const end = requested.start + Math.min(requested.end - requested.start,
    length - requested.start, SOURCE_READ_MAX_CHARS);
  return { ...common, outcome: end < requested.end ? 'clipped' : 'complete', served: { start: requested.start, end } };
}
export function projectSourceReading(projectId: string, source: Ref, value: Source,
  requested: { start: number; end: number }, contract: SourceReadContract = SOURCE_READ_CONTRACT): SourceReading {
  requireCondition(isRef(source) && source.id.startsWith(`source:${projectId}:`)
    && value?.projectId === projectId && typeof value.content === 'string'
    && digest(value.content) === value.sha256 && hashJson(value) === source.hash, 'source_invalid', 'The read needs exact source content from this project');
  requireCondition(requested && requested.end > requested.start, 'selector_invalid', 'A source read needs a nonempty requested range');
  requireCondition(contract === SOURCE_READ_CONTRACT || contract === SOURCE_READ_CONTRACT_V2
    || contract === SOURCE_READ_CONTRACT_V3,
    'research_consumer_intent_invalid', 'Unknown source read contract');
  if (contract === SOURCE_READ_CONTRACT_V3) {
    requireCondition(sourceReadContract(value, source) === SOURCE_READ_CONTRACT_V3, 'source_structure_invalid', 'A v3 read needs its declared Source index');
  }
  const range = contract === SOURCE_READ_CONTRACT_V3
    ? { contract, ...selectStructuredRead(value.content, value.structure!, requested) }
    : contract === SOURCE_READ_CONTRACT_V2
      ? sourceReadRangeV2(value.content.length, requested) : sourceReadRange(value.content.length, requested);
  if (contract === SOURCE_READ_CONTRACT) requireCondition(!range.served
    || range.served.end - range.served.start <= SOURCE_READ_V1_MAX_CHARS,
    'research_excerpt_limit', 'Read a smaller source range');
  return { ...range, projectId, source,
    selector: range.served ? { kind: 'text-range', ...range.served } : null,
    value: range.served ? value.content.slice(range.served.start, range.served.end)
      : range.outcome === 'overview' ? JSON.parse(canonical({ length: value.content.length, structureHash: value.structure!.structureHash,
        toc: value.structure!.sections.map(section => ({ id: section.id, level: section.level,
          title: section.title, parentId: section.parentId, headingRange: section.headingRange,
          bodyRange: section.bodyRange })), nextAction: range.nextAction })) as Json : null };
}
/** The captured digest was computed from the captured content when the source was written; only the file on disk is new.
 * A web snapshot is its saved text: citing it never goes back to the network. */
export function sourceIsCurrent(source: Source): boolean {
  try {
    return source.origin.kind === "owner-document"
      || source.origin.kind === "web" && (!('documentContract' in source.origin)
        || source.origin.documentContract === WEB_DOCUMENT_CONTRACT
          && source.mediaType === 'text/markdown' && digest(source.content) === source.sha256
          && !!source.structure
          && verifySourceStructure(source.content, source.structure))
      || source.origin.kind === "file" && realpathSync(source.origin.location) === source.origin.location
        && digest(readFileSync(source.origin.location)) === source.sha256;
  } catch { return false; }
}

/** One shared admission check for saved Markdown web documents across documentary consumers. */
export function isWebDocumentSource(value: unknown): value is Source {
  if (!plainRecord(value) || value.mediaType !== 'text/markdown' || typeof value.content !== 'string'
    || typeof value.sha256 !== 'string' || digest(value.content) !== value.sha256
    || !plainRecord(value.origin) || value.origin.kind !== 'web'
    || value.origin.documentContract !== WEB_DOCUMENT_CONTRACT
    || !isRef(value.origin.capture) || !plainRecord(value.origin.raw)
    || value.origin.raw.pointer !== '/response/reply/raw'
    || !/^[a-f0-9]{64}$/.test(String(value.origin.raw.sha256))
    || !Number.isSafeInteger(value.origin.raw.byteLength) || Number(value.origin.raw.byteLength) < 1
    || typeof value.origin.raw.mediaType !== 'string' || !value.origin.raw.mediaType
    || !plainRecord(value.origin.method) || typeof value.origin.method.kind !== 'string'
    || typeof value.origin.method.version !== 'string' || !value.structure) return false;
  return sourceIsCurrent(value as unknown as Source);
}

export class Evidence {
  constructor(private readonly store: Store) {}
  document(projectId: string, id: string, content: string, mediaType: Source['mediaType'], expected: number): Revision<Source> {
    requireCondition(typeof content === "string" && Buffer.byteLength(content) <= 5_000_000,
      "source_invalid", "Source text exceeds the size limit");
    requireCondition(mediaType === "text/plain" || mediaType === "application/json", "source_invalid", "Unsupported source media type");
    if (mediaType === "application/json") canonical(JSON.parse(content));
    return this.store.write<Source>({ id: `source:${projectId}:${id}`, kind: "source", expected,
      value: { projectId, origin: { kind: "owner-document", location: id }, content, mediaType, sha256: digest(content) } });
  }
  file(projectId: string, id: string, root: string, path: string, mediaType: Source['mediaType'], expected: number): Revision<Source> {
    requireCondition(safeRelativePath(path), "source_path_invalid", "Source path must be relative to the selected folder");
    const base = realpathSync(root); const target = realpathSync(resolve(base, path));
    const within = relative(base, target);
    requireCondition(within !== ".." && !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(within), "source_path_invalid", "Source escapes the selected folder");
    requireCondition(statSync(target).isFile() && statSync(target).size <= 5_000_000, "source_invalid", "Source must be a bounded regular file");
    const content = readFileSync(target, "utf8");
    requireCondition(mediaType === "text/plain" || mediaType === "application/json", "source_invalid", "Unsupported source media type");
    if (mediaType === "application/json") canonical(JSON.parse(content));
    return this.store.write<Source>({ id: `source:${projectId}:${id}`, kind: "source", expected,
      value: { projectId, origin: { kind: "file", location: target }, content, mediaType, sha256: digest(content) } });
  }
  observe(projectId: string, sourceRef: Ref, selector: Selector): Observation {
    requireCondition(isRef(sourceRef) && selector && typeof selector === "object", "evidence_input_invalid", "Evidence needs a versioned source reference and selector");
    const source = this.store.get<Source>(sourceRef.id);
    requireCondition(source && source.kind === "source" && source.value.projectId === projectId,
      "source_missing", "A real source from this project is required");
    requireCondition(source.revision === sourceRef.revision && source.hash === sourceRef.hash,
      "source_stale", "Evidence must reference the current source version");
    requireCondition(sourceIsCurrent(source.value), "source_stale", "The captured source file has changed or disappeared");
    let value: unknown;
    if (selector.kind === "json-pointer") {
      requireCondition(source.value.mediaType === "application/json", "selector_invalid", "JSON selection requires a JSON source");
      value = JSON.parse(source.value.content);
      requireCondition(typeof selector.pointer === "string" && (selector.pointer === "" || selector.pointer.startsWith("/")), "selector_invalid", "Invalid JSON pointer");
      if (selector.pointer) for (const encoded of selector.pointer.slice(1).split("/")) {
        requireCondition(!/~(?![01])/.test(encoded), "selector_invalid", "Invalid JSON pointer escape");
        const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        requireCondition(value !== null && typeof value === "object" && Object.hasOwn(value, key), "evidence_missing", "Selected field does not exist in the source");
        value = (value as Record<string, unknown>)[key];
      }
    } else {
      requireCondition(selector.kind === "text-range" && Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)
        && selector.start >= 0 && selector.end > selector.start && selector.end <= source.value.content.length,
      "selector_invalid", "Text evidence needs a valid nonempty range");
      value = source.value.content.slice(selector.start, selector.end);
    }
    return { projectId, source: reference(source), selector, value: JSON.parse(canonical(value)) as Json };
  }
  readSource(projectId: string, sourceRef: Ref, requested: { start: number; end: number },
    contract: SourceReadContract = SOURCE_READ_CONTRACT): SourceReading {
    requireCondition(isRef(sourceRef), 'evidence_input_invalid', 'A read needs an exact source reference');
    const source = this.store.get<Source>(sourceRef.id);
    requireCondition(source?.kind === 'source' && source.value.projectId === projectId,
      'source_missing', 'A real source from this project is required');
    requireCondition(canonical(reference(source)) === canonical(sourceRef) && sourceIsCurrent(source.value),
      'source_stale', 'The requested source has changed or disappeared');
    return projectSourceReading(projectId, sourceRef, source.value, requested, contract);
  }
  verifyReading(reading: unknown): boolean {
    try {
      if (!reading || typeof reading !== 'object') return false;
      if (!Object.hasOwn(reading, 'contract')) return this.verify(reading as Observation);
      const value = reading as SourceReading;
      return (value.contract === SOURCE_READ_CONTRACT || value.contract === SOURCE_READ_CONTRACT_V2
        || value.contract === SOURCE_READ_CONTRACT_V3)
        && canonical(this.readSource(value.projectId, value.source, value.requested, value.contract)) === canonical(value);
    } catch { return false; }
  }
  verify(observation: Observation): boolean {
    try { return canonical(this.observe(observation.projectId, observation.source, observation.selector)) === canonical(observation); }
    catch { return false; }
  }
}

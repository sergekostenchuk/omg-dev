import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { Store, type Revision } from "../storage/store.js";
import { digest, canonical, hashJson, type Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { safeRelativePath } from "../graph/topology.js";

/** A received web page, kept as one immutable snapshot of its capture. HTTP success does not prove the extraction
 * complete and the digest does not prove the page true: completeness is reported as unknown. */
export interface WebSnapshotOrigin {
  kind: 'web'; location: string; requestedUrl: string; finalUrl: string; fetchedAt: string; status: number | null;
  capture: Ref; extraction: string; completeness: 'unknown'; truncated: { gateway: boolean; local: boolean };
}
export interface Source {
  provenance?: { kind: 'runtime-observation'; record: Ref };
  projectId: string; origin: { kind: "file" | "owner-document"; location: string } | WebSnapshotOrigin;
  content: string; mediaType: "text/plain" | "application/json"; sha256: string;
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
export type Selector = { kind: "json-pointer"; pointer: string } | { kind: "text-range"; start: number; end: number };
export interface Observation { projectId: string; source: Ref; selector: Selector; value: Json }
export const SOURCE_READ_CONTRACT = 'source-read/v1' as const;
export const SOURCE_READ_CONTRACT_V2 = 'source-read/v2' as const;
export const SOURCE_READ_MAX_CHARS = 50_000;
const SOURCE_READ_V1_MAX_CHARS = 50_000;
export type SourceReadContract = typeof SOURCE_READ_CONTRACT | typeof SOURCE_READ_CONTRACT_V2;
export interface SourceReadRange {
  contract: SourceReadContract; outcome: 'complete' | 'clipped' | 'outside';
  requested: { start: number; end: number }; served: { start: number; end: number } | null;
  length: number; unit: 'utf16';
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
  requireCondition(contract === SOURCE_READ_CONTRACT || contract === SOURCE_READ_CONTRACT_V2,
    'research_consumer_intent_invalid', 'Unknown source read contract');
  const range = contract === SOURCE_READ_CONTRACT_V2
    ? sourceReadRangeV2(value.content.length, requested) : sourceReadRange(value.content.length, requested);
  if (contract === SOURCE_READ_CONTRACT) requireCondition(!range.served
    || range.served.end - range.served.start <= SOURCE_READ_V1_MAX_CHARS,
    'research_excerpt_limit', 'Read a smaller source range');
  return { ...range, projectId, source,
    selector: range.served ? { kind: 'text-range', ...range.served } : null,
    value: range.served ? value.content.slice(range.served.start, range.served.end) : null };
}
/** The captured digest was computed from the captured content when the source was written; only the file on disk is new.
 * A web snapshot is its saved text: citing it never goes back to the network. */
export function sourceIsCurrent(source: Source): boolean {
  try {
    return source.origin.kind === "owner-document" || source.origin.kind === "web" || (source.origin.kind === "file"
      && realpathSync(source.origin.location) === source.origin.location
      && digest(readFileSync(source.origin.location)) === source.sha256);
  } catch { return false; }
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
      return (value.contract === SOURCE_READ_CONTRACT || value.contract === SOURCE_READ_CONTRACT_V2)
        && canonical(this.readSource(value.projectId, value.source, value.requested, value.contract)) === canonical(value);
    } catch { return false; }
  }
  verify(observation: Observation): boolean {
    try { return canonical(this.observe(observation.projectId, observation.source, observation.selector)) === canonical(observation); }
    catch { return false; }
  }
}

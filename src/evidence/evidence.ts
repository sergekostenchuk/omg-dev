import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { Store, type Revision } from "../storage/store.js";
import { digest, canonical, type Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { safeRelativePath } from "../graph/topology.js";

export interface Source {
  projectId: string; origin: { kind: "file" | "owner-document"; location: string };
  content: string; mediaType: "text/plain" | "application/json"; sha256: string;
}
export type Selector = { kind: "json-pointer"; pointer: string } | { kind: "text-range"; start: number; end: number };
export interface Observation { projectId: string; source: Ref; selector: Selector; value: Json }

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
    requireCondition(digest(source.value.content) === source.value.sha256, "source_corrupt", "Source checksum mismatch");
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
  verify(observation: Observation): boolean {
    try { return canonical(this.observe(observation.projectId, observation.source, observation.selector)) === canonical(observation); }
    catch { return false; }
  }
}

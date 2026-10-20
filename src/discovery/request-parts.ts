import type { Store, Revision, Write } from "../storage/store.js";
import { isRef, reference, uniqueRefs, type Ref } from "../pipeline/contracts.js";
import { canonical, digest, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import type { V7PlanSubject } from "./v7-managed-attempt.js";

export const REQUEST_MANIFEST_CONTRACT = "request-manifest/v1" as const;
export const REQUEST_PART_CONTRACT = "request-part/v1" as const;
export const REQUEST_MANIFEST_KIND = "request-manifest" as const;
export const REQUEST_PART_KIND = "request-part" as const;

/* DRS1a2 (пул G, codex-omg №6057/№6196/№7487): the compact storage forms of an
 * analyst call. Both keep their large body once as project-scoped request
 * parts (the DRS1a primitive below); the saved record and the restored body are
 * different representations, and the contract is checked before either. */
export const CONTEXT_PREPARATION_CONTRACT = "context-preparation/v1" as const;
export const CONTEXT_PREPARATION_KIND = "context-preparation" as const;
export const ARCHIVE_PARTS_CONTRACT = "archive-parts/v1" as const;

export interface RequestPart {
  contract: typeof REQUEST_PART_CONTRACT;
  projectId: string;
  hash: string;
  text: string;
  chars: number;
  bytes: number;
}

export interface RequestManifest {
  contract: typeof REQUEST_MANIFEST_CONTRACT;
  projectId: string;
  draftId: string;
  requestId: string;
  intent?: Ref;
  call?: Ref;
  parts: Ref[];
  chars: number;
  bytes: number;
  sha256: string;
  wire?: {
    chars: number;
    bytes: number;
    sha256: string;
  };
}

/** The immutable step a preparation belongs to: one analyst call of one
 * project/draft/Question/owner with its instruction and exact v7 subject
 * (planAnswer + planQuestionId; null on a field question). Two plan-questions
 * of one Question, or one id in two plan editions, are different bindings. */
export interface ContextPreparationBinding {
  projectId: string;
  draft: Ref;
  question: Ref;
  owner: Ref;
  kind: "analyst";
  instruction: string;
  subject: V7PlanSubject | null;
  earlyActions: string | null;
  graphBase: Ref | null;
}
export interface ContextPreparation extends ContextPreparationBinding {
  contract: typeof CONTEXT_PREPARATION_CONTRACT;
  contextSha256: string;
  contextChars: number;
  contextBytes: number;
  parts: Ref[];
}
const PREPARATION_FIELDS = ["contract", "projectId", "draft", "question", "owner", "kind", "instruction", "subject",
  "earlyActions", "graphBase", "contextSha256", "contextChars", "contextBytes", "parts"].sort().join(",");

/** The compact research-context archive: its body in parts, the same project/
 * draft/Question/subject metadata as the whole-body archive. */
export interface ArchivePartsValue {
  contract: typeof ARCHIVE_PARTS_CONTRACT;
  projectId: string;
  draft: Ref;
  question: Ref;
  subject?: V7PlanSubject;
  parts: Ref[];
  bodySha256: string;
  bodyChars: number;
  bodyBytes: number;
}

export interface ResearchEnvelopeFrame {
  protocol: string;
  requestId: string;
  mode: string;
  model: string;
  effort: string;
  speed?: string;
  prompt: string;
}

export interface PrepareStorePartsResult {
  writes: Write[];
  guards: Ref[];
  partRefs: Ref[];
  partCount: number;
  sharedPartCount: number;
  chars: number;
  bytes: number;
  sha256: string;
  text: string;
}

/**
 * Common primitive to write and deduplicate project-scoped request-part entities.
 * Existing parts in the store are validated and guarded; missing parts are emitted as writes.
 */
export function prepareStoreParts(
  store: Store,
  projectId: string,
  chunks: string[]
): PrepareStorePartsResult {
  const text = chunks.join("");
  const chars = text.length;
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = digest(text);

  const writes: Write[] = [];
  const guards: Ref[] = [];
  const partRefs: Ref[] = [];
  const pendingWrites = new Map<string, { write: Write; ref: Ref }>();
  let sharedPartCount = 0;

  for (const partText of chunks) {
    const textHash = digest(partText);
    const partId = requestPartId(projectId, partText);
    const existing = store.get<RequestPart>(partId);
    if (existing) {
      requireCondition(
        existing.kind === REQUEST_PART_KIND
        && existing.value !== null
        && existing.value.contract === REQUEST_PART_CONTRACT
        && existing.value.hash === textHash
        && existing.value.text === partText
        && existing.value.projectId === projectId
        && hashJson(existing.value) === existing.hash,
        "request_part_invalid",
        "Existing saved request part is invalid, corrupt or foreign"
      );
      guards.push(reference(existing));
      partRefs.push(reference(existing));
      sharedPartCount++;
    } else if (pendingWrites.has(partId)) {
      partRefs.push(pendingWrites.get(partId)!.ref);
    } else {
      const partValue: RequestPart = {
        contract: REQUEST_PART_CONTRACT,
        projectId,
        hash: textHash,
        text: partText,
        chars: partText.length,
        bytes: Buffer.byteLength(partText, "utf8"),
      };
      const write: Write = {
        id: partId,
        kind: REQUEST_PART_KIND,
        expected: 0,
        value: partValue,
      };
      const ref: Ref = {
        id: partId,
        revision: 1,
        hash: hashJson(partValue),
      };
      writes.push(write);
      partRefs.push(ref);
      pendingWrites.set(partId, { write, ref });
    }
  }

  return {
    writes,
    guards: uniqueRefs(guards),
    partRefs,
    partCount: chunks.length,
    sharedPartCount,
    chars,
    bytes,
    sha256,
    text,
  };
}

/**
 * Common primitive to restore and verify concatenated text from stored request-part refs.
 */
export function restoreTextFromParts(options: {
  store: Store;
  projectId: string;
  parts: Ref[];
  expectedSha256?: string;
  expectedChars?: number;
  expectedBytes?: number;
  errorCode?: string;
}): { text: string; partGuards: Ref[] } {
  const { store, projectId, parts, expectedSha256, expectedChars, expectedBytes, errorCode = "request_part_invalid" } = options;
  requireCondition(
    Array.isArray(parts) && parts.length > 0 && parts.every(isRef),
    errorCode,
    "Parts must be a non-empty array of valid refs"
  );

  const partsText: string[] = [];
  const partGuards: Ref[] = [];

  for (const partRef of parts) {
    const partRecord = store.get<RequestPart>(partRef.id, partRef.revision);
    requireCondition(
      partRecord !== null
      && partRecord.kind === REQUEST_PART_KIND
      && canonical(reference(partRecord)) === canonical(partRef)
      && partRecord.value !== null
      && partRecord.value.contract === REQUEST_PART_CONTRACT
      && hashJson(partRecord.value) === partRecord.hash
      && typeof partRecord.value.text === "string"
      && digest(partRecord.value.text) === partRecord.value.hash
      && partRecord.value.projectId === projectId
      && partRef.id === requestPartId(projectId, partRecord.value.text),
      errorCode,
      "A saved request part is missing, tampered, foreign or corrupt"
    );
    partsText.push(partRecord.value.text);
    partGuards.push(reference(partRecord));
  }

  const assembled = partsText.join("");
  if (expectedChars !== undefined) {
    requireCondition(assembled.length === expectedChars, errorCode, "Assembled part text length mismatch");
  }
  if (expectedBytes !== undefined) {
    requireCondition(Buffer.byteLength(assembled, "utf8") === expectedBytes, errorCode, "Assembled part text byte length mismatch");
  }
  if (expectedSha256 !== undefined) {
    requireCondition(digest(assembled) === expectedSha256, errorCode, "Assembled part text sha256 checksum mismatch");
  }

  return { text: assembled, partGuards };
}

/**
 * Deterministically partitions an arbitrary JSON object into content-addressed
 * chunks whose exact concatenation equals canonical JSON.stringify.
 */
export function partitionJsonObject(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [JSON.stringify(value)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    const chunks: string[] = ["["];
    for (let i = 0; i < value.length; i++) {
      const itemStr = JSON.stringify(value[i]) ?? "null";
      chunks.push((i === 0 ? "" : ",") + itemStr);
    }
    chunks.push("]");
    return chunks;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return ["{}"];
  const chunks: string[] = ["{"];
  let first = true;
  for (const k of keys) {
    const val = (value as Record<string, unknown>)[k];
    if (val === undefined || typeof val === "function" || typeof val === "symbol") continue;
    const prefix = first ? "" : ",";
    first = false;
    if (Array.isArray(val)) {
      if (val.length === 0) {
        chunks.push(`${prefix}${JSON.stringify(k)}:[]`);
      } else {
        chunks.push(`${prefix}${JSON.stringify(k)}:[`);
        for (let j = 0; j < val.length; j++) {
          const elemStr = JSON.stringify(val[j]) ?? "null";
          chunks.push((j === 0 ? "" : ",") + elemStr);
        }
        chunks.push("]");
      }
    } else {
      chunks.push(prefix + JSON.stringify(k) + ":" + JSON.stringify(val));
    }
  }
  chunks.push("}");
  return chunks;
}

/**
 * Computes the deterministic, project-scoped entity ID for a request part.
 * Incorporates the owning projectId into the ID and hash to ensure that
 * parts created by one project never collide or fail across multi-project
 * databases while preserving complete deduplication within the project.
 */
export function requestPartId(projectId: string, text: string): string {
  const hash = digest(`${projectId}:${text}`);
  return `request-part:${projectId}:${hash}`;
}

/**
 * Deterministically partitions the JSON wire of an envelope and subject into
 * seek-safe, content-addressed textual chunks whose exact concatenation equals
 * the full transmitted wire string produced by canonical JSON.stringify.
 *
 * Keys with undefined, function, or symbol values are omitted identically to
 * standard JSON.stringify({ ...envelope, subject }).
 */
export function partitionResearchWire(envelope: ResearchEnvelopeFrame, subject: unknown): string[] {
  const parts: string[] = [];

  // Part 0: Dynamic envelope invocation header containing the unique requestId
  const headerObj = {
    protocol: envelope.protocol,
    requestId: envelope.requestId,
    mode: envelope.mode,
    model: envelope.model,
    effort: envelope.effort,
    ...(envelope.speed ? { speed: envelope.speed } : {}),
  };
  parts.push(JSON.stringify(headerObj).slice(0, -1) + ",");

  // Part 1: Immutable instruction / prompt chunk
  parts.push(JSON.stringify({ prompt: envelope.prompt }).slice(1, -1) + ",");

  // Subject parts
  if (typeof subject === "object" && subject !== null && !Array.isArray(subject)) {
    parts.push('"subject":{');
    const keys = Object.keys(subject);
    let count = 0;
    for (const k of keys) {
      const val = (subject as Record<string, unknown>)[k];
      if (val === undefined || typeof val === "function" || typeof val === "symbol") continue;
      const entry = JSON.stringify({ [k]: val }).slice(1, -1);
      parts.push((count === 0 ? "" : ",") + entry);
      count++;
    }
    parts.push("}}");
  } else {
    parts.push('"subject":' + JSON.stringify(subject) + "}");
  }

  return parts;
}

/**
 * Prepares the wire manifest and all missing request-part writes for atomic
 * inclusion into the model reservation transaction. Shared parts already
 * present in the Store are preserved without duplicate writes.
 */
export function prepareRequestPartsAndManifest(options: {
  store: Store;
  projectId: string;
  draftId: string;
  requestId: string;
  envelope: ResearchEnvelopeFrame;
  subject: unknown;
  intentRef?: Ref | undefined;
  callWriteRef?: Ref | undefined;
}): {
  input: string;
  manifestRef: Ref;
  manifestValue: RequestManifest;
  writes: Write[];
  guards: Ref[];
  partCount: number;
  sharedPartCount: number;
} {
  const { store, projectId, draftId, requestId, envelope, subject, intentRef, callWriteRef } = options;
  const partStrings = partitionResearchWire(envelope, subject);
  const input = partStrings.join("");
  const canonicalWire = JSON.stringify({ ...envelope, subject });
  requireCondition(
    input === canonicalWire,
    "request_manifest_invalid",
    "Partitioned wire parts must exactly equal canonical transmitted wire string"
  );

  const partsResult = prepareStoreParts(store, projectId, partStrings);

  const manifestId = `request-manifest:${requestId}`;
  const manifestValue: RequestManifest = {
    contract: REQUEST_MANIFEST_CONTRACT,
    projectId,
    draftId,
    requestId,
    ...(intentRef ? { intent: intentRef } : {}),
    ...(callWriteRef ? { call: callWriteRef } : {}),
    parts: partsResult.partRefs,
    chars: partsResult.chars,
    bytes: partsResult.bytes,
    sha256: partsResult.sha256,
    wire: { chars: partsResult.chars, bytes: partsResult.bytes, sha256: partsResult.sha256 },
  };

  const manifestRef: Ref = {
    id: manifestId,
    revision: 1,
    hash: hashJson(manifestValue),
  };

  const writes = [
    ...partsResult.writes,
    {
      id: manifestId,
      kind: REQUEST_MANIFEST_KIND,
      expected: 0,
      value: manifestValue,
    },
  ];

  return {
    input,
    manifestRef,
    manifestValue,
    writes,
    guards: partsResult.guards,
    partCount: partsResult.partCount,
    sharedPartCount: partsResult.sharedPartCount,
  };
}

export interface ReadRequestWireOptions {
  projectId?: string;
  draftId?: string;
  requestId?: string;
  errorCode?: string;
}

export interface ReadRequestWireResult {
  text: string;
  contract: "model-request" | typeof REQUEST_MANIFEST_CONTRACT;
  manifest?: RequestManifest;
  partGuards: Ref[];
  record: Revision<any>;
}

/**
 * Universal reader of durable request wire: restores exact wire text from either
 * a historical model-request record or a request-manifest with joined parts.
 */
export function readRequestWire(
  store: Store,
  requestRef: Ref,
  options?: ReadRequestWireOptions
): ReadRequestWireResult {
  const errorCode = options?.errorCode ?? "response_recovery_wire_invalid";
  requireCondition(
    isRef(requestRef),
    errorCode,
    "A valid request reference is required"
  );

  if (requestRef.id.startsWith("model-request:")) {
    const record = store.get<{ projectId: string; draftId: string; text: string }>(requestRef.id, requestRef.revision);
    requireCondition(
      record !== null
      && record.kind === "model-request"
      && canonical(reference(record)) === canonical(requestRef)
      && typeof record.value?.text === "string"
      && hashJson(record.value) === record.hash
      && (!options?.projectId || record.value.projectId === options.projectId)
      && (!options?.draftId || record.value.draftId === options.draftId),
      errorCode,
      "The exact saved model-request is missing or foreign"
    );
    return {
      text: record.value.text,
      contract: "model-request",
      partGuards: [reference(record)],
      record,
    };
  }

  if (requestRef.id.startsWith("request-manifest:")) {
    const record = store.get<RequestManifest>(requestRef.id, requestRef.revision);
    requireCondition(
      record !== null
      && record.kind === REQUEST_MANIFEST_KIND
      && canonical(reference(record)) === canonical(requestRef)
      && record.value !== null
      && record.value.contract === REQUEST_MANIFEST_CONTRACT
      && hashJson(record.value) === record.hash
      && (!options?.projectId || record.value.projectId === options.projectId)
      && (!options?.draftId || record.value.draftId === options.draftId)
      && (!options?.requestId || record.value.requestId === options.requestId)
      && Array.isArray(record.value.parts)
      && record.value.parts.length > 0,
      errorCode,
      "The exact saved request-manifest is missing, foreign or corrupt"
    );

    const chars = record.value.chars ?? record.value.wire?.chars;
    const bytes = record.value.bytes ?? record.value.wire?.bytes;
    const sha256 = record.value.sha256 ?? record.value.wire?.sha256;
    requireCondition(
      Number.isSafeInteger(chars)
      && Number.isSafeInteger(bytes)
      && typeof sha256 === "string",
      errorCode,
      "The request-manifest wire properties are invalid"
    );

    const restored = restoreTextFromParts({
      store,
      projectId: record.value.projectId,
      parts: record.value.parts,
      expectedChars: chars,
      expectedBytes: bytes,
      expectedSha256: sha256,
      errorCode,
    });

    return {
      text: restored.text,
      contract: REQUEST_MANIFEST_CONTRACT,
      manifest: record.value,
      partGuards: [reference(record), ...restored.partGuards],
      record,
    };
  }

  throw new EngineError(errorCode, `Unknown or unsupported request wire record kind: ${requestRef.id}`);
}

/** The content-derived address of one preparation: its whole binding and the
 * checksum of its context. */
export function contextPreparationId(binding: ContextPreparationBinding, contextSha256: string): string {
  return `context-preparation:v1:${hashJson([binding.projectId, binding.draft, binding.question, binding.owner,
    binding.kind, binding.instruction, binding.subject, binding.earlyActions, binding.graphBase, contextSha256] as unknown as Json)}`;
}

export interface PreparedContextWrites {
  /** The exact Ref the preparation has once the batch commits (revision 1). */
  preparation: Ref;
  value: ContextPreparation;
  /** New parts and, when absent, the preparation itself — all expected:0. */
  writes: Write[];
  /** Exact guards of the parts and preparation that already exist; never a
   * guard of a record this batch writes. */
  guards: Ref[];
}

/** The producer side of a preparation: partitions the exact context into
 * project-scoped parts and binds it to its step. It writes nothing itself —
 * the caller publishes these writes in the same batch as the first intent
 * that names the preparation. */
export function prepareContextPreparation(store: Store, binding: ContextPreparationBinding,
  context: unknown): PreparedContextWrites {
  requireCondition(context !== null && typeof context === "object" && !Array.isArray(context),
    "context_preparation_invalid", "A preparation holds the exact context object of its call");
  const parts = prepareStoreParts(store, binding.projectId, partitionJsonObject(context));
  const value: ContextPreparation = { contract: CONTEXT_PREPARATION_CONTRACT, ...exactBinding(binding),
    contextSha256: parts.sha256, contextChars: parts.chars, contextBytes: parts.bytes, parts: parts.partRefs };
  const id = contextPreparationId(value, parts.sha256);
  const preparation: Ref = { id, revision: 1, hash: hashJson(value) };
  const existing = store.get<ContextPreparation>(id);
  if (existing) {
    requireCondition(existing.kind === CONTEXT_PREPARATION_KIND && existing.revision === 1
      && hashJson(existing.value) === existing.hash && canonical(existing.value) === canonical(value),
    "context_preparation_invalid", "The saved preparation at this address differs from its binding");
    return { preparation: reference(existing), value, writes: parts.writes, guards: uniqueRefs([...parts.guards, reference(existing)]) };
  }
  return { preparation, value, guards: parts.guards,
    writes: [...parts.writes, { id, kind: CONTEXT_PREPARATION_KIND, expected: 0, value }] };
}

function exactBinding(binding: ContextPreparationBinding): ContextPreparationBinding {
  return { projectId: binding.projectId, draft: binding.draft, question: binding.question, owner: binding.owner,
    kind: binding.kind, instruction: binding.instruction, subject: binding.subject ?? null,
    earlyActions: binding.earlyActions ?? null, graphBase: binding.graphBase ?? null };
}

/** The exact record of a preparation, for every read of its intent: the
 * immutable first revision, the known contract first, its exact form, the
 * binding of the reading step and its own address. Parts are not read here. */
export function readPreparationRecord(store: Store, ref: Ref, binding: ContextPreparationBinding): Revision<ContextPreparation> {
  const invalid = (message: string): never => {
    throw new EngineError("context_preparation_invalid", `[${isRef(ref) ? ref.id : "context-preparation"}] ${message}`);
  };
  if (!isRef(ref) || ref.revision !== 1) invalid("A preparation is read only at its immutable first revision");
  const record = store.get<ContextPreparation>(ref.id, ref.revision);
  if (!record || record.kind !== CONTEXT_PREPARATION_KIND || canonical(reference(record)) !== canonical(ref)
    || hashJson(record.value) !== record.hash) invalid("The exact preparation is missing or changed");
  const value = record!.value as unknown as Record<string, unknown>;
  if (!value || typeof value !== "object" || value["contract"] !== CONTEXT_PREPARATION_CONTRACT)
    invalid("The preparation names an unknown contract");
  if (Object.keys(value).sort().join(",") !== PREPARATION_FIELDS || !Array.isArray(value["parts"])
    || typeof value["contextSha256"] !== "string" || !Number.isSafeInteger(value["contextChars"])
    || !Number.isSafeInteger(value["contextBytes"])) invalid("The preparation lost its exact form");
  const saved = record!.value;
  if (canonical(exactBinding(saved)) !== canonical(exactBinding(binding)))
    invalid("The preparation belongs to another step");
  if (record!.id !== contextPreparationId(saved, saved.contextSha256))
    invalid("The preparation address does not match its binding");
  return record!;
}

/** The exact context of a preparation: its record as above and the context
 * restored from its exact parts. The saved Revision and the restored context
 * are returned separately; neither stands in for the other. */
export function readPreparedContext(store: Store, ref: Ref, binding: ContextPreparationBinding): {
  context: Record<string, unknown>; preparation: Revision<ContextPreparation>; partGuards: Ref[];
} {
  const record = readPreparationRecord(store, ref, binding), saved = record.value;
  const restored = restoreTextFromParts({ store, projectId: saved.projectId, parts: saved.parts,
    expectedSha256: saved.contextSha256, expectedChars: saved.contextChars, expectedBytes: saved.contextBytes,
    errorCode: "context_part_invalid" });
  let context: unknown = null;
  try { context = JSON.parse(restored.text); } catch { context = null; }
  requireCondition(context !== null && typeof context === "object" && !Array.isArray(context),
    "context_preparation_invalid", `[${record.id}] The restored context is not a JSON object`);
  return { context: context as Record<string, unknown>, preparation: record, partGuards: [reference(record), ...restored.partGuards] };
}

export interface ArchivePartsWrites { archive: Ref; value: ArchivePartsValue; writes: Write[]; guards: Ref[] }

/** The compact archive of one exact body; content-addressed like the
 * whole-body archive, metadata included. Writes nothing itself. */
export function prepareArchiveParts(store: Store, metadata: { projectId: string; draft: Ref; question: Ref;
  subject?: V7PlanSubject }, body: Record<string, unknown>): ArchivePartsWrites {
  const parts = prepareStoreParts(store, metadata.projectId, partitionJsonObject(body));
  const value: ArchivePartsValue = { contract: ARCHIVE_PARTS_CONTRACT, projectId: metadata.projectId,
    draft: metadata.draft, question: metadata.question, ...(metadata.subject ? { subject: metadata.subject } : {}),
    parts: parts.partRefs, bodySha256: parts.sha256, bodyChars: parts.chars, bodyBytes: parts.bytes };
  const id = `research-context:${hashJson(value)}`;
  const existing = store.get<ArchivePartsValue>(id);
  if (existing) {
    requireCondition(existing.kind === "research-context" && hashJson(existing.value) === existing.hash
      && canonical(existing.value) === canonical(value),
    "archive_parts_invalid", "The saved compact archive at this address differs from its body");
    return { archive: reference(existing), value, writes: parts.writes, guards: uniqueRefs([...parts.guards, reference(existing)]) };
  }
  return { archive: { id, revision: 1, hash: hashJson(value) }, value, guards: parts.guards,
    writes: [...parts.writes, { id, kind: "research-context", expected: 0, value }] };
}

/** Saved research-context forms whose body is stored whole. */
const WHOLE_BODY_ARCHIVES: readonly (string | undefined)[] = [undefined, "result-capacity-projection/v1"];
const ARCHIVE_PARTS_FIELDS = ["contract", "projectId", "draft", "question", "parts", "bodySha256", "bodyChars", "bodyBytes"];

/** The body of one exact saved research-context record by its own contract —
 * checked before the representation is chosen: whole-body forms literally,
 * archive-parts/v1 restored from its exact parts, anything else refused. */
export function readArchiveBody(store: Store, record: Revision<unknown>): { body: Record<string, any>; partGuards: Ref[] } {
  const value = record?.value as Record<string, any> | null;
  requireCondition(record?.kind === "research-context" && value !== null && typeof value === "object",
    "archive_parts_invalid", "The exact context archive is missing");
  const contract = Object.hasOwn(value!, "contract") ? value!["contract"] : undefined;
  // A whole-body archive is read literally: no read or check beyond its own
  // form is added to its callers' historical sequence (RD2e).
  if (WHOLE_BODY_ARCHIVES.includes(contract)) {
    requireCondition(value!["body"] !== null && typeof value!["body"] === "object" && !Array.isArray(value!["body"]),
      "archive_parts_invalid", "The whole-body archive lost its body");
    return { body: value!["body"], partGuards: [] };
  }
  requireCondition(contract === ARCHIVE_PARTS_CONTRACT, "archive_parts_invalid", "The context archive names an unknown contract");
  const keys = Object.keys(value!).filter(key => key !== "subject").sort().join(",");
  requireCondition(keys === [...ARCHIVE_PARTS_FIELDS].sort().join(",") && Array.isArray(value!["parts"])
    && typeof value!["bodySha256"] === "string" && Number.isSafeInteger(value!["bodyChars"])
    && Number.isSafeInteger(value!["bodyBytes"]) && hashJson(value) === record.hash
    && record.id === `research-context:${hashJson(value)}`,
  "archive_parts_invalid", "The compact archive lost its exact form");
  const restored = restoreTextFromParts({ store, projectId: value!["projectId"], parts: value!["parts"],
    expectedSha256: value!["bodySha256"], expectedChars: value!["bodyChars"], expectedBytes: value!["bodyBytes"],
    errorCode: "archive_part_invalid" });
  let body: unknown;
  try { body = JSON.parse(restored.text); } catch { body = null; }
  requireCondition(body !== null && typeof body === "object" && !Array.isArray(body),
    "archive_parts_invalid", "The restored archive body is not an object");
  return { body: body as Record<string, any>, partGuards: [reference(record), ...restored.partGuards] };
}

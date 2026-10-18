import type { Store, Revision, Write } from "../storage/store.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { canonical, digest, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";

export const REQUEST_MANIFEST_CONTRACT = "request-manifest/v1" as const;
export const REQUEST_PART_CONTRACT = "request-part/v1" as const;
export const REQUEST_MANIFEST_KIND = "request-manifest" as const;
export const REQUEST_PART_KIND = "request-part" as const;

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

export interface ResearchEnvelopeFrame {
  protocol: string;
  requestId: string;
  mode: string;
  model: string;
  effort: string;
  speed?: string;
  prompt: string;
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

  const chars = input.length;
  const bytes = Buffer.byteLength(input, "utf8");
  const sha256 = digest(input);

  const writes: Write[] = [];
  const guards: Ref[] = [];
  const partRefs: Ref[] = [];
  let sharedPartCount = 0;

  for (const text of partStrings) {
    const textHash = digest(text);
    const partId = requestPartId(projectId, text);
    const existing = store.get<RequestPart>(partId);
    if (existing) {
      requireCondition(
        existing.kind === REQUEST_PART_KIND
        && existing.value !== null
        && existing.value.contract === REQUEST_PART_CONTRACT
        && existing.value.hash === textHash
        && existing.value.text === text
        && existing.value.projectId === projectId
        && hashJson(existing.value) === existing.hash,
        "request_part_invalid",
        "Existing saved request part is invalid, corrupt or foreign"
      );
      guards.push(reference(existing));
      partRefs.push(reference(existing));
      sharedPartCount++;
    } else {
      const partValue: RequestPart = {
        contract: REQUEST_PART_CONTRACT,
        projectId,
        hash: textHash,
        text,
        chars: text.length,
        bytes: Buffer.byteLength(text, "utf8"),
      };
      writes.push({
        id: partId,
        kind: REQUEST_PART_KIND,
        expected: 0,
        value: partValue,
      });
      partRefs.push({
        id: partId,
        revision: 1,
        hash: hashJson(partValue),
      });
    }
  }

  const manifestId = `request-manifest:${requestId}`;
  const manifestValue: RequestManifest = {
    contract: REQUEST_MANIFEST_CONTRACT,
    projectId,
    draftId,
    requestId,
    ...(intentRef ? { intent: intentRef } : {}),
    ...(callWriteRef ? { call: callWriteRef } : {}),
    parts: partRefs,
    chars,
    bytes,
    sha256,
    wire: { chars, bytes, sha256 },
  };

  const manifestRef: Ref = {
    id: manifestId,
    revision: 1,
    hash: hashJson(manifestValue),
  };

  writes.push({
    id: manifestId,
    kind: REQUEST_MANIFEST_KIND,
    expected: 0,
    value: manifestValue,
  });

  return {
    input,
    manifestRef,
    manifestValue,
    writes,
    guards,
    partCount: partStrings.length,
    sharedPartCount,
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

    const partGuards: Ref[] = [reference(record)];
    const partsText: string[] = [];
    for (const partRef of record.value.parts) {
      requireCondition(
        isRef(partRef),
        errorCode,
        "Manifest contains an invalid part reference"
      );
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
        && partRecord.value.projectId === record.value.projectId
        && partRef.id === requestPartId(record.value.projectId, partRecord.value.text),
        errorCode,
        "A saved request part is missing, tampered, foreign or corrupt"
      );
      partsText.push(partRecord.value.text);
      partGuards.push(reference(partRecord));
    }

    const assembledWire = partsText.join("");
    requireCondition(
      assembledWire.length === chars
      && Buffer.byteLength(assembledWire, "utf8") === bytes
      && digest(assembledWire) === sha256,
      errorCode,
      "Assembled request wire does not match the manifest checksums"
    );

    return {
      text: assembledWire,
      contract: REQUEST_MANIFEST_CONTRACT,
      manifest: record.value,
      partGuards,
      record,
    };
  }

  throw new EngineError(errorCode, `Unknown or unsupported request wire record kind: ${requestRef.id}`);
}

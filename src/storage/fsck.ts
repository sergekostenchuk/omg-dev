import { digest } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { Store } from "./store.js";

/**
 * NR1 (№3633, №3635): the integrity check of a whole database, like git fsck. Reads are trusted (№3591): a record is read
 * as it was written and never checked again on the way. Damage that hashes and references can show is found here, by
 * one explicit scan outside every step of the pass: a body that is not the one its sha256 was written for, a revision or
 * event that is missing or out of order, a head that is not the last revision, and a reference {id, revision, hash} in a
 * body that names a revision the store does not hold or holds with another hash. It changes nothing; its cost is the
 * history, paid only when it is run.
 */
export const INTEGRITY_FINDING_CODES = Object.freeze([
  "revision_corrupt", "revision_gap", "head_invalid", "event_missing", "event_duplicate", "event_order",
  "reference_missing", "reference_forged",
] as const);
export type IntegrityFindingCode = typeof INTEGRITY_FINDING_CODES[number];
export interface IntegrityFinding {
  code: IntegrityFindingCode; id: string; revision: number | null; field: string | null;
  ref: { id: string; revision: number; hash: string } | null; message: string;
}
export interface IntegrityReport { lastSequence: number; revisions: number; events: number; references: number; findings: IntegrityFinding[] }

const HASH = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isReference = (value: Record<string, unknown>): value is { id: string; revision: number; hash: string } =>
  typeof value["id"] === "string" && Number.isSafeInteger(value["revision"]) && (value["revision"] as number) > 0
  && typeof value["hash"] === "string" && HASH.test(value["hash"]);

export function checkStoreIntegrity(store: Store): IntegrityReport {
  requireCondition(store instanceof Store, "integrity_request_invalid", "The integrity check reads a store");
  // №3674 п.1: one committed snapshot for the whole check — never events of one moment and heads of another.
  return store.integritySnapshot(() => checkSnapshot(store));
}
function checkSnapshot(store: Store): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  const found = (code: IntegrityFindingCode, id: string, revision: number | null, message: string,
    field: string | null = null, ref: IntegrityFinding["ref"] = null) => findings.push({ code, id, revision, field, ref, message });
  const { events, heads } = store.integrityLedger();
  const lastSequence = events.length ? events[events.length - 1]!.sequence : 0;
  // A revision is covered when an event made it or its head reached it (in one snapshot both agree on an intact database).
  const covered = new Map<string, number>(heads);
  for (const event of events) covered.set(event.id, Math.max(covered.get(event.id) ?? 0, event.revision));
  // Pass 1: every body against the sha256 written with it, and every line of revisions without a hole.
  const hashes = new Map<string, string[]>();
  let revisions = 0;
  for (const row of store.integrityRevisions()) {
    if (row.revision > (covered.get(row.id) ?? 0)) continue;
    revisions++;
    const line = hashes.get(row.id) ?? [];
    if (row.revision !== line.length + 1)
      found("revision_gap", row.id, row.revision, `Revision ${row.revision} follows revision ${line.length}`);
    line[row.revision - 1] = row.sha256; hashes.set(row.id, line);
    if (digest(row.body) !== row.sha256) found("revision_corrupt", row.id, row.revision, "The stored body is not the one its sha256 was written for");
  }
  // Every revision has one event, in the order of its line; every line ends at its head.
  const seen = new Map<string, number>(), occurred = new Set<string>();
  for (const event of events) {
    const key = `${event.id}\u0000${event.revision}`;
    if (occurred.has(key)) found("event_duplicate", event.id, event.revision, `Event ${event.sequence} repeats a revision already made`);
    occurred.add(key);
    if (event.revision <= (seen.get(event.id) ?? 0)) found("event_order", event.id, event.revision, `Event ${event.sequence} makes a revision after a later one`);
    seen.set(event.id, Math.max(seen.get(event.id) ?? 0, event.revision));
  }
  for (const [id, line] of hashes) {
    for (let revision = 1; revision <= line.length; revision++)
      if (line[revision - 1] !== undefined && !occurred.has(`${id}\u0000${revision}`))
        found("event_missing", id, revision, "A stored revision has no event that made it");
    if (heads.get(id) !== line.length) found("head_invalid", id, heads.get(id) ?? null, `The head is not the last revision ${line.length}`);
  }
  // Pass 2: every reference in every body names a revision the store holds with exactly that hash.
  let references = 0;
  for (const row of store.integrityRevisions()) {
    if (row.revision > (covered.get(row.id) ?? 0)) continue;
    let body: unknown;
    try { body = JSON.parse(row.body); } catch { continue; }
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
      if (!object(value)) return;
      if (isReference(value)) {
        references++;
        const target = hashes.get(value.id)?.[value.revision - 1];
        if (target === undefined) found("reference_missing", row.id, row.revision, "A reference names a revision the store does not hold",
          path, { id: value.id, revision: value.revision, hash: value.hash });
        else if (target !== value.hash) found("reference_forged", row.id, row.revision, "A reference names a revision the store holds with another hash",
          path, { id: value.id, revision: value.revision, hash: value.hash });
      }
      for (const [key, item] of Object.entries(value)) visit(item, path ? `${path}.${key}` : key);
    };
    visit(body, "");
  }
  return { lastSequence, revisions, events: events.length, references, findings };
}

import { digest } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { Store, type Revision } from "./store.js";
import { referenceSites } from "./reference-sites.js";

/**
 * NR1 (№3633, №3635): the integrity check of a whole database, like git fsck. Reads are trusted (№3591): a record is read
 * as it was written and never checked again on the way. Damage that hashes and references can show is found here, by
 * one explicit scan outside every step of the pass: a body that is not the one its sha256 was written for, a revision or
 * event that is missing or out of order, a head that is not the last revision, and every reference declared by a stored
 * record contract that names a revision the store does not hold or holds with another hash. JSON evidence and model data
 * remain data even when an object inside them resembles a reference. It changes nothing; its cost is the history, paid
 * only when it is run.
 */
export const INTEGRITY_FINDING_CODES = Object.freeze([
  "revision_corrupt", "revision_gap", "head_invalid", "event_missing", "event_duplicate", "event_order",
  "reference_missing", "reference_forged", "record_missing",
] as const);
export type IntegrityFindingCode = typeof INTEGRITY_FINDING_CODES[number];
export interface IntegrityFinding {
  code: IntegrityFindingCode; id: string; revision: number | null; field: string | null;
  ref: { id: string; revision: number; hash: string } | null; message: string;
}
export interface IntegrityReport { lastSequence: number; revisions: number; events: number; references: number; findings: IntegrityFinding[] }

/** A domain check consumes the same decoded revisions and finishes inside the same snapshot. */
export interface IntegrityRecordCheck {
  record(record: Revision<unknown>): void;
  findings(): IntegrityFinding[];
}

export function checkStoreIntegrity(store: Store, additional?: IntegrityRecordCheck): IntegrityReport {
  requireCondition(store instanceof Store, "integrity_request_invalid", "The integrity check reads a store");
  // №3674 п.1: one committed snapshot for the whole check — never events of one moment and heads of another.
  return store.integritySnapshot(() => checkSnapshot(store, additional));
}
function checkSnapshot(store: Store, additional?: IntegrityRecordCheck): IntegrityReport {
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
  // Pass 2: every reference declared by the record's saved contract names exact stored bytes.
  let references = 0;
  for (const row of store.integrityRevisions()) {
    if (row.revision > (covered.get(row.id) ?? 0)) continue;
    let body: unknown;
    try { body = JSON.parse(row.body); } catch { continue; }
    additional?.record({ id: row.id, kind: row.kind, revision: row.revision, hash: row.sha256, value: body });
    for (const { field, ref } of referenceSites(row.kind, body)) {
      references++;
      const target = hashes.get(ref.id)?.[ref.revision - 1];
      if (target === undefined) found("reference_missing", row.id, row.revision, "A reference names a revision the store does not hold",
        field, ref);
      else if (target !== ref.hash) found("reference_forged", row.id, row.revision, "A reference names a revision the store holds with another hash",
        field, ref);
    }
  }
  findings.push(...(additional?.findings() ?? []));
  return { lastSequence, revisions, events: events.length, references, findings };
}

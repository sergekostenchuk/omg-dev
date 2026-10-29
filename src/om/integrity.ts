import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { canonical, digest } from "../canonical.js";
import { b1OriginCheck } from "./b1-origin.js";
import { reference } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { checkStoreIntegrity, checkStoreIntegritySince, type IntegrityFinding, type IntegrityRecordCheck, type IntegrityReport } from "../storage/fsck.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Sealed } from "./refusal.js";
import { writeGuarded } from "./refs.js";
import { EngineError } from "../errors.js";

/**
 * NR1 (№3633, №3646): om-fsck, as in git. During a pass every record is read as it was written (№3591): the engine is its
 * only writer. The whole check of the database — each body against its sha256, every line of revisions and events, every
 * head, every reference declared by each stored record contract — runs by itself at each om-start and om-continue, and on
 * request. Arbitrary JSON remains data; an old diagnostic report can therefore describe a missing address without becoming
 * a new broken link itself. Damage found stops the pass before it starts, with the exact addresses (store_damaged, for the
 * owner); the check repairs nothing. Its cost is the history, paid once per start, never per step (2.3 s on the live copy of
 * 5 276 revisions).
 */
const UNIT = "NR1.fsck";
export const INTEGRITY_KIND = "om-integrity";
export const INTEGRITY_CONTRACT = "om-integrity/v1" as const;
export interface IntegrityRecord extends IntegrityReport { contract: typeof INTEGRITY_CONTRACT; project: string; checkedAt: number }
export function integrityId(project: string): string { return `${INTEGRITY_KIND}:${project}`; }
function requireProject(project: unknown): asserts project is string {
  if (!isText(project) || (project as string).includes(":"))
    throw new EngineError("integrity_request_invalid", "The integrity check names its project", { unit: UNIT, target: "om-integrity", field: "project" });
}
function save(store: Store, project: string, report: IntegrityReport): OmResult<Sealed<Revision<IntegrityRecord>>> {
  const id = integrityId(project), head = store.get<IntegrityRecord>(id);
  const value: IntegrityRecord = { contract: INTEGRITY_CONTRACT, project, checkedAt: Date.now(), ...report };
  const written = writeGuarded<IntegrityRecord>(store, { unit: UNIT, target: id,
    writes: [{ id, kind: INTEGRITY_KIND, expected: head?.revision ?? 0, value }], guards: head ? [reference(head)] : [{ id, absent: true }] });
  return written.ok ? delivered(written.value[0]!) : written;
}
export const integrityAddress = (finding: IntegrityFinding): string =>
  `${finding.code} ${finding.id}${finding.revision === null ? "" : `@${finding.revision}`}${finding.field ? ` ${finding.field}` : ""}`;

/** om-fsck on request: the whole check, saved as om-integrity:<project> whatever it found. */
export function runIntegrityCheck(store: Store, request: { project: string }): OmResult<Sealed<Revision<IntegrityRecord>>> {
  if (!(store instanceof Store)) throw new EngineError("integrity_request_invalid", "The integrity check reads a store", { unit: UNIT, target: "om-integrity", field: "store" });
  requireProject(request?.project);
  return save(store, request.project, checkStoreIntegrity(store, b1OriginCheck(request.project)));
}

/** A damaged diagnostic is never evidence that the newly computed report was already saved. */
function sameFindings(value: unknown, project: string, findings: IntegrityFinding[]): boolean {
  if (!isPlainObject(value)) return false;
  const saved = value as Record<string, unknown>;
  if (saved.contract !== INTEGRITY_CONTRACT || saved.project !== project || !Array.isArray(saved.findings)
    || ![saved.checkedAt, saved.lastSequence, saved.revisions, saved.events, saved.references]
      .every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return false;
  try { return canonical(saved.findings) === canonical(findings); }
  catch (error) {
    // JSON.parse also accepts numeric overflow. Such a damaged array must not hide the fsck refusal.
    if (error instanceof EngineError && error.code === "invalid_json") return false;
    throw error;
  }
}

/**
 * PROOF-SPEED-2 (owner rule 08.10, the database fingerprint): the sequence up to which a clean check of this project's
 * database is known — a note beside the database file, never inside it, so an entry writes nothing for it. It names the
 * database identity, the event at that sequence, and the file as the checking connection left it once closed (size,
 * modification and change times, inode — any write by anyone moves them; reopening and reading do not). An entry takes the
 * mark only while the file is that very file with no pending journal; otherwise — another database, a rewritten, shortened
 * or externally touched file, a forged or erased note — it checks the whole store before any history is used.
 */
const MARK_CONTRACT = "om-fsck-mark/v2";
const markPath = (store: Store, project: string) => `${store.path}.om-fsck-mark.${digest(project).slice(0, 16)}.json`;
function fileSign(path: string): { size: number; mtimeNs: string; ctimeNs: string; ino: string } | null {
  try { const s = statSync(path, { bigint: true }); return { size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), ino: String(s.ino) }; }
  catch { return null; }
}
const quietJournal = (store: Store) => { const wal = fileSign(`${store.path}-wal`); return wal === null || wal.size === 0; };
function savedMark(store: Store, project: string): number | null {
  if (store.path === ":memory:") return null;
  try {
    const mark: unknown = JSON.parse(readFileSync(markPath(store, project), "utf8"));
    if (!isPlainObject(mark)) return null;
    const value = mark as Record<string, unknown>, cursor = value.cursor;
    if (value.contract !== MARK_CONTRACT || value.project !== project || value.db !== store.databaseId
      || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor <= 0 || cursor > store.lastEvent()) return null;
    if (!quietJournal(store) || canonical(value.file) !== canonical(fileSign(store.path))) return null;
    return canonical(value.event) === canonical(store.eventAt(cursor)) ? cursor : null;
  } catch (error) { if (error instanceof EngineError && error.code === "store_busy") throw error; return null; }
}
/** The commits of other connections this connection has seen: PRAGMA data_version, never moved by its own writes. */
const othersSeen = (store: Store) => store.changeStamp().split(":")[1]!;
function saveMark(store: Store, project: string, through: number, witness: string): void {
  if (through <= 0 || store.path === ":memory:") return;
  const db = store.databaseId, event = store.eventAt(through), path = markPath(store, project);
  // PS2-INTEGRITY-01 (map-2 №18491, №18514): the clean check holds only while no other connection commits. data_version
  // of this connection moves with every such commit and never with its own: `witness` was taken before the check began.
  // Under the Store's guarded end — no other writer until it is closed — it is compared again, the journal checkpointed,
  // and only then the file's sign taken; any commit in between, or a boundary that cannot be guarded, leaves no mark and
  // erases an old one.
  let sign: ReturnType<typeof fileSign> = null;
  store.sealOnClose({
    inspect: seen => seen === witness,
    sealed: () => { sign = quietJournal(store) ? fileSign(store.path) : null; },
    abandoned: () => { sign = null; },
  });
  store.afterClose(() => {
    if (sign === null) { rmSync(path, { force: true }); return; }
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ contract: MARK_CONTRACT, project, db, cursor: through, event, file: sign }));
    renameSync(temporary, path);
  });
}
function damaged(store: Store, project: string, report: IntegrityReport): OmResult<never> {
  const head = store.get<unknown>(integrityId(project));
  if (!head || !sameFindings(head.value, project, report.findings)) save(store, project, report);
  const shown = report.findings.slice(0, 5).map(integrityAddress).join("; ");
  return refused("store_damaged", `om-fsck found ${report.findings.length} damaged place(s) in the database: ${shown}`
    + `${report.findings.length > 5 ? "; …" : ""} — the pass does not start; the owner decides`,
  { unit: UNIT, target: integrityId(project), field: report.findings[0]!.code }, "owner");
}
/** The B1 provenance check of the records after a mark: the first B1 itself may be older than the mark. */
function b1OriginSince(store: Store, project: string): IntegrityRecordCheck {
  const check = b1OriginCheck(project), first = store.integrityRevision(`om-input:${project}`, 1);
  if (first) {
    let value: unknown = null;
    try { value = JSON.parse(first.body); } catch { /* the full check reports an unreadable body */ }
    check.record({ id: `om-input:${project}`, kind: first.kind, revision: 1, hash: first.sha256, value });
  }
  return check;
}
/** At each entry of a Discovery pass: the check of what was committed after a mark this very file still proves — in full
 * when there is none. A clean result names the sequence it checked through, which `saveIntegrityMark` keeps beside the
 * file once the Store is closed. */
export function incrementalIntegrityGate(store: Store, project: string):
  { refusal: OmResult<never> | null; checked: number | null; since: number | null; witness: string } {
  const witness = othersSeen(store), mark = savedMark(store, project);
  const report = mark === null ? checkStoreIntegrity(store, b1OriginCheck(project)) : checkStoreIntegritySince(store, mark, b1OriginSince(store, project));
  if (report.findings.length) return { refusal: damaged(store, project, report), checked: null, since: mark, witness };
  return { refusal: null, checked: report.lastSequence, since: mark, witness };
}
/** The note beside the file that would hold this project's mark (for its own tests and the operator). */
export const integrityMarkPath = markPath;
export function saveIntegrityMark(store: Store, project: string, checked: number, witness: string): void { saveMark(store, project, checked, witness); }

/** At om-start and om-continue: the same check; damage found is saved (once per distinct finding set) and refuses the start. */
export function integrityGate(store: Store, project: string): OmResult<never> | null {
  const report = checkStoreIntegrity(store, b1OriginCheck(project));
  if (!report.findings.length) return null;
  const head = store.get<unknown>(integrityId(project));
  if (!head || !sameFindings(head.value, project, report.findings)) save(store, project, report);
  const shown = report.findings.slice(0, 5).map(integrityAddress).join("; ");
  return refused("store_damaged", `om-fsck found ${report.findings.length} damaged place(s) in the database: ${shown}`
    + `${report.findings.length > 5 ? "; …" : ""} — the pass does not start; the owner decides`,
  { unit: UNIT, target: integrityId(project), field: report.findings[0]!.code }, "owner");
}

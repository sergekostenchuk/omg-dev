import { reference } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { checkStoreIntegrity, type IntegrityFinding, type IntegrityReport } from "../storage/fsck.js";
import { delivered, isText, refused, type OmResult, type Sealed } from "./refusal.js";
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
  return save(store, request.project, checkStoreIntegrity(store));
}

/** At om-start and om-continue: the same check; damage found is saved (once per distinct finding set) and refuses the start. */
export function integrityGate(store: Store, project: string): OmResult<never> | null {
  const report = checkStoreIntegrity(store);
  if (!report.findings.length) return null;
  const head = store.get<IntegrityRecord>(integrityId(project));
  if (!head || JSON.stringify(head.value.findings) !== JSON.stringify(report.findings)) save(store, project, report);
  const shown = report.findings.slice(0, 5).map(integrityAddress).join("; ");
  return refused("store_damaged", `om-fsck found ${report.findings.length} damaged place(s) in the database: ${shown}`
    + `${report.findings.length > 5 ? "; …" : ""} — the pass does not start; the owner decides`,
  { unit: UNIT, target: integrityId(project), field: report.findings[0]!.code }, "owner");
}

import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { canonical, digest, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import type { Command } from "../graph/model.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision, type Write } from "../storage/store.js";
import { executablePath, readEnvironmentAt, type Environment } from "../runtime/environment.js";
import type { TokenUsage } from "../runtime/model-usage.js";
import { runProcess, type ProcessResult } from "../runtime/process.js";
import { isProcessStopRefusal, processStopPhysical, type ProcessStopHooks } from "../runtime/process-identity.js";
import { adapterRequest, pendingCallStore, readAdapterResponse, readModelCallPhysical, type AdapterRequest, type AdapterResult } from "./model-call.js";
import { prepareQuestionPacket, readQuestionPacket, type QuestionPacketRecord, type QuestionPacketRequest, type RetryRefusal } from "./question-packet.js";
import { checkAnswerForm, type CheckedAnswerForm } from "./answer-form.js";
import { readRoutes } from "./routes.js";
import { readRun } from "./run.js";
import { applyProposals, readFrameProposals, type LayerProposal, type ProposalRequest } from "./frame-proposals.js";
import { assembleCandidate } from "./frame-candidate.js";
import { WORKS_FRAME_CONTRACT } from "./frame-obligations.js";
import { readRecord } from "./refs.js";
import { isPlainObject, localRefusals, transferError, type OmResult, type Refusal } from "./refusal.js";

/**
 * PR1 (№2943) — the probe of the engine: a diagnostic command, not a step of the pass and not a gate of a live run.
 *
 * On a private copy of a frozen snapshot it takes a few saved points of every packet task kind, rebuilds each request
 * with the engine's own readers and encoder and compares it with the saved exchange (free). Only with every paid limit
 * confirmed does it send the same wire through the adapter its exact environment names, keep the physical result
 * before any decoding and check the answer with E3 (paid). It writes no engine record anywhere: its report and its
 * receipts live in a directory of its own. A clean exit is never a permission to start a live pass.
 */
const UNIT = "PR1";
export const PROBE_REPORT_FORMAT = "omg-probe-report/v1" as const;
const RUN_FORMAT = "omg-probe-run/v1", SEND_FORMAT = "omg-probe-send/v1", RESULT_FORMAT = "omg-probe-result/v1";
export const PROBE_CODES = Object.freeze([
  "probe_request_invalid", "probe_source_unavailable", "probe_source_not_quiescent", "probe_copy_failed", "probe_project_missing",
  "probe_no_points", "probe_point_invalid", "probe_paid_not_confirmed", "probe_workspace_invalid", "probe_adapter_unresolved",
  "probe_paid_limit_exceeded", "probe_report_foreign", "probe_report_invalid", "probe_report_unwritable", "probe_report_busy",
  "probe_receipt_mismatch", "probe_send_unknown", "probe_stop_unproven", "probe_interrupted",
] as const);
export type ProbeCode = typeof PROBE_CODES[number];
export const PROBE_KINDS = Object.freeze(["fact", "input-field", "node-l2", "node-l3"] as const);
export type ProbeKind = typeof PROBE_KINDS[number];
const CONTINUATION = "+continuation", UNCLASSIFIED = "unclassified";
export const PROBE_GROUPS: readonly string[] = Object.freeze([...PROBE_KINDS, ...PROBE_KINDS.map(kind => `${kind}${CONTINUATION}`)]);
const DEFAULT_POINTS = 3;
export const PROBE_USAGE = [
  "Usage: npm start -- probe --source <frozen snapshot> --project <id> [--kind <group>]... [--points <n>] [--point <id|run>]...",
  "         [--replay] [--answer <point>=<file>]... [--report-dir <dir>]",
  "         [--paid --max-calls <n> --max-chars <n> --workspace <isolated dir> --report-dir <dir>]",
  "The source must be a frozen snapshot that no process writes while it is copied; a live database is never opened, and a",
  "changed, journaled or WAL-holding source is refused. Groups: fact, input-field, node-l2, node-l3, each also with +continuation.",
  "Without --paid no adapter is started. --max-chars counts the code units of every sent canonical wire, not tokens or money.",
  "A report directory is one experiment: its snapshot, working directory and sends; resumed elsewhere, or once a send of it could",
  "not be proved stopped, it sends nothing more.",
  "Exit 0: the requested diagnostics found no discrepancy and no refused point; it is not a permission to start a live pass.",
  "Exit 2: a discrepancy, an unreadable point, a refused answer or joint assembly, an unfinished paid send or a stopped directory.",
  "Exit 1: arguments, source, report directory or probe.",
].join("\n");

const refuse = localRefusals(PROBE_CODES);
/** The throw channel of this module: one of its own addressed refusals, nothing else. */
class ProbeFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: ProbeCode, target: string, field: string, message: string): never {
  const result = refuse(code, message, { unit: UNIT, target, field }, "producer");
  if (!result.ok) throw new ProbeFailure(result.refusal);
  throw new Error("Unreachable");
}
function probeRefusal(code: ProbeCode, target: string, field: string, message: string): Refusal {
  const result = refuse(code, message, { unit: UNIT, target, field }, "producer");
  if (result.ok) throw new Error("Unreachable");
  return result.refusal;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const object = (value: unknown): value is Record<string, any> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const order = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const now = (): number => performance.now();
type Role = "implementer" | "reviewer";
const isRole = (value: unknown): value is Role => value === "implementer" || value === "reviewer";

// ---- Options: one check for the CLI and the function, before any source, Store or process. ----

export interface ProbePaidOptions { readonly maxCalls: number; readonly maxChars: number; readonly workspace: string }
export interface ProbeAnswerOption { readonly point: string; readonly file: string }
/** Test seams only; the CLI never sets them. `beforeCommit` runs when a probe file's temporary copy is durable and has not yet replaced it. */
export interface ProbeTestHooks { readonly stop?: ProcessStopHooks; readonly afterCopy?: () => void; readonly beforeCommit?: (path: string) => void }
export interface ProbeOptions {
  readonly source: string; readonly project: string;
  readonly kinds?: readonly string[]; readonly points?: number; readonly select?: readonly string[];
  readonly replay?: boolean; readonly answers?: readonly ProbeAnswerOption[];
  readonly paid?: ProbePaidOptions | null; readonly reportDir?: string | null;
  readonly signal?: AbortSignal; readonly testHooks?: ProbeTestHooks;
}
interface CheckedOptions {
  source: string; project: string; kinds: string[] | null; points: number; select: string[]; replay: boolean;
  answers: ProbeAnswerOption[]; paid: ProbePaidOptions | null; reportDir: string | null; signal: AbortSignal | null;
  testHooks: ProbeTestHooks;
}
const OPTION_KEYS = ["source", "project", "kinds", "points", "select", "replay", "answers", "paid", "reportDir", "signal", "testHooks"];

function checkOptions(options: unknown): CheckedOptions {
  if (!object(options)) fail("probe_request_invalid", "probe", "options", "A probe names its source and project");
  const unknown = Object.keys(options).find(key => !OPTION_KEYS.includes(key));
  if (unknown !== undefined) fail("probe_request_invalid", unknown, unknown, "Unknown probe option");
  if (!text(options.source)) fail("probe_request_invalid", "source", "source", "--source names the frozen snapshot of the project database");
  if (!text(options.project)) fail("probe_request_invalid", "project", "project", "--project names the project of the snapshot");
  const kinds = options.kinds === undefined || options.kinds === null ? null : options.kinds;
  if (kinds !== null && (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !PROBE_GROUPS.includes(kind))))
    fail("probe_request_invalid", "kind", "kind", `--kind accepts ${PROBE_GROUPS.join(", ")}`);
  if (options.points !== undefined && !positive(options.points))
    fail("probe_request_invalid", "points", "points", "--points is a positive safe integer");
  const select = options.select ?? [];
  if (!Array.isArray(select) || select.some(item => !text(item)))
    fail("probe_request_invalid", "point", "point", "--point names a saved call, a saved packet or run");
  const answers = options.answers ?? [];
  if (!Array.isArray(answers) || answers.some(item => !object(item) || !text(item.point) || !text(item.file) || Object.keys(item).length !== 2))
    fail("probe_request_invalid", "answer", "answer", "--answer is <point>=<file>");
  if (options.replay !== undefined && typeof options.replay !== "boolean") fail("probe_request_invalid", "replay", "replay", "--replay is a switch");
  const reportDir = options.reportDir ?? null;
  if (reportDir !== null && !text(reportDir)) fail("probe_request_invalid", "report-dir", "report-dir", "--report-dir names a directory");
  const paid = options.paid ?? null;
  if (paid !== null) {
    if (!object(paid)) fail("probe_paid_not_confirmed", "paid", "paid", "A paid probe states every limit explicitly");
    const extra = Object.keys(paid).find(key => !["maxCalls", "maxChars", "workspace"].includes(key));
    if (extra !== undefined) fail("probe_request_invalid", extra, extra, "Unknown paid option");
    if (paid.maxCalls === undefined) fail("probe_paid_not_confirmed", "max-calls", "max-calls", "--paid needs --max-calls");
    if (paid.maxChars === undefined) fail("probe_paid_not_confirmed", "max-chars", "max-chars", "--paid needs --max-chars");
    if (paid.workspace === undefined) fail("probe_paid_not_confirmed", "workspace", "workspace", "--paid needs --workspace");
    if (!positive(paid.maxCalls)) fail("probe_request_invalid", "max-calls", "max-calls", "--max-calls is a positive safe integer");
    if (!positive(paid.maxChars)) fail("probe_request_invalid", "max-chars", "max-chars", "--max-chars is a positive safe integer");
    if (!text(paid.workspace)) fail("probe_paid_not_confirmed", "workspace", "workspace", "--workspace names an isolated working directory");
    if (reportDir === null) fail("probe_paid_not_confirmed", "report-dir", "report-dir", "--paid needs --report-dir for its receipts");
    if (answers.length) fail("probe_request_invalid", "answer", "answer", "--answer checks a supplied answer without an adapter; it is not combined with --paid");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail("probe_request_invalid", "signal", "signal", "A probe signal is an AbortSignal");
  const hooks = options.testHooks ?? {};
  if (!object(hooks)) fail("probe_request_invalid", "testHooks", "testHooks", "Test hooks are an object");
  return { source: options.source, project: options.project, kinds: kinds === null ? null : [...new Set(kinds as string[])],
    points: options.points ?? DEFAULT_POINTS, select: [...select], replay: options.replay ?? false,
    answers: answers.map(item => ({ point: item.point, file: item.file })),
    paid: paid === null ? null : { maxCalls: paid.maxCalls, maxChars: paid.maxChars, workspace: paid.workspace },
    reportDir, signal: options.signal ?? null, testHooks: hooks as ProbeTestHooks };
}

/** The command line of `probe`: syntax only; the meaning is checked by the same check as a direct call. */
export function parseProbeArgs(argv: readonly string[]): OmResult<ProbeOptions, ProbeCode> {
  try {
    const single = new Map<string, string>(), many = new Map<string, string[]>(), flags = new Set<string>();
    const valued = ["--source", "--project", "--points", "--max-calls", "--max-chars", "--workspace", "--report-dir"];
    const repeated = ["--kind", "--point", "--answer"], switches = ["--paid", "--replay"];
    for (let index = 0; index < argv.length; index++) {
      const flag = argv[index]!;
      if (switches.includes(flag)) {
        if (flags.has(flag)) fail("probe_request_invalid", flag, flag, `${flag} is given once`);
        flags.add(flag); continue;
      }
      if (!valued.includes(flag) && !repeated.includes(flag)) fail("probe_request_invalid", flag, flag, `Unknown argument ${flag}`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail("probe_request_invalid", flag, flag, `${flag} needs a value`);
      index++;
      if (repeated.includes(flag)) many.set(flag, [...(many.get(flag) ?? []), value]);
      else if (single.has(flag)) fail("probe_request_invalid", flag, flag, `${flag} is given once`);
      else single.set(flag, value);
    }
    const integer = (flag: string): number | undefined => {
      const value = single.get(flag);
      if (value === undefined) return undefined;
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) fail("probe_request_invalid", flag, flag, `${flag} is a positive safe integer`);
      return Number(value);
    };
    const answers = (many.get("--answer") ?? []).map(item => {
      const at = item.indexOf("=");
      if (at <= 0 || at === item.length - 1) fail("probe_request_invalid", "--answer", "--answer", "--answer is <point>=<file>");
      return { point: item.slice(0, at), file: item.slice(at + 1) };
    });
    const paid = flags.has("--paid");
    for (const flag of ["--max-calls", "--max-chars", "--workspace"]) if (!paid && single.has(flag))
      fail("probe_request_invalid", flag, flag, `${flag} belongs to a paid probe and needs --paid`);
    const options: ProbeOptions = {
      source: single.get("--source") ?? "", project: single.get("--project") ?? "",
      ...(many.has("--kind") ? { kinds: many.get("--kind")! } : {}),
      ...(single.has("--points") ? { points: integer("--points")! } : {}),
      select: many.get("--point") ?? [], replay: flags.has("--replay"), answers,
      paid: paid ? { maxCalls: integer("--max-calls") as number, maxChars: integer("--max-chars") as number, workspace: single.get("--workspace") as string } : null,
      reportDir: single.get("--report-dir") ?? null,
    };
    // Absent paid values stay absent here, so the common check names the missing one.
    if (options.paid) for (const [flag, key] of [["--max-calls", "maxCalls"], ["--max-chars", "maxChars"], ["--workspace", "workspace"]] as const)
      if (!single.has(flag)) delete (options.paid as unknown as Record<string, unknown>)[key];
    checkOptions(options);
    return { ok: true, value: options };
  } catch (error) {
    if (error instanceof ProbeFailure) return { ok: false, refusal: error.refusal as Refusal<ProbeCode> };
    throw error;
  }
}

// ---- Source: a frozen snapshot, copied read-only into a private directory; the Store opens only the copy. ----

interface SourceIdentity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; sha256: string }
export interface ProbeSnapshot { path: string; sha256: string; bytes: number; databaseId: string | null }
interface SourceCopy { snapshot: ProbeSnapshot; directory: string; database: string }

const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
function fileSha256(path: string): string {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1 << 20), fd = openSync(path, constants.O_RDONLY);
  try { for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}
function sourceIdentity(path: string): SourceIdentity {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256: fileSha256(path) };
}
/** A non-empty WAL or a journal with a live header means the snapshot is not at rest. */
function quiescent(path: string): string | null {
  const wal = lstatSync(`${path}-wal`, { throwIfNoEntry: false });
  if (wal && (!wal.isFile() || wal.size > 0)) return "wal";
  const journal = lstatSync(`${path}-journal`, { throwIfNoEntry: false });
  if (journal) {
    if (!journal.isFile()) return "journal";
    if (journal.size > 0) {
      const header = Buffer.alloc(JOURNAL_MAGIC.length), fd = openSync(`${path}-journal`, constants.O_RDONLY);
      try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
      if (header.equals(JOURNAL_MAGIC)) return "journal";
    }
  }
  return null;
}
async function copySource(source: string, afterCopy?: () => void): Promise<SourceCopy> {
  const path = resolve(source);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) fail("probe_source_unavailable", path, "source", "The snapshot does not exist");
  if (stat.isSymbolicLink()) fail("probe_source_unavailable", path, "source", "A symbolic link is not accepted as a snapshot");
  if (!stat.isFile()) fail("probe_source_unavailable", path, "source", "The snapshot must be a regular file");
  try { closeSync(openSync(path, constants.O_RDONLY)); }
  catch { fail("probe_source_unavailable", path, "source", "The snapshot cannot be read"); }
  const busy = quiescent(path);
  if (busy) fail("probe_source_not_quiescent", path, busy, "The snapshot has pending writes beside it; take a frozen copy first");
  const before = sourceIdentity(path);
  const directory = mkdtempSync(join(tmpdir(), "omg-probe-"));
  try {
    const database = join(directory, "copy.sqlite");
    let pages = 0;
    try {
      const reader = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
      try { pages = await backup(reader, database); } finally { reader.close(); }
    } catch (error) {
      fail("probe_copy_failed", path, "backup", `The snapshot could not be copied: ${error instanceof Error ? error.message : String(error)}`);
    }
    afterCopy?.();
    const after = lstatSync(path, { throwIfNoEntry: false });
    if (!after || after.isSymbolicLink() || !after.isFile()) fail("probe_source_not_quiescent", path, "source", "The snapshot was replaced while it was copied");
    const changed = quiescent(path);
    if (changed) fail("probe_source_not_quiescent", path, changed, "The snapshot gained pending writes while it was copied");
    const checked = sourceIdentity(path);
    if (!same(checked, before)) fail("probe_source_not_quiescent", path, "source", "The snapshot changed while it was copied");
    if (pages <= 0) fail("probe_copy_failed", path, "backup", "The copy holds no database pages");
    return { snapshot: { path, sha256: before.sha256, bytes: before.size, databaseId: null }, directory, database };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

// ---- Report directory: one exclusive owner, closed receipts, durable writes. ----

interface SendBinding {
  snapshot: string; project: string; point: string; packet: Ref; environment: Ref; role: Role;
  wire: { sha256: string; chars: number; bytes: number }; command: { executable: string; args: string[] };
  modules: { path: string; sha256: string }[]; cwd: string;
}
interface SendReceipt { format: typeof SEND_FORMAT; binding: SendBinding; reservation: { calls: 1; chars: number }; at: string }
interface StopEvidence { code: string; message: string; details: Json; physical: { exitCode: number | null; signal: string | null; stdout: string; stderr: string; complete: boolean } | null }
interface ResultReceipt {
  format: typeof RESULT_FORMAT; point: string; send: string; process: ProcessResult | null;
  launchError: { code: string; message: string } | null; stop: StopEvidence | null; at: string;
}
const HEX = /^[a-f0-9]{64}$/;
// The only names a report directory holds; a temporary copy is this probe's only by the exact name its own save gives it.
const OWN_NAMES = new Set(["lock.sqlite", "lock.sqlite-journal", "run.json", "report.json", "sends", "results"]);
const OWN_TMP = /^(run|report)\.json\.[1-9][0-9]*\.tmp$/, MANIFEST_TMP = /^run\.json\.[1-9][0-9]*\.tmp$/, REPORT_TMP = /^report\.json\.[1-9][0-9]*\.tmp$/;
const RECEIPT = /^[a-f0-9]{64}\.json$/, RECEIPT_TMP = /^[a-f0-9]{64}\.json\.[1-9][0-9]*\.tmp$/;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function writeDurable(path: string, body: string, beforeCommit?: (path: string) => void): void {
  const pending = `${path}.${process.pid}.tmp`;
  const fd = openSync(pending, "wx", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  beforeCommit?.(path);
  renameSync(pending, path);
  const folder = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(folder); } finally { closeSync(folder); }
}
function checkSend(value: unknown, snapshot: string, project: string, point: string): value is SendReceipt {
  if (!object(value) || !exactKeys(value, ["format", "binding", "reservation", "at"]) || value.format !== SEND_FORMAT || !text(value.at)) return false;
  const binding = value.binding, reservation = value.reservation;
  if (!object(binding) || !exactKeys(binding, ["snapshot", "project", "point", "packet", "environment", "role", "wire", "command", "modules", "cwd"])
    || binding.snapshot !== snapshot || binding.project !== project || binding.point !== point || !isRef(binding.packet) || !isRef(binding.environment)
    || !isRole(binding.role) || !text(binding.cwd) || !object(binding.wire) || !exactKeys(binding.wire, ["sha256", "chars", "bytes"])
    || !HEX.test(String(binding.wire.sha256)) || !positive(binding.wire.chars) || !positive(binding.wire.bytes)
    || !object(binding.command) || !exactKeys(binding.command, ["executable", "args"]) || !text(binding.command.executable)
    || !Array.isArray(binding.command.args) || !binding.command.args.every((arg: unknown) => typeof arg === "string")
    || !Array.isArray(binding.modules) || !binding.modules.every((item: unknown) => object(item) && exactKeys(item, ["path", "sha256"])
      && text(item.path) && HEX.test(String(item.sha256)))) return false;
  return object(reservation) && exactKeys(reservation, ["calls", "chars"]) && reservation.calls === 1 && reservation.chars === binding.wire.chars;
}
function checkProcess(value: unknown): value is ProcessResult {
  return object(value) && exactKeys(value, ["exitCode", "signal", "stdout", "stderr"]) && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
    && (value.signal === null || typeof value.signal === "string") && typeof value.stdout === "string" && typeof value.stderr === "string";
}
function checkResult(value: unknown, point: string, send: string): value is ResultReceipt {
  if (!object(value) || !exactKeys(value, ["format", "point", "send", "process", "launchError", "stop", "at"]) || value.format !== RESULT_FORMAT
    || value.point !== point || value.send !== send || !text(value.at)) return false;
  const outcomes = [value.process, value.launchError, value.stop].filter(item => item !== null).length;
  if (outcomes !== 1) return false;
  if (value.process !== null && !checkProcess(value.process)) return false;
  if (value.launchError !== null && !(object(value.launchError) && exactKeys(value.launchError, ["code", "message"])
    && text(value.launchError.code) && typeof value.launchError.message === "string")) return false;
  const stop = value.stop;
  return stop === null || object(stop) && exactKeys(stop, ["code", "message", "details", "physical"]) && text(stop.code) && typeof stop.message === "string"
    && (stop.physical === null || object(stop.physical) && exactKeys(stop.physical, ["exitCode", "signal", "stdout", "stderr", "complete"])
      && typeof stop.physical.stdout === "string" && typeof stop.physical.stderr === "string" && typeof stop.physical.complete === "boolean");
}

/** What a report directory holds, read without changing it. */
interface Found { manifest: boolean; tmp: string[]; sends: Map<string, { receipt: SendReceipt; sha256: string }>; results: Map<string, ResultReceipt> }
const ELSEWHERE = "choose another --report-dir";
function readJson(file: string, body?: Buffer): unknown {
  try { return JSON.parse((body ?? readFileSync(file)).toString("utf8")); }
  catch { return fail("probe_report_invalid", file, "json", `A probe file is not readable JSON; ${ELSEWHERE}`); }
}
/** The manifest this probe writes for a snapshot and project, byte for byte. */
const manifestBytes = (snapshot: string, project: string): string => `${canonical({ format: RUN_FORMAT, snapshot, project })}\n`;
/** A manifest is this probe's writing only when its bytes are exactly the canonical form of its three fields; a cut or foreign file is not. */
function readManifest(file: string, message: string): { snapshot: string; project: string } {
  const body = readFileSync(file).toString("utf8");
  let value: unknown = null;
  try { value = JSON.parse(body); } catch { value = null; }
  if (!object(value) || !exactKeys(value, ["format", "snapshot", "project"]) || value.format !== RUN_FORMAT || !HEX.test(String(value.snapshot))
    || !text(value.project) || body !== manifestBytes(value.snapshot, value.project)) fail("probe_report_invalid", file, "run.json", message);
  return { snapshot: value.snapshot as string, project: value.project as string };
}
/** This probe's lock is an empty regular file; SQLite keeps a journal beside it while, or since, a probe held it. */
function checkLock(path: string, names: readonly string[]): void {
  const lock = lstatSync(join(path, "lock.sqlite"), { throwIfNoEntry: false });
  if (lock && (!lock.isFile() || lock.size !== 0))
    fail("probe_report_foreign", join(path, "lock.sqlite"), "lock", `lock.sqlite here is not this probe's empty lock file; ${ELSEWHERE}`);
  if (names.includes("lock.sqlite-journal") && (!lock || !lstatSync(join(path, "lock.sqlite-journal")).isFile()))
    fail("probe_report_foreign", join(path, "lock.sqlite-journal"), "lock", `This lock journal has no lock of this probe beside it; ${ELSEWHERE}`);
}
/** Whether a probe holds the directory now, asked through a read-only connection that creates and changes nothing. */
function held(path: string): boolean {
  const file = join(path, "lock.sqlite"), stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size !== 0) return false;
  try {
    const reader = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    try { reader.prepare("SELECT count(*) FROM sqlite_master").get(); return false; } finally { reader.close(); }
  } catch (error) { return error instanceof Error && /locked|busy/i.test(error.message); }
}
function busy(path: string): never {
  return fail("probe_report_busy", path, "report-dir", `Another probe owns this report directory; wait for it to finish, or ${ELSEWHERE}`);
}
/**
 * Reads a whole report directory without changing it. Without its manifest a directory is new, or the start of this probe cut short:
 * its empty lock and at most one manifest whose bytes are this snapshot's and project's own. Every other state is refused as found.
 */
function inspectDirectory(path: string, snapshot: string, project: string): Found {
  const names = readdirSync(path).sort();
  const foreign = names.find(name => !OWN_NAMES.has(name) && !OWN_TMP.test(name));
  if (foreign !== undefined) fail("probe_report_foreign", join(path, foreign), "report-dir", `The directory holds files that are not this probe's; ${ELSEWHERE}`);
  checkLock(path, names);
  const manifests = names.filter(name => MANIFEST_TMP.test(name)), reports = names.filter(name => REPORT_TMP.test(name));
  const manifestPath = join(path, "run.json");
  if (!names.includes("run.json")) {
    const other = names.find(name => name !== "lock.sqlite" && name !== "lock.sqlite-journal" && !MANIFEST_TMP.test(name));
    if (other !== undefined) fail("probe_report_invalid", join(path, other), "run.json", `Probe files without the run manifest cannot be resumed; ${ELSEWHERE}`);
    if (manifests.length > 1) fail("probe_report_invalid", join(path, manifests[0]!), "run.json",
      `Several unfinished run manifests make the start ambiguous; remove them if those starts are abandoned, or ${ELSEWHERE}`);
    if (manifests.length === 1) {
      const file = join(path, manifests[0]!);
      const started = readManifest(file, `The unfinished run manifest is not one this probe writes; remove it if that start is abandoned, or ${ELSEWHERE}`);
      if (started.snapshot !== snapshot) fail("probe_report_foreign", file, "snapshot",
        `The unfinished start belongs to a probe of another snapshot; ${ELSEWHERE}, or remove this file if that start is abandoned`);
      if (started.project !== project) fail("probe_report_foreign", file, "project",
        `The unfinished start belongs to a probe of another project; ${ELSEWHERE}, or remove this file if that start is abandoned`);
    }
    // The only file a start removes is that one manifest, proved by its bytes to be this snapshot's and project's own.
    return { manifest: false, tmp: manifests, sends: new Map(), results: new Map() };
  }
  if (manifests.length) fail("probe_report_invalid", join(path, manifests[0]!), "run.json",
    `An unfinished run manifest beside the saved one is not this probe's; remove it, or ${ELSEWHERE}`);
  if (reports.length > 1) fail("probe_report_invalid", join(path, reports[0]!), "report.json", `Several unfinished reports are not this probe's; remove them, or ${ELSEWHERE}`);
  const run = readManifest(manifestPath, `The run manifest is damaged; ${ELSEWHERE}`);
  if (run.snapshot !== snapshot) fail("probe_report_foreign", manifestPath, "snapshot", `The directory belongs to a probe of another snapshot; ${ELSEWHERE}`);
  if (run.project !== project) fail("probe_report_foreign", manifestPath, "project", `The directory belongs to a probe of another project; ${ELSEWHERE}`);
  const unfinished: { folder: "sends" | "results"; name: string }[] = [];
  const receipts = (folder: "sends" | "results"): string[] => {
    const folderPath = join(path, folder), stat = lstatSync(folderPath, { throwIfNoEntry: false });
    if (!stat) return [];
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("probe_report_invalid", folderPath, folder, `Receipts live in a real directory; ${ELSEWHERE}`);
    const files: string[] = [];
    for (const name of readdirSync(folderPath).sort()) {
      if (RECEIPT_TMP.test(name)) unfinished.push({ folder, name });
      else if (RECEIPT.test(name)) files.push(name);
      else fail("probe_report_foreign", join(folderPath, name), folder, `Not a receipt of this probe; ${ELSEWHERE}`);
    }
    return files;
  };
  const found: Found = { manifest: true, tmp: [...reports], sends: new Map(), results: new Map() };
  for (const name of receipts("sends")) {
    const file = join(path, "sends", name), point = name.slice(0, -".json".length), body = readFileSync(file);
    const value = readJson(file, body);
    if (!checkSend(value, snapshot, project, point)) fail("probe_report_invalid", file, "send", `The send receipt is damaged or belongs to another point; ${ELSEWHERE}`);
    found.sends.set(point, { receipt: value, sha256: digest(body) });
  }
  for (const name of receipts("results")) {
    const file = join(path, "results", name), point = name.slice(0, -".json".length), send = found.sends.get(point);
    if (!send) fail("probe_report_invalid", file, "send", `A result needs the send receipt it settles; ${ELSEWHERE}`);
    const value = readJson(file);
    if (!checkResult(value, point, send.sha256)) fail("probe_report_invalid", file, "result", `The result receipt is damaged or settles another send; ${ELSEWHERE}`);
    found.results.set(point, value);
  }
  // An unfinished receipt is this probe's only where its save can be cut short: a send not yet authorized, or the result of an authorized one.
  const keys = new Set<string>();
  for (const { folder, name } of unfinished) {
    const key = name.slice(0, 64);
    const leaves = folder === "sends" ? !found.sends.has(key) && !found.results.has(key) : found.sends.has(key) && !found.results.has(key);
    if (!leaves || keys.has(key)) fail("probe_report_invalid", join(path, folder, name), folder, `This unfinished receipt is not one this probe leaves; remove it, or ${ELSEWHERE}`);
    keys.add(key); found.tmp.push(join(folder, name));
  }
  return found;
}

class ReportDirectory {
  readonly sends = new Map<string, { receipt: SendReceipt; sha256: string }>();
  readonly results = new Map<string, ResultReceipt>();
  /** The point of a saved send whose process group could not be proved stopped: the probe of this directory stays stopped. */
  stopped: string | null = null;
  /** Sends this run authorized; a run refused before any of them leaves the directory as it found it. */
  authorized = 0;
  private pending: string[] = [];
  private ready = false;
  private constructor(readonly path: string, private readonly lock: DatabaseSync, private readonly beforeCommit?: (path: string) => void) {}

  /** Creates or resumes the directory of one run of one snapshot; any foreign, damaged or busy state refuses before a send. */
  static open(directory: string, snapshot: string, project: string, beforeCommit?: (path: string) => void): ReportDirectory {
    const path = resolve(directory);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) fail("probe_report_foreign", path, "report-dir", `The report directory must be a real directory; ${ELSEWHERE}`);
    if (!stat) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { fail("probe_report_unwritable", path, "report-dir", `The report directory cannot be created: ${(error as Error).message}`); }
    }
    // A probe at work here may be in the middle of its own start: its lock is asked first, through a connection that changes nothing,
    // and asked again when the files refuse, so that a start in progress is never taken for a damaged one.
    if (held(path)) busy(path);
    // A foreign, damaged or other snapshot's directory is refused as it was found: not even a lock file is added to it.
    try { inspectDirectory(path, snapshot, project); }
    catch (error) { if (error instanceof ProbeFailure && held(path)) busy(path); throw error; }
    let lock: DatabaseSync;
    try {
      lock = new DatabaseSync(join(path, "lock.sqlite"), { timeout: 0 });
      lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (error instanceof Error && /locked|busy/i.test(error.message)) busy(path);
      fail("probe_report_unwritable", path, "report-dir", `The report directory cannot be owned: ${(error as Error).message}`);
    }
    const opened = new ReportDirectory(path, lock, beforeCommit);
    try { opened.load(snapshot, project); } catch (error) { opened.close(); throw error; }
    return opened;
  }
  private load(snapshot: string, project: string): void {
    // Owned now, the directory is read again: whatever was checked before the lock may have changed until it was taken.
    const found = inspectDirectory(this.path, snapshot, project);
    for (const [point, send] of found.sends) this.sends.set(point, send);
    for (const [point, result] of found.results) {
      this.results.set(point, result);
      if (result.stop !== null && this.stopped === null) this.stopped = point;
    }
    this.pending = found.tmp;
    // A new directory, or an interrupted start of this probe, is set up at once; a resumed one is first written by its run's first save.
    if (!found.manifest) this.prepare({ snapshot, project });
  }
  /** Before this run's first write: the interrupted saves of its own predecessor are removed, the manifest and receipt folders exist. */
  private prepare(manifest?: { snapshot: string; project: string }): void {
    if (this.ready) return;
    try {
      for (const name of this.pending) rmSync(join(this.path, name), { force: true });
      this.pending = [];
      if (manifest) writeDurable(join(this.path, "run.json"), manifestBytes(manifest.snapshot, manifest.project), this.beforeCommit);
      for (const folder of ["sends", "results"])
        if (!lstatSync(join(this.path, folder), { throwIfNoEntry: false })) mkdirSync(join(this.path, folder), { mode: 0o700 });
      this.ready = true;
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      fail("probe_report_unwritable", this.path, "report-dir", `The report directory cannot be written: ${(error as Error).message}`);
    }
  }
  reserved(): { calls: number; chars: number } {
    let calls = 0, chars = 0;
    for (const { receipt } of this.sends.values()) { calls += receipt.reservation.calls; chars += receipt.reservation.chars; }
    return { calls, chars };
  }
  /** The durable permission and reserve of one send, written before the request crosses into the adapter. */
  authorize(point: string, receipt: SendReceipt): void {
    this.prepare();
    const body = `${canonical(receipt)}\n`;
    writeDurable(join(this.path, "sends", `${point}.json`), body, this.beforeCommit);
    this.sends.set(point, { receipt, sha256: digest(body) });
    this.authorized++;
  }
  settle(point: string, receipt: ResultReceipt): void {
    this.prepare();
    writeDurable(join(this.path, "results", `${point}.json`), `${canonical(receipt)}\n`, this.beforeCommit);
    this.results.set(point, receipt);
  }
  writeReport(report: ProbeReport): void {
    this.prepare();
    writeDurable(join(this.path, "report.json"), `${JSON.stringify(report, null, 1)}\n`, this.beforeCommit);
  }
  close(): void { try { this.lock.close(); } catch { /* the lock dies with the connection */ } }
}

// ---- Points: candidates from saved records, grouped by kind, chosen deterministically. ----

type Origin = "call" | "packet" | "run" | "explicit";
interface Candidate {
  key: string; packet: Ref | null; role: Role | null; group: string; calls: Ref[]; origins: Set<Origin>;
  time: number | null; chars: number | null; specs: string[];
}
const pointKey = (packet: Ref, role: Role): string => hashJson({ packet, role });
const orphanKey = (call: Ref): string => hashJson({ call });

interface RunPoint { state: "absent" | "readable" | "refused"; phase: string | null; action: string | null; refusal: Refusal | null; packet: Ref | null; role: Role | null }

function groupOf(store: Store, project: string, packet: Ref | null, routes: Map<string, ReturnType<typeof readRoutes>>): { group: string; chars: number | null } {
  if (!packet) return { group: UNCLASSIFIED, chars: null };
  const raw = store.get<QuestionPacketRecord>(packet.id, packet.revision);
  if (!raw || raw.kind !== "question-packet" || !object(raw.value) || !object(raw.value.request) || !isRef(raw.value.request.routes))
    return { group: UNCLASSIFIED, chars: null };
  const value = raw.value, key = canonical(value.request.routes);
  if (!routes.has(key)) routes.set(key, readRoutes(store, { project, record: value.request.routes }));
  const read = routes.get(key)!;
  const batch = read.ok ? read.value.record.value.batches.find(item => item.id === value.request.batch) : undefined;
  const chars = object(value.fingerprint) && positive(value.fingerprint.chars) ? value.fingerprint.chars : null;
  if (!batch) return { group: UNCLASSIFIED, chars };
  const kind: ProbeKind | null = batch.model === "MC1" ? "fact" : batch.task === "input-field" ? "input-field"
    : batch.task === "node-expansion" && batch.level === 2 ? "node-l2" : batch.task === "node-expansion" && batch.level === 3 ? "node-l3" : null;
  if (!kind) return { group: UNCLASSIFIED, chars };
  return { group: object(value.request.continuation) ? `${kind}${CONTINUATION}` : kind, chars };
}

function enumerate(store: Store, project: string): { candidates: Map<string, Candidate>; run: RunPoint } {
  const candidates = new Map<string, Candidate>(), routes = new Map<string, ReturnType<typeof readRoutes>>();
  const add = (packet: Ref | null, role: Role | null, origin: Origin, call: Ref | null, time: number | null): Candidate => {
    const key = packet && role ? pointKey(packet, role) : orphanKey(call!);
    let found = candidates.get(key);
    if (!found) {
      const { group, chars } = groupOf(store, project, packet, routes);
      found = { key, packet, role, group, calls: [], origins: new Set(), time: null, chars, specs: [] };
      candidates.set(key, found);
    }
    found.origins.add(origin);
    if (call && !found.calls.some(item => same(item, call))) found.calls.push(call);
    if (time !== null && (found.time === null || time < found.time)) found.time = time;
    return found;
  };
  for (const row of store.list<Record<string, any>>("model-call")) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!row.id.startsWith(`model-call:${project}:om:`) || !object(row.value) || !object(row.value.om) || Object.hasOwn(row.value, "transport")) continue;
    const request = row.value.om.request, call = reference(row);
    const time = Number.isSafeInteger(row.value.startedAt) ? row.value.startedAt as number : null;
    if (object(request) && isRef(request.packet) && isRole(request.role)) add(request.packet, request.role, "call", call, time);
    else add(null, null, "call", call, time);
  }
  for (const row of store.list("question-packet"))
    if (row.id.startsWith(`om-question-packet:${project}:`)) add(reference(row), "implementer", "packet", null, null);
  const run: RunPoint = { state: "absent", phase: null, action: null, refusal: null, packet: null, role: null };
  const saved = readRun(store, { project });
  if (!saved.ok) { run.state = "refused"; run.refusal = saved.refusal; }
  else if (saved.value) {
    const state = saved.value.value.state as { phase: string; step?: { action: string; request: unknown } };
    run.state = "readable"; run.phase = state.phase; run.action = state.step?.action ?? null;
    const request = state.step?.request;
    if (state.phase === "step" && state.step?.action === "cycle" && object(request) && request.project === project && isRef(request.packet) && isRole(request.role)) {
      run.packet = request.packet; run.role = request.role;
      add(request.packet, request.role, "run", null, null);
    }
  }
  return { candidates, run };
}

/** An explicit point: a saved OM call or packet of this project (optionally at an exact revision and hash), or run. */
function resolveSpec(store: Store, project: string, spec: string, candidates: Map<string, Candidate>, run: RunPoint): Candidate {
  if (spec === "run") {
    if (!run.packet || !run.role) fail("probe_point_invalid", spec, "point", "The project has no saved next cycle of its pass");
    const found = candidates.get(pointKey(run.packet, run.role))!;
    found.origins.add("explicit"); found.specs.push(spec);
    return found;
  }
  const match = /^([^@#]+)(?:@([1-9][0-9]*)(?:#([a-f0-9]{64}))?)?$/.exec(spec);
  if (!match) fail("probe_point_invalid", spec, "point", "A point is <id>, <id>@<revision> or <id>@<revision>#<sha256>");
  const [, id, revisionText, hash] = match as unknown as [string, string, string | undefined, string | undefined];
  const call = id.startsWith(`model-call:${project}:om:`), packet = id.startsWith(`om-question-packet:${project}:`);
  if (!call && !packet) {
    const foreign = /^(model-call:[^:]+:om:|om-question-packet:[^:]+:)/.test(id);
    fail("probe_point_invalid", spec, "point", foreign ? "The point belongs to another project" : "A point is a saved OM call or packet of this project");
  }
  const revision = revisionText === undefined ? undefined : Number(revisionText);
  const row = store.get(id, revision);
  if (!row) fail("probe_point_invalid", spec, "point", "No saved record exists at this point");
  if (row.kind !== (call ? "model-call" : "question-packet")) fail("probe_point_invalid", spec, "point", `The record is a ${row.kind}, not a point`);
  const ref: Ref = hash === undefined ? reference(row) : { id: row.id, revision: row.revision, hash };
  let found: Candidate;
  if (packet) {
    const key = pointKey(ref, "implementer");
    found = candidates.get(key) ?? (() => {
      const created: Candidate = { key, packet: ref, role: "implementer", group: groupOf(store, project, ref, new Map()).group, calls: [],
        origins: new Set(), time: null, chars: null, specs: [] };
      candidates.set(key, created); return created;
    })();
  } else {
    const value = row.value as Record<string, unknown>;
    if (!object(value) || !object(value.om) || Object.hasOwn(value, "transport")) fail("probe_point_invalid", spec, "point", "The call is not an OM packet call");
    const request = (value.om as Record<string, unknown>).request;
    const target = object(request) && isRef(request.packet) && isRole(request.role) ? pointKey(request.packet, request.role) : orphanKey(ref);
    found = candidates.get(target) ?? (() => {
      const created: Candidate = { key: target, packet: object(request) && isRef(request.packet) ? request.packet : null,
        role: object(request) && isRole(request.role) ? request.role : null, group: UNCLASSIFIED, calls: [], origins: new Set(), time: null, chars: null, specs: [] };
      if (created.packet) created.group = groupOf(store, project, created.packet, new Map()).group;
      candidates.set(target, created); return created;
    })();
    if (!found.calls.some(item => same(item, ref))) found.calls.push(ref);
  }
  found.origins.add("explicit"); found.specs.push(spec);
  return found;
}

export const SELECTION_RULE = "Within each group points are ordered by the start of their earliest saved call (points without a call follow, "
  + "the pass's saved next cycle last), ties by point key; the first, the largest saved request (ties: the earlier) and the last are chosen, then the rest in order, "
  + "up to the per-group limit; points equal by packet and role are one point; explicit points are always included.";
interface Coverage { group: string; candidates: number; selected: number; status: "covered" | "absent" | "filtered" }
interface Chosen { candidate: Candidate; reasons: string[] }

function select(candidates: Map<string, Candidate>, explicit: Candidate[], options: CheckedOptions): { chosen: Chosen[]; coverage: Coverage[] } {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates.values()) groups.set(candidate.group, [...(groups.get(candidate.group) ?? []), candidate]);
  // A saved call orders by its start; a packet without one follows; the pass's next cycle, never performed yet, comes last.
  const rank = (candidate: Candidate) => candidate.time !== null ? 0 : candidate.origins.has("run") ? 2 : 1;
  const chosen: Chosen[] = [], coverage: Coverage[] = [];
  for (const group of [...PROBE_GROUPS, UNCLASSIFIED]) {
    const members = [...(groups.get(group) ?? [])].sort((left, right) => rank(left) - rank(right)
      || (left.time ?? 0) - (right.time ?? 0) || order(left.key, right.key));
    const filtered = options.kinds !== null && !options.kinds.includes(group) && group !== UNCLASSIFIED;
    if (!members.length) { if (group !== UNCLASSIFIED) coverage.push({ group, candidates: 0, selected: 0, status: "absent" }); continue; }
    if (filtered) { coverage.push({ group, candidates: members.length, selected: 0, status: "filtered" }); continue; }
    const largest = members.reduce((best, item) => (item.chars ?? -1) > (best.chars ?? -1) ? item : best, members[0]!);
    const picks: Chosen[] = [];
    const take = (candidate: Candidate, reason: string) => {
      const existing = picks.find(item => item.candidate === candidate);
      if (existing) existing.reasons.push(reason); else picks.push({ candidate, reasons: [reason] });
    };
    take(members[0]!, "first"); take(largest, "largest"); take(members.at(-1)!, "last");
    for (const member of members) if (!picks.some(item => item.candidate === member)) picks.push({ candidate: member, reasons: ["order"] });
    const limited = picks.slice(0, options.points);
    chosen.push(...limited);
    coverage.push({ group, candidates: members.length, selected: limited.length, status: "covered" });
  }
  for (const candidate of explicit) {
    const existing = chosen.find(item => item.candidate === candidate);
    if (existing) { if (!existing.reasons.includes("explicit")) existing.reasons.push("explicit"); }
    else chosen.push({ candidate, reasons: ["explicit"] });
  }
  return { chosen, coverage };
}

// ---- Examination: the engine's own readers, encoder and E3; nothing is written. ----

/** The sent body: canonical JSON measured in code units and UTF-8 bytes, the prompt alone, its hash and the packet's own request id. */
export interface WireMetrics { requestId: string; chars: number; bytes: number; promptChars: number; promptBytes: number; sha256: string }
export interface WireDifference { offset: number; field: string | null; saved: string; built: string }
/** The first difference of two canonical wires: its code-unit offset and the first differing wire field. */
export function wireDifference(saved: string, built: string): WireDifference | null {
  if (saved === built) return null;
  let offset = 0;
  while (offset < saved.length && offset < built.length && saved[offset] === built[offset]) offset++;
  let field: string | null = null;
  try {
    const left = JSON.parse(saved) as Record<string, unknown>, right = JSON.parse(built) as Record<string, unknown>;
    field = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(order)
      .find(key => !Object.hasOwn(left, key) || !Object.hasOwn(right, key) || !same(left[key], right[key])) ?? null;
  } catch { field = null; }
  const window = (value: string) => value.slice(Math.max(0, offset - 16), offset + 48);
  return { offset, field, saved: window(saved), built: window(built) };
}
function metrics(wire: AdapterRequest): WireMetrics {
  const body = canonical(wire);
  return { requestId: wire.requestId, chars: body.length, bytes: Buffer.byteLength(body), promptChars: wire.prompt.length, promptBytes: Buffer.byteLength(wire.prompt),
    sha256: digest(body) };
}

export type AcceptanceReport =
  | { ok: true; kind: CheckedAnswerForm["kind"]; unanswered: string[]; detail: Json }
  | { ok: false; refusal: Refusal; rule: { list: "rules" | "refusals"; code: string; row: string | null } | null };
function acceptance(store: Store, project: string, packet: Revision<QuestionPacketRecord>, raw: string): { report: AcceptanceReport; outcome: CheckedAnswerForm | null } {
  const checked = guarded("answer-form", packet.id, "answer", () => checkAnswerForm(store, { project, packet: reference(packet), raw }));
  if (!checked.ok) {
    // A rule is named only when the packet's own list holds this exact code, or a retry row this exact code and address.
    const payload = (object(packet.value.packet) ? packet.value.packet : {}) as Record<string, unknown>;
    const rules = Array.isArray(payload.rules) ? payload.rules as string[] : [];
    const retries = Array.isArray(payload.refusals) ? payload.refusals as unknown as RetryRefusal[] : [];
    const retry = retries.find(row => row.code === checked.refusal.code && row.target === checked.refusal.at.target && row.field === checked.refusal.at.field);
    const rule = retry ? { list: "refusals" as const, code: retry.code, row: retry.row }
      : rules.includes(checked.refusal.code) ? { list: "rules" as const, code: checked.refusal.code, row: null } : null;
    return { report: { ok: false, refusal: checked.refusal, rule }, outcome: null };
  }
  const outcome = checked.value as CheckedAnswerForm;
  const detail: Json = outcome.kind === "node-proposal" ? { nodes: outcome.proposal.nodes.map(node => node.id), fills: outcome.proposal.fills.length,
      proposal: hashJson(outcome.proposal), bindings: outcome.works ? outcome.works.bindings.length : null }
    : outcome.kind === "fact-candidates" ? { facts: outcome.facts.map(fact => fact.questionId) }
    : outcome.kind === "input-decisions" ? { decisions: outcome.decisions.length }
    : outcome.kind === "need-source" ? { questions: outcome.questionIds, missing: outcome.missing, reads: outcome.reads.length }
    : outcome.kind === "awaiting-owner" ? { questions: outcome.questionIds, reason: outcome.reason, decision: outcome.decision }
    : { questions: outcome.questionIds, action: outcome.action, reason: outcome.reason };
  return { report: { ok: true, kind: outcome.kind, unanswered: [...outcome.unanswered], detail }, outcome };
}
const substantive = (report: AcceptanceReport | null | undefined): boolean => !!report && report.ok
  && ["node-proposal", "fact-candidates", "input-decisions"].includes(report.kind) && report.unanswered.length === 0;

/** An EngineError thrown by a reader becomes that reader's addressed refusal; nothing else is caught. */
function guarded<T>(source: string, target: string, field: string, read: () => OmResult<T>): OmResult<T> {
  try { return read(); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return transferError(source, error, { unit: UNIT, target, field }, "producer");
  }
}

interface CallReport {
  call: Ref; readable: boolean; refusal: Refusal | null; application: string | null; exchange: Ref | null;
  transport: string | null; wire: "equal" | "differs" | "none"; difference: WireDifference | null;
  replay: { acceptance: AcceptanceReport | null; transport: string; saved: { application: string; error: string | null }; verdict: "same" | "changed" | "unsettled" } | null;
}
type Readable = { ok: true; state: string; refusal: Refusal | null; ms: number } | { ok: false; refusal: Refusal; ms: number };
type Admission = { ok: true; record: Ref; existing: boolean; equalsHistorical: boolean; writes: number; readBack: Refusal | null; wire: WireMetrics | null; ms: number }
  | { ok: false; refusal: Refusal; ms: number };
export interface PaidReport {
  state: "sent" | "reused" | "unknown" | "not-sent";
  /** Why a chosen point is not offered to the adapter at all: its free check failed, or it is an unchosen continuation. */
  reason: "unreadable" | "no_wire" | "differs" | "continuation" | null;
  refusal: Refusal | null;
  /** The send receipt that fixes this point's wire, adapter path and module bytes and working directory (relative to the report directory). */
  receipt: string | null;
  transport: { kind: string; error: { code: string; field: string | null; message: string } | null; usage: TokenUsage | null;
    exitCode: number | null; signal: string | null; seconds: number | null } | null;
  acceptance: AcceptanceReport | null;
}
export interface PointReport {
  key: string; group: string; origins: Origin[]; chosen: string[]; specs: string[];
  packet: Ref | null; role: Role | null; environment: Ref | null;
  readable: Readable | null; environmentRefusal: Refusal | null; wireRefusal: Refusal | null; calls: CallReport[];
  wire: WireMetrics | null; capacity: number | null; admission: Admission | null;
  verdict: "equal" | "differs" | "sized" | "unreadable" | "no_wire";
  answer: { file: string; sha256: string; acceptance: AcceptanceReport } | null;
  paid: PaidReport | null; complete: boolean;
}
/** A node proposal E3 accepted at a point, with the exact frame basis it was checked against. */
interface AcceptedProposal { point: string; origin: "answer" | "replay" | "paid"; outcome: Extract<CheckedAnswerForm, { kind: "node-proposal" }>; frame: PointFrame }
interface PointFrame { level: 2 | 3; source: ProposalRequest }
interface Examined {
  report: PointReport; record: Revision<QuestionPacketRecord> | null; environment: Revision<Environment> | null;
  wire: AdapterRequest | null; body: string | null; frame: PointFrame | null; accepted: AcceptedProposal[];
}

function examine(store: Store, project: string, chosen: Chosen, options: CheckedOptions, answer: { file: string; body: string } | null): Examined {
  const candidate = chosen.candidate;
  const report: PointReport = { key: candidate.key, group: candidate.group, origins: [...candidate.origins].sort(order), chosen: chosen.reasons,
    specs: candidate.specs, packet: candidate.packet, role: candidate.role, environment: null, readable: null, environmentRefusal: null,
    wireRefusal: null, calls: [], wire: null, capacity: null, admission: null, verdict: "unreadable", answer: null, paid: null, complete: false };
  const result: Examined = { report, record: null, environment: null, wire: null, body: null, frame: null, accepted: [] };
  const saved = new Map<string, string>();
  const transports = new Map<string, { transport: AdapterResult; application: string; error: string | null }>();
  for (const call of candidate.calls) {
    const entry: CallReport = { call, readable: false, refusal: null, application: null, exchange: null, transport: null, wire: "none", difference: null, replay: null };
    report.calls.push(entry);
    const physical = guarded("model-call", call.id, "call", () => readModelCallPhysical(store, { project, record: call }));
    if (!physical.ok) { entry.refusal = physical.refusal; continue; }
    const value = physical.value.record.value;
    entry.readable = true; entry.application = value.om.application; entry.transport = physical.value.transport?.kind ?? null;
    if (physical.value.transport) transports.set(call.id, { transport: physical.value.transport as AdapterResult, application: value.om.application, error: value.error });
    if (isRef(value.om.exchange)) {
      // The physical reader has proved this exchange belongs to the call; only now is its wire read.
      entry.exchange = value.om.exchange;
      const exchange = readRecord<{ wire: Json }>(store, value.om.exchange, { unit: UNIT, target: call.id, id: value.om.exchange.id, kind: "om-model-exchange" });
      if (!exchange.ok) { entry.readable = false; entry.refusal = exchange.refusal; continue; }
      saved.set(call.id, canonical((exchange.value.value as { wire: Json }).wire));
    }
  }
  if (!candidate.packet || !candidate.role) return result;
  const started = now();
  const historical = guarded("question-packet", candidate.packet.id, "packet", () => readQuestionPacket(store, { project, record: candidate.packet! }));
  if (!historical.ok) { report.readable = { ok: false, refusal: historical.refusal, ms: Math.round(now() - started) }; return result; }
  const record = historical.value as Revision<QuestionPacketRecord>;
  result.record = record;
  report.readable = { ok: true, state: record.value.state, refusal: record.value.refusal, ms: Math.round(now() - started) };
  result.frame = frameOf(store, project, record);
  const environmentRef = record.value.request.environment;
  report.environment = environmentRef;
  let environment: Revision<Environment> | null = null;
  try { environment = readEnvironmentAt(store, project, environmentRef); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    const moved = transferError("environment", error, { unit: UNIT, target: environmentRef.id, field: "environment" }, "producer");
    if (!moved.ok) report.environmentRefusal = moved.refusal;
  }
  result.environment = environment;
  if (environment) report.capacity = environment.value.requestCapacityChars ?? null;
  const payload = record.value.packet as Record<string, Json> | null;
  if (environment && record.value.state === "ready" && object(payload) && text(payload.requestId)) {
    const binding = environment.value[candidate.role];
    const built = guarded("model-call", record.id, "wire", () => adapterRequest({ requestId: payload.requestId as string, packet: payload, model: binding.model,
      effort: binding.effort, ...(binding.speed === undefined ? {} : { speed: binding.speed }) }));
    if (!built.ok) report.wireRefusal = built.refusal;
    else {
      result.wire = built.value as AdapterRequest; result.body = canonical(built.value);
      report.wire = metrics(result.wire);
      for (const entry of report.calls) {
        const savedWire = saved.get(entry.call.id);
        if (savedWire === undefined) continue;
        entry.difference = wireDifference(savedWire, result.body);
        entry.wire = entry.difference ? "differs" : "equal";
      }
    }
  }
  const admissionStarted = now();
  const current = guarded("question-packet", record.id, "admission", () => prepareQuestionPacket(store, record.value.request as QuestionPacketRequest));
  if (!current.ok) report.admission = { ok: false, refusal: current.refusal, ms: Math.round(now() - admissionStarted) };
  else {
    const prepared = current.value.record as Revision<QuestionPacketRecord>, equal = same(reference(prepared), candidate.packet);
    let readBack: Refusal | null = null, wire: WireMetrics | null = null;
    if (!equal) {
      // A current record that differs from the historical one is proved through the common reader over its pending writes.
      const view = pendingCallStore(store, current.value.writes as Write[]);
      const read = guarded("question-packet", prepared.id, "admission", () => readQuestionPacket(view, { project, record: reference(prepared) }));
      if (!read.ok) readBack = read.refusal;
      else if (environment && read.value.value.state === "ready" && object(read.value.value.packet)) {
        const payloadNow = read.value.value.packet as unknown as Record<string, Json>, binding = environment.value[candidate.role];
        const encoded = adapterRequest({ requestId: String(payloadNow.requestId), packet: payloadNow, model: binding.model, effort: binding.effort,
          ...(binding.speed === undefined ? {} : { speed: binding.speed }) });
        if (encoded.ok) wire = metrics(encoded.value as AdapterRequest);
      }
    }
    report.admission = { ok: true, record: reference(prepared), existing: current.value.existing, equalsHistorical: equal,
      writes: current.value.writes.length, readBack, wire, ms: Math.round(now() - admissionStarted) };
  }
  if (options.replay) for (const entry of report.calls) {
    const saved = transports.get(entry.call.id);
    if (!saved) continue;
    const checked = saved.transport.kind === "answered" ? acceptance(store, project, record, saved.transport.raw) : null;
    if (checked) keep(result, "replay", checked.outcome);
    const accepted = checked?.report ?? null;
    const code = accepted === null ? (saved.transport.kind === "answered" ? null : saved.transport.error.code) : accepted.ok ? null : accepted.refusal.code;
    entry.replay = { acceptance: accepted, transport: saved.transport.kind, saved: { application: saved.application, error: saved.error },
      verdict: replayVerdict(saved.application, saved.error, code) };
  }
  if (answer) {
    const checked = acceptance(store, project, record, answer.body);
    keep(result, "answer", checked.outcome);
    report.answer = { file: answer.file, sha256: digest(answer.body), acceptance: checked.report };
  }
  return result;
}

/** The frame a node point was assigned on: its exact routed D1 sources at the batch's level; null for other tasks. */
function frameOf(store: Store, project: string, record: Revision<QuestionPacketRecord>): PointFrame | null {
  const routes = guarded("routes", record.id, "routes", () => readRoutes(store, { project, record: record.value.request.routes }));
  if (!routes.ok) return null;
  const batch = routes.value.record.value.batches.find(item => item.id === record.value.request.batch);
  if (!batch || batch.task !== "node-expansion" || (batch.level !== 2 && batch.level !== 3)) return null;
  const sources = routes.value.record.value.request.gaps.sources, source = batch.level === 2 ? sources.operations : sources.works;
  if (!object(source) || "state" in source) return null;
  return { level: batch.level, source: JSON.parse(canonical(source)) as ProposalRequest };
}
function keep(examined: Examined, origin: AcceptedProposal["origin"], outcome: CheckedAnswerForm | null): void {
  if (outcome?.kind === "node-proposal" && examined.frame)
    examined.accepted.push({ point: examined.report.key, origin, outcome, frame: examined.frame });
}
/**
 * A replayed answer against its saved application. Only an applied call holds a decided outcome: E4 applies a refusal only
 * when the historical E3 gives the same one, and leaves a call received when only today's admission refused it. So under the
 * code that saved it a replay reads the same; "changed" means the snapshot was decided by another era of the rules.
 */
export function replayVerdict(application: string, savedError: string | null, replayed: string | null): "same" | "changed" | "unsettled" {
  return application === "applied" ? (replayed === savedError ? "same" : "changed") : "unsettled";
}
function verdictOf(report: PointReport): PointReport["verdict"] {
  if (!report.readable?.ok || report.environmentRefusal || report.wireRefusal || report.calls.some(call => !call.readable)) return "unreadable";
  if (report.readable.state !== "ready" || !report.wire) return "no_wire";
  if (report.calls.some(call => call.wire === "differs")) return "differs";
  return report.calls.some(call => call.wire === "equal") ? "equal" : "sized";
}

// ---- Paid sends: an explicit, limited experiment in an isolated directory; one reserve, one result, never a resend. ----

interface Adapter { command: Command; modules: { path: string; sha256: string }[] }
const within = (inner: string, outer: string): boolean => {
  const path = relative(outer, inner);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const realOrResolved = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
/** The isolated working directory: not the project's workspace or inside it, and holding neither the snapshot nor the report. */
function checkWorkspace(workspace: string, environments: readonly Environment[], source: string, reportDir: string): string {
  let real: string;
  try { real = realpathSync(workspace); } catch { return fail("probe_workspace_invalid", resolve(workspace), "workspace", "The isolated working directory does not exist"); }
  if (!statSync(real).isDirectory()) fail("probe_workspace_invalid", real, "workspace", "The isolated working directory is not a directory");
  for (const environment of environments)
    if (within(real, realOrResolved(environment.workspace)))
      fail("probe_workspace_invalid", real, "workspace", "The working directory is the project's own workspace or lies inside it");
  if (within(realOrResolved(source), real)) fail("probe_workspace_invalid", real, "workspace", "The working directory holds the snapshot");
  const report = realOrResolved(reportDir);
  if (within(report, real) || within(real, report)) fail("probe_workspace_invalid", real, "workspace", "The working directory and the report directory must be apart");
  return real;
}
/** The configured adapter, fixed to an absolute executable and absolute module files that no change of directory can redirect. */
function resolveAdapter(command: Command, workspace: string, projectWorkspace: string): Adapter {
  const executable = command.executable;
  if (!isAbsolute(executable)) {
    if (/[\\/]/.test(executable)) fail("probe_adapter_unresolved", executable, "executable", "A relative executable would resolve against the isolated directory");
    if ((process.env["PATH"] ?? "").split(delimiter).some(entry => !isAbsolute(entry)))
      fail("probe_adapter_unresolved", executable, "executable", "PATH holds a relative entry; the executable cannot be fixed under another directory");
  }
  // A relative argument that has a separator, or that names a file in either directory, would name another file (or none) here.
  for (const arg of command.args) if (!isAbsolute(arg) && (/[\\/]/.test(arg)
    || !arg.startsWith("-") && [projectWorkspace, workspace].some(base => lstatSync(resolve(base, arg), { throwIfNoEntry: false }) !== undefined)))
    fail("probe_adapter_unresolved", arg, "args", "A relative path argument would name another file under the isolated directory");
  let resolved: string;
  try { resolved = executablePath(command, workspace); }
  catch (error) { return fail("probe_adapter_unresolved", executable, "executable", (error as Error).message); }
  const modules = command.args.filter(arg => isAbsolute(arg) && lstatSync(arg, { throwIfNoEntry: false })?.isFile())
    .map(path => ({ path, sha256: fileSha256(path) }));
  return { command: { executable: resolved, args: [...command.args] }, modules };
}

interface PaidContext {
  directory: ReportDirectory; paid: ProbePaidOptions; workspace: string; snapshot: string; project: string;
  signal: AbortSignal | null; stop: ProcessStopHooks | undefined; halted: Refusal | null; limited: Refusal | null;
}
type Transport = AdapterResult | { kind: "stop-unproven"; usage: null; error: { code: string; field: string; message: string } };
const unknownConfirmed = { model: null, effort: null, speed: null };
/** The saved physical result, decoded again on every run: the transport of the engine, never a saved verdict. */
function transportOf(result: ResultReceipt, requestId: string): Transport {
  if (result.process) {
    const decoded = readAdapterResponse({ requestId, process: result.process });
    if (decoded.ok) return decoded.value as AdapterResult;
    return { kind: "interrupted", usage: null, confirmed: unknownConfirmed, error: { code: decoded.refusal.code, field: "process", message: decoded.refusal.message } } as AdapterResult;
  }
  if (result.stop) return { kind: "stop-unproven", usage: null, error: { code: result.stop.code, field: "process", message: result.stop.message } };
  const launch = result.launchError!;
  return { kind: "interrupted", usage: null, confirmed: unknownConfirmed, error: { code: launch.code, field: "process", message: launch.message } } as AdapterResult;
}
function settled(store: Store, project: string, examined: Examined, result: ResultReceipt, state: "sent" | "reused", seconds: number | null): PaidReport {
  const transport = transportOf(result, examined.wire!.requestId);
  const paid: PaidReport = { state, reason: null, refusal: null, acceptance: null, receipt: `sends/${examined.report.key}.json`,
    transport: { kind: transport.kind, error: transport.kind === "answered" ? null : { code: transport.error.code, field: transport.error.field, message: transport.error.message },
      usage: transport.usage, exitCode: result.process?.exitCode ?? result.stop?.physical?.exitCode ?? null,
      signal: result.process?.signal ?? result.stop?.physical?.signal ?? null, seconds } };
  if (transport.kind === "answered") {
    const checked = acceptance(store, project, examined.record!, transport.raw);
    keep(examined, "paid", checked.outcome);
    paid.acceptance = checked.report;
  }
  return paid;
}
const notSent = (refusal: Refusal | null, reason: PaidReport["reason"] = null, receipt: string | null = null): PaidReport =>
  ({ state: "not-sent", reason, refusal, receipt, transport: null, acceptance: null });

/** What one send of a point binds: the snapshot, the exact packet, environment and role, the canonical wire, the fixed adapter and the directory. */
function bindingOf(context: PaidContext, examined: Examined, adapter: Adapter | undefined): SendBinding | null {
  const report = examined.report;
  if (!adapter || !report.packet || !report.environment || !report.role || !report.wire) return null;
  return { snapshot: context.snapshot, project: context.project, point: report.key, packet: report.packet, environment: report.environment,
    role: report.role, wire: { sha256: report.wire.sha256, chars: report.wire.chars, bytes: report.wire.bytes },
    command: { executable: adapter.command.executable, args: [...adapter.command.args] }, modules: adapter.modules, cwd: context.workspace };
}
/**
 * A report directory is one experiment: every saved send of it ran in this working directory, and every chosen point it already sent
 * binds now exactly as then. Otherwise the run is refused before its first send, whatever the order or the choice of points.
 */
function checkBindings(context: PaidContext, examined: readonly Examined[], adapters: ReadonlyMap<string, Adapter>): void {
  const receipt = (point: string) => join(context.directory.path, "sends", `${point}.json`);
  for (const [point, saved] of context.directory.sends)
    if (saved.receipt.binding.cwd !== context.workspace)
      fail("probe_receipt_mismatch", receipt(point), "cwd", "The directory's sends ran in another working directory; it is not paid again");
  for (const item of examined) {
    const saved = context.directory.sends.get(item.report.key);
    if (!saved) continue;
    const binding = bindingOf(context, item, adapters.get(item.report.key));
    if (binding && same(saved.receipt.binding, binding)) continue;
    const before = saved.receipt.binding as unknown as Record<string, unknown>, after = binding as unknown as Record<string, unknown> | null;
    fail("probe_receipt_mismatch", receipt(item.report.key), after ? Object.keys(after).find(name => !same(before[name], after[name])) ?? "binding" : "wire",
      "The saved send of this point names another wire, adapter or directory; it is not paid again");
  }
}

async function payPoint(store: Store, context: PaidContext, examined: Examined, adapter: Adapter): Promise<PaidReport> {
  const report = examined.report, key = report.key;
  if (context.directory.sends.has(key)) {
    // checkBindings has proved that this saved send binds the point as it is now.
    const result = context.directory.results.get(key);
    if (!result) return { ...notSent(probeRefusal("probe_send_unknown", key, "result",
      "A send was authorized but its result was never saved; the outcome is unknown and it is not sent again"), null, `sends/${key}.json`), state: "unknown" };
    return settled(store, context.project, examined, result, "reused", null);
  }
  if (context.halted) return notSent(context.halted);
  if (context.limited) return notSent(context.limited);
  if (context.signal?.aborted) return notSent(context.halted = probeRefusal("probe_interrupted", key, "signal", "The probe was interrupted; no further point is sent"));
  const reserved = context.directory.reserved(), chars = report.wire!.chars;
  if (reserved.calls + 1 > context.paid.maxCalls || reserved.chars + chars > context.paid.maxChars) {
    const field = reserved.calls + 1 > context.paid.maxCalls ? "max-calls" : "max-chars";
    return notSent(context.limited = probeRefusal("probe_paid_limit_exceeded", key, field,
      `The next send would exceed the limit: calls ${reserved.calls + 1} of ${context.paid.maxCalls}, chars ${reserved.chars + chars} of ${context.paid.maxChars}`));
  }
  const receipt: SendReceipt = { format: SEND_FORMAT, binding: bindingOf(context, examined, adapter)!, reservation: { calls: 1, chars }, at: new Date().toISOString() };
  let authorized = false, unwritable: string | null = null;
  let outcome: Pick<ResultReceipt, "process" | "launchError" | "stop">;
  const started = now();
  try {
    const process = await runProcess(adapter.command, context.workspace, examined.body!, examined.environment!.value.timeoutMs,
      context.signal ?? undefined, true, () => {
        // The permission and the reserve are durable before the request crosses into the adapter's stdin.
        try { context.directory.authorize(key, receipt); authorized = true; }
        catch (error) { unwritable = (error as Error).message; throw new EngineError("probe_report_unwritable", "The send could not be authorized durably"); }
      }, context.stop);
    outcome = { process, launchError: null, stop: null };
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    if (isProcessStopRefusal(error)) {
      const physical = processStopPhysical(error);
      outcome = { process: null, launchError: null, stop: { code: error.code, message: error.message,
        details: JSON.parse(JSON.stringify(error.details ?? null)) as Json,
        physical: physical ? { exitCode: physical.exitCode, signal: physical.signal, stdout: physical.stdout, stderr: physical.stderr, complete: physical.complete } : null } };
      context.halted = probeRefusal("probe_stop_unproven", key, "process", "The adapter's process group could not be proved stopped; no further point is sent");
    } else {
      if (error.code === "process_cancelled") context.halted = probeRefusal("probe_interrupted", key, "signal", "The probe was interrupted; no further point is sent");
      outcome = { process: null, launchError: { code: error.code, message: error.message }, stop: null };
    }
  }
  const seconds = Math.round((now() - started) / 100) / 10;
  if (unwritable !== null) fail("probe_report_unwritable", join(context.directory.path, "sends"), "send", `The send could not be authorized: ${unwritable as string}`);
  if (!authorized) {
    // Nothing reached the adapter: the launch failed, or the probe was stopped, before the permission was saved.
    const error = outcome.launchError ?? { code: outcome.stop?.code ?? "process_failed", message: outcome.stop?.message ?? "Not sent" };
    return { ...notSent(context.halted), transport: { kind: "interrupted", error: { code: error.code, field: "process", message: error.message },
      usage: null, exitCode: null, signal: null, seconds } };
  }
  const result: ResultReceipt = { format: RESULT_FORMAT, point: key, send: context.directory.sends.get(key)!.sha256, ...outcome, at: new Date().toISOString() };
  try { context.directory.settle(key, result); }
  catch (error) { fail("probe_report_unwritable", join(context.directory.path, "results"), "result", `The physical result could not be saved: ${(error as Error).message}`); }
  return settled(store, context.project, examined, result, "sent", seconds);
}

// ---- Joint assembly: only E3-accepted proposals of one exact frame basis, through the engine's own C3/F4.5. ----

export interface JointReport {
  level: 2 | 3; frame: Json; saved: number; works: { producer: Ref; ledger: Ref } | null;
  proposals: { point: string; origin: AcceptedProposal["origin"]; proposal: string }[];
  outcome: { state: "not-assembled"; operations: { covered: number; total: number }; remaining: { obligation: string; node: string; kind: string }[] }
    | { state: "candidate"; graphHash: string; layerHash: string } | { state: "gaps"; gaps: number }
    | { state: "refused"; stage: string; refusal: Refusal };
}
function jointGroups(accepted: readonly AcceptedProposal[]): Map<string, AcceptedProposal[]> {
  const groups = new Map<string, AcceptedProposal[]>();
  for (const item of accepted) {
    const works = item.outcome.works ? { contract: item.outcome.works.contract, producer: item.outcome.works.producer, ledger: item.outcome.works.ledger } : null;
    const key = canonical({ level: item.frame.level, frame: item.frame.source.frame, proposals: [...item.frame.source.proposals].sort((a, b) => order(canonical(a), canonical(b))),
      works } as unknown as Json);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}
function assembleGroup(store: Store, project: string, members: readonly AcceptedProposal[]): JointReport {
  const first = members[0]!, frame = first.frame, works = first.outcome.works ?? null;
  const writes = new Map<string, Write>();
  const proposals: JointReport["proposals"] = [];
  for (const member of members) {
    const value = member.outcome.proposal as LayerProposal, hash = hashJson(value), id = `om-proposal:${project}:answer-content:${hash}`;
    writes.set(id, { id, kind: "layer-proposal", expected: 0, value: value as unknown as Json });
    proposals.push({ point: member.point, origin: member.origin, proposal: hash });
  }
  const report: JointReport = { level: frame.level, frame: frame.source.frame as unknown as Json, saved: frame.source.proposals.length,
    works: works ? { producer: works.producer, ledger: works.ledger } : null, proposals, outcome: { state: "gaps", gaps: 0 } };
  const refusedAt = (stage: string, refusal: Refusal): JointReport => ({ ...report, outcome: { state: "refused", stage, refusal } });
  const base = guarded("frame-proposals", project, "frame", () => readFrameProposals(store, frame.source));
  if (!base.ok) return refusedAt("readFrameProposals(base)", base.refusal);
  const refs = [...writes.values()].map(write => ({ id: write.id, revision: 1, hash: hashJson(write.value) }));
  const known = new Set(frame.source.proposals.map(ref => canonical(ref)));
  const request: ProposalRequest = { frame: frame.source.frame, proposals: [...frame.source.proposals, ...refs.filter(ref => !known.has(canonical(ref)))] };
  const read = guarded("frame-proposals", project, "proposals", () => readFrameProposals(pendingCallStore(store, [...writes.values()]), request));
  if (!read.ok) return refusedAt("readFrameProposals", read.refusal);
  const applied = guarded("frame-proposals", project, "proposals", () => applyProposals(read.value.frame as never, read.value.proposals as never));
  if (!applied.ok) return refusedAt("applyProposals", applied.refusal);
  const total = [...new Set(base.value.result.open.map(item => item.upper.node))].sort(order);
  const remaining = applied.value.open;
  if (remaining.length) {
    const covered = total.filter(node => !remaining.some(item => item.upper.node === node)).length;
    return { ...report, outcome: { state: "not-assembled", operations: { covered, total: total.length },
      remaining: remaining.map(item => ({ obligation: item.id, node: item.upper.node, kind: item.kind })) } };
  }
  const input = works ? { contract: WORKS_FRAME_CONTRACT, producer: works.producer, ledger: works.ledger,
    bindings: members.flatMap(member => member.outcome.works?.bindings ?? []) } : undefined;
  const candidate = guarded("frame-candidate", project, "candidate", () => assembleCandidate(read.value.frame as never, read.value.proposals as never, input as never));
  if (!candidate.ok) return refusedAt("assembleCandidate", candidate.refusal);
  const assembled = candidate.value as { state: "gaps"; gaps: unknown[] } | { state: "candidate"; candidate: { graphHash: string; layerHash: string } };
  return { ...report, outcome: assembled.state === "candidate" ? { state: "candidate", graphHash: assembled.candidate.graphHash, layerHash: assembled.candidate.layerHash }
    : { state: "gaps", gaps: assembled.gaps.length } };
}

// ---- The run: report, exit and the command line. ----

export interface ProbeEngineVersion { package: string | null; commit: string | null; probe: string | null }
/** The running code: its package, the commit its checkout names (read from Git's files, never by running git) and this module. */
function engineVersion(): ProbeEngineVersion {
  const module = fileURLToPath(import.meta.url), root = resolve(dirname(module), "../../..");
  const read = (path: string): string | null => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
  let packageName: string | null = null;
  try { const json = JSON.parse(read(join(root, "package.json")) ?? "null") as { name?: string; version?: string } | null; if (json?.name) packageName = `${json.name}@${json.version ?? "?"}`; }
  catch { packageName = null; }
  let commit: string | null = null;
  try {
    const dotGit = join(root, ".git"), marker = lstatSync(dotGit, { throwIfNoEntry: false });
    const gitDir = marker?.isDirectory() ? dotGit : marker?.isFile() ? resolve(root, (read(dotGit) ?? "").replace(/^gitdir:\s*/, "")) : null;
    if (gitDir) {
      const head = read(join(gitDir, "HEAD")) ?? "";
      if (/^[0-9a-f]{40}$/.test(head)) commit = head;
      else if (head.startsWith("ref: ")) {
        const name = head.slice(5), common = resolve(gitDir, read(join(gitDir, "commondir")) ?? ".");
        commit = read(join(gitDir, name)) ?? read(join(common, name))
          ?? (read(join(common, "packed-refs")) ?? "").split("\n").find(line => line.endsWith(` ${name}`))?.slice(0, 40) ?? null;
        if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) commit = null;
      }
    }
  } catch { commit = null; }
  let probe: string | null = null;
  try { probe = fileSha256(module); } catch { probe = null; }
  return { package: packageName, commit, probe };
}

export interface ProbeTotals {
  sent: number; reused: number; unknown: number; sentChars: number; sentBytes: number;
  usage: TokenUsage | null; unmeasured: number; reserved: { calls: number; chars: number } | null;
}
export interface ProbeReport {
  format: typeof PROBE_REPORT_FORMAT; mode: "free" | "paid"; engine: ProbeEngineVersion; project: string | null; source: ProbeSnapshot | null;
  options: Json; selection: { rule: string; coverage: Coverage[]; run: Omit<RunPoint, "packet" | "role"> & { packet: Ref | null } } | null;
  points: PointReport[]; joint: { state: "nothing-to-assemble" | "assembled"; groups: JointReport[] };
  totals: ProbeTotals; halted: Refusal | null; refusal: Refusal | null; complete: boolean; exit: 0 | 1 | 2; durationMs: number;
}
export interface ProbeOutcome { exit: 0 | 1 | 2; report: ProbeReport }

function describe(options: CheckedOptions | null, raw: unknown): Json {
  if (!options) return object(raw) ? { source: typeof raw.source === "string" ? raw.source : null, project: typeof raw.project === "string" ? raw.project : null } : null;
  return { source: options.source, project: options.project, kinds: options.kinds, points: options.points, select: options.select, replay: options.replay,
    answers: options.answers.map(item => ({ point: item.point, file: item.file })),
    paid: options.paid ? { maxCalls: options.paid.maxCalls, maxChars: options.paid.maxChars, workspace: options.paid.workspace } : null,
    reportDir: options.reportDir };
}
function finish(report: ProbeReport, started: number): ProbeReport {
  report.durationMs = Math.round(now() - started);
  if (report.refusal) { report.exit = 1; report.complete = false; return report; }
  const failed = report.points.some(point => point.verdict !== "equal" && point.verdict !== "sized")
    || report.points.some(point => point.answer !== null && !point.answer.acceptance.ok)
    || report.points.some(point => point.calls.some(call => call.replay?.verdict === "changed" || (call.replay?.acceptance && !call.replay.acceptance.ok && call.replay.verdict !== "same")))
    || report.points.some(point => point.paid !== null && (point.paid.state === "unknown" || point.paid.refusal !== null
      || (point.paid.transport !== null && point.paid.transport.kind !== "answered") || (point.paid.acceptance !== null && !point.paid.acceptance.ok)))
    // A refusal of the joint assembly is a substantive finding; partial coverage and gaps only keep the run incomplete.
    || report.joint.groups.some(group => group.outcome.state === "refused")
    || report.halted !== null;
  report.exit = failed ? 2 : 0;
  for (const point of report.points) point.complete = substantive(point.paid?.acceptance ?? point.answer?.acceptance ?? null);
  const paid = report.points.filter(point => point.paid && ["sent", "reused"].includes(point.paid.state));
  report.complete = report.exit === 0 && report.mode === "paid" && paid.length > 0 && paid.every(point => point.complete)
    && report.joint.groups.every(group => group.outcome.state === "candidate");
  return report;
}
function blankReport(): ProbeReport {
  return { format: PROBE_REPORT_FORMAT, mode: "free", engine: engineVersion(), project: null, source: null, options: null, selection: null, points: [],
    joint: { state: "nothing-to-assemble", groups: [] },
    totals: { sent: 0, reused: 0, unknown: 0, sentChars: 0, sentBytes: 0, usage: null, unmeasured: 0, reserved: null },
    halted: null, refusal: null, complete: false, exit: 1, durationMs: 0 };
}
function totalsOf(points: readonly PointReport[], directory: ReportDirectory | null): ProbeTotals {
  const totals: ProbeTotals = { sent: 0, reused: 0, unknown: 0, sentChars: 0, sentBytes: 0, usage: null, unmeasured: 0, reserved: directory?.reserved() ?? null };
  for (const point of points) {
    const paid = point.paid;
    if (!paid) continue;
    if (paid.state === "unknown") totals.unknown++;
    if (paid.state !== "sent" && paid.state !== "reused") continue;
    if (paid.state === "sent") { totals.sent++; totals.sentChars += point.wire!.chars; totals.sentBytes += point.wire!.bytes; } else totals.reused++;
    const usage = paid.transport?.usage ?? null;
    if (!usage) { totals.unmeasured++; continue; }
    // A field an adapter did not measure stays unknown in the sum; it never becomes zero.
    const add = (left: number | null, right: number | null): number | null => left === null || right === null ? null : left + right;
    const sum = totals.usage;
    totals.usage = sum === null ? { ...usage } : { inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens,
      cachedInputTokens: add(sum.cachedInputTokens, usage.cachedInputTokens), reasoningOutputTokens: add(sum.reasoningOutputTokens, usage.reasoningOutputTokens) };
  }
  return totals;
}

/** The probe of the engine; every refusal of its own is a report with exit 1, never a thrown error. */
export async function runProbe(options: ProbeOptions): Promise<ProbeOutcome> {
  const started = now(), report = blankReport();
  let checked: CheckedOptions | null = null, copy: SourceCopy | null = null, store: Store | null = null, directory: ReportDirectory | null = null;
  try {
    checked = checkOptions(options);
    report.mode = checked.paid ? "paid" : "free"; report.project = checked.project; report.options = describe(checked, options);
    copy = await copySource(checked.source, checked.testHooks.afterCopy);
    report.source = copy.snapshot;
    try { store = new Store(copy.database); }
    catch (error) { fail("probe_copy_failed", copy.snapshot.path, "store", `The copy cannot be opened: ${(error as Error).message}`); }
    report.source.databaseId = store.databaseId;
    const project = checked.project;
    if (!store.get(`project:${project}`)) fail("probe_project_missing", project, "project", "The snapshot holds no such project");
    if (checked.reportDir) directory = ReportDirectory.open(checked.reportDir, copy.snapshot.sha256, project, checked.testHooks.beforeCommit);
    const { candidates, run } = enumerate(store, project);
    const explicit: Candidate[] = [], answers = new Map<string, { file: string; body: string }>();
    for (const spec of checked.select) explicit.push(resolveSpec(store, project, spec, candidates, run));
    for (const item of checked.answers) {
      const candidate = resolveSpec(store, project, item.point, candidates, run);
      if (answers.has(candidate.key)) fail("probe_request_invalid", item.point, "answer", "A point takes one answer");
      let body: string;
      try { body = readFileSync(resolve(item.file), "utf8"); }
      catch { return fail("probe_request_invalid", resolve(item.file), "answer", "The answer file cannot be read"); }
      answers.set(candidate.key, { file: resolve(item.file), body }); explicit.push(candidate);
    }
    const { chosen, coverage } = select(candidates, [...new Set(explicit)], checked);
    report.selection = { rule: SELECTION_RULE, coverage, run: { state: run.state, phase: run.phase, action: run.action, refusal: run.refusal, packet: run.packet } };
    if (!chosen.length) fail("probe_no_points", project, "points", "The snapshot holds no saved point of the requested groups");
    const examined: Examined[] = [];
    for (const point of chosen) {
      if (checked.signal?.aborted) { report.halted = probeRefusal("probe_interrupted", point.candidate.key, "signal", "The probe was interrupted before this point"); break; }
      const item = examine(store, project, point, checked, answers.get(point.candidate.key) ?? null);
      item.report.verdict = verdictOf(item.report);
      examined.push(item); report.points.push(item.report);
    }
    // A directory with a send whose process group was never proved stopped keeps its probe stopped, in every later run of it.
    if (directory?.stopped && !report.halted) report.halted = probeRefusal("probe_stop_unproven", directory.stopped, "process",
      "A saved send of this report directory could not be proved stopped; nothing more is sent from it. Use a new directory once that process group is gone");
    if (checked.paid && directory) {
      const continuationChosen = (item: Examined) => item.report.origins.includes("explicit") || (checked!.kinds ?? []).includes(item.report.group);
      const offered: Examined[] = [];
      for (const item of examined) {
        const verdict = item.report.verdict;
        // A point this directory already sent is decided again from its saved result, whatever its check or group gives now.
        if (directory.sends.has(item.report.key)) offered.push(item);
        else if (verdict !== "equal" && verdict !== "sized") item.report.paid = notSent(null, verdict);
        else if (item.report.group.endsWith(CONTINUATION) && !continuationChosen(item)) item.report.paid = notSent(null, "continuation");
        else offered.push(item);
      }
      const readable = offered.filter(item => item.environment !== null && item.report.role !== null);
      const workspace = checkWorkspace(checked.paid.workspace, readable.map(item => item.environment!.value), copy.snapshot.path, checked.reportDir!);
      const adapters = new Map(readable.map(item => [item.report.key,
        resolveAdapter(item.environment!.value[item.report.role!].command, workspace, item.environment!.value.workspace)]));
      const context: PaidContext = { directory, paid: checked.paid, workspace, snapshot: copy.snapshot.sha256, project, signal: checked.signal,
        stop: checked.testHooks.stop, halted: report.halted, limited: null };
      checkBindings(context, offered, adapters);
      for (const item of offered) item.report.paid = await payPoint(store, context, item, adapters.get(item.report.key)!);
      report.halted = context.halted;
    }
    const groups = jointGroups(examined.flatMap(item => item.accepted));
    report.joint = groups.size ? { state: "assembled", groups: [...groups.values()].map(members => assembleGroup(store!, project, members)) }
      : { state: "nothing-to-assemble", groups: [] };
    report.totals = totalsOf(report.points, directory);
    finish(report, started);
    directory?.writeReport(report);
  } catch (error) {
    if (!(error instanceof ProbeFailure)) throw error;
    report.refusal = error.refusal;
    if (!checked) report.options = describe(null, options);
    report.totals = totalsOf(report.points, directory);
    finish(report, started);
    // A run refused before its first send leaves the directory as it found it; after a send its partial report stays beside the receipts.
    if (directory && directory.authorized > 0) try { directory.writeReport(report); } catch { /* the refusal itself is the outcome */ }
  } finally {
    try { store?.close(); } finally {
      if (copy) rmSync(copy.directory, { recursive: true, force: true });
      directory?.close();
    }
  }
  return { exit: report.exit, report };
}

/** `npm start -- probe …`: the report on stdout, its exit code returned; SIGINT and SIGTERM stop it through the common runner. */
export async function probeCommand(argv: readonly string[], write: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { write(`${PROBE_USAGE}\n`); return 0; }
  const parsed = parseProbeArgs(argv);
  if (!parsed.ok) {
    const report = blankReport();
    report.refusal = parsed.refusal; report.options = describe(null, null);
    write(`${JSON.stringify(finish(report, now()))}\n`);
    return 1;
  }
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const outcome = await runProbe({ ...parsed.value, signal: controller.signal });
    write(`${JSON.stringify(outcome.report)}\n`);
    return outcome.exit;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

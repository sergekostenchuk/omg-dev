import { canonical, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type Refusal, type Sealed } from "./refusal.js";
import { readRecord, writeGuarded } from "./refs.js";
import type { FrameRequest } from "./frame-obligations.js";
import type { ProposalRequest } from "./frame-proposals.js";

/**
 * The project's journal of gate refusals. A gate that refuses writes a record of its own; this unit reads that record
 * at its exact reference and appends its refusals to the journal, each row keeping the gate, the code, the goal the
 * refused check was securing, what to fix, and the ORIGIN — the refusal's name, the stage it arose at, the refused
 * object and the exact sources it was weighed against. A gate never declares the class of its own refusal or who it
 * goes back to: G7 derives both from the origin and writes them here as a classification of its own, kept beside the
 * rows so that the identity of a row — the hash of its content — never changes under a consumer. The owner's
 * explanation of a stop is assembled from rows and classifications by code.
 * Neither a row nor a classification switches anything (T8): readiness, the graph, gaps, attempts and the order of
 * blocks stay as they were.
 */
const UNIT = "store-refusals";
const MAX_ENTITY_ID = 200; // the store's own limit on an entity id (src/storage/store.ts)

export const UNIT_REFUSAL_KIND = "om-unit-refusal";
export const REFUSAL_JOURNAL_KIND = "om-refusal-journal";

// Every refusal this unit can produce. The list is the checklist its test walks, so a new code cannot arrive untested.
export const REFUSAL_JOURNAL_CODES = Object.freeze([
  "refusal_record_invalid", "refusals_missing", "refusal_entry_invalid",
  "origin_invalid", "origin_source_invalid",
  "row_unknown", "classification_conflict", "classification_invalid",
  "journal_invalid", "journal_foreign", "journal_missing",
] as const);
export type RefusalJournalCode = typeof REFUSAL_JOURNAL_CODES[number];

export interface OriginSource {
  readonly role: string;
  readonly ref: Ref;
  readonly context?: OriginSourceContext;
}
export type OriginSourceContext = { readonly kind: "proposal"; readonly request: Sealed<ProposalRequest> }
  | { readonly kind: "frame"; readonly request: Sealed<FrameRequest> };

export interface RefusalOrigin {
  readonly name: string;
  readonly stage: string;
  readonly subject: string;
  readonly sources: readonly OriginSource[];
}

export interface UnitRefusal {
  readonly code: string;
  readonly goal: string;
  readonly remedy: string;
  readonly origin: RefusalOrigin;
}

export interface UnitRefusalRecord {
  readonly gate: string;
  readonly refusals: readonly UnitRefusal[];
}

export interface JournalRow extends UnitRefusal {
  readonly id: string;
  readonly gate: string;
  readonly source: Ref;
}

/**
 * What G7 derived for one row: the class of the refusal, who it goes back to, and the exact records the origin was
 * weighed against. The vocabulary of classes and addressees is G7's — the journal keeps what it was told and rules on
 * none of it. A classification stands beside its row, never inside it, so a row keeps the identity its id stands for.
 */
export interface RefusalClassification {
  readonly row: string;
  readonly class: string;
  readonly addressee: string;
  readonly basis: readonly OriginSource[];
}

export interface RefusalJournal {
  readonly projectId: string;
  readonly rows: readonly JournalRow[];
  readonly classifications: readonly RefusalClassification[];
}

export interface JournalRequest { readonly project: string }
export interface RecordRefusalRequest extends JournalRequest { readonly source: Ref }
export interface ClassifyRefusalRequest extends JournalRequest, RefusalClassification {}

/**
 * Several decisions of G7 about one journal, asked for at once.
 * A journal is ONE record, and a transaction writes each record once, so a neighbour that classifies a whole set of
 * refusals in the transaction of its own change cannot call the single-row preparation once per row: that would offer
 * the store several competing writes of one id. The set is weighed row by row — the same rules, in the order given —
 * and comes out as ONE write.
 */
export interface ClassifyRefusalsRequest extends JournalRequest {
  readonly classifications: readonly RefusalClassification[];
}

/**
 * One prepared change of the journal: the record to write, the exact references it must be guarded by, and what the
 * journal would hold afterwards. `writes` is empty when the journal already holds this change — a repeat needs no
 * revision, and adds nothing to anyone's transaction.
 * A caller that has to write SEVERAL records at once (G7 recording the outcome of a cycle in the series AND the class
 * of every refusal of that cycle here) puts these writes and guards into one writeGuarded of its own, so that either
 * all of them are applied or none is. Calling the operations one after another would leave a partial result.
 */
export interface JournalWrite {
  readonly id: string;
  readonly kind: string;
  readonly expected: number;
  readonly value: unknown;
}
export interface JournalTransition {
  readonly writes: readonly JournalWrite[];
  readonly guards: readonly Ref[];
  readonly value: RefusalJournal;
}

/**
 * Everything one transaction adds to the journal, prepared at once against ONE head: the rows of every source record
 * and every decision of G7, including decisions about rows this same batch adds. A source is either a refusal record
 * that already stands (read at its exact reference) or one created in the same transaction: such a record is admitted
 * only together with its exact prepared write, is read through the same checks as a stored one — its address, kind,
 * hash and content — never on the caller's word that it is fine, and is written from the batch's own copy.
 * Both sets are required and may be explicitly empty; an absent set is not an empty one (T4).
 */
export interface JournalBatchRequest extends JournalRequest {
  readonly sources: readonly Ref[];
  readonly pending: readonly JournalWrite[];
  readonly classifications: readonly RefusalClassification[];
}

/**
 * The batch as one change: its writes, the guards they depend on, what the journal holds afterwards, and the exact
 * reference of that journal. The writes are the pending source records this batch read — the batch's own sealed copies
 * of them, in the order their sources are named — and then the journal: a caller writes them as they are, in one
 * writeGuarded with its other records, and adds no copy of its own (the store refuses a second write of one id). So no
 * row of the journal can stand for bytes the transaction does not write. The guards always name the journal as it was
 * read — its head, or its absence — so a caller never has to read it again to know what its transaction depends on.
 */
export interface JournalBatch {
  readonly writes: readonly JournalWrite[];
  readonly guards: readonly TransactionGuard[];
  readonly value: RefusalJournal;
  readonly result: Ref;
}

const ENTRY_TEXTS = Object.freeze(["code", "goal", "remedy"] as const);
const ORIGIN_TEXTS = Object.freeze(["name", "stage", "subject"] as const);
const RECORD_KEYS = Object.freeze(["gate", "refusals"] as const);
const ENTRY_KEYS = Object.freeze([...ENTRY_TEXTS, "origin"] as const);
const ORIGIN_KEYS = Object.freeze([...ORIGIN_TEXTS, "sources"] as const);
const SOURCE_KEYS = Object.freeze(["role", "ref"] as const);
const ROW_KEYS = Object.freeze(["id", "gate", "code", "goal", "remedy", "origin", "source"] as const);
const CLASSIFICATION_TEXTS = Object.freeze(["row", "class", "addressee"] as const);
const CLASSIFICATION_KEYS = Object.freeze([...CLASSIFICATION_TEXTS, "basis"] as const);
const JOURNAL_KEYS = Object.freeze(["projectId", "rows", "classifications"] as const);
const WRITE_KEYS = Object.freeze(["id", "kind", "expected", "value"] as const);
const BATCH_KEYS = Object.freeze(["project", "sources", "pending", "classifications"] as const);

// A context without a reference is a batch that found no journal yet: there is no head to address its refusal to.
interface Context { readonly target: string; readonly ref?: Ref | undefined }
interface Codes { readonly entry: RefusalJournalCode; readonly origin: RefusalJournalCode; readonly source: RefusalJournalCode }
interface Prepared { readonly transition: JournalTransition; readonly current: Revision<RefusalJournal> | null }

// The same shape is read on two paths: as it arrives from a gate, and as it already stands in the journal. What is
// wrong is the same; who is at fault is not, so each path carries its own codes.
const INCOMING: Codes = { entry: "refusal_entry_invalid", origin: "origin_invalid", source: "origin_source_invalid" };
const STORED: Codes = { entry: "journal_invalid", origin: "journal_invalid", source: "journal_invalid" };

function frameContextShape(value: unknown): value is FrameRequest {
  if (!isPlainObject(value) || !exactKeys(value, ["project", "level", "horizon", "graph", "layer", "frame", "upper",
    ...(Object.hasOwn(value as object, "workZoneContract") ? ["workZoneContract"] : [])])) return false;
  const frame = value as FrameRequest;
  if (Object.hasOwn(frame, "workZoneContract") && (frame.level !== 3 || frame.workZoneContract !== "accepted-l2-v1")) return false;
  if (!isText(frame.project) || ![2, 3].includes(frame.level) || !isRef(frame.horizon) || !isRef(frame.graph)
    || frame.layer !== null && !isRef(frame.layer) || frame.frame !== null && !isRef(frame.frame)) return false;
  return frame.level === 2 ? frame.upper === null : isPlainObject(frame.upper) && exactKeys(frame.upper, ["horizon", "frame"])
    && isRef(frame.upper!.horizon) && (frame.upper!.frame === null || isRef(frame.upper!.frame));
}
function sourceIssue(value: unknown): string | null {
  if (!isPlainObject(value) || !exactKeys(value, Object.hasOwn(value as object, "context") ? [...SOURCE_KEYS, "context"] : SOURCE_KEYS)) return "";
  const source = value as OriginSource;
  if (!isText(source.role)) return "role";
  if (!isRef(source.ref)) return "ref";
  if (!Object.hasOwn(source, "context")) return null;
  const context = source.context;
  if (!isPlainObject(context) || !exactKeys(context, ["kind", "request"])) return "context";
  if (context!.kind === "frame") return frameContextShape(context!.request) ? null : "context.request";
  if (context!.kind !== "proposal" || !isPlainObject(context!.request) || !exactKeys(context!.request, ["frame", "proposals"])) return "context";
  const request = context!.request;
  return frameContextShape(request.frame) && Array.isArray(request.proposals) && Array.from(request.proposals).every(isRef) ? null : "context.request";
}
const sourceRef = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
function normalizedFrameContext(frame: FrameRequest): FrameRequest {
  return { project: frame.project, level: frame.level, horizon: sourceRef(frame.horizon), graph: sourceRef(frame.graph),
    layer: frame.layer === null ? null : sourceRef(frame.layer), frame: frame.frame === null ? null : sourceRef(frame.frame),
    upper: frame.upper === null ? null : { horizon: sourceRef(frame.upper.horizon), frame: frame.upper.frame === null ? null : sourceRef(frame.upper.frame) },
    ...(Object.hasOwn(frame, "workZoneContract") ? { workZoneContract: frame.workZoneContract! } : {}) };
}
/** Syntax and identity only: each producer still proves the source and its exact assembly context. */
export function normalizeOriginSource(value: unknown): Sealed<OriginSource> {
  const issue = sourceIssue(value);
  if (issue !== null) throw new EngineError("journal_request_invalid", "An origin source needs its role, exact reference and complete context",
    { unit: UNIT, target: "source", field: issue || "source" });
  const source = value as OriginSource;
  let context: OriginSourceContext | undefined;
  if (source.context?.kind === "frame") context = { kind: "frame", request: normalizedFrameContext(source.context.request) };
  else if (source.context?.kind === "proposal") context = { kind: "proposal", request: {
    frame: normalizedFrameContext(source.context.request.frame), proposals: source.context.request.proposals.map(sourceRef)
      .sort((a, b) => compare(canonical(a), canonical(b))),
  } };
  try { return sealed({ role: source.role, ref: sourceRef(source.ref), ...(context === undefined ? {} : { context }) }); }
  catch (error) {
    if (error instanceof EngineError && error.code === "unsealable_value")
      throw new EngineError("journal_request_invalid", "An origin source must be finite JSON", { unit: UNIT, target: "source", field: "context" });
    throw error;
  }
}
/** Context participates in identity; contextless sources retain their established ordering. */
export function originSourceKey(value: OriginSource): string {
  const source = normalizeOriginSource(value);
  return `${source.role}\0${source.ref.id}\0${source.ref.revision}\0${source.ref.hash}${source.context === undefined ? "" : `\0${canonical(source.context)}`}`;
}

export function journalId(project: string): string {
  return `${REFUSAL_JOURNAL_KIND}:${requireProject(project)}`;
}

export function unitRefusalNamespace(project: string): string {
  return `${UNIT_REFUSAL_KIND}:${requireProject(project)}:`;
}

/**
 * The four marks of a refusal record of G4b (answers-gate). ANY one of them makes a record a G4b source, and a G4b
 * source is admitted only when it carries ALL of them — the gate, its namespace, the stage and one finding-proof as its
 * only source, one refusal per record — and when the typed reader of G4b, which derives the whole record again from
 * that proof, says it is one. A contradiction is never read as "some other gate" (STALE-6, C19, C21).
 */
export const G4B_MARKERS = Object.freeze({ gate: "G4b", stage: "answers-gate/v1", role: "answers-finding", segment: "g4b:" } as const);
export interface AnswersMarks { readonly any: boolean; readonly exact: boolean }

/**
 * Proves one G4b source against its whole derivation, on the view it is given (a pending source is read on the view
 * holding its write). It never reads the journal or a close (C66). G4b has no refusal of its own that G7 classifies
 * (№1628 Q1), so a G4b row is never classified: the reader answers only whether the record is one G4b produced.
 */
export type AnswersSourceReader = (store: Store, project: string, source: Ref) => OmResult<unknown>;

// Process state, closed by default: a G4b source read where no typed reader is loaded is refused, never let through
// on its shape (C36, R3). The journal imports nothing of answers-gate; answers-gate registers here when it loads.
let answersSourceReader: AnswersSourceReader | null = null;

export function registerAnswersSourceReader(reader: AnswersSourceReader): void {
  requireCondition(typeof reader === "function", "journal_request_invalid", "The typed reader of G4b sources is a function");
  if (answersSourceReader === reader) return;
  if (answersSourceReader !== null) {
    throw new EngineError("journal_reader_conflict", "A typed reader of G4b sources is registered already, and another one does not replace it",
      { unit: UNIT, target: REFUSAL_JOURNAL_KIND, field: "reader" });
  }
  answersSourceReader = reader;
}

/** The marks of G4b on a refusal record at its reference. The value is data and may be malformed: it is only looked at. */
export function answersSourceMarks(project: string, source: Ref, value: unknown): AnswersMarks {
  const namespace = unitRefusalNamespace(project);
  requireCondition(isRef(source), "journal_request_invalid", "The marks of a source are read at its exact reference");
  const record = isPlainObject(value) ? value as Record<string, unknown> : {};
  const gate = record['gate'];
  const entries = Array.isArray(record['refusals']) ? Array.from(record['refusals'] as unknown[]) : [];
  const origins = entries.map(item => isPlainObject(item) && isPlainObject((item as Record<string, unknown>)['origin'])
    ? (item as Record<string, unknown>)['origin'] as Record<string, unknown> : {});
  const roles = origins.map(origin => Array.isArray(origin['sources'])
    ? Array.from(origin['sources'] as unknown[]).map(item => isPlainObject(item) ? (item as Record<string, unknown>)['role'] : undefined) : []);
  return marks(namespace, source.id, gate, origins.map(origin => origin['stage']), roles);
}

/** The marks of G4b on a journal row: the same four, read from the row and the record it names. */
export function answersRowMarks(project: string, row: JournalRow): AnswersMarks {
  const namespace = unitRefusalNamespace(project);
  requireCondition(isPlainObject(row) && isRef(row.source), "journal_request_invalid", "The marks of a row are read from a row naming its exact record");
  const origin = isPlainObject(row.origin) ? row.origin as unknown as Record<string, unknown> : {};
  const roles = Array.isArray(origin['sources'])
    ? Array.from(origin['sources'] as unknown[]).map(item => isPlainObject(item) ? (item as Record<string, unknown>)['role'] : undefined) : [];
  return marks(namespace, row.source.id, row.gate, [origin['stage']], [roles]);
}

// Any mark is looked for loosely (a case or a namespace segment elsewhere is still a mark), the exact form strictly.
function marks(namespace: string, id: string, gate: unknown, stages: readonly unknown[], roles: readonly (readonly unknown[])[]): AnswersMarks {
  const loose = (value: unknown, mark: string): boolean => typeof value === "string" && value.toLowerCase() === mark.toLowerCase();
  const segment = G4B_MARKERS.segment.slice(0, -1);
  const any = loose(gate, G4B_MARKERS.gate) || id.toLowerCase().split(":").includes(segment)
    || stages.some(stage => loose(stage, G4B_MARKERS.stage)) || roles.some(set => set.some(role => loose(role, G4B_MARKERS.role)));
  const exact = gate === G4B_MARKERS.gate && id.startsWith(`${namespace}${G4B_MARKERS.segment}`)
    && /^[0-9a-f]{64}$/.test(id.slice(namespace.length + G4B_MARKERS.segment.length))
    && stages.length === 1 && stages[0] === G4B_MARKERS.stage
    && roles.length === 1 && roles[0]!.length === 1 && roles[0]![0] === G4B_MARKERS.role;
  return { any, exact };
}

// A G4b source is admitted only by its typed reader; null is "not a G4b source", the refusal says why one is not.
type AnswersIssue = { readonly field: "markers" | "reader"; readonly refused: Refusal | null };
function answersSourceIssue(store: Store, project: string, source: Ref, value: unknown): AnswersIssue | null {
  const found = answersSourceMarks(project, source, value);
  if (!found.any) return null;
  if (!found.exact) return { field: "markers", refused: null };
  if (answersSourceReader === null) return { field: "reader", refused: null };
  const proved = answersSourceReader(store, project, source);
  return proved.ok ? null : { field: "reader", refused: proved.refusal };
}

/**
 * Appends the refusals of one unit refusal record to the project's journal.
 * The record is read at its exact reference inside this project's namespace, and the journal is written in one
 * guarded transaction with that record and the journal's own head as guards (T7). Recording the same record again
 * adds no row and no revision (T5), and this unit writes nothing but the journal (T8).
 */
export function recordRefusal(store: Store, request: RecordRefusalRequest): OmResult<Sealed<Revision<RefusalJournal>>> {
  return applied(store, prepareRecord(store, request));
}

/**
 * Writes what G7 derived for one journalled refusal: its class, its addressee and the grounds it was derived from.
 * The row itself is not touched, so its id still stands for its content. A classification already written is not
 * replaced: the same one again changes nothing, and a different one is refused — a later reading does not undo an
 * earlier decision (T5). Like a row, a classification switches nothing else (T8).
 */
export function classifyRefusal(store: Store, request: ClassifyRefusalRequest): OmResult<Sealed<Revision<RefusalJournal>>> {
  requireStore(store);
  requireCondition(isPlainObject(request), "journal_request_invalid", "A classification is asked for by a request object");
  // One decision is a set of one: the accepted operation and the set share every rule, so neither can drift.
  return applied(store, prepareClassify(store, { project: request.project, classifications: [request] }));
}

// Each change is prepared once and applied in one of two ways: written on its own here, or handed to a caller that
// writes it together with other records in a single guarded transaction. One implementation, two entrances.
export const prepareRecordRefusal = (store: Store, request: RecordRefusalRequest): OmResult<Sealed<JournalTransition>> =>
  handed(prepareRecord(store, request));
export const prepareClassifyRefusal = (store: Store, request: ClassifyRefusalsRequest): OmResult<Sealed<JournalTransition>> =>
  handed(prepareClassify(store, request));

const handed = (prepared: OmResult<Prepared>): OmResult<Sealed<JournalTransition>> =>
  prepared.ok ? delivered(prepared.value.transition) : prepared;

const unchanged = (current: Revision<RefusalJournal>): OmResult<Prepared> =>
  ({ ok: true, value: { transition: { writes: [], guards: [], value: current.value }, current } });

function applied(store: Store, prepared: OmResult<Prepared>): OmResult<Sealed<Revision<RefusalJournal>>> {
  if (!prepared.ok) return prepared;
  const { transition, current } = prepared.value;
  // Nothing to write is a fact, not a failure: the journal already holds what was asked for.
  if (transition.writes.length === 0) return delivered(current!);
  const written = writeGuarded<RefusalJournal>(store, {
    unit: UNIT, target: transition.writes[0]!.id, guards: transition.guards, writes: [...transition.writes],
  });
  if (!written.ok) return written;
  return delivered(written.value[0]!);
}

function prepareRecord(store: Store, request: RecordRefusalRequest): OmResult<Prepared> {
  requireStore(store);
  requireCondition(isPlainObject(request), "journal_request_invalid", "A refusal is journalled through a request object");
  const project = requireProject(request.project);
  const target = journalId(project);

  const read = readSource(store, request.source, project, target);
  if (!read.ok) return read;
  const source = reference(read.value);

  const current = currentJournal(store, project, target);
  if (current && !current.ok) return current;
  const head = current && current.ok ? (current.value as Revision<RefusalJournal>) : null;
  const rows: readonly JournalRow[] = head ? head.value.rows : [];

  const additions: JournalRow[] = [];
  appendRows(read.value.value, source, new Set(rows.map(row => row.id)), additions);
  if (head && additions.length === 0) return unchanged(head);

  // A journal that has classified nothing yet says so explicitly: an absent set is never read as an empty one (T4).
  const value: RefusalJournal = {
    projectId: project,
    rows: [...rows, ...additions],
    classifications: head ? head.value.classifications : [],
  };
  return {
    ok: true,
    value: {
      transition: {
        // The record the rows came from is guarded beside the journal's own head: a gate that rewrites its record
        // between this reading and the write leaves no row standing for content it no longer holds (T7).
        guards: head ? [source, reference(head)] : [source],
        writes: [{ id: target, kind: REFUSAL_JOURNAL_KIND, expected: head ? head.revision : 0, value }],
        value,
      },
      current: head,
    },
  };
}

function prepareClassify(store: Store, request: ClassifyRefusalsRequest): OmResult<Prepared> {
  requireStore(store);
  requireCondition(isPlainObject(request), "journal_request_invalid", "A classification is asked for by a request object");
  const project = requireProject(request.project);
  const target = journalId(project);
  // An absent set is not an empty one, and an explicitly empty one decides nothing: a caller with nothing to
  // classify adds nothing to its transaction instead of asking for a change that would be none.
  requireCondition(Array.isArray(request.classifications) && request.classifications.length > 0,
    "journal_request_invalid", "A classification names at least one refusal G7 decided about");
  for (const item of request.classifications) requireClassification(item);

  const current = currentJournal(store, project, target);
  if (!current) return refused("journal_missing", "This project holds no journal of refusals to classify", { unit: UNIT, target }, "producer");
  if (!current.ok) return current;
  const head = current.value as Revision<RefusalJournal>;
  const context: Context = { target, ref: reference(head) };
  const decided = decide(new Set(head.value.rows.map(row => row.id)), head.value.classifications, request.classifications, context,
    answersRows(project, head.value.rows));
  if (!decided.ok) return decided;
  const additions = decided.value;
  if (additions.length === 0) return unchanged(head);

  const value: RefusalJournal = {
    projectId: project,
    rows: head.value.rows,
    classifications: [...head.value.classifications, ...additions],
  };
  return {
    ok: true,
    value: {
      transition: {
        guards: [reference(head)],
        writes: [{ id: target, kind: REFUSAL_JOURNAL_KIND, expected: head.revision, value }],
        value,
      },
      current: head,
    },
  };
}

/**
 * Prepares one batch of the journal: the rows of every named source and every decision about them, as ONE write.
 * The journal's head is taken once, before anything is weighed against it, and every rule is the one the single
 * operations use — the same reading of a source, the same row, the same repeat, the same conflict, the same order: rows
 * in the order their sources are first named, decisions in the order they are asked for. A batch of one source, or of
 * decisions alone, therefore prepares the very journal the single operation does. A batch that finds no journal creates
 * it with its rows and decisions at once; a batch the journal already holds writes nothing and still names the head it
 * was weighed against, as its guard and as its result.
 */
export function prepareJournalBatch(store: Store, request: JournalBatchRequest): OmResult<Sealed<JournalBatch>> {
  requireStore(store);
  // The key set is exact: a flag beside the sets (say, "already verified") would be a word to trust instead of a check.
  requireCondition(isPlainObject(request) && exactKeys(request, BATCH_KEYS),
    "journal_request_invalid", "A batch of the journal is asked for by its project, sources, pending writes and decisions, and nothing else");
  // Everything below is weighed on ONE copy: an object of the caller read twice could say one thing to a check and
  // another to the journal.
  const asked = sealedRequest(request);
  const project = requireProject(asked.project);
  const target = journalId(project);
  // Each set is said explicitly: an absent one is the calling code's defect, never read as "nothing" (T4).
  requireCondition(Array.isArray(asked.sources), "journal_request_invalid", "A batch names its source records, explicitly empty when it adds no row");
  requireCondition(Array.isArray(asked.pending), "journal_request_invalid", "A batch names the source records its transaction creates, explicitly empty when every source stands already");
  requireCondition(Array.isArray(asked.classifications), "journal_request_invalid", "A batch names the decisions of G7, explicitly empty when it decides nothing");
  const pending = pendingRecords(asked.pending);
  for (const item of asked.classifications) requireClassification(item);
  // A reference is data, as on the single path: a malformed one is an addressed refusal, found before the store is read.
  for (const source of asked.sources as readonly unknown[]) {
    if (isRef(source)) continue;
    const malformed = readSource(store, source, project, target);
    if (!malformed.ok) return malformed;
  }
  // A source named twice is one source, read once; the first mention keeps its place.
  const named: Ref[] = [];
  for (const ref of asked.sources as readonly Ref[]) if (!named.some(seen => refKey(seen) === refKey(ref))) named.push(ref);
  // A pending write no source names would be written with no row standing for it.
  for (const id of pending.keys()) {
    requireCondition(named.some(source => source.id === id), "journal_request_invalid", "Each pending record is a source this batch journals");
  }

  const current = currentJournal(store, project, target);
  if (current && !current.ok) return current;
  const head = current ? (current.value as Revision<RefusalJournal>) : null;
  const rows: readonly JournalRow[] = head ? head.value.rows : [];

  const known = new Set(rows.map(row => row.id));
  const additions: JournalRow[] = [];
  const stored: Ref[] = [];
  const creations: JournalWrite[] = [];
  for (const ref of named) {
    const staged = pending.get(ref.id);
    // A pending record whose exact bytes stand already has been created: its write could only fail now, so it is read
    // and guarded as any stored record (T5 — a repeat adds no revision).
    const creates = staged !== undefined && !standsAlready(store, staged.record) ? staged : undefined;
    const read = readSource(creates ? withPending(store, creates.record) : store, ref, project, target);
    if (!read.ok) return read;
    const source = reference(read.value);
    appendRows(read.value.value, source, known, additions);
    if (creates) creations.push(creates.write);
    else stored.push(source);
  }
  // Nothing creates a journal that is absent: an absent journal is not an empty one (T4).
  if (!head && additions.length === 0) {
    return refused("journal_missing", "This project holds no journal, and the batch adds no refusal to begin one", { unit: UNIT, target }, "producer");
  }
  const context: Context = { target, ref: head ? reference(head) : undefined };
  const decided = decide(known, head ? head.value.classifications : [], asked.classifications, context,
    answersRows(project, [...rows, ...additions]));
  if (!decided.ok) return decided;
  if (head && additions.length === 0 && decided.value.length === 0) {
    const standing = reference(head);
    return delivered<JournalBatch>({ writes: [], guards: [standing], value: head.value, result: standing });
  }

  const value: RefusalJournal = {
    projectId: project,
    rows: [...rows, ...additions],
    classifications: [...(head ? head.value.classifications : []), ...decided.value],
  };
  const expected = head ? head.revision : 0;
  return delivered<JournalBatch>({
    // The records this batch read as pending are written from the copy it read, never from the caller's object, so no
    // row can name bytes other than those the transaction writes.
    writes: [...creations, { id: target, kind: REFUSAL_JOURNAL_KIND, expected, value }],
    // Every stored record the batch read, as on the single path, and the journal as it was read: its head, or its
    // absence when this write creates it (lesson 43). A pending record is guarded by its own write (expected 0).
    guards: [...stored, head ? reference(head) : { id: target, absent: true }],
    value,
    result: { id: target, revision: expected + 1, hash: hashJson(value) },
  });
}

function sealedRequest(request: JournalBatchRequest): Sealed<JournalBatchRequest> {
  try { return sealed(request); }
  catch (error) {
    if (error instanceof EngineError && error.code === "unsealable_value")
      throw new EngineError("journal_request_invalid", "A batch of the journal is finite JSON", { unit: UNIT, target: REFUSAL_JOURNAL_KIND, field: "request" });
    throw error;
  }
}

// One reading of a source record on every entrance: its exact address in this project's namespace, its kind, its hash,
// then the strict shape of its content.
function readSource(store: Store, ref: unknown, project: string, target: string): OmResult<Sealed<Revision<UnitRefusalRecord>>> {
  const read = readRecord<UnitRefusalRecord>(store, ref, {
    unit: UNIT, target, kind: UNIT_REFUSAL_KIND, idPrefix: unitRefusalNamespace(project),
  });
  if (!read.ok) return read;
  const context: Context = { target, ref: reference(read.value) };
  const broken = checkUnitRefusalRecord(read.value.value, context);
  if (broken) return broken;
  const answers = answersSourceIssue(store, project, context.ref!, read.value.value);
  if (answers === null) return read;
  // The typed reader's own refusal is passed on as it is: it names the exact ground of G4b that failed.
  if (answers.refused) return { ok: false, refusal: answers.refused };
  return problem("refusal_record_invalid", answers.field === "markers"
    ? "A record carrying any mark of G4b carries all of them: its gate, namespace, stage and one finding-proof as the only source of one refusal"
    : "No typed reader of G4b sources is loaded here, and a G4b source is not admitted on its shape", context, answers.field);
}

/** Appends the rows of one checked record that `known` does not hold yet. */
function appendRows(record: UnitRefusalRecord, source: Ref, known: Set<string>, additions: JournalRow[]): void {
  for (const entry of record.refusals) {
    const row = rowOf(record.gate, entry, source);
    // T5: the same refusal again is a repeat, not a second event, on either path — a re-delivered record or a
    // record that names one refusal twice. Two DIFFERENT records keep their own rows, so a repetition across
    // attempts still reaches G7 (T6).
    if (known.has(row.id)) continue;
    known.add(row.id);
    additions.push(row);
  }
}

// The rows that carry any mark of G4b: already proved by their typed reader, and never classified.
const answersRows = (project: string, rows: readonly JournalRow[]): ReadonlySet<string> =>
  new Set(rows.filter(row => answersRowMarks(project, row).any).map(row => row.id));

/** The decisions of a request that do not stand yet, weighed against the rows and the decisions that do. */
function decide(rows: ReadonlySet<string>, standing: readonly RefusalClassification[],
  requested: readonly RefusalClassification[], context: Context, answers: ReadonlySet<string>): OmResult<RefusalClassification[]> {
  // The decisions already standing and those taken earlier in THIS set are weighed alike: a set that says one thing
  // twice says it once, and a set that says two different things about one refusal decides it twice, which is what
  // the journal holds each refusal once against.
  const decided = new Map(standing.map(item => [item.row, item as RefusalClassification]));
  const additions: RefusalClassification[] = [];
  for (const item of requested) {
    if (!rows.has(item.row)) return problem("row_unknown", "No refusal stands in this journal under that id", context, "row");
    // №1628 Q1, C36: G4b has no refusal of its own for G7 to classify; a decision about a G4b row is refused by address,
    // never kept as a class or an addressee to be read back.
    if (answers.has(item.row)) return problem("classification_invalid", "A G4b row is an observation of the gate and is never classified", context, "row");
    const classification = classificationOf(item);
    const already = decided.get(item.row);
    if (already) {
      if (hashJson(already) === hashJson(classification)) continue;
      return problem("classification_conflict", "This refusal is classified already, and a later classification does not replace the earlier one", context, "row");
    }
    decided.set(item.row, classification);
    additions.push(classification);
  }
  return { ok: true, value: additions };
}

interface Pending { readonly write: JournalWrite; readonly record: Revision<unknown> }

/**
 * The exact prepared writes of source records a batch journals before they stand. Refusal records are immutable, so a
 * pending one is created by its write — expected 0, revision 1 — and each is written once. The writes come from the
 * batch's own copy of the request, and it is this copy the batch hands back to be written.
 */
function pendingRecords(writes: readonly unknown[]): Map<string, Pending> {
  const records = new Map<string, Pending>();
  for (const write of writes) {
    requireCondition(isPlainObject(write) && exactKeys(write, WRITE_KEYS),
      "journal_request_invalid", "A pending source is the exact write of its record: its id, kind, expected revision and value");
    const fields = write as Record<string, unknown>;
    const id = fields['id'], kind = fields['kind'], value = fields['value'];
    requireCondition(isText(id) && isText(kind), "journal_request_invalid", "A pending source write names its id and kind");
    requireCondition(fields['expected'] === 0, "journal_request_invalid", "A pending source record is created by its write, at revision 1");
    requireCondition(!records.has(id as string), "journal_request_invalid", "A pending source record is written once");
    records.set(id as string, {
      write: { id: id as string, kind: kind as string, expected: 0, value },
      record: { id: id as string, kind: kind as string, revision: 1, hash: hashJson(value), value },
    });
  }
  return records;
}

// A pending record is read exactly as a stored one, from a view that holds it at the revision its write creates.
function withPending(store: Store, record: Revision<unknown>): Store {
  return new Proxy(store, { get(target, key) {
    if (key === "get") return (id: string, revision?: number) =>
      id === record.id && (revision === undefined || revision === record.revision) ? record : target.get(id, revision);
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}

function standsAlready(store: Store, record: Revision<unknown>): boolean {
  const found = store.get(record.id, record.revision);
  return found !== null && found.kind === record.kind && found.hash === record.hash;
}

const refKey = (ref: Ref): string => `${ref.id}\0${ref.revision}\0${ref.hash}`;

function requireClassification(value: unknown): void {
  requireCondition(isPlainObject(value), "journal_request_invalid", "A classification is asked for by an object");
  const item = value as unknown as RefusalClassification;
  requireCondition(isText(item.row), "journal_request_invalid", "A classification names the journal row it stands for");
  // The class and the addressee are G7's words, checked for being said at all, never for being one of a list this
  // unit keeps: the vocabulary belongs to the gate that derives them.
  requireCondition(isText(item.class), "journal_request_invalid", "A classification names the class G7 derived from the origin");
  requireCondition(isText(item.addressee), "journal_request_invalid", "A classification names who the refusal goes back to");
  requireCondition(Array.isArray(item.basis),
    "journal_request_invalid", "A classification carries the grounds it was derived from, explicitly empty when the origin was not established");
  for (const ground of item.basis) {
    requireCondition(sourceIssue(ground) === null,
      "journal_request_invalid", "Each ground of a classification names its role and an exact reference");
  }
}

/**
 * Reads the project's journal. An absent journal is a typed refusal, not an empty one: a project that has never been
 * refused and a project whose journal was lost are different facts, and no consumer may read them alike (T4).
 */
export function readJournal(store: Store, request: JournalRequest): OmResult<Sealed<Revision<RefusalJournal>>> {
  requireStore(store);
  requireCondition(isPlainObject(request), "journal_request_invalid", "A journal is read through a request object");
  const project = requireProject(request.project);
  const target = journalId(project);
  const current = currentJournal(store, project, target);
  if (!current) return refused("journal_missing", "This project holds no journal of refusals", { unit: UNIT, target }, "producer");
  return current;
}

/** Historical journal sources are checked by the same derivation without consulting a head. */
export function readJournalAt(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<RefusalJournal>>> {
  const invalid = (field: string): never => { throw new EngineError("journal_request_invalid", "A historical journal needs its project and exact reference",
    { unit: UNIT, target: REFUSAL_JOURNAL_KIND, field }); };
  if (!(store instanceof Store)) invalid("store");
  try { project = requireProject(project); }
  catch (error) { if (error instanceof EngineError && error.code === "journal_request_invalid") invalid("project"); throw error; }
  if (!isRef(ref)) invalid("reference");
  const target = journalId(project);
  const read = readRecord<RefusalJournal>(store, ref, { unit: UNIT, target, kind: REFUSAL_JOURNAL_KIND, id: target });
  if (!read.ok) return read;
  const broken = checkJournal(store, read.value.value, project, { target, ref });
  return broken ?? read;
}

function currentJournal(store: Store, project: string, target: string): OmResult<Sealed<Revision<RefusalJournal>>> | null {
  // The head revision of an exact id is what a reference to it is made of; the record itself is then read as any
  // accepted record is, so a foreign kind sitting at this address is refused instead of being appended to.
  const head = store.get<RefusalJournal>(target);
  if (!head) return null;
  return readJournalAt(store, project, reference(head));
}

function rowOf(gate: string, entry: UnitRefusal, source: Ref): JournalRow {
  // Fields are copied one by one: a row holds what the journal is defined to hold and nothing else, whatever the
  // record around them carried.
  const body = {
    gate,
    code: entry.code, goal: entry.goal, remedy: entry.remedy,
    origin: {
      name: entry.origin.name, stage: entry.origin.stage, subject: entry.origin.subject,
      // T6: the order sources arrive in decides nothing, so a row is stored canonically and the same refusal
      // delivered twice hashes alike.
      sources: entry.origin.sources
        .map(normalizeOriginSource)
        .sort((left, right) => compare(originSourceKey(left as OriginSource), originSourceKey(right as OriginSource))),
    },
    source: { id: source.id, revision: source.revision, hash: source.hash },
  };
  return { id: hashJson(body), ...body };
}

function classificationOf(source: RefusalClassification): RefusalClassification {
  return {
    row: source.row, class: source.class, addressee: source.addressee,
    // Canonical for the same reason a row is: two readings of the same decision must compare equal (T5, T6).
    basis: source.basis
      .map(normalizeOriginSource)
      .sort((left, right) => compare(originSourceKey(left as OriginSource), originSourceKey(right as OriginSource))),
  };
}

// Not localeCompare: a row id is the hash of its own content, so the order must not depend on the machine's locale.
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function checkUnitRefusalRecord(value: unknown, context: Context): OmResult<never> | null {
  if (!isPlainObject(value) || !exactKeys(value, RECORD_KEYS)) {
    return problem("refusal_record_invalid", "A unit refusal record carries the gate that refused and the set of its refusals, and nothing else", context, "value");
  }
  const record = value as Record<string, unknown>;
  if (!isText(record['gate'])) return problem("refusal_record_invalid", "A unit refusal record names the gate that refused", context, "gate");
  const refusals = record['refusals'];
  // An absent set is not an empty one, and an explicitly empty one is not a refusal: a gate that refused and named
  // no refusal would leave the journal nothing to return to anyone.
  if (!Array.isArray(refusals)) return problem("refusal_record_invalid", "A unit refusal record carries a set of refusals", context, "refusals");
  if (refusals.length === 0) return problem("refusals_missing", "A gate that refused names at least one refusal", context, "refusals");
  for (let index = 0; index < refusals.length; index += 1) {
    const found = checkRefusal(refusals[index], context, `refusals.${index}`, INCOMING);
    if (found) return found;
  }
  return null;
}

function checkRefusal(value: unknown, context: Context, path: string, codes: Codes): OmResult<never> | null {
  // The key set is exact: a record that also declares a class, an addressee or a status of its own would offer a
  // consumer a verdict to trust instead of the origin G7 derives one from.
  if (!isPlainObject(value) || !exactKeys(value, ENTRY_KEYS)) {
    return problem(codes.entry, "A refusal carries its code, goal, remedy and origin, and nothing a consumer could read as a verdict", context, path);
  }
  const entry = value as Record<string, unknown>;
  for (const field of ENTRY_TEXTS) {
    if (!isText(entry[field])) return problem(codes.entry, `A refusal names the ${field} it was refused with`, context, `${path}.${field}`);
  }
  return checkOrigin(entry['origin'], context, `${path}.origin`, codes);
}

function checkOrigin(value: unknown, context: Context, path: string, codes: Codes): OmResult<never> | null {
  if (!isPlainObject(value) || !exactKeys(value, ORIGIN_KEYS)) {
    return problem(codes.origin, "An origin carries the refusal's name, the stage it arose at, the refused object and its exact sources", context, path);
  }
  const origin = value as Record<string, unknown>;
  for (const field of ORIGIN_TEXTS) {
    if (!isText(origin[field])) return problem(codes.origin, `An origin names its ${field}`, context, `${path}.${field}`);
  }
  const sources = origin['sources'];
  // An absent set is not an empty one. "The origin was not established" is said explicitly, and G7 turns such a
  // refusal into a saved stop for analysis instead of classifying it; an absent set says nothing at all.
  if (!Array.isArray(sources)) {
    return problem(codes.origin, "An origin carries a set of exact sources, explicitly empty when none was established", context, `${path}.sources`);
  }
  for (let index = 0; index < sources.length; index += 1) {
    const where = `${path}.sources.${index}`;
    const item = sources[index];
    const issue = sourceIssue(item);
    if (issue !== null) return problem(codes.source, "A source needs its role, exact reference and complete context", context, issue ? `${where}.${issue}` : where);
  }
  return null;
}

function checkJournal(store: Store, value: unknown, project: string, context: Context): OmResult<never> | null {
  if (!isPlainObject(value) || !exactKeys(value, JOURNAL_KEYS)) return problem("journal_invalid", "A journal carries its project and its rows", context, "value");
  const journal = value as Record<string, unknown>;
  const projectId = journal['projectId'];
  if (!isText(projectId)) return problem("journal_invalid", "A journal names the project it belongs to", context, "projectId");
  // A journal of another project standing at this address is not this project's journal, however well it reads.
  if (projectId !== project) return problem("journal_foreign", `A journal of ${String(projectId)} cannot stand for ${project}`, context, "projectId");
  const rows = journal['rows'];
  if (!Array.isArray(rows)) return problem("journal_invalid", "A journal carries a set of rows", context, "rows");
  const seen = new Set<string>();
  const answers = new Set<string>();
  const derived = new Map<string, ReadonlyMap<string, JournalRow>>();
  for (let index = 0; index < rows.length; index += 1) {
    const path = `rows.${index}`;
    const row = rows[index];
    if (!isPlainObject(row) || !exactKeys(row, ROW_KEYS)) return problem("journal_invalid", "A journal row carries its id, its gate, the refusal and the record it was taken from", context, path);
    const fields = row as Record<string, unknown>;
    const id = fields['id'];
    const gate = fields['gate'];
    const from = fields['source'];
    if (!isText(id) || !isText(gate)) return problem("journal_invalid", "A journal row names its id and its gate", context, `${path}.id`);
    if (!isRef(from)) return problem("journal_invalid", "A journal row names the exact record it was taken from", context, `${path}.source`);
    const bad = checkRefusal({ code: fields['code'], goal: fields['goal'], remedy: fields['remedy'], origin: fields['origin'] }, context, path, STORED);
    if (bad) return bad;
    // T3: the row is derived AGAIN from the refusal record it names, not read back from its own fields. A row that
    // merely agrees with itself — content rewritten and its id recomputed to match — is not a refusal the gate gave.
    const produced = rowsOfSource(store, project, from, context, path, derived);
    if ("ok" in produced) return produced;
    const rowId = id as string;
    const original = produced.get(rowId);
    if (!original || hashJson(original) !== hashJson(row)) {
      return problem("journal_invalid", "A journal row does not hold the refusal the record it names produced", context, path);
    }
    if (seen.has(rowId)) return problem("journal_invalid", "A journal holds each refusal once", context, `${path}.id`);
    seen.add(rowId);
    if (answersRowMarks(project, original).any) answers.add(rowId);
  }
  return checkClassifications(journal['classifications'], seen, context, answers);
}

/**
 * The rows the named refusal record produces, derived by the same function that appends them.
 * The record is read at the EXACT revision the row names, so a gate that has since rewritten its record does not
 * make a row journalled earlier false; and it is read as this project's refusal record, so a row cannot borrow its
 * ground from another project or from a record of another kind.
 */
function rowsOfSource(
  store: Store, project: string, source: Ref, context: Context, path: string,
  derived: Map<string, ReadonlyMap<string, JournalRow>>,
): ReadonlyMap<string, JournalRow> | OmResult<never> {
  const key = `${source.id}:${source.revision}:${source.hash}`;
  const known = derived.get(key);
  if (known) return known;
  const read = readRecord<UnitRefusalRecord>(store, source, {
    unit: UNIT, target: context.target, kind: UNIT_REFUSAL_KIND, idPrefix: unitRefusalNamespace(project),
  });
  if (!read.ok) {
    return problem("journal_invalid", `The record a row names is not a refusal of this project: ${read.refusal.code}`, context, `${path}.source`);
  }
  const broken = checkUnitRefusalRecord(read.value.value, context);
  if (broken) return problem("journal_invalid", "The record a row names holds no refusal it could have come from", context, `${path}.source`);
  // C36: a G4b row is read through the same typed derivation that admitted it, and refused where none is loaded.
  const answers = answersSourceIssue(store, project, source, read.value.value);
  if (answers !== null) {
    return problem("journal_invalid", `The record a row names is not a G4b source its typed reader proves: ${answers.refused ? answers.refused.code : answers.field}`,
      context, `${path}.source`);
  }
  const rows = new Map<string, JournalRow>();
  for (const entry of read.value.value.refusals) {
    const row = rowOf(read.value.value.gate, entry, source);
    rows.set(row.id, row);
  }
  derived.set(key, rows);
  return rows;
}

function checkClassifications(value: unknown, rows: ReadonlySet<string>, context: Context, answers: ReadonlySet<string>): OmResult<never> | null {
  // A journal of the earlier shape, which carried no set of classifications at all, is not an unclassified journal:
  // "nothing classified yet" is said with an empty set, and an absent one says nothing (T4).
  if (!Array.isArray(value)) return problem("journal_invalid", "A journal carries its set of classifications, explicitly empty until G7 has classified a refusal", context, "classifications");
  const classified = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `classifications.${index}`;
    const item = value[index];
    if (!isPlainObject(item) || !exactKeys(item, CLASSIFICATION_KEYS)) {
      return problem("journal_invalid", "A classification carries the row it stands for, its class, its addressee and its grounds", context, path);
    }
    const fields = item as Record<string, unknown>;
    for (const field of CLASSIFICATION_TEXTS) {
      if (!isText(fields[field])) return problem("journal_invalid", `A classification names its ${field}`, context, `${path}.${field}`);
    }
    const basis = fields['basis'];
    if (!Array.isArray(basis)) return problem("journal_invalid", "A classification carries the grounds it was derived from", context, `${path}.basis`);
    for (let ground = 0; ground < basis.length; ground += 1) {
      const where = `${path}.basis.${ground}`;
      const issue = sourceIssue(basis[ground]);
      if (issue !== null) return problem("journal_invalid", "A ground needs its role, exact reference and complete context", context, issue ? `${where}.${issue}` : where);
    }
    if (hashJson(classificationOf(item as unknown as RefusalClassification)) !== hashJson(item)) {
      return problem("journal_invalid", "A classification is not held as this unit writes one", context, path);
    }
    const row = fields['row'] as string;
    // A classification of a refusal this journal does not hold stands for nothing, and a second one for the same
    // row would leave two answers where G7 decided once.
    if (!rows.has(row)) return problem("journal_invalid", "A classification stands for a refusal this journal does not hold", context, `${path}.row`);
    // №1628 Q1: a G4b row is an observation or a pointer to an existing ground, never a refusal G7 classifies.
    if (answers.has(row)) return problem("journal_invalid", "A G4b row is never classified: a stored classification of one is not a decision G7 took", context, `${path}.row`);
    if (classified.has(row)) return problem("journal_invalid", "A refusal is classified once", context, `${path}.row`);
    classified.add(row);
  }
  return null;
}

// Own keys only, and exactly these: a value parsed from JSON may carry "__proto__" as an own field, and an unexpected
// field is a difference in content, not a detail to ignore.
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  const own = Object.keys(value as object);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value as object, key));
}

// Every refusal of this unit goes back to whoever produced the record it read: the class of a JOURNALLED refusal is
// G7's to derive from the origin, and this unit never routes one on a gate's behalf.
function problem(code: RefusalJournalCode, message: string, context: Context, field: string): OmResult<never> {
  return refused(code, message, { unit: UNIT, target: context.target, field, ref: context.ref }, "producer");
}

function requireStore(store: unknown): asserts store is Store {
  requireCondition(store instanceof Store, "journal_request_invalid", "A journal is read and written through a store");
}

function requireProject(project: unknown): string {
  requireCondition(typeof project === "string" && project.length > 0, "journal_request_invalid", "A journal is named for a project");
  // ':' separates namespaces inside an id: a project carrying one would address another project's records.
  requireCondition(!project.includes(":"), "journal_request_invalid", "A project name carries no ':' namespace separator");
  requireCondition(project.length + REFUSAL_JOURNAL_KIND.length + 1 <= MAX_ENTITY_ID,
    "journal_request_invalid", "A project name that overflows an entity id cannot be journalled");
  return project;
}

import { canonical, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
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
  "row_unknown", "classification_conflict",
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

interface Context { readonly target: string; readonly ref: Ref }
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

  const read = readRecord<UnitRefusalRecord>(store, request.source, {
    unit: UNIT, target, kind: UNIT_REFUSAL_KIND, idPrefix: unitRefusalNamespace(project),
  });
  if (!read.ok) return read;
  const source = reference(read.value);
  const context: Context = { target, ref: source };
  const broken = checkUnitRefusalRecord(read.value.value, context);
  if (broken) return broken;

  const current = currentJournal(store, project, target);
  if (current && !current.ok) return current;
  const head = current && current.ok ? (current.value as Revision<RefusalJournal>) : null;
  const rows: readonly JournalRow[] = head ? head.value.rows : [];

  const known = new Set(rows.map(row => row.id));
  const additions: JournalRow[] = [];
  for (const entry of read.value.value.refusals) {
    const row = rowOf(read.value.value.gate, entry, source);
    // T5: the same refusal again is a repeat, not a second event, on either path — a re-delivered record or a
    // record that names one refusal twice. Two DIFFERENT records keep their own rows, so a repetition across
    // attempts still reaches G7 (T6).
    if (known.has(row.id)) continue;
    known.add(row.id);
    additions.push(row);
  }
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
  const rows = new Set(head.value.rows.map(row => row.id));
  // The decisions already standing and those taken earlier in THIS set are weighed alike: a set that says one thing
  // twice says it once, and a set that says two different things about one refusal decides it twice, which is what
  // the journal holds each refusal once against.
  const decided = new Map(head.value.classifications.map(item => [item.row, item as RefusalClassification]));
  const additions: RefusalClassification[] = [];
  for (const item of request.classifications) {
    if (!rows.has(item.row)) return problem("row_unknown", "No refusal stands in this journal under that id", context, "row");
    const classification = classificationOf(item);
    const already = decided.get(item.row);
    if (already) {
      if (hashJson(already) === hashJson(classification)) continue;
      return problem("classification_conflict", "This refusal is classified already, and a later classification does not replace the earlier one", context, "row");
    }
    decided.set(item.row, classification);
    additions.push(classification);
  }
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

function currentJournal(store: Store, project: string, target: string): OmResult<Sealed<Revision<RefusalJournal>>> | null {
  // The head revision of an exact id is what a reference to it is made of; the record itself is then read as any
  // accepted record is, so a foreign kind sitting at this address is refused instead of being appended to.
  const head = store.get<RefusalJournal>(target);
  if (!head) return null;
  const read = readRecord<RefusalJournal>(store, reference(head), { unit: UNIT, target, kind: REFUSAL_JOURNAL_KIND, id: target });
  if (!read.ok) return read;
  const broken = checkJournal(store, read.value.value, project, { target, ref: reference(head) });
  return broken ?? read;
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
  }
  return checkClassifications(journal['classifications'], seen, context);
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
  const rows = new Map<string, JournalRow>();
  for (const entry of read.value.value.refusals) {
    const row = rowOf(read.value.value.gate, entry, source);
    rows.set(row.id, row);
  }
  derived.set(key, rows);
  return rows;
}

function checkClassifications(value: unknown, rows: ReadonlySet<string>, context: Context): OmResult<never> | null {
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

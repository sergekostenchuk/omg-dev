import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import { readRecord } from "./refs.js";
import { readJournal, readJournalAt, journalId, normalizeOriginSource, type JournalRow, type RefusalOrigin } from "./refusal-journal.js";
import {
  readStopHistory, readStopHistoryAt, readAnySeriesAt, seriesRequestOf, seriesAddress, stopReviewNamespace, COMPLETION_REASONS, STOP_REVIEW_KIND,
  type CompletionReason, type Continuation, type SeriesRequest, type StopHistory, type StopHistoryEntry,
  type AnySeriesRequest, type SeriesAddress, type MechanismOwner,
} from "./series.js";
import { readStopContext, readStopContextAt, originHoldNamespace, ADDRESSEE_KINDS, REFUSAL_CLASSES,
  type RefusalClass, type StopContext, type StopContextSources } from "./repeat-gate.js";

/**
 * THE EXPLANATION OF A STOP, ASSEMBLED BY CODE.
 *
 * The context of a stop is already assembled by the gate of repetition (readStopContext, A4): the goals that were
 * named, what was accepted, which refusals repeat with the class and the addressee G7 derived for each, the standing
 * holds, why the cycles ended, and the grounds the series was continued on. This unit turns that context into the
 * explanation the ladder after a stop asks for — for the REVIEWER on the first rung and for the OWNER on the second —
 * and it is the SAME context on both: one function assembles it, and this unit adds to it only what the rules name
 * beside it.
 *
 * NO MODEL IS CALLED to write any of it (rules-g7). Every line is assembled from stored records, so two readings of the
 * same records give the same explanation, byte for byte. What a model DID say — the cause and the change a reviewer
 * named in the record of an analysis — is carried as a VERSION with the exact record it was said in, never as a fact
 * this unit establishes: "the cause the model named stays a version, not a fact". The same line is drawn around what a
 * GATE wrote: the way to fix a refusal, as the journal records it, is a RECORDED REMEDY and not a proven cause.
 *
 * WHAT IT DOES NOT DECIDE. The verdict of a cycle, the count, the stop, the rung of the ladder and the class of every
 * refusal are the findings of the series (A3) and of the gate (A4): they are read here and derived again nowhere. How a
 * recorded analysis ENDED is likewise the series' finding, read from where the series put it — a review that decided is
 * the ground of a continuation, a review that ended without a decision is the ground of an escalation — so this unit
 * has no second way of establishing that, and refuses a record whose content contradicts where the series put it
 * instead of choosing between them.
 *
 * WHAT IT DOES ESTABLISH is one thing only: the SUBJECT of the stop — what the records say stands behind it, and who
 * answers for it (STOP_SUBJECT_DECISIONS). It is said only when the records SUFFICE to say it: one obstacle with one
 * responsible, a failure of the ENVIRONMENT rather than of the construction of the product, or an origin held for
 * analysis. Anything less — several candidates without a distinguishing ground, a mixture of kinds, a refusal the
 * journal classes not at all — is a cause NOT ESTABLISHED, and then it is written down as not established, with the
 * known facts beside it. There is no last row that answers by default.
 *
 * STATE IS NOT HISTORY. The ladder of a series says what the NEXT continuation has to satisfy, and a new accepted
 * result returns it to the start — which drops the windows already spent and the goals of the stop it began at. So the
 * goals of a stop already answered and the boundary of a window already closed are NOT in the ladder, and this unit
 * neither approximates them ("every goal named occurred somewhere") nor walks the attempts a second time to work them
 * out: it reads them from readStopHistory (A3), which the one walk that builds and checks the ladder fills in as it
 * goes. There is one derivation of the rules of a series, and it is A3's.
 *
 * HISTORY AND HEADS ARE NOT THE SAME THING. A record the series has already moved on — the analysis a continuation or
 * an escalation stands on — is a HISTORICAL ground: it is read at the exact reference the series holds, and a newer
 * revision of it makes that ground no less true, so it is not guarded. What the freshness of this explanation depends
 * on are the mutable HEADS it was read from, and ALL of them: the series, the journal, and every hold of the lineage,
 * lifted or standing, which the gate names in the reading it hands over. Those are the report's guards, for whoever
 * writes on it (T7); checkStanding weighs a report against them and against the records again before it is acted on.
 *
 * It writes nothing (T8).
 */
const UNIT = "om-stop-report";

/** Who the rung of the ladder hands the explanation to. The table is closed: a rung it does not name has no audience. */
export const REPORT_AUDIENCES = Object.freeze(["reviewer", "owner"] as const);
export type ReportAudience = typeof REPORT_AUDIENCES[number];

// The rungs of the ladder after a stop, as the series derives them: the first is the analysis with an independent
// reviewer, the second the call of the owner, and the ladder never climbs back down (rules-g8).
const AUDIENCE_OF: Readonly<Record<number, ReportAudience>> = Object.freeze({ 1: "reviewer", 2: "owner" });

/**
 * What the records say stands behind a stop.
 *   obstacle    — one repeated obstacle with one responsible, as the class of its refusal gave it;
 *   environment — the cycles were broken off by the repository, the workspace or the executor: a failure of the
 *                 ENVIRONMENT, which the explanation and its addressee speak of instead of a failed construction;
 *   origin      — the origin of the refusal is not established and is held for analysis at its own address;
 *   unknown     — the records do not single out any of these, and that is what is written down.
 */
export const STOP_SUBJECTS = Object.freeze(["obstacle", "environment", "origin", "unknown"] as const);
export type StopSubject = typeof STOP_SUBJECTS[number];

/** What was done after an earlier stop of this lineage, and what kind of record it stood on. */
export const REMEDY_KINDS = Object.freeze(["review-record", "inputs-fixed", "owner-decision", "escalation"] as const);
export type RemedyKind = typeof REMEDY_KINDS[number];

/**
 * What became of the window a remedy opened — read from the history, never guessed. A LATER STOP BY ITSELF DOES NOT
 * MAKE A REMEDY THE ONE THAT FAILED: a window opens at every new accepted result as well, so a stop counted in a
 * window that a result opened belongs to that result, not to the remedy before it.
 *   ended-undecided      — the analysis ended without a decision, which is why the stop went to the owner; it opened
 *                          no window at all;
 *   result-followed      — the window it opened ended at a new accepted result: this remedy is not what failed;
 *   window-stopped-again — the window it opened closed in another stop, with no accepted result in between;
 *   standing             — the window it opened is the one the series stands in, and what stops the work now was not
 *                          counted in it (a held origin, for instance).
 */
export const REMEDY_OUTCOMES = Object.freeze(["ended-undecided", "result-followed", "window-stopped-again", "standing"] as const);
export type RemedyOutcome = typeof REMEDY_OUTCOMES[number];

/** Every refusal this unit can produce. The list is the checklist its test walks, so a new code cannot arrive untested. */
export const STOP_REPORT_CODES = Object.freeze([
  "analysis_unreadable", "analysis_invalid", "obstacle_unrecorded", "report_stale", "report_forged",
] as const);
export type StopReportCode = typeof STOP_REPORT_CODES[number];

/** The two parts of an analysis a reviewer names, and the only ones the rules ask the owner to be shown. */
export const CLAIM_SUBJECTS = Object.freeze(["cause", "change"] as const);
export type ClaimSubject = typeof CLAIM_SUBJECTS[number];

/**
 * A JSON value exactly as a record says it. Written out here rather than taken from canonical.ts because what a unit
 * delivers is deeply readonly (T11), and a value that can be handed back to this unit has to say so in its type.
 */
export type StatedValue = string | number | boolean | null | readonly StatedValue[] | { readonly [key: string]: StatedValue };

/**
 * Something a MODEL named. `standing` is "version" and nothing else: the reviewer is a model call, so the cause it
 * named is a version of what happened and not a fact of the records. `stated` is null when the reviewer explicitly
 * named none — "the reviewer could not name a cause" is itself a fact worth handing on.
 */
export interface StopClaim {
  readonly what: ClaimSubject;
  readonly standing: "version";
  readonly stated: StatedValue;
  readonly record: Ref;
}

/** One thing that was tried after an earlier stop, the records it stood on, and what became of it. */
export interface StopRemedy {
  /** The attempt the stop it answered was saved after. */
  readonly after: number;
  readonly kind: RemedyKind;
  /** The exact records it stood on — the saved link to them, never a name and a goal two grounds could share. */
  readonly records: readonly Ref[];
  /** The row of the journal a fixed input named, when that is what was tried. */
  readonly refusal: string | null;
  /** What the series recorded as the ground's own text. */
  readonly text: string;
  readonly claims: readonly StopClaim[];
  readonly outcome: RemedyOutcome;
  readonly explained: string;
}

/**
 * One obstacle of the window WITH THE CONTENT the journal records for it: what the gate refused, the check it was
 * securing, the origin, and the way to fix it the gate wrote down. The row id is the hash of the row's own content, so
 * it is the one unambiguous link to the source, and `source` names the record of the gate the row was appended from.
 * `class` and `addressee` are G7's findings, read beside the row and derived again nowhere.
 */
export interface StopObstacleRow {
  readonly row: string;
  readonly source: Ref;
  readonly gate: string;
  readonly code: string;
  readonly goal: string;
  /** What the gate RECORDED as the way to fix it. A recorded remedy is not a cause anybody proved. */
  readonly remedy: string;
  readonly origin: RefusalOrigin;
  readonly class: RefusalClass | null;
  readonly addressee: string | null;
  /** How many cycles of the window ran into it: a refusal that repeats is one this number is above one for. */
  readonly times: number;
}

/** How many of each fact the window of this stop holds. Nothing here is a verdict; the table below reads it. */
export interface StopFacts {
  readonly attempts: number;
  readonly endings: Readonly<Record<CompletionReason, number>>;
  readonly obstacles: number;
  readonly repeating: number;
  readonly classes: Readonly<Record<RefusalClass, number>>;
  /** Obstacles the journal holds no classification for: an unclassified obstacle blames nobody. */
  readonly unclassified: number;
  /** Distinct responsibles among the classified obstacles: two of them single nobody out. */
  readonly addressees: number;
  readonly holds: number;
  readonly accepted: number;
}

/** What this unit establishes: the subject of the stop, its address and its responsible — or that it is not established. */
export interface StopFinding {
  readonly subject: StopSubject;
  /** Who answers for it, as the class of the refusal gave it (G7) — null when the records single nobody out. */
  readonly addressee: string | null;
  readonly rows: readonly string[];
  readonly facts: StopFacts;
  readonly text: string;
}

/**
 * The explanation of one stop. `context` is the context of the stop exactly as the gate assembles it — the reviewer on
 * the first rung and the owner on the second are handed the same one.
 */
export interface StopReport {
  readonly project: string;
  readonly block: string;
  readonly line: number;
  readonly series: string;
  readonly rung: number;
  readonly audience: ReportAudience;
  readonly context: StopContext;
  /** The obstacles of the window with the content the journal records for each, in one canonical order. */
  readonly obstacles: readonly StopObstacleRow[];
  readonly finding: StopFinding;
  /** What was tried after the earlier stops of this lineage, oldest first, and what became of each. */
  readonly remedies: readonly StopRemedy[];
  /** The changes an analysis proposed, each a version of its reviewer's and never a fact of this unit's. */
  readonly proposed: readonly StopClaim[];
  /** The mutable heads this report was read from, at the revision they stood at: the guards of whoever writes on it. */
  readonly guards: readonly Ref[];
  /** The explanation itself, assembled by code from the facts above. No model writes a line of it. */
  readonly lines: readonly string[];
}

export interface MechanismStopReport extends Omit<StopReport, "block"> { readonly owner: MechanismOwner }
export type AnyStopReport = StopReport | MechanismStopReport;
export type StopReportSources = StopContextSources;

const BLAMING_CLASSES: readonly RefusalClass[] = Object.freeze(["proposal", "input", "derivation", "readiness"] as const);
const blamed = (facts: StopFacts): number => BLAMING_CLASSES.reduce((sum, item) => sum + facts.classes[item], 0);

/**
 * THE TABLE OF DECISION for the subject of a stop: each row is a subject and the condition under which the records
 * SUFFICE to say it. There is no last row that answers by default — a tally no row admits is a cause not established,
 * and a tally two rows admitted would be a defect of this table, which its test walks every combination of to exclude.
 *   obstacle    — every obstacle of the window is classified, every one of them blames the construction of the
 *                 product, and they all come back to ONE responsible: that responsible is the address of the stop.
 *                 Nothing else may be in the window — no held origin, no unclassified obstacle, no condition of the
 *                 environment and no cycle broken off by one — because each of those is a second candidate.
 *   environment — nothing in the window blames the construction of the product, and the environment is named: either
 *                 by a refusal of the conditions (repository, workspace, executor) or, when no refusal was recorded at
 *                 all, by cycles that were broken off and by nothing else.
 *   origin      — exactly one origin is held for analysis, every obstacle of the window is that unplaced refusal, and
 *                 nothing else stands beside it. Two holds are two candidates, and single out neither.
 */
export const STOP_SUBJECT_DECISIONS: readonly Readonly<{ subject: StopSubject; sufficient: (facts: StopFacts) => boolean }>[] = Object.freeze([
  Object.freeze({
    subject: "obstacle" as const,
    sufficient: (f: StopFacts) => f.holds === 0 && f.unclassified === 0 && f.endings.interrupted === 0
      && f.classes.unknown === 0 && f.classes.conditions === 0
      && f.obstacles >= 1 && blamed(f) === f.obstacles && f.addressees === 1,
  }),
  Object.freeze({
    subject: "environment" as const,
    sufficient: (f: StopFacts) => f.holds === 0 && f.unclassified === 0 && f.classes.unknown === 0 && blamed(f) === 0
      && (f.classes.conditions >= 1
        || (f.obstacles === 0 && f.endings.interrupted >= 1 && f.endings.refused === 0 && f.endings["off-form"] === 0)),
  }),
  Object.freeze({
    subject: "origin" as const,
    sufficient: (f: StopFacts) => f.holds === 1 && f.unclassified === 0 && f.endings.interrupted === 0
      && blamed(f) === 0 && f.classes.conditions === 0
      && f.obstacles >= 1 && f.classes.unknown === f.obstacles,
  }),
]);

const REPORT_KEYS = Object.freeze([
  "project", "block", "line", "series", "rung", "audience", "context", "obstacles", "finding", "remedies", "proposed",
  "guards", "lines",
] as const);
const MECHANISM_REPORT_KEYS = Object.freeze([...REPORT_KEYS.filter(key => key !== "block"), "owner"]);
const REVIEW_PARTS = Object.freeze(["cause", "change"] as const);

interface Assembled { readonly report: AnyStopReport; readonly guards: readonly Ref[] }
/** The address of the series being explained, as the request names it and the record was checked against it (A3). */
type Address = SeriesAddress;

// ---------------------------------------------------------------------------

/**
 * Assembles the explanation of what stops one series, for the rung of the ladder the series stands on.
 * It reads the series, the journal of refusals, the holds of the lineage and the record of every analysis this lineage
 * recorded, and it changes nothing. A series where nothing stops the work has no explanation to give, and the gate
 * says so (stop_absent).
 */
export function stopReport(store: Store, request: SeriesRequest): OmResult<Sealed<StopReport>>;
export function stopReport(store: Store, request: AnySeriesRequest): OmResult<Sealed<AnyStopReport>>;
export function stopReport(store: Store, request: AnySeriesRequest): OmResult<Sealed<AnyStopReport>> {
  requireStore(store);
  requireCondition(isPlainObject(request), "stop_report_invalid", "The explanation of a stop is asked for through a request object");
  const assembled = assemble(store, request);
  return assembled.ok ? delivered(assembled.value.report) : assembled;
}

/** Capture only the mutable inputs of the checked report; all deeper witnesses remain in their saved records. */
export function stopReportSources(report: Sealed<AnyStopReport>): Sealed<StopReportSources> {
  requireReport(report);
  const address = seriesAddress(reportRequest(report)), byId = new Map(report.guards.map(ref => [ref.id, ref]));
  if (byId.size !== report.guards.length || report.series !== address.id || !byId.has(address.id)) reportInvalid("guards");
  const series = byId.get(address.id)!, journal = byId.get(journalId(address.project)) ?? null;
  const holds = report.guards.filter(ref => ref.id.startsWith(originHoldNamespace(address.project)));
  if (1 + Number(journal !== null) + holds.length !== report.guards.length) reportInvalid("guards");
  return sealed({ series: exactRef(series), journal: journal === null ? null : exactRef(journal), holds: holds.map(exactRef) });
}

/** Reassemble through A3/A4 and the same report formula from exact saved sources, without current admission. */
export function readStopReport(store: Store, request: { project: string; sources: StopReportSources }): OmResult<Sealed<AnyStopReport>> {
  if (!(store instanceof Store)) reportInvalid("store");
  if (!(isPlainObject(request) && isText(request.project) && isPlainObject(request.sources)
    && exactKeys(request.sources, ["series", "journal", "holds"]) && isRef(request.sources.series)
    && (request.sources.journal === null || isRef(request.sources.journal))
    && Array.isArray(request.sources.holds) && request.sources.holds.every(isRef))) reportInvalid("sources");
  const fixed = sealed({ project: request.project, sources: { series: exactRef(request.sources.series),
    journal: request.sources.journal === null ? null : exactRef(request.sources.journal), holds: request.sources.holds.map(exactRef) } });
  const series = readAnySeriesAt(store, fixed.project, fixed.sources.series);
  if (!series.ok) return series;
  const assembled = assemble(store, seriesRequestOf(series.value.value), fixed.sources);
  return assembled.ok ? delivered(assembled.value.report) : assembled;
}

/**
 * Weighs a report against the records again, for whoever is about to act on it — A6 writing the analysis of this stop,
 * H2 writing the owner's decision. A HEAD that moved since the report was assembled is the window between a check and
 * a write, and it is refused rather than written through (T7); a report the unchanged heads do not give is not a report
 * of theirs, and is refused too. A newer revision of a HISTORICAL ground is neither: the grounds the series already
 * moved on are read at their exact references, so the report goes on standing. What comes back is the report as the
 * records give it NOW, so that the caller acts on that one and guards its transaction with its guards.
 */
export function checkStanding(store: Store, report: Sealed<StopReport>): OmResult<Sealed<StopReport>>;
export function checkStanding(store: Store, report: Sealed<AnyStopReport>): OmResult<Sealed<AnyStopReport>>;
export function checkStanding(store: Store, report: Sealed<AnyStopReport>): OmResult<Sealed<AnyStopReport>> {
  requireStore(store);
  requireReport(report);
  // The address is derived from the project, the block and the line: what a report says its own series is would be
  // the caller's word, and a refusal must be addressed at the series the records are read for.
  const request = reportRequest(report), target = seriesAddress(request).id;
  const moved = movedGuard(store, report.guards);
  if (moved !== null) {
    return refused("report_stale", "A head this explanation was read from has moved since, so the explanation no longer stands for what the records hold",
      { unit: UNIT, target, field: "guards", ref: moved }, "producer");
  }
  const again = assemble(store, request);
  if (!again.ok) return again;
  // Every head the report was read from is among its guards, so unchanged guards give the same explanation again:
  // a difference here is a difference in the report, not in the records (T3).
  if (hashJson(again.value.report as unknown as Json) !== hashJson(report as unknown as Json)) {
    return refused("report_forged", "The records these guards stand at do not give this explanation",
      { unit: UNIT, target, field: "lines" }, "producer");
  }
  return delivered(again.value.report);
}

// ---------------------------------------------------------------------------

function assemble(store: Store, request: AnySeriesRequest, sources?: StopReportSources): OmResult<Assembled> {
  // The context is assembled by the ONE function that assembles it, and it hands over the heads it read: the series,
  // the journal and every hold of the lineage, lifted or standing. Nothing is guessed about what the gate touched.
  const read = sources ? readStopContextAt(store, { project: request.project, sources }) : readStopContext(store, request);
  if (!read.ok) return read;
  const held = read.value.context as StopContext;
  const guards: Ref[] = [...read.value.reads];
  // The history of the stops — their exact goals and the boundaries of their windows — from the one derivation of the
  // rules of a series. This unit reads the series' record through these two and not a third time of its own.
  const history = sources ? readStopHistoryAt(store, request.project, sources.series) : readStopHistory(store, request);
  if (!history.ok) return history;
  // A3 checks the record's own projectId, block and line against the address the request names before it returns
  // anything, so the request's address IS the record's.
  const at = seriesAddress(request);

  const rung = held.ladder.rung;
  const audience = Object.hasOwn(AUDIENCE_OF, rung) ? AUDIENCE_OF[rung] : undefined;
  // The rung is derived and checked by the series on every reading, which names two of them; a third would be a defect
  // of engine code, not data a consumer handed over.
  requireCondition(audience !== undefined, "stop_report_broken", "The ladder after a stop has two rungs, and each has its audience");

  const obstacles = obstaclesOf(store, at, held, guards, sources);
  if ("ok" in obstacles) return obstacles;
  const remedies = remediesOf(store, at, history.value as StopHistory, held.ladder.goals);
  if ("ok" in remedies) return remedies;
  // The rules ask the owner to be shown the analysis that was made and why it did not help. A stop reaches the owner's
  // rung only by spending the first one, which is a recorded continuation or a recorded escalation, so an owner's
  // explanation without one would be a defect of the series' own derivation rather than a missing input.
  requireCondition(audience !== "owner" || remedies.length > 0,
    "stop_report_broken", "The owner's rung is reached by spending the first one, and what was spent is on record");

  const facts = factsOf(held);
  const finding = findingOf(held, facts, obstacles);
  // A change nobody named is no proposal: an analysis that found none says so, and none is invented in its place.
  const proposed = remedies.flatMap(item => item.claims.filter(claim => claim.what === "change" && claim.stated !== null));
  const report: AnyStopReport = {
    project: at.project, ...(at.owner.kind === "block" ? { block: at.owner.block } : { owner: at.owner }), line: at.line,
    series: at.id, rung, audience: audience as ReportAudience,
    context: held, obstacles, finding, remedies, proposed,
    guards: uniqueGuards(guards),
    lines: linesOf(held, obstacles, finding, remedies, proposed, audience as ReportAudience),
  };
  return { ok: true, value: { report, guards } };
}

// ---------------------------------------------------------------------------
// The obstacles of the window, with what the journal records about each.

/**
 * The content of every journal row the cycles of this window ran into: what the gate refused, the check it was
 * securing, the origin it was weighed over and the way to fix it the gate wrote down — beside the class and the
 * addressee G7 derived for it. A row the journal does not hold is not an obstacle anybody can be sent to work on, and
 * it is refused rather than reported as a bare hash.
 */
function obstaclesOf(store: Store, at: Address, context: StopContext, guards: Ref[], sources?: StopReportSources): readonly StopObstacleRow[] | OmResult<never> {
  if (context.repeated.length === 0) return [];
  if (sources && sources.journal === null) return refused("obstacle_unrecorded", "The saved obstacles require their historical journal",
    { unit: UNIT, target: at.id, field: "sources.journal" }, "producer");
  const journal = sources ? readJournalAt(store, at.project, sources.journal!) : readJournal(store, { project: at.project });
  if (!journal.ok) return journal;
  guards.push(reference(journal.value));
  const rows = new Map(journal.value.value.rows.map(row => [row.id, row as JournalRow]));
  const found: StopObstacleRow[] = [];
  for (const obstacle of context.repeated) {
    const row = rows.get(obstacle.row);
    if (row === undefined) {
      return refused("obstacle_unrecorded", `The journal of this project holds no row at ${obstacle.row}, so there is no obstacle to explain under it`,
        { unit: UNIT, target: at.id, field: `repeated.${obstacle.row}` }, "producer");
    }
    found.push({
      row: row.id, source: exactRef(row.source), gate: row.gate, code: row.code, goal: row.goal, remedy: row.remedy,
      origin: {
        name: row.origin.name, stage: row.origin.stage, subject: row.origin.subject,
        sources: row.origin.sources.map(normalizeOriginSource),
      },
      class: obstacle.class, addressee: obstacle.addressee, times: obstacle.times,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// What was tried, and what became of it.

/**
 * Everything this lineage did after a saved stop, oldest first, taken from THE HISTORY OF THE STOPS (A3) and not from
 * the lists of the record: the history attributes every escalation and every continuation to the stop it really
 * answered, and it says what ended the window each continuation opened. An escalation answers a stop and opens no
 * window; a continuation opens one, and a later stop by itself says nothing about it — a new accepted result in between
 * closed that window and opened another.
 * The record of an analysis is read at the exact reference the history holds for it, and at no other.
 */
function remediesOf(store: Store, at: Address, history: StopHistory, ladderGoals: readonly string[]):
readonly StopRemedy[] | OmResult<never> {
  const remedies: StopRemedy[] = [];
  for (const entry of history.stops) {
    if (entry.escalation !== null) {
      const claims = claimsOf(store, at, entry, "escalation", entry.escalation.review);
      if ("ok" in claims) return claims;
      remedies.push({
        after: entry.attempt, kind: "escalation", records: [exactRef(entry.escalation.review)], refusal: null,
        text: "the analysis of this stop ended without a decision",
        claims, outcome: "ended-undecided", explained: explainedText(entry, "ended-undecided", ladderGoals, claims),
      });
    }
    if (entry.continuation === null) continue;
    const ground = entry.continuation;
    const claims = ground.ground === "review-record" ? claimsOf(store, at, entry, ground.ground, ground.review) : [];
    if ("ok" in claims) return claims;
    // A3's walk opens a window for every continuation it applies and says what became of it, so a continued stop
    // without one would be a defect of engine code, not a fact about this series.
    requireCondition(entry.window !== null,
      "stop_report_broken", "A continued stop opens a window, and the history of the line says what became of it");
    const ended = entry.window.ended;
    const outcome: RemedyOutcome = ended === "progress" ? "result-followed"
      : ended === "stop" ? "window-stopped-again" : "standing";
    remedies.push({
      after: entry.attempt, kind: ground.ground, records: recordsOf(ground),
      refusal: ground.ground === "inputs-fixed" ? ground.refusal : null, text: ground.text,
      claims, outcome, explained: explainedText(entry, outcome, ladderGoals, claims),
    });
  }
  return remedies;
}

function recordsOf(ground: Continuation): readonly Ref[] {
  if (ground.ground === "review-record") return [exactRef(ground.review)];
  if (ground.ground === "inputs-fixed") return [exactRef(ground.input), exactRef(ground.confirmation)];
  return [exactRef(ground.decision)];
}

/**
 * What a model named in the record of an analysis — the cause and the change — read at the exact reference the history
 * of the stops holds, inside this project's namespace and as a record of a review and nothing else.
 *
 * The exact reference proves WHICH record was read; it does not prove the record is about THIS stop, so the address of
 * its content is weighed too — the project, the block, the attempt the stop was saved after, and THE GOALS that stop
 * was counted over, compared EXACTLY as the unordered set A3 compares them as (T6). Those goals come from the history,
 * which has them for a stop already answered as well as for the one standing; nothing weaker stands in for them. A
 * record of the right kind, at the right revision, with the right hash, about the same attempt of the same block but
 * about a different set of goals is an analysis of something else, and becomes neither the explanation of this stop nor
 * a change proposed for it. The number of the LINE decides nothing here: an inherited stop keeps its attempt and its
 * goals in the successor, so the analysis of it goes on standing, while the analysis of another stop never does.
 *
 * HOW THE ANALYSIS ENDED is not established here: a review that decided is the ground of a CONTINUATION and a review
 * that ended without a decision is the ground of an ESCALATION, and the series established which when it recorded one.
 * This unit reads that placement and checks the record agrees with it — a record whose content says the other thing is
 * a contradiction between a derived record and its source, and neither of the two is chosen over the other (T3).
 * The other two grounds — a confirmed fix of an input, the owner's own decision — name no cause and no change: what
 * they stand on is kept as the exact records above, and nothing in them is a version of anybody's.
 *
 * The record is NOT guarded. The series has already moved on it, so it is a historical ground: a newer revision of it
 * is a later reading of the same stop and makes this ground no less true (T3). Guarding it would turn every legitimate
 * second revision of an analysis into a permanent staleness of every report of this series.
 */
function claimsOf(store: Store, at: Address, entry: StopHistoryEntry, kind: RemedyKind, ref: Ref):
readonly StopClaim[] | OmResult<never> {
  const field = `${kind === "escalation" ? "escalations" : "continuations"}.${entry.attempt}`;
  const read = readRecord<Json>(store, ref, {
    unit: UNIT, target: at.id, kind: STOP_REVIEW_KIND, idPrefix: stopReviewNamespace(at.project),
  });
  if (!read.ok) {
    return refused("analysis_unreadable", `The analysis this series recorded for the stop after attempt ${entry.attempt} cannot be read at the reference the series holds: ${read.refusal.code}`,
      { unit: UNIT, target: at.id, field, ref: exactRef(ref) }, "producer");
  }
  const invalid = (message: string, part: string): OmResult<never> =>
    refused("analysis_invalid", message, { unit: UNIT, target: at.id, field: `${field}.${part}`, ref: exactRef(ref) }, "producer");
  const value = read.value.value as unknown;
  if (!isPlainObject(value)) return invalid("A record that is not an analysis of a stop explains nothing", "value");
  const record = value as Record<string, unknown>;
  // The address of the record. Whether its reviewer was independent and whether its cause is worth anything are A6's
  // to establish, and no field of the record claiming either is consulted here.
  if (record['projectId'] !== at.project || (at.owner.kind === "block"
    ? record['block'] !== at.owner.block || Object.hasOwn(record, "owner")
    : Object.hasOwn(record, "block") || canonical(record['owner'] ?? null) !== canonical(at.owner))) {
    return invalid("An analysis of another series owner explains nothing about this stop", at.owner.kind === "block" ? "block" : "owner");
  }
  if (record['stop'] !== entry.attempt) return invalid("An analysis of another stop explains nothing about this one", "stop");
  if (!sameGoals(record['goals'], entry.goals)) {
    return invalid("An analysis of other goals explains nothing about this stop", "goals");
  }
  for (const part of REVIEW_PARTS) {
    if (!Object.hasOwn(record, part) || notSaid(record[part])) {
      return invalid(`An analysis says its ${part}, explicitly null when there is none; a part left out or left empty is a broken record, not an outcome`, part);
    }
  }
  const undecided = record['cause'] === null || record['change'] === null;
  if (undecided !== (kind === "escalation")) {
    return invalid(kind === "escalation"
      ? "This analysis names a cause and a change, so it is not the analysis without a decision the series escalated on"
      : "This analysis ended without a decision, so it is not the analysis the series continued on", "cause");
  }
  return CLAIM_SUBJECTS.map(what => ({
    what, standing: "version" as const,
    stated: (record[what] ?? null) as StatedValue,
    record: exactRef(ref),
  }));
}

/**
 * T6: the goals of a stop are an unordered set on both sides, put in one order before they are compared, and the
 * comparison is EXACT — a goal lost, a goal added from another window and a goal of another series alike make it
 * another set. Multiplicity is kept by the sort, so a set that names one goal twice is not the set that names it once.
 */
function sameGoals(named: unknown, exact: readonly string[]): boolean {
  if (!Array.isArray(named) || named.length === 0 || !named.every(isText)) return false;
  return hashJson([...(named as string[])].sort(compare)) === hashJson([...exact].sort(compare));
}

// A part of an analysis is either SAID, or explicitly none. An empty text or an empty structure is neither, so it is no
// outcome at all but a broken record (the contract of a review, src/om/series.ts).
const notSaid = (value: unknown): boolean => value !== null
  && !(isText(value) || (Array.isArray(value) ? value.length > 0 : isPlainObject(value) && Object.keys(value as object).length > 0));

function explainedText(
  entry: StopHistoryEntry, outcome: RemedyOutcome, ladderGoals: readonly string[], claims: readonly StopClaim[],
): string {
  if (outcome === "ended-undecided") {
    const missing = claims.filter(claim => claim.stated === null).map(claim => claim.what);
    return `it named no ${missing.join(" and no ")}, so it decided nothing and the stop after attempt ${entry.attempt} went to the owner`;
  }
  const window = entry.window;
  if (outcome === "result-followed" && window !== null && window.ended === "progress") {
    const ladder = ladderGoals.includes(window.goal) ? ", the goal the ladder stands for" : "";
    return `the window it opened after attempt ${entry.attempt} ended at attempt ${window.at}, which the series counted as a new accepted result (${window.accepted.join(", ")}) of ${window.goal}${ladder}: whatever stopped the series later was counted in the window that result opened, not in this one`;
  }
  if (outcome === "window-stopped-again" && window !== null && window.ended === "stop") {
    return `the window it opened after attempt ${entry.attempt} closed in the stop after attempt ${window.at}, with no new accepted result counted in between`;
  }
  return `the window it opened after attempt ${entry.attempt} is the one this series stands in, and what stops the work now was not counted in it`;
}

// ---------------------------------------------------------------------------
// The subject of the stop.

function factsOf(context: StopContext): StopFacts {
  const classified = context.repeated.filter(item => item.class !== null && item.addressee !== null);
  return {
    attempts: context.endings.length,
    endings: counted(COMPLETION_REASONS, context.endings.map(item => item.reason)),
    obstacles: context.repeated.length,
    repeating: context.repeated.filter(item => item.times > 1).length,
    classes: counted(REFUSAL_CLASSES, classified.map(item => item.class as RefusalClass)),
    unclassified: context.repeated.length - classified.length,
    addressees: new Set(classified.map(item => item.addressee as string)).size,
    holds: context.holds.length,
    accepted: context.accepted.length,
  };
}

function counted<Key extends string>(keys: readonly Key[], seen: readonly Key[]): Readonly<Record<Key, number>> {
  const table = {} as Record<Key, number>;
  for (const key of keys) table[key] = 0;
  for (const key of seen) table[key] += 1;
  return Object.freeze(table);
}

function findingOf(context: StopContext, facts: StopFacts, obstacles: readonly StopObstacleRow[]): StopFinding {
  const admitted = STOP_SUBJECT_DECISIONS.filter(decision => decision.sufficient(facts));
  requireCondition(admitted.length <= 1, "stop_report_broken", "The table of decision admits one subject for a tally at most");
  const decided = admitted[0];
  const subject: StopSubject = decided === undefined ? "unknown" : decided.subject;
  if (subject === "obstacle") {
    const blaming = obstacles.filter(item => item.class !== null && BLAMING_CLASSES.includes(item.class));
    const first = blaming[0]!;
    return {
      subject, addressee: first.addressee, rows: blaming.map(item => item.row).sort(compare), facts,
      text: `One obstacle stands behind this stop, answered for by ${String(first.addressee)}: ${named(blaming)}.`,
    };
  }
  if (subject === "environment") {
    // The conditions of the repository, the workspace and the executor go to the owner or to the environment, and the
    // explanation speaks of a failure THERE — not of a failed construction of the product.
    const conditions = obstacles.filter(item => item.class === "conditions");
    const addressee = `${ADDRESSEE_KINDS.conditions}:${context.series}`;
    return {
      subject, addressee, rows: conditions.map(item => item.row).sort(compare), facts,
      text: `The work of this window was stopped by the ENVIRONMENT, not by the construction of the product: ${environmentFacts(facts, conditions)}. It goes to ${addressee}.`,
    };
  }
  if (subject === "origin") {
    const hold = context.holds[0]!;
    const row = obstacles.find(item => item.row === hold.row);
    return {
      subject, addressee: hold.address, rows: [hold.row], facts,
      text: `The origin of the refusal attempt ${hold.attempt} ran into is not established, so it is held for analysis at ${hold.address}: ${row === undefined ? `the refusal arose at the stage "${hold.origin.stage}" over "${hold.origin.subject}"` : named([row])}.`,
    };
  }
  return {
    subject, addressee: null, rows: obstacles.map(item => item.row).sort(compare), facts,
    text: `The cause of this stop is NOT established: ${knownFacts(facts)}${obstacles.length === 0 ? "" : `; the obstacles of the window are ${named(obstacles)}`}. These are the known facts; no cause is stated for them here, and none is invented.`,
  };
}

/** One obstacle as a reader can act on it: what was refused, over what, and the way to fix it the gate wrote down. */
const named = (obstacles: readonly StopObstacleRow[]): string => obstacles
  .map(item => `"${item.code}" (${item.gate}, stage "${item.origin.stage}", over "${item.origin.subject}", met by ${item.times} cycle(s), row ${item.row}), recorded way to fix it "${item.remedy}"`)
  .join("; ");

const environmentFacts = (facts: StopFacts, conditions: readonly StopObstacleRow[]): string => (conditions.length > 0
  ? `${named(conditions)} — refusals of the conditions of the repository, the workspace or the executor`
  : `${facts.endings.interrupted} of ${facts.attempts} cycle(s) were broken off and no refusal of the product was recorded`);

const knownFacts = (facts: StopFacts): string => [
  `${facts.attempts} cycle(s) ended in the window`,
  `${facts.obstacles} obstacle(s), ${facts.repeating} of them met by more than one cycle`,
  `${facts.unclassified} of them classified by nobody`,
  `${facts.addressees} responsible(s) named`,
  `${facts.holds} origin(s) held for analysis`,
  `${facts.accepted} accepted result(s) of these goals`,
].join("; ");

// ---------------------------------------------------------------------------
// The explanation itself. Every line is assembled here, from the facts above and from nothing else.

function linesOf(
  context: StopContext, obstacles: readonly StopObstacleRow[], finding: StopFinding,
  remedies: readonly StopRemedy[], proposed: readonly StopClaim[], audience: ReportAudience,
): readonly string[] {
  const lines: string[] = [
    `Goals named before the cycles: ${context.goals.map(item => `${item.key} (${item.result})`).join("; ")}.`,
    context.accepted.length === 0
      ? "Accepted results of these goals: none."
      : `Accepted results of these goals: ${context.accepted.join(", ")}.`,
    obstaclesLine(obstacles),
    repeatedLine(obstacles),
    `Obstacle and responsible: ${finding.text}`,
    "A recorded way to fix an obstacle is what the gate wrote down when it refused, not a cause anybody has proved: the cause of this stop is what the analysis of it has to name, and nothing here names one in its place.",
    endingsLine(context),
  ];
  lines.push(remedies.length === 0
    ? "Tried after an earlier stop: nothing — no stop of this series has been continued or sent on yet."
    : `Tried after an earlier stop: ${remedies.map(item => `after attempt ${item.after}, ${describe(item)} — ${item.explained}`).join("; ")}.`);
  lines.push(proposed.length === 0
    ? "Proposed change: none is on record. No change is invented here."
    : `Proposed change, as a VERSION of the reviewer who named it and not as a fact: ${proposed.map(claim => `${JSON.stringify(claim.stated)} (${claim.record.id})`).join("; ")}.`);
  lines.push(`Asked of the ${audience} on rung ${context.ladder.rung}: ${asked(context)}`);
  return lines;
}

const describe = (item: StopRemedy): string => (item.kind === "escalation"
  ? `the analysis ${item.records[0]!.id} was sent to the owner`
  : `the stop was continued on "${item.kind}" (${item.records.map(ref => ref.id).join(", ")})`);

const obstaclesLine = (obstacles: readonly StopObstacleRow[]): string => (obstacles.length === 0
  ? "Obstacles of the window, as the journal records them: none was recorded."
  : `Obstacles of the window, as the journal records them: ${obstacles.map(item =>
    `row ${item.row} — ${item.gate} refused "${item.code}" while securing "${item.goal}"; origin: "${item.origin.name}" at the stage "${item.origin.stage}" over "${item.origin.subject}" against ${item.origin.sources.length} source(s); recorded way to fix it: "${item.remedy}"; class ${item.class ?? "not classified"}, answered for by ${item.addressee ?? "nobody"}; met by ${item.times} cycle(s)`).join(". ")}.`);

const repeatedLine = (obstacles: readonly StopObstacleRow[]): string => {
  const repeating = obstacles.filter(item => item.times > 1);
  if (obstacles.length === 0) return "Refusals repeating: no refusal of the window was recorded.";
  if (repeating.length === 0) {
    return `Refusals repeating: none — each of the ${obstacles.length} refusal(s) of the window was met by one cycle only.`;
  }
  return `Refusals repeating: ${repeating.map(item => `"${item.code}" over "${item.origin.subject}" (row ${item.row}) met by ${item.times} cycles, answered for by ${String(item.addressee)}`).join("; ")}.`;
};

const endingsLine = (context: StopContext): string =>
  `Why the cycles ended: ${context.endings.map(item => `attempt ${item.attempt} — ${item.reason}`).join("; ")}.`;

const asked = (context: StopContext): string => (context.stop !== null
  ? context.stop.resume
  : `the origin of ${context.holds.length} refusal(s) is not established, and only its analysis or the owner's decision lifts the hold at ${context.holds.map(item => item.address).join(", ")}`);

// ---------------------------------------------------------------------------

function movedGuard(store: Store, guards: readonly Ref[]): Ref | null {
  for (const guard of guards) {
    const current = store.get(guard.id);
    if (current === null || current.revision !== guard.revision || current.hash !== guard.hash) return exactRef(guard);
  }
  return null;
}

const exactRef = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });

// Not localeCompare: what a reviewer and the owner are handed must not depend on the machine's locale.
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function uniqueGuards(guards: readonly Ref[]): Ref[] {
  const seen = new Map<string, Ref>();
  for (const guard of guards) seen.set(`${guard.id}\0${guard.revision}\0${guard.hash}`, exactRef(guard));
  return [...seen.values()];
}

// Own keys only, and exactly these: a value parsed from JSON may carry "__proto__" as an own field, and an unexpected
// field is a difference in content, not a detail to ignore.
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  const own = Object.keys(value as object);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value as object, key));
}

function requireStore(store: unknown): asserts store is Store {
  requireCondition(store instanceof Store, "stop_report_invalid", "A stop is explained out of a store");
}

function requireReport(report: unknown): asserts report is Sealed<AnyStopReport> {
  if (!(isPlainObject(report) && exactKeys(report, Object.hasOwn(report as object, "owner") ? MECHANISM_REPORT_KEYS : REPORT_KEYS))) reportInvalid("report");
  const value = report as unknown as AnyStopReport;
  if (!(isText(value.project) && Number.isSafeInteger(value.line) && isText(value.series)
    && ("owner" in value ? isPlainObject(value.owner) && exactKeys(value.owner, ["kind", "mechanism"])
      && value.owner.kind === "mechanism" && value.owner.mechanism === "M5:addressing" : isText(value.block)))) reportInvalid("owner");
  if (!(Array.isArray(value.guards) && value.guards.every(isRef))) reportInvalid("guards");
}

function reportInvalid(field: string): never {
  throw new EngineError("stop_report_invalid", "A stop report needs its explicit owner and complete exact sources",
    { unit: UNIT, target: "stop-report", field });
}

function reportRequest(report: Sealed<AnyStopReport>): AnySeriesRequest {
  const address = seriesAddress(report);
  return address.owner.kind === "block" ? { project: address.project, block: address.owner.block, line: address.line }
    : { project: address.project, owner: address.owner, line: address.line };
}

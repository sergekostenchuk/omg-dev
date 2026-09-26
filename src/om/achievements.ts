import { canonical, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import { readSeriesAt, type Achievement, type AttemptGoal, type RepairSeries } from "./series.js";
import { confirmGapLineResult, gapLinesNamespace } from "./gap-lines.js";
import { acceptedAnswerNamespace, confirmAcceptedAnswerResult } from "./accepted-answer.js";
import { FRAME_ACCEPTANCE_CONTRACT, readAcceptedFrameLayer } from "./layer-basis.js";
import { readResultIdentity } from "./result-identity.js";
import { withHistoricalReads } from "./input.js";

/**
 * The contract of the PROVIDERS OF ACCEPTANCE: who may say that a result was accepted, and what its lasting key is.
 *
 * Progress is only a NEW ACCEPTED result (rules-g7, the rules of model calls). The series of A3 folds a history of keys
 * and decides progress from them; it does not decide whether a key stands for anything accepted, and neither may the
 * caller who closes a cycle: a key named by the caller is the caller's word, and so is an existing record named as the
 * ground of a result it never accepted. So a result reaches the series only through this contract. A cycle names the
 * RECORDS that accepted its results and the transitions that cancelled earlier ones, never a key; each record is read
 * at its exact reference, handed to the provider registered for its kind, and the provider — which knows what an
 * accepting record of that kind looks like — confirms that the record really accepted something and DERIVES the
 * lasting keys from the record itself. A new name for an earlier result therefore comes back under its earlier key,
 * and the series sees no progress in it.
 *
 * The keys are derived and never passed: a key the caller also states could only agree with the derived one or
 * contradict it, and one accepting record may accept several results at once (a package call with a result per
 * question), which a single stated key could not say.
 *
 * The providers are the units that write accepting records — the closing of a gap line (D2), the checked answer (D5),
 * the accepted frame (C5). D2 verifies its historical closing grounds and recorded goal through its registered
 * provider, then derives the shared structural result identity. Cancellation providers remain unconnected. Provider
 * selection stays in the table below; no caller can hand a table of its own to any function here.
 */
const UNIT = "om-acceptance";

/** What a provider is told about the cycle whose result it is asked to confirm. */
export interface AcceptanceContext {
  readonly project: string;
  readonly block: string;
  /** The goal the attempt was begun for: a record that accepted a result of another goal is no progress of this one. */
  readonly goal: AttemptGoal;
  /** Exact historical slice being closed or reported; older suppliers retain their goal-only contract. */
  readonly attempt?: { readonly series: Ref; readonly ordinal: number };
  /** The complete claim being closed; E5 uses it to prevent omitting another assessed fact. */
  readonly accepting?: readonly Ref[];
}

/** What a provider answers about one record: the keys it derived from it, or why the record confirms nothing. */
export type Confirmation =
  | { readonly keys: readonly string[]; readonly guards?: readonly Ref[] }
  | { readonly unconfirmed: string };

/**
 * One provider: where its records live, and the function that reads one of them.
 * The namespace is checked before the provider is asked anything, so a record of another project is never weighed as
 * this one's, however well it reads.
 */
export interface AcceptanceProvider {
  readonly namespace: (project: string) => string;
  readonly confirm: (record: Sealed<Revision<Json>>, context: AcceptanceContext, store: Store) => Confirmation;
}

// A table keyed by kinds that come out of the store. It has no prototype, so a record whose kind is "constructor" or
// "__proto__" finds nothing, and it is frozen with its entries, so a caller cannot add a provider of its own.
function providers(entries: Record<string, AcceptanceProvider>): Readonly<Record<string, AcceptanceProvider>> {
  const table = Object.create(null) as Record<string, AcceptanceProvider>;
  for (const [kind, provider] of Object.entries(entries)) {
    Object.defineProperty(table, kind, {
      value: Object.freeze({ namespace: provider.namespace, confirm: provider.confirm }), enumerable: true,
    });
  }
  return Object.freeze(table);
}

/**
 * Kind of an ACCEPTING record → the provider written by its producing unit.
 * Historical grounds and semantic result identity are interpreted by that provider, never by this table.
 */
export const ACCEPTANCE_PROVIDERS = providers({ "gap-line": { namespace: gapLinesNamespace, confirm: confirmGapLineResult },
  "accepted-answer": { namespace: acceptedAnswerNamespace, confirm: confirmAcceptedAnswerResult },
  "connection-frame": { namespace: project => `om-frame:${project}:`, confirm: confirmAcceptedFrameResult } });

/**
 * Kind of a TRANSITION that cancelled an earlier result → its provider, which derives the keys of the results it
 * cancelled. One line per provider, like the table above.
 */
export const CANCELLATION_PROVIDERS = providers({});

// Every refusal this unit can produce. The list is the checklist its test walks, so a new code cannot arrive untested.
export const ACCEPTANCE_CODES = Object.freeze(["achievement_unconfirmed", "cancellation_unconfirmed"] as const);
export type AcceptanceCode = typeof ACCEPTANCE_CODES[number];

export interface ConfirmRequest {
  readonly project: string;
  readonly block: string;
  /** The series the outcome is recorded in: what a refusal is addressed to. */
  readonly target: string;
  /** The goal of the attempt being closed, or null when no attempt of that ordinal stands to confirm anything for. */
  readonly goal: AttemptGoal | null;
  readonly attempt?: AcceptanceContext["attempt"];
  readonly accepting: readonly Ref[];
  readonly cancelling: readonly Ref[];
}

/** What the series may be told: each result under the key its provider derived, with the record that accepted it. */
export interface ConfirmedResults {
  readonly achieved: readonly Achievement[];
  readonly cancelled: readonly string[];
  readonly guards?: readonly Ref[];
}

interface Side {
  readonly table: Readonly<Record<string, AcceptanceProvider>>;
  readonly code: AcceptanceCode;
  readonly field: string;
  readonly what: string;
}
const ACCEPTING: Side = { table: ACCEPTANCE_PROVIDERS, code: "achievement_unconfirmed", field: "outcome.accepting", what: "accepted result" };
const CANCELLING: Side = { table: CANCELLATION_PROVIDERS, code: "cancellation_unconfirmed", field: "outcome.cancelling", what: "cancellation" };

/**
 * Confirms every result and every cancellation a cycle names, through the providers and nothing else.
 * One unconfirmed record refuses the whole outcome: a cycle is recorded with what it really achieved, or not at all.
 */
export function confirmResults(store: Store, request: ConfirmRequest): OmResult<Sealed<ConfirmedResults>> {
  requireCondition(store instanceof Store, "acceptance_request_invalid", "Results are confirmed through a store");
  requireCondition(isPlainObject(request), "acceptance_request_invalid", "Results are confirmed through a request object");
  requireCondition(isText(request.project) && isText(request.block) && isText(request.target),
    "acceptance_request_invalid", "A confirmation names the project, the block and the series it is for");
  requireCondition(request.goal === null || isPlainObject(request.goal),
    "acceptance_request_invalid", "A confirmation names the goal of the attempt, or says that no such attempt stands");
  requireCondition(!Object.hasOwn(request, "attempt") || validAttempt(request.attempt),
    "acceptance_request_invalid", "An explicit attempt context names an exact series and positive ordinal");
  // An absent set is not an empty one: a cycle that accepted nothing says so.
  requireCondition(Array.isArray(request.accepting) && request.accepting.every(isRef),
    "acceptance_request_invalid", "A cycle names the records that accepted its results by exact references, explicitly none");
  requireCondition(Array.isArray(request.cancelling) && request.cancelling.every(isRef),
    "acceptance_request_invalid", "A cycle names the transitions that cancelled earlier results by exact references, explicitly none");

  const achieved: Achievement[] = [], guards: Ref[] = [];
  for (let index = 0; index < request.accepting.length; index += 1) {
    const ref = request.accepting[index]!;
    const answer = confirmed(store, request, ref, ACCEPTING, index);
    if ('ok' in answer) return answer;
    for (const key of answer.keys) achieved.push({ key, basis: { id: ref.id, revision: ref.revision, hash: ref.hash } });
    guards.push(...answer.guards);
  }
  const cancelled: string[] = [];
  for (let index = 0; index < request.cancelling.length; index += 1) {
    const answer = confirmed(store, request, request.cancelling[index]!, CANCELLING, index);
    if ('ok' in answer) return answer;
    cancelled.push(...answer.keys);
    guards.push(...answer.guards);
  }
  return delivered({ achieved, cancelled, ...(guards.length ? { guards } : {}) });
}

function confirmed(store: Store, request: ConfirmRequest, ref: Ref, side: Side, index: number):
  { keys: readonly string[]; guards: readonly Ref[] } | OmResult<never> {
  const field = `${side.field}.${index}`;
  const found = store.get<Json>(ref.id, ref.revision);
  if (!found || found.hash !== ref.hash) {
    return problem(side.code, `No record stands at the exact reference an ${side.what} is named by`, request.target, field, ref);
  }
  // The kind is the store's, never the caller's: it is what the record IS, and it alone selects who may read it.
  const provider = Object.hasOwn(side.table, found.kind) ? side.table[found.kind] : undefined;
  if (provider === undefined) {
    return problem(side.code,
      `No provider of acceptance is connected for records of kind ${found.kind}, so this record confirms no ${side.what}`,
      request.target, `${field}.kind`, ref);
  }
  if (!ref.id.startsWith(provider.namespace(request.project))) {
    return problem(side.code, `A record at ${ref.id} lies outside the records of this project`, request.target, `${field}.id`, ref);
  }
  if (request.goal === null) {
    return problem(side.code, "No attempt of that ordinal stands, so nothing it accepted can be confirmed for it", request.target, "attempt", ref);
  }
  const answer = provider.confirm(sealed(found), { project: request.project, block: request.block, goal: request.goal,
    accepting: request.accepting, ...(request.attempt === undefined ? {} : { attempt: request.attempt }) }, store);
  const confirmed = keysOf(answer);
  if (confirmed === null) return problem(side.code, (answer as { readonly unconfirmed: string }).unconfirmed, request.target, field, ref);
  return confirmed;
}

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
function validAttempt(value: unknown): value is NonNullable<AcceptanceContext["attempt"]> {
  return object(value) && Object.keys(value).length === 2 && isRef(value['series'])
    && Number.isSafeInteger(value['ordinal']) && (value['ordinal'] as number) > 0;
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const goalOf = (goal: AttemptGoal) => ({ ...goal, questions: [...goal.questions].sort() });

/** C5 proves acceptance and its one bound attempt; the shared identity reader alone defines the result keys. */
export function confirmAcceptedFrameResult(record: Sealed<Revision<Json>>, context: AcceptanceContext, store: Store): Confirmation {
  requireCondition(store instanceof Store && isPlainObject(record) && isRef(record) && isPlainObject(context)
    && isText(context.project) && isText(context.block) && isPlainObject(context.goal)
    && Object.keys(context.goal).length === 3 && isText(context.goal.key) && isText(context.goal.result) && Array.isArray(context.goal.questions)
    && Array.from(context.goal.questions).every(isText), "acceptance_request_invalid", "Frame confirmation needs its exact record and full attempt goal");
  return withHistoricalReads(() => {
    if (!validAttempt(context.attempt)) return { unconfirmed: "A frame achievement needs its exact attempt context" };
    if (!object(record.value) || (record.value['level'] !== 2 && record.value['level'] !== 3))
      return { unconfirmed: "The record must be an accepted N2 or N3 frame" };
    const accepted = readAcceptedFrameLayer(store, { project: context.project, level: record.value['level'], frame: reference(record) });
    if (!accepted.ok) return { unconfirmed: `${accepted.refusal.code}: ${accepted.refusal.message}` };
    const production = accepted.value.frame.value.acceptance;
    if (production.contract !== FRAME_ACCEPTANCE_CONTRACT || !production.binding)
      return { unconfirmed: "This acceptance has no proved attempt binding" };
    const binding = production.binding, at = context.attempt;
    if (at.series.id !== binding.series.id || at.series.revision < binding.series.revision || at.ordinal !== binding.ordinal)
      return { unconfirmed: "The frame belongs to another series, attempt or later admission" };
    const original = readSeriesAt(store, context.project, binding.series);
    if (!original.ok) return { unconfirmed: `${original.refusal.code}: ${original.refusal.message}` };
    const checked = readSeriesAt(store, context.project, at.series);
    if (!checked.ok) return { unconfirmed: `${checked.refusal.code}: ${checked.refusal.message}` };
    const before = original.value.value, after = checked.value.value;
    const lineage = (series: Sealed<RepairSeries>) => ({ project: series.projectId, block: series.block, line: series.line,
      slice: series.slice, predecessor: series.predecessor, basis: series.basis, inherited: series.inherited,
      earlier: series.attempts.filter(item => item.ordinal < binding.ordinal) });
    const source = before.attempts.find(item => item.ordinal === binding.ordinal);
    const target = after.attempts.find(item => item.ordinal === binding.ordinal);
    if (before.block !== context.block || !same(lineage(before), lineage(after)) || !source || !target
      || !same(goalOf(source.goal), goalOf(target.goal)) || !same(goalOf(source.goal), goalOf(context.goal)))
      return { unconfirmed: "The context must preserve the bound line, prior history, attempt and full declared goal" };
    const acceptance = { project: context.project, level: accepted.value.frame.value.level,
      graph: reference(accepted.value.graph), layer: reference(accepted.value.layer), frame: reference(accepted.value.frame) };
    const keys: string[] = [];
    for (const obligation of binding.obligations) {
      const identity = readResultIdentity(store, { acceptance, obligation });
      if (!identity.ok) return { unconfirmed: `${identity.refusal.code}: ${identity.refusal.message}` };
      keys.push(identity.value.key);
    }
    return { keys };
  });
}

// A provider is code of this module, so an answer it cannot give is a defect of that code, not data to refuse.
function keysOf(answer: unknown): { keys: readonly string[]; guards: readonly Ref[] } | null {
  requireCondition(isPlainObject(answer), "acceptance_provider_invalid", "A provider answers with keys or with the reason it confirms none");
  const said = answer as Record<string, unknown>;
  const keys = said['keys'];
  if ((Object.keys(said).length === 1 || Object.keys(said).length === 2 && Object.hasOwn(said, 'guards')) && Array.isArray(keys)) {
    requireCondition(keys.length > 0 && keys.every(isText) && new Set(keys).size === keys.length,
      "acceptance_provider_invalid", "A provider that confirms a record derives at least one key from it, each once");
    const guards = said['guards'];
    requireCondition(guards === undefined || Array.isArray(guards) && guards.length > 0 && guards.every(isRef),
      "acceptance_provider_invalid", "A provider's optional guards must be exact nonempty references");
    return { keys: [...keys] as string[], guards: guards === undefined ? [] : [...guards as Ref[]] };
  }
  if (Object.keys(said).length === 1 && isText(said['unconfirmed'])) return null;
  throw new EngineError("acceptance_provider_invalid", "A provider answers with keys or with the reason it confirms none");
}

// A refusal of this contract goes back to whoever named the record: the record they named accepted nothing this unit
// can confirm, and the series is not told otherwise.
function problem(code: AcceptanceCode, message: string, target: string, field: string, ref: Ref): OmResult<never> {
  return refused(code, message, { unit: UNIT, target, field, ref }, "producer");
}

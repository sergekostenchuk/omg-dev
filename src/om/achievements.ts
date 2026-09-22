import type { Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import type { Achievement, AttemptGoal } from "./series.js";

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
 * the accepted frame (C5). None of them is written yet, so both tables are EMPTY and every result and every
 * cancellation is refused: until a provider is connected, an unconfirmed result is no result. Connecting one is one
 * line in its table below; nothing in G7 changes, and no caller can hand a table of its own to any function here.
 */
const UNIT = "om-acceptance";

/** What a provider is told about the cycle whose result it is asked to confirm. */
export interface AcceptanceContext {
  readonly project: string;
  readonly block: string;
  /** The goal the attempt was begun for: a record that accepted a result of another goal is no progress of this one. */
  readonly goal: AttemptGoal;
}

/** What a provider answers about one record: the keys it derived from it, or why the record confirms nothing. */
export type Confirmation =
  | { readonly keys: readonly string[] }
  | { readonly unconfirmed: string };

/**
 * One provider: where its records live, and the function that reads one of them.
 * The namespace is checked before the provider is asked anything, so a record of another project is never weighed as
 * this one's, however well it reads.
 */
export interface AcceptanceProvider {
  readonly namespace: (project: string) => string;
  readonly confirm: (record: Sealed<Revision<Json>>, context: AcceptanceContext) => Confirmation;
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
 * Kind of an ACCEPTING record → its provider. One line per provider, for example
 *   "om-gap-line-closure": { namespace: gapLineClosureNamespace, confirm: confirmGapLineClosure },
 * written by the unit that writes those records (D2 the closing of a gap line, D5 the checked answer, C5 the frame).
 */
export const ACCEPTANCE_PROVIDERS = providers({});

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
  readonly accepting: readonly Ref[];
  readonly cancelling: readonly Ref[];
}

/** What the series may be told: each result under the key its provider derived, with the record that accepted it. */
export interface ConfirmedResults {
  readonly achieved: readonly Achievement[];
  readonly cancelled: readonly string[];
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
  // An absent set is not an empty one: a cycle that accepted nothing says so.
  requireCondition(Array.isArray(request.accepting) && request.accepting.every(isRef),
    "acceptance_request_invalid", "A cycle names the records that accepted its results by exact references, explicitly none");
  requireCondition(Array.isArray(request.cancelling) && request.cancelling.every(isRef),
    "acceptance_request_invalid", "A cycle names the transitions that cancelled earlier results by exact references, explicitly none");

  const achieved: Achievement[] = [];
  for (let index = 0; index < request.accepting.length; index += 1) {
    const ref = request.accepting[index]!;
    const keys = confirmed(store, request, ref, ACCEPTING, index);
    if (!Array.isArray(keys)) return keys as OmResult<never>;
    for (const key of keys) achieved.push({ key, basis: { id: ref.id, revision: ref.revision, hash: ref.hash } });
  }
  const cancelled: string[] = [];
  for (let index = 0; index < request.cancelling.length; index += 1) {
    const keys = confirmed(store, request, request.cancelling[index]!, CANCELLING, index);
    if (!Array.isArray(keys)) return keys as OmResult<never>;
    cancelled.push(...keys);
  }
  return delivered({ achieved, cancelled });
}

function confirmed(store: Store, request: ConfirmRequest, ref: Ref, side: Side, index: number): readonly string[] | OmResult<never> {
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
  const answer = provider.confirm(sealed(found), { project: request.project, block: request.block, goal: request.goal });
  const keys = keysOf(answer);
  if (keys === null) return problem(side.code, (answer as { readonly unconfirmed: string }).unconfirmed, request.target, field, ref);
  return keys;
}

// A provider is code of this module, so an answer it cannot give is a defect of that code, not data to refuse.
function keysOf(answer: unknown): readonly string[] | null {
  requireCondition(isPlainObject(answer), "acceptance_provider_invalid", "A provider answers with keys or with the reason it confirms none");
  const said = answer as Record<string, unknown>;
  const keys = said['keys'];
  if (Object.keys(said).length === 1 && Array.isArray(keys)) {
    requireCondition(keys.length > 0 && keys.every(isText) && new Set(keys).size === keys.length,
      "acceptance_provider_invalid", "A provider that confirms a record derives at least one key from it, each once");
    return [...keys] as string[];
  }
  if (Object.keys(said).length === 1 && isText(said['unconfirmed'])) return null;
  throw new EngineError("acceptance_provider_invalid", "A provider answers with keys or with the reason it confirms none");
}

// A refusal of this contract goes back to whoever named the record: the record they named accepted nothing this unit
// can confirm, and the series is not told otherwise.
function problem(code: AcceptanceCode, message: string, target: string, field: string, ref: Ref): OmResult<never> {
  return refused(code, message, { unit: UNIT, target, field, ref }, "producer");
}

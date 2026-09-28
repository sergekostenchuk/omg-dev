import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import { readAnySeriesAt, readCompletionOwnerAt, readMechanismAdmission, readSeriesAt, type Achievement, type AnyRepairSeries,
  type AttemptGoal, type ClaimedRefusal, type ManagedClosure, type MechanismOwner, type MechanismRepairSeries, type RepairSeries } from "./series.js";
import { confirmGapLineResult, gapLinesNamespace } from "./gap-lines.js";
import { acceptedAnswerNamespace, confirmAcceptedAnswerResult } from "./accepted-answer.js";
import { FRAME_ACCEPTANCE_CONTRACT, readAcceptedFrameLayer } from "./layer-basis.js";
import { readResultIdentity } from "./result-identity.js";
import { readOmInput, withHistoricalReads, type OmInputRecord } from "./input.js";
import { readModelCallState, type OmModelCall } from "./model-call.js";
import { readCall, type MechanismCallRecord } from "./call-record.js";
import { INPUT_DECISION_KIND, type InputDecisionProposal } from "./addressing.js";

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
  /** The complete refusals being closed; E5 binds each negative verdict to its journal row. */
  readonly refusals?: readonly ClaimedRefusal[];
  readonly managedClosure?: ManagedClosure;
}

/**
 * What a provider is told about a cycle of a MECHANISM series (H1.0d). A mechanism has no block, and none is invented
 * for it; its exact attempt is always named, because the M5 provider binds a result to one series, ordinal and goal.
 */
export interface MechanismAcceptanceContext {
  readonly project: string;
  readonly owner: MechanismOwner;
  readonly goal: AttemptGoal;
  readonly attempt: { readonly series: Ref; readonly ordinal: number };
  readonly accepting?: readonly Ref[];
  readonly refusals?: readonly ClaimedRefusal[];
  readonly managedClosure?: ManagedClosure;
}

/** What a provider answers about one record: the keys it derived from it, or why the record confirms nothing. */
export type Confirmation =
  | { readonly keys: readonly string[]; readonly guards?: readonly TransactionGuard[] }
  | { readonly unconfirmed: string };

/**
 * One provider: where its records live, and the function that reads one of them.
 * The namespace is checked before the provider is asked anything, so a record of another project is never weighed as
 * this one's, however well it reads.
 */
export interface AcceptanceProvider {
  readonly namespace: (project: string) => string;
  /** Confirms for a block owner; absent when records of this kind accept nothing a block owns. */
  readonly confirm?: (record: Sealed<Revision<Json>>, context: AcceptanceContext, store: Store) => Confirmation;
  /** Confirms for a typed mechanism owner; a provider without it is never handed a mechanism context. */
  readonly confirmMechanism?: (record: Sealed<Revision<Json>>, context: MechanismAcceptanceContext, store: Store) => Confirmation;
}

// A table keyed by kinds that come out of the store. It has no prototype, so a record whose kind is "constructor" or
// "__proto__" finds nothing, and it is frozen with its entries, so a caller cannot add a provider of its own.
function providers(entries: Record<string, AcceptanceProvider>): Readonly<Record<string, AcceptanceProvider>> {
  const table = Object.create(null) as Record<string, AcceptanceProvider>;
  for (const [kind, provider] of Object.entries(entries)) {
    Object.defineProperty(table, kind, {
      value: Object.freeze({ namespace: provider.namespace, ...(provider.confirm ? { confirm: provider.confirm } : {}),
        ...(provider.confirmMechanism ? { confirmMechanism: provider.confirmMechanism } : {}) }), enumerable: true,
    });
  }
  return Object.freeze(table);
}

/**
 * Kind of an ACCEPTING record → the provider written by its producing unit.
 * Historical grounds and semantic result identity are interpreted by that provider, never by this table.
 * The applied E4 (model-call) confirms only M5 addressing, and only for its mechanism owner (H1.0d).
 */
export const ACCEPTANCE_PROVIDERS = providers({ "gap-line": { namespace: gapLinesNamespace, confirm: confirmGapLineResult },
  "accepted-answer": { namespace: acceptedAnswerNamespace, confirm: confirmAcceptedAnswerResult },
  "connection-frame": { namespace: project => `om-frame:${project}:`, confirm: confirmAcceptedFrameResult },
  "model-call": { namespace: project => `model-call:${project}:om:`, confirmMechanism: confirmModelCallAddressing } });

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
  readonly refusals?: readonly ClaimedRefusal[];
  readonly managedClosure?: ManagedClosure;
}
/** The same request for a typed mechanism owner: no block, and its exact attempt is always named. */
export interface MechanismConfirmRequest extends Omit<ConfirmRequest, "block" | "attempt"> {
  readonly owner: MechanismOwner;
  readonly attempt: NonNullable<AcceptanceContext["attempt"]>;
}

/** What the series may be told: each result under the key its provider derived, with the record that accepted it. */
export interface ConfirmedResults {
  readonly achieved: readonly Achievement[];
  readonly cancelled: readonly string[];
  readonly guards?: readonly TransactionGuard[];
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
export function confirmResults(store: Store, request: ConfirmRequest | MechanismConfirmRequest): OmResult<Sealed<ConfirmedResults>> {
  requireCondition(store instanceof Store, "acceptance_request_invalid", "Results are confirmed through a store");
  requireCondition(isPlainObject(request), "acceptance_request_invalid", "Results are confirmed through a request object");
  // The owner is typed: a block owner names its block, a mechanism names itself. A missing block never means a
  // mechanism, and naming both is a contradiction rather than a choice between two providers.
  const mechanism = Object.hasOwn(request, "owner");
  requireCondition(mechanism !== Object.hasOwn(request, "block") && isText(request.project) && isText(request.target)
    && (mechanism ? isMechanismOwner((request as MechanismConfirmRequest).owner) && validAttempt(request.attempt)
      : isText((request as ConfirmRequest).block)),
    "acceptance_request_invalid", "A confirmation names the project, either the block or the typed mechanism with its exact attempt, and the series it is for");
  requireCondition(request.goal === null || isPlainObject(request.goal),
    "acceptance_request_invalid", "A confirmation names the goal of the attempt, or says that no such attempt stands");
  requireCondition(!Object.hasOwn(request, "attempt") || validAttempt(request.attempt),
    "acceptance_request_invalid", "An explicit attempt context names an exact series and positive ordinal");
  // An absent set is not an empty one: a cycle that accepted nothing says so.
  requireCondition(Array.isArray(request.accepting) && request.accepting.every(isRef),
    "acceptance_request_invalid", "A cycle names the records that accepted its results by exact references, explicitly none");
  requireCondition(Array.isArray(request.cancelling) && request.cancelling.every(isRef),
    "acceptance_request_invalid", "A cycle names the transitions that cancelled earlier results by exact references, explicitly none");
  const achieved: Achievement[] = [], guards: TransactionGuard[] = [];
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
  // Every exact acceptance was confirmed above. An achievement is a semantic key, so two
  // independently confirmed records with that key have one deterministic representative.
  // Keep every provider guard even when its record is not the representative.
  const byKey = new Map<string, Achievement>();
  for (const item of achieved) {
    const previous = byKey.get(item.key);
    if (!previous || canonical(item.basis) < canonical(previous.basis)) byKey.set(item.key, item);
  }
  return delivered({ achieved: [...byKey.values()],
    cancelled, ...(guards.length ? { guards } : {}) });
}

function confirmed(store: Store, request: ConfirmRequest | MechanismConfirmRequest, ref: Ref, side: Side, index: number):
  { keys: readonly string[]; guards: readonly TransactionGuard[] } | OmResult<never> {
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
  // Only a provider that confirms for this owner is asked: an older block provider is never handed a mechanism
  // context, and the M5 provider never answers for a block.
  const optional = { ...(request.refusals === undefined ? {} : { refusals: request.refusals }),
    ...(request.managedClosure === undefined ? {} : { managedClosure: request.managedClosure }) };
  const answer = "owner" in request
    ? provider.confirmMechanism?.(sealed(found), { project: request.project, owner: request.owner, goal: request.goal,
      attempt: request.attempt, accepting: request.accepting, ...optional }, store)
    : provider.confirm?.(sealed(found), { project: request.project, block: request.block, goal: request.goal,
      accepting: request.accepting, ...(request.attempt === undefined ? {} : { attempt: request.attempt }), ...optional }, store);
  if (answer === undefined) {
    return problem(side.code, `Records of kind ${found.kind} confirm no ${side.what} of a ${"owner" in request ? "mechanism" : "block"} owner`,
      request.target, `${field}.kind`, ref);
  }
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
function isMechanismOwner(value: unknown): value is MechanismOwner {
  return object(value) && Object.keys(value).length === 2 && value['kind'] === "mechanism" && value['mechanism'] === "M5:addressing";
}
function isGoal(value: unknown): value is AttemptGoal {
  return object(value) && Object.keys(value).length === 3 && isText(value['key']) && isText(value['result'])
    && Array.isArray(value['questions']) && value['questions'].every(isText);
}

class Unconfirmed extends Error {}
function need<T>(result: OmResult<T>): T {
  if (!result.ok) throw new Unconfirmed(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function hold(condition: unknown, message: string): asserts condition { if (!condition) throw new Unconfirmed(message); }

/**
 * M5 addressing (H1.0d, №1449 §1–§2, №1688). The ground of the result is the exact APPLIED E4 whose own D3 transition
 * addressed the assigned questions — never a proposal, a bare response or a vanished gap. Every decision of that E4 must
 * belong to its assigned address subset, name its accepted question through addressedBy and choose a consumer the
 * admission allows; one that does not refuses the whole record instead of being dropped. The key is the semantic
 * addressing of the admitted task: revisions, call names, ordinals and packaging stay grounds, not identity.
 */
export function confirmModelCallAddressing(record: Sealed<Revision<Json>>, context: MechanismAcceptanceContext, store: Store): Confirmation {
  requireCondition(store instanceof Store && isPlainObject(record) && isRef(record) && isPlainObject(context)
    && isText(context.project) && isMechanismOwner(context.owner) && isGoal(context.goal) && validAttempt(context.attempt),
  "acceptance_request_invalid", "M5 confirmation needs its exact record, the typed mechanism owner, the full goal and the exact attempt");
  return withHistoricalReads(() => {
    try {
      const project = context.project;
      const state = need(readModelCallState(store, { project, record: reference(record) }));
      hold(state.state === "applied", "Only an applied E4 accepts an addressing result");
      const applied = state.outcome, form = applied.outcome;
      hold(form?.kind === "input-decisions" && applied.diagnostic === null,
        "An addressing result is an applied field decision without a diagnostic");
      const e4 = applied.record.value as OmModelCall;
      const call = need(readCall(store, project, e4.om.call)).value;
      hold("owner" in call && same(call.owner, context.owner) && call.purpose === "model-design",
        "The call was admitted for the M5 addressing mechanism");
      const e1 = call as MechanismCallRecord;
      // The exact own attempt: a later revision of the same series may close it, another line or ordinal may not.
      hold(e1.series.id === context.attempt.series.id && e1.attempt === context.attempt.ordinal
        && same(goalOf(e1.goal), goalOf(context.goal)), "The result belongs to another series, attempt or full goal");
      if (!same(e1.series, context.attempt.series)) {
        const lineage = (series: Sealed<Revision<AnyRepairSeries>>) => {
          hold("owner" in series.value, "An addressing attempt belongs to a mechanism series");
          const value = series.value as Sealed<MechanismRepairSeries>;
          return { project: value.projectId, owner: value.owner, line: value.line, slice: value.slice,
            predecessor: value.predecessor, basis: value.basis, inherited: value.inherited,
            earlier: value.attempts.filter(item => item.ordinal < e1.attempt),
            goal: value.attempts.find(item => item.ordinal === e1.attempt)?.goal ?? null,
            admission: value.admissions.find(row => row.attempt === e1.attempt) ?? null };
        };
        hold(same(lineage(need(readAnySeriesAt(store, project, e1.series))), lineage(need(readAnySeriesAt(store, project, context.attempt.series)))),
          "The named series revision must preserve the original line, prior history, attempt and admission");
      }
      // The admitted slice of THIS attempt: a refreshed E1 admission is tied to it by the common reader.
      const admitted = need(readMechanismAdmission(store, { project, series: e1.series, attempt: e1.attempt, admission: e1.admission, current: false }));
      const binding = e4.om.completionOwner;
      if (context.managedClosure !== undefined)
        hold(binding !== undefined && same(binding.binding, context.managedClosure.binding), "The result belongs to another completion binding");
      if (binding !== undefined) {
        const owner = need(readCompletionOwnerAt(store, project, binding.binding)).value;
        hold(owner.series.id === e1.series.id && owner.attempt === e1.attempt && same(goalOf(owner.goal), goalOf(e1.goal))
          && same(owner.owner, context.owner) && owner.admission !== null && same(owner.admission.routes, e1.admission.routes)
          && owner.admission.batch === e1.admission.batch && same(owner.plan.routes, e1.admission.routes)
          && owner.plan.batches.includes(e1.admission.batch), "The managed call belongs to the binding of this exact attempt and plan");
      }
      // The accepted B1 is exactly this E4's own D3 transition.
      hold(e4.om.input !== null, "Input decisions need their applied D3 result");
      const accepted = need(readOmInput(store, project, e4.om.input)).value as Sealed<OmInputRecord>;
      const ordered = (refs: readonly Ref[]) => [...refs].map(ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash }))
        .sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
      const derivation: unknown = accepted.derivation;
      hold(object(derivation) && !Object.hasOwn(derivation, "kind") && Object.keys(derivation).length === 3
        && same(derivation['previous'], form.input) && same(derivation['graph'], form.graph)
        && Array.isArray(derivation['decisions']) && same(ordered(derivation['decisions'] as Ref[]), ordered(form.decisions)),
      "The accepted input must derive from the previous input, graph and complete decisions of this E4");
      const assigned = new Set(e1.gaps.map(gap => gap.goal));
      const questions = accepted.input.questions as readonly { id: string; consumer?: unknown; kind?: unknown; addressedBy?: Ref }[];
      const keys: string[] = [];
      for (const ref of form.decisions) {
        const found = store.get<InputDecisionProposal>(ref.id, ref.revision);
        hold(found && found.kind === INPUT_DECISION_KIND && same(reference(found), ref), "Every decision stands at its exact reference");
        const decision = found.value.decision;
        hold(decision.field === "address" && assigned.has(decision.target), "Every decision belongs to the assigned address subset");
        const question = questions.find(item => item.id === decision.target);
        hold(question && isText(question.consumer) && isText(question.kind) && same(question.addressedBy, ref)
          && same(decision.value, { consumer: question.consumer, kind: question.kind }),
        "The accepted question is addressed by this exact decision");
        hold(admitted.value.consumers.some(item => item.id === question.consumer), "The accepted consumer is outside the admitted catalog");
        const row = admitted.value.questions.find(item => item.target === decision.target && item.field === "address");
        hold(row, "The decision addresses a question outside the admitted task");
        const key = `om-result:${hashJson({ kind: "addressing", project, target: row.target, field: "address", task: row.task,
          producer: row.producer, protected: row.protected, accepted: { consumer: question.consumer, kind: question.kind } } as Json)}`;
        if (!keys.includes(key)) keys.push(key);
      }
      hold(keys.length > 0, "An applied E4 that addressed nothing accepts no result");
      return { keys };
    } catch (error) {
      if (error instanceof Unconfirmed) return { unconfirmed: error.message };
      throw error;
    }
  });
}

/**
 * №1688-13: a saved representative of a key is proved by ITS OWN provider, whatever kind it is — not filtered by the
 * namespace of the local result that shares the key. The local result is proved separately by its caller.
 */
export function acceptanceRepresents(store: Store, context: AcceptanceContext | MechanismAcceptanceContext, basis: Ref, key: string): boolean {
  requireCondition(store instanceof Store && isPlainObject(context) && isText(context.project) && isRef(basis) && isText(key),
    "acceptance_request_invalid", "A representative is checked against its exact basis, key and attempt context");
  const record = store.get<Json>(basis.id, basis.revision);
  if (!record || !same(reference(record), basis)) return false;
  const provider = Object.hasOwn(ACCEPTANCE_PROVIDERS, record.kind) ? ACCEPTANCE_PROVIDERS[record.kind] : undefined;
  if (!provider || !basis.id.startsWith(provider.namespace(context.project))) return false;
  const answer = "owner" in context ? provider.confirmMechanism?.(sealed(record), context, store)
    : provider.confirm?.(sealed(record), context, store);
  const keys = answer === undefined ? null : keysOf(answer);
  return keys !== null && keys.keys.includes(key);
}

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
function keysOf(answer: unknown): { keys: readonly string[]; guards: readonly TransactionGuard[] } | null {
  requireCondition(isPlainObject(answer), "acceptance_provider_invalid", "A provider answers with keys or with the reason it confirms none");
  const said = answer as Record<string, unknown>;
  const keys = said['keys'];
  if ((Object.keys(said).length === 1 || Object.keys(said).length === 2 && Object.hasOwn(said, 'guards')) && Array.isArray(keys)) {
    requireCondition(keys.length > 0 && keys.every(isText) && new Set(keys).size === keys.length,
      "acceptance_provider_invalid", "A provider that confirms a record derives at least one key from it, each once");
    const guards = said['guards'];
    requireCondition(guards === undefined || Array.isArray(guards) && guards.length > 0
      && guards.every(guard => isRef(guard) || isPlainObject(guard) && Object.keys(guard).length === 2
        && isText(guard.id) && guard.absent === true),
      "acceptance_provider_invalid", "A provider's optional guards must be exact references or guarded absences");
    return { keys: [...keys] as string[], guards: guards === undefined ? [] : [...guards as TransactionGuard[]] };
  }
  if (Object.keys(said).length === 1 && isText(said['unconfirmed'])) return null;
  throw new EngineError("acceptance_provider_invalid", "A provider answers with keys or with the reason it confirms none");
}

// A refusal of this contract goes back to whoever named the record: the record they named accepted nothing this unit
// can confirm, and the series is not told otherwise.
function problem(code: AcceptanceCode, message: string, target: string, field: string, ref: Ref): OmResult<never> {
  return refused(code, message, { unit: UNIT, target, field, ref }, "producer");
}

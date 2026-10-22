import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { uniqueTransactionGuards, type Environment } from '../runtime/environment.js';
import { readCapacity } from './capacity.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, isPlainObject, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readAnySeriesAt, type AttemptGoal } from './series.js';
import { recordCall, type AnyRecordCallRequest, type DispatchContract } from './call-record.js';
import { adapterRequest, transportUnder, type ModelTransportOutcome } from './model-call.js';
import { RunControlGate, RunControlLost, type RunControlHold } from './run-control.js';

/**
 * G5.1/G6.1 (№3833, №3847, №3857 п.4, №3891): the one remaining narrow choice of the wake mechanism — the write order of
 * a file several works of a group write, where every dependency of the group allows more than one order. One small call
 * asks that choice of the model and nothing else; the accepting attempt pays. Its key is the exact proposals of the
 * group's candidate and the file, never the paying attempt, so a re-entry, a restart or a later accepting attempt finds
 * it without paying again. LG10-01 retired the wake-test task; its requests are refused at the boundary, before any
 * intent, E1 or transport. E5 shows the shape: intent, E1, one physical transport, result.
 */
export const WAKE_INTENT_KIND = 'om-wake-intent';
export const WAKE_CHOICE_KIND = 'om-wake-choice';
export const WAKE_CHOICE_PROTOCOL = 'omg-wake-choice/v1';
const INTENT_CONTRACT = 'om-wake-intent/v1', CHOICE_CONTRACT = 'om-wake-choice/v1';
/** Row 5 of the outcome table (№3851): a failed choice is asked once more, showing why; then the wait stands. */
export const WAKE_CHOICE_ATTEMPTS = 2;
export const WAKE_CHOICE_CODES = Object.freeze(['wake_request_invalid', 'wake_source_invalid', 'wake_choice_unneeded',
  'wake_attempt_invalid', 'wake_intent_invalid', 'wake_result_invalid', 'wake_limit_reached', 'assessor_not_independent',
  'context_too_large'] as const);
type WakeCode = typeof WAKE_CHOICE_CODES[number];

/**
 * G6.1 (№3857 п.4, №3891): the second narrow choice of the same mechanism — the write order of a file several works of a
 * group write, where every dependency of the group allows more than one order. Its key is the exact proposals of the
 * group's candidate and the file, never the paying attempt, so another accepting attempt keeps the same two intents.
 */
export interface WriteOrderRequest {
  task: 'write-order'; project: string; proposals: readonly Ref[]; path: string;
  /** The group's results whose works step the order completes — what re-derives its lawful orders. */
  results: readonly { kind: string; record: Ref }[];
  accepting: { series: Ref; attempt: number };
  dispatch: DispatchContract;
}
export type ChoiceRequest = WriteOrderRequest;
/** What a works candidate takes from a chosen write order: the writers of one file in their chosen order, with its proof. */
export interface WriteOrderInput { path: string; order: string[]; choice: Ref }
export interface OrderChoiceRecord {
  contract: typeof CHOICE_CONTRACT; project: string; intent: Ref; transport: Ref;
  task: 'write-order'; path: string; proposals: Ref[]; verdict: WakeVerdict; choice: string | null; reasons: string[];
}
export interface WakeIntentRecord {
  contract: typeof INTENT_CONTRACT; project: string; request: ChoiceRequest; ordinal: number;
  allowed: string[]; previous: Ref | null; block: string; goal: AttemptGoal; packet: Json;
}
export type WakeVerdict = 'chosen' | 'refused' | 'off-form' | 'interrupted';
export type AnyChoiceRecord = OrderChoiceRecord;
/** G6.1: the rule a write-order choice states — the same order the native validator then reads from the transfers. */
export const WRITE_ORDER_RULE = 'Several works of this group write the same file, and their dependencies allow more than one order. Choose the '
  + 'order in which they write it: each later writer takes the file over once the previous one has committed. Name exactly '
  + 'one of the allowed orders; the engine never picks one for you.';

class WakeFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: WakeCode, target: string, field: string, message: string, ref?: Ref): never {
  const refusal = refused(code, message, { unit: 'G5.1', target, field, ...(ref ? { ref } : {}) }, 'producer');
  throw new WakeFailure((refusal as unknown as { refusal: Refusal }).refusal);
}
function take<T>(value: OmResult<T, string>): T { if (!value.ok) throw new WakeFailure(value.refusal as Refusal); return value.value; }
function result<T>(action: () => T): OmResult<Sealed<T>, string> {
  try { return delivered(action()); }
  catch (error) {
    if (error instanceof WakeFailure || error instanceof RunControlLost) return { ok: false, refusal: error.refusal as Refusal };
    throw error;
  }
}
const object = (value: unknown): value is Record<string, any> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const json = (value: unknown): Json => JSON.parse(canonical(value as Json)) as Json;
const same = (a: unknown, b: unknown): boolean => canonical(a as Json) === canonical(b as Json);
function requireRequest(store: Store, request: unknown): asserts request is ChoiceRequest {
  // Only the write-order task of G6.1 runs; a request of the retired wake-test task is refused at the boundary,
  // before any intent, E1 or transport.
  if (!(store instanceof Store) || !object(request) || request.task !== 'write-order'
    || !same(Object.keys(request).sort(), ['accepting', 'dispatch', 'path', 'project', 'proposals', 'results', 'task'])
    || !text(request.project) || !text(request.path) || !Array.isArray(request.proposals) || !request.proposals.length || !request.proposals.every(isRef)
    || !Array.isArray(request.results) || !request.results.every(row => object(row) && text(row.kind) && isRef(row.record))
    || !object(request.accepting) || !same(Object.keys(request.accepting).sort(), ['attempt', 'series']) || !isRef(request.accepting.series)
    || !Number.isSafeInteger(request.accepting.attempt) || request.accepting.attempt < 1
    || !object(request.dispatch) || !isRef(request.dispatch.adapter) || !isRef(request.dispatch.config))
    throw new EngineError('wake_request_invalid', 'A write-order choice names its proposals, file, results, paying attempt and dispatch');
}
/** One key per shared file: the exact proposals and the file. */
function keyOf(request: WriteOrderRequest): string {
  return orderKey(request.project, request.proposals, request.path);
}
const sortedRefs = (refs: readonly Ref[]): Ref[] => [...refs].sort((a, b) => canonical(a as unknown as Json) < canonical(b as unknown as Json) ? -1 : 1);
const orderKey = (project: string, proposals: readonly Ref[], path: string): string =>
  hashJson({ project, task: 'write-order', proposals: sortedRefs(proposals), path } as unknown as Json);
export const wakeIntentId = (project: string, key: string, ordinal: number): string => `${WAKE_INTENT_KIND}:${project}:${key}:${ordinal}`;
export const wakeChoiceId = (project: string, key: string, ordinal: number): string => `${WAKE_CHOICE_KIND}:${project}:${key}:${ordinal}`;

function deriveIntent(store: Store, request: WriteOrderRequest, ordinal: number, previous: Revision<AnyChoiceRecord> | null,
  options: string[]): WakeIntentRecord {
  const allowed = options;
  const series = take(readAnySeriesAt(store, request.project, request.accepting.series));
  if ('owner' in series.value) fail('wake_attempt_invalid', request.accepting.series.id, 'series', 'A wake choice is paid by a block attempt');
  const attempt = [...series.value.inherited, ...series.value.attempts].find(item => item.ordinal === request.accepting.attempt);
  if (!attempt || attempt.outcome !== null) fail('wake_attempt_invalid', request.accepting.series.id, 'attempt', 'The paying accepting attempt must be running');
  const environment = take(readRecord<Environment>(store, request.dispatch.config,
    { unit: 'G5.1', target: request.path, id: `environment:${request.project}`, kind: 'environment' })).value;
  if (!object(environment) || environment.projectId !== request.project || !object(environment.implementer) || !text(environment.implementer.actor))
    fail('wake_request_invalid', request.dispatch.config.id, 'implementer', 'The environment must name its implementer');
  take(readRecord(store, request.dispatch.adapter, { unit: 'G5.1', target: request.path, id: request.dispatch.adapter.id, kind: 'dispatch-adapter' }));
  const key = keyOf(request), call = `wake:${key}:${ordinal}`;
  const shown = previous ? { verdict: previous.value.verdict, choice: previous.value.choice, reasons: previous.value.reasons } : null;
  const orders = allowed.map(row => JSON.parse(row) as string[]);
  const packet = json({ protocol: WAKE_CHOICE_PROTOCOL, task: 'write-order', path: request.path, allowed: orders, rule: WRITE_ORDER_RULE, previous: shown,
    responseForm: { protocol: WAKE_CHOICE_PROTOCOL, schema: { type: 'object', additionalProperties: false, required: ['writeOrder'],
      properties: { writeOrder: { enum: orders } } }, text: 'Return exactly one JSON object {"writeOrder": <one of "allowed">} and nothing else.' } });
  const wire = take(adapterRequest({ requestId: call, packet, model: environment.implementer.model, effort: environment.implementer.effort,
    ...(environment.implementer.speed === undefined ? {} : { speed: environment.implementer.speed }) }));
  const capacity = take(readCapacity(store, { project: request.project, environment: request.dispatch.config, current: false }));
  if (canonical(wire as unknown as Json).length > capacity.maxRequestChars)
    fail('context_too_large', request.path, 'packet', 'The complete wake-choice request exceeds the saved technical capacity');
  const goal: AttemptGoal = { key: `wake:${key}`, questions: [request.path],
    result: 'One write order of the works that write this shared file' };
  void call;
  return copy({ contract: INTENT_CONTRACT, project: request.project, request, ordinal, allowed,
    previous: previous ? reference(previous) : null, block: series.value.block, goal, packet });
}
const copy = <T>(value: T): T => JSON.parse(canonical(value as unknown as Json)) as T;
/** The E1 of an intent follows from the saved intent alone: its name, its basis (the intent) and its paying attempt. */
export function wakeCallOf(intent: Revision<WakeIntentRecord> | Sealed<Revision<WakeIntentRecord>>): AnyRecordCallRequest {
  const value = intent.value, request = value.request;
  return copy({ call: `wake:${keyOf(request)}:${value.ordinal}`, purpose: 'wake-choice', basis: { kind: 'wake-choice', intent: reference(intent) },
    block: value.block, gaps: [{ id: request.path, goal: value.goal.key, field: 'writeOrder', consumer: value.block }],
    series: request.accepting.series, attempt: request.accepting.attempt, goal: value.goal, dispatch: request.dispatch,
    packet: value.packet as Json }) as unknown as AnyRecordCallRequest;
}

/** NR (№3600): a trusted read — runWakeChoice derived the intent from its exact proposal and paying attempt once. */
export function readWakeIntentAt(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<WakeIntentRecord>>, string> {
  return result(() => {
    const record = take(readRecord<WakeIntentRecord>(store, ref, { unit: 'G5.1', target: ref.id, kind: WAKE_INTENT_KIND,
      idPrefix: `${WAKE_INTENT_KIND}:${project}:` })) as Revision<WakeIntentRecord>;
    const value = record.value;
    if (!object(value) || value.contract !== INTENT_CONTRACT || value.project !== project || !object(value.request)
      || (value.request as WriteOrderRequest).task !== 'write-order'
      || record.id !== wakeIntentId(project, keyOf(value.request), value.ordinal) || record.revision !== 1)
      fail('wake_intent_invalid', record.id, 'intent', 'A wake intent stands at the address of its own producer end and ordinal');
    return record;
  });
}
/** The one reader of a saved choice: its intent's own subject and allowed options. */
function readChoiceAt(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<AnyChoiceRecord>>, string> {
  return result(() => {
    const record = take(readRecord<AnyChoiceRecord>(store, ref, { unit: 'G5.1', target: ref.id, kind: WAKE_CHOICE_KIND,
      idPrefix: `${WAKE_CHOICE_KIND}:${project}:` })) as Revision<AnyChoiceRecord>;
    const value = record.value;
    if (!object(value) || value.contract !== CHOICE_CONTRACT || value.project !== project || !isRef(value.intent)
      || (value.verdict === 'chosen') !== text(value.choice))
      fail('wake_result_invalid', record.id, 'result', 'A wake result keeps its intent, and a choice exactly when chosen');
    const intent = take(readWakeIntentAt(store, project, value.intent)), request = intent.value.request;
    const own = value.task === 'write-order' && value.path === request.path && same(value.proposals, sortedRefs(request.proposals));
    if (!own || value.verdict === 'chosen' && !intent.value.allowed.includes(value.choice!))
      fail('wake_result_invalid', record.id, 'intent', 'A choice belongs to its exact intent and its allowed options');
    return record;
  });
}
/** Every saved result of one producer end, in ordinal order — read by its deterministic addresses, never by a list. */
function resultsOf(store: Store, project: string, key: string): Revision<AnyChoiceRecord>[] {
  const rows: Revision<AnyChoiceRecord>[] = [];
  for (let ordinal = 1; ordinal <= WAKE_CHOICE_ATTEMPTS; ordinal++) {
    const head = store.get<AnyChoiceRecord>(wakeChoiceId(project, key, ordinal));
    if (!head) break;
    rows.push(take(readChoiceAt(store, project, reference(head))) as Revision<AnyChoiceRecord>);
  }
  return rows;
}
/**
 * G6.1: the chosen write orders of exactly these proposals, for the files their works share — each read at the
 * deterministic addresses of its key, never by a list; a file without a choice is absent.
 */
export function chosenWriteOrders(store: Store, project: string, proposals: readonly Ref[], paths: readonly string[]): OmResult<Sealed<WriteOrderInput[]>, string> {
  return result(() => paths.flatMap(path => {
    const chosen = resultsOf(store, project, orderKey(project, proposals, path)).find(row => row.value.verdict === 'chosen');
    return chosen ? [{ path, order: JSON.parse(chosen.value.choice!) as string[], choice: reference(chosen) }] : [];
  }));
}
function verdictOf(intent: WakeIntentRecord, physical: Sealed<ModelTransportOutcome>): Pick<OrderChoiceRecord, 'verdict' | 'choice' | 'reasons'> {
  if (physical.result.kind !== 'answered') return { verdict: physical.result.kind === 'interrupted' ? 'interrupted' : 'off-form',
    choice: null, reasons: [physical.result.error.message] };
  let parsed: unknown;
  try { parsed = JSON.parse(physical.result.raw); } catch { return { verdict: 'off-form', choice: null, reasons: ['The answer is not one JSON object'] }; }
  const request = intent.request;
  if (!object(parsed) || !same(Object.keys(parsed), ['writeOrder']) || !Array.isArray(parsed.writeOrder) || !parsed.writeOrder.every(text))
    return { verdict: 'off-form', choice: null, reasons: ['The answer must be exactly {"writeOrder": [<work id>, ...]}'] };
  const choice = canonical(parsed.writeOrder as Json);
  if (!intent.allowed.includes(choice)) return { verdict: 'refused', choice: null, reasons: [`${choice} is not one of the allowed write orders of ${request.path}`] };
  return { verdict: 'chosen', choice, reasons: [] };
}
/** G5.1: where one producer end stands — its choice made, or the ordinal of the next intent while one more is lawful. */
export function wakeStanding(store: Store, request: ChoiceRequest): OmResult<Sealed<{ chosen: boolean; next: number | null }>, string> {
  requireRequest(store, request);
  return result(() => {
    const saved = resultsOf(store, request.project, keyOf(request));
    const chosen = saved.some(row => row.value.verdict === 'chosen');
    return { chosen, next: chosen || saved.length >= WAKE_CHOICE_ATTEMPTS ? null : saved.length + 1 };
  });
}
/**
 * G6.1: the lawful write orders of the file, as the group's own works preparation refuses for want of the choice: its
 * exact proposals and the options it names. Anything else — no refusal, another file, other proposals — asks nothing.
 */
async function orderOptions(store: Store, request: WriteOrderRequest): Promise<string[]> {
  const { prepareWorksSources } = await import('./atomic-gate.js');
  const refused = prepareWorksSources(store, { project: request.project, results: request.results as never });
  const refusal = refused.ok ? null : refused.refusal as Refusal & { findings?: { code: string; target: string; message: string }[] };
  if (!refusal || refusal.code !== 'write_order_choice_missing' || refusal.at.target !== request.path)
    fail('wake_choice_unneeded', request.path, 'writeOrder', 'This file has no open write order of these results to choose');
  const findings = refusal.findings ?? [];
  if (findings.find(row => row.code === 'write_order_sources')?.message !== canonical(sortedRefs(request.proposals) as unknown as Json))
    fail('wake_source_invalid', request.path, 'proposals', 'The choice names the exact proposals of the group\'s candidate');
  const options = findings.filter(row => row.code === 'write_order_option').map(row => row.message);
  if (options.length < 2) fail('wake_choice_unneeded', request.path, 'writeOrder', 'A write order is asked only of a file with several lawful orders');
  return options;
}
/**
 * The write-order choice of one shared file, by the exact intent its step names: the saved result of that ordinal is the
 * step's outcome whatever its verdict, so a restart after it sends nothing; otherwise that intent (the later one showing
 * why the earlier failed), its E1, one transport and its result. The next ordinal is always a step of its own
 * (return №3867-1).
 */
export async function runWakeChoice(store: Store, request: ChoiceRequest, ordinal: number, signal?: AbortSignal, control?: RunControlHold):
  Promise<OmResult<Sealed<Revision<AnyChoiceRecord>>, string>> {
  requireRequest(store, request);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > WAKE_CHOICE_ATTEMPTS)
    throw new EngineError('wake_request_invalid', `A wake step names the ordinal of its intent, 1 to ${WAKE_CHOICE_ATTEMPTS}`);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new EngineError('wake_request_invalid', 'A signal must be an AbortSignal');
  if (control !== undefined && !object(control)) throw new EngineError('wake_request_invalid', 'A control hold must be an object');
  const gate = new RunControlGate(store, request.project, control);
  try {
    const key = keyOf(request), saved = resultsOf(store, request.project, key);
    const own = saved[ordinal - 1];
    if (own) return delivered(sealed(own));
    if (saved.length !== ordinal - 1)
      fail('wake_intent_invalid', request.path, 'ordinal', 'A later wake intent follows the saved result of every earlier one');
    if (saved.some(row => row.value.verdict === 'chosen'))
      fail('wake_intent_invalid', request.path, 'ordinal', 'A producer end whose choice is made asks no further intent');
    const id = wakeIntentId(request.project, key, ordinal);
    const existing = store.get<WakeIntentRecord>(id);
    // G6.1: the lawful write orders are re-derived by the group's own works preparation — the one derivation of C4.
    const options = !existing ? await orderOptions(store, request) : null;
    const intent = existing ? take(readWakeIntentAt(store, request.project, reference(existing))) as Revision<WakeIntentRecord>
      : (() => {
        const value = deriveIntent(store, request, ordinal, saved.at(-1) ?? null, options!);
        const write: Write = { id, kind: WAKE_INTENT_KIND, expected: 0, value: value as unknown as Json };
        const guards: TransactionGuard[] = [request.accepting.series, ...request.proposals,
          request.dispatch.config, request.dispatch.adapter, ...(saved.length ? [reference(saved.at(-1)!)] : [])];
        return take(writeGuarded(gate.view(), { unit: 'G5.1', target: id, writes: [write], guards: uniqueTransactionGuards(guards) }))[0] as unknown as Revision<WakeIntentRecord>;
      })();
    const admitted = take(recordCall(gate.view(), request.project, wakeCallOf(intent), [reference(intent)]));
    const first = store.get(admitted.call.id, 1)!;
    const physical = take(await transportUnder(store, { project: request.project, call: reference(first), packet: intent.value.packet,
      role: 'implementer' }, signal, [reference(intent)], gate));
    const value: AnyChoiceRecord = { contract: CHOICE_CONTRACT, project: request.project, intent: reference(intent), transport: reference(physical.record),
      task: 'write-order', path: request.path, proposals: sortedRefs(request.proposals), ...verdictOf(intent.value, physical) };
    const resultId = wakeChoiceId(request.project, key, ordinal), write: Write = { id: resultId, kind: WAKE_CHOICE_KIND, expected: 0, value: value as unknown as Json };
    const stored = writeGuarded(store, { unit: 'G5.1', target: resultId, writes: [write], guards: [reference(intent), reference(physical.record)] });
    if (!stored.ok) {
      const raced = store.get<AnyChoiceRecord>(resultId);
      if (raced && same(raced.value, value)) return readChoiceAt(store, request.project, reference(raced));
      return { ok: false, refusal: stored.refusal as Refusal };
    }
    return readChoiceAt(store, request.project, reference(stored.value[0]!));
  } catch (error) {
    if (error instanceof WakeFailure || error instanceof RunControlLost) return { ok: false, refusal: error.refusal as Refusal };
    throw error;
  }
}

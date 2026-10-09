import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Graph } from '../graph/model.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { uniqueTransactionGuards, type Environment } from '../runtime/environment.js';
import { readCapacity } from './capacity.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, isPlainObject, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readAnySeriesAt, type AttemptGoal } from './series.js';
import { recordCall, type AnyRecordCallRequest, type DispatchContract } from './call-record.js';
import { adapterRequest, transportUnder, type ModelTransportOutcome } from './model-call.js';
import { WAKE_TEST } from './frame-proposals.js';
import { RunControlGate, RunControlLost, type RunControlHold } from './run-control.js';

/**
 * G5.1 (№3833, №3847): the wake-test supplement of an exact producer assembly. A group acceptance refused a sleeping
 * connection whose producer work, answered before the wake-test era, has several covering tests and named none: one small
 * call asks that choice of the model and nothing else — the work, its tests and their covers stay as they are, no closed
 * root is written again. The accepting attempt pays; the choice is kept by the work's layer-proposal and the connection,
 * so a re-entry, a restart or a later accepting attempt finds it without paying again. E5 shows the shape: intent, E1,
 * one physical transport, result.
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

export interface WakeChoiceRequest {
  project: string;
  /** The exact layer-proposal of the producer assembly (the same one under every reuse of it). */
  proposal: Ref;
  work: string; connector: string;
  /** The accepting attempt that pays: its check passed and its works step was refused. */
  accepting: { series: Ref; attempt: number };
  dispatch: DispatchContract;
}
export interface WakeIntentRecord {
  contract: typeof INTENT_CONTRACT; project: string; request: WakeChoiceRequest; ordinal: number;
  allowed: string[]; previous: Ref | null; block: string; goal: AttemptGoal; packet: Json;
}
export type WakeVerdict = 'chosen' | 'refused' | 'off-form' | 'interrupted';
export interface WakeChoiceRecord {
  contract: typeof CHOICE_CONTRACT; project: string; intent: Ref; transport: Ref;
  proposal: Ref; work: string; connector: string; verdict: WakeVerdict; choice: string | null; reasons: string[];
}
/** What a works candidate takes from a chosen supplement: the named test of one producer end, with its proof. */
export interface WakeChoiceInput { proposal: Ref; work: string; connector: string; test: string; choice: Ref }

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
function requireRequest(store: Store, request: unknown): asserts request is WakeChoiceRequest {
  if (!(store instanceof Store) || !object(request) || !same(Object.keys(request).sort(), ['accepting', 'connector', 'dispatch', 'project', 'proposal', 'work'])
    || !text(request.project) || !isRef(request.proposal) || !text(request.work) || !text(request.connector)
    || !object(request.accepting) || !same(Object.keys(request.accepting).sort(), ['attempt', 'series']) || !isRef(request.accepting.series)
    || !Number.isSafeInteger(request.accepting.attempt) || request.accepting.attempt < 1
    || !object(request.dispatch) || !isRef(request.dispatch.adapter) || !isRef(request.dispatch.config))
    throw new EngineError('wake_request_invalid', 'A wake choice names its proposal, work, connection, paying attempt and dispatch');
}
/** One key per producer end: the exact proposal, its work and the connection. */
function keyOf(request: Pick<WakeChoiceRequest, 'project' | 'proposal' | 'work' | 'connector'>): string {
  return hashJson({ project: request.project, proposal: request.proposal, work: request.work, connector: request.connector } as unknown as Json);
}
export const wakeIntentId = (project: string, key: string, ordinal: number): string => `${WAKE_INTENT_KIND}:${project}:${key}:${ordinal}`;
export const wakeChoiceId = (project: string, key: string, ordinal: number): string => `${WAKE_CHOICE_KIND}:${project}:${key}:${ordinal}`;
const responseSchema = (allowed: readonly string[]) => ({ type: 'object', additionalProperties: false, required: ['wakeTest'],
  properties: { wakeTest: { type: 'string', enum: [...allowed] } } });

/** The covering tests of the producer work in its own proposal — the only lawful choices. Two or more, or nothing to ask. */
function allowedTests(store: Store, request: WakeChoiceRequest): { proposal: Revision<{ nodes: Graph['nodes']; tests: Graph['tests'] }>; allowed: string[] } {
  const proposal = take(readRecord<{ nodes: Graph['nodes']; tests: Graph['tests']; fills: { node: string; wakeTest?: string }[] }>(store,
    request.proposal, { unit: 'G5.1', target: request.proposal.id, kind: 'layer-proposal', idPrefix: `om-proposal:${request.project}:` }));
  const value = proposal.value;
  if (!object(value) || !Array.isArray(value.nodes) || !Array.isArray(value.tests))
    fail('wake_source_invalid', request.proposal.id, 'proposal', 'The producer assembly needs its complete proposal');
  const node = value.nodes.find(item => item.id === request.work);
  if (!node || node.kind !== 'work') fail('wake_source_invalid', request.proposal.id, 'work', 'The proposal must define this producer work');
  const allowed = value.tests.filter(test => test.node === node.id && node.tests.includes(test.id) && test.covers.includes(request.connector))
    .map(test => test.id).sort();
  if (allowed.length < 2) fail('wake_choice_unneeded', request.connector, 'tests', 'A wake test is asked only of a work with several covering tests');
  return { proposal: proposal as unknown as Revision<{ nodes: Graph['nodes']; tests: Graph['tests'] }>, allowed };
}
function deriveIntent(store: Store, request: WakeChoiceRequest, ordinal: number, previous: Revision<WakeChoiceRecord> | null): WakeIntentRecord {
  const { proposal, allowed } = allowedTests(store, request);
  const series = take(readAnySeriesAt(store, request.project, request.accepting.series));
  if ('owner' in series.value) fail('wake_attempt_invalid', request.accepting.series.id, 'series', 'A wake choice is paid by a block attempt');
  const attempt = [...series.value.inherited, ...series.value.attempts].find(item => item.ordinal === request.accepting.attempt);
  if (!attempt || attempt.outcome !== null) fail('wake_attempt_invalid', request.accepting.series.id, 'attempt', 'The paying accepting attempt must be running');
  const environment = take(readRecord<Environment>(store, request.dispatch.config,
    { unit: 'G5.1', target: request.connector, id: `environment:${request.project}`, kind: 'environment' })).value;
  if (!object(environment) || environment.projectId !== request.project || !object(environment.implementer) || !text(environment.implementer.actor))
    fail('wake_request_invalid', request.dispatch.config.id, 'implementer', 'The environment must name its implementer');
  take(readRecord(store, request.dispatch.adapter, { unit: 'G5.1', target: request.connector, id: request.dispatch.adapter.id, kind: 'dispatch-adapter' }));
  const node = proposal.value.nodes.find(item => item.id === request.work)!;
  const key = keyOf(request), call = `wake:${key}:${ordinal}`;
  const packet = json({ protocol: WAKE_CHOICE_PROTOCOL, task: 'wake-test', connector: request.connector,
    work: { id: node.id, title: node.title, outcome: node.outcome, tests: node.tests },
    tests: proposal.value.tests.filter(test => allowed.includes(test.id)),
    allowed, rule: WAKE_TEST.rule,
    previous: previous ? { verdict: previous.value.verdict, choice: previous.value.choice, reasons: previous.value.reasons } : null,
    responseForm: { protocol: WAKE_CHOICE_PROTOCOL, schema: responseSchema(allowed),
      text: 'Return exactly one JSON object {"wakeTest": <one of "allowed">} and nothing else.' } });
  const wire = take(adapterRequest({ requestId: call, packet, model: environment.implementer.model, effort: environment.implementer.effort,
    ...(environment.implementer.speed === undefined ? {} : { speed: environment.implementer.speed }) }));
  const capacity = take(readCapacity(store, { project: request.project, environment: request.dispatch.config, current: false }));
  if (canonical(wire as unknown as Json).length > capacity.maxRequestChars)
    fail('context_too_large', request.connector, 'packet', 'The complete wake-choice request exceeds the saved technical capacity');
  const goal: AttemptGoal = { key: `wake:${key}`, questions: [request.connector], result: 'One wake test of the producer work for this sleeping connection' };
  void call;
  return copy({ contract: INTENT_CONTRACT, project: request.project, request, ordinal, allowed,
    previous: previous ? reference(previous) : null, block: series.value.block, goal, packet });
}
const copy = <T>(value: T): T => JSON.parse(canonical(value as unknown as Json)) as T;
/** The E1 of an intent follows from the saved intent alone: its name, its basis (the intent) and its paying attempt. */
export function wakeCallOf(intent: Revision<WakeIntentRecord> | Sealed<Revision<WakeIntentRecord>>): AnyRecordCallRequest {
  const value = intent.value, request = value.request;
  return copy({ call: `wake:${keyOf(request)}:${value.ordinal}`, purpose: 'wake-choice', basis: { kind: 'wake-choice', intent: reference(intent) },
    block: value.block, gaps: [{ id: request.connector, goal: value.goal.key, field: WAKE_TEST.field, consumer: value.block }],
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
      || record.id !== wakeIntentId(project, keyOf(value.request), value.ordinal) || record.revision !== 1)
      fail('wake_intent_invalid', record.id, 'intent', 'A wake intent stands at the address of its own producer end and ordinal');
    return record;
  });
}
/** NR (№3600): a trusted read — runWakeChoice wrote the result from its exact intent and transport once. */
export function readWakeChoiceAt(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<WakeChoiceRecord>>, string> {
  return result(() => {
    const record = take(readRecord<WakeChoiceRecord>(store, ref, { unit: 'G5.1', target: ref.id, kind: WAKE_CHOICE_KIND,
      idPrefix: `${WAKE_CHOICE_KIND}:${project}:` })) as Revision<WakeChoiceRecord>;
    const value = record.value;
    if (!object(value) || value.contract !== CHOICE_CONTRACT || value.project !== project || !isRef(value.intent)
      || (value.verdict === 'chosen') !== text(value.choice))
      fail('wake_result_invalid', record.id, 'result', 'A wake result keeps its intent, and a choice exactly when chosen');
    const intent = take(readWakeIntentAt(store, project, value.intent));
    if (!same(value.proposal, intent.value.request.proposal) || value.work !== intent.value.request.work
      || value.connector !== intent.value.request.connector || value.verdict === 'chosen' && !intent.value.allowed.includes(value.choice!))
      fail('wake_result_invalid', record.id, 'intent', 'A wake result belongs to its exact intent and its allowed tests');
    return record;
  });
}
/** Every saved result of one producer end, in ordinal order — read by its deterministic addresses, never by a list. */
function resultsOf(store: Store, project: string, key: string): Revision<WakeChoiceRecord>[] {
  const rows: Revision<WakeChoiceRecord>[] = [];
  for (let ordinal = 1; ordinal <= WAKE_CHOICE_ATTEMPTS; ordinal++) {
    const head = store.get<WakeChoiceRecord>(wakeChoiceId(project, key, ordinal));
    if (!head) break;
    rows.push(take(readWakeChoiceAt(store, project, reference(head))) as Revision<WakeChoiceRecord>);
  }
  return rows;
}
/**
 * The chosen supplements of one proposal — what a works candidate takes. Only a work with several tests covering one
 * connection can have one, so its own pairs are read at their deterministic addresses: the cost follows the proposal,
 * never the history of other choices (№3606, return №3867-2).
 */
export function chosenWakes(store: Store, project: string, proposal: Ref): OmResult<Sealed<WakeChoiceInput[]>, string> {
  return result(() => {
    const record = take(readRecord<{ nodes: Graph['nodes']; tests: Graph['tests'] }>(store, proposal,
      { unit: 'G5.1', target: proposal.id, kind: 'layer-proposal', idPrefix: `om-proposal:${project}:` }));
    const value = record.value;
    if (!object(value) || !Array.isArray(value.nodes) || !Array.isArray(value.tests))
      fail('wake_source_invalid', proposal.id, 'proposal', 'The producer assembly needs its complete proposal');
    const found: WakeChoiceInput[] = [];
    for (const node of value.nodes) if (object(node) && node.kind === 'work' && Array.isArray(node.tests)) {
      const covering = new Map<string, number>();
      for (const test of value.tests) if (object(test) && test.node === node.id && node.tests.includes(test.id) && Array.isArray(test.covers))
        for (const connector of new Set(test.covers)) covering.set(connector, (covering.get(connector) ?? 0) + 1);
      for (const [connector, count] of covering) if (count >= 2) {
        const chosen = resultsOf(store, project, keyOf({ project, proposal, work: node.id, connector })).find(row => row.value.verdict === 'chosen');
        if (chosen) found.push({ proposal, work: node.id, connector, test: chosen.value.choice!, choice: reference(chosen) });
      }
    }
    return found.sort((a, b) => canonical(a as unknown as Json) < canonical(b as unknown as Json) ? -1 : 1);
  });
}
/** A candidate's supplement is proved by its own saved chosen result, never by its copy in the request. */
export function checkWakeInput(store: Store, project: string, input: WakeChoiceInput): OmResult<Sealed<WakeChoiceInput>, string> {
  return result(() => {
    const row = take(readWakeChoiceAt(store, project, input.choice));
    if (row.value.verdict !== 'chosen' || !same(row.value.proposal, input.proposal) || row.value.work !== input.work
      || row.value.connector !== input.connector || row.value.choice !== input.test)
      fail('wake_result_invalid', input.choice.id, 'choice', 'The supplement must repeat its exact chosen result');
    return input;
  });
}
function verdictOf(intent: WakeIntentRecord, physical: Sealed<ModelTransportOutcome>): Pick<WakeChoiceRecord, 'verdict' | 'choice' | 'reasons'> {
  if (physical.result.kind !== 'answered') return { verdict: physical.result.kind === 'interrupted' ? 'interrupted' : 'off-form',
    choice: null, reasons: [physical.result.error.message] };
  let parsed: unknown;
  try { parsed = JSON.parse(physical.result.raw); } catch { return { verdict: 'off-form', choice: null, reasons: ['The answer is not one JSON object'] }; }
  if (!object(parsed) || !same(Object.keys(parsed), ['wakeTest']) || typeof parsed.wakeTest !== 'string')
    return { verdict: 'off-form', choice: null, reasons: ['The answer must be exactly {"wakeTest": <test id>}'] };
  if (!intent.allowed.includes(parsed.wakeTest))
    return { verdict: 'refused', choice: null, reasons: [`${parsed.wakeTest} is not one of the producer work's tests covering ${intent.request.connector}`] };
  return { verdict: 'chosen', choice: parsed.wakeTest, reasons: [] };
}
/** G5.1: where one producer end stands — its choice made, or the ordinal of the next intent while one more is lawful. */
export function wakeStanding(store: Store, request: WakeChoiceRequest): OmResult<Sealed<{ chosen: boolean; next: number | null }>, string> {
  requireRequest(store, request);
  return result(() => {
    const saved = resultsOf(store, request.project, keyOf(request));
    const chosen = saved.some(row => row.value.verdict === 'chosen');
    return { chosen, next: chosen || saved.length >= WAKE_CHOICE_ATTEMPTS ? null : saved.length + 1 };
  });
}
/**
 * The wake test of one producer end, by the exact intent its step names: the saved result of that ordinal is the step's
 * outcome whatever its verdict, so a restart after it sends nothing; otherwise that intent (the later one showing why the
 * earlier failed), its E1, one transport and its result. The next ordinal is always a step of its own (return №3867-1).
 */
export async function runWakeChoice(store: Store, request: WakeChoiceRequest, ordinal: number, signal?: AbortSignal, control?: RunControlHold):
  Promise<OmResult<Sealed<Revision<WakeChoiceRecord>>, string>> {
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
      fail('wake_intent_invalid', request.connector, 'ordinal', 'A later wake intent follows the saved result of every earlier one');
    if (saved.some(row => row.value.verdict === 'chosen'))
      fail('wake_intent_invalid', request.connector, 'ordinal', 'A producer end whose wake test is chosen asks no further intent');
    const id = wakeIntentId(request.project, key, ordinal);
    const existing = store.get<WakeIntentRecord>(id);
    const intent = existing ? take(readWakeIntentAt(store, request.project, reference(existing))) as Revision<WakeIntentRecord>
      : (() => {
        const value = deriveIntent(store, request, ordinal, saved.at(-1) ?? null);
        const write: Write = { id, kind: WAKE_INTENT_KIND, expected: 0, value: value as unknown as Json };
        const guards: TransactionGuard[] = [request.accepting.series, request.proposal, request.dispatch.config, request.dispatch.adapter,
          ...(saved.length ? [reference(saved.at(-1)!)] : [])];
        return take(writeGuarded(gate.view(), { unit: 'G5.1', target: id, writes: [write], guards: uniqueTransactionGuards(guards) }))[0] as unknown as Revision<WakeIntentRecord>;
      })();
    const admitted = take(recordCall(gate.view(), request.project, wakeCallOf(intent), [reference(intent)]));
    const first = store.get(admitted.call.id, 1)!;
    const physical = take(await transportUnder(store, { project: request.project, call: reference(first), packet: intent.value.packet,
      role: 'implementer' }, signal, [reference(intent)], gate));
    const value: WakeChoiceRecord = { contract: CHOICE_CONTRACT, project: request.project, intent: reference(intent),
      transport: reference(physical.record), proposal: request.proposal, work: request.work, connector: request.connector,
      ...verdictOf(intent.value, physical) };
    const resultId = wakeChoiceId(request.project, key, ordinal), write: Write = { id: resultId, kind: WAKE_CHOICE_KIND, expected: 0, value: value as unknown as Json };
    const stored = writeGuarded(store, { unit: 'G5.1', target: resultId, writes: [write], guards: [reference(intent), reference(physical.record)] });
    if (!stored.ok) {
      const raced = store.get<WakeChoiceRecord>(resultId);
      if (raced && same(raced.value, value)) return readWakeChoiceAt(store, request.project, reference(raced));
      return { ok: false, refusal: stored.refusal as Refusal };
    }
    return readWakeChoiceAt(store, request.project, reference(stored.value[0]!));
  } catch (error) {
    if (error instanceof WakeFailure || error instanceof RunControlLost) return { ok: false, refusal: error.refusal as Refusal };
    throw error;
  }
}

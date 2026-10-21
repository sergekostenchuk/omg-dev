import { canonical, HASH_RE } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { V7ProgressSubject, V7ProgressSummary } from './research-model.js';

export type V7ProgressCounters = Pick<V7ProgressSummary, 'cursor' | 'count' | 'streak'>;
export interface V7FoldAttempt { attempt: Ref; number: number; contentKeys: readonly string[] }
export interface V7ProgressFoldInput {
  subject: V7ProgressSubject;
  run: string;
  previous: { subject: V7ProgressSubject; counters: V7ProgressCounters } | null;
  attempts: readonly V7FoldAttempt[];
  /** Exact accounts and content keys already proven by the caller. These are
   * only the relevant inputs, not an instruction to scan a previous history. */
  accounted: readonly Ref[];
  knownContentKeys: readonly string[];
}
export interface V7ProgressFold {
  counters: V7ProgressCounters;
  stalled: boolean;
  fresh: { attempt: Ref; number: number; contentKeys: string[]; streak: number }[];
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function invalid(field: string, reason: string): never {
  throw new EngineError('discovery_progress_order_invalid', `[${field}] ${reason}`, { field, reason });
}
function shape(v: unknown, keys: readonly string[], field: string): asserts v is Record<string, unknown> {
  if (!obj(v) || Object.keys(v).length !== keys.length || !keys.every(key => Object.hasOwn(v, key)))
    invalid(field, 'The fold requires its explicit contracted inputs');
}
function subject(v: unknown, field: string): asserts v is V7ProgressSubject {
  shape(v, ['project', 'planAnswer', 'planQuestionId'], field);
  if (!text(v.project) || !isRef(v.planAnswer) || !text(v.planQuestionId)) invalid(field, 'An exact plan-question subject is required');
}
function counters(v: unknown, run: string): asserts v is V7ProgressCounters {
  const at = 'previous.counters';
  shape(v, ['cursor', 'count', 'streak'], at);
  if (!Number.isSafeInteger(v.count) || (v.count as number) < 0 || !Number.isSafeInteger(v.streak)
    || (v.streak as number) < 0 || (v.streak as number) > (v.count as number)) invalid(at, 'Counters are nonnegative safe integers and streak cannot exceed count');
  if (v.cursor === null) {
    if (v.count !== 0 || v.streak !== 0) invalid(`${at}.cursor`, 'A nonempty prefix needs its exact cursor');
    return;
  }
  shape(v.cursor, ['run', 'number'], `${at}.cursor`);
  if (v.cursor.run !== run || !Number.isSafeInteger(v.cursor.number) || (v.cursor.number as number) < (v.count as number)
    || v.count === 0) invalid(`${at}.cursor`, 'The prefix cursor belongs to this run and covers its counted attempts');
}
function keys(v: unknown, field: string): asserts v is string[] {
  if (!Array.isArray(v)) invalid(field, 'Content keys are an explicit list');
  for (const key of v) if (typeof key !== 'string' || !HASH_RE.test(key))
    invalid(field, 'Content keys are exact hashes, including an explicit empty list');
}

/** P.1 extracts the ordered counting/deduplication loop. The caller proves the
 * paid assessment, exact attempt order, previous state, accounts and keys.
 * This function performs no reads/writes and grants no acceptance or dispatch.
 * Semantic duplicate claims are omitted from the supplied contentKeys by that
 * proven classification; equal code keys are additionally deduplicated here. */
export function foldV7Progress(input: V7ProgressFoldInput): V7ProgressFold {
  shape(input, ['subject', 'run', 'previous', 'attempts', 'accounted', 'knownContentKeys'], 'input');
  subject(input.subject, 'subject');
  if (!text(input.run)) invalid('run', 'The ordered managed run is required');
  let before: V7ProgressCounters = { cursor: null, count: 0, streak: 0 };
  if (input.previous !== null) {
    shape(input.previous, ['subject', 'counters'], 'previous');
    subject(input.previous.subject, 'previous.subject');
    if (canonical(input.previous.subject) !== canonical(input.subject)) invalid('previous.subject', 'Another project, plan edition or question has its own counters');
    counters(input.previous.counters, input.run);
    before = input.previous.counters;
  }
  if (!Array.isArray(input.attempts)) invalid('attempts', 'Attempts are an explicit list');
  if (!Array.isArray(input.accounted)) invalid('accounted', 'Reused accounts are an explicit list');
  keys(input.knownContentKeys, 'knownContentKeys');
  if ((!input.previous || before.count === 0) && (input.accounted.length || input.knownContentKeys.length))
    invalid('previous', 'There are no prior accounts or progress keys without a counted predecessor');
  const rows = new Map<string, V7FoldAttempt>(), ids = new Set<string>();
  let last = 0;
  for (const [i, row] of input.attempts.entries()) {
    const at = `attempts.${i}`;
    shape(row, ['attempt', 'number', 'contentKeys'], at);
    if (!isRef(row.attempt) || !Number.isSafeInteger(row.number) || (row.number as number) <= last)
      invalid(at, 'Attempts retain strictly ascending proven managed positions and exact references');
    keys(row.contentKeys, `${at}.contentKeys`);
    if (ids.has(row.attempt.id)) invalid(`${at}.attempt`, 'One immutable attempt occurs once in a packet');
    ids.add(row.attempt.id); rows.set(canonical(row.attempt), row as unknown as V7FoldAttempt); last = row.number as number;
  }
  const accounted = new Set<string>();
  for (const [i, ref] of input.accounted.entries()) {
    if (!isRef(ref)) invalid(`accounted.${i}`, 'A reused account names an exact attempt');
    const key = canonical(ref), row = rows.get(key);
    if (!row || accounted.has(key) || !before.cursor || row.number > before.cursor.number)
      invalid(`accounted.${i}`, 'Only unique exact prior accounts of this packet and saved prefix may be reused');
    accounted.add(key);
  }
  const seen = new Set(input.knownContentKeys), fresh: V7ProgressFold['fresh'] = [];
  const after = structuredClone(before);
  for (const row of input.attempts) {
    if (accounted.has(canonical(row.attempt))) continue;
    if (row.number <= (before.cursor?.number ?? 0)) invalid('cursor', 'An unaccounted attempt cannot precede the saved prefix');
    const emitted: string[] = [];
    for (const key of row.contentKeys) if (!seen.has(key)) { seen.add(key); emitted.push(key); }
    after.count++;
    after.streak = emitted.length ? 0 : after.streak + 1;
    after.cursor = { run: input.run, number: row.number };
    fresh.push({ attempt: { ...row.attempt }, number: row.number, contentKeys: emitted, streak: after.streak });
  }
  return { counters: after, stalled: after.streak >= 3, fresh };
}

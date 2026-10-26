import assert from 'node:assert/strict';
import { types } from 'node:util';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';

/**
 * The cheap form of "this door wrote nothing": the product records of a real, open Store are compared through its own
 * changeStamp() before and after one fully awaited action, instead of dumping every head and revision twice.
 *
 * An equal stamp proves that no commit of product records (heads, revisions, events) went through this Store — its own
 * write/writeMany and every non-empty atomicWrite are counted — and that no other connection committed to the file
 * meanwhile: SQLite's data_version moves with each such commit, so a write followed by a write that restores the value is
 * seen as well. A refused write that rolled back, and an empty atomicWrite, commit nothing and pass. A writeMany([]) does
 * commit (an empty transaction) and moves the stamp: that stricter signal is reported as a change, never masked.
 *
 * What it does not cover: the proof cache and the index tables are technical and never moved the stamp (nor the old full
 * dump of heads and revisions); and a stamp is comparable only on the very Store object it was read from — never across
 * two Stores, and never before and after a reopen. A scenario in which another connection legally commits technical rows
 * inside the window keeps the full comparison of its product history instead, and says so.
 *
 * The Store is the genuine open object the checked door runs on — not a Proxy, not an object that only answers
 * changeStamp, not a Store whose changeStamp was replaced. Both stamp reads happen on that very Store, outside any held
 * transaction (never inside an atomicWrite preparation). The stamp is read again when the action throws, so a write
 * followed by a refusal is no silent pass. The action must be awaited to its end by the caller's own door: work left
 * running after it returns is outside the window.
 */

/** The refusals of the product itself: an EngineError. Pass another predicate to demand one code. */
export const engineRefusal = (error: unknown): boolean => error instanceof EngineError;

function stampOf(store: Store): string {
  assert.ok(typeof store === 'object' && store !== null && !types.isProxy(store) && store instanceof Store,
    'the window needs the genuine Store the checked door runs on, not a stand-in or a Proxy');
  assert.equal(store.changeStamp, Store.prototype.changeStamp, 'the window needs the genuine changeStamp of the Store, not a replaced method');
  return store.changeStamp();
}

interface Outcome { returned: boolean; value?: unknown; error?: unknown }

/** Runs the action once, then proves the stamp — also when the action threw. */
async function observed(store: Store, action: () => unknown): Promise<Outcome> {
  const before = stampOf(store);
  const outcome: Outcome = { returned: false };
  try { outcome.value = await action(); outcome.returned = true; } catch (error) { outcome.error = error; }
  const after = stampOf(store);
  if (after !== before) {
    const failure = new assert.AssertionError({ message: `the checked action committed to the product store (change stamp ${before} -> ${after})`
      + `${outcome.returned ? '' : ' and then threw'}`, actual: after, expected: before, operator: 'strictEqual' });
    if (!outcome.returned) Object.defineProperty(failure, 'cause', { value: outcome.error, configurable: true });
    throw failure;
  }
  return outcome;
}

/** The action succeeds and commits nothing to the product store. Its value is returned; its own error is rethrown after the stamp is proved. */
export async function storeUnchanged<T>(store: Store, action: () => T | Promise<T>): Promise<T> {
  const outcome = await observed(store, action);
  if (!outcome.returned) throw outcome.error;
  return outcome.value as T;
}

/** The action refuses (an EngineError unless `refusal` says otherwise) and commits nothing. Returns the refusal. */
export async function storeRefused(store: Store, action: () => unknown, refusal: (error: unknown) => boolean = engineRefusal): Promise<unknown> {
  const outcome = await observed(store, action);
  assert.ok(!outcome.returned, 'the checked door must refuse, but it returned');
  assert.ok(refusal(outcome.error), `the checked door refused with an unexpected error: ${String((outcome.error as Error | undefined)?.message ?? outcome.error)}`);
  return outcome.error;
}

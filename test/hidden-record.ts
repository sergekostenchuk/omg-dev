import { Store, type Revision } from '../src/storage/store.js';

/**
 * A record the genuine Store answers differently for the time of one action: absent (null) or another revision. The door
 * under test reads the very Store object, so its proofs are derived and kept as in production; an opaque Proxy or a
 * storeView with a `get` projection makes every read through it untraced and every proof is derived again from the
 * first record in each window (about ten seconds for one door of a paid world). What a window may still not do is
 * written down by the caller around it: storeUnchanged/fixed prove that nothing was committed.
 *
 * Only reads of `get` change, exactly as in the stand-ins this replaces: list, history and identities still show the
 * record. Only the named Store object is affected; every other Store, also on the same file, reads as before.
 */
export interface Hide {
  id: string;
  /** `exact` (default): the head and the read of `revision` (every revision when none is named); `head`: only a read without a revision; `every`: any read of the id. */
  reads?: 'exact' | 'head' | 'every';
  revision?: number;
}
interface Rule { store: Store; hide: Hide; answer: Revision<unknown> | null }
const rules = new Set<Rule>();
let original: Store['get'] | null = null;

function matches(rule: Rule, store: Store, id: string, revision: number | undefined): boolean {
  if (rule.store !== store || rule.hide.id !== id) return false;
  switch (rule.hide.reads ?? 'exact') {
    case 'every': return true;
    case 'head': return revision === undefined;
    default: return revision === undefined || rule.hide.revision === undefined || revision === rule.hide.revision;
  }
}
function install(): void {
  if (original !== null) return;
  const get = original = Store.prototype.get;
  Store.prototype.get = function (this: Store, id: string, revision?: number) {
    for (const rule of rules) if (matches(rule, this, id, revision)) return rule.answer as never;
    return get.call(this, id, revision);
  } as Store['get'];
}

/** Starts hiding; the returned function ends it. Prefer `whileHidden`, which ends it also when the action throws. */
export function hideRecord(store: Store, hide: Hide, answer: Revision<unknown> | null = null): () => void {
  const rule: Rule = { store, hide, answer };
  install();
  rules.add(rule);
  return () => {
    rules.delete(rule);
    if (rules.size === 0 && original !== null) { Store.prototype.get = original; original = null; }
  };
}

/** Runs the action to its end with the record hidden on `store`, then restores the reads, whatever the action did. */
export async function whileHidden<T>(store: Store, hide: Hide, answer: Revision<unknown> | null, action: () => T | Promise<T>): Promise<T> {
  const end = hideRecord(store, hide, answer);
  try { return await action(); } finally { end(); }
}

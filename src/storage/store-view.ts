import { EngineError, requireCondition } from '../errors.js';
import { canonical, hashJson } from '../canonical.js';
import type { Revision, Store, TransactionGuard, Write } from './store.js';

/** One storage view over a Store or a nearer view (№1728): the single
 * interception of BOTH write methods. One public call is exactly one policy
 * pass — write(w) is policy([w], []), never target.write (which on a raw Store
 * dispatches to the un-intercepted this.writeMany); writeMany(ws, g) is
 * policy(ws, g). The subject policy lives in the consumer; this shell owns only
 * the routing and the explicitly declared surface. */
export interface StoreViewPolicy {
  write(inputs: Write[], guards: TransactionGuard[]): Revision[];
  /** The consumer's read overlay (pending rows, substitutions, read
   * observation). Returning undefined falls through to the nearest target. */
  get?(id: string, revision?: number): Revision | null | undefined;
}

const READ_METHODS = new Set(['get', 'list', 'history']);
const READ_PROPERTIES = new Set(['path', 'databaseId']);

function descriptorOf(target: object, prop: string): PropertyDescriptor | undefined {
  let cursor: object | null = target;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, prop);
    if (descriptor) return descriptor;
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return undefined;
}

/** Every call builds its own Proxy (№1734-9): never the bare target, never a
 * per-target cached instance. instanceof Store is preserved through the
 * prototype chain; read methods run with the nearest target as receiver, so
 * private fields stay reachable; a function-valued member outside the declared
 * surface yields a refusing function (typeof stays 'function', the call throws
 * before the original method runs — №1734-11); an undeclared accessor is
 * refused at property-get before its getter runs. */
export function storeView(target: Store, policy: StoreViewPolicy): Store {
  const unsupported = (prop: string) => function () {
    throw new EngineError('store_view_method_unsupported',
      `The store view does not expose method '${prop}'`, { method: prop });
  };
  const view: Store = new Proxy(target, {
    get(target, prop, _receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, target);
      if (prop === 'write')
        return <T,>(input: Write): Revision<T> => policy.write([input], [])[0] as Revision<T>;
      if (prop === 'writeMany')
        return <T,>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] =>
          policy.write(inputs, guards) as Revision<T>[];
      if (prop === 'get' && policy.get)
        return (id: string, revision?: number) => {
          const projected = policy.get!(id, revision);
          // Only undefined delegates to the nearest target; an explicit null is
          // the projection's own answer "no record in this view" (№1760-2).
          return projected === undefined ? target.get(id, revision) : projected;
        };
      if (READ_METHODS.has(prop))
        return (Reflect.get(target, prop, target) as (...args: never[]) => unknown).bind(target);
      if (READ_PROPERTIES.has(prop)) return Reflect.get(target, prop, target);
      const descriptor = descriptorOf(target, prop);
      if (descriptor && typeof descriptor.get === 'function')
        throw new EngineError('store_view_method_unsupported',
          `The store view does not expose accessor '${prop}'`, { method: prop });
      if (descriptor && typeof descriptor.value === 'function') return unsupported(prop);
      const member: unknown = Reflect.get(target, prop, target);
      return typeof member === 'function' ? unsupported(prop) : member;
    },
  });
  // The capture-over-capture ban survives guard/read projections built by this
  // helper (№1760-3): a view derived from a capture keeps its taint, so a later
  // captureView refuses before any accumulation. The raw Store is never
  // unwrapped and no nested-transaction machinery is introduced; a capture over
  // a guard of a plain Store stays lawful because that guard is untainted.
  if (captureViews.has(target)) captureViews.add(view);
  return view;
}

/** The capture-view registry: the only forbidden composition is capture over
 * capture (№1728-16); sequential captures and capture over a guard/read
 * projection stay lawful (№1734-10). */
const captureViews = new WeakSet<object>();

export interface CaptureHooks {
  /** Subject admission of one element after the shared form checks — the
   * consumer's own refusal (e.g. packet_record_invalid for native issuance). */
  admit?(write: Write, pending: Revision | undefined, existing: Revision | null): void;
  /** Pending rows the read overlay sees first and duplicate/kind checks
   * consult; pending rewrite of one id is refused (no virtual rewrite). */
  rows?: Map<string, Revision>;
  /** The consumer's read overlay; undefined result falls through to target. */
  get?(id: string, revision?: number): Revision | null | undefined;
  /** 'refuse': a well-formed absent guard is rejected with
   * store_view_guard_unsupported (№1734-1); default: carried. */
  absentGuards?: 'carry' | 'refuse';
}

function validateWriteForm(write: Write): void {
  requireCondition(write !== null && typeof write === 'object' && !Array.isArray(write)
    && typeof write.id === 'string' && write.id.length > 0 && write.id.length <= 200
    && typeof write.kind === 'string' && write.kind.length > 0
    && Number.isSafeInteger(write.expected) && write.expected >= 0,
    'invalid_write', 'A write needs a nonempty bounded id, a nonempty kind and a nonnegative integer expected');
  canonical(write.value); // serializability: the same error the Store would surface
}

function validateGuardForm(guard: TransactionGuard, index: number): void {
  requireCondition(guard !== null && typeof guard === 'object' && !Array.isArray(guard),
    'invalid_guard', `Guard ${index} must be a record`);
  const fields = guard as unknown as Record<string, unknown>;
  const id = fields['id'];
  requireCondition(typeof id === 'string' && id.length > 0, 'invalid_guard', `Guard ${index} needs a nonempty ID`);
  if ('absent' in fields)
    requireCondition(fields['absent'] === true && !('revision' in fields) && !('hash' in fields),
      'invalid_guard', `Guard ${index} for ${String(id)} must declare only absence`);
  else
    requireCondition(typeof fields['revision'] === 'number' && Number.isSafeInteger(fields['revision'])
      && (fields['revision'] as number) > 0
      && typeof fields['hash'] === 'string' && /^[a-f0-9]{64}$/i.test(fields['hash'] as string),
      'invalid_guard', `Guard ${index} for ${String(id)} needs an exact revision and SHA-256 hash`);
}

/** The shared narrow core of both capture consumers (№1734-7): batch form
 * checks with the Store's own codes, one capture overlay, detached copies.
 * This checks the API arguments and the pack's atomicity — it never promises
 * the final commit: Store.writeMany re-decides guards and conflicts then. */
export function captureView(target: Store, hooks: CaptureHooks = {}): { view: Store; writes: Write[]; guards: TransactionGuard[] } {
  if (captureViews.has(target))
    throw new EngineError('store_view_composition_unsupported',
      'A capture view cannot accumulate over another capture view');
  const writes: Write[] = [], guards: TransactionGuard[] = [];
  const overlay = hooks.get ?? (hooks.rows
    ? (id: string, revision?: number) => {
      const pending = hooks.rows!.get(id);
      return pending && (revision === undefined || revision === pending.revision) ? pending : undefined;
    }
    : undefined);
  const policy: StoreViewPolicy = {
    ...(overlay ? { get: overlay } : {}),
    write(inputs, callerGuards) {
      callerGuards.forEach(validateGuardForm);
      // Validate the whole batch before publishing any element (№1728-2).
      const seen = new Set<string>();
      const prepared = inputs.map(input => {
        validateWriteForm(input);
        requireCondition(!seen.has(input.id), 'duplicate_write', `A batch writes '${input.id}' twice`);
        seen.add(input.id);
        const pending = hooks.rows?.get(input.id);
        requireCondition(!pending, 'duplicate_write', `The captured set already holds '${input.id}'`);
        const existing = target.get(input.id) ?? null;
        // The consumer's subject rule answers first where IT is violated
        // (№1734-7); the kind/expected checks of the current view follow.
        hooks.admit?.(input, pending, existing);
        if (existing) {
          requireCondition(existing.kind === input.kind, 'kind_mismatch',
            `The entity '${input.id}' cannot change its kind`);
          requireCondition(input.expected === existing.revision, 'revision_conflict',
            `The entity '${input.id}' moved before this write could commit`);
        } else requireCondition(input.expected === 0, 'revision_conflict',
          `The entity '${input.id}' does not exist for expected=${input.expected}`);
        return { id: input.id, kind: input.kind, expected: input.expected,
          value: JSON.parse(canonical(input.value)) as unknown };
      });
      if (hooks.absentGuards === 'refuse')
        for (const guard of callerGuards)
          if ('absent' in guard)
            throw new EngineError('store_view_guard_unsupported',
              `This capture cannot carry the absent guard '${guard.id}'`, { id: guard.id });
      // Only now publish: accumulated writes keep the caller's exact expected;
      // input, returned Revision and the accumulated write share no mutable cell.
      guards.push(...callerGuards);
      return prepared.map(write => {
        const accumulated: Write = { id: write.id, kind: write.kind, expected: write.expected,
          value: JSON.parse(canonical(write.value)) };
        writes.push(accumulated);
        hooks.rows?.set(write.id, { id: write.id, kind: write.kind, revision: write.expected + 1,
          hash: hashJson(write.value), value: JSON.parse(canonical(write.value)) });
        return { id: write.id, kind: write.kind, revision: write.expected + 1,
          hash: hashJson(write.value), value: JSON.parse(canonical(write.value)) };
      });
    },
  };
  const view = storeView(target, policy);
  captureViews.add(view);
  return { view, writes, guards };
}

import { types } from 'node:util';
import { EngineError, requireCondition } from '../errors.js';
import { canonical, hashJson } from '../canonical.js';
import { Store, type Revision, type TransactionGuard, type Write } from './store.js';

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
  /** A capture keeps the opaque Proxy whatever its target (S1.1, №1887-2):
   * its pending rows are a read projection of the caller's own writes. */
  capture?: true;
}

/** The write-only views this helper built over a genuine Store (or over one
 * another): the one category whose reads are exactly the target's, proved as
 * such by this module — never by a frozen shell or a caller's claim. */
const writeOnlyViews = new WeakSet<object>();

/** A genuine Store instance (№2008-1): no Proxy, the Store prototype itself, and no own member but the constructor's
 * own `path` data property — so every reading member is the prototype's own. A frozen shell built on Store.prototype
 * with own accessors or methods (reads delegated elsewhere, added before or after), or any object of unknown origin,
 * is not one: its reads may reach another source beneath it. Neither !isProxy nor Object.isFrozen proves anything. */
export function genuineStore(candidate: unknown): candidate is Store {
  if (typeof candidate !== 'object' || candidate === null || types.isProxy(candidate)) return false;
  if (Object.getPrototypeOf(candidate) !== Store.prototype || Object.getOwnPropertySymbols(candidate).length) return false;
  const own = Object.getOwnPropertyNames(candidate), path = Object.getOwnPropertyDescriptor(candidate, 'path');
  return own.length === 1 && own[0] === 'path' && path !== undefined && !path.get && !path.set && typeof path.value === 'string';
}
/** The one rule of the fast branches (№2008-1, №2012-2): reads proved to be a genuine Store's — the instance itself, or
 * a write-only view of this module's own making over such reads. This narrow category is what storeView and the
 * acceptance's Transaction admit. */
export const provenReads = (candidate: unknown): candidate is Store => genuineStore(candidate) || writeOnlyViews.has(candidate as object);

/** The frozen source overlays other helpers build over proved reads — the pending overlays of E4 and the previews of
 * the acceptance's Transaction (№1942) — registered by their own constructors, never by a caller's claim or a flag.
 * The pending overlay of E4 admits them beneath itself (№2012-2): their reads are the proved reads they were built on. */
const sourceOverlays = new WeakSet<object>();
export function registerSourceOverlay(view: Store): void { sourceOverlays.add(view); }
export const provenSourceReads = (candidate: unknown): candidate is Store => provenReads(candidate) || sourceOverlays.has(candidate as object);

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
  // S1.1 (№1887-2): a view that intercepts ONLY the writes, directly over a plain Store or over such a view of this
  // module's own making, is not a Proxy: an opaque Proxy makes every proof read through it unrepeatable, so the same
  // history was derived again on each path. Its region stays separate; the raw Store is never handed out. A capture,
  // a read projection, a historicalTrace, an arbitrary Proxy or an unknown lower view keep the opaque Proxy below.
  if (!policy.get && !policy.capture && provenReads(target)) return writeOnlyView(target, policy, unsupported);
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

/** The write-only facade: an ordinary frozen object whose own surface is the declared one (bound reads, the policy's
 * writes, the forwarded read properties) and whose prototype chain ends in a refusing gate before Store.prototype.
 * The gate answers every undeclared member exactly as the Proxy above does — resolved against the NEAREST TARGET at
 * the moment of access (№2008-2): a method of the target, own or inherited, added before or after the view, is a
 * refusing function (typeof stays 'function'); an accessor of the target refuses before its getter runs; an absent
 * property reads undefined — while `instanceof Store` holds through the gate's prototype. Nothing about the target's
 * behaviour is assumed: its reads run with the target as receiver, exactly as through the Proxy. */
function writeOnlyView(target: Store, policy: StoreViewPolicy, unsupported: (prop: string) => () => never): Store {
  const gate = new Proxy(Object.create(Store.prototype) as object, {
    get(_proto, prop, _receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, target);
      const descriptor = descriptorOf(target, prop);
      if (descriptor && typeof descriptor.get === 'function')
        throw new EngineError('store_view_method_unsupported',
          `The store view does not expose accessor '${prop}'`, { method: prop });
      if (descriptor && typeof descriptor.value === 'function') return unsupported(prop);
      const member: unknown = Reflect.get(target, prop, target);
      return typeof member === 'function' ? unsupported(prop) : member;
    },
  });
  const members = Object.create(gate) as Record<string, unknown>;
  Object.defineProperty(members, 'write', { value: <T,>(input: Write): Revision<T> => policy.write([input], [])[0] as Revision<T> });
  Object.defineProperty(members, 'writeMany', { value: <T,>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] =>
    policy.write(inputs, guards) as Revision<T>[] });
  for (const name of READ_METHODS)
    Object.defineProperty(members, name, { value: (Reflect.get(target, name, target) as (...args: never[]) => unknown).bind(target) });
  for (const name of READ_PROPERTIES) Object.defineProperty(members, name, { get: () => Reflect.get(target, name, target) });
  Object.freeze(members);
  const view = Object.freeze(Object.create(members)) as Store;
  writeOnlyViews.add(view);
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
    ...(overlay ? { get: overlay } : {}), capture: true,
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

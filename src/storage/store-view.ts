import { types } from 'node:util';
import { EngineError, requireCondition } from '../errors.js';
import { canonical, hashJson } from '../canonical.js';
import { checkTransactionGuards, noteUntracedRead, noteWriteAttempt, Store, type Revision, type TransactionGuard, type Write } from './store.js';

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
/** The target each write-only view was built over and the read methods it bound, recorded by writeOnlyView itself. */
const writeOnlyTargets = new WeakMap<object, { target: Store; reads: Map<string, unknown> }>();
/** The genuine Store whose reads these are (S1.3, №2185-3, №2194-1): the instance itself, or the Store beneath this
 * module's own write-only views — as long as every view in the chain still reads through the very methods it bound. Its
 * changeStamp and identities speak for exactly these reads. A Proxy, a subclass, an overlay, a capture, a trace or a
 * view whose target's reads were replaced after it was built has none, and keeps the conservative branch. */
export function provenStore(candidate: unknown): Store | null {
  for (let cursor = candidate; ;) {
    if (genuineStore(cursor)) return cursor;
    const built = typeof cursor === 'object' && cursor !== null ? writeOnlyTargets.get(cursor) : undefined;
    if (!built || [...built.reads].some(([name, bound]) => Reflect.get(built.target, name, built.target) !== bound)) return null;
    cursor = built.target;
  }
}

/** The frozen source overlays other helpers build over proved reads — the pending overlays of E4 and the previews of
 * the acceptance's Transaction (№1942) — registered by their own constructors, never by a caller's claim or a flag.
 * The pending overlay of E4 admits them beneath itself (№2012-2): their reads are the proved reads they were built on. */
const sourceOverlays = new WeakSet<object>();
export function registerSourceOverlay(view: Store): void { sourceOverlays.add(view); }
export const provenSourceReads = (candidate: unknown): candidate is Store => provenReads(candidate) || sourceOverlays.has(candidate as object);

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  Object.freeze(value);
}
/** One layer of a pending overlay this module built: its base, its own frozen rows and the base members it bound. */
interface PendingLayer { base: Store; rows: ReadonlyMap<string, Revision<unknown>>; bound: ReadonlyMap<string, unknown> }
/** Written only by pendingOverlay; never handed out (PF1, №2797-2). Transaction previews and other source overlays are
 * not layers: they may change under their callers. */
const pendingLayers = new WeakMap<object, PendingLayer>();
/**
 * The rows a bundle is about to write, readable before they are written (E4 pending calls, journal batches). The overlay
 * owns detached, deeply frozen copies of the rows behind a private index — the caller's objects are neither frozen nor
 * shared, and a later change to them leaves this snapshot as it was. Only `get` of a row's id, at its head or at its own
 * revision, is answered here; another revision, another id, an absence, list, history, identities and the writes go to
 * the base exactly as before, and later rows of one id replace earlier ones. Over a base with proved reads it is a frozen
 * object and a registered layer of that base (№2012-2); over anything else it stays an opaque Proxy, whose reads may reach
 * another source beneath it.
 */
export function pendingOverlay(base: Store, rows: readonly Revision<unknown>[]): Store {
  const owned = new Map<string, Revision<unknown>>();
  for (const row of rows) { const copy = structuredClone(row); deepFreeze(copy); owned.set(copy.id, copy); }
  // PF2 (№2905): only a registered layer reports what it answers itself; the opaque Proxy below keeps its old silence.
  let layer: Store | null = null;
  const get = <T,>(id: string, revision?: number): Revision<T> | null => {
    const row = owned.get(id);
    if (row && (revision === undefined || revision === row.revision)) { if (layer) pendingReads?.(layer, id, revision, row); return row as Revision<T>; }
    return base.get<T>(id, revision);
  };
  if (!provenSourceReads(base)) return new Proxy(base, { get(target, key) {
    if (key === 'get') return get;
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  const methods = Object.create(Store.prototype) as Store;
  const view = Object.create(methods) as Store;
  Object.defineProperty(view, 'path', { value: base.path });
  const bound = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(Store.prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(Store.prototype, name)!;
    if (descriptor.get) {
      Object.defineProperty(methods, name, { get: () => Reflect.get(base, name, base) });
      continue;
    }
    const member: unknown = Reflect.get(base, name, base);
    if (typeof member !== 'function') continue;
    // The reads a proof's events go through (get, list, history) are the ones a witness must still reach; a member the
    // base refuses afresh on every access (a write-only view's undeclared method) proves nothing either way.
    if (READ_METHODS.has(name)) bound.set(name, member);
    Object.defineProperty(methods, name, { value: name === 'get' ? get : member.bind(base) });
  }
  Object.freeze(methods);
  const overlay = Object.freeze(view) as Store;
  sourceOverlays.add(overlay);
  pendingLayers.set(overlay, { base, rows: owned, bound });
  layer = overlay;
  return overlay;
}
/**
 * PF2 (№2905): a read a pending layer answers from its own rows reaches no Store, so no Store reports it; the one
 * observer of such answers (the historical proofs) learns of it as a read of that very layer, never of its base.
 */
type PendingReads = (layer: Store, id: string, revision: number | undefined, row: Revision<unknown>) => void;
let pendingReads: PendingReads | null = null;
export function observePendingReads(next: PendingReads | null): PendingReads | null { const previous = pendingReads; pendingReads = next; return previous; }
/**
 * PF2 (№2905): the exact selections the chain of pending layers of a view answers itself — each row's id and revision
 * (a get of its head or of that revision), from the view down to the genuine Store it is proved to read through. Null
 * when any link is of unknown origin or its base no longer reads through the members it bound. Only the pairs are
 * handed out, a new frozen list: never a row, a body or a layer's own map.
 */
export function pendingSelections(view: unknown): readonly (readonly [string, number])[] | null {
  const found: (readonly [string, number])[] = [];
  for (let cursor = view; ;) {
    const layer = typeof cursor === 'object' && cursor !== null ? pendingLayers.get(cursor) : undefined;
    if (!layer) return provenStore(cursor) ? Object.freeze(found) : null;
    if ([...layer.bound].some(([name, member]) => Reflect.get(layer.base, name, layer.base) !== member)) return null;
    for (const row of layer.rows.values()) found.push(Object.freeze([row.id, row.revision] as const));
    cursor = layer.base;
  }
}
/** Whether a view is a pending layer this module built; nothing of the layer is handed out. */
export const pendingLayer = (view: unknown): boolean => typeof view === 'object' && view !== null && pendingLayers.has(view);
/** PF2 (№2932-1): whether a pending layer is one a view reads through — the view itself or a layer beneath it, down to
 * the first link that is no layer. Only the answer is handed out. */
export function pendingWithin(view: unknown, layer: unknown): boolean {
  for (let cursor = view; ;) {
    const found = typeof cursor === 'object' && cursor !== null ? pendingLayers.get(cursor) : undefined;
    if (!found) return false;
    if (cursor === layer) return true;
    cursor = found.base;
  }
}
/**
 * Who answers one read of a view (PF1, №2797-3): 'pending' when a layer answers it from its own frozen rows — a get of a
 * row's id at its head or own revision, decided by method, id and revision; otherwise the genuine Store that serves it
 * through a proved chain of pending layers and write-only views; null when any link is of unknown origin (a caller's
 * Proxy, a capture, a Transaction preview, a projection) or a base no longer reads through the members a layer bound.
 */
export function readServer(view: unknown, method: string, id: string | undefined, revision: number | undefined): Store | 'pending' | null {
  for (let cursor = view; ;) {
    const layer = typeof cursor === 'object' && cursor !== null ? pendingLayers.get(cursor) : undefined;
    if (!layer) return provenStore(cursor);
    if (method === 'get' && id !== undefined) {
      const row = layer.rows.get(id);
      if (row && (revision === undefined || row.revision === revision)) return 'pending';
    }
    if ([...layer.bound].some(([name, member]) => Reflect.get(layer.base, name, layer.base) !== member)) return null;
    cursor = layer.base;
  }
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
  // S1.1 (№1887-2): a view that intercepts ONLY the writes, directly over a plain Store or over such a view of this
  // module's own making, is not a Proxy: an opaque Proxy makes every proof read through it unrepeatable, so the same
  // history was derived again on each path. Its region stays separate; the raw Store is never handed out. A capture,
  // a read projection, a historicalTrace, an arbitrary Proxy or an unknown lower view keep the opaque Proxy below.
  if (!policy.get && !policy.capture && provenReads(target)) return writeOnlyView(target, policy, unsupported);
  const view: Store = new Proxy(target, {
    get(target, prop, _receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, target);
      if (prop === 'write')
        return <T,>(input: Write): Revision<T> => { noteWriteAttempt(target); return policy.write([input], [])[0] as Revision<T>; };
      if (prop === 'writeMany')
        return <T,>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] =>
          (noteWriteAttempt(target), policy.write(inputs, guards)) as Revision<T>[];
      if (prop === 'get' && policy.get)
        return (id: string, revision?: number) => {
          noteUntracedRead();
          const projected = policy.get!(id, revision);
          // Only undefined delegates to the nearest target; an explicit null is
          // the projection's own answer "no record in this view" (№1760-2).
          return projected === undefined ? target.get(id, revision) : projected;
        };
      if (READ_METHODS.has(prop)) {
        // An opaque view's reads are no proved family's (S1.4, №2395): whoever reads through it stays incomplete.
        const read = (Reflect.get(target, prop, target) as (...args: never[]) => unknown).bind(target);
        return (...args: never[]) => { noteUntracedRead(); return read(...args); };
      }
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
  Object.defineProperty(members, 'write', { value: <T,>(input: Write): Revision<T> => { noteWriteAttempt(target); return policy.write([input], [])[0] as Revision<T>; } });
  Object.defineProperty(members, 'writeMany', { value: <T,>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] =>
    (noteWriteAttempt(target), policy.write(inputs, guards)) as Revision<T>[] });
  const reads = new Map<string, unknown>();
  for (const name of READ_METHODS) {
    const method = Reflect.get(target, name, target) as (...args: never[]) => unknown;
    reads.set(name, method);
    Object.defineProperty(members, name, { value: method.bind(target) });
  }
  for (const name of READ_PROPERTIES) Object.defineProperty(members, name, { get: () => Reflect.get(target, name, target) });
  Object.freeze(members);
  const view = Object.freeze(Object.create(members)) as Store;
  writeOnlyViews.add(view);
  writeOnlyTargets.set(view, { target, reads });
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
      // The same form check Store.writeMany applies (Q5): a malformed guard is refused at capture, not at commit.
      const checkedGuards = checkTransactionGuards(callerGuards);
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
        for (const guard of checkedGuards)
          if ('absent' in guard)
            throw new EngineError('store_view_guard_unsupported',
              `This capture cannot carry the absent guard '${guard.id}'`, { id: guard.id });
      // Only now publish: accumulated writes keep the caller's exact expected;
      // input, returned Revision and the accumulated write share no mutable cell.
      guards.push(...checkedGuards);
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

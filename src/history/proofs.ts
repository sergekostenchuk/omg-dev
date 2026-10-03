import { isProxy } from "node:util/types";
import { canonical, digest, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { observeStore, Store, storeReads, type Revision } from "../storage/store.js";
import { pendingLayer, provenStore, readServer } from "../storage/store-view.js";
import { gitCalls } from "../runtime/environment.js";

/**
 * R5 (№2451): the common mechanism of historical reads — the operation scope, journals, observers, replay, footprints
 * and the proofs kept across operations (S1.3/S1.4) — below every reader that uses it. It imports nothing of OM, the
 * compiler or the product; om/input re-exports its former entries, so old and new imports reach these same functions and
 * this same state.
 */
type Row = Record<string, any>;
const object = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
// The argument checks keep the code, message and address they had in om/input (№2451-2).
function invalid(field: string): never {
  throw new EngineError("input_request_invalid", "OM input needs a well-formed request", { unit: "G1", target: "om-input", field });
}

export interface HistoricalReadKey { reader: string; project: string; ref: Ref; parameters?: Json }
type ReadObservation = { source: Store; method: 'get' | 'list' | 'history' | 'prefix'; id: string | undefined; revision: number | undefined; references: Ref[] };
/** `stamp`: the change stamp of the source's genuine Store under which `signature` is known to hold (S1.3), or null
 * when the source has no such Store. Events are shared by every enclosing journal, so one check serves them all.
 * `witness`: the genuine Store that served a read of a pending overlay through its proved layers (PF1, №2797-3) — only
 * the witness of the check; the event, its key and its replay stay the overlay's. */
type ReadEvent = ReadObservation & { signature: string; mutable: boolean; observations: ReadObservation[]; stamp: string | null; key?: string; witness?: Store;
  /** The signature covers the whole rows: the read came through a pending layer whose base has no proved chain. */
  bodies?: true };
/** `accounted`: physical Store reads this journal traced (its own and its nested proofs'); `complete`: every read of the
 * proof and of every proof nested in it was traced and none of them ran git — the only journal whose footprint is its
 * whole dependency area. */
interface ReadJournal {
  entries: (ReadEvent | ReadJournal)[]; sources: Set<Store>; footprint: ReadEvent[]; accounted: number; complete: boolean;
  /** A write was attempted or an opaque view answered while this proof ran (S1.4, №2302-2, №2395); change stamps its observed Stores had before their reads;
   * the Stores those reads came from — apart from `sources`, which decide replay through a view and never see them. */
  tainted: boolean; stamps: Map<Store, string | null>; stores: Set<Store>;
  /** PF1 (№2827): the pending layers this proof or a nested one read through, each with the witness its delegated reads
   * had — exact ones included, which no footprint holds — and the trusted recovery snapshots it read (null). Any reuse
   * needs every one of these chains intact. */
  chains: Map<Store, Store | null>;
  /** PF1 (№2846): the read methods each delegated read actually invoked, by the object it was invoked on, taken before the
   * read; a reuse resolves them the same way and needs the very same functions. Never overwritten: one object and method
   * seen with two functions is a `conflict`, and such a proof is not reused as one derived under one unchanged chain. */
  methods: Map<object, Map<string, unknown>>; conflict: boolean;
  /** A listed reader over the proven family of a genuine Store: its closure reads are observed (S1.4, №2410). */
  observing: boolean;
}
interface HistoricalProof { value: unknown; events: ReadJournal; footprint: ReadEvent[]; complete: boolean }
interface HistoricalView { active: Set<string>; proven: Map<string, HistoricalProof> }
interface HistoricalTrace { source: Store; observe: ((ref: Ref, head: boolean, method: ReadEvent['method']) => void) | undefined; mode: 'ordered' | 'distinct'; seen: Set<string>; journals: WeakSet<ReadJournal> }
const historicalTraces = new WeakMap<Store, HistoricalTrace>();
// Only internally constructed, frozen overlays qualify; an arbitrary Proxy has no snapshot guarantee.
const historicalSnapshots = new WeakSet<Store>();
let historicalViews: WeakMap<Store, HistoricalView> | null = null;
let proofCaptures: ReadJournal[] = [];
let readStack: ReadObservation[][] = [];
let checkingFootprint = 0;
let proofStarts = 0;
function synchronous<T>(action: () => T): T {
  if (typeof action !== "function") invalid("history.action");
  const result = action();
  if (result !== null && (typeof result === "object" || typeof result === "function")
    && typeof (result as { then?: unknown }).then === "function") invalid("history.async");
  return result;
}
function sourceView(store: Store): Store {
  for (;;) { const trace = historicalTraces.get(store); if (!trace) return store; store = trace.source; }
}
/** One identity of a source in proof keys, events and replay (№2194-3): the genuine Store beneath proven write-only
 * views, whose reads are exactly its reads; any other source keeps its own identity. */
function sourceIdentity(store: Store): Store {
  const source = sourceView(store);
  return provenStore(source) ?? source;
}
/**
 * S1.3 (№2185-4, №2194): proofs kept across the operations of one genuine Store instance. One H1 transition runs many
 * operations, and each used to derive the same exact histories again. Only a complete, successful, cacheable proof
 * whose every read came from that Store, and whose value is plain data, is kept; every reuse re-checks its footprint
 * (change stamp, identities). A frozen value is shared; any other is handed out as an independent copy, so no later
 * operation receives an object another may change. Bounded; a new Store or a restart starts cold.
 */
const RETAINED_LIMIT = 512;
const retainedProofs = new WeakMap<Store, Map<string, HistoricalProof & { frozen: boolean }>>();
/** Plain data only — no functions, symbols, accessors or instances whose state a copy would not carry. */
function plainValue(value: unknown, frozen: { all: boolean }, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function' && typeof value !== 'symbol';
  if (seen.has(value)) return true;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (!Object.isFrozen(value)) frozen.all = false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key === 'symbol' || !('value' in descriptor) || !plainValue(descriptor.value, frozen, seen)) return false;
  }
  return true;
}
function retainedArea(source: Store): Map<string, HistoricalProof & { frozen: boolean }> | null {
  if (provenStore(source) !== source) return null;
  let area = retainedProofs.get(source);
  if (!area) { area = new Map(); retainedProofs.set(source, area); }
  return area;
}
function traceObservers(store: Store): HistoricalTrace[] {
  const observers: HistoricalTrace[] = [];
  for (;;) {
    const trace = historicalTraces.get(store); if (!trace) return observers.reverse();
    if (trace.observe) observers.push(trace);
    store = trace.source;
  }
}
function observeReference(trace: HistoricalTrace, ref: Ref, head: boolean, method: ReadEvent['method']): void {
  if (trace.mode === 'distinct') {
    const key = canonical([ref, head, method]);
    if (trace.seen.has(key)) return;
    trace.seen.add(key);
  }
  trace.observe?.({ ...ref }, head, method);
}
function recordRead(event: ReadEvent | ReadJournal): void {
  if (!checkingFootprint) proofCaptures.at(-1)?.entries.push(event);
}
function readSignature(source: Store, records: readonly Revision<unknown>[], bodies = false): string {
  return digest(canonical(bodies || isProxy(source) && !historicalSnapshots.has(source) ? records : records.map(row => ({ ...reference(row), kind: row.kind }))));
}
function noteMethod(journal: ReadJournal, holder: object, name: string, invoked: unknown): void {
  let names = journal.methods.get(holder);
  if (!names) { names = new Map(); journal.methods.set(holder, names); }
  if (!names.has(name)) names.set(name, invoked);
  else if (names.get(name) !== invoked) journal.conflict = true;
}
/** PF1 (№2827): every pending layer a proof read through still reaches the witness its reads had, and every trusted
 * recovery snapshot still reads through the very members of the base it was trusted over. */
function chainsIntact(journal: ReadJournal): boolean {
  if (journal.conflict) return false;
  for (const [holder, names] of journal.methods)
    for (const [name, invoked] of names) if (Reflect.get(holder, name, holder) !== invoked) return false;
  for (const [view, witness] of journal.chains)
    if (witness === null ? !snapshotIntact(view) : readServer(view, 'list', undefined, undefined) !== witness) return false;
  return true;
}
/**
 * S1.4 (№2410, C1/C2): the readers whose untraced action is observed at the Store and may be kept on that observation.
 * Each was audited: its action reads only the Store it was given as root (directly or through the common readers it
 * calls with that Store) and values derived from its key — no overlay, preview, projection or other Store captured from
 * outside, no file, environment, clock or randomness; git is counted (№2217). An overlay a reader builds inside its
 * action from those values is rebuilt by every derivation. Every other historicalRead keeps the S1.3 semantics: a
 * closure read is not accounted and the proof is not kept beyond its operation.
 */
const OBSERVED_READERS: ReadonlySet<string> = new Set([
  'G7.completion-assignment', 'G7.completion-work', 'G7.completion-cessation', 'G7.completion-owner', 'G7.completion-close',
  'G7.answers-assignment', 'A3.series-history', 'A3.3.full-gaps', 'A3.3.mechanism-slice', 'A3.3.mechanism-admission',
  'E2.question-packet', 'E4.model-call-state', 'M6.route-result',
]);
/**
 * S1.4 (№2302): the Store's own implementation reports every completed read and every write attempt, so a proof whose
 * action reads a closure-captured Store journals those reads too. A read inside a traced read is that read's own; a read
 * checking a footprint is only accounted, never a new dependency. Such an event carries no observation: a cold action
 * reading around a trace shows it nothing, and neither does its replay (№2302-4).
 */
observeStore({
  begin(store) {
    const capture = historicalViews && !readStack.length ? proofCaptures.at(-1) : undefined;
    // Checking a footprint is accounted for any proof; a closure read only for an observed reader (C1/C2).
    if (!capture || !(checkingFootprint || capture.observing)) return undefined;
    // Taken before the first read: a commit after it can only make the stamp older, never mask a change.
    if (capture && !checkingFootprint && !capture.stamps.has(store)) capture.stamps.set(store, provenStore(store) === store ? store.changeStamp() : null);
    return capture;
  },
  end(token, store, _method, mode, id, revision, rows) {
    const capture = token as ReadJournal;
    capture.accounted++;
    if (checkingFootprint) return;
    // Identities carry the same {id, revision, hash, kind} a genuine source's signature is made of.
    const records = rows as Revision<unknown>[];
    capture.entries.push({ source: store, method: mode, id, revision, references: records.map(reference), observations: [],
      stamp: capture.stamps.get(store) ?? null, signature: readSignature(store, records),
      mutable: mode !== 'get' || revision === undefined || !records.length });
  },
  write() { for (const capture of proofCaptures) capture.tainted = true; },
  // An opaque view answered (№2395): every enclosing proof is incomplete; checking a footprint is no such read.
  untraced() { if (!checkingFootprint) for (const capture of proofCaptures) capture.tainted = true; },
});
function observedRead<T>(store: Store, method: ReadEvent['method'], id: string | undefined, revision: number | undefined, action: () => T): T {
  // Taken before the read: a commit between the stamp and the read can only make the stamp older, never mask a change.
  const recorded = !readStack.length && !checkingFootprint && historicalViews !== null && proofCaptures.length > 0;
  // PF1 (№2797-3): a row a pending layer answers from its own frozen rows is constant for that overlay; any other read is
  // witnessed by the genuine Store that serves it through proved layers, or by none.
  const served = recorded ? readServer(sourceView(store), method, id, revision) : null;
  const witness = served === 'pending' ? null : served;
  const stamp = witness?.changeStamp() ?? null;
  // №2846: the function a delegated read invokes, and the object it is invoked on, fixed before the read — the witness
  // beneath a trusted layer, or the source a trusted recovery snapshot delegates to.
  const delegate = !recorded ? null : pendingLayer(sourceView(store)) && witness ? witness
    : snapshotBases.get(sourceView(store)) ?? null;
  const invoked = delegate ? Reflect.get(delegate, method, delegate) : undefined;
  const outermost = !readStack.length, reads = storeReads(), starts = proofStarts;
  const observations: ReadObservation[] = []; readStack.push(observations);
  let value: T;
  try { value = action(); } finally {
    readStack.pop();
    // A proof run inside this read accounts for itself; then this read's own count is left unaccounted (never twice).
    const capture = outermost && !checkingFootprint && proofStarts === starts ? proofCaptures.at(-1) : undefined;
    if (capture) capture.accounted += storeReads() - reads;
  }
  const records = (method === 'get' ? value === null ? [] : [value] : value) as Revision<unknown>[];
  const refs = records.map(reference), source = sourceIdentity(store);
  const trace = historicalTraces.get(store)!;
  if (!checkingFootprint && trace.observe) for (const ref of refs) observeReference(trace, ref, method === 'get' && revision === undefined, method);
  // Transparent wrappers observe one call; an opaque view may answer without reaching its source collector.
  const child = observations.at(-1);
  if (!child || child.source !== source || child.method !== method || child.id !== id || child.revision !== revision)
    observations.push({ source, method, id, revision, references: refs });
  if (readStack.length) readStack.at(-1)!.push(...observations);
  else if (!checkingFootprint && historicalViews && proofCaptures.length) {
    // A read a layer delegated without a proved chain is an unknown projection: whole rows, always checked (№2827).
    const layer = pendingLayer(sourceView(store)), bodies = layer && served === null;
    if (layer && witness && witness !== source) proofCaptures.at(-1)!.chains.set(source, witness);
    if (snapshotBases.has(source)) proofCaptures.at(-1)!.chains.set(source, null);
    if (delegate) noteMethod(proofCaptures.at(-1)!, delegate, method, invoked);
    recordRead({ source, method, id, revision, references: refs, observations, stamp, ...(witness && witness !== source ? { witness } : {}),
      ...(bodies ? { bodies: true as const } : {}), signature: readSignature(source, records, bodies), mutable: served !== 'pending'
        && (bodies || isProxy(source) && !historicalSnapshots.has(source) || method !== 'get' || revision === undefined || value === null) });
  }
  return value;
}
/** Construct, rather than trust a claim about, a transparent source view. Opaque/pending views keep their identity. */
export function historicalTrace(store: Store, observe?: (ref: Ref, head: boolean, method: ReadEvent['method']) => void,
  mode: 'ordered' | 'distinct' = 'ordered'): Store {
  if (!(store instanceof Store) || (observe !== undefined && typeof observe !== 'function') || !['ordered', 'distinct'].includes(mode)) invalid('history.trace');
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get') return <T>(id: string, revision?: number): Revision<T> | null =>
      observedRead(view, 'get', id, revision, () => target.get<T>(id, revision));
    if (key === 'list') return <T>(kind?: string): Revision<T>[] => observedRead(view, 'list', kind, undefined, () => target.list<T>(kind));
    if (key === 'history') return <T>(id: string): Revision<T>[] => observedRead(view, 'history', id, undefined, () => target.history<T>(id));
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  historicalTraces.set(view, { source: store, observe, mode, seen: new Set(), journals: new WeakSet() });
  return view;
}
function completeJournal(journal: ReadJournal): void {
  const checked = new WeakMap<Store, Set<string>>();
  const remember = (event: ReadEvent) => {
    let keys = checked.get(event.source); if (!keys) { keys = new Set(); checked.set(event.source, keys); }
    const key = event.key ??= canonical([event.method, event.id ?? null, event.revision ?? null, event.signature]);
    if (!keys.has(key)) { keys.add(key); journal.footprint.push(event); }
  };
  // Child journals are already complete. Repeated edges retain multiplicity without copying their leaves.
  const children = new Set<ReadJournal>();
  for (const entry of journal.entries) {
    if ('entries' in entry) {
      if (children.has(entry)) continue;
      children.add(entry);
      for (const source of entry.sources) journal.sources.add(source);
      for (const store of entry.stores) journal.stores.add(store);
      for (const [layer, witness] of entry.chains) journal.chains.set(layer, witness);
      if (entry.conflict) journal.conflict = true;
      for (const [holder, names] of entry.methods) for (const [name, invoked] of names) noteMethod(journal, holder, name, invoked);
      for (const event of entry.footprint) remember(event);
    } else {
      if (!entry.observations.length) journal.stores.add(entry.source);
      for (const observation of entry.observations) journal.sources.add(observation.source);
      if (entry.mutable) remember(entry);
    }
  }
}
/**
 * S1.3 (№2185): a dependency of a genuine Store is read again only when that Store's change stamp moved since the
 * dependency was last proved, and then only as identities — the same rows, never decoded. A proved event keeps its new
 * stamp, so a dependency shared by nested proofs is checked once per change, not once per path through the proof tree.
 * Sources without a genuine Store or a witness (captures, subclasses, arbitrary views) keep the full read below.
 */
function currentFootprint(footprint: readonly ReadEvent[]): boolean {
  checkingFootprint++;
  const stamps = new Map<Store, string>();
  try {
    for (const event of footprint) {
      // A witnessed event of an overlay is checked at its witness only while the same proved layers still lead there; a
      // broken chain is no current source at all, never a weaker check of what an unknown view now answers (№2827).
      if (event.witness && readServer(event.source, event.method, event.id, event.revision) !== event.witness) return false;
      if (snapshotBases.has(event.source) && !snapshotIntact(event.source)) return false;
      const genuine = event.stamp === null ? null : event.witness ?? provenStore(event.source);
      if (genuine) {
        let now = stamps.get(genuine);
        // A Store closed since (S1.4: an observed closure read of another Store) is no current source: derive again.
        try {
          if (now === undefined) { now = genuine.changeStamp(); stamps.set(genuine, now); }
          if (event.stamp === now) continue;
          if (digest(canonical(genuine.identities(event.method, event.id, event.revision))) !== event.signature) return false;
        } catch { return false; }
        event.stamp = now;
        continue;
      }
      const records = event.method === 'get' ? (() => { const row = event.source.get<unknown>(event.id!, event.revision); return row ? [row] : []; })()
        : event.method === 'list' ? event.source.list<unknown>(event.id)
        : event.method === 'prefix' ? event.source.identities('prefix', event.id!) as unknown as Revision<unknown>[]
        : event.source.history<unknown>(event.id!);
      if (readSignature(event.source, records, event.bodies) !== event.signature) return false;
    }
    return true;
  } finally { checkingFootprint--; }
}
function replayProof(store: Store, events: ReadJournal): void {
  const source = sourceIdentity(store), observers = traceObservers(store);
  const replay = (journal: ReadJournal, active: HistoricalTrace[]): void => {
    if (!journal.sources.has(source)) return;
    const collecting = active.filter(trace => trace.mode === 'ordered' || !trace.journals.has(journal));
    if (!collecting.length) return;
    for (const trace of collecting) if (trace.mode === 'distinct') trace.journals.add(journal);
    for (const entry of journal.entries) {
      if ('entries' in entry) replay(entry, collecting);
      else for (const observation of entry.observations) if (observation.source === source)
        for (const trace of collecting) for (const ref of observation.references)
          observeReference(trace, ref, observation.method === 'get' && observation.revision === undefined, observation.method);
    }
  };
  // Ordered observers receive the full stream; declared sets visit shared subproofs only once.
  if (observers.length) replay(events, observers);
  recordRead(events);
}
/** Share exact proofs for one synchronous product operation; heads and current admission stay fresh. */
export function withHistoricalReads<T>(action: () => T): T {
  if (historicalViews) return synchronous(action);
  historicalViews = new WeakMap();
  try { return synchronous(action); }
  finally { historicalViews = null; proofCaptures = []; }
}
function useHistoricalProof<T>(store: Store, key: HistoricalReadKey, action: (source: Store) => T,
  onCycle: () => T, cacheable: (value: T) => boolean, traced: boolean): T {
  if (!(store instanceof Store) || !object(key) || !text(key.reader) || !text(key.project) || !isRef(key.ref)
    || typeof action !== 'function' || typeof onCycle !== 'function' || typeof cacheable !== 'function') invalid('history');
  const exact = canonical(key);
  return withHistoricalReads(() => {
    const views = historicalViews!, source = sourceIdentity(store);
    let view = views.get(source);
    if (!view) { view = { active: new Set(), proven: new Map() }; views.set(source, view); }
    if (view.active.has(exact)) return synchronous(onCycle);
    const area = retainedArea(source), kept = view.proven.has(exact) ? undefined : area?.get(exact);
    // A traced caller replays a proof to its observers; one derived through a closure read shows them nothing (S1.4).
    if (kept && (!(traced || historicalTraces.has(store)) || kept.complete)) {
      // Another operation proved it: it serves this one only while its whole footprint is current.
      area!.delete(exact);
      if (chainsIntact(kept.events) && currentFootprint(kept.footprint)) {
        area!.set(exact, kept);
        const adopted = { ...kept, value: kept.frozen ? kept.value : structuredClone(kept.value) };
        view.proven.set(exact, adopted);
        replayProof(store, adopted.events);
        return adopted.value as T;
      }
    }
    const complete = traced || historicalTraces.has(store), previous = view.proven.get(exact);
    // An untraced action is observed at the Store (S1.4, №2302, №2410): only a listed reader over the proven family of a
    // genuine Store; every other one keeps the S1.3 semantics.
    const observing = OBSERVED_READERS.has(key.reader) && provenStore(source) === source, observable = complete || observing;
    if (previous && (!complete || previous.complete)) {
      if (chainsIntact(previous.events) && currentFootprint(previous.footprint)) { replayProof(store, previous.events); return previous.value as T; }
      // A proof of a genuine Store is checked on its own at every use, so only the moved one goes (S1.3). A mutable opaque
      // view now exposes another snapshot: no proof of its previous snapshot survives.
      if (area) view.proven.delete(exact);
      else view.proven.clear();
    }
    view.active.add(exact);
    const events: ReadJournal = { entries: [], sources: new Set(), footprint: [], accounted: 0, complete: false, tainted: false, stamps: new Map(), stores: new Set(), chains: new Map(), methods: new Map(), conflict: false, observing };
    proofCaptures.push(events);
    const reads = storeReads(), gits = gitCalls(); proofStarts++;
    let completed = false;
    try {
      const result = synchronous(() => action(traced ? historicalTrace(store) : store));
      // Replaying through an opaque forwarding view must not bypass collectors hidden behind that view.
      completeJournal(events); completed = true;
      // Complete only if every physical read of this action was traced, it ran no git (№2217) and every nested journal —
      // derived here or taken from a cache — is complete too (№2201): a dependency outside the Store travels to every parent.
      events.complete = observable && !events.tainted && storeReads() - reads === events.accounted && gitCalls() === gits
        && events.entries.every(entry => !('entries' in entry) || entry.complete);
      const replayable = !isProxy(source) || [...events.sources].every(observed => observed === source);
      if (replayable && !(object(result) && result.ok === false) && cacheable(result)) {
        const proof = { value: result, events, footprint: events.footprint, complete };
        view.proven.set(exact, proof);
        // Kept beyond this operation only with its full dependency area: a complete journal of this Store alone — never on
        // an empty trail, which proves no dependency at all, only that none reached the Store (№2302, card).
        const frozen = { all: true };
        if (area && events.complete && events.entries.length > 0 && [...events.sources].every(observed => observed === source)
          && [...events.stores].every(observed => observed === source) && plainValue(result, frozen)) {
          area.set(exact, { ...proof, value: frozen.all ? result : structuredClone(result), frozen: frozen.all });
          for (const oldest of area.keys()) { if (area.size <= RETAINED_LIMIT) break; area.delete(oldest); }
        }
      }
      return result;
    } finally {
      if (!completed) completeJournal(events);
      proofCaptures.pop(); recordRead(events); view.active.delete(exact);
      // The parent's own count includes these reads; what this proof traced is traced for the parent as well.
      const parent = proofCaptures.at(-1);
      if (parent) parent.accounted += events.accounted;
    }
  });
}
/** Existing historical readers retain their interface; traced callers also retain their dependency journal. */
export function historicalRead<T>(store: Store, key: HistoricalReadKey, action: () => T,
  onCycle: () => T, cacheable: (value: T) => boolean = value => !(object(value) && value.ok === false)): T {
  return useHistoricalProof(store, key, action, onCycle, cacheable, false);
}
/** The callback uses this source for every read, so even a cold proof records its full transitive dependencies. */
export function historicalProof<T>(store: Store, key: HistoricalReadKey, action: (source: Store) => T,
  onCycle: () => T, cacheable: (value: T) => boolean = value => !(object(value) && value.ok === false)): T {
  return useHistoricalProof(store, key, action, onCycle, cacheable, true);
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  Object.freeze(value);
}
/**
 * A pending view of exact rows over a Store for a recovery's own derivation (№2451-3). The view owns its map of deeply
 * frozen copies of the rows (R5 return №2471); it is a trusted immutable snapshot only over a source that already is one — a genuine Store or another such
 * snapshot — and every other read falls through to that source. No caller can mark an arbitrary Proxy as trusted.
 */
export function pendingSnapshotView(store: Store, rows: readonly Revision<unknown>[]): Store {
  // A deep own copy, frozen at every level: no reference into the caller's rows, and the caller's objects stay its own.
  const pending = new Map(rows.map(row => { const owned = structuredClone(row); deepFreeze(owned); return [owned.id, owned]; }));
  const view = new Proxy(store, { get(target, property) {
    if (property === "get") return <T = Json>(id: string, revision?: number): Revision<T> | null => {
      const row = pending.get(id);
      return row && (revision === undefined || row.revision === revision) ? row as Revision<T> : target.get<T>(id, revision);
    };
    const member: unknown = Reflect.get(target, property, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
  // This map is complete before use and never changes. Exact fallback reads are immutable only for a known source, and
  // only while that source is still a proved one (PF1, №2827): the view reads through it afresh on every call.
  const base = sourceView(store);
  if (!isProxy(base) || historicalSnapshots.has(base)) { historicalSnapshots.add(view); snapshotBases.set(view, store); }
  return view;
}
const snapshotBases = new WeakMap<Store, Store>();
/** A trusted recovery snapshot still stands over a proved source: a genuine Store as it is now (an own replaced read
 * makes it none), a write-only view still bound to its reads, a pending layer with its chain, or such a snapshot (№2827). */
function snapshotIntact(view: Store): boolean {
  const stored = snapshotBases.get(view);
  if (!stored) return false;
  const base = sourceView(stored);
  if (snapshotBases.has(base)) return snapshotIntact(base);
  return pendingLayer(base) ? readServer(base, 'list', undefined, undefined) !== null : provenStore(base) !== null;
}

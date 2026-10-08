import { isProxy } from "node:util/types";
import { canonical, digest, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { observeStore, Store, storeReads, type Revision } from "../storage/store.js";
import { observePendingReads, pendingLayer, pendingSelections, pendingWithin, provenStore, readServer } from "../storage/store-view.js";
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
  bodies?: true;
  /** PF2 (№2905): a pending layer answered this read from its own rows — constant for that layer, never its base's. */
  pending?: true };
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
  /** PF3.1 (№3459 §4): a cycle answered by onCycle while this proof or a nested one ran — whatever an action made of that
   * answer, a refusal of such a derivation is never kept. */
  cyclic: boolean;
  /** PF2 (№2905): the proved pending layer this proof observes its closure reads through. */
  layer: Store | null;
  /** PF2 (№2932-1): the pending layer this proof is derived at, whose own answers — and those of every layer beneath it —
   * the proof records whoever reads them; null at any other source. */
  root: Store | null;
  /** PF2 (№2932-2): the source this journal's observations are labelled for — where it was derived, or the receiver of an
   * adopted proof. `alias`: for an adoption, the home of the adopted journal, whose observations are the receiver's. */
  home: Store | null; alias?: Store;
}
interface HistoricalProof { value: unknown; events: ReadJournal; footprint: ReadEvent[]; complete: boolean }
interface HistoricalView { active: Set<string>; proven: Map<string, HistoricalProof> }
/** `journals`: for a declared set, the journals already replayed to it, each with the sources it was replayed for. */
interface HistoricalTrace { source: Store; observe: ((ref: Ref, head: boolean, method: ReadEvent['method']) => void) | undefined; mode: 'ordered' | 'distinct'; seen: Set<string>; journals: WeakMap<ReadJournal, Set<Store>> }
const historicalTraces = new WeakMap<Store, HistoricalTrace>();
// Only internally constructed, frozen overlays qualify; an arbitrary Proxy has no snapshot guarantee.
const historicalSnapshots = new WeakSet<Store>();
let historicalViews: WeakMap<Store, HistoricalView> | null = null;
/** PF2 (№2905): proofs derived through a layer that are its base's, offered to the base's other layers — in this operation
 * and kept across operations — apart from the base's own views, whose proofs and retention keep their old rules. */
let sharedProofs: WeakMap<Store, Map<string, HistoricalProof & { frozen: boolean }>> | null = null;
const sharedRetained = new WeakMap<Store, Map<string, HistoricalProof & { frozen: boolean }>>();
let proofCaptures: ReadJournal[] = [];
let readStack: ReadObservation[][] = [];
/** PF3.1 (№3459 §3): beside each frame of readStack, the physical Store reads that proofs started inside that traced read
 * made and accounted for themselves; the read counts only the rest as its own (never twice, №2201). */
let readCredits: number[] = [];
/** PF3.1 (№3473): the read each frame of readStack performs. A nested read of another record — another method, id or
 * revision — is a dependency of its own, recorded as its own event where it happened; only the same read seen through
 * one more trace folds into the frame that encloses it. */
let readFrames: { method: ReadEvent['method']; id: string | undefined; revision: number | undefined }[] = [];
let checkingFootprint = 0;
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
  // PF3.1 (№3459 §2): audited the same way — each reads its root Store through the common historical readers and values
  // derived from its key; a file, a workspace scope or a current admission is reached only on a current branch outside
  // the cached action (D5 citations project the saved source as an owner document; E4 replays saved deliveries; a saved
  // packet replays its carried readings; a research assessment replays its captured file snapshots).
  'D5.citation', 'E4.continuation', 'E4.part-assembly', 'G7.completion-reuse', 'G7.completion-finalization',
  'G7.completion-effective', 'G4b.answers', 'G4b.registration', 'G4b.evaluation', 'G4b.finding', 'G4b.refusal',
  'E2.works-basis', 'E2.works-proposal-content', 'E2.part-result', 'D7.obligations', 'A3.progress-transition',
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
/**
 * PF2 (№2905, №2932-1): a closure read that a layer answers from its own rows is an exact event of that layer — constant
 * for it, no dependency of its base, and the end of any claim that the proof is its base's — when that layer is one a
 * proof being derived reads through: its root or a layer beneath it, of this proof or of one enclosing it. The innermost
 * proof records it, and every enclosing one inherits it. A layer a reader builds inside its action is rebuilt by every
 * derivation (S1.4) and stays as silent as before; a read inside a traced read is that read's own.
 */
observePendingReads((layer, id, revision, row) => {
  const capture = historicalViews && !readStack.length && !checkingFootprint ? proofCaptures.at(-1) : undefined;
  if (!capture || !proofCaptures.some(open => open.root !== null && pendingWithin(open.root, layer))) return;
  capture.entries.push({ source: layer, method: 'get', id, revision, references: [reference(row)], observations: [], stamp: null,
    signature: readSignature(layer, [row]), mutable: false, pending: true });
});
function observedRead<T>(store: Store, method: ReadEvent['method'], id: string | undefined, revision: number | undefined, action: () => T): T {
  // Taken before the read: a commit between the stamp and the read can only make the stamp older, never mask a change.
  const enclosing = readFrames.at(-1);
  const distinct = !enclosing || enclosing.method !== method || enclosing.id !== id || enclosing.revision !== revision;
  const recorded = distinct && !checkingFootprint && historicalViews !== null && proofCaptures.length > 0;
  // PF1 (№2797-3): a row a pending layer answers from its own frozen rows is constant for that overlay; any other read is
  // witnessed by the genuine Store that serves it through proved layers, or by none.
  const served = recorded ? readServer(sourceView(store), method, id, revision) : null;
  const witness = served === 'pending' ? null : served;
  const stamp = witness?.changeStamp() ?? null;
  // №2846: the function a delegated read invokes, and the object it is invoked on, fixed before the read — the witness
  // beneath a trusted layer, or the source a trusted recovery snapshot delegates to.
  const delegate = !recorded ? null : pendingLayer(sourceView(store)) && witness ? witness : snapshotDelegate(sourceView(store));
  const invoked = delegate ? Reflect.get(delegate, method, delegate) : undefined;
  const outermost = !readStack.length, reads = storeReads();
  const observations: ReadObservation[] = []; readStack.push(observations); readCredits.push(0); readFrames.push({ method, id, revision });
  let value: T;
  try { value = action(); } finally {
    readStack.pop(); readFrames.pop();
    // PF3.1 (№3459 §3): a proof run inside this read has accounted for its own reads in its own journal, which its parent
    // inherits; this read accounts for the rest — its own reads — once. The credit travels to an enclosing read.
    const credit = readCredits.pop()!;
    if (readCredits.length) readCredits[readCredits.length - 1]! += credit;
    const capture = outermost && !checkingFootprint ? proofCaptures.at(-1) : undefined;
    if (capture) capture.accounted += storeReads() - reads - credit;
  }
  const records = (method === 'get' ? value === null ? [] : [value] : value) as Revision<unknown>[];
  const refs = records.map(reference), source = sourceIdentity(store);
  const trace = historicalTraces.get(store)!;
  if (!checkingFootprint && trace.observe) for (const ref of refs) observeReference(trace, ref, method === 'get' && revision === undefined, method);
  // Transparent wrappers observe one call; an opaque view may answer without reaching its source collector.
  const child = observations.at(-1);
  if (!child || child.source !== source || child.method !== method || child.id !== id || child.revision !== revision)
    observations.push({ source, method, id, revision, references: refs });
  if (!distinct) readStack.at(-1)!.push(...observations);
  else if (!checkingFootprint && historicalViews && proofCaptures.length) {
    // A read a layer delegated without a proved chain is an unknown projection: whole rows, always checked (№2827).
    const layer = pendingLayer(sourceView(store)), bodies = layer && served === null;
    if (layer && witness && witness !== source) proofCaptures.at(-1)!.chains.set(source, witness);
    if (snapshotBases.has(source)) proofCaptures.at(-1)!.chains.set(source, null);
    if (delegate) noteMethod(proofCaptures.at(-1)!, delegate, method, invoked);
    recordRead({ source, method, id, revision, references: refs, observations, stamp, ...(witness && witness !== source ? { witness } : {}),
      ...(bodies ? { bodies: true as const } : {}), ...(served === 'pending' ? { pending: true as const } : {}),
      signature: readSignature(source, records, bodies), mutable: served !== 'pending'
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
  historicalTraces.set(view, { source: store, observe, mode, seen: new Set(), journals: new WeakMap() });
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
      if (entry.cyclic) journal.cyclic = true;
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
  const observers = traceObservers(store);
  const replay = (journal: ReadJournal, active: HistoricalTrace[], source: Store): void => {
    if (!journal.sources.has(source)) return;
    const collecting = active.filter(trace => trace.mode === 'ordered' || !trace.journals.get(journal)?.has(source));
    if (!collecting.length) return;
    for (const trace of collecting) if (trace.mode === 'distinct') {
      let sources = trace.journals.get(journal);
      if (!sources) { sources = new Set(); trace.journals.set(journal, sources); }
      sources.add(source);
    }
    // PF2 (№2932-2): within an adoption, what the adopted proof observed at its home is what this source observes.
    const within = journal.alias && journal.home === source ? journal.alias : source;
    for (const entry of journal.entries) {
      if ('entries' in entry) replay(entry, collecting, within);
      else for (const observation of entry.observations) if (observation.source === within)
        for (const trace of collecting) for (const ref of observation.references)
          observeReference(trace, ref, observation.method === 'get' && observation.revision === undefined, observation.method);
    }
  };
  // Ordered observers receive the full stream; declared sets visit shared subproofs only once.
  if (observers.length) replay(events, observers, sourceIdentity(store));
  recordRead(events);
}
/**
 * PF2 (№2932-2): the journal a receiver keeps for a proof adopted from another source — the adopted journal itself under
 * one more link that reads its home as the receiver. Each read of the adopted proof went through its home to the base that
 * also serves the receiver (servesBase), so the receiver's cold derivation would observe the very same references, heads
 * and methods in the same order. Recorded in a parent, replayed now or later, adopted further: every observer gets the
 * stream a cold derivation at the receiver gives. One link per journal and receiver.
 */
const adoptions = new WeakMap<ReadJournal, WeakMap<Store, ReadJournal>>();
function adoptedJournal(events: ReadJournal, receiver: Store): ReadJournal {
  if (events.home === receiver || events.home === null) return events;
  let links = adoptions.get(events);
  if (!links) { links = new WeakMap(); adoptions.set(events, links); }
  let link = links.get(receiver);
  if (!link) {
    link = { entries: [events], sources: new Set([...events.sources].map(source => source === events.home ? receiver : source)),
      footprint: events.footprint, accounted: 0, complete: events.complete, tainted: events.tainted, stamps: events.stamps,
      stores: events.stores, chains: events.chains, methods: events.methods, conflict: events.conflict, observing: events.observing,
      cyclic: events.cyclic, layer: null, root: null, home: receiver, alias: events.home };
    links.set(receiver, link);
  }
  return link;
}
/**
 * PF2 (№2905): the genuine Store a view's reads are proved to reach through its pending layers — for a registered layer
 * only (a genuine Store and its write-only views already are that Store's own identity).
 */
function layerBase(source: Store): Store | null {
  if (!pendingLayer(source)) return null;
  const server = readServer(source, 'list', undefined, undefined);
  return server instanceof Store ? server : null;
}
/** PF2 (№2905): what served every read of a completed journal, transitively: `pending` when a layer answered any of them
 * from its own rows; otherwise the one genuine Store that served them all, null when any came from elsewhere (another
 * Store, an unknown projection, a snapshot, a view with no proved chain). A completed journal never changes. */
const provenances = new WeakMap<ReadJournal, { pending: boolean; server: Store | null | undefined }>();
function provenance(journal: ReadJournal): { pending: boolean; server: Store | null | undefined } {
  const known = provenances.get(journal);
  if (known) return known;
  const found: { pending: boolean; server: Store | null | undefined } = { pending: false, server: undefined };
  const serve = (server: Store | null | undefined) => {
    if (server !== undefined) found.server = found.server === undefined || found.server === server ? server : null;
  };
  for (const entry of journal.entries) {
    if ('entries' in entry) { const child = provenance(entry); if (child.pending) found.pending = true; serve(child.server); }
    else if (entry.pending) found.pending = true;
    else serve(entry.bodies ? null : entry.witness ?? (provenStore(entry.source) === entry.source ? entry.source : null));
  }
  provenances.set(journal, found);
  return found;
}
/**
 * PF2 (№2905): a proof that is its base's — complete, non-empty, without conflicting functions, no read a layer answered
 * itself, every read served by that one genuine Store and every chain leading to it — and the
 * exact get selections (id → head or revisions, absences included) a receiver's own rows must not answer. Built once
 * per journal; every other proof keeps its old local scope.
 */
const shareable = new WeakMap<ReadJournal, Map<string, Set<number | null>> | null>();
function baseSelections(events: ReadJournal, base: Store): Map<string, Set<number | null>> | null {
  const origin = provenance(events);
  if (origin.server !== base) return null;
  if (shareable.has(events)) return shareable.get(events)!;
  // An adoption link reads exactly what the adopted journal read (№2932-2).
  if (events.alias) { const found = baseSelections(events.entries[0] as ReadJournal, base); shareable.set(events, found); return found; }
  let selections: Map<string, Set<number | null>> | null = null;
  if (events.complete && events.entries.length > 0 && !events.conflict && !origin.pending
    && [...events.chains.values()].every(witness => witness === base)) {
    selections = new Map();
    const seen = new Set<ReadJournal>();
    const visit = (journal: ReadJournal): void => {
      if (seen.has(journal)) return;
      seen.add(journal);
      for (const entry of journal.entries) {
        if ('entries' in entry) { visit(entry); continue; }
        if (entry.method !== 'get' || entry.id === undefined) continue;
        let revisions = selections!.get(entry.id);
        if (!revisions) { revisions = new Set(); selections!.set(entry.id, revisions); }
        revisions.add(entry.revision ?? null);
      }
    };
    visit(events);
  }
  shareable.set(events, selections);
  return selections;
}
/** PF2 (№2905): whether a proof's value may be handed to another view — plain data, shared when deeply frozen and
 * otherwise copied (S1.3), a kept or promoted copy as recorded with it — decided once per proof. */
const sharedValues = new WeakMap<object, { frozen: boolean } | null>();
function sharedValue(proof: HistoricalProof & { frozen?: boolean }): { frozen: boolean } | null {
  if (typeof proof.frozen === 'boolean') return { frozen: proof.frozen };
  if (sharedValues.has(proof)) return sharedValues.get(proof)!;
  // A proof kept only in its own view holds the very object its caller received: shared further only while no one can change it.
  const frozen = { all: true }, found = plainValue(proof.value, frozen) && frozen.all ? { frozen: true } : null;
  sharedValues.set(proof, found);
  return found;
}
/** PF2 (№2905, table rows 3–5): a receiver gives every selection of a base proof to the same Store — no own row of its
 * chain answers a get the proof made (its head, that revision or an absence), and the chain itself is intact. */
function servesBase(receiver: Store, base: Store, selections: Map<string, Set<number | null>>): boolean {
  const rows = pendingSelections(receiver);
  if (rows === null || readServer(receiver, 'list', undefined, undefined) !== base) return false;
  return rows.every(([id, revision]) => { const read = selections.get(id); return !read || !read.has(null) && !read.has(revision); });
}
/** Share exact proofs for one synchronous product operation; heads and current admission stay fresh. */
export function withHistoricalReads<T>(action: () => T): T {
  if (historicalViews) return synchronous(action);
  historicalViews = new WeakMap(); sharedProofs = new WeakMap();
  try { return synchronous(action); }
  finally { historicalViews = null; sharedProofs = null; proofCaptures = []; }
}
function useHistoricalProof<T>(store: Store, key: HistoricalReadKey, action: (source: Store) => T,
  onCycle: () => T, cacheable: (value: T) => boolean, traced: boolean, refusals = false): T {
  if (!(store instanceof Store) || !object(key) || !text(key.reader) || !text(key.project) || !isRef(key.ref)
    || typeof action !== 'function' || typeof onCycle !== 'function' || typeof cacheable !== 'function') invalid('history');
  const exact = canonical(key);
  return withHistoricalReads(() => {
    const views = historicalViews!, source = sourceIdentity(store), base = layerBase(source);
    let view = views.get(source);
    if (!view) { view = { active: new Set(), proven: new Map() }; views.set(source, view); }
    if (view.active.has(exact)) { for (const open of proofCaptures) open.cyclic = true; return synchronous(onCycle); }
    /**
     * PF2 (№2905, №2932-2/3): a proof of the base — proved there or through a layer of it, in this operation or kept —
     * serves this view when no own row of its chain answers what the proof read and the proof is current. The receiver
     * keeps it under its own identity (adoptedJournal), so it replays to observers attached now or later the stream a
     * cold derivation here gives.
     */
    const adopt = (home: Store, scopes: (Map<string, HistoricalProof & { frozen?: boolean }> | null | undefined)[]): { value: T } | null => {
      for (const scope of scopes) {
        const kept = scope?.get(exact);
        if (!kept || (traced || historicalTraces.has(store)) && !kept.complete) continue;
        const selections = baseSelections(kept.events, home);
        if (!selections || !servesBase(source, home, selections)) continue;
        if (!chainsIntact(kept.events) || !currentFootprint(kept.footprint)) { scope!.delete(exact); continue; }
        const value = sharedValue(kept);
        if (!value) continue;
        // What a view keeps is what its caller received (№2932): no `frozen` of a kept copy travels with it (sharedValue).
        const adopted = { value: value.frozen ? kept.value : structuredClone(kept.value), events: adoptedJournal(kept.events, source),
          footprint: kept.footprint, complete: kept.complete };
        view.proven.set(exact, adopted);
        replayProof(store, adopted.events);
        return { value: adopted.value as T };
      }
      return null;
    };
    if (base && !view.proven.has(exact)) {
      const adopted = adopt(base, [views.get(base)?.proven, retainedArea(base), sharedProofs!.get(base), sharedRetained.get(base)]);
      if (adopted) return adopted.value;
    }
    const area = retainedArea(source), kept = view.proven.has(exact) ? undefined : area?.get(exact);
    // A traced caller replays a proof to its observers; one derived through a closure read shows them nothing (S1.4).
    if (kept && (!(traced || historicalTraces.has(store)) || kept.complete)) {
      // Another operation proved it: it serves this one only while its whole footprint is current.
      area!.delete(exact);
      if (chainsIntact(kept.events) && currentFootprint(kept.footprint)) {
        area!.set(exact, kept);
        const adopted = { value: kept.frozen ? kept.value : structuredClone(kept.value), events: kept.events, footprint: kept.footprint, complete: kept.complete };
        view.proven.set(exact, adopted);
        replayProof(store, adopted.events);
        return adopted.value as T;
      }
    }
    // PF2 (№2932-3, row 1): the base itself, with nothing of its own, takes what its layers proved of it.
    if (area && !view.proven.has(exact)) {
      const adopted = adopt(source, [sharedProofs!.get(source), sharedRetained.get(source)]);
      if (adopted) return adopted.value;
    }
    const complete = traced || historicalTraces.has(store), previous = view.proven.get(exact);
    // An untraced action is observed at the Store (S1.4, №2302, №2410): only a listed reader over the proven family of a
    // genuine Store; every other one keeps the S1.3 semantics.
    const observing = OBSERVED_READERS.has(key.reader) && (provenStore(source) === source || base !== null), observable = complete || observing;
    if (previous && (!complete || previous.complete)) {
      if (chainsIntact(previous.events) && currentFootprint(previous.footprint)) { replayProof(store, previous.events); return previous.value as T; }
      // A proof of a genuine Store is checked on its own at every use, so only the moved one goes (S1.3). A mutable opaque
      // view now exposes another snapshot: no proof of its previous snapshot survives.
      if (area) view.proven.delete(exact);
      else view.proven.clear();
    }
    view.active.add(exact);
    const events: ReadJournal = { entries: [], sources: new Set(), footprint: [], accounted: 0, complete: false, tainted: false, stamps: new Map(), stores: new Set(), chains: new Map(), methods: new Map(), conflict: false, observing, cyclic: false,
      layer: observing && base ? source : null, root: base ? source : null, home: source };
    // PF2: closure reads through a layer reach its base only while the layer still reads through the members it bound.
    if (events.layer) events.chains.set(source, base);
    proofCaptures.push(events);
    // PF3.1 (№3459 §3): a derivation started inside a traced read observes its own reads — the read in progress outside it
    // keeps its own observations and result; what this derivation reads is credited to that read when it ends.
    const outerReads = readStack, outerCredits = readCredits, outerFrames = readFrames;
    readStack = []; readCredits = []; readFrames = [];
    const reads = storeReads(), gits = gitCalls();
    let completed = false;
    try {
      const result = synchronous(() => action(traced ? historicalTrace(store) : store));
      // Replaying through an opaque forwarding view must not bypass collectors hidden behind that view.
      completeJournal(events); completed = true;
      // Complete only if every physical read of this action was traced, it ran no git (№2217) and every nested journal —
      // derived here or taken from a cache — is complete too (№2201): a dependency outside the Store travels to every parent.
      // PF4 (№3499 §2): a cycle answered inside — whatever an action made of that answer — leaves the trail incomplete.
      events.complete = observable && !events.tainted && !events.cyclic && storeReads() - reads === events.accounted && gitCalls() === gits
        && events.entries.every(entry => !('entries' in entry) || entry.complete);
      const replayable = !isProxy(source) || [...events.sources].every(observed => observed === source);
      // PF3.1 (№3459 §4): a refusal is a result like any other, but it is kept — here and across operations — only for a
      // historical consumer that asked for it explicitly and is listed below, from a complete, acyclic derivation of plain
      // data; every other refusal keeps the old rule, whatever its cacheable predicate says.
      const refused = object(result) && result.ok === false;
      const keptRefusal = refused && refusals && REFUSAL_READERS.has(key.reader) && events.complete && !events.cyclic
        && plainValue(result, { all: true });
      if (replayable && (refused ? keptRefusal : cacheable(result))) {
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
        // PF2 (№2905, №2932-3, row 1): derived through a layer, yet its base's — it serves the base itself and its other
        // layers in this and the next operations; a proof that read a layer's own row stays this layer's (row 2). The base's
        // own views and kept proofs keep their rules, and the base takes a layer's proof only with nothing of its own.
        const shared = { all: true };
        if (base && baseSelections(events, base) && plainValue(result, shared)) {
          const owned = { ...proof, value: shared.all ? result : structuredClone(result), frozen: shared.all };
          let current = sharedProofs!.get(base), kept = sharedRetained.get(base);
          if (!current) { current = new Map(); sharedProofs!.set(base, current); }
          if (!kept) { kept = new Map(); sharedRetained.set(base, kept); }
          current.set(exact, owned);
          kept.set(exact, owned);
          for (const oldest of kept.keys()) { if (kept.size <= RETAINED_LIMIT) break; kept.delete(oldest); }
        }
      }
      return result;
    } finally {
      readStack = outerReads; readCredits = outerCredits; readFrames = outerFrames;
      if (outerCredits.length) outerCredits[outerCredits.length - 1]! += storeReads() - reads;
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
/**
 * PF3.1 (№3459 §4): the historical readers whose own refusal, derived from exact saved inputs with a complete acyclic trail,
 * is the same result at every repeat and may be kept like a success; it never stands for a current check.
 */
const REFUSAL_READERS: ReadonlySet<string> = new Set(['E4.continuation', 'D5.citation']);
/** A historical read whose refusal may be kept as well — effective only for a reader listed in REFUSAL_READERS. */
export function historicalRefusalRead<T>(store: Store, key: HistoricalReadKey, action: () => T, onCycle: () => T): T {
  return useHistoricalProof(store, key, action, onCycle, value => !(object(value) && value.ok === false), false, true);
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
  // №55: one wrapper of each read for the life of the view — the same function at every access — that calls the source's
  // current member on the source itself, so a later replacement of that member still reaches the reads and their checks.
  const reads: Record<string, unknown> = {
    get: <T = Json>(id: string, revision?: number): Revision<T> | null => {
      const row = pending.get(id);
      return row && (revision === undefined || row.revision === revision) ? row as Revision<T> : store.get<T>(id, revision);
    },
    list: <T = Json>(kind?: string): Revision<T>[] => store.list<T>(kind),
    history: <T = Json>(id: string): Revision<T>[] => store.history<T>(id),
  };
  const view = new Proxy(store, { get(target, property) {
    if (typeof property === "string" && Object.hasOwn(reads, property)) return reads[property];
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
/** №2846, №55: the source a trusted recovery snapshot — through every snapshot nested in it — finally reads from; the
 * functions a read invokes are fixed on it, never on a nested snapshot's wrapper. */
function snapshotDelegate(view: Store): Store | null {
  let delegate = snapshotBases.get(view) ?? null;
  while (delegate && snapshotBases.has(sourceView(delegate))) delegate = snapshotBases.get(sourceView(delegate))!;
  // A trace forwards each read to its source afresh: the functions that run are the source's.
  return delegate && sourceView(delegate);
}
/** A trusted recovery snapshot still stands over a proved source: a genuine Store as it is now (an own replaced read
 * makes it none), a write-only view still bound to its reads, a pending layer with its chain, or such a snapshot (№2827). */
function snapshotIntact(view: Store): boolean {
  const stored = snapshotBases.get(view);
  if (!stored) return false;
  const base = sourceView(stored);
  if (snapshotBases.has(base)) return snapshotIntact(base);
  return pendingLayer(base) ? readServer(base, 'list', undefined, undefined) !== null : provenStore(base) !== null;
}

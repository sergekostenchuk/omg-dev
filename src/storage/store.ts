import { mkdirSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { canonical, digest, HASH_RE, type Json } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import { migrate } from "./schema.js";
import { createSnapshot, type Snapshot, type SnapshotOptions } from "./snapshots.js";

export interface Revision<T = Json> { id: string; kind: string; revision: number; hash: string; value: T }
/** A saved revision's identity without its body. */
export interface RevisionIdentity { id: string; kind: string; revision: number; hash: string }
export interface Write { id: string; kind: string; expected: number; value: unknown }
export interface AtomicWriteBatch<T> { value: T; writes: Write[]; guards: TransactionGuard[] }
interface PreparedWrite extends Write { body: string; hash: string }
export interface ReadGuard { id: string; revision: number; hash: string }
export interface AbsentGuard { id: string; absent: true }
export type TransactionGuard = ReadGuard | AbsentGuard;

/** The single guard-form check (Q5): every caller — this Store's writes, admission-guard normalization and capture
 * views — shares it, so a malformed guard is refused identically wherever it arrives. */
export function checkTransactionGuards(value: unknown): TransactionGuard[] {
  requireCondition(Array.isArray(value), "invalid_guard", "Transaction guards must be an array");
  return Array.from(value, (guard: unknown, index): TransactionGuard => {
    requireCondition(guard !== null && typeof guard === "object" && !Array.isArray(guard),
      "invalid_guard", `Guard ${index} must be a record`);
    const fields = guard as Record<string, unknown>;
    const id = fields['id'];
    requireCondition(typeof id === "string" && id.length > 0,
      "invalid_guard", `Guard ${index} needs a nonempty ID`);
    if ('absent' in fields) {
      requireCondition(fields['absent'] === true && !('revision' in fields) && !('hash' in fields),
        "invalid_guard", `Guard ${index} for ${id} must declare only absence`);
      return { id, absent: true };
    }
    const revision = fields['revision'], hash = fields['hash'];
    requireCondition(typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
      && typeof hash === "string" && HASH_RE.test(hash),
    "invalid_guard", `Guard ${index} for ${id} needs an exact revision and SHA-256 hash`);
    return { id, revision, hash };
  });
}

let physicalReads = 0;
/** Reads made through get/list/history/identities of every Store in this process (S1.3, №2201; S1.4, №2302-1): a
 * historical proof compares them with the reads it observed, so any read it did not see keeps that proof incomplete. */
export function storeReads(): number { return physicalReads; }
export type StoreReadMethod = 'get' | 'list' | 'history' | 'identities';
/** The selection an identities() call applies: get one id or revision, list every head or one kind, prefix the
 * literal entity_id range of heads (Q4, №2563-3) — never decoded bodies, so excluded corrupt rows stay unread. */
export type IdentityMethod = 'get' | 'list' | 'history' | 'prefix';
/**
 * S1.4 (№2302): what a historical proof observes at this implementation — a read only once it has completed, with its
 * request and result, and every write attempt before its first check. A read that throws is never reported.
 */
export interface StoreObserver {
  begin(store: Store): object | undefined;
  end(token: object, store: Store, method: StoreReadMethod, mode: IdentityMethod, id: string | undefined,
    revision: number | undefined, rows: readonly (Revision<unknown> | RevisionIdentity)[]): void;
  write(store: Store): void;
  /** A read answered through a view whose own answers no Store reports (S1.4, №2395). */
  untraced(): void;
}
let observer: StoreObserver | null = null;
/** Installs the observer and returns the previous one, so a test can put it back. */
export function observeStore(next: StoreObserver | null): StoreObserver | null { const previous = observer; observer = next; return previous; }
/** G1 (№6174 п.3): whether a capture actively observes this Store's reads right now — asked through the
 * same begin protocol the reads use, so an installed-but-idle observer (proofs.ts sets it permanently)
 * does not disable the snapshot paths. A returned token is dropped, never ended: nothing was read and
 * nothing is accounted; the store may be marked for the proof in progress exactly as its first observed
 * read would mark it. */
export function storeObserved(store: Store): boolean {
  return observer?.begin(store) !== undefined;
}
/** A write attempt that a view's policy may refuse before it reaches any Store is still an attempt (№2302-2). */
export function noteWriteAttempt(store: Store): void { observer?.write(store); }
/** A read projection, capture or other opaque view may answer without reaching any Store: the reading proof is incomplete. */
export function noteUntracedRead(): void { observer?.untraced(); }

/** The first entity_id after `prefix`'s whole prefix range, or none when it ends at the last Unicode point. The
 * literal range shares no semantics with SQL patterns: %, _, case and colons are ordinary characters. */
function prefixBound(prefix: string): string | null {
  const chars = Array.from(prefix);
  for (let index = chars.length - 1; index >= 0; index--) {
    const point = chars[index]!.codePointAt(0)!;
    if (point < 0x10ffff) return chars.slice(0, index).join('') + String.fromCodePoint(point + 1);
  }
  return null;
}

/** NR1 (№3600): the sha256 of a body is its identity, computed once when it was written; a read does not hash it again. */
function decode<T>(row: Record<string, unknown>): Revision<T> {
  const body = String(row['body']);
  return { id: String(row['entity_id']), kind: String(row['kind']), revision: Number(row['revision']),
    hash: String(row['sha256']), value: JSON.parse(body) as T };
}

/**
 * PF3 (№3424 §2): the checked JSON text of exact saved revisions, kept so that a repeated read neither loads a body
 * from SQLite again nor hashes it again. Only text that passed the first read's digest and JSON.parse is kept, in its
 * own Store's area under the exact (id, revision, sha256); every read still parses a new value of its own, so callers
 * share no mutable cell. Heads, absences, errors and any "checked" status are never kept. One least-recently-used
 * budget bounds the areas of all Stores of the process together: an eviction, an entry above the budget or a released
 * area is an ordinary read, never a refusal.
 */
const BODY_CACHE_LIMIT = 256 * 1024 * 1024;
/** Accounting is conservative: the UTF-16 text of key and body, plus a fixed cost per entry. */
const BODY_ENTRY_COST = 256;
interface CachedBody { readonly area: Map<string, CachedBody>; readonly key: string; readonly body: string; readonly cost: number }
const cachedBodies = new Set<CachedBody>();
let cachedBytes = 0;
const bodyCounters = { hits: 0, misses: 0, loads: 0, loadedChars: 0, digests: 0, parses: 0, kept: 0, evictions: 0, oversized: 0, resets: 0 };
export interface StoreBodyCache {
  hits: number; misses: number; loads: number; loadedChars: number; digests: number; parses: number; kept: number;
  evictions: number; oversized: number; resets: number; bytes: number; entries: number; limit: number;
}
/** Diagnostics of the body cache (PF3): counters only; no proof, record, refusal or guard depends on them. */
export function storeBodyCache(): Readonly<StoreBodyCache> {
  return Object.freeze({ ...bodyCounters, bytes: cachedBytes, entries: cachedBodies.size, limit: BODY_CACHE_LIMIT });
}
const bodyKey = (id: string, revision: number, hash: string): string => `${hash}:${revision}:${id}`;
function forgetBody(entry: CachedBody): void { cachedBodies.delete(entry); entry.area.delete(entry.key); cachedBytes -= entry.cost; }
function keepBody(area: Map<string, CachedBody>, key: string, body: string): void {
  const cost = 2 * (key.length + body.length) + BODY_ENTRY_COST;
  if (cost > BODY_CACHE_LIMIT) { bodyCounters.oversized++; return; }
  for (const oldest of cachedBodies) { if (cachedBytes + cost <= BODY_CACHE_LIMIT) break; forgetBody(oldest); bodyCounters.evictions++; }
  const entry: CachedBody = { area, key, body, cost };
  area.set(key, entry); cachedBodies.add(entry); cachedBytes += cost; bodyCounters.kept++;
}
function releaseArea(area: Map<string, CachedBody>): void { for (const entry of [...area.values()]) forgetBody(entry); }
const IDENTITY_COLUMNS = "r.entity_id, r.revision, r.kind, r.sha256";

/** G1 (пул K ред.3 п.2, №6174 п.3): one id a batch head comparison could not satisfy. `expected` lists
 * every guard that named the id — more than one is a `guard_conflict`; `actual` is the head identity the
 * single snapshot found, or none. */
export interface HeadsMatchMismatch {
  id: string;
  expected: TransactionGuard[];
  actual: RevisionIdentity | null;
}
/** The result of one snapshot head comparison: `ok` exactly when every guard held; `conflict` marks at
 * least one id required by contradictory guards — reported, never silently folded into a stale answer.
 * `heads` is additive: the head identities the same snapshot selected for the requested ids — each
 * found head with its kind, exactly the ids that were present; an absent or unselected id has none. */
export interface HeadsMatch {
  ok: boolean;
  conflict: boolean;
  mismatches: HeadsMatchMismatch[];
  heads: RevisionIdentity[];
}

/** PF4 (№3499 §3.1): one committed product event without its body — what a write changed, never what it wrote. */
export interface StoreEvent { sequence: number; id: string; revision: number; kind: string }
/** PF4 (№3499 §5.1): a checked result and the shared nodes it reaches, written together or not at all. */
export interface ProofCacheRecord { key: string; body: string; nodes: readonly string[] }
export interface ProofCacheNode { hash: string; body: string }
export interface ProofCacheWritten { records: number; nodes: number; evicted: number; swept: string[]; bytes: number }
const eventCounters = { marks: 0, ranges: 0, rangeEvents: 0, tails: 0, cacheReads: 0, nodeReads: 0, cacheWrites: 0, cacheBusy: 0, cacheClears: 0 };
/** Diagnostics of the technical reads and writes PF4 adds (event marks and ranges, the proof cache). None of them is a
 * product read: storeReads() and the read observer never see them, so no proof takes them for a dependency. */
export function storeEvents(): Readonly<typeof eventCounters> { return Object.freeze({ ...eventCounters }); }
const busyError = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return code === 5 || code === 6;
};

export class Store {
  readonly path: string;
  #db: DatabaseSync;
  #busy = false;
  #closed = false;
  #commits = 0;
  /** PF3: this connection's area of the body cache, its prepared statements, the data_version it last saw, and whether
   * a writeMany transaction is open — inside it reads keep the previous uncached check. */
  #bodies = new Map<string, CachedBody>();
  #statements = new Map<string, StatementSync>();
  #seen: unknown = undefined;
  #writing = false;
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const existing = lstatSync(this.path, { throwIfNoEntry: false });
    if (existing) requireCondition(existing.isFile() && !existing.isSymbolicLink(),
      "unsafe_database_path", "Database must be a regular file");
    this.#db = new DatabaseSync(this.path);
    try { migrate(this.#db); } catch (error) { this.#db.close(); throw error; }
  }
  /**
   * Equal stamps prove that nothing this connection can read has changed in between: this Store's own commits are
   * counted, and SQLite's data_version moves with every commit of any other connection to the file (S1.3, №2185-3).
   */
  changeStamp(): string {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    return `${this.#commits}:${String(this.#db.prepare("PRAGMA data_version").get()!['data_version'])}`;
  }
  /** The identities get/list/history/prefix select, read without decoding bodies: saved revisions never change.
   * 'prefix' names a literal entity_id prefix and selects the current heads inside its indexed range, in the
   * Store's own entity_id order — the same rows a startsWith filter over list() would name, without reading them. */
  identities(method: IdentityMethod, id?: string, revision?: number): RevisionIdentity[] {
    physicalReads++;
    const token = observer?.begin(this);
    const columns = "r.entity_id, r.revision, r.kind, r.sha256";
    const rows = method === 'get' ? [revision === undefined
      ? this.#db.prepare(`SELECT ${columns} FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.entity_id=?`).get(id!)
      : this.#db.prepare(`SELECT ${columns} FROM revisions r WHERE entity_id=? AND revision=?`).get(id!, revision)].filter(row => row !== undefined)
      : method === 'list' ? id === undefined
        ? this.#db.prepare(`SELECT ${columns} FROM revisions r JOIN heads h USING(entity_id,revision) ORDER BY entity_id`).all()
        : this.#db.prepare(`SELECT ${columns} FROM revisions r JOIN heads h USING(entity_id,revision) WHERE kind=? ORDER BY entity_id`).all(id)
      : method === 'prefix' ? (() => {
          const bound = id === undefined ? null : prefixBound(id);
          return bound === null
            ? this.#db.prepare(`SELECT ${columns} FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.entity_id>=? ORDER BY entity_id`).all(id!)
            : this.#db.prepare(`SELECT ${columns} FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.entity_id>=? AND r.entity_id<? ORDER BY entity_id`).all(id!, bound);
        })()
      : this.#db.prepare(`SELECT ${columns} FROM revisions r WHERE entity_id=? ORDER BY revision`).all(id!);
    const found = rows.map(row => ({ id: String(row!['entity_id']), kind: String(row!['kind']), revision: Number(row!['revision']), hash: String(row!['sha256']) }));
    if (token) observer!.end(token, this, 'identities', method, id, revision, found);
    return found;
  }
  /**
   * G1 (пул K ред.3 п.2, №6174 п.3): compares a set of transaction guards against current heads in ONE
   * committed snapshot — all chunks inside a single deferred read transaction (inside an already-open
   * write transaction, within it), no body ever decoded. Covers TransactionGuard wholly: a present
   * requirement (exact revision and sha256), an absent one (no head may exist), the empty set (true),
   * and contradictory requirements for one id, which are reported as a conflict instead of passing or
   * failing silently. Every executed SELECT chunk is a counted physical read — the batch cost follows
   * C+ceil(D/chunk), never one flat read however large the guard set (№6232 G1-02). While a proof
   * actively captures this Store's reads, the same snapshot is read instead by the point identities
   * get of each distinct id (№6262 G1-02): the journal then records exactly the ids selected — each
   * found head and each absent id — counted and observed once per read, so a write of any other id
   * leaves the proof reusable and a moved or newly present selected id re-derives it. A chunk is never
   * described as a whole-Store list. The empty guard set runs no SELECT at all and reports no observation.
   * `heads` additionally reports the found head identities (with kind) from that same snapshot, so a
   * caller that must read selected bodies can choose them by kind without another head walk (LG1).
   */
  headsMatch(guards: readonly TransactionGuard[]): HeadsMatch {
    requireCondition(!this.#busy && !this.#closed, "store_busy", "Store is closed or creating a snapshot");
    const checked = checkTransactionGuards([...guards]);
    const byId = new Map<string, TransactionGuard[]>();
    for (const guard of checked) {
      const group = byId.get(guard.id);
      if (group) group.push(guard); else byId.set(guard.id, [guard]);
    }
    const heads = new Map<string, RevisionIdentity>();
    const ids = [...byId.keys()];
    const read = () => {
      if (storeObserved(this)) {
        // A capturing proof records each selected id by the point read its journal already replays.
        for (const id of ids) for (const identity of this.identities('get', id)) heads.set(identity.id, identity);
        return;
      }
      for (let index = 0; index < ids.length; index += 999) {
        physicalReads++;
        const chunk = ids.slice(index, index + 999);
        const rows = this.#db.prepare(`SELECT ${IDENTITY_COLUMNS} FROM heads h
          JOIN revisions r USING(entity_id, revision) WHERE h.entity_id IN (${chunk.map(() => "?").join(",")})`)
          .all(...chunk);
        for (const row of rows) heads.set(String(row!['entity_id']), { id: String(row!['entity_id']), kind: String(row!['kind']),
          revision: Number(row!['revision']), hash: String(row!['sha256']) });
      }
    };
    if (ids.length) {
      if (this.#writing) read();
      else {
        this.#db.exec("BEGIN DEFERRED");
        try { read(); } finally { this.#db.exec("COMMIT"); }
      }
    }
    const mismatches: HeadsMatchMismatch[] = [];
    let conflict = false;
    for (const [id, group] of byId) {
      const actual = heads.get(id) ?? null;
      const variants = new Set(group.map(guard => 'absent' in guard ? "absent" : `${guard.revision}:${guard.hash}`));
      if (variants.size > 1) {
        conflict = true;
        mismatches.push({ id, expected: group, actual });
        continue;
      }
      const guard = group[0]!;
      const ok = 'absent' in guard ? actual === null
        : actual !== null && actual.revision === guard.revision && actual.hash === guard.hash;
      if (!ok) mismatches.push({ id, expected: group, actual });
    }
    return { ok: mismatches.length === 0, conflict, mismatches, heads: [...heads.values()] };
  }
  get databaseId(): string { return String(this.#db.prepare("SELECT database_id FROM identity WHERE id=1").get()!['database_id']); }
  get<T = Json>(id: string, revision?: number): Revision<T> | null {
    physicalReads++;
    const token = observer?.begin(this);
    const found = this.#writing ? this.#get<T>(id, revision) : this.#read<T>(id, revision);
    if (token) observer!.end(token, this, 'get', 'get', id, revision, found ? [found] : []);
    return found;
  }
  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) { statement = this.#db.prepare(sql); this.#statements.set(sql, statement); }
    return statement;
  }
  /** Another connection's commit may have changed any row this area kept: the area is dropped before it answers. */
  #current(): void {
    const version = this.#statement("PRAGMA data_version").get()!['data_version'];
    if (this.#seen !== undefined && version !== this.#seen && this.#bodies.size) { releaseArea(this.#bodies); bodyCounters.resets++; }
    this.#seen = version;
  }
  #read<T>(id: string, revision?: number): Revision<T> | null {
    this.#current();
    const row = revision === undefined
      ? this.#statement(`SELECT ${IDENTITY_COLUMNS} FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.entity_id=?`).get(id)
      : this.#statement(`SELECT ${IDENTITY_COLUMNS} FROM revisions r WHERE entity_id=? AND revision=?`).get(id, revision);
    return row ? this.#materialize<T>(row) : null;
  }
  /** The body of exactly the version a selection named — never re-read through a head that may have moved since. */
  #materialize<T>(row: Record<string, unknown>): Revision<T> {
    const id = String(row['entity_id']), revision = Number(row['revision']), kind = String(row['kind']), hash = String(row['sha256']);
    const key = bodyKey(id, revision, hash), kept = this.#writing ? undefined : this.#bodies.get(key);
    let body: string;
    if (kept) { cachedBodies.delete(kept); cachedBodies.add(kept); bodyCounters.hits++; body = kept.body; }
    else {
      bodyCounters.misses++;
      const loaded = this.#statement("SELECT body FROM revisions WHERE entity_id=? AND revision=?").get(id, revision);
      requireCondition(loaded !== undefined, "record_corrupt", "A selected revision disappeared before its body was read");
      body = String(loaded['body']); bodyCounters.loads++; bodyCounters.loadedChars += body.length;
    }
    bodyCounters.parses++;
    const value = JSON.parse(body) as T;
    if (!kept && !this.#writing) keepBody(this.#bodies, key, body);
    return { id, kind, revision, hash, value };
  }
  #get<T = Json>(id: string, revision?: number): Revision<T> | null {
    const row = revision === undefined
      ? this.#db.prepare("SELECT r.* FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.entity_id=?").get(id)
      : this.#db.prepare("SELECT * FROM revisions WHERE entity_id=? AND revision=?").get(id, revision);
    return row ? decode<T>(row) : null;
  }
  list<T = Json>(kind?: string): Revision<T>[] {
    physicalReads++;
    const token = observer?.begin(this);
    this.#current();
    const sql = `SELECT ${IDENTITY_COLUMNS} FROM revisions r JOIN heads h USING(entity_id,revision)`;
    const rows = kind === undefined ? this.#statement(`${sql} ORDER BY entity_id`).all()
      : this.#statement(`${sql} WHERE kind=? ORDER BY entity_id`).all(kind);
    const found = rows.map(row => this.#materialize<T>(row));
    if (token) observer!.end(token, this, 'list', 'list', kind, undefined, found);
    return found;
  }
  history<T = Json>(id: string): Revision<T>[] {
    physicalReads++;
    const token = observer?.begin(this);
    this.#current();
    const found = this.#statement(`SELECT ${IDENTITY_COLUMNS} FROM revisions r WHERE entity_id=? ORDER BY revision`).all(id)
      .map(row => this.#materialize<T>(row));
    if (token) observer!.end(token, this, 'history', 'history', id, undefined, found);
    return found;
  }
  write<T = Json>(input: Write): Revision<T> { return this.writeMany<T>([input])[0]!; }
  writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    // Even a refused or rolled-back attempt: its guard reads are no pure proof (№2302-2).
    observer?.write(this);
    requireCondition(!this.#busy && !this.#closed, "store_busy", "Store is closed or creating a snapshot");
    requireCondition(!this.#writing, "store_atomic_prepare_invalid", "A write cannot be nested in atomic preparation");
    const checkedGuards = checkTransactionGuards(guards), prepared = this.#prepareWrites(inputs);
    this.#db.exec("BEGIN IMMEDIATE");
    this.#writing = true;
    try {
      const results = this.#insert<T>(prepared, checkedGuards);
      this.#db.exec("COMMIT");
      this.#writing = false;
      this.#commits++;
      return results;
    } catch (error) { this.#writing = false; this.#db.exec("ROLLBACK"); throw error; }
  }
  /** Prepare a product batch under the same write lock that commits it. Readers see this connection's committed
   * snapshot; the callback is synchronous and gets no writing surface. An empty batch is a read-only repeat. */
  atomicWrite<T>(prepare: (view: Store) => AtomicWriteBatch<T>): { value: T; records: Revision<unknown>[] } {
    observer?.write(this);
    requireCondition(!this.#busy && !this.#closed, "store_busy", "Store is closed or creating a snapshot");
    requireCondition(!this.#writing && typeof prepare === 'function', "store_atomic_prepare_invalid", "Atomic preparation cannot be nested");
    this.#db.exec("BEGIN IMMEDIATE");
    this.#writing = true;
    try {
      const reads = new Set(['get', 'list', 'history', 'identities', 'headsMatch', 'changeStamp', 'lastEvent',
        'events', 'integrityLedger', 'eventAt', 'proofCacheRead', 'proofCacheNode']);
      const denied = () => { observer?.write(this); throw new EngineError('store_atomic_prepare_invalid', 'Atomic preparation permits reads only'); };
      // Inherited methods let historical readers wrap this frozen surface in their tracing Proxy.
      const methods = Object.create(Store.prototype) as Store, view = Object.create(methods) as Store;
      Object.defineProperty(view, 'path', { value: this.path });
      for (const name of Object.getOwnPropertyNames(Store.prototype)) {
        if (name === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(Store.prototype, name)!;
        Object.defineProperty(methods, name, descriptor.get
          ? { get: () => Reflect.get(this, name, this) }
          : { value: name === 'proofCacheWrite' ? () => null : reads.has(name) ? (Reflect.get(this, name, this) as (...args: never[]) => unknown).bind(this) : denied });
      }
      Object.freeze(methods); Object.freeze(view);
      const batch = prepare(view);
      requireCondition(batch !== null && typeof batch === 'object' && typeof (batch as any).then !== 'function'
        && Array.isArray(batch.writes), 'store_atomic_prepare_invalid', 'Atomic preparation returns a synchronous batch');
      const prepared = this.#prepareWrites(batch.writes), guards = checkTransactionGuards(batch.guards);
      const value = batch.value, records = this.#insert<unknown>(prepared, guards);
      this.#db.exec("COMMIT");
      this.#writing = false;
      if (records.length) this.#commits++;
      return { value, records };
    } catch (error) { this.#writing = false; this.#db.exec("ROLLBACK"); throw error; }
  }
  #prepareWrites(inputs: Write[]): PreparedWrite[] {
    const ids = new Set<string>();
    return inputs.map(input => {
      requireCondition(typeof input.id === "string" && input.id.length > 0 && input.id.length <= 200
        && typeof input.kind === "string" && input.kind.length > 0 && Number.isSafeInteger(input.expected) && input.expected >= 0,
      "invalid_write", "A write needs an ID, kind and explicit expected revision");
      requireCondition(!ids.has(input.id), "duplicate_write", "A transaction may write each entity only once");
      ids.add(input.id);
      const body = canonical(input.value);
      return { ...input, body, hash: digest(body) };
    });
  }
  #insert<T = Json>(prepared: PreparedWrite[], checkedGuards: TransactionGuard[]): Revision<T>[] {
    for (const guard of checkedGuards) {
      if ('absent' in guard) {
        const head = this.#db.prepare("SELECT revision FROM heads WHERE entity_id=?").get(guard.id);
        requireCondition(!head, "input_stale", `Input ${guard.id} appeared before the transaction could commit`);
      } else {
        const current = this.#get(guard.id);
        requireCondition(current && current.revision === guard.revision && current.hash === guard.hash,
          "input_stale", "An input changed before the transaction could commit");
      }
    }
    const results: Revision<T>[] = [];
    for (const input of prepared) {
      const current = this.get(input.id);
      if ((current?.revision ?? 0) !== input.expected) throw new EngineError("revision_conflict", "Entity changed; reload before writing", { id: input.id });
      requireCondition(!current || current.kind === input.kind, "kind_mismatch", "An entity cannot change its kind");
      const revision = input.expected + 1;
      this.#db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?)").run(input.id, revision, input.kind, input.body, input.hash);
      this.#db.prepare("INSERT INTO heads VALUES(?,?) ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision").run(input.id, revision);
      this.#db.prepare("INSERT INTO events(entity_id,revision) VALUES(?,?)").run(input.id, revision);
      results.push({ id: input.id, kind: input.kind, revision, hash: input.hash, value: JSON.parse(input.body) as T });
    }
    return results;
  }
  /**
   * PF4 (№3499 §3.1): the sequence of the last committed product event (0 for none). Writers are serialized and
   * sequences only grow, so every commit after this answer carries a greater sequence. Never a product read.
   */
  lastEvent(): number {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    eventCounters.marks++;
    return Number(this.#statement("SELECT coalesce(max(sequence), 0) AS last FROM events").get()!['last']);
  }
  /** PF4: the committed events in (from, to], in sequence order, with the kind of the revision each one made — no bodies.
   * Sequences may have gaps; completeness is the range itself, never a count. */
  events(from: number, to: number): StoreEvent[] {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    eventCounters.ranges++;
    const rows = this.#statement(`SELECT e.sequence, e.entity_id, e.revision, r.kind FROM events e JOIN revisions r USING(entity_id, revision)
      WHERE e.sequence > ? AND e.sequence <= ? ORDER BY e.sequence`).all(from, to);
    eventCounters.rangeEvents += rows.length;
    return rows.map(row => ({ sequence: Number(row['sequence']), id: String(row['entity_id']), revision: Number(row['revision']), kind: String(row['kind']) }));
  }
  /** Bounded incremental journal scan; the old events() contract stays unchanged. */
  eventsPage(from: number, to: number, limit: number): StoreEvent[] {
    this.#eventBoundary(to);
    requireCondition(Number.isSafeInteger(from) && from >= 0 && from <= to && Number.isSafeInteger(limit) && limit > 0,
      "event_cursor_invalid", "Expected a forward range and a positive event page limit");
    eventCounters.ranges++;
    const rows = this.#statement(`SELECT e.sequence,e.entity_id,e.revision,r.kind FROM events e JOIN revisions r USING(entity_id,revision)
      WHERE e.sequence>? AND e.sequence<=? ORDER BY e.sequence LIMIT ?`).all(from,to,limit);
    eventCounters.rangeEvents += rows.length;
    return rows.map(row => ({sequence: Number(row['sequence']),id: String(row['entity_id']),revision: Number(row['revision']),kind: String(row['kind'])}));
  }
  /** DRS2.1: an exact revision (or the last revision of an id) committed no later than
   * this event boundary. Unlike get(), a current head can never enter this read. */
  getAtEvent<T = Json>(sequence: number, id: string, revision?: number): Revision<T> | null {
    this.#eventBoundary(sequence);
    physicalReads++;
    const token = observer?.begin(this);
    const row = this.#statement(`SELECT ${IDENTITY_COLUMNS} FROM revisions r JOIN events e USING(entity_id,revision)
      WHERE e.sequence<=? AND r.entity_id=? ${revision === undefined ? '' : 'AND r.revision=?'}
      ORDER BY e.sequence DESC LIMIT 1`).get(...(revision === undefined ? [sequence, id] : [sequence, id, revision]));
    this.#current();
    const found = row ? this.#materialize<T>(row) : null;
    if (token) observer!.end(token, this, 'get', 'get', id, revision, found ? [found] : []);
    return found;
  }
  /** Historical heads/history, selected by event sequence, never by today's heads table. */
  identitiesAtEvent(sequence: number, kind?: string, id?: string, history = false): RevisionIdentity[] {
    this.#eventBoundary(sequence);
    physicalReads++;
    const token = observer?.begin(this);
    const rows = this.#statement(`SELECT ${IDENTITY_COLUMNS} FROM revisions r JOIN events e USING(entity_id,revision)
      WHERE e.sequence<=? ${kind === undefined ? '' : 'AND r.kind=?'} ${id === undefined ? '' : 'AND r.entity_id=?'}
      ${history ? '' : `AND NOT EXISTS (SELECT 1 FROM events later WHERE later.entity_id=e.entity_id
        AND later.sequence>e.sequence AND later.sequence<=?)`} ORDER BY r.entity_id,r.revision`)
      .all(sequence, ...(kind === undefined ? [] : [kind]), ...(id === undefined ? [] : [id]), ...(history ? [] : [sequence]));
    const found = rows.map(row => ({id: String(row['entity_id']), revision: Number(row['revision']),
      kind: String(row['kind']), hash: String(row['sha256'])}));
    if (token) observer!.end(token, this, 'identities', history ? 'history' : 'list', id ?? kind, undefined, found);
    return found;
  }
  #eventBoundary(sequence: number): void {
    requireCondition(!this.#closed && !this.#busy, "store_busy", "Store is closed or creating a snapshot");
    requireCondition(Number.isSafeInteger(sequence) && sequence >= 0 && (sequence === 0 || this.eventAt(sequence) !== null),
      "event_cursor_invalid", "The cursor must name a committed event (or the empty journal)");
  }
  /** Technical projection reads are not product proof reads. Metadata and rows come from one snapshot. */
  eventIndexRead(key: string, through: number, includeRows = true): {scope: string; cursor: number; rows: {sequence: number; body: string}[]} | null {
    this.#eventBoundary(through);
    this.#db.exec("BEGIN DEFERRED");
    try {
      const scope = this.#db.prepare("SELECT scope,cursor FROM event_index_scopes WHERE key=?").get(key);
      if (!scope) return null;
      const rows = !includeRows ? [] : this.#db.prepare("SELECT sequence,body FROM event_index_rows WHERE scope_key=? AND sequence<=? ORDER BY sequence")
        .all(key, through).map(row => ({sequence: Number(row['sequence']), body: String(row['body'])}));
      return {scope: String(scope['scope']), cursor: Number(scope['cursor']), rows};
    } finally { this.#db.exec("COMMIT"); }
  }
  /** Publish a scanned event range and its selected rows in the SAME transaction. A lost
   * cursor CAS or any failed row rolls the whole range back; primary records/events stay untouched. */
  eventIndexWrite(scope: unknown, from: number, through: number, rows: readonly {sequence: number; value: unknown}[]): void {
    this.#eventBoundary(through);
    requireCondition(Number.isSafeInteger(from) && from >= 0 && from <= through,
      "event_cursor_invalid", "An index range must move forward");
    const body = canonical(scope), key = digest(body), seen = new Set<number>();
    const prepared = rows.map(row => {
      requireCondition(Number.isSafeInteger(row.sequence) && row.sequence > from && row.sequence <= through && !seen.has(row.sequence),
        "event_cursor_invalid", "Every selected event occurs once inside the published range");
      seen.add(row.sequence); return {sequence: row.sequence, body: canonical(row.value)};
    });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#db.prepare("SELECT scope,cursor FROM event_index_scopes WHERE key=?").get(key);
      requireCondition(previous ? previous['scope'] === body && previous['cursor'] === from : from === 0,
        "event_index_conflict", "Another builder advanced this projection; reload its cursor");
      if (!previous) this.#db.prepare("INSERT INTO event_index_scopes VALUES(?,?,?)").run(key, body, through);
      else this.#db.prepare("UPDATE event_index_scopes SET cursor=? WHERE key=?").run(through, key);
      for (const row of prepared) this.#db.prepare("INSERT INTO event_index_rows VALUES(?,?,?)").run(key, row.sequence, row.body);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  /** NR1 (№3633): every stored revision as written — its body text and the sha256 stored with it — in id and revision
   * order, for the integrity check (om-fsck) alone; no product read uses it. */
  *integrityRevisions(): Generator<{ id: string; revision: number; kind: string; body: string; sha256: string }> {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    for (const row of this.#db.prepare("SELECT entity_id, revision, kind, body, sha256 FROM revisions ORDER BY entity_id, revision").iterate())
      yield { id: String(row['entity_id']), revision: Number(row['revision']), kind: String(row['kind']), body: String(row['body']), sha256: String(row['sha256']) };
  }
  /**
   * NR1 (№3674 п.1): runs the integrity check (om-fsck) inside one read transaction, so its events, heads and revisions
   * are one committed snapshot of the database — a lawful write of another connection meanwhile is wholly outside it.
   */
  integritySnapshot<T>(check: () => T): T {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    this.#db.exec("BEGIN DEFERRED");
    try {
      // The snapshot is taken by the first read of the transaction.
      this.#db.prepare("SELECT 1 FROM heads LIMIT 1").get();
      return check();
    } finally { this.#db.exec("COMMIT"); }
  }
  /** NR1 (№3633): every event and every head as stored, for the integrity check (om-fsck) alone. */
  integrityLedger(): { events: { sequence: number; id: string; revision: number }[]; heads: Map<string, number> } {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    const events = this.#db.prepare("SELECT sequence, entity_id, revision FROM events ORDER BY sequence").all()
      .map(row => ({ sequence: Number(row['sequence']), id: String(row['entity_id']), revision: Number(row['revision']) }));
    const heads = new Map(this.#db.prepare("SELECT entity_id, revision FROM heads").all().map(row => [String(row['entity_id']), Number(row['revision'])]));
    return { events, heads };
  }
  /** PF4: what the event at one sequence made — its id, revision and hash — so a kept mark names its own history. */
  eventAt(sequence: number): { id: string; revision: number; hash: string } | null {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    eventCounters.tails++;
    const row = this.#statement(`SELECT e.entity_id, e.revision, r.sha256 FROM events e JOIN revisions r USING(entity_id, revision)
      WHERE e.sequence = ?`).get(sequence);
    return row ? { id: String(row['entity_id']), revision: Number(row['revision']), hash: String(row['sha256']) } : null;
  }
  /** PF4 (№3499 §5.2): one saved result of the proof cache by its key, or null. */
  proofCacheRead(key: string): string | null {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    eventCounters.cacheReads++;
    const row = this.#statement("SELECT body FROM proof_cache WHERE key = ?").get(key);
    return row ? String(row['body']) : null;
  }
  /** PF4: one shared node of the proof cache by its content hash, or null. */
  proofCacheNode(hash: string): string | null {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    eventCounters.nodeReads++;
    const row = this.#statement("SELECT body FROM proof_nodes WHERE hash = ?").get(hash);
    return row ? String(row['body']) : null;
  }
  /**
   * PF4 (№3499 §5.3): saves checked results, their nodes and links in one transaction of this connection, then keeps
   * at most `roots` results (oldest written go first) and `bytes` of encoded data, and sweeps the nodes no kept result
   * reaches. `nodes` are all the nodes the results reach (return №3541-2): whether each is saved is decided here, inside
   * the transaction — another connection may have swept it since anyone looked — and a missing one is written from what
   * was given; a result naming a node that is neither saved nor given is no complete result, and nothing is written. No product table, event, hash or commit count changes, so changeStamp() stays as it was. A cache another
   * writer holds is skipped at once (null) and never waited for; durability is relaxed for this transaction only — a
   * lost one costs a cold derivation, and the next product commit syncs everything before it.
   */
  proofCacheWrite(records: readonly ProofCacheRecord[], nodes: readonly ProofCacheNode[], limits: { roots: number; bytes: number }): ProofCacheWritten | null {
    requireCondition(!this.#closed, "store_busy", "Store is closed or creating a snapshot");
    if (this.#busy || this.#writing) { eventCounters.cacheBusy++; return null; }
    this.#db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL");
    try {
      try { this.#db.exec("BEGIN IMMEDIATE"); }
      catch (error) { if (busyError(error)) { eventCounters.cacheBusy++; return null; } throw error; }
      try {
        const written: ProofCacheWritten = { records: 0, nodes: 0, evicted: 0, swept: [], bytes: 0 };
        const present = this.#statement("SELECT 1 AS present FROM proof_nodes WHERE hash = ?");
        const node = this.#statement("INSERT INTO proof_nodes(hash, size, body) VALUES(?, ?, ?)");
        const given = new Map(nodes.map(item => [item.hash, item])), ensured = new Set<string>();
        const ensure = (hash: string) => {
          if (ensured.has(hash)) return;
          if (!present.get(hash)) {
            const item = given.get(hash);
            requireCondition(item !== undefined, "proof_cache_incomplete", "A saved result names a node that is neither saved nor given");
            node.run(item.hash, 2 * item.body.length, item.body);
            written.nodes++;
          }
          ensured.add(hash);
        };
        const unlink = this.#statement("DELETE FROM proof_links WHERE key = ?");
        const link = this.#statement("INSERT OR IGNORE INTO proof_links(key, node) VALUES(?, ?)");
        const record = this.#statement(`INSERT OR REPLACE INTO proof_cache(key, written, size, body)
          VALUES(?, (SELECT coalesce(max(written), 0) + 1 FROM proof_cache), ?, ?)`);
        let unlinked = false;
        for (const item of records) {
          unlinked = Number(unlink.run(item.key).changes) > 0 || unlinked;
          record.run(item.key, 2 * item.body.length, item.body);
          for (const hash of item.nodes) { ensure(hash); link.run(item.key, hash); }
          written.records++;
        }
        const evict = (keys: readonly unknown[]) => {
          for (const key of keys) { unlink.run(key as string); this.#statement("DELETE FROM proof_cache WHERE key = ?").run(key as string); }
          written.evicted += keys.length;
        };
        const sweep = () => { for (const row of this.#statement(
          "DELETE FROM proof_nodes WHERE NOT EXISTS (SELECT 1 FROM proof_links WHERE node = proof_nodes.hash) RETURNING hash").all())
          written.swept.push(String(row['hash'])); };
        evict(this.#statement("SELECT key FROM proof_cache ORDER BY written DESC LIMIT -1 OFFSET ?").all(limits.roots).map(row => row['key']));
        if (unlinked || written.evicted) sweep();
        const total = () => Number(this.#statement(`SELECT (SELECT coalesce(sum(size), 0) FROM proof_cache)
          + (SELECT coalesce(sum(size), 0) FROM proof_nodes) AS total`).get()!['total']);
        for (let bytes = total(); bytes > limits.bytes; bytes = total()) {
          const count = Number(this.#statement("SELECT count(*) AS count FROM proof_cache").get()!['count']);
          evict(this.#statement("SELECT key FROM proof_cache ORDER BY written LIMIT ?").all(Math.max(1, Math.ceil(count / 2))).map(row => row['key']));
          sweep();
          if (!count) break;
        }
        written.bytes = total();
        this.#db.exec("COMMIT");
        eventCounters.cacheWrites++;
        return written;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    } finally { this.#db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000"); }
  }
  /** PF4 (№3499 §5.1): empties the proof cache; history, heads, events and hashes stay as they are. */
  proofCacheClear(): void {
    requireCondition(!this.#closed && !this.#busy, "store_busy", "Store is closed or creating a snapshot");
    this.#db.exec("BEGIN IMMEDIATE");
    try { this.#db.exec("DELETE FROM proof_links; DELETE FROM proof_nodes; DELETE FROM proof_cache; COMMIT"); eventCounters.cacheClears++; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  async snapshot(directory: string, options: SnapshotOptions = {}): Promise<Snapshot> {
    requireCondition(!this.#busy && !this.#closed, "store_busy", "Store is closed or creating a snapshot");
    this.#busy = true;
    try { return await createSnapshot(this.#db, this.path, directory, options); }
    finally { this.#busy = false; }
  }
  close(): void {
    requireCondition(!this.#busy, "store_busy", "Wait for the snapshot before closing the store");
    if (!this.#closed) { releaseArea(this.#bodies); this.#statements.clear(); this.#db.close(); this.#closed = true; }
  }
}

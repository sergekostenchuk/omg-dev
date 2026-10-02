import { mkdirSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, digest, HASH_RE, type Json } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import { migrate } from "./schema.js";
import { createSnapshot, type Snapshot, type SnapshotOptions } from "./snapshots.js";

export interface Revision<T = Json> { id: string; kind: string; revision: number; hash: string; value: T }
/** A saved revision's identity without its body. */
export interface RevisionIdentity { id: string; kind: string; revision: number; hash: string }
export interface Write { id: string; kind: string; expected: number; value: unknown }
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

function decode<T>(row: Record<string, unknown>): Revision<T> {
  const body = String(row['body']);
  requireCondition(digest(body) === row['sha256'], "record_corrupt", "Stored revision checksum mismatch");
  return { id: String(row['entity_id']), kind: String(row['kind']), revision: Number(row['revision']),
    hash: String(row['sha256']), value: JSON.parse(body) as T };
}

export class Store {
  readonly path: string;
  #db: DatabaseSync;
  #busy = false;
  #closed = false;
  #commits = 0;
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
  get databaseId(): string { return String(this.#db.prepare("SELECT database_id FROM identity WHERE id=1").get()!['database_id']); }
  get<T = Json>(id: string, revision?: number): Revision<T> | null {
    physicalReads++;
    const token = observer?.begin(this);
    const found = this.#get<T>(id, revision);
    if (token) observer!.end(token, this, 'get', 'get', id, revision, found ? [found] : []);
    return found;
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
    const sql = "SELECT r.* FROM revisions r JOIN heads h USING(entity_id,revision)";
    const rows = kind === undefined ? this.#db.prepare(`${sql} ORDER BY entity_id`).all()
      : this.#db.prepare(`${sql} WHERE kind=? ORDER BY entity_id`).all(kind);
    const found = rows.map(row => decode<T>(row));
    if (token) observer!.end(token, this, 'list', 'list', kind, undefined, found);
    return found;
  }
  history<T = Json>(id: string): Revision<T>[] {
    physicalReads++;
    const token = observer?.begin(this);
    const found = this.#db.prepare("SELECT * FROM revisions WHERE entity_id=? ORDER BY revision").all(id).map(row => decode<T>(row));
    if (token) observer!.end(token, this, 'history', 'history', id, undefined, found);
    return found;
  }
  write<T = Json>(input: Write): Revision<T> { return this.writeMany<T>([input])[0]!; }
  writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    // Even a refused or rolled-back attempt: its guard reads are no pure proof (№2302-2).
    observer?.write(this);
    requireCondition(!this.#busy && !this.#closed, "store_busy", "Store is closed or creating a snapshot");
    const checkedGuards = checkTransactionGuards(guards);
    const ids = new Set<string>();
    const prepared = inputs.map(input => {
      requireCondition(typeof input.id === "string" && input.id.length > 0 && input.id.length <= 200
        && typeof input.kind === "string" && input.kind.length > 0 && Number.isSafeInteger(input.expected) && input.expected >= 0,
      "invalid_write", "A write needs an ID, kind and explicit expected revision");
      requireCondition(!ids.has(input.id), "duplicate_write", "A transaction may write each entity only once");
      ids.add(input.id);
      const body = canonical(input.value);
      return { ...input, body, hash: digest(body) };
    });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
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
      this.#db.exec("COMMIT");
      this.#commits++;
      return results;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  async snapshot(directory: string, options: SnapshotOptions = {}): Promise<Snapshot> {
    requireCondition(!this.#busy && !this.#closed, "store_busy", "Store is closed or creating a snapshot");
    this.#busy = true;
    try { return await createSnapshot(this.#db, this.path, directory, options); }
    finally { this.#busy = false; }
  }
  close(): void {
    requireCondition(!this.#busy, "store_busy", "Wait for the snapshot before closing the store");
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }
}

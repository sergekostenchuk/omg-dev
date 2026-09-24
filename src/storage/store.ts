import { mkdirSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, digest, type Json } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import { migrate } from "./schema.js";
import { createSnapshot, type Snapshot, type SnapshotOptions } from "./snapshots.js";

export interface Revision<T = Json> { id: string; kind: string; revision: number; hash: string; value: T }
export interface Write { id: string; kind: string; expected: number; value: unknown }
export interface ReadGuard { id: string; revision: number; hash: string }
export interface AbsentGuard { id: string; absent: true }
export type TransactionGuard = ReadGuard | AbsentGuard;

function transactionGuards(value: unknown): TransactionGuard[] {
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
      && typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash),
    "invalid_guard", `Guard ${index} for ${id} needs an exact revision and SHA-256 hash`);
    return { id, revision, hash };
  });
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
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const existing = lstatSync(this.path, { throwIfNoEntry: false });
    if (existing) requireCondition(existing.isFile() && !existing.isSymbolicLink(),
      "unsafe_database_path", "Database must be a regular file");
    this.#db = new DatabaseSync(this.path);
    try { migrate(this.#db); } catch (error) { this.#db.close(); throw error; }
  }
  get databaseId(): string { return String(this.#db.prepare("SELECT database_id FROM identity WHERE id=1").get()!['database_id']); }
  get<T = Json>(id: string, revision?: number): Revision<T> | null {
    return this.#get<T>(id, revision);
  }
  #get<T = Json>(id: string, revision?: number): Revision<T> | null {
    const row = revision === undefined
      ? this.#db.prepare("SELECT r.* FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.entity_id=?").get(id)
      : this.#db.prepare("SELECT * FROM revisions WHERE entity_id=? AND revision=?").get(id, revision);
    return row ? decode<T>(row) : null;
  }
  list<T = Json>(kind?: string): Revision<T>[] {
    const sql = "SELECT r.* FROM revisions r JOIN heads h USING(entity_id,revision)";
    const rows = kind === undefined ? this.#db.prepare(`${sql} ORDER BY entity_id`).all()
      : this.#db.prepare(`${sql} WHERE kind=? ORDER BY entity_id`).all(kind);
    return rows.map(row => decode<T>(row));
  }
  history<T = Json>(id: string): Revision<T>[] {
    return this.#db.prepare("SELECT * FROM revisions WHERE entity_id=? ORDER BY revision").all(id).map(row => decode<T>(row));
  }
  write<T = Json>(input: Write): Revision<T> { return this.writeMany<T>([input])[0]!; }
  writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    requireCondition(!this.#busy && !this.#closed, "store_busy", "Store is closed or creating a snapshot");
    const checkedGuards = transactionGuards(guards);
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

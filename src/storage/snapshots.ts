import { DatabaseSync, backup } from "node:sqlite";
import { closeSync, copyFileSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, renameSync, unlinkSync, linkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, digest, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { assertSchema } from "./schema.js";

export interface Snapshot { path: string; generation: number; databaseId: string; contentHash: string }
export interface SnapshotOptions { signal?: AbortSignal; progress?: (remaining: number) => void }

function syncFile(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

function contentHash(db: DatabaseSync): string {
  const revisions = db.prepare("SELECT * FROM revisions ORDER BY entity_id,revision").all();
  for (const row of revisions) {
    const body = String(row['body']);
    requireCondition(digest(body) === row['sha256'] && canonical(JSON.parse(body)) === body,
      "record_corrupt", "Snapshot contains a corrupted revision");
  }
  return hashJson({ identity: db.prepare("SELECT * FROM identity").all(), revisions,
    heads: db.prepare("SELECT * FROM heads ORDER BY entity_id").all(), events: db.prepare("SELECT * FROM events ORDER BY sequence").all() });
}

export function inspectSnapshot(path: string): Snapshot {
  requireCondition(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    "snapshot_unavailable", "Snapshot is missing or not a regular file");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertSchema(db);
    requireCondition(db.prepare("PRAGMA quick_check").get()!['quick_check'] === "ok"
      && db.prepare("PRAGMA foreign_key_check").all().length === 0, "snapshot_corrupt", "Snapshot integrity check failed");
    const stamp = db.prepare("SELECT * FROM snapshot_stamp WHERE id=1").get();
    const hash = contentHash(db);
    requireCondition(stamp && stamp['content_sha256'] === hash && Number.isSafeInteger(stamp['generation'])
      && Number(stamp['generation']) > 0, "snapshot_corrupt", "Snapshot stamp or content checksum is invalid");
    return { path, generation: Number(stamp['generation']), databaseId: String(db.prepare("SELECT database_id FROM identity WHERE id=1").get()!['database_id']), contentHash: hash };
  } finally { db.close(); }
}

function available(directory: string): Snapshot[] {
  return ["A", "B"].flatMap(slot => {
    try { return [inspectSnapshot(join(directory, `snapshot-${slot}.sqlite`))]; } catch { return []; }
  });
}

export async function createSnapshot(source: DatabaseSync, databasePath: string, directory: string, options: SnapshotOptions): Promise<Snapshot> {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  requireCondition(!lstatSync(root).isSymbolicLink(), "unsafe_snapshot_path", "Snapshot directory cannot be a symlink");
  const lock = new DatabaseSync(databasePath);
  const temporary = join(root, `.pending-${randomUUID()}.sqlite`);
  let locked = false;
  try {
    // SQLite releases this reservation on process death. No stale lock-file recovery is required.
    lock.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE"); locked = true;
    options.signal?.throwIfAborted();
    const current = available(root);
    const identity = String(source.prepare("SELECT database_id FROM identity WHERE id=1").get()!['database_id']);
    requireCondition(current.every(item => item.databaseId === identity), "foreign_snapshot", "Snapshot directory belongs to another database");
    const generation = Math.max(0, ...current.map(item => item.generation)) + 1;
    const missing = ["A", "B"].map(slot => join(root, `snapshot-${slot}.sqlite`)).find(path => !current.some(item => item.path === path));
    const target = missing ?? [...current].sort((a, b) => a.generation - b.generation)[0]!.path;
    requireCondition(resolve(target) !== resolve(databasePath), "unsafe_snapshot_path", "Snapshot cannot replace the working database");
    if (existsSync(target)) requireCondition(realpathSync(target) !== realpathSync(databasePath),
      "unsafe_snapshot_path", "Snapshot cannot replace an alias of the working database");
    if (existsSync(target)) requireCondition(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink(), "unsafe_snapshot_path", "Snapshot slot must be a regular file");
    await backup(source, temporary, { rate: 32, progress: ({ remainingPages }) => options.progress?.(remainingPages) });
    options.signal?.throwIfAborted();
    const copy = new DatabaseSync(temporary);
    try {
      copy.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
      copy.prepare("INSERT INTO snapshot_stamp VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,content_sha256=excluded.content_sha256").run(generation, contentHash(copy));
    } finally { copy.close(); }
    const snapshot = inspectSnapshot(temporary);
    syncFile(temporary);
    options.signal?.throwIfAborted();
    renameSync(temporary, target); syncFile(root);
    return { ...snapshot, path: target };
  } finally {
    if (locked) lock.exec("ROLLBACK"); lock.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function restoreSnapshot(directory: string, destination: string): Snapshot {
  const candidates = available(resolve(directory));
  requireCondition(candidates.length > 0, "snapshot_unavailable", "No valid A/B snapshot is available");
  requireCondition(new Set(candidates.map(item => item.databaseId)).size === 1, "foreign_snapshot", "Snapshot slots belong to different databases");
  const latest = candidates.sort((a, b) => b.generation - a.generation)[0]!;
  const target = resolve(destination);
  requireCondition(!existsSync(target) && !existsSync(`${target}-wal`) && !existsSync(`${target}-shm`),
    "restore_target_exists", "Restore requires a new database path");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.restore-${randomUUID()}.sqlite`);
  try {
    copyFileSync(latest.path, temporary, constants.COPYFILE_EXCL);
    const restored = inspectSnapshot(temporary);
    requireCondition(restored.contentHash === latest.contentHash, "snapshot_changed", "Snapshot changed while restoring");
    syncFile(temporary);
    // Atomic publication with no replacement, including a destination created after the initial check.
    linkSync(temporary, target); syncFile(dirname(target));
    return { ...restored, path: target };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new EngineError("restore_target_exists", "Restore destination already exists");
    throw new EngineError("restore_failed", "Could not restore the snapshot", String(error));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

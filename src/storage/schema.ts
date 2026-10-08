import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { digest } from "../canonical.js";
import { requireCondition } from "../errors.js";

export const APPLICATION_ID = 0x4f4d4732;
const SCHEMA = `
CREATE TABLE identity(id INTEGER PRIMARY KEY CHECK(id=1), database_id TEXT NOT NULL) STRICT;
CREATE TABLE migrations(version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT;
CREATE TABLE revisions(
 entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), kind TEXT NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body)), sha256 TEXT NOT NULL,
 PRIMARY KEY(entity_id, revision)
) STRICT;
CREATE TABLE heads(entity_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
 FOREIGN KEY(entity_id, revision) REFERENCES revisions(entity_id, revision)) STRICT;
CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
 revision INTEGER NOT NULL, FOREIGN KEY(entity_id, revision) REFERENCES revisions(entity_id, revision)) STRICT;
CREATE TABLE snapshot_stamp(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL,
 content_sha256 TEXT NOT NULL) STRICT;
CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END;
CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable_revision'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable_event'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable_event'); END;
CREATE TRIGGER identity_no_update BEFORE UPDATE ON identity BEGIN SELECT RAISE(ABORT, 'immutable_identity'); END;
CREATE TRIGGER identity_no_delete BEFORE DELETE ON identity BEGIN SELECT RAISE(ABORT, 'immutable_identity'); END;
`;

/**
 * PF4 (№3499 §5.1 as amended by №3523): the proof cache is an extension of this database, not a new version of it — the
 * schema above, its digest, user_version and the migrations table stay byte for byte as they were, so code that predates
 * the extension opens the database as before (and whatever it writes is an event the cache's checks see). The extension
 * is its own tables and its own record of version and digest, created or removed in one transaction: wholly absent (a
 * cold start), or wholly present with exactly this record. Anything between — a missing table or record, another version
 * or text — is migration_mismatch, never completed silently. `proof_cache` holds one checked result with its honest mark
 * per full key; `proof_nodes` the shared journal nodes and layer descriptions by content hash; `proof_links` which nodes
 * each result reaches, so sweeping unreferenced nodes never removes a journal of a result still kept.
 */
const PROOF_CACHE_VERSION = 2;
const PROOF_CACHE_SCHEMA = `
CREATE TABLE proof_cache(key TEXT PRIMARY KEY, written INTEGER NOT NULL, size INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
CREATE TABLE proof_nodes(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
CREATE TABLE proof_links(key TEXT NOT NULL, node TEXT NOT NULL, PRIMARY KEY(key, node)) STRICT, WITHOUT ROWID;
CREATE INDEX proof_links_node ON proof_links(node);
CREATE TABLE proof_cache_schema(version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT;
`;
/** Every object the extension owns, by name and type — the only objects removeProofCache ever drops. */
const PROOF_CACHE_OBJECTS: readonly (readonly [string, 'table' | 'index'])[] = [
  ['proof_links_node', 'index'], ['proof_links', 'table'], ['proof_nodes', 'table'], ['proof_cache', 'table'], ['proof_cache_schema', 'table']];

/** Whether the extension is wholly absent, wholly present with exactly its own record, or anything else. */
function proofCacheState(db: DatabaseSync): 'absent' | 'present' | 'mismatch' {
  const found = new Map(db.prepare(`SELECT name, type FROM sqlite_master WHERE name IN (${PROOF_CACHE_OBJECTS.map(() => '?').join(',')})`)
    .all(...PROOF_CACHE_OBJECTS.map(([name]) => name)).map(row => [String(row['name']), String(row['type'])]));
  if (found.size === 0) return 'absent';
  if (found.size !== PROOF_CACHE_OBJECTS.length || PROOF_CACHE_OBJECTS.some(([name, type]) => found.get(name) !== type)) return 'mismatch';
  const record = db.prepare("SELECT version, sha256 FROM proof_cache_schema").all();
  return record.length === 1 && Number(record[0]!['version']) === PROOF_CACHE_VERSION && record[0]!['sha256'] === digest(PROOF_CACHE_SCHEMA)
    ? 'present' : 'mismatch';
}

export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  try {
    const appId = Number(db.prepare("PRAGMA application_id").get()!['application_id']);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length === 0 && appId === 0) {
      db.exec(SCHEMA);
      db.prepare("INSERT INTO identity VALUES(1, ?)").run(randomUUID());
      db.prepare("INSERT INTO migrations VALUES(1, ?)").run(digest(SCHEMA));
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
    } else assertSchema(db);
    // PF4: the extension joins the same transaction — an interrupted open leaves the database as it was.
    if (proofCacheState(db) === 'absent') {
      db.exec(PROOF_CACHE_SCHEMA);
      db.prepare("INSERT INTO proof_cache_schema VALUES(?, ?)").run(PROOF_CACHE_VERSION, digest(PROOF_CACHE_SCHEMA));
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
}

export function assertSchema(db: DatabaseSync): void {
  requireCondition(Number(db.prepare("PRAGMA application_id").get()!['application_id']) === APPLICATION_ID,
    "foreign_database", "This is not an OMG database");
  requireCondition(Number(db.prepare("PRAGMA user_version").get()!['user_version']) === 1,
    "schema_version", "Unsupported database version");
  const migrations = db.prepare("SELECT version, sha256 FROM migrations ORDER BY version").all();
  requireCondition(migrations.length === 1 && migrations[0]!['sha256'] === digest(SCHEMA),
    "migration_mismatch", "Database migration identity does not match this engine");
  requireCondition(proofCacheState(db) !== 'mismatch', "migration_mismatch", "The proof cache extension is incomplete or of another version");
}

/**
 * PF4 (№3523): removes the proof cache extension — exactly its own tables, index and record, complete or not — in one
 * transaction, leaving identity, revisions, heads, events, migrations and every hash as they are. The next open by this
 * engine installs an empty extension again. An object of another type under one of its names is no object of the
 * extension: it stays, and the database stays a mismatch.
 */
export function removeProofCache(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try {
      requireCondition(Number(db.prepare("PRAGMA application_id").get()!['application_id']) === APPLICATION_ID,
        "foreign_database", "This is not an OMG database");
      for (const [name, type] of PROOF_CACHE_OBJECTS)
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = ?").get(name, type)) db.exec(`DROP ${type.toUpperCase()} ${name}`);
      assertSchema(db);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

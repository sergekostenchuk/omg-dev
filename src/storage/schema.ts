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
}

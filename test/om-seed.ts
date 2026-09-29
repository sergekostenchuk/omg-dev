import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/storage/store.js";

/**
 * Immutable seeds for expensive fixture prefixes (T-DIET, №2029 Т2).
 *
 * A seed is built once per test process in a directory of its own; its database file is then made read-only and is
 * never opened again. Every test receives its own copy of that file in its own root and a deep copy of the seed's data,
 * so no Store, scenario, trace, file or process is shared between tests. A seed holds only records that name no
 * directory: whatever records a workspace, a scenario or a trace is written after the copy, in the test's own root, as
 * before. The key must name every parameter the build depends on.
 */
interface Seed { readonly root: string; readonly database: string; readonly data: unknown }
const seeds = new Map<string, Seed>();
process.once("exit", () => { for (const seed of seeds.values()) rmSync(seed.root, { recursive: true, force: true }); });

export interface SeedCopy<T> { root: string; database: string; data: T }

function checkedSeed(root: string, database: string): void {
  // A copy is exact only when the whole seed is one checkpointed file whose records do not name the seed's directory.
  if (existsSync(`${database}-wal`) || existsSync(`${database}-shm`)) throw new Error(`Seed ${database} was not checkpointed`);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const named = db.prepare("SELECT entity_id FROM revisions WHERE instr(body, ?) > 0").all(root).map(row => String(row["entity_id"]));
    if (named.length) throw new Error(`Seed records name the seed directory and cannot be copied: ${named.join(", ")}`);
  } finally { db.close(); }
}

export function seedCopy<T>(key: string, build: (store: Store) => T, prefix: string): SeedCopy<T> {
  let seed = seeds.get(key);
  if (!seed) {
    const root = mkdtempSync(join(tmpdir(), "omg-seed-")), database = join(root, "state.sqlite");
    const store = new Store(database);
    let data: T;
    try { data = build(store); } finally { store.close(); }
    checkedSeed(root, database);
    chmodSync(database, 0o400);
    seed = { root, database, data: structuredClone(data) };
    seeds.set(key, seed);
  }
  const root = mkdtempSync(join(tmpdir(), prefix)), database = join(root, "state.sqlite");
  copyFileSync(seed.database, database);
  chmodSync(database, 0o600);
  return { root, database, data: structuredClone(seed.data) as T };
}

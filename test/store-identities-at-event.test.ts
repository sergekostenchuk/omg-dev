import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";

/**
 * PROOF-SPEED-2: the identities at a committed cut are each id's last event up to it, read in one grouped pass. They are
 * compared here, at every cut of a mixed history, with the answer computed directly from the journal of events.
 */
test("identitiesAtEvent: at every cut, by kind, by id and as a history, exactly what the journal says", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-identities-")), store = new Store(join(root, "store.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const ids = ["note:a", "note:b", "task:c", "task:d", "note:e"], heads = new Map<string, number>();
  for (let step = 0; step < 60; step++) {
    const id = ids[(step * 7 + Math.floor(step / 3)) % ids.length]!, revision = (heads.get(id) ?? 0) + 1;
    store.writeMany([{ id, kind: id.split(":")[0]!, expected: revision - 1, value: { step } }]);
    heads.set(id, revision);
  }
  const events = store.events(0, store.lastEvent()), hashes = new Map<string, string>();
  for (const event of events) hashes.set(`${event.id}@${event.revision}`, store.get(event.id, event.revision)!.hash);
  const row = (event: { id: string; revision: number; kind: string }) =>
    ({ id: event.id, revision: event.revision, kind: event.kind, hash: hashes.get(`${event.id}@${event.revision}`)! });
  const order = (a: { id: string; revision: number }, b: { id: string; revision: number }) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision;
  for (const cut of [0, ...events.map(event => event.sequence)]) {
    const upTo = events.filter(event => event.sequence <= cut), last = new Map<string, typeof upTo[number]>();
    for (const event of upTo) last.set(event.id, event);
    for (const kind of [undefined, "note", "task", "none"]) {
      const expected = [...last.values()].filter(event => kind === undefined || event.kind === kind).map(row).sort(order);
      assert.deepEqual(store.identitiesAtEvent(cut, kind), expected, `heads at ${cut} of ${kind ?? "every kind"}`);
    }
    for (const id of [...ids, "note:z"]) {
      const head = last.get(id);
      assert.deepEqual(store.identitiesAtEvent(cut, undefined, id), head ? [row(head)] : [], `head of ${id} at ${cut}`);
      assert.deepEqual(store.identitiesAtEvent(cut, undefined, id, true), upTo.filter(event => event.id === id).map(row).sort(order), `history of ${id} at ${cut}`);
    }
  }
});

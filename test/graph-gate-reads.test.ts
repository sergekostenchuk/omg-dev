import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, hashJson } from "../src/canonical.js";
import type { Discovery } from "../src/discovery/discovery.js";
import type { Source } from "../src/evidence/evidence.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { GraphRepository, withGraphRead } from "../src/graph/repository.js";
import { historicalRead, withHistoricalReads } from "../src/history/proofs.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, storeReads, type Revision } from "../src/storage/store.js";
import { storeView } from "../src/storage/store-view.js";

interface GateFixture { store: Store; directory: string }
function fixture(t: TestContext): GateFixture {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omg-lg1-gate-")));
  const store = new Store(join(directory, "state.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}
const graphsOf = (store: Store) => new GraphRepository(store, null as unknown as Discovery);
const layerRecord = (store: Store, value: unknown, level: 1 | 2 | 3 = 1) => {
  const id = `graph-layer:p:${level}`;
  return store.write({ id, kind: "graph-layer", expected: store.get(id)?.revision ?? 0, value });
};
const writeLayer = (store: Store, inputs: Ref[], level: 1 | 2 | 3 = 1) =>
  layerRecord(store, { projection: { nodes: [] }, inputs, obligations: [] }, level);
const plain = (store: Store, id: string, value: unknown = { done: true }) =>
  store.write({ id, kind: "research", expected: 0, value });
const documentSource = (f: GateFixture, name: string, content: string) => f.store.write<Source>({
  id: `source:p:${name}`, kind: "source", expected: 0,
  value: { projectId: "p", origin: { kind: "owner-document", location: name }, content, mediaType: "text/plain", sha256: digest(content) },
});
const fileSource = (f: GateFixture, name: string, content: string): Revision<Source> => {
  const location = join(f.directory, name);
  writeFileSync(location, content);
  return f.store.write<Source>({
    id: `source:p:${name}`, kind: "source", expected: 0,
    value: { projectId: "p", origin: { kind: "file", location }, content, mediaType: "text/plain", sha256: digest(content) },
  });
};
const reads = (action: () => void): number => {
  const before = storeReads();
  action();
  return storeReads() - before;
};
function countFileReads(file: string, action: () => void): { count: number } {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function (...args: Parameters<typeof original>) {
    if (String(args[0]) === file) count++;
    return Reflect.apply(original, fs, args);
  } as typeof original;
  syncBuiltinESMExports();
  try { action(); } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  return { count };
}

test("LG1: layerGate compares every input head in one snapshot and reads bodies of Source ids only", t => {
  const f = fixture(t);
  // An input-free layer needs its two record reads and no snapshot at all.
  writeLayer(f.store, []);
  assert.equal(reads(() => assert.deepEqual(graphsOf(f.store).layerGate("p", 1).findings, [])), 2,
    "empty inputs: the layer and graph gets only");

  const source = fileSource(f, "a.txt", "alpha"), doc = documentSource(f, "doc", "beta");
  const first = plain(f.store, "research:p:1"), second = plain(f.store, "research:p:2");
  const layer = writeLayer(f.store, [reference(source), reference(doc), reference(first), reference(second)]);
  const graphs = graphsOf(f.store);
  const gate = graphs.layerGate("p", 1);
  assert.deepEqual(gate.findings, []);
  assert.deepEqual(gate.guards, [reference(layer), reference(first), reference(second), reference(source), reference(doc)],
    "every matched input guards the result, in uniqueRefs order");
  assert.equal(reads(() => graphs.layerGate("p", 1)), 2 + 1 + 2,
    "one snapshot chunk + the two Source bodies — the plain inputs are head-checked only");
  assert.deepEqual(gate.closure?.external.map(check => check.kind).sort(), ["graph-projection", "source", "source"]);

  // A moved input head is an exact stale finding and drops out of the guards.
  f.store.write({ id: first.id, kind: "research", expected: first.revision, value: { done: false } });
  const moved = graphs.layerGate("p", 1);
  assert.deepEqual(moved.findings.map(finding => [finding.code, finding.target]),
    [["graph_evidence_stale", first.id]]);
  assert.deepEqual(moved.guards.map(guard => guard.id), [layer.id, second.id, source.id, doc.id]);

  // A ref that never had a head is stale the same way — reported, never silently skipped.
  const ghost: Ref = { id: "research:p:ghost", revision: 1, hash: "0".repeat(64) };
  f.store.write({ id: layer.id, kind: layer.kind, expected: layer.revision,
    value: { projection: { nodes: [] }, inputs: [reference(source), reference(doc), reference(first), reference(second), ghost], obligations: [] } });
  const missing = graphs.layerGate("p", 1);
  assert.ok(missing.findings.some(finding => finding.code === "graph_evidence_stale" && finding.target === ghost.id));
});

test("LG1: two revisions of one id among the inputs are answered per input — the stale one finds, the current one guards", t => {
  const f = fixture(t);
  const first = plain(f.store, "research:p:pair");
  const second = f.store.write({ id: first.id, kind: "research", expected: first.revision, value: { done: "newer" } });
  writeLayer(f.store, [reference(first), reference(second)]);
  const gate = graphsOf(f.store).layerGate("p", 1);
  assert.deepEqual(gate.findings.map(finding => [finding.code, finding.target]),
    [["graph_evidence_stale", first.id]],
    "the superseded revision is stale while the current head revision still guards");
  assert.deepEqual(gate.guards.map(guard => `${guard.id}:${guard.revision}`), [`graph-layer:p:1:1`, `${second.id}:2`]);
});

test("LG1: 1001 inputs chunk the one snapshot — the gate budget is 2 + ceil(D/999) + S", t => {
  const f = fixture(t);
  const inputs = f.store.writeMany(Array.from({ length: 1001 }, (_v, index) =>
    ({ id: `research:p:bulk:${index}`, kind: "research", expected: 0, value: { index } }))).map(reference);
  const sources = [documentSource(f, "s1", "one"), documentSource(f, "s2", "two")].map(reference);
  writeLayer(f.store, [...inputs, ...sources]);
  const graphs = graphsOf(f.store);
  assert.equal(reads(() => assert.deepEqual(graphs.layerGate("p", 1).findings, [])), 2 + 2 + 2,
    "two record gets + two snapshot chunks + two Source bodies for 1003 distinct inputs");
});

test("LG1: identical calls in one read share pure derivations, never heads — a mid-read move and a later move are both seen", t => {
  const f = fixture(t);
  const source = fileSource(f, "memo.txt", "scope"), moving = plain(f.store, "research:p:moving");
  writeLayer(f.store, [reference(source), reference(moving)]);
  const graphs = graphsOf(f.store);
  const location = join(f.directory, "memo.txt");

  const measured = countFileReads(location, () => withGraphRead(() => {
    const first = graphs.layerGate("p", 1);
    assert.equal(reads(() => graphs.layerGate("p", 1)), reads(() => graphs.layerGate("p", 1)),
      "a repeated call re-compares the same heads — only pure derivations are shared");
    f.store.write({ id: moving.id, kind: "research", expected: moving.revision, value: { done: false } });
    const after = graphs.layerGate("p", 1);
    assert.ok(after.findings.some(finding => finding.code === "graph_evidence_stale" && finding.target === moving.id),
      "a head moved inside the scope is not answered from a memo");
    assert.deepEqual(first.findings, []);
  }));
  assert.equal(measured.count, 1, "the shared scope checks the exact source once for all its calls");

  // Outside the scope nothing is shared: the next operation reads the file again.
  const separate = countFileReads(location, () => { graphs.layerGate("p", 1); graphs.layerGate("p", 1); });
  assert.equal(separate.count, 2);
});

test("LG1: a file source changed or restored between operations is answered by the operation's own check", t => {
  const f = fixture(t);
  const location = join(f.directory, "drift.txt"), source = fileSource(f, "drift.txt", "original");
  writeLayer(f.store, [reference(source)]);
  const graphs = graphsOf(f.store);
  assert.deepEqual(graphs.layerGate("p", 1).findings, []);
  writeFileSync(location, "changed on disk");
  assert.ok(graphs.layerGate("p", 1).findings.some(finding =>
    finding.code === "graph_evidence_stale" && finding.target === source.id),
    "no memo survives across operations");
  writeFileSync(location, "original");
  assert.deepEqual(graphs.layerGate("p", 1).findings, []);
});

test("LG1: an exception inside the shared read leaves no memo behind", t => {
  const f = fixture(t);
  const location = join(f.directory, "boom.txt"), source = fileSource(f, "boom.txt", "before");
  writeLayer(f.store, [reference(source)]);
  const graphs = graphsOf(f.store), marker = new Error("boom");
  assert.throws(() => withGraphRead(() => { graphs.layerGate("p", 1); throw marker; }), error => error === marker);
  writeFileSync(location, "after the failure");
  assert.ok(graphs.layerGate("p", 1).findings.some(finding =>
    finding.code === "graph_evidence_stale" && finding.target === source.id),
    "the failed scope served nothing to the next call");
});

test("LG1: an opaque view keeps the observable per-input walk with the same answer", t => {
  const f = fixture(t);
  const source = documentSource(f, "viewed", "seen"), a = plain(f.store, "research:p:a"), b = plain(f.store, "research:p:b");
  writeLayer(f.store, [reference(source), reference(a), reference(b)]);
  const direct = graphsOf(f.store).layerGate("p", 1);
  const seen: string[] = [];
  const view = storeView(f.store, {
    write: (writes, guards) => f.store.writeMany(writes, guards),
    get: (id, revision) => { seen.push(id); return f.store.get(id, revision) ?? null; },
  });
  const viaView = graphsOf(view).layerGate("p", 1);
  assert.deepEqual(viaView, direct, "the fallback answers exactly as the snapshot path");
  assert.deepEqual(seen.sort(), ["graph-layer:p:1", "graph:p", a.id, b.id, source.id].sort(),
    "every selected id reached the view's own get — no hidden snapshot under an opaque view");
});

test("LG1: under a capture the gate journals every input id — a foreign write keeps the proof, a selected move re-derives", t => {
  const f = fixture(t);
  const a = plain(f.store, "research:p:j1"), b = plain(f.store, "research:p:j2");
  const layer = writeLayer(f.store, [reference(a), reference(b)]);
  const graphs = graphsOf(f.store);
  let derived = 0;
  const run = () => withHistoricalReads(() => historicalRead(f.store,
    { reader: "M6.route-result", project: "p", ref: reference(layer) },
    () => { derived++; return graphs.layerGate("p", 1); },
    () => { throw new Error("cycle"); }));
  assert.deepEqual(run().findings, []); assert.deepEqual(run().findings, []);
  assert.equal(derived, 1, "the second identical read replays the saved proof");
  f.store.write({ id: "unrelated:noise", kind: "noise", expected: 0, value: {} });
  assert.deepEqual(run().findings, []);
  assert.equal(derived, 1, "a write of an unselected id leaves the proof reusable");
  f.store.write({ id: a.id, kind: "research", expected: a.revision, value: { moved: true } });
  assert.ok(run().findings.some(finding => finding.code === "graph_evidence_stale" && finding.target === a.id));
  assert.equal(derived, 2, "a moved selected head re-derives — every input id was journaled");
});

test("LG1: real layer proofs and obligation fields gate by the same derivations on a proven store", t => {
  const f = fixture(t);
  const body = { version: 1, id: "map", title: "graph",
    nodes: [{ id: "node", kind: "block", title: "Original title", parent: null, outcome: null,
      ports: [], code: [], tests: [], boundary: [] }],
    contracts: [], artifacts: [], connectors: [], anchors: [], joins: [], tests: [], horizon: [] } as unknown as Graph;
  f.store.write({ id: "graph:p", kind: "graph", expected: 0, value: body });
  const projection = projectGraph(body, 1);
  const layerValue = () => ({ projection, inputs: [],
    obligations: [{ node: "node", field: "title", valueHash: hashJson("Original title"), inputs: [] }],
    layerProofs: [{ level: 1, hash: hashJson(projection), inputs: [] }] });
  layerRecord(f.store, layerValue());
  const graphs = graphsOf(f.store), gate = () => graphs.layerGate("p", 1);
  assert.deepEqual(gate().findings, []);
  assert.ok(gate().guards.length >= 1, "the layer head guards a passing gate");
  withGraphRead(() => {
    assert.deepEqual(gate().findings, []);
    assert.deepEqual(gate().findings, [], "the shared derivation answers a repeated call inside the read");
  });
  assert.deepEqual(gate().findings, [], "and again after the scope");

  // A proof whose hash no longer matches the derived projection is a finding, memoized or not.
  layerRecord(f.store, { ...layerValue(), layerProofs: [{ level: 1, hash: digest("other"), inputs: [] }] });
  assert.ok(gate().findings.some(finding => finding.code === "graph_layer_unproven" && finding.target === "L1"));
  withGraphRead(() => {
    assert.deepEqual(gate().findings, gate().findings, "the same refusal twice inside one read");
  });

  // Restored proof + an obligation field hash that no longer matches — a field finding.
  layerRecord(f.store, { ...layerValue(),
    obligations: [{ node: "node", field: "title", valueHash: hashJson("Different title"), inputs: [] }] });
  assert.ok(gate().findings.some(finding => finding.code === "graph_field_unproven" && finding.target === "node/title"));
});

test("LG1: a nested proven write-only view keeps the snapshot budget of the plain store", t => {
  const f = fixture(t);
  const location = join(f.directory, "valid.txt");
  writeFileSync(location, "original");
  const source = f.store.write<Source>({ id: "document:p:legal", kind: "source", expected: 0,
    value: { projectId: "p", origin: { kind: "file", location }, content: "original", mediaType: "text/plain", sha256: digest("original") } });
  writeLayer(f.store, [reference(source)]);
  const readOnly = () => { throw new Error("read-only probe"); };
  const nested = storeView(storeView(f.store, { write: readOnly }), { write: readOnly });
  const gate = graphsOf(nested).layerGate("p", 1);
  assert.deepEqual(gate.findings, []);
  assert.equal(reads(() => graphsOf(nested).layerGate("p", 1)), 2 + 1 + 1,
    "two record gets + one snapshot + the one Source body — a lawful Source id needs no prefix");
  assert.ok(gate.closure?.external.some(check => check.kind === "source" && check.ref.id === source.id));
});

test("LAYERGATE1-01: an opaque Source view cannot borrow the physical source memo of a mixed scope", t => {
  const f = fixture(t);
  const location = join(f.directory, "valid.txt");
  writeFileSync(location, "original");
  const source = f.store.write<Source>({ id: "document:p:legal", kind: "source", expected: 0,
    value: { projectId: "p", origin: { kind: "file", location }, content: "original", mediaType: "text/plain", sha256: digest("original") } });
  writeLayer(f.store, [reference(source)]);
  const altered = { ...source, value: { ...source.value, origin: { ...source.value.origin, location: join(f.directory, "missing") } } } as unknown as Revision;
  const view = storeView(f.store, { get: id => id === source.id ? altered : undefined,
    write: () => { throw new Error("read-only probe"); } });
  const cold = graphsOf(view).layerGate("p", 1);
  assert.ok(cold.findings.some(finding => finding.code === "graph_evidence_stale" && finding.target === source.id));
  const warm = withGraphRead(() => {
    assert.deepEqual(graphsOf(f.store).layerGate("p", 1).findings, [], "the physical gate warms the shared source memo");
    return graphsOf(view).layerGate("p", 1);
  });
  assert.deepEqual(warm, cold, "an opaque view's own body decides — the physical memo is not borrowed");
});

test("LAYERGATE1-01: an opaque view rechecks a changed graph projection after the first derivation", t => {
  const f = fixture(t);
  const value = { version: 1, id: "map", title: "original", nodes: [], contracts: [], artifacts: [],
    connectors: [], anchors: [], joins: [], tests: [], horizon: [] } as unknown as Graph;
  const graph = f.store.write({ id: "graph:p", kind: "graph", expected: 0, value });
  const projection = projectGraph(value, 1);
  layerRecord(f.store, { projection, inputs: [], obligations: [],
    layerProofs: [{ level: 1, hash: hashJson(projection), inputs: [] }] });
  let changed = false;
  const view = storeView(f.store, {
    get: id => id === graph.id ? { ...graph, value: { ...value, title: changed ? "projected replacement" : "original" } } as unknown as Revision : undefined,
    write: () => { throw new Error("read-only probe"); } });
  const repository = graphsOf(view);
  const warm = withGraphRead(() => {
    assert.deepEqual(repository.layerGate("p", 1).findings, []);
    changed = true;
    return repository.layerGate("p", 1);
  });
  const cold = repository.layerGate("p", 1);
  assert.ok(cold.findings.some(finding => finding.code === "graph_layer_unproven" && finding.target === "L1"));
  assert.deepEqual(warm, cold, "a previous hash does not certify later bytes from an opaque view");
});

test("LAYERGATE1-01: an opaque view rechecks a changed obligation field after the first derivation", t => {
  const f = fixture(t);
  const original = layerRecord(f.store, { projection: { nodes: [{ id: "node", title: "original" }] }, inputs: [],
    obligations: [{ node: "node", field: "title", valueHash: hashJson("original"), inputs: [] }] });
  let changed = false;
  const view = storeView(f.store, {
    get: id => id === original.id ? { ...original, value: { ...(original.value as Record<string, unknown>),
      projection: { nodes: [{ id: "node", title: changed ? "projected replacement" : "original" }] } } } as unknown as Revision : undefined,
    write: () => { throw new Error("read-only probe"); } });
  const repository = graphsOf(view);
  const warm = withGraphRead(() => {
    assert.deepEqual(repository.layerGate("p", 1).findings, []);
    changed = true;
    return repository.layerGate("p", 1);
  });
  const cold = repository.layerGate("p", 1);
  assert.ok(cold.findings.some(finding => finding.code === "graph_field_unproven" && finding.target === "node/title"));
  assert.deepEqual(warm, cold, "an obligation must use the currently returned view body");
});

test("LG1: 100 unrelated records add no reads to the gate — the snapshot selects by id", t => {
  const f = fixture(t);
  const inputs = [plain(f.store, "research:p:n1"), plain(f.store, "research:p:n2"), documentSource(f, "n", "n")].map(reference);
  writeLayer(f.store, inputs);
  const graphs = graphsOf(f.store);
  const baseline = reads(() => graphs.layerGate("p", 1));
  f.store.writeMany(Array.from({ length: 100 }, (_v, index) =>
    ({ id: `noise:other:${index}`, kind: "noise", expected: 0, value: { index } })));
  assert.equal(reads(() => graphs.layerGate("p", 1)), baseline,
    "a 10x history of unrelated ids does not widen the gate's reads");
});

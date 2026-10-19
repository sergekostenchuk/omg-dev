import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { LEVEL, type Graph } from "../src/graph/model.js";
import type { CarriedObligation } from "../src/graph/obligation-policy.js";
import { projectGraph } from "../src/graph/project.js";
import { RefinementRelations } from "../src/graph/relations.js";
import { obligationHandoff } from "../src/graph/obligation-handoff.js";
import { readinessObligations } from "../src/graph/obligation-readiness.js";
import { bindTaskObligations, taskObligationHandoff, taskBindingId } from "../src/graph/task-obligations.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Write } from "../src/storage/store.js";
import { writeOmInput, type OmInputRecord } from "../src/om/input.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { writeHorizon } from "../src/om/horizon.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { writeGapLines, type GapLinesRecord } from "../src/om/gap-lines.js";
import { WORKS_FRAME_CONTRACT } from "../src/om/frame-obligations.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import { OM_OBLIGATION_CONTRACT, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, normalizeOwnerGapAssignment, readOwnerGapAssignment, type OwnerGapAssignment, prepareOmObligations, writeOmObligations, readOmObligations,
  readOmObligationHandoff, readOmObligationLedger, type ObligationRequest, type OmObligationProducer, type OmObligationRecord,
  OM_OBLIGATION_TRANSFER_CONTRACT, OM_OBLIGATION_TRANSFER_KIND, prepareObligationTransfer, readObligationTransfer,
  type ObligationTransferRequest, type ObligationTransferRecord, type OmObligations } from "../src/om/obligations.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { gardenGraph, prepareNativeLayers, refusedWith, thrownWith } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

const clone = structuredClone;
const sameRef = (a: Ref, b: Ref): boolean => canonical(a) === canonical(b);
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function ok<T>(value: OmResult<T>): T {
  if (!value.ok) assert.fail(`Unexpected ${value.refusal.code}: ${value.refusal.message}`);
  return value.value;
}
function denied(value: OmResult<unknown>, code: string | readonly string[]): Refusal {
  const refusal = refusedWith(value, code);
  assert.ok(refusal.at.target.length > 0);
  assert.ok(refusal.at.field || refusal.at.ref);
  assert.ok(["producer", "gap", "owner", "readiness"].includes(refusal.route));
  return refusal;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "obligation_request_invalid");
  return true;
}

/** Native B1 -> horizon -> D1 -> D2, before accepted operation or work layers. */
function fixture(t: TestContext, kinds: Array<"environment-confirmation" | "post-implementation-proof"> = [], multipleConsumers = false, unacceptedBridge = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-obligations-")), database = join(root, "state.sqlite");
  const store = new Store(database), engine = new ProductEngine(store), project = "garden";
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "README.md"), "Deterministic native first-pass garden product.\n");
  const desired = gardenGraph(), lateConsumer = multipleConsumers ? "garden-later-operation" : "garden-produce-block";
  if (multipleConsumers) {
    desired.nodes.find(node => node.id === lateConsumer)!.parent = "garden-produce-block";
    desired.edges!.push({ id: "late-consumer-realizes-later", relation: "realizes", source: lateConsumer,
      target: "garden-later-block", condition: "One operation serves both retained consumers" });
  }
  const { level: _level, ...projection } = projectGraph(desired, 1);
  preparedFeatures(engine, project, projection as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation" && kinds.length) (value as Record<string, Json>).unknowns = kinds.map((kind, index) => ({
      id: `late-${index}`, question: `Which ${kind} is required for the repository?`, consumer: lateConsumer,
      moment: kind === "environment-confirmation" ? "task-start" : "task-result", blocksCurrentStage: false, resolution: "Address the retained question during OM",
    }));
    return value;
  });
  if (multipleConsumers) {
    const command = { executable: process.execPath, args: ["--version"] };
    engine.environments.configure(project, { workspace: root,
      implementer: { actor: "assignment-researcher", model: "fixture", effort: "high", command },
      reviewer: { actor: "assignment-reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 10_000 }, 0);
    // LG13-pre2 (№7640 п.2): the two consumers stand on a real accepted OM N2 of this changed graph — the exact
    // graph-layer:2 and om-frame:2 the L3 reads name as their upper witness — never on Refinement phases.
    prepareNativeLayers(engine, project, desired, "n2");
  }
  if (unacceptedBridge) {
    const original = store.get<Graph>(`graph:${project}`)!, graph = clone(original.value);
    const bridge = { ...clone(desired.nodes.find(node => node.id === "garden-produce-operation")!), id: "unaccepted-bridge", parent: "garden-produce-block" };
    graph.nodes.push(bridge);
    graph.edges!.push({ id: "accepted-to-unaccepted", relation: "realizes", source: "garden-later-block", target: bridge.id, condition: "Unaccepted lower proposal" });
    store.write({ id: original.id, kind: original.kind, expected: original.revision, value: graph });
    const layer = store.get<{ projection: unknown }>(`graph-layer:${project}:2`)!;
    store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value: { ...layer.value, projection: projectGraph(graph, 2) } });
  }
  // The N2 producer wrote B1 itself; the single-consumer pass stays before N2 and writes its first B1 here.
  let input = multipleConsumers ? store.get<OmInputRecord>(`om-input:${project}`)! : ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const graph = store.get<Graph>(`graph:${project}`)!, upper = store.get(`graph-layer:${project}:2`)!;
  const upperFrame = multipleConsumers ? reference(store.get(`om-frame:${project}:2`)!) : null;
  if (kinds.length) input = ok(writeAddressing(store, { project, input: reference(input), graph: reference(graph),
    decisions: kinds.map((kind, index) => ({ pending: inputDecisionWrite({ project, input: reference(input), graph: reference(graph), layers: multipleConsumers ? [reference(upper)] : [],
      decision: { target: `discovery:late-${index}`, field: "address", value: { consumer: lateConsumer, kind } } }) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: multipleConsumers ? reference(upper) : null,
    available: {}, choice: { choiceVersion: "obligation-first-pass", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const source: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: multipleConsumers ? reference(upper) : null, frame: upperFrame, upper: null } },
    works: multipleConsumers ? { proposals: [], frame: { project, level: 3, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: upperFrame } } } : { state: "upper-not-accepted", layer: reference(upper) } };
  const gaps = ok(writeGaps(store, source));
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const request: ObligationRequest = { project, gaps: gapRead, lines: reference(lines), assignments: [] };
  return { root, database, store, engine, project, graph, upper, input, horizon, gaps, lines, request };
}

test("D7 derives an explicit empty late ledger from native D1/D2 and all obligation readers retain its OM era", t => {
  const f = fixture(t);
  assert.ok(f.graph.value.nodes.every(node => LEVEL[node.kind] <= 1));
  assert.equal(f.engine.graphs.layerIsDerived(f.project, 2), false);
  assert.equal(f.engine.graphs.layerIsDerived(f.project, 3), false);
  assert.equal(f.store.get(`phase:${f.project}:R2`), null);
  assert.equal(f.store.get(`phase:${f.project}:L3`), null);
  assert.ok(f.gaps.collection.gaps.length > 0);
  assert.ok(f.gaps.collection.gaps.every(gap => gap.moment === "om-pass"));
  assert.ok(f.lines.value.lines.length > 0);
  const before = revisions(f.store), prepared = ok(prepareOmObligations(f.store, f.request));
  assert.deepEqual(revisions(f.store), before, "Preparation must not publish an obligation basis");
  assert.equal(prepared.producer.kind, "om-obligation-basis");
  assert.equal(prepared.record.kind, "om-obligations");
  assert.equal(prepared.producer.value.contract, OM_OBLIGATION_CONTRACT);
  assert.equal(prepared.record.value.contract, OM_OBLIGATION_CONTRACT);
  assert.deepEqual(prepared.record.value.assignments, []);
  assert.deepEqual(prepared.producer.value.ledger, reference(prepared.record));
  const saved = ok(writeOmObligations(f.store, f.request));
  assert.deepEqual(saved.producer, prepared.producer);
  assert.deepEqual(saved.record, prepared.record);
  assert.deepEqual(saved.handoff.obligations, []);
  assert.deepEqual(saved.handoff.producer, reference(saved.producer));
  assert.deepEqual(saved.handoff.scope, reference(saved.record));
  assert.ok(saved.inputs.some(ref => sameRef(ref, reference(saved.producer))));
  assert.ok(saved.inputs.some(ref => sameRef(ref, reference(saved.record))));
  const inputs = clone(saved.inputs) as Ref[];
  assert.deepEqual(ok(readOmObligationHandoff(f.store, f.project, inputs)), saved.handoff);
  assert.deepEqual(obligationHandoff(f.store, f.project, inputs), saved.handoff);
  assert.deepEqual(taskObligationHandoff(f.store, f.project, inputs), saved.handoff);
  const handoff = obligationHandoff(f.store, f.project, inputs);
  const explicit = { ...clone(f.graph.value), researchObligations: [] };
  assert.deepEqual(bindTaskObligations(f.store, f.project, explicit, handoff).findings, []);
  const absent = clone(explicit) as Graph; delete absent.researchObligations;
  assert.ok(bindTaskObligations(f.store, f.project, absent, handoff).findings.some(item => item.code === "task_obligation_bindings_missing"));
  const readiness = readinessObligations(f.store, f.project, inputs);
  assert.deepEqual(readiness.findings, []);
  assert.deepEqual(readiness.value, { handoff: saved.handoff, confirmations: [] });
  assert.deepEqual(readinessObligations(f.store, f.project, inputs, readiness.value, "consume", true).findings, []);
  assert.ok(readinessObligations(f.store, f.project, inputs, undefined, "consume", true).findings
    .some(item => item.code === "obligation_handoff_missing"), "An OM empty set still requires an explicit saved readiness handoff");
  const loaded = ok(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) }));
  assert.deepEqual(loaded.producer, saved.producer);
  assert.deepEqual(loaded.record, saved.record);
  assert.deepEqual(loaded.handoff, saved.handoff);
  assert.ok(loaded.inputs.every(ref => saved.inputs.some(input => sameRef(input, ref))), "Admission retains the historical context and its current guarded source closure");
  assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.record.value.assignments) && Object.isFrozen(loaded.handoff.obligations));
  const after = revisions(f.store), reused = ok(prepareOmObligations(f.store, f.request));
  assert.deepEqual(reused.writes, []);
  assert.deepEqual(reused.producer, saved.producer);
  assert.deepEqual(reused.record, saved.record);
  assert.deepEqual(ok(writeOmObligations(f.store, f.request)).handoff, saved.handoff);
  assert.deepEqual(revisions(f.store), after, "Replay must reuse the exact saved producer and ledger");
});

test("D7 omitted producer or ledger inputs cannot become legacy no-obligation success", t => {
  const f = fixture(t), saved = ok(writeOmObligations(f.store, f.request));
  for (const [removed, code] of [[saved.producer.id, "obligation_basis_missing"], [saved.record.id, "obligation_ledger_missing"]] as const) {
    const inputs = saved.inputs.filter(ref => ref.id !== removed) as Ref[];
    denied(readOmObligationHandoff(f.store, f.project, inputs), code);
    thrownWith(() => obligationHandoff(f.store, f.project, inputs), code);
    thrownWith(() => taskObligationHandoff(f.store, f.project, inputs), code);
    assert.ok(readinessObligations(f.store, f.project, inputs).findings.some(item => item.code === code));
  }
  assert.equal(ok(readOmObligationHandoff(f.store, f.project, [])), null);
  assert.equal(obligationHandoff(f.store, f.project, []), null);
  assert.equal(taskObligationHandoff(f.store, f.project, []), null);
  assert.equal(readinessObligations(f.store, f.project, []).value, undefined);
});

test("D7 duplicate producer and ledger inputs cannot select an ambiguous obligation basis", t => {
  const f = fixture(t), saved = ok(writeOmObligations(f.store, f.request)), before = revisions(f.store);
  for (const [duplicate, code] of [[reference(saved.producer), "obligation_basis_missing"], [reference(saved.record), "obligation_ledger_missing"]] as const) {
    const inputs = [...saved.inputs, duplicate] as Ref[];
    denied(readOmObligationHandoff(f.store, f.project, inputs), code);
    thrownWith(() => obligationHandoff(f.store, f.project, inputs), code);
    thrownWith(() => taskObligationHandoff(f.store, f.project, inputs), code);
    assert.ok(readinessObligations(f.store, f.project, inputs).findings.length > 0);
  }
  const duplicateGaps = { ...f.request, gaps: { ...f.request.gaps, records: [...f.request.gaps.records, f.request.gaps.records[0]!] } };
  denied(prepareOmObligations(f.store, duplicateGaps), "gap_duplicate");
  denied(writeOmObligations(f.store, duplicateGaps), "gap_duplicate");
  assert.deepEqual(revisions(f.store), before);
});

test("D7 D1 and D2 must name the same native horizon even when their open gap identities match", t => {
  const f = fixture(t);
  const nextHorizon = ok(writeHorizon(f.store, { project: f.project, input: reference(f.input), graph: reference(f.graph),
    refinement: null, available: {}, choice: { choiceVersion: "obligation-second-pass", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { ...f.request.gaps.sources, horizon: reference(nextHorizon.gate),
    operations: { ...f.request.gaps.sources.operations, frame: { ...f.request.gaps.sources.operations.frame, horizon: reference(nextHorizon.gate) } } };
  const nextGaps = ok(writeGaps(f.store, sources));
  assert.deepEqual(nextGaps.collection.gaps.map(gap => gap.id), f.gaps.collection.gaps.map(gap => gap.id));
  const mismatched: ObligationRequest = { ...f.request, gaps: { sources: structuredClone(nextGaps.sources) as GapRequest, records: nextGaps.records.map(reference) } };
  const before = revisions(f.store);
  denied(prepareOmObligations(f.store, mismatched), "obligation_context_mismatch");
  denied(writeOmObligations(f.store, mismatched), "obligation_context_mismatch");
  assert.deepEqual(revisions(f.store), before);
  assert.deepEqual(f.store.list("om-obligation-basis"), []);
  assert.deepEqual(f.store.list("om-obligations"), []);
});

test("D7 unavailable records, foreign references and forged hashes are addressed refusals on every reader", t => {
  const f = fixture(t), saved = ok(writeOmObligations(f.store, f.request)), before = revisions(f.store);
  for (const victim of [saved.producer, saved.record]) {
    const original = f.store.get.bind(f.store);
    try {
      f.store.get = ((id: string, revision?: number) => id === victim.id ? null : original(id, revision)) as Store["get"];
      denied(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) }), "record_missing");
      denied(readOmObligationHandoff(f.store, f.project, clone(saved.inputs) as Ref[]), "record_missing");
      thrownWith(() => obligationHandoff(f.store, f.project, clone(saved.inputs) as Ref[]), "record_missing");
      thrownWith(() => taskObligationHandoff(f.store, f.project, clone(saved.inputs) as Ref[]), "record_missing");
      assert.ok(readinessObligations(f.store, f.project, clone(saved.inputs) as Ref[]).findings.some(item => item.code === "record_missing"));
    } finally { f.store.get = original; }
    const inputs = saved.inputs.map(ref => ref.id === victim.id ? { ...ref, hash: "0".repeat(64) } : ref) as Ref[];
    const forgedCode = victim === saved.producer ? "record_forged" : "obligation_ledger_missing";
    denied(readOmObligationHandoff(f.store, f.project, inputs), forgedCode);
    thrownWith(() => obligationHandoff(f.store, f.project, inputs), forgedCode);
    thrownWith(() => taskObligationHandoff(f.store, f.project, inputs), forgedCode);
    assert.ok(readinessObligations(f.store, f.project, inputs).findings.length > 0);
  }
  denied(readOmObligations(f.store, { project: f.project, producer: { ...reference(saved.producer), hash: "0".repeat(64) } }), "record_forged");
  denied(readOmObligations(f.store, { project: "gardens", producer: reference(saved.producer) }), "record_foreign");
  denied(readOmObligationHandoff(f.store, "gardens", clone(saved.inputs) as Ref[]), "record_foreign");
  assert.deepEqual(revisions(f.store), before);
  const foreign = f.store.write({ id: `${saved.producer.id}:foreign-kind`, kind: "counterfeit", expected: 0, value: saved.producer.value });
  denied(readOmObligations(f.store, { project: f.project, producer: reference(foreign) }), "record_foreign");
  const inputs = saved.inputs.map(ref => ref.id === saved.producer.id ? reference(foreign) : ref) as Ref[];
  denied(readOmObligationHandoff(f.store, f.project, inputs), "record_foreign");
});

test("D7 rejects mixed OM and legacy R2 or L3 eras before interpreting either as an empty handoff", t => {
  const f = fixture(t), saved = ok(writeOmObligations(f.store, f.request)), before = revisions(f.store);
  for (const phases of [["R2"], ["L3"], ["R2", "L3"]]) {
    const inputs = [...saved.inputs, ...phases.map(phase => ({ id: `phase:${f.project}:${phase}`, revision: 1, hash: hashJson(phase) }))] as Ref[];
    denied(readOmObligationHandoff(f.store, f.project, inputs), "obligation_era_conflict");
    thrownWith(() => obligationHandoff(f.store, f.project, inputs), "obligation_era_conflict");
    thrownWith(() => taskObligationHandoff(f.store, f.project, inputs), "obligation_era_conflict");
    assert.ok(readinessObligations(f.store, f.project, inputs).findings.some(item => item.code === "obligation_era_conflict"));
  }
  assert.deepEqual(revisions(f.store), before);
  assert.equal(f.store.get(`phase:${f.project}:R2`), null);
  assert.equal(f.store.get(`phase:${f.project}:L3`), null);
});

test("D7 mandatory source shapes fail with typed errors before store access", t => {
  const f = fixture(t), before = revisions(f.store);
  const broken: unknown[] = [undefined, null, {}, { ...f.request, project: "" }, { ...f.request, gaps: undefined },
    { ...f.request, assignments: undefined }, { ...f.request, assignments: null }, { ...f.request, assignments: [{}] },
    { ...f.request, lines: undefined }, { ...f.request, lines: null }, { ...f.request, gaps: { records: [] } },
    { ...f.request, gaps: { ...f.request.gaps, records: undefined } }, { ...f.request, gaps: { ...f.request.gaps, sources: undefined } }];
  for (const request of broken) for (const action of [prepareOmObligations, writeOmObligations]) {
    assert.throws(() => action(undefined as unknown as Store, request as ObligationRequest), malformed);
    assert.throws(() => action(f.store, request as ObligationRequest), malformed);
  }
  for (const request of [undefined, null, {}, { project: f.project }, { project: "", producer: reference(f.input) }, { project: f.project, producer: null }]) {
    assert.throws(() => readOmObligations(undefined as unknown as Store, request as Parameters<typeof readOmObligations>[1]), malformed);
    assert.throws(() => readOmObligations(f.store, request as Parameters<typeof readOmObligations>[1]), malformed);
  }
  for (const request of [undefined, null, {}, { project: f.project }, { project: "", ledger: reference(f.input), record: reference(f.input) },
    { project: f.project, ledger: null, record: null }]) {
    assert.throws(() => readOmObligationLedger(f.store, request as Parameters<typeof readOmObligationLedger>[1]), malformed);
    assert.throws(() => readOwnerGapAssignment(f.store, request as Parameters<typeof readOwnerGapAssignment>[1]), malformed);
  }
  for (const inputs of [undefined, null, {}, [null], [{ id: "om-obligation-basis:garden:missing" }]]) {
    assert.throws(() => readOmObligationHandoff(undefined as unknown as Store, f.project, inputs as Ref[]), malformed);
    assert.throws(() => readOmObligationHandoff(f.store, f.project, inputs as Ref[]), malformed);
  }
  for (const project of [undefined, null, "", " "]) {
    assert.throws(() => readOmObligationHandoff(f.store, project as string, []), malformed);
  }
  assert.deepEqual(revisions(f.store), before);
});

test("D7 rehashed ledger and producer counterfeits cannot claim a valid native context", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const f = fixture(t), saved = ok(writeOmObligations(f.store, f.request));
  const ledgerMutations: Array<(record: OmObligationRecord) => void> = [
    record => { delete (record as Partial<OmObligationRecord>).assignments; },
    record => { record.project = "gardens"; },
    record => { record.request.lines.hash = "0".repeat(64); },
    record => { record.request.gaps.records.pop(); },
  ];
  for (const mutate of ledgerMutations) {
    const value = clone(saved.record.value) as OmObligationRecord; mutate(value);
    const forged = f.store.write<OmObligationRecord>({ id: saved.record.id, kind: saved.record.kind,
      expected: f.store.get(saved.record.id)!.revision, value });
    assert.equal(forged.hash, hashJson(value), "The store hash alone must not certify a semantic ledger");
    const producerValue = { ...clone(saved.producer.value), ledger: reference(forged) } as OmObligationProducer;
    const producer = f.store.write<OmObligationProducer>({ id: saved.producer.id, kind: saved.producer.kind,
      expected: f.store.get(saved.producer.id)!.revision, value: producerValue });
    const inputs = saved.inputs.map(ref => ref.id === saved.producer.id ? reference(producer) : ref.id === saved.record.id ? reference(forged) : ref) as Ref[];
    const before = revisions(f.store);
    denied(readOmObligations(f.store, { project: f.project, producer: reference(producer) }), "obligation_record_invalid");
    denied(readOmObligationHandoff(f.store, f.project, inputs), "obligation_record_invalid");
    thrownWith(() => obligationHandoff(f.store, f.project, inputs), "obligation_record_invalid");
    thrownWith(() => taskObligationHandoff(f.store, f.project, inputs), "obligation_record_invalid");
    assert.deepEqual(ok(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) })).handoff, saved.handoff);
    assert.deepEqual(revisions(f.store), before);
  }
  for (const [mutate, mutateCode] of [
    [(record: OmObligationProducer) => { record.request.project = "gardens"; }, "obligation_context_mismatch"],
    [(record: OmObligationProducer) => { record.request.lines = reference(f.input); }, "record_foreign"],
    [(record: OmObligationProducer) => { delete (record as Partial<OmObligationProducer>).ledger; }, "obligation_record_invalid"],
  ] as const) {
    const value = clone(saved.producer.value) as OmObligationProducer; mutate(value);
    const forged = f.store.write<OmObligationProducer>({ id: saved.producer.id, kind: saved.producer.kind,
      expected: f.store.get(saved.producer.id)!.revision, value });
    assert.equal(forged.hash, hashJson(value));
    denied(readOmObligations(f.store, { project: f.project, producer: reference(forged) }), mutateCode);
  }
});

test("D7 new and reused preparations guard native sources inside the consumer transaction", async t => {
  const f = fixture(t), fresh = ok(prepareOmObligations(f.store, f.request));
  const before = await f.store.snapshot(join(f.root, "before-obligations"));
  const saved = ok(writeOmObligations(f.store, f.request)), reused = ok(prepareOmObligations(f.store, f.request));
  const after = await f.store.snapshot(join(f.root, "after-obligations"));
  for (const [name, prepared, snapshot] of [["new", fresh, before], ["reused", reused, after]] as const) {
    const dependencies = [reference(f.graph), reference(f.upper), reference(f.input), reference(f.lines), f.request.gaps.records[0]!];
    if (name === "reused") dependencies.push(reference(saved.producer), reference(saved.record));
    for (const [index, dependency] of dependencies.entries()) {
      assert.ok(prepared.guards.some(ref => !('absent' in ref) && sameRef(ref, dependency)), `${name}: missing guard for ${dependency.id}`);
      const path = join(f.root, `${name}-${index}.sqlite`); copyFileSync(snapshot.path, path);
      const branch = new Store(path);
      try {
        const old = branch.get(dependency.id)!;
        branch.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
        const current = revisions(branch);
        denied(writeGuarded(branch, { unit: "D7-consumer", target: "native-obligation-consumer", guards: prepared.guards,
          writes: [...prepared.writes, { id: "native-obligation-consumer", kind: "native-obligation-consumer", expected: 0,
            value: { inputs: prepared.inputs, handoff: prepared.handoff } }] }), "input_stale");
        assert.equal(branch.get("native-obligation-consumer"), null);
        if (name === "new") {
          assert.equal(branch.get(fresh.producer.id), null);
          assert.equal(branch.get(fresh.record.id), null);
        }
        assert.deepEqual(revisions(branch), current, "A raced transaction may publish neither the basis nor its consumer");
      } finally { branch.close(); }
    }
  }
});

test("D7 pinned OM history survives source head advances and restart while fresh preparation refuses stale sources", t => {
  const f = fixture(t), saved = ok(writeOmObligations(f.store, f.request)), inputs = clone(saved.inputs) as Ref[];
  const history = ok(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) }));
  for (const dependency of [reference(f.graph), reference(f.lines)]) {
    const old = f.store.get(dependency.id)!;
    f.store.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
  }
  const before = revisions(f.store);
  denied(prepareOmObligations(f.store, f.request), "input_stale");
  denied(writeOmObligations(f.store, f.request), "input_stale");
  assert.deepEqual(ok(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) })), history);
  assert.deepEqual(ok(readOmObligationHandoff(f.store, f.project, inputs)), saved.handoff);
  assert.deepEqual(revisions(f.store), before);
  f.store.close();
  const reopened = new Store(f.database);
  try {
    assert.deepEqual(ok(readOmObligations(reopened, { project: f.project, producer: reference(saved.producer) })), history);
    assert.deepEqual(obligationHandoff(reopened, f.project, inputs), saved.handoff);
    assert.deepEqual(taskObligationHandoff(reopened, f.project, inputs), saved.handoff);
    const readiness = readinessObligations(reopened, f.project, inputs);
    assert.deepEqual(readiness.findings, []);
    assert.deepEqual(readiness.value?.handoff, saved.handoff);
    denied(prepareOmObligations(reopened, f.request), "input_stale");
    assert.deepEqual(revisions(reopened), before);
  } finally { reopened.close(); }
});

/** H2's declared command producer records one exact owner contract, never a model proposal. */
function ownerAssignment(f: ReturnType<typeof fixture>, index = 0): OwnerGapAssignment {
  const gap = f.gaps.records.find(row => row.value.gap.target === `discovery:late-${index}`)!;
  assert.ok(gap, "An owner assignment needs an actual retained D1 gap");
  return clone(normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project: f.project,
    context: { gaps: f.request.gaps, lines: f.request.lines }, gap: reference(gap),
    assignments: gap.value.gap.consumers.map(consumer => ({ responsibleNode: consumer, responsibleConsumer: consumer,
      reason: `The owner retains this condition for ${consumer}`, returnCondition: `Verify ${consumer} readiness for late-${index}`,
      wake: null })) })) as OwnerGapAssignment;
}
function ownerWrite(value: OwnerGapAssignment): Write {
  return { id: `om-owner-gap-assignment:${value.project}:${hashJson(value)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value };
}
function pendingOwners(f: ReturnType<typeof fixture>): ObligationRequest {
  return { ...f.request, assignments: f.input.value.input.questions.map((_, index) => ({ pending: ownerWrite(ownerAssignment(f, index)) })) };
}

test("D7 native D3 late questions retain kind, deadline and original address; the bypass carries to its consumer only what a work proves itself, H2 replaces that by its explicit assignment without closing or advancing anything", t => {
  const f = fixture(t, ["environment-confirmation", "post-implementation-proof"]);
  const late = f.gaps.records.filter(row => row.value.gap.moment !== "om-pass");
  assert.equal(late.length, 2);
  assert.deepEqual(late.map(row => row.value.gap.moment).sort(), ["task-result", "task-start"]);
  assert.equal(f.store.get("phase:garden:R2"), null); assert.equal(f.store.get("phase:garden:L3"), null);
  const before = revisions(f.store);
  // OWN1 (№3711, №3716): without H2 the engine carries a late gap to its own consumer, with what the pass knows of its own
  // database; the question stays as it is. OWN1.2 (№3806, №3809): only a gap a work proves itself (its tests at task
  // result) — the environment one without H2 has no consumer proof, stays open in B1 and is not carried.
  const bypass = ok(prepareOmObligations(f.store, f.request));
  assert.equal(bypass.writes.length, 2, "Only the producer and its ledger; no owner command is invented");
  assert.deepEqual(revisions(f.store), before);
  const proven = late.filter(row => row.value.gap.kind === "post-implementation-proof");
  assert.equal(proven.length, 1);
  assert.deepEqual(bypass.record.value.assignments.map(row => [row.obligation, row.responsibleNode, row.responsibleConsumer, row.returnCondition]),
    proven.map(row => [row.value.gap.id, "garden-produce-block", "garden-produce-block",
      f.input.value.input.questions.find(q => q.id === row.value.gap.target)!.question]));
  for (const row of bypass.record.value.assignments)
    assert.match(row.reason, /^Assigned by the engine in the bypass: the consumer answers it at task-result\. Own database facts at this pass: stages discovery stage:garden:discovery@\d+, .*; layers L2 .*; accepted nodes \d+\.$/);
  const request = pendingOwners(f), prepared = ok(prepareOmObligations(f.store, request));
  assert.equal(prepared.writes.length, 4, "Two H2 contracts and the complete producer/ledger are one transaction");
  assert.deepEqual(revisions(f.store), before);
  const saved = ok(writeOmObligations(f.store, request));
  assert.equal(saved.handoff.obligations.length, 2);
  for (const obligation of saved.handoff.obligations) {
    const source = late.find(row => sameRef(reference(row), obligation.original.record))!;
    assert.ok(source);
    assert.equal(obligation.original.pointer, "/gap");
    assert.equal(obligation.kind, source.value.gap.kind);
    assert.equal(obligation.moment, source.value.gap.moment);
    assert.equal(obligation.obligation, source.value.gap.id);
    assert.equal(obligation.responsibleNode, "garden-produce-block");
    assert.equal(obligation.responsibleConsumer, "garden-produce-block");
    assert.equal(obligation.wake, null);
    assert.equal(obligation.neededForR2, false);
    assert.notEqual(obligation.returnCondition, f.input.value.input.questions.find(q => q.id === source.value.gap.target)!.question);
  }
  for (const original of before) assert.deepEqual({ head: reference(f.store.get(original.head.id)!), history: f.store.history(original.head.id).map(reference) }, original,
    `D7 must preserve ${original.head.id}`);
  assert.equal(f.store.list("attempt-series").length, 0);
  assert.deepEqual(obligationHandoff(f.store, f.project, clone(saved.inputs) as Ref[]), saved.handoff);
  assert.deepEqual(taskObligationHandoff(f.store, f.project, clone(saved.inputs) as Ref[]), saved.handoff);
  const after = revisions(f.store), repeated = ok(writeOmObligations(f.store, request));
  assert.deepEqual(repeated.writes, []); assert.deepEqual(repeated.handoff, saved.handoff); assert.deepEqual(revisions(f.store), after);
  const historical = ok(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) }));
  assert.deepEqual(ok(readOmObligationLedger(f.store, { project: f.project, ledger: reference(saved.record) })), historical);
  f.store.close(); const reopened = new Store(f.database);
  try { assert.deepEqual(ok(readOmObligations(reopened, { project: f.project, producer: reference(saved.producer) })), historical); }
  finally { reopened.close(); }
});

test("D7 H2 source must be complete, canonical, foreign-free and authoritative before preparation or write", t => {
  const f = fixture(t, ["environment-confirmation"]), valid = ownerAssignment(f);
  const mutations: Array<[string, (value: OwnerGapAssignment) => void]> = [
    ["missing wake", value => { delete (value.assignments[0] as Partial<OwnerGapAssignment["assignments"][number]>).wake; }],
    ["missing reason", value => { delete (value.assignments[0] as Partial<OwnerGapAssignment["assignments"][number]>).reason; }],
    ["missing return condition", value => { delete (value.assignments[0] as Partial<OwnerGapAssignment["assignments"][number]>).returnCondition; }],
    ["empty return condition", value => { value.assignments[0]!.returnCondition = " "; }],
    ["partial consumers", value => { value.assignments = []; }],
    ["duplicate consumers", value => { value.assignments.push(clone(value.assignments[0]!)); }],
    ["extra consumer", value => { value.assignments.push({ ...clone(value.assignments[0]!), responsibleNode: "garden-consume-block", responsibleConsumer: "garden-consume-block" }); }],
    ["foreign node", value => { value.assignments[0]!.responsibleNode = "garden-does-not-exist"; }],
    ["unaccepted node", value => { value.assignments[0]!.responsibleNode = "garden-produce-operation"; }],
    ["foreign consumer", value => { value.assignments[0]!.responsibleConsumer = "garden-consume-block"; }],
    ["kind override", value => { (value.assignments[0] as unknown as Record<string, unknown>).kind = "repository-fact"; }],
    ["moment override", value => { (value.assignments[0] as unknown as Record<string, unknown>).moment = "feasibility"; }],
    ["unknown kind", value => { (value.assignments[0] as unknown as Record<string, unknown>).kind = "invented"; }],
    ["unknown moment", value => { (value.assignments[0] as unknown as Record<string, unknown>).moment = "someday"; }],
    ["self-asserted acceptance", value => { (value as unknown as Record<string, unknown>).status = "accepted"; }],
    ["foreign context", value => { value.context.lines = reference(f.input); }],
    ["incomplete D1", value => { value.context.gaps.records.pop(); }],
    ["foreign gap", value => { value.gap = reference(f.gaps.records.find(row => row.value.gap.moment === "om-pass")!); }],
    ["unknown version", value => { (value as unknown as { contract: string }).contract = "om-owner-gap-assignment/v2"; }],
  ];
  for (const [name, mutate] of mutations) {
    const value = clone(valid); mutate(value);
    const request: ObligationRequest = { ...f.request, assignments: [{ pending: ownerWrite(value) }] };
    const before = revisions(f.store);
    denied(prepareOmObligations(f.store, request), "obligation_assignment_invalid");
    denied(writeOmObligations(f.store, request), "obligation_assignment_invalid");
    assert.deepEqual(revisions(f.store), before, name);
  }
  for (const [id, kind] of [[`om-proposal:${f.project}:not-owner`, "layer-proposal"],
    [`om-owner-gap-assignment:other:${hashJson(valid)}`, OM_OWNER_ASSIGNMENT_KIND],
    [`om-owner-gap-assignment:${f.project}:${hashJson(valid)}`, "decision"]]) {
    const record = f.store.write({ id: id!, kind: kind!, expected: 0, value: valid });
    const request: ObligationRequest = { ...f.request, assignments: [{ record: reference(record) }] };
    const before = revisions(f.store);
    denied(readOwnerGapAssignment(f.store, { project: f.project, record: reference(record) }), "record_foreign");
    denied(prepareOmObligations(f.store, request), "record_foreign"); denied(writeOmObligations(f.store, request), "record_foreign");
    assert.deepEqual(revisions(f.store), before);
  }
});

test("D7 exact runtime declarations keep source guards and explicit satisfies without claiming observation", t => {
  const f = fixture(t, ["environment-confirmation"]), value = ownerAssignment(f);
  writeFileSync(join(f.root, "proof.mjs"), "process.exit(0);\n");
  const script = f.engine.discovery.evidence.file(f.project, "late-proof", f.root, "proof.mjs", "text/plain", 0);
  const assignment = value.assignments[0]!;
  assignment.runtimeCheck = { script: reference(script), dependencies: [], subjects: ["garden-produce-block"], executables: [process.execPath], args: [],
    timeoutMs: 1000, purpose: "Observe the explicitly declared repository prerequisite", satisfies: assignment.returnCondition };
  const normalized = clone(normalizeOwnerGapAssignment(value)) as OwnerGapAssignment;
  for (const [mutate, mutateCode] of [
    [(candidate: OwnerGapAssignment) => { delete candidate.assignments[0]!.runtimeCheck!.satisfies; }, "obligation_assignment_invalid"],
    [(candidate: OwnerGapAssignment) => { candidate.assignments[0]!.runtimeCheck!.satisfies = "An unrelated property"; }, "obligation_assignment_invalid"],
    [(candidate: OwnerGapAssignment) => { candidate.assignments[0]!.runtimeCheck!.script = { ...reference(script), hash: "0".repeat(64) }; }, "record_forged"],
    [(candidate: OwnerGapAssignment) => { candidate.assignments[0]!.runtimeCheck!.dependencies = [{ id: "source:garden:absent", revision: 1, hash: "1".repeat(64) }]; }, "record_missing"],
  ] as const) {
    const candidate = clone(normalized); mutate(candidate);
    const before = revisions(f.store), request = { ...f.request, assignments: [{ pending: ownerWrite(candidate) }] };
    denied(prepareOmObligations(f.store, request), mutateCode); denied(writeOmObligations(f.store, request), mutateCode);
    assert.deepEqual(revisions(f.store), before);
  }
  const request: ObligationRequest = { ...f.request, assignments: [{ pending: ownerWrite(normalized) }] };
  const prepared = ok(prepareOmObligations(f.store, request));
  assert.ok(prepared.guards.some(ref => !('absent' in ref) && sameRef(ref, reference(script))));
  const saved = ok(writeOmObligations(f.store, request));
  assert.deepEqual(saved.handoff.obligations[0]!.runtimeCheck, assignment.runtimeCheck);
  assert.equal(f.store.list("runtime-observation").length, 0);
  const original = f.store.get(script.id)!;
  f.store.write({ id: original.id, kind: original.kind, expected: original.revision, value: original.value });
  denied(prepareOmObligations(f.store, request), "input_stale");
  assert.deepEqual(ok(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) })).handoff, saved.handoff);
});

test("D7 pending H2 assignments commit with the producer once; competing ownership and current-source races leave no partial handoff", async t => {
  const f = fixture(t, ["environment-confirmation"]), request = pendingOwners(f), fresh = ok(prepareOmObligations(f.store, request));
  const snapshot = await f.store.snapshot(join(f.root, "pending-owner"));
  const owner = fresh.writes.find(write => write.kind === OM_OWNER_ASSIGNMENT_KIND)!;
  assert.ok(owner, "A pending owner contract belongs to the same atomic write set");
  for (const [name, dependency, raceCode] of [["owner", null, "revision_conflict"], ["gap", request.gaps.records.find(ref => ref.id.includes(hashJson(["discovery:late-0", "answer"])))!, "input_stale"],
    ["input", reference(f.input), "input_stale"], ["lines", reference(f.lines), "input_stale"]] as const) {
    const path = join(f.root, `pending-race-${name}.sqlite`); copyFileSync(snapshot.path, path); const branch = new Store(path);
    try {
      if (dependency) { const old = branch.get(dependency.id)!; branch.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value }); }
      else branch.write(owner);
      const before = revisions(branch);
      denied(writeGuarded(branch, { unit: "D7", target: "pending-owner-race", writes: fresh.writes, guards: fresh.guards }), raceCode);
      assert.equal(branch.get(fresh.producer.id), null); assert.equal(branch.get(fresh.record.id), null);
      assert.deepEqual(revisions(branch), before);
    } finally { branch.close(); }
  }
  const saved = ok(writeOmObligations(f.store, request));
  const ownerRecord = f.store.get(owner.id)!;
  assert.ok(ok(prepareOmObligations(f.store, request)).guards.some(ref => !('absent' in ref) && sameRef(ref, reference(ownerRecord))));
  const historical = ok(readOwnerGapAssignment(f.store, { project: f.project, record: reference(ownerRecord) }));
  f.store.write({ id: ownerRecord.id, kind: ownerRecord.kind, expected: ownerRecord.revision, value: ownerRecord.value });
  denied(prepareOmObligations(f.store, request), "input_stale");
  assert.deepEqual(ok(readOwnerGapAssignment(f.store, { project: f.project, record: reference(ownerRecord) })), historical);
  const before = revisions(f.store); f.store.close(); const reopened = new Store(f.database);
  try {
    assert.deepEqual(ok(readOwnerGapAssignment(reopened, { project: f.project, record: reference(ownerRecord) })), historical);
    assert.deepEqual(ok(readOmObligations(reopened, { project: f.project, producer: reference(saved.producer) })).handoff, saved.handoff);
    denied(prepareOmObligations(reopened, request), "input_stale"); assert.deepEqual(revisions(reopened), before);
  } finally { reopened.close(); }
});

test("D7 one native gap with two accepted consumers requires two complete owner assignments and distinct new-era bindings", t => {
  const f = fixture(t, ["post-implementation-proof"], true), value = ownerAssignment(f);
  const gap = f.gaps.records.find(row => row.value.gap.target === "discovery:late-0")!;
  assert.deepEqual(gap.value.gap.consumers, ["garden-later-block", "garden-produce-block"]);
  assert.equal(f.engine.graphs.layerIsDerived(f.project, 2), true);
  assert.equal(f.store.get("phase:garden:R2"), null); assert.equal(f.store.get("phase:garden:L3"), null);
  for (const assignments of [value.assignments.slice(0, 1), [value.assignments[0]!, value.assignments[0]!],
    [...value.assignments, { ...value.assignments[0]!, responsibleNode: "garden-consume-block", responsibleConsumer: "garden-consume-block" }]]) {
    const request = { ...f.request, assignments: [{ pending: ownerWrite({ ...value, assignments }) }] };
    const before = revisions(f.store);
    denied(prepareOmObligations(f.store, request), "obligation_assignment_invalid"); denied(writeOmObligations(f.store, request), "obligation_assignment_invalid");
    assert.deepEqual(revisions(f.store), before);
  }
  const request = { ...f.request, assignments: [{ pending: ownerWrite(value) }] }, saved = ok(writeOmObligations(f.store, request));
  const obligations = clone(saved.handoff.obligations) as CarriedObligation[];
  assert.equal(obligations.length, 2);
  assert.deepEqual(taskObligationHandoff(f.store, f.project, clone(saved.inputs) as Ref[]), saved.handoff);
  assert.deepEqual(obligations.map(item => item.responsibleConsumer).sort(), gap.value.gap.consumers);
  assert.deepEqual(obligations[0]!.original, obligations[1]!.original);
  assert.notEqual(taskBindingId(obligations[0]!), taskBindingId(obligations[1]!));
  const reversed = clone(value); reversed.assignments.reverse(); reversed.context.gaps.records.reverse();
  const normalized = clone(normalizeOwnerGapAssignment(reversed)) as OwnerGapAssignment;
  assert.deepEqual(normalized, value);
  const before = revisions(f.store);
  assert.deepEqual(ok(writeOmObligations(f.store, { ...f.request, assignments: [{ pending: ownerWrite(normalized) }] })).writes, []);
  assert.deepEqual(revisions(f.store), before);
  const legacy = obligations.map(item => ({ ...item, scope: { ...item.scope, id: "research-scope:garden:R2" } }));
  assert.equal(taskBindingId(legacy[0]!), `obligation:${hashJson([legacy[0]!.scope, legacy[0]!.original]).slice(0, 40)}`);
  assert.equal(taskBindingId(legacy[0]!), taskBindingId(legacy[1]!), "The existing legacy identity algorithm is not retroactively changed");
  const history = ok(readOmObligations(f.store, { project: f.project, producer: reference(saved.producer) }));
  f.store.close(); const reopened = new Store(f.database);
  try { assert.deepEqual(ok(readOmObligations(reopened, { project: f.project, producer: reference(saved.producer) })), history); }
  finally { reopened.close(); }
});

test("D7 engine binds native OM task proof to concrete work without weakening the original consumer or proof checks", t => {
  const f = fixture(t, ["post-implementation-proof"]), saved = ok(writeOmObligations(f.store, pendingOwners(f)));
  const handoff = taskObligationHandoff(f.store, f.project, clone(saved.inputs) as Ref[])!;
  const obligation = clone(saved.handoff.obligations[0]!) as CarriedObligation;
  const graph = gardenGraph(), work = graph.nodes.find(node => node.id === "garden-produce-work")!;
  assert.ok(work.tests.length && graph.tests.some(test => test.id === work.tests[0] && test.contract));
  const binding = { id: taskBindingId(obligation), scope: obligation.scope, obligation: obligation.obligation,
    consumers: [{ node: work.id, tests: [...work.tests] }] };
  graph.researchObligations = [binding];
  const bound = bindTaskObligations(f.store, f.project, graph, handoff);
  assert.deepEqual(bound.findings, []);
  assert.deepEqual(bound.byNode.get(work.id), [{ binding: binding.id, requirement: obligation, tests: work.tests }]);
  const cases: [NonNullable<Graph['researchObligations']>, string][] = [
    [[], "task_obligation_consumer_missing"],
    [[{ ...binding, consumers: [{ node: "garden-consume-work", tests: [] }] }], "task_obligation_consumer_foreign"],
    [[{ ...binding, consumers: [{ node: work.id, tests: ["other-test"] }] }], "task_obligation_test_foreign"],
    [[{ ...binding, consumers: [{ node: work.id, tests: [] }] }], "task_obligation_resolution_required"],
    [[binding, binding], "task_obligation_duplicate"],
  ];
  for (const [bindings, code] of cases) {
    const candidate = { ...graph, researchObligations: clone(bindings) };
    assert.ok(bindTaskObligations(f.store, f.project, candidate, handoff).findings.some(finding => finding.code === code), code);
  }
  const readiness = readinessObligations(f.store, f.project, clone(saved.inputs) as Ref[]);
  assert.deepEqual(readiness.findings, []);
  assert.deepEqual(readiness.value?.handoff, saved.handoff);
  assert.deepEqual(readiness.value?.confirmations, [], "Task-result transfer is not runtime confirmation or achievement");
});

test("D7 responsibility paths cannot borrow unaccepted lower intermediates between accepted nodes", t => {
  const f = fixture(t, ["post-implementation-proof"], false, true);
  const { level: _level, ...accepted } = projectGraph(f.graph.value, 1);
  assert.equal(new RefinementRelations(f.graph.value).refines("garden-later-block", "garden-produce-block"), true);
  assert.equal(new RefinementRelations(accepted as Graph).refines("garden-later-block", "garden-produce-block"), false);
  assert.equal(f.engine.graphs.layerIsDerived(f.project, 2), false);
  const bad = ownerAssignment(f); bad.assignments[0]!.responsibleNode = "garden-later-block";
  const pending = ownerWrite(clone(normalizeOwnerGapAssignment(bad)) as OwnerGapAssignment);
  const request = { ...f.request, assignments: [{ pending }] }, before = revisions(f.store);
  denied(prepareOmObligations(f.store, request), "obligation_assignment_invalid");
  denied(writeOmObligations(f.store, request), "obligation_assignment_invalid");
  assert.deepEqual(revisions(f.store), before);
  const record = f.store.write(pending);
  denied(readOwnerGapAssignment(f.store, { project: f.project, record: reference(record) }), "obligation_assignment_invalid");
  const legitimate = ok(writeOmObligations(f.store, pendingOwners(f)));
  f.store.close(); const reopened = new Store(f.database);
  try {
    denied(readOwnerGapAssignment(reopened, { project: f.project, record: reference(record) }), "obligation_assignment_invalid");
    assert.deepEqual(ok(readOmObligationLedger(reopened, { project: f.project, ledger: reference(legitimate.record) })).handoff, legitimate.handoff);
  } finally { reopened.close(); }
});

/** A valid C3 proposal-set change, without pretending to accept work or to grant H2 authority. */
function nextTransferContext(f: ReturnType<typeof fixture>, source: OmObligations, ordinal: number) {
  const sources = clone(source.producer.value.request.gaps.sources) as GapRequest;
  if ('state' in sources.works) assert.fail('A work-assignment transfer starts from a genuine L3 frame request');
  const frame = sources.works.frame;
  const value: LayerProposal = { base: { graph: frame.graph, frame: frame.frame }, level: 3, worksContract: WORKS_FRAME_CONTRACT,
    source: 'input', status: 'proposed', nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], joins: [], tests: [],
    edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  const proposal = f.store.write({ id: `om-proposal:${f.project}:transfer-context-${ordinal}`, kind: 'layer-proposal', expected: 0, value });
  sources.works.proposals.push(reference(proposal));
  const gaps = ok(writeGaps(f.store, sources)), gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const previous = f.store.get<GapLinesRecord>(source.producer.value.request.lines.id)!;
  const lines = ok(writeGapLines(f.store, { project: f.project, gaps: gapRead, previous: reference(previous),
    pass: previous.value.request.pass + 1, closures: [] }));
  const gap = gaps.records.find(row => row.value.gap.target === 'discovery:late-0')!;
  return { gaps: gapRead, lines: reference(lines), gap: reference(gap) };
}
function transferRequest(f: ReturnType<typeof fixture>, source: OmObligations, next: ReturnType<typeof nextTransferContext>): ObligationTransferRequest {
  const assignment = source.producer.value.request.assignments[0]!;
  if (!('record' in assignment)) assert.fail('The source authority must be saved');
  return { project: f.project, from: { producer: reference(source.producer), ledger: reference(source.record), assignment: assignment.record },
    context: { gaps: next.gaps, lines: next.lines }, gap: next.gap };
}
function transferWrite(value: ObligationTransferRecord): Write {
  return { id: `${OM_OBLIGATION_TRANSFER_KIND}:${value.project}:${hashJson(value)}`, kind: OM_OBLIGATION_TRANSFER_KIND, expected: 0, value };
}

test('D7 F5 transfer preserves all H2 consumers through repeated proposal changes and exact historical restart', t => {
  const f = fixture(t, ['post-implementation-proof'], true), original = ok(writeOmObligations(f.store, pendingOwners(f))) as unknown as OmObligations;
  const oldBytes = { producer: clone(original.producer), record: clone(original.record), handoff: clone(original.handoff) };
  const next = nextTransferContext(f, original, 1), request = transferRequest(f, original, next), before = revisions(f.store);
  const transfer = ok(prepareObligationTransfer(f.store, request));
  assert.deepEqual(revisions(f.store), before); assert.equal(transfer.record.kind, OM_OBLIGATION_TRANSFER_KIND);
  assert.equal(transfer.record.value.contract, OM_OBLIGATION_TRANSFER_CONTRACT);
  assert.deepEqual(transfer.owner, request.from.assignment);
  assert.equal(transfer.assignments.length, 2);
  assert.deepEqual(transfer.assignments.map(row => row.responsibleConsumer).sort(), ['garden-later-block', 'garden-produce-block']);
  assert.ok(!transfer.guards.some(ref => !('absent' in ref) && sameRef(ref, original.producer.value.request.lines)), 'Old D2 is historical, not required to be current');
  assert.ok(transfer.guards.some(ref => !('absent' in ref) && sameRef(ref, next.lines)));
  for (const ref of [request.from.assignment, request.from.producer, request.from.ledger])
    assert.ok(transfer.guards.some(guard => !('absent' in guard) && sameRef(guard, ref)));
  const newRequest: ObligationRequest = { project: f.project, gaps: next.gaps, lines: next.lines,
    assignments: [{ pending: clone(transfer.writes[0]!) as Write }] };
  const prepared = ok(prepareOmObligations(f.store, newRequest));
  assert.deepEqual(revisions(f.store), before, 'Preparing the transferred ledger publishes neither record');
  assert.equal(prepared.writes.filter(write => write.kind === OM_OWNER_ASSIGNMENT_KIND).length, 0);
  assert.equal(prepared.writes.filter(write => write.kind === OM_OBLIGATION_TRANSFER_KIND).length, 1);
  for (const ref of [request.from.assignment, request.from.producer, request.from.ledger])
    assert.ok(prepared.guards.some(guard => !('absent' in guard) && sameRef(guard, ref)), 'The outward handoff still guards its original authority');
  const saved = ok(writeOmObligations(f.store, newRequest)) as unknown as OmObligations;
  assert.equal(saved.handoff.obligations.length, 2);
  assert.deepEqual(ok(readOmObligationHandoff(f.store, f.project, saved.inputs)), saved.handoff);
  assert.deepEqual(obligationHandoff(f.store, f.project, saved.inputs), saved.handoff);
  assert.deepEqual(taskObligationHandoff(f.store, f.project, saved.inputs), saved.handoff);
  assert.deepEqual(readinessObligations(f.store, f.project, saved.inputs).value?.handoff, saved.handoff);
  for (let index = 0; index < original.handoff.obligations.length; index++) {
    const old = original.handoff.obligations[index]!, current = saved.handoff.obligations.find(row => row.responsibleConsumer === old.responsibleConsumer)!;
    const { scope: _oldScope, original: _oldGap, ...oldAssignment } = old;
    const { scope: _newScope, original: _newGap, ...newAssignment } = current;
    assert.deepEqual(newAssignment, oldAssignment); assert.notEqual(taskBindingId(old), taskBindingId(current));
    assert.deepEqual(current.original.record, next.gap); assert.deepEqual(current.scope, reference(saved.record));
  }
  assert.deepEqual(ok(readObligationTransfer(f.store, { project: f.project, record: reference(transfer.record) })).assignments, transfer.assignments);
  assert.deepEqual(ok(prepareObligationTransfer(f.store, request)).writes, []);
  assert.deepEqual(ok(prepareOmObligations(f.store, newRequest)).writes, []);
  const another = nextTransferContext(f, saved, 2), againRequest = transferRequest(f, saved, another);
  const again = ok(prepareObligationTransfer(f.store, againRequest));
  assert.deepEqual(again.owner, transfer.owner, 'A second transfer retains original H2 authority');
  assert.deepEqual(again.record.value.from.assignment, reference(transfer.record));
  const newest = ok(writeOmObligations(f.store, { project: f.project, gaps: another.gaps, lines: another.lines,
    assignments: [{ pending: clone(again.writes[0]!) as Write }] }));
  assert.equal(newest.handoff.obligations.length, 2);
  assert.equal(newest.inputs.filter(ref => ref.id.startsWith('om-obligation-basis:')).length, 1);
  assert.equal(newest.inputs.filter(ref => ref.id.startsWith('om-obligations:')).length, 1);
  assert.deepEqual(ok(readOmObligationHandoff(f.store, f.project, clone(newest.inputs) as Ref[])), newest.handoff);
  assert.deepEqual(f.store.get(original.producer.id, original.producer.revision), oldBytes.producer);
  assert.deepEqual(f.store.get(original.record.id, original.record.revision), oldBytes.record);
  const ownerHead = f.store.get(transfer.owner.id)!;
  f.store.write({ id: ownerHead.id, kind: ownerHead.kind, expected: ownerHead.revision, value: ownerHead.value });
  f.store.close(); const reopened = new Store(f.database);
  try {
    assert.deepEqual(ok(readOmObligations(reopened, { project: f.project, producer: reference(original.producer) })).handoff, oldBytes.handoff);
    assert.deepEqual(ok(readOmObligations(reopened, { project: f.project, producer: reference(saved.producer) })).handoff, saved.handoff);
    assert.deepEqual(ok(readOmObligations(reopened, { project: f.project, producer: reference(newest.producer) })).handoff, newest.handoff);
    assert.deepEqual(obligationHandoff(reopened, f.project, clone(newest.inputs) as Ref[]), newest.handoff);
    assert.deepEqual(taskObligationHandoff(reopened, f.project, clone(newest.inputs) as Ref[]), newest.handoff);
    assert.deepEqual(ok(readObligationTransfer(reopened, { project: f.project, record: reference(again.record) })).owner, transfer.owner);
    assert.deepEqual(ok(readOwnerGapAssignment(reopened, { project: f.project, record: transfer.owner })).record,
      reopened.get(transfer.owner.id, transfer.owner.revision), 'The old owner era is still read as an H2 command');
    denied(prepareObligationTransfer(reopened, request), 'input_stale');
    denied(prepareObligationTransfer(reopened, againRequest), 'input_stale');
  } finally { reopened.close(); }
});

test('D7 transfer rederives owner contents and rejects lost consumers forged provenance and source races atomically', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const f = fixture(t, ['post-implementation-proof'], true), original = ok(writeOmObligations(f.store, pendingOwners(f))) as unknown as OmObligations;
  const next = nextTransferContext(f, original, 1), request = transferRequest(f, original, next), legitimate = ok(prepareObligationTransfer(f.store, request));
  const variants: ObligationTransferRecord[] = [];
  const changed = clone(legitimate.record.value) as ObligationTransferRecord; changed.assignments[0]!.returnCondition = 'Different authorization'; variants.push(changed);
  const shortened = clone(legitimate.record.value) as ObligationTransferRecord; shortened.assignments.pop(); variants.push(shortened);
  const owner = clone(legitimate.record.value) as ObligationTransferRecord; owner.owner = reference(original.producer); variants.push(owner);
  const epoch = clone(legitimate.record.value) as unknown as Record<string, Json>; epoch.contract = 'om-obligation-transfer/v99'; variants.push(epoch as unknown as ObligationTransferRecord);
  for (const value of variants) {
    const pending = transferWrite(value), before = revisions(f.store);
    denied(prepareOmObligations(f.store, { project: f.project, gaps: next.gaps, lines: next.lines, assignments: [{ pending }] }), 'obligation_assignment_invalid');
    assert.deepEqual(revisions(f.store), before);
    const forged = f.store.write(pending);
    denied(readObligationTransfer(f.store, { project: f.project, record: reference(forged) }), 'obligation_assignment_invalid');
  }
  const foreign = { ...request, from: { ...request.from, ledger: reference(original.producer) } };
  denied(prepareObligationTransfer(f.store, foreign), 'obligation_assignment_invalid');
  const originalAssignment = original.producer.value.request.assignments[0]!;
  if (!('record' in originalAssignment)) assert.fail('Expected saved H2 source');
  denied(prepareOmObligations(f.store, { project: f.project, gaps: next.gaps, lines: next.lines, assignments: [originalAssignment] }),
    'obligation_assignment_invalid');
  const prepared = ok(prepareOmObligations(f.store, { project: f.project, gaps: next.gaps, lines: next.lines,
    assignments: [{ pending: clone(legitimate.writes[0]!) as Write }] }));
  const other = new Store(f.database);
  try {
    const source = other.get(originalAssignment.record.id)!;
    other.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
    const before = revisions(f.store);
    denied(writeGuarded(f.store, { unit: 'F5-transfer-test', target: legitimate.record.id,
      writes: [...prepared.writes, { id: 'transfer-neighbor', kind: 'transfer-neighbor', expected: 0, value: {} }], guards: prepared.guards }), 'input_stale');
    assert.equal(f.store.get(legitimate.record.id), null); assert.equal(f.store.get(prepared.record.id), null);
    assert.equal(f.store.get(prepared.producer.id), null); assert.equal(f.store.get('transfer-neighbor'), null);
    assert.deepEqual(revisions(f.store), before);
    denied(prepareObligationTransfer(f.store, request), 'input_stale');
  } finally { other.close(); }
});

test('D7 transfer entry points reject missing malformed and foreign arguments before storage', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-transfer-arguments-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const view = new Proxy(store, { get(target, property) {
    if (['get', 'list', 'history'].includes(String(property))) return () => assert.fail('Malformed transfer request reached storage');
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const ref: Ref = { id: 'om-obligation-basis:garden:argument', revision: 1, hash: hashJson('argument') };
  const input = { project: 'garden', from: { producer: ref, ledger: ref, assignment: ref }, context: { gaps: { sources: {}, records: [] }, lines: ref }, gap: ref };
  const read = { project: 'garden', record: ref };
  for (const [action, request] of [[prepareObligationTransfer, input], [readObligationTransfer, read]] as const) {
    const invoke = action as (store: Store, request: unknown) => unknown;
    for (const value of [undefined, null, [], '', false, { ...request, project: '' }, { ...request, status: 'accepted' }])
      assert.throws(() => invoke(view, value), malformed);
    for (const key of Object.keys(request)) {
      const absent = clone(request) as Record<string, unknown>; delete absent[key];
      assert.throws(() => invoke(view, absent), malformed);
    }
    assert.throws(() => invoke(undefined as unknown as Store, request), malformed);
  }
  for (const from of [null, [], {}, { producer: ref, ledger: ref }, { ...input.from, assignment: null }, { ...input.from, producer: { ...ref, revision: 0 } }])
    assert.throws(() => prepareObligationTransfer(view, { ...input, from } as unknown as ObligationTransferRequest), malformed);
});

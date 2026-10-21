import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage/store.js";

// ---- AT1 door (№4105 п.1–3): the readiness questions of a saved G5 rejection as a derivation of B1 ----
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { readOmInput, prepareReadinessInput, writeReadinessInput, type OmInputRecord, type ReadinessTransition } from "../src/om/input.js";
import type { Graph } from "../src/graph/model.js";
import { createOmFixture } from "./om-fixture.js";
import { declarationUnknown, transitionField } from "../src/om/impact.js";

function ok<T>(result: { ok: true; value: T } | { ok: false; refusal: { code: string; message: string } }): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refused(result: { ok: boolean; refusal?: { code: string } }, code: string): void {
  assert.equal(result.ok, false); assert.equal(result.refusal!.code, code);
}
/** A saved G5 of the impact era that refused a work the accepted graph does not hold yet, for one unresolved transition. */
function refusedGate(store: Store, project: string, input: Ref, graph: Ref, tree: string, name: string, contract = "om-atomic-gate/v2",
  unknown: Record<string, unknown> = { file: "test/loader.test.ts", line: 2, kind: "dynamic-import", text: "import(process.env.M!)", site: { start: 60, end: 82, hash: "a".repeat(64) }, candidates: ["src/garden.ts"] }): Ref {
  const accepted = store.get<Graph>(graph.id, graph.revision)!.value;
  const work = { ...structuredClone(accepted.nodes.find(node => node.kind === "work")!), id: `${project}-new-work`, parent: `${project}-produce-operation` };
  const candidate = store.write({ id: `om-candidate:${project}:${name}`, kind: "frame-candidate", expected: 0,
    value: { level: 3, graph: { ...structuredClone(accepted), nodes: [...structuredClone(accepted.nodes), work] } } });
  const gate = store.write({ id: `om-atomic-gate:${project}:${name}`, kind: "om-atomic-gate", expected: 0, value: { contract, project,
    request: { project, candidate: reference(candidate), gaps: { sources: { project, input, graph }, records: [] } },
    result: { gate: "G5", passed: false, codes: ["work_impact_unresolved"],
      findings: [{ code: "work_impact_unresolved", target: work.id, field: transitionField(unknown as Parameters<typeof transitionField>[0]), message: "An unresolved transition" }] },
    impact: { snapshot: { commit: "c".repeat(40), tree }, works: [{ work: work.id, affected: ["src/garden.ts"], entries: [], consumers: [], unknowns: [unknown] }] } } });
  return reference(gate);
}

test("AT1 door: a saved G5 rejection asks its unresolved transition in B1 once — for the accepted operation above a work not yet accepted, its source the gate; a repeat writes nothing; another snapshot asks anew; a foreign chain or era is refused", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), project = f.project;
  const root = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  const graph = reference(f.graphRevision);
  const gate = refusedGate(f.store, project, reference(root), graph, "b".repeat(40), "first");
  const asked = ok(writeReadinessInput(f.store, { project, input: reference(root), gate }));
  assert.equal(asked.revision, root.revision + 1);
  const added = asked.value.input.questions.filter(question => !root.value.input.questions.some(prior => prior.id === question.id));
  assert.equal(added.length, 1);
  const [question] = added;
  assert.deepEqual([question!.consumer, question!.kind, question!.blocks, question!.moment, question!.source, question!.readiness!.works,
    (question!.readiness as ReadinessTransition).snapshot.tree, (question!.readiness as ReadinessTransition).candidates],
    [`${project}-produce-operation`, "repository-fact", true, "om-pass", gate, [`${project}-new-work`], "b".repeat(40), ["src/garden.ts"]]);
  assert.deepEqual(asked.value.derivation, { kind: "readiness", previous: reference(root), gate });
  assert.deepEqual(ok(readOmInput(f.store, project, reference(asked))), asked, "a trusted read of the derived B1");
  // A repeat after a crash: the same request delivers the written B1; asked again on it, nothing is new.
  assert.deepEqual(ok(writeReadinessInput(f.store, { project, input: reference(root), gate })), asked);
  assert.deepEqual(ok(prepareReadinessInput(f.store, { project, input: reference(asked), gate })).writes, []);
  assert.equal(f.store.get<OmInputRecord>(`om-input:${project}`)!.revision, asked.revision);
  // The same transition on another tree is another question: an answer of one snapshot never resolves another.
  const moved = refusedGate(f.store, project, reference(asked), graph, "d".repeat(40), "moved");
  const again = ok(writeReadinessInput(f.store, { project, input: reference(asked), gate: moved }));
  assert.equal(again.value.input.questions.length, asked.value.input.questions.length + 1);
  // A gate whose D1 stands on no B1 of this chain, or of the era before the impact, asks nothing.
  const other = f.store.write({ id: `om-input-other:${project}`, kind: "om-input", expected: 0, value: root.value });
  refused(prepareReadinessInput(f.store, { project, input: reference(again), gate: refusedGate(f.store, project, reference(other), graph, "e".repeat(40), "foreign") }), "record_forged");
  refused(prepareReadinessInput(f.store, { project, input: reference(again), gate: refusedGate(f.store, project, reference(again), graph, "e".repeat(40), "old", "om-atomic-gate/v1") }), "record_forged");
  refused(prepareReadinessInput(f.store, { project, input: reference(root), gate: moved }), "input_stale");
});

test("AT1 return №4147: a connection point the parser proves nothing about is asked in B1 as a repository fact about the point itself — its only candidate the point", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), project = f.project;
  const root = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  const unknown = declarationUnknown("src/store.py#commit", "The parser reads JavaScript and TypeScript only");
  const gate = refusedGate(f.store, project, reference(root), reference(f.graphRevision), "b".repeat(40), "declaration", "om-atomic-gate/v2", { ...unknown });
  const asked = ok(writeReadinessInput(f.store, { project, input: reference(root), gate }));
  const [question] = asked.value.input.questions.filter(item => !root.value.input.questions.some(prior => prior.id === item.id));
  const cause = question!.readiness as ReadinessTransition;
  assert.deepEqual([question!.kind, cause.file, cause.kind, cause.candidates, cause.site], ["repository-fact", "src/store.py#commit", "declaration", ["src/store.py#commit"], unknown.site]);
  assert.match(question!.question, /Does the code of that snapshot declare it\? Answer with "resolves": \["src\/store\.py#commit"\] when it is declared there, \[\] when it is not/);
  assert.match(question!.question, /not that its interface fits the contract/);
});

/** A saved G5 of the impact era that refused a work not yet accepted for undecided policies of its producers. */
function policyGate(store: Store, project: string, input: Ref, graph: Ref, needs: [string, string, string][], name: string): Ref {
  const accepted = store.get<Graph>(graph.id, graph.revision)!.value;
  const work = { ...structuredClone(accepted.nodes.find(node => node.kind === "work")!), id: `${project}-durable-work`, parent: `${project}-produce-operation` };
  const candidate = store.write({ id: `om-candidate:${project}:${name}`, kind: "frame-candidate", expected: 0,
    value: { level: 3, graph: { ...structuredClone(accepted), nodes: [...structuredClone(accepted.nodes), work] } } });
  const gate = store.write({ id: `om-atomic-gate:${project}:${name}`, kind: "om-atomic-gate", expected: 0, value: { contract: "om-atomic-gate/v2", project,
    request: { project, candidate: reference(candidate), gaps: { sources: { project, input, graph }, records: [] } },
    result: { gate: "G5", passed: false, codes: ["work_policy_open"],
      findings: needs.map(([policy, producer, contract]) => ({ code: "work_policy_open", target: work.id, field: `${policy}:${producer}:${contract}`, message: "An undecided policy" })) },
    impact: { snapshot: null, works: [], policies: needs.map(([policy, producer, contract]) => ({ work: work.id, policy, producer,
      contract: { id: contract, hash: `${contract}-hash` }, question: null })) } } });
  return reference(gate);
}
test("AT1 policy: a saved G5 asks each undecided policy once — at the producer the boundary names when it is an accepted node, above the works when no node bears the name — as an owner decision; a repeat asks nothing", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), project = f.project;
  const root = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  const gate = policyGate(f.store, project, reference(root), reference(f.graphRevision),
    [["appearance", `${project}-produce-block`, "state-contract"], ["appearance", `${project}-produce-block`, "other-contract"], ["provider", "owner", "state-contract"]], "policies");
  const asked = ok(writeReadinessInput(f.store, { project, input: reference(root), gate }));
  const added = asked.value.input.questions.filter(question => question.readiness?.cause === "policy")
    .map(question => [question.consumer, question.kind, question.blocks, question.source.id, question.readiness]);
  assert.deepEqual(added.sort(), [
    [`${project}-produce-block`, "owner-decision", true, gate.id, { contract: "om-readiness/v1", cause: "policy", policy: "appearance", producer: `${project}-produce-block`,
      governs: { contract: "state-contract", hash: "state-contract-hash" }, works: [`${project}-durable-work`] }],
    [`${project}-produce-block`, "owner-decision", true, gate.id, { contract: "om-readiness/v1", cause: "policy", policy: "appearance", producer: `${project}-produce-block`,
      governs: { contract: "other-contract", hash: "other-contract-hash" }, works: [`${project}-durable-work`] }],
    [`${project}-produce-operation`, "owner-decision", true, gate.id, { contract: "om-readiness/v1", cause: "policy", policy: "provider", producer: "owner",
      governs: { contract: "state-contract", hash: "state-contract-hash" }, works: [`${project}-durable-work`] }],
  ].sort());
  assert.deepEqual(ok(prepareReadinessInput(f.store, { project, input: reference(asked), gate })).writes, [], "asked once");
});

test("AT1 return №4186 P1, №4188: a transition several works in different blocks need is one question of the snapshot — asked once at their common accepted place, one answer for all", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), project = f.project;
  const root = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  const accepted = f.store.get<Graph>(f.graphRevision.id, f.graphRevision.revision)!.value;
  const template = accepted.nodes.find(node => node.kind === "work")!;
  const works = [{ ...structuredClone(template), id: `${project}-one-work`, parent: `${project}-produce-operation` },
    { ...structuredClone(template), id: `${project}-two-work`, parent: `${project}-later-operation` }];
  const candidate = f.store.write({ id: `om-candidate:${project}:two`, kind: "frame-candidate", expected: 0,
    value: { level: 3, graph: { ...structuredClone(accepted), nodes: [...structuredClone(accepted.nodes), ...works] } } });
  const unknown = { file: "test/loader.test.ts", line: 2, kind: "dynamic-import", text: "import(process.env.M!)", site: { start: 60, end: 82, hash: "a".repeat(64) }, candidates: ["src/garden.ts"] };
  const gate = reference(f.store.write({ id: `om-atomic-gate:${project}:two`, kind: "om-atomic-gate", expected: 0, value: { contract: "om-atomic-gate/v2", project,
    request: { project, candidate: reference(candidate), gaps: { sources: { project, input: reference(root), graph: reference(f.graphRevision) }, records: [] } },
    result: { gate: "G5", passed: false, codes: ["work_impact_unresolved"],
      findings: works.map(work => ({ code: "work_impact_unresolved", target: work.id, field: transitionField(unknown), message: "An unresolved transition" })) },
    impact: { snapshot: { commit: "c".repeat(40), tree: "b".repeat(40) },
      works: works.map(work => ({ work: work.id, affected: ["src/garden.ts"], entries: [], consumers: [], unknowns: [unknown] })) } } }));
  const asked = ok(writeReadinessInput(f.store, { project, input: reference(root), gate }));
  const added = asked.value.input.questions.filter(question => !root.value.input.questions.some(prior => prior.id === question.id));
  assert.equal(added.length, 1, "one question, not one per block");
  assert.deepEqual((added[0]!.readiness as ReadinessTransition).works, [`${project}-one-work`, `${project}-two-work`]);
  // Return №4197: it names the place in each block, and D1 makes it a gap of both blocks — never of a root above them.
  assert.deepEqual((added[0]!.readiness as ReadinessTransition).places, [`${project}-later-operation`, `${project}-produce-operation`]);
  assert.ok([`${project}-later-operation`, `${project}-produce-operation`].includes(added[0]!.consumer));
});

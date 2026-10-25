import { readCompletionWorkAt } from "../src/om/model-call.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type Write } from "../src/storage/store.js";
import { configureDispatch } from "../src/om/dispatch.js";
import { canonical, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { git } from "../src/runtime/environment.js";
import type { OmInputRecord } from "../src/om/input.js";
import { readFeasibility, type OmFeasibility } from "../src/om/feasibility.js";
import { gardenGraph, prepareNativeLayers } from "./om-fixture.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { readCompletionBinding, resumeSeries, seriesRequestOf, ownerDecisionNamespace, OWNER_DECISION_KIND, type AnyRepairSeries, type CompletionOwner } from "../src/om/series.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { type RoutesRecord } from "../src/om/routes.js";
import { readRouteProducers } from "../src/om/answers-gate.js";
import type { RepairSeries } from "../src/om/series.js";
import { deriveCompletionEvidence } from "../src/om/repeat-gate.js";
import { modelCallRecordId, prepareCompletionCause, runModelCall, type OmModelCall } from "../src/om/model-call.js";
import { readRun, startRun, runId, type RunRecord } from "../src/om/run.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { completionCloseId} from "../src/om/series.js";
import { readCompletionCloseAt } from "../src/om/repeat-gate.js";
// ---- LP8.1 (№3670): an unable pass weighs its grounds again by today's rules at every entry ----
import { continuePass, startPass } from "../src/om/run-driver.js";
// AT1 door (№4105): a works answer whose file a test may load through a transition nobody resolved is refused by G5; the
// group's rejection first asks that transition in B1 (its source the saved gate), research answers it with the exact files
// of the snapshot, the answer is applied, and the next works — now deciding the test the transition reaches — pass G5 on
// the same snapshot. The question is asked once; a repeat of the B1 transition writes nothing.
import { readinessPending, writeReadinessInput, type ReadinessTransition } from "../src/om/input.js";
import { project, ok, refusal, runFixture, type Fixture, addressAll, usage, assessor, mechanismSeries, blockSeries, actions, ends, driveTo, reasonsOf, stopAnswer, cannotAnswer, until, regatePolicy, nodeAnswer, worksFixture, worksAcceptance, nodeRefusal, addressQuestions, advanceRun, lp4Configure, lp4Questions, lp4Sent, lp4Close, mp2WorkAnswer, type Lp6Op, lp6Line, lp6CurrentRounds, lp6Close, passRows, unavailableReview, policyDoor, sameEnd, managedAwaitOwner } from "./om-run-fixture.js";

test("H1.2 R7 C01 C33 C59 both kinds of line ask the owner: the grounds keep their canonical order without a repeat, and a malformed end is an integrity refusal", async t => {
  const f = runFixture(t, ["encoding", "spare"], "executed", ["encoding"]);
  const b = f.bases("h12-both"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  const m5 = saved.batches.find(item => item.model === "MC2" && item.task === "input-field")!;
  const facts = saved.batches.find(item => item.model === "MC1")!;
  const ask = (gaps: string[], reason: string) => ({ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: gaps,
    action: "need_owner", reason, decision: "Decide it" }, usage });
  f.steps([ask(m5.items.map(item => item.gap), "The optional format is not named"), ask(facts.items.map(item => item.gap), "The encoding source is not named")]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 60);
  const reasons = reasonsOf(end.state);
  assert.equal(reasons.length, 2, JSON.stringify(reasons));
  assert.deepEqual(reasons.map(row => row.kind), ["owner-control", "owner-control"]);
  assert.deepEqual(reasons.map(row => row.target), [mechanismSeries(f).id, blockSeries(f).id].sort(), "Canonical order, not the order the grounds were met in");
  assert.deepEqual(reasons.map(row => row.message).sort(), ["The encoding source is not named; Decide it", "The optional format is not named; Decide it"]);
  // A malformed end is an integrity refusal of the pass, never a guess: an empty list, and a list out of its canonical order.
  const head = f.store.get<RunRecord>(runId(project))!;
  const bad = (state: unknown) => f.store.write({ id: head.id, kind: head.kind, expected: f.store.get(head.id)!.revision, value: { ...head.value, state } as unknown as Json });
  bad({ phase: "unable", reasons: [] });
  assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid");
  bad({ phase: "unable", reasons: [...reasons].reverse() });
  assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid");
  assert.equal(refusal(await advanceRun(f.store, request)).code, "run_record_invalid");
  bad({ phase: "unable", reasons });
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
});

test("H1.2 R2 18 19 H1 a decided first-rung review grounds resumeSeries of that exact stop, the next attempt works on, and the pass does not end", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h1-first"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, true), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const driven = await driveTo(f, request, "bases", 50);
  const attempt = ["open", "packet", "cycle", "close"];
  assert.deepEqual(driven.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze", "resume", ...attempt, "bases"], JSON.stringify(driven.wait));
  const series = mechanismSeries(f);
  assert.equal(series.value.stop, null);
  assert.equal(series.value.continuations.length, 1);
  assert.equal(series.value.attempts.at(-1)!.outcome!.reason, "result");
  assert.equal(f.store.get(`om-input:${project}`)!.revision, 3, "The applied addressing made a new B1, and the pass built its bases itself");
  assert.notEqual(ok(readRun(f.store, { project }))!.value.state.phase, "unable", "A decided review is a lawful continuation, never a ground of the end");
});
test("RL3 №4218 condition 1: the wait is the reopening's alone — a policy asked from a saved G5 beside it stays open and the pass goes on to its works once the owner answered the reopening's", async t => regatePolicy(t, "foreign"));

test("25 7 C61 №1749 H1 works of several blocks: each pays once, the full G4b waits for all, one bound works acceptance, a D2 event and G7 per goal", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const blocks = [...new Set(works.flatMap(row => row.items[0]!.consumers))];
  assert.ok(blocks.length > 1, `Several blocks own works: ${blocks.join(",")}`);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>();
  let stood: unknown = null, phase = "";
  for (let index = 0; index < 200; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    if (advanced.performed) performed.push(advanced.performed.action);
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet: Ref } }; wait?: unknown };
    phase = state.phase;
    // Each paid cycle is answered for its exact saved packet before it runs.
    if (state.phase === "step" && state.step!.action === "cycle" && !answered.has(state.step!.request.packet.id)) {
      answered.add(state.step!.request.packet.id); f.answer(state.step!.request.packet);
    }
    // Windows: after the common acceptance before D2, and after a D2 event before its G7.
    if (advanced.performed?.action === "works" || advanced.performed?.action === "confirm") f.restart();
    if (state.phase === "waiting" || state.phase === "complete") { stood = state.wait ?? null; break; }
    if (performed.filter(action => action === "close").length === blocks.length) break;
  }
  const count = (action: string) => performed.filter(item => item === action).length;
  assert.equal(count("works"), 1, `One common works acceptance: ${performed.join(",")} ${JSON.stringify(stood)}`);
  assert.equal(count("cycle"), works.length, "One paid cycle per works root; a block's roots share its one attempt");
  assert.equal(count("confirm"), blocks.length, "A D2 event per original goal");
  assert.equal(count("close"), blocks.length);
  for (const block of blocks) assert.equal(blockSeries(f as unknown as Fixture, block).value.attempts[0]!.outcome!.reason, "result", block);
  assert.equal(f.sent().length, works.length, "Each works root paid its one call, nothing twice");
  void phase;
});

test("H1.2 R7 C25 an owner-control whose question is no longer open holds nothing: the line's work on today's question goes on", async t => {
  const f = runFixture(t, [], "stages", false, false, true);
  const b = f.bases("h12-resolved");
  const routes = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!;
  // The joined input-field batch of the block's contract — nodes, state and the criterion's checkKind — are the questions
  // a model may lawfully send to the owner (every 'answer' field of a pass question is the model's own to decide).
  const joined = routes.value.batches.filter(batch =>
    batch.items.some(row => row.field === "checkKind" && row.consumers.includes("garden-consume-block")));
  assert.ok(joined.length === 1, "The cold input leaves the joined contract batch open");
  // Attempt 1 of the line works by a real managed cycle: its model call asked the owner and the attempt ended
  // awaiting-owner — the close keeps its waiting diagnostic, aimed at questions still open today.
  await managedAwaitOwner(f, b, "garden-consume-block", 1, joined);
  const closing = f.store.list<{ waiting: unknown[] }>("om-completion-close").at(-1)!;
  assert.ok(closing.value.waiting.length > 0, "The close keeps a real owner-control diagnostic of the wait");
  // Meanwhile B1 decides every field of the joined batch (a lawful decision of another producer): the waited questions
  // leave today's open routes, while the line's other batches stay open.
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  ok(writeAddressing(f.store, { project, input: reference(input), graph: f.graph,
    decisions: joined[0]!.items.map(item => ({ pending: structuredClone(inputDecisionWrite({ project,
      input: reference(input), graph: f.graph, layers: [], decision: { target: item.target,
        field: item.field as "nodes" | "state" | "checkKind",
        value: item.field === "nodes" ? ["garden-produce-block", "garden-consume-block"]
          : item.field === "checkKind" ? "test"
          : { writer: "garden-produce-block", authority: "garden-user", rollback: "garden-produce-block" } } })) as Write })) }));
  const request = f.request(f.bases("h12-resolved-2"));
  ok(startRun(f.store, { project }));
  // The line's work on today's questions goes on: the independent fill batches get their real node answers, and the
  // consume line — its earlier wait held nothing once its questions were gone — opens a new managed attempt.
  let state = ok(await advanceRun(f.store, request)).record.value.state;
  for (let index = 0; index < 40 && blockSeries(f).value.attempts.length < 2; index++) {
    assert.notEqual(state.phase, "unable", JSON.stringify(state));
    if (state.phase === "step" && state.step.action === "cycle")
      f.push(nodeAnswer(f, state.step as Parameters<typeof nodeAnswer>[1]) as Record<string, unknown>);
    state = ok(await advanceRun(f.store, request)).record.value.state;
  }
  assert.equal(blockSeries(f).value.attempts.length, 2, "A new attempt opens; the wait of a gone question holds nothing");
  assert.notEqual(state.phase, "unable");
});

test("25 R4 №1770 H1 N2 mixed: A's assembly waits open for the frame; B's negative attempt closes by its own G7 meanwhile, nothing is paid twice", async t => {
  const f = runFixture(t, [], "stages");
  const b = f.bases("h1-mixed"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const a1 = await until(f, request, "cycle");
  const answers: unknown[] = [nodeAnswer(f, a1)];
  f.steps(answers as Record<string, unknown>[]);
  const b1 = await until(f, request, "cycle", 30);
  assert.notEqual(b1.series, a1.series, "A waits for the frame; the independent block is worked");
  answers.push(nodeRefusal(f, b1)); f.steps(answers as Record<string, unknown>[]);
  for (let index = 0; index < 20 && f.store.get<RepairSeries>(b1.series!)!.value.attempts[0]!.outcome === null; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.record.value.state.phase === "waiting") assert.fail(JSON.stringify(advanced.record.value.state));
  }
  assert.equal(f.store.get<RepairSeries>(b1.series!)!.value.attempts[0]!.outcome!.reason, "refused", "B's negative attempt closed while A waited");
  assert.equal(f.store.get<RepairSeries>(a1.series!)!.value.attempts[0]!.outcome, null, "A kept its one open attempt and its assembly");
  assert.ok(!actions(f.store).some(action => ["accept", "confirm"].includes(action)), "No C5 and no D2 without the filled frame");
  assert.equal(f.sent().length, 2, "A1 and B1 — nothing paid twice");
});

test("R10 H1.1 a saved step is performed by its own request when the bases have changed meanwhile: no build, cycle or ordinal comes first", async t => {
  const f = runFixture(t, undefined, "executed");
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const cycling = await until(f, request, "cycle");
  // Meanwhile B1 changes (a lawful D3 decision of another producer): the machine bases of new work are no longer these.
  const input = f.store.get(`om-input:${project}`)!, graph = reference(f.store.get(`graph:${project}`)!);
  ok(writeAddressing(f.store, { project, input: reference(input), graph, decisions: [{ pending: structuredClone(inputDecisionWrite({ project,
    input: reference(input), graph, layers: [], decision: { target: "discovery:spare", field: "address",
      value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
  assert.equal(ok(prepareRunBases(f.store, { project })).state, "missing");
  const cycles = f.store.list().filter(row => row.kind === "om-model-cycle").length;
  const performed = ok(await advanceRun(f.store, request));
  assert.deepEqual(performed.performed, cycling, "The saved cycle keeps its exact request");
  // The producer keeps its own current admission: the packet stands on the earlier B1, so the saved cycle is refused
  // there and nothing is sent — the refusal is its outcome, not a rebuilt request.
  const state = performed.record.value.state;
  assert.deepEqual(state.phase === "waiting" && [state.wait.code, state.wait.target], ["input_stale", `om-input:${project}`]);
  assert.equal(f.store.list().filter(row => row.kind === "om-model-cycle").length, cycles);
  assert.equal(f.sent().length, 0);
  assert.ok(!actions(f.store).includes("bases"), "No build came before the saved step");
  assert.equal(mechanismSeries(f).value.attempts.length, 1, "No new ordinal");
});

test("H1.5 №2166 п.4 a design question of task-start has a batch M6 describes and no producer: it is left out of every plan as well, yet it is no ground of the end", async t => {
  const f = runFixture(t, ["proof"], "n2", false, false, false, { proof: { moment: "task-start" } });
  addressQuestions(f, [["proof", "design-decision"]]); // Before D1, D7 and N3; no stale accepted horizon.
  const question = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.find(row => row.id === "discovery:proof")!;
  assert.ok(question);
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value;
  const batch = routes.batches.find(item => item.items.some(row => row.target === question.id && row.field === "answer"));
  assert.ok(batch, "M6 makes a batch of every design decision, whatever its moment");
  const read = ok(readRouteProducers(f.store, { project, routes: bases.routes }));
  assert.deepEqual(read.batches.filter(row => row.unserved.length).map(row => row.batch), [batch.id]);
  assert.deepEqual(read.batches.find(row => row.batch === batch.id)!.unserved.map(row => [row.gap, row.target, row.field, row.blocking]),
    [[batch.items.find(row => row.target === question.id)!.record, question.id, "answer", false]], "Exactly this late question has no producer");
  const selectedBatch = (routesRef: Ref, id: string | null) => {
    assert.ok(id, "Every N3 packet names its batch");
    const saved = f.store.get<RoutesRecord>(routesRef.id, routesRef.revision)!;
    assert.deepEqual(reference(saved), routesRef);
    const selected = saved.value.batches.find(row => row.id === id)!;
    assert.ok(selected);
    assert.notEqual(selected.id, batch.id);
    assert.ok(!selected.items.some(row => row.target === question.id), "No version of the late question enters a plan, packet or call");
    assert.deepEqual([selected.task, selected.level], ["node-expansion", 3]);
    return selected;
  };
  const request = f.request(), replies: Record<string, unknown>[] = [], paid = new Map<string, Ref>(), performed: string[] = [];
  ok(startRun(f.store, { project }));
  let state = ok(readRun(f.store, { project }))!.value.state;
  // №7365/7394: real N3 replaces the old full Refinement L3 without om-frame:3 and its 12 idle transitions.
  for (let index = 0; index < 200 && !["complete", "unable", "waiting"].includes(state.phase); index++) {
    const next = ok(await advanceRun(f.store, request)); state = next.record.value.state;
    if (next.performed) performed.push(next.performed.action);
    if (state.phase !== "step" || state.step.action !== "cycle") continue;
    const ref = (state.step.request as unknown as { packet: Ref }).packet;
    if (paid.has(ref.id)) continue;
    paid.set(ref.id, ref);
    const packet = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!;
    assert.deepEqual(reference(packet), ref);
    selectedBatch(packet.value.request.routes, packet.value.request.batch);
    assert.deepEqual((packet.value.packet as unknown as { works: { assigned: string[] } }).works.assigned, [], "No task binding is invented for the late design question");
    replies.push({ ...mp2WorkAnswer({ store: f.store, desired: gardenGraph() }, ref), usage }); f.steps(replies);
  }
  assert.equal(state.phase, "complete", JSON.stringify({ state, performed }));
  const m8 = f.store.get<OmFeasibility>(`om-feasibility:${project}`)!;
  assert.ok(m8.value.ready);
  assert.deepEqual(ok(readFeasibility(f.store, { project, record: reference(m8) })), m8);
  const owners = f.store.list<CompletionOwner>("om-completion-owner");
  assert.ok(owners.length > 0, "Real N3 has completion plans");
  for (const owner of owners) for (const id of owner.value.plan.batches) selectedBatch(owner.value.plan.routes, id);
  const packets = f.store.list<QuestionPacketRecord>("question-packet"), calls = f.store.list<OmModelCall>("model-call").filter(row => row.value.om);
  assert.ok(paid.size > 0);
  assert.deepEqual(packets.map(reference).sort((a, b) => a.id.localeCompare(b.id)), [...paid.values()].sort((a, b) => a.id.localeCompare(b.id)));
  for (const packet of packets) selectedBatch(packet.value.request.routes, packet.value.request.batch);
  assert.equal(calls.length, paid.size, "One call per exact N3 packet, no correction or hidden review");
  assert.equal(f.sent().length, calls.length, "All paid transport is accounted for by N3 calls");
  for (const call of calls) assert.deepEqual(call.value.om.request.packet, paid.get(call.value.om.request.packet.id));
  assert.deepEqual(f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.find(row => row.id === question.id), question);
  const history = () => f.store.list().flatMap(row => f.store.history(row.id).map(reference));
  const before = history();
  await sameEnd(f, request, calls.length);
  assert.deepEqual(history(), before, "Restart adds neither a record nor a revision");
  t.diagnostic(`${calls.length} native N3 calls, ${performed.length} transitions; late batch never planned or paid`);
});

test("LP4 (№2887 rows 1, 4, 9, §6.3, §6.4, §6.6) an addressed file the first or the second root waits for: without another environment the pass waits lawfully and nothing is ceased; once the roles move, the waiting step and then its node are ceased, the other root is worked by its own rules, the first attempt closes by G7 — on a new Store after every transaction, never waiting on completion_ceased and never sending the paid need_source again", async t => {
  for (const hang of ["first", "second"] as const) await t.test(`the ${hang} root waits`, async t => {
    const f = worksFixture(t), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], cycled: Ref[] = [];
    ok(startRun(f.store, { project }));
    let state = null as { phase: string; step?: { action: string; request: unknown } } | null;
    for (let index = 0; index < 40 && state?.phase !== "waiting"; index++) {
      const advanced = ok(await advanceRun(f.store, f.request)); state = advanced.record.value.state as unknown as typeof state;
      if (state!.phase !== "step" || state!.step!.action !== "cycle") continue;
      const packet = (state!.step!.request as { packet: Ref }).packet;
      if (cycled.some(ref => ref.id === packet.id)) continue;
      cycled.push(packet);
      if (cycled.length === (hang === "first" ? 1 : 2)) steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source",
        questionIds: lp4Questions(f, packet), missing: "The addressed file", reads: [{ action: "read", path: "lp4-later.txt", media: "text/plain" }] }, usage });
      else { f.answer(packet); steps.push((JSON.parse(readFileSync(scenario, "utf8")) as { steps: unknown[] }).steps.at(-1)); }
      writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    }
    assert.equal(state?.phase, "waiting", JSON.stringify(state));
    const waiting = cycled[hang === "first" ? 0 : 1]!, other = cycled.find(ref => ref.id !== waiting.id) ?? null;
    // Row 9: the lawful wait for an external input stays as it is without another environment; nothing is ceased.
    // Row 9: a lawful wait for an external input; without another environment nothing is ceased and nothing sent again.
    const saved = (state as unknown as { wait: { code: string } }).wait.code;
    assert.deepEqual([saved, f.store.list("om-completion-cessation").length, lp4Sent(f, waiting)], ["model_read_unavailable", 0, 1]);
    f.restart();
    assert.equal(ok(prepareCompletionCause(f.store, project, (f.store.list<{ om: { completionOwner: { assignment: Ref } } }>("model-call")
      .find(row => row.value.om?.completionOwner)!).value.om.completionOwner.assignment)).cause, null);
    const request = lp4Configure(f, f.request), seen = await lp4Close(f, request);
    const cessations = f.store.list<{ assignment: Ref; remainder: string; cause: { kind: string } }>("om-completion-cessation");
    assert.deepEqual(cessations.map(row => row.value.cause.kind).sort(), ["cycle-step-ceased", "required-record-replaced"], seen.join(","));
    const root = cessations.find(row => row.value.cause.kind === "cycle-step-ceased")!;
    assert.equal(root.value.remainder, "assembly");
    assert.equal(f.store.get<{ kind: string }>(root.value.assignment.id)!.value.kind, "root");
    assert.equal(lp4Sent(f, waiting), 1, "The paid need_source is never sent again");
    // §6.3: the other root is worked by its own rules — its own cycle, never ceased because of the waiting one.
    const cycles = f.store.list<{ request: { packet: Ref }; terminal: string }>("om-model-cycle");
    const own = cycles.filter(row => row.value.request.packet.id !== waiting.id);
    assert.ok(own.length >= 1 && own.every(row => ["outcome", "assembled"].includes(row.value.terminal)), JSON.stringify(cycles.map(row => row.value.terminal)));
    if (other) assert.ok(own.some(row => row.value.request.packet.id === other.id));
    assert.ok(!cycles.some(row => row.value.request.packet.id === waiting.id), "No cycle terminal is invented for the ceased cycle");
    const series = f.store.list<RepairSeries>("repair-series")[0]!;
    assert.notEqual(series.value.attempts[0]!.outcome, null, "G7 closed the first attempt");
    // LP6 (№3325 row 15): an end by the moved environment and a ceased cycle step is no administrative end of the area's B1.
    const binding = ok(readCompletionBinding(f.store, project, reference(series), 1))!;
    const close = ok(readCompletionCloseAt(f.store, project, reference(f.store.get(completionCloseId(project, binding.id))!)));
    assert.deepEqual([close.contract, close.outcome.progress?.administrative], ["om-completion-close/v2", null]);
  });
});

test("MP2 return №3147: through the pass after a restart, a changed environment between the paid repairable refusal and its correction ceases the step and its root and closes the attempt by G7 — never waiting on completion_claim_exists, nothing sent again", async t => {
  const f = worksFixture(t);
  ok(startRun(f.store, { project }));
  let cycle: { request: { packet: Ref } } | null = null;
  for (let index = 0; index < 40 && !cycle; index++) {
    const state = ok(await advanceRun(f.store, f.request)).record.value.state as unknown as { phase: string; step?: { action: string; request: { packet: Ref } } };
    assert.notEqual(state.phase, "waiting", JSON.stringify(state));
    if (state.phase === "step" && state.step!.action === "cycle") cycle = state.step!;
  }
  assert.ok(cycle, "A cycle step is chosen");
  const answer = mp2WorkAnswer(f, cycle!.request.packet).research;
  answer.proposal.fills = answer.proposal.fills.map((fill, at) => at === 0 ? { ...fill, obligation: "X999" } : fill);
  writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps: [{ research: answer, usage }] }));
  const first = ok(await runModelCall(f.store, cycle!.request as never));
  assert.equal(first.record.value.om.failure?.code, "answer_label_unknown");
  const moved = lp4Configure(f, f.request);
  const seen: string[] = [];
  for (let index = 0; index < 40; index++) {
    f.restart();
    const advanced = ok(await advanceRun(f.store, moved)), state = advanced.record.value.state;
    seen.push(state.phase === "waiting" ? `waiting:${(state as unknown as { wait: { code: string } }).wait.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    assert.ok(!(state.phase === "waiting" && (state as unknown as { wait: { code: string } }).wait.code === "completion_claim_exists"), seen.join(","));
    if (advanced.performed?.action === "close") break;
  }
  assert.ok(seen.some(step => step.endsWith(":close")), `The attempt closes: ${seen.join(",")}`);
  const cessations = f.store.list<{ cause: { kind: string }; remainder: string }>("om-completion-cessation");
  assert.ok(cessations.some(row => row.value.cause.kind === "required-record-replaced" && row.value.remainder === "continuation"), "The owed step ceased");
  assert.ok(cessations.some(row => row.value.cause.kind === "cycle-step-ceased"), "Its root ceased by the ceased step");
  // §6.3: the other root is worked by its own rules in the new environment, so the sends are counted by packet.
  assert.equal(lp4Sent(f, cycle!.request.packet), 1, "The paid answer is never sent again");
  const corrections = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.request.correction && row.value.state === "ready");
  assert.ok(!corrections.some(row => lp4Sent(f, reference(row)) > 0
    || f.store.get(modelCallRecordId(project, (row.value.packet as { requestId: string }).requestId))), "The correction is never sent and no correction call exists");
});

test("LP6 current mixed attempts keep their applied field beside refusal, owner wait or interruption: progress closes preserve failure evidence after restart", async t => {
  for (const kind of ["refusal", "owner", "interrupted"] as const) await t.test(kind, async t => {
    const f = lp6Line(t);
    const failed: Lp6Op & { op: "round" } = { op: "round", ordinal: 1, answers: [
      { field: "expansion", ...(kind === "refusal" ? { cannot: "The expansion is unresolved" } : kind === "owner" ? { owner: "The owner decides the expansion" } : { exit: 1 }) },
      { field: "nodes", value: ["garden-produce-block", "garden-consume-block"] },
    ] };
    const made = await lp6CurrentRounds(f, [failed, { op: "cease", ordinal: 1 }, { op: "close", ordinal: 1 }]);
    assert.deepEqual(made.verdicts, ["progress"]);
    assert.equal(made.calls.length, 2);
    const [failure, accepted] = made.calls;
    assert.ok(failure!.diagnostic && accepted!.record.value.om.input);
    const code = kind === "refusal" ? "model_cannot_answer" : kind === "owner" ? "model_need_owner" : "model_adapter_interrupted";
    const close = lp6Close(f, 1);
    assert.ok(close.claim.refusals.some(row => row.name === code), JSON.stringify(close.claim.refusals));
    const binding = ok(readCompletionBinding(f.store, project, reference(f.head()), 1))!;
    const snapshot = ok(readCompletionWorkAt(f.store, project, close.work));
    for (const call of made.calls) {
      const packet = f.store.get<QuestionPacketRecord>(call.packet.id, call.packet.revision)!.value;
      assert.equal(packet.request.attempt!.ordinal, 1);
      assert.equal(packet.request.attempt!.series.id, f.head().id);
      assert.ok(snapshot.assignments.some(row => row.value.batch === packet.request.batch));
    }
    assert.deepEqual(close.binding, reference(binding));
    assert.ok(close.claim.accepting.some(ref => canonical(ref) === canonical(reference(accepted!.record))));
    assert.equal(f.store.get(`om-input:${project}`)!.revision, 2, "Its own D3 applied the partial field");
    if (kind === "owner") assert.deepEqual(close.waiting, [failure!.diagnostic]);
    else assert.deepEqual(close.waiting, []);
    const evidence = ok(deriveCompletionEvidence(f.store, project, { series: reference(f.head()), ordinals: [1] }));
    assert.equal(evidence[0]!.effect, "failure");
    assert.ok(evidence[0]!.results.length > 0);
    assert.deepEqual(evidence[0]!.decisions.map(row => row.e4), [reference(accepted!.record)]);
    assert.deepEqual(evidence[0]!.remaining, [
      ...close.claim.refusals.map(row => `refusal ${row.name} of ${row.goal} (row ${row.row})`),
      ...close.waiting.map(ref => `waiting for the owner on ${ref.id}@${ref.revision}`),
      ...(kind === "interrupted" ? [`interrupted of model-call (${failure!.record.id}@${failure!.record.revision})`] : []),
    ]);
    const saved = f.store.list(); f.restart();
    assert.deepEqual(ok(deriveCompletionEvidence(f.store, project, { series: reference(f.head()), ordinals: [1] })), evidence);
    assert.deepEqual(lp6Close(f, 1), close);
    assert.deepEqual(f.store.list(), saved);
    assert.equal(f.sent().length, 2);
  });
});

test("LP7 row 26: one question of a joined batch waiting for the owner holds that whole batch — none of its fields is asked again — while a free batch the wait does not hold is worked on", async t => {
  const f = runFixture(t, ["encoding"], "stages", false, false, true);
  // Accept N2 without addressing B1: its joined input batch must remain open.
  prepareNativeLayers(f.engine, project, gardenGraph(), "n2");
  const built = ok(writeRunBases(f.store, { project })), request = f.request();
  assert.equal(f.store.get<RoutesRecord>(built.bases.routes.id, built.bases.routes.revision)!.value.grouping, "block-input-v1");
  const source = () => f.store.get<{ content: string }>(`source:${project}:brief`)!;
  const steps: Record<string, unknown>[] = [], sent: string[][] = [];
  let state = ok(await advanceRun(f.store, request)).record.value.state;
  for (let index = 0; index < 80 && !["waiting", "complete", "unable"].includes(state.phase); index++) {
    if (state.phase === "step" && state.step.action === "assess") { steps.push(assessor("supported")); f.steps(steps); }
    if (state.phase === "step" && state.step.action === "cycle") {
      const ref = (state.step.request as unknown as { packet: Ref }).packet;
      const packet = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!;
      const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
      sent.push([...new Set(batch.items.map(item => item.field))].sort());
      // M5 addresses the encoding; the block asks the owner one question of its joined batch, answers its fact
      // and works the real N3 expansion batches the wait does not hold.
      steps.push(batch.items.every(item => item.field === "address") ? { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
          results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: { consumer: "garden-consume-block", kind: "repository-fact" } })) }, usage }
        : batch.items.some(item => item.field === "checkKind") ? { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_owner",
          questionIds: batch.items.filter(item => item.field === "checkKind").map(item => item.gap), reason: "The owner decides the check kind", decision: "Name it" }, usage }
        : batch.task === "node-expansion" ? { ...mp2WorkAnswer({ store: f.store, desired: gardenGraph() }, ref), usage }
        : { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: batch.items.map(item => ({ questionId: item.gap, value: { answer: "UTF-8" },
          citations: [{ source: reference(source()), selector: { kind: "text-range", start: 0, end: source().value.content.length } }] })) }, usage });
      f.steps(steps);
    }
    state = ok(await advanceRun(f.store, request)).record.value.state;
  }
  assert.deepEqual(sent[0], ["address"], "Row 6: M5 goes first, and the address keeps its own batch beside the joined one");
  assert.deepEqual(sent.map(row => row.join("+")).sort(),
    ["address", "answer", "checkKind+nodes+state", "fill", "fill", "fill"],
    `Each batch once: M5, the free fact, the joined batch whose one question waits, and the real N3 fills: ${JSON.stringify(sent)}`);
  assert.ok(actions(f.store).includes("assess"), "The free fact batch is worked on — its answer is assessed — beside the wait");
  assert.equal(state.phase, "waiting", JSON.stringify(state));
  // The wait holds the whole joined batch: further steps ask none of its fields again and pay nothing.
  const calls = f.sent().length, attempts = blockSeries(f).value.attempts.length;
  for (let index = 0; index < 3; index++) ok(await advanceRun(f.store, request));
  assert.deepEqual([f.sent().length, blockSeries(f).value.attempts.length], [calls, attempts],
    "The held joined batch is never asked again while the pass waits on its owner");
});

test("LP8.1 grounds that stay final: an unable pass on a review that never completed stands — advance, start and continue write nothing, take no execution and send nothing, also after a restart", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("lp81-final"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, { rawStdout: "{broken", exitCode: 7, stderr: "intentional reviewer failure" }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveTo(f, request, "analyze", 40);
  const end = await ends(f, request, 5);
  assert.equal(end.state.phase, "unable");
  const before = canonical(f.store.list().map(reference) as unknown as Json), sends = f.sent().length;
  for (const restart of [false, true]) {
    if (restart) f.restart();
    assert.equal(ok(await advanceRun(f.store, request)).performed, null);
    const started = ok(await startPass(f.store, { project })), continued = ok(await continuePass(f.store, { project }));
    assert.deepEqual([started.end, continued.end], ["unable", "unable"]);
    assert.equal(canonical(f.store.list().map(reference) as unknown as Json), before, "Nothing is written — no reopening, no execution claim");
    assert.equal(f.sent().length, sends);
  }
  assert.deepEqual(passRows(f.store).filter(phase => phase === "reopened"), []);
});

test("LP8.1 start and continue of an unable pass whose grounds no longer stand drive it: the reopening and the next work under one execution", async t => {
  const { f, unable, unchanged } = await unavailableReview(t);
  ok(configureDispatch(f.store, { project, protocol: "codex-stdio" }));
  // The grounds stop standing on the owner's own continuation: a decision on the exact stop resumes the series
  // by today's rules, so the next entry reopens the pass and works the new attempt in the same execution.
  const stopped = f.store.list<AnyRepairSeries>("repair-series").find(row => "owner" in row.value)!, stop = stopped.value.stop!;
  const decision = f.store.write({ id: `${ownerDecisionNamespace(project)}lp81-continue`, kind: OWNER_DECISION_KIND, expected: 0,
    value: { projectId: project, owner: { kind: "mechanism", mechanism: "M5:addressing" }, stop: stop.attempt, goals: [...stop.goals],
      decided: "go on: one more window", taken: { by: "the owner", through: "the command API", approved: true } } });
  ok(resumeSeries(f.store, { ...seriesRequestOf(stopped.value), stop: stop.attempt, ground: "owner-decision",
    text: "the owner decided to go on", decision: { ref: reference(decision) } } as never));
  ok(await continuePass(f.store, { project }));
  const rows = passRows(f.store);
  assert.equal(rows.filter(phase => phase === "reopened").length, 1);
  const reopened = f.store.history<RunRecord>(runId(project)).find(row => row.value.state.phase === "reopened")!.value.state;
  assert.ok(reopened.phase === "reopened");
  assert.deepEqual([reopened.from, reopened.reasons], [reference(unable), reasonsOf(unable.value.state)]);
  assert.deepEqual(Object.keys(reopened.ground), ["step"]);
  assert.ok("step" in reopened.ground);
  assert.equal(reopened.ground.step.action, "open");
  assert.equal(reopened.ground.step.attempt, stop.attempt + 1);
  assert.equal(reopened.ground.step.series, stopped.id);
  assert.ok(f.store.history(runId(project)).some(row => row.revision > unable.revision + 1
    && (row.value as unknown as RunRecord).last?.step.action === "open"), "The continue drove the pass past its old end");
  // A second start reads the pass's own standing and never reopens it again.
  ok(await startPass(f.store, { project }));
  assert.equal(passRows(f.store).filter(phase => phase === "reopened").length, 1);
  unchanged();
});
test("AT1 door: an unresolved transition refused by G5 is asked in B1 once, researched, applied, and the next works decide what it reaches and pass G5 on the same snapshot", async t => {
  const f = worksFixture(t), work = f.desired.nodes.find(node => node.id === "garden-produce-work")!;
  // LG24 (№12218): the full Store — every record's head and all its saved revisions — proves a check wrote nothing.
  const snapshot = () => f.store.list().map(head => ({ head: reference(head), history: f.store.history(head.id).map(reference) }));
  const written = work.code.find(code => code.access === "write")!.path;
  // The workspace is a repository whose test loads a file by a computed URL — the file the producing work writes.
  mkdirSync(join(f.root, "test"), { recursive: true });
  writeFileSync(join(f.root, written), "seed\n");
  writeFileSync(join(f.root, "test", "loader.test.ts"), 'import test from "node:test";\nconst data = new URL(process.env.DATA!, import.meta.url);\ntest("loads its data", () => data);\n');
  git(f.root, ["init", "-q", "-b", "main"]); git(f.root, ["add", written, "test/loader.test.ts"]);
  git(f.root, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base"]);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>(), forms: unknown[] = [];
  let applied = false, restarted = false, last: unknown = null, seenPending = false;
  for (let index = 0; index < 500 && !worksAcceptance(f.store).frame; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const action = advanced.performed?.action ?? "";
    if (action) performed.push(action);
    // LG24 (№12218): the refusal is the real producer's saved G5 — before its question reaches B1 the pending read
    // answers true, and does so cold, through a second Store on the same database; the read itself writes nothing.
    if (!seenPending) {
      const row = f.store.list<{ result: { findings: { code: string }[] } }>("om-atomic-gate")
        .find(item => item.value.result.findings.some(finding => finding.code === "work_impact_unresolved"));
      if (row) {
        seenPending = true;
        const before = snapshot();
        const other = new Store(f.database);
        try {
          const cold = readinessPending(other, project, reference(row));
          assert.ok(cold.ok && cold.value === true, "a saved refused G5 has its transition pending — read cold on a second Store");
        } finally { other.close(); }
        assert.deepEqual(snapshot(), before, "the pending check read but never wrote");
      }
    }
    // A crash right after the B1 transition: the pass goes on from the store, asking nothing twice.
    if (action === "readiness" && !restarted) { restarted = true; f.restart(); }
    if (action === "apply" && f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.facts?.some(fact => fact.question.readiness) && !applied) {
      applied = true;
      // What the works of the next attempt decide: the test the resolved transition reaches is kept for the data contract.
      work.impact = [{ entry: { files: ["test/loader.test.ts"] }, decision: "keep", requirement: f.desired.contracts[0]!.id }];
    }
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet: Ref } } };
    last = state;
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") break;
    if (state.phase !== "step") continue;
    const key = JSON.stringify(state.step!.request);
    if (state.step!.action === "cycle" && !answered.has(key)) {
      answered.add(key);
      const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
      const routed = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routed.batches.find(row => row.id === packet.value.request.batch)!;
      if (batch.model !== "MC1") f.answer(saved);
      else {
        forms.push(packet.value.packet);
        const source = f.store.get<{ content: string }>(`source:${project}:brief`)!;
        f.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
          results: batch.items.map(item => ({ questionId: item.gap, value: { answer: `The test loads ${written} by its DATA path`, resolves: [written] },
            citations: [{ source: reference(source), selector: { kind: "text-range", start: 0, end: source.value.content.length } }] })) }, usage });
      }
    }
    if (state.step!.action === "assess" && !answered.has(key)) { answered.add(key); f.push(assessor("supported")); }
  }
  const trail = `${performed.join(",")} ${JSON.stringify(last).slice(0, 1500)}`;
  const gates = f.store.list<{ result: { passed: boolean; findings: { code: string; target: string; field?: string }[] };
    impact?: { snapshot: { tree: string } | null; resolutions?: { question: string; resolves: string[] }[]; works: { work: string; coverage: { test: string; by: string }[] }[] } }>("om-atomic-gate");
  const refused = gates.find(row => row.value.result.findings.some(item => item.code === "work_impact_unresolved"));
  assert.ok(refused, `G5 refused the unresolved transition: ${trail}`);
  assert.deepEqual(refused!.value.result.findings.filter(item => item.code === "work_impact_unresolved").map(item => [item.target, item.field]),
    [["garden-produce-work", `test/loader.test.ts:2#${"import test from \"node:test\";\nconst data = ".length}-${"import test from \"node:test\";\nconst data = new URL(process.env.DATA!, import.meta.url)".length}`]]);
  assert.deepEqual(performed.filter(row => row === "readiness"), ["readiness"], `The transition is asked once: ${trail}`);
  assert.ok(performed.indexOf("readiness") < performed.lastIndexOf("apply") && performed.lastIndexOf("apply") < performed.lastIndexOf("works"), trail);
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  const facts = (input.value.input.facts ?? []).filter(fact => fact.question.readiness);
  assert.equal(facts.length, 1, "One readiness question, answered and applied");
  const cause = facts[0]!.question.readiness as ReadinessTransition;
  assert.deepEqual([facts[0]!.question.source.id, facts[0]!.question.consumer, cause.works, cause.snapshot.tree, facts[0]!.value],
    [refused!.id, "garden-produce-operation", ["garden-produce-work"], refused!.value.impact!.snapshot!.tree,
      { answer: `The test loads ${written} by its DATA path`, resolves: [written] }]);
  assert.ok(forms.some(form => JSON.stringify(form).includes(`"resolves":{"items":{"enum":["${written}"`)), `The research packet names the snapshot's candidates: ${JSON.stringify(forms).slice(0, 3000)}`);
  const passed = gates.find(row => row.value.result.passed)!;
  assert.ok(passed, `G5 passed: ${JSON.stringify(worksAcceptance(f.store).findings)} ${trail}`);
  assert.equal(passed.value.impact!.snapshot!.tree, refused!.value.impact!.snapshot!.tree, "The same snapshot");
  assert.deepEqual(passed.value.impact!.resolutions!.map(row => [row.question, row.resolves]), [[facts[0]!.question.id, [written]]]);
  assert.deepEqual(passed.value.impact!.works.find(row => row.work === "garden-produce-work")!.coverage, [{ test: "test/loader.test.ts", by: "file" }]);
  assert.deepEqual(worksAcceptance(f.store).frame, true, "Layer 3 is written");
  // The repeat: the gate's question is answered — nothing is pending and the same transition writes no new B1.
  const before = snapshot();
  assert.equal(ok(readinessPending(f.store, project, reference(refused!))), false);
  assert.deepEqual(snapshot(), before, "the hot pending read wrote nothing");
  // LG24 (№12218): the same on a second Store — the held question is not pending on a cold read either.
  const cold = new Store(f.database);
  try {
    const held = readinessPending(cold, project, reference(refused!));
    assert.ok(held.ok && held.value === false, "cold: the held question is not pending on a new Store");
  } finally { cold.close(); }
  assert.deepEqual(snapshot(), before, "the cold pending read wrote nothing");
  const derivation = f.store.history(input.id).map(row => (row.value as unknown as OmInputRecord).derivation).find(row => row && "kind" in row && row.kind === "readiness")!;
  assert.deepEqual(ok(writeReadinessInput(f.store, { project, input: (derivation as { previous: Ref }).previous, gate: reference(refused!) })).value.derivation, derivation);
  assert.equal(f.store.get(input.id)!.revision, input.revision);
  assert.deepEqual(snapshot(), before, "the exact repeat wrote nothing");
  // LG24: a copy of this saved gate forged to the earlier or an unknown contract, or losing its contract or its impact,
  // is refused record_forged at its own address by the common readiness source — never silently false.
  const copied = () => structuredClone(refused!.value) as Record<string, Json>;
  const forged: [string, Json][] = [["earlier-v1", { ...copied(), contract: "om-atomic-gate/v1" } as Json],
    ["unknown-contract", { ...copied(), contract: "om-atomic-gate/v9" } as Json],
    ["absent-contract", (() => { const value = copied(); delete value.contract; return value; })()],
    ["absent-impact", (() => { const value = copied(); delete value.impact; return value; })()]];
  const copies = forged.map(([name, value]) => [name,
    reference(f.store.write({ id: `om-atomic-gate:${project}:lg24-${name}`, kind: "om-atomic-gate", expected: 0, value }))] as const);
  const untouched = snapshot();
  for (const [name, copy] of copies) {
    const result = readinessPending(f.store, project, copy);
    assert.ok(!result.ok, `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual([result.refusal.code, result.refusal.at], ["record_forged", { unit: "G1", target: copy.id, field: "impact", ref: copy }], name);
    assert.deepEqual(snapshot(), untouched, `${name}: the forged check read but never wrote`);
  }
});
test("AT1 policy: a durable work's state policy is asked once at its producer and decided by the model in the bypass; the works refer to it and pass G5", async t => policyDoor(t, false));
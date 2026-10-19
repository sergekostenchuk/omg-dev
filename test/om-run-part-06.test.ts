import { readCompletionWorkAt } from "../src/om/model-call.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Revision, Store, type Write } from "../src/storage/store.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { git } from "../src/runtime/environment.js";
import type { OmInputRecord } from "../src/om/input.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { beginAttempt, openSeries, readCompletionBinding } from "../src/om/series.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { type RoutesRecord } from "../src/om/routes.js";
import { readRouteProducers } from "../src/om/answers-gate.js";
import type { RepairSeries } from "../src/om/series.js";
import { closeAttempt, deriveCompletionEvidence } from "../src/om/repeat-gate.js";
import { modelCallRecordId, prepareCompletionCause, runModelCall } from "../src/om/model-call.js";
import { gapLineKey } from "../src/om/gap-lines.js";
import { readRun, startRun, runId, type RunRecord, type RunWait } from "../src/om/run.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { prepareReconcileSeries, readSeries, readSeriesProgressTransitionAt, completionCloseId, seriesProgressTransitionId, SERIES_PROGRESS_TRANSITION_KIND } from "../src/om/series.js";
import { readCompletionCloseAt } from "../src/om/repeat-gate.js";
import { stopReportOfNewEra } from "../src/om/stop-report.js";
// ---- LP8.1 (№3670): an unable pass weighs its grounds again by today's rules at every entry ----
import { continuePass, startPass } from "../src/om/run-driver.js";
import { configureDispatch } from "../src/om/dispatch.js";
// AT1 door (№4105): a works answer whose file a test may load through a transition nobody resolved is refused by G5; the
// group's rejection first asks that transition in B1 (its source the saved gate), research answers it with the exact files
// of the snapshot, the answer is applied, and the next works — now deciding the test the transition reaches — pass G5 on
// the same snapshot. The question is asked once; a repeat of the B1 transition writes nothing.
import { readinessPending, writeReadinessInput, type ReadinessTransition } from "../src/om/input.js";
import { project, ok, refusal, runFixture, type Fixture, addressAll, usage, assessor, mechanismSeries, blockSeries, actions, ends, driveTo, reasonsOf, stopAnswer, cannotAnswer, until, regatePolicy, nodeAnswer, worksFixture, worksAcceptance, nodeRefusal, addressQuestions, advanceRun, lp4Configure, lp4Questions, lp4Sent, lp4Close, mp2WorkAnswer, type Lp6Op, lp6Line, lp6CurrentRounds, lp6Close, passRows, unavailableReview, policyDoor } from "./om-run-fixture.js";


test("H1.2 R7 C01 C33 C59 both kinds of line ask the owner: the grounds keep their canonical order without a repeat, and a malformed end is an integrity refusal", async t => {
  const f = runFixture(t, ["encoding", "spare"], true, ["encoding"]);
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
  const f = runFixture(t, ["encoding"]);
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
  const f = runFixture(t, ["encoding"], true, true);
  const request = f.request(f.bases("h12-resolved"));
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h12-resolved", predecessor: null, basis: null }));
  // The earlier attempt asked the owner about a question that today's routes no longer carry (it was decided elsewhere).
  ok(beginAttempt(f.store, { ...address, attempt: 1, goal: { key: "h12-gone-goal", questions: [gapLineKey(project, "discovery:gone", "answer")], result: "A supported fact" } }));
  ok(closeAttempt(f.store, { ...address, attempt: 1, outcome: { reason: "awaiting-owner", accepting: [], cancelling: [], refusals: [] } }));
  ok(startRun(f.store, { project }));
  const driven = await driveTo(f, request, "open", 10);
  assert.deepEqual(driven.performed, ["open"], "A new attempt of the line opens for today's question; the old one holds nothing");
  assert.equal(blockSeries(f).value.attempts.length, 2);
  assert.notEqual(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
});

test("25 R4 №1770 H1 N2 mixed: A's assembly waits open for the frame; B's negative attempt closes by its own G7 meanwhile, nothing is paid twice", async t => {
  const f = runFixture(t, [], false);
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
  const f = runFixture(t);
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
  const f = runFixture(t, ["proof"], true, false, false, false, { proof: { moment: "task-start" } });
  addressQuestions(f, [["proof", "design-decision"]]);
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value;
  const batch = routes.batches.find(item => item.items.some(row => row.target === "discovery:proof" && row.field === "answer"));
  assert.ok(batch, "M6 makes a batch of every design decision, whatever its moment");
  const read = ok(readRouteProducers(f.store, { project, routes: bases.routes }));
  assert.deepEqual(read.batches.filter(row => row.unserved.length).map(row => row.batch), [batch!.id], "The batch has no producer, blocking or not");
  ok(startRun(f.store, { project }));
  const idle = await ends(f, f.request(), 12);
  assert.equal(idle.state.phase, "waiting", JSON.stringify(idle.state));
  assert.equal((idle.state as unknown as { wait: RunWait }).wait.code, "run_idle", "A question of task-start does not end the pass");
  assert.equal(f.store.list("repair-series").length, 0, "Not planned, not asked");
  assert.equal(f.sent().length, 0);
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
    const f = lp6Line(t, "");
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

test("LP6 return №3371: an accepted field beside a real failure of the same attempt — a refusal of the model (the reviewer's probe), the owner's wait, an interrupted call — is no reconciled row: the stop stands for the producer, for the reader of a transition and after a reopen, and the facts A6 is shown keep the mixed end", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  // A stop e7db0ba8 saved over three mixed attempts, the producer and the reader of the new era over it.
  const check = (f: ReturnType<typeof lp6Line>, failures: RegExp[]) => {
    const stopped = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
    assert.deepEqual([stopped.stop?.attempt, stopped.withoutProgress], [3, 3]);
    // The facts of every attempt: a fresh result of its own field AND the failure beside it — never an input transition.
    const report = ok(stopReportOfNewEra(f.store, f.address as never)), evidence = report.completionEvidence!;
    assert.deepEqual(evidence.map(row => [row.ordinal, row.effect, row.results.length > 0]), [[1, "failure", true], [2, "failure", true], [3, "failure", true]]);
    evidence.forEach((row, index) => assert.ok(row.remaining.some(item => failures[index]!.test(item)), row.remaining.join("; ")));
    assert.notEqual(report.finding.subject, "input-transition");
    assert.ok(report.lines.some(line => line.includes("beside real failure")), "The text of the report says the end was mixed");
    // The producer: no transition — the first row with a real failure answers for the whole window; nothing is prepared.
    const unfit = refusal(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never));
    assert.deepEqual([unfit.code, unfit.at.field], ["progress_unproved", "attempts.1"]);
    assert.match(unfit.message, failures[0]!);
    // The reader: a transition of this stop that took the fresh fields alone (as a derivation blind to the failures would
    // write it), seen through a view — the database is never touched — is refused by the one derivation it is read by.
    const goals = new Map(stopped.attempts.map(row => [row.ordinal, row.goal]));
    const blind = { contract: "om-series-progress-transition/v1", project, series: reference(f.head()), stop: 3,
      rows: evidence.map(row => ({ ordinal: row.ordinal, goal: goals.get(row.ordinal)!, close: row.close!, result: "input-field",
        achieved: [...row.results], sources: row.decisions.map(decision => decision.e4) })) };
    const id = seriesProgressTransitionId(project, reference(f.head()), 3), planted = { id, revision: 1, hash: hashJson(blind as unknown as Json) };
    const view = new Proxy(f.store, { get(target, property) {
      if (property === "get") return (key: string, revision?: number) => key === id
        ? { id, kind: SERIES_PROGRESS_TRANSITION_KIND, revision: 1, hash: planted.hash, value: blind } : target.get(key, revision);
      const member: unknown = Reflect.get(target, property, target); return typeof member === "function" ? member.bind(target) : member;
    } }) as Store;
    assert.equal(refusal(readSeriesProgressTransitionAt(view, project, planted)).code, "progress_unproved");
    // After a reopen: the stop stands, the count is not cleared, no transition exists.
    f.restart();
    const again = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
    assert.deepEqual([again.stop?.attempt, again.withoutProgress, again.reconciliations, again.progressPolicy], [3, 3, undefined, undefined]);
    assert.equal(f.store.list(SERIES_PROGRESS_TRANSITION_KIND).length, 0);
    assert.equal(refusal(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never)).code, "progress_unproved");
  };
  // The reviewer's probe (№3371): each attempt refused by the model on its node and, beside it, its own field applied.
  const probe = lp6Line(t);
  const refused = probe.old("probe", ([[1, "nodes", ["garden-produce-block", "garden-consume-block"]],
    [2, "state", { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-produce-block" }], [3, "checkKind", "test"]] as const)
    .flatMap(([ordinal, field, value]) => [{ op: "round", ordinal, answers: [{ field: "expansion", cannot: `Real unresolved refusal ${ordinal}` }, { field, value }] },
      { op: "cease", ordinal }, { op: "close", ordinal }] as Lp6Op[]));
  assert.deepEqual(refused.verdicts, ["none", "none", "none"]);
  check(probe, [/model_cannot_answer/, /model_cannot_answer/, /model_cannot_answer/]);
  // The owner's wait and an interrupted call beside an applied field, each in an attempt the old rules count.
  const other = lp6Line(t);
  const mixed = other.old("mixed", [
    { op: "round", ordinal: 1, answers: [{ field: "checkKind", owner: "The owner names the check of the criterion" },
      { field: "nodes", value: ["garden-produce-block", "garden-consume-block"] }, { field: "expansion", unsent: true }] },
    { op: "cease", ordinal: 1 }, { op: "close", ordinal: 1 },
    { op: "round", ordinal: 2, answers: [{ field: "expansion", exit: 1 },
      { field: "state", value: { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-produce-block" } }] },
    { op: "cease", ordinal: 2 }, { op: "close", ordinal: 2 },
    { op: "round", ordinal: 3, answers: [{ field: "expansion", exit: 1 }, { field: "checkKind", value: "test" }] },
    { op: "cease", ordinal: 3 }, { op: "close", ordinal: 3 },
  ]);
  assert.deepEqual(mixed.verdicts, ["none", "none", "none"]);
  check(other, [/waiting for the owner/, /model_adapter_interrupted/, /model_adapter_interrupted/]);
});




test("LP7 row 26: one question of a joined batch waiting for the owner holds that whole batch — none of its fields is asked again — while a free batch the wait does not hold is worked on", async t => {
  const f = runFixture(t, ["encoding"], true, false, false, true);
  const built = ok(writeRunBases(f.store, { project })), request = f.request();
  assert.equal(f.store.get<RoutesRecord>(built.bases.routes.id, built.bases.routes.revision)!.value.grouping, "block-input-v1");
  const source = () => f.store.get<{ content: string }>(`source:${project}:brief`)!;
  const steps: Record<string, unknown>[] = [], sent: string[][] = [];
  let state = ok(await advanceRun(f.store, request)).record.value.state;
  for (let index = 0; index < 80 && !["waiting", "complete", "unable"].includes(state.phase); index++) {
    if (state.phase === "step" && state.step.action === "assess") { steps.push(assessor("supported")); f.steps(steps); }
    if (state.phase === "step" && state.step.action === "cycle") {
      const packet = f.store.get<QuestionPacketRecord>((state.step.request as unknown as { packet: Ref }).packet.id)!;
      const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
      sent.push([...new Set(batch.items.map(item => item.field))].sort());
      // M5 addresses the encoding; the block asks the owner one question of its joined batch and answers its fact.
      steps.push(batch.items.every(item => item.field === "address") ? { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
          results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: { consumer: "garden-consume-block", kind: "repository-fact" } })) }, usage }
        : batch.task === "input-field" ? { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_owner",
          questionIds: batch.items.filter(item => item.field === "checkKind").map(item => item.gap), reason: "The owner decides the check kind", decision: "Name it" }, usage }
        : { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: batch.items.map(item => ({ questionId: item.gap, value: { answer: "UTF-8" },
          citations: [{ source: reference(source()), selector: { kind: "text-range", start: 0, end: source().value.content.length } }] })) }, usage });
      f.steps(steps);
    }
    state = ok(await advanceRun(f.store, request)).record.value.state;
  }
  assert.deepEqual(sent[0], ["address"], "Row 6: M5 goes first, and the address keeps its own batch beside the joined one");
  assert.deepEqual(sent.map(row => row.join("+")).sort(), ["address", "answer", "checkKind+nodes+state"],
    `Each batch once: M5, the free fact and the joined batch whose one question waits: ${JSON.stringify(sent)}`);
  assert.ok(actions(f.store).includes("assess"), "The free fact batch is worked on — its answer is assessed — beside the wait");
  assert.equal(state.phase, "waiting");
  // The wait holds the whole joined batch: further steps ask none of its fields again and pay nothing.
  const calls = f.sent().length;
  for (let index = 0; index < 3; index++) ok(await advanceRun(f.store, request));
  assert.deepEqual([f.sent().length, blockSeries(f).value.attempts.length], [calls, 1]);
});

test("LP8.1 grounds that stay final: an unable pass on a review that never completed stands — advance, start and continue write nothing, take no execution and send nothing, also after a restart", async t => {
  const f = runFixture(t, ["encoding"]);
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

test("LP8.1 start and continue of an unable pass whose grounds no longer stand drive it: the reopening, the recovery and the next work under one execution", async t => {
  const { f, failure, unable, unchanged } = await unavailableReview(t);
  ok(configureDispatch(f.store, { project, protocol: "codex-stdio" }));
  const sends = f.sent().length;
  let recoveries = 0;
  class ObservedRecovery extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (writes.some(write => write.kind === "om-stop-review" && Object.hasOwn(write.value as object, "recovery"))) {
        assert.equal(f.sent().length, sends, "The exact paid answer is recovered without another call");
        recoveries++;
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new ObservedRecovery(path));
  ok(await continuePass(f.store, { project }));
  const rows = passRows(f.store);
  assert.equal(rows.filter(phase => phase === "reopened").length, 1);
  const reopened = f.store.history<RunRecord>(runId(project)).find(row => row.value.state.phase === "reopened")!.value.state;
  assert.ok(reopened.phase === "reopened");
  assert.deepEqual([reopened.from, reopened.reasons], [reference(unable), reasonsOf(unable.value.state)]);
  assert.deepEqual(Object.keys(reopened.ground), ["step"]);
  assert.ok("step" in reopened.ground);
  assert.equal(reopened.ground.step.action, "recover-analysis");
  assert.deepEqual((reopened.ground.step.request as unknown as { failure: Ref }).failure, failure);
  assert.equal(recoveries, 1);
  assert.ok(f.store.history(runId(project)).some(row => row.revision > unable.revision + 1
    && (row.value as unknown as RunRecord).last?.step.action === "resume"), "The continue drove the pass past its old end");
  assert.ok(f.store.list().some(row => row.kind === "om-stop-review" && canonical((row.value as { recovery?: { failure: Ref } }).recovery?.failure as unknown as Json) === canonical(failure as unknown as Json)));
  assert.ok(f.sent().length >= sends, "Only the work after the recovery may call");
  // A second start finds the pass live and never reopens it again.
  ok(await startPass(f.store, { project }));
  assert.equal(passRows(f.store).filter(phase => phase === "reopened").length, 1);
  unchanged();
});
test("AT1 door: an unresolved transition refused by G5 is asked in B1 once, researched, applied, and the next works decide what it reaches and pass G5 on the same snapshot", async t => {
  const f = worksFixture(t), work = f.desired.nodes.find(node => node.id === "garden-produce-work")!;
  const written = work.code.find(code => code.access === "write")!.path;
  // The workspace is a repository whose test loads a file by a computed URL — the file the producing work writes.
  mkdirSync(join(f.root, "test"), { recursive: true });
  writeFileSync(join(f.root, written), "seed\n");
  writeFileSync(join(f.root, "test", "loader.test.ts"), 'import test from "node:test";\nconst data = new URL(process.env.DATA!, import.meta.url);\ntest("loads its data", () => data);\n');
  git(f.root, ["init", "-q", "-b", "main"]); git(f.root, ["add", written, "test/loader.test.ts"]);
  git(f.root, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base"]);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>(), forms: unknown[] = [];
  let applied = false, restarted = false, last: unknown = null;
  for (let index = 0; index < 500 && !worksAcceptance(f.store).frame; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const action = advanced.performed?.action ?? "";
    if (action) performed.push(action);
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
  assert.equal(ok(readinessPending(f.store, project, reference(refused!))), false);
  const derivation = f.store.history(input.id).map(row => (row.value as unknown as OmInputRecord).derivation).find(row => row && "kind" in row && row.kind === "readiness")!;
  assert.deepEqual(ok(writeReadinessInput(f.store, { project, input: (derivation as { previous: Ref }).previous, gate: reference(refused!) })).value.derivation, derivation);
  assert.equal(f.store.get(input.id)!.revision, input.revision);
});
test("AT1 policy: a durable work's state policy is asked once at its producer and decided by the model in the bypass; the works refer to it and pass G5", async t => policyDoor(t, false));

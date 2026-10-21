import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { Graph } from "../src/graph/model.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import type { Node } from "../src/graph/model.js";
import { ownerDecisionNamespace, OWNER_DECISION_KIND, readCompletionBinding, resumeSeries, seriesRequestOf } from "../src/om/series.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { type RoutesRecord } from "../src/om/routes.js";
import { readRouteProducers } from "../src/om/answers-gate.js";
import type { AnyRepairSeries } from "../src/om/series.js";
import { readRun, startRun, runId, type RunRecord, type RunStep, type RunWait } from "../src/om/run.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
import { checkAnswerForm } from "../src/om/answer-form.js";
// ---- LP5 (№3278): after a replaced B1 the old work ends by its own products, the new bases are built, paid assemblies answer again ----
import { AREA_INPUT_VARIANT, COMPLETION_FINALIZATION_KIND, COMPLETION_REUSE_KIND, type CompletionCessation, type CompletionReuse } from "../src/om/model-call.js";
import type { WorksAcceptanceRecord } from "../src/om/atomic-gate.js";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
import { runWakeChoice, wakeStanding, WAKE_CHOICE_KIND, WAKE_INTENT_KIND } from "../src/om/wake-choice.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { completionCloseId } from "../src/om/series.js";
import { openAttempt, readCompletionCloseAt, readOriginHoldAt, type OriginHold } from "../src/om/repeat-gate.js";
import { readJournalAt } from "../src/om/refusal-journal.js";
import { readManagedModelDiagnostic } from "../src/om/model-call.js";
import { prepareRunBases as lp81PrepareRunBases } from "../src/om/run-bases.js";
import type { OmModelCall } from "../src/om/model-call.js";
import { gardenGraph } from "./om-fixture.js";
import { project, ok, refusal, runFixture, type Fixture, usage, mechanismSeries, blockSeries, actions, ends, driveTo, drive, reasonsOf, blockBases, stopAnswer, cannotAnswer, untouched, secondRung, until, regatePolicy, worksFixture, worksAcceptance, heldAfterClaim, addressQuestions, openPlanned, advanceRun, lp4Questions, lp4Sent, mp2WorkAnswer, twoArtifacts, lp5ReplaceB1, lp5Kind, type Reopened, unavailableReview, sameEnd, regatedHold, defectedWork } from "./om-run-fixture.js";

test("H1.2 R9 R5a a live reviewer keeps the pass waiting; once its loss is proved by the common recovery the failed review ends the pass, and nothing is sent twice", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h1-a6-lost"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const analyzing = await until(f, request, "analyze", 50);
  const release = await heldAfterClaim(t, f, analyzing);
  const held = ok(await advanceRun(f.store, request)), sends = f.sent().length;
  const wait = (held.record.value.state as { wait?: { code: string } }).wait;
  assert.equal(held.record.value.state.phase, "waiting", "A live executor is not a ground of the end");
  assert.equal(wait?.code, "model_call_still_running");
  await release();
  // R5a: the loss is proved by the common recovery and the same saved review goes on to its failed record.
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.performed, analyzing, "The exact saved A6 step");
  assert.ok(f.store.list().some(row => row.kind === "om-stop-analysis-failure"));
  const end = await ends(f, request, 5), series = mechanismSeries(f);
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target]), [["stop-analysis-failed", "analysis_failed", series.id]]);
  assert.equal(f.sent().length, sends, "Nothing is sent again and no second intent exists");
  assert.equal(f.store.list().filter(row => row.kind === "om-analysis-intent").length, 1);
});

test("H1.2 R11 an end derived on a stop that another store lawfully continues before the write is not saved: the next choice reads the new ladder", async t => {
  const { f, request } = await secondRung(t, "executed");
  let raced = false;
  class Continuing extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "unable")) {
        raced = true;
        const other = new Store(f.database);
        try {
          const stopped = other.list<AnyRepairSeries>("repair-series").find(row => "owner" in row.value)!, stop = stopped.value.stop!;
          const decision = other.write({ id: `${ownerDecisionNamespace(project)}h12-window`, kind: OWNER_DECISION_KIND, expected: 0,
            value: { projectId: project, owner: { kind: "mechanism", mechanism: "M5:addressing" }, stop: stop.attempt, goals: [...stop.goals],
              decided: "go on: one more window", taken: { by: "the owner", through: "the command API", approved: true } } });
          ok(resumeSeries(other, { ...seriesRequestOf(stopped.value), stop: stop.attempt, ground: "owner-decision",
            text: "the owner decided to go on", decision: { ref: reference(decision) } } as never));
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Continuing(path));
  const lost = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(lost).code, "input_stale", "The line moved under the derivation: the stale end is not saved");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready");
  f.restart();
  const window = await driveTo(f, request, "bases", 20);
  assert.deepEqual(window.performed, ["open", "packet", "cycle", "close", "bases"], JSON.stringify(window.wait));
  assert.notEqual(ok(readRun(f.store, { project }))!.value.state.phase, "unable", "The next choice read the ladder as it stands now");
});

// OWN1 (№3711): an owner question of the pass is the model's since; a confirmation of the environment the pass itself
// needs (moment om-pass) still has no producer in this product.
test("H1.2 R13b a blocking question nobody can answer in this product ends the pass on that exact question, with no attempt open and nothing invented", async t => {
  const f = runFixture(t, ["encoding"], "n2");
  const input = f.store.get(`om-input:${project}`)!;
  ok(writeAddressing(f.store, { project, input: reference(input), graph: f.graph, decisions: [{ pending: structuredClone(inputDecisionWrite({
    project, input: reference(input), graph: f.graph, layers: [], decision: { target: "discovery:encoding", field: "address",
      value: { consumer: "garden-consume-block", kind: "environment-confirmation" } } })) as Write }] }));
  const request = f.request();
  ok(startRun(f.store, { project }));
  // Native N2 builds a real N3 now; the unserved question is never a part of any packet — every paid call is a works one.
  const replies: Record<string, unknown>[] = [], paid = new Set<string>();
  let end: Awaited<ReturnType<typeof ends>>["state"] | null = null;
  for (let index = 0; index < 200 && !end; index++) {
    const state = ok(await advanceRun(f.store, request)).record.value.state;
    if (state.phase === "step" && state.step.action === "cycle") {
      const ref = (state.step.request as unknown as { packet: Ref }).packet;
      if (paid.has(ref.id)) continue;
      paid.add(ref.id);
      const packet = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!;
      const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
      assert.ok(!batch.items.some(item => item.target === "discovery:encoding"), "The unsupported question is never paid");
      replies.push({ ...mp2WorkAnswer({ store: f.store, desired: gardenGraph() }, ref), usage }); f.steps(replies);
    }
    if (["unable", "waiting", "complete"].includes(state.phase)) end = state;
  }
  assert.ok(end, "The pass reached a terminal state");
  const reasons = reasonsOf(end);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target]), [["unsupported-question", "route_result_unsupported", "discovery:encoding"]]);
  assert.equal(reasons[0]!.field, "answer");
  const calls = f.store.list<OmModelCall>("model-call").filter(row => row.value.om);
  assert.equal(calls.length, paid.size, "Every paid call is an exact N3 packet; none asks the unsupported question");
  assert.equal(f.store.list().filter(row => row.id.startsWith("om-owner-result:")).length, 0, "No owner result is invented");
  const history = () => f.store.list().flatMap(row => f.store.history(row.id).map(reference));
  const before = history();
  await sameEnd(f, request, calls.length);
  assert.deepEqual(history(), before, "A restart writes no revision after the exact unsupported end");
});

test("H1.2 R7 R10a 15 16 C33 need_owner of a goal ends the pass on that goal at any reason of its close; new bases or a restart neither release it nor pay again", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const { m5, second, request } = await blockBases(f);
  const saved = f.store.get<RoutesRecord>(second.routes.id, second.routes.revision)!.value;
  const gap = saved.batches.find(item => item.model === "MC1")!.items[0]!.gap;
  f.steps([m5, { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: [gap], action: "need_owner",
    reason: "Need a concrete source", decision: "Choose the source" }, usage }]);
  const end = await ends(f, request);
  assert.equal(end.performed.at(-1), "close", JSON.stringify(end.state));
  const series = blockSeries(f);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["owner-control", "model_need_owner", series.id, "attempt.1"]]);
  assert.equal(reasons[0]!.message, "Need a concrete source; Choose the source", "The message is the saved diagnostic of E4");
  assert.equal(reasons[0]!.basis.length, 3, "The line, the close of that very attempt and the saved diagnostic");
  assert.equal(series.value.attempts[0]!.outcome!.reason, "awaiting-owner");
  const sends = f.sent().length, before = untouched(f.store);
  // R10a: no base of any kind is built for a pass that ended; the saved end stands across a new store and a restart.
  f.restart();
  assert.equal(refusal(writeRunBases(f.store, { project })).code, "run_bases_terminal");
  assert.equal(refusal(prepareRunBases(f.store, { project })).code, "run_bases_terminal");
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed, again.record.value.state.phase], [null, "unable"]);
  assert.deepEqual(untouched(f.store), before);
  assert.equal(f.sent().length, sends);
  assert.equal(blockSeries(f).value.attempts.length, 1, "The held goal opens no second attempt");
});
test("RL3 №4218 exits 1 and 3: the reopening's policy is asked in B1 before any work and the pass waits for the owner — a repeat writes nothing; the owner's H2 answer is applied first, never asked of the model, carried decided to the works brief, and closes the policy for every work of the contract", async t => regatePolicy(t, "owner"));

test("6 C54 H1 a lawfully changed required condition of an unfinished assignment is ended by the common cessation producer, never sent", async t => {
  const f = runFixture(t, ["encoding", "spare"], "executed", ["encoding"]);
  const b = f.bases("h1-cease"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  const m5 = saved.batches.find(item => item.model === "MC2" && item.task === "input-field")!;
  // M5 waits for its owner, so the independent block is worked (row 3); its first packet is chosen.
  f.steps([{ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: m5.items.map(item => item.gap), action: "need_owner",
    reason: "The owner must name the optional format", decision: "Name it" }, usage }]);
  ok(startRun(f.store, { project }));
  // The block's first packet is chosen (after M5 waits for its owner).
  for (let index = 0; ; index++) {
    assert.ok(index < 30, "The block's packet is chosen");
    const state = ok(await advanceRun(f.store, request)).record.value.state as unknown as { phase: string; step?: { action: string; series: string } };
    if (state.phase === "step" && state.step!.action === "packet" && state.step!.series.includes("garden-consume-block")) break;
  }
  const sends = f.sent().length;
  // The owner addresses the other question in B1 before the block's first dispatch: its required input is replaced.
  const current = f.store.get(`om-input:${project}`)!;
  ok(writeAddressing(f.store, { project, input: reference(current), graph: f.graph, decisions: [{ pending: structuredClone(inputDecisionWrite({
    project, input: reference(current), graph: f.graph, layers: [], decision: { target: "discovery:spare", field: "address",
      value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
  // The saved packet is refused by its own producer (its input is stale), without a send; the next choice ends the
  // assignment by the proved cause instead of retrying it.
  const refused = await drive(f, request, 5);
  assert.deepEqual(refused.performed, ["packet"]);
  assert.equal(refused.wait.code, "input_stale");
  // LP5 (№3278 rows 2, 6, 13): the replaced B1 of the area also ends the registered check, so the attempt closes by the
  // common G7 instead of waiting on its stale check; the bases of the new B1 come next.
  const driven = await driveTo(f, request, "close", 20);
  assert.deepEqual(driven.performed, ["cease", "cease-check", "close"], JSON.stringify(driven.wait));
  assert.equal(f.sent().length, sends, "The ended assignment is never sent");
  assert.ok(f.store.list().some(row => row.kind === "om-completion-cessation"), "The proved cessation is its own record");
  assert.equal(blockSeries(f).value.attempts[0]!.outcome!.reason, "interrupted");
});

test("H1.2 R6 R7 C32 a standing hold and the goal's own owner-control are both grounds: each is named once with its own records, and nothing else is paid", async t => {
  const f = runFixture(t, [], "executed");
  ok(startRun(f.store, { project }));
  // The regated consume line first asks its owner. Before any hold exists, an explicit public openAttempt starts
  // its next managed attempt on the same exact plan; that answer is refused at G5. No attempt opens past a hold.
  const held = await regatedHold(f, {
    cycle: (packet, batch) => batch.task === "node-expansion" && batch.level === 3
      ? defectedWork(f, reference(packet), false) : null,
    analyze: () => ({ research: { protocol: "omg-stop-analysis/v1", cause: null, change: null, origin: null }, usage }),
    pause: { step: "cycle" } });
  const packetRef = (held.second!.step!.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(packetRef.id, packetRef.revision)!;
  const replies = JSON.parse(readFileSync(join(f.root, "scenario.json"), "utf8")).steps as Record<string, unknown>[];
  replies.splice(f.sent().length, 1, { research: { protocol: "$answerProtocol", requestId: "$requestId",
    questionIds: (packet.value.packet as { questions: { id: string }[] }).questions.map(row => row.id),
    action: "need_owner", reason: "The owner must settle this question", decision: "Decide it" }, usage });
  f.steps(replies);
  await driveTo(f, f.request(), "close", 50);
  const waitingSeries = blockSeries(f);
  assert.equal(waitingSeries.value.attempts[0]!.outcome!.reason, "awaiting-owner");
  const waitingBinding = ok(readCompletionBinding(f.store, project, reference(waitingSeries), 1))!;
  const waitingRecord = f.store.get(completionCloseId(project, waitingBinding.id))!;
  const waitingClose = ok(readCompletionCloseAt(f.store, project, reference(waitingRecord)));
  assert.deepEqual([waitingBinding.value.owner, waitingBinding.value.series.id, waitingBinding.value.attempt],
    [{ kind: "block", block: "garden-consume-block" }, waitingSeries.id, 1]);
  assert.deepEqual(waitingClose.binding, reference(waitingBinding));
  assert.equal(waitingClose.series.id, waitingSeries.id);
  assert.equal(waitingClose.waiting.length, 1);
  const waiting = ok(readManagedModelDiagnostic(f.store, waitingBinding, waitingClose.waiting[0]!));
  assert.deepEqual([waiting.reason, waiting.request.code, waiting.request.packet], ["awaiting-owner", "model_need_owner", packetRef]);
  assert.deepEqual(f.store.list("om-origin-hold"), [], "No standing hold is bypassed by the second opening");
  ok(openAttempt(f.store, { project, block: "garden-consume-block", line: 1, attempt: 2,
    goal: waitingSeries.value.attempts[0]!.goal, completion: waitingBinding.value.plan }));
  const reviewing = await held.resume({ pause: { step: "analyze" } });
  assert.equal(reviewing!.step!.action, "analyze");
  const series = blockSeries(f), holds = f.store.list<OriginHold>("om-origin-hold");
  assert.equal(holds.length, 1);
  const hold = holds[0]!;
  assert.deepEqual([hold.value.block, hold.value.series, hold.value.attempt, hold.value.lift],
    ["garden-consume-block", reference(series), 2, null]);
  const binding = ok(readCompletionBinding(f.store, project, reference(series), 2))!;
  const close = ok(readCompletionCloseAt(f.store, project, reference(f.store.get(completionCloseId(project, binding.id))!)));
  assert.equal(close.outcome.reason, "refused");
  assert.ok(close.claim.refusals.some(row => row.row === hold.value.row));
  const journal = ok(readJournalAt(f.store, project, close.journal!));
  const row = journal.value.rows.find(row => row.id === hold.value.row)!;
  assert.deepEqual([row.gate, row.code, row.goal], ["G5", "work_write_scope_unbounded", "garden-consume-work"]);
  assert.deepEqual(reference(ok(readOriginHoldAt(f.store, project, reference(hold), close.journal!))), reference(hold));
  assert.deepEqual((reviewing!.step!.request as { series: Ref; hold: Ref }).series, reference(series));
  assert.deepEqual((reviewing!.step!.request as { series: Ref; hold: Ref }).hold, reference(hold));
  const paid = f.sent().length;
  const end = await held.resume({ pause: { step: "analyze" } });
  const reasons = reasonsOf(end!.state);
  assert.deepEqual(reasons.map(entry => [entry.kind, entry.code, entry.target, entry.field]), [
    ["hold-origin-unestablished", "origin_hold", hold.id, "hold"],
    ["owner-control", "model_need_owner", series.id, "attempt.1"]]);
  assert.deepEqual(reasons[1]!.basis.map(ref => canonical(ref)).sort(),
    [reference(series), reference(waitingRecord), waitingClose.waiting[0]!].map(ref => canonical(ref)).sort(),
    "Owner-control names this line's exact close and its own waiting diagnostic");
  assert.deepEqual(end!.performed, ["analyze"], "Only the review of the hold was paid");
  assert.equal(f.sent().length, paid + 1, "A6 ends its one held call; nothing else is paid");
  assert.equal(blockSeries(f).value.attempts.length, 2, "The standing hold opens no further attempt");
  await sameEnd(f, f.request(), paid + 1);
});

// OWN1 (№3711): the H1.5 tests of a blocking batch no producer serves are gone with it — a design or owner question of the
// pass is the model's now (above); a question of a later moment keeps its unserved batch and is no ground (below).
test("H1.5 №2221 a non-blocking unserved batch (a design question of task-start) in a saved plan is not sent and is no ground: the pass waits on the open work instead of ending", async t => {
  const f = runFixture(t, ["proof"], "executed", false, false, false, { proof: { moment: "task-start" } });
  addressQuestions(f, [["proof", "design-decision"]]);
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value;
  const batch = routes.batches.find(item => item.items.some(row => row.target === "discovery:proof" && row.field === "answer"))!;
  assert.ok(batch);
  const read = ok(readRouteProducers(f.store, { project, routes: bases.routes })).batches.find(row => row.batch === batch.id)!;
  assert.deepEqual(read.unserved.map(row => [row.target, row.blocking]), [["discovery:proof", false]], "Unserved, but not a blocking question of the pass");
  openPlanned(f, bases, "garden-consume-block", [batch], "task-start-plan");
  ok(startRun(f.store, { project }));
  const end = await ends(f, f.request(), 15);
  assert.equal(end.state.phase, "waiting", JSON.stringify(end.state));
  assert.equal((end.state as unknown as { wait: RunWait }).wait.code, "work_pending", "Open work without a ground is a wait, not an end");
  assert.equal(f.sent().length, 0);
  assert.deepEqual(actions(f.store), ["register"]);
  f.restart();
  assert.equal(ok(await advanceRun(f.store, f.request())).performed, null);
  assert.equal(f.sent().length, 0);
});
test("G6.2 the example answer of every new works packet passes the packet's own acceptance, a node producing two artifacts included", async t => {
  const f = worksFixture(t, false, false, twoArtifacts);
  ok(startRun(f.store, { project }));
  const checked = new Map<string, boolean>();
  for (let index = 0; index < 120 && checked.size < 2; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string; message: string }; step?: { action: string; request: { packet?: Ref } } };
    if (state.phase === "waiting" || state.phase === "unable" || state.phase === "complete") assert.fail(`The pass reaches the works packets: ${JSON.stringify(state).slice(0, 600)}`);
    if (state.phase !== "step" || state.step!.action !== "cycle" || !state.step!.request.packet || checked.has(state.step!.request.packet.id)) continue;
    const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
    const payload = packet.value.packet as unknown as { brief: { examples: { action: string; proposal?: { nodes: Node[] } }[] } };
    const example = payload.brief.examples.find(row => row.action === "answer")!;
    const result = checkAnswerForm(f.store, { project, packet: saved, raw: canonical(example) });
    assert.ok(result.ok, `The example passes its own acceptance: ${JSON.stringify(result).slice(0, 800)}`);
    checked.set(saved.id, example.proposal!.nodes.length > 1);
    f.answer(saved);
  }
  assert.ok([...checked.values()].includes(true), `The producing packet's example holds a work per artifact: ${JSON.stringify([...checked])}`);
});

// G6.1 (№3857 п.4, №3891): the write ownership of shared files is completed at the assembly of the group's candidate. The
// producing root answers with its example (a work per artifact); its two works, ordered by no dependency, share one file,
// and its first work shares another with the consuming work it feeds. The second file's one lawful order is completed by
// code; the first asks one narrow choice of the model, paid by the accepting attempt; the group is then accepted.
test("G6.1 a shared file with one lawful write order gets its producer_committed transfer from the code; one with several asks one narrow choice, then the group is accepted", async t => {
  for (const variant of ["chosen", "refused, then chosen"] as const) await t.test(variant, async t => {
    const f = worksFixture(t, false, false, twoArtifacts), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], trail: string[] = [];
    const push = (research: unknown) => { steps.push({ research, usage }); writeFileSync(scenario, JSON.stringify({ database: f.database, steps })); };
    ok(startRun(f.store, { project }));
    const answered = new Set<string>();
    let orders = 0, reentered = 0, works: string[] = [];
    for (let index = 0; index < 300 && !worksAcceptance(f.store).frame; index++) {
      const advanced = ok(await advanceRun(f.store, f.request));
      const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string; message: string }; step?: { action: string; request: { packet?: Ref; wake?: { task?: string; path?: string }; ordinal?: number } } };
      trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
      // A restart and a re-entry of the settled write-order step return its own saved result and send nothing again.
      if (advanced.performed?.action === "wake") {
        const done = advanced.performed.request as unknown as { wake: Parameters<typeof runWakeChoice>[1]; ordinal: number }, sent = f.sent().length;
        f.restart();
        const again = ok(await runWakeChoice(f.store, done.wake, done.ordinal));
        assert.deepEqual([again.id, f.sent().length], [advanced.products[0]?.id, sent], "Re-entry and restart pay nothing again");
        reentered++;
      }
      if (state.phase === "waiting" || state.phase === "unable") break;
      if (state.phase !== "step") continue;
      const current = state.step!;
      if (current.action === "wake" && current.request.wake?.task === "write-order" && current.request.ordinal === orders + 1) {
        const lawful = [[works[0]!, works[1]!], [works[1]!, works[0]!]];
        push({ writeOrder: variant === "refused, then chosen" && orders === 0 ? ["not-a-writer", works[0]!] : lawful[1] });
        orders++;
        continue;
      }
      if (current.action !== "cycle" || !current.request.packet || answered.has(current.request.packet.id)) continue;
      const saved = current.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
      answered.add(saved.id);
      const answer = mp2WorkAnswer(f, saved), node = answer.research.proposal.nodes[0]!.parent!;
      if (node === "garden-produce-operation") {
        const example = structuredClone((packet.value.packet as unknown as { brief: { examples: { action: string; proposal: { nodes: Node[]; fills: { node: string; codeRef?: { path: string } }[]; tests: { node: string; contract: { entrypoint: { path: string } } }[] } }[] } }).brief.examples.find(row => row.action === "answer")!.proposal);
        works = example.nodes.map(item => item.id);
        assert.equal(works.length, 2, "The example gives a work per artifact");
        const shared = example.nodes[0]!.code[0]!.path;
        example.nodes[1]!.code = example.nodes[1]!.code.map(ref => ({ ...ref, path: shared }));
        for (const fill of example.fills) if (fill.node === works[1] && fill.codeRef) fill.codeRef.path = shared;
        for (const test of example.tests) if (test.node === works[1]) test.contract.entrypoint.path = shared;
        example.nodes[0]!.code.push({ path: "src/garden-shared.ts", access: "write", status: "planned" });
        push({ ...answer.research, proposal: example });
      } else {
        if (node === "garden-consume-operation") answer.research.proposal.nodes[0]!.code.push({ path: "src/garden-shared.ts", access: "write", status: "planned" });
        push(answer.research);
      }
    }
    const text = trail.join(",");
    assert.deepEqual([worksAcceptance(f.store).passed, worksAcceptance(f.store).frame], [true, true], `The group is accepted: ${text.slice(-700)}`);
    const graph = f.store.get<Graph>(`graph:${project}`)!.value;
    const transfers = (graph.transfers ?? []).map(row => [row.path, row.from, row.to]);
    assert.ok(transfers.some(([path, from, to]) => path === "src/garden-shared.ts" && from === works[0] && to?.startsWith("garden-consume")),
      `The one lawful order is completed by code: ${JSON.stringify(transfers)}`);
    assert.ok(transfers.some(([path, from, to]) => path !== "src/garden-shared.ts" && from === works[1] && to === works[0]),
      `The chosen order of the ambiguous file: ${JSON.stringify(transfers)}`);
    const choices = f.store.list<{ task?: string; verdict: string }>(WAKE_CHOICE_KIND).filter(row => row.value.task === "write-order").map(row => row.value.verdict);
    assert.deepEqual(choices.sort(), variant === "chosen" ? ["chosen"] : ["chosen", "refused"], text);
    assert.deepEqual([reentered, f.store.list(WAKE_INTENT_KIND).length], [choices.length, choices.length], "One intent per call; every step re-entered without a call");
  });
});

test("LG10 a complete wake request of the retired wake-test shape is refused before any intent, E1 or transport", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const ref = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
  // Every field of the retired form is well-formed — the only ground of the refusal is the removed task itself.
  const legacy = { project, proposal: ref("om-proposal:garden:x"), work: "garden-produce-work", connector: "garden-flow",
    accepting: { series: ref("om-attempt-series:garden:x"), attempt: 1 },
    dispatch: { adapter: ref("om-adapter:garden:x"), config: ref("om-config:garden:x") } };
  const before = untouched(f.store), sent = f.sent().length;
  const refused = (error: unknown) => (error as EngineError).code === "wake_request_invalid";
  assert.throws(() => wakeStanding(f.store, legacy as never), refused);
  await assert.rejects(runWakeChoice(f.store, legacy as never, 1), refused);
  assert.deepEqual(untouched(f.store), before, "No record is written: no intent and no E1");
  assert.equal(f.store.list(WAKE_INTENT_KIND).length, 0, "No intent is created");
  assert.equal(f.sent().length, sent, "Nothing is sent");
});

test("MP2 (№2968 rows 8, 18) through the pass a refused works answer is corrected once; G7 closes the block attempt with its result, every physical call sent once, the first refusal kept in its history", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const produce = works.find(row => row.node === "garden-produce-operation")!;
  const scenario = join(f.root, "scenario.json"), steps: unknown[] = [], answered = new Set<string>();
  let refused = 0;
  ok(startRun(f.store, { project }));
  for (let index = 0; index < 200; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet?: Ref } } };
    if (state.phase === "step" && state.step?.action === "cycle" && state.step.request.packet && !answered.has(state.step.request.packet.id)) {
      answered.add(state.step.request.packet.id);
      const answer = mp2WorkAnswer(f, state.step.request.packet);
      if (answer.batch === produce.id && !refused++) {
        const wrong = structuredClone(answer.research);
        wrong.proposal.fills = wrong.proposal.fills.map((fill, at) => at === 0 ? { ...fill, obligation: "X999" } : fill);
        steps.push({ research: wrong, usage });
      }
      steps.push({ research: answer.research, usage });
      writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    }
    if (state.phase === "waiting" || state.phase === "complete") break;
    if (blockSeries(f as unknown as Fixture, "garden-produce-block")?.value.attempts[0]?.outcome) break;
  }
  const attempt = blockSeries(f as unknown as Fixture, "garden-produce-block").value.attempts[0]!;
  assert.equal(attempt.outcome?.reason, "result", "Row 18: the corrected result decides, not the first refusal");
  const corrections = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.request.correction);
  assert.equal(corrections.length, 1, "Row 8: one correction");
  assert.equal(corrections[0]!.value.request.batch, produce.id);
  assert.equal(f.sent().length, steps.length, "Every scripted answer was asked for exactly once, nothing twice");
  const first = f.store.list<{ om: { failure: { code: string } | null; diagnostic: Ref | null } }>("model-call")
    .find(row => row.value.om?.failure?.code === "answer_label_unknown")!;
  assert.ok(first?.value.om.diagnostic, "The first refusal has its diagnostic");
  const rows = f.store.list<{ rows: { source: Ref; id: string }[] }>("om-refusal-journal").flatMap(row => row.value.rows ?? []);
  assert.ok(rows.some(row => row.source.id === first.value.om.diagnostic!.id), "Row 18: and its journal row stays in the history");
});

test("MP2 №3153: through the pass in a second attempt, standing on the non-empty refusal journal of the first, a repairable refusal after a read is corrected — the correction is written and sent once, never input_stale on the journal head the refusal itself moved", async t => {
  const f = worksFixture(t);
  const produce = f.routes.value.batches.find(row => row.level === 3 && row.task === "node-expansion" && row.node === "garden-produce-operation")!;
  writeFileSync(join(f.root, "mp2-retry.txt"), "The produced artifact is written to the garden store.");
  const scenario = join(f.root, "scenario.json"), steps: unknown[] = [], answered = new Set<string>(), trail: string[] = [];
  let corrected = false;
  const sentCorrection = () => f.store.list<QuestionPacketRecord>("question-packet")
    .some(row => row.value.request.correction && row.value.state === "ready" && lp4Sent(f, reference(row)) > 0);
  ok(startRun(f.store, { project }));
  for (let index = 0; index < 300 && !sentCorrection(); index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string }; step?: { action: string; request: { packet?: Ref } } };
    trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    assert.ok(state.phase !== "waiting" && state.phase !== "complete", trail.join(","));
    if (state.phase !== "step" || state.step?.action !== "cycle" || !state.step.request.packet || answered.has(state.step.request.packet.id)) continue;
    const packet = state.step.request.packet; answered.add(packet.id);
    if (f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.request.attempt!.ordinal === 1)
      steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "cannot_answer", questionIds: lp4Questions(f, packet),
        reason: "The node needs another design" }, usage });
    else {
      const answer = mp2WorkAnswer(f, packet);
      if (answer.batch === produce.id && !corrected) {
        corrected = true;
        const wrong = structuredClone(answer.research);
        wrong.proposal.fills = wrong.proposal.fills.map((fill, at) => at === 0 ? { ...fill, obligation: "X999" } : fill);
        steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source", questionIds: lp4Questions(f, packet),
          missing: "Where the produced artifact is written", reads: [{ action: "read", path: "mp2-retry.txt", media: "text/plain" }] }, usage },
        { research: wrong, usage });
      }
      steps.push({ research: answer.research, usage });
    }
    writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
  }
  assert.equal(blockSeries(f as unknown as Fixture, "garden-produce-block").value.attempts[0]!.outcome?.reason, "refused", "The model refused the first attempt");
  const correction = f.store.list<QuestionPacketRecord>("question-packet").find(row => row.value.request.correction)!;
  assert.ok(correction && sentCorrection(), `The correction is written and sent: ${trail.join(",")}`);
  const rejected = f.store.get<QuestionPacketRecord>(correction.value.request.correction!.packet.id)!.value;
  assert.ok(rejected.request.continuation, "It corrects the step after the read");
  assert.equal(correction.value.request.attempt!.ordinal, 2);
  assert.ok(correction.value.journal, "The chain stands on the journal of the refused attempt");
  assert.deepEqual(correction.value.journal, rejected.journal, "On its root's saved journal, not on the head its refusal moved");
  assert.notDeepEqual(reference(f.store.get(correction.value.journal!.id)!), correction.value.journal, "The refusal moved the head");
  assert.equal(lp4Sent(f, reference(correction)), 1, "The correction is sent once");
  assert.equal(f.sent().length, steps.length, "Every scripted answer was asked for exactly once, nothing twice");
});

test("LP5 (№3278 rows 2, 6, 7, 9, 13, 14, 18, 20, 23) through the pass on a new Store after every transaction: a B1 replaced by G1 while a works attempt is open ends its remaining work by its own products, the attempt closes by the common G7, the bases of the new B1 are built and the paid complete assemblies answer their roots again — never a wait, never a second send of a paid answer, one common C4/G5 of reused and new results", async t => {
  for (const moment of ["after the first root", "after the check", "after the acceptance"] as const) await t.test(moment, async t => {
    const f = worksFixture(t);
    const scenario = join(f.root, "scenario.json"), steps: unknown[] = [], answered = new Set<string>(), trail: string[] = [];
    let replaced: Ref | null = null;
    const line = () => blockSeries(f as unknown as Fixture, "garden-produce-block")?.value ?? null;
    const done = () => moment === "after the acceptance" ? !!line()?.attempts[0]?.outcome && (line()!.attempts[0]!.outcome!.reason === "result" || !!line()?.attempts[1]?.outcome)
      : !!line()?.attempts[1]?.outcome;
    ok(startRun(f.store, { project }));
    for (let index = 0; index < 300 && !done(); index++) {
      f.restart();
      const advanced = ok(await advanceRun(f.store, f.request));
      const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string }; step?: { action: string; request: { packet?: Ref }; attempt: number | null } };
      const performed = advanced.performed?.action ?? "";
      trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${performed}${state.phase === "step" ? `>${state.step!.action}#${state.step!.attempt}` : ""}`);
      assert.ok(state.phase === "step" || state.phase === "ready", trail.join(","));
      if (!replaced && (moment === "after the first root" && performed === "cycle" || moment === "after the check" && performed === "evaluate"
        || moment === "after the acceptance" && performed === "works")) replaced = lp5ReplaceB1(f);
      if (state.phase !== "step" || state.step!.action !== "cycle" || !state.step!.request.packet || answered.has(state.step!.request.packet.id)) continue;
      answered.add(state.step!.request.packet.id);
      steps.push({ research: mp2WorkAnswer(f, state.step!.request.packet).research, usage });
      writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    }
    assert.ok(replaced && done(), trail.join(","));
    t.diagnostic(trail.join(","));
    const [first, second] = line()!.attempts;
    // LP6 (№3325 rows 12, 15, 19): the old attempt ended only by the replaced B1 of its area is an administrative end —
    // neutral, nothing counted — while the end of a confirmation remainder is not one; a reuse is no achievement.
    const close = (ordinal: number) => {
      const binding = ok(readCompletionBinding(f.store, project, reference(blockSeries(f as unknown as Fixture, "garden-produce-block")!), ordinal))!;
      return ok(readCompletionCloseAt(f.store, project, reference(f.store.get(completionCloseId(project, binding.id))!)));
    };
    const packets = f.store.list<QuestionPacketRecord>("question-packet");
    // The produce block's own packets of the new attempt: the reused roots get none, every other root one, sent once.
    const produced = (ordinal: number) => packets.filter(row => row.value.request.attempt?.series.id === blockSeries(f as unknown as Fixture, "garden-produce-block").id
      && row.value.request.attempt.ordinal === ordinal && row.value.state === "ready");
    for (const packet of packets.filter(row => row.value.state === "ready")) assert.ok(lp4Sent(f, reference(packet)) <= 1, "A paid answer is never sent again");
    assert.equal(f.sent().length, steps.length, "Every scripted answer was asked for exactly once");
    const reuses = lp5Kind<CompletionReuse>(f, COMPLETION_REUSE_KIND);
    if (moment === "after the acceptance") {
      // Rows 9, 10: the acceptance stays; either the confirmation is completed by D2 and the attempt keeps its result, or the
      // remainder of the confirmation alone is ended — the accepted frame is never ceased and no closure is made up.
      const finalized = lp5Kind(f, COMPLETION_FINALIZATION_KIND);
      if (finalized.length) assert.deepEqual([first!.outcome!.reason, (finalized[0]!.value as { phase: string }).phase], ["interrupted", "confirmation"]);
      if (finalized.length) assert.deepEqual([close(1).contract, close(1).outcome.progress, first!.verdict],
        ["om-completion-close/v2", { contract: "om-attempt-progress/v1", administrative: null }, "none"], "LP6 row 15: a confirmation end is no administrative end");
      else assert.equal(first!.outcome!.reason, "result", "Row 9: the accepted goal is confirmed on the new bases");
      assert.equal(reuses.length, finalized.length ? reuses.length : 0);
      return;
    }
    assert.equal(first!.outcome!.reason, "interrupted", "The old attempt ends without a verdict");
    assert.equal(second!.outcome!.reason, "result", "The next attempt reaches its result");
    const end = close(1).outcome.progress?.administrative;
    assert.deepEqual([end?.kind, first!.verdict, line()!.withoutProgress], ["area-input-replaced", "neutral", 0], "LP6 row 12: neutral, nothing counted");
    assert.ok(end!.sources.every(ref => [COMPLETION_FINALIZATION_KIND, "om-completion-cessation"].includes(f.store.get(ref.id, ref.revision)!.kind)));
    assert.equal(second!.verdict, "progress");
    const cessations = lp5Kind<CompletionCessation>(f, "om-completion-cessation");
    if (moment === "after the first root") {
      // Rows 2, 6: the unsent second root by LP4, the registered check by its area's replaced B1 (a variant of its own era).
      assert.ok(cessations.some(row => row.value.disposition !== "check-ceased" && row.value.cause.kind === "required-record-replaced"), "Row 2");
      const check = cessations.find(row => row.value.disposition === "check-ceased")!;
      assert.deepEqual([check.value.cause.kind, check.value.variant, (check.value.cause as { replacement: Ref }).replacement], ["required-record-replaced", AREA_INPUT_VARIANT, replaced], "Row 6");
      assert.equal(reuses.length, 1, "Row 14: the paid first root answers again");
      assert.deepEqual(produced(2).map(row => lp4Sent(f, reference(row))), [1], "Row 18: only the unsent second root is asked, once, in the new attempt");
      // Row 20: the second root of the new attempt sees its reused neighbour by the exact reuse.
      const later = packets.filter(row => row.value.request.attempt?.ordinal === 2 && row.value.state === "ready");
      assert.ok(later.some(row => (row.value as unknown as { briefNeighbors?: { sources: { reuse?: Ref }[] } }).briefNeighbors?.sources
        .some(source => source.reuse?.id === reuses[0]!.id)), "Row 20: the neighbour form names the reuse");
    } else {
      // Row 7: the complete check keeps its evaluation; only the remaining acceptance ends.
      const finalized = lp5Kind(f, COMPLETION_FINALIZATION_KIND);
      assert.deepEqual(finalized.map(row => (row.value as { phase: string }).phase), ["acceptance"]);
      // Row 7: the check is complete without a pass (the full G4b still waits for the group's works) and no C5 exists.
      const evaluation = (finalized[0]!.value as unknown as { evaluation: Ref }).evaluation;
      const gate = f.store.get<{ gate: Ref }>(evaluation.id, evaluation.revision)!.value.gate;
      assert.equal(f.store.get<{ result: { passed: boolean } }>(gate.id, gate.revision)!.value.result.passed, false, "Row 7");
      assert.ok(!cessations.some(row => row.value.disposition === "check-ceased"), "A complete check is never ceased");
      assert.equal(reuses.length, 2, "Row 14: both paid roots answer again");
      assert.deepEqual(produced(2), [], "No root of the new attempt is asked: 0 new E1, calls or expense");
    }
    for (const reuse of reuses) assert.equal(reuse.value.binding.id === reuse.value.source.binding.id, false, "A reuse answers a later attempt");
    // LP6 row 19: no achievement stands on a reuse; the result of the new attempt is its own C5/D2.
    assert.ok(close(2).outcome.achieved.length > 0 && close(2).outcome.achieved.every(item => !reuses.some(reuse => reuse.id === item.basis.id)));
    // Row 18: the one common C4/G5 of the new attempt takes the reuses themselves, beside the new assemblies.
    const acceptance = lp5Kind<WorksAcceptanceRecord>(f, "om-works-acceptance").find(row => row.value.acceptance);
    assert.ok(acceptance, "G5 accepts the works of the new attempt");
    assert.deepEqual(acceptance!.value.request.results.filter(row => row.kind === "reuse").map(row => row.record).sort((a, b) => a.id.localeCompare(b.id)),
      reuses.map(row => reference(row)).sort((a, b) => a.id.localeCompare(b.id)));
  });
});

test("LP8.1 a reopened record names the exact unable revision, its grounds and exactly one new ground; absence or excess is refused on reading; bases are read as of a live pass only while it weighs its grounds again", async t => {
  const { f, unable, unchanged } = await unavailableReview(t);
  const reasons = (unable.value.state as unknown as Reopened).reasons;
  const step: RunStep = { action: "resume", request: { project } as unknown as Json, series: null, attempt: null };
  const bad = (state: unknown) => {
    const head = f.store.get<RunRecord>(runId(project))!;
    const written = f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, state } as unknown as Json });
    assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid", JSON.stringify(state));
    f.store.write({ id: head.id, kind: head.kind, expected: written.revision, value: head.value as unknown as Json });
  };
  const from = reference(unable);
  bad({ phase: "reopened", from, reasons, ground: {} });
  bad({ phase: "reopened", from, reasons, ground: { step, wait: { code: "x", message: "x", target: "x", field: "x", basis: [] } } });
  bad({ phase: "reopened", from, reasons });
  bad({ phase: "reopened", reasons, ground: { step } });
  bad({ phase: "reopened", from, reasons: [], ground: { step } });
  bad({ phase: "reopened", from: { id: from.id }, reasons, ground: { step } });
  bad({ phase: "reopened", from, reasons, ground: { complete: [from] } });
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
  assert.equal(refusal(lp81PrepareRunBases(f.store, { project })).code, "run_bases_terminal", "An unable pass takes no bases");
  assert.throws(() => lp81PrepareRunBases(f.store, { project }, { reweigh: "yes" } as never), (error: unknown) => error instanceof EngineError && error.code === "run_bases_request_invalid");
  assert.ok(ok(lp81PrepareRunBases(f.store, { project }, { reweigh: true })), "Weighing its grounds again, it reads them as a live pass");
  unchanged();
});
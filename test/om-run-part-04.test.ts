import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { historicalProofCounters } from "../src/history/proofs.js";
import { canonical, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { type OmResult } from "../src/om/refusal.js";
import { ProductEngine } from "../src/product/engine.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { WORKS_BRIEF_PACKET_CONTRACT } from "../src/om/packet-brief.js";
import { withHistoricalReads } from "../src/om/input.js";
import { readHorizon } from "../src/om/horizon.js";
import { readPreparedSeriesTransition } from "../src/om/series-transition.js";
import { openSeries, readAnySeriesAt, readAppliedSeriesTransition, readCurrentSeriesPointer, readSeriesMembership, resumeSeries, seriesRequestOf, ownerDecisionNamespace, OWNER_DECISION_KIND } from "../src/om/series.js";
import { type RoutesRecord } from "../src/om/routes.js";
import type { AnyRepairSeries, RepairSeries } from "../src/om/series.js";
import { runStopAnalysis } from "../src/om/stop-analysis.js";
import { readRun, startRun, runId, type RunRecord, type RunStep, type RunWait } from "../src/om/run.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
// ---- LP5 (№3278): after a replaced B1 the old work ends by its own products, the new bases are built, paid assemblies answer again ----
import { COMPLETION_REUSE_KIND, type CompletionReuse } from "../src/om/model-call.js";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
import { WAKE_INTENT_KIND } from "../src/om/wake-choice.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { project, ok, refusal, runFixture, type Fixture, addressAll, usage, factsAll, type Verdict, assessor, mechanismSeries, blockSeries, actions, ends, driveTo, reasonsOf, stopAnswer, cannotAnswer, stoppedBlockLine, OWN1_DECISION, decisionCalls, restWithDecisions, until, RacingStore, nodeAnswer, worksFixture, worksAcceptance, a6Survives, driveUntil, addressQuestions, answerBatch, advanceRun, g62Rejection, lp5ReplaceB1, type Lp5State, g51AmbiguousAnswer, passRows, unavailableReview, eraRefusal, eraRefusedClose } from "./om-run-fixture.js";

test("H1.2 R8 R4 C31 a stopped line whose owner has no batch today keeps its barrier: its reviewed stop on the second rung ends the pass, and nothing is paid for that owner", async t => {
  const f = runFixture(t, [], "executed");
  const stopped = stoppedBlockLine(f);
  const request = f.request(f.bases("h12-idle"));
  f.steps([stopAnswer(f, false)]);
  // The one review of this exact stop is the earlier mode's own A6 (an operator act through the same producer); the second rung is what it leaves.
  const review = ok(await runStopAnalysis(f.store, { project, series: reference(stopped), hold: null, dispatch: request.dispatch }));
  assert.equal(review.value.state, "undecided");
  const series = blockSeries(f);
  assert.equal(series.value.escalations.length, 1);
  const sends = f.sent().length;
  assert.equal(sends, 1);
  // No question is open, so no route reaches the block: the old absence of a batch must not erase its stop.
  assert.deepEqual(f.store.list<RoutesRecord>("route-result").flatMap(row => row.value.batches.filter(batch => batch.items.length)), []);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 20);
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.deepEqual(end.performed.filter(action => action !== "bases"), [], "The idle owner is asked for nothing: only the pass's own bases were built");
  assert.equal(f.sent().length, sends, "Nothing was paid for the owner that has no work");
  assert.notEqual(end.state.phase, "complete", "A proved barrier forbids the completion of the pass");
});

test("H1.2 R5 a failed review of the stop ends the pass on that very record: a restart pays no second review", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h1-failed"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, { rawStdout: "{broken", exitCode: 7, stderr: "intentional reviewer failure" }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const attempt = ["open", "packet", "cycle", "close"];
  const reviewed = await driveTo(f, request, "analyze", 40);
  assert.deepEqual(reviewed.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze"]);
  const failure = f.store.list().find(row => row.kind === "om-stop-analysis-failure")!;
  assert.ok(failure, "The failed review is a record of its own");
  const sends = f.sent().length, series = mechanismSeries(f);
  const end = await ends(f, request, 5);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-analysis-failed", "analysis_failed", series.id, "stop"]]);
  assert.ok(reasons[0]!.basis.some(ref => ref.id === failure.id && ref.hash === failure.hash), "The Ref of exactly this review");
  assert.equal(series.value.escalations.length, 0, "A failed review escalates nothing and opens no door of its own");
  // PF4 (№3499 row 42): the database carries the checks this process saved; a warm cache resumes nothing — the ended
  // pass stays ended on its own record.
  assert.ok(historicalProofCounters().writtenRecords > 0, "The restart meets a warm saved cache");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.equal(f.sent().length, sends, "A restart does not pay the review again");
  assert.equal(f.store.list().filter(row => row.kind === "om-stop-analysis-failure").length, 1);
});

test("H1.2 R5b a review that cannot even be prepared for its saved request ends the pass on that refusal: no failed record, no transport, no new dispatch", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h1-a6-unavailable"), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  let request = f.request(b);
  for (let closes = 0; closes < 3;) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.performed?.action === "close") closes += 1;
  }
  // The environment now offers a request capacity no reviewer request can fit; the review is chosen with that dispatch.
  f.environment(1);
  request = f.request(b);
  const waiting = await ends(f, request, 6);
  assert.equal(waiting.state.phase, "waiting");
  assert.equal((waiting.state as unknown as { wait: RunWait }).wait.code, "context_too_large");
  const sends = f.sent().length, before = f.store.list().length, moved = ok(readRun(f.store, { project }))!.revision;
  const end = await ends(f, request, 3), series = mechanismSeries(f);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code]), [["analysis-unavailable", "context_too_large"]]);
  assert.ok(reasons[0]!.basis.some(ref => ref.id === series.id), "The line it stands on");
  assert.ok(reasons[0]!.basis.some(ref => ref.id === request.dispatch.config.id && ref.hash === request.dispatch.config.hash), "The exact dispatch of the saved request");
  assert.equal(f.sent().length, sends, "No transport exists for a review that was never prepared");
  assert.equal(f.store.list("om-stop-analysis-failure").length, 0);
  assert.equal(f.store.list().length, before, "No record was added");
  assert.equal(ok(readRun(f.store, { project }))!.revision, moved + 1, "Only the pass record moved, once");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
});

test("H1.2 R7 R7a R8 6 C54 M5 asks the owner while the independent block is worked to its end; only then does the pass end, on the goal that stays open, and its grounds keep the canonical order", async t => {
  const f = runFixture(t, ["encoding", "spare"], "executed", ["encoding"]);
  const b = f.bases("h12-independent"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  const m5 = saved.batches.find(item => item.model === "MC2" && item.task === "input-field")!;
  f.steps([{ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: m5.items.map(item => item.gap), action: "need_owner",
    reason: "The owner must name the optional format", decision: "Name it" }, usage }, factsAll(f, b.routes), assessor("supported")]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 80);
  const mechanism = mechanismSeries(f), reasons = reasonsOf(end.state);
  assert.deepEqual(mechanism.value.attempts.map(row => row.outcome?.reason), ["awaiting-owner"], "M5's goal is held, not closed as done");
  // R8: the independent block was worked, paid and applied before the end; the goal that waits for the owner is the ground.
  assert.ok(end.performed.includes("assess") && end.performed.filter(action => action === "close").length >= 2, end.performed.join(","));
  assert.equal(blockSeries(f).value.attempts[0]!.outcome!.reason, "result");
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]),
    [["owner-control", "model_need_owner", mechanism.id, "attempt.1"]]);
  assert.equal(reasons[0]!.message, "The owner must name the optional format; Name it", "The message is the saved diagnostic of E4");
  // R7a: the applied facts made a new B1 and with it a new composition of M6; the held question stays the one ground, asked once.
  assert.ok(end.performed.includes("apply") && end.performed.includes("bases"), end.performed.join(","));
  assert.ok(f.store.list("route-result").length >= 2, "The independent batch changed the composition of M6 while the question stayed held");
  assert.equal(f.sent().length, 3, "M5, the facts and their assessment: nothing is paid twice and nothing is paid for the held goal");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
});

test("К10 C41 H1 two stores choosing the next step at once: the first saved choice wins and the other performs that same step", async t => {
  const f = runFixture(t, undefined, "executed");
  const b = f.bases("h1-first"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const racing = new RacingStore(f.database);
  t.after(() => racing.close());
  racing.target = runId(project); racing.remaining = 1;
  racing.run = other => { void advanceRun(other, request); };
  const lost = await advanceRun(racing, request);
  assert.equal(lost.ok, false, "The losing choice is refused by the run's own revision guard");
  const saved = ok(readRun(f.store, { project }))!;
  assert.equal(saved.revision, 2);
  assert.equal(saved.value.state.phase, "step");
  const performed = ok(await advanceRun(racing, request));
  assert.deepEqual(performed.performed, (saved.value.state as { step: unknown }).step, "The other store performs the saved step, not a new name");
  assert.equal(f.store.list("repair-series").length, 1);
});

test("25 C61 7 R8 №1749 №1860-12 H1.1 two blocks of one N2 frame: G4b waits for both, one bound C5, machine bases over it, a D2 event per goal and each own G7 across second stores, then L3", async t => {
  const f = runFixture(t, [], "stages");
  const b = f.bases("h1-n2"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  assert.equal(saved.batches.filter(row => row.task === "node-expansion" && row.level === 2).length, 2, "Both blocks expand the one operations frame");
  ok(startRun(f.store, { project }));
  // Block A (first in M3) pays its MC2; its part alone cannot form the frame, so A stays open and B is worked next.
  const first = await until(f, request, "cycle");
  const answers = [nodeAnswer(f, first)];
  f.steps(answers);
  const d1 = f.store.list().filter(row => row.id.startsWith("om-gap:")).map(reference), done = actions(f.store).length;
  const second = await until(f, request, "cycle", 30);
  assert.notEqual(second.series, first.series, "The pass moved on to the other block instead of waiting globally");
  // №1860-12: the waiting A keeps its scope; B is opened on the same bases, with no build and no D1 rewrite between them.
  assert.ok(!actions(f.store).slice(done).includes("bases"));
  assert.deepEqual(f.store.list().filter(row => row.id.startsWith("om-gap:")).map(reference), d1);
  const a = f.store.get<AnyRepairSeries>(first.series!)!;
  assert.equal(a.value.attempts.length, 1, "A kept its one open attempt: no second ordinal, no repaid call");
  answers.push(nodeAnswer(f, second));
  f.steps(answers);
  const accept = await until(f, request, "accept", 40);
  const binding = (accept.request as unknown as { settle: { binding: { series: Ref; ordinal: number } } }).settle.binding;
  assert.equal(binding.series.id, accept.series, "The coordinator binds only its own goal");
  assert.equal(ok(await advanceRun(f.store, request)).performed?.action, "accept");
  // R8: the acceptance is written and the bases over it are not; then the bases are written and no D2 yet; then a D2
  // event and not its G7 — each window is continued by a second store: one C5, one delivery per goal, then L3 work.
  f.restart();
  const after: string[] = [];
  let next: RunStep | null = null;
  for (let index = 0; index < 30 && !next; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    const state = advanced.record.value.state;
    if (advanced.performed) {
      after.push(advanced.performed.action);
      if (["bases", "confirm"].includes(advanced.performed.action)) f.restart();
    }
    if (state.phase === "waiting") assert.fail(`${after.join(",")}: ${JSON.stringify(state.wait)}`);
    if (state.phase === "step" && after.filter(action => action === "close").length === 2) next = state.step as unknown as RunStep;
  }
  assert.deepEqual(after, ["bases", "confirm", "close", "confirm", "close"], "The machine bases over the accepted N2 serve both D2 events; no d2_bases wait");
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases over the accepted N2 are current");
  assert.deepEqual(ok(readHorizon(f.store, project, built.built.bases.horizon)).horizon.value.request.refinement,
    reference(f.store.get(`graph-layer:${project}:2`)!), "The new issue stands on the accepted N2 layer");
  const l3 = f.store.get<RoutesRecord>(built.built.bases.routes.id, built.built.bases.routes.revision)!.value;
  assert.ok(l3.batches.some(row => row.task === "node-expansion" && row.level === 3), "The accepted N2 opens its L3 works");
  assert.ok(next && ["open-series", "open"].includes(next.action), `New work comes only after both D2/G7: ${JSON.stringify(next)}`);
  const blocks = ["garden-produce-block", "garden-consume-block"].map(block => blockSeries(f, block));
  for (const series of blocks) {
    assert.equal(series.value.attempts.length, 1);
    assert.equal(series.value.attempts[0]!.outcome!.reason, "result", series.id);
  }
  assert.equal(f.store.history(`om-frame:${project}:2`).length, 1, "One common acceptance");
  const lines = f.store.history(`om-gap-lines:${project}:history`);
  assert.equal(lines.filter(row => (row.value as { request: { closures: unknown[] } }).request.closures.length).length, 2, "One D2 event per original goal");
  assert.equal(f.sent().length, 2, "Nothing was paid twice");
  // №1961: a project without OM records stays in its lawful legacy participation through N2: no activation, no pointer.
  const membership = ok(readSeriesMembership(f.store, { project }));
  assert.equal(membership.value.mode, "legacy");
  assert.equal(membership.value.activation, null);
  assert.equal(f.store.list("om-series-applied").length, 0, "No activation was written");
  assert.equal(f.store.get(`om-series-current:${project}`), null, "No current pointer was written");
});
// G6 В3 (№3869): a paid assembly ended by its area's replaced B1 is reused while the B1 still holds its area's question; once
// the answer is applied it is no longer — it was asked without that knowledge — and the root is new work carrying the answer.
// The consuming block's first attempt assembles its works, then G1 replaces its B1 before its interrupted E5 closes it:
// LP5 ends it by its area (interrupted, the assembly kept). The second attempt reuses that assembly (the question still held)
// and its fact is supported; the group's transition applies the answer; the third asks the works anew. The producing block,
// whose area the fact does not concern, is reused throughout.
test("G6 В3 a paid assembly ended by its area's B1 is reused while its area's question stands, and never once that question's answer is applied: the root is new work whose packet carries the answer; another area keeps its reuse", async t => {
  const f = worksFixture(t, false, true);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>(), verdicts: Verdict[] = ["interrupted", "supported"];
  let assessed = 0, replaceAfter: string | null = null, replaced = false;
  for (let index = 0; index < 400 && !performed.includes("works"); index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const action = advanced.performed?.action ?? "";
    if (action) performed.push(action);
    if (!replaced && replaceAfter && action === "cycle" && JSON.stringify(advanced.performed!.request).includes(replaceAfter)) { lp5ReplaceB1(f); replaced = true; }
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet: Ref } } };
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") break;
    if (state.phase !== "step") continue;
    const key = JSON.stringify(state.step!.request);
    if (state.step!.action === "cycle" && !answered.has(key)) {
      answered.add(key);
      const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
      const routed = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routed.batches.find(row => row.id === packet.value.request.batch)!;
      if (batch.model !== "MC1") {
        f.answer(saved);
        const attempt = packet.value.request.attempt;
        if (!replaced && attempt?.ordinal === 1 && attempt.series.id.endsWith("garden-consume-block")) replaceAfter = saved.id;
      } else {
        const source = f.store.get<{ content: string }>(`source:${project}:brief`)!;
        f.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
          results: batch.items.map(item => ({ questionId: item.gap, value: { answer: "UTF-8" }, citations: [{ source: reference(source),
            selector: { kind: "text-range", start: 0, end: source.value.content.length } }] })) }, usage });
      }
    }
    if (state.phase === "step" && state.step!.action === "assess" && !answered.has(key)) {
      answered.add(key); f.push(assessor(verdicts[Math.min(assessed++, verdicts.length - 1)]!));
    }
  }
  const trail = performed.join(",");
  assert.ok(replaced, `G1 replaced the B1 after the first works of the consuming block: ${trail}`);
  const consume = blockSeries(f as unknown as Fixture, "garden-consume-block").value.attempts;
  assert.deepEqual(consume.slice(0, 2).map(row => row.outcome?.reason), ["interrupted", "result"], trail);
  const blockOf = (row: Revision<CompletionReuse>) => f.store.get<{ owner: { block?: string } }>(row.value.binding.id, row.value.binding.revision)!.value.owner.block;
  const reuses = f.store.list<CompletionReuse>(COMPLETION_REUSE_KIND);
  assert.equal(reuses.filter(row => blockOf(row) === "garden-consume-block").length, 1, `The second attempt reused the first assembly while the question stood: ${trail}`);
  const works = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.packetContract === WORKS_BRIEF_PACKET_CONTRACT
    && row.value.packet && row.value.request.attempt?.series.id.endsWith("garden-consume-block"));
  assert.deepEqual(works.map(row => row.value.request.attempt!.ordinal).sort(), [1, 3], "The third attempt asks its works anew; the second never did");
  assert.ok(JSON.stringify(works.find(row => row.value.request.attempt!.ordinal === 3)!.value.packet).includes("UTF-8"), "The new packet carries the answer");
  assert.ok(reuses.filter(row => blockOf(row) === "garden-produce-block").length >= 2, "The producing block keeps its reuse after either replacement");
  assert.deepEqual(worksAcceptance(f.store), { passed: true, frame: true, findings: [] }, trail);
});

test("H1.2 R6 R6a 12 21 H1 stop and origin holds together: the origin route goes first (A6 on the exact hold), no attempt opens, an unestablished origin ends the pass without paying the other holds or the stop", async t => {
  const f = runFixture(t, ["encoding"], "executed", true);
  const b = f.bases("h1-hold"), request = f.request(b);
  // Three earlier standalone attempts of the block were refused with a refusal of unknown origin: A3 stopped the
  // series and G7 raised a hold for each (the earlier mode, read by its own contract).
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h1-hold", predecessor: null, basis: null }));
  const goal = { key: "h1-hold-goal", questions: ["Address one contract"], result: "A supported contract" };
  const holds: Ref[] = [];
  for (const attempt of [1, 2, 3]) {
    const row = eraRefusal(f.store, `h1-origin-${attempt}`, goal.key,
      { name: "artifact_missing", stage: "layer-check", subject: `artifact:fixture-${attempt}`, sources: [] });
    holds.push(...eraRefusedClose(f.store, address, attempt, goal, row).holds);
  }
  assert.ok(blockSeries(f).value.stop, "A3 stopped the series");
  assert.ok(holds.length > 0, "G7 raised the origin holds");
  f.steps([{ research: { protocol: "omg-stop-analysis/v1", cause: null, change: null, origin: null }, usage }]);
  ok(startRun(f.store, { project }));
  const driven = await ends(f, request, 10);
  assert.deepEqual(driven.performed, ["analyze"], "The origin route first; nothing else of the line is paid once a hold stands unlifted");
  const reasons = reasonsOf(driven.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.field]), [["hold-origin-unestablished", "origin_hold", "hold"]]);
  assert.ok(holds.some(hold => hold.id === reasons[0]!.target), "The reason names the exact hold");
  const analyses = f.store.list().filter(row => row.kind === "om-origin-analysis");
  assert.equal(analyses.length, 1, "R6a: the other holds and the stop are not reviewed just to fill the report");
  assert.equal((analyses[0]!.value as { state: string }).state, "origin-unestablished");
  assert.ok(reasons[0]!.basis.some(ref => ref.id === analyses[0]!.id), "The review of this very hold is a Ref of the reason");
  assert.equal(blockSeries(f).value.attempts.length, 3, "No new attempt while the stop and the hold stand");
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.deepEqual(f.store.list().map(reference), before, "The saved end is read, not paid again");
  assert.equal(f.sent().length, sends);
});

test("4 9 17 21 C21 №1814 H1 A6 on a stop keeps its saved request through a live executor, its loss, a new Environment revision and a restart", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h1-a6-stop"), request = f.request(b);
  const none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const analyzing = await until(f, request, "analyze", 50);
  assert.equal((analyzing.request as { hold: unknown }).hold, null, "A6 reviews the stop");
  await a6Survives(t, f, request, analyzing, () => f.request(b));
  assert.equal(f.sent().length, 3, "Only the three M5 attempts were ever sent");
});

test("25 R8 R20 №1937-2 №1860-8 H1.1 managed N2 after C5: completion bases serve both D2 and G7 through second stores, with no B3 before the group is closed; S1.2 №1961-4 then the common B3 of the new slices and the first L3 step on the joint base, nothing paid again", async t => {
  const f = runFixture(t, [], "stages");
  for (const block of ["garden-produce-block", "garden-consume-block"])
    ok(openSeries(f.store, { project, block, line: 1, slice: "h11-initial", predecessor: null, basis: null }));
  f.activate("h11-initial", { features: [{ outcome: "garden-result" }], excluded: [] });
  const request = f.request(f.bases());
  const first = await until(f, request, "cycle", 40);
  const answers = [nodeAnswer(f, first)];
  f.steps(answers);
  const second = await until(f, request, "cycle", 40);
  answers.push(nodeAnswer(f, second));
  f.steps(answers);
  await until(f, request, "accept", 40);
  assert.equal(ok(await advanceRun(f.store, request)).performed?.action, "accept");
  f.restart();
  const applied = f.store.list("om-series-applied").length, transitions = f.store.list("series-transition").length;
  const pointer = reference(f.store.get(`om-series-current:${project}`)!);
  const closed = await driveUntil(f, request, (_state, trail) => trail.filter(action => action === "close").length === 2, 30, ["bases", "confirm"]);
  assert.deepEqual(closed.trail, ["bases", "confirm", "close", "confirm", "close"], "The group's own D2 and G7 on completion bases: no attempt_running");
  // The completion bases admit no new work: no transition, no activation, the pointer stays while the group closes.
  assert.equal(f.store.list("series-transition").length, transitions);
  assert.equal(f.store.list("om-series-applied").length, applied);
  assert.deepEqual(reference(f.store.get(`om-series-current:${project}`)!), pointer);
  for (const block of ["garden-produce-block", "garden-consume-block"])
    assert.equal(blockSeries(f, block).value.attempts.at(-1)!.outcome!.reason, "result", block);
  // ---- S1.2 (№1961-4): on the joint base the same pass goes on past the closed group ----
  // The common B3 of the new slices — P over both current lines, its G2 issuance and the activation, each by its own
  // producer, inside the pass's own bases step — then the lawful first L3 step of new work on the line that activation
  // made, through a second store after the activation. The accepted N2 stays the exact basis of the new issue, both
  // participants are named by their exact revisions, the closed attempts stay closed and nothing is paid again.
  const paid = f.sent().length, acceptances = f.store.history(`om-frame:${project}:2`).length;
  const roots = ok(readSeriesMembership(f.store, { project })).value.roots;
  const blocks = ["garden-consume-block", "garden-produce-block"];
  const previous = blocks.map(block => reference(f.store.get(`repair-series:${project}:1:${block}`)!));
  const l3 = await driveUntil(f, request, state => state.phase === "step" && state.step.action === "cycle", 30, ["bases"]);
  assert.deepEqual(l3.trail, ["bases", "open", "register", "obligations", "packet"],
    "One B3 of the new slices inside the pass's own bases, then the first L3 work opens on the line it activated: no second bases, no open-series");
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases over the accepted N2 are current");
  assert.deepEqual(ok(readHorizon(f.store, project, built.built.bases.horizon)).horizon.value.request.refinement,
    reference(f.store.get(`graph-layer:${project}:2`)!), "The new issue stands on the accepted N2 layer");
  // The activation the pointer names is of this very issue, over the complete registered membership, by exact revisions.
  assert.notDeepEqual(reference(f.store.get(`om-series-current:${project}`)!), pointer, "The pointer moved to the new activation");
  const current = ok(readCurrentSeriesPointer(f.store, { project })).value;
  const activation = ok(readAppliedSeriesTransition(f.store, { project, record: current.applied })).value;
  const plan = ok(readPreparedSeriesTransition(f.store, { project, record: activation.prepared })).record.value;
  assert.deepEqual(plan.request.horizon, built.built.bases.horizon, "P names the horizon of the pass's own new issue");
  // The producer normalizes its series by the canonical form of the whole Ref (hash included), so the lawful order of
  // the two lines depends on the fixture's hashes: the set is compared through the same sorting of copies (№2347).
  const byCanonical = (a: Ref, b: Ref) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
  assert.equal(plan.request.series.length, previous.length, "P names exactly the two current lines");
  assert.deepEqual([...plan.request.series].sort(byCanonical), [...previous].sort(byCanonical), "P covers both current lines at their exact revisions");
  assert.deepEqual(activation.decisions.map(row => [row.block, row.participation, row.outcome]),
    blocks.map(block => [block, "active", "new-work"]), "Both participants are active on their new slices");
  assert.deepEqual(activation.roots, roots, "The registered membership is the same");
  assert.equal(f.store.list("series-transition").length, transitions + 1, "One P");
  assert.equal(f.store.list("om-series-applied").length, applied + 1, "One activation");
  for (const [index, block] of blocks.entries()) {
    // The new line of each block stands on its exact previous line; the pointer names the new line's activation revision.
    const next = f.store.get<RepairSeries>(`repair-series:${project}:2:${block}`)!;
    assert.deepEqual(next.value.predecessor, previous[index], block);
    assert.deepEqual(current.series.find(row => row.block === block), { block, activation: reference(f.store.get(next.id, 1)!), participation: "active" }, block);
    assert.deepEqual(f.store.get<RepairSeries>(previous[index]!.id)!.value.attempts.map(attempt => attempt.outcome?.reason), ["result"], `${block}: the closed attempt of line 1 stays closed`);
  }
  // The first L3 step: the produce block's new line (first in M3), on a level-3 batch of these bases — chosen, not yet paid.
  const step = l3.state.phase === "step" ? l3.state.step : assert.fail("A saved step");
  assert.equal(step.series, `repair-series:${project}:2:garden-produce-block`);
  assert.deepEqual(f.store.get<RepairSeries>(step.series!)!.value.attempts.map(attempt => attempt.outcome), [null], "One open attempt on the new line");
  const saved = (step.request as unknown as { packet: Ref }).packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  assert.deepEqual(packet.value.request.routes, built.built.bases.routes, "The L3 packet stands on the routes of the new bases");
  const batch = f.store.get<RoutesRecord>(built.built.bases.routes.id, built.built.bases.routes.revision)!.value.batches.find(row => row.id === packet.value.request.batch)!;
  assert.deepEqual([batch.task, batch.level, batch.node], ["node-expansion", 3, "garden-h1-operation-garden-produce-block"]);
  assert.equal(f.sent().length, paid, "Nothing was paid again: the L3 call is chosen, not yet made");
  assert.equal(f.store.history(`om-frame:${project}:2`).length, acceptances, "One common acceptance");
  // A new store finds the same saved step on the same bases: the build repeated with the open attempt named writes
  // nothing — no second P, issuance or activation — and nothing is sent again.
  f.restart();
  assert.deepEqual(ok(readRun(f.store, { project }))!.value.state, l3.state);
  const heads = f.store.list().map(reference);
  assert.deepEqual(ok(writeRunBases(f.store, { project }, { open: [step.series!] })).bases, built.built.bases);
  assert.deepEqual(f.store.list().map(reference), heads, "The repeated build found its bases and wrote nothing");
  assert.equal(f.sent().length, paid);
  // The exact references P stands on read the same however its nested proofs are served (№2329): cold on this store,
  // hot inside one operation (replayed from the operation's own proofs), warmed by the nested readers before the
  // collector attaches (replayed from kept proofs), and again on a new store.
  const readPlan = () => ok(readPreparedSeriesTransition(f.store, { project, record: activation.prepared }));
  const cold = readPlan();
  assert.deepEqual(cold.record.value, plan);
  const hot = withHistoricalReads(() => { readPlan(); return readPlan(); });
  const warmed = withHistoricalReads(() => {
    ok(readHorizon(f.store, project, plan.request.horizon));
    for (const ref of plan.request.series) ok(readAnySeriesAt(f.store, project, ref));
    return readPlan();
  });
  assert.deepEqual(hot, cold); assert.deepEqual(warmed, cold);
  f.restart();
  assert.deepEqual(readPlan(), cold);
});

// OWN1 (№3711) replaces H1.5 №2164: an owner question of the pass is asked of the model once and decided by it.
test("OWN1 H1.5 №2164 an owner question of the pass is asked of the model once: its decision stands decided in B1, om-decisions shows it with its alternatives, and the pass does not end on it", async t => {
  const f = runFixture(t, ["spare"], "executed");
  addressQuestions(f, [["spare", "owner-decision"]]);
  const bases = f.bases(), request = f.request();
  assert.ok(answerBatch(f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value), "M6 routes the question to the model");
  ok(startRun(f.store, { project }));
  const state = await restWithDecisions(f, request);
  assert.ok(!(state.phase === "unable" ? reasonsOf(state) : []).some(row => row.target === "discovery:spare"), JSON.stringify(state));
  const listed = ok(new ProductEngine(f.store).execute({ type: "om-decisions", project }) as unknown as OmResult<{ decisions: { id: string; kind: string; decision: string; alternatives: unknown[]; call: Ref | null; at: string | null }[] }>);
  assert.deepEqual(listed.decisions.map(row => [row.id, row.kind, row.decision, row.alternatives.length]),
    [["discovery:spare", "owner-decision", OWN1_DECISION.decision, 2]]);
  assert.ok(listed.decisions[0]!.call?.id.startsWith(`model-call:${project}:om:`), "The model call that decided it");
  assert.ok(!Number.isNaN(Date.parse(listed.decisions[0]!.at!)), "and when it started");
  assert.equal(f.store.list().filter(row => row.id.startsWith("om-owner-result:")).length, 0, "No owner result is invented");
  assert.equal(decisionCalls(f), 1, "The decision is paid once");
});
test("G6.2 a G5 finding of one work's own content rejects only its proposal: its attempt closes on its own rows with no hold, the next attempt answers anew, the other member's paid work is kept — never input_stale; a rejected assembly is never reused, through a chain of reuses either", async t => {
  for (const chain of [false, true]) await t.test(chain ? "the rejected assembly came by a reuse" : "the rejected assembly is the attempt's own", async t => g62Rejection(t, chain));
  // Return №3899: the sound member's end by the group's rejection is neutral — two earlier attempts without a result
  // before it do not make a third that stops the line and pays A6; it reuses its assembly and the group is accepted.
  await t.test("a sound member with two earlier attempts without a result ends neutrally: no stop, no A6", async t => g62Rejection(t, false, true));
});

test("G5.1 row 9 a producer end answered in the wake-test era names its wake test itself: the group takes it and no supplement is asked or paid", async t => {
  const f = worksFixture(t), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], answered = new Set<string>(), trail: string[] = [];
  ok(startRun(f.store, { project }));
  for (let index = 0; index < 200 && !trail.some(row => row.includes(":works")); index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as Lp5State;
    trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    if (state.phase === "waiting" || state.phase === "unable") break;
    if (state.phase !== "step" || state.step!.action !== "cycle" || !state.step!.request.packet || answered.has(state.step!.request.packet.id)) continue;
    const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
    answered.add(saved.id);
    const answer = g51AmbiguousAnswer(f, saved), payload = packet.value.packet as unknown as { expansion: { obligations: { id: string; kind: string; role?: string; connector?: string }[] } };
    for (const fill of answer.research.proposal.fills as { obligation: string; wakeTest?: string }[]) {
      const obligation = payload.expansion.obligations.find(item => item.id === fill.obligation);
      if (obligation?.kind !== "connection-end" || obligation.role !== "producer") continue;
      const covering = answer.research.proposal.tests.filter(test => test.covers.includes(obligation.connector!)).map(test => test.id).sort();
      if (covering.length > 1) fill.wakeTest = covering[covering.length - 1]!;
    }
    steps.push({ research: answer.research, usage }); writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
  }
  assert.ok(trail.some(row => row.includes(":works")), `The works are accepted on the work's own choice: ${trail.join(",")}`);
  assert.equal(f.store.list(WAKE_INTENT_KIND).length, 0, "No supplement is asked");
  assert.ok(!trail.some(row => row.includes("wake")));
});

test("LP8.1 the reopening is guarded by the exact unable revision: another store moving the pass between the weighing and the write leaves its record, nothing is written over it", async t => {
  const { f, request, unable, unchanged } = await unavailableReview(t);
  // The grounds stop standing on the owner's own continuation: a decision on the exact stop resumes the series
  // by today's rules, so the next entry reopens the pass — the write the moving store races below.
  const stopped = f.store.list<AnyRepairSeries>("repair-series").find(row => "owner" in row.value)!, stop = stopped.value.stop!;
  const decision = f.store.write({ id: `${ownerDecisionNamespace(project)}lp81-guarded`, kind: OWNER_DECISION_KIND, expected: 0,
    value: { projectId: project, owner: { kind: "mechanism", mechanism: "M5:addressing" }, stop: stop.attempt, goals: [...stop.goals],
      decided: "go on: one more window", taken: { by: "the owner", through: "the command API", approved: true } } });
  ok(resumeSeries(f.store, { ...seriesRequestOf(stopped.value), stop: stop.attempt, ground: "owner-decision",
    text: "the owner decided to go on", decision: { ref: reference(decision) } } as never));
  let raced = false;
  class Moving extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "reopened")) {
        raced = true;
        const other = new Store(f.database);
        try {
          const head = other.get<RunRecord>(runId(project))!;
          other.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, state: { phase: "ready" } } as unknown as Json });
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Moving(path));
  const advanced = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(advanced).code, "revision_conflict");
  const head = ok(readRun(f.store, { project }))!;
  assert.deepEqual([head.revision, head.value.state.phase], [unable.revision + 1, "ready"], "The other store's record stands");
  assert.deepEqual(passRows(f.store).filter(phase => phase === "reopened"), []);
  unchanged();
});
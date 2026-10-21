import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { Graph } from "../src/graph/model.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import type { Node } from "../src/graph/model.js";
import { readOmInput } from "../src/om/input.js";
import { readHorizon } from "../src/om/horizon.js";
import { ownerDecisionNamespace } from "../src/om/series.js";
import { closeAttempt, openAttempt, prepareManagedClaim } from "../src/om/repeat-gate.js";
import { runModelCycle } from "../src/om/model-call.js";
import { runStopAnalysis } from "../src/om/stop-analysis.js";
import { readJournal } from "../src/om/refusal-journal.js";
import { readRun, startRun, runId, type RunRecord } from "../src/om/run.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
import { WAKE_CHOICE_KIND, WAKE_INTENT_KIND } from "../src/om/wake-choice.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { project, ok, refusal, runFixture, addressAll, usage, factsAll, assessor, refOf, mechanismSeries, blockSeries, ends, driveTo, drive, reasonsOf, blockBases, stopAnswer, cannotAnswer, untouched, stoppedBlockLine, until, worksFixture, worksAcceptance, factWorksPass, lostAfterClaim, a6Survives, advanceRun, mp2Works, mp2WorkAnswer, threeArtifacts, regatedHold, defectedWork } from "./om-run-fixture.js";

test("3 8 25 C23 C17 C27 R5 H1.1 on its own new bases the pass works the block through MC1, E5 and G4b to one G7 close, then applies the accepted facts", async t => {
  const f = runFixture(t, undefined, "executed");
  const { m5, second, request } = await blockBases(f);
  f.steps([m5, factsAll(f, second.routes), assessor("supported"), assessor("supported")]);
  const driven = await drive(f, request, 40);
  assert.deepEqual(driven.performed, ["open-series", "open", "register", "packet", "cycle", "assess", "assess", "routes", "evaluate", "close",
    "apply", "bases", "apply", "bases"], JSON.stringify(driven.wait));
  const series = blockSeries(f);
  const outcome = series.value.attempts[0]!.outcome!;
  assert.equal(outcome.reason, "result");
  // The saved M8's completion admission names the input before the applied facts moved its head —
  // the pass stands on that exact stale basis instead of reopening the confirmed feasibility.
  assert.deepEqual([driven.wait.code, driven.wait.target, driven.wait.field],
    ["input_stale", `om-input:${project}`, "head"], JSON.stringify(driven.wait));
  assert.equal(f.sent().length, 4, "Every paid call was made once; a new B1 never calls MC1 again");
  // №1860-4: the machine task's result form {answer} runs D5 → MC1 → E5 → the applied B1, read back from the saved input.
  const input = ok(readOmInput(f.store, project, reference(f.store.get(`om-input:${project}`)!)));
  assert.deepEqual(input.value.input.facts!.map(fact => [fact.question.id, fact.value]).sort(),
    [["discovery:encoding", { answer: "UTF-8" }], ["discovery:spare", { answer: "UTF-8" }]]);
  assert.deepEqual(input.value.input.questions, [], "An applied fact leaves the open questions");
  assert.equal(driven.wait.target, `om-input:${project}`, "The standing wait names the moved input head it bases on");
});

test("H1.2 R1 R3 R4 R10 17 19 20 C33 three attempts without progress stop the M5 series; A6 reviews the exact stop once, an undecided review ends the pass on the second rung, and nothing is written or paid again", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h1-first"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const attempt = ["open", "packet", "cycle", "close"];
  // R1: a stop of the first rung not yet reviewed is no ground: the one A6 of that exact stop is performed first.
  const reviewed = await driveTo(f, request, "analyze", 40);
  assert.deepEqual(reviewed.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze"]);
  const series = mechanismSeries(f);
  assert.deepEqual(series.value.attempts.map(row => row.outcome?.reason), ["refused", "refused", "refused"]);
  assert.ok(series.value.stop, "A3 set the stop; the pass counts nothing itself");
  assert.equal(series.value.escalations.length, 1, "The undecided review escalated the stop atomically (A6)");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready", "Nothing ended before the review's own result was read");
  const sends = f.sent().length;
  assert.equal(sends, 4, "Three attempts and the one review");
  // R3/R4: the saved review and the escalation are the ground; no further call is made and no decision is required or made.
  const end = await ends(f, request, 5);
  assert.deepEqual(end.performed, []);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.match(reasons[0]!.message, /attempt 3/);
  assert.equal(reasons[0]!.basis.length, 2);
  assert.ok(reasons[0]!.basis.some(ref => ref.id === series.id && ref.revision === series.revision), "The exact stopped line");
  assert.ok(reasons[0]!.basis.some(ref => ref.hash === series.value.escalations[0]!.review.hash), "The exact review of this stop");
  assert.equal(f.store.list().filter(row => row.id.startsWith(ownerDecisionNamespace(project))).length, 0);
  assert.equal(f.sent().length, sends);
  // R10: the saved end comes back from advance, start, a new store and a changed Environment; nothing is written or paid.
  const saved = ok(readRun(f.store, { project }))!, before = untouched(f.store);
  f.restart();
  assert.deepEqual(ok(await advanceRun(f.store, request)).record, saved);
  f.environment();
  const changed = ok(await advanceRun(f.store, f.request()));
  assert.deepEqual([changed.performed, changed.products, changed.record], [null, [], saved]);
  assert.deepEqual(ok(startRun(f.store, { project })), saved);
  assert.equal(refusal(startRun(f.store, { project, outcomes: ["another-outcome"] })).code, "run_intent_conflict", "A pass never changes its intent");
  // R10a: the direct entries of the builder read the saved end before any product of the chain: no base, no write.
  for (const refused of [refusal(prepareRunBases(f.store, { project })), refusal(writeRunBases(f.store, { project })),
    refusal(writeRunBases(f.store, { project, outcomes: saved.value.intent.outcomes as string[] }))]) {
    assert.deepEqual([refused.code, refused.at.target, refused.at.field, refused.at.ref], ["run_bases_terminal", runId(project), "state.phase", reference(saved)]);
    assert.match(refused.message, /unable/);
  }
  assert.equal(refusal(writeRunBases(f.store, { project, outcomes: ["another-outcome"] })).code, "run_intent_conflict", "The intent conflict is judged first");
  assert.deepEqual(untouched(f.store), before);
  assert.equal(f.sent().length, sends);
});

test("H1.2 R8 C31 №2045-1 a stopped line of a block outside the horizon of the launch intent stops nothing; of two stopped lines only the one inside the horizon is a ground", async t => {
  // Outside: the intent names garden-result, so the later block is no node of the horizon the pass derived.
  const f = runFixture(t, [], "executed");
  const stopped = stoppedBlockLine(f, "garden-later-block");
  ok(startRun(f.store, { project, outcomes: ["garden-result"] }));
  const request = f.request(), horizon = f.bases().horizon;
  assert.deepEqual(ok(readHorizon(f.store, project, horizon)).horizon.value.result.horizon.nodes, ["garden-consume-block", "garden-produce-block"]);
  f.steps([stopAnswer(f, false)]);
  const review = ok(await runStopAnalysis(f.store, { project, series: reference(stopped), hold: null, dispatch: request.dispatch }));
  assert.equal(review.value.state, "undecided");
  f.restart();
  const outside = await ends(f, request, 30);
  assert.notEqual(outside.state.phase, "unable", "The finished history of a block the intent never asked for is another subject's: " + JSON.stringify(outside.state));
  assert.equal(f.sent().length, 1, "Only the operator's review was paid");
  // Both: the same kind of stop on a block of the horizon is the pass's ground, and only it is named.
  const g = runFixture(t, [], "executed");
  const foreign = stoppedBlockLine(g, "garden-later-block"), own = stoppedBlockLine(g, "garden-produce-block");
  ok(startRun(g.store, { project, outcomes: ["garden-result"] }));
  const asked = g.request();
  g.bases();
  g.steps([stopAnswer(g, false), stopAnswer(g, false)]);
  for (const line of [foreign, own]) ok(await runStopAnalysis(g.store, { project, series: reference(line), hold: null, dispatch: asked.dispatch }));
  g.restart();
  const inside = await ends(g, asked, 30);
  assert.deepEqual(reasonsOf(inside.state).map(row => [row.kind, row.code, row.target, row.field]),
    [["stop-second-rung", "owner_decision", own.id, "stop"]], "The stop of the block outside the horizon is not among the grounds");
  assert.equal(g.sent().length, 2);
});


test("H1.2 R4 R2 a stop after a spent continuation is on the second rung by that spent window: the first review is not borrowed, no second one is paid", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h12-spent"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, true), none, none, none]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 80);
  const series = mechanismSeries(f), stop = series.value.stop!;
  assert.equal(end.performed.filter(action => action === "analyze").length, 1, "Only the first stop was reviewed");
  assert.equal(end.performed.filter(action => action === "resume").length, 1, "The first stop was continued by its decided review");
  assert.equal(series.value.continuations.length, 1);
  assert.ok(stop.attempt > 3, "The stop that ended the pass is a later stop of the same line");
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.match(reasons[0]!.message, new RegExp(`attempt ${stop.attempt}`), "The message names the later stop, not the first");
  assert.deepEqual(reasons[0]!.basis, [reference(series)], "No review of another stop is borrowed to fill the reference");
  assert.equal(f.sent().length, series.value.attempts.length + 1, "The attempts and the one review of the first stop");
});

test("H1.2 R6 an origin the review establishes lifts its own hold and the pass goes on; it is no ground of the end", async t => {
  const f = runFixture(t, [], "executed");
  ok(startRun(f.store, { project }));
  // The managed regate reopens the consume work; its works answer loses the write access — a real G5 refusal whose
  // row has no placeable origin, so G7 raises the hold the review below stands on.
  const held = await regatedHold(f, {
    files: { "consume.txt": "consumed\n", "regate.test.mjs": "import \"./consume.txt\";\n" },
    cycle: (packet, batch) => batch.task === "node-expansion" && batch.level === 3
      ? defectedWork(f, reference(packet), false) : null,
    // A6 establishes the origin on the row's own proposal source: the refused proposal held the defective work —
    // the only class these grounds prove, so the lift is lawful and the hold goes.
    analyze: () => {
      const rows = (ok(readJournal(f.store, { project })).value as unknown as { rows: { origin: { sources: { role: string }[] } }[] }).rows;
      const proposal = rows.at(-1)!.origin.sources.find(source => source.role === "proposal")!;
      return { research: { protocol: "omg-stop-analysis/v1", cause: null, change: null,
        origin: { class: "proposal", basis: [proposal] } }, usage };
    },
    pause: { step: "analyze" } });
  const holds = f.store.list<{ lift: { class: string } | null }>("om-origin-hold" as never);
  assert.equal(holds.length, 1, "G7 raised one hold of unknown origin");
  const driven = await held.resume({ pause: { performed: "open" } });
  assert.ok(driven, "The drive answered after the review");
  const reviewed = driven.performed.lastIndexOf("analyze");
  assert.ok(reviewed >= 0, "The review of the hold was paid");
  assert.deepEqual(driven.performed.slice(reviewed), ["analyze", "open"], "The review lifts its own hold and the next attempt opens on the same line");
  const lifted = f.store.get<{ lift: { class: string } | null }>(holds[0]!.id)!;
  assert.equal(lifted.value.lift?.class, "proposal");
  assert.notEqual(driven.state.phase, "unable");
});

test("C41 C43 К7 H1 a product written before the cursor moved is found again by the saved request: no second call, open or close", async t => {
  const f = runFixture(t, undefined, "executed");
  const b = f.bases("h1-first"), request = f.request(b);
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  // Window after the producer of the opening and before the cursor: the same saved request finds the same attempt.
  const opening = await until(f, request, "open");
  const opened = ok(openAttempt(f.store, opening.request as never));
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.products, [refOf(opened)]);
  // Window after a paid cycle and before the cursor: a restart repeats the cycle by its request without a send.
  const cycling = await until(f, request, "cycle");
  // №1737 п.5: the common claim preparer keeps the typed incompleteness of an unfinished composition.
  const address = { project, owner: { kind: "mechanism" as const, mechanism: "M5:addressing" as const }, line: 1, attempt: 1 };
  const empty = { reason: "result" as const, accepting: [], cancelling: [], refusals: [] };
  assert.equal(refusal(prepareManagedClaim(f.store, { ...address, outcome: empty } as never)).code, "completion_incomplete");
  const cycle = ok(await runModelCycle(f.store, cycling.request as never));
  assert.equal(f.sent().length, 1);
  f.restart();
  const found = ok(await advanceRun(f.store, request));
  assert.deepEqual(found.products, [refOf(cycle.record)]);
  assert.equal(f.sent().length, 1, "The saved call is not sent again");
  // Window after G7 and before the cursor: the close is repeated only with its saved claim, and changes nothing.
  const closing = await until(f, request, "close");
  // The saved claim is the preparer's: every applied M5 addressing is named by the registry itself, not by the caller.
  const claim = ok(prepareManagedClaim(f.store, { ...address, outcome: empty } as never));
  assert.deepEqual((closing.request as unknown as { outcome: unknown }).outcome, JSON.parse(JSON.stringify(claim.outcome)));
  assert.deepEqual(claim.outcome.accepting, [refOf(cycle.last!.record)], "The applied E4 is required even when the caller names nothing");
  assert.ok(claim.guards.some(guard => "id" in guard && guard.id === mechanismSeries(f).id), "The claim carries the heads it stands on");
  ok(closeAttempt(f.store, closing.request as never));
  const closedAt = f.store.list().map(reference);
  const after = ok(await advanceRun(f.store, request));
  assert.equal(after.performed?.action, "close");
  assert.deepEqual(f.store.list().map(reference).filter(ref => ref.id !== runId(project)), closedAt.filter(ref => ref.id !== runId(project)));
  assert.equal(mechanismSeries(f).value.attempts.length, 1, "No second attempt or close");
});
// FA1 return №3833: a technical terminal beside a lawful negative verdict of another own fact is no technical failure —
// the negative verdict is the attempt's own cause, so nothing is paid again and the earlier wait stands.
test("FA1 №3833 an own off-form E5 terminal beside an own insufficient or conflicting verdict keeps the earlier frame_gate wait: no close, no fact asked or assessed again", async t => {
  for (const negative of ["insufficient", "conflicting"] as const) await t.test(negative, async child => {
    const { f, performed, state, assessed, consume } = await factWorksPass(child, ["off-form", negative], 2);
    assert.deepEqual(assessed, ["off-form", negative], `Each fact is assessed once: ${performed.join(",")} ${JSON.stringify(state)}`);
    assert.equal(consume.value.attempts.length, 1, "No next attempt is opened");
    assert.equal(consume.value.attempts[0]!.outcome, null, "The attempt is not closed through the technical branch");
    assert.equal(performed.includes("works"), false);
    assert.equal(worksAcceptance(f.store).frame, false, "No acceptance");
    assert.deepEqual([state.phase, (state.wait as { code?: string } | undefined)?.code], ["waiting", "frame_gate"]);
  });
});

test("29 H1 a pass record that lost a required saved field is an integrity refusal: nothing is chosen, sent or written", async t => {
  const f = runFixture(t, undefined, "executed");
  const request = f.request(f.bases("h1-29"));
  ok(startRun(f.store, { project }));
  await until(f, request, "open-series");
  const head = f.store.get<RunRecord>(runId(project))!;
  const lost = structuredClone(head.value) as unknown as { state: { step: Record<string, unknown> } };
  delete lost.state.step.request;
  f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: lost as unknown as Json });
  const before = f.store.list().map(reference);
  assert.equal(refusal(await advanceRun(f.store, request)).code, "run_record_invalid");
  assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid");
  assert.deepEqual(f.store.list().map(reference), before, "The saved step is not guessed from the last head");
  assert.equal(f.store.list("repair-series").length, 0);
  assert.equal(f.sent().length, 0);
});

test("4 9 C21 C22 C25 H1 a lost E4 executor after its claim is recovered by the common recovery; the same saved cycle goes on without a send", async t => {
  const f = runFixture(t, undefined, "executed");
  const b = f.bases("h1-lost"), request = f.request(b);
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const cycling = await until(f, request, "cycle");
  lostAfterClaim(f, cycling);
  const running = f.store.list().find(row => row.kind === "model-call" && (row.value as { om?: unknown }).om)!;
  assert.equal((running.value as { status: string }).status, "running");
  assert.equal(f.sent().length, 0, "The lost process never reached the adapter");
  // The saved cycle is performed again: the common recovery proves the loss and the cycle reads the recovered call.
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.performed, cycling);
  assert.equal(resumed.record.value.state.phase, "ready");
  const recovered = f.store.get(running.id)!.value as { status: string; error: string; om: { application: string } };
  assert.deepEqual([recovered.status, recovered.error, recovered.om.application], ["failed", "process_lost", "recovered"]);
  assert.equal(f.sent().length, 0, "Recovery sends nothing");
  const cycles = f.store.list().filter(row => row.kind === "om-model-cycle").length;
  const driven = await driveTo(f, request, "bases", 20);
  assert.deepEqual(mechanismSeries(f).value.attempts.map(row => row.outcome?.reason), ["interrupted", "result"],
    `${driven.performed.join(",")} ${JSON.stringify(driven.wait)}`);
  assert.equal(driven.performed.filter(action => action === "cycle").length, 1, "Only the next attempt cycles; the recovered one is not re-sent");
  assert.equal(f.store.list().filter(row => row.kind === "om-model-cycle").length, cycles + 1);
  assert.equal(f.sent().length, 1);
});

test("4 9 C21 H1 a lost assessor after its claim is recovered the same way: the saved assessment reads its recovered transport, no second intent", async t => {
  const f = runFixture(t, ["encoding"], "executed", true);
  const b = f.bases("h1-lost-e5"), request = f.request(b);
  f.steps([factsAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const assessing = await until(f, request, "assess", 20);
  const sends = f.sent().length;
  lostAfterClaim(f, assessing);
  assert.equal(f.sent().length, sends, "The lost assessor never reached the adapter");
  const intents = f.store.list().filter(row => row.kind === "om-assessment-intent").length;
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.performed, assessing);
  assert.equal(resumed.record.value.state.phase, "ready", JSON.stringify(resumed.record.value.state));
  const terminal = f.store.get(resumed.products[0]!.id)!.value as { verdict: string };
  assert.equal(terminal.verdict, "interrupted", "The recovered assessor is a technical terminal, not a new call");
  assert.equal(f.store.list().filter(row => row.kind === "om-assessment-intent").length, intents);
  assert.equal(f.sent().length, sends);
});

test("4 9 12 21 C21 №1814 H1 A6 on an origin hold keeps its saved request through a live executor, its loss, a new Environment revision and a restart", async t => {
  const f = runFixture(t, [], "executed");
  ok(startRun(f.store, { project }));
  // The managed regate: three real terminals of the consume line — two off-form closes, then a works refusal whose
  // G5 rows have no placeable origin — A3 stops the series and G7 raises a hold per row; the pass stands at A6.
  const held = await regatedHold(f, {
    files: { "consume.txt": "consumed\n", "regate.test.mjs": "import \"./consume.txt\";\n" },
    cycle: (packet, batch, attempt) => {
      if (batch.task !== "node-expansion" || batch.level !== 3) return null;
      return (attempt ?? 0) < 3 ? { research: { answer: "untyped reviewer reply" }, usage }
        : defectedWork(f, reference(packet), true);
    },
    analyze: () => ({ research: { protocol: "omg-stop-analysis/v1", cause: null, change: null, origin: null }, usage }),
    pause: { step: "analyze" } });
  const analyzing = held.second!.step!;
  assert.ok((analyzing.request as { hold: unknown }).hold !== null, "A6 reviews the exact hold first");
  const sends = f.sent().length;
  await a6Survives(t, f, f.request(), analyzing, () => f.request());
  assert.equal(f.sent().length, sends, "The saved review is repeated by its request; nothing is sent again");
});

test("MP2 (№2968 rows 1, 3, 4, 5) through the pass a block designs its producer operation first; the consumer's brief carries the producer's finished work with its write paths; the producer's own brief has the explicit empty set; a saved step goes on before any rank", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const prep = works.find(row => row.node === "garden-prep-operation")!, produce = works.find(row => row.node === "garden-produce-operation")!;
  assert.ok(prep && produce, "The produce block owns two operations joined by garden-prep-flow");
  ok(startRun(f.store, { project }));
  let restarted = false;
  const trail: string[] = [];
  const cycles = await mp2Works(f, step => {
    const request = step.request as { batch?: string; packet?: Ref };
    const batch = request.batch ?? (request.packet ? f.store.get<QuestionPacketRecord>(request.packet.id)?.value.request.batch : undefined);
    trail.push(`${step.action}:${batch === prep.id ? "prep" : batch === produce.id ? "produce" : batch ?? "-"}`);
    // Row 4: a saved packet step of the producer continues after a restart, before the other root is ranked.
    if (!restarted && step.action === "cycle") { restarted = true; f.restart(); }
  });
  const batchOf = (packet: Ref) => f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.request.batch;
  const order = cycles.map(batchOf).filter(batch => batch === prep.id || batch === produce.id);
  assert.deepEqual(order, [prep.id, produce.id], `Row 1: the producer operation is designed first: ${trail.join(" ")}`);
  const at = (step: string) => trail.indexOf(step);
  assert.ok(at("packet:prep") < at("cycle:prep") && at("cycle:prep") < at("packet:produce"),
    `Row 4: begun work goes on before the next root is started, whatever the order of ids: ${trail.join(" ")}`);
  const root = (batch: string) => f.store.list<QuestionPacketRecord>("question-packet").find(row => row.value.request.batch === batch
    && !row.value.request.previous.length && !row.value.request.continuation && !row.value.request.correction)!;
  assert.deepEqual(root(prep.id).value.briefNeighbors, { contract: "om-brief-neighbors/v1", sources: [] }, "Row 19: the explicit empty set");
  const neighbours = root(produce.id).value.briefNeighbors!;
  assert.deepEqual(neighbours.sources.map(source => [source.node, source.batch]), [["garden-prep-operation", prep.id]], "Row 5: the finished producer");
  const text = (root(produce.id).value.packet as { brief: { text: string } }).brief.text;
  assert.ok(text.includes("# Accepted work of neighbouring roots"));
  const section = JSON.parse(text.split("# Accepted work of neighbouring roots\n")[1]!.split("\n")[1]!) as { works: { node: string; writes: string[]; nodes: { id: string }[] }[] };
  assert.equal(section.works[0]!.node, "garden-prep-operation");
  assert.ok(section.works[0]!.nodes.some(node => node.id === "garden-prep-work"), "Row 5: the producer's work node");
  assert.ok(section.works[0]!.writes.length > 0, "Row 5: the files it declared for writing");
});
test("G6.1 return №3913 a given transfer of a shared file is a link: no offered order breaks it, an answer that does is refused, the lawful choice keeps it and the group is accepted", async t => {
  const f = worksFixture(t, false, false, threeArtifacts), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], trail: string[] = [];
  const push = (research: unknown) => { steps.push({ research, usage }); writeFileSync(scenario, JSON.stringify({ database: f.database, steps })); };
  ok(startRun(f.store, { project }));
  const answered = new Set<string>(), offered: string[][][] = [];
  let orders = 0, works: string[] = [];
  for (let index = 0; index < 300 && !worksAcceptance(f.store).frame; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string }; step?: { action: string; request: { packet?: Ref; wake?: { task?: string }; ordinal?: number } } };
    trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    if (state.phase === "waiting" || state.phase === "unable") break;
    if (state.phase !== "step") continue;
    const current = state.step!;
    if (current.action === "wake" && current.request.wake?.task === "write-order" && current.request.ordinal === orders + 1) {
      // The breaking order first (the probe's answer), then the lawful order that puts the third writer before the link.
      push({ writeOrder: orders === 0 ? [works[0]!, works[2]!, works[1]!] : [works[2]!, works[0]!, works[1]!] });
      orders++;
      continue;
    }
    if (current.action !== "cycle" || !current.request.packet || answered.has(current.request.packet.id)) continue;
    const saved = current.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
    answered.add(saved.id);
    const answer = mp2WorkAnswer(f, saved), node = answer.research.proposal.nodes[0]!.parent!;
    if (node === "garden-produce-operation") {
      const example = structuredClone((packet.value.packet as unknown as { brief: { examples: { action: string; proposal: { nodes: Node[]; fills: { codeRef?: { path: string } }[]; tests: { contract: { entrypoint: { path: string } } }[]; transfers: Graph["transfers"] } }[] } }).brief.examples.find(row => row.action === "answer")!.proposal);
      works = example.nodes.map(item => item.id);
      assert.equal(works.length, 3, "The example gives a work per artifact");
      for (const item of example.nodes) item.code = item.code.map(ref => ({ ...ref, path: "src/shared.ts" }));
      for (const fill of example.fills) if (fill.codeRef) fill.codeRef.path = "src/shared.ts";
      for (const test of example.tests) test.contract.entrypoint.path = "src/shared.ts";
      example.transfers = [...(example.transfers ?? []), { id: "given-producer-pair", path: "src/shared.ts", from: works[0]!, to: works[1]!, condition: "producer_committed" }];
      push({ ...answer.research, proposal: example });
    } else {
      if (node === "garden-consume-operation") (answer.research.proposal.joins as unknown[]).push(structuredClone(f.desired.joins.find(row => row.consumer === "garden-consume-work")!));
      push(answer.research);
    }
  }
  const text = trail.join(",");
  for (const intent of f.store.list<{ allowed: string[] }>(WAKE_INTENT_KIND)) offered.push(intent.value.allowed.map(row => JSON.parse(row) as string[]));
  assert.ok(offered.length > 0, text);
  for (const options of offered) {
    assert.deepEqual(options.map(row => canonical(row)).sort(), [[works[0], works[1], works[2]], [works[2], works[0], works[1]]].map(row => canonical(row as Json)).sort(),
      "Every offered order keeps the given link, and no other");
  }
  const choices = f.store.list<{ task?: string; verdict: string }>(WAKE_CHOICE_KIND).filter(row => row.value.task === "write-order").map(row => row.value.verdict);
  assert.deepEqual(choices.sort(), ["chosen", "refused"], text);
  assert.deepEqual([worksAcceptance(f.store).passed, worksAcceptance(f.store).frame], [true, true], `The group is accepted: ${text.slice(-700)}`);
  const graph = f.store.get<Graph>(`graph:${project}`)!.value;
  const shared = (graph.transfers ?? []).filter(row => row.path === "src/shared.ts").map(row => [row.from, row.to]).sort();
  assert.deepEqual(shared, [[works[0], works[1]], [works[2], works[0]]].sort(), "The given link stays, the code adds the lawful rest");
});
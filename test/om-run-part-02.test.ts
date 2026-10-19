import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { historicalProofCounters } from "../src/history/proofs.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { assessAnswer } from "../src/discovery/research-assessment.js";
import type { OmInputRecord } from "../src/om/input.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { writeOmInput } from "../src/om/input.js";
import { beginAttempt, openSeries, ownerDecisionNamespace, OWNER_DECISION_KIND, resumeSeries } from "../src/om/series.js";
import { type RoutesRecord } from "../src/om/routes.js";
import type { RepairSeries } from "../src/om/series.js";
import { closeAttempt } from "../src/om/repeat-gate.js";
import { prepareCompletionCause, runModelCall, writeCompletionCessation } from "../src/om/model-call.js";
import { ResearchSources } from "../src/discovery/research-sources.js";
import { readRun, startRun, runId, type RunRequest, type RunRecord, type RunStep } from "../src/om/run.js";
import { prepareRunBases } from "../src/om/run-bases.js";
// OWN1.2 (№3806): the live pass had derived D7 for this exact request by the older rule (73d95d93 carried the environment
// question to its consumer); the newer rule derives another ledger for the same request. Its earlier performance with the
// older product is no step without effect: the pass writes the new ledger and the works go on (OMG-LIVE 0537 snapshot).
import { prepareOmObligations, type ObligationRequest } from "../src/om/obligations.js";
import { readGaps } from "../src/om/gaps.js";
import { checkAnswerForm } from "../src/om/answer-form.js";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
import { runWakeChoice, type WakeChoiceRecord, type WakeChoiceRequest } from "../src/om/wake-choice.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { prepareReconcileSeries, readSeries, readStopHistory, readSeriesProgressTransitionAt } from "../src/om/series.js";
// ---- LP8.1 (№3670): an unable pass weighs its grounds again by today's rules at every entry ----
import { startPass } from "../src/om/run-driver.js";
import { project, ok, refusal, runFixture, addressAll, usage, blockSeries, actions, ends, driveTo, reasonsOf, stopAnswer, stoppedBlockLine, frameAnswer, OWN1_DECISION, decisionCalls, restWithDecisions, until, nodeAnswer, worksFixture, worksAcceptance, factWorksPass, LostApplication, driveUntil, gapHeads, addressQuestions, atCommit, sameEnd, twoOwnerAnswers, LP3_PACKET_COMMIT, lp3NativePackets, advanceRun, lp3Need, lp3Context, LP4_COMMITS, lp4Configure, lp4Questions, g51Pass, type Lp6Op, lp6Line } from "./om-run-fixture.js";


test("H1.2 R4 R1 a block line stopped by three fruitless attempts: the one review is undecided and the second rung ends the pass on the block's exact stop", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const stopped = stoppedBlockLine(f);
  assert.ok(stopped.value.stop, "A3 stopped the line");
  assert.equal(stopped.value.escalations.length, 0, "Nothing reviewed it yet");
  const request = f.request(f.bases("h12-block-stop"));
  f.steps([stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 30);
  const series = blockSeries(f);
  assert.deepEqual(series.value.attempts.map(row => row.outcome?.reason), ["result", "result", "result"]);
  assert.equal(end.performed.filter(action => action === "analyze").length, 1, "The one review of the exact stop");
  assert.equal(end.performed.includes("open") || end.performed.includes("open-series"), false, "The stopped line opens no attempt");
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.equal(series.value.escalations.length, 1, "The undecided review escalated the stop atomically (A6)");
  assert.ok(reasons[0]!.basis.some(ref => ref.hash === series.value.escalations[0]!.review.hash), "The review of this very stop");
  assert.equal(f.store.list().filter(row => row.id.startsWith(ownerDecisionNamespace(project))).length, 0, "No decision of the owner is required or made");
  const sends = f.sent().length;
  assert.equal(sends, 1, "Only the one review was paid");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.equal(f.sent().length, sends);
});

test("H1.2 R13a R8 an open N2 attempt whose MC1 asked the owner: after the neighbour's work the full G4b proves that exact question, and no close, C5 or D2 is invented", async t => {
  const f = runFixture(t, ["encoding"], false, true);
  const b = f.bases("h12-frame-owner"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const answers: Record<string, unknown>[] = [], answered = new Set<string>();
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 150 && !state; index++) {
    const advanced = ok(await advanceRun(f.store, request)), now = advanced.record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && now.step.action === "cycle") {
      const packet = (now.step.request as unknown as { packet: Ref }).packet;
      if (!answered.has(packet.id)) { answered.add(packet.id); answers.push(frameAnswer(f, now.step)); f.steps(answers); }
    }
    if (now.phase === "waiting" || now.phase === "unable" || now.phase === "complete") state = now;
  }
  assert.ok(state, "The pass came to rest");
  const reasons = reasonsOf(state);
  const need = reasons.filter(row => row.kind === "frame-need-owner");
  assert.deepEqual(need.map(row => [row.code, row.target, row.field, row.message]),
    [["model_need_owner", "discovery:encoding", "answer", "Need a concrete source; Choose the source"]], JSON.stringify(reasons));
  assert.ok(need[0]!.basis.length >= 3, "The gate, the call and the diagnostic of E4");
  for (const block of ["garden-produce-block", "garden-consume-block"])
    assert.equal(blockSeries(f, block).value.attempts[0]!.outcome, null, `${block}: the attempt stays open, no close is invented`);
  assert.equal(f.store.get(`om-frame:${project}:2`), null, "No C5");
  assert.ok(!actions(f.store).some(action => ["accept", "confirm", "lines"].includes(action)), "No C5 and no D2 without a passed G4b");
  assert.equal(f.sent().length, 3, "The neighbour's MC2 and the consumer's MC1 and MC2: everything reachable was worked first");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.equal(f.sent().length, 3);
});
test("OWN1 H1.2 R13 R8 a fact and a design decision of one block are each asked once: the fact is applied, the model's decision with its alternatives stands decided in B1, and the pass ends on neither", async t => {
  const f = runFixture(t, ["encoding", "spare"]);
  addressQuestions(f, [["encoding", "repository-fact"], ["spare", "design-decision"]]);
  const request = f.request();
  ok(startRun(f.store, { project }));
  const state = await restWithDecisions(f, request);
  // At rest — idle on its bases or ending for another reason — never on these questions.
  assert.ok(!(state.phase === "unable" ? reasonsOf(state) : []).some(row => row.target === "discovery:spare" || row.target === "discovery:encoding"), JSON.stringify(state));
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
  assert.deepEqual(input.decided?.map(row => [row.question.id, row.value]), [["discovery:spare", OWN1_DECISION]],
    `${JSON.stringify(state).slice(0, 600)} ${actions(f.store).join(",")}`);
  assert.ok(input.decided![0]!.decision.id.startsWith(`om-input-decision:${project}:`));
  assert.ok(input.facts?.some(row => row.question.id === "discovery:encoding"), "The fact is applied");
  assert.ok(!input.questions.some(row => row.id === "discovery:spare" || row.id === "discovery:encoding"));
  assert.equal(decisionCalls(f), 1, "The decision is paid once");
  const sent = f.sent().length;
  f.restart();
  for (let index = 0; index < 3; index++) ok(await advanceRun(f.store, request));
  assert.equal(f.sent().length, sent, "A restart pays for nothing again");
});
test("OWN1.2 a D7 request the older rule performed (the environment question carried) is performed again by the newer one: the pass writes the new ledger and the works answer is accepted, never step_without_effect", async t => {
  const f = worksFixture(t, true);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>();
  let older: { producer: Ref; ledger: Ref } | null = null;
  let state: { phase: string; step?: { action: string; request: { packet: Ref } }; wait?: unknown } = { phase: "" };
  for (let index = 0; index < 200 && !performed.includes("works"); index++) {
    const head = f.store.get<RunRecord>(runId(project))!;
    const chosen = head.value.state as unknown as { phase: string; step?: RunStep };
    if (!older && chosen.phase === "step" && chosen.step!.action === "obligations") {
      // What the older rule wrote for this exact request: the same ledger with the environment question carried.
      const request = chosen.step!.request as unknown as ObligationRequest;
      const derived = ok(prepareOmObligations(f.store, request));
      assert.deepEqual(derived.record.value.assignments, [], "The newer rule carries nothing here");
      const gap = ok(readGaps(f.store, request.gaps)).records.find(row => row.value.gap.target === "discovery:later-env")!;
      const value = { ...derived.record.value, assignments: [{ obligation: gap.value.gap.id, original: { record: reference(gap), pointer: "/gap" },
        kind: "environment-confirmation", moment: "task-start", neededForR2: false, responsibleNode: "garden-consume-block",
        responsibleConsumer: "garden-consume-block", wake: null, reason: "Assigned by the engine in the bypass: the consumer answers it at task-start.",
        returnCondition: "Which runtime does the task start on?" }] };
      const ledger = f.store.write({ id: `om-obligations:${project}:${hashJson(value as unknown as Json)}`, kind: "om-obligations", expected: 0, value: value as unknown as Json });
      const basis = { ...derived.producer.value, ledger: reference(ledger) };
      const producer = f.store.write({ id: `om-obligation-basis:${project}:${hashJson(basis as unknown as Json)}`, kind: "om-obligation-basis", expected: 0, value: basis as unknown as Json });
      older = { producer: reference(producer), ledger: reference(ledger) };
      f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, state: { phase: "ready" },
        last: { step: chosen.step!, products: [older.producer, older.ledger], refusal: null } } as unknown as Json });
      continue;
    }
    const advanced = ok(await advanceRun(f.store, f.request));
    if (advanced.performed) performed.push(advanced.performed.action);
    state = advanced.record.value.state as unknown as typeof state;
    if (state.phase === "step" && state.step!.action === "cycle" && !answered.has(state.step!.request.packet.id)) {
      answered.add(state.step!.request.packet.id); f.answer(state.step!.request.packet);
    }
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") break;
  }
  assert.ok(older, "The pass chose D7 of this exact request");
  assert.ok(performed.includes("obligations"), `The newer rule's D7 is performed after the older one: ${performed.join(",")} ${JSON.stringify(state)}`);
  const ledgers = f.store.list<{ assignments: { kind: string }[] }>("om-obligations");
  assert.ok(ledgers.some(row => row.id === older!.ledger.id), "The older ledger stays as written");
  assert.ok(ledgers.some(row => row.id !== older!.ledger.id && !row.value.assignments.length), `The newer one is added beside it: ${JSON.stringify(ledgers.map(row => [row.id, row.value.assignments.length]))}`);
  assert.ok(performed.includes("works"), `The works answer that binds nothing is accepted: ${performed.join(",")} ${JSON.stringify(state)}`);
  assert.deepEqual(worksAcceptance(f.store), { passed: true, frame: true, findings: [] }, "G5 passed and layer 3 is written");
});
test("FA1 a lawful negative E5 verdict of the attempt's own fact is no technical failure: the attempt is never closed as off-form or interrupted and the fact is not asked again", async t => {
  const { performed, state, assessed, consume } = await factWorksPass(t, ["insufficient"]);
  assert.deepEqual(assessed, ["insufficient"], `${performed.join(",")} ${JSON.stringify(state)}`);
  assert.ok(!["off-form", "interrupted"].includes(consume.value.attempts[0]!.outcome?.reason ?? ""),
    `The negative verdict keeps its earlier rules: ${JSON.stringify(consume.value.attempts[0]!.outcome)} ${JSON.stringify(state)}`);
  assert.equal(performed.includes("works"), false);
});


test("1 24 22 C57 R20 №1860-8 H1.1 a managed project works only on the activation of the pass's own issue: the machine runs B3, a new root works after it, a block outside the intent never", async t => {
  const f = runFixture(t, ["encoding"], false, true, true);
  // The project is already transition-managed: another issue activated an independent block's root.
  ok(openSeries(f.store, { project, block: "garden-later-block", line: 1, slice: "h1-other", predecessor: null, basis: null }));
  f.activate("h1-initial", { features: [{ outcome: "garden-later" }], excluded: [] });
  ok(startRun(f.store, { project, outcomes: ["garden-result"] }));
  const request = f.request();
  const pointer = () => f.store.get<{ applied: Ref; series: { block: string; participation: string }[] }>(`om-series-current:${project}`)!;
  const issued = () => {
    const applied = f.store.get<{ prepared: Ref }>(pointer().value.applied.id, pointer().value.applied.revision)!;
    return f.store.get<{ request: { horizon: Ref } }>(applied.value.prepared.id, applied.value.prepared.revision)!.value.request.horizon;
  };
  const initial = issued();
  // The current activation belongs to another issue: no work stands on it; the pass first builds its bases and B3.
  assert.deepEqual((await driveTo(f, request, "bases", 3)).performed, ["bases"]);
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases of the pass's own issue are current");
  assert.notDeepEqual(initial, built.built.bases.horizon);
  assert.deepEqual(issued(), built.built.bases.horizon, "The current pointer now stands on the pass's own issue");
  // Row 1: a root registered for new work is unactivated; the machine's next B3 (a new P of the same issue) activates it.
  assert.deepEqual((await driveTo(f, request, "open-series", 3)).performed, ["open-series"]);
  const root = () => f.store.list<RepairSeries>("repair-series").find(row => (row.value as { block?: string }).block === "garden-produce-block"
    || (row.value as { block?: string }).block === "garden-consume-block")!;
  assert.equal((root().value as { activation?: { state: string } }).activation?.state, "unactivated");
  assert.equal(root().value.attempts.length, 0);
  assert.deepEqual((await driveTo(f, request, "bases", 3)).performed, ["bases"]);
  assert.deepEqual((root().value as { activation?: { state: string; participation: string } }).activation,
    { ...(root().value as { activation: object }).activation, state: "activated", participation: "active" });
  // Row 22: new work opens on the line B3 proved — the current line, without a successor.
  const opened = await driveTo(f, request, "open", 3);
  assert.deepEqual(opened.performed, ["open"]);
  const all = f.store.list<RepairSeries>("repair-series"), current = root();
  assert.ok(!all.some(other => other.value.predecessor?.id === current.id));
  assert.equal(current.value.attempts.length, 1);
  // Row 24: the block outside the intent keeps its line and starts no work.
  assert.equal(pointer().value.series.find(row => row.block === "garden-later-block")!.participation, "unselected");
  assert.equal(blockSeries(f, "garden-later-block").value.attempts.length, 0);
});

test("5 4 H1 an answer received before a lost process is applied by the same saved step after restart, without a second send", async t => {
  const f = runFixture(t);
  const b = f.bases("h1-5"), request = f.request(b);
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const cycling = await until(f, request, "cycle");
  f.restart(path => new LostApplication(path));
  await assert.rejects(advanceRun(f.store, request), /lost after the receipt/);
  assert.equal(f.sent().length, 1, "The adapter answered once");
  const call = f.store.list().find(row => row.kind === "model-call")!;
  assert.notEqual((call.value as { om?: { application?: string } }).om?.application, "applied");
  f.restart();
  const loaded = historicalProofCounters().loaded;
  const resumed = ok(await advanceRun(f.store, request));
  // PF4 (№3499 row 43): the restarted process takes the checks the lost one saved; the saved receipt still decides.
  assert.ok(historicalProofCounters().loaded > loaded, "The restart is served by saved checks");
  assert.deepEqual(resumed.performed, cycling, "The saved request is performed, not a new choice");
  assert.equal(f.sent().length, 1, "The saved receipt is applied without a second send");
  assert.equal((f.store.get(call.id)!.value as { om: { application: string } }).om.application, "applied");
});

test("25 R20 №1937-1 №1860-5 H1.1 managed N2: while the first participant waits for the frame, the missing one is registered and activated by B3 of the same issue and paid; the first keeps its scope", async t => {
  const f = runFixture(t, [], false);
  // The managed era began with an activation of the producing block's root only; the consuming root does not exist yet.
  ok(openSeries(f.store, { project, block: "garden-produce-block", line: 1, slice: "h11-initial", predecessor: null, basis: null }));
  f.activate("h11-initial", { features: [{ outcome: "garden-result" }], excluded: [] });
  const request = f.request(f.bases());
  const first = await until(f, request, "cycle", 40);
  f.steps([nodeAnswer(f, first)]);
  const d1 = gapHeads(f.store), done = actions(f.store).length;
  const reached = await driveUntil(f, request, state => state.phase === "step" && state.step.action === "cycle" && state.step.series !== first.series);
  assert.deepEqual(actions(f.store).slice(done), ["cycle", "open-series", "bases", "open", "register", "packet"],
    "The first pays and waits; the missing root is registered, activated by B3 of the same issue, and opens its own work");
  assert.equal(reached.state.phase, "step");
  const consume = blockSeries(f, "garden-consume-block");
  assert.deepEqual([(consume.value as { activation?: { state: string; participation: string } }).activation?.state,
    (consume.value as { activation?: { participation: string } }).activation?.participation], ["activated", "active"]);
  const produce = blockSeries(f, "garden-produce-block");
  assert.deepEqual(produce.value.attempts.map(attempt => attempt.outcome), [null], "The first participant keeps its one open attempt");
  assert.deepEqual(gapHeads(f.store), d1, "No D1 head moved under the waiting participant");
  ok(await advanceRun(f.store, request));
  assert.equal(f.sent().length, 2, "The missing participant is actually paid");
});
// Top-level registrations only: S1.1 (om-operation-cost) loads this file as a fixture with its test() calls removed.
test("OWN1.1 №3722 two owner answers of questions the bypass gives the model are both decisions: the model is never asked, B1 holds both owner values",
  async t => twoOwnerAnswers(t, false));
test("OWN1 №3719 P2-2 a decision packet asks no owner: no need_owner in its form or examples, every example passes its own check, and a need_owner reply is a correctable refusal", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  const request = f.request();
  ok(startRun(f.store, { project }));
  let saved: Ref | null = null;
  for (let index = 0; index < 20 && !saved; index++) {
    const now = ok(await advanceRun(f.store, request)).record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && now.step.action === "cycle") saved = (now.step.request as unknown as { packet: Ref }).packet;
    else if (now.phase !== "step" && now.phase !== "ready") assert.fail(`The pass stood before its decision cycle: ${JSON.stringify(now)}`);
  }
  assert.ok(saved, "The decision packet is issued");
  const payload = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!.value.packet as unknown as {
    responseForm: { schema: { oneOf: { properties: { action?: { const?: string } } }[] } }; brief: { examples: Record<string, Json>[]; text: string } };
  assert.ok(!payload.responseForm.schema.oneOf.some(branch => branch.properties.action?.const === "need_owner"));
  assert.ok(!payload.brief.examples.some(example => example.action === "need_owner"));
  assert.ok(payload.brief.text.includes("the owner is not asked in this pass"));
  for (const example of payload.brief.examples) {
    const checked = checkAnswerForm(f.store, { project, packet: saved, raw: canonical(example) });
    assert.ok(checked.ok, `${canonical(example)}: ${checked.ok ? "" : `${checked.refusal.code} ${checked.refusal.message}`}`);
    if (example.action === "answer") assert.equal(checked.value.kind, "input-decisions");
  }
  const control = payload.brief.examples.find(example => example.action === "cannot_answer")!;
  const asked = checkAnswerForm(f.store, { project, packet: saved, raw: canonical({ ...control, action: "need_owner", reason: "Ask the owner", decision: "Choose the policy" }) });
  assert.equal(asked.ok ? "accepted" : asked.refusal.code, "part_answer_invalid");
  // The pass itself: a model that asks for the owner gets the correction of its answer, and decides on it.
  const issued = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!.value.request;
  const batch = f.store.get<RoutesRecord>(issued.routes.id, issued.routes.revision)!.value.batches.find(row => row.id === issued.batch)!;
  f.steps([{ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap), action: "need_owner",
    reason: "The policy needs the owner", decision: "Choose the policy" }, usage },
  { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: OWN1_DECISION })) }, usage }]);
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 60 && !state; index++) {
    const now = ok(await advanceRun(f.store, request)).record.value.state as unknown as RunRecord["state"];
    if (now.phase === "waiting" || now.phase === "unable" || now.phase === "complete") state = now;
  }
  assert.deepEqual(f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.decided?.map(row => [row.question.id, row.value]),
    [["discovery:spare", OWN1_DECISION]], JSON.stringify(state));
  assert.equal(f.sent().length, 2, "The asked owner is one corrected answer, not a wait");
});

test("LP3 (№2817 row 2, №53) a need_source whose search names a context record as its scope ends the cycle as reads-invalid with its record_foreign: the pass closes the attempt, goes on to the next and never waits on the refusal; a source scope and read_context of the same record still deliver", async t => {
  const f = lp3NativePackets(t, runFixture(t, ["encoding"], undefined, undefined, undefined, undefined, undefined, LP3_PACKET_COMMIT));
  const b = f.bases("lp3-53"), request = f.request(b);
  const need = lp3Need(f, b.routes, [{ action: "search", within: lp3Context(f), query: "encoding" }]);
  f.steps([need, need, need, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const first = await driveTo(f, request, "close", 20);
  assert.deepEqual(first.performed.slice(-2), ["cycle", "close"]);
  const end = await ends(f, request, 60);
  assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
  const cycles = f.store.list<{ terminal: string; diagnostic: Ref }>("om-model-cycle");
  assert.equal(cycles.length, 3); assert.ok(cycles.every(row => row.value.terminal === "reads-invalid"));
  for (const cycle of cycles) assert.equal(f.store.get<{ refusals: { code: string }[] }>(cycle.value.diagnostic.id)!.value.refusals[0]!.code, "record_foreign");
  assert.deepEqual(f.store.list("om-read-delivery"), [], "Nothing was read");
  assert.equal(f.sent().length, 4, "Three attempts and the one review");
  await sameEnd(f, request, 4);
});

test("LP3 (№2870, works-v1) an H1 works root whose three lawful read_context reads leave a continuation the capacity cannot hold ends each cycle blocked, never sends the blocked packet and reaches the attempt's close through G7 — also after a restart between steps", async t => {
  const f = lp3NativePackets(t, worksFixture(t, undefined, undefined, undefined, LP3_PACKET_COMMIT)), capture = new ResearchSources(f.store, project, f.root), reads: unknown[] = [];
  for (let index = 0; index < 3; index++) {
    writeFileSync(join(f.root, `context-${index}.txt`), `context ${index} ${"x".repeat(90_000)}`);
    reads.push({ action: "read_context", record: reference(capture.read(`context-${index}.txt`, "text/plain")), pointer: "/content" });
  }
  ok(startRun(f.store, { project }));
  const steps: unknown[] = [], performed: string[] = [], answered = new Set<string>();
  let closed = false;
  for (let index = 0; index < 45 && !closed; index++) {
    const advanced = ok(await advanceRun(f.store, f.request)), state = advanced.record.value.state;
    if (advanced.performed) performed.push(advanced.performed.action);
    assert.notEqual(state.phase, "waiting", JSON.stringify({ state, performed }));
    if (state.phase === "step" && state.step.action === "cycle") {
      const ref = (state.step.request as unknown as { packet: Ref }).packet;
      if (!answered.has(ref.id)) {
        answered.add(ref.id);
        const saved = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!.value;
        assert.deepEqual([saved.packetContract, saved.state], ["om-packet/works-v1", "ready"]);
        steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source",
          questionIds: (saved.packet as { questions: { id: string }[] }).questions.map(question => question.id),
          missing: "Read the three supplied context values", reads }, usage });
        writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ steps }));
      }
    }
    if (advanced.performed?.action === "cycle") {
      const cycles = f.store.list<{ terminal: string }>("om-model-cycle");
      assert.ok(cycles.length > 0 && cycles.every(row => row.value.terminal === "blocked"), JSON.stringify(cycles.map(row => row.value.terminal)));
      assert.equal(f.sent().length, steps.length, "The blocked continuation is never sent");
      f.restart();
    }
    closed = advanced.performed?.action === "close";
  }
  assert.ok(closed, performed.join(","));
  assert.ok(f.store.list("om-read-delivery").length >= 3, "The three lawful reads were delivered");
  assert.equal(f.sent().length, steps.length);
});

test("LP4 (№2902, rows 3/4) a saved cycle whose step ceased, while its root also has a direct cause of higher priority (a lawfully replaced B1), is not performed: saved as the step or — by the code 202c470 in its own process — as the wait on completion_ceased, the new code goes back to the choice, which ceases the root by its direct cause, without a stop on completion_ceased and without another send", async t => {
  for (const saved of ["step", "waiting"] as const) await t.test(saved, async t => {
    const f = worksFixture(t, undefined, undefined, undefined, LP4_COMMITS['202c470']);
    let step: RunStep | null = null;
    if (saved === "waiting") {
      // LP1 transfer: 202c470 can only write its old waiting state over a packet of its own era.
      step = atCommit(f, LP4_COMMITS["202c470"], "lp4-direct-step", `const { startRun, advanceRun } = await import(src('om/run.js'));
take(startRun(store, { project: args.project }));
let step = null;
for (let index = 0; index < 40 && !step; index++) {
  const state = take(await advanceRun(store, args.request)).record.value.state;
  if (state.phase === 'waiting') throw new Error(JSON.stringify(state));
  if (state.phase === 'step' && state.step.action === 'cycle') step = state.step;
}
out(step);`, { project, request: f.request }) as RunStep | null;
      f.restart();
    } else {
      ok(startRun(f.store, { project }));
      for (let index = 0; index < 40 && !step; index++) {
        const state = ok(await advanceRun(f.store, f.request)).record.value.state;
        assert.notEqual(state.phase, "waiting", JSON.stringify(state));
        if (state.phase === "step" && state.step.action === "cycle") step = state.step as unknown as RunStep;
      }
    }
    assert.ok(step, "A cycle is chosen");
    const packet = (step.request as unknown as { packet: Ref }).packet;
    assert.equal(f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.answerProtocol,
      saved === "waiting" ? "omg-answer/v2" : "omg-answer/v3");
    writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps: [{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source",
      questionIds: lp4Questions(f, packet), missing: "The addressed file", reads: [{ action: "read", path: "lp4-later.txt", media: "text/plain" }] }, usage }] }));
    // The paid need_source is applied while the pass's cursor still stands on the saved step (the boundary of its recovery).
    const owner = ok(await runModelCall(f.store, step.request as never)).record.value.om.completionOwner!;
    const request = lp4Configure(f, f.request);
    ok(writeCompletionCessation(f.store, { project, binding: owner.binding, assignment: owner.assignment }));
    const root = f.store.list<{ kind: string; batch: string }>("om-completion-assignment")
      .find(row => row.value.kind === "root" && row.value.batch === f.store.get<{ batch: string }>(owner.assignment.id)!.value.batch)!;
    assert.equal(ok(prepareCompletionCause(f.store, project, reference(root))).cause!.kind, "cycle-step-ceased");
    const inventory = f.store.write({ id: `repo-inventory:${project}`, kind: "repo-inventory", expected: 0, value: { projectId: project, paths: [] } });
    const before = f.store.get(`om-input:${project}`)!;
    const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
    ok(writeOmInput(f.store, { project, stages, inventory: reference(inventory), expected: before.revision }));
    const direct = ok(prepareCompletionCause(f.store, project, reference(root))).cause!;
    assert.deepEqual([direct.kind, (direct as { prerequisite: { kind: string } }).prerequisite.kind], ["required-record-replaced", "input"], "The direct cause keeps its priority");
    if (saved === "waiting") {
      const stood = atCommit(f, LP4_COMMITS["202c470"], "lp4-direct-waiting", `const { advanceRun } = await import(src('om/run.js'));
const advanced = take(await advanceRun(store, args.request));
out(advanced.record.value.state);`, { request }) as { phase: string; wait?: { code: string } };
      assert.deepEqual([stood.phase, stood.wait?.code], ["waiting", "completion_ceased"], "The code 202c470 performs the forbidden cycle and stands");
    }
    const sent = f.sent().length;
    f.restart();
    const head = ok(readRun(f.store, { project }))!;
    const first = ok(await advanceRun(f.store, request));
    if (saved === "step") assert.deepEqual([first.performed, first.record.value.state.phase, first.record.revision], [null, "ready", head.revision + 1],
      "The saved forbidden cycle goes back to the choice by an ordinary transition");
    else assert.notEqual(first.record.value.state.phase, "waiting", "The saved wait goes on to the choice");
    // On a new Store after every transaction, until the root is ceased: never a stop on completion_ceased.
    const seen: string[] = [];
    const rootCessation = () => f.store.list<{ assignment: Ref }>("om-completion-cessation").find(row => row.value.assignment.id === root.id);
    for (let index = 0; index < 12 && !rootCessation(); index++) {
      f.restart();
      const state = ok(await advanceRun(f.store, request)).record.value.state;
      seen.push(state.phase === "waiting" ? `waiting:${state.wait.code}` : state.phase);
      assert.ok(!seen.includes("waiting:completion_ceased"), seen.join(","));
    }
    const ceased = f.store.get<{ cause: { kind: string; prerequisite?: { kind: string } }; remainder: string }>(rootCessation()!.id)!;
    assert.deepEqual([ceased.value.cause.kind, ceased.value.cause.prerequisite?.kind, ceased.value.remainder], ["required-record-replaced", "input", "assembly"], seen.join(","));
    assert.equal(f.sent().length, sent, "Nothing of the ceased cycle is sent again");
  });
});
// G5.1 return №3867-1: the producer of a wake step wrote the failed result of its intent 1, and the process stopped before
// the pass settled that step. The saved step is that exact intent: repeating it returns result 1 and sends nothing;
// intent 2 is a step of its own, chosen by the next choice of the pass.
test("G5.1 return №3867-1 a restart after the saved failed result of intent 1, before its step settled, sends nothing again: the step returns result 1, and intent 2 is a step of its own", async t => {
  let sends = -1;
  const { f, trail, results } = await g51Pass(t, (allowed, index) => index === 0 ? "not-a-covering-test" : allowed[0]!, 200, async (run, request) => {
    if (request.ordinal !== 1) return;
    const written = ok(await runWakeChoice(run.store, request.wake, 1));
    assert.equal(written.value.verdict, "refused");
    run.restart(); sends = run.sent().length;
  });
  assert.deepEqual(results().map(row => [row.id.split(":").at(-1), row.value.verdict]), [["1", "refused"], ["2", "chosen"]], trail.join(","));
  const wakes = trail.filter(row => row.includes(":wake#"));
  assert.ok(wakes[0]!.includes(":wake#1=1"), `The saved step returns its own result 1: ${trail.join(",")}`);
  assert.ok(wakes[1]!.includes(":wake#2=2"), `Intent 2 is its own step: ${trail.join(",")}`);
  assert.equal(f.sent().length, sends + 1, "The repeat of step 1 sends nothing; only intent 2 is sent");
  assert.ok(trail.some(row => row.includes("works")), trail.join(","));
  // A step names its exact intent: an ordinal past an unsaved earlier one, or past a made choice, is refused.
  const wake = f.store.get<WakeChoiceRecord>(results()[1]!.id)!.value;
  const request = f.store.get<{ request: WakeChoiceRequest }>(wake.intent.id)!.value.request;
  const total = f.sent().length;
  assert.equal(ok(await runWakeChoice(f.store, request, 2)).value.verdict, "chosen", "A saved ordinal returns its own result");
  assert.equal(ok(await runWakeChoice(f.store, request, 1)).value.verdict, "refused");
  assert.equal(f.sent().length, total, "Repeats of saved intents send nothing");
  await assert.rejects(runWakeChoice(f.store, request, 3), /ordinal/);
});

test("LP6 rows 22, 24, 25: on the second rung the pass reconciles a stop e7db0ba8 saved over clean ends of the replaced B1 before it asks for the owner's decision — the rung and its window stay, the real earlier stop and its review are not revisited, and a window with a real failure is never reconciled", async t => {
  const f = lp6Line(t);
  f.old("state-1", [1, 2, 3].flatMap(ordinal => [{ op: "round", ordinal, answers: [{ field: "checkKind", cannot: `Not decidable ${ordinal}` }] },
    { op: "close", ordinal }] as Lp6Op[]));
  // Row 24: three real refusals make a real stop; the transition of the new era is not available for it.
  const early = refusal(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never));
  assert.deepEqual([early.code, early.at.field], ["progress_unproved", "attempts.1"]);
  const old = f.old("state-2", [{ op: "analyze", decided: true }, { op: "resume", stop: 3 },
    ...[[4, "state", { writer: "garden-produce-block" }], [5, "nodes", ["garden-produce-block", "garden-consume-block"]], [6, "state", { authority: "garden-consume-block" }]]
      .flatMap(([ordinal, field, value]) => [{ op: "round", ordinal, answers: [{ field: "expansion", unsent: true }] },
        { op: "replace", target: "garden-B1", field, value }, { op: "cease", ordinal }, { op: "close", ordinal }] as Lp6Op[])]);
  assert.deepEqual(old.verdicts, ["none", "none", "none"]);
  const stopped = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
  assert.deepEqual([stopped.stop?.attempt, stopped.ladder.rung, stopped.ladder.windows, stopped.continuations.map(item => [item.after, item.ground])],
    [6, 2, [3], [[3, "review-record"]]]);
  // garden-produce-block comes first in M3: its own real stop on the second rung — fruitless standalone attempts and the
  // owner's decision between them — is no transition (row 24 through the pass) and ends nothing, so the pass goes on.
  const produce = { project, block: "garden-produce-block", line: 1 };
  ok(openSeries(f.store, { ...produce, slice: "lp6-produce", predecessor: null, basis: null } as never));
  const fruitless = { key: "lp6-produce-goal", questions: ["Expand the producer"], result: "An expanded producer" };
  const fail = (from: number) => { for (let attempt = from; attempt < from + 3; attempt++) {
    ok(beginAttempt(f.store, { ...produce, attempt, goal: fruitless } as never));
    ok(closeAttempt(f.store, { ...produce, attempt, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
  } };
  fail(1);
  const decision = f.store.write({ id: `${ownerDecisionNamespace(project)}lp6-produce`, kind: OWNER_DECISION_KIND, expected: 0,
    value: { projectId: project, block: produce.block, stop: 3, goals: [fruitless.key], decided: "go on: one more window",
      taken: { by: "the owner", through: "the command API", approved: true } } });
  ok(resumeSeries(f.store, { ...produce, stop: 3, ground: "owner-decision", text: "the owner decided to go on", decision: { ref: reference(decision) } } as never));
  fail(4);
  assert.equal(refusal(prepareReconcileSeries(f.store, { ...produce, stop: 6 } as never)).code, "progress_unproved");
  // Rows 22, 25: the pass chooses the transition before the second rung could end it; nothing else is paid or asked.
  ok(startRun(f.store, { project }));
  const sent = f.sent().length, trail: string[] = [];
  for (let index = 0; index < 12 && !trail.includes("reconcile"); index++) {
    f.restart();
    const advanced = ok(await advanceRun(f.store, { project, dispatch: f.dispatch } as RunRequest));
    const state = advanced.record.value.state as { phase: string; step?: { action: string } };
    trail.push(advanced.performed?.action ?? state.phase);
    assert.ok(state.phase !== "unable", `The pass never ends on the reconcilable stop: ${trail.join(",")}`);
  }
  assert.ok(trail.includes("reconcile"), trail.join(","));
  assert.equal(f.sent().length, sent, "No model was asked on the way to the transition");
  const series = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
  assert.deepEqual([series.stop, series.ladder.rung, series.ladder.windows, series.withoutProgress], [null, 2, [3], 0]);
  const record = ok(readSeriesProgressTransitionAt(f.store, project, series.reconciliations![0]!.transition)).value;
  assert.deepEqual(record.rows.map(row => [row.ordinal, row.result]), [[4, "administrative"], [5, "administrative"], [6, "administrative"]]);
  // Row 25: the real stop after attempt 3 and its review-record stay as they were; the history shows both stops.
  assert.deepEqual(series.continuations.map(item => [item.after, item.ground]), [[3, "review-record"]]);
  const history = ok(readStopHistory(f.store, f.address as never)).stops;
  assert.deepEqual(history.map(item => [item.attempt, item.continuation?.ground ?? null, item.reconciliation ? "reconciled" : null]),
    [[3, "review-record", null], [6, null, "reconciled"]]);
  assert.deepEqual(series.attempts.slice(3).map(row => row.verdict), ["none", "none", "none"], "The old verdicts stay as they were written");
});

test("DRY6-03 public om-start: a real assessor read_context keeps reference-shaped JSON as data after restart", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-dry6-03-run-")), database = join(root, "state.sqlite");
  const workspace = join(root, "repo"), adapter = join(root, "adapter.mjs"), assessedProject = "assessment-json";
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "fixture\n");
  git(workspace, ["add", "."]); git(workspace, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  writeFileSync(adapter, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;const research=!s.contextWorkspace?.length?{action:'read_context',record:s.working.archive,pointer:'/body/observations/0/value'}:{verdict:'supported',reasons:[]};console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: "create-project", project: assessedProject, title: "Reference-shaped JSON evidence" });
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure(assessedProject, { workspace,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10000 }, 0);
  const fake = { id: "fixture-report", revision: 1, hash: "0".repeat(64) }, payload = { nested: [fake] };
  const source = engine.discovery.evidence.document(assessedProject, "json", JSON.stringify({ payload }), "application/json", 0);
  const draft = engine.discovery.create(assessedProject, "discovery", "R0", "compilation",
    [{ field: "proposal", kind: "design", prompt: "Preserve JSON", risk: "Losing data", schema: { type: "object" } }]);
  const question = store.get<any>(draft.value.questions[0]!)!;
  const assessment = await assessAnswer(store, question,
    { action: "answer", question: question.id, value: payload,
      citations: [{ source: reference(source), selector: { kind: "json-pointer", pointer: "/payload" } }] },
    environment, workspace);
  assert.equal(assessment.value.verdict, "supported");
  const session = store.list<any>("assessment-session").find(row => row.value.workspace?.entries?.length)!;
  assert.ok(session, "The lawful assessor saved its requested original");
  const sites = referenceSites(session.kind, session.value);
  assert.equal(sites.some(site => site.ref.id === fake.id), false);
  assert.ok(sites.some(site => site.field === "workspace.entries[0].result.record"));
  assert.ok(sites.some(site => site.field === "binding.question" && site.ref.id === question.id));
  assert.deepEqual(checkStoreIntegrity(store).findings, []);
  const gateProject = "dry6-03-gate";
  store.write({ id: `om-integrity:${gateProject}`, kind: "om-integrity", expected: 0,
    value: { contract: "om-integrity/v1", project: gateProject, checkedAt: 1, lastSequence: 1,
      revisions: 1, events: 1, references: 1, findings: [{ code: "reference_missing", id: session.id,
        revision: session.revision, field: "workspace.entries[0].result.value.nested[0]", ref: fake,
        message: "Old shape-only diagnostic" }] } });
  store.close(); store = new Store(database); engine = new ProductEngine(store);
  assert.deepEqual(checkStoreIntegrity(store).findings, []);
  const result = await startPass(store, { project: gateProject });
  assert.equal(refusal(result).code, "environment_missing", "om-start passed integrity and reached its next requirement");
});

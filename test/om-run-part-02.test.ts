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
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { assessAnswer } from "../src/discovery/research-assessment.js";
import type { OmInputRecord } from "../src/om/input.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { readCompletionBinding, openSeries, ownerDecisionNamespace} from "../src/om/series.js";
import { type RoutesRecord } from "../src/om/routes.js";
import type { RepairSeries } from "../src/om/series.js";
import { runModelCall, readModelCall, deliverModelSources, readManagedModelDiagnostic } from "../src/om/model-call.js";
import { startRun, runId, type RunRecord, type RunStep } from "../src/om/run.js";
import { prepareRunBases } from "../src/om/run-bases.js";
// OWN1.2 (№3806): the live pass had derived D7 for this exact request by the older rule (73d95d93 carried the environment
// question to its consumer); the newer rule derives another ledger for the same request. Its earlier performance with the
// older product is no step without effect: the pass writes the new ledger and the works go on (OMG-LIVE 0537 snapshot).
import { prepareOmObligations, type ObligationRequest } from "../src/om/obligations.js";
import { readGaps } from "../src/om/gaps.js";
import { checkAnswerForm } from "../src/om/answer-form.js";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
// ---- LP8.1 (№3670): an unable pass weighs its grounds again by today's rules at every entry ----
import { startPass } from "../src/om/run-driver.js";
import { lp3Blocked, lp3Pointers, mechanismSeries, project, ok, refusal, runFixture, addressAll, usage, blockSeries, actions, ends, driveTo, reasonsOf, stopAnswer, stoppedBlockLine, frameAnswer, OWN1_DECISION, decisionCalls, restWithDecisions, until, nodeAnswer, worksFixture, worksAcceptance, factWorksPass, LostApplication, driveUntil, gapHeads, addressQuestions, sameEnd, twoOwnerAnswers, advanceRun, lp3Need, lp3Context } from "./om-run-fixture.js";

test("H1.2 R4 R1 a block line stopped by three fruitless attempts: the one review is undecided and the second rung ends the pass on the block's exact stop", async t => {
  const f = runFixture(t, ["encoding"], "executed", true);
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
  const f = runFixture(t, ["encoding"], "stages", true);
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
  const f = runFixture(t, ["encoding", "spare"], "executed");
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
  const f = runFixture(t, ["encoding"], "stages", true, true);
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
  const f = runFixture(t, undefined, "executed");
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
  const f = runFixture(t, [], "stages");
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
  async t => twoOwnerAnswers(t, false, "executed"));
test("OWN1 №3719 P2-2 a decision packet asks no owner: no need_owner in its form or examples, every example passes its own check, and a need_owner reply is a correctable refusal", async t => {
  const f = runFixture(t, ["spare"], "executed");
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

test("LP3 current context search labels fail before delivery: one correction per attempt, G7 closes all three, and restart repeats the unable end without payment", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("lp3-53"), request = f.request(b);
  const need = lp3Need(f, b.routes, [{ action: "search", within: lp3Context(f), query: "encoding" }]);
  f.steps([need, need, need, need, need, need, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const first = await driveTo(f, request, "close", 20);
  assert.deepEqual(first.performed.slice(-2), ["cycle", "close"]);
  const end = await ends(f, request, 60);
  assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
  const cycles = f.store.list<{ terminal: string; steps: { packet: Ref; record: Ref }[] }>("om-model-cycle");
  assert.equal(cycles.length, 3);
  assert.equal(mechanismSeries(f).value.attempts.length, 3);
  for (const cycle of cycles) {
    assert.equal(cycle.value.terminal, "outcome");
    assert.equal(cycle.value.steps.length, 2, "The first answer and exactly one correction");
    for (const step of cycle.value.steps) {
      const call = ok(readModelCall(f.store, { project, record: step.record }));
      assert.deepEqual([call.record.value.om.failure?.code, call.record.value.om.failure?.at.field], ["answer_label_unknown", "reads/0/within"]);
      assert.ok(call.diagnostic && call.response);
      const packet = f.store.get<QuestionPacketRecord>(step.packet.id, step.packet.revision)!.value;
      const attempt = packet.request.attempt!;
      const binding = ok(readCompletionBinding(f.store, project, attempt.series, attempt.ordinal))!;
      const diagnostic = ok(readManagedModelDiagnostic(f.store, binding, call.diagnostic));
      assert.deepEqual([diagnostic.request.packet, diagnostic.request.call, diagnostic.request.response, diagnostic.request.code],
        [step.packet, call.call, call.response, "answer_label_unknown"]);
    }
  }
  assert.deepEqual(f.store.list("om-read-delivery"), [], "Nothing was read");
  assert.equal(f.sent().length, 7, "Six answers and the one review; no third correction");
  await sameEnd(f, request, 7);

  const positive = runFixture(t, ["encoding"], "executed");
  const bases = positive.bases("lp3-positive"), req = positive.request(bases);
  ok(startRun(positive.store, { project }));
  const step = await until(positive, req, "cycle");
  const packetRef = (step.request as unknown as { packet: Ref }).packet;
  const packet = positive.store.get<QuestionPacketRecord>(packetRef.id, packetRef.revision)!;
  const labels = (packet.value.packet as unknown as { brief: { labels: { domain: string; value: Ref }[] } }).brief.labels;
  const source = labels.find(label => label.domain === "source")!.value;
  const context = labels.find(label => label.domain === "context" && label.value.id.startsWith("om-input:"))!.value;
  const reads = [{ action: "search", within: source, query: "encoding" }, { action: "read_context", record: context, pointer: "/input/questions/0/question" }];
  positive.steps([lp3Need(positive, bases.routes, reads)]);
  const paid = ok(await runModelCall(positive.store, { ...(step.request as object), project } as Parameters<typeof runModelCall>[1]));
  assert.equal(paid.outcome?.kind, "need-source", "Both reads are lawful under the current label protocol");
  const delivered = ok(deliverModelSources(positive.store, { project, packet: packetRef, call: paid.call, response: paid.response! }));
  assert.equal(delivered.deliveries.length, 2);
  const rows = positive.store.list<{ read: Json; data: Json }>("om-read-delivery");
  assert.equal(rows.length, 2);
  const at = (read: object) => rows.find(row => canonical(row.value.read) === canonical(read as Json))!.value.data;
  assert.deepEqual(at(reads[1]!), { contract: "om-read-result/v1", outcome: "complete", requested: { pointer: "/input/questions/0/question" },
    value: positive.store.get<OmInputRecord>(context.id, context.revision)!.value.input.questions[0]!.question });
  const content = positive.store.get<{ content: string }>(source.id, source.revision)!.value.content;
  assert.deepEqual(at(reads[0]!), content.split(/\r?\n/).flatMap((text, index) => text.toLowerCase().includes("encoding")
    ? [{ source, line: index + 1, text }] : []));
});

test("LP3 current works-brief roots whose distinct lawful context pointers exceed the continuation capacity ends each cycle blocked, never sends the blocked packet and reaches the attempt's close through G7 — also after a restart between steps", async t => {
  const f = worksFixture(t, undefined, undefined, undefined);
  const environment = f.store.get<import("../src/runtime/environment.js").Environment>(`environment:${project}`)!;
  const configured = f.engine.environments.configure(project, { ...environment.value, requestCapacityChars: 100_000 }, environment.revision);
  const request = { ...f.request, dispatch: { ...f.request.dispatch, config: reference(configured) } };
  const graph = reference(f.store.get(`graph:${project}`)!);
  const pointers = lp3Pointers(f.store.get(graph.id, graph.revision)!.value).slice(0, 192);
  assert.equal(pointers.length, 192);
  const reads = pointers.map(pointer => ({ action: "read_context", record: graph, pointer }));
  ok(startRun(f.store, { project }));
  const steps: unknown[] = [], performed: string[] = [], answered = new Set<string>();
  let closed = false;
  for (let index = 0; index < 45 && !closed; index++) {
    const advanced = ok(await advanceRun(f.store, request)), state = advanced.record.value.state;
    if (advanced.performed) performed.push(advanced.performed.action);
    assert.notEqual(state.phase, "waiting", JSON.stringify({ state, performed }));
    if (state.phase === "step" && state.step.action === "cycle") {
      const ref = (state.step.request as unknown as { packet: Ref }).packet;
      if (!answered.has(ref.id)) {
        answered.add(ref.id);
        const saved = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!.value;
        assert.deepEqual([saved.packetContract, saved.state], ["om-packet/works-brief-v1", "ready"], JSON.stringify({ refusal: saved.refusal, priorCalls: steps.length }));
        steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source",
          questionIds: (saved.packet as { questions: { id: string }[] }).questions.map(question => question.id),
          missing: "Read the distinct addressed context values", reads }, usage });
        writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps }));
      }
    }
    if (advanced.performed?.action === "cycle") {
      lp3Blocked(f, steps.length, "node_unexpandable", reads.length, 100_000);
      f.restart();
    }
    closed = advanced.performed?.action === "close";
  }
  assert.ok(closed, performed.join(","));
  assert.equal(f.store.list("om-read-delivery").length, steps.length * reads.length, "Every root delivered each exact page");
  assert.equal(f.sent().length, steps.length);
});

// G5.1 return №3867-1: the producer of a wake step wrote the failed result of its intent 1, and the process stopped before
// the pass settled that step. The saved step is that exact intent: repeating it returns result 1 and sends nothing;
// intent 2 is a step of its own, chosen by the next choice of the pass.

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
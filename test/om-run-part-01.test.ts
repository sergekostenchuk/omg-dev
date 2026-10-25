import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { refused, transfer, type OmResult } from "../src/om/refusal.js";
import { ProductEngine } from "../src/product/engine.js";
import type { OmInputRecord } from "../src/om/input.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { readOmInput } from "../src/om/input.js";
import { readRoutes, type RoutesRecord } from "../src/om/routes.js";
import type { RepairSeries } from "../src/om/series.js";
import { closeAttempt, openAttempt, prepareManagedClaim } from "../src/om/repeat-gate.js";
import { runModelCall, readModelCall, runModelCycle, type ModelCycleRecord, type OmModelCall } from "../src/om/model-call.js";
import { readQuestionPacket, writeQuestionPacket } from "../src/om/question-packet.js";
import { cycleStartOf, readRun, startRun, runId, type RunRecord, type RunRequest } from "../src/om/run.js";
import { writeRunBases } from "../src/om/run-bases.js";
import { gardenGraph } from "./om-fixture.js";
import { readOmObligations } from "../src/om/obligations.js";
import type { CarriedObligation } from "../src/graph/om-obligation-readers.js";
import { taskBindingId } from "../src/graph/task-obligations.js";
import { readFeasibility, type OmFeasibility } from "../src/om/feasibility.js";
import { readWorksFrame } from "../src/om/works-frame.js";
import type { GapRecord } from "../src/om/gaps.js";
// OWN1 (№3719, return of Codex-omg): the owner's answer is above the model's, and a decision packet asks no owner.
import { issueOwnerInvitation, OwnerSessions } from "../src/product/owner-authority.js";
import { writeOwnerResult } from "../src/om/owner-result.js";
// ---- MP2 (№2968): the still unstarted roots of an attempt by the flows of their frame; neighbours of a brief root ----
import { rankExpansions } from "../src/om/run.js";
// ---- LP5 (№3278): after a replaced B1 the old work ends by its own products, the new bases are built, paid assemblies answer again ----
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { readSeries } from "../src/om/series.js";
import { gapLineKey as lp7LineKey, gapLineExpectedResult as lp7Result } from "../src/om/gap-lines.js";
import { project, ok, refusal, runFixture, type Fixture, addressAll, usage, mechanismSeries, actions, ends, driveTo, reasonsOf, stopAnswer, secondRung, decisionCalls, restWithDecisions, until, worksFixture, nodeRefusal, driveUntil, gapHeads, addressQuestions, sameEnd, advanceRun, lp3Need, lp3Order, lp3Blocked, lp3Pointers, LP3_UNPROVED, lp3Hiding, lp3Context, isRefOf, asCycleStart, asRunResult, mp2Upper, mp2Rank, mp2Works, mp2WorkAnswer, lp6Line, lp6Close, LP7_VALUES, lp7Routes } from "./om-run-fixture.js";

test("LG01r1 current fixture modes preserve the run's questions and never prebuild a cold B1", t => {
  for (const mode of ["stages", "n2", "executed"] as const) {
    const f = runFixture(t, ["own-question"], mode);
    assert.deepEqual(f.input!.value.input.questions.map(row => row.id), ["discovery:own-question"]);
    assert.deepEqual(f.store.list("phase"), [], "Current modes never create research phases");
    assert.equal(!!f.store.get(`om-frame:${project}:2`), mode !== "stages");
    assert.equal(!!f.store.get(`om-frame:${project}:3`), mode === "executed");
    const cold = runFixture(t, ["own-question"], mode, false, false, true);
    assert.equal(cold.input, null);
    for (const id of [`om-input:${project}`, `om-frame:${project}:2`, `om-frame:${project}:3`, runId(project)])
      assert.equal(cold.store.get(id), null, `${mode}: ${id} is created only by the tested operation`);
    assert.deepEqual(cold.store.list("phase"), []);
  }
});

test("H1.2 R10a a second store ending the pass between the builder's derivation and its first write: the lost write reads the pass again and builds no base", async t => {
  const f = runFixture(t, undefined, "executed");
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveUntil(f, request, state => state.phase === "step" && state.step.action === "bases");
  const d1 = gapHeads(f.store), horizons = f.store.list("om-horizon").length;
  let raced = false;
  class Ending extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-horizon")) {
        raced = true;
        const other = new Store(f.database);
        try {
          const head = other.get<RunRecord>(runId(project))!, input = other.get(`om-input:${project}`)!;
          other.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, state: { phase: "unable", reasons: [
            { kind: "stop-second-rung", code: "owner_decision", message: "Ended by another store", target: "repair-series:h12", field: "stop", basis: [reference(input)] }] } } as unknown as Json });
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Ending(path));
  const advanced = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(advanced).code, "revision_conflict", "The pass moved under the saved step: its outcome is not written over the other store's end");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
  assert.deepEqual(gapHeads(f.store), d1, "The lost build moved no D1 head");
  assert.equal(f.store.list("om-horizon").length, horizons);
  assert.equal(refusal(writeRunBases(f.store, { project })).code, "run_bases_terminal");
});

test("H1.2 R11 two stores deriving the same end: one write wins, the other reads the winner's pass, and the grounds are the same", async t => {
  const { f, request } = await secondRung(t, "executed");
  let raced = false;
  class Losing extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "unable")) {
        raced = true;
        const other = new Store(f.database);
        try { void advanceRun(other, request); } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Losing(path));
  const lost = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(lost).code, "revision_conflict");
  const winner = ok(readRun(f.store, { project }))!;
  assert.equal(winner.value.state.phase, "unable");
  f.restart();
  const same = ok(await advanceRun(f.store, request));
  assert.deepEqual(same.record, winner, "The loser converges to the one saved end");
  assert.equal(f.store.history(runId(project)).filter(row => (row.value as unknown as RunRecord).state.phase === "unable").length, 1);
  assert.equal(reasonsOf(winner.value.state).length, 1);
});

test("2 R1 H1.1 cold OM to the first model step: the machine builds B1, the pass and its bases; a pass without built bases builds them first", async t => {
  const f = runFixture(t, ["encoding"], "stages", false, false, true);
  assert.equal(f.store.get(`om-input:${project}`), null, "No OM record exists");
  const built = ok(writeRunBases(f.store, { project }));
  f.steps([addressAll(f, built.bases.routes)]);
  const request = f.request();
  const cycling = await until(f, request, "cycle", 10);
  assert.deepEqual(actions(f.store), ["open-series", "open", "packet"], "M5 is the first work; nobody issued any bases");
  assert.ok(ok(await advanceRun(f.store, request)).performed?.action === "cycle" && cycling);
  assert.equal(f.sent().length, 1, "The first paid model step");
  // A pass whose bases were never built: its first step is its own saved build, before any series or attempt.
  const g = runFixture(t, ["encoding"], "stages");
  ok(startRun(g.store, { project }));
  assert.equal(g.store.list("horizon").length, 0);
  const first = ok(await advanceRun(g.store, g.request())).record.value.state;
  assert.equal(first.phase === "step" && first.step.action, "bases");
  assert.equal(g.store.list("repair-series").length, 0);
  assert.equal(ok(await advanceRun(g.store, g.request())).performed?.action, "bases");
  assert.equal(g.store.list("om-horizon").length, 1, "One issue of the launch intent");
});

test("13 H1 technical outcomes are closed by G7 with their proved reason; the next attempt opens only after the previous one is closed", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("h1-13"), request = f.request(b);
  f.steps([{ research: { invalid: true }, usage }, { rawStdout: "{broken", exitCode: 7 }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const driven = await driveTo(f, request, "bases", 40);
  const attempt = ["open", "packet", "cycle", "close"];
  assert.deepEqual(driven.performed, ["open-series", ...attempt, ...attempt, ...attempt, "bases"], JSON.stringify(driven.wait));
  assert.deepEqual(mechanismSeries(f).value.attempts.map(row => row.outcome?.reason), ["off-form", "interrupted", "result"]);
  assert.equal(f.sent().length, 3);
});

test("25 11 R2 №1770 H1 an N2 root that ended without assembly closes its own attempt through G7: no candidate, C5 or D2, no waiting for the frame", async t => {
  const f = runFixture(t, [], "stages");
  const b = f.bases("h1-negative"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const a1 = await until(f, request, "cycle");
  f.steps([nodeRefusal(f, a1)]);
  for (let index = 0; index < 20 && f.store.get<RepairSeries>(a1.series!)!.value.attempts[0]!.outcome === null; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.record.value.state.phase === "waiting") assert.fail(JSON.stringify(advanced.record.value.state));
    if (advanced.performed) f.restart();
  }
  assert.equal(f.store.get<RepairSeries>(a1.series!)!.value.attempts[0]!.outcome!.reason, "refused");
  assert.deepEqual(actions(f.store).slice(-3), ["cycle", "evaluate", "close"]);
  assert.ok(!actions(f.store).some(action => ["candidate", "accept", "lines", "confirm"].includes(action)),
    "A negative close needs no candidate, C5 or D2");
  assert.equal(f.sent().length, 1);
});

test("H1.5 №2166 п.4 the moment decides, not the kind: an environment confirmation or a post-implementation proof of the pass is a ground of its end, one of task-start or task-result is no barrier of the pass", async t => {
  // Native N2 must actually build N3 now; the former research fixture had a full L3 without om-frame:3.
  async function completeWorks(f: Fixture, request: RunRequest) {
    const replies: Record<string, unknown>[] = [], packets = new Set<string>(), performed: string[] = [];
    ok(startRun(f.store, { project }));
    // Includes N3 registration, D1/D2/D7, paid parts, G4b/G5/G7 and M8/M9/compilation (formerly 12 idle transitions).
    for (let index = 0; index < 200; index++) {
      const next = ok(await advanceRun(f.store, request)), state = next.record.value.state;
      if (next.performed) performed.push(next.performed.action);
      if (state.phase === "step" && state.step.action === "cycle") {
        const ref = (state.step.request as unknown as { packet: Ref }).packet;
        if (!packets.has(ref.id)) {
          packets.add(ref.id);
          const packet = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!;
          const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!;
          const batch = routes.value.batches.find(row => row.id === packet.value.request.batch)!;
          assert.deepEqual([batch.task, batch.level], ["node-expansion", 3], "Only real N3 questions are sent");
          assert.ok(!batch.items.some(item => item.target === "discovery:proof"));
          const answer = mp2WorkAnswer({ store: f.store, desired: gardenGraph() }, ref);
          const handoff = ok(readOmObligations(f.store, { project, producer: packet.value.request.works!.producer }));
          assert.deepEqual(reference(handoff.record), packet.value.request.works!.ledger);
          const work = answer.research.proposal.nodes[0]!;
          const assigned = (packet.value.packet as unknown as { works: { assigned: string[] } }).works.assigned;
          const bindings = handoff.handoff.obligations.filter(item => assigned.includes(taskBindingId(item as CarriedObligation)))
            .map(item => ({ id: taskBindingId(item as CarriedObligation), scope: item.scope, obligation: item.obligation,
              consumers: [{ node: work.id, tests: work.tests }] }));
          replies.push({ ...answer, research: { ...answer.research, bindings }, usage }); f.steps(replies);
        }
      }
      if (["unable", "waiting", "complete"].includes(state.phase)) {
        const calls = f.store.list<OmModelCall>("model-call").filter(row => row.value.om);
        assert.equal(calls.length, f.sent().length, `Every physical N3 call is accounted for: ${JSON.stringify({ state, performed, failures: calls.map(row => row.value.om.failure) })}`);
        assert.equal(calls.length, packets.size, "Each exact packet is paid once, with no correction or hidden review");
        for (const call of calls) {
          const ref = call.value.om.request.packet;
          assert.ok(packets.has(ref.id));
          const packet = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!;
          assert.deepEqual(reference(packet), ref);
          const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!;
          assert.deepEqual(reference(routes), packet.value.request.routes);
          const batch = routes.value.batches.find(row => row.id === packet.value.request.batch)!;
          assert.deepEqual([batch.task, batch.level], ["node-expansion", 3]);
          assert.ok(!batch.items.some(item => item.target === "discovery:proof"), "The unsupported/late question itself is never paid");
        }
        return { state, performed };
      }
    }
    assert.fail(`N3 did not reach its terminal state: ${performed.join(",")}`);
  }
  const history = (f: Fixture) => f.store.list().flatMap(row => f.store.history(row.id).map(reference));
  for (const [kind, later] of [["environment-confirmation", "task-start"], ["post-implementation-proof", "task-result"]] as const) {
    const blocking = runFixture(t, ["proof"], "n2");
    addressQuestions(blocking, [["proof", kind]]);
    const request = blocking.request(), ended = await completeWorks(blocking, request);
    const reasons = reasonsOf(ended.state);
    assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]),
      [["unsupported-question", "route_result_unsupported", "discovery:proof", "answer"]], kind);
    const gap = blocking.store.list<GapRecord>("gap").find(row => row.value.gap.target === "discovery:proof")!;
    assert.ok(gap);
    assert.deepEqual(reasons[0]!.basis.find(ref => ref.id === gap.id), reference(gap));
    assert.ok(blocking.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.some(row => row.id === "discovery:proof"));
    const before = history(blocking);
    await sameEnd(blocking, request, blocking.sent().length);
    assert.deepEqual(history(blocking), before, "Restart writes no revision after the exact unsupported end");

    const deferred = runFixture(t, ["proof"], "n2", false, false, false, { proof: { moment: later } });
    addressQuestions(deferred, [["proof", kind]]); // Before current D1, D7 and N3, never on a stale accepted horizon.
    const lateRequest = deferred.request(), finished = await completeWorks(deferred, lateRequest);
    assert.equal(finished.state.phase, "complete", JSON.stringify(finished));
    const m8 = deferred.store.get<OmFeasibility>(`om-feasibility:${project}`)!;
    assert.ok(m8 && m8.value.ready);
    assert.deepEqual(ok(readFeasibility(deferred.store, { project, record: reference(m8) })), m8);
    const candidate = ok(readWorksFrame(deferred.store, { project, candidate: m8.value.producer.candidate }));
    assert.deepEqual({ producer: candidate.value.works!.producer, ledger: candidate.value.works!.ledger }, m8.value.producer.obligations);
    const d7 = ok(readOmObligations(deferred.store, { project, producer: m8.value.producer.obligations.producer }));
    assert.deepEqual(reference(d7.record), m8.value.producer.obligations.ledger);
    const input = deferred.store.get<OmInputRecord>(`om-input:${project}`)!;
    assert.ok(input.value.input.questions.some(row => row.id === "discovery:proof"), "A carried question remains open in B1");
    assert.equal(deferred.store.list("om-owner-gap-assignment").length, 0, "No H2 is invented");
    if (kind === "environment-confirmation") assert.deepEqual(d7.record.value.assignments, [], "No runtime proof: no work assignment");
    else {
      assert.equal(d7.record.value.assignments.length, 1);
      const assignment = d7.record.value.assignments[0]!;
      const original = deferred.store.get<GapRecord>(assignment.original.record.id, assignment.original.record.revision)!;
      assert.deepEqual(reference(original), assignment.original.record);
      assert.deepEqual([assignment.original.pointer, original.value.gap.target, assignment.kind, assignment.moment,
        assignment.responsibleNode, assignment.responsibleConsumer],
      ["/gap", "discovery:proof", "post-implementation-proof", "task-result", "garden-consume-block", "garden-consume-block"]);
      assert.ok(candidate.value.works!.bindings.some(binding => binding.obligation === assignment.obligation
        && binding.consumers.some(consumer => consumer.node === "garden-consume-work")));
    }
    t.diagnostic(`${kind}: ${deferred.sent().length} native N3 calls, ${finished.performed.length} transitions, complete with ready M8`);
    const lateBefore = history(deferred);
    await sameEnd(deferred, lateRequest, deferred.sent().length);
    assert.deepEqual(history(deferred), lateBefore);
  }
});
test("OWN1 №3719 P2-1 an owner's H2 answer of a question the bypass gives the model is its decision: the model is never asked, B1 holds the owner's value, om-decisions names the owner", async t => {
  const f = runFixture(t, ["spare"], "executed");
  addressQuestions(f, [["spare", "owner-decision"]]);
  const bases = f.bases(), request = f.request();
  const routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!;
  const routed = routes.value.routes.find(row => row.kind === "owner-decision")! as unknown as { record: Ref; route: string };
  assert.equal(routed.route, "design", "The bypass routes it to the model");
  const sessions = new OwnerSessions(f.store), { invitation } = ok(issueOwnerInvitation(f.store, { project }));
  const authority = sessions.authority(ok(sessions.exchange({ project, invitation })).bearer)!;
  const owner = ok(writeOwnerResult(f.store, authority, { project, routes: reference(routes), gap: routed.record,
    value: "Retain every record permanently", basis: "Explicit choice for this question" }, { routes: readRoutes, input: readOmInput }));
  ok(startRun(f.store, { project }));
  const state = await restWithDecisions(f, request);
  assert.ok(!(state.phase === "unable" ? reasonsOf(state) : []).some(row => row.target === "discovery:spare"), JSON.stringify(state));
  assert.equal(decisionCalls(f), 0, "The model is never asked the question the owner answered");
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
  assert.deepEqual(input.decided?.map(row => [row.question.id, row.value]),
    [["discovery:spare", { owner: reference(owner.result), value: "Retain every record permanently" }]]);
  assert.ok(!input.questions.some(row => row.id === "discovery:spare"));
  const listed = ok(new ProductEngine(f.store).execute({ type: "om-decisions", project }) as unknown as OmResult<{ decisions: { id: string; by: string; decision: string; owner: Ref | null; alternatives: unknown[] }[] }>);
  assert.deepEqual(listed.decisions.map(row => [row.id, row.by, row.decision, row.owner, row.alternatives.length]),
    [["discovery:spare", "owner", "Retain every record permanently", reference(owner.result), 0]]);
});

// RD2 pages individual values; distinct read addresses must themselves exceed the fixed continuation budget.
test("LP3 (№2817 rows 3, 4, №52) a continuation the capacity cannot hold ends its cycle blocked and is never sent: the pass closes each attempt through G7, goes up the ladder and ends by A6 — never waiting on the blocked packet; the start of the root's cycle is chosen by its links in both positions of root and continuation", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  f.environment(80_000);
  const b = f.bases("lp3-52"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const selected = await until(f, request, "cycle");
  const rootRef = (selected.request as unknown as { packet: Ref }).packet;
  const body = f.store.get<QuestionPacketRecord>(rootRef.id, rootRef.revision)!.value.packet as unknown as {
    brief: { labels: { domain: string; value: Ref }[] }
  };
  // Select by stable record identity, not the label order (labels are ordered by hashes).
  const context = body.brief.labels.find(label => label.domain === "context" && label.value.id === `graph:${project}`)!.value;
  const pointers = lp3Pointers(f.store.get(context.id, context.revision)!.value).slice(0, 256);
  assert.equal(pointers.length, 256);
  const reads = pointers.map(pointer => ({ action: "read_context", record: context, pointer }));
  const need = lp3Need(f, b.routes, reads);
  f.steps([need, need, need, stopAnswer(f, false)]);
  const first = await driveTo(f, request, "close", 20);
  assert.deepEqual(first.performed.slice(-2), ["cycle", "close"], `The blocked root is closed by G7, not waited on (products ${lp3Order(f)})`);
  // Both positions of the root packet and its blocked continuation, without relying on the order the hashes gave here.
  const packets = f.store.list<QuestionPacketRecord>("question-packet");
  const root = reference(packets.find(row => !row.value.request.continuation)!), continuation = reference(packets.find(row => row.value.request.continuation)!);
  for (const order of [[root, continuation], [continuation, root]]) assert.deepEqual(cycleStartOf(f.store, project, order), { ok: true, value: root });
  assert.deepEqual(cycleStartOf(f.store, project, [continuation]), { ok: true, value: null }, "A continuation alone starts no cycle");
  // №2870: a packet whose place E2's reader does not prove is no continuation: its refusal stands, in either position.
  const unproved = { missing: { ...continuation, id: `${continuation.id}-missing` }, stale: { ...continuation, hash: "0".repeat(64) }, foreign: lp3Context(f) };
  for (const [name, ref] of Object.entries(unproved)) {
    const refusals = [[root, ref], [ref, root]].map(order => cycleStartOf(f.store, project, order));
    assert.ok(refusals.every(found => !found.ok), `${name}: ${JSON.stringify(refusals)}`);
    assert.deepEqual(refusals[0], refusals[1], `${name}: the same refusal in both positions`);
    LP3_UNPROVED[name] = (refusals[0] as { refusal: { code: string } }).refusal.code;
  }
  assert.deepEqual(LP3_UNPROVED, { missing: "record_missing", stale: "record_forged", foreign: "record_foreign" });
  const end = await ends(f, request, 60);
  assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
  assert.equal(mechanismSeries(f).value.attempts.length, 3, "Three attempts of the ladder");
  lp3Blocked(f, 4, "packet_too_large", reads.length, 80_000);
  const roots = f.store.list<QuestionPacketRecord>("question-packet").filter(row => !row.value.request.continuation).map(reference);
  const two = cycleStartOf(f.store, project, roots.slice(0, 2));
  assert.ok(!two.ok && two.refusal.code === "run_record_invalid", "Two starts are an addressed refusal, never a second dispatch");
  await sameEnd(f, request, 4);
});

test("LP3 current packet reads can be temporarily unavailable at selection or a saved cycle: exact waiting is idempotent and the same root resumes with one lawful read and its continuation", async t => {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("lp3-2870"), request = f.request(b);
  const content = "UTF-8 is supported\n";
  writeFileSync(join(f.root, "repo", "encoding.txt"), content);
  f.steps([lp3Need(f, b.routes, [{ action: "read", path: "encoding.txt", media: "text/plain" }]), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  let head = ok(readRun(f.store, { project }))!;
  for (let index = 0; index < 20 && !(head.value.state.phase === "ready" && head.value.last?.step.action === "packet"); index++)
    head = ok(await advanceRun(f.store, request)).record;
  assert.equal(head.value.last?.step.action, "packet");
  const packet = head.value.last!.products.find(ref => ref.id.startsWith(`om-question-packet:${project}:`))!;
  const physical = structuredClone(f.store.get(packet.id, packet.revision));
  let intercepted = 0;
  const hidden = lp3Hiding(f.store, packet, () => { intercepted++; });
  const expected = { code: "record_missing", message: "No record exists at this exact reference", target: packet.id,
    field: "producer", basis: [packet] };
  const products = () => ["question-packet", "model-call", "om-model-cycle"].map(kind => f.store.list(kind));
  const beforeProducts = products();
  const chosen = ok(await advanceRun(hidden, request));
  assert.ok(intercepted > 0);
  assert.deepEqual(chosen.record.value.state, { phase: "waiting", wait: expected });
  assert.equal(chosen.record.revision, head.revision + 1);
  assert.equal(chosen.performed, null);
  assert.deepEqual(chosen.record.value.last, head.value.last);
  assert.deepEqual(products(), beforeProducts);
  const repeated = ok(await advanceRun(hidden, request));
  assert.deepEqual(repeated.record, chosen.record, "The same selection wait adds no run revision");
  assert.equal(repeated.performed, null);
  assert.equal(f.sent().length, 0);
  const step = await until(f, request, "cycle");
  assert.ok(isRefOf(step.request, packet));
  const before = ok(readRun(f.store, { project }))!;
  intercepted = 0;
  const performed = ok(await advanceRun(hidden, request));
  assert.ok(intercepted > 0);
  assert.deepEqual(performed.record.value.state, { phase: "waiting", wait: expected });
  assert.equal(performed.record.revision, before.revision + 1);
  assert.deepEqual(performed.performed, step);
  assert.deepEqual(performed.record.value.last, { step, products: [], refusal: expected });
  assert.deepEqual(performed.products, []);
  assert.deepEqual(products(), beforeProducts);
  assert.deepEqual(ok(await advanceRun(hidden, request)).record, performed.record);
  assert.equal(f.sent().length, 0);
  assert.deepEqual(f.store.get(packet.id, packet.revision), physical);
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual(again.performed, step, "Resume the saved cycle request without substituting a new root");
  assert.equal(f.sent().length, 2, "One root and one valid completing continuation");
  const cycle = f.store.list<ModelCycleRecord>("om-model-cycle")[0]!;
  assert.equal(cycle.value.terminal, "outcome");
  assert.deepEqual(cycle.value.request.packet, packet);
  assert.equal(cycle.value.steps.length, 2);
  assert.deepEqual(cycle.value.steps[0]!.packet, packet);
  const continuation = f.store.get<QuestionPacketRecord>(cycle.value.steps[1]!.packet.id, cycle.value.steps[1]!.packet.revision)!;
  assert.deepEqual(continuation.value.request.continuation!.packet, packet);
  assert.deepEqual(continuation.value.request.continuation!.call, ok(readModelCall(f.store, { project, record: cycle.value.steps[0]!.record })).call);
  const deliveries = f.store.list<{ data: Json }>("om-read-delivery");
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0]!.value.data, content);
  assert.deepEqual(continuation.value.request.continuation!.deliveries, [reference(deliveries[0]!)]);
  for (const called of cycle.value.steps) {
    const body = f.store.get<QuestionPacketRecord>(called.packet.id, called.packet.revision)!.value.packet as { requestId: string };
    assert.equal(f.sent().filter(line => JSON.parse(line as string).requestId === body.requestId).length, 1);
  }
  assert.equal(f.store.list<QuestionPacketRecord>("question-packet").filter(row => !row.value.request.continuation).length, 1);
  const snapshot = f.store.list().map(row => f.store.history(row.id));
  const resumed = ok(await runModelCycle(f.store, step.request as unknown as Parameters<typeof runModelCycle>[1]));
  assert.equal(resumed.repeated, true);
  assert.deepEqual(f.store.list().map(row => f.store.history(row.id)), snapshot);
  assert.equal(f.sent().length, 2);
  assert.deepEqual(f.store.get(packet.id, packet.revision), physical);
});
test("LP3 (№2876) a cycle start is refused only with the codes of H1 and of E2's reader marked with its source; the refusal keeps the reader's bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "omg-lp3-codes-")), store = new Store(join(root, "state.sqlite"));
  try {
    const ghost: Ref = { id: `om-question-packet:${project}:${"0".repeat(64)}`, revision: 1, hash: "0".repeat(64) };
    const read = readQuestionPacket(store, { project, record: ghost });
    const lawful = transfer("question-packet", read), started = cycleStartOf(store, project, [ghost]);
    // A lawful result of the reader, through its source, is a result of a cycle start; the result is one of H1's.
    assert.equal(asCycleStart(lawful).ok, false);
    assert.equal(asRunResult<Ref | null>(started).ok, false);
    const unmarked = refused("reviewer_arbitrary_code", "probe", { unit: "H1", target: "probe" }, "producer");
    // @ts-expect-error an unmarked refusal with an arbitrary code is no result of a cycle start (№2876)
    asCycleStart(unmarked);
    // Runtime: the mark is a type only — code, message, address and route are the reader's own.
    assert.ok(!read.ok && !started.ok);
    assert.equal(read.refusal.code, "record_missing");
    assert.equal(JSON.stringify(started.refusal), JSON.stringify(read.refusal));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("MP2 (№2968 rows 1, 2) the rank of unstarted expansion roots: producer before consumer on a chain and a fork, equal ranks by node id; a cycle keeps its outer producer before and outer consumer after; every binding and consumer counts; sleeping flows, other levels and self-references set no order", () => {
  // Row 1: a chain whose ids run against the flow, and a fork; the ready component with the least id goes first.
  assert.deepEqual(mp2Rank(["c-op", "b-op", "a-op"], [{ producer: "c-op", consumers: ["b-op"] }, { producer: "b-op", consumers: ["a-op"] }]), ["c-op", "b-op", "a-op"]);
  assert.deepEqual(mp2Rank(["z-root", "b-leaf", "a-leaf"], [{ producer: "z-root", consumers: ["b-leaf", "a-leaf"] }]), ["z-root", "a-leaf", "b-leaf"]);
  assert.deepEqual(mp2Rank(["m", "k", "q"], []), ["k", "m", "q"], "Without flows: by node id, never by the hash of an assignment");
  // Row 2: a strongly connected pair with an outer producer and an outer consumer keeps both outer dependencies.
  assert.deepEqual(mp2Rank(["y", "p", "x", "q"], [{ producer: "p", consumers: ["y"] }, { producer: "x", consumers: ["y"] },
    { producer: "y", consumers: ["x"] }, { producer: "x", consumers: ["q"] }]), ["p", "x", "y", "q"]);
  // Two bindings of one connector and several consumers of one binding: each counts, not only the first.
  assert.deepEqual(mp2Rank(["a", "b", "c"], [{ id: "one", producer: "c", consumers: ["a"] }, { id: "one", producer: "b", consumers: ["c"] }]), ["b", "c", "a"]);
  assert.deepEqual(mp2Rank(["a", "b", "c"], [{ producer: "c", consumers: ["b", "a"] }]), ["c", "a", "b"]);
  // A sleeping flow, a flow of another level and a self-reference set no order.
  assert.deepEqual(mp2Rank(["a", "b"], [{ producer: "b", consumers: ["a"], anchor: "sleeping" }]), ["a", "b"]);
  assert.deepEqual(mp2Rank(["a", "b"], [{ producer: "b", consumers: ["a"], level: 1 }]), ["a", "b"]);
  assert.deepEqual(mp2Rank(["a", "b"], [{ producer: "b", consumers: ["b"] }]), ["a", "b"]);
  // One node with two batches: by batch, then by assignment.
  const items = [{ id: "z", node: "n", batch: "batch-2", level: 3 as const }, { id: "y", node: "n", batch: "batch-1", level: 3 as const },
    { id: "x", node: "n", batch: "batch-1", level: 3 as const }];
  assert.deepEqual(rankExpansions(items, () => mp2Upper([])), ["x", "y", "z"]);
});

test("MP2 (№2968 row 6) a packet issued before its neighbour finished keeps its set: the run reuses it as it is, with no later neighbour", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const prep = works.find(row => row.node === "garden-prep-operation")!, produce = works.find(row => row.node === "garden-produce-operation")!;
  ok(startRun(f.store, { project }));
  const early: { ref: Ref | null } = { ref: null };
  await mp2Works(f, step => {
    // As soon as the producer's packet is issued, the consumer's root packet is issued too, before the producer finished.
    if (early.ref || step.action !== "cycle" || !step.request.packet) return;
    const saved = f.store.get<QuestionPacketRecord>(step.request.packet.id)!;
    if (saved.value.request.batch !== prep.id) return;
    early.ref = reference(ok(writeQuestionPacket(f.store, { ...saved.value.request, batch: produce.id })).record);
  });
  assert.ok(early.ref, "The consumer's packet was issued early");
  const issued = f.store.get<QuestionPacketRecord>(early.ref.id)!;
  assert.deepEqual(issued.value.briefNeighbors, { contract: "om-brief-neighbors/v1", sources: [] }, "Issued before the producer finished");
  assert.deepEqual(reference(f.store.get(early.ref.id)!), early.ref, "The issued packet is never replaced");
  const sentFor = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.request.batch === produce.id
    && !row.value.request.previous.length && !row.value.request.continuation && !row.value.request.correction);
  assert.equal(sentFor.length, 1, "No second root packet with the later neighbour");
});

// G5.1 return №3867-2 (№3606): the chosen supplements of one proposal are read at the addresses of its own producer ends —
// other choices in the history change neither the result nor the number of records the lookup reads.



test("LP7 rows 14, 24 (run): an answer of some joined fields — part of state included — applies only them; on the new B1 today's routing joins the rest, and its answer completes the subject keys of one full answer", async t => {
  const f = lp6Line(t), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], keys: string[] = [];
  const round = async (ordinal: number, values: Record<string, Json>) => {
    const routes = lp7Routes(f), joined = routes.value.batches.find(batch => batch.task === "input-field" && batch.items.every(item => item.consumers.includes(f.block))
      && new Set(batch.items.map(item => item.field)).size > 1)!;
    const goal = { key: `lp7:${ordinal}`, questions: joined.items.map(item => lp7LineKey(project, item.target, item.field)).sort(), result: lp7Result(project, joined.items[0]!.target, joined.items[0]!.field) };
    const series = ok(openAttempt(f.store, { ...f.address, attempt: ordinal, goal, completion: { routes: reference(routes), batches: [joined.id] } } as never));
    const packet = ok(writeQuestionPacket(f.store, { project, routes: reference(routes), batch: joined.id, environment: f.dispatch.config,
      attempt: { series: reference(series), ordinal }, previous: [] })).record;
    steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: joined.items.filter(item => Object.hasOwn(values, item.field))
      .map(item => ({ target: item.target, field: item.field, basis: item.record, value: values[item.field]! })) }, usage });
    writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    const sent = ok(await runModelCall(f.store, { project, packet: reference(packet), dispatch: f.dispatch, role: "implementer" }));
    const claim = ok(prepareManagedClaim(f.store, { ...f.address, attempt: ordinal, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
    assert.equal(ok(closeAttempt(f.store, { ...f.address, attempt: ordinal, outcome: claim.outcome } as never)).verdict, "progress");
    keys.push(...lp6Close(f, ordinal).outcome.achieved.map(item => item.key));
    return { joined, sent };
  };
  const first = await round(1, { nodes: LP7_VALUES.nodes!, state: { writer: "garden-produce-block" } });
  assert.deepEqual(first.sent.outcome?.unanswered, first.joined.items.filter(item => item.field === "checkKind").map(item => item.gap));
  assert.equal(keys.length, 2, "nodes and the writer of state only");
  const second = await round(2, { state: LP7_VALUES.state!, checkKind: "test" });
  assert.deepEqual([...new Set(second.joined.items.map(item => item.field))].sort(), ["checkKind", "state"], "Row 14: the new B1's route joins the rest");
  assert.deepEqual([keys.length, f.store.get(`om-input:${project}`)!.revision], [5, 3], "The rest adds authority, rollback and checkKind — never the writer again");
  assert.deepEqual(ok(readSeries(f.store, f.address as never)).value.withoutProgress, 0);
});

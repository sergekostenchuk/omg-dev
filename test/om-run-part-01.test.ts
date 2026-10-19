import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeStore, Store, type Revision, type Write } from "../src/storage/store.js";
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
import { runModelCall } from "../src/om/model-call.js";
import { readQuestionPacket, writeQuestionPacket } from "../src/om/question-packet.js";
import { cycleStartOf, readRun, startRun, runId, type RunRecord, type RunWait } from "../src/om/run.js";
import { writeRunBases } from "../src/om/run-bases.js";
// OWN1 (№3719, return of Codex-omg): the owner's answer is above the model's, and a decision packet asks no owner.
import { issueOwnerInvitation, OwnerSessions } from "../src/product/owner-authority.js";
import { writeOwnerResult } from "../src/om/owner-result.js";
// ---- MP2 (№2968): the still unstarted roots of an attempt by the flows of their frame; neighbours of a brief root ----
import { rankExpansions } from "../src/om/run.js";
// ---- LP5 (№3278): after a replaced B1 the old work ends by its own products, the new bases are built, paid assemblies answer again ----
import { COMPLETION_REUSE_KIND, readCompletionCessationAt, type CompletionCessation } from "../src/om/model-call.js";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
import { chosenWakes, WAKE_CHOICE_KIND } from "../src/om/wake-choice.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { readSeries } from "../src/om/series.js";
import { gapLineKey as lp7LineKey, gapLineExpectedResult as lp7Result } from "../src/om/gap-lines.js";
import { project, ok, refusal, runFixture, type Fixture, addressAll, usage, mechanismSeries, blockSeries, actions, ends, driveTo, reasonsOf, stopAnswer, secondRung, decisionCalls, restWithDecisions, until, worksFixture, worksAcceptance, nodeRefusal, driveUntil, gapHeads, addressQuestions, atCommit, sameEnd, LP3_BASE_COMMIT, LP3_PACKET_COMMIT, lp3NativePackets, advanceRun, lp3Need, lp3Order, lp3Blocked, LP3_CONTENTS, LP3_UNPROVED, lp3Hiding, lp3Context, isRefOf, asCycleStart, asRunResult, mp2Upper, mp2Rank, mp2Works, mp2WorkAnswer, twoArtifacts, G62_BASE, lp5ReplaceB1, lp5Pass, g51Pass, LP5_BASE_COMMIT, lp6Line, lp6Close, LP7_VALUES, lp7Routes, AT1_BASE } from "./om-run-fixture.js";


test("H1.2 R10a a second store ending the pass between the builder's derivation and its first write: the lost write reads the pass again and builds no base", async t => {
  const f = runFixture(t);
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
  const { f, request } = await secondRung(t);
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
  const f = runFixture(t, ["encoding"], true, false, false, true);
  assert.equal(f.store.get(`om-input:${project}`), null, "No OM record exists");
  const built = ok(writeRunBases(f.store, { project }));
  f.steps([addressAll(f, built.bases.routes)]);
  const request = f.request();
  const cycling = await until(f, request, "cycle", 10);
  assert.deepEqual(actions(f.store), ["open-series", "open", "packet"], "M5 is the first work; nobody issued any bases");
  assert.ok(ok(await advanceRun(f.store, request)).performed?.action === "cycle" && cycling);
  assert.equal(f.sent().length, 1, "The first paid model step");
  // A pass whose bases were never built: its first step is its own saved build, before any series or attempt.
  const g = runFixture(t, ["encoding"]);
  ok(startRun(g.store, { project }));
  assert.equal(g.store.list("horizon").length, 0);
  const first = ok(await advanceRun(g.store, g.request())).record.value.state;
  assert.equal(first.phase === "step" && first.step.action, "bases");
  assert.equal(g.store.list("repair-series").length, 0);
  assert.equal(ok(await advanceRun(g.store, g.request())).performed?.action, "bases");
  assert.equal(g.store.list("om-horizon").length, 1, "One issue of the launch intent");
});

test("13 H1 technical outcomes are closed by G7 with their proved reason; the next attempt opens only after the previous one is closed", async t => {
  const f = runFixture(t, ["encoding"]);
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
  const f = runFixture(t, [], false);
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
  for (const [kind, later] of [["environment-confirmation", "task-start"], ["post-implementation-proof", "task-result"]] as const) {
    const blocking = runFixture(t, ["proof"]);
    addressQuestions(blocking, [["proof", kind]]);
    ok(startRun(blocking.store, { project }));
    const ended = await ends(blocking, blocking.request(), 12);
    assert.deepEqual(reasonsOf(ended.state).map(row => [row.kind, row.code, row.target, row.field]), [["unsupported-question", "route_result_unsupported", "discovery:proof", "answer"]], kind);
    assert.equal(blocking.sent().length, 0, kind);
    const deferred = runFixture(t, ["proof"], true, false, false, false, { proof: { moment: later } });
    addressQuestions(deferred, [["proof", kind]]);
    ok(startRun(deferred.store, { project }));
    const idle = await ends(deferred, deferred.request(), 12);
    assert.equal(idle.state.phase, "waiting", `${kind}: ${JSON.stringify(idle.state)}`);
    assert.equal((idle.state as unknown as { wait: RunWait }).wait.code, "run_idle", `${kind}: nothing to do is a wait for new bases, not the end of the pass`);
    assert.equal(deferred.sent().length, 0, kind);
    assert.equal(deferred.store.list("repair-series").length, 0, kind);
  }
});
test("OWN1 №3719 P2-1 an owner's H2 answer of a question the bypass gives the model is its decision: the model is never asked, B1 holds the owner's value, om-decisions names the owner", async t => {
  const f = runFixture(t, ["spare"]);
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

// OBL1 (№3773): a brief continuation fits what its reads brought; the continuation the capacity cannot hold stays the end of
// the packet era before the brief — the old packet producer issues these roots.
test("LP3 (№2817 rows 3, 4, №52) a continuation the capacity cannot hold ends its cycle blocked and is never sent: the pass closes each attempt through G7, goes up the ladder and ends by A6 — never waiting on the blocked packet; the start of the root's cycle is chosen by its links in both positions of root and continuation", async t => {
  const f = lp3NativePackets(t, runFixture(t, ["encoding"], undefined, undefined, undefined, undefined, undefined, LP3_PACKET_COMMIT));
  const b = f.bases("lp3-52"), request = f.request(b);
  writeFileSync(join(f.root, "repo", "big.txt"), LP3_CONTENTS["root-first"]);
  const need = lp3Need(f, b.routes, [{ action: "read", path: "big.txt", media: "text/plain" }]);
  f.steps([need, need, need, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
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
  lp3Blocked(f, 4);
  const roots = f.store.list<QuestionPacketRecord>("question-packet").filter(row => !row.value.request.continuation).map(reference);
  const two = cycleStartOf(f.store, project, roots.slice(0, 2));
  assert.ok(!two.ok && two.refusal.code === "run_record_invalid", "Two starts are an addressed refusal, never a second dispatch");
  await sameEnd(f, request, 4);
});

test("LP3 (№2870, №2817 row 9) a packet whose record cannot be read is never taken for a continuation: a saved cycle of it is performed as saved and its producer's record_missing stands as the pass's wait — no ready, no new packet, nothing sent; once the record is read again the same saved cycle goes on", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  const f = lp3NativePackets(t, runFixture(t, ["encoding"], undefined, undefined, undefined, undefined, undefined, LP3_PACKET_COMMIT));
  const b = f.bases("lp3-2870"), request = f.request(b);
  f.steps([lp3Need(f, b.routes, [{ action: "search", within: lp3Context(f), query: "encoding" }])]);
  ok(startRun(f.store, { project }));
  // The selection: ready after the packet step, the root's packet unreadable — the pass's addressed refusal, nothing written,
  // never a second packet.
  let head = ok(readRun(f.store, { project }))!;
  for (let index = 0; index < 20 && !(head.value.state.phase === "ready" && head.value.last?.step.action === "packet"); index++)
    head = ok(await advanceRun(f.store, request)).record;
  assert.equal(head.value.last?.step.action, "packet");
  const packet = head.value.last!.products.find(ref => ref.id.startsWith(`om-question-packet:${project}:`))!;
  const chosen = await advanceRun(lp3Hiding(f.store, packet.id), request);
  assert.deepEqual(chosen.ok ? chosen.value.record.value.state : [chosen.refusal.code, chosen.refusal.at.target], ["record_missing", packet.id]);
  assert.equal(ok(readRun(f.store, { project }))!.revision, head.revision, "Nothing was written");
  // The saved step: the root's cycle chosen, then its packet unreadable — performed as saved, its refusal stands.
  const step = await until(f, request, "cycle");
  assert.ok(isRefOf(step.request, packet), "The saved cycle is the root's own");
  const before = ok(readRun(f.store, { project }))!.revision;
  const performed = ok(await advanceRun(lp3Hiding(f.store, packet.id), request));
  const state = performed.record.value.state;
  assert.notEqual(state.phase, "ready", JSON.stringify(state));
  assert.deepEqual([performed.record.revision, performed.performed?.action, performed.record.value.last?.refusal?.code, f.sent().length],
    [before + 1, "cycle", "record_missing", 0], "The cycle was performed as saved and refused by its producer; nothing was sent");
  assert.deepEqual(f.store.list("om-model-cycle"), []);
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed?.action, f.sent().length], ["cycle", 1], "The same saved cycle goes on once its packet is read");
  assert.equal(f.store.list<{ terminal: string }>("om-model-cycle")[0]!.value.terminal, "reads-invalid");
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

test("LP3 (№2817 п.4, п.7) the base d519a60 in its own process leaves the pass waiting on №52 and №53; the new code reopens it and finishes the saved work by an ordinary transition without paying the saved call again, the old revisions and records untouched", async t => {
  for (const kase of ["52", "53"] as const) await t.test(kase, async t => {
    // OBL1 (№3773): the next attempts keep the packet era of the base too — a brief continuation would fit what №52 read.
    const f = lp3NativePackets(t, runFixture(t, ["encoding"], undefined, undefined, undefined, undefined, undefined, LP3_PACKET_COMMIT));
    const b = f.bases(`lp3-era-${kase}`), request = f.request(b);
    writeFileSync(join(f.root, "repo", "big.txt"), LP3_CONTENTS["root-first"]);
    const need = lp3Need(f, b.routes, kase === "52" ? [{ action: "read", path: "big.txt", media: "text/plain" }]
      : [{ action: "search", within: lp3Context(f), query: "encoding" }]);
    f.steps([need, need, need, stopAnswer(f, false)]);
    const stuck = atCommit(f, LP3_BASE_COMMIT, `lp3-era-${kase}`, `const { advanceRun, startRun } = await import(src('om/run.js'));
take(startRun(store, { project: args.project }));
const seen = [];
for (let index = 0; index < 30; index++) {
  const advanced = take(await advanceRun(store, args.request));
  const state = advanced.record.value.state;
  seen.push(state.phase === 'waiting' ? 'waiting:' + state.wait.code : state.phase);
  if (state.phase === 'waiting' && seen.at(-2) === seen.at(-1)) break;
}
out(seen);`, { request, project }) as string[];
    assert.match(stuck.at(-1)!, /^waiting:/, `The base code stands on a wait: ${stuck.join(",")}`);
    assert.equal(f.sent().length, 1, "The base code paid once");
    f.restart();
    const before = f.store.list().map(reference);
    const end = await ends(f, request, 60);
    assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
    assert.equal(f.sent().length, 4, "The saved call is not paid again: only the next attempts and the review are sent");
    for (const ref of before) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref, `${ref.id}@${ref.revision} stands as the base code wrote it`);
    const terminals = f.store.list<{ terminal: string }>("om-model-cycle").map(row => row.value.terminal);
    assert.ok(terminals.length === 3 && terminals.every(terminal => terminal === (kase === "52" ? "blocked" : "reads-invalid")), terminals.join(","));
    await sameEnd(f, request, 4);
  });
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
test("G5.1 return №3867-2 the supplements of one proposal are found by their addresses: a growing history of other choices reads no more records", async t => {
  const { f, results } = await g51Pass(t, allowed => allowed[1]!);
  const proposal = results()[0]!.value.proposal;
  const measured = () => {
    let rows = 0, lists = 0;
    const previous = observeStore({ begin: () => ({}), end: (_token, _store, method, _mode, _id, _revision, found) => {
      rows += found.length; if (method === "list") lists++; }, write: () => undefined, untraced: () => undefined });
    try { return { value: ok(chosenWakes(f.store, project, proposal)), rows, lists }; } finally { observeStore(previous); }
  };
  const before = measured();
  assert.equal(before.value.length, 1);
  assert.equal(before.lists, 0, "No list of a whole kind");
  f.store.writeMany(Array.from({ length: 300 }, (_, index) => ({ id: `${WAKE_CHOICE_KIND}:${project}:other-${index}:1`, kind: WAKE_CHOICE_KIND,
    expected: 0, value: { project, proposal: { ...proposal, id: `${proposal.id}-other-${index}` }, verdict: "chosen", choice: "t" } })));
  const after = measured();
  assert.deepEqual(after.value, before.value);
  assert.equal(after.rows, before.rows, "300 other results read nothing more");
});
test("LP5 (№3278 §4, rows 13, 21) era: febbee2c, run from Git in its own process on the B1 replaced under its open works attempt, ends the unsent root by LP4 and stands on input_stale; the new code reads its records as they are and continues that very open work — the check ceased, the attempt closed, the new bases built, the paid root answered by its reuse", async t => {
  const f = worksFixture(t, undefined, undefined, undefined, LP5_BASE_COMMIT);
  const produce = () => blockSeries(f as unknown as Fixture, "garden-produce-block");
  ok(startRun(f.store, { project }));
  // G5 (№3820): the open works attempt is the base's own — its packet issued and its paid root cycled by febbee2c — since
  // the base reads no works packet of a later era (the wake-test form); today's code then reads them all as they are.
  const issued = atCommit(f, LP5_BASE_COMMIT, "lp5-base-issue", `const { advanceRun } = await import(src('om/run.js'));
for (let index = 0; index < 40; index++) {
  const state = take(await advanceRun(store, args.request)).record.value.state;
  if (state.phase === 'step' && state.step.action === 'cycle') { out(state.step.request.packet); break; }
  if (state.phase === 'waiting') { out(null); break; }
}`, { request: f.request }) as Ref | null;
  assert.ok(issued, "The base issues the works packet of the open attempt");
  writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps: [{ research: mp2WorkAnswer(f, issued).research, usage }] }));
  const cycled = atCommit(f, LP5_BASE_COMMIT, "lp5-base-cycle", `const { advanceRun } = await import(src('om/run.js'));
out(take(await advanceRun(store, args.request)).performed?.action ?? null);`, { request: f.request });
  assert.equal(cycled, "cycle", "The base pays the root's answer");
  f.restart();
  lp5ReplaceB1(f);
  const stood = atCommit(f, LP5_BASE_COMMIT, "lp5-base", `const { advanceRun } = await import(src('om/run.js'));
const trail = [];
for (let index = 0; index < 20; index++) {
  const advanced = take(await advanceRun(store, args.request)), state = advanced.record.value.state;
  trail.push(state.phase === 'waiting' ? 'waiting:' + state.wait.code + ':' + state.wait.target : state.phase + ':' + (advanced.performed?.action ?? ''));
  if (state.phase === 'waiting') break;
}
out(trail);`, { request: f.request }) as string[];
  assert.equal(stood.at(-1), `waiting:input_stale:om-input:${project}`, `The base stands on the replaced B1: ${stood.join(",")}`);
  f.restart();
  const ceased = f.store.list<CompletionCessation>("om-completion-cessation");
  assert.deepEqual(ceased.map(row => [row.value.disposition, row.value.cause.kind]), [["branch-ceased", "required-record-replaced"]], "The base ended the unsent root by LP4");
  assert.deepEqual(ok(readCompletionCessationAt(f.store, project, reference(ceased[0]!))), ceased[0], "Its record reads as it is");
  const trail = await lp5Pass(f, () => produce()?.value.attempts[1]?.outcome ? "stop" : undefined);
  assert.ok(trail.some(row => row.endsWith(">cease-check#1")) && trail.some(row => row.endsWith(">reuse#2")), trail.join(","));
  assert.deepEqual(produce().value.attempts.map(row => row.outcome?.reason), ["interrupted", "result"]);
  assert.equal(f.store.list(COMPLETION_REUSE_KIND).length, 1);
});

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
test("AT1 return №4124 P2-6: a group refused by a G5 of the earlier era ends under the new code by its rejection as before — no readiness question, no refusal of the era, and the new candidate is accepted", async t => {
  const f = worksFixture(t, false, false, twoArtifacts, G62_BASE);
  ok(startRun(f.store, { project }));
  // As in G6.2: the code before G6 (a62940ec) answers the works, the producing one for two artifacts (its E3 admits it).
  for (let round = 0; round < 4; round++) {
    const issued = atCommit(f, G62_BASE, `p26-issue-${round}`, `const { advanceRun } = await import(src('om/run.js'));
for (let index = 0; index < 40; index++) {
  const state = take(await advanceRun(store, args.request)).record.value.state;
  if (state.phase === 'step' && state.step.action === 'cycle') { out(state.step.request.packet); break; }
  if (state.phase === 'waiting') { out(null); break; }
}`, { request: f.request }) as Ref | null;
    assert.ok(issued, "The earlier code issues a works packet");
    const answer = mp2WorkAnswer(f, issued), node = answer.research.proposal.nodes[0]!.parent!;
    f.push({ research: answer.research, usage });
    assert.equal(atCommit(f, G62_BASE, `p26-cycle-${round}`, `const { advanceRun } = await import(src('om/run.js'));
out(take(await advanceRun(store, args.request)).performed?.action ?? null);`, { request: f.request }), "cycle");
    if (node === "garden-produce-operation") break;
  }
  // The code before AT1 (e475bd59) goes on to its works step: its G5 of the earlier era refuses the group.
  let works = false;
  for (let round = 0; round < 16 && !works; round++) {
    const result = atCommit(f, AT1_BASE, `p26-${round}`, `const { advanceRun } = await import(src('om/run.js'));
let result = null;
for (let index = 0; index < 80 && result === null; index++) {
  const advanced = take(await advanceRun(store, args.request));
  const state = advanced.record.value.state;
  if (advanced.performed && advanced.performed.action === 'works') result = { works: true };
  else if (state.phase === 'step' && state.step.action === 'cycle') result = { packet: state.step.request.packet };
  else if (state.phase === 'waiting' || state.phase === 'unable' || state.phase === 'complete') result = { state };
}
out(result);`, { request: f.request }) as { works?: true; packet?: Ref; state?: unknown } | null;
    assert.ok(result && !result.state, `The base reaches its works step: ${JSON.stringify(result).slice(0, 800)}`);
    if (result.works) works = true; else f.answer(result.packet!);
  }
  assert.ok(works, "The base performed its works step");
  f.restart();
  const before = f.store.list<{ contract: string; result: { passed: boolean } }>("om-atomic-gate");
  assert.ok(before.length > 0 && before.every(row => row.value.contract === "om-atomic-gate/v1" && !row.value.result.passed), "The base refused the group by its G5 of the earlier era");
  const trail: string[] = [], answered = new Set<string>();
  for (let index = 0; index < 300 && !worksAcceptance(f.store).frame; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string }; step?: { action: string; request: { packet?: Ref } } };
    trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    if (state.phase === "waiting" || state.phase === "unable") break;
    if (state.phase !== "step" || state.step!.action !== "cycle" || !state.step!.request.packet || answered.has(state.step!.request.packet.id)) continue;
    const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
    answered.add(saved.id);
    const answer = mp2WorkAnswer(f, saved), node = answer.research.proposal.nodes[0]!.parent!;
    const example = (packet.value.packet as unknown as { brief: { examples: { action: string; proposal: unknown }[] } }).brief.examples.find(row => row.action === "answer")!;
    f.push({ research: node === "garden-produce-operation" ? { ...answer.research, proposal: example.proposal } : answer.research, usage });
  }
  const text = trail.join(",");
  assert.ok(!text.includes("waiting:") && !text.includes("readiness"), `No wait and no readiness question: ${text}`);
  const ends = f.store.list<{ cause: { kind: string } }>("om-completion-finalization").map(row => row.value.cause.kind);
  assert.ok(ends.length >= 1 && ends.every(kind => kind === "group-rejected"), `The group ends by its rejection as before: ${JSON.stringify(ends)} ${text}`);
  assert.deepEqual([worksAcceptance(f.store).passed, worksAcceptance(f.store).frame], [true, true], `The new candidate is accepted: ${text.slice(-600)}`);
});

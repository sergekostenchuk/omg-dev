import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { type Refusal } from "../src/om/refusal.js";
import type { Graph } from "../src/graph/model.js";
import { runIntegrityCheck } from "../src/om/integrity.js";
import { git } from "../src/runtime/environment.js";
import { Evidence } from "../src/evidence/evidence.js";
import type { OmInputRecord } from "../src/om/input.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { WORKS_BRIEF_PACKET_CONTRACT } from "../src/om/packet-brief.js";
import { prepareFrameProposals, type ProposalRequest } from "../src/om/frame-proposals.js";
import { openSeries, beginAttempt } from "../src/om/series.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { type RoutesRecord } from "../src/om/routes.js";
import type { RepairSeries } from "../src/om/series.js";
import { readRun, startRun, runId, type RunRequest, type RunStep } from "../src/om/run.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
import { regateRun } from "../src/om/run.js";
import { currentL3Reopen, l3ReopenId, readFrameProposals } from "../src/om/frame-proposals.js";
import { resolveSnapshot } from "../src/om/impact.js";
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { project, adapterFixture, ok, refusal, runFixture, type Fixture, addressAll, usage, blockSeries, actions, actionsSteps, ends, stopAnswer, secondRung, until, RacingStore, loadOperations, gardenPass, regatePolicy, worksFixture, worksAcceptance, factWorksPass, driveUntil, gapHeads, atCommit, sameEnd, twoOwnerAnswers, advanceRun, lp3Need, lp3Context, LP4_COMMITS, lp4Sent, lp4Close, policyDoor } from "./om-run-fixture.js";

test("26 1 C07 R4 H1.1 the pass runs the project mechanism M5 through G7, then builds the bases of the new B1 itself and goes on; a restart repeats nothing", async t => {
  const f = runFixture(t, undefined, "executed");
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  const started = ok(startRun(f.store, { project }));
  assert.deepEqual(started.value.input, reference(f.store.get(`om-input:${project}`)!));
  // The fact of the addressed questions is the next block work: the pass reaches it without any issued bases.
  let working: RunStep | null = null;
  for (let index = 0; index < 20 && !working; index++) {
    const state = ok(await advanceRun(f.store, request)).record.value.state;
    if (state.phase === "waiting") assert.fail(JSON.stringify(state.wait));
    if (state.phase === "step" && state.step.action === "open-series" && (state.step.request as { block?: string }).block) working = state.step as unknown as RunStep;
  }
  assert.ok(working, "The pass chose the block's own work");
  assert.deepEqual(actions(f.store), ["open-series", "open", "packet", "cycle", "close", "bases"]);
  const series = f.store.list<RepairSeries>("repair-series").find(row => row.id.includes(":mechanism:"))!;
  const outcome = series.value.attempts[0]!.outcome!;
  assert.equal(outcome.reason, "result");
  assert.equal(outcome.achieved.length, 2);
  // The saved build names the new B1 of D3; its horizon is a new issue of the same intent over that B1.
  const input = f.store.get(`om-input:${project}`)!;
  assert.equal(input.revision, started.value.input.revision + 1, "D3 of M5 made the new B1");
  const built = ok(prepareRunBases(f.store, { project }));
  assert.equal(built.state, "ready");
  if (built.state !== "ready") return;
  assert.deepEqual(built.built.input, reference(input));
  assert.notDeepEqual(built.built.bases.horizon, b.horizon);
  assert.deepEqual((working.request as { block?: string }).block, "garden-consume-block");
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  // The saved step goes on after the restart; neither M5 nor the build is paid or written again.
  const again = ok(await advanceRun(f.store, { ...request, dispatch: { ...request.dispatch } }));
  assert.deepEqual(again.performed, working);
  assert.equal(f.sent().length, sends);
  assert.equal(actions(f.store).filter(action => action === "bases").length, 1);
  assert.ok(f.store.list().map(reference).length > before.length);
  assert.deepEqual(ok(startRun(f.store, { project })).value.input, started.value.input, "A repeated start reads the one pass");
});

test("H1.2 R11 C11 an end derived on bases that another store lawfully renews before the write is not saved: the next choice starts from the new B1", async t => {
  const { f, request } = await secondRung(t, "executed");
  let raced = false;
  class Renewing extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "unable")) {
        raced = true;
        const other = new Store(f.database);
        try {
          // The owner addresses the open question to the block: a lawful new B1 while the end was being derived.
          const input = other.get<OmInputRecord>(`om-input:${project}`)!;
          ok(writeAddressing(other, { project, input: reference(input), graph: f.graph, decisions: [{ pending: structuredClone(inputDecisionWrite({
            project, input: reference(input), graph: f.graph, layers: [], decision: { target: "discovery:encoding", field: "address",
              value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Renewing(path));
  const sends = f.sent().length;
  const lost = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(lost).code, "input_stale", "The B1 moved under the derivation: the stale end is not saved");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready");
  f.restart();
  const next = ok(await advanceRun(f.store, request)).record.value.state;
  assert.equal(next.phase === "step" && next.step.action, "bases", "The next choice builds the bases of the renewed B1 before any end");
  assert.equal(f.sent().length, sends);
});

test("C01 №1852 H1 one pass per project: a repeated start reads it, equal concurrent creations converge to one winner, and the record is B1-born", async t => {
  const f = runFixture(t, undefined, "executed");
  const racing = new RacingStore(f.database);
  t.after(() => racing.close());
  racing.target = runId(project); racing.remaining = 1;
  racing.run = other => { ok(startRun(other, { project })); };
  // №1852-2: the losing creation reads the winner again; an equal intent converges to it without a second record.
  const lost = ok(startRun(racing, { project }));
  const again = ok(startRun(racing, { project }));
  assert.deepEqual(lost, again);
  assert.equal(again.revision, 1);
  assert.deepEqual(again.value.input, reference(f.store.get(`om-input:${project}`)!));
  // G7 moved B1 provenance from the hot era read to om-fsck, including incomplete run records.
  const other = new Store(join(f.root, "orphan.sqlite"));
  t.after(() => other.close());
  other.write({ id: runId(project), kind: "om-run", expected: 0, value: { contract: "om-run/v1" } });
  assert.deepEqual(ok(runIntegrityCheck(other, { project })).value.findings, [{
    code: "record_missing", id: `om-input:${project}`, revision: 1, field: "revision", ref: null,
    message: "OM provenance requires the exact first B1 input",
  }]);
});

test("H1.2 R12 R10a 27 25 7 C61 C28 H1 end to end: the pass works L3 through MC2, G4b and one bound works acceptance, then M8 (not ready, then fixed), M9 and the existing compiler; no base is built for the completed pass", async t => {
  const f = (await loadOperations()).acceptedOperationsFixture(t, "planned", 0);
  const { store, project: name, workspace, desired } = f;
  assert.equal(name, project);
  // The pass's own works bases over the accepted operations (H1.1), for the launch intent of the garden result.
  const built = ok(writeRunBases(store, { project, outcomes: ["garden-result"] }));
  const routes = store.get<RoutesRecord>(built.bases.routes.id, built.bases.routes.revision)!;
  assert.ok(routes.value.batches.some(batch => batch.level === 3 && batch.task === "node-expansion"));
  const scenario = join(f.root, "scenario.json"), trace = join(f.root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = f.engine.environments.configure(project, { workspace,
    implementer: { actor: "h1-works-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "h1-works-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 }, 0);
  writeFileSync(join(workspace, "input.txt"), "A captured external input");
  // The external input of the works; G5 finds exactly this Source through the candidate's own task derivation (№1860 п.7).
  new Evidence(store).file(project, "garden-data", workspace, "input.txt", "text/plain", 0);
  git(workspace, ["add", "input.txt"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "capture input"]);
  const adapter = store.write({ id: `adapter:${project}:h1`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const request: RunRequest = { project, dispatch: { adapter: reference(adapter), config: reference(environment) } };
  ok(startRun(store, { project }));
  // The pass chooses and saves the paid cycle first; its answer is written for the exact saved packet.
  const cycling = await until({ store } as unknown as Fixture, request, "cycle");
  const packet = store.get<QuestionPacketRecord>((cycling.request as unknown as { packet: Ref }).packet.id)!;
  const payload = packet.value.packet as unknown as { expansion: { assigned: string[]; obligations: { id: string; kind: string; upper: { port?: string } }[] } };
  const work = structuredClone(desired.nodes.find(node => node.id === "garden-consume-work")!);
  const body = { nodes: [work], tests: structuredClone(desired.tests.filter(proof => work.tests.includes(proof.id))),
    fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id)).map(item => ({ obligation: item.id, node: work.id,
      ...(item.kind === "connection-end" ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
    removes: [], replaces: [], redefines: [] };
  writeFileSync(scenario, JSON.stringify({ database: f.database, steps: [{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", proposal: body, bindings: [] }, usage }] }));
  const performed: string[] = [];
  let phase = "", dirty = false;
  const readme = join(workspace, "README.md"), original = readFileSync(readme);
  for (let index = 0; index < 40 && phase !== "complete"; index++) {
    const advanced = ok(await advanceRun(store, request));
    if (advanced.performed) performed.push(advanced.performed.action);
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string }; wait?: { code: string } };
    phase = state.phase;
    // №1766 п.2: the repository becomes dirty before the first M8; M8 lawfully finds it not ready.
    if (state.phase === "step" && state.step!.action === "feasibility" && !dirty) { dirty = true; writeFileSync(readme, "An unrecorded local edit\n"); }
    if (state.phase === "waiting") {
      assert.equal(state.wait!.code, "feasibility_not_ready", JSON.stringify(state.wait));
      const saved = store.get(`om-feasibility:${project}`)!;
      assert.equal((saved.value as { ready: boolean }).ready, false);
      // The unchanged finding stands: no new M8 record and no write of the pass.
      const before = store.list().map(reference);
      assert.equal(ok(await advanceRun(store, request)).performed, null);
      assert.deepEqual(store.list().map(reference), before);
      // Fixing the named ground admits a new M8 step on the saved revision.
      writeFileSync(readme, original);
    }
  }
  assert.deepEqual(performed, ["cycle", "evaluate", "works", "bases", "confirm", "close", "feasibility", "feasibility", "handoff", "compile"],
    "One bound works acceptance, the machine bases over it for the D2 event of the original goal and G7; M8 again after its finding is fixed; then M9 and the compiler");
  // №1860 п.7: the works acceptance names exactly the external Source its candidate's own task derivation needs.
  const works = actionsSteps(store).find(row => row.action === "works")!.request as unknown as { works: { sources: Ref[] } };
  assert.deepEqual(works.works.sources, [reference(store.get(`source:${project}:garden-data`)!)]);
  assert.equal(store.get(`om-feasibility:${project}`)!.revision, 2);
  assert.equal((store.get(`om-feasibility:${project}`)!.value as { ready: boolean }).ready, true);
  assert.deepEqual(actions(store), ["open-series", "open", "register", "lines", "obligations", "packet", ...performed],
    "D2 and D7 of the exact scope precede the works packet; the check is registered before them");
  assert.equal(phase, "complete");
  const series = blockSeries(f as unknown as Fixture);
  assert.equal(series.value.attempts[0]!.outcome!.reason, "result");
  assert.ok(series.value.attempts[0]!.outcome!.achieved.length > 0, "G7 confirmed the achievement from the D2 event and the own C5");
  const frame = store.get(`om-frame:${project}:3`)!;
  assert.deepEqual((frame.value as { acceptance: { binding: { ordinal: number } } }).acceptance.binding.ordinal, 1, "The works acceptance is bound to the attempt");
  assert.equal(store.get<{ status: string }>(`stage:${project}:compilation`)!.value.status, "accepted");
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 1, "One paid call made the whole works");
  // A completed pass returns its proved completion and starts nothing.
  const before = store.list().map(reference);
  const again = ok(await advanceRun(store, request));
  assert.equal(again.performed, null);
  assert.deepEqual(store.list().map(reference), before);
  // R10a: the same saved end is refused to the direct entries of the builder, with the phase named.
  for (const refused of [refusal(prepareRunBases(store, { project })), refusal(writeRunBases(store, { project }))]) {
    assert.equal(refused.code, "run_bases_terminal");
    assert.match(refused.message, /complete/);
  }
  assert.deepEqual(store.list().map(reference), before);
});
test("RL3 rows 1–9: om-regate refuses an unfinished pass and writes nothing when the door passes; a work the door finds on the current snapshot is reopened in one guarded transaction — a repeat is that record, a head a second Store moved refuses it whole; the ordinary machine designs the work anew on the same line and goal to a new completion; the D1 of the earlier era reads as written and a forged reopening is refused", async t => {
  const g = await gardenPass(t), { f, store, workspace, desired, built, adapter, commit, respond, drive, cycle } = g;
  let environment = store.get(`environment:${project}`)!;
  // Row 1: an unfinished pass is refused at its phase, and nothing is written.
  let before = store.list().map(reference);
  const early = refusal(regateRun(store, { project }));
  assert.deepEqual([early.code, early.at.field], ["record_missing", "state.phase"]);
  assert.match(early.message, /ready/);
  assert.deepEqual(store.list().map(reference), before);
  const first = structuredClone(desired.nodes.find(node => node.id === "garden-consume-work")!);
  await drive(cycle);
  respond((ok(readRun(store, { project }))!.value.state as { step: RunStep }).step, first, []);
  await drive(state => state.phase === "complete");
  const completed = ok(readRun(store, { project }))!, frame1 = reference(store.get(`om-frame:${project}:3`)!);
  // The last D1 the pass saved, read before any reopening: the era row 9 holds it to.
  const works1 = store.get<RoutesRecord>(built.bases.routes.id)!.value.request.gaps.sources.works as unknown as ProposalRequest;
  const read1 = ok(readFrameProposals(store, works1));
  const accepted = store.get<Graph>(`graph:${project}`)!.value.nodes.find(node => node.id === "garden-consume-work")!;
  // Row 2: the door passes on the accepted L3 — the answer names the snapshot, and nothing is written.
  before = store.list().map(reference);
  const passing = ok(regateRun(store, { project }));
  assert.deepEqual([passing.state, passing.findings, passing.reopen, passing.frame], ["passed", [], null, frame1]);
  assert.deepEqual(passing.snapshot, resolveSnapshot(workspace));
  assert.deepEqual(store.list().map(reference), before, "A door that passes writes nothing");
  // The snapshot gains the work's file and a test that reaches it: the work's impact no longer covers that test.
  commit("a test reaches the consumed result", { "consume.txt": "consumed\n", "regate.test.mjs": "import \"./consume.txt\";\n" });
  // Row 5: a head the door read moved by a second Store between the reading and the write refuses the transaction whole.
  let raced = false;
  class Moving extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-l3-reopen")) {
        raced = true;
        const other = new Store(f.database);
        try { const head = other.get(`environment:${project}`)!; other.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value }); }
        finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  const moving = new Moving(f.database);
  try {
    const lost = refusal(regateRun(moving, { project }));
    assert.ok(raced);
    assert.deepEqual([lost.code, lost.at.target], ["input_stale", `environment:${project}`]);
  } finally { moving.close(); }
  assert.equal(store.get(l3ReopenId(project)), null, "Nothing of the lost transaction is written");
  assert.deepEqual(ok(readRun(store, { project })), completed);
  environment = store.get(`environment:${project}`)!;
  g.request = { project, dispatch: { adapter: reference(adapter), config: reference(environment) } };
  // Row 3: one guarded transaction — the record of the reopened work and the transition of the pass out of complete.
  before = store.list().map(reference);
  const reopened = ok(regateRun(store, { project })), reopen = reopened.reopen!;
  assert.equal(reopened.state, "reopened");
  assert.deepEqual(reopened.findings.map(row => [row.code, row.target, row.field]), [["work_impact_undecided", "garden-consume-work", "regate.test.mjs"]]);
  assert.deepEqual(reopen.value.works, [{ work: "garden-consume-work", definition: hashJson(accepted as unknown as Json) }]);
  assert.deepEqual([reopen.value.run, reopen.value.frame, reopen.value.snapshot, reopen.value.decision],
    [reference(completed), frame1, resolveSnapshot(workspace), { actor: "owner", command: "om-regate" }]);
  assert.deepEqual([reopen.value.input, reopen.value.environment], [reference(store.get(`om-input:${project}`)!), reference(environment)]);
  assert.deepEqual(reopened.run.value.state, { phase: "regated", from: reference(completed), reopen: reference(reopen) });
  const moved = store.list().map(reference).filter(ref => !before.some(old => canonical(old) === canonical(ref)));
  assert.deepEqual(moved.map(ref => ref.id).sort(), [l3ReopenId(project), runId(project)].sort(), "Exactly the record and the pass are written");
  // Row 4: a repeat is that record; nothing is written.
  before = store.list().map(reference);
  assert.deepEqual(reference(ok(regateRun(store, { project })).reopen!), reference(reopen));
  assert.deepEqual(store.list().map(reference), before);
  // Row 9: a D1 the pass saved before the reopening reads exactly as it did.
  assert.deepEqual(ok(readFrameProposals(store, works1)), read1);
  // Row 6: the regated pass goes on as from ready — new bases over the record, and new work of the same line and goal: the
  // goal its first attempt achieved before the reopening is not achieved for the reopened work.
  // The record is a root the machine derivation reads: the bases chosen after it name it, so they are a new step, never a
  // repeat without effect.
  const chosen = ok(await advanceRun(store, g.request)).record.value.state as { step: RunStep };
  assert.equal(chosen.step.action, "bases");
  assert.ok((chosen.step.request as unknown as { basis: Ref[] }).basis.some(ref => canonical(ref) === canonical(reference(reopen))));
  const toCycle = await drive(cycle);
  assert.deepEqual(toCycle, ["bases", "open", "register", "lines", "obligations", "packet"]);
  const packet2 = ((ok(readRun(store, { project }))!.value.state as { step: RunStep }).step.request as unknown as { packet: Ref }).packet;
  const routes2 = store.get<QuestionPacketRecord>(packet2.id, packet2.revision)!.value.request.routes;
  const works2 = store.get<RoutesRecord>(routes2.id, routes2.revision)!.value.request.gaps.sources.works as unknown as ProposalRequest;
  const named = (works2.frame as unknown as { reopen: { record: Ref; works: string[] } }).reopen;
  assert.deepEqual([works2.frame.frame, named], [frame1, { record: reference(reopen), works: ["garden-consume-work"] }],
    "The new D1 stands on the accepted frame and names the record");
  const filledBy = (store.get(frame1.id, frame1.revision)!.value as { fills: { obligation: string; node: string; source: string }[] }).fills
    .filter(row => row.node === "garden-consume-work" && row.source === "accepted").map(row => row.obligation).sort();
  assert.ok(filledBy.length > 0);
  assert.deepEqual(ok(readFrameProposals(store, works2)).result.open.map(item => item.id).sort(), filledBy, "Exactly the reopened work's fills open");
  // The same frame named without the record derives as before it; today's preparation of it stands on the record and guards it.
  const naming = (reopenValue: unknown): ProposalRequest => {
    const { reopen: _named, ...frame } = works2.frame as unknown as Record<string, unknown>;
    return { ...works2, frame: (reopenValue === undefined ? frame : { ...frame, reopen: reopenValue }) as unknown as ProposalRequest["frame"] };
  };
  assert.deepEqual(ok(readFrameProposals(store, naming(undefined))).result.open, []);
  const current = ok(prepareFrameProposals(store, naming(undefined)));
  assert.deepEqual((current.frame.request as unknown as { reopen: unknown }).reopen, named);
  assert.ok(current.guards.some(ref => canonical(ref) === canonical(reference(reopen))));
  assert.deepEqual(current.result.open.map(item => item.id).sort(), filledBy);
  // A request naming other works, a forged record or one the frame does not stand on today is refused.
  assert.equal(refusal(readFrameProposals(store, naming({ ...named, works: ["garden-produce-work"] }))).code, "proposal_invalid");
  assert.equal(readFrameProposals(store, naming({ ...named, record: { ...named.record, hash: "0".repeat(64) } })).ok, false);
  assert.equal(refusal(prepareFrameProposals(store, naming({ ...named, works: ["garden-produce-work"] }))).code, "input_stale");
  const series = blockSeries(f as unknown as Fixture);
  assert.equal(series.value.attempts.length, 2);
  assert.deepEqual(series.value.attempts[1]!.goal, series.value.attempts[0]!.goal);
  // Rows 7, 8: the work redesigned with its impact decided is accepted on a new frame; the record no longer speaks of it, and
  // the pass completes through a new M8, M9 and the compiler.
  const second = { ...structuredClone(accepted), impact: [{ entry: { file: "regate.test.mjs" }, decision: "keep" as const,
    requirement: "garden-contract" }] };
  respond((ok(readRun(store, { project }))!.value.state as { step: RunStep }).step, second, ["garden-consume-work"]);
  const redesign = await drive(state => state.phase === "complete");
  assert.deepEqual(redesign, ["cycle", "evaluate", "works", "bases", "confirm", "close", "feasibility", "handoff", "compile"]);
  const frame2 = store.get(`om-frame:${project}:3`)!;
  assert.equal(frame2.revision, frame1.revision + 1);
  assert.equal(ok(currentL3Reopen(store, project, reference(frame2))), null);
  assert.deepEqual(store.get<Graph>(`graph:${project}`)!.value.nodes.find(node => node.id === "garden-consume-work")!.impact, second.impact);
  const plan = store.get<{ content: { plan: Ref } }>(`stage:${project}:compilation`)!.value.content.plan;
  assert.deepEqual(store.get<{ feasibility: Ref }>(plan.id, plan.revision)!.value.feasibility, reference(store.get(`om-feasibility:${project}`)!));
  // The door passes on the redesigned works: a new regate writes nothing.
  before = store.list().map(reference);
  assert.equal(ok(regateRun(store, { project })).state, "passed");
  assert.deepEqual(store.list().map(reference), before);
});
test("RL3 №4218 exits 2 and 3: the owner's explicit release of the wait is one record of that reopening — a repeat is that record — and the pass then gives the policy to the model by OWN1 with the reopened works", async t => regatePolicy(t, "release"));
// OWN1 (№3711, №3716) replaced the end of R13/R13b: in the bypass a late question no H2 assigned no longer ends the pass.
// OWN1.2 (№3806, №3809) replaces its carrying: the engine carries by default only what a work proves itself. The late
// question of the environment without H2 is not in D7 — it stays open in B1 for its task start and binds no work, so the
// works answer is accepted (OMG-LIVE 05:37: carried, it refused every works answer, task_obligation_resolution_required).
test("OWN1.2 OWN1 H1.2 R13 R13b a late question of the environment no H2 assigned binds no work: D7 does not carry it, the works answer without a binding is accepted, the question stays open and no owner command is invented", async t => {
  const f = worksFixture(t, true);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>();
  let state: { phase: string; step?: { action: string; request: { packet: Ref } }; wait?: unknown } = { phase: "" };
  for (let index = 0; index < 200 && !performed.includes("works"); index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    if (advanced.performed) performed.push(advanced.performed.action);
    state = advanced.record.value.state as unknown as typeof state;
    if (state.phase === "step" && state.step!.action === "cycle" && !answered.has(state.step!.request.packet.id)) {
      answered.add(state.step!.request.packet.id); f.answer(state.step!.request.packet);
    }
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") break;
  }
  assert.ok(performed.indexOf("obligations") >= 0 && performed.indexOf("cycle", performed.indexOf("obligations")) > 0,
    `D7 and the works go on: ${performed.join(",")} ${JSON.stringify(state)}`);
  const ledgers = f.store.list<{ assignments: { kind: string }[] }>("om-obligations");
  assert.ok(ledgers.length >= 1, "D7 is derived");
  assert.deepEqual(ledgers.flatMap(row => row.value.assignments).filter(row => row.kind === "environment-confirmation"), [],
    "A late question of the environment without H2 is not carried");
  assert.ok(performed.includes("works"), `The works answer that binds nothing is accepted: ${performed.join(",")} ${JSON.stringify(state)}`);
  assert.deepEqual(worksAcceptance(f.store), { passed: true, frame: true, findings: [] }, "G5 passed and layer 3 is written");
  assert.equal(JSON.stringify(f.store.list("om-unit-refusal")).includes("task_obligation_resolution_required"), false,
    "No works answer is refused for a binding no work can make");
  assert.equal(f.store.list("om-owner-gap-assignment").length, 0, "The pass invents no owner command");
  assert.ok(f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.some(row => row.id === "discovery:later-env"), "The question stays open");
});
// G6 (№3857, №3869): the supported fact and the works of its block stood in one attempt, whose works D1 kept the fact's
// question open on the old B1 — G5 refused them, which FA1 never saw (it proved a performed step, №3855 п.5). Now the
// group waits for the transition: the answer is applied, LP5 ends the attempt on the replaced B1, the fact stays its
// result, and the next attempt asks the works anew with the answer in its packet; G5 passes and layer 3 is written.
test("FA1 G6 a technical E5 terminal of the attempt's own fact closes the attempt through G7 with its derived reason; the next attempt asks the fact again, the group's transition applies the answer, and new works carrying it pass G5 and write layer 3", async t => {
  for (const technical of ["off-form", "interrupted"] as const) await t.test(technical, async child => {
    const { f, performed, state, assessed, consume } = await factWorksPass(child, [technical, "supported"]);
    const trail = `${performed.join(",")} ${JSON.stringify(state)}`;
    assert.deepEqual(assessed, [technical, "supported"], `The fact is assessed once per attempt: ${trail}`);
    assert.equal(consume.value.attempts[0]!.outcome?.reason, technical, "The common close derives the technical reason");
    assert.deepEqual(consume.value.attempts[0]!.outcome?.achieved, []);
    assert.ok(performed.indexOf("apply") > 0 && performed.indexOf("apply") < performed.indexOf("works"), `The answer is applied before the works step: ${trail}`);
    assert.equal(consume.value.attempts[1]!.outcome?.reason, "result", "LP5 ends the attempt of the old B1; the supported fact is its result");
    assert.ok(consume.value.attempts[1]!.outcome!.achieved.length > 0, `The fact stays achieved: ${JSON.stringify(consume.value.attempts[1]!.outcome)}`);
    assert.ok(consume.value.attempts.length >= 3, "New works are asked in a new attempt");
    const works = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.packetContract === WORKS_BRIEF_PACKET_CONTRACT && row.value.packet);
    const latest = works.filter(row => row.value.request.attempt?.ordinal === 3);
    assert.ok(latest.length && latest.every(row => JSON.stringify(row.value.packet).includes("UTF-8")), "The new works packet carries the applied answer");
    assert.deepEqual(worksAcceptance(f.store), { passed: true, frame: true, findings: [] }, `G5 passed and layer 3 is written: ${trail}`);
    const next = ok(await advanceRun(f.store, f.request)).record.value.state as { phase: string };
    assert.equal(next.phase, "step", "The pass goes on after the acceptance");
  });
});

test("R19 №1937-3 H1.1 a second store opening work between the saved bases step's admission and its write: the step is refused, D1 does not move", async t => {
  const f = runFixture(t, undefined, "executed");
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveUntil(f, request, state => state.phase === "step" && state.step.action === "bases");
  // A registered root without attempts exists; a second store begins its attempt right before the build moves G2.
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h11-race", predecessor: null, basis: null }));
  const d1 = gapHeads(f.store), horizons = f.store.list("om-horizon").length;
  let raced = false;
  class Race extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-horizon")) {
        raced = true;
        const other = new Store(f.database);
        try { ok(beginAttempt(other, { ...address, attempt: 1, goal: { key: "h11-raced", questions: ["Hold the area"], result: "A held area" } })); }
        finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Race(path));
  const advanced = ok(await advanceRun(f.store, request)), state = advanced.record.value.state;
  assert.ok(raced);
  assert.equal(advanced.performed?.action, "bases");
  assert.deepEqual(state.phase === "waiting" && [state.wait.code, state.wait.target], ["run_bases_work_open", `repair-series:${project}:1:garden-consume-block`]);
  assert.deepEqual(gapHeads(f.store), d1, "The losing build moved no D1 head");
  assert.equal(f.store.list("om-horizon").length, horizons);
});
test("OWN1.1 №3722 two owner answers stay decisions when the second was given before B1 moved by the first: the model is never asked, B1 holds both owner values",
  async t => twoOwnerAnswers(t, true, "executed"));

test("MP1 LP3 №53 in the brief era: a search scope naming a context Ref is refused by E2 label decoding during E3 admission; the pass closes all three attempts without waiting or delivering reads — MP2 (№2968): each managed attempt corrects that repairable answer once", async t => {
  const f = runFixture(t, ["encoding"], "executed"), b = f.bases("mp1-lp3-53"), request = f.request(b);
  const need = lp3Need(f, b.routes, [{ action: "search", within: lp3Context(f), query: "encoding" }]);
  // MP2 (№2968 §3): an unissued label in reads is answer content of MP1's closed repairable class (briefAnswerRepairable):
  // each attempt gets its one correction, answered here the same way.
  f.steps([need, need, need, need, need, need, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 80);
  assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
  const packets = f.store.list<QuestionPacketRecord>("question-packet");
  const roots = packets.filter(row => !row.value.request.correction), corrections = packets.filter(row => row.value.request.correction);
  assert.equal(roots.length, 3); assert.equal(corrections.length, 3);
  assert.ok(packets.every(row => row.value.packetContract === "om-packet/brief-v1"));
  for (const correction of corrections) assert.ok(roots.some(root => root.id === correction.value.request.correction!.packet.id),
    "Each correction names the rejected step of its own chain");
  const calls = f.store.list<{ error: string | null; status: string; om?: { failure?: Refusal } }>("model-call")
    .filter(row => row.value.error === "answer_label_unknown");
  assert.equal(calls.length, 6);
  for (const call of calls) assert.deepEqual([call.value.status, call.value.om?.failure?.at.unit, call.value.om?.failure?.at.field],
    ["failed", "E2", "reads/0/within"]);
  const cycles = f.store.list<{ terminal: string; cyclePolicy?: string }>("om-model-cycle");
  assert.equal(cycles.length, 3);
  assert.ok(cycles.every(row => row.value.terminal === "outcome" && row.value.cyclePolicy === "brief-correction/v1"));
  assert.deepEqual(f.store.list("om-read-delivery"), []);
  assert.equal(end.performed.filter(action => action === "close").length, 3);
  assert.equal(f.sent().length, 7, "Six answers — one correction per attempt — and one review; no repeated delivery or paid call");
  await sameEnd(f, request, 7);
});

test("LP4 (№2887 row 10, §6.2, §6.6) the producers 3cba953 and 202c470, each from its whole Git code in its own process, leave the pass on completion_ceased after the roles move — saved as a wait or as the step about to be performed; the new code on a new Store ends the remaining work by cease and G7 without sending the paid need_source again, every saved revision as the old code wrote it", async t => {
  for (const [name, commit] of Object.entries(LP4_COMMITS)) for (const stop of ["waiting", "step"] as const) await t.test(`${name} ${stop}`, async t => {
    const f = worksFixture(t, undefined, undefined, undefined, commit), moved = join(f.root, "adapter-next.mjs");
    writeFileSync(moved, readFileSync(adapterFixture));
    const reads = name === "3cba953" ? [{ action: "search", within: reference(f.store.get(`om-input:${project}`)!), query: "question" }]
      : [{ action: "read", path: "lp4-later.txt", media: "text/plain" }];
    const stuck = atCommit(f, commit, `lp4-${name}-${stop}`, `const { advanceRun, startRun } = await import(src('om/run.js'));
const { ProductEngine } = await import(src('product/engine.js'));
const { reference } = await import(src('pipeline/contracts.js'));
const { writeFileSync } = await import('node:fs');
take(startRun(store, { project: args.project }));
let request = args.request, ceased = false;
const seen = [], steps = [];
async function drive(stopAtStep) {
  for (let index = 0; index < 40; index++) {
    const advanced = take(await advanceRun(store, request)), state = advanced.record.value.state;
    if (advanced.performed?.action === 'cease') ceased = true;
    if (state.phase === 'step' && state.step.action === 'cycle' && !steps.length) {
      const packet = store.get(state.step.request.packet.id, state.step.request.packet.revision);
      steps.push({ research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'need_source',
        questionIds: packet.value.packet.questions.map(row => row.id), missing: 'The addressed data', reads: args.reads }, usage: args.usage });
      writeFileSync(args.scenario, JSON.stringify({ steps }));
    }
    seen.push(state.phase === 'waiting' ? 'waiting:' + state.wait.code : state.phase + ':' + (advanced.performed?.action ?? ''));
    if (stopAtStep && ceased && state.phase === 'step' && state.step.action === 'cycle') return;
    if (state.phase === 'waiting' && seen.at(-2) === seen.at(-1)) return;
  }
}
await drive(false);
const engine = new ProductEngine(store), old = store.get('environment:' + args.project), environment = structuredClone(old.value);
delete environment.projectId;
for (const role of ['implementer', 'reviewer']) environment[role].command.args = [args.moved, ...environment[role].command.args.slice(1)];
request = { ...request, dispatch: { ...request.dispatch, config: reference(engine.environments.configure(args.project, environment, old.revision)) } };
await drive(args.stop === 'step');
out({ seen, request });`,
      { request: f.request, project, reads, usage, scenario: join(f.root, "scenario.json"), moved, stop }) as { seen: string[]; request: RunRequest };
    const last = stuck.seen.at(-1)!;
    assert.equal(last, stop === "waiting" ? "waiting:completion_ceased" : "step:", `The old code stands on its cessation: ${stuck.seen.join(",")}`);
    f.restart();
    const before = f.store.list().map(reference), head = ok(readRun(f.store, { project }))!;
    const step = head.value.state.phase === "step" ? head.value.state.step : head.value.last!.step;
    assert.equal(step.action, "cycle");
    const packet = (step.request as unknown as { packet: Ref }).packet, paid = lp4Sent(f, packet);
    assert.equal(paid, 1);
    if (stop === "step") {
      // §6.6: the saved step is not performed — an ordinary transition back to the choice, no cycle product invented.
      const first = ok(await advanceRun(f.store, stuck.request));
      assert.deepEqual([first.performed, first.record.value.state.phase, first.record.revision], [null, "ready", head.revision + 1]);
      assert.equal(f.store.list<{ request: { packet: Ref } }>("om-model-cycle").filter(row => row.value.request.packet.id === packet.id).length, 0);
    }
    const seen = await lp4Close(f, stuck.request);
    const roots = f.store.list<{ cause: { kind: string }; remainder: string }>("om-completion-cessation").filter(row => row.value.cause.kind === "cycle-step-ceased");
    assert.deepEqual(roots.map(row => row.value.remainder), ["assembly"], seen.join(","));
    assert.equal(lp4Sent(f, packet), 1, "The paid need_source of the old code is never sent again");
    for (const ref of before) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref, `${ref.id}@${ref.revision} stands as the old code wrote it`);
  });
});

test("AT1 policy: the owner's H2 answer decides the producer's state policy; the model is never asked, and the works pass G5", async t => policyDoor(t, true));
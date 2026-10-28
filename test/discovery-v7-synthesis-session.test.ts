import { fixturePlanAxes, fixturePlanCoverage } from "./discovery-v7-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_STAGE_TOKEN_CEILING } from "../src/discovery/v7-contracts.js";
import { findUnfinishedSynthesisSession, findUnfinishedSynthesisSessionV3, readSynthesisSessionV3,
  synthesisSession } from "../src/discovery/synthesis-session.js";
import { exactContextLookup, managedTurnId, projectPaidTurnAdmission, projectResearchTurnRevision,
  projectSynthesisSessionV3Initial, projectSynthesisTransition, turnAction } from "../src/discovery/research-consumer-transition.js";
import { addContextLookup, contextWorkspace, packContextWorkspace } from "../src/discovery/context-workspace.js";
import { readReaderResultAt } from "../src/discovery/reader.js";
import { pilotEnvironment, readerPilot } from "../src/discovery/reader-pilot.js";
import { researchCall } from "../src/discovery/research-protocol.js";
import { DISCOVERY_CLAIMS_CONTRACT } from "../src/discovery/v7-contracts.js";
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { configureV7SavedSynthesis, savedV7SynthesisMaterials } from "../src/discovery/saved-synthesis.js";
import { recoverContextSession } from "../src/discovery/context-recovery.js";
import { questionDispatchId } from "../src/discovery/v7-managed-attempt.js";
import type { Write } from "../src/storage/store.js";
import { Researcher } from "../src/discovery/research-runner.js";
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  readResearchConsumerIntent, recoverResearchResponse, subjectContextRecordHolds, contextRecordValue,
  prepareResearchConsumerReservation } from "../src/discovery/response-recovery.js";
import { REQUEST_MANIFEST_CONTRACT, prepareRequestPartsAndManifest } from "../src/discovery/request-parts.js";
import { workingContext } from "../src/discovery/working-context.js";
import { processStart } from "../src/runtime/process-identity.js";
import type { ResearchRun } from "../src/discovery/research-model.js";
import { addressedWorkspace, workingSelections } from "../src/discovery/research-continuation.js";
import { PLANNING_INSTRUCTION } from "../src/discovery/reading-plan.js";
import { digest, hashJson } from "../src/canonical.js";
import { uniqueRefs } from "../src/pipeline/contracts.js";
import { uniqueTransactionGuards } from "../src/runtime/environment.js";
import type { ModelCall } from "../src/runtime/model-usage.js";
import { EngineError } from "../src/errors.js";
import type { Json } from "../src/canonical.js";
import { isRef, reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision } from "../src/storage/store.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture } from "./discovery-v7-fixture.js";

// DR3a3-S5, независимая часть (№8525; переносы S1→S5 №7869 и S4→S5 №8455):
// the v3 synthesis producer of one v7 plan-question. The plan, environment
// and reader profile come from their real producers and the session from the
// real synthesisSession entry. The paid admission of synthesis stays closed
// until the shared files are connected, so the producer reaches its first
// record and a prepared step intent, and the payment refuses before any
// adapter or ledger.

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3a3s5-session-");
type Fixture = ReturnType<typeof fixture>;
const validFrame = (): Json => ({ productType: "internal", scale: "30 users across 10 sites",
  industries: ["construction"], domains: ["materials supply"], axes: fixturePlanAxes([{ axis: "industry" }, { axis: "market" }]),
  budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } });
const planQuestion = (id: string, axis: string, cls = "supporting") => ({ id, axis, domain: "construction",
  text: `What covers ${id}?`, class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
  roles: ["domain expert"], searchPlaces: ["domain documents"] });
const validPlan = (frame: Ref, ids: string[], edition = 1, previous: Ref | null = null): Json =>
  ({ edition, frame, previous, coverage: fixturePlanCoverage(ids.map((id, i) => ({ id, axis: i ? "market" : "industry" }))), questions: ids.map((id, i) => planQuestion(id, i ? "market" : "industry",
    i ? "supporting" : "blocking")) }) as unknown as Json;
const questionOf = (store: Store, draft: Revision<DiscoveryDraft>, field: string) =>
  draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
const subjectOf = (planAnswer: Ref, planQuestionId: string): V7PlanSubject =>
  ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId });
const code = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};

/** The real plan, environment and active reader profile of one v7 project. */
function planned(f: Fixture, project: string) {
  f.engine.execute({ type: "create-project", project, title: project });
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, ["q-supply", "q-market"]), src);
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 30000 }, 0);
  f.engine.execute({ type: "configure-reader-pilot", project, expected: 0, settings: { experimental: true, active: true,
    stopAfter: "L2", reader: { actor: "reader", model: "fixture", effort: "high", speed: "inherited", command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000, maxCalls: 20, maxReportedTokens: 100000 } });
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef, environment,
    pilot: readerPilot(f.store, project)!, dispatch: { ...environment.value, workspace: f.root } };
}
type Planned = ReturnType<typeof planned>;
function nextEdition(f: Fixture, p: Planned) {
  const planQ = f.store.get<Question>(p.plan.id)!;
  f.discovery.reopen(planQ.id, planQ.revision);
  const src = f.discovery.evidence.document(p.project, "basis-2", `Second source for ${p.project}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, p.project, f.store.get<DiscoveryDraft>(p.draft.id)!, f.store.get<Question>(planQ.id)!,
    validPlan(p.frameRef, ["q-supply", "q-market"], 2, p.planAnswer), src);
  return f.store.get<Question>(planQ.id)!.value.answer!;
}
/** The synthesis call context of one subject (S2's transport form). */
const contextOf = (subject: V7PlanSubject) => ({ role: "research", stage: "discovery", subject,
  inventory: { sources: [] }, history: [], contextWorkspace: [] });
const run = (f: Fixture, p: Planned, context: Record<string, any>) => synthesisSession(f.store, p.draft, p.plan,
  p.environment, p.dispatch, p.pilot, context, "Synthesize the exact plan-question");
const history = (store: Store) => store.list().map(row => [row.id, row.revision, row.hash]);

test("S5 creation (S1→S5): the real producer writes exactly the v3 projector's first record at its address, prepares its subject's step, and without a calibrated estimate stops at the budget boundary before any call", async t => {
  const f = fixture(t), p = planned(f, "s5-create");
  const A = subjectOf(p.planAnswer, "q-supply");
  assert.equal(await code(() => run(f, p, contextOf(A))), "budget_estimate_missing");
  const sessions = f.store.list<any>("synthesis-session");
  const expected = projectSynthesisSessionV3Initial({ projectId: p.project, binding: { draft: reference(p.draft),
    question: reference(p.plan), environment: reference(p.environment), inputs: p.draft.value.inputs, subject: A },
    basis: { materials: [], previousProposal: null, previousProposalRef: null }, delivery: null });
  assert.deepEqual(sessions.map(session => [session.id, session.revision]), [[expected.id, 1]]);
  assert.deepEqual(sessions[0]!.value, expected.value, "exactly the shared projector's first record");
  const intents = f.store.list<any>("research-consumer-intent");
  assert.deepEqual(intents.map(intent => [intent.value.kind, intent.value.state, intent.value.owner.id]),
    [["synthesis", "prepared", expected.id]]);
  assert.deepEqual(intents[0]!.value.cursor.subject, A, "the step names exactly its session's subject");
  for (const kind of ["model-call", "model-request", "research-budget-ledger"]) assert.deepEqual(f.store.list(kind), [], `no ${kind}`);
  // A repeat continues the same unfinished session of the subject: no second session, no second step, no payment.
  assert.equal(await code(() => run(f, p, contextOf(A))), "budget_estimate_missing");
  assert.equal(f.store.list("synthesis-session").length, 1);
  assert.equal(f.store.list("research-consumer-intent").length, 1);
});

test("S5 exact, cold and historical reads (S1→S5): the saved v3 session proves on saved bases in a new Store without writes, after a new plan edition too, and passes the store integrity check", async t => {
  const f = fixture(t), p = planned(f, "s5-read");
  const A = subjectOf(p.planAnswer, "q-supply");
  await code(() => run(f, p, contextOf(A)));
  const session = f.store.list<any>("synthesis-session")[0]!;
  const before = history(f.store);
  const cold = f.open();
  assert.deepEqual(readSynthesisSessionV3(cold, reference(session)), session);
  assert.deepEqual(history(cold), before, "the exact reader writes nothing");
  assert.deepEqual(checkStoreIntegrity(cold).findings.filter(finding => finding.id === session.id), []);
  nextEdition(f, p);
  assert.deepEqual(readSynthesisSessionV3(f.open(), reference(session)), session, "history reads by its own saved plan edition");
  // New work on the replaced edition is not sent as a new step of the current plan.
  const after = history(f.store);
  assert.equal(await code(() => run(f, p, contextOf(A))), "research_plan_subject_invalid");
  assert.deepEqual(history(f.store), after);
});

test("S5 subject isolation: A and B keep separate sessions and unfinished lookups; the v2 lookup never adopts a v3 session; a damaged subject refuses before any record", async t => {
  const f = fixture(t), p = planned(f, "s5-isolation");
  const A = subjectOf(p.planAnswer, "q-supply"), B = subjectOf(p.planAnswer, "q-market");
  const before = history(f.store);
  for (const damaged of [{ ...A, planQuestionId: "" }, null, { ...A, contract: "v7-plan-subject/v0" }, subjectOf(p.planAnswer, "q-unknown")])
    assert.equal(await code(() => run(f, p, { ...contextOf(A), subject: damaged })), "research_plan_subject_invalid", JSON.stringify(damaged));
  assert.deepEqual(history(f.store), before, "a refused subject wrote nothing");
  await code(() => run(f, p, contextOf(A)));
  await code(() => run(f, p, contextOf(B)));
  const ids = f.store.list<any>("synthesis-session").map(session => session.id);
  assert.equal(new Set(ids).size, 2, "two subjects, two sessions");
  const a = findUnfinishedSynthesisSessionV3(f.store, p.project, p.draft.id, A)!;
  const b = findUnfinishedSynthesisSessionV3(f.store, p.project, p.draft.id, B)!;
  assert.notEqual(a.session.id, b.session.id);
  assert.deepEqual([a.subject, b.subject], [A, B], "the operation returns its saved subject, not only a Question id");
  assert.equal(a.questionId, p.plan.id);
  assert.equal(findUnfinishedSynthesisSession(f.store, p.project, p.draft.id), null, "the v2 lookup never adopts a v3 session");
  // Negative corruption only: a later revision that swaps the saved subject is not a lawful transition.
  const head = f.store.get<any>(a.session.id)!;
  const forged = f.store.write({ id: head.id, kind: head.kind, expected: head.revision,
    value: { ...head.value, binding: { ...head.value.binding, subject: B } } });
  assert.equal(await code(async () => readSynthesisSessionV3(f.open(), reference(forged))), "synthesis_session_invalid");
});

/* ---------- paid chains on the real researchCall with a controlled adapter ---------- */

/** One v7 project whose adapter answers from a queue of replies, with both the
 * analyst and the reading-planner purposes calibrated by real calls (a4). */
async function paidPlanned(t: { after(fn: () => void): void }, project: string, ids = ["q-supply", "q-market"],
  options: { calibrationTokens?: number; conclusionShare?: number; planning?: boolean } = {}) {
  const f = fixture(t);
  const wire = join(f.root, "wire.ndjson"), replies = join(f.root, "replies.json"), adapter = join(f.root, "adapter.mjs");
  const tokensFile = join(f.root, "tokens.json");
  const configure = (queue: unknown[] = []) => writeFileSync(replies, JSON.stringify(queue));
  const usage = (tokens: number) => writeFileSync(tokensFile, JSON.stringify(tokens));
  configure(); usage(options.calibrationTokens ?? 10);
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),queue=JSON.parse(readFileSync(${JSON.stringify(replies)},'utf8'));
let seen=[];try{seen=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw.replace(/\\n/g,' ')+'\\n');
const c=r.subject??{},tokens=JSON.parse(readFileSync(${JSON.stringify(tokensFile)},'utf8'));
const position=seen.filter(line=>JSON.parse(line).subject?.dispatchMode!=='consolidation').length;
let research=c.dispatchMode==='consolidation'
  ?{action:'checkpoint',question:c.question.id,value:{summaries:c.consolidation.notes.map((n,i)=>({notes:[i],text:'Finding '+i+' retains its exception and unresolved condition'})),citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['New conflict remains open']}
  :queue[position]??{action:'pause',reason:'calibration'};
if(c.assessmentSubject){
 const packet=c.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 const rejected=(c.value?.attempts??[]).flatMap(entry=>entry.end.type==='submitted'?entry.end.value.claims.map((claim,index)=>({claim:{project:packet.project,container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id},reason:'Insufficient corroboration'})):[]);
 research={verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected,newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
research=JSON.parse(JSON.stringify(research).replaceAll('$q',c.question?.id??'probe'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  f.engine.execute({ type: "create-project", project, title: project });
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 30000 }, 0);
  f.engine.execute({ type: "configure-reader-pilot", project, expected: 0, settings: { experimental: true, active: true,
    stopAfter: "L2", reader: { actor: "reader", model: "fixture", effort: "high", speed: "inherited", command }, agentCommand: command,
    maxRequestChars: 200000, maxReadChars: 20000, maxReplyChars: 200000, maxCalls: 50, maxReportedTokens: 100000000,
    ...(options.planning ? { v7Planning: { contract: "v7-plan-planning/v1", maxRequestChars: 200000, maxRounds: 5 } } : {}),
    ...(options.conclusionShare ? { conclusionShare: options.conclusionShare } : {}) } });
  // Real calibration calls of both purposes on a field-path draft (no plan subject, no stage budget).
  const calibration = f.discovery.create(project, "discovery", "R0", "concept",
    [{ field: "probe", kind: "fact", prompt: "Calibrate", risk: "unknown", schema: { type: "object" } }], [], 6);
  for (const purpose of ["analyst", "reading-planner"])
    await researchCall(environment.value.implementer, environment.value, "Calibrate", {}, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  await researchCall(environment.value.reviewer, environment.value, "Calibrate assessor", {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: "assessor" });
  writeFileSync(wire, ""); usage(10);
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, ids), src);
  const plan = f.store.get<Question>(planQ.id)!, pilot = readerPilot(f.store, project)!;
  // A "large" material takes a page of its own (as the v2 fixture's small layout): delivery stays incomplete after page one.
  const material = (name: string, large = false) => {
    const document = f.discovery.evidence.document(project, `material-${name}`, `Material ${name}: a condition with its exception. `
      + (large ? "detail ".repeat(Math.floor(200000 * 0.55 / 7)) : ""), "text/plain", 0);
    return { kind: "context", value: f.discovery.evidence.observe(project, reference(document),
      { kind: "text-range", start: 0, end: document.value.content.length }) };
  };
  const citation = (selection: { value: any }) => ({ source: selection.value.source, selector: selection.value.selector });
  const calls = () => readFileSync(wire, "utf8").trim().split("\n").filter(Boolean).length;
  const p = { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef, environment,
    pilot, dispatch: pilotEnvironment(environment.value, pilot.value) };
  return { ...f, p, configure, usage, material, citation, calls };
}
type Paid = Awaited<ReturnType<typeof paidPlanned>>;
const paidRun = (f: Paid, subject: V7PlanSubject, materials: unknown[], extra: Record<string, any> = {}) =>
  synthesisSession(f.store, f.p.draft, f.p.plan, f.p.environment, f.p.dispatch, f.p.pilot,
    { ...contextOf(subject), workingSelections: materials, ...extra }, "Synthesize the exact plan-question");
const endOf = (value: unknown) => ({ action: "answer", question: "$q", value, citations: [] });
const ENDS: Record<string, unknown> = {
  submitted: { type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims: [] } },
  refused: { type: "refused", code: "source_unavailable", evidence: [], text: "No accessible source" },
  impossible: { type: "impossible", code: "source_unavailable", evidence: [], text: "Cannot be established" },
  duplicate: { type: "duplicate", of: { id: "research-attempt:original", revision: 1, hash: "0".repeat(64) } },
};

test("S5 paid chain: initial page → v2 checkpoint → final page → each of the four attempt ends as the session result, with exact counts and no attempt", async t => {
  const ids = ["q-a", "q-b", "q-c", "q-d"];
  const f = await paidPlanned(t, "s5-chain", ids);
  const [first, second] = [f.material("one"), f.material("two")];
  for (const [index, kind] of Object.keys(ENDS).entries()) {
    const subject = subjectOf(f.p.planAnswer, ids[index]!);
    const before = f.calls();
    f.configure([...Array(before).fill(null), { action: "checkpoint", question: "$q", value: { finding: `page one of ${kind}` },
      citations: [f.citation(first)], unresolved: [] }, endOf(ENDS[kind])]);
    const result = await paidRun(f, subject, [first, second]);
    assert.deepEqual(result, { ...endOf(ENDS[kind]), question: ids[index] }, `${kind}: the session result is the attempt end`);
    assert.equal(f.calls() - before, 2, `${kind}: two paid pages`);
    const session = f.store.list<any>("synthesis-session").find(row => row.value.binding.subject.planQuestionId === ids[index])!;
    const proven = readSynthesisSessionV3(f.open(), reference(session));
    assert.equal(proven.value.notes.length, 1);
    const note = f.store.get<any>(proven.value.notes[0]!.checkpoint.id)!;
    assert.ok(note.id.startsWith("research-checkpoint:v2:"));
    assert.deepEqual(note.value.subject, subject, `${kind}: the note is bound to its own subject`);
    assert.equal(note.value.question.id, f.p.plan.id, "the note keeps the real plan Question");
  }
  assert.deepEqual(f.store.list("research-attempt"), [], "S5 records no attempt: the end is handed off by the runner (S6)");
});

test("S5 early answer: an answer before all pages are delivered is synthesis_checkpoint_required with its paid payload kept, no note and no repurchase", async t => {
  const f = await paidPlanned(t, "s5-early");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  f.configure([endOf(ENDS.impossible)]);
  const pages = [f.material("one", true), f.material("two", true)];
  assert.equal(await code(() => paidRun(f, A, pages)), "synthesis_checkpoint_required");
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.store.list("research-checkpoint"), [], "an early end is never turned into a note");
  const intent = f.store.list<any>("research-consumer-intent").find(row => row.value.kind === "synthesis")!;
  assert.equal(intent.value.state, "refused");
  assert.equal(intent.value.refusal.code, "synthesis_checkpoint_required");
  assert.equal(await code(() => paidRun(f, A, pages)), "synthesis_checkpoint_required",
    "the saved refusal repeats as itself");
  assert.equal(f.calls(), 1, "no new payment");
});

test("S5 not ends: answer_delta is refused by the subject's action reader; need_research and need_owner before full delivery need a checkpoint and after it stay control results; pause pauses", async t => {
  const f = await paidPlanned(t, "s5-control", ["q-a", "q-b", "q-c", "q-d"]);
  const delta = { action: "answer_delta", question: "$q", upserts: [], citations: [] };
  f.configure([delta]);
  // An answer_delta is no end of an attempt: the subject's own action reader refuses it with its paid payload kept.
  assert.equal(await code(() => paidRun(f, subjectOf(f.p.planAnswer, "q-a"), [f.material("x")])), "research_response_invalid");
  assert.deepEqual(f.store.list("research-checkpoint"), []);
  const needResearch = { action: "need_research", question: "$q", missing: ["the exact clause"] };
  f.configure([...Array(f.calls()).fill(null), needResearch]);
  assert.equal(await code(() => paidRun(f, subjectOf(f.p.planAnswer, "q-b"), [f.material("y", true), f.material("z", true)])),
    "synthesis_checkpoint_required", "an incomplete page cannot ask for new research");
  const consulted = f.material("consulted");
  const needOwner = { action: "need_owner", question: "$q", reason: "owner-only scope", searched: [consulted.value.source] };
  f.configure([...Array(f.calls()).fill(null), needOwner]);
  assert.deepEqual(await paidRun(f, subjectOf(f.p.planAnswer, "q-c"), [consulted]), { ...needOwner, question: "q-c" },
    "after full delivery need_owner is a control result, not an end");
  f.configure([...Array(f.calls()).fill(null), { action: "pause", reason: "operator" }]);
  assert.deepEqual(await paidRun(f, subjectOf(f.p.planAnswer, "q-d"), []), { action: "pause", reason: "operator" });
  assert.deepEqual(f.store.list("research-attempt"), []);
});

test("S5 cold replay: a finished session returns its saved result from a new Store without calling the adapter or adding a ledger", async t => {
  const f = await paidPlanned(t, "s5-replay");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  f.configure([endOf(ENDS.refused)]);
  const result = await paidRun(f, A, []);
  const calls = f.calls(), ledgers = f.store.list("research-budget-ledger").length, before = history(f.store);
  const cold = f.open();
  const replay = await synthesisSession(cold, f.p.draft, f.p.plan, f.p.environment, f.p.dispatch, f.p.pilot,
    { ...contextOf(A), workingSelections: [] }, "Synthesize the exact plan-question");
  assert.deepEqual(replay, result);
  assert.equal(f.calls(), calls, "no adapter call");
  assert.equal(cold.list("research-budget-ledger").length, ledgers, "no new ledger");
  assert.deepEqual(history(cold), before, "no write at all");
});

const checkpointOn = (f: Paid, selection: { value: any }, finding: string) => ({ action: "checkpoint", question: "$q",
  value: { finding }, citations: [f.citation(selection)], unresolved: [] });
const runIn = (f: Paid, store: Store, subject: V7PlanSubject, materials: unknown[]) => synthesisSession(store, f.p.draft, f.p.plan,
  f.p.environment, f.p.dispatch, f.p.pilot, { ...contextOf(subject), workingSelections: materials }, "Synthesize the exact plan-question");

test("S5 crash after payment: an interrupted application keeps the paid answer and a second Store applies it without a new call or ledger", async t => {
  const f = await paidPlanned(t, "s5-crash");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  f.configure([endOf(ENDS.refused)]);
  const write = f.store.writeMany.bind(f.store); let cut = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!cut && writes.some(item => item.kind === "synthesis-session" && item.expected > 0)) {
      cut = true; throw new Error("crash after payment"); }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(paidRun(f, A, []), /crash after payment/);
  f.store.writeMany = write;
  assert.equal(f.calls(), 1);
  const ledgers = f.store.list("research-budget-ledger").length;
  const second = f.open();
  assert.deepEqual(await runIn(f, second, A, []), { ...endOf(ENDS.refused), question: "q-supply" });
  assert.equal(f.calls(), 1, "the paid answer is applied, not bought again");
  assert.equal(second.list("research-budget-ledger").length, ledgers, "no new ledger");
});

test("S5 finalization never spends the completion reserve: a final page whose estimate exceeds the research remainder pauses before any call", async t => {
  const f = await paidPlanned(t, "s5-reserve", ["q-supply", "q-market"], { calibrationTokens: 19_000_000 });
  const A = subjectOf(f.p.planAnswer, "q-supply");
  f.configure([endOf(ENDS.refused)]);
  const before = f.store.list("model-call").length;
  let failure: EngineError | null = null;
  try { await paidRun(f, A, []); } catch (error) { failure = error as EngineError; }
  assert.equal(failure?.code, "discovery_budget_reserve", String(failure?.message));
  const details = failure!.details as { remaining: number; class: string; estimate: { tokens: number } };
  assert.equal(details.class, "research");
  assert.equal(details.remaining, 18_000_000, "the research remainder excludes the 2 000 000 completion reserve");
  assert.ok(details.estimate.tokens > details.remaining, JSON.stringify(details.estimate));
  assert.equal(f.store.list("model-call").length, before);
  assert.equal(f.calls(), 0);
});

test("S5 overrun: a paid page whose actual usage passes the stage limit keeps its note, and the next send pauses with discovery_budget_overrun", async t => {
  const f = await paidPlanned(t, "s5-overrun");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  const [first, second] = [f.material("one", true), f.material("two", true)];
  f.configure([checkpointOn(f, first, "page one"), endOf(ENDS.refused)]);
  f.usage(21_000_000);
  assert.equal(await code(() => paidRun(f, A, [first, second])), "discovery_budget_overrun");
  assert.equal(f.calls(), 1, "the overrun stops the next send");
  const session = f.store.list<any>("synthesis-session")[0]!;
  assert.equal(session.value.notes.length, 1, "the paid page keeps its note");
});

test("S5 consolidation: after a real profile change leaves the notes no room, a paid consolidation step writes a v2 note of the same subject and the session reaches its end", async t => {
  const f = await paidPlanned(t, "s5-consolidation");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  const pages = [f.material("one", true), f.material("two", true), f.material("three")];
  // Produce two large lawful notes under the setup profile, then pause on the third (small) page.
  f.configure([checkpointOn(f, pages[0]!, "x".repeat(30000)), checkpointOn(f, pages[1]!, "y".repeat(30000)),
    { action: "pause", reason: "hold before the measured profile" }, endOf(ENDS.impossible)]);
  assert.deepEqual(await paidRun(f, A, pages), { action: "pause", reason: "hold before the measured profile" });
  // The measured pressure: the owner's next profile revision (the real command) gives the carried notes no room.
  const { projectId: _project, ...settings } = f.p.pilot.value;
  f.engine.execute({ type: "configure-reader-pilot", project: f.p.project, expected: f.p.pilot.revision,
    settings: { ...settings, maxRequestChars: 60000, conclusionShare: 0.35 } });
  const pilot = readerPilot(f.store, f.p.project)!, dispatch = pilotEnvironment(f.p.environment.value, pilot.value);
  const result = await synthesisSession(f.store, f.p.draft, f.p.plan, f.p.environment, dispatch, pilot,
    { ...contextOf(A), workingSelections: pages }, "Synthesize the exact plan-question");
  assert.deepEqual(result, { ...endOf(ENDS.impossible), question: "q-supply" });
  const session = readSynthesisSessionV3(f.open(), reference(f.store.list<any>("synthesis-session")[0]!));
  const consolidated = session.value.notes.filter(note => note.consolidated);
  assert.ok(consolidated.length >= 1, "a paid consolidation step ran");
  for (const note of consolidated) {
    const record = f.store.get<any>(note.checkpoint.id)!;
    assert.ok(record.id.startsWith("research-checkpoint:v2:"));
    assert.deepEqual(record.value.subject, A, "the consolidated note is the same subject's note");
  }
});

test("S4→S5 saved-only on a lawful v3 session: the choice takes its proven notes in order and reads them back; a mismatched expected changes nothing", async t => {
  const f = await paidPlanned(t, "s5-saved");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  const [first, second] = [f.material("one", true), f.material("two", true)];
  f.configure([checkpointOn(f, first, "page one"), { action: "pause", reason: "hold for saved-only" }]);
  await paidRun(f, A, [first, second]);
  const saved = configureV7SavedSynthesis(f.store, f.p.project, A, 0);
  const session = f.store.list<any>("synthesis-session")[0]!;
  assert.deepEqual(saved.value.checkpoints, session.value.notes.map((note: any) => note.checkpoint));
  const draft = f.store.get<DiscoveryDraft>(f.p.draft.id)!, plan = f.store.get<Question>(f.p.plan.id)!;
  const materials = savedV7SynthesisMaterials(f.store, draft, plan, A)!;
  assert.equal(materials.length, 1);
  assert.deepEqual((materials[0]!.value as any).proposal.value, { finding: "page one" }, "the note keeps its paid checkpoint");
  const before = history(f.store);
  assert.equal(await code(async () => configureV7SavedSynthesis(f.store, f.p.project, A, 0)), "revision_conflict");
  assert.deepEqual(history(f.store), before);
});

test("S4→S5 cold v3 context recovery: a lawfully blocked session gets one operator revision its chain reader proves; a dispatch of either counter racing the write conflicts; another subject's note is foreign", async t => {
  const f = await paidPlanned(t, "s5-recover");
  const A = subjectOf(f.p.planAnswer, "q-supply"), B = subjectOf(f.p.planAnswer, "q-market");
  // B's lawful note, to be refused as A's recovery material.
  const [b1, b2] = [f.material("b1", true), f.material("b2", true)];
  f.configure([checkpointOn(f, b1, "B's page"), { action: "pause", reason: "hold B" }]);
  await paidRun(f, B, [b1, b2]);
  const noteB = f.store.list<any>("synthesis-session").find(row => row.value.binding.subject.planQuestionId === "q-market")!.value.notes[0].checkpoint;
  // A blocks lawfully: its paid final-page lookup names a pointer its exact bound draft does not have.
  f.configure([...Array(f.calls()).fill(null), { action: "read_context", record: reference(f.p.draft), pointer: "/no-such-field",
    purpose: "the missing clause" }]);
  assert.equal(await code(() => paidRun(f, A, [])), "research_no_progress");
  const headOf = () => f.store.list<any>("synthesis-session").find(row => row.value.binding.subject.planQuestionId === "q-supply")!;
  const blocked = headOf();
  assert.ok(blocked.value.workspace.blocked);
  const selector = { record: reference(f.store.get<DiscoveryDraft>(f.p.draft.id)!), pointer: "/stage" };
  assert.equal(await code(async () => recoverContextSession(f.store, f.p.project, reference(blocked), { record: noteB, pointer: "/proposal" })),
    "context_reference_foreign", "another subject's lawful note is not A's material");
  for (const scope of [A, null]) {
    const write = f.store.writeMany.bind(f.store); let raced = false;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!raced && writes.some(item => item.id === blocked.id)) {
        raced = true;
        const id = questionDispatchId(f.p.project, f.p.plan.id, scope), current = f.store.get<any>(id);
        write([{ id, kind: "question-dispatch", expected: current?.revision ?? 0, value: { projectId: f.p.project, question: f.p.plan.id,
          ...(scope ? { subject: scope } : {}), serial: (current?.value.serial ?? 0) + 1 } }]);
      }
      return write(writes, guards);
    }) as typeof f.store.writeMany;
    assert.equal(await code(async () => recoverContextSession(f.store, f.p.project, reference(blocked), selector)), "input_stale",
      scope ? "a subject dispatch racing the write" : "a common reader dispatch racing the write");
    f.store.writeMany = write;
    assert.deepEqual(headOf(), blocked, "no half write");
  }
  const recovered = recoverContextSession(f.store, f.p.project, reference(blocked), selector);
  assert.equal(recovered.revision, blocked.revision + 1);
  const cold = f.open();
  assert.deepEqual(readSynthesisSessionV3(cold, reference(recovered)), recovered, "the chain reader proves the operator revision");
  assert.equal(recovered.value.workspace?.blocked, undefined);
});

test("S5 planner admission (S3 intent): a lawful saved planner intent passes the subject role and budget admission and stops only at the run-ownership boundary the runner (S6) holds, without a call", async t => {
  const f = await paidPlanned(t, "s5-planner");
  const B = subjectOf(f.p.planAnswer, "q-market");
  // A lawful v7 run of the real runner: one paid analyst turn for the blocking plan-question, then the allowance pauses.
  f.configure([endOf(ENDS.refused)]);
  const paused = await new Researcher(f.store, new Discovery(f.store), f.engine.environments)
    .run(f.p.project, f.p.draft.id, 1, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(paused.value.pauseCode, "research_turns_exhausted", JSON.stringify(paused.value));
  const run = f.store.get<any>(paused.id)!, calls = f.calls();
  const dispatch = { ...f.p.environment.value, workspace: f.root };
  const context = { role: "research", stage: "discovery", subject: B, inventory: { sources: [] }, history: [],
    contextWorkspace: [], dispatchMode: "planning" };
  const intent = prepareResearchConsumerIntent(f.store, { projectId: f.p.project, kind: "reading-planner",
    key: hashJson([run.id, run.value.turns + 1, "reading-planner"]), owner: reference(run),
    draft: reference(f.p.draft), question: reference(f.p.plan), role: dispatch.implementer, dispatch, profile: null,
    cursor: { run: run.id, turn: run.value.turns + 1, mode: "planning", instruction: PLANNING_INSTRUCTION, context, subject: B },
    basis: uniqueRefs([...f.p.draft.value.inputs, f.p.planAnswer]),
    guards: uniqueTransactionGuards([reference(run), reference(f.p.draft), reference(f.p.plan), ...f.p.draft.value.inputs, f.p.planAnswer]) });
  const before = f.store.list<ModelCall>("model-call").length;
  // The paid planner reply itself is applied by the runner's planner connection (S6): there, a running run owns the turn.
  assert.equal(await code(() => researchCall(intent.value.role, intent.value.dispatch, PLANNING_INSTRUCTION, context, undefined,
    { store: f.store, draftId: f.p.draft.id, questionId: f.p.plan.id, purpose: "reading-planner", consumerIntent: reference(intent) })),
  "research_consumer_intent_invalid", "past the role and budget admission, only the run's ownership is left");
  assert.equal(f.store.list<ModelCall>("model-call").length, before, "no call");
  assert.equal(f.calls(), calls);
  // Without its subject the same planner role stays closed on a v7 draft.
  assert.equal(await code(() => researchCall(dispatch.implementer, dispatch, PLANNING_INSTRUCTION, { ...context, subject: undefined }, undefined,
    { store: f.store, draftId: f.p.draft.id, questionId: f.p.plan.id, purpose: "reading-planner" })), "research_v7_mode_unavailable");
});

test("S5 no result from a damaged session: a swapped offset or subject is refused by the chain reader, and no new step is bought over it", async t => {
  // A fourth plan-question is the swap target only: a session that falsely claims a subject blocks that subject's work.
  const ids = ["q-a", "q-b", "q-c", "q-d"];
  const f = await paidPlanned(t, "s5-damage", ids);
  const other = subjectOf(f.p.planAnswer, "q-d");
  // Negative corruption only: each lawful session gets one forged later revision; no new step is bought over it.
  for (const [index, [name, damage, expected]] of ([["offset", (value: any) => ({ ...value, offset: 0 }), "synthesis_session_invalid"],
    // Another lawful plan-question of the same plan passes the subject proof; the chain (address, steps) refuses it.
    ["subject", (value: any) => ({ ...value, binding: { ...value.binding, subject: other } }), "synthesis_session_invalid"],
    ["null subject", (value: any) => ({ ...value, binding: { ...value.binding, subject: null } }), "research_plan_subject_invalid"]] as
    [string, (value: any) => unknown, string][]).entries()) {
    const subject = subjectOf(f.p.planAnswer, ids[index]!);
    const pages = [f.material(`${name}-one`, true), f.material(`${name}-two`, true)];
    f.configure([...Array(f.calls()).fill(null), checkpointOn(f, pages[0]!, `${name} page`), { action: "pause", reason: "hold" }]);
    await paidRun(f, subject, pages);
    const head = f.store.list<any>("synthesis-session").find(row => row.value.binding.subject.planQuestionId === ids[index])!;
    const calls = f.calls();
    const forged = f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: damage(head.value) });
    assert.equal(await code(async () => readSynthesisSessionV3(f.open(), reference(forged))), expected, name);
    assert.notEqual(await code(() => paidRun(f, subject, pages)), "no-error", name);
    assert.equal(f.calls(), calls, `${name}: no new payment`);
  }
});

/* ---------- круг 2 (codex-omg №8854, оркестратор №8856): one subject and one history for writer and reader ---------- */

/** The paid page of `subject` is bought and its application crashes, keeping the paid response unapplied. */
async function crashAfterPayment(f: Paid, subject: V7PlanSubject, materials: unknown[]) {
  const write = f.store.writeMany.bind(f.store); let cut = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!cut && writes.some(item => item.kind === "synthesis-session" && item.expected > 0)) {
      cut = true; throw new Error("crash after payment"); }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(paidRun(f, subject, materials), /crash after payment/);
  f.store.writeMany = write;
}
const reopenPlan = (f: Paid) => f.discovery.reopen(f.p.plan.id, f.store.get<Question>(f.p.plan.id)!.revision);
const sessionOf = (store: Store, id: string) => store.list<any>("synthesis-session")
  .find(row => row.value.binding.subject.planQuestionId === id)!;

test("S5-01 finished replay after a real new plan edition: a cold Store returns the saved result by its own history, without the adapter or any write", async t => {
  const f = await paidPlanned(t, "s5r2-finished");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  f.configure([endOf(ENDS.refused)]);
  const result = await paidRun(f, A, []);
  nextEdition(f, f.p as unknown as Planned);
  const calls = f.calls(), before = history(f.store);
  assert.deepEqual(await runIn(f, f.open(), A, []), result);
  assert.equal(f.calls(), calls, "no adapter call");
  assert.deepEqual(history(f.store), before, "no write at all");
});

test("S5-01 historical application vs new send: after a real reopen the paid page applies to its own history in a second Store, and the next page — a new send of the replaced plan — is refused without a call or ledger", async t => {
  const f = await paidPlanned(t, "s5r2-reopen");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  const pages = [f.material("one", true), f.material("two", true)];
  f.configure([checkpointOn(f, pages[0]!, "page one"), endOf(ENDS.refused)]);
  await crashAfterPayment(f, A, pages);
  reopenPlan(f);
  const calls = f.calls(), ledgers = f.store.list("research-budget-ledger").length;
  const second = f.open();
  assert.equal(await code(() => runIn(f, second, A, pages)), "research_plan_subject_invalid",
    "the next page is new work of a replaced plan");
  assert.equal(f.calls(), calls, "the paid page is applied, not bought again, and nothing new is sent");
  assert.equal(second.list("research-budget-ledger").length, ledgers, "no new ledger");
  const session = readSynthesisSessionV3(f.open(), reference(sessionOf(second, "q-supply")));
  assert.equal(session.value.notes.length, 1, "the paid page's note is applied to its own history");
  assert.deepEqual(second.get<any>(session.value.notes[0]!.checkpoint.id)!.value.subject, A);
});

test("S5-01 operator recovery applies the exact paid v3 step on its answered plan anchor; after a real reopen the operator replay, which reproduces its request from today's heads, refuses typed and the paid step applies by its own history", async t => {
  for (const reopen of [false, true]) {
    const f = await paidPlanned(t, `s5r2-operator-${reopen}`);
    const A = subjectOf(f.p.planAnswer, "q-supply");
    f.configure([endOf(ENDS.refused)]);
    await crashAfterPayment(f, A, []);
    if (reopen) reopenPlan(f);
    const intent = f.store.list<any>("research-consumer-intent").find(row => row.value.kind === "synthesis")!;
    const call = f.store.get<any>(intent.value.call.id)!;
    const calls = f.calls(), ledgers = f.store.list("research-budget-ledger").length, before = history(f.store);
    const recover = () => recoverResearchResponse(f.store, f.engine.environments, f.p.project, reference(call),
      intent.value.owner, "operator");
    if (reopen) {
      assert.equal(await code(recover), "response_recovery_binding_stale", "the replay cannot reproduce its request on a moved plan");
      assert.deepEqual(history(f.store), before, "the refused replay wrote nothing");
      assert.deepEqual(await runIn(f, f.open(), A, []), { ...endOf(ENDS.refused), question: "q-supply" },
        "the producer path applies the paid step by its own history");
    } else assert.equal((await recover()).value.state, "applied", "the answered plan anchor is the v7 norm");
    assert.equal(f.calls(), calls, `reopen=${reopen}: no adapter call`);
    assert.equal(f.store.list("research-budget-ledger").length, ledgers, `reopen=${reopen}: no new ledger`);
    const session = readSynthesisSessionV3(f.open(), reference(sessionOf(f.store, "q-supply")));
    assert.deepEqual(session.value.result, { ...endOf(ENDS.refused), question: "q-supply" });
  }
});

test("S5-02 a step lookup carries only its subject's own material: B's own paid note is delivered to B, while B's paid note and B's archive block A's and C's sessions with context_reference_foreign and never enter their workspace", async t => {
  const f = await paidPlanned(t, "s5r2-lookup", ["q-supply", "q-market", "q-third"]);
  const A = subjectOf(f.p.planAnswer, "q-supply"), B = subjectOf(f.p.planAnswer, "q-market"), C = subjectOf(f.p.planAnswer, "q-third");
  const pagesB = [f.material("b1", true), f.material("b2", true)];
  f.configure([checkpointOn(f, pagesB[0]!, "B secret finding"), { action: "pause", reason: "hold B" }]);
  await paidRun(f, B, pagesB);
  const noteB = sessionOf(f.store, "q-market").value.notes[0].checkpoint;
  const archiveB = f.store.list<any>("research-context").find(row => row.value.subject?.planQuestionId === "q-market");
  assert.ok(archiveB, "B's paid step archived its packet under its subject");
  // Positive control: B looks up its own paid note on its next page.
  f.configure([...Array(f.calls()).fill(null), { action: "read_context", record: noteB, pointer: "/proposal", purpose: "B's own finding" },
    { action: "pause", reason: "after own lookup" }]);
  assert.deepEqual(await paidRun(f, B, pagesB), { action: "pause", reason: "after own lookup" });
  assert.ok(sessionOf(f.store, "q-market").value.workspace.entries.some((entry: any) => entry.result?.record?.id === noteB.id),
    "a subject's own paid note is its lawful material");
  for (const [subject, id, record] of [[A, "q-supply", noteB], [C, "q-third", reference(archiveB)]] as [V7PlanSubject, string, Ref][]) {
    f.configure([...Array(f.calls()).fill(null), { action: "read_context", record, pointer: record.id === noteB.id ? "/proposal" : "/body",
      purpose: "another subject's material" }]);
    const calls = f.calls();
    assert.equal(await code(() => paidRun(f, subject, [])), "research_no_progress", id);
    assert.equal(f.calls(), calls + 1, `${id}: one paid lookup, nothing more`);
    const session = sessionOf(f.store, id);
    assert.equal(session.value.blockedCode, "context_reference_foreign", id);
    assert.ok(!session.value.workspace.entries.some((entry: any) => entry.result?.record?.id === record.id), `${id}: never adopted`);
    assert.deepEqual(readSynthesisSessionV3(f.open(), reference(session)), session, `${id}: the reader proves the same blocked step`);
  }
});

test("S5-02 a new v3 basis carries only its subject's own material and previous proposal: B's saved findings, a selection naming B's note, an unaddressed and a non-turn proposal are refused before any record or payment; B's own saved findings pay", async t => {
  const f = await paidPlanned(t, "s5r2-basis");
  const A = subjectOf(f.p.planAnswer, "q-supply"), B = subjectOf(f.p.planAnswer, "q-market");
  const pagesB = [f.material("b1", true), f.material("b2", true)];
  f.configure([checkpointOn(f, pagesB[0]!, "B finding"), { action: "pause", reason: "hold B" }]);
  await paidRun(f, B, pagesB);
  configureV7SavedSynthesis(f.store, f.p.project, B, 0);
  const savedB = savedV7SynthesisMaterials(f.store, f.p.draft, f.p.plan, B)!;
  const noteB = sessionOf(f.store, "q-market").value.notes[0].checkpoint;
  const selection = { kind: "context", value: { record: noteB, pointer: "/proposal", value: { finding: "B finding" } } };
  const calls = f.calls(), before = history(f.store);
  for (const [name, materials, extra] of [["saved findings", [], { savedOnly: true, savedMaterials: savedB }],
    ["selection", [selection], {}],
    ["unaddressed proposal", [], { previousProposal: { action: "answer" }, previousProposalRef: null }],
    ["non-turn proposal", [], { previousProposal: { finding: "B finding" }, previousProposalRef: noteB }]] as [string, unknown[], Record<string, any>][])
    assert.equal(await code(() => paidRun(f, A, materials, extra)), "context_reference_foreign", name);
  assert.deepEqual(history(f.store), before, "a refused basis wrote nothing");
  assert.equal(f.calls(), calls, "and bought nothing");
  f.configure([...Array(calls).fill(null), endOf(ENDS.refused)]);
  assert.deepEqual(await paidRun(f, B, [], { savedOnly: true, savedMaterials: savedB }), { ...endOf(ENDS.refused), question: "q-market" },
    "B's own saved findings are B's lawful basis");
});

test("S5-02 writer ≡ reader on the saved basis: a first record whose materials name another subject's note is refused by the chain reader", async t => {
  const f = await paidPlanned(t, "s5r2-forged-basis");
  const A = subjectOf(f.p.planAnswer, "q-supply"), B = subjectOf(f.p.planAnswer, "q-market");
  const pagesB = [f.material("b1", true), f.material("b2", true)];
  f.configure([checkpointOn(f, pagesB[0]!, "B finding"), { action: "pause", reason: "hold B" }]);
  await paidRun(f, B, pagesB);
  const noteB = sessionOf(f.store, "q-market").value.notes[0].checkpoint;
  // Negative corruption only: the shared projector's first record over B's note, saved without its producer.
  const projected = projectSynthesisSessionV3Initial({ projectId: f.p.project, binding: { draft: reference(f.p.draft),
    question: reference(f.p.plan), environment: reference(f.p.environment), inputs: f.p.draft.value.inputs, subject: A },
    basis: { materials: [{ kind: "context", value: { record: noteB, pointer: "/proposal", value: { finding: "B finding" } } }],
      previousProposal: null, previousProposalRef: null }, delivery: null });
  const forged = f.store.write({ id: projected.id, kind: "synthesis-session", expected: 0, value: projected.value });
  assert.equal(await code(async () => readSynthesisSessionV3(f.open(), reference(forged))), "synthesis_session_invalid");
});

test("S5-03 writer ≡ reader on the inherited runner prefix: A's session inherits exactly A's turns (its own attempt end read by its subject) on a proven reservation and the chain reader proves it; B's session over A's prefix is refused before any record", async t => {
  const f = await paidPlanned(t, "s5r2-prefix");
  const A = subjectOf(f.p.planAnswer, "q-supply"), B = subjectOf(f.p.planAnswer, "q-market");
  // The real runner (no v7 planning settings: the analyst path R) — A first as the blocking plan-question.
  // A second subject's read_context in the same run is not reachable today (the R defect reported to S6),
  // so the prefix carries A's lookup and A's lawful end, and B only pauses.
  f.configure([{ action: "read_context", record: reference(f.p.draft), pointer: "/fields/plan" }, endOf(ENDS.refused), null,
    { action: "pause", reason: "hold B" }]);
  const run = await new Researcher(f.store, new Discovery(f.store), f.engine.environments)
    .run(f.p.project, f.p.draft.id, 8, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(run.value.pauseCode, "research_model_paused", JSON.stringify(run.value));
  const turns = f.store.list<any>("research-turn").filter(row => row.value.run === run.id)
    .sort((a, b) => a.value.number - b.value.number);
  const packetFor = (row: Revision<any>) => {
    const paid = readResearchConsumerExecution(f.store, f.p.project, row.value.consumerIntent);
    return paid.kind === "response" ? paid.subject : null;
  };
  const own = addressedWorkspace(f.store, turns, f.p.plan, packetFor, A);
  assert.equal(own.entries.length, 1, "A's lookup");
  const delivery = { run: run.id, turn: run.value.turns + 1 };
  const reserve = () => { const head = f.store.get<any>(run.id)!;
    return { write: { id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, turns: head.value.turns + 1 } },
      guards: [reference(head)] }; };
  const enter = (subject: V7PlanSubject) => synthesisSession(f.store, f.p.draft, f.p.plan, f.p.environment, f.p.dispatch,
    f.p.pilot, { ...contextOf(subject), workingSelections: [] }, "Synthesize the exact plan-question", undefined,
    { delivery, reserve: reserve(), initialWorkspace: own });
  const before = history(f.store);
  assert.equal(await code(() => enter(B)), "synthesis_session_invalid", "A's turns are not B's prefix");
  assert.deepEqual(history(f.store), before, "the foreign prefix wrote nothing");
  f.configure([...Array(f.calls()).fill(null), endOf(ENDS.impossible)]);
  await code(() => enter(A));
  const session = sessionOf(f.store, "q-supply");
  assert.deepEqual(f.store.get<any>(session.id, 1)!.value.workspace, own, "the first record inherits exactly A's prefix");
  assert.deepEqual(f.store.get<any>(session.id, 1)!.value.delivery, delivery);
  const head = f.store.get<any>(session.id)!;
  assert.deepEqual(readSynthesisSessionV3(f.open(), reference(head)), head, "the chain reader proves the same prefix and reservation");
});

test("S5-03 runner-prefix packet contract: a delivered packet without its research-delivery/v1 contract — missing or foreign — is refused before any record or call; a packet-null turn, an empty delivered set and a lawful real packet inherit", async t => {
  // The positive prefix is the real runner path itself — the same Researcher
  // preparation as the first S5-03 test: the adapter answers every call, the
  // paid machinery writes every intent/claim/dispatch/response/manifest/turn
  // record, and the lawful delivered packet is read back from the store.
  const realRun = (f: Paid, actions: Record<string, any>[], limit = 8) => {
    f.configure(actions);
    return new Researcher(f.store, new Discovery(f.store), f.engine.environments)
      .run(f.p.project, f.p.draft.id, limit, undefined, { producerPolicy: { discovery: 7 } });
  };
  const wires = (f: Paid) => readFileSync(join(f.root, "wire.ndjson"), "utf8")
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  // The packet gate mirrors runnerWorkspaceAt (synthesis-session.ts:416-447)
  // exactly: no origin Ref or a non-analyst/planner origin means packet ===
  // null regardless of the wire, and any saved delivered set — even an empty
  // one — is the packet boundary it records.
  const packetFor = (f: Paid, row: Revision<any>): Record<string, any> | null => {
    const origin = (row.value as { consumerIntent?: unknown }).consumerIntent;
    if (!isRef(origin)) return null;
    const intent = readResearchConsumerIntent(f.store, origin);
    if (!["analyst", "reading-planner"].includes(intent.value.kind)) return null;
    const paid = readResearchConsumerExecution(f.store, f.p.project, origin);
    return paid.kind === "response" && Array.isArray((paid.subject as any)?.contextWorkspace)
      ? paid.subject as Record<string, any> : null;
  };
  const prefix = (f: Paid, run: Revision<ResearchRun>) => {
    const turns = f.store.list<any>("research-turn").filter(row => row.value.run === run.id)
      .sort((a, b) => a.value.number - b.value.number);
    return addressedWorkspace(f.store, turns, f.p.plan, row => packetFor(f, row), subjectOf(f.p.planAnswer, "q-supply"));
  };
  const enter = (f: Paid, run: Revision<ResearchRun>, own: ReturnType<typeof prefix>) => {
    const head = f.store.get<any>(run.id)!;
    const delivery = { run: run.id, turn: head.value.turns + 1 };
    const reserve = () => { const current = f.store.get<any>(run.id)!;
      return { write: { id: current.id, kind: current.kind, expected: current.revision,
        value: { ...current.value, turns: current.value.turns + 1 } }, guards: [reference(current)] }; };
    return synthesisSession(f.store, f.p.draft, f.p.plan, f.p.environment, f.p.dispatch, f.p.pilot,
      { ...contextOf(subjectOf(f.p.planAnswer, "q-supply")), workingSelections: [] },
      "Synthesize the exact plan-question", undefined, { delivery, reserve: reserve(), initialWorkspace: own });
  };
  // Positive: an empty delivered set is still a packet boundary — the real
  // one-turn run's wire carries contextWorkspace: [], so runnerWorkspaceAt
  // records the packet and folds nothing; the session inherits the prefix.
  {
    const f = await paidPlanned(t, "s5r2-packet-empty");
    const run = await realRun(f, [{ action: "read_context", record: reference(f.p.draft), pointer: "/fields/plan" }], 1);
    const own = prefix(f, run);
    assert.equal(own.entries.length, 1, "the read_context turn folds its entry");
    assert.ok(!(own.deliveryCoverage ?? []).length, "the empty packet delivered nothing");
    assert.equal(await code(() => enter(f, run, own)), "no-error",
      "the empty-delivery prefix inherits");
    const session = sessionOf(f.store, "q-supply");
    assert.deepEqual(f.store.get<any>(session.id, 1)!.value.workspace, own);
    const head = f.store.get<any>(session.id)!;
    assert.deepEqual(readSynthesisSessionV3(f.open(), reference(head)), head, "the chain reader proves the same prefix");
  }
  // Positive: a real delivered packet — A's second paid call of the real run
  // carries the folded lookup under research-delivery/v1; the adapter trace
  // proves the actual dispatch and the session inherits the packet's coverage.
  {
    const f = await paidPlanned(t, "s5r2-packet-lawful");
    const run = await realRun(f, [
      { action: "read_context", record: reference(f.p.draft), pointer: "/fields/plan" },
      endOf(ENDS.refused), { action: "pause", reason: "hold B" }]);
    const turns = f.store.list<any>("research-turn").filter(row => row.value.run === run.id)
      .sort((a, b) => a.value.number - b.value.number);
    const packetTurn = turns.find(row => { const packet = packetFor(f, row);
      return packet !== null && (packet.contextWorkspace as unknown[]).length > 0; });
    assert.ok(packetTurn, "the real run produced a packet-bearing paid turn");
    const sent = wires(f).filter(w => Array.isArray(w.subject?.contextWorkspace) && w.subject.contextWorkspace.length
      && w.subject?.working?.deliveryContract === "research-delivery/v1");
    assert.ok(sent.length > 0, "the adapter trace carries the real research-delivery/v1 dispatch");
    const own = prefix(f, run);
    assert.equal(own.entries.length, 1, "the read_context turn folds its entry");
    assert.ok((own.deliveryCoverage ?? []).length > 0, "the real packet records its delivery coverage");
    assert.equal(await code(() => enter(f, run, own)), "no-error", "the lawful packet prefix inherits");
    const session = sessionOf(f.store, "q-supply");
    assert.deepEqual(f.store.get<any>(session.id, 1)!.value.workspace, own);
  }
  // Positive: counted turns whose saved wire carries no delivered packet at
  // all — the planning-enabled real run's read_plan turn (reading-planner,
  // its own lawful v1 packet) queues a managed child that is completed by
  // the engine and never receives a consumerIntent, so the origin gate at
  // synthesis-session.ts:441-446 yields packet === null for it.
  {
    const f = await paidPlanned(t, "s5r2-packet-null", undefined, { planning: true });
    const run = await realRun(f, [
      { action: "read_plan", question: "$q",
        reads: [{ action: "read_context", record: reference(f.p.draft), pointer: "/fields/plan" }] },
      { action: "pause", reason: "hold" }]);
    const turns = f.store.list<any>("research-turn").filter(row => row.value.run === run.id)
      .sort((a, b) => a.value.number - b.value.number);
    const child = turns.find(row => isRef(row.value.plannedBy) && row.value.status === "completed"
      && !row.value.error);
    assert.ok(child, "the real run completed a planned child turn");
    assert.ok(!isRef(child.value.consumerIntent), "the planned child carries no paid origin");
    assert.equal(packetFor(f, child), null,
      "runnerWorkspaceAt reads packet === null for the counted child turn");
    const own = prefix(f, run);
    assert.ok(own.entries.length >= 1, "the child read_context folds its entry");
    assert.equal(await code(() => enter(f, run, own)), "no-error",
      "a lawful packet-free prefix inherits — no delivery door was required");
    const session = sessionOf(f.store, "q-supply");
    assert.deepEqual(f.store.get<any>(session.id, 1)!.value.workspace, own);
    const head = f.store.get<any>(session.id)!;
    assert.deepEqual(readSynthesisSessionV3(f.open(), reference(head)), head, "a new Store reads the same session chain");
  }
  // Corruption-zone helpers — manual record rewriting is allowed only as
  // negative mutation: produce() dispatches through the real paid path
  // (adapter → researchCall), corrupt() rewrites the dependent records by
  // hand over the corrupted bytes.
  const startRun = (f: Paid) => f.store.write<ResearchRun>({ id: `research-run:${hashJson([f.p.project, f.p.draft.id, "packet-contract"])}`,
    kind: "research-run", expected: 0,
    value: { projectId: f.p.project, draftId: f.p.draft.id, environment: reference(f.p.environment), turns: 0, limit: 100,
      requestChars: 0, owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null,
      error: null, pauseCode: null, status: "running", inputs: f.p.draft.value.inputs } });
  const produce = async (f: Paid, run: Revision<ResearchRun>, deliver: boolean) => {
    const subject = subjectOf(f.p.planAnswer, "q-supply");
    const draft = f.store.get<DiscoveryDraft>(f.p.draft.id)!, plan = f.store.get<Question>(f.p.plan.id)!;
    const head = f.store.get<any>(run.id)!, number = head.value.turns + 1;
    const context: Record<string, any> = { role: "research", stage: "discovery", subject, history: [], readings: [],
      ...(deliver ? { contextWorkspace: [exactContextLookup(f.store, draft, plan,
        reference(draft), "/fields/plan", undefined, () => {})] } : {}) };
    const intent = prepareResearchConsumerIntent(f.store, { projectId: f.p.project, kind: "analyst",
      key: hashJson([run.id, number, "analyst"]), owner: reference(head), draft: reference(draft),
      question: reference(plan), role: f.p.environment.value.implementer, dispatch: f.p.environment.value, profile: null,
      cursor: { run: run.id, turn: number, instruction: "Research the exact plan question", context, subject },
      basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(head), reference(draft), reference(plan), reference(f.p.environment)]) });
    f.configure([...Array(f.calls()).fill(null),
      { action: "read_context", record: reference(draft), pointer: "/fields/plan" }]);
    const response = await researchCall(f.p.environment.value.implementer, f.p.environment.value,
      "Research the exact plan question", context, undefined,
      { store: f.store, draftId: draft.id, questionId: plan.id, purpose: "analyst", consumerIntent: reference(intent),
        requestContract: REQUEST_MANIFEST_CONTRACT }) as Record<string, any>;
    const savedIntent = f.store.get<any>(intent.id)!;
    const execution = readResearchConsumerExecution(f.store, f.p.project, reference(savedIntent));
    assert.equal(execution.kind, "response");
    const projected = projectPaidTurnAdmission(head.value, { runId: run.id, intent: reference(intent), response,
      question: reference(plan), owner: head.value.owner, limit: 100, context, subject });
    const turnId = managedTurnId(run.id, number);
    const application = prepareResearchConsumerApplication(f.store, reference(savedIntent), reference(execution.call),
      [{ id: run.id, kind: run.kind, expected: head.revision, value: projected.run },
        { id: turnId, kind: "research-turn", expected: 0, value: projected.turn }],
      [reference(head), reference(f.p.environment), { id: turnId, absent: true }]);
    f.store.writeMany(application.writes, application.guards);
    // A mid-attempt paid step completes by its own read-context proof —
    // no attempt record is written for it.
    const pending = f.store.get<any>(turnId)!, step = turnAction(pending.value) as any;
    assert.equal(step.action, "read_context", "the produced turn is an addressed context read");
    const exact = f.store.get<any>(step.record.id, step.record.revision)!;
    const completed = projectResearchTurnRevision(pending.value,
      { kind: "read-context", recordValue: contextRecordValue(f.store, exact), record: step.record,
        maxChars: f.p.pilot.value.maxRequestChars ?? 300000 });
    f.store.write({ id: turnId, kind: "research-turn", expected: pending.revision, value: completed });
    return f.store.get<any>(turnId)!;
  };
  const corrupt = async (f: Paid, run: Revision<ResearchRun>, lawfulTurn: Revision<any>, kind: "delete" | "foreign") => {
    const subject = subjectOf(f.p.planAnswer, "q-supply");
    const draft = f.store.get<DiscoveryDraft>(f.p.draft.id)!, plan = f.store.get<Question>(f.p.plan.id)!;
    const head = f.store.get<any>(run.id)!, number = head.value.turns + 1;
    const lawfulIntent = f.store.get<any>(lawfulTurn.value.consumerIntent.id)!;
    // The corrupted intent reuses the lawful intent's saved cursor context so
    // the delivered set is the same folded lookup the lawful turn carried.
    const context = lawfulIntent.value.cursor.context as Record<string, any>;
    const intent = prepareResearchConsumerIntent(f.store, { projectId: f.p.project, kind: "analyst",
      key: hashJson([run.id, number, "analyst"]), owner: reference(head), draft: reference(draft),
      question: reference(plan), role: f.p.environment.value.implementer, dispatch: f.p.environment.value, profile: null,
      cursor: { run: run.id, turn: number, instruction: "Research the exact plan question", context, subject },
      basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(head), reference(draft), reference(plan), reference(f.p.environment)]) });
    // The packet is produced by the same real producer the paid path uses —
    // workingContext packs this intent's declared result capacity into the
    // packet and its archive — and only working.deliveryContract is mutated.
    const lawfulPacket = workingContext(f.store, f.p.project, draft.id, plan.id,
      { ...context, resultCapacity: intent.value.cursor.resultCapacity },
      f.p.pilot.value.maxRequestChars ?? 300000, { common: true, purpose: "analyst", subject });
    const { deliveryContract: _removed, ...noContract } = lawfulPacket.working as Record<string, any>;
    const packet = { ...lawfulPacket, working: kind === "foreign"
      ? { ...lawfulPacket.working, deliveryContract: "research-delivery/v0" } : noContract };
    const requestId = `corrupted-${kind}-${hashJson([run.id, number]).slice(0, 12)}`;
    const role = f.p.environment.value.implementer;
    const wire = prepareRequestPartsAndManifest({ store: f.store, projectId: f.p.project, draftId: draft.id,
      requestId, intentRef: reference(intent),
      envelope: { protocol: "omg-agent/v1", requestId, mode: "research", model: role.model,
        effort: role.effort, ...(role.speed !== undefined ? { speed: role.speed } : {}),
        prompt: intent.value.cursor.resultCapacityPrompt },
      subject: packet });
    const pid = process.pid, started = processStart(pid)!;
    const claimWrite = { id: `model-call:consumer:v1:${requestId}`, kind: "model-call" as const, expected: 0,
      value: { projectId: f.p.project, draftId: draft.id, questionId: "q-supply",
        planAnswer: subject.planAnswer, purpose: "analyst", requestId, requested: intent.value.role,
        profile: intent.value.profile, status: "running", startedAt: 1, finishedAt: null, error: null,
        confirmed: { model: null, effort: null, speed: null }, usage: null, usageSource: "unavailable",
        request: { record: wire.manifestRef, hash: digest(wire.input), chars: wire.input.length,
          bytes: Buffer.byteLength(wire.input) },
        response: null, packet: { archive: packet.working.archive }, consumerIntent: reference(intent),
        execution: { version: "model-execution/v1", phase: "claimed", owner: { pid, started }, provider: null },
        ownerProcess: { pid, started } } };
    const reservation = prepareResearchConsumerReservation(f.store, reference(intent), claimWrite,
      wire.manifestRef, packet.working.archive);
    f.store.writeMany([...wire.writes, claimWrite, ...reservation.writes],
      uniqueTransactionGuards([...wire.guards, ...reservation.guards]));
    const claimed = f.store.get<any>(claimWrite.id)!;
    const dispatched = f.store.write<any>({ id: claimed.id, kind: "model-call", expected: claimed.revision,
      value: { ...claimed.value,
        execution: { version: "model-execution/v1", phase: "authorized", owner: { pid, started },
          provider: { pid, started, group: null } },
        providerProcess: { pid, started } } });
    const research = { action: "read_context", record: reference(draft), pointer: "/fields/plan" };
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 };
    const responseText = JSON.stringify({ protocol: "omg-agent/v1", requestId, research, usage });
    const reply = f.store.write<any>({ id: `model-response:${requestId}`, kind: "model-response", expected: 0,
      value: { projectId: f.p.project, draftId: draft.id, text: responseText,
        consumerExecution: { contract: "research-consumer-execution/v1", call: reference(claimed),
          dispatch: reference(dispatched), process: { exitCode: 0, signal: null, stderr: "" } } } });
    f.store.write<any>({ id: claimed.id, kind: "model-call", expected: dispatched.revision,
      value: { ...dispatched.value, status: "succeeded", finishedAt: 2, error: null,
        confirmed: { model: null, effort: null, speed: null }, usage, usageSource: "adapter",
        response: { record: reference(reply), chars: responseText.length,
          bytes: Buffer.byteLength(responseText) } } });
    const savedIntent = f.store.get<any>(intent.id)!;
    const execution = readResearchConsumerExecution(f.store, f.p.project, reference(savedIntent));
    assert.equal(execution.kind, "response");
    const projected = projectPaidTurnAdmission(head.value, { runId: run.id, intent: reference(intent), response: research,
      question: reference(plan), owner: head.value.owner, limit: 100, context, subject });
    const turnId = managedTurnId(run.id, number);
    const application = prepareResearchConsumerApplication(f.store, reference(savedIntent), reference(execution.call),
      [{ id: run.id, kind: run.kind, expected: head.revision, value: projected.run },
        { id: turnId, kind: "research-turn", expected: 0, value: projected.turn }],
      [reference(head), reference(f.p.environment), { id: turnId, absent: true }]);
    f.store.writeMany(application.writes, application.guards);
    const pending = f.store.get<any>(turnId)!, step = turnAction(pending.value) as any;
    const exact = f.store.get<any>(step.record.id, step.record.revision)!;
    const completed = projectResearchTurnRevision(pending.value,
      { kind: "read-context", recordValue: contextRecordValue(f.store, exact), record: step.record,
        maxChars: f.p.pilot.value.maxRequestChars ?? 300000 });
    f.store.write({ id: turnId, kind: "research-turn", expected: pending.revision, value: completed });
    return f.store.get<any>(turnId)!;
  };
  for (const kind of ["delete", "foreign"] as const) {
    const f = await paidPlanned(t, `s5r2-packet-${kind === "delete" ? "missing" : "foreign"}`);
    const run = startRun(f);
    await produce(f, run, false);
    const lawfulTurn = await produce(f, run, true);
    const lawful = packetFor(f, lawfulTurn);
    assert.ok(lawful && lawful.working?.deliveryContract === "research-delivery/v1",
      "the real paid turn saved the lawful packet the corruption mutates");
    const turn = await corrupt(f, run, lawfulTurn, kind);
    const paid = readResearchConsumerExecution(f.store, f.p.project, turn.value.consumerIntent);
    assert.equal(paid.kind, "response");
    assert.ok(paid.kind === "response" && Array.isArray(paid.subject.contextWorkspace),
      "the corrupted packet retains its delivered set");
    const before = history(f.store), calls = f.calls();
    assert.equal(await code(() => enter(f, run, prefix(f, run))), "synthesis_session_invalid",
      kind === "delete" ? "a packet without its contract is no delivery" : "a foreign contract is no delivery");
    assert.deepEqual(history(f.store), before, "the refusal wrote nothing");
    assert.equal(f.calls(), calls, "and paid nothing");
  }
});

test("S5-04 an order of unfinished v3 sessions is proven by reserved positions of one run: a second session on the same proven position is ambiguous, an unreserved position is refused before any record and an unknown run is no session", async t => {
  const f = await paidPlanned(t, "s5r2-order");
  const B = subjectOf(f.p.planAnswer, "q-market");
  f.configure([endOf(ENDS.refused)]);
  const run = await new Researcher(f.store, new Discovery(f.store), f.engine.environments)
    .run(f.p.project, f.p.draft.id, 1, undefined, { producerPolicy: { discovery: 7 } });
  const head = f.store.get<any>(run.id)!, delivery = { run: run.id, turn: head.value.turns + 1 };
  const enter = (materials: unknown[], position: { run: string; turn: number }, reserve?: { write: Write; guards: Ref[] }) =>
    synthesisSession(f.store, f.p.draft, f.p.plan, f.p.environment, f.p.dispatch, f.p.pilot,
      { ...contextOf(B), workingSelections: materials }, "Synthesize the exact plan-question", undefined,
      { delivery: position, ...(reserve ? { reserve } : {}) });
  f.configure([...Array(f.calls()).fill(null), { action: "pause", reason: "hold the reserved task" }]);
  await enter([f.material("first")], delivery, { write: { id: head.id, kind: head.kind, expected: head.revision,
    value: { ...head.value, turns: delivery.turn } }, guards: [reference(head)] });
  const lawful = f.store.list<any>("synthesis-session")[0]!;
  assert.equal(findUnfinishedSynthesisSessionV3(f.store, f.p.project, f.p.draft.id, B)!.session.id, lawful.id);
  // A new task (C has no unfinished session to resume) on a bare number is refused before any record.
  const C = subjectOf(f.p.planAnswer, "q-supply"), bare = f.material("bare");
  const before = history(f.store);
  for (const position of [{ run: run.id, turn: delivery.turn + 5 }, { run: "research-run:missing", turn: 1 }])
    assert.equal(await code(() => synthesisSession(f.store, f.p.draft, f.p.plan, f.p.environment, f.p.dispatch, f.p.pilot,
      { ...contextOf(C), workingSelections: [bare] }, "Synthesize the exact plan-question", undefined,
      { delivery: position })), "synthesis_session_invalid", `${position.run}#${position.turn}: a bare number is no reservation`);
  assert.deepEqual(history(f.store), before, "nothing written over an unproven position");
  // Negative corruption only: the projector's first record of another task of B on the same proven position.
  const projected = projectSynthesisSessionV3Initial({ projectId: f.p.project, binding: { draft: reference(f.p.draft),
    question: reference(f.p.plan), environment: reference(f.p.environment), inputs: f.p.draft.value.inputs, subject: B },
    basis: { materials: [], previousProposal: null, previousProposalRef: null }, delivery });
  f.store.write({ id: projected.id, kind: "synthesis-session", expected: 0, value: projected.value });
  assert.equal(await code(async () => findUnfinishedSynthesisSessionV3(f.store, f.p.project, f.p.draft.id, B)),
    "research_synthesis_ambiguous", "two tasks on one position have no proven order");
});

test("S5 source substitution: a material source replaced in another Store at the application of a paid v3 page refuses without a partial note, and the paid call is not bought again", async t => {
  const f = await paidPlanned(t, "s5r2-source");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  const pages = [f.material("one", true), f.material("two", true)];
  f.configure([checkpointOn(f, pages[0]!, "page one"), endOf(ENDS.refused)]);
  const other = f.open(), source = f.store.get<any>(pages[0]!.value.source.id)!;
  const write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.some(item => item.kind === "research-checkpoint")) {
      changed = true;
      other.write({ id: source.id, kind: "source", expected: source.revision,
        value: { ...source.value, content: "Changed in another Store", sha256: digest("Changed in another Store") } });
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  assert.equal(await code(() => paidRun(f, A, pages)), "synthesis_evidence_stale");
  assert.equal(changed, true);
  assert.deepEqual(f.store.list("research-checkpoint"), [], "no partial note");
  assert.equal(f.calls(), 1, "the paid page is kept and nothing else is bought");
  assert.equal(await code(() => paidRun(f, A, pages)), "synthesis_evidence_stale", "a repeat refuses the same way");
  assert.equal(f.calls(), 1, "still no second payment");
});

/* ---------- круг 3 (codex-omg №8931, оркестратор №8933): absence is a typed refusal, content is re-derived ---------- */

test("S5 круг 3 ОТСУТСТВИЕ: a v3 basis material proves its kind's form and exact content — a missing note reference or evidence original, a changed own note, a reader view without its result, a context value without a record or Source, a changed lookup or Source slice, an unknown kind and a non-object are refused before any record or payment; the exact forms pay", async t => {
  const f = await paidPlanned(t, "s5r3-absence");
  const A = subjectOf(f.p.planAnswer, "q-supply"), B = subjectOf(f.p.planAnswer, "q-market");
  // Real paid notes of A and B and their saved-only projections (the real command and reader).
  const pagesA = [f.material("a1", true), f.material("a2", true)], pagesB = [f.material("b1", true), f.material("b2", true)];
  // A's first session finishes (its note, then an end), so a new basis of A is a new task, not a resumed one.
  f.configure([checkpointOn(f, pagesA[0]!, "A finding"), endOf(ENDS.refused),
    checkpointOn(f, pagesB[0]!, "B finding"), { action: "pause", reason: "hold B" }]);
  await paidRun(f, A, pagesA);
  await paidRun(f, B, pagesB);
  configureV7SavedSynthesis(f.store, f.p.project, A, 0);
  configureV7SavedSynthesis(f.store, f.p.project, B, 0);
  const savedA = savedV7SynthesisMaterials(f.store, f.p.draft, f.p.plan, A)!;
  const savedB = savedV7SynthesisMaterials(f.store, f.p.draft, f.p.plan, B)!;
  const noteA = sessionOf(f.store, "q-supply").value.notes[0].checkpoint;
  const lookupA = exactContextLookup(f.store, f.p.draft, f.p.plan, noteA, "/proposal", undefined,
    record => { readReaderResultAt(f.store, f.p.project, reference(record)); });
  const source = f.material("primary");
  const omitted = structuredClone(savedB) as any[];
  delete omitted[0].value.checkpoint;
  for (const item of omitted[0].value.evidence) delete item.original;
  const changedOwn = structuredClone(savedA) as any[];
  changedOwn[0].value.proposal = { finding: "a different finding beside A's exact reference" };
  const cases: [string, unknown[], Record<string, any>][] = [
    ["saved findings without note reference and evidence originals", [], { savedOnly: true, savedMaterials: omitted }],
    ["own note reference beside other content", [], { savedOnly: true, savedMaterials: changedOwn }],
    ["reader view without its result", [{ kind: "reader", value: { purpose: "x", observations: [], coverage: [], unresolved: [] } }], {}],
    ["context value without a record or Source", [{ kind: "context", value: { pointer: "/proposal", value: { finding: "B finding" } } }], {}],
    ["own lookup with another value", [{ kind: "context", value: { ...lookupA, value: { finding: "B finding" } } }], {}],
    ["Source slice with another value", [{ kind: "context", value: { ...source.value, value: "a forged slice" } }], {}],
    ["unknown kind", [{ kind: "notes", value: { finding: "B finding" } }], {}],
    ["non-object material", [null], {}]];
  const calls = f.calls(), before = history(f.store);
  for (const [name, materials, extra] of cases)
    assert.equal(await code(() => paidRun(f, A, materials, extra)), "context_reference_foreign", name);
  assert.deepEqual(history(f.store), before, "a refused basis wrote nothing");
  assert.equal(f.calls(), calls, "and bought nothing");
  // The exact forms are lawful: A's own saved findings, A's own exact lookup with a primary Source slice.
  f.configure([...Array(calls).fill(null), endOf(ENDS.duplicate), endOf(ENDS.impossible)]);
  assert.deepEqual(await paidRun(f, A, [], { savedOnly: true, savedMaterials: savedA }), { ...endOf(ENDS.duplicate), question: "q-supply" },
    "A's own exact saved findings pay");
  assert.deepEqual(await paidRun(f, A, [{ kind: "context", value: lookupA }, source]), { ...endOf(ENDS.impossible), question: "q-supply" },
    "A's exact lookup of its own note and an exact Source slice are A's lawful basis");
});

test("S5-05 the previous proposal of a v3 basis is a paid turn proven by the common turn reader: a forged same-subject turn is refused before any record or payment; A's own paid turn from the real runner is accepted", async t => {
  const f = await paidPlanned(t, "s5r3-proposal");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  f.configure([endOf(ENDS.refused), null, { action: "pause", reason: "hold B" }]);
  const run = await new Researcher(f.store, new Discovery(f.store), f.engine.environments)
    .run(f.p.project, f.p.draft.id, 8, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(run.value.pauseCode, "research_model_paused", JSON.stringify(run.value));
  const paidTurn = f.store.list<any>("research-turn").find(row => row.value.run === run.id && row.value.subject?.planQuestionId === "q-supply")!;
  const material = f.material("a");
  const action = { ...checkpointOn(f, material, "unpaid fabricated previous finding"), question: "q-supply" };
  // Negative corruption only: a same-subject turn record with no producer, paid intent or run.
  const forged = f.store.write({ id: "research-turn:forged-proposal", kind: "research-turn", expected: 0,
    value: { run: "research-run:missing", number: 1, question: reference(f.p.plan), subject: A, action, status: "completed",
      assessment: null, observation: null, error: null } });
  const calls = f.calls(), before = history(f.store);
  assert.equal(await code(() => paidRun(f, A, [], { previousProposal: action, previousProposalRef: reference(forged) })),
    "context_reference_foreign", "the form of a turn is not its paid origin");
  assert.equal(await code(() => paidRun(f, A, [], { previousProposal: action, previousProposalRef: reference(paidTurn) })),
    "context_reference_foreign", "a proven turn does not carry another proposal");
  assert.deepEqual(history(f.store), before);
  assert.equal(f.calls(), calls);
  f.configure([...Array(calls).fill(null), endOf(ENDS.impossible)]);
  assert.deepEqual(await paidRun(f, A, [], { previousProposal: turnAction(paidTurn.value), previousProposalRef: reference(paidTurn) }),
    { ...endOf(ENDS.impossible), question: "q-supply" }, "A's own paid turn is a lawful previous proposal");
});

test("S5 loss of a required page (projector): a final answer over an addressed value whose packet delivered only part of it is context-incomplete — no result, the exact address and next kept; the complete delivery is the result", async t => {
  const f = await paidPlanned(t, "s5r3-incomplete");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  const page = f.material("only");
  // A real paid note of A with a large exact value, on A's final page; the session then pauses.
  f.configure([checkpointOn(f, page, "x".repeat(9000)), { action: "pause", reason: "hold the final page" }]);
  await paidRun(f, A, [page]);
  const head = f.store.get<any>(sessionOf(f.store, "q-supply").id)!;
  const noteA = head.value.notes[0].checkpoint;
  const pauseIntent = f.store.list<any>("research-consumer-intent").filter(row => row.value.kind === "synthesis")
    .sort((a, b) => b.value.cursor.offset - a.value.cursor.offset || b.revision - a.revision)[0]!;
  const paid = readResearchConsumerExecution(f.store, f.p.project, reference(pauseIntent));
  assert.equal(paid.kind, "response");
  const archive = f.store.get<any>((paid as any).archive.id, (paid as any).archive.revision)!.value.body;
  const lookup = exactContextLookup(f.store, f.p.draft, f.p.plan, noteA, "/proposal/value/finding", undefined,
    record => { readReaderResultAt(f.store, f.p.project, reference(record)); });
  const before = { ...head.value, workspace: addContextLookup(contextWorkspace(), lookup), focus: null };
  const transition = (maxChars: number, keepChars: number) => {
    // The delivery of the addressed value is packed alone (as RD2b packs it) and carried by the step's real packet.
    const delivered: Record<string, any> = { contextWorkspace: [lookup],
      working: { archive: lookup.record, deliveryContract: "research-delivery/v1" } };
    packContextWorkspace(delivered, maxChars, keepChars);
    const packet: Record<string, any> = { ...structuredClone((paid as any).subject),
      working: { ...(paid as any).subject.working, deliveryContract: "research-delivery/v1" } };
    for (const key of ["contextWorkspace", "contextDelivery", "contextIndex"])
      if (Object.hasOwn(delivered, key)) packet[key] = delivered[key];
    return projectSynthesisTransition({ store: f.store, projectId: f.p.project, kind: "synthesis", sessionId: head.id, before,
      draft: reference(f.p.draft), question: reference(f.p.plan), delivery: null, subject: packet,
      payload: { ...endOf(ENDS.refused), question: "q-supply" }, archive, readLimit: 200000,
      proveRecord: record => { readReaderResultAt(f.store, f.p.project, reference(record)); },
      subjectRecord: (record, bound) => subjectContextRecordHolds(f.store, f.p.project, f.p.draft.id, bound, record) });
  };
  const partial = transition(4000, 3000);
  assert.equal(partial.kind, "context-incomplete");
  assert.equal(partial.session.result, null, "no result over an undelivered required page");
  assert.equal((partial.session as any).contextCorrection.code, "research_context_incomplete");
  assert.deepEqual((partial.session as any).contextCorrection.record, noteA, "the exact address is kept");
  assert.ok((partial.session as any).contextCorrection.next > 0 && (partial.session as any).contextCorrection.next < 9000,
    "and the exact next position");
  const complete = transition(40000, 30000);
  assert.equal(complete.kind, "result");
  assert.deepEqual(complete.session.result, { ...endOf(ENDS.refused), question: "q-supply" });
});

test("S5 terminal/application conflict: two Stores apply one paid response — another Store's identical application commits first, the loser's write conflicts and returns the winner's result; one application, one call, no new ledger", async t => {
  const f = await paidPlanned(t, "s5r3-race");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  f.configure([endOf(ENDS.refused)]);
  await crashAfterPayment(f, A, []);
  const loser = f.open(), competitor = f.open();
  const write = loser.writeMany.bind(loser); let raced = false;
  loser.writeMany = ((writes: Write[], guards = []) => {
    if (!raced && writes.some(item => item.kind === "research-consumer-intent" && (item.value as any).state === "applied")) {
      raced = true;
      competitor.writeMany(writes, guards); // the same lawful application, committed by another Store first
    }
    return write(writes, guards);
  }) as typeof loser.writeMany;
  const calls = f.calls(), ledgers = f.store.list("research-budget-ledger").length;
  assert.deepEqual(await runIn(f, loser, A, []), { ...endOf(ENDS.refused), question: "q-supply" });
  assert.equal(raced, true, "the competing application really raced the write");
  const intent = f.store.list<any>("research-consumer-intent").find(row => row.value.kind === "synthesis")!;
  assert.deepEqual(f.store.history<any>(intent.id).map(step => step.value.state), ["prepared", "running", "applied"],
    "the paid step is applied once");
  const session = sessionOf(f.store, "q-supply");
  assert.equal(session.revision, 2, "one application of the session");
  assert.equal(f.calls(), calls, "no new call");
  assert.equal(f.store.list("research-budget-ledger").length, ledgers, "no new ledger");
  assert.deepEqual(readSynthesisSessionV3(f.open(), reference(session)), session);
});

/* ---------- круг 4 (codex-omg №9033): the producers' own material forms, re-derived; a wrong kind refuses typed ---------- */

for (const mode of ["search", "read", "read_source", "read_context"] as const)
  test(`S5-06 a lawful ${mode} material of the real runner reaches A's synthesis through workingSelections(A) and pays; its substituted bytes or missing proof are refused before any record or payment`, async t => {
    const f = await paidPlanned(t, `s5r4-${mode.replaceAll("_", "-")}`);
    const A = subjectOf(f.p.planAnswer, "q-supply");
    const source = f.material("exact");
    if (mode === "read") writeFileSync(join(f.p.environment.value.workspace, "local-source.txt"), "A true local source with enough content to read.");
    const action = mode === "search" ? { action: "search", query: "Exact source" }
      : mode === "read" ? { action: "read", path: "local-source.txt", media: "text/plain" }
      : mode === "read_context" ? { action: "read_context", record: reference(f.p.draft), pointer: "/fields/plan" }
      : { action: "read_source", source: source.value.source, start: 0, end: String(source.value.value).length };
    f.configure([action, { action: "pause", reason: "stop after the real material" }]);
    const run = await new Researcher(f.store, new Discovery(f.store), f.engine.environments)
      .run(f.p.project, f.p.draft.id, 8, undefined, { producerPolicy: { discovery: 7 } });
    assert.equal(run.value.pauseCode, "research_model_paused", JSON.stringify(run.value));
    const turns = f.store.list<any>("research-turn").filter(row => row.value.run === run.id);
    const materials = workingSelections(f.store, turns, f.p.plan, A) as any[];
    assert.equal(materials.length, 1, "the real material is selected for A");
    const [material] = materials;
    const changed = (patch: (value: any) => any) => [{ ...material, value: patch(structuredClone(material.value)) }];
    const forgeries: [string, unknown[]][] = mode === "search"
      ? [["repository matches", changed(value => ({ ...value, repositoryMatches: `${value.repositoryMatches} forged` }))],
        ["missing capture", changed(({ capture: _capture, ...value }) => value)]]
      : mode === "read"
      ? [["excerpt", changed(value => ({ ...value, excerpt: "a forged excerpt" }))],
        ["length", changed(value => ({ ...value, length: value.length + 1 }))]]
      : mode === "read_context"
      ? [["value", changed(value => ({ ...value, value: { forged: true } }))],
        ["missing record", changed(({ record: _record, ...value }) => value)]]
      : [["slice", changed(value => ({ ...value, value: "a forged slice" }))],
        ["missing request", changed(({ requested: _requested, ...value }) => value)]];
    const calls = f.calls(), before = history(f.store);
    for (const [name, forged] of forgeries)
      assert.equal(await code(() => paidRun(f, A, forged)), "context_reference_foreign", `${mode}: ${name}`);
    assert.deepEqual(history(f.store), before, "a refused material wrote nothing");
    assert.equal(f.calls(), calls, "and bought nothing");
    f.configure([...Array(calls).fill(null), endOf(ENDS.refused)]);
    assert.deepEqual(await paidRun(f, A, materials), { ...endOf(ENDS.refused), question: "q-supply" },
      `the exact ${mode} material is A's lawful basis`);
  });

test("S5-07 a saved finding naming a record of another kind is a typed refusal: the writer refuses a Source used as the note before any record or payment, and the chain reader refuses such a saved basis", async t => {
  const f = await paidPlanned(t, "s5r4-kind");
  const A = subjectOf(f.p.planAnswer, "q-supply");
  const source = f.material("basis");
  const wrong = [{ kind: "saved-findings", value: { checkpoint: source.value.source } }];
  const calls = f.calls(), before = history(f.store);
  assert.equal(await code(() => paidRun(f, A, [], { savedOnly: true, savedMaterials: wrong })), "context_reference_foreign");
  assert.deepEqual(history(f.store), before);
  assert.equal(f.calls(), calls);
  // Negative corruption only: the projector's first record over that basis, saved without its producer.
  const projected = projectSynthesisSessionV3Initial({ projectId: f.p.project, binding: { draft: reference(f.p.draft),
    question: reference(f.p.plan), environment: reference(f.p.environment), inputs: f.p.draft.value.inputs, subject: A },
    basis: { materials: wrong, previousProposal: null, previousProposalRef: null }, delivery: null });
  const forged = f.store.write({ id: projected.id, kind: "synthesis-session", expected: 0, value: projected.value });
  assert.equal(await code(async () => readSynthesisSessionV3(f.open(), reference(forged))), "synthesis_session_invalid");
});

/* ---------- круг 5 (codex-omg №9102): a search capture is proven by its paid turn's completion ---------- */

for (const variant of ["missing origin", "unknown contract"] as const)
  test(`S5-08 a search material whose capture has ${variant} is refused before any record or payment: the capture is proven only as the one its paid search turn's completion produced`, async t => {
    const f = await paidPlanned(t, `s5r5-${variant.replace(" ", "-")}`);
    const A = subjectOf(f.p.planAnswer, "q-supply");
    f.configure([{ action: "search", query: "Exact source" }, { action: "pause", reason: "stop after the real capture" }]);
    const run = await new Researcher(f.store, new Discovery(f.store), f.engine.environments)
      .run(f.p.project, f.p.draft.id, 8, undefined, { producerPolicy: { discovery: 7 } });
    assert.equal(run.value.pauseCode, "research_model_paused", JSON.stringify(run.value));
    const [material] = workingSelections(f.store, f.store.list<any>("research-turn").filter(row => row.value.run === run.id),
      f.p.plan, A) as any[];
    const capture = f.store.get<any>(material.value.capture.id, material.value.capture.revision)!;
    const value = structuredClone(capture.value);
    if (variant === "missing origin") for (const field of ["turn", "run", "consumerIntent", "plannedBy"]) delete value[field];
    else value.contract = "research-search-capture/unknown";
    // Negative corruption only: a re-addressed capture record no lawful producer wrote.
    const forged = f.store.write({ id: `research-search-capture:v1:${hashJson(value)}`, kind: "research-search-capture",
      expected: 0, value });
    const materials = [{ ...material, value: { ...value.observation, capture: reference(forged) } }];
    const calls = f.calls(), before = history(f.store);
    f.configure([...Array(calls).fill(null), endOf(ENDS.refused)]);
    assert.equal(await code(() => paidRun(f, A, materials)), "context_reference_foreign");
    assert.equal(f.calls(), calls, "nothing bought");
    assert.deepEqual(history(f.store), before, "nothing written");
    // The real capture itself stays A's lawful search material.
    f.configure([...Array(calls).fill(null), endOf(ENDS.impossible)]);
    assert.deepEqual(await paidRun(f, A, [material]), { ...endOf(ENDS.impossible), question: "q-supply" });
    // Negative corruption only, the reader half: the projector's first record over the forged basis.
    const projected = projectSynthesisSessionV3Initial({ projectId: f.p.project, binding: { draft: reference(f.p.draft),
      question: reference(f.p.plan), environment: reference(f.p.environment), inputs: f.p.draft.value.inputs, subject: A },
      basis: { materials, previousProposal: null, previousProposalRef: null }, delivery: null });
    const saved = f.store.write({ id: projected.id, kind: "synthesis-session", expected: 0, value: projected.value });
    assert.equal(await code(async () => readSynthesisSessionV3(f.open(), reference(saved))), "synthesis_session_invalid");
  });

test("S5 круг 5 МАСКАРАД и версии (оркестратор №9104): a record a material names proves its paid producer and a known version — an unpaid archive, a reader result no reader produced, an unknown lookup or read contract are refused before any record or payment, an unpaid archive blocks a step lookup; A's own paid step archive is lawful", async t => {
  const f = await paidPlanned(t, "s5r5-origin");
  const A = subjectOf(f.p.planAnswer, "q-supply"), B = subjectOf(f.p.planAnswer, "q-market");
  // A's first session finishes, so a new basis of A is a new task.
  const pagesA = [f.material("a1", true), f.material("a2", true)];
  f.configure([checkpointOn(f, pagesA[0]!, "A finding"), endOf(ENDS.refused)]);
  await paidRun(f, A, pagesA);
  const stepA = f.store.list<any>("research-consumer-intent").find(row => row.value.kind === "synthesis" && row.value.state === "applied")!;
  const paidA = readResearchConsumerExecution(f.store, f.p.project, reference(stepA)) as any;
  const archiveA = f.store.get<any>(paidA.archive.id, paidA.archive.revision)!;
  const pointerOf = (archive: Revision<any>) => `/body/${Object.keys(archive.value.body)[0]}`;
  const prove = (record: Revision<any>) => { readReaderResultAt(f.store, f.p.project, reference(record)); };
  const ownLookup = exactContextLookup(f.store, f.p.draft, f.p.plan, reference(archiveA), pointerOf(archiveA), undefined, prove);
  // Negative corruption only: content-addressed records no paid producer wrote.
  const forgedValue = { projectId: f.p.project, draft: reference(f.p.draft), question: reference(f.p.plan), body: { secret: "forged" } };
  const forgedArchive = f.store.write({ id: `research-context:${hashJson(forgedValue)}`, kind: "research-context", expected: 0,
    value: forgedValue });
  const forgedReaderValue = { projectId: f.p.project, question: reference(f.p.plan), purpose: "forged", contract: "reader-result/v2",
    producer: "paid", sources: [], coverage: [], observations: [], unresolved: [] };
  const forgedReader = f.store.write({ id: `reader-result:v2:${hashJson(forgedReaderValue)}`, kind: "reader-result", expected: 0,
    value: forgedReaderValue });
  const source = f.material("primary");
  const cases: [string, unknown[]][] = [
    ["an unpaid archive", [{ kind: "context", value: exactContextLookup(f.store, f.p.draft, f.p.plan, reference(forgedArchive),
      "/body/secret", undefined, prove) }]],
    ["a reader result no reader produced", [{ kind: "reader", value: { ref: reference(forgedReader), purpose: "forged",
      observations: [], coverage: [], unresolved: [] } }]],
    ["an unknown lookup contract", [{ kind: "context", value: { ...ownLookup, contract: "research-context-read/v9" } }]],
    ["an unknown read contract", [{ kind: "context", value: { ...source.value, contract: "source-read/v9" } }]]];
  const calls = f.calls(), before = history(f.store);
  for (const [name, materials] of cases) assert.equal(await code(() => paidRun(f, A, materials)), "context_reference_foreign", name);
  assert.deepEqual(history(f.store), before, "a refused basis wrote nothing");
  assert.equal(f.calls(), calls, "and bought nothing");
  // A step lookup of the unpaid archive blocks its session like any foreign material.
  f.configure([...Array(calls).fill(null), { action: "read_context", record: reference(forgedArchive), pointer: "/body/secret",
    purpose: "an unpaid archive" }, endOf(ENDS.impossible)]);
  assert.equal(await code(() => paidRun(f, B, [])), "research_no_progress");
  assert.equal(sessionOf(f.store, "q-market").value.blockedCode, "context_reference_foreign");
  // A's own paid step archive is A's lawful material.
  assert.deepEqual(await paidRun(f, A, [{ kind: "context", value: ownLookup }]), { ...endOf(ENDS.impossible), question: "q-supply" });
});

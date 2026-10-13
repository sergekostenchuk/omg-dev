import { configurePhasePolicy } from "../src/discovery/phase-policy.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EngineError } from "../src/errors.js";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { configureReaderPilot, pilotEnvironment, type ReaderPilot, type ReaderPilotSettings } from "../src/discovery/reader-pilot.js";
import { numberedSource, readerSourcePacket, readerObservations, readBundle } from "../src/discovery/reader.js";
import { pilotContext, readPilotContext } from "../src/discovery/pilot-context.js";
import { reference, isRef, type Ref } from "../src/pipeline/contracts.js";
import { canonical, digest, hashJson } from "../src/canonical.js";
import { preparedFeatures } from "./product-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { projectGraph } from "../src/graph/project.js";
import type { Question, DiscoveryDraft } from "../src/discovery/discovery.js";
import type { ModelCall } from "../src/runtime/model-usage.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { layerDesignOf, layerDesignSpec } from "../src/graph/layer-design.js";
import { expandLayerDelta, layerDeltaCandidate, layerDeltaView } from "../src/discovery/layer-delta.js";
import type { ConsumerResult } from "../src/discovery/consumer-research.js";
import type { Json } from "../src/canonical.js";
import { answerLayerFixture } from "./layer-design-fixture.js";
import type { ResearchRun, ResearchTurn } from "../src/discovery/research-model.js";
import { modelUsage } from "../src/runtime/model-usage.js";
import { contextTable, targetFieldGroups, type ContextTable } from "../src/discovery/context-tables.js";
import { workingContext } from "../src/discovery/working-context.js";
import { checkpoint, latestProposal, recoverableAnswer, workingSelections } from "../src/discovery/research-continuation.js";
import { assessAnswer } from "../src/discovery/research-assessment.js";
import { assessmentSession } from "../src/discovery/assessment-session.js";
import { researchAction, researchCall } from "../src/discovery/research-protocol.js";
import { replayLimitedResponse } from "../src/discovery/response-replay.js";
import { synthesisSession, pendingSynthesis } from "../src/discovery/synthesis-session.js";
import { recoverableReadingPlan } from "../src/discovery/planning-recovery.js";
import { ResearchSources } from "../src/discovery/research-sources.js";
import { withInvocationAllowance } from '../src/discovery/invocation-progress.js';
import { readResearchConsumerIntent, readResearchConsumerTurn, readManagedProposalRefusalAt,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { retryPlannedRead } from '../src/discovery/reading-plan.js';
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { reusableReaderRanges, priorReaderIndex, bindReaderResultProof } from "../src/discovery/reader-reuse.js";
import { retainPilotRead } from "../src/discovery/pilot-context.js";
import { latestFocus } from "../src/discovery/research-continuation.js";
import { readReaderResultAt, type ReaderResult } from "../src/discovery/reader.js";

function records<T>(value: T[] | ContextTable): T[] {
  return Array.isArray(value) ? value : value.rows.map(row => Object.fromEntries(value.columns.map((column, index) => [column, row[index]])) as T);
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-reader-pilot-"));
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const full = enrichedGraph(exampleGraph("p"), "p"); preparedFeatures(engine, "p", full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save("p", initial, store.get("graph:p")!.revision, "fixture");
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = engine.environments.configure("p", { workspace: root,
    implementer: { actor: "author", model: "fixture-author", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture-assessor", effort: "high", command }, fullCheck: command, timeoutMs: 3000 }, 0);
  const readerPath = join(root, "reader.mjs");
  writeFileSync(join(root, "README.md"), "Planned runtime\nRestrict writes to the chosen scope.\nRoll back on failure.\n");
  writeFileSync(readerPath, `import {readFileSync,appendFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
appendFileSync('calls.jsonl',JSON.stringify({role:c.role,field:c.question?.field,fullGraph:Boolean(c.value?.nodes),delta:Boolean(c.value?.upserts)})+'\\n');
let research;
if(c.role==='reader'&&c.sources.some(s=>JSON.stringify(s.lineColumns)!=='["line","text"]'||s.lines.some(line=>!Array.isArray(line)||line.length!==2)))throw Error('Reader wire must use explicit line/text columns');
if(c.role!=='reader'&&c.dispatchMode!=='planning'&&c.continuation?.kind!=='continuation'&&(!c.contextEncoding||Object.keys(c).indexOf('core')>Object.keys(c).indexOf('question')))throw Error('Stable product context must precede the question');
if(c.role==='reader'){const lines=c.sources[0].lines.filter(line=>line[0]>=2&&line[0]<=3);research={selections:lines.length?[{source:c.sources[0].ref,firstLine:lines[0][0],lastLine:lines.at(-1)[0]}]:[],unresolved:lines.length?[]:['No additional runtime conditions in this supplied window']};}
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'read_bundle',purpose:'Read runtime conditions',inputs:[{path:'README.md',media:'text/plain'}]}]};
else if(!c.readings.length)research={action:'read_bundle',purpose:'Read the scoped runtime conditions',inputs:[{path:'README.md',media:'text/plain'}]};
else if(c.question.field==='layerDesign')research={action:'answer_delta',question:c.question.id,base:c.graphBase,...JSON.parse(readFileSync('delta.json','utf8')),citations:c.readings[0].observations.map(o=>({source:o.source,selector:o.selector}))};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'A scoped local product',facts:[{id:c.question.field+'-fact',claim:'README defines scope and rollback',path:'README.md'}],designs:[{id:c.question.field+'-design',decision:'Apply the defined scope and rollback',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:c.readings[0].observations.map(o=>({source:o.source,selector:o.selector}))};
const response={protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:100,outputTokens:25,cachedInputTokens:0,reasoningOutputTokens:5}};
if(existsSync('bad-consumer')&&research.action==='answer')research.value.designs[0].consumer='invented-consumer';
if(existsSync('omit-usage'))delete response.usage;
console.log(JSON.stringify(response));`);
  const settings: ReaderPilotSettings = { experimental: true, active: true, stopAfter: "L2",
    reader: { actor: "reader", model: "fixture-reader", effort: "high", speed: "fast", command: { executable: process.execPath, args: [readerPath] } },
    agentCommand: { executable: process.execPath, args: [readerPath] }, maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000, maxCalls: 20, maxReportedTokens: 100000 };
  const pilot = configureReaderPilot(store, engine.environments, "p", settings, 0);
  const r0 = engine.refinement.begin("p", "R0"); engine.refinement.finishResearch("p", "R0", reference(r0), 0); engine.refinement.sealLayer("p", 1, 0);
  const draft = engine.refinement.begin("p", "R1"); const question = store.get<Question>(draft.value.questions[0]!)!;
  return { root, store, engine, environment, settings, pilot, draft, question, full };
}

test("reader returns exact source coordinates; the engine extracts originals and records the chosen reader", async t => {
  const { root, store, engine, environment, pilot, question } = fixture(t);
  const text = "Header\r\nЗапись запрещена вне scope.\r\nПри ошибке откатить результат.\n";
  writeFileSync(join(root, "runtime.txt"), text);
  const source = engine.discovery.evidence.file("p", "runtime", root, "runtime.txt", "text/plain", 0);
  const result = await readBundle(store, environment.value, pilot, reference(question), "Read authority and failure conditions",
    [{ source: reference(source) }]);
  assert.equal(result.value.observations.length, 1);
  assert.equal(result.value.observations[0]!.value, text.slice("Header\r\n".length));
  assert.ok(engine.discovery.evidence.verify(result.value.observations[0]!));
  const call = store.list<ModelCall>("model-call")[0]!;
  assert.equal(call.value.purpose, "reader"); assert.equal(call.value.requested.model, "fixture-reader");
  assert.equal(call.value.requested.speed, "fast"); assert.equal(call.value.usage!.inputTokens, 100);
  assert.equal(store.get<Question>(question.id)!.value.status, "open", "Reading does not accept an answer or stage");
  assert.deepEqual(engine.environments.get("p"), environment, "The experimental assignment does not rewrite accepted environment history");
  assert.equal(pilotEnvironment(environment.value, pilot.value).implementer.actor, "author");
});

test("compact reader packets preserve every visible character and original selection coordinates", t => {
  const { root, engine, store } = fixture(t);
  const text = "Header\r\n" + "Условие 😀: разрешено только внутри scope.\r\n".repeat(30) + "Последняя строка";
  writeFileSync(join(root, "compact.txt"), text);
  const source = engine.discovery.evidence.file("p", "compact", root, "compact.txt", "text/plain", 0);
  for (const range of [{ start: 0, end: text.length }, { start: 11, end: text.length - 3 }]) {
    const supplied = numberedSource(source, range);
    const packet = readerSourcePacket(supplied);
    assert.deepEqual(packet.ref, reference(source));
    assert.deepEqual(packet.visibleRange, range);
    assert.equal(packet.totalChars, text.length);
    assert.equal(packet.partial, range.start !== 0 || range.end !== text.length);
    assert.deepEqual(packet.lineColumns, ["line", "text"]);
    assert.equal(packet.lines.map(([, text]) => text).join(""), text.slice(range.start, range.end));
    assert.ok(canonical(packet).length < canonical(supplied).length * 0.8, "Repeated offsets and object keys are omitted from the wire");
    for (const [line, original] of packet.lines) {
      const selected = readerObservations(store, "p", [supplied], {
        selections: [{ source: packet.ref, firstLine: line, lastLine: line }], unresolved: [],
      }, 10000);
      assert.equal(selected.observations[0]!.value, original);
      assert.ok(engine.discovery.evidence.verify(selected.observations[0]!));
    }
  }
});

test("reader cannot replace evidence with a summary, choose foreign ranges, or return changed source bytes", t => {
  const { root, engine, store } = fixture(t);
  writeFileSync(join(root, "source.txt"), "one\ntwo\nthree\n");
  const source = engine.discovery.evidence.file("p", "source", root, "source.txt", "text/plain", 0);
  const supplied = [numberedSource(source)];
  const response = { selections: [{ source: reference(source), firstLine: 1, lastLine: 2 }], unresolved: [] };
  assert.throws(() => readerObservations(store, "p", supplied, { ...response, summary: "Trust my paraphrase" }, 10000), { code: "reader_response_invalid" });
  assert.throws(() => readerObservations(store, "p", supplied, { selections: [], unresolved: [] }, 10000), { code: "reader_response_empty" });
  assert.throws(() => readerObservations(store, "p", supplied, { ...response, selections: [{ ...response.selections[0]!, lastLine: 9 }] }, 10000), { code: "reader_selection_foreign" });
  assert.throws(() => readerObservations(store, "p", supplied, response, 1), { code: "reader_output_limit" });
  writeFileSync(join(root, "source.txt"), "changed\n");
  assert.throws(() => readerObservations(store, "p", supplied, response, 10000), { code: "source_stale" });
});

test("partial reader windows keep original offsets and cannot be presented as a full source", t => {
  const { root, store, engine } = fixture(t);
  const text = "first\nsecond\nthird\n";
  writeFileSync(join(root, "window.txt"), text);
  const source = engine.discovery.evidence.file("p", "window", root, "window.txt", "text/plain", 0);
  const window = numberedSource(source, { start: 8, end: 16 });
  assert.equal(window.partial, true); assert.equal(window.totalChars, text.length);
  const response = { selections: [{ source: reference(source), firstLine: 2, lastLine: 3 }], unresolved: [] };
  const result = readerObservations(store, "p", [window], response, 10000);
  assert.equal(result.observations[0]!.value, text.slice(8, 16));
  assert.deepEqual(result.observations[0]!.selector, { kind: "text-range", start: 8, end: 16 });
  assert.throws(() => readerObservations(store, "p", [window], { ...response, selections: [{ ...response.selections[0]!, firstLine: 1 }] }, 10000),
    { code: "reader_selection_foreign" });
});

test("pilot packet preserves global constraints and exposes exact bound context instead of full contract schemas", t => {
  const { store, draft, question } = fixture(t);
  const packet = pilotContext(store, draft, question);
  assert.ok(packet.core.constraints.length > 0); assert.ok(packet.core.requirements.length > 0);
  assert.ok(records(packet.map.connectors).length > 0); assert.ok(records(packet.map.journeys).length > 0);
  assert.ok(packet.map.contracts.every(contract => !Object.hasOwn(contract, "schema")));
  const selected = packet.map.contracts[0]!;
  const detail = readPilotContext(store, draft, packet.map.ref, selected.pointer, 10000);
  assert.equal(canonical(detail.value).length, selected.chars);
  assert.throws(() => readPilotContext(store, draft, { ...packet.map.ref, hash: "f".repeat(64) }, selected.pointer, 10000), { code: "context_reference_foreign" });
  assert.throws(() => readPilotContext(store, draft, packet.map.ref, "/projection/absent", 10000), { code: "context_missing" });
  assert.throws(() => readPilotContext(store, draft, packet.map.ref, selected.pointer, 1), { code: "context_read_limit" });
});

test("compact context preserves nulls, unknown properties, Unicode and heterogeneous record shapes", () => {
  const original = Array.from({ length: 20 }, (_, index) => ({ identifier: `n-${index}`,
    exactCondition: "Не писать вне области. Исключение: только по разрешению.\r\n😀", optionalValue: null,
    futureField: { nested: [false, 0, "", { columns: ["literal"], rows: [["source data"]] }] } }));
  const packed = contextTable(original);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(original).length);
  assert.deepEqual(records(packed), original);
  const mixed = [{ id: "a", present: null }, { id: "b" }];
  assert.deepEqual(records(contextTable(mixed)), mixed, "Absent and null are not interchangeable");
  assert.deepEqual(contextTable([]), []);
  const targets = [{ id: "one", condition: "a" }, { id: "two", condition: "b" }, { id: "three", other: 1 }];
  const groups = targetFieldGroups(targets);
  assert.equal(groups.length, 2);
  for (const target of targets) assert.deepEqual(groups.find(group => group.targets.includes(target.id))!.fields, Object.keys(target).sort());
});

test("R1 and L2 retain all requirement criteria and transition conditions with a stable prefix", t => {
  const { store, draft, question } = fixture(t);
  const before = pilotContext(store, draft, question);
  const fields = store.get<any>("stage:p:concept")!.value.content.fields;
  assert.deepEqual(before.core.requirements.map((section: any) => ({ ...section, requirements: records(section.requirements) })), fields.conceptSections);
  assert.deepEqual(before.core.acceptance, fields.acceptance);
  assert.deepEqual(before.core.specificationConstraints, store.get<any>("stage:p:specification")!.value.content.fields.constraints);
  for (const edge of records<any>(before.map.controls)) {
    const detail = readPilotContext(store, draft, before.map.ref, edge.pointer, 10000).value as any;
    assert.equal(edge.condition, detail.condition);
    assert.equal(edge.source, detail.source); assert.equal(edge.target, detail.target);
  }
  const next = store.get<Question>(draft.value.questions[1]!)!;
  const changedDraft = store.write<DiscoveryDraft>({ id: draft.id, kind: draft.kind, expected: draft.revision,
    value: { ...draft.value, fields: { ...draft.value.fields, runtime: "A new candidate" } } });
  const after = pilotContext(store, changedDraft, next);
  const prefix = (packet: unknown) => JSON.stringify(packet).split(',"draft":')[0];
  assert.equal(prefix(before), prefix(after), "Changing a question and draft does not change the stable product prefix");
  assert.notEqual(JSON.stringify(before), JSON.stringify(after));
  assert.deepEqual(question.value.spec.schema, before.question.schema);
  // L2 uses the same complete product material, even though its output is a delta.
  const layerQuestion = { ...question, value: { ...question.value, spec: { ...question.value.spec, field: "layerDesign" } } };
  const layerDraft = { ...draft, value: { ...draft.value, consumer: "operation-map" as const } };
  const layer = pilotContext(store, layerDraft, layerQuestion);
  assert.deepEqual(layer.core, before.core);
  assert.deepEqual(layer.map, before.map);
});

test("active experiment refuses creation and execution of R2 and later phases", async t => {
  const { engine, store, settings, pilot, draft } = fixture(t);
  assert.throws(() => engine.refinement.begin("p", "R2"), { code: "pilot_boundary_reached" });
  assert.throws(() => engine.refinement.prepareLayer("p", 3), { code: "pilot_boundary_reached" });
  assert.throws(() => engine.refinement.assess("p", 0), { code: "pilot_boundary_reached" });
  assert.throws(() => engine.refinement.finishResearch("p", "R2", reference(draft), 0), { code: "pilot_boundary_reached" });
  const foreignPhase = engine.discovery.create("p", "om-g2", "R2", "compilation", [{ field: "later", kind: "design", prompt: "Later work", risk: "Out of pilot", schema: { type: "string" } }]);
  await assert.rejects(engine.researcher.run("p", foreignPhase.id, 1), { code: "pilot_boundary_reached" });
  assert.equal(store.list("model-call").length, 0);
  configureReaderPilot(store, engine.environments, "p", { ...settings, active: false }, pilot.revision);
  assert.throws(() => engine.refinement.begin("p", "R2"), { code: "pilot_boundary_reached" }, "Disabling the pilot cannot grant permission for another phase");
});

test("R1 pilot routes reading to its configured reader, assesses originals, and resumes without repeating accepted answers", async t => {
  const { engine, store, draft } = fixture(t);
  const first = await engine.researcher.run("p", draft.id, 4);
  assert.equal(first.value.status, "paused");
  const answered = draft.value.questions.slice(0, 2).map(id => store.get<Question>(id)!);
  assert.ok(answered.every(q => q.value.status === "answered"), JSON.stringify({error:first.value.error,pauseCode:first.value.pauseCode}));
  const calls = store.list<ModelCall>("model-call");
  assert.equal(calls.length, 8); assert.equal(calls.filter(c => c.value.purpose === "reader").length, 2);
  assert.ok(calls.filter(c => c.value.purpose === "reader").every(c => c.value.requested.model === "fixture-reader" && c.value.requested.speed === "fast"));
  assert.ok(calls.filter(c => c.value.purpose === "analyst").every(c => c.value.requested.model === "fixture-author"));
  assert.equal(calls.filter(c => c.value.purpose === "assessor").length, 2);
  await engine.researcher.run("p", draft.id, 2);
  assert.ok(answered.every(q => store.get(q.id)!.revision === q.revision));
  assert.equal(store.list("model-call").length, 12);
});

test("shared pilot limits stop additional role calls without publishing an answer", async t => {
  for (const limits of [{ maxCalls: 1 }, { maxReportedTokens: 1 }]) {
    const { engine, store, settings, pilot, draft } = fixture(t);
    configureReaderPilot(store, engine.environments, "p", { ...settings, ...limits }, pilot.revision);
    const result = await engine.researcher.run("p", draft.id, 2);
    assert.equal(result.value.status, "paused"); assert.equal(result.value.ownerQuestion, null);
    assert.equal(store.list("model-call").length, 1, "The reader cannot evade the analyst's shared allowance");
    assert.equal(store.get<Question>(draft.value.questions[0]!)!.value.status, "open");
  }
});

test("L2 accepts a model delta, inherits exact L1, and gives the assessor changes rather than the full graph", async t => {
  const { root, engine, store, full, settings, pilot, draft: r1 } = fixture(t);
  configureReaderPilot(store, engine.environments, "p", { ...settings, planning: { fields: ["layerDesign"], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  answerTechnicalFixture(engine, "p", r1);
  engine.refinement.finishResearch("p", "R1", reference(store.get(r1.id)!), 0);
  const draft = engine.refinement.prepareLayer("p", 2), question = store.get<Question>(draft.value.questions[0]!)!;
  const target = layerDesignOf(full, 2);
  const delta = layerDeltaView(store, "p", target);
  writeFileSync(join(root, "delta.json"), JSON.stringify({ upserts: delta.upserts, removes: delta.removes }));
  const orderedNodes = (value: Json) => {
    const result = structuredClone(value) as Record<string, Json>;
    result['nodes'] = (result['nodes'] as { id: string }[]).sort((a, b) => a.id.localeCompare(b.id));
    return result;
  };
  assert.deepEqual(orderedNodes(expandLayerDelta(store, draft, question, delta)), orderedNodes(target),
    "The delta preserves every node value; new nodes append without rewriting upper node order");
  assert.throws(() => expandLayerDelta(store, draft, question, { ...delta, base: { ...delta.base, revision: 999 } }), { code: "graph_stale" });
  const l1 = store.get("graph-layer:p:1")!;
  const result = await engine.execute({ type: "research-phase", project: "p", phase: "L2", draftId: draft.id, maxTurns: 3 }) as ConsumerResult;
  assert.equal(result.status, "accepted", JSON.stringify(result));
  assert.deepEqual(store.get(l1.id), l1);
  assert.deepEqual(engine.refinement.gate("p", "L2").findings, []);
  const review = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    .find(call => call.role === "assess-answer" && call.field === "layerDesign");
  assert.equal(review.fullGraph, false); assert.equal(review.delta, true);
  assert.throws(() => engine.refinement.begin("p", "R2"), { code: "pilot_boundary_reached" });
  assert.equal(store.get("phase:p:R2"), null);
  assert.equal(store.list<ModelCall>("model-call").filter(c=>c.value.purpose==='reading-planner').length, 1);
});

test("raising a pilot allowance resumes the saved assessor candidate without another analyst call", async t => {
  const { engine, store, settings, pilot, draft } = fixture(t);
  const limited = configureReaderPilot(store, engine.environments, "p", { ...settings, maxCalls: 3 }, pilot.revision);
  const paused = await engine.researcher.run("p", draft.id, 2);
  assert.equal(paused.value.status, "paused");
  const pending = store.list<ResearchTurn>("research-turn").find(turn => turn.value.status === "pending")!;
  assert.equal((pending.value.action as { action: string }).action, "answer");
  assert.equal(store.list("model-call").length, 3);
  configureReaderPilot(store, engine.environments, "p", { ...settings, maxCalls: 4 }, limited.revision);
  await engine.researcher.run("p", draft.id, 1);
  assert.equal(store.list("model-call").length, 4);
  assert.equal(store.list<ModelCall>("model-call").filter(call => call.value.purpose === "analyst").length, 2);
  assert.equal(store.get<ResearchTurn>(pending.id)!.value.status, "completed");
  assert.equal(store.get<Question>(draft.value.questions[0]!)!.value.status, "answered");
});

test("an explicit reserve resumes unknown usage without converting it into measured tokens", async t => {
  const { root, engine, store, settings, pilot, draft } = fixture(t);
  writeFileSync(join(root, "omit-usage"), "fixture");
  const paused = await engine.researcher.run("p", draft.id, 1);
  assert.equal(paused.value.status, "paused");
  const unknown = store.list<ModelCall>("model-call")[0]!;
  assert.equal(unknown.value.usage, null);
  configureReaderPilot(store, engine.environments, "p", { ...settings, unknownReserves: [{ call: reference(unknown), tokens: 130 }] }, pilot.revision);
  rmSync(join(root, "omit-usage"));
  await engine.researcher.run("p", draft.id, 1);
  const summary = modelUsage(store, "p", 0).cumulative;
  assert.equal(summary.attempts, 2); assert.equal(summary.unmeasuredCalls, 1);
  assert.deepEqual(summary.reportedTokens, { input: 100, output: 25, cachedInput: 0, reasoningOutput: 5 });
  assert.equal(store.get<ModelCall>(unknown.id)!.value.usage, null);
});

test("a previously prepared L3 cannot bypass the pilot boundary through build-layer", t => {
  const { engine, store, draft: r1, full } = fixture(t);
  configurePhasePolicy(store, "p", "L3", "R2-L3", 0);
  answerTechnicalFixture(engine, "p", r1);
  engine.refinement.finishResearch("p", "R1", reference(store.get(r1.id)!), 0);
  const l2 = engine.refinement.prepareLayer("p", 2);
  const ready2 = answerLayerFixture(engine, "p", l2, 2, full);
  engine.refinement.buildLayer("p", 2, reference(ready2), store.get("graph:p")!.revision, "fixture");
  engine.refinement.sealLayer("p", 2, 0);
  const r2 = engine.refinement.begin("p", "R2"); answerTechnicalFixture(engine, "p", r2);
  engine.refinement.finishResearch("p", "R2", reference(store.get(r2.id)!), 0);
  const l3 = engine.refinement.prepareLayer("p", 3);
  const ready3 = answerLayerFixture(engine, "p", l3, 3, full);
  configurePhasePolicy(store, "p", "L2", "R2-L3", 1);
  const before = store.get("graph:p")!;
  assert.throws(() => engine.execute({ type: "build-layer", project: "p", level: 3, draft: reference(ready3), expected: before.revision }),
    { code: "pilot_boundary_reached" });
  assert.deepEqual(store.get(before.id), before);
  assert.throws(() => engine.execute({ type: "compile", project: "p" }), { code: "pilot_boundary_reached" });
});

test("invalid technical consumer references are rejected before paying an assessor", async t => {
  const { root, engine, store, draft, question } = fixture(t);
  writeFileSync(join(root, "bad-consumer"), "fixture");
  const context = pilotContext(store, draft, question);
  assert.ok(context.allowedConsumers.includes("compilation"));
  assert.deepEqual(context.question.schema, question.value.spec.schema, "The saved schema is not expanded with repeated conditional blocks");
  const graph = store.get<any>("graph:p")!.value;
  for (const node of graph.nodes) assert.deepEqual(context.gapFields.find(group => group.targets.includes(node.id))!.fields, Object.keys(node).sort());
  await engine.researcher.run("p", draft.id, 2);
  const calls = store.list<ModelCall>("model-call");
  assert.equal(calls.length, 3); assert.equal(calls.filter(call => call.value.purpose === "assessor").length, 0);
  assert.equal(store.get<Question>(question.id)!.value.status, "open");
  const rejected = store.list<ResearchTurn>("research-turn").find(turn => turn.value.error !== null)!;
  assert.equal((rejected.value.observation as {code:string}).code, "research_proposal_invalid");
});

test("working set stays bounded while every old observation remains addressable after restart", t => {
  const { root, store, draft, question } = fixture(t);
  const base = pilotContext(store, draft, question);
  const readings = Array.from({ length: 30 }, (_, index) => ({ purpose: `reading-${index}`,
    observations: [{ value: `EXCEPTION-${index}: ` + "source condition 😀\r\n".repeat(2000) }] }));
  const full = { ...base, readings, focus: readings.at(-1), history: Array(50).fill("historical response".repeat(1000)) };
  const packet = workingContext(store, "p", draft.id, question.id, full, 70000);
  assert.ok(JSON.stringify(packet).length <= 70000);
  assert.ok(packet.readings.length <= 1);
  assert.deepEqual(packet.core, JSON.parse(JSON.stringify(base.core)));
  assert.ok(packet.working.omitted.includes("readings"));
  assert.equal(packet.working.sections.find((s: any) => s.pointer === "/body/readings").count, 30);
  const original = readPilotContext(store, draft, packet.working.archive, "/body/readings/0/observations/0/value", 10000, { offset: 0, limit: 100 });
  assert.equal(original.value, readings[0]!.observations[0]!.value.slice(0, 100));
  assert.equal(original.page!.next, 100);
  const next = readPilotContext(store, draft, packet.working.archive, "/body/readings/0/observations/0/value", 10000, { offset: 100, limit: 100 });
  assert.equal(next.value, readings[0]!.observations[0]!.value.slice(100, 200));
  const page = readPilotContext(store, draft, packet.working.archive, "/body/readings", 70000, { offset: 1, limit: 1 });
  assert.deepEqual(page.value, [readings[1]]);
  assert.throws(() => readPilotContext(store, draft, packet.working.archive, "/body/readings", 100, { offset: -1, limit: 1 }), { code: "context_page_invalid" });
  assert.throws(() => readPilotContext(store, draft, { ...packet.working.archive, hash: "f".repeat(64) }, "/body", 10000), { code: "context_reference_foreign" });
  assert.throws(() => readPilotContext(store, { ...draft, value: { ...draft.value, projectId: "other" } }, packet.working.archive, "/body", 10000), { code: "context_reference_foreign" });
  store.close();
  const reopened = new Store(join(root, "state.sqlite"));
  try {
    assert.equal(readPilotContext(reopened, draft, packet.working.archive, "/body/readings/0/observations/0/value", 70000).value, readings[0]!.observations[0]!.value);
    assert.equal(reopened.list("model-call").length, 0);
    reopened.write({ id: question.id, kind: question.kind, expected: question.revision, value: { ...question.value, beforeHash: "changed" } });
    assert.throws(() => readPilotContext(reopened, draft, packet.working.archive, "/body/readings", 10000), { code: "context_reference_stale" });
  } finally { reopened.close(); }
});

test("intermediate checkpoints preserve exact evidence and never accept a question", t => {
  const { root, store, engine, draft, question } = fixture(t);
  const source = engine.discovery.evidence.file("p", "notes", root, "README.md", "text/plain", 0);
  const action = { action: "checkpoint" as const, question: question.id, value: { findings: ["Proposed interpretation, not a fact"] },
    citations: [{ source: reference(source), selector: { kind: "text-range" as const, start: 0, end: source.value.content.length } }],
    unresolved: ["Check the exception on restart"] };
  const saved = checkpoint(store, draft, question, action);
  assert.equal((saved.value as any).status, "unassessed");
  assert.equal((saved.value as any).observations[0].value, source.value.content);
  assert.deepEqual(checkpoint(store, draft, question, action), saved);
  assert.equal(store.get<Question>(question.id)!.value.status, "open");
  assert.equal(store.list("research-assessment").filter(a => (a.value as any).question?.id === question.id).length, 0);
  assert.throws(() => checkpoint(store, draft, question, { ...action, question: "foreign" }), { code: "research_question_foreign" });
  writeFileSync(join(root, "README.md"), "changed");
  assert.throws(() => checkpoint(store, draft, question, action), { code: "source_stale" });
});

test("legacy transport-stopped answer is replayed to assessor without another analyst or history rewrite", async t => {
  const { root, engine, store, settings, pilot, draft, question } = fixture(t);
  const limited = configureReaderPilot(store, engine.environments, "p", { ...settings, maxCalls: 3 }, pilot.revision);
  // The former producer wrote unversioned research-turn:<hash([run,number])>
  // records. Preserve the exact paid answer from this fixture, then install
  // that former record shape/address rather than reclassifying a v1 turn.
  const adapter = join(root, 'reader.mjs');
  const originalAdapter = readFileSync(adapter, 'utf8');
  assert.ok(originalAdapter.includes("claim:'README defines scope and rollback',path:'README.md'"));
  writeFileSync(adapter, originalAdapter.replace("claim:'README defines scope and rollback',path:'README.md'",
    "claim:'README defines scope and rollback',path:'alias.md'"));
  await engine.researcher.run("p", draft.id, 2);
  symlinkSync('README.md', join(root, 'alias.md'));
  const paid = store.list<ResearchTurn>('research-turn').find(turn => (turn.value.action as { action?: string }).action === 'answer')!;
  assert.equal(paid.value.status, 'completed');
  assert.equal(store.get<Question>(question.id)!.value.status, 'open');
  const refusalRef = (paid.value.observation as { refusal: ReturnType<typeof reference> }).refusal;
  const refusal = readManagedProposalRefusalAt(store, 'p', paid.id, refusalRef);
  assert.equal(refusal.value.findings[0]?.code, 'repository_evidence_required',
    'The exact precheck refusal remains readable after the missing path appears');
  const run = store.list<ResearchRun>('research-run')[0]!, number = run.value.turns + 1;
  const oldValue: ResearchTurn = { run: run.id, number, action: paid.value.action, assessment: null, observation: null,
    error: null, status: 'pending', question: reference(question),
    ...(paid.value.dispatchMode ? { dispatchMode: paid.value.dispatchMode } : {}) };
  const [, originalLegacy] = store.writeMany<ResearchRun | ResearchTurn>([
    { id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, turns: number } },
    { id: `research-turn:${hashJson([run.id, number])}`, kind: 'research-turn', expected: 0, value: oldValue }
  ]);
  const legacyTurn = store.write<ResearchTurn>({ id: originalLegacy!.id, kind: originalLegacy!.kind,
    expected: originalLegacy!.revision, value: { ...oldValue, status: 'completed',
      error: 'An input changed before the transaction could commit' } });
  assert.deepEqual(readResearchConsumerTurn(store, reference(legacyTurn)), legacyTurn);
  assert.equal(recoverableAnswer([legacyTurn], question)?.id, legacyTurn.id);
  assert.equal(recoverableAnswer([{ ...legacyTurn, value: { ...legacyTurn.value, error: "Semantic refusal" } }], question), null);
  assert.equal(recoverableAnswer([legacyTurn], { ...question, revision: 99 }), null);
  configureReaderPilot(store, engine.environments, "p", { ...settings, maxCalls: 4 }, limited.revision);
  await engine.researcher.run("p", draft.id, 1);
  assert.deepEqual(store.get(legacyTurn.id), legacyTurn, "Historical failed turn is untouched");
  assert.ok(store.list<ResearchTurn>("research-turn").some(turn => turn.value.replayedFrom?.id === legacyTurn.id));
  assert.equal(store.list<ModelCall>("model-call").filter(call => call.value.purpose === "analyst").length, 2);
  assert.equal(store.get<Question>(question.id)!.value.status, "answered");
});

test('a fabricated managed completed turn cannot use legacy transport replay without its producer proof', async t => {
  const { engine, store, settings, pilot, draft, question } = fixture(t);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, maxCalls: 3 }, pilot.revision);
  await engine.researcher.run('p', draft.id, 2);
  const pending = store.list<ResearchTurn>('research-turn').find(turn => turn.id.startsWith('research-turn:v1:')
    && turn.value.status === 'pending' && (turn.value.action as { action?: string }).action === 'answer')!;
  const fabricated = store.write<ResearchTurn>({ id: pending.id, kind: pending.kind, expected: pending.revision,
    value: { ...pending.value, status: 'completed', error: 'An input changed before the transaction could commit' } });
  assert.throws(() => readResearchConsumerTurn(store, reference(fabricated)), { code: 'research_consumer_intent_invalid' });
  const calls = store.list<ModelCall>('model-call').length;
  await assert.rejects(engine.researcher.run('p', draft.id, 1), { code: 'research_consumer_intent_invalid' });
  assert.equal(store.list<ModelCall>('model-call').length, calls);
  assert.equal(store.get<Question>(question.id)!.value.status, 'open');
});

test("assessor resumes bounded evidence pages after budget stop and sees a late exception before acceptance", async t => {
  const { root, store, engine, environment, settings, pilot, draft, question } = fixture(t);
  const sourceText = "Evidence line. ".repeat(18000) + "EXCEPTION: never grant this effect.";
  writeFileSync(join(root, "large.txt"), sourceText);
  const source = engine.discovery.evidence.file("p", "large-evidence", root, "large.txt", "text/plain", 0);
  const command = join(root, "paged-assessor.mjs");
  writeFileSync(command, `import {readFileSync,appendFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
appendFileSync('pages.jsonl',JSON.stringify({chars:JSON.stringify(req).length,page:c.evidencePage,observations:c.observations})+'\\n');
const seen=JSON.stringify(c.observations).includes('EXCEPTION')||c.evidencePage.text?.includes('EXCEPTION');
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:seen?'conflicting':'supported',reasons:[seen?'Exception forbids the effect':'Provisional page judgment']},usage:{inputTokens:100,outputTokens:20,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const limited = configureReaderPilot(store, engine.environments, "p", { ...settings, maxRequestChars: 60000, maxCalls: 2,
    agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const action = { action: "answer" as const, question: question.id, value: { applicability: "applicable", reason: "Evaluate a proposal",
    facts: [], designs: [{ id: "d", decision: "Grant this effect", benefit: "A useful output", consumer: "compilation" }], gaps: [] },
    citations: [{ source: reference(source), selector: { kind: "text-range" as const, start: 0, end: sourceText.length } }] };
  await assert.rejects(assessAnswer(store, question, action, environment, root, undefined, limited), { code: "pilot_call_limit" });
  assert.equal(store.get<Question>(question.id)!.value.status, "open");
  const saved = store.list<any>("assessment-session")[0]!;
  assert.ok(saved.value.offset > 0); assert.equal(saved.value.result, null);
  const { projectId: _projectId, ...continuedSettings } = limited.value;
  const resumed = configureReaderPilot(store, engine.environments, "p", { ...continuedSettings, maxCalls: 20 }, limited.revision);
  const result = await assessAnswer(store, question, action, environment, root, undefined, resumed);
  assert.equal(result.value.verdict, "conflicting");
  const pages = readFileSync(join(root, "pages.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(pages.every(page => page.chars <= 60000));
  let end = 0, text = "";
  for (const item of pages) { assert.equal(item.page.offset, end); end = item.page.end; text += item.page.text; }
  assert.deepEqual(JSON.parse(text), result.value.observations);
  assert.ok(pages.length > 2);
  assert.equal(store.get<Question>(draft.value.questions[0]!)!.value.status, "open");
});

test("checkpoint and addressed continuation work through the researcher across restart", async t => {
  const { root, store, engine, settings, pilot, draft, question } = fixture(t);
  const source = engine.discovery.evidence.file("p", "checkpoint-source", root, "README.md", "text/plain", 0);
  const citations = [{ source: reference(source), selector: { kind: "text-range", start: 0, end: source.value.content.length } }];
  const command = join(root, "checkpoint-provider.mjs");
  const value = { applicability: "applicable", reason: "A bounded proposal", facts: [], designs: [{ id: "d", decision: "Preserve the exception", benefit: "Correct output", consumer: "compilation" }], gaps: [] };
  writeFileSync(command, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};else{
const step=existsSync('checkpoint-step')?Number(readFileSync('checkpoint-step','utf8')):0;writeFileSync('checkpoint-step',String(step+1));
if(step===0)research={action:'checkpoint',question:c.question.id,value:{finding:'Preserve the exception'},citations:${JSON.stringify(citations)},unresolved:['Verify before acceptance']};
else if(step===1){if(c.checkpoint.status!=='unassessed')throw Error('Checkpoint cannot be promoted');research={action:'read_context',record:c.working.archive,pointer:'/body/checkpoints/0/proposal'};}
else {if(c.focus.value.finding!=='Preserve the exception')throw Error('Missing exact continuation');research={action:'answer',question:c.question.id,value:${JSON.stringify(value)},citations:${JSON.stringify(citations)}};}}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, "p", { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const firstCheckpointRun = await engine.researcher.run("p", draft.id, 1);
  assert.equal(store.get<Question>(question.id)!.value.status, "open");
  assert.equal(store.list("research-checkpoint").length, 1, firstCheckpointRun.value.error ?? "Checkpoint was not saved");
  store.close();
  const reopened = new Store(join(root, "state.sqlite"));
  try {
    const continued = new ProductEngine(reopened);
    await continued.researcher.run("p", draft.id, 2);
    assert.equal(reopened.get<Question>(question.id)!.value.status, "answered");
    assert.equal(reopened.list("model-call").length, 4);
    assert.equal(reopened.list<ModelCall>("model-call").filter(c => c.value.purpose === "reader").length, 0);
  } finally { reopened.close(); }
});

test("oversized requested assessment context pauses before another call instead of being forgotten", async t => {
  const { root, store, engine, environment, settings, pilot, draft, question } = fixture(t);
  const source = engine.discovery.evidence.file("p", "focus-source", root, "README.md", "text/plain", 0);
  const observations = [engine.discovery.evidence.observe("p", reference(source), { kind: "text-range", start: 0, end: source.value.content.length })];
  const command = join(root, "focus-provider.mjs");
  writeFileSync(command, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
const step=existsSync('focus-step')?Number(readFileSync('focus-step','utf8')):0;writeFileSync('focus-step',String(step+1));
const research=step===0?{action:'read_context',record:c.working.archive,pointer:'/body/extra'}:step===1?{action:'assessment_checkpoint',notes:['Still awaiting context']}:{verdict:'supported',reasons:[]};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const selected = configureReaderPilot(store, engine.environments, "p", { ...settings, maxRequestChars: 200000, maxReadChars: 200000,
    physicalLimits:{maxRequestChars:60000,maxReplyChars:100000,basis:'Fixture transport capacity'},
    agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const context = { ...pilotContext(store, draft, question), role: "assess-answer", observations, value: "candidate", extra: "exception ".repeat(10000) };
  await assert.rejects(assessmentSession(store, draft, question, environment, pilotEnvironment(environment.value, selected.value), selected, context, "Evaluate"),
    { code: "budget_transport_limit" });
  const session = store.list<any>("assessment-session")[0]!.value;
  assert.equal(session.result, null);
  assert.equal(session.workspace.entries[0].result.value, context.extra);
  await assert.rejects(assessmentSession(store, draft, question, environment, pilotEnvironment(environment.value, selected.value), selected, context, "Evaluate"),
    { code: "budget_transport_limit" });
  assert.equal(store.list("model-call").length, 1);
  assert.equal(store.get<Question>(question.id)!.value.status, "open");
});

test("assessment continuation never reuses a verdict after its supplied research context changes", async t => {
  const { root, store, environment, pilot, draft, question } = fixture(t);
  const context = { ...pilotContext(store, draft, question), role: "assess-answer", value: "same candidate", observations: [] };
  const dispatch = pilotEnvironment(environment.value, pilot.value);
  await assessmentSession(store, draft, question, environment, dispatch, pilot, context, "Evaluate");
  await assessmentSession(store, draft, question, environment, dispatch, pilot, context, "Evaluate");
  assert.equal(store.list("model-call").length, 1, "Exact continuation may reuse its completed verdict");
  await assessmentSession(store, draft, question, environment, dispatch, pilot,
    { ...context, readings: [{ ref: reference(question), purpose: "New evidence", observations: [], coverage: [], unresolved: ["New contradiction requires consideration"] }] }, "Evaluate");
  assert.equal(store.list("model-call").length, 2);
  assert.equal(store.list("assessment-session").length, 2);
  assert.ok(readFileSync(join(root, "calls.jsonl"), "utf8").includes("assess-answer"));
});

test("two paid reading blocks coexist for comparison without archive ping-pong", async t => {
  const { root, store, engine, environment, pilot, settings, draft, question } = fixture(t);
  for (const name of ["a", "b"]) {
    writeFileSync(join(root, `${name}.txt`), `Header\n${name.repeat(1800)}\nException ${name}\n`);
    await readBundle(store, environment.value, pilot, reference(question), `Read ${name}`, [{ path: `${name}.txt`, media: "text/plain" }]);
  }
  const readers = store.list<any>("reader-result");
  const command = join(root, "compare-provider.mjs");
  writeFileSync(command, `import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.readings.length===2)research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Compared both originals',facts:[],designs:[{id:'d',decision:'Respect both exceptions',benefit:'Correct comparison',consumer:'compilation'}],gaps:[]},citations:c.readings.flatMap(r=>r.observations.map(o=>({source:o.source,selector:o.selector})))};
else research={action:'read_context',record:c.working.archive,pointer:'/body/readings/'+(c.readings.some(r=>r.ref.id===${JSON.stringify(readers[0]!.id)})?1:0)};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, "p", { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  await engine.researcher.run("p", draft.id, 3);
  assert.equal(store.get<Question>(question.id)!.value.status, "answered");
  assert.equal(store.list<ModelCall>("model-call").filter(c=>c.value.purpose==='analyst').length, 3);
  assert.equal(store.list<ModelCall>("model-call").filter(c=>c.value.purpose==='reader').length, 2, "Paid reading results are reused");
});

test("unchanged archive rereading pauses on the second request despite a new wrapper hash", async t => {
  for (const alternating of [false, true]) {
    const { root, store, engine, environment, pilot, settings, draft, question } = fixture(t);
    for (const name of ["a", "b"]) {
      writeFileSync(join(root, `${name}.txt`), `Header\nData ${name}\nException ${name}\n`);
      await readBundle(store, environment.value, pilot, reference(question), `Read ${name}`, [{ path: `${name}.txt`, media: "text/plain" }]);
    }
    const command = join(root, "repeat-provider.mjs");
    writeFileSync(command, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
const step=existsSync('repeat-step')?Number(readFileSync('repeat-step','utf8')):0;writeFileSync('repeat-step',String(step+1));
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'read_context',record:c.working.archive,pointer:'/body/readings/'+(${alternating}?step%2:0)},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    configureReaderPilot(store, engine.environments, "p", { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
    const run = await engine.researcher.run("p", draft.id, 10);
    assert.equal(run.value.status, "paused"); assert.equal(run.value.pauseCode, "research_no_progress");
    const turns = store.list<ResearchTurn>("research-turn").sort((a,b)=>a.value.number-b.value.number);
    assert.equal(turns.at(-1)!.value.status, "completed");
    assert.ok(turns.at(-1)!.value.error, 'A refused lookup is recorded, not queued for automatic replay');
    assert.equal((turns.at(-1)!.value.observation as any).code, "research_no_progress");
    assert.notEqual((turns[0]!.value.action as any).record.id, (turns.at(-1)!.value.action as any).record.id);
    assert.equal(store.list<ModelCall>("model-call").filter(c=>c.value.purpose==='analyst').length, alternating ? 3 : 2);
    assert.equal(store.get<Question>(question.id)!.value.status, "open");
  }
});

test('a planned context array exceeding the transport request limit is delivered in smaller children before another paid call',async t=>{
  const {root,store,engine,environment,pilot,settings,draft,question}=fixture(t);
  for(let n=0;n<4;n++){
    const path=`part-${n}.txt`;writeFileSync(join(root,path),`Header\n${'X'.repeat(30000)}\nException ${n}\n`);
    await readBundle(store,environment.value,pilot,reference(question),`Read part ${n}`,[{path,media:'text/plain'}]);
  }
  const adapter=join(root,'oversized-plan.mjs');
  writeFileSync(adapter,`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
if(c.dispatchMode!=='planning')throw Error('Unexpected paid consumer');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_plan',question:c.question.id,reads:[{action:'read_context',record:c.working.archive,pointer:'/body/readings',page:{offset:0,limit:4}}]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:{executable:process.execPath,args:[adapter]},planning:{fields:['productDomain'],maxRequestChars:50000,maxRounds:3}},pilot.revision);
  const before=store.list('model-call').length;
  const run=await withInvocationAllowance(1,()=>engine.researcher.run('p',draft.id,100));
  assert.equal(run.value.pauseCode,'research_call_allowance',run.value.error??'Missing bounded stop');
  assert.equal(store.list('model-call').length,before+1,'Only the original planner was paid');
  const turns=store.list<ResearchTurn>('research-turn');
  assert.ok(turns.some(turn=>(turn.value.observation as any)?.splitInto?.length===2));
  const delivered=turns.filter(turn=>turn.value.splitFrom&&turn.value.status==='completed'&&!turn.value.error
    &&Array.isArray((turn.value.observation as any)?.value));
  assert.equal(delivered.reduce((sum,turn)=>sum+(turn.value.observation as any).value.length,0),4);
});

test("the oldest selected material is evicted before the newest without increasing the ceiling", t => {
  const { store, draft, question } = fixture(t);
  const base = pilotContext(store, draft, question);
  const newest = { key: "new", kind: "context", value: { text: "new".repeat(3000) } };
  const older = { key: "old", kind: "context", value: { text: "old".repeat(3000) } };
  const oldest = { key: "oldest", kind: "context", value: { text: "oldest".repeat(6000) } };
  const limit = JSON.stringify(base).length + 25000;
  const packet = workingContext(store, "p", draft.id, question.id, { ...base, workingSelections: [newest, older, oldest] }, limit);
  assert.ok(JSON.stringify(packet).length <= limit);
  assert.deepEqual(packet.focus, newest.value);
  assert.deepEqual(packet.selectedContext, [older.value]);
  const oversized = { ...newest, value: { text: "X".repeat(limit * 2) } };
  const continuation = workingContext(store, "p", draft.id, question.id, { ...base, workingSelections: [oversized, older] }, limit);
  assert.ok(continuation.working.focusContinuation);
  assert.equal(continuation.focus, undefined, "An older value cannot replace the requested newest value");
});

test("increasing page limit at end of unchanged context cannot evade repeat detection", async t => {
  const { root, store, engine, pilot, settings, draft } = fixture(t);
  const command = join(root, "end-page-provider.mjs");
  writeFileSync(command, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
const step=existsSync('end-step')?Number(readFileSync('end-step','utf8')):0;writeFileSync('end-step',String(step+1));
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'read_context',record:c.working.archive,pointer:'/body/core/acceptance',page:{offset:0,limit:100+step}},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, "p", { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const run = await engine.researcher.run("p", draft.id, 10);
  assert.equal(run.value.pauseCode, "research_no_progress");
  assert.equal(store.list("model-call").length, 2);
});

test("restoring paid readings checks every bundle source including unselected sources", async t => {
  const { root, store, engine, environment, pilot, draft, question } = fixture(t);
  writeFileSync(join(root, "a.txt"), "Header\nSelected A\nException A\n");
  writeFileSync(join(root, "b.txt"), "Header\nUnselected B\nException B\n");
  const reader = await readBundle(store, environment.value, pilot, reference(question), "Read A and B", [
    { path: "a.txt", media: "text/plain" }, { path: "b.txt", media: "text/plain" }]);
  assert.equal(reader.value.sources.length, 2); assert.equal(reader.value.observations.length, 1);
  const context = pilotContext(store, draft, question);
  const packet = workingContext(store, "p", draft.id, question.id, context, 100000);
  const action = { action: "read_context" as const, record: packet.working.archive, pointer: "/body/readings/0" };
  const observation = readPilotContext(store, draft, action.record, action.pointer, 10000);
  const turn = store.write<ResearchTurn>({ id: "fixture-archived-reading", kind: "research-turn", expected: 0,
    value: { run: "fixture", number: 1, action, observation, assessment: null, error: null, status: "completed", question: reference(question) } });
  assert.equal(workingSelections(store, [turn], question).length, 1);
  writeFileSync(join(root, "b.txt"), "changed B");
  assert.ok(engine.discovery.evidence.verify(reader.value.observations[0]!));
  assert.equal(pilotContext(store, draft, question).readings.length, 0);
  assert.equal(workingSelections(store, [turn], question).length, 0, "Stale bundle must not return as a generic focus either");
});

test("planning indexes all sources, requirements and nodes without carrying observations", t => {
  const { root, store, engine, draft, question } = fixture(t);
  const source = engine.discovery.evidence.file("p", "index-source", root, "README.md", "text/plain", 0);
  const base = pilotContext(store, draft, question);
  const inventory = new ResearchSources(store, "p", root).inventory();
  const body = { ...base, repositoryRoot: root, dispatchMode: "planning", inventory, readPlanStatus: [],
    readings: [{ purpose: "Read source", coverage: [{ ref: reference(source), visibleRange: { start: 0, end: 10 } }], unresolved: ["Check exception"],
      observations: [{ value: "LARGE_OBSERVATION_NOT_FOR_PLANNING".repeat(5000) }] }] };
  const packet = workingContext(store, "p", draft.id, question.id, body, 50000);
  assert.ok(JSON.stringify(packet).length < 50000);
  assert.ok(!JSON.stringify(packet).includes("LARGE_OBSERVATION_NOT_FOR_PLANNING"));
  assert.deepEqual(packet.question.schema, question.value.spec.schema);
  assert.deepEqual(readPilotContext(store, draft, packet.question.schemaAddress.record,
    packet.question.schemaAddress.pointer, 50000).value, question.value.spec.schema);
  assert.deepEqual(records<any>(packet.sources).map((s: any)=>inventory.sources[s.index]!.ref.id), inventory.sources.map(s=>s.ref.id));
  assert.deepEqual(records<any>(packet.requirements).map((r: any)=>r.id), base.core.requirements.flatMap((s: any)=>records<any>(s.requirements).map(r=>r.id)));
  assert.deepEqual(records<any>(packet.nodes).map((n: any)=>n.id), records<any>(base.map.nodes).map(n=>n.id));
  assert.deepEqual(packet.constraints, base.core.constraints);
  assert.deepEqual(packet.specificationConstraints, base.core.specificationConstraints);
  assert.equal(records<any>(packet.alreadyRead)[0].unresolvedCount, 1);
  assert.equal(records<any>(packet.alreadyRead)[0].unresolved, undefined);
  assert.deepEqual(records<any>(packet.unresolvedEvidence)[0].unresolved, ["Check exception"]);
  assert.equal(readPilotContext(store, draft, packet.working.archive, records<any>(packet.alreadyRead)[0].purposePointer, 1000).value, "Read source");
  assert.equal(readPilotContext(store, draft, packet.working.archive, "/body/readings/0/observations/0/value", 500, {offset:0,limit:32}).value,
    body.readings[0]!.observations[0]!.value.slice(0,32));
});

test("planning table transport retains every navigation value and enforces the complete packet ceiling", t => {
  const { root, store, draft, question } = fixture(t);
  const base = pilotContext(store, draft, question);
  const requirements = Array.from({length: 100}, (_, i) => ({id: `requirement-${i}`, statement: `Exact condition ${i}: preserve the adjacent exception`, outcome: "Useful result", beneficiary: "Owner"}));
  const body = {...base, repositoryRoot: root, dispatchMode: "planning", inventory: new ResearchSources(store, "p", root).inventory(),
    core: {...base.core, requirements: [{requirements}]}, researchMissing: ["Do not omit the exception"], readPlanStatus: []};
  const packet = workingContext(store, "p", draft.id, question.id, body, 100000);
  assert.ok(!Array.isArray(packet.requirements));
  assert.deepEqual(records<any>(packet.requirements), requirements.map((r, i) => ({...r, pointer: `/content/fields/conceptSections/0/requirements/${i}`})));
  assert.deepEqual(records<any>(packet.nodes), records<any>(base.map.nodes).map(n => JSON.parse(JSON.stringify({id:n.id,title:n.title,parent:n.parent,outcome:n.outcome,pointer:n.pointer}))));
  assert.deepEqual(records<any>(packet.records).map(r => ({...r,fields:records(r.fields)})), base.catalogue.map(r => ({ref:r.ref,kind:r.kind,stage:r.stage,fields:r.fields.map(f => ({field:f.field,pointer:f.pointer,chars:f.chars}))})));
  assert.deepEqual(packet.missing, body.researchMissing);
  assert.deepEqual(packet.constraints, base.core.constraints);
  assert.deepEqual(packet.specificationConstraints, base.core.specificationConstraints);
  const chars = JSON.stringify(packet).length;
  assert.deepEqual(workingContext(store, "p", draft.id, question.id, body, chars), packet);
  assert.throws(() => workingContext(store, "p", draft.id, question.id, body, chars - 1), {code:"planning_context_limit"});
  assert.deepEqual(readPilotContext(store, draft, packet.working.archive, "/body/core/requirements/0/requirements/99", 1000).value, requirements[99]);
});

test("planner cannot approve an answer from the index", async t => {
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const source = engine.discovery.evidence.file("p", "planner-cite", root, "README.md", "text/plain", 0);
  const command = join(root, "bad-planner.mjs");
  const action = {action:'answer',question:question.id,value:{applicability:'applicable',reason:'valid shape',facts:[],designs:[{id:'d',decision:'Do work',benefit:'Benefit',consumer:'compilation'}],gaps:[]},
    citations:[{source:reference(source),selector:{kind:'text-range',start:0,end:source.value.content.length}}]};
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:${JSON.stringify(action)},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store,engine.environments,"p",{...settings,agentCommand:{executable:process.execPath,args:[command]},planning:{fields:[question.value.spec.field],maxRequestChars:50000,maxRounds:3}},pilot.revision);
  await engine.researcher.run("p",draft.id,2);
  const run = await engine.researcher.run("p",draft.id,5);
  assert.equal(run.value.pauseCode,null);
  assert.ok(store.list("model-call").length>=3);
  assert.ok(store.list<ModelCall>("model-call").every(c=>c.value.purpose==='reading-planner'&&c.value.request.chars<=50000));
  assert.equal(store.get<Question>(question.id)!.value.status,"open");
});

test("a rejected planner target reaches the next planner as correction feedback", async t => {
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const command = join(root, "corrected-planner.mjs");
  writeFileSync(command,`import {readFileSync,existsSync,writeFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(!existsSync('attempted')){writeFileSync('attempted','1');research={action:'read_plan',question:c.question.prompt,reads:[{action:'read',path:'README.md',media:'text/plain'}]};}
else {if(c.dispatchMode!=='planning'||!c.corrections.some(x=>x.error.includes('target this question')))throw Error('The planner must see the rejected target');if(!req.prompt.includes('subject.question.id'))throw Error('Exact question target must be specified');research={action:'read_plan',question:c.question.id,reads:[{action:'read',path:'README.md',media:'text/plain'}]};}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, "p", {...settings,agentCommand:{executable:process.execPath,args:[command]},planning:{fields:[question.value.spec.field],maxRequestChars:50000,maxRounds:3}},pilot.revision);
  await engine.researcher.run("p",draft.id,3);
  const turns=store.list<ResearchTurn>("research-turn");
  assert.equal(turns.filter(t=>t.value.error).length,1);
  assert.equal(turns.filter(t=>t.value.plannedBy&&t.value.status==='completed'&&!t.value.error).length,1);
  assert.equal(store.list<ModelCall>("model-call").length,2);
  assert.equal(store.get<Question>(question.id)!.value.status,'open');
});

/** C52 fixture: the exact pre-intent (legacy) planner chain — an audited
 * model-call/model-response pair plus a previous-era turn — written directly
 * so the test does not depend on the retired runner. */
function legacyRejectedPlan(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  actionOverride?: unknown) {
  const packet = workingContext(store, 'p', draft.id, question.id,
    { note: 'legacy archived packet' }, 90000, { common: true });
  const archiveRef = (packet as { working: { archive: ReturnType<typeof reference> } }).working.archive;
  const action = actionOverride ?? { action: 'read_plan', question: 'a prose question, not the id',
    reads: [{ action: 'read_context', record: archiveRef, pointer: '/body/question/prompt' }] };
  const requestId = `legacy-${randomUUID()}`;
  const text = JSON.stringify({ protocol: 'omg-agent/v1', requestId, research: action });
  const response = store.write({ id: `model-response:${requestId}`, kind: 'model-response', expected: 0,
    value: { projectId: 'p', draftId: draft.id, text } });
  const call = store.write<ModelCall>({ id: `model-call:${requestId}`, kind: 'model-call', expected: 0, value: {
    projectId: 'p', draftId: draft.id, questionId: question.id, purpose: 'reading-planner', requestId,
    requested: { actor: 'author', model: 'fixture-author', effort: 'high' }, profile: null,
    status: 'succeeded', startedAt: 1, finishedAt: 2, error: null,
    request: { chars: text.length, bytes: Buffer.byteLength(text), hash: digest(text) },
    response: { record: reference(response), chars: text.length, bytes: Buffer.byteLength(text), hash: digest(text) } } } as any);
  const runId = `research-run:${hashJson(['p', draft.id])}`;
  const turn = store.write<ResearchTurn>({ id: `research-turn:${hashJson([runId, 2])}`, kind: 'research-turn',
    expected: 0, value: { run: runId, number: 2, action: action as any, question: null,
      dispatchMode: 'planning', status: 'completed', error: 'reading_plan_invalid: foreign target',
      assessment: null, observation: null } });
  return { action: action as any, call, response, turn };
}

// C52 split: the removed single test encoded the obsolete invariant that any
// audited plan could be replayed. The door now repairs only the legacy era.
test("a previous-era audited archive plan recovers its question binding without another planner call", async t => {
  const { store, draft, question } = fixture(t);
  const { action, call, turn } = legacyRejectedPlan(store, draft, question);
  const recovery = recoverableReadingPlan(store, [turn], draft, question)!;
  assert.ok(recovery);
  assert.equal(recovery.action.question, question.id);
  assert.deepEqual(recovery.action.reads, action.reads);
  assert.deepEqual(recovery.request, reference(call));
  assert.deepEqual(store.get(turn.id), turn, 'Original rejected turn remains immutable');
});

test("a managed planner rejection is corrected by its own era, never the legacy replay door", async t => {
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const command = join(root, 'managed-plan.mjs');
  writeFileSync(command, `import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
const research={action:'read_plan',question:c.question.prompt,reads:[{action:'read_context',record:c.working.archive,pointer:'/body/question/prompt'}]};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] }, planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 1 } }, pilot.revision);
  await engine.researcher.run('p', draft.id, 1);
  const original = store.list<ResearchTurn>('research-turn').at(-1)!;
  assert.ok(original.id.startsWith('research-turn:v1:'), 'The fixture turn is a managed-era record');
  // A matching previous-era call that saves even the same action bytes still
  // must not hijack the managed turn into the legacy replay door.
  legacyRejectedPlan(store, draft, question, original.value.action);
  assert.equal(recoverableReadingPlan(store, [original], draft, question), null,
    'A managed turn is never repaired through the previous-era replay door');
  await engine.researcher.run('p', draft.id, 1);
  assert.equal(store.list<ModelCall>('model-call').filter(c => c.value.purpose === 'reading-planner').length, 2,
    'The correction pays the next managed planner generation');
  assert.ok(store.list<ResearchTurn>('research-turn').every(turn => !turn.value.replayedFrom),
    'No previous-era replayed turn was created');
});

test("archive plan recovery rejects missing audit, forged response and foreign or changed question", async t => {
  const { store, draft, question } = fixture(t);
  const { action, call, turn } = legacyRejectedPlan(store, draft, question);
  assert.ok(recoverableReadingPlan(store, [turn], draft, question));
  const altered = (patch: Partial<ModelCall>) => { const current = store.get<ModelCall>(call.id)!;
    store.write({ id: call.id, kind: call.kind, expected: current.revision, value: { ...call.value, ...patch } }); };
  for (const patch of [{ questionId: 'question:foreign' }, { response: null }, { status: 'failed' as const },
    { response: { ...call.value.response!, record: { ...call.value.response!.record!, hash: '0'.repeat(64) } } }]) {
    altered(patch); assert.equal(recoverableReadingPlan(store, [turn], draft, question), null);
  }
  altered({});
  const foreign = { ...turn, value: { ...turn.value, action: { ...action, question: 'question:foreign' } } };
  assert.equal(recoverableReadingPlan(store, [foreign], draft, question), null);
  const forged = { ...turn, value: { ...turn.value, action: { ...action,
    reads: [{ action: 'read_context', record: action.reads[0].record, pointer: '/body/inventory' }] } } };
  assert.equal(recoverableReadingPlan(store, [forged], draft, question), null,
    'Changed selection does not match paid response');
  const managedDescendant = { ...turn, id: 'research-turn:v1:forged-ancestor' } as typeof turn;
  assert.equal(recoverableReadingPlan(store, [managedDescendant], draft, question), null,
    'A managed-era turn id is never replayed through the legacy door');
  const current = store.get<Question>(question.id)!;
  store.write({ id: current.id, kind: current.kind, expected: current.revision,
    value: { ...current.value, spec: { ...current.value.spec, prompt: 'Changed question' } } });
  assert.equal(recoverableReadingPlan(store, [turn], draft, store.get<Question>(question.id)!), null);
});

test("grouped reads resume only the failed child and then switch to substantive synthesis", async t => {
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  for(const path of ['a.txt','b.txt'])writeFileSync(join(root,path),`Header\n${path} condition\n${path} exception\n`);
  const command=join(root,'batch-provider.mjs');
  writeFileSync(join(root,'fail-b'),'once');
  writeFileSync(command,`import {readFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(c.role==='reader'){if(c.purpose==='b'&&existsSync('fail-b'))process.exit(1);research={selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]};}
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:['a','b'].map(n=>({action:'read_bundle',purpose:n,inputs:[{path:n+'.txt',media:'text/plain'}]}))};
else {if(!c.question.schema||c.readings.length!==2)throw Error('Synthesis needs real content');if(req.prompt.includes('"action":"read"')||req.prompt.includes('prefer one related bundle'))throw Error('Synthesis cannot carry planning instructions');research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Both groups read',facts:[],designs:[{id:'d',decision:'Respect both conditions',benefit:'Safe result',consumer:'compilation'}],gaps:[]},citations:c.readings.flatMap(r=>r.observations.map(o=>({source:o.source,selector:o.selector})))};}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  const active=configureReaderPilot(store,engine.environments,"p",{...settings,agentCommand:cmd,reader:{...settings.reader,command:cmd},planning:{fields:[question.value.spec.field],maxRequestChars:50000,maxRounds:3}},pilot.revision);
  const first=await engine.researcher.run("p",draft.id,10);
  assert.equal(first.value.pauseCode,'research_provider_failed');
  assert.equal(store.list('reader-result').length,1);
  const acceptedRead=store.list('reader-result')[0]!;
  assert.equal(store.list<ResearchTurn>('research-turn').filter(t=>t.value.plannedBy&&t.value.status==='pending').length,1);
  rmSync(join(root,'fail-b'));
  const failed=store.list<ModelCall>('model-call').find(call=>call.value.purpose==='reader'&&call.value.status==='failed')!;
  const {projectId:_projectId,...activeSettings}=active.value;
  configureReaderPilot(store,engine.environments,'p',{...activeSettings,unknownReserves:[{call:reference(failed),tokens:130}]},active.revision);
  await engine.researcher.run("p",draft.id,2);
  assert.equal(store.get<Question>(question.id)!.value.status,'answered');
  assert.deepEqual(store.get(acceptedRead.id),acceptedRead);
  const calls=store.list<ModelCall>('model-call');
  assert.equal(calls.filter(c=>c.value.purpose==='reading-planner').length,1);
  assert.equal(calls.filter(c=>c.value.purpose==='analyst').length,1);
  assert.equal(calls.filter(c=>c.value.purpose==='reader').length,3);
  assert.equal(calls.length,6);
});

test('a grouped child with a nonempty failed physical reply stays pending without repurchase after restart', async t => {
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  for (const path of ['a.txt', 'b.txt']) writeFileSync(join(root, path), `Header\n${path} condition\n${path} exception\n`);
  const command = join(root, 'nonempty-failed-child.mjs');
  writeFileSync(join(root, 'fail-b'), 'once');
  writeFileSync(command, `import {readFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(c.role==='reader'){research={selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]};if(c.purpose==='b'&&existsSync('fail-b'))process.exitCode=1;}
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:['a','b'].map(n=>({action:'read_bundle',purpose:n,inputs:[{path:n+'.txt',media:'text/plain'}]}))};
else throw Error('No further paid action is expected');
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd = { executable: process.execPath, args: [command] };
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: cmd,
    reader: { ...settings.reader, command: cmd },
    planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  const first = await engine.researcher.run('p', draft.id, 10);
  assert.equal(first.value.pauseCode, 'research_provider_failed');
  const accepted = store.list('reader-result')[0]!;
  const calls = store.list<ModelCall>('model-call');
  const responses = store.list('model-response');
  const failed = calls.find(call => call.value.purpose === 'reader' && call.value.status === 'failed')!;
  assert.ok(failed.value.response?.chars);
  const intent = store.list<any>('research-consumer-intent').find(row => row.value.call?.id === failed.id)!;
  assert.equal(readResearchConsumerIntent(store, reference(intent)).value.refusal?.kind, 'terminal');
  assert.equal(store.list<ResearchTurn>('research-turn').filter(turn => turn.value.plannedBy && turn.value.status === 'pending').length, 1);
  rmSync(join(root, 'fail-b'));
  const reopened = new Store(join(root, 'state.sqlite')); t.after(() => reopened.close());
  const repeated = await new ProductEngine(reopened).researcher.run('p', draft.id, 2);
  assert.equal(repeated.value.pauseCode, 'research_consumer_execution_refused');
  assert.deepEqual(reopened.list('model-call'), calls);
  assert.deepEqual(reopened.list('model-response'), responses);
  assert.deepEqual(reopened.get(accepted.id), accepted);
  assert.equal(reopened.list<ResearchTurn>('research-turn').filter(turn => turn.value.plannedBy && turn.value.status === 'pending').length, 1);
});

test("the permanent source catalogue retains every inventory field without retaining duplicate navigation payload", t => {
  const { root, store, draft, question }=fixture(t);
  const inventory=new ResearchSources(store,'p',root).inventory();
  const body={...pilotContext(store,draft,question),inventory,workingSelections:[{kind:'context',key:'inventory',value:{pointer:'/body/inventory',value:inventory}}]};
  const packet=workingContext(store,'p',draft.id,question.id,body,100000);
  assert.deepEqual(records(packet.sourceCatalogue.sources),inventory.sources);
  assert.deepEqual(packet.sourceCatalogue.files,inventory.files);
  assert.equal(packet.sourceCatalogue.filesTruncated,inventory.filesTruncated);
  assert.equal(packet.focus,undefined);assert.equal(packet.inventory,undefined);
});

test("reader source indices bind to exact supplied versions and reject ambiguous or foreign indices", t => {
  const {root,store,engine}=fixture(t);
  const source=engine.discovery.evidence.file('p','indexed',root,'README.md','text/plain',0);
  const supplied=[numberedSource(source)];
  const response={selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]};
  const result=readerObservations(store,'p',supplied,response,10000);
  assert.deepEqual(result.observations[0]!.source,reference(source));
  assert.ok(engine.discovery.evidence.verify(result.observations[0]!));
  assert.throws(()=>readerObservations(store,'p',supplied,{...response,selections:[{...response.selections[0],sourceIndex:1}]},10000),{code:'reader_selection_foreign'});
  assert.throws(()=>readerObservations(store,'p',supplied,{...response,selections:[{...response.selections[0],source:reference(source)}]},10000),{code:'reader_response_invalid'});
  writeFileSync(join(root,'README.md'),'changed');
  assert.throws(()=>readerObservations(store,'p',supplied,response,10000),{code:'source_stale'});
});


test("synthesis resumes unshown materials after a budget pause without repeating the reading plan", async t => {
  const {root,store,engine,environment,pilot,settings,draft,question}=fixture(t);
  const selections=['first','second','third'].map(name=>{
    writeFileSync(join(root,name+'.txt'),name+' condition '+'.'.repeat(12000));
    const source=engine.discovery.evidence.file('p',name,root,name+'.txt','text/plain',0);
    return {kind:'context',value:engine.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:source.value.content.length})};
  });
  const context={...pilotContext(store,draft,question),inventory:new ResearchSources(store,'p',root).inventory(),workingSelections:selections};
  const full=workingContext(store,'p',draft.id,question.id,{...context,synthesisMaterials:selections,synthesisState:{offset:0},synthesisNotes:[]},1000000);
  const limit=JSON.stringify(full).length-16000;
  const command=join(root,'paged-author.mjs');
  writeFileSync(command,`import {readFileSync,appendFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
appendFileSync('pages.jsonl',JSON.stringify(c.synthesisPage)+'\\n');
const seen=[...new Set([...(c.conclusions??c.synthesisNotes).flatMap(n=>n.proposal.value.seen),...c.selectedContext.map(o=>o.source.id)])];
const research={action:'answer',question:c.question.id,value:{seen},citations:c.selectedContext.map(o=>({source:o.source,selector:o.selector}))};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  let configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd,maxRequestChars:limit,maxCalls:1},pilot.revision);
  const dispatch={...environment.value,implementer:{...environment.value.implementer,command:cmd}};
  await assert.rejects(synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON'),{code:'pilot_call_limit'});
  const paused=store.list<any>('synthesis-session')[0]!;
  assert.ok(paused.value.offset>0&&paused.value.offset<3);assert.equal(paused.value.result,null);
  assert.equal(store.get<Question>(question.id)!.value.status,'open');
  const first=store.list<ModelCall>('model-call')[0]!;
  configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd,maxRequestChars:limit,maxCalls:10},configured.revision);
  const result=await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON');
  assert.equal(result.action,'answer');
  assert.deepEqual((result as any).value.seen,selections.map(s=>s.value.source.id));
  assert.deepEqual(store.get(first.id),first);
  const pages=readFileSync(join(root,'pages.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(pages[1].offset,pages[0].end);assert.equal(pages.at(-1).end,3);
  assert.ok(store.list<ModelCall>('model-call').every(c=>c.value.request.chars<=limit));
  assert.equal(pendingSynthesis(store,draft,question,environment,context),false);
  const count=store.list('model-call').length;
  writeFileSync(join(root,'first.txt'),'Changed after partial synthesis');
  assert.deepEqual(await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON'),result);
  assert.equal(store.list('model-call').length,count,'The finished direct task replays its saved answer by the saved bases, without another model call');
});

test("an explicit synthesis pause does not become an unresumable cached result", async t => {
  const {root,store,engine,environment,pilot,settings,draft,question}=fixture(t);
  const command=join(root,'pause-synthesis.mjs');
  writeFileSync(command,`import {readFileSync,existsSync,writeFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8'));const paused=existsSync('paused-once');writeFileSync('paused-once','1');const research=paused?{action:'need_research',question:req.subject.question.id,missing:['An additional source is required']}:{action:'pause',reason:'Explicit pause before continuing'};console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  const configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd},pilot.revision);
  const dispatch={...environment.value,implementer:{...environment.value.implementer,command:cmd}};
  const source=engine.discovery.evidence.file('p','direct-synthesis-source',root,'README.md','text/plain',0);
  const context={...pilotContext(store,draft,question),inventory:new ResearchSources(store,'p',root).inventory(),workingSelections:[{kind:'context',value:{ref:reference(source),length:source.value.content.length,excerpt:source.value.content}}]};
  assert.equal((await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON')).action,'pause');
  assert.equal(store.list<any>('synthesis-session')[0]!.value.result,null);
  assert.equal((await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON')).action,'need_research');
  assert.equal(store.list('model-call').length,2);
  writeFileSync(join(root,'README.md'),'Changed directly-read source');
  assert.equal((await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON')).action,'need_research',
    'the finished need_research outcome replays by its saved bases, without a current file check');
  store.write({id:question.id,kind:question.kind,expected:question.revision,value:{...question.value,spec:{...question.value.spec,prompt:'A changed question'}}});
  assert.equal((await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON')).action,'need_research',
    'the exact repeat of the final outcome is historical even under a moved head');
  assert.equal(store.list('model-call').length,2,'the finished direct task replays its saved outcome — exactly two payments');
});

test("synthesis combines recent selections with older paid readings without duplicate evidence", async t => {
  const {root,store,engine,environment,pilot,settings,draft,question}=fixture(t);
  writeFileSync(join(root,'older.txt'),'Header\nOlder necessary condition\nOlder exception\n');
  const older=await readBundle(store,environment.value,pilot,reference(question),'Older evidence',[{path:'older.txt',media:'text/plain'}]);
  const recent=await readBundle(store,environment.value,pilot,reference(question),'Recent evidence',[{path:'README.md',media:'text/plain'}]);
  const view=(r:typeof older)=>({ref:reference(r),purpose:r.value.purpose,observations:r.value.observations,coverage:r.value.coverage,unresolved:r.value.unresolved});
  const context={...pilotContext(store,draft,question),inventory:new ResearchSources(store,'p',root).inventory(),
    workingSelections:[{kind:'reader',key:'recent',value:view(recent)}],readings:[view(older),view(recent)]};
  const command=join(root,'complete-reader-context.mjs');
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;if(c.readings.length!==2||c.readings[0].purpose!=='Recent evidence'||c.readings[1].purpose!=='Older evidence')throw Error('Missing old evidence or duplicated recent evidence');console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'need_research',question:c.question.id,missing:['An actual new source is needed']},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  const configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd},pilot.revision);
  const dispatch={...environment.value,implementer:{...environment.value.implementer,command:cmd}};
  const result=await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON');
  assert.equal(result.action,'need_research');
  assert.equal(store.list('model-call').length,3,'Two paid reader results and one substantive call');
  assert.equal(pendingSynthesis(store,draft,question,environment,context),false);
});


test("the latest proposal remains stable beyond the compact eight-turn history", t => {
  const {store,question}=fixture(t);
  const proposal={action:'answer',question:question.id,value:{marker:'Retain this proposal'},citations:[]};
  const record=(number:number,action:unknown)=>store.write<ResearchTurn>({id:'proposal-history-'+number,kind:'research-turn',expected:0,
    value:{run:'history-fixture',number,action,status:'completed',question:reference(question),assessment:null,observation:null,error:null}});
  const turns=[record(1,proposal),...Array.from({length:10},(_,i)=>record(i+2,{action:'search',query:'source-'+i}))];
  assert.deepEqual(latestProposal(turns,question.id),proposal);
  assert.equal(latestProposal(turns.slice(-8),question.id),null,'Compact history alone cannot provide the resume identity');
  turns.push(record(12,{action:'answer',question:'foreign-question',value:{},citations:[]}));
  assert.deepEqual(latestProposal(turns,question.id),proposal);
  const corrected={...proposal,value:{marker:'Corrected'}};turns.push(record(13,corrected));
  assert.deepEqual(latestProposal(turns,question.id),corrected);
});

test("a pilot timeout override leaves the accepted source environment unchanged", t => {
  const {store,engine,environment,settings,pilot}=fixture(t);
  assert.equal(pilotEnvironment(environment.value,pilot.value).timeoutMs,environment.value.timeoutMs);
  const configured=configureReaderPilot(store,engine.environments,'p',{...settings,callTimeoutMs:1800000},pilot.revision);
  assert.equal(pilotEnvironment(environment.value,configured.value).timeoutMs,1800000);
  assert.deepEqual(store.get(environment.id),environment);
  for(const callTimeoutMs of [0,-1,1.5,3000001])assert.throws(()=>configureReaderPilot(store,engine.environments,'p',{...settings,callTimeoutMs},configured.revision),{code:'reader_pilot_invalid'});
});


test("current replies are accepted; a historical reply-limit record replays only its exact paid bytes", async t => {
  const {root,store,engine,environment,pilot,settings,draft,question}=fixture(t);
  const command=join(root,'oversized-provider.mjs');
  writeFileSync(command,`import {readFileSync,writeFileSync} from 'node:fs';const input=readFileSync(0,'utf8'),req=JSON.parse(input);writeFileSync('original-request.json',input);console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'answer',question:req.subject.question.id,value:'x'.repeat(4000),citations:[]},usage:{inputTokens:10,outputTokens:1000,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]},role={...environment.value.implementer,command:cmd};
  const configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd,maxReplyChars:128},pilot.revision);
  const context={...pilotContext(store,draft,question),inventory:new ResearchSources(store,'p',root).inventory()};
  const audit={store,draftId:draft.id,questionId:question.id,purpose:'analyst',pilot:configured};
  const accepted=await researchCall(role,environment.value,'Return JSON',context,undefined,audit) as any;
  assert.equal(accepted.value.length,4000);
  const original=store.list<ModelCall>('model-call')[0]!,input=readFileSync(join(root,'original-request.json'),'utf8');
  store.write<ModelCall>({id:original.id,kind:original.kind,expected:original.revision,value:{...original.value,status:'failed',error:'pilot_reply_limit'}});
  const response=await researchCall({...role,command:{executable:'/usr/bin/false',args:[]}},environment.value,'Return JSON',context,undefined,audit) as any;
  assert.equal(response.value.length,4000);assert.equal(store.get(original.id)!.revision,original.revision+1);
  assert.equal(store.list('model-call').length,1);assert.equal(store.list('research-response-replay').length,1);
  const changed=JSON.parse(input);changed.prompt='Different instruction';
  assert.equal(replayLimitedResponse(store,configured,role,draft.id,question.id,'analyst',JSON.stringify(changed)),null);
  assert.equal(replayLimitedResponse(store,configured,{...role,actor:'foreign'},draft.id,question.id,'analyst',input),null);
  assert.equal(replayLimitedResponse(store,configured,role,draft.id,question.id,'assessor',input),null);
  store.write({id:question.id,kind:question.kind,expected:question.revision,value:{...question.value,spec:{...question.value.spec,prompt:'Changed basis'}}});
  assert.throws(()=>replayLimitedResponse(store,configured,role,draft.id,question.id,'analyst',input),{code:'context_reference_stale'});
  // C51: a managed consumer call is recovered only through its own intent
  // chain. Both era markers independently exclude it from legacy replay.
  const managedRequest=(requestId:string)=>{
    const raw=JSON.stringify({...JSON.parse(input),prompt:'Managed instruction',requestId});
    return {...original.value,requested:role,profile:reference(configured),status:'failed' as const,
      error:'pilot_reply_limit',requestId,request:{hash:digest(raw),chars:raw.length,bytes:Buffer.byteLength(raw)},
      response:original.value.response,startedAt:original.value.startedAt+1,finishedAt:original.value.startedAt+2,
      consumerIntent:{id:'research-consumer-intent:managed',revision:1,hash:hashJson(['managed'])}};
  };
  const managedInput=JSON.stringify({...JSON.parse(input),prompt:'Managed instruction'});
  store.write<ModelCall>({id:`model-call:consumer:v1:${hashJson(['managed-1'])}`,kind:'model-call',expected:0,
    value:managedRequest('managed-1') as ModelCall});
  assert.equal(replayLimitedResponse(store,configured,role,draft.id,question.id,'analyst',managedInput),null,
    'A consumer-namespaced call keeps its bytes out of legacy replay');
  store.write<ModelCall>({id:`model-call:legacy-shaped:${hashJson(['managed-2'])}`,kind:'model-call',expected:0,
    value:managedRequest('managed-2') as ModelCall});
  assert.equal(replayLimitedResponse(store,configured,role,draft.id,question.id,'analyst',managedInput),null,
    'A consumerIntent marker alone excludes the call even under a legacy-shaped id');
});

test("planner response is accepted regardless of the former reply and round disciplines", async t => {
  const {root,store,engine,pilot,settings,draft,question}=fixture(t);
  const command=join(root,'last-planner.mjs');
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;const research=c.role==='reader'?{selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]}:{action:'read_plan',question:c.question.id,reads:[{action:'read_bundle',purpose:'Read the condition '+'.'.repeat(4000),inputs:[{path:'README.md',media:'text/plain'}]}]};console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:20,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd,reader:{...settings.reader,command:cmd},maxReplyChars:256,planning:{fields:[question.value.spec.field],maxRequestChars:100000,maxRounds:1}},pilot.revision);
  const resumed=await engine.researcher.run('p',draft.id,2);
  assert.equal(resumed.value.pauseCode,null);
  assert.equal(store.list<ModelCall>('model-call').filter(c=>c.value.purpose==='reading-planner').length,1);
  assert.equal(store.list('research-response-replay').length,0);
  assert.equal(store.list('reader-result').length,1);
});


test("a small L2 correction retains the whole prior proposal and validates the assembled layer", t => {
  const {root,engine,store,full,draft:r1}=fixture(t);
  answerTechnicalFixture(engine,'p',r1);engine.refinement.finishResearch('p','R1',reference(store.get(r1.id)!),0);
  const draft=engine.refinement.prepareLayer('p',2),question=store.get<Question>(draft.value.questions[0]!)!;
  const target=layerDesignOf(full,2) as any,operation=target.nodes.find((n:any)=>n.kind==='operation');
  const view=layerDeltaView(store,'p',target),bad={base:view.base,upserts:structuredClone(view.upserts),removes:view.removes};
  bad.upserts.nodes!.find(n=>n.id===operation.id)!.title='';
  const source=engine.discovery.evidence.file('p','delta-proof',root,'README.md','text/plain',0);
  const citations=[{source:reference(source),selector:{kind:'text-range' as const,start:0,end:source.value.content.length}}];
  const record=(id:string,action:unknown)=>store.write<ResearchTurn>({id,kind:'research-turn',expected:0,value:{run:'delta-fixture',number:1,action,question:reference(question),status:'completed',assessment:null,observation:null,error:'Invalid candidate'}});
  const original=record('initial-delta',{action:'answer_delta',question:question.id,...bad,citations});
  const graph=store.get('graph:p')!;
  assert.throws(()=>expandLayerDelta(store,draft,question,bad),{code:'graph_invalid'});
  assert.equal((layerDeltaCandidate(store,draft,question,bad) as any).nodes.find((n:any)=>n.id===operation.id).title,'');
  const patch={base:view.base,revises:reference(original),upserts:{nodes:[{id:operation.id,title:operation.title}]},removes:{}};
  researchAction({action:'answer_delta',question:question.id,...patch,citations});
  const sorted=(v:any)=>({...v,nodes:[...v.nodes].sort((a:any,b:any)=>a.id.localeCompare(b.id))});
  assert.deepEqual(sorted(expandLayerDelta(store,draft,question,patch)),sorted(target));
  const second=record('second-delta',{action:'answer_delta',question:question.id,...patch,citations});
  const next={...patch,revises:reference(second),upserts:{nodes:[{id:operation.id,title:'Refined operation'}]}};
  assert.equal((expandLayerDelta(store,draft,question,next) as any).nodes.find((n:any)=>n.id===operation.id).title,'Refined operation');
  assert.deepEqual(store.get('graph:p'),graph,'Proposal correction must not write the accepted map');
  assert.deepEqual(store.get(original.id),original,'History remains unchanged');
  const block=target.nodes.find((n:any)=>n.kind==='block');
  assert.throws(()=>expandLayerDelta(store,draft,question,{...patch,revises:reference(second),upserts:{nodes:[{id:block.id,title:'Silent upper-layer rewrite'}]}}),{code:'upper_layer_drift'});
  assert.throws(()=>expandLayerDelta(store,draft,question,{...patch,revises:{...reference(original),hash:'0'.repeat(64)}}),{code:'layer_delta_revision_foreign'});
  const foreign=store.write<ResearchTurn>({id:'foreign-delta',kind:'research-turn',expected:0,value:{...original.value,question:reference(store.get<Question>(r1.value.questions[0]!)!)}});
  assert.throws(()=>expandLayerDelta(store,draft,question,{...patch,revises:reference(foreign)}),{code:'layer_delta_revision_foreign'});
  assert.throws(()=>expandLayerDelta(store,draft,question,{...patch,base:{...view.base,revision:999}}),{code:'graph_stale'});
  store.write({id:question.id,kind:question.kind,expected:question.revision,value:{...question.value,spec:{...question.value.spec,prompt:'Changed research basis'}}});
  assert.throws(()=>expandLayerDelta(store,draft,store.get<Question>(question.id)!,patch),{code:'layer_delta_revision_foreign'});
});

test("a new correction reference cannot return the previous cached correction for an unchanged candidate", async t => {
  const {root,store,engine,environment,pilot,settings,draft:r1}=fixture(t);
  answerTechnicalFixture(engine,'p',r1);engine.refinement.finishResearch('p','R1',reference(store.get(r1.id)!),0);
  const draft=engine.refinement.prepareLayer('p',2),question=store.get<Question>(draft.value.questions[0]!)!;
  const source=engine.discovery.evidence.file('p','correction-source',root,'README.md','text/plain',0);
  const citations=[{source:reference(source),selector:{kind:'text-range',start:0,end:source.value.content.length}}];
  const command=join(root,'correction-ref.mjs');
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'answer_delta',question:c.question.id,base:c.graphBase,revises:c.previousProposalRef,upserts:{},removes:{},citations:${JSON.stringify(citations)}},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  const configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd},pilot.revision);
  const dispatch={...environment.value,implementer:{...environment.value.implementer,command:cmd}};
  const proposal={action:'answer_delta',question:question.id,base:reference(store.get('graph:p')!),upserts:{},removes:{},citations};
  const record=(id:string,action:unknown)=>store.write<ResearchTurn>({id,kind:'research-turn',expected:0,value:{run:'correction-ref',number:1,action,question:reference(question),status:'completed',assessment:null,observation:null,error:'graph_invalid'}});
  const first=record('correction-one',proposal),second=record('correction-two',{...proposal,revises:reference(first)});
  const context={...pilotContext(store,draft,question),inventory:new ResearchSources(store,'p',root).inventory(),graphBase:reference(store.get('graph:p')!),previousProposal:proposal,previousProposalRef:reference(first)};
  const a=await synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON') as any;
  const b=await synthesisSession(store,draft,question,environment,dispatch,configured,{...context,previousProposalRef:reference(second)},'Return JSON') as any;
  assert.deepEqual(a.revises,reference(first));assert.deepEqual(b.revises,reference(second));
  assert.equal(store.list('model-call').length,2,'A different exact proposal needs a fresh correction');
});

test("early technical consumer rejection does not depend on the pilot or pay an assessor", async t => {
  const { root, store, engine, environment, question } = fixture(t);
  const source = engine.discovery.evidence.file('p', 'early-source', root, 'README.md', 'text/plain', 0);
  const action = { action: 'answer' as const, question: question.id,
    value: { applicability: 'applicable', reason: 'fixture', facts: [], designs: [{ id: 'bad', decision: 'proposal', benefit: 'benefit', consumer: 'invented' }], gaps: [] },
    citations: [{ source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: 10 } }] };
  await assert.rejects(assessAnswer(store, question, action, environment, root), { code: 'research_proposal_invalid' });
  assert.equal(store.list('model-call').length, 0);
});

test("L3 delta preserves L2, carries its atomic horizon and refuses an empty horizon or foreign base", t => {
  const { engine, store, full } = fixture(t);
  const { level: _level, ...upper } = projectGraph(full, 2);
  engine.graphs.save("p", upper, store.get("graph:p")!.revision, "fixture");
  const draft = engine.discovery.create("p", "om-g2", "R2", full.nodes.find(n => n.kind === "product")!.id, [layerDesignSpec(3)], [], 1);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const target = layerDesignOf(full, 3, question.value.spec.layerAssembly), delta = layerDeltaView(store, "p", target, 3, question.value.spec.layerAssembly);
  const result = expandLayerDelta(store, draft, question, delta) as Record<string, Json>;
  assert.deepEqual(result['horizon'], full.horizon);
  assert.equal((result['nodes'] as {id:string}[]).length, full.nodes.length);
  assert.throws(() => expandLayerDelta(store, draft, question, {...delta, horizon: []}), {code: "answer_invalid"});
  assert.throws(() => expandLayerDelta(store, draft, question, {...delta, base: {...delta.base, revision: 999}}), {code: "graph_stale"});
});

test('map status has a product command and stale annotations are omitted from research packets',t=>{
  const {engine,store,draft,question,full}=fixture(t);
  const graph=store.get('graph:p')!, node=full.nodes.find(n=>n.kind==='block')!.id;
  engine.execute({type:'set-map-status',project:'p',expected:0,base:reference(graph),nodes:[{id:node,status:'existing',explanation:'Fixture source',code:[{path:'README.md',access:'read',status:'existing'}]}]});
  assert.ok(pilotContext(store,draft,question).mapStatus);
  store.write({id:graph.id,kind:graph.kind,expected:graph.revision,value:graph.value});
  const packet=pilotContext(store,draft,question);
  assert.equal(packet.mapStatus,null);
  assert.equal(packet.mapStatusFindings[0]!.code,'map_status_stale');
  assert.throws(()=>engine.execute({type:'set-map-status',project:'p',expected:1,base:reference(graph),nodes:[]}),{code:'command_invalid'});
});

test('declared physical envelope capacity refuses the actual call before the adapter starts',async t=>{
  const {engine,store,draft,question,environment,settings,pilot}=fixture(t);
  const bounded=configureReaderPilot(store,engine.environments,'p',{...settings,physicalLimits:{maxRequestChars:20,maxReplyChars:1000,basis:'Deterministic test transport capacity'}},pilot.revision);
  await assert.rejects(researchCall(environment.value.implementer,environment.value,'Fixture',pilotContext(store,draft,question),undefined,
    {store,draftId:draft.id,questionId:question.id,purpose:'analyst',pilot:bounded}),{code:'budget_transport_limit'});
  assert.equal(store.list('model-call').length,0);
});

test('an identical reader request reuses its paid extraction without another invocation',async t=>{
 const {store,environment,pilot,question,root,engine}=fixture(t);
 const source=engine.discovery.evidence.file('p','reuse-reader',root,'README.md','text/plain',0);
 const first=await readBundle(store,environment.value,pilot,reference(question),'same purpose',[{source:reference(source)}]);
 const count=store.list('model-call').length;
 const again=await readBundle(store,environment.value,pilot,reference(question),'same purpose',[{source:reference(source)}]);
 assert.deepEqual(reference(again),reference(first));assert.equal(store.list('model-call').length,count);
});

test('assessor context lookup does not skip the evidence page in a stateless continuation',async t=>{
 const {root,store,engine,environment,pilot,draft,question}=fixture(t);
 const source=engine.discovery.evidence.file('p','assessment-lookup',root,'README.md','text/plain',0);
 const observation=engine.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:10});
 const adapter=join(root,'lookup-assessor.mjs');
 writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync('lookup-pages.jsonl',JSON.stringify({offset:c.evidencePage.offset,core:Boolean(c.core)})+'\\n');const research=c.contextWorkspace?.length?{verdict:'supported',reasons:[]}:{action:'read_context',record:c.working.archive,pointer:'/body/value'};console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const dispatch={...environment.value,reviewer:{...environment.value.reviewer,command:{executable:process.execPath,args:[adapter]}}};
 const result=await assessmentSession(store,draft,question,environment,dispatch,pilot,{...pilotContext(store,draft,question),role:'assess-answer',value:{ok:'fixture'},observations:[observation]},'Assess') as any;
 assert.equal(result.verdict,'supported');
 const pages=readFileSync(join(root,'lookup-pages.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.deepEqual(pages,[{offset:0,core:true},{offset:0,core:false}]);
});

test('assessor can inspect distinct original pointers with equal values without a false no-progress refusal',async t=>{
 const {root,store,engine,environment,pilot,draft,question}=fixture(t);
 const source=engine.discovery.evidence.file('p','equal-lookup',root,'README.md','text/plain',0);
 const observation=engine.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:10});
 const adapter=join(root,'equal-lookup-assessor.mjs');
 writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync('equal-pages.jsonl',JSON.stringify({offset:c.evidencePage.offset,pointer:c.contextWorkspace?.at(-1)?.pointer??null})+'\\n');const focus=c.contextWorkspace?.at(-1);const research=!focus?{action:'read_context',record:c.working.archive,pointer:'/body/value/a'}:focus.pointer.endsWith('/a')?{action:'read_context',record:focus.record,pointer:'/body/value/b'}:{verdict:'supported',reasons:[]};console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const dispatch={...environment.value,reviewer:{...environment.value.reviewer,command:{executable:process.execPath,args:[adapter]}}};
 const result=await assessmentSession(store,draft,question,environment,dispatch,pilot,{...pilotContext(store,draft,question),role:'assess-answer',value:{a:'same',b:'same'},observations:[observation]},'Assess') as any;
 assert.equal(result.verdict,'supported');
 const pages=readFileSync(join(root,'equal-pages.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.deepEqual(pages,[{offset:0,pointer:null},{offset:0,pointer:'/body/value/a'},{offset:0,pointer:'/body/value/b'}]);
});

test("a malformed paid analyst payload ends in a typed terminal refusal instead of a repurchase", async t => {
  // C13/C62: the invalid response is the intent's terminal consumer-invalid
  // outcome bound to its exact call; repeat entry restores it, never repays.
  const { root, store, engine, pilot, settings, draft } = fixture(t);
  const command = join(root, 'invalid-analyst.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{bad:'payload'},usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const first = await engine.researcher.run('p', draft.id, 1);
  assert.equal(first.value.pauseCode, 'research_response_invalid');
  const intent = store.list<ResearchConsumerIntent>('research-consumer-intent').find(i => i.value.kind === 'analyst')!;
  assert.equal(intent.value.state, 'refused');
  assert.equal(intent.value.refusal?.kind, 'consumer-invalid');
  assert.equal(intent.value.refusal?.code, 'research_response_invalid');
  assert.equal(store.list('model-call').length, 1);
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  for (let i = 0; i < 2; i++) {
    const next = await new ProductEngine(db).researcher.run('p', draft.id, 1);
    assert.equal(next.value.status, 'paused');
    assert.equal(next.value.pauseCode, 'research_response_invalid');
    assert.equal(db.list('model-call').length, 1, 'A refused paid position never pays again');
  }
});

test("a malformed paid escalation verdict ends in a typed terminal refusal instead of a repurchase", async t => {
  const { root, store, engine, pilot, settings, draft } = fixture(t);
  const consulted = engine.discovery.evidence.document('p', 'owner-basis', 'Already consulted evidence', 'text/plain', 0);
  const command = join(root, 'invalid-escalation.mjs');
  writeFileSync(command, `import{readFileSync,writeFileSync,existsSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;const n=existsSync('count')?Number(readFileSync('count','utf8')):0;writeFileSync('count',String(n+1));let research;
if(c.role==='reader'){const lines=c.sources[0].lines.filter(l=>l[0]>=2&&l[0]<=3);research={selections:lines.length?[{source:c.sources[0].ref,firstLine:lines[0][0],lastLine:lines.at(-1)[0]}]:[],unresolved:[]};}
else if(c.role==='assess-escalation')research={unstructured:true};
else if(!n)research={action:'read',path:'README.md',media:'text/plain'};
else research={action:'need_owner',question:c.question.id,reason:'Owner-only choice',searched:[${JSON.stringify(reference(consulted))}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd = { executable: process.execPath, args: [command] };
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: cmd, reader: { ...settings.reader, command: cmd } }, pilot.revision);
  const first = await engine.researcher.run('p', draft.id, 3);
  assert.equal(first.value.pauseCode, 'escalation_assessment_invalid');
  const intent = store.list<ResearchConsumerIntent>('research-consumer-intent').find(i => i.value.kind === 'escalation-assessor')!;
  assert.equal(intent.value.state, 'refused');
  assert.equal(intent.value.refusal?.kind, 'consumer-invalid');
  assert.equal(intent.value.refusal?.code, 'escalation_assessment_invalid');
  const calls = store.list('model-call').length;
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  const next = await new ProductEngine(db).researcher.run('p', draft.id, 3);
  assert.equal(next.value.pauseCode, 'escalation_assessment_invalid');
  assert.equal(db.list('model-call').length, calls, 'A refused escalation never pays again');
});

test("retry of a failed planned child rebinds its unclaimed reader atomically", async t => {
  // C23: the retry writes the pending child and the rebound prepared reader in
  // one transaction; a claimed in-flight reader refuses the whole retry.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  for (const path of ['a.txt', 'b.txt']) writeFileSync(join(root, path), `Header\n${path} condition\n${path} exception\n`);
  const command = join(root, 'retry-reader.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(c.role==='reader')research={selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]};
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:['a','b'].map(n=>({action:'read_bundle',purpose:n,inputs:[{path:n+'.txt',media:'text/plain'}]}))};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Both read',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(r=>r.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd = { executable: process.execPath, args: [command] };
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: cmd, reader: { ...settings.reader, command: cmd }, planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes, guards = []) => { const rows = original(writes, guards);
    if (!hit && writes.some(w => w.kind === 'research-consumer-intent'
      && (w.value as ResearchConsumerIntent).kind === 'reader'
      && (w.value as ResearchConsumerIntent).state === 'prepared')) { hit = true; throw new EngineError('fixture_prepared', 'crash with unsent reader'); }
    return rows; }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 10); store.writeMany = original;
  const intent = store.list<ResearchConsumerIntent>('research-consumer-intent').find(i => i.value.kind === 'reader')!;
  assert.equal(intent.value.state, 'prepared', 'fixture left an unclaimed reader');
  const child = store.get<ResearchTurn>(intent.value.owner.id)!;
  assert.equal(child.value.status, 'pending');
  const failed = store.write<ResearchTurn>({ id: child.id, kind: child.kind, expected: child.revision,
    value: { ...child.value, status: 'completed', error: 'provider interrupted' } });
  const retried = retryPlannedRead(store, 'p', reference(failed));
  assert.equal(retried.value.status, 'pending'); assert.deepEqual(retried.value.replayedFrom, reference(failed));
  const rebound = readResearchConsumerIntent(store, reference(store.get(intent.id)!));
  assert.equal(rebound.revision, intent.revision + 1);
  assert.equal(rebound.value.state, 'prepared');
  assert.deepEqual(rebound.value.owner, reference(retried));
  assert.deepEqual(rebound.value.cursor.consumer.turn, reference(retried));
  store.write<ResearchConsumerIntent>({ id: rebound.id, kind: rebound.kind, expected: rebound.revision,
    value: { ...rebound.value, state: 'running',
      call: reference(store.list('model-call').at(-1)!), request: reference(store.list('model-request').at(-1)!),
      archive: reference(store.list('research-context').at(-1)!) } });
  const second = store.write<ResearchTurn>({ id: retried.id, kind: retried.kind, expected: retried.revision,
    value: { ...retried.value, status: 'completed', error: 'failed again' } });
  assert.throws(() => retryPlannedRead(store, 'p', reference(second)), { code: 'reading_plan_recovery_invalid' });
});

test("a saved paid analyst response is delivered even after the allowance profile changes", async t => {
  // C61: once the physical response exists, it is resumed and applied under
  // its original profile; a future maxCalls change cannot invalidate paid bytes.
  const { root, store, engine, settings, draft, question } = fixture(t);
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes, guards = []) => {
    if (!hit && writes.some(w => w.kind === 'research-consumer-intent'
      && (w.value as ResearchConsumerIntent).state === 'applied')) {
      hit = true; throw new EngineError('input_stale', 'interrupt before paid application'); }
    return original(writes, guards); }) as typeof store.writeMany;
  const first = await engine.researcher.run('p', draft.id, 1); store.writeMany = original;
  assert.ok(hit);
  assert.equal(first.value.pauseCode, 'input_stale');
  const analyst = store.list<ResearchConsumerIntent>('research-consumer-intent').find(i => i.value.kind === 'analyst')!;
  assert.equal(analyst.value.state, 'running');
  configureReaderPilot(store, engine.environments, 'p', { ...settings, maxCalls: settings.maxCalls + 1 },
    store.get('reader-pilot:p')!.revision);
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  const result = await new ProductEngine(db).researcher.run('p', draft.id, 1);
  assert.notEqual(result.value.pauseCode, 'research_consumer_context_stale');
  assert.equal(db.list<ResearchTurn>('research-turn').filter(x => x.value.status === 'completed').length, 1,
    'The saved response completed its paid turn');
  assert.equal(db.list<ModelCall>('model-call').filter(c => c.value.purpose === 'analyst').length, 1,
    'No second analyst payment');
  const again = new Store(join(root, 'state.sqlite')); t.after(() => again.close());
  await new ProductEngine(again).researcher.run('p', draft.id, 5);
  assert.equal(again.list<ResearchTurn>('research-turn').filter(x => x.value.status === 'completed'
    && (x.value.action as { action?: string }).action === 'read_bundle'
    && x.value.question?.id === question.id).length, 1,
    'the applied paid step of this question is not re-executed on continuation');
  assert.ok(again.list<ResearchTurn>('research-turn').length > 1,
    'the run progressed past the applied paid step');
});

test("a completed local read retains its derived reading on re-entry without another execution", async t => {
  // C32 first window: the completed turn is durable before retainPilotRead;
  // a crash between them is repaired from the exact turn on re-entry.
  // read_source is used because its observation binds a verifiable source
  // record — a path read is a navigation hint that stays non-current.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const source = engine.discovery.evidence.document('p', 'read-proof', '{"note":"local"}', 'application/json', 0);
  const command = join(root, 'local-read.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(!(c.readings||[]).length&&!(c.directReadings||[]).length&&!c.focus)research={action:'read_source',source:${JSON.stringify(reference(source))},start:0,end:15};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'read',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'json-pointer',pointer:'/note'}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes, guards = []) => {
    if (!hit && writes.some(w => w.kind === 'pilot-reading')) { hit = true; throw new EngineError('input_stale', 'interrupt before derivative'); }
    return original(writes, guards); }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1); store.writeMany = original;
  assert.ok(hit);
  const readsOf = (db: Store) => db.list<ResearchTurn>('research-turn').filter(x => isRef(x.value.question)
    && x.value.question!.id === question.id && x.value.status === 'completed'
    && (x.value.action as { action?: string }).action === 'read_source');
  assert.equal(readsOf(store).length, 1, 'the read turn is durable');
  assert.equal(store.list('pilot-reading').length, 0, 'the derivative did not land');
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  await new ProductEngine(db).researcher.run('p', draft.id, 2);
  assert.equal(readsOf(db).length, 1,
    'no second read of this question was executed');
  assert.equal(db.list<{ question: string }>('pilot-reading').filter(r => r.value.question === question.id).length, 1,
    'the completed turn re-derives its reading without another execution');
});

test("a completed search keeps its capture and re-derives its reading on re-entry", async t => {
  // C32 second window: the captured search record and the completed turn are
  // durable; the derived reading is repaired on re-entry, never by a second grep.
  const { root, store, engine, pilot, settings, draft } = fixture(t);
  writeFileSync(join(root, 'target.txt'), 'Alpha\nRestrict writes to the chosen scope.\nOmega\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'target.txt', 'README.md'], { cwd: root });
  const command = join(root, 'local-search.mjs');
  writeFileSync(command, `import{readFileSync,writeFileSync,existsSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;const n=existsSync('count')?Number(readFileSync('count','utf8')):0;writeFileSync('count',String(n+1));let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(!n)research={action:'search',query:'Restrict'};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'searched',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(r=>r.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes, guards = []) => {
    if (!hit && writes.some(w => w.kind === 'pilot-reading')) { hit = true; throw new EngineError('input_stale', 'interrupt before derivative'); }
    return original(writes, guards); }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1); store.writeMany = original;
  assert.ok(hit);
  assert.equal(store.list<ResearchTurn>('research-turn').filter(x => (x.value.action as any).action === 'search'
    && x.value.status === 'completed').length, 1, 'the search turn is durable');
  assert.equal(store.list('pilot-reading').length, 0, 'the derivative did not land');
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  await new ProductEngine(db).researcher.run('p', draft.id, 2);
  assert.equal(db.list('pilot-reading').length, 1,
    'the completed search turn re-derives its reading without another grep');
});

test("a matching pre-intent reply-limit call is recovered before a managed intent is paid", async t => {
  // C51 run door: a byte-identical legacy pilot_reply_limit call with a saved
  // response is delivered as a previous-era turn; no managed intent is created.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const packet = workingContext(store, 'p', draft.id, question.id,
    { note: 'legacy archived packet' }, 90000, { common: true });
  const archiveRef = (packet as { working: { archive: ReturnType<typeof reference> } }).working.archive;
  const requestId = `legacy-${randomUUID()}`;
  const requestText = JSON.stringify({ protocol: 'omg-agent/v1', requestId,
    subject: { working: { archive: archiveRef } } });
  const research = { action: 'read_bundle', purpose: 'recovered legacy read',
    inputs: [{ path: 'README.md', media: 'text/plain' }] };
  const responseText = JSON.stringify({ protocol: 'omg-agent/v1', requestId, research });
  const requestRecord = store.write({ id: `model-request:${requestId}`, kind: 'model-request', expected: 0,
    value: { projectId: 'p', draftId: draft.id, text: requestText } });
  const responseRecord = store.write({ id: `model-response:${requestId}`, kind: 'model-response', expected: 0,
    value: { projectId: 'p', draftId: draft.id, text: responseText } });
  store.write<ModelCall>({ id: `model-call:${requestId}`, kind: 'model-call', expected: 0, value: {
    projectId: 'p', draftId: draft.id, questionId: question.id, purpose: 'analyst', requestId,
    requested: { actor: 'author', model: 'fixture-author', effort: 'high' }, profile: reference(pilot),
    status: 'failed', startedAt: 1, finishedAt: 2, error: 'pilot_reply_limit',
    confirmed: { model: null, effort: null, speed: null }, usage: null, usageSource: 'unavailable',
    request: { chars: requestText.length, bytes: Buffer.byteLength(requestText), hash: digest(requestText),
      record: reference(requestRecord) },
    response: { record: reference(responseRecord), chars: responseText.length,
      bytes: Buffer.byteLength(responseText), hash: digest(responseText) } } as any });
  const command = join(root, 'should-not-be-called.mjs');
  writeFileSync(command, `import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync('called.jsonl','x'+'\\n');console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'managed path reached'},usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const first = await engine.researcher.run('p', draft.id, 1);
  assert.equal(store.list('research-response-replay').length, 1, 'the saved response is delivered as a replay');
  const turn = store.list<ResearchTurn>('research-turn').find(x => x.value.run === first.id)!;
  assert.ok(!turn.id.startsWith('research-turn:v1:'), 'the recovered turn is a previous-era record');
  assert.equal((turn.value.action as any).action, 'read_bundle');
  assert.equal(store.list<ModelCall>('model-call').filter(c => c.value.purpose === 'analyst').length, 1,
    'the same logical step was not sent again');
  assert.equal(store.list<ResearchConsumerIntent>('research-consumer-intent').filter(i => i.value.kind === 'analyst').length, 0,
    'no managed analyst intent was created for the replayed step');
});

test("an accepted paid answer persists its exact chain and stays readable across repeated identical answers", async t => {
  // №1745-2: each completed managed answer turn carries the exact adjacent
  // draft/question pair it accepted; history consumes the stored references
  // instead of rescanning a draft that moved on through identical cycles.
  const root = mkdtempSync(join(tmpdir(), 'omg-accepted-chain-'));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'History' });
  const source = engine.discovery.evidence.document('p', 'values', '{"result":"same answer"}', 'application/json', 0);
  const script = join(root, 'provider.mjs');
  writeFileSync(script, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;const research=c.role==='assess-answer'?{verdict:'supported',reasons:[]}:{action:'answer',question:c.questions[0].id,value:{result:'same answer'},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'json-pointer',pointer:'/result'}}]};console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [script] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 3000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{ field: 'result', kind: 'design',
    prompt: 'Give result', risk: 'missing', schema: { type: 'object', required: ['result'],
      properties: { result: { type: 'string' } } } }], []);
  const chains: { revision: number }[] = [];
  for (let i = 0; i < 3; i++) {
    await engine.researcher.run('p', draft.id, 1);
    const turns = store.list<ResearchTurn>('research-turn').sort((a, b) => a.value.number - b.value.number);
    const accepted = turns.filter(turn => turn.value.status === 'completed' && !turn.value.error
      && (turn.value.action as { action?: string }).action === 'answer' && turn.value.assessment);
    assert.equal(accepted.length, i + 1);
    const chain = (accepted.at(-1)!.value as { acceptance?: Record<string, { id: string; revision: number; hash: string }> }).acceptance;
    assert.ok(chain, 'Completed accepted turn persists the exact chain');
    for (const [key, kind] of [['draftBefore', 'discovery-draft'], ['draftAfter', 'discovery-draft'],
      ['questionBefore', 'question'], ['questionAfter', 'question'],
      ['answer', 'research-answer'], ['assessment', 'research-assessment']] as const) {
      const ref: { id: string; revision: number; hash: string } = chain[key]!;
      const record: Revision<unknown> | null = store.get(ref.id, ref.revision);
      assert.equal(record?.kind, kind); assert.equal(record?.hash, ref.hash, `${key} binds its exact revision`);
    }
    chains.push({ revision: chain['draftAfter']!.revision });
    for (const turn of turns) assert.doesNotThrow(() => readResearchConsumerTurn(store, reference(turn)));
    if (i < 2) { const q = store.get<Question>(draft.value.questions[0]!)!; engine.discovery.reopen(q.id, q.revision); }
  }
  assert.ok(chains[1]!.revision > chains[0]!.revision && chains[2]!.revision > chains[1]!.revision,
    'Identical answers still bind distinct exact chains');
  const callsDone = store.list('model-call').length;
  const resumed = new Store(join(root, 'db.sqlite')); t.after(() => resumed.close());
  const tail = await new ProductEngine(resumed).researcher.run('p', draft.id, 1);
  assert.notEqual(tail.value.pauseCode, 'research_consumer_intent_invalid');
  assert.equal(resumed.list('model-call').length, callsDone,
    'an answered question is not repurchased on continuation');
  for (const turn of resumed.list<ResearchTurn>('research-turn'))
    assert.doesNotThrow(() => readResearchConsumerTurn(resumed, reference(turn)),
      'every accepted chain stays readable on the new Store');
});

test("a retried planned child lets its rebound reader continue the queue on a new Store", async t => {
  // C23 continuation: the fix is proven on the NEXT entry — the rebound
  // unclaimed reader resumes from the parent queue (original stored ref plus
  // the lawful retry chain to the current pending revision), reads once and
  // the retried child completes. The run is not lost to
  // research_consumer_intent_invalid and paid parts are not repurchased.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  for (const path of ['a.txt', 'b.txt']) writeFileSync(join(root, path), `Header\n${path} condition\n${path} exception\n`);
  const command = join(root, 'retry-continue.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(c.role==='reader')research={selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]};
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:['a','b'].map(n=>({action:'read_bundle',purpose:n,inputs:[{path:n+'.txt',media:'text/plain'}]}))};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Both read',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(r=>r.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd = { executable: process.execPath, args: [command] };
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: cmd, reader: { ...settings.reader, command: cmd }, planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes, guards = []) => { const rows = original(writes, guards);
    if (!hit && writes.some(w => w.kind === 'research-consumer-intent'
      && (w.value as ResearchConsumerIntent).kind === 'reader'
      && (w.value as ResearchConsumerIntent).state === 'prepared')) { hit = true; throw new EngineError('fixture_prepared', 'crash with unsent reader'); }
    return rows; }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 10); store.writeMany = original;
  const intent = store.list<ResearchConsumerIntent>('research-consumer-intent').find(i => i.value.kind === 'reader')!;
  assert.equal(intent.value.state, 'prepared', 'fixture left an unclaimed reader');
  const child = store.get<ResearchTurn>(intent.value.owner.id)!;
  const failed = store.write<ResearchTurn>({ id: child.id, kind: child.kind, expected: child.revision,
    value: { ...child.value, status: 'completed', error: 'provider interrupted' } });
  const retried = retryPlannedRead(store, 'p', reference(failed));
  assert.equal(retried.value.status, 'pending');
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  const out = await new ProductEngine(db).researcher.run('p', draft.id, 10);
  assert.notEqual(out.value.pauseCode, 'research_consumer_intent_invalid',
    'the rebound reader resumes from its queue through the lawful retry chain');
  const continued = db.get<ResearchTurn>(retried.id)!;
  assert.equal(continued.value.status, 'completed');
  assert.equal(continued.value.error, null);
  const childCalls = db.list<ModelCall>('model-call')
    .filter(call => (call.value as { consumerIntent?: { id: string } }).consumerIntent?.id === intent.id);
  assert.equal(childCalls.length, 1, 'the retried child is read exactly once');
  assert.equal(db.list<ModelCall>('model-call').filter(c => c.value.purpose === 'reader').length, 2,
    'each queued child is read exactly once');
  assert.equal(db.list<ResearchTurn>('research-turn').filter(x => x.value.recoveredRequest).length, 0,
    'a managed-era queue never falls through the legacy recovery door');
});

function legacyReplyLimit(store: Store, pilot: Revision<ReaderPilot>,
  draft: Revision<DiscoveryDraft>, question: Revision<Question>, research: unknown) {
  const packet = workingContext(store, 'p', draft.id, question.id, { note: 'legacy archived packet' }, 90000, { common: true });
  const archiveRef = (packet as { working: { archive: ReturnType<typeof reference> } }).working.archive;
  const requestId = `legacy-${randomUUID()}`;
  const requestText = JSON.stringify({ protocol: 'omg-agent/v1', requestId,
    subject: { working: { archive: archiveRef } } });
  const responseText = JSON.stringify({ protocol: 'omg-agent/v1', requestId, research });
  const requestRecord = store.write({ id: `model-request:${requestId}`, kind: 'model-request', expected: 0,
    value: { projectId: 'p', draftId: draft.id, text: requestText } });
  const responseRecord = store.write({ id: `model-response:${requestId}`, kind: 'model-response', expected: 0,
    value: { projectId: 'p', draftId: draft.id, text: responseText } });
  return store.write<ModelCall>({ id: `model-call:${requestId}`, kind: 'model-call', expected: 0, value: {
    projectId: 'p', draftId: draft.id, questionId: question.id, purpose: 'analyst', requestId,
    requested: { actor: 'author', model: 'fixture-author', effort: 'high' }, profile: reference(pilot),
    status: 'failed', startedAt: 1, finishedAt: 2, error: 'pilot_reply_limit',
    confirmed: { model: null, effort: null, speed: null },
    usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 },
    usageSource: 'adapter',
    request: { chars: requestText.length, bytes: Buffer.byteLength(requestText), hash: digest(requestText),
      record: reference(requestRecord) },
    response: { record: reference(responseRecord), chars: responseText.length,
      bytes: Buffer.byteLength(responseText), hash: digest(responseText) } } as any });
}

test("a delivered legacy call keeps its position and never re-delivers on the next entry", async t => {
  // C51 continuation: the recovered turn owns the call's exact recoveredRequest
  // (id+revision+hash, this run only); repeated entries through new Stores move
  // on to the next lawful step — one managed analyst call — instead of
  // re-delivering the same paid bytes into new run positions.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const call = legacyReplyLimit(store, pilot, draft, question,
    { action: 'read_bundle', purpose: 'recovered legacy read',
      inputs: [{ path: 'README.md', media: 'text/plain' }] });
  const command = join(root, 'next-step.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;let research;
if(c.role==='reader'){const lines=c.sources[0].lines.filter(l=>l[0]>=2&&l[0]<=3);research={selections:lines.length?[{source:c.sources[0].ref,firstLine:lines[0][0],lastLine:lines.at(-1)[0]}]:[],unresolved:[]};}
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Recovered reading',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(x=>x.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd = { executable: process.execPath, args: [command] };
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: cmd, reader: { ...settings.reader, command: cmd } }, pilot.revision);
  await engine.researcher.run('p', draft.id, 1);
  assert.equal(store.list<ResearchTurn>('research-turn').filter(x => x.value.recoveredRequest?.id === call.id).length, 1,
    'the first entry delivers the saved response into exactly one turn');
  for (let n = 0; n < 2; n++) {
    const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
    await new ProductEngine(db).researcher.run('p', draft.id, 1);
    assert.equal(db.list<ResearchTurn>('research-turn').filter(x => x.value.recoveredRequest?.id === call.id).length, 1,
      'a delivered legacy call does not own another run position');
  }
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  const analysts = db.list<ModelCall>('model-call').filter(c => c.value.purpose === 'analyst');
  assert.equal(analysts.filter(c => c.id === call.id).length, 1, 'the fabricated legacy call is the only pre-intent one');
  assert.ok(analysts.length >= 2 && analysts.filter(c => c.id !== call.id)
    .every(c => c.id.startsWith('model-call:consumer:v1:')),
    'every analyst call after the legacy one belongs to the managed era');
  assert.equal(db.get<Question>(question.id)!.value.status, 'answered',
    'the question progressed to its terminal outcome');
});

test("a replay receipt without its delivered turn keeps the legacy call recoverable exactly once", async t => {
  // C51 window: research-response-replay is written before the turn — a crash
  // in between must not mark the call delivered. The next entry still picks it
  // as the single candidate and binds the delivery in exactly one turn.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const call = legacyReplyLimit(store, pilot, draft, question,
    { action: 'read_bundle', purpose: 'window read', inputs: [{ path: 'README.md', media: 'text/plain' }] });
  const command = join(root, 'window.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;let research;
if(c.role==='reader'){const lines=c.sources[0].lines.filter(l=>l[0]>=2&&l[0]<=3);research={selections:lines.length?[{source:c.sources[0].ref,firstLine:lines[0][0],lastLine:lines.at(-1)[0]}]:[],unresolved:[]};}
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Recovered',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(x=>x.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd = { executable: process.execPath, args: [command] };
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: cmd, reader: { ...settings.reader, command: cmd } }, pilot.revision);
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes, guards = []) => {
    if (!hit && writes.some(w => w.kind === 'research-turn' && w.expected === 0)) {
      hit = true; throw new EngineError('input_stale', 'crash before legacy turn delivery'); }
    return original(writes, guards); }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1); store.writeMany = original;
  assert.ok(hit, 'the crash landed between the receipt and the turn');
  assert.equal(store.list('research-response-replay').length, 1, 'the paid receipt exists');
  assert.equal(store.list<ResearchTurn>('research-turn').filter(x => x.value.recoveredRequest?.id === call.id).length, 0,
    'no turn delivered it yet');
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  await new ProductEngine(db).researcher.run('p', draft.id, 1);
  assert.equal(db.list('research-response-replay').length, 1,
    'the content-addressed receipt is not duplicated');
  assert.equal(db.list<ResearchTurn>('research-turn').filter(x => x.value.recoveredRequest?.id === call.id).length, 1,
    'the window closes by delivering the call exactly once');
  const again = new Store(join(root, 'state.sqlite')); t.after(() => again.close());
  await new ProductEngine(again).researcher.run('p', draft.id, 1);
  assert.equal(again.list<ResearchTurn>('research-turn').filter(x => x.value.recoveredRequest?.id === call.id).length, 1,
    'the delivered call leaves the candidate set');
});

test("a completed queued search child without a retry reads exactly as before", async t => {
  // Era rule for queuedChildReached: the stored ref remains the first exact
  // link — a managed search child that completed without any retry is read by
  // the historical validator through the same stored provenance as before.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  const command = join(root, 'queued-search.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'search',query:'Restrict'}]};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Searched',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(x=>x.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] },
    planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  await engine.researcher.run('p', draft.id, 10);
  const child = store.list<ResearchTurn>('research-turn').find(x => x.value.plannedBy
    && (x.value.action as { action?: string }).action === 'search' && x.value.status === 'completed' && !x.value.error);
  assert.ok(child, 'the queued search child completed');
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  const head = db.get<ResearchTurn>(child.id)!;
  assert.equal(head.value.status, 'completed');
  assert.doesNotThrow(() => readResearchConsumerTurn(db, reference(head)),
    'the non-retried completed search child still reads through its exact stored ref');
});

test("a failed queued search retries through its pending basis and the retried completion reads historically", async t => {
  // №1927-4(2): O stays the stored queue ref; the completion is proven from P —
  // the pending revision the retry actually produced. failed@2 must read as a
  // lawful failed outcome (no capture derivation), pending@3 -> completed@4
  // with capture bound to @3, all readable on a new Store.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  const command = join(root, 'search-retry.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'search',query:'Restrict'}]};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Searched',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(x=>x.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] },
    planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  const original = ResearchSources.prototype.searchCaptured; let hit = false;
  ResearchSources.prototype.searchCaptured = function (this: ResearchSources, ...args: Parameters<ResearchSources['searchCaptured']>) {
    if (!hit) { hit = true; throw new EngineError('fixture_search_io', 'Transient search failure'); }
    return original.apply(this, args);
  } as typeof ResearchSources.prototype.searchCaptured;
  try { await engine.researcher.run('p', draft.id, 10); }
  finally { ResearchSources.prototype.searchCaptured = original; }
  const failed = store.list<ResearchTurn>('research-turn').find(x => x.value.plannedBy
    && (x.value.action as { action?: string }).action === 'search' && x.value.question?.id === question.id
    && x.value.status === 'completed' && x.value.error);
  assert.ok(failed, 'the runner recorded the failed search child');
  assert.equal(failed.revision, 2);
  const db0 = new Store(join(root, 'state.sqlite')); t.after(() => db0.close());
  assert.doesNotThrow(() => readResearchConsumerTurn(db0, reference(failed)),
    'a lawful failed queue child reads as failed — never as a successful capture');
  const retried = retryPlannedRead(store, 'p', reference(failed));
  assert.equal(retried.revision, 3);
  assert.equal(retried.value.status, 'pending');
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  const out = await new ProductEngine(db).researcher.run('p', draft.id, 10);
  assert.notEqual(out.value.pauseCode, 'research_consumer_intent_invalid');
  assert.notEqual(out.value.pauseCode, 'reading_plan_blocked',
    'the run moved past the retried child — the plan is no longer blocked on it');
  const completed = db.get<ResearchTurn>(retried.id)!;
  assert.equal(completed.revision, 4);
  assert.equal(completed.value.status, 'completed');
  assert.equal(completed.value.error, null);
  const capture = db.get<Record<string, any>>((completed.value.observation as { capture?: { id: string } }).capture!.id)!;
  assert.equal(capture.kind, 'research-search-capture');
  assert.equal((capture.value.turn as { revision?: number }).revision, 3,
    'the capture is bound to the exact pending basis P, not to the stored O');
  assert.doesNotThrow(() => readResearchConsumerTurn(db, reference(completed)),
    'the retried completed search reads historically from its pending basis');
  assert.doesNotThrow(() => readResearchConsumerTurn(db, reference(db.get<ResearchTurn>(failed.id, 2)!)),
    'the failed attempt still reads as failed after the retried completion');
});

test("a doubly retried queued search keeps every failed attempt and the final completion readable by their own bases", async t => {
  // №1927-4(3): two failures with a retry between them — @2 and @4 read as
  // failed from their own pending bases (@1 and @3), the success @6 reads from
  // @5 with its capture, all proven without today's files on a new Store.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  const command = join(root, 'search-retry2.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'search',query:'Restrict'}]};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Searched',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(x=>x.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] },
    planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  const original = ResearchSources.prototype.searchCaptured; let failures = 2;
  ResearchSources.prototype.searchCaptured = function (this: ResearchSources, ...args: Parameters<ResearchSources['searchCaptured']>) {
    if (failures > 0) { failures -= 1; throw new EngineError('fixture_search_io', 'Transient search failure'); }
    return original.apply(this, args);
  } as typeof ResearchSources.prototype.searchCaptured;
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  const db2 = new Store(join(root, 'state.sqlite')); t.after(() => db2.close());
  let childId = '';
  try {
    await engine.researcher.run('p', draft.id, 10);
    const child = store.list<ResearchTurn>('research-turn').find(x => x.value.plannedBy
      && (x.value.action as { action?: string }).action === 'search' && x.value.question?.id === question.id)!;
    childId = child.id;
    const current = db.get<ResearchTurn>(child.id)!;
    assert.equal(current.revision, 2);
    assert.equal(current.value.status, 'completed');
    assert.ok(current.value.error, 'first attempt failed');
    assert.doesNotThrow(() => readResearchConsumerTurn(db, reference(current)),
      'failed revision 2 reads by its own pending basis');
    retryPlannedRead(db, 'p', reference(current));
    // The second failure is still armed — the retried pending child fails again.
    await new ProductEngine(db2).researcher.run('p', draft.id, 10);
  } finally { ResearchSources.prototype.searchCaptured = original; }
  const secondFailed = db2.get<ResearchTurn>(childId, 4)!;
  assert.equal(secondFailed.value.status, 'completed');
  assert.ok(secondFailed.value.error, 'second attempt failed from its own pending basis @3');
  assert.doesNotThrow(() => readResearchConsumerTurn(db2, reference(secondFailed)),
    'the second failed attempt reads historically');
  retryPlannedRead(db2, 'p', reference(secondFailed));
  const db3 = new Store(join(root, 'state.sqlite')); t.after(() => db3.close());
  const out = await new ProductEngine(db3).researcher.run('p', draft.id, 10);
  assert.notEqual(out.value.pauseCode, 'research_consumer_intent_invalid');
  assert.notEqual(out.value.pauseCode, 'reading_plan_blocked',
    'the run moved past the retried child — the plan is no longer blocked on it');
  const completed = db3.get<ResearchTurn>(childId)!;
  assert.equal(completed.revision, 6);
  assert.equal(completed.value.status, 'completed');
  assert.equal(completed.value.error, null);
  assert.doesNotThrow(() => readResearchConsumerTurn(db3, reference(completed)),
    'the final retried completion reads from pending basis @5');
  const capture = db3.get<Record<string, any>>((completed.value.observation as { capture?: { id: string } }).capture!.id)!;
  assert.equal((capture.value.turn as { revision?: number }).revision, 5,
    'the capture of the final completion is bound to its own pending basis');
});

test("a failed queued search that rewrote its pending basis is refused, not read as failed", async t => {
  // №1927-4 masquerade: a failed outcome may change only the completion
  // payload. Forging a different question/action on top of the pending basis
  // is refused by the shared derivation, not read as a lawful failure.
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  const command = join(root, 'search-forge.mjs');
  writeFileSync(command, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'search',query:'Restrict'}]};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Searched',facts:[],designs:[{id:'d',decision:'ok',benefit:'ok',consumer:'compilation'}],gaps:[]},citations:(c.readings||[]).flatMap(x=>x.observations.map(o=>({source:o.source,selector:o.selector})))};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store, engine.environments, 'p', { ...settings, agentCommand: { executable: process.execPath, args: [command] },
    planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, pilot.revision);
  const original = ResearchSources.prototype.searchCaptured; let hit = false;
  ResearchSources.prototype.searchCaptured = function (this: ResearchSources, ...args: Parameters<ResearchSources['searchCaptured']>) {
    if (!hit) { hit = true; throw new EngineError('fixture_search_io', 'Transient search failure'); }
    return original.apply(this, args);
  } as typeof ResearchSources.prototype.searchCaptured;
  try { await engine.researcher.run('p', draft.id, 10); }
  finally { ResearchSources.prototype.searchCaptured = original; }
  const failed = store.list<ResearchTurn>('research-turn').find(x => x.value.plannedBy
    && (x.value.action as { action?: string }).action === 'search' && x.value.question?.id === question.id
    && x.value.status === 'completed' && x.value.error)!;
  const retried = retryPlannedRead(store, 'p', reference(failed));
  assert.equal(retried.value.status, 'pending');
  // Forge a failed outcome on the pending basis but with a foreign question.
  const forged = store.write<ResearchTurn>({ id: retried.id, kind: retried.kind, expected: retried.revision,
    value: { ...retried.value, status: 'completed', question: { id: 'question:p:forged', revision: 1, hash: 'f'.repeat(64) },
      observation: { code: 'fixture_search_io', details: null }, error: { code: 'fixture_search_io', details: null } } });
  assert.throws(() => readResearchConsumerTurn(store, reference(forged)),
    (error: unknown) => (error as { code?: string }).code === 'research_consumer_intent_invalid',
    'a failed outcome that changed its pending basis is refused, not read as failed');
  const db = new Store(join(root, 'state.sqlite')); t.after(() => db.close());
  assert.throws(() => readResearchConsumerTurn(db, reference(forged)),
    (error: unknown) => (error as { code?: string }).code === 'research_consumer_intent_invalid',
    'the forged failure is refused on a new Store as well');
  // A forged middle step of the chain is refused too: a pending replay whose
  // recorded action differs from the queue's basis is not part of the lawful
  // chain even when the endpoint pending looks original.
  const forgedStep = store.write<ResearchTurn>({ id: retried.id, kind: retried.kind, expected: forged.revision,
    value: { ...retried.value, replayedFrom: reference(forged), action: { action: 'search', query: 'forged query' } } });
  const endpoint = store.write<ResearchTurn>({ id: retried.id, kind: retried.kind, expected: forgedStep.revision,
    value: { ...retried.value, replayedFrom: reference(forgedStep) } });
  const outcome = store.write<ResearchTurn>({ id: retried.id, kind: retried.kind, expected: endpoint.revision,
    value: { ...endpoint.value, status: 'completed', observation: { code: 'fixture_search_io', details: null },
      error: { code: 'fixture_search_io', details: null } } });
  assert.throws(() => readResearchConsumerTurn(db, reference(outcome)),
    (error: unknown) => (error as { code?: string }).code === 'research_consumer_intent_invalid',
    'a lawful-looking endpoint over a forged middle step is refused');
});

// ===========================================================================
// D8.4.1 (договор №2314, таблица S1–S4): общий исторический читатель reader-result у прежних
// потребителей — reusableReaderRanges (1), priorReaderIndex (2), readPilotContext (3),
// pilotContext.readings (4), pilotContext.currentRead (5), latestFocus (6), workingSelections /
// readerSelection (7). Доказательство целой записи общим читателем идёт до отбора байтов; сегодняшний
// допуск сохраняет прежнюю гранулярность.
// ===========================================================================
const readerInvalid = (error: unknown) => error instanceof EngineError && error.code === "reader_result_invalid";
function rawRewrite(database: string, id: string, revision: number, value: unknown): void {
  const raw = new DatabaseSync(database);
  try {
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?").run(canonical(value), hashJson(value), id, revision);
  } finally { raw.close(); }
}
function rawDrop(database: string, id: string): void {
  const raw = new DatabaseSync(database);
  try {
    raw.exec("PRAGMA foreign_keys=OFF");
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_delete");
    raw.prepare("DELETE FROM revisions WHERE entity_id=?").run(id);
    raw.prepare("DELETE FROM heads WHERE entity_id=?").run(id);
  } finally { raw.close(); }
}
/** A copy of a reader result at its own recomputed content address (either era's prefix) with a substituted body. */
function forgedCopy(store: Store, record: Revision<ReaderResult>, patch: Partial<ReaderResult>): Revision<ReaderResult> {
  const value = { ...record.value, ...patch };
  const prefix = record.id.startsWith("reader-result:v2:") ? "reader-result:v2:" : "reader-result:";
  return store.write<ReaderResult>({ id: `${prefix}${hashJson(value)}`, kind: "reader-result", expected: 0, value });
}
function bundleTurn(store: Store, result: Revision<ReaderResult>, question: Revision<Question>, id: string): Revision<ResearchTurn> {
  return store.write<ResearchTurn>({ id, kind: "research-turn", expected: 0,
    value: { run: "fixture", number: 1, action: { action: "read_bundle", purpose: result.value.purpose, inputs: [] },
      observation: { ref: reference(result), observations: result.value.observations, coverage: result.value.coverage, unresolved: result.value.unresolved },
      assessment: null, error: null, status: "completed", question: reference(question) } });
}
async function readingFixture(t: test.TestContext) {
  const f = fixture(t);
  writeFileSync(join(f.root, "a.txt"), "Header\nSelected A\nException A\n");
  writeFileSync(join(f.root, "b.txt"), "Header\nSelected B\nException B\n");
  const result = await readBundle(f.store, f.environment.value, f.pilot, reference(f.question), "Read A and B",
    [{ path: "a.txt", media: "text/plain" }, { path: "b.txt", media: "text/plain" }]);
  assert.equal(result.value.producer, "paid");
  const sources = result.value.sources.map(ref => f.store.get<import("../src/evidence/evidence.js").Source>(ref.id, ref.revision)!);
  const other = f.engine.discovery.create("p", "discovery", "R0", "compilation",
    [{ field: "other", kind: "design", prompt: "Another question", risk: "r", schema: { type: "object" } }]);
  const otherQuestion = f.store.get<Question>(other.value.questions[0]!)!;
  const database = join(f.root, "state.sqlite");
  return { ...f, result, sources, otherQuestion, database,
    supplied: () => sources.map(source => numberedSource(source)),
    calls: () => f.store.list("model-call").length };
}

test("D8.4.1 S1: a proven and current reader result is used as before on every entry — reuse, index, page, readings, direct reads, focus and selections", async t => {
  const f = await readingFixture(t);
  const ranges = reusableReaderRanges(f.store, "p", f.supplied());
  assert.equal(ranges.observations.length, 1); assert.deepEqual(ranges.reusedFrom, [reference(f.result)]); // (1)
  assert.equal(priorReaderIndex(f.store, "p", f.otherQuestion.id).length, 1); // (2)
  const page = readPilotContext(f.store, f.draft, reference(f.result), "/observations/0", Number.MAX_SAFE_INTEGER); // (3)
  assert.deepEqual(page.value, f.result.value.observations[0]);
  const context = pilotContext(f.store, f.draft, f.question);
  assert.deepEqual(context.readings.map(item => item.ref), [reference(f.result)]); // (4)
  retainPilotRead(f.store, "p", f.question.id, { action: "read_context", record: reference(f.result), pointer: "/observations/0" }, page);
  assert.equal(pilotContext(f.store, f.draft, f.question).directReadings.length, 1); // (5)
  const turn = bundleTurn(f.store, f.result, f.question, "fixture-turn-s1");
  assert.ok(latestFocus(f.store, [turn], f.question)); // (6)
  const selections = workingSelections(f.store, [turn], f.question); // (7)
  assert.equal(selections.length, 1); assert.equal(selections[0]!.kind, "reader");
  assert.equal(readReaderResultAt(f.store, "p", reference(f.result)).id, f.result.id);
});

test("D8.4.1 S2: a proven result that is not current today is excluded without a refusal at the previous granularity — the observation of the unchanged source stays reusable, the whole result leaves readings and selections, the requested page is stale, the direct read is false", async t => {
  const f = await readingFixture(t);
  const page = readPilotContext(f.store, f.draft, reference(f.result), "/observations/0", Number.MAX_SAFE_INTEGER);
  retainPilotRead(f.store, "p", f.question.id, { action: "read_context", record: reference(f.result), pointer: "/observations/0" }, page);
  const turn = bundleTurn(f.store, f.result, f.question, "fixture-turn-s2");
  writeFileSync(join(f.root, "b.txt"), "changed B");
  assert.ok(f.engine.discovery.evidence.verify(f.result.value.observations[0]!), "the observation of a.txt is still current");
  assert.equal(readReaderResultAt(f.store, "p", reference(f.result)).id, f.result.id, "history does not depend on today's file");
  const ranges = reusableReaderRanges(f.store, "p", f.supplied());
  assert.equal(ranges.observations.length, 1, "(1) the good observation of the second source remains reusable");
  assert.equal(priorReaderIndex(f.store, "p", f.otherQuestion.id).length, 1, "(2) the index keeps the current observation");
  assert.deepEqual(readPilotContext(f.store, f.draft, reference(f.result), "/observations/0", Number.MAX_SAFE_INTEGER).value, f.result.value.observations[0], "(3) the page of the current observation");
  const context = pilotContext(f.store, f.draft, f.question);
  assert.equal(context.readings.length, 0, "(4) the whole result is not current");
  assert.equal(context.directReadings.length, 1, "(5) the direct read of the still-current observation stays");
  assert.equal(latestFocus(f.store, [turn], f.question), null, "(6) a stale material is no focus");
  assert.equal(workingSelections(f.store, [turn], f.question).length, 0, "(7) and no selection");
  writeFileSync(join(f.root, "a.txt"), "changed A");
  assert.throws(() => readPilotContext(f.store, f.draft, reference(f.result), "/observations/0", Number.MAX_SAFE_INTEGER), { code: "research_evidence_stale" }, "(3) the requested page is stale");
  assert.equal(pilotContext(f.store, f.draft, f.question).directReadings.length, 0, "(5) the direct read is false, not a refusal");
  assert.equal(reusableReaderRanges(f.store, "p", f.supplied()).observations.length, 0, "(1) nothing reusable, no refusal");
});

test("D8.4.1 S3: a copy with a recomputed address and substituted coverage/observations/unresolved, a lost result or a lost basis is the common reader's addressed refusal on every entry — never skipped, false or a fallback context; damaged and stale at once is still the refusal", async t => {
  const f = await readingFixture(t);
  const forged = forgedCopy(f.store, f.result, { coverage: f.result.value.coverage.map(entry => ({ ...entry, visibleRange: { start: 0, end: 5 } })), unresolved: ["forged conclusion"] });
  assert.throws(() => readReaderResultAt(f.store, "p", reference(forged)), readerInvalid);
  const entries: [string, () => unknown][] = [
    ["(1) reuse scan", () => reusableReaderRanges(f.store, "p", f.supplied())],
    ["(2) prior index", () => priorReaderIndex(f.store, "p", f.otherQuestion.id)],
    ["(3) page", () => readPilotContext(f.store, f.draft, reference(forged), "/observations/0", Number.MAX_SAFE_INTEGER)],
    ["(4) readings", () => pilotContext(f.store, f.draft, f.question)],
    ["(6) focus", () => latestFocus(f.store, [bundleTurn(f.store, forged, f.question, `fixture-turn-s3-${randomUUID()}`)], f.question)],
    ["(7) selections", () => workingSelections(f.store, [bundleTurn(f.store, forged, f.question, `fixture-turn-s3-${randomUUID()}`)], f.question)],
  ];
  for (const [name, entry] of entries) assert.throws(entry, readerInvalid, name);
  // Damaged and stale at once: the proof comes first, the refusal is not turned into a stale exclusion.
  writeFileSync(join(f.root, "b.txt"), "changed B");
  for (const [name, entry] of entries) assert.throws(entry, readerInvalid, `${name} (stale too)`);
  rawDrop(f.database, forged.id);
  // The lost exact result behind a saved page, a saved focus or a direct read: S3, not another branch.
  const page = readPilotContext(f.store, f.draft, reference(f.result), "/observations/0", Number.MAX_SAFE_INTEGER);
  retainPilotRead(f.store, "p", f.question.id, { action: "read_context", record: reference(f.result), pointer: "/observations/0" }, page);
  const contextTurn = f.store.write<ResearchTurn>({ id: "fixture-turn-s3-context", kind: "research-turn", expected: 0,
    value: { run: "fixture", number: 1, action: { action: "read_context", record: reference(f.result), pointer: "/observations/0" },
      observation: page, assessment: null, error: null, status: "completed", question: reference(f.question) } });
  const bundle = bundleTurn(f.store, f.result, f.question, "fixture-turn-s3-lost");
  rawDrop(f.database, f.result.id);
  assert.throws(() => readPilotContext(f.store, f.draft, reference(f.result), "/observations/0", Number.MAX_SAFE_INTEGER), readerInvalid, "(3) lost");
  assert.throws(() => pilotContext(f.store, f.draft, f.question), readerInvalid, "(5) a direct read of a lost result is a refusal, not false");
  assert.throws(() => latestFocus(f.store, [bundle], f.question), readerInvalid, "(6) lost material");
  assert.throws(() => latestFocus(f.store, [contextTurn], f.question), readerInvalid, "(6) lost page result");
  assert.throws(() => workingSelections(f.store, [contextTurn], f.question), readerInvalid, "(7) no fallback context from a lost result");
  // A lost basis (the exact pilot revision) of an intact result is the same refusal.
  const g = await readingFixture(t);
  rawRewrite(g.database, g.result.value.pilot.id, g.result.value.pilot.revision, { ...g.pilot.value, maxCalls: 99 });
  assert.throws(() => reusableReaderRanges(g.store, "p", g.supplied()), readerInvalid, "(1) lost basis");
  assert.throws(() => pilotContext(g.store, g.draft, g.question), readerInvalid, "(4) lost basis");
});

test("D8.4.1 S1/S3 for combined and reused results: proven through the common reader's own rules, a substituted part or origin refuses", async t => {
  const f = fixture(t);
  // Two sources whose packet together exceeds the request envelope while each half fits: the reader
  // splits the selection into a combined result of two paid parts.
  const long = (label: string) => `Header\n${`Selected ${label} condition `.repeat(2800)}\nException ${label}\n`;
  writeFileSync(join(f.root, "a.txt"), long("A")); writeFileSync(join(f.root, "b.txt"), long("B"));
  const narrow = configureReaderPilot(f.store, f.engine.environments, "p", { ...f.settings, maxReadChars: 200000 }, f.pilot.revision);
  const combined = await readBundle(f.store, f.environment.value, narrow, reference(f.question), "Read both halves",
    [{ path: "a.txt", media: "text/plain" }, { path: "b.txt", media: "text/plain" }]);
  assert.equal(combined.value.producer, "combined", JSON.stringify(combined.value.parts));
  // A request for exactly the bytes already read is served from the proven prior result without a call.
  const observedA = combined.value.observations.find(item => item.source.id === combined.value.sources[0]!.id)!;
  assert.equal(observedA.selector.kind, "text-range");
  const window = observedA.selector.kind === "text-range" ? { start: observedA.selector.start, end: observedA.selector.end } : { start: 0, end: 0 };
  const reused = await readBundle(f.store, f.environment.value, narrow, reference(f.question), "Read A again",
    [{ path: "a.txt", media: "text/plain", range: window }]);
  assert.equal(reused.value.producer, "reused");
  const calls = f.store.list("model-call").length;
  const supplied = combined.value.sources.map(ref => numberedSource(f.store.get<import("../src/evidence/evidence.js").Source>(ref.id, ref.revision)!));
  assert.ok(reusableReaderRanges(f.store, "p", supplied).observations.length >= 2, "(1) both halves reusable through the proven combined result");
  const readings = pilotContext(f.store, f.draft, f.question).readings.map(item => item.ref.id);
  assert.ok(readings.includes(combined.id) && readings.includes(reused.id), "(4) the parent, not its child parts, and the reused result");
  assert.ok(!readings.some(id => combined.value.parts!.some(part => part.id === id)));
  const forgedCombined = forgedCopy(f.store, combined, { parts: [combined.value.parts![0]!, combined.value.parts![0]!] });
  assert.throws(() => pilotContext(f.store, f.draft, f.question), readerInvalid, "a combined copy with substituted parts refuses the scan");
  rawDrop(join(f.root, "state.sqlite"), forgedCombined.id);
  const forgedReused = forgedCopy(f.store, reused, { reusedFrom: [combined.value.parts![1]!] });
  assert.throws(() => reusableReaderRanges(f.store, "p", supplied), readerInvalid, "a reused copy with a substituted origin refuses the scan");
  rawDrop(join(f.root, "state.sqlite"), forgedReused.id);
  assert.equal(f.store.list("model-call").length, calls);
});

const PRIOR_ERA_LOADER = String.raw`
import ts from TYPESCRIPT;
import { execFileSync } from 'node:child_process';
let root, repository, baseline;
export function initialize(data) { root = data.root; repository = data.repository; baseline = data.baseline; }
export async function load(url, context, nextLoad) {
  if (url.startsWith(root) && url.endsWith('.js')) {
    const path = decodeURIComponent(url.slice(root.length)).replace(/\.js$/, '.ts');
    const body = execFileSync('git', ['show', baseline + ':' + path], { cwd: repository, encoding: 'utf8', maxBuffer: 10_000_000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(body,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return nextLoad(url, context);
}
`;
const PRIOR_ERA_SCENARIO = String.raw`
import { register } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config = CONFIG;
register(config.loader, { data: { root: config.dist, repository: config.repository, baseline: config.baseline } });
const { Store } = await import(config.dist + 'src/storage/store.js');
const { ProductEngine } = await import(config.dist + 'src/product/engine.js');
const { configureReaderPilot } = await import(config.dist + 'src/discovery/reader-pilot.js');
const { readBundle } = await import(config.dist + 'src/discovery/reader.js');
const { reference } = await import(config.dist + 'src/pipeline/contracts.js');
const { preparedFeatures } = await import(config.dist + 'test/product-fixture.js');
const { exampleGraph } = await import(config.dist + 'test/graph-fixture.js');
const { enrichedGraph } = await import(config.dist + 'test/enriched-graph-fixture.js');
const { projectGraph } = await import(config.dist + 'src/graph/project.js');
const root = join(config.directory, 'prior'); mkdirSync(root, { recursive: true });
const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
const full = enrichedGraph(exampleGraph('p'), 'p'); preparedFeatures(engine, 'p', full);
const { level: _level, ...initial } = projectGraph(full, 1);
engine.graphs.save('p', initial, store.get('graph:p').revision, 'fixture');
const command = { executable: process.execPath, args: ['--version'] };
engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture-author', effort: 'high', command },
  reviewer: { actor: 'assessor', model: 'fixture-assessor', effort: 'high', command }, fullCheck: command, timeoutMs: 3000 }, 0);
const readerPath = join(root, 'reader.mjs');
writeFileSync(join(root, 'README.md'), 'Planned runtime\nRestrict writes to the chosen scope.\nRoll back on failure.\n');
writeFileSync(readerPath, "import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;"
  + "const lines=c.sources[0].lines.filter(line=>line[0]>=2&&line[0]<=3);"
  + "const research={selections:[{sourceIndex:0,firstLine:lines[0][0],lastLine:lines.at(-1)[0]}],unresolved:[]};"
  + "console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:100,outputTokens:25,cachedInputTokens:0,reasoningOutputTokens:5}}));");
const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
  reader: { actor: 'reader', model: 'fixture-reader', effort: 'high', speed: 'fast', command: { executable: process.execPath, args: [readerPath] } },
  agentCommand: { executable: process.execPath, args: [readerPath] }, maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000, maxCalls: 20, maxReportedTokens: 100000 }, 0);
const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
const draft = engine.refinement.begin('p', 'R1'); const question = store.get(draft.value.questions[0]);
const environment = engine.environments.get('p');
const result = await readBundle(store, environment.value, pilot, reference(question), 'Read runtime conditions', [{ path: 'README.md', media: 'text/plain' }]);
console.log(JSON.stringify({ root, database: join(root, 'state.sqlite'), draft: draft.id, question: question.id, result: reference(result),
  id: result.id, calls: store.list('model-call').length }));
store.close();
`;

test("D8.4.1 S4: a reader result of the previous era (producer 2a74d7f, address reader-result:<hash>) passes S1–S3 through the same common reader on every entry, without migration", async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omg-d841-prior-era-")));
  const stores: Store[] = [];
  t.after(() => { for (const db of stores) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const loaderFile = join(directory, "prior-loader.mjs"), script = join(directory, "prior-producer.mjs");
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  const dist = pathToFileURL(fileURLToPath(new URL("../", import.meta.url))).href;
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  writeFileSync(loaderFile, PRIOR_ERA_LOADER.replace("TYPESCRIPT", JSON.stringify(typescript)));
  writeFileSync(script, PRIOR_ERA_SCENARIO.replace("CONFIG", JSON.stringify({ directory, repository, dist,
    loader: pathToFileURL(loaderFile).href, baseline: "2a74d7f75e84fb089790cf5e9ca500e05decc54a" })));
  const output = execFileSync(process.execPath, [script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n").at(-1)!;
  const produced = JSON.parse(output) as { root: string; database: string; draft: string; question: string; result: Ref; id: string; calls: number };
  assert.ok(produced.id.startsWith("reader-result:") && !produced.id.startsWith("reader-result:v2:"), produced.id);
  const store = new Store(produced.database); stores.push(store);
  const record = readReaderResultAt(store, "p", produced.result);
  assert.equal(record.value.contract, undefined, "the previous era carries no producer contract");
  const draft = store.get<DiscoveryDraft>(produced.draft)!, question = store.get<Question>(produced.question)!;
  const source = store.get<import("../src/evidence/evidence.js").Source>(record.value.sources[0]!.id, record.value.sources[0]!.revision)!;
  const supplied = () => [numberedSource(source)];
  const other = new ProductEngine(store).discovery.create("p", "discovery", "R0", "compilation",
    [{ field: "other", kind: "design", prompt: "Another question", risk: "r", schema: { type: "object" } }]);
  // S1 on every entry.
  assert.deepEqual(reusableReaderRanges(store, "p", supplied()).reusedFrom, [produced.result]);
  assert.equal(priorReaderIndex(store, "p", other.value.questions[0]!).length, 1);
  const page = readPilotContext(store, draft, produced.result, "/observations/0", Number.MAX_SAFE_INTEGER);
  assert.deepEqual(page.value, record.value.observations[0]);
  assert.deepEqual(pilotContext(store, draft, question).readings.map(item => item.ref), [produced.result]);
  retainPilotRead(store, "p", question.id, { action: "read_context", record: produced.result, pointer: "/observations/0" }, page);
  assert.equal(pilotContext(store, draft, question).directReadings.length, 1);
  const turn = bundleTurn(store, record, question, "fixture-turn-s4");
  assert.ok(latestFocus(store, [turn], question)); assert.equal(workingSelections(store, [turn], question).length, 1);
  assert.equal(store.list("model-call").length, produced.calls, "no repurchase");
  // S3: a previous-era copy with substituted coverage at its recomputed address refuses every scan and the page.
  const forged = forgedCopy(store, record, { coverage: record.value.coverage.map(entry => ({ ...entry, visibleRange: { start: 0, end: 3 } })) });
  assert.ok(forged.id.startsWith("reader-result:") && !forged.id.startsWith("reader-result:v2:"));
  assert.throws(() => reusableReaderRanges(store, "p", supplied()), readerInvalid);
  assert.throws(() => priorReaderIndex(store, "p", other.value.questions[0]!), readerInvalid);
  assert.throws(() => readPilotContext(store, draft, reference(forged), "/observations/0", Number.MAX_SAFE_INTEGER), readerInvalid);
  assert.throws(() => pilotContext(store, draft, question), readerInvalid);
  assert.throws(() => latestFocus(store, [bundleTurn(store, forged, question, "fixture-turn-s4-forged")], question), readerInvalid);
  rawDrop(produced.database, forged.id);
  // S2: today's file moved — the proven previous-era result is excluded without a refusal.
  writeFileSync(join(produced.root, "README.md"), "changed today");
  assert.equal(readReaderResultAt(store, "p", produced.result).id, record.id, "history stays provable");
  assert.equal(pilotContext(store, draft, question).readings.length, 0);
  assert.equal(reusableReaderRanges(store, "p", supplied()).observations.length, 0);
  assert.equal(latestFocus(store, [turn], question), null);
  assert.throws(() => readPilotContext(store, draft, produced.result, "/observations/0", Number.MAX_SAFE_INTEGER), { code: "research_evidence_stale" });
});

// ---------------------------------------------------------------------------
// D8.4.1 круг 2 (№2332): никакое обязательное поле не читается до общего читателя (1); заявленный
// проект не доверяется до доказательства (2). Пробы ревьюера — постоянные регрессии.
// ---------------------------------------------------------------------------
test("D8.4.1-2 (№2332-1): a candidate of this project whose mandatory question is unreadable reaches the common reader on every scan — an addressed refusal, never an untyped exception or a silent exclusion; a record without a readable body claims no project and no scope", async t => {
  const f = await readingFixture(t);
  for (const [name, patch] of [["question null", { question: null }], ["question not a reference", { question: "not-a-ref" }],
    ["pilot null", { pilot: null }], ["sources null", { sources: null }], ["observations null", { observations: null }]] as const) {
    const bad = forgedCopy(f.store, f.result, patch as unknown as Partial<ReaderResult>);
    assert.throws(() => readReaderResultAt(f.store, "p", reference(bad)), readerInvalid, name);
    assert.throws(() => priorReaderIndex(f.store, "p", f.otherQuestion.id), readerInvalid, `(2) ${name}`);
    assert.throws(() => pilotContext(f.store, f.draft, f.question), readerInvalid, `(4) ${name}`);
    assert.throws(() => reusableReaderRanges(f.store, "p", f.supplied()), readerInvalid, `(1) ${name}`);
    rawDrop(f.database, bad.id);
  }
  f.store.write({ id: "reader-result:v2:bodyless", kind: "reader-result", expected: 0, value: null });
  f.store.write({ id: "reader-result:v2:listbody", kind: "reader-result", expected: 0, value: [1, 2] });
  assert.equal(reusableReaderRanges(f.store, "p", f.supplied()).observations.length, 1, "records without a readable body belong to no project scope");
  assert.equal(pilotContext(f.store, f.draft, f.question).readings.length, 1);
  assert.equal(priorReaderIndex(f.store, "p", f.otherQuestion.id).length, 1);
});

test("D8.4.1-2 (№2332-2): a rewritten projectId behind a saved Ref is the common reader's refusal on the page and in the direct read — never context_reference_foreign or false; a PROVEN result of another project keeps the previous access refusal", async t => {
  const f = await readingFixture(t);
  const ref = reference(f.result);
  const page = readPilotContext(f.store, f.draft, ref, "/observations/0", Number.MAX_SAFE_INTEGER);
  retainPilotRead(f.store, "p", f.question.id, { action: "read_context", record: ref, pointer: "/observations/0" }, page);
  rawRewrite(f.database, f.result.id, f.result.revision, { ...f.result.value, projectId: "foreign" });
  assert.throws(() => readReaderResultAt(f.store, "p", ref), readerInvalid);
  assert.throws(() => readPilotContext(f.store, f.draft, ref, "/observations/0", Number.MAX_SAFE_INTEGER), readerInvalid, "(3) the corrupt claim is not a foreign result");
  assert.throws(() => pilotContext(f.store, f.draft, f.question), readerInvalid, "(5) the direct read does not hide the lost basis as stale");
  rawRewrite(f.database, f.result.id, f.result.revision, f.result.value);
  // The genuine result of project p read by a draft of another project: proven as p's result, refused as foreign.
  const foreignDraft = { ...f.draft, value: { ...f.draft.value, projectId: "foreign" } };
  assert.throws(() => readPilotContext(f.store, foreignDraft, ref, "/observations/0", Number.MAX_SAFE_INTEGER), { code: "context_reference_foreign" });
  assert.deepEqual(readPilotContext(f.store, f.draft, ref, "/observations/0", Number.MAX_SAFE_INTEGER).value, page.value);
  assert.equal(pilotContext(f.store, f.draft, f.question).directReadings.length, 1);
});

test("review (№2332): missing question is reader_result_invalid in priorReaderIndex and pilotContext; a corrupt project claim behind a saved ref is reader_result_invalid on the page and is not hidden by currentRead", async t => {
  const f = await readingFixture(t);
  const bad = forgedCopy(f.store, f.result, { question: null } as unknown as Partial<ReaderResult>);
  assert.throws(() => readReaderResultAt(f.store, "p", reference(bad)), readerInvalid);
  assert.throws(() => priorReaderIndex(f.store, "p", f.otherQuestion.id), readerInvalid);
  assert.throws(() => pilotContext(f.store, f.draft, f.question), readerInvalid);
  rawDrop(f.database, bad.id);
  const g = await readingFixture(t);
  const ref = reference(g.result);
  const page = readPilotContext(g.store, g.draft, ref, "/observations/0", Number.MAX_SAFE_INTEGER);
  retainPilotRead(g.store, "p", g.question.id, { action: "read_context", record: ref, pointer: "/observations/0" }, page);
  rawRewrite(g.database, g.result.id, g.result.revision, { ...g.result.value, projectId: "foreign" });
  assert.throws(() => readReaderResultAt(g.store, "p", ref), readerInvalid);
  assert.throws(() => readPilotContext(g.store, g.draft, ref, "/observations/0", Number.MAX_SAFE_INTEGER), readerInvalid);
  assert.throws(() => pilotContext(g.store, g.draft, g.question), readerInvalid);
});

// ---------------------------------------------------------------------------
// D8.4.1 круг 3 (№2353, таблица B1–B5): однократная привязка общего читателя в reader-reuse.
// ---------------------------------------------------------------------------
test("D8.4.1-3 B1/B2/B3 (№2353): an empty slot refuses every scan with an addressed reader_result_invalid; the first bound function is not invoked at binding; a repeat of the same function has no effect", async t => {
  const f = await readingFixture(t);
  // The slot is empty only in a process that has not loaded pilot-context: a child imports reader-reuse alone
  // (reader.js would load research-limits → pilot-context and bind the proof, so the source window is built by hand).
  const script = `import { Store } from ${JSON.stringify(new URL("../src/storage/store.js", import.meta.url).href)};
import { priorReaderIndex, reusableReaderRanges, bindReaderResultProof } from ${JSON.stringify(new URL("../src/discovery/reader-reuse.js", import.meta.url).href)};
import { reference } from ${JSON.stringify(new URL("../src/pipeline/contracts.js", import.meta.url).href)};
const store = new Store(${JSON.stringify(f.database)}); const out = {};
const code = fn => { try { fn(); return "ok"; } catch (error) { return error.code ?? String(error); } };
out.emptyIndex = code(() => priorReaderIndex(store, "p", ${JSON.stringify(f.otherQuestion.id)}));
const source = store.get(${JSON.stringify(f.sources[0]!.id)}, ${f.sources[0]!.revision});
const supplied = [{ ref: reference(source), totalChars: source.value.content.length, visibleRange: { start: 0, end: source.value.content.length }, partial: false, lines: [] }];
out.emptyRanges = code(() => reusableReaderRanges(store, "p", supplied));
let calls = 0; const spy = (db, project, ref) => { calls += 1; return db.get(ref.id, ref.revision); };
out.firstBind = code(() => bindReaderResultProof(spy)); out.callsAtBind = calls;
out.repeatBind = code(() => bindReaderResultProof(spy)); out.callsAfterRepeat = calls;
out.scanAfterBind = code(() => priorReaderIndex(store, "p", ${JSON.stringify(f.otherQuestion.id)})); out.callsAfterScan = calls;
process.stdout.write(JSON.stringify(out)); store.close();`;
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60000 })) as Record<string, unknown>;
  assert.equal(out['emptyIndex'], "reader_result_invalid", "B1: the index scan refuses on an empty slot");
  assert.equal(out['emptyRanges'], "reader_result_invalid", "B1: the reuse scan refuses on an empty slot");
  assert.equal(out['firstBind'], "ok"); assert.equal(out['callsAtBind'], 0, "B2: the bound function is not invoked at binding");
  assert.equal(out['repeatBind'], "ok"); assert.equal(out['callsAfterRepeat'], 0, "B3: the repeat has no effect");
  assert.equal(out['scanAfterBind'], "ok"); assert.equal(out['callsAfterScan'], 1, "the bound function proves the candidate when a scan runs");
  // B3 in the loaded process: the established binding of pilot-context is repeated without effect.
  bindReaderResultProof(readReaderResultAt);
  assert.equal(priorReaderIndex(f.store, "p", f.otherQuestion.id).length, 1);
});

test("D8.4.1-3 B4/B5 (№2353, reviewer probe): another function is a typed conflict and the established proof stays — both scans still refuse the damaged copy; a non-function is a typed refusal that leaves the slot intact", async t => {
  const f = await readingFixture(t);
  const bad = forgedCopy(f.store, f.result, { question: null } as unknown as Partial<ReaderResult>);
  assert.throws(() => readReaderResultAt(f.store, "p", reference(bad)), readerInvalid);
  const impostor = (store: Store, _project: string, ref: Ref) => store.get<ReaderResult>(ref.id, ref.revision)!;
  assert.throws(() => bindReaderResultProof(impostor), { code: "reader_proof_conflict" }, "B4: another function does not replace the bound proof");
  assert.throws(() => priorReaderIndex(f.store, "p", f.question.id), readerInvalid, "B4: the index scan still proves with the established reader");
  assert.throws(() => priorReaderIndex(f.store, "p", f.otherQuestion.id), readerInvalid);
  assert.throws(() => reusableReaderRanges(f.store, "p", f.supplied()), readerInvalid, "B4: the reuse scan still proves with the established reader");
  for (const value of [null, undefined, "readReaderResultAt", 42, {}, []] as unknown[])
    assert.throws(() => bindReaderResultProof(value as never), { code: "reader_proof_invalid" }, `B5: ${String(value)}`);
  assert.throws(() => priorReaderIndex(f.store, "p", f.otherQuestion.id), readerInvalid, "B5: the slot is intact after a wrong argument");
  rawDrop(f.database, bad.id);
  assert.equal(priorReaderIndex(f.store, "p", f.otherQuestion.id).length, 1, "the established proof keeps serving lawful candidates");
  assert.equal(reusableReaderRanges(f.store, "p", f.supplied()).observations.length, 1);
});


import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { configureReaderPilot, pilotEnvironment, type ReaderPilotSettings } from "../src/discovery/reader-pilot.js";
import { numberedSource, readerSourcePacket, readerObservations, readBundle } from "../src/discovery/reader.js";
import { pilotContext, readPilotContext } from "../src/discovery/pilot-context.js";
import { reference } from "../src/pipeline/contracts.js";
import { canonical } from "../src/canonical.js";
import { preparedFeatures } from "./product-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { projectGraph } from "../src/graph/project.js";
import type { Question, DiscoveryDraft } from "../src/discovery/discovery.js";
import type { ModelCall } from "../src/runtime/model-usage.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { layerDesignOf } from "../src/graph/layer-design.js";
import { expandLayerDelta, layerDeltaView } from "../src/discovery/layer-delta.js";
import type { ConsumerResult } from "../src/discovery/consumer-research.js";
import type { Json } from "../src/canonical.js";
import { answerLayerFixture } from "./layer-design-fixture.js";
import type { ResearchTurn } from "../src/discovery/research-model.js";
import { modelUsage } from "../src/runtime/model-usage.js";
import { contextTable, targetFieldGroups, type ContextTable } from "../src/discovery/context-tables.js";
import { workingContext } from "../src/discovery/working-context.js";
import { checkpoint, latestProposal, recoverableAnswer, workingSelections } from "../src/discovery/research-continuation.js";
import { assessAnswer } from "../src/discovery/research-assessment.js";
import { assessmentSession } from "../src/discovery/assessment-session.js";
import { researchCall } from "../src/discovery/research-protocol.js";
import { replayLimitedResponse } from "../src/discovery/response-replay.js";
import { synthesisSession, pendingSynthesis } from "../src/discovery/synthesis-session.js";
import { recoverableReadingPlan } from "../src/discovery/planning-recovery.js";
import { ResearchSources } from "../src/discovery/research-sources.js";

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
if(c.role!=='reader'&&c.dispatchMode!=='planning'&&(!c.contextEncoding||JSON.stringify(c).indexOf('"core":')>JSON.stringify(c).indexOf('"question":')))throw Error('Stable product context must precede the question');
if(c.role==='reader')research={selections:[{source:c.sources[0].ref,firstLine:2,lastLine:3}],unresolved:[]};
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
  assert.throws(() => engine.refinement.begin("p", "R2"), { code: "phase_not_ready" }, "Disabling the pilot does not bypass normal prerequisites");
});

test("R1 pilot routes reading to its configured reader, assesses originals, and resumes without repeating accepted answers", async t => {
  const { engine, store, draft } = fixture(t);
  const first = await engine.researcher.run("p", draft.id, 4);
  assert.equal(first.value.status, "paused");
  const answered = draft.value.questions.slice(0, 2).map(id => store.get<Question>(id)!);
  assert.ok(answered.every(q => q.value.status === "answered"));
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
  const { engine, store, settings, pilot, draft: r1, full } = fixture(t);
  const inactive = configureReaderPilot(store, engine.environments, "p", { ...settings, active: false }, pilot.revision);
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
  configureReaderPilot(store, engine.environments, "p", settings, inactive.revision);
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
  const { engine, store, settings, pilot, draft, question } = fixture(t);
  const limited = configureReaderPilot(store, engine.environments, "p", { ...settings, maxCalls: 3 }, pilot.revision);
  await engine.researcher.run("p", draft.id, 2);
  const pending = store.list<ResearchTurn>("research-turn").find(turn => turn.value.status === "pending")!;
  const legacy = store.write<ResearchTurn>({ id: pending.id, kind: pending.kind, expected: pending.revision,
    value: { ...pending.value, status: "completed", error: "An input changed before the transaction could commit" } });
  assert.equal(recoverableAnswer([legacy], question)?.id, legacy.id);
  assert.equal(recoverableAnswer([{ ...legacy, value: { ...legacy.value, error: "Semantic refusal" } }], question), null);
  assert.equal(recoverableAnswer([legacy], { ...question, revision: 99 }), null);
  configureReaderPilot(store, engine.environments, "p", { ...settings, maxCalls: 4 }, limited.revision);
  await engine.researcher.run("p", draft.id, 1);
  assert.deepEqual(store.get(legacy.id), legacy, "Historical failed turn is untouched");
  assert.ok(store.list<ResearchTurn>("research-turn").some(turn => turn.value.replayedFrom?.id === legacy.id));
  assert.equal(store.list<ModelCall>("model-call").filter(call => call.value.purpose === "analyst").length, 2);
  assert.equal(store.get<Question>(question.id)!.value.status, "answered");
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

test("an assessor checkpoint cannot forget requested context that did not fit the wire", async t => {
  const { root, store, engine, environment, settings, pilot, draft, question } = fixture(t);
  const source = engine.discovery.evidence.file("p", "focus-source", root, "README.md", "text/plain", 0);
  const observations = [engine.discovery.evidence.observe("p", reference(source), { kind: "text-range", start: 0, end: source.value.content.length })];
  const command = join(root, "focus-provider.mjs");
  writeFileSync(command, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
const step=existsSync('focus-step')?Number(readFileSync('focus-step','utf8')):0;writeFileSync('focus-step',String(step+1));
const research=step===0?{action:'read_context',record:c.working.archive,pointer:'/body/extra'}:step===1?{action:'assessment_checkpoint',notes:['Still awaiting context']}:{verdict:'supported',reasons:[]};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const selected = configureReaderPilot(store, engine.environments, "p", { ...settings, maxRequestChars: 60000, maxReadChars: 200000,
    agentCommand: { executable: process.execPath, args: [command] } }, pilot.revision);
  const context = { ...pilotContext(store, draft, question), role: "assess-answer", observations, value: "candidate", extra: "exception ".repeat(10000) };
  await assert.rejects(assessmentSession(store, draft, question, environment, pilotEnvironment(environment.value, selected.value), selected, context, "Evaluate"),
    { code: "assessment_invalid" });
  const session = store.list<any>("assessment-session")[0]!.value;
  assert.equal(session.result, null);
  assert.equal(session.focus.value, context.extra);
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
    assert.equal(turns.at(-1)!.value.status, "pending");
    assert.equal((turns.at(-1)!.value.observation as any).code, "research_no_progress");
    assert.notEqual((turns[0]!.value.action as any).record.id, (turns.at(-1)!.value.action as any).record.id);
    assert.equal(store.list<ModelCall>("model-call").filter(c=>c.value.purpose==='analyst').length, alternating ? 3 : 2);
    assert.equal(store.get<Question>(question.id)!.value.status, "open");
  }
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
  assert.equal(packet.question.schema, undefined);
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

test("planner cannot approve an answer from the index and its round count survives restart", async t => {
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  const source = engine.discovery.evidence.file("p", "planner-cite", root, "README.md", "text/plain", 0);
  const command = join(root, "bad-planner.mjs");
  const action = {action:'answer',question:question.id,value:{applicability:'applicable',reason:'valid shape',facts:[],designs:[{id:'d',decision:'Do work',benefit:'Benefit',consumer:'compilation'}],gaps:[]},
    citations:[{source:reference(source),selector:{kind:'text-range',start:0,end:source.value.content.length}}]};
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:${JSON.stringify(action)},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store,engine.environments,"p",{...settings,agentCommand:{executable:process.execPath,args:[command]},planning:{fields:[question.value.spec.field],maxRequestChars:50000,maxRounds:3}},pilot.revision);
  await engine.researcher.run("p",draft.id,2);
  const run = await engine.researcher.run("p",draft.id,5);
  assert.equal(run.value.pauseCode,"planning_round_limit");
  assert.equal(store.list("model-call").length,3);
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

test("an audited archive plan recovers its question binding without another planner call", async t => {
  const {root,store,engine,pilot,settings,draft,question}=fixture(t);
  const command=join(root,'archived-plan.mjs');
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
const research={action:'read_plan',question:c.question.prompt,reads:[{action:'read_context',record:c.working.archive,pointer:'/body/question/prompt'}]};
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:{executable:process.execPath,args:[command]},planning:{fields:[question.value.spec.field],maxRequestChars:50000,maxRounds:1}},pilot.revision);
  await engine.researcher.run('p',draft.id,1);
  const original=store.list<ResearchTurn>('research-turn').at(-1)!;
  const recovery=recoverableReadingPlan(store,[original],draft,question)!;
  assert.ok(recovery);assert.equal(recovery.action.question,question.id);
  assert.deepEqual(recovery.action.reads,(original.value.action as any).reads);
  await engine.researcher.run('p',draft.id,2);
  const turns=store.list<ResearchTurn>('research-turn').sort((a,b)=>a.value.number-b.value.number);
  assert.deepEqual(store.get(original.id),original,'Original rejected turn remains immutable');
  assert.equal(store.list('model-call').length,1,'Recovery consumes no new planning allowance');
  assert.deepEqual(turns[1]!.value.replayedFrom,reference(original));
  assert.deepEqual(turns[1]!.value.recoveredRequest,recovery.request);
  assert.equal(turns[2]!.value.status,'completed');assert.equal(turns[2]!.value.error,null);
  assert.equal(recoverableReadingPlan(store,turns,draft,question),null,'Never replay the same request twice');
  assert.equal(store.get<Question>(question.id)!.value.status,'open','Reading recovery never accepts a question');
});

test("archive plan recovery rejects missing audit, forged response and foreign or changed question", async t => {
  const {root,store,engine,pilot,settings,draft,question}=fixture(t);
  const command=join(root,'recovery-audit.mjs');
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'read_plan',question:'A prose question',reads:[{action:'read_context',record:c.working.archive,pointer:'/body/question/prompt'}]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:{executable:process.execPath,args:[command]},planning:{fields:[question.value.spec.field],maxRequestChars:50000,maxRounds:1}},pilot.revision);
  await engine.researcher.run('p',draft.id,1);
  const original=store.list<ResearchTurn>('research-turn').at(-1)!,call=store.list<ModelCall>('model-call')[0]!;
  assert.ok(recoverableReadingPlan(store,[original],draft,question));
  const altered=(patch:Partial<ModelCall>)=>{const current=store.get<ModelCall>(call.id)!;store.write({id:call.id,kind:call.kind,expected:current.revision,value:{...call.value,...patch}});};
  for(const patch of [{questionId:'question:foreign'}, {response:null}, {status:'failed' as const}, {response:{...call.value.response!,record:{...call.value.response!.record!,hash:'0'.repeat(64)}}}]){
    altered(patch);assert.equal(recoverableReadingPlan(store,[original],draft,question),null);
  }
  altered({});
  const foreign={...original,value:{...original.value,action:{...(original.value.action as any),question:'question:foreign'}}};
  assert.equal(recoverableReadingPlan(store,[foreign],draft,question),null);
  const forged={...original,value:{...original.value,action:{...(original.value.action as any),reads:[{action:'read_context',record:(original.value.action as any).reads[0].record,pointer:'/body/inventory'}]}}};
  assert.equal(recoverableReadingPlan(store,[forged],draft,question),null,'Changed selection does not match paid response');
  const current=store.get<Question>(question.id)!;store.write({id:current.id,kind:current.kind,expected:current.revision,value:{...current.value,spec:{...current.value.spec,prompt:'Changed question'}}});
  assert.equal(recoverableReadingPlan(store,[original],draft,store.get<Question>(question.id)!),null);
});

test("grouped reads resume only the failed child and then switch to substantive synthesis", async t => {
  const { root, store, engine, pilot, settings, draft, question } = fixture(t);
  for(const path of ['a.txt','b.txt'])writeFileSync(join(root,path),`Header\n${path} condition\n${path} exception\n`);
  const command=join(root,'batch-provider.mjs');
  writeFileSync(join(root,'fail-b'),'once');
  writeFileSync(command,`import {readFileSync,existsSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;let research;
if(c.role==='reader'){research={selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]};if(c.purpose==='b'&&existsSync('fail-b'))process.exitCode=1;}
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:['a','b'].map(n=>({action:'read_bundle',purpose:n,inputs:[{path:n+'.txt',media:'text/plain'}]}))};
else {if(!c.question.schema||c.readings.length!==2)throw Error('Synthesis needs real content');if(req.prompt.includes('"action":"read"')||req.prompt.includes('prefer one related bundle'))throw Error('Synthesis cannot carry planning instructions');research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Both groups read',facts:[],designs:[{id:'d',decision:'Respect both conditions',benefit:'Safe result',consumer:'compilation'}],gaps:[]},citations:c.readings.flatMap(r=>r.observations.map(o=>({source:o.source,selector:o.selector})))};}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  configureReaderPilot(store,engine.environments,"p",{...settings,agentCommand:cmd,reader:{...settings.reader,command:cmd},planning:{fields:[question.value.spec.field],maxRequestChars:50000,maxRounds:3}},pilot.revision);
  const first=await engine.researcher.run("p",draft.id,10);
  assert.equal(first.value.pauseCode,'research_provider_failed');
  assert.equal(store.list('reader-result').length,1);
  const acceptedRead=store.list('reader-result')[0]!;
  assert.equal(store.list<ResearchTurn>('research-turn').filter(t=>t.value.plannedBy&&t.value.status==='pending').length,1);
  rmSync(join(root,'fail-b'));
  await engine.researcher.run("p",draft.id,2);
  assert.equal(store.get<Question>(question.id)!.value.status,'answered');
  assert.deepEqual(store.get(acceptedRead.id),acceptedRead);
  const calls=store.list<ModelCall>('model-call');
  assert.equal(calls.filter(c=>c.value.purpose==='reading-planner').length,1);
  assert.equal(calls.filter(c=>c.value.purpose==='analyst').length,1);
  assert.equal(calls.filter(c=>c.value.purpose==='reader').length,3);
  assert.equal(calls.length,6);
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
const seen=[...new Set([...c.synthesisNotes.flatMap(n=>n.proposal.value.seen),...c.selectedContext.map(o=>o.source.id)])];
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
  await assert.rejects(synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON'),{code:'synthesis_evidence_stale'});
  assert.equal(store.list('model-call').length,count,'Stale notes must fail before another model call');
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
  await assert.rejects(synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON'),{code:'synthesis_evidence_stale'});
  writeFileSync(join(root,'README.md'),source.value.content);
  store.write({id:question.id,kind:question.kind,expected:question.revision,value:{...question.value,spec:{...question.value.spec,prompt:'A changed question'}}});
  await assert.rejects(synthesisSession(store,draft,question,environment,dispatch,configured,context,'Return JSON'),{code:'input_stale'});
  assert.equal(store.list('model-call').length,2,'Cached answers cannot bypass changed inputs');
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


test("an oversized paid response is replayed only for its exact current request without another generation", async t => {
  const {root,store,engine,environment,pilot,settings,draft,question}=fixture(t);
  const command=join(root,'oversized-provider.mjs');
  writeFileSync(command,`import {readFileSync,writeFileSync} from 'node:fs';const input=readFileSync(0,'utf8'),req=JSON.parse(input);writeFileSync('original-request.json',input);console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{action:'answer',question:req.subject.question.id,value:'x'.repeat(4000),citations:[]},usage:{inputTokens:10,outputTokens:1000,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]},role={...environment.value.implementer,command:cmd};
  const configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd,maxReplyChars:128},pilot.revision);
  const context={...pilotContext(store,draft,question),inventory:new ResearchSources(store,'p',root).inventory()};
  const audit={store,draftId:draft.id,questionId:question.id,purpose:'analyst',pilot:configured};
  await assert.rejects(researchCall(role,environment.value,'Return JSON',context,undefined,audit),{code:'pilot_reply_limit'});
  const original=store.list<ModelCall>('model-call')[0]!,input=readFileSync(join(root,'original-request.json'),'utf8');
  await assert.rejects(researchCall(role,environment.value,'Return JSON',context,undefined,audit),{code:'pilot_reply_limit'});
  assert.equal(store.list('model-call').length,1,'Do not buy another oversized response with an unchanged ceiling');
  const expanded=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd,maxReplyChars:5000},configured.revision);
  const response=await researchCall({...role,command:{executable:'/usr/bin/false',args:[]}},environment.value,'Return JSON',context,undefined,{...audit,pilot:expanded}) as any;
  assert.equal(response.value.length,4000);assert.deepEqual(store.get(original.id),original);
  assert.equal(store.list('model-call').length,1);assert.equal(store.list('research-response-replay').length,1);
  const changed=JSON.parse(input);changed.prompt='Different instruction';
  assert.equal(replayLimitedResponse(store,expanded,role,draft.id,question.id,'analyst',JSON.stringify(changed)),null);
  assert.equal(replayLimitedResponse(store,expanded,{...role,actor:'foreign'},draft.id,question.id,'analyst',input),null);
  assert.equal(replayLimitedResponse(store,expanded,role,draft.id,question.id,'assessor',input),null);
  store.write({id:question.id,kind:question.kind,expected:question.revision,value:{...question.value,spec:{...question.value.spec,prompt:'Changed basis'}}});
  assert.throws(()=>replayLimitedResponse(store,expanded,role,draft.id,question.id,'analyst',input),{code:'context_reference_stale'});
});

test("the last allowed planner response can be replayed before checking generation quota", async t => {
  const {root,store,engine,pilot,settings,draft,question}=fixture(t);
  const command=join(root,'last-planner.mjs');
  writeFileSync(command,`import {readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;const research=c.role==='reader'?{selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]}:{action:'read_plan',question:c.question.id,reads:[{action:'read_bundle',purpose:'Read the condition '+'.'.repeat(4000),inputs:[{path:'README.md',media:'text/plain'}]}]};console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:{inputTokens:10,outputTokens:20,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const cmd={executable:process.execPath,args:[command]};
  const configured=configureReaderPilot(store,engine.environments,'p',{...settings,agentCommand:cmd,reader:{...settings.reader,command:cmd},maxReplyChars:256,planning:{fields:[question.value.spec.field],maxRequestChars:100000,maxRounds:1}},pilot.revision);
  const first=await engine.researcher.run('p',draft.id,1);assert.equal(first.value.pauseCode,'pilot_reply_limit');
  const {projectId:_projectId,...resumedSettings}=configured.value;
  configureReaderPilot(store,engine.environments,'p',{...resumedSettings,maxReplyChars:10000},configured.revision);
  const resumed=await engine.researcher.run('p',draft.id,2);
  assert.equal(resumed.value.pauseCode,null);
  assert.equal(store.list<ModelCall>('model-call').filter(c=>c.value.purpose==='reading-planner').length,1);
  assert.equal(store.list('research-response-replay').length,1);
  assert.equal(store.list('reader-result').length,1);
});

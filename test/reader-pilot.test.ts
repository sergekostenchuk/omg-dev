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
if(c.role!=='reader'&&(!c.contextEncoding||JSON.stringify(c).indexOf('"core":')>JSON.stringify(c).indexOf('"question":')))throw Error('Stable product context must precede the question');
if(c.role==='reader')research={selections:[{source:c.sources[0].ref,firstLine:2,lastLine:3}],unresolved:[]};
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
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
  const { root, engine, store, full, draft: r1 } = fixture(t);
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
  const result = await engine.execute({ type: "research-phase", project: "p", phase: "L2", draftId: draft.id, maxTurns: 2 }) as ConsumerResult;
  assert.equal(result.status, "accepted", JSON.stringify(result));
  assert.deepEqual(store.get(l1.id), l1);
  assert.deepEqual(engine.refinement.gate("p", "L2").findings, []);
  const review = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    .find(call => call.role === "assess-answer" && call.field === "layerDesign");
  assert.equal(review.fullGraph, false); assert.equal(review.delta, true);
  assert.throws(() => engine.refinement.begin("p", "R2"), { code: "pilot_boundary_reached" });
  assert.equal(store.get("phase:p:R2"), null);
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

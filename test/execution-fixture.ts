import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { Store } from "../src/storage/store.js";
import assert from "node:assert/strict";
import { writeFeasibility } from "../src/om/feasibility.js";
import { writeHandoff } from "../src/om/handoff.js";
import { EngineError } from "../src/errors.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { reference } from "../src/pipeline/contracts.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { prepareOmFixtureStages, prepareNativeLayers, type NativeLayerOptions } from "./om-fixture.js";
import { hashJson, type Json } from "../src/canonical.js";
import type { CarriedObligation } from "../src/graph/obligation-policy.js";
import { taskBindingId } from "../src/graph/task-obligations.js";
import { runtimeObligationId, type RuntimeObservationResult } from "../src/runtime/runtime-observation.js";
import { OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, normalizeOwnerGapAssignment, readOmObligations } from "../src/om/obligations.js";
import type { OmResult } from "../src/om/refusal.js";
import type { Ref } from "../src/pipeline/contracts.js";
import { writeRoutes } from "../src/om/routes.js";
import { writeQuestionPacket, partResponseId, preparePartResult } from "../src/om/question-packet.js";
import { writeGuarded } from "../src/om/refs.js";
import { openSeries, beginAttempt } from "../src/om/series.js";
import { recordCall } from "../src/om/call-record.js";
import { gapLineKey, gapLineExpectedResult } from "../src/om/gap-lines.js";
import { writeWorksAcceptance } from "../src/om/atomic-gate.js";
import { readAcceptedFrame } from "../src/om/frame-accept.js";
import { readWorksFrame } from "../src/om/works-frame.js";
import { preparedField } from "./preparation-fixture.js";
import { exampleGraph } from "./graph-fixture.js";

const { fixtureAnswer }: { fixtureAnswer: (packet: unknown, answer: unknown) => unknown } = await import(new URL('../../test/om-adapter-fixture.mjs', import.meta.url).href);
const take = <T>(result: OmResult<T>): T => {
  assert.ok(result.ok, result.ok ? "" : `${result.refusal.code}: ${result.refusal.message}`); return result.value;
};

// Controlled protocol agents exercise real OS processes, code, gates and Git.
// They do not prove research or code-generation quality of a language model.
const AGENT = String.raw`
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [journal, behavior] = process.argv.slice(2);
const raw=readFileSync(0,'utf8'), request=JSON.parse(raw), context=request.subject.context;
const previous=existsSync(journal)?readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
if(request.mode==='research') {
 const c=request.subject;
 if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
 appendFileSync(journal,JSON.stringify({mode:'research',role:c.role})+'\n');
 const reply=research=>process.stdout.write(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));
 if(c.role==='assess-answer') reply({verdict:'supported',reasons:[]});
 else {
  const manifest=JSON.parse(readFileSync(journal+'.repair.json','utf8'));
  const q=(manifest.researchGap?c.questions.find(q=>q.field!=='contractsAndConsumers'):null)??c.questions[0], source=c.inventory.sources.find(item=>item.ref.id.includes(':failure-'));
  const value=q.field==='layerDesign'?manifest.design:
   {applicability:'applicable',reason:'Repair the observed missing consumer refusal contract while retaining the accepted producer',facts:[],
    designs:[{id:q.field+'-repair',decision:'Add a consumer counterfactual that removes its input and requires input_missing, preserve the accepted producer and its data contract',benefit:'A caller receives a defined refusal instead of unchecked input',consumer:'p-consume-work'}],gaps:[],
    ...(q.basisContract==='typed-v1'?{documents:[]}:{})};
  if(manifest.researchGap&&q.field==='contractsAndConsumers'&&!c.inventory.sources.some(item=>item.ref.id.includes(':repair-feedback-')))
   value.gaps=[{id:'unresolved-consumer',target:'p-consume-work',field:'ports',consumer:'p-consume-work',requiredFor:'current',question:'The current consumer input remains unresolved'}];
  reply({action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:''}}]});
 }
} else {
appendFileSync(journal,JSON.stringify({ mode:request.mode, task:context.binding.task, chars:raw.length, bytes:Buffer.byteLength(raw), hash:createHash('sha256').update(raw).digest('hex'), subject:request.subject })+'\n');
if(behavior==='wait') await new Promise(resolve=>setTimeout(resolve,30000));
const response={protocol:request.protocol,requestId:request.requestId};
if(request.mode==='implement') {
 const file=context.scope.code.find(item=>item.access==='write').path;
 const first=!previous.some(item=>item.mode==='implement'&&item.task===context.binding.task);
 const wrong=behavior==='correct'&&first;
 writeFileSync(file,file==='produce.mjs'
  ? 'export const produce=n=>{if(!Number.isFinite(n))throw new Error("input_missing");return n+'+(wrong?2:1)+'};\n'
  : 'import {produce} from "./produce.mjs"; export const consume=n=>produce(n)*'+(wrong?3:2)+';\n');
 if(context.action.title==='Upgrade producer safety')writeFileSync(file,'export const produce=n=>{if(!Number.isFinite(n))throw new Error("input_missing");const result=n+1;if(!Number.isSafeInteger(result))throw new Error("output_overflow");return result};\n');
 if(context.action.title==='Upgrade consumer safety')writeFileSync(file,'import {produce} from "./produce.mjs";export const consume=n=>{const result=produce(n)*2;if(!Number.isSafeInteger(result))throw new Error("result_overflow");return result};\n');
 if(behavior==='scope')writeFileSync('foreign.txt','outside scope');
 if(behavior==='delete'&&existsSync('obsolete.txt'))unlinkSync('obsolete.txt');
 response.text='Implemented the bounded module';
 response.artifacts=context.produces.map(id=>behavior==='business-value'?{id,value:'invented'}:{id});
 if(behavior==='missing-output')response.artifacts=[];
} else response.review=behavior==='plan-defect'||behavior==='repair'&&context.action.title==='consume work'&&!context.criteria.tests.some(test=>test.contract.counterfactuals.length)
 ? {verdict:'request_changes',kind:'plan',findings:['The proposed responsibility cannot deliver the required result']}
 : {verdict:'pass',kind:'none',findings:[]};
process.stdout.write(JSON.stringify(response));
}
`;
const CHECK = String.raw`
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const mode=process.argv[2];
if(mode==='produce'||mode==='all') {const {produce}=await import('./produce.mjs');assert.equal(produce(1),2);}
if(mode==='consume'||mode==='all'&&existsSync('consume.mjs')) {const {consume}=await import('./consume.mjs');assert.equal(consume(1),4);}
if(mode==='mutation') {const {produce}=await import('./produce.mjs');assert.throws(()=>produce(undefined),/input_missing/);}
if(mode==='consume-mutation') {const {consume}=await import('./consume.mjs');assert.throws(()=>consume(undefined),/input_missing/);}
if(mode==='overflow-produce') {const {produce}=await import('./produce.mjs');assert.throws(()=>produce(Number.MAX_SAFE_INTEGER),/output_overflow/);}
if(mode==='overflow-consume') {const {consume}=await import('./consume.mjs');assert.throws(()=>consume(Number.MAX_SAFE_INTEGER-1),/result_overflow/);}
`;

export interface CurrentExecutionFixture {
  route: "om";
  graph?: (graph: import("../src/graph/model.js").Graph) => void;
  beforeRoute?: (engine: ProductEngine) => void;
  valueFor?: Parameters<typeof preparedFeatures>[3];
  native?: NativeLayerOptions;
}

export function executionFixture(t: TestContext, behavior = "normal",
  route?: CurrentExecutionFixture) {
  const current = route !== undefined;
  if (current && (!route || typeof route !== "object" || route.route !== "om"
    || (route.beforeRoute !== undefined && typeof route.beforeRoute !== "function")))
    throw new EngineError("execution_fixture_invalid", "The current fixture needs route om and an optional beforeRoute function", { target: "/route" });
  const directory = mkdtempSync(join(tmpdir(), "omg-execution-")), workspace = join(directory, "repo"); mkdirSync(workspace);
  const journal = join(directory, "calls.jsonl"), agent = join(directory, "agent.mjs"); writeFileSync(agent, AGENT);
  git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "A local numeric transformation product");
  if (behavior === "filter") {
    const filter = join(directory, "filter.mjs");
    writeFileSync(filter, "import{readFileSync}from'node:fs';process.stdout.write(readFileSync(0,'utf8').replaceAll('n+1','n+100'));");
    git(workspace, ["config", "filter.alter.clean", `'${process.execPath.replaceAll("'", "'\\''")}' '${filter.replaceAll("'", "'\\''")}'`]);
    writeFileSync(join(workspace, ".gitattributes"), "*.mjs filter=alter\n"); git(workspace, ["add", ".gitattributes"]);
  }
  writeFileSync(join(workspace, "check.mjs"), CHECK);
  if (behavior === "delete") { writeFileSync(join(workspace, "obsolete.txt"), "old implementation"); git(workspace, ["add", "obsolete.txt"]); }
  git(workspace, ["add", "README.md", "check.mjs"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const initial = git(workspace, ["rev-parse", "HEAD"]);
  let store = new Store(join(directory, "state.sqlite")), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = exampleGraph("p");
  for (const node of base.nodes) for (const ref of node.code) ref.path = ref.path.replace('.txt', '.mjs');
  if (behavior === "delete") base.nodes.find(node => node.id === "p-produce-work")!.code.push({ path: "obsolete.txt", access: "write", status: "existing" });
  const graph = enrichedGraph(base, "p");
  graph.contracts[0]!.schema = { type: "number" };
  for (const test of graph.tests) {
    test.command = { executable: process.execPath, args: ["check.mjs", test.node.includes("produce") ? "produce" : "consume"] };
    for (const mutation of test.contract!.counterfactuals) mutation.command = { executable: process.execPath, args: ["check.mjs", "mutation"] };
  }
  if (current) route.graph?.(graph);
  if (current) prepareOmFixtureStages(engine, "p", graph, route.valueFor);
  else preparedFeatures(engine, "p", graph);
  const command = { executable: process.execPath, args: [agent, journal, behavior] };
  engine.environments.configure("p", { workspace, implementer: { actor: "worker", model: "protocol-fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "protocol-fixture", effort: "high", command }, fullCheck: { executable: process.execPath, args: ["check.mjs", "all"] }, timeoutMs: 10_000,
    ...(current ? { requestCapacityChars: 100_000 } : {}) }, 0);
  if (!current) {
    refinedLayers(engine, "p"); const feasibility = engine.refinement.assess("p", 0);
    const stage = engine.refinement.publish("p", reference(feasibility), 0); engine.pipeline.accept("p", "om-g2", stage.revision);
  } else {
    route.beforeRoute?.(engine);
    prepareNativeLayers(engine, "p", graph, "executed", route.native);
  }
  const plan = engine.compiler.compile("p"); const compilation = engine.compiler.publish("p", reference(plan), 0); engine.pipeline.accept("p", "compilation", compilation.revision);
  return { get store() { return store; }, get engine() { return engine; }, directory, workspace, initial, plan,
    calls: () => { try { return readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    reopen: () => { store.close(); store = new Store(join(directory, "state.sqlite")); engine = new ProductEngine(store); return engine; },
    options: { retry: false, maxContextChars: 100_000, maxCorrections: 0 },
  };
}

/** Reobserve the accepted native L3 against the current repository and publish its new M8/M9. */
export function refreshExecutionPlan(engine: ProductEngine, project = "p") {
  const store = engine.store;
  const feasibility = writeFeasibility(store, { project, graph: reference(store.get(`graph:${project}`)!),
    layer: reference(store.get(`graph-layer:${project}:3`)!), frame: reference(store.get(`om-frame:${project}:3`)!),
    environment: reference(engine.environments.get(project)), expected: store.get(`om-feasibility:${project}`)!.revision });
  assert.ok(feasibility.ok, feasibility.ok ? "" : feasibility.refusal.message);
  assert.equal(feasibility.value.value.ready, true);
  const handoff = writeHandoff(store, { project, feasibility: reference(feasibility.value), expected: store.get(`stage:${project}:om-g2`)!.revision });
  assert.ok(handoff.ok, handoff.ok ? "" : handoff.refusal.message);
  return engine.compiler.compile(project);
}

/** Current D1/D2 -> H2/D7 -> L3 task bindings, with live evidence produced only in the test. */
export function taskObligationExecutionFixture(t: TestContext) {
  const labels = ["start", "result", "implementation"] as const;
  let condition = "", engine: ProductEngine;
  const obligations = new Map<string, CarriedObligation>();
  const f = executionFixture(t, "normal", {
    route: "om",
    valueFor(field) {
      const value = preparedField("p", field);
      if (field === "preparation") (value as { unknowns: unknown }).unknowns = labels.map(id => ({
        id, question: `Check the actual ${id} of the producer task at its declared moment`,
        consumer: "p-produce-operation", moment: id === "start" ? "task-start" : "task-result",
        blocksCurrentStage: false, resolution: `Verify actual ${id} for this producer task`,
      }));
      return value;
    },
    beforeRoute(current) {
      engine = current;
      condition = join(dirname(current.store.path), "condition.txt"); writeFileSync(condition, "ready");
    },
    native: {
      addresses: labels.map(id => ({ target: `discovery:${id}`, field: "address", value: {
        consumer: "p-produce-operation", kind: id === "implementation" ? "post-implementation-proof" : "environment-confirmation",
      } })),
      obligations: {
        assignments(context, records) {
          const script = engine.discovery.evidence.document("p", "task-check",
            "import{readFileSync}from'node:fs';process.exitCode=readFileSync(process.argv.at(-1),'utf8')==='ready'?0:7;", "text/plain", 0);
          const gaps = records.filter(row => labels.some(id => row.value.gap.target === `discovery:${id}`) && row.value.gap.field === "answer");
          assert.equal(gaps.length, labels.length);
          return gaps.map(row => {
            const label = row.value.gap.target.slice("discovery:".length);
            const returnCondition = `Verify actual ${label} for this producer task`;
            const assignment = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project: "p",
              context: { gaps: context.gaps, lines: context.lines }, gap: reference(row), assignments: row.value.gap.consumers.map(responsibleConsumer => ({
                responsibleNode: "p-produce-operation", responsibleConsumer, reason: "The owner requires exact evidence at this task boundary",
                returnCondition, wake: null, ...(label === "implementation" ? {} : { runtimeCheck: {
                  script: reference(script), dependencies: [], subjects: [condition], executables: [], args: [condition], timeoutMs: 3000,
                  purpose: "A controlled local execution fixture", satisfies: returnCondition,
                } }),
              })) });
            return { pending: { id: `om-owner-gap-assignment:p:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } };
          });
        },
        accept(gaps, initial, proposal) {
          const store = engine.store, project = "p", environment = reference(engine.environments.get(project));
          const routes = take(writeRoutes(store, { project, gaps, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
          const adapter = store.write({ id: "adapter:p:task-fixture", kind: "dispatch-adapter", expected: 0,
            value: { projectId: project, protocol: "fixture" } });
          const results: { kind: "part"; record: Ref }[] = [];
          for (const batch of routes.value.batches.filter(item => item.level === 3 && item.task === "node-expansion")) {
            const work = proposal.nodes.find(node => node.parent === batch.node)!; assert.ok(work, batch.node ?? "node");
            const upper = store.get<import("../src/graph/model.js").Graph>("graph:p")!.value.nodes.find(node => node.id === batch.node)!;
            const block = upper.parent!;
            take(openSeries(store, { project, block, line: 1, slice: `fixture:${batch.node}`, predecessor: null, basis: null }));
            const goal = { key: `fixture:${batch.node}`, questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
              result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
            const series = take(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
            const packet = take(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id, environment,
              attempt: { series: reference(series), ordinal: 1 }, previous: [],
              works: { producer: reference(initial.producer), ledger: reference(initial.record) } })).record;
            assert.equal(packet.value.state, "ready"); assert.equal(packet.value.plan!.mode, "whole");
            const payload = packet.value.packet as unknown as { requestId: string; questions: { id: string }[];
              expansion: { assigned: string[] }; works: { assigned: string[] } };
            const bindings = initial.handoff.obligations.filter(item => payload.works.assigned.includes(taskBindingId(item))).map(item => ({
              id: taskBindingId(item), scope: item.scope, obligation: item.obligation,
              consumers: [{ node: work.id, tests: item.kind === "post-implementation-proof" ? [...work.tests] : [] }],
            }));
            const body = { nodes: [work], tests: proposal.tests.filter(proof => work.tests.includes(proof.id)),
              fills: proposal.fills.filter(fill => fill.node === work.id && payload.expansion.assigned.includes(fill.obligation)),
              localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
              removes: [], replaces: [], redefines: [] };
            const questions = new Set(payload.questions.map(question => question.id));
            const call = take(recordCall(store, project, { call: payload.requestId, purpose: "model-design", basis: null, block,
              gaps: batch.items.filter(item => questions.has(item.gap)).flatMap(item => item.consumers.map(consumer => ({
                id: item.target, goal: item.target, field: item.field, consumer }))), series: reference(series), attempt: 1, goal,
              dispatch: { adapter: reference(adapter), config: environment }, packet: structuredClone(packet.value.packet) as Json })).call;
            const response = store.write({ id: partResponseId(project, reference(call)), kind: "part-response", expected: 0,
              value: { project, packet: reference(packet), call: reference(call), requestId: payload.requestId,
                raw: JSON.stringify(fixtureAnswer(packet.value.packet, { protocol: packet.value.answerProtocol, requestId: payload.requestId,
                  action: "answer", proposal: body, bindings })) } });
            const part = take(preparePartResult(store, { project, packet: reference(packet), call: reference(call), response: reference(response) }));
            take(writeGuarded(store, { unit: "fixture", target: part.record.id, writes: part.writes, guards: part.guards }));
            results.push({ kind: "part", record: reference(part.record) });
          }
          assert.equal(results.length, 2);
          const accepted = take(writeWorksAcceptance(store, { project, results, environment, sources: [], binding: null }));
          assert.equal(accepted.state, "accepted"); assert.ok(accepted.acceptance);
          const settled = take(readAcceptedFrame(store, accepted.acceptance)); assert.ok(settled.frame);
          const candidate = take(readWorksFrame(store, { project, candidate: settled.frame.value.acceptance.candidate }));
          const final = take(readOmObligations(store, { project, producer: candidate.value.works!.producer }));
          assert.equal(final.handoff.obligations.length, labels.length);
          for (const frozen of final.handoff.obligations) {
            const item = structuredClone(frozen) as CarriedObligation;
            const label = labels.find(id => item.returnCondition === `Verify actual ${id} for this producer task`); assert.ok(label);
            obligations.set(label, item); assert.equal(item.moment, label === "start" ? "task-start" : "task-result");
          }
          return structuredClone(accepted.acceptance);
        },
      },
    },
  });
  const observe = (label: string, key = label) => {
    const obligation = obligations.get(label); assert.ok(obligation, `Missing declared obligation ${label}`);
    return f.engine.execute({ type: "observe-runtime", project: "p", scope: obligation.scope,
      obligation: runtimeObligationId(obligation), key }) as Promise<RuntimeObservationResult>;
  };
  return { ...f, condition, observe };
}

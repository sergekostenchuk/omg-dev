import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { reference } from "../src/pipeline/contracts.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";

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
 appendFileSync(journal,JSON.stringify({mode:'research',role:c.role})+'\n');
 const reply=research=>process.stdout.write(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));
 if(c.role==='assess-answer') reply({verdict:'supported',reasons:[]});
 else {
  const q=c.questions[0], source=c.inventory.sources.find(item=>item.ref.id.includes(':failure-'));
  const manifest=JSON.parse(readFileSync(journal+'.repair.json','utf8'));
  const value=q.field==='layerDesign'?manifest.design:
   {applicability:'applicable',reason:'Repair the observed missing consumer refusal contract while retaining the accepted producer',facts:[],
    designs:[{id:q.field+'-repair',decision:'Add a consumer counterfactual that removes its input and requires input_missing, preserve the accepted producer and its data contract',benefit:'A caller receives a defined refusal instead of unchecked input',consumer:'p-consume-work'}],gaps:[]};
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

export function executionFixture(t: TestContext, behavior = "normal") {
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
  preparedFeatures(engine, "p", graph);
  const command = { executable: process.execPath, args: [agent, journal, behavior] };
  engine.environments.configure("p", { workspace, implementer: { actor: "worker", model: "protocol-fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "protocol-fixture", effort: "high", command }, fullCheck: { executable: process.execPath, args: ["check.mjs", "all"] }, timeoutMs: 10_000 }, 0);
  refinedLayers(engine, "p"); const feasibility = engine.refinement.assess("p", 0);
  const stage = engine.refinement.publish("p", reference(feasibility), 0); engine.pipeline.accept("p", "om-g2", stage.revision);
  const plan = engine.compiler.compile("p"); const compilation = engine.compiler.publish("p", reference(plan), 0); engine.pipeline.accept("p", "compilation", compilation.revision);
  return { get store() { return store; }, get engine() { return engine; }, directory, workspace, initial, plan,
    calls: () => { try { return readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    reopen: () => { store.close(); store = new Store(join(directory, "state.sqlite")); engine = new ProductEngine(store); return engine; },
    options: { retry: false, maxContextChars: 100_000, maxCorrections: 0 },
  };
}

import { discoveryContext } from '../src/discovery/discovery-outcome.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine, type StageContent } from "../src/product/engine.js";
import { LEGACY_REQUIREMENTS, RESEARCH_CONTRACT_VERSION, REQUIREMENTS, VERSION3_REQUIREMENTS, type UpstreamStage } from "../src/discovery/requirements.js";
import { JOURNEY_VARIANTS, QUESTION_MOMENTS, QUESTION_MOMENT_CONTRACT_VERSION, preparationSchema, featurePreparationSchema, UPSTREAM_DETAILS } from "../src/discovery/preparation-contracts.js";
import { reference, stageId, type StageArtifact } from "../src/pipeline/contracts.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { canonical, type Json } from "../src/canonical.js";
import type { Graph } from "../src/graph/model.js";
import { preparedField, preparationValue as basePreparationValue, boundDiscoveryValue } from "./preparation-fixture.js";
import { preparedFeatures, answerDiscoveryFixture } from "./product-fixture.js";

function preparationValue(engine: ProductEngine, draft: Revision<DiscoveryDraft>): Json {
  const current = engine.store.get<DiscoveryDraft>(draft.id)!;
  const question = current.value.questions.map(id => engine.store.get<Question>(id)!).find(q => q.value.spec.field === 'preparation')!;
  return boundDiscoveryValue('preparation', basePreparationValue('p'), discoveryContext(engine.store, current, question).context);
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-preparation-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "p", title: "Local transformer" });
  const source = engine.discovery.evidence.document("p", "brief", "Create a standalone local CLI transformer with validation.", "text/plain", 0);
  const draft = engine.prepare("p", "discovery");
  engine.discovery.fact(draft.value.questions[0]!, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
  engine.discovery.decision(draft.value.questions[1]!, 1, "owner", "Return a validated local result");
  for (const id of draft.value.questions) {
    const question=store.get<Question>(id)!;
    if (['researchPlan','researchReport','verdict'].includes(question.value.spec.field))
      answerDiscoveryFixture(engine,'p',store.get<DiscoveryDraft>(draft.id)!,question,preparedField('p',question.value.spec.field),source);
  }
  const preparation=draft.value.questions.find(id=>store.get<Question>(id)!.value.spec.field==='preparation')!;
  return { engine, store, draft, source, root, preparation };
}

test("new initial research requires every scenario category and refuses unresolved essential inputs", t => {
  const { engine, draft, store, preparation } = fixture(t);
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  const stage = engine.draft("p", "discovery", draft.id, 0);
  assert.throws(() => engine.pipeline.accept("p", "discovery", stage.revision), /validation refused/);
  const value = preparationValue(engine, draft) as Record<string, Json>;
  const journeys = value['journeys'] as Record<string, Json>;
  assert.equal(Object.keys(journeys).length, JOURNEY_VARIANTS.length);
  delete journeys['crash_recovery'];
  assert.throws(() => engine.discovery.decision(preparation, 1, "owner", value), /field contract/);
  const blocked = preparationValue(engine, draft) as Record<string, Json>;
  blocked['unknowns'] = [{ id: "essential", question: "Which input must be transformed?", consumer: "concept", blocksCurrentStage: true, resolution: "Unavailable", moment: "om-pass" }];
  engine.discovery.decision(preparation, 1, "owner", blocked);
  const next = engine.draft("p", "discovery", draft.id, stage.revision);
  assert.ok(engine.pipeline.inspect("p", "discovery").findings.some(item => item.code === "preparation_unresolved"));
  assert.throws(() => engine.pipeline.accept("p", "discovery", next.revision), /validation refused/);
  const question = engine.discovery.reopen(preparation, store.get(preparation)!.revision);
  engine.discovery.decision(question.id, question.revision, "owner", preparationValue(engine, draft));
  const fixed = engine.draft("p", "discovery", draft.id, next.revision);
  engine.pipeline.accept("p", "discovery", fixed.revision);
  assert.equal(engine.pipeline.inspect("p", "discovery").state, "accepted");
});

test("a complete-looking preparation cannot bind a scenario to a foreign beneficiary", t => {
  const { engine, draft, preparation } = fixture(t);
  const value = preparationValue(engine, draft) as any;
  value.outcomes[0].beneficiary = "unknown-person";
  engine.discovery.decision(preparation, 1, "owner", value);
  const stage = engine.draft("p", "discovery", draft.id, 0);
  assert.ok(engine.pipeline.inspect("p", "discovery").findings.some(item => item.code === "beneficiary_missing"));
  assert.throws(() => engine.pipeline.accept("p", "discovery", stage.revision), /validation refused/);
});

test("legacy accepted research keeps its era, while a new result cannot use the legacy contract", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-era-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); engine.execute({ type: "create-project", project: "legacy", title: "Legacy" });
  const source = engine.discovery.evidence.document("legacy", "brief", "Existing accepted request", "text/plain", 0);
  const old = engine.discovery.create("legacy", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery);
  engine.discovery.fact(old.value.questions[0]!, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
  engine.discovery.decision(old.value.questions[1]!, 1, "owner", "Original outcome");
  const record = store.get<DiscoveryDraft>(old.id)!;
  const content = { draft: reference(record), fields: record.value.fields, graph: null } as unknown as Json;
  // Simulate a canonical accepted record written by the previous contract version.
  const historical = store.write<StageArtifact>({ id: stageId("legacy", "discovery"), kind: "stage", expected: 0,
    value: { projectId: "legacy", stage: "discovery", status: "accepted", content, inputs: [], proofs: [] } });
  assert.equal(engine.pipeline.inspect("legacy", "discovery").state, "accepted");
  assert.throws(() => engine.draft("legacy", "discovery", old.id, historical.revision), /enriched research/);
  assert.deepEqual(store.get(historical.id), historical);
  const draft = engine.prepare("legacy", "discovery");
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
});

test("a feature cannot claim an unrelated specification contract even when its old outcome binding is correct", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-feature-contract-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); preparedFeatures(engine, "p");
  const current = store.get<StageArtifact>(stageId("p", "features"))!;
  const content = current.value.content as unknown as StageContent;
  const draft = store.get<DiscoveryDraft>(content.draft.id)!;
  const id = draft.value.questions.find(id => store.get<{ spec: { field: string } }>(id)!.value.spec.field === "featurePreparation")!;
  const question = engine.discovery.reopen(id, store.get(id)!.revision);
  const details = preparedField("p", "featurePreparation") as any[];
  details[0].behaviorContracts = ["not-a-real-contract"];
  engine.discovery.decision(question.id, question.revision, "owner", details);
  const changed = engine.draft("p", "features", draft.id, current.revision);
  assert.ok(engine.pipeline.inspect("p", "features").findings.some(item => item.code === "feature_contract_foreign"));
  assert.throws(() => engine.pipeline.accept("p", "features", changed.revision), /validation refused/);
});

test("a feature cannot replace the outcome's beneficiary with another declared actor", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-feature-beneficiary-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  preparedFeatures(engine, "p", undefined, field => {
    const value = preparedField("p", field) as any;
    if (field === "preparation") {
      value.actors.push({ id: "p-admin", role: "Operator", benefit: "Support the user", channels: ["CLI"] });
      value.journeys.success.scenarios.push({ ...value.journeys.success.scenarios[0], actor: "p-admin" });
    }
    return value;
  });
  const stage = store.get<StageArtifact>(stageId("p", "features"))!;
  const draft = store.get<DiscoveryDraft>((stage.value.content as unknown as StageContent).draft.id)!;
  const id = draft.value.questions.find(id => store.get<{ spec: { field: string } }>(id)!.value.spec.field === "featurePreparation")!;
  const question = engine.discovery.reopen(id, store.get(id)!.revision);
  const details = preparedField("p", "featurePreparation") as any[];
  details[0].beneficiary = "p-admin";
  engine.discovery.decision(id, question.revision, "owner", details);
  const updated = engine.draft("p", "features", draft.id, stage.revision);
  assert.ok(engine.pipeline.inspect("p", "features").findings.some(item => item.code === "feature_beneficiary_foreign"));
  assert.throws(() => engine.pipeline.accept("p", "features", updated.revision), /validation refused/);
});

for (const stage of ["discovery", "features"] as const) test(`B1.1 v4 ${stage} questions require an explicit legal moment before any answer write`, t => {
  const root = mkdtempSync(join(tmpdir(), "omg-moment-schema-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), project = "p";
  preparedFeatures(engine, project);
  const savedStage = store.get<StageArtifact>(stageId(project, stage))!;
  const draft = store.get<DiscoveryDraft>((savedStage.value.content as unknown as StageContent).draft.id)!;
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  assert.equal(QUESTION_MOMENT_CONTRACT_VERSION,4, "Question moment semantics retain their version");
  const field = stage === "discovery" ? "preparation" : "featurePreparation";
  const id = draft.value.questions.find(id => store.get<Question>(id)!.value.spec.field === field)!;
  let question = engine.discovery.reopen(id, store.get(id)!.revision);
  function valueWithQuestion(moment: unknown, present = true): Json {
    const question = { ...(stage === "discovery" ? { id: "retained", resolution: "Resolve at the declared moment" } : {}),
      question: "Which environment condition must hold?", consumer: "p-produce-block", blocksCurrentStage: false,
      ...(present ? { moment } : {}) };
    const value = (stage === "discovery" ? preparationValue(engine, draft) : preparedField(project, field)) as any;
    if (stage === "discovery") value.unknowns = [question];
    else value[0].remainingQuestions = [question];
    return value as Json;
  }
  const before = canonical(store.list().flatMap(row => store.history(row.id)));
  for (const [present, value] of [[false, undefined], [true, undefined], [true, null], [true, "R3"], [true, "later"], [true, 4]] as const) {
    assert.throws(() => engine.discovery.decision(id, question.revision, "owner", valueWithQuestion(value, present)), { code: "answer_invalid" });
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
  }
  for (const moment of QUESTION_MOMENTS) {
    const value = valueWithQuestion(moment);
    const answered = engine.discovery.decision(id, question.revision, "owner", value);
    assert.deepEqual(answered.value.fields[field], value);
    if (moment !== QUESTION_MOMENTS.at(-1)) question = engine.discovery.reopen(id, store.get(id)!.revision);
  }
  const artifact = engine.draft(project, stage, draft.id, savedStage.revision);
  assert.equal(engine.pipeline.inspect(project, stage).state, "draft");
  assert.equal(engine.pipeline.accept(project, stage, artifact.revision).value.status, "accepted");
});

test("B1.1 v4 stage research uses the declared question schema and the ordinary consumer gate", async t => {
  const { engine, store, draft, root, preparation } = fixture(t);
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("p", { workspace: root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: command, timeoutMs: 4000 }, 0);
  const value = preparationValue(engine, draft) as Record<string, Json>;
  value.unknowns = [{ id: "retained", question: "Which environment condition must hold?", consumer: "concept",
    blocksCurrentStage: false, resolution: "Confirm before feasibility", moment: "feasibility" }];
  engine.discovery.decision(preparation, 1, "owner", value);
  // All research answers are already present; the real research-stage path still applies its consumer gate.
  const result = await engine.stageResearch.run("p", draft.id, 1);
  assert.equal(result.status, "accepted", JSON.stringify(result));
  assert.equal(store.list("model-call").length, 0);
  assert.equal(engine.pipeline.inspect("p", "discovery").state, "accepted");
  assert.deepEqual((store.get<StageArtifact>(stageId("p", "discovery"))!.value.content as unknown as StageContent).fields.preparation, value);
});

test("B1.1 current producer does not resume unaccepted version 3 work", async t => {
  const { engine, store } = fixture(t);
  const old = engine.discovery.create("p", "discovery", "R0", "concept", VERSION3_REQUIREMENTS.discovery, [], 3);
  const before = canonical(store.list().flatMap(row => store.history(row.id)));
  await assert.rejects(engine.stageResearch.run("p", old.id, 1), { code: "research_contract_upgrade_required" });
  assert.throws(() => engine.draft("p", "discovery", old.id, 0), { code: "research_contract_upgrade_required" });
  assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
});

test("B1.1 real version 3 producer preserves schemas, accepted stage history and mapDesign validation after restart", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-moment-v3-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryUrl = new URL("../../", import.meta.url), repository = fileURLToPath(repositoryUrl);
  const loader = join(root, "v3-loader.mjs"), producer = join(root, "v3-producer.mjs");
  writeFileSync(loader, VERSION3_LOADER); writeFileSync(producer, VERSION3_PRODUCER);
  const bootstrap = `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    {data:{root:${JSON.stringify(repositoryUrl.href)},typescript:${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href)}}});`;
  const prior = JSON.parse(execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, root],
    { cwd: repository, encoding: "utf8", maxBuffer: 20_000_000, timeout: 60_000 })) as {
      database: string; requirements: unknown; schemas: unknown; details: unknown; bytes: string;
      stages: { stage: UpstreamStage; draft: string; inspection: unknown; replay: unknown }[];
    };
  assert.deepEqual(VERSION3_REQUIREMENTS, prior.requirements);
  assert.deepEqual([preparationSchema, featurePreparationSchema], prior.schemas);
  assert.deepEqual(UPSTREAM_DETAILS, prior.details);
  assert.deepEqual(REQUIREMENTS["operation-map"], VERSION3_REQUIREMENTS["operation-map"]);
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(prior.database), engine = new ProductEngine(store);
    try {
      for (const item of prior.stages) {
        assert.deepEqual(engine.pipeline.inspect("legacy", item.stage), item.inspection);
        assert.deepEqual(await engine.stageResearch.run("legacy", item.draft, 1), item.replay);
      }
      assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), prior.bytes);
    } finally { store.close(); }
  }
  const store = new Store(prior.database), engine = new ProductEngine(store);
  try {
    const graph = store.get<Graph>("graph:legacy")!, changed = structuredClone(graph.value);
    changed.nodes.find(node => node.kind === "block")!.title += " foreign design";
    // A changed graph head cannot borrow the intact historical layer as proof of the old mapDesign.
    store.write({ id: graph.id, kind: graph.kind, expected: graph.revision, value: changed });
    const checked = engine.pipeline.inspect("legacy", "operation-map");
    assert.ok(checked.findings.some(item => item.code === "map_design_drift"), JSON.stringify(checked.findings));
  } finally { store.close(); }
});

const VERSION3_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root,ts;
export async function initialize(data){root=data.root;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  const source=execFileSync('git',['show','1189043f4bc7:'+relative],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
  return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
 }
 return next(url,context);
}`;

const VERSION3_PRODUCER = String.raw`import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [repository,root]=process.argv.slice(2),url=path=>pathToFileURL(join(repository,'dist',path)).href;
const {Store}=await import(url('src/storage/store.js'));
const {ProductEngine}=await import(url('src/product/engine.js'));
const {canonical}=await import(url('src/canonical.js'));
const {UPSTREAM_STAGES,REQUIREMENTS}=await import(url('src/discovery/requirements.js'));
const {preparationSchema,featurePreparationSchema,UPSTREAM_DETAILS}=await import(url('src/discovery/preparation-contracts.js'));
const {preparedFeatures}=await import(url('test/product-fixture.js'));
const {preparedField}=await import(url('test/preparation-fixture.js'));
const database=join(root,'legacy.sqlite'),store=new Store(database),engine=new ProductEngine(store);
preparedFeatures(engine,'legacy',undefined,field=>{
 const value=preparedField('legacy',field);
 if(field==='preparation')value.unknowns=[{id:'old-question',question:'Which environment is supported?',consumer:'legacy-produce-block',blocksCurrentStage:false,resolution:'Retain for the next stage'}];
 if(field==='featurePreparation')value[0].remainingQuestions=[{question:'Which output must be confirmed?',consumer:'legacy-consume-block',blocksCurrentStage:false}];
 return value;
});
const stages=[];
for(const stage of UPSTREAM_STAGES){
 const artifact=store.get('stage:legacy:'+stage),draft=artifact.value.content.draft.id;
 stages.push({stage,draft,inspection:engine.pipeline.inspect('legacy',stage),replay:await engine.stageResearch.run('legacy',draft,1)});
}
const bytes=canonical(store.list().flatMap(row=>store.history(row.id)));
store.close();process.stdout.write(JSON.stringify({database,requirements:REQUIREMENTS,schemas:[preparationSchema,featurePreparationSchema],details:UPSTREAM_DETAILS,stages,bytes}));`;

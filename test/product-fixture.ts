import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoveryContext } from '../src/discovery/discovery-outcome.js';
import type { ResearchAssessment } from '../src/discovery/research-model.js';
import type { Environment } from '../src/runtime/environment.js';
import type { Question, DiscoveryDraft } from '../src/discovery/discovery.js';
import type { Revision } from '../src/storage/store.js';
import type { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES, VERSION4_REQUIREMENTS } from "../src/discovery/requirements.js";
import { reference } from "../src/pipeline/contracts.js";
import { exampleGraph } from "./graph-fixture.js";
import type { Graph } from "../src/graph/model.js";
import { preparedField, boundDiscoveryValue } from "./preparation-fixture.js";
import { hashJson, type Json } from "../src/canonical.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { designOf } from "../src/graph/builder.js";
import { deriveLayerFixture } from "./layer-design-fixture.js";

const upstreamEra = new AsyncLocalStorage<string>();
/** Scope a neighboring fixture without changing its default for other tests. */
export function withHistoricalUpstream<T>(commit: string, fixture: () => T): T {
  return upstreamEra.run(commit, fixture);
}

export function preparedFeatures(engine: ProductEngine, project: string, graph: Graph = exampleGraph(project),
  valueFor: (field: string) => Json = field => preparedField(project, field), historicalCommit?: string) {
  const era = historicalCommit ?? upstreamEra.getStore();
  if (era) return historicalFeatures(engine, project, graph, valueFor, era);
  engine.execute({ type: "create-project", project, title: project });
  const source = engine.discovery.evidence.document(project, "brief", `A brief for ${project}`, "text/plain", 0);
  graph = enrichedGraph(graph, project, valueFor("preparation"), valueFor("conceptSections"));
  engine.graphs.save(project, graph, 0, "owner");
  for (const stage of UPSTREAM_STAGES) {
    const draft = engine.prepare(project, stage);
    for (const id of draft.value.questions) {
      const question = engine.projection(project).questions.find(q => q.id === id)!;
      if (question.value.spec.kind === "fact") engine.discovery.fact(id, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
      else {
        const field = question.value.spec.field;
        const value = field === "mapDesign" ? designOf(graph) as unknown as Json : valueFor(field);
        if (stage === 'discovery' && draft.value.contractVersion === 5 && ['researchPlan','researchReport','verdict','preparation'].includes(field))
          answerDiscoveryFixture(engine, project, engine.store.get<DiscoveryDraft>(draft.id)!, engine.store.get<Question>(id)!, value, source);
        else engine.discovery.decision(id, 1, "owner", value);
      }
    }
    const artifact = engine.draft(project, stage, draft.id, 0); engine.pipeline.accept(project, stage, artifact.revision);
  }
}

export function refinedLayers(engine: ProductEngine, project: string) {
  for (const [level, layer] of [["R0", 1], ["R1", 2], ["R2", 3]] as const) {
    const draft = engine.refinement.begin(project, level);
    if (level !== "R0") answerTechnicalFixture(engine, project, draft);
    const current = engine.store.get(draft.id)!;
    engine.refinement.finishResearch(project, level, reference(current), 0);
    if (layer !== 1) deriveLayerFixture(engine, project, layer);
    engine.refinement.sealLayer(project, layer, 0);
  }
}

/** Like answerTechnicalFixture, this seeds downstream unit tests with explicit
 * manufactured assessments. Research-stage integration tests use real adapters. */
export function answerDiscoveryFixture(engine: ProductEngine, project: string, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, value: Json, source: Revision<{content:string}>) {
  if (question.value.spec.field === 'preparation') return engine.discovery.decision(question.id, question.revision, 'owner',
    boundDiscoveryValue('preparation', value, discoveryContext(engine.store, draft, question).context));
  const command={executable:process.execPath,args:['--version']};
  // A frozen fixture-only environment is not the project's active execution
  // configuration; downstream tests retain their own first configure call.
  const environment=engine.store.get<Environment>(`fixture-research-environment:${project}`) ?? engine.store.write<Environment>({
    id:`fixture-research-environment:${project}`,kind:'environment',expected:0,value:{projectId:project,workspace:process.cwd(),
      implementer:{actor:'fixture-author',model:'fixture',effort:'medium',command},reviewer:{actor:'fixture-assessor',model:'fixture',effort:'medium',command},fullCheck:command,timeoutMs:10000}});
  const accepted=boundDiscoveryValue(question.value.spec.field,value,discoveryContext(engine.store,draft,question).context);
  const assessment:ResearchAssessment={projectId:project,question:reference(question),value:accepted,
    observations:[engine.discovery.evidence.observe(project,reference(source),{kind:'text-range',start:0,end:source.value.content.length})],
    verdict:'supported',reasons:[],researcher:'fixture-author',assessor:'fixture-assessor',environment:reference(environment)};
  const saved=engine.store.write({id:`research-assessment:${hashJson(assessment)}`,kind:'research-assessment',expected:0,value:assessment});
  return engine.discovery.researched(question.id,question.revision,reference(saved));
}

/** Explicit era only: the old producer owns both its code and upstream records. */
function historicalFeatures(engine: ProductEngine, project: string, graph: Graph,
  valueFor: (field: string) => Json, commit: string): void {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'omg-upstream-era-'));
  const loader = join(root, 'loader.mjs'), producer = join(root, 'producer.mjs');
  const values = Object.fromEntries([...new Set(Object.values(VERSION4_REQUIREMENTS).flat()
    .filter(spec => spec.kind !== 'fact' && spec.field !== 'mapDesign').map(spec => spec.field))]
    .map(field => [field, valueFor(field)]));
  try {
    writeFileSync(loader, String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root, commit, ts;
export async function initialize(data) {
  root = data.root; commit = data.commit; ts = (await import(data.typescript)).default;
}
export async function load(url, context, next) {
  const prefix = new URL('dist/', root).href;
  if (url.startsWith(prefix) && /\.js$/.test(url)) {
    const relative = url.slice(prefix.length).replace(/\.js$/, '.ts');
    if (relative.startsWith('src/') || relative.startsWith('test/')) {
      const source = execFileSync('git', ['show', commit + ':' + relative],
        {cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
      return {format:'module',shortCircuit:true,source:ts.transpileModule(source,
        {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
    }
  }
  return next(url, context);
}`);
    writeFileSync(producer, String.raw`import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const args=JSON.parse(readFileSync(0,'utf8'));
const url=path=>pathToFileURL(join(args.repository,'dist',path)).href;
const {Store}=await import(url('src/storage/store.js'));
const {ProductEngine}=await import(url('src/product/engine.js'));
const {preparedFeatures}=await import(url('test/product-fixture.js'));
const store=new Store(args.database);
try {
  preparedFeatures(new ProductEngine(store),args.project,args.graph,field=>args.values[field]);
} finally {store.close();}
`);
    const bootstrap = `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
      {data:${JSON.stringify({root:pathToFileURL(repository).href,commit,
        typescript:pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href})}});`;
    execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer],
      {cwd:repository,input:JSON.stringify({repository,database:engine.store.path,project,graph,values}),
        encoding:'utf8',timeout:180_000,maxBuffer:10_000_000});
  } finally { rmSync(root, {recursive:true,force:true}); }
}

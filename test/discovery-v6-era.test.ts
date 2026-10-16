import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { canonical, hashJson } from '../src/canonical.js';
import { isDiscoveryV5, discoveryOutcome } from '../src/discovery/discovery-outcome.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, VERSION5_REQUIREMENTS, VERSION6_REQUIREMENTS } from '../src/discovery/requirements.js';
import { VERSION6_UPSTREAM_DETAILS } from '../src/discovery/preparation-contracts.js';
import { inputResearchRequirements } from '../src/om/input.js';
import { reference, stageId, type StageArtifact } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { stageResearchContract } from '../src/product/stage-checks.js';
import { Store } from '../src/storage/store.js';
import { preparedField } from './preparation-fixture.js';

const V5_BASE = '151e94e3ddaf2ba4797970e7188178ff01e82a0e';
const V5_HASH = '6082bb42d272eac557007c06d3426d43af530139b72de0a91f7e038917b88586';

test('DS1.2e the released v5 requirement literal and all schema/prompt bytes stay exact', () => {
  const root = new URL('../../', import.meta.url);
  const source = execFileSync('git', ['show', `${V5_BASE}:src/discovery/requirements.ts`], { cwd: root, encoding: 'utf8' });
  const current = readFileSync(new URL('../../src/discovery/requirements.ts', import.meta.url), 'utf8');
  const literal = (text: string, name: string) => {
    const start = text.indexOf(`export const ${name}: Record<UpstreamStage, FieldSpec[]> = `);
    assert.ok(start >= 0);
    const end = text.indexOf('\n};', start); assert.ok(end >= 0);
    return text.slice(start, end + 3).replace(name, 'REQUIREMENTS');
  };
  assert.equal(literal(current, 'VERSION5_REQUIREMENTS'), literal(source, 'REQUIREMENTS'));
  assert.equal(hashJson(VERSION5_REQUIREMENTS), V5_HASH);
  assert.equal(RESEARCH_CONTRACT_VERSION, 6, 'The complete v6 contract is now the producer');
  assert.equal(REQUIREMENTS, VERSION6_REQUIREMENTS);
});

test('DS1.2e v6 policy values are deeply frozen and share no mutable object with v5', () => {
  const old = new Set<object>();
  const walk = (value: unknown, visit: (value: object) => void) => {
    if (value && typeof value === 'object') { visit(value); for (const child of Object.values(value)) walk(child, visit); }
  };
  walk(VERSION5_REQUIREMENTS, value => old.add(value));
  for (const table of [VERSION6_REQUIREMENTS, VERSION6_UPSTREAM_DETAILS]) walk(table, value => {
    assert.equal(old.has(value), false); assert.equal(Object.isFrozen(value), true);
  });
  const bytes = canonical(VERSION6_REQUIREMENTS);
  assert.throws(() => { VERSION6_REQUIREMENTS.discovery[0]!.prompt = 'Changed future policy'; }, TypeError);
  assert.throws(() => { (VERSION6_UPSTREAM_DETAILS.discovery.schema as { type: string }).type = 'null'; }, TypeError);
  assert.equal(canonical(VERSION6_REQUIREMENTS), bytes); assert.equal(hashJson(VERSION5_REQUIREMENTS), V5_HASH);
});

for (const stage of UPSTREAM_STAGES) test(`DS1.2e ${stage}: stage checks and B1 select the saved v5/v6 table`, () => {
  for (const [version, expected] of [[5, VERSION5_REQUIREMENTS], [6, VERSION6_REQUIREMENTS]] as const) {
    const historical = stageResearchContract(stage, version, true), current = stageResearchContract(stage, version, false);
    assert.equal(historical.supported, true);
    assert.equal(current.supported, version === RESEARCH_CONTRACT_VERSION);
    assert.equal(canonical(historical.requirements), canonical(expected[stage]));
    assert.equal(canonical(inputResearchRequirements(version)?.[stage]), canonical(expected[stage]));
    assert.equal(historical.checkMapDesign, true, 'v6 retains the mapDesign reconstruction route');
    historical.requirements[0]!.prompt = 'Caller edit';
    assert.notEqual(stageResearchContract(stage, version, true).requirements[0]!.prompt, 'Caller edit');
    assert.equal(Object.isFrozen(inputResearchRequirements(version)), true);
  }
  assert.equal(stageResearchContract(stage, 7, true).supported, false);
  assert.equal(inputResearchRequirements(7), null);
});

test('DS1.2e v6 explicitly retains the Discovery subject gate; field presence never selects the era', () => {
  const draft = (version: number, stage = 'discovery') => ({ stage, contractVersion: version }) as DiscoveryDraft;
  for (const version of [5, 6]) assert.equal(isDiscoveryV5(draft(version)), true);
  for (const version of [1, 2, 3, 4, 7]) assert.equal(isDiscoveryV5(draft(version)), false);
  assert.equal(isDiscoveryV5(draft(6, 'concept')), false);
  assert.equal(isDiscoveryV5({ ...draft(4), fields: { applications: [] } }), false);
});

const ADAPTER = `import{readFileSync}from'node:fs';
import{boundDiscoveryValue}from ${JSON.stringify(new URL('./preparation-fixture.js', import.meta.url).href)};
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
let research;
if(c.role==='assess-answer') research={verdict:'supported',reasons:[]};
else {
 const q=c.questions[0], inventory=c.inventory?.sources??c.originals?.sources??[];
 const sources=Array.isArray(inventory)?inventory:inventory.rows.map(row=>Object.fromEntries(inventory.columns.map((key,i)=>[key,row[i]])));
 const source=sources.find(row=>row.location==='era-values');
 const value=boundDiscoveryValue(q.field,JSON.parse(readFileSync(process.argv[2],'utf8'))[q.field],c.discoveryContext);
 research={action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research}));`;

test('P3-83 saved v5 accepted replay keeps its public shape and paid bytes after a new Store', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-v5-accepted-replay-')), database = join(root, 'state.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new URL('../../', import.meta.url), project = 'v5-era-replay';
  const values = Object.fromEntries(VERSION5_REQUIREMENTS.discovery.map(spec => [spec.field, preparedField(project, spec.field)]));
  values.brief = 'A simple local harness'; values.objective = values.brief;
  const valuesPath = join(root, 'values.json'), adapter = join(root, 'adapter.mjs'), calls = join(root, 'calls.txt');
  writeFileSync(valuesPath, JSON.stringify(values));
  writeFileSync(adapter, `import {appendFileSync} from 'node:fs'; appendFileSync(process.argv[3], 'call\\n');\n${ADAPTER}`);
  // The pinned v5 producer creates genuine history. No record version or hash is
  // rewritten to make a current v6 record look like one from the previous era.
  const loader = join(root, 'v5-loader.mjs'), producer = join(root, 'v5-producer.mjs');
  writeFileSync(loader, String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root, commit, ts;
export async function initialize(data) {
  root=data.root; commit=data.commit; ts=(await import(data.typescript)).default;
}
export async function load(url, context, next) {
  const prefix=new URL('dist/src/',root).href;
  if(url.startsWith(prefix)&&url.endsWith('.js')) {
    const path='src/'+url.slice(prefix.length).replace(/\.js$/,'.ts');
    const source=execFileSync('git',['show',commit+':'+path],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
    return {format:'module',shortCircuit:true,source:ts.transpileModule(source,
      {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
  }
  return next(url,context);
}`);
  writeFileSync(producer, String.raw`import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const args=JSON.parse(readFileSync(0,'utf8')),url=path=>new URL('dist/src/'+path,args.repository).href;
const {Store}=await import(url('storage/store.js'));
const {ProductEngine}=await import(url('product/engine.js'));
const {reference,stageId}=await import(url('pipeline/contracts.js'));
const store=new Store(args.database),engine=new ProductEngine(store),project=args.project;
try {
  engine.execute({type:'create-project',project,title:project});
  const values=JSON.parse(readFileSync(args.valuesPath,'utf8'));
  const source=engine.discovery.evidence.document(project,'era-values',JSON.stringify(values),'application/json',0);
  const command={executable:process.execPath,args:[args.adapter,args.valuesPath,args.calls]};
  engine.environments.configure(project,{workspace:args.root,
    implementer:{actor:'author',model:'fixture',effort:'medium',command},
    reviewer:{actor:'assessor',model:'fixture',effort:'medium',command},
    fullCheck:{executable:process.execPath,args:['--version']},timeoutMs:10000},0);
  const draft=engine.prepare(project,'discovery'); assert.equal(draft.value.contractVersion,5);
  const questions=draft.value.questions.map(id=>store.get(id));
  const brief=questions.find(q=>q.value.spec.field==='brief'),objective=questions.find(q=>q.value.spec.field==='objective');
  engine.discovery.fact(brief.id,brief.revision,reference(source),{kind:'json-pointer',pointer:'/brief'});
  engine.discovery.decision(objective.id,objective.revision,'owner',values.objective);
  const result=await engine.stageResearch.run(project,draft.id,10); assert.equal(result.status,'accepted',JSON.stringify(result));
  const replay=await engine.stageResearch.run(project,draft.id,1);
  const paid=['model-call','model-response','model-request','research-context'].flatMap(kind=>{
    const rows=store.list(kind); assert.ok(rows.length>0,kind); return rows.flatMap(row=>store.history(row.id));
  });
  console.log(JSON.stringify({draftId:draft.id,replay,artifact:store.get(stageId(project,'discovery')),paid}));
} finally {store.close();}`);
  const bootstrap = `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    {data:${JSON.stringify({ root: repository.href, commit: '4dc199d7eeb73128ec4d39a9154216d9cbf32a1f',
      typescript: pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href })}});`;
  const saved = JSON.parse(execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer],
    { cwd: fileURLToPath(repository), input: JSON.stringify({ repository: repository.href, root, database, project, valuesPath, adapter, calls }),
      encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000 }));
  assert.equal(saved.replay.status, 'accepted');
  assert.equal(saved.replay.turnsUsed, 0); assert.equal(saved.replay.reason, null);
  const callsBefore = readFileSync(calls, 'utf8'); assert.ok(callsBefore.length > 0);
  const reopened = new Store(database);
  try {
    assert.equal(reopened.get<DiscoveryDraft>(saved.draftId)!.value.contractVersion, 5);
    const stamp = reopened.changeStamp();
    const replay = await new ProductEngine(reopened).stageResearch.run(project, saved.draftId, 1);
    assert.deepEqual(replay, saved.replay);
    assert.deepEqual(reopened.get(saved.artifact.id), saved.artifact);
    assert.deepEqual(['model-call', 'model-response', 'model-request', 'research-context']
      .flatMap(kind => reopened.list(kind).flatMap(row => reopened.history(row.id))), saved.paid);
    assert.equal(readFileSync(calls, 'utf8'), callsBefore, 'Accepted v5 replay makes no additional model call');
    assert.equal(reopened.changeStamp(), stamp, 'Accepted history is read without new writes');
  } finally { reopened.close(); }
});

test('DS1.2v current v6 accepted replay keeps the DRV1 public shape and paid bytes after a new Store', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-v6-era-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store), project = 'era-replay';
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project, title: project });
  const values = Object.fromEntries(REQUIREMENTS.discovery.map(spec => [spec.field, preparedField(project, spec.field)]));
  values.brief = 'A simple local harness'; values.objective = 'A simple local harness';
  const path = join(root, 'values.json'), adapter = join(root, 'adapter.mjs');
  writeFileSync(path, JSON.stringify(values)); writeFileSync(adapter, ADAPTER);
  const source = engine.discovery.evidence.document(project, 'era-values', JSON.stringify(values), 'application/json', 0);
  const command = { executable: process.execPath, args: [adapter, path] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'medium', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 10_000 }, 0);
  const draft = engine.prepare(project, 'discovery'); assert.equal(draft.value.contractVersion, 6);
  const questions = draft.value.questions.map(id => store.get<Question>(id)!);
  const brief = questions.find(q => q.value.spec.field === 'brief')!, objective = questions.find(q => q.value.spec.field === 'objective')!;
  engine.discovery.fact(brief.id, brief.revision, reference(source), { kind: 'json-pointer', pointer: '/brief' });
  engine.discovery.decision(objective.id, objective.revision, 'owner', values.objective);
  const result = await engine.stageResearch.run(project, draft.id, 10);
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  const artifact = store.get<StageArtifact>(stageId(project, 'discovery'))!, outcome = discoveryOutcome(store, store.get<DiscoveryDraft>(draft.id)!);
  const paid = ['model-call', 'model-response', 'model-request-archive'].flatMap(kind => store.list(kind).flatMap(row => store.history(row.id)));
  const expected = { status: 'accepted', stage: reference(artifact), research: null, feedback: null, findings: [],
    discovery: { state: outcome.state, verdict: outcome.verdict, report: outcome.report, conditions: outcome.conditions,
      ownerChoices: outcome.ownerChoices, reason: outcome.reason }, turnsUsed: 0, reason: null };
  const reopened = new Store(database); t.after(() => reopened.close());
  const repeated = await new ProductEngine(reopened).stageResearch.run(project, draft.id, 1);
  assert.deepEqual(repeated, expected);
  assert.deepEqual(reopened.get(artifact.id), artifact);
  assert.deepEqual(['model-call', 'model-response', 'model-request-archive'].flatMap(kind => reopened.list(kind).flatMap(row => reopened.history(row.id))), paid);
});

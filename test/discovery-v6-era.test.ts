import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonical, hashJson } from '../src/canonical.js';
import { isDiscoveryV5, discoveryOutcome } from '../src/discovery/discovery-outcome.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, VERSION5_REQUIREMENTS, VERSION6_REQUIREMENTS, VERSION6_ANALOGUES_REQUIREMENTS, selectResearchRequirements } from '../src/discovery/requirements.js';
import { VERSION6_UPSTREAM_DETAILS } from '../src/discovery/preparation-contracts.js';
import { inputResearchRequirements } from '../src/om/input.js';
import { reference, stageId, type StageArtifact } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { stageResearchContract } from '../src/product/stage-checks.js';
import { Store } from '../src/storage/store.js';
import { preparedField } from './preparation-fixture.js';
import type { EarlyStageOutcome } from '../src/product/early-stage-driver.js';

const V5_HASH = '6082bb42d272eac557007c06d3426d43af530139b72de0a91f7e038917b88586';

test('DS1.2e v6 policy values are deeply frozen and share no mutable object with v5', () => {
  const old = new Set<object>();
  const walk = (value: unknown, visit: (value: object) => void) => {
    if (value && typeof value === 'object') { visit(value); for (const child of Object.values(value)) walk(child, visit); }
  };
  walk(VERSION5_REQUIREMENTS, value => old.add(value));
  for (const table of [VERSION6_REQUIREMENTS, VERSION6_ANALOGUES_REQUIREMENTS, VERSION6_UPSTREAM_DETAILS]) walk(table, value => {
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
  for (const version of [6]) assert.equal(isDiscoveryV5(draft(version)), true);
  for (const version of [1, 2, 3, 4, 5, 7]) assert.equal(isDiscoveryV5(draft(version)), false);
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

test('DS2 the selector accepts exactly two complete v6 editions and keeps every spec property', () => {
  for (const stage of UPSTREAM_STAGES) for (const table of [VERSION6_REQUIREMENTS, VERSION6_ANALOGUES_REQUIREMENTS]) {
    const selected = selectResearchRequirements(stage, 6, structuredClone(table[stage]));
    assert.deepEqual(selected, table[stage]); assert.ok(Object.isFrozen(selected));
    assert.throws(() => { selected![0]!.prompt = 'caller edit'; }, TypeError);
  }
  const old = VERSION6_REQUIREMENTS.discovery, latest = VERSION6_ANALOGUES_REQUIREMENTS.discovery;
  for (const [name, change] of [
    ['prompt', (specs: any[]) => { specs[2].prompt += ' unknown'; }],
    ['schema', (specs: any[]) => { specs[2].schema = { type: 'null' }; }],
    ['kind', (specs: any[]) => { specs[2].kind = 'decision'; }],
    ['proof', (specs: any[]) => { specs[2].proof = 'owner'; }],
    ['risk', (specs: any[]) => { specs[2].risk += ' changed'; }],
    ['missing property', (specs: any[]) => { delete specs[2].prompt; }],
    ['extra property', (specs: any[]) => { specs[2].edition = 'pretend'; }],
    ['missing question', (specs: any[]) => { specs.pop(); }],
    ['extra question', (specs: any[]) => { specs.push(specs[0]); }],
    ['order', (specs: any[]) => { [specs[0], specs[1]] = [specs[1], specs[0]]; }],
    ['mixed editions', (specs: any[]) => { specs[2] = structuredClone(old[2]); }],
  ] as const) {
    const specs = structuredClone(latest); change(specs);
    assert.equal(selectResearchRequirements('discovery', 6, specs), null, name);
  }
  for (const absent of [null, undefined, [], [null], { questions: latest }, latest.map(spec => ({ value: { spec } }))])
    assert.equal(selectResearchRequirements('discovery', 6, absent), null);
  assert.equal(selectResearchRequirements('discovery', 5, latest), null);
  assert.equal(selectResearchRequirements('discovery', 7, latest), null);
  for(let mask=0;mask<8;mask++) {
    const mixed=structuredClone(old);
    for(const [bit,field] of ['researchPlan','researchReport','verdict'].entries())
      if(mask&(1<<bit))mixed.find(spec=>spec.field===field)!.prompt=latest.find(spec=>spec.field===field)!.prompt;
    assert.deepEqual(selectResearchRequirements('discovery',6,mixed),mask===0?old:mask===7?latest:null,`edition mask ${mask}`);
  }
  const oldObjects = new Set<object>();
  const walk = (v: unknown, visit: (v: object) => void) => {
    if (v && typeof v === 'object') { visit(v); for (const child of Object.values(v)) walk(child, visit); }
  };
  walk(VERSION6_REQUIREMENTS, v => oldObjects.add(v));
  walk(VERSION6_ANALOGUES_REQUIREMENTS, v => { assert.equal(oldObjects.has(v), false); assert.ok(Object.isFrozen(v)); });
});

test('DS2 unknown complete contracts from a real producer keep addressed driver and gate refusals', async t=>{
  const root=mkdtempSync(join(tmpdir(),'omg-ds2-unknown-')),store=new Store(join(root,'state.sqlite')),engine=new ProductEngine(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  for(const [name,change] of [
    ['prompt',(specs:any[])=>{specs[2].prompt+=' Unreleased instruction';}],
    ['schema',(specs:any[])=>{specs[2].schema={type:'object'};}],
    ['kind',(specs:any[])=>{specs[2].kind='decision';}],
    ['proof',(specs:any[])=>{specs[2].proof='extraction';}],
    ['missing',(specs:any[])=>{specs.pop();}],
    ['extra',(specs:any[])=>{specs.push({...specs[0],field:'unreleasedField'});}],
    ['order',(specs:any[])=>{[specs[0],specs[1]]=[specs[1],specs[0]];}],
    ['mixed',(specs:any[])=>{specs[3]=structuredClone(VERSION6_REQUIREMENTS.discovery[3]);}],
  ] as const){
    const project='unknown-'+name;engine.execute({type:'create-project',project,title:project});
    const specs=structuredClone(VERSION6_ANALOGUES_REQUIREMENTS.discovery);change(specs);
    const draft=engine.discovery.create(project,'discovery','R0','concept',specs,[],6);
    const result=await engine.execute({type:'early-stage-run',project,draftId:draft.id,maxTurns:1,maxCalls:1}) as EarlyStageOutcome;
    assert.equal(result.reason?.code,'early_draft_invalid',name);assert.equal(result.reason?.field,'questions');
    assert.equal(result.budget.callsMade,0);assert.equal(store.list('model-call').length,0);
    engine.draft(project,'discovery',draft.id,0);
    const gate=engine.pipeline.inspect(project,'discovery');
    assert.ok(gate.findings.some(finding=>finding.code==='research_contract_mismatch'),JSON.stringify(gate));
  }
});

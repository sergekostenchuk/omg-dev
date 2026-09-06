import { researchCall } from "../dist/src/discovery/research-protocol.js";
// Uses an online SQLite backup and a local deterministic protocol fixture only.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { Store } from '../dist/src/storage/store.js';
import { ProductEngine } from '../dist/src/product/engine.js';
import { configureReaderPilot, pilotEnvironment } from '../dist/src/discovery/reader-pilot.js';
import { configurePhasePolicy } from '../dist/src/discovery/phase-policy.js';
import { configureResearchScope, originalGaps, scopeObligations } from '../dist/src/graph/research-scope.js';
import { configureBudgetSegment, budgetUsage, budgetGroups, workingLimit } from '../dist/src/runtime/research-budget.js';
import { reference } from '../dist/src/pipeline/contracts.js';
import { hashJson } from '../dist/src/canonical.js';
const [sourcePath, outPath, option] = process.argv.slice(2);
if (!sourcePath || !outPath) throw Error('Usage: node scripts/r2-dry-run.mjs SOURCE_SQLITE NEW_OUTPUT_DIRECTORY');
const out = resolve(outPath); mkdirSync(out, { recursive: false });
const db = join(out, 'copy.sqlite');
const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
try { await backup(source, db); } finally { source.close(); }
const store = new Store(db), engine = new ProductEngine(store), project = 'omg-live';
try {
  const log = join(out, 'envelopes.ndjson'), adapter = join(out, 'fixture.mjs');
  writeFileSync(adapter, `import { readFileSync, appendFileSync } from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')), c=req.subject;
appendFileSync(${JSON.stringify(log)},JSON.stringify(req)+'\\n');
let research;
if(c.role==='budget-probe')research={probe:true};
else if(c.role==='reader')research={selections:[{sourceIndex:0,firstLine:1,lastLine:3}],unresolved:[]};
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'read_bundle',purpose:'Deterministic fixture only: inspect error contract',inputs:[{path:'src/errors.ts',media:'text/plain'}]}]};
else {
 const obs=c.readings.flatMap(r=>r.observations);
 const citations=obs.map(o=>({source:o.source,selector:o.selector}));
 research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Deterministic fixture; not new research',facts:[{id:c.question.field+'-fixture',claim:'Fixture source exists',path:'src/errors.ts'}],designs:[{id:c.question.field+'-design',decision:'Fixture projection contract',benefit:'Exercise wiring only',consumer:'n-state'}],gaps:[],...(c.question.obligations?{coverage:c.question.obligations.map(o=>({obligation:o.id,facts:[c.question.field+'-fixture'],designs:[],gaps:[]}))}:{})},citations};
}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:c.role==='budget-probe'?null:{inputTokens:100,outputTokens:25,cachedInputTokens:0,reasoningOutputTokens:5}}));`);
  const old = store.get(`reader-pilot:${project}`);
  const { projectId: _project, ...settings } = old.value;
  const command = { executable: process.execPath, args: [adapter] };
  const pilot = configureReaderPilot(store, engine.environments, project, { ...settings, agentCommand: command,
    reader: { ...settings.reader, command }, planning: { ...settings.planning, maxRounds: 5 } }, old.revision);
  const segment = configureBudgetSegment(store, project, 'R2-L3');
  configurePhasePolicy(store, project, 'L3', 'R2-L3', 0);
  const layer = store.get(`graph-layer:${project}:2`), gaps = originalGaps(store, project);
  const nodes = ['n-state','o-state-project','n-research','n-control','n-recovery','n-progress'];
  const boundaries = [...new Set(gaps.filter(g => g.id !== 'actors-g5' && !nodes.includes(g.target)).map(g => g.target))]
    .map(node => ({ node, reason: 'Preserve the existing gap as an external contract until R2 establishes whether projection inputs, consumers, authority or recovery require it; no automatic closure.' }));
  const scope = configureResearchScope(store, { projectId: project, layer: reference(layer), r1: reference(store.get(`phase:${project}:R1`)),
    outcome: 'Оператор получает читаемые файлы сохранённых стадий и исследований рядом с SQLite; после сбоя они восстанавливаются из канона без модели.',
    nodes, boundaries, expansions: [], changedPaths: [], uiRequired: option === "--include-ui",
    obligations: gaps.map(gap => ({ gap, state: gap.id === 'actors-g5' ? 'deferred' : 'active',
      reason: gap.id === 'actors-g5' ? 'UI исключён владельцем; ошибка QuestionPanel остаётся открытой.' : 'Необходимость для входов, потребителей, полномочий и восстановления проекций ещё требует адресного уточнения; сохраняем активным.',
      wake: gap.id === 'actors-g5' ? { nodes: ['n-ui'], paths: ['ui/app.tsx'], uiRequired: true } : null })) }, 0);
  const environment = pilotEnvironment(engine.environments.get(project).value, pilot.value);
  // Synthetic calibration belongs only to this copy, visibly labelled fixture.
  for (const [purpose, role] of [['reading-planner',environment.implementer],['analyst',environment.implementer],['assessor',environment.reviewer],['reader',pilot.value.reader]]) {
    store.write({ id: `model-call:fixture-${purpose}`, kind:'model-call',expected:0,value:{projectId:project,draftId:'fixture',purpose,requestId:`fixture-${purpose}`,
      startedAt:0,finishedAt:1,status:'succeeded',requested:role,confirmed:{model:null,effort:null,speed:null},
      request:{chars:1000,bytes:1000,hash:hashJson('fixture')},response:null,usage:{inputTokens:100,outputTokens:25,cachedInputTokens:0,reasoningOutputTokens:0},usageSource:'adapter',error:null} });
  }
  const draft = engine.refinement.begin(project,'R2');
  const run = await engine.researcher.run(project,draft.id,100);
  const envelopes = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  const questions = draft.value.questions.map(id => store.get(id));
  const usage = budgetUsage(store,segment);
  for (const q of questions) {
    assert.ok(envelopes.some(e => e.subject.question?.field === q.value.spec.field && e.subject.dispatchMode === 'planning'), `Missing planner envelope for ${q.value.spec.field}`);
    assert.ok(envelopes.some(e => e.subject.question?.field === q.value.spec.field && e.subject.dispatchMode === 'synthesis'), `Missing synthesis envelope for ${q.value.spec.field}`);
    assert.ok(envelopes.some(e => e.subject.question?.field === q.value.spec.field && e.subject.role === 'assess-answer'), `Missing assessor envelope for ${q.value.spec.field}`);
  }
  assert.ok(envelopes.some(e => e.subject.role === 'reader'));
  assert.equal(usage.reserved,0);
  // Independent fixture branch: expensive measured calibration, an unknown
  // response and an exhausted segment exercise the actual dispatch boundary.
  const probeQuestion = questions[0];
  engine.discovery.reopen(probeQuestion.id, probeQuestion.revision);
  store.write({ id:'model-call:fixture-expensive-assessor',kind:'model-call',expected:0,value:{...store.get('model-call:fixture-assessor').value,
    requestId:'fixture-expensive-assessor',request:{chars:1000000,bytes:1000000,hash:hashJson('fixture-expensive')},
    usage:{inputTokens:700000,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}} });
  await researchCall(environment.reviewer, environment, 'Deterministic budget probe only', {role:'budget-probe'}, undefined,
    {store,draftId:draft.id,questionId:probeQuestion.id,purpose:'assessor',pilot});
  const afterUnknown=budgetUsage(store,segment), groups=budgetGroups(store,draft.id,probeQuestion.id);
  const expandedLimit=workingLimit(store,segment,groups[0],'tokens',700000);
  assert.ok(expandedLimit>700000); assert.ok(afterUnknown.reserved>0);
  const callsBeforeStop=store.list('model-call').length;
  const limited=store.write({id:segment.id,kind:segment.kind,expected:segment.revision,value:{...segment.value,limit:afterUnknown.measured+afterUnknown.reserved+1}});
  await assert.rejects(researchCall(environment.reviewer,environment,'Deterministic exhausted-budget probe',{role:'budget-probe'},undefined,
    {store,draftId:draft.id,questionId:probeQuestion.id,purpose:'assessor',pilot}),{code:'budget_segment_exhausted'});
  assert.equal(store.list('model-call').length,callsBeforeStop);
  const budgetScenarios={fixtureOnly:true,expandedLimit,unknownReserved:afterUnknown.reserved,segmentStopBeforeDispatch:true,
    testedSegment:reference(limited),remaining:budgetUsage(store,limited).remaining};
  const report = { budgetScenarios, fixtureOnly:true, paidCalls:0, source:resolve(sourcePath), copy:db, run:run.value,
    scope:{ref:reference(scope),obligations:scopeObligations(scope.value).map(o=>({id:o.gap.id,state:o.state,reason:o.reason,wake:o.wake}))},
    questions:questions.map(q=>({id:q.id,field:q.value.spec.field,status:q.value.status})),
    envelopes:envelopes.map(e=>({question:e.subject.question?.id,field:e.subject.question?.field,role:e.subject.role,mode:e.subject.dispatchMode,chars:JSON.stringify(e).length})),
    budget:{measured:usage.measured,reserved:usage.reserved,remaining:usage.remaining}, log };
  writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({run:run.value.status,pause:run.value.pauseCode,error:run.value.error,questions:report.questions,budget:report.budget,result:join(out,'result.json')}));
  if(run.value.status!=='completed' || questions.some(q=>q.value.status!=='answered')) process.exitCode=1;
} finally { store.close(); }

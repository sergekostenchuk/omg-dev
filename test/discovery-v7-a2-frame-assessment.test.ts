import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { createPartialV7Draft, V7_AXES, V7_FRAME_FIELD, V7_STAGE_BUDGET_POLICY } from '../src/discovery/v7-contracts.js';
import type { Question } from '../src/discovery/discovery.js';
import type { ResearchAction } from '../src/discovery/research-model.js';
import { assessAnswer, directAssessmentBasis } from '../src/discovery/research-assessment.js';
import { readAssessmentSessionOutcomeAt } from '../src/discovery/assessment-session.js';
import { V7_FRAME_ASSESSMENT, V7_FRAME_ASSESSMENT_INSTRUCTION } from '../src/discovery/v7-frame-assessment.js';
import { researchCall } from '../src/discovery/research-protocol.js';

type Scenario = { productType: string; scale: string; brief: string; objective: string; deep: string[] };
const scenarios: Scenario[] = [
  { productType: 'personal', scale: 'One person, own data, own maintenance budget',
    brief: '  Рецепты для себя.\nСохранять семейные рецепты и находить их по ингредиентам — α.  ',
    objective: 'Найти семейный рецепт за минуту', deep: [] },
  { productType: 'commercial', scale: 'A construction company website, prospective customers, a small marketing budget',
    brief: 'Сайт строительной компании: показать работы заказчикам и получать заявки; соблюдать правила компании.',
    objective: 'Компания получает измеримые квалифицированные заявки', deep: ['people', 'market'] },
  { productType: 'internal', scale: '30 employees and 10 construction sites; internal company ledger',
    brief: 'Учёт ресурсов строительной компании: материалы, техника, сметы и расчёты с субподрядом. '
      + 'Часть основной ERP: данные остаются в компании, обмен с 1С, директор измеряет снижение потерь.',
    objective: 'Снизить потери материалов на 20% и сохранить сверку техники и расчётов',
    deep: ['people', 'rules', 'market', 'money', 'data', 'risks', 'outcome'] },
];
function frame(s: Scenario): Json {
  return { productType: s.productType, scale: s.scale, industries: ['Owner domain'], domains: [s.brief],
    axes: Object.fromEntries(V7_AXES.map(axis => [axis, { depth: s.deep.includes(axis) ? 'deep' : 'brief',
      reason: axis === 'rules' ? '05: preserve the organization rules in the brief; research unknown requirements'
        : axis === 'outcome' ? `12: main consumer success — ${s.objective}`
        : `${s.scale}: ${s.deep.includes(axis) ? 'Detailed evidence needed for this consequence' : 'A short check is proportional'}` }])),
    budget: { ...V7_STAGE_BUDGET_POLICY, axisHints: { rules: 2_000_000, outcome: 1_000_000 } } };
}

async function fixture(t: TestContext, requestCapacityChars?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-a2-frame-'))), path = join(root, 'state.sqlite');
  const wire = join(root, 'wire.ndjson'), settings = join(root, 'reply.json'), adapter = join(root, 'adapter.mjs');
  const stores: Store[] = [], open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(settings, JSON.stringify({ verdict: 'supported', reasons: [] }));
  writeFileSync(adapter, `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
const file=${JSON.stringify(settings)},s=JSON.parse(readFileSync(file,'utf8'));
const key=(record,pointer)=>JSON.stringify([record.id,record.revision,record.hash,pointer]);
const save=(k,a,b)=>{(s.coverage??={})[k]??=[];s.coverage[k].push([a,b]);};
for(const v of [...(r.subject.materialDelivery??[]),...(r.subject.contextDelivery??[])])save(key(v.original.record,v.original.pointer),v.served.offset,v.served.end);
for(const v of r.subject.contextWorkspace??[]){const a=(r.subject.working?.materialAddresses??[]).find(x=>key(x.record,x.pointer)===key(v.record,v.pointer));if(v.page)save(key(v.record,v.pointer),v.page.offset,v.page.end);else if(a)save(key(v.record,v.pointer),0,a.total);}
let research={verdict:s.verdict,reasons:s.reasons};
for(const a of r.subject.working?.materialAddresses??[]){const ranges=(s.coverage?.[key(a.record,a.pointer)]??[]).sort((a,b)=>a[0]-b[0]);let offset=0;for(const [start,end] of ranges){if(start>offset)break;offset=Math.max(offset,end);}if(offset<a.total){research={action:'read_context',record:a.record,pointer:a.pointer,page:{offset,limit:128000,...(a.encoding==='canonical-json'?{encoding:'canonical-json'}:{})}};break;}}
if(!research.action&&(r.subject.evidencePage?.complete===false||r.subject.candidatePage?.complete===false))research={action:'assessment_checkpoint',notes:['Read the remaining original material before judgement']};
writeFileSync(file,JSON.stringify(s));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  engine.execute({ type: 'create-project', project: 'p', title: 'A2 frame' });
  const command = { executable: process.execPath, args: [adapter] };
  let environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 60_000 }, 0);
  const calibration = engine.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Measure the fixture role', risk: 'unknown', schema: { type: 'string' } }]);
  await researchCall(environment.value.reviewer, environment.value, 'Measure fixture assessor', {}, undefined,
    { store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'assessor' });
  if (requestCapacityChars !== undefined) {
    const { projectId: _project, ...saved } = environment.value;
    environment = engine.environments.configure('p', { ...saved, requestCapacityChars }, environment.revision);
  }
  const sent = (): any[] => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const setup = (scenario = scenarios[2]!, accept: 'both' | 'brief' | 'none' = 'both') => {
    const draft = createPartialV7Draft(engine.discovery, 'p', 'concept');
    const q = (field: string) => draft.value.questions.map(id => store.get<Question>(id)!).find(row => row.value.spec.field === field)!;
    const source = engine.discovery.evidence.document('p', `mandate-${draft.id}`, scenario.brief, 'text/plain', 0);
    if (accept !== 'none') engine.discovery.fact(q('brief').id, q('brief').revision, reference(source),
      { kind: 'text-range', start: 0, end: scenario.brief.length });
    if (accept === 'both') engine.discovery.decision(q('objective').id, q('objective').revision, 'owner', scenario.objective);
    const candidate: Extract<ResearchAction, { action: 'answer' }> = {
      action: 'answer', question: q('frame').id, value: frame(scenario), citations: [] };
    return { draft, q, source, scenario, candidate,
      assess: () => assessAnswer(store, q('frame'), candidate, environment, root),
      accept: (assessment: Awaited<ReturnType<typeof assessAnswer>>) => engine.discovery.researched(q('frame').id, q('frame').revision, reference(assessment)) };
  };
  return { root, store, engine, open, environment, setup, sent,
    reply: (verdict: string, reasons: string[] = []) => writeFileSync(settings, JSON.stringify({ verdict, reasons })) };
}

test('A2: three scales deliver the whole accepted mandate and axis criteria, independent of author citations', async t => {
  const f = await fixture(t);
  for (const scenario of scenarios) {
    const s = f.setup(scenario);
    if (scenario.productType === 'internal') s.candidate.citations.push({ source: reference(s.source),
      selector: { kind: 'text-range', start: 0, end: scenario.brief.indexOf('.') + 1 } });
    const assessment = await s.assess();
    const request = f.sent().at(-1), material = request.subject.v7Frame;
    assert.equal(material.contract, V7_FRAME_ASSESSMENT);
    assert.equal(material.brief.value, scenario.brief);
    assert.equal(material.brief.observation.value, scenario.brief);
    assert.equal(material.objective.value, scenario.objective);
    assert.deepEqual(material.brief.answer, s.q('brief').value.answer);
    assert.deepEqual(material.objective.answer, s.q('objective').value.answer);
    assert.deepEqual(material.brief.observation.source, reference(s.source));
    assert.deepEqual(request.subject.value, s.candidate.value);
    assert.ok(request.prompt.includes(V7_FRAME_ASSESSMENT_INSTRUCTION));
    assert.ok(request.subject.question.prompt.includes('axes.rules.reason'));
    assert.ok(request.subject.question.prompt.includes('axes.outcome.reason'));
    assert.ok(assessment.value.observations.some(item => item.value === scenario.brief),
      'An absent or shortened author citation cannot hide the original mandate');
    assert.equal(s.accept(assessment).value.fields.frame && s.q('frame').value.status, 'answered');
  }
  assert.ok(V7_FRAME_FIELD.prompt.includes('Личное назначение'));
});

test('A2: narrowed scope, unjustified shallow depth and lost larger-system rules/success remain unaccepted', async t => {
  const f = await fixture(t);
  const cases = [
    { verdict: 'conflicting', reason: 'Dropped equipment and subcontractor settlements from the owner mandate', change: (v: any) => { v.domains = ['materials only']; } },
    { verdict: 'insufficient', reason: 'Money, rules and data depth is unjustifiably brief for an internal ledger', change: (v: any) => {
      for (const axis of ['rules', 'data', 'money']) v.axes[axis] = { depth: 'brief', reason: 'Small app' };
    } },
    { verdict: 'insufficient', reason: 'Rules 05 and outcome 12 omit the parent ERP and director success criterion', change: (v: any) => {
      v.scale = 'Standalone app'; v.axes.rules.reason = 'Generic rules'; v.axes.outcome.reason = 'App works';
    } },
  ];
  for (const c of cases) {
    const s = f.setup(); c.change(s.candidate.value); f.reply(c.verdict, [c.reason]);
    const before = reference(f.store.get(s.draft.id)!), result = await s.assess();
    assert.equal(result.value.verdict, c.verdict); assert.deepEqual(result.value.reasons, [c.reason]);
    assert.throws(() => s.accept(result), { code: 'research_not_supported' });
    assert.equal(s.q('frame').value.status, 'open');
    assert.deepEqual(reference(f.store.get(s.draft.id)!), before);
    assert.equal(f.sent().at(-1).subject.v7Frame.brief.value, s.scenario.brief);
  }
});

test('A2: missing and reopened brief/objective refuse before any model call or assessment write', async t => {
  const f = await fixture(t);
  for (const state of ['no-brief', 'no-objective', 'reopen-brief', 'reopen-objective'] as const) {
    const s = f.setup(scenarios[0]!, state === 'no-brief' ? 'none' : state === 'no-objective' ? 'brief' : 'both');
    if (state.startsWith('reopen-')) {
      const q = s.q(state === 'reopen-brief' ? 'brief' : 'objective');
      f.engine.discovery.reopen(q.id, q.revision);
    }
    const calls = f.sent().length, assessments = f.store.list('research-assessment').length;
    await assert.rejects(s.assess(), { code: 'discovery_frame_basis_invalid' });
    assert.equal(f.sent().length, calls); assert.equal(f.store.list('research-assessment').length, assessments);
  }
});

test('A2: paid context restores cold from exact history; a reopened mandate cannot admit that old assessment', async t => {
  const f = await fixture(t), s = f.setup(), result = await s.assess(), origin = result.value.origin!;
  assert.ok(origin);
  const originalBasis = directAssessmentBasis(f.store, result), calls = f.sent().length;
  const objective = s.q('objective'); f.engine.discovery.reopen(objective.id, objective.revision);
  const cold = f.open();
  const restored = readAssessmentSessionOutcomeAt(cold, 'p', origin.session, origin.application);
  assert.equal(restored.context.v7Frame.brief.value, s.scenario.brief);
  assert.equal(restored.context.v7Frame.objective.value, s.scenario.objective);
  assert.deepEqual(directAssessmentBasis(cold, result), originalBasis);
  assert.throws(() => new ProductEngine(cold).discovery.researched(s.q('frame').id, s.q('frame').revision, reference(result)),
    { code: 'research_assessment_basis_stale' });
  assert.equal(f.sent().length, calls);
});

test('A2: a changing proposal getter is read once and cannot replace the assessed frame', async t => {
  const f = await fixture(t), s = f.setup(), expected = s.candidate.value;
  let reads = 0;
  Object.defineProperty(s.candidate, 'value', { enumerable: true, get: () => ++reads === 1 ? expected : { productType: 'forged' } });
  const result = await s.assess();
  assert.equal(reads, 1); assert.equal(canonical(result.value.value), canonical(expected));
  assert.deepEqual(f.sent().at(-1).subject.value, expected);
});

test('A2: a large accepted brief reaches the assessor completely through bounded material delivery', async t => {
  const f = await fixture(t), scenario = { ...scenarios[2]!, brief: 'Original boundary α\n'.repeat(5500) + 'END — parent ERP rules and director success' };
  const s = f.setup(scenario);
  (s.candidate.value as Record<string, Json>).domains = ['materials', 'equipment', 'estimates', 'subcontractor settlements'];
  const before = f.sent().length, result = await s.assess(), requests = f.sent().slice(before);
  assert.ok(requests.length > 1, 'The complete original needs more than one bounded request');
  const fragments: { offset: number; text: string }[] = [];
  for (const request of requests) {
    assert.ok(JSON.stringify(request.subject).length <= 300_000);
    for (const fragment of [...(request.subject.materialDelivery ?? []), ...(request.subject.contextDelivery ?? [])])
      if (fragment.original.pointer === '/body/v7Frame') fragments.push({ offset: fragment.served.offset, text: fragment.text });
    for (const lookup of request.subject.contextWorkspace ?? [])
      if (lookup.pointer === '/body/v7Frame' && lookup.page?.encoding === 'canonical-json')
        fragments.push({ offset: lookup.page.offset, text: lookup.value });
  }
  let delivered = '';
  for (const part of fragments.sort((a, b) => a.offset - b.offset)) {
    assert.ok(part.offset <= delivered.length, 'Every next original fragment connects to the delivered prefix');
    delivered += part.text.slice(Math.max(0, delivered.length - part.offset));
  }
  const material = JSON.parse(delivered);
  assert.equal(material.brief.value, scenario.brief);
  assert.equal(material.brief.observation.value, scenario.brief);
  assert.equal(material.objective.value, scenario.objective);
  assert.equal(result.value.verdict, 'supported');
  assert.equal(s.accept(result).value.fields.frame && s.q('frame').value.status, 'answered');
});

test('A2: an impossible mandatory capacity refuses before a physical assessment', async t => {
  const f = await fixture(t, 1000), s = f.setup(), calls = f.sent().length;
  await assert.rejects(s.assess(), error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'research_capacity_configuration');
    assert.equal(error.message, 'Mandatory result grounds exceed the admission envelope');
    const details = error.details as { required: number; envelopeLimitChars: number };
    assert.equal(details.envelopeLimitChars, 1000); assert.ok(details.required > details.envelopeLimitChars);
    return true;
  });
  assert.equal(f.sent().length, calls);
  assert.equal(f.store.list('research-assessment').length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { hashJson, type Json } from '../src/canonical.js';
import { discoveryBasisCatalogue, discoveryContext } from '../src/discovery/discovery-outcome.js';
import { conceptApplicationFindings } from '../src/discovery/preparation-validation.js';
import { conceptApplicationsSchema, sectionSchema } from '../src/discovery/preparation-contracts.js';
import { workingContext } from '../src/discovery/working-context.js';
import { Store } from '../src/storage/store.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { VERSION6_REQUIREMENTS } from '../src/discovery/requirements.js';
import { reference } from '../src/pipeline/contracts.js';
import { preparedField, preparationValue, boundDiscoveryValue } from './preparation-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';

const source = { id: 'stage:p:discovery', revision: 1, hash: hashJson('accepted discovery') };
const catalogue = discoveryBasisCatalogue({ ref: source, fields: {
  preparation: { constraints: [{ id: 'offline', rule: 'Keep results available without a network session', basis: 'owner brief' }] },
  verdict: { outcome: 'go', variant: 'Single subscribed vendor with a separate API route' },
} as unknown as Record<string, Json> });
const application = (basis: typeof catalogue.variant.address, ...appliedAt: string[]) =>
  ({ contract: 'basis-application/v1', basis, appliedAt });
const sections = (): Json => [{ id: 'flow', title: 'Run a request', requirements: [{
  id: 'request', statement: 'Use one subscribed vendor and retain a separately configured API route',
  benefit: 'A user can choose the available route', beneficiary: 'user', outcome: 'request-complete',
  acceptance: ['A request can complete on the subscription route and on the API route',
    'A saved result remains readable without a network session'],
  applications: [
    application(catalogue.variant.address, '/0/requirements/0/statement', '/0/requirements/0/acceptance/0'),
    application(catalogue.constraints[0]!.address, '/0/requirements/0/acceptance/1'),
  ],
}] }] as unknown as Json;

test('v6 concept requires explicit applications while the released v5 schema stays unchanged', () => {
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  const v6 = ajv.compile(conceptApplicationsSchema as object), v5 = ajv.compile(sectionSchema as object);
  assert.equal(v6(sections()), true);
  assert.equal(v5(sections()), false);
  const missing = structuredClone(sections()) as any[];
  delete missing[0].requirements[0].applications;
  assert.equal(v6(missing), false);
  assert.equal(v5(missing), true);
});

test('one concept applies the accepted variant and each exact constraint at its own substantive targets', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-concept-foreign-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(conceptApplicationFindings(sections(), catalogue), []);
  const withoutConstraint = structuredClone(sections()) as any[];
  withoutConstraint[0].requirements[0].applications.pop();
  assert.equal(conceptApplicationFindings(withoutConstraint, catalogue)[0]?.code, 'basis_application_missing');
  assert.equal(conceptApplicationFindings(withoutConstraint, catalogue)[0]?.target, '/conceptSections');
  const foreign = structuredClone(sections()) as any[];
  const foreignSource = store.write({ id: 'stage:other:discovery', kind: 'stage', expected: 0, value: {
    projectId: 'other', stage: 'discovery', status: 'accepted', content: null, inputs: [], proofs: [],
  } });
  foreign[0].requirements[0].applications[0].basis.record = reference(foreignSource);
  assert.equal(conceptApplicationFindings(foreign, catalogue)[0]?.code, 'basis_application_invalid');
  assert.equal(conceptApplicationFindings(foreign, catalogue)[0]?.target,
    '/conceptSections/0/requirements/0/applications/0/basis');
  const metadata = structuredClone(sections()) as any[];
  metadata[0].requirements[0].applications[0].appliedAt = ['/0/requirements/0/id'];
  assert.equal(conceptApplicationFindings(metadata, catalogue)[0]?.code, 'basis_application_invalid');
  const missingRequirements = structuredClone(sections()) as any[];
  delete missingRequirements[0].requirements;
  assert.equal(conceptApplicationFindings(missingRequirements, catalogue)[0]?.target,
    '/conceptSections/0/requirements');
});

test('initial and continuation packets keep the complete exact catalogue or refuse the limit', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-concept-catalogue-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const draftId = 'draft:concept:catalogue', questionId = 'question:concept:catalogue';
  store.write<DiscoveryDraft>({ id: draftId, kind: 'discovery-draft', expected: 0, value: {
    projectId: 'p', createdAt: 1, stage: 'concept', level: 'R0', consumer: 'concept',
    fields: {}, questions: [questionId], inputs: [], contractVersion: 6,
  } });
  const spec = { field: 'conceptSections', kind: 'design' as const, prompt: 'Develop the concept',
    risk: 'No adopted constraints', schema: conceptApplicationsSchema };
  store.write<Question>({ id: questionId, kind: 'question', expected: 0, value: {
    projectId: 'p', draftId, stage: 'concept', level: 'R0', consumer: 'concept',
    spec, beforeHash: hashJson({}), status: 'open', answer: null,
  } });
  const largeCatalogue = { ...catalogue, constraints: Array.from({ length: 80 }, (_, index) => ({
    address: { record: source, pointer: `/content/fields/preparation/constraints/${index}` },
    value: { id: `constraint-${index}`, rule: `Preserve this distinct condition ${index}: ${'x'.repeat(60)}`,
      basis: 'accepted Discovery' },
  })) };
  const context = { role: 'research', question: { id: questionId, ...spec },
    discoveryBasisCatalogue: largeCatalogue, history: [], inventory: { sources: [], files: [], filesTruncated: false } };
  const initial = workingContext(store, 'p', draftId, questionId, context, 100_000, { common: true });
  const continuation = workingContext(store, 'p', draftId, questionId, context, 100_000,
    { common: true, continuation: true, previous: initial.working.archive });
  const correction = workingContext(store, 'p', draftId, questionId,
    { ...context, failures: [{ code: 'basis_application_missing', field: 'conceptSections' }] }, 100_000,
    { common: true, continuation: true, previous: continuation.working.archive });
  assert.deepEqual(initial.discoveryBasisCatalogue, largeCatalogue);
  assert.deepEqual(continuation.discoveryBasisCatalogue, largeCatalogue);
  assert.deepEqual(correction.discoveryBasisCatalogue, largeCatalogue);
  assert.throws(() => workingContext(store, 'p', draftId, questionId,
    { ...context, discoveryBasisCatalogue: undefined }, 100_000, { common: true }),
  (error: any) => error.code === 'context_discovery_incomplete');
  assert.throws(() => workingContext(store, 'p', draftId, questionId, context, 500, { common: true }),
    (error: any) => error.code === 'pilot_core_limit');
});

test('a direct design answer is refused before assessment and cannot pass the v6 concept gate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-concept-gate-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Harness' });
  const called = join(root, 'assessor-called'), adapter = join(root, 'assessor.mjs');
  writeFileSync(adapter, `import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
writeFileSync(${JSON.stringify(called)},'called');
const context=request.subject;
if(context.discoveryBasisCatalogue?.contract!=='discovery-basis-catalogue/v1') throw Error('Missing exact Discovery grounds');
if(!context.discoveryBasisCatalogue.constraints.some(entry=>entry.value.rule==='Use local input and output only')
  || context.discoveryBasisCatalogue.variant.value!=='Local stateless transformation') throw Error('Wrong Discovery grounds');
const opposed=JSON.stringify(context.value).includes('Requires a network session to read saved results');
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research:{verdict:opposed?'conflicting':'supported',reasons:opposed?['The proposed criterion reverses the accepted offline constraint']:[]}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const source = engine.discovery.evidence.document('p', 'brief', 'Build a simple model harness', 'text/plain', 0);
  const discovery = engine.prepare('p', 'discovery');
  engine.discovery.fact(discovery.value.questions[0]!, 1, reference(source),
    { kind: 'text-range', start: 0, end: source.value.content.length });
  engine.discovery.decision(discovery.value.questions[1]!, 1, 'owner', 'Run one subscribed vendor and a separate API route');
  for (const id of discovery.value.questions) {
    const question = store.get<Question>(id)!;
    if (['researchPlan', 'researchReport', 'verdict'].includes(question.value.spec.field))
      answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(discovery.id)!, question,
        preparedField('p', question.value.spec.field), source);
  }
  const preparationQuestion = discovery.value.questions.find(id => store.get<Question>(id)!.value.spec.field === 'preparation')!;
  const current = store.get<DiscoveryDraft>(discovery.id)!;
  const selected = store.get<Question>(preparationQuestion)!;
  engine.discovery.decision(preparationQuestion, selected.revision, 'owner',
    boundDiscoveryValue('preparation', preparationValue('p'),
      discoveryContext(store, current, selected).context));
  const discoveryStage = engine.draft('p', 'discovery', discovery.id, 0);
  const accepted = engine.pipeline.accept('p', 'discovery', discoveryStage.revision);
  const draft = engine.discovery.create('p', 'concept', 'R0', 'concept', VERSION6_REQUIREMENTS.concept,
    [reference(accepted)], 6);
  let conceptQuestion = '';
  for (const id of draft.value.questions) {
    const question = store.get<Question>(id)!;
    const field = question.value.spec.field;
    const value: Json = field === 'audience' ? 'User' : field === 'outcome' ? 'Complete a request'
      : field === 'acceptance' ? ['One result'] : (() => {
        const answer = structuredClone(sections()) as any[];
        answer[0].requirements[0].applications = [];
        return answer as Json;
      })();
    if (field === 'conceptSections') await assert.rejects(
      assessAnswer(store, question, { action: 'answer', question: id, value, citations: [] }, environment, root),
      (error: any) => error.code === 'basis_application_missing');
    if (field === 'conceptSections') conceptQuestion = id;
    engine.discovery.decision(id, question.revision, 'owner', value);
  }
  assert.equal(existsSync(called), false);
  const completed = store.get<DiscoveryDraft>(draft.id)!;
  engine.pipeline.draft('p', 'concept', { draft: reference(completed), fields: completed.value.fields,
    graph: null } as unknown as Json, 0);
  assert.ok(engine.pipeline.inspect('p', 'concept').findings.some(item => item.code === 'basis_application_missing'));

  const opened = engine.discovery.reopen(conceptQuestion, store.get<Question>(conceptQuestion)!.revision);
  const acceptedFields = (accepted.value.content as unknown as { fields: Record<string, Json> }).fields;
  const exactCatalogue = discoveryBasisCatalogue({ ref: reference(accepted), fields: acceptedFields });
  const valid = structuredClone(sections()) as any[];
  const requirement = valid[0].requirements[0];
  requirement.acceptance = ['The chosen route completes a request', ...exactCatalogue.constraints.map(
    item => (item.value as { rule: string }).rule)];
  requirement.applications = [application(exactCatalogue.variant.address, '/0/requirements/0/statement'),
    ...exactCatalogue.constraints.map((item, index) => application(item.address,
      `/0/requirements/0/acceptance/${index + 1}`))];
  const opposed = structuredClone(valid) as any[];
  opposed[0].requirements[0].acceptance[1] = 'Requires a network session to read saved results';
  const conflict = await assessAnswer(store, opened, { action: 'answer', question: conceptQuestion,
    value: opposed as Json, citations: [{ source: reference(source), selector: {
      kind: 'text-range', start: 0, end: source.value.content.length } }] }, environment, root);
  assert.equal(conflict.value.verdict, 'conflicting');
  assert.ok(store.get(conflict.id));
  assert.throws(() => engine.discovery.researched(conceptQuestion, opened.revision, reference(conflict)),
    (error: any) => error.code === 'research_not_supported');
  assert.equal(store.get<Question>(conceptQuestion)!.value.status, 'open');
  const supported = await assessAnswer(store, opened, { action: 'answer', question: conceptQuestion,
    value: valid as Json, citations: [{ source: reference(source), selector: {
      kind: 'text-range', start: 0, end: source.value.content.length } }] }, environment, root);
  assert.equal(existsSync(called), true);
  const other = new Store(join(root, 'state.sqlite'));
  try {
    const peer = new ProductEngine(other);
    const old = other.get<Question>(preparationQuestion)!;
    const reopened = peer.discovery.reopen(preparationQuestion, old.revision);
    const changed = preparationValue('p') as Record<string, Json>;
    changed['problem'] = 'The revised accepted problem';
    peer.discovery.decision(preparationQuestion, reopened.revision, 'owner',
      boundDiscoveryValue('preparation', changed,
        discoveryContext(other, other.get<DiscoveryDraft>(discovery.id)!, reopened).context));
    const replacement = peer.draft('p', 'discovery', discovery.id, accepted.revision);
    peer.pipeline.accept('p', 'discovery', replacement.revision);
  } finally { other.close(); }
  assert.throws(() => engine.discovery.researched(conceptQuestion, opened.revision, reference(supported)),
    (error: any) => error.code === 'research_assessment_basis_stale');
  assert.equal(store.get<Question>(conceptQuestion)!.value.status, 'open');
});

test('v6 concept analyst continuation and escalation see the same exact Discovery catalogue', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-concept-delivery-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Harness' });
  const log = join(root, 'calls.jsonl'), adapter = join(root, 'delivery.mjs');
  writeFileSync(adapter, `import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')), c=req.subject, log=${JSON.stringify(log)};
const previous=existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
appendFileSync(log,JSON.stringify({role:c.role,catalogue:c.discoveryBasisCatalogue})+'\\n');
const reply=research=>console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));
if(c.role==='assess-escalation') reply({necessary:false,reason:'The accepted Discovery scope already answers the choice'});
else if(c.role==='assess-answer') reply({verdict:'supported',reasons:[]});
else {
  const inventory=c.inventory??{sources:c.originals?.sources??[]};
  const sources=Array.isArray(inventory.sources)?inventory.sources:
    inventory.sources.rows.map(row=>Object.fromEntries(inventory.sources.columns.map((key,i)=>[key,row[i]])));
  const source=sources[0], question=c.questions[0].id;
  if(!previous.some(call=>call.role==='research')) reply({action:'read_source',source:source.ref,start:0,end:source.length});
  else reply({action:'need_owner',question,reason:'Check whether the accepted scope resolves this',searched:[source.ref]});
}`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const source = engine.discovery.evidence.document('p', 'brief', 'The owner selected a local route.', 'text/plain', 0);
  const discovery = engine.prepare('p', 'discovery');
  engine.discovery.fact(discovery.value.questions[0]!, 1, reference(source),
    { kind: 'text-range', start: 0, end: source.value.content.length });
  engine.discovery.decision(discovery.value.questions[1]!, 1, 'owner', 'Use the selected local route');
  for (const id of discovery.value.questions) {
    const question = store.get<Question>(id)!;
    if (['researchPlan', 'researchReport', 'verdict'].includes(question.value.spec.field))
      answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(discovery.id)!, question,
        preparedField('p', question.value.spec.field), source);
  }
  const preparationQuestion = discovery.value.questions.find(id => store.get<Question>(id)!.value.spec.field === 'preparation')!;
  const current = store.get<DiscoveryDraft>(discovery.id)!;
  const selected = store.get<Question>(preparationQuestion)!;
  engine.discovery.decision(preparationQuestion, selected.revision, 'owner',
    boundDiscoveryValue('preparation', preparationValue('p'),
      discoveryContext(store, current, selected).context));
  const discoveryStage = engine.draft('p', 'discovery', discovery.id, 0);
  const accepted = engine.pipeline.accept('p', 'discovery', discoveryStage.revision);
  const concept = engine.discovery.create('p', 'concept', 'R0', 'concept', VERSION6_REQUIREMENTS.concept,
    [reference(accepted)], 6);
  await engine.researcher.run('p', concept.id, 2);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.role), ['research', 'research', 'assess-escalation']);
  const expected = discoveryBasisCatalogue({ ref: reference(accepted),
    fields: (accepted.value.content as unknown as { fields: Record<string, Json> }).fields });
  for (const call of calls) assert.deepEqual(call.catalogue, expected);
  const audience = store.get<Question>(concept.value.questions[0]!)!;
  const assessment = await assessAnswer(store, audience, { action: 'answer', question: audience.id,
    value: 'User', citations: [{ source: reference(source), selector: {
      kind: 'text-range', start: 0, end: source.value.content.length } }] }, environment, root);
  assert.equal(assessment.value.verdict, 'supported');
  const after = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(after.at(-1)?.role, 'assess-answer');
  assert.deepEqual(after.at(-1)?.catalogue, expected);
});

test('a paid v6 concept application refusal resumes with one correcting analyst call', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-concept-correction-'));
  const path = join(root, 'state.sqlite'), store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'Harness' });
  const source = engine.discovery.evidence.document('p', 'brief', 'Use local input and output only.', 'text/plain', 0);
  const log = join(root, 'calls.jsonl'), adapter = join(root, 'correction.mjs');
  const values = Object.fromEntries(VERSION6_REQUIREMENTS.concept.map(spec => [spec.field, preparedField('p', spec.field)]));
  writeFileSync(join(root, 'values.json'), JSON.stringify(values));
  writeFileSync(adapter, `import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject,log=${JSON.stringify(log)};
const previous=existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
const field=c.questions?.[0]?.field??c.question?.field;
appendFileSync(log,JSON.stringify({role:c.role,field,failures:c.failures??[],catalogue:c.discoveryBasisCatalogue})+'\\n');
const reply=research=>console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));
if(c.role==='assess-answer') reply({verdict:'supported',reasons:[]});
else {
  const q=c.questions[0], value=structuredClone(JSON.parse(readFileSync(${JSON.stringify(join(root, 'values.json'))},'utf8'))[q.field]);
  if(q.field==='conceptSections') {
    const requirement=value[0].requirements[0], catalogue=c.discoveryBasisCatalogue;
    requirement.acceptance.push(...catalogue.constraints.map(row=>row.value.rule));
    const corrected=previous.some(row=>row.role==='research'&&row.field==='conceptSections');
    requirement.applications=corrected?[{contract:'basis-application/v1',basis:catalogue.variant.address,
      appliedAt:['/0/requirements/0/statement']},...catalogue.constraints.map((row,index)=>({
      contract:'basis-application/v1',basis:row.address,
      appliedAt:['/0/requirements/0/acceptance/'+(index+requirement.acceptance.length-catalogue.constraints.length)]}))]:[];
  }
  reply({action:'answer',question:q.id,value,citations:[{source:${JSON.stringify(reference(source))},
    selector:{kind:'text-range',start:0,end:${source.value.content.length}}}]});
}`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const discovery = engine.prepare('p', 'discovery');
  engine.discovery.fact(discovery.value.questions[0]!, 1, reference(source),
    { kind: 'text-range', start: 0, end: source.value.content.length });
  engine.discovery.decision(discovery.value.questions[1]!, 1, 'owner', 'Use the local route');
  for (const id of discovery.value.questions) {
    const question = store.get<Question>(id)!;
    if (['researchPlan', 'researchReport', 'verdict'].includes(question.value.spec.field))
      answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(discovery.id)!, question,
        preparedField('p', question.value.spec.field), source);
  }
  const preparationQuestion = discovery.value.questions.find(id => store.get<Question>(id)!.value.spec.field === 'preparation')!;
  const current = store.get<DiscoveryDraft>(discovery.id)!, selected = store.get<Question>(preparationQuestion)!;
  engine.discovery.decision(preparationQuestion, selected.revision, 'owner',
    boundDiscoveryValue('preparation', preparationValue('p'), discoveryContext(store, current, selected).context));
  const discoveryStage = engine.draft('p', 'discovery', discovery.id, 0);
  const accepted = engine.pipeline.accept('p', 'discovery', discoveryStage.revision);
  const concept = engine.discovery.create('p', 'concept', 'R0', 'concept', VERSION6_REQUIREMENTS.concept,
    [reference(accepted)], 6);
  const first = await engine.researcher.run('p', concept.id, 4);
  const readCalls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const before = readCalls();
  assert.equal(first.value.status, 'paused');
  assert.equal(before.filter(call => call.role === 'research' && call.field === 'conceptSections').length, 1);
  assert.equal(store.list('research-turn').some(turn => (turn.value as any).observation?.code === 'basis_application_missing'), true);
  const reopened = new Store(path);
  try {
    const resumed = await new ProductEngine(reopened).researcher.run('p', concept.id, 1);
    assert.equal(resumed.value.status, 'completed');
    const after = readCalls(), analysts = after.filter(call => call.role === 'research');
    assert.equal(analysts.filter(call => call.field === 'conceptSections').length, 2);
    assert.equal(analysts.length, before.filter(call => call.role === 'research').length + 1);
    assert.ok(analysts.at(-1)?.failures.some((failure: any) => failure.code === 'basis_application_missing'));
  } finally { reopened.close(); }
});

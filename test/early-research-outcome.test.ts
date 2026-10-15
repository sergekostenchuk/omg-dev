import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveredConceptSections, earlyResearchFailure, requireAssessmentReply } from '../src/discovery/early-research-outcome.js';
import { discoveryBasisCatalogue } from '../src/discovery/discovery-outcome.js';
import { conceptApplicationsSchema } from '../src/discovery/preparation-contracts.js';
import { VERSION6_REQUIREMENTS } from '../src/discovery/requirements.js';
import { preparedField } from './preparation-fixture.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';

const draft = { projectId: 'p', stage: 'discovery', questions: ['q'] } as DiscoveryDraft;
const question: Question = { projectId: 'p', draftId: 'd', stage: 'discovery', level: 'R0', consumer: 'discovery',
  beforeHash: '0'.repeat(64), status: 'open', answer: null, spec: { field: 'result', kind: 'design', prompt: 'Result', risk: 'Missing result', schema: {
  type: 'object', required: ['result'], properties: { result: { type: 'string' } }, additionalProperties: false
} } };
const ref = { id: 'source', revision: 1, hash: 'a'.repeat(64) };
const answer = { action: 'answer', question: 'q', value: { result: 'yes' },
  citations: [{ source: ref, selector: { kind: 'text-range', start: 0, end: 1 } }] };
const rows = [
  ['M1', { action: 'read_bundle', purpose: 'Read', inputs: [{ path: 'a', media: 'text/plain' }] }, 'reader_pilot_required'],
  ['M2', { action: 'answer_delta', question: 'q', base: ref, upserts: {}, removes: {}, citations: answer.citations }, 'reader_pilot_required'],
  ['M3', { action: 'read_plan', question: 'q', reads: [{ action: 'read', path: 'a', media: 'text/plain' }] }, 'reading_plan_disabled'],
  ['M4', { action: 'synthesize', question: 'q' }, 'research_question_foreign'],
  ['M4 need_research', { action: 'need_research', question: 'q', missing: ['evidence'] }, 'research_question_foreign'],
  ['M5', { action: 'need_source', question: 'q' }, 'research_response_invalid'],
  ['M6', { action: 'answer', question: 'q' }, 'research_response_invalid'],
  ['M7', { ...answer, value: 42 }, 'answer_invalid']
] as const;
for (const [id, payload, code] of rows) test(`DRY5FIX ${id}: exact early reply error`, () => {
  assert.equal(earlyResearchFailure(draft, question, 'analyst', payload)?.code, code);
  assert.equal(earlyResearchFailure({ ...draft, stage: 'om-g2' }, question, 'analyst', payload), null);
});
test('DRY5FIX M8/M9/M10 classify role payloads without turning negative results into errors', () => {
  for (const payload of [{ action: 'answer' }, { verdict: 'unknown', reasons: [] }, { verdict: 'supported' },
    { verdict: 'supported', reasons: 42 }, { action: 'assessment_checkpoint' }])
    assert.ok(earlyResearchFailure(draft, question, 'assessor', payload));
  for (const verdict of ['supported', 'insufficient', 'conflicting'])
    assert.equal(earlyResearchFailure(draft, question, 'assessor', { verdict, reasons: ['reason'] }), null);
  for (const necessary of [true, false])
    assert.equal(earlyResearchFailure(draft, question, 'escalation-assessor', { necessary, reason: 'reason' }), null);
  for (const payload of [{ necessary: true }, { necessary: 'true', reason: 'reason' }, { verdict: 'supported' }])
    assert.equal(earlyResearchFailure(draft, question, 'escalation-assessor', payload)?.code, 'escalation_assessment_invalid');
  assert.doesNotThrow(() => requireAssessmentReply({ action: 'assessment_checkpoint', notes: [] }));
  assert.equal(earlyResearchFailure(draft, question, 'analyst', answer), null);
});
test('DRY5FIX absence of the classification contract is addressed, never a model retry', () => {
  for (const absent of [null, {}, { ...question, spec: null }])
    assert.throws(() => earlyResearchFailure(draft, absent as Question, 'analyst', answer), { code: 'early_research_input_invalid' });
});

test('DS1.2c a malformed v6 concept application is a correctable answer error on its original catalogue', () => {
  const source = { id: 'stage:p:discovery', revision: 1, hash: 'b'.repeat(64) };
  const catalogue = discoveryBasisCatalogue({ ref: source, fields: {
    preparation: { constraints: [{ id: 'offline', rule: 'Read saved results without a network session', basis: 'report' }] },
    verdict: { outcome: 'go', variant: 'One local transformation' },
  } });
  const conceptDraft = { ...draft, stage: 'concept', contractVersion: 6 } as DiscoveryDraft;
  const conceptQuestion = { ...question, stage: 'concept', spec: {
    ...question.spec, field: 'conceptSections', schema: conceptApplicationsSchema,
  } } as Question;
  const valid = [{ id: 'flow', title: 'Run', requirements: [{ id: 'result', statement: 'Transform locally',
    benefit: 'Fast access', beneficiary: 'user', outcome: 'saved result',
    acceptance: ['A saved result is available without a network session'], applications: [
      { contract: 'basis-application/v1', basis: catalogue.variant.address,
        appliedAt: ['/0/requirements/0/statement'] },
      { contract: 'basis-application/v1', basis: catalogue.constraints[0]!.address,
        appliedAt: ['/0/requirements/0/acceptance/0'] },
    ] }] }];
  const classify = (value: unknown, basis: typeof catalogue | null = catalogue) => earlyResearchFailure(
    conceptDraft, conceptQuestion, 'analyst', { action: 'answer', question: 'q', value, citations: answer.citations },
    null, false, null, basis);
  assert.equal(classify(valid), null);
  const missing = structuredClone(valid);
  missing[0]!.requirements[0]!.applications = [];
  assert.equal(classify(missing)?.code, 'basis_application_missing');
  const foreign = structuredClone(valid);
  foreign[0]!.requirements[0]!.applications[0]!.basis.pointer = '/content/fields/verdict/outcome';
  assert.equal(classify(foreign)?.code, 'basis_application_invalid');
  assert.throws(() => classify(valid, null), { code: 'basis_application_material_invalid' });
  assert.equal(earlyResearchFailure({ ...conceptDraft, contractVersion: 5 }, conceptQuestion, 'analyst',
    { action: 'answer', question: 'q', value: valid, citations: answer.citations }), null);
});

test('DS1.2s the original v6 specification cursor classifies missing or foreign grounds as a completed proposal refusal', () => {
  const catalogue = discoveryBasisCatalogue({ ref: { id: 'stage:p:discovery', revision: 1, hash: 'c'.repeat(64) }, fields: {
    preparation: { constraints: [{ id: 'offline', rule: 'Read saved results offline', basis: 'accepted report' }] },
    verdict: { outcome: 'go', variant: 'A local route' },
  } });
  const apply = (basis: typeof catalogue.variant.address, appliedAt: string) =>
    ({ contract: 'basis-application/v1', basis, appliedAt: [appliedAt] });
  const concept = [{ id: 'journey', requirements: [{ id: 'p-R1', statement: 'Provide a local route', benefit: 'Use results',
    beneficiary: 'p-user', outcome: 'p-result', acceptance: ['Read saved results offline'], applications: [
      apply(catalogue.variant.address, '/0/requirements/0/statement'),
      apply(catalogue.constraints[0]!.address, '/0/requirements/0/acceptance/0'),
    ] }] }];
  const conceptRef = { id: 'stage:p:concept', revision: 1, hash: 'd'.repeat(64) };
  const specification = { ...draft, stage: 'specification', contractVersion: 6,
    inputs: [conceptRef] } as DiscoveryDraft;
  const specQuestion = { ...question, stage: 'specification', spec: VERSION6_REQUIREMENTS.specification.find(row =>
    row.field === 'behaviorContracts')! } as Question;
  const rows = structuredClone(preparedField('p', 'behaviorContracts')) as any[];
  rows[0].applications = [apply(catalogue.variant.address, '/0/entry'),
    apply(catalogue.constraints[0]!.address, '/0/success/0')];
  const cursor = { discoveryBasisCatalogue: catalogue,
    prerequisites: [{ ref: conceptRef, stage: 'concept', fields: { conceptSections: concept } }] };
  const classify = (value: unknown, delivered = cursor) => earlyResearchFailure(specification, specQuestion,
    'analyst', { action: 'answer', question: 'q', value, citations: answer.citations }, null, false, null,
    delivered.discoveryBasisCatalogue, deliveredConceptSections(delivered, specification));
  assert.equal(classify(rows), null);
  const missing = structuredClone(rows);
  missing[0].applications.pop();
  assert.equal(classify(missing)?.code, 'basis_application_missing');
  const foreign = structuredClone(rows);
  foreign[0].applications[0].basis.pointer = '/content/fields/verdict/outcome';
  assert.equal(classify(foreign)?.code, 'basis_application_invalid');
  assert.equal(deliveredConceptSections({ ...cursor, prerequisites: [{ ...cursor.prerequisites[0],
    ref: { ...conceptRef, id: 'stage:other:concept' } }] }, specification), null);
  assert.throws(() => earlyResearchFailure(specification, specQuestion, 'analyst',
    { action: 'answer', question: 'q', value: rows, citations: answer.citations }, null, false, null, catalogue, null),
  { code: 'basis_application_material_invalid' });
  assert.equal(earlyResearchFailure({ ...specification, contractVersion: 5 }, specQuestion, 'analyst',
    { action: 'answer', question: 'q', value: rows, citations: answer.citations }), null);
});

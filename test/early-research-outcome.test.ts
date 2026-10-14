import test from 'node:test';
import assert from 'node:assert/strict';
import { earlyResearchFailure, requireAssessmentReply } from '../src/discovery/early-research-outcome.js';
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

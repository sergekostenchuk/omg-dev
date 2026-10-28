import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { checkV7PlanCoverage, hasV7PlanCoverage, V7_PLAN_FIELD, V7_PLAN_SCHEMA, V7_AXES } from '../src/discovery/v7-contracts.js';
import { EngineError } from '../src/errors.js';
import { validFrame, validPlan, planQuestion } from './discovery-v7-fixture.js';
const ref = { id: 'research-answer:p:frame', revision: 1, hash: 'a'.repeat(64) };
const plan = () => validPlan(ref, V7_AXES.map(axis => planQuestion(`q-${axis}`, axis,
  ['rules', 'feasibility'].includes(axis) ? 'blocking' : 'supporting'))) as any;
const frame = () => validFrame() as any;
const invalid = (fn: () => void) => assert.throws(fn, (e: unknown) => e instanceof EngineError && e.code === 'answer_invalid');
const validate = new Ajv({ strict: true }).compile(V7_PLAN_SCHEMA as object);

test('A3 coverage: all twelve axes link real question IDs and meet the accepted depth', () => {
  const p = plan(), f = frame();
  assert.equal(validate(p), true); checkV7PlanCoverage(f, p);
  f.axes.language.depth = 'brief'; p.questions.find((q: any) => q.axis === 'language').requiredDepth = 'brief';
  checkV7PlanCoverage(f, p);
  p.questions.find((q: any) => q.axis === 'language').requiredDepth = 'deep'; checkV7PlanCoverage(f, p);
  assert.match(V7_PLAN_FIELD.prompt, /не выдавай запланированный поиск за выполненный/);
});

test('A3 coverage: concrete inapplicability is explicit and never overwrites an applicable frame axis', () => {
  const p = plan(), f = frame();
  const reason = 'The owner runs a local offline archive for personal use; no sales, invoices or payments belong to the mandate.';
  p.questions = p.questions.filter((q: any) => q.axis !== 'money'); p.coverage.money = { inapplicable: reason };
  invalid(() => checkV7PlanCoverage(f, p));
  f.axes.money = { depth: 'inapplicable', reason }; checkV7PlanCoverage(f, p);
  p.questions.push(planQuestion('unexpected-sales', 'money')); invalid(() => checkV7PlanCoverage(f, p));
});

test('A3 coverage: missing, disguised, duplicate, mixed-axis and shallow coverage refuse structurally', () => {
  const variants: Array<(p: any) => void> = [
    p => delete p.coverage, p => p.coverage = null, p => p.coverage = [],
    p => delete p.coverage.market, p => p.coverage.other = { questions: ['q-market'] },
    p => p.coverage.market = null, p => p.coverage.market = { questions: [] },
    p => p.coverage.market = { questions: ['missing'] }, p => p.coverage.market = { questions: ['q-industry'] },
    p => p.coverage.market = { questions: ['q-market', 'q-market'] },
    p => p.questions = p.questions.filter((q: any) => q.axis !== 'market'),
    p => p.questions[0].requiredDepth = 'brief', p => p.questions[0].requiredDepth = null,
    p => p.coverage.market = { questions: ['q-market'], inapplicable: 'excluded' },
    p => p.questions.push({ ...p.questions[0] }), p => p.questions[0].axis = 'unknown',
    p => p.questions = null,
  ];
  for (const mutate of variants) { const p = plan(); mutate(p); invalid(() => checkV7PlanCoverage(frame(), p)); }
  const f = frame(); f.axes.money = { depth: 'inapplicable', reason: 'Personal archive without financial operations' };
  for (const reason of ['', ' ', null, []]) {
    const p = plan(); p.questions = p.questions.filter((q: any) => q.axis !== 'money');
    p.coverage.money = { inapplicable: reason }; invalid(() => checkV7PlanCoverage(f, p));
  }
});

test('A3 coverage: the new issued schema requires coverage; historical issued schemas keep their era', () => {
  const legacy: any = structuredClone(V7_PLAN_FIELD);
  delete legacy.schema.properties.coverage; legacy.schema.required = legacy.schema.required.filter((x: string) => x !== 'coverage');
  assert.equal(hasV7PlanCoverage(legacy), false); assert.equal(hasV7PlanCoverage(V7_PLAN_FIELD), true);
  const p = plan(); delete p.coverage;
  assert.equal(validate(p), false); assert.equal(new Ajv({ strict: true }).compile(legacy.schema)(p), true);
});

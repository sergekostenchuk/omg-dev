import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
const recipe = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const request = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(request.protocol, 'omg-agent/v1');
const response = { protocol: request.protocol, requestId: request.requestId };
const implementation = {
  'produce.mjs': 'export const produce=n=>{if(!Number.isFinite(n))throw new Error("input_missing");return n+1};\n',
  'consume.mjs': 'import {produce} from "./produce.mjs";export const consume=n=>produce(n)*2;\n'
};
function bound(field, value, subject) {
  const context = subject.discoveryContext;
  if (field === 'researchReport') value.researchPlan = context.fields.researchPlan.answer;
  if (field === 'verdict') value.researchReport = context.fields.researchReport.answer;
  if (field === 'preparation' && context?.reportConstraints)
    value.constraints.push(...context.reportConstraints.map((row, index) => ({ id: `research-constraint-${index}`, rule: row.rule, basis: row.basis })));
  const catalogue = subject.discoveryBasisCatalogue;
  if (field === 'conceptSections' && catalogue)
    for (const [s, section] of value.entries()) for (const [r, requirement] of section.requirements.entries())
      requirement.applications = [catalogue.variant, ...catalogue.constraints].map(entry => ({ contract: 'basis-application/v1', basis: entry.address,
        appliedAt: [`/${s}/requirements/${r}/${entry === catalogue.variant ? 'statement' : 'acceptance/0'}`] }));
  if (field === 'behaviorContracts' && catalogue)
    for (const [i, contract] of value.entries()) contract.applications = [catalogue.variant, ...catalogue.constraints].map(entry => ({
      contract: 'basis-application/v1', basis: entry.address, appliedAt: [entry === catalogue.variant ? `/${i}/entry` : `/${i}/success/0`] }));
  return value;
}
if (request.mode === 'implement') {
  for (const file of request.subject.context.scope.code.filter(row => row.access === 'write')) {
    assert.ok(['produce.mjs', 'consume.mjs'].includes(file.path), `Unknown write ${file.path}`);
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, implementation[file.path]);
  }
  response.text = 'Implemented the recipe transformation';
  response.artifacts = request.subject.context.produces.map(id => ({ id }));
} else if (request.mode === 'review') {
  assert.ok(request.subject.context.binding.task);
  for (const file of request.subject.context.scope.code.filter(row => row.access === 'write')) {
    assert.ok(Object.hasOwn(implementation, file.path), `Unknown review ${file.path}`);
    assert.equal(readFileSync(file.path, 'utf8'), implementation[file.path], 'Review requires the declared implementation');
  }
  response.review = { verdict: 'pass', kind: 'none', findings: [] };
} else if (request.subject?.role) {
  const c = request.subject, question = c.question ?? c.questions?.[0];
  assert.ok(question?.field && Object.hasOwn(recipe.fields, question.field), `Unknown question: ${JSON.stringify(question)}`);
  const expected = bound(question.field, structuredClone(recipe.fields[question.field]), c);
  if (c.role === 'assess-answer') {
    assert.deepEqual(c.value, expected, 'Only the declared recipe proposal is supported');
    assert.ok(c.observations?.length, 'The assessor requires actual evidence');
    response.research = { verdict: 'supported', reasons: [] };
  } else {
    const inventory = c.inventory?.sources ?? c.originals?.sources ?? [];
    const sources = Array.isArray(inventory) ? inventory : inventory.rows.map(row => Object.fromEntries(inventory.columns.map((column, i) => [column, row[i]])));
    const source = sources.find(row => row.location === 'values');
    assert.ok(source, 'The recipe must be delivered as a real Source');
    response.research = { action: 'answer', question: question.id, value: expected,
      citations: [{ source: source.ref, selector: { kind: 'json-pointer', pointer: `/${question.field}` } }] };
  }
} else {
  response.confirmed = { model: null, effort: null, speed: null };
  const marker = '# Response form — machine section is one JSON line immediately after this header\n';
  const form = request.prompt.startsWith('{') ? JSON.parse(request.prompt) : JSON.parse(request.prompt.split(marker)[1].split('\n')[0]);
  assert.equal(form.responseForm.requestId, request.requestId);
  const reply = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const labels = form.labels ?? [];
  for (const fill of reply.proposal?.fills ?? [])
    assert.ok(labels.some(row => row.domain === 'slot' && row.label === fill.obligation), 'Reply must use an issued slot label');
  response.research = { ...reply, protocol: form.responseForm.protocol, requestId: request.requestId };
}
response.usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningOutputTokens: 0 };
process.stdout.write(JSON.stringify(response));

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { stageId, type Ref } from '../src/pipeline/contracts.js';
import { preparationMatches, selectSpecification, SELECTED_SPECIFICATION_CONTRACT,
  type AcceptedStageFields, type SelectedSpecificationRequest } from '../src/om/selected-specification.js';
import { preparedField } from './preparation-fixture.js';

const project = 'p';
const ref = (stage: 'specification' | 'features', revision = 1, owner = project): Ref =>
  ({ id: stageId(owner, stage), revision, hash: hashJson({ owner, stage, revision }) });
const contract = (preparedField(project, 'behaviorContracts') as Json[])[0] as Record<string, Json>;
const preparation = (preparedField(project, 'featurePreparation') as Json[])[0] as Record<string, Json>;
// The selected elements stand at index 1 of their source arrays, behind an unrelated neighbour.
const other = { ...contract, id: 'p-B0', requirements: ['p-R0'], entry: 'Another entry', compatibility: 'Another compatibility' };
const otherPrep = { ...preparation, featureTitle: 'Other feature', behaviorContracts: ['p-B0'], benefit: 'Another benefit' };
function accepted(): AcceptedStageFields[] {
  return [
    { stage: 'specification', ref: ref('specification'), fields: { behavior: ['behavior for p'], constraints: ['Local only', 'No network'],
      behaviorContracts: [other, contract] as Json } },
    { stage: 'features', ref: ref('features'), fields: { features: [{ title: 'Other feature', outcome: 'p-result', requirements: [0] },
      { title: 'Deliver result', outcome: 'p-result', requirements: [0] }], featurePreparation: [otherPrep, preparation] as Json } },
  ];
}
function request(overrides: Partial<SelectedSpecificationRequest> = {}): SelectedSpecificationRequest {
  return { project, sources: [{ ...ref('specification'), stage: 'specification' }, { ...ref('features'), stage: 'features' }],
    accepted: accepted(), contracts: ['p-B1'], features: [{ index: 1, title: 'Deliver result', outcome: 'p-result' }], ...overrides };
}
const refusal = (code: string, target: string, field: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code
  && (error.details as { target: string }).target === target && (error.details as { field: string }).field === field;

test('SP1a selection: the full accepted contract, preparation and every constraint with exact Ref, source index and pointer; an unrelated contract is not added', () => {
  const selected = selectSpecification(request());
  assert.equal(selected.contract, SELECTED_SPECIFICATION_CONTRACT);
  assert.deepEqual(selected.contracts, [{ source: ref('specification'), index: 1, pointer: '/content/fields/behaviorContracts/1', value: contract }]);
  for (const field of ['entry', 'inputs', 'compatibility', 'success', 'failures', 'forbiddenEffects', 'state', 'proof'])
    assert.deepEqual((selected.contracts[0]!.value as Record<string, Json>)[field], contract[field], `The original ${field} is delivered`);
  assert.deepEqual(selected.preparations, [{ source: ref('features'), index: 1, pointer: '/content/fields/featurePreparation/1', featureIndex: 1, value: preparation }]);
  for (const field of ['beneficiary', 'benefit', 'success', 'failures', 'interactions'])
    assert.deepEqual((selected.preparations[0]!.value as Record<string, Json>)[field], preparation[field], `The original ${field} is delivered`);
  assert.deepEqual(selected.constraints, { source: ref('specification'), pointer: '/content/fields/constraints', value: ['Local only', 'No network'] });
  assert.ok(!canonical(selected).includes('Another entry'), 'The neighbour contract is not part of the selection');
  assert.ok(!canonical(selected).includes('Another benefit'), 'The neighbour preparation is not part of the selection');
});

test('SP1a selection is pure and deterministic: no input is changed, duplicates select once, an empty constraint list stays explicit', () => {
  const input = request({ contracts: ['p-B1', 'p-B0', 'p-B1'] }), before = canonical(input);
  const first = selectSpecification(input), second = selectSpecification(request({ contracts: ['p-B0', 'p-B1'] }));
  assert.equal(canonical(input), before);
  assert.deepEqual(first, second);
  assert.deepEqual(first.contracts.map(row => row.index), [0, 1], 'Source order, each once');
  const empty = accepted(); empty[0]!.fields.constraints = [];
  assert.deepEqual(selectSpecification(request({ accepted: empty })).constraints.value, []);
});

test('SP1a preparationMatches is the B1 rule: every featureTitle+outcome match in source order, nothing by a similar title', () => {
  const rows = [preparation, { ...preparation, featureTitle: 'Deliver result ' }, 'not a row', { ...preparation, benefit: 'twin' }];
  assert.deepEqual(preparationMatches(rows, { title: 'Deliver result', outcome: 'p-result' }).map(row => row.index), [0, 3]);
  assert.deepEqual(preparationMatches(rows, { title: 'Deliver result', outcome: 'other' }), []);
});

test('SP1a selection refuses an ambiguous or missing preparation at its address — no silent skip', () => {
  const twin = accepted(); (twin[1]!.fields.featurePreparation as Json[]).push({ ...preparation, benefit: 'twin' });
  assert.throws(() => selectSpecification(request({ accepted: twin })),
    refusal('selected_specification_unresolved', 'features[1]', '/content/fields/featurePreparation'));
  assert.throws(() => selectSpecification(request({ features: [{ index: 1, title: 'Deliver result', outcome: 'elsewhere' }] })),
    refusal('selected_specification_unresolved', 'features[1]', '/content/fields/featurePreparation'));
});

test('SP1a selection refuses a missing or duplicated original contract at its address', () => {
  assert.throws(() => selectSpecification(request({ contracts: ['p-B9'] })),
    refusal('selected_specification_unresolved', 'p-B9', '/content/fields/behaviorContracts'));
  const twin = accepted(); (twin[0]!.fields.behaviorContracts as Json[]).push({ ...contract, entry: 'twin' });
  assert.throws(() => selectSpecification(request({ accepted: twin })),
    refusal('selected_specification_unresolved', 'p-B1', '/content/fields/behaviorContracts'));
});

test('SP1a selection accepts only the exact basis of its input: another project, another revision, a missing stage or list is refused', () => {
  const foreign = request({ sources: [{ ...ref('specification', 1, 'q'), stage: 'specification' }, { ...ref('features'), stage: 'features' }] });
  assert.throws(() => selectSpecification(foreign), refusal('selected_specification_basis_invalid', stageId(project, 'specification'), 'sources'));
  const updated = accepted(); updated[0]!.ref = ref('specification', 2);
  assert.throws(() => selectSpecification(request({ accepted: updated })),
    refusal('selected_specification_basis_invalid', stageId(project, 'specification'), 'accepted'));
  assert.throws(() => selectSpecification(request({ accepted: accepted().filter(row => row.stage !== 'features') })),
    refusal('selected_specification_basis_invalid', stageId(project, 'features'), 'accepted'));
  for (const [stage, field] of [[0, 'behaviorContracts'], [0, 'constraints'], [1, 'featurePreparation']] as const) {
    const missing = accepted(); delete missing[stage]!.fields[field];
    assert.throws(() => selectSpecification(request({ accepted: missing })),
      refusal('selected_specification_basis_invalid', missing[stage]!.ref.id, `/content/fields/${field}`));
  }
});

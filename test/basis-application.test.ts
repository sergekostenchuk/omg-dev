import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { BASIS_APPLICATION_CONTRACT, resolveBasisApplications, type BasisAddress,
  type BasisApplication, type BasisApplicationRequest } from '../src/discovery/basis-application.js';

const source = { id: 'stage:p:discovery', revision: 3, hash: hashJson('accepted Discovery') };
const constraint: BasisAddress = { record: source, pointer: '/content/fields/preparation/constraints/0' };
const variant: BasisAddress = { record: source, pointer: '/content/fields/verdict/variant' };
const link = (basis = constraint, appliedAt = ['/0/requirements/0/statement']): BasisApplication =>
  ({ contract: BASIS_APPLICATION_CONTRACT, basis, appliedAt });
function fixture(): BasisApplicationRequest {
  return structuredClone({ field: 'conceptSections',
    value: [{ id: 's', requirements: [
      { id: 'r0', statement: 'Use the chosen interface', benefit: 'Simple use', acceptance: ['One chosen provider'], applications: [link()] },
      { id: 'r1', statement: 'Independent intent', benefit: 'Another result', acceptance: ['Visible result'], applications: [] },
    ] }],
    catalogue: [{ address: constraint, value: { id: 'single-provider', rule: 'One provider', basis: 'owner intent' } },
      { address: variant, value: 'Subscription with a separate API connection' }],
    owners: [0, 1].map(i => ({ pointer: `/0/requirements/${i}`, fields: ['statement', 'benefit', 'acceptance'], required: [] })),
    required: [constraint],
  });
}
const row = (r: BasisApplicationRequest, index = 0): Record<string, any> => (r.value as any)[0].requirements[index];
function refused(r: BasisApplicationRequest, code: string, pointer?: string) {
  assert.throws(() => resolveBasisApplications(r), error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, code);
    const details = error.details as { field: string; pointer: string };
    assert.equal(details.field, r.field || 'applications');
    assert.equal(typeof details.pointer, 'string');
    if (pointer !== undefined) assert.equal(details.pointer, pointer);
    return true;
  });
}

test('DS1.2 F resolves exact allowed bases and own targets; coverage is a union and unassigned owners may be empty', () => {
  const r = fixture(); r.required = [constraint, variant];
  row(r, 1).applications.push(link(variant, ['/0/requirements/1/benefit']));
  const resolved = resolveBasisApplications(r);
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved[0]!.basis, r.catalogue[0]);
  assert.deepEqual(resolved[0]!.targets, [{ pointer: '/0/requirements/0/statement', value: 'Use the chosen interface' }]);
  assert.equal(resolved[1]!.owner, '/0/requirements/1');
  (resolved[0]!.basis.value as any).rule = 'Changed copy';
  resolved[0]!.application.appliedAt.push('/foreign');
  assert.equal((r.catalogue[0]!.value as any).rule, 'One provider');
  assert.deepEqual(row(r).applications[0].appliedAt, ['/0/requirements/0/statement']);
  assert.equal(resolveBasisApplications(fixture()).length, 1);
});

test('DS1.2 F distinguishes existence from truthiness, decodes escaped keys once and rejects inherited/array metadata', () => {
  const r = fixture();
  row(r)['benefit'] = { 'a/b~c': [false, 0, null, []], '~1': 'literal tilde-one' };
  row(r).applications[0].appliedAt = [0, 1, 2, 3].map(i => `/0/requirements/0/benefit/a~1b~0c/${i}`);
  row(r).applications[0].appliedAt.push('/0/requirements/0/benefit/~01');
  assert.deepEqual(resolveBasisApplications(r)[0]!.targets.map(x => x.value), [false, 0, null, [], 'literal tilde-one']);
  for (const target of ['/0/requirements/0/benefit/toString', '/0/requirements/0/benefit/a~1b~0c/length',
    '/0/requirements/0/benefit/a~1b~0c/01', '/0/requirements/0/benefit/a~1b~0c/4']) {
    row(r).applications[0].appliedAt = [target]; refused(r, 'basis_application_invalid', target);
  }
});

for (const target of ['', '/0/requirements/0', '/0/requirements/0/id', '/0/requirements/0/applications/0',
  '/0/requirements/0/applications/0/basis', '/0/requirements/1/statement', '/0/requirements/00/statement',
  '/0/requirements/0/statement/missing', '/0/requirements/0/acceptance/9', '/0/requirements/0/benefit/~2',
  '/0/requirements/0/benefit/~', '#/0/requirements/0/statement']) {
  test(`DS1.2 F refuses non-substantive, foreign or unresolved target ${JSON.stringify(target)}`, () => {
    const r = fixture(); row(r).applications[0].appliedAt = [target]; refused(r, 'basis_application_invalid');
  });
}

test('DS1.2 F owner boundaries are decoded segments, never string prefixes', () => {
  const r = fixture(); const values = (r.value as any)[0].requirements;
  while (values.length < 11) values.push({ id: `r${values.length}`, statement: 'Another owner', applications: [] });
  row(r, 1).applications = [link(constraint, ['/0/requirements/10/statement'])];
  refused(r, 'basis_application_invalid', '/0/requirements/10/statement');
});

test('DS1.2 F rejects a lawful foreign Ref, different revision/hash, and incorrect source escapes outside its catalogue', () => {
  for (const basis of [
    { ...constraint, record: { ...source, id: 'stage:other:discovery' } },
    { ...constraint, record: { ...source, revision: 4 } },
    { ...constraint, record: { ...source, hash: hashJson('another snapshot') } },
    { ...constraint, pointer: '/content/fields/preparation/constraints/1' },
    { ...constraint, pointer: '/bad~2' },
  ]) { const r = fixture(); row(r).applications[0].basis = basis; refused(r, 'basis_application_invalid'); }
  const r = fixture(), escaped = { record: source, pointer: '/a~1b/~01' };
  r.catalogue = [{ address: escaped, value: false }]; r.required = [escaped];
  row(r).applications[0].basis = escaped;
  assert.equal(resolveBasisApplications(r)[0]!.basis.value, false);
});

test('DS1.2 F checks inherited obligations for each owner as well as the stage union', () => {
  const r = fixture();
  r.owners = r.owners.map((owner, i) => ({ ...owner, required: i === 1 ? [constraint] : [] }));
  refused(r, 'basis_application_missing', '/0/requirements/1/applications');
  row(r, 1).applications = [link(constraint, ['/0/requirements/1/statement'])];
  assert.equal(resolveBasisApplications(r).length, 2);
  r.required = [constraint, variant]; refused(r, 'basis_application_missing', '');
});

for (const change of ['absent', 'null', 'object', 'missing-contract', 'old-contract', 'missing-basis', 'empty-targets', 'missing-targets', 'extra-key'] as const) {
  test(`DS1.2 F addresses malformed model applications: ${change}`, () => {
    const r = fixture(), owner = row(r);
    if (change === 'absent') delete owner.applications;
    else if (change === 'null') owner.applications = null;
    else if (change === 'object') owner.applications = {};
    else if (change === 'missing-contract') delete owner.applications[0].contract;
    else if (change === 'old-contract') owner.applications[0].contract = 'basis-application/v0';
    else if (change === 'missing-basis') delete owner.applications[0].basis;
    else if (change === 'empty-targets') owner.applications[0].appliedAt = [];
    else if (change === 'missing-targets') delete owner.applications[0].appliedAt;
    else owner.applications[0].unrelated = true;
    refused(r, 'basis_application_invalid');
  });
}

test('DS1.2 F distinguishes missing or inconsistent delivered material from a bad model proposal', () => {
  const mutations: ((r: any) => void)[] = [
    r => { delete r.catalogue; }, r => { delete r.owners; }, r => { delete r.required; },
    r => { r.catalogue = null; }, r => { delete r.catalogue[0].value; },
    r => { r.catalogue[0].address.pointer = '/bad~3'; }, r => { r.catalogue.push(r.catalogue[0]); },
    r => { r.required = [{ ...variant, record: { ...source, revision: 99 } }]; },
    r => { r.owners[0].fields = ['applications']; }, r => { delete r.owners[0].required; },
    r => { r.owners.push(r.owners[0]); },
  ];
  for (const mutate of mutations) { const r = fixture(); mutate(r); refused(r, 'basis_application_material_invalid'); }
});

test('DS1.2 F consumers select contract fields explicitly; no semantic comparison or I/O is inferred', () => {
  const r: BasisApplicationRequest = { field: 'behaviorContracts', value: [{ id: 'bc',
    state: { authority: 'Forbidden authority' }, proof: 'A proposed check',
    applications: [link(constraint, ['/0/state/authority', '/0/proof'])] }],
    catalogue: [{ address: constraint, value: 'Only the chosen authority is allowed' }],
    required: [constraint], owners: [{ pointer: '/0', fields: ['state', 'proof'], required: [constraint] }],
  };
  const result = resolveBasisApplications(r);
  assert.equal(result[0]!.targets[0]!.value, 'Forbidden authority');
  assert.equal(result[0]!.basis.value, 'Only the chosen authority is allowed');
  const empty: BasisApplicationRequest = { field: 'conceptSections', value: [] as Json[], catalogue: [], owners: [], required: [] };
  assert.deepEqual(resolveBasisApplications(empty), []);
});

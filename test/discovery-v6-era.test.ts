import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, hashJson } from '../src/canonical.js';
import { RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, VERSION5_REQUIREMENTS, VERSION6_REQUIREMENTS, VERSION6_ANALOGUES_REQUIREMENTS, selectResearchRequirements } from '../src/discovery/requirements.js';
import { VERSION6_UPSTREAM_DETAILS } from '../src/discovery/preparation-contracts.js';
import { inputResearchRequirements } from '../src/om/input.js';
import { stageResearchContract } from '../src/product/stage-checks.js';

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

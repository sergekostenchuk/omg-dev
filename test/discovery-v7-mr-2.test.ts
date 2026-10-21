import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceSites } from '../src/storage/reference-sites.js';

// A pure registry specimen, not a persisted or paid assessment. Each optional
// branch is represented so fsck's shared enumeration sees every service edge.
const paths = [
  'subject.packet.planAnswer', 'subject.packet.question',
  'subject.packet.entries.0.attempt', 'subject.packet.entries.0.binding',
  'baseline.state.ref', 'baseline.materials.0.container', 'session', 'application', 'environment',
  'return.target.attempt', 'return.target.claim.container',
  'novelty.attempts.0.attempt', 'novelty.noProgress.0.attempt',
  'novelty.accepted.0.claim.container', 'novelty.rejected.0.claim.container',
  'novelty.newContent.0.claim.container', 'novelty.duplicates.0.claim.container', 'novelty.duplicates.0.of.container',
  'novelty.transition.bases.0.claim.container', 'novelty.transition.bases.0.constraint',
  'novelty.transition.sufficiency.methodologyRequirements.0.claim.container',
  'methodology.facts.0.claim.container', 'methodology.facts.0.sources.0.source', 'methodology.facts.0.sources.0.original',
  'methodology.facts.0.sources.0.evidence.0.source', 'methodology.facts.0.sources.0.publicationDate.evidence.0.source',
  'methodology.facts.0.sources.0.eventDate.evidence.0.source', 'methodology.facts.0.sources.0.version.evidence.0.source',
  'methodology.facts.0.temporalApplicability.evidence.0.source', 'methodology.facts.0.corroboration.sources.0',
  'methodology.facts.0.refutation.traces.0.turn', 'methodology.facts.0.refutation.traces.0.capture',
  'methodology.facts.0.refutation.counterarguments.0.source',
];
const ref = (id: string) => ({id, revision:1, hash:'a'.repeat(64)});
const shown = (path: string) => path.replace(/\.(\d+)/g, '[$1]');
function specimen() {
  const value: Record<string, any> = {contract:'discovery-assessment/v3'};
  for (const path of paths) {
    const keys=path.split('.');let node=value;
    keys.slice(0,-1).forEach((key,i)=>node=node[key]??=(/^\d+$/.test(keys[i+1]!)?[]:{}));
    node[keys.at(-1)!]=ref(path);
  }
  return value;
}

test('MR.2: every v3 service reference including closing requirements is enumerated exactly once', () => {
  const value=specimen(),before=JSON.stringify(value);
  assert.deepEqual(referenceSites('discovery-assessment',value).sort((a,b)=>a.field.localeCompare(b.field)),
    paths.map(path=>({field:shown(path),ref:ref(path)})).sort((a,b)=>a.field.localeCompare(b.field)));
  assert.equal(JSON.stringify(value),before);
  const requirements=value.novelty.transition.sufficiency.methodologyRequirements;
  requirements.push({claim:{container:ref('second-requirement')}});
  assert.deepEqual(referenceSites('discovery-assessment',value).find(site=>site.field.endsWith('methodologyRequirements[1].claim.container'))?.ref,
    ref('second-requirement'));
});

test('MR.2: Ref-shaped JSON data is not a service reference of a v3 record', () => {
  const value=specimen(),data=ref('model-data');
  value.value={payload:data};value.metadata=data;
  value.novelty.transition.sufficiency.modelData={nested:data};
  value.methodology.facts[0].sources[0].publicationDate.value=data;
  value.methodology.facts[0].refutation.limitations=[{nested:data}];
  assert.equal(referenceSites('discovery-assessment',value).length,paths.length);
  assert.ok(referenceSites('discovery-assessment',value).every(site=>site.ref.id!=='model-data'));
});

test('MR.2: adding v3 does not reinterpret the old v2 reference contract', () => {
  const value=specimen();value.contract='discovery-assessment/v2';
  const v2=referenceSites('discovery-assessment',value);
  assert.deepEqual(v2.map(site=>site.field).sort(),paths.filter(path=>!path.includes('methodologyRequirements')).map(shown).sort());
  assert.ok(v2.every(site=>!site.field.includes('methodologyRequirements')));
});

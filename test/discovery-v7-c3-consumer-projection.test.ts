import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, type Json } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { readAcceptedDiscoveryProjectionAt } from '../src/discovery/discovery-accepted-projection.js';
import { readDiscoveryConsumerProjectionAt, consumerPreparationFields, adaptDiscoveryConsumerProjection, type DiscoveryConsumerProjection } from '../src/discovery/discovery-consumer-projection.js';
import { acceptedDiscoveryBasisCatalogue } from '../src/discovery/discovery-handoff.js';
import { conceptApplicationFindings, specificationApplicationFindings, preparationFindings } from '../src/discovery/preparation-validation.js';
import { buildL1, designOf } from '../src/graph/builder.js';
import { buildOmInput, buildOmInputFromDiscovery, type InputStages } from '../src/om/input.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { acceptDiscoveryFinal, resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { proveClaimAddress } from '../src/discovery/claim-address.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { CONDITION_EVIDENCE_RESULT, prepareConditionEvidenceSubject } from '../src/discovery/discovery-condition-evidence-subject.js';
import { prepareConditionEvidenceSession } from '../src/discovery/discovery-condition-evidence-session.js';
import { runConditionEvidenceExecution } from '../src/discovery/discovery-condition-evidence-execution.js';
import { acceptedAssessmentPaid, finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { preparedField } from './preparation-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { storeUnchanged } from './store-unchanged.js';

function fixtureValue(field: string): Json {
  return JSON.parse(JSON.stringify(preparedField('p', field)).replaceAll('p-user', 'operator').replaceAll('p-result', 'record'));
}
async function world(t: test.TestContext) {
  // The accepted paid v9 product is a precondition here, so it is copied from the run's catalog (layer `accepted`), not accepted again.
  const f = await acceptedAssessmentPaid(t, { form: V9_FINAL_CONTRACT });
  return { f, at: f.data.accepted.manifest };
}

test('C3: paid accepted v9 drives the existing L1 builder without changing actor, outcome or journey identities', async t => {
  const { f, at } = await world(t), wire = canonical(f.wires());
  await storeUnchanged(f.store, async () => {
    const source = await readAcceptedDiscoveryProjectionAt(f.store, 'p', at);
    const h = await readDiscoveryConsumerProjectionAt(f.store, 'p', at, 'operation-map');
    const sections = fixtureValue('conceptSections');
    const base = JSON.parse(JSON.stringify(exampleGraph('p')).replaceAll('p-result', 'record'));
    const designed = enrichedGraph(base, 'p', h.preparation as unknown as Json, sections);
    designed.horizon = [];
    // This explicit design covers the payer too; the adapter must not invent a journey for it.
    designed.nodes = designed.nodes.filter(node => !node.id.includes('-refusal-'));
    designed.artifacts = designed.artifacts.filter(artifact => artifact.id !== 'p-refusal');
    designed.edges = [];
    designed.journeys!.push({ ...designed.journeys![0]!, id: 'payer-observes-record', actor: 'company' });
    const graph = buildL1('p-map', 'Ledger', designOf(designed), consumerPreparationFields(h), { conceptSections: sections });
    assert.deepEqual(graph.actors, h.preparation.actors.map(({ id, role, channels }) => ({ id, role, channels })));
    assert.ok(graph.artifacts.some(a => a.id === 'record'));
    assert.ok(graph.journeys!.some(j => j.actor === 'operator' && j.outcome === 'record' && j.terminal === 'success'));
    assert.deepEqual(h.preparation.journeys, (source.projection.value as any).journeys);
    assert.deepEqual(h.material.externalSystems.value, (source.projection.value as any).externalSystems);
    assert.equal(h.preparation.externalSystems[0]!.availability, 'Documented in the dossier');
    assert.notEqual(h.preparation.externalSystems[0]!.availability, 'available');
    assert.deepEqual(h.material.constraints.value, (source.projection.value as any).constraints);
    assert.deepEqual(h.material.claims, source.claims);
    assert.deepEqual(h.material.summary, source.summary); assert.deepEqual(h.material.constitution, source.constitution);
  });
  assert.equal(canonical(f.wires()), wire);
});

test('C3: specification applies actual bundle/member grounds and features consume first-release material without choosing feature composition', async t => {
  const { f, at } = await world(t);
  await storeUnchanged(f.store, async () => {
    const source = await readAcceptedDiscoveryProjectionAt(f.store, 'p', at), catalogue = acceptedDiscoveryBasisCatalogue(source);
    const h = await readDiscoveryConsumerProjectionAt(f.store, 'p', at, 'specification');
    assert.equal(catalogue.contract, 'discovery-basis-catalogue/v2'); assert.deepEqual(catalogue.source, at);
    assert.deepEqual(catalogue.constraints[0]!.address, { record: source.bundle, pointer: '/bundle/projection/constraints/0' });
    const sections = fixtureValue('conceptSections') as any[];
    const grounds = [catalogue.variant, ...catalogue.constraints];
    sections[0].requirements[0].applications = grounds.map(entry => ({ contract: 'basis-application/v1', basis: entry.address, appliedAt: ['/0/requirements/0/statement'] }));
    assert.deepEqual(conceptApplicationFindings(sections, catalogue), []);
    const behavior = fixtureValue('behaviorContracts') as any[];
    behavior[0].applications = grounds.map(entry => ({ contract: 'basis-application/v1', basis: entry.address, appliedAt: ['/0/entry'] }));
    assert.deepEqual(specificationApplicationFindings(behavior, sections, catalogue), []);
    const forged = structuredClone(behavior); forged[0].applications[0].basis.record = source.manifest;
    assert.ok(specificationApplicationFindings(forged, sections, catalogue).length);
    const fields = { behaviorContracts: behavior, behavior: fixtureValue('behavior') };
    const upstream = (stage: string) => stage === 'discovery' ? consumerPreparationFields(h) : stage === 'concept' ? { conceptSections: sections } : fields;
    assert.deepEqual(preparationFindings('specification', fields, upstream, ['record']), []);
    const features = { features: fixtureValue('features'), featurePreparation: fixtureValue('featurePreparation') };
    assert.deepEqual(preparationFindings('features', features, upstream, ['record']), []);
    const release = await readDiscoveryConsumerProjectionAt(f.store, 'p', at, 'features');
    assert.deepEqual(release.material.summary.value, source.summary.value);
    assert.deepEqual(release.material.selectedVariant, source.selectedVariant);
    assert.equal('features' in release, false);
  });
});

// Explicit inputs of the existing pure builder; these do not impersonate accepted pipeline stages.
function omBuilderInputs(source: DiscoveryConsumerProjection): InputStages {
  const rows = Object.fromEntries(['discovery','concept','operation-map','specification','features'].map(stage => [stage,
    { ref: { id: `stage:p:${stage}`, revision: 1, hash: 'a'.repeat(64) }, contractVersion: 6, fields: {} }])) as InputStages;
  rows.concept.fields = { conceptSections: fixtureValue('conceptSections'), acceptance: ['Accept'] };
  const base = JSON.parse(JSON.stringify(exampleGraph('p')).replaceAll('p-result', 'record'));
  rows['operation-map'].fields = { mapDesign: designOf(enrichedGraph(base, 'p', source.preparation as unknown as Json, rows.concept.fields.conceptSections!)) as Json };
  rows.specification.fields = { behavior: fixtureValue('behavior'), behaviorContracts: fixtureValue('behaviorContracts') };
  rows.features.fields = { features: fixtureValue('features'), featurePreparation: fixtureValue('featurePreparation') };
  return rows;
}

test('C3: the existing OM builder consumes accepted material read from a cold Store and preserves exact Discovery source', async t => {
  const { f, at } = await world(t), cold = f.open();
  const source = await readDiscoveryConsumerProjectionAt(cold, 'p', at, 'om-g2'), rows = omBuilderInputs(source);
  for (const discovery of [null, {}, { ...source, material: { unknowns: [null] } }])
    assert.throws(() => buildOmInput(rows, { discovery } as any), (error: any) => error.code === 'input_request_invalid');
  const result = await storeUnchanged(cold, () => buildOmInputFromDiscovery(cold, 'p', at, rows));
  assert.deepEqual(result.refusals, []); assert.ok(result.input);
  assert.deepEqual(result.input.discovery!.manifest, at);
  assert.deepEqual(result.input.discovery!.bundle, source.bundle);
  assert.deepEqual(result.input.discovery!.unknowns, source.material.unknowns);
  assert.ok(result.input.contracts.some(c => c.outcome === 'record'));
});

test('C3: an unknown risk outcome is an addressed D7 refusal and textual unknowns keep their IDs and origins', async t => {
  const { f, at } = await world(t), source = await readAcceptedDiscoveryProjectionAt(f.store, 'p', at);
  // A pure adapter counterexample; this does not claim this changed candidate passed paid acceptance.
  const candidate = structuredClone(source), p = candidate.projection.value as any;
  p.unknowns = [{ id: 'volume', origin: { condition: 'measure' }, question: 'What volume?', affects: ['record'], consumer: 'om-g2', blocksCurrentStage: false, moment: 'task-start', closeCriterion: 'A measurement' }];
  p.externalSystems[0].availability.basis = { unknown: 'volume' }; p.risks[0].mitigation = { unknown: 'volume' };
  const h = adaptDiscoveryConsumerProjection(candidate, 'om-g2');
  assert.equal(h.preparation.externalSystems[0]!.availability, 'unknown:volume');
  assert.equal(h.preparation.risks[0]!.mitigation, 'unknown:volume');
  assert.deepEqual(h.material.unknowns[0]!.origin, p.unknowns[0].origin);
  assert.deepEqual(h.material.unknowns[0]!.source, { record: source.bundle, pointer: '/bundle/projection/unknowns/0' });
  p.risks[0].affectedOutcome = { unknown: 'volume' };
  assert.throws(() => adaptDiscoveryConsumerProjection(candidate, 'operation-map'), (error: any) =>
    error.code === 'discovery_consumer_risk_outcome_unresolved' && error.details.riskId === 'lag' && error.details.return.destination === 'D7');
});


test('C3: real paid evidence releases the conditional edition while the OM builder keeps every ND-02 field and origin', async t => {
  const f = await finalAssessmentPaid(t, { form: V9_FINAL_CONTRACT, outcome: 'conditional' });
  modeOf(f.store, 'bypass');
  const accepted = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Accept the conditional final' });
  assert.ok(accepted.accepted);
  const first = reference(accepted.accepted.manifest);
  const claim = f.packet.final.dossier.materials.map(item => item.address).find(address => {
    try { proveClaimAddress(f.store, address); return true; } catch { return false; }
  });
  assert.ok(claim, 'the evidence assessor receives a real accepted claim');
  f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Measure this evidence reviewer' }, citations: [] });
  await researchCall(f.environment.value.reviewer, f.environment.value, 'Measure the C3 evidence reviewer', {}, undefined,
    { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  const packet = prepareConditionEvidenceSubject(f.store, 'p', { manifest: first, conditionId: 'evidence-1', claims: [claim] });
  const prepared = prepareConditionEvidenceSession(f.store, 'p', packet.subject, { prompt: 'Assess the condition against this material',
    packetChars: 8_000_000, limitChars: 9_000_000, resultLimitChars: 10_000_000, environment: reference(f.environment), role: f.environment.value.reviewer });
  f.reply({ contract: CONDITION_EVIDENCE_RESULT, subject: packet.subject, verdict: 'supported',
    reasons: ['The saved material supports the condition'], bases: [{ claim }, { criterion: true }], return: null });
  const paid = await runConditionEvidenceExecution(f.store, 'p', first, reference(prepared), { profile: f.profile });
  assert.ok(paid.output && paid.result);
  const resolved = await resolveDiscoveryCondition(f.store, { projectId: 'p', manifest: first, conditionId: 'evidence-1',
    evidence: reference(paid.output), reason: 'Use the independently assessed evidence' });
  assert.ok(resolved.resolved && resolved.edition);
  const edition = reference(resolved.edition.manifest), cold = f.open(), wire = canonical(f.wires());
  await storeUnchanged(cold, async () => {
    await assert.rejects(readDiscoveryConsumerProjectionAt(cold, 'p', first, 'om-g2'), (e: any) => e.code === 'discovery_projection_conditions_open');
    const acceptedSource = await readAcceptedDiscoveryProjectionAt(cold, 'p', edition);
    assert.deepEqual(acceptedSource.conditions, { resolved: ['evidence-1'], open: [] });
    const expected = (acceptedSource.projection.value as any).unknowns;
    assert.equal(expected.length, 1); assert.deepEqual(expected[0].origin, { condition: 'evidence-1' });
    for (const consumer of ['operation-map', 'specification', 'features', 'om-g2'] as const) {
      const h = await readDiscoveryConsumerProjectionAt(cold, 'p', edition, consumer);
      assert.deepEqual(h.material.unknowns.map(({ source: _source, ...value }) => value), expected);
      assert.deepEqual(h.material.unknowns[0]!.source, { record: acceptedSource.bundle, pointer: '/bundle/projection/unknowns/0' });
      assert.equal(h.preparation.risks[0]!.mitigation, 'unknown:demand');
    }
    const h = await readDiscoveryConsumerProjectionAt(cold, 'p', edition, 'om-g2');
    const result = await buildOmInputFromDiscovery(cold, 'p', edition, omBuilderInputs(h));
    assert.deepEqual(result.refusals, []); assert.ok(result.input);
    assert.deepEqual(result.input.discovery!.unknowns, h.material.unknowns);
    const question = result.input.questions.find(item => item.id === 'discovery:demand');
    assert.ok(question);
    assert.deepEqual(question, { id: 'discovery:demand', question: expected[0].question, consumer: expected[0].consumer,
      kind: null, blocks: expected[0].blocksCurrentStage, source: acceptedSource.bundle,
      sourcePointer: '/bundle/projection/unknowns/0', origin: expected[0].origin, affects: expected[0].affects,
      closeCriterion: expected[0].closeCriterion, moment: expected[0].moment });
  });
  assert.equal(canonical(f.wires()), wire);
});

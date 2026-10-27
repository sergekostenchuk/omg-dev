import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { runDossierAssessmentSession } from '../src/discovery/assessment-session.js';
import { VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { readRunnerDossierAssessmentAt } from '../src/discovery/dossier-assessment-runner.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier, produceStoppedPartialDossier } from '../src/discovery/dossier-manifest.js';
import { produceDeepFrontierStop, publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { completed, paid, fixedPoint, unchanged, revise, deep, assess, claim, type Paid } from './discovery-v7-dossier-seed.js';

function wideDelivery(f: Paid) {
  const role = f.environment.value.reviewer;
  return configureReaderPilot(f.store, f.engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'dossier-reader', model: role.model, effort: role.effort, command: role.command, speed: 'inherited' },
    agentCommand: role.command, maxRequestChars: 3000000, maxReadChars: 128000, maxReplyChars: 100000,
    maxCalls: 100, maxReportedTokens: 100000,
    physicalLimits: { maxRequestChars: 3000000, maxReplyChars: 100000, basis: 'Full local dossier delivery' } }, 0);
}

function reply(packet: DossierAssessmentPacket, verdict: 'supported' | 'return'): DossierAssessmentResult {
  const bases = [{ record: packet.manifest.ref }];
  return { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: packet.subject, verdict, reasons: ['Exact paid D6 boundary'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(key => [key, { judgement: 'adequate', reason: key, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(row => row.address), unknowns: packet.unknowns.map(row => row.unknown.claim),
      contradictions: packet.contradictions.map(row => ({ id: row.contradiction.id,
        sides: [row.sides[0].address, row.sides[1].address], grounds: row.grounds.map(record => record.ref) })) },
    return: verdict === 'return' ? { targets: packet.subject.root.kind === 'partial' ? [{ partialReason: 0 }] : [{ axis: 'market' }],
      reason: 'Collect the missing exact basis', bases } : null };
}
for (const route of ['owner', 'model'] as const) test(`${route} selected D6 reaches a paid supported assessment through Researcher.run`, async t => {
  const f = await completed(t, route);
  const selected = produceSelectedDossier(f.store, 'p', f.input);
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', reference(selected.record));
  wideDelivery(f);
  f.reply(reply(packet, 'supported'));
  const run = await new Researcher(f.store, f.discovery, f.engine.environments)
    .run('p', f.v.draft.id, 8, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(run.value.pauseCode, 'research_dossier_ready', run.value.error!);
  assert.equal(run.value.status, 'paused');
  const proven = await readRunnerDossierAssessmentAt(f.store, 'p', reference(run));
  assert.deepEqual(proven.assessment.value.subject, packet.subject);
  assert.equal(proven.result.verdict, 'supported');
  assert.equal(proven.result.return, null);
  let reads=0;
  await fixedPoint(f,f.store,async()=>{
    await unchanged(f,f.store,()=>runDossierAssessmentSession(f.store,'p',packet.subject,undefined,undefined,undefined,
      {restoreOnly:true,get admissionGuards(){reads++;return [reference(proven.origin)];}}));
  });
  assert.equal(reads,1,'admission guards are captured once before asynchronous proof');
  for (const store of [f.store, f.open()]) await fixedPoint(f, store, async () => {
    const engine = new ProductEngine(store);
    assert.deepEqual(await unchanged(f, store, () => new Researcher(store, engine.discovery, engine.environments)
      .run('p', f.v.draft.id, 1, undefined, { restoreOnly: true })), run);
    await unchanged(f, store, () => readRunnerDossierAssessmentAt(store, 'p', reference(run)));
  });
});

test('nonempty no_variants partial remains partial and returns addressed paid targets', async t => {
  const f = await paid(t, (snapshot: Ref) => ({ action: 'no_variants',
    reasons: [{ code: 'bounded_search', message: 'No bounded variant', grounds: [snapshot] }],
    searchLimits: ['Saved sweep'], unknowns: ['Demand unknown'] }), true);
  const none = f.store.list('discovery-variant-none')[0]!;
  const handoff = await publishVariantHandoff(f.store, 'p', { draft: reference(f.store.get(f.draft.id)!),
    result: reference(none), decision: null, scope: null });
  const partial = await producePartialDossier(f.store, 'p', reference(handoff.record));
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', reference(partial.record));
  assert.ok(packet.materials.length > 0);
  wideDelivery(f);
  f.reply(reply(packet, 'return'));
  const run = await new Researcher(f.store, f.discovery, f.engine.environments)
    .run('p', f.v.draft.id, 8, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(run.value.pauseCode, 'research_dossier_return', run.value.error!);
  const proven = await readRunnerDossierAssessmentAt(f.store, 'p', reference(run));
  assert.equal(proven.assessment.value.result.completeness, 'partial');
  assert.deepEqual(proven.result.return, reply(packet, 'return').return);
});

test('selected return preserves its addressed reason; structural caller claims cannot replace paid proof', async t => {
  const f = await completed(t, 'owner');
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', reference(produceSelectedDossier(f.store, 'p', f.input).record));
  wideDelivery(f); f.reply(reply(packet, 'return'));
  const run = await new Researcher(f.store, f.discovery, f.engine.environments)
    .run('p', f.v.draft.id, 1, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(run.value.pauseCode, 'research_dossier_return', run.value.error!);
  const result = await readRunnerDossierAssessmentAt(f.store, 'p', reference(run));
  assert.deepEqual(result.result.return, reply(packet, 'return').return);
  await fixedPoint(f, f.store, async () => {
    for (const at of [null, {}, { ...reference(run), hash: '0'.repeat(64) }, { ...reference(run), supported: true }])
      await unchanged(f, f.store, () => readRunnerDossierAssessmentAt(f.store, 'p', at), true);
    await unchanged(f, f.store, () => readRunnerDossierAssessmentAt(f.store, 'other', reference(run)), true);
  });
  // Deliberately save a forged run continuation, never a synthetic paid assessment.
  // The ordinary read door must derive its verdict/targets from the original paid result.
  for (const field of [null, { ...run.value.dossierAssessment!, verdict: 'supported', return: null },
    { ...run.value.dossierAssessment!, root: run.value.dossierAssessment!.manifest }]) {
    const head = f.store.get(run.id)!;
    const bad = f.store.write({ id: run.id, kind: run.kind, expected: head.revision,
      value: { ...run.value, dossierAssessment: field } });
    await unchanged(f, f.store, () => readRunnerDossierAssessmentAt(f.store, 'p', reference(bad)), true);
  }
});

test('a real owner reject_all keeps its nonempty partial reason through the paid runner return', async t => {
  const f=await paid(t,undefined,true);
  const scope={...f.scope!,outcome:{kind:'reject_all' as const,reason:'The paid set does not satisfy the owner'}};
  const sessions=new VariantChoiceSessions(f.store),issued=issueVariantChoiceInvitation(f.store,scope);
  assert.ok(issued.ok);const login=sessions.exchange({projectId:'p',invitation:issued.value.invitation});assert.ok(login.ok);
  const decision=answerVariantChoice(f.store,scope,sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok);
  const handoff=await publishVariantHandoff(f.store,'p',{draft:scope.draft,result:reference(f.set!),decision:reference(decision.decision),scope:null});
  const dossier=await producePartialDossier(f.store,'p',reference(handoff.record));
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(dossier.record));
  assert.ok(packet.materials.length>0);assert.equal(dossier.record.value.reasons[0]!.code,'reject_all');
  wideDelivery(f);f.reply(reply(packet,'return'));
  const run=await new Researcher(f.store,f.discovery,f.engine.environments)
    .run('p',f.v.draft.id,1,undefined,{producerPolicy:{discovery:7}});
  const proof=await readRunnerDossierAssessmentAt(f.store,'p',reference(run));
  assert.equal(proof.packet.subject.root.kind,'partial');assert.deepEqual(proof.packet.root,packet.root);
  assert.deepEqual(proof.result.return,reply(packet,'return').return);
});

test('post-choice bounded stop keeps rejected material, exact scope and its reason in paid D6', async t => {
  const prior=await completed(t,'owner'),decision=revise(prior);
  const scope=publishVariantScope(prior.store,'p',reference(decision.decision)).scope;
  const f={...prior,scopeRecord:scope,input:{scope:reference(scope),plan:prior.v.planAnswer}};
  for(const question of ['q-industry','q-market']) for(let n=0;n<3;n++) {
    const entry=await deep(f,question,[claim(f,question,question==='q-industry'?'industry':'market',`Rejected bounded probe ${question} ${n}`)]);
    await assess(f,entry,'rejected');
  }
  const handoff=await publishVariantHandoff(f.store,'p',{draft:reference(f.store.get(f.draft.id)!),
    result:scope.value.set,decision:scope.value.decision,scope:reference(scope)});
  // The ordinary runner owns the stop boundary, even though all preceding
  // probes were already settled by the shared real managed producers.
  const paused=await new Researcher(f.store,f.discovery,f.engine.environments)
    .run('p',f.v.draft.id,1,undefined,{restoreOnly:true,producerPolicy:{discovery:7}});
  assert.equal(paused.value.pauseCode,'research_dossier_assessment_unavailable',paused.value.error!);
  const stop=await produceDeepFrontierStop(f.store,'p',reference(handoff.record));
  const dossier=await produceStoppedPartialDossier(f.store,'p',reference(stop.record));
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(dossier.record));
  assert.ok(packet.materials.some(row=>row.status==='rejected'));
  wideDelivery(f);f.reply(reply(packet,'return'));
  const run=await new Researcher(f.store,f.discovery,f.engine.environments)
    .run('p',f.v.draft.id,1,undefined,{producerPolicy:{discovery:7}});
  const proof=await readRunnerDossierAssessmentAt(f.store,'p',reference(run));
  assert.deepEqual(proof.packet.subject,packet.subject);assert.deepEqual(proof.packet.root,packet.root);
  assert.deepEqual(proof.packet.route.scope!.ref,reference(scope));
  assert.deepEqual(proof.packet.materials,packet.materials);
  assert.deepEqual(proof.result.return,reply(packet,'return').return);
});

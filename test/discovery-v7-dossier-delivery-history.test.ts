import test from 'node:test';
import assert from 'node:assert/strict';
import { dossierDeliveryWorld } from './discovery-v7-dossier-delivery-fixture.js';
import { canonical, hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { contextWorkspace } from '../src/discovery/context-workspace.js';
import { prepareDossierResearchEnvelope } from '../src/discovery/research-protocol.js';
import { runDossierAssessmentSession, readDossierAssessmentSessionAt, type DossierAssessmentSession } from '../src/discovery/assessment-session.js';
import { resolveRoleMode, uniqueTransactionGuards } from '../src/runtime/environment.js';
import { money } from './discovery-v7-dossier-seed.js';

/** The published v1 origin format, before the dictionary era. Only unpaid
 * preparation is seeded; every call, charge, application and result uses the real runtime. */
test('L29 old saved session keeps complete-packet transport and its paid cold result', async t=>{
  const f=await dossierDeliveryWorld(t),subject=f.packet.subject;
  f.settingsChange({read:true,readLimit:128000});
  const draft=f.store.get<any>(f.packet.basis.draft.ref.id)!,question=f.store.get<any>((f.packet.basis.plan.value as any).question)!;
  const id=`dossier-session:v1:${hashJson(['dossier-session/v1',subject])}`;
  const application=`dossier-application:v1:${hashJson([id,1])}`;
  const role=resolveRoleMode('reviewer',f.environment.value.reviewer,'research');
  const prompt='Assess the exact saved dossier using its dossier-assessment-result/v1 schema. Read every required original and both sides; return supported or an addressed return, or read_context/assessment_checkpoint.';
  const value:DossierAssessmentSession={contract:'dossier-session/v1',projectId:'p',subject,
    binding:{draft:reference(draft),question:reference(question),environment:reference(f.environment),inputs:draft.value.inputs},
    role,dispatch:f.environment.value,profile:reference(f.profile),prompt,step:0,offset:0,notes:[],workspace:contextWorkspace(),
    previous:null,application,result:null};
  const session={id,revision:1,hash:hashJson(value)};
  const context={dossierSubject:subject,dossierResultTransport:'dossier-result-transport/v1',
    managedDossier:{contract:'dossier-session-transport/v1',session,application,step:0},dossierNotes:[],contextWorkspace:[]};
  const built=await prepareDossierResearchEnvelope(role,f.environment.value,prompt,context,
    {store:f.store,draftId:draft.id,questionId:question.id,purpose:'dossier-assessor',pilot:f.profile},undefined,undefined,true);
  const archive=built.archives.records.get(built.subject.working.archive.id)??f.store.get<any>(built.subject.working.archive.id)!;
  const effective=f.engine.environments.effective('p');
  const guards=uniqueTransactionGuards([...effective.guards,...effective.admissionGuards,reference(draft),reference(question),reference(f.environment),...draft.value.inputs,reference(f.profile)]);
  f.store.writeMany([{id,kind:'assessment-session',expected:0,value},...built.archives.writes,
    {id:application,kind:'assessment-application',expected:0,value:{contract:'dossier-application/v1',projectId:'p',session,
      context:archive.value.body,prompt,role,dispatch:f.environment.value,profile:reference(f.profile),guards,state:'prepared',call:null,received:null,after:null}}],
    uniqueTransactionGuards([...guards,...built.archives.guards]));
  const result=await runDossierAssessmentSession(f.store,'p',subject);
  assert.ok(result.result);assert.ok(!Object.hasOwn(result.session.value,'dossierMaterialContract'));
  assert.ok(f.sent().every(w=>!Object.hasOwn(w.subject,'dossierMaterial')));
  assert.ok(f.sent().some(w=>w.subject.dossierPacket || w.subject.working.materialAddresses?.some((a:any)=>a.field==='dossierPacket')));
  const before=money(f.store),count=f.sent().length,cold=f.open();
  assert.deepEqual((await readDossierAssessmentSessionAt(cold,'p',reference(result.session))).result,result.result);
  assert.deepEqual((await runDossierAssessmentSession(cold,'p',subject)).result,result.result);
  assert.deepEqual(money(cold),before);assert.equal(f.sent().length,count);
  t.diagnostic(JSON.stringify({era:'legacy',fullPacket:canonical(f.packet).length,calls:count,deliveredChars:f.sent().reduce((sum,w)=>sum+JSON.stringify(w).length,0)}));
});

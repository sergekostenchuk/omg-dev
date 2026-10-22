import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { VARIANT_OWNER_ACTION, type VariantChoiceScope } from '../src/discovery/variant-decision.js';
import { issueVariantChoiceInvitation, VariantChoiceAuthority, VariantChoiceSessions,
  requireVariantChoiceAuthority } from '../src/product/owner-authority.js';
import type { OmResult } from '../src/om/refusal.js';

function no<T>(result: OmResult<T>, code: string) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.code, code, result.refusal.message);
}
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
}
const history=(store:Store)=>store.list().flatMap(row=>store.history(row.id));
async function bare(t:test.TestContext) {
  const root=mkdtempSync(join(tmpdir(),'omg-4o1-')), path=join(root,'state.sqlite'), store=new Store(path);
  const engine=new ProductEngine(store);
  await engine.execute({type:'create-project',project:'p',title:'Variant authority'});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  // Deliberately negative structural scope: a project Ref proves no draft, paid set, mode or member.
  const ref=reference(store.get('project:p')!);
  const scope:VariantChoiceScope={action:VARIANT_OWNER_ACTION,projectId:'p',draft:ref,set:ref,mode:ref,
    operation:'initial',previous:null,expectedSelection:null,outcome:{kind:'choose',member:ref,reason:'Negative control'}};
  return {root,path,store,scope};
}

test('4O.1: every missing scope field and malformed outcome refuses without a grant',async t=>{
  const f=await bare(t),before=history(f.store);
  for(const key of Object.keys(f.scope)) {
    const missing={...f.scope} as Record<string,unknown>;delete missing[key];
    no(issueVariantChoiceInvitation(f.store,missing),'owner_invitation_invalid');
  }
  for(const request of [null,undefined,{}, {scope:f.scope}, {...f.scope,ready:true},
    {...f.scope,action:'owner-result'}, {...f.scope,previous:undefined},
    {...f.scope,outcome:{kind:'choose',reason:'Missing member'}},
    {...f.scope,outcome:{kind:'reject_all',reason:''}}, {...f.scope,operation:'revise'},
    {...f.scope,outcome:{...f.scope.outcome,accepted:true}}])
    no(issueVariantChoiceInvitation(f.store,request),'owner_invitation_invalid');
  assert.deepEqual(history(f.store),before);
});

test('4O.1: actor, bearer-like JSON, bare Ref and a substituted instance cannot exercise',async t=>{
  const f=await bare(t),before=history(f.store);
  const fake=Object.create(VariantChoiceAuthority.prototype);
  fake.exercise=()=>({ok:true,value:{session:f.scope.set,at:Date.now()}});
  const request={store:f.store,action:VARIANT_OWNER_ACTION,scope:f.scope};
  for(const candidate of [undefined,null,'owner','local-owner',{owner:true},{actor:'owner'},f.scope.set,
    JSON.parse(JSON.stringify(f.scope)),{session:f.scope.set},'f'.repeat(64),fake,
    {exercise:()=>({ok:true,value:{session:f.scope.set}})}])
    no(requireVariantChoiceAuthority(candidate,request),'owner_authority_invalid');
  assert.throws(()=>new VariantChoiceAuthority(Symbol(),new VariantChoiceSessions(f.store),f.store,'x',f.scope.set,f.scope),
    {code:'owner_authority_invalid'});
  assert.deepEqual(history(f.store),before);
});

test('4O.1: absent or malformed local invitation never creates a session',async t=>{
  const f=await bare(t),sessions=new VariantChoiceSessions(f.store),before=history(f.store);
  for(const input of [null,{}, {projectId:'p'}, {projectId:'p',invitation:'missing'},
    {projectId:'p',invitation:`${'a'.repeat(32)}.${'b'.repeat(64)}`},
    {projectId:'p',invitation:'bad',scope:f.scope}])
    no(sessions.exchange(input),'owner_invitation_invalid');
  assert.equal(sessions.authority('f'.repeat(64)),null);
  no(sessions.revoke('f'.repeat(64)),'owner_session_missing');
  assert.deepEqual(history(f.store),before);
});

test('4O.1: grants and sessions from another action never become variant authority',async t=>{
  const f=await bare(t),request={store:f.store,action:VARIANT_OWNER_ACTION,scope:f.scope};
  const {OwnerSessions,DiscoveryChoiceSessions,ProjectModeSessions,issueOwnerInvitation,
    issueDiscoveryChoiceInvitation,issueProjectModeInvitation}=await import('../src/product/owner-authority.js');
  const owner=new OwnerSessions(f.store),old=ok(issueOwnerInvitation(f.store,{project:'p'}));
  const ownerLogin=ok(owner.exchange({project:'p',invitation:old.invitation}));
  const choice=new DiscoveryChoiceSessions(f.store),choiceGrant=ok(issueDiscoveryChoiceInvitation(f.store,
    {project:'p',draft:'d',verdictRef:f.scope.set,reportRef:f.scope.set,conditionId:'condition',optionId:'option'}));
  const choiceLogin=ok(choice.exchange({project:'p',invitation:choiceGrant.invitation}));
  const mode=new ProjectModeSessions(f.store),modeGrant=ok(issueProjectModeInvitation(f.store,{project:'p',mode:'questions',previous:null}));
  const modeLogin=ok(mode.exchange({project:'p',invitation:modeGrant.invitation}));
  const before=history(f.store),variant=new VariantChoiceSessions(f.store);
  for(const authority of [owner.authority(ownerLogin.bearer),choice.authority(choiceLogin.bearer),mode.authority(modeLogin.bearer)])
    no(requireVariantChoiceAuthority(authority,request),'owner_authority_foreign');
  for(const invitation of [old.invitation,choiceGrant.invitation,modeGrant.invitation])
    no(variant.exchange({projectId:'p',invitation}),'owner_invitation_invalid');
  assert.deepEqual(history(f.store),before);
});

test('4O.1: historical doors require exact addresses and cannot read another action or a bare actor',async t=>{
  const f=await bare(t),before=history(f.store);
  const {readVariantChoiceSession,readVariantChoiceSessionGrant}=await import('../src/product/owner-authority.js');
  for(const value of [undefined,null,'owner',{}, {id:'owner-variant-session:missing'}]) {
    no(readVariantChoiceSession(f.store,value),'reference_invalid');
    no(readVariantChoiceSessionGrant(f.store,value),'reference_invalid');
  }
  assert.throws(()=>variantChoiceSessionId(undefined as unknown as Parameters<typeof variantChoiceSessionId>[0]),{code:'owner_session_state_invalid'});
  no(readVariantChoiceSession(f.store,f.scope.draft),'record_foreign');
  no(readVariantChoiceSessionGrant(f.store,f.scope.draft),'record_foreign');
  assert.deepEqual(history(f.store),before);
});
import { writeFileSync } from 'node:fs';
import { hashJson, digest } from '../src/canonical.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId } from '../src/discovery/variant-decision.js';
import { readVariantChoiceSessionGrant, readVariantChoiceSession, variantChoiceSessionId,
  VARIANT_CHOICE_GRANT_PREFIX, type VariantChoiceSession,
  ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { writeGuarded } from '../src/om/refs.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

const generation=()=>({action:'variants',variants:[{key:'one',title:'One bounded variant',proposal:{scope:'common'},
  criteria:Object.fromEntries(VARIANT_CRITERIA.map(key=>[key,{conclusion:'Bounded by the paid sweep',grounds:[],assumptions:[],unknowns:['No evidence beyond the saved sweep'],quantity:null}]))}],
  scale:Object.fromEntries(VARIANT_CRITERIA.map(key=>[key,'Same shared scale'])),comparison:'One bounded variant',
  recommendation:{key:'one',reason:'Fits the exact snapshot'},searchLimits:['Saved sweep'],unknowns:[]});
async function paid(t:test.TestContext) {
  const f=await researchSetup(t,{adapter:'reply',prefix:'omg-4o1-paid-'}),project='p',runs=new Map<string,string>();
  await f.engine.execute({type:'create-project',project,title:'Paid variant authority'});
  const prepare=(selected=f.subject())=>{
    const context={history:[],readings:[]},draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!,question=f.store.get<Question>(f.v.plan.id)!;
    const old=runs.get(selected.planAnswer.hash),run=old?f.store.get<ResearchRun>(old)!:f.store.write<ResearchRun>({
      id:`research-run:${rand()}`,kind:'research-run',expected:0,value:{projectId:project,draftId:draft.id,environment:reference(f.environment),
        turns:0,limit:100,requestChars:0,owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runs.set(selected.planAnswer.hash,run.id);const number=run.value.turns+1;
    const input={projectId:project,kind:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,cursor:{run:run.id,turn:number,instruction:f.prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(f.environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input),invoke=()=>researchCall(f.environment.value.implementer,f.environment.value,f.prompt,context,undefined,
      {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const g={...f,prepare};
  for(const question of ['q-industry','q-market']) {
    const entry=await produce(g,undefined,question),packet=projectAttemptPacket(f.store,{project,planAnswer:f.v.planAnswer,planQuestionId:question,entries:[entry]});
    const reply={verdict:'supported',reasons:['Paid sweep'],return:null,novelty:{attempts:[{attempt:entry.attempt,reason:'Exact result'}],accepted:[],rejected:[],newContent:[],duplicates:[],
      noProgress:[{attempt:entry.attempt,reason:'No source'}],transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[]}};
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
    const assessment=await assessAttempts(f.store,packet,v7ProgressBaseline(f.store,packet),f.environment,f.root);
    applyDiscoveryAssessment(f.store,project,reference(assessment));
  }
  const saved=produceVariantSnapshot(f.store,project).record;
  const modeSessions=new ProjectModeSessions(f.store),invite=ok(issueProjectModeInvitation(f.store,{project,mode:'questions',previous:null}));
  const exchanged=ok(modeSessions.exchange({project,invitation:invite.invitation}));
  const mode=setProjectMode(f.store,{project,mode:'questions',previous:null},modeSessions.authority(exchanged.bearer)).record;
  ok(modeSessions.revoke(exchanged.bearer));
  const subject:VariantSubject={contract:VARIANT_SUBJECT_CONTRACT,kind:'proposal',snapshot:reference(saved),mode:reference(mode),expectedSelection:null};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:generation()}));
  // Explicit transport fixture only for service calibration; the positive producer below uses the real snapshot.
  const calibration=f.store.write({id:'transport-fixture:owner-authority-calibration',kind:'transport-fixture',expected:0,value:{projectId:project}});
  await researchCall(f.environment.value.implementer,f.environment.value,'Calibrate generation',
    {variantSubject:{...subject,snapshot:reference(calibration)},history:[]},undefined,
    {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'variant-proposal'});
  const receipt=await runVariantSession(f.store,{projectId:project,variantSubject:subject,environment:f.environment,
    role:f.environment.value.implementer,prompt:'Propose variants from this exact paid sweep'});
  assert.equal(receipt.value.cursor,1);
  const sets=f.store.list<VariantSet>('discovery-variant-set');assert.equal(sets.length,1,'4B.1 publishes the real paid set');
  const set=sets[0]!,state=f.store.get(variantStateId(project,f.v.draft.id))!;
  const scope:VariantChoiceScope={action:VARIANT_OWNER_ACTION,projectId:project,draft:set.value.draft,set:reference(set),mode:reference(mode),
    operation:'initial',previous:null,expectedSelection:reference(state),outcome:{kind:'choose',member:set.value.members[0]!,reason:'The exact paid set fits the owner goal'}};
  return {...g,scope,set,mode,receipt};
}

const mint=(store:Store,scope:VariantChoiceScope)=>{
  const sessions=new VariantChoiceSessions(store),issued=ok(issueVariantChoiceInvitation(store,scope));
  const exchanged=ok(sessions.exchange({projectId:scope.projectId,invitation:issued.invitation}));
  return {sessions,issued,...exchanged,authority:sessions.authority(exchanged.bearer)!};
};
const exercise=(f:{store:Store;scope:VariantChoiceScope},authority:unknown)=>
  requireVariantChoiceAuthority(authority,{store:f.store,action:VARIANT_OWNER_ACTION,scope:f.scope});

test('4O.1: paid set -> local grant -> one-use exchange -> full exact authority without choosing the set',async t=>{
  const f=await paid(t),before=f.store.list('discovery-variant-state'),calls=f.wires().length;
  const issued=ok(issueVariantChoiceInvitation(f.store,f.scope)),secret=issued.invitation.split('.')[1]!;
  const grant=ok(readVariantChoiceSessionGrant(f.store,issued.grant));
  assert.equal(grant.value.contract,'owner-session-grant/v4');assert.deepEqual(grant.value.scope,f.scope);
  assert.ok(grant.id.startsWith(VARIANT_CHOICE_GRANT_PREFIX));assert.equal(grant.value.proof,digest(secret));
  const sessions=new VariantChoiceSessions(f.store),exchange=()=>sessions.exchange({projectId:'p',invitation:issued.invitation});
  const wrong=(secret[0]==='0'?'1':'0')+secret.slice(1),beforeExchange=history(f.store);
  no(sessions.exchange({projectId:'p',invitation:`${issued.invitation.split('.')[0]}.${wrong}`}),'owner_invitation_invalid');
  assert.deepEqual(history(f.store),beforeExchange);
  const login=ok(exchange()),authority=sessions.authority(login.bearer)!;
  const session=ok(readVariantChoiceSession(f.store,login.session));
  assert.equal(session.value.contract,'owner-session/v4');assert.equal(session.value.state,'open');
  assert.deepEqual(session.value.grant,issued.grant);assert.deepEqual(session.value.scope,f.scope);
  assert.equal(session.id,variantChoiceSessionId(issued.grant));
  const snapshot=history(f.store),exercised=ok(exercise(f,authority));
  assert.deepEqual(exercised.session,login.session);assert.ok(exercised.at>=session.value.openedAt);
  no(exchange(),'owner_invitation_spent');assert.deepEqual(history(f.store),snapshot);
  assert.deepEqual(f.store.list('discovery-variant-state'),before);assert.equal(f.wires().length,calls);
  for(const row of history(f.store)) {
    assert.equal(JSON.stringify(row.value).includes(secret),false);
    assert.equal(JSON.stringify(row.value).includes(login.bearer),false);
  }
});

test('4O.1: changing each scope field or omitting it never expands the minted authority',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),before=history(f.store),other={...f.scope.set,hash:'0'.repeat(64)};
  const changes:unknown[]=[{...f.scope,action:'owner-result'},{...f.scope,projectId:'other'},
    {...f.scope,draft:other},{...f.scope,set:other},{...f.scope,mode:other},
    {...f.scope,expectedSelection:null},{...f.scope,operation:'revise',previous:other},
    {...f.scope,operation:'override',previous:other},
    {...f.scope,outcome:{kind:'choose',member:other,reason:f.scope.outcome.reason}},
    {...f.scope,outcome:{...f.scope.outcome,reason:'Different owner reason'}},
    {...f.scope,outcome:{kind:'reject_all',reason:'Reject this set'}}];
  for(const key of Object.keys(f.scope)) { const missing={...f.scope} as Record<string,unknown>;delete missing[key];changes.push(missing); }
  for(const scope of changes) no(requireVariantChoiceAuthority(m.authority,{store:f.store,action:VARIANT_OWNER_ACTION,
    scope:scope as VariantChoiceScope}),'owner_authority_foreign');
  no(requireVariantChoiceAuthority(m.authority,{store:f.store,action:'owner-result',scope:f.scope}),'owner_authority_foreign');
  const rejected:VariantChoiceScope={...f.scope,outcome:{kind:'reject_all',reason:'Another exact scope'}};
  const second=mint(f.store,rejected);
  assert.deepEqual(ok(exercise({...f,scope:rejected},second.authority)).session,second.session);
  no(exercise(f,second.authority),'owner_authority_foreign');
  const afterSecond=history(f.store);no(exercise({...f,scope:{...f.scope,set:other}},m.authority),'owner_authority_foreign');
  assert.deepEqual(history(f.store),afterSecond);assert.equal(before.length+2,afterSecond.length);
  assert.deepEqual(ok(exercise(f,m.authority)).session,m.session);
});

test('4O.1: Store instance, database, project, action and session cannot be exchanged',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),sameDatabase=new Store(f.path),otherDatabase=new Store(join(f.root,'other.sqlite'));
  t.after(()=>{sameDatabase.close();otherDatabase.close();});
  const before=history(f.store);
  for(const store of [sameDatabase,otherDatabase])
    no(requireVariantChoiceAuthority(m.authority,{store,action:VARIANT_OWNER_ACTION,scope:f.scope}),'owner_authority_foreign');
  no(new VariantChoiceSessions(f.store).exchange({projectId:'other',invitation:m.issued.invitation}),'owner_invitation_foreign');
  assert.equal(new VariantChoiceSessions(sameDatabase).authority(m.bearer),null);
  no(requireVariantChoiceAuthority({...m.authority},{store:f.store,action:VARIANT_OWNER_ACTION,scope:f.scope}),'owner_authority_invalid');
  no(exercise(f,m.session),'owner_authority_invalid');assert.deepEqual(history(f.store),before);
  // Explicit negative copies: their saved database is the original one, not this database.
  for(const ref of [m.issued.grant,m.session]) {
    const row=f.store.get(ref.id,ref.revision)!;
    otherDatabase.write({id:row.id,kind:row.kind,expected:0,value:row.value});
  }
  const foreignBefore=history(otherDatabase);
  no(readVariantChoiceSessionGrant(otherDatabase,m.issued.grant),'owner_invitation_invalid');
  no(readVariantChoiceSession(otherDatabase,m.session),'owner_session_state_invalid');
  no(new VariantChoiceSessions(otherDatabase).exchange({projectId:'p',invitation:m.issued.invitation}),'owner_invitation_invalid');
  no(m.sessions.revoke(m.bearer,otherDatabase),'owner_authority_foreign');
  assert.deepEqual(history(otherDatabase),foreignBefore);
  assert.deepEqual(ok(exercise(f,m.authority)).session,m.session);
});

test('4O.1: grant expiry and session expiry are typed and leave the saved history unchanged',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),pending=ok(issueVariantChoiceInvitation(f.store,f.scope)),before=history(f.store);
  const now=Date.now;
  try {
    Date.now=()=>pending.expiresAt;
    no(new VariantChoiceSessions(f.store).exchange({projectId:'p',invitation:pending.invitation}),'owner_invitation_expired');
    Date.now=()=>m.expiresAt;
    no(exercise(f,m.authority),'owner_session_expired');
    Date.now=()=>1;
    no(exercise(f,m.authority),'owner_session_expired');
    no(new VariantChoiceSessions(f.store).exchange({projectId:'p',invitation:pending.invitation}),'owner_invitation_invalid');
  } finally {Date.now=now;}
  assert.deepEqual(history(f.store),before);
});

test('4O.1: revocation from a second Store defeats the guard after exercise',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),permit=ok(exercise(f,m.authority)),other=new Store(f.path);
  t.after(()=>other.close());
  const closed=ok(m.sessions.revoke(m.bearer,other));assert.equal(closed.session.revision,2);
  const before=history(f.store);
  no(writeGuarded(f.store,{unit:'4O.1-test',target:'authority-effect',writes:[{id:'authority-effect',kind:'authority-effect',expected:0,
    value:{session:permit.session}}],guards:[permit.session]}),'input_stale');
  no(exercise(f,m.authority),'owner_session_revoked');assert.deepEqual(history(f.store),before);
  assert.equal(f.store.get('authority-effect'),null);
});

test('4O.1: exact historical grant/open session survive revocation, timeout and a cold process registry',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),savedGrant=ok(readVariantChoiceSessionGrant(f.store,m.issued.grant)),
    savedSession=ok(readVariantChoiceSession(f.store,m.session));
  const closed=ok(m.sessions.revoke(m.bearer)),before=history(f.store),cold=new Store(f.path),now=Date.now;
  t.after(()=>cold.close());
  try {
    Date.now=()=>m.expiresAt+1;
    const sessions=new VariantChoiceSessions(cold);assert.equal(sessions.authority(m.bearer),null);
    assert.deepEqual(ok(readVariantChoiceSessionGrant(cold,m.issued.grant)),savedGrant);
    assert.deepEqual(ok(readVariantChoiceSession(cold,m.session)),savedSession);
    assert.equal(ok(readVariantChoiceSession(cold,closed.session)).value.state,'closed');
    no(sessions.exchange({projectId:'p',invitation:m.issued.invitation}),'owner_invitation_expired');
  } finally {Date.now=now;}
  assert.deepEqual(history(f.store),before);
});

test('4O.1: changing a live session cannot replace the session bound at exchange; exact origin remains readable',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),first=ok(readVariantChoiceSession(f.store,m.session));
  const tampered=f.store.write<VariantChoiceSession>({id:first.id,kind:first.kind,expected:first.revision,
    value:{...first.value,scope:{...first.value.scope,outcome:{kind:'reject_all',reason:'Forged revision'}}}});
  const before=history(f.store);
  no(exercise(f,m.authority),'owner_session_state_invalid');
  no(readVariantChoiceSession(f.store,reference(tampered)),'owner_session_state_invalid');
  assert.deepEqual(ok(readVariantChoiceSession(f.store,m.session)),first);assert.deepEqual(history(f.store),before);
});

test('4O.1: the same invitation raced by two Stores opens exactly one session',async t=>{
  const f=await paid(t),issued=ok(issueVariantChoiceInvitation(f.store,f.scope)),sessions=new VariantChoiceSessions(f.store),other=new Store(f.path);
  t.after(()=>other.close());const second=new VariantChoiceSessions(other),original=f.store.writeMany.bind(f.store);
  let winning:ReturnType<typeof second.exchange>|null=null;
  f.store.writeMany=((writes,guards)=>{
    if(writes.some(write=>write.id.startsWith('owner-variant-session:'))) {
      f.store.writeMany=original;
      winning=second.exchange({projectId:'p',invitation:issued.invitation});
    }
    return original(writes,guards);
  }) as typeof f.store.writeMany;
  no(sessions.exchange({projectId:'p',invitation:issued.invitation}),'revision_conflict');
  assert.ok(winning);const login=ok(winning as ReturnType<typeof second.exchange>);
  assert.equal(f.store.history(login.session.id).length,1);
  const authority=second.authority(login.bearer)!;
  assert.deepEqual(ok(requireVariantChoiceAuthority(authority,{store:other,action:VARIANT_OWNER_ACTION,scope:f.scope})).session,login.session);
  no(sessions.exchange({projectId:'p',invitation:issued.invitation}),'owner_invitation_spent');
});

test('4O.1: a structural lookalike set is refused before any grant or authority is created',async t=>{
  const f=await paid(t);
  const {variantRecordId}=await import('../src/discovery/discovery-variants.js');
  // Explicit negative corruption: the paid application never published this otherwise closed set value.
  const value={...f.set.value,comparison:'Unpaid substitute for the real comparison'},
    fake=f.store.write({id:variantRecordId('discovery-variant-set',value),kind:'discovery-variant-set',expected:0,value});
  const before=history(f.store);
  no(issueVariantChoiceInvitation(f.store,{...f.scope,set:reference(fake)}),'discovery_variant_session_invalid');
  no(issueVariantChoiceInvitation(f.store,{...f.scope,draft:{...f.scope.draft,revision:f.scope.draft.revision+1}}),'discovery_variant_basis_invalid');
  no(issueVariantChoiceInvitation(f.store,{...f.scope,outcome:{kind:'choose',member:f.scope.draft,reason:'Not a set member'}}),'discovery_variant_basis_invalid');
  assert.deepEqual(history(f.store),before);
});

test('4O.1: another real paid set has a distinct authority; historical grants keep their original set',async t=>{
  const f=await paid(t),first=mint(f.store,f.scope),oldGrant=ok(readVariantChoiceSessionGrant(f.store,first.issued.grant));
  const subject:VariantSubject={contract:VARIANT_SUBJECT_CONTRACT,kind:'proposal',snapshot:f.set.value.snapshot,
    mode:f.scope.mode,expectedSelection:f.scope.expectedSelection};
  const next=await runVariantSession(f.store,{projectId:'p',variantSubject:subject,environment:f.environment,
    role:f.environment.value.implementer,prompt:'A new paid generation from the saved sweep and selection'});
  const sets=f.store.list<VariantSet>('discovery-variant-set');assert.equal(sets.length,2);
  const secondSet=sets.find(row=>row.id!==f.set.id)!;
  const secondScope:VariantChoiceScope={...f.scope,set:reference(secondSet),expectedSelection:reference(f.store.get(variantStateId('p',f.v.draft.id))!),
    outcome:{kind:'choose',member:secondSet.value.members[0]!,reason:'Choose the second paid set'}};
  const second=mint(f.store,secondScope),before=history(f.store);
  no(exercise({...f,scope:secondScope},first.authority),'owner_authority_foreign');
  no(exercise(f,second.authority),'owner_authority_foreign');
  assert.deepEqual(ok(readVariantChoiceSessionGrant(f.store,first.issued.grant)),oldGrant);
  assert.deepEqual(ok(exercise(f,first.authority)).session,first.session);
  assert.equal(next.value.cursor,1);assert.deepEqual(history(f.store),before);
});

test('4O.1: each absent persisted grant field is a typed refusal, without an exchange or writes',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),grant=ok(readVariantChoiceSessionGrant(f.store,m.issued.grant));
  const secret=m.issued.invitation.split('.')[1]!;
  for(const [index,key] of Object.keys(grant.value).entries()) {
    // Explicit negative corruption, not a second producer: all other fields retain the real saved basis.
    const id=index.toString(16).padStart(32,'0'),value={...grant.value,id} as Record<string,unknown>;delete value[key];
    const row=f.store.write({id:`${VARIANT_CHOICE_GRANT_PREFIX}${id}`,kind:'owner-session-grant',expected:0,value});
    const before=history(f.store);
    no(readVariantChoiceSessionGrant(f.store,reference(row)),'owner_invitation_invalid');
    no(new VariantChoiceSessions(f.store).exchange({projectId:'p',invitation:`${id}.${secret}`}),'owner_invitation_invalid');
    assert.deepEqual(history(f.store),before,key);
  }
});

test('4O.1: each absent persisted session field and a missing closedAt refuse without side effects',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),session=ok(readVariantChoiceSession(f.store,m.session));
  for(const key of Object.keys(session.value)) {
    const grant=ok(issueVariantChoiceInvitation(f.store,f.scope)),saved=ok(readVariantChoiceSessionGrant(f.store,grant.grant));
    const value={...session.value,grant:grant.grant,openedAt:saved.value.issuedAt,
      expiresAt:saved.value.issuedAt+30*60_000} as Record<string,unknown>;delete value[key];
    const row=f.store.write({id:variantChoiceSessionId(grant.grant),kind:'owner-session',expected:0,value});
    const before=history(f.store);
    no(readVariantChoiceSession(f.store,reference(row)),'owner_session_state_invalid');
    assert.deepEqual(history(f.store),before,key);
  }
  // Negative corruption of the lawful open session; absence of closedAt is illegal only for closed state.
  const closed=f.store.write({id:session.id,kind:session.kind,expected:1,value:{...session.value,state:'closed'}});
  const before=history(f.store);
  no(readVariantChoiceSession(f.store,reference(closed)),'owner_session_state_invalid');
  no(exercise(f,m.authority),'owner_session_state_invalid');assert.deepEqual(history(f.store),before);
});

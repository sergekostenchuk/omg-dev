import { answerDiscoveryCondition } from '../src/discovery/discovery-decision.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { discoveryOutcome } from '../src/discovery/discovery-outcome.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { DiscoveryChoiceAuthority, DiscoveryChoiceSessions, OwnerAuthority, OwnerSessions,
  issueDiscoveryChoiceInvitation, issueOwnerInvitation, requireOwnerAuthority } from '../src/product/owner-authority.js';
import { createProductServer } from '../src/server.js';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ok = <T>(result: {ok: true; value: T} | {ok: false; refusal: {code: string}}): T => {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as {ok: true; value: T}).value;
};

const ownerCondition = (id: string) => ({ id, kind: 'owner_choice', condition: `Choose ${id}`, criterion: 'Explicit owner choice', options: [
  { optionId: 'accept', label: 'Accept local scope', consequences: ['Reassess the local variant'], choice: 'accept' },
  { optionId: 'decline', label: 'Decline local scope', consequences: ['Reassess feasibility without this condition'], choice: 'decline' },
] });
function fixture(t: {after(fn: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), 'omg-discovery-choice-')), path = join(root, 'state.sqlite');
  const store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  engine.execute({type: 'create-project', project: 'p', title: 'Local CLI'});
  const source = engine.discovery.evidence.document('p', 'request', 'Local CLI feasibility research fixture', 'text/plain', 0);
  const draft = engine.prepare('p', 'discovery');
  const question = (field: string) => draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
  for (const id of draft.value.questions) {
    const q = store.get<Question>(id)!, field = q.value.spec.field;
    if (field === 'preparation') break;
    if (q.value.spec.kind === 'fact') engine.discovery.fact(q.id, q.revision, reference(source), {kind: 'text-range', start: 0, end: source.value.content.length});
    else if (['researchPlan', 'researchReport', 'verdict'].includes(field)) {
      const value: any = preparedField('p', field);
      if (field === 'verdict') Object.assign(value, {outcome: 'conditional', conditions: [ownerCondition('scope')]});
      answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(draft.id)!, q, value, source);
    } else engine.discovery.decision(q.id, q.revision, 'local-owner', preparedField('p', field));
  }
  const verdict = question('verdict').value.answer!;
  const reportRef = question('researchReport').value.answer!;
  const command = (conditionId = 'scope', optionId = 'accept') => ({type: 'answer-decision' as const, mode: 'discovery-condition' as const,
    project: 'p', draft: draft.id, verdictRef: verdict, conditionId, optionId});
  const request = (conditionId = 'scope', optionId = 'accept') =>
    ({project: 'p', draft: draft.id, verdictRef: verdict, reportRef, conditionId, optionId});
  const chooseOutcome = (conditionId = 'scope', optionId = 'accept', target = store) => {
    const scoped = request(conditionId, optionId), sessions = new DiscoveryChoiceSessions(target);
    const issued = ok(issueDiscoveryChoiceInvitation(target, scoped));
    const exchanged = ok(sessions.exchange({project: scoped.project, invitation: issued.invitation}));
    const authority = sessions.authority(exchanged.bearer)!;
    try { return answerDiscoveryCondition(target, scoped, authority); }
    finally { sessions.revoke(exchanged.bearer); }
  };
  const choose = (conditionId = 'scope', optionId = 'accept', target = store) =>
    chooseOutcome(conditionId, optionId, target).decision;
  const state = () => discoveryOutcome(store, store.get<DiscoveryDraft>(draft.id)!);
  return {root, store, engine, path, draft, question, verdict, reportRef, command, request, choose, chooseOutcome, state};
}

test('DS1.1 missing command address is refused before lookup and before writing a decision', t => {
 const f=fixture(t);
 assert.throws(()=>answerDiscoveryCondition(f.store,f.command(),''),{code:'owner_authority_invalid'});
 for(const key of ['project','draft','verdictRef','reportRef','conditionId','optionId']) {
  const request:any={...f.request()};delete request[key];
  assert.throws(()=>f.engine.execute(request),{code:'command_invalid'});
  const sessions=new DiscoveryChoiceSessions(f.store),issued=ok(issueDiscoveryChoiceInvitation(f.store,f.request()));
  const exchanged=ok(sessions.exchange({project:'p',invitation:issued.invitation}));
  assert.throws(()=>answerDiscoveryCondition(f.store,request,sessions.authority(exchanged.bearer)),{code:'discovery_choice_invalid'});
  sessions.revoke(exchanged.bearer);
 }
 const sessions=new DiscoveryChoiceSessions(f.store),issued=ok(issueDiscoveryChoiceInvitation(f.store,f.request()));
 const exchanged=ok(sessions.exchange({project:'p',invitation:issued.invitation}));
 assert.equal(new DiscoveryChoiceSessions(f.store).authority(exchanged.bearer),null,
  'a process/registry restart cannot recover a live bearer');
 assert.throws(()=>answerDiscoveryCondition(f.store,{...f.request(),bearer:exchanged.bearer},sessions.authority(exchanged.bearer)),
  {code:'discovery_choice_invalid'});
 sessions.revoke(exchanged.bearer);
 assert.equal(f.store.list('discovery-condition-decision').length,0);
});

test('OC1 rejects actor, JSON and H2 authority masquerades; general HTTP remains a non-owner door', async t => {
 const f=fixture(t);
 for(const candidate of ['owner',{owner:true},f.verdict,{session:f.verdict}])
  assert.throws(()=>answerDiscoveryCondition(f.store,f.request(),candidate),{code:'owner_authority_invalid'});
 assert.throws(()=>f.engine.execute(f.command()),(error:any)=>error.code==='owner_authority_invalid'
  && error.details.door==='owner-discovery-choice');
 const h2=new OwnerSessions(f.store),invite=ok(issueOwnerInvitation(f.store,{project:'p'}));
 const login=ok(h2.exchange({project:'p',invitation:invite.invitation}));
 assert.throws(()=>answerDiscoveryCondition(f.store,f.request(),h2.authority(login.bearer)),{code:'owner_authority_foreign'});
 const scoped=new DiscoveryChoiceSessions(f.store),issued=ok(issueDiscoveryChoiceInvitation(f.store,f.request()));
 const exchanged=ok(scoped.exchange({project:'p',invitation:issued.invitation}));
 const reverse=requireOwnerAuthority(scoped.authority(exchanged.bearer),{store:f.store,project:'p',action:'owner-result'});
 assert.equal(reverse.ok,false);if(!reverse.ok)assert.equal(reverse.refusal.code,'owner_authority_foreign');
 const fakeDiscovery=Object.create(DiscoveryChoiceAuthority.prototype);
 fakeDiscovery.exercise=()=>({ok:true,value:{session:exchanged.session}});
 assert.throws(()=>answerDiscoveryCondition(f.store,f.request(),fakeDiscovery),{code:'owner_authority_invalid'});
 const fakeOwner=Object.create(OwnerAuthority.prototype);
 fakeOwner.exercise=()=>({ok:true,value:{session:login.session}});
 const fakeOwnerResult=requireOwnerAuthority(fakeOwner,{store:f.store,project:'p',action:'owner-result'});
 assert.equal(fakeOwnerResult.ok,false);if(!fakeOwnerResult.ok)assert.equal(fakeOwnerResult.refusal.code,'owner_authority_invalid');
 scoped.revoke(exchanged.bearer);h2.revoke(login.bearer);

 const server=createProductServer(f.engine);await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
 try {
  const port=(server.address() as {port:number}).port;
  const response=await fetch(`http://127.0.0.1:${port}/api/command`,{method:'POST',headers:{
   'content-type':'application/json','x-omg-token':server.accessToken},body:JSON.stringify(f.command())});
  const body=await response.json() as {error:string;details?:{door?:string}};
  assert.equal(body.error,'owner_authority_invalid');assert.equal(body.details?.door,'owner-discovery-choice');
 } finally {await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));}
 assert.equal(f.store.list('discovery-condition-decision').length,0);
});

test('OC1 invitations are scoped, one-use and time bounded; authority is store/scope/live-session bound', t => {
 const f=fixture(t),sessions=new DiscoveryChoiceSessions(f.store),issued=ok(issueDiscoveryChoiceInvitation(f.store,f.request()));
 const wrong=`${issued.invitation.slice(0,-1)}${issued.invitation.endsWith('0')?'1':'0'}`;
 const invalid=sessions.exchange({project:'p',invitation:wrong});assert.equal(invalid.ok,false);
 if(!invalid.ok)assert.equal(invalid.refusal.code,'owner_invitation_invalid');
 const exchanged=ok(sessions.exchange({project:'p',invitation:issued.invitation}));
 const spent=sessions.exchange({project:'p',invitation:issued.invitation});assert.equal(spent.ok,false);
 if(!spent.ok)assert.equal(spent.refusal.code,'owner_invitation_spent');
 assert.throws(()=>answerDiscoveryCondition(f.store,f.request('scope','decline'),sessions.authority(exchanged.bearer)),
  {code:'owner_authority_foreign'});
 const otherStore=new Store(f.path);
 try{assert.throws(()=>answerDiscoveryCondition(otherStore,f.request(),sessions.authority(exchanged.bearer)),
  {code:'owner_authority_foreign'});}finally{otherStore.close();}
 const revoked=sessions.authority(exchanged.bearer)!;sessions.revoke(exchanged.bearer);
 assert.throws(()=>answerDiscoveryCondition(f.store,f.request(),revoked),{code:'owner_session_revoked'});

 f.engine.execute({type:'create-project',project:'other',title:'Other'});
 const foreignIssued=ok(issueDiscoveryChoiceInvitation(f.store,f.request()));
 const foreign=sessions.exchange({project:'other',invitation:foreignIssued.invitation});assert.equal(foreign.ok,false);
 if(!foreign.ok)assert.equal(foreign.refusal.code,'owner_invitation_foreign');
 const grantIssued=ok(issueDiscoveryChoiceInvitation(f.store,f.request())),grantNow=Date.now;
 Date.now=()=>grantNow()+11*60_000;
 try {const expired=sessions.exchange({project:'p',invitation:grantIssued.invitation});assert.equal(expired.ok,false);
  if(!expired.ok)assert.equal(expired.refusal.code,'owner_invitation_expired');} finally {Date.now=grantNow;}

 const now=Date.now,late=now()+31*60_000,sessions2=new DiscoveryChoiceSessions(f.store);
 const issued2=ok(issueDiscoveryChoiceInvitation(f.store,f.request()));
 const exchanged2=ok(sessions2.exchange({project:'p',invitation:issued2.invitation}));
 Date.now=()=>late;
 try {assert.throws(()=>answerDiscoveryCondition(f.store,f.request(),sessions2.authority(exchanged2.bearer)),
  {code:'owner_session_expired'});} finally {Date.now=now;sessions2.revoke(exchanged2.bearer);}
 assert.equal(f.store.list('discovery-condition-decision').length,0);
});

test('OC1 exact repeat uses a new scoped session, closes it, and preserves one historical v2 proof', t => {
 const f=fixture(t),first=f.chooseOutcome();assert.equal(first.repeated,false);assert.equal(first.nextAction,'research-stage');
 const second=f.chooseOutcome();assert.equal(second.repeated,true);assert.deepEqual(second.decision,first.decision);
 assert.equal(f.store.list('discovery-condition-decision').length,1);
 assert.equal(f.store.list<any>('owner-session').filter(row=>row.id.startsWith('owner-discovery-session:')).length,2);
 assert.ok(f.store.list<any>('owner-session').filter(row=>row.id.startsWith('owner-discovery-session:'))
  .every(row=>row.value.state==='closed'));
 const clock=Date.now;Date.now=()=>clock()+31*60_000;
 try{assert.equal(f.state().state,'researching','closed or expired authority cannot erase historical proof');}
 finally{Date.now=clock;}
});

test('OC1 one transaction guards revocation and grounds; exact concurrent repeats converge', t => {
 const f=fixture(t),sessions=new DiscoveryChoiceSessions(f.store),issued=ok(issueDiscoveryChoiceInvitation(f.store,f.request()));
 const exchanged=ok(sessions.exchange({project:'p',invitation:issued.invitation})),authority=sessions.authority(exchanged.bearer)!;
 const write=f.store.writeMany.bind(f.store);let revoked=false;
 f.store.writeMany=((writes:any[],guards:any[]=[])=>{
  if(!revoked&&writes.some(row=>row.kind==='discovery-condition-decision')){revoked=true;sessions.revoke(exchanged.bearer);}
  return write(writes,guards);
 }) as typeof f.store.writeMany;
 assert.throws(()=>answerDiscoveryCondition(f.store,f.request(),authority),{code:'input_stale'});
 f.store.writeMany=write;assert.equal(f.store.list('discovery-condition-decision').length,0);

 const f2=fixture(t),sessions2=new DiscoveryChoiceSessions(f2.store),issued2=ok(issueDiscoveryChoiceInvitation(f2.store,f2.request()));
 const exchanged2=ok(sessions2.exchange({project:'p',invitation:issued2.invitation})),authority2=sessions2.authority(exchanged2.bearer)!;
 const write2=f2.store.writeMany.bind(f2.store);let raced=false;
 f2.store.writeMany=((writes:any[],guards:any[]=[])=>{
  if(!raced&&writes.some(row=>row.kind==='discovery-condition-decision')){raced=true;const other=new Store(f2.path);
   try{f2.choose('scope','accept',other);}finally{other.close();}}
  return write2(writes,guards);
 }) as typeof f2.store.writeMany;
 const result=answerDiscoveryCondition(f2.store,f2.request(),authority2);
 assert.equal(result.repeated,true);assert.equal(f2.store.list('discovery-condition-decision').length,1);
 f2.store.writeMany=write2;sessions2.revoke(exchanged2.bearer);
});

test('OC1 CAS recovery rechecks current grounds after the competing exact choice', t => {
 const f=fixture(t),write=f.store.writeMany.bind(f.store);let raced=false;
 f.store.writeMany=((writes:any[],guards:any[]=[])=>{
  if(!raced&&writes.some(row=>row.kind==='discovery-condition-decision')){
   raced=true;const other=new Store(f.path);
   try{
    f.choose('scope','accept',other);
    const report=other.get<Question>(f.question('researchReport').id)!;
    new ProductEngine(other).discovery.reopen(report.id,report.revision);
   }finally{other.close();}
  }
  return write(writes,guards);
 }) as typeof f.store.writeMany;
 assert.throws(()=>f.chooseOutcome(),{code:'discovery_choice_stale'});
 assert.ok(raced);assert.equal(f.store.list('discovery-condition-decision').length,1);
 f.store.writeMany=write;
});

test('OC1 trusted CLI creates and repeats one decision without exposing a live bearer', t => {
 const f=fixture(t),cli=resolve('dist/src/cli.js'),input=JSON.stringify(f.request());
 const grants=f.store.list('owner-session-grant').length;
 assert.throws(()=>execFileSync(process.execPath,[cli,'command',f.path],{
  input:JSON.stringify(f.command()),encoding:'utf8',stdio:['pipe','pipe','pipe']}),(error:any)=>{
   const line=String(error.stderr).split(/\r?\n/).find((row:string)=>row.startsWith('{"error"'));
   if(!line)return false;const body=JSON.parse(line);return body.error==='owner_authority_invalid'
    && body.door==='owner-discovery-choice';
  });
 assert.throws(()=>execFileSync(process.execPath,[cli,'owner-discovery-choice',f.path],{
  input:JSON.stringify({...f.request(),bearer:'not-a-credential'}),encoding:'utf8',stdio:['pipe','pipe','pipe']}),
  (error:any)=>String(error.stderr).includes('discovery_choice_invalid'));
 assert.equal(f.store.list('owner-session-grant').length,grants,'invalid CLI input mints no invitation');
 const first=JSON.parse(execFileSync(process.execPath,[cli,'owner-discovery-choice',f.path],{input,encoding:'utf8'}));
 const second=JSON.parse(execFileSync(process.execPath,[cli,'owner-discovery-choice',f.path],{input,encoding:'utf8'}));
 assert.equal(first.repeated,false);assert.equal(second.repeated,true);assert.deepEqual(second.decision,first.decision);
 assert.equal(first.nextAction,'research-stage');
 assert.equal(Object.hasOwn(first,'bearer'),false);assert.equal(Object.hasOwn(first,'invitation'),false);
 assert.equal(f.store.list('discovery-condition-decision').length,1);
 assert.ok(f.store.list<any>('owner-session').filter(row=>row.id.startsWith('owner-discovery-session:'))
  .every(row=>row.value.state==='closed'));
});

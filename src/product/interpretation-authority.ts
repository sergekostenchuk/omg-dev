import { randomBytes } from 'node:crypto';
import { canonical, digest, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision } from '../storage/store.js';
import { readProjectMode } from './project-mode.js';
import { interpretationExact, readInterpretationExecutionAt, type InterpretationDecision } from '../discovery/interpretation-execution.js';
import { readFrameInterpretationSession } from '../discovery/interpretation-session.js';
import { prepareFrameInterpretationChoiceSubject, projectFrameInterpretationChoice, FRAME_INTERPRETATION_CHOICE } from '../discovery/frame-interpretation-choice.js';

export interface InterpretationChoiceScope {project:string; generation:Ref; interpretation:string; justification:string}
interface Grant {contract:'interpretation-choice-grant/v1'; database:string; scope:InterpretationChoiceScope;
  secretHash:string; issuedAt:number; expiresAt:number}
interface Session {contract:'interpretation-choice-session/v1'; database:string; grant:Ref; scope:InterpretationChoiceScope;
  openedAt:number; expiresAt:number; revokedAt:number|null}
const snapshot = (v: unknown): any => JSON.parse(canonical(v));
const same = (a:unknown,b:unknown) => canonical(a)===canonical(b);
const database = (store:Store) => store.databaseId;
const MINT=Symbol('interpretation-choice');
const live=new WeakMap<object,{store:Store;scope:InterpretationChoiceScope;session:Ref;valid:()=>boolean}>();
class InterpretationAuthority {
  constructor(mint:symbol, store:Store, scope:InterpretationChoiceScope, session:Ref, valid:()=>boolean) {
    requireCondition(mint===MINT,'owner_authority_required','A trusted scoped session is required');
    live.set(this,{store,scope:snapshot(scope),session:snapshot(session),valid}); Object.freeze(this);
  }
}
export function validateInterpretationChoice(store:Store, input:unknown):InterpretationChoiceScope {
  const s=snapshot(input);
  requireCondition(s && Object.keys(s).sort().join(',')==='generation,interpretation,justification,project'
    && typeof s.project==='string' && isRef(s.generation) && typeof s.interpretation==='string'
    && typeof s.justification==='string' && s.justification.trim().length>0,
    'interpretation_choice_invalid','The choice needs project, exact generation, member and justification');
  const generated=readInterpretationExecutionAt(store,s.project,s.generation);
  requireCondition(generated.value.phase==='generate' && generated.value.result!==null,
    'interpretation_generation_unproven','An owner chooses only from a paid generated set');
  const p=readFrameInterpretationSession(store,s.project,generated.value.prepared);
  const subject=prepareFrameInterpretationChoiceSubject(store,{project:s.project,frame:p.value.frame,mandate:p.value.brief,previousSet:p.value.previousSet},generated.value.result);
  requireCondition(subject.result.answer.value.outcome==='material'
    && subject.result.answer.value.interpretations.some(i=>i.id===s.interpretation),
    'interpretation_choice_invalid','Choose an actual material interpretation');
  return s;
}
export function issueInterpretationChoiceInvitation(store:Store,input:unknown) {
  const scope=validateInterpretationChoice(store,input), mode=readProjectMode(store,scope.project);
  requireCondition(mode.mode==='questions','interpretation_mode_invalid','Owner choice requires questions mode');
  const secret=randomBytes(32).toString('hex'), now=Date.now();
  const value:Grant={contract:'interpretation-choice-grant/v1',database:database(store),scope,secretHash:digest(secret),issuedAt:now,expiresAt:now+600000};
  const id=`interpretation-choice-grant:${hashJson(value)}`;
  const record=store.writeMany<Grant>([{id,kind:'owner-session-grant',expected:0,value}],[mode.ref,scope.generation])[0]!;
  return {grant:reference(record),secret};
}
export class InterpretationChoiceSessions {
  #bearers=new Map<string,InterpretationAuthority>();
  constructor(private store:Store) {}
  exchange(invitation:{grant:Ref;secret:string}) {
    const grant=interpretationExact<Grant>(this.store,invitation.grant,'owner-session-grant'), g=grant.value, now=Date.now();
    requireCondition(g?.contract==='interpretation-choice-grant/v1' && g.database===database(this.store)
      && typeof invitation.secret==='string' && digest(invitation.secret)===g.secretHash && now<g.expiresAt,
      'owner_authority_required','The trusted invitation is missing, expired or foreign');
    validateInterpretationChoice(this.store,g.scope);
    const id=`interpretation-choice-session:${hashJson(reference(grant))}`;
    const value:Session={contract:'interpretation-choice-session/v1',database:g.database,grant:reference(grant),scope:g.scope,
      openedAt:now,expiresAt:now+1800000,revokedAt:null};
    const row=this.store.writeMany<Session>([{id,kind:'owner-session',expected:0,value}],[reference(grant),{id,absent:true}])[0]!;
    const bearer=randomBytes(32).toString('hex');
    const authority:InterpretationAuthority=new InterpretationAuthority(MINT,this.store,g.scope,reference(row),()=>this.#bearers.get(bearer)===authority);
    this.#bearers.set(bearer,authority); return {bearer,authority};
  }
  revoke(bearer:string):void {
    const authority=this.#bearers.get(bearer);
    requireCondition(authority,'owner_authority_required','The live scoped session is missing');
    this.#bearers.delete(bearer);
    const ref=live.get(authority)!.session, row=interpretationExact<Session>(this.store,ref,'owner-session');
    this.store.writeMany([{id:row.id,kind:row.kind,expected:row.revision,value:{...row.value,revokedAt:Date.now()}}],[ref]);
  }
}
function sessionProof(store:Store, ref:Ref, scope:InterpretationChoiceScope):Revision<Session> {
  const session=interpretationExact<Session>(store,ref,'owner-session'), s=session.value;
  requireCondition(s?.contract==='interpretation-choice-session/v1' && s.database===database(store)
    && s.revokedAt===null && same(s.scope,scope),'owner_authority_required','The scoped owner session differs from this choice');
  const grant=interpretationExact<Grant>(store,s.grant,'owner-session-grant');
  requireCondition(grant.value.contract==='interpretation-choice-grant/v1' && grant.value.database===s.database
    && same(grant.value.scope,scope) && session.id===`interpretation-choice-session:${hashJson(s.grant)}`
    && s.openedAt>=grant.value.issuedAt && s.openedAt<grant.value.expiresAt,
    'owner_authority_required','The saved session lost its trusted scoped invitation');
  return session;
}
export function proveInterpretationOwnerDecision(store:Store, decision:InterpretationDecision):void {
  requireCondition(decision.origin.kind==='owner','owner_authority_required','An owner decision needs its owner origin');
  sessionProof(store,decision.origin.session,{project:decision.project,generation:decision.generation,
    interpretation:decision.choice.interpretation!,justification:decision.choice.justification!});
}
export function chooseInterpretation(store:Store,input:unknown,authority:unknown):Revision<InterpretationDecision> {
  const scope=validateInterpretationChoice(store,input), cap=typeof authority==='object' && authority!==null ? live.get(authority) : null;
  requireCondition(cap && cap.store===store && cap.valid() && same(cap.scope,scope),
    'owner_authority_required','Only a live trusted authority for this exact choice can act');
  const session=sessionProof(store,cap.session,scope);
  requireCondition(Date.now()<session.value.expiresAt,'owner_authority_expired','The scoped owner session has expired');
  const generated=readInterpretationExecutionAt(store,scope.project,scope.generation);
  const p=readFrameInterpretationSession(store,scope.project,generated.value.prepared);
  const subject=prepareFrameInterpretationChoiceSubject(store,{project:scope.project,frame:p.value.frame,mandate:p.value.brief},generated.value.result);
  const body={contract:FRAME_INTERPRETATION_CHOICE,project:scope.project,set:subject.result.answer,mandate:p.value.brief,
    frame:p.value.frame,previous:null,outcome:'chosen',interpretation:scope.interpretation,justification:scope.justification};
  const choice=projectFrameInterpretationChoice(subject,{...body,identity:`frame-interpretation-choice:${hashJson(body)}`}).choice.value;
  const id=`interpretation-decision:${hashJson(scope.generation)}`,existing=store.get<InterpretationDecision>(id);
  if(existing) { requireCondition(same(existing.value.choice,choice),'interpretation_choice_stale','This generation already has a different choice'); return structuredClone(existing); }
  const mode=readProjectMode(store,scope.project);
  requireCondition(mode.mode==='questions','interpretation_mode_invalid','Owner choice requires current questions mode');
  const value:InterpretationDecision={contract:'interpretation-decision/v1',project:scope.project,generation:scope.generation,choice,
    origin:{kind:'owner',session:cap.session}};
  return store.writeMany<InterpretationDecision>([{id,kind:'interpretation-decision',expected:0,value}],
    [cap.session,mode.ref,scope.generation,p.value.request.subject.frame.question,p.value.request.subject.frame.draft,{id,absent:true}])[0]!;
}

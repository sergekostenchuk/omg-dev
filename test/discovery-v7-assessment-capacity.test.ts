import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson } from '../src/canonical.js';
import { V7_ATTEMPT_PACKET_CONTRACT, V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { assessmentSubjectKey, ATTEMPTS_ASSESSMENT_INSTRUCTION, type AssessmentTransportSubject } from '../src/discovery/continuation-packet.js';
import { researchCapacityInput, resultCapacityFrom, requireResultCapacity, requireAttemptsAssessmentReply,
  researchResultFailure } from '../src/discovery/early-research-outcome.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';

// Pure capacity arithmetic: no record below stands for a proved packet. The
// context suite obtains one from the real managed producer and the M/K reader.
const ref=(id:string)=>({id,revision:1,hash:'a'.repeat(64)});
const subject:AssessmentTransportSubject={kind:'attempts',packet:{contract:V7_ATTEMPT_PACKET_CONTRACT,
  project:'p',planAnswer:ref('plan-answer'),planQuestionId:'q1',question:ref('question'),
  entries:[{attempt:ref('attempt'),binding:ref('binding')}]},
  baseline:{contract:V7_PROGRESS_BASELINE_CONTRACT,state:{kind:'absent',id:'state'},materials:[]}};
const draft={projectId:'p',stage:'discovery',level:'R0',consumer:'concept',contractVersion:7,inputs:[]} as unknown as DiscoveryDraft;
const question={id:'question',value:{projectId:'p',draftId:'draft',spec:{field:'plan',prompt:'Plan the research',kind:'design',risk:'omission',
  schema:{type:'object',required:['questions']}}} as unknown as Question};
const binding={actor:'assessor',model:'fixture',effort:'high' as const,command:{executable:'fixture',args:[]}};
const input=(assessmentSubject=subject,limit=20000)=>researchCapacityInput({operation:'assessment-op',generation:0,
  bindings:{projectId:'p',draft:ref('draft'),question:ref('question'),assessmentSubject},role:'assessor',purpose:'assessor',
  actionMode:'assess-attempts',limit,prompt:ATTEMPTS_ASSESSMENT_INSTRUCTION,binding,draft,question,context:{assessmentSubject}});
const result={verdict:'return',reasons:['No new material'],return:{target:{attempt:ref('attempt')},reason:'No evidence'},novelty:{
  attempts:[{attempt:ref('attempt'),reason:'No evidence'}],accepted:[],rejected:[],newContent:[],duplicates:[],
  noProgress:[{attempt:ref('attempt'),reason:'No evidence'}],transition:null}};

test('T capacity binds packet/baseline and uses the attempts reply contract instead of the plan FieldSpec',()=>{
  const proposal=input(),capacity=resultCapacityFrom(proposal),wire=proposal.mandatoryEnvelope as any;
  assert.deepEqual(capacity.bindings.assessmentSubject,subject);
  assert.deepEqual(wire.subject.assessmentSubject,subject);
  assert.deepEqual(wire.subject.question.basis,subject.packet.question);
  assert.equal(wire.subject.question.id,'q1');assert.equal(wire.subject.question.field,undefined);
  assert.deepEqual(wire.subject.question.schema.required,['verdict','reasons','return','novelty']);
  assert.deepEqual(capacity.forms.map(f=>f.kind),['verdict','assessment_checkpoint','read_context']);
  assert.deepEqual(requireResultCapacity(capacity,proposal),capacity);
  assert.equal(requireAttemptsAssessmentReply(result),undefined);
  assert.equal(researchResultFailure(capacity,result),null);
});

test('T capacity cannot reuse an admission for another packet or baseline',()=>{
  const capacity=resultCapacityFrom(input());
  for(const changed of [
    {...subject,packet:{...subject.packet,entries:[{attempt:ref('other-attempt'),binding:ref('other-binding')}]}},
    {...subject,baseline:{...subject.baseline,state:{kind:'state' as const,ref:ref('state')}}}
  ]) {
    assert.notEqual(assessmentSubjectKey(changed),assessmentSubjectKey(subject));
    assert.notEqual(hashJson(input(changed).mandatoryEnvelope),hashJson(input().mandatoryEnvelope));
    assert.throws(()=>requireResultCapacity(capacity,input(changed)),{code:'research_capacity_invalid'});
  }
});

test('T capacity measures mandatory novelty and refuses an oversized result without increasing limits',()=>{
  const capacity=resultCapacityFrom(input()),large={...result,novelty:{...result.novelty,
    attempts:[{attempt:ref('attempt'),reason:'я'.repeat(25000)}]}};
  const failure=researchResultFailure(capacity,large);
  assert.ok(failure);assert.equal(failure.code,'research_result_capacity');
  assert.equal(capacity.envelopeLimitChars,20000);
  assert.throws(()=>resultCapacityFrom(input(subject,1000)),{code:'research_capacity_configuration'});
  for(const novelty of [undefined,null,{}, {...result.novelty,noProgress:undefined}]) {
    assert.throws(()=>requireAttemptsAssessmentReply({...result,novelty}),{code:'discovery_novelty_invalid'});
  }
});

test('T malformed capacity subjects have a typed refusal and cannot fall back to v6',()=>{
  for(const value of [null,{}, {...subject,kind:'answer'}, {...subject,packet:{}}, {...subject,baseline:{}}])
    assert.throws(()=>input(value as any),{code:'discovery_assessment_subject_invalid'});
});

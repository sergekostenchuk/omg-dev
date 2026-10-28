import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { readEnvironmentAt, uniqueTransactionGuards, type Environment } from '../runtime/environment.js';
import type { Revision, Store } from '../storage/store.js';
import { captureView } from '../storage/store-view.js';
import { readProjectMode } from '../product/project-mode.js';
import { Discovery, readAcceptedResearchAnswer, type DiscoveryDraft, type Question } from './discovery.js';
import { frameInterpretationsId } from './frame-interpretations.js';
import { FRAME_INTERPRETATION_INSTRUCTION } from './frame-interpretation-request.js';
import { collectFrameInterpretationSubject, type FrameSubjectRequest } from './frame-interpretation-subject.js';
import { prepareFrameInterpretationEnvelope } from './frame-interpretation-packing.js';
import { prepareFrameInterpretationSession, readFrameInterpretationSession } from './interpretation-session.js';
import { prepareInterpretationExecution, readInterpretationExecutionAt, runInterpretationExecution,
  interpretationExact, sameInterpretation, readInterpretationDecisionAt,
  type InterpretationExecution, type InterpretationDecision } from './interpretation-execution.js';
import { assessAnswer } from './research-assessment.js';
import { withChildInvocationAllowance } from './invocation-progress.js';
import { withInterpretationRestoreOnly } from './interpretation-execution.js';

export interface InterpretationFlowInput {project:string;draft:Ref;frame:Ref}
export interface InterpretationFlowOptions {allowance:number;restoreOnly:boolean;signal?:AbortSignal}
export interface InterpretationContinuation {draft:Ref;frame:Ref;generation:Ref|null;set:Ref|null;decision:Ref|null;application:Ref|null}
export type InterpretationFlowResult =
  | {kind:'ready';outcome:'no_divergence'|'material';sourceFrame:Ref;draft:Ref;frame:Ref;basis:Ref;callsUsed:number}
  | {kind:'owner_required'|'pending'|'refused';sourceFrame:Ref;code:string;reason:string;continuation:InterpretationContinuation;callsUsed:number};
interface Application {contract:'interpretation-application/v1';project:string;generation:Ref;decision:Ref;proposal:Ref;before:Ref;opened:Ref}
interface Ready {contract:'interpretation-ready/v1';project:string;generation:Ref;application:Ref|null;draft:Ref;frame:Ref}
const readyId=(generation:Ref)=>`interpretation-ready:${hashJson(generation)}`;
const applicationId=(generation:Ref)=>`interpretation-application:${hashJson(generation)}`;
const clone=<T>(v:T):T=>JSON.parse(canonical(v));
const modelCalls=(store:Store,project:string)=>store.list<{projectId:string}>('model-call').filter(r=>r.value.projectId===project).length;
function subjectRequest(store:Store, input:InterpretationFlowInput):FrameSubjectRequest {
  const draft=interpretationExact<DiscoveryDraft>(store,input.draft,'discovery-draft');
  requireCondition(draft.value.projectId===input.project && draft.value.contractVersion===7,
    'interpretation_input_invalid','Interpretations need the exact Discovery v7 draft');
  const questions=draft.value.questions.map(id=>store.get<Question>(id)!);
  const frame=questions.find(q=>q.value.spec.field==='frame'),brief=questions.find(q=>q.value.spec.field==='brief');
  requireCondition(frame && brief?.value.answer,'interpretation_basis_missing','The accepted frame and mandate are required');
  requireCondition(sameInterpretation(reference(store.get(draft.id)!), input.draft) && sameInterpretation(frame.value.answer,input.frame),
    'interpretation_input_stale','New generation needs the current exact accepted draft and frame');
  const fact=store.get<any>(brief.value.answer.id,brief.value.answer.revision);
  requireCondition(fact?.kind==='fact' && sameInterpretation(reference(fact),brief.value.answer) && fact.value.observation,
    'interpretation_basis_missing','The verbatim mandate needs its saved source observation');
  const request={project:input.project,frame:input.frame,
    mandate:{source:fact.value.observation.source,selector:fact.value.observation.selector}};
  const subject=collectFrameInterpretationSubject(store,request);
  requireCondition(subject.frame.draft.id===draft.id && sameInterpretation(subject.frame.draft.value.fields.frame,draft.value.fields.frame),
    'interpretation_input_invalid','The exact draft and accepted frame must agree');
  return request;
}
function findGeneration(store:Store,input:InterpretationFlowInput):Revision<InterpretationExecution>|null {
  for(const row of store.list<InterpretationExecution>('interpretation-execution')) {
    if(row.value.project!==input.project || row.value.phase!=='generate' || row.value.draft.id!==input.draft.id) continue;
    const p=readFrameInterpretationSession(store,input.project,row.value.prepared);
    if(sameInterpretation(p.value.frame,input.frame)) return readInterpretationExecutionAt(store,input.project,reference(row));
  }
  return null;
}
function prepareGeneration(store:Store,input:InterpretationFlowInput) {
  const old=findGeneration(store,input); if(old)return old;
  const request=subjectRequest(store,input);
  const environment=store.get<Environment>(`environment:${input.project}`);
  requireCondition(environment,'environment_missing','Configure the project environment');
  readEnvironmentAt(store,input.project,reference(environment));
  const limitChars=environment.value.requestCapacityChars??300000;
  const packing={prompt:FRAME_INTERPRETATION_INSTRUCTION,packetChars:Math.floor(limitChars/2),limitChars,
    role:environment.value.implementer,environment:environment.value};
  const envelope=prepareFrameInterpretationEnvelope(store,request,packing);
  const prepared=prepareFrameInterpretationSession(store,request,packing,envelope);
  return prepareInterpretationExecution(store,reference(prepared),'generate');
}
async function finishExecution(store:Store,row:Revision<InterpretationExecution>,options:InterpretationFlowOptions) {
  while(row.value.result===null) row=await runInterpretationExecution(store,reference(row),options.restoreOnly,options.signal);
  return row;
}
function readApplication(store:Store,project:string,ref:Ref):Revision<Application> {
  const row=interpretationExact<Application>(store,ref,'interpretation-application'),v=row.value;
  requireCondition(v?.contract==='interpretation-application/v1' && v.project===project && row.id===applicationId(v.generation),
    'interpretation_application_invalid','The application needs its exact generation');
  const decision=readInterpretationDecisionAt(store,project,v.decision);
  const proposal=readInterpretationExecutionAt(store,project,v.proposal);
  const before=interpretationExact<Question>(store,v.before,'question'),opened=interpretationExact<Question>(store,v.opened,'question');
  requireCondition(sameInterpretation(decision.value.generation,v.generation) && proposal.value.phase==='frame'
    && sameInterpretation(proposal.value.decision,v.decision) && proposal.value.result!==null
    && before.id===opened.id && opened.revision===before.revision+1 && opened.value.status==='open'
    && opened.value.answer===null && before.value.projectId===project,
    'interpretation_application_invalid','The reopened frame must derive from the chosen paid proposal');
  return row;
}
function openFrame(store:Store,generation:Revision<InterpretationExecution>,decision:Ref,proposal:Ref):Revision<Application> {
  const id=applicationId(reference(generation)),old=store.get<Application>(id);
  if(old)return readApplication(store,generation.value.project,reference(old));
  const before=store.get<Question>(generation.value.question.id)!;
  requireCondition(sameInterpretation(reference(before),generation.value.question),
    'interpretation_input_stale','The frame changed before applying its interpretation');
  const capture=captureView(store),opened=new Discovery(capture.view).reopen(before.id,before.revision);
  const value:Application={contract:'interpretation-application/v1',project:generation.value.project,generation:reference(generation),
    decision,proposal,before:reference(before),opened:reference(opened)};
  const written=store.writeMany([...capture.writes,{id,kind:'interpretation-application',expected:0,value}],
    uniqueTransactionGuards([...capture.guards,reference(before),decision,proposal,{id,absent:true}]));
  return written.at(-1)! as unknown as Revision<Application>;
}

export async function readInterpretationFlowReadyAt(store:Store,project:string,basis:Ref):Promise<Extract<InterpretationFlowResult,{kind:'ready'}>> {
  const row=interpretationExact<Ready>(store,basis,'interpretation-ready'),v=row.value;
  requireCondition(v?.contract==='interpretation-ready/v1' && v.project===project && row.id===readyId(v.generation),
    'interpretation_ready_invalid','The readiness record needs its exact generated result');
  const generated=readInterpretationExecutionAt(store,project,v.generation);
  const p=readFrameInterpretationSession(store,project,generated.value.prepared);
  const result=generated.value.result as {outcome:'no_divergence'|'material'}|null;
  requireCondition(generated.value.phase==='generate' && result!==null,'interpretation_ready_invalid','Readiness needs paid generation');
  const accepted=readAcceptedResearchAnswer(store,project,v.frame);
  const draft=interpretationExact<DiscoveryDraft>(store,v.draft,'discovery-draft');
  requireCondition(draft.value.projectId===project && sameInterpretation(draft.value.fields.frame,accepted.answer.value.value),
    'interpretation_ready_invalid','Readiness binds the accepted frame and its resulting draft');
  if(result.outcome==='no_divergence') {
    requireCondition(v.application===null && sameInterpretation(v.frame,p.value.frame)
      && sameInterpretation(v.draft,generated.value.draft),'interpretation_ready_invalid','No divergence keeps its original accepted frame');
  } else {
    requireCondition(v.application!==null,'interpretation_ready_invalid','Material divergence needs an applied choice');
    const app=readApplication(store,project,v.application);
    const proposal=readInterpretationExecutionAt(store,project,app.value.proposal);
    requireCondition(sameInterpretation(app.value.generation,v.generation) && sameInterpretation(proposal.value.result,accepted.answer.value.value)
      && accepted.assessment?.value.verdict==='supported' && sameInterpretation(accepted.assessment.value.question,app.value.opened),
      'interpretation_ready_invalid','The exact chosen frame still needs its independent supported assessment');
  }
  return {kind:'ready',outcome:result.outcome,sourceFrame:clone(p.value.frame),draft:clone(v.draft),frame:clone(v.frame),basis:reference(row),callsUsed:0};
}

export async function advanceInterpretationFlow(store:Store,input:InterpretationFlowInput,options:InterpretationFlowOptions):Promise<InterpretationFlowResult> {
  input=clone(input); options={...options};
  requireCondition(input && Object.keys(input).sort().join(',')==='draft,frame,project' && typeof input.project==='string'
    && isRef(input.draft) && isRef(input.frame) && Number.isSafeInteger(options.allowance) && options.allowance>=0
    && typeof options.restoreOnly==='boolean','interpretation_input_invalid','The flow needs exact draft/frame and a bounded invocation');
  let generation:Revision<InterpretationExecution>|null=null,decision:Ref|null=null,application:Ref|null=null;
  const before=modelCalls(store,input.project);
  const continuation=():InterpretationContinuation=>({draft:clone(input.draft),frame:clone(input.frame),
    generation:generation?reference(generation):null,set:generation?.value.result ? reference(store.get(frameInterpretationsId(generation.value.result as any))!) : null,decision,application});
  const work=async():Promise<InterpretationFlowResult>=>{
    try {
      // The applied frame is recognized before preparing any new generation.
      for(const row of store.list<Ready>('interpretation-ready')) if(row.value.project===input.project
        && row.value.draft.id===input.draft.id && (sameInterpretation(row.value.frame,input.frame)
          || sameInterpretation(readFrameInterpretationSession(store,input.project,
            readInterpretationExecutionAt(store,input.project,row.value.generation).value.prepared).value.frame,input.frame)))
        return await readInterpretationFlowReadyAt(store,input.project,reference(row));
      generation=findGeneration(store,input);
      if(!generation) {
        requireCondition(!options.restoreOnly && options.allowance>0,'interpretation_restore_only','Generation has no saved result to restore');
        generation=prepareGeneration(store,input);
      }
      generation=await finishExecution(store,generation,options);
      const p=readFrameInterpretationSession(store,input.project,generation.value.prepared);
      const result=generation.value.result as {outcome:'no_divergence'|'material'};
      let draft=interpretationExact<DiscoveryDraft>(store,generation.value.draft,'discovery-draft'),frame=p.value.frame;
      if(result.outcome==='material') {
        const decisionId=`interpretation-decision:${hashJson(reference(generation))}`;
        let chosen=store.get<InterpretationDecision>(decisionId);
        if(!chosen) {
          const mode=readProjectMode(store,input.project);
          if(mode.mode==='questions') return {kind:'owner_required',sourceFrame:p.value.frame,code:'interpretation_owner_required',
            reason:'Choose one of the saved material interpretations through the scoped owner door',continuation:continuation(),callsUsed:0};
          const choose=await finishExecution(store,prepareInterpretationExecution(store,reference(p),'choose',reference(generation)),options);
          const value:InterpretationDecision={contract:'interpretation-decision/v1',project:input.project,generation:reference(generation),
            choice:choose.value.result as InterpretationDecision['choice'],origin:{kind:'model',execution:reference(choose)}};
          chosen=store.writeMany<InterpretationDecision>([{id:decisionId,kind:'interpretation-decision',expected:0,value}],
            [reference(choose),{id:decisionId,absent:true}])[0]!;
        }
        decision=reference(readInterpretationDecisionAt(store,input.project,reference(chosen)));
        const proposal=await finishExecution(store,prepareInterpretationExecution(store,reference(p),'frame',reference(generation),decision),options);
        const app=openFrame(store,generation,decision,reference(proposal)); application=reference(app);
        const q=interpretationExact<Question>(store,app.value.opened,'question'),head=store.get<Question>(q.id)!;
        if(head.value.status==='answered' && head.value.answer) {
          const accepted=readAcceptedResearchAnswer(store,input.project,head.value.answer);
          requireCondition(sameInterpretation(accepted.answer.value.value,proposal.value.result)
            && sameInterpretation(accepted.assessment?.value.question,reference(q)),
            'interpretation_input_stale','A different frame was accepted while applying the interpretation');
          frame=head.value.answer; draft=store.get<DiscoveryDraft>(q.value.draftId)!;
        } else {
          const env=readEnvironmentAt(store,input.project,p.value.environment);
          const assessed=await assessAnswer(store,q,{action:'answer',question:q.id,value:proposal.value.result as Json,citations:[]},env,env.value.workspace,options.signal);
          requireCondition(assessed.value.verdict==='supported','interpretation_frame_unsupported','The revised frame is not supported by the common assessor');
          draft=new Discovery(store).researched(q.id,q.revision,reference(assessed));
          frame=store.get<Question>(q.id)!.value.answer!;
        }
      }
      const value:Ready={contract:'interpretation-ready/v1',project:input.project,generation:reference(generation),application,
        draft:reference(draft),frame};
      const id=readyId(reference(generation)),existing=store.get<Ready>(id);
      const saved=existing??store.writeMany<Ready>([{id,kind:'interpretation-ready',expected:0,value}],
        [reference(generation),reference(draft),{id,absent:true}])[0]!;
      return await readInterpretationFlowReadyAt(store,input.project,reference(saved));
    } catch(error) {
      if(!(error instanceof EngineError))throw error;
      const pending=['interpretation_restore_only','research_call_allowance','budget_estimate_missing','research_consumer_execution_running',
        'interpretation_frame_unsupported','research_stage_budget_exhausted','discovery_budget_exhausted'].includes(error.code);
      return {kind:pending?'pending':'refused',sourceFrame:clone(input.frame),code:error.code,reason:error.message,
        continuation:continuation(),callsUsed:0};
    }
  };
  // A restore-only scope is checked by the common carrier after paid early returns, before a new send.
  const result=await withInterpretationRestoreOnly(options.restoreOnly||options.allowance===0,()=>
    withChildInvocationAllowance(Math.max(1,options.allowance),work));
  return {...result,callsUsed:modelCalls(store,input.project)-before};
}

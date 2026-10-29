import { historicalProof } from '../history/proofs.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { readEnvironmentAt, resolveRoleMode, uniqueTransactionGuards } from '../runtime/environment.js';
import type { Revision, Store, TransactionGuard, Write } from '../storage/store.js';
import { readProjectMode } from '../product/project-mode.js';
import { type DiscoveryDraft, type Question } from './discovery.js';
import { frameInterpretationsId } from './frame-interpretations.js';
import { checkFrameInterpretationResult } from './frame-interpretation-transport.js';
import { prepareFrameInterpretationChoiceSubject, projectFrameInterpretationChoice, FRAME_INTERPRETATION_CHOICE } from './frame-interpretation-choice.js';
import { readFrameInterpretationSession, type FrameInterpretationSession } from './interpretation-session.js';
import { V7_FRAME_SCHEMA, V7_FRAME_FIELD, checkV7FieldAnswer } from './v7-contracts.js';
import { researchAction, researchCall } from './research-protocol.js';
import { contextWorkspace, contextProgress, addContextLookup, requireCompleteContextPacket, type ContextWorkspace } from './context-workspace.js';
import { readResearchContextOutcomeAt, findResearchConsumerIntent, prepareResearchConsumerIntent,
  readResearchConsumerIntent, readResearchConsumerExecution, resumeResearchConsumerExecution,
  prepareResearchConsumerApplication, type ResearchConsumerIntent, type ResearchConsumerExecution } from './response-recovery.js';
import { managedCorrectionBaseContext } from './response-recovery.js';

export const INTERPRETATION_EXECUTION = 'interpretation-execution/v1';
export type InterpretationPhase = 'generate' | 'choose' | 'frame';
export interface InterpretationExecution {
  contract: typeof INTERPRETATION_EXECUTION; project: string; prepared: Ref;
  phase: InterpretationPhase; generation: Ref | null; decision: Ref | null; mode: Ref;
  draft: Ref; question: Ref; step: number; workspace: ContextWorkspace;
  previous: Ref | null; result: unknown | null;
}
export const sameInterpretation = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function interpretationExact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  requireCondition(isRef(ref), 'interpretation_basis_missing', `An exact ${kind} is required`);
  const row = store.get<T>(ref.id, ref.revision);
  requireCondition(row?.kind === kind && sameInterpretation(reference(row), ref) && hashJson(row.value) === ref.hash,
    'interpretation_basis_missing', `The exact ${kind} is missing or changed`);
  return row;
}
export const interpretationPurpose = (phase: InterpretationPhase) =>
  phase === 'generate' ? 'frame-interpretation-request' as const : 'frame-interpretation-choice' as const;
export const isInterpretationConsumer = (v: {kind: string}): boolean =>
  ['frame-interpretation-request', 'frame-interpretation-choice'].includes(v.kind);
const source = (p: FrameInterpretationSession) => ({project: p.project, frame: p.frame, mandate: p.brief, previousSet: p.previousSet});
const executionId = (p: FrameInterpretationSession, phase: InterpretationPhase, generation: Ref | null, decision: Ref | null) =>
  `interpretation-execution:${hashJson([p.project, p.request.request, phase, generation, decision])}`;

export function readInterpretationExecutionAt(store: Store, project: string, ref: Ref): Revision<InterpretationExecution> {
  const exact = JSON.parse(canonical(ref)) as Ref;
  requireCondition(isRef(exact), 'interpretation_basis_missing', 'An exact interpretation execution is required');
  return structuredClone(historicalProof(store, {reader:'interpretation.execution-read/v1',project,ref:exact},
    source=>deriveInterpretationExecutionAt(source,project,exact),
    ()=>{ throw new EngineError('interpretation_execution_invalid','The historical execution proof is cyclic'); }));
}
function deriveInterpretationExecutionAt(store: Store, project: string, ref: Ref): Revision<InterpretationExecution> {
  const row = interpretationExact<InterpretationExecution>(store, ref, 'interpretation-execution'), v = row.value;
  requireCondition(v?.contract === INTERPRETATION_EXECUTION && v.project === project
    && ['generate','choose','frame'].includes(v.phase) && Number.isSafeInteger(v.step) && v.step >= 0
    && (v.generation === null || isRef(v.generation)) && (v.decision === null || isRef(v.decision)),
    'interpretation_execution_invalid', 'The execution lost its closed phase and exact grounds');
  const prepared = readFrameInterpretationSession(store, project, v.prepared);
  requireCondition(row.id === executionId(prepared.value, v.phase, v.generation, v.decision)
    && sameInterpretation(v.question, reference(prepared.value.request.subject.frame.question))
    && v.draft.id === prepared.value.request.subject.frame.draft.id,
    'interpretation_execution_invalid', 'The execution does not belong to its complete prepared request');
  interpretationExact<DiscoveryDraft>(store, v.draft, 'discovery-draft');
  readProjectMode(store, project, v.mode);
  if (v.generation) {
    const generated = readInterpretationExecutionAt(store, project, v.generation);
    requireCondition(generated.value.phase === 'generate' && generated.value.result !== null
      && sameInterpretation(generated.value.prepared, v.prepared), 'interpretation_generation_unproven', 'The chosen set needs its paid generation');
  }
  if (v.decision) {
    const decision = readInterpretationDecisionAt(store, project, v.decision);
    requireCondition(v.phase === 'frame' && sameInterpretation(decision.value.generation, v.generation),
      'interpretation_decision_invalid', 'The applied decision belongs to another generated set');
  }
  if (row.revision === 1) {
    requireCondition(v.step === 0 && v.previous === null && v.result === null
      && sameInterpretation(v.workspace, contextWorkspace(undefined, null)),
      'interpretation_execution_invalid', 'An initial execution cannot claim a paid result');
  } else {
    requireCondition(isRef(v.previous), 'interpretation_execution_invalid', 'The applied execution needs its paid intent');
    const intent = readResearchConsumerIntent(store, v.previous);
    const head = store.get<ResearchConsumerIntent>(intent.id)!;
    requireCondition(head.value.state === 'applied' && head.value.outputs?.some(r => sameInterpretation(r, ref)),
      'interpretation_execution_invalid', 'The execution is not a saved managed output');
    const paid = readResearchConsumerExecution(store, project, reference(head));
    const projected = interpretationApplication(store, intent, paid);
    requireCondition(sameInterpretation(projected[0]?.value, v) && projected[0]?.expected === row.revision - 1,
      'interpretation_execution_invalid', 'The execution differs from its paid projection');
  }
  return structuredClone(row);
}

export function interpretationContext(store: Store, row: Revision<InterpretationExecution>) {
  const v = row.value, prepared = readFrameInterpretationSession(store, v.project, v.prepared);
  const context: Record<string, unknown> = { interpretationExecution: reference(store.get(row.id, 1)!), interpretationPhase: v.phase,
    frameRequest: prepared.value.request };
  if (v.generation) {
    const generated = readInterpretationExecutionAt(store, v.project, v.generation);
    context.choiceSubject = prepareFrameInterpretationChoiceSubject(store, source(prepared.value), generated.value.result);
  }
  if (v.decision) {
    context.decisionRef = v.decision;
    context.decision = readInterpretationDecisionAt(store, v.project, v.decision).value;
    context.frameSchema = V7_FRAME_SCHEMA;
  }
  return {interpretationExecution:reference(row),role:interpretationPurpose(v.phase),purpose:interpretationPurpose(v.phase),
    request:context,contextWorkspace:v.workspace.entries.map(e=>e.result),focus:null,history:[]};
}
const promptFor = (v: InterpretationExecution, prepared: FrameInterpretationSession) => v.phase === 'generate'
  ? prepared.request.instruction
  : v.phase === 'choose'
  ? 'Choose one interpretation from the exact choiceSubject. Return only {action:"choose",interpretation:"exact member id",justification:"reason"}. The producer binds this answer to the exact set and computes the content identity. Preserve all exact bindings and justify the choice. A recommendation is not an owner act. You may request read_context for remaining original material.'
  : 'Produce the revised Discovery frame for the exact saved decision and its selected interpretation. Preserve the original mandate and unaffected frame content. Return only {action:"frame",decision: the exact supplied decision Ref,value: complete frame satisfying frameSchema}. You may request read_context for remaining material. This proposal still requires independent frame assessment.';

/** Subject proof is shared by preparation, physical admission and historical application. */
export function requireInterpretationConsumer(store: Store, intent: ResearchConsumerIntent, current = false): TransactionGuard[] {
  requireCondition(isInterpretationConsumer(intent), 'interpretation_execution_invalid', 'This is not an interpretation consumer');
  const row = readInterpretationExecutionAt(store, intent.projectId, intent.owner), v = row.value;
  const p = readFrameInterpretationSession(store, v.project, v.prepared);
  const environment = readEnvironmentAt(store, v.project, p.value.environment);
  const role = resolveRoleMode('implementer', p.value.role, 'research');
  requireCondition(intent.kind === interpretationPurpose(v.phase) && intent.key === `${row.id}:${v.step}`
    && intent.cursor.sessionId === row.id && intent.cursor.offset === v.step
    && sameInterpretation(intent.draft, v.draft) && sameInterpretation(intent.question, v.question)
    && sameInterpretation(intent.role, role) && sameInterpretation(intent.dispatch, environment.value)
    && sameInterpretation(managedCorrectionBaseContext(store, intent), interpretationContext(store, row))
    && intent.cursor.prompt === promptFor(v, p.value),
    'interpretation_execution_invalid', 'The dispatch must retain its entire exact subject, role and original instruction');
  if (!current) return [];
  const draft = interpretationExact<DiscoveryDraft>(store, v.draft, 'discovery-draft');
  const question = interpretationExact<Question>(store, v.question, 'question');
  requireCondition(sameInterpretation(reference(store.get(draft.id)!), v.draft)
    && sameInterpretation(reference(store.get(question.id)!), v.question)
    && sameInterpretation(question.value.answer, p.value.frame) && draft.value.fields.plan === null,
    'interpretation_input_stale', 'New interpretation work requires the current accepted frame before the first plan');
  const mode = readProjectMode(store, v.project);
  requireCondition(v.phase !== 'choose' || mode.mode === 'bypass' && sameInterpretation(mode.ref, v.mode),
    'interpretation_owner_required', 'Only the exact bypass mode admits model choice');
  const decisionId = v.generation ? `interpretation-decision:${hashJson(v.generation)}` : null;
  requireCondition(v.phase !== 'choose' || !store.get(decisionId!), 'interpretation_choice_stale', 'This generation already has a saved choice');
  return uniqueTransactionGuards([v.draft, v.question, p.value.environment,
    ...(v.phase === 'choose' ? [mode.ref, {id:decisionId!,absent:true as const}] : [])]);
}

export function prepareInterpretationExecution(store: Store, preparedRef: Ref, phase: InterpretationPhase,
  generation: Ref | null = null, decision: Ref | null = null): Revision<InterpretationExecution> {
  const raw = interpretationExact<FrameInterpretationSession>(store, preparedRef, 'frame-interpretation-session');
  const p = readFrameInterpretationSession(store, raw.value.project, preparedRef), project = p.value.project;
  const id = executionId(p.value, phase, generation, decision), existing = store.get<InterpretationExecution>(id);
  if (existing) return readInterpretationExecutionAt(store, project, reference(existing));
  const draft = store.get<DiscoveryDraft>(p.value.request.subject.frame.draft.id)!;
  const mode = readProjectMode(store, project);
  const value: InterpretationExecution = {contract: INTERPRETATION_EXECUTION, project, prepared: preparedRef,
    phase, generation, decision, mode: mode.ref, draft: reference(draft), question: reference(p.value.request.subject.frame.question),
    step: 0, workspace: contextWorkspace(undefined, null), previous: null, result: null};
  requireCondition(phase === 'generate' ? generation === null && decision === null
    : isRef(generation) && (phase === 'choose' ? decision === null && mode.mode === 'bypass' : isRef(decision)),
    'interpretation_execution_invalid', 'The phase requires its proven predecessor and applicable mode');
  if (generation) {
    const prior = readInterpretationExecutionAt(store, project, generation);
    requireCondition(prior.value.phase === 'generate' && prior.value.result !== null && sameInterpretation(prior.value.prepared, preparedRef),
      'interpretation_generation_unproven', 'The next phase needs its exact completed generation');
  }
  if (decision) requireCondition(sameInterpretation(readInterpretationDecisionAt(store, project, decision).value.generation, generation),
    'interpretation_decision_invalid', 'The choice belongs to another generation');
  const saved = store.writeMany<InterpretationExecution>([{id,kind:'interpretation-execution',expected:0,value}],
    [reference(draft), value.question, {id,absent:true}])[0]!;
  return readInterpretationExecutionAt(store, project, reference(saved));
}

/** Pure projection used both by the common application gate and the historical reader. */
export function interpretationApplication(store: Store, intent: Revision<ResearchConsumerIntent>, paid: ResearchConsumerExecution): Write[] {
  if (intent.value.state === 'applied') intent = readResearchConsumerIntent(store, reference(store.get(intent.id, intent.revision - 1)!));
  requireCondition(paid.kind === 'response', 'interpretation_response_missing', 'The managed call has no paid response');
  const owner = readInterpretationExecutionAt(store, intent.value.projectId, intent.value.owner), v = owner.value;
  requireInterpretationConsumer(store, intent.value);
  const prepared = readFrameInterpretationSession(store, v.project, v.prepared);
  let workspace = v.workspace, result: unknown | null = null;
  const answer = paid.payload as Record<string, unknown>;
  if (answer?.action === 'read_context') {
    const action = researchAction(answer);
    requireCondition(action.action === 'read_context', 'interpretation_response_invalid', 'Expected an exact context read');
    const draft = interpretationExact<DiscoveryDraft>(store, v.draft, 'discovery-draft');
    const question = interpretationExact<Question>(store, v.question, 'question');
    const read = readResearchContextOutcomeAt(store, draft, question, action, prepared.value.input.limitChars, 'bounded');
    workspace = addContextLookup(workspace, read, paid.subject.contextWorkspace, undefined, paid.subject);
  } else {
    requireCompleteContextPacket(workspace, paid.subject);
    if (v.phase === 'generate') result = checkFrameInterpretationResult(store, source(prepared.value), answer).answer.value;
    else if (v.phase === 'choose') {
      const generated = readInterpretationExecutionAt(store, v.project, v.generation!);
      const subject = prepareFrameInterpretationChoiceSubject(store, source(prepared.value), generated.value.result);
      requireCondition(answer && Object.keys(answer).sort().join(',')==='action,interpretation,justification' && answer.action==='choose',
        'interpretation_choice_invalid','The model must return only the selected member and its justification');
      const body={contract:FRAME_INTERPRETATION_CHOICE,project:v.project,set:subject.result.answer,mandate:prepared.value.brief,
        frame:prepared.value.frame,previous:null,outcome:'chosen',interpretation:answer.interpretation,justification:answer.justification};
      result = projectFrameInterpretationChoice(subject, {...body,identity:`frame-interpretation-choice:${hashJson(body)}`}).choice.value;
    } else {
      requireCondition(answer && Object.keys(answer).sort().join(',') === 'action,decision,value'
        && answer.action === 'frame' && sameInterpretation(answer.decision, v.decision),
        'interpretation_frame_invalid', 'The revised frame must bind the exact chosen interpretation');
      checkV7FieldAnswer(interpretationExact<DiscoveryDraft>(store, v.draft, 'discovery-draft').value, V7_FRAME_FIELD, answer.value as Json, () => { throw new EngineError('interpretation_frame_invalid','Unexpected non-frame proof'); }); result = structuredClone(answer.value);
    }
    workspace = contextProgress(workspace, paid.subject);
  }
  const value: InterpretationExecution = {...v,step:v.step+1,workspace,previous:reference(intent),result};
  return [{id:owner.id,kind:owner.kind,expected:owner.revision,value},
    ...(v.phase==='generate' && result!==null ? [{id:frameInterpretationsId(result as any),kind:'frame-interpretations',expected:0,value:result}] : [])];
}

export async function runInterpretationExecution(store: Store, ref: Ref, restoreOnly: boolean, signal?: AbortSignal) {
  let row = readInterpretationExecutionAt(store, interpretationExact<InterpretationExecution>(store,ref,'interpretation-execution').value.project, ref);
  if (row.value.result !== null) return row;
  const v = row.value, key = `${row.id}:${v.step}`;
  let intent = findResearchConsumerIntent(store, v.project, interpretationPurpose(v.phase), key, v.draft.id);
  if (!intent) {
    requireCondition(!restoreOnly, 'interpretation_restore_only', 'No paid interpretation step remains to restore');
    const p = readFrameInterpretationSession(store,v.project,v.prepared);
    const env = readEnvironmentAt(store,v.project,p.value.environment);
    const input = {projectId:v.project,kind:interpretationPurpose(v.phase),key,owner:reference(row),draft:v.draft,question:v.question,
      role:resolveRoleMode('implementer',p.value.role,'research'),dispatch:env.value,profile:null,
      cursor:{sessionId:row.id,offset:v.step,prompt:promptFor(v,p.value),context:interpretationContext(store,row)},
      basis:[v.prepared],guards:uniqueTransactionGuards([reference(row),v.draft,v.question,v.prepared,p.value.environment])};
    // The common reservation repeats this proof and keeps its guards in the CAS.
    intent = prepareResearchConsumerIntent(store,input);
  }
  if (intent.value.state === 'prepared') {
    requireCondition(!restoreOnly, 'interpretation_restore_only', 'A prepared step has no paid result');
    await researchCall(intent.value.role,intent.value.dispatch,intent.value.cursor.prompt,intent.value.cursor.context,signal,
      {store,draftId:v.draft.id,questionId:v.question.id,purpose:intent.value.kind,consumerIntent:reference(intent),session:intent.value.owner});
    intent = readResearchConsumerIntent(store,reference(store.get(intent.id)!));
  }
  if (intent.value.state === 'applied') return readInterpretationExecutionAt(store,v.project,intent.value.outputs![0]!);
  const paid = resumeResearchConsumerExecution(store,v.project,reference(intent));
  requireCondition(paid.kind === 'response','interpretation_response_missing','The saved call has no usable response');
  const writes = interpretationApplication(store,paid.intent,paid);
  const batch = prepareResearchConsumerApplication(store,reference(paid.intent),reference(paid.call),writes,[reference(row)]);
  row = store.writeMany<InterpretationExecution>(batch.writes,batch.guards)[0]!;
  return structuredClone(row);
}

// A durable decision has one of two explicit origins; ordinary JSON never produces an owner origin.
export interface InterpretationDecision {contract:'interpretation-decision/v1'; project:string; generation:Ref;
  choice:ReturnType<typeof projectFrameInterpretationChoice>['choice']['value'];
  origin:{kind:'model'; execution:Ref}|{kind:'owner'; session:Ref}; }
export function readInterpretationDecisionAt(store: Store, project: string, ref: Ref): Revision<InterpretationDecision> {
  const exact = JSON.parse(canonical(ref)) as Ref;
  requireCondition(isRef(exact), 'interpretation_basis_missing', 'An exact interpretation decision is required');
  return structuredClone(historicalProof(store, {reader:'interpretation.decision-read/v1',project,ref:exact},
    source=>deriveInterpretationDecisionAt(source,project,exact),
    ()=>{ throw new EngineError('interpretation_decision_invalid','The historical decision proof is cyclic'); }));
}
function deriveInterpretationDecisionAt(store: Store, project: string, ref: Ref): Revision<InterpretationDecision> {
  const row = interpretationExact<InterpretationDecision>(store,ref,'interpretation-decision'), v=row.value;
  requireCondition(v?.contract==='interpretation-decision/v1' && v.project===project,
    'interpretation_decision_invalid','The decision belongs to another project');
  const generation=readInterpretationExecutionAt(store,project,v.generation);
  const p=readFrameInterpretationSession(store,project,generation.value.prepared);
  const subject=prepareFrameInterpretationChoiceSubject(store,source(p.value),generation.value.result);
  projectFrameInterpretationChoice(subject,v.choice);
  requireCondition(row.id===`interpretation-decision:${hashJson(v.generation)}` && row.revision===1,
    'interpretation_decision_invalid','One generation has one immutable choice');
  if(v.origin.kind==='model') {
    const execution=readInterpretationExecutionAt(store,project,v.origin.execution);
    requireCondition(execution.value.phase==='choose' && sameInterpretation(execution.value.generation,v.generation)
      && sameInterpretation(execution.value.result,v.choice),'interpretation_decision_invalid','The choice needs its exact paid model result');
  } else {
    // The scoped authority module checks the grant/session and chosen value, including historical revocation semantics.
    proveInterpretationOwnerDecision(store,v);
  }
  return structuredClone(row);
}
import { proveInterpretationOwnerDecision } from '../product/interpretation-authority.js';

const restoreScope = new AsyncLocalStorage<boolean>();
export function withInterpretationRestoreOnly<T>(restoreOnly:boolean,work:()=>Promise<T>):Promise<T> {
  return restoreScope.run(restoreOnly || restoreScope.getStore() === true, work);
}
export function requireInterpretationNewDispatch():void {
  requireCondition(restoreScope.getStore() !== true,'interpretation_restore_only','Only the saved paid result may be restored');
}

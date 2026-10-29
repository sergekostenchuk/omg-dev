import { canonical } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import type { ReaderPilot } from './reader-pilot.js';
import { withChildInvocationAllowance } from './invocation-progress.js';
import { projectProducerSelection, withProjectProducerSelection } from './project-producer-policy.js';
import { researchCall } from './research-protocol.js';
import { consumerIntentContext, prepareResearchConsumerIntent, readManagedResponseCorrection, managedResponseFormFailure,
  readResearchConsumerIntent, type ResearchConsumerIntentInput } from './response-recovery.js';
import { applyVariantSession } from './variant-session.js';
import { runInterpretationExecution } from './interpretation-execution.js';
import { DOSSIER_APPLICATION, retryDossierResponse, retryAttemptAssessmentResponse } from './assessment-session.js';
import {retryFinalRoleResponse} from './final-response-correction.js';

async function applyOriginalRole(store: Store, project: string,
  selected: ReturnType<typeof readResearchConsumerIntent>) {
  if (selected.value.kind === 'variant-proposal' || selected.value.kind === 'variant-decision')
    return reference(applyVariantSession(store, project, reference(selected)));
  return reference(await runInterpretationExecution(store, selected.value.owner, true));
}

/** The address is the original role's saved intent/application, never a new
 * artificial consumer. One invocation may send only that role's correction. */
export async function retryDiscoveryResponse(store: Store, project: string, refusal: Ref, limit: number,
  restoreOnly = false) {
  requireCondition(limit === 1, 'research_response_retry_invalid', 'A response correction permits exactly one physical call');
  const root = store.get(refusal.id, refusal.revision);
  if(root && ['discovery-final-application','discovery-final-assessment-application',
    'discovery-condition-evidence-application'].includes(root.kind)) {
    const selection=projectProducerSelection(store,project);
    return withChildInvocationAllowance(1,()=>withProjectProducerSelection(store,project,selection,
      ()=>retryFinalRoleResponse(store,project,refusal,restoreOnly)));
  }
  if(root?.kind==='assessment-application' && (root.value as any)?.contract===DOSSIER_APPLICATION) {
    const selection=projectProducerSelection(store,project);
    return withChildInvocationAllowance(1,()=>withProjectProducerSelection(store,project,selection,
      ()=>retryDossierResponse(store,project,refusal,restoreOnly)));
  }
  if(root?.kind==='assessment-application') {
    const selection=projectProducerSelection(store,project);
    return withChildInvocationAllowance(1,()=>withProjectProducerSelection(store,project,selection,
      ()=>retryAttemptAssessmentResponse(store,project,refusal,restoreOnly)));
  }
  requireCondition(root?.kind === 'research-consumer-intent' && canonical(reference(root)) === canonical(refusal),
    'research_response_retry_invalid', 'Select the exact saved refusal of its original role');
  const correction = readManagedResponseCorrection(store, project, refusal);
  return withChildInvocationAllowance(1, async () => {
    let selected = correction.latest;
    const applied = async () => {
      if(!['variant-proposal','variant-decision','frame-interpretation-request','frame-interpretation-choice'].includes(selected.value.kind)) {
        const failure=managedResponseFormFailure(store,selected);
        if(failure) throw failure;
        // The ordinary native runner owns applying this role's paid reply.
        // This addressed entry never buys its next step or a child assessor.
        return selected.value.state==='applied'
          ? {kind:'applied' as const,root:refusal,intent:reference(selected),outputs:selected.value.outputs}
          : {kind:'pending' as const,root:refusal,intent:reference(selected)};
      }
      const result = await applyOriginalRole(store, project, selected);
      return { kind: 'applied' as const, root: refusal,
        intent: reference(readResearchConsumerIntent(store, reference(store.get(selected.id)!))), result };
    };
    if (selected.value.state === 'applied') return applied();
    if (!correction.retry && selected.value.state !== 'prepared') {
      // A paid response below is still applied by its own projector. If its
      // closed form is invalid, expose the terminal error before new admission.
      try { return await applied(); }
      catch (error) {
        if (selected.value.state === 'refused') return { kind: 'refused' as const, root: refusal,
          intent: reference(selected), code: selected.value.refusal!.code };
        throw error;
      }
    }
    if (restoreOnly && (correction.retry || selected.value.state === 'prepared'))
      return { kind: 'pending' as const, root: refusal, intent: reference(selected) };
    const selection = projectProducerSelection(store, project);
    return withProjectProducerSelection(store, project, selection, async () => {
      if (correction.retry) {
        const value = correction.intent.value;
        const context = consumerIntentContext(store, value, correction.intent.id);
        const ownerHead=store.get<Record<string,any>>(value.owner.id);
        const owner=ownerHead?.kind==='research-run'?reference(ownerHead):value.owner;
        const input: ResearchConsumerIntentInput = { projectId: project, kind: value.kind, key: value.rootKey,
          owner, draft: value.draft, question: value.question, role: value.role,
          dispatch: value.dispatch, profile: value.profile, basis: value.basis, guards: value.guards.map(guard=>guard.id===owner.id?owner:guard),
          cursor: { ...value.cursor, responseCorrection: refusal,
            context: { ...context, failures: [...(context.failures ?? []), correction.failure] } } };
        selected = prepareResearchConsumerIntent(store, input, [], { responseCorrection: refusal });
      }
      const value = selected.value;
      if (value.state === 'prepared') {
        const runner=store.get<Record<string,any>>(value.owner.id);
        const pilot=value.profile?store.get<ReaderPilot>(value.profile.id,value.profile.revision):undefined;
        requireCondition(!value.profile || pilot?.kind==='reader-pilot' && canonical(reference(pilot))===canonical(value.profile),
          'research_response_retry_invalid','The original role lost its exact saved profile');
        try {
          await researchCall(value.role, value.dispatch, value.cursor.prompt ?? value.cursor.instruction,
            consumerIntentContext(store, value, selected.id), undefined,
            { store, draftId: value.draft.id, questionId: value.question.id,
              purpose: ['synthesis','consolidation'].includes(value.kind)?'analyst':value.kind,
              consumerIntent: reference(selected), session: value.owner, ...(pilot?{pilot}:{}) });
        } finally {
          // The reservation activates a paused native run atomically. This
          // addressed invocation ends after its one reply, so it releases the
          // same runner position without pretending an ordinary run is live.
          const current=runner?.kind==='research-run'?store.get<Record<string,any>>(runner.id):null;
          if(runner?.value.status==='paused' && current?.value.status==='running'
            && current.value.turns===runner.value.turns
            && canonical(current.value.owner)===canonical(runner.value.owner))
            store.writeMany([{id:current.id,kind:current.kind,expected:current.revision,
              value:{...current.value,status:'paused',error:runner.value.error,pauseCode:runner.value.pauseCode}}],
              [reference(current),reference(store.get(selected.id)!)]);
        }
        selected = readResearchConsumerIntent(store, reference(store.get(selected.id)!));
      }
      return applied();
    });
  });
}

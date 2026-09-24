import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, uniqueRefs, type Finding, type Ref } from '../pipeline/contracts.js';
import type { Store, TransactionGuard } from '../storage/store.js';
import type { Source } from '../evidence/evidence.js';
import type { RuntimeObservation } from '../runtime/runtime-observation-model.js';
import type { ResearchScope } from './research-scope.js';
import { obligationAssignment, type CarriedObligation } from './obligation-policy.js';
import { obligationHandoff, type ObligationHandoff } from './obligation-handoff.js';
import { runtimeSupport } from './runtime-evidence.js';
import { runtimeSource } from '../runtime/runtime-observation-model.js';
import { omRuntimeAssignment, runtimeObligationId } from '../runtime/runtime-observation.js';
import { transactionGuardsCurrent, uniqueTransactionGuards } from '../runtime/environment.js';

export interface ObligationConfirmation { obligation: string; source: Ref; observation: Ref }
export interface ReadinessObligations { handoff: ObligationHandoff; confirmations: ObligationConfirmation[] }

function confirmation(store: Store, project: string, obligation: CarriedObligation, source: Ref, dispatch: Ref | null) {
  if (!dispatch) return null;
  if (obligation.kind !== 'environment-confirmation' || !obligation.returnCondition
    || obligation.runtimeCheck?.satisfies !== obligation.returnCondition) return null;
  const found = runtimeSupport(store, project, obligation, source);
  const address = runtimeObligationId(obligation);
  if (!found || found.record.value.requestedFor !== address || found.record.value.result?.exitCode !== 0) return null;
  if (!obligation.scope.id.startsWith('om-obligations:')) {
    const authorized = store.get<ResearchScope>(found.record.value.scope.id, found.record.value.scope.revision)!;
    const assignment = obligationAssignment(authorized.value, obligation.obligation);
    const { scope: _scope, wake: _wake, ...expected } = obligation;
    if (canonical(assignment) !== canonical(expected)) return null;
  }
  // A later failed/in-flight check is new contrary or unknown evidence, even
  // if no new Source was published. Do not resurrect an older success.
  if (store.list<RuntimeObservation>('runtime-observation').some(record => record.id !== found.record.id
    && record.value.projectId === project && record.value.requestedFor === address
    && canonical(record.value.check) === canonical(obligation.runtimeCheck)
    && record.value.startedAt >= found.record.value.startedAt)) return null;
  return { proof: { obligation: address, source, observation: reference(found.record) },
    guards: [...found.guards, dispatch], admissionGuards: found.admissionGuards,
    dependencies: uniqueRefs([source, reference(found.record), ...found.code.map(code => code.source)]) };
}

function confirmationIsCurrent(store: Store, found: ReturnType<typeof confirmation>): boolean {
  // Some consumers use the result only as a current predicate. They must not
  // accept an already-stale proof merely because a guarded writer would fail.
  return !!found && transactionGuardsCurrent(store, [...found.guards, ...found.admissionGuards]);
}

export function findObligationConfirmation(store: Store, project: string, obligation: CarriedObligation, pinned?: ObligationConfirmation) {
  // Capture the counter before either enumeration. A concurrent observation
  // may invalidate this revision, but cannot replace it with a newer guard.
  const counter = store.get(`project-dispatch:${hashJson(project)}`), dispatch = counter ? reference(counter) : null;
  const sources = pinned ? [pinned.source] : store.list<Source>('source')
    .filter(source => source.value.projectId === project && source.value.provenance?.kind === 'runtime-observation')
    .sort((a, b) => a.id.localeCompare(b.id)).map(reference);
  const found = sources.map(source => confirmation(store, project, obligation, source, dispatch)).find(Boolean);
  return found && confirmationIsCurrent(store, found) && (!pinned || canonical(found.proof) === canonical(pinned)) ? found : null;
}

/** A sealed task admission is checked against immutable records. Later runtime
 * changes do not rewrite the fact that the condition was met at task start. */
export function frozenObligationConfirmation(store: Store, project: string, obligation: CarriedObligation, proof: ObligationConfirmation): boolean {
  try {
    const address = runtimeObligationId(obligation);
    if (obligation.kind !== 'environment-confirmation' || !obligation.returnCondition
      || obligation.runtimeCheck?.satisfies !== obligation.returnCondition || proof.obligation !== address
      || !isRef(proof.source) || !isRef(proof.observation)) return false;
    const record = store.get<RuntimeObservation>(proof.observation.id, proof.observation.revision);
    const source = store.get<Source>(proof.source.id, proof.source.revision);
    if (record?.kind !== 'runtime-observation' || source?.kind !== 'source' || record.value.projectId !== project
      || source.value.projectId !== project || canonical(reference(record)) !== canonical(proof.observation)
      || canonical(reference(source)) !== canonical(proof.source) || record.value.version !== 1 || record.value.status !== 'observed'
      || record.value.requestedFor !== address || record.value.result?.exitCode !== 0 || record.value.result.signal !== null
      || canonical(record.value.check) !== canonical(obligation.runtimeCheck)) return false;
    const rendered = runtimeSource(record);
    if (source.id !== rendered.id || canonical(source.value) !== canonical(rendered.value)) return false;
    if (obligation.scope.id.startsWith('om-obligations:')) {
      const declared = omRuntimeAssignment(store, project, record.value.scope, address);
      return canonical(declared.assignment) === canonical(obligation);
    }
    const scope = store.get<ResearchScope>(record.value.scope.id, record.value.scope.revision);
    if (scope?.kind !== 'research-scope' || scope.value.projectId !== project || scope.id !== obligation.scope.id || scope.hash !== record.value.scope.hash) return false;
    const { scope: _scope, wake: _wake, ...expected } = obligation;
    return canonical(obligationAssignment(scope.value, obligation.obligation)) === canonical(expected);
  } catch { return false; }
}

/** Machine readiness consumes an explicitly declared pass predicate. Merely
 * running a version command (even exit zero) or quoting an owner report cannot
 * certify the condition. No provider call or command is launched by this gate. */
export function readinessObligations(store: Store, project: string, inputs: Ref[], saved?: ReadinessObligations,
  mode: 'assess' | 'consume' = 'assess', allowHistorical = false) {
  const findings: Finding[] = [], guards: Ref[] = [], dependencies: Ref[] = [], confirmations: ObligationConfirmation[] = [];
  const admissionGuards: TransactionGuard[] = [];
  let handoff: ObligationHandoff | null;
  try { handoff = obligationHandoff(store, project, inputs); }
  catch (error) {
    return { findings: [{ code: error instanceof EngineError ? error.code : 'obligation_handoff_invalid', target: 'R3',
      message: error instanceof Error ? error.message : 'Invalid R2 handoff' }], guards, admissionGuards, dependencies, value: undefined };
  }
  if (!handoff) {
    if (saved !== undefined) findings.push({ code: 'obligation_handoff_foreign', target: 'R3', message: 'Readiness obligations do not belong to this R3 basis' });
    return { findings, guards, admissionGuards, dependencies, value: undefined };
  }
  const due = handoff.obligations.filter(obligation => obligation.moment === 'R3');
  // Only a legacy producing R2 can waive the old R3 field. An OM ledger,
  // including an empty one, always survives into the saved readiness result.
  if ('r2' in handoff) {
    const producer = store.get<{ carriedContract?: string }>(handoff.r2.id, handoff.r2.revision)!;
    if (mode === 'consume' && saved === undefined && allowHistorical && producer.value.carriedContract === undefined)
      return { findings, guards, admissionGuards, dependencies, value: undefined };
  }
  if (mode === 'consume' && saved === undefined) {
    findings.push({ code: 'obligation_handoff_missing', target: 'R3', message: 'This scoped R3 result omitted its required obligation handoff; do not infer it as accepted' });
    return { findings, guards, admissionGuards, dependencies, value: undefined };
  }
  if (saved !== undefined && (!saved || canonical(saved.handoff ?? null) !== canonical(handoff) || !Array.isArray(saved.confirmations)
    || !saved.confirmations.every(item => item && typeof item.obligation === 'string' && isRef(item.source) && isRef(item.observation))
    || saved.confirmations.length !== due.length || new Set(saved.confirmations.map(item => item.obligation)).size !== due.length
    || saved.confirmations.some(item => !due.some(obligation => runtimeObligationId(obligation) === item.obligation)))) {
    findings.push({ code: 'obligation_handoff_invalid', target: 'R3', message: 'R3 must preserve the complete R2 handoff and one exact confirmation per due obligation' });
    return { findings, guards, admissionGuards, dependencies, value: { handoff, confirmations } };
  }
  const counter = due.length ? store.get(`project-dispatch:${hashJson(project)}`) : null, dispatch = counter ? reference(counter) : null;
  for (const obligation of due) {
    const pinned = saved?.confirmations.find(item => item.obligation === runtimeObligationId(obligation));
    const sources = saved !== undefined ? pinned && isRef(pinned.source) ? [pinned.source] : []
      : store.list<Source>('source').filter(source => source.value.projectId === project && source.value.provenance?.kind === 'runtime-observation')
        .sort((a, b) => {
          const finished = (source: typeof a) => store.get<RuntimeObservation>(source.value.provenance!.record.id)?.value.finishedAt ?? 0;
          return finished(b) - finished(a) || a.id.localeCompare(b.id);
        }).map(reference);
    const found = sources.map(source => confirmation(store, project, obligation, source, dispatch)).find(Boolean);
    if (!found || !confirmationIsCurrent(store, found) || pinned && canonical(pinned) !== canonical(found.proof)) {
      findings.push({ code: obligation.kind === 'environment-confirmation' ? 'environment_confirmation_required' : 'obligation_resolution_required',
        target: obligation.obligation, message: `Before R3: ${obligation.returnCondition}. Exact current confirmation is missing, failed or not declared as certifying this condition.` });
      continue;
    }
    confirmations.push(found.proof); guards.push(...found.guards); dependencies.push(...found.dependencies);
    admissionGuards.push(...found.admissionGuards);
  }
  return { findings, guards: uniqueRefs(guards), admissionGuards: uniqueTransactionGuards(admissionGuards),
    dependencies: uniqueRefs(dependencies), value: { handoff, confirmations } };
}

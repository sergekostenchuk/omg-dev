import { hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { budgetSegment, segmentId, type BudgetSegment } from '../runtime/research-budget.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { Store, Revision } from '../storage/store.js';
import { phasePolicy, type PhasePolicy } from './phase-policy.js';
import { readerPilot } from './reader-pilot.js';

export interface ResearchTrialRequest { key: string; previousPolicy: Ref; limit: number; blockLimit: number }
export interface ResearchTrial extends ResearchTrialRequest {
  projectId: string; previousSegment: Ref | null; pilot: Ref; segment: Ref; policy: Ref;
}
interface ProjectDispatch { projectId: string; serial: number }
const sameRef = (left: Ref, right: Ref) => left.id === right.id && left.revision === right.revision && left.hash === right.hash;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
function allocatedTrial(store: Store, project: string, id: string, request: ResearchTrialRequest) {
  const previous = store.get<ResearchTrial>(id);
  if (!previous) return null;
  requireCondition(previous.kind === 'research-trial' && previous.revision === 1 && previous.value && typeof previous.value === 'object' && previous.value.projectId === project
    && previous.value.key === request.key && previous.value.limit === request.limit && previous.value.blockLimit === request.blockLimit
    && isRef(previous.value.previousPolicy) && sameRef(previous.value.previousPolicy, request.previousPolicy),
  'budget_trial_conflict', 'This trial key already identifies a different allocation');
  for (const [ref, kind, expectedId] of [[previous.value.segment, 'research-budget', segmentId(project, request.key)],
    [previous.value.policy, 'phase-policy', `phase-policy:${project}`], [previous.value.pilot, 'reader-pilot', `reader-pilot:${project}`]] as const) {
    const saved = isRef(ref) ? store.get<{ projectId: string }>(ref.id, ref.revision) : null;
    requireCondition(saved?.kind === kind && saved.id === expectedId && saved.value.projectId === project && saved.hash === ref.hash,
      'budget_trial_invalid', 'A saved allocation must retain its exact resulting segment, policy and preset');
  }
  const segment = store.get<BudgetSegment>(previous.value.segment.id, previous.value.segment.revision)!;
  const policy = store.get<PhasePolicy>(previous.value.policy.id, previous.value.policy.revision)!;
  const basis = store.get<PhasePolicy>(request.previousPolicy.id, request.previousPolicy.revision);
  requireCondition(segment.revision === 1 && segment.value.key === request.key && segment.value.limit === request.limit
    && segment.value.initialGroupLimit === request.blockLimit && segment.value.ownerGroupCeiling === request.blockLimit
    && basis?.kind === 'phase-policy' && basis.id === policy.id && basis.hash === request.previousPolicy.hash
    && policy.revision === basis.revision + 1 && policy.value.stopAfter === basis.value.stopAfter && policy.value.budgetSegment === request.key,
  'budget_trial_invalid', 'The saved allocation must represent exactly the requested budget and preserved phase boundary');
  return previous;
}

/** This explicit owner allocation is the only switch; ordinary phase-policy
 * continuation still cannot replace a segment. No existing budget is rewritten. */
export function allocateResearchTrial(store: Store, project: string, request: ResearchTrialRequest): Revision<ResearchTrial> {
  requireCondition(typeof project === 'string' && project.trim() && request && typeof request === 'object'
    && typeof request.key === 'string' && request.key.length > 0 && request.key === request.key.trim()
    && isRef(request.previousPolicy) && positive(request.limit) && positive(request.blockLimit) && request.blockLimit <= request.limit,
  'budget_trial_invalid', 'A trial needs a new key, exact previous policy and positive segment/block limits');
  const id = `research-trial:${hashJson([project, request.key])}`;
  const previous = allocatedTrial(store, project, id, request);
  if (previous) {
    // A retry may arrive after spending or a later allocation. Return the original
    // result without moving the active policy or recreating its segment/ledger.
    return previous;
  }

  const policy = phasePolicy(store, project);
  requireCondition(policy && sameRef(reference(policy), request.previousPolicy),
    'budget_trial_policy_stale', 'Allocation must name the exact current phase policy');
  const pilot = readerPilot(store, project);
  requireCondition(pilot, 'budget_trial_pilot_missing', 'Allocation must retain the active validated reader preset');
  const priorSegment = policy.value.budgetSegment ? budgetSegment(store, project, policy.value.budgetSegment) : null;
  const nextId = segmentId(project, request.key);
  requireCondition(!store.get(nextId) && !store.get(`research-budget-ledger:${hashJson(nextId)}`),
    'budget_trial_segment_reused', 'Allocate a new prospective segment; an existing segment or ledger cannot be reset or reused');

  // Read before scanning calls. Every audited model-call creation increments this
  // same record atomically, so expected revision closes the phantom-insert race.
  const dispatchId = `project-dispatch:${hashJson(project)}`;
  const dispatch = store.get<ProjectDispatch>(dispatchId);
  requireCondition(!dispatch || (dispatch.kind === 'project-dispatch' && dispatch.value.projectId === project
    && Number.isSafeInteger(dispatch.value.serial) && dispatch.value.serial >= 0 && dispatch.value.serial < Number.MAX_SAFE_INTEGER),
  'budget_trial_dispatch_invalid', 'The project dispatch counter is missing its valid identity or serial');
  requireCondition(!store.list<ModelCall>('model-call').some(call => call.value.projectId === project && call.value.status === 'running'),
    'budget_trial_call_running', 'Wait for project model calls to finish before allocating another segment');

  const nextSegment: BudgetSegment = { projectId: project, key: request.key, limit: request.limit,
    initialGroupLimit: request.blockLimit, ownerGroupCeiling: request.blockLimit };
  const nextPolicy: PhasePolicy = { ...policy.value, budgetSegment: request.key };
  const segment: Ref = { id: nextId, revision: 1, hash: hashJson(nextSegment) };
  const updatedPolicy: Ref = { id: policy.id, revision: policy.revision + 1, hash: hashJson(nextPolicy) };
  const value: ResearchTrial = { projectId: project, key: request.key, previousPolicy: reference(policy),
    limit: request.limit, blockLimit: request.blockLimit, previousSegment: priorSegment ? reference(priorSegment) : null,
    pilot: reference(pilot), segment, policy: updatedPolicy };
  try {
    return store.writeMany<ResearchTrial>([
      { id, kind: 'research-trial', expected: 0, value },
      { id: nextId, kind: 'research-budget', expected: 0, value: nextSegment },
      { id: policy.id, kind: policy.kind, expected: policy.revision, value: nextPolicy },
      { id: dispatchId, kind: 'project-dispatch', expected: dispatch?.revision ?? 0,
        value: { projectId: project, serial: (dispatch?.value.serial ?? 0) + 1 } },
    ], [reference(policy), reference(pilot), ...(priorSegment ? [reference(priorSegment)] : [])])[0]!;
  } catch (error) {
    if (error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code)) {
      const concurrent = allocatedTrial(store, project, id, request);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}

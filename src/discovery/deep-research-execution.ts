import { deepIdentityCalls } from './invocation-progress.js';
import { withHistoricalReads } from '../history/proofs.js';
import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import { uniqueTransactionGuards, type Environment, type RoleBinding } from '../runtime/environment.js';
import { processStart } from '../runtime/process-identity.js';
import type { Revision, Store, TransactionGuard } from '../storage/store.js';
import { requireCurrentDeepPreparation } from './deep-research.js';
import { deepResearchRunId, managedTurnId } from './research-consumer-transition.js';
import type { ResearchRun } from './research-model.js';
import { researchCall } from './research-protocol.js';
import { completeResearchAttemptTurn, deepResearchApplication, findResearchConsumerIntent,
  prepareResearchConsumerApplication, prepareResearchConsumerIntent, readDeepResearchResult, readManagedDeepPreparation,
  readResearchConsumerExecution, readResearchConsumerIntent, requireDeepConsumerBinding, consumerIntentContext,
  type ProvenDeepResearchResult, type ResearchConsumerIntent } from './response-recovery.js';

export { readDeepResearchResult, type ProvenDeepResearchResult } from './response-recovery.js';

export interface DeepResearchInput {
  projectId: string; deepPreparation: Ref; environment: Revision<Environment>; role?: RoleBinding;
  /** An existing MR/P run and its exact next position. Omit only for a standalone step. */
  owner?: Ref; turn?: number; guards?: TransactionGuard[];
}
export interface DeepResearchOptions { restoreOnly?: boolean; allowance?: number; signal?: AbortSignal }
const instruction = 'Research only the exact deep preparation and its selected variant. The cell supplies the exact plan question, requiredDepth and criterion; the scope supplies the proven selection. Return {action:"answer",question:<planQuestionId>,value:<one v7-attempt end>,citations:[]}. Evidence belongs inside that end. This step neither accepts claims nor changes choice, coverage or stage.';
function invalid(message: string): never { throw new EngineError('discovery_deep_execution_invalid', message); }

function position(store: Store, input: DeepResearchInput, actor: string) {
  if (input.guards !== undefined && !Array.isArray(input.guards)) invalid('Frontier guards must be an explicit list');
  if (Object.hasOwn(input, 'owner')) {
    if (!isRef(input.owner)) invalid('An explicit run needs its exact owner Ref');
    const run = store.get<ResearchRun>(input.owner.id, input.owner.revision);
    if (!run || run.kind !== 'research-run' || canonical(reference(run)) !== canonical(input.owner)
      || run.value.projectId !== input.projectId) invalid('The deep position lost its exact original run');
    const turn = input.turn === undefined ? run.value.turns + 1 : input.turn;
    if (!Number.isSafeInteger(turn) || turn !== run.value.turns + 1) invalid('Deep must continue the exact next run position');
    return { id: run.id, turn, key: hashJson([run.id, turn, 'analyst']), run };
  }
  if (input.turn !== undefined && input.turn !== 1) invalid('A standalone deep step starts at turn one');
  const id = deepResearchRunId(input.projectId, input.deepPreparation, actor);
  return { id, turn: 1, key: hashJson([id, 1, 'analyst']), run: null };
}
function savedPosition(store: Store, input: DeepResearchInput, actor: string, draft: string) {
  const at = position(store, input, actor);
  const previous = findResearchConsumerIntent(store, input.projectId, 'analyst', at.key, draft);
  if (!previous) return { ...at, previous: null };
  const checked = readResearchConsumerIntent(store, reference(previous));
  const proof = requireDeepConsumerBinding(store, checked);
  if (!proof || canonical(reference(proof.preparation)) !== canonical(input.deepPreparation)
    || checked.value.role.actor !== actor || checked.value.cursor.turn !== at.turn
    || (input.owner && canonical(checked.value.owner) !== canonical(input.owner)))
    invalid('This run position already belongs to another exact deep admission');
  return { ...at, previous: checked };
}

/** Continue a proved MR/P run, or use a standalone bounded managed step.
 * Saved positions are recovered before today's admission and allowance. */
export function prepareDeepResearch(store: Store, input: DeepResearchInput): Revision<ResearchConsumerIntent> {
  return withHistoricalReads(() => prepareDeepResearchAt(store, input));
}
function prepareDeepResearchAt(store: Store, input: DeepResearchInput): Revision<ResearchConsumerIntent> {
  requireCondition(input && isRef(input.deepPreparation), 'discovery_deep_preparation_invalid', 'An explicit deep entry needs its exact preparation');
  const proof = readManagedDeepPreparation(store, input.projectId, input.deepPreparation);
  const role = input.role ?? input.environment?.value.implementer;
  if (!role || !input.environment) invalid('Deep research needs its exact environment and role');
  const { id, turn, key, previous } = savedPosition(store, input, role.actor, proof.draft.id);
  if (previous) return previous;
  deepIdentityCalls(store, input.deepPreparation, 'analyst', role.actor);
  const admitted = requireCurrentDeepPreparation(store, input.projectId, input.deepPreparation);
  const environment = store.get<Environment>(input.environment.id, input.environment.revision);
  if (!environment || environment.kind !== 'environment' || canonical(environment) !== canonical(input.environment)
    || environment.value.projectId !== input.projectId
    || ![environment.value.implementer, environment.value.reviewer].some(saved => canonical(saved) === canonical(role)))
    invalid('Deep research needs the exact project environment and one of its roles');
  const question = admitted.scope.generation.session.value.question;
  const basis = uniqueRefs([input.deepPreparation, admitted.preparation.value.cell.subject.planAnswer, ...admitted.draft.value.inputs]);
  let run = store.get<ResearchRun>(id);
  if (run) {
    if (run.kind !== 'research-run' || run.value.projectId !== input.projectId || run.value.draftId !== admitted.draft.id
      || (input.owner && canonical(reference(run)) !== canonical(input.owner))
      || run.value.turns !== turn - 1 || !input.owner && run.value.turns >= run.value.limit) invalid('The deep run lost its current bounded position');
  } else {
    const value: ResearchRun = { projectId: input.projectId, draftId: admitted.draft.id, environment: reference(environment),
      status: 'running', turns: 0, limit: 1, inputs: basis, ownerQuestion: null, error: null, pauseCode: null,
      owner: { pid: process.pid, started: processStart(process.pid)! }, requestChars: 0 };
    run = store.writeMany<ResearchRun>([{ id, kind: 'research-run', expected: 0, value }],
      uniqueTransactionGuards([...admitted.guards, ...(input.guards ?? []), reference(environment), { id, absent: true }]))[0]!;
  }
  return prepareResearchConsumerIntent(store, { projectId: input.projectId, kind: 'analyst', key,
    owner: reference(run), draft: reference(admitted.draft), question, role, dispatch: environment.value, profile: null,
    cursor: { run: id, turn, mode: null, instruction, subject: admitted.preparation.value.cell.subject,
      deepPreparation: input.deepPreparation,
      context: { role: 'research', stage: 'discovery', subject: admitted.preparation.value.cell.subject,
        deepPreparation: input.deepPreparation, deepCell: admitted.preparation.value.cell,
        deepScope: admitted.scope.scope.value, history: [] } }, basis,
    guards: uniqueTransactionGuards([reference(run), reference(admitted.draft), question, ...basis,
      reference(environment), ...admitted.guards, ...(input.guards ?? []), { id: managedTurnId(id, turn), absent: true }]) });
}

/** Apply the paid bytes using the common atomic application/terminal batch,
 * then complete the existing attempt/K binding. A cut between those two
 * ordinary transitions is recovered without another physical send. */
export function applyDeepResearch(store: Store, project: string, intentRef: Ref): ProvenDeepResearchResult {
  return withHistoricalReads(() => applyDeepResearchAt(store, project, intentRef));
}
function applyDeepResearchAt(store: Store, project: string, intentRef: Ref): ProvenDeepResearchResult {
  let intent = readResearchConsumerIntent(store, intentRef);
  if (intent.value.projectId !== project || !requireDeepConsumerBinding(store, intent)) invalid('Expected this project\'s deep intent');
  if (intent.value.state !== 'applied') {
    const paid = readResearchConsumerExecution(store, project, reference(intent));
    if (paid.kind !== 'response') invalid('Deep application needs its paid response');
    intent = paid.intent;
    const writes = deepResearchApplication(store, intent, paid);
    const owner = store.get(intent.value.owner.id);
    if (!owner) invalid('The deep run disappeared');
    const batch = prepareResearchConsumerApplication(store, reference(intent), reference(paid.call), writes, [reference(owner)]);
    store.writeMany(batch.writes, batch.guards);
    intent = readResearchConsumerIntent(store, reference(store.get<ResearchConsumerIntent>(intent.id)!));
  }
  const outputs = intent.value.outputs;
  if (!outputs || outputs.length !== 3) invalid('The applied deep intent lost its full output list');
  completeResearchAttemptTurn(store, project, outputs[1]!, outputs[2]!);
  return readDeepResearchResult(store, project, reference(intent));
}

/** Exact saved identity first. restoreOnly and invocation allowance can
 * forbid new payment, but never discard an already paid response. */
export async function resumeDeepResearch(store: Store, project: string, intentRef: Ref,
  options: DeepResearchOptions = {}): Promise<ProvenDeepResearchResult | null> {
  const original = readResearchConsumerIntent(store, intentRef);
  let intent = readResearchConsumerIntent(store, reference(store.get<ResearchConsumerIntent>(original.id)!));
  if (intent.value.projectId !== project || !requireDeepConsumerBinding(store, intent)) invalid('Expected this project\'s exact deep identity');
  if (intent.value.state === 'applied') return applyDeepResearch(store, project, reference(intent));
  if (intent.value.state === 'prepared') {
    if (options.restoreOnly) return null;
    requireCondition((options.allowance ?? 1) > 0, 'research_turns_exhausted', 'This invocation has no allowance for a new deep payment');
    requireCurrentDeepPreparation(store, project, intent.value.cursor.deepPreparation);
  }
  const value = intent.value;
  await researchCall(value.role, value.dispatch, value.cursor.instruction, consumerIntentContext(store, value, intent.id), options.signal,
    { store, draftId: value.draft.id, questionId: value.question.id, purpose: 'analyst', consumerIntent: reference(intent), session: value.owner });
  intent = readResearchConsumerIntent(store, reference(store.get<ResearchConsumerIntent>(intent.id)!));
  return applyDeepResearch(store, project, reference(intent));
}
export async function runDeepResearch(store: Store, input: DeepResearchInput,
  options: DeepResearchOptions = {}): Promise<ProvenDeepResearchResult | null> {
  requireCondition(input && isRef(input.deepPreparation), 'discovery_deep_preparation_invalid', 'An explicit deep entry needs its exact preparation');
  const proof = readManagedDeepPreparation(store, input.projectId, input.deepPreparation);
  const actor = (input.role ?? input.environment?.value.implementer)?.actor;
  if (!actor) invalid('Deep research needs its actor');
  const { previous: existing } = savedPosition(store, input, actor, proof.draft.id);
  if (!existing && options.restoreOnly) return null;
  if (!existing) requireCondition((options.allowance ?? 1) > 0, 'research_turns_exhausted', 'This invocation has no allowance for a new deep payment');
  const intent = existing ?? prepareDeepResearch(store, input);
  return resumeDeepResearch(store, input.projectId, reference(intent), options);
}

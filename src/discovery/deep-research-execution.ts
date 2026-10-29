import { deepIdentityCalls } from './invocation-progress.js';
import { withHistoricalReads } from '../history/proofs.js';
import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import { readEnvironmentAt, uniqueTransactionGuards, type Environment, type RoleBinding } from '../runtime/environment.js';
import { processStart } from '../runtime/process-identity.js';
import type { Revision, Store, TransactionGuard } from '../storage/store.js';
import { requireCurrentDeepPreparation } from './deep-research.js';
import { DEEP_RESEARCH_CYCLE_CONTRACT, deepResearchCycle, webResearchCapability, type ManagedResearchTurn, deepResearchRunId, managedTurnId } from './research-consumer-transition.js';
import type { ResearchRun } from './research-model.js';
import { ResearchSources } from './research-sources.js';
import { webBudgetView, webResearchGuide } from './web-research.js';
import { RESEARCH_READ_INSTRUCTION } from './research-read-contract.js';
import { researchCall } from './research-protocol.js';
import { completeResearchAttemptTurn, deepResearchApplication, findResearchConsumerIntent,
  prepareResearchConsumerApplication, prepareResearchConsumerIntent, readDeepResearchResult, readManagedDeepPreparation,
  readResearchConsumerExecution, readResearchConsumerIntent, readResearchConsumerTurn, requireDeepConsumerBinding, consumerIntentContext, staleUnpaidDeepAdmission,
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
const cycleInstruction = 'Research only this exact deep preparation, selected variant, plan question, requiredDepth and criterion. Use the supplied source catalogue and research actions to search, fetch and read evidence. Intermediate actions preserve this cell and do not publish an attempt. Finish with {action:"answer",question:<planQuestionId>,value:<one v7-attempt end>,citations:[]}; claim evidence must use exact pins from served read_source history. A search result is navigation, not evidence. This cycle does not accept claims or close coverage.' + RESEARCH_READ_INSTRUCTION;

/** Reuse only completed, independently proved steps of this run and exact cell. */
function cycleHistory(store: Store, run: string, turn: number, preparation: Ref) {
  return store.list<ManagedResearchTurn>('research-turn')
    .filter(row => row.value?.run === run && row.value.number < turn)
    .sort((a, b) => a.value.number - b.value.number)
    .flatMap(row => {
      const saved = readResearchConsumerTurn(store, reference(row)) as Revision<ManagedResearchTurn>;
      const intent = readResearchConsumerIntent(store, saved.value.consumerIntent);
      return saved.value.status === 'completed' && deepResearchCycle(intent.value.cursor)
        && canonical(intent.value.cursor.deepPreparation) === canonical(preparation) ? [saved] : [];
    });
}


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
  if (!proof) invalid('This run position does not belong to a proven deep admission');
  // Timeout-only revisions keep preparation/actor/owner unchanged, but still
  // invalidate the old environment guard. Use the common replacement proof.
  if (checked.value.state === 'prepared' && staleUnpaidDeepAdmission(store, checked)) return { ...at, previous: null };
  if (canonical(reference(proof.preparation)) !== canonical(input.deepPreparation)
    || checked.value.role.actor !== actor || checked.value.cursor.turn !== at.turn
    || (input.owner && canonical(checked.value.owner) !== canonical(input.owner))) {
    // This position has already begun its physical operation. Recover that
    // exact paid subject first, even when today's requested scope differs.
    if (checked.value.state !== 'prepared' && checked.value.role.actor === actor
      && checked.value.owner.id === at.id && checked.value.cursor.turn === at.turn)
      return { ...at, previous: checked };
    invalid('This run position already belongs to another exact deep admission');
  }
  return { ...at, previous: checked };
}

/** Continue a proved MR/P run, or use a standalone bounded managed step.
 * Saved positions are recovered before today's admission and allowance. */
export function prepareDeepResearch(store: Store, input: DeepResearchInput): Revision<ResearchConsumerIntent> {
  return withHistoricalReads(() => prepareDeepResearchAt(store, input));
}
/** The ordinary runner owns each new cyclic position and its invocation allowance. */
export function prepareDeepResearchCycle(store: Store, input: DeepResearchInput): Revision<ResearchConsumerIntent> {
  if (!input || !isRef(input.owner)) invalid('A deep cycle needs its exact ordinary research run');
  return withHistoricalReads(() => prepareDeepResearchAt(store, input, true));
}
function prepareDeepResearchAt(store: Store, input: DeepResearchInput, cycle = false): Revision<ResearchConsumerIntent> {
  requireCondition(input && isRef(input.deepPreparation), 'discovery_deep_preparation_invalid', 'An explicit deep entry needs its exact preparation');
  const proof = readManagedDeepPreparation(store, input.projectId, input.deepPreparation);
  const role = input.role ?? input.environment?.value.implementer;
  if (!role || !input.environment) invalid('Deep research needs its exact environment and role');
  const { id, turn, key, previous } = savedPosition(store, input, role.actor, proof.draft.id);
  if (previous) return previous;
  deepIdentityCalls(store, input.deepPreparation, 'analyst', role.actor);
  const admitted = requireCurrentDeepPreparation(store, input.projectId, input.deepPreparation);
  const environment = readEnvironmentAt(store, input.projectId, reference(input.environment));
  if (canonical(environment) !== canonical(input.environment)
    || environment.value.projectId !== input.projectId
    || ![environment.value.implementer, environment.value.reviewer].some(saved => canonical(saved) === canonical(role)))
    invalid('Deep research needs the exact project environment and one of its roles');
  const question = admitted.scope.generation.session.value.question;
  const history = cycle ? cycleHistory(store, id, turn, input.deepPreparation) : [];
  const sources = cycle ? new ResearchSources(store, input.projectId, environment.value.workspace) : null;
  const basis = uniqueRefs([input.deepPreparation, admitted.preparation.value.cell.subject.planAnswer, ...admitted.draft.value.inputs,
    ...history.map(reference), ...(sources?.list().map(reference) ?? [])]);
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
    cursor: { run: id, turn, mode: null, instruction: cycle ? cycleInstruction : instruction, subject: admitted.preparation.value.cell.subject,
      ...(cycle ? { deepResearchContract: DEEP_RESEARCH_CYCLE_CONTRACT, deepHistory: history.map(reference) } : {}),
      deepPreparation: input.deepPreparation,
      context: { role: 'research', stage: 'discovery', subject: admitted.preparation.value.cell.subject,
        deepPreparation: input.deepPreparation, deepCell: admitted.preparation.value.cell,
        deepScope: admitted.scope.scope.value, history: history.map(row => row.value),
        ...(cycle ? { deepResearchContract: DEEP_RESEARCH_CYCLE_CONTRACT, inventory: sources!.inventory(),
          ...(webResearchCapability('discovery', 'analyst', environment.value)
            ? { webResearch: webResearchGuide(webBudgetView(store, input.projectId, 'discovery', environment.value.webResearch!)) } : {}) } : {}) } }, basis,
    guards: uniqueTransactionGuards([reference(run), reference(admitted.draft), question, ...basis,
      reference(environment), ...admitted.guards, ...(input.guards ?? []), { id: managedTurnId(id, turn), absent: true }]) });
}

/** Apply the paid bytes using the common atomic application/terminal batch,
 * then complete the existing attempt/K binding. A cut between those two
 * ordinary transitions is recovered without another physical send. */
export function applyDeepResearch(store: Store, project: string, intentRef: Ref): ProvenDeepResearchResult {
  return withHistoricalReads(() => applyDeepResearchAt(store, project, intentRef));
}
function applyDeepResearchIntent(store: Store, project: string, intentRef: Ref): Revision<ResearchConsumerIntent> {
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
  return intent;
}
function applyDeepResearchAt(store: Store, project: string, intentRef: Ref): ProvenDeepResearchResult {
  const intent = applyDeepResearchIntent(store, project, intentRef);
  const outputs = intent.value.outputs;
  if (!outputs || outputs.length !== 3) invalid('The applied deep intent lost its final output list');
  completeResearchAttemptTurn(store, project, outputs[1]!, outputs[2]!);
  return readDeepResearchResult(store, project, reference(intent));
}

/** Exact saved identity first. restoreOnly and invocation allowance can
 * forbid new payment, but never discard an already paid response. */
async function resumeDeepIntent(store: Store, project: string, intentRef: Ref,
  options: DeepResearchOptions): Promise<Revision<ResearchConsumerIntent> | null> {
  const original = readResearchConsumerIntent(store, intentRef);
  let intent = readResearchConsumerIntent(store, reference(store.get<ResearchConsumerIntent>(original.id)!));
  if (intent.value.projectId !== project || !requireDeepConsumerBinding(store, intent)) invalid('Expected this project\'s exact deep identity');
  if (intent.value.state === 'applied') return intent;
  if (intent.value.state === 'prepared') {
    if (options.restoreOnly) return null;
    requireCondition((options.allowance ?? 1) > 0, 'research_turns_exhausted', 'This invocation has no allowance for a new deep payment');
    requireCurrentDeepPreparation(store, project, intent.value.cursor.deepPreparation);
  }
  const value = intent.value;
  await researchCall(value.role, value.dispatch, value.cursor.instruction, consumerIntentContext(store, value, intent.id), options.signal,
    { store, draftId: value.draft.id, questionId: value.question.id, purpose: 'analyst', consumerIntent: reference(intent), session: value.owner });
  intent = readResearchConsumerIntent(store, reference(store.get<ResearchConsumerIntent>(intent.id)!));
  return intent;
}
export async function resumeDeepResearch(store: Store, project: string, intentRef: Ref,
  options: DeepResearchOptions = {}): Promise<ProvenDeepResearchResult | null> {
  const intent = await resumeDeepIntent(store, project, intentRef, options);
  return intent ? applyDeepResearch(store, project, reference(intent)) : null;
}
/** Intermediate turns are consumed by the ordinary runner's read/web/owner executor. */
export async function resumeDeepResearchCycle(store: Store, project: string, intentRef: Ref,
  options: DeepResearchOptions = {}): Promise<Revision<ManagedResearchTurn> | null> {
  const saved = readResearchConsumerIntent(store, intentRef);
  if (!deepResearchCycle(saved.value.cursor)) invalid('A cyclic entry needs its saved execution contract');
  const paid = await resumeDeepIntent(store, project, intentRef, options);
  if (!paid) return null;
  return withHistoricalReads(() => {
    const intent = applyDeepResearchIntent(store, project, reference(paid));
    if (intent.value.outputs?.length === 3) return applyDeepResearchAt(store, project, reference(intent)).turn;
    if (intent.value.outputs?.length !== 2) invalid('The cyclic turn lost its exact paid outputs');
    return readResearchConsumerTurn(store, intent.value.outputs[1]!) as Revision<ManagedResearchTurn>;
  });
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

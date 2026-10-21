import type { Store, Revision, Write, ReadGuard } from '../storage/store.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import { hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { ModelCall } from './model-usage.js';
import type { DiscoveryDraft, Question } from '../discovery/discovery.js';

export interface CallEstimate { kind: 'estimated' | 'guaranteed'; tokens: number; basis: Ref[]; explanation: string }
export interface BudgetSegment { projectId: string; key: string; limit: number; initialGroupLimit: number; ownerGroupCeiling?: number; completionReserve: number }
interface Assignment { call: string; groups: string[]; estimate: CallEstimate }
interface Ledger { projectId: string; segment: string; assignments: Assignment[] }
export interface Optimization {
  reason: string; progress: string; required: number;
  options: { method: string; saved: number; decision: 'accept' | 'reject'; quality: string; preserved: string[] }[];
  obligations: string[]; forecast: string; basis: Ref[];
}
interface WorkingLimit { projectId: string; segment: string; group: string; metric: string; limit: number; ceiling?: number; decisions: Optimization[] }
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
export const segmentId = (project: string, key: string) => `research-budget:${hashJson([project, key])}`;
export function budgetSegment(store: Store, project: string, key: string) {
  const s = store.get<BudgetSegment>(segmentId(project, key));
  requireCondition(s?.kind === 'research-budget' && s.value.projectId === project && s.value.key === key
    && positive(s.value.limit) && positive(s.value.initialGroupLimit), 'budget_missing', 'Continuation needs its existing budget segment');
  segmentOwnerCeiling(store, s);
  segmentCompletionReserve(store, s);
  return s;
}
/** New segments bind the owner ceiling at creation. Its absence on an original
 * legacy segment retains that segment's existing working-limit policy. */
function segmentOwnerCeiling(store: Store, segment: Revision<BudgetSegment>): number | undefined {
  const saved = store.get<BudgetSegment>(segment.id, segment.revision);
  const original = store.get<BudgetSegment>(segment.id, 1);
  requireCondition(saved?.kind === 'research-budget' && saved.hash === segment.hash && hashJson(segment.value) === segment.hash
    && original?.kind === 'research-budget' && segment.id === segmentId(segment.value.projectId, segment.value.key),
  'budget_segment_invalid', 'Budget limits must come from the exact saved segment');
  const ceiling = original.value.ownerGroupCeiling;
  requireCondition(Object.hasOwn(original.value, 'ownerGroupCeiling') === Object.hasOwn(segment.value, 'ownerGroupCeiling')
    && ceiling === segment.value.ownerGroupCeiling,
  'budget_owner_ceiling_changed', 'A segment cannot remove or replace its owner block ceiling');
  requireCondition(!Object.hasOwn(original.value, 'ownerGroupCeiling') || (typeof ceiling === 'number' && positive(ceiling)
    && original.value.initialGroupLimit <= ceiling && ceiling <= original.value.limit),
  'budget_owner_ceiling_invalid', 'The saved owner block ceiling is missing or invalid');
  return ceiling;
}
/** Every readable segment binds its completion reserve at creation; the reserve
 * is a mandatory field. A pre-DR3c segment saved without it can no longer admit
 * new work under a silent zero reserve — reading its policy is a typed refusal. */
export function segmentCompletionReserve(store: Store, segment: Revision<BudgetSegment>): number {
  const saved = store.get<BudgetSegment>(segment.id, segment.revision);
  const original = store.get<BudgetSegment>(segment.id, 1);
  requireCondition(saved?.kind === 'research-budget' && saved.hash === segment.hash && hashJson(segment.value) === segment.hash
    && original?.kind === 'research-budget' && segment.id === segmentId(segment.value.projectId, segment.value.key),
  'budget_segment_invalid', 'Budget limits must come from the exact saved segment');
  const reserve = original.value.completionReserve;
  requireCondition(Object.hasOwn(original.value, 'completionReserve') === Object.hasOwn(segment.value, 'completionReserve')
    && reserve === segment.value.completionReserve,
  'budget_completion_reserve_changed', 'A segment cannot remove or replace its completion reserve');
  requireCondition(typeof reserve === 'number' && Number.isSafeInteger(reserve)
    && reserve >= 0 && reserve <= original.value.limit,
  'budget_completion_reserve_invalid', 'The saved completion reserve is missing or invalid');
  return reserve;
}
/** Target identity survives question/draft regeneration and field grouping changes.
 * A call spanning several obligations is charged once to the segment and to each
 * affected group, so splitting a question cannot shed its original costs. */
export function budgetGroups(store: Store, draftId: string, questionId: string): string[] {
  const draft = store.get<DiscoveryDraft>(draftId), question = store.get<Question>(questionId);
  requireCondition(draft?.kind === 'discovery-draft' && question?.kind === 'question' && question.value.draftId === draft.id
    && draft.value.questions.includes(question.id) && question.value.projectId === draft.value.projectId,
  'budget_question_missing', 'Every role must carry its bound logical question');
  const spec = question.value.spec;
  return spec.targets?.length ? [...new Set(spec.targets.map(t => `target:${hashJson([t.target])}`))].sort() : [`field:${spec.field}`];
}
const limitId = (segment: string, group: string, metric: string) => `research-limit:${hashJson([segment, group, metric])}`;
export function workingLimit(store: Store, segment: Revision<BudgetSegment>, group: string, metric: string, initial: number): number {
  if (group.includes(',')) return Math.max(...group.split(',').map(g => workingLimit(store, segment, g, metric, initial)));
  const limit = store.get<WorkingLimit>(limitId(segment.id, group, metric))?.value.limit ?? initial;
  const ceiling = metric === 'tokens' ? segmentOwnerCeiling(store, segment) : undefined;
  return ceiling === undefined ? limit : Math.min(limit, ceiling);
}
export function raiseWorkingLimit(store: Store, segment: Revision<BudgetSegment>, group: string, metric: string, initial: number, decision: Optimization, physicalMaximum?: number) {
  const ownerCeiling = metric === 'tokens' ? segmentOwnerCeiling(store, segment) : undefined;
  requireCondition(decision && typeof decision === 'object' && typeof decision.reason === 'string' && typeof decision.progress === 'string'
    && typeof decision.forecast === 'string' && Array.isArray(decision.options) && Array.isArray(decision.obligations)
    && decision.obligations.every(o => typeof o === 'string' && o.length > 0) && Array.isArray(decision.basis),
    'budget_justification_missing', 'Working policy requires structured alternatives, obligations and evidence');
  const id = limitId(segment.id, group, metric), previous = store.get<WorkingLimit>(id);
  const old = previous?.value.limit ?? initial;
  requireCondition(positive(decision.required) && decision.required > old && decision.reason.trim() && decision.progress.trim()
    && decision.forecast.trim() && decision.options.length > 0 && decision.obligations.length > 0 && decision.basis.length > 0,
  'budget_justification_missing', 'A working increase needs measured need, unresolved obligations, alternatives and evidence');
  for (const option of decision.options) requireCondition(option && typeof option.method === 'string' && option.method.trim() && Number.isSafeInteger(option.saved) && option.saved >= 0
    && typeof option.quality === 'string' && option.quality.trim() && Array.isArray(option.preserved) && ['accept', 'reject'].includes(option.decision)
    && (option.decision === 'reject' || decision.obligations.every(o => option.preserved.includes(o))),
  'budget_quality_loss', 'An accepted reduction must retain every named obligation including exceptions and external consumers');
  requireCondition(!previous?.value.decisions.some(d => d.progress === decision.progress), 'budget_no_progress', 'The same progress cannot repeatedly justify increases');
  requireCondition(physicalMaximum !== undefined && positive(physicalMaximum), 'budget_ceiling_required',
    'A limit increase needs an explicit finite ceiling; it is never an automatic continuation strategy');
  const limit = Number((BigInt(decision.required) * 11n + 9n) / 10n);
  requireCondition(ownerCeiling === undefined || limit <= ownerCeiling,
    'budget_owner_group_limit', 'An automatic working increase cannot exceed the owner block ceiling');
  const ceiling = Math.min(physicalMaximum, previous?.value.ceiling ?? physicalMaximum, ownerCeiling ?? physicalMaximum);
  requireCondition(positive(limit) && limit <= ceiling, 'budget_transport_limit', 'A working increase cannot enlarge a physical model/transport limit');
  return store.writeMany<WorkingLimit>([{ id, kind: 'research-limit', expected: previous?.revision ?? 0,
    value: { projectId: segment.value.projectId, segment: segment.id, group, metric, limit, ceiling, decisions: [...(previous?.value.decisions ?? []), decision] } }],
  [reference(segment), ...decision.basis])[0]!;
}
export function budgetUsage(store: Store, segment: Revision<BudgetSegment>) {
  const ledger = store.get<Ledger>(`research-budget-ledger:${hashJson(segment.id)}`);
  const groups: Record<string, { measured: number; reserved: number }> = {};
  let measured = 0, reserved = 0;
  const guards: ReadGuard[] = [reference(segment)];
  for (const assignment of ledger?.value.assignments ?? []) {
    const call = store.get<ModelCall>(assignment.call);
    requireCondition(call?.kind === 'model-call' && call.value.projectId === segment.value.projectId, 'budget_call_missing', 'A reserved call cannot disappear from accounting');
    guards.push(reference(call));
    const used = call.value.usage ? call.value.usage.inputTokens + call.value.usage.outputTokens : null;
    measured += used ?? 0; reserved += used === null ? assignment.estimate.tokens : 0;
    for (const group of assignment.groups) {
      const row = groups[group] ??= { measured: 0, reserved: 0 };
      row.measured += used ?? 0; row.reserved += used === null ? assignment.estimate.tokens : 0;
    }
  }
  return { ledger, measured, reserved, groups, guards, remaining: segment.value.limit - measured - reserved };
}
export type NewBudgetSegment = BudgetSegment & { completionReserve: number };
export type BudgetSegmentTarget =
  | { saved: Revision<BudgetSegment> }
  | { creating: NewBudgetSegment };

export function prepareNewSegmentReservation(
  store: Store,
  segment: NewBudgetSegment | BudgetSegmentTarget,
  call: string,
  groups: string[],
  estimate: CallEstimate,
  classification: 'research' | 'completion' = 'research'
): { writes: Write[]; guards: ReadGuard[] } {
  const target: BudgetSegmentTarget =
    typeof segment === 'object' && segment !== null && ('creating' in segment || 'saved' in segment)
      ? (segment as BudgetSegmentTarget)
      : { creating: segment as NewBudgetSegment };
  return reserveResearchCall(store, target, call, groups, estimate, classification);
}

export function reserveResearchCall(
  store: Store,
  target: BudgetSegmentTarget,
  call: string,
  groups: string[],
  estimate: CallEstimate,
  classification: 'research' | 'completion' = 'research'
): { writes: Write[]; guards: ReadGuard[] } {
  requireCondition(classification === 'research' || classification === 'completion',
    'budget_class_invalid', 'The budget reservation class must be research or completion');
  requireCondition(positive(estimate.tokens) && ['estimated', 'guaranteed'].includes(estimate.kind) && estimate.explanation.trim() && estimate.basis.length > 0,
    'budget_estimate_missing', 'Unknown usage never means a zero reserve');
  requireCondition(Array.isArray(groups) && groups.length > 0 && new Set(groups).size === groups.length,
    'budget_group_missing', 'Logical obligation groups are required');

  if (typeof target === 'object' && target !== null && 'creating' in target) {
    const creating = target.creating;
    requireCondition(creating && typeof creating === 'object' && typeof creating.key === 'string' && creating.key.trim().length > 0
      && typeof creating.projectId === 'string' && creating.projectId.trim().length > 0
      && positive(creating.limit) && positive(creating.initialGroupLimit) && creating.initialGroupLimit <= creating.limit,
      'budget_invalid', 'Explicit positive segment and question limits are required');
    requireCondition(creating.ownerGroupCeiling === undefined || (positive(creating.ownerGroupCeiling) && creating.initialGroupLimit <= creating.ownerGroupCeiling && creating.ownerGroupCeiling <= creating.limit),
      'budget_owner_ceiling_invalid', 'An owner block ceiling must be a positive integer between the initial group limit and segment limit');
    requireCondition(typeof creating.completionReserve === 'number' && Number.isSafeInteger(creating.completionReserve)
      && creating.completionReserve >= 0 && creating.completionReserve <= creating.limit,
      'budget_completion_reserve_invalid', 'A new budget segment requires an explicit completion reserve between 0 and the segment limit');

    const reserve = creating.completionReserve;
    const effectiveLimit = classification === 'completion' ? creating.limit : creating.limit - reserve;
    requireCondition(estimate.tokens <= effectiveLimit,
      'budget_segment_exhausted', 'The next reserve does not fit the owner-approved segment; reduce the call or request an owner decision');

    const segId = segmentId(creating.projectId, creating.key);
    const guards: ReadGuard[] = [...estimate.basis];
    for (const group of groups) {
      requireCondition(creating.ownerGroupCeiling === undefined || estimate.tokens <= creating.ownerGroupCeiling,
        'budget_owner_group_limit', 'The next call does not fit the owner block ceiling; other segment funds cannot enlarge it');
      const limit = store.get<WorkingLimit>(limitId(segId, group, 'tokens'));
      if (limit) guards.push(reference(limit));
      requireCondition(estimate.tokens <= (limit?.value.limit ?? creating.initialGroupLimit),
        'budget_question_limit', 'Optimize the remaining work and justify a working increase before dispatch');
    }

    const ledgerId = `research-budget-ledger:${hashJson(segId)}`;
    const writes: Write[] = [
      {
        id: segId,
        kind: 'research-budget',
        expected: 0,
        value: {
          projectId: creating.projectId,
          key: creating.key,
          limit: creating.limit,
          initialGroupLimit: creating.initialGroupLimit,
          ...(creating.ownerGroupCeiling === undefined ? {} : { ownerGroupCeiling: creating.ownerGroupCeiling }),
          completionReserve: creating.completionReserve,
        }
      },
      {
        id: ledgerId,
        kind: 'research-budget-ledger',
        expected: 0,
        value: {
          projectId: creating.projectId,
          segment: segId,
          assignments: [{ call, groups, estimate }]
        }
      }
    ];
    return { writes, guards };
  }

  requireCondition(typeof target === 'object' && target !== null && 'saved' in target
    && target.saved !== null && target.saved !== undefined,
    'budget_segment_invalid', 'A budget reservation requires an exact { saved } or { creating } target');
  const segment = target.saved;

  requireCondition(segment && typeof segment === 'object', 'budget_segment_invalid', 'A saved budget segment revision is required');
  const ownerCeiling = segmentOwnerCeiling(store, segment);
  const completionReserve = segmentCompletionReserve(store, segment);
  const usage = budgetUsage(store, segment);
  const effectiveLimit = classification === 'completion' ? segment.value.limit : segment.value.limit - completionReserve;

  requireCondition(usage.measured + usage.reserved + estimate.tokens <= effectiveLimit,
    'budget_segment_exhausted', 'The next reserve does not fit the owner-approved segment; reduce the call or request an owner decision');
  for (const group of groups) {
    const row = usage.groups[group] ?? { measured: 0, reserved: 0 };
    requireCondition(ownerCeiling === undefined || row.measured + row.reserved + estimate.tokens <= ownerCeiling,
      'budget_owner_group_limit', 'The next call does not fit the owner block ceiling; other segment funds cannot enlarge it');
    const limit = store.get<WorkingLimit>(limitId(segment.id, group, 'tokens'));
    if (limit) usage.guards.push(reference(limit));
    requireCondition(row.measured + row.reserved + estimate.tokens <= (limit?.value.limit ?? segment.value.initialGroupLimit),
      'budget_question_limit', 'Optimize the remaining work and justify a working increase before dispatch');
  }
  requireCondition(!usage.ledger?.value.assignments.some(a => a.call === call), 'budget_call_duplicate', 'A generation can only be reserved once');
  return { writes: [{ id: usage.ledger?.id ?? `research-budget-ledger:${hashJson(segment.id)}`, kind: 'research-budget-ledger', expected: usage.ledger?.revision ?? 0,
    value: { projectId: segment.value.projectId, segment: segment.id, assignments: [...(usage.ledger?.value.assignments ?? []), { call, groups, estimate }] } }],
    guards: [...usage.guards, ...estimate.basis] };
}
export function assertQuestionBudget(store: Store, segment: Revision<BudgetSegment>, groups: string[]) {
  const ownerCeiling = segmentOwnerCeiling(store, segment);
  const usage = budgetUsage(store, segment);
  for (const group of groups) {
    const measured = usage.groups[group]?.measured ?? 0;
    requireCondition(ownerCeiling === undefined || measured <= ownerCeiling,
      'budget_owner_group_overrun', 'Actual block usage exceeded the owner ceiling; further calls for this block are forbidden');
    const limit = workingLimit(store, segment, group, 'tokens', segment.value.initialGroupLimit);
    requireCondition(measured <= limit, 'budget_question_overrun', 'Actual question usage exceeded its working limit; pause and report before any continuation');
  }
}

import type { Store, Revision, Write, ReadGuard } from '../storage/store.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import { hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { ModelCall } from './model-usage.js';
import type { DiscoveryDraft, Question } from '../discovery/discovery.js';

export interface CallEstimate { kind: 'estimated' | 'guaranteed'; tokens: number; basis: Ref[]; explanation: string }
export interface BudgetSegment { projectId: string; key: string; limit: number; initialGroupLimit: number }
interface Assignment { call: string; groups: string[]; estimate: CallEstimate }
interface Ledger { projectId: string; segment: string; assignments: Assignment[] }
export interface Optimization {
  reason: string; progress: string; required: number;
  options: { method: string; saved: number; decision: 'accept' | 'reject'; quality: string; preserved: string[] }[];
  obligations: string[]; forecast: string; basis: Ref[];
}
interface WorkingLimit { projectId: string; segment: string; group: string; metric: string; limit: number; decisions: Optimization[] }
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
export const segmentId = (project: string, key: string) => `research-budget:${hashJson([project, key])}`;
export function configureBudgetSegment(store: Store, projectId: string, key: string, limit = 10_000_000, initialGroupLimit = 700_000) {
  requireCondition(key.trim() && positive(limit) && positive(initialGroupLimit) && initialGroupLimit <= limit,
    'budget_invalid', 'Explicit positive segment and question limits are required');
  // A segment cannot be reset by replacing a profile or recreating a draft.
  return store.write<BudgetSegment>({ id: segmentId(projectId, key), kind: 'research-budget', expected: 0,
    value: { projectId, key, limit, initialGroupLimit } });
}
export function budgetSegment(store: Store, project: string, key: string) {
  const s = store.get<BudgetSegment>(segmentId(project, key));
  requireCondition(s?.kind === 'research-budget' && s.value.projectId === project && s.value.key === key
    && positive(s.value.limit) && positive(s.value.initialGroupLimit), 'budget_missing', 'Continuation needs its existing budget segment');
  return s;
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
  return store.get<WorkingLimit>(limitId(segment.id, group, metric))?.value.limit ?? initial;
}
export function raiseWorkingLimit(store: Store, segment: Revision<BudgetSegment>, group: string, metric: string, initial: number, decision: Optimization, physicalMaximum?: number) {
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
  const limit = Number((BigInt(decision.required) * 11n + 9n) / 10n);
  requireCondition(positive(limit) && (physicalMaximum === undefined || limit <= physicalMaximum), 'budget_transport_limit', 'A working increase cannot enlarge a physical model/transport limit');
  return store.writeMany<WorkingLimit>([{ id, kind: 'research-limit', expected: previous?.revision ?? 0,
    value: { projectId: segment.value.projectId, segment: segment.id, group, metric, limit, decisions: [...(previous?.value.decisions ?? []), decision] } }],
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
export function reserveResearchCall(store: Store, segment: Revision<BudgetSegment>, call: string, groups: string[], estimate: CallEstimate): { writes: Write[]; guards: ReadGuard[] } {
  requireCondition(positive(estimate.tokens) && ['estimated', 'guaranteed'].includes(estimate.kind) && estimate.explanation.trim() && estimate.basis.length > 0,
    'budget_estimate_missing', 'Unknown usage never means a zero reserve');
  const usage = budgetUsage(store, segment);
  requireCondition(groups.length > 0 && new Set(groups).size === groups.length, 'budget_group_missing', 'Logical obligation groups are required');
  requireCondition(usage.measured + usage.reserved + estimate.tokens <= segment.value.limit,
    'budget_segment_exhausted', 'The next reserve does not fit the owner-approved segment; reduce the call or request an owner decision');
  for (const group of groups) {
    const row = usage.groups[group] ?? { measured: 0, reserved: 0 };
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
/** Engine-owned progress fingerprint excludes new attempts and budget records:
 * failed repeats cannot manufacture progress just by spending more tokens. */
export function researchProgress(store: Store, draft: DiscoveryDraft, questionId: string) {
  const records = ['reader-result', 'pilot-reading', 'research-checkpoint'].flatMap(kind => store.list<any>(kind))
    .filter(r => r.value.projectId === draft.projectId && (r.value.question === questionId || r.value.question?.id === questionId));
  return { hash: hashJson(records.map(r => [r.kind, r.value])), basis: records.map(reference) };
}
export function accommodateQuestion(store: Store, segment: Revision<BudgetSegment>, groups: string[], estimate: CallEstimate,
  draft: Revision<DiscoveryDraft>, questionId: string, remainingEstimate: number) {
  const usage = budgetUsage(store, segment);
  const progress = researchProgress(store, draft.value, questionId);
  for (const group of groups) {
    const row = usage.groups[group] ?? { measured: 0, reserved: 0 };
    const required = row.measured + row.reserved + estimate.tokens + remainingEstimate;
    const old = workingLimit(store, segment, group, 'tokens', segment.value.initialGroupLimit);
    if (required <= old) continue;
    requireCondition(progress.basis.length > 0, 'budget_no_progress', 'A cost forecast alone cannot justify repeated expansion without preserved research');
    requireCondition(usage.measured + usage.reserved + estimate.tokens + remainingEstimate <= segment.value.limit,
      'budget_segment_exhausted', 'Required remaining work exceeds the overall segment');
    raiseWorkingLimit(store, segment, group, 'tokens', segment.value.initialGroupLimit, {
      reason: 'Measured question cost plus reserved and forecast remaining work exceeds its working threshold',
      progress: progress.hash, required, obligations: [group], basis: [...estimate.basis, ...progress.basis],
      forecast: `Next invocation ${estimate.tokens}; remaining known roles ${remainingEstimate}. Both are estimates; no output quality or provider cap is guaranteed.`,
      options: [
        { method: 'existing-pagination-and-replay', saved: 0, decision: 'accept', quality: 'The engine has already retained the exact originals, paged context, and attempted saved-response replay before this boundary.', preserved: [group] },
        { method: 'drop-constraints-or-external-consumers', saved: 0, decision: 'reject', quality: 'No demonstrated preservation of requirements, exceptions, authority, recovery or source meaning; do not discard these materials.', preserved: [] },
        { method: 'switch-model', saved: 0, decision: 'reject', quality: 'No evidence that another authorized role is suitable for this required reasoning; keep the selected role.', preserved: [] },
      ],
    });
  }
}

export function accommodateMetric(store: Store, segment: Revision<BudgetSegment>, group: string, metric: string, initial: number,
  required: number, draft: Revision<DiscoveryDraft>, questionId: string, evidence: Ref[], explanation: string, physicalMaximum?: number): number {
  if (group.includes(',')) return Math.max(...group.split(',').map(g => accommodateMetric(store, segment, g, metric, initial,
    required, draft, questionId, evidence, explanation, physicalMaximum)));
  requireCondition(physicalMaximum === undefined || required <= physicalMaximum, 'budget_transport_limit', 'Required material exceeds the declared transport capacity');
  const previous = workingLimit(store, segment, group, metric, initial);
  if (required <= previous) return previous;
  const progress = researchProgress(store, draft.value, questionId);
  const basis = [...evidence, ...progress.basis];
  requireCondition(basis.length > 0 && (metric !== 'rounds' || progress.basis.length > 0), 'budget_no_progress', 'Expansion needs concrete saved material, not repeated failed attempts');
  return raiseWorkingLimit(store, segment, group, metric, initial, {
    reason: explanation, progress: hashJson([progress.hash, evidence]), required, obligations: [group], basis,
    forecast: `Required ${required} ${metric} after lossless packing; this does not enlarge the model or transport window.`,
    options: [
      { method: 'existing-pagination-and-replay', saved: 0, decision: 'accept', quality: 'Exact original remains in the SQLite archive. Existing compact tables, page cursor and replay remain enabled.', preserved: [group] },
      { method: 'remove-required-material', saved: 0, decision: 'reject', quality: 'Would remove required meaning, exception or consumer; preservation has not been established.', preserved: [] },
    ],
  }, physicalMaximum).value.limit;
}

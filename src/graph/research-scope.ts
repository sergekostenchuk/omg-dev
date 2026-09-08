import type { Store, Revision, Write } from '../storage/store.js';
import { canonical } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import type { Graph } from './model.js';
import type { DiscoveryDraft, FieldSpec } from '../discovery/discovery.js';
import { refinementQuestions, deferredGap, type TechnicalGap, type TechnicalReport } from './research-contracts.js';
import { validateObligationPolicy, obligationAssignment, type ObligationPolicy } from './obligation-policy.js';

export interface ResearchScope {
  policy?: ObligationPolicy;
  projectId: string; layer: Ref; r1: Ref; outcome: string; nodes: string[];
  boundaries: { node: string; reason: string }[];
  expansions: { node: string; reason: string }[];
  obligations: { gap: TechnicalGap; state: 'active' | 'deferred'; reason: string;
    wake: { nodes: string[]; paths: string[]; uiRequired: boolean } | null }[];
  changedPaths: string[]; uiRequired: boolean;
}
export function originalGaps(store: Store, project: string): TechnicalGap[] {
  const phase = store.get<{ draft: Ref }>(`phase:${project}:R1`);
  const ref = phase?.value.draft;
  const draft = ref && store.get<DiscoveryDraft>(ref.id, ref.revision);
  requireCondition(draft?.kind === 'discovery-draft' && draft.hash === ref!.hash && draft.value.projectId === project,
    'scope_basis_missing', 'Scope needs the exact accepted R1 report');
  return Object.values(draft.value.fields).flatMap(value => (value as unknown as TechnicalReport).gaps);
}
export function prepareScopeWrite(store: Store, value: ResearchScope, expected: number): { write: Write; guards: Ref[] } {
  requireCondition(value && typeof value === 'object' && typeof value.projectId === 'string' && isRef(value.layer) && isRef(value.r1), 'scope_invalid', 'Explicit project and exact L2 reference are required');
  const layer = isRef(value.layer) && store.get<{ projection: Graph }>(value.layer.id);
  requireCondition(layer && layer.id === `graph-layer:${value.projectId}:2` && layer.kind === 'graph-layer'
    && canonical(reference(layer)) === canonical(value.layer), 'scope_basis_foreign', 'Scope must bind the exact current L2 of this project');
  const r1 = store.get(`phase:${value.projectId}:R1`);
  requireCondition(r1 && canonical(reference(r1)) === canonical(value.r1), 'scope_basis_foreign', 'Scope must bind the current accepted R1');
  const nodes = new Set(layer.value.projection.nodes.map(n => n.id));
  requireCondition(typeof value.outcome === 'string' && value.outcome.trim() && Array.isArray(value.nodes) && value.nodes.length > 0
    && value.nodes.every(n => nodes.has(n)) && Array.isArray(value.boundaries) && Array.isArray(value.expansions)
    && [...value.boundaries, ...value.expansions].every(b => b && nodes.has(b.node) && typeof b.reason === 'string' && b.reason.trim())
    && Array.isArray(value.changedPaths) && typeof value.uiRequired === 'boolean', 'scope_invalid', 'Scope needs a useful outcome, known nodes and reasons for external contracts/expansions');
  const gaps = originalGaps(store, value.projectId);
  requireCondition(Array.isArray(value.obligations) && value.obligations.length === gaps.length
    && value.obligations.every(o => o && o.gap && typeof o.gap.id === 'string')
    && new Set(value.obligations.map(o => o.gap.id)).size === gaps.length
    && gaps.every(g => value.obligations.some(o => canonical(o.gap) === canonical(g))),
  'scope_gap_missing', 'Every original gap must retain its exact identity and contents');
  const policyGuards = validateObligationPolicy(store, value);
  requireCondition(!store.get<ResearchScope>(`research-scope:${value.projectId}:R2`)?.value.policy || value.policy,
    'obligation_policy_missing', 'Updating scope cannot silently remove the explicit obligation policy');
  for (const o of value.obligations) requireCondition(['active', 'deferred'].includes(o.state) && typeof o.reason === 'string' && o.reason.trim()
    && (o.state === 'active' || (o.gap.requiredFor==='next' && o.wake && Array.isArray(o.wake.nodes) && o.wake.nodes.every(n => nodes.has(n))
      && Array.isArray(o.wake.paths) && o.wake.paths.every(p => typeof p === 'string' && p.length > 0) && typeof o.wake.uiRequired === 'boolean'
      && (o.wake.nodes.length > 0 || o.wake.paths.length > 0 || o.wake.uiRequired))),
  'scope_deferral_invalid', 'Research deferral requires an explicit reason and a testable return condition');
  return { write: { id: `research-scope:${value.projectId}:R2`, kind: 'research-scope', expected, value },
    guards: [reference(layer), reference(store.get(`phase:${value.projectId}:R1`)!), ...policyGuards] };
}
export function configureResearchScope(store: Store, value: ResearchScope, expected: number): Revision<ResearchScope> {
  const prepared = prepareScopeWrite(store, value, expected);
  return store.writeMany<ResearchScope>([prepared.write], prepared.guards)[0]!;
}
export function researchScope(store: Store, project: string): Revision<ResearchScope> | null {
  const scope = store.get<ResearchScope>(`research-scope:${project}:R2`);
  if (!scope) return null;
  const layer = store.get(scope.value.layer?.id ?? '');
  const r1 = store.get(`phase:${project}:R1`);
  requireCondition(scope.kind === 'research-scope' && scope.value.projectId === project && layer?.id === `graph-layer:${project}:2`
    && canonical(reference(layer)) === canonical(scope.value.layer) && r1 && isRef(scope.value.r1)
    && canonical(reference(r1)) === canonical(scope.value.r1), 'scope_basis_foreign', 'Research scope belongs to another or changed L2');
  validateObligationPolicy(store, scope.value);
  return scope;
}
export function scopeObligations(scope: ResearchScope) {
  if (scope.policy) return scope.obligations.map(o => {
    const assignment = obligationAssignment(scope, o.gap.id)!;
    return { ...o, assignment, state: assignment.moment === 'R2' ? 'active' as const : 'deferred' as const };
  });
  const active = new Set([...scope.nodes, ...scope.boundaries.map(b => b.node), ...scope.expansions.map(b => b.node)]);
  return scope.obligations.map(o => ({ ...o, state: o.state === 'active' || active.has(o.gap.target) || active.has(o.gap.consumer)
    || (o.wake && (o.wake.nodes.some(n => active.has(n)) || (o.wake.uiRequired && scope.uiRequired)
      || o.wake.paths.some(p => scope.changedPaths.some(changed => changed === p || changed.startsWith(p + '/'))))) ? 'active' as const : 'deferred' as const }));
}
export function scopedQuestions(scope: ResearchScope, extra: TechnicalGap[] = [], grouping: 'target' | 'target-field' = 'target'): FieldSpec[] {
  return refinementQuestions('R2', [...scopeObligations(scope).filter(o => o.state === 'active').map(o => o.gap), ...extra], grouping)
    .map(spec => ({ ...groupCoverageSpec(scope, spec, extra), prompt: `${spec.prompt}\nБлижайший результат: ${scope.outcome}\nПодробная область: ${[...scope.nodes, ...scope.expansions.map(e => e.node)].join(', ')}. Необходимые внешние контракты: ${scope.boundaries.map(b => `${b.node}: ${b.reason}`).join('; ')}. Полный каталог остаётся доступен; необходимую новую зависимость явно обоснуй.` }));
}

export function scopeDefersGap(store: Store, project: string, gap: TechnicalGap): boolean {
  const scope = researchScope(store, project);
  return gap.requiredFor === 'next' && Boolean(scope && scopeObligations(scope.value).some(o => o.state === 'deferred' && canonical(o.gap) === canonical(gap)));
}

export function researchGapDeferred(store: Store, project: string, graph: Graph, gap: TechnicalGap): boolean {
  const scope = researchScope(store, project);
  const original = scope?.value.obligations.find(o => o.gap.id === gap.id);
  if (scope?.value.policy && original) return canonical(original.gap) === canonical(gap)
    && obligationAssignment(scope.value, gap.id)!.moment !== 'R2';
  return scopeDefersGap(store, project, gap) || deferredGap(graph, gap);
}

export function expandResearchScope(store: Store, project: string, expected: number, node: string, reason: string,
  changedPaths: string[] = [], uiRequired = false) {
  const current = researchScope(store, project);
  requireCondition(current?.revision === expected, 'research_scope_stale', 'Expand the current scope, preserving its existing obligations');
  return configureResearchScope(store, { ...current.value,
    expansions: [...current.value.expansions.filter(e => e.node !== node), { node, reason }],
    changedPaths: [...new Set([...current.value.changedPaths, ...changedPaths])], uiRequired: current.value.uiRequired || uiRequired }, expected);
}

function groupCoverageSpec(scope: ResearchScope, spec: FieldSpec, extra: TechnicalGap[]): FieldSpec {
  if (!spec.targets?.length) return spec;
  const obligations = [...scopeObligations(scope).filter(o => o.state === 'active').map(o => o.gap), ...extra].filter(g => spec.targets!.some(t =>
    t.target === g.target && t.field === g.field && t.consumer === g.consumer))
    .map(g => ({ id: g.id, target: g.target, field: g.field, consumer: g.consumer,
      ...(scope.policy && scope.obligations.some(o => o.gap.id === g.id) ? { assignment: obligationAssignment(scope, g.id)! } : {}) }));
  if (!obligations.length) return spec;
  const schema = structuredClone(spec.schema) as { required: string[]; properties: Record<string, import('../canonical.js').Json> };
  schema.required.push('coverage');
  const ids = { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } };
  schema.properties['coverage'] = { type: 'array', minItems: obligations.length, maxItems: obligations.length, items: {
    type: 'object', additionalProperties: false, required: ['obligation','facts','designs','gaps'], properties: {
      obligation: { enum: obligations.map(o => o.id) }, facts: ids, designs: ids, gaps: ids,
    },
  } };
  return { ...spec, schema, obligations };
}

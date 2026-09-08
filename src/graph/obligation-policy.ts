import { Ajv } from 'ajv';
import { canonical } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Store, Revision } from '../storage/store.js';
import type { ResearchScope } from './research-scope.js';
import type { Source } from '../evidence/evidence.js';

export const KNOWLEDGE_KINDS = ['repository-fact', 'design-decision', 'owner-decision', 'environment-confirmation', 'post-implementation-proof'] as const;
export const RESOLUTION_MOMENTS = ['R2', 'R3', 'task-start', 'task-result'] as const;
export interface RuntimeCheck { script: Ref; dependencies: Ref[]; subjects: string[]; executables: string[]; args: string[]; timeoutMs: number; purpose: string;
  /** Explicit owner contract: exit zero certifies this entire return condition. */
  satisfies?: string }
export interface ObligationAssignment {
  obligation: string;
  original: { record: Ref; pointer: string };
  kind: typeof KNOWLEDGE_KINDS[number];
  moment: typeof RESOLUTION_MOMENTS[number];
  responsibleNode: string; responsibleConsumer: string;
  neededForR2: boolean; reason: string;
  returnCondition: string | null;
  documentaryAllowance?: { sources: Ref[]; claimLimit: string };
  runtimeCheck?: RuntimeCheck;
}
export interface ObligationPolicy { version: 1; sourceScope: Ref; assignments: ObligationAssignment[] }
export interface CarriedObligation extends ObligationAssignment { scope: Ref; wake: ResearchScope['obligations'][number]['wake'] }
const text = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const ref = object({ id: text, revision: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
const assignmentSchema = object({
  obligation: text, original: object({ record: ref, pointer: text }), kind: { enum: KNOWLEDGE_KINDS }, moment: { enum: RESOLUTION_MOMENTS },
  responsibleNode: text, responsibleConsumer: text, neededForR2: { type: 'boolean' }, reason: text,
  returnCondition: { anyOf: [text, { type: 'null' }] },
});
assignmentSchema.properties['documentaryAllowance'] = object({ sources: { type: 'array', minItems: 1, uniqueItems: true, items: ref }, claimLimit: text });
assignmentSchema.properties['runtimeCheck'] = object({ script:ref,dependencies:{type:'array',uniqueItems:true,items:ref},
  subjects:{type:'array',uniqueItems:true,items:text},executables:{type:'array',uniqueItems:true,items:text},
  args:{type:'array',items:{type:'string'}},timeoutMs:{type:'integer',minimum:100,maximum:60000},purpose:text });
(assignmentSchema.properties['runtimeCheck'] as ReturnType<typeof object>).properties['satisfies'] = text;
export const obligationPolicySchema = object({ version: { const: 1 }, sourceScope: ref, assignments: { type: 'array', items: assignmentSchema } });
const valid = new Ajv({ allErrors: true }).compile<ObligationPolicy>(obligationPolicySchema);

/** The owner supplies the complete policy once; a model answer cannot amend it. */
export function validateObligationPolicy(store: Store, scope: ResearchScope): Ref[] {
  const policy = scope.policy;
  if (policy === undefined) return [];
  requireCondition(valid(policy), 'obligation_policy_invalid', 'Every obligation needs an explicit kind, owner, deadline and return rule');
  const source = store.get<ResearchScope>(policy.sourceScope.id, policy.sourceScope.revision);
  requireCondition(source?.kind === 'research-scope' && source.id === `research-scope:${scope.projectId}:R2`
    && source.hash === policy.sourceScope.hash && source.value.projectId === scope.projectId,
  'obligation_origin_invalid', 'Policy must address the exact original scope of this project');
  const assignments = policy.assignments;
  requireCondition(assignments.length === scope.obligations.length
    && new Set(assignments.map(a => a.obligation)).size === scope.obligations.length
    && scope.obligations.every(o => assignments.some(a => a.obligation === o.gap.id)),
  'obligation_policy_incomplete', 'Apply assignments for every original obligation together, without merging or dropping identities');
  for (const assignment of assignments) {
    const original = /^\/obligations\/(0|[1-9][0-9]*)\/gap$/.exec(assignment.original.pointer);
    const old = original ? source.value.obligations[Number(original[1])] : undefined;
    const current = scope.obligations.find(o => o.gap.id === assignment.obligation)!;
    requireCondition(canonical(assignment.original.record) === canonical(policy.sourceScope)
      && old?.gap.id === assignment.obligation && canonical(old.gap) === canonical(current.gap)
      && old.state === current.state && canonical(old.wake) === canonical(current.wake),
    'obligation_origin_invalid', 'The original address must resolve to this unchanged obligation, not another gap or scope');
    requireCondition(assignment.responsibleNode === current.gap.target && assignment.responsibleConsumer === current.gap.consumer,
      'obligation_owner_invalid', 'Classification cannot change the original target or responsible consumer');
    requireCondition(assignment.reason.trim() && (!assignment.neededForR2 || assignment.moment === 'R2')
      && (assignment.moment === 'R2' ? assignment.returnCondition === null
        : current.gap.requiredFor === 'next' && typeof assignment.returnCondition === 'string' && assignment.returnCondition.trim()),
    'obligation_deadline_invalid', 'Anything needed for R2 stays due now; transfer needs a reason, return condition and named consumer');
    if (assignment.documentaryAllowance) {
      requireCondition(assignment.kind === 'environment-confirmation' && assignment.documentaryAllowance.claimLimit.trim(),
        'obligation_document_allowance_invalid', 'A documentary allowance is a bounded metadata confirmation, never a repository fact or implementation proof');
      for (const ref of assignment.documentaryAllowance.sources) {
        const document = store.get<Source>(ref.id, ref.revision);
        requireCondition(document?.kind === 'source' && document.hash === ref.hash && document.value.projectId === scope.projectId
          && document.value.origin.kind === 'owner-document', 'obligation_document_allowance_invalid',
        'An allowance must bind exact document sources of this project; a filename or an owner assertion is not sufficient');
      }
    }
    if (assignment.runtimeCheck) {
      requireCondition(!assignment.documentaryAllowance,'obligation_confirmation_ambiguous','Choose a bounded documentary allowance or an actual runtime check; a report must not bypass the declared check');
      requireCondition(assignment.kind === 'environment-confirmation' && assignment.runtimeCheck.purpose.trim(),
        'obligation_runtime_check_invalid','A declared local runtime check must serve an environment obligation');
      if (assignment.runtimeCheck.satisfies !== undefined) requireCondition(assignment.moment !== 'R2'
        && assignment.runtimeCheck.satisfies === assignment.returnCondition,
      'obligation_runtime_condition_invalid', 'An automatic readiness check must explicitly certify the exact approved return condition; an observation alone is not a pass');
      for (const ref of [assignment.runtimeCheck.script,...assignment.runtimeCheck.dependencies]) {
        const code = store.get<Source>(ref.id,ref.revision);
        const script=canonical(ref)===canonical(assignment.runtimeCheck.script);
        requireCondition(code?.kind === 'source' && code.hash === ref.hash && code.value.projectId === scope.projectId
          && ['text/plain','application/json'].includes(code.value.mediaType) && code.value.content.trim()
          && (script ? code.value.mediaType==='text/plain' && (code.value.origin.kind==='file'&&code.value.origin.location.endsWith('.mjs')
            ||code.value.origin.kind==='owner-document'&&!code.value.provenance&&assignment.runtimeCheck.dependencies.length===0)
            :code.value.origin.kind==='file'),
        'obligation_runtime_check_invalid','Declare exact repository modules or a self-contained operator module; do not change the accepted source snapshot to install tooling');
      }
    }
  }
  // Historical origins are immutable; only their current head is a transaction
  // guard when the policy is first applied to that same scope entity.
  const current = store.get(source.id);
  return current?.revision === source.revision && current.hash === source.hash ? [reference(current)] : [];
}

export function carriedObligations(scope: Revision<ResearchScope>): CarriedObligation[] {
  return (scope.value.policy ? scope.value.obligations.map(o => obligationAssignment(scope.value, o.gap.id)!) : []).filter(a => a.moment !== 'R2')
    .map(assignment => ({ ...assignment, scope: reference(scope),
      wake: scope.value.obligations.find(o => o.gap.id === assignment.obligation)!.wake }));
}

export function obligationAssignment(scope: ResearchScope, id: string): ObligationAssignment | null {
  if (scope.policy === undefined) return null;
  requireCondition(valid(scope.policy), 'obligation_policy_invalid', 'The recorded obligation policy is incomplete');
  requireCondition(scope.policy.assignments.length === scope.obligations.length
    && new Set(scope.policy.assignments.map(a => a.obligation)).size === scope.obligations.length,
  'obligation_policy_incomplete', 'The policy must retain one unique assignment per original obligation');
  const assignment = scope.policy.assignments.find(a => a.obligation === id);
  requireCondition(assignment, 'obligation_policy_incomplete', 'An unknown assignment remains unresolved; it cannot default to deferral');
  return assignment;
}

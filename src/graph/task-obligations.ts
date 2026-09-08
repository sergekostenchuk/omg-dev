import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { type Finding, type Ref } from '../pipeline/contracts.js';
import { Ajv } from 'ajv';
import type { Store } from '../storage/store.js';
import type { Graph } from './model.js';
import type { ResearchScope } from './research-scope.js';
import { carriedObligations, type CarriedObligation } from './obligation-policy.js';
import { RefinementRelations } from './relations.js';
import { obligationHandoff, type ObligationHandoff } from './obligation-handoff.js';
import { taskObligationBindingSchema, type BoundTaskObligation, type TaskObligationBinding } from './task-obligation-model.js';
const validBindings = new Ajv({ allErrors: true }).compile<TaskObligationBinding[]>({ type: 'array', items: taskObligationBindingSchema });

export const TASK_OBLIGATION_CONTRACT = 'task-obligations-v1';
export const taskBindingId = (obligation: CarriedObligation): string => `obligation:${hashJson([obligation.scope, obligation.original]).slice(0, 40)}`;
export const taskObligations = (handoff: ObligationHandoff) => handoff.obligations.filter(item => ['task-start','task-result'].includes(item.moment));

/** Historical plans follow the immutable producing L3, not a missing field on
 * a mutable current plan. New L3 seals explicitly opt into task consumers. */
export function taskObligationHandoff(store: Store, project: string, inputs: Ref[]): ObligationHandoff | null {
  const ref = inputs.find(input => input.id === `phase:${project}:L3`);
  if (!ref) return null;
  const producer = store.get<{ projectId: string; taskObligationContract?: string }>(ref.id, ref.revision);
  requireCondition(producer?.kind === 'phase' && producer.hash === ref.hash && producer.value.projectId === project,
    'task_obligation_contract_invalid', 'The producing L3 is missing or foreign');
  if (producer.value.taskObligationContract === undefined) return null;
  requireCondition(producer.value.taskObligationContract === TASK_OBLIGATION_CONTRACT,
    'task_obligation_contract_invalid', 'The task contract must come from the exact sealed L3');
  const handoff = obligationHandoff(store, project, inputs);
  requireCondition(handoff, 'task_obligation_contract_invalid', 'The new L3 task contract must retain its actual scoped R2 basis');
  return handoff;
}

export function bindTaskObligations(store: Store, project: string, graph: Graph, handoff: ObligationHandoff | null) {
  const findings: Finding[] = [], byNode = new Map<string, BoundTaskObligation[]>();
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
  if (!handoff) {
    if (graph.researchObligations?.length) fail('task_obligation_foreign', graph.id, 'Task obligations need their exact R2 handoff');
    return { findings, byNode };
  }
  const scope = store.get<ResearchScope>(handoff.scope.id, handoff.scope.revision);
  requireCondition(scope?.kind === 'research-scope' && scope.hash === handoff.scope.hash && scope.value.projectId === project,
    'task_obligation_scope_foreign', 'The task consumers must use the exact policy scope');
  requireCondition(canonical(handoff.obligations) === canonical(carriedObligations(scope)),
    'task_obligation_scope_foreign', 'L3 must not change the original kind, deadline, owner or return condition');
  const obligations = taskObligations(handoff), bindings = graph.researchObligations;
  if (!Array.isArray(bindings)) {
    fail('task_obligation_bindings_missing', graph.id, 'L3 must explicitly retain task bindings, including an empty set when nothing is due');
    return { findings, byNode };
  }
  if (!validBindings(bindings)) {
    fail('task_obligation_binding_invalid', graph.id, 'A binding needs its exact identity, scope and concrete consumers/tests'); return { findings, byNode };
  }
  const relations = new RefinementRelations(graph);
  const active = graph.nodes.filter(node => graph.horizon.includes(node.id));
  const scoped = [...scope.value.nodes, ...scope.value.boundaries.map(item => item.node), ...scope.value.expansions.map(item => item.node)];
  const changedPaths = [...scope.value.changedPaths, ...active.flatMap(node => node.code.filter(code => code.access === 'write').map(code => code.path))];
  const awakened = (obligation: CarriedObligation) => {
    const original = scope.value.obligations.find(item => item.gap.id === obligation.obligation)!;
    const wake = obligation.wake;
    const triggered = Boolean(wake && (wake.uiRequired && scope.value.uiRequired || wake.nodes.some(id => scoped.includes(id)
      || active.some(node => relations.refines(node.id, id))) || wake.paths.some(path => changedPaths.some(changed => changed === path || changed.startsWith(path + '/')))));
    // An active research obligation can concern a boundary whose work has not
    // been detailed yet. Keep it in the exact R2 handoff until a valid consumer
    // exists; each later L3 is checked again. Product ancestry still counts.
    if (original.state === 'active') return triggered
      || graph.nodes.some(node => node.kind === 'work' && relations.refines(node.id, obligation.responsibleNode));
    return triggered || scoped.includes(obligation.responsibleNode) || scoped.includes(obligation.responsibleConsumer);
  };
  if (new Set(bindings.map(binding => binding.id)).size !== bindings.length) fail('task_obligation_duplicate', graph.id, 'Each carried identity has exactly one L3 binding');
  for (const binding of bindings) {
    const obligation = obligations.find(item => taskBindingId(item) === binding.id);
    if (!obligation || binding.obligation !== obligation.obligation || canonical(binding.scope) !== canonical(obligation.scope)) {
      fail('task_obligation_foreign', binding.id, 'A binding cannot borrow another scope, original identity or resolution moment'); continue;
    }
    if (!Array.isArray(binding.consumers) || !binding.consumers.length || new Set(binding.consumers.map(consumer => consumer.node)).size !== binding.consumers.length) {
      fail('task_obligation_consumer_missing', binding.id, 'Name distinct concrete work consumers'); continue;
    }
    for (const consumer of binding.consumers) {
      const node = graph.nodes.find(item => item.id === consumer.node);
      if (node?.kind !== 'work' || !relations.refines(node.id, obligation.responsibleNode)) {
        fail('task_obligation_consumer_foreign', binding.id, 'The named work must realize the original responsible node'); continue;
      }
      if (!Array.isArray(consumer.tests) || new Set(consumer.tests).size !== consumer.tests.length
        || consumer.tests.some(id => !node.tests.includes(id) || !graph.tests.some(test => test.id === id && test.node === node.id && test.contract))) {
        fail('task_obligation_test_foreign', binding.id, 'Every selected test must be a concrete contract of this same work node'); continue;
      }
      const supported = obligation.kind === 'post-implementation-proof' && obligation.moment === 'task-result' && consumer.tests.length > 0
        || obligation.kind === 'environment-confirmation' && obligation.runtimeCheck?.satisfies === obligation.returnCondition;
      if (!supported) {
        fail('task_obligation_resolution_required', binding.id, 'This knowledge kind/deadline has no declared admissible consumer proof; do not infer success or change its kind'); continue;
      }
      if (awakened(obligation)) byNode.set(node.id, [...(byNode.get(node.id) ?? []), { binding: binding.id, requirement: obligation, tests: [...consumer.tests] }]);
    }
  }
  for (const obligation of obligations) if (awakened(obligation) && !bindings.some(binding => binding.id === taskBindingId(obligation)))
    fail('task_obligation_consumer_missing', obligation.obligation, 'An active carried obligation cannot disappear between R2 and the concrete L3 consumers');
  for (const values of byNode.values()) values.sort((a, b) => a.binding.localeCompare(b.binding));
  return { findings, byNode };
}

export function requireTaskObligations(store: Store, project: string, graph: Graph, handoff: ObligationHandoff | null) {
  const result = bindTaskObligations(store, project, graph, handoff);
  if (result.findings.length) throw new EngineError('task_obligation_bindings_invalid', result.findings.map(item => `${item.code}: ${item.target}`).join('; '), result.findings);
  return result.byNode;
}

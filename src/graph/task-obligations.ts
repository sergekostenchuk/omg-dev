import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, type Finding, type Ref } from '../pipeline/contracts.js';
import { Ajv } from 'ajv';
import { Store } from '../storage/store.js';
import type { GapRecord } from '../om/gaps.js';
import { historicalRead } from '../history/proofs.js';
import type { Graph } from './model.js';
import type { ResearchScope } from './research-scope.js';
import { graphSchema, graphV2Schema } from './schema.js';
import { carriedObligations, type CarriedObligation } from './obligation-policy.js';
import { RefinementRelations } from './relations.js';
import { obligationHandoff, omObligationHandoff, type ObligationHandoff } from './obligation-handoff.js';
import { taskObligationBindingSchema, type BoundTaskObligation, type TaskObligationBinding } from './task-obligation-model.js';
const shapes = new Ajv({ allErrors: true, allowUnionTypes: true });
const validBindings = shapes.compile<TaskObligationBinding[]>({ type: 'array', items: taskObligationBindingSchema });
const validGraph = shapes.compile<Graph>({ anyOf: [graphSchema, graphV2Schema] });

export const TASK_OBLIGATION_CONTRACT = 'task-obligations-v1';
export const taskBindingId = (obligation: CarriedObligation): string => `obligation:${hashJson(obligation.scope.id.startsWith('om-obligations:')
  ? [obligation.scope, obligation.original, obligation.responsibleNode, obligation.responsibleConsumer]
  : [obligation.scope, obligation.original]).slice(0, 40)}`;
export const taskObligations = (handoff: ObligationHandoff) => handoff.obligations.filter(item => ['task-start','task-result'].includes(item.moment));

/** Historical plans follow the immutable producing L3, not a missing field on
 * a mutable current plan. New L3 seals explicitly opt into task consumers. */
export function taskObligationHandoff(store: Store, project: string, inputs: Ref[]): ObligationHandoff | null {
  const om = omObligationHandoff(store, project, inputs);
  if (om) return om;
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

export interface TaskObligationCheck {
  findings: Finding[];
  byNode: Map<string, BoundTaskObligation[]>;
}

function verifiedScope(store: Store, project: string, handoff: ObligationHandoff): ResearchScope | null {
  let scope: ResearchScope | null = null;
  if (!('r2' in handoff)) {
    const verified = historicalRead(store, { reader: 'task-obligations.om-handoff', project,
      ref: handoff.producer, parameters: { scope: { ...handoff.scope } } },
    () => omObligationHandoff(store, project, [handoff.producer, handoff.scope]),
    () => { throw new EngineError('task_obligation_scope_foreign', 'The exact OM obligation handoff has a cyclic derivation'); }, value => value !== null);
    // Only the immutable source proof is shared. Every caller still proves it
    // supplied the entire unmodified ledger, even when those refs are cached.
    requireCondition(verified && canonical(verified) === canonical(handoff),
      'task_obligation_scope_foreign', 'Task consumers must retain the exact OM producer and its complete obligation ledger');
  } else {
    const record = store.get<ResearchScope>(handoff.scope.id, handoff.scope.revision);
    requireCondition(record?.kind === 'research-scope' && record.hash === handoff.scope.hash && record.value.projectId === project,
      'task_obligation_scope_foreign', 'The task consumers must use the exact policy scope');
    requireCondition(canonical(handoff.obligations) === canonical(carriedObligations(record)),
      'task_obligation_scope_foreign', 'L3 must not change the original kind, deadline, owner or return condition');
    scope = record.value;
  }
  return scope;
}

function bindingContext(store: Store, graph: Graph, handoff: ObligationHandoff, scope: ResearchScope | null) {
  const relations = new RefinementRelations(graph);
  const active = graph.nodes.filter(node => graph.horizon.includes(node.id));
  const scoped = scope ? [...scope.nodes, ...scope.boundaries.map(item => item.node), ...scope.expansions.map(item => item.node)] : [];
  const changedPaths = [...(scope?.changedPaths ?? []), ...active.flatMap(node => node.code.filter(code => code.access === 'write').map(code => code.path))];
  const awakened = (obligation: CarriedObligation) => {
    const wake = obligation.wake;
    const triggered = Boolean(wake && (wake.uiRequired && scope?.uiRequired || wake.nodes.some(id => scoped.includes(id)
      || active.some(node => relations.refines(node.id, id))) || wake.paths.some(path => changedPaths.some(changed => changed === path || changed.startsWith(path + '/')))));
    if (!scope) {
      // The common OM reader has proved this exact /gap. Its original deferral
      // survives the handoff; a new work refinement can make its consumer due.
      const original = store.get<GapRecord>(obligation.original.record.id, obligation.original.record.revision)!.value.gap;
      const realizes = (node: Graph['nodes'][number]) => node.kind === 'work'
        && relations.refines(node.id, obligation.responsibleNode) && relations.refines(node.id, obligation.responsibleConsumer);
      // Graphs have no uiRequired signal. Retain that explicit wake term without
      // inventing a UI classification; responsible active work still wakes it.
      return triggered || (original.deferral ? active : graph.nodes).some(realizes);
    }
    const original = scope.obligations.find(item => item.gap.id === obligation.obligation)!;
    // An active research obligation can concern a boundary whose work has not
    // been detailed yet. Keep it in the exact R2 handoff until a valid consumer
    // exists; each later L3 is checked again. Product ancestry still counts.
    if (original.state === 'active') return triggered
      || graph.nodes.some(node => node.kind === 'work' && relations.refines(node.id, obligation.responsibleNode));
    return triggered || scoped.includes(obligation.responsibleNode) || scoped.includes(obligation.responsibleConsumer);
  };
  return { graph, scope, obligations: taskObligations(handoff), relations, awakened };
}

/** One row has the same proof rules in a node answer and the complete L3 set. */
function checkBinding(context: ReturnType<typeof bindingContext>, binding: TaskObligationBinding, result: TaskObligationCheck): void {
  const { graph, scope, obligations, relations, awakened } = context, { findings, byNode } = result;
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
  const obligation = obligations.find(item => taskBindingId(item) === binding.id);
  if (!obligation || binding.obligation !== obligation.obligation || canonical(binding.scope) !== canonical(obligation.scope)) {
    fail('task_obligation_foreign', binding.id, 'A binding cannot borrow another scope, original identity or resolution moment'); return;
  }
  if (!Array.isArray(binding.consumers) || !binding.consumers.length || new Set(binding.consumers.map(consumer => consumer.node)).size !== binding.consumers.length) {
    fail('task_obligation_consumer_missing', binding.id, 'Name distinct concrete work consumers'); return;
  }
  for (const consumer of binding.consumers) {
    const node = graph.nodes.find(item => item.id === consumer.node);
    if (node?.kind !== 'work' || !relations.refines(node.id, obligation.responsibleNode)
      || !scope && !relations.refines(node.id, obligation.responsibleConsumer)) {
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

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactRef = (value: unknown): value is Ref => isRef(value) && Object.keys(value).length === 3;
function bindingRequest(store: Store, project: string, graph: Graph, handoff: ObligationHandoff, binding: TaskObligationBinding): void {
  const invalid = (field: string): never => { throw new EngineError('task_obligation_request_invalid',
    'A task binding check needs a Store, project, graph, complete handoff and one exact binding', { target: 'task-obligation-binding', field }); };
  if (!(store instanceof Store)) invalid('store');
  if (typeof project !== 'string' || !project.length) invalid('project');
  if (!validGraph(graph)) invalid('graph');
  if (!object(handoff) || !exactRef(handoff.scope) || !Array.isArray(handoff.obligations)
    || !handoff.obligations.every(object)) invalid('handoff');
  if ('r2' in handoff) {
    if (Object.keys(handoff).length !== 3 || !exactRef(handoff.r2)) invalid('handoff.r2');
  } else if (Object.keys(handoff).length !== 4 || typeof handoff.era !== 'string' || !handoff.era.length || !exactRef(handoff.producer)) invalid('handoff.producer');
  if (!validBindings([binding])) invalid('binding');
}

/** Check one row against the complete historical authority. Success does not
 * prove that the node answer or the final candidate supplies every binding. */
export function checkTaskObligationBinding(store: Store, project: string, graph: Graph, handoff: ObligationHandoff,
  binding: TaskObligationBinding): TaskObligationCheck {
  bindingRequest(store, project, graph, handoff, binding);
  // This public entry accepts an exact legacy handoff, not a caller-built scope.
  // Existing complete consumers retain their established scope admission below.
  if ('r2' in handoff) {
    const verified = obligationHandoff(store, project, [handoff.r2, handoff.scope]);
    requireCondition(verified && canonical(verified) === canonical(handoff),
      'task_obligation_scope_foreign', 'A task binding needs the complete handoff of the exact producing R2');
  }
  const scope = verifiedScope(store, project, handoff), result: TaskObligationCheck = { findings: [], byNode: new Map() };
  checkBinding(bindingContext(store, graph, handoff, scope), binding, result);
  for (const values of result.byNode.values()) values.sort((a, b) => a.binding.localeCompare(b.binding));
  return result;
}

export function bindTaskObligations(store: Store, project: string, graph: Graph, handoff: ObligationHandoff | null): TaskObligationCheck {
  const findings: Finding[] = [], byNode = new Map<string, BoundTaskObligation[]>(), result = { findings, byNode };
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
  if (!handoff) {
    if (graph.researchObligations?.length) fail('task_obligation_foreign', graph.id, 'Task obligations need their exact R2 handoff');
    return result;
  }
  const scope = verifiedScope(store, project, handoff), bindings = graph.researchObligations;
  if (!Array.isArray(bindings)) {
    fail('task_obligation_bindings_missing', graph.id, 'L3 must explicitly retain task bindings, including an empty set when nothing is due');
    return result;
  }
  if (!validBindings(bindings)) {
    fail('task_obligation_binding_invalid', graph.id, 'A binding needs its exact identity, scope and concrete consumers/tests'); return result;
  }
  const context = bindingContext(store, graph, handoff, scope);
  if (new Set(bindings.map(binding => binding.id)).size !== bindings.length) fail('task_obligation_duplicate', graph.id, 'Each carried identity has exactly one L3 binding');
  for (const binding of bindings) checkBinding(context, binding, result);
  for (const obligation of context.obligations) if (context.awakened(obligation) && !bindings.some(binding => binding.id === taskBindingId(obligation)))
    fail('task_obligation_consumer_missing', obligation.obligation, 'An active carried obligation cannot disappear between R2 and the concrete L3 consumers');
  for (const values of byNode.values()) values.sort((a, b) => a.binding.localeCompare(b.binding));
  return result;
}

export function requireTaskObligations(store: Store, project: string, graph: Graph, handoff: ObligationHandoff | null) {
  const result = bindTaskObligations(store, project, graph, handoff);
  if (result.findings.length) throw new EngineError('task_obligation_bindings_invalid', result.findings.map(item => `${item.code}: ${item.target}`).join('; '), result.findings);
  return result.byNode;
}

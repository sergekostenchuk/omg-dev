import { canonical, hashJson} from '../canonical.js';
import { EngineError } from '../errors.js';
import { composeLayer, layerDesignOf } from '../graph/layer-design.js';
import { type Binding, type Endpoint, type Graph } from '../graph/model.js';
import { RefinementRelations } from '../graph/relations.js';
import { bindTaskObligations, taskBindingId, taskObligations } from '../graph/task-obligations.js';
import type { TaskObligationBinding } from '../graph/task-obligation-model.js';
import { L3_ASSEMBLY, assembleL3 } from '../graph/layer-assembly.js';
import { projectGraph } from '../graph/project.js';
import { requireGraph, validateGraph } from '../graph/validate.js';
import { isRef, reference, type Finding, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { WORKS_FRAME_CONTRACT, representativeJoinId, workAnchorId, workFillCode, fillObligations, flowKey, readFrame, type ConnectionFrame, type FrameFill, type FrameRead, type PreparedFrame } from './frame-obligations.js';
import { applyProposals, definitionIds, observeProposal, openObligationsToGaps, prepareFrameProposals,
  type FrameGap, type ProposalObservation, type ProposalRequest, type ProposalResult } from './frame-proposals.js';
import { readOmObligations, prepareOmObligations, type ObligationRequest, type OmObligationHandoff } from './obligations.js';
import { withHistoricalReads } from './input.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';

export const CANDIDATE_REFUSAL_CODES = Object.freeze([
  'candidate_level_unsupported', 'candidate_missing', 'candidate_graph_mismatch',
  'works_contract_invalid', 'works_obligations_invalid', 'works_code_missing', 'works_code_foreign',
  'sleeping_anchor_underivable', 'sleeping_wake_test_missing', 'works_upper_drift',
  'derived_field_conflict', 'slot_fill_conflict', 'replacement_leaves_dangling', 'operation_port_unbound', 'graph_invalid',
] as const);
export type CandidateResult<T> = { readonly ok: true; readonly value: Sealed<T> }
  | { readonly ok: false; readonly refusal: Sealed<Refusal & { findings?: Finding[] }> };
export const JOIN_ASSEMBLY = 'identity-joins/v1' as const;
export interface FrameCandidate {
  joinAssembly?: typeof JOIN_ASSEMBLY;
  project: string; level: 2 | 3; works?: WorksCandidateInput; graphHash: string; layerHash: string; upperHash: string; graph: Graph;
  fills: ProposalResult['fills']; base: { graph: Ref; frame: Ref | null }; proposals: Ref[];
}
export type CandidateAssembly = { state: 'gaps'; gaps: FrameGap[] } | { state: 'candidate'; candidate: FrameCandidate };
export interface WorksCandidateInput { contract: typeof WORKS_FRAME_CONTRACT; producer: Ref; ledger: Ref; bindings: TaskObligationBinding[] }
export interface CandidateRequest extends ProposalRequest { works?: WorksCandidateInput; joinAssembly?: typeof JOIN_ASSEMBLY }
export interface FrameCandidateRecord extends FrameCandidate { request: CandidateRequest }
export type PreparedCandidate = { guards: Ref[]; expected: PreparedFrame['expected']; writes: Write[] } & (
  { state: 'gaps'; gaps: FrameGap[]; existing: null }
  | { state: 'candidate'; candidate: FrameCandidateRecord; existing: Revision<FrameCandidateRecord> | null });
export type CandidateWriteResult = { state: 'gaps'; gaps: FrameGap[] }
  | { state: 'candidate'; record: Revision<FrameCandidateRecord> };
export interface CandidateReadRequest { project: string; candidate: Ref }
export interface CandidateGateRequest extends CandidateReadRequest { graph?: unknown }
export interface CandidateGate { passed: true; candidate: Ref; graphHash: string; findings: Finding[] }
export interface ObservedCandidate { record: Revision<FrameCandidateRecord>; definitions: string[]; references: Ref[]; sources: CandidateRequest }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const unique = <T>(values: readonly T[]): T[] => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
const parts = ['artifacts', 'contracts', 'anchors', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers'] as const;
class CandidateFailure extends Error {
  constructor(readonly refusal: Refusal & { findings?: Finding[] }) { super(refusal.message); }
}
function invalid(field: string): never {
  throw new EngineError('candidate_request_invalid', 'Candidate assembly needs explicit, well-formed inputs',
    { unit: 'F4.5', target: 'candidate', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function reject(code: string, target: string, field: string, message: string, findings?: Finding[]): never {
  const result = refused(code, message, { unit: 'G3', target, field }, 'producer');
  if (!result.ok) throw new CandidateFailure({ ...result.refusal, ...(findings ? { findings } : {}) });
  throw new EngineError('candidate_internal_error', 'Refusal unexpectedly produced a value');
}
function take<T>(result: OmResult<T>): T {
  if (!result.ok) throw new CandidateFailure(result.refusal);
  return result.value;
}
function outcome<T>(action: () => T): CandidateResult<T> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) {
      if (error instanceof CandidateFailure) return { ok: false, refusal: sealed(error.refusal) };
      throw error;
    }
  });
}
function requireLevel(frame: unknown, works?: WorksCandidateInput): void {
  if (!object(frame) || !object(frame['request'])) invalid('frame');
  if (frame['request']['level'] !== 2 && frame['request']['level'] !== 3) invalid('frame.level');
  if (frame['request']['level'] === 3) requireWorks(works);
  else if (works !== undefined) reject('works_contract_invalid', 'candidate:2', 'works', 'A works contract belongs only to L3');
}
function requireStore(store: Store): void { if (!(store instanceof Store)) invalid('store'); }
function requireRequest(value: unknown): asserts value is CandidateRequest {
  if (!object(value) || !object(value['frame'])) invalid('frame');
  const frame = value['frame'];
  if (!text(frame['project']) || (frame['level'] !== 2 && frame['level'] !== 3)) invalid('frame.project/level');
  for (const field of ['horizon', 'graph']) if (!isRef(frame[field])) invalid(`frame.${field}`);
  for (const field of ['layer', 'frame']) if (frame[field] !== null && !isRef(frame[field])) invalid(`frame.${field}`);
  if (frame['level'] === 2 ? frame['upper'] !== null : !object(frame['upper']) || !isRef(frame['upper']['horizon'])
    || (frame['upper']['frame'] !== null && !isRef(frame['upper']['frame']))) invalid('frame.upper');
  if (!Array.isArray(value['proposals']) || !value['proposals'].every(isRef)) invalid('proposals');
  if (Object.hasOwn(value, 'joinAssembly') && (frame['level'] !== 3 || value['joinAssembly'] !== JOIN_ASSEMBLY)) invalid('joinAssembly');
}
function checkedEra(value: FrameCandidateRecord, target: string): typeof JOIN_ASSEMBLY | undefined {
  if (!object(value.request) || !object(value.request.frame))
    reject('candidate_graph_mismatch', target, 'request', 'The candidate must retain its complete source request');
  const marked = Object.hasOwn(value, 'joinAssembly'), requested = Object.hasOwn(value.request, 'joinAssembly');
  if (marked !== requested || marked && (value.level !== 3 || value.joinAssembly !== JOIN_ASSEMBLY
    || value.request.frame.level !== 3 || value.request.joinAssembly !== JOIN_ASSEMBLY))
    reject('candidate_graph_mismatch', target, 'joinAssembly', 'The saved candidate and its request must name the same known assembly era');
  return marked ? JOIN_ASSEMBLY : undefined;
}
function requireWorks(value: unknown): asserts value is WorksCandidateInput {
  if (!object(value) || value['contract'] !== WORKS_FRAME_CONTRACT
    || !isRef(value['producer']) || !isRef(value['ledger']) || !Array.isArray(value['bindings'])
    || Object.keys(value).some(key => !['contract', 'producer', 'ledger', 'bindings'].includes(key)))
    reject('works_contract_invalid', 'candidate:3', 'works', 'L3 requires its explicit contract, exact OM producer and ledger, and task bindings');
  for (const binding of value['bindings']) if (!object(binding) || !text(binding['id']) || !isRef(binding['scope'])
    || !text(binding['obligation']) || !Array.isArray(binding['consumers']) || !binding['consumers'].every((consumer: unknown) =>
      object(consumer) && text(consumer['node']) && Array.isArray(consumer['tests']) && consumer['tests'].every(text)))
    reject('works_obligations_invalid', 'candidate:3', 'bindings', 'Task bindings retain their explicit identity, scope, work and test selections');
}
function normalizedWorks(works: WorksCandidateInput): WorksCandidateInput {
  requireWorks(works);
  return copy({ ...works, bindings: sorted(works.bindings.map(binding => ({ ...binding,
    consumers: sorted(binding.consumers.map(consumer => ({ ...consumer, tests: sorted(consumer.tests) }))) }))) });
}
function normalizeRequest(request: CandidateRequest): CandidateRequest {
  return copy({ frame: request.frame, proposals: sorted(request.proposals),
    ...(Object.hasOwn(request, 'joinAssembly') ? { joinAssembly: request.joinAssembly! } : {}),
    ...(Object.hasOwn(request, 'works') ? { works: normalizedWorks(request.works!) } : {}) });
}

function requireRead(value: unknown): asserts value is CandidateReadRequest {
  if (!object(value) || !text(value['project'])) invalid('project');
  if (!isRef(value['candidate'])) invalid('candidate');
}
function idOf(value: FrameCandidate): string {
  return `om-candidate:${value.project}:${hashJson(value.level === 3
    ? (value.joinAssembly === JOIN_ASSEMBLY
      ? [value.level, value.joinAssembly, value.graphHash, value.base, value.proposals, value.works!]
      : [value.level, value.graphHash, value.base, value.proposals, value.works!]) : [value.graphHash, value.base, value.proposals])}`;
}

// Only typed node references count. Text and JSON Schema may legitimately contain a removed node's name.
function nodeReferences(part: string, value: unknown): { field: string; node: string }[] {
  const refs: { field: string; node: string }[] = [];
  const add = (field: string, node: string | null | undefined) => { if (node) refs.push({ field, node }); };
  switch (part) {
    case 'nodes': add('parent', (value as Graph['nodes'][number]).parent); break;
    case 'connectors': {
      const connector = value as Graph['connectors'][number]; add('returnsTo', connector.returnsTo);
      for (const binding of connector.bindings) {
        add(`bindings.${binding.level}.producer`, binding.producer.node);
        for (const endpoint of binding.consumers) add(`bindings.${binding.level}.consumer`, endpoint.node);
      }
      break;
    }
    case 'anchors': add('owner', (value as Graph['anchors'][number]).owner); break;
    case 'joins': {
      const join = value as Graph['joins'][number]; add('consumer', join.consumer); add('failures.returnsTo', join.failures?.returnsTo); break;
    }
    case 'tests': add('node', (value as Graph['tests'][number]).node); break;
    case 'edges': {
      const edge = value as NonNullable<Graph['edges']>[number]; add('source', edge.source); add('target', edge.target); break;
    }
    case 'journeys': {
      const journey = value as NonNullable<Graph['journeys']>[number]; add('entry', journey.entry);
      for (const node of journey.path) add('path', node); break;
    }
    case 'transfers': {
      const transfer = value as NonNullable<Graph['transfers']>[number]; add('from', transfer.from); add('to', transfer.to); break;
    }
    case 'packets': add('unit', (value as NonNullable<Graph['packets']>[number]).unit); break;
  }
  return refs;
}
function danglingReferences(graph: Graph, removed: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const part of ['nodes', 'connectors', ...parts] as const) for (const item of graph[part] ?? [])
    for (const ref of nodeReferences(part, item)) if (removed.has(ref.node))
      findings.push({ code: 'replacement_leaves_dangling', target: item.id, message: `${part}.${ref.field} → ${ref.node}` });
  for (const node of graph.horizon) if (removed.has(node))
    findings.push({ code: 'replacement_leaves_dangling', target: graph.id, message: `horizon → ${node}` });
  return unique(findings);
}
function bindingSet(bindings: readonly Binding[]): Binding[] {
  return sorted(bindings.map(binding => ({ ...binding, consumers: sorted(binding.consumers) })));
}
function mergeConnector(accepted: Graph['connectors'][number] | undefined, proposed: Graph['connectors'][number], level: 2 | 3): Graph['connectors'][number] {
  if (!accepted) return proposed;
  if (level === 3) return { ...proposed, bindings: [...accepted.bindings.filter(binding => binding.level !== 3),
    ...proposed.bindings.filter(binding => binding.level === 3)] };
  const carried = accepted.bindings.filter(binding => binding.level === 3);
  const supplied = proposed.bindings.filter(binding => binding.level === 3);
  // Omitting the future slice is not a deletion. An explicitly supplied slice must describe all of it.
  if (supplied.length && !same(bindingSet(supplied), bindingSet(carried)))
    reject('candidate_level_unsupported', proposed.id, 'connectors', 'Explicit L3 bindings differ from the accepted bindings');
  const lower = proposed.bindings.filter(binding => binding.level === 2), bindings: Binding[] = [];
  let inserted = false;
  for (const binding of accepted.bindings) {
    if (binding.level !== 2) bindings.push(binding);
    else if (!inserted) { bindings.push(...lower); inserted = true; }
  }
  if (!inserted) bindings.push(...lower);
  return { ...proposed, bindings };
}
const dependencyParts = ['nodes', 'connectors', ...parts, 'actors', 'requirements'] as const;
type DependencyPart = typeof dependencyParts[number];
interface ProtectedDefinition { part: DependencyPart; id: string; value: unknown }
function workDependencies(graph: Graph): Map<string, ProtectedDefinition> {
  const works = new Set(graph.nodes.filter(node => node.kind === 'work').map(node => node.id));
  const indexes = new Map<DependencyPart, Map<string, { id: string }>>(dependencyParts.map(part =>
    [part, new Map((graph[part] ?? []).map(value => [value.id, value]))]));
  const protectedDefinitions = new Map<string, ProtectedDefinition>(), queued = new Set<string>();
  const pending: { part: DependencyPart; id: string }[] = [];
  const add = (part: DependencyPart, id: string | null | undefined) => {
    if (!id) return;
    const key = canonical([part, id]);
    if (!queued.has(key)) { queued.add(key); pending.push({ part, id }); }
  };
  for (const part of dependencyParts) for (const value of graph[part] ?? []) {
    const root = part === 'nodes' && works.has(value.id)
      || part === 'connectors' && (value as Graph['connectors'][number]).bindings.some(binding => binding.level === 3)
      || nodeReferences(part, value).some(ref => works.has(ref.node));
    if (root) add(part, value.id);
  }
  for (const obligation of graph.researchObligations ?? []) for (const consumer of obligation.consumers)
    for (const test of consumer.tests) add('tests', test);
  for (let index = 0; index < pending.length; index++) {
    const { part, id } = pending[index]!, value = indexes.get(part)!.get(id);
    if (!value) { protectedDefinitions.set(canonical([part, id]), { part, id, value: null }); continue; }
    // A reference to a connector resolves at L3: its shared definition and work bindings, never its editable L2 slice.
    const definition = part === 'connectors' ? { ...value as Graph['connectors'][number],
      bindings: (value as Graph['connectors'][number]).bindings.filter(binding => binding.level === 3) } : value;
    protectedDefinitions.set(canonical([part, id]), { part, id, value: definition });
    // Upper-node identities are already retained in these records. Freezing their definitions would also forbid legal L2 edits.
    switch (part) {
      case 'nodes': {
        const node = value as Graph['nodes'][number]; add('artifacts', node.outcome);
        for (const port of node.ports) add('contracts', port.contract);
        for (const test of node.tests) add('tests', test);
        for (const requirement of node.implements ?? []) add('requirements', requirement);
        add('actors', node.beneficiary); break;
      }
      case 'artifacts': add('contracts', (value as Graph['artifacts'][number]).contract); break;
      case 'connectors': {
        const connector = definition as Graph['connectors'][number]; add('artifacts', connector.artifact); add('tests', connector.wakeTest);
        for (const binding of connector.bindings) add('anchors', binding.anchor); break;
      }
      case 'anchors': {
        const anchor = value as Graph['anchors'][number]; add('artifacts', anchor.outcome); add('tests', anchor.test); break;
      }
      case 'joins': {
        const join = value as Graph['joins'][number];
        for (const connector of [...join.connectors, ...(join.required ?? []), ...(join.optional ?? [])]) add('connectors', connector); break;
      }
      case 'tests': {
        const test = value as Graph['tests'][number];
        for (const connector of test.covers) add('connectors', connector);
        for (const counterfactual of test.contract?.counterfactuals ?? []) add('connectors', counterfactual.connector); break;
      }
      case 'journeys': {
        const journey = value as NonNullable<Graph['journeys']>[number]; add('artifacts', journey.outcome); add('actors', journey.actor); break;
      }
      case 'requirements': {
        const requirement = value as NonNullable<Graph['requirements']>[number];
        add('artifacts', requirement.outcome); add('actors', requirement.beneficiary); break;
      }
      // Contracts are opaque JSON Schema; labels, commands, paths and condition strings are not graph references.
      case 'contracts': case 'actors': case 'edges': case 'packets': case 'transfers': break;
    }
  }
  return protectedDefinitions;
}
function requireUnchangedWorks(accepted: Graph, graph: Graph): void {
  const before = workDependencies(accepted), after = workDependencies(graph);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key), next = after.get(key);
    if (!same(old?.value ?? null, next?.value ?? null)) {
      const address = old ?? next!;
      reject('candidate_level_unsupported', address.id, address.part,
        'The final candidate changes or removes an accepted L3 dependency; that requires F2');
    }
  }
  for (const field of ['horizon', 'researchObligations'] as const)
    if (!same(accepted[field] ?? null, graph[field] ?? null))
      reject('candidate_level_unsupported', graph.id, field, 'The accepted work horizon and research obligations must remain unchanged');
}
function checkedGraph(graph: Graph, upper: Graph, level: 2 | 3): void {
  const validation = validateGraph(graph);
  if (validation.findings.length) reject('graph_invalid', validation.findings[0]!.target || graph.id, 'graph',
    'The candidate failed the native graph validator', validation.findings);
  // requireGraph remains the native graph contract; composeLayer validates the derived L2 without pruning the saved graph.
  try { requireGraph(graph); composeLayer(upper, level, layerDesignOf(graph, level)); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    if (error.code === 'graph_invalid') reject(error.code, graph.id, 'graph', error.message, error.details as Finding[]);
    if (['layer_outcome_uncovered', 'layer_connector_uncovered', 'upper_layer_drift', 'derived_field_conflict',
      'layer_detail_invalid', 'graph_upgrade_required', 'layer_design_missing', 'layer_port_unbound', 'horizon_empty'].includes(error.code))
      reject(error.code, graph.id, 'layer', error.message);
    throw error;
  }
}
/** Enrich only the NEW candidate. Legacy C2 output remains a faithful historical value. */
function workCodeFills(frame: FrameRead, result: ProposalResult, graph: Graph): ProposalResult {
  return { ...result, fills: sorted(result.fills.map(fill => {
    const obligation = result.obligations.find(item => item.id === fill.obligation)!;
    if (obligation.kind !== 'connection-end' || fill.source === 'identity') {
      if (Object.hasOwn(fill, 'codeRef')) reject('works_code_foreign', fill.node, fill.obligation, 'Only real connection ends carry a code reference');
      return fill;
    }
    let codeRef = fill.codeRef;
    if (!codeRef && fill.source === 'accepted') {
      codeRef = take(workFillCode(frame.upper, frame.accepted!, obligation, fill as FrameFill));
    }
    if (!codeRef) reject('works_code_missing', fill.node, fill.obligation, 'A real work end needs an exact declared code reference, including on an inherited end');
    if (!graph.nodes.find(node => node.id === fill.node)?.code.some(ref => same(ref, codeRef)))
      reject('works_code_foreign', fill.node, fill.obligation, 'The fill code reference must equal a complete CodeRef declared by this work');
    return { ...fill, codeRef: copy(codeRef) };
  })) };
}
function workDeliveries(graph: Graph, connector: Graph['connectors'][number], binding: Binding, flow: string): Binding[] {
  const activeProducer = graph.horizon.includes(binding.producer.node);
  const awake = binding.consumers.filter(endpoint => !activeProducer || graph.horizon.includes(endpoint.node));
  const sleeping = binding.consumers.filter(endpoint => activeProducer && !graph.horizon.includes(endpoint.node));
  const result: Binding[] = awake.length ? [{ ...binding, consumers: awake, anchor: null }] : [];
  if (sleeping.length) {
    const producer = graph.nodes.find(node => node.id === binding.producer.node);
    if (!producer || producer.kind !== 'work' || producer.outcome !== connector.artifact)
      reject('sleeping_anchor_underivable', connector.id, binding.producer.node, 'The sleeping flow needs its producer work to produce this exact artifact');
    const tests = graph.tests.filter(test => test.node === producer.id && producer.tests.includes(test.id) && test.covers.includes(connector.id));
    if (tests.length !== 1) reject('sleeping_wake_test_missing', connector.id, producer.id,
      'Exactly one producer-owned covering test must determine the sleeping flow; no first-match selection');
    const test = tests[0]!;
    const id = workAnchorId(connector.id, flow, binding.producer);
    const anchor = { id, owner: producer.id, outcome: connector.artifact, test: test.id };
    const existing = graph.anchors.find(item => item.id === id);
    if (existing && !same(existing, anchor)) reject('sleeping_anchor_underivable', id, 'anchor', 'The mechanical anchor address has conflicting content');
    if (!existing) graph.anchors.push(anchor);
    // Keep an already accepted upper wake test; the lower anchor carries its work-owned test.
    connector.wakeTest ??= test.id;
    result.push({ ...binding, consumers: sleeping, anchor: id });
  }
  return result;
}
function checkWorkEndpoints(graph: Graph, result: ProposalResult): void {
  const identities = new Set(result.fills.filter(fill => fill.source === 'identity').map(fill => fill.node));
  for (const connector of graph.connectors) for (const binding of connector.bindings.filter(item => item.level === 3))
    for (const endpoint of [binding.producer, ...binding.consumers]) {
      if (identities.has(endpoint.node)) {
        if (Object.hasOwn(endpoint, 'codeRef')) reject('works_code_foreign', endpoint.node, connector.id, 'Identity has no implemented endpoint');
      } else {
        if (!endpoint.codeRef) reject('works_code_missing', endpoint.node, connector.id, 'Every real work connection end must name code');
        if (!graph.nodes.find(node => node.id === endpoint.node)?.code.some(ref => same(ref, endpoint.codeRef)))
          reject('works_code_foreign', endpoint.node, connector.id, 'Endpoint code belongs to its own work');
      }
    }
}
function checkedWorksBasis(store: Store, request: CandidateRequest, current: boolean) {
  requireWorks(request.works);
  const saved = take(readOmObligations(store, { project: request.frame.project, producer: request.works.producer }));
  if (!same(reference(saved.record), request.works.ledger))
    reject('works_obligations_invalid', request.works.ledger.id, 'ledger', 'The candidate names the complete ledger of this exact OM producer');
  const works = saved.producer.value.request.gaps.sources.works;
  if ('state' in works || !same(works, { frame: request.frame, proposals: sorted(request.proposals) }))
    reject('works_obligations_invalid', request.works.producer.id, 'context', 'The handoff and candidate must name exactly the same checked D1 works request');
  if (!current) return { ...saved, guards: [] as Ref[] };
  const prepared = take(prepareOmObligations(store, saved.producer.value.request as ObligationRequest));
  if (prepared.writes.length || !same(reference(prepared.producer), request.works.producer) || !same(reference(prepared.record), request.works.ledger))
    reject('works_obligations_invalid', request.works.producer.id, 'admission', 'The current handoff must already exist at the exact declared references');
  return prepared;
}
function checkWorkObligations(store: Store, request: CandidateRequest, candidate: FrameCandidate): void {
  const basis = checkedWorksBasis(store, request, false);
  const identities = new Set(candidate.fills.filter(fill => fill.source === 'identity').map(fill => fill.node));
  for (const binding of candidate.graph.researchObligations ?? []) if (binding.consumers.some(consumer => identities.has(consumer.node)))
    reject('works_obligations_invalid', binding.id, 'consumers', 'An identity representative cannot act as a concrete task consumer');
  const checked = bindTaskObligations(store, request.frame.project, candidate.graph, basis.handoff as OmObligationHandoff);
  if (checked.findings.length) reject('works_obligations_invalid', checked.findings[0]!.target, 'bindings',
    'The assembled work bindings failed the common task obligation contract', checked.findings);
  for (const obligation of taskObligations(basis.handoff as OmObligationHandoff)) if (!candidate.graph.researchObligations?.some(binding => binding.id === taskBindingId(obligation)))
    reject('works_obligations_invalid', obligation.obligation, 'bindings', 'Every carried task assignment must retain its own binding');
}
function directIdentityInputs(graph: Graph, consumer: string): string[] {
  return graph.connectors.filter(connector => connector.bindings.some(binding => binding.level === 3
    && binding.anchor === null && binding.producer.node !== consumer
    && binding.consumers.some(endpoint => endpoint.node === consumer))).map(connector => connector.id).sort(order);
}
function structuralIdentityJoins(frame: FrameRead, result: ProposalResult, graph: Graph): ReadonlyMap<string, Graph['joins'][number] | null> {
  const obligations = new Map(result.obligations.map(item => [item.id, item]));
  const origins = (fills: readonly ProposalResult['fills'][number][]) => {
    const mapped = new Map<string, string>();
    for (const fill of fills.filter(item => item.source === 'identity')) {
      const upper = obligations.get(fill.obligation)?.upper.node;
      if (!upper || mapped.has(fill.node) && mapped.get(fill.node) !== upper)
        reject('frame_record_invalid', fill.node, 'identity', 'The proven identity must name exactly one retained upper node');
      mapped.set(fill.node, upper);
    }
    return mapped;
  };
  const current = origins(result.fills), previous = origins(frame.accepted?.frame?.value.fills ?? []);
  const sourceOf = (node: string, upper: string) => {
    const sources = frame.upper.joins.filter(join => join.consumer === upper);
    if (sources.length > 1) reject('graph_invalid', node, 'joins', 'The upper consumer has ambiguous joins',
      [{ code: 'join_duplicate', target: upper, message: 'A consumer has more than one upper join' }]);
    return sources[0];
  };
  const mechanical = new Set<string>();
  for (const [node, upper] of previous) {
    const source = sourceOf(node, upper);
    if (!source) continue;
    const id = representativeJoinId(source.id, upper, 3), saved = frame.accepted!.graph.joins.find(join => join.id === id);
    if (!saved) continue;
    const connectors = directIdentityInputs(frame.accepted!.graph, node);
    const structural = { id, consumer: node, connectors, ...(source.failures ? { failures: source.failures } : {}) };
    const used = new Set(frame.accepted!.frame!.value.fills.filter(fill => fill.source === 'identity' && fill.node === node)
      .map(fill => obligations.get(fill.obligation)?.connector));
    const legacy = { ...source, id, consumer: node, connectors,
      ...(source.required ? { required: source.required.filter(connector => used.has(connector)) } : {}),
      ...(source.optional ? { optional: source.optional.filter(connector => used.has(connector)) } : {}) };
    if (!same(saved, structural) && !same(saved, legacy))
      reject('derived_field_conflict', id, 'joins', 'The accepted definition at the mechanical address has different authored content');
    mechanical.add(id);
  }
  for (const [node, upper] of current) {
    const representative = result.representatives.find(item => item.id === node);
    if (!representative || graph.horizon.includes(node) || !frame.upper.nodes.some(item => item.id === upper && item.kind === 'operation')
      || result.fills.some(fill => fill.node === node && (fill.source !== 'identity' || !same(fill.basis, frame.upperRef)
        || obligations.get(fill.obligation)?.zone !== 'outside')))
      reject('frame_record_invalid', node, 'identity', 'The exception requires the complete current C2/C3 representative outside the final horizon');
  }
  for (const proposal of result.proposals) for (const join of proposal.value.joins) {
    if (current.has(join.consumer) || mechanical.has(join.id))
      reject('derived_field_conflict', join.id, 'joins', 'A proposal cannot author or redefine a proven mechanical identity join');
  }
  graph.joins = graph.joins.filter(join => !mechanical.has(join.id));
  const context = new Map<string, Graph['joins'][number] | null>();
  for (const [node, upper] of current) {
    const source = sourceOf(node, upper), connectors = directIdentityInputs(graph, node);
    if (graph.joins.some(join => join.consumer === node)) reject('graph_invalid', node, 'joins',
      'An authored definition conflicts with the proven identity join',
      [{ code: 'join_duplicate', target: node, message: 'A representative has another authored join' }]);
    if (connectors.length >= 3 && !source || connectors.length && source && !source.failures)
      reject('layer_join_design_required', node, 'joins', 'Direct identity inputs require a proven upper join and its original failures');
    const join = source && connectors.length ? { id: representativeJoinId(source.id, upper, 3), consumer: node,
      connectors, failures: copy(source.failures!) } : null;
    if (join) {
      if (graph.joins.some(item => item.id === join.id))
        reject('derived_field_conflict', join.id, 'joins', 'A mechanical join address is already used by another definition');
      graph.joins.push(join);
    }
    context.set(node, join);
  }
  return context;
}
function assemble(frame: FrameRead, result: ProposalResult, works?: WorksCandidateInput, joinAssembly?: typeof JOIN_ASSEMBLY): CandidateAssembly {
  const level = frame.request.level;
  const gaps = take(openObligationsToGaps(frame, result)) as FrameGap[];
  if (gaps.length) return { state: 'gaps', gaps };
  // Keep the complete accepted content, including local definitions and authored descendants.
  const graph = structuredClone(frame.accepted?.graph ?? frame.upper);
  const removed = new Set(result.proposals.flatMap(proposal => proposal.value.removes));
  const oldIdentities = new Set(frame.accepted?.frame?.value.fills.filter(fill => fill.source === 'identity').map(fill => fill.node) ?? []);
  const neededIdentities = new Set(result.fills.filter(fill => fill.source === 'identity').map(fill => fill.node));
  for (const id of oldIdentities) if (!neededIdentities.has(id)) removed.add(id);
  graph.nodes = graph.nodes.filter(node => !removed.has(node.id));
  const introduced = new Map<string, unknown>();
  function merge<T extends { id: string }>(part: string, values: T[], incoming: T, redefine: boolean): void {
    const key = `${part}:${incoming.id}`, previous = introduced.get(key);
    if (previous !== undefined && !same(previous, incoming))
      reject('derived_field_conflict', incoming.id, part, 'Proposals disagree about the same introduced or redefined object');
    const at = values.findIndex(item => item.id === incoming.id);
    if (at < 0) { values.push(structuredClone(incoming)); introduced.set(key, incoming); }
    else if (redefine) { values[at] = structuredClone(incoming); introduced.set(key, incoming); }
    // Unlisted accepted definitions survive unchanged, even when a proposal carries a different copy.
  }
  for (const observation of result.proposals) {
    const proposal = observation.value;
    for (const node of sorted(proposal.nodes)) merge('nodes', graph.nodes, node, removed.has(node.id));
    for (const part of parts) {
      const values = (graph[part] ?? []) as { id: string }[];
      for (const item of sorted(proposal[part] as { id: string }[])) merge(part, values, item, proposal.redefines.includes(item.id));
      Object.assign(graph, { [part]: values });
    }
    for (const connector of sorted(proposal.localConnectors)) {
      const accepted = graph.connectors.find(item => item.id === connector.id);
      const incoming = mergeConnector(accepted, connector, level);
      merge('connectors', graph.connectors, incoming, proposal.redefines.includes(connector.id));
    }
  }
  for (const node of result.representatives) {
    const index = graph.nodes.findIndex(item => item.id === node.id);
    if (index < 0) graph.nodes.push(structuredClone(node)); else graph.nodes[index] = structuredClone(node);
  }
  for (const join of joinAssembly ? [] : result.joins) {
    const index = graph.joins.findIndex(item => item.id === join.id);
    if (index < 0) graph.joins.push(structuredClone(join));
  }
  if (level === 3) {
    const identities = new Set(result.fills.filter(fill => fill.source === 'identity').map(fill => fill.node));
    const relations = new RefinementRelations(graph);
    graph.horizon = graph.nodes.filter(node => node.kind === 'work' && !identities.has(node.id)
      && frame.scope.nodes.some(id => relations.refines(node.id, id))).map(node => node.id).sort(order);
    graph.researchObligations = copy(works!.bindings);
    result = workCodeFills(frame, result, graph);
  }
  const obligations = new Map(result.obligations.map(obligation => [obligation.id, obligation]));
  for (const connector of graph.connectors) {
    const upper = connector.bindings.filter(binding => binding.level === level - 1);
    if (!upper.length) continue;
    const endpoints = (binding: Binding, role: 'producer' | 'consumer', endpoint: Endpoint): Endpoint[] => unique(result.fills.filter(fill => {
      const obligation = obligations.get(fill.obligation)!;
      return obligation.connector === connector.id && obligation.flow === flowKey(binding) && obligation.role === role
        && obligation.upper.node === endpoint.node && obligation.upper.port === endpoint.port;
    }).map(fill => ({ node: fill.node, port: fill.port!, ...(level === 3 && fill.codeRef ? { codeRef: fill.codeRef } : {}) })));
    const lower = upper.map(binding => {
      const producers = endpoints(binding, 'producer', binding.producer);
      if (producers.length !== 1) reject('slot_fill_conflict', connector.id, 'producer', 'Each upper flow has exactly one lower producer');
      return { level, producer: producers[0]!,
        consumers: unique(binding.consumers.flatMap(endpoint => endpoints(binding, 'consumer', endpoint))), anchor: binding.anchor };
    });
    if (new Set(lower.map(flowKey)).size !== lower.length)
      reject('slot_fill_conflict', connector.id, 'flow', 'Distinct upper flows cannot share one lower producer/port/anchor flow');
    const deliveries = level === 3 ? lower.flatMap((binding, index) => workDeliveries(graph, connector, binding, flowKey(upper[index]!))) : lower;
    const previous = connector.bindings.filter(binding => binding.level === level);
    if (!same(bindingSet(previous), bindingSet(deliveries)))
      connector.bindings = [...connector.bindings.filter(binding => binding.level !== level), ...deliveries];
  }
  if (level === 2) requireUnchangedWorks(frame.accepted?.graph ?? frame.upper, graph);
  else {
    // Local work connections have no upper flow, but obey the same code/sleeping contract.
    for (const connector of graph.connectors.filter(item => !item.bindings.some(binding => binding.level === 2)))
      connector.bindings = connector.bindings.flatMap(binding => binding.level === 3
        ? workDeliveries(graph, connector, binding, flowKey(binding)) : [binding]);
    checkWorkEndpoints(graph, result);
    if (!same(projectGraph(graph, 2), projectGraph(frame.upper, 2)))
      reject('works_upper_drift', graph.id, 'upper', 'A works candidate cannot change the accepted operation projection');
    // Use the native typed assembly for the work-owned test and join relations.
    const identities = joinAssembly ? structuralIdentityJoins(frame, result, graph) : undefined;
    try {
      const native = assembleL3(frame.upper, layerDesignOf(graph, 3, L3_ASSEMBLY) as Record<string, unknown>, identities);
      Object.assign(graph, native);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      reject(error.code, graph.id, 'layer', error.message, error.code === 'graph_invalid' ? error.details as Finding[] : undefined);
    }
  }
  const actuallyRemoved = new Set([...removed].filter(id => !graph.nodes.some(node => node.id === id)));
  const dangling = danglingReferences(graph, actuallyRemoved);
  if (dangling.length) reject('replacement_leaves_dangling', dangling[0]!.target, 'references',
    'Definitions still reference removed nodes', dangling);
  for (const node of graph.nodes.filter(node => node.kind === (level === 2 ? 'operation' : 'work') && (level === 2 || graph.horizon.includes(node.id)))) for (const port of node.ports.filter(port => port.direction === 'in')) {
    if (!graph.connectors.some(connector => connector.bindings.some(binding => binding.level === level
      && binding.consumers.some(endpoint => endpoint.node === node.id && endpoint.port === port.id))))
      reject('operation_port_unbound', node.id, port.id, 'Every operation input needs a connector binding');
  }
  checkedGraph(graph, frame.upper, level);
  // Reuse C2's structural correspondence check on the FINAL graph, after redefines have been applied.
  // These local references identify computed values only: they are neither persisted nor evidence of acceptance.
  const mapping: ConnectionFrame = { project: frame.request.project, level, ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}), candidateHash: hashJson(graph),
    layerHash: hashJson(projectGraph(graph, level)),
    fills: level === 3 ? sorted(result.fills.map(fill => ({ ...fill, source: fill.source === 'proposed' ? 'accepted' as const : fill.source })))
      : result.fills.map(fill => ({ ...fill, source: fill.source === 'proposed' ? 'accepted' : fill.source })) };
  take(fillObligations(frame.upper, frame.scope, {
    graph, reference: { ...frame.request.graph, hash: hashJson(graph) },
    frame: { reference: { id: `om-frame:${frame.request.project}:${level}`, revision: 1, hash: hashJson(mapping) }, value: mapping },
  }, frame.upperRef, level));
  return { state: 'candidate', candidate: { project: frame.request.project, level, ...(joinAssembly ? { joinAssembly } : {}), ...(level === 3 ? { works: normalizedWorks(works!) } : {}), graphHash: hashJson(graph),
    layerHash: hashJson(projectGraph(graph, level)), upperHash: hashJson(projectGraph(graph, (level - 1) as 1 | 2)), graph,
    fills: result.fills, base: { graph: frame.request.graph, frame: frame.request.frame },
    proposals: sorted(result.proposals.map(proposal => proposal.reference)) } };
}
/** Pure F4.5: open obligations remain M5 gaps; this function never invents a completion or writes a frame. */
export function assembleCandidate(frame: FrameRead, proposals: ProposalObservation[], works?: WorksCandidateInput): CandidateResult<CandidateAssembly> {
  return deriveCandidate(frame, proposals, works, frame?.request?.level === 3 ? JOIN_ASSEMBLY : undefined);
}
function deriveCandidate(frame: FrameRead, proposals: ProposalObservation[], works: WorksCandidateInput | undefined,
  joinAssembly: typeof JOIN_ASSEMBLY | undefined): CandidateResult<CandidateAssembly> {
  return outcome(() => {
    requireLevel(frame, works);
    if (!Array.isArray(proposals)) invalid('proposals');
    const result = take(applyProposals(frame, proposals)) as ProposalResult;
    if (frame.request.level === 3 && proposals.some(item => item.value.worksContract !== WORKS_FRAME_CONTRACT))
      reject('works_contract_invalid', 'candidate:3', 'proposals', 'New works assembly needs proposals of its declared era');
    return assemble(copy(frame), result, works && normalizedWorks(works), joinAssembly);
  });
}
export function readCandidate(store: Store, request: CandidateReadRequest): CandidateResult<Revision<FrameCandidateRecord>> {
  requireStore(store); requireRead(request); request = copy(request);
  return outcome(() => {
    const loaded = readRecord<FrameCandidateRecord>(store, request.candidate, { unit: 'G3', target: request.candidate.id,
      idPrefix: `om-candidate:${request.project}:`, kind: 'frame-candidate' });
    if (!loaded.ok) {
      if (loaded.refusal.code === 'record_missing') reject('candidate_missing', request.candidate.id, 'candidate', loaded.refusal.message);
      throw new CandidateFailure(loaded.refusal);
    }
    // NR (№3600): a trusted read — prepareCandidate derived the saved candidate from its exact sources once.
    return loaded.value as Revision<FrameCandidateRecord>;
  });
}
/** Observe the saved refusal object and its sources without declaring its assembly or G3 successful. */
export function observeCandidate(store: Store, request: CandidateReadRequest): CandidateResult<ObservedCandidate> {
  requireStore(store); requireRead(request); request = copy(request);
  return outcome(() => {
    const record = take(readRecord<FrameCandidateRecord>(store, request.candidate, { unit: 'G3', target: request.candidate.id,
      idPrefix: `om-candidate:${request.project}:`, kind: 'frame-candidate' })) as Revision<FrameCandidateRecord>;
    const value = record.value;
    if (!object(value) || value.project !== request.project || ![2, 3].includes(value.level) || record.revision !== 1
      || !object(value.graph) || !object(value.base) || !isRef(value.base.graph)
      || value.base.frame !== null && !isRef(value.base.frame) || !Array.isArray(value.proposals) || !value.proposals.every(isRef)
      || !Array.isArray(value.fills) || ![value.graphHash, value.layerHash, value.upperHash].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)))
      reject('candidate_graph_mismatch', record.id, 'record', 'A candidate observation needs its readable immutable envelope and exact source addresses');
    checkedEra(value, record.id);
    try { requireRequest(value.request); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'candidate_request_invalid')
        reject('candidate_graph_mismatch', record.id, 'request', 'The observed candidate must retain its complete source request');
      throw error;
    }
    if (value.request.frame.project !== request.project || value.request.frame.level !== value.level
      || !same(value.base, { graph: value.request.frame.graph, frame: value.request.frame.frame })
      || !same(sorted(value.proposals), sorted(value.request.proposals))
      || value.level === 3 && !same(value.works ?? null, value.request.works ?? null))
      reject('candidate_graph_mismatch', record.id, 'request', 'The candidate must name precisely the same base, level and proposal set as its source request');
    if (value.graphHash !== hashJson(value.graph) || record.id !== idOf(value))
      reject('candidate_graph_mismatch', record.id, 'graphHash', 'The observed candidate must retain its own graph hash and content address');
    requireLevel({ request: value.request.frame }, value.request.works);
    const basis = value.level === 3 ? checkedWorksBasis(store, value.request, false) : null;
    const frame = take(readFrame(store, value.request.frame));
    if (value.graph.id !== frame.upper.id)
      reject('candidate_graph_mismatch', record.id, 'graph.id', 'The observed graph belongs to another product');
    const references: Ref[] = [reference(record), ...frame.references, ...(basis?.inputs ?? [])];
    // C3 observes the whole named set in one historical base read, including every participant's linkage.
    if (value.request.proposals.length) references.push(...take(observeProposal(store, {
      project: request.project, proposal: value.request.proposals[0]!, request: value.request,
    })).references);
    return { record, definitions: [...take(definitionIds(value.graph, 'graph', record.id))], references: unique(references),
      sources: normalizeRequest(value.request) };
  });
}
/** Current preparation inherits C3's complete admission guards, including when an immutable candidate already exists. */
export function prepareCandidate(store: Store, request: CandidateRequest): CandidateResult<PreparedCandidate> {
  requireStore(store); requireRequest(request);
  return outcome(() => {
    request = normalizeRequest(request);
    requireLevel({ request: request.frame }, request.works);
    const sources = take(prepareFrameProposals(store, request));
    if (request.frame.level === 3) request = normalizeRequest({ ...request, frame: sources.frame.request as CandidateRequest['frame'] });
    const basis = request.frame.level === 3 ? checkedWorksBasis(store, request, true) : null;
    const common = { guards: unique([...sources.guards, ...(basis?.guards ?? [])]) as Ref[], expected: sources.expected as PreparedFrame['expected'] };
    const existingResult = (existing: Revision<FrameCandidateRecord>, candidate: FrameCandidate): PreparedCandidate => {
      const { request: _request, ...content } = existing.value;
      if (!same(content, candidate)) reject('candidate_graph_mismatch', existing.id, 'candidate', 'An existing candidate with this identity has a different derived result');
      if (candidate.level === 3) checkWorkObligations(store, request, candidate);
      return { ...common, guards: unique([...common.guards, reference(existing)]), state: 'candidate', candidate: existing.value, writes: [], existing };
    };
    // C5 repeats an unmarked saved request. Probe only its exact old address, after current admission.
    if (request.frame.level === 3 && !Object.hasOwn(request, 'joinAssembly')) {
      const legacy = deriveCandidate(sources.frame as FrameRead, sources.proposals as ProposalObservation[], request.works, undefined);
      if (legacy.ok && legacy.value.state === 'candidate') {
        const candidate = legacy.value.candidate as FrameCandidate, existing = store.get<FrameCandidateRecord>(idOf(candidate));
        if (existing) return existingResult(existing, candidate);
      }
    }
    if (request.frame.level === 3) request = normalizeRequest({ ...request, joinAssembly: JOIN_ASSEMBLY });
    const built = take(deriveCandidate(sources.frame as FrameRead, sources.proposals as ProposalObservation[], request.works, request.joinAssembly));
    if (built.state === 'gaps') return { ...common, state: 'gaps', gaps: built.gaps as FrameGap[], writes: [], existing: null };
    const candidate: FrameCandidateRecord = { ...built.candidate as FrameCandidate, request }, id = idOf(candidate);
    const existing = store.get<FrameCandidateRecord>(id);
    if (existing) {
      // Identity is graph/base/proposals. A different current horizon may reuse the same immutable candidate,
      // but its admission guards come from THIS preparation; its historical source request stays unchanged.
      return existingResult(existing, built.candidate as FrameCandidate);
    }
    if (candidate.level === 3) checkWorkObligations(store, request, candidate);
    return { ...common, state: 'candidate', candidate, writes: [{ id, kind: 'frame-candidate', expected: 0, value: candidate }], existing: null };
  });
}
export function writeCandidate(store: Store, request: CandidateRequest): CandidateResult<CandidateWriteResult> {
  return outcome(() => {
    const prepared = take(prepareCandidate(store, request));
    if (prepared.state === 'gaps') return { state: 'gaps', gaps: prepared.gaps as FrameGap[] };
    const record = prepared.existing ?? take(writeGuarded<FrameCandidateRecord>(store,
      { unit: 'F4.5', target: idOf(prepared.candidate as unknown as FrameCandidate), writes: prepared.writes, guards: prepared.guards }))[0]!;
    return { state: 'candidate', record: record as Revision<FrameCandidateRecord> };
  });
}
/** G3 consumes only the graph rederived from the exact saved candidate. Acceptance writes belong to C5. */
export function gateCandidate(store: Store, request: CandidateGateRequest): CandidateResult<CandidateGate> {
  requireStore(store); requireRead(request);
  return outcome(() => {
    if (Object.hasOwn(request, 'graph')) reject('candidate_graph_mismatch', request.candidate.id, 'graph', 'G3 accepts the graph in the candidate record only');
    const row = take(readCandidate(store, request));
    if (row.value.level !== 2) reject('candidate_level_unsupported', row.id, 'gate', 'A works candidate requires G5; G3 cannot authorize its acceptance');
    return { passed: true, candidate: reference(row), graphHash: row.value.graphHash, findings: [] };
  });
}

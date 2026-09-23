import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { composeLayer, layerDesignOf } from '../graph/layer-design.js';
import type { Binding, Endpoint, Graph } from '../graph/model.js';
import { projectGraph } from '../graph/project.js';
import { requireGraph, validateGraph } from '../graph/validate.js';
import { isRef, reference, type Finding, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { fillObligations, flowKey, type ConnectionFrame, type FrameRead, type PreparedFrame } from './frame-obligations.js';
import { applyProposals, openObligationsToGaps, prepareFrameProposals, readFrameProposals,
  type FrameGap, type ProposalObservation, type ProposalRequest, type ProposalResult } from './frame-proposals.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';

export const CANDIDATE_REFUSAL_CODES = Object.freeze([
  'candidate_level_unsupported', 'candidate_missing', 'candidate_graph_mismatch',
  'derived_field_conflict', 'slot_fill_conflict', 'replacement_leaves_dangling', 'operation_port_unbound', 'graph_invalid',
] as const);
export type CandidateResult<T> = { readonly ok: true; readonly value: Sealed<T> }
  | { readonly ok: false; readonly refusal: Sealed<Refusal & { findings?: Finding[] }> };
export interface FrameCandidate {
  project: string; level: 2; graphHash: string; layerHash: string; upperHash: string; graph: Graph;
  fills: ProposalResult['fills']; base: { graph: Ref; frame: Ref | null }; proposals: Ref[];
}
export type CandidateAssembly = { state: 'gaps'; gaps: FrameGap[] } | { state: 'candidate'; candidate: FrameCandidate };
export type CandidateRequest = ProposalRequest;
export interface FrameCandidateRecord extends FrameCandidate { request: CandidateRequest }
export type PreparedCandidate = { guards: Ref[]; expected: PreparedFrame['expected']; writes: Write[] } & (
  { state: 'gaps'; gaps: FrameGap[]; existing: null }
  | { state: 'candidate'; candidate: FrameCandidateRecord; existing: Revision<FrameCandidateRecord> | null });
export type CandidateWriteResult = { state: 'gaps'; gaps: FrameGap[] }
  | { state: 'candidate'; record: Revision<FrameCandidateRecord> };
export interface CandidateReadRequest { project: string; candidate: Ref }
export interface CandidateGateRequest extends CandidateReadRequest { graph?: unknown }
export interface CandidateGate { passed: true; candidate: Ref; graphHash: string; findings: Finding[] }

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
  try { return delivered(action()); }
  catch (error) {
    if (error instanceof CandidateFailure) return { ok: false, refusal: sealed(error.refusal) };
    throw error;
  }
}
function requireLevel(frame: unknown): void {
  if (!object(frame) || !object(frame['request'])) invalid('frame');
  if (frame['request']['level'] !== 2 && frame['request']['level'] !== 3) invalid('frame.level');
  if (frame['request']['level'] === 3) reject('candidate_level_unsupported', 'candidate:3', 'level', 'L3 needs the F2 code-reference and obligation-handoff contract');
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
}
function normalizeRequest(request: CandidateRequest): CandidateRequest {
  return copy({ frame: request.frame, proposals: sorted(request.proposals) });
}
function requireRead(value: unknown): asserts value is CandidateReadRequest {
  if (!object(value) || !text(value['project'])) invalid('project');
  if (!isRef(value['candidate'])) invalid('candidate');
}
function idOf(value: FrameCandidate): string {
  return `om-candidate:${value.project}:${hashJson([value.graphHash, value.base, value.proposals])}`;
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
function mergeConnector(accepted: Graph['connectors'][number] | undefined, proposed: Graph['connectors'][number]): Graph['connectors'][number] {
  if (!accepted) return proposed;
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
function checkedGraph(graph: Graph, upper: Graph): void {
  const validation = validateGraph(graph);
  if (validation.findings.length) reject('graph_invalid', validation.findings[0]!.target || graph.id, 'graph',
    'The candidate failed the native graph validator', validation.findings);
  // requireGraph remains the native graph contract; composeLayer validates the derived L2 without pruning the saved graph.
  try { requireGraph(graph); composeLayer(upper, 2, layerDesignOf(graph, 2)); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    if (error.code === 'graph_invalid') reject(error.code, graph.id, 'graph', error.message, error.details as Finding[]);
    if (['layer_outcome_uncovered', 'layer_connector_uncovered', 'upper_layer_drift', 'derived_field_conflict',
      'layer_detail_invalid', 'graph_upgrade_required', 'layer_design_missing'].includes(error.code))
      reject(error.code, graph.id, 'layer', error.message);
    throw error;
  }
}
function assemble(frame: FrameRead, result: ProposalResult): CandidateAssembly {
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
      const incoming = mergeConnector(accepted, connector);
      merge('connectors', graph.connectors, incoming, proposal.redefines.includes(connector.id));
    }
  }
  for (const node of result.representatives) {
    const index = graph.nodes.findIndex(item => item.id === node.id);
    if (index < 0) graph.nodes.push(structuredClone(node)); else graph.nodes[index] = structuredClone(node);
  }
  for (const join of result.joins) {
    const index = graph.joins.findIndex(item => item.id === join.id);
    if (index < 0) graph.joins.push(structuredClone(join));
  }
  const obligations = new Map(result.obligations.map(obligation => [obligation.id, obligation]));
  for (const connector of graph.connectors) {
    const upper = connector.bindings.filter(binding => binding.level === 1);
    if (!upper.length) continue;
    const endpoints = (binding: Binding, role: 'producer' | 'consumer', endpoint: Endpoint): Endpoint[] => unique(result.fills.filter(fill => {
      const obligation = obligations.get(fill.obligation)!;
      return obligation.connector === connector.id && obligation.flow === flowKey(binding) && obligation.role === role
        && obligation.upper.node === endpoint.node && obligation.upper.port === endpoint.port;
    }).map(fill => ({ node: fill.node, port: fill.port! })));
    const lower = upper.map(binding => {
      const producers = endpoints(binding, 'producer', binding.producer);
      if (producers.length !== 1) reject('slot_fill_conflict', connector.id, 'producer', 'Each upper flow has exactly one lower producer');
      return { level: 2 as const, producer: producers[0]!,
        consumers: unique(binding.consumers.flatMap(endpoint => endpoints(binding, 'consumer', endpoint))), anchor: binding.anchor };
    });
    if (new Set(lower.map(flowKey)).size !== lower.length)
      reject('slot_fill_conflict', connector.id, 'flow', 'Distinct upper flows cannot share one lower producer/port/anchor flow');
    const previous = connector.bindings.filter(binding => binding.level === 2);
    if (!same(bindingSet(previous), bindingSet(lower)))
      connector.bindings = [...connector.bindings.filter(binding => binding.level !== 2), ...lower];
  }
  requireUnchangedWorks(frame.accepted?.graph ?? frame.upper, graph);
  const actuallyRemoved = new Set([...removed].filter(id => !graph.nodes.some(node => node.id === id)));
  const dangling = danglingReferences(graph, actuallyRemoved);
  if (dangling.length) reject('replacement_leaves_dangling', dangling[0]!.target, 'references',
    'Definitions still reference removed nodes', dangling);
  for (const node of graph.nodes.filter(node => node.kind === 'operation')) for (const port of node.ports.filter(port => port.direction === 'in')) {
    if (!graph.connectors.some(connector => connector.bindings.some(binding => binding.level === 2
      && binding.consumers.some(endpoint => endpoint.node === node.id && endpoint.port === port.id))))
      reject('operation_port_unbound', node.id, port.id, 'Every operation input needs a connector binding');
  }
  checkedGraph(graph, frame.upper);
  // Reuse C2's structural correspondence check on the FINAL graph, after redefines have been applied.
  // These local references identify computed values only: they are neither persisted nor evidence of acceptance.
  const mapping: ConnectionFrame = { project: frame.request.project, level: 2, candidateHash: hashJson(graph),
    layerHash: hashJson(projectGraph(graph, 2)),
    fills: result.fills.map(fill => ({ ...fill, source: fill.source === 'proposed' ? 'accepted' : fill.source })) };
  take(fillObligations(frame.upper, frame.scope, {
    graph, reference: { ...frame.request.graph, hash: hashJson(graph) },
    frame: { reference: { id: `om-frame:${frame.request.project}:2`, revision: 1, hash: hashJson(mapping) }, value: mapping },
  }, frame.upperRef, 2));
  return { state: 'candidate', candidate: { project: frame.request.project, level: 2, graphHash: hashJson(graph),
    layerHash: hashJson(projectGraph(graph, 2)), upperHash: hashJson(projectGraph(graph, 1)), graph,
    fills: result.fills, base: { graph: frame.request.graph, frame: frame.request.frame },
    proposals: sorted(result.proposals.map(proposal => proposal.reference)) } };
}
/** Pure F4.5: open obligations remain M5 gaps; this function never invents a completion or writes a frame. */
export function assembleCandidate(frame: FrameRead, proposals: ProposalObservation[]): CandidateResult<CandidateAssembly> {
  return outcome(() => {
    requireLevel(frame);
    if (!Array.isArray(proposals)) invalid('proposals');
    const result = take(applyProposals(frame, proposals)) as ProposalResult;
    return assemble(copy(frame), result);
  });
}
function verifyRecord(store: Store, row: Revision<FrameCandidateRecord>, project: string): void {
  const value = row.value;
  if (row.kind !== 'frame-candidate' || row.revision !== 1 || !object(value) || value.project !== project
    || !object(value.request) || !object(value.graph) || !object(value.base) || !Array.isArray(value.proposals)
    || row.hash !== hashJson(value)) reject('candidate_graph_mismatch', row.id, 'record', 'An immutable candidate names its own exact content and source request');
  try { requireRequest(value.request); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'candidate_request_invalid')
      reject('candidate_graph_mismatch', row.id, 'request', 'The saved candidate source request is incomplete');
    throw error;
  }
  if (value.request.frame.project !== project || value.request.frame.level !== 2 || !same(value.request, normalizeRequest(value.request)))
    reject('candidate_graph_mismatch', row.id, 'request', 'A candidate must have canonical sources for its own project and supported level');
  const sources = take(readFrameProposals(store, value.request));
  const expected = take(assembleCandidate(sources.frame as FrameRead, sources.proposals as ProposalObservation[]));
  if (expected.state !== 'candidate' || !same(value, { ...expected.candidate, request: value.request }) || row.id !== idOf(expected.candidate as FrameCandidate))
    reject('candidate_graph_mismatch', row.id, 'graph', 'The complete candidate must be rederived from its saved sources');
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
    const row = loaded.value as Revision<FrameCandidateRecord>;
    verifyRecord(store, row, request.project);
    return row;
  });
}
/** Current preparation inherits C3's complete admission guards, including when an immutable candidate already exists. */
export function prepareCandidate(store: Store, request: CandidateRequest): CandidateResult<PreparedCandidate> {
  requireStore(store); requireRequest(request); request = normalizeRequest(request);
  return outcome(() => {
    requireLevel({ request: request.frame });
    const sources = take(prepareFrameProposals(store, request));
    const built = take(assembleCandidate(sources.frame as FrameRead, sources.proposals as ProposalObservation[]));
    const common = { guards: [...sources.guards] as Ref[], expected: sources.expected as PreparedFrame['expected'] };
    if (built.state === 'gaps') return { ...common, state: 'gaps', gaps: built.gaps as FrameGap[], writes: [], existing: null };
    const candidate: FrameCandidateRecord = { ...built.candidate as FrameCandidate, request }, id = idOf(candidate);
    const existing = store.get<FrameCandidateRecord>(id);
    if (existing) {
      verifyRecord(store, existing, request.frame.project);
      // Identity is graph/base/proposals. A different current horizon may reuse the same immutable candidate,
      // but its admission guards come from THIS preparation; its historical source request stays unchanged.
      const { request: _request, ...content } = existing.value;
      if (!same(content, built.candidate)) reject('candidate_graph_mismatch', id, 'candidate', 'An existing candidate with this identity has a different derived result');
      common.guards = unique([...common.guards, reference(existing)]);
      return { ...common, state: 'candidate', candidate: existing.value, writes: [], existing };
    }
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
    return { passed: true, candidate: reference(row), graphHash: row.value.graphHash, findings: [] };
  });
}

import { Ajv } from "ajv";
import { canonical, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import { LEVEL, type CodeRef, type Graph, type Node } from "../graph/model.js";
import { RefinementRelations } from "../graph/relations.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { readRecord } from "./refs.js";
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from "./refusal.js";
import {
  fillObligations, prepareFrame, readFrame, representativeId, WORKS_FRAME_CONTRACT,
  type FilledFrame, type FrameFill, type FrameLevel, type FrameObligation,
  type FrameRead, type FrameRequest, type PreparedFrame,
} from "./frame-obligations.js";

export const PROPOSAL_REFUSAL_CODES = Object.freeze([
  "proposal_request_invalid", "proposal_invalid", "proposal_not_proposed", "proposal_base_stale",
  "slot_fill_foreign", "slot_fill_conflict", "proposal_node_reserved", "input_stale",
] as const);
export interface ProposalFill { obligation: string; node: string; port?: string; codeRef?: CodeRef; wakeTest?: string }
/**
 * G5 (№3820, №3822): the wake test of a producer end — the one test of its own work that covers the connection and wakes the
 * consumers when they sleep. The answer form names it and E2 checks it by this one rule; the engine never picks one.
 */
/** G6 (В4, №3869): one artifact per real work — the G5 gate's invariant, stated in the brief and checked at the primary
 * acceptance of a new work, where its outcome and outgoing connections are known. */
export const ONE_ARTIFACT = Object.freeze({ code: 'work_artifact_not_single' as const,
  rule: 'A real work produces one artifact, including every outgoing connection: its outcome and the artifact of every '
    + 'connection it is the producer end of are the same. A second artifact needs a work of its own.' });
export const WAKE_TEST = Object.freeze({ field: 'wakeTest' as const,
  rule: 'When more than one test of its own work covers a connection, the producer end of that connection names in '
    + 'wakeTest exactly one of them: the test that wakes the consumers of the connection when they sleep. Name it even when '
    + 'no consumer sleeps now. A named test must be a test of this same work whose covers include this connection. The engine '
    + 'never chooses one of several for you.' });
export interface ProposalReplacement {
  obligation: string; base: { node: string; graph: Ref };
  with: { node: string; port: string | null }; basis: string;
}
export interface LayerProposal {
  base: { graph: Ref; frame: Ref | null }; level: FrameLevel; source: "input" | "decision";
  status: "proposed" | "accepted" | "rejected";
  worksContract?: typeof WORKS_FRAME_CONTRACT;
  verdict?: { candidateHash: string; candidate: Ref; codes: string[] };
  nodes: Node[]; fills: ProposalFill[]; localConnectors: Graph['connectors'];
  artifacts: Graph['artifacts']; contracts: Graph['contracts']; joins: Graph['joins']; tests: Graph['tests'];
  edges: NonNullable<Graph['edges']>; journeys: NonNullable<Graph['journeys']>; packets: NonNullable<Graph['packets']>;
  transfers: NonNullable<Graph['transfers']>; anchors: Graph['anchors'];
  removes: string[]; replaces: ProposalReplacement[]; redefines: string[];
}
export interface ProposalObservation { reference: Ref; value: LayerProposal }
export interface ProposalResult extends Omit<FilledFrame, 'fills'> {
  fills: (Omit<FrameFill, 'source'> & { source: "accepted" | "identity" | "proposed"; wakeTest?: string })[];
  proposals: ProposalObservation[];
}
export interface FrameGap {
  target: string; field: "fill"; kind: "design-decision"; consumer: string;
  neighbors: FrameObligation[]; blocking: true;
  question: { level: FrameLevel; upper: string; artifact: string; role: 'producer' | 'consumer';
    port: string | null; portContract: string | null; existing: string[]; allowNew: true };
}
export interface ProposalRequest { frame: FrameRequest; proposals: Ref[] }
export interface FrameProposals {
  frame: FrameRead; proposals: ProposalObservation[]; result: ProposalResult; gaps: FrameGap[]; references: Ref[];
}
export interface PreparedFrameProposals extends FrameProposals { guards: Ref[]; expected: PreparedFrame['expected'] }
export interface ObserveProposalRequest { project: string; proposal: Ref; request: ProposalRequest }
export interface ObservedProposal { record: Revision<LayerProposal>; definitions: string[]; references: Ref[]; sources: ProposalRequest }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const parts = ['nodes', 'localConnectors', 'artifacts', 'contracts', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers', 'anchors'] as const;
const schemas = new Ajv({ strict: true, allowUnionTypes: true });
const graphShapes = [schemas.compile(sealed(graphSchema)), schemas.compile(sealed(graphV2Schema))];
const codeShape = schemas.compile(sealed(graphV2Schema.properties['nodes'].items.properties.code.items));
const partShapes = new Map(parts.map(part => [part, schemas.compile(sealed(graphV2Schema.properties[part === 'localConnectors' ? 'connectors' : part].items))]));
const graphParts = ['nodes', 'connectors', 'artifacts', 'contracts', 'anchors', 'joins', 'tests'] as const;
const graphV2Parts = ['actors', 'requirements', 'edges', 'journeys', 'transfers', 'packets'] as const;
function invalid(field: string, target = 'proposals'): never {
  throw new EngineError('proposal_request_invalid', 'Proposal application needs explicit, well-formed inputs', { unit: 'F4.3', target, field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) {
    if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json');
    throw error;
  }
}
class ProposalFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function reject(code: string, target: string, field: string, message: string): never {
  const result = refused(code, message, { unit: 'F4.3', target, field }, 'producer');
  if (!result.ok) throw new ProposalFailure(result.refusal);
  throw new EngineError('proposal_internal_error', 'Refusal unexpectedly produced a value');
}
function take<T>(result: OmResult<T>): T {
  if (!result.ok) throw new ProposalFailure(result.refusal);
  return result.value;
}
function outcome<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof ProposalFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function requireRequest(value: unknown): asserts value is FrameRequest {
  if (!object(value) || !text(value['project']) || (value['level'] !== 2 && value['level'] !== 3)) invalid('frame.request');
  for (const key of ['graph', 'horizon']) if (!isRef(value[key])) invalid(`frame.${key}`);
  for (const key of ['layer', 'frame']) if (value[key] !== null && !isRef(value[key])) invalid(`frame.${key}`);
  const upper = value['upper'];
  if (value['level'] === 2 ? upper !== null : !object(upper) || !isRef(upper['horizon'])
    || (upper['frame'] !== null && !isRef(upper['frame']))) invalid('frame.upper');
}
function requireFrame(value: unknown): asserts value is FrameRead {
  if (!object(value)) invalid('frame');
  requireRequest(value['request']);
  if (!object(value['upper']) || !graphShapes[value['upper']['version'] === 2 ? 1 : 0]!(value['upper'])
    || !isRef(value['upperRef']) || !object(value['scope']) || !object(value['result'])
    || !Array.isArray(value['references']) || !value['references'].every(isRef)) invalid('frame');
  const scope = value['scope'];
  if (!Array.isArray(scope['nodes']) || !scope['nodes'].every(text) || !Array.isArray(scope['excluded'])
    || !scope['excluded'].every(item => object(item) && text(item['block']) && text(item['reason']) && text(item['returnCondition']))
    || typeof scope['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(scope['hash'])) invalid('frame.scope');
  const accepted = value['accepted'];
  if (accepted !== null && (!object(accepted) || !isRef(accepted['reference']) || !object(accepted['graph'])
    || !graphShapes[accepted['graph']['version'] === 2 ? 1 : 0]!(accepted['graph'])
    || (accepted['frame'] !== null && (!object(accepted['frame']) || !isRef(accepted['frame']['reference']) || !object(accepted['frame']['value']))))) invalid('frame.accepted');
  for (const key of ['obligations', 'fills', 'open', 'representatives', 'joins']) if (!Array.isArray(value['result'][key])) invalid(`frame.result.${key}`);
}
function requireObservations(value: unknown): asserts value is ProposalObservation[] {
  if (!Array.isArray(value)) invalid('proposals');
  for (const observation of value) if (!object(observation) || !isRef(observation['reference']) || !Object.hasOwn(observation, 'value')) invalid('proposals.reference');
}
function checkWorksContract(proposal: unknown, target: string): void {
  if (object(proposal) && Object.hasOwn(proposal, 'worksContract')
    && (proposal['level'] !== 3 || proposal['worksContract'] !== WORKS_FRAME_CONTRACT))
    reject('proposal_invalid', target, 'worksContract', 'The work proposal contract must be known and apply to L3');
}
function checkProposal(observation: ProposalObservation, frame: FrameRead): void {
  const { reference: ref, value: proposal } = observation;
  checkWorksContract(proposal, ref.id);
  if (!ref.id.startsWith(`om-proposal:${frame.request.project}:`) || hashJson(proposal) !== ref.hash)
    reject('proposal_invalid', ref.id, 'reference', 'The proposal must belong to this project and match its exact content');
  if (!object(proposal)) reject('proposal_invalid', ref.id, 'value', 'A layer proposal is an explicit record');
  if (!object(proposal.base) || !isRef(proposal.base.graph) || (proposal.base.frame !== null && !isRef(proposal.base.frame))
    || (proposal.level !== 2 && proposal.level !== 3) || !['input', 'decision'].includes(proposal.source)
    || !['proposed', 'accepted', 'rejected'].includes(proposal.status))
    reject('proposal_invalid', ref.id, 'base', 'A layer proposal names its base, level, source and status');
  if (proposal.status !== 'proposed') reject('proposal_not_proposed', ref.id, 'status', 'Only the proposed revision can be applied');
  if (!same(proposal.base.graph, frame.request.graph) || !same(proposal.base.frame, frame.request.frame) || proposal.level !== frame.request.level)
    reject('proposal_base_stale', ref.id, 'base', 'This proposal was offered for another graph, frame or level');
  for (const part of parts) {
    if (!Array.isArray(proposal[part]) || !proposal[part].every(item => partShapes.get(part)!(item)))
      reject('proposal_invalid', ref.id, part, 'Every introduced definition must be complete according to the native graph schema');
    const ids = proposal[part].map(item => item.id);
    if (new Set(ids).size !== ids.length) reject('proposal_invalid', ref.id, part, 'Introduced definitions have distinct IDs');
  }
  const fillShape = (row: unknown) => object(row) && text(row['obligation']) && text(row['node'])
    && (row['port'] === undefined || text(row['port']))
    && (!Object.hasOwn(row, 'codeRef') || proposal.worksContract === WORKS_FRAME_CONTRACT && codeShape(row['codeRef']))
    && (!Object.hasOwn(row, WAKE_TEST.field) || proposal.worksContract === WORKS_FRAME_CONTRACT && text(row[WAKE_TEST.field]))
    && Object.keys(row).every(key => ['obligation', 'node', 'port', ...(proposal.worksContract === WORKS_FRAME_CONTRACT ? ['codeRef', WAKE_TEST.field] : [])].includes(key));
  if (!Array.isArray(proposal.fills) || !proposal.fills.every(fillShape)) reject('proposal_invalid', ref.id, 'fills', 'Fills must be explicit complete endpoints');
  for (const field of ['removes', 'redefines'] as const)
    if (!Array.isArray(proposal[field]) || !proposal[field].every(text) || new Set(proposal[field]).size !== proposal[field].length)
      reject('proposal_invalid', ref.id, field, 'The change set is explicit and contains distinct IDs');
  if (!Array.isArray(proposal.replaces) || !proposal.replaces.every(row => object(row) && text(row.obligation)
    && object(row.base) && text(row.base.node) && isRef(row.base.graph) && object(row.with) && text(row.with.node)
    && (row.with.port === null || text(row.with.port)) && text(row.basis)))
    reject('proposal_invalid', ref.id, 'replaces', 'Replacement names its exact old node, new endpoint and basis');
}
function verifiedBase(frame: FrameRead): FilledFrame {
  if ((frame.accepted === null) !== (frame.request.layer === null)
    || (frame.accepted !== null && (!same(frame.accepted.reference, frame.request.graph)
    || !same(frame.accepted.frame?.reference ?? null, frame.request.frame))) || (frame.accepted === null && frame.request.frame !== null))
    reject('proposal_invalid', frame.request.graph.id, 'frame.accepted', 'Computed and accepted frame bases differ');
  const result = take(fillObligations(frame.upper, frame.scope, frame.accepted, frame.upperRef, frame.request.level)) as FilledFrame;
  if (!same(result, frame.result)) reject('proposal_invalid', frame.request.graph.id, 'frame.result', 'The complete C2 result must agree with its sources');
  return result;
}
const endpointKey = (fill: { node: string; port?: string }) => canonical([fill.node, fill.port ?? null]);
function fits(node: Node | undefined, row: ProposalFill, obligation: FrameObligation, frame: FrameRead, relations: RefinementRelations): boolean {
  if (!node || LEVEL[node.kind] !== frame.request.level || !relations.refines(node.id, obligation.upper.node)) return false;
  if (obligation.kind !== 'connection-end') return row.port === undefined && node.outcome === obligation.artifact;
  const port = node.ports.find(item => item.id === row.port);
  const contract = frame.upper.artifacts.find(item => item.id === obligation.artifact)?.contract;
  return !!port && port.direction === (obligation.role === 'producer' ? 'out' : 'in') && port.contract === contract;
}
function derive(frame: FrameRead, observations: ProposalObservation[], base: FilledFrame = verifiedBase(frame)): ProposalResult {
  const proposals = [...observations].sort((a, b) => order(a.reference.id, b.reference.id));
  if (new Set(proposals.map(item => item.reference.id)).size !== proposals.length)
    reject('proposal_invalid', 'proposals', 'reference', 'Each proposal occurs once in the checked set');
  for (const proposal of proposals) checkProposal(proposal, frame);
  const obligations = new Map(base.obligations.map(item => [item.id, item]));
  const accepted = frame.accepted?.graph ?? frame.upper;
  const reserved = new Set(frame.upper.nodes.filter(node => LEVEL[node.kind] === frame.request.level - 1)
    .map(node => representativeId(node.id, frame.request.level)));
  for (const row of [...base.fills, ...(frame.accepted?.frame?.value.fills ?? [])]) if (row.source === 'identity') reserved.add(row.node);
  const oldFills = base.fills.filter(row => row.source === 'accepted');
  const additions = new Map<string, ProposalResult['fills']>();
  const replacements = new Map<string, string>();
  const removed = new Set(proposals.flatMap(item => item.value.removes));
  const definitions = new Map<string, Node>();
  for (const observation of proposals) {
    const { value: proposal, reference: ref } = observation;
    for (const node of proposal.nodes) {
      if (reserved.has(node.id)) reject('proposal_node_reserved', node.id, 'id', 'Identity representative IDs cannot be introduced by proposals');
      const other = definitions.get(node.id);
      if (other && !same(other, node)) reject('slot_fill_conflict', node.id, 'nodes', 'Proposals disagree on a node definition');
      definitions.set(node.id, node);
      const old = frame.accepted?.graph.nodes.find(item => item.id === node.id);
      if (old && !same(old, node) && !proposal.removes.includes(node.id))
        reject('slot_fill_conflict', node.id, 'nodes', 'A changed accepted node needs an explicit replacement');
      if (LEVEL[node.kind] !== frame.request.level) reject('slot_fill_foreign', node.id, 'level', 'A proposal introduces nodes only at its own level');
    }
    for (const id of proposal.removes) {
      const node = frame.accepted?.graph.nodes.find(item => item.id === id);
      if (!node || LEVEL[node.kind] !== frame.request.level || reserved.has(id))
        reject('slot_fill_conflict', id, 'removes', 'Removal names a real node of the accepted lower layer');
    }
    const nodes = new Map(accepted.nodes.map(node => [node.id, node]));
    for (const node of proposal.nodes) nodes.set(node.id, node);
    const relations = new RefinementRelations({ ...accepted, nodes: [...nodes.values()], edges: [...(accepted.edges ?? []), ...proposal.edges] });
    for (const row of proposal.fills) {
      const obligation = obligations.get(row.obligation), node = nodes.get(row.node);
      if (reserved.has(row.node)) reject('proposal_node_reserved', row.node, 'fill', 'An identity node cannot masquerade as proposed real refinement');
      const own = proposal.nodes.some(item => item.id === row.node);
      if ((!own && !frame.accepted?.graph.nodes.some(item => item.id === row.node))
        || !obligation || !fits(node, row, obligation, frame, relations) || (removed.has(row.node) && !own))
        reject('slot_fill_foreign', row.obligation, 'fill', 'The endpoint must be accepted or defined in this proposal and refine the named upper end');
      if (proposal.worksContract === WORKS_FRAME_CONTRACT && (obligation.kind === 'connection-end'
        ? !Object.hasOwn(row, 'codeRef') || !node!.code.some(code => same(code, row.codeRef))
        : Object.hasOwn(row, 'codeRef')))
        reject('slot_fill_foreign', row.obligation, 'codeRef', 'A real connection end needs one exact declared code reference; outcome fills carry none');
      // G5: the wake test chosen by the work is checked when the work itself is accepted, whatever its neighbour sleeps now.
      if (Object.hasOwn(row, WAKE_TEST.field)) {
        const test = [...accepted.tests, ...proposals.flatMap(item => item.value.tests)].find(item => item.id === row.wakeTest);
        if (obligation.kind !== 'connection-end' || obligation.role !== 'producer' || !obligation.connector || !test
          || test.node !== row.node || !node!.tests.includes(test.id) || !test.covers.includes(obligation.connector))
          reject('slot_fill_foreign', row.obligation, WAKE_TEST.field, WAKE_TEST.rule);
      }
      const values = additions.get(row.obligation) ?? [];
      if (values.some(item => endpointKey(item) === endpointKey(row)) || (obligation.role !== 'consumer' && values.length > 0))
        reject('slot_fill_conflict', row.obligation, 'fill', 'Different proposals cannot compete for a single endpoint or single-valued obligation');
      values.push({ ...row, source: 'proposed', basis: ref }); additions.set(row.obligation, values);
    }
    for (const replacement of proposal.replaces) {
      const before = oldFills.filter(row => row.obligation === replacement.obligation && row.node === replacement.base.node);
      if (!same(replacement.base.graph, frame.request.graph) || !before.length)
        reject('proposal_base_stale', replacement.obligation, 'replaces.base', 'Replacement must name the accepted graph before removal');
      if (!proposal.fills.some(row => row.obligation === replacement.obligation
        && row.node === replacement.with.node && (row.port ?? null) === replacement.with.port))
        reject('slot_fill_conflict', replacement.obligation, 'replaces', 'Replacement must connect an accepted fill to an endpoint of this proposal');
      const key = canonical([replacement.obligation, replacement.base.node]);
      if (replacements.has(key)) reject('slot_fill_conflict', replacement.obligation, 'replaces', 'The same accepted base has competing replacements');
      replacements.set(key, ref.id);
    }
    for (const row of proposal.fills) if (oldFills.some(old => old.obligation === row.obligation)
      && !proposal.replaces.some(item => item.obligation === row.obligation && item.with.node === row.node && item.with.port === (row.port ?? null)))
      reject('slot_fill_conflict', row.obligation, 'replaces', 'An occupied real obligation needs an explicit replacement');
  }
  for (const row of oldFills) if (removed.has(row.node) && !replacements.has(canonical([row.obligation, row.node])))
    reject('slot_fill_conflict', row.obligation, 'removes', 'Removal cannot silently discard another accepted fill');
  const fills: ProposalResult['fills'] = [];
  for (const obligation of base.obligations) {
    const before = oldFills.filter(row => row.obligation === obligation.id && !replacements.has(canonical([row.obligation, row.node])));
    const proposed = additions.get(obligation.id) ?? [];
    const real = [...before, ...proposed];
    if (obligation.role !== 'consumer' && real.length > 1) reject('slot_fill_conflict', obligation.id, 'fill', 'The obligation needs exactly one real endpoint');
    if (new Set(real.map(endpointKey)).size !== real.length) reject('slot_fill_conflict', obligation.id, 'fill', 'A replacement duplicates a surviving endpoint');
    fills.push(...(real.length ? real : base.fills.filter(row => row.obligation === obligation.id && row.source === 'identity')));
  }
  const open = base.obligations.filter(item => item.zone === 'horizon' && !fills.some(row => row.obligation === item.id));
  const identity = fills.filter(row => row.source === 'identity');
  const representatives = base.representatives.filter(node => identity.some(row => row.node === node.id)).map(node => ({ ...node,
    ports: node.ports.filter(port => identity.some(row => row.node === node.id && row.port === port.id)) }));
  const joins = base.joins.flatMap(join => {
    const connectors = join.connectors.filter(connector => identity.some(row => row.node === join.consumer
      && obligations.get(row.obligation)?.role === 'consumer' && obligations.get(row.obligation)?.connector === connector));
    return connectors.length ? [{ ...join, connectors, ...(join.required ? { required: join.required.filter(id => connectors.includes(id)) } : {}),
      ...(join.optional ? { optional: join.optional.filter(id => connectors.includes(id)) } : {}) }] : [];
  });
  return { obligations: base.obligations, fills: sorted(fills), open, representatives, joins: sorted(joins), proposals };
}

/** Pure calls require complete structural correspondence. Partial rebases need read/prepareFrameProposals,
 * whose C2 reader verifies the saved transition; caller-supplied markers never establish that provenance. */
export function applyProposals(frame: FrameRead, proposals: ProposalObservation[]): OmResult<Sealed<ProposalResult>> {
  requireFrame(frame); requireObservations(proposals);
  return outcome(() => {
    for (const proposal of proposals) checkWorksContract(proposal.value, proposal.reference.id);
    frame = copy(frame); proposals = copy(proposals);
    return derive(frame, proposals);
  });
}
function gapsOf(frame: FrameRead, result: ProposalResult): FrameGap[] {
  const base = frame.accepted?.graph ?? frame.upper;
  const removed = new Set(result.proposals.flatMap(item => item.value.removes));
  const nodes = new Map(base.nodes.filter(node => !removed.has(node.id)
    && (frame.accepted !== null || LEVEL[node.kind] < frame.request.level)).map(node => [node.id, node]));
  const edges = new Map((base.edges ?? []).map(edge => [edge.id, edge]));
  for (const proposal of result.proposals) {
    for (const node of proposal.value.nodes) nodes.set(node.id, node);
    for (const edge of proposal.value.edges) edges.set(edge.id, edge);
  }
  const graph = { ...base, nodes: [...nodes.values()], edges: [...edges.values()] };
  const relations = new RefinementRelations(graph);
  const identities = new Set([...(frame.accepted?.frame?.value.fills ?? []), ...frame.result.fills].filter(row => row.source === 'identity').map(row => row.node));
  return result.open.map(obligation => ({ target: obligation.id, field: 'fill', kind: 'design-decision', consumer: obligation.upper.node,
    neighbors: obligation.kind === 'connection-end' ? result.obligations.filter(other => other.id !== obligation.id
      && other.connector === obligation.connector && other.flow === obligation.flow) : [], blocking: true,
    question: { level: frame.request.level, upper: obligation.upper.node, artifact: obligation.artifact,
      role: obligation.role ?? 'producer', port: obligation.upper.port ?? null,
      portContract: frame.upper.artifacts.find(item => item.id === obligation.artifact)?.contract ?? null,
      existing: graph.nodes.filter(node => LEVEL[node.kind] === frame.request.level && !identities.has(node.id)
        && (obligation.kind === 'connection-end' ? node.ports.some(port => fits(node, { obligation: obligation.id, node: node.id, port: port.id }, obligation, frame, relations))
          : fits(node, { obligation: obligation.id, node: node.id }, obligation, frame, relations))).map(node => node.id).sort(order), allowNew: true } }));
}
/** Recompute instead of trusting an omitted obligation, open row, or fabricated fill. Absence never closes a line. */
export function openObligationsToGaps(frame: FrameRead, result: ProposalResult): OmResult<Sealed<FrameGap[]>> {
  requireFrame(frame);
  if (!object(result)) invalid('result');
  requireObservations(result.proposals);
  for (const field of ['obligations', 'fills', 'open', 'representatives', 'joins'] as const) if (!Array.isArray(result[field])) invalid(`result.${field}`);
  return outcome(() => {
    for (const proposal of result.proposals) checkWorksContract(proposal.value, proposal.reference.id);
    frame = copy(frame); result = copy(result);
    const derived = derive(frame, result.proposals);
    if (!same(derived, result)) reject('proposal_invalid', frame.request.graph.id, 'result', 'Gap sources must equal the complete result derived from the checked proposals');
    return gapsOf(frame, derived);
  });
}
function requireStored(store: Store, request: unknown): asserts request is ProposalRequest {
  if (!(store instanceof Store) || !object(request)) invalid('request');
  requireRequest(request['frame']);
  if (!Array.isArray(request['proposals']) || !request['proposals'].every(isRef)) invalid('proposals');
}
/** Read only definition addresses. Semantic validity belongs to application and the graph gates. */
export function definitionIds(value: unknown, kind: 'proposal' | 'graph', target: string): OmResult<Sealed<string[]>> {
  if (!['proposal', 'graph'].includes(kind) || !text(target)) invalid('definitions');
  return outcome(() => {
    if (!object(value)) reject('proposal_invalid', target, 'value', 'Definition-bearing content must be an explicit object');
    if (kind === 'graph' && value['version'] !== 1 && value['version'] !== 2)
      reject('proposal_invalid', target, 'version', 'Definition-bearing graphs name their schema version');
    const required: readonly string[] = kind === 'proposal' ? [...parts] : [...graphParts, ...(value['version'] === 2 ? graphV2Parts : [])];
    const optional = kind === 'graph' ? graphV2Parts.filter(part => !required.includes(part)) : [];
    // Task bindings refer to definitions owned by their external research scope, like fills refer to nodes.
    if (kind === 'graph' && Object.hasOwn(value, 'researchObligations') && !Array.isArray(value['researchObligations']))
      reject('proposal_invalid', target, 'researchObligations', 'Task bindings must be an explicit set when present');
    const definitions: string[] = [];
    for (const part of [...required, ...optional.filter(part => Object.hasOwn(value, part))]) {
      const entries = value[part];
      if (!Array.isArray(entries)) reject('proposal_invalid', target, part, 'A definition section must be an explicit readable set');
      for (let index = 0; index < entries.length; index++) {
        const entry: unknown = entries[index];
        if (!object(entry) || !text(entry['id']))
          reject('proposal_invalid', target, `${part}.${index}.id`, 'Each definition must have its readable address');
        definitions.push(entry['id']);
      }
    }
    return [...new Set(definitions)].sort(order);
  });
}
/** Observation reads a refusal's historical composition; it never applies or accepts that proposal. */
export function observeProposal(store: Store, request: ObserveProposalRequest): OmResult<Sealed<ObservedProposal>> {
  if (!object(request) || !text(request.project) || !isRef(request.proposal)) invalid('observation');
  requireStored(store, request.request); request = copy(request);
  return outcome(() => {
    const context = request.request;
    if (context.frame.project !== request.project || !context.proposals.some(ref => same(ref, request.proposal)))
      reject('proposal_invalid', request.proposal.id, 'request', 'The observed proposal must occur in its own project context');
    if (new Set(context.proposals.map(ref => ref.id)).size !== context.proposals.length)
      reject('proposal_invalid', request.proposal.id, 'request.proposals', 'A proposal context names each exact participant once');
    const frame = take(readFrame(store, context.frame)), references = [...frame.references];
    let observed: ObservedProposal | null = null;
    for (const ref of context.proposals) {
      const record = take(readRecord<LayerProposal>(store, ref, { unit: 'F4.3', target: ref.id,
        idPrefix: `om-proposal:${request.project}:`, kind: 'layer-proposal' })) as Revision<LayerProposal>;
      const proposal = record.value;
      checkWorksContract(proposal, ref.id);
      if (!object(proposal) || !object(proposal.base) || !isRef(proposal.base.graph)
        || proposal.base.frame !== null && !isRef(proposal.base.frame) || ![2, 3].includes(proposal.level)
        || !['input', 'decision'].includes(proposal.source) || !['proposed', 'accepted', 'rejected'].includes(proposal.status))
        reject('proposal_invalid', ref.id, 'base', 'A proposal observation needs its recorded base, level, source and status');
      if (proposal.level !== context.frame.level || !same(proposal.base.graph, context.frame.graph)
        || !same(proposal.base.frame, context.frame.frame))
        reject('proposal_base_stale', ref.id, 'base', 'The observed proposal must belong to this exact frame basis');
      for (const part of ['fills', 'removes', 'redefines', 'replaces'] as const)
        if (!Array.isArray(proposal[part])) reject('proposal_invalid', ref.id, part, 'A proposal must retain every mandatory section');
      const definitions = take(definitionIds(proposal, 'proposal', ref.id));
      references.push(reference(record));
      if (same(ref, request.proposal)) observed = { record, definitions: [...definitions], references,
        sources: { frame: context.frame, proposals: sorted(context.proposals) } };
    }
    return { ...observed!, references: sorted([...new Map(references.map(ref => [canonical(ref), ref])).values()]) };
  });
}
function loadProposals(store: Store, request: ProposalRequest): ProposalObservation[] {
  return request.proposals.map(ref => {
    const record = take(readRecord<LayerProposal>(store, ref, { unit: 'F4.3', target: ref.id,
      idPrefix: `om-proposal:${request.frame.project}:`, kind: 'layer-proposal' }));
    return { reference: reference(record), value: record.value as LayerProposal };
  });
}
function bundle(frame: FrameRead, proposals: ProposalObservation[]): FrameProposals {
  // Only the storage entry points call this function, immediately after their own verified C2 read.
  const result = derive(frame, proposals, frame.result);
  const references = sorted([...new Map([...frame.references, ...result.proposals.map(item => item.reference)]
    .map(ref => [canonical(ref), ref])).values()]);
  return { frame, proposals: result.proposals, result, gaps: gapsOf(frame, result), references };
}
export function readFrameProposals(store: Store, request: ProposalRequest): OmResult<Sealed<FrameProposals>> {
  requireStored(store, request); request = copy(request);
  return outcome(() => bundle(take(readFrame(store, request.frame)) as FrameRead, loadProposals(store, request)));
}
/** No writes or status changes: C4/C5 use this same checked set and these guards in their own transaction. */
export function prepareFrameProposals(store: Store, request: ProposalRequest): OmResult<Sealed<PreparedFrameProposals>> {
  requireStored(store, request); request = copy(request);
  return outcome(() => {
    const frame = take(prepareFrame(store, request.frame)) as PreparedFrame;
    const result = bundle(frame, loadProposals(store, request));
    const guards = new Map(frame.guards.map(ref => [ref.id, ref]));
    for (const proposal of result.proposals) {
      const head = store.get(proposal.reference.id);
      if (!head || !same(reference(head), proposal.reference))
        reject('input_stale', proposal.reference.id, 'head', 'A proposal changed after its named revision; use the current proposed record');
      guards.set(proposal.reference.id, proposal.reference);
    }
    return { ...result, guards: sorted([...guards.values()]), expected: frame.expected };
  });
}

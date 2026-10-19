import { Ajv } from 'ajv';
import { EngineError } from '../errors.js';
import type { Graph } from '../graph/model.js';
import { projectGraph } from '../graph/project.js';
import { RefinementRelations } from '../graph/relations.js';
import { graphSchema, graphV2Schema } from '../graph/schema.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { Store } from '../storage/store.js';
import { readFrame, prepareFrame, type FrameRequest } from './frame-obligations.js';
import { readHorizon, type Horizon } from './horizon.js';
import { withHistoricalReads } from './input.js';
import { delivered, isPlainObject, refused, sealed, type OmResult, type Sealed } from './refusal.js';

export const WORK_ZONE_CODES = Object.freeze([
  'work_zone_request_invalid', 'horizon_execution_missing', 'work_zone_basis_unproven',
] as const);
export type WorkZoneHorizon = Sealed<Pick<Horizon, 'nodes' | 'execution'>>;

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
let graphShapes: ReturnType<Ajv['compile']>[] | undefined;
const zoneShapes = () => graphShapes ??= (() => {
  const schemas = new Ajv({ strict: true, allErrors: false, allowUnionTypes: true });
  return [schemas.compile(sealed(graphSchema)), schemas.compile(sealed(graphV2Schema))];
})();
function invalid(field: string): never {
  throw new EngineError('work_zone_request_invalid', 'The work zone needs explicit, well-formed sources',
    { unit: 'F7.1', target: 'work-zone', field });
}

/** This selects from an accepted L2 projection; persisted callers prove acceptance through C2. */
export function workZone(graph: Graph, horizon: WorkZoneHorizon, identityOps: readonly string[]): OmResult<Sealed<string[]>> {
  if (!object(graph) || !zoneShapes()[graph.version === 2 ? 1 : 0]!(graph)) invalid('graph');
  if (!object(horizon) || !Array.isArray(horizon.nodes) || !Array.from(horizon.nodes).every(text)) invalid('horizon.nodes');
  if (!Array.isArray(identityOps) || !Array.from(identityOps).every(text)) invalid('identityOps');
  const projected = projectGraph(graph, 2);
  const upper = { ...projected, version: graph.version } as Graph;
  const nodes = new Map(upper.nodes.map(node => [node.id, node]));
  for (const block of horizon.nodes) {
    if (nodes.get(block)?.kind !== 'block') return refused('work_zone_basis_unproven',
      'The horizon must name a block of the accepted graph', { unit: 'F7.1', target: block, field: 'horizon.nodes' }, 'producer');
    const execution = object(horizon.execution) && Object.hasOwn(horizon.execution, block) ? horizon.execution[block] : undefined;
    if (!object(execution) || !Object.hasOwn(execution, 'state') || !['needed', 'available'].includes(execution['state'] as string)
      || (execution['state'] === 'available' && (!Object.hasOwn(execution, 'basis') || !object(execution['basis']) || !Object.values(execution['basis']).every(isRef))))
      return refused('horizon_execution_missing', 'The horizon must explicitly state execution readiness and its basis',
        { unit: 'F7.1', target: block, field: 'execution' }, 'readiness');
  }
  if (!object(horizon.execution)) return refused('horizon_execution_missing', 'The horizon must include an explicit execution map',
    { unit: 'F7.1', target: 'horizon', field: 'execution' }, 'readiness');
  for (const id of identityOps) if (nodes.get(id)?.kind !== 'operation') return refused('work_zone_basis_unproven',
    'An identity classification must name an operation of the accepted graph', { unit: 'F7.1', target: id, field: 'identityOps' }, 'producer');
  const identities = new Set(identityOps), relations = new RefinementRelations(upper);
  return delivered(upper.nodes.filter(node => node.kind === 'operation' && !identities.has(node.id)
    && horizon.nodes.some(block => horizon.execution[block]!.state === 'needed' && relations.refines(node.id, block)))
    .map(node => node.id).sort(order));
}

export interface WorkZoneRequest { project: string; graph: Ref; layer: Ref; horizon: Ref; frame: Ref | null }
export interface WorkZoneRead { request: WorkZoneRequest; operations: string[]; references: Ref[] }
export interface PreparedWorkZone extends WorkZoneRead { guards: Ref[] }

function requireRequest(store: Store, request: unknown): asserts request is WorkZoneRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(request) || !text(request['project']) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request['project'])) invalid('request.project');
  for (const field of ['graph', 'layer', 'horizon']) if (!isRef(request[field])) invalid(field);
  if (request['frame'] !== null && !isRef(request['frame'])) invalid('frame');
}
function checkedZone(store: Store, request: WorkZoneRequest, current: boolean): OmResult<Sealed<PreparedWorkZone>> {
  requireRequest(store, request);
  const source = sealed({ project: request.project, graph: request.graph, layer: request.layer,
    horizon: request.horizon, frame: request.frame });
  const frameRequest: FrameRequest = { ...source, level: 2, upper: null };
  const frame = current ? prepareFrame(store, frameRequest) : readFrame(store, frameRequest);
  if (!frame.ok) return frame;
  const horizon = readHorizon(store, source.project, source.horizon);
  if (!horizon.ok) return horizon;
  const accepted = frame.value.accepted;
  if (!accepted) return refused('work_zone_basis_unproven', 'A work zone requires the accepted operation layer',
    { unit: 'F7.1', target: source.layer.id, field: 'layer', ref: source.layer }, 'producer');
  // A new horizon can reopen an identity obligation without making the saved operation real.
  const identities = [...new Set((accepted.frame?.value.fills ?? []).filter(fill => fill.source === 'identity').map(fill => fill.node))];
  const zone = workZone(accepted.graph as Graph, horizon.value.horizon.value.result.horizon, identities);
  if (!zone.ok) return zone;
  return delivered({ request: source, operations: zone.value, references: frame.value.references,
    guards: 'guards' in frame.value ? frame.value.guards as Ref[] : [] });
}

/** Reconstruct a historical zone from exact sources; moving heads does not rewrite history. */
export function readWorkZone(store: Store, request: WorkZoneRequest): OmResult<Sealed<WorkZoneRead>> {
  return withHistoricalReads(() => {
    const result = checkedZone(store, request, false);
    if (!result.ok) return result;
    const { guards: _guards, ...read } = result.value;
    return delivered(read);
  });
}

/** Admit use by the next operation and return C2's complete transaction guards, without writing. */
export function prepareWorkZone(store: Store, request: WorkZoneRequest): OmResult<Sealed<PreparedWorkZone>> {
  return withHistoricalReads(() => checkedZone(store, request, true));
}

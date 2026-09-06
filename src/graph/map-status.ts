import type { Store } from '../storage/store.js';
import { canonical } from '../canonical.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { requireCondition, EngineError } from '../errors.js';
import type { Graph, CodeRef } from './model.js';
import { lstatSync } from 'node:fs';
import { workspacePath } from '../runtime/environment.js';

export interface MapStatusDelta { projectId: string; base: Ref; actor: string;
  nodes: { id: string; status: 'existing' | 'future'; explanation: string; code: CodeRef[] }[] }
/** Present-day implementation status is a separately attributed delta, not a
 * rewrite of the accepted historical layer or its evidence hashes. */
export function saveMapStatus(store: Store, delta: MapStatusDelta, expected: number, root: string) {
  const base = isRef(delta.base) ? store.get<Graph>(delta.base.id) : null;
  requireCondition(base?.kind === 'graph' && base.id === `graph:${delta.projectId}` && canonical(reference(base)) === canonical(delta.base),
    'map_status_foreign', 'Implementation status must bind this exact project map');
  requireCondition(delta.actor.trim() && Array.isArray(delta.nodes) && delta.nodes.length > 0 && new Set(delta.nodes.map(n => n.id)).size === delta.nodes.length,
    'map_status_invalid', 'An attributed nonempty node delta is required');
  for (const node of delta.nodes) {
    requireCondition(base.value.nodes.some(n => n.id === node.id) && ['existing','future'].includes(node.status) && node.explanation.trim()
      && Array.isArray(node.code) && (node.status !== 'existing' || node.code.length > 0), 'map_status_invalid', 'Existing status needs actual code references');
    for (const code of node.code) {
      requireCondition(code.status === 'existing' && ['read','write'].includes(code.access), 'map_status_invalid', 'Status evidence points to existing code');
      try { requireCondition(lstatSync(workspacePath(root, code.path)).isFile(), 'map_status_evidence_missing', 'Status source must exist in the bound repository'); }
      catch { throw new EngineError('map_status_evidence_missing', 'Status source is missing or outside the bound repository'); }
    }
  }
  return store.writeMany<MapStatusDelta>([{ id:`map-status:${delta.projectId}`,kind:'map-status',expected,value:delta }],[reference(base)])[0]!;
}
export function mapStatus(store: Store, project: string) {
  const delta=store.get<MapStatusDelta>(`map-status:${project}`);
  if (!delta) return null;
  const graph=store.get<Graph>(`graph:${project}`);
  requireCondition(delta.kind==='map-status' && delta.value.projectId===project, 'map_status_foreign', 'Foreign map annotation');
  return { record: delta, current: Boolean(graph && canonical(reference(graph))===canonical(delta.value.base)) };
}

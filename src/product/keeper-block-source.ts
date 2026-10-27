import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision } from '../storage/store.js';
import { collectBlockSubject, checkBlockSubject, type BlockSubject, type BlockSubjectRequest } from '../om/block-keeper.js';
import type { CandidateResult } from '../om/frame-candidate.js';
import type { KeeperAddress } from './keeper.js';

export const KEEPER_BLOCK_SOURCE_KIND = 'keeper-block-source' as const;
export const KEEPER_BLOCK_SOURCE_CONTRACT = 'keeper-block-source/v1' as const;
export interface KeeperBlockContainer {
  contract: typeof KEEPER_BLOCK_SOURCE_CONTRACT;
  project: string;
  candidate: Ref;
  block: string;
  subject: BlockSubject;
}
export interface KeeperBlockSource {
  container: Revision<KeeperBlockContainer>;
  address: KeeperAddress & { pointer: '/subject' };
  material: BlockSubject;
  grounds: BlockSubject['grounds'];
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function invalid(field: string): never {
  throw new EngineError('keeper_block_source_invalid', 'Expected a complete proven block source at its exact address', { field });
}
function snapshot(value: unknown): unknown {
  try { return JSON.parse(canonical(value)); } catch { return invalid('input'); }
}
function exact(value: unknown): value is Ref {
  return object(value) && Object.keys(value).sort().join(',') === 'hash,id,revision' && isRef(value);
}
function request(value: unknown): BlockSubjectRequest {
  const input = snapshot(value);
  if (!object(input) || Object.keys(input).sort().join(',') !== 'block,candidate,project'
    || !text(input.project) || !exact(input.candidate) || !text(input.block)) invalid('request');
  return input as unknown as BlockSubjectRequest;
}
function take<T>(result: CandidateResult<T>): T {
  if (!result.ok) throw new EngineError(result.refusal.code, result.refusal.message, result.refusal.at);
  return snapshot(result.value) as T;
}
function identity(input: BlockSubjectRequest): string {
  return `${KEEPER_BLOCK_SOURCE_KIND}:${input.project}:${hashJson(input as unknown as Json)}`;
}
function delivered(container: Revision<KeeperBlockContainer>): KeeperBlockSource {
  return structuredClone({ container, address: { container: reference(container), pointer: '/subject' as const },
    material: container.value.subject, grounds: container.value.subject.grounds });
}

/** Prove the complete saved material against the historical candidate, never today's graph or a caller inventory. */
export function readKeeperBlockSourceAt(store: Store, project: string, sourceRef: unknown): KeeperBlockSource {
  const at = snapshot(sourceRef);
  if (!(store instanceof Store) || !text(project) || !exact(at) || at.revision !== 1) invalid('reference');
  const saved = snapshot(store.get(at.id, at.revision));
  if (!object(saved) || saved.id !== at.id || saved.revision !== at.revision || saved.hash !== at.hash
    || saved.kind !== KEEPER_BLOCK_SOURCE_KIND) invalid('container');
  const value = saved.value;
  if (!object(value) || Object.keys(value).sort().join(',') !== 'block,candidate,contract,project,subject'
    || value.contract !== KEEPER_BLOCK_SOURCE_CONTRACT || value.project !== project) invalid('contract');
  if (hashJson(value as Json) !== at.hash) invalid('container');
  const row = saved as unknown as Revision<KeeperBlockContainer>;
  const input = request({ project: value.project, candidate: value.candidate, block: value.block });
  if (identity(input) !== at.id) invalid('identity');
  take(checkBlockSubject(store, input, value.subject));
  return delivered(row);
}

/** Save material for a Keeper check, not an OM acceptance or a Keeper verdict.
 * Re-proving and publishing run under one write lock; concurrent preparations share one revision. */
export function prepareKeeperBlockSource(store: Store, input: unknown): KeeperBlockSource {
  if (!(store instanceof Store)) invalid('store');
  const selected = request(input), id = identity(selected);
  const existing = store.get(id);
  if (existing) {
    if (existing.revision !== 1) invalid('immutable');
    return readKeeperBlockSourceAt(store, selected.project, reference(existing));
  }
  const written = store.atomicWrite<KeeperBlockSource | null>(view => {
    const saved = view.get(id);
    if (saved) {
      if (saved.revision !== 1) invalid('immutable');
      return { value: readKeeperBlockSourceAt(view, selected.project, reference(saved)), writes: [], guards: [] };
    }
    const subject = take<BlockSubject>(collectBlockSubject(view, selected));
    const value: KeeperBlockContainer = { contract: KEEPER_BLOCK_SOURCE_CONTRACT, ...selected, subject };
    return { value: null, writes: [{ id, kind: KEEPER_BLOCK_SOURCE_KIND, expected: 0, value: value as unknown as Json }], guards: [] };
  });
  return written.value ?? delivered(written.records[0] as Revision<KeeperBlockContainer>);
}

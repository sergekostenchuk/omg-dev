import { hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { prepareKeeperRequest, type KeeperRequest } from './keeper-request.js';
import { readKeeperPairSourceAt } from './keeper-pair-source.js';
import { readKeeperBlockPairSourceAt } from './keeper-block-pair-source.js';
import { decodeKeeperPackingInput, exactRef, keys, readKeeperArchive, same, snapshot, stageKeeperPacking, valid,
  type KeeperPacking, type KeeperPackingInput } from './keeper-packing.js';

export const KEEPER_SESSION = 'keeper-session/v1' as const;
export interface KeeperSessionInput extends KeeperPackingInput {
  project: string; sourceKind: 'stage' | 'block'; source: Ref; manifest: Ref; checkVersion: string;
}
export interface KeeperSession {
  contract: typeof KEEPER_SESSION; project: string; state: 'prepared'; input: KeeperSessionInput;
  request: KeeperRequest; packing: KeeperPacking; limits: { request: number; reply: number };
}
function decode(value: unknown): KeeperSessionInput {
  valid(keys(value, ['project', 'sourceKind', 'source', 'manifest', 'checkVersion', 'environment',
    'prompt', 'packetChars', 'limitChars', 'resultLimitChars']), 'Expected the closed Keeper preparation input');
  valid(typeof value.project === 'string' && !!value.project.trim()
    && ['stage', 'block'].includes(value.sourceKind) && exactRef(value.source) && exactRef(value.manifest)
    && typeof value.checkVersion === 'string' && !!value.checkVersion.trim(), 'Expected project, source kind, exact source/manifest and explicit check version');
  decodeKeeperPackingInput({ environment: value.environment, prompt: value.prompt, packetChars: value.packetChars,
    limitChars: value.limitChars, resultLimitChars: value.resultLimitChars });
  return structuredClone(value) as KeeperSessionInput;
}
async function stage(store: Store, input: KeeperSessionInput) {
  const proven = input.sourceKind === 'block'
    ? await readKeeperBlockPairSourceAt(store, input.project, input.source, input.manifest, input.checkVersion)
    : await readKeeperPairSourceAt(store, input.project, input.source, input.manifest, input.checkVersion);
  const request = prepareKeeperRequest(proven.pair);
  const staged = stageKeeperPacking(store, input.project, request, input);
  const value: KeeperSession = { contract: KEEPER_SESSION, project: input.project, state: 'prepared',
    input: structuredClone(input), request: structuredClone(request), packing: structuredClone(staged.packing),
    limits: { request: input.limitChars, reply: input.resultLimitChars } };
  return { value, writes: staged.writes, guards: staged.guards };
}
const idFor = (value: KeeperSession) => `keeper-session:${value.project}:${hashJson(value as unknown as Json)}`;

/** An exact prepared session is historical material, never a current authority to spend. Re-prove both origins,
 * archived parts and the entire preparation; a valid hash alone is not provenance. No writes occur here. */
export async function readKeeperSessionAt(store: Store, project: string, rawRef: unknown): Promise<Revision<KeeperSession>> {
  const at = snapshot(rawRef);
  valid(exactRef(at), 'Expected the closed exact session Ref');
  const row = store.get<KeeperSession>(at.id, at.revision);
  valid(row && row.kind === 'keeper-session' && row.revision === 1 && same(reference(row), at)
    && hashJson(row.value as unknown as Json) === at.hash
    && keys(row.value, ['contract', 'project', 'state', 'input', 'request', 'packing', 'limits'])
    && row.value.contract === KEEPER_SESSION && row.value.project === project && row.value.state === 'prepared'
    && idFor(row.value) === row.id, 'The exact session is missing, foreign, malformed or changed');
  const input = decode(row.value.input);
  valid(input.project === project, 'The session input belongs to another project');
  const expected = await stage(store, input);
  valid(same(expected.value, row.value), 'The saved session differs from its proven sources, Environment, request, limits or delivery');
  const archive = readKeeperArchive(store, project, row.value.packing.archive, expected.value.request);
  valid(same(archive.parts, row.value.packing.parts), 'The saved session names incomplete archive parts');
  return structuredClone(row);
}

/** Snapshot caller getters before async proof. Publish archive, common parts and session in one guarded CAS.
 * A commit/return cut or competing Store recovers the same exact prepared session without a new revision. */
export async function prepareKeeperSession(store: Store, rawInput: unknown): Promise<Revision<KeeperSession>> {
  const input = decode(snapshot(rawInput)), prepared = await stage(store, input);
  const id = idFor(prepared.value), existing = store.get(id);
  if (existing) {
    valid(existing.kind === 'keeper-session' && existing.revision === 1
      && same(existing.value, prepared.value) && existing.hash === hashJson(existing.value), 'An incompatible record occupies the deterministic session address');
    return readKeeperSessionAt(store, input.project, reference(existing));
  }
  try {
    const rows = store.writeMany([...prepared.writes,
      { id, kind: 'keeper-session', expected: 0, value: prepared.value as unknown as Json }], prepared.guards);
    return structuredClone(rows.find(row => row.id === id)!) as unknown as Revision<KeeperSession>;
  } catch (error) {
    if (!(error instanceof EngineError) || error.code !== 'revision_conflict') throw error;
    const winner = store.get(id);
    if (!winner) throw error;
    valid(winner.kind === 'keeper-session' && same(winner.value, prepared.value), 'The competing session is incompatible');
    return readKeeperSessionAt(store, input.project, reference(winner));
  }
}

import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Store } from '../storage/store.js';
import { KEEPER_CHECK_KEY_CONTRACT, keeperCheckKey } from './keeper.js';
import { decodeKeeperPair, type KeeperPair } from './keeper-result.js';
import { readKeeperBlockSourceAt, type KeeperBlockSource } from './keeper-block-source.js';
import { readKeeperConstitutionSourceAt, type KeeperConstitutionSource } from './keeper-constitution-source.js';

export interface KeeperBlockPairSource {
  artifact: KeeperBlockSource;
  constitution: KeeperConstitutionSource;
  pair: KeeperPair;
  checkId: string;
}

/** Exact saved full block × accepted constitution. The candidate is proven composition, not an accepted OM plan. */
export async function readKeeperBlockPairSourceAt(store: Store, project: string, blockSourceRef: unknown,
  manifestRef: unknown, checkVersion: string): Promise<KeeperBlockPairSource> {
  let input: { project: string; blockSourceRef: unknown; manifestRef: unknown; checkVersion: string };
  try { input = JSON.parse(canonical({ project, blockSourceRef, manifestRef, checkVersion })); }
  catch { throw new EngineError('keeper_block_pair_source_invalid', 'Expected exact sources and an explicit check version'); }
  if (typeof input.checkVersion !== 'string' || !input.checkVersion.trim())
    throw new EngineError('keeper_block_pair_source_invalid', 'An explicit check version is required');
  const artifact = readKeeperBlockSourceAt(store, input.project, input.blockSourceRef);
  const constitution = await readKeeperConstitutionSourceAt(store, input.project, input.manifestRef);
  const pair = decodeKeeperPair({ key: { contract: KEEPER_CHECK_KEY_CONTRACT, projectId: input.project,
    artifact: artifact.address, constitution: constitution.address, checkVersion: input.checkVersion },
    artifact: { ref: artifact.address.container, value: artifact.container.value },
    constitution: { ref: constitution.address.container, value: constitution.container.value } });
  return structuredClone({ artifact, constitution, pair, checkId: keeperCheckKey(pair.key) });
}

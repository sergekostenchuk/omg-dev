import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Store } from '../storage/store.js';
import { KEEPER_CHECK_KEY_CONTRACT, keeperCheckKey } from './keeper.js';
import { decodeKeeperPair, type KeeperPair } from './keeper-result.js';
import { readKeeperArtifactSourceAt, type KeeperArtifactSource } from './keeper-artifact-source.js';
import { readKeeperConstitutionSourceAt, type KeeperConstitutionSource } from './keeper-constitution-source.js';

export interface KeeperPairSource {
  artifact: KeeperArtifactSource;
  constitution: KeeperConstitutionSource;
  pair: KeeperPair;
  checkId: string;
}

/** A proven stage artifact × accepted Discovery constitution; no caller pair or mark supplies either proof. */
export async function readKeeperPairSourceAt(store: Store, project: string, artifactRef: unknown,
  manifestRef: unknown, checkVersion: string): Promise<KeeperPairSource> {
  let input: { artifactRef: unknown; manifestRef: unknown; checkVersion: string };
  try { input = JSON.parse(canonical({ artifactRef, manifestRef, checkVersion })); }
  catch { throw new EngineError('keeper_pair_source_invalid', 'Expected exact JSON source references and a check version'); }
  const artifact = await readKeeperArtifactSourceAt(store, project, input.artifactRef);
  const constitution = await readKeeperConstitutionSourceAt(store, project, input.manifestRef);
  const pair = decodeKeeperPair({ key: { contract: KEEPER_CHECK_KEY_CONTRACT, projectId: project,
    artifact: artifact.address, constitution: constitution.address, checkVersion: input.checkVersion },
  artifact: { ref: artifact.address.container, value: artifact.container.value },
  constitution: { ref: constitution.address.container, value: constitution.container.value } });
  return structuredClone({ artifact, constitution, pair, checkId: keeperCheckKey(pair.key) });
}

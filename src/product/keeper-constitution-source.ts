import { EngineError } from '../errors.js';
import { reference } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { readAcceptedDiscoveryManifestAt, type AcceptedFinalBundle } from '../discovery/discovery-acceptance.js';
import type { DiscoveryManifest } from '../discovery/discovery-manifest.js';
import type { V7FinalBundle } from '../discovery/v7-final-contracts.js';
import type { KeeperAddress } from './keeper.js';

/** The manifest proves acceptance; the address names the constitution inside the whole saved bundle container. */
export interface KeeperConstitutionSource {
  manifest: Revision<DiscoveryManifest>;
  container: Revision<AcceptedFinalBundle>;
  address: KeeperAddress & { pointer: '/bundle/constitution' };
  constitution: NonNullable<V7FinalBundle['constitution']>;
}

/** Historical, read-only source for Keeper 9.1. The shared acceptance reader snapshots the external Ref once and proves
 * the exact manifest, admission, paid assessment and complete container. No caller verification flag or current head
 * substitutes for that proof. A lawful negative Discovery remains accepted, but supplies no constitution to Keeper. */
export async function readKeeperConstitutionSourceAt(store: Store, project: string, manifestRef: unknown): Promise<KeeperConstitutionSource> {
  const accepted = await readAcceptedDiscoveryManifestAt(store, project, manifestRef);
  const constitution = accepted.bundle.value.bundle.constitution;
  if (constitution === null)
    throw new EngineError('keeper_constitution_absent', 'The accepted Discovery bundle has no constitution',
      { manifest: reference(accepted.manifest), bundle: reference(accepted.bundle) });
  return structuredClone({ manifest: accepted.manifest, container: accepted.bundle,
    address: { container: reference(accepted.bundle), pointer: '/bundle/constitution' as const }, constitution: structuredClone(constitution) });
}

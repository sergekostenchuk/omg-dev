import { canonical, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, stageId, STAGES, type StageArtifact } from '../pipeline/contracts.js';
import type { AcceptedStageArtifact } from '../pipeline/pipeline.js';
import type { Revision, Store } from '../storage/store.js';
import type { KeeperAddress } from './keeper.js';
import { StageChecks } from './stage-checks.js';

export interface KeeperArtifactSource {
  acceptance: AcceptedStageArtifact;
  container: Revision<StageArtifact>;
  address: KeeperAddress & { pointer: '/content' };
  content: Json;
}

/** The complete content of one historically accepted stage, never a caller-selected subfield or today's head. */
export async function readKeeperArtifactSourceAt(store: Store, project: string, artifactRef: unknown): Promise<KeeperArtifactSource> {
  let at: unknown;
  try { at = JSON.parse(canonical(artifactRef)); }
  catch { throw new EngineError('keeper_artifact_source_invalid', 'Expected one exact JSON artifact Ref'); }
  if (!isRef(at) || Object.keys(at).sort().join(',') !== 'hash,id,revision')
    throw new EngineError('keeper_artifact_source_invalid', 'Expected the closed exact artifact Ref');
  const stage = STAGES.find(candidate => at.id === stageId(project, candidate));
  if (!stage) throw new EngineError('keeper_artifact_source_invalid', 'The artifact belongs to another project or is not a stage');
  const acceptance = await new StageChecks(store).pipeline.readAcceptedStageArtifactAt(project, stage, at);
  return structuredClone({ acceptance, container: acceptance.artifact,
    address: { container: reference(acceptance.artifact), pointer: '/content' as const },
    content: structuredClone(acceptance.artifact.value.content) });
}

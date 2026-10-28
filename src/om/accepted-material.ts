import { hasBasisApplications, hasManifestBasisApplications } from '../discovery/projection-reader.js';
import { canonical, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, stageId, type Ref, type StageArtifact } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import type { DiscoveryDraft } from '../discovery/discovery.js';
import { requireDiscoveryHandoff, withDiscoveryHandoffAt } from '../discovery/discovery-handoff.js';
import type { AcceptedDiscoveryProjection } from '../discovery/discovery-accepted-projection.js';
import { readOmInput, readAcceptedUpstreamStageAt, type OmInput } from './input.js';
import { readRecord } from './refs.js';
import type { OmResult } from './refusal.js';

const exact = ({ id, revision, hash }: Ref): Ref => ({ id, revision, hash });
const take = <T>(value: OmResult<T>): T => {
  if (!value.ok) throw new EngineError(value.refusal.code, value.refusal.message, value.refusal.at);
  return value.value;
};
function invalid(condition: unknown, input: Ref, message: string): asserts condition {
  if (!condition) throw new EngineError('om_accepted_material_invalid', message, { unit: 'G1', target: input.id, ref: input });
}
function acceptedInput(store: Store, project: string, at: Ref): OmInput {
  const row = take(readOmInput(store, project, at));
  const body = row.value as { input?: unknown } | null;
  const input = body?.input as OmInput | undefined;
  invalid(input && typeof input === 'object' && Array.isArray(input.sources)
    && input.sources.every(source => source && isRef(source) && typeof source.stage === 'string'), at,
  'The saved input must retain its explicit exact source list');
  return structuredClone(input);
}
function featuresAt(store: Store, project: string, input: OmInput, at: Ref) {
  const sources = input.sources.filter(source => source.stage === 'features');
  invalid(sources.length === 1, at, 'The accepted input names one exact features source');
  return take(readRecord<StageArtifact>(store, sources[0]!, {
    unit: 'G1', target: at.id, id: stageId(project, 'features'), kind: 'stage' }));
}
export interface OmAcceptedMaterial {
  accepted: { stage: string; ref: Ref; fields: Record<string, Json> }[];
  discovery?: AcceptedDiscoveryProjection;
}
/** Shared E4/G5 material. The input and its real accepted prefix determine the source; a scope alone grants nothing. */
export function readOmAcceptedMaterial(store: Store, project: string, inputRef: Ref): OmAcceptedMaterial {
  const input = acceptedInput(store, project, inputRef);
  const feature = featuresAt(store, project, input, inputRef);
  const content = feature.value?.content as unknown as { draft?: Ref; discoveryHandoff?: unknown } | null;
  const manifestForm = Object.hasOwn(input, 'discovery') || input.sources.some(source => source.sourceKind === 'accepted-manifest')
    || !!content && Object.hasOwn(content, 'discoveryHandoff');
  let discovery: AcceptedDiscoveryProjection | undefined;
  if (manifestForm) {
    invalid(content && isRef(content.draft), inputRef, 'The manifest input retains its exact features draft');
    const draft = take(readRecord<DiscoveryDraft>(store, content.draft, { unit: 'G1', target: inputRef.id, id: content.draft.id, kind: 'discovery-draft' }));
    const handoff = requireDiscoveryHandoff(store, structuredClone(draft.value) as DiscoveryDraft);
    invalid(input.sources.length === 5, inputRef, 'A manifest input has one root and four actual stages');
    const root = input.sources.filter(source => source.stage === 'discovery');
    invalid(root.length === 1 && root[0]!.sourceKind === 'accepted-manifest'
      && canonical(exact(root[0]!)) === canonical(handoff.source.manifest)
      && input.discovery?.contract === 'discovery-om-handoff/v1'
      && canonical(input.discovery.manifest) === canonical(handoff.source.manifest)
      && canonical(input.discovery.bundle) === canonical(handoff.source.bundle), inputRef,
    'The input root and the accepted features binding must name the same exact manifest and bundle');
    const proven = readAcceptedUpstreamStageAt(store, project, 'features', reference(feature));
    let next = proven.artifact;
    for (const stage of ['features', 'specification', 'operation-map', 'concept'] as const) {
      const refs = input.sources.filter(source => source.stage === stage);
      invalid(refs.length === 1 && canonical(exact(refs[0]!)) === canonical(reference(next)), inputRef,
        'Every input stage must belong to the proved accepted prefix');
      if (stage !== 'concept') next = take(readRecord<StageArtifact>(store, next.value.inputs[0]!, {
        unit: 'G1', target: inputRef.id, id: next.value.inputs[0]!.id, kind: 'stage' })) as typeof next;
    }
    invalid(canonical(next.value.inputs) === canonical([handoff.source.manifest]), inputRef,
      'The concept root must retain the proved manifest');
    discovery = handoff.source;
  }
  const accepted = input.sources.flatMap(source => {
    if (source.stage === 'discovery' && discovery) return [];
    const row = take(readRecord<StageArtifact>(store, source, { unit: 'G1', target: inputRef.id,
      id: stageId(project, source.stage), kind: 'stage' }));
    const fields = (row.value?.content as { fields?: Record<string, Json> } | null)?.fields;
    invalid(fields && typeof fields === 'object' && !Array.isArray(fields), inputRef, 'Accepted stages retain their fields');
    return [{ stage: source.stage, ref: reference(row), fields: structuredClone(fields) }];
  });
  return structuredClone({ accepted, ...(discovery ? { discovery } : {}) });
}
/** Cold external entry: snapshot the exact input, recover its historical draft, then let C1 prove it for this operation. */
export async function withOmAcceptedMaterialAt<T>(store: Store, project: string, inputRef: Ref, work: () => T): Promise<Awaited<T>> {
  let request: { project: string; inputRef: Ref };
  try { request = JSON.parse(canonical({ project, inputRef })); }
  catch { throw new EngineError('om_accepted_material_invalid', 'Expected an exact JSON input reference'); }
  const input = acceptedInput(store, request.project, request.inputRef);
  const feature = featuresAt(store, request.project, input, request.inputRef);
  const content = feature.value?.content as unknown as { draft?: Ref; discoveryHandoff?: unknown } | null;
  const manifestForm = Object.hasOwn(input, 'discovery') || input.sources.some(source => source.sourceKind === 'accepted-manifest')
    || !!content && Object.hasOwn(content, 'discoveryHandoff');
  const consume = () => { readOmAcceptedMaterial(store, request.project, request.inputRef); return work(); };
  if (!manifestForm) return consume() as Awaited<T>;
  invalid(content && isRef(content.draft), request.inputRef, 'The manifest input retains its exact features draft');
  return withDiscoveryHandoffAt(store, request.project, content.draft, consume);
}

export function hasOmBasisApplications(store: Store, project: string, inputRef: Ref): boolean {
  const input = acceptedInput(store, project, inputRef);
  if (!Object.hasOwn(input, 'discovery') && !input.sources.some(source => source.sourceKind === 'accepted-manifest'))
    return hasBasisApplications(input.sources);
  const material = readOmAcceptedMaterial(store, project, inputRef);
  return !!material.discovery && hasManifestBasisApplications(input.sources, material.discovery.manifest);
}

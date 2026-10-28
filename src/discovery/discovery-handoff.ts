import { AsyncLocalStorage } from 'node:async_hooks';
import { canonical, hashJson, type Json } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { isRef, reference, type Ref, type Stage } from '../pipeline/contracts.js';
import type { Store, Revision } from '../storage/store.js';
import type { RunControlHold } from '../om/run-control.js';
import type { DiscoveryDraft } from './discovery.js';
import { readAcceptedDiscoveryProjectionAt, type AcceptedDiscoveryProjection } from './discovery-accepted-projection.js';
import type { BasisCatalogueEntry } from './basis-application.js';
import { adaptDiscoveryConsumerProjection, type DiscoveryConsumerProjection, type DiscoveryConsumer } from './discovery-consumer-projection.js';

export interface DiscoveryHandoffBinding {
  contract: 'discovery-handoff/v1'; project: string; stage: Stage; draft: string; manifest: Ref;
}
/** v2 addresses the accepted bundle/member themselves, never an unsaved catalogue. */
export interface AcceptedDiscoveryBasisCatalogue {
  contract: 'discovery-basis-catalogue/v2'; source: Ref; constraints: BasisCatalogueEntry[]; variant: BasisCatalogueEntry;
}
export function acceptedDiscoveryBasisCatalogue(source: AcceptedDiscoveryProjection): AcceptedDiscoveryBasisCatalogue {
  requireCondition('constraints' in source.projection.value && source.selectedVariant !== null,
    'discovery_basis_catalogue_invalid', 'The accepted projection needs constraints and its chosen variant');
  const member = source.selectedVariant.member;
  return structuredClone({ contract: 'discovery-basis-catalogue/v2', source: source.manifest,
    constraints: source.projection.value.constraints.map((value, index) => ({
      address: { record: structuredClone(source.bundle), pointer: `/bundle/projection/constraints/${index}` }, value: structuredClone(value) as unknown as Json })),
    variant: { address: { record: member.address.container, pointer: member.address.pointer }, value: member.value } });
}
export interface DiscoveryHandoff {
  binding: DiscoveryHandoffBinding; source: AcceptedDiscoveryProjection; catalogue: AcceptedDiscoveryBasisCatalogue;
}
export function hasDiscoveryHandoff(store: Store, draft: DiscoveryDraft): boolean {
  if (Object.hasOwn(draft, 'discoveryHandoff')) return true;
  const question = typeof draft.questions?.[0] === 'string' ? store.get<{draftId: string}>(draft.questions[0]) : null;
  const first = question ? store.get<DiscoveryDraft>(question.value.draftId, 1) : null;
  return !!first && Object.hasOwn(first.value, 'discoveryHandoff');
}
function checkBinding(store: Store, draft: DiscoveryDraft): DiscoveryHandoffBinding {
  const binding = draft.discoveryHandoff;
  requireCondition(binding && binding.contract === 'discovery-handoff/v1'
    && Object.keys(binding).sort().join(',') === 'contract,draft,manifest,project,stage'
    && binding.project === draft.projectId && binding.stage === draft.stage
    && typeof binding.draft === 'string' && isRef(binding.manifest)
    && Object.keys(binding.manifest).sort().join(',') === 'hash,id,revision',
    'discovery_handoff_invalid', 'The downstream draft needs its closed exact Discovery binding');
  const first = store.get<DiscoveryDraft>(binding.draft, 1);
  requireCondition(first?.kind === 'discovery-draft' && first.value.projectId === draft.projectId
    && first.value.stage === draft.stage && canonical(first.value.discoveryHandoff) === canonical(binding),
    'discovery_handoff_invalid', 'The initial draft binding is missing, foreign or changed');
  return binding;
}
function exactDraft(store: Store, project: string, at: unknown): Revision<DiscoveryDraft> {
  requireCondition(isRef(at) && Object.keys(at).sort().join(',') === 'hash,id,revision',
    'discovery_handoff_invalid', 'Expected an exact downstream draft Ref');
  const row = store.get<DiscoveryDraft>(at.id, at.revision);
  requireCondition(row?.kind === 'discovery-draft' && canonical(reference(row)) === canonical(at)
    && hashJson(row.value) === at.hash && row.value.projectId === project,
    'discovery_handoff_invalid', 'The downstream draft is absent, foreign or differs from its Ref');
  return row;
}
export async function readDiscoveryHandoffAt(store: Store, project: string, draft: unknown): Promise<DiscoveryHandoff> {
  const row = exactDraft(store, project, JSON.parse(canonical(draft)));
  const binding = structuredClone(checkBinding(store, row.value));
  const source = await readAcceptedDiscoveryProjectionAt(store, project, binding.manifest);
  return { binding, source, catalogue: acceptedDiscoveryBasisCatalogue(source) };
}
// Operation-local proof, not a cache or a saved authorization. Every external cold entry runs C1 first.
const scope = new AsyncLocalStorage<{ database: string; handoff: DiscoveryHandoff }>();
export async function withDiscoveryHandoffAt<T>(store: Store, project: string, draft: Ref, work: () => T): Promise<Awaited<T>> {
  const handoff = await readDiscoveryHandoffAt(store, project, draft);
  return scope.run({ database: store.databaseId, handoff }, work) as Awaited<T>;
}
export function requireDiscoveryHandoff(store: Store, draft: DiscoveryDraft): DiscoveryHandoff {
  const binding = checkBinding(store, draft), current = scope.getStore();
  requireCondition(current && current.database === store.databaseId && current.handoff.binding.project === draft.projectId
    && canonical(current.handoff.binding.manifest) === canonical(binding.manifest),
    'discovery_handoff_proof_required', 'Enter through the asynchronous Discovery handoff reader before consuming this bound draft');
  return structuredClone({ ...current.handoff, binding });
}
export function discoveryConsumerForDraft(store: Store, draft: DiscoveryDraft, consumer: DiscoveryConsumer = draft.stage as DiscoveryConsumer): DiscoveryConsumerProjection | null {
  if (!hasDiscoveryHandoff(store, draft)) return null;
  return adaptDiscoveryConsumerProjection(requireDiscoveryHandoff(store, draft).source, consumer);
}
export function hasDiscoveryHandoffScope(store: Store, draft: DiscoveryDraft): boolean {
  if (!hasDiscoveryHandoff(store, draft)) return true;
  const current = scope.getStore();
  return !!current && current.database === store.databaseId
    && canonical(current.handoff.binding.manifest) === canonical(checkBinding(store, draft).manifest);
}
/** Create the downstream draft and its immutable manifest binding in the ordinary draft transaction. */
export async function prepareDiscoveryHandoff(store: Store, input: {
  project: string; stage: 'concept' | 'operation-map' | 'specification' | 'features'; manifest: Ref; inputs: Ref[];
}, hold?: RunControlHold): Promise<Revision<DiscoveryDraft>> {
  const request = JSON.parse(canonical(input)) as typeof input;
  const held = hold === undefined ? undefined : JSON.parse(canonical(hold)) as RunControlHold;
  requireCondition(Object.keys(request).sort().join(',') === 'inputs,manifest,project,stage'
    && ['concept', 'operation-map', 'specification', 'features'].includes(request.stage) && Array.isArray(request.inputs)
    && request.inputs.every(isRef), 'discovery_handoff_invalid', 'The handoff requires a closed consumer preparation request');
  const source = await readAcceptedDiscoveryProjectionAt(store, request.project, request.manifest);
  acceptedDiscoveryBasisCatalogue(source);
  if (request.stage !== 'concept') adaptDiscoveryConsumerProjection(source, request.stage);
  const { Discovery } = await import('./discovery.js');
  const { STAGES } = await import('../pipeline/contracts.js');
  // C1 needs the full historical Store; only the new draft transaction uses the run-control write gate.
  const writer = held === undefined ? store : new (await import('../om/run-control.js')).RunControlGate(store, request.project, held).view();
  return new Discovery(writer).forStage(request.project, request.stage, STAGES[STAGES.indexOf(request.stage) + 1]!,
    request.inputs, undefined, source.manifest);
}
/** Actual saved grounds for stage validators/closures. This function never proves acceptance from these Refs alone. */
export function discoveryHandoffGrounds(store: Store, draft: DiscoveryDraft): Ref[] {
  const { source } = requireDiscoveryHandoff(store, draft);
  const g = source.grounds;
  return structuredClone([...new Map([source.manifest, source.bundle, g.draft, g.frame, g.plan, g.dossier, g.paidFinal,
    g.assessment, g.admission.record, ...g.resolutions].map(ref => [canonical(ref), ref])).values()]);
}
/** Narrow synchronous consumer projection inside the current already-proved operation. */
export function scopedDiscoveryProjection(view: { readonly databaseId?: string }, project: string): AcceptedDiscoveryProjection | null {
  const current = scope.getStore();
  return current && current.database === view.databaseId && current.handoff.binding.project === project
    ? structuredClone(current.handoff.source) : null;
}

import type { Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import type { ClaimAddress } from './claim-address.js';
import { readAcceptedDiscoveryManifestAt } from './discovery-acceptance.js';
import type { V7FinalPositiveBundle } from './v7-final-contracts.js';

/** A pointer into the value of the exact saved record, not a new or computed Ref. */
export interface AcceptedProjectionValue<T> { address: { container: Ref; pointer: string }; value: T }
export interface AcceptedDiscoveryProjection {
  contract: 'discovery-accepted-projection/v1'; project: string;
  manifest: Ref; previous: Ref | null; bundle: Ref; form: V7FinalPositiveBundle['contract'];
  outcome: 'go' | 'conditional';
  verdict: AcceptedProjectionValue<V7FinalPositiveBundle['verdict']>;
  summary: AcceptedProjectionValue<V7FinalPositiveBundle['summary']>;
  projection: AcceptedProjectionValue<V7FinalPositiveBundle['projection']>;
  constitution: AcceptedProjectionValue<V7FinalPositiveBundle['constitution']>;
  selectedVariant: { member: AcceptedProjectionValue<Json>; set: Ref | null;
    decision: AcceptedProjectionValue<Json> | null } | null;
  /** The contents and classification of claims already resolved inside Discovery; no dossier or transport schema. */
  claims: { address: ClaimAddress; value: Json; status: 'accepted' | 'rejected' | 'unassessed' }[];
  conditions: { resolved: string[]; open: string[] };
  grounds: { draft: Ref; frame: Ref; plan: Ref; dossier: Ref; paidFinal: Ref; assessment: Ref;
    admission: { kind: 'owner' | 'machine'; record: Ref }; resolutions: Ref[] };
}
function addressed<T>(container: Ref, pointer: string, value: T): AcceptedProjectionValue<T> {
  return { address: { container: structuredClone(container), pointer }, value: structuredClone(value) };
}

/** C1 / ndisc.d8.n7: one read-only consumer door. The common historical acceptance reader snapshots the external Ref,
 * proves the paid final and assessment, admission and every edition/resolution. This module does not prove acceptance
 * again or follow a successor/head. An accepted negative or still-conditional result is not permission to consume a
 * product projection. Old v7/v8 projections keep their actual fields; only v9 contains the complete A1 structure.
 * All content comes from that single proven result, including resolved claims and the chosen variant. */
export async function readAcceptedDiscoveryProjectionAt(store: Store, project: string,
  manifest: unknown): Promise<AcceptedDiscoveryProjection> {
  const accepted = await readAcceptedDiscoveryManifestAt(store, project, manifest);
  const bundle = accepted.bundle.value.bundle, bundleRef = reference(accepted.bundle), manifestRef = reference(accepted.manifest);
  if (!['go', 'conditional'].includes(bundle.verdict.outcome) || bundle.projection === null || bundle.constitution === null)
    throw new EngineError('discovery_projection_unavailable', 'The accepted Discovery outcome has no product projection',
      { manifest: manifestRef, bundle: bundleRef, outcome: bundle.verdict.outcome, reason: bundle.verdict.reason,
        target: { container: bundleRef, pointer: '/bundle/verdict' } });
  if (accepted.conditions.open.length)
    throw new EngineError('discovery_projection_conditions_open', 'The exact accepted edition still has unresolved conditions',
      { manifest: manifestRef, bundle: bundleRef, outcome: bundle.verdict.outcome, conditions: structuredClone(accepted.conditions),
        targets: accepted.conditions.open.map(id => ({ conditionId: id, container: structuredClone(bundleRef),
          pointer: `/bundle/verdict/conditions/${bundle.verdict.conditions.findIndex(condition =>
            (condition as { id: string }).id === id)}` })) });
  const packet = accepted.grounds.source.packet.final, route = packet.dossier.route;
  return {
    contract: 'discovery-accepted-projection/v1', project,
    manifest: manifestRef, previous: structuredClone(accepted.manifest.value.previous), bundle: bundleRef, form: bundle.contract,
    outcome: bundle.verdict.outcome,
    verdict: addressed(bundleRef, '/bundle/verdict', bundle.verdict),
    summary: addressed(bundleRef, '/bundle/summary', bundle.summary),
    projection: addressed(bundleRef, '/bundle/projection', bundle.projection),
    constitution: addressed(bundleRef, '/bundle/constitution', bundle.constitution),
    selectedVariant: route.member ? { member: addressed(route.member.ref, '', route.member.value),
      set: route.set ? structuredClone(route.set.ref) : null,
      decision: route.decision ? addressed(route.decision.ref, '', route.decision.value) : null } : null,
    claims: packet.dossier.materials.map(material => ({ address: structuredClone(material.address),
      value: structuredClone(material.value), status: material.status })),
    conditions: structuredClone(accepted.conditions),
    grounds: { draft: structuredClone(accepted.grounds.draft), frame: structuredClone(packet.subject.basis.frame),
      plan: structuredClone(packet.subject.basis.plan), dossier: structuredClone(bundle.dossier),
      paidFinal: structuredClone(accepted.grounds.paid), assessment: structuredClone(accepted.grounds.assessment),
      admission: { kind: accepted.admission.kind, record: reference(accepted.admission.record) },
      resolutions: accepted.resolutions.map(reference) },
  };
}

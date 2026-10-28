import type { Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import { readAcceptedDiscoveryProjectionAt, type AcceptedDiscoveryProjection,
  type AcceptedProjectionValue } from './discovery-accepted-projection.js';
import type { FinalProductProjection } from './discovery-final-projection.js';
import { V9_FINAL_CONTRACT } from './v7-final-contracts.js';

export const DISCOVERY_CONSUMERS = ['operation-map', 'specification', 'features', 'om-g2'] as const;
export type DiscoveryConsumer = typeof DISCOVERY_CONSUMERS[number];
/** The preparation fields actually read downstream. Missing problem/existingSituation are not invented from a v9 summary. */
export interface ConsumerPreparation {
  actors: FinalProductProjection['actors']; outcomes: FinalProductProjection['outcomes']; journeys: FinalProductProjection['journeys'];
  constraints: { id: string; rule: string; basis: string }[];
  externalSystems: { id: string; purpose: string; inputs: string[]; outputs: string[]; availability: string }[];
  risks: { id: string; consequence: string; affectedOutcome: string; mitigation: string }[];
  unknowns: { id: string; question: string; consumer: string; blocksCurrentStage: boolean; resolution: string;
    moment: FinalProductProjection['unknowns'][number]['moment'] }[];
}
export type ConsumerUnknown = FinalProductProjection['unknowns'][number] & {
  source: { record: Ref; pointer: string };
};
export interface DiscoveryConsumerProjection {
  contract: 'discovery-consumer-projection/v1'; project: string; consumer: DiscoveryConsumer;
  manifest: Ref; bundle: Ref; grounds: AcceptedDiscoveryProjection['grounds'];
  preparation: ConsumerPreparation;
  /** Original full values and grounds, alongside the limited preparation representation required by old builders. */
  material: {
    summary: AcceptedDiscoveryProjection['summary']; constitution: AcceptedDiscoveryProjection['constitution'];
    selectedVariant: AcceptedDiscoveryProjection['selectedVariant'];
    constraints: AcceptedProjectionValue<FinalProductProjection['constraints']>;
    externalSystems: AcceptedProjectionValue<FinalProductProjection['externalSystems']>;
    risks: AcceptedProjectionValue<FinalProductProjection['risks']>;
    claims: AcceptedDiscoveryProjection['claims']; unknowns: ConsumerUnknown[];
  };
}
function item<T>(bundle: Ref, pointer: string, value: T): AcceptedProjectionValue<T> {
  return { address: { container: structuredClone(bundle), pointer }, value: structuredClone(value) };
}
export function adaptDiscoveryConsumerProjection(source: AcceptedDiscoveryProjection, consumer: DiscoveryConsumer): DiscoveryConsumerProjection {
  if (source.form !== V9_FINAL_CONTRACT || !('actors' in source.projection.value))
    throw new EngineError('discovery_consumer_projection_incomplete', 'This accepted version has no full downstream product projection',
      { manifest: source.manifest, form: source.form, consumer, return: { destination: 'D7' } });
  const p = source.projection.value;
  const risks = p.risks.map((risk, index) => {
    if (!('outcome' in risk.affectedOutcome))
      throw new EngineError('discovery_consumer_risk_outcome_unresolved', 'The risk needs an accepted product outcome before preparation',
        { manifest: source.manifest, consumer, riskId: risk.id, unknownId: risk.affectedOutcome.unknown,
          target: { container: source.bundle, pointer: `/bundle/projection/risks/${index}/affectedOutcome` },
          return: { destination: 'D7', requiredResult: 'An accepted edition binding this risk to a product outcome' } });
    return { id: risk.id, consequence: risk.consequence, affectedOutcome: risk.affectedOutcome.outcome,
      mitigation: 'text' in risk.mitigation ? risk.mitigation.text : `unknown:${risk.mitigation.unknown}` };
  });
  const preparation: ConsumerPreparation = {
    actors: structuredClone(p.actors), outcomes: structuredClone(p.outcomes), journeys: structuredClone(p.journeys),
    constraints: p.constraints.map(c => ({ id: c.id, rule: c.rule, basis: c.basis.map(b => b.content).join('\n') })),
    externalSystems: p.externalSystems.map(system => ({ id: system.id, purpose: system.purpose,
      inputs: [...system.inputs], outputs: [...system.outputs],
      availability: 'unknown' in system.availability.basis ? `unknown:${system.availability.basis.unknown}` : system.availability.text })),
    risks,
    unknowns: p.unknowns.map(u => ({ id: u.id, question: u.question, consumer: u.consumer,
      blocksCurrentStage: u.blocksCurrentStage, moment: u.moment, resolution: u.closeCriterion })),
  };
  return { contract: 'discovery-consumer-projection/v1', project: source.project, consumer,
    manifest: structuredClone(source.manifest), bundle: structuredClone(source.bundle), grounds: structuredClone(source.grounds), preparation,
    material: { summary: structuredClone(source.summary), constitution: structuredClone(source.constitution),
      selectedVariant: structuredClone(source.selectedVariant),
      constraints: item(source.bundle, '/bundle/projection/constraints', p.constraints),
      externalSystems: item(source.bundle, '/bundle/projection/externalSystems', p.externalSystems),
      risks: item(source.bundle, '/bundle/projection/risks', p.risks), claims: structuredClone(source.claims),
      unknowns: p.unknowns.map((u, index) => ({ ...structuredClone(u),
        source: { record: structuredClone(source.bundle), pointer: `/bundle/projection/unknowns/${index}` } })) } };
}

/** No payment, acceptance or semantic inference: the single C1 proof is converted for the named consumer. */
export async function readDiscoveryConsumerProjectionAt(store: Store, project: string, manifest: unknown,
  consumer: DiscoveryConsumer): Promise<DiscoveryConsumerProjection> {
  if (!(DISCOVERY_CONSUMERS as readonly unknown[]).includes(consumer))
    throw new EngineError('discovery_consumer_unknown', 'The requested consumer has no Discovery handoff', { consumer });
  return adaptDiscoveryConsumerProjection(await readAcceptedDiscoveryProjectionAt(store, project, manifest), consumer);
}
/** Builder input only; evidence/origins remain in the handoff material rather than acquiring old-schema meanings. */
export function consumerPreparationFields(handoff: DiscoveryConsumerProjection): Record<string, Json> {
  return { preparation: structuredClone(handoff.preparation) as unknown as Json };
}

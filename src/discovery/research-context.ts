import type { Store } from "../storage/store.js";
import { STAGES, reference, type StageArtifact } from "../pipeline/contracts.js";
import type { DiscoveryDraft } from "./discovery.js";
import type { Graph } from "../graph/model.js";
import type { Ref } from "../pipeline/contracts.js";
import { REFINEMENT_CONTRACT_VERSION, type TechnicalReport } from "../graph/research-contracts.js";
import { researchGapDeferred } from '../graph/research-scope.js';
import type { PlanDefect } from "../graph/plan-defects.js";
import { projectGraph } from "../graph/project.js";
import { layerRelationContext } from '../graph/layer-assembly.js';

/** The immediate accepted prerequisite carries the detailed handoff; older stages
 * supply identities needed for traceability, without duplicating every report. */
export function researchPrerequisites(store: Store, draft: DiscoveryDraft) {
  const stages = draft.inputs.flatMap(ref => {
    const record = store.get<StageArtifact>(ref.id, ref.revision);
    return record?.kind === "stage" && record.hash === ref.hash ? [record] : [];
  }).sort((left, right) => STAGES.indexOf(right.value.stage) - STAGES.indexOf(left.value.stage));
  const latest = stages[0];
  return stages.map(record => {
    const content = record.value.content as { fields?: Record<string, unknown> };
    const fields = content?.fields ?? {};
    const identities: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (name === "preparation" && value && typeof value === "object") {
        const preparation = value as Record<string, unknown>;
        identities[name] = { actors: preparation['actors'], outcomes: preparation['outcomes'], constraints: preparation['constraints'],
          ...(draft.stage === "operation-map" ? { journeys: preparation['journeys'] } : {}) };
      } else if (name === "conceptSections" && Array.isArray(value)) identities[name] = value;
    }
    return { ref: reference(record), stage: record.value.stage, fields: record === latest ? fields : identities };
  });
}

export function researchGraphContext(store: Store, draft: DiscoveryDraft) {
  if (draft.stage === "operation-map") {
    const graph = store.get<Graph>(`graph:${draft.projectId}`);
    return graph ? { ref: reference(graph), level: 1, graph: projectGraph(graph.value, 1),
      currentHorizon: [], research: [], failures: [], previousResearch: null, openGaps: [] } : null;
  }
  if (draft.stage !== "om-g2" || draft.level === "R0") return null;
  const level = draft.level === "R1" ? 1 : 2;
  const layer = store.get<{ projection: Graph }>(`graph-layer:${draft.projectId}:${level}`);
  if (!layer || !draft.inputs.some(ref => ref.id === layer.id && ref.revision === layer.revision && ref.hash === layer.hash)) return null;
  const graph = store.get<Graph>(`graph:${draft.projectId}`);
  const previous = draft.level === "R2" ? store.get<{ draft: Ref | null }>(`phase:${draft.projectId}:R2`) : null;
  const earlier = previous?.value.draft ? store.get<DiscoveryDraft>(previous.value.draft.id, previous.value.draft.revision) : null;
  const openGaps = earlier?.value.contractVersion === REFINEMENT_CONTRACT_VERSION ? Object.values(earlier.value.fields).flatMap(value => (value as unknown as TechnicalReport).gaps)
    .map(gap => ({ ...gap, deferred: Boolean(graph && researchGapDeferred(store, draft.projectId, graph.value, gap)) })) : [];
  const currentHorizon = graph?.value.nodes.filter(node => graph.value.horizon.includes(node.id))
    .map(node => ({ id: node.id, parent: node.parent, outcome: node.outcome, code: node.code })) ?? [];
  const research = draft.inputs.flatMap(ref => {
    const phase = store.get<{ draft: Ref | null }>(ref.id, ref.revision);
    if (phase?.kind !== "phase" || phase.hash !== ref.hash || !phase.value.draft) return [];
    const report = store.get<DiscoveryDraft>(phase.value.draft.id, phase.value.draft.revision);
    return report?.hash === phase.value.draft.hash && report.value.level === draft.level
      ? [{ ref: reference(report), fields: report.value.fields }] : [];
  });
  const failures = draft.inputs.flatMap(ref => {
    const defect = store.get<PlanDefect>(ref.id, ref.revision);
    return defect?.kind === "plan-defect" && defect.hash === ref.hash ? [{ ref, ...defect.value }] : [];
  });
  return { ref: reference(layer), level, graph: layer.value.projection, currentHorizon, research, failures,
    ...(draft.level === 'R2' && draft.consumer !== 'compilation' ? { relationContext: layerRelationContext(layer.value.projection, level) } : {}),
    previousResearch: earlier ? reference(earlier) : null, openGaps };
}

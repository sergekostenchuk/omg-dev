import type { Revision, Store } from "../storage/store.js";
import { STAGES, isRef, reference, stageId, type StageArtifact } from "../pipeline/contracts.js";
import type { DiscoveryDraft } from "./discovery.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import type { Graph } from "../graph/model.js";
import type { Ref } from "../pipeline/contracts.js";
import { REFINEMENT_CONTRACT_VERSION, type TechnicalReport } from "../graph/research-contracts.js";
import { researchGapDeferred } from '../graph/research-scope.js';
import type { PlanDefect } from "../graph/plan-defects.js";
import { projectGraph } from "../graph/project.js";
import { layerRelationContext } from '../graph/layer-assembly.js';
import { discoveryBasisCatalogue, type DiscoveryBasisCatalogue } from './discovery-outcome.js';

export interface DiscoveryBasisMaterial {
  source: Ref;
  catalogue: DiscoveryBasisCatalogue;
  guards: Ref[];
}

/** Read the one accepted Discovery stage named by this draft, never the current stage head. */
export function readDiscoveryBasisMaterial(store: Store, draft: DiscoveryDraft): DiscoveryBasisMaterial {
  const project = typeof draft?.projectId === 'string' && draft.projectId ? draft.projectId : null;
  const id = project === null ? 'discovery' : stageId(project, 'discovery');
  const fail = (field: string, message: string): never => {
    throw new EngineError('discovery_basis_catalogue_invalid', `[${id}] ${message}`, { target: id, field });
  };
  if (project === null || !Array.isArray(draft.inputs))
    return fail('inputs', 'The draft needs its project and exact accepted Discovery inputs');
  const refs = draft.inputs.filter(ref => ref?.id === id);
  if (refs.length !== 1) return fail('inputs', 'The draft needs exactly one accepted Discovery source');
  const ref = refs[0]!;
  if (!isRef(ref)) return fail('inputs', 'The Discovery source needs its full historical reference');
  const record = store.get<StageArtifact>(ref.id, ref.revision);
  if (!record || record.kind !== 'stage' || record.hash !== ref.hash || hashJson(record.value) !== record.hash
    || record.value.projectId !== project || record.value.stage !== 'discovery'
    || record.value.status !== 'accepted')
    return fail('inputs', 'The draft lost its exact accepted Discovery source');
  const content = record.value.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)
    || !Object.hasOwn(content, 'fields') || !content.fields || typeof content.fields !== 'object'
    || Array.isArray(content.fields))
    return fail('content.fields', 'The accepted Discovery fields are missing');
  const source = reference(record);
  return { source, catalogue: discoveryBasisCatalogue({ ref: source, fields: content.fields as Record<string, Json> }),
    guards: [{ ...source }] };
}

const MAP_RULES = [
  "Engine rule (buildL1): every Discovery preparation.outcomes[].id remains the id of a result artifact and the outcome of a success journey. Do not rename these results; additional intermediate artifacts are allowed.",
  "Engine rule: operationRequirements.outcomes[].outcome and conceptCoverage use the exact outcome and requirement identities in this catalogue. Actor references use the accepted actor ids. The engine supplies graph actors and requirements from these accepted stages.",
  "External entities have different meanings: preparation.externalSystems names a service or vendor; artifact.external=true describes a concrete runtime input with a producer outside the product; a documentary Source, including a web snapshot, is evidence for a claim. None proves either of the other two.",
  "A service dependency may affect a product block's responsibility, contract and failure path. Merely listing a service does not require one separate block or external artifact per service; documentation does not prove an available session, API response or runtime execution.",
] as const;

function operationMapMaterial(store: Store, draft: DiscoveryDraft) {
  const fail = (target: string, field: string, message: string): never => {
    throw new EngineError("operation_map_material_invalid", `[${target}] ${message}`, { target, field });
  };
  const accepted = (stage: "discovery" | "concept") => {
    const id = stageId(draft.projectId, stage), refs = draft.inputs.filter(ref => ref.id === id);
    if (refs.length !== 1) return fail(id, "inputs", "Map material needs exactly one accepted stage reference in its draft inputs");
    const ref = refs[0]!, record = store.get<StageArtifact>(ref.id, ref.revision);
    if (!record || record.kind !== "stage" || record.hash !== ref.hash || record.value.projectId !== draft.projectId
      || record.value.stage !== stage || record.value.status !== "accepted")
      return fail(id, "inputs", "Map material needs the exact accepted stage of this project");
    return record;
  };
  const discovery = accepted("discovery"), concept = accepted("concept");
  if (!concept.value.inputs.some(ref => canonical(ref) === canonical(reference(discovery))))
    return fail(concept.id, "inputs", "The concept and Discovery must belong to the same accepted stage chain");
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const fields = (record: typeof discovery) => {
    const content = record.value.content;
    if (!object(content) || !object(content['fields'])) return fail(record.id, "content.fields", "Map material needs the accepted stage fields");
    return content['fields'];
  };
  const preparation = fields(discovery)['preparation'];
  if (!object(preparation)) return fail(discovery.id, "preparation", "Map material needs Discovery preparation");
  const list = (value: unknown, target: string, field: string): Record<string, unknown>[] => {
    if (!Array.isArray(value) || !value.every(object)) return fail(target, field, "Map material needs its explicit accepted list");
    return value;
  };
  const text = (value: unknown, target: string, field: string): string => {
    if (typeof value !== "string" || !value.trim()) return fail(target, field, "Map identities must be nonempty accepted strings");
    return value;
  };
  const address = (record: typeof discovery, pointer: string) => ({ record: reference(record), pointer });
  const outcomes = list(preparation['outcomes'], discovery.id, "preparation.outcomes").map((value, index) => ({
    id: text(value['id'], discovery.id, `preparation.outcomes.${index}.id`),
    source: address(discovery, `/content/fields/preparation/outcomes/${index}`),
  }));
  const actors = list(preparation['actors'], discovery.id, "preparation.actors").map((value, index) => ({
    id: text(value['id'], discovery.id, `preparation.actors.${index}.id`),
    source: address(discovery, `/content/fields/preparation/actors/${index}`),
  }));
  const requirements = list(fields(concept)['conceptSections'], concept.id, "conceptSections").flatMap((section, sectionIndex) =>
    list(section['requirements'], concept.id, `conceptSections.${sectionIndex}.requirements`).map((value, index) => ({
      id: text(value['id'], concept.id, `conceptSections.${sectionIndex}.requirements.${index}.id`),
      outcome: text(value['outcome'], concept.id, `conceptSections.${sectionIndex}.requirements.${index}.outcome`),
      source: address(concept, `/content/fields/conceptSections/${sectionIndex}/requirements/${index}`),
    })));
  list(preparation['externalSystems'], discovery.id, "preparation.externalSystems");
  return { contract: "operation-map-material/v1", sources: { discovery: reference(discovery), concept: reference(concept) },
    catalogue: { outcomes, actors, requirements }, engineRules: { origin: "engine-rule", rules: [...MAP_RULES] } };
}

const UNKNOWN_RULE = 'Accepted Discovery unknowns with their consumer and moment. A later moment does not resolve an unknown now:'
  + ' a claim this stage needs from it stays an explicit unknown (need_research), never an assumption; an assessor does not support'
  + ' an answer that assumes it.';
/** UNK1 (№4686 §3 п.4): the accepted Discovery unknowns, each at its exact stage reference and pointer, for every early
 * stage after Discovery. Whether one affects this stage is the analyst's and assessor's judgement, not the engine's. */
function discoveryUnknowns(record: Revision<StageArtifact>) {
  const preparation = ((record.value.content as { fields?: Record<string, unknown> })?.fields ?? {})['preparation'];
  const rows = preparation && typeof preparation === "object" ? (preparation as Record<string, unknown>)['unknowns'] : undefined;
  if (!Array.isArray(rows)) return undefined;
  return { rule: UNKNOWN_RULE, items: rows.map((row, index) => ({ ...(row as Record<string, unknown>),
    source: { record: reference(record), pointer: `/content/fields/preparation/unknowns/${index}` } })) };
}

/** The immediate accepted prerequisite carries the detailed handoff; older stages
 * supply identities needed for traceability, without duplicating every report. */
export function researchPrerequisites(store: Store, draft: DiscoveryDraft) {
  const stages = draft.inputs.flatMap(ref => {
    const record = store.get<StageArtifact>(ref.id, ref.revision);
    return record?.kind === "stage" && record.hash === ref.hash ? [record] : [];
  }).sort((left, right) => STAGES.indexOf(right.value.stage) - STAGES.indexOf(left.value.stage));
  const latest = stages[0];
  const mapMaterial = draft.stage === "operation-map" ? operationMapMaterial(store, draft) : null;
  return stages.map(record => {
    const content = record.value.content as { fields?: Record<string, unknown> };
    const fields = content?.fields ?? {};
    const identities: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (name === "preparation" && value && typeof value === "object") {
        const preparation = value as Record<string, unknown>;
        identities[name] = { actors: preparation['actors'], outcomes: preparation['outcomes'], constraints: preparation['constraints'],
          ...(draft.stage === "operation-map" ? { journeys: preparation['journeys'], externalSystems: preparation['externalSystems'] } : {}) };
      } else if (name === "conceptSections" && Array.isArray(value)) identities[name] = value;
    }
    const unknowns = record.value.stage === "discovery" && ["concept", "operation-map", "specification", "features"].includes(draft.stage)
      ? discoveryUnknowns(record) : undefined;
    return { ref: reference(record), stage: record.value.stage, fields: record === latest ? fields : identities,
      ...(mapMaterial && record.value.stage === "concept" ? { operationMapMaterial: mapMaterial } : {}),
      ...(unknowns ? { unknowns } : {}) };
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

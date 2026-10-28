import { requireDiscoveryHandoff, hasDiscoveryHandoff, discoveryConsumerForDraft, withDiscoveryHandoffAt, type AcceptedDiscoveryBasisCatalogue } from './discovery-handoff.js';
import { consumerPreparationFields, type DiscoveryConsumerProjection } from './discovery-consumer-projection.js';
import { readV7PlanBasis } from './v7-plan-assessment.js';
import { hasV7PlanCoverage, isDiscoveryV7Draft } from './v7-contracts.js';
import type { Revision, Store } from "../storage/store.js";
import { STAGES, isRef, reference, stageId, type StageArtifact } from "../pipeline/contracts.js";
import type { DiscoveryDraft } from "./discovery.js";
import { readAnswer, readDraft, readQuestion, readStageArtifact } from "./projection-reader.js";
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
import { conceptApplicationFindings, selectedFeatureRequirements, specificationApplicationFindings } from './preparation-validation.js';
import type { BasisAddress } from './basis-application.js';

export interface DiscoveryBasisMaterial {
  source: Ref;
  catalogue: DiscoveryBasisCatalogue | AcceptedDiscoveryBasisCatalogue;
  guards: Ref[];
}

/** Read the one accepted Discovery stage named by this draft, never the current stage head. */
export function readDiscoveryBasisMaterial(store: Store, draft: DiscoveryDraft): DiscoveryBasisMaterial {
  if (hasDiscoveryHandoff(store, draft)) {
    const h = requireDiscoveryHandoff(store, draft);
    return { source: h.source.manifest, catalogue: h.catalogue, guards: [h.source.manifest, h.source.bundle] };
  }
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
  const record = readStageArtifact<StageArtifact>(store, ref.id, ref.revision);
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

export interface InheritanceProposal { field: 'mapDesign' | 'featurePreparation'; value: Json }

function operationMapMaterial(store: Store, draft: DiscoveryDraft, proposal?: InheritanceProposal) {
  const fail = (target: string, field: string, message: string): never => {
    throw new EngineError("operation_map_material_invalid", `[${target}] ${message}`, { target, field });
  };
  const accepted = (stage: "discovery" | "concept") => {
    const id = stageId(draft.projectId, stage), refs = draft.inputs.filter(ref => ref.id === id);
    if (refs.length !== 1) return fail(id, "inputs", "Map material needs exactly one accepted stage reference in its draft inputs");
    const ref = refs[0]!, record = readStageArtifact<StageArtifact>(store, ref.id, ref.revision);
    if (!record || record.kind !== "stage" || record.hash !== ref.hash || record.value.projectId !== draft.projectId
      || record.value.stage !== stage || record.value.status !== "accepted")
      return fail(id, "inputs", "Map material needs the exact accepted stage of this project");
    return record;
  };
  const handoff = discoveryConsumerForDraft(store, draft, 'operation-map');
  const discovery = handoff ? null : accepted("discovery"), concept = accepted("concept");
  const discoveryRef = handoff?.manifest ?? reference(discovery!);
  if (discovery && !concept.value.inputs.some(ref => canonical(ref) === canonical(discoveryRef)))
    return fail(concept.id, "inputs", "The concept and Discovery must belong to the same accepted stage chain");
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const fields = (record: Revision<StageArtifact>) => {
    const content = record.value.content;
    if (!object(content) || !object(content['fields'])) return fail(record.id, "content.fields", "Map material needs the accepted stage fields");
    return content['fields'];
  };
  const discoveryFields = handoff ? consumerPreparationFields(handoff) : fields(discovery!);
  const preparation = discoveryFields['preparation'];
  if (!object(preparation)) return fail(discoveryRef.id, "preparation", "Map material needs Discovery preparation");
  const list = (value: unknown, target: string, field: string): Record<string, unknown>[] => {
    if (!Array.isArray(value) || !value.every(object)) return fail(target, field, "Map material needs its explicit accepted list");
    return value;
  };
  const text = (value: unknown, target: string, field: string): string => {
    if (typeof value !== "string" || !value.trim()) return fail(target, field, "Map identities must be nonempty accepted strings");
    return value;
  };
  const address = (record: Revision<StageArtifact>, pointer: string) => ({ record: reference(record), pointer });
  const outcomes = list(preparation['outcomes'], discoveryRef.id, "preparation.outcomes").map((value, index) => ({
    id: text(value['id'], discoveryRef.id, `preparation.outcomes.${index}.id`),
    source: handoff ? { record: handoff.bundle, pointer: `/bundle/projection/outcomes/${index}` } : address(discovery!, `/content/fields/preparation/outcomes/${index}`),
  }));
  const actors = list(preparation['actors'], discoveryRef.id, "preparation.actors").map((value, index) => ({
    id: text(value['id'], discoveryRef.id, `preparation.actors.${index}.id`),
    source: handoff ? { record: handoff.bundle, pointer: `/bundle/projection/actors/${index}` } : address(discovery!, `/content/fields/preparation/actors/${index}`),
  }));
  const requirements = list(fields(concept)['conceptSections'], concept.id, "conceptSections").flatMap((section, sectionIndex) =>
    list(section['requirements'], concept.id, `conceptSections.${sectionIndex}.requirements`).map((value, index) => ({
      id: text(value['id'], concept.id, `conceptSections.${sectionIndex}.requirements.${index}.id`),
      outcome: text(value['outcome'], concept.id, `conceptSections.${sectionIndex}.requirements.${index}.outcome`),
      source: address(concept, `/content/fields/conceptSections/${sectionIndex}/requirements/${index}`),
    })));
  list(preparation['externalSystems'], discoveryRef.id, "preparation.externalSystems");
  const original = { contract: "operation-map-material/v1", sources: { discovery: discoveryRef, concept: reference(concept) },
    catalogue: { outcomes, actors, requirements }, engineRules: { origin: "engine-rule", rules: [...MAP_RULES] } };
  if (draft.contractVersion !== 6) return original;
  const grounds = acceptedConceptGrounds(discoveryRef, discoveryFields, reference(concept), fields(concept),
    handoff ? requireDiscoveryHandoff(store, draft).catalogue : undefined);
  const acceptedRequirements = acceptedDraftField(store, draft, 'operationRequirements');
  const coverage = (acceptedRequirements as Record<string, unknown> | null)?.['conceptCoverage'];
  if (proposal?.field === 'mapDesign' && (!object(proposal.value) || !Array.isArray(proposal.value['nodes'])))
    return inheritanceFailure('mapDesign', '/nodes', 'A proposed map needs its explicit blocks');
  const design = (proposal?.field === 'mapDesign' ? proposal.value
    : acceptedDraftField(store, draft, 'mapDesign')) as Record<string, unknown> | null;
  return { ...original, contract: "operation-map-material/v2", basis: {
    catalogue: grounds.catalogue, requirements: grounds.requirements,
    coverage: coveredRequirements(coverage, grounds.requirements),
    blocks: acceptedRequirements === null ? [] : implementedBlocks(design?.['nodes'], grounds.requirements, coverage),
    rule: 'An implements or conceptCoverage link carries the addressed requirement grounds into a block; the assessor still checks whether its responsibility and path actually honor them.',
  } };
}

type GroundedRequirement = { id: string; outcome: string; source: { record: Ref; pointer: string }; grounds: BasisAddress[] };
type GroundedContract = { id: string; outcome: string; source: { record: Ref; pointer: string };
  requirements: string[]; grounds: BasisAddress[] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const distinctAddresses = (addresses: BasisAddress[]) => [...new Map(addresses.map(address => [canonical(address), address])).values()];
const inheritanceFailure = (field: string, pointer: string, message: string): never => {
  throw new EngineError('basis_inheritance_material_invalid', message, { field, pointer });
};

/** Reopen retains the old draft value; only an exact answered prefix supplies a premise. */
function acceptedDraftField(store: Store, draft: DiscoveryDraft, field: string): Json | null {
  if (!Array.isArray(draft.questions))
    return inheritanceFailure(field, '/questions', 'The draft lost its ordered questions');
  let selected: Json | null = null;
  let pending = false;
  let draftId: string | null = null;
  for (const id of draft.questions) {
    const question = readQuestion(store, id);
    if (!question || question.kind !== 'question' || question.value.projectId !== draft.projectId
      || question.value.stage !== draft.stage || !question.value.spec?.field
      || (draftId !== null && question.value.draftId !== draftId))
      return inheritanceFailure(field, '/questions', 'The accepted prefix lost a bound question');
    draftId = question.value.draftId;
    if (pending || question.value.status !== 'answered') { pending = true; continue; }
    const ref = question.value.answer;
    const answer = isRef(ref) ? readAnswer<{ projectId: string; question: string;
      value?: Json; observation?: { value: Json } }>(store, ref) : null;
    const value = answer?.kind === 'fact' ? answer.value.observation?.value : answer?.value.value;
    if (!answer || !isRef(ref) || answer.hash !== ref.hash
      || (answer.kind !== question.value.spec.kind && answer.kind !== 'research-answer')
      || answer.value.projectId !== draft.projectId || answer.value.question !== id
      || value === undefined || !Object.hasOwn(draft.fields, question.value.spec.field)
      || canonical(value) !== canonical(draft.fields[question.value.spec.field]))
      return inheritanceFailure(question.value.spec.field, '/questions', 'The accepted prefix lost its exact answer');
    if (question.value.spec.field === field) selected = value;
  }
  return selected;
}

function acceptedConceptGrounds(discovery: Ref, discoveryFields: Record<string, unknown>, concept: Ref,
  conceptFields: Record<string, unknown>, supplied?: AcceptedDiscoveryBasisCatalogue) {
  const catalogue = supplied ?? discoveryBasisCatalogue({ ref: discovery, fields: discoveryFields as Record<string, Json> });
  const sections = conceptFields['conceptSections'];
  const finding = conceptApplicationFindings(sections as Json, catalogue)[0];
  if (finding) inheritanceFailure('conceptSections', finding.target, finding.message);
  const requirements: GroundedRequirement[] = [];
  for (const [sectionIndex, section] of (sections as Record<string, unknown>[]).entries())
    for (const [index, row] of (section['requirements'] as Record<string, unknown>[]).entries()) {
      if (typeof row['id'] !== 'string' || !row['id'] || typeof row['outcome'] !== 'string' || !row['outcome']
        || requirements.some(item => item.id === row['id']))
        return inheritanceFailure('conceptSections', `/${sectionIndex}/requirements/${index}`,
          'Accepted concept requirements need distinct identities and outcomes');
      requirements.push({ id: row['id'] as string, outcome: row['outcome'] as string,
        source: { record: concept, pointer: `/content/fields/conceptSections/${sectionIndex}/requirements/${index}` },
        grounds: distinctAddresses((row['applications'] as { basis: BasisAddress }[]).map(application => application.basis)) });
    }
  return { catalogue, requirements };
}

function coveredRequirements(value: unknown, requirements: GroundedRequirement[]) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return inheritanceFailure('operationRequirements', '/conceptCoverage', 'Coverage must be an explicit list');
  const seen = new Set<string>();
  return value.map((row: unknown, index: number) => {
    if (!object(row) || typeof row['requirement'] !== 'string' || typeof row['outcome'] !== 'string'
      || !requirements.some(item => item.id === row['requirement'] && item.outcome === row['outcome'])
      || seen.has(row['requirement']))
      return inheritanceFailure('operationRequirements', `/conceptCoverage/${index}`, 'Coverage names a foreign concept requirement');
    seen.add(row['requirement']);
    return { requirement: row['requirement'] as string, outcome: row['outcome'] as string };
  });
}

function implementedBlocks(value: unknown, requirements: GroundedRequirement[], coverage: unknown) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return inheritanceFailure('mapDesign', '/nodes', 'Map nodes must be an explicit list');
  const covered = new Set(coveredRequirements(coverage, requirements).map(row => row.requirement));
  return value.flatMap((row: unknown, index: number) => {
    if (!object(row) || row['kind'] !== 'block') return [];
    if (typeof row['id'] !== 'string' || !Array.isArray(row['implements'])
      || new Set(row['implements']).size !== row['implements'].length)
      return inheritanceFailure('mapDesign', `/nodes/${index}`, 'A block needs its identity and implements links');
    const linked = (row['implements'] as unknown[]).map(id => {
      const requirement = requirements.find(item => item.id === id);
      if (!requirement || !covered.has(requirement.id))
        return inheritanceFailure('mapDesign', `/nodes/${index}/implements`, 'A block link needs the covered concept requirement');
      return requirement;
    });
    return [{ id: row['id'], source: `/mapDesign/nodes/${index}`, requirements: linked.map(item => item.id),
      grounds: distinctAddresses(linked.flatMap(item => item.grounds)) }];
  });
}

/** The candidate's links are checked without filling any missing link from the catalogue. */
function selectedFeatures(prepared: unknown, rows: GroundedContract[]) {
  if (prepared === null || prepared === undefined) return [];
  if (!Array.isArray(prepared)) return inheritanceFailure('featurePreparation', '', 'Feature preparation must be an explicit list');
  return prepared.map((entry, index) => {
    if (!object(entry) || typeof entry['featureTitle'] !== 'string' || !Array.isArray(entry['behaviorContracts'])
      || (entry['behaviorContracts'] as unknown[]).some(id => typeof id !== 'string'))
      return inheritanceFailure('featurePreparation', `/${index}`, 'A feature needs its title and selected contract IDs');
    const chosenIds = entry['behaviorContracts'] as string[];
    if (new Set(chosenIds).size !== chosenIds.length)
      return inheritanceFailure('featurePreparation', `/${index}/behaviorContracts`, 'Selected contract IDs must be unique');
    const chosen = chosenIds.map(id => {
      const contract = rows.find(row => row.id === id);
      if (!contract) return inheritanceFailure('featurePreparation', `/${index}/behaviorContracts`, 'A feature selected a foreign contract');
      return contract;
    });
    const requirements = selectedFeatureRequirements(rows, chosen.map(row => row.id));
    if (!Array.isArray(entry['requirements']) || entry['requirements'].length !== requirements.length
      || new Set(entry['requirements']).size !== entry['requirements'].length
      || entry['requirements'].some(id => typeof id !== 'string' || !requirements.includes(id)))
      return inheritanceFailure('featurePreparation', `/${index}/requirements`, 'Feature requirements must be the exact selected contract union');
    return { title: entry['featureTitle'], contracts: chosen.map(row => row.id), requirements,
      grounds: distinctAddresses(chosen.flatMap(row => row.grounds)) };
  });
}

function featureBasisMaterial(store: Store, draft: DiscoveryDraft, proposal?: InheritanceProposal) {
  const read = (stage: 'discovery' | 'concept' | 'operation-map' | 'specification') => {
    const id = stageId(draft.projectId, stage), refs = draft.inputs.filter(ref => ref.id === id);
    if (refs.length !== 1 || !isRef(refs[0])) return inheritanceFailure(stage, '/inputs', `Features need one exact accepted ${stage} source`);
    const ref = refs[0]!, record = readStageArtifact<StageArtifact>(store, ref.id, ref.revision);
    if (!record || record.kind !== 'stage' || record.hash !== ref.hash || hashJson(record.value) !== record.hash
      || record.value.projectId !== draft.projectId || record.value.stage !== stage || record.value.status !== 'accepted')
      return inheritanceFailure(stage, '/inputs', `Features lost their exact accepted ${stage} source`);
    const content = record.value.content;
    if (!object(content) || !object(content['fields']))
      return inheritanceFailure(stage, '/content/fields', `Features lost their accepted ${stage} fields`);
    return { record, fields: content['fields'] };
  };
  const handoff = discoveryConsumerForDraft(store, draft, 'features');
  const discovery = handoff ? null : read('discovery'), concept = read('concept'), map = read('operation-map'), specification = read('specification');
  for (const [child, parent] of [...(discovery ? [[concept, discovery] as const] : []), [map, concept], [specification, map]] as const)
    if (!child.record.value.inputs.some(ref => canonical(ref) === canonical(reference(parent.record))))
      return inheritanceFailure(child.record.value.stage, '/inputs', 'Feature sources must be one accepted stage chain');
  const grounds = acceptedConceptGrounds(handoff?.manifest ?? reference(discovery!.record),
    handoff ? consumerPreparationFields(handoff) : discovery!.fields, reference(concept.record), concept.fields,
    handoff ? requireDiscoveryHandoff(store, draft).catalogue : undefined);
  const contracts = specification.fields['behaviorContracts'];
  const finding = specificationApplicationFindings(contracts as Json, concept.fields['conceptSections'] as Json, grounds.catalogue)[0];
  if (finding) return inheritanceFailure('behaviorContracts', finding.target, finding.message);
  const rows = (contracts as Record<string, unknown>[]).map((row, index) => {
    const requirements = (row['requirements'] as string[]).map(id => grounds.requirements.find(item => item.id === id)!);
    return { id: row['id'] as string, outcome: row['outcome'] as string,
      source: { record: reference(specification.record), pointer: `/content/fields/behaviorContracts/${index}` },
      requirements: requirements.map(item => item.id), grounds: distinctAddresses(requirements.flatMap(item => item.grounds)) };
  });
  const prepared = proposal?.field === 'featurePreparation' ? proposal.value
    : acceptedDraftField(store, draft, 'featurePreparation');
  const selected = selectedFeatures(prepared, rows);
  return { contract: 'feature-basis-material/v1', sources: { discovery: handoff?.manifest ?? reference(discovery!.record),
    concept: reference(concept.record), map: reference(map.record), specification: reference(specification.record) },
    catalogue: grounds.catalogue, requirements: grounds.requirements, contracts: rows, selected,
    rule: 'A feature inherits only the grounds of its selected behaviorContracts and their exact requirement union; compare its proposed success, failures and interactions with those grounds.' };
}

/** Classify only links in the proposed answer against the material saved with its paid call.
 * A missing or changed accepted premise is not an error in the model's answer. */
export function inheritanceCandidateFailure(draft: DiscoveryDraft, field: string, value: Json,
  prerequisites: unknown): EngineError | null {
  if (draft.contractVersion !== 6 || !Array.isArray(prerequisites)) return null;
  const source = (stage: 'discovery' | 'concept' | 'operation-map' | 'specification'): Ref | null => {
    const refs = draft.inputs.filter(ref => ref.id === stageId(draft.projectId, stage));
    return refs.length === 1 && isRef(refs[0]) ? refs[0]! : null;
  };
  const delivered = (stage: 'concept' | 'specification') => {
    const ref = source(stage);
    const matches = prerequisites.filter(row => object(row) && row['stage'] === stage);
    return ref && matches.length === 1 && isRef(matches[0]!['ref'])
      && canonical(matches[0]!['ref']) === canonical(ref) ? matches[0]! : null;
  };
  const exactSources = (material: Record<string, unknown>, stages: ('discovery' | 'concept' | 'operation-map' | 'specification')[]) => {
    const sources = material['sources'];
    return object(sources) && stages.every(stage => {
      const ref = source(stage), named = sources[stage === 'operation-map' ? 'map' : stage];
      return ref && isRef(named) && canonical(named) === canonical(ref);
    });
  };
  try {
    if (draft.stage === 'operation-map' && field === 'mapDesign') {
      const material = delivered('concept')?.['operationMapMaterial'];
      if (!object(material) || material['contract'] !== 'operation-map-material/v2'
        || !exactSources(material, ['discovery', 'concept']) || !object(material['basis'])
        || !object(material['basis']['catalogue']) || !Array.isArray(material['basis']['requirements'])
        || !Array.isArray(material['basis']['coverage'])) return null;
      const requirements = material['basis']['requirements'];
      if (!requirements.every(row => object(row) && typeof row['id'] === 'string'
        && typeof row['outcome'] === 'string' && Array.isArray(row['grounds']))) return null;
      if (!object(value) || !Array.isArray(value['nodes']))
        return inheritanceFailure('mapDesign', '/nodes', 'A proposed map needs its explicit blocks');
      implementedBlocks(value['nodes'], requirements as GroundedRequirement[], material['basis']['coverage']);
    } else if (draft.stage === 'features' && field === 'featurePreparation') {
      const material = delivered('specification')?.['featureBasisMaterial'];
      if (!object(material) || material['contract'] !== 'feature-basis-material/v1'
        || !exactSources(material, ['discovery', 'concept', 'operation-map', 'specification'])
        || !object(material['catalogue']) || !Array.isArray(material['requirements'])
        || !Array.isArray(material['contracts'])) return null;
      const rows = material['contracts'];
      if (!rows.every(row => object(row) && typeof row['id'] === 'string'
        && Array.isArray(row['requirements']) && row['requirements'].every((id: unknown) => typeof id === 'string')
        && Array.isArray(row['grounds']))) return null;
      selectedFeatures(value, rows as GroundedContract[]);
    }
  } catch (error) {
    if (error instanceof EngineError && error.code === 'basis_inheritance_material_invalid'
      && (error.details as { field?: string } | null)?.field === field) return error;
    if (error instanceof EngineError && error.code === 'basis_inheritance_material_invalid') return null;
    throw error;
  }
  return null;
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

/** Full concept material uses the same proved C1 source and catalogue as stage admission. */
export function conceptBasisMaterial(store: Store, draft: DiscoveryDraft) {
  if (draft.stage !== 'concept' || !hasDiscoveryHandoff(store, draft)) return null;
  const h = requireDiscoveryHandoff(store, draft);
  return { source: { manifest: h.source.manifest, bundle: h.source.bundle }, summary: h.source.summary,
    projection: h.source.projection, constitution: h.source.constitution, catalogue: h.catalogue };
}

interface ResearchPrerequisite {
  ref: Ref;
  stage: DiscoveryDraft['stage'];
  fields: Record<string, unknown>;
  discoveryMaterial?: DiscoveryConsumerProjection;
  conceptBasisMaterial?: NonNullable<ReturnType<typeof conceptBasisMaterial>>;
  operationMapMaterial?: ReturnType<typeof operationMapMaterial>;
  featureBasisMaterial?: ReturnType<typeof featureBasisMaterial>;
  unknowns?: ReturnType<typeof discoveryUnknowns>;
  planBasis?: NonNullable<ReturnType<typeof readV7PlanBasis>>['context'];
}

/** The immediate accepted prerequisite carries the detailed handoff; older stages
 * supply identities needed for traceability, without duplicating every report. */
export function researchPrerequisites(store: Store, draft: DiscoveryDraft, proposal?: InheritanceProposal): ResearchPrerequisite[] {
  if (isDiscoveryV7Draft(draft)) {
    const plan = draft.questions.map(id => readQuestion(store, id)).find(q => q?.value.status === 'open');
    if (plan && hasV7PlanCoverage(plan.value.spec)) {
      const basis = readV7PlanBasis(store, draft, plan)!;
      return [{ ref: basis.context.frame.answer, stage: 'discovery', fields: {}, planBasis: basis.context }];
    }
  }
  const stages = draft.inputs.flatMap(ref => {
    const record = readStageArtifact<StageArtifact>(store, ref.id, ref.revision);
    return record?.kind === "stage" && record.hash === ref.hash ? [record] : [];
  }).sort((left, right) => STAGES.indexOf(right.value.stage) - STAGES.indexOf(left.value.stage));
  const latest = stages[0];
  const mapMaterial = draft.stage === "operation-map" ? operationMapMaterial(store, draft, proposal) : null;
  const featureMaterial = draft.stage === 'features' && draft.contractVersion === 6 ? featureBasisMaterial(store, draft, proposal) : null;
  const handoff = hasDiscoveryHandoff(store, draft) && draft.stage !== 'concept' ? discoveryConsumerForDraft(store, draft) : null;
  const inherited = stages.filter(record => !handoff || record.value.stage !== 'discovery').map(record => {
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
      ...(featureMaterial && record.value.stage === 'specification' ? { featureBasisMaterial: featureMaterial } : {}),
      ...(unknowns ? { unknowns } : {}) };
  });
  const concept = conceptBasisMaterial(store, draft);
  if (concept) return [...inherited, { ref: concept.source.manifest, stage: 'discovery', fields: {}, conceptBasisMaterial: concept }];
  return handoff ? [...inherited, { ref: handoff.manifest, stage: 'discovery', fields: consumerPreparationFields(handoff),
    discoveryMaterial: handoff }] : inherited;
}

/** Cold entry for consumers outside an already proved product operation. */
export async function researchPrerequisitesAt(store: Store, project: string, at: Ref, proposal?: InheritanceProposal): Promise<ResearchPrerequisite[]> {
  const row = store.get<DiscoveryDraft>(at.id, at.revision);
  if (!row || row.kind !== 'discovery-draft' || row.value.projectId !== project || canonical(reference(row)) !== canonical(at))
    throw new EngineError('discovery_handoff_invalid', 'Expected the exact downstream draft');
  return hasDiscoveryHandoff(store, row.value) ? withDiscoveryHandoffAt(store, project, at, () => researchPrerequisites(store, row.value, proposal))
    : researchPrerequisites(store, row.value, proposal);
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
  const earlier = previous?.value.draft ? readDraft(store, previous.value.draft.id, previous.value.draft.revision) : null;
  const openGaps = earlier?.value.contractVersion === REFINEMENT_CONTRACT_VERSION ? Object.values(earlier.value.fields).flatMap(value => (value as unknown as TechnicalReport).gaps)
    .map(gap => ({ ...gap, deferred: Boolean(graph && researchGapDeferred(store, draft.projectId, graph.value, gap)) })) : [];
  const currentHorizon = graph?.value.nodes.filter(node => graph.value.horizon.includes(node.id))
    .map(node => ({ id: node.id, parent: node.parent, outcome: node.outcome, code: node.code })) ?? [];
  const research = draft.inputs.flatMap(ref => {
    const phase = store.get<{ draft: Ref | null }>(ref.id, ref.revision);
    if (phase?.kind !== "phase" || phase.hash !== ref.hash || !phase.value.draft) return [];
    const report = readDraft(store, phase.value.draft.id, phase.value.draft.revision);
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

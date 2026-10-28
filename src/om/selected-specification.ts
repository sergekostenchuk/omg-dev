import { canonical, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { SpecificationBases, TaskSpecification, TaskSpecificationSelection } from '../compiler/om-readers.js';
import { isRef, stageId, type Ref } from '../pipeline/contracts.js';
import { resolveBasisApplications } from '../discovery/basis-application.js';
import { discoveryBasisCatalogue } from '../discovery/discovery-outcome.js';
import { hasBasisApplications, hasManifestBasisApplications } from '../discovery/projection-reader.js';

/**
 * SP1 (№4714 §3): the accepted specification a consumer is given whole — the original behavior contracts, the feature
 * preparations and every constraint, each with its exact stage Ref and address. One pure selection: no head lookup, no
 * network, no model; the same inputs give the same result. The normalized B1 rows stay the binding view of nodes/state.
 */
export const SELECTED_SPECIFICATION_CONTRACT = 'selected-specification/v1' as const;
export const BASIS_SPECIFICATION_CONTRACT = 'selected-specification/v2' as const;
export type SpecificationContract = typeof SELECTED_SPECIFICATION_CONTRACT | typeof BASIS_SPECIFICATION_CONTRACT;
/** Only the declared producers of the catalogue and application-bearing stages choose this era.
 * The era rule itself lives behind the Discovery boundary (projection-reader.hasBasisApplications). */
export { hasBasisApplications };
export const SELECTED_SPECIFICATION_CODES = Object.freeze(['selected_specification_basis_invalid', 'selected_specification_unresolved'] as const);

export interface AcceptedStageFields { stage: string; ref: Ref; fields: Record<string, Json> }
export interface SelectedSpecificationRequest {
  project: string;
  contract?: SpecificationContract;
  /** The exact stage sources of the B1 input the selection stands on. */
  sources: readonly (Ref & { stage: string; contractVersion?: number | null; sourceKind?: 'accepted-manifest' })[];
  accepted: readonly AcceptedStageFields[];
  discoveryCatalogue?: SpecificationBases['catalogue'];
  discovery?: Json;
  contracts: readonly string[];
  features: readonly { index: number; title: string; outcome: string }[];
}
interface SelectedSpecificationContent {
  discovery?: Json;
  contracts: { source: Ref; index: number; pointer: string; value: Json }[];
  preparations: { source: Ref; index: number; pointer: string; featureIndex: number; value: Json }[];
  constraints: { source: Ref; pointer: string; value: Json };
}

export type SelectedSpecification = SelectedSpecificationContent & ({ contract: typeof SELECTED_SPECIFICATION_CONTRACT }
  | { contract: typeof BASIS_SPECIFICATION_CONTRACT; bases: SpecificationBases });

type Row = Record<string, Json>;
const object = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
const FIELDS = '/content/fields';

function failure(code: typeof SELECTED_SPECIFICATION_CODES[number], target: string, field: string, message: string, ref?: Ref): never {
  throw new EngineError(code, message, { unit: 'E2', target, field, ...(ref ? { ref: exact(ref) } : {}) });
}

/** The preparations of one feature by the B1 rule: equal featureTitle and outcome. Every match is returned in source order. */
export function preparationMatches(preparations: readonly unknown[], feature: { readonly title?: unknown; readonly outcome?: unknown }): { index: number; value: Row }[] {
  return preparations.flatMap((prep, index) => object(prep) && prep.featureTitle === feature.title && prep.outcome === feature.outcome
    ? [{ index, value: prep }] : []);
}

function stage(request: SelectedSpecificationRequest, name: 'discovery' | 'concept' | 'specification' | 'features'): AcceptedStageFields {
  const source = request.sources.filter(row => row.stage === name);
  if (source.length !== 1 || !isRef(source[0]) || source[0]!.id !== stageId(request.project, name))
    failure('selected_specification_basis_invalid', stageId(request.project, name), 'sources', `The input names exactly one ${name} stage of this project`);
  const rows = request.accepted.filter(row => row.stage === name);
  const row = rows[0];
  if (rows.length !== 1 || !row || !isRef(row.ref) || canonical(exact(row.ref)) !== canonical(exact(source[0]!)) || !object(row.fields))
    failure('selected_specification_basis_invalid', source[0]!.id, 'accepted', `The accepted ${name} is the exact stage revision of the input`, source[0]!);
  return row;
}

export function selectSpecification(request: SelectedSpecificationRequest): SelectedSpecification {
  const specification = stage(request, 'specification'), features = stage(request, 'features');
  const list = (from: AcceptedStageFields, field: string): unknown[] => {
    const value = from.fields[field];
    if (!Array.isArray(value)) failure('selected_specification_basis_invalid', from.ref.id, `${FIELDS}/${field}`, `The accepted ${from.stage} keeps an explicit ${field} list`, from.ref);
    return value;
  };
  const raw = list(specification, 'behaviorContracts'), preparations = list(features, 'featurePreparation'), constraints = list(specification, 'constraints');
  const contracts = [...new Set(request.contracts)].map(id => {
    const matches = raw.flatMap((row, index) => object(row) && row.id === id ? [index] : []);
    if (matches.length !== 1)
      failure('selected_specification_unresolved', id, `${FIELDS}/behaviorContracts`, matches.length
        ? 'A selected contract matches several accepted contracts' : 'A selected contract has no accepted original', specification.ref);
    const index = matches[0]!;
    return { source: exact(specification.ref), index, pointer: `${FIELDS}/behaviorContracts/${index}`, value: raw[index] as Json };
  }).sort((a, b) => a.index - b.index);
  const seen = new Set<number>();
  const prepared = request.features.filter(feature => !seen.has(feature.index) && seen.add(feature.index)).map(feature => {
    const matches = preparationMatches(preparations, feature);
    if (matches.length !== 1)
      failure('selected_specification_unresolved', `features[${feature.index}]`, `${FIELDS}/featurePreparation`, matches.length
        ? 'Several preparations match the selected feature title and outcome' : 'No preparation matches the selected feature title and outcome', features.ref);
    const { index, value } = matches[0]!;
    return { source: exact(features.ref), index, pointer: `${FIELDS}/featurePreparation/${index}`, featureIndex: feature.index, value: value as Json };
  }).sort((a, b) => a.index - b.index);
  if (request.discovery && request.contract !== BASIS_SPECIFICATION_CONTRACT)
    failure('selected_specification_basis_invalid', request.project, 'contract', 'Manifest material requires the basis selection form');
  const content = { ...(request.discovery ? { discovery: request.discovery } : {}), contracts, preparations: prepared,
    constraints: { source: exact(specification.ref), pointer: `${FIELDS}/constraints`, value: constraints as Json } };
  if (request.contract === BASIS_SPECIFICATION_CONTRACT)
    return structuredClone({ ...content, contract: BASIS_SPECIFICATION_CONTRACT, bases: selectedBases(request, content) });
  if (request.contract !== undefined && request.contract !== SELECTED_SPECIFICATION_CONTRACT)
    failure('selected_specification_basis_invalid', request.project, 'contract', 'The selection needs a known saved material contract');
  return structuredClone({ contract: SELECTED_SPECIFICATION_CONTRACT, ...content });
}


/** Task scope uses resolved B1 bindings; selecting a feature never recursively expands its contracts. */
export function selectTaskSpecification(request: TaskSpecificationSelection): TaskSpecification {
  const { project, inputRef, input, accepted, requirements, nodes } = request;
  if (!isRef(inputRef) || inputRef.id !== `om-input:${project}`)
    failure('selected_specification_basis_invalid', `om-input:${project}`, 'input', 'Task material needs the exact input of its project');
  const required = new Set(requirements), ancestry = new Set(nodes);
  const contracts = input.contracts.flatMap((value, index) => value.requirements.some(id => required.has(id))
    || value.nodes?.some(id => ancestry.has(id)) ? [{ index, value }] : []);
  const ids = new Set(contracts.map(row => row.value.id));
  const features = input.features.filter(feature => feature.requirementIds.some(id => required.has(id))
    || feature.contracts.some(id => ids.has(id)));
  const selected = selectSpecification({ project, sources: input.sources, accepted,
    ...(request.discoveryCatalogue ? { discoveryCatalogue: request.discoveryCatalogue } : {}),
    ...(request.discovery ? { discovery: request.discovery } : {}), contracts: [...ids], features, ...(request.contract ? { contract: request.contract } : {}) });
  return structuredClone({ ...selected, contracts: selected.contracts.map(row => {
    const id = (row.value as Row).id;
    const effective = contracts.filter(item => item.value.id === id);
    if (effective.length !== 1) failure('selected_specification_unresolved', String(id), '/contracts',
      'A selected original has one effective B1 contract', inputRef);
    const resolved = effective[0]!;
    return { ...row, effective: { source: exact(inputRef), pointer: `/contracts/${resolved.index}`, value: resolved.value as unknown as Json } };
  }) });
}


/** Resolve only the immutable catalogue; feature inheritance does not expand the selected assignment. */
function selectedBases(request: SelectedSpecificationRequest, selected: SelectedSpecificationContent): SpecificationBases {
  const manifest = request.sources.some(source => source.sourceKind === 'accepted-manifest');
  const concept = stage(request, 'concept'), specification = stage(request, 'specification');
  const catalogue = (() => {
    if (manifest) {
      const c = request.discoveryCatalogue, d = request.discovery;
      if (!c || c.contract !== 'discovery-basis-catalogue/v2' || !isRef(c.source)
        || !hasManifestBasisApplications(request.sources, c.source) || !object(d)
        || d.contract !== 'discovery-accepted-projection/v1' || d.project !== request.project
        || !isRef(d.manifest) || canonical(d.manifest) !== canonical(c.source) || !isRef(d.bundle))
        failure('selected_specification_basis_invalid', request.project, 'discovery', 'Manifest selection needs the exact complete C1 material and shared catalogue');
      return c;
    }
    if (request.discoveryCatalogue || request.discovery || !hasBasisApplications(request.sources))
      failure('selected_specification_basis_invalid', request.project, 'sources.contractVersion',
        'Legacy basis material requires its original v6 producers');
    const discovery = stage(request, 'discovery');
    try { return discoveryBasisCatalogue(discovery); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      failure('selected_specification_basis_invalid', discovery.ref.id, '/content/fields', error.message, discovery.ref);
    }
  })();
  const entries = [...catalogue.constraints, catalogue.variant];
  const rawContracts = specification.fields.behaviorContracts;
  const sections = concept.fields.conceptSections;
  if (!Array.isArray(rawContracts) || !Array.isArray(sections))
    failure('selected_specification_basis_invalid', specification.ref.id, FIELDS, 'The application sources retain their explicit lists');
  const requirements = sections.flatMap((section, index) => {
    if (!object(section) || !Array.isArray(section.requirements))
      failure('selected_specification_basis_invalid', concept.ref.id, `${FIELDS}/conceptSections/${index}`, 'Accepted sections retain their requirements');
    return section.requirements.map((value, requirementIndex) => ({ value, pointer: `/${index}/requirements/${requirementIndex}` }));
  });
  const names = (value: unknown, target: string, field: string): string[] => {
    if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && id.length))
      failure('selected_specification_basis_invalid', target, field, 'An inherited basis needs an explicit identity list');
    return value;
  };
  const applications = (source: AcceptedStageFields, field: string, pointer: string, allowed: string[]) => {
    try {
      return resolveBasisApplications({ field, value: source.fields[field], catalogue: entries,
        owners: [{ pointer, fields: allowed, required: [] }], required: [] }).map(row => row.basis);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      failure('selected_specification_basis_invalid', source.ref.id, `${FIELDS}/${field}${pointer}`, error.message, source.ref);
    }
  };
  const contractBases = (index: number) => applications(specification, 'behaviorContracts', `/${index}`,
    ['entry', 'inputs', 'success', 'failures', 'forbiddenEffects', 'state', 'compatibility', 'proof']);
  const inherited = (value: Json, target: string): SpecificationBases['catalogue']['constraints'] => {
    if (!object(value)) failure('selected_specification_basis_invalid', target, 'featurePreparation', 'The selected preparation is an object');
    const result = names(value.requirements, target, 'requirements').flatMap(id => {
      const rows = requirements.filter(row => object(row.value) && row.value.id === id);
      if (rows.length !== 1) failure('selected_specification_unresolved', id, 'requirements', 'Each inherited requirement has one exact source');
      return applications(concept, 'conceptSections', rows[0]!.pointer, ['statement', 'benefit', 'acceptance']);
    });
    for (const id of names(value.behaviorContracts, target, 'behaviorContracts')) {
      const rows = rawContracts.flatMap((row, index) => object(row) && row.id === id ? [index] : []);
      if (rows.length !== 1) failure('selected_specification_unresolved', id, 'behaviorContracts', 'Each inherited contract has one exact source');
      result.push(...contractBases(rows[0]!));
    }
    return [...new Map(result.map(row => [canonical(row.address), row])).values()];
  };
  return { catalogue, selected: [
    ...selected.contracts.map(row => ({ owner: { record: row.source, pointer: row.pointer }, bases: contractBases(row.index) })),
    ...selected.preparations.map(row => ({ owner: { record: row.source, pointer: row.pointer }, bases: inherited(row.value, row.source.id) })),
  ] };
}

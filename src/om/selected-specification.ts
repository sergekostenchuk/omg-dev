import { canonical, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { TaskSpecification, TaskSpecificationSelection } from '../compiler/om-readers.js';
import { isRef, stageId, type Ref } from '../pipeline/contracts.js';

/**
 * SP1 (№4714 §3): the accepted specification a consumer is given whole — the original behavior contracts, the feature
 * preparations and every constraint, each with its exact stage Ref and address. One pure selection: no head lookup, no
 * network, no model; the same inputs give the same result. The normalized B1 rows stay the binding view of nodes/state.
 */
export const SELECTED_SPECIFICATION_CONTRACT = 'selected-specification/v1' as const;
export const SELECTED_SPECIFICATION_CODES = Object.freeze(['selected_specification_basis_invalid', 'selected_specification_unresolved'] as const);

export interface AcceptedStageFields { stage: string; ref: Ref; fields: Record<string, Json> }
export interface SelectedSpecificationRequest {
  project: string;
  /** The exact stage sources of the B1 input the selection stands on. */
  sources: readonly (Ref & { stage: string })[];
  accepted: readonly AcceptedStageFields[];
  contracts: readonly string[];
  features: readonly { index: number; title: string; outcome: string }[];
}
export interface SelectedSpecification {
  contract: typeof SELECTED_SPECIFICATION_CONTRACT;
  contracts: { source: Ref; index: number; pointer: string; value: Json }[];
  preparations: { source: Ref; index: number; pointer: string; featureIndex: number; value: Json }[];
  constraints: { source: Ref; pointer: string; value: Json };
}

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

function stage(request: SelectedSpecificationRequest, name: 'specification' | 'features'): AcceptedStageFields {
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
  return { contract: SELECTED_SPECIFICATION_CONTRACT, contracts, preparations: prepared,
    constraints: { source: exact(specification.ref), pointer: `${FIELDS}/constraints`, value: constraints as Json } };
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
    contracts: [...ids], features });
  return structuredClone({ ...selected, contracts: selected.contracts.map(row => {
    const id = (row.value as Row).id;
    const effective = contracts.filter(item => item.value.id === id);
    if (effective.length !== 1) failure('selected_specification_unresolved', String(id), '/contracts',
      'A selected original has one effective B1 contract', inputRef);
    const resolved = effective[0]!;
    return { ...row, effective: { source: exact(inputRef), pointer: `/contracts/${resolved.index}`, value: resolved.value as unknown as Json } };
  }) });
}

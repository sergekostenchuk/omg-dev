import { uniqueTransactionGuards } from '../runtime/environment.js';
import { Ajv } from 'ajv';
import { canonical, canonicalSorted, hashJson, type Json } from '../canonical.js';
import { QUESTION_MOMENTS } from '../discovery/projection-reader.js';
import { isSupportedEra, questionMomentRequired } from '../discovery/projection-reader.js';
import { EngineError } from '../errors.js';
import type { Graph } from '../graph/model.js';
import { RefinementRelations } from '../graph/relations.js';
import { graphSchema, graphV2Schema } from '../graph/schema.js';
import { KNOWLEDGE_KINDS as ENGINE_KINDS, RESOLUTION_MOMENTS as ENGINE_MOMENTS } from '../graph/obligation-policy.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type TransactionGuard, type Revision, type Write } from '../storage/store.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readRecord, writeGuarded } from './refs.js';
import { READINESS_CONTRACT, historicalProof, readOmInput, readinessQuestionId, withHistoricalReads, type InputBuildResult, type InputGap, type OmInput,
  type ReadinessCause } from './input.js';
import { readHorizon } from './horizon.js';
import { readUnacceptedLayer } from './layer-basis.js';
import { prepareFrameProposals, readFrameProposals, type FrameGap, type ProposalRequest, type PreparedFrameProposals } from './frame-proposals.js';

export const KNOWLEDGE_KINDS = sealed([...ENGINE_KINDS]);
export const RESOLUTION_MOMENTS = sealed([...ENGINE_MOMENTS]);
export const GAP_MOMENTS = sealed(QUESTION_MOMENTS);
export type GapKind = typeof KNOWLEDGE_KINDS[number];
export type GapMoment = typeof GAP_MOMENTS[number];
export const GAP_ROUTES = sealed({
  'repository-fact': ['code', 'research'], 'design-decision': ['design'], 'owner-decision': ['owner'],
  'environment-confirmation': ['environment'], 'post-implementation-proof': ['task-result'],
});
/**
 * OWN1 (№3711, №3713): the bypass — an owner question the pass needs now is decided by the model on the design route
 * (MC2 input-field, applied by F5.3 as a decision of the model, never as an owner's H2); an owner's own H2 result offered
 * for it is still admitted by G4b. D1 keeps the routes an offered result may take: its records stay those of their era,
 * and an attempt open on them is not cut off from its own D1 by a new code.
 */
export function bypassRouteOf(gap: Pick<Gap, 'kind' | 'code' | 'field' | 'moment'>): 'design' | null {
  return gap.kind === 'owner-decision' && gap.code === 'predecessor_question' && gap.field === 'answer' && gap.moment === 'om-pass'
    ? 'design' : null;
}
export const GAP_DEFAULT_MOMENTS = sealed({
  'repository-fact': 'om-pass', 'design-decision': 'om-pass', 'owner-decision': 'om-pass',
  'environment-confirmation': 'task-start', 'post-implementation-proof': 'task-result',
} as const);
export const GAP_CLASSES = sealed({
  contract_node_unbound: { field: 'nodes', kind: 'design-decision' },
  contract_boundary_prose: { field: 'state', kind: 'design-decision' },
  acceptance_kind_missing: { field: 'checkKind', kind: 'design-decision' },
  inventory_missing: { field: 'inventory', kind: 'repository-fact' },
  obligation_open: { field: 'fill', kind: 'design-decision' },
  predecessor_question: { field: 'answer', kind: null },
  question_unaddressed: { field: 'address', kind: 'design-decision' },
} as const);
export const GAP_REFUSAL_CODES = sealed([
  'gap_request_invalid', 'gap_source_missing', 'gap_set_missing', 'gap_record_forged', 'gap_missing', 'gap_foreign',
  'gap_duplicate', 'gap_class_unknown', 'gap_kind_unknown', 'gap_class_conflict', 'gap_consumer_missing',
  'gap_moment_unknown', 'gap_outside_horizon',
] as const);
export interface SourceGap extends InputGap { kind?: GapKind; moment?: GapMoment; addressedBy?: Ref }
export type GapQuestion = OmInput['questions'][number] & { moment?: GapMoment; addressedBy?: Ref };
export interface GapInputResult extends Omit<InputBuildResult, 'input' | 'gaps'> {
  input: (Omit<OmInput, 'questions'> & { questions: GapQuestion[] }) | null; gaps: SourceGap[];
}
export interface GapSources {
  inputResult: GapInputResult; frameGaps: { operations: FrameGap[]; works: FrameGap[] };
  horizon: { nodes: string[] }; graph: Graph;
}
export interface GapEvidence {
  origin: 'input' | 'question' | 'operations' | 'works'; target: string; source: Ref | null; value: Json;
}
export interface Gap {
  id: string; target: string; field: string; code: string; kind: GapKind; routes: string[]; moment: GapMoment;
  consumers: string[]; origins: ('input' | 'frame' | 'question')[]; evidence: GapEvidence[]; blocking: boolean;
  mechanism?: string; uses?: string[]; node?: string; neighbors?: FrameGap['neighbors']; addressedBy?: Ref;
  deferral?: { reason: 'outside_horizon'; until: 'horizon-entry'; blocks: string[] };
}
export interface GapCollection { gaps: Gap[]; refusals: Refusal[] }
export interface GapGate { passed: boolean; codes: string[]; findings: Refusal[] }
export interface UnavailableWorksSource { state: 'upper-not-accepted'; layer: Ref }
export type WorksSourceRequest = ProposalRequest | UnavailableWorksSource;
export interface GapRequest {
  project: string; input: Ref; horizon: Ref; graph: Ref; operations: ProposalRequest; works: WorksSourceRequest;
}
export interface GapRecord { project: string; sources: GapRequest; gap: Gap }
export interface PreparedGaps {
  sources: GapRequest; collection: GapCollection; gate: GapGate; references: Ref[];
  writes: Write[]; guards: TransactionGuard[]; existing: Revision<GapRecord>[];
}
export interface GapRecords { sources: GapRequest; records: Revision<GapRecord>[]; collection: GapCollection; gate: GapGate }
export interface GapReadRequest { sources: GapRequest; records: Ref[] }

const object = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = canonicalSorted;
const unique = <T>(values: readonly T[]): T[] => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const isKind = (value: unknown): value is GapKind => typeof value === 'string' && (KNOWLEDGE_KINDS as readonly string[]).includes(value);
const isMoment = (value: unknown): value is GapMoment => typeof value === 'string' && (GAP_MOMENTS as readonly string[]).includes(value);
const schemas = new Ajv({ strict: true, allowUnionTypes: true });
const graphShapes = [schemas.compile(sealed(graphSchema)), schemas.compile(sealed(graphV2Schema))];
function invalid(field: string): never {
  throw new EngineError('gap_request_invalid', 'Gap operations need explicit, well-formed arguments', { unit: 'G4', target: 'gaps', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) {
    if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json');
    throw error;
  }
}
function failure(code: string, target: string, field: string, message: string): Refusal {
  const result = refused(code, message, { unit: 'G4', target, field }, 'producer');
  if (!result.ok) return result.refusal;
  throw new EngineError('gap_internal_error', 'Refusal unexpectedly produced a value');
}
class GapFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function reject(code: string, target: string, field: string, message: string): never { throw new GapFailure(failure(code, target, field, message)); }
function take<T>(result: OmResult<T>): T {
  if (!result.ok) throw new GapFailure(result.refusal);
  return result.value;
}
function outcome<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof GapFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
export function gapId(target: string, field: string): string {
  if (!text(target) || !text(field)) invalid('identity');
  return hashJson([target, field]);
}
function missingSource(sources: unknown): string | null {
  if (!object(sources)) return 'sources';
  if (!object(sources.horizon) || !Array.isArray(sources.horizon.nodes) || !sources.horizon.nodes.every(text)) return 'horizon';
  if (!object(sources.graph) || !graphShapes[sources.graph.version === 2 ? 1 : 0]!(sources.graph)) return 'graph';
  if (!object(sources.frameGaps)) return 'frameGaps';
  for (const name of ['operations', 'works']) if (!Array.isArray(sources.frameGaps[name])) return `frameGaps.${name}`;
  const result = sources.inputResult;
  if (!object(result) || !Array.isArray(result.gaps) || !Array.isArray(result.refusals) || !object(result.input)) return 'inputResult';
  if (!Object.hasOwn(result, 'hash')) return 'inputResult.hash';
  for (const name of ['features', 'questions']) if (!Array.isArray(result.input[name])) return `inputResult.input.${name}`;
  return null;
}
function frameSource(value: unknown, level: 2 | 3): value is FrameGap {
  if (!object(value) || !text(value.target) || !text(value.consumer) || !text(value.kind) || !Array.isArray(value.neighbors)
    || !object(value.question) || value.blocking !== true) return false;
  const question = value.question;
  if (question.level !== level || !text(question.upper) || !text(question.artifact) || !['producer', 'consumer'].includes(question.role)
    || (question.port !== null && !text(question.port)) || (question.portContract !== null && !text(question.portContract))
    || !Array.isArray(question.existing) || !question.existing.every(text) || question.allowNew !== true) return false;
  return value.neighbors.every(item => object(item) && text(item.id) && item.level === level
    && ['block-outcome', 'operation-outcome', 'connection-end'].includes(item.kind)
    && object(item.upper) && text(item.upper.node) && (item.upper.port === undefined || text(item.upper.port))
    && text(item.artifact) && ['horizon', 'outside'].includes(item.zone)
    && (item.connector === undefined || text(item.connector)) && (item.flow === undefined || text(item.flow))
    && (item.role === undefined || ['producer', 'consumer'].includes(item.role)));
}
/** Four explicit source collections; an empty collection is received data, never a substitute for a missing producer. */
export function collectGaps(sources: GapSources): Sealed<GapCollection> {
  const missing = missingSource(sources);
  if (missing) return sealed({ gaps: [], refusals: [failure('gap_source_missing', missing, 'source', 'Each gap source must be explicitly supplied')] });
  for (const question of sources.inputResult.input!.questions) if (object(question)
    && Object.hasOwn(question, 'moment') && question.moment === undefined)
    return sealed({ gaps: [], refusals: [failure('gap_moment_unknown', text(question.id) ? question.id : 'inputResult',
      'moment', 'An explicit undefined is not a question moment')] });
  sources = copy(sources);
  const { inputResult, graph } = sources, input = inputResult.input!;
  const refusals: Refusal[] = [], found = new Map<string, Gap>(), conflicts = new Set<string>();
  const fail = (code: string, target: string, field: string, message: string) => refusals.push(failure(code, target, field, message));
  const finish = () => sealed({ gaps: [...found.values()].filter(gap => !conflicts.has(gap.id)).sort((a, b) => order(a.id, b.id)), refusals: unique(refusals) });
  if (inputResult.hash !== hashJson(input)) {
    fail('gap_record_forged', 'inputResult', 'hash', 'The input hash does not match its source content'); return finish();
  }
  if (!input.features.every(feature => object(feature) && Number.isSafeInteger(feature.index) && feature.index >= 0
    && text(feature.outcome) && Array.isArray(feature.requirementIds) && feature.requirementIds.every(text))) {
    fail('gap_source_missing', 'inputResult', 'features', 'Feature identities, outcomes and requirement bindings must be explicit'); return finish();
  }
  if (inputResult.refusals.length) {
    for (const item of inputResult.refusals) if (object(item) && text(item.code) && object(item.at) && text(item.at.target)
      && text(item.at.unit) && text(item.message) && ['producer', 'gap', 'owner', 'readiness'].includes(item.route)) refusals.push(item);
    else fail('gap_source_missing', 'inputResult', 'refusals', 'The producer refusal is malformed');
    return finish();
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), relations = new RefinementRelations(graph);
  const activeBlocks = new Set(sources.horizon.nodes);
  if (sources.horizon.nodes.some(id => nodes.get(id)?.kind !== 'block')) {
    fail('gap_source_missing', 'horizon', 'nodes', 'Horizon entries must resolve to blocks of this graph'); return finish();
  }
  const outcomeBlocks = (value: string) => graph.nodes.filter(node => node.kind === 'block' && node.outcome === value).map(node => node.id);
  const resolve = (consumer: unknown): { blocks: string[]; mechanism?: string; uses?: string[] } => {
    if (text(consumer)) return { blocks: unique(relations.ancestry(consumer).filter(node => node.kind === 'block').map(node => node.id)) };
    if (!object(consumer)) return { blocks: [] };
    if (Array.isArray(consumer.places) && consumer.places.length && consumer.places.every(text)) {
      const blocks = (consumer.places as string[]).map(place => relations.ancestry(place).filter(node => node.kind === 'block').map(node => node.id));
      return { blocks: blocks.some(found => !found.length) ? [] : unique(blocks.flat()) };
    }
    if (text(consumer.mechanism) && (consumer.uses === undefined || Array.isArray(consumer.uses) && consumer.uses.every(text)))
      return { blocks: [], mechanism: consumer.mechanism, ...(consumer.uses === undefined ? {} : { uses: unique(consumer.uses as string[]) }) };
    if (Array.isArray(consumer.features)) {
      const blocks: string[] = [];
      for (const item of consumer.features) {
        if (!object(item) || !Number.isSafeInteger(item.feature)) return { blocks: [] };
        const features = input.features.filter(feature => feature.index === item.feature);
        if (features.length !== 1) return { blocks: [] };
        const mine = outcomeBlocks(features[0]!.outcome);
        if (!mine.length) return { blocks: [] };
        blocks.push(...mine);
      }
      return { blocks: unique(blocks) };
    }
    if (text(consumer.requirement)) {
      const mapped = input.features.filter(feature => feature.requirementIds.includes(consumer.requirement)).map(feature => outcomeBlocks(feature.outcome));
      return { blocks: mapped.some(blocks => !blocks.length) ? [] : unique(mapped.flat()) };
    }
    return { blocks: [] };
  };
  const push = (src: Record<string, any>, origin: GapEvidence['origin'], raw: Json) => {
    const target = text(src.target) ? src.target : 'source';
    if (!text(src.code) || !Object.hasOwn(GAP_CLASSES, src.code)) {
      fail('gap_class_unknown', target, 'code', 'The source code has no gap classification'); return;
    }
    const cls = GAP_CLASSES[src.code as keyof typeof GAP_CLASSES], kind = cls.kind ?? src.kind;
    if (!isKind(kind)) { fail('gap_kind_unknown', target, 'kind', 'The knowledge kind is not in the immutable policy'); return; }
    if (!text(src.target) || src.field !== cls.field || (src.kind !== undefined && src.kind !== kind)) {
      fail('gap_class_conflict', target, 'classification', 'Source fields disagree with their code classification'); return;
    }
    const moment = Object.hasOwn(src, 'moment') ? src.moment : GAP_DEFAULT_MOMENTS[kind];
    if (!isMoment(moment)) { fail('gap_moment_unknown', target, 'moment', 'An assigned moment must be preserved and recognized'); return; }
    const inventory = src.code === 'inventory_missing';
    if (inventory && (!object(src.consumer) || !Array.isArray(src.consumer.uses) || !src.consumer.uses.every(text)
      || !same(sorted(src.consumer.uses), ['code-answer', 'project-question-package']))) {
      fail('gap_class_conflict', target, 'consumer.uses', 'Inventory must name both M6 uses explicitly and exactly'); return;
    }
    const consumer = resolve(src.consumer);
    if (!consumer.blocks.length && !consumer.mechanism) { fail('gap_consumer_missing', target, 'consumer', 'No consumer block or mechanism resolves'); return; }
    if (inventory && (consumer.mechanism !== 'M6' || !same(consumer.uses, ['code-answer', 'project-question-package']) || moment !== 'om-pass')) {
      fail('gap_class_conflict', target, 'inventory', 'Inventory has the fixed M6 consumers and OM-pass deadline'); return;
    }
    if (src.addressedBy !== undefined && !isRef(src.addressedBy)) { fail('gap_source_missing', target, 'addressedBy', 'Addressing needs its exact basis'); return; }
    const id = gapId(target, cls.field), active = !!consumer.mechanism || consumer.blocks.some(block => activeBlocks.has(block));
    const gap: Gap = { id, target, field: cls.field, code: src.code, kind,
      routes: inventory ? ['code'] : [...GAP_ROUTES[kind]], moment, consumers: consumer.blocks,
      origins: [origin === 'operations' || origin === 'works' ? 'frame' : origin],
      evidence: [{ origin, target, source: isRef(src.source) ? src.source : null, value: raw }],
      blocking: !inventory && active && moment === 'om-pass',
      ...(consumer.mechanism ? { mechanism: consumer.mechanism } : {}), ...(consumer.uses ? { uses: consumer.uses } : {}),
      ...(src.node === undefined ? {} : { node: src.node }), ...(src.neighbors === undefined ? {} : { neighbors: src.neighbors }),
      ...(src.addressedBy === undefined ? {} : { addressedBy: src.addressedBy }),
      ...(active || inventory ? {} : { deferral: { reason: 'outside_horizon', until: 'horizon-entry', blocks: [...consumer.blocks] } }),
    };
    const prior = found.get(id);
    if (!prior) { found.set(id, gap); return; }
    if (!same([prior.code, prior.kind, prior.routes, prior.moment, prior.mechanism ?? null], [gap.code, gap.kind, gap.routes, gap.moment, gap.mechanism ?? null])
      || (prior.node && gap.node && prior.node !== gap.node)
      || (prior.addressedBy && gap.addressedBy && !same(prior.addressedBy, gap.addressedBy))) {
      conflicts.add(id); fail('gap_class_conflict', target, cls.field, 'Sources assign contradictory classifications to the same gap'); return;
    }
    prior.consumers = unique([...prior.consumers, ...gap.consumers]); prior.origins = unique([...prior.origins, ...gap.origins]);
    prior.evidence = unique([...prior.evidence, ...gap.evidence]);
    if (prior.uses || gap.uses) prior.uses = unique([...(prior.uses ?? []), ...(gap.uses ?? [])]);
    if (prior.neighbors || gap.neighbors) prior.neighbors = unique([...(prior.neighbors ?? []), ...(gap.neighbors ?? [])]);
    if (gap.node) prior.node = gap.node;
    if (gap.addressedBy) prior.addressedBy = gap.addressedBy;
    const mergedActive = !!prior.mechanism || prior.consumers.some(block => activeBlocks.has(block));
    prior.blocking = !inventory && mergedActive && prior.moment === 'om-pass';
    if (mergedActive || inventory) delete prior.deferral;
    else prior.deferral = { reason: 'outside_horizon', until: 'horizon-entry', blocks: [...prior.consumers] };
  };
  for (const item of inputResult.gaps) {
    if (!object(item) || !Object.hasOwn(item, 'consumer') || !text(item.message)
      || (item.source !== null && !isRef(item.source))) { fail('gap_source_missing', 'inputResult', 'gaps', 'An input gap must name its source and consumer'); continue; }
    push(item, 'input', item as unknown as Json);
  }
  for (const question of input.questions) {
    if (!object(question) || !text(question.id) || !text(question.question) || !text(question.consumer) || !Object.hasOwn(question, 'kind')
      || typeof question.blocks !== 'boolean' || !isRef(question.source)) {
      fail('gap_source_missing', 'inputResult', 'questions', 'A predecessor question needs its complete producer metadata'); continue;
    }
    // AT1 door (№4105 п.1): a readiness question names its own producer — the saved G5 whose cause it asks (RL3: or the owner's
    // reopening of the accepted L3, whose door asked it), proved by the B1 derivation that added it; never a question of a stage.
    if (Object.hasOwn(question, 'readiness')) {
      if (!readinessQuestion(question)) fail('gap_source_missing', question.id, 'source', 'A readiness question names its exact saved G5 cause');
      // Return №4197: a transition is a gap of the block of every place its works stand in.
      else push({ target: question.id, code: 'predecessor_question', field: 'answer', source: question.source, kind: question.kind, moment: question.moment,
        consumer: question.readiness?.cause === 'transition' ? { places: question.readiness.places } : question.consumer }, 'question', question as unknown as Json);
      continue;
    }
    const producer = Array.isArray(input.sources) ? input.sources.filter(source => object(source)
      && source.id === question.source.id && source.revision === question.source.revision && source.hash === question.source.hash) : [];
    if (producer.length !== 1 || !['discovery', 'features'].includes(producer[0]!.stage)
      || !Object.hasOwn(producer[0]!, 'contractVersion')
      || (producer[0]!.contractVersion !== null && !isSupportedEra(producer[0]!.contractVersion))) {
      fail('gap_source_missing', question.id, 'source', 'A question must identify its exact stage producer and contract era'); continue;
    }
    if (questionMomentRequired(producer[0]!.contractVersion) && !Object.hasOwn(question, 'moment')) {
      fail('gap_moment_unknown', question.id, 'moment', 'This producer contract requires its explicit question moment'); continue;
    }
    if (question.kind !== null && !isKind(question.kind)) { fail('gap_kind_unknown', question.id, 'kind', 'The assigned knowledge kind is unknown'); continue; }
    if (Object.hasOwn(question, 'moment') && !isMoment(question.moment)) {
      fail('gap_moment_unknown', question.id, 'moment', 'An assigned moment must be preserved and recognized'); continue;
    }
    if (question.addressedBy !== undefined && !isRef(question.addressedBy)) {
      fail('gap_source_missing', question.id, 'addressedBy', 'Addressing needs its exact basis'); continue;
    }
    const addressed = nodes.has(question.consumer) && isKind(question.kind);
    // Addressing is an OM-pass prerequisite; the answer deadline remains in the source question.
    push({ target: question.id, code: addressed ? 'predecessor_question' : 'question_unaddressed', field: addressed ? 'answer' : 'address',
      consumer: addressed ? question.consumer : { mechanism: 'M5:addressing' }, source: question.source,
      ...(addressed ? { kind: question.kind, ...(Object.hasOwn(question, 'moment') ? { moment: question.moment } : {}),
        ...(question.addressedBy === undefined ? {} : { addressedBy: question.addressedBy }) } : {}) }, 'question', question as unknown as Json);
  }
  for (const origin of ['operations', 'works'] as const) for (const item of sources.frameGaps[origin]) {
    if (!frameSource(item, origin === 'operations' ? 2 : 3)) {
      fail('gap_source_missing', origin, 'gaps', 'A frame source must carry its exact obligation, neighbors and question'); continue;
    }
    push({ ...item, code: 'obligation_open', node: item.consumer }, origin, item as unknown as Json);
  }
  return finish();
}

/**
 * The whole form of a readiness question: its exact cause, identity, addressed consumer and fixed moment and blocking; a
 * transition is a repository fact, a policy an owner decision (decided by the owner's H2, or by the model in the pass).
 */
function readinessQuestion(question: Record<string, any>): boolean {
  const cause = question.readiness as ReadinessCause;
  const texts = (value: unknown) => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
  if (!object(cause) || cause.contract !== READINESS_CONTRACT || !texts(cause.works) || !cause.works.length || !isRef(question.source)
    || !['om-atomic-gate:', 'om-l3-reopen:'].some(prefix => question.source.id.startsWith(prefix)) || question.moment !== 'om-pass' || question.blocks !== true
    || question.addressedBy !== undefined) return false;
  // The whole form first; the identity is derived from it only once it is complete.
  const formed = cause.cause === 'policy'
    ? ['appearance', 'provider'].includes(cause.policy) && text(cause.producer) && object(cause.governs)
      && text(cause.governs.contract) && text(cause.governs.hash) && Object.keys(cause.governs).length === 2
      && Object.keys(cause).length === 6 && question.kind === 'owner-decision'
    : cause.cause === 'transition' && object(cause.snapshot) && text(cause.snapshot.commit) && text(cause.snapshot.tree)
      && Object.keys(cause.snapshot).length === 2 && text(cause.file) && Number.isSafeInteger(cause.line) && cause.line >= 0
      && text(cause.kind) && text(cause.expression) && object(cause.site) && Number.isSafeInteger(cause.site.start) && Number.isSafeInteger(cause.site.end)
      && cause.site.start >= 0 && cause.site.end >= cause.site.start && text(cause.site.hash) && Object.keys(cause.site).length === 3
      && texts(cause.candidates) && texts(cause.places) && cause.places.includes(question.consumer) && Object.keys(cause).length === 11
      && question.kind === 'repository-fact';
  return formed && question.id === readinessQuestionId(cause, question.consumer);
}
/** The supplied set cannot choose its own classification, deadline, routing, scope, or completeness. */
export function gateGaps(result: GapCollection, sources: GapSources): Sealed<GapGate> {
  if (!object(result) || !Array.isArray(result.gaps) || !Array.isArray(result.refusals) || result.gaps.some(gap => !object(gap)))
    return sealed({ passed: false, codes: ['gap_set_missing'], findings: [failure('gap_set_missing', 'gaps', 'set', 'An explicit gap set and refusals are required')] });
  return gateAgainst(result, collectGaps(sources), sources);
}
/** The one comparison of a claimed set with the set its sources derive (PF3.1 №3459 §6): the public gate derives that set
 * itself; G4's own derivation hands over the collection it has just derived, so it is not collected a second time. */
function gateAgainst(result: GapCollection, fresh: Sealed<GapCollection>, sources: GapSources): Sealed<GapGate> {
  result = copy(result);
  const findings: Refusal[] = [...fresh.refusals] as Refusal[];
  const expected = new Map(fresh.gaps.map(gap => [gap.id, gap])), seen = new Set<string>();
  for (const gap of result.gaps) {
    const id = text(gap.id) ? gap.id : 'gap';
    if (seen.has(id)) { findings.push(failure('gap_duplicate', id, 'id', 'The claimed set contains a duplicate')); continue; }
    seen.add(id);
    const wanted = expected.get(id);
    if (!wanted) findings.push(failure('gap_foreign', id, 'id', 'The claimed gap is absent from its source set'));
    else if (!same(gap, wanted)) findings.push(failure('gap_record_forged', id, 'gap', 'The claimed gap differs from the source-derived gap'));
    if (Array.isArray(gap.consumers) && object(sources?.horizon) && Array.isArray(sources.horizon.nodes)
      && !gap.mechanism && !gap.consumers.some(block => sources.horizon.nodes.includes(block))
      && (!gap.deferral || gap.deferral.until !== 'horizon-entry' || !Array.isArray(gap.deferral.blocks) || !gap.deferral.blocks.length))
      findings.push(failure('gap_outside_horizon', id, 'deferral', 'An inactive gap needs its return condition'));
  }
  for (const id of expected.keys()) if (!seen.has(id)) findings.push(failure('gap_missing', id, 'set', 'A source gap is missing from the claimed set'));
  if (!same(unique(result.refusals), unique(fresh.refusals))) findings.push(failure('gap_record_forged', 'gaps', 'refusals', 'The claimed refusals differ from source validation'));
  const normalized = unique(findings);
  return sealed({ passed: normalized.length === 0, codes: unique(normalized.map(item => item.code)), findings: normalized });
}

function requireStore(store: Store): void { if (!(store instanceof Store)) invalid('store'); }
function unavailableWorks(value: WorksSourceRequest): value is UnavailableWorksSource { return 'state' in value; }
function requireRequest(value: unknown, historical = false): asserts value is GapRequest {
  if (!object(value) || !text(value.project) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.project)) invalid('request');
  for (const field of ['input', 'graph', 'horizon']) if (!isRef(value[field])) invalid(field);
  for (const field of ['operations', 'works']) {
    const source = value[field];
    if (field === 'works' && object(source) && Object.hasOwn(source, 'state')) {
      if (source.state !== 'upper-not-accepted' || !isRef(source.layer)
        || Object.keys(source).some(key => key !== 'state' && key !== 'layer')) invalid('works');
      continue;
    }
    if (!object(source) || !object(source.frame) || !Array.isArray(source.proposals) || !source.proposals.every(isRef)) invalid(field);
    const frame = source.frame;
    if (!text(frame.project) || ![2, 3].includes(frame.level) || !isRef(frame.graph) || !isRef(frame.horizon)
      || (frame.frame !== null && !isRef(frame.frame)) || (frame.layer !== null && !isRef(frame.layer))
      || (frame.level === 2 ? frame.upper !== null : !object(frame.upper) || !isRef(frame.upper.horizon)
        || (historical ? frame.upper.frame !== null && !isRef(frame.upper.frame) : !isRef(frame.upper.frame)))) invalid(field);
  }
}
function normalizedRequest(request: GapRequest): GapRequest {
  return copy({ ...request, operations: { ...request.operations, proposals: sorted(request.operations.proposals) },
    works: unavailableWorks(request.works) ? request.works : { ...request.works, proposals: sorted(request.works.proposals) } });
}
interface Materialized { request: GapRequest; sources: GapSources; collection: GapCollection; gate: GapGate; references: Ref[]; guards: TransactionGuard[] }
function materialize(store: Store, request: GapRequest, current: boolean): Materialized {
  if (current) return deriveMaterialized(store, request, true);
  return historicalProof(store, { reader: 'D1.materialize', project: request.project, ref: request.input,
    parameters: request as unknown as Json }, store => deriveMaterialized(store, request, false),
  () => reject('gap_record_forged', request.project, 'sources', 'Historical gap sources cannot contain a cyclic derivation'));
}
function deriveMaterialized(store: Store, request: GapRequest, current: boolean): Materialized {
  for (const [name, level] of [['operations', 2], ['works', 3]] as const) {
    const frame = name === 'operations' ? request.operations.frame : unavailableWorks(request.works) ? null : request.works.frame;
    if (frame === null) continue;
    if (frame.project !== request.project || frame.level !== level || !same(frame.graph, request.graph) || !same(frame.horizon, request.horizon))
      reject('gap_record_forged', request.project, name, 'All four sources must belong to one exact graph, input and horizon snapshot');
  }
  const input = take(readOmInput(store, request.project, request.input));
  const horizon = take(readHorizon(store, request.project, request.horizon));
  if (horizon.gate.value.state !== 'accepted' || !same(horizon.horizon.value.request.input, request.input))
    reject('gap_record_forged', request.horizon.id, 'input', 'The admitted horizon must reference this exact OM input');
  const graph = take(readRecord<Graph>(store, request.graph, { unit: 'G4', target: request.graph.id, id: `graph:${request.project}`, kind: 'graph' }));
  const read = current ? prepareFrameProposals : readFrameProposals;
  const operations = take(read(store, request.operations));
  let works: Sealed<{ gaps: FrameGap[]; references: Ref[]; guards?: TransactionGuard[] }>;
  let worksRequest = request.works;
  if (unavailableWorks(request.works)) {
    if (operations.frame.accepted !== null || horizon.horizon.value.request.refinement !== null)
      reject('gap_record_forged', request.project, 'works', 'The unavailable works source contradicts its saved upper-layer basis');
    const envelope = take(readUnacceptedLayer(store,
      { project: request.project, level: 2, graph: request.graph, layer: request.works.layer }));
    if (current) {
      const head = store.get(request.works.layer.id);
      if (!head || !same(reference(head), request.works.layer))
        reject('input_stale', request.works.layer.id, 'works.layer', 'The unavailable works source is no longer current');
    }
    works = { gaps: [], references: envelope.references, guards: current ? envelope.currentReferences : [] };
  } else {
    const prepared = take(read(store, request.works));
    works = prepared;
    worksRequest = { ...request.works, frame: prepared.frame.request };
  }
  const sources: GapSources = { inputResult: { input: input.value.input as OmInput, hash: input.value.hash, gaps: input.value.gaps as InputGap[], refusals: [] },
    graph: graph.value as Graph, horizon: { nodes: [...horizon.horizon.value.result.horizon.nodes] },
    frameGaps: { operations: operations.gaps as FrameGap[], works: works.gaps as FrameGap[] } };
  const derived = collectGaps(sources), collection = derived as GapCollection, gate = gateAgainst(collection, derived, sources) as GapGate;
  if (!gate.passed) throw new GapFailure(gate.findings[0]!);
  const guards = new Map<string, TransactionGuard>();
  if (current) for (const source of [operations, works]) for (const ref of (source as Sealed<PreparedFrameProposals>).guards) {
    const previous = guards.get(ref.id);
    if (previous && !same(previous, ref)) reject('gap_record_forged', ref.id, 'head', 'Sources were prepared from different heads');
    guards.set(ref.id, ref);
  }
  return { request: { ...request, operations: { ...request.operations, frame: operations.frame.request }, works: worksRequest },
    sources, collection, gate, guards: sorted([...guards.values()]),
    references: unique([request.input, request.graph, request.horizon, reference(horizon.horizon), ...operations.references, ...works.references]) };
}
function recordId(project: string, gap: Gap): string { return `om-gap:${project}:${gap.id}`; }
/** No gap lines, source statuses, or neighboring records are changed during preparation. */
export function prepareGaps(store: Store, request: GapRequest): OmResult<Sealed<PreparedGaps>> {
  requireStore(store); requireRequest(request); request = normalizedRequest(request);
  return outcome(() => {
    const basis = materialize(store, request, true), writes: Write[] = [], existing: Revision<GapRecord>[] = [];
    request = normalizedRequest(basis.request);
    const guards: TransactionGuard[] = [...basis.guards];
    for (const gap of basis.collection.gaps) {
      const id = recordId(request.project, gap), value: GapRecord = { project: request.project, sources: request, gap };
      const head = store.get<GapRecord>(id);
      if (head) guards.push(reference(head));
      if (head && same(head.value, value)) existing.push(head);
      else writes.push({ id, kind: 'gap', expected: head?.revision ?? 0, value });
    }
    return { sources: request, collection: basis.collection, gate: basis.gate, references: basis.references,
      writes, guards: sorted(uniqueTransactionGuards(guards)), existing };
  });
}
export function writeGaps(store: Store, request: GapRequest): OmResult<Sealed<GapRecords>> {
  requireStore(store); requireRequest(request);
  return outcome(() => {
    const prepared = take(prepareGaps(store, request));
    const written = prepared.writes.length ? take(writeGuarded<GapRecord>(store, { unit: 'G4', target: request.project,
      writes: prepared.writes as Write[], guards: prepared.guards })) : [];
    const records = [...prepared.existing, ...written].sort((a, b) => order(a.id, b.id));
    return { sources: prepared.sources as GapRequest, collection: prepared.collection as GapCollection,
      gate: prepared.gate as GapGate, records: records as Revision<GapRecord>[] };
  });
}
/** A historical set is complete only if it includes every gap rederived from its named sources. */
export function readGaps(store: Store, request: GapReadRequest): OmResult<Sealed<GapRecords>> {
  requireStore(store);
  if (!object(request) || !Array.isArray(request.records) || !request.records.every(isRef)) invalid('records');
  requireRequest(request.sources, true); request = copy(request);
  return outcome(() => historicalProof(store, { reader: 'D1.readGaps', project: request.sources.project, ref: request.sources.input,
    parameters: { sources: normalizedRequest(request.sources), records: sorted(request.records) } as unknown as Json },
  store => deriveGapRecords(store, request),
  () => reject('gap_record_forged', request.sources.project, 'records', 'A historical gap set cannot depend cyclically on itself')));
}
/** NR1 (№3600): the gap set as prepareGaps wrote it — one record per gap of a collection whose gate passed with no
 * refusal (a refused collection is never written) — read by exact references. The collection is those gaps in their
 * collectGaps order; nothing is materialized again. */
function deriveGapRecords(store: Store, request: GapReadRequest): GapRecords {
  const sources = normalizedRequest(request.sources), seen = new Set<string>();
  const records = request.records.map(ref => {
    if (seen.has(ref.id)) reject('gap_duplicate', ref.id, 'records', 'Each gap occurs once in the historical set');
    seen.add(ref.id);
    const row = take(readRecord<GapRecord>(store, ref,
      { unit: 'G4', target: ref.id, idPrefix: `om-gap:${sources.project}:`, kind: 'gap' })) as Revision<GapRecord>;
    // The request pairs these records with one source snapshot; each record names the snapshot it was written for.
    if (!same(row.value.sources, sources)) reject('gap_record_forged', row.id, 'sources', 'Historical rows must share the exact supplied snapshot');
    return row;
  }).sort((a, b) => order(a.id, b.id));
  const gaps = records.map(row => row.value.gap).sort((a, b) => order(a.id, b.id));
  return { sources, records, collection: { gaps, refusals: [] }, gate: { passed: true, codes: [], findings: [] } };
}

/** New work requires the exact saved current derivation, even when two eras yield the same empty set. */
export function prepareCurrentGaps(store: Store, request: GapReadRequest): OmResult<Sealed<PreparedGaps>> {
  return outcome(() => {
    const historical = take(readGaps(store, request));
    const prepared = take(prepareGaps(store, historical.sources as GapRequest));
    if (!same(prepared.sources, historical.sources) || prepared.writes.length
      || !same(sorted(prepared.existing.map(reference)), sorted(historical.records.map(reference))))
      reject('input_stale', historical.sources.project, 'gaps.sources', 'New work requires the complete saved current D1 contract and record set');
    return prepared;
  });
}

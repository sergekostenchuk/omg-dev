import { Ajv } from 'ajv';
import { canonical, digest, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { obligationPolicySchema, type CarriedObligation, type RuntimeCheck } from '../graph/obligation-policy.js';
import { LEVEL, type Graph } from '../graph/model.js';
import { projectGraph } from '../graph/project.js';
import { RefinementRelations } from '../graph/relations.js';
import type { Source } from '../evidence/evidence.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { readGapLines, type GapLinesRecord } from './gap-lines.js';
import { prepareCurrentGaps, readGaps, type GapReadRequest, type GapRecords, type GapRecord } from './gaps.js';
import { historicalRead, withHistoricalReads } from './input.js';
import { readFrameBasis } from './frame-obligations.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readRecord, writeGuarded } from './refs.js';
import { OM_LEDGER_ID_PREFIX, OM_OBLIGATION_CONTRACT, OM_PRODUCER_ID_PREFIX, registerOmObligationReaders,
  type OmObligationHandoff } from '../graph/om-obligation-readers.js';

// The contract constants and handoff type belong to the lower reader slot so
// that graph/runtime consumers never reach back into the OM unit; both names
// stay re-exported here for the existing OM consumers.
export { OM_OBLIGATION_CONTRACT } from '../graph/om-obligation-readers.js';
export type { OmObligationHandoff } from '../graph/om-obligation-readers.js';
export const OM_OWNER_ASSIGNMENT_CONTRACT = 'om-owner-gap-assignment/v1';
export const OM_OWNER_ASSIGNMENT_KIND = 'om-owner-gap-assignment';
export const OM_OBLIGATION_TRANSFER_CONTRACT = 'om-obligation-transfer/v1';
export const OM_OBLIGATION_TRANSFER_KIND = 'om-obligation-transfer';
export const OM_OBLIGATION_CODES = Object.freeze([
  'obligation_request_invalid', 'obligation_record_invalid', 'obligation_basis_missing',
  'obligation_ledger_missing', 'obligation_era_conflict', 'obligation_context_mismatch',
  'obligation_assignment_unresolved', 'obligation_assignment_invalid',
] as const);
export type OwnerAssignmentBasis = { record: Ref } | { pending: Write };
export interface ObligationContext { project: string; gaps: GapReadRequest; lines: Ref }
export interface ObligationRequest extends ObligationContext { assignments: OwnerAssignmentBasis[] }
export interface OwnerGapAssignment {
  contract: typeof OM_OWNER_ASSIGNMENT_CONTRACT; project: string;
  context: { gaps: GapReadRequest; lines: Ref }; gap: Ref;
  assignments: { responsibleNode: string; responsibleConsumer: string; reason: string; returnCondition: string;
    wake: CarriedObligation['wake']; runtimeCheck?: RuntimeCheck }[];
}
export interface ObligationTransferRequest {
  project: string; from: { producer: Ref; ledger: Ref; assignment: Ref };
  context: { gaps: GapReadRequest; lines: Ref }; gap: Ref;
}
export interface ObligationTransferRecord extends ObligationTransferRequest {
  contract: typeof OM_OBLIGATION_TRANSFER_CONTRACT; owner: Ref; assignments: OwnerGapAssignment['assignments'];
}
export interface ObligationTransfer {
  record: Revision<ObligationTransferRecord>; owner: Ref; assignments: OwnerGapAssignment['assignments']; inputs: Ref[];
}
export interface PreparedObligationTransfer extends ObligationTransfer { writes: Write[]; guards: Ref[] }
type AssignmentRecord = Revision<OwnerGapAssignment> | Revision<ObligationTransferRecord>;
export interface OmObligationRecord {
  contract: typeof OM_OBLIGATION_CONTRACT; project: string; request: ObligationRequest;
  assignments: Omit<CarriedObligation, 'scope'>[];
}
export interface OmObligationProducer {
  contract: typeof OM_OBLIGATION_CONTRACT; project: string; request: ObligationRequest; ledger: Ref;
}
export interface OmObligations {
  producer: Revision<OmObligationProducer>; record: Revision<OmObligationRecord>;
  handoff: OmObligationHandoff; inputs: Ref[];
}
export interface PreparedOmObligations extends OmObligations { writes: Write[]; guards: Ref[] }
export interface ReadOmObligationsRequest { project: string; producer: Ref }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
const unique = (values: readonly Ref[]): Ref[] => sorted([...new Map(values.map(ref => [canonical(ref), ref])).values()]);
function invalid(field: string): never {
  throw new EngineError('obligation_request_invalid', 'OM obligations need explicit source context and exact references',
    { unit: 'D7', target: 'om-obligations', field });
}
class ObligationFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: string, target: string, field: string, message: string, route: 'producer' | 'owner' = 'producer'): never {
  const result = refused(code, message, { unit: 'D7', target, field }, route);
  if (!result.ok) throw new ObligationFailure(result.refusal);
  throw new EngineError('obligation_internal', 'A refusal unexpectedly succeeded');
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new ObligationFailure(result.refusal); return result.value; }
function result<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof ObligationFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function requireStore(store: Store): void { if (!(store instanceof Store)) invalid('store'); }
function requireContext(request: ObligationContext): void {
  if (!object(request) || !text(request.project) || !object(request.gaps) || !object(request.gaps.sources)
    || !Array.isArray(request.gaps.records) || !request.gaps.records.every(isRef) || !isRef(request.lines)) invalid('request');
}
function requireRequest(request: ObligationRequest): void {
  requireContext(request);
  if (!Array.isArray(request.assignments) || !request.assignments.every((item: unknown) => object(item)
    && (Object.keys(item).length === 1 && isRef(item.record)
      || Object.keys(item).length === 1 && object(item.pending) && text(item.pending.id) && text(item.pending.kind)
        && item.pending.expected === 0 && object(item.pending.value)))) invalid('assignments');
  if (Object.keys(request).some(key => !['project', 'gaps', 'lines', 'assignments'].includes(key))) invalid('request.fields');
}
function namespace(project: string, producer: boolean): string { return `${producer ? OM_PRODUCER_ID_PREFIX : OM_LEDGER_ID_PREFIX}${project}:`; }
function row<T extends OmObligationRecord | OmObligationProducer>(value: T, producer: boolean): Revision<T> {
  const hash = hashJson(value);
  return { id: `${namespace(value.project, producer)}${hash}`, kind: producer ? 'om-obligation-basis' : 'om-obligations', revision: 1, hash, value };
}
interface Context { request: ObligationRequest; gaps: Sealed<GapRecords>; lines: Sealed<Revision<GapLinesRecord>>;
  graph: Graph; acceptedNodes: Set<string>; inputs: Ref[] }
function context(store: Store, request: ObligationRequest): Context {
  if (request.gaps.sources.project !== request.project)
    fail('obligation_context_mismatch', request.project, 'gaps.project', 'The complete gap set must belong to this project');
  let gaps: Sealed<GapRecords>;
  try { gaps = take(readGaps(store, request.gaps)); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'gap_request_invalid') invalid('gaps');
    throw error;
  }
  const normalized: ObligationRequest = { project: request.project,
    gaps: { sources: gaps.sources, records: sorted(gaps.records.map(reference)) }, lines: request.lines,
    assignments: sorted(request.assignments) } as ObligationRequest;
  const lines = take(readGapLines(store, { project: request.project, record: request.lines }));
  if (!same(lines.value.request.gaps.sources, normalized.gaps.sources)
    || !same(sorted(lines.value.request.gaps.records), normalized.gaps.records))
    fail('obligation_context_mismatch', request.lines.id, 'gaps', 'Line history and the full gap set must name the same exact source context');
  const sources = normalized.gaps.sources;
  const frames = [sources.operations, ...('frame' in sources.works ? [sources.works] : [])];
  const inputs = unique([request.lines, ...normalized.gaps.records, sources.input, sources.graph, sources.horizon,
    ...frames.flatMap(item => [item.frame.graph, item.frame.horizon, ...item.proposals,
      ...(item.frame.layer ? [item.frame.layer] : []), ...(item.frame.frame ? [item.frame.frame] : []),
      ...(item.frame.upper ? [item.frame.upper.horizon, ...(item.frame.upper.frame ? [item.frame.upper.frame] : [])] : [])]),
    ...('state' in sources.works ? [sources.works.layer] : [])]);
  const graph = take(readRecord<Graph>(store, sources.graph,
    { unit: 'D7', target: sources.graph.id, id: `graph:${request.project}`, kind: 'graph' })).value as Graph;
  const acceptedNodes = new Set<string>();
  for (const item of frames) {
    const frame = take(readFrameBasis(store, item.frame));
    for (const node of frame.upper.nodes) acceptedNodes.add(node.id);
    if (frame.accepted) for (const node of frame.accepted.graph.nodes)
      if (LEVEL[node.kind] <= item.frame.level) acceptedNodes.add(node.id);
    inputs.push(...frame.references);
  }
  const acceptedLevel = Math.max(...graph.nodes.filter(node => acceptedNodes.has(node.id)).map(node => LEVEL[node.kind])) as 1 | 2 | 3;
  const { level: _level, ...projection } = projectGraph(graph, acceptedLevel);
  // Both endpoints AND every relation along the responsibility path need acceptance.
  // Unaccepted lower edges cannot supply a bridge between accepted upper nodes.
  return { request: normalized, gaps, lines, graph: { ...projection, version: graph.version } as Graph,
    acceptedNodes, inputs: unique(inputs) };
}
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const distinct = (value: readonly unknown[]) => new Set(value.map(item => canonical(item))).size === value.length;
const runtimeShape = new Ajv({ allErrors: true }).compile<RuntimeCheck>(
  (obligationPolicySchema.properties.assignments as { items: { properties: { runtimeCheck: object } } }).items.properties.runtimeCheck);
function ownerInvalid(target: string, field: string, message: string): never {
  fail('obligation_assignment_invalid', target, field, message, 'owner');
}
/** H2 authenticates the owner and persists this distinct command contract. D7 checks its exact subject and contents;
 * a model proposal, an actor/status claim, or caller-supplied text is not a substitute for that producer record. */
export function normalizeOwnerGapAssignment(value: OwnerGapAssignment): Sealed<OwnerGapAssignment> {
  if (!object(value) || !keys(value, ['contract', 'project', 'context', 'gap', 'assignments'])
    || value.contract !== OM_OWNER_ASSIGNMENT_CONTRACT || !text(value.project) || !isRef(value.gap)
    || !object(value.context) || !keys(value.context, ['gaps', 'lines']) || !Array.isArray(value.assignments)) invalid('owner-assignment');
  requireContext({ project: value.project, ...value.context });
  for (const item of value.assignments) {
    if (!object(item) || !keys(item, ['responsibleNode', 'responsibleConsumer', 'reason', 'returnCondition', 'wake'], ['runtimeCheck'])
      || ![item.responsibleNode, item.responsibleConsumer, item.reason, item.returnCondition].every(text)
      || !(item.wake === null || object(item.wake) && keys(item.wake, ['nodes', 'paths', 'uiRequired'])
        && strings(item.wake.nodes) && strings(item.wake.paths) && typeof item.wake.uiRequired === 'boolean')
      || Object.hasOwn(item, 'runtimeCheck') && (!runtimeShape(item.runtimeCheck) || !text(item.runtimeCheck?.satisfies))) invalid('owner-assignment.fields');
  }
  return sealed({ ...value, context: { ...value.context, gaps: { ...value.context.gaps, records: sorted(value.context.gaps.records) } },
    assignments: sorted(value.assignments.map(item => ({ ...item,
      wake: item.wake === null ? null : { ...item.wake, nodes: sorted(item.wake.nodes), paths: sorted(item.wake.paths) },
      ...(item.runtimeCheck ? { runtimeCheck: { ...item.runtimeCheck, dependencies: sorted(item.runtimeCheck.dependencies),
        subjects: sorted(item.runtimeCheck.subjects), executables: sorted(item.runtimeCheck.executables) } } : {}) }))) });
}
function ownerNamespace(project: string): string { return `${OM_OWNER_ASSIGNMENT_KIND}:${project}:`; }
function ownerRow(value: OwnerGapAssignment): Revision<OwnerGapAssignment> {
  const hash = hashJson(value);
  return { id: `${ownerNamespace(value.project)}${hash}`, kind: OM_OWNER_ASSIGNMENT_KIND, revision: 1, hash, value };
}
function ownerRecord(store: Store, project: string, ref: Ref): Revision<OwnerGapAssignment> {
  const record = take(readRecord<OwnerGapAssignment>(store, ref,
    { unit: 'H2', target: ref.id, idPrefix: ownerNamespace(project), kind: OM_OWNER_ASSIGNMENT_KIND }));
  let normalized: OwnerGapAssignment;
  try { normalized = normalizeOwnerGapAssignment(record.value as OwnerGapAssignment) as OwnerGapAssignment; }
  catch (error) {
    if (error instanceof EngineError && error.code === 'obligation_request_invalid')
      ownerInvalid(ref.id, 'assignment', 'The owner command must contain the complete declared assignment contract');
    throw error;
  }
  if (normalized.project !== project || !same(record, ownerRow(normalized)))
    ownerInvalid(ref.id, 'record', 'The immutable H2 command must retain its exact canonical contents and project');
  return record as Revision<OwnerGapAssignment>;
}
function projectAssignment(store: Store, basis: Context, record: AssignmentRecord) {
  const value = record.value, expectedContext = { gaps: basis.request.gaps, lines: basis.request.lines };
  if (!same(value.context, expectedContext)) ownerInvalid(record.id, 'context', 'An assignment belongs to the exact full D1 and line context');
  const source = basis.gaps.records.find(row => same(reference(row), value.gap));
  if (!source || source.value.gap.moment === 'om-pass') ownerInvalid(record.id, 'gap', 'Name an exact late gap; a current OM question cannot be deferred by assignment');
  const gap = source.value.gap;
  const consumers = sorted(value.assignments.map(item => item.responsibleConsumer));
  if (!gap.consumers.length || !distinct(consumers) || !same(consumers, sorted(gap.consumers)))
    ownerInvalid(record.id, 'consumers', 'Assignments cover every normalized gap consumer exactly once, without merging');
  const relations = new RefinementRelations(basis.graph), inputs: Ref[] = [reference(record)];
  const assignments = value.assignments.map(item => {
    if (!basis.acceptedNodes.has(item.responsibleNode) || !basis.acceptedNodes.has(item.responsibleConsumer)
      || !relations.refines(item.responsibleNode, item.responsibleConsumer))
      ownerInvalid(record.id, 'responsibleNode', 'The responsible node and consumer must be accepted and belong to the same refinement');
    if (item.wake && (!distinct(item.wake.nodes) || !distinct(item.wake.paths)
      || item.wake.nodes.some(node => !basis.acceptedNodes.has(node))))
      ownerInvalid(record.id, 'wake', 'Explicit wake sets preserve distinct, accepted node identities');
    if (item.runtimeCheck) {
      const check = item.runtimeCheck;
      if (gap.kind !== 'environment-confirmation' || check.satisfies !== item.returnCondition
        || !distinct(check.dependencies) || !distinct(check.subjects) || !distinct(check.executables)
        || check.dependencies.some(ref => same(ref, check.script)))
        ownerInvalid(record.id, 'runtimeCheck', 'Execution is an explicit environment check of this entire return condition');
      for (const ref of [check.script, ...check.dependencies]) {
        const source = take(readRecord<Source>(store, ref,
          { unit: 'D7', target: ref.id, idPrefix: `source:${basis.request.project}:`, kind: 'source' }));
        const code = source.value, script = same(ref, check.script);
        if (!object(code) || code.projectId !== basis.request.project || !text(code.content)
          || digest(code.content) !== code.sha256 || !object(code.origin) || !text(code.origin.location)
          || !['text/plain', 'application/json'].includes(code.mediaType)
          || (script ? !(code.mediaType === 'text/plain' && (code.origin.kind === 'file' && code.origin.location.endsWith('.mjs')
            || code.origin.kind === 'owner-document' && !code.provenance && check.dependencies.length === 0)) : code.origin.kind !== 'file'))
          ownerInvalid(record.id, 'runtimeCheck.sources', 'Declare exact repository modules or a self-contained operator module');
        inputs.push(ref);
      }
    }
    return { obligation: gap.id, original: { record: reference(source), pointer: '/gap' }, kind: gap.kind,
      moment: gap.moment === 'feasibility' ? 'R3' as const : gap.moment as 'task-start' | 'task-result', neededForR2: false,
      ...item };
  });
  return { assignments: sorted(assignments), inputs };
}
export function readOwnerGapAssignment(store: Store, request: { project: string; record: Ref }) {
  requireStore(store);
  if (!object(request) || !text(request.project) || !isRef(request.record)) invalid('owner-read');
  return result(() => {
    const record = ownerRecord(store, request.project, request.record);
    const basis = context(store, { project: request.project, ...record.value.context, assignments: [] });
    const verified = projectAssignment(store, basis, record);
    return { record, ...verified, inputs: unique([...basis.inputs, ...verified.inputs]) };
  });
}
function transferNamespace(project: string): string { return `${OM_OBLIGATION_TRANSFER_KIND}:${project}:`; }
function transferRow(value: ObligationTransferRecord): Revision<ObligationTransferRecord> {
  const hash = hashJson(value);
  return { id: `${transferNamespace(value.project)}${hash}`, kind: OM_OBLIGATION_TRANSFER_KIND, revision: 1, hash, value };
}
function requireTransfer(request: ObligationTransferRequest): void {
  if (!object(request) || !keys(request, ['project', 'from', 'context', 'gap']) || !text(request.project)
    || !object(request.from) || !keys(request.from, ['producer', 'ledger', 'assignment'])
    || ![request.from.producer, request.from.ledger, request.from.assignment, request.gap].every(isRef)
    || !object(request.context) || !keys(request.context, ['gaps', 'lines'])) invalid('transfer');
  requireContext({ project: request.project, ...request.context });
  const sources = request.context.gaps.sources;
  if (!text(sources.project) || ![sources.input, sources.graph, sources.horizon].every(isRef)) invalid('transfer.sources');
  for (const [name, level] of [['operations', 2], ['works', 3]] as const) {
    const source = sources[name];
    if (name === 'works' && object(source) && Object.hasOwn(source, 'state')) {
      if (source.state !== 'upper-not-accepted' || !isRef(source.layer)) invalid('transfer.sources.works');
      continue;
    }
    if (!object(source) || !Array.isArray(source.proposals) || !source.proposals.every(isRef) || !object(source.frame)) invalid('transfer.sources.frame');
    const frame = source.frame;
    if (!text(frame.project) || frame.level !== level || ![frame.graph, frame.horizon].every(isRef)
      || (frame.frame !== null && !isRef(frame.frame)) || (frame.layer !== null && !isRef(frame.layer))
      || (level === 2 ? frame.upper !== null : !object(frame.upper) || !isRef(frame.upper.horizon)
        || (frame.upper.frame !== null && !isRef(frame.upper.frame)))) invalid('transfer.sources.frame');
  }
}
function assignmentRecord(store: Store, project: string, ref: Ref): { record: AssignmentRecord; inputs: Ref[]; owner: Ref } {
  if (ref.id.startsWith(transferNamespace(project))) {
    const transfer = loadTransfer(store, project, ref);
    return { record: transfer.record, inputs: transfer.inputs, owner: transfer.owner };
  }
  const record = ownerRecord(store, project, ref);
  return { record, inputs: [reference(record)], owner: reference(record) };
}
function deriveTransfer(store: Store, request: ObligationTransferRequest): ObligationTransfer {
  const previous = load(store, request.project, request.from.producer);
  if (!same(reference(previous.record), request.from.ledger)
    || !previous.producer.value.request.assignments.some(item => 'record' in item && same(item.record, request.from.assignment)))
    ownerInvalid(request.from.assignment.id, 'from', 'The source assignment must belong to the exact complete prior OM ledger');
  const original = assignmentRecord(store, request.project, request.from.assignment);
  const basis = context(store, { project: request.project, ...request.context, assignments: [] });
  const oldSources = previous.producer.value.request.gaps.sources, nextSources = basis.request.gaps.sources;
  if ('state' in oldSources.works || 'state' in nextSources.works
    || !same({ ...oldSources, works: { ...oldSources.works, proposals: [] } },
      { ...nextSources, works: { ...nextSources.works, proposals: [] } }))
    ownerInvalid(request.from.assignment.id, 'context', 'F5 transfer changes only the checked work proposals of the same exact input, graph, horizon and frames');
  const oldGap = take(readRecord<GapRecord>(store, original.record.value.gap,
    { unit: 'D7', target: request.from.assignment.id, idPrefix: `om-gap:${request.project}:`, kind: 'gap' }));
  const nextGap = basis.gaps.records.find(record => same(reference(record), request.gap));
  if (!nextGap || nextGap.value.gap.moment === 'om-pass' || !same(oldGap.value.gap, nextGap.value.gap))
    ownerInvalid(request.gap.id, 'gap', 'A transfer preserves the entire proved late gap, including its evidence, consumers and deferral');
  const value: ObligationTransferRecord = { contract: OM_OBLIGATION_TRANSFER_CONTRACT, project: request.project,
    from: request.from, context: { gaps: basis.request.gaps, lines: basis.request.lines }, gap: reference(nextGap),
    owner: original.owner, assignments: original.record.value.assignments };
  const record = transferRow(value), projected = projectAssignment(store, basis, record);
  return { record, owner: original.owner, assignments: value.assignments,
    inputs: unique([...previous.inputs, ...original.inputs, ...basis.inputs, ...projected.inputs,
      request.from.producer, request.from.ledger, request.from.assignment, original.owner]) };
}
function loadTransfer(store: Store, project: string, ref: Ref): ObligationTransfer {
  return historicalRead(store, { reader: 'D7.obligation-transfer', project, ref }, () => {
    const record = take(readRecord<ObligationTransferRecord>(store, ref,
      { unit: 'D7', target: ref.id, idPrefix: transferNamespace(project), kind: OM_OBLIGATION_TRANSFER_KIND }));
    const value = record.value;
    if (!object(value) || !keys(value, ['contract', 'project', 'from', 'context', 'gap', 'owner', 'assignments'])
      || value.contract !== OM_OBLIGATION_TRANSFER_CONTRACT || value.project !== project || !isRef(value.owner)
      || !Array.isArray(value.assignments) || !value.assignments.every(object))
      ownerInvalid(ref.id, 'transfer', 'A saved transfer needs its explicit contract and complete derived owner assignment');
    const request = { project: value.project, from: value.from, context: value.context, gap: value.gap } as ObligationTransferRequest;
    try { requireTransfer(request); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'obligation_request_invalid')
        ownerInvalid(ref.id, 'transfer', 'The saved transfer must retain every exact source and target reference');
      throw error;
    }
    const derived = deriveTransfer(store, request);
    if (!same(record, derived.record)) ownerInvalid(ref.id, 'transfer', 'The transfer is derived from original H2 authority, not from caller-supplied replacement fields');
    return sealed(derived) as ObligationTransfer;
  }, () => ownerInvalid(ref.id, 'transfer', 'Obligation transfer history contains a cycle'));
}
/** F5 records a derived transfer; only the original H2 command grants the assignment. */
export function readObligationTransfer(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<ObligationTransfer>> {
  requireStore(store);
  if (!object(request) || !keys(request, ['project', 'record']) || !text(request.project) || !isRef(request.record)) invalid('transfer-read');
  return result(() => loadTransfer(store, request.project, request.record));
}
const authorityRef = (project: string, ref: Ref): boolean => [ownerNamespace(project), transferNamespace(project),
  namespace(project, true), namespace(project, false), `source:${project}:`].some(prefix => ref.id.startsWith(prefix));
function currentAuthority(store: Store, inputs: Ref[], writes: Write[]): Ref[] {
  const guards: Ref[] = [];
  for (const ref of inputs) {
    if (writes.some(write => write.id === ref.id)) continue;
    const current = store.get(ref.id);
    if (!current || !same(reference(current), ref)) fail('input_stale', ref.id, 'assignment', 'New handoff admission uses current assignment authorities and source snapshots');
    guards.push(ref);
  }
  return guards;
}
export function prepareObligationTransfer(store: Store, request: ObligationTransferRequest): OmResult<Sealed<PreparedObligationTransfer>> {
  requireStore(store); requireTransfer(request); request = sealed(request) as ObligationTransferRequest;
  return result(() => {
    const derived = deriveTransfer(store, request), fresh = take(prepareCurrentGaps(store, derived.record.value.context.gaps));
    const lines = store.get(request.context.lines.id);
    if (!lines || !same(reference(lines), request.context.lines))
      fail('input_stale', request.context.lines.id, 'lines', 'A new assignment transfer uses the current target line history');
    const existing = store.get(derived.record.id), writes: Write[] = [];
    if (existing) {
      if (!same(existing, derived.record)) ownerInvalid(existing.id, 'transfer', 'The exact transfer address is already occupied');
    } else writes.push({ id: derived.record.id, kind: derived.record.kind, expected: 0, value: derived.record.value });
    const guards = unique([...fresh.guards, request.context.lines,
      ...currentAuthority(store, derived.inputs.filter(ref => authorityRef(request.project, ref)), writes)]);
    return { ...derived, writes, guards };
  });
}
/** The same projection checks H2 authority during preparation and historical consumption. */
function assignments(store: Store, basis: Context): OmObligationRecord['assignments'] {
  const late = basis.gaps.collection.gaps.filter(gap => gap.moment !== 'om-pass');
  const records = basis.request.assignments.map(item => {
    if (!('record' in item)) invalid('saved.assignments');
    const checked = assignmentRecord(store, basis.request.project, item.record);
    basis.inputs.push(...checked.inputs);
    return checked.record;
  });
  if (!distinct(records.map(record => record.value.gap))) ownerInvalid(basis.request.project, 'assignments', 'A gap has exactly one complete owner assignment');
  const projected = records.flatMap(record => {
    const value = projectAssignment(store, basis, record); basis.inputs.push(...value.inputs); return value.assignments;
  });
  for (const gap of late) if (!projected.some(row => row.obligation === gap.id))
    fail('obligation_assignment_unresolved', gap.target, gap.field,
      'H2 must record the missing owner assignment for this late gap; its question remains open', 'owner');
  return sorted(projected);
}
function derive(store: Store, basis: Context): OmObligations {
  const record = row<OmObligationRecord>({ contract: OM_OBLIGATION_CONTRACT, project: basis.request.project,
    request: basis.request, assignments: assignments(store, basis) }, false);
  const producer = row<OmObligationProducer>({ contract: OM_OBLIGATION_CONTRACT, project: basis.request.project,
    request: basis.request, ledger: reference(record) }, true);
  return { record, producer, handoff: { era: OM_OBLIGATION_CONTRACT, producer: reference(producer), scope: reference(record),
    obligations: record.value.assignments.map(assignment => ({ ...assignment, scope: reference(record) })) },
  inputs: handoffInputs(basis.request.project, basis.inputs, record, producer) };
}
function handoffInputs(project: string, inputs: readonly Ref[], record: Revision<OmObligationRecord>, producer: Revision<OmObligationProducer>): Ref[] {
  // Prior producer/ledger pairs prove transfer authority; they are not additional
  // handoffs for the new consumer. The transfer retains them, and preparation
  // guards the complete internal basis, while public inputs select this one era.
  return unique([...inputs.filter(ref => !ref.id.startsWith(namespace(project, true))
    && !ref.id.startsWith(namespace(project, false))), reference(record), reference(producer)]);
}
function checked(found: Revision<unknown> | Sealed<Revision<unknown>>, expected: Revision<unknown>): void {
  if (!same(found, expected)) fail('obligation_record_invalid', found.id, 'record',
    'The immutable obligation record must be derived from its complete exact sources');
}
function load(store: Store, project: string, ref: Ref): OmObligations {
  return historicalRead(store, { reader: 'D7.obligations', project, ref },
    () => sealed(loadRecord(store, project, ref)) as OmObligations,
    () => ownerInvalid(ref.id, 'history', 'The obligation producer history contains a cycle'));
}
function loadRecord(store: Store, project: string, ref: Ref): OmObligations {
  const producer = take(readRecord<OmObligationProducer>(store, ref,
    { unit: 'D7', target: ref.id, idPrefix: namespace(project, true), kind: 'om-obligation-basis' }));
  const value = producer.value;
  if (!object(value) || value.contract !== OM_OBLIGATION_CONTRACT || value.project !== project || !isRef(value.ledger))
    fail('obligation_record_invalid', ref.id, 'producer', 'An OM producer needs its declared era, exact context and mandatory ledger');
  try { requireRequest(value.request as ObligationRequest); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'obligation_request_invalid')
      fail('obligation_record_invalid', ref.id, 'request', 'The saved producer context is incomplete');
    throw error;
  }
  if (value.request.project !== project) fail('obligation_context_mismatch', ref.id, 'project', 'The producing request is foreign');
  const expected = derive(store, context(store, value.request as ObligationRequest));
  checked(producer, expected.producer);
  const record = take(readRecord<OmObligationRecord>(store, value.ledger,
    { unit: 'D7', target: value.ledger.id, idPrefix: namespace(project, false), kind: 'om-obligations' }));
  checked(record, expected.record);
  return expected;
}
export function readOmObligations(store: Store, request: ReadOmObligationsRequest): OmResult<Sealed<OmObligations>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !isRef(request.producer)) invalid('read');
  return result(() => load(store, request.project, request.producer));
}
/** D8 and execution receive the carried scope. Resolve it through the same complete producer proof. */
export function readOmObligationLedger(store: Store, request: { project: string; ledger: Ref }): OmResult<Sealed<OmObligations>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !isRef(request.ledger)) invalid('ledger-read');
  return result(() => {
    const ledger = take(readRecord<OmObligationRecord>(store, request.ledger,
      { unit: 'D7', target: request.ledger.id, idPrefix: namespace(request.project, false), kind: 'om-obligations' }));
    if (!object(ledger.value) || ledger.value.contract !== OM_OBLIGATION_CONTRACT || ledger.value.project !== request.project)
      fail('obligation_record_invalid', ledger.id, 'ledger', 'The carried scope must retain its exact OM producer contract');
    try { requireRequest(ledger.value.request as ObligationRequest); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'obligation_request_invalid')
        fail('obligation_record_invalid', ledger.id, 'request', 'The saved ledger context is incomplete');
      throw error;
    }
    const producer = row<OmObligationProducer>({ contract: OM_OBLIGATION_CONTRACT, project: request.project,
      request: ledger.value.request as ObligationRequest, ledger: request.ledger }, true);
    const verified = load(store, request.project, reference(producer));
    checked(ledger, verified.record);
    return verified;
  });
}
export function prepareOmObligations(store: Store, request: ObligationRequest): OmResult<Sealed<PreparedOmObligations>> {
  requireStore(store); requireRequest(request);
  request = sealed(request) as ObligationRequest;
  return result(() => {
    const pending = new Map<string, AssignmentRecord>(), writes: Write[] = [];
    const normalized = { ...request, assignments: request.assignments.map(item => {
      if ('record' in item) return item;
      const write = item.pending;
      // A pending authority follows the same exact H2 or derived-transfer reader.
      const record = { id: write.id, kind: write.kind, revision: 1, hash: hashJson(write.value), value: write.value } as AssignmentRecord;
      if (pending.has(write.id)) ownerInvalid(write.id, 'pending', 'The transaction cannot contain ambiguous owner commands');
      pending.set(write.id, record);
      const existing = store.get(write.id);
      if (existing) {
        if (existing.revision !== 1) fail('input_stale', write.id, 'assignment', 'The pending owner command has advanced since this exact request');
        if (!same(existing, record)) ownerInvalid(write.id, 'pending', 'The owner command address is already occupied');
      }
      else writes.push(write);
      return { record: reference(record) };
    }) };
    const view = new Proxy(store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => {
        const record = pending.get(id);
        return record && (revision === undefined || revision === record.revision) ? record : target.get(id, revision);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const basis = context(view, normalized), derived = derive(view, basis);
    const fresh = take(prepareCurrentGaps(store, basis.request.gaps));
    const currentLines = store.get(request.lines.id);
    if (!currentLines || !same(reference(currentLines), request.lines))
      fail('input_stale', request.lines.id, 'lines', 'New handoff admission uses current line history');
    const guards = [...fresh.guards, request.lines];
    guards.push(...currentAuthority(store, basis.inputs.filter(ref => authorityRef(request.project, ref)), writes));
    for (const expected of [derived.record, derived.producer]) {
      const existing = store.get(expected.id);
      if (existing) { checked(existing, expected); guards.push(reference(existing)); }
      else writes.push({ id: expected.id, kind: expected.kind, expected: 0, value: expected.value });
    }
    return { ...derived, writes, guards: unique(guards), inputs: handoffInputs(request.project,
      [...derived.inputs, ...fresh.references, ...fresh.guards], derived.record, derived.producer) };
  });
}
export function writeOmObligations(store: Store, request: ObligationRequest): OmResult<Sealed<PreparedOmObligations>> {
  requireStore(store); requireRequest(request);
  return result(() => {
    const prepared = take(prepareOmObligations(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'D7', target: prepared.producer.id,
      writes: prepared.writes, guards: prepared.guards }));
    return prepared as PreparedOmObligations;
  });
}
/** The producing record selects the era; absence of its ledger never means legacy. */
export function readOmObligationHandoff(store: Store, project: string, inputs: Ref[]): OmResult<Sealed<OmObligationHandoff | null>> {
  requireStore(store);
  if (!text(project) || !Array.isArray(inputs) || !inputs.every(isRef)) invalid('inputs');
  return result(() => {
    const producers = inputs.filter(ref => ref.id.startsWith(OM_PRODUCER_ID_PREFIX));
    const ledgers = inputs.filter(ref => ref.id.startsWith(OM_LEDGER_ID_PREFIX));
    if (!producers.length && !ledgers.length) return null;
    if (inputs.some(ref => /^phase:.*:(R2|L3)$/.test(ref.id)))
      fail('obligation_era_conflict', project, 'inputs', 'One consumer cannot combine legacy research and OM obligation eras');
    if (producers.length !== 1) fail('obligation_basis_missing', project, 'producer', 'Exactly one explicit OM producer establishes the handoff era');
    if (ledgers.length !== 1) fail('obligation_ledger_missing', producers[0]!.id, 'ledger', 'The OM era requires its explicit complete ledger, including an empty one');
    const saved = load(store, project, producers[0]!);
    if (!same(ledgers[0], reference(saved.record)))
      fail('obligation_ledger_missing', producers[0]!.id, 'ledger', 'The consumer must retain the exact ledger named by its producer');
    return saved.handoff;
  });
}

// Loading this unit installs both complete readers in the lower slot; the slot
// calls nothing at registration and lower consumers refuse an empty slot.
registerOmObligationReaders({
  handoff: readOmObligationHandoff,
  ledger: readOmObligationLedger,
});

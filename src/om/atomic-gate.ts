import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { loadTaskSpecification, preplanTaskContext } from '../compiler/context.js';
import { deriveTasks } from '../compiler/derive.js';
import { resolveExternalSource } from '../compiler/inputs.js';
import { TASK_CONTEXT_CONTRACT, BASIS_TASK_CONTEXT_CONTRACT, isTaskContextContract, type TaskContextContract, type TaskInput } from '../compiler/model.js';
import { readWriter, type WriterProof } from '../ownership/owners.js';
import type { Environment, ExecutionRoot } from '../runtime/environment.js';
import type { Graph } from '../graph/model.js';
import type { CarriedObligation } from '../graph/obligation-policy.js';
import { RefinementRelations } from '../graph/relations.js';
import { bindTaskObligations, taskBindingId, taskObligations } from '../graph/task-obligations.js';
import type { TaskObligationBinding } from '../graph/task-obligation-model.js';
import { safeRelativePath } from '../graph/topology.js';
import { validateGraph } from '../graph/validate.js';
import { isRef, reference, type Finding, type Ref } from '../pipeline/contracts.js';
import { noteUntracedRead, Store, type TransactionGuard, type Revision, type Write } from '../storage/store.js';
import { provenReads, registerSourceOverlay } from '../storage/store-view.js';
import { readCapacity as readCapacityOf } from './capacity.js';
import { taskSpecificationReader } from './task-specification.js';
import { hasBasisApplications } from './selected-specification.js';
import { readDeliveries as readDeliveriesOf } from './deliveries.js';
import { prepareSettleCandidate as prepareSettleCandidateOf, readAcceptedFrame as readAcceptedFrameOf, readRejectedCandidate as readRejectedCandidateOf, type AcceptedFrameRequest } from './frame-accept.js';
import type { CandidateRequest, FrameCandidateRecord } from './frame-candidate.js';
import { WORKS_FRAME_CONTRACT } from './frame-obligations.js';
import { isFrameAttemptBinding, type FrameAttemptBinding } from './layer-basis.js';
import type { ProposalRequest } from './frame-proposals.js';
import { prepareGapLines as prepareGapLinesOf, readGapLines as readGapLinesOf } from './gap-lines.js';
import { prepareCurrentGaps as prepareCurrentGapsOf, prepareGaps as prepareGapsOf, readGaps as readGapsOf, type GapCollection, type GapReadRequest, type GapRequest } from './gaps.js';
import { withHistoricalReads, historicalRead, readOmInput as readOmInputOf, type OmInput } from './input.js';
import { readPartAssembly as readPartAssemblyOf, readReuseResult as readReuseResultOf } from './model-call.js';
import { prepareNeighbors as prepareNeighborsOf, readNeighbors as readNeighborsOf, type NeighborCollection } from './neighbors.js';
import { prepareObligationTransfer as prepareObligationTransferOf, prepareOmObligations as prepareOmObligationsOf, readObligationTransfer as readObligationTransferOf, readOmObligations as readOmObligationsOf,
  type ObligationRequest, type OmObligationHandoff, type OmObligations } from './obligations.js';
import { readPartResult as readPartResultOf, readQuestionPacket as readQuestionPacketOf, type WorksPartBindings } from './question-packet.js';
import { declarationUnknown, declares, deriveImpact, impactCoverage, readSnapshot, validSnapshot, type ImpactCoverage, type ImpactResolution, type ImpactUnknown,
  type RepositorySnapshot, type SnapshotFiles, type WorkImpact } from './impact.js';
import { readRecord as readRecordOf, writeGuarded as writeGuardedOf, type GuardedWrite, type RecordRequest } from './refs.js';
import { delivered, isPlainObject, localErrors, localRefusals, sealed, transfer, transferError, transferring, type OmResult, type Refusal,
  type Sealed, type SourceCodes } from './refusal.js';
import type { Json } from '../canonical.js';
import { prepareWorksFrame as prepareWorksFrameOf, readWorksFrame as readWorksFrameOf } from './works-frame.js';

/** Q2b (№2518): every refusal code G5 creates itself, from the actual places of issue; its exceptions apart. */
export const ATOMIC_GATE_LOCAL_CODES = Object.freeze(['atomic_gate_basis_unproven', 'atomic_gate_bindings_unproven',
  'atomic_gate_record_forged', 'atomic_gate_transaction_conflict', 'input_stale', 'obligation_assignment_invalid', 'packet_foreign',
  'work_blocking_gap_open'] as const);
export type AtomicGateLocalCode = typeof ATOMIC_GATE_LOCAL_CODES[number];
export const ATOMIC_GATE_ERROR_CODES = Object.freeze(['atomic_gate_request_invalid', 'atomic_gate_internal'] as const);
export type AtomicGateErrorCode = typeof ATOMIC_GATE_ERROR_CODES[number];
/** The units whose refusals G5 hands on: its readers, and the compiler's resolution of an external task source (its
 * exceptions, through the exact earlier filter SOURCE_UNFIT). */
export type AtomicGateSource = 'refs' | 'capacity' | 'deliveries' | 'frame-accept' | 'gap-lines' | 'gaps' | 'model-call' | 'neighbors'
  | 'obligations' | 'question-packet' | 'works-frame' | 'compiler-inputs' | 'wake-choice' | 'input';
export type AtomicGateCode = AtomicGateLocalCode | SourceCodes<AtomicGateSource>;
export type AtomicGateResult<T> = OmResult<T, AtomicGateCode>;

const readTaskSpecification = taskSpecificationReader();
const readCapacity = transferring('capacity', readCapacityOf);
const readDeliveries = transferring('deliveries', readDeliveriesOf);
const prepareSettleCandidate = transferring('frame-accept', prepareSettleCandidateOf);
const readAcceptedFrame = transferring('frame-accept', readAcceptedFrameOf);
const readRejectedCandidate = transferring('frame-accept', readRejectedCandidateOf);
const prepareGapLines = transferring('gap-lines', prepareGapLinesOf);
const readGapLines = transferring('gap-lines', readGapLinesOf);
const prepareCurrentGaps = transferring('gaps', prepareCurrentGapsOf);
const prepareGaps = transferring('gaps', prepareGapsOf);
const readGaps = transferring('gaps', readGapsOf);
const readPartAssembly = transferring('model-call', readPartAssemblyOf);
const readReuseResult = transferring('model-call', readReuseResultOf);
const prepareNeighbors = transferring('neighbors', prepareNeighborsOf);
const readNeighbors = transferring('neighbors', readNeighborsOf);
const readOmInput = transferring('input', readOmInputOf);
const prepareObligationTransfer = transferring('obligations', prepareObligationTransferOf);
const prepareOmObligations = transferring('obligations', prepareOmObligationsOf);
const readObligationTransfer = transferring('obligations', readObligationTransferOf);
const readOmObligations = transferring('obligations', readOmObligationsOf);
const readPartResult = transferring('question-packet', readPartResultOf);
const readQuestionPacket = transferring('question-packet', readQuestionPacketOf);
const prepareWorksFrame = transferring('works-frame', prepareWorksFrameOf);
const readWorksFrame = transferring('works-frame', readWorksFrameOf);
const readRecord = <T = Json>(store: Store, reference: unknown, request: RecordRequest) => transfer('refs', readRecordOf<T>(store, reference, request));
const writeGuarded = <T = Json>(store: Store, request: GuardedWrite) => transfer('refs', writeGuardedOf<T>(store, request));

export const ATOMIC_GATE_CONTRACT = 'om-atomic-gate/v1' as const;
/**
 * AT1 (№4091 п.5, п.6): the gate of the impact era — its request names the one repository snapshot its works were answered
 * against (null when their packets had none), and its record keeps the exact inventory and coverage its producer derived.
 * A reader takes them as saved; M8 issues the plan only on that very tree.
 */
export const ATOMIC_GATE_IMPACT_CONTRACT = 'om-atomic-gate/v2' as const;
export interface AtomicGateImpact { snapshot: RepositorySnapshot | null; works: (WorkImpact & { coverage: ImpactCoverage['covered'] })[];
  /** Return №4147: the exact parser the inventory of the snapshot was read with — part of its basis (none without a snapshot). */
  parser?: string;
  /** №4170: what the inventory does not establish — a limit of its completeness, saved with it (none without a snapshot). */
  boundary?: string[];
  /** AT1 door (№4105): the accepted resolutions of this snapshot's transitions B1 held, each by its readiness question. */
  resolutions?: (ImpactResolution & { question: string })[];
  /** AT1 (№4117): the policies the horizon's works need, each with the readiness question whose decision B1 holds. */
  policies?: PolicyRow[] }
// LP5 (№3278 §3): a reuse — a paid complete L3 assembly admitted again into a later attempt, with today's D7 bindings.
export interface WorkProposalSource { kind: 'part' | 'assembly' | 'reuse'; record: Ref }
export interface AtomicGateRequest {
  project: string; candidate: Ref; neighbors: Ref; environment: Ref; gaps: GapReadRequest; results: WorkProposalSource[]; sources: Ref[];
  /** AT1: the exact snapshot the originating packets were answered against, or its legal null when they had none. */
  snapshot: RepositorySnapshot | null;
  taskContextContract?: TaskContextContract;
}
export type IssuedGateRequest = AtomicGateRequest & { taskContextContract: TaskContextContract };
export interface AtomicGateRecord {
  contract: typeof ATOMIC_GATE_CONTRACT | typeof ATOMIC_GATE_IMPACT_CONTRACT; project: string; request: AtomicGateRequest;
  result: { gate: 'G5'; candidate: Ref; graphHash: string; passed: boolean; codes: string[]; findings: Finding[] };
  impact?: AtomicGateImpact;
}
export interface PreparedAtomicGate { record: Revision<AtomicGateRecord>; writes: Write[]; guards: TransactionGuard[]; references: Ref[] }
const object = isPlainObject;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const unique = <T>(values: readonly T[]): T[] => sorted([...new Map(values.map(v => [canonical(v), v])).values()]);
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
const refuse = localRefusals(ATOMIC_GATE_LOCAL_CODES);
// Annotated explicitly: only a declared `never` makes a bare call end the control flow for tsc.
const raise: (code: AtomicGateErrorCode, message: string, details?: unknown) => never = localErrors(ATOMIC_GATE_ERROR_CODES);
class GateFailure extends Error { constructor(readonly refusal: Refusal<AtomicGateCode>) { super(refusal.message); } }
function fail(code: AtomicGateLocalCode, target: string, field: string, message: string): never {
  const result = refuse(code, message, { unit: 'G5', target, field }, 'producer');
  if (!result.ok) throw new GateFailure(result.refusal);
  return raise('atomic_gate_internal', 'A refusal unexpectedly succeeded');
}
function take<T>(result: OmResult<T, AtomicGateCode>): T { if (!result.ok) throw new GateFailure(result.refusal); return result.value; }
function run<T>(action: () => T): AtomicGateResult<Sealed<T>> {
  return withHistoricalReads(() => { try { return delivered(action()); }
    catch (error) { if (error instanceof GateFailure) return { ok: false, refusal: error.refusal }; throw error; } });
}
function invalid(field: string): never {
  return raise('atomic_gate_request_invalid', 'G5 needs explicit exact sources', { unit: 'G5', target: 'works', field });
}
function sourcesShape(sources: unknown): sources is WorkProposalSource[] {
  return Array.isArray(sources) && sources.every(source => object(source) && ['part', 'assembly', 'reuse'].includes(source.kind as string)
    && isRef(source.record) && Object.keys(source).every(key => ['kind', 'record'].includes(key)))
    && new Set(sources.map(canonical)).size === sources.length;
}
function sourcesRefs(value: unknown): value is Ref[] {
  return Array.isArray(value) && value.every(isRef) && new Set(value.map(ref => ref.id)).size === value.length;
}
function requireRequest(store: Store, request: AtomicGateRequest): void {
  if (!(store instanceof Store) || !object(request) || !text(request.project)
    || ![request.candidate, request.neighbors, request.environment].every(isRef) || !object(request.gaps)
    || !sourcesShape(request.results) || !sourcesRefs(request.sources)
    || request.snapshot !== null && !validSnapshot(request.snapshot)
    || Object.hasOwn(request, 'taskContextContract') && !isTaskContextContract(request.taskContextContract)
    || Object.keys(request).some(key => !['project', 'candidate', 'neighbors', 'environment', 'gaps', 'results', 'sources', 'snapshot', 'taskContextContract'].includes(key))) invalid('request');
}

const normalizedGateRequest = <T extends AtomicGateRequest>(request: T): T =>
  ({ ...copy(request), sources: sorted(request.sources), results: sorted(request.results) });
const gateId = (request: AtomicGateRequest) => `om-atomic-gate:${request.project}:${hashJson(request)}`;
function issuedRequest(store: Store, request: AtomicGateRequest): IssuedGateRequest {
  request = normalizedGateRequest(request);
  // New work derives the contract from its immutable B1 producers, never field presence.
  const input = take(readOmInput(store, request.project, request.gaps.sources.input)).value.input;
  const contract = hasBasisApplications(input.sources) ? BASIS_TASK_CONTEXT_CONTRACT : TASK_CONTEXT_CONTRACT;
  if (request.taskContextContract !== undefined && request.taskContextContract !== contract)
    invalid('taskContextContract');
  return { ...request, taskContextContract: contract };
}

/** A preview has the same exact revisions as the one final transaction; it never writes to the store. */
class Transaction {
  readonly writes = new Map<string, Write>();
  readonly guards: TransactionGuard[] = [];
  readonly view: Store;
  constructor(readonly store: Store) {
    const row = (write: Write): Revision<unknown> => ({ id: write.id, kind: write.kind, revision: write.expected + 1,
      hash: hashJson(write.value), value: write.value });
    // S1.4 (№2410): a preview answers from its own pending writes, so a proof reading it — even while it still delegates
    // down — has a dependency no Store reports; such a proof stays incomplete.
    const get = (id: string, revision?: number) => {
      noteUntracedRead();
      const pending = this.writes.get(id);
      return pending && (revision === undefined || revision === pending.expected + 1) ? row(pending) : store.get(id, revision);
    };
    const list = (kind?: string) => {
      noteUntracedRead();
      const records = new Map(store.list<unknown>(kind).map(record => [record.id, record]));
      for (const write of this.writes.values()) { records.delete(write.id); if (!kind || write.kind === kind) records.set(write.id, row(write)); }
      return [...records.values()].sort((a, b) => order(a.id, b.id));
    };
    const history = (id: string) => { noteUntracedRead(); const pending = this.writes.get(id); return [...store.history(id), ...(pending ? [row(pending)] : [])]; };
    if (provenReads(store)) {
      // S1.1 (№1942-2, №2008-1): over reads proved to be a genuine Store's (the instance, or a write-only view of the
      // storage helper's own making) the preview is a frozen source view of its own, no Proxy — the common cache keeps
      // each proof of the acceptance once per transaction; the region is the transaction's, never the Store's or another
      // transaction's. The reading members live on the prototype, so an outer historicalTrace may wrap the view lawfully.
      const methods = Object.create(Store.prototype) as Store;
      const view = Object.create(methods) as Store;
      Object.defineProperty(view, 'path', { value: store.path });
      for (const name of Object.getOwnPropertyNames(Store.prototype)) {
        if (name === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(Store.prototype, name)!;
        if (descriptor.get) { Object.defineProperty(methods, name, { get: () => Reflect.get(store, name, store) }); continue; }
        const member: unknown = Reflect.get(store, name, store);
        if (typeof member === 'function') Object.defineProperty(methods, name,
          { value: name === 'get' ? get : name === 'list' ? list : name === 'history' ? history : member.bind(store) });
      }
      Object.freeze(methods);
      this.view = Object.freeze(view) as Store;
      registerSourceOverlay(this.view);
      return;
    }
    // Over a traced Store, a caller's Proxy, a frozen shell with its own reading members or any unknown lower view the
    // preview stays opaque: their reads may reach another source beneath it.
    this.view = new Proxy(store, { get: (target, key) => {
      if (key === 'get') return get;
      if (key === 'list') return list;
      if (key === 'history') return history;
      const member: unknown = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    } });
  }
  add(value: { writes: readonly Write[]; guards: readonly TransactionGuard[] }): void {
    for (const write of value.writes) {
      const old = this.writes.get(write.id);
      if (old && !same(old, write)) fail('atomic_gate_transaction_conflict', write.id, 'writes', 'One acceptance cannot write two different versions of a source');
      if (!old) {
        // №1942-3: a new pending id is published only while the lower Store still stands where the write expects it — its
        // pending exact revision then never existed below, so no proof of this region could have read another body under it.
        const head = this.store.get(write.id);
        if ((head?.revision ?? 0) !== write.expected)
          fail('atomic_gate_transaction_conflict', write.id, 'writes', 'A source moved beneath the acceptance before its pending revision was published');
      }
      this.writes.set(write.id, copy(write));
    }
    this.guards.push(...value.guards);
  }
  protectedHeads(): TransactionGuard[] {
    return unique(this.guards.filter(ref => {
      const pending = this.writes.get(ref.id);
      return 'absent' in ref || !pending || ref.revision !== pending.expected + 1 || ref.hash !== hashJson(pending.value);
    }));
  }
}

/** Test access only (№1942-4): the preview transaction of one acceptance, for the regressions of its view; not a product API. */
export const transactionForTests = (store: Store): { view: Store; writes: Map<string, Write>; add(value: { writes: readonly Write[]; guards: readonly TransactionGuard[] }): void } => new Transaction(store);

function modelSources(store: Store, project: string, results: readonly WorkProposalSource[]) {
  const outputs = results.map(source => historicalRead(store, { reader: `G5.model-source.${source.kind}`, project, ref: source.record },
    () => source.kind === 'part' ? take(readPartResult(store, { project, record: source.record }))
      : source.kind === 'reuse' ? take(readReuseResult(store, { project, record: source.record }))
      : take(readPartAssembly(store, { project, record: source.record })),
    () => fail('atomic_gate_bindings_unproven', source.record.id, 'cycle', 'Model-result sources contain a cyclic derivation')));
  const works: WorksPartBindings[] = [];
  for (const output of outputs) {
    if (output.proposal.value.level !== 3 || output.proposal.value.worksContract !== WORKS_FRAME_CONTRACT || !output.record.value.works)
      fail('atomic_gate_bindings_unproven', output.record.id, 'works', 'Bindings come from a checked L3 answer or complete assembly');
    works.push(copy(output.record.value.works) as WorksPartBindings);
  }
  if (new Set(outputs.map(output => canonical(reference(output.proposal)))).size !== outputs.length)
    fail('atomic_gate_bindings_unproven', project, 'results', 'A proposal occurs once in the accepted result set');
  // G5 (№3820, №3822): the checked answers of the final proposals all belong to the one exact original handoff —
  // every source's own declared ledger is that same D7 record; its bindings are transferred from it.
  let original: Sealed<OmObligations> | null = null;
  for (const work of works) {
    const found = take(readOmObligations(store, { project, producer: work.producer }));
    if (!same(reference(found.record), work.ledger))
      fail('atomic_gate_bindings_unproven', work.ledger.id, 'ledger', 'The source ledger must belong to the checked answer');
    if (original && !same(reference(original.record), reference(found.record)))
      fail('atomic_gate_bindings_unproven', work.ledger.id, 'works', 'All final proposals belong to one original handoff');
    original = found;
  }
  return { outputs, works, original, references: unique(outputs.flatMap(output => output.references)) };
}

/** Assignment identity is checked by D7; this key preserves every responsibility and policy field. */
function assignmentKey(value: CarriedObligation): string {
  const { scope: _scope, original: _original, ...policy } = value;
  return canonical(policy);
}
/** Each source's bindings are transferred from its own original ledger; one destination merges their consumers. */
function remapBindings(sources: readonly { old: Sealed<OmObligations>; bindings: readonly TaskObligationBinding[] }[],
  current: Sealed<OmObligations>): TaskObligationBinding[] {
  const destinations = new Map<string, CarriedObligation>();
  for (const item of taskObligations(current.handoff as OmObligationHandoff)) {
    const key = assignmentKey(item);
    if (destinations.has(key)) fail('atomic_gate_bindings_unproven', item.obligation, 'assignments', 'An assignment cannot map to two destinations');
    destinations.set(key, item);
  }
  const mapped = new Map<string, TaskObligationBinding>();
  for (const { old, bindings } of sources) {
    const former = new Map(taskObligations(old.handoff as OmObligationHandoff).map(item => [taskBindingId(item), item]));
    for (const binding of bindings) {
      const source = former.get(binding.id);
      if (!source || !same(binding.scope, source.scope) || binding.obligation !== source.obligation)
        fail('atomic_gate_bindings_unproven', binding.id, 'scope', 'Every binding must refer to its checked original handoff');
      const next = destinations.get(assignmentKey(source));
      if (!next) fail('atomic_gate_bindings_unproven', binding.id, 'assignment', 'The full unchanged assignment must survive the transfer');
      const id = taskBindingId(next), previous = mapped.get(id);
      const consumers = new Map((previous?.consumers ?? []).map(consumer => [consumer.node, consumer]));
      for (const consumer of binding.consumers) {
        const existing = consumers.get(consumer.node);
        if (existing && !same(sorted(existing.tests), sorted(consumer.tests)))
          fail('atomic_gate_bindings_unproven', id, 'tests', 'Overlapping answers disagree about the tests of one concrete consumer');
        consumers.set(consumer.node, copy(consumer));
      }
      mapped.set(id, { id, scope: next.scope, obligation: next.obligation, consumers: sorted([...consumers.values()]) });
    }
  }
  return sorted([...mapped.values()]);
}

function proveBindingTransfer(store: Store, request: AtomicGateRequest, candidate: FrameCandidateRecord): Ref[] {
  const current = take(readOmObligations(store, { project: request.project, producer: candidate.works!.producer }));
  if (!same(current.record.value.request.gaps, request.gaps))
    fail('atomic_gate_bindings_unproven', candidate.works!.ledger.id, 'gaps', 'G5 requires D7 for the final complete D1 source set');
  const sources = modelSources(store, request.project, request.results);
  if (!sources.works.length) {
    if (current.handoff.obligations.length || candidate.works!.bindings.length)
      fail('atomic_gate_bindings_unproven', candidate.works!.ledger.id, 'results', 'A nonempty handoff needs the checked model results carrying its bindings');
    return current.inputs as Ref[];
  }
  const original = sources.original!;
  const initial = original.record.value.request.gaps.sources.works;
  if ('state' in initial || !same(initial.frame, candidate.request.frame)
    || !same(unique([...initial.proposals, ...sources.outputs.map(output => reference(output.proposal))]), unique(candidate.proposals)))
    fail('atomic_gate_bindings_unproven', request.candidate.id, 'proposals', 'The candidate must contain the initial proposals and exactly the checked final answers');
  const expected = remapBindings(sources.works.map(work => ({ old: original, bindings: work.bindings })), current);
  if (!same(sorted(expected), sorted(candidate.works!.bindings)))
    fail('atomic_gate_bindings_unproven', request.candidate.id, 'bindings', 'Final bindings must be the complete, lossless transfer of the checked answers');
  for (const basis of current.record.value.request.assignments) {
    if (!('record' in basis)) fail('atomic_gate_bindings_unproven', request.candidate.id, 'assignments', 'A saved handoff names exact transferred assignments');
    const transfer = take(readObligationTransfer(store, { project: request.project, record: basis.record }));
    if (!same(transfer.record.value.from.producer, reference(original.producer))
      || !same(transfer.record.value.from.ledger, reference(original.record)))
      fail('atomic_gate_bindings_unproven', basis.record.id, 'from', 'The retained authority must come from this exact answer assignment');
  }
  return unique([...sources.references, ...original.inputs, ...current.inputs]);
}

/** New G5 rules are layered on native graph checks; C4 remains the authority for assembly and binding. */
export function checkAtomicWorks(graph: Graph, collection: GapCollection): AtomicGateResult<Sealed<Finding[]>> {
  return run(() => {
    const validation = validateGraph(graph), findings: Finding[] = [...validation.findings];
    if (!validation.graph) return findings;
    if (!object(collection) || !Array.isArray(collection.gaps) || !collection.gaps.every(gap => object(gap)
      && typeof gap.blocking === 'boolean' && text(gap.target) && text(gap.field)
      && Array.isArray(gap.consumers) && gap.consumers.every(text)
      && (!Object.hasOwn(gap, 'deferral') || gap.deferral !== undefined && object(gap.deferral) && gap.deferral.reason === 'outside_horizon'
        && gap.deferral.until === 'horizon-entry' && Array.isArray(gap.deferral.blocks) && gap.deferral.blocks.every(text)))
      || !Array.isArray(collection.refusals) || !collection.refusals.every(refusal => object(refusal)
        && text(refusal.code) && text(refusal.message) && object(refusal.at) && text(refusal.at.target))) invalid('gaps');
    const relations = new RefinementRelations(graph);
    for (const work of graph.nodes.filter(node => graph.horizon.includes(node.id))) {
      const artifacts = new Set([work.outcome, ...graph.connectors.filter(connector => connector.bindings.some(binding =>
        binding.level === 3 && binding.producer.node === work.id)).map(connector => connector.artifact)]);
      if (artifacts.size !== 1) findings.push({ code: 'work_artifact_not_single', target: work.id, message: 'A real work produces one artifact, including every outgoing connection' });
      const paths = work.code.filter(code => code.access === 'write').map(code => code.path);
      if (!paths.length || paths.some(path => !safeRelativePath(path))) findings.push({ code: 'work_write_scope_unbounded', target: work.id,
        message: 'A real work declares a nonempty set of exact relative file paths' });
      for (const gap of collection.gaps) if (gap.blocking && !gap.deferral
        && gap.consumers.some(consumer => relations.refines(work.id, consumer)))
        findings.push({ code: 'work_blocking_gap_open', target: work.id, message: `Unresolved gap ${gap.target}/${gap.field} blocks this work or its accepted upper node` });
    }
    for (const refusal of collection.refusals) findings.push({ code: refusal.code, target: refusal.at.target, message: refusal.message });
    return unique(findings);
  });
}

type ExternalInput = (artifact: string) => Pick<TaskInput, 'receipt' | 'source'>;
/**
 * The one task derivation of a works candidate: the compiler's deriveTasks with the G5 input resolution. G5 checks the
 * external Sources its request names; the machine caller collects exactly the Sources the same derivation asks for
 * (H1.1, №1860-7). `admit` runs where G5 admits its environment, so both keep the original order of refusals.
 */
function candidateTasks(store: Store, project: string, target: string, candidate: FrameCandidateRecord,
  neighbors: Revision<NeighborCollection>, external: ExternalInput, admit: () => void) {
  const graph = candidate.graph;
  const delivery = take(readDeliveries(store, neighbors.value.source));
  const handoff = take(readOmObligations(store, { project, producer: candidate.works!.producer }));
  const obligations = bindTaskObligations(store, project, graph, handoff.handoff as OmObligationHandoff);
  if (!graph.horizon.length) return { tasks: null, obligations };
  admit();
  const root = delivery.request.ownership.root === null ? null : take(readRecord<ExecutionRoot>(store,
    delivery.request.ownership.root, { unit: 'G5', target, id: `execution-root:${project}`, kind: 'execution-root' }));
  const writers = new Map<string, WriterProof | null>();
  const owner = (path: string): WriterProof | null => {
    if (writers.has(path)) return writers.get(path)!;
    const ref = delivery.writers[path];
    if (ref && !root) fail('atomic_gate_basis_unproven', path, 'ownership.root', 'A checked writer needs its exact execution slice');
    const proof = ref ? readWriter(store, project, { root: root!.value.path, head: root!.value.head }, ref, path) : null;
    writers.set(path, proof); return proof;
  };
  const resolveInput = (producer: string, artifact: string): Pick<TaskInput, 'receipt' | 'source'> => {
    if (graph.artifacts.find(item => item.id === artifact)?.external) return external(artifact);
    const receipts = unique(neighbors.value.packets.flatMap(packet => packet.neighbors.flatMap(neighbor =>
      (neighbor.direction === 'reads' || neighbor.direction === 'requires') && neighbor.neighbor.work.id === producer
        && neighbor.artifact === artifact && neighbor.delivery === 'available' && neighbor.basis ? [neighbor.basis] : [])));
    if (receipts.length !== 1) fail('atomic_gate_basis_unproven', artifact, 'delivery', 'A task input needs one checked F3 receipt for this producer and artifact');
    return { receipt: receipts[0]!, source: null };
  };
  const { tasks } = deriveTasks(project, candidate.graphHash, graph, resolveInput,
    { version: 2, owner, researchObligations: obligations.byNode });
  return { tasks, obligations };
}
/** Measure the exact compiler task DTO plus the complete checked F4 packet, before any MachinePlan exists. */
function packetCapacity(store: Store, request: IssuedGateRequest, candidate: FrameCandidateRecord,
  neighbors: Revision<NeighborCollection>, limit: number, current: boolean): Finding[] {
  const graph = candidate.graph;
  const external = new Map(request.sources.map(ref => [ref.id, ref])), used = new Set<string>();
  let fullCheck: Environment['fullCheck'] | null = null;
  const derived = candidateTasks(store, request.project, request.candidate.id, candidate, neighbors, artifact => {
    const id = `source:${request.project}:${artifact}`, ref = external.get(id);
    if (!ref) fail('atomic_gate_basis_unproven', artifact, 'sources', 'Each external task input needs its exact declared Source');
    used.add(id); return resolveExternalSource(store, request.project, graph, artifact, ref, current);
  }, () => {
    const environment = take(readRecord<Environment>(store, request.environment, { unit: 'G5', target: request.environment.id,
      id: `environment:${request.project}`, kind: 'environment' }));
    fullCheck = environment.value.fullCheck as Environment['fullCheck'];
  });
  if (!derived.tasks) {
    if (request.sources.length) fail('atomic_gate_basis_unproven', request.candidate.id, 'sources', 'A context names exactly its necessary external sources');
    return derived.obligations.findings;
  }
  if (used.size !== external.size) fail('atomic_gate_basis_unproven', request.candidate.id, 'sources', 'A context names exactly its necessary external sources');
  const findings: Finding[] = [...derived.obligations.findings];
  for (const task of derived.tasks) {
    const selected = { taskContextContract: request.taskContextContract,
      specification: loadTaskSpecification(store, request.project, request.gaps.sources.input, graph, task, readTaskSpecification, request.taskContextContract) };
    try { preplanTaskContext({ project: request.project, graph, task, fullCheck: fullCheck!,
      basis: { candidate: request.candidate, environment: request.environment }, neighbors, ...selected }, limit); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'context_budget_exceeded') throw error;
      const size = error.details as { requiredChars: number; maxChars: number };
      findings.push({ code: 'work_packet_over_capacity', target: task.node,
        message: `The complete task context needs ${size.requiredChars} characters; the configured capacity is ${size.maxChars}` });
    }
  }
  return findings;
}
/**
 * AT1: the impact of the candidate's works on the exact snapshot their packets were answered against, derived by the
 * producer from Git objects of that tree, and the coverage of each work's inventory by its own decisions.
 */
function impactOf(store: Store, request: AtomicGateRequest, graph: Graph): { record: AtomicGateImpact; findings: Finding[] } {
  const snapshot = request.snapshot;
  const input = take(readOmInput(store, request.project, request.gaps.sources.input)).value.input as OmInput;
  const policy = gatePolicies(graph, input), policies = policy.rows.length ? { policies: policy.rows } : {};
  if (!snapshot) return { record: { snapshot: null, works: [], ...policies }, findings: [...policy.findings, ...gateIntegrations(graph, null).findings] };
  const environment = take(readRecord<Environment>(store, request.environment, { unit: 'G5', target: request.environment.id,
    id: `environment:${request.project}`, kind: 'environment' }));
  let files: ReturnType<typeof readSnapshot>;
  try { files = readSnapshot(environment.value.workspace, snapshot); }
  catch (error) {
    if (error instanceof EngineError && ['impact_repository_unavailable', 'impact_snapshot_invalid'].includes(error.code))
      fail('atomic_gate_basis_unproven', snapshot.tree, 'snapshot', 'The works are checked against their exact readable repository snapshot');
    throw error;
  }
  const impact = gateImpact(files, graph, snapshot, readinessResolutions(input, snapshot));
  return { record: { ...impact.record, ...policies }, findings: [...impact.findings, ...policy.findings] };
}
/**
 * AT1 door (№4105 п.2, п.4): the transitions B1 of this gate's own D1 holds resolved — applied facts of readiness questions
 * asked on this very tree. An answer about another snapshot resolves nothing here: its question is asked again for this one.
 */
export function readinessResolutions(input: Pick<OmInput, 'facts'>, snapshot: RepositorySnapshot): (ImpactResolution & { question: string })[] {
  const rows: (ImpactResolution & { question: string })[] = [];
  for (const fact of input.facts ?? []) {
    const cause = fact.question.readiness;
    if (cause?.cause !== 'transition' || cause.snapshot.tree !== snapshot.tree) continue;
    const value = fact.value as { resolves?: unknown };
    if (!object(value) || !Array.isArray(value.resolves) || !value.resolves.every(item => text(item) && cause.candidates.includes(item)))
      fail('atomic_gate_basis_unproven', fact.question.id, 'resolves', 'An applied resolution names files among the candidates of its transition');
    rows.push({ question: fact.question.id, file: cause.file, line: cause.line, site: { ...cause.site }, resolves: [...value.resolves as string[]].sort() });
  }
  return rows.sort((a, b) => a.question < b.question ? -1 : a.question > b.question ? 1 : 0);
}
/**
 * AT1 (return №4124 P2-2, №4143, №4147): a connection the work's own result needs from existing code is proved on the exact
 * snapshot — its file is in the tree and the TypeScript parser finds the symbol it names declared there (a mention, a
 * comment, a string, a regular expression or a call is no declaration). A file the parser proves nothing about — another
 * language, a parse diagnostic, a file beyond the analyzed size — is an addressed unknown of the work, asked through the
 * readiness door; the research fact on this very tree decides it. Either way only the point's existence is proved, never
 * that its interface fits the contract. Without a repository nothing existing is proved.
 */
export function gateIntegrations(graph: Graph, files: (SnapshotFiles & { readonly unanalyzed?: ReadonlySet<string> }) | null,
  resolutions: readonly ImpactResolution[] = []): { findings: Finding[]; unknowns: Map<string, ImpactUnknown[]> } {
  const findings: Finding[] = [], unknowns = new Map<string, ImpactUnknown[]>(), present = new Set(files?.paths ?? []);
  for (const work of graph.nodes.filter(node => node.kind === 'work' && graph.horizon.includes(node.id)))
    for (const integration of work.integrations ?? []) {
      if (!('existing' in integration.basis)) continue;
      const unproven = (message: string) => findings.push({ code: 'work_integration_unproven', target: work.id, field: integration.entry, message });
      // Return №4173 G12: every segment after the file names the point — `#Store#commit` and `#Store.commit` alike.
      const [path, ...segments] = integration.entry.split('#') as [string, ...string[]];
      const symbol = segments.length ? segments.join('.') : undefined;
      if (!files) { unproven(`No repository snapshot proves the existing connection point ${integration.entry}`); continue; }
      if (!present.has(path)) { unproven(`The existing connection point ${integration.entry} is not in the snapshot ${files.snapshot.tree}`); continue; }
      if (!symbol) continue;
      const found = declares(files, path, symbol);
      if (found === 'declared') continue;
      if (found === 'absent') { unproven(`${path} of the snapshot ${files.snapshot.tree} declares no ${symbol}: a mention is no connection point`); continue; }
      const unknown = declarationUnknown(integration.entry, found.unknown);
      const answer = resolutions.find(row => row.file === unknown.file && same(row.site, unknown.site));
      if (!answer) { unknowns.set(work.id, [...unknowns.get(work.id) ?? [], unknown]); continue; }
      if (!answer.resolves.includes(integration.entry))
        unproven(`The research fact on the snapshot ${files.snapshot.tree} finds no declaration of ${symbol} in ${path}`);
    }
  return { findings, unknowns };
}
/** AT1 (№4117): a policy a work of the horizon needs, and the readiness question whose decision B1 holds for it (or none). */
export interface PolicyRow { work: string; policy: 'appearance' | 'provider'; producer: string; contract: { id: string; hash: string }; question: string | null }
/**
 * AT1 (№4117, contract §1.3): a durable work needs the appearance policy of its state's producer, a provider work the
 * policy of its provider's authority — each decided once at that producer, whether the owner answered it (H2), the model
 * decided it in the pass (OWN1) or research established it, and referred to by every consumer. Without it G5 refuses the
 * work at that producer's address.
 */
export function gatePolicies(graph: Graph, input: Pick<OmInput, 'facts' | 'decided'>): { rows: PolicyRow[]; findings: Finding[] } {
  const decided = new Map<string, string>();
  for (const row of [...input.facts ?? [], ...input.decided ?? []]) {
    const cause = row.question.readiness;
    // A decision is for one exact contract; one whose cause names none decides nothing here and the policy is asked again.
    if (cause?.cause === 'policy' && cause.governs) decided.set(canonical([cause.policy, cause.producer, cause.governs.contract, cause.governs.hash]), row.question.id);
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  // The contract a policy governs, at the exact schema this graph gives it.
  const contractOf = (artifact: string) => {
    const id = graph.artifacts.find(item => item.id === artifact)?.contract ?? artifact;
    return { id, hash: hashJson((graph.contracts.find(item => item.id === id)?.schema ?? null) as Json) };
  };
  const rows: PolicyRow[] = [], findings: Finding[] = [];
  for (const work of graph.nodes.filter(node => node.kind === 'work' && graph.horizon.includes(node.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const needs = new Map<string, [PolicyRow['policy'], string, PolicyRow['contract']]>();
    const need = (policy: PolicyRow['policy'], producer: string, contract: PolicyRow['contract']) =>
      needs.set(canonical([policy, producer, contract.id, contract.hash]), [policy, producer, contract]);
    // Its own durable result or provider call: the policy of its own result contract at its producer.
    if (work.boundary.state === 'durable') need('appearance', work.boundary.writer, contractOf(work.outcome));
    if (work.boundary.provider) need('provider', work.boundary.authority, contractOf(work.outcome));
    // Return №4135 P2-1: every durable contract it uses — an artifact a connection brings it from a producer whose state is
    // durable (or an artifact declared durable) — refers to that producer's policy of that contract, wherever the producer
    // stands; the consumer creates no state of its own.
    for (const connector of graph.connectors) for (const binding of connector.bindings) {
      if (!binding.consumers.some(end => end.node === work.id) || binding.producer.node === work.id) continue;
      const producer = nodes.get(binding.producer.node), artifact = graph.artifacts.find(item => item.id === connector.artifact);
      if (!producer || !artifact || producer.boundary.state !== 'durable' && !String(artifact.durability ?? '').startsWith('durable')) continue;
      need('appearance', producer.boundary.writer, contractOf(artifact.id));
    }
    for (const [policy, producer, contract] of [...needs.values()].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1)) {
      const question = decided.get(canonical([policy, producer, contract.id, contract.hash])) ?? null;
      rows.push({ work: work.id, policy, producer, contract, question });
      if (!question) findings.push({ code: 'work_policy_open', target: work.id, field: `${policy}:${producer}:${contract.id}`,
        message: `The ${policy} policy of the contract ${contract.id} at its producer ${producer} is not decided: it is asked once and every work of the contract refers to it` });
    }
  }
  return { rows, findings };
}
/** The impact rule of G5 over files in hand: each current work's inventory on the snapshot and its coverage by its decisions. */
export function gateImpact(files: SnapshotFiles, graph: Graph, snapshot: RepositorySnapshot,
  resolutions: readonly (ImpactResolution & { question: string })[] = []): { record: AtomicGateImpact; findings: Finding[] } {
  const works = graph.nodes.filter(node => node.kind === 'work' && graph.horizon.includes(node.id));
  // Several applied answers about one transition (asked for different blocks) resolve it by the union of their files.
  const merged = new Map<string, ImpactResolution>();
  for (const row of resolutions) {
    const key = JSON.stringify([row.file, row.site.start, row.site.end, row.site.hash]), prior = merged.get(key);
    merged.set(key, { file: row.file, line: row.line, site: { ...row.site }, resolves: [...new Set([...(prior?.resolves ?? []), ...row.resolves])].sort() });
  }
  const inventory = deriveImpact(files, works.map(node => ({ work: node.id, writes: node.code.filter(ref => ref.access === 'write').map(ref => ref.path) })),
    [...merged.values()]);
  const integrations = gateIntegrations(graph, files, [...merged.values()]);
  const findings: Finding[] = [...integrations.findings];
  const rows = inventory.works.map(derived => {
    // A connection point the parser proves nothing about is one more unknown of the work's own inventory.
    const work = { ...derived, unknowns: [...derived.unknowns, ...integrations.unknowns.get(derived.work) ?? []] };
    const coverage = impactCoverage(work, works.find(node => node.id === work.work)!.impact ?? []);
    findings.push(...coverage.findings.map(item => ({ code: item.code, target: item.target, field: item.field, message: item.message })));
    return { ...work, coverage: coverage.covered };
  });
  return { record: { snapshot, parser: inventory.parser, boundary: [...inventory.boundary], works: rows, ...(resolutions.length ? { resolutions: resolutions.map(row => ({ ...row, resolves: [...row.resolves] })) } : {}) }, findings };
}
/** AT1: the one snapshot of the packets the final proposals were answered in — parts, assemblies of parts, reused assemblies. */
function resultsSnapshot(store: Store, project: string, results: readonly WorkProposalSource[]): RepositorySnapshot | null {
  const packets = new Map<string, Ref>();
  const part = (ref: Ref) => { const read = take(readPartResult(store, { project, record: ref })); packets.set(canonical(read.record.value.request.packet), read.record.value.request.packet); };
  const assembly = (ref: Ref) => { for (const item of take(readPartAssembly(store, { project, record: ref })).record.value.results) part(item); };
  for (const source of results) {
    if (source.kind === 'part') part(source.record);
    else if (source.kind === 'assembly') assembly(source.record);
    else assembly(take(readReuseResult(store, { project, record: source.record })).record.value.origin.assembly);
  }
  const snapshots = [...packets.values()].map(ref => take(readQuestionPacket(store, { project, record: ref })).value.briefImpact?.snapshot ?? null);
  if (new Set(snapshots.map(item => canonical(item))).size > 1)
    fail('atomic_gate_basis_unproven', project, 'snapshot', 'One works chain is checked against one repository snapshot');
  return snapshots[0] ?? null;
}
function deriveGate(store: Store, request: IssuedGateRequest, current: boolean): PreparedAtomicGate {
  requireRequest(store, request); request = normalizedGateRequest(request);
  const candidate = take(readWorksFrame(store, { project: request.project, candidate: request.candidate }));
  const neighbors = take(readNeighbors(store, { project: request.project, neighbors: request.neighbors }));
  if (!same(neighbors.value.source.candidate, request.candidate)) fail('packet_foreign', request.neighbors.id, 'candidate', 'Neighbors belong to this exact works candidate');
  const gapSet = take(readGaps(store, request.gaps));
  if (request.gaps.sources.project !== request.project || !same(request.gaps.sources.works, {
    frame: candidate.value.request.frame, proposals: candidate.value.request.proposals }))
    fail('atomic_gate_basis_unproven', request.candidate.id, 'gaps', 'The complete D1 set must describe the final proposals');
  const guards: TransactionGuard[] = [], writes: Write[] = [];
  if (current) {
    const gaps = take(prepareCurrentGaps(store, request.gaps)); guards.push(...gaps.guards);
    const prepared = take(prepareNeighbors(store, { project: request.project, candidate: request.candidate }));
    if (!same(prepared.reference, request.neighbors)) fail('input_stale', request.neighbors.id, 'source', 'The neighbors must match the complete current delivery derivation');
    guards.push(...prepared.guards, ...request.sources, request.candidate, request.neighbors); writes.push(...prepared.writes);
  }
  const references = proveBindingTransfer(store, request, candidate.value as FrameCandidateRecord);
  const capacity = take(readCapacity(store, { project: request.project, environment: request.environment, current }));
  const impact = impactOf(store, request, candidate.value.graph as Graph);
  const findings = unique([...take(checkAtomicWorks(candidate.value.graph as Graph, gapSet.collection as GapCollection)),
    ...packetCapacity(store, request, candidate.value as FrameCandidateRecord, neighbors as Revision<NeighborCollection>, capacity.maxRequestChars, current),
    ...impact.findings]);
  const value: AtomicGateRecord = { contract: ATOMIC_GATE_IMPACT_CONTRACT, project: request.project, request,
    result: { gate: 'G5', candidate: request.candidate, graphHash: candidate.value.graphHash,
      passed: findings.length === 0, codes: unique(findings.map(finding => finding.code)), findings },
    impact: impact.record };
  const record: Revision<AtomicGateRecord> = { id: gateId(request),
    kind: 'om-atomic-gate', revision: 1, hash: hashJson(value), value };
  if (current) guards.push(...capacity.guards);
  return { record, writes, guards: unique(guards), references: unique([...references, request.candidate, request.neighbors,
    request.environment, ...request.sources, ...request.gaps.records]) };
}
export function readAtomicGate(store: Store, request: { project: string; record: Ref }): AtomicGateResult<Sealed<Revision<AtomicGateRecord>>> {
  return run(() => {
    if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('read');
    return historicalRead(store, { reader: 'G5.gate', project: request.project, ref: request.record }, () => {
      // NR (№3600): a trusted read — prepareAtomicGate derived the outcome from its exact candidate and grounds once.
      return take(readRecord<AtomicGateRecord>(store, request.record, { unit: 'G5', target: request.record.id,
        idPrefix: `om-atomic-gate:${request.project}:`, kind: 'om-atomic-gate' }));
    }, () => fail('atomic_gate_record_forged', request.record.id, 'cycle', 'Gate sources contain a cyclic derivation'));
  });
}
export function prepareAtomicGate(store: Store, request: AtomicGateRequest): AtomicGateResult<Sealed<PreparedAtomicGate>> {
  return run(() => {
    requireRequest(store, request);
    const prepared = deriveGate(store, issuedRequest(store, request), true), existing = store.get(prepared.record.id);
    if (existing) {
      const saved = take(readAtomicGate(store, { project: request.project, record: reference(existing) }));
      if (!same(saved, prepared.record)) fail('atomic_gate_record_forged', existing.id, 'request', 'An outcome identity cannot be reused');
      prepared.guards.push(reference(existing));
    } else prepared.writes.push({ id: prepared.record.id, kind: prepared.record.kind, expected: 0, value: prepared.record.value });
    return prepared;
  });
}
export function writeAtomicGate(store: Store, request: AtomicGateRequest): AtomicGateResult<Sealed<Revision<AtomicGateRecord>>> {
  return run(() => {
    requireRequest(store, request); request = issuedRequest(store, request);
    const existing = store.get(gateId(request));
    // Returning an immutable prior outcome is not a new admission; C5 always uses prepareAtomicGate for current guards.
    if (existing) return take(readAtomicGate(store, { project: request.project, record: reference(existing) })) as Revision<AtomicGateRecord>;
    const prepared = take(prepareAtomicGate(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'G5', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record;
  });
}

export interface WorksAcceptanceRequest { project: string; results: WorkProposalSource[]; environment: Ref; sources: Ref[];
  /** C5: the exact accepting attempt and its declared obligations, or the legal null of an unbound acceptance. */
  binding: FrameAttemptBinding | null }
export interface WorksAcceptanceRecord {
  contract: 'om-works-acceptance/v1'; request: WorksAcceptanceRequest; gate: Ref;
  acceptance: AcceptedFrameRequest | null;
}
export interface PreparedWorksAcceptance {
  state: 'accepted' | 'rejected' | 'unchanged'; record: Revision<WorksAcceptanceRecord>;
  acceptance: AcceptedFrameRequest | null; writes: Write[]; guards: TransactionGuard[];
}
function requireAcceptance(store: Store, request: WorksAcceptanceRequest): void {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.environment)
    || !sourcesShape(request.results) || !request.results.length || !sourcesRefs(request.sources)
    || Object.keys(request).some(key => !['project', 'results', 'environment', 'sources', 'binding'].includes(key))
    || !Object.hasOwn(request, 'binding') || request.binding !== null && !isFrameAttemptBinding(request.binding)) invalid('acceptance');
}
function normalizeAcceptance(request: WorksAcceptanceRequest): WorksAcceptanceRequest {
  return { project: request.project, results: sorted(copy(request.results)), environment: copy(request.environment), sources: sorted(copy(request.sources)),
    binding: request.binding === null ? null : { ...copy(request.binding), obligations: sorted(request.binding.obligations) } };
}
const acceptanceId = (request: WorksAcceptanceRequest) => `om-works-acceptance:${request.project}:${hashJson(request)}`;
function acceptanceRow(value: WorksAcceptanceRecord): Revision<WorksAcceptanceRecord> {
  return { id: acceptanceId(value.request), kind: 'om-works-acceptance', revision: 1, hash: hashJson(value), value };
}
export function readWorksAcceptance(store: Store, request: { project: string; record: Ref }): AtomicGateResult<Sealed<Revision<WorksAcceptanceRecord>>> {
  return run(() => {
    if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('acceptance.read');
    const saved = take(readRecord<WorksAcceptanceRecord>(store, request.record, { unit: 'G5', target: request.record.id,
      idPrefix: `om-works-acceptance:${request.project}:`, kind: 'om-works-acceptance' }));
    const value = saved.value;
    if (!object(value) || value.contract !== 'om-works-acceptance/v1' || !object(value.request)
      || value.request.project !== request.project || !isRef(value.gate))
      fail('atomic_gate_record_forged', saved.id, 'record', 'Acceptance retains its exact request and derived G5 outcome');
    requireAcceptance(store, value.request as WorksAcceptanceRequest);
    const gate = take(readAtomicGate(store, { project: request.project, record: value.gate }));
    if (!same(gate.value.request.results, value.request.results) || !same(gate.value.request.environment, value.request.environment)
      || !same(gate.value.request.sources, value.request.sources)
      || !same(value.request, normalizeAcceptance(value.request as WorksAcceptanceRequest))
      || !same(saved, acceptanceRow(value as WorksAcceptanceRecord)))
      fail('atomic_gate_record_forged', saved.id, 'request', 'Acceptance must name the same checked answers and configuration as G5');
    if (gate.value.result.passed) {
      if (!object(value.acceptance)) fail('atomic_gate_record_forged', saved.id, 'acceptance', 'A passed acceptance retains all common C5 references');
      const accepted = take(readAcceptedFrame(store, value.acceptance as AcceptedFrameRequest));
      if (!accepted.frame || accepted.frame.value.acceptance.gate.name !== 'G5'
        || !same(accepted.frame.value.acceptance.candidate, gate.value.result.candidate)
        || !same(accepted.frame.value.acceptance.gate.basis, value.gate)
        || !same(accepted.frame.value.acceptance.binding ?? null, value.request.binding ?? null))
        fail('atomic_gate_record_forged', saved.id, 'gate', 'The accepted layer must preserve this exact G5 outcome');
    } else {
      if (value.acceptance !== null) fail('atomic_gate_record_forged', saved.id, 'acceptance', 'A refused gate cannot claim an accepted graph');
      take(readRejectedCandidate(store, { project: request.project, level: 3, candidate: gate.value.result.candidate,
        outcome: { ...gate.value.result, codes: [...gate.value.result.codes], basis: value.gate }, binding: (value.request.binding ?? null) as FrameAttemptBinding | null }));
    }
    return saved;
  });
}

/**
 * The final works candidate these exact results make, previewed in one transaction view: D1 over the final proposals,
 * the next D2 snapshot, the D7 transfer, C4 and F3. G5 acceptance and the machine list of its external Sources share it.
 */
function worksCandidate(store: Store, project: string, results: readonly WorkProposalSource[], target: string) {
  const checked = modelSources(store, project, results), old = checked.original!;
  const oldRequest = old.record.value.request, initial = oldRequest.gaps.sources.works;
  if ('state' in initial) fail('atomic_gate_basis_unproven', target, 'works', 'The original assignment requires an accepted operation frame');
  const works: ProposalRequest = { frame: copy(initial.frame) as ProposalRequest['frame'],
    proposals: unique([...initial.proposals, ...checked.outputs.map(output => reference(output.proposal))]) };
  const tx = new Transaction(store);
  const gaps = take(prepareGaps(tx.view, { ...copy(oldRequest.gaps.sources), works } as GapRequest)); tx.add(gaps);
  const gapRecords = [...gaps.existing.map(reference), ...gaps.writes.map(write => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) }))];
  const gapRead: GapReadRequest = { sources: gaps.sources as GapRequest, records: unique(gapRecords) };
  const previousHead = store.get(oldRequest.lines.id);
  if (!previousHead) fail('atomic_gate_basis_unproven', oldRequest.lines.id, 'lines', 'The existing D2 line history must be retained');
  const previous = take(readGapLines(store, { project, record: reference(previousHead) }));
  const lines = take(prepareGapLines(tx.view, { project, previous: reference(previousHead),
    pass: previous.value.request.pass + 1, gaps: gapRead, closures: [] })); tx.add(lines);
  const lineWrite = lines.writes.find(write => write.kind === 'gap-line');
  const linesRef = lines.existing ? reference(lines.existing) : lineWrite
    ? { id: lineWrite.id, revision: lineWrite.expected + 1, hash: hashJson(lineWrite.value) } : null;
  if (!linesRef) fail('atomic_gate_basis_unproven', target, 'lines', 'The transition must retain the new full D2 snapshot');
  const context = { gaps: gapRead, lines: linesRef }, assignments: ObligationRequest['assignments'] = [];
  const oldGaps = take(readGaps(store, oldRequest.gaps as GapReadRequest));
  const newGaps = take(readGaps(tx.view, gapRead));
  for (const source of oldRequest.assignments) {
    if (!('record' in source)) fail('atomic_gate_bindings_unproven', old.record.id, 'assignment', 'An original saved handoff must name an exact assignment');
    const sourceRecord = store.get<{ gap: Ref }>(source.record.id, source.record.revision);
    const sourceGap = oldGaps.records.find(row => same(reference(row), sourceRecord?.value.gap));
    const destination = sourceGap && newGaps.records.find(row => row.value.gap.id === sourceGap.value.gap.id);
    if (!destination) fail('obligation_assignment_invalid', source.record.id, 'gap', 'An assignment cannot disappear from the final D1 set');
    const transfer = take(prepareObligationTransfer(tx.view, { project,
      from: { producer: reference(old.producer), ledger: reference(old.record), assignment: source.record }, context, gap: reference(destination) }));
    tx.add(transfer); assignments.push({ record: reference(transfer.record) });
  }
  const handoff = take(prepareOmObligations(tx.view, { project, ...context, assignments })); tx.add(handoff);
  const bindings = remapBindings(checked.works.map(work => ({ old, bindings: work.bindings })), handoff);
  const candidateRequest: CandidateRequest = { ...works, works: { contract: WORKS_FRAME_CONTRACT,
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings } };
  const candidate = take(prepareWorksFrame(tx.view, candidateRequest));
  if (candidate.state !== 'candidate') fail('work_blocking_gap_open', target, 'candidate', 'The final proposals must fill the complete work frame');
  tx.add(candidate);
  const candidateWrite = candidate.writes.find(write => write.kind === 'frame-candidate');
  const candidateRef = candidate.existing ? reference(candidate.existing) : candidateWrite
    ? { id: candidateWrite.id, revision: candidateWrite.expected + 1, hash: hashJson(candidateWrite.value) } : null;
  if (!candidateRef) fail('atomic_gate_basis_unproven', target, 'candidate', 'The common C4 transition must yield its exact candidate');
  const neighbors = take(prepareNeighbors(tx.view, { project, candidate: candidateRef })); tx.add(neighbors);
  return { tx, gapRead, candidateRef, neighbors };
}
/** Rebuild D1/D2/D7 over the final proposals and join every write with common C5 acceptance. */
export function prepareWorksAcceptance(store: Store, raw: WorksAcceptanceRequest): AtomicGateResult<Sealed<PreparedWorksAcceptance>> {
  return run(() => {
    requireAcceptance(store, raw);
    const request = normalizeAcceptance(raw), id = acceptanceId(request), existing = store.get(id);
    if (existing) {
      const saved = take(readWorksAcceptance(store, { project: request.project, record: reference(existing) }));
      return { state: 'unchanged' as const, record: saved as Revision<WorksAcceptanceRecord>, acceptance: saved.value.acceptance as AcceptedFrameRequest | null,
        writes: [], guards: [] };
    }
    const { tx, gapRead, candidateRef, neighbors } = worksCandidate(store, request.project, request.results, id);
    const gate = take(prepareAtomicGate(tx.view, { project: request.project, candidate: candidateRef, neighbors: neighbors.reference,
      environment: request.environment, gaps: gapRead, results: request.results, sources: request.sources,
      snapshot: resultsSnapshot(store, request.project, request.results) })); tx.add(gate);
    const settlement = take(prepareSettleCandidate(tx.view, { project: request.project, level: 3, candidate: candidateRef, binding: request.binding,
      outcome: { ...gate.record.value.result, codes: [...gate.record.value.result.codes], basis: reference(gate.record) } })); tx.add(settlement);
    const accepted = settlement.result;
    const acceptance: AcceptedFrameRequest | null = gate.record.value.result.passed && accepted.graph && accepted.layer && accepted.frame
      ? { project: request.project, level: 3, graph: reference(accepted.graph), layer: reference(accepted.layer), frame: reference(accepted.frame) } : null;
    if (gate.record.value.result.passed && !acceptance) fail('atomic_gate_basis_unproven', id, 'acceptance', 'A passing G5 must be settled by common C5');
    const record = acceptanceRow({ contract: 'om-works-acceptance/v1', request, gate: reference(gate.record), acceptance });
    tx.add({ writes: [{ id: record.id, kind: record.kind, expected: 0, value: record.value }], guards: [] });
    return { state: acceptance ? 'accepted' as const : 'rejected' as const, record, acceptance,
      writes: [...tx.writes.values()], guards: tx.protectedHeads() };
  });
}
export function writeWorksAcceptance(store: Store, request: WorksAcceptanceRequest): AtomicGateResult<Sealed<PreparedWorksAcceptance>> {
  return run(() => { const prepared = take(prepareWorksAcceptance(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'G5', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared;
  });
}

export interface WorksSourcesRequest { project: string; results: WorkProposalSource[] }
export interface CandidateSourcesRequest { project: string; candidate: Ref; neighbors: Ref }
export interface WorksSources { candidate: Ref; sources: Ref[] }
const SOURCE_UNFIT = new Set(['external_input_missing', 'artifact_contract_mismatch', 'external_source_request_invalid']);
/** The collecting side of the one task derivation: each external input's current Source, checked by the common resolver. */
function neededSources(view: Store, store: Store, project: string, candidateRef: Ref, neighborsRef: Ref): Ref[] {
  const candidate = take(readWorksFrame(view, { project, candidate: candidateRef }));
  const neighbors = take(readNeighbors(view, { project, neighbors: neighborsRef }));
  if (!same(neighbors.value.source.candidate, candidateRef)) fail('packet_foreign', neighborsRef.id, 'candidate', 'Neighbors belong to this exact works candidate');
  const graph = (candidate.value as FrameCandidateRecord).graph, found = new Map<string, Ref>();
  candidateTasks(view, project, candidateRef.id, candidate.value as FrameCandidateRecord, neighbors as Revision<NeighborCollection>, artifact => {
    const id = `source:${project}:${artifact}`, head = store.get(id);
    if (!head) fail('atomic_gate_basis_unproven', artifact, 'sources', 'Each external task input needs its exact declared Source');
    try {
      const resolved = resolveExternalSource(store, project, graph, artifact, reference(head), true);
      found.set(id, reference(head)); return resolved;
    } catch (error) {
      if (error instanceof EngineError && SOURCE_UNFIT.has(error.code))
        take(transferError('compiler-inputs', error, { unit: 'G5', target: artifact, field: 'sources' }, 'producer'));
      throw error;
    }
  }, () => undefined);
  return sorted([...found.values()]);
}
/**
 * The exact external Sources G5 requires of an existing works candidate (H1.1, №1860-7): the same task derivation G5
 * runs, collecting instead of checking. Each needed source:<project>:<artifact> is read at its current head and checked
 * by the common resolver; a missing or unfit one is an addressed refusal naming the artifact. Nothing is written.
 */
export function prepareCandidateSources(store: Store, raw: CandidateSourcesRequest): AtomicGateResult<Sealed<WorksSources>> {
  return run(() => {
    if (!(store instanceof Store) || !object(raw) || !same(Object.keys(raw).sort(), ['candidate', 'neighbors', 'project']) || !text(raw.project)
      || !isRef(raw.candidate) || !isRef(raw.neighbors)) invalid('sources');
    return { candidate: copy(raw.candidate), sources: neededSources(store, store, raw.project, raw.candidate, raw.neighbors) };
  });
}
/**
 * The same list for the works candidate these results make: the acceptance's own candidate transition, previewed
 * without durable writes, then the same collection. G5 still admits the list it is given currently.
 */
export function prepareWorksSources(store: Store, raw: WorksSourcesRequest): AtomicGateResult<Sealed<WorksSources>> {
  return run(() => {
    if (!(store instanceof Store) || !object(raw) || !same(Object.keys(raw).sort(), ['project', 'results']) || !text(raw.project)
      || !Array.isArray(raw.results) || !raw.results.length || !raw.results.every(item => object(item)
        && (item.kind === 'part' || item.kind === 'assembly' || item.kind === 'reuse') && isRef(item.record) && same(Object.keys(item).sort(), ['kind', 'record']))
      || new Set(raw.results.map(item => canonical(item.record))).size !== raw.results.length) invalid('sources');
    const project = raw.project, results = sorted(copy(raw.results));
    const built = worksCandidate(store, project, results, `works-sources:${project}`);
    return { candidate: built.candidateRef, sources: neededSources(built.tx.view, store, project, built.candidateRef, built.neighbors.reference) };
  });
}

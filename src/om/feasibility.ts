import { canonical, hashJson } from '../canonical.js';
import { deriveTasks } from '../compiler/derive.js';
import { resolveArtifact } from '../compiler/inputs.js';
import type { ArtifactReceipt, TaskInput } from '../compiler/model.js';
import { EngineError } from '../errors.js';
import { ATOMIC_GATE_IMPACT_CONTRACT, type AtomicGateRecord } from './atomic-gate.js';
import type { Graph } from '../graph/model.js';
import type { Feasibility } from '../graph/refinement.js';
import { REFINEMENT_CONTRACT_VERSION } from '../graph/research-contracts.js';
import { readinessObligations, readReadinessObligations, type ReadinessObligations } from '../graph/obligation-readiness.js';
import { requireTaskObligations } from '../graph/task-obligations.js';
import { selectWriter, type WriterProof } from '../ownership/owners.js';
import { prepareWriterIndex, readWriterIndex } from '../ownership/writer-index.js';
import { isRef, reference, uniqueRefs, type Finding, type Ref } from '../pipeline/contracts.js';
import { Environments, inspectRepository, transactionGuardsCurrent, uniqueTransactionGuards, type Environment, type ExecutionRoot } from '../runtime/environment.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { readAcceptedFrame as readAcceptedFrameOf } from './frame-accept.js';
import { checkDeliveries as checkDeliveriesOf, type DeliveryBases } from './deliveries.js';
import { prepareFrame as prepareFrameOf, readFrame as readFrameOf, type FrameRequest } from './frame-obligations.js';
import { readHorizon as readHorizonOf } from './horizon.js';
import { historicalTrace, withHistoricalReads } from './input.js';
import { readOmObligations as readOmObligationsOf } from './obligations.js';
import { readRecord as readRecordOf, writeGuarded as writeGuardedOf, type GuardedWrite, type RecordRequest } from './refs.js';
import { delivered, localErrors, localRefusals, refused, transfer, transferError, transferring, type OmResult, type Refusal,
  type Sealed, type SourceCode, type SourceCodes } from './refusal.js';
import { readWorksFrame as readWorksFrameOf } from './works-frame.js';
import type { Json } from '../canonical.js';

export const FEASIBILITY_PRODUCER_CONTRACT = 'om-m8/v2' as const;
export interface FeasibilityRequest {
  project: string; graph: Ref; layer: Ref; frame: Ref; environment: Ref; expected: number;
}
export interface FeasibilityInspection {
  graph: Ref; layer: Ref; environment: Ref; root: string; executionRoot: Ref | null; workspace: Ref | null;
  result: ReturnType<typeof inspectRepository>;
}
export interface FeasibilityDeliveries {
  ownership: { root: Ref | null; indexes: Record<string, Ref> } | null;
  resolved: { producer: string; artifact: string; source: Ref | null; receipt: Ref | null }[];
  inputs: Ref[];
}
export interface OmFeasibility extends Feasibility {
  obligations: ReadinessObligations;
  producer: {
    contract: typeof FEASIBILITY_PRODUCER_CONTRACT; project: string;
    layer: Ref; frame: Ref; candidate: Ref; horizon: Ref;
    obligations: { producer: Ref; ledger: Ref }; readiness: ReadinessObligations;
    inspection: FeasibilityInspection; deliveries: FeasibilityDeliveries;
  };
}
/** Q2b (№2518): every refusal code M8 creates itself, from the actual places of issue; its exceptions apart. */
export const FEASIBILITY_LOCAL_CODES = Object.freeze(['feasibility_record_invalid',
  'feasibility_stale', 'feasibility_not_ready', 'input_stale'] as const);
export type FeasibilityLocalCode = typeof FEASIBILITY_LOCAL_CODES[number];
export const FEASIBILITY_ERROR_CODES = Object.freeze(['feasibility_request_invalid', 'feasibility_internal'] as const);
export type FeasibilityErrorCode = typeof FEASIBILITY_ERROR_CODES[number];
/**
 * The units whose refusals M8 hands on: its readers; the compiler's resolution of a task input (its exceptions, through
 * the exact earlier filter); and the three producers whose findings become the refusals of a result — the repository
 * inspection, the D7 readiness and the deliveries.
 */
export type FeasibilitySource = 'refs' | 'frame-accept' | 'works-frame' | 'obligations' | 'frame-obligations' | 'horizon'
  | 'deliveries' | 'compiler-inputs' | 'inspection' | 'readiness';
export type FeasibilityCode = FeasibilityLocalCode | SourceCodes<FeasibilitySource>;
export type FeasibilityResult<T> = OmResult<T, FeasibilityCode>;
export interface PreparedFeasibility {
  record: Revision<OmFeasibility>; writes: Write[]; guards: TransactionGuard[]; references: Ref[];
  refusals: Refusal<SourceCode<'inspection'> | SourceCode<'readiness'> | SourceCode<'deliveries'>>[];
}

const readAcceptedFrame = transferring('frame-accept', readAcceptedFrameOf);
const checkDeliveries = transferring('deliveries', checkDeliveriesOf);
const prepareFrame = transferring('frame-obligations', prepareFrameOf);
const readFrame = transferring('frame-obligations', readFrameOf);
const readHorizon = transferring('horizon', readHorizonOf);
const readOmObligations = transferring('obligations', readOmObligationsOf);
const readWorksFrame = transferring('works-frame', readWorksFrameOf);
const readRecord = <T = Json>(store: Store, reference: unknown, request: RecordRequest) => transfer('refs', readRecordOf<T>(store, reference, request));
const writeGuarded = <T = Json>(store: Store, request: GuardedWrite) => transfer('refs', writeGuardedOf<T>(store, request));
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const id = (project: string) => `om-feasibility:${project}`;
const refuse = localRefusals(FEASIBILITY_LOCAL_CODES);
// Annotated explicitly: only a declared `never` makes a bare call end the control flow for tsc.
const raise: (code: FeasibilityErrorCode, message: string, details?: unknown) => never = localErrors(FEASIBILITY_ERROR_CODES);
class Failure extends Error { constructor(readonly refusal: Refusal<FeasibilityCode>) { super(refusal.message); } }
function take<T>(result: OmResult<T, FeasibilityCode>): T { if (!result.ok) throw new Failure(result.refusal); return result.value; }
function fail(code: FeasibilityLocalCode, target: string, field: string, message: string): never {
  take(refuse(code, message, { unit: 'M8', target, field }, 'producer'));
  return raise('feasibility_internal', 'A refusal unexpectedly succeeded');
}
function run<T>(action: () => T): FeasibilityResult<Sealed<T>> {
  return withHistoricalReads(() => { try { return delivered(action()); }
    catch (error) { if (error instanceof Failure) return { ok: false, refusal: error.refusal }; throw error; } });
}
function invalid(field: string): never {
  return raise('feasibility_request_invalid', 'M8 requires an explicit project and exact accepted sources',
    { unit: 'M8', target: 'feasibility', field });
}
function requireRequest(store: Store, request: unknown): asserts request is FeasibilityRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(request) || !text(request['project']) || !['graph', 'layer', 'frame', 'environment'].every(key => isRef(request[key]))
    || !Number.isSafeInteger(request['expected']) || (request['expected'] as number) < 0
    || Object.keys(request).some(key => !['project', 'graph', 'layer', 'frame', 'environment', 'expected'].includes(key))) invalid('request');
}

/** The same exact C5/F2/D7 readers establish the inputs for preview and provenance. */
/**
 * AT1 (№4091 п.5): a plan is issued on exactly the tree its works were checked against. The gate of the impact era names that
 * snapshot (read as saved, never derived again); without one the impact was never checked, and no plan is issued. A gate
 * of any other contract can never have named it — there is no earlier-era rule left to read.
 */
function sameSnapshot(store: Store, project: string, frame: { id: string; value: { acceptance: unknown } }, tree: string | null): void {
  const gate = (frame.value.acceptance as { gate?: { basis?: unknown } } | undefined)?.gate?.basis;
  // A genuine accepted L3 always receives its exact G5 basis at issue; a missing one is an unproved input, not a skip.
  if (!isRef(gate))
    fail('feasibility_not_ready', frame.id, 'acceptance.gate.basis', 'The accepted frame must name the exact atomic-gate basis of its works');
  const record = take(readRecord<AtomicGateRecord>(store, gate, { unit: 'M8', target: gate.id, idPrefix: `om-atomic-gate:${project}:`, kind: 'om-atomic-gate' }));
  const impact = record.value.contract === ATOMIC_GATE_IMPACT_CONTRACT ? record.value.impact : undefined;
  if (!impact || !Object.hasOwn(impact, 'snapshot'))
    fail('feasibility_not_ready', gate.id, 'snapshot', 'The works were accepted without the repository snapshot their impact is checked against');
  const snapshot = impact.snapshot;
  // A workspace without a repository has no snapshot to check an impact against — its packets carry none; a repository does.
  if (!snapshot) {
    if (tree !== null) fail('feasibility_not_ready', gate.id, 'snapshot', 'The works were accepted without the repository snapshot their impact is checked against');
    return;
  }
  if (tree !== snapshot.tree)
    fail('feasibility_stale', gate.id, 'snapshot', `The plan is issued on the tree its works were checked against: ${snapshot.tree}, not ${tree ?? 'no repository'}`);
}
function sources(store: Store, request: Pick<FeasibilityRequest, 'project' | 'graph' | 'layer' | 'frame'>, current: boolean) {
  const accepted = take(readAcceptedFrame(store, { ...request, level: 3 }));
  if (!accepted.graph || !accepted.layer || !accepted.frame)
    fail('feasibility_record_invalid', request.frame.id, 'acceptance', 'M8 requires the exact accepted work layer');
  const candidate = take(readWorksFrame(store, { project: request.project, candidate: accepted.frame.value.acceptance.candidate }));
  const works = candidate.value.works;
  if (!works) fail('feasibility_record_invalid', candidate.id, 'works', 'The work candidate carries its D7 handoff');
  const obligations = take(readOmObligations(store, { project: request.project, producer: works.producer }));
  if (!same(reference(obligations.record), works.ledger))
    fail('feasibility_record_invalid', candidate.id, 'works.ledger', 'The candidate must name this exact D7 ledger');
  const frameRequest: FrameRequest = { ...candidate.value.request.frame, graph: request.graph, layer: request.layer, frame: request.frame };
  const prepared = current ? take(prepareFrame(store, frameRequest)) : null;
  const frame = prepared ?? take(readFrame(store, frameRequest));
  const horizon = take(readHorizon(store, request.project, frameRequest.horizon));
  // The common C5/G5 proof above includes the complete nonempty work horizon; M8 cannot admit an unproved graph.
  return { accepted, candidate, obligations, frame, horizon, graph: accepted.graph.value,
    guards: prepared?.guards ?? [] };
}

/**
 * A finding of one of the three producers of a result as its refusal: the finding's own code and message at the M8 address,
 * the route chosen from the code as before, marked with that producer. Reached only through the three adapters below, each
 * of which takes its producer's whole result (№2518-3, №2522-2).
 */
function addressed<Source extends 'inspection' | 'readiness' | 'deliveries'>(source: Source, finding: Finding): Refusal<SourceCode<Source>> {
  const route = finding.code === 'source_missing' ? 'gap'
    : /^(external_|artifact_|producer_|implementation_|ownership_|available_|environment_confirmation_|obligation_)/.test(finding.code)
      ? 'readiness' : 'owner';
  const result = transfer(source, refused(finding.code, finding.message, { unit: 'M8', target: finding.target }, route));
  if (!result.ok) return result.refusal;
  return raise('feasibility_internal', 'A refusal unexpectedly succeeded');
}
const inspectionRefusals = (result: ReturnType<typeof inspectRepository>) => result.findings.map(finding => addressed('inspection', finding));
const readinessRefusals = (result: ReturnType<typeof readinessObligations>) => result.findings.map(finding => addressed('readiness', finding));
const deliveryRefusals = (result: ReturnType<typeof deliveryInputs>) => result.findings.map(finding => addressed('deliveries', finding));

type Sources = ReturnType<typeof sources>;
const badRecord = (target: string, field: string): never =>
  fail('feasibility_record_invalid', target, field, 'M8 must preserve the complete result derived from its exact sources');
const refs = (value: unknown): value is Ref[] => Array.isArray(value) && value.every(isRef);
const findingsShape = (value: unknown): value is Finding[] => Array.isArray(value)
  && value.every(item => object(item) && text(item['code']) && text(item['target']) && text(item['message'])
    && Object.keys(item).every(key => ['code', 'target', 'message'].includes(key)));
function environmentAt(store: Store, project: string, ref: Ref): Revision<Environment> {
  const record = take(readRecord<Environment>(store, ref,
    { unit: 'M8', target: project, id: `environment:${project}`, kind: 'environment' })) as Revision<Environment>;
  if (!object(record.value) || record.value.projectId !== project || !text(record.value.workspace)) badRecord(ref.id, 'environment');
  return record;
}

function requireRecord(value: unknown, project: string): asserts value is OmFeasibility {
  const bad = (field: string): never => badRecord(id(project), field);
  if (!object(value)) return bad('record');
  if (value['contractVersion'] !== REFINEMENT_CONTRACT_VERSION || value['projectId'] !== project
    || !isRef(value['graph']) || !isRef(value['environment']) || typeof value['ready'] !== 'boolean'
    || !Object.hasOwn(value, 'repository') || !refs(value['inputs']) || !findingsShape(value['findings'])) bad('record');
  const producer = value['producer'];
  if (!object(producer)) return bad('producer');
  if (producer['contract'] !== FEASIBILITY_PRODUCER_CONTRACT || producer['project'] !== project
    || !['layer', 'frame', 'candidate', 'horizon'].every(key => isRef(producer[key]))) bad('producer');
  const obligations = producer['obligations'], readiness = producer['readiness'], inspection = producer['inspection'];
  if (!object(obligations) || !isRef(obligations['producer']) || !isRef(obligations['ledger'])) bad('producer.obligations');
  if (!object(readiness) || !object(readiness['handoff']) || !Array.isArray(readiness['confirmations'])
    || !readiness['confirmations'].every(item => object(item) && text(item['obligation']) && isRef(item['source']) && isRef(item['observation'])))
    bad('producer.readiness');
  if (!object(value['obligations']) || !same(value['obligations'], readiness)) bad('obligations');
  if (!object(inspection)) return bad('inspection');
  if (!['graph', 'layer', 'environment'].every(key => isRef(inspection[key])) || !text(inspection['root'])
    || !(inspection['executionRoot'] === null || isRef(inspection['executionRoot']))
    || !(inspection['workspace'] === null || isRef(inspection['workspace']))) bad('inspection.sources');
  const result = inspection['result'];
  if (!object(result) || !Object.hasOwn(result, 'state') || !findingsShape(result['findings'])) return bad('inspection.result');
  const state = result['state'];
  if (state !== null && (!object(state) || !text(state['root']) || typeof state['head'] !== 'string' || !/^[a-f0-9]{40,64}$/.test(state['head'])
    || typeof state['tree'] !== 'string' || !/^[a-f0-9]{40,64}$/.test(state['tree']) || !Array.isArray(state['files'])
    || !state['files'].every(file => object(file) && text(file['path'])
      && (file['hash'] === null || typeof file['hash'] === 'string' && /^[a-f0-9]{64}$/.test(file['hash']))))) bad('inspection.state');
  if (state === null && !result['findings'].length) bad('inspection.findings');
  const deliveries = producer['deliveries'];
  if (!object(deliveries) || !refs(deliveries['inputs']) || !Object.hasOwn(deliveries, 'ownership')
    || !Array.isArray(deliveries['resolved']) || !deliveries['resolved'].every(item => object(item)
      && text(item['producer']) && text(item['artifact']) && (item['source'] === null || isRef(item['source']))
      && (item['receipt'] === null || isRef(item['receipt'])))) return bad('deliveries');
  const ownership = deliveries['ownership'];
  if (state === null ? ownership !== null || deliveries['inputs'].length > 0 || deliveries['resolved'].length > 0
    : !object(ownership) || !(ownership['root'] === null || isRef(ownership['root']))
      || !object(ownership['indexes']) || !Object.values(ownership['indexes']).every(isRef)) bad('deliveries.ownership');
}

/** The selected root is proved from exact environment/workspace records; disk state is the saved observation. */
function proveInspection(store: Store, project: string, value: OmFeasibility): void {
  const inspection = value.producer.inspection, environment = environmentAt(store, project, value.environment);
  if (!same(inspection.graph, value.graph) || !same(inspection.layer, value.producer.layer)
    || !same(inspection.environment, value.environment) || !same(inspection.result.state, value.repository)) badRecord(id(project), 'inspection');
  if (inspection.executionRoot) {
    if (!inspection.workspace) return badRecord(id(project), 'inspection.workspace');
    const root = take(readRecord<ExecutionRoot>(store, inspection.executionRoot,
      { unit: 'M8', target: project, id: `execution-root:${project}`, kind: 'execution-root' }));
    const workspace = take(readRecord<{ path: string }>(store, inspection.workspace,
      { unit: 'M8', target: project, id: `workspace:${project}`, kind: 'workspace' }));
    if (!object(root.value) || root.value.projectId !== project || root.value.state !== 'ready'
      || !isRef(root.value.workspace) || root.value.workspace.id !== inspection.workspace.id
      || root.value.workspace.hash !== inspection.workspace.hash || !object(workspace.value) || workspace.value.path !== environment.value.workspace
      || root.value.sourceRoot !== environment.value.workspace || root.value.path !== inspection.root
      || inspection.result.state && root.value.head !== inspection.result.state.head) badRecord(id(project), 'inspection.executionRoot');
  } else if (inspection.workspace !== null || inspection.root !== environment.value.workspace) badRecord(id(project), 'inspection.root');
  // inspectRepository resolves symlinks in a managed path. Its canonical spelling is part of the saved observation,
  // while inspection.root above proves which exact configured path was inspected; history does not resolve it again.
  if (!inspection.executionRoot && inspection.result.state && inspection.result.state.root !== inspection.root)
    badRecord(id(project), 'inspection.state.root');
}

/** Reuse the writer-index reader so an empty path history is bound to the exact execution-root slice. */
function deliveryInputs(store: Store, project: string, basis: Sources, inspection: FeasibilityInspection,
  saved?: FeasibilityDeliveries) {
  const state = inspection.result.state, inputGuards: Ref[] = [], dependencies: Ref[] = [];
  if (!state) return { value: { ownership: null, resolved: [], inputs: [] } satisfies FeasibilityDeliveries,
    findings: [] as Finding[], guards: inputGuards, references: dependencies };
  const paths = [...new Set(basis.graph.nodes.filter(node => basis.graph.horizon.includes(node.id))
    .flatMap(node => node.code.filter(code => code.access === 'write').map(code => code.path)))].sort();
  if (saved && (!saved.ownership || !same(Object.keys(saved.ownership.indexes).sort(), paths)
    || !same(saved.ownership.root, inspection.executionRoot))) badRecord(id(project), 'deliveries.ownership');
  const selected = new Map<string, WriterProof | null>(), indexes = new Map<string, Ref>();
  const traced = historicalTrace(store, ref => { dependencies.push(ref); }, 'distinct');
  for (const path of paths) {
    const prepared = saved ? null : prepareWriterIndex(store, project, path, inspection.executionRoot);
    // F4 already persisted the complete index for every accepted write path. Missing history is not an empty index.
    if (prepared?.writes.length) badRecord(path, 'writer-index');
    const record = prepared?.record ?? readWriterIndex(store, project, path, saved!.ownership!.indexes[path]!, inspection.executionRoot);
    if (prepared) inputGuards.push(...prepared.guards);
    indexes.set(path, reference(record)); dependencies.push(reference(record));
    selected.set(path, selectWriter(traced, project, state, record.value.writers, path));
  }
  const owner = (path: string) => {
    if (!selected.has(path)) return badRecord(path, 'writePaths');
    return selected.get(path)!;
  };
  const bases: DeliveryBases = Object.create(null) as DeliveryBases;
  const selection = basis.horizon.horizon.value.result.horizon;
  for (const [block, execution] of Object.entries(selection.execution))
    if (execution.state === 'available') bases[block] = { ...execution.basis };
  for (const boundary of selection.boundary) bases[boundary.block] = { ...boundary.basis };
  const deliveries = take(checkDeliveries(traced, project, basis.graph as Graph, bases,
    { current: saved === undefined, owner,
      identities: [...new Set(basis.candidate.value.fills.filter(fill => fill.source === 'identity').map(fill => fill.node))] }));
  const findings: Finding[] = deliveries.findings.map(({ code, target, message }) => ({ code, target, message }));
  inputGuards.push(...deliveries.guards);
  const resolved = new Map<string, FeasibilityDeliveries['resolved'][number]>();
  const resolve = (producer: string, artifact: string): Pick<TaskInput, 'source' | 'receipt'> => {
    const key = canonical([producer, artifact]), previous = resolved.get(key);
    if (previous) return previous;
    let input: Pick<TaskInput, 'source' | 'receipt'>;
    const retained = saved?.resolved.filter(item => item.producer === producer && item.artifact === artifact);
    if (retained && retained.length !== 1) return badRecord(artifact, 'deliveries.resolved');
    // Only the immediate input belongs to this resolution. Transitive history may contain older revisions of its ID.
    const exact = retained?.flatMap(item => [...(item.source ? [item.source] : []), ...(item.receipt ? [item.receipt] : [])]);
    try { input = resolveArtifact(traced, project, basis.graph as Graph, state, producer, artifact, exact); }
    catch (error) {
      if (!(error instanceof EngineError) || !['external_input_missing', 'artifact_contract_mismatch', 'producer_not_ready',
        'artifact_foreign', 'implementation_receipt_invalid', 'implementation_proof_missing', 'implementation_proof_foreign',
        'implementation_manifest_invalid', 'artifact_stale', 'plan_input_invalid'].includes(error.code)) throw error;
      return take(transferError('compiler-inputs', error, { unit: 'M8', target: artifact, field: 'delivery' }, 'readiness'));
    }
    resolved.set(key, { producer, artifact, source: input.source ?? null, receipt: input.receipt ?? null });
    if (input.source) inputGuards.push(input.source);
    if (input.receipt) inputGuards.push(input.receipt);
    return input;
  };
  if (!findings.length) for (const map of Object.values(bases)) for (const [artifact, named] of Object.entries(map)) {
    const receipt = take(readRecord<ArtifactReceipt>(traced, named, { unit: 'M8', target: artifact, id: named.id, kind: 'artifact' }));
    if (!same(resolve(receipt.value.node, artifact).receipt, named))
      fail('input_stale', named.id, 'delivery', 'The compiler must resolve the exact result named by M2');
  }
  const researchObligations = requireTaskObligations(store, project, basis.graph as Graph, basis.obligations.handoff as ReadinessObligations['handoff']);
  const derived = deriveTasks(project, basis.accepted.graph!.hash, basis.graph as Graph, resolve,
    { version: 2, owner, researchObligations });
  inputGuards.push(...derived.guards);
  const resolutions = [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, input]) => input);
  // Saved bases name each selected slice and immediate resolution. Later right-boundary proofs remain observable
  // in the historical trace but cannot change this already saved producer's inputs.
  const inputs = uniqueRefs([...indexes.values(), ...(inspection.executionRoot ? [inspection.executionRoot] : []),
    ...resolutions.flatMap(input => [...(input.source ? [input.source] : []), ...(input.receipt ? [input.receipt] : [])])]);
  const value: FeasibilityDeliveries = { ownership: { root: inspection.executionRoot, indexes: Object.fromEntries(indexes) },
    resolved: resolutions, inputs };
  if (saved && !same(saved, value)) badRecord(id(project), 'deliveries');
  return { value, findings, guards: uniqueRefs(inputGuards), references: uniqueRefs(dependencies) };
}

function resultValue(request: Pick<FeasibilityRequest, 'project' | 'graph' | 'layer' | 'frame' | 'environment'>,
  basis: Sources, inspection: FeasibilityInspection, readiness: ReturnType<typeof readinessObligations>, deliveries: ReturnType<typeof deliveryInputs>): OmFeasibility {
  const retained = readiness.value;
  if (!retained || !same(retained.handoff, basis.obligations.handoff)) return badRecord(id(request.project), 'readiness');
  const d7 = { producer: reference(basis.obligations.producer), ledger: reference(basis.obligations.record) };
  const inputs = uniqueRefs([request.graph, request.layer, request.frame, request.environment,
    reference(basis.candidate), basis.frame.request.horizon, d7.producer, d7.ledger,
    ...(inspection.executionRoot ? [inspection.executionRoot] : []), ...(inspection.workspace ? [inspection.workspace] : []),
    ...readiness.dependencies, ...deliveries.value.inputs]);
  const findings = [...inspection.result.findings, ...readiness.findings, ...deliveries.findings];
  return { contractVersion: REFINEMENT_CONTRACT_VERSION, projectId: request.project, ready: findings.length === 0,
    graph: request.graph, environment: request.environment, repository: inspection.result.state, inputs, findings,
    obligations: retained, producer: { contract: FEASIBILITY_PRODUCER_CONTRACT, project: request.project,
      layer: request.layer, frame: request.frame, candidate: reference(basis.candidate), horizon: basis.frame.request.horizon,
      obligations: d7, readiness: retained, inspection, deliveries: deliveries.value } };
}

/** Read-only preparation: current heads are guards; immutable proof dependencies remain exact saved inputs. */
export function prepareFeasibility(store: Store, request: FeasibilityRequest): FeasibilityResult<Sealed<PreparedFeasibility>> {
  requireRequest(store, request);
  return run(() => {
    const references: Ref[] = [], traced = historicalTrace(store, ref => { references.push(ref); }, 'distinct');
    const basis = sources(traced, request, true);
    environmentAt(traced, request.project, request.environment);
    const workspace = traced.get(`workspace:${request.project}`);
    const effective = new Environments(traced).effective(request.project);
    if (!same(reference(effective.environment), request.environment))
      fail('input_stale', request.environment.id, 'environment', 'M8 uses the selected current environment');
    const executionRoot = effective.guards.find(ref => ref.id === `execution-root:${request.project}`) ?? null;
    const workspaceGuards: TransactionGuard[] = executionRoot
      ? [workspace ? reference(workspace) : { id: `workspace:${request.project}`, absent: true }] : [];
    const inspection: FeasibilityInspection = { graph: request.graph, layer: request.layer, environment: request.environment,
      root: effective.root, executionRoot, workspace: executionRoot && workspace ? reference(workspace) : null,
      result: inspectRepository({ ...effective.environment.value, workspace: effective.root }, basis.graph as Graph) };
    sameSnapshot(traced, request.project, basis.accepted.frame!, inspection.result.state?.tree ?? null);
    const d7 = { producer: reference(basis.obligations.producer), ledger: reference(basis.obligations.record) };
    const readiness = readinessObligations(traced, request.project, [d7.producer, d7.ledger]);
    const deliveries = deliveryInputs(traced, request.project, basis, inspection);
    const value = resultValue(request, basis, inspection, readiness, deliveries);
    // The refusals of the result, in the order of its findings (the inspection's, the readiness', the deliveries'), taken
    // where the result is handed out, as before.
    const refusals = () => [...inspectionRefusals(inspection.result), ...readinessRefusals(readiness), ...deliveryRefusals(deliveries)];
    proveInspection(traced, request.project, value);
    const guards = uniqueTransactionGuards([...basis.guards, request.graph, request.layer, request.frame, request.environment,
      reference(basis.candidate), d7.producer, d7.ledger, ...effective.guards, ...effective.admissionGuards, ...workspaceGuards,
      ...readiness.guards, ...readiness.admissionGuards, ...deliveries.guards]);
    const stale = guards.find(guard => !transactionGuardsCurrent(store, [guard]));
    if (stale) fail('input_stale', stale.id, 'guards', 'A current M8 source changed during preparation');
    const write: Write = { id: id(request.project), kind: 'feasibility', expected: request.expected, value };
    const previous = traced.get<OmFeasibility>(write.id);
    if (previous?.kind === write.kind && [request.expected, request.expected + 1].includes(previous.revision) && same(previous.value, value)) {
      const repeatGuards = uniqueTransactionGuards([...guards, reference(previous)]);
      if (!transactionGuardsCurrent(store, repeatGuards)) fail('input_stale', write.id, 'guards', 'An exact repeat requires its current admission');
      return { record: previous, writes: [], guards: repeatGuards, references: uniqueRefs(references), refusals: refusals() };
    }
    const record: Revision<OmFeasibility> = { id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(value), value };
    return { record, writes: [write], guards, references: uniqueRefs(references), refusals: refusals() };
  });
}

export function writeFeasibility(store: Store, request: FeasibilityRequest): FeasibilityResult<Sealed<Revision<OmFeasibility>>> {
  requireRequest(store, request);
  return run(() => {
    // A late repeat returns the immutable result of that transition, not a new assessment of today's disk.
    const previous = store.get<OmFeasibility>(id(request.project), request.expected + 1);
    if (previous) {
      const saved = take(readFeasibility(store, { project: request.project, record: reference(previous) }));
      if (same(saved.value.graph, request.graph) && same(saved.value.environment, request.environment)
        && same(saved.value.producer.layer, request.layer) && same(saved.value.producer.frame, request.frame)) return saved;
    }
    const prepared = take(prepareFeasibility(store, request));
    if (!prepared.writes.length) return prepared.record;
    return take(writeGuarded<OmFeasibility>(store, { unit: 'M8', target: prepared.record.id,
      writes: prepared.writes, guards: prepared.guards }))[0]!;
  });
}

function requireReadRequest(store: Store, request: { project: string; record: Ref }): void {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('record');
}
export function readFeasibility(store: Store, request: { project: string; record: Ref }): FeasibilityResult<Sealed<Revision<OmFeasibility>>> {
  requireReadRequest(store, request);
  return run(() => {
    const record = take(readRecord<OmFeasibility>(store, request.record, { unit: 'M8', target: request.project, id: id(request.project), kind: 'feasibility' }));
    requireRecord(record.value, request.project);
    const value = record.value, producer = value.producer;
    const sourceRequest = { project: request.project, graph: value.graph, layer: producer.layer, frame: producer.frame, environment: value.environment };
    const basis = sources(store, sourceRequest, false);
    if (!same(producer.candidate, reference(basis.candidate)) || !same(producer.horizon, basis.frame.request.horizon)
      || !same(producer.obligations, { producer: reference(basis.obligations.producer), ledger: reference(basis.obligations.record) })) badRecord(record.id, 'producer');
    proveInspection(store, request.project, value);
    let readiness: ReturnType<typeof readReadinessObligations>;
    try { readiness = readReadinessObligations(store, request.project,
      [producer.obligations.producer, producer.obligations.ledger], value.obligations); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'obligation_handoff_invalid') throw error;
      return badRecord(record.id, 'readiness');
    }
    const deliveries = deliveryInputs(store, request.project, basis, producer.inspection, producer.deliveries);
    if (!same(value, resultValue(sourceRequest, basis, producer.inspection, readiness, deliveries))) badRecord(record.id, 'result');
    return record as Revision<OmFeasibility>;
  });
}

/** G6 repeats the whole current inspection, including dirty/untracked files and executable availability. */
export function gateFeasibility(store: Store, request: { project: string; record: Ref }) {
  requireReadRequest(store, request);
  return run(() => {
    const saved = take(readFeasibility(store, request));
    const value = saved.value;
    const current = take(prepareFeasibility(store, { project: request.project, graph: value.graph,
      layer: value.producer.layer, frame: value.producer.frame, environment: value.environment, expected: saved.revision }));
    if (!same(current.record.value, value)) fail('feasibility_stale', saved.id, 'result', 'A complete new inspection differs from the saved M8 result');
    if (!value.ready) fail('feasibility_not_ready', saved.id, 'findings', 'The saved M8 result has unresolved findings');
    const guards = uniqueTransactionGuards([...current.guards, request.record]);
    const stale = guards.find(guard => !transactionGuardsCurrent(store, [guard]));
    if (stale) fail('input_stale', stale.id, 'guards', 'The current M8 admission changed');
    return { passed: true as const, record: request.record,
      guards, references: current.references };
  });
}

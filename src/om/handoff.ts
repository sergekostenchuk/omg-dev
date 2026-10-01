import { canonical, hashJson } from '../canonical.js';
import { assertPilotBoundary } from '../discovery/reader-pilot.js';
import { EngineError } from '../errors.js';
import { isRef, reference, stageId, uniqueRefs, type Ref, type StageArtifact } from '../pipeline/contracts.js';
import { StageChecks } from '../product/stage-checks.js';
import { transactionGuardsCurrent, uniqueTransactionGuards } from '../runtime/environment.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { readFeasibility } from './feasibility.js';
import { readHorizon } from './horizon.js';
import { readOmInput, withHistoricalReads } from './input.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, type OmResult, type Refusal, type Sealed } from './refusal.js';

export interface HandoffRequest { project: string; feasibility: Ref; expected: number }
export interface HandoffReadRequest { project: string; record: Ref }
export interface PreparedHandoff { record: Revision<StageArtifact>; writes: Write[]; guards: TransactionGuard[] }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const target = (project: string) => stageId(project, 'om-g2');
class Failure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new Failure(result.refusal); return result.value; }
function fail(code: string, id: string, field: string, message: string): never {
  take(refused(code, message, { unit: 'M9', target: id, field }, 'producer'));
  throw new EngineError('handoff_internal', 'A refusal unexpectedly succeeded');
}
function run<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof Failure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function requireRequest(store: Store, request: unknown, read: boolean): void {
  const ref = read ? 'record' : 'feasibility';
  if (!(store instanceof Store) || !object(request) || typeof request['project'] !== 'string' || !request['project'].trim()
    || !isRef(request[ref]) || (!read && (!Number.isSafeInteger(request['expected']) || (request['expected'] as number) < 0))
    || Object.keys(request).some(key => !['project', ref, ...(read ? [] : ['expected'])].includes(key))) {
    throw new EngineError('handoff_request_invalid', 'M9 requires an explicit project, exact basis and transition revision',
      { unit: 'M9', target: 'handoff', field: 'request' });
  }
}
function exactSource(store: Store, ref: Ref): void {
  const found = store.get(ref.id, ref.revision);
  if (!found) fail('record_missing', ref.id, 'proofs', 'A saved handoff basis is missing');
  if (found.hash !== ref.hash) fail('record_forged', ref.id, 'hash', 'A saved handoff basis has different content');
}

/** The saved M8 and its B1 lineage establish history without inspecting today's repository or heads. */
export function readHandoff(store: Store, request: HandoffReadRequest): OmResult<Sealed<Revision<StageArtifact>>> {
  requireRequest(store, request, true);
  return run(() => {
    const record = take(readRecord<StageArtifact>(store, request.record,
      { unit: 'M9', target: request.project, id: target(request.project), kind: 'stage' }));
    const value = record.value;
    if (!object(value) || value.projectId !== request.project || value.stage !== 'om-g2' || value.status !== 'accepted'
      || !object(value.content) || !same(Object.keys(value.content), ['feasibility']) || !isRef(value.content['feasibility'])
      || value.content['feasibility'].id !== `om-feasibility:${request.project}`
      || !Array.isArray(value.inputs) || value.inputs.length !== 1 || !value.inputs.every(isRef)
      || !Array.isArray(value.proofs) || !value.proofs.every(isRef) || !same(value.proofs, uniqueRefs(value.proofs)))
      fail('handoff_record_invalid', record.id, 'record', 'An accepted M9 stage needs its exact M8 and explicit inputs and proofs');
    const m8 = take(readFeasibility(store, { project: request.project, record: value.content['feasibility'] }));
    if (!m8.value.ready) fail('feasibility_not_ready', m8.id, 'ready', 'A handoff requires a proved ready M8');
    const horizon = take(readHorizon(store, request.project, m8.value.producer.horizon));
    const input = take(readOmInput(store, request.project, horizon.horizon.value.request.input));
    const source = input.value.input.sources.find(source => source.stage === 'features');
    const features = source ? { id: source.id, revision: source.revision, hash: source.hash } : null;
    if (!features || !same(value.inputs, [features]))
      fail('handoff_record_invalid', record.id, 'inputs', 'The predecessor must be the accepted features of this M8 lineage');
    const required = [features, reference(m8), m8.value.graph, m8.value.environment];
    if (value.proofs.some(ref => ref.id === record.id) || required.some(ref => !value.proofs.some(proof => same(ref, proof))))
      fail('handoff_record_invalid', record.id, 'proofs', 'The handoff cannot omit its immediate acceptance evidence');
    for (const ref of value.proofs) exactSource(store, ref);
    return record as Revision<StageArtifact>;
  });
}

/** A new admission always uses the current validator; a completed retry is handled only by writeHandoff. */
export function prepareHandoff(store: Store, request: HandoffRequest): OmResult<Sealed<PreparedHandoff>> {
  requireRequest(store, request, false);
  return run(() => {
    const id = target(request.project);
    if (request.feasibility.id !== `om-feasibility:${request.project}`)
      fail('record_foreign', request.feasibility.id, 'feasibility', 'M9 consumes the OM feasibility producer of this project');
    const current = store.get<StageArtifact>(id);
    if ((current?.revision ?? 0) !== request.expected)
      fail('revision_conflict', id, 'expected', 'A new handoff uses the exact stage revision it replaces');
    for (const prior of store.history<StageArtifact>(id)) {
      if (prior.value?.status === 'accepted' && object(prior.value.content) && same(prior.value.content, { feasibility: request.feasibility })) {
        take(readHandoff(store, { project: request.project, record: reference(prior) }));
        fail('handoff_feasibility_unchanged', id, 'feasibility', 'A new handoff requires a new exact M8; retry the original transition instead');
      }
    }
    // Permission heads are captured before checking the boundary; absence remains a transaction guard.
    const boundary = [`reader-pilot:${request.project}`, `phase-policy:${request.project}`].map((id): TransactionGuard => {
      const record = store.get(id); return record ? reference(record) : { id, absent: true };
    });
    try { assertPilotBoundary(store, request.project, 'R3'); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      fail(error.code, error.code.startsWith('phase_') ? `phase-policy:${request.project}` : `reader-pilot:${request.project}`,
        'R3', error.message);
    }
    let prepared: ReturnType<StageChecks['pipeline']['prepareAccepted']>;
    try { prepared = new StageChecks(store).pipeline.prepareAccepted(request.project, 'om-g2',
      { feasibility: { ...request.feasibility } }, request.expected, boundary); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      const detail = Array.isArray(error.details) ? error.details[0] as unknown : error.details;
      const finding = object(detail) ? detail : {};
      fail(typeof finding['code'] === 'string' ? finding['code'] : error.code,
        typeof finding['target'] === 'string' ? finding['target'] : id,
        typeof finding['field'] === 'string' ? finding['field'] : 'admission', error.message);
    }
    const guards = uniqueTransactionGuards(prepared.guards);
    const stale = guards.find(guard => !transactionGuardsCurrent(store, [guard]));
    if (stale) fail('input_stale', stale.id, 'guards', 'An admission dependency changed during preparation');
    const value = prepared.write.value;
    return { record: { id, kind: 'stage', revision: request.expected + 1, hash: hashJson(value), value },
      writes: [prepared.write], guards };
  });
}

export function writeHandoff(store: Store, request: HandoffRequest): OmResult<Sealed<Revision<StageArtifact>>> {
  requireRequest(store, request, false);
  return run(() => {
    const prior = store.get<StageArtifact>(target(request.project), request.expected + 1);
    if (prior?.value?.status === 'accepted' && object(prior.value.content) && same(prior.value.content, { feasibility: request.feasibility }))
      return take(readHandoff(store, { project: request.project, record: reference(prior) })) as Revision<StageArtifact>;
    const prepared = take(prepareHandoff(store, request));
    return take(writeGuarded<StageArtifact>(store, { unit: 'M9', target: prepared.record.id,
      writes: prepared.writes, guards: prepared.guards }))[0]! as Revision<StageArtifact>;
  });
}

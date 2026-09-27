import { readCompletionCloseAt } from './repeat-gate.js';
import { isProxy } from 'node:util/types';
import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EngineError, requireCondition } from '../errors.js';
import { physicalClaim, authorizeModelDispatch, prepareModelCallRecovery, readModelCallRecovery,
  prepareLateModelReceipt, readLateModelReceipt, executionOf } from '../discovery/model-call-recovery.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { ResearchSources } from '../discovery/research-sources.js';
import { contextValue } from '../discovery/working-context.js';
import { sourceIsCurrent, type Source } from '../evidence/evidence.js';
import { uniqueTransactionGuards, workspacePath, type Environment } from '../runtime/environment.js';
import { tokenUsage, type TokenUsage, type ModelCall } from '../runtime/model-usage.js';
import type { ProcessResult } from '../runtime/process.js';
import { delivered, refused, sealed, isPlainObject, type Refusal, type OmResult, type Sealed } from './refusal.js';
import { readRecord, writeGuarded } from './refs.js';
import { readAnswerCitations, prepareAnswerCitations } from './accepted-answer.js';
import { checkAnswerForm, prepareAnswerForm } from './answer-form.js';
import { readPacketResponse, readPartResult, readQuestionPacket, writeQuestionPacket, normalizePartAnswer,
  type PacketRead, type QuestionPacketRecord, type PartProposalBody, type WorksPartBindings } from './question-packet.js';
import { readRoutes } from './routes.js';
import { readFrameProposals, prepareFrameProposals, type LayerProposal } from './frame-proposals.js';
import { WORKS_FRAME_CONTRACT } from './frame-obligations.js';
import { withHistoricalReads, historicalRead } from './input.js';
import { prepareAssessmentAdmission, readAssessmentIntentAt } from './assessment.js';

export const MODEL_CALL_CODES = Object.freeze([
  'model_call_request_invalid', 'model_adapter_response_invalid', 'model_adapter_interrupted',
  'model_delivery_invalid', 'model_read_unavailable',
  'model_parts_invalid', 'model_parts_conflict',
  'model_call_record_invalid', 'model_call_identity_conflict', 'model_call_in_progress', 'model_call_application_pending',
] as const);

export interface AdapterRequest {
  protocol: 'omg-agent/v1'; requestId: string; mode: 'research';
  model: string; effort: string; speed?: 'fast' | 'inherited'; prompt: string;
}
export interface AdapterRequestInput {
  requestId: string; packet: Json; model: string; effort: string; speed?: 'fast' | 'inherited';
}
export interface AdapterResponseInput { requestId: string; process: ProcessResult }
type Confirmed = ModelCall['confirmed'];
interface AdapterResultBase { usage: TokenUsage | null; confirmed: Confirmed }
export type AdapterResult = AdapterResultBase & (
  | { kind: 'answered'; raw: string }
  | { kind: 'interrupted' | 'off-form'; error: { code: string; field: string; message: string } }
);

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const unknownConfirmed = (): Confirmed => ({ model: null, effort: null, speed: null });
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function invalid(field: string): never {
  throw new EngineError('model_call_request_invalid', 'E4 requires an explicit complete request',
    { unit: 'E4', target: 'model-call', field });
}
class CallFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new CallFailure(result.refusal); return result.value; }
function fail(code: string, target: string, field: string, message: string, ref?: Ref): never {
  const result = refused(code, message, { unit: 'E4', target, field, ref }, 'producer');
  if (!result.ok) throw new CallFailure(result.refusal);
  throw new Error('Unreachable');
}
function result<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof CallFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const compareJson = (a: unknown, b: unknown) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
const refs = (values: readonly Ref[]): Ref[] => [...new Map(values.map(ref => [canonical(ref), ref])).values()]
  .sort(compareJson);

/** Wire encoding only. Dispatch admission and the packet proof belong to E1 and E2. */
export function adapterRequest(request: AdapterRequestInput): OmResult<Sealed<AdapterRequest>> {
  if (!object(request) || !text(request.requestId) || !text(request.model)
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(request.effort)
    || !Object.hasOwn(request, 'packet')
    || (Object.hasOwn(request, 'speed') && !['fast', 'inherited'].includes(request.speed as string))
    || Object.keys(request).some(key => !['requestId', 'packet', 'model', 'effort', 'speed'].includes(key))) invalid('request');
  let prompt: string;
  try { prompt = canonical(request.packet); }
  catch (error) { if (error instanceof EngineError) invalid('packet'); throw error; }
  return delivered({ protocol: 'omg-agent/v1', requestId: request.requestId, mode: 'research',
    model: request.model, effort: request.effort, ...(request.speed === undefined ? {} : { speed: request.speed }), prompt });
}

/** Decode transport evidence, not the answer's product form or its acceptance. */
export function readAdapterResponse(request: AdapterResponseInput): OmResult<Sealed<AdapterResult>> {
  if (!object(request) || !text(request.requestId) || !object(request.process)
    || !exactKeys(request, ['requestId', 'process'])
    || !exactKeys(request.process, ['exitCode', 'signal', 'stdout', 'stderr'])
    || !(request.process.exitCode === null || (Number.isInteger(request.process.exitCode) && request.process.exitCode >= 0))
    || !(request.process.signal === null || text(request.process.signal))
    || typeof request.process.stdout !== 'string' || typeof request.process.stderr !== 'string') invalid('process');
  const process = request.process;
  let usage: TokenUsage | null = null;
  let confirmed = unknownConfirmed();
  let envelope: unknown;
  let defect: { field: string; message: string } | null = null;
  try { envelope = JSON.parse(process.stdout); }
  catch { defect = { field: 'stdout', message: 'The adapter must return one JSON envelope' }; }
  if (!defect && (!object(envelope) || envelope.protocol !== 'omg-agent/v1' || envelope.requestId !== request.requestId))
    defect = { field: 'requestId', message: 'The adapter response must name this exact protocol and request' };
  // Usage from another request is not evidence about this dispatch, even on a failed process.
  if (!defect && object(envelope)) {
    try { usage = tokenUsage(envelope.usage); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'usage_invalid') throw error;
      defect = { field: 'usage', message: 'The adapter token counts are malformed' };
    }
    if (object(envelope.confirmed) && exactKeys(envelope.confirmed, ['model', 'effort', 'speed'])
      && Object.values(envelope.confirmed).every(value => value === null || text(value))) {
      confirmed = envelope.confirmed as unknown as Confirmed;
    } else if (process.exitCode === 0 && process.signal === null) {
      defect ??= { field: 'confirmed', message: 'The adapter must explicitly distinguish confirmed settings from unknown settings' };
    }
  }
  if (process.exitCode !== 0 || process.signal !== null) {
    return delivered({ kind: 'interrupted', usage, confirmed, error: { code: 'model_adapter_interrupted', field: 'process',
      message: `Adapter did not complete (exit=${process.exitCode}, signal=${process.signal})` } });
  }
  if (!defect && (!object(envelope) || !exactKeys(envelope, ['protocol', 'requestId', 'research', 'usage', 'confirmed'])))
    defect = { field: 'envelope', message: 'The adapter response requires exactly protocol, requestId, research, usage and confirmed' };
  if (defect) return delivered({ kind: 'off-form', usage, confirmed,
    error: { code: 'model_adapter_response_invalid', ...defect } });
  let raw: string;
  try { raw = canonical((envelope as Record<string, Json>).research!); }
  catch (error) {
    if (!(error instanceof EngineError) || error.code !== 'invalid_json') throw error;
    return delivered({ kind: 'off-form', usage, confirmed,
      error: { code: 'model_adapter_response_invalid', field: 'research', message: 'The adapter payload must be finite JSON' } });
  }
  return delivered({ kind: 'answered', raw, usage, confirmed });
}

export interface ReadDeliveryRequest { project: string; packet: Ref; call: Ref; response: Ref }
export interface ContinuationEvidenceRequest extends ReadDeliveryRequest { deliveries: Ref[] }
export interface ReadDeliveryRecord extends ReadDeliveryRequest {
  questionIds: string[]; read: PacketRead; sources: Ref[]; data: Json;
}
export const READ_DELIVERY_KIND = 'om-read-delivery';
const DELIVERY_SET_KIND = 'om-read-delivery-set';
const deliveryId = (value: ReadDeliveryRecord) => `om-read-delivery:${value.project}:${hashJson(value)}`;
const deliverySetId = (request: ReadDeliveryRequest) => `om-read-deliveries:${request.project}:${hashJson(request)}`;
function requireDeliveryRequest(store: Store, value: unknown, continuation = false): asserts value is ContinuationEvidenceRequest {
  if (!(store instanceof Store) || !object(value) || !text(value.project)
    || ![value.packet, value.call, value.response].every(isRef)
    || !exactKeys(value, ['project', 'packet', 'call', 'response', ...(continuation ? ['deliveries'] : [])])
    || continuation && (!Array.isArray(value.deliveries) || !value.deliveries.every(isRef))) invalid('delivery');
}
function exactSource(store: Store, project: string, ref: Ref, current: boolean): Revision<Source> {
  const record = take(readRecord<Source>(store, ref, { unit: 'E4', target: ref.id, idPrefix: `source:${project}:`, kind: 'source' }));
  if (!object(record.value) || record.value.projectId !== project || typeof record.value.content !== 'string'
    || digest(record.value.content) !== record.value.sha256 || !object(record.value.origin)
    || !['file', 'owner-document'].includes(record.value.origin.kind) || !text(record.value.origin.location)
    || !['text/plain', 'application/json'].includes(record.value.mediaType))
    fail('model_delivery_invalid', ref.id, 'source', 'A read source belongs to this project and retains its captured bytes', ref);
  // An empty file is still a valid read. Nonempty sources also use D5's shared historical selector/checksum proof.
  if (record.value.content.length) take(readAnswerCitations(store, { project,
    citations: [{ source: ref, selector: { kind: 'text-range', start: 0, end: record.value.content.length } }] }));
  if (current) {
    const head = store.get(ref.id);
    if (!head || !same(reference(head), ref) || !sourceIsCurrent(record.value as Source))
      fail('input_stale', ref.id, 'source', 'The addressed source changed before this operation', ref);
  }
  return record as Revision<Source>;
}
function deliveryData(store: Store, project: string, environment: Environment, read: PacketRead, sources: Ref[], current: boolean): Json {
  if (read.action === 'read_source') {
    if (!same(sources, [read.source])) fail('model_delivery_invalid', read.source.id, 'sources', 'The selected source must be the requested source');
    const request = { project, citations: [{ source: read.source, selector: read.selector }] };
    const checked = current ? take(prepareAnswerCitations(store, request)) : take(readAnswerCitations(store, request));
    return checked.grounds[0]!.observation.value as Json;
  }
  if (read.action === 'read_context') {
    if (!same(sources, [read.record])) fail('model_delivery_invalid', read.record.id, 'sources', 'The selected record must be the requested record');
    const found = store.get(read.record.id, read.record.revision);
    if (!found || !same(reference(found), read.record)) fail('model_delivery_invalid', read.record.id, 'record', 'The exact context record must exist');
    const head = current ? store.get(read.record.id) : null;
    if (current && (!head || !same(reference(head), read.record))) fail('input_stale', read.record.id, 'record', 'The selected context changed');
    return contextValue(found.value, read.pointer) as Json;
  }
  const records = sources.map(ref => exactSource(store, project, ref, current));
  if (read.action === 'read') {
    const location = join(environment.workspace, read.path);
    if (records.length !== 1 || records[0]!.value.origin.kind !== 'file'
      || records[0]!.value.origin.location !== location || records[0]!.value.mediaType !== read.media)
      fail('model_delivery_invalid', read.path, 'sources', 'The captured file must be this requested path and media');
    return records[0]!.value.content;
  }
  if (typeof read.within !== 'string' && !same(sources, [read.within]))
    fail('model_delivery_invalid', project, 'sources', 'Search remains inside the named exact source');
  if (typeof read.within === 'string') for (const source of records) {
    const within = relative(join(environment.workspace, read.within), source.value.origin.location);
    if (source.value.origin.kind !== 'file' || within === '..' || within.startsWith('../') || within.startsWith('/'))
      fail('model_delivery_invalid', read.within, 'sources', 'Search sources stay within the requested address');
  }
  return records.flatMap(source => source.value.content.split(/\r?\n/).flatMap((line, index) =>
    line.toLowerCase().includes(read.query.toLowerCase())
      ? [{ source: reference(source), line: index + 1, text: line }] : [])) as unknown as Json;
}

/** One historical proof for E2 continuations and E4 delivery/replay. Current adds freshness, never a different derivation. */
export function readContinuationEvidence(store: Store, request: ContinuationEvidenceRequest, current = false): OmResult<Sealed<{ data: Json[]; novel: boolean; references: Ref[]; guards: Ref[] }>> {
  requireDeliveryRequest(store, request, true); if (typeof current !== 'boolean') invalid('current');
  request = sealed(request) as ContinuationEvidenceRequest;
  const derive = () => result(() => {
    const response = take(readPacketResponse(store, { project: request.project, packet: request.packet, call: request.call, response: request.response }));
    const answerRequest = { project: request.project, packet: request.packet, raw: response.record.value.raw };
    const prepared = current ? take(prepareAnswerForm(store, answerRequest)) : null;
    const checked = prepared ?? take(checkAnswerForm(store, answerRequest));
    if (checked.kind !== 'need-source') fail('model_delivery_invalid', request.response.id, 'action', 'Only an addressed need_source response supplies a continuation');
    if (request.deliveries.length !== checked.reads.length)
      fail('model_delivery_invalid', request.response.id, 'deliveries', 'Every addressed read has exactly one checked delivery');
    const envRef = response.packet.value.request.environment;
    const environment = take(readRecord<Environment>(store, envRef, { unit: 'E4', target: envRef.id, id: `environment:${request.project}`, kind: 'environment' }));
    const references: Ref[] = [...response.references, envRef], guards: Ref[] = prepared ? [...prepared.guards] : [];
    const data = request.deliveries.map((ref, index) => {
      const record = take(readRecord<ReadDeliveryRecord>(store, ref, { unit: 'E4', target: ref.id, idPrefix: `om-read-delivery:${request.project}:`, kind: READ_DELIVERY_KIND }));
      const value = record.value;
      if (record.revision !== 1 || !object(value) || !exactKeys(value, ['project', 'packet', 'call', 'response', 'questionIds', 'read', 'sources', 'data'])
        || !Array.isArray(value.sources) || !value.sources.every(isRef) || record.id !== deliveryId(value as ReadDeliveryRecord)
        || value.project !== request.project || !same(value.packet, request.packet) || !same(value.call, request.call)
        || !same(value.response, request.response) || !same(value.questionIds, checked.questionIds) || !same(value.read, checked.reads[index]))
        fail('model_delivery_invalid', ref.id, 'delivery', 'A delivery belongs to this response, question set and requested read', ref);
      const expected = deliveryData(store, request.project, environment.value as Environment, value.read as PacketRead, value.sources as Ref[], current);
      if (!same(expected, value.data)) fail('model_delivery_invalid', ref.id, 'data', 'The delivery must reproduce data from the exact saved sources', ref);
      references.push(ref, ...value.sources); if (current) guards.push(ref, ...value.sources);
      return { delivery: ref, questionIds: value.questionIds, read: value.read, sources: value.sources, data: value.data } as unknown as Json;
    });
    return { data, novel: addsKnowledge(store, response.packet.value as QuestionPacketRecord, data),
      references: refs(references), guards: refs(guards) };
  });
  return current ? derive() : historicalRead(store, { reader: 'E4.continuation', project: request.project, ref: request.response,
    parameters: request as unknown as Json }, derive,
  () => refused('model_delivery_invalid', 'Delivery provenance contains a cycle', { unit: 'E4', target: request.response.id, field: 'continuation' }, 'producer'));
}

/** Executes only the addresses E3 validated; the sources and actual delivered values remain readable after restart. */
export function deliverModelSources(store: Store, request: ReadDeliveryRequest): OmResult<Sealed<{ deliveries: Ref[]; references: Ref[] }>> {
  requireDeliveryRequest(store, request); request = sealed(request) as ReadDeliveryRequest;
  return result(() => {
    const setId = deliverySetId(request), oldSet = store.get<ContinuationEvidenceRequest>(setId);
    if (oldSet) {
      if (oldSet.kind !== DELIVERY_SET_KIND || oldSet.revision !== 1 || !object(oldSet.value)
        || !exactKeys(oldSet.value, ['project', 'packet', 'call', 'response', 'deliveries'])
        || !Array.isArray(oldSet.value.deliveries) || !oldSet.value.deliveries.every(isRef)
        || !same({ project: oldSet.value.project, packet: oldSet.value.packet, call: oldSet.value.call, response: oldSet.value.response }, request))
        fail('model_delivery_invalid', setId, 'record', 'A delivery transition has one immutable source');
      const checked = take(readContinuationEvidence(store, oldSet.value));
      return { deliveries: oldSet.value.deliveries, references: refs([reference(oldSet), ...checked.references]) };
    }
    const response = take(readPacketResponse(store, request));
    const checked = take(prepareAnswerForm(store, { project: request.project, packet: request.packet, raw: response.record.value.raw }));
    if (checked.kind !== 'need-source') fail('model_delivery_invalid', request.response.id, 'action', 'Delivery requires an addressed need_source response');
    const envRef = response.packet.value.request.environment;
    const environment = take(readRecord<Environment>(store, envRef, { unit: 'E4', target: envRef.id, id: `environment:${request.project}`, kind: 'environment' }));
    const capture = new ResearchSources(store, request.project, environment.value.workspace);
    const writes: Write[] = [], deliveries: Ref[] = [], guards: Ref[] = [...checked.guards, request.response];
    for (const read of checked.reads) {
      let sources: Ref[];
      try {
        if (read.action === 'read') sources = [reference(capture.read(read.path, read.media))];
        else if (read.action === 'read_source') sources = [read.source];
        else if (read.action === 'read_context') sources = [read.record];
        else if (typeof read.within !== 'string') sources = [read.within];
        else {
          const paths: string[] = [];
          const visit = (path: string) => {
            const absolute = workspacePath(environment.value.workspace, path);
            if (realpathSync(absolute) !== absolute) fail('model_read_unavailable', path, 'path', 'Search uses concrete paths without symbolic aliases');
            if (statSync(absolute).isDirectory()) for (const entry of readdirSync(absolute).sort()) {
              if (entry !== '.git') visit(`${path}/${entry}`);
            } else paths.push(path);
          };
          visit(read.within);
          sources = paths.map(path => reference(capture.read(path, 'text/plain')));
        }
      } catch (error) {
        if (error instanceof CallFailure) throw error;
        if (error instanceof EngineError || object(error) && ['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR'].includes(String(error.code)))
          fail('model_read_unavailable', request.response.id, 'reads', error instanceof Error ? error.message : 'The addressed source cannot be read');
        throw error;
      }
      const value: ReadDeliveryRecord = { ...request, questionIds: [...checked.questionIds], read: read as PacketRead, sources,
        data: deliveryData(store, request.project, environment.value as Environment, read as PacketRead, sources, true) };
      const id = deliveryId(value), old = store.get(id);
      if (old && (old.kind !== READ_DELIVERY_KIND || old.revision !== 1 || !same(old.value, value)))
        fail('model_delivery_invalid', id, 'record', 'An immutable delivery cannot be replaced');
      deliveries.push({ id, revision: 1, hash: hashJson(value) }); guards.push(...sources);
      if (old) guards.push(reference(old));
      else if (!writes.some(write => write.id === id)) writes.push({ id, kind: READ_DELIVERY_KIND, expected: 0, value });
    }
    writes.push({ id: setId, kind: DELIVERY_SET_KIND, expected: 0, value: { ...request, deliveries } });
    take(writeGuarded(store, { unit: 'E4', target: request.response.id, writes, guards: refs(guards) }));
    const proof = take(readContinuationEvidence(store, { ...request, deliveries }));
    return { deliveries, references: proof.references as Ref[] };
  });
}


export interface PartAssemblyRequest { project: string; results: Ref[] }
export interface PartAssemblyRecord { project: string; results: Ref[]; proposal: Ref; works?: WorksPartBindings }
export const PART_ASSEMBLY_KIND = 'om-part-assembly';
const definitionSections = ['nodes', 'localConnectors', 'artifacts', 'contracts', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers', 'anchors'] as const;
function requireAssembly(store: Store, value: unknown): asserts value is PartAssemblyRequest {
  if (!(store instanceof Store) || !object(value) || !text(value.project) || !Array.isArray(value.results)
    || !value.results.length || !value.results.every(isRef) || !exactKeys(value, ['project', 'results'])) invalid('parts');
}
function deriveAssembly(store: Store, request: PartAssemblyRequest, current: boolean) {
  const parts = request.results.map(record => take(readPartResult(store, { project: request.project, record })));
  const packets = parts.map(part => take(readQuestionPacket(store, { project: request.project, record: part.record.value.request.packet })));
  const first = packets[0]!, last = packets.at(-1)!, plan = last.value.plan;
  const worksContract = parts[0]!.proposal.value.worksContract;
  const works = parts.at(-1)!.record.value.works;
  if (worksContract !== undefined && (worksContract !== WORKS_FRAME_CONTRACT || parts[0]!.proposal.value.level !== 3))
    fail('model_parts_invalid', first.id, 'worksContract', 'A works assembly requires the supported L3 proposal contract', reference(first));
  if ((worksContract !== undefined) !== (works !== undefined))
    fail('model_parts_invalid', first.id, 'works', 'A works assembly retains the checked final part handoff', reference(first));
  const root = (packet: QuestionPacketRecord) => {
    const { previous: _previous, continuation: _continuation, ...rest } = packet.request; return rest;
  };
  if (!plan || plan.assignments.length !== parts.length || new Set(request.results.map(canonical)).size !== parts.length)
    fail('model_parts_invalid', request.project, 'results', 'A node assembly contains every assigned part exactly once');
  const allAssigned = plan.assignments.flatMap(item => item.obligations);
  if (new Set(allAssigned).size !== allAssigned.length)
    fail('model_parts_invalid', request.project, 'assignments', 'Part assignments do not overlap');
  for (let index = 0; index < parts.length; index++) {
    const packet = packets[index]!, proposal = parts[index]!.proposal.value, payload = packet.value.packet;
    const transfer = parts[index]!.record.value.works;
    if (works ? !transfer || transfer.contract !== works.contract || !same(transfer.producer, works.producer)
      || !same(transfer.ledger, works.ledger) || (index < parts.length - 1 && transfer.bindings.length !== 0)
      : transfer !== undefined)
      fail('model_parts_invalid', packet.id, 'works', 'Every work part must retain one exact handoff; only the final part supplies bindings', reference(packet));
    const prefix = parts.slice(0, index).map((part, prior) => ({ packet: reference(packets[prior]!),
      proposal: reference(part.proposal), result: reference(part.record) }));
    if (!object(payload) || payload.task !== 'node-expansion' || !same(root(packet.value as QuestionPacketRecord), root(first.value as QuestionPacketRecord))
      || !packet.value.plan || !same(packet.value.plan.assignments, plan.assignments) || packet.value.plan.position !== index
      || !same(packet.value.request.previous, prefix) || !same(proposal.base, parts[0]!.proposal.value.base)
      || proposal.level !== parts[0]!.proposal.value.level || proposal.worksContract !== worksContract
      || packet.value.packetContract !== first.value.packetContract || packet.value.answerProtocol !== first.value.answerProtocol)
      fail('model_parts_invalid', packet.id, 'chain', 'Parts must be consecutive results of one exact node assignment', reference(packet));
    const assigned = new Set(plan.assignments[index]!.obligations);
    const covered = new Set([...proposal.fills, ...proposal.replaces].map(fill => fill.obligation));
    if (covered.size !== assigned.size || [...covered].some(id => !assigned.has(id)))
      fail('model_parts_invalid', packet.id, 'fills', 'Each part must fill exactly its assigned obligations before node assembly', reference(packet));
  }
  const definitions: Record<string, unknown[]> = {};
  for (const section of definitionSections) {
    const byId = new Map<string, unknown>();
    for (const part of parts) for (const definition of part.proposal.value[section]) {
      const previous = byId.get(definition.id);
      if (previous !== undefined && !same(previous, definition))
        fail('model_parts_conflict', definition.id, section, 'Части противоречат: one definition has different contents');
      byId.set(definition.id, definition);
    }
    definitions[section] = [...byId.values()];
  }
  const set = (name: 'removes' | 'redefines') => [...new Set(parts.flatMap(part => part.proposal.value[name]))];
  const body = take(normalizePartAnswer({ ...definitions, fills: parts.flatMap(part => part.proposal.value.fills),
    replaces: parts.flatMap(part => part.proposal.value.replaces), removes: set('removes'), redefines: set('redefines') }, worksContract));
  const proposalValue: LayerProposal = { base: parts[0]!.proposal.value.base as LayerProposal['base'], level: parts[0]!.proposal.value.level,
    source: 'input', status: 'proposed', ...body as PartProposalBody, ...(worksContract ? { worksContract } : {}) };
  const key = hashJson(request), proposal: Revision<LayerProposal> = { id: `om-proposal:${request.project}:assembly:${key}`,
    kind: 'layer-proposal', revision: 1, hash: hashJson(proposalValue), value: proposalValue };
  const value: PartAssemblyRecord = { ...request, proposal: reference(proposal), ...(works ? { works: works as WorksPartBindings } : {}) };
  const record: Revision<PartAssemblyRecord> = { id: `om-part-assembly:${request.project}:${key}`, kind: PART_ASSEMBLY_KIND,
    revision: 1, hash: hashJson(value), value };
  const routes = take(readRoutes(store, { project: request.project, record: first.value.request.routes }));
  const source = proposalValue.level === 2 ? routes.record.value.request.gaps.sources.operations : routes.record.value.request.gaps.sources.works;
  if ('state' in source) fail('model_parts_invalid', record.id, 'frame', 'The assigned frame must have its accepted upper source');
  const write: Write = { id: proposal.id, kind: proposal.kind, expected: 0, value: proposal.value };
  const view = pendingCallStore(store, [write]);
  const proposalRequest = { frame: source.frame, proposals: [...source.proposals, reference(proposal)] };
  const historical = take(readFrameProposals(view, proposalRequest));
  const remaining = new Set(historical.result.open.map(item => item.id));
  if (allAssigned.some(id => remaining.has(id))) fail('model_parts_invalid', record.id, 'coverage', 'The assembled proposal leaves an assigned obligation open');
  const prepared = current ? take(prepareFrameProposals(view, proposalRequest)) : null;
  const packetAdmission = current && works ? take(prepareQuestionPacket(store, last.value.request as QuestionPacketRequest)) : null;
  if (packetAdmission && (packetAdmission.writes.length || !same(packetAdmission.record, last)))
    fail('model_parts_invalid', last.id, 'works', 'Assembly requires the current saved assignment and handoff, without producing another packet', reference(last));
  return { record, proposal, references: refs([...parts.flatMap(part => part.references), ...historical.references,
    ...packets.map(reference)]), guards: prepared ? refs([...prepared.guards.filter(ref => ref.id !== proposal.id),
      ...(packetAdmission?.guards ?? [])]) : [] };
}
export function readPartAssembly(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<{
  record: Revision<PartAssemblyRecord>; proposal: Revision<LayerProposal>; references: Ref[];
}>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('assembly.read');
  return result(() => {
    const saved = take(readRecord<PartAssemblyRecord>(store, request.record, { unit: 'E4', target: request.record.id,
      idPrefix: `om-part-assembly:${request.project}:`, kind: PART_ASSEMBLY_KIND }));
    if (!object(saved.value) || saved.value.project !== request.project || !Array.isArray(saved.value.results) || !saved.value.results.length
      || !saved.value.results.every(isRef) || !isRef(saved.value.proposal))
      fail('model_parts_invalid', saved.id, 'record', 'An assembly retains every exact part result');
    const derived = deriveAssembly(store, { project: request.project, results: saved.value.results as Ref[] }, false);
    const proposal = take(readRecord<LayerProposal>(store, saved.value.proposal, { unit: 'E4', target: saved.id,
      id: derived.proposal.id, kind: 'layer-proposal' }));
    if (!same(saved, derived.record) || !same(proposal, derived.proposal))
      fail('model_parts_invalid', saved.id, 'record', 'The assembly and original proposal must match the verified part chain');
    return { record: derived.record, proposal: derived.proposal, references: derived.references };
  });
}
export function assembleModelParts(store: Store, request: PartAssemblyRequest): OmResult<Sealed<{
  record: Revision<PartAssemblyRecord>; proposal: Revision<LayerProposal>; references: Ref[];
}>> {
  requireAssembly(store, request); request = sealed(request) as PartAssemblyRequest;
  return result(() => {
    const id = `om-part-assembly:${request.project}:${hashJson(request)}`, old = store.get(id);
    if (old) {
      const saved = take(readPartAssembly(store, { project: request.project, record: reference(old) }));
      const first = take(readPartResult(store, { project: request.project, record: request.results[0]! }));
      const admitted = take(readCall(store, request.project, first.record.value.request.call));
      const binding = take(readCompletionBinding(store, request.project, admitted.value.series, admitted.value.attempt));
      if (binding) {
        const update = take(prepareCompletionProducts(store, reference(binding), [reference(saved.record)]));
        if (update.writes.length) take(writeGuarded(store, { unit: 'E4', target: id,
          writes: update.writes as Write[], guards: update.guards as TransactionGuard[] }));
      }
      return saved;
    }
    const prepared = deriveAssembly(store, request, true);
    const writes: Write[] = [prepared.proposal, prepared.record]
      .map(record => ({ id: record.id, kind: record.kind, expected: 0, value: record.value }));
    const guards: TransactionGuard[] = [...prepared.guards];
    const first = take(readPartResult(store, { project: request.project, record: request.results[0]! }));
    const admitted = take(readCall(store, request.project, first.record.value.request.call));
    const binding = take(readCompletionBinding(store, request.project, admitted.value.series, admitted.value.attempt));
    if (binding) {
      const update = take(prepareCompletionProducts(pendingCallStore(store, writes), reference(binding), [reference(prepared.record)]));
      writes.push(...update.writes as Write[]); guards.push(...update.guards);
    }
    take(writeGuarded(store, { unit: 'E4', target: id, guards, writes }));
    return { record: prepared.record, proposal: prepared.proposal, references: prepared.references };
  });
}



export interface ModelCycleRecord {
  request: ModelCallRequest;
  steps: { packet: Ref; record: Ref }[];
  results: Ref[];
  assembly: Ref | null;
  next: Ref | null;
  diagnostic: Ref | null;
  terminal: 'outcome' | 'assembled' | 'blocked' | 'parts-invalid' | 'research-no-progress';
}
export interface ModelCycleOutcome {
  record: Revision<ModelCycleRecord>; last: ModelCallOutcome; assembly: Ref | null; diagnostic: Ref | null; repeated: boolean;
}
export const MODEL_CYCLE_KIND = 'om-model-cycle';
const cycleId = (request: ModelCallRequest) => `om-model-cycle:${request.project}:${hashJson(request)}`;
function knowledgeOf(store: Store, value: Json): string[] {
  if (!object(value) || !object(value.read) || !Array.isArray(value.questionIds) || !Array.isArray(value.sources)) invalid('knowledge');
  const read = value.read as unknown as PacketRead;
  const sourceAddress = (ref: Ref) => {
    const record = store.get<Source>(ref.id, ref.revision);
    if (!record || !same(reference(record), ref)) fail('model_delivery_invalid', ref.id, 'source', 'Knowledge needs its exact captured source');
    return record.kind === 'source' ? { origin: record.value.origin, media: record.value.mediaType } : { record: record.id };
  };
  const address = read.action === 'read_source' ? { action: read.action, source: sourceAddress(read.source), selector: read.selector }
    : read.action === 'read_context' ? { action: read.action, record: read.record.id, pointer: read.pointer }
    : read.action === 'search' ? { action: read.action, within: typeof read.within === 'string' ? read.within : sourceAddress(read.within), query: read.query }
    : read;
  const data = read.action === 'search' && Array.isArray(value.data) ? value.data.map(item => {
    if (!object(item) || !isRef(item.source)) invalid('search.data');
    return { ...item, source: sourceAddress(item.source) };
  }) : value.data;
  return value.questionIds.map(question => hashJson({ question, address, data }));
}
function addsKnowledge(store: Store, packet: QuestionPacketRecord, data: readonly Json[]): boolean {
  const payload = packet.packet as Record<string, Json>;
  const delivered = Array.isArray(payload.sourceDeliveries) ? payload.sourceDeliveries.flatMap(item =>
    object(item) && Array.isArray(item.data) ? item.data as Json[] : []) : [];
  const previous = new Set(delivered.flatMap(value => knowledgeOf(store, value)));
  return data.flatMap(value => knowledgeOf(store, value)).some(value => !previous.has(value));
}
function cycleSources(store: Store, project: string, value: ModelCycleRecord): ModelCallOutcome {
  if (!object(value) || !object(value.request) || value.request.project !== project || !Array.isArray(value.steps)
    || !value.steps.length || !Array.isArray(value.results) || !value.results.every(isRef)
    || !exactKeys(value, ['request', 'steps', 'results', 'assembly', 'next', 'diagnostic', 'terminal'])
    || ![value.assembly, value.next, value.diagnostic].every(ref => ref === null || isRef(ref))
    || !value.steps.every(step => object(step) && isRef(step.packet) && isRef(step.record)))
    fail('model_delivery_invalid', project, 'cycle', 'A cycle retains its physical dispatches and exact results');
  const calls = value.steps.map(step => take(readModelCall(store, { project, record: step.record })));
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!, step = value.steps[i]!;
    if (!same(call.record.value.om.request, { ...value.request, packet: step.packet })
      || !same(call.packet, step.packet) || i === 0 && !same(step.packet, value.request.packet))
      fail('model_delivery_invalid', step.record.id, 'packet', 'The physical call must belong to this exact cycle packet');
    const packet = take(readQuestionPacket(store, { project, record: step.packet }));
    if (i > 0) {
      const prior = calls[i - 1]!, priorStep = value.steps[i - 1]!;
      if (prior.outcome?.kind === 'need-source') {
        const c = packet.value.request.continuation;
        if (!c || !same(c.packet, priorStep.packet) || !same(c.call, prior.call) || !same(c.response, prior.response))
          fail('model_delivery_invalid', step.record.id, 'continuation', 'The next physical call must derive from the prior source request');
        const evidence = take(readContinuationEvidence(store, { project, ...c, deliveries: [...c.deliveries] }));
        if (!evidence.novel)
          fail('model_delivery_invalid', step.record.id, 'continuation', 'Repeated knowledge terminates this cycle before another call');
      } else if (prior.part) {
        const previous = packet.value.request.previous.at(-1);
        if (!previous || !same(previous, { packet: priorStep.packet, ...prior.part }))
          fail('model_parts_invalid', step.record.id, 'previous', 'The next part must follow this prior result');
      } else fail('model_delivery_invalid', step.record.id, 'cycle', 'A terminal response does not start another call automatically');
    }
  }
  const results = calls.flatMap(call => call.part ? [call.part.result] : []);
  if (!same(results, value.results)) fail('model_parts_invalid', project, 'results', 'The cycle names exactly its produced part results');
  const last = calls.at(-1)!;
  let completion: { code: string; message: string; evidence: Ref[] } | null = null;
  if (value.terminal !== 'assembled' && value.assembly !== null || value.terminal !== 'blocked' && value.next !== null)
    fail('model_delivery_invalid', project, 'terminal', 'Only the corresponding terminal outcome can name an assembly or blocked successor');
  if (value.terminal === 'assembled') {
    if (!isRef(value.assembly)) fail('model_parts_invalid', project, 'assembly', 'Completed parts need their saved assembled proposal');
    const assembly = take(readPartAssembly(store, { project, record: value.assembly }));
    if (!same(assembly.record.value.results, results)) fail('model_parts_invalid', project, 'assembly', 'The assembly uses exactly this cycle');
  } else if (value.terminal === 'blocked') {
    if (!isRef(value.next))
      fail('model_delivery_invalid', project, 'next', 'Overflow needs its saved blocked packet');
    const next = take(readQuestionPacket(store, { project, record: value.next }));
    const prior = take(readQuestionPacket(store, { project, record: last.packet }));
    let expected: QuestionPacketRequest;
    if (last.outcome?.kind === 'need-source' && last.response) {
      const basis = { project, packet: last.packet, call: last.call, response: last.response };
      const set = store.get<ContinuationEvidenceRequest>(deliverySetId(basis));
      if (!set || set.kind !== DELIVERY_SET_KIND) fail('model_delivery_invalid', project, 'deliveries', 'A blocked continuation needs its deliveries');
      take(readContinuationEvidence(store, set.value));
      expected = { ...prior.value.request, previous: [...prior.value.request.previous],
        continuation: { packet: last.packet, call: last.call, response: last.response, deliveries: [...set.value.deliveries] } };
    } else if (last.part) {
      const { continuation: _continuation, ...root } = prior.value.request;
      expected = { ...root, previous: [...root.previous, { packet: last.packet, ...last.part }] };
    } else fail('model_delivery_invalid', project, 'next', 'Only a source request or completed part can have a successor');
    if (next.value.state !== 'blocked' || !same(next.value.request, expected) || !next.value.refusal)
      fail('model_delivery_invalid', project, 'next', 'Overflow belongs to this exact cycle successor');
    completion = { code: next.value.refusal.code, message: next.value.refusal.message, evidence: [value.next] };
  } else if (value.terminal === 'parts-invalid') {
    const assembled = result(() => deriveAssembly(store, { project, results }, false));
    if (assembled.ok)
      fail('model_parts_invalid', project, 'terminal', 'Valid parts cannot stand for a failed assembly');
    completion = { code: assembled.refusal.code, message: assembled.refusal.message, evidence: results };
  } else if (value.terminal === 'research-no-progress') {
    if (!last.response || last.outcome?.kind !== 'need-source') fail('model_delivery_invalid', project, 'terminal', 'No progress needs an actual repeated read request');
    const request = { project, packet: last.packet, call: last.call, response: last.response };
    const set = store.get<ContinuationEvidenceRequest>(deliverySetId(request));
    if (!set || set.kind !== DELIVERY_SET_KIND) fail('model_delivery_invalid', project, 'deliveries', 'No progress needs the saved read results');
    const evidence = take(readContinuationEvidence(store, set.value));
    if (evidence.novel)
      fail('model_delivery_invalid', project, 'terminal', 'New delivered information cannot be declared a repeated read');
    completion = { code: 'research_no_progress', message: 'The addressed reads add no information to this attempt', evidence: set.value.deliveries };
  } else if (value.terminal !== 'outcome' || last.outcome?.kind === 'need-source' || last.part !== null) {
    fail('model_delivery_invalid', project, 'terminal', 'A nonterminal source/part response cannot end the cycle');
  }
  if (completion) {
    const finished = prepareModelFinish(store, { project, packet: last.packet, call: last.call, response: last.response,
      reason: 'refused', ...completion });
    if (finished.writes.length || !same(finished.diagnostic, value.diagnostic))
      fail('model_delivery_invalid', project, 'diagnostic', 'The cycle must retain its derived journal and completed attempt');
  } else if (!same(value.diagnostic, last.diagnostic))
    fail('model_delivery_invalid', project, 'diagnostic', 'A cycle retains the actual physical outcome diagnostic');
  return last as ModelCallOutcome;
}
export function readModelCycle(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<ModelCycleOutcome>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('cycle.read');
  return result(() => {
    const record = take(readRecord<ModelCycleRecord>(store, request.record, { unit: 'E4', target: request.record.id,
      idPrefix: `om-model-cycle:${request.project}:`, kind: MODEL_CYCLE_KIND }));
    if (!object(record.value) || !object(record.value.request) || record.revision !== 1
      || record.id !== cycleId(record.value.request as ModelCallRequest))
      fail('model_delivery_invalid', record.id, 'request', 'A cycle has one immutable exact request');
    const last = cycleSources(store, request.project, record.value as ModelCycleRecord);
    return { record: record as Revision<ModelCycleRecord>, last, assembly: record.value.assembly, diagnostic: record.value.diagnostic, repeated: true };
  });
}
/** A cycle cursor may be lost after all its products have already closed the attempt.
 * Restore only that cursor; closed work still admits no new products or assignments. */
function prepareCycleCompletion(store: Store, binding: Ref, cycle: Ref, value: ModelCycleRecord) {
  const products = [cycle, ...(value.assembly ? [value.assembly] : []), ...(value.diagnostic ? [value.diagnostic] : [])];
  const head = store.get<CompletionWork>(completionWorkId(value.request.project, binding.id));
  if (!head) fail('completion_invalid', binding.id, 'work', 'A cycle retains its original completion registry');
  const snapshot = take(readCompletionWorkAt(store, value.request.project, reference(head)));
  if (!same(reference(snapshot.binding), binding))
    fail('completion_foreign', cycle.id, 'binding', 'A cycle belongs to its exact completion owner');
  if (!snapshot.work.value.closed) return take(prepareCompletionProducts(store, binding, products));
  // readCompletionWorkAt proves the exact pre-close composition and the common G7 outcome.
  // The cursor itself is optional; every underlying terminal product must be in that composition.
  const sources = refs([...value.steps.map(step => step.record), ...products.slice(1)]);
  if (!sources.every(source => snapshot.products.some(product => same(product, source))))
    fail('completion_closed', cycle.id, 'products', 'Cycle recovery cannot add evidence to a closed attempt');
  return { writes: [] as Write[], guards: [reference(head), binding, ...sources] as TransactionGuard[] };
}
/** Continue only addressed source reads and assigned node parts; neither starts another A3 attempt. */
export async function runModelCycle(store: Store, request: ModelCallRequest, signal?: AbortSignal): Promise<OmResult<Sealed<ModelCycleOutcome>>> {
  requireModelRequest(store, request);
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  request = sealed(request) as ModelCallRequest;
  const id = cycleId(request), old = store.get(id);
  if (old) return result(() => {
    const saved = take(readModelCycle(store, { project: request.project, record: reference(old) }));
    // A terminal cycle is immutable, but late physical evidence may arrive after it.
    // Reconcile every admitted dispatch through the same step as a direct replay.
    for (const step of saved.record.value.steps) {
      const call = same(step.record, reference(saved.last.record)) ? saved.last
        : take(readModelCall(store, { project: request.project, record: step.record }));
      settleAppliedCall(store, call as ModelCallOutcome);
    }
    const owner = saved.last.record.value.om.completionOwner;
    if (owner) {
      const prepared = prepareCycleCompletion(store, owner.binding, reference(saved.record), saved.record.value as ModelCycleRecord);
      if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: owner.binding.id,
        writes: prepared.writes as Write[], guards: prepared.guards as TransactionGuard[] }));
    }
    return saved as ModelCycleOutcome;
  });
  const value: ModelCycleRecord = { request, steps: [], results: [], assembly: null, next: null, diagnostic: null, terminal: 'outcome' };
  let packetRef = request.packet;
  try {
    while (true) {
      const call = take(await runModelCall(store, { ...request, packet: packetRef }, signal));
      value.steps.push({ packet: packetRef, record: reference(call.record) });
      if (call.part) value.results.push(call.part.result);
      value.diagnostic = call.diagnostic;
      const packet = take(readQuestionPacket(store, { project: request.project, record: packetRef }));
      const finish = (code: string, message: string, evidence: Ref[] = []) => {
        value.diagnostic = take(finishModelAttempt(store, { project: request.project, packet: packetRef, call: call.call,
          response: call.response, code, message, reason: 'refused', evidence })).diagnostic;
      };
      if (call.outcome?.kind === 'need-source' && call.response) {
        const basis = { project: request.project, packet: packetRef, call: call.call, response: call.response };
        const delivered = take(deliverModelSources(store, basis));
        const next = take(writeQuestionPacket(store, { ...packet.value.request, previous: [...packet.value.request.previous],
          continuation: { packet: packetRef, call: call.call, response: call.response, deliveries: delivered.deliveries as Ref[] } }));
        if (next.record.value.state !== 'ready') {
          if (next.record.value.refusal?.code === 'research_no_progress') {
            value.terminal = 'research-no-progress';
            finish(next.record.value.refusal.code, next.record.value.refusal.message, delivered.deliveries as Ref[]); break;
          }
          value.terminal = 'blocked'; value.next = reference(next.record);
          finish(next.record.value.refusal?.code ?? 'packet_too_large', next.record.value.refusal?.message ?? 'The complete continuation does not fit', [value.next]); break;
        }
        packetRef = reference(next.record); continue;
      }
      if (call.part && packet.value.plan) {
        if (packet.value.plan.position + 1 < packet.value.plan.assignments.length) {
          const { continuation: _continuation, ...root } = packet.value.request;
          const next = take(writeQuestionPacket(store, { ...root, previous: [...root.previous, { packet: packetRef, ...call.part }] }));
          if (next.record.value.state !== 'ready') {
            value.terminal = 'blocked'; value.next = reference(next.record);
            finish(next.record.value.refusal?.code ?? 'node_unexpandable', next.record.value.refusal?.message ?? 'The next assigned part does not fit', [value.next]); break;
          }
          packetRef = reference(next.record); continue;
        }
        const assembly = assembleModelParts(store, { project: request.project, results: value.results });
        if (assembly.ok) { value.assembly = reference(assembly.value.record); value.terminal = 'assembled'; }
        else { value.terminal = 'parts-invalid'; finish(assembly.refusal.code, assembly.refusal.message, value.results); }
      }
      break;
    }
    return result(() => {
      const last = cycleSources(store, request.project, value);
      const cycleWrite: Write = { id, kind: MODEL_CYCLE_KIND, expected: 0, value };
      const writes = [cycleWrite], guards: TransactionGuard[] = refs(value.steps.map(step => step.record));
      const owner = last.record.value.om.completionOwner;
      if (owner) {
        const work = prepareCycleCompletion(pendingCallStore(store, writes), owner.binding, writeRef(cycleWrite), value);
        writes.push(...work.writes as Write[]); guards.push(...work.guards);
      }
      const written = take(writeGuarded<ModelCycleRecord>(store, { unit: 'E4', target: id, writes, guards }));
      const read = take(readModelCycle(store, { project: request.project, record: reference(written[0]!) }));
      return { ...read, repeated: false } as ModelCycleOutcome;
    });
  } catch (error) { if (error instanceof CallFailure) return { ok: false, refusal: error.refusal }; throw error; }
}

// Dispatch lifecycle.
import { readFileSync as readRejectedFile } from 'node:fs';
import { runProcess } from '../runtime/process.js';
import { recordCall, readCall, readCallLedgerAt, settleCall, prepareCallDispatch, type AnyCallRecord, type AnyRecordCallRequest, type DispatchContract, type CallHistory, type CallLedger } from './call-record.js';
import { prepareQuestionPacket, preparePartResult, partResponseId,
  PART_RESPONSE_KIND, PART_RESULT_KIND, type QuestionPacketRequest, type PartResponseRecord } from './question-packet.js';
import { readAnySeriesAt, seriesRequestOf, prepareCompleteAttempt, prepareSeriesLineAdmission,
  readSeriesWorkAdmission, readSeriesAdmissionChange, type AttemptGoal, type CompletionReason, type SeriesAdmissionChange } from './series.js';
import { prepareRecordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND, type UnitRefusalRecord } from './refusal-journal.js';
import { prepareAddressing, deriveInputDecisions } from './addressing.js';
import { readOmInput, type OmInputRecord } from './input.js';
import type { CheckedAnswerForm } from './answer-form.js';

export interface ModelCallRequest { project: string; packet: Ref; dispatch: DispatchContract; role: 'implementer' | 'reviewer' }
export interface ModelCallOutcome {
  record: Revision<OmModelCall>; packet: Ref; call: Ref; response: Ref | null; outcome: CheckedAnswerForm | null;
  part: { proposal: Ref; result: Ref } | null; diagnostic: Ref | null; repeated: boolean;
}
export interface ModelCallPhysical {
  record: Revision<OmModelCall>; call: Ref; packet: Ref; transport: AdapterResult | null;
}
interface ModelExchange {
  project: string; request: ModelCallRequest; call: Ref; wire: AdapterRequest;
  process: ProcessResult | null; launchError: { code: string; message: string } | null; admissionGuards: Ref[];
}
export type ModelApplicationState = 'running' | 'received' | 'applied' | 'application-refused' | 'recovered';
export type ModelCallState =
  | { state: 'running'; record: Revision<OmModelCall> }
  | { state: 'received'; record: Revision<OmModelCall>; exchange: Revision<ModelExchange>; transport: AdapterResult }
  | { state: 'applied' | 'application-refused' | 'recovered'; outcome: ModelCallOutcome };
export interface OmModelCall extends ModelCall {
  om: { version: 'om-model-call/v1' | 'om-model-call/managed-v1'; completionOwner?: CompletionCallOwner; application: ModelApplicationState; request: ModelCallRequest; call: Ref; exchange: Ref | null;
    part: { proposal: Ref; result: Ref } | null; diagnostic: Ref | null; input: Ref | null; failure: Refusal | null; rejection: Ref | null; completion?: Ref | null;
    admission?: ModelWorkAdmission; terminal?: ModelTerminalWitness };
}
export interface ModelWorkAdmission {
  contract: 'om-model-admission/v1'; series: Ref; pointer: Ref | null;
}
export interface ModelTerminalWitness {
  contract: 'om-model-terminal/v1'; source: Ref; call: Ref; series: Ref; attempt: number; goal: AttemptGoal;
  admission: ModelWorkAdmission; change: SeriesAdmissionChange; reason: 'interrupted';
}
export interface FinishModelAttemptRequest {
  project: string; packet: Ref; call: Ref; response: Ref | null; code: string; message: string;
  reason: Exclude<CompletionReason, 'result'>; evidence?: Ref[];
}
const EXCHANGE_KIND = 'om-model-exchange';
const modelRecordId = (project: string, requestId: string) => `model-call:${project}:om:${hashJson(requestId)}`;
const exchangeId = (request: ModelCallRequest) => `${EXCHANGE_KIND}:${request.project}:${hashJson(request)}`;
const writeRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
export function pendingCallStore(store: Store, writes: readonly Write[]): Store {
  const pending = new Map(writes.map(write => [write.id,
    sealed({ ...writeRef(write), kind: write.kind, value: write.value })]));
  const get = (id: string, revision?: number) => {
    const value = pending.get(id);
    return value && (revision === undefined || revision === value.revision) ? value : store.get(id, revision);
  };
  // A frozen locally constructed overlay over a real Store is an immutable source view.
  // Keep opaque caller proxies opaque: their exact reads may intentionally change beneath a test or transaction.
  if (!isProxy(store)) {
    const methods = Object.create(Store.prototype) as Store;
    const view = Object.create(methods) as Store;
    Object.defineProperty(view, 'path', { value: store.path });
    for (const name of Object.getOwnPropertyNames(Store.prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(Store.prototype, name)!;
      if (descriptor.get) {
        Object.defineProperty(methods, name, { get: () => Reflect.get(store, name, store) });
        continue;
      }
      const member: unknown = Reflect.get(store, name, store);
      if (typeof member === 'function') Object.defineProperty(methods, name, { value: name === 'get' ? get : member.bind(store) });
    }
    Object.freeze(methods);
    return Object.freeze(view) as Store;
  }
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return get;
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
}
function externalGuards(guards: readonly Ref[], writes: readonly Write[]): Ref[] {
  const pending = new Set(writes.map(write => canonical(writeRef(write))));
  return refs(guards.filter(ref => !pending.has(canonical(ref))));
}
function requireModelRequest(store: Store, request: unknown): asserts request is ModelCallRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.packet)
    || !object(request.dispatch) || !exactKeys(request.dispatch, ['adapter', 'config'])
    || !isRef(request.dispatch.adapter) || !isRef(request.dispatch.config)
    || !['implementer', 'reviewer'].includes(request.role as string)
    || !exactKeys(request, ['project', 'packet', 'dispatch', 'role'])) invalid('model-call');
}
function modelAssignment(store: Store, request: ModelCallRequest) {
  const packet = take(readQuestionPacket(store, { project: request.project, record: request.packet }));
  const payload = packet.value.packet;
  if (packet.value.state !== 'ready' || !object(payload) || !text(payload.requestId)
    || !['model-research', 'model-design'].includes(payload.purpose as string) || !packet.value.request.attempt)
    fail('model_call_request_invalid', request.packet.id, 'packet', 'Dispatch requires a ready ordinary E2 assignment', request.packet);
  if (!same(request.dispatch.config, packet.value.request.environment))
    fail('dispatch_contract_invalid', request.packet.id, 'dispatch.config', 'Dispatch must use the exact environment measured in the packet');
  const configured = take(readRecord<Environment>(store, request.dispatch.config,
    { unit: 'E4', target: request.packet.id, id: `environment:${request.project}`, kind: 'environment' }));
  const adapter = take(readRecord<{ protocol: string }>(store, request.dispatch.adapter,
    { unit: 'E4', target: request.packet.id, id: request.dispatch.adapter.id, kind: 'dispatch-adapter' }));
  if (!object(adapter.value) || adapter.value.protocol !== 'codex-stdio')
    fail('dispatch_contract_invalid', request.dispatch.adapter.id, 'protocol', 'E4 executes only the selected codex-stdio dispatch contract');
  const environment = configured.value as Environment;
  if (!object(environment)) fail('dispatch_contract_invalid', configured.id, 'environment', 'A dispatch environment must be a record');
  const binding = environment[request.role];
  if (environment.projectId !== request.project || !object(binding) || !text(binding.actor)
    || !text(binding.model) || !text(binding.effort) || !object(binding.command)
    || !text(binding.command.executable) || !Array.isArray(binding.command.args)
    || !binding.command.args.every(arg => typeof arg === 'string') || !text(environment.workspace)
    || !Number.isSafeInteger(environment.timeoutMs) || environment.timeoutMs < 100 || environment.timeoutMs > 3_600_000)
    fail('dispatch_contract_invalid', configured.id, request.role, 'The exact environment must provide a complete executor binding');
  const wire = take(adapterRequest({ requestId: payload.requestId, packet: payload as Json, model: binding.model,
    effort: binding.effort, ...(binding.speed === undefined ? {} : { speed: binding.speed }) }));
  const series = take(readAnySeriesAt(store, request.project, packet.value.request.attempt.series));
  const attempt = series.value.attempts.find(item => item.ordinal === packet.value.request.attempt!.ordinal);
  if (!attempt) fail('packet_attempt_invalid', request.packet.id, 'attempt', 'The packet must name its exact series attempt');
  const routes = take(readRoutes(store, { project: request.project, record: packet.value.request.routes }));
  const batch = routes.record.value.batches.find(item => item.id === packet.value.request.batch)!;
  const assigned = new Set((payload.questions as { id: string }[]).map(item => item.id));
  const common = { call: payload.requestId, purpose: payload.purpose as 'model-research' | 'model-design', basis: null,
    series: packet.value.request.attempt.series, attempt: attempt.ordinal, goal: attempt.goal,
    dispatch: request.dispatch, packet: payload as Json };
  const assignedItems = batch.items.filter(item => assigned.has(item.gap));
  const mechanismOwner = 'owner' in series.value ? series.value.owner : null;
  const admission: AnyRecordCallRequest = 'owner' in series.value
    ? { ...common, owner: series.value.owner, admission: { routes: packet.value.request.routes, batch: batch.id,
      gaps: routes.record.value.request.gaps }, gaps: assignedItems.map(item => ({ id: item.gap, goal: item.target,
        field: item.field, consumer: mechanismOwner! })) }
    : { ...common, block: series.value.block, gaps: assignedItems.flatMap(item => item.consumers.map(consumer =>
      ({ id: item.target, goal: item.target, field: item.field, consumer }))) };
  return { packet, payload, environment, binding, wire, series, admission };
}
function modelWorkAdmission(store: Store, record: Revision<OmModelCall>, series: Ref): ModelWorkAdmission {
  if (!object(record.value) || !object(record.value.om) || !['om-model-call/v1', 'om-model-call/managed-v1'].includes(record.value.om.version))
    fail('model_call_record_invalid', record.id, 'admission', 'An original admission belongs to a complete E4 runtime record');
  const saved = record.value.om.admission;
  if (saved !== undefined && (!object(saved) || !exactKeys(saved, ['contract', 'series', 'pointer'])
    || saved.contract !== 'om-model-admission/v1' || !isRef(saved.series) || !same(saved.series, series)
    || !(saved.pointer === null || isRef(saved.pointer))))
    fail('model_call_record_invalid', record.id, 'admission', 'The physical call retains its exact original series admission');
  const admission: ModelWorkAdmission = saved ?? { contract: 'om-model-admission/v1', series, pointer: null };
  // A missing field is legacy only when the exact source series proves that era.
  take(readSeriesWorkAdmission(store, { project: record.value.projectId, series, pointer: admission.pointer }));
  return admission;
}
function prepareModelTerminalWitness(store: Store, source: Revision<OmModelCall>) {
  if (source.value.om.completionOwner) return null;
  const call = take(readCall(store, source.value.projectId, source.value.om.call));
  const admission = modelWorkAdmission(store, source, call.value.series);
  const changed = readSeriesAdmissionChange(store, { project: source.value.projectId,
    series: admission.series, pointer: admission.pointer });
  if (!changed.ok) return null;
  return { witness: { contract: 'om-model-terminal/v1', source: reference(source), call: source.value.om.call,
    series: call.value.series, attempt: call.value.attempt, goal: call.value.goal, admission,
    change: changed.value.proof, reason: 'interrupted' } as ModelTerminalWitness, guards: changed.value.guards };
}
/** This proof ends at the physical outcome, before any later explicit A3 completion. */
function modelTerminalBasis(store: Store, project: string, witness: ModelTerminalWitness) {
  if (!object(witness) || !exactKeys(witness, ['contract', 'source', 'call', 'series', 'attempt', 'goal', 'admission', 'change', 'reason'])
    || witness.contract !== 'om-model-terminal/v1' || ![witness.source, witness.call, witness.series].every(isRef)
    || !Number.isSafeInteger(witness.attempt) || witness.attempt < 1 || witness.reason !== 'interrupted'
    || !object(witness.change) || !exactKeys(witness.change, ['contract', 'project', 'series', 'pointer', 'applied', 'currentPointer'])
    || witness.change.contract !== 'series-admission-change/v1' || witness.change.project !== project
    || ![witness.change.series, witness.change.applied, witness.change.currentPointer].every(isRef)
    || !(witness.change.pointer === null || isRef(witness.change.pointer)))
    fail('model_call_record_invalid', project, 'terminal', 'A terminal outcome requires its complete versioned admission-change witness');
  const source = take(readModelCallPhysical(store, { project, record: witness.source }));
  if (!['running', 'received'].includes(source.record.value.om.application))
    fail('model_call_record_invalid', witness.source.id, 'terminal', 'A terminal witness starts at a running claim or saved receipt');
  const call = take(readCall(store, project, witness.call));
  const admission = modelWorkAdmission(store, source.record as Revision<OmModelCall>, call.value.series);
  if (!same(source.call, witness.call) || !same(call.value.series, witness.series) || call.value.attempt !== witness.attempt
    || !same(call.value.goal, witness.goal) || !same(admission, witness.admission)
    || !same(witness.change.series, witness.series) || !same(witness.change.pointer, admission.pointer))
    fail('model_call_record_invalid', witness.source.id, 'terminal', 'Terminal evidence belongs to this exact call, attempt, goal and admission era');
  const changed = take(readSeriesAdmissionChange(store, { project, series: witness.series,
    pointer: admission.pointer, currentPointer: witness.change.currentPointer }));
  if (!same(changed.proof, witness.change))
    fail('model_call_record_invalid', witness.source.id, 'terminal', 'Only the applied A3 change can end the saved admission');
  return { source: source.record as Revision<OmModelCall>, references: refs([witness.source, witness.call, witness.series, ...changed.references]) };
}
function checkModelTerminal(store: Store, record: Revision<OmModelCall>): void {
  if (!Object.hasOwn(record.value.om, 'terminal')) return;
  const witness = record.value.om.terminal!;
  const checked = modelTerminalBasis(store, record.value.projectId, witness), source = checked.source;
  const application = record.value.om.application;
  if (!['application-refused', 'recovered'].includes(application) || source.id !== record.id || source.revision >= record.revision
    || !same(source.value.om.request, record.value.om.request) || !same(source.value.om.call, record.value.om.call)
    || !same(source.value.om.admission ?? null, record.value.om.admission ?? null)
    || record.value.om.diagnostic !== null || record.value.om.completion !== null
    || application === 'application-refused' && (source.value.om.application !== 'received'
      || !same(source.value.om.exchange, record.value.om.exchange))
    || application === 'recovered' && source.value.om.application !== 'running')
    fail('model_call_record_invalid', record.id, 'terminal', 'The terminal witness retains the exact preceding physical outcome without completing A3');
}
export function readModelTerminalWitness(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<{
  series: Ref; attempt: number; goal: AttemptGoal; reason: 'interrupted'; call: Ref; change: SeriesAdmissionChange; references: Ref[];
}>> {
  return result(() => {
    const state = take(readModelCallState(store, request));
    if (state.state !== 'application-refused' && state.state !== 'recovered')
      fail('model_call_record_invalid', request.record.id, 'terminal', 'Only a proved terminal physical outcome can authorize explicit completion');
    const witness = state.outcome.record.value.om.terminal;
    if (!witness) fail('model_call_record_invalid', request.record.id, 'terminal', 'The terminal admission-change witness is required');
    const checked = modelTerminalBasis(store, request.project, witness as ModelTerminalWitness);
    return { series: witness.series, attempt: witness.attempt, goal: witness.goal, reason: witness.reason,
      call: witness.call, change: witness.change, references: refs([request.record, ...checked.references]) };
  });
}
function requireFinish(store: Store, request: unknown): asserts request is FinishModelAttemptRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.packet) || !isRef(request.call)
    || !(request.response === null || isRef(request.response)) || !text(request.code) || !text(request.message)
    || !['refused', 'off-form', 'interrupted', 'awaiting-owner'].includes(request.reason as string)
    || Object.hasOwn(request, 'evidence') && (!Array.isArray(request.evidence) || !request.evidence.every(isRef))
    || Object.keys(request).some(key => !['project', 'packet', 'call', 'response', 'code', 'message', 'reason', 'evidence'].includes(key))) invalid('finish');
}
function prepareModelFinish(store: Store, request: FinishModelAttemptRequest) {
  const packet = take(readQuestionPacket(store, { project: request.project, record: request.packet }));
  const call = take(readCall(store, request.project, request.call));
  if (!packet.value.request.attempt || !object(packet.value.packet)
    || call.value.call !== packet.value.packet.requestId || !same(call.value.series, packet.value.request.attempt.series)
    || call.value.attempt !== packet.value.request.attempt.ordinal)
    fail('model_call_request_invalid', request.packet.id, 'call', 'Completion belongs to this exact admitted packet and attempt');
  if (request.response) take(readPacketResponse(store, { project: request.project, packet: request.packet, call: request.call, response: request.response }));
  const binding = take(readCompletionBinding(store, request.project, call.value.series, call.value.attempt)) as Revision<CompletionOwner> | null;
  const diagnosticWrite = modelFinishDiagnostic(store, request, binding);
  const diagnostic = writeRef(diagnosticWrite), old = store.get(diagnostic.id);
  if (old && (old.kind !== UNIT_REFUSAL_KIND || old.revision !== 1 || !same(old.value, diagnosticWrite.value)))
    fail('model_call_record_invalid', diagnostic.id, 'diagnostic', 'The immutable diagnostic cannot be replaced');
  if (binding && old) return { diagnostic, writes: [] as Write[], guards: [reference(old)] };
  const writes: Write[] = old ? [] : [diagnosticWrite];
  const journal = take(prepareRecordRefusal(pendingCallStore(store, writes), { project: request.project, source: diagnostic }));
  writes.push(...journal.writes);
  const claims = journal.value.rows.filter(row => same(row.source, diagnostic)).map(row => ({ row: row.id, name: row.code, goal: row.goal }));
  if (binding) return { diagnostic, writes, guards: externalGuards([...journal.guards, ...(old ? [reference(old)] : [])], writes) };
  const series = take(readAnySeriesAt(store, request.project, call.value.series));
  const completion = take(prepareCompleteAttempt(pendingCallStore(store, writes), { ...seriesRequestOf(series.value),
    attempt: call.value.attempt, outcome: { reason: request.reason, achieved: [], cancelled: [], refusals: claims } }));
  writes.push(...completion.writes);
  return { diagnostic, writes, guards: externalGuards([...journal.guards, ...completion.guards,
    ...(old ? [reference(old)] : [])], writes) };
}
/** Shared prepared completion; neighbours can atomically persist their result and the single A3 outcome. */
export function prepareModelAttemptFinish(store: Store, request: FinishModelAttemptRequest): OmResult<Sealed<{ diagnostic: Ref; writes: Write[]; guards: Ref[] }>> {
  requireFinish(store, request); request = sealed(request) as FinishModelAttemptRequest;
  return result(() => prepareModelFinish(store, request));
}
/** Records one addressed failure/control outcome through the common journal and A3 transition. */
export function finishModelAttempt(store: Store, request: FinishModelAttemptRequest): OmResult<Sealed<{ diagnostic: Ref }>> {
  requireFinish(store, request); request = sealed(request) as FinishModelAttemptRequest;
  return result(() => {
    const prepared = prepareModelFinish(store, request);
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: request.call.id,
      writes: prepared.writes, guards: prepared.guards }));
    return { diagnostic: prepared.diagnostic };
  });
}
function transportOf(exchange: Pick<ModelExchange, 'wire' | 'call' | 'process' | 'launchError'>): AdapterResult {
  if (exchange.process !== null) return take(readAdapterResponse({ requestId: exchange.wire.requestId, process: exchange.process })) as AdapterResult;
  if (!exchange.launchError || !text(exchange.launchError.code) || !text(exchange.launchError.message))
    fail('model_call_record_invalid', exchange.call.id, 'process', 'Missing process evidence must have an explicit launch/interruption error');
  return { kind: 'interrupted', usage: null, confirmed: unknownConfirmed(), error: { code: exchange.launchError.code,
    field: 'process', message: exchange.launchError.message } };
}
function failureOf(transport: AdapterResult, form: OmResult<Sealed<CheckedAnswerForm>> | null): Refusal | null {
  if (transport.kind !== 'answered') {
    const failed = refused(transport.error.code, transport.error.message, { unit: 'E4', target: 'adapter', field: transport.error.field }, 'producer');
    return failed.ok ? null : failed.refusal;
  }
  return form && !form.ok ? form.refusal : null;
}
function finishReason(transport: AdapterResult, form: CheckedAnswerForm | null, failure: Refusal | null): FinishModelAttemptRequest['reason'] | null {
  if (transport.kind === 'interrupted') return 'interrupted';
  if (transport.kind === 'off-form' || failure) return 'off-form';
  if (form?.kind === 'awaiting-owner') return 'awaiting-owner';
  if (form?.kind === 'no-result') return 'refused';
  return null;
}
function finishDetail(transport: AdapterResult, form: CheckedAnswerForm | null, failure: Refusal | null) {
  if (failure) return { code: failure.code, message: failure.message };
  if (form?.kind === 'awaiting-owner') return { code: 'model_need_owner', message: `${form.reason}; ${form.decision}` };
  if (form?.kind === 'no-result') return { code: `model_${form.action}`, message: form.reason };
  if (transport.kind !== 'answered') return { code: transport.error.code, message: transport.error.message };
  return null;
}

/** Unknown expense is justified only by a complete, unreceived physical claim. */
function requireUnreceivedModelCall(record: Revision<ModelCall>): void {
  const value = record.value;
  for (const field of ['finishedAt', 'response', 'usage', 'error'] as const) {
    if (value[field] !== null)
      fail('model_call_record_invalid', record.id, field, 'An unreceived dispatch retains an explicit null physical outcome');
  }
  if (value.status !== 'running' || Object.hasOwn(value, 'recovery'))
    fail('model_call_record_invalid', record.id, 'status', 'A running dispatch has no terminal recovery');
  if (!Number.isSafeInteger(value.startedAt) || value.startedAt < 0)
    fail('model_call_record_invalid', record.id, 'startedAt', 'A running dispatch retains its physical start time');
  if (!object(value.confirmed) || !same(value.confirmed, unknownConfirmed()) || value.usageSource !== 'unavailable')
    fail('model_call_record_invalid', record.id, 'receipt', 'A running dispatch has no confirmed executor or measured expense');
  try {
    if (!executionOf(value)) fail('model_call_record_invalid', record.id, 'execution', 'OM dispatch retains its mandatory physical claim');
  } catch (error) {
    if (error instanceof EngineError && error.code === 'model_call_execution_invalid')
      fail('model_call_record_invalid', record.id, 'execution', 'The physical claim retains its exact owner and authorization phase');
    throw error;
  }
}

function requireRunningModelCall(record: Revision<OmModelCall>): void {
  requireUnreceivedModelCall(record);
  const value = record.value;
  if (value.om.exchange !== null || value.om.part !== null
    || value.om.input !== null || value.om.diagnostic !== null || value.om.failure !== null || value.om.rejection !== null
    || Object.hasOwn(value.om, 'completion') || Object.hasOwn(value.om, 'terminal'))
    fail('model_call_record_invalid', record.id, 'application', 'A running dispatch has no received or applied evidence');
}

/** Both readers require the original completion unless the checked terminal witness ends admission.
 * This check uses the saved outcome's producers, never the subject reader of the same runtime. */
function checkModelCompletion(store: Store, record: Revision<OmModelCall>, source: { incident: Ref } | { transport: AdapterResult }): void {
  const value = record.value, project = value.projectId;
  if ('incident' in source) {
    if (value.om.terminal) return;
    if (value.om.completion) {
      const admitted = take(readCall(store, project, value.om.call));
      const completed = take(readAnySeriesAt(store, project, value.om.completion));
      const attempt = completed.value.attempts.find(item => item.ordinal === admitted.value.attempt);
      if (completed.id !== admitted.value.series.id || !attempt?.outcome || !same(attempt.goal, admitted.value.goal)
        || value.om.diagnostic !== null)
        fail('model_call_record_invalid', record.id, 'completion', 'Recovery preserves the exact already completed attempt');
    } else {
      if (!isRef(value.om.diagnostic))
        fail('model_call_record_invalid', record.id, 'diagnostic', 'Recovery without a terminal witness retains its original completion diagnostic');
      const finish = recoveryFinish(store, record, source.incident);
      if (finish.writes.length || !same(value.om.diagnostic, finish.diagnostic))
        fail('model_call_record_invalid', record.id, 'diagnostic', 'Physical loss completes A3 once through its shared transition');
    }
    return;
  }
  if (!isRef(value.om.rejection) || !isRef(value.om.exchange))
    fail('model_call_record_invalid', record.id, 'rejection', 'Application rejection needs exact retained source heads and exchange');
  const rejected = take(readModelApplicationRejection(store, { project, record: value.om.rejection }));
  const transport = source.transport;
  if (!same(rejected.record.value.packet, value.om.request.packet) || !same(rejected.record.value.call, value.om.call)
    || !same(rejected.record.value.exchange, value.om.exchange) || !same(value.om.failure, rejected.failure)
    || value.status !== 'failed' || value.error !== rejected.failure.code || value.om.part !== null || value.om.input !== null
    || !same(value.om.terminal ?? null, rejected.record.value.terminal ?? null)
    || !same(value.response, transport.kind === 'answered'
      ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: value.om.exchange } : null))
    fail('model_call_record_invalid', record.id, 'rejection', 'A rejected application retains its original transport and checked failing source window');
  if (value.om.completionOwner) {
    if (value.om.diagnostic !== null) fail('completion_invalid', record.id, 'diagnostic', 'Lost application admission is not a local interrupted terminal');
    return;
  }
  if (!rejected.record.value.terminal && rejected.record.value.completion) {
    if (value.om.diagnostic !== null)
      fail('model_call_record_invalid', record.id, 'diagnostic', 'An already completed attempt is preserved, not completed again');
  } else if (!rejected.record.value.terminal) {
    if (!isRef(value.om.diagnostic))
      fail('model_call_record_invalid', record.id, 'diagnostic', 'Rejection without a terminal witness retains its original completion diagnostic');
    const finish = prepareModelFinish(store, { project, packet: value.om.request.packet, call: value.om.call,
      response: null, code: rejected.failure.code, message: rejected.failure.message, reason: 'interrupted',
      evidence: [value.om.exchange, value.om.rejection] });
    if (finish.writes.length || !same(finish.diagnostic, value.om.diagnostic))
      fail('model_call_record_invalid', record.id, 'diagnostic', 'A rejected application completes its attempt exactly once');
  }
}

function checkedModelExchange(store: Store, request: ModelCallRequest, callRef: Ref, exchangeRef: Ref) {
  const { wire } = modelAssignment(store, request);
    const exchange = take(readRecord<ModelExchange>(store, exchangeRef,
      { unit: 'E4', target: exchangeRef.id, id: exchangeId(request), kind: EXCHANGE_KIND }));
    if (exchange.revision !== 1 || !object(exchange.value)
      || !exactKeys(exchange.value, ['project', 'request', 'call', 'wire', 'process', 'launchError', 'admissionGuards'])
      || exchange.value.project !== request.project || !same(exchange.value.request, request)
      || !same(exchange.value.call, callRef) || !same(exchange.value.wire, wire)
      || !Array.isArray(exchange.value.admissionGuards) || !exchange.value.admissionGuards.length
      || !exchange.value.admissionGuards.every(isRef) || !same(refs(exchange.value.admissionGuards), exchange.value.admissionGuards)
      || (exchange.value.process === null) === (exchange.value.launchError === null))
      fail('model_call_record_invalid', exchangeRef.id, 'exchange', 'Transport evidence must belong to this exact request and original admission');
    for (const guard of exchange.value.admissionGuards) {
      const source = store.get(guard.id, guard.revision);
      if (!source || !same(reference(source), guard))
        fail('model_call_record_invalid', exchangeRef.id, 'admissionGuards', 'The received exchange retains exact dispatch sources');
    }
    return { exchange: exchange as Revision<ModelExchange>, transport: transportOf(exchange.value as ModelExchange) };
}

function requireModelCallRead(store: Store, request: { project: string; record: Ref }): void {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('record');
}
/** Exact E4 provenance and physical usage, including the original terminal completion contract. */
export function readModelCallPhysical(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<ModelCallPhysical>> {
  requireModelCallRead(store, request);
  return result<ModelCallPhysical>(() => {
    const record = take(readRecord<OmModelCall>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `model-call:${request.project}:om:`, kind: 'model-call' }));
    const value = record.value;
    if (!object(value) || Object.hasOwn(value, 'transport') || !object(value.om) || !['om-model-call/v1', 'om-model-call/managed-v1'].includes(value.om.version) || !isRef(value.om.call))
      fail('model_call_record_invalid', record.id, 'om', 'The runtime record needs explicit E4 provenance');
    requireModelRequest(store, value.om.request);
    if (value.om.request.project !== request.project) fail('model_call_record_invalid', record.id, 'project', 'A call belongs to this project');
    const assignment = modelAssignment(store, value.om.request), { packet, payload, wire, binding } = assignment;
    if (record.id !== modelRecordId(request.project, wire.requestId) || value.projectId !== request.project
      || value.draftId !== packet.id || value.requestId !== wire.requestId || value.purpose !== payload.purpose
      || !object(value.requested) || !object(value.request) || !same(value.requested, binding)
      || !same(value.request, { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(payload), record: reference(packet) })
      || !Number.isSafeInteger(value.startedAt)) fail('model_call_record_invalid', record.id, 'request', 'Runtime request must reproduce its exact packet and executor');
    const admitted = take(readCall(store, request.project, value.om.call));
    if (admitted.revision !== 1 || admitted.value.call !== wire.requestId || !same(admitted.value.dispatch, value.om.request.dispatch)
      || !same(admitted.value.packet, { hash: hashJson(payload), chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt) })
      || !same(admitted.value.series, assignment.admission.series) || admitted.value.attempt !== assignment.admission.attempt
      || !same(admitted.value.goal, assignment.admission.goal) || admitted.value.purpose !== assignment.admission.purpose
      || !same(admitted.value.gaps, [...assignment.admission.gaps].sort(compareJson)))
      fail('model_call_record_invalid', record.id, 'call', 'The runtime call must reproduce its E1 admission');
    const completion = checkedCompletionOwner(store, request.project, value.om.call, value.om.request.packet, value.om.completionOwner);
    if (value.om.version !== (completion ? 'om-model-call/managed-v1' : 'om-model-call/v1'))
      fail('completion_invalid', record.id, 'version', 'The physical contract must follow the independently proved attempt era');
    modelWorkAdmission(store, record as Revision<OmModelCall>, admitted.value.series);
    checkModelTerminal(store, record as Revision<OmModelCall>);
    if (value.om.application === 'running') {
      requireRunningModelCall(record as Revision<OmModelCall>);
      return { record: record as Revision<OmModelCall>, call: value.om.call, packet: value.om.request.packet, transport: null };
    }
    if (value.om.application === 'recovered') {
      const recovery = readModelCallRecovery(store, request.project, request.record);
      const original = recovery.original.value as OmModelCall;
      if (original.om?.application !== 'running' || !same(original.om.request, value.om.request)
        || !same(original.om.call, value.om.call) || value.om.exchange !== null || value.om.part !== null
        || value.om.input !== null || value.om.failure !== null || value.om.rejection !== null
        || !(value.om.completion === null || isRef(value.om.completion)))
        fail('model_call_record_invalid', record.id, 'recovery', 'Recovery retains the original unreceived E4 assignment');
      requireRunningModelCall(recovery.original as Revision<OmModelCall>);
      if (value.om.terminal && !same(value.om.terminal.source, reference(recovery.original)))
        fail('model_call_record_invalid', record.id, 'terminal', 'Recovery witness must name the exact lost physical claim');
      if (!Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt)
        fail('model_call_record_invalid', record.id, 'recovery', 'Physical recovery retains a valid completion time');
      checkModelCompletion(store, record as Revision<OmModelCall>, { incident: reference(recovery.incident) });
      return { record: record as Revision<OmModelCall>, call: value.om.call, packet: value.om.request.packet, transport: null };
    }
    if (!isRef(value.om.exchange)) fail('model_call_record_invalid', record.id, 'exchange', 'A completed runtime call needs immutable transport evidence');
    const { transport } = checkedModelExchange(store, value.om.request, value.om.call, value.om.exchange);
    if (!same(value.usage, transport.usage) || !same(value.confirmed, transport.confirmed)
      || value.usageSource !== (transport.usage === null ? 'unavailable' : 'adapter')
      || !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt)
      fail('model_call_record_invalid', record.id, 'receipt', 'Physical usage and executor confirmation derive from the immutable original exchange');
    if (value.om.application === 'received') {
      if (value.status !== (transport.kind === 'answered' ? 'succeeded' : 'failed')
        || value.error !== (transport.kind === 'answered' ? null : transport.error.code)
        || !same(value.response, transport.kind === 'answered'
          ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: value.om.exchange } : null)
        || value.om.part !== null || value.om.input !== null || value.om.diagnostic !== null
        || value.om.failure !== null || value.om.rejection !== null || Object.hasOwn(value.om, 'terminal'))
        fail('model_call_record_invalid', record.id, 'receipt', 'A physical receipt is derived solely from its immutable original exchange');
    } else if (!['applied', 'application-refused'].includes(value.om.application)
      || (value.om.application === 'application-refused') !== (value.om.rejection !== null))
      fail('model_call_record_invalid', record.id, 'application', 'Terminal application states distinguish a product result from a proved refusal');
    if (value.om.application === 'application-refused')
      checkModelCompletion(store, record as Revision<OmModelCall>, { transport });
    return { record: record as Revision<OmModelCall>, call: value.om.call, packet: value.om.request.packet, transport };
  });
}

/** Historical playback additionally checks the saved product application through its original producer. */
export function readModelCallState(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<ModelCallState>> {
  requireModelCallRead(store, request);
  return result<ModelCallState>(() => historicalRead(store, { reader: 'E4.model-call-state', project: request.project, ref: request.record }, () => {
    const physical = take(readModelCallPhysical(store, request));
    const record = physical.record as Revision<OmModelCall>, value = record.value;
    if (value.om.application === 'running') return { state: 'running', record };
    if (value.om.application === 'recovered') {
      return { state: 'recovered', outcome: { record, packet: value.om.request.packet,
        call: value.om.call, response: null, outcome: null, part: null, diagnostic: value.om.diagnostic, repeated: true } };
    }
    const transport = physical.transport as AdapterResult;
    // The physical reader proved this exact exchange; the received DTO also supplies it to application.
    if (!isRef(value.om.exchange)) fail('model_call_record_invalid', record.id, 'exchange', 'A completed runtime call needs immutable transport evidence');
    if (value.om.application === 'received') {
      const exchange = take(readRecord<ModelExchange>(store, value.om.exchange,
        { unit: 'E4', target: record.id, id: exchangeId(value.om.request), kind: EXCHANGE_KIND }));
      return { state: 'received', record, exchange: exchange as Revision<ModelExchange>, transport };
    }
    if (value.om.rejection !== null) {
      return { state: 'application-refused', outcome: { record: record as Revision<OmModelCall>, packet: value.om.request.packet, call: value.om.call,
        response: null, outcome: null, part: null, diagnostic: value.om.diagnostic, repeated: true } };
    }
    const response = value.response?.record ?? null;
    let outcome: CheckedAnswerForm | null = null, form: OmResult<Sealed<CheckedAnswerForm>> | null = null;
    if (transport.kind === 'answered') {
      if (!response) fail('model_call_record_invalid', record.id, 'response', 'A completed adapter answer needs its saved raw source');
      const saved = take(readPacketResponse(store, { project: request.project, packet: value.om.request.packet, call: value.om.call, response }));
      if (saved.record.value.raw !== transport.raw) fail('model_call_record_invalid', record.id, 'raw', 'The response must be the original decoded adapter research');
      form = checkAnswerForm(store, { project: request.project, packet: value.om.request.packet, raw: transport.raw });
      if (form.ok) outcome = form.value as CheckedAnswerForm;
    } else if (response !== null) fail('model_call_record_invalid', record.id, 'response', 'An unsuccessful wire envelope cannot supply a product response');
    const failure = failureOf(transport, form), reason = finishReason(transport, outcome, failure);
    if (!same(value.om.failure, failure)
      || value.status !== (transport.kind === 'answered' && !failure ? 'succeeded' : 'failed')
      || value.error !== (failure?.code ?? null)
      || !same(value.response, response ? { chars: transport.kind === 'answered' ? transport.raw.length : 0,
        bytes: transport.kind === 'answered' ? Buffer.byteLength(transport.raw) : 0, record: response } : null))
      fail('model_call_record_invalid', record.id, 'outcome', 'The stored outcome must be derived from the saved transport and form');
    if (outcome?.kind === 'node-proposal') {
      if (!value.om.part) fail('model_call_record_invalid', record.id, 'part', 'A node answer needs the atomic proposal/result pair');
      const part = take(readPartResult(store, { project: request.project, record: value.om.part.result }));
      if (!same(part.record.value.request, { project: request.project, packet: value.om.request.packet, call: value.om.call, response })
        || !same(reference(part.proposal), value.om.part.proposal) || !same(part.proposal.value, outcome.proposal)
        || !same(part.record.value.works ?? null, outcome.works ?? null))
        fail('model_call_record_invalid', record.id, 'part', 'The part result must derive from this exact response');
    } else if (value.om.part !== null) fail('model_call_record_invalid', record.id, 'part', 'Only node answers supply part results');
    if (outcome?.kind === 'input-decisions') {
      if (!value.om.input) fail('model_call_record_invalid', record.id, 'input', 'Input decisions need their applied D3 result');
      const actual = take(readOmInput(store, request.project, value.om.input));
      const prior = take(readOmInput(store, request.project, outcome.input));
      const expected = take(deriveInputDecisions(store, { project: request.project, previous: prior as Revision<OmInputRecord>,
        graph: outcome.graph, decisions: outcome.decisions }));
      if (!same(actual.value.input, expected.input) || !same(actual.value.gaps, expected.gaps)) fail('model_call_record_invalid', record.id, 'input', 'The saved D3 input must be derived from these exact decisions');
    } else if (value.om.input !== null) fail('model_call_record_invalid', record.id, 'input', 'Only field decisions supply a D3 input');
    if (reason) {
      const detail = finishDetail(transport, outcome, failure)!;
      const finish = prepareModelFinish(store, { project: request.project, packet: value.om.request.packet, call: value.om.call,
        response, ...detail, reason, evidence: [value.om.exchange] });
      if (finish.writes.length || !same(finish.diagnostic, value.om.diagnostic))
        fail('model_call_record_invalid', record.id, 'diagnostic', 'A terminal control/failure needs its original journal and one completed attempt');
    } else if (value.om.diagnostic !== null) fail('model_call_record_invalid', record.id, 'diagnostic', 'A substantive answer cannot manufacture an attempt refusal');
    return { state: 'applied', outcome: { record: record as Revision<OmModelCall>, packet: value.om.request.packet, call: value.om.call, response, outcome,
      part: value.om.part, diagnostic: value.om.diagnostic, repeated: true } };
  }, () => fail('model_call_record_invalid', request.record.id, 'history', 'A physical outcome cannot derive through its own application')));
}

/** Product reads cannot mistake a durable receipt for a completed product result. */
export function readModelCall(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<ModelCallOutcome>> {
  return result(() => {
    const state = take(readModelCallState(store, request));
    if (state.state === 'running') fail('model_call_in_progress', request.record.id, 'application', 'Dispatch has no saved receipt; resending is not safe');
    if (state.state === 'received') fail('model_call_application_pending', request.record.id, 'application', 'The saved receipt must resume application before it is a product result');
    return state.outcome as ModelCallOutcome;
  });
}

/** The only received -> terminal transition. Fresh receipts and restarts use the same current checks,
 * E3 derivation, E2/D3/A3 application and atomic refusal path; neither branch launches a process. */
function applyReceivedModelCall(store: Store, state: Extract<ModelCallState, { state: 'received' }>): OmResult<Sealed<ModelCallOutcome>> {
  const { record: receiptRecord, exchange, transport } = state;
  const request = receiptRecord.value.om.request, call = receiptRecord.value.om.call, id = receiptRecord.id;
  const exchangeRef = reference(exchange), wire = exchange.value.wire;
  const exchangeWrite: Write = { id: exchange.id, kind: exchange.kind, expected: 0, value: exchange.value };
  const writes: Write[] = [], guards: Ref[] = refs([reference(receiptRecord), call, ...exchange.value.admissionGuards, request.packet]);
  try {
    const assignment = modelAssignment(store, request);
    const admission = take(prepareSeriesLineAdmission(store, request.project, assignment.admission.series));
    guards.push(...admission.guards);
    const prepared = take(prepareQuestionPacket(store, assignment.packet.value.request as QuestionPacketRequest));
    if (!same(reference(prepared.record), request.packet))
      fail('model_call_request_invalid', request.packet.id, 'packet', 'Application retains its exact currently admitted assignment');
    guards.push(...prepared.guards); writes.push(...prepared.writes);
    const dispatch = take(prepareCallDispatch(store, request.project, call));
    guards.push(...dispatch.guards);
    let response: Ref | null = null, outcome: CheckedAnswerForm | null = null,
      part: ModelCallOutcome['part'] = null, input: Ref | null = null;
    let checked: OmResult<Sealed<CheckedAnswerForm & { guards: Ref[] }>> | null = null;
    if (transport.kind === 'answered') {
      const responseWrite: Write = { id: partResponseId(request.project, call), kind: PART_RESPONSE_KIND, expected: 0,
        value: { project: request.project, packet: request.packet, call, requestId: wire.requestId, raw: transport.raw } satisfies PartResponseRecord };
      response = writeRef(responseWrite);
      checked = prepareAnswerForm(store, { project: request.project, packet: request.packet, raw: transport.raw });
      if (!checked.ok) {
        const historical = checkAnswerForm(store, { project: request.project, packet: request.packet, raw: transport.raw });
        if (historical.ok || !same(historical.refusal, checked.refusal)) {
          if (historical.ok) guards.push(...historical.value.references);
          throw new CallFailure(checked.refusal);
        }
      }
      if (checked.ok) {
        const { guards: formGuards, ...form } = checked.value;
        outcome = form as CheckedAnswerForm; guards.push(...formGuards);
        if (outcome.kind === 'node-proposal') {
          const produced = take(preparePartResult(store, { project: request.project, packet: request.packet, call, response: { pending: responseWrite } }));
          if (!same(produced.record.value.works ?? null, outcome.works ?? null))
            fail('model_call_record_invalid', id, 'works', 'The part handoff must derive from the same checked saved response');
          writes.push(...produced.writes); guards.push(...produced.guards);
          part = { proposal: reference(produced.proposal), result: reference(produced.record) };
        } else {
          writes.push(responseWrite);
          if (outcome.kind === 'input-decisions') {
            const pending = new Map(outcome.writes.map(write => [write.id, write]));
            const addressed = take(prepareAddressing(store, { project: request.project, input: outcome.input, graph: outcome.graph,
              decisions: outcome.decisions.map(ref => pending.has(ref.id) ? { pending: pending.get(ref.id)! } : { record: ref }) }));
            writes.push(...addressed.writes); guards.push(...addressed.guards); input = reference(addressed.record);
          }
        }
      } else writes.push(responseWrite);
    }
    const failure = failureOf(transport, checked), reason = finishReason(transport, outcome, failure);
    let diagnostic: Ref | null = null;
    if (reason) {
      const finish = prepareModelFinish(pendingCallStore(store, writes), { project: request.project, packet: request.packet, call, response,
        reason, ...finishDetail(transport, outcome, failure)!, evidence: [exchangeRef] });
      writes.push(...finish.writes); guards.push(...finish.guards); diagnostic = finish.diagnostic;
    }
    const finished: OmModelCall = { ...receiptRecord.value,
      status: transport.kind === 'answered' && !failure ? 'succeeded' : 'failed', confirmed: transport.confirmed,
      response: response && transport.kind === 'answered' ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: response } : null,
      usage: transport.usage, usageSource: transport.usage === null ? 'unavailable' : 'adapter', error: failure?.code ?? null,
      om: { ...receiptRecord.value.om, application: 'applied', exchange: exchangeRef, part, input, diagnostic, failure } };
    writes.push({ id, kind: 'model-call', expected: receiptRecord.revision, value: finished });
    if (finished.om.completionOwner) {
      const terminal = writeRef(writes.at(-1)!);
      const work = take(prepareCompletionProducts(pendingCallStore(store, writes), finished.om.completionOwner.binding,
        [terminal, ...(diagnostic ? [diagnostic] : [])]));
      writes.push(...work.writes as Write[]); guards.push(...work.guards.filter(isRef));
    }
    const applicationGuards = externalGuards(guards, writes);
    const committed = writeGuarded<OmModelCall>(store, { unit: 'E4', target: id, writes, guards: applicationGuards });
    const record = take(committed).find(record => record.id === id)!;
    return delivered({ record, packet: request.packet, call, response, outcome, part, diagnostic, repeated: false }) as OmResult<Sealed<ModelCallOutcome>>;
  } catch (error) {
    if (!(error instanceof CallFailure)) throw error;
    // A second race may leave received intact. No settlement or product result is invented;
    // another invocation resumes this same transition from its immutable exchange.
    return saveRejectedModelApplication(store, { request, call, running: receiptRecord, exchange: exchangeWrite,
      transport, writes, guards: externalGuards(guards, writes), failure: error.refusal });
  }
}
/** Accounting belongs to the mutating operation, never to a historical reader. */
function settlePhysicalCall(store: Store, record: Revision<ModelCall> | Sealed<Revision<ModelCall>>, call: Ref): void {
  if (record.value.recovery) settleRecoveredCall(store, record, call);
  else take(settleCall(store, call, record.value.usage, record.value.status === 'succeeded' ? 'succeeded' : 'failed'));
}
function settleAppliedCall(store: Store, outcome: ModelCallOutcome): ModelCallOutcome {
  const owner = outcome.record.value.om.completionOwner;
  if (owner && outcome.record.value.om.application !== 'application-refused') {
    const prepared = take(prepareCompletionProducts(store, owner.binding,
      [reference(outcome.record), ...(outcome.diagnostic ? [outcome.diagnostic] : [])]));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: owner.binding.id,
      writes: prepared.writes as Write[], guards: prepared.guards as TransactionGuard[] }));
  }
  settlePhysicalCall(store, outcome.record, outcome.call);
  return outcome;
}

/** One physical dispatch. Each new continuation is another packet and therefore another E1 call. */
export async function runModelCall(store: Store, request: ModelCallRequest, signal?: AbortSignal): Promise<OmResult<Sealed<ModelCallOutcome>>> {
  requireModelRequest(store, request); request = sealed(request) as ModelCallRequest;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  try {
    const assignment = modelAssignment(store, request), { packet, payload, wire, binding } = assignment;
    const id = modelRecordId(request.project, wire.requestId), old = store.get<OmModelCall>(id);
    if (old) {
      if (!object(old.value) || !object(old.value.om) || !same(old.value.om.request, request))
        fail('model_call_identity_conflict', id, 'request', 'The packet already belongs to another exact dispatch binding');
      const state = take(readModelCallState(store, { project: request.project, record: reference(old) }));
      if (state.state === 'running') fail('model_call_in_progress', id, 'application', 'Dispatch has no saved receipt; resending is not safe');
      const outcome = state.state === 'received' ? take(applyReceivedModelCall(store, state as Extract<ModelCallState, { state: 'received' }>))
        : state.outcome as ModelCallOutcome;
      return delivered(settleAppliedCall(store, outcome as ModelCallOutcome)) as OmResult<Sealed<ModelCallOutcome>>;
    }
    const admission = take(prepareSeriesLineAdmission(store, request.project, assignment.admission.series));
    const prepared = take(prepareQuestionPacket(store, packet.value.request as QuestionPacketRequest));
    if (!same(reference(prepared.record), request.packet)) fail('model_call_request_invalid', request.packet.id, 'packet', 'Dispatch uses exactly the currently admitted E2 packet');
    const guarded = new Proxy(store, { get(target, key) {
      if (key === 'writeMany') return (writes: Write[], guards: Ref[] = []) => target.writeMany(writes, externalGuards([...guards, ...prepared.guards, ...admission.guards, request.packet], writes));
      const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const admitted = take(recordCall(guarded, request.project, assignment.admission));
    // E1 alone precedes the durable running claim. A repeat without that claim has not sent;
    // fresh dispatch admission plus expected=0 arbitrates concurrent resumptions.
    const call = reference(admitted.call), startedAt = Date.now();
    const completion = take(prepareCompletionCall(store, request.project, assignment.admission));
    const claimPacket = take(prepareQuestionPacket(store, packet.value.request as QuestionPacketRequest));
    const running: OmModelCall = { projectId: request.project, draftId: packet.id, purpose: payload.purpose as string,
      requestId: wire.requestId, startedAt, finishedAt: null, status: 'running', requested: binding,
      confirmed: unknownConfirmed(), request: { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(payload), record: request.packet },
      response: null, usage: null, usageSource: 'unavailable', error: null,
      om: { version: completion.owner ? 'om-model-call/managed-v1' : 'om-model-call/v1',
        ...(completion.owner ? { completionOwner: { ...completion.owner, call } } : {}), application: 'running', request, call, exchange: null, part: null, diagnostic: null, input: null, failure: null, rejection: null,
        admission: { contract: 'om-model-admission/v1', series: assignment.admission.series, pointer: admission.pointer } } };
    const physical = await startPhysicalTransport(store, { project: request.project, call, packet: payload as Json, role: request.role },
      { id, kind: 'model-call', expected: 0, value: running }, [...claimPacket.guards, ...admission.guards, request.packet], signal,
      completion.guards as TransactionGuard[], completion.writes as Write[]);
    const runningRecord = physical.record as Revision<OmModelCall>;
    const exchange: ModelExchange = { project: request.project, request, call, wire: wire as AdapterRequest,
      process: physical.process, launchError: physical.launchError, admissionGuards: physical.guards };
    const exchangeWrite: Write = { id: exchangeId(request), kind: EXCHANGE_KIND, expected: 0, value: exchange }, exchangeRef = writeRef(exchangeWrite);
    const transport = transportOf(exchange);
    // Only the running claim guards physical receipt: changed product sources cannot erase received bytes.
    const receipt: OmModelCall = { ...runningRecord.value, finishedAt: Math.max(Date.now(), startedAt),
      status: transport.kind === 'answered' ? 'succeeded' : 'failed', confirmed: transport.confirmed,
      response: transport.kind === 'answered' ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: exchangeRef } : null,
      usage: transport.usage, usageSource: transport.usage === null ? 'unavailable' : 'adapter',
      error: transport.kind === 'answered' ? null : transport.error.code,
      om: { ...running.om, application: 'received', exchange: exchangeRef } };
    const savedReceipt = writeGuarded<OmModelCall>(store, { unit: 'E4', target: id,
      writes: [exchangeWrite, { id, kind: 'model-call', expected: runningRecord.revision, value: receipt }], guards: [reference(runningRecord)] });
    if (!savedReceipt.ok && store.get<ModelCall>(id)?.value.recovery) {
      const recovered = preserveLateTransport(store, request.project, runningRecord, call, physical);
      return delivered(take(readModelCall(store, { project: request.project, record: reference(recovered) }))) as OmResult<Sealed<ModelCallOutcome>>;
    }
    const persisted = take(savedReceipt);
    const state = take(readModelCallState(store, { project: request.project, record: reference(persisted.find(row => row.id === id)!) }));
    if (state.state !== 'received') fail('model_call_record_invalid', id, 'application', 'Physical receipt must precede application');
    const applied = take(applyReceivedModelCall(store, state as Extract<ModelCallState, { state: 'received' }>));
    return delivered(settleAppliedCall(store, applied as ModelCallOutcome)) as OmResult<Sealed<ModelCallOutcome>>;
  } catch (error) {
    if (error instanceof CallFailure) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

export interface ModelTransportRequest { project: string; call: Ref; packet: Json; role: 'implementer' | 'reviewer' }
interface TransportExchange extends Omit<ModelExchange, 'request' | 'admissionGuards'> { request: ModelTransportRequest }
export interface TransportModelCall extends ModelCall {
  transport: { version: 'om-model-transport/v1' | 'om-model-transport/managed-v1'; completionOwner?: CompletionCallOwner; request: ModelTransportRequest; exchange: Ref | null };
}
export interface ModelTransportOutcome { record: Revision<TransportModelCall>; call: Ref; exchange: Ref | null; result: AdapterResult; repeated: boolean }
const DIRECT_TRANSPORT_PURPOSES: readonly string[] = Object.freeze(['fact-assessment', 'stop-analysis', 'origin-analysis']);
const directTransportPurpose = (purpose: string): boolean => DIRECT_TRANSPORT_PURPOSES.includes(purpose);
function requireTransport(store: Store, request: unknown): asserts request is ModelTransportRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.call)
    || !Object.hasOwn(request, 'packet') || !['implementer', 'reviewer'].includes(request.role as string)
    || !exactKeys(request, ['project', 'call', 'packet', 'role'])) invalid('transport');
  try { canonical(request.packet); } catch (error) { if (error instanceof EngineError) invalid('packet'); throw error; }
}
function transportAssignment(store: Store, request: ModelTransportRequest, history?: CallHistory) {
  const call = take(readCall(store, request.project, request.call, history));
  if (call.revision !== 1) fail('model_call_request_invalid', request.call.id, 'call', 'A transport names the original E1 admission');
  const packet = canonical(request.packet);
  if (!same(call.value.packet, { hash: hashJson(request.packet), chars: packet.length, bytes: Buffer.byteLength(packet) }))
    fail('packet_invalid', request.call.id, 'packet', 'The actual sent body must reproduce the admitted fingerprint and both sizes');
  const environment = take(readRecord<Environment>(store, call.value.dispatch.config,
    { unit: 'E4', target: request.call.id, id: `environment:${request.project}`, kind: 'environment' })).value as Environment;
  const adapter = take(readRecord<{protocol: string}>(store, call.value.dispatch.adapter,
    { unit: 'E4', target: request.call.id, id: call.value.dispatch.adapter.id, kind: 'dispatch-adapter' }));
  if (!object(environment)) fail('dispatch_contract_invalid', request.call.id, 'environment', 'A dispatch environment must be a record');
  const binding = environment[request.role];
  if (!object(adapter.value) || adapter.value.protocol !== 'codex-stdio' || environment.projectId !== request.project || !object(binding)
    || !text(binding.actor) || !object(binding.command) || !text(binding.command.executable)
    || !Array.isArray(binding.command.args) || !binding.command.args.every(arg => typeof arg === 'string')
    || !text(environment.workspace) || !Number.isSafeInteger(environment.timeoutMs) || environment.timeoutMs < 100 || environment.timeoutMs > 3_600_000)
    fail('dispatch_contract_invalid', request.call.id, 'dispatch', 'The admitted dispatch must supply the exact supported adapter and environment binding');
  const wire = take(adapterRequest({ requestId: call.value.call, packet: request.packet,
    model: binding.model, effort: binding.effort, ...(binding.speed === undefined ? {} : { speed: binding.speed }) }));
  return { call, environment, binding, wire };
}

function assessmentTransportAdmission(store: Store, request: ModelTransportRequest,
  call: Revision<AnyCallRecord>, binding: { actor: string }, current: boolean): readonly TransactionGuard[] {
  if (call.value.purpose !== 'fact-assessment') return [];
  const basis = call.value.basis;
  if (!basis || basis.kind !== 'fact-assessment' || !basis.assessment) {
    if (!current) return []; // E5.0 physical history predates the mandatory E5 intent.
    fail('model_call_request_invalid', call.id, 'basis.assessment', 'A new assessor dispatch needs its proved E5 intent');
  }
  let proof: { readonly call: string; readonly basis: unknown; readonly gaps: unknown; readonly series: unknown;
    readonly attempt: number; readonly goal: unknown; readonly dispatch: unknown; readonly packet: unknown;
    readonly originalActor: string };
  let admissionGuards: readonly TransactionGuard[] = [];
  if (current) {
    const prepared = take(prepareAssessmentAdmission(store, request.project, basis.assessment));
    proof = prepared;
    admissionGuards = prepared.guards;
  } else proof = take(readAssessmentIntentAt(store, request.project, basis.assessment));
  if (request.role !== 'reviewer' || binding.actor === proof.originalActor
    || call.value.call !== proof.call || !same(call.value.basis, proof.basis)
    || !same(call.value.gaps, proof.gaps) || !same(call.value.series, proof.series)
    || call.value.attempt !== proof.attempt || !same(call.value.goal, proof.goal)
    || !same(call.value.dispatch, proof.dispatch) || !same(request.packet, proof.packet)) {
    fail(current ? 'model_call_request_invalid' : 'model_call_record_invalid', call.id, 'assessment',
      'The assessor dispatch must reproduce its exact intent with a different actual actor');
  }
  return admissionGuards;
}
/** Shared physical boundary: real body fingerprint, current purpose admission and durable claim before spawn. */
async function startPhysicalTransport(store: Store, request: ModelTransportRequest, running: Write, guards: readonly Ref[], signal?: AbortSignal,
  extraGuards: readonly TransactionGuard[] = [], sourceWrites: readonly Write[] = []) {
  const assignment = transportAssignment(store, request), prepared = take(prepareCallDispatch(store, request.project, request.call));
  const assessmentGuards = assessmentTransportAdmission(store, request, assignment.call, assignment.binding, true);
  const line = 'om' in (running.value as ModelCall)
    ? take(prepareSeriesLineAdmission(store, request.project, assignment.call.value.series)) : null;
  const admissionGuards = refs([...guards, ...prepared.guards, ...(line?.guards ?? [])]);
  const counterId = `project-dispatch:${hashJson(request.project)}`;
  const counter = store.get<{ projectId: string; serial: number }>(counterId);
  requireCondition(!counter || (counter.kind === 'project-dispatch' && object(counter.value)
    && counter.value.projectId === request.project && Number.isSafeInteger(counter.value.serial) && counter.value.serial >= 0),
  'research_dispatch_invalid', 'Invalid project dispatch counter');
  let record = take(writeGuarded<ModelCall>(store, { unit: 'E4', target: running.id,
    writes: [...sourceWrites, { ...running, value: { ...running.value as ModelCall, ...physicalClaim() } },
      { id: counterId, kind: 'project-dispatch', expected: counter?.revision ?? 0,
        value: { projectId: request.project, serial: (counter?.value.serial ?? 0) + 1 } }],
    guards: uniqueTransactionGuards([...admissionGuards, ...assessmentGuards, ...extraGuards,
      ...(counter ? [reference(counter)] : [])].filter(guard => !isRef(guard) || !sourceWrites.some(write => same(writeRef(write), guard)))) }))
    .find(row => row.id === running.id)!;
  let processResult: ProcessResult | null = null, launchError: ModelExchange['launchError'] = null;
  try { processResult = await runProcess(assignment.binding.command, assignment.environment.workspace,
    canonical(assignment.wire), assignment.environment.timeoutMs, signal, true, pid => {
      record = authorizeModelDispatch(store, reference(record), pid);
    }); }
  catch (error) {
    // Every typed failure at this physical boundary is retained, including a failed
    // ownership CAS/identity capture in onSpawn. No request was sent on that path.
    if (!(error instanceof EngineError)) throw error;
    launchError = { code: error.code, message: error.message };
  }
  return { record, process: processResult, launchError, guards: admissionGuards };
}
const transportExchangeId = (request: ModelTransportRequest) => `om-model-transport:${request.project}:${hashJson(request)}`;
/** Direct transport keeps E1's body and outcome opaque; it uses the same process boundary as ordinary E2/E3 calls. */
export function readModelTransport(store: Store, request: { project: string; record: Ref }, history?: CallHistory): OmResult<Sealed<ModelTransportOutcome>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('transport-record');
  if (history !== undefined && (!object(history) || !exactKeys(history, ['journal']) || !isRef(history.journal))) invalid('history');
  return result(() => {
    const record = take(readRecord<TransportModelCall>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `model-call:${request.project}:om:`, kind: 'model-call' }));
    if (!object(record.value) || Object.hasOwn(record.value, 'om') || !object(record.value.transport) || !['om-model-transport/v1', 'om-model-transport/managed-v1'].includes(record.value.transport.version))
      fail('model_call_record_invalid', record.id, 'transport', 'Direct transport playback requires explicit transport provenance');
    const source = record.value.transport.request;
    requireTransport(store, source);
    if (source.project !== request.project) fail('model_call_record_invalid', record.id, 'project', 'This transport belongs to this project');
    const { call, wire, binding } = transportAssignment(store, source, history);
    if (!directTransportPurpose(call.value.purpose))
      fail('model_call_request_invalid', call.id, 'purpose', 'Ordinary dispatch is admitted through the E2/E3 orchestrator');
    assessmentTransportAdmission(store, source, call, binding, false);
    const completion = checkedCompletionOwner(store, request.project, source.call,
      call.value.basis?.kind === 'fact-assessment' && call.value.basis.assessment ? call.value.basis.assessment : source.call,
      record.value.transport.completionOwner, history);
    if (record.value.transport.version !== (completion ? 'om-model-transport/managed-v1' : 'om-model-transport/v1'))
      fail('completion_invalid', record.id, 'version', 'Transport version follows its exact purpose and completion era');
    const value = record.value;
    if (record.id !== modelRecordId(request.project, wire.requestId) || value.projectId !== request.project
      || value.draftId !== call.id || value.requestId !== wire.requestId || value.purpose !== call.value.purpose
      || !object(value.requested) || !object(value.request) || !same(value.requested, binding)
      || !same(value.request, { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(source.packet) }))
      fail('model_call_record_invalid', record.id, 'request', 'Direct transport runtime must reproduce the actual admitted body and executor');
    if (value.status === 'running') {
      requireUnreceivedModelCall(record as Revision<TransportModelCall>);
      if (value.transport.exchange !== null)
        fail('model_call_record_invalid', record.id, 'exchange', 'A running direct transport retains an explicit absence of received exchange');
      fail('model_call_in_progress', record.id, 'status', 'The admitted call already owns a physical dispatch');
    }
    if (value.recovery) {
      const recovered = readModelCallRecovery(store, request.project, request.record);
      requireUnreceivedModelCall(recovered.original);
      if (!Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt)
        fail('model_call_record_invalid', record.id, 'finishedAt', 'Direct transport recovery retains its physical completion time');
      if (!same((recovered.original.value as TransportModelCall).transport, value.transport) || value.transport.exchange !== null)
        fail('model_call_record_invalid', record.id, 'recovery', 'Direct transport recovery retains its exact assignment without an invented response');
      return { record: record as Revision<TransportModelCall>, call: source.call, exchange: null, repeated: true,
        result: { kind: 'interrupted' as const, usage: null, confirmed: unknownConfirmed(),
          error: { code: 'process_lost', field: 'process', message: recovered.incident.value.reason } } };
    }
    const ref = value.transport.exchange;
    if (!isRef(ref)) fail('model_call_record_invalid', record.id, 'exchange', 'A completed direct transport keeps the original transport evidence');
    const exchange = take(readRecord<TransportExchange>(store, ref,
      { unit: 'E4', target: record.id, id: transportExchangeId(source), kind: EXCHANGE_KIND }));
    if (exchange.revision !== 1 || !same(exchange.value.request, source) || !same(exchange.value.call, source.call)
      || exchange.value.project !== request.project || !same(exchange.value.wire, wire)
      || !exactKeys(exchange.value, ['project', 'request', 'call', 'wire', 'process', 'launchError'])
      || (exchange.value.process === null) === (exchange.value.launchError === null))
      fail('model_call_record_invalid', record.id, 'exchange', 'The transport evidence must belong to this actual E1 body');
    const decoded = transportOf(exchange.value as TransportExchange);
    if (value.status !== (decoded.kind === 'answered' ? 'succeeded' : 'failed')
      || !same(value.confirmed, decoded.confirmed) || !same(value.usage, decoded.usage)
      || value.usageSource !== (decoded.usage === null ? 'unavailable' : 'adapter')
      || value.error !== (decoded.kind === 'answered' ? null : decoded.error.code)
      || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt
      || !same(value.response, decoded.kind === 'answered' ? { chars: decoded.raw.length, bytes: Buffer.byteLength(decoded.raw), record: ref } : null))
      fail('model_call_record_invalid', record.id, 'outcome', 'Direct transport runtime is derived from the saved adapter response');
    return { record: record as Revision<TransportModelCall>, call: source.call, exchange: ref, result: decoded, repeated: true };
  });
}
export async function runModelTransport(store: Store, request: ModelTransportRequest, signal?: AbortSignal,
  extraGuards: readonly TransactionGuard[] = []): Promise<OmResult<Sealed<ModelTransportOutcome>>> {
  requireTransport(store, request); request = sealed(request) as ModelTransportRequest;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  extraGuards = uniqueTransactionGuards(extraGuards);
  try {
    const { call, wire, binding } = transportAssignment(store, request), id = modelRecordId(request.project, wire.requestId);
    if (!directTransportPurpose(call.value.purpose))
      fail('model_call_request_invalid', request.call.id, 'purpose', 'Ordinary MC1/MC2 calls require the E2/E3 orchestrator');
    const prior = store.get(id);
    if (prior) {
      const saved = take(readModelTransport(store, { project: request.project, record: reference(prior) }));
      if (!same(saved.record.value.transport.request, request)) fail('model_call_identity_conflict', id, 'request', 'A physical identity cannot be rebound to another request');
      settlePhysicalCall(store, saved.record, request.call);
      return delivered(saved) as OmResult<Sealed<ModelTransportOutcome>>;
    }
    const completion = take(prepareCompletionCall(store, request.project, { ...call.value, packet: request.packet } as AnyRecordCallRequest));
    if (completion.writes.length) fail('completion_invalid', call.id, 'work', 'The assessor must be registered before its claim');
    extraGuards = uniqueTransactionGuards([...extraGuards, ...completion.guards]);
    const startedAt = Date.now();
    const running: TransportModelCall = { projectId: request.project, draftId: call.id, purpose: call.value.purpose,
      requestId: call.value.call, startedAt, finishedAt: null, status: 'running', requested: binding, confirmed: unknownConfirmed(),
      request: { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(request.packet) },
      response: null, usage: null, usageSource: 'unavailable', error: null,
      transport: { version: completion.owner ? 'om-model-transport/managed-v1' : 'om-model-transport/v1',
        ...(completion.owner ? { completionOwner: { ...completion.owner, call: request.call } } : {}), request, exchange: null } };
    const physical = await startPhysicalTransport(store, request, { id, kind: 'model-call', expected: 0, value: running }, [], signal, extraGuards);
    const exchange: TransportExchange = { project: request.project, request, call: request.call, wire: wire as AdapterRequest,
      process: physical.process, launchError: physical.launchError };
    const exchangeWrite: Write = { id: transportExchangeId(request), kind: EXCHANGE_KIND, expected: 0, value: exchange }, ref = writeRef(exchangeWrite);
    const decoded = transportOf(exchange);
    const finished: TransportModelCall = { ...physical.record.value as TransportModelCall, finishedAt: Math.max(Date.now(), startedAt),
      status: decoded.kind === 'answered' ? 'succeeded' : 'failed', confirmed: decoded.confirmed, usage: decoded.usage,
      usageSource: decoded.usage === null ? 'unavailable' : 'adapter', error: decoded.kind === 'answered' ? null : decoded.error.code,
      response: decoded.kind === 'answered' ? { chars: decoded.raw.length, bytes: Buffer.byteLength(decoded.raw), record: ref } : null,
      transport: { ...running.transport, exchange: ref } };
    const savedReceipt = writeGuarded<TransportModelCall>(store, { unit: 'E4', target: id,
      writes: [exchangeWrite, { id, kind: 'model-call', expected: physical.record.revision, value: finished }], guards: [reference(physical.record)] });
    if (!savedReceipt.ok && store.get<ModelCall>(id)?.value.recovery) {
      const recovered = preserveLateTransport(store, request.project, physical.record as Revision<ModelCall>, request.call, physical);
      return delivered(take(readModelTransport(store, { project: request.project, record: reference(recovered) }))) as OmResult<Sealed<ModelTransportOutcome>>;
    }
    const written = take(savedReceipt);
    settlePhysicalCall(store, written.find(record => record.id === id)!, request.call);
    return delivered({ record: written.find(record => record.id === id)!, call: request.call, exchange: ref, result: decoded, repeated: false }) as OmResult<Sealed<ModelTransportOutcome>>;
  } catch (error) {
    if (error instanceof CallFailure) {
      return { ok: false, refusal: error.refusal };
    }
    throw error;
  }
}

/** Collect the exact dependency closure traversed by the common historical admission/form readers.
 * This deliberately observes their reads rather than keeping another, inevitably incomplete admission list. */
function historicalApplicationBasis(store: Store, request: ModelCallRequest, call: Ref, transport: AdapterResult): Ref[] {
  const seen: Ref[] = [];
  const observed = new Proxy(store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => {
      const value = target.get(id, revision); if (value) seen.push(reference(value)); return value;
    };
    const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  modelAssignment(observed, request);
  take(readCall(observed, request.project, call));
  if (transport.kind === 'answered') checkAnswerForm(observed, { project: request.project, packet: request.packet, raw: transport.raw });
  return refs(seen);
}

interface ModelApplicationRejection {
  project: string; packet: Ref; call: Ref; exchange: Ref; guards: Ref[]; completion: Ref | null;
  terminal?: ModelTerminalWitness;
  expectations: { id: string; expected: number }[]; heads: { id: string; head: Ref | null }[]; failure: Refusal;
  files: { source: Ref; observation: { kind: 'read'; bytes: string } | { kind: 'unavailable'; code: string } }[];
}
const APPLICATION_REJECTION_KIND = 'om-model-application-rejection';
/** The refused transaction keeps the exact failed expected/observed comparison; later heads cannot rewrite it. */
export function readModelApplicationRejection(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<{record: Revision<ModelApplicationRejection>; failure: Refusal}>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('application-rejection');
  return result(() => {
    const record = take(readRecord<ModelApplicationRejection>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `${APPLICATION_REJECTION_KIND}:${request.project}:`, kind: APPLICATION_REJECTION_KIND }));
    const value = record.value;
    if (record.revision !== 1 || !object(value) || !exactKeys(value, ['project', 'packet', 'call', 'exchange', 'guards', 'expectations', 'heads', 'failure', 'files', 'completion',
      ...(Object.hasOwn(value, 'terminal') ? ['terminal'] : [])])
      || value.project !== request.project || ![value.packet, value.call, value.exchange].every(isRef)
      || !(value.completion === null || isRef(value.completion))
      || !Array.isArray(value.guards) || !value.guards.every(isRef) || !Array.isArray(value.expectations)
      || !value.expectations.every(row => object(row) && text(row.id) && Number.isSafeInteger(row.expected) && Number(row.expected) >= 0)
      || !Array.isArray(value.heads) || !value.heads.every(row => object(row) && text(row.id) && (row.head === null || isRef(row.head) && row.head.id === row.id))
      || !object(value.failure) || !['input_stale', 'revision_conflict'].includes(value.failure.code) || !text(value.failure.message)
      || !Array.isArray(value.files) || !value.files.every(file => object(file) && isRef(file.source) && object(file.observation))
      || record.id !== `${APPLICATION_REJECTION_KIND}:${request.project}:${hashJson(value)}`)
      fail('model_call_record_invalid', record.id, 'rejection', 'An immutable rejection needs explicit expected and observed source identities');
    take(readQuestionPacket(store, { project: request.project, record: value.packet }));
    const exchange = take(readRecord<ModelExchange>(store, value.exchange,
      { unit: 'E4', target: record.id, idPrefix: `${EXCHANGE_KIND}:${request.project}:`, kind: EXCHANGE_KIND }));
    requireModelRequest(store, exchange.value.request);
    if (!same(exchange.value.request.packet, value.packet) || !same(exchange.value.call, value.call))
      fail('model_call_record_invalid', record.id, 'exchange', 'A rejection belongs to its exact E2 assignment and admitted exchange');
    const assignment = modelAssignment(store, exchange.value.request);
    if (!same(exchange.value.wire, assignment.wire)) fail('model_call_record_invalid', record.id, 'wire', 'A rejection keeps the actual admitted wire');
    const decoded = transportOf(exchange.value as ModelExchange);
    const checked = decoded.kind === 'answered' ? checkAnswerForm(store, { project: request.project, packet: value.packet, raw: decoded.raw }) : null;
    const runtimeId = modelRecordId(request.project, exchange.value.wire.requestId), runtime = store.get<OmModelCall>(runtimeId, 1);
    if (!runtime) fail('model_call_record_invalid', record.id, 'runtime', 'A rejected transaction follows its durable pre-dispatch claim');
    const originalCall = take(readCall(store, request.project, value.call));
    const originalAdmission = modelWorkAdmission(store, runtime, originalCall.value.series);
    const originalProof = take(readSeriesWorkAdmission(store, { project: request.project,
      series: originalAdmission.series, pointer: originalAdmission.pointer }));
    let terminalReferences: Ref[] = [];
    if (Object.hasOwn(value, 'terminal')) {
      const terminal = modelTerminalBasis(store, request.project, value.terminal!);
      if (terminal.source.id !== runtimeId || terminal.source.value.om.application !== 'received'
        || !same(value.terminal!.call, value.call) || !same(terminal.source.value.om.request.packet, value.packet)
        || !same(terminal.source.value.om.exchange, value.exchange) || value.completion !== null || value.failure.code !== 'input_stale')
        fail('model_call_record_invalid', record.id, 'terminal', 'The rejected application retains its own received outcome and proved admission change');
      terminalReferences = terminal.references;
    }
    const relevant = new Set(refs([reference(runtime), ...originalProof.references,
      ...value.guards.filter(ref => {
        if (ref.id !== runtimeId) return false;
        const prior = store.get<OmModelCall>(ref.id, ref.revision);
        return prior && same(reference(prior), ref) && prior.value.om?.application === 'received'
          && same(prior.value.om.exchange, value.exchange) && same(prior.value.om.call, value.call);
      }), ...historicalApplicationBasis(store, exchange.value.request, value.call, decoded)]).map(canonical));
    if (value.completion) {
      const completed = take(readAnySeriesAt(store, request.project, value.completion));
      const original = take(readCall(store, request.project, value.call));
      const attempt = [...completed.value.inherited, ...completed.value.attempts].find(item => item.ordinal === original.value.attempt);
      if (completed.id !== original.value.series.id || !attempt?.outcome || !same(attempt.goal, original.value.goal)
        || !same(value.heads.find(row => row.id === completed.id)?.head ?? null, value.completion))
        fail('model_call_record_invalid', record.id, 'completion', 'An existing outcome must be the checked completion of the original admitted attempt');
    }
    const relevantStale = value.guards.filter(ref => relevant.has(canonical(ref))
      && !same(value.heads.find(row => row.id === ref.id)?.head ?? null, ref));
    const outputIds = new Set([runtimeId, value.exchange.id, partResponseId(request.project, value.call)]);
    if (decoded.kind === 'answered') {
      const responseValue: PartResponseRecord = { project: request.project, packet: value.packet, call: value.call,
        requestId: exchange.value.wire.requestId, raw: decoded.raw };
      const response = { id: partResponseId(request.project, value.call), revision: 1, hash: hashJson(responseValue) };
      const partKey = hashJson({ project: request.project, packet: value.packet, call: value.call, response });
      outputIds.add(`om-proposal:${request.project}:part:${partKey}`); outputIds.add(`om-part-result:${request.project}:${partKey}`);
    }
    if (checked?.ok && checked.value.kind === 'input-decisions') {
      outputIds.add(checked.value.input.id); for (const ref of checked.value.decisions) outputIds.add(ref.id);
    }
    const ids = [...new Set([...value.guards.map(ref => ref.id), ...value.expectations.map(row => row.id)])].sort();
    if (!same(value.heads.map(row => row.id), ids))
      fail('model_call_record_invalid', record.id, 'heads', 'Every guarded input and written identity has one observed head');
    for (const ref of [...value.guards, ...value.heads.flatMap(row => row.head ? [row.head] : []), value.packet, value.call, value.exchange]) {
      const row = store.get(ref.id, ref.revision);
      if (!row || !same(reference(row), ref)) fail('model_call_record_invalid', record.id, 'heads', 'Retained failure evidence must resolve at its exact historical revision');
    }
    const head = (id: string) => value.heads.find(row => row.id === id)!.head;
    let fileStale = false;
    for (const file of value.files) {
      if (!value.guards.some(ref => same(ref, file.source)) || !relevant.has(canonical(file.source)))
        fail('model_call_record_invalid', record.id, 'files', 'Observed files must belong to the actual guarded historical sources');
      const source = take(readRecord<Source>(store, file.source, { unit: 'E4', target: record.id, idPrefix: `source:${request.project}:`, kind: 'source' }));
      if (source.value.projectId !== request.project || source.value.origin.kind !== 'file' || digest(source.value.content) !== source.value.sha256)
        fail('model_call_record_invalid', record.id, 'files', 'A file observation compares a valid exact file source');
      const observation = file.observation;
      if (observation.kind === 'read') {
        if (typeof observation.bytes !== 'string' || Buffer.from(observation.bytes, 'base64').toString('base64') !== observation.bytes
          || Buffer.from(observation.bytes, 'base64').length > 5_000_000)
          fail('model_call_record_invalid', record.id, 'files', 'A retained read contains bounded exact file bytes');
        fileStale ||= digest(Buffer.from(observation.bytes, 'base64')) !== source.value.sha256;
      } else if (observation.kind === 'unavailable' && ['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR', 'EPERM', 'file_alias', 'file_too_large'].includes(observation.code)) fileStale = true;
      else fail('model_call_record_invalid', record.id, 'files', 'Unavailable file evidence names the concrete failed read');
    }
    const stale = fileStale || relevantStale.length > 0 || terminalReferences.length > 0;
    const conflict = value.expectations.some(row => outputIds.has(row.id) && (head(row.id)?.revision ?? 0) !== row.expected);
    if (value.failure.code === 'revision_conflict' ? !conflict : !stale)
      fail('model_call_record_invalid', record.id, 'failure', 'The retained identities must prove the rejected transaction class');
    return { record: record as Revision<ModelApplicationRejection>, failure: value.failure as Refusal };
  });
}
function saveRejectedModelApplication(store: Store, input: { request: ModelCallRequest; call: Ref; running: Revision<OmModelCall>;
  exchange: Write; transport: AdapterResult; failure: Refusal; writes: Write[]; guards: Ref[] }): OmResult<Sealed<ModelCallOutcome>> {
  return result(() => {
    const { request, call, running, exchange, transport } = input, exchangeRef = writeRef(exchange);
    const normalized = refused('input_stale', `${input.failure.code}: ${input.failure.message}`,
      { ...input.failure.at, unit: 'E4' }, 'producer');
    let failure = ['input_stale', 'revision_conflict'].includes(input.failure.code) ? input.failure
      : !normalized.ok ? normalized.refusal : input.failure;
    const admitted = take(readCall(store, request.project, call)), seriesHead = store.get(admitted.value.series.id);
    const series = seriesHead ? take(readAnySeriesAt(store, request.project, reference(seriesHead))) : null;
    const completed = series?.value.attempts.find(item => item.ordinal === admitted.value.attempt)?.outcome;
    const completion = completed && series ? reference(series) : null;
    const terminal = completion ? null : prepareModelTerminalWitness(store, running);
    if (terminal && !normalized.ok) failure = normalized.refusal;
    const ids = [...new Set([...input.guards.map(ref => ref.id), ...input.writes.map(write => write.id)])].sort();
    const value: ModelApplicationRejection = { project: request.project, packet: request.packet, call, exchange: exchangeRef, completion,
      ...(terminal ? { terminal: terminal.witness } : {}),
      guards: input.guards, expectations: input.writes.map(write => ({ id: write.id, expected: write.expected })),
      heads: ids.map(id => { const head = store.get(id); return { id, head: head ? reference(head) : null }; }), failure,
      files: input.guards.flatMap(ref => {
        const source = store.get<Source>(ref.id, ref.revision);
        if (!source || source.kind !== 'source' || !object(source.value) || source.value.projectId !== request.project
          || !object(source.value.origin) || source.value.origin.kind !== 'file' || sourceIsCurrent(source.value)) return [];
        let observation: ModelApplicationRejection['files'][number]['observation'];
        try {
          const path = source.value.origin.location;
          observation = realpathSync(path) !== path ? { kind: 'unavailable', code: 'file_alias' }
            : statSync(path).size > 5_000_000 ? { kind: 'unavailable', code: 'file_too_large' }
            : { kind: 'read', bytes: readRejectedFile(path).toString('base64') };
        } catch (error) {
          if (!object(error) && !(error instanceof Error)) throw error;
          const code = String((error as NodeJS.ErrnoException).code);
          if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR', 'EPERM'].includes(code)) throw error;
          observation = { kind: 'unavailable', code };
        }
        return [{ source: ref, observation }];
      }) };
    const rejected: Write = { id: `${APPLICATION_REJECTION_KIND}:${request.project}:${hashJson(value)}`,
      kind: APPLICATION_REJECTION_KIND, expected: 0, value };
    const rejectionRef = writeRef(rejected), writes = [rejected];
    take(readModelApplicationRejection(pendingCallStore(store, writes), { project: request.project, record: rejectionRef }));
    const finish = running.value.om.completionOwner || completion || terminal ? { diagnostic: null, writes: [], guards: terminal?.guards ?? [] }
      : prepareModelFinish(pendingCallStore(store, writes), { project: request.project, packet: request.packet, call,
        response: null, code: failure.code, message: failure.message, reason: 'interrupted', evidence: [exchangeRef, rejectionRef] });
    writes.push(...finish.writes);
    const finished: OmModelCall = { ...running.value, finishedAt: Math.max(Date.now(), running.value.startedAt), status: 'failed',
      confirmed: transport.confirmed, usage: transport.usage, usageSource: transport.usage === null ? 'unavailable' : 'adapter', error: failure.code,
      response: transport.kind === 'answered' ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: exchangeRef } : null,
      om: { ...running.value.om, application: 'application-refused', exchange: exchangeRef, failure, rejection: rejectionRef, diagnostic: finish.diagnostic,
        ...(terminal ? { terminal: terminal.witness, completion: null } : {}) } };
    writes.push({ id: running.id, kind: running.kind, expected: running.revision, value: finished });
    const committed = take(writeGuarded<OmModelCall>(store, { unit: 'E4', target: running.id, writes,
      guards: externalGuards([reference(running), ...finish.guards], writes) }));
    return { record: committed.find(row => row.id === running.id)!, packet: request.packet, call,
      response: null, outcome: null, part: null, diagnostic: finish.diagnostic, repeated: false };
  });
}

function recoveryFinish(store: Store, record: Revision<OmModelCall>, incident: Ref) {
  return prepareModelFinish(store, { project: record.value.projectId, packet: record.value.om.request.packet,
    call: record.value.om.call, response: null, code: 'process_lost', message: 'The physical executor was lost; answer and usage remain unknown',
    reason: 'interrupted', evidence: [incident] });
}
/** The physical proof and the owning product transition are committed together. No liveness
 * logic belongs here: the engine's shared recovery preparation is the only observer. */
export function recoverOmModelCall(store: Store, project: string, ref: Ref): Revision<ModelCall> {
  try {
    const head = store.get<ModelCall>(ref.id);
    if (head?.value.recovery) {
      const checked = readModelCallRecovery(store, project, reference(head));
      if (!same(ref, reference(head)) && !same(ref, reference(checked.original)))
        fail('model_call_foreign', ref.id, 'recovery', 'Recovery repeat must name the original loss or its exact terminal result');
      const saved = 'om' in head.value ? take(readModelCall(store, { project, record: reference(head) }))
        : take(readModelTransport(store, { project, record: reference(head) }));
      settlePhysicalCall(store, saved.record, saved.call);
      return head;
    }
    const prepared = prepareModelCallRecovery(store, project, ref);
    const original = prepared.call, incident = reference(prepared.incident);
    let finished = prepared.writes[0]!.value as ModelCall;
    const writes = [...prepared.writes.slice(1)], guards = [...prepared.guards];
    if ('om' in original.value) {
      const state = take(readModelCallState(store, { project, record: ref }));
      if (state.state !== 'running') fail('model_call_not_running', ref.id, 'application', 'Only an unreceived physical call needs loss recovery');
      const record = original as Revision<OmModelCall>, admitted = take(readCall(store, project, record.value.om.call));
      const seriesHead = store.get(admitted.value.series.id);
      if (!seriesHead) fail('model_call_record_invalid', ref.id, 'series', 'The admitted attempt must retain its series');
      const series = take(readAnySeriesAt(store, project, reference(seriesHead)));
      const attempt = series.value.attempts.find(item => item.ordinal === admitted.value.attempt);
      if (!attempt || !same(attempt.goal, admitted.value.goal))
        fail('model_call_record_invalid', ref.id, 'attempt', 'Recovery belongs to the original admitted attempt');
      const completion = attempt.outcome ? reference(series) : null;
      const terminal = completion ? null : prepareModelTerminalWitness(store, record);
      const finish = completion || terminal ? { writes: [], guards: terminal?.guards ?? [], diagnostic: null }
        : recoveryFinish(pendingCallStore(store, [...writes, prepared.writes[0]!]), record, incident);
      writes.push(...finish.writes); guards.push(reference(seriesHead), ...finish.guards);
      finished = { ...finished, om: { ...record.value.om, application: 'recovered', diagnostic: finish.diagnostic, completion,
        ...(terminal ? { terminal: terminal.witness } : {}) } } as OmModelCall;
    } else if ('transport' in original.value) {
      const record = original as Revision<TransportModelCall>;
      const assignment = transportAssignment(store, record.value.transport.request);
      if (!directTransportPurpose(assignment.call.value.purpose)
        || !same(record.value.transport.exchange, null))
        fail('model_call_record_invalid', ref.id, 'transport', 'Only an unreceived direct transport can be interrupted without a result');
    } else fail('model_call_foreign', ref.id, 'producer', 'The runtime has no E4 producer');
    writes.push({ id: original.id, kind: original.kind, expected: original.revision, value: finished });
    const view = pendingCallStore(store, writes), terminal = writeRef(writes[writes.length - 1]!);
    if ('om' in original.value) take(readModelCall(view, { project, record: terminal }));
    else take(readModelTransport(view, { project, record: terminal }));
    const managed = (finished as OmModelCall).om?.completionOwner;
    if (managed) {
      const update = take(prepareCompletionProducts(view, managed.binding, [terminal, ...((finished as OmModelCall).om.diagnostic ? [(finished as OmModelCall).om.diagnostic!] : [])]));
      writes.push(...update.writes as Write[]); guards.push(...update.guards.filter(isRef));
    }
    const committed = take(writeGuarded<ModelCall>(store, { unit: 'E4', target: ref.id, writes,
      guards: externalGuards(guards, writes) }));
    return committed.find(row => row.id === original.id)! as Revision<ModelCall>;
  } catch (error) {
    if (error instanceof CallFailure) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
    throw error;
  }
}
function settleRecoveredCall(store: Store, record: Revision<ModelCall> | Sealed<Revision<ModelCall>>, call: Ref): void {
  const late = readLateModelReceipt(store, record.value.projectId, reference(record));
  if (!late) return; // Unknown expenditure keeps the original E1 reservation open.
  const evidence = late.value.evidence;
  const decoded = transportOf({ ...evidence, call, wire: { requestId: record.value.requestId } as AdapterRequest });
  take(settleCall(store, call, decoded.usage, 'failed'));
}
function preserveLateTransport(store: Store, project: string, dispatch: Revision<ModelCall>, call: Ref,
  evidence: { process: ProcessResult | null; launchError: ModelExchange['launchError'] }): Revision<ModelCall> {
  const prepared = prepareLateModelReceipt(store, project, reference(dispatch), { process: evidence.process, launchError: evidence.launchError });
  if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: dispatch.id,
    writes: prepared.writes, guards: prepared.guards }));
  const recovered = prepared.recovered.record;
  settlePhysicalCall(store, recovered, call);
  return recovered;
}

// G7 completion graph: immutable logical assignments, exact producer products and a CAS registry.
// Readers of local products use only their immutable assignment, never this registry or its close proof.
import { completionAssignmentId, completionRootAssignments, completionWorkId, COMPLETION_ASSIGNMENT_KIND,
  COMPLETION_WORK_KIND, readCompletionBinding, readCompletionOwnerAt,
  type CompletionAssignment, type CompletionOwner, type CompletionWork } from './series.js';
import { readAssessmentTerminalAt,
  readAssessmentRefusalAt, assessmentRefusalId } from './assessment.js';
import { readJournal, readJournalAt } from './refusal-journal.js';
export interface CompletionCallOwner {
  contract: 'om-completion-call/v1'; binding: Ref; assignment: Ref; call: Ref; packetBasis: Ref;
}
export interface CompletionSnapshot {
  binding: Revision<CompletionOwner>; work: Revision<CompletionWork>; assignments: Revision<CompletionAssignment>[];
  products: Ref[]; complete: boolean; accepting: Ref[]; negative: Ref[]; refusals: { row: string; name: string; goal: string }[];
  technical: { source: Ref; reason: 'off-form' | 'interrupted' }[]; waiting: Ref[]; guards: TransactionGuard[];
}
function completionRecord(value: CompletionAssignment): Revision<CompletionAssignment> {
  return { id: completionAssignmentId(value.project, value.binding.id, value.key), kind: COMPLETION_ASSIGNMENT_KIND,
    revision: 1, hash: hashJson(value), value };
}
function completionRoot(binding: Revision<CompletionOwner>, batch: string): Revision<CompletionAssignment> {
  const root = completionRootAssignments(binding).find(item => item.value.batch === batch);
  if (!root) fail('completion_foreign', binding.id, 'batch', 'This packet is outside the original whole assignment');
  return root;
}
function packetCompletionAssignments(store: Store, binding: Revision<CompletionOwner>, packetRef: Ref): {
  records: Revision<CompletionAssignment>[]; selected: Revision<CompletionAssignment>; packet: Revision<QuestionPacketRecord>;
} {
  const project = binding.value.project;
  const packet = take(readQuestionPacket(store, { project, record: packetRef })) as Revision<QuestionPacketRecord>;
  const request = packet.value.request, attempt = request.attempt;
  if (!attempt || attempt.series.id !== binding.value.series.id || attempt.ordinal !== binding.value.attempt
    || !same(request.routes, binding.value.plan.routes) || !request.batch || packet.value.state !== 'ready')
    fail('completion_foreign', packet.id, 'packet', 'The exact E2 must belong to this original managed root and attempt');
  const line = take(readAnySeriesAt(store, project, attempt.series));
  const cycle = line.value.attempts.find(item => item.ordinal === attempt.ordinal);
  if (!cycle || !same(cycle.goal, binding.value.goal)) fail('completion_foreign', packet.id, 'goal', 'The packet must retain the full original goal');
  const root = completionRoot(binding, request.batch);
  let first = packet;
  if (request.previous.length) first = take(readQuestionPacket(store, { project, record: request.previous[0]!.packet })) as Revision<QuestionPacketRecord>;
  while (first.value.request.continuation)
    first = take(readQuestionPacket(store, { project, record: first.value.request.continuation.packet })) as Revision<QuestionPacketRecord>;
  if (!same(first.value.request.routes, request.routes) || first.value.request.batch !== request.batch
    || !same(first.value.plan?.assignments ?? null, packet.value.plan?.assignments ?? null))
    fail('completion_foreign', packet.id, 'plan', 'Parts and continuations preserve the first proved complete E2 plan');
  const count = first.value.plan?.assignments.length ?? 1, position = packet.value.plan?.position ?? 0;
  const records = Array.from({ length: count }, (_, index) => completionRecord({
    contract: 'om-completion-assignment/v1', project, binding: reference(binding), key: `${root.value.key}:part:${index}`,
    kind: 'part', parent: reference(root), source: reference(first), batch: request.batch!, position: index, question: null,
  }));
  let selected = records[position];
  if (!selected) fail('completion_foreign', packet.id, 'position', 'The step must belong to the exact complete part plan');
  if (request.continuation) {
    const parent = packetCompletionAssignments(store, binding, request.continuation.packet);
    const continuation = completionRecord({ contract: 'om-completion-assignment/v1', project, binding: reference(binding),
      key: `${root.value.key}:continue:${hashJson(request.continuation)}`, kind: 'continuation', parent: reference(parent.selected),
      source: packetRef, batch: request.batch, position, question: null });
    records.push(...parent.records.filter(row => !records.some(own => own.id === row.id)), continuation);
    selected = continuation;
  }
  return { records, selected, packet };
}
function factCompletionAssignments(store: Store, binding: Revision<CompletionOwner>, modelRef: Ref): Revision<CompletionAssignment>[] {
  const state = take(readModelCallState(store, { project: binding.value.project, record: modelRef }));
  if (state.state !== 'applied' || state.outcome.outcome?.kind !== 'fact-candidates')
    fail('completion_foreign', modelRef.id, 'facts', 'Fact children derive only from the entire checked MC1 response');
  const parent = packetCompletionAssignments(store, binding, state.outcome.packet).selected;
  return state.outcome.outcome.facts.map(fact => completionRecord({ contract: 'om-completion-assignment/v1',
    project: binding.value.project, binding: reference(binding), key: `${parent.value.key}:fact:${fact.questionId}`,
    kind: 'fact', parent: reference(parent), source: modelRef, batch: parent.value.batch,
    position: null, question: fact.questionId }));
}
export function readCompletionAssignmentAt(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<CompletionAssignment>>> {
  return result(() => historicalRead(store, { reader: 'G7.completion-assignment', project, ref }, () => {
    const record = take(readRecord<CompletionAssignment>(store, ref,
      { unit: 'G7', target: ref.id, kind: COMPLETION_ASSIGNMENT_KIND, idPrefix: `${COMPLETION_ASSIGNMENT_KIND}:${project}:` }));
    const value = record.value;
    if (!object(value) || value.contract !== 'om-completion-assignment/v1' || value.project !== project
      || !isRef(value.binding) || !isRef(value.source) || !text(value.key) || !text(value.batch)
      || !['root', 'part', 'continuation', 'fact'].includes(value.kind)
      || !(value.parent === null || isRef(value.parent)) || !(value.question === null || text(value.question))
      || !(value.position === null || Number.isSafeInteger(value.position) && value.position >= 0)
      || !exactKeys(value, ['contract', 'project', 'binding', 'key', 'kind', 'parent', 'source', 'batch', 'position', 'question']))
      fail('completion_invalid', ref.id, 'assignment', 'The assignment retains the full exact producer request');
    const binding = take(readCompletionOwnerAt(store, project, record.value.binding)) as Revision<CompletionOwner>;
    const produced = record.value.kind === 'root' ? completionRootAssignments(binding)
      : record.value.kind === 'fact' ? factCompletionAssignments(store, binding, record.value.source)
      : packetCompletionAssignments(store, binding, record.value.source).records;
    if (!produced.some(candidate => same(candidate, record)))
      fail('completion_invalid', ref.id, 'assignment', 'The immutable assignment must equal its full producer derivation');
    if (record.value.parent) take(readCompletionAssignmentAt(store, project, record.value.parent));
    return record as Revision<CompletionAssignment>;
  }, () => fail('completion_invalid', ref.id, 'parent', 'An assignment cannot descend from itself')));
}
function completionGraph(store: Store, binding: Revision<CompletionOwner>, products: readonly Ref[]) {
  const assignments = new Map(completionRootAssignments(binding).map(item => [item.id, item]));
  const packets = new Map<string, Revision<QuestionPacketRecord>>(), calls = new Map<string, ModelCallOutcome>();
  const terminals: ReturnType<typeof readAssessmentTerminalAt>[] = [];
  const add = (rows: Revision<CompletionAssignment>[]) => {
    for (const row of rows) {
      const old = assignments.get(row.id);
      if (old && !same(old, row)) fail('completion_conflict', row.id, 'assignment', 'A logical step cannot change its original packet or parent');
      assignments.set(row.id, row);
    }
  };
  for (const ref of products) {
    const record = store.get(ref.id, ref.revision);
    if (!record || !same(reference(record), ref)) fail('completion_invalid', ref.id, 'product', 'Every product is exact immutable evidence');
    if (record.kind === 'question-packet') {
      const source = packetCompletionAssignments(store, binding, ref); add(source.records); packets.set(ref.id, source.packet);
    } else if (record.kind === 'model-call') {
      const state = take(readModelCallState(store, { project: binding.value.project, record: ref }));
      const value = state.state === 'running' || state.state === 'received' ? state.record : state.outcome.record;
      const source = packetCompletionAssignments(store, binding, value.value.om.request.packet); add(source.records);
      packets.set(source.packet.id, source.packet);
      if (state.state !== 'running' && state.state !== 'received') {
        const old = calls.get(ref.id);
        if (old && old.record.revision > ref.revision) continue;
        calls.set(ref.id, state.outcome as ModelCallOutcome);
        if (state.state === 'applied' && state.outcome.outcome?.kind === 'fact-candidates') add(factCompletionAssignments(store, binding, ref));
      }
    } else if (record.kind === 'om-assessment-result') {
      const terminal = readAssessmentTerminalAt(store, binding.value.project, ref); const checked = take(terminal);
      const intent = take(readAssessmentIntentAt(store, binding.value.project, checked.value.intent));
      if (intent.originalSeries.id !== binding.value.series.id || intent.attempt !== binding.value.attempt
        || !same(intent.goal, binding.value.goal)) fail('completion_foreign', ref.id, 'assessment', 'The assessed fact belongs to this exact managed attempt');
      const facts = factCompletionAssignments(store, binding, intent.record.value.source.modelCall);
      add(facts); terminals.push(terminal);
    } else if (record.kind === MODEL_CYCLE_KIND) {
      const cycle = take(readModelCycle(store, { project: binding.value.project, record: ref }));
      packetCompletionAssignments(store, binding, cycle.record.value.request.packet);
    } else if (record.kind === PART_ASSEMBLY_KIND) {
      const assembly = take(readPartAssembly(store, { project: binding.value.project, record: ref }));
      for (const partRef of assembly.record.value.results) {
        const part = take(readPartResult(store, { project: binding.value.project, record: partRef }));
        packetCompletionAssignments(store, binding, part.record.value.request.packet);
      }
    } else if (record.kind === UNIT_REFUSAL_KIND) {
      if ((record.value as unknown as UnitRefusalRecord).gate === 'E5') {
        const row = take(readAssessmentRefusalAt(store, binding.value.project, ref));
        if (row.intent.originalSeries.id !== binding.value.series.id || row.intent.attempt !== binding.value.attempt
          || !same(row.intent.goal, binding.value.goal)) fail('completion_foreign', ref.id, 'refusal', 'Every semantic diagnostic belongs to this exact managed attempt');
      }
      else take(readManagedModelDiagnostic(store, binding, ref));
    } else fail('completion_invalid', ref.id, 'product', 'This record has no registered completion producer');
  }
  return { assignments: [...assignments.values()].sort((a, b) => a.id.localeCompare(b.id)), packets, calls,
    terminals: terminals.map(item => take(item)) };
}
export function readCompletionWorkAt(store: Store, project: string, ref: Ref): OmResult<Sealed<CompletionSnapshot>> {
  return result(() => historicalRead(store, { reader: 'G7.completion-work', project, ref }, () => {
    const work = take(readRecord<CompletionWork>(store, ref, { unit: 'G7', target: ref.id,
      kind: COMPLETION_WORK_KIND, idPrefix: `${COMPLETION_WORK_KIND}:${project}:` })) as Revision<CompletionWork>;
    const value = work.value;
    if (!object(value) || value.contract !== 'om-completion-work/v1' || value.project !== project
      || !isRef(value.binding) || !Array.isArray(value.assignments) || !value.assignments.every(isRef)
      || !Array.isArray(value.products) || !value.products.every(isRef)
      || !(value.previous === null || isRef(value.previous)) || !(value.closed === null || isRef(value.closed))
      || !(value.journal === null || isRef(value.journal))
      || !exactKeys(value, ['contract', 'project', 'binding', 'previous', 'assignments', 'products', 'journal', 'closed']))
      fail('completion_invalid', ref.id, 'work', 'The registry needs explicit exact assignments and products');
    const binding = take(readCompletionOwnerAt(store, project, value.binding)) as Revision<CompletionOwner>;
    if (work.id !== completionWorkId(project, binding.id) || !same(value.products, refs(value.products)))
      fail('completion_invalid', ref.id, 'work', 'The registry is canonical and owned by one original attempt');
    if (work.revision === 1) {
      if (value.previous !== null || value.products.length || value.closed !== null || value.journal !== null)
        fail('completion_invalid', ref.id, 'previous', 'The initial registry contains only the fixed root assignments');
    } else {
      if (!value.previous || value.previous.id !== work.id || value.previous.revision !== work.revision - 1)
        fail('completion_invalid', ref.id, 'previous', 'Every registry revision retains its immediate exact predecessor');
      const before = take(readCompletionWorkAt(store, project, value.previous));
      if (before.work.value.closed || !same(before.work.value.binding, value.binding)
        || before.products.some(product => !value.products.some(next => same(product, next))))
        fail('completion_invalid', ref.id, 'previous', 'Work cannot erase products or mutate after closing');
      if (value.closed) {
        const close = take(readCompletionCloseAt(store, project, value.closed));
        if (!same(close.binding, value.binding) || !same(close.work, value.previous)
          || !same(value, { ...before.work.value, previous: value.previous, closed: value.closed }))
          fail('completion_invalid', ref.id, 'closed', 'The closed registry must equal the exact G7 transition over its predecessor');
      }
    }
    const graph = completionGraph(store, binding, value.products);
    if (!same(refs(graph.assignments.map(reference)), value.assignments))
      fail('completion_invalid', ref.id, 'assignments', 'All mandatory children follow from the exact full producer products');
    for (const assignment of graph.assignments) take(readCompletionAssignmentAt(store, project, reference(assignment)));
    return deriveCompletionSnapshot(store, binding, work, graph);
  }, () => fail('completion_invalid', ref.id, 'history', 'A completion registry cannot derive through its own closure')));
}
export function prepareCompletionProducts(store: Store, bindingRef: Ref, products: readonly Ref[]): OmResult<Sealed<{ writes: Write[]; guards: TransactionGuard[]; work: Ref }>> {
  return result(() => {
    const project = bindingRef.id.split(':')[1]!;
    const id = completionWorkId(project, bindingRef.id), head = store.get<CompletionWork>(id);
    if (!head) fail('completion_invalid', id, 'work', 'Managed work cannot lose its registry');
    const prior = take(readCompletionWorkAt(store, project, reference(head)));
    const combined = refs([...prior.products, ...products]);
    if (same(combined, prior.products)) return { writes: [], guards: [reference(head)], work: reference(head) };
    if (head.value.closed) fail('completion_closed', id, 'work', 'Closed work accepts only exact historical repeats');
    const graph = completionGraph(store, prior.binding as Revision<CompletionOwner>, combined);
    const writes: Write[] = [];
    for (const assignment of graph.assignments) {
      const old = store.get(assignment.id);
      if (old && !same(old, assignment)) fail('completion_conflict', assignment.id, 'assignment', 'The logical assignment cannot be rebound');
      if (!old) writes.push({ id: assignment.id, kind: assignment.kind, expected: 0, value: assignment.value });
    }
    const journal = combined.some(ref => store.get(ref.id, ref.revision)?.kind === UNIT_REFUSAL_KIND)
      ? reference(take(readJournal(store, { project }))) : null;
    const value: CompletionWork = { ...head.value, previous: reference(head), products: combined, journal,
      assignments: refs(graph.assignments.map(reference)) };
    const write: Write = { id, kind: COMPLETION_WORK_KIND, expected: head.revision, value }; writes.push(write);
    // The initial assignment/opening guards and current work close the registration-vs-G7 window.
    const line = store.get(prior.binding.value.series.id);
    if (!line) fail('completion_invalid', id, 'series', 'The current original line must exist');
    const admitted = take(prepareSeriesLineAdmission(store, project, reference(line)));
    return { writes, guards: [reference(head), bindingRef, ...admitted.guards], work: writeRef(write) };
  });
}
function deriveCompletionSnapshot(store: Store, binding: Revision<CompletionOwner>, work: Revision<CompletionWork>, graph: ReturnType<typeof completionGraph>): CompletionSnapshot {
  const project = binding.value.project, completed = new Set<string>();
  const accepting: Ref[] = [], negative: Ref[] = [], technical: CompletionSnapshot['technical'] = [], waiting: Ref[] = [];
  const diagnostics: Ref[] = [], products = work.value.products;
  for (const call of graph.calls.values()) {
    const step = packetCompletionAssignments(store, binding, call.packet).selected;
    if (call.record.value.om.application === 'application-refused') continue;
    if (call.outcome?.kind === 'need-source') continue;
    completed.add(step.id);
    if (call.diagnostic) {
      diagnostics.push(call.diagnostic);
      const checked = take(readManagedModelDiagnostic(store, binding, call.diagnostic));
      if (checked.reason === 'off-form' || checked.reason === 'interrupted') technical.push({ source: reference(call.record), reason: checked.reason });
      if (checked.reason === 'awaiting-owner') waiting.push(call.diagnostic);
    }
  }
  for (const terminal of graph.terminals) {
    const intent = take(readAssessmentIntentAt(store, project, terminal.value.intent));
    const fact = factCompletionAssignments(store, binding, intent.record.value.source.modelCall).find(row => row.value.question === intent.fact.questionId);
    if (!fact) fail('completion_foreign', terminal.id, 'fact', 'A terminal must belong to an enumerated original fact');
    const value = terminal.value;
    if (value.verdict === 'supported') { accepting.push(value.accepted!); completed.add(fact.id); }
    else if (value.verdict === 'off-form' || value.verdict === 'interrupted') {
      technical.push({ source: reference(terminal), reason: value.verdict }); completed.add(fact.id);
    } else {
      negative.push(reference(terminal));
      const row = products.find(ref => ref.id === assessmentRefusalId(project, reference(terminal)));
      if (row) { take(readAssessmentRefusalAt(store, project, row)); diagnostics.push(row); completed.add(fact.id); }
    }
  }
  const parentOf = new Map(graph.assignments.map(row => [row.id, row.value.parent?.id ?? null]));
  const below = (child: string, parent: string): boolean => {
    let id: string | null | undefined = child;
    while (id) { if (id === parent) return true; id = parentOf.get(id); }
    return false;
  };
  // Continuations discharge their exact parent's source request; they never skip sibling parts or facts.
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const row of graph.assignments) if (row.value.kind === 'continuation' && completed.has(row.id)
      && !completed.has(row.value.parent!.id)) { completed.add(row.value.parent!.id); advanced = true; }
  }
  for (const root of completionRootAssignments(binding)) {
    const parts = graph.assignments.filter(row => row.value.kind === 'part' && row.value.parent?.id === root.id);
    if (!parts.length) continue;
    let complete = parts.every(row => completed.has(row.id))
      && graph.assignments.filter(row => row.value.kind === 'fact' && below(row.id, root.id)).every(row => completed.has(row.id));
    const node = [...graph.packets.values()].some(packet => packet.value.plan && packet.value.request.batch === root.value.batch);
    if (node) {
      const assemblies = products.filter(ref => store.get(ref.id, ref.revision)?.kind === PART_ASSEMBLY_KIND);
      const assembled = assemblies.some(ref => {
        const assembly = take(readPartAssembly(store, { project, record: ref }));
        const actual = [...graph.calls.values()].filter(call => call.part && below(packetCompletionAssignments(store, binding, call.packet).selected.id, root.id));
        return same(refs(actual.map(call => call.part!.result)), refs(assembly.record.value.results));
      });
      complete &&= assembled;
    }
    for (const ref of products.filter(ref => store.get(ref.id, ref.revision)?.kind === MODEL_CYCLE_KIND)) {
      const cycle = take(readModelCycle(store, { project, record: ref }));
      if (packetCompletionAssignments(store, binding, cycle.record.value.request.packet).selected.value.batch !== root.value.batch) continue;
      if (['blocked', 'research-no-progress', 'parts-invalid'].includes(cycle.record.value.terminal)
        || cycle.record.value.terminal === 'outcome' && cycle.last.diagnostic !== null
          && cycle.last.record.value.om.application !== 'application-refused') {
        complete = true; if (cycle.record.value.diagnostic) diagnostics.push(cycle.record.value.diagnostic);
      }
    }
    if (complete) completed.add(root.id);
  }
  const refusals: CompletionSnapshot['refusals'] = [];
  if (diagnostics.length) {
    if (!work.value.journal) fail('completion_invalid', work.id, 'journal', 'Work retains the exact journal cut for its diagnostics');
    const journal = take(readJournalAt(store, project, work.value.journal));
    for (const diagnostic of refs(diagnostics)) {
      const matching = journal.value.rows.filter(row => same(row.source, diagnostic));
      if (!matching.length) fail('completion_invalid', diagnostic.id, 'journal', 'A terminal diagnostic must retain its exact journal rows');
      refusals.push(...matching.map(row => ({ row: row.id, name: row.code, goal: row.goal })));
    }
  }
  return { binding, work, assignments: graph.assignments, products: [...products],
    complete: completionRootAssignments(binding).every(root => completed.has(root.id)),
    accepting: refs(accepting), negative: refs(negative), refusals: [...new Map(refusals.map(row => [row.row, row])).values()].sort((a,b) => a.row.localeCompare(b.row)),
    technical, waiting: refs(waiting), guards: [reference(work), reference(binding)] };
}
/** E1 is a cross-check of the registered plan, never the plan itself. */
export function checkCompletionLedger(store: Store, snapshot: Sealed<CompletionSnapshot>, ledger: Ref, journal: Ref | null = null): OmResult<Sealed<true>> {
  return result(() => {
    const owner = snapshot.binding.value, project = owner.project;
    // Context selection is not proof: readCallLedgerAt still rederives every row and
    // preceding revision. Mechanism analyses retain the close's exact journal cut.
    const saved = take(readRecord<CallLedger>(store, ledger, { unit: 'G7', target: ledger.id,
      kind: 'om-call-ledger', id: `om-call-ledger:${project}` }));
    if (!object(saved.value) || !Array.isArray(saved.value.calls))
      fail('ledger_invalid', ledger.id, 'calls', 'A saved ledger needs its complete call list');
    const histories = journal ? saved.value.calls.filter(row => object(row) && Object.hasOwn(row, 'owner')
      && row.purpose === 'origin-analysis' && isRef(row.call)).map(row => ({ call: row.call, journal })) : [];
    const exact = take(readCallLedgerAt(store, project, ledger, histories));
    for (const row of exact.value.calls) {
      if (row.series.id !== owner.series.id || row.attempt !== owner.attempt) continue;
      if (row.purpose === 'stop-analysis' || row.purpose === 'origin-analysis') continue;
      const admitted = take(readCall(store, project, row.call));
      if (!same(admitted.value.goal, owner.goal)) fail('completion_foreign', row.call.id, 'goal', 'E1 cannot change the whole managed goal');
      if (row.purpose === 'fact-assessment') {
        if (row.basis?.kind !== 'fact-assessment' || !row.basis.assessment)
          fail('completion_foreign', row.call.id, 'assessment', 'Managed E1 must retain its original fact intent');
        const intent = take(readAssessmentIntentAt(store, project, row.basis.assessment));
        if (intent.call !== row.name || !snapshot.assignments.some(item => item.value.kind === 'fact'
          && same(item.value.source, intent.record.value.source.modelCall) && item.value.question === intent.fact.questionId))
          fail('completion_foreign', row.call.id, 'assignment', 'Every assessor E1 belongs to an original mandatory fact');
      } else {
        const packets = snapshot.products.filter(ref => store.get(ref.id, ref.revision)?.kind === 'question-packet')
          .map(ref => packetCompletionAssignments(store, snapshot.binding, ref));
        const matched = packets.filter(({packet}) => object(packet.value.packet)
          && packet.value.packet.requestId === row.name && packet.value.fingerprint !== null
          && same({ hash: packet.value.fingerprint.hash, chars: packet.value.fingerprint.chars,
            bytes: packet.value.fingerprint.utf8Bytes }, admitted.value.packet));
        if (matched.length !== 1 || !snapshot.assignments.some(item => same(reference(item), reference(matched[0]!.selected))))
          fail('completion_foreign', row.call.id, 'assignment', 'Every working E1 belongs to one exactly registered physical step');
      }
    }
    return true as const;
  });
}
/** Proves an E4 diagnostic by the same exact physical/continuation derivation used to produce it. */
function deriveManagedModelDiagnostic(store: Store, binding: Revision<CompletionOwner>, ref: Ref): { reason: FinishModelAttemptRequest['reason']; request: FinishModelAttemptRequest } {
  const project = binding.value.project;
  const record = take(readRecord<UnitRefusalRecord>(store, ref, { unit: 'E4', target: ref.id,
    kind: UNIT_REFUSAL_KIND, idPrefix: `${unitRefusalNamespace(project)}e4:` }));
  if (!object(record.value) || !Array.isArray(record.value.refusals))
    fail('completion_invalid', ref.id, 'diagnostic', 'A diagnostic retains its full refusal rows');
  const first = record.value.refusals[0], origin = first?.origin;
  if (record.value.gate !== 'E4' || !object(origin) || typeof origin.stage !== 'string' || !origin.stage.startsWith('model-call:')
    || !Array.isArray(origin.sources) || !origin.sources.every(row => object(row) && text(row.role) && isRef(row.ref)))
    fail('completion_invalid', ref.id, 'diagnostic', 'An E4 diagnostic retains its full source roles');
  const sources = origin.sources as {role:string;ref:Ref}[];
  const named = (role: string) => sources.filter(source => source.role === role).map(source => source.ref);
  const packets = named('packet'), calls = named('call'), responses = named('response');
  if (packets.length !== 1 || calls.length !== 1 || responses.length > 1) fail('completion_invalid', ref.id, 'sources', 'One diagnostic belongs to one exact E1 and E2');
  const request: FinishModelAttemptRequest = { project, packet: packets[0]!, call: calls[0]!, response: responses[0] ?? null,
    code: first.code, message: first.remedy, reason: origin.stage.slice('model-call:'.length) as FinishModelAttemptRequest['reason'], evidence: named('evidence') };
  const expected = modelFinishDiagnostic(store, request, binding);
  if (record.revision !== 1 || ref.id !== expected.id || !same(record.value, expected.value))
    fail('completion_invalid', ref.id, 'diagnostic', 'The complete diagnostic must reproduce its producer');
  return { reason: request.reason, request };
}
export function readManagedModelDiagnostic(store: Store, binding: Revision<CompletionOwner>, ref: Ref):
  OmResult<Sealed<{ reason: FinishModelAttemptRequest['reason']; request: FinishModelAttemptRequest }>> {
  return result(() => deriveManagedModelDiagnostic(store, binding, ref));
}
/** E1 producer and physical claim share this assignment resolver; the caller cannot select an era. */
export function prepareCompletionCall(store: Store, project: string, request: AnyRecordCallRequest): OmResult<Sealed<{
  owner: Omit<CompletionCallOwner, 'call'> | null; writes: Write[]; guards: TransactionGuard[];
}>> {
  return result(() => {
    if (request.purpose === 'stop-analysis' || request.purpose === 'origin-analysis') return { owner: null, writes: [], guards: [] };
    const binding = take(readCompletionBinding(store, project, request.series, request.attempt)) as Revision<CompletionOwner> | null;
    if (!binding) return { owner: null, writes: [], guards: [] };
    if (!same(request.goal, binding.value.goal)) fail('completion_foreign', binding.id, 'goal', 'The call retains the original whole goal');
    let assignment: Revision<CompletionAssignment>, packetBasis: Ref, products: Ref[];
    const sourceWrites: Write[] = [], sourceGuards: Ref[] = [];
    if (request.purpose === 'fact-assessment') {
      if (request.basis?.kind !== 'fact-assessment' || !request.basis.assessment)
        fail('completion_foreign', binding.id, 'assessment', 'An assessor inherits ownership through its exact E5 intent');
      const intent = take(readAssessmentIntentAt(store, project, request.basis.assessment));
      if (request.call !== intent.call || !same(request.packet, intent.packet) || !same(request.basis, intent.basis))
        fail('completion_foreign', binding.id, 'assessment', 'Assessor identity is derived from its original fact intent');
      const children = factCompletionAssignments(store, binding, intent.record.value.source.modelCall);
      const found = children.filter(row => row.value.question === intent.fact.questionId);
      if (found.length !== 1) fail('completion_foreign', binding.id, 'assessment', 'The original response must contain this one fact');
      assignment = found[0]!; packetBasis = intent.intent; products = [intent.record.value.source.modelCall];
    } else {
      const candidates = store.list<QuestionPacketRecord>('question-packet').filter(record => record.value.project === project
        && record.value.packet !== null && same(record.value.packet, request.packet));
      if (candidates.length !== 1) fail('completion_foreign', binding.id, 'packet', 'A new E1 must name one exact proved E2 packet, not just an ordinal');
      const source = packetCompletionAssignments(store, binding, reference(candidates[0]!));
      if (!object(source.packet.value.packet) || source.packet.value.packet.requestId !== request.call
        || source.packet.value.packet.purpose !== request.purpose)
        fail('completion_foreign', binding.id, 'call', 'An assignment cannot be renamed to create a second physical call');
      const expected = modelAssignment(store, { project, packet: reference(source.packet), dispatch: request.dispatch, role: 'implementer' }).admission;
      const normalized = (value: AnyRecordCallRequest) => ({ ...value, gaps: [...value.gaps].sort(compareJson),
        goal: { ...value.goal, questions: [...value.goal.questions].sort() } });
      if (!same(normalized(request), normalized(expected)))
        fail('completion_foreign', binding.id, 'call', 'Every E1 field must reproduce this proved E2 assignment');
      const admittedPacket = take(prepareQuestionPacket(store, source.packet.value.request as QuestionPacketRequest));
      if (!same(admittedPacket.record, source.packet)) fail('completion_foreign', binding.id, 'packet', 'Current admission cannot replace the original packet');
      sourceWrites.push(...admittedPacket.writes); sourceGuards.push(...admittedPacket.guards);
      assignment = source.selected; packetBasis = reference(source.packet); products = [packetBasis];
    }
    const prepared = take(prepareCompletionProducts(store, reference(binding), products));
    const view = pendingCallStore(store, prepared.writes as Write[]);
    const work = take(readCompletionWorkAt(view, project, prepared.work));
    if (work.work.value.closed || !work.assignments.some(row => same(reference(row), reference(assignment))))
      fail('completion_closed', binding.id, 'assignment', 'A physical claim belongs to one registered open assignment');
    return { owner: { contract: 'om-completion-call/v1', binding: reference(binding), assignment: reference(assignment), packetBasis },
      writes: [...sourceWrites, ...prepared.writes as Write[]],
      guards: uniqueTransactionGuards([...sourceGuards, ...prepared.guards].filter(guard => !isRef(guard)
        || !sourceWrites.some(write => same(writeRef(write), guard)))) };
  });
}
function checkedCompletionOwner(store: Store, project: string, call: Ref, packetBasis: Ref, marker: unknown, history?: CallHistory): CompletionCallOwner | null {
  const admitted = take(readCall(store, project, call, history));
  const purpose = admitted.value.purpose;
  const binding = purpose === 'stop-analysis' || purpose === 'origin-analysis' ? null
    : take(readCompletionBinding(store, project, admitted.value.series, admitted.value.attempt));
  if (!binding) {
    if (marker !== undefined) fail('completion_invalid', call.id, 'completionOwner', 'Standalone history cannot acquire managed provenance');
    return null;
  }
  if (!object(marker) || marker.contract !== 'om-completion-call/v1' || !isRef(marker.assignment)
    || !same(marker.binding, reference(binding)) || !same(marker.call, call) || !same(marker.packetBasis, packetBasis)
    || !exactKeys(marker, ['contract', 'binding', 'assignment', 'call', 'packetBasis']))
    fail('completion_invalid', call.id, 'completionOwner', 'Every managed physical step retains its exact proved ownership');
  const assignment = take(readCompletionAssignmentAt(store, project, marker.assignment));
  if (!same(assignment.value.binding, reference(binding))) fail('completion_foreign', call.id, 'binding', 'The assignment belongs to its own original owner');
  if (purpose === 'fact-assessment') {
    if (admitted.value.basis?.kind !== 'fact-assessment' || !same(admitted.value.basis.assessment, packetBasis))
      fail('completion_foreign', call.id, 'intent', 'The assessor retains its exact originating intent');
    const intent = take(readAssessmentIntentAt(store, project, packetBasis));
    const children = factCompletionAssignments(store, binding as Revision<CompletionOwner>, intent.record.value.source.modelCall);
    if (!children.some(row => same(reference(row), marker.assignment) && row.value.question === intent.fact.questionId))
      fail('completion_foreign', call.id, 'fact', 'The assessor must be this original response child');
  } else {
    const source = packetCompletionAssignments(store, binding as Revision<CompletionOwner>, packetBasis);
    if (!same(reference(source.selected), marker.assignment)) fail('completion_foreign', call.id, 'packet', 'The physical step must be exactly the selected E2 assignment');
  }
  return marker as unknown as CompletionCallOwner;
}

function modelFinishDiagnostic(store: Store, request: FinishModelAttemptRequest, binding: Revision<CompletionOwner> | null): Write {
  const call = take(readCall(store, request.project, request.call));
  if (binding) validateManagedFinish(store, request, binding);
  const sources = refs([request.packet, request.call, ...(request.response ? [request.response] : []), ...(request.evidence ?? [])]);
  for (const ref of sources) {
    const record = store.get(ref.id, ref.revision);
    if (!record || !same(reference(record), ref)) fail('model_call_request_invalid', ref.id, 'evidence', 'Completion evidence must exist at the exact reference');
  }
  const diagnosticValue: UnitRefusalRecord = { gate: 'E4', refusals: [...new Set(call.value.gaps.map(gap => gap.goal))].sort().map(goal =>
    ({ code: request.code, goal, remedy: request.message, origin: { name: request.code, stage: `model-call:${request.reason}`, subject: call.value.call,
      sources: sources.map(ref => ({ role: ref.id === request.packet.id ? 'packet' : ref.id === request.call.id ? 'call'
        : ref.id === request.response?.id ? 'response' : 'evidence', ref })) } })) };
  const diagnosticWrite: Write = { id: `${unitRefusalNamespace(request.project)}e4:${hashJson(diagnosticValue)}`,
    kind: UNIT_REFUSAL_KIND, expected: 0, value: diagnosticValue };
  return diagnosticWrite;
}
function validateManagedFinish(store: Store, request: FinishModelAttemptRequest, binding: Revision<CompletionOwner>): void {
  packetCompletionAssignments(store, binding, request.packet);
  const project = request.project, evidence = request.evidence ?? [];
  const exchangeRef = evidence.find(ref => store.get(ref.id, ref.revision)?.kind === EXCHANGE_KIND);
  if (exchangeRef) {
    const source = take(readRecord<ModelExchange>(store, exchangeRef, { unit: 'E4', target: request.call.id, kind: EXCHANGE_KIND, id: exchangeRef.id }));
    if (!object(source.value) || !object(source.value.request) || !same(source.value.request.packet, request.packet))
      fail('completion_foreign', request.call.id, 'exchange', 'The terminal evidence must belong to this exact packet');
    requireModelRequest(store, source.value.request);
    const { transport } = checkedModelExchange(store, source.value.request, request.call, exchangeRef);
    const form = transport.kind === 'answered'
      ? checkAnswerForm(store, { project, packet: request.packet, raw: transport.raw }) : null;
    const checked = form?.ok ? form.value as CheckedAnswerForm : null;
    const failure = failureOf(transport, form), reason = finishReason(transport, checked, failure);
    const detail = finishDetail(transport, checked, failure);
    if (!reason || reason !== request.reason || !detail || detail.code !== request.code || detail.message !== request.message)
      fail('completion_invalid', request.call.id, 'reason', 'The local reason and diagnostic must be derived from the physical response');
    return;
  }
  if (request.code === 'process_lost' && request.reason === 'interrupted') {
    const call = take(readCall(store, project, request.call));
    const incidentRef = evidence.find(ref => store.get(ref.id, ref.revision)?.kind === 'model-call-recovery');
    const incident = incidentRef ? store.get<{call:Ref}>(incidentRef.id, incidentRef.revision) : null;
    const id = modelRecordId(project, call.value.call);
    const head = incident && isRef(incident.value.call) && incident.value.call.id === id
      ? store.get<ModelCall>(id, incident.value.call.revision + 1) : null;
    if (!head?.value.recovery) fail('completion_invalid', request.call.id, 'incident', 'Physical loss requires its proved recovery record');
    const recovery = readModelCallRecovery(store, project, reference(head));
    if (!evidence.some(ref => same(ref, reference(recovery.incident)))) fail('completion_invalid', request.call.id, 'incident', 'The incident must belong to the exact original physical claim');
    return;
  }
  if (request.reason === 'refused' && request.response) {
    const source = take(readPacketResponse(store, { project, packet: request.packet, call: request.call, response: request.response }));
    const checked = take(checkAnswerForm(store, { project, packet: request.packet, raw: source.record.value.raw }));
    if (checked.kind === 'need-source') {
      const reads = readContinuationEvidence(store, { project, packet: request.packet, call: request.call, response: request.response, deliveries: evidence });
      if (reads.ok && !reads.value.novel && request.code === 'research_no_progress'
        && request.message === 'The addressed reads add no information to this attempt') return;
    }
    for (const ref of evidence) if (store.get(ref.id, ref.revision)?.kind === 'question-packet') {
      const next = take(readQuestionPacket(store, { project, record: ref }));
      const parent = next.value.request.continuation;
      const last = next.value.request.previous.at(-1);
      if (next.value.state === 'blocked' && next.value.refusal?.code === request.code && next.value.refusal.message === request.message
        && (parent && same(parent.packet, request.packet) && same(parent.call, request.call) && same(parent.response, request.response)
          || last && same(last.packet, request.packet))) return;
    }
    if (evidence.length && evidence.every(ref => store.get(ref.id, ref.revision)?.kind === PART_RESULT_KIND)) {
      // Diagnostic source roles are canonical sets; assembly input is an ordered
      // plan. Recover that order from each proved E2, not from hash/id ordering.
      const parts = evidence.map(ref => {
        const part = take(readPartResult(store, { project, record: ref }));
        const assigned = packetCompletionAssignments(store, binding, part.record.value.request.packet);
        return { ref, part, packet: assigned.packet, position: assigned.packet.value.plan?.position ?? -1 };
      }).sort((a,b) => a.position - b.position);
      const last = parts.at(-1)!;
      if (!last.packet.value.plan || parts.length !== last.packet.value.plan.assignments.length
        || parts.some((part,index) => part.position !== index)
        || !same(reference(last.packet), request.packet)
        || !same(last.part.record.value.request.call, request.call)
        || !same(last.part.record.value.request.response, request.response))
        fail('completion_invalid', request.call.id, 'parts', 'A failed assembly retains the entire ordered plan and its exact final physical step');
      const assembly = result(() => deriveAssembly(store, { project, results: parts.map(row => row.ref) }, false));
      if (!assembly.ok && assembly.refusal.code === request.code && assembly.refusal.message === request.message) return;
    }
  }
  fail('completion_invalid', request.call.id, 'reason', 'A local technical or cycle terminal needs its exact common producer proof');
}

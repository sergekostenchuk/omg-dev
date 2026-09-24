import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EngineError } from '../errors.js';
import { physicalClaim, authorizeModelDispatch, prepareModelCallRecovery, readModelCallRecovery,
  prepareLateModelReceipt, readLateModelReceipt } from '../discovery/model-call-recovery.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { ResearchSources } from '../discovery/research-sources.js';
import { contextValue } from '../discovery/working-context.js';
import { sourceIsCurrent, type Source } from '../evidence/evidence.js';
import { workspacePath, type Environment } from '../runtime/environment.js';
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
    if (old) return take(readPartAssembly(store, { project: request.project, record: reference(old) }));
    const prepared = deriveAssembly(store, request, true);
    take(writeGuarded(store, { unit: 'E4', target: id, guards: prepared.guards, writes: [prepared.proposal, prepared.record]
      .map(record => ({ id: record.id, kind: record.kind, expected: 0, value: record.value })) }));
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
      settlePhysicalCall(store, call.record, call.call);
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
      cycleSources(store, request.project, value);
      const written = take(writeGuarded<ModelCycleRecord>(store, { unit: 'E4', target: id,
        writes: [{ id, kind: MODEL_CYCLE_KIND, expected: 0, value }], guards: refs(value.steps.map(step => step.record)) }));
      const read = take(readModelCycle(store, { project: request.project, record: reference(written[0]!) }));
      return { ...read, repeated: false } as ModelCycleOutcome;
    });
  } catch (error) { if (error instanceof CallFailure) return { ok: false, refusal: error.refusal }; throw error; }
}

// Dispatch lifecycle.
import { readFileSync as readRejectedFile } from 'node:fs';
import { runProcess } from '../runtime/process.js';
import { recordCall, readCall, settleCall, prepareCallDispatch, type AnyRecordCallRequest, type DispatchContract } from './call-record.js';
import { prepareQuestionPacket, preparePartResult, partResponseId,
  PART_RESPONSE_KIND, type QuestionPacketRequest, type PartResponseRecord } from './question-packet.js';
import { readAnySeriesAt, seriesRequestOf, prepareCompleteAttempt, type CompletionReason } from './series.js';
import { prepareRecordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND, type UnitRefusalRecord } from './refusal-journal.js';
import { prepareAddressing, deriveInputDecisions } from './addressing.js';
import { readOmInput, type OmInputRecord } from './input.js';
import type { CheckedAnswerForm } from './answer-form.js';

export interface ModelCallRequest { project: string; packet: Ref; dispatch: DispatchContract; role: 'implementer' | 'reviewer' }
export interface ModelCallOutcome {
  record: Revision<OmModelCall>; packet: Ref; call: Ref; response: Ref | null; outcome: CheckedAnswerForm | null;
  part: { proposal: Ref; result: Ref } | null; diagnostic: Ref | null; repeated: boolean;
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
  om: { version: 'om-model-call/v1'; application: ModelApplicationState; request: ModelCallRequest; call: Ref; exchange: Ref | null;
    part: { proposal: Ref; result: Ref } | null; diagnostic: Ref | null; input: Ref | null; failure: Refusal | null; rejection: Ref | null; completion?: Ref | null };
}
export interface FinishModelAttemptRequest {
  project: string; packet: Ref; call: Ref; response: Ref | null; code: string; message: string;
  reason: Exclude<CompletionReason, 'result'>; evidence?: Ref[];
}
const EXCHANGE_KIND = 'om-model-exchange';
const modelRecordId = (project: string, requestId: string) => `model-call:${project}:om:${hashJson(requestId)}`;
const exchangeId = (request: ModelCallRequest) => `${EXCHANGE_KIND}:${request.project}:${hashJson(request)}`;
const writeRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
function pendingCallStore(store: Store, writes: readonly Write[]): Store {
  const pending = new Map(writes.map(write => [write.id, { ...writeRef(write), kind: write.kind, value: write.value }]));
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => {
      const value = pending.get(id);
      return value && (revision === undefined || revision === value.revision) ? value : target.get(id, revision);
    };
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
  const diagnostic = writeRef(diagnosticWrite), old = store.get(diagnostic.id);
  if (old && (old.kind !== UNIT_REFUSAL_KIND || old.revision !== 1 || !same(old.value, diagnosticValue)))
    fail('model_call_record_invalid', diagnostic.id, 'diagnostic', 'The immutable diagnostic cannot be replaced');
  const writes: Write[] = old ? [] : [diagnosticWrite];
  const journal = take(prepareRecordRefusal(pendingCallStore(store, writes), { project: request.project, source: diagnostic }));
  writes.push(...journal.writes);
  const claims = journal.value.rows.filter(row => same(row.source, diagnostic)).map(row => ({ row: row.id, name: row.code, goal: row.goal }));
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

/** Historical playback rederives the wire and form from saved sources, including the original E1 revision. */
export function readModelCallState(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<ModelCallState>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('record');
  return result<ModelCallState>(() => {
    const record = take(readRecord<OmModelCall>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `model-call:${request.project}:om:`, kind: 'model-call' }));
    const value = record.value;
    if (!object(value) || !object(value.om) || value.om.version !== 'om-model-call/v1' || !isRef(value.om.call))
      fail('model_call_record_invalid', record.id, 'om', 'The runtime record needs explicit E4 provenance');
    requireModelRequest(store, value.om.request);
    if (value.om.request.project !== request.project) fail('model_call_record_invalid', record.id, 'project', 'A call belongs to this project');
    const assignment = modelAssignment(store, value.om.request), { packet, payload, wire, binding } = assignment;
    if (record.id !== modelRecordId(request.project, wire.requestId) || value.projectId !== request.project
      || value.requestId !== wire.requestId || value.purpose !== payload.purpose || !same(value.requested, binding)
      || !same(value.request, { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(payload), record: reference(packet) })
      || !Number.isSafeInteger(value.startedAt)) fail('model_call_record_invalid', record.id, 'request', 'Runtime request must reproduce its exact packet and executor');
    const admitted = take(readCall(store, request.project, value.om.call));
    if (admitted.revision !== 1 || admitted.value.call !== wire.requestId || !same(admitted.value.dispatch, value.om.request.dispatch)
      || !same(admitted.value.packet, { hash: hashJson(payload), chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt) })
      || !same(admitted.value.series, assignment.admission.series) || admitted.value.attempt !== assignment.admission.attempt
      || !same(admitted.value.goal, assignment.admission.goal) || admitted.value.purpose !== assignment.admission.purpose
      || !same(admitted.value.gaps, [...assignment.admission.gaps].sort(compareJson)))
      fail('model_call_record_invalid', record.id, 'call', 'The runtime call must reproduce its E1 admission');
    if (value.om.application === 'running') {
      if (value.status !== 'running' || value.finishedAt !== null || value.om.exchange !== null
        || value.response !== null || value.usage !== null || value.error !== null || value.om.part !== null
        || value.om.input !== null || value.om.diagnostic !== null || value.om.failure !== null || value.om.rejection !== null)
        fail('model_call_record_invalid', record.id, 'application', 'A running dispatch has no received or applied evidence');
      return { state: 'running', record: record as Revision<OmModelCall> };
    }
    if (value.om.application === 'recovered') {
      const recovery = readModelCallRecovery(store, request.project, request.record);
      const original = recovery.original.value as OmModelCall;
      if (original.om?.application !== 'running' || !same(original.om.request, value.om.request)
        || !same(original.om.call, value.om.call) || value.om.exchange !== null || value.om.part !== null
        || value.om.input !== null || value.om.failure !== null || value.om.rejection !== null
        || !(value.om.completion === null || isRef(value.om.completion)))
        fail('model_call_record_invalid', record.id, 'recovery', 'Recovery retains the original unreceived E4 assignment');
      if (value.om.completion) {
        const completed = take(readAnySeriesAt(store, request.project, value.om.completion));
        const attempt = completed.value.attempts.find(item => item.ordinal === admitted.value.attempt);
        if (completed.id !== admitted.value.series.id || !attempt?.outcome || !same(attempt.goal, admitted.value.goal)
          || value.om.diagnostic !== null)
          fail('model_call_record_invalid', record.id, 'completion', 'Recovery preserves the exact already completed attempt');
      } else {
        const finish = recoveryFinish(store, record as Revision<OmModelCall>, reference(recovery.incident));
        if (finish.writes.length || !same(value.om.diagnostic, finish.diagnostic))
          fail('model_call_record_invalid', record.id, 'diagnostic', 'Physical loss completes A3 once through its shared transition');
      }
      return { state: 'recovered', outcome: { record: record as Revision<OmModelCall>, packet: value.om.request.packet,
        call: value.om.call, response: null, outcome: null, part: null, diagnostic: value.om.diagnostic, repeated: true } };
    }
    if (!isRef(value.om.exchange)) fail('model_call_record_invalid', record.id, 'exchange', 'A completed runtime call needs immutable transport evidence');
    const exchange = take(readRecord<ModelExchange>(store, value.om.exchange,
      { unit: 'E4', target: record.id, id: exchangeId(value.om.request), kind: EXCHANGE_KIND }));
    if (exchange.revision !== 1 || !exactKeys(exchange.value, ['project', 'request', 'call', 'wire', 'process', 'launchError', 'admissionGuards'])
      || exchange.value.project !== request.project || !same(exchange.value.request, value.om.request)
      || !same(exchange.value.call, value.om.call) || !same(exchange.value.wire, wire)
      || !Array.isArray(exchange.value.admissionGuards) || !exchange.value.admissionGuards.length
      || !exchange.value.admissionGuards.every(isRef) || !same(refs(exchange.value.admissionGuards), exchange.value.admissionGuards)
      || (exchange.value.process === null) === (exchange.value.launchError === null))
      fail('model_call_record_invalid', record.id, 'exchange', 'Transport evidence must belong to this exact request and original admission');
    for (const guard of exchange.value.admissionGuards) {
      const source = store.get(guard.id, guard.revision);
      if (!source || !same(reference(source), guard))
        fail('model_call_record_invalid', record.id, 'admissionGuards', 'The received exchange retains exact dispatch sources');
    }
    const transport = transportOf(exchange.value as ModelExchange);
    if (value.om.application === 'received') {
      if (value.status !== (transport.kind === 'answered' ? 'succeeded' : 'failed')
        || value.error !== (transport.kind === 'answered' ? null : transport.error.code)
        || !same(value.usage, transport.usage) || !same(value.confirmed, transport.confirmed)
        || value.usageSource !== (transport.usage === null ? 'unavailable' : 'adapter')
        || !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt
        || !same(value.response, transport.kind === 'answered'
          ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: value.om.exchange } : null)
        || value.om.part !== null || value.om.input !== null || value.om.diagnostic !== null
        || value.om.failure !== null || value.om.rejection !== null)
        fail('model_call_record_invalid', record.id, 'receipt', 'A physical receipt is derived solely from its immutable original exchange');
      return { state: 'received', record: record as Revision<OmModelCall>, exchange: exchange as Revision<ModelExchange>, transport };
    }
    if (!['applied', 'application-refused'].includes(value.om.application)
      || (value.om.application === 'application-refused') !== (value.om.rejection !== null))
      fail('model_call_record_invalid', record.id, 'application', 'Terminal application states distinguish a product result from a proved refusal');
    if (value.om.rejection !== null) {
      if (!isRef(value.om.rejection)) fail('model_call_record_invalid', record.id, 'rejection', 'Application rejection needs exact retained source heads');
      const rejected = take(readModelApplicationRejection(store, { project: request.project, record: value.om.rejection }));
      if (!same(rejected.record.value.packet, value.om.request.packet) || !same(rejected.record.value.call, value.om.call)
        || !same(rejected.record.value.exchange, value.om.exchange) || !same(value.om.failure, rejected.failure)
        || value.status !== 'failed' || value.error !== rejected.failure.code || value.om.part !== null || value.om.input !== null
        || !same(value.usage, transport.usage) || !same(value.confirmed, transport.confirmed)
        || value.usageSource !== (transport.usage === null ? 'unavailable' : 'adapter')
        || !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt
        || !same(value.response, transport.kind === 'answered'
          ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: value.om.exchange } : null))
        fail('model_call_record_invalid', record.id, 'rejection', 'A rejected application retains its original transport and checked failing source window');
      if (rejected.record.value.completion) {
        if (value.om.diagnostic !== null)
          fail('model_call_record_invalid', record.id, 'diagnostic', 'An already completed attempt is preserved, not completed again');
      } else {
        const finish = prepareModelFinish(store, { project: request.project, packet: value.om.request.packet, call: value.om.call,
          response: null, code: rejected.failure.code, message: rejected.failure.message, reason: 'interrupted',
          evidence: [value.om.exchange, value.om.rejection] });
        if (finish.writes.length || !same(finish.diagnostic, value.om.diagnostic))
          fail('model_call_record_invalid', record.id, 'diagnostic', 'A rejected application completes its attempt exactly once');
      }
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
    if (!same(value.om.failure, failure) || !same(value.usage, transport.usage) || !same(value.confirmed, transport.confirmed)
      || value.usageSource !== (transport.usage === null ? 'unavailable' : 'adapter')
      || value.status !== (transport.kind === 'answered' && !failure ? 'succeeded' : 'failed')
      || !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt
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
  });
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
    const prepared = take(prepareQuestionPacket(store, assignment.packet.value.request as QuestionPacketRequest));
    if (!same(reference(prepared.record), request.packet))
      fail('model_call_request_invalid', request.packet.id, 'packet', 'Application retains its exact currently admitted assignment');
    guards.push(...prepared.guards);
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
    const prepared = take(prepareQuestionPacket(store, packet.value.request as QuestionPacketRequest));
    if (!same(reference(prepared.record), request.packet)) fail('model_call_request_invalid', request.packet.id, 'packet', 'Dispatch uses exactly the currently admitted E2 packet');
    const guarded = new Proxy(store, { get(target, key) {
      if (key === 'writeMany') return (writes: Write[], guards: Ref[] = []) => target.writeMany(writes, refs([...guards, ...prepared.guards, request.packet]));
      const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const admitted = take(recordCall(guarded, request.project, assignment.admission));
    // E1 alone precedes the durable running claim. A repeat without that claim has not sent;
    // fresh dispatch admission plus expected=0 arbitrates concurrent resumptions.
    const call = reference(admitted.call), startedAt = Date.now();
    const running: OmModelCall = { projectId: request.project, draftId: packet.id, purpose: payload.purpose as string,
      requestId: wire.requestId, startedAt, finishedAt: null, status: 'running', requested: binding,
      confirmed: unknownConfirmed(), request: { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(payload), record: request.packet },
      response: null, usage: null, usageSource: 'unavailable', error: null,
      om: { version: 'om-model-call/v1', application: 'running', request, call, exchange: null, part: null, diagnostic: null, input: null, failure: null, rejection: null } };
    const physical = await startPhysicalTransport(store, { project: request.project, call, packet: payload as Json, role: request.role },
      { id, kind: 'model-call', expected: 0, value: running }, [...prepared.guards, request.packet], signal);
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
  transport: { version: 'om-model-transport/v1'; request: ModelTransportRequest; exchange: Ref | null };
}
export interface ModelTransportOutcome { record: Revision<TransportModelCall>; call: Ref; exchange: Ref | null; result: AdapterResult; repeated: boolean }
function requireTransport(store: Store, request: unknown): asserts request is ModelTransportRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.call)
    || !Object.hasOwn(request, 'packet') || !['implementer', 'reviewer'].includes(request.role as string)
    || !exactKeys(request, ['project', 'call', 'packet', 'role'])) invalid('transport');
  try { canonical(request.packet); } catch (error) { if (error instanceof EngineError) invalid('packet'); throw error; }
}
function transportAssignment(store: Store, request: ModelTransportRequest) {
  const call = take(readCall(store, request.project, request.call));
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
/** Shared physical boundary: real body fingerprint, current purpose admission and durable claim before spawn. */
async function startPhysicalTransport(store: Store, request: ModelTransportRequest, running: Write, guards: readonly Ref[], signal?: AbortSignal) {
  const assignment = transportAssignment(store, request), prepared = take(prepareCallDispatch(store, request.project, request.call));
  const admissionGuards = refs([...guards, ...prepared.guards]);
  let record = take(writeGuarded<ModelCall>(store, { unit: 'E4', target: running.id,
    writes: [{ ...running, value: { ...running.value as ModelCall, ...physicalClaim() } }],
    guards: admissionGuards }))[0]!;
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
/** Analysis keeps A6's body and outcome opaque; it uses the same process boundary as ordinary E2/E3 calls. */
export function readModelTransport(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<ModelTransportOutcome>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('transport-record');
  return result(() => {
    const record = take(readRecord<TransportModelCall>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `model-call:${request.project}:om:`, kind: 'model-call' }));
    if (!object(record.value) || !object(record.value.transport) || record.value.transport.version !== 'om-model-transport/v1')
      fail('model_call_record_invalid', record.id, 'transport', 'Analysis playback requires explicit transport provenance');
    const source = record.value.transport.request;
    requireTransport(store, source);
    if (source.project !== request.project) fail('model_call_record_invalid', record.id, 'project', 'This transport belongs to this project');
    const { call, wire, binding } = transportAssignment(store, source);
    if (!['stop-analysis', 'origin-analysis'].includes(call.value.purpose))
      fail('model_call_request_invalid', call.id, 'purpose', 'Ordinary dispatch is admitted through the E2/E3 orchestrator');
    const value = record.value;
    if (record.id !== modelRecordId(request.project, wire.requestId) || value.projectId !== request.project
      || value.requestId !== wire.requestId || value.purpose !== call.value.purpose || !same(value.requested, binding)
      || !same(value.request, { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(source.packet) }))
      fail('model_call_record_invalid', record.id, 'request', 'Analysis runtime must reproduce the actual admitted body and executor');
    if (value.status === 'running') fail('model_call_in_progress', record.id, 'status', 'The admitted analysis already owns a physical dispatch');
    if (value.recovery) {
      const recovered = readModelCallRecovery(store, request.project, request.record);
      if (!same((recovered.original.value as TransportModelCall).transport, value.transport) || value.transport.exchange !== null)
        fail('model_call_record_invalid', record.id, 'recovery', 'Analysis recovery retains its exact assignment without an invented response');
      return { record: record as Revision<TransportModelCall>, call: source.call, exchange: null, repeated: true,
        result: { kind: 'interrupted' as const, usage: null, confirmed: unknownConfirmed(),
          error: { code: 'process_lost', field: 'process', message: recovered.incident.value.reason } } };
    }
    const ref = value.transport.exchange;
    if (!isRef(ref)) fail('model_call_record_invalid', record.id, 'exchange', 'A completed analysis keeps the original transport evidence');
    const exchange = take(readRecord<TransportExchange>(store, ref,
      { unit: 'E4', target: record.id, id: transportExchangeId(source), kind: EXCHANGE_KIND }));
    if (exchange.revision !== 1 || !same(exchange.value.request, source) || !same(exchange.value.call, source.call)
      || exchange.value.project !== request.project || !same(exchange.value.wire, wire)
      || !exactKeys(exchange.value, ['project', 'request', 'call', 'wire', 'process', 'launchError'])
      || (exchange.value.process === null) === (exchange.value.launchError === null))
      fail('model_call_record_invalid', record.id, 'exchange', 'The analysis evidence must belong to this actual E1 body');
    const decoded = transportOf(exchange.value as TransportExchange);
    if (value.status !== (decoded.kind === 'answered' ? 'succeeded' : 'failed')
      || !same(value.confirmed, decoded.confirmed) || !same(value.usage, decoded.usage)
      || value.usageSource !== (decoded.usage === null ? 'unavailable' : 'adapter')
      || value.error !== (decoded.kind === 'answered' ? null : decoded.error.code)
      || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt
      || !same(value.response, decoded.kind === 'answered' ? { chars: decoded.raw.length, bytes: Buffer.byteLength(decoded.raw), record: ref } : null))
      fail('model_call_record_invalid', record.id, 'outcome', 'Analysis runtime is derived from the saved adapter response');
    return { record: record as Revision<TransportModelCall>, call: source.call, exchange: ref, result: decoded, repeated: true };
  });
}
export async function runModelTransport(store: Store, request: ModelTransportRequest, signal?: AbortSignal): Promise<OmResult<Sealed<ModelTransportOutcome>>> {
  requireTransport(store, request); request = sealed(request) as ModelTransportRequest;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  try {
    const { call, wire, binding } = transportAssignment(store, request), id = modelRecordId(request.project, wire.requestId);
    if (!['stop-analysis', 'origin-analysis'].includes(call.value.purpose))
      fail('model_call_request_invalid', request.call.id, 'purpose', 'Ordinary MC1/MC2 calls require the E2/E3 orchestrator');
    const prior = store.get(id);
    if (prior) {
      const saved = take(readModelTransport(store, { project: request.project, record: reference(prior) }));
      if (!same(saved.record.value.transport.request, request)) fail('model_call_identity_conflict', id, 'request', 'A physical identity cannot be rebound to another request');
      settlePhysicalCall(store, saved.record, request.call);
      return delivered(saved) as OmResult<Sealed<ModelTransportOutcome>>;
    }
    const startedAt = Date.now();
    const running: TransportModelCall = { projectId: request.project, draftId: call.id, purpose: call.value.purpose,
      requestId: call.value.call, startedAt, finishedAt: null, status: 'running', requested: binding, confirmed: unknownConfirmed(),
      request: { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(request.packet) },
      response: null, usage: null, usageSource: 'unavailable', error: null,
      transport: { version: 'om-model-transport/v1', request, exchange: null } };
    const physical = await startPhysicalTransport(store, request, { id, kind: 'model-call', expected: 0, value: running }, [], signal);
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
    if (record.revision !== 1 || !object(value) || !exactKeys(value, ['project', 'packet', 'call', 'exchange', 'guards', 'expectations', 'heads', 'failure', 'files', 'completion'])
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
    const runtimeId = modelRecordId(request.project, exchange.value.wire.requestId), runtime = store.get(runtimeId, 1);
    if (!runtime) fail('model_call_record_invalid', record.id, 'runtime', 'A rejected transaction follows its durable pre-dispatch claim');
    const relevant = new Set(refs([reference(runtime),
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
    const stale = fileStale || relevantStale.length > 0;
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
    const failure = ['input_stale', 'revision_conflict'].includes(input.failure.code) ? input.failure
      : !normalized.ok ? normalized.refusal : input.failure;
    const admitted = take(readCall(store, request.project, call)), seriesHead = store.get(admitted.value.series.id);
    const series = seriesHead ? take(readAnySeriesAt(store, request.project, reference(seriesHead))) : null;
    const completed = series?.value.attempts.find(item => item.ordinal === admitted.value.attempt)?.outcome;
    const completion = completed && series ? reference(series) : null;
    const ids = [...new Set([...input.guards.map(ref => ref.id), ...input.writes.map(write => write.id)])].sort();
    const value: ModelApplicationRejection = { project: request.project, packet: request.packet, call, exchange: exchangeRef, completion,
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
    const finish = completion ? { diagnostic: null, writes: [], guards: [] }
      : prepareModelFinish(pendingCallStore(store, writes), { project: request.project, packet: request.packet, call,
        response: null, code: failure.code, message: failure.message, reason: 'interrupted', evidence: [exchangeRef, rejectionRef] });
    writes.push(...finish.writes);
    const finished: OmModelCall = { ...running.value, finishedAt: Math.max(Date.now(), running.value.startedAt), status: 'failed',
      confirmed: transport.confirmed, usage: transport.usage, usageSource: transport.usage === null ? 'unavailable' : 'adapter', error: failure.code,
      response: transport.kind === 'answered' ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: exchangeRef } : null,
      om: { ...running.value.om, application: 'application-refused', exchange: exchangeRef, failure, rejection: rejectionRef, diagnostic: finish.diagnostic } };
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
      const finish = completion ? { writes: [], guards: [], diagnostic: null }
        : recoveryFinish(pendingCallStore(store, writes), record, incident);
      writes.push(...finish.writes); guards.push(reference(seriesHead), ...finish.guards);
      finished = { ...finished, om: { ...record.value.om, application: 'recovered', diagnostic: finish.diagnostic, completion } } as OmModelCall;
    } else if ('transport' in original.value) {
      const record = original as Revision<TransportModelCall>;
      const assignment = transportAssignment(store, record.value.transport.request);
      if (!['stop-analysis', 'origin-analysis'].includes(assignment.call.value.purpose)
        || !same(record.value.transport.exchange, null))
        fail('model_call_record_invalid', ref.id, 'transport', 'Only an unreceived analysis can be interrupted without a result');
    } else fail('model_call_foreign', ref.id, 'producer', 'The runtime has no E4 producer');
    writes.push({ id: original.id, kind: original.kind, expected: original.revision, value: finished });
    const view = pendingCallStore(store, writes), terminal = writeRef(writes[writes.length - 1]!);
    if ('om' in original.value) take(readModelCall(view, { project, record: terminal }));
    else take(readModelTransport(view, { project, record: terminal }));
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

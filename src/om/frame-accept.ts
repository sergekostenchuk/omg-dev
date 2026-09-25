import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Graph } from '../graph/model.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { assembleCandidate, gateCandidate, prepareCandidate, readCandidate, type FrameCandidateRecord } from './frame-candidate.js';
import type { LayerProposal, ProposalObservation, ProposalRequest } from './frame-proposals.js';
import { WORKS_FRAME_CONTRACT, currentFrameRequest, prepareFrame, readFrame, type FrameRead, type FrameRequest } from './frame-obligations.js';
import type { Finding } from '../pipeline/contracts.js';
import { omAcceptedFrame, buildAcceptedLayer, readLayerAcceptance, readAcceptedFrameLayer, readFrameAttemptBinding, isFrameAttemptBinding, FRAME_ACCEPTANCE_CONTRACT,
  type FrameAttemptBinding, type AcceptedFrameGate, type LayerBasis, type OmAcceptedFrame } from './layer-basis.js';
import { prepareSeriesLineAdmission } from './series.js';
import { prepareAtomicGate, readAtomicGate, type AtomicGateRequest, type AtomicGateRecord } from './atomic-gate.js';
import { journalId, prepareRecordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND, REFUSAL_JOURNAL_KIND,
  type RefusalJournal, type UnitRefusalRecord, type OriginSource } from './refusal-journal.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readRebaseBasis, buildRebasedLayer, type OmRebasedFrame } from './layer-basis.js';

export const FRAME_ACCEPT_CODES = Object.freeze([
  'candidate_level_unsupported', 'candidate_missing', 'candidate_graph_mismatch', 'gate_outcome_mismatch',
  'input_stale', 'frame_acceptance_invalid',
] as const);
export interface FrameGateOutcome { gate: 'G3' | 'G5'; candidate: Ref; graphHash: string; passed: boolean; codes: string[]; basis?: Ref }
export interface SettleCandidateRequest { project: string; level: 2 | 3; candidate: Ref; outcome: FrameGateOutcome; binding?: FrameAttemptBinding | null }
export interface Settlement {
  state: 'accepted' | 'rejected' | 'unchanged' | 'obsolete';
  graph: Revision<Graph> | null; layer: Revision<LayerBasis> | null; frame: Revision<OmAcceptedFrame> | null;
  proposals: Revision<LayerProposal>[];
}
export interface PreparedSettlement { result: Settlement; writes: Write[]; guards: Ref[]; expected: { graph: number; layer: number; frame: number } | null }
export interface AcceptedFrameRequest { project: string; level: 2 | 3; graph: Ref; layer: Ref; frame: Ref }
interface WorkRejectionRecord {
  contract: 'om-work-rejection/v1'; project: string; candidate: Ref; gate: Ref;
  diagnostic: Ref; previousJournal: Ref | null; journal: Ref; proposals: Ref[];
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const sorted = <T>(items: readonly T[]): T[] => [...items].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
const unique = (refs: readonly Ref[]): Ref[] => sorted([...new Map(refs.map(ref => [canonical(ref), ref])).values()]);
class AcceptFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: string, target: string, field: string, message: string): never {
  const result = refused(code, message, { unit: 'F4.6', target, field }, 'producer');
  if (!result.ok) throw new AcceptFailure(result.refusal);
  throw new EngineError('frame_accept_internal', 'A refusal unexpectedly succeeded');
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new AcceptFailure(result.refusal); return result.value; }
function run<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof AcceptFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function invalid(field: string): never {
  throw new EngineError('frame_accept_request_invalid', 'Frame acceptance needs explicit well-formed arguments', { unit: 'F4.6', target: 'candidate', field });
}
function requireRequest(store: Store, value: unknown): asserts value is SettleCandidateRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(value) || !text(value['project']) || ![2, 3].includes(value['level'] as number) || !isRef(value['candidate'])) invalid('request');
  if (Object.hasOwn(value, 'binding') && value['binding'] !== null && !isFrameAttemptBinding(value['binding'])) invalid('binding');
  const outcome = value['outcome'];
  if (!object(outcome) || !['G3', 'G5'].includes(outcome['gate'] as string) || !isRef(outcome['candidate'])
    || !hash(outcome['graphHash']) || typeof outcome['passed'] !== 'boolean' || !Array.isArray(outcome['codes'])
    || !outcome['codes'].every(text) || Object.hasOwn(outcome, 'basis') && !isRef(outcome['basis'])) invalid('outcome');
}
function proposedRevision<T>(write: Write): Revision<T> {
  return { id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(write.value), value: sealed(write.value) as T };
}
function exact<T>(store: Store, ref: Ref, id: string, kind: string): Revision<T> {
  return take(readRecord<T>(store, ref, { unit: 'F4.6', target: id, id, kind })) as Revision<T>;
}
function current(store: Store, ref: Ref): void {
  const row = store.get(ref.id);
  if (!row || !same(reference(row), ref)) fail('input_stale', ref.id, 'reference', 'The candidate prerequisite is no longer current');
}
function supported(level: number): void {
  if (level !== 2) fail('candidate_level_unsupported', `candidate:${level}`, 'level', 'L3 acceptance needs the actual F2/F5 producer');
}
/** Exact historical acceptance; moving heads never changes the event that accepted this frame. */
export function readAcceptedFrame(store: Store, request: AcceptedFrameRequest): OmResult<Sealed<Settlement>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || ![2, 3].includes(request.level)
    || ![request.graph, request.layer, request.frame].every(isRef)) invalid('acceptedFrame');
  return run(() => {
    const basis = take(readLayerAcceptance(store, request));
    if (basis.producer !== 'om' || !same(basis.frame, request.frame))
      fail('frame_acceptance_invalid', request.frame.id, 'acceptance', 'The layer must name this exact OM accepting frame');
    const frame = exact<OmAcceptedFrame>(store, request.frame, `om-frame:${request.project}:${request.level}`, 'connection-frame');
    if (!object(frame.value.acceptance) || !isRef(frame.value.acceptance.candidate))
      fail('frame_acceptance_invalid', request.frame.id, 'acceptance', 'A rebase cannot substitute for an actual candidate acceptance');
    const graph = exact<Graph>(store, request.graph, `graph:${request.project}`, 'graph');
    const layer = exact<LayerBasis>(store, request.layer, `graph-layer:${request.project}:${request.level}`, 'graph-layer');
    if (!same(request.graph, frame.value.acceptance.graph))
      fail('frame_acceptance_invalid', request.graph.id, 'graph', 'The historical event names its exact accepted graph revision');
    return acceptedSettlement(store, { graph, layer, frame });
  });
}
function acceptedSettlement(store: Store, found: { graph: Revision<Graph>; layer: Revision<LayerBasis>; frame: Revision<OmAcceptedFrame> }): Settlement {
  const { graph, layer, frame } = found;
  const candidate = take(readCandidate(store, { project: frame.value.project, candidate: frame.value.acceptance.candidate }));
  // The common layer reader already proved every proposed-to-accepted transition.
  const proposals = candidate.value.proposals.map(ref => store.get<LayerProposal>(ref.id, ref.revision + 1)!);
  return { state: 'accepted', graph, layer, frame, proposals };
}
function priorAcceptance(store: Store, request: SettleCandidateRequest): Settlement | null {
  for (const row of store.history<OmAcceptedFrame>(`om-frame:${request.project}:${request.level}`)) {
    if (!object(row.value) || !object(row.value.acceptance) || !same(row.value.acceptance.candidate ?? null, request.candidate)) continue;
    if (!isRef(row.value.acceptance.graph))
      fail('frame_acceptance_invalid', row.id, 'acceptance.graph', 'The accepting event must name its exact result graph');
    const found = take(readAcceptedFrameLayer(store, { project: request.project, level: request.level, frame: reference(row) }));
    if (!same(found.frame.value.acceptance.binding ?? null, request.binding ?? null))
      fail('frame_acceptance_invalid', row.id, 'acceptance.binding', 'An accepted candidate cannot be assigned to a different attempt or obligation set');
    return acceptedSettlement(store, found as unknown as Parameters<typeof acceptedSettlement>[1]);
  }
  return null;
}
function normalizeOutcome(request: SettleCandidateRequest): SettleCandidateRequest {
  return sealed({ ...request, ...(request.binding ? { binding: { ...request.binding, obligations: sorted(request.binding.obligations) } } : {}),
    outcome: { ...request.outcome, codes: sorted(request.outcome.codes) } }) as SettleCandidateRequest;
}
function workRejectionId(request: SettleCandidateRequest): string {
  return `om-work-rejection:${request.project}:${hashJson([request.candidate, request.outcome.basis])}`;
}
function workRejectionSources(store: Store, request: SettleCandidateRequest,
  candidate: Revision<FrameCandidateRecord>, gate: Revision<AtomicGateRecord>) {
  if (candidate.value.level !== 3 || candidate.value.works?.contract !== WORKS_FRAME_CONTRACT
    || gate.value.result.passed || !gate.value.result.codes.length || !gate.value.result.findings.length)
    fail('gate_outcome_mismatch', candidate.id, 'passed', 'Work rejection requires the complete failed G5 result');
  const proposalRequest = { frame: candidate.value.request.frame, proposals: candidate.value.request.proposals };
  const origins: OriginSource[] = [{ role: 'derived', ref: reference(candidate) },
    { role: 'base', ref: candidate.value.base.graph, context: { kind: 'frame', request: sealed(candidate.value.request.frame) } },
    { role: 'environment', ref: gate.value.request.environment },
    ...candidate.value.proposals.map(ref => ({ role: 'proposal', ref,
      context: { kind: 'proposal' as const, request: sealed(proposalRequest) } }))];
  const diagnosticValue: UnitRefusalRecord = { gate: 'G5', refusals: sorted(gate.value.result.findings).map(finding => ({
    code: finding.code, goal: finding.target, remedy: finding.message,
    origin: { name: finding.code, stage: 'atomicity', subject: finding.target, sources: sorted(origins) },
  })) };
  const diagnosticWrite: Write = { id: `${unitRefusalNamespace(request.project)}g5:${hashJson(reference(gate))}`,
    kind: UNIT_REFUSAL_KIND, expected: 0, value: diagnosticValue };
  const verdict = { contract: 'om-work-rejection/v1' as const, candidateHash: candidate.value.graphHash,
    candidate: request.candidate, gate: reference(gate), codes: sorted(gate.value.result.codes) };
  const proposalWrites = candidate.value.proposals.map(ref => {
    const original = exact<LayerProposal>(store, ref, ref.id, 'layer-proposal');
    return { id: ref.id, kind: 'layer-proposal', expected: ref.revision,
      value: { ...original.value, status: 'rejected' as const, verdict } };
  });
  return { diagnosticWrite, diagnostic: proposedRevision<UnitRefusalRecord>(diagnosticWrite), proposalWrites };
}
function withRecords(store: Store, rows: readonly Revision<unknown>[], absentHead?: string): Store {
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => {
      if (id === absentHead && revision === undefined) return null;
      return rows.find(row => row.id === id && (revision === undefined || revision === row.revision)) ?? target.get(id, revision);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function rejectionBody(request: SettleCandidateRequest, diagnostic: Ref, previousJournal: Ref | null, journal: Ref, proposals: Ref[]): WorkRejectionRecord {
  return { contract: 'om-work-rejection/v1', project: request.project, candidate: request.candidate,
    gate: request.outcome.basis!, diagnostic, previousJournal, journal, proposals };
}
/** Exact failed G5 settlement, including its journal snapshot; subsequent heads do not rewrite the event. */
export function readRejectedCandidate(store: Store, request: SettleCandidateRequest): OmResult<Sealed<Settlement>> {
  requireRequest(store, request); request = normalizeOutcome(request);
  return run(() => {
    if (request.level !== 3 || request.outcome.gate !== 'G5' || !request.outcome.basis || request.outcome.passed
      || !request.outcome.codes.length || !same(request.candidate, request.outcome.candidate))
      fail('gate_outcome_mismatch', request.candidate.id, 'outcome', 'A rejected work candidate names its failed G5 basis');
    const candidate = take(readCandidate(store, { project: request.project, candidate: request.candidate })) as Revision<FrameCandidateRecord>;
    const gate = take(readAtomicGate(store, { project: request.project, record: request.outcome.basis })) as Revision<AtomicGateRecord>;
    requireAtomicOutcome(request, candidate, gate);
    const derived = workRejectionSources(store, request, candidate, gate), id = workRejectionId(request);
    const row = store.get<WorkRejectionRecord>(id, 1);
    if (!row || row.kind !== 'om-work-rejection' || !object(row.value) || row.hash !== hashJson(row.value)
      || !isRef(row.value.journal) || row.value.journal.id !== journalId(request.project)
      || row.value.previousJournal !== null && (!isRef(row.value.previousJournal) || row.value.previousJournal.id !== journalId(request.project)))
      fail('frame_acceptance_invalid', id, 'rejection', 'The failed gate needs its exact complete rejection event');
    const diagnostic = exact<UnitRefusalRecord>(store, reference(derived.diagnostic), derived.diagnostic.id, UNIT_REFUSAL_KIND);
    if (!same(diagnostic, derived.diagnostic)) fail('frame_acceptance_invalid', diagnostic.id, 'refusals', 'Diagnostics must retain every original G5 finding');
    const proposals = derived.proposalWrites.map(write => {
      const expected = proposedRevision<LayerProposal>(write);
      return exact<LayerProposal>(store, reference(expected), expected.id, 'layer-proposal');
    });
    const journal = exact<RefusalJournal>(store, row.value.journal, journalId(request.project), REFUSAL_JOURNAL_KIND);
    const previous = row.value.previousJournal === null ? null
      : exact<RefusalJournal>(store, row.value.previousJournal, journalId(request.project), REFUSAL_JOURNAL_KIND);
    const verified = take(prepareRecordRefusal(withRecords(store, previous ? [previous] : [], previous ? undefined : journal.id),
      { project: request.project, source: reference(diagnostic) }));
    const journalWrite = verified.writes.find(write => write.id === journal.id);
    const expectedJournal = journalWrite ? proposedRevision<RefusalJournal>(journalWrite) : previous;
    if (!same(journal, expectedJournal) || !same(row.value, rejectionBody(request, reference(diagnostic),
      previous ? reference(previous) : null, reference(journal), proposals.map(reference))))
      fail('frame_acceptance_invalid', row.id, 'journal', 'The rejection must retain its complete journalled finding set and proposal transitions');
    return { state: 'rejected', graph: null, layer: null, frame: null, proposals };
  });
}
function requireAtomicOutcome(request: SettleCandidateRequest, candidate: Revision<FrameCandidateRecord>, atomic: Revision<AtomicGateRecord>): void {
  if (candidate.value.works?.contract !== WORKS_FRAME_CONTRACT || candidate.value.level !== 3
    || !same({ gate: atomic.value.result.gate, candidate: atomic.value.result.candidate,
      graphHash: atomic.value.result.graphHash, passed: atomic.value.result.passed, codes: sorted(atomic.value.result.codes) },
    { gate: request.outcome.gate, candidate: request.candidate, graphHash: request.outcome.graphHash,
      passed: request.outcome.passed, codes: request.outcome.codes }) || !same(request.candidate, request.outcome.candidate)
    || candidate.value.graphHash !== atomic.value.result.graphHash)
    fail('gate_outcome_mismatch', candidate.id, 'outcome', 'The claimed outcome must equal the complete saved G5 result for this works candidate');
}
function prepareWorkRejection(store: Store, request: SettleCandidateRequest, candidate: Revision<FrameCandidateRecord>,
  gate: Revision<AtomicGateRecord>, guards: Ref[], expected: PreparedSettlement['expected']): PreparedSettlement {
  const derived = workRejectionSources(store, request, candidate, gate), writes: Write[] = [...derived.proposalWrites];
  const old = store.get(derived.diagnostic.id);
  if (old && !same(old, derived.diagnostic))
    fail('frame_acceptance_invalid', old.id, 'refusals', 'An immutable G5 diagnostic cannot be replaced');
  if (!old) writes.push(derived.diagnosticWrite);
  const journal = take(prepareRecordRefusal(withRecords(store, [derived.diagnostic]), { project: request.project, source: reference(derived.diagnostic) }));
  writes.push(...journal.writes);
  const journalWrite = journal.writes.find(write => write.id === journalId(request.project));
  let previousJournal = journal.guards.find(ref => ref.id === journalId(request.project)) ?? null;
  let journalRef: Ref;
  if (journalWrite) journalRef = reference(proposedRevision<RefusalJournal>(journalWrite));
  else {
    const saved = store.get<RefusalJournal>(journalId(request.project));
    if (!saved || !same(saved.value, journal.value))
      fail('input_stale', journalId(request.project), 'journal', 'The journal changed after preparation of the rejection');
    journalRef = reference(saved); previousJournal = journalRef; guards.push(journalRef);
  }
  const proposals = derived.proposalWrites.map(write => proposedRevision<LayerProposal>(write));
  writes.push({ id: workRejectionId(request), kind: 'om-work-rejection', expected: 0,
    value: rejectionBody(request, reference(derived.diagnostic), previousJournal, journalRef, proposals.map(reference)) });
  return { result: { state: 'rejected', graph: null, layer: null, frame: null, proposals }, writes,
    guards: unique([...guards, ...journal.guards, ...(old ? [reference(old)] : [])]
      .filter(ref => !writes.some(write => same(reference(proposedRevision(write)), ref)))), expected };
}
/** Prepare every write and its guard before any member of the acceptance transaction is visible. */
export function prepareSettleCandidate(store: Store, request: SettleCandidateRequest): OmResult<Sealed<PreparedSettlement>> {
  requireRequest(store, request); request = normalizeOutcome(request);
  return run(() => {
    if (request.level === 3 && !request.outcome.basis) supported(request.level);
    if (request.outcome.gate !== (request.level === 3 ? 'G5' : 'G3') || request.level === 2 && request.outcome.basis !== undefined
      || !same(request.candidate, request.outcome.candidate)
      || (request.outcome.passed ? request.outcome.codes.length !== 0 : request.outcome.codes.length === 0))
      fail('gate_outcome_mismatch', request.candidate.id, 'outcome', 'The gate must name this exact candidate and its own level');
    const loaded = readCandidate(store, { project: request.project, candidate: request.candidate });
    if (!loaded.ok && loaded.refusal.code === 'record_forged')
      fail('candidate_missing', request.candidate.id, 'candidate', 'No candidate exists at this exact revision and hash');
    const candidate = take(loaded) as Revision<FrameCandidateRecord>;
    if (candidate.value.level !== request.level || request.outcome.graphHash !== candidate.value.graphHash)
      fail('gate_outcome_mismatch', candidate.id, 'graphHash', 'The gate outcome belongs to a different candidate graph');
    const atomic = request.level === 3 ? take(readAtomicGate(store, { project: request.project, record: request.outcome.basis! })) : null;
    if (atomic) requireAtomicOutcome(request, candidate, atomic as Revision<AtomicGateRecord>);
    const previous = priorAcceptance(store, request);
    if (previous) return { result: { ...previous, state: request.outcome.passed ? 'unchanged' : 'obsolete' }, writes: [], guards: [], expected: null };
    if (atomic && !atomic.value.result.passed && store.get(workRejectionId(request), 1)) {
      const rejected = take(readRejectedCandidate(store, request));
      return { result: { ...rejected, state: 'unchanged' }, writes: [], guards: [], expected: null };
    }
    let checked: AcceptedFrameGate;
    const gateGuards: Ref[] = [];
    if (atomic) {
      const admission = take(prepareAtomicGate(store, atomic.value.request as AtomicGateRequest));
      if (!same(admission.record, atomic))
        fail('gate_outcome_mismatch', atomic.id, 'basis', 'Current G5 preparation must reproduce the exact saved gate record');
      gateGuards.push(...admission.guards, reference(atomic));
      checked = { ...atomic.value.result, basis: reference(atomic) } as AcceptedFrameGate;
      if (checked.passed && (checked.findings.length || atomic.value.result.codes.length))
        fail('gate_outcome_mismatch', atomic.id, 'passed', 'Only the complete successful G5 result may accept a work candidate');
    } else {
      checked = take(gateCandidate(store, { project: request.project, candidate: request.candidate })) as AcceptedFrameGate;
      if (!request.outcome.passed)
        fail('gate_outcome_mismatch', candidate.id, 'passed', 'A failed outcome cannot replace the successful G3 result rederived by code');
    }
    // These are the exact source heads frozen by C4, not a fresh snapshot of changed proposals.
    current(store, candidate.value.base.graph);
    for (const ref of candidate.value.proposals) current(store, ref);
    const frameHead = store.get(`om-frame:${request.project}:${request.level}`);
    if (!same(frameHead ? reference(frameHead) : null, candidate.value.base.frame))
      fail('input_stale', candidate.id, 'base.frame', 'The accepted frame changed after candidate assembly');
    const prepared = take(prepareCandidate(store, candidate.value.request));
    if (prepared.state !== 'candidate' || !prepared.existing || !same(reference(prepared.existing), request.candidate))
      fail('candidate_graph_mismatch', candidate.id, 'candidate', 'Current preparation did not reproduce this exact saved candidate');
    if (atomic && !atomic.value.result.passed) return prepareWorkRejection(store, request, candidate,
      atomic as Revision<AtomicGateRecord>, unique([...prepared.guards, ...gateGuards, request.candidate]), prepared.expected);
    const binding = take(readFrameAttemptBinding(store, { project: request.project, candidate: request.candidate, binding: request.binding ?? null })).binding;
    const bindingGuards = binding ? take(prepareSeriesLineAdmission(store, request.project, binding.series)).guards : [];
    const upperId = `graph-layer:${request.project}:${request.level - 1}`;
    const upperCandidates = prepared.guards.filter(ref => ref.id === upperId);
    if (upperCandidates.length !== 1) fail('frame_acceptance_invalid', upperId, 'upper', 'The acceptance must retain exactly one admitted upper basis');
    const upperRef = upperCandidates[0]!;
    const upper = exact<LayerBasis>(store, upperRef, upperId, 'graph-layer');
    const graphWrite: Write = { id: `graph:${request.project}`, kind: 'graph', expected: prepared.expected.graph, value: candidate.value.graph };
    const graph = proposedRevision<Graph>(graphWrite);
    const frameValue = omAcceptedFrame(candidate, checked, reference(graph), upperRef, { contract: FRAME_ACCEPTANCE_CONTRACT,
      binding: binding ? { ...binding, obligations: [...binding.obligations] } : null,
      layer: { id: `graph-layer:${request.project}:${request.level}`, revision: prepared.expected.layer + 1 } });
    const frameWrite: Write = { id: `om-frame:${request.project}:${request.level}`, kind: 'connection-frame', expected: prepared.expected.frame, value: frameValue };
    const frame = proposedRevision<OmAcceptedFrame>(frameWrite);
    const layerValue = buildAcceptedLayer(candidate, upper, reference(frame));
    const layerWrite: Write = { id: `graph-layer:${request.project}:${request.level}`, kind: 'graph-layer', expected: prepared.expected.layer, value: layerValue };
    const layer = proposedRevision<LayerBasis>(layerWrite);
    const proposalWrites = candidate.value.proposals.map(ref => {
      const original = exact<LayerProposal>(store, ref, ref.id, 'layer-proposal');
      return { id: ref.id, kind: 'layer-proposal', expected: ref.revision, value: { ...original.value, status: 'accepted',
        verdict: { candidateHash: candidate.value.graphHash, candidate: request.candidate, codes: [] } } };
    });
    const proposals = proposalWrites.map(write => proposedRevision<LayerProposal>(write));
    return { result: { state: 'accepted', graph, layer, frame, proposals },
      writes: [graphWrite, layerWrite, frameWrite, ...proposalWrites], guards: unique([...prepared.guards, ...gateGuards, ...bindingGuards, request.candidate, upperRef]), expected: prepared.expected };
  });
}
export function settleCandidate(store: Store, request: SettleCandidateRequest): OmResult<Sealed<Settlement>> {
  return run(() => {
    const prepared = take(prepareSettleCandidate(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'F4.6', target: request.candidate.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.result as Settlement;
  });
}

export const PROPOSAL_REJECTION_CODES = Object.freeze(['proposal_rejection_unproven', 'proposal_rejection_invalid'] as const);
export interface ProposalRejectionVerdict {
  kind: 'assembly-refusal'; request: ProposalRequest; level: 2; codes: string[];
  refusal: Refusal & { findings?: Finding[] };
}
export interface RejectedLayerProposal extends Omit<LayerProposal, 'status' | 'verdict'> {
  status: 'rejected'; verdict: ProposalRejectionVerdict;
}
export interface ProposalRejection {
  state: 'rejected' | 'unchanged' | 'obsolete'; proposals: Revision<RejectedLayerProposal>[]; verdict: ProposalRejectionVerdict | null;
}
export interface PreparedProposalRejection { result: ProposalRejection; writes: Write[]; guards: Ref[] }
export interface RejectedProposalsRequest { request: ProposalRequest; proposals: Ref[] }
function requireRejectionRequest(store: Store, value: unknown): asserts value is ProposalRequest {
  if (!(store instanceof Store) || !object(value) || !object(value['frame'])
    || !Array.isArray(value['proposals']) || !value['proposals'].every(isRef)) invalid('rejection');
  const frame = value['frame'];
  if (!text(frame['project']) || ![2, 3].includes(frame['level'] as number)
    || !isRef(frame['graph']) || !isRef(frame['horizon'])
    || frame['layer'] !== null && !isRef(frame['layer']) || frame['frame'] !== null && !isRef(frame['frame'])) invalid('rejection.frame');
  const upper = frame['upper'];
  if (frame['level'] === 2 ? upper !== null : !object(upper) || !isRef(upper['horizon'])
    || upper['frame'] !== null && !isRef(upper['frame'])) invalid('rejection.upper');
}
function rejectionRequest(request: ProposalRequest): ProposalRequest {
  try { return sealed({ frame: request.frame, proposals: sorted(request.proposals) }) as ProposalRequest; }
  catch (error) {
    if (error instanceof EngineError && error.code === 'unsealable_value') invalid('rejection.json');
    throw error;
  }
}
function rejectionSources(store: Store, request: ProposalRequest): Revision<LayerProposal>[] {
  if (new Set(request.proposals.map(ref => ref.id)).size !== request.proposals.length)
    fail('proposal_rejection_invalid', 'proposals', 'reference', 'A checked proposal set names each source once');
  return request.proposals.map(ref => {
    const row = take(readRecord<LayerProposal>(store, ref, { unit: 'F4.6', target: ref.id,
      idPrefix: `om-proposal:${request.frame.project}:`, kind: 'layer-proposal' })) as Revision<LayerProposal>;
    const value = row.value;
    if (!object(value) || !object(value.base) || !isRef(value.base.graph)
      || value.base.frame !== null && !isRef(value.base.frame) || !['input', 'decision'].includes(value.source)
      || ![2, 3].includes(value.level) || !['proposed', 'accepted', 'rejected'].includes(value.status))
      fail('proposal_rejection_invalid', ref.id, 'source', 'A rejection needs a well-formed proposal source envelope');
    if (!same(value.base.graph, request.frame.graph) || !same(value.base.frame, request.frame.frame) || value.level !== request.frame.level)
      fail('proposal_base_stale', ref.id, 'base', 'The proposal does not belong to this exact frame basis');
    if (value.status !== 'proposed') fail('proposal_not_proposed', ref.id, 'status', 'Only the named proposed revision may be rejected');
    return row;
  });
}
const substantiveAssemblyCodes = new Set([
  'candidate_level_unsupported', 'derived_field_conflict', 'slot_fill_conflict', 'replacement_leaves_dangling', 'operation_port_unbound', 'graph_invalid',
  'slot_fill_foreign', 'proposal_node_reserved', 'frame_record_invalid',
]);
const proposalPayloadFields = new Set(['nodes', 'localConnectors', 'artifacts', 'contracts', 'joins', 'tests', 'edges',
  'journeys', 'packets', 'transfers', 'anchors', 'fills', 'removes', 'redefines', 'replaces']);
function rejectionVerdict(frame: FrameRead, sources: Revision<LayerProposal>[], request: ProposalRequest): ProposalRejectionVerdict {
  const observations: ProposalObservation[] = sources.map(row => ({ reference: reference(row), value: row.value }));
  const assembled = assembleCandidate(frame, observations);
  if (assembled.ok) fail('proposal_rejection_unproven', request.frame.graph.id, assembled.value.state,
    'Successful assembly and open gaps do not authorize proposal rejection');
  const refusal = assembled.refusal;
  const payloadFailure = refusal.code === 'proposal_invalid' && proposalPayloadFields.has(refusal.at.field ?? '')
    && sources.some(row => row.id === refusal.at.target);
  if (!substantiveAssemblyCodes.has(refusal.code) && !payloadFailure) throw new AcceptFailure(refusal);
  const findings = refusal.findings === undefined ? undefined : sorted(refusal.findings);
  return sealed({ kind: 'assembly-refusal', request, level: 2,
    codes: sorted([...new Set([refusal.code, ...(findings ?? []).map(finding => finding.code)])]),
    refusal: { ...refusal, ...(findings === undefined ? {} : { findings }) } }) as ProposalRejectionVerdict;
}
function rejectedValue(source: Revision<LayerProposal>, verdict: ProposalRejectionVerdict): RejectedLayerProposal {
  return { ...source.value, status: 'rejected', verdict };
}
/** Historical confirmation reassembles the original proposed revisions, never their rejected heads. */
export function readRejectedProposals(store: Store, request: RejectedProposalsRequest): OmResult<Sealed<ProposalRejection>> {
  if (!object(request) || !Array.isArray(request.proposals) || !request.proposals.every(isRef)) invalid('rejectedProposals');
  requireRejectionRequest(store, request.request);
  const sourcesRequest = rejectionRequest(request.request), proposalRefs = sorted(request.proposals);
  return run(() => {
    supported(sourcesRequest.frame.level);
    const sources = rejectionSources(store, sourcesRequest);
    const frame = take(readFrame(store, sourcesRequest.frame));
    const verdict = rejectionVerdict(frame as unknown as FrameRead, sources, sourcesRequest);
    if (proposalRefs.length !== sources.length || new Set(proposalRefs.map(ref => ref.id)).size !== proposalRefs.length)
      fail('proposal_rejection_invalid', 'proposals', 'set', 'Historical rejection must retain its complete checked set');
    const rows = sources.map(source => {
      const ref = proposalRefs.find(item => item.id === source.id);
      if (!ref || ref.revision !== source.revision + 1)
        fail('proposal_rejection_invalid', source.id, 'revision', 'Every rejection immediately follows its exact proposed source');
      const row = exact<RejectedLayerProposal>(store, ref, source.id, 'layer-proposal');
      if (!same(row.value, rejectedValue(source, verdict)))
        fail('proposal_rejection_invalid', source.id, 'verdict', 'The saved verdict must equal the refusal rederived for the whole source set');
      return row;
    });
    return { state: 'rejected', proposals: rows, verdict };
  });
}
/** Only substantive assembly failure of the established combination authorizes one atomic status transition. */
export function prepareRejectProposals(store: Store, request: ProposalRequest): OmResult<Sealed<PreparedProposalRejection>> {
  requireRejectionRequest(store, request); request = rejectionRequest(request);
  return run(() => {
    supported(request.frame.level);
    const sources = rejectionSources(store, request);
    const previous = sources.map(source => store.get<RejectedLayerProposal>(source.id, source.revision + 1));
    for (const row of previous) if (object(row?.value) && object(row.value.verdict)
      && row.value.verdict.kind === 'assembly-refusal' && !object(row.value.verdict.request))
      fail('proposal_rejection_invalid', row.id, 'verdict.request', 'The recorded refusal must retain its complete source request');
    if (previous.some(row => object(row?.value) && object(row.value.verdict)
      && row.value.verdict.kind === 'assembly-refusal' && same(row.value.verdict.request ?? null, request))) {
      if (previous.some(row => !row)) fail('proposal_rejection_invalid', 'proposals', 'set', 'A prior rejection lost part of its atomic source set');
      const replay = take(readRejectedProposals(store, { request, proposals: previous.map(row => reference(row!)) }));
      return { result: { ...replay, state: 'unchanged' }, writes: [], guards: [] };
    }
    for (const source of sources) {
      const head = store.get(source.id);
      if (!head) fail('input_stale', source.id, 'head', 'The proposed source is no longer present');
      if (!same(reference(head), reference(source))) {
        take(readFrame(store, request.frame));
        return { result: { state: 'obsolete', proposals: [], verdict: null }, writes: [], guards: [] };
      }
    }
    const frame = take(prepareFrame(store, request.frame));
    const verdict = rejectionVerdict(frame as unknown as FrameRead, sources, request);
    const writes = sources.map(source => ({ id: source.id, kind: 'layer-proposal', expected: source.revision, value: rejectedValue(source, verdict) }));
    return { result: { state: 'rejected', proposals: writes.map(write => proposedRevision<RejectedLayerProposal>(write)), verdict },
      writes, guards: unique([...frame.guards, ...sources.map(reference)]) };
  });
}
export function rejectProposals(store: Store, request: ProposalRequest): OmResult<Sealed<ProposalRejection>> {
  return run(() => {
    const prepared = take(prepareRejectProposals(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'F4.6', target: request.frame.project,
      writes: prepared.writes, guards: prepared.guards }));
    return prepared.result as ProposalRejection;
  });
}

export interface RebaseFrameRequest { from: FrameRequest; to: FrameRequest }
export interface FrameRebase {
  state: 'rebased' | 'unchanged'; frame: Revision<OmRebasedFrame>; layer: Revision<LayerBasis>;
  carried: number; retired: number;
}
export interface PreparedFrameRebase { result: FrameRebase; writes: Write[]; guards: Ref[] }
function requireRebaseRequest(store: Store, request: unknown): asserts request is RebaseFrameRequest {
  if (!(store instanceof Store) || !object(request)) invalid('rebase');
  for (const key of ['from', 'to']) {
    const frame = request[key];
    if (!object(frame) || !text(frame['project']) || ![2, 3].includes(frame['level'] as number)
      || !isRef(frame['graph']) || !isRef(frame['horizon'])
      || frame['frame'] !== null && !isRef(frame['frame']) || frame['layer'] !== null && !isRef(frame['layer'])
      || !object(frame['upper']) || !isRef(frame['upper']['horizon'])
      || frame['upper']['frame'] !== null && !isRef(frame['upper']['frame'])) invalid(`rebase.${key}`);
  }
}
function rebaseResult(frame: Revision<OmRebasedFrame>, layer: Revision<LayerBasis>, state: FrameRebase['state']): FrameRebase {
  return { state, frame, layer, carried: frame.value.fills.length, retired: frame.value.retired.length };
}
/** Rebase carries an already accepted work frame; it never accepts a new work candidate or G5 claim. */
export function prepareRebaseFrame(store: Store, request: RebaseFrameRequest): OmResult<Sealed<PreparedFrameRebase>> {
  requireRebaseRequest(store, request);
  currentFrameRequest(request.from); currentFrameRequest(request.to);
  request = sealed(request) as RebaseFrameRequest;
  return run(() => {
    const { from } = request;
    let { to } = request;
    if (from.level !== 3 || to.level !== 3)
      fail('candidate_level_unsupported', from.project, 'level', 'The current rebase carries accepted works after an OM operation transition');
    if (from.project !== to.project || !from.frame || !from.layer || to.frame !== null || to.layer !== null)
      fail('frame_acceptance_invalid', from.project, 'rebase', 'Rebase needs one exact old work frame and a fresh upper-basis request');
    const saved = store.get<OmRebasedFrame>(from.frame.id, from.frame.revision + 1);
    // A completed transition is compared in its recorded era before normalizing any new work.
    const replay = saved && object(saved.value) && object(saved.value.rebase)
      && object(saved.value.rebase.to) && Object.hasOwn(saved.value.rebase.to, 'workZoneContract')
      ? { from, to: currentFrameRequest(to) } : request;
    if (saved && object(saved.value) && same(saved.value.rebase ?? null, replay)) {
      const layer = store.get<LayerBasis>(from.layer.id, from.layer.revision + 1);
      if (!layer || !object(layer.value) || !object(layer.value.acceptance) || !isRef(layer.value.acceptance.frame)
        || !same(layer.value.acceptance.frame, reference(saved)))
        fail('frame_acceptance_invalid', saved.id, 'layer', 'The historical rebase lost its exact result layer');
      take(readLayerAcceptance(store, { project: from.project, level: 3, graph: to.graph, layer: reference(layer) }));
      return { result: rebaseResult(saved, layer, 'unchanged'), writes: [], guards: [] };
    }
    to = currentFrameRequest(to);
    request = { from, to };
    const basis = take(readRebaseBasis(store, request));
    for (const ref of [to.graph, to.horizon, from.layer, from.frame, ...basis.currentReferences]) current(store, ref);
    const guards: Ref[] = [...basis.currentReferences, to.graph, to.horizon, from.layer, from.frame];
    // Each horizon can carry different availability sources; admit both, preserving their complete guards.
    for (const horizon of unique([to.horizon, to.upper!.horizon])) {
      const admitted = take(prepareFrame(store, { project: to.project, level: 2, graph: to.graph, horizon,
        layer: basis.upper, frame: to.upper!.frame, upper: null }));
      guards.push(...admitted.guards);
    }
    const graph = exact<Graph>(store, to.graph, `graph:${to.project}`, 'graph');
    const upper = exact<LayerBasis>(store, basis.upper, `graph-layer:${to.project}:2`, 'graph-layer');
    const previous = exact<LayerBasis>(store, from.layer, `graph-layer:${from.project}:3`, 'graph-layer');
    const frameWrite: Write = { id: from.frame.id, kind: 'connection-frame', expected: from.frame.revision, value: basis.frame };
    const frame = proposedRevision<OmRebasedFrame>(frameWrite);
    const layerWrite: Write = { id: from.layer.id, kind: 'graph-layer', expected: from.layer.revision,
      value: buildRebasedLayer({ frame: basis.frame as OmRebasedFrame, reference: reference(frame), graph: graph.value, upper, previous }) };
    const layer = proposedRevision<LayerBasis>(layerWrite);
    return { result: rebaseResult(frame, layer, 'rebased'), writes: [layerWrite, frameWrite], guards: unique(guards) };
  });
}
export function rebaseFrame(store: Store, request: RebaseFrameRequest): OmResult<Sealed<FrameRebase>> {
  return run(() => {
    const prepared = take(prepareRebaseFrame(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'F4.6', target: request.from.project,
      writes: prepared.writes, guards: prepared.guards }));
    return prepared.result as FrameRebase;
  });
}

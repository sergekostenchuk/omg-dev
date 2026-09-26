import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { deriveInputDecisions, inputDecisionNamespace, type InputDecisionProposal } from './addressing.js';
import { applicableAnswerTask, readAnswerTaskBasis, readMc1Question, readAcceptedAnswer,
  type AnswerInvalidation } from './accepted-answer.js';
import { readAssessmentIntentAt, readAssessmentTerminalAt } from './assessment.js';
import { readCall, readFactAssessmentOrigin } from './call-record.js';
import { readCandidate, gateCandidate, prepareCandidate, type CandidateRequest } from './frame-candidate.js';
import { prepareFrameProposals, readFrameProposals } from './frame-proposals.js';
import { readGaps, prepareCurrentGaps, type GapReadRequest, type Gap } from './gaps.js';
import { historicalRead, readOmInput, withHistoricalReads, type OmInputRecord } from './input.js';
import { readPartAssembly, readModelCallState, readModelTransport } from './model-call.js';
import { readPartResult, readQuestionPacket } from './question-packet.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type RefusalRoute, type Sealed } from './refusal.js';
import { readRoutes, prepareRoutes, type RoutesRequest, type RoutedGap, type SavedRoutesRequest } from './routes.js';

export const ANSWERS_GATE_CONTRACT = 'om-answers-gate/v1' as const;
export const ANSWERS_GATE_KIND = 'om-answers-gate';
export const ANSWERS_GATE_CODES = sealed([
  'answers_gate_request_invalid', 'answers_gate_record_invalid', 'answers_missing', 'gap_source_missing', 'input_stale',
  'revision_conflict', 'record_foreign', 'answer_missing_for_blocking_gap', 'answer_version_stale',
  'answer_route_foreign', 'answer_duplicate', 'answer_gap_unknown', 'route_result_missing',
  'route_result_unsupported', 'owner_result_unavailable', 'deferral_not_permitted',
  'delta_not_verified', 'delta_stale',
] as const);

export interface AnswerRouteResult {
  gap: Ref; result: Ref | null; candidate: Ref | null;
  deferral?: { reason: 'outside_horizon'; until: 'horizon-entry' };
}
export interface AnswersGateRequest { project: string; gaps: GapReadRequest; routes: Ref; results: AnswerRouteResult[] }
export interface AnswersGateOutcome { passed: boolean; codes: string[]; findings: Refusal[] }
export interface AnswersGateRecord {
  contract: typeof ANSWERS_GATE_CONTRACT; project: string; request: AnswersGateRequest; result: AnswersGateOutcome;
}
export interface PreparedAnswersGate {
  record: Revision<AnswersGateRecord>; writes: Write[]; guards: TransactionGuard[]; references: Ref[];
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const unique = <T>(values: readonly T[]): T[] => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
class GateFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: string, target: string, field: string, message: string, ref?: Ref): never {
  const result = refused(code, message, { unit: 'G4b', target, field, ref }, 'readiness');
  if (!result.ok) throw new GateFailure(result.refusal);
  throw new Error('Unreachable refusal');
}
function finding(code: string, target: string, field: string, message: string, ref?: Ref): Refusal {
  const route: RefusalRoute = code === 'owner_result_unavailable' ? 'owner'
    : code === 'route_result_unsupported' ? 'producer' : 'readiness';
  const result = refused(code, message, { unit: 'G4b', target, field, ref }, route);
  if (!result.ok) return result.refusal;
  throw new Error('Unreachable refusal');
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new GateFailure(result.refusal); return result.value; }
function run<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof GateFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function invalid(field: string): never {
  throw new EngineError('answers_gate_request_invalid', 'G4b requires complete exact source and result addresses',
    { unit: 'G4b', target: 'answers', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function requireRequest(store: Store, value: unknown): asserts value is AnswersGateRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(value) || !text(value.project) || !object(value.gaps) || !object(value.gaps.sources)
    || !Array.isArray(value.gaps.records) || !value.gaps.records.every(isRef) || !isRef(value.routes)
    || Object.keys(value).some(key => !['project', 'gaps', 'routes', 'results'].includes(key))) invalid('request');
  if (!Array.isArray(value.results)) fail('answers_missing', value.project, 'results', 'The result set must be supplied explicitly');
  for (const row of value.results) {
    if (!object(row)) fail('answers_missing', value.project, 'results', 'Every declared result must be an object');
    if (!isRef(row.gap) || !(row.result === null || isRef(row.result))
      || !(row.candidate === null || isRef(row.candidate))
      || Object.hasOwn(row, 'deferral') && (!object(row.deferral) || row.deferral.reason !== 'outside_horizon'
        || row.deferral.until !== 'horizon-entry' || Object.keys(row.deferral).length !== 2)
      || Object.keys(row).some(key => !['gap', 'result', 'candidate', 'deferral'].includes(key))) invalid('results');
  }
}
function normalized(request: AnswersGateRequest): AnswersGateRequest {
  return copy({ ...request, gaps: { ...request.gaps, records: sorted(request.gaps.records) }, results: sorted(request.results) });
}
function idOf(request: AnswersGateRequest): string { return `om-answers-gate:${request.project}:${hashJson(request)}`; }
function sourceRequest(saved: SavedRoutesRequest): RoutesRequest {
  return { ...saved, tasks: saved.tasks.map(record => ({ record })) };
}
function matchPart(store: Store, project: string, ref: Ref) {
  const assembly = take(readPartAssembly(store, { project, record: ref }));
  const first = assembly.record.value.results[0]!;
  const part = take(readPartResult(store, { project, record: first }));
  return { proposal: reference(assembly.proposal), packet: part.record.value.request.packet,
    references: unique([...assembly.references, ...part.references]) as Ref[],
    parts: assembly.record.value.results as Ref[] };
}
function proveInputDecision(store: Store, project: string, ref: Ref): Ref[] {
  const proposal = take(readRecord<InputDecisionProposal>(store, ref,
    { unit: 'G4b', target: ref.id, idPrefix: inputDecisionNamespace(project), kind: 'input-decision' }));
  const previous = take(readOmInput(store, project, proposal.value.input));
  const derived = take(deriveInputDecisions(store, { project,
    previous: previous as Revision<OmInputRecord>, graph: proposal.value.graph, decisions: [ref] }));
  return unique([ref, ...derived.references]);
}
function modelCallKind(store: Store, project: string, ref: Ref): 'ordinary' | 'transport' {
  const record = take(readRecord<{ om?: unknown; transport?: unknown }>(store, ref,
    { unit: 'G4b', target: ref.id, idPrefix: `model-call:${project}:om:`, kind: 'model-call' }));
  const ordinary = object(record.value) && Object.hasOwn(record.value, 'om');
  const transport = object(record.value) && Object.hasOwn(record.value, 'transport');
  if (ordinary === transport) fail('model_call_record_invalid', ref.id, 'contract',
    'A model call must have exactly one E4 producer contract', ref);
  return ordinary ? 'ordinary' : 'transport';
}
/** Reprove recognizable offered records before classifying a wrong variant; never accept them on shape alone. */
function proveOfferedRecord(store: Store, project: string, ref: Ref): boolean {
  if (ref.id.startsWith('om-answer:')) take(readAcceptedAnswer(store, { project, record: ref }));
  else if (ref.id.startsWith('om-part-result:')) take(readPartResult(store, { project, record: ref }));
  else if (ref.id.startsWith('om-part-assembly:')) take(readPartAssembly(store, { project, record: ref }));
  else if (ref.id.startsWith('om-assessment-result:')) take(readAssessmentTerminalAt(store, project, ref));
  else if (ref.id.startsWith('model-call:')) {
    if (modelCallKind(store, project, ref) === 'ordinary') take(readModelCallState(store, { project, record: ref }));
    else take(readModelTransport(store, { project, record: ref }));
  }
  else if (ref.id.startsWith('om-routes:')) take(readRoutes(store, { project, record: ref }));
  else if (ref.id.startsWith('om-input-decision:')) proveInputDecision(store, project, ref);
  else if (ref.id.startsWith('om-owner-result:')) take(readRecord(store, ref,
    { unit: 'G4b', target: ref.id, idPrefix: `om-owner-result:${project}:`, kind: 'om-owner-result' }));
  else return false;
  return true;
}
function negativeFact(store: Store, request: AnswersGateRequest, row: AnswerRouteResult, route: RoutedGap,
  gap: Gap, current: boolean, guards: TransactionGuard[], references: Ref[], writes: Write[]): Refusal {
  const ref = row.result!, project = request.project;
  if (ref.id.startsWith('model-call:') && modelCallKind(store, project, ref) === 'ordinary') {
    const state = take(readModelCallState(store, { project, record: ref }));
    if (state.state === 'running' || state.state === 'received' || state.state === 'recovered')
      return finding('route_result_missing', gap.target, 'result', 'An unfinished MC1 call is not an answer', ref);
    const outcome = state.outcome;
    const call = take(readCall(store, project, outcome.call));
    const packet = take(readQuestionPacket(store, { project, record: outcome.packet }));
    const sourceRoutes = take(readRoutes(store, { project, record: packet.value.request.routes }));
    const currentRoutes = take(readRoutes(store, { project, record: request.routes }));
    const sourceBatch = sourceRoutes.record.value.batches.find(item => item.id === packet.value.request.batch);
    const currentBatch = currentRoutes.record.value.batches.find(item => item.id === packet.value.request.batch);
    if (call.value.purpose !== 'model-research' || call.value.basis !== null || !sourceBatch || !currentBatch
      || sourceBatch.model !== 'MC1' || sourceBatch.task !== 'fact' || !same(sourceBatch, currentBatch)
      || !sourceBatch.items.some(item => item.gap === gap.id && same(item.record, row.gap)
        && same(item.task, route.task)) || !route.task)
      return finding('answer_version_stale', gap.target, 'result',
        'The ordinary MC1 result must belong to this exact current M6 fact task', ref);
    const task = take(readAnswerTaskBasis(store, { project, task: { record: route.task }, current }));
    if (task.gap.target !== gap.target || task.gap.field !== gap.field)
      return finding('answer_version_stale', gap.target, 'result', 'The MC1 fact task addresses another gap', ref);
    guards.push(...task.guards, ...(current ? [ref] : []));
    references.push(ref, outcome.call, outcome.packet, packet.value.request.routes, ...task.references);
    writes.push(...task.writes);
    return finding(outcome.outcome?.kind === 'fact-candidates' ? 'route_result_missing' : 'answer_missing_for_blocking_gap',
      gap.target, 'result', outcome.outcome?.kind === 'fact-candidates'
        ? 'A substantive MC1 result needs its separately accepted D5 answer'
        : 'A checked technical MC1 result does not accept a D5 fact', ref);
  }
  let questionRef: Ref, supported = false, managedTransport = false, legacyTransport = false;
  if (ref.id.startsWith('om-assessment-result:')) {
    const terminal = take(readAssessmentTerminalAt(store, project, ref));
    const intent = take(readAssessmentIntentAt(store, project, terminal.value.intent));
    questionRef = intent.question.record;
    supported = terminal.value.verdict === 'supported';
    references.push(ref, terminal.value.intent, intent.question.record);
  } else {
    const transport = take(readModelTransport(store, { project, record: ref }));
    const call = take(readCall(store, project, transport.call));
    const basis = call.value.basis;
    if (call.value.purpose !== 'fact-assessment' || !basis || basis.kind !== 'fact-assessment')
      return finding('record_foreign', gap.target, 'result', 'This transport is not a fact assessment', ref);
    if (basis.assessment) {
      const intent = take(readAssessmentIntentAt(store, project, basis.assessment));
      questionRef = intent.question.record;
      managedTransport = true;
      references.push(basis.assessment);
    } else {
      const origin = take(readFactAssessmentOrigin(store, project, basis, ref.id));
      questionRef = basis.question;
      legacyTransport = true;
      if (!origin.gaps.some(address => address.id === gap.target && address.field === gap.field))
        return finding('answer_version_stale', gap.target, 'result', 'The assessed fact belongs to another question', ref);
    }
    references.push(ref, transport.call, basis.modelCall, basis.packet, basis.response, basis.question);
  }
  const question = take(readMc1Question(store, { project, record: questionRef }));
  if (!route.task || !same(question.record.value.request.gap, row.gap)
    || (question.record.value.request.task === undefined ? !legacyTransport
      : !same(question.record.value.request.task, route.task))
    || question.gap.target !== gap.target || question.gap.field !== gap.field)
    return finding('answer_version_stale', gap.target, 'result', 'The assessed fact does not belong to the exact current M6 question', ref);
  const task = take(readAnswerTaskBasis(store, { project, task: { record: route.task }, current }));
  if (task.gap.target !== gap.target || task.gap.field !== gap.field || !same(task.contract, question.record.value.request.contract))
    return finding('answer_version_stale', gap.target, 'result', 'The assessed question differs from the exact current D5 task', ref);
  guards.push(...task.guards);
  if (current && ref.id.startsWith('om-assessment-result:')) guards.push(ref);
  references.push(...task.references, questionRef);
  writes.push(...task.writes);
  if (supported) return finding('route_result_missing', gap.target, 'result',
    'A supported assessment is not its accepted D5 answer', ref);
  if (managedTransport) return finding('route_result_missing', gap.target, 'result',
    'A managed assessor transport is not its checked E5 terminal result', ref);
  return finding('answer_missing_for_blocking_gap', gap.target, 'result',
    'A checked negative or technical assessment does not accept a D5 fact', ref);
}
function proveResult(store: Store, request: AnswersGateRequest, row: AnswerRouteResult, route: RoutedGap,
  gap: Gap, current: boolean, guards: TransactionGuard[], references: Ref[], writes: Write[]): Refusal | null {
  const target = gap.target;
  if (route.route === 'owner' || gap.kind === 'owner-decision') {
    if (row.result) proveOfferedRecord(store, request.project, row.result);
    return finding('owner_result_unavailable', target,
      'owner-result', 'An owner gap needs the separately authenticated H2 owner-result producer', row.result ?? row.gap);
  }
  if (gap.code === 'predecessor_question' && gap.field === 'answer'
    && (gap.kind === 'design-decision' || gap.kind === 'environment-confirmation'
      || gap.kind === 'post-implementation-proof')) {
    if (row.result) proveOfferedRecord(store, request.project, row.result);
    return finding('route_result_unsupported', target, 'answer', 'This question has no OM answer producer in the current contract', row.gap);
  }
  if (row.result === null) return finding('answer_missing_for_blocking_gap', target, 'result', 'A blocking gap needs an exact result', row.gap);
  if (!gap.routes.includes(route.route)) return finding('answer_route_foreign', target, 'route', 'The D1 knowledge kind does not allow this route');
  if (gap.kind === 'repository-fact' && (route.route === 'code' || route.route === 'research')
    && (row.result.id.startsWith('om-assessment-result:') || row.result.id.startsWith('model-call:'))) {
    if (row.candidate !== null) return finding('answer_route_foreign', target, 'candidate', 'A fact result has no layer candidate', row.candidate);
    return negativeFact(store, request, row, route, gap, current, guards, references, writes);
  }
  if (row.result.id.startsWith('om-answer:') && !row.result.id.startsWith(`om-answer:${request.project}:`)) {
    take(readAcceptedAnswer(store, { project: request.project, record: row.result }));
    return finding('record_foreign', target, 'result', 'A foreign accepted answer cannot cover this gap', row.result);
  }
  if (row.result.id.startsWith(`om-answer:${request.project}:`)) {
    take(readAcceptedAnswer(store, { project: request.project, record: row.result }));
    if (gap.kind !== 'repository-fact' || !route.task)
      return finding('answer_route_foreign', target, 'result', 'An accepted fact needs the exact M6 question task', row.result);
    const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
    const search = routes.record.value.searches.find(item => item.gap === gap.id);
    if (!search) return finding('route_result_missing', target, 'search', 'The fact route lacks its complete answer search');
    const check = search.checks.find(item => same(item.answer, row.result));
    if (!check) return finding('answer_version_stale', target, 'search',
      'The exact answer is absent from the saved full search', row.result);
    const checked = take(applicableAnswerTask(store, { project: request.project, record: row.result,
      task: { record: route.task }, current,
      ...(!current ? { invalidation: copy<AnswerInvalidation | null>(check!.invalidation as AnswerInvalidation | null) } : {}) }));
    guards.push(...checked.guards, ...(current ? [row.result] : []));
    references.push(...checked.references, row.result);
    writes.push(...checked.writes);
    if (!checked.applicable) return finding('answer_version_stale', target, 'answer',
      'The saved answer no longer applies to this exact question', row.result);
    if (route.route !== 'code' || !route.answer || !check)
      return finding('answer_route_foreign', target, 'result',
        'An applicable D5 answer must occur in the complete current M6 search', row.result);
    if (row.candidate !== null) return finding('answer_route_foreign', target, 'candidate', 'A fact result does not carry a layer candidate');
    return null;
  }
  if (row.result.id.startsWith('om-input-decision:')) {
    references.push(...proveInputDecision(store, request.project, row.result));
    if (current) guards.push(row.result);
    return finding(gap.origins.includes('input') || gap.code === 'question_unaddressed'
      ? 'answer_missing_for_blocking_gap' : 'answer_route_foreign', target, 'result',
      'A D3 decision changes the next B1/D1 derivation; it does not cover an existing gap', row.result);
  }
  if (route.route !== 'design' || gap.kind !== 'design-decision' || gap.code !== 'obligation_open') {
    const known = proveOfferedRecord(store, request.project, row.result);
    return finding(known ? 'answer_route_foreign' : 'route_result_unsupported', target, 'result',
      'Only a checked producer result can satisfy this route', row.result);
  }
  if (row.result.id.startsWith(`om-part-result:${request.project}:`)) {
    take(readPartResult(store, { project: request.project, record: row.result }));
    return finding('route_result_missing', target, 'assembly', 'A part is not proof of the complete MC2 node', row.result);
  }
  if (!row.result.id.startsWith(`om-part-assembly:${request.project}:`)) {
    const known = proveOfferedRecord(store, request.project, row.result);
    return finding(known ? 'record_foreign' : 'route_result_unsupported',
      target, 'result', 'A design result needs a checked complete MC2 assembly', row.result);
  }
  const part = matchPart(store, request.project, row.result);
  const packet = take(readQuestionPacket(store, { project: request.project, record: part.packet }));
  const routeRecord = take(readRoutes(store, { project: request.project, record: request.routes }));
  const batch = routeRecord.record.value.batches.find(item => item.id === packet.value.request.batch);
  const assigned = part.parts.flatMap(record => {
    const checked = take(readPartResult(store, { project: request.project, record }));
    const source = take(readQuestionPacket(store, { project: request.project, record: checked.record.value.request.packet }));
    if (!object(source.value.packet) || !Array.isArray(source.value.packet.questions))
      fail('route_result_missing', source.id, 'questions', 'An MC2 result needs its exact assigned questions');
    return source.value.packet.questions.map(question => object(question) && text(question.id) ? question.id : '');
  });
  const assignedRoutes = take(readRoutes(store, { project: request.project, record: packet.value.request.routes }));
  const assignedBatch = assignedRoutes.record.value.batches.find(item => item.id === packet.value.request.batch);
  if (!batch || !assignedBatch || !same(assignedBatch, batch) || batch.task !== 'node-expansion'
    || !assigned.includes(gap.id)
    || !batch.items.some(item => item.gap === gap.id && same(item.record, row.gap)))
    return finding('answer_route_foreign', target, 'packet', 'The MC2 assignment must include this exact routed gap', part.packet);
  references.push(row.result, part.proposal, part.packet, ...part.references);
  if (current) guards.push(row.result, part.proposal, part.packet);
  if (batch.level === 2) {
    if (!row.candidate) return finding('delta_not_verified', target, 'candidate', 'An operation proposal needs the exact G3 candidate');
    const candidate = take(readCandidate(store, { project: request.project, candidate: row.candidate }));
    const gate = take(gateCandidate(store, { project: request.project, candidate: row.candidate }));
    if (!gate.passed) return finding('delta_not_verified', gate.findings[0]?.target ?? target,
      gate.findings[0]?.field ?? 'candidate', gate.findings[0]?.message ?? 'G3 did not verify the candidate', row.candidate);
    if (gate.graphHash !== candidate.value.graphHash || candidate.value.level !== 2
      || !candidate.value.request.proposals.some(ref => same(ref, part.proposal)))
      return finding('delta_stale', target, 'candidate', 'G3 must verify the candidate carrying this exact operation proposal', row.candidate);
    const source = request.gaps.sources.operations;
    if (current) {
      const prepared = take(prepareCandidate(store, copy<CandidateRequest>({
        ...candidate.value.request, frame: source.frame,
      } as CandidateRequest)));
      if (prepared.state !== 'candidate' || prepared.writes.length || !prepared.existing
        || !same(reference(prepared.existing), row.candidate))
        fail('input_stale', target, 'candidate', 'The G3 candidate is not admitted by the current frame', row.candidate);
      guards.push(...prepared.guards, row.candidate);
    }
    references.push(row.candidate);
  } else if (batch.level === 3) {
    if (row.candidate !== null) return finding('answer_route_foreign', target, 'candidate', 'Works are admitted to assembly before G5 acceptance');
    const works = request.gaps.sources.works;
    if (!('frame' in works)) return finding('route_result_missing', target, 'works', 'The exact works frame is unavailable', row.result);
    const proof = { frame: works.frame, proposals: unique([...works.proposals, part.proposal]) };
    const derived = take(readFrameProposals(store, proof));
    if (derived.result.open.some(item => item.id === target)
      || !derived.result.fills.some(fill => fill.obligation === target && fill.source === 'proposed'
        && same(fill.basis, part.proposal)))
      return finding('route_result_missing', target, 'proposal', 'The complete MC2 proposal does not fill the exact works obligation', row.result);
    references.push(...derived.references);
    if (current) {
      const prepared = take(prepareFrameProposals(store, proof));
      if (!same(prepared.result, derived.result)) fail('input_stale', target,
        'works', 'The works proposal changed before current admission', row.result);
      guards.push(...prepared.guards);
      references.push(...prepared.references);
    }
  } else return finding('answer_route_foreign', target, 'batch', 'A node proposal needs a level-two or level-three MC2 batch');
  return null;
}
function derive(store: Store, request: AnswersGateRequest, current: boolean): PreparedAnswersGate {
  requireRequest(store, request); request = normalized(request);
  const gaps = take(readGaps(store, request.gaps));
  if (gaps.sources.project !== request.project) fail('gap_source_missing', request.project, 'gaps', 'G4b needs this project\'s complete exact D1 set');
  if (!gaps.gate.passed) fail('gap_source_missing', request.project, 'gaps', 'The D1 source has not passed its complete derivation gate');
  const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
  if (!same(routes.record.value.request.gaps.sources, gaps.sources)
    || !same(sorted(routes.record.value.request.gaps.records), sorted(request.gaps.records)))
    fail('input_stale', request.project, 'routes', 'The M6 route must use this exact complete D1 version', request.routes);
  const guards: TransactionGuard[] = [], writes: Write[] = [],
    references: Ref[] = [request.routes, request.gaps.sources.input, ...request.gaps.records, ...routes.references];
  if (current) {
    const preparedGaps = take(prepareCurrentGaps(store, request.gaps));
    const preparedRoutes = take(prepareRoutes(store, sourceRequest(copy<SavedRoutesRequest>(routes.record.value.request as SavedRoutesRequest))));
    if (!same(reference(preparedRoutes.record), request.routes))
      fail('input_stale', request.routes.id, 'routes', 'The saved M6 route is not the complete current derivation', request.routes);
    guards.push(...preparedGaps.guards, ...preparedRoutes.guards, request.routes, request.gaps.sources.input,
      ...request.gaps.records);
    references.push(...preparedGaps.references, ...preparedRoutes.references);
    writes.push(...preparedRoutes.writes);
  }
  const findings: Refusal[] = [], grouped = new Map<string, AnswerRouteResult[]>();
  const all = new Map(gaps.records.map(record => [record.id, record]));
  for (const row of request.results) {
    const saved = all.get(row.gap.id);
    if (saved && saved.revision === row.gap.revision && saved.hash !== row.gap.hash)
      fail('record_forged', row.gap.id, 'gap.hash', 'The declared gap has a false exact content hash', row.gap);
    if (saved && !same(reference(saved), row.gap)) {
      findings.push(finding('answer_version_stale', saved.value.gap.target, 'gap',
        'The result names another revision of this D1 gap', row.gap));
    }
    if (!saved) {
      findings.push(finding('answer_gap_unknown', row.gap.id, 'gap', 'The result is outside this exact complete D1 set', row.gap));
      continue;
    }
    grouped.set(row.gap.id, [...(grouped.get(row.gap.id) ?? []), row]);
  }
  for (const saved of gaps.records) {
    const gap = saved.value.gap;
    const rows = grouped.get(saved.id) ?? [];
    const route = routes.record.value.routes.find(item => item.gap === gap.id && same(item.record, reference(saved)));
    if (!route) {
      findings.push(finding('answer_route_foreign', gap.target, 'route', 'The M6 route does not name this exact gap', reference(saved)));
      continue;
    }
    for (const offered of rows) {
      const deferred = Object.hasOwn(offered, 'deferral') || gap.blocking && gap.deferral !== undefined;
      if (deferred && gap.blocking) findings.push(finding('deferral_not_permitted', gap.target,
        'blocking', 'A blocking gap cannot be deferred by its result', offered.gap));
    }
    if (rows.length > 1) {
      findings.push(finding('answer_duplicate', gap.target, 'gap', 'A gap has more than one proposed result', reference(saved)));
      continue;
    }
    const row = rows[0];
    if (!row) {
      if (!gap.blocking) continue;
      if (gap.kind === 'owner-decision') findings.push(finding('owner_result_unavailable', gap.target,
        'owner-result', 'An owner gap needs the separately authenticated H2 owner-result producer', reference(saved)));
      else if (gap.code === 'predecessor_question' && gap.field === 'answer'
        && (gap.kind === 'design-decision' || gap.kind === 'environment-confirmation'
          || gap.kind === 'post-implementation-proof'))
        findings.push(finding('route_result_unsupported', gap.target, 'answer',
          'This question has no OM answer producer in the current contract', reference(saved)));
      else findings.push(finding('answer_missing_for_blocking_gap', gap.target, 'result',
        'Every blocking D1 gap needs one result', reference(saved)));
      continue;
    }
    if (!same(row.gap, reference(saved))) continue;
    if (!gap.routes.includes(route.route)) findings.push(finding('answer_route_foreign', gap.target,
      'route', 'The D1 knowledge kind does not allow this route', row.gap));
    const deferred = Object.hasOwn(row, 'deferral') || gap.blocking && gap.deferral !== undefined;
    if (row.result === null && row.candidate !== null) {
      findings.push(finding('route_result_missing', gap.target, 'result',
        'A candidate without its complete result cannot cover a gap', row.candidate));
      continue;
    }
    if (row.result === null && !gap.blocking) continue;
    if (row.result === null && deferred) continue;
    const issue = proveResult(store, request, row, route as RoutedGap, gap as Gap, current, guards, references, writes);
    if (issue) findings.push(issue);
  }
  const outcome: AnswersGateOutcome = { passed: findings.length === 0, codes: unique(findings.map(item => item.code)), findings: sorted(findings) };
  const value: AnswersGateRecord = { contract: ANSWERS_GATE_CONTRACT, project: request.project, request, result: outcome };
  const record: Revision<AnswersGateRecord> = { id: idOf(request), kind: ANSWERS_GATE_KIND, revision: 1, hash: hashJson(value), value };
  const merged = new Map<string, Write>();
  for (const write of writes) {
    const old = merged.get(write.id);
    if (old && !same(old, write)) fail('revision_conflict', write.id, 'writes', 'Two admitted sources require different writes');
    merged.set(write.id, write);
  }
  return { record, writes: [...merged.values()], guards: unique(guards), references: unique(references) };
}
export function readAnswersGate(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<Revision<AnswersGateRecord>>> {
  return run(() => {
    if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('read');
    return historicalRead(store, { reader: 'G4b.answers', project: request.project, ref: request.record }, () => {
      const saved = take(readRecord<AnswersGateRecord>(store, request.record, { unit: 'G4b', target: request.record.id,
        kind: ANSWERS_GATE_KIND, idPrefix: `om-answers-gate:${request.project}:` }));
      if (!object(saved.value) || saved.value.contract !== ANSWERS_GATE_CONTRACT || saved.value.project !== request.project)
        fail('answers_gate_record_invalid', saved.id, 'contract', 'The saved G4b outcome has an unsupported producer contract');
      let source: AnswersGateRequest;
      try {
        source = copy<AnswersGateRequest>(saved.value.request as AnswersGateRequest);
        requireRequest(store, source);
      } catch (error) {
        if (!(error instanceof GateFailure)
          && (!(error instanceof EngineError) || error.code !== 'answers_gate_request_invalid')) throw error;
        fail('answers_gate_record_invalid', saved.id, 'request', 'The saved G4b request has an invalid source or result shape');
      }
      const derived = derive(store, source, false);
      if (!same(derived.record, saved))
        fail('answers_gate_record_invalid', saved.id, 'result', 'G4b must be rederived from its exact saved D1/M6 and answer sources');
      return saved as Revision<AnswersGateRecord>;
    }, () => fail('answer_version_stale', request.record.id, 'history', 'G4b contains a cyclic historical source'));
  });
}
export function prepareAnswersGate(store: Store, request: AnswersGateRequest): OmResult<Sealed<PreparedAnswersGate>> {
  return run(() => {
    const prepared = derive(store, request, true), old = store.get(prepared.record.id);
    if (old) {
      const existing = take(readAnswersGate(store, { project: request.project, record: reference(old) }));
      if (!same(existing, prepared.record)) fail('answer_version_stale', old.id, 'result', 'One G4b identity has one derived outcome');
      prepared.guards.push(reference(existing));
    } else prepared.writes.push({ id: prepared.record.id, kind: prepared.record.kind, expected: 0, value: prepared.record.value });
    return prepared;
  });
}
export function writeAnswersGate(store: Store, request: AnswersGateRequest): OmResult<Sealed<Revision<AnswersGateRecord>>> {
  return run(() => {
    requireRequest(store, request); request = normalized(request);
    const old = store.get(idOf(request));
    if (old) return take(readAnswersGate(store, { project: request.project, record: reference(old) })) as Revision<AnswersGateRecord>;
    const prepared = take(prepareAnswersGate(store, request));
    take(writeGuarded(store, { unit: 'G4b', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record;
  });
}

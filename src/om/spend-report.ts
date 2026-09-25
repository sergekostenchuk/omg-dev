import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard } from '../storage/store.js';
import { transactionGuardsCurrent } from '../runtime/environment.js';
import type { ModelCall, TokenUsage } from '../runtime/model-usage.js';
import { readModelCallRecovery, readLateModelReceiptAt } from '../discovery/model-call-recovery.js';
import { withHistoricalReads } from './input.js';
import { readRecord } from './refs.js';
import { delivered, refused, isPlainObject, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { CALL_PURPOSES, callLedgerId, callRecordId, readCall, readCallLedger, readCallLedgerAt,
  type CallLedgerHistory, type CallPurpose, type AnyCallLedgerEntry } from './call-record.js';
import { readModelCallPhysical, readModelTransport, readAdapterResponse } from './model-call.js';
import { readAnySeriesAt, type Achievement, type AnyRepairSeries } from './series.js';
import { confirmResults } from './achievements.js';
import { readGaps, type GapReadRequest, type GapRecord } from './gaps.js';
import { readRoutes } from './routes.js';
import { readQuestionPacket } from './question-packet.js';
import { readOmObligationLedger } from './obligations.js';
import { taskBindingId } from '../graph/task-obligations.js';

export const SPEND_REPORT_SCOPE = 'om-e1';
export const SPEND_REPORT_CODES = Object.freeze(['spend_request_invalid', 'spend_source_invalid', 'spend_basis_invalid',
  'call_without_record', 'call_not_settled'] as const);
export interface SpendSignificanceSource { call: Ref; gaps: GapReadRequest; obligations: Ref | null }
export interface SpendSnapshot {
  project: string; ledger: Ref | null; calls: Ref[]; series: Ref[]; histories: CallLedgerHistory[];
  significance: SpendSignificanceSource[]; late: { call: Ref; receipt: Ref | null }[];
}
export interface SpendRequest { project: string; histories?: CallLedgerHistory[]; significance?: SpendSignificanceSource[] }
export interface SpendSignificance { obligations: number | null; consumers: number | null; blocks: number | null; sources: Ref[] }
export interface SpendRow {
  call: Ref | null; physical: Ref | null; purpose: CallPurpose; questions: AnyCallLedgerEntry['gaps'];
  series: Ref | null; attempt: number | null; usage: TokenUsage | null;
  settlement: 'open' | 'succeeded' | 'failed' | 'missing'; significance: SpendSignificance;
  /** A proved accepted outcome of the attempt, not a claim that this one call caused it. */
  result: { series: Ref; attempt: number; verdict: string | null; achieved: readonly Achievement[] } | null;
}
export interface SpendTotals { calls: number; measuredCalls: number; unmeasuredCalls: number; reportedTokens: TokenUsage | null }
export interface SpendReport {
  scope: typeof SPEND_REPORT_SCOPE; snapshot: SpendSnapshot; rows: SpendRow[]; findings: Refusal[];
  totals: SpendTotals; byPurpose: Record<CallPurpose, SpendTotals>;
}
const object = (value: unknown): value is Record<string, any> => isPlainObject(value);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const compare = (a: unknown, b: unknown): number => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
const keys = (value: object, expected: string[]): boolean => same(Object.keys(value).sort(), [...expected].sort());
const ref = (value: unknown): value is Ref => object(value) && keys(value, ['id', 'revision', 'hash']) && isRef(value);
const refs = (items: readonly Ref[]): Ref[] => [...new Map(items.map(item => [canonical(item), item])).values()]
  .sort(compare);
const unknownSignificance = (): SpendSignificance => ({ obligations: null, consumers: null, blocks: null, sources: [] });
const namespace = (project: string) => `model-call:${project}:om:`;
class SpendFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new SpendFailure(result.refusal); return result.value; }
function fail(code: string, target: string, field: string, message: string): never {
  take(refused(code, message, { unit: 'F8.3', target, field }, 'producer')); throw new Error('Unreachable');
}
function result(action: () => SpendReport): OmResult<Sealed<SpendReport>> {
  return withHistoricalReads(() => { try { return delivered(action()); } catch (error) {
    if (error instanceof SpendFailure) return { ok: false, refusal: error.refusal }; throw error;
  } });
}
function invalid(field: string): never {
  throw new EngineError('spend_request_invalid', 'Spend reports require an explicit, well-formed source set',
    { unit: 'F8.3', target: 'spend-report', field });
}
function requireProject(store: Store, request: unknown): asserts request is SpendRequest {
  if (!(store instanceof Store) || !object(request) || typeof request.project !== 'string'
    || !request.project.trim() || request.project.includes(':')) invalid('project');
}
function array(value: unknown): value is any[] { return Array.isArray(value) && Array.from(value).every(item => item !== undefined); }
function requireOptions(request: { histories?: unknown; significance?: unknown }): void {
  if (!array(request.histories) || !request.histories.every(item => object(item) && keys(item, ['call', 'journal']) && ref(item.call) && ref(item.journal))
    || !array(request.significance) || !request.significance.every(item => object(item) && keys(item, ['call', 'gaps', 'obligations'])
      && ref(item.call) && object(item.gaps) && object(item.gaps.sources) && array(item.gaps.records) && item.gaps.records.every(ref)
      && (item.obligations === null || ref(item.obligations)))) invalid('sources');
  for (const items of [request.histories, request.significance]) {
    if (new Set(items.map(item => item.call.id)).size !== items.length) invalid('sources.duplicates');
  }
}
function requireSnapshot(store: Store, snapshot: Sealed<SpendSnapshot>): void {
  requireProject(store, snapshot);
  if (!keys(snapshot, ['project', 'ledger', 'calls', 'series', 'histories', 'significance', 'late'])
    || !(snapshot.ledger === null || ref(snapshot.ledger))
    || !array(snapshot.calls) || !snapshot.calls.every(ref) || !array(snapshot.series) || !snapshot.series.every(ref)
    || !array(snapshot.late) || !snapshot.late.every(item => object(item) && keys(item, ['call', 'receipt']) && ref(item.call)
      && (item.receipt === null || ref(item.receipt)))) invalid('snapshot');
  requireOptions(snapshot);
  for (const entries of [snapshot.calls, snapshot.series, snapshot.late.map(item => item.call)]) {
    if (new Set(entries.map(item => item.id)).size !== entries.length) invalid('snapshot.duplicates');
  }
}

/** Capture a complete current OM/E1 source set; native research budgets are a different accounting domain. */
export function spendReport(store: Store, request: SpendRequest): OmResult<Sealed<SpendReport>> {
  requireProject(store, request);
  if (Object.keys(request).some(key => !['project', 'histories', 'significance'].includes(key))) invalid('request');
  const options = { histories: request.histories ?? [], significance: request.significance ?? [] };
  // Explicit null is not a request for a default empty source set.
  if (request.histories === null || request.significance === null) invalid('sources');
  requireOptions(options);
  return result(() => {
    const project = request.project, guards: TransactionGuard[] = [];
    const capture = (id: string) => { const row = store.get(id); guards.push(row ? reference(row) : { id, absent: true }); return row; };
    capture(`project-dispatch:${hashJson(project)}`); // Protect enumeration before looking at physical calls.
    const ledgerHead = capture(callLedgerId(project));
    const journal = capture(`om-refusal-journal:${project}`);
    const histories = [...options.histories];
    const ledgerBody: unknown = ledgerHead?.value;
    if (object(ledgerBody) && array(ledgerBody.calls) && journal) {
      for (const row of ledgerBody.calls) if (object(row) && 'owner' in row && row.purpose === 'origin-analysis'
        && ref(row.call) && !histories.some(item => item.call.id === row.call.id)) histories.push({ call: row.call, journal: reference(journal) });
    }
    const ledger = take(readCallLedger(store, project, histories));
    const physical = store.list<ModelCall>('model-call').filter(row => row.id.startsWith(namespace(project)));
    guards.push(...physical.map(reference));
    const series = new Map<string, Ref>();
    for (const call of ledger?.value.calls ?? []) {
      if (!series.has(call.series.id)) {
        const row = capture(call.series.id);
        if (!row) fail('spend_source_invalid', call.series.id, 'series', 'The call must retain its original series');
        series.set(row.id, reference(row));
      }
    }
    const late: SpendSnapshot['late'] = [];
    for (const row of physical) if (object(row.value) && row.value.recovery) {
      const recovery = readModelCallRecovery(store, project, reference(row));
      const head = capture(`model-late-receipt:${hashJson({ dispatch: reference(recovery.original) })}`);
      const receipt = head ? readLateModelReceiptAt(store, project, reference(row), reference(head)) : null;
      late.push({ call: reference(row), receipt: receipt ? reference(receipt) : null });
    }
    const snapshot: SpendSnapshot = { project, ledger: ledger ? reference(ledger) : null, calls: physical.map(reference),
      series: [...series.values()], histories, significance: options.significance, late };
    const report = derive(store, snapshot);
    if (!transactionGuardsCurrent(store, guards)) fail('input_stale', callLedgerId(project), 'sources', 'The current report source set changed while it was being read');
    return report;
  });
}

/** A historical report uses only the explicitly named cut, never filling gaps from later heads. */
export function readSpendReport(store: Store, snapshot: Sealed<SpendSnapshot>): OmResult<Sealed<SpendReport>> {
  requireSnapshot(store, snapshot);
  return result(() => derive(store, JSON.parse(canonical(snapshot)) as SpendSnapshot));
}

interface Physical { record: Revision<ModelCall>; call: Ref; purpose: CallPurpose; packet: Ref | null; usage: TokenUsage | null; missing: boolean }
function physicalCall(store: Store, snapshot: SpendSnapshot, at: Ref): Physical | null {
  const { project } = snapshot;
  const record = take(readRecord<ModelCall>(store, at, { unit: 'F8.3', target: at.id, kind: 'model-call', id: at.id })) as Revision<ModelCall>;
  const body: unknown = record.value;
  if (!object(body) || body.projectId !== project) fail('spend_source_invalid', at.id, 'project', 'A physical call belongs to this project');
  if (!at.id.startsWith(namespace(project))) {
    if (/^model-call:[0-9a-f-]{36}$/.test(at.id) && !('om' in body) && !('transport' in body)) return null;
    fail('spend_source_invalid', at.id, 'producer', 'An unrecognized physical call cannot select an accounting domain');
  }
  const om = 'om' in body, transport = 'transport' in body;
  const producer = om ? body.om : body.transport;
  if (om === transport || !object(producer) || producer.version !== (om ? 'om-model-call/v1' : 'om-model-transport/v1')
    || !object(producer.request) || producer.request.project !== project || typeof body.requestId !== 'string'
    || at.id !== `${namespace(project)}${hashJson(body.requestId)}` || !CALL_PURPOSES.includes(body.purpose as CallPurpose))
    fail('spend_source_invalid', at.id, 'producer', 'An OM physical call requires its declared producer and exact request identity');
  const call: Ref = om ? producer.call : producer.request.call;
  if (!ref(call) || call.revision !== 1 || call.id !== callRecordId(project, body.requestId))
    fail('spend_source_invalid', at.id, 'call', 'The physical call names its exact prior E1 admission');
  const packet: Ref | null = om ? producer.request.packet : null;
  if (om && !ref(packet)) fail('spend_source_invalid', at.id, 'packet', 'Ordinary E4 retains its exact E2 packet');
  const entry = snapshot.histories.find(item => item.call.id === call.id), history = entry && { journal: entry.journal };
  let receipt: ReturnType<typeof readLateModelReceiptAt> | null = null;
  if (body.recovery) {
    const named = snapshot.late.find(item => same(item.call, at));
    if (!named) fail('spend_source_invalid', at.id, 'late', 'A recovered call explicitly names its late receipt or null in this cut');
    if (named.receipt) receipt = readLateModelReceiptAt(store, project, at, named.receipt);
  }
  const missing = store.get(call.id, call.revision) === null;
  if (missing) return { record, call, purpose: body.purpose as CallPurpose, packet, usage: null, missing };
  const admitted = take(readCall(store, project, call, history));
  if (admitted.value.purpose !== body.purpose) fail('spend_basis_invalid', at.id, 'purpose', 'Physical and E1 call purposes agree');
  let usage: TokenUsage | null;
  if (om) {
    const physical = take(readModelCallPhysical(store, { project, record: at }));
    usage = physical.transport?.usage ?? null;
  } else {
    const physical = readModelTransport(store, { project, record: at }, history);
    if (!physical.ok && physical.refusal.code === 'model_call_in_progress' && physical.refusal.at.target === at.id
      && physical.refusal.at.field === 'status') usage = null;
    else usage = take(physical).result.usage;
  }
  if (receipt) {
    usage = receipt.value.evidence.process === null ? null
      : take(readAdapterResponse({ requestId: body.requestId, process: receipt.value.evidence.process })).usage;
  }
  return { record, call, purpose: admitted.value.purpose, packet, usage, missing: false };
}

function derive(store: Store, snapshot: SpendSnapshot): SpendReport {
  const { project } = snapshot;
  const ledger = snapshot.ledger ? take(readCallLedgerAt(store, project, snapshot.ledger, snapshot.histories)) : null;
  if (!ledger && snapshot.histories.length) fail('spend_basis_invalid', callLedgerId(project), 'histories', 'No ledger rows exist for these historical contexts');
  const entries = ledger?.value.calls ?? [], physical = new Map<string, Physical>(), findings: Refusal[] = [], rows: SpendRow[] = [];
  for (const at of snapshot.calls) {
    const checked = physicalCall(store, snapshot, at);
    if (!checked) continue;
    if (physical.has(checked.call.id)) fail('spend_basis_invalid', at.id, 'call', 'One E1 identity cannot be charged for two physical calls');
    physical.set(checked.call.id, checked);
    if (checked.missing) {
      findings.push({ code: 'call_without_record', message: 'The OM physical call has no prior E1 record',
        at: { unit: 'F8.3', target: at.id, field: 'call', ref: checked.call }, route: 'producer' });
      rows.push({ call: null, physical: at, purpose: checked.purpose, questions: [], series: null, attempt: null, usage: null,
        settlement: 'missing', significance: unknownSignificance(), result: null });
    } else if (!entries.some(entry => entry.call.id === checked.call.id)) {
      fail('spend_basis_invalid', at.id, 'ledger', 'The selected ledger cut must contain this physical call admission');
    }
  }
  for (const item of snapshot.late) {
    const checked = [...physical.values()].find(itemPhysical => same(reference(itemPhysical.record), item.call));
    if (!checked || !same(reference(checked.record), item.call) || !checked.record.value.recovery)
      fail('spend_basis_invalid', item.call.id, 'late', 'A late receipt belongs to a recovered physical call of this exact cut');
  }
  for (const source of snapshot.significance) if (!entries.some(entry => same(entry.call, source.call)))
    fail('spend_basis_invalid', source.call.id, 'significance', 'Significance sources name exact E1 rows in the ledger cut');
  const usedSeries = new Set<string>();
  for (const entry of entries) {
    const sent = physical.get(entry.call.id);
    if (sent?.missing) fail('spend_basis_invalid', entry.call.id, 'call', 'A ledger entry must retain its admission');
    if (entry.status !== 'open' && sent && !same(entry.usage, sent.usage))
      fail('spend_basis_invalid', entry.call.id, 'usage', 'A closed E1 expense equals its checked physical or late receipt');
    if (entry.status === 'open') findings.push({ code: 'call_not_settled', message: 'The E1 call has not been closed with actual expense',
      at: { unit: 'F8.3', target: entry.call.id, field: 'usage', ref: entry.call }, route: 'producer' });
    const named = snapshot.series.find(at => at.id === entry.series.id);
    if (!named) fail('spend_source_invalid', entry.series.id, 'series', 'Every call names the exact result-series snapshot used by this report');
    usedSeries.add(named.id);
    rows.push({ call: entry.call, physical: sent ? reference(sent.record) : null, purpose: entry.purpose, questions: entry.gaps,
      series: entry.series, attempt: entry.attempt, usage: entry.usage ?? sent?.usage ?? null, settlement: entry.status,
      significance: significance(store, snapshot, entry, sent?.packet ?? null), result: attemptResult(store, project, entry, named) });
  }
  if (snapshot.series.some(at => !usedSeries.has(at.id))) fail('spend_basis_invalid', project, 'series', 'The result cut contains no unrelated series');
  rows.sort((a, b) => compare(a.call ?? a.physical, b.call ?? b.physical));
  return { scope: SPEND_REPORT_SCOPE, snapshot, rows, findings, totals: total(rows),
    byPurpose: Object.fromEntries(CALL_PURPOSES.map(purpose => [purpose, total(rows.filter(row => row.purpose === purpose))])) as Record<CallPurpose, SpendTotals> };
}

function attemptResult(store: Store, project: string, call: AnyCallLedgerEntry, at: Ref): SpendRow['result'] {
  const admitted = take(readAnySeriesAt(store, project, call.series)), series = take(readAnySeriesAt(store, project, at));
  const owner = (value: { owner?: unknown; block?: string }) => 'owner' in value ? value.owner : { kind: 'block', block: value.block };
  if (!same(owner(call), owner(admitted.value)) || !same(owner(call), owner(series.value)))
    fail('spend_basis_invalid', call.call.id, 'series', 'The call and both series snapshots have the same declared owner');
  if (series.id !== admitted.id || series.revision < admitted.revision)
    fail('spend_basis_invalid', at.id, 'series', 'The result snapshot belongs to the admitted series at or after admission');
  const find = (value: Sealed<AnyRepairSeries>) => [...value.inherited, ...value.attempts].find(item => item.ordinal === call.attempt);
  const before = find(admitted.value), attempt = find(series.value);
  if (!before || !attempt || !same(before.goal, attempt.goal) || before.outcome !== null && !same(before, attempt))
    fail('spend_basis_invalid', at.id, 'attempt', 'The result snapshot retains this exact admitted attempt and goal');
  if (['model-research', 'model-design'].includes(call.purpose) && !same(call.goal, attempt.goal))
    fail('spend_basis_invalid', call.call.id, 'goal', 'The ordinary call belongs to this attempt goal');
  const achieved = attempt.outcome?.achieved ?? [];
  if (achieved.length) {
    if ('owner' in series.value) fail('achievement_unconfirmed', at.id, 'achieved', 'No mechanism acceptance provider is declared');
    const confirmed = take(confirmResults(store, { project, block: series.value.block, target: at.id,
      goal: attempt.goal, accepting: refs(achieved.map(item => item.basis)), cancelling: [] }));
    const ordered = (items: readonly Achievement[]) => [...items].sort(compare);
    if (!same(ordered(confirmed.achieved), ordered(achieved))) fail('spend_basis_invalid', at.id, 'achieved', 'Every saved achievement is derived by its acceptance provider');
  }
  return achieved.length ? { series: at, attempt: call.attempt, verdict: attempt.verdict, achieved } : null;
}

function significance(store: Store, snapshot: SpendSnapshot, call: AnyCallLedgerEntry, packetRef: Ref | null): SpendSignificance {
  let source = snapshot.significance.find(item => same(item.call, call.call));
  const supplied = source;
  let assigned: readonly string[] | null = null;
  const proof: Ref[] = [];
  if (packetRef) {
    const packet = take(readQuestionPacket(store, { project: snapshot.project, record: packetRef }));
    const routes = take(readRoutes(store, { project: snapshot.project, record: packet.value.request.routes })).record;
    const derived: SpendSignificanceSource = { call: call.call, gaps: routes.value.request.gaps as GapReadRequest,
      obligations: packet.value.request.works?.ledger ?? null };
    source = derived;
    proof.push(packetRef, reference(routes));
    if (packet.value.request.works) {
      const body: unknown = packet.value.packet;
      if (!object(body) || !object(body.works) || !array(body.works.assigned) || !body.works.assigned.every((id: unknown) => typeof id === 'string'))
        fail('spend_source_invalid', packetRef.id, 'works.assigned', 'The checked work packet retains its assigned obligation set');
      assigned = body.works.assigned;
    }
  }
  if (!source) return unknownSignificance();
  const gaps = take(readGaps(store, source.gaps));
  const gapBasis = { sources: gaps.sources, records: refs(gaps.records.map(reference)) };
  if (packetRef && supplied) {
    const explicit = take(readGaps(store, supplied.gaps));
    if (!same(supplied.obligations, source.obligations)
      || !same({ sources: explicit.sources, records: refs(explicit.records.map(reference)) }, gapBasis))
      fail('spend_basis_invalid', call.call.id, 'significance', 'Explicit significance cannot replace the exact E2 source set');
  }
  if (gaps.sources.project !== snapshot.project) fail('spend_basis_invalid', call.call.id, 'gaps', 'Significance belongs to this project');
  const selected = new Map<string, Sealed<Revision<GapRecord>>>();
  for (const address of call.gaps) {
    const matching = gaps.records.filter(record => {
      const gap = record.value.gap;
      return address.field === gap.field && address.goal === gap.target && ('owner' in call
        ? address.id === gap.id && same(address.consumer, call.owner)
        : address.id === gap.target && typeof address.consumer === 'string' && gap.consumers.includes(address.consumer));
    });
    if (matching.length !== 1) fail('spend_basis_invalid', call.call.id, 'gaps', 'Every addressed question has one compatible proved D1 identity');
    selected.set(matching[0]!.id, matching[0]!);
  }
  const records = [...selected.values()];
  const blocks = new Set(records.flatMap(record => record.value.gap.consumers));
  const consumers = new Set(call.gaps.map(address => canonical(address.consumer)));
  const obligationIds = new Set(records.filter(record => record.value.gap.code === 'obligation_open')
    .map(record => `frame:${record.value.gap.target}`));
  let obligations: number | null = records.every(record => record.value.gap.code === 'obligation_open') ? obligationIds.size : null;
  if (source.obligations) {
    const basis = take(readOmObligationLedger(store, { project: snapshot.project, ledger: source.obligations }));
    if (!same(basis.record.value.request.gaps, gapBasis))
      fail('spend_basis_invalid', source.obligations.id, 'gaps', 'D7 and D1 must have the same exact full source set');
    const rows = assigned === null ? basis.handoff.obligations.filter(item => records.some(record => same(item.original.record, reference(record))))
      : basis.handoff.obligations.filter(item => assigned.includes(taskBindingId(JSON.parse(canonical(item)))));
    for (const item of rows) obligationIds.add(`d1:${item.obligation}`);
    obligations = obligationIds.size;
    proof.push(reference(basis.record), reference(basis.producer));
  }
  return { obligations, consumers: consumers.size, blocks: blocks.size,
    sources: refs([...proof, ...records.map(reference), source.gaps.sources.input, source.gaps.sources.graph, source.gaps.sources.horizon]) };
}

function total(rows: readonly SpendRow[]): SpendTotals {
  const known = rows.flatMap(row => row.usage === null ? [] : [row.usage]);
  const sum = (field: keyof TokenUsage): number | null => {
    if (known.some(usage => usage[field] === null)) return null;
    const value = known.reduce((amount, usage) => amount + usage[field]!, 0);
    if (!Number.isSafeInteger(value)) fail('spend_source_invalid', 'spend-report', field, 'A reported token total must remain an exact integer');
    return value;
  };
  return { calls: rows.length, measuredCalls: known.length, unmeasuredCalls: rows.length - known.length,
    reportedTokens: known.length ? { inputTokens: sum('inputTokens')!, outputTokens: sum('outputTokens')!,
      cachedInputTokens: sum('cachedInputTokens'), reasoningOutputTokens: sum('reasoningOutputTokens') } : null };
}

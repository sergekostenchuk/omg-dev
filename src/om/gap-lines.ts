import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { RefinementRelations } from '../graph/relations.js';
import type { Graph } from '../graph/model.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { gapId, prepareCurrentGaps, readGaps, type Gap, type GapReadRequest, type GapRecords } from './gaps.js';
import { readAcceptedFrame, type AcceptedFrameRequest } from './frame-accept.js';
import { readCandidate } from './frame-candidate.js';
import { prepareFrame, readFrame, type FrameObligation, type PreparedFrame, type FrameRequest } from './frame-obligations.js';
import { readAnySeriesAt, prepareSeriesLineAdmission, REPAIR_SERIES_KIND, type AttemptGoal, type RepairSeries } from './series.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import type { AcceptanceContext, Confirmation } from './achievements.js';
import { readResultIdentity } from './result-identity.js';
import { confirmAnswerGapClosure, type AnswerBasis } from './accepted-answer.js';
import { historicalProof, withHistoricalReads } from './input.js';

export const GAP_LINE_KIND = 'gap-line';
export const GAP_LINE_CODES = Object.freeze([
  'gap_line_duplicate', 'gap_line_invalid', 'pass_out_of_order', 'pass_conflict', 'closure_invalid',
  'closure_unconfirmed', 'closure_unsupported', 'gap_line_forged', 'input_stale',
] as const);
export interface GapLine {
  id: string; target: string; field: string;
  firstPass: number; lastPass: number; statePass: number; passes: number; reopened: number;
  status: 'open' | 'deferred' | 'closed'; scope?: 'absent';
  closedPass?: number; closedBy?: 'filled' | 'cancelled'; basis?: Ref;
}
export interface GapLineClosure { id: string; reason: 'filled' | 'cancelled'; basis: Ref }
export interface MergeLinesResult { lines: GapLine[]; refusals: Refusal[] }
export interface GapLineAttempt { series: Ref; attempt: number }
export interface GapClosureRequest extends GapLineClosure {
  acceptance: AcceptedFrameRequest | null;
  attempt: GapLineAttempt | null;
  answer?: AnswerBasis;
}
/** A project snapshot includes every line, even when the current D1 set is empty. */
export interface GapLinesRequest {
  project: string; previous: Ref | null; pass: number; gaps: GapReadRequest; closures: GapClosureRequest[];
}
export interface GapLinesRecord { project: string; request: GapLinesRequest; lines: GapLine[] }
export interface GapLinesReadRequest { project: string; record: Ref }
export interface PreparedGapLines {
  record: GapLinesRecord; existing: Revision<GapLinesRecord> | null; writes: Write[]; guards: Ref[]; references: Ref[];
}
interface ConfirmedClosureBase {
  attempt: { series: Ref; ordinal: number; block: string; goal: AttemptGoal } | null;
  references: Ref[]; guards: Ref[]; writes: Write[];
}
type ConfirmedGapClosure = ConfirmedClosureBase & (
  { kind: 'frame'; obligation: FrameObligation; acceptance: AcceptedFrameRequest }
  | { kind: 'answer'; key: string }
);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
const unique = (refs: readonly Ref[]): Ref[] => sorted([...new Map(refs.map(ref => [canonical(ref), ref])).values()]);
function invalid(field: string): never {
  throw new EngineError('gap_line_request_invalid', 'Gap lines need explicit well-formed inputs', { unit: 'F5.2', target: 'gap-lines', field });
}
class LineFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: string, target: string, field: string, message: string): never {
  const result = refused(code, message, { unit: 'F5.2', target, field }, 'producer');
  if (!result.ok) throw new LineFailure(result.refusal);
  throw new EngineError('gap_line_internal', 'A refusal unexpectedly succeeded');
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new LineFailure(result.refusal); return result.value; }
function run<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof LineFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function lineShape(value: unknown): value is GapLine {
  if (!object(value) || ![value['id'], value['target'], value['field']].every(text)
    || !['firstPass', 'lastPass', 'statePass', 'passes'].every(key => positive(value[key]))
    || !Number.isSafeInteger(value['reopened']) || Number(value['reopened']) < 0
    || !['open', 'deferred', 'closed'].includes(value['status'] as string)) return false;
  return (value['scope'] === undefined || value['scope'] === 'absent')
    && (value['closedPass'] === undefined || positive(value['closedPass']))
    && (value['closedBy'] === undefined || ['filled', 'cancelled'].includes(value['closedBy'] as string))
    && (value['basis'] === undefined || isRef(value['basis']));
}
function requirePure(previous: unknown, gaps: unknown, pass: unknown, closures: unknown): void {
  if (!Array.isArray(previous) || !Array.from(previous).every(lineShape)) invalid('previous');
  if (!Array.isArray(gaps) || !Array.from(gaps).every(gap => object(gap) && [gap['id'], gap['target'], gap['field']].every(text)
    && (gap['deferral'] === undefined || (object(gap['deferral']) && gap['deferral']['reason'] === 'outside_horizon'
      && gap['deferral']['until'] === 'horizon-entry' && Array.isArray(gap['deferral']['blocks'])
      && gap['deferral']['blocks'].every(text))))) invalid('gaps');
  if (!positive(pass)) invalid('pass');
  if (!Array.isArray(closures)) invalid('closures');
}
function checkLines(lines: readonly GapLine[]): void {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.id)) fail('gap_line_duplicate', line.id, 'previous', 'A previous line occurs twice');
    seen.add(line.id);
    if (line.id !== gapId(line.target, line.field) || line.firstPass > line.lastPass || line.lastPass > line.statePass
      || line.passes > line.lastPass - line.firstPass + 1 || line.reopened >= line.passes)
      fail('gap_line_invalid', line.id, 'history', 'The line identity and counters must describe its occurrences');
    if (line.status === 'closed') {
      if (!positive(line.closedPass) || line.closedPass > line.statePass || line.closedPass < line.lastPass
        || !['filled', 'cancelled'].includes(line.closedBy ?? '') || !isRef(line.basis) || line.scope !== undefined)
        fail('gap_line_invalid', line.id, 'closure', 'A closed line needs its closing pass and exact basis');
    } else if (line.closedPass !== undefined || line.closedBy !== undefined || line.basis !== undefined
      || (line.scope !== undefined && line.status !== 'deferred'))
      fail('gap_line_invalid', line.id, 'closure', 'An open or deferred line carries no closing event');
  }
}
/** Pure state transition. Content/authority of a closure is checked by its producer on the saved path below. */
export function mergeLines(previous: readonly GapLine[], gaps: readonly Gap[], pass: number,
  closures: readonly GapLineClosure[]): Sealed<MergeLinesResult> {
  requirePure(previous, gaps, pass, closures);
  try {
    checkLines(previous);
    const old = new Map(previous.map(line => [line.id, line])), current = new Map<string, Gap>(), closing = new Map<string, GapLineClosure>();
    for (const gap of gaps) {
      if (current.has(gap.id)) fail('gap_line_duplicate', gap.id, 'gaps', 'The current set contains the same gap twice');
      if (gap.id !== gapId(gap.target, gap.field)) fail('gap_line_invalid', gap.id, 'id', 'Gap identity is its target and field');
      current.set(gap.id, gap);
    }
    for (const closure of closures) {
      if (!object(closure) || !text(closure.id) || !['filled', 'cancelled'].includes(closure.reason) || !isRef(closure.basis))
        fail('closure_invalid', object(closure) && text(closure.id) ? closure.id : 'gap-lines', 'closures', 'A closure names its line, reason and exact basis');
      if (closing.has(closure.id)) fail('gap_line_duplicate', closure.id, 'closures', 'A line has one closure in a pass');
      if (!old.has(closure.id) || current.has(closure.id)) fail('closure_invalid', closure.id, 'closures', 'Only an existing, no longer present gap may close');
      closing.set(closure.id, closure);
    }
    if (previous.some(line => pass < line.statePass)) fail('pass_out_of_order', 'gap-lines', 'pass', 'A pass cannot undo a later processed state');
    const next: GapLine[] = [];
    for (const line of previous) {
      const gap = current.get(line.id), closure = closing.get(line.id);
      if (line.statePass === pass) {
        const repeated = gap ? line.status === (gap.deferral ? 'deferred' : 'open') && line.lastPass === pass && line.scope === undefined
          : closure ? line.status === 'closed' && line.closedBy === closure.reason && same(line.basis, closure.basis)
            : (line.status === 'closed' && line.closedPass !== pass) || (line.status === 'deferred' && line.scope === 'absent');
        if (!repeated) fail('pass_conflict', line.id, 'pass', 'The same pass cannot describe a different line state');
        next.push({ ...line }); continue;
      }
      if (gap) {
        next.push({ id: line.id, target: line.target, field: line.field, firstPass: line.firstPass, lastPass: pass, statePass: pass,
          passes: line.passes + 1, reopened: line.reopened + (line.status === 'closed' ? 1 : 0), status: gap.deferral ? 'deferred' : 'open' });
      } else if (closure) {
        if (line.status === 'closed' && !(line.closedBy === 'filled' && closure.reason === 'filled')
          && (line.closedBy !== closure.reason || !same(line.basis, closure.basis)))
          fail('closure_invalid', line.id, 'closures', 'Only a filled closure can receive another confirmed filling without reopening');
        next.push(line.status === 'closed' && line.closedBy === 'cancelled' ? { ...line, statePass: pass } : {
          ...line, statePass: pass, status: 'closed', closedPass: pass, closedBy: closure.reason, basis: closure.basis,
        });
        delete next[next.length - 1]!.scope;
      } else if (line.status === 'closed') next.push({ ...line, statePass: pass });
      else next.push({ ...line, statePass: pass, status: 'deferred', scope: 'absent' });
    }
    for (const gap of gaps) if (!old.has(gap.id)) {
      if (previous.some(line => line.statePass === pass)) fail('pass_conflict', gap.id, 'pass', 'An already processed pass cannot gain another line');
      next.push({ id: gap.id, target: gap.target, field: gap.field, firstPass: pass, lastPass: pass, statePass: pass,
        passes: 1, reopened: 0, status: gap.deferral ? 'deferred' : 'open' });
    }
    return sealed({ lines: sorted(next), refusals: [] });
  } catch (error) {
    if (error instanceof LineFailure) return sealed({ lines: [...previous], refusals: [error.refusal] });
    throw error;
  }
}
export function gapLinesNamespace(project: string): string {
  if (!text(project)) invalid('project');
  return `om-gap-lines:${project}:`;
}
export function gapLinesId(project: string): string { return `${gapLinesNamespace(project)}history`; }
/** This is a goal address, not the semantic key of an achieved result. */
export function gapLineKey(project: string, target: string, field: string): string {
  if (![project, target, field].every(text)) invalid('line');
  return `om-gap-line:${project}:${gapId(target, field)}`;
}
export const GAP_LINE_EXPECTED_RESULT = 'accepted-gap-fill';
/** A package names its exact line addresses in goal.questions and this expected result. */
export function gapLineExpectedResult(project: string, target: string, field: string): string {
  gapLineKey(project, target, field);
  return GAP_LINE_EXPECTED_RESULT;
}
function requireRequest(store: Store, value: unknown): asserts value is GapLinesRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(value) || !text(value['project']) || !positive(value['pass'])
    || !(value['previous'] === null || isRef(value['previous'])) || !object(value['gaps'])
    || !object(value['gaps']['sources']) || value['gaps']['sources']['project'] !== value['project']
    || !Array.isArray(value['gaps']['records']) || !Array.from(value['gaps']['records']).every(isRef)
    || !Array.isArray(value['closures'])) invalid('request');
  for (const closure of value['closures']) {
    const acceptance = object(closure) ? closure['acceptance'] : null;
    if (!object(closure) || !text(closure['id']) || !['filled', 'cancelled'].includes(closure['reason'] as string)
      || !isRef(closure['basis']) || !(closure['attempt'] === null || (object(closure['attempt'])
        && isRef(closure['attempt']['series']) && positive(closure['attempt']['attempt'])))
      || !(acceptance === null || (object(acceptance) && text(acceptance['project'])
        && [2, 3].includes(acceptance['level'] as number)
        && ['graph', 'layer', 'frame'].every(key => isRef(acceptance[key]))))) invalid('closures');
    if ('answer' in closure) {
      const answer = closure['answer'];
      if (!object(answer) || !(
        isRef(answer['record']) && !('pending' in answer)
        || !('record' in answer) && object(answer['pending']) && text(answer['pending']['id'])
          && text(answer['pending']['kind']) && answer['pending']['expected'] === 0
          && 'value' in answer['pending'] && answer['pending']['value'] !== undefined
      )) invalid('closures.answer');
    }
  }
}
function normalize(request: GapLinesRequest): GapLinesRequest {
  // Only sets owned by the source contract are order-insensitive. Validation remains D1's.
  const proposals = (value: unknown): unknown => object(value) && Array.isArray(value['proposals'])
    ? { ...value, proposals: sorted(value['proposals']) } : value;
  const sources = request.gaps.sources;
  try {
    return sealed({ ...request, gaps: { sources: { ...sources,
      operations: proposals(sources.operations), works: proposals(sources.works),
    }, records: sorted(request.gaps.records) }, closures: sorted(request.closures.map(closure => {
      if (closure.answer && 'pending' in closure.answer) {
        const pending = closure.answer.pending;
        // Validate JSON before hashing so malformed pending content keeps this boundary's addressed error.
        const value = sealed(pending.value);
        return { ...closure, answer: { record: { id: pending.id, revision: pending.expected + 1, hash: hashJson(value) } } };
      }
      return closure;
    })) }) as GapLinesRequest;
  } catch (error) {
    if (error instanceof EngineError && error.code === 'unsealable_value') invalid('request.json');
    throw error;
  }
}
function head(store: Store, ref: Ref): void {
  const row = store.get(ref.id);
  if (!row || !same(reference(row), ref)) fail('input_stale', ref.id, 'reference', 'A current prerequisite has changed');
}
function guardsOf(refs: readonly Ref[]): Ref[] {
  const result = new Map<string, Ref>();
  for (const ref of refs) {
    const old = result.get(ref.id);
    if (old && !same(old, ref)) fail('input_stale', ref.id, 'guards', 'The sources name different current revisions');
    result.set(ref.id, ref);
  }
  return sorted([...result.values()]);
}
interface History {
  row: Revision<GapLinesRecord>; gaps: GapRecords; closures: ConfirmedGapClosure[];
  previous: History | null; references: Ref[];
}
function historyReferences(history: History | null): Ref[] {
  const refs: Ref[] = [];
  for (let entry = history; entry; entry = entry.previous) refs.push(...entry.references);
  return unique(refs);
}
function oldGap(history: History | null, id: string): { gap: Gap; history: History } | null {
  for (let entry = history; entry; entry = entry.previous) {
    const gap = entry.gaps.collection.gaps.find(item => item.id === id);
    if (gap) return { gap, history: entry };
  }
  return null;
}
function seriesGoal(store: Store, project: string, line: GapLine, link: GapLineAttempt | null, current: boolean): ConfirmedGapClosure['attempt'] {
  if (link === null) return null;
  const exact = take(readRecord<RepairSeries>(store, link.series, { unit: 'F5.2', target: line.id,
    idPrefix: `repair-series:${project}:`, kind: REPAIR_SERIES_KIND }));
  if (!object(exact.value) || !text(exact.value.block) || !positive(exact.value.line))
    fail('closure_unconfirmed', line.id, 'attempt', 'The named attempt needs a readable series');
  // A3 remains the sole validator of its history: the exact saved revision is checked by its own exact reader (S1.1,
  // №1878), never through a view substituting the head — such a view proved nothing again on every path to this line.
  const checked = take(readAnySeriesAt(store, project, link.series)) as Revision<RepairSeries>;
  if (!same(reference(checked), link.series)) fail('closure_unconfirmed', line.id, 'attempt.series', 'The attempt must belong to this exact series');
  if ('owner' in checked.value || checked.value.block !== exact.value.block || checked.value.line !== exact.value.line)
    fail('closure_unconfirmed', line.id, 'attempt', 'The named attempt needs a readable series');
  const attempt = checked.value.attempts.find(item => item.ordinal === link.attempt);
  if (!attempt || attempt.outcome !== null || !attempt.goal.questions.includes(gapLineKey(project, line.target, line.field))
    || attempt.goal.result !== gapLineExpectedResult(project, line.target, line.field))
    fail('closure_unconfirmed', line.id, 'attempt.goal', 'The result must have been named in a running attempt before it was closed');
  if (current) head(store, link.series);
  return { series: link.series, ordinal: link.attempt, block: checked.value.block, goal: attempt.goal as AttemptGoal };
}
function substantive(obligation: FrameObligation): Omit<FrameObligation, 'zone'> {
  const { zone: _zone, ...value } = obligation; return value;
}
function closureFrame(gaps: GapReadRequest, level: 2 | 3, line: string): FrameRequest {
  const source = level === 2 ? gaps.sources.operations : gaps.sources.works;
  if ('state' in source) fail('closure_unconfirmed', line, 'acceptance', 'A work filling needs its exact saved work-frame context');
  return source.frame;
}
/** One content verifier serves preparation, historical re-derivation, and the acceptance provider. */
function confirmClosure(store: Store, project: string, line: GapLine, closure: GapClosureRequest,
  previous: History | null, gaps: GapReadRequest, current: boolean): ConfirmedGapClosure {
  if (closure.reason === 'cancelled') fail('closure_unsupported', line.id, 'reason', 'Cancellation requires the H2 owner-decision producer');
  if (closure.answer) {
    const source = oldGap(previous, line.id);
    if (!source || closure.acceptance !== null)
      fail('closure_unconfirmed', line.id, 'answer', 'An answer closure names its preceding gap and one accepting producer');
    const basis = 'record' in closure.answer ? closure.answer.record : {
      id: closure.answer.pending.id, revision: closure.answer.pending.expected + 1, hash: hashJson(closure.answer.pending.value),
    };
    if (!same(closure.basis, basis)) fail('closure_unconfirmed', line.id, 'basis', 'An answer closure must name the exact confirmed answer');
    const answer = take(confirmAnswerGapClosure(store, { project, basis: closure.answer, target: line.target, field: line.field,
      prior: source.history.row.value.request.gaps, current: gaps, attempt: closure.attempt, currentOnly: current }));
    return { kind: 'answer', key: answer.key, attempt: answer.attempt,
      references: [...answer.references], guards: [...answer.guards], writes: [...answer.writes] };
  }
  if (closure.acceptance === null || closure.acceptance.project !== project || !same(closure.basis, closure.acceptance.frame))
    fail('closure_unconfirmed', line.id, 'acceptance', 'A filled line names its exact accepted connection frame and its source context');
  // The exact accepting producer chooses the source contract; there is no fallback between levels.
  const level = closure.acceptance.level, origin = level === 2 ? 'operations' : 'works';
  const context = closureFrame(gaps, level, line.id);
  // Historical delivery still belongs to its saved D1 context; only head freshness is conditional.
  if (context.project !== closure.acceptance.project || context.level !== closure.acceptance.level
    || !same(context.graph, closure.acceptance.graph) || !same(context.layer, closure.acceptance.layer)
    || !same(context.frame, closure.acceptance.frame))
    fail('closure_unconfirmed', line.id, 'acceptance', 'The saved D1 context must use this exact accepted filling');
  const source = oldGap(previous, line.id);
  if (!source || source.gap.field !== 'fill' || !source.gap.evidence.some(item => item.origin === origin))
    fail('closure_unsupported', line.id, 'basis', level === 2
      ? 'This producer confirms operation-frame fillings; other kinds need their own accepting producer'
      : 'This producer confirms work-frame fillings from the exact preceding D1 context');
  const accepted = take(readAcceptedFrame(store, closure.acceptance));
  if (!accepted.graph || !accepted.frame || !accepted.layer) fail('closure_unconfirmed', line.id, 'basis', 'A filled line needs an accepted graph, layer and frame');
  const candidate = take(readCandidate(store, { project, candidate: accepted.frame.value.acceptance.candidate }));
  const frameRequest: FrameRequest = { ...candidate.value.request.frame, graph: closure.acceptance.graph,
    layer: closure.acceptance.layer, frame: closure.acceptance.frame };
  const frame = take(readFrame(store, frameRequest));
  let fresh: Sealed<PreparedFrame> | null = null;
  if (current) {
    // The accepting candidate horizon is historical; current admission uses D1's current frame context.
    fresh = take(prepareFrame(store, context));
  }
  const previousFrame = take(readFrame(store, closureFrame(source.history.row.value.request.gaps, level, line.id)));
  const before = previousFrame.result.obligations.find(item => item.id === line.target);
  const obligation = frame.result.obligations.find(item => item.id === line.target);
  const fills = frame.result.fills.filter(item => item.obligation === line.target);
  if (!before || !obligation || !same(substantive(before as FrameObligation), substantive(obligation as FrameObligation))
    || obligation.zone !== 'horizon' || frame.result.open.some(item => item.id === line.target)
    || !fills.length || fills.some(fill => fill.source !== 'accepted'))
    fail('closure_unconfirmed', line.id, 'fill', 'The same obligation must be fully filled by accepted real definitions, not identities or a changed requirement');
  const attempt = seriesGoal(store, project, line, closure.attempt, current);
  const admission = current && attempt ? take(prepareSeriesLineAdmission(store, project, attempt.series)).guards : [];
  const belongs = !attempt || (level === 2 ? attempt.block === obligation.upper.node
    : source.gap.consumers.includes(attempt.block)
      && frame.upper.nodes.some(node => node.id === attempt.block && node.kind === 'block')
      && new RefinementRelations(frame.upper as Graph).refines(obligation.upper.node, attempt.block));
  if (!belongs)
    fail('closure_unconfirmed', line.id, 'attempt.block', 'The recorded goal belongs to the block whose gap was filled');
  return { kind: 'frame', obligation: obligation as FrameObligation, acceptance: closure.acceptance, attempt, writes: [], references: unique([...frame.references, ...previousFrame.references, closure.basis,
      closure.acceptance.graph, closure.acceptance.layer, ...(attempt ? [attempt.series] : [])]),
    guards: fresh ? guardsOf([...fresh.guards,
      ...admission]) : [] };
}
function loadHistory(store: Store, project: string, ref: Ref): History {
  return historicalProof(store, { reader: 'D2.loadHistory', project, ref }, store => deriveHistory(store, project, ref),
    () => fail('gap_line_forged', ref.id, 'previous', 'A historical line cannot depend cyclically on itself'));
}
function deriveHistory(store: Store, project: string, ref: Ref): History {
  const row = take(readRecord<GapLinesRecord>(store, ref, { unit: 'F5.2', target: ref.id, id: gapLinesId(project), kind: GAP_LINE_KIND })) as Revision<GapLinesRecord>;
  const value = row.value;
  if (!object(value) || value.project !== project || !Array.isArray(value.lines) || !value.lines.every(lineShape))
    fail('gap_line_forged', row.id, 'record', 'A line snapshot needs its complete source request and derived lines');
  try { requireRequest(store, value.request); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'gap_line_request_invalid') fail('gap_line_forged', row.id, 'request', 'The saved source request is malformed');
    throw error;
  }
  if (value.request.project !== project || !same(value.request, normalize(value.request)) || row.hash !== hashJson(value))
    fail('gap_line_forged', row.id, 'request', 'The saved source request must be canonical and project-bound');
  const previousRef = value.request.previous;
  if (row.revision === 1 ? previousRef !== null : previousRef === null || previousRef.id !== row.id || previousRef.revision !== row.revision - 1)
    fail('gap_line_forged', row.id, 'previous', 'A snapshot must include every preceding line through its exact preceding revision');
  const previous = previousRef ? loadHistory(store, project, previousRef) : null;
  if (previous && value.request.pass <= previous.row.value.request.pass)
    fail('gap_line_forged', row.id, 'pass', 'Saved passes must strictly advance');
  const gaps = take(readGaps(store, value.request.gaps)) as GapRecords;
  const merged = mergeLines(previous?.row.value.lines ?? [], gaps.collection.gaps, value.request.pass, value.request.closures);
  if (merged.refusals.length) throw new LineFailure(merged.refusals[0]!);
  if (!same(merged.lines, value.lines)) fail('gap_line_forged', row.id, 'lines', 'The full set and every state must follow from saved sources and prior lines');
  const closures = value.request.closures.map(closure => confirmClosure(store, project,
    value.lines.find(line => line.id === closure.id)!, closure, previous, value.request.gaps, false));
  return { row, gaps, closures, previous, references: unique([ref,
    ...value.request.gaps.records, ...closures.flatMap(item => item.references)]) };
}
export function readGapLines(store: Store, request: GapLinesReadRequest): OmResult<Sealed<Revision<GapLinesRecord>>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('read');
  return run(() => loadHistory(store, request.project, request.record).row);
}
export function prepareGapLines(store: Store, request: GapLinesRequest): OmResult<Sealed<PreparedGapLines>> {
  requireRequest(store, request);
  // Pending answers are verified by D5 before inclusion in the transaction. Saved history only names exact records.
  const suppliedClosures = request.closures;
  request = normalize(request);
  return run(() => {
    const latest = store.get<GapLinesRecord>(gapLinesId(request.project));
    const previous = latest ? loadHistory(store, request.project, reference(latest)) : null;
    // Exact old deliveries are history, never a command to overwrite the current state.
    for (let item = previous; item; item = item.previous) if (item.row.value.request.pass === request.pass) {
      if (!same(item.row.value.request, request)) fail('pass_conflict', item.row.id, 'request', 'A recorded pass cannot be changed');
      return { record: item.row.value, existing: item.row, writes: [], guards: [reference(latest!)], references: historyReferences(item) };
    }
    if (previous && request.pass < previous.row.value.request.pass) fail('pass_out_of_order', latest!.id, 'pass', 'A delayed pass cannot replace later states');
    if (!same(request.previous, latest ? reference(latest) : null)) fail('input_stale', gapLinesId(request.project), 'previous', 'A pass names the state it advances');
    const gaps = take(readGaps(store, request.gaps));
    const fresh = take(prepareCurrentGaps(store, request.gaps));
    const merged = mergeLines(previous?.row.value.lines ?? [], gaps.collection.gaps as Gap[], request.pass, request.closures);
    if (merged.refusals.length) throw new LineFailure(merged.refusals[0]!);
    const closures = suppliedClosures.map(closure => confirmClosure(store, request.project,
      merged.lines.find(line => line.id === closure.id)! as GapLine, closure, previous, request.gaps, true));
    const record: GapLinesRecord = { project: request.project, request, lines: merged.lines as GapLine[] };
    const guards = guardsOf([...(latest ? [reference(latest)] : []), ...fresh.guards, ...request.gaps.records,
      ...closures.flatMap(item => item.guards)]);
    for (const ref of guards) head(store, ref);
    const pending = new Map<string, Write>();
    for (const write of closures.flatMap(item => item.writes)) {
      const other = pending.get(write.id);
      if (other && !same(other, write)) fail('closure_invalid', write.id, 'answer', 'A shared transaction cannot contain conflicting answer records');
      pending.set(write.id, write);
    }
    return { record, existing: null, writes: [{ id: gapLinesId(request.project), kind: GAP_LINE_KIND, expected: latest?.revision ?? 0, value: record }, ...pending.values()],
      guards, references: unique([...historyReferences(previous), ...fresh.references, ...request.gaps.records,
        ...closures.flatMap(item => item.references)]) };
  });
}
export function writeGapLines(store: Store, request: GapLinesRequest): OmResult<Sealed<Revision<GapLinesRecord>>> {
  requireRequest(store, request);
  return run(() => {
    const prepared = take(prepareGapLines(store, request));
    if (prepared.existing) return prepared.existing as Revision<GapLinesRecord>;
    return take(writeGuarded<GapLinesRecord>(store, { unit: 'F5.2', target: gapLinesId(request.project), writes: prepared.writes, guards: prepared.guards }))[0]! as Revision<GapLinesRecord>;
  });
}
/** Closure authority and the goal are D2's; semantic identity is shared with every result supplier. */
export function confirmGapLineResult(record: Sealed<Revision<Json>>, context: AcceptanceContext, store: Store): Confirmation {
  if (!(store instanceof Store)) invalid('store');
  if (!object(record) || !isRef(record) || !text(record.kind)) invalid('record');
  if (!object(context) || !text(context.project) || !text(context.block) || !object(context.goal)
    || !text(context.goal.key) || !text(context.goal.result) || !Array.isArray(context.goal.questions)
    || !Array.from(context.goal.questions).every(text)) invalid('context');
  const result = run(() => {
    const history = loadHistory(store, context.project, reference(record));
    const closures = history.closures.filter(closure => closure.attempt !== null && closure.attempt.block === context.block
      && same({ ...closure.attempt.goal, questions: sorted(closure.attempt.goal.questions) },
        { ...context.goal, questions: sorted(context.goal.questions) }));
    if (!closures.length) fail('closure_unconfirmed', record.id, 'attempt', 'No filled closure in this event belongs to the previously recorded full goal');
    return closures.map(closure => closure.kind === 'answer' ? closure.key
      : take(readResultIdentity(store, { acceptance: closure.acceptance, obligation: closure.obligation.id })).key);
  });
  return result.ok ? { keys: result.value } : { unconfirmed: `${result.refusal.code}: ${result.refusal.message}` };
}

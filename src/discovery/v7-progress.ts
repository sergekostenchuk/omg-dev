import { canonical, hashJson, HASH_RE } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { DISCOVERY_ASSESSMENT_CONTRACT_V3, type PaidDiscoveryAttemptsAssessment,
  V7_PROGRESS_BASELINE_CONTRACT, type V7ProgressBaseline, type V7ProgressState, type V7ProgressApplication,
  type V7AttemptAccount, type V7ProgressEvent, type V7ProgressSubject, type V7ProgressSummary } from './research-model.js';
import type { Store, Revision, Write, TransactionGuard } from '../storage/store.js';
import { historicalProof, pendingSnapshotView, withHistoricalReads } from '../history/proofs.js';
import { closureFactClaims, requireMethodologyClosure } from './assessment-methodology.js';
import { proveClaimAddress, resolveClaimAddress, type ClaimAddress } from './claim-address.js';
import { readDiscoveryAssessment } from './research-assessment.js';
import { readResearchConsumerTurn } from './response-recovery.js';
import { managedTurnId } from './research-consumer-transition.js';
import { attemptAccountKey, progressEventKey, v7ProgressStateId, baselineGuards, checkDiscoveryAssessmentForm,
  claimContentKey, constraintContentKey, transitionContentKey, type V7AssessmentSubject } from './v7-attempt-assessment.js';
import { V7_ATTEMPT_KIND } from './v7-contracts.js';

export type V7ProgressCounters = Pick<V7ProgressSummary, 'cursor' | 'count' | 'streak'>;
export interface V7FoldAttempt { attempt: Ref; number: number; contentKeys: readonly string[] }
export interface V7ProgressFoldInput {
  subject: V7ProgressSubject;
  run: string;
  previous: { subject: V7ProgressSubject; counters: V7ProgressCounters } | null;
  attempts: readonly V7FoldAttempt[];
  /** Exact accounts and content keys already proven by the caller. These are
   * only the relevant inputs, not an instruction to scan a previous history. */
  accounted: readonly Ref[];
  knownContentKeys: readonly string[];
}
export interface V7ProgressFold {
  counters: V7ProgressCounters;
  stalled: boolean;
  fresh: { attempt: Ref; number: number; contentKeys: string[]; streak: number }[];
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function invalid(field: string, reason: string): never {
  throw new EngineError('discovery_progress_order_invalid', `[${field}] ${reason}`, { field, reason });
}
function shape(v: unknown, keys: readonly string[], field: string): asserts v is Record<string, unknown> {
  if (!obj(v) || Object.keys(v).length !== keys.length || !keys.every(key => Object.hasOwn(v, key)))
    invalid(field, 'The fold requires its explicit contracted inputs');
}
function subject(v: unknown, field: string): asserts v is V7ProgressSubject {
  shape(v, ['project', 'planAnswer', 'planQuestionId'], field);
  if (!text(v.project) || !isRef(v.planAnswer) || !text(v.planQuestionId)) invalid(field, 'An exact plan-question subject is required');
}
function counters(v: unknown, run: string): asserts v is V7ProgressCounters {
  const at = 'previous.counters';
  shape(v, ['cursor', 'count', 'streak'], at);
  if (!Number.isSafeInteger(v.count) || (v.count as number) < 0 || !Number.isSafeInteger(v.streak)
    || (v.streak as number) < 0 || (v.streak as number) > (v.count as number)) invalid(at, 'Counters are nonnegative safe integers and streak cannot exceed count');
  if (v.cursor === null) {
    if (v.count !== 0 || v.streak !== 0) invalid(`${at}.cursor`, 'A nonempty prefix needs its exact cursor');
    return;
  }
  shape(v.cursor, ['run', 'number'], `${at}.cursor`);
  if (v.cursor.run !== run || !Number.isSafeInteger(v.cursor.number) || (v.cursor.number as number) < (v.count as number)
    || v.count === 0) invalid(`${at}.cursor`, 'The prefix cursor belongs to this run and covers its counted attempts');
}
function keys(v: unknown, field: string): asserts v is string[] {
  if (!Array.isArray(v)) invalid(field, 'Content keys are an explicit list');
  for (const key of v) if (typeof key !== 'string' || !HASH_RE.test(key))
    invalid(field, 'Content keys are exact hashes, including an explicit empty list');
}

/** P.1 extracts the ordered counting/deduplication loop. The caller proves the
 * paid assessment, exact attempt order, previous state, accounts and keys.
 * This function performs no reads/writes and grants no acceptance or dispatch.
 * Semantic duplicate claims are omitted from the supplied contentKeys by that
 * proven classification; equal code keys are additionally deduplicated here. */
export function foldV7Progress(input: V7ProgressFoldInput): V7ProgressFold {
  shape(input, ['subject', 'run', 'previous', 'attempts', 'accounted', 'knownContentKeys'], 'input');
  subject(input.subject, 'subject');
  if (!text(input.run)) invalid('run', 'The ordered managed run is required');
  let before: V7ProgressCounters = { cursor: null, count: 0, streak: 0 };
  if (input.previous !== null) {
    shape(input.previous, ['subject', 'counters'], 'previous');
    subject(input.previous.subject, 'previous.subject');
    if (canonical(input.previous.subject) !== canonical(input.subject)) invalid('previous.subject', 'Another project, plan edition or question has its own counters');
    counters(input.previous.counters, input.run);
    before = input.previous.counters;
  }
  if (!Array.isArray(input.attempts)) invalid('attempts', 'Attempts are an explicit list');
  if (!Array.isArray(input.accounted)) invalid('accounted', 'Reused accounts are an explicit list');
  keys(input.knownContentKeys, 'knownContentKeys');
  if ((!input.previous || before.count === 0) && (input.accounted.length || input.knownContentKeys.length))
    invalid('previous', 'There are no prior accounts or progress keys without a counted predecessor');
  const rows = new Map<string, V7FoldAttempt>(), ids = new Set<string>();
  let last = 0;
  for (const [i, row] of input.attempts.entries()) {
    const at = `attempts.${i}`;
    shape(row, ['attempt', 'number', 'contentKeys'], at);
    if (!isRef(row.attempt) || !Number.isSafeInteger(row.number) || (row.number as number) <= last)
      invalid(at, 'Attempts retain strictly ascending proven managed positions and exact references');
    keys(row.contentKeys, `${at}.contentKeys`);
    if (ids.has(row.attempt.id)) invalid(`${at}.attempt`, 'One immutable attempt occurs once in a packet');
    ids.add(row.attempt.id); rows.set(canonical(row.attempt), row as unknown as V7FoldAttempt); last = row.number as number;
  }
  const accounted = new Set<string>();
  for (const [i, ref] of input.accounted.entries()) {
    if (!isRef(ref)) invalid(`accounted.${i}`, 'A reused account names an exact attempt');
    const key = canonical(ref), row = rows.get(key);
    if (!row || accounted.has(key) || !before.cursor || row.number > before.cursor.number)
      invalid(`accounted.${i}`, 'Only unique exact prior accounts of this packet and saved prefix may be reused');
    accounted.add(key);
  }
  const seen = new Set(input.knownContentKeys), fresh: V7ProgressFold['fresh'] = [];
  const after = structuredClone(before);
  for (const row of input.attempts) {
    if (accounted.has(canonical(row.attempt))) continue;
    if (row.number <= (before.cursor?.number ?? 0)) invalid('cursor', 'An unaccounted attempt cannot precede the saved prefix');
    const emitted: string[] = [];
    for (const key of row.contentKeys) if (!seen.has(key)) { seen.add(key); emitted.push(key); }
    after.count++;
    after.streak = emitted.length ? 0 : after.streak + 1;
    after.cursor = { run: input.run, number: row.number };
    fresh.push({ attempt: { ...row.attempt }, number: row.number, contentKeys: emitted, streak: after.streak });
  }
  return { counters: after, stalled: after.streak >= 3, fresh };
}

export interface V7MethodologyOrigin { claim: ClaimAddress; assessment: Ref }
export interface V7AssessmentClosure {
  assessment: Ref;
  transition: PaidDiscoveryAttemptsAssessment['novelty']['transition'];
  methodologyOrigins: V7MethodologyOrigin[];
}
function closureInvalid(field: string, reason: string): never {
  throw new EngineError('discovery_novelty_invalid', `[${field}] ${reason}`, { field, reason });
}
/** P.2 checks methodological conditions, not acceptance or permission to apply
 * closed. MR.5 re-derives each paid terminal through the common form checker.
 * P.3/P.4 must prove external claims accepted and match every historical origin
 * to the assessment of that exact accepted application, rather than substitute
 * a different, more favourable paid reassessment. No heads are searched here. */
export function checkV7AssessmentClosure(store: Store, project: string, assessment: Ref,
  origins: readonly V7MethodologyOrigin[]): V7AssessmentClosure {
  const paid = readDiscoveryAssessment(store, project, assessment).value;
  const transition = paid.novelty.transition, at = 'transition.sufficiency.methodologyRequirements';
  if (transition?.outcome === 'closed' && paid.contract !== DISCOVERY_ASSESSMENT_CONTRACT_V3)
    closureInvalid(at, 'A new closed requires explicit paid v3 requirements, including an empty list without facts; historical v2 supplies no defaults');
  const requirements = paid.contract === DISCOVERY_ASSESSMENT_CONTRACT_V3 && transition?.outcome === 'closed'
    ? paid.novelty.transition!.sufficiency!.methodologyRequirements : [];
  if (!Array.isArray(origins)) closureInvalid('methodologyOrigins', 'Historical methodology origins are an explicit list');
  const selected = new Map<string, { origin: V7MethodologyOrigin; field: string }>();
  for (const [i, origin] of origins.entries()) {
    const field = `methodologyOrigins.${i}`;
    if (!obj(origin) || Object.keys(origin).length !== 2 || !['claim','assessment'].every(key => Object.hasOwn(origin, key)) || !isRef(origin.assessment))
      closureInvalid(field, 'An origin names exactly its claim and exact paid assessment Ref');
    const claim = origin.claim;
    if (!obj(claim) || Object.keys(claim).length !== 5
      || !['project','container','containerKind','pointer','claimId'].every(key => Object.hasOwn(claim, key)) || claim.project !== project || !isRef(claim.container)
      || !text(claim.containerKind) || !text(claim.pointer) || !text(claim.claimId))
      closureInvalid(`${field}.claim`, 'The origin carries the full exact claim address of this project');
    const key = canonical(claim);
    if (selected.has(key)) closureInvalid(`${field}.claim`, 'A historical fact has exactly one methodology origin');
    const requirement = requirements.find(row => canonical(row.claim) === key);
    if (!requirement || paid.methodology.facts.some(fact => canonical(fact.claim) === key))
      closureInvalid(`${field}.claim`, 'Origins name only required external facts, never extra or current claims');
    selected.set(key, { origin: { claim: requirement.claim, assessment: { ...origin.assessment } }, field });
  }
  const sources = new Map<string, PaidDiscoveryAttemptsAssessment>(), used: V7MethodologyOrigin[] = [];
  for (const [i, row] of requirements.entries()) {
    const field = `${at}.${i}`, key = canonical(row.claim);
    let fact = paid.methodology.facts.find(item => canonical(item.claim) === key), ref = assessment;
    if (!fact) {
      const entry = selected.get(key);
      if (!entry) closureInvalid(`${field}.claim`, 'The external closing fact needs its explicit original paid methodology');
      ref = entry.origin.assessment;
      let original = sources.get(canonical(ref));
      if (!original) {
        try { original = readDiscoveryAssessment(store, project, ref).value; }
        catch (error) {
          if (error instanceof EngineError) closureInvalid(`${entry.field}.assessment`, `The selected paid methodology is not provable: ${error.message}`);
          throw error;
        }
        sources.set(canonical(ref), original);
      }
      if (!original.novelty.accepted.some(item => canonical(item.claim) === key))
        closureInvalid(`${entry.field}.claim`, 'The selected paid assessment does not classify this exact fact as accepted');
      fact = original.methodology.facts.find(item => canonical(item.claim) === key);
      if (!fact) closureInvalid(`${entry.field}.claim`, 'The selected paid assessment lacks this exact fact methodology');
    }
    requireMethodologyClosure(fact, row, field);
    used.push({ claim: structuredClone(row.claim), assessment: { ...ref } });
  }
  return { assessment: { ...assessment }, transition: structuredClone(transition), methodologyOrigins: used };
}

export const PROGRESS_APPLICATION_KIND = 'v7-progress-application';
export const ATTEMPT_ACCOUNT_KIND = 'v7-attempt-account';
export const PROGRESS_EVENT_KIND = 'research-progress-event';
const STATE_KIND = 'v7-progress-state';
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const appId = (ref: Ref) => `v7-progress-application:${hashJson(ref)}`;
function fail(code: string, field: string, reason: string): never {
  throw new EngineError(code, `[${field}] ${reason}`, { field, reason });
}
function need(ok: unknown, field: string, reason: string): asserts ok {
  if (!ok) fail('discovery_progress_conflict', field, reason);
}
function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  const row = isRef(ref) ? store.get<T>(ref.id, ref.revision) : null;
  need(row && row.kind === kind && row.hash === ref.hash && hashJson(row.value) === ref.hash,
    kind, 'The exact historical record is absent, changed or foreign');
  return row;
}
function acceptedAt(a: PaidDiscoveryAttemptsAssessment, attempt: Ref): ClaimAddress[] {
  return a.novelty.accepted.filter(c => same(c.claim.container, attempt)).map(c => c.claim)
    .sort((x, y) => Number(x.pointer.slice(8)) - Number(y.pointer.slice(8)));
}
function predicted<T>(id: string, kind: string, revision: number, value: T): Revision<T> {
  return { id, kind, revision, hash: hashJson(value), value };
}
const initial = (): V7ProgressSummary => ({ cursor: null, count: 0, streak: 0, outcome: 'open',
  reason: null, nextAction: null });

/** Walk the actual run graph: ordinary paid addresses, the exact queue of a
 * planner and recursively split children. No list/number guess may substitute
 * a different turn for an unknown position. Historical application supplies
 * every selected revision; only the writer selects heads, protected by CAS. */
function progressPrefix(store: Store, run: string, last: number, saved?: Ref[]): Revision<Record<string, any>>[] {
  if (saved !== undefined) need(Array.isArray(saved) && saved.length === last && saved.every(isRef),
    'prefix', 'The application fixes one exact revision for every run position');
  const rows: Revision<Record<string, any>>[] = [], queued = new Map<number, Ref>();
  for (let n = 1; n <= last; n++) {
    const origin = queued.get(n), id = origin?.id ?? managedTurnId(run, n);
    const row = saved === undefined ? store.get<Record<string, any>>(id)
      : exact<Record<string, any>>(store, saved[n - 1]!, 'research-turn');
    need(row && row.id === id && row.kind === 'research-turn' && hashJson(row.value) === row.hash
      && row.value?.run === run && row.value.number === n,
      'prefix', 'The exact managed or queued position is missing, changed or substituted');
    if (origin) need(row.revision >= origin.revision, 'prefix', 'A queued position precedes its original revision');
    rows.push(row);
    for (const field of ['children', 'splitInto']) {
      const links = row.value.observation?.[field];
      if (links === undefined) continue;
      need(Array.isArray(links) && links.every(isRef), 'prefix', 'Queue and split links are exact references');
      for (const link of links as Ref[]) {
        const child = exact<Record<string, any>>(store, link, 'research-turn'), number = child.value?.number;
        need(child.value?.run === run && Number.isSafeInteger(number) && number > n,
          'prefix', 'A child belongs to a later exact position of this run');
        const known = queued.get(number);
        need(!known || same(known, link), 'prefix', 'Two queues cannot claim the same run position');
        queued.set(number, link);
      }
    }
  }
  return rows;
}

function orderedPrefix(store: Store, assessment: PaidDiscoveryAttemptsAssessment, before: V7ProgressSummary,
  fresh: readonly Ref[], rows: Revision<Record<string, any>>[]): void {
  const packet = checkDiscoveryAssessmentForm(store, assessment).packet;
  if (before.cursor && before.cursor.run !== packet.run)
    fail('discovery_progress_order_invalid', 'cursor.run', 'The subject cannot change its saved managed run');
  const start = before.cursor?.number ?? 0;
  if (packet.entries.some(e => fresh.some(ref => same(ref, reference(e.attempt.attempt))) && e.number <= start))
    fail('discovery_progress_order_invalid', 'cursor', 'An unaccounted attempt precedes the saved prefix');
  const included = new Set(packet.entries.map(e => e.original.id));
  for (const turn of rows) {
    readResearchConsumerTurn(store, reference(turn));
    if (turn.value.number <= start) continue;
    const subject = turn.value.subject;
    if (subject && same(subject.planAnswer, assessment.subject.packet.planAnswer)
      && subject.planQuestionId === assessment.subject.packet.planQuestionId
      && (turn.value.status !== 'completed' || turn.value.attemptContract && turn.value.action?.action === 'answer'
        && (!turn.value.attemptBinding || !included.has(turn.id))))
      fail('discovery_progress_order_invalid', 'packet', 'An earlier attempt of this subject is pending or omitted');
  }
}

/** Premises and baseline materials use the same public acceptance proof as
 * other consumers; an attempt retains its first atomic paid application. */
function acceptedPremise(store: Store, address: ClaimAddress): ReturnType<typeof proveAppliedAttemptClaim> | null {
  const proof = proveClaimAddress(store, address);
  return proof.kind === 'attempt' ? proof : null;
}
function methodology(store: Store, paid: Revision<PaidDiscoveryAttemptsAssessment>, reused: Revision<V7AttemptAccount>[]): V7MethodologyOrigin[] {
  const assessment = paid.value, transition = assessment.novelty.transition;
  const origins: V7MethodologyOrigin[] = [];
  if (transition?.outcome === 'closed') for (const claim of closureFactClaims(store, transition.bases, assessment.projectId)) {
    if (assessment.methodology.facts.some(fact => same(fact.claim, claim))) continue;
    const proof = acceptedPremise(store, claim);
    if (!proof) fail('discovery_novelty_invalid', 'methodologyOrigins', 'The accepted premise has no original paid attempts methodology');
    origins.push({ claim, assessment: reference(proof.assessment) });
  }
  const checked = checkV7AssessmentClosure(store, assessment.projectId, reference(paid), origins);
  // A covered attempt can occur in this packet again. Its new paid annotation
  // is not the original methodology of an already accepted fact.
  return checked.methodologyOrigins.map(origin => {
    if (!reused.some(account => same(account.value.attempt, origin.claim.container))) return origin;
    const proof = proveAppliedAttemptClaim(store, origin.claim);
    const original = proof.assessment.value.methodology.facts.find(fact => same(fact.claim, origin.claim));
    const requirement = assessment.contract === DISCOVERY_ASSESSMENT_CONTRACT_V3
      ? assessment.novelty.transition?.sufficiency?.methodologyRequirements.find(row => same(row.claim, origin.claim)) : null;
    if (!original || !requirement) fail('discovery_novelty_invalid', 'methodologyOrigins',
      'The reused fact requires its original accepted methodology and explicit closure requirement');
    requireMethodologyClosure(original, requirement, 'methodologyOrigins');
    return { claim: origin.claim, assessment: reference(proof.assessment) };
  });
}

interface Derived {
  application: Revision<V7ProgressApplication>; state: Revision<V7ProgressState>;
  accounts: Revision<V7AttemptAccount>[]; events: Revision<V7ProgressEvent>[];
}
/** The same projection builds the write batch and re-derives its immutable
 * receipts. Existing accounts/events are named exact inputs, never a scan. */
function project(store: Store, paid: Revision<PaidDiscoveryAttemptsAssessment>,
  previous: Revision<V7ProgressState> | null, reused: Revision<V7AttemptAccount>[], prior: Revision<V7ProgressEvent>[], prefix: Ref[]): Derived {
  const a = paid.value, packet = checkDiscoveryAssessmentForm(store, a).packet;
  const prefixRows = progressPrefix(store, packet.run, packet.entries.at(-1)!.number, prefix);
  // Verify all pinned bytes above before exposing them as a head snapshot to
  // the common turn reader (queued children also read their parent's head).
  store = pendingSnapshotView(store, prefixRows);
  const subject: V7AssessmentSubject = { project: a.projectId, planAnswer: packet.packet.planAnswer,
    planQuestionId: packet.packet.planQuestionId };
  need(same(a.baseline.state, previous ? { kind: 'state', ref: reference(previous) }
    : { kind: 'absent', id: v7ProgressStateId(subject) }), 'baseline.state', 'The assessment fixes its exact predecessor');
  orderedPrefix(store, a, previous?.value.summary ?? initial(), packet.entries
    .filter(e => !reused.some(r => r.id === attemptAccountKey(subject, reference(e.attempt.attempt)))).map(e => reference(e.attempt.attempt)), prefixRows);
  const methodologyOrigins = methodology(store, paid, reused);
  // Accepted baseline materials have their own exact provenance, including
  // attempts of other questions; resolve alone is deliberately insufficient.
  for (const material of a.baseline.materials) acceptedPremise(store, material);
  const previousSummary = previous?.value.summary ?? initial();
  const summary: V7ProgressSummary = structuredClone(previousSummary);
  const reusedById = new Map(reused.map(r => [r.id, r]));
  need(reusedById.size === reused.length && reused.every(r => packet.entries.some(e =>
    r.id === attemptAccountKey(subject, reference(e.attempt.attempt)))), 'reused', 'Only unique accounts of this packet may be reused');
  need(new Set(prior.map(r => r.id)).size === prior.length, 'priorEvents', 'Each prior event is named once');
  const seen = new Map(prior.map(e => [e.id, e]));
  const counting = new Map<string, V7FoldAttempt>(packet.entries.map(entry => {
    const attempt = reference(entry.attempt.attempt);return [attempt.id, { attempt, number: entry.number, contentKeys: [] }];
  }));
  const accountBodies: Omit<V7AttemptAccount, 'application'>[] = [];
  const eventBodies: Omit<V7ProgressEvent, 'application'>[] = [];
  const accepted = new Set(a.novelty.accepted.map(c => canonical(c.claim)));
  for (const entry of packet.entries) {
    const attempt = reference(entry.attempt.attempt), id = attemptAccountKey(subject, attempt);
    const old = reusedById.get(id);
    const claims = acceptedAt(a, attempt);
    if (old) {
      need(same(old.value.subject, subject) && same(old.value.attempt, attempt), 'account', 'A reused account belongs to its exact attempt');
      need(same(old.value.accepted, claims), 'account.accepted', 'A second judgment cannot revise the first claim acceptance');
      continue;
    }
    const keys: { key: string; basis: { claim: ClaimAddress } | { constraint: Ref }; type: 'claim' | 'constraint' }[] = [];
    const premise = (address: ClaimAddress) => {
      if (!accepted.has(canonical(address))) acceptedPremise(store, address);
    };
    for (const claim of claims) {
      // Source bytes, ranges, inference premises and owner authority are proved
      // even for duplicates. An accepted claim does not upgrade its kind.
      const key = claimContentKey(store, claim, { premise });
      const duplicate = a.novelty.duplicates.find(c => same(c.claim, claim));
      if (duplicate) {
        premise(duplicate.of);
        // Semantic duplication is the paid assessor's decision. Distinct
        // captures/locations may have different code keys for the same fact.
        claimContentKey(store, duplicate.of, { premise });
      } else keys.push({ key, basis: { claim }, type: 'claim' });
    }
    const transition = a.novelty.transition;
    const constraints = (transition?.bases ?? []).filter((b): b is { constraint: Ref } => 'constraint' in b && same(b.constraint, attempt));
    if (transition && constraints.length) {
      const key = constraintContentKey(store, attempt);
      // Repeated evidence cannot become new through a renamed attempt.
      keys.push({ key, basis: { constraint: attempt }, type: 'constraint' });
    }
    counting.get(attempt.id)!.contentKeys = keys.map(item => item.key);
    const emitted: string[] = [];
    for (const item of keys) {
      const eventId = progressEventKey(subject, item.key);
      if (seen.has(eventId) || eventBodies.some(e => e.id === eventId)) continue;
      emitted.push(eventId);
      eventBodies.push({ contract: 'research-progress-event/v1', id: eventId, subject, attempt,
        contentKey: item.key, type: item.type, basis: item.basis });
    }

    accountBodies.push({ contract: 'v7-attempt-account/v1', subject, attempt,
      number: entry.number, accepted: claims, eventIds: emitted, streak: 0 });
  }
  const fold = foldV7Progress({ subject, run: packet.run,
    previous: previous ? { subject: previous.value.subject, counters: {
      cursor: previousSummary.cursor, count: previousSummary.count, streak: previousSummary.streak } } : null,
    attempts: [...counting.values()], accounted: reused.map(account => account.value.attempt),
    knownContentKeys: prior.map(event => event.value.contentKey) });
  Object.assign(summary, fold.counters);
  for (const row of fold.fresh) accountBodies.find(account => same(account.attempt, row.attempt))!.streak = row.streak;
  const transition = a.novelty.transition;
  if (transition) {
    const newlyAccepted = eventBodies.filter(e => transition.bases.some(b => same(b, e.basis)));
    if (newlyAccepted.length) {
      const key = transitionContentKey(previousSummary.outcome, transition.outcome, newlyAccepted.map(e => e.contentKey));
      const id = progressEventKey(subject, key), cause = newlyAccepted.at(-1)!;
      if (!seen.has(id)) {
        eventBodies.push({ contract: 'research-progress-event/v1', id, subject, attempt: cause.attempt,
          contentKey: key, type: 'transition', basis: { transition: { from: previousSummary.outcome,
            to: transition.outcome, bases: newlyAccepted.map(e => e.basis as { claim: ClaimAddress } | { constraint: Ref }) } } });
        accountBodies.find(b => same(b.attempt, cause.attempt))!.eventIds.push(id);
      }
    }
  }
  need(accountBodies.length > 0, 'application', 'An application must account for a previously unaccounted attempt');
  if (a.novelty.transition) {
    summary.outcome = a.novelty.transition.outcome;
    summary.reason = a.novelty.transition.reason;
    summary.nextAction = a.novelty.transition.nextAction ?? null;
  }
  if (summary.outcome === 'open' || summary.outcome === 'stalled') {
    summary.outcome = summary.streak >= 3 ? 'stalled' : 'open';
    summary.reason = summary.outcome === 'stalled' ? 'Three distinct assessed attempts produced no new accepted basis'
      : a.novelty.transition?.outcome === 'open' ? a.novelty.transition.reason : null;
    summary.nextAction = summary.outcome === 'stalled' ? 'Change the accepted research basis before another dispatch' : null;
  }
  const value: V7ProgressApplication = { contract: 'v7-progress-application/v1', subject, assessment: reference(paid),
    previous: previous ? reference(previous) : null, prefix, methodologyOrigins, reused: reused.map(reference), priorEvents: prior.map(reference),
    attempts: accountBodies.map(b => b.attempt), after: summary };
  const application = predicted(appId(reference(paid)), PROGRESS_APPLICATION_KIND, 1, value);
  const accounts = accountBodies.map(value => predicted(attemptAccountKey(subject, value.attempt), ATTEMPT_ACCOUNT_KIND,
    1, { ...value, application: reference(application) }));
  const events = eventBodies.map(value => predicted(value.id, PROGRESS_EVENT_KIND, 1,
    { ...value, application: reference(application) }));
  const state = predicted(v7ProgressStateId(subject), STATE_KIND, (previous?.revision ?? 0) + 1,
    { contract: 'v7-progress-state/v1' as const, subject, application: reference(application), summary });
  return { application, state, accounts, events };
}

function readApplication(store: Store, ref: Ref): Derived {
  return historicalProof(store, { reader: 'discovery.v7-progress.application/v1', project: ref.id, ref }, source => {
    const app = exact<V7ProgressApplication>(source, ref, PROGRESS_APPLICATION_KIND), v = app.value;
    need(v?.subject && typeof v.subject.project === 'string' && v.contract === 'v7-progress-application/v1' && app.revision === 1 && isRef(v.assessment)
      && (v.previous === null || isRef(v.previous)) && Array.isArray(v.reused) && Array.isArray(v.priorEvents) && Array.isArray(v.methodologyOrigins) && Array.isArray(v.prefix),
      'application', 'The application needs its complete versioned provenance');
    const paid = readDiscoveryAssessment(source, v.subject.project, v.assessment);
    const previous = v.previous ? readV7ProgressStateAt(source, v.previous) : null;
    const reused = v.reused.map(r => readAccount(source, r));
    const prior = v.priorEvents.map(r => readEvent(source, r));
    for (const e of prior) {
      const predecessor = exact<V7ProgressApplication>(source, e.value.application, PROGRESS_APPLICATION_KIND);
      need(same(e.value.subject, v.subject) && predecessor.value.after.count <= (previous?.value.summary.count ?? 0),
        'priorEvents', 'Only earlier events of this subject suppress novelty');
    }
    const result = project(source, paid, previous, reused, prior, v.prefix);
    need(same(result.application, app), 'application', 'The application differs from the paid assessment projection');
    exactMatch(source, result.state);
    for (const account of result.accounts) exactMatch(source, account);
    for (const event of result.events) exactMatch(source, event);
    return result;
  }, () => fail('discovery_progress_conflict', 'application', 'Cyclic progress provenance'));
}
function exactMatch<T>(store: Store, expected: Revision<T>): void {
  need(same(exact(store, reference(expected), expected.kind), expected), expected.kind,
    'The atomic result is absent or differs from its exact application');
}
function readAccount(store: Store, ref: Ref): Revision<V7AttemptAccount> {
  const account = exact<V7AttemptAccount>(store, ref, ATTEMPT_ACCOUNT_KIND);
  need(account.value?.contract === 'v7-attempt-account/v1' && isRef(account.value.application),
    'account', 'The account needs its exact atomic application');
  const proof = readApplication(store, account.value.application);
  need(proof.accounts.some(r => same(r, account)), 'account', 'The account is not a derived atomic result');
  return account;
}
function readEvent(store: Store, ref: Ref): Revision<V7ProgressEvent> {
  const event = exact<V7ProgressEvent>(store, ref, PROGRESS_EVENT_KIND);
  need(event.value?.contract === 'research-progress-event/v1' && isRef(event.value.application),
    'event', 'The event needs its exact atomic application');
  const proof = readApplication(store, event.value.application);
  need(proof.events.some(r => same(r, event)), 'event', 'The event is not a derived atomic result');
  return event;
}
export function readV7ProgressStateAt(store: Store, ref: Ref): Revision<V7ProgressState> {
  const state = exact<V7ProgressState>(store, ref, STATE_KIND);
  need(state.value?.contract === 'v7-progress-state/v1' && isRef(state.value.application), 'state', 'The state needs its exact application');
  const proof = readApplication(store, state.value.application);
  need(same(proof.state, state), 'state', 'The state differs from its atomic application');
  return state;
}

export interface ProgressApplicationResult { state: Revision<V7ProgressState>;
  applications: Revision<V7ProgressApplication>[]; repeated: boolean }

/** Current heads are used only for CAS admission. The selected paid result and
 * all proof readers retain their original exact packet/baseline. */
export function applyDiscoveryAssessment(store: Store, projectId: string, ref: Ref): ProgressApplicationResult {
  return withHistoricalReads(() => {
    const paid = readDiscoveryAssessment(store, projectId, ref), a = paid.value;
    const subject = a.subject.packet, stateId = v7ProgressStateId(subject);
    const covered: Revision<V7AttemptAccount>[] = [], fresh: Ref[] = [];
    for (const entry of subject.entries) {
      const saved = store.get<V7AttemptAccount>(attemptAccountKey(subject, entry.attempt), 1);
      if (saved) covered.push(readAccount(store, reference(saved))); else fresh.push(entry.attempt);
    }
    const head = store.get<V7ProgressState>(stateId);
    const previous = head ? readV7ProgressStateAt(store, reference(head)) : null;
    if (!fresh.length) {
      for (const r of covered) need(same(r.value.accepted, acceptedAt(a, r.value.attempt)),
        'account.accepted', 'A second judgment cannot rewrite the accepted claims');
      need(previous, 'state', 'Accounted attempts need their derived state');
      const apps = [...new Map(covered.map(r => [r.value.application.id, r.value.application])).values()];
      return { state: previous, applications: apps.map(r => readApplication(store, r).application), repeated: true };
    }
    const expected = previous ? { kind: 'state', ref: reference(previous) } : { kind: 'absent', id: stateId };
    if (!same(a.baseline.state, expected)) fail('discovery_progress_stale', 'baseline.state',
      'The unaccounted paid result names a moved baseline; preserve it and select an addressed recovery');
    // Probe only keys this packet can emit. Historical derivation uses these
    // exact receipts, so later events cannot change the saved application.
    const prior: Revision<V7ProgressEvent>[] = [];
    const keys = a.novelty.newContent.map(c => claimContentKey(store, c.claim, { premise: address => {
      if (!a.novelty.accepted.some(c => same(c.claim, address))) acceptedPremise(store, address);
    } }));
    for (const b of a.novelty.transition?.bases ?? []) if ('constraint' in b)
      keys.push(constraintContentKey(store, b.constraint));
    for (const key of [...new Set(keys)]) {
      const row = store.get<V7ProgressEvent>(progressEventKey(subject, key), 1);
      if (row) prior.push(readEvent(store, reference(row)));
    }
    const packet = checkDiscoveryAssessmentForm(store, a).packet;
    const prefix = progressPrefix(store, packet.run, packet.entries.at(-1)!.number).map(reference);
    const result = project(store, paid, previous, covered, prior, prefix);
    const rows: Revision<unknown>[] = [result.application, ...result.accounts, ...result.events, result.state];
    const writes: Write[] = rows.map(r => ({ id: r.id, kind: r.kind, expected: r.revision - 1, value: r.value }));
    const guards: TransactionGuard[] = [...baselineGuards(a.baseline), ...covered.map(reference), ...prior.map(reference), ...prefix];
    try { store.writeMany(writes, guards); }
    catch (error) {
      if (error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code)) {
        const won = store.get<V7ProgressApplication>(result.application.id, 1);
        if (won && same(won, result.application)) {
          const saved = readApplication(store, reference(won));
          return { state: saved.state, applications: [saved.application], repeated: true };
        }
        const now = store.get<V7ProgressState>(stateId);
        if (now && (!previous || !same(reference(previous), reference(now))))
          fail('discovery_progress_stale', 'baseline.state', 'The subject changed before atomic application');
        fail('discovery_progress_conflict', 'application', 'The atomic application conflicted; the paid result is retained');
      }
      throw error;
    }
    return { state: result.state, applications: [result.application], repeated: false };
  });
}

/** An attempt claim is usable only at the deterministic first-account address,
 * and only if that exact pointer occurs in the re-derived paid application. */
export function proveAppliedAttemptClaim(store: Store, address: ClaimAddress): {
  application: Revision<V7ProgressApplication>; assessment: Revision<PaidDiscoveryAttemptsAssessment> } {
  return withHistoricalReads(() => {
    const resolved = resolveClaimAddress(store, address);
    need(resolved.container.kind === V7_ATTEMPT_KIND, 'claim', 'An attempt proof needs an attempt container');
    const value = resolved.container.value as unknown as { project: string; planAnswer: Ref; planQuestionId: string };
    const subject = { project: value.project, planAnswer: value.planAnswer, planQuestionId: value.planQuestionId };
    const account = store.get<V7AttemptAccount>(attemptAccountKey(subject, address.container), 1);
    if (!account) fail('claim_attempt_not_accepted', 'application', 'The exact attempt has not been applied');
    const proven = readAccount(store, reference(account));
    if (!proven.value.accepted.some(c => same(c, address)))
      fail('claim_attempt_not_accepted', 'claim', 'This exact claim pointer was not accepted by the first application');
    const app = readApplication(store, proven.value.application).application;
    return { application: app, assessment: readDiscoveryAssessment(store, address.project, app.value.assessment) };
  });
}

/** A caller can request a comparison snapshot; no caller field manufactures a
 * state or accepted material. The paid producer will guard this exact snapshot. */
export function v7ProgressBaseline(store: Store, subject: V7AssessmentSubject, materials: ClaimAddress[] = []): V7ProgressBaseline {
  if (!subject || typeof subject.project !== 'string' || !subject.project.trim() || !isRef(subject.planAnswer)
    || typeof subject.planQuestionId !== 'string' || !subject.planQuestionId.trim() || !Array.isArray(materials))
    fail('discovery_assessment_subject_invalid', 'baseline', 'A baseline needs its exact subject and materials list');
  const head = store.get<V7ProgressState>(v7ProgressStateId(subject));
  if (head) readV7ProgressStateAt(store, reference(head));
  for (const material of materials) acceptedPremise(store, material);
  return { contract: V7_PROGRESS_BASELINE_CONTRACT,
    state: head ? { kind: 'state', ref: reference(head) } : { kind: 'absent', id: v7ProgressStateId(subject) }, materials };
}

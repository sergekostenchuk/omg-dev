import { VARIANT_OWNER_ACTION, VARIANT_OWNER_GRANT_CONTRACT, VARIANT_OWNER_SESSION_CONTRACT,
  decodeVariantChoiceScope, type VariantChoiceScope } from '../discovery/variant-decision.js';
import { readProjectMode } from './project-mode.js';
import { readVariantGeneration } from '../discovery/variant-session.js';
import { randomBytes, timingSafeEqual } from "node:crypto";
import { digest, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { readRecord, writeGuarded } from "../om/refs.js";
import { STAGE_BUDGET_ACTION, STAGE_BUDGET_PAIRING_METHOD, STAGE_BUDGET_GRANT_CONTRACT, STAGE_BUDGET_SESSION_CONTRACT,
  STAGE_BUDGET_GRANT_PREFIX, STAGE_BUDGET_GRANT_KIND, STAGE_BUDGET_SESSION_KIND, STAGE_BUDGET_GRANT_LIFETIME_MS,
  STAGE_BUDGET_SESSION_LIFETIME_MS, STAGE_BUDGET_INCREASE_KIND, STAGE_BUDGET_INCREASE_CONTRACT, readEffectiveStageBudget,
  readStageBudgetGrant, readStageBudgetSession, requireStageBudgetScope, stageBudgetIncreaseId, stageBudgetSegmentId,
  stageBudgetSessionId, type StageBudgetIncrease, type StageBudgetScope, type StageBudgetSession,
  type StageBudgetSessionGrant } from "../discovery/stage-token-budget.js";
import type { BudgetSegment } from "../runtime/research-budget.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import { FINAL_ACCEPTANCE_ACTION, FINAL_ACCEPTANCE_ACT_CONTRACT, FINAL_ACCEPTANCE_ACT_KIND, FINAL_ACCEPTANCE_GRANT_CONTRACT,
  FINAL_ACCEPTANCE_GRANT_KIND, FINAL_ACCEPTANCE_GRANT_LIFETIME_MS, FINAL_ACCEPTANCE_GRANT_PREFIX, FINAL_ACCEPTANCE_PAIRING_METHOD,
  FINAL_ACCEPTANCE_SESSION_CONTRACT, FINAL_ACCEPTANCE_SESSION_KIND, FINAL_ACCEPTANCE_SESSION_LIFETIME_MS,
  FINAL_MACHINE_ADMISSION_CONTRACT, acceptanceSnapshot, acceptanceWrites, finalAcceptanceActId, finalAcceptanceSessionId,
  finalMachineAdmissionId, proveFinalAcceptanceAct, proveFinalMachineAdmission, provenAcceptanceGrounds, provenAcceptanceMode,
  readAcceptedDiscoveryManifestAt, readFinalAcceptanceGrant, readFinalAcceptanceSession, requireFinalAcceptanceScope,
  type AcceptedDiscovery, type DiscoveryAcceptanceGrounds, type FinalAcceptanceAct, type FinalAcceptanceScope,
  type FinalAcceptanceSession, type FinalAcceptanceSessionGrant, type FinalMachineAdmission } from "../discovery/discovery-acceptance.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Refusal, type Sealed } from "../om/refusal.js";

/**
 * H2.0 (№1353, вариант Б; договор №2719): owner authority — the separately authenticated path that alone may produce
 * an om-owner-result. The chain is a trusted local invitation (owner-session-grant/v1, 10 minutes, one-time, secret
 * never persisted), its exchange into an owner-session/v1 at a deterministic address derived from the exact grant Ref
 * (CAS expected:0 — one session per invitation, losers get a typed refusal), and an opaque in-memory bearer→authority
 * mapping the server hands to a cookie. The grant/session/command records deliberately carry no `om-` prefix: they are
 * outside the OM era and open nothing in it.
 *
 * Authority itself is an object identity, not a claim: only the module-local MINT token can construct an
 * OwnerAuthority, every minted object registers in the closed WeakSet, and the producer-facing exercise() re-checks the
 * live bearer map of THIS OwnerSessions instance — so a lookalike shape, a serialized Ref, an actor name, an
 * `owner:true` flag or a bare record hash establish nothing (№1076-2). Revocation drops the bearer and closes the
 * session revision; a guarded writer pins the exact session revision, so a revocation racing a commit is caught by the
 * transaction guards, never by a window between check and write. A server restart empties the bearer map: live bearers
 * die, the persisted session/grant records remain for historical reads.
 */
export const OWNER_RESULT_ACTION = 'owner-result';
export const OWNER_PAIRING_METHOD = 'local-pairing/v1';
export const OWNER_GRANT_KIND = 'owner-session-grant';
export const OWNER_SESSION_KIND = 'owner-session';
export const OWNER_GRANT_CONTRACT = 'owner-session-grant/v1';
export const OWNER_SESSION_CONTRACT = 'owner-session/v1';
export const OWNER_GRANT_PREFIX = 'owner-session-grant:';
export const OWNER_SESSION_PREFIX = 'owner-session:';
export const OWNER_GRANT_LIFETIME_MS = 10 * 60_000;
export const OWNER_SESSION_LIFETIME_MS = 30 * 60_000;

/** OC1: a separate authority branch for one exact Discovery condition choice. */
export const DISCOVERY_CHOICE_ACTION = 'discovery-condition-choice';
export const DISCOVERY_CHOICE_GRANT_CONTRACT = 'owner-session-grant/v2';
export const DISCOVERY_CHOICE_SESSION_CONTRACT = 'owner-session/v2';
export const DISCOVERY_CHOICE_GRANT_PREFIX = 'owner-discovery-grant:';
export const DISCOVERY_CHOICE_SESSION_PREFIX = 'owner-discovery-session:';
export const DISCOVERY_CHOICE_GRANT_KIND = 'owner-session-grant';
export const DISCOVERY_CHOICE_SESSION_KIND = 'owner-session';

export const OWNER_AUTHORITY_REFUSAL_CODES = Object.freeze([
  'owner_invitation_invalid', 'owner_invitation_foreign', 'owner_invitation_expired', 'owner_invitation_spent',
  'owner_project_missing', 'owner_session_missing', 'owner_session_revoked', 'owner_session_expired',
  'owner_session_state_invalid', 'owner_authority_invalid', 'owner_authority_foreign',
] as const);
export type OwnerAuthorityRefusalCode = typeof OWNER_AUTHORITY_REFUSAL_CODES[number];
type DiscoveryChoiceAuthorityRefusalCode = OwnerAuthorityRefusalCode | 'discovery_choice_invalid'
  | 'project_mode_invalid' | 'project_mode_stale';

export interface OwnerSessionGrant {
  contract: typeof OWNER_GRANT_CONTRACT; id: string; database: string; project: string;
  action: typeof OWNER_RESULT_ACTION; method: typeof OWNER_PAIRING_METHOD; issuedAt: number; expiresAt: number;
  /** The verification value of the one-time secret — the secret itself is never persisted. */
  proof: string;
}
export interface OwnerSession {
  contract: typeof OWNER_SESSION_CONTRACT; grant: Ref; database: string; project: string;
  action: typeof OWNER_RESULT_ACTION; method: typeof OWNER_PAIRING_METHOD; session: string; openedAt: number;
  expiresAt: number; state: 'open' | 'closed'; closedAt?: number;
}

export interface DiscoveryChoiceScope {
  project: string; draft: string; verdictRef: Ref; reportRef: Ref; conditionId: string; optionId: string;
}
export interface DiscoveryChoiceSessionGrant {
  contract: typeof DISCOVERY_CHOICE_GRANT_CONTRACT; id: string; database: string;
  action: typeof DISCOVERY_CHOICE_ACTION; method: typeof OWNER_PAIRING_METHOD; scope: DiscoveryChoiceScope;
  issuedAt: number; expiresAt: number; proof: string;
}
export interface DiscoveryChoiceSession {
  contract: typeof DISCOVERY_CHOICE_SESSION_CONTRACT; grant: Ref; database: string;
  action: typeof DISCOVERY_CHOICE_ACTION; method: typeof OWNER_PAIRING_METHOD; scope: DiscoveryChoiceScope;
  session: string; openedAt: number; expiresAt: number; state: 'open' | 'closed'; closedAt?: number;
}

/** The deterministic session address of one exact grant Ref — the one-time-exchange CAS target. */
export function ownerSessionId(grant: Ref): string {
  return `${OWNER_SESSION_PREFIX}${hashJson({ id: grant.id, revision: grant.revision, hash: grant.hash })}`;
}
export function discoveryChoiceSessionId(grant: Ref): string {
  return `${DISCOVERY_CHOICE_SESSION_PREFIX}${hashJson({ id: grant.id, revision: grant.revision, hash: grant.hash })}`;
}

class AuthorityFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function deny(code: DiscoveryChoiceAuthorityRefusalCode, target: string, field: string, message: string,
  unit = 'H2'): never {
  const result = refused(code, message, { unit, target, field }, 'owner');
  if (!result.ok) throw new AuthorityFailure(result.refusal);
  throw new EngineError('owner_authority_internal', 'Refusal unexpectedly produced a value');
}
function take<T>(result: OmResult<T>): T {
  if (!result.ok) throw new AuthorityFailure(result.refusal);
  return result.value;
}
function run<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof AuthorityFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
const shape = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const exactRef = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });

/** Internal shape proof of a grant record already addressed by readRecord or store.get. */
function provenGrant(record: Revision<OwnerSessionGrant>): Revision<OwnerSessionGrant> {
  const value = record.value;
  if (!shape(value) || value.contract !== OWNER_GRANT_CONTRACT || !isText(value.id)
    || record.id !== `${OWNER_GRANT_PREFIX}${value.id}` || !isText(value.database) || !isText(value.project)
    || value.action !== OWNER_RESULT_ACTION || value.method !== OWNER_PAIRING_METHOD
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt
    || typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof))
    deny('owner_invitation_invalid', record.id, 'contract', 'An invitation grant keeps its complete v1 provenance');
  return record;
}
/** Internal shape proof of a session record: internal consistency only — liveness is exercised separately. */
function provenSession(record: Revision<OwnerSession>): Revision<OwnerSession> {
  const value = record.value;
  if (!shape(value) || value.contract !== OWNER_SESSION_CONTRACT || !isRef(value.grant)
    || record.id !== ownerSessionId(value.grant) || !isText(value.database) || !isText(value.project)
    || value.action !== OWNER_RESULT_ACTION || value.method !== OWNER_PAIRING_METHOD || !isText(value.session)
    || !Number.isSafeInteger(value.openedAt) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.openedAt
    || (value.state !== 'open' && value.state !== 'closed')
    || (value.state === 'closed' && !Number.isSafeInteger(value.closedAt))
    || (value.state === 'open' && Object.hasOwn(value, 'closedAt')))
    deny('owner_session_state_invalid', record.id, 'contract', 'An owner session keeps its complete v1 provenance');
  return record;
}

/** Common reader of one grant record — shared with the owner-result proof chain; never duplicated. */
export function readOwnerSessionGrant(store: Store, record: unknown): OmResult<Sealed<Revision<OwnerSessionGrant>>> {
  return run(() => provenGrant(take(readRecord<OwnerSessionGrant>(store, record,
    { unit: 'H2', target: isRef(record) ? record.id : 'grant', idPrefix: OWNER_GRANT_PREFIX, kind: OWNER_GRANT_KIND }))));
}
/** Common reader of one session record — shared with the owner-result proof chain; never duplicated. */
export function readOwnerSession(store: Store, record: unknown): OmResult<Sealed<Revision<OwnerSession>>> {
  return run(() => provenSession(take(readRecord<OwnerSession>(store, record,
    { unit: 'H2', target: isRef(record) ? record.id : 'session', idPrefix: OWNER_SESSION_PREFIX, kind: OWNER_SESSION_KIND }))));
}

/**
 * The trusted local bootstrap of model Б (№1353-1): a separate CLI command — not a ProductCommand, not reachable
 * through execute or HTTP — issues a one-time invitation for this exact database, project and the single action
 * owner-result. The high-entropy secret is returned to the issuer's interactive terminal once; only its digest is kept.
 */
export function issueOwnerInvitation(store: Store, request: unknown): OmResult<Sealed<{ invitation: string; grant: Ref; expiresAt: number }>> {
  return run(() => {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'An invitation needs a Store');
    if (!shape(request) || !isText(request.project) || Object.keys(request).some(key => key !== 'project'))
      deny('owner_invitation_invalid', 'invitation', 'project', 'An invitation is issued for a named existing project');
    const projectName = request.project as string;
    const project = store.get(`project:${projectName}`);
    if (!project) deny('owner_project_missing', projectName, 'project',
      'An invitation is issued for an existing project only');
    const secret = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex'), issuedAt = Date.now();
    const grant: OwnerSessionGrant = { contract: OWNER_GRANT_CONTRACT, id, database: store.databaseId,
      project: projectName, action: OWNER_RESULT_ACTION, method: OWNER_PAIRING_METHOD, issuedAt,
      expiresAt: issuedAt + OWNER_GRANT_LIFETIME_MS, proof: digest(secret) };
    const written = take(writeGuarded<OwnerSessionGrant>(store, { unit: 'H2', target: `${OWNER_GRANT_PREFIX}${id}`,
      writes: [{ id: `${OWNER_GRANT_PREFIX}${id}`, kind: OWNER_GRANT_KIND, expected: 0, value: grant }],
      guards: [exactRef(reference(project))] }));
    return { invitation: `${id}.${secret}`, grant: exactRef(reference(written[0]!)), expiresAt: grant.expiresAt };
  });
}

const MINT = Symbol('owner-authority-mint');
/** The closed registry of authority object identities (договор: закрытый реестр идентичностей объектов, без brand). */
const AUTHORITIES = new WeakSet<OwnerAuthority>();

/**
 * The opaque authority object an owner session hands to the producer. It is unforgeable by construction: the
 * constructor needs the module-local MINT symbol, every minted object lives in AUTHORITIES, and exercise() re-proves
 * the live bearer mapping plus the current session record before yielding the exact session Ref.
 */
export class OwnerAuthority {
  readonly #sessions: OwnerSessions; readonly #store: Store; readonly #digest: string;
  readonly #sessionId: string; readonly #project: string;
  constructor(token: symbol, sessions: OwnerSessions, store: Store, bearerDigest: string, sessionId: string, project: string) {
    requireCondition(token === MINT, 'owner_authority_invalid',
      'Owner authority is minted by the owner session exchange only');
    this.#sessions = sessions; this.#store = store; this.#digest = bearerDigest;
    this.#sessionId = sessionId; this.#project = project;
    AUTHORITIES.add(this);
  }
  /**
   * The producer-facing proof: registry liveness (bearer not revoked, server not restarted), Store/project/action
   * binding, then the session record's own state — open, inside its 30-minute window, still bound to grant/project.
   * Delivers the exact head Ref of the live session for the command receipt and its transaction guard.
   */
  exercise(request: { store: Store; project: string; action: string }): OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      if (!AUTHORITIES.has(this))
        deny('owner_authority_invalid', 'authority', 'authority',
          'Owner authority is an object of the closed exchange registry');
      if (this.#sessions.sessionOf(this.#digest) !== this.#sessionId)
        deny('owner_session_missing', this.#sessionId, 'session',
          'The owner session bearer is not live on this server');
      if (request.store !== this.#store)
        deny('owner_authority_foreign', this.#sessionId, 'store', 'Owner authority is bound to its issuing Store');
      if (request.project !== this.#project || request.action !== OWNER_RESULT_ACTION)
        deny('owner_authority_foreign', this.#sessionId, 'scope',
          'Owner authority admits only its bound project and its bound action');
      const found = this.#store.get<OwnerSession>(this.#sessionId);
      if (!found) deny('owner_session_missing', this.#sessionId, 'session', 'The owner session record is absent');
      const session = provenSession(found);
      if (session.value.state !== 'open')
        deny('owner_session_revoked', this.#sessionId, 'session', 'The owner session is revoked');
      if (session.value.expiresAt <= Date.now())
        deny('owner_session_expired', this.#sessionId, 'session', 'The owner session has expired');
      if (session.value.database !== this.#store.databaseId || session.value.project !== this.#project
        || session.value.action !== OWNER_RESULT_ACTION)
        deny('owner_authority_foreign', this.#sessionId, 'scope',
          'The owner session is bound to another database, project or action');
      return { session: exactRef(reference(session)) };
    });
  }
}
const OWNER_AUTHORITY_EXERCISE = OwnerAuthority.prototype.exercise;
/**
 * Producer-side check of a supplied authority. Anything that is not a minted live OwnerAuthority — a lookalike object,
 * a Ref, a string, a record hash — is refused before any store read or write is prepared.
 */
export function requireOwnerAuthority(candidate: unknown, request: { store: Store; project: string; action: string }):
  OmResult<Sealed<{ session: Ref }>> {
  if (candidate instanceof DiscoveryChoiceAuthority || candidate instanceof ProjectModeAuthority)
    return refused('owner_authority_foreign',
      'A scoped owner authority cannot authorize an owner-result action',
      { unit: 'H2', target: 'authority', field: 'action' }, 'owner');
  if (!(candidate instanceof OwnerAuthority) || !AUTHORITIES.has(candidate))
    return refused('owner_authority_invalid',
      'Owner authority is the opaque object minted by the owner session exchange',
      { unit: 'H2', target: 'authority', field: 'authority' }, 'owner');
  return OWNER_AUTHORITY_EXERCISE.call(candidate, request);
}

/**
 * The server-held owner-session registry: exchange, bearer→authority mapping and revocation. One instance per Store —
 * the bearer map lives in memory only, so a server restart kills every live bearer while the historical grant/session
 * records stay readable forever.
 */
export class OwnerSessions {
  readonly #store: Store;
  readonly #live = new Map<string, { session: string; authority: OwnerAuthority }>();
  constructor(store: Store) {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'The owner session registry needs a Store');
    this.#store = store;
  }
  /** Internal liveness lookup for OwnerAuthority.exercise — maps a bearer digest to its live session id. */
  sessionOf(bearerDigest: string): string | null { return this.#live.get(bearerDigest)?.session ?? null; }
  /**
   * One-time exchange: a presented `<grantId>.<secret>` invitation against a verified, unexpired, unspent grant.
   * Every failure is refused before any write — a wrong secret never spends the invitation. Two concurrent exchanges
   * contend on the deterministic session id: CAS expected:0 admits exactly one session per grant.
   */
  exchange(request: unknown): OmResult<Sealed<{ bearer: string; session: Ref; expiresAt: number }>> {
    return run(() => {
      if (!shape(request) || !isText(request.project) || !isText(request.invitation)
        || Object.keys(request).some(key => !['project', 'invitation'].includes(key)))
        deny('owner_invitation_invalid', 'session', 'request', 'The owner session exchange needs a project and an invitation');
      const project = request.project as string, parts = (request.invitation as string).split('.');
      if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!))
        deny('owner_invitation_invalid', project, 'invitation', 'An invitation is <grant-id>.<secret>');
      const found = this.#store.get<OwnerSessionGrant>(`${OWNER_GRANT_PREFIX}${parts[0]}`);
      if (!found) deny('owner_invitation_invalid', project, 'invitation', 'Unknown invitation');
      const grant = provenGrant(found);
      if (!timingSafeEqual(Buffer.from(digest(parts[1]!), 'hex'), Buffer.from(grant.value.proof, 'hex')))
        deny('owner_invitation_invalid', project, 'invitation', 'The invitation secret does not verify');
      if (grant.value.database !== this.#store.databaseId || grant.value.project !== project
        || grant.value.action !== OWNER_RESULT_ACTION)
        deny('owner_invitation_foreign', project, 'invitation',
          'The invitation is bound to another database, project or action');
      const now = Date.now();
      if (grant.value.expiresAt <= now)
        deny('owner_invitation_expired', project, 'invitation', 'The invitation has expired');
      const grantRef = exactRef(reference(grant));
      const sessionId = ownerSessionId(grantRef);
      if (this.#store.get(sessionId))
        deny('owner_invitation_spent', project, 'invitation', 'The invitation is already exchanged');
      const session: OwnerSession = { contract: OWNER_SESSION_CONTRACT, grant: grantRef, database: grant.value.database,
        project: grant.value.project, action: OWNER_RESULT_ACTION, method: OWNER_PAIRING_METHOD,
        session: randomBytes(16).toString('hex'), openedAt: now, expiresAt: now + OWNER_SESSION_LIFETIME_MS,
        state: 'open' };
      const written = take(writeGuarded<OwnerSession>(this.#store, { unit: 'H2', target: sessionId,
        writes: [{ id: sessionId, kind: OWNER_SESSION_KIND, expected: 0, value: session }], guards: [grantRef] }));
      const bearer = randomBytes(32).toString('hex');
      this.#live.set(digest(bearer), { session: sessionId,
        authority: new OwnerAuthority(MINT, this, this.#store, digest(bearer), sessionId, project) });
      return { bearer, session: exactRef(reference(written[0]!)), expiresAt: session.expiresAt };
    });
  }
  /** The live authority of one bearer, or null — a restart empties the map even though the records persist. */
  authority(bearer: unknown): OwnerAuthority | null {
    return typeof bearer === 'string' && /^[a-f0-9]{64}$/.test(bearer)
      ? this.#live.get(digest(bearer))?.authority ?? null : null;
  }
  /**
   * Logout: the bearer leaves the live registry and the session closes (a new revision with state 'closed'), so both
   * the authority check and any in-flight guarded write pinned to the open revision are refused afterwards.
   */
  revoke(bearer: unknown): OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      const key = typeof bearer === 'string' ? digest(bearer) : null;
      const live = key ? this.#live.get(key) : undefined;
      if (!live) deny('owner_session_missing', 'session', 'bearer', 'No live owner session carries this bearer');
      this.#live.delete(key!);
      const head = this.#store.get<OwnerSession>(live!.session);
      if (!head) deny('owner_session_missing', live!.session, 'session', 'The owner session record is absent');
      if (head.value.state === 'closed') return { session: exactRef(reference(head)) };
      const closed: OwnerSession = { ...head.value, state: 'closed', closedAt: Date.now() };
      const written = take(writeGuarded<OwnerSession>(this.#store, { unit: 'H2', target: head.id,
        writes: [{ id: head.id, kind: OWNER_SESSION_KIND, expected: head.revision, value: closed }],
        guards: [exactRef(reference(head))] }));
      return { session: exactRef(reference(written[0]!)) };
    });
  }
}

const DISCOVERY_MINT = Symbol('discovery-choice-authority-mint');
const DISCOVERY_AUTHORITIES = new WeakSet<DiscoveryChoiceAuthority>();

const sameScope = (left: unknown, right: unknown): boolean =>
  hashJson(left) === hashJson(right);

function requireDiscoveryScope(value: unknown, target = 'discovery-choice',
  code: DiscoveryChoiceAuthorityRefusalCode = 'discovery_choice_invalid'): DiscoveryChoiceScope {
  if (!shape(value) || !isText(value.project) || !isText(value.draft) || !isRef(value.verdictRef)
    || !isRef(value.reportRef) || !isText(value.conditionId) || !isText(value.optionId)
    || Object.keys(value).some(key => !['project', 'draft', 'verdictRef', 'reportRef', 'conditionId', 'optionId'].includes(key)))
    deny(code, target, 'scope',
      'A Discovery choice scope names project, draft, exact verdict/report, condition and option only');
  return { project: value.project as string, draft: value.draft as string,
    verdictRef: exactRef(value.verdictRef as Ref), reportRef: exactRef(value.reportRef as Ref),
    conditionId: value.conditionId as string, optionId: value.optionId as string };
}

function provenDiscoveryChoiceGrant(record: Revision<DiscoveryChoiceSessionGrant>): Revision<DiscoveryChoiceSessionGrant> {
  const value = record.value;
  if (!shape(value) || value.contract !== DISCOVERY_CHOICE_GRANT_CONTRACT || !isText(value.id)
    || record.id !== `${DISCOVERY_CHOICE_GRANT_PREFIX}${value.id}` || !isText(value.database)
    || value.action !== DISCOVERY_CHOICE_ACTION || value.method !== OWNER_PAIRING_METHOD
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt
    || typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof)
    || !shape(value.scope) || Object.keys(value).some(key => !['contract', 'id', 'database', 'action', 'method',
      'scope', 'issuedAt', 'expiresAt', 'proof'].includes(key)))
    deny('owner_invitation_invalid', record.id, 'contract', 'A Discovery invitation keeps its complete v2 provenance');
  requireDiscoveryScope(value.scope, record.id, 'owner_invitation_invalid');
  return record;
}

function provenDiscoveryChoiceSession(record: Revision<DiscoveryChoiceSession>): Revision<DiscoveryChoiceSession> {
  const value = record.value;
  if (!shape(value) || value.contract !== DISCOVERY_CHOICE_SESSION_CONTRACT || !isRef(value.grant)
    || record.id !== discoveryChoiceSessionId(value.grant) || !isText(value.database)
    || value.action !== DISCOVERY_CHOICE_ACTION || value.method !== OWNER_PAIRING_METHOD || !isText(value.session)
    || !Number.isSafeInteger(value.openedAt) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.openedAt
    || (value.state !== 'open' && value.state !== 'closed')
    || (value.state === 'closed' && !Number.isSafeInteger(value.closedAt))
    || (value.state === 'open' && Object.hasOwn(value, 'closedAt')) || !shape(value.scope)
    || Object.keys(value).some(key => !['contract', 'grant', 'database', 'action', 'method', 'scope', 'session',
      'openedAt', 'expiresAt', 'state', 'closedAt'].includes(key)))
    deny('owner_session_state_invalid', record.id, 'contract', 'A Discovery owner session keeps its complete v2 provenance');
  requireDiscoveryScope(value.scope, record.id, 'owner_session_state_invalid');
  return record;
}

export function readDiscoveryChoiceSessionGrant(store: Store, record: unknown):
  OmResult<Sealed<Revision<DiscoveryChoiceSessionGrant>>> {
  return run(() => provenDiscoveryChoiceGrant(take(readRecord<DiscoveryChoiceSessionGrant>(store, record,
    { unit: 'OC1', target: isRef(record) ? record.id : 'grant', idPrefix: DISCOVERY_CHOICE_GRANT_PREFIX,
      kind: DISCOVERY_CHOICE_GRANT_KIND }))));
}

export function readDiscoveryChoiceSession(store: Store, record: unknown):
  OmResult<Sealed<Revision<DiscoveryChoiceSession>>> {
  return run(() => provenDiscoveryChoiceSession(take(readRecord<DiscoveryChoiceSession>(store, record,
    { unit: 'OC1', target: isRef(record) ? record.id : 'session', idPrefix: DISCOVERY_CHOICE_SESSION_PREFIX,
      kind: DISCOVERY_CHOICE_SESSION_KIND }))));
}

export function issueDiscoveryChoiceInvitation(store: Store, request: unknown):
  OmResult<Sealed<{ invitation: string; grant: Ref; expiresAt: number }>> {
  return run(() => {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'A Discovery invitation needs a Store');
    const scope = requireDiscoveryScope(request);
    const project = store.get(`project:${scope.project}`);
    if (!project) deny('owner_project_missing', scope.project, 'project',
      'A Discovery invitation is issued for an existing project only');
    const secret = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex'), issuedAt = Date.now();
    const grant: DiscoveryChoiceSessionGrant = { contract: DISCOVERY_CHOICE_GRANT_CONTRACT, id,
      database: store.databaseId, action: DISCOVERY_CHOICE_ACTION, method: OWNER_PAIRING_METHOD, scope,
      issuedAt, expiresAt: issuedAt + OWNER_GRANT_LIFETIME_MS, proof: digest(secret) };
    const written = take(writeGuarded<DiscoveryChoiceSessionGrant>(store, { unit: 'OC1',
      target: `${DISCOVERY_CHOICE_GRANT_PREFIX}${id}`,
      writes: [{ id: `${DISCOVERY_CHOICE_GRANT_PREFIX}${id}`, kind: DISCOVERY_CHOICE_GRANT_KIND, expected: 0, value: grant }],
      guards: [exactRef(reference(project))] }));
    return { invitation: `${id}.${secret}`, grant: exactRef(reference(written[0]!)), expiresAt: grant.expiresAt };
  });
}

export class DiscoveryChoiceAuthority {
  readonly #sessions: DiscoveryChoiceSessions; readonly #store: Store; readonly #digest: string;
  readonly #sessionId: string; readonly #scope: DiscoveryChoiceScope;
  constructor(token: symbol, sessions: DiscoveryChoiceSessions, store: Store, bearerDigest: string,
    sessionId: string, scope: DiscoveryChoiceScope) {
    requireCondition(token === DISCOVERY_MINT, 'owner_authority_invalid',
      'Discovery choice authority is minted by its scoped session exchange only');
    this.#sessions = sessions; this.#store = store; this.#digest = bearerDigest;
    this.#sessionId = sessionId; this.#scope = scope; DISCOVERY_AUTHORITIES.add(this);
  }
  exercise(request: { store: Store; action: string; scope: DiscoveryChoiceScope }):
    OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      if (!DISCOVERY_AUTHORITIES.has(this)) deny('owner_authority_invalid', 'authority', 'authority',
        'Discovery authority is an object of the closed scoped registry');
      if (request.store !== this.#store || request.action !== DISCOVERY_CHOICE_ACTION
        || !sameScope(request.scope, this.#scope))
        deny('owner_authority_foreign', this.#sessionId, 'scope',
          'Discovery authority is bound to one Store and one exact condition option');
      const found = this.#store.get<DiscoveryChoiceSession>(this.#sessionId);
      if (!found) deny('owner_session_missing', this.#sessionId, 'session', 'The Discovery owner session record is absent');
      const session = provenDiscoveryChoiceSession(found);
      if (session.value.state !== 'open') deny('owner_session_revoked', this.#sessionId, 'session',
        'The Discovery owner session is revoked');
      if (this.#sessions.sessionOf(this.#digest) !== this.#sessionId)
        deny('owner_session_missing', this.#sessionId, 'session', 'The Discovery owner session is not live in this process');
      if (session.value.expiresAt <= Date.now()) deny('owner_session_expired', this.#sessionId, 'session',
        'The Discovery owner session has expired');
      if (session.value.database !== this.#store.databaseId || !sameScope(session.value.scope, this.#scope))
        deny('owner_authority_foreign', this.#sessionId, 'scope',
          'The Discovery owner session is bound to another database or choice');
      return { session: exactRef(reference(session)) };
    });
  }
}
const DISCOVERY_AUTHORITY_EXERCISE = DiscoveryChoiceAuthority.prototype.exercise;

export function requireDiscoveryChoiceAuthority(candidate: unknown,
  request: { store: Store; action: string; scope: DiscoveryChoiceScope }): OmResult<Sealed<{ session: Ref }>> {
  if (candidate instanceof OwnerAuthority || candidate instanceof ProjectModeAuthority)
    return refused('owner_authority_foreign', 'Another owner authority cannot authorize a Discovery choice',
      { unit: 'OC1', target: 'authority', field: 'action' }, 'owner');
  if (!(candidate instanceof DiscoveryChoiceAuthority) || !DISCOVERY_AUTHORITIES.has(candidate))
    return refused('owner_authority_invalid',
      'Use the trusted owner-discovery-choice CLI for this exact condition option',
      { unit: 'OC1', target: 'authority', field: 'authority' }, 'owner');
  return DISCOVERY_AUTHORITY_EXERCISE.call(candidate, request);
}

export class DiscoveryChoiceSessions {
  readonly #store: Store;
  readonly #live = new Map<string, { session: string; authority: DiscoveryChoiceAuthority }>();
  constructor(store: Store) {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'The Discovery session registry needs a Store');
    this.#store = store;
  }
  sessionOf(bearerDigest: string): string | null { return this.#live.get(bearerDigest)?.session ?? null; }
  exchange(request: unknown): OmResult<Sealed<{ bearer: string; session: Ref; expiresAt: number }>> {
    return run(() => {
      if (!shape(request) || !isText(request.project) || !isText(request.invitation)
        || Object.keys(request).some(key => !['project', 'invitation'].includes(key)))
        deny('owner_invitation_invalid', 'discovery-session', 'request',
          'A Discovery session exchange needs a project and invitation');
      const project = request.project as string, parts = (request.invitation as string).split('.');
      if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!))
        deny('owner_invitation_invalid', project, 'invitation', 'An invitation is <grant-id>.<secret>');
      const found = this.#store.get<DiscoveryChoiceSessionGrant>(`${DISCOVERY_CHOICE_GRANT_PREFIX}${parts[0]}`);
      if (!found) deny('owner_invitation_invalid', project, 'invitation', 'Unknown Discovery invitation');
      const grant = provenDiscoveryChoiceGrant(found);
      if (!timingSafeEqual(Buffer.from(digest(parts[1]!), 'hex'), Buffer.from(grant.value.proof, 'hex')))
        deny('owner_invitation_invalid', project, 'invitation', 'The invitation secret does not verify');
      if (grant.value.database !== this.#store.databaseId || grant.value.scope.project !== project
        || grant.value.action !== DISCOVERY_CHOICE_ACTION)
        deny('owner_invitation_foreign', project, 'invitation',
          'The invitation belongs to another database, project or action');
      const now = Date.now();
      if (grant.value.expiresAt <= now) deny('owner_invitation_expired', project, 'invitation',
        'The Discovery invitation has expired');
      const grantRef = exactRef(reference(grant)), sessionId = discoveryChoiceSessionId(grantRef);
      if (this.#store.get(sessionId)) deny('owner_invitation_spent', project, 'invitation',
        'The Discovery invitation is already exchanged');
      const session: DiscoveryChoiceSession = { contract: DISCOVERY_CHOICE_SESSION_CONTRACT, grant: grantRef,
        database: grant.value.database, action: DISCOVERY_CHOICE_ACTION, method: OWNER_PAIRING_METHOD,
        scope: grant.value.scope, session: randomBytes(16).toString('hex'), openedAt: now,
        expiresAt: now + OWNER_SESSION_LIFETIME_MS, state: 'open' };
      const written = take(writeGuarded<DiscoveryChoiceSession>(this.#store, { unit: 'OC1', target: sessionId,
        writes: [{ id: sessionId, kind: DISCOVERY_CHOICE_SESSION_KIND, expected: 0, value: session }],
        guards: [grantRef] }));
      const bearer = randomBytes(32).toString('hex'), key = digest(bearer);
      this.#live.set(key, { session: sessionId,
        authority: new DiscoveryChoiceAuthority(DISCOVERY_MINT, this, this.#store, key, sessionId, grant.value.scope) });
      return { bearer, session: exactRef(reference(written[0]!)), expiresAt: session.expiresAt };
    });
  }
  authority(bearer: unknown): DiscoveryChoiceAuthority | null {
    return typeof bearer === 'string' && /^[a-f0-9]{64}$/.test(bearer)
      ? this.#live.get(digest(bearer))?.authority ?? null : null;
  }
  revoke(bearer: unknown): OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      const key = typeof bearer === 'string' ? digest(bearer) : null;
      const live = key ? this.#live.get(key) : undefined;
      if (!live) deny('owner_session_missing', 'discovery-session', 'bearer', 'No live Discovery session carries this bearer');
      this.#live.delete(key!);
      const head = this.#store.get<DiscoveryChoiceSession>(live!.session);
      if (!head) deny('owner_session_missing', live!.session, 'session', 'The Discovery session record is absent');
      if (head.value.state === 'closed') return { session: exactRef(reference(head)) };
      const closed: DiscoveryChoiceSession = { ...head.value, state: 'closed', closedAt: Date.now() };
      const written = take(writeGuarded<DiscoveryChoiceSession>(this.#store, { unit: 'OC1', target: head.id,
        writes: [{ id: head.id, kind: DISCOVERY_CHOICE_SESSION_KIND, expected: head.revision, value: closed }],
        guards: [exactRef(reference(head))] }));
      return { session: exactRef(reference(written[0]!)) };
    });
  }
}

/** DR1a: a separate authority branch for the owner project-mode decision — its own action, contracts and scope. */
export const PROJECT_MODE_ACTION = 'project-mode';
export const PROJECT_MODE_GRANT_CONTRACT = 'owner-session-grant/v3';
export const PROJECT_MODE_SESSION_CONTRACT = 'owner-session/v3';
export const PROJECT_MODE_GRANT_PREFIX = 'owner-project-mode-grant:';
export const PROJECT_MODE_SESSION_PREFIX = 'owner-project-mode-session:';
export const PROJECT_MODE_GRANT_KIND = 'owner-session-grant';
export const PROJECT_MODE_SESSION_KIND = 'owner-session';
export type ProjectMode = 'questions' | 'bypass';
export interface ProjectModeScope { project: string; mode: ProjectMode; previous: Ref | null }
export interface ProjectModeSessionGrant {
  contract: typeof PROJECT_MODE_GRANT_CONTRACT; id: string; database: string;
  action: typeof PROJECT_MODE_ACTION; method: typeof OWNER_PAIRING_METHOD; scope: ProjectModeScope;
  issuedAt: number; expiresAt: number; proof: string;
}
export interface ProjectModeSession {
  contract: typeof PROJECT_MODE_SESSION_CONTRACT; grant: Ref; database: string;
  action: typeof PROJECT_MODE_ACTION; method: typeof OWNER_PAIRING_METHOD; scope: ProjectModeScope;
  session: string; openedAt: number; expiresAt: number; state: 'open' | 'closed'; closedAt?: number;
}

export function projectModeSessionId(grant: Ref): string {
  return `${PROJECT_MODE_SESSION_PREFIX}${hashJson({ id: grant.id, revision: grant.revision, hash: grant.hash })}`;
}

function denyMode(code: DiscoveryChoiceAuthorityRefusalCode, target: string, field: string,
  message: string): never {
  deny(code, target, field, message, 'DR1a');
}

function requireProjectModeScope(value: unknown, target = 'owner-project-mode',
  code: DiscoveryChoiceAuthorityRefusalCode = 'project_mode_invalid'): ProjectModeScope {
  if (!shape(value) || !isText(value.project)
    || (value.mode !== 'questions' && value.mode !== 'bypass')
    || (value.previous !== null && !isRef(value.previous))
    || Object.keys(value).some(key => !['project', 'mode', 'previous'].includes(key)))
    denyMode(code, target, 'scope',
      'A project-mode scope names project, mode questions|bypass and the exact previous record or null only');
  return { project: value.project as string, mode: value.mode as ProjectMode,
    previous: value.previous === null ? null : exactRef(value.previous as Ref) };
}

function provenProjectModeGrant(record: Revision<ProjectModeSessionGrant>): Revision<ProjectModeSessionGrant> {
  const value = record.value;
  if (!shape(value) || value.contract !== PROJECT_MODE_GRANT_CONTRACT || !isText(value.id)
    || record.id !== `${PROJECT_MODE_GRANT_PREFIX}${value.id}` || !isText(value.database)
    || value.action !== PROJECT_MODE_ACTION || value.method !== OWNER_PAIRING_METHOD
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt - value.issuedAt !== OWNER_GRANT_LIFETIME_MS
    || typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof)
    || !shape(value.scope) || Object.keys(value).some(key => !['contract', 'id', 'database', 'action', 'method',
      'scope', 'issuedAt', 'expiresAt', 'proof'].includes(key)))
    denyMode('owner_invitation_invalid', record.id, 'contract', 'A project-mode invitation keeps its complete v3 provenance');
  requireProjectModeScope(value.scope, record.id, 'owner_invitation_invalid');
  return record;
}

function provenProjectModeSession(record: Revision<ProjectModeSession>): Revision<ProjectModeSession> {
  const value = record.value;
  if (!shape(value) || value.contract !== PROJECT_MODE_SESSION_CONTRACT || !isRef(value.grant)
    || record.id !== projectModeSessionId(value.grant) || !isText(value.database)
    || value.action !== PROJECT_MODE_ACTION || value.method !== OWNER_PAIRING_METHOD || !isText(value.session)
    || !Number.isSafeInteger(value.openedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt - value.openedAt !== OWNER_SESSION_LIFETIME_MS
    || (value.state !== 'open' && value.state !== 'closed')
    || (value.state === 'closed' && !Number.isSafeInteger(value.closedAt))
    || (value.state === 'open' && Object.hasOwn(value, 'closedAt')) || !shape(value.scope)
    || Object.keys(value).some(key => !['contract', 'grant', 'database', 'action', 'method', 'scope', 'session',
      'openedAt', 'expiresAt', 'state', 'closedAt'].includes(key)))
    denyMode('owner_session_state_invalid', record.id, 'contract', 'A project-mode owner session keeps its complete v3 provenance');
  requireProjectModeScope(value.scope, record.id, 'owner_session_state_invalid');
  return record;
}

export function readProjectModeSessionGrant(store: Store, record: unknown):
  OmResult<Sealed<Revision<ProjectModeSessionGrant>>> {
  return run(() => provenProjectModeGrant(take(readRecord<ProjectModeSessionGrant>(store, record,
    { unit: 'DR1a', target: isRef(record) ? record.id : 'grant', idPrefix: PROJECT_MODE_GRANT_PREFIX,
      kind: PROJECT_MODE_GRANT_KIND }))));
}

export function readProjectModeSession(store: Store, record: unknown):
  OmResult<Sealed<Revision<ProjectModeSession>>> {
  return run(() => provenProjectModeSession(take(readRecord<ProjectModeSession>(store, record,
    { unit: 'DR1a', target: isRef(record) ? record.id : 'session', idPrefix: PROJECT_MODE_SESSION_PREFIX,
      kind: PROJECT_MODE_SESSION_KIND }))));
}

export function issueProjectModeInvitation(store: Store, request: unknown):
  OmResult<Sealed<{ invitation: string; grant: Ref; expiresAt: number }>> {
  return run(() => {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'A project-mode invitation needs a Store');
    const scope = requireProjectModeScope(request);
    const project = store.get(`project:${scope.project}`);
    if (!project) denyMode('owner_project_missing', scope.project, 'project',
      'A project-mode invitation is issued for an existing project only');
    // A previous naming nothing stored would persist a dangling reference inside the grant.
    const previous = scope.previous === null ? null : store.get(scope.previous.id, scope.previous.revision);
    if (scope.previous !== null && (!previous || previous.hash !== scope.previous.hash))
      denyMode('project_mode_stale', scope.project, 'previous', 'The named previous mode record is not stored');
    const secret = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex'), issuedAt = Date.now();
    const grant: ProjectModeSessionGrant = { contract: PROJECT_MODE_GRANT_CONTRACT, id,
      database: store.databaseId, action: PROJECT_MODE_ACTION, method: OWNER_PAIRING_METHOD, scope,
      issuedAt, expiresAt: issuedAt + OWNER_GRANT_LIFETIME_MS, proof: digest(secret) };
    const written = take(writeGuarded<ProjectModeSessionGrant>(store, { unit: 'DR1a',
      target: `${PROJECT_MODE_GRANT_PREFIX}${id}`,
      writes: [{ id: `${PROJECT_MODE_GRANT_PREFIX}${id}`, kind: PROJECT_MODE_GRANT_KIND, expected: 0, value: grant }],
      guards: [exactRef(reference(project))] }));
    return { invitation: `${id}.${secret}`, grant: exactRef(reference(written[0]!)), expiresAt: grant.expiresAt };
  });
}

const PROJECT_MODE_MINT = Symbol('project-mode-authority-mint');
const PROJECT_MODE_AUTHORITIES = new WeakSet<ProjectModeAuthority>();

export class ProjectModeAuthority {
  readonly #sessions: ProjectModeSessions; readonly #store: Store; readonly #digest: string;
  readonly #sessionId: string; readonly #scope: ProjectModeScope;
  constructor(token: symbol, sessions: ProjectModeSessions, store: Store, bearerDigest: string,
    sessionId: string, scope: ProjectModeScope) {
    requireCondition(token === PROJECT_MODE_MINT, 'owner_authority_invalid',
      'Project-mode authority is minted by its scoped session exchange only');
    this.#sessions = sessions; this.#store = store; this.#digest = bearerDigest;
    this.#sessionId = sessionId; this.#scope = scope; PROJECT_MODE_AUTHORITIES.add(this);
  }
  exercise(request: { store: Store; action: string; scope: ProjectModeScope }):
    OmResult<Sealed<{ session: Ref; at: number }>> {
    return run(() => {
      if (!PROJECT_MODE_AUTHORITIES.has(this)) denyMode('owner_authority_invalid', 'authority', 'authority',
        'Project-mode authority is an object of the closed scoped registry');
      if (request.store !== this.#store || request.action !== PROJECT_MODE_ACTION
        || !sameScope(request.scope, this.#scope))
        denyMode('owner_authority_foreign', this.#sessionId, 'scope',
          'Project-mode authority is bound to one Store and one exact mode decision');
      const found = this.#store.get<ProjectModeSession>(this.#sessionId);
      if (!found) denyMode('owner_session_missing', this.#sessionId, 'session', 'The project-mode owner session record is absent');
      const session = provenProjectModeSession(found);
      if (session.value.state !== 'open') denyMode('owner_session_revoked', this.#sessionId, 'session',
        'The project-mode owner session is revoked');
      if (this.#sessions.sessionOf(this.#digest) !== this.#sessionId)
        denyMode('owner_session_missing', this.#sessionId, 'session', 'The project-mode owner session is not live in this process');
      // The single checked instant of authorization — the decision record saves exactly this moment; it must lie
      // inside the saved session window on both sides, so a clock behind openedAt writes nothing.
      const now = Date.now();
      if (now < session.value.openedAt) denyMode('owner_session_expired', this.#sessionId, 'session',
        'The project-mode owner session is not yet open at this time');
      if (session.value.expiresAt <= now) denyMode('owner_session_expired', this.#sessionId, 'session',
        'The project-mode owner session has expired');
      if (session.value.database !== this.#store.databaseId || !sameScope(session.value.scope, this.#scope))
        denyMode('owner_authority_foreign', this.#sessionId, 'scope',
          'The project-mode owner session is bound to another database or decision');
      return { session: exactRef(reference(session)), at: now };
    });
  }
}
const PROJECT_MODE_AUTHORITY_EXERCISE = ProjectModeAuthority.prototype.exercise;

export function requireProjectModeAuthority(candidate: unknown,
  request: { store: Store; action: string; scope: ProjectModeScope }): OmResult<Sealed<{ session: Ref; at: number }>> {
  if (candidate instanceof OwnerAuthority || candidate instanceof DiscoveryChoiceAuthority)
    return refused('owner_authority_foreign', 'Another owner authority cannot authorize a project-mode decision',
      { unit: 'DR1a', target: 'authority', field: 'action' }, 'owner');
  if (!(candidate instanceof ProjectModeAuthority) || !PROJECT_MODE_AUTHORITIES.has(candidate))
    return refused('owner_authority_invalid',
      'Use the trusted owner-project-mode CLI for this exact mode decision',
      { unit: 'DR1a', target: 'authority', field: 'authority' }, 'owner');
  return PROJECT_MODE_AUTHORITY_EXERCISE.call(candidate, request);
}

export class ProjectModeSessions {
  readonly #store: Store;
  readonly #live = new Map<string, { session: string; authority: ProjectModeAuthority }>();
  constructor(store: Store) {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'The project-mode session registry needs a Store');
    this.#store = store;
  }
  sessionOf(bearerDigest: string): string | null { return this.#live.get(bearerDigest)?.session ?? null; }
  exchange(request: unknown): OmResult<Sealed<{ bearer: string; session: Ref; expiresAt: number }>> {
    return run(() => {
      if (!shape(request) || !isText(request.project) || !isText(request.invitation)
        || Object.keys(request).some(key => !['project', 'invitation'].includes(key)))
        denyMode('owner_invitation_invalid', 'project-mode-session', 'request',
          'A project-mode session exchange needs a project and invitation');
      const project = request.project as string, parts = (request.invitation as string).split('.');
      if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!))
        denyMode('owner_invitation_invalid', project, 'invitation', 'An invitation is <grant-id>.<secret>');
      const found = this.#store.get<ProjectModeSessionGrant>(`${PROJECT_MODE_GRANT_PREFIX}${parts[0]}`);
      if (!found) denyMode('owner_invitation_invalid', project, 'invitation', 'Unknown project-mode invitation');
      const grant = provenProjectModeGrant(found);
      if (!timingSafeEqual(Buffer.from(digest(parts[1]!), 'hex'), Buffer.from(grant.value.proof, 'hex')))
        denyMode('owner_invitation_invalid', project, 'invitation', 'The invitation secret does not verify');
      if (grant.value.database !== this.#store.databaseId || grant.value.scope.project !== project
        || grant.value.action !== PROJECT_MODE_ACTION)
        denyMode('owner_invitation_foreign', project, 'invitation',
          'The invitation belongs to another database, project or action');
      const now = Date.now();
      // The exchange moment must lie inside the saved grant window: a clock behind issuedAt would write a session
      // whose own reader later refuses the chain.
      if (now < grant.value.issuedAt) denyMode('owner_invitation_invalid', project, 'invitation',
        'The project-mode invitation is not yet issued at this time');
      if (grant.value.expiresAt <= now) denyMode('owner_invitation_expired', project, 'invitation',
        'The project-mode invitation has expired');
      const grantRef = exactRef(reference(grant)), sessionId = projectModeSessionId(grantRef);
      if (this.#store.get(sessionId)) denyMode('owner_invitation_spent', project, 'invitation',
        'The project-mode invitation is already exchanged');
      const session: ProjectModeSession = { contract: PROJECT_MODE_SESSION_CONTRACT, grant: grantRef,
        database: grant.value.database, action: PROJECT_MODE_ACTION, method: OWNER_PAIRING_METHOD,
        scope: grant.value.scope, session: randomBytes(16).toString('hex'), openedAt: now,
        expiresAt: now + OWNER_SESSION_LIFETIME_MS, state: 'open' };
      const written = take(writeGuarded<ProjectModeSession>(this.#store, { unit: 'DR1a', target: sessionId,
        writes: [{ id: sessionId, kind: PROJECT_MODE_SESSION_KIND, expected: 0, value: session }],
        guards: [grantRef] }));
      const bearer = randomBytes(32).toString('hex'), key = digest(bearer);
      this.#live.set(key, { session: sessionId,
        authority: new ProjectModeAuthority(PROJECT_MODE_MINT, this, this.#store, key, sessionId, grant.value.scope) });
      return { bearer, session: exactRef(reference(written[0]!)), expiresAt: session.expiresAt };
    });
  }
  authority(bearer: unknown): ProjectModeAuthority | null {
    return typeof bearer === 'string' && /^[a-f0-9]{64}$/.test(bearer)
      ? this.#live.get(digest(bearer))?.authority ?? null : null;
  }
  revoke(bearer: unknown): OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      const key = typeof bearer === 'string' ? digest(bearer) : null;
      const live = key ? this.#live.get(key) : undefined;
      if (!live) denyMode('owner_session_missing', 'project-mode-session', 'bearer',
        'No live project-mode session carries this bearer');
      this.#live.delete(key!);
      const head = this.#store.get<ProjectModeSession>(live!.session);
      if (!head) denyMode('owner_session_missing', live!.session, 'session', 'The project-mode session record is absent');
      if (head.value.state === 'closed') return { session: exactRef(reference(head)) };
      const closed: ProjectModeSession = { ...head.value, state: 'closed', closedAt: Date.now() };
      const written = take(writeGuarded<ProjectModeSession>(this.#store, { unit: 'DR1a', target: head.id,
        writes: [{ id: head.id, kind: PROJECT_MODE_SESSION_KIND, expected: head.revision, value: closed }],
        guards: [exactRef(reference(head))] }));
      return { session: exactRef(reference(written[0]!)) };
    });
  }
}

/** 4O.1: a separate, exact capability for one prospective variant choice. */
export const VARIANT_CHOICE_GRANT_PREFIX = 'owner-variant-grant:';
export const VARIANT_CHOICE_SESSION_PREFIX = 'owner-variant-session:';
export interface VariantChoiceSessionGrant {
  contract: typeof VARIANT_OWNER_GRANT_CONTRACT; id: string; database: string;
  action: typeof VARIANT_OWNER_ACTION; method: typeof OWNER_PAIRING_METHOD; scope: VariantChoiceScope;
  issuedAt: number; expiresAt: number; proof: string;
}
export interface VariantChoiceSession {
  contract: typeof VARIANT_OWNER_SESSION_CONTRACT; grant: Ref; database: string;
  action: typeof VARIANT_OWNER_ACTION; method: typeof OWNER_PAIRING_METHOD; scope: VariantChoiceScope;
  session: string; openedAt: number; expiresAt: number; state: 'open' | 'closed'; closedAt?: number;
}
export function variantChoiceSessionId(grant: Ref): string {
  requireCondition(isRef(grant), 'owner_session_state_invalid', 'A variant session address needs an exact grant Ref');
  return `${VARIANT_CHOICE_SESSION_PREFIX}${hashJson(exactRef(grant))}`;
}
function denyVariant(code: OwnerAuthorityRefusalCode, target: string, field: string, message: string): never {
  return deny(code, target, field, message, '4O.1');
}
function variantChoiceScope(value: unknown, code: OwnerAuthorityRefusalCode): VariantChoiceScope {
  try { return decodeVariantChoiceScope(value); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return denyVariant(code, 'variant-choice', 'scope', error.message);
  }
}
/** This door proves saved grounds; the later decision producer proves operation/current-state admissibility. */
function variantChoiceGrounds(store: Store, scope: VariantChoiceScope): void {
  let field = 'mode', ref = scope.mode;
  try {
    readProjectMode(store, scope.projectId, scope.mode);
    field = 'set'; ref = scope.set;
    const generation = readVariantGeneration(store, scope.projectId, scope.set), publication = generation.publication;
    requireCondition(publication.result.kind === 'discovery-variant-set'
      && sameScope(publication.result.value.draft, scope.draft), 'discovery_variant_basis_invalid',
      'Variant authority needs the exact draft and a proven paid set');
    if (scope.outcome.kind === 'choose') {
      const member = scope.outcome.member;
      requireCondition(publication.members.some(row => sameScope(row.ref, member)), 'discovery_variant_basis_invalid',
        'Variant authority chooses an exact member of its proven set');
    }
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    take(refused(error.code, error.message, { unit: '4O.1', target: scope.projectId, field, ref }, 'owner'));
  }
}
function provenVariantGrant(store: Store, record: Revision<VariantChoiceSessionGrant>): Revision<VariantChoiceSessionGrant> {
  const value = record.value;
  if (record.revision !== 1 || record.kind !== OWNER_GRANT_KIND || !shape(value)
    || value.contract !== VARIANT_OWNER_GRANT_CONTRACT || !/^[a-f0-9]{32}$/.test(value.id)
    || record.id !== `${VARIANT_CHOICE_GRANT_PREFIX}${value.id}` || value.database !== store.databaseId
    || value.action !== VARIANT_OWNER_ACTION || value.method !== OWNER_PAIRING_METHOD
    || !Number.isSafeInteger(value.issuedAt) || value.issuedAt <= 0 || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt - value.issuedAt !== OWNER_GRANT_LIFETIME_MS
    || typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof)
    || Object.keys(value).some(key => !['contract', 'id', 'database', 'action', 'method', 'scope',
      'issuedAt', 'expiresAt', 'proof'].includes(key)))
    denyVariant('owner_invitation_invalid', record.id, 'contract', 'A variant grant retains its exact v4 origin and database');
  const scope = variantChoiceScope(value.scope, 'owner_invitation_invalid');
  variantChoiceGrounds(store, scope);
  return record;
}
export function readVariantChoiceSessionGrant(store: Store, ref: unknown): OmResult<Sealed<Revision<VariantChoiceSessionGrant>>> {
  return run(() => {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'A variant grant reader needs a Store');
    return provenVariantGrant(store, take(readRecord<VariantChoiceSessionGrant>(store, ref,
      { unit: '4O.1', target: 'variant-grant', idPrefix: VARIANT_CHOICE_GRANT_PREFIX, kind: OWNER_GRANT_KIND })));
  });
}
export function readVariantChoiceSession(store: Store, ref: unknown): OmResult<Sealed<Revision<VariantChoiceSession>>> {
  return run(() => {
    requireCondition(store instanceof Store, 'owner_session_state_invalid', 'A variant session reader needs a Store');
    const row = take(readRecord<VariantChoiceSession>(store, ref,
      { unit: '4O.1', target: 'variant-session', idPrefix: VARIANT_CHOICE_SESSION_PREFIX, kind: OWNER_SESSION_KIND }));
    const value = row.value;
    if (!shape(value) || value.contract !== VARIANT_OWNER_SESSION_CONTRACT || !isRef(value.grant)
      || !sameScope(value.grant, exactRef(value.grant))
      || row.id !== variantChoiceSessionId(value.grant) || value.database !== store.databaseId
      || value.action !== VARIANT_OWNER_ACTION || value.method !== OWNER_PAIRING_METHOD
      || typeof value.session !== 'string' || !/^[a-f0-9]{32}$/.test(value.session)
      || !Number.isSafeInteger(value.openedAt) || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt - value.openedAt !== OWNER_SESSION_LIFETIME_MS
      || (value.state !== 'open' && value.state !== 'closed')
      || (value.state === 'open' && (row.revision !== 1 || Object.hasOwn(value, 'closedAt')))
      || (value.state === 'closed' && (row.revision !== 2 || !Number.isSafeInteger(value.closedAt)
        || value.closedAt! < value.openedAt))
      || Object.keys(value).some(key => !['contract', 'grant', 'database', 'action', 'method', 'scope',
        'session', 'openedAt', 'expiresAt', 'state', 'closedAt'].includes(key)))
      denyVariant('owner_session_state_invalid', row.id, 'contract', 'A variant session retains its exact open or revoked v4 origin');
    variantChoiceScope(value.scope, 'owner_session_state_invalid');
    const grant = take(readVariantChoiceSessionGrant(store, value.grant));
    if (!sameScope(value.scope, grant.value.scope) || value.openedAt < grant.value.issuedAt
      || value.openedAt >= grant.value.expiresAt)
      denyVariant('owner_session_state_invalid', row.id, 'grant', 'A session descends from its exact scoped grant inside its saved window');
    if (value.state === 'closed') {
      const first = store.get<VariantChoiceSession>(row.id, 1);
      if (!first) denyVariant('owner_session_state_invalid', row.id, 'session', 'The initial open session is absent');
      const opened = take(readVariantChoiceSession(store, reference(first)));
      const { closedAt: _closed, ...rest } = value;
      if (!sameScope({ ...rest, state: 'open' }, opened.value))
        denyVariant('owner_session_state_invalid', row.id, 'session', 'Revocation changes only state and closedAt');
    }
    return row;
  });
}
export function issueVariantChoiceInvitation(store: Store, request: unknown):
  OmResult<Sealed<{ invitation: string; grant: Ref; expiresAt: number }>> {
  return run(() => {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'A variant invitation needs a Store');
    const scope = variantChoiceScope(request, 'owner_invitation_invalid');
    const project = store.get(`project:${scope.projectId}`);
    if (!project) denyVariant('owner_project_missing', scope.projectId, 'projectId', 'A variant invitation needs its project');
    variantChoiceGrounds(store, scope);
    const secret = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex'), issuedAt = Date.now();
    const value: VariantChoiceSessionGrant = { contract: VARIANT_OWNER_GRANT_CONTRACT, id, database: store.databaseId,
      action: VARIANT_OWNER_ACTION, method: OWNER_PAIRING_METHOD, scope, issuedAt,
      expiresAt: issuedAt + OWNER_GRANT_LIFETIME_MS, proof: digest(secret) };
    const rows = take(writeGuarded<VariantChoiceSessionGrant>(store, { unit: '4O.1', target: `${VARIANT_CHOICE_GRANT_PREFIX}${id}`,
      writes: [{ id: `${VARIANT_CHOICE_GRANT_PREFIX}${id}`, kind: OWNER_GRANT_KIND, expected: 0, value }],
      guards: [reference(project)] }));
    return { invitation: `${id}.${secret}`, grant: exactRef(reference(rows[0]!)), expiresAt: value.expiresAt };
  });
}
const VARIANT_CHOICE_MINT = Symbol('variant-choice-authority-mint');
const VARIANT_CHOICE_AUTHORITIES = new WeakSet<VariantChoiceAuthority>();
export class VariantChoiceAuthority {
  readonly #sessions: VariantChoiceSessions; readonly #store: Store; readonly #digest: string;
  readonly #session: Ref; readonly #scope: VariantChoiceScope;
  constructor(token: symbol, sessions: VariantChoiceSessions, store: Store, key: string, session: Ref, scope: VariantChoiceScope) {
    requireCondition(token === VARIANT_CHOICE_MINT, 'owner_authority_invalid', 'Only variant invitation exchange mints this authority');
    this.#sessions = sessions; this.#store = store; this.#digest = key;
    this.#session = exactRef(session); this.#scope = structuredClone(scope); VARIANT_CHOICE_AUTHORITIES.add(this);
  }
  exercise(request: { store: Store; action: string; scope: VariantChoiceScope }): OmResult<Sealed<{ session: Ref; at: number }>> {
    return run(() => {
      if (!VARIANT_CHOICE_AUTHORITIES.has(this)) denyVariant('owner_authority_invalid', 'authority', 'authority', 'Unknown variant authority');
      if (!shape(request) || request.store !== this.#store || request.action !== VARIANT_OWNER_ACTION
        || Object.keys(request).some(key => !['store', 'action', 'scope'].includes(key)))
        denyVariant('owner_authority_foreign', this.#session.id, 'action', 'Variant authority belongs to its Store and action');
      const scope = variantChoiceScope(request.scope, 'owner_authority_foreign');
      if (!sameScope(scope, this.#scope)) denyVariant('owner_authority_foreign', this.#session.id, 'scope', 'Variant authority covers one full exact scope');
      const head = this.#store.get<VariantChoiceSession>(this.#session.id);
      if (!head) denyVariant('owner_session_missing', this.#session.id, 'session', 'The variant session is absent');
      const session = take(readVariantChoiceSession(this.#store, reference(head)));
      if (session.value.state !== 'open') denyVariant('owner_session_revoked', head.id, 'session', 'The variant session is revoked');
      if (!sameScope(reference(session), this.#session) || !sameScope(session.value.scope, this.#scope))
        denyVariant('owner_authority_foreign', head.id, 'session', 'The original variant session cannot be substituted');
      if (VARIANT_CHOICE_SESSION_OF.call(this.#sessions, this.#digest) !== this.#session.id)
        denyVariant('owner_session_missing', head.id, 'session', 'The bearer is not live in this process');
      const at = Date.now();
      if (at < session.value.openedAt || at >= session.value.expiresAt)
        denyVariant('owner_session_expired', head.id, 'session', 'The variant session is outside its live window');
      return { session: exactRef(reference(session)), at };
    });
  }
}
const VARIANT_CHOICE_EXERCISE = VariantChoiceAuthority.prototype.exercise;
export function requireVariantChoiceAuthority(candidate: unknown,
  request: { store: Store; action: string; scope: VariantChoiceScope }): OmResult<Sealed<{ session: Ref; at: number }>> {
  if (candidate instanceof OwnerAuthority || candidate instanceof DiscoveryChoiceAuthority || candidate instanceof ProjectModeAuthority)
    return refused('owner_authority_foreign', 'Another owner action cannot authorize a variant choice',
      { unit: '4O.1', target: 'authority', field: 'action' }, 'owner');
  if (!(candidate instanceof VariantChoiceAuthority) || !VARIANT_CHOICE_AUTHORITIES.has(candidate))
    return refused('owner_authority_invalid', 'Use the local variant invitation and its live bearer',
      { unit: '4O.1', target: 'authority', field: 'authority' }, 'owner');
  return VARIANT_CHOICE_EXERCISE.call(candidate, request);
}
export class VariantChoiceSessions {
  readonly #store: Store;
  readonly #live = new Map<string, { session: string; authority: VariantChoiceAuthority }>();
  constructor(store: Store) {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'Variant sessions need a Store'); this.#store = store;
  }
  sessionOf(key: string): string | null { return this.#live.get(key)?.session ?? null; }
  exchange(request: unknown): OmResult<Sealed<{ bearer: string; session: Ref; expiresAt: number }>> {
    return run(() => {
      if (!shape(request) || !isText(request.projectId) || !isText(request.invitation)
        || Object.keys(request).some(key => !['projectId', 'invitation'].includes(key)))
        denyVariant('owner_invitation_invalid', 'variant-session', 'request', 'Exchange names projectId and local invitation only');
      const projectId = request.projectId as string, parts = (request.invitation as string).split('.');
      if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!))
        denyVariant('owner_invitation_invalid', projectId, 'invitation', 'An invitation is <grant-id>.<secret>');
      const head = this.#store.get<VariantChoiceSessionGrant>(`${VARIANT_CHOICE_GRANT_PREFIX}${parts[0]}`);
      if (!head) denyVariant('owner_invitation_invalid', projectId, 'invitation', 'Unknown variant invitation');
      const grant = take(readVariantChoiceSessionGrant(this.#store, reference(head)));
      if (!timingSafeEqual(Buffer.from(digest(parts[1]!), 'hex'), Buffer.from(grant.value.proof, 'hex')))
        denyVariant('owner_invitation_invalid', projectId, 'invitation', 'The invitation secret does not verify');
      if (grant.value.scope.projectId !== projectId) denyVariant('owner_invitation_foreign', projectId, 'projectId', 'Invitation belongs to another project');
      const now = Date.now();
      if (now < grant.value.issuedAt) denyVariant('owner_invitation_invalid', projectId, 'invitation', 'Invitation is not yet issued');
      if (now >= grant.value.expiresAt) denyVariant('owner_invitation_expired', projectId, 'invitation', 'Invitation has expired');
      const grantRef = exactRef(reference(grant)), id = variantChoiceSessionId(grantRef);
      if (this.#store.get(id)) denyVariant('owner_invitation_spent', projectId, 'invitation', 'Invitation is already exchanged');
      const value: VariantChoiceSession = { contract: VARIANT_OWNER_SESSION_CONTRACT, grant: grantRef,
        database: this.#store.databaseId, action: VARIANT_OWNER_ACTION, method: OWNER_PAIRING_METHOD,
        scope: grant.value.scope, session: randomBytes(16).toString('hex'), openedAt: now,
        expiresAt: now + OWNER_SESSION_LIFETIME_MS, state: 'open' };
      const rows = take(writeGuarded<VariantChoiceSession>(this.#store, { unit: '4O.1', target: id,
        writes: [{ id, kind: OWNER_SESSION_KIND, expected: 0, value }], guards: [grantRef] }));
      const session = exactRef(reference(rows[0]!)), bearer = randomBytes(32).toString('hex'), key = digest(bearer);
      this.#live.set(key, { session: id, authority: new VariantChoiceAuthority(VARIANT_CHOICE_MINT, this,
        this.#store, key, session, grant.value.scope) });
      return { bearer, session, expiresAt: value.expiresAt };
    });
  }
  authority(bearer: unknown): VariantChoiceAuthority | null {
    return typeof bearer === 'string' && /^[a-f0-9]{64}$/.test(bearer) ? this.#live.get(digest(bearer))?.authority ?? null : null;
  }
  revoke(bearer: unknown, store: Store = this.#store): OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      const key = typeof bearer === 'string' ? digest(bearer) : '', live = this.#live.get(key);
      if (!live) denyVariant('owner_session_missing', 'variant-session', 'bearer', 'No variant session carries this bearer');
      if (!(store instanceof Store) || store.databaseId !== this.#store.databaseId)
        denyVariant('owner_authority_foreign', live.session, 'database', 'Revocation needs the same database');
      const head = store.get<VariantChoiceSession>(live.session);
      if (!head) denyVariant('owner_session_missing', live.session, 'session', 'The variant session is absent');
      const opened = take(readVariantChoiceSession(store, reference(head)));
      if (opened.value.state === 'closed') { this.#live.delete(key); return { session: exactRef(reference(opened)) }; }
      const closed: VariantChoiceSession = { ...opened.value, state: 'closed', closedAt: Math.max(Date.now(), opened.value.openedAt) };
      const rows = take(writeGuarded<VariantChoiceSession>(store, { unit: '4O.1', target: head.id,
        writes: [{ id: head.id, kind: OWNER_SESSION_KIND, expected: head.revision, value: closed }], guards: [reference(opened)] }));
      this.#live.delete(key); return { session: exactRef(reference(rows[0]!)) };
    });
  }
}
const VARIANT_CHOICE_SESSION_OF = VariantChoiceSessions.prototype.sessionOf;


// ---- 5.7/Р3 (codex-omg №14393): the owner increase of the Discovery v7 stage budget — a separate versioned branch ------
// One exact capability for one approved raise: database (the grant's), project, the discovery stage, the exact previous
// segment revision and the new finite limit. Its saved forms and historical proofs live in stage-token-budget.ts; the
// unforgeable authority, the session registry and the single producer live here. No other owner action, actor string,
// owner flag or bypass mode authorizes it.
type StageBudgetRefusalCode = OwnerAuthorityRefusalCode | 'discovery_budget_increase_invalid' | 'discovery_budget_increase_stale';
function denyBudget(code: StageBudgetRefusalCode, target: string, field: string, message: string): never {
  deny(code as DiscoveryChoiceAuthorityRefusalCode, target, field, message, 'DR5.7');
}
function budgetScope(value: unknown, code: StageBudgetRefusalCode, target = 'owner-stage-budget'): StageBudgetScope {
  try { return requireStageBudgetScope(value); }
  catch (error) {
    if (error instanceof EngineError) denyBudget(code, target, 'scope', error.message);
    throw error;
  }
}
function provenBudgetRecord<T>(read: () => T, code: StageBudgetRefusalCode, target: string): T {
  try { return read(); }
  catch (error) {
    if (error instanceof EngineError) denyBudget(code, target, 'record', error.message);
    throw error;
  }
}

/** The trusted CLI's one-use invitation for one exact raise of the current proven stage budget. */
export function issueStageBudgetInvitation(store: Store, request: unknown):
  OmResult<Sealed<{ invitation: string; grant: Ref; expiresAt: number }>> {
  return run(() => {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'A stage-budget invitation needs a Store');
    const scope = budgetScope(request, 'owner_invitation_invalid');
    const project = store.get(`project:${scope.project}`);
    if (!project) denyBudget('owner_project_missing', scope.project, 'project', 'A stage-budget invitation is issued for an existing project only');
    const effective = provenBudgetRecord(() => readEffectiveStageBudget(store, scope.project), 'owner_invitation_invalid', scope.project);
    if (!effective.segment || !sameScope(reference(effective.segment), scope.previous))
      denyBudget('discovery_budget_increase_stale', scope.project, 'previous', 'The named previous segment revision is not the proven current stage budget');
    if (scope.limit <= effective.limit)
      denyBudget('discovery_budget_increase_invalid', scope.project, 'limit', 'An increase names a finite limit above the current stage limit');
    const secret = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex'), issuedAt = Date.now();
    const grant: StageBudgetSessionGrant = { contract: STAGE_BUDGET_GRANT_CONTRACT, id, database: store.databaseId,
      action: STAGE_BUDGET_ACTION, method: STAGE_BUDGET_PAIRING_METHOD, scope, issuedAt,
      expiresAt: issuedAt + STAGE_BUDGET_GRANT_LIFETIME_MS, proof: digest(secret) };
    const written = take(writeGuarded<StageBudgetSessionGrant>(store, { unit: 'DR5.7', target: `${STAGE_BUDGET_GRANT_PREFIX}${id}`,
      writes: [{ id: `${STAGE_BUDGET_GRANT_PREFIX}${id}`, kind: STAGE_BUDGET_GRANT_KIND, expected: 0, value: grant }],
      guards: [exactRef(reference(project)), exactRef(reference(effective.segment!))] }));
    return { invitation: `${id}.${secret}`, grant: exactRef(reference(written[0]!)), expiresAt: grant.expiresAt };
  });
}

const STAGE_BUDGET_MINT = Symbol('stage-budget-authority-mint');
const STAGE_BUDGET_AUTHORITIES = new WeakSet<StageBudgetAuthority>();

export class StageBudgetAuthority {
  readonly #sessions: StageBudgetSessions; readonly #store: Store; readonly #digest: string;
  readonly #sessionId: string; readonly #session: Ref; readonly #scope: StageBudgetScope;
  constructor(token: symbol, sessions: StageBudgetSessions, store: Store, bearerDigest: string,
    session: Ref, scope: StageBudgetScope) {
    requireCondition(token === STAGE_BUDGET_MINT, 'owner_authority_invalid',
      'Stage-budget authority is minted by its scoped session exchange only');
    this.#sessions = sessions; this.#store = store; this.#digest = bearerDigest;
    this.#session = exactRef(session); this.#sessionId = this.#session.id; this.#scope = structuredClone(scope);
    STAGE_BUDGET_AUTHORITIES.add(this);
  }
  exercise(request: { store: Store; action: string; scope: StageBudgetScope }):
    OmResult<Sealed<{ session: Ref; at: number }>> {
    return run(() => {
      if (!STAGE_BUDGET_AUTHORITIES.has(this)) denyBudget('owner_authority_invalid', 'authority', 'authority',
        'Stage-budget authority is an object of the closed scoped registry');
      if (request.store !== this.#store || request.action !== STAGE_BUDGET_ACTION || !sameScope(request.scope, this.#scope))
        denyBudget('owner_authority_foreign', this.#sessionId, 'scope',
          'Stage-budget authority is bound to one Store and one exact raise');
      const found = this.#store.get<StageBudgetSession>(this.#sessionId);
      if (!found) denyBudget('owner_session_missing', this.#sessionId, 'session', 'The stage-budget owner session record is absent');
      const session = provenBudgetRecord(() => readStageBudgetSession(this.#store, reference(found!)), 'owner_session_state_invalid', this.#sessionId);
      if (session.value.state !== 'open') denyBudget('owner_session_revoked', this.#sessionId, 'session',
        'The stage-budget owner session is revoked');
      if (!sameScope(reference(session), this.#session))
        denyBudget('owner_authority_foreign', this.#sessionId, 'session', 'The original stage-budget session cannot be substituted');
      if (this.#sessions.sessionOf(this.#digest) !== this.#sessionId)
        denyBudget('owner_session_missing', this.#sessionId, 'session', 'The stage-budget owner session is not live in this process');
      const now = Date.now();
      if (now < session.value.openedAt) denyBudget('owner_session_expired', this.#sessionId, 'session',
        'The stage-budget owner session is not yet open at this time');
      if (session.value.expiresAt <= now) denyBudget('owner_session_expired', this.#sessionId, 'session',
        'The stage-budget owner session has expired');
      if (session.value.database !== this.#store.databaseId || !sameScope(session.value.scope, this.#scope))
        denyBudget('owner_authority_foreign', this.#sessionId, 'scope',
          'The stage-budget owner session is bound to another database or raise');
      return { session: exactRef(reference(session)), at: now };
    });
  }
}
const STAGE_BUDGET_AUTHORITY_EXERCISE = StageBudgetAuthority.prototype.exercise;

export function requireStageBudgetAuthority(candidate: unknown,
  request: { store: Store; action: string; scope: StageBudgetScope }): OmResult<Sealed<{ session: Ref; at: number }>> {
  if (candidate instanceof OwnerAuthority || candidate instanceof DiscoveryChoiceAuthority
    || candidate instanceof ProjectModeAuthority || candidate instanceof VariantChoiceAuthority)
    return refused('owner_authority_foreign', 'Another owner authority cannot authorize a stage-budget increase',
      { unit: 'DR5.7', target: 'authority', field: 'action' }, 'owner');
  if (!(candidate instanceof StageBudgetAuthority) || !STAGE_BUDGET_AUTHORITIES.has(candidate))
    return refused('owner_authority_invalid', 'Use the trusted owner stage-budget door for this exact raise',
      { unit: 'DR5.7', target: 'authority', field: 'authority' }, 'owner');
  return STAGE_BUDGET_AUTHORITY_EXERCISE.call(candidate, request);
}

export class StageBudgetSessions {
  readonly #store: Store;
  readonly #live = new Map<string, { session: string; authority: StageBudgetAuthority }>();
  constructor(store: Store) {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'The stage-budget session registry needs a Store');
    this.#store = store;
  }
  sessionOf(bearerDigest: string): string | null { return this.#live.get(bearerDigest)?.session ?? null; }
  exchange(request: unknown): OmResult<Sealed<{ bearer: string; session: Ref; expiresAt: number }>> {
    return run(() => {
      if (!shape(request) || !isText(request.project) || !isText(request.invitation)
        || Object.keys(request).some(key => !['project', 'invitation'].includes(key)))
        denyBudget('owner_invitation_invalid', 'stage-budget-session', 'request', 'A stage-budget session exchange needs a project and invitation');
      const project = request.project as string, parts = (request.invitation as string).split('.');
      if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!))
        denyBudget('owner_invitation_invalid', project, 'invitation', 'An invitation is <grant-id>.<secret>');
      const found = this.#store.get<StageBudgetSessionGrant>(`${STAGE_BUDGET_GRANT_PREFIX}${parts[0]}`);
      if (!found) denyBudget('owner_invitation_invalid', project, 'invitation', 'Unknown stage-budget invitation');
      const grant = provenBudgetRecord(() => readStageBudgetGrant(this.#store, reference(found!)), 'owner_invitation_invalid', project);
      if (!timingSafeEqual(Buffer.from(digest(parts[1]!), 'hex'), Buffer.from(grant.value.proof, 'hex')))
        denyBudget('owner_invitation_invalid', project, 'invitation', 'The invitation secret does not verify');
      if (grant.value.database !== this.#store.databaseId || grant.value.scope.project !== project
        || grant.value.action !== STAGE_BUDGET_ACTION)
        denyBudget('owner_invitation_foreign', project, 'invitation', 'The invitation belongs to another database, project or action');
      const now = Date.now();
      if (now < grant.value.issuedAt) denyBudget('owner_invitation_invalid', project, 'invitation',
        'The stage-budget invitation is not yet issued at this time');
      if (grant.value.expiresAt <= now) denyBudget('owner_invitation_expired', project, 'invitation',
        'The stage-budget invitation has expired');
      const grantRef = exactRef(reference(grant)), sessionId = stageBudgetSessionId(grantRef);
      if (this.#store.get(sessionId)) denyBudget('owner_invitation_spent', project, 'invitation',
        'The stage-budget invitation is already exchanged');
      const session: StageBudgetSession = { contract: STAGE_BUDGET_SESSION_CONTRACT, grant: grantRef,
        database: grant.value.database, action: STAGE_BUDGET_ACTION, method: STAGE_BUDGET_PAIRING_METHOD,
        scope: grant.value.scope, session: randomBytes(16).toString('hex'), openedAt: now,
        expiresAt: now + STAGE_BUDGET_SESSION_LIFETIME_MS, state: 'open' };
      const written = take(writeGuarded<StageBudgetSession>(this.#store, { unit: 'DR5.7', target: sessionId,
        writes: [{ id: sessionId, kind: STAGE_BUDGET_SESSION_KIND, expected: 0, value: session }], guards: [grantRef] }));
      const bearer = randomBytes(32).toString('hex'), key = digest(bearer), opened = exactRef(reference(written[0]!));
      this.#live.set(key, { session: sessionId,
        authority: new StageBudgetAuthority(STAGE_BUDGET_MINT, this, this.#store, key, opened, grant.value.scope) });
      return { bearer, session: opened, expiresAt: session.expiresAt };
    });
  }
  authority(bearer: unknown): StageBudgetAuthority | null {
    return typeof bearer === 'string' && /^[a-f0-9]{64}$/.test(bearer) ? this.#live.get(digest(bearer))?.authority ?? null : null;
  }
  revoke(bearer: unknown): OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      const key = typeof bearer === 'string' ? digest(bearer) : null;
      const live = key ? this.#live.get(key) : undefined;
      if (!live) denyBudget('owner_session_missing', 'stage-budget-session', 'bearer', 'No live stage-budget session carries this bearer');
      this.#live.delete(key!);
      const head = this.#store.get<StageBudgetSession>(live!.session);
      if (!head) denyBudget('owner_session_missing', live!.session, 'session', 'The stage-budget session record is absent');
      if (head!.value.state === 'closed') return { session: exactRef(reference(head!)) };
      const closed: StageBudgetSession = { ...head!.value, state: 'closed', closedAt: Date.now() };
      const written = take(writeGuarded<StageBudgetSession>(this.#store, { unit: 'DR5.7', target: head!.id,
        writes: [{ id: head!.id, kind: STAGE_BUDGET_SESSION_KIND, expected: head!.revision, value: closed }],
        guards: [exactRef(reference(head!))] }));
      return { session: exactRef(reference(written[0]!)) };
    });
  }
}

export interface StageBudgetIncreaseOutcome {
  segment: Revision<BudgetSegment>; increase: Revision<StageBudgetIncrease>; repeated: boolean;
}
function increaseFailure(result: OmResult<unknown>): never {
  if (result.ok) throw new EngineError('owner_authority_internal', 'Authority refusal unexpectedly delivered a value');
  throw new EngineError(result.refusal.code, result.refusal.message, { ...result.refusal.at, door: 'owner-stage-budget' });
}
/**
 * 5.7/Р3: the single protected producer of a stage-budget increase. Only a minted stage-budget authority bound to this
 * exact raise may write: the next segment revision — the previous body with only the higher limit — and the act that
 * names it, atomically, under the CAS of the previous revision and the guard of the exact open session. Ledger, working
 * limits, reserve and past spend are untouched; no model is sent. The same act again returns the saved one.
 */
export function increaseStageBudget(store: Store, request: unknown, authority: unknown): StageBudgetIncreaseOutcome {
  if (!(authority instanceof StageBudgetAuthority))
    return increaseFailure(requireStageBudgetAuthority(authority, { store, action: STAGE_BUDGET_ACTION,
      scope: { project: '', stage: 'discovery', previous: { id: '', revision: 1, hash: '' }, limit: 1 } }));
  const scope = (() => { const parsed = run(() => budgetScope(request, 'discovery_budget_increase_invalid')); return parsed.ok ? parsed.value : increaseFailure(parsed); })();
  const admitted = requireStageBudgetAuthority(authority, { store, action: STAGE_BUDGET_ACTION, scope });
  if (!admitted.ok) return increaseFailure(admitted);
  const project = store.get(`project:${scope.project}`);
  if (!project) throw new EngineError('owner_project_missing', 'A stage-budget increase addresses an existing project only',
    { project: scope.project, door: 'owner-stage-budget' });
  const segId = stageBudgetSegmentId(scope.project);
  const repeatOf = (head: Revision<BudgetSegment>): StageBudgetIncreaseOutcome | null => {
    const act = store.get<StageBudgetIncrease>(stageBudgetIncreaseId(scope.project, head.revision), 1);
    return act && sameScope(act.value.authority.scope, scope) ? { segment: head, increase: act, repeated: true } : null;
  };
  const effective = readEffectiveStageBudget(store, scope.project);
  if (!effective.segment) throw new EngineError('discovery_budget_increase_invalid', 'The stage has no budget to raise',
    { project: scope.project, door: 'owner-stage-budget' });
  const head = effective.segment;
  const repeated = repeatOf(head);
  if (repeated) return repeated;
  if (!sameScope(reference(head), scope.previous))
    throw new EngineError('discovery_budget_increase_stale', 'The stage budget moved since this raise was scoped',
      { project: scope.project, expected: scope.previous, actual: reference(head), door: 'owner-stage-budget' });
  if (scope.limit <= head.value.limit)
    throw new EngineError('discovery_budget_increase_invalid', 'An increase names a finite limit above the current stage limit',
      { project: scope.project, limit: scope.limit, current: head.value.limit, door: 'owner-stage-budget' });
  // The second exercise closes the check-to-write window; the pinned session revision is a transaction guard.
  const applied = requireStageBudgetAuthority(authority, { store, action: STAGE_BUDGET_ACTION, scope });
  if (!applied.ok) return increaseFailure(applied);
  const prior = effective.increases.at(-1);
  if (prior && store.get<StageBudgetIncrease>(prior.id, prior.revision)!.value.at > applied.value.at)
    throw new EngineError('discovery_budget_increase_stale', 'The increase is not younger than the increase before it',
      { project: scope.project, door: 'owner-stage-budget' });
  const raised: BudgetSegment = { ...head.value, limit: scope.limit };
  const act: StageBudgetIncrease = { contract: STAGE_BUDGET_INCREASE_CONTRACT, database: store.databaseId, project: scope.project,
    stage: 'discovery', segment: { id: segId, revision: head.revision + 1, hash: hashJson(raised as never) },
    previous: exactRef(reference(head)), limit: scope.limit, authority: { session: applied.value.session, scope }, at: applied.value.at };
  try {
    const written = store.writeMany<unknown>([
      { id: segId, kind: 'research-budget', expected: head.revision, value: raised },
      { id: stageBudgetIncreaseId(scope.project, head.revision + 1), kind: STAGE_BUDGET_INCREASE_KIND, expected: 0, value: act }],
      uniqueTransactionGuards([reference(project), reference(head), applied.value.session]));
    return { segment: written[0] as Revision<BudgetSegment>, increase: written[1] as Revision<StageBudgetIncrease>, repeated: false };
  } catch (error) {
    if (error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code)) {
      const latest = readEffectiveStageBudget(store, scope.project).segment;
      const again = latest ? repeatOf(latest) : null;
      if (again) return again;
      throw new EngineError('discovery_budget_increase_stale', 'A competing stage-budget change reached the store first',
        { project: scope.project, expected: scope.previous, actual: latest ? reference(latest) : null, door: 'owner-stage-budget' });
    }
    throw error;
  }
}


// ---- DR7 7b.1+7b.2 (codex-omg2 №16106 п.1): the owner decision on one exact assessed D7 bundle --------------------------
// One exact capability for one decision: database (the grant's), project, the D7 draft, the paid D7, its paid supported
// assessment, the questions-mode record and accept or decline. Its saved forms and historical proofs live in
// discovery-acceptance.ts; the unforgeable authority, the session registry and the single producer live here. No other owner
// authority, actor string, owner flag or model reply authorizes it, and in bypass mode only the proven saved policy does.
function denyAcceptance(code: OwnerAuthorityRefusalCode, target: string, field: string, message: string): never {
  deny(code as DiscoveryChoiceAuthorityRefusalCode, target, field, message, 'DR7b');
}
function acceptanceScopeOf(value: unknown, code: OwnerAuthorityRefusalCode): FinalAcceptanceScope {
  try { return requireFinalAcceptanceScope(value); }
  catch (error) {
    if (error instanceof EngineError) denyAcceptance(code, 'owner-final-acceptance', 'scope', error.message);
    throw error;
  }
}
async function runAsync<T>(action: () => Promise<T>): Promise<OmResult<Sealed<T>>> {
  try { return delivered(await action()); }
  catch (error) { if (error instanceof AuthorityFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
/** The proven grounds a scope must name exactly: the paid supported assessment, its paid D7 and draft, and the current
 * questions-mode record of the project. */
async function acceptanceScopeGrounds(store: Store, scope: FinalAcceptanceScope): Promise<DiscoveryAcceptanceGrounds> {
  let grounds: DiscoveryAcceptanceGrounds;
  try { grounds = await provenAcceptanceGrounds(store, scope.projectId, scope.assessment); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return take(refused(error.code, error.message, { unit: 'DR7b', target: scope.projectId, field: 'assessment', ref: scope.assessment }, 'owner'));
  }
  if (!sameScope(grounds.paid, scope.paid) || !sameScope(grounds.draft, scope.draft))
    denyAcceptance('owner_invitation_invalid', scope.projectId, 'scope', 'The scope names another paid D7 or draft than its assessment');
  let mode: ReturnType<typeof provenAcceptanceMode>;
  try { mode = provenAcceptanceMode(store, scope.projectId); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return take(refused(error.code, error.message, { unit: 'DR7b', target: scope.projectId, field: 'mode' }, 'owner'));
  }
  if (mode.mode !== 'questions' || !sameScope(exactRef(mode.ref), scope.mode))
    take(refused('discovery_acceptance_mode_mismatch', 'An owner decision is scoped to the current questions-mode record',
      { unit: 'DR7b', target: scope.projectId, field: 'mode', ref: scope.mode }, 'owner'));
  return grounds;
}

/** The trusted CLI's one-use invitation for one exact owner decision on a paid supported assessment. */
export async function issueFinalAcceptanceInvitation(store: Store, request: unknown):
  Promise<OmResult<Sealed<{ invitation: string; grant: Ref; expiresAt: number }>>> {
  return runAsync(async () => {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'An acceptance invitation needs a Store');
    const scope = acceptanceScopeOf(acceptanceSnapshot(request, 'scope'), 'owner_invitation_invalid');
    const project = store.get(`project:${scope.projectId}`);
    if (!project) denyAcceptance('owner_project_missing', scope.projectId, 'projectId', 'An acceptance invitation is issued for an existing project only');
    await acceptanceScopeGrounds(store, scope);
    const secret = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex'), issuedAt = Date.now();
    const grant: FinalAcceptanceSessionGrant = { contract: FINAL_ACCEPTANCE_GRANT_CONTRACT, id, database: store.databaseId,
      action: FINAL_ACCEPTANCE_ACTION, method: FINAL_ACCEPTANCE_PAIRING_METHOD, scope, issuedAt,
      expiresAt: issuedAt + FINAL_ACCEPTANCE_GRANT_LIFETIME_MS, proof: digest(secret) };
    const written = take(writeGuarded<FinalAcceptanceSessionGrant>(store, { unit: 'DR7b', target: `${FINAL_ACCEPTANCE_GRANT_PREFIX}${id}`,
      writes: [{ id: `${FINAL_ACCEPTANCE_GRANT_PREFIX}${id}`, kind: FINAL_ACCEPTANCE_GRANT_KIND, expected: 0, value: grant }],
      guards: [exactRef(reference(project!)), scope.mode] }));
    return { invitation: `${id}.${secret}`, grant: exactRef(reference(written[0]!)), expiresAt: grant.expiresAt };
  });
}

const FINAL_ACCEPTANCE_MINT = Symbol('final-acceptance-authority-mint');
const FINAL_ACCEPTANCE_AUTHORITIES = new WeakSet<FinalAcceptanceAuthority>();
export class FinalAcceptanceAuthority {
  readonly #sessions: FinalAcceptanceSessions; readonly #store: Store; readonly #digest: string;
  readonly #sessionId: string; readonly #session: Ref; readonly #scope: FinalAcceptanceScope;
  constructor(token: symbol, sessions: FinalAcceptanceSessions, store: Store, bearerDigest: string, session: Ref, scope: FinalAcceptanceScope) {
    requireCondition(token === FINAL_ACCEPTANCE_MINT, 'owner_authority_invalid', 'Acceptance authority is minted by its scoped session exchange only');
    this.#sessions = sessions; this.#store = store; this.#digest = bearerDigest;
    this.#session = exactRef(session); this.#sessionId = this.#session.id; this.#scope = structuredClone(scope);
    FINAL_ACCEPTANCE_AUTHORITIES.add(this);
  }
  exercise(request: { store: Store; action: string; scope: FinalAcceptanceScope }): OmResult<Sealed<{ session: Ref; grant: Ref; at: number }>> {
    return run(() => {
      if (!FINAL_ACCEPTANCE_AUTHORITIES.has(this)) denyAcceptance('owner_authority_invalid', 'authority', 'authority',
        'Acceptance authority is an object of the closed scoped registry');
      if (!shape(request) || request.store !== this.#store || request.action !== FINAL_ACCEPTANCE_ACTION || !sameScope(request.scope, this.#scope))
        denyAcceptance('owner_authority_foreign', this.#sessionId, 'scope', 'Acceptance authority is bound to one Store and one exact decision');
      const found = this.#store.get<FinalAcceptanceSession>(this.#sessionId);
      if (!found) denyAcceptance('owner_session_missing', this.#sessionId, 'session', 'The acceptance owner session record is absent');
      let session: Revision<FinalAcceptanceSession>;
      try { session = readFinalAcceptanceSession(this.#store, reference(found!)); }
      catch (error) { if (error instanceof EngineError) denyAcceptance('owner_session_state_invalid', this.#sessionId, 'session', error.message); throw error; }
      if (session!.value.state !== 'open') denyAcceptance('owner_session_revoked', this.#sessionId, 'session', 'The acceptance owner session is revoked');
      if (!sameScope(reference(session!), this.#session))
        denyAcceptance('owner_authority_foreign', this.#sessionId, 'session', 'The original acceptance session cannot be substituted');
      if (this.#sessions.sessionOf(this.#digest) !== this.#sessionId)
        denyAcceptance('owner_session_missing', this.#sessionId, 'session', 'The acceptance owner session is not live in this process');
      const now = Date.now();
      if (now < session!.value.openedAt || session!.value.expiresAt <= now)
        denyAcceptance('owner_session_expired', this.#sessionId, 'session', 'The acceptance owner session is outside its live window');
      if (session!.value.database !== this.#store.databaseId || !sameScope(session!.value.scope, this.#scope))
        denyAcceptance('owner_authority_foreign', this.#sessionId, 'scope', 'The acceptance owner session is bound to another database or decision');
      return { session: exactRef(reference(session!)), grant: exactRef(session!.value.grant), at: now };
    });
  }
}
const FINAL_ACCEPTANCE_EXERCISE = FinalAcceptanceAuthority.prototype.exercise;
export function requireFinalAcceptanceAuthority(candidate: unknown,
  request: { store: Store; action: string; scope: FinalAcceptanceScope }): OmResult<Sealed<{ session: Ref; grant: Ref; at: number }>> {
  if (candidate instanceof OwnerAuthority || candidate instanceof DiscoveryChoiceAuthority || candidate instanceof ProjectModeAuthority
    || candidate instanceof VariantChoiceAuthority || candidate instanceof StageBudgetAuthority)
    return refused('owner_authority_foreign', 'Another owner authority cannot decide on the final Discovery bundle',
      { unit: 'DR7b', target: 'authority', field: 'action' }, 'owner');
  if (!(candidate instanceof FinalAcceptanceAuthority) || !FINAL_ACCEPTANCE_AUTHORITIES.has(candidate))
    return refused('owner_authority_invalid', 'Use the trusted owner acceptance door for this exact decision',
      { unit: 'DR7b', target: 'authority', field: 'authority' }, 'owner');
  return FINAL_ACCEPTANCE_EXERCISE.call(candidate, request);
}
export class FinalAcceptanceSessions {
  readonly #store: Store;
  readonly #live = new Map<string, { session: string; authority: FinalAcceptanceAuthority }>();
  constructor(store: Store) {
    requireCondition(store instanceof Store, 'owner_invitation_invalid', 'The acceptance session registry needs a Store');
    this.#store = store;
  }
  sessionOf(bearerDigest: string): string | null { return this.#live.get(bearerDigest)?.session ?? null; }
  exchange(request: unknown): OmResult<Sealed<{ bearer: string; session: Ref; expiresAt: number }>> {
    return run(() => {
      if (!shape(request) || !isText(request.projectId) || !isText(request.invitation)
        || Object.keys(request).some(key => !['projectId', 'invitation'].includes(key)))
        denyAcceptance('owner_invitation_invalid', 'final-acceptance-session', 'request', 'An acceptance exchange names projectId and invitation only');
      const project = request.projectId as string, parts = (request.invitation as string).split('.');
      if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!))
        denyAcceptance('owner_invitation_invalid', project, 'invitation', 'An invitation is <grant-id>.<secret>');
      const found = this.#store.get<FinalAcceptanceSessionGrant>(`${FINAL_ACCEPTANCE_GRANT_PREFIX}${parts[0]}`);
      if (!found) denyAcceptance('owner_invitation_invalid', project, 'invitation', 'Unknown acceptance invitation');
      let grant: Revision<FinalAcceptanceSessionGrant>;
      try { grant = readFinalAcceptanceGrant(this.#store, reference(found!)); }
      catch (error) { if (error instanceof EngineError) denyAcceptance('owner_invitation_invalid', project, 'invitation', error.message); throw error; }
      if (!timingSafeEqual(Buffer.from(digest(parts[1]!), 'hex'), Buffer.from(grant!.value.proof, 'hex')))
        denyAcceptance('owner_invitation_invalid', project, 'invitation', 'The invitation secret does not verify');
      if (grant!.value.database !== this.#store.databaseId || grant!.value.scope.projectId !== project || grant!.value.action !== FINAL_ACCEPTANCE_ACTION)
        denyAcceptance('owner_invitation_foreign', project, 'invitation', 'The invitation belongs to another database, project or action');
      const now = Date.now();
      if (now < grant!.value.issuedAt) denyAcceptance('owner_invitation_invalid', project, 'invitation', 'The acceptance invitation is not yet issued');
      if (grant!.value.expiresAt <= now) denyAcceptance('owner_invitation_expired', project, 'invitation', 'The acceptance invitation has expired');
      const grantRef = exactRef(reference(grant!)), sessionId = finalAcceptanceSessionId(grantRef);
      if (this.#store.get(sessionId)) denyAcceptance('owner_invitation_spent', project, 'invitation', 'The acceptance invitation is already exchanged');
      const session: FinalAcceptanceSession = { contract: FINAL_ACCEPTANCE_SESSION_CONTRACT, grant: grantRef, database: grant!.value.database,
        action: FINAL_ACCEPTANCE_ACTION, method: FINAL_ACCEPTANCE_PAIRING_METHOD, scope: grant!.value.scope,
        session: randomBytes(16).toString('hex'), openedAt: now, expiresAt: now + FINAL_ACCEPTANCE_SESSION_LIFETIME_MS, state: 'open' };
      const written = take(writeGuarded<FinalAcceptanceSession>(this.#store, { unit: 'DR7b', target: sessionId,
        writes: [{ id: sessionId, kind: FINAL_ACCEPTANCE_SESSION_KIND, expected: 0, value: session }], guards: [grantRef] }));
      const bearer = randomBytes(32).toString('hex'), key = digest(bearer), opened = exactRef(reference(written[0]!));
      this.#live.set(key, { session: sessionId,
        authority: new FinalAcceptanceAuthority(FINAL_ACCEPTANCE_MINT, this, this.#store, key, opened, grant!.value.scope) });
      return { bearer, session: opened, expiresAt: session.expiresAt };
    });
  }
  authority(bearer: unknown): FinalAcceptanceAuthority | null {
    return typeof bearer === 'string' && /^[a-f0-9]{64}$/.test(bearer) ? this.#live.get(digest(bearer))?.authority ?? null : null;
  }
  revoke(bearer: unknown): OmResult<Sealed<{ session: Ref }>> {
    return run(() => {
      const key = typeof bearer === 'string' ? digest(bearer) : null, live = key ? this.#live.get(key) : undefined;
      if (!live) denyAcceptance('owner_session_missing', 'final-acceptance-session', 'bearer', 'No live acceptance session carries this bearer');
      this.#live.delete(key!);
      const head = this.#store.get<FinalAcceptanceSession>(live!.session);
      if (!head) denyAcceptance('owner_session_missing', live!.session, 'session', 'The acceptance session record is absent');
      if (head!.value.state === 'closed') return { session: exactRef(reference(head!)) };
      const closed: FinalAcceptanceSession = { ...head!.value, state: 'closed', closedAt: Math.max(Date.now(), head!.value.openedAt) };
      const written = take(writeGuarded<FinalAcceptanceSession>(this.#store, { unit: 'DR7b', target: head!.id,
        writes: [{ id: head!.id, kind: FINAL_ACCEPTANCE_SESSION_KIND, expected: head!.revision, value: closed }],
        guards: [exactRef(reference(head!))] }));
      return { session: exactRef(reference(written[0]!)) };
    });
  }
}

export interface DiscoveryAcceptanceOutcome {
  decision: 'accept' | 'decline';
  /** The proven accepted Discovery; null for a declining owner act, which publishes no accepted manifest. */
  accepted: AcceptedDiscovery | null;
  act: Revision<FinalAcceptanceAct> | null;
  repeated: boolean;
}
function acceptanceFailure(result: OmResult<unknown>): never {
  if (result.ok) throw new EngineError('owner_authority_internal', 'Authority refusal unexpectedly delivered a value');
  throw new EngineError(result.refusal.code, result.refusal.message, { ...result.refusal.at, door: 'owner-final-acceptance' });
}
function acceptanceRequest(value: unknown): { projectId: string; assessment: Ref; decision: 'accept' | 'decline'; reason: string } {
  const input = acceptanceSnapshot(value, 'request');
  if (!shape(input) || Object.keys(input).sort().join(',') !== 'assessment,decision,projectId,reason' || !isText(input.projectId)
    || !isRef(input.assessment) || !shape(input.assessment) || Object.keys(input.assessment).sort().join(',') !== 'hash,id,revision'
    || (input.decision !== 'accept' && input.decision !== 'decline') || !isText(input.reason) || !(input.reason as string).trim())
    throw new EngineError('discovery_acceptance_invalid', 'An acceptance request names projectId, the exact paid assessment, accept or decline and a reason only',
      { door: 'owner-final-acceptance' });
  return { projectId: input.projectId as string, assessment: exactRef(input.assessment as Ref), decision: input.decision as 'accept' | 'decline',
    reason: input.reason as string };
}
/**
 * DR7 7b.1+7b.2: the single producer of a decision on one exact paid supported assessment. In questions mode only a minted
 * acceptance authority bound to this exact decision may write; accept publishes atomically the act, the saved whole bundle
 * and the manifest, decline writes the act alone. In bypass mode the code writes the machine admission from the proven
 * bypass record, the bundle and the manifest. Every write stands under the CAS of its new addresses and the guards of the
 * project, the current mode head and the exact open session; a decision already saved for this assessment is returned
 * proven again. Any refusal writes nothing.
 */
export async function acceptDiscoveryFinal(store: Store, request: unknown, authority?: unknown): Promise<DiscoveryAcceptanceOutcome> {
  requireCondition(store instanceof Store, 'discovery_acceptance_invalid', 'An acceptance needs a Store');
  const input = acceptanceRequest(request), projectId = input.projectId;
  const project = store.get(`project:${projectId}`);
  if (!project) throw new EngineError('owner_project_missing', 'An acceptance addresses an existing project only',
    { project: projectId, door: 'owner-final-acceptance' });
  // The current mode is proven first: a project without one has no acceptance, before any paid ground is proven again.
  const mode = provenAcceptanceMode(store, projectId);
  const grounds = await provenAcceptanceGrounds(store, projectId, input.assessment);
  const saved = async (repeated: boolean): Promise<DiscoveryAcceptanceOutcome | null> => {
    const act = store.get<FinalAcceptanceAct>(finalAcceptanceActId(projectId, grounds.assessment), 1);
    if (act) {
      const proven = proveFinalAcceptanceAct(store, projectId, reference(act), grounds);
      if (proven.value.scope.decision === 'decline') return { decision: 'decline', accepted: null, act: structuredClone(proven), repeated };
      const manifest = acceptanceWrites(projectId, grounds, { kind: 'owner', act: proven.value }).manifest;
      const accepted = await readAcceptedDiscoveryManifestAt(store, projectId, { id: manifest.id, revision: 1, hash: hashJson(manifest.value as never) });
      return { decision: 'accept', accepted, act: structuredClone(proven), repeated };
    }
    const admission = store.get<FinalMachineAdmission>(finalMachineAdmissionId(projectId, grounds.assessment), 1);
    if (admission) {
      const proven = proveFinalMachineAdmission(store, projectId, reference(admission), grounds);
      const manifest = acceptanceWrites(projectId, grounds, { kind: 'machine', admission: proven.value }).manifest;
      const accepted = await readAcceptedDiscoveryManifestAt(store, projectId, { id: manifest.id, revision: 1, hash: hashJson(manifest.value as never) });
      return { decision: 'accept', accepted, act: null, repeated };
    }
    return null;
  };
  const before = await saved(true);
  if (before) return before;
  let writes, guards, manifestRef: Ref | null = null;
  if (mode.mode === 'questions') {
    const scope: FinalAcceptanceScope = { projectId, draft: grounds.draft, paid: grounds.paid, assessment: grounds.assessment,
      mode: exactRef(mode.ref), decision: input.decision, reason: input.reason };
    const admitted = requireFinalAcceptanceAuthority(authority, { store, action: FINAL_ACCEPTANCE_ACTION, scope });
    if (!admitted.ok) return acceptanceFailure(admitted);
    // The second exercise closes the check-to-write window; the pinned open session revision is a transaction guard.
    const applied = requireFinalAcceptanceAuthority(authority, { store, action: FINAL_ACCEPTANCE_ACTION, scope });
    if (!applied.ok) return acceptanceFailure(applied);
    const act: FinalAcceptanceAct = { contract: FINAL_ACCEPTANCE_ACT_CONTRACT, database: store.databaseId, projectId, scope,
      authority: { grant: applied.value.grant, session: applied.value.session }, at: applied.value.at };
    if (input.decision === 'decline')
      writes = [{ id: finalAcceptanceActId(projectId, grounds.assessment), kind: FINAL_ACCEPTANCE_ACT_KIND, expected: 0, value: act }];
    else { const published = acceptanceWrites(projectId, grounds, { kind: 'owner', act }); writes = published.writes;
      manifestRef = { id: published.manifest.id, revision: 1, hash: hashJson(published.manifest.value as never) }; }
    guards = uniqueTransactionGuards([reference(project), exactRef(mode.ref), applied.value.session]);
  } else {
    if (authority !== undefined)
      throw new EngineError('discovery_acceptance_mode_mismatch', 'In bypass mode the saved project policy admits the bundle; an owner authority is not used',
        { project: projectId, door: 'owner-final-acceptance' });
    if (input.decision !== 'accept')
      throw new EngineError('discovery_acceptance_mode_mismatch', 'A machine admission only accepts; a refusal is an owner decision in questions mode',
        { project: projectId, door: 'owner-final-acceptance' });
    const admission: FinalMachineAdmission = { contract: FINAL_MACHINE_ADMISSION_CONTRACT, database: store.databaseId, projectId,
      draft: grounds.draft, paid: grounds.paid, assessment: grounds.assessment, mode: exactRef(mode.ref), policy: 'bypass' };
    const published = acceptanceWrites(projectId, grounds, { kind: 'machine', admission });
    writes = published.writes; manifestRef = { id: published.manifest.id, revision: 1, hash: hashJson(published.manifest.value as never) };
    guards = uniqueTransactionGuards([reference(project), exactRef(mode.ref)]);
  }
  try { store.writeMany(writes, guards); }
  catch (error) {
    if (error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code)) {
      const winner = await saved(true);
      if (winner) return winner;
      throw new EngineError('discovery_acceptance_stale', 'The mode, the owner session or the decision moved before the acceptance was written',
        { project: projectId, door: 'owner-final-acceptance' });
    }
    throw error;
  }
  if (manifestRef) {
    const accepted = await readAcceptedDiscoveryManifestAt(store, projectId, manifestRef);
    return { decision: 'accept', accepted, act: accepted.admission.kind === 'owner' ? accepted.admission.record : null, repeated: false };
  }
  const declined = await saved(false);
  if (!declined) throw new EngineError('owner_authority_internal', 'The declining act was not saved');
  return declined;
}

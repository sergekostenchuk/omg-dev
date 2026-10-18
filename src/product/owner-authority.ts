import { randomBytes, timingSafeEqual } from "node:crypto";
import { digest, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { readRecord, writeGuarded } from "../om/refs.js";
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

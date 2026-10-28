import { randomBytes } from 'node:crypto';
import { digest, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import { Store } from '../storage/store.js';
import { OWNER_GRANT_LIFETIME_MS, OWNER_SESSION_LIFETIME_MS } from './owner-authority.js';
import { producerPolicyScope, producerPolicyId, readProjectProducerPolicy, policyRecord, policyRequire, policySame,
  proveProducerPolicySession, PRODUCER_POLICY_DOOR, type ProducerPolicyScope, type ProducerPolicyGrant,
  type ProducerPolicySession, type ProjectProducerPolicy } from '../discovery/project-producer-policy.js';

const live = new WeakMap<object, { store: Store; scope: ProducerPolicyScope; session: Ref; active: () => boolean }>();
const MINT = Symbol('producer-policy');
class ProducerPolicyAuthority {
  constructor(mint: symbol, entry: {store: Store; scope: ProducerPolicyScope; session: Ref; active: () => boolean}) {
    requireCondition(mint === MINT, 'owner_authority_required', 'Use the scoped owner producer-policy door');
    live.set(this, entry); Object.freeze(this);
  }
}
function currentScope(store: Store, input: unknown) {
  const scope = producerPolicyScope(input), project = store.get<{id: string}>(`project:${scope.project}`);
  policyRequire(project?.kind === 'project' && project.value?.id === scope.project, 'Producer policy needs this existing project');
  const current = readProjectProducerPolicy(store, scope.project);
  const repeated = current !== null && policySame({project: scope.project, discovery: current.value.discovery, previous: current.value.previous}, scope);
  if (!repeated && !policySame(current ? reference(current) : null, scope.previous))
    throw new EngineError('producer_policy_stale', 'Reload the exact producer policy before changing it', { door: PRODUCER_POLICY_DOOR });
  return { scope, project, current, repeated };
}
/** Trusted local CLI only. Neither ProductCommand nor configure exposes this mint. */
export function issueProducerPolicyInvitation(store: Store, input: unknown) {
  const {scope, project} = currentScope(store, input), now = Date.now(), secret = randomBytes(32).toString('hex');
  const value: ProducerPolicyGrant = { contract: 'producer-policy-grant/v1', database: store.databaseId,
    project: reference(project), scope, secretHash: digest(secret), issuedAt: now, expiresAt: now + OWNER_GRANT_LIFETIME_MS };
  const grant = store.writeMany([{ id: `producer-policy-grant:${hashJson(value)}`, kind: 'owner-session-grant', expected: 0, value }],
    [reference(project)])[0]!;
  return { grant: reference(grant), secret };
}
export class ProducerPolicySessions {
  readonly #bearers = new Map<string, ProducerPolicyAuthority>();
  constructor(private readonly store: Store) {}
  exchange(input: {grant: Ref; secret: string}) {
    const grant = policyRecord<ProducerPolicyGrant>(this.store, input.grant, 'owner-session-grant'), g = grant.value, now = Date.now();
    policyRequire(g?.contract === 'producer-policy-grant/v1' && grant.id === `producer-policy-grant:${hashJson(g)}`
      && g.database === this.store.databaseId && typeof input.secret === 'string' && digest(input.secret) === g.secretHash
      && g.issuedAt <= now && now < g.expiresAt, 'The producer-policy invitation is absent, expired or foreign');
    const {scope, project} = currentScope(this.store, g.scope);
    policyRequire(policySame(reference(project), g.project), 'The scoped project changed before session exchange');
    const value: ProducerPolicySession = { contract: 'producer-policy-session/v1', database: this.store.databaseId,
      grant: reference(grant), scope, openedAt: now, expiresAt: now + OWNER_SESSION_LIFETIME_MS, revokedAt: null };
    const row = this.store.writeMany([{ id: `producer-policy-session:${hashJson(reference(grant))}`,
      kind: 'owner-session', expected: 0, value }], [reference(grant), reference(project)])[0]!;
    const bearer = randomBytes(32).toString('hex');
    const authority: ProducerPolicyAuthority = new ProducerPolicyAuthority(MINT, {store: this.store, scope, session: reference(row),
      active: () => this.#bearers.get(bearer) === authority});
    this.#bearers.set(bearer, authority); return { bearer, authority };
  }
  revoke(bearer: string) {
    const authority = this.#bearers.get(bearer);
    requireCondition(authority, 'owner_authority_required', 'The owner producer-policy session is not live');
    this.#bearers.delete(bearer);
    const entry = live.get(authority)!, row = policyRecord<ProducerPolicySession>(this.store, entry.session, 'owner-session');
    this.store.writeMany([{id: row.id, kind: row.kind, expected: row.revision,
      value: {...row.value, revokedAt: Date.now()}}], [reference(row)]);
  }
}
export function setProjectProducerPolicy(store: Store, input: unknown, authority: unknown) {
  const cap = authority !== null && typeof authority === 'object' ? live.get(authority) : null;
  requireCondition(cap && cap.store === store && cap.active(), 'owner_authority_required', 'A live scoped owner session is required');
  const {scope, project, current, repeated} = currentScope(store, input);
  requireCondition(policySame(cap.scope, scope), 'owner_authority_foreign', 'The owner authority covers another exact decision');
  const session = proveProducerPolicySession(store, cap.session, scope), now = Date.now();
  const head = store.get(session.id);
  requireCondition(head && policySame(reference(head), cap.session)
    && session.value.openedAt <= now && now < session.value.expiresAt,
  'owner_authority_expired', 'The producer-policy owner session expired or was revoked');
  if (repeated) return {record: current!, repeated: true};
  policyRequire(!current || current.value.at <= now, 'A new producer decision cannot precede its previous record');
  const value: ProjectProducerPolicy = { contract: 'project-producer-policy/v1', database: store.databaseId,
    project: scope.project, discovery: scope.discovery, previous: scope.previous, session: cap.session, at: now };
  const record = store.writeMany<ProjectProducerPolicy>([{id: producerPolicyId(scope.project), kind: 'project-producer-policy',
    expected: current?.revision ?? 0, value}], [reference(project), cap.session,
      current ? reference(current) : { id: producerPolicyId(scope.project), absent: true }])[0]!;
  return {record, repeated: false};
}

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store } from '../src/storage/store.js';
import { issueOwnerInvitation, OWNER_GRANT_KIND, OWNER_GRANT_PREFIX, OWNER_RESULT_ACTION, OWNER_SESSION_KIND,
  OwnerSessions, ownerSessionId, readOwnerSession, readOwnerSessionGrant, requireOwnerAuthority,
  type OwnerSession, type OwnerSessionGrant } from '../src/product/owner-authority.js';
import type { OmResult } from '../src/om/refusal.js';
import { refusedWith } from './om-fixture.js';

function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-owner-authority-'));
  const store = new Store(join(root, 'state.sqlite'));
  const engine = new ProductEngine(store);
  await engine.execute({ type: 'create-project', project: 'garden', title: 'Garden' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, engine, project: 'garden' };
}
function login(store: Store, project: string, sessions = new OwnerSessions(store)) {
  const { invitation } = ok(issueOwnerInvitation(store, { project }));
  const exchanged = ok(sessions.exchange({ project, invitation }));
  const authority = sessions.authority(exchanged.bearer);
  assert.ok(authority, 'A live bearer yields its opaque authority');
  return { sessions, invitation, ...exchanged, authority };
}

test('H2 invitation issuance persists a verifiable grant and never persists the secret', async t => {
  const f = await fixture(t);
  refusedWith(issueOwnerInvitation(f.store, { project: 'absent' }), 'owner_project_missing');
  for (const request of [null, {}, { project: 7 }, { project: 'garden', extra: true }, 'garden'])
    refusedWith(issueOwnerInvitation(f.store, request), 'owner_invitation_invalid');
  const issued = ok(issueOwnerInvitation(f.store, { project: 'garden' }));
  const [id, secret] = issued.invitation.split('.');
  assert.match(id!, /^[a-f0-9]{32}$/); assert.match(secret!, /^[a-f0-9]{64}$/);
  assert.equal(issued.grant.id, `${OWNER_GRANT_PREFIX}${id}`);
  const grant = ok(readOwnerSessionGrant(f.store, issued.grant));
  assert.equal(grant.value.contract, 'owner-session-grant/v1');
  assert.equal(grant.value.database, f.store.databaseId);
  assert.equal(grant.value.project, 'garden');
  assert.equal(grant.value.action, OWNER_RESULT_ACTION);
  assert.equal(grant.value.method, 'local-pairing/v1');
  assert.equal(grant.value.proof, digest(secret!));
  assert.ok(grant.value.expiresAt - grant.value.issuedAt === 10 * 60_000);
  for (const record of f.store.list()) {
    assert.equal(JSON.stringify(record.value).includes(secret!), false, 'The secret is never persisted');
    assert.equal(JSON.stringify(record.value).includes(issued.invitation), false);
  }
});

test('H2 exchange verifies the secret before any write and spends the grant once', async t => {
  const f = await fixture(t);
  const sessions = new OwnerSessions(f.store);
  const { invitation } = ok(issueOwnerInvitation(f.store, { project: 'garden' }));
  const [id, secret] = invitation.split('.');
  const before = f.store.list().map(reference).length;
  for (const bad of [`${id}.${'0'.repeat(64)}`, `${id}.`, `${'0'.repeat(32)}.${secret}`, 'no-shape', `${id}.${secret}x`])
    refusedWith(sessions.exchange({ project: 'garden', invitation: bad }), 'owner_invitation_invalid');
  assert.equal(f.store.list().length, before, 'A wrong secret performs no write and never spends the grant');
  refusedWith(sessions.exchange({ project: 'other', invitation }), 'owner_invitation_foreign');
  const exchanged = ok(sessions.exchange({ project: 'garden', invitation }));
  assert.match(exchanged.bearer, /^[a-f0-9]{64}$/);
  const session = ok(readOwnerSession(f.store, exchanged.session));
  const grantRecord = f.store.get<OwnerSessionGrant>(`${OWNER_GRANT_PREFIX}${id}`)!;
  assert.deepEqual(session.value.grant, reference(grantRecord));
  assert.equal(session.id, ownerSessionId(reference(grantRecord)),
    'The session lives at the deterministic address of its exact grant Ref');
  assert.equal(session.value.state, 'open');
  assert.equal(session.value.expiresAt - session.value.openedAt, 30 * 60_000);
  refusedWith(sessions.exchange({ project: 'garden', invitation }), 'owner_invitation_spent');
  // The deterministic CAS keeps the first session: the loser never overwrote it.
  assert.equal(ok(readOwnerSession(f.store, exchanged.session)).value.session, session.value.session);
});

test('H2 exchange refuses an expired grant and a foreign-database grant', async t => {
  const f = await fixture(t);
  const sessions = new OwnerSessions(f.store);
  const now = Date.now();
  const staleSecret = 'e'.repeat(64);
  const stale: OwnerSessionGrant = { contract: 'owner-session-grant/v1', id: 'a'.repeat(32), database: f.store.databaseId,
    project: 'garden', action: OWNER_RESULT_ACTION, method: 'local-pairing/v1', issuedAt: now - 20 * 60_000,
    expiresAt: now - 10 * 60_000, proof: digest(staleSecret) };
  f.store.write({ id: `owner-session-grant:${stale.id}`, kind: OWNER_GRANT_KIND, expected: 0, value: stale });
  refusedWith(sessions.exchange({ project: 'garden', invitation: `${stale.id}.${staleSecret}` }),
    'owner_invitation_expired');
  const foreignSecret = 'f'.repeat(64);
  const forged: OwnerSessionGrant = { ...stale, id: 'b'.repeat(32), issuedAt: now - 60_000, expiresAt: now + 60_000,
    database: 'another-database', proof: digest(foreignSecret) };
  f.store.write({ id: `owner-session-grant:${forged.id}`, kind: OWNER_GRANT_KIND, expected: 0, value: forged });
  refusedWith(sessions.exchange({ project: 'garden', invitation: `${forged.id}.${foreignSecret}` }),
    'owner_invitation_foreign');
});

test('H2 authority is an unforgeable object: lookalikes, foreign scope and revocation are refused', async t => {
  const f = await fixture(t);
  const { authority, sessions, bearer } = login(f.store, 'garden');
  refusedWith(requireOwnerAuthority(authority, { store: f.store, project: 'garden', action: 'other-action' }),
    'owner_authority_foreign');
  refusedWith(requireOwnerAuthority(authority, { store: f.store, project: 'other', action: OWNER_RESULT_ACTION }),
    'owner_authority_foreign');
  for (const lookalike of [null, {}, { exercise: () => ({ ok: true }) }, bearer,
    { session: 'x' }, ['owner'], new Date()])
    refusedWith(requireOwnerAuthority(lookalike, { store: f.store, project: 'garden', action: OWNER_RESULT_ACTION }),
      'owner_authority_invalid');
  const foreignRoot = mkdtempSync(join(tmpdir(), 'omg-owner-foreign-'));
  const foreign = new Store(join(foreignRoot, 'other.sqlite'));
  t.after(() => { foreign.close(); rmSync(foreignRoot, { recursive: true, force: true }); });
  refusedWith(requireOwnerAuthority(authority, { store: foreign, project: 'garden', action: OWNER_RESULT_ACTION }),
    'owner_authority_foreign');
  const proved = ok(requireOwnerAuthority(authority, { store: f.store, project: 'garden', action: OWNER_RESULT_ACTION }));
  const session = ok(readOwnerSession(f.store, proved.session));
  assert.equal(session.value.state, 'open');
  const closed = ok(sessions.revoke(bearer));
  assert.equal(ok(readOwnerSession(f.store, closed.session)).value.state, 'closed');
  assert.equal(sessions.authority(bearer), null, 'A revoked bearer drops out of the live registry');
  refusedWith(requireOwnerAuthority(authority, { store: f.store, project: 'garden', action: OWNER_RESULT_ACTION }),
    'owner_session_missing');
  refusedWith(sessions.revoke(bearer), 'owner_session_missing');
});

test('H2 bearer authority dies with the server while the persisted chain stays readable', async t => {
  const f = await fixture(t);
  const first = login(f.store, 'garden');
  // A restart is a new registry over the same Store — its bearer map is empty, the records survive.
  const restarted = new OwnerSessions(f.store);
  assert.equal(restarted.authority(first.bearer), null, 'A fresh registry knows no bearer of the dead process');
  refusedWith(restarted.revoke(first.bearer), 'owner_session_missing');
  assert.equal(ok(readOwnerSession(f.store, first.session)).value.state, 'open',
    'The persisted session record remains readable history');
  // A new invitation under the new registry opens a new session; the old grant stays spent.
  const second = login(f.store, 'garden', restarted);
  refusedWith(first.sessions.exchange({ project: 'garden', invitation: first.invitation }), 'owner_invitation_spent');
  assert.ok(ok(requireOwnerAuthority(second.authority,
    { store: f.store, project: 'garden', action: OWNER_RESULT_ACTION })).session);
});

test('H2 session records prove their own shape on read', async t => {
  const f = await fixture(t);
  const { session } = login(f.store, 'garden');
  refusedWith(readOwnerSession(f.store, { ...session, hash: '0'.repeat(64) }), 'record_forged');
  refusedWith(readOwnerSession(f.store, { id: 'owner-session:absent', revision: 1, hash: '0'.repeat(64) }),
    ['record_missing', 'record_forged']);
  refusedWith(readOwnerSessionGrant(f.store, { id: 'owner-session-grant:absent', revision: 1, hash: '0'.repeat(64) }),
    ['record_missing', 'record_forged']);
  const tampered = f.store.write({ id: session.id, kind: OWNER_SESSION_KIND, expected: 1,
    value: { ...f.store.get<OwnerSession>(session.id)!.value, state: 'closed', closedAt: Date.now() } });
  // A closed session still reads — its state is the truth, not a failure of reading.
  assert.equal(ok(readOwnerSession(f.store, reference(tampered))).value.state, 'closed');
  const malformed = f.store.write({ id: `${OWNER_GRANT_PREFIX}${'c'.repeat(32)}`, kind: OWNER_GRANT_KIND, expected: 0,
    value: { contract: 'owner-session-grant/v1', id: 'c'.repeat(32) } });
  refusedWith(readOwnerSessionGrant(f.store, reference(malformed)), 'owner_invitation_invalid');
});

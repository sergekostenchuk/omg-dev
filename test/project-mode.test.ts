import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import {
  OwnerSessions, issueOwnerInvitation, DiscoveryChoiceSessions, issueDiscoveryChoiceInvitation,
  OwnerAuthority, ProjectModeAuthority, ProjectModeSessions,
  issueProjectModeInvitation, requireOwnerAuthority, requireDiscoveryChoiceAuthority,
  PROJECT_MODE_SESSION_PREFIX, PROJECT_MODE_GRANT_PREFIX, projectModeSessionId,
  OWNER_GRANT_LIFETIME_MS, OWNER_SESSION_LIFETIME_MS,
  type ProjectMode, type ProjectModeScope, type ProjectModeSession,
} from '../src/product/owner-authority.js';
import type { Ref } from '../src/pipeline/contracts.js';
import {
  readProjectMode, setProjectMode, projectModeId,
  type ProjectModeRecord, type ProjectModeRequest,
} from '../src/product/project-mode.js';

const ok = <T>(result: { ok: true; value: T } | { ok: false; refusal: { code: string } }): T => {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
};

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'omg-project-mode-')), path = join(root, 'state.sqlite');
  const store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'Mode fixture' });
  const request = (mode: ProjectMode = 'questions', previous: ProjectModeRequest['previous'] = null):
    ProjectModeRequest => ({ project: 'p', mode, previous });
  const mint = (req: ProjectModeRequest, target = store) => {
    const sessions = new ProjectModeSessions(target);
    const issued = ok(issueProjectModeInvitation(target, req));
    const exchanged = ok(sessions.exchange({ project: req.project, invitation: issued.invitation }));
    return { sessions, bearer: exchanged.bearer, session: exchanged.session,
      authority: sessions.authority(exchanged.bearer)! };
  };
  const decide = (req: ProjectModeRequest, target = store) => {
    const session = mint(req, target);
    try { return setProjectMode(target, req, session.authority); }
    finally { session.sessions.revoke(session.bearer); }
  };
  const modes = () => store.list<ProjectModeRecord>('project-mode');
  const sessions = () => store.list<ProjectModeSessionView>('owner-session')
    .filter(row => row.id.startsWith(PROJECT_MODE_SESSION_PREFIX));
  return { root, path, store, engine, request, mint, decide, modes, sessions };
}
type ProjectModeSessionView = { scope: ProjectModeScope; state: string; contract: string };

test('DR1a the owner-authorized path writes a proven project-mode/v1 record and switches it', t => {
  const f = fixture(t);
  const first = f.decide(f.request('bypass'));
  assert.equal(first.repeated, false);
  assert.equal(first.record.id, 'project-mode:p');
  assert.equal(first.record.revision, 1);
  const value = first.record.value;
  assert.equal(value.contract, 'project-mode/v1');
  assert.equal(value.database, f.store.databaseId);
  assert.equal(value.project, 'p');
  assert.equal(value.mode, 'bypass');
  assert.equal(value.previous, null);
  assert.ok(Number.isSafeInteger(value.at) && value.at > 0);
  assert.ok(value.authority.session.id.startsWith(PROJECT_MODE_SESSION_PREFIX));
  assert.deepEqual(value.authority.scope, { project: 'p', mode: 'bypass', previous: null });
  assert.equal(f.store.get<{ state: string }>(value.authority.session.id,
    value.authority.session.revision)?.value.state, 'open');

  const second = f.decide(f.request('questions', reference(first.record)));
  assert.equal(second.repeated, false);
  assert.equal(second.record.revision, 2);
  assert.deepEqual(second.record.value.previous, reference(first.record));
  assert.equal(readProjectMode(f.store, 'p').mode, 'questions');
  assert.deepEqual(readProjectMode(f.store, 'p', reference(first.record)).mode, 'bypass');
  assert.equal(f.modes().length, 1);
  assert.ok(f.sessions().every(session => session.value.state === 'closed'));
});

test('DR1a a request without authority or with actor-like imitations is refused', t => {
  const f = fixture(t);
  for (const candidate of [undefined, null, 'owner', { owner: true }, 'local-owner',
    reference(f.store.get('project:p')!), { session: 'bearer' }])
    assert.throws(() => setProjectMode(f.store, f.request(), candidate), { code: 'owner_authority_invalid' });
  assert.equal(f.modes().length, 0);
});

test('DR1a foreign owner-result and discovery-choice authorities cannot authorize a mode', t => {
  const f = fixture(t);
  const h2 = new OwnerSessions(f.store), invite = ok(issueOwnerInvitation(f.store, { project: 'p' }));
  const login = ok(h2.exchange({ project: 'p', invitation: invite.invitation }));
  assert.throws(() => setProjectMode(f.store, f.request(), h2.authority(login.bearer)),
    { code: 'owner_authority_foreign' });
  const discovery = new DiscoveryChoiceSessions(f.store);
  const choiceScope = { project: 'p', draft: 'd', verdictRef: reference(f.store.get('project:p')!),
    reportRef: reference(f.store.get('project:p')!), conditionId: 'c', optionId: 'o' };
  const scoped = ok(issueDiscoveryChoiceInvitation(f.store, choiceScope));
  const exchanged = ok(discovery.exchange({ project: 'p', invitation: scoped.invitation }));
  assert.throws(() => setProjectMode(f.store, f.request(), discovery.authority(exchanged.bearer)),
    { code: 'owner_authority_foreign' });
  const minted = f.mint(f.request());
  const reverse = requireOwnerAuthority(minted.authority, { store: f.store, project: 'p', action: 'owner-result' });
  assert.equal(reverse.ok, false);
  if (!reverse.ok) assert.equal(reverse.refusal.code, 'owner_authority_foreign');
  const reverseChoice = requireDiscoveryChoiceAuthority(minted.authority,
    { store: f.store, action: 'discovery-condition-choice', scope: choiceScope });
  assert.equal(reverseChoice.ok, false);
  if (!reverseChoice.ok) assert.equal(reverseChoice.refusal.code, 'owner_authority_foreign');
  minted.sessions.revoke(minted.bearer);
  h2.revoke(login.bearer); discovery.revoke(exchanged.bearer);
  assert.equal(f.modes().length, 0);
});

test('DR1a a forged authority object shape does not mint authority', t => {
  const f = fixture(t), minted = f.mint(f.request());
  const fake = Object.create(ProjectModeAuthority.prototype) as ProjectModeAuthority;
  (fake as any).exercise = () => ({ ok: true, value: { session: minted.sessions.sessionOf('x') } });
  assert.throws(() => setProjectMode(f.store, f.request(), fake), { code: 'owner_authority_invalid' });
  const fakeOwner = Object.create(OwnerAuthority.prototype) as OwnerAuthority;
  (fakeOwner as any).exercise = () => ({ ok: true, value: { session: null } });
  assert.throws(() => setProjectMode(f.store, f.request(), fakeOwner), { code: 'owner_authority_foreign' });
  minted.sessions.revoke(minted.bearer);
  assert.equal(f.modes().length, 0);
});

test('DR1a tampered scope, expired session and foreign store are refused by the exercise', t => {
  const f = fixture(t);
  const minted = f.mint(f.request('bypass'));
  assert.throws(() => setProjectMode(f.store, f.request('questions'), minted.authority),
    { code: 'owner_authority_foreign' });
  const other = new Store(f.path);
  try {
    assert.throws(() => setProjectMode(other, f.request('bypass'), minted.authority),
      { code: 'owner_authority_foreign' });
  } finally { other.close(); }
  const now = Date.now;
  Date.now = () => now() + 31 * 60_000;
  try {
    assert.throws(() => setProjectMode(f.store, f.request('bypass'), minted.authority),
      { code: 'owner_session_expired' });
  } finally { Date.now = now; minted.sessions.revoke(minted.bearer); }
  assert.equal(f.modes().length, 0);
});

test('DR1a revoked authority cannot write and the closed session refuses later exercise', t => {
  const f = fixture(t), minted = f.mint(f.request());
  minted.sessions.revoke(minted.bearer);
  assert.throws(() => setProjectMode(f.store, f.request(), minted.authority), { code: 'owner_session_revoked' });
  assert.equal(f.modes().length, 0);
});

test('DR1a the exact repeat through a new session returns the same Ref without a new version', t => {
  const f = fixture(t);
  const first = f.decide(f.request('bypass'));
  const second = f.decide(f.request('bypass'));
  assert.equal(second.repeated, true);
  assert.deepEqual(reference(second.record), reference(first.record));
  assert.equal(f.modes().length, 1);
  assert.equal(f.modes()[0]!.revision, 1);
  assert.equal(f.sessions().length, 2);
  assert.ok(f.sessions().every(session => session.value.state === 'closed'));
});

test('DR1a a stale previous and an old request replay are refused without rolling the head back', t => {
  const f = fixture(t);
  const first = f.decide(f.request('bypass'));
  assert.throws(() => f.decide(f.request('questions')),
    (error: any) => error.code === 'project_mode_stale' && error.details.door === 'owner-project-mode');
  const second = f.decide(f.request('questions', reference(first.record)));
  assert.equal(second.record.revision, 2);
  assert.throws(() => f.decide(f.request('bypass')),
    (error: any) => error.code === 'project_mode_stale');
  assert.throws(() => f.decide(f.request('bypass', reference(first.record))),
    (error: any) => error.code === 'project_mode_stale');
  const replay = f.decide(f.request('questions', reference(first.record)));
  assert.equal(replay.repeated, true);
  assert.deepEqual(reference(replay.record), reference(second.record));
  assert.equal(readProjectMode(f.store, 'p').mode, 'questions');
  assert.equal(f.modes()[0]!.revision, 2);
});

test('DR1a two Stores converge on one version; a competing switch stays a typed stale refusal', t => {
  const f = fixture(t), sessions = new ProjectModeSessions(f.store);
  const issued = ok(issueProjectModeInvitation(f.store, f.request('bypass')));
  const exchanged = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  const authority = sessions.authority(exchanged.bearer)!;
  const write = f.store.writeMany.bind(f.store);
  let raced = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!raced && writes.some(row => row.kind === 'project-mode')) {
      raced = true;
      const other = new Store(f.path);
      try { f.decide(f.request('bypass'), other); } finally { other.close(); }
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  const outcome = setProjectMode(f.store, f.request('bypass'), authority);
  assert.equal(outcome.repeated, true);
  assert.equal(f.modes().length, 1);
  f.store.writeMany = write;
  sessions.revoke(exchanged.bearer);

  const f2 = fixture(t);
  const head = f2.decide(f2.request('bypass'));
  const sessions2 = new ProjectModeSessions(f2.store);
  const issued2 = ok(issueProjectModeInvitation(f2.store, f2.request('questions', reference(head.record))));
  const exchanged2 = ok(sessions2.exchange({ project: 'p', invitation: issued2.invitation }));
  const authority2 = sessions2.authority(exchanged2.bearer)!;
  const write2 = f2.store.writeMany.bind(f2.store);
  let raced2 = false;
  f2.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!raced2 && writes.some(row => row.kind === 'project-mode')) {
      raced2 = true;
      const other = new Store(f2.path);
      try { f2.decide(f2.request('bypass', reference(head.record)), other); } finally { other.close(); }
    }
    return write2(writes, guards);
  }) as typeof f2.store.writeMany;
  assert.throws(() => setProjectMode(f2.store, f2.request('questions', reference(head.record)), authority2),
    { code: 'project_mode_stale' });
  assert.equal(readProjectMode(f2.store, 'p').mode, 'bypass');
  assert.equal(f2.modes()[0]!.revision, 2);
  f2.store.writeMany = write2;
  sessions2.revoke(exchanged2.bearer);
});

test('DR1a revocation between the second exercise and the commit prevents the write', t => {
  const f = fixture(t), head = f.decide(f.request('bypass'));
  const sessions = new ProjectModeSessions(f.store);
  const request = f.request('questions', reference(head.record));
  const issued = ok(issueProjectModeInvitation(f.store, request));
  const exchanged = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  const authority = sessions.authority(exchanged.bearer)!;
  const write = f.store.writeMany.bind(f.store);
  let revoked = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!revoked && writes.some(row => row.kind === 'project-mode')) {
      revoked = true;
      sessions.revoke(exchanged.bearer);
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  assert.throws(() => setProjectMode(f.store, request, authority),
    (error: any) => ['input_stale', 'owner_session_revoked'].includes(error.code));
  f.store.writeMany = write;
  assert.equal(readProjectMode(f.store, 'p').mode, 'bypass');
  assert.equal(f.modes()[0]!.revision, 1);
});

test('DR1a a missing record is project_mode_unset — never a default mode', t => {
  const f = fixture(t);
  assert.throws(() => readProjectMode(f.store, 'p'),
    (error: any) => error.code === 'project_mode_unset'
      && error.details.project === 'p' && error.details.door === 'owner-project-mode');
  assert.throws(() => readProjectMode(f.store, 'p', { id: 'project-mode:p', revision: 1, hash: 'f'.repeat(64) }),
    (error: any) => error.code === 'project_mode_invalid' && error.details.door === 'owner-project-mode');
});

test('DR1a a malformed record is refused separately from an absent one', t => {
  const f = fixture(t);
  const fakeRef = { id: 'owner-project-mode-session:x', revision: 1, hash: 'a'.repeat(64) };
  for (const value of [
    { contract: 'project-mode/v2', database: f.store.databaseId, project: 'p', mode: 'bypass',
      authority: { session: fakeRef, scope: { project: 'p', mode: 'bypass', previous: null } },
      previous: null, at: Date.now() },
    { contract: 'project-mode/v1', database: f.store.databaseId, project: 'p', mode: 'bypass',
      authority: { session: fakeRef, scope: { project: 'p', mode: 'questions', previous: null } },
      previous: null, at: Date.now() },
    { contract: 'project-mode/v1', database: f.store.databaseId, project: 'p', mode: 'bypass',
      authority: { session: fakeRef, scope: { project: 'p', mode: 'bypass', previous: null } },
      previous: null, at: Date.now() },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'omg-mode-forge-')), path = join(root, 'state.sqlite');
    const target = new Store(path), engine = new ProductEngine(target);
    try {
      engine.execute({ type: 'create-project', project: 'p', title: 'forge' });
      target.write({ id: projectModeId('p'), kind: 'project-mode', expected: 0, value });
      assert.throws(() => readProjectMode(target, 'p'),
        (error: any) => error.code === 'project_mode_invalid' && error.code !== 'project_mode_unset');
    } finally { target.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('DR1a the historical decision proves itself after session expiry and a process restart', t => {
  const f = fixture(t);
  const first = f.decide(f.request('bypass'));
  const second = f.decide(f.request('questions', reference(first.record)));
  const now = Date.now;
  Date.now = () => now() + 31 * 60_000;
  try {
    const reopened = new Store(f.path);
    try {
      const head = readProjectMode(reopened, 'p');
      assert.equal(head.mode, 'questions');
      assert.deepEqual(head.ref, reference(second.record));
      assert.equal(readProjectMode(reopened, 'p', reference(first.record)).mode, 'bypass');
      assert.equal(reopened.get<{ state: string }>(second.record.value.authority.session.id)?.value.state, 'closed');
    } finally { reopened.close(); }
  } finally { Date.now = now; }
});

test('DR1a fsck accounts every project-mode reference site and flags a dangling one', t => {
  const f = fixture(t);
  const first = f.decide(f.request('bypass'));
  f.decide(f.request('questions', reference(first.record)));
  const report = checkStoreIntegrity(f.store);
  assert.deepEqual(report.findings, []);
  const head = f.modes()[0]!;
  const fields = referenceSites('project-mode', head.value).map(site => site.field).sort();
  assert.deepEqual(fields, ['authority.scope.previous', 'authority.session', 'previous']);
  const firstRevision = referenceSites('project-mode', f.store.get(head.id, 1)!.value).map(site => site.field);
  assert.deepEqual(firstRevision, ['authority.session']);

  const dangling = { ...head.value, previous: { id: head.id, revision: 99, hash: '0'.repeat(64) },
    authority: { session: head.value.authority.session,
      scope: { project: 'p', mode: 'questions', previous: { id: head.id, revision: 99, hash: '0'.repeat(64) } } } };
  f.store.write({ id: head.id, kind: 'project-mode', expected: head.revision, value: dangling });
  const damaged = checkStoreIntegrity(f.store);
  assert.ok(damaged.findings.some(finding => finding.code === 'reference_missing' && finding.id === head.id));
});

test('DR1a invitations are scoped, one-use and time bounded; exchange binds the exact scope', t => {
  const f = fixture(t), sessions = new ProjectModeSessions(f.store);
  const issued = ok(issueProjectModeInvitation(f.store, f.request('bypass')));
  const wrong = `${issued.invitation.slice(0, -1)}${issued.invitation.endsWith('0') ? '1' : '0'}`;
  const invalid = sessions.exchange({ project: 'p', invitation: wrong });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.refusal.code, 'owner_invitation_invalid');
  const exchanged = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  const spent = sessions.exchange({ project: 'p', invitation: issued.invitation });
  assert.equal(spent.ok, false);
  if (!spent.ok) assert.equal(spent.refusal.code, 'owner_invitation_spent');
  f.engine.execute({ type: 'create-project', project: 'other', title: 'Other' });
  const foreignIssued = ok(issueProjectModeInvitation(f.store, f.request('bypass')));
  const foreign = sessions.exchange({ project: 'other', invitation: foreignIssued.invitation });
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.refusal.code, 'owner_invitation_foreign');
  const grantNow = Date.now;
  Date.now = () => grantNow() + 11 * 60_000;
  try {
    const lateIssued = ok(issueProjectModeInvitation(f.store, f.request('bypass')));
    Date.now = () => grantNow() + 22 * 60_000;
    const expired = sessions.exchange({ project: 'p', invitation: lateIssued.invitation });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.refusal.code, 'owner_invitation_expired');
  } finally { Date.now = grantNow; }
  const missing = issueProjectModeInvitation(f.store, f.request('bypass', { id: 'project-mode:p', revision: 7, hash: '0'.repeat(64) }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.refusal.code, 'project_mode_stale');
  sessions.revoke(exchanged.bearer);
  assert.equal(f.modes().length, 0);
});

test('DR1a the trusted CLI writes and repeats the decision without exposing a live bearer', t => {
  const f = fixture(t), cli = resolve('dist/src/cli.js');
  const grants = f.store.list('owner-session-grant').length;
  const cliDoor = (error: any, code: string) => {
    const line = String(error.stderr).split(/\r?\n/).find((row: string) => row.startsWith('{"error"'));
    const body = line ? JSON.parse(line) : {};
    return body.error === code && body.door === 'owner-project-mode';
  };
  assert.throws(() => execFileSync(process.execPath, [cli, 'owner-project-mode', f.path], {
    input: JSON.stringify({ ...f.request('bypass'), bearer: 'not-a-credential' }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
    (error: any) => cliDoor(error, 'project_mode_invalid'));
  assert.throws(() => execFileSync(process.execPath, [cli, 'owner-project-mode', f.path], {
    input: JSON.stringify({ project: 'p', mode: 'forward' }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
    (error: any) => cliDoor(error, 'project_mode_invalid'));
  assert.equal(f.store.list('owner-session-grant').length, grants, 'invalid CLI input mints no invitation');
  const first = JSON.parse(execFileSync(process.execPath, [cli, 'owner-project-mode', f.path], {
    input: JSON.stringify(f.request('bypass')), encoding: 'utf8' }));
  const second = JSON.parse(execFileSync(process.execPath, [cli, 'owner-project-mode', f.path], {
    input: JSON.stringify(f.request('bypass')), encoding: 'utf8' }));
  assert.equal(first.repeated, false);
  assert.equal(first.mode, 'bypass');
  assert.equal(second.repeated, true);
  assert.deepEqual(second.record, first.record);
  assert.equal(Object.hasOwn(first, 'bearer'), false);
  assert.equal(Object.hasOwn(first, 'invitation'), false);
  assert.equal(f.modes().length, 1);
  assert.ok(f.sessions().every(session => session.value.state === 'closed'));
});

/** One lawful session in a fresh store; the probe then damages exactly the saved ground under test. */
function probeStore(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'omg-mode-probe-')), path = join(root, 'state.sqlite');
  const target = new Store(path);
  new ProductEngine(target).execute({ type: 'create-project', project: 'p', title: 'probe' });
  t.after(() => { target.close(); rmSync(root, { recursive: true, force: true }); });
  return target;
}
const openModeSession = (target: Store) => {
  const sessions = new ProjectModeSessions(target);
  const issued = ok(issueProjectModeInvitation(target, { project: 'p', mode: 'bypass', previous: null }));
  const exchanged = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  return { sessions, bearer: exchanged.bearer,
    session: target.get<ProjectModeSession>(exchanged.session.id, exchanged.session.revision)! };
};
const forgeDecision = (target: Store, sessionRef: Ref, scope: ProjectModeScope, at: number) =>
  target.write<ProjectModeRecord>({ id: projectModeId('p'), kind: 'project-mode', expected: 0,
    value: { contract: 'project-mode/v1', database: target.databaseId, project: 'p', mode: 'bypass',
      authority: { session: sessionRef, scope }, previous: null, at } });
const expectInvalid = (target: Store) => assert.throws(() => readProjectMode(target, 'p'),
  (error: any) => error.code === 'project_mode_invalid' && error.code !== 'project_mode_unset');
const writeAuthority = (target: Store, database: string, openedAt: number, grantExpiresAt: number) => {
  const grantValue = { contract: 'owner-session-grant/v3' as const, id: 'g1', database,
    action: 'project-mode' as const, method: 'local-pairing/v1' as const,
    scope: { project: 'p', mode: 'bypass' as const, previous: null },
    issuedAt: 1000, expiresAt: grantExpiresAt, proof: 'a'.repeat(64) };
  const grant = target.write({ id: `${PROJECT_MODE_GRANT_PREFIX}g1`,
    kind: 'owner-session-grant', expected: 0, value: grantValue });
  const grantRef = reference(grant), sessionId = projectModeSessionId(grantRef);
  const session = target.write<ProjectModeSession>({ id: sessionId, kind: 'owner-session', expected: 0,
    value: { contract: 'owner-session/v3', grant: grantRef, database, action: 'project-mode',
      method: 'local-pairing/v1', scope: grantValue.scope, session: 's1', openedAt,
      expiresAt: openedAt + OWNER_SESSION_LIFETIME_MS, state: 'open' } });
  return { grantRef, session };
};

test('DR1a the reader refuses a decision saved outside its session window', t => {
  const target = probeStore(t), minted = openModeSession(target);
  forgeDecision(target, reference(minted.session), minted.session.value.scope,
    minted.session.value.expiresAt + 1);
  expectInvalid(target);
  minted.sessions.revoke(minted.bearer);
});

test('DR1a the reader refuses a decision authorized by the closed session revision', t => {
  const target = probeStore(t), minted = openModeSession(target);
  minted.sessions.revoke(minted.bearer);
  const closed = target.get<ProjectModeSession>(minted.session.id)!;
  assert.equal(closed.value.state, 'closed');
  forgeDecision(target, reference(closed), closed.value.scope, closed.value.closedAt! + 1);
  expectInvalid(target);
});

test('DR1a the reader refuses a chain whose grant and session belong to another database', t => {
  const target = probeStore(t);
  const { session } = writeAuthority(target, 'other-database', 2000, 1000 + OWNER_GRANT_LIFETIME_MS);
  forgeDecision(target, reference(session), session.value.scope, 3000);
  expectInvalid(target);
});

test('DR1a the reader refuses a session exchanged after its grant expired', t => {
  const target = probeStore(t);
  const openedAt = 1000 + OWNER_GRANT_LIFETIME_MS + 1;
  const { session } = writeAuthority(target, target.databaseId, openedAt, 1000 + OWNER_GRANT_LIFETIME_MS);
  forgeDecision(target, reference(session), session.value.scope, openedAt + 1);
  expectInvalid(target);
});

test('DR1a the saved moment is the checked one: at or after session expiry nothing is written', t => {
  const f = fixture(t), minted = f.mint(f.request('bypass'));
  const session = f.store.get<ProjectModeSession>(minted.session.id, minted.session.revision)!;
  const now = Date.now;
  Date.now = () => session.value.expiresAt - 1;
  try {
    const decided = setProjectMode(f.store, f.request('bypass'), minted.authority);
    assert.equal(decided.repeated, false);
    assert.equal(decided.record.value.at, session.value.expiresAt - 1,
      'the record keeps the exact instant the authority proved the session live');
    assert.equal(readProjectMode(f.store, 'p').mode, 'bypass');
  } finally { Date.now = now; }
  Date.now = () => session.value.expiresAt;
  try {
    assert.throws(() => setProjectMode(f.store, f.request('bypass'), minted.authority),
      { code: 'owner_session_expired' });
  } finally { Date.now = now; minted.sessions.revoke(minted.bearer); }
  assert.equal(f.modes()[0]!.revision, 1);
});

test('DR1a an exchange a millisecond before its grant was issued writes no session', t => {
  const f = fixture(t), sessions = new ProjectModeSessions(f.store);
  const issued = ok(issueProjectModeInvitation(f.store, f.request('bypass')));
  const issuedAt = f.store.get<{ issuedAt: number }>(issued.grant.id, issued.grant.revision)!.value.issuedAt;
  const now = Date.now;
  Date.now = () => issuedAt - 1;
  try {
    const exchanged = sessions.exchange({ project: 'p', invitation: issued.invitation });
    assert.equal(exchanged.ok, false);
    if (!exchanged.ok) assert.equal(exchanged.refusal.code, 'owner_invitation_invalid');
    assert.equal(f.store.get(projectModeSessionId(issued.grant)), null, 'no session was persisted');
  } finally { Date.now = now; }
  // Once the clock reaches the grant window the same invitation still exchanges lawfully.
  const exchanged = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  sessions.revoke(exchanged.bearer);
});

test('DR1a a decision a millisecond before its session opened writes nothing', t => {
  const f = fixture(t), minted = f.mint(f.request('bypass'));
  const openedAt = f.store.get<ProjectModeSession>(minted.session.id, minted.session.revision)!.value.openedAt;
  const now = Date.now;
  Date.now = () => openedAt - 1;
  try {
    assert.throws(() => setProjectMode(f.store, f.request('bypass'), minted.authority),
      { code: 'owner_session_expired' });
  } finally { Date.now = now; minted.sessions.revoke(minted.bearer); }
  assert.equal(f.modes().length, 0, 'no mode record was persisted');
  assert.throws(() => readProjectMode(f.store, 'p'), { code: 'project_mode_unset' });
});

test('DR1a a switch a millisecond older than the recorded head is refused and the head stays', t => {
  const f = fixture(t);
  const first = f.decide(f.request());
  const headAt = first.record.value.at;
  const now = Date.now;
  Date.now = () => headAt - 1;
  let minted!: ReturnType<typeof f.mint>;
  try {
    minted = f.mint({ project: 'p', mode: 'bypass', previous: reference(first.record) });
    assert.throws(() => setProjectMode(f.store,
      { project: 'p', mode: 'bypass', previous: reference(first.record) }, minted.authority),
      { code: 'project_mode_stale' });
  } finally { Date.now = now; minted.sessions.revoke(minted.bearer); }
  assert.equal(f.modes().length, 1, 'no new head was persisted');
  assert.equal(readProjectMode(f.store, 'p').mode, 'questions');
  assert.equal(readProjectMode(f.store, 'p').record.revision, 1);
});

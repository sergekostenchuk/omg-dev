import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProductEngine } from '../src/product/engine.js';
import { parseCommand } from '../src/product/commands.js';
import { createProductServer } from '../src/server.js';
import { reference } from '../src/pipeline/contracts.js';
import { FinalAcceptanceSessions, issueFinalAcceptanceInvitation, acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { all, money, modeOf } from './discovery-v7-dossier-seed.js';
import { storeUnchanged } from './store-unchanged.js';
import { proveClaimAddress } from '../src/discovery/claim-address.js';

test('7b commands: questions JSON cannot mint or carry owner authority', async t => {
  const f = await finalAssessmentPaid(t), engine = new ProductEngine(f.store);
  const command = { type: 'discovery-final-decision', project: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Accept exact bundle' };
  const before = all(f.store), calls = money(f.store), wire = f.wires();
  for (const extra of [{ authority: { owner: true } }, { bearer: 'secret' }, { invitation: 'secret' }, { actor: 'owner' }])
    assert.throws(() => parseCommand({ ...command, ...extra }), { code: 'command_invalid' });
  await assert.rejects(async () => engine.execute(command), { code: 'owner_authority_invalid' });
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

test('7b commands: saved bypass accepts once and exact reading preserves the complete conditional bundle', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional' });
  modeOf(f.store, 'bypass');
  const engine = new ProductEngine(f.store), calls = money(f.store), wire = f.wires();
  const command = { type: 'discovery-final-decision', project: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Saved bypass policy' };
  const result = await engine.execute(command) as any;
  assert.equal(result.accepted.outcome, 'conditional'); assert.equal(result.accepted.unresolved, true);
  assert.deepEqual(result.accepted.value, f.result.value.projection.candidate);
  const before = all(f.store);
  const read = await storeUnchanged(f.store, async () => engine.execute({ type: 'discovery-final-accepted', project: 'p', manifest: result.accepted.manifest }));
  assert.deepEqual(read, result.accepted);
  const material = f.packet.final.dossier.materials.find(item => {
    try { proveClaimAddress(f.store, item.address); return true; } catch { return false; }
  })!;
  assert.ok(material);
  await assert.rejects(async () => engine.execute({ type: 'discovery-final-condition', project: 'p',
    manifest: result.accepted.manifest, conditionId: 'evidence-1', claims: [material.address], reason: 'Existing evidence' }),
    { code: 'discovery_condition_evidence_unproven' });
  const repeated = await storeUnchanged(f.store, async () => engine.execute(command)) as any;
  assert.equal(repeated.repeated, true); assert.deepEqual(repeated.accepted, result.accepted);
  await assert.rejects(async () => engine.execute({ type: 'discovery-final-accepted', project: 'other', manifest: result.accepted.manifest }));
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

test('7b commands: a saved owner decline reads back without publishing a manifest', async t => {
  const f = await finalAssessmentPaid(t), mode = readProjectMode(f.store, 'p').ref;
  const request = { projectId: 'p', assessment: f.paidResult, decision: 'decline' as const, reason: 'Owner declines' };
  const issued = await issueFinalAcceptanceInvitation(f.store, { ...request, draft: f.packet.final.subject.basis.draft, paid: f.paidD7, mode });
  assert.ok(issued.ok);
  const sessions = new FinalAcceptanceSessions(f.store), login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
  assert.ok(login.ok);
  const calls = money(f.store), wire = f.wires();
  const saved = await acceptDiscoveryFinal(f.store, request, sessions.authority(login.value.bearer));
  sessions.revoke(login.value.bearer);
  assert.equal(saved.decision, 'decline');
  const result = await storeUnchanged(f.store, async () => new ProductEngine(f.store).execute({ type: 'discovery-final-decision',
    project: 'p', assessment: f.paidResult, decision: 'decline', reason: request.reason })) as any;
  assert.equal(result.decision, 'decline'); assert.equal(result.accepted, null); assert.equal(result.repeated, true);
  assert.deepEqual(result.act, reference(saved.act!)); assert.equal(f.store.list('discovery-manifest').length, 0);
  assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);

  // The CLI file shares a conditional world. Keep its separate go-path here,
  // on an independent copy of this file's already paid go world.
  const go = await finalAssessmentPaid(t), goCalls = money(go.store), goWire = go.wires();
  const run = (door: string, input: unknown) => {
    const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), door, go.path],
      { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.doesNotMatch(stdout, /"(?:invitation|bearer|proof|session)"\s*:/);
    return JSON.parse(stdout);
  };
  const positive = run('owner-final-acceptance', { type: 'discovery-final-decision', project: 'p',
    assessment: go.paidResult, decision: 'accept', reason: 'Independent go acceptance' });
  assert.equal(positive.accepted.outcome, 'go'); assert.equal(positive.accepted.unresolved, false);
  const sessionsAfter = go.store.list<any>('owner-session').filter(row => row.value.contract === 'owner-session/v6');
  assert.equal(sessionsAfter.length, 1); assert.equal(sessionsAfter[0]!.value.state, 'closed');
  assert.deepEqual(run('command', { type: 'discovery-final-accepted', project: 'p', manifest: positive.accepted.manifest }), positive.accepted);
  assert.deepEqual(money(go.store), goCalls); assert.deepEqual(go.wires(), goWire);
});

test('7b commands: HTTP uses the same unauthorised questions path and closed schema', async t => {
  const f = await finalAssessmentPaid(t), server = createProductServer(new ProductEngine(f.store));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/command`;
  const before = all(f.store), calls = money(f.store), wire = f.wires();
  for (const extra of [{}, { authority: { owner: true } }]) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-omg-token': server.accessToken },
      body: JSON.stringify({ type: 'discovery-final-decision', project: 'p', assessment: f.paidResult, decision: 'accept', reason: 'HTTP input', ...extra }) });
    assert.notEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(['owner_authority_invalid', 'command_invalid'].includes(body.error));
  }
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

test('7b commands: absent project mode cannot become bypass and malformed exact inputs write nothing', async t => {
  const f = await finalAssessmentPaid(t), engine = new ProductEngine(f.store);
  await engine.execute({ type: 'create-project', project: 'unset', title: 'No policy chosen' });
  const before = all(f.store), calls = money(f.store), wire = f.wires();
  await assert.rejects(async () => engine.execute({ type: 'discovery-final-decision', project: 'unset',
    assessment: f.paidResult, decision: 'accept', reason: 'No implicit policy' }), { code: 'discovery_acceptance_mode_unset' });
  for (const assessment of [null, { ...f.paidResult, hash: 'bad' }, { ...f.paidResult, authority: true }])
    assert.throws(() => engine.execute({ type: 'discovery-final-decision', project: 'p', assessment,
      decision: 'accept', reason: 'Exact ground required' }), { code: 'command_invalid' });
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

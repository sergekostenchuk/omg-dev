import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { all, money } from './discovery-v7-dossier-seed.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { reference } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';

const conditions = [{ id: 'owner-1', kind: 'owner_choice', condition: 'Bound first release', criterion: 'Owner picks a bound',
    options: [{ optionId: 'narrow', label: 'Narrow', consequences: ['Only ledger ships'], choice: 'accept' },
      { optionId: 'stop', label: 'Stop', consequences: ['Wait'], choice: 'decline' }] }];

async function cli(door: string, path: string, input: unknown, raw = false) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), door, path],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  child.stdin.end(raw ? String(input) : JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const line = (code === 0 ? stdout : stderr).split('\n').find(value => value.startsWith('{'));
  assert.ok(line, `CLI returned no JSON: ${stderr}`);
  const output = JSON.parse(line);
  assert.doesNotMatch(stdout, /"(?:invitation|bearer|proof|session)"\s*:/);
  return { code, output, stdout, stderr };
}

test('7b CLI: decline saves no manifest and forged credential fields refuse before any write', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions });
  const command = { type: 'discovery-final-decision', project: 'p', assessment: f.paidResult, decision: 'decline', reason: 'Owner refuses' };
  const before = all(f.store), calls = money(f.store), wire = f.wires();
  const malformed = await cli('owner-final-acceptance', f.path, '{', true);
  assert.equal(malformed.code, 1); assert.equal(malformed.output.error, 'command_invalid');
  assert.equal(all(f.store), before);
  const forged = await cli('owner-final-acceptance', f.path, { ...command, authority: { owner: true } });
  assert.equal(forged.code, 1); assert.equal(forged.output.error, 'command_invalid'); assert.equal(all(f.store), before);
  const result = await cli('owner-final-acceptance', f.path, command);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.output.accepted, null); assert.equal(result.output.decision, 'decline');
  assert.equal(f.store.list('discovery-manifest').length, 0);
  assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

test('7b CLI: trusted owner accept creates and closes its scoped session without exposing credentials', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions }), calls = money(f.store), wire = f.wires();
  const command = { type: 'discovery-final-decision', project: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Owner accepts exact result' };
  const result = await cli('owner-final-acceptance', f.path, command);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.output.accepted.outcome, 'conditional');
  assert.equal(result.output.accepted.unresolved, true);
  const sessions = f.store.list<any>('owner-session').filter(row => row.value.contract === 'owner-session/v6');
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.value.state, 'closed');
  const read = await cli('command', f.path, { type: 'discovery-final-accepted', project: 'p', manifest: result.output.accepted.manifest });
  assert.equal(read.code, 0, read.stderr); assert.deepEqual(read.output, result.output.accepted);
  assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

test('7b CLI: accepting a condition saves only its act and displays unresolved condition_class_unproven', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions });
  modeOf(f.store, 'bypass');
  const accepted = (await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Saved policy' })).accepted!;
  const command = { type: 'discovery-final-condition', project: 'p', manifest: reference(accepted.manifest), conditionId: 'owner-1', optionId: 'narrow', reason: 'Bound the release' };
  const calls = money(f.store), wire = f.wires(), count = f.store.list('discovery-manifest').length;
  const before = all(f.store);
  await assert.rejects(async () => new ProductEngine(f.store).execute(command), { code: 'owner_authority_invalid' });
  assert.equal(all(f.store), before);
  const result = await cli('owner-final-condition', f.path, command);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.output.choice, 'accept');
  assert.equal(result.output.edition, null); assert.equal(result.output.resolved, false); assert.equal(result.output.unresolved, true);
  assert.equal(result.output.reason, 'condition_class_unproven');
  assert.equal(f.store.list('discovery-manifest').length, count);
  const repeated = await cli('command', f.path, command);
  assert.equal(repeated.code, 0, repeated.stderr); assert.equal(repeated.output.repeated, true);
  assert.equal(repeated.output.unresolved, true); assert.deepEqual(repeated.output.act, result.output.act);
  assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

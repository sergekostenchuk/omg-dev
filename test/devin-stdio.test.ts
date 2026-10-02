import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/runtime/process.js';

const adapter = fileURLToPath(new URL('../src/adapters/devin-stdio.js', import.meta.url));
const originalPath = process.env['PATH'];

/** A fake `devin` executable: it records argv, the prompt file's content and mode,
 * then answers from the rewritable scenario file. No live provider is ever called. */
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-devin-stdio-')), bin = join(root, 'bin');
  const trace = join(root, 'trace.json'), scenario = join(root, 'scenario.txt');
  mkdirSync(bin);
  writeFileSync(join(bin, 'devin'), `#!${process.execPath}
import {readFileSync,writeFileSync,statSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('devin 3000.11.3 (fixture)');process.exit(0);}
const file=args[args.indexOf('--prompt-file')+1];
const prompt=file?readFileSync(file,'utf8'):'';
const mode=file?('0'+((statSync(file).mode)&0o777).toString(8)):'none';
writeFileSync(${JSON.stringify(trace)},JSON.stringify({args,prompt,mode,promptFile:file}));
const scenario=readFileSync(${JSON.stringify(scenario)},'utf8').trim();
if(scenario==='fail'){console.error('fixture denial');process.exit(3);}
if(scenario==='sleep'){setInterval(()=>{},1000);}
else if(scenario==='empty'){}
else if(scenario==='malformed')console.log('not json {');
else if(scenario==='extra')console.log('{"action":"pause"}\\n{"unexpected":true}');
else if(scenario==='array')console.log('[]');
else if(scenario==='research')console.log(JSON.stringify({action:'pause',reason:'Fixture'}));
else if(scenario==='reader')console.log(JSON.stringify({selections:[{sourceIndex:0,firstLine:1,lastLine:2}],unresolved:['u']}));
else if(scenario==='reader-bad')console.log(JSON.stringify({selections:[{sourceIndex:-1,firstLine:0,lastLine:0}],unresolved:'x'}));
else if(scenario==='implement')console.log(JSON.stringify({text:'done',artifacts:[{id:'a'}]}));
else if(scenario.startsWith('implement='))console.log(scenario.slice('implement='.length));
else if(scenario==='implement-bad')console.log(JSON.stringify({text:'done'}));
else if(scenario==='review-pass')console.log(JSON.stringify({verdict:'pass',kind:'none',findings:[]}));
else if(scenario==='review-changes')console.log(JSON.stringify({verdict:'request_changes',kind:'code',findings:['f']}));
else if(scenario==='review-bad')console.log(JSON.stringify({verdict:'pass',kind:'code',findings:[]}));
else console.log('plain answer text');
`, { mode: 0o700 });
  writeFileSync(scenario, 'text');
  process.env['PATH'] = bin + delimiter + (originalPath ?? '');
  t.after(() => {
    if (originalPath === undefined) delete process.env['PATH']; else process.env['PATH'] = originalPath;
    rmSync(root, { recursive: true, force: true });
  });
  const call = (request: Record<string, unknown> | string, options: string[] = []) =>
    runProcess({ executable: process.execPath, args: [adapter, ...options] }, root,
      typeof request === 'string' ? request : JSON.stringify(request), 30_000);
  const req = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ protocol: 'omg-agent/v1', requestId: 'r1', mode: 'chat', model: 'swe-2-high', effort: 'high', prompt: 'Fixture question', ...overrides });
  const reset = () => { rmSync(trace, { force: true }); };
  const ran = () => existsSync(trace);
  const traced = () => JSON.parse(readFileSync(trace, 'utf8')) as { args: string[]; prompt: string; mode: string; promptFile: string };
  return { root, call, req, reset, ran, traced, scenario: (value: string) => writeFileSync(scenario, value) };
}

/** The adapter's own diagnostic JSON is stderr's last line; earlier lines may hold runtime warnings. */
function errorOf(result: { stderr: string }): string {
  return JSON.parse(result.stderr.trim().split('\n').filter(line => line.startsWith('{')).pop() ?? '{}')['error'] ?? 'none';
}

test('all four modes and the reader role share the exact argv and the 0600 prompt file', async t => {
  const f = fixture(t);
  const modes: [string, string, Record<string, unknown>, (payload: Record<string, unknown>) => void][] = [
    ['text', 'chat', {}, payload => assert.equal(payload['text'], 'plain answer text')],
    ['research', 'research', {}, payload => assert.deepEqual(payload['research'], { action: 'pause', reason: 'Fixture' })],
    ['reader', 'research', { subject: { role: 'reader' } },
      payload => assert.deepEqual(payload['research'], { selections: [{ sourceIndex: 0, firstLine: 1, lastLine: 2 }], unresolved: ['u'] })],
    ['implement', 'implement', {}, payload => assert.deepEqual(payload['artifacts'], [{ id: 'a' }])],
    ['review-pass', 'review', {}, payload => assert.deepEqual(payload['review'], { verdict: 'pass', kind: 'none', findings: [] })],
    ['review-changes', 'review', {}, payload => assert.deepEqual(payload['review'], { verdict: 'request_changes', kind: 'code', findings: ['f'] })],
  ];
  for (const [scenario, mode, extra, check] of modes) {
    f.scenario(scenario); f.reset();
    const result = await f.call(f.req({ mode, ...extra }));
    assert.equal(result.exitCode, 0, `${mode}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload['protocol'], 'omg-agent/v1'); assert.equal(payload['requestId'], 'r1');
    assert.equal(payload['usage'], null, 'Devin usage is always null');
    assert.deepEqual(payload['confirmed'], { model: null, effort: null, speed: null });
    check(payload);
    const trace = f.traced();
    assert.deepEqual(trace.args.slice(0, -1), ['--print', '--model', 'swe-2-high', '--permission-mode',
      mode === 'implement' ? 'accept-edits' : 'auto', '--sandbox', '--respect-workspace-trust=false', '--prompt-file'], `${mode} argv`);
    assert.equal(trace.args[trace.args.length - 1], trace.promptFile);
    assert.equal(trace.mode, '0600', 'the prompt file is private');
    assert.ok(trace.prompt.includes('Fixture question'));
    assert.equal(existsSync(dirname(trace.promptFile)), false, 'the temporary prompt directory is cleaned');
    if (extra['subject']) assert.ok(trace.prompt.endsWith(`Subject:\n${JSON.stringify(extra['subject'])}`));
  }
});

test('the full prompt travels through the file, never argv, without truncation', async t => {
  const f = fixture(t), prompt = 'Long instruction. '.repeat(150_000) + 'ENDMARKER';
  f.reset();
  const result = await f.call(f.req({ prompt }));
  assert.equal(result.exitCode, 0, result.stderr);
  const trace = f.traced();
  assert.ok(!trace.args.some(arg => arg.includes('ENDMARKER')), 'argv never carries the prompt');
  assert.ok(trace.prompt.endsWith('ENDMARKER') && trace.prompt.length > prompt.length, 'the file keeps the complete prompt');
});

test('unsupported speed, option, effort and a model mismatch refuse before the CLI ever launches', async t => {
  const f = fixture(t);
  const cases: [string, Record<string, unknown>, string[], string][] = [
    ['adapter_option_invalid', { speed: 'fast' }, [], 'fast speed'],
    ['adapter_option_invalid', {}, ['--compact-research'], 'compact research option'],
    ['adapter_option_invalid', {}, ['--other'], 'unknown option'],
    ['adapter_effort_unsupported', { effort: 'low', model: 'swe-2-medium' }, [], 'low effort'],
    ['adapter_effort_unsupported', { effort: 'xhigh' }, [], 'xhigh effort'],
    ['adapter_effort_unsupported', { effort: 'ultra' }, [], 'ultra effort'],
    ['adapter_model_invalid', { model: 'swe-2-max', effort: 'high' }, [], 'effort/model mismatch'],
    ['adapter_input_invalid', { effort: 'strange', model: 'x' }, [], 'unknown effort value'],
    ['adapter_input_invalid', { protocol: 'other/v9' }, [], 'foreign protocol'],
    ['adapter_input_invalid', { mode: 'edit' }, [], 'unknown mode'],
    ['adapter_input_invalid', { speed: 'warp' }, [], 'unknown speed value'],
  ];
  for (const [code, overrides, options, label] of cases) {
    f.reset();
    const result = await f.call(f.req(overrides), options);
    assert.notEqual(result.exitCode, 0, label);
    if (result.stdout.trim()) { // Options rejected before the request is read emit no envelope.
      const reply = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(reply['requestId'], 'r1', label); assert.equal(reply['usage'], null, label);
    }
    assert.equal(errorOf(result), code, label);
    assert.equal(f.ran(), false, `${label}: the provider was never launched`);
  }
  for (const [effort, model] of [['medium', 'swe-2-medium'], ['high', 'swe-2-high'], ['max', 'swe-2-max']] as const) {
    f.reset();
    const result = await f.call(f.req({ effort, model }));
    assert.equal(result.exitCode, 0, `${effort}: ${result.stderr}`);
    assert.equal(f.traced().args[f.traced().args.indexOf('--model') + 1], model);
  }
});

test('empty, malformed, extra or wrongly shaped output is a typed invalid result, never salvaged', async t => {
  const f = fixture(t);
  for (const [scenario, code] of [['empty', 'provider_empty'], ['malformed', 'provider_result_invalid'],
    ['extra', 'provider_result_invalid'], ['array', 'provider_result_invalid']] as const) {
    for (const mode of ['research', 'implement', 'review'] as const) {
      f.scenario(scenario); f.reset();
      const result = await f.call(f.req({ mode }));
      assert.notEqual(result.exitCode, 0);
      assert.equal(errorOf(result), code, `${scenario}/${mode}`);
    }
  }
  for (const [scenario, mode, extra] of [['reader-bad', 'research', { subject: { role: 'reader' } }],
    ['implement-bad', 'implement', {}], ['review-bad', 'review', {}]] as const) {
    f.scenario(scenario); f.reset();
    const result = await f.call(f.req({ mode, ...extra }));
    assert.notEqual(result.exitCode, 0);
    assert.equal(errorOf(result), 'provider_result_invalid', `${scenario}`);
    assert.equal((JSON.parse(result.stdout) as Record<string, unknown>)['usage'], null);
  }
});

test('a CLI failure maps to provider_failed with the bounded stderr, and chat keeps plain text', async t => {
  const f = fixture(t);
  f.scenario('fail');
  const result = await f.call(f.req({ mode: 'research' }));
  assert.notEqual(result.exitCode, 0);
  assert.equal(errorOf(result), 'provider_failed');
  assert.match(result.stderr, /fixture denial/);
  const reply = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(reply['protocol'], 'omg-agent/v1'); assert.equal(reply['usage'], null);
});

test('the adapter boundary keeps typed cancellation and a refused stop through the process machinery', async t => {
  const f = fixture(t);
  f.scenario('sleep');
  const controller = new AbortController(), request = JSON.stringify(f.req());
  const run = runProcess({ executable: process.execPath, args: [adapter] }, f.root, request, 30_000, controller.signal, true,
    undefined, { signal: () => 'EPERM', probeGroup: () => 'EPERM' });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(run, (error: unknown) => (error as { code?: string }).code === 'process_stop_denied');
  const early = new AbortController(); early.abort();
  await assert.rejects(runProcess({ executable: process.execPath, args: [adapter] }, f.root, request, 3_000, early.signal),
    (error: unknown) => (error as { code?: string }).code === 'process_cancelled');
});

test('a non-object or unparseable request body is adapter_input_invalid before any launch', async t => {
  const f = fixture(t);
  for (const raw of ['null', '{', '[]', '"text"', '17', 'true']) {
    f.reset();
    const result = await f.call(raw);
    assert.notEqual(result.exitCode, 0, raw);
    assert.equal(errorOf(result), 'adapter_input_invalid', raw);
    assert.equal(f.ran(), false, `${raw}: the provider was never launched`);
  }
});

test('implementation artifacts must each be an object carrying exactly an id string', async t => {
  const f = fixture(t);
  for (const artifacts of [[null], [{}], [{ id: 17 }], [{ id: 'ok', extra: 1 }]]) {
    f.scenario(`implement=${JSON.stringify({ text: 'done', artifacts })}`); f.reset();
    const result = await f.call(f.req({ mode: 'implement' }));
    assert.notEqual(result.exitCode, 0, JSON.stringify(artifacts));
    assert.equal(errorOf(result), 'provider_result_invalid', JSON.stringify(artifacts));
  }
  f.scenario(`implement=${JSON.stringify({ text: 'done', artifacts: [{ id: 'a' }] })}`); f.reset();
  const lawful = await f.call(f.req({ mode: 'implement' }));
  assert.equal(lawful.exitCode, 0, lawful.stderr);
  assert.deepEqual((JSON.parse(lawful.stdout) as Record<string, unknown>)['artifacts'], [{ id: 'a' }]);
});

test('the closed provider table cannot be mutated through any issued descriptor', async () => {
  const { STDIO_PROVIDERS, STDIO_PROTOCOLS, isStdioProtocol, stdioProviderByModule, stdioProviderByProtocol } =
    await import('../src/adapters/stdio-providers.js');
  for (const descriptor of [stdioProviderByProtocol('devin-stdio')!, stdioProviderByModule('devin-stdio.js')!]) {
    Reflect.set(descriptor, 'protocol', 'pretend');
    Reflect.set(descriptor, 'executable', 'pretend-bin');
    assert.equal(isStdioProtocol('pretend'), false, 'a returned descriptor never alters the protocol set');
    assert.equal(stdioProviderByModule('devin-stdio.js')!.executable, 'devin');
  }
  // The table's own rows and their nested version patterns are frozen data — the live RegExp
  // is never issued, so compile() cannot rewrite the policy's matcher either.
  const row = STDIO_PROVIDERS.find(provider => provider.protocol === 'devin-stdio')!;
  assert.equal(Reflect.set(row, 'protocol', 'pretend'), false);
  assert.equal(Reflect.set(row.versionPattern, 'source', '^pretend'), false);
  assert.ok(new RegExp(row.versionPattern.source, row.versionPattern.flags).test('devin 9.9.9'));
  assert.deepEqual([...STDIO_PROTOCOLS].sort(), ['codex-stdio', 'devin-stdio']);
});

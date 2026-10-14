import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Revision } from '../src/storage/store.js';
import { Environments, type Environment, type WebResearchSettings } from '../src/runtime/environment.js';
import { Evidence, SOURCE_MAX_BYTES, type Source } from '../src/evidence/evidence.js';
import { ProductEngine } from '../src/product/engine.js';
import { digest } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import type { ResearchTurn } from '../src/discovery/research-model.js';
import { resolveResearchBasis } from '../src/graph/research-basis.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { researchAction, responseAction, admittedResearchAction, webResearchCapability } from '../src/discovery/research-consumer-transition.js';
import { earlyResearchFailure, earlyResearchCorrection } from '../src/discovery/early-research-outcome.js';
import { readResearchConsumerIntent, earlyResearchConsumerFailure, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { UPSTREAM_STAGES, REQUIREMENTS } from '../src/discovery/requirements.js';
import { preparedField } from './preparation-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { designOf } from '../src/graph/builder.js';
import { ResearchSources } from '../src/discovery/research-sources.js';
import type { StageResearchResult } from '../src/product/stage-research.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { executeWebTurn, webBudgetView, webCaptureId, webAction, webUrlRefusal, type WebCapture } from '../src/discovery/web-research.js';

type Route = (body: any, url: URL) => { status: number; body: unknown } | 'drop' | 'hang';
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

async function gateway(t: test.TestContext, routes: { search?: Route; fetch?: Route }) {
  const hits: { path: string; body: any }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const url = new URL(request.url!, 'http://gateway');
      const body = raw ? JSON.parse(raw) : null;
      hits.push({ path: url.pathname, body: url.pathname === '/search' ? url.searchParams.get('q') : body });
      const route = url.pathname === '/search' ? routes.search : url.pathname === '/fetch' ? routes.fetch : undefined;
      const reply = route ? route(body, url) : { status: 404, body: { error: 'not_found' } };
      if (reply === 'drop') { request.socket.destroy(); return; }
      if (reply === 'hang') { setTimeout(() => request.socket.destroy(), 5000).unref(); return; }
      const data = JSON.stringify(reply.body);
      response.writeHead(reply.status, { 'Content-Type': 'application/json' }); response.end(data);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const settings = (gatewayUrl: string, limits: Partial<WebResearchSettings['limits']> = {}): WebResearchSettings => ({
  enabled: true, gatewayUrl, timeoutMs: 5000,
  limits: { httpAttempts: 20, pages: 10, receivedChars: 1_000_000, responseBytes: 2_000_000, ...limits } });

function fixture(t: test.TestContext, web?: WebResearchSettings | null, project = 'p') {
  const root = mkdtempSync(join(tmpdir(), 'omg-wb1-'));
  const path = join(root, 'state.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = { executable: process.execPath, args: [] };
  const value = { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000,
    ...(web ? { webResearch: web } : {}) };
  const environment = new Environments(store).configure(project, value, 0);
  store.write({ id: `research-run:${project}`, kind: 'research-run', expected: 0, value: { projectId: project, draftId: 'discovery:d' } });
  let turns = 0;
  const pending = (action: unknown, view = store): Revision<ResearchTurn> => view.write<ResearchTurn>({ id: `research-turn:${project}:${++turns}`,
    kind: 'research-turn', expected: 0, value: { run: `research-run:${project}`, number: turns, action, assessment: null,
      observation: null, error: null, status: 'pending', question: null } });
  const run = (turn: Revision<ResearchTurn>, view = store, env: Revision<Environment> = environment) =>
    executeWebTurn({ store: view, projectId: project, stage: 'discovery', environment: env, turn, now: () => '2026-10-14T00:00:00.000Z' });
  return { root, path, store, environment, pending, run, value };
}

const hit = (url: string, title = 'Title') => ({ url, title, snippet: `About ${title}`, score: 1, engines: ['google cse'] });
const searchBody = (q: string, results: unknown[], unresponsive: [string, string][] = [], engines = ['google cse', 'mojeek']) =>
  ({ status: 200, body: { query: q, results, engines_queried: engines, unresponsive_engines: unresponsive, elapsed_ms: 5 } });
const page = (url: string, text: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { requested_url: url, resolved_url: url,
  redirects: [], final_url: url, fetched_at: '2026-10-14T00:00:01+00:00', status: 200, success: true, failure: null, text,
  truncated: false, chars_total: text.length, chars: text.length, sha256: 'x', extraction: 'crawl4ai/raw_markdown', completeness: 'unknown', ...extra } });

test('WB1-01 configure keeps an environment without webResearch unchanged and validates the setting it carries', async t => {
  const plain = fixture(t, null);
  assert.equal(Object.hasOwn(plain.environment.value, 'webResearch'), false);
  const web = fixture(t, settings('http://127.0.0.1:18890'));
  assert.deepEqual(web.environment.value.webResearch, settings('http://127.0.0.1:18890'));
  const environments = new Environments(web.store);
  for (const [field, bad] of [['gatewayUrl', { gatewayUrl: 'ftp://gateway' }], ['gatewayUrl', { gatewayUrl: 'http://u:p@gateway' }],
    ['timeoutMs', { timeoutMs: 10 }], ['enabled', { enabled: 'yes' }], ['limits', { limits: { httpAttempts: 1 } }],
    ['limits.pages', { limits: { httpAttempts: 1, pages: 0, receivedChars: 1, responseBytes: 1 } }], ['extra', { extra: true }]] as const)
    assert.throws(() => environments.configure('p', { ...web.value, webResearch: { ...settings('http://g'), ...bad } as any }, web.environment.revision),
      (error: unknown) => error instanceof EngineError && error.code === 'environment_invalid'
        && String((error.details as any).field).startsWith(`webResearch.${field === 'extra' ? 'extra' : field}`), field);
  const engine = new ProductEngine(web.store);
  await assert.rejects(Promise.resolve().then(() => engine.execute({ type: 'configure', project: 'p', expected: web.environment.revision,
    environment: { ...web.value, webResearch: { ...settings('http://g'), unknown: 1 } } } as any)), (error: unknown) => error instanceof EngineError);
  assert.equal(web.store.get('environment:p')!.revision, web.environment.revision);
});

test('WB1-02 web_search saves the gateway answer and delivers navigation results with the stage budget', async t => {
  const g = await gateway(t, { search: (_b, url) => searchBody(url.searchParams.get('q')!, [hit('https://example.org/a', 'A'), hit('https://example.org/b', 'B')]) });
  const f = fixture(t, settings(g.url));
  const turn = f.pending({ action: 'web_search', query: 'harness subscription login', purpose: 'find vendors' });
  const outcome = await f.run(turn);
  const observation = outcome.turn.value.observation as any;
  assert.equal(outcome.turn.value.status, 'completed'); assert.equal(outcome.turn.value.error, null);
  assert.equal(observation.kind, 'web_search'); assert.equal(observation.outcome, 'ok');
  assert.deepEqual(observation.results.map((r: any) => r.url), ['https://example.org/a', 'https://example.org/b']);
  assert.equal(outcome.source, null, 'search results are navigation, never a Source');
  const capture = f.store.get<WebCapture>(webCaptureId(reference(turn)))!;
  assert.deepEqual(observation.capture, reference(capture));
  assert.deepEqual(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used, { attempts: 1, pages: 0, receivedChars: 0 });
  assert.equal(g.hits.length, 1); assert.equal(g.hits[0]!.body, 'harness subscription login');
});

for (const [label, results, unresponsive, engines, expected] of [
  ['partial', [hit('https://example.org/a')], [['mojeek', 'CAPTCHA']], ['google cse', 'mojeek'], 'partial'],
  ['empty but answered', [], [], ['google cse', 'mojeek'], 'ok'],
  ['empty with some engines failed', [], [['mojeek', 'timeout']], ['google cse', 'mojeek'], 'partial'],
  ['every engine failed', [], [['google cse', 'timeout'], ['mojeek', 'CAPTCHA']], ['google cse', 'mojeek'], 'unavailable'],
] as const) test(`WB1-03 search outcome ${label} is ${expected}, not a research conclusion`, async t => {
  const g = await gateway(t, { search: (_b, url) => searchBody(url.searchParams.get('q')!, [...results], unresponsive.map(r => [...r]) as [string, string][], [...engines]) });
  const f = fixture(t, settings(g.url));
  const outcome = await f.run(f.pending({ action: 'web_search', query: 'q', purpose: 'p' }));
  assert.equal((outcome.turn.value.observation as any).outcome, expected);
  assert.equal(outcome.turn.value.error, null);
});

test('WB1-04 web_fetch saves an immutable web snapshot that read_source and exact citations use', async t => {
  const text = '# Pricing\nSubscription login uses OAuth. API keys are billed per token.';
  const g = await gateway(t, { fetch: body => page(body.url, text) });
  const f = fixture(t, settings(g.url));
  const turn = f.pending({ action: 'web_fetch', url: 'https://example.org/pricing', purpose: 'billing' });
  const outcome = await f.run(turn);
  const source = outcome.source!;
  assert.equal(source.value.origin.kind, 'web');
  assert.deepEqual(source.value.origin, { kind: 'web', location: 'https://example.org/pricing', requestedUrl: 'https://example.org/pricing',
    finalUrl: 'https://example.org/pricing', fetchedAt: '2026-10-14T00:00:01+00:00', status: 200,
    capture: reference(f.store.get(webCaptureId(reference(turn)))!), extraction: 'crawl4ai/raw_markdown', completeness: 'unknown',
    truncated: { gateway: false, local: false } });
  assert.equal(source.value.content, text); assert.equal(source.value.sha256, digest(text)); assert.equal(source.value.mediaType, 'text/plain');
  const observation = outcome.turn.value.observation as any;
  assert.deepEqual(observation.source, reference(source)); assert.equal(observation.completeness, 'unknown'); assert.equal(observation.length, text.length);
  const evidence = new Evidence(f.store), start = text.indexOf('Subscription'), end = text.indexOf('OAuth.') + 6;
  const reading = evidence.readSource('p', reference(source), { start: 0, end: 200 });
  assert.equal(reading.outcome, 'clipped'); assert.equal(evidence.verifyReading(reading), true);
  const quote = evidence.observe('p', reference(source), { kind: 'text-range', start, end });
  assert.equal(quote.value, 'Subscription login uses OAuth.'); assert.equal(evidence.verify(quote), true);
  assert.throws(() => evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: text.length + 1 }), code('selector_invalid'));
  assert.deepEqual(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used, { attempts: 1, pages: 1, receivedChars: text.length });
  const again = await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/pricing', purpose: 'billing again' }));
  assert.notEqual(again.source!.id, source.id, 'fetching again is a new snapshot');
  assert.deepEqual(f.store.get(source.id), source, 'the cited snapshot is never rewritten');
});

for (const [label, reply, status] of [
  ['404', (url: string) => page(url, 'Not found page', { status: 404 }), 404],
  ['anti-bot', (url: string) => page(url, '', { success: false, failure: 'Blocked by anti-bot protection', status: 200 }), 200],
  ['unresolved host', (url: string) => page(url, '', { success: false, failure: 'unresolved: no such host', status: null, final_url: null }), null],
] as const) test(`WB1-05 a ${label} page is a saved result without a snapshot; the model may choose another URL`, async t => {
  const g = await gateway(t, { fetch: body => reply(body.url) });
  const f = fixture(t, settings(g.url));
  const outcome = await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/missing', purpose: 'p' }));
  const observation = outcome.turn.value.observation as any;
  assert.equal(outcome.turn.value.error, null); assert.equal(outcome.source, null);
  assert.equal(observation.source, null); assert.equal(observation.status, status); assert.ok(observation.failure);
  assert.equal(f.store.list('source').length, 0);
  assert.deepEqual(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used.pages, 0);
});

test('WB1-06 an unavailable gateway pauses the same turn; after recovery the same action completes without a new model call', async t => {
  let down = true;
  const g = await gateway(t, { search: (_b, url) => down ? 'drop' : searchBody(url.searchParams.get('q')!, [hit('https://example.org/a')]) });
  const f = fixture(t, settings(g.url));
  const turn = f.pending({ action: 'web_search', query: 'q', purpose: 'p' });
  await assert.rejects(f.run(turn), (error: unknown) => error instanceof EngineError && error.code === 'web_gateway_unavailable'
    && (error.details as any).turn.id === turn.id);
  assert.equal(f.store.get(turn.id)!.revision, turn.revision, 'the turn stays pending');
  assert.equal(f.store.get(webCaptureId(reference(turn))), null);
  assert.equal(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used.attempts, 1, 'a failed HTTP attempt is counted');
  down = false;
  const outcome = await f.run(turn);
  assert.equal((outcome.turn.value.observation as any).outcome, 'ok');
  assert.equal(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used.attempts, 2);
  await g.close();
  const closed = f.pending({ action: 'web_search', query: 'q2', purpose: 'p' });
  await assert.rejects(f.run(closed), code('web_gateway_unavailable'));
});

test('WB1-07 a capture saved before a crash is applied after restart without HTTP or a second budget charge', async t => {
  const g = await gateway(t, { fetch: body => page(body.url, 'Saved page text') });
  const f = fixture(t, settings(g.url));
  const turn = f.pending({ action: 'web_fetch', url: 'https://example.org/p', purpose: 'p' });
  const write = f.store.writeMany.bind(f.store); let crashed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!crashed && writes.some(w => w.kind === 'source')) { crashed = true; throw Error('crash before application'); }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.run(turn), /crash before application/);
  f.store.writeMany = write;
  assert.ok(f.store.get(webCaptureId(reference(turn)))); assert.equal(f.store.get<ResearchTurn>(turn.id)!.value.status, 'pending');
  const second = new Store(f.path); t.after(() => second.close());
  const outcome = await f.run(second.get<ResearchTurn>(turn.id)!, second);
  assert.equal(outcome.source!.value.content, 'Saved page text');
  assert.equal(g.hits.length, 1, 'no second fetch');
  assert.deepEqual(webBudgetView(second, 'p', 'discovery', settings(g.url)).used, { attempts: 1, pages: 1, receivedChars: 15 });
  const repeat = await f.run(second.get<ResearchTurn>(turn.id)!, second).catch(error => error);
  assert.ok(repeat instanceof EngineError && repeat.code === 'web_turn_invalid', 'a completed turn is not run again');
});

test('WB1-08 a write conflict after the answer keeps the saved capture and fetches nothing again', async t => {
  const g = await gateway(t, { fetch: body => page(body.url, 'Conflict page') });
  const f = fixture(t, settings(g.url));
  const turn = f.pending({ action: 'web_fetch', url: 'https://example.org/c', purpose: 'p' });
  const second = new Store(f.path); t.after(() => second.close());
  const write = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!raced && writes.some(w => w.kind === 'web-capture')) {
      raced = true;
      // Another Store saves this turn's capture first, as a concurrent applier would.
      const capture = { ...writes.find(w => w.kind === 'web-capture') };
      second.writeMany([capture, { ...writes.find(w => w.kind === 'web-budget') }], guards);
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  const outcome = await f.run(turn);
  assert.equal(outcome.source!.value.content, 'Conflict page');
  assert.equal(g.hits.length, 1);
  assert.equal(f.store.list('web-capture').length, 1);
});

test('WB1-09 local and gateway URL refusals are addressed action errors the model can correct', async t => {
  const g = await gateway(t, { fetch: body => ({ status: 403, body: { error: 'url_forbidden', message: `${new URL(body.url).hostname} resolves to a non-public address` } }) });
  const f = fixture(t, settings(g.url));
  for (const [url, expected] of [['http://127.0.0.1:8888/', 'web_url_forbidden'], ['http://[::1]/', 'web_url_forbidden'],
    ['http://10.1.2.3/x', 'web_url_forbidden'], ['http://localhost:6379', 'web_url_forbidden'], ['file:///etc/passwd', 'web_url_invalid'],
    ['http://user:pw@example.org/', 'web_url_invalid'], ['not a url', 'web_url_invalid']] as const) {
    const outcome = await f.run(f.pending({ action: 'web_fetch', url, purpose: 'p' }));
    assert.equal((outcome.turn.value.observation as any).code, expected, url); assert.ok(outcome.turn.value.error, url);
  }
  assert.equal(g.hits.length, 0, 'local refusals spend no HTTP attempt');
  const outcome = await f.run(f.pending({ action: 'web_fetch', url: 'http://rebinding.example/', purpose: 'p' }));
  assert.equal((outcome.turn.value.observation as any).code, 'web_url_forbidden');
  assert.ok(f.store.get(webCaptureId({ id: outcome.turn.id, revision: 1, hash: f.store.get(outcome.turn.id, 1)!.hash })));
  assert.equal(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used.attempts, 1);
  assert.equal(webUrlRefusal('https://example.org/'), null);
});

test('WB1-10 a malformed model action and a project without web research complete as addressed errors', async t => {
  const g = await gateway(t, {});
  const f = fixture(t, settings(g.url));
  for (const action of [{ action: 'web_search', query: 'q' }, { action: 'web_fetch', url: 'https://example.org', purpose: 'p', extra: 1 },
    { action: 'web_search', query: ' ', purpose: 'p' }]) {
    const outcome = await f.run(f.pending(action));
    assert.equal((outcome.turn.value.observation as any).code, 'web_action_invalid');
  }
  assert.throws(() => webAction({ action: 'search', query: 'q' }), code('web_action_invalid'));
  const plain = fixture(t, null, 'old');
  const outcome = await plain.run(plain.pending({ action: 'web_search', query: 'q', purpose: 'p' }));
  assert.equal((outcome.turn.value.observation as any).code, 'web_research_unavailable');
  const disabled = fixture(t, { ...settings(g.url), enabled: false }, 'off');
  assert.equal(((await disabled.run(disabled.pending({ action: 'web_search', query: 'q', purpose: 'p' }))).turn.value.observation as any).code, 'web_research_unavailable');
  assert.equal(g.hits.length, 0);
});

test('WB1-11 the stage budget survives new turns and runs; exhaustion is a resumable pause on the same action', async t => {
  const g = await gateway(t, { search: (_b, url) => searchBody(url.searchParams.get('q')!, [hit('https://example.org/a')]) });
  const limited = settings(g.url, { httpAttempts: 2 });
  const f = fixture(t, limited);
  await f.run(f.pending({ action: 'web_search', query: 'one', purpose: 'p' }));
  await f.run(f.pending({ action: 'web_search', query: 'two', purpose: 'p' }));
  const third = f.pending({ action: 'web_search', query: 'three', purpose: 'p' });
  await assert.rejects(f.run(third), (error: unknown) => error instanceof EngineError && error.code === 'web_research_budget_exhausted'
    && (error.details as any).limit === 'httpAttempts' && (error.details as any).budget.remaining.attempts === 0);
  assert.equal(g.hits.length, 2); assert.equal(f.store.get<ResearchTurn>(third.id)!.value.status, 'pending');
  const raised = new Environments(f.store).configure('p', { ...f.value, webResearch: settings(g.url, { httpAttempts: 3 }) }, f.environment.revision);
  const outcome = await f.run(f.store.get<ResearchTurn>(third.id)!, f.store, raised);
  assert.equal((outcome.turn.value.observation as any).outcome, 'ok');
  assert.deepEqual(webBudgetView(f.store, 'p', 'discovery', raised.value.webResearch!).remaining.attempts, 0);
});

test('WB1-12 a malformed or oversized gateway answer is addressed; an oversized page is a saved result', async t => {
  let mode = 'bad-shape';
  const g = await gateway(t, {
    search: () => mode === 'bad-shape' ? { status: 200, body: { query: 'other', results: [] } } : { status: 200, body: { query: 'q', results: [], engines_queried: [], unresponsive_engines: [], padding: 'x'.repeat(5000) } },
    fetch: body => page(body.url, 'y'.repeat(5000)) });
  const f = fixture(t, settings(g.url, { responseBytes: 1000 }));
  await assert.rejects(f.run(f.pending({ action: 'web_search', query: 'q', purpose: 'p' })), code('web_gateway_response_invalid'));
  mode = 'large';
  await assert.rejects(f.run(f.pending({ action: 'web_search', query: 'q', purpose: 'p' })), code('web_gateway_response_invalid'));
  const outcome = await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/huge', purpose: 'p' }));
  assert.equal(outcome.source, null); assert.match((outcome.turn.value.observation as any).failure, /exceeded 1000 bytes/);
});

test('WB1-13 two genuine foreign results do not close the current operation', async t => {
  const g = await gateway(t, { fetch: body => page(body.url, `Text for ${body.url}`) });
  const other = fixture(t, settings(g.url), 'other');
  const foreign = await other.run(other.pending({ action: 'web_fetch', url: 'https://example.org/same', purpose: 'p' }));
  const f = fixture(t, settings(g.url));
  const first = f.pending({ action: 'web_fetch', url: 'https://example.org/same', purpose: 'p' });
  const sibling = f.pending({ action: 'web_fetch', url: 'https://example.org/same', purpose: 'p' });
  const done = await f.run(sibling);
  const outcome = await f.run(first);
  assert.equal(g.hits.length, 3, 'neither the other project nor a sibling turn answers this turn');
  assert.notEqual(outcome.source!.id, foreign.source!.id); assert.notEqual(outcome.source!.id, done.source!.id);
  assert.equal(outcome.source!.value.projectId, 'p');
});

test('WB1-14 gateway and local truncation are reported separately; completeness stays unknown', async t => {
  const big = 'ж'.repeat(SOURCE_MAX_BYTES / 2 + 10);
  const g = await gateway(t, { fetch: body => page(body.url, body.url.endsWith('local') ? big : 'cut', { truncated: !body.url.endsWith('local') }) });
  const f = fixture(t, settings(g.url, { responseBytes: 64_000_000, receivedChars: 10_000_000 }));
  const gatewayCut = (await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/gateway', purpose: 'p' }))).source!;
  assert.deepEqual((gatewayCut.value.origin as any).truncated, { gateway: true, local: false });
  const local = (await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/local', purpose: 'p' }))).source!;
  assert.deepEqual((local.value.origin as any).truncated, { gateway: false, local: true });
  assert.ok(Buffer.byteLength(local.value.content) <= SOURCE_MAX_BYTES); assert.equal(local.value.sha256, digest(local.value.content));
  assert.equal((local.value.origin as any).completeness, 'unknown');
  assert.equal(new Evidence(f.store).verify(new Evidence(f.store).observe('p', reference(local as Revision<Source>), { kind: 'text-range', start: 0, end: 3 })), true);
});

test('WB1-15 Discovery accepts a web snapshot only as a reported document observation, never as owner intent or a repository fact', async t => {
  const text = 'Vendor docs: third-party tools must use API keys, not consumer subscription logins.';
  const g = await gateway(t, { fetch: body => page(body.url, text) });
  const f = fixture(t, settings(g.url));
  const source = (await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/terms', purpose: 'terms' }))).source!;
  const quote = 'third-party tools must use API keys';
  const start = text.indexOf(quote), observation = new Evidence(f.store).observe('p', reference(source), { kind: 'text-range', start, end: start + quote.length });
  const report = (kind: 'owner-document' | 'document-observation', facts: any[] = []) => ({ applicability: 'applicable' as const, reason: 'r', facts,
    designs: [{ id: 'd', decision: 'Use the API for third-party access', benefit: 'Allowed access', consumer: 'compilation' }], gaps: [],
    documents: [{ id: 'doc', claim: 'Third-party access uses API keys', kind, citation: 0, quote, designs: ['d'], gaps: [] }] });
  const accepted = resolveResearchBasis(f.store, 'p', report('document-observation'), [observation], f.root, 'field');
  assert.deepEqual(accepted.findings, []);
  assert.deepEqual(accepted.bases.find(basis => basis.id === 'doc'), { id: 'doc', kind: 'document-observation', source: reference(source),
    selector: observation.selector, repositoryPath: null, proofLimit: 'reported-not-runtime-proof', quote, designs: ['d'], gaps: [] });
  assert.ok(resolveResearchBasis(f.store, 'p', report('owner-document'), [observation], f.root, 'field').findings
    .some(finding => finding.code === 'document_evidence_required' && finding.target === 'doc'));
  const asFact = { ...report('document-observation'), documents: [], facts: [{ id: 'fact', claim: 'c', evidence: { kind: 'repository-file' as const, citation: 0 } }] };
  assert.ok(resolveResearchBasis(f.store, 'p', asFact, [observation], f.root, 'field').findings
    .some(finding => finding.code === 'repository_evidence_required' && finding.target === 'fact'));
});

test('WB1-16 a gateway timeout or upstream failure is a technical pause on the same pending turn', async t => {
  let mode: 'hang' | '502' = 'hang';
  const g = await gateway(t, { search: () => mode === 'hang' ? 'hang' : { status: 502, body: { error: 'upstream_unavailable', message: 'searxng down' } } });
  const f = fixture(t, { ...settings(g.url), timeoutMs: 1000 });
  const turn = f.pending({ action: 'web_search', query: 'q', purpose: 'p' });
  await assert.rejects(f.run(turn), (error: unknown) => error instanceof EngineError && error.code === 'web_gateway_unavailable'
    && (error.details as any).reason === 'timeout');
  mode = '502';
  await assert.rejects(f.run(turn), (error: unknown) => error instanceof EngineError && error.code === 'web_gateway_unavailable'
    && (error.details as any).status === 502);
  assert.equal(f.store.get<ResearchTurn>(turn.id)!.value.status, 'pending');
  assert.equal(f.store.get(webCaptureId(reference(turn))), null);
  assert.equal(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used.attempts, 2);
});

test('WB1-17 windows: a moved stage counter keeps the received answer; a changed turn refuses without a partial write', async t => {
  const g = await gateway(t, { fetch: body => page(body.url, 'Window page') });
  const f = fixture(t, settings(g.url));
  const second = new Store(f.path); t.after(() => second.close());
  const write = f.store.writeMany.bind(f.store);
  let sibling = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!sibling && writes.some(w => w.kind === 'web-capture')) {
      sibling = true;
      const budget = second.get<any>('web-budget:p:discovery')!;
      second.write({ id: budget.id, kind: budget.kind, expected: budget.revision, value: { ...budget.value, attempts: budget.value.attempts + 1 } });
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  const moved = await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/w1', purpose: 'p' }));
  assert.equal(moved.source!.value.content, 'Window page');
  assert.deepEqual(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used, { attempts: 2, pages: 1, receivedChars: 11 });
  assert.equal(g.hits.length, 1, 'the answer is not fetched again');
  const turn = f.pending({ action: 'web_fetch', url: 'https://example.org/w2', purpose: 'p' });
  let changed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!changed && writes.some(w => w.kind === 'web-capture')) {
      changed = true;
      second.write({ id: turn.id, kind: turn.kind, expected: turn.revision, value: { ...turn.value, status: 'completed', observation: null, error: 'replaced' } });
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.run(turn));
  assert.equal(f.store.get(webCaptureId(reference(turn))), null);
  assert.equal(f.store.list('source').length, 1, 'no snapshot of the refused turn');
  assert.equal(f.store.get<ResearchTurn>(turn.id)!.value.error, 'replaced');
});

const webSearch = { action: 'web_search', query: 'vendor subscription login policy', purpose: 'Which access the vendor permits' };
const ref = { id: 'source:p:x', revision: 1, hash: 'a'.repeat(64) };
const answer = { action: 'answer', question: 'q', value: { result: 'yes' }, citations: [{ source: ref, selector: { kind: 'text-range', start: 0, end: 1 } }] };

test('WB1-18 the shared action contract is unchanged; web is admitted only by the capability of the call', () => {
  assert.throws(() => researchAction(webSearch), code('research_response_invalid'), 'the global parser keeps its era');
  assert.throws(() => responseAction(webSearch, false), code('research_response_invalid'));
  assert.deepEqual(responseAction(webSearch, true), webSearch);
  assert.throws(() => responseAction({ action: 'web_fetch', url: 'https://example.org' }, true),
    (error: unknown) => error instanceof EngineError && error.code === 'research_response_invalid' && (error.details as any).field === 'action');
  assert.deepEqual(responseAction(answer, true), researchAction(answer)); assert.deepEqual(responseAction(answer, false), researchAction(answer));
  assert.deepEqual(admittedResearchAction(webSearch), webSearch); assert.deepEqual(admittedResearchAction(answer), researchAction(answer));
  const on = { webResearch: { enabled: true } }, off = { webResearch: { enabled: false } };
  assert.equal(webResearchCapability('discovery', 'analyst', on), true);
  for (const [stage, role, dispatch] of [['concept', 'analyst', on], ['operation-map', 'analyst', on], ['discovery', 'assessor', on],
    ['discovery', 'escalation-assessor', on], ['discovery', 'reader', on], ['discovery', 'analyst', off], ['discovery', 'analyst', {}],
    ['discovery', 'analyst', null]] as const)
    assert.equal(webResearchCapability(stage, role, dispatch as any), false, `${stage}/${role}`);
});

const earlyDraft = { projectId: 'p', stage: 'discovery', questions: ['q'] } as DiscoveryDraft;
const earlyQuestion = { projectId: 'p', draftId: 'd', stage: 'discovery', level: 'R0', consumer: 'discovery', beforeHash: '0'.repeat(64),
  status: 'open', answer: null, spec: { field: 'result', kind: 'design', prompt: 'Result', risk: 'Missing result',
    schema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } }, additionalProperties: false } } } as unknown as Question;

test('WB1-19 the early classifier and its correction follow the capability; other roles and stages are unchanged', () => {
  assert.equal(earlyResearchFailure(earlyDraft, earlyQuestion, 'analyst', webSearch)?.code, 'research_response_invalid');
  assert.equal(earlyResearchFailure(earlyDraft, earlyQuestion, 'analyst', webSearch, null, true), null);
  assert.equal(earlyResearchFailure(earlyDraft, earlyQuestion, 'assessor', webSearch, null, true)?.code, 'assessment_invalid');
  assert.equal(earlyResearchFailure({ ...earlyDraft, stage: 'om-g2' }, earlyQuestion, 'analyst', webSearch, null, true), null);
  assert.equal(earlyResearchFailure(earlyDraft, earlyQuestion, 'analyst', { action: 'web_fetch', url: 'x' }, null, true)?.code, 'research_response_invalid');
  const failure = new EngineError('research_response_invalid', 'bad');
  const plain = earlyResearchCorrection('analyst', failure, null, earlyQuestion) as any;
  assert.equal(plain.responseContract.instruction, 'Use the selected question ID, a value satisfying its schema and exact source citations. Reader/planner actions are unavailable on this stage.');
  assert.equal(Object.hasOwn(plain.responseContract, 'webActions'), false);
  const web = earlyResearchCorrection('analyst', failure, null, earlyQuestion, true) as any;
  assert.ok(web.responseContract.instruction.startsWith(plain.responseContract.instruction));
  assert.match(web.responseContract.instruction, /web_search \{query, purpose\}/);
  assert.deepEqual(web.responseContract.webActions.map((a: any) => a.action), ['web_search', 'web_fetch']);
  assert.deepEqual(earlyResearchCorrection('assessor', failure, null, earlyQuestion, true), earlyResearchCorrection('assessor', failure, null, earlyQuestion));
});

const OLD_WEB_ADAPTER = `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js', import.meta.url).href)};
import{readFileSync,writeFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,fault=JSON.parse(readFileSync(process.argv[4],'utf8'));
appendFileSync(process.argv[3],JSON.stringify({role:s.role,field:(s.questions?.[0]??s.question)?.field,failures:s.failures??null,web:!!s.webResearch})+'\\n');
const q=s.questions?.[0]??s.question,values=JSON.parse(readFileSync(process.argv[2],'utf8'));
const source=(s.inventory?.sources??s.originals?.sources??[]).find(x=>x.location==='values');
let research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:{action:'answer',question:q.id,value:boundDiscoveryValue(q.field,values[q.field],s.discoveryContext),citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
if(fault.remaining>0&&s.role==='research'&&q.field===fault.field){fault.remaining--;writeFileSync(process.argv[4],JSON.stringify(fault));
 research={action:'web_search',query:'vendor subscription login policy',purpose:'Which access the vendor permits'};}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:null}));`;

test('WB1-20 a genuine web reply refused before web research keeps its refusal after the update and after enabling web', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-wb1-old-'));
  const path = join(root, 'state.sqlite'), store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'adapter.mjs'), OLD_WEB_ADAPTER);
  writeFileSync(join(root, 'fault.json'), JSON.stringify({ field: 'preparation', remaining: 1 }));
  engine.execute({ type: 'create-project', project: 'p', title: 'p' });
  const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
    spec.field === 'mapDesign' ? designOf(enrichedGraph(exampleGraph('p'), 'p')) : preparedField('p', spec.field)])));
  writeFileSync(join(root, 'p.json'), JSON.stringify(fields));
  engine.discovery.evidence.document('p', 'values', JSON.stringify(fields), 'application/json', 0);
  const command = { executable: process.execPath, args: [join(root, 'adapter.mjs'), join(root, 'p.json'), join(root, 'p.calls'), join(root, 'fault.json')] };
  const value = { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 4000 };
  const environment = engine.environments.configure('p', value, 0);
  const draft = engine.prepare('p', 'discovery');
  const first = await engine.stageResearch.run('p', draft.id, 20);
  assert.equal(first.status, 'paused');
  assert.equal((store.get(first.research!.id)!.value as { pauseCode: string }).pauseCode, 'research_response_invalid');
  const refused = store.list<ResearchConsumerIntent>('research-consumer-intent')
    .filter(intent => intent.value.state === 'refused' && intent.value.refusal?.kind === 'consumer-invalid');
  assert.equal(refused.length, 1); const intent = refused[0]!;
  assert.equal(intent.value.refusal!.code, 'research_response_invalid');
  assert.equal(Object.hasOwn(intent.value.dispatch, 'webResearch'), false, 'the refused call had no web capability');
  engine.environments.configure('p', { ...value, webResearch: settings('http://127.0.0.1:9') }, environment.revision);
  for (const view of [store, new Store(path)]) {
    if (view !== store) t.after(() => view.close());
    const read = readResearchConsumerIntent(view, reference(intent));
    assert.deepEqual(read, intent, 'the historical refusal reads unchanged with today\'s web-enabled environment');
    assert.equal(earlyResearchConsumerFailure(view, read)?.code, 'research_response_invalid');
  }
  const calls = () => readFileSync(join(root, 'p.calls'), 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
  const before = calls().length;
  assert.equal(calls().some(call => call.web), false, 'without web research no call was offered web actions');
  const corrected = await engine.stageResearch.run('p', draft.id, 20);
  assert.equal(corrected.status, 'accepted', JSON.stringify(corrected));
  const retry = calls().slice(before).find(call => call.failures?.length)!;
  assert.equal(retry.failures[0].code, 'research_response_invalid', 'the cause follows the failed call');
  assert.deepEqual(retry.failures[0].responseContract.webActions.map((action: any) => action.action), ['web_search', 'web_fetch'],
    'the actions offered follow the new call with web enabled');
  assert.equal(retry.web, true);
});

test('WB1-21 the model catalogue lists a web snapshot as a short orientation; documents keep their excerpt', async t => {
  const long = 'Policy. '.repeat(1000);
  const g = await gateway(t, { fetch: body => page(body.url, long) });
  const f = fixture(t, settings(g.url));
  const document = new Evidence(f.store).document('p', 'brief', long, 'text/plain', 0);
  const snapshot = (await f.run(f.pending({ action: 'web_fetch', url: 'https://example.org/policy', purpose: 'p' }))).source!;
  const rows = new ResearchSources(f.store, 'p', f.root).inventory().sources as any[];
  const web = rows.find(row => row.ref.id === snapshot.id), doc = rows.find(row => row.ref.id === document.id);
  assert.deepEqual({ kind: web.kind, location: web.location, fetchedAt: web.fetchedAt, completeness: web.completeness, excerpt: web.excerpt.length, truncated: web.truncated },
    { kind: 'web', location: 'https://example.org/policy', fetchedAt: '2026-10-14T00:00:01+00:00', completeness: 'unknown', excerpt: 500, truncated: true });
  assert.deepEqual(Object.keys(doc).sort(), ['excerpt', 'kind', 'length', 'location', 'media', 'ref', 'truncated']);
  assert.equal(doc.excerpt.length, 3000);
});

// ---- I6: the Discovery v5 analyst researches the web through the engine (stage command, model stub process). ----
const PAGE = '# Vendor access\nThird-party tools use API keys; consumer subscription login is limited to the vendor client.';
const QUOTE = 'Third-party tools use API keys';
const WEB_ADAPTER = `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js', import.meta.url).href)};
import {readFileSync,appendFileSync,writeFileSync,existsSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject,mode=process.argv[4]||'normal',statePath=process.argv[5];
if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
if(!Array.isArray(c.inventory.sources)){const t=c.inventory.sources;c.inventory.sources=t.rows.map(row=>Object.fromEntries(t.columns.map((column,i)=>[column,row[i]])));}
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{};
const q=c.questions?.[0]??c.question,cur=c.currentRead,kind=cur?.action?.action;
appendFileSync(process.argv[3],JSON.stringify({role:c.role,field:q?.field,web:c.webResearch??null,failures:c.failures??null,currentRead:kind??null,
  currentError:cur?.error??null,currentCode:cur?.observation?.code??null})+'\\n');
let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else {const values=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const value=boundDiscoveryValue(q.field,structuredClone(values[q.field]),c.discoveryContext);
 if(q.field!=='researchReport'){const source=c.inventory.sources.find(s=>s.location==='values');
  research={action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};}
 else if(kind==='web_search'){const hits=cur.observation.results.map(h=>h.url);state.results=hits;writeFileSync(statePath,JSON.stringify(state));
  appendFileSync(process.argv[3],JSON.stringify({picked:hits[0],from:hits})+'\\n');
  research=mode==='bad-url'&&!state.refused?{action:'web_fetch',url:'http://127.0.0.1:8888/',purpose:'policy page'}
   :{action:'web_fetch',url:hits[0],purpose:'Read the policy page found by search'};}
 else if(kind==='web_fetch'&&cur.error){state.refused=true;writeFileSync(statePath,JSON.stringify(state));
  appendFileSync(process.argv[3],JSON.stringify({picked:state.results[0],from:state.results})+'\\n');
  research={action:'web_fetch',url:state.results[0],purpose:'Read the policy page found by search'};}
 else if(kind==='web_fetch')research={action:'read_source',source:cur.observation.source,start:0,end:cur.observation.length};
 else if(kind==='read_source'){const text=cur.observation.value,start=text.indexOf(${JSON.stringify(QUOTE)});
  research={action:'answer',question:q.id,value,citations:[{source:cur.action.source,selector:{kind:'text-range',start,end:start+${QUOTE.length}}}]};}
 else research={action:'web_search',query:'vendor subscription login third-party API key policy',purpose:'Which access the vendor permits'};
}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,usage:null}));`;

async function vendorGateway(t: test.TestContext) {
  const state = { dropFetches: 0 };
  const g = await gateway(t, {
    search: (_b, url) => searchBody(url.searchParams.get('q')!, [hit('https://vendor.example/policy', 'Access policy'), hit('https://other.example/a', 'Other')]),
    fetch: body => state.dropFetches > 0 && state.dropFetches-- > 0 ? 'drop' : page(body.url, PAGE) });
  return { ...g, state };
}

function webStage(t: test.TestContext, gatewayUrl: string | null, mode = 'normal', limits: Partial<WebResearchSettings['limits']> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omg-wb1-i6-'));
  const path = join(root, 'state.sqlite'), store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'adapter.mjs'), WEB_ADAPTER);
  engine.execute({ type: 'create-project', project: 'p', title: 'p' });
  const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
    spec.field === 'mapDesign' ? designOf(enrichedGraph(exampleGraph('p'), 'p')) : preparedField('p', spec.field)])));
  writeFileSync(join(root, 'p.json'), JSON.stringify(fields));
  engine.discovery.evidence.document('p', 'values', JSON.stringify(fields), 'application/json', 0);
  const command = { executable: process.execPath, args: [join(root, 'adapter.mjs'), join(root, 'p.json'), join(root, 'p.calls'), mode, join(root, 'stub-state.json')] };
  const value = { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 8000,
    ...(gatewayUrl ? { webResearch: settings(gatewayUrl, limits) } : {}) };
  const environment = engine.environments.configure('p', value, 0);
  const calls = (): any[] => readFileSync(join(root, 'p.calls'), 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line));
  const reportCalls = () => calls().filter(c => c.role === 'research' && c.field === 'researchReport');
  return { root, path, store, engine, value, environment, calls, reportCalls };
}
const pauseOf = (store: Store, result: StageResearchResult) => (store.get<any>(result.research!.id)!.value).pauseCode;

test('I6-01 Discovery v5 researches the web through the engine: search → delivered URL → fetch → read → cited report → go', async t => {
  const g = await vendorGateway(t), f = webStage(t, g.url);
  const draft = f.engine.prepare('p', 'discovery');
  const result = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(result.status, 'accepted', JSON.stringify({ result, run: result.research && f.store.get(result.research.id)?.value }));
  assert.equal(result.discovery?.state, 'go');
  assert.deepEqual(g.hits.map(h => h.path), ['/search', '/fetch']);
  const picked = f.calls().find(c => c.picked)!;
  assert.ok(picked.from.includes(picked.picked), 'the model chose a URL from the delivered results');
  assert.deepEqual(f.reportCalls().length, 4, 'search, fetch, read and answer: one model call each');
  const first = f.reportCalls()[0];
  assert.match(first.web.instruction, /Search results are navigation/); assert.equal(first.web.budget.remaining.attempts, 20);
  assert.equal(f.reportCalls()[2].web.budget.used.pages, 1);
  const snapshot = f.store.list<Source>('source').find(s => s.value.origin.kind === 'web')!;
  const report = f.store.get<any>(result.discovery!.report!.id)!, assessment = f.store.get<any>(report.value.assessment.id)!;
  assert.deepEqual(assessment.value.observations[0].source, reference(snapshot), 'the accepted report cites the saved web snapshot');
  assert.equal(assessment.value.observations[0].value, QUOTE);
  assert.equal(f.calls().filter(c => c.field === 'researchPlan').every(c => c.role !== 'research' || c.web), true);
  assert.equal(f.calls().filter(c => c.role === 'assess-answer').every(c => c.web === null), true, 'the assessor gets no web capability');
});

test('I6-02 a lost gateway pauses the run on the paid fetch; the same turn completes later without a new model call', async t => {
  const g = await vendorGateway(t), f = webStage(t, g.url);
  g.state.dropFetches = 1;
  const draft = f.engine.prepare('p', 'discovery');
  const first = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(first.status, 'paused'); assert.equal(pauseOf(f.store, first), 'web_gateway_unavailable');
  const pending = f.store.list<ResearchTurn>('research-turn').filter(turn => turn.value.status === 'pending');
  assert.equal(pending.length, 1); assert.equal((pending[0]!.value.action as any).action, 'web_fetch');
  assert.equal(f.reportCalls().length, 2);
  const next = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(next.status, 'accepted', JSON.stringify(next));
  assert.equal(f.reportCalls().length, 4, 'the paid fetch was not requested from the model again');
  assert.equal(f.store.get<ResearchTurn>(pending[0]!.id)!.value.status, 'completed');
  assert.deepEqual(g.hits.map(h => h.path), ['/search', '/fetch', '/fetch']);
  assert.equal(webBudgetView(f.store, 'p', 'discovery', settings(g.url)).used.attempts, 3, 'the lost attempt is counted');
});

test('I6-03 a forbidden URL from the model is an addressed error it corrects with a delivered result', async t => {
  const g = await vendorGateway(t), f = webStage(t, g.url, 'bad-url');
  const draft = f.engine.prepare('p', 'discovery');
  const result = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(result.status, 'accepted', JSON.stringify({ result, run: result.research && f.store.get(result.research.id)?.value }));
  assert.deepEqual(g.hits.map(h => h.path), ['/search', '/fetch'], 'the refused URL spent no HTTP attempt');
  const corrected = f.reportCalls().find(c => c.currentRead === 'web_fetch' && c.currentCode === 'web_url_forbidden');
  assert.ok(corrected, 'the next call carries the addressed refusal');
  assert.notEqual(result.discovery?.state, 'no_go');
});

test('I6-05 the stage allowance pauses resumably and is not reset by a new run', async t => {
  const g = await vendorGateway(t), f = webStage(t, g.url, 'normal', { httpAttempts: 1 });
  const draft = f.engine.prepare('p', 'discovery');
  const first = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(first.status, 'paused'); assert.equal(pauseOf(f.store, first), 'web_research_budget_exhausted');
  assert.deepEqual(g.hits.map(h => h.path), ['/search']);
  const again = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(pauseOf(f.store, again), 'web_research_budget_exhausted', 'a new run does not reset the allowance');
  f.engine.environments.configure('p', { ...f.value, webResearch: settings(g.url, { httpAttempts: 3 }) }, f.store.get('environment:p')!.revision);
  const resumed = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(resumed.status, 'accepted', JSON.stringify(resumed));
  assert.equal(f.reportCalls().length, 4);
  assert.deepEqual(webBudgetView(f.store, 'p', 'discovery', settings(g.url, { httpAttempts: 3 })).used.attempts, 2);
});

test('I6-06 a capture saved before a crash is applied after restart without HTTP or a model call', async t => {
  const g = await vendorGateway(t), f = webStage(t, g.url);
  const draft = f.engine.prepare('p', 'discovery');
  const write = f.store.writeMany.bind(f.store); let crashed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!crashed && writes.some(w => w.kind === 'source' && w.value?.origin?.kind === 'web')) { crashed = true; throw new Error('process lost before applying the page'); }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  const first = await f.engine.stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.ok(crashed); assert.equal(first.status, 'paused');
  f.store.writeMany = write;
  const reopened = new Store(f.path); t.after(() => reopened.close());
  const result = await new ProductEngine(reopened).stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.deepEqual(g.hits.map(h => h.path), ['/search', '/fetch'], 'the saved page is not fetched again');
  assert.equal(f.reportCalls().length, 4);
});

test('I6-07 a paid web reply saved before its turn recovers after restart without another model call', async t => {
  const g = await vendorGateway(t), f = webStage(t, g.url);
  const draft = f.engine.prepare('p', 'discovery');
  const write = f.store.writeMany.bind(f.store); let interrupted = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    const saved = write(writes, guards);
    if (!interrupted && writes.some(w => w.kind === 'model-response') && f.reportCalls().length === 1) {
      interrupted = true; throw new EngineError('input_stale', 'Stop after the saved paid web reply');
    }
    return saved;
  }) as typeof f.store.writeMany;
  await f.engine.stageResearch.run('p', draft.id, 20);
  f.store.writeMany = write;
  assert.ok(interrupted);
  const reopened = new Store(f.path); t.after(() => reopened.close());
  const result = await new ProductEngine(reopened).stageResearch.run('p', draft.id, 20) as StageResearchResult;
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(f.reportCalls().length, 4, 'the paid web_search reply is recovered, not requested again');
  assert.deepEqual(g.hits.map(h => h.path), ['/search', '/fetch']);
});

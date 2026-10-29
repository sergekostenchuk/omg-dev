import { fixtureApplicableAxes } from './discovery-v7-fixture.js';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ProducerPolicySessions, issueProducerPolicyInvitation, setProjectProducerPolicy } from '../src/product/producer-policy-authority.js';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { readVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { canonical } from '../src/canonical.js';
import { readVariantScope } from '../src/discovery/variant-scope.js';

// Include orphaned history as well as current heads after the explicit missing-head corruptions.
function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
      revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id, revision').all() });
  } finally { db.close(); }
}
// A world is built once by the real producers in a root of its own; every test opens its own Stores over it. A cached
// ready world is restored from its byte snapshot before each test (tests of a file run one after another), so no test
// sees another's writes. Saved records name the world's root (workspace, adapter), hence restore in place.
const roots: string[] = [];
process.once('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
type Base = { root: string; path: string; v: ReturnType<typeof acceptPlan>; environment: Revision<any>; command: { executable: string; args: string[] };
  initial: Revision<unknown> | null; questions: PlanQuestion[] };
async function build(questions: PlanQuestion[], initialMode: 'questions'|'bypass'|null): Promise<Base> {
  const f = discoveryFixture({ after: () => {} }, 'omg-deep-cycle-');
  roots.push(f.root);
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')), s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')), q=r.subject.question?.id??'probe';
let prior=[];try{prior=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line))}catch{}
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research=s.actions?.[prior.filter(row=>!row.subject.assessmentSubject&&!row.subject.variantSubject).length]??{action:'answer',question:q,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=q;
if(r.subject.subject?.contract==='v7-plan-subject/v1'&&!r.subject.deepPreparation){
 const at=r.subject.subject,id=at.planQuestionId;
 research={action:'answer',question:id,value:{type:'submitted',contract:'discovery-claims/v7',value:{claims:[{id:'broad-'+prior.length,kind:'hypothesis',text:'Common sweep material '+prior.length,axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:at.planAnswer,planQuestionId:id}],scope:{variants:'common'},basis:{howToVerify:'Measure the common domain'}}]}},citations:[]};
}
if(r.subject.deepPreparation){
 const cell=r.subject.deepCell, id=cell.subject.planQuestionId;
 const claim={id:'deep-'+prior.length,kind:'hypothesis',text:'Exact variant material '+prior.length,axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:cell.subject.planAnswer,planQuestionId:id}],scope:{variants:s.deepMode==='common'?'common':[cell.variant.member]},basis:{howToVerify:'Measure the exact chosen variant'}};
 const claims=s.deepClaims??(s.selectedAxes&&id==='q-two'&&s.deepMode!=='common'?s.applicableAxes.map(axis=>({...claim,id:claim.id+'-'+axis,text:claim.text+' '+axis,axis,basis:{howToVerify:claim.basis.howToVerify+' '+axis}})):[claim]);
 research={action:'answer',question:id,value:s.deepMode==='impossible'?{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'}:{type:'submitted',contract:'discovery-claims/v7',value:{claims}},citations:[]};
}
if(s.deepWeb && r.subject.deepPreparation){
 const c=r.subject, cell=c.deepCell, id=cell.subject.planQuestionId;
 if(c.deepResearchContract!=='deep-research-cycle/v1')throw Error('Missing delivered deep cycle contract');
 const last=c.currentRead??c.history?.at(-1), action=last?.action?.action;
 if(action==='web_search') research={action:'web_fetch',url:last.observation.results[0].url,purpose:'Read the exact search hit'};
 else if(action==='web_fetch') research={action:'read_source',source:last.observation.source,start:0,end:last.observation.length};
 else if(action==='read_source'){
  const pin=c.discoveryClaims.sources.find(pin=>pin.ref.id===last.action.source.id);
  if(!pin)throw Error('No served source pin in the actual request');
  research={action:'answer',question:id,citations:[],value:{type:'submitted',contract:'discovery-claims/v7',value:{claims:[{
   id:'deep-web-fact',kind:'fact',text:'The published report records 42 units',axis:id==='q-one'?'industry':'market',
   planQuestions:[{planAnswer:cell.subject.planAnswer,planQuestionId:id}],scope:{variants:[cell.variant.member]},basis:{source:pin,limit:'One saved fetched report',asOf:'2026-10-29'}
  }]}}};
 }else research={action:'web_search',query:'published report 42 units',purpose:'Find primary material for the selected cell'};
}
if(s.deepAction && r.subject.deepPreparation){
 research={...s.deepAction};
 if(research.question==='$selected')research.question=r.subject.deepCell.subject.planQuestionId;
}
if(r.subject.role==='assess-escalation')research={necessary:true,reason:'The source cannot resolve the exact owner choice'};
if(r.subject.variantSubject?.kind==='decision')research=s.reject?{action:'reject_all',reason:'Model rejects this exact set'}:{action:'choose',key:'v1',reason:'Model chooses the bounded member'};
else if(r.subject.variantSubject){
 const grounds=[r.subject.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];
 research=s.none?{action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds}],searchLimits:['Saved sweep only'],unknowns:['Demand unknown']}
 :{action:'variants',variants:[{key:'v1',title:'Bounded variant',proposal:{bounded:true},criteria:Object.fromEntries(keys.map(key=>[key,{conclusion:'Bounded model proposal',grounds,assumptions:[],unknowns:['Demand unknown'],quantity:null}]))}],scale:Object.fromEntries(keys.map(key=>[key,'Same bounded scale'])),comparison:'One bounded option',recommendation:{key:'v1',reason:'Only bounded candidate'},searchLimits:['Saved sweep only'],unknowns:['Demand unknown']};
}
if(r.subject.role==='reader'){if(s.readerFail)process.exit(42);research={selections:r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]})),unresolved:[]}};
if(r.subject.assessmentSubject){
 const entries=r.subject.assessmentSubject.packet.entries;
 const all=r.subject.value.attempts.flatMap(row=>row.end.type==='submitted'?row.end.value.claims.map((claim,index)=>({accepted:true,claim:{project:r.subject.assessmentSubject.packet.project,container:row.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id}})):[]);
 const accepted=all.filter(c=>c.accepted).map(c=>({claim:c.claim,reason:'Supported exact hypothesis or addressed unknown'}));
 research={verdict:'supported',reasons:['Exact material classification'],return:null,novelty:{attempts:entries.map(e=>({attempt:e.attempt,reason:'Exact attempt'})),accepted,rejected:all.filter(c=>!c.accepted).map(c=>({claim:c.claim,reason:'Counterargument not supported'})),newContent:accepted,duplicates:[],noProgress:entries.filter(e=>!accepted.some(c=>c.claim.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No accepted addition'})),transition:accepted.length&&s.close!==false?{outcome:'closed',bases:accepted.map(c=>({claim:c.claim})),reason:'The exact criterion has enough supported material',sufficiency:{criterion:'Named basis answering '+r.subject.assessmentSubject.packet.planQuestionId,requiredDepth:'deep',reason:'Required depth is met',methodologyRequirements:[]}}:accepted.length&&s.outcome?{outcome:s.outcome,bases:accepted.map(c=>({claim:c.claim})),reason:'Reopened by the applied assessment',...(s.outcome==='unknown'?{consequence:'The deep cell stays missing',nextAction:'Find the named evidence'}:{})}:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
if(s.deepWeb && r.subject.assessmentSubject){
 const rows=r.subject.value.attempts.flatMap(row=>row.end.type==='submitted'?row.end.value.claims.map((value,index)=>({value,claim:{project:'p',container:row.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:value.id}})):[]).filter(row=>row.value.kind==='fact');
 if(rows.length){research.novelty.transition=null;research.methodology.facts=rows.map(({value,claim})=>{
  const pin=value.basis.source, material=r.subject.value.materials.find(item=>item.ref.id===pin.ref.id).value,
   evidence=[{source:pin.ref,selector:{kind:'text-range',start:pin.range.start,end:pin.range.end}}];
  const exact=(value,prefix='')=>{const found=material.content.indexOf(prefix+value),start=found+prefix.length;if(found<0)throw Error('Missing delivered date/version');return [{source:pin.ref,selector:{kind:'text-range',start,end:start+value.length}}]};
  return {claim,significance:{kind:'blocking',reason:'Required evidence for this exact cell'},sources:[{source:pin.ref,role:'primary',reason:'Fetched original report',evidence,original:pin.ref,originalReason:'Original publisher',limitation:'Single report',publicationDate:{status:'known',value:'2026-10-29',evidence:exact('2026-10-29')},eventDate:{status:'unknown',reason:'Only publication is dated'},version:{status:'known',value:'1',evidence:exact('1','Version ')},retrievedAt:material.origin.fetchedAt}],temporalApplicability:{status:'established',scope:'Saved report',reason:'Exact dated bytes',evidence},corroboration:{status:'single_confirmation',reason:'One original report',limitation:'No independent confirmation'},refutation:{status:'not_performed',reason:'Initial evidence pass',traces:[],counterarguments:[],limitations:['Refutation remains']}};
 });}
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):r.subject.deepPreparation?(s.deepTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, 'p', questions);
  configure({applicableAxes:fixtureApplicableAxes(v.draft)});
  function mode(value: 'questions'|'bypass', store = f.store) {
    const request = { project: 'p', mode: value, previous: store.get('project-mode:p') ? reference(store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(store), invitation = issueProjectModeInvitation(store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const initial = initialMode === null ? null : mode(initialMode);
  if (initial) {
    const cal = f.store.write({ id: 'variant-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
    for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
      { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? {snapshot: reference(cal)} : {set: reference(cal)}), mode: reference(initial), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  }
  writeFileSync(wire, '');
  f.store.close();
  return { root: f.root, path: f.path, v, environment, command, initial, questions };
}
function bind(t: { after(fn: () => void): void }, base: Base) {
  const { root, path, v, environment, command, initial, questions } = base, stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); });
  const f = { root, path, store, engine, discovery, open };
  const settings = join(root, 'settings.json'), wire = join(root, 'wire.ndjson');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  function mode(value: 'questions'|'bypass', store = f.store) {
    const request = { project: 'p', mode: value, previous: store.get('project-mode:p') ? reference(store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(store), invitation = issueProjectModeInvitation(store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const generationCalls = () => wires().filter(row => row.subject.variantSubject);
  const nextEdition = (store = f.store) => {
    const discovery = new Discovery(store), engine = new ProductEngine(store);
    const plan = store.get<Question>(v.plan.id)!; discovery.reopen(plan.id, plan.revision);
    const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(v.draft.id)!;
    const source = discovery.evidence.document('p', 'edition-two', 'New accepted edition', 'text/plain', 0);
    answerDiscoveryFixture(engine, 'p', draft, question, validPlan(v.frameRef, questions, 2, v.planAnswer), source);
    return store.get<Question>(plan.id)!.value.answer!;
  };
  return { ...f, v, environment, command, run, wires, generationCalls, configure, mode, initial, nextEdition };
}
async function setup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')], initialMode: 'questions'|'bypass'|null = 'questions') {
  return bind(t, await build(questions, initialMode));
}
const WORLD_FILES = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'settings.json', 'wire.ndjson'];
const money = (store: Store) => store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind)).flatMap(row => store.history(row.id));
function choiceScope(f: Awaited<ReturnType<typeof setup>>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
  const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  const set = f.store.get<VariantSet>(state.value.set!.id, state.value.set!.revision)!;
  return { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set),
    mode: reference(f.store.get('project-mode:p')!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: kind === 'choose' ? { kind, member: set.value.members[0]!, reason: 'Authorized owner chooses the member' }
      : { kind, reason: 'Authorized owner rejects the exact set' } };
}
function owner(store: Store, scope: VariantChoiceScope) {
  const sessions = new VariantChoiceSessions(store), issued = issueVariantChoiceInvitation(store, scope);
  assert.ok(issued.ok); if (!issued.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
  assert.ok(login.ok); if (!login.ok) assert.fail('Expected successful owner exchange');
  const act = answerVariantChoice(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok); return act;
}

const readyWorlds = new Map<string, { base: Base; snapshot: string; data: { scope: any; pending: any } }>();
/** The real generation, choice and pending deep frontier is produced once per (model, config); each later test starts
 * from its exact bytes in its own Stores. */
async function ready(t:test.TestContext,model=false,config:Record<string,unknown>={}) {
  const key=JSON.stringify([model,config]);let cached=readyWorlds.get(key);
  if(!cached){
    const closing:(()=>void)[]=[], base=await build([planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')],model?'bypass':'questions');
    const made=await readyIn(bind({after:fn=>closing.push(fn)},base),model,config);
    for(const close of closing)close();
    const snapshot=mkdtempSync(join(tmpdir(),'omg-56-snap-'));roots.push(snapshot);
    for(const file of WORLD_FILES)if(existsSync(join(base.root,file)))copyFileSync(join(base.root,file),join(snapshot,file));
    cached={base,snapshot,data:structuredClone({scope:made.scope,pending:made.pending})};readyWorlds.set(key,cached);
  }
  for(const file of WORLD_FILES){rmSync(join(cached.base.root,file),{force:true});
    if(existsSync(join(cached.snapshot,file)))copyFileSync(join(cached.snapshot,file),join(cached.base.root,file));}
  return {...bind(t,cached.base),...structuredClone(cached.data)};
}
async function readyIn(f:ReturnType<typeof bind>,model:boolean,config:Record<string,unknown>) {
  const generated=await f.run(3);
  assert.equal(generated.value.pauseCode,model?'research_turns_exhausted':'research_variant_owner_required',generated.value.error!);
  f.configure(config);
  if(model)await f.run(1);else owner(f.store,choiceScope(f));
  const pending=await f.run(1,f.store,true), details=JSON.parse(pending.value.error!);
  assert.equal(pending.value.pauseCode,'research_deep_frontier_pending',pending.value.error!);
  const handoff=(await readVariantHandoff(f.store,'p',details.handoff)).record;
  assert.equal(handoff.value.next,'deep');assert.deepEqual(handoff.value.scope,details.scope);
  assert.deepEqual(reference(readVariantScope(f.store,'p',details.scope).scope),details.scope);
  return {...f,scope:details.scope,pending};
}

export { history as deepCycleHistory, money as deepCycleMoney };
export async function deepCycleWorld(t: test.TestContext) {
  const f = await ready(t, false, { deepWeb: true });
  const hits: string[] = [];
  const text = 'Published 2026-10-29. Version 1. The original report records 42 units.';
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const server = createServer((request, response) => {
    let body = ''; request.on('data', part => body += part); request.on('end', () => {
      const url = new URL(request.url!, 'http://gateway'); hits.push(url.pathname);
      const page = 'https://publisher.example/report';
      const result = url.pathname === '/search'
        ? { query: url.searchParams.get('q'), results: [{ url: page, title: 'Original report', snippet: 'Measured units', score: 1, engines: ['fixture'] }], engines_queried: ['fixture'], unresponsive_engines: [], elapsed_ms: 1 }
        : { contract: 'web-document/v2', requested_url: JSON.parse(body).url, selected_url: page, final_url: page,
          redirects: [], fetched_at: '2026-10-29T00:00:00+00:00', status: 200, success: true, failure: null,
          raw: { encoding: 'base64', data: Buffer.from(text).toString('base64'), mediaType: 'text/markdown', byteLength: Buffer.byteLength(text), sha256: digest(text) },
          clean: { text, mediaType: 'text/markdown', utf16Length: text.length, sha256: digest(text) },
          method: { kind: 'native-markdown', version: 'fixture/v1' }, signals: { rawTruncated: false, cleanTruncated: false, completeness: 'unknown' }, attempts: [] };
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const current = f.engine.environments.get('p');
  f.engine.environments.configure('p', { ...current.value, webResearch: { enabled: true, gatewayUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000,
    limits: { httpAttempts: 10, pages: 5, receivedChars: 1000000, responseBytes: 2000000 } } }, current.revision);
  const policy = { project: 'p', discovery: 7 as const, previous: null }, sessions = new ProducerPolicySessions(f.store);
  const login = sessions.exchange(issueProducerPolicyInvitation(f.store, policy));
  setProjectProducerPolicy(f.store, policy, login.authority); sessions.revoke(login.bearer);
  const reviseScope = (store: Store) => {
    const old = readVariantScope(store, 'p', f.scope);
    return owner(store, { ...choiceScope({ ...f, store }), operation: 'revise', previous: old.scope.value.decision });
  };
  return { ...f, hits, page: text, reviseScope };
}

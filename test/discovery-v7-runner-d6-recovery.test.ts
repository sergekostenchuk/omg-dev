import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineError } from '../src/errors.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { readRunnerDossierInput, readRunnerDossierAssessmentAt, runRunnerDossierAssessment } from '../src/discovery/dossier-assessment-runner.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { canonical, hashJson } from '../src/canonical.js';
import { readDossierReservationAt, runDossierAssessmentSession } from '../src/discovery/assessment-session.js';
import { configureReaderPilot, readerPilot } from '../src/discovery/reader-pilot.js';
import { admitRunControl, acquireRunExecution, stopRun } from '../src/om/run-control.js';
import { resumeDossierResearchCall, withResearchRunControl } from '../src/discovery/research-protocol.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { completed, unchanged, fixedPoint, revise } from './discovery-v7-dossier-seed.js';

async function world(t: test.TestContext) {
  const f = await completed(t, 'owner');
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', reference(produceSelectedDossier(f.store, 'p', f.input).record));
  const bases = [{ record: packet.manifest.ref }], role = f.environment.value.reviewer;
  const terminal: DossierAssessmentResult = { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: packet.subject,
    verdict: 'supported', reasons: ['Exact saved packet'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(key => [key,
      { judgement: 'adequate', reason: key, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(row => row.address), unknowns: packet.unknowns.map(row => row.unknown.claim),
      contradictions: packet.contradictions.map(row => ({ id: row.contradiction.id,
        sides: [row.sides[0].address, row.sides[1].address], grounds: row.grounds.map(item => item.ref) })) }, return: null };
  configureReaderPilot(f.store, f.engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'dossier-reader', model: role.model, effort: role.effort, command: role.command, speed: 'inherited' },
    agentCommand: role.command, maxRequestChars: 3000000, maxReadChars: 128000, maxReplyChars: 100000,
    maxCalls: 100, maxReportedTokens: 100000,
    physicalLimits: { maxRequestChars: 3000000, maxReplyChars: 100000, basis: 'Full local dossier delivery' } }, 0);
  f.reply(terminal);
  const run = (store = f.store, restoreOnly = false, limit = 8) => {
    const engine = new ProductEngine(store);
    return new Researcher(store, engine.discovery, engine.environments).run('p', f.v.draft.id, limit, undefined,
      { producerPolicy: { discovery: 7 }, restoreOnly });
  };
  return { ...f, packet, terminal, run };
}
function intercept(t: test.TestContext, target: Store, match: (writes: Write[]) => boolean) {
  let cut = false;
  const original = Store.prototype.writeMany;
  const hook = t.mock.method(Store.prototype, 'writeMany', function<T>(this: Store, writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (this === target && !cut && match(writes)) { cut = true; throw new Error('D6 runner cut'); }
    return original.call(this, writes, guards) as Revision<T>[];
  });

  return () => { hook.mock.restore(); assert.ok(cut, 'the named physical boundary was executed'); };
}
for (const boundary of ['before-reservation', 'after-response', 'after-publication'] as const)
  test(`D6 runner ${boundary}: exact cut recovery, two Stores and free paid repeats`, async t => {
    const f = await world(t);
    const restore = intercept(t, f.store, writes => writes.some(row => {
      const value = row.value as any;
      return boundary === 'before-reservation' ? row.kind === 'model-call' && value.purpose === 'dossier-assessor'
        : boundary === 'after-response' ? row.kind === 'assessment-application' && value.contract === 'dossier-application/v1' && value.state === 'applied'
        : row.kind === 'research-run' && value.dossierAssessment !== undefined;
    }));
    await assert.rejects(() => f.run(), /D6 runner cut/); restore();
    if (boundary === 'before-reservation') {
      await fixedPoint(f, f.store, async () => { await unchanged(f, f.store, () => f.run(f.store, true)); });
    }
    const calls = f.store.list('model-call').length, wires = f.wires().length;
    if (boundary === 'after-response') {
      revise(f, f.open());
      const old = f.engine.environments.get('p'), { projectId: _project, ...settings } = old.value;
      f.engine.environments.configure('p', settings, old.revision);
    }
    if (boundary === 'after-publication') revise(f);
    const recovered = await f.run(f.open(), boundary !== 'before-reservation');
    assert.equal(recovered.value.pauseCode, 'research_dossier_ready', recovered.value.error!);
    if (boundary !== 'before-reservation') {
      assert.equal(f.store.list('model-call').length, calls); assert.equal(f.wires().length, wires);
    }
    for (const store of [f.store, f.open()]) await fixedPoint(f, store, async () => {
      assert.deepEqual(await unchanged(f, store, () => f.run(store, true)), recovered);
      await unchanged(f, store, () => readRunnerDossierAssessmentAt(store, 'p', reference(recovered)));
    });
  });

test('D6 checkpoint pages use the invocation allowance; restoreOnly cannot buy the next page', async t => {
  const f = await world(t);
  f.reply({ action: 'assessment_checkpoint', dossierSubject: f.packet.subject, notes: ['Retain the exact dossier'] });
  const before = f.wires().length;
  await assert.rejects(() => f.run(f.store, false, 1), { code: 'research_call_allowance' });
  assert.equal(f.wires().length, before + 1);
  await fixedPoint(f, f.store, async () => { await unchanged(f, f.store, () => f.run(f.store, true, 1)); });
  f.reply(f.terminal);
  const run = await f.run(f.open(), false, 1);
  assert.equal(run.value.pauseCode, 'research_dossier_ready', run.value.error!);
  assert.equal(f.wires().length, before + 2);
  const proof = await readRunnerDossierAssessmentAt(f.store, 'p', reference(run));
  const session = f.store.get<any>(proof.assessment.value.session.id, 1)!;
  const application = f.store.get<any>(session.value.application, 2)!;
  const first = f.store.get<ModelCall>(application.value.call.id)!;
  const missing = first.value.request.record!;
  assert.ok(missing); assert.notDeepEqual(missing, proof.assessment.value.request);
  const path = join(f.root, 'lost-early-page.sqlite'), snapshot = new DatabaseSync(f.path);
  try { snapshot.prepare('VACUUM INTO ?').run(path); } finally { snapshot.close(); }
  const hot = new Store(path); t.after(() => hot.close());
  await readRunnerDossierAssessmentAt(hot, 'p', reference(run));
  const fault = new DatabaseSync(path);
  try {
    const triggers = fault.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('revisions_no_delete','revisions_no_update')")
      .all().map(row => String(row['sql']));
    assert.equal(triggers.length, 2);
    fault.exec('PRAGMA foreign_keys=OFF; BEGIN; DROP TRIGGER revisions_no_delete; DROP TRIGGER revisions_no_update');
    fault.prepare('DELETE FROM heads WHERE entity_id=? AND revision=?').run(missing.id, missing.revision);
    fault.prepare('DELETE FROM revisions WHERE entity_id=? AND revision=?').run(missing.id, missing.revision);
    for (const sql of triggers) fault.exec(sql);
    fault.exec('COMMIT');
  } finally { fault.close(); }
  const cold = new Store(path); t.after(() => cold.close());
  for (const store of [hot, cold]) await fixedPoint(f, store, async () => {
    await unchanged(f, store, () => readRunnerDossierAssessmentAt(store, 'p', reference(run)), true);
    await unchanged(f, store, () => f.run(store, true), true);
  });
});

for (const control of ['stop', 'lost-hold'] as const) test(`D6 ${control} before reservation refuses without another call or diagnostic write`, async t => {
  const f = await world(t);
  const restore = intercept(t, f.store, writes => writes.some(row => row.kind === 'model-call' && (row.value as any).purpose === 'dossier-assessor'));
  await assert.rejects(() => f.run(), /D6 runner cut/); restore();
  const hold = admitRunControl(f.store, 'p').hold;
  const changed = control === 'stop' ? stopRun(f.store, { project: 'p' }) : acquireRunExecution(f.store, { project: 'p' });
  assert.ok(changed.ok);
  await fixedPoint(f, f.store, async () => {
    await unchanged(f, f.store, () => withResearchRunControl(f.store, 'p', hold, () => f.run()), true);
    await unchanged(f, f.store, () => f.run(f.store, true));
  });
});

test('an authorized uncertain D6 provider is never launched a second time', async t => {
  const f = await world(t), original = Store.prototype.writeMany;
  let cut = false;
  const hook = t.mock.method(Store.prototype, 'writeMany', function<T>(this: Store, writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const hit = this === f.store && !cut && writes.some(row => row.kind === 'model-call' && (row.value as any).execution?.phase === 'authorized');
    const rows = original.call(this, writes, guards) as Revision<T>[];
    if (hit) { cut = true; throw new Error('authorized cut'); }
    return rows;
  });
  await assert.rejects(() => f.run(), { code: 'process_record_failed' }); hook.mock.restore(); assert.ok(cut);
  for (const store of [f.store, f.open()]) await fixedPoint(f, store, async () => {
    await unchanged(f, store, () => f.run(store), true);
    await unchanged(f, store, () => f.run(store, true));
  });
});

test('a competing run successor wins CAS; paid D6 cannot be attached to a moved origin', async t => {
  const f = await world(t), competitor = f.open(), original = Store.prototype.writeMany;
  let changed: Revision<ResearchRun> | null = null;
  const hook = t.mock.method(Store.prototype, 'writeMany', function<T>(this: Store, writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    const result = writes.find(row => row.kind === 'research-run' && (row.value as any).dossierAssessment);
    if (this === f.store && result && !changed) {
      const before = competitor.get<ResearchRun>(result.id)!;
      changed = original.call(competitor, [{ id: before.id, kind: before.kind, expected: before.revision,
        value: { ...before.value, pauseCode: 'competing-owner-pause', error: 'A separate run successor owns this position' } }])[0] as Revision<ResearchRun>;
    }
    return original.call(this, writes, guards) as Revision<T>[];
  });
  await assert.rejects(() => f.run(), error => ['input_stale', 'revision_conflict'].includes((error as any).code));
  hook.mock.restore();
  const winner = changed as Revision<ResearchRun> | null; assert.ok(winner);
  assert.deepEqual(competitor.get(winner.id), winner);
  assert.equal(Object.hasOwn(winner.value, 'dossierAssessment'), false);
  assert.equal(competitor.list('discovery-dossier-assessment').length, 1);
  await unchanged(f, competitor, () => readRunnerDossierAssessmentAt(competitor, 'p', reference(winner)), true);
});

for (const change of ['choice', 'environment'] as const) test(`a later ${change} before an unpaid D6 send refuses hot/cold while restoreOnly stays free`, async t => {
  const f = await world(t);
  const restore = intercept(t, f.store, writes => writes.some(row => row.kind === 'model-call' && (row.value as any).purpose === 'dossier-assessor'));
  await assert.rejects(() => f.run(), /D6 runner cut/); restore();
  if (change === 'choice') revise(f);
  else {
    const old = f.engine.environments.get('p'), { projectId: _project, ...settings } = old.value;
    f.engine.environments.configure('p', settings, old.revision);
  }
  for (const store of [f.store, f.open()]) await fixedPoint(f, store, async () => {
    await unchanged(f, store, () => f.run(store), true);
    await unchanged(f, store, () => f.run(store, true));
  });
});

for (const change of ['choice', 'run'] as const) for (const boundary of ['reservation', 'authorization'] as const)
  test(`D6 ${change} successor at ${boundary}: second Store closes the new-send CAS window`, async t => {
    const f = await world(t), competitor = f.open(), original = Store.prototype.writeMany;
    let changed = false;
    const hook = t.mock.method(Store.prototype, 'writeMany', function<T>(this: Store, writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
      const hit = this === f.store && !changed && writes.some(row => row.kind === 'model-call'
        && (row.value as any).purpose === 'dossier-assessor'
        && (boundary === 'reservation' ? row.expected === 0 : (row.value as any).execution?.phase === 'authorized'));
      if (hit) {
        changed = true;
        if (change === 'choice') revise(f, competitor);
        else {
          const old = competitor.get<ResearchRun>(`research-run:${hashJson(['p',f.v.draft.id])}`)!;
          assert.ok(old,'the second Store must move the ordinary runner, not a seed helper run');
          original.call(competitor, [{id:old.id,kind:old.kind,expected:old.revision,
            value:{...old.value,limit:old.value.limit+1}}]);
        }
      }
      return original.call(this, writes, guards) as Revision<T>[];
    });
    const wires = f.wires().length;
    await assert.rejects(() => f.run()); hook.mock.restore(); assert.ok(changed);
    assert.equal(f.wires().length, wires);
    if (boundary === 'reservation') assert.equal(f.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'dossier-assessor').length,0);
  });

test('prepared and claimed D6 retain new runner guards when a direct retry omits options', async t => {
  const f = await world(t), original = Store.prototype.writeMany;
  // A legitimate prepared application predates reservation. The next runner
  // call must retain its own current witnesses in the saved running transition.
  let cut = false;
  // First prepare through the standalone API, without runner options. Its
  // immutable application must not be rewritten when the runner later binds it.
  await f.run(f.store,true);
  const unprepare=intercept(t,f.store,writes=>writes.some(row=>row.kind==='model-call' && (row.value as any).purpose==='dossier-assessor'));
  await assert.rejects(()=>runDossierAssessmentSession(f.store,'p',f.packet.subject,f.environment,readerPilot(f.store,'p')??undefined),/D6 runner cut/);
  unprepare();
  const prepared=f.store.list<any>('assessment-application').find(row=>row.value.contract==='dossier-application/v1')!;
  assert.equal(prepared.revision,1);assert.equal(prepared.value.dispatchGuards,undefined);
  // Reinstall only the exact claim cut, then prove the immutable origin remains.
  const claimHook=t.mock.method(Store.prototype,'writeMany',function<T>(this:Store,writes:Write[],guards:TransactionGuard[]=[]):Revision<T>[] {
    const claim=this===f.store && !cut && writes.some(row=>row.kind==='model-call' && (row.value as any).purpose==='dossier-assessor' && row.expected===0);
    const rows=original.call(this,writes,guards) as Revision<T>[];
    if(claim){cut=true;throw new Error('claimed before dispatch');}return rows;
  });
  const wires=f.wires().length;
  await assert.rejects(() => f.run(), /claimed before dispatch/);claimHook.mock.restore();
  assert.deepEqual(f.store.get(prepared.id,1),prepared);assert.ok(cut);
  const app=f.store.list<any>('assessment-application').find(row=>row.value.contract==='dossier-application/v1')!;
  assert.equal(app.value.state,'running');assert.ok(app.value.dispatchGuards.length>0);
  revise(f,f.open());
  // Direct claimed resume has no caller options; the saved guards still bind it.
  await fixedPoint(f,f.store,async()=>{await unchanged(f,f.store,()=>resumeDossierResearchCall(f.store,reference(f.store.get(app.id,1)!)),true);});
  assert.equal(f.wires().length,wires);
});

test('paid D6 requires its own exact claim and a typed running form even under rehashed storage damage', async t => {
  const f=await world(t),run=await f.run();
  const proof=await readRunnerDossierAssessmentAt(f.store,'p',reference(run));
  const at=proof.assessment.value.application,prepared=f.store.get<any>(at.id,1)!,running=f.store.get<any>(at.id,2)!;
  const foreign=f.store.list<ModelCall>('model-call').find(row=>row.id!==running.value.call.id)!;
  for(const [index,value] of [null,'running',[],{...running.value,extra:true},{...running.value,call:reference(foreign)}].entries()) {
    const path=join(f.root,`damaged-running-${index}.sqlite`),snapshot=new DatabaseSync(f.path);
    try{snapshot.prepare('VACUUM INTO ?').run(path);}finally{snapshot.close();}
    const fault=new DatabaseSync(path);
    try {
      const trigger=String(fault.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='revisions_no_update'").get()!['sql']);
      fault.exec('BEGIN; DROP TRIGGER revisions_no_update');
      fault.prepare('UPDATE revisions SET body=?,sha256=? WHERE entity_id=? AND revision=2')
        .run(canonical(value),hashJson(value),running.id);
      fault.exec(trigger);fault.exec('COMMIT');
    }finally{fault.close();}
    const store=new Store(path);t.after(()=>store.close());
    await fixedPoint(f,store,async()=>{
      if(index<4) await unchanged(f,store,()=>Promise.resolve().then(()=>readDossierReservationAt(store,reference(prepared))),true);
      await unchanged(f,store,()=>readRunnerDossierAssessmentAt(store,'p',reference(run)),true);
      await unchanged(f,store,()=>f.run(store,true),true);
    });
  }
});

test('runner witnesses added after a standalone paid page survive a later optionless continuation', async t => {
  const f=await world(t);await f.run(f.store,true);
  f.reply({action:'assessment_checkpoint',dossierSubject:f.packet.subject,notes:['Exact previous page']});
  await assert.rejects(()=>runDossierAssessmentSession(f.store,'p',f.packet.subject,f.environment,readerPilot(f.store,'p')??undefined,
    undefined,{allowance:1}),{code:'research_call_allowance'});
  await assert.rejects(()=>f.run(f.store,false,1),{code:'research_call_allowance'});
  assert.equal(f.store.list<ModelCall>('model-call').filter(row=>row.value.purpose==='dossier-assessor').length,2);
  revise(f,f.open());
  for(const store of [f.store,f.open()]) await fixedPoint(f,store,async()=>{
    await unchanged(f,store,()=>runDossierAssessmentSession(store,'p',f.packet.subject,undefined,undefined,undefined,{allowance:1}),true);
    await unchanged(f,store,()=>f.run(store,true));
  });
});


test('D6 public doors reject hash-consistent non-record run values with one typed result refusal', async t => {
  const f=await world(t),origin=await f.run(f.store,true);
  for(const value of [null,[], 'broken run',7,true,{}, {projectId:'p'}, {projectId:'p',draftId:null}]) {
    const head=f.store.get(origin.id)!;
    const damaged=f.store.write({id:head.id,kind:head.kind,expected:head.revision,value});
    for(const store of [f.store,f.open()]) await fixedPoint(f,store,async()=>{
      for(const door of [
        ()=>readRunnerDossierInput(store,'p',reference(damaged)),
        ()=>readRunnerDossierAssessmentAt(store,'p',reference(damaged)),
        ()=>runRunnerDossierAssessment(store,'p',reference(damaged),{restoreOnly:true,allowance:0}),
      ]) await unchanged(f,store,async()=>{
        await assert.rejects(door,error=>error instanceof EngineError && error.code==='research_dossier_result_invalid');
      });
    });
  }
});

test('D6 session inventory rejects non-record saved values instead of treating the damaged session as absent', async t => {
  const f=await world(t),origin=await f.run(f.store,true);
  assert.equal(origin.value.pauseCode,'research_selected_dossier_assessment_unavailable');
  for(const value of [null,[], 'broken session',7,true]) {
    const id='damaged-d6-session',head=f.store.get(id);
    f.store.write({id,kind:'assessment-session',expected:head?.revision??0,value});
    for(const store of [f.store,f.open()]) await fixedPoint(f,store,async()=>{
      await unchanged(f,store,async()=>{
        await assert.rejects(()=>runRunnerDossierAssessment(store,'p',reference(origin),{restoreOnly:true,allowance:0}),
          error=>error instanceof EngineError && error.code==='research_dossier_result_invalid');
      });
    });
  }
});

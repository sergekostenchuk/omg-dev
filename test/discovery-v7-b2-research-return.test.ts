import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixtureApplicableAxes, researchSetup } from './discovery-v7-fixture.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { completed, addresses, money, revise, claim, deep, assess, modeOf } from './discovery-v7-dossier-seed.js';
import { returnDiscoveryResearch, readResearchReturnAt, type ResearchReturnInput } from '../src/discovery/discovery-research-return.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { computeMissingCoverage } from '../src/discovery/coverage.js';
import { readCurrentVariantChoice, readCurrentVariantScope } from '../src/discovery/variant-scope.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareVariantSession, runVariantSession } from '../src/discovery/variant-session.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { VARIANT_SUBJECT_CONTRACT } from '../src/discovery/discovery-variants.js';
import { variantStateId } from '../src/discovery/variant-decision.js';

function input(f: Awaited<ReturnType<typeof completed>>, destination: 'D4'|'D5'): ResearchReturnInput {
  return { project: 'p', scope: reference(f.scopeRecord), plan: f.v.planAnswer, question: 'q-market', axis: 'market',
    grounds: addresses(f.entries.market), destination, final: null,
    reason: 'The accepted evidence requires reconsideration', requiredResult: 'Resolve this exact market question' };
}
const supported = { verdict: 'supported', reasons: ['The full exact evidence proves the proposed return'] };
async function refutation(f: Awaited<ReturnType<typeof completed>>) {
  const counterexample = claim(f,'q-market','market','Observed market capacity excludes the scope required by the selected first variant') as any;
  counterexample.contradicts = addresses(f.entries.market);
  const entry = await deep(f,'q-market',[counterexample]);
  await assess(f,entry,'open');
  return {...input(f,'D4'), grounds:addresses(entry)};
}

/** A real public-runner prefix: checkpoint cursors must retain the same managed run during D5 re-entry. */
async function runnerWorld(t: test.TestContext) {
  const f = await researchSetup(t,{adapter:'reply',prefix:'omg-b2-runner-'});
  f.engine.execute({type:'create-project',project:'p',title:'Addressed research return'});
  const mode=modeOf(f.store,'bypass'), adapter=f.environment.value.implementer.command.args[0]!;
  const original=readFileSync(adapter,'utf8');
  const response=`(()=>{
    const s=r.subject, at=s.deepCell?.subject??s.subject, id=at?.planQuestionId;
    if(s.assessmentSubject){
      const packet=s.assessmentSubject.packet, entries=packet.entries;
      const accepted=s.value.attempts.flatMap(row=>row.end.type==='submitted'?row.end.value.claims.map((c,i)=>({claim:{project:'p',container:row.attempt,containerKind:'research-attempt',pointer:'/claims/'+i,claimId:c.id},reason:'Measured exact material'})):[]);
      return {verdict:'supported',reasons:['Exact material classification'],return:null,novelty:{attempts:entries.map(e=>({attempt:e.attempt,reason:'Real managed attempt'})),accepted,rejected:[],newContent:accepted,duplicates:[],noProgress:accepted.length?[]:entries.map(e=>({attempt:e.attempt,reason:'No accessible source'})),transition:accepted.length?{outcome:'closed',bases:accepted.map(c=>({claim:c.claim})),reason:'Criterion satisfied',sufficiency:{criterion:'Named basis answering '+packet.planQuestionId,requiredDepth:'deep',reason:'Enough addressed evidence',methodologyRequirements:[]}}:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
    }
    if(settings.reply)return settings.reply;
    if(s.variantSubject?.kind==='decision')return {action:'choose',key:'v1',reason:'Initial viable member'};
    if(s.variantSubject){const grounds=[s.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];return {action:'variants',variants:[1,2].map(i=>({key:'v'+i,title:'Variant '+i,proposal:{bounded:true},criteria:Object.fromEntries(keys.map(k=>[k,{conclusion:'Bounded',grounds,assumptions:[],unknowns:['Demand'],quantity:null}]))})),scale:Object.fromEntries(keys.map(k=>[k,'Same bounded scale'])),comparison:'Two alternatives',recommendation:{key:'v1',reason:'Initial candidate'},searchLimits:['Saved sweep'],unknowns:['Demand']};}
    if(at?.contract==='v7-plan-subject/v1')return {action:'answer',question:id,value:{type:'submitted',contract:'discovery-claims/v7',value:{claims:(s.deepCell&&id==='q-industry'?${JSON.stringify(fixtureApplicableAxes(f.v.draft))}:[id==='q-market'?'market':'industry']).map(axis=>({id:'basis-'+id+'-'+axis+'-'+(s.deepCell?'deep':'common'),kind:'hypothesis',text:'Observed '+id+' '+axis,axis,planQuestions:[{planAnswer:at.planAnswer,planQuestionId:id}],scope:{variants:s.deepCell?[s.deepCell.variant.member]:'common'},basis:{howToVerify:'Measure exact evidence '+axis}}))}},citations:[]};
    return {action:'answer',question:s.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
  })()`;
  assert.ok(original.includes('const research='));
  writeFileSync(adapter,original.replace(/const research=.*;\nconsole\.log/s,'const research='+response+';\nconsole.log'));
  const calibration=f.store.write({id:'transport-fixture:b2-runner',kind:'transport-fixture',expected:0,value:{projectId:'p'}});
  for(const kind of ['proposal','decision'] as const)
    await researchCall(f.environment.value.implementer,f.environment.value,'Calibrate variant step',
      {variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,kind,...(kind==='proposal'?{snapshot:reference(calibration)}:{set:reference(calibration)}),mode:reference(mode),expectedSelection:null},history:[]},undefined,
      {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:`variant-${kind}`});
  let scopeRecord:ReturnType<typeof readCurrentVariantScope>['scope']|undefined;
  for(let i=0;i<8;i++){
    await f.engine.researcher.run('p',f.v.draft.id,1,undefined,{producerPolicy:{discovery:7}});
    if(f.store.list('discovery-variant-scope').length){
      scopeRecord=readCurrentVariantScope(f.store,'p',reference(f.v.draft)).scope;
      if(computeMissingCoverage(f.store,'p',reference(scopeRecord),f.v.planAnswer).missing.length===0)break;
    }
  }
  assert.ok(scopeRecord);assert.equal(computeMissingCoverage(f.store,'p',reference(scopeRecord),f.v.planAnswer).missing.length,0);
  const entry=(question:string)=>{const attempt=f.store.list<any>('research-attempt').filter(row=>row.value.planQuestionId===question&&row.value.end?.type==='submitted').at(-1)!;
    return {question,claims:attempt.value.end.value.claims,result:{attempt}};};
  return {...f,scopeRecord,entries:{market:entry('q-market'),industry:entry('q-industry')},
    reply:(reply:unknown)=>writeFileSync(f.settings,JSON.stringify({tokens:10,reply}))} as unknown as Awaited<ReturnType<typeof completed>>;
}


test('B2: owner D4 return waits for a new act; repeat and cold read retain payment and the old choice', async t => {
  const f = await completed(t, 'owner');
  const proposal = await refutation(f);
  f.reply(supported);
  const output = await f.engine.execute({ type: 'discovery-research-return', ...proposal }) as {return: ReturnType<typeof reference>; destination: string};
  assert.equal(output.destination, 'D4');
  const result = await readResearchReturnAt(f.store, 'p', output.return);
  assert.equal(result.destination, 'D4');
  const paid = money(f.store), wire = f.wires().length;
  assert.deepEqual((await returnDiscoveryResearch(f.store, proposal)).record, result.record);
  const run = await f.engine.researcher.run('p', f.v.draft.id, 1, undefined, { producerPolicy: { discovery: 7 } });
  assert.equal(run.value.pauseCode, 'research_variant_owner_required');
  assert.deepEqual(money(f.store), paid); assert.equal(f.wires().length, wire);
  assert.equal((await readResearchReturnAt(f.open(), 'p', reference(result.record))).destination, 'D4');
  await assert.rejects(deep(f,'q-market',[claim(f,'q-market','market','The obsolete scope cannot buy again')]),
    (error:unknown)=>error instanceof EngineError && error.code==='discovery_return_d4');
  assert.deepEqual(money(f.store),paid); assert.equal(f.wires().length,wire);
  const act = revise(f);
  assert.notDeepEqual(act.decision.value.outcome, f.scope!.outcome);
  assert.deepEqual((await readResearchReturnAt(f.store, 'p', reference(result.record))).request.value.subject.decision, f.scopeRecord.value.decision);
});

test('B2: bypass uses a second paid choice with its actual predecessor; no second purchase by another actor', async t => {
  const f = await completed(t, 'model');
  const proposal = await refutation(f);
  f.reply(supported); const returned = await returnDiscoveryResearch(f.store, proposal);
  const prior = readCurrentVariantChoice(f.store, 'p', reference(f.v.draft));
  f.reply({ action: 'choose', key: 'v2', reason: 'The other member answers the refutation' });
  const subject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision' as const, set: reference(f.set!),
    mode: readProjectMode(f.store,'p').ref, expectedSelection: reference(prior.state) };
  const operation = { projectId:'p', variantSubject:subject, environment:f.environment,
    role:f.environment.value.implementer, prompt:'Choose a viable alternative using the full refutation, or reject_all.' };
  // The copied world has a new adapter command; measure its real decision purpose before buying v7 work.
  const calibration = f.store.write({id:'transport-fixture:b2-decision-calibration',kind:'transport-fixture',expected:0,value:{projectId:'p'}});
  await researchCall(f.environment.value.implementer,f.environment.value,'Calibrate decision',
    {variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,kind:'decision',set:reference(calibration),mode:subject.mode,expectedSelection:null},history:[]},undefined,
    {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'variant-decision'});
  const beforeChoice = f.wires().length;
  const run = await f.engine.researcher.run('p',f.v.draft.id,1,undefined,{producerPolicy:{discovery:7}});
  assert.equal(run.value.pauseCode,'research_deep_frontier_pending',run.value.error ?? undefined);
  assert.equal(f.wires().length,beforeChoice+1);
  const next = readCurrentVariantChoice(f.store, 'p', reference(f.v.draft));
  assert.deepEqual(next.choice.value.previous, prior.choice.ref);
  assert.notDeepEqual(next.choice.ref, prior.choice.ref);
  assert.deepEqual(readCurrentVariantChoice(f.open(),'p',reference(f.v.draft)).choice.value.previous,prior.choice.ref);
  const paid = money(f.store), wire = f.wires().length;
  const selected = await runVariantSession(f.store, operation);
  assert.deepEqual(await runVariantSession(f.store, operation), selected);
  assert.throws(() => prepareVariantSession(f.store, {...operation, role:f.environment.value.reviewer}), /already decided|being decided/);
  assert.deepEqual(money(f.store), paid); assert.equal(f.wires().length, wire);
  assert.equal((await readResearchReturnAt(f.open(), 'p', reference(returned.record))).destination, 'D4');
});

test('B2: late D5 gap reopens only its cell; new paid sufficiency closes it without clearing other coverage', async t => {
  const f = await runnerWorld(t);
  const before = computeMissingCoverage(f.store,'p',reference(f.scopeRecord),f.v.planAnswer);
  assert.equal(before.missing.length,0);
  f.reply(supported); const returned = await returnDiscoveryResearch(f.store,input(f,'D5'));
  const opened = computeMissingCoverage(f.store,'p',reference(f.scopeRecord),f.v.planAnswer);
  assert.deepEqual(opened.missing.map(cell=>cell.cell.subject.planQuestionId),['q-market']);
  assert.equal(deepPlanSelection(f.store,'p',reference(f.scopeRecord)).next?.cell.subject.planQuestionId,'q-market');
  assert.deepEqual(opened.cells.find(cell=>cell.cell.subject.planQuestionId==='q-industry'),before.cells.find(cell=>cell.cell.subject.planQuestionId==='q-industry'));
  assert.deepEqual(opened.missing[0]!.grounds,before.cells.find(cell=>cell.cell.subject.planQuestionId==='q-market')!.grounds);
  const calls = new Set(f.store.list('model-call').map(row=>row.id)), wireBefore = f.wires().length;
  f.reply({action:'answer',question:'q-market',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'The addressed source still needs retrieval'},citations:[]});
  const resumed = await f.engine.researcher.run('p',f.v.draft.id,1,undefined,{producerPolicy:{discovery:7}});
  assert.equal(resumed.value.pauseCode,'research_deep_frontier_pending',resumed.value.error ?? undefined);
  const newCalls = f.store.list<any>('model-call').filter(row=>!calls.has(row.id));
  assert.equal(newCalls.length,2);
  const dispatched = f.wires().slice(wireBefore);
  assert.equal(dispatched.length,2);
  assert.equal(dispatched.find(row=>row.subject.deepCell)!.subject.deepCell.subject.planQuestionId,'q-market');
  assert.equal(dispatched.find(row=>row.subject.assessmentSubject)!.subject.assessmentSubject.packet.planQuestionId,'q-market');
  const entry = await deep(f,'q-market',[claim(f,'q-market','market','Additional exact evidence resolves the late gap')]);
  await assess(f,entry);
  assert.equal(computeMissingCoverage(f.store,'p',reference(f.scopeRecord),f.v.planAnswer).missing.length,0);
  assert.equal((await readResearchReturnAt(f.open(), 'p', reference(returned.record))).destination,'D5');
});

test('B2: a proposed route without semantic support does not invalidate coverage or authorize another choice', async t => {
  const f = await completed(t,'model');
  const proposed = input(f,'D4'), before = money(f.store), wireBefore = f.wires().length;
  for (const key of Object.keys(proposed)) {
    const missing = {...proposed} as any; delete missing[key];
    await assert.rejects(returnDiscoveryResearch(f.store,missing), (error:unknown)=>error instanceof EngineError && error.code==='discovery_research_return_invalid');
  }
  await assert.rejects(returnDiscoveryResearch(f.store,{...proposed,grounds:addresses(f.entries.industry)}),/exact question/);
  assert.deepEqual(money(f.store),before); assert.equal(f.wires().length,wireBefore);
  f.reply({verdict:'insufficient',reasons:['This material does not refute the selected variant']});
  const result = await returnDiscoveryResearch(f.store,input(f,'D4'));
  assert.equal(result.destination,null); assert.equal(result.reason.code,'discovery_return_unproven');
  const reread = await readResearchReturnAt(f.store,'p',reference(result.record));
  result.request.value.input.reason = 'caller mutation';
  assert.notEqual((result.assessment.context.value as any).input.reason,'caller mutation');
  assert.deepEqual((await readResearchReturnAt(f.store,'p',reference(result.record))).request,reread.request);
  assert.equal(computeMissingCoverage(f.store,'p',reference(f.scopeRecord),f.v.planAnswer).missing.length,0);
  const state=f.store.get(variantStateId('p',f.v.draft.id))!;
  assert.throws(()=>prepareVariantSession(f.store,{projectId:'p',variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,kind:'decision',set:reference(f.set!),mode:readProjectMode(f.store,'p').ref,expectedSelection:reference(state)},environment:f.environment,role:f.environment.value.implementer,prompt:'Select'}),/already decided/);
  const paid=money(f.store); await returnDiscoveryResearch(f.store,input(f,'D4')); assert.deepEqual(money(f.store),paid);
});

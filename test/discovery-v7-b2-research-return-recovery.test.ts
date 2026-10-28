import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { completed, addresses, money, claim, deep, assess } from './discovery-v7-dossier-seed.js';
import { finalPaid } from './discovery-v7-final-paid-seed.js';
import { returnDiscoveryResearch, readResearchReturnAt, type ResearchReturnInput } from '../src/discovery/discovery-research-return.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { readCurrentVariantChoice } from '../src/discovery/variant-scope.js';

const supported = { verdict:'supported', reasons:['Proven evidence requires the addressed return'] };
function input(f: Awaited<ReturnType<typeof completed>>): ResearchReturnInput {
  return {project:'p',scope:reference(f.scopeRecord),plan:f.v.planAnswer,question:'q-market',axis:'market',
    grounds:addresses(f.entries.market),destination:'D5',final:null,reason:'Late market gap',requiredResult:'Additional market evidence'};
}

test('B2: paid final return preserves the previous D7 and exact evidence for its successor', async t => {
  const f = await finalPaid(t);
  f.reply({action:'answer',question:'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'Calibration'},citations:[]});
  await researchCall(f.environment.value.reviewer,f.environment.value,'Calibrate independent reviewer',{},undefined,
    {store:f.store,draftId:f.data.calibration.draft.id,questionId:f.data.calibration.question.id,purpose:'assessor'});
  const material=f.packet.dossier.materials.find(m=>(m.value as any).axis==='market' && (m.value as any).planQuestions.some((q:any)=>q.planQuestionId==='q-market'))!;
  assert.ok(material);
  const proposal: ResearchReturnInput = {project:'p',scope:f.packet.dossier.route.scope!.ref,plan:f.packet.subject.basis.plan,
    question:'q-market',axis:'market',grounds:[material.address],destination:'D7',final:f.paidResult,
    reason:'The final market conclusion needs revision',requiredResult:'A new final reflecting this exact market evidence'};
  f.reply(supported);
  const returned=await returnDiscoveryResearch(f.store,proposal);
  assert.equal(returned.destination,'D7'); assert.deepEqual(returned.final,f.paidResult);
  assert.deepEqual(f.store.get(f.paidResult.id,f.paidResult.revision),f.result);
  const paid=money(f.store),wire=f.wires().length;
  f.reopen();
  assert.deepEqual((await readResearchReturnAt(f.store,'p',reference(returned.record))).final,f.paidResult);
  assert.deepEqual((await returnDiscoveryResearch(f.store,proposal)).record,returned.record);
  assert.deepEqual(money(f.store),paid); assert.equal(f.wires().length,wire);
});

test('B2: a commit cut restores the paid assessment and return without another call', async t => {
  const f=await completed(t,'owner'); f.reply(supported);
  const write=Store.prototype.writeMany;
  let cut=false;
  Store.prototype.writeMany=function(items,guards) {
    const result=write.call(this,items,guards);
    if(this===f.store && !cut && items.some(item=>item.kind==='discovery-research-return')) { cut=true; throw new Error('B2 after commit'); }
    return result as any;
  };
  try { await assert.rejects(returnDiscoveryResearch(f.store,input(f)),/B2 after commit/); }
  finally { Store.prototype.writeMany=write; }
  assert.equal(cut,true);
  const paid=money(f.store),wire=f.wires().length;
  const restored=await returnDiscoveryResearch(f.open(),input(f));
  assert.equal(restored.destination,'D5');
  assert.equal(f.store.history(restored.record.id).length,1);
  assert.deepEqual(money(f.store),paid); assert.equal(f.wires().length,wire);
  assert.equal(hashJson(restored.record.value as never),restored.record.hash);
});

test('B2: ordinary run assesses accepted refuted deep evidence and waits at the owner door', async t => {
  const f=await completed(t,'owner');
  const contradicted=claim(f,'q-market','market','A new measurement contradicts the original selected-variant claim') as any;
  contradicted.refutedBy=addresses(f.entries.market);
  const entry=await deep(f,'q-market',[contradicted]); await assess(f,entry,'open');
  f.reply(supported);
  const run=await f.engine.researcher.run('p',f.v.draft.id,1,undefined,{producerPolicy:{discovery:7}});
  assert.equal(run.value.pauseCode,'research_variant_owner_required');
  const returns=f.store.list('discovery-research-return'); assert.equal(returns.length,1);
  const result=await readResearchReturnAt(f.open(),'p',reference(returns[0]!));
  assert.equal(result.destination,'D4'); assert.deepEqual(result.request.value.input.grounds,addresses(entry));
  assert.deepEqual(readCurrentVariantChoice(f.store,'p',reference(f.v.draft)).choice.ref,f.scopeRecord.value.decision);
  const paid=money(f.store),wire=f.wires().length;
  await f.engine.researcher.run('p',f.v.draft.id,1,undefined,{producerPolicy:{discovery:7}});
  assert.deepEqual(money(f.store),paid); assert.equal(f.wires().length,wire);
});

test('B2: a new return cannot bypass spent research tokens; paid recovery still works', async t => {
  const f=await completed(t,'owner');
  // Actual provider usage, consumed by the ordinary ledger, not an edited budget record.
  writeFileSync(f.settings,JSON.stringify({tokens:18_000_000,reply:supported}));
  const first=await returnDiscoveryResearch(f.store,input(f));
  const paid=money(f.store),wire=f.wires().length;
  f.reply(supported);
  await assert.rejects(returnDiscoveryResearch(f.store,{...input(f),reason:'Another addressed question about the same evidence'}),
    (error:unknown)=>error instanceof EngineError && /budget/.test(error.code));
  assert.deepEqual(money(f.store),paid); assert.equal(f.wires().length,wire);
  assert.deepEqual((await returnDiscoveryResearch(f.open(),input(f))).record,first.record);
});

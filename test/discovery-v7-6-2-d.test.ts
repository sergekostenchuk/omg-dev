import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { type Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-6-2-d-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

const rand = () => Math.random().toString(16).slice(2);
const allAxes = (depth: string) => Object.fromEntries(V7_AXES.map(axis => [axis, { depth }]));

function validFrame(): Json {
  return { productType: "internal", scale: "30 users across 10 sites",
    industries: ["construction"], domains: ["materials supply", "equipment accounting"],
    axes: allAxes("deep"),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } };
}
type PlanQuestion = { id: string; axis: string; domain: string; text: string; class: string;
  criterion: string; requiredDepth: string; roles: string[]; searchPlaces: string[] };
function planQuestion(id: string, axis: string, cls = "supporting"): PlanQuestion {
  return { id, axis, domain: "construction", text: `What covers ${id}?`,
    class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
    roles: ["domain expert"], searchPlaces: ["domain documents"] };
}
function validPlan(frameRef: Ref, questions: PlanQuestion[], edition = 1, previous: Ref | null = null): Json {
  return { edition, frame: frameRef, previous, questions } as unknown as Json;
}
function questionOf(store: Store, draft: Revision<DiscoveryDraft>, field: string): Revision<Question> {
  const question = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field);
  assert.ok(question, `question for ${field}`);
  return question;
}
/** The real plan acceptance chain (frame and plan through #answer). */
function acceptPlan(f: Fixture, project: string, questions: PlanQuestion[]) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, questions), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
async function setup(t: test.TestContext) {
  const f = fixture(t), project = 'p', wire = join(f.root,'wire.ndjson'), adapter = join(f.root,'adapter.mjs');
  const settings = join(f.root,'reply.json');
  writeFileSync(settings,JSON.stringify({tokens:10}));
  writeFileSync(adapter, `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const queued=settings.replies?.shift();if(queued)writeFileSync(${JSON.stringify(settings)},JSON.stringify(settings));
const research=settings.readSource&&!r.subject.contextWorkspace?.length?{action:'read_context',record:r.subject.working.archive,pointer:'/body/value/materials/0/value/content'}:queued??settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:settings.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = {executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure(project,{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:10000},0);
  const old=f.discovery.create(project,'discovery','R0','concept',[
    {field:'probe',kind:'fact',prompt:'Calibrate',risk:'unknown',schema:{type:'object'}}],[],6);
  const q=f.store.get<Question>(old.value.questions[0]!)!;
  await researchCall(environment.value.implementer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:old.id,questionId:q.id,purpose:'analyst'});
  await researchCall(environment.value.reviewer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:old.id,questionId:q.id,purpose:'assessor'});
  const questions=[planQuestion('q-industry','industry','blocking'),planQuestion('q-market','market')];
  const v=acceptPlan(f,project,questions);
  const subject=(id='q-industry',answer=v.planAnswer):V7PlanSubject=>({contract:V7_PLAN_SUBJECT_CONTRACT,planAnswer:answer,planQuestionId:id});
  const prompt='Research the selected plan question; return an answer with a V7AttemptEnd value and empty citations.';
  let runId: string | undefined;
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:context.dispatchMode==='planning'?'reading-planner' as const:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,...(context.dispatchMode?{mode:context.dispatchMode}:{}),instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:context.dispatchMode==='planning'?'reading-planner':'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,project,questions,subject,prepare,wires,environment,prompt,settings,calibration:{draft:old,question:q}};
}

import { applyDiscoveryAssessment, v7ProgressBaseline, proveAppliedAttemptClassification } from '../src/discovery/v7-progress.js';
import { proveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';

type Setup = Awaited<ReturnType<typeof setup>>;
const noEnd = () => ({ type:'impossible', code:'source_unavailable', evidence:[], text:'No source' });
function hypothesis(f: Setup, text: string) {
  return { type:'submitted', contract:DISCOVERY_CLAIMS_CONTRACT, value:{claims:[{id:'h',kind:'hypothesis',text,
    axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
    basis:{howToVerify:'Measure it'}}]} };
}
async function produce(f: Setup, end: unknown = noEnd(), question = 'q-industry') {
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'answer',question,value:end,citations:[]}}));
  const m=f.prepare(f.subject(question)), response=await m.invoke();
  const execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:100,context:m.context,subject:m.selected});
  const turnId=managedTurnId(m.run.id,m.number);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id:turnId,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const call=f.store.get<ResearchConsumerIntent>(m.intent.id)!.value.call!;
  const recorded=recordV7Attempt(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:question,
    call,end:attemptEndOfAction(response,m.selected)});
  const done=completeResearchAttemptTurn(f.store,'p',reference(f.store.get(turnId)!),reference(recorded.attempt));
  return { attempt:reference(recorded.attempt),binding:reference(done.binding) };
}
type Entry=Awaited<ReturnType<typeof produce>>;
async function assess(f: Setup, entries:Entry[], options:{accept?:boolean; selected?:number[]; requirements?:boolean}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:'q-industry',entries});
  const baseline=v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.selected ? claims.filter((_,i)=>options.selected!.includes(i))
    :options.accept?claims:[];
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:accepted.map(claim=>({claim,reason:'New basis'})),
    duplicates:[],
    noProgress:entries.filter(e=>!accepted.some(c=>c.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No new basis'})),
    transition:null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}


import { projectDossierManifest, readDossierManifestStructural, readDossierContradictionsAt,
  DOSSIER_MANIFEST_CONTRACT, DOSSIER_MANIFEST_KIND, type DossierManifest } from '../src/discovery/dossier-manifest.js';
import type { DossierContradiction, DossierResolution, DossierContradictionSide } from '../src/discovery/dossier-contradictions.js';

const side = (claim:ClaimAddress,status:DossierContradictionSide['status'],assessment:Ref|null):DossierContradictionSide=>({claim,status,assessment});
const contradiction = (sides:DossierContradictionSide[],resolution:DossierResolution={state:'open'},relation:DossierContradiction['relation']='contradicts'):DossierContradiction=>({
  id:'c',relation,sides:sides as DossierContradiction['sides'],reason:'The two claims disagree about the requirement',
  planQuestionIds:['q-industry'],blocking:false,resolution});
function snapshot(f:Setup,claims:ClaimAddress[],contradictions:DossierContradiction[]):DossierManifest {
  return {contract:DOSSIER_MANIFEST_CONTRACT,projectId:'p',draft:reference(f.v.draft),frame:f.v.frameRef,plan:f.v.planAnswer,
    completeness:'partial',reasons:[{code:'stall',message:'Other axes remain open',grounds:[f.v.planAnswer]}],
    axes:Object.fromEntries(V7_AXES.map(axis=>[axis,axis==='industry'?{depth:'deep',reason:null,claims}
      :{depth:'inapplicable',reason:'Outside this snapshot',claims:[]}])) as DossierManifest['axes'],unknowns:[],contradictions};
}
function save(f:Setup,value:DossierManifest) {
  const p=projectDossierManifest(value);
  return reference(f.store.get(p.id)??f.store.write({id:p.id,kind:DOSSIER_MANIFEST_KIND,expected:0,value:p.value}));
}
function refused(action:()=>unknown,field?:string) {
  assert.throws(action,(error:unknown)=>{
    assert.ok(error instanceof EngineError, String(error));
    assert.ok(error.details && typeof error.details==='object','The refusal is addressed');
    if(field)assert.equal((error.details as any).field,field,error.message);
    return true;
  });
}
async function pair(f:Setup,options:{apply?:boolean;both?:boolean;link?:'refutedBy'|'contradicts';scoped?:boolean;requirements?:boolean}={}) {
  const one=hypothesis(f,'Grounded requirement A');
  if(options.scoped)Object.assign(one.value.claims[0]!.scope,{region:'North'});
  const a=await produce(f,one),aClaim:ClaimAddress={project:'p',container:a.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const two=hypothesis(f,'Counterargument B');
  if(options.link)(two.value.claims[0] as any)[options.link]=[aClaim];
  if(options.scoped)Object.assign(two.value.claims[0]!.scope,{region:'South'});
  const b=await produce(f,two),judged=await assess(f,[a,b],{selected:options.both?[0,1]:[0],requirements:options.requirements??true});
  const applied=options.apply===false?null:applyDiscoveryAssessment(f.store,'p',reference(judged.paid));
  return {...judged,a,b,applied,refs:[reference(judged.paid)]};
}

test('6.2-D: real first application proves accepted and rejected sides; accepted keeps its public P.4 proof',async t=>{
  const f=await setup(t),p=await pair(f),sides=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const manifest=save(f,snapshot(f,p.claims,[contradiction(sides,{state:'side',holds:0,reason:'The applied original assessment supports A',grounds:p.refs})]));
  const before=f.store.list(),wires=f.wires().length,cold=f.open();
  cold.list=()=>assert.fail('No global Store scan belongs to contradiction proof');
  const result=readDossierContradictionsAt(cold,'p',manifest,{assessments:p.refs});
  assert.equal(result.verification,'contradictions');assert.deepEqual(result.manifestRef,manifest);assert.deepEqual(result.assessments,p.refs);
  assert.deepEqual(result.contradictions[0]!.sides.map(s=>s.status),['accepted','rejected']);
  assert.deepEqual(result.contradictions[0]!.sides.map(s=>s.application),[reference(p.applied!.applications[0]!),reference(p.applied!.applications[0]!)]);
  assert.equal(proveAppliedAttemptClassification(f.open(),p.claims[1]!).status,'rejected');
  assert.equal(proveClaimAddress(f.open(),p.claims[0]!).kind,'attempt');
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
});

test('6.2-D: paid classification without application cannot produce accepted, rejected or unassessed',async t=>{
  const f=await setup(t),p=await pair(f,{apply:false});
  for(const status of ['accepted','rejected','unassessed'] as const) {
    const sides=[side(p.claims[status==='rejected'?1:0]!,status,status==='unassessed'?null:p.refs[0]!),
      side(p.claims[status==='rejected'?0:1]!,'unassessed',null)];
    const m=save(f,snapshot(f,p.claims,[contradiction(sides)]));
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}));
  }
});

test('6.2-D: the explicit snapshot set is required; [] differs from classified sets for the same manifest',async t=>{
  const f=await setup(t),p=await pair(f);
  const m=save(f,snapshot(f,p.claims,[contradiction(p.claims.map(c=>side(c,'unassessed',null)))]));
  refused(()=>readDossierContradictionsAt(f.open(),'p',m,undefined as never),'grounds');
  for(const input of [{},{assessments:null},{assessments:new Array(1)},{assessments:[p.refs[0],p.refs[0]]},{assessments:[f.v.planAnswer]},
    {assessments:[{...p.refs[0]!,hash:'0'.repeat(64)}]},{assessments:['not-a-ref']}])
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,input as never));
  for(const damage of [{projectId:'another-project'},{contract:'unknown-assessment-version'}]) {
    const forged=f.store.write({id:`forged-assessment:${hashJson(damage)}`,kind:'discovery-assessment',expected:0,value:{...p.paid.value,...damage}});
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:[reference(forged)]}),'grounds.assessments.0');
  }
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:[]}).assessments,[]);
  refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}),'contradictions.0.sides.0.status');
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:[]}).assessments,[],'proof must not cache by manifest alone');
  for(const [i,value] of [null,{}, {projectId:'p',question:null}].entries()) {
    const malformed=f.store.write({id:`malformed-historical:${i}`,kind:'research-assessment',expected:0,value});
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:[reference(malformed)]}));
  }
  const oldAnswer=f.store.get<any>(f.v.frameRef.id,f.v.frameRef.revision)!;
  const historicRef=oldAnswer.value.assessment as Ref;
  const own=readDossierContradictionsAt(f.open(),'p',m,{assessments:[historicRef]});
  assert.deepEqual(own.assessments,[historicRef],'a historical answer assessment keeps its own contract, without attempt v3 requirements');
  assert.deepEqual(own.contradictions[0]!.sides.map(s=>s.status),['unassessed','unassessed']);

});

test('6.2-D: late favorable paid assessment cannot rename the exact first applied rejection',async t=>{
  const f=await setup(t),p=await pair(f),later=await assess(f,[p.a,p.b],{accept:true,requirements:true});
  const refs=[...p.refs,reference(later.paid)];
  const original=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const m=save(f,snapshot(f,p.claims,[contradiction(original)]));
  assert.equal(readDossierContradictionsAt(f.open(),'p',m,{assessments:refs}).contradictions[0]!.sides[1].status,'rejected');
  const changed=structuredClone(original);changed[1]=side(p.claims[1]!,'accepted',reference(later.paid));
  const renamed=save(f,snapshot(f,p.claims,[contradiction(changed)]));
  refused(()=>readDossierContradictionsAt(f.open(),'p',renamed,{assessments:refs}),'contradictions.0.sides.1.assessment');
  const unrelatedResolution=save(f,snapshot(f,p.claims,[contradiction(original,{state:'side',holds:0,
    reason:'A later favorable assessment is not the applied ground',grounds:[reference(later.paid)]})]));
  refused(()=>readDossierContradictionsAt(f.open(),'p',unrelatedResolution,{assessments:refs}),'contradictions.0.resolution.grounds.0');
  const unassessed=save(f,snapshot(f,p.claims,[contradiction(p.claims.map(c=>side(c,'unassessed',null)))]));
  assert.equal(readDossierContradictionsAt(f.open(),'p',unassessed,{assessments:[]}).contradictions[0]!.sides[1].status,'unassessed',
    'a later assessment outside the fixed set does not reinterpret it');
  refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:[reference(later.paid)]}),'contradictions.0.sides.0.assessment');
});

test('6.2-D: full claim address, original assessment and declared status cannot be substituted',async t=>{
  const f=await setup(t),p=await pair(f);
  const value=snapshot(f,p.claims,[contradiction([side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)])]);
  for(const damage of [
    (v:DossierManifest)=>{v.contradictions[0]!.sides[0].status='rejected';},
    (v:DossierManifest)=>{v.contradictions[0]!.sides[1].status='accepted';},
    (v:DossierManifest)=>{v.contradictions[0]!.sides[0].assessment=f.v.planAnswer;},
    (v:DossierManifest)=>{v.axes.industry.claims[0]!.claimId='other';v.contradictions[0]!.sides[0].claim.claimId='other';},
    (v:DossierManifest)=>{v.axes.industry.claims[0]!.containerKind='research-answer';v.contradictions[0]!.sides[0].claim.containerKind='research-answer';},
    (v:DossierManifest)=>{v.contradictions[0]!.planQuestionIds=['absent'];},
    (v:DossierManifest)=>{v.frame={...f.v.frameRef,revision:2};},
    (v:DossierManifest)=>{v.plan=f.v.frameRef;},
    (v:DossierManifest)=>{v.draft={...v.draft,hash:'0'.repeat(64)};}
  ]) {
    const v=structuredClone(value);damage(v);const m=save(f,v);
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}));
  }
});

test('6.2-D: refutedBy preserves directed [refuter,target], rejected counterargument and explicit-link completeness',async t=>{
  const f=await setup(t),p=await pair(f,{link:'refutedBy'});
  const sides=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const v=snapshot(f,p.claims,[contradiction(sides,{state:'open'},'refutes')]);
  const m=save(f,v),proof=readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs});
  assert.equal(proof.contradictions[0]!.sides[1].status,'rejected');
  for(const mode of ['omitted','reversed','lost-target'] as const) {
    const changed=structuredClone(v);
    if(mode==='omitted')changed.contradictions=[];
    else if(mode==='reversed')changed.contradictions[0]!.sides.reverse();
    else {changed.axes.industry.claims=[p.claims[1]!];changed.contradictions=[];}
    const ref=save(f,changed);refused(()=>readDossierContradictionsAt(f.open(),'p',ref,{assessments:p.refs}));
  }
});

test('6.2-D: contradicts is symmetric, exact links are mandatory even with no classified sides',async t=>{
  const f=await setup(t),p=await pair(f,{link:'contradicts'});
  const sides=p.claims.map(c=>side(c,'unassessed',null)).reverse();
  const v=snapshot(f,p.claims,[contradiction(sides)]),m=save(f,v);
  assert.equal(readDossierContradictionsAt(f.open(),'p',m,{assessments:[]}).contradictions.length,1);
  const omitted=save(f,{...v,contradictions:[]});refused(()=>readDossierContradictionsAt(f.open(),'p',omitted,{assessments:[]}));
});

test('6.2-D: scoped resolution uses proven grounds for both sides, never declares a winner from a region',async t=>{
  const f=await setup(t),p=await pair(f,{both:true,scoped:true});
  const sides=p.claims.map(c=>side(c,'accepted',p.refs[0]!));
  const resolution:DossierResolution={state:'scoped',dimension:'region',reason:'Independent applied claims concern North and South',grounds:p.refs};
  const v=snapshot(f,p.claims,[contradiction(sides,resolution)]),m=save(f,v);
  const proof=readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs});
  assert.deepEqual(proof.contradictions[0]!.sides.map(s=>s.status),['accepted','accepted']);
  assert.equal('holds' in proof.contradictions[0]!.contradiction.resolution,false);
  for(const dimension of ['apiVersion','asOf'] as const) {
    const changed=structuredClone(v);(changed.contradictions[0]!.resolution as any).dimension=dimension;
    refused(()=>readDossierContradictionsAt(f.open(),'p',save(f,changed),{assessments:p.refs}),'contradictions.0.resolution.dimension');
  }
});

test('6.2-D: arbitrary, unrelated, missing or changed resolution refs do not become grounds',async t=>{
  const f=await setup(t),p=await pair(f);
  const sides=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const resolve=(grounds:Ref[])=>save(f,snapshot(f,p.claims,[contradiction(sides,{state:'side',holds:0,reason:'A stands on a proven origin',grounds})]));
  assert.equal(readDossierContradictionsAt(f.open(),'p',resolve([p.claims[0]!.container]),{assessments:p.refs}).contradictions.length,1);
  for(const ground of [f.v.frameRef,f.v.planAnswer,p.claims[1]!.container,
    {...p.refs[0]!,hash:'0'.repeat(64)},{id:'absent',revision:1,hash:hashJson('absent')}])
    refused(()=>readDossierContradictionsAt(f.open(),'p',resolve([ground]),{assessments:p.refs}));
});

test('6.2-D: cold exact proof survives damaged later heads; losing pinned grounds refuses without writes or spend',async t=>{
  const f=await setup(t),p=await pair(f),v=snapshot(f,p.claims,[contradiction([
    side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)])]),m=save(f,v);
  const original=readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs});
  const account=f.store.list('v7-attempt-account')[0]!,turn=f.store.list('research-turn')[0]!;
  for(const row of [account,turn,p.paid])f.store.write({id:row.id,kind:row.kind,expected:row.revision,value:{broken:true}});
  const before=f.store.list(),wires=f.wires().length;
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}),original);
  const lost=f.open(),get=lost.get.bind(lost);
  lost.get=((id:string,rev?:number)=>id===p.paid.id&&rev===p.paid.revision?null:get(id,rev)) as typeof lost.get;
  refused(()=>readDossierContradictionsAt(lost,'p',m,{assessments:p.refs}));
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
  assert.equal(readDossierManifestStructural(f.open(),'p',m).verification,'structural');
});


test('6.2-D: applied v2 classifications keep their own contract beside v3',async t=>{
  const f=await setup(t),p=await pair(f,{requirements:false});
  assert.equal(p.paid.value.contract,'discovery-assessment/v2');
  const m=save(f,snapshot(f,p.claims,[contradiction([
    side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)])]));
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}).contradictions[0]!.sides.map(s=>s.status),['accepted','rejected']);
});

import { executeWebTurn } from '../src/discovery/web-research.js';
// M2 checks the structural v2 contract against real accepted plans, paid managed
// attempts and saved searches. It does not manufacture or apply a paid v7 assessment.
import { execFileSync } from 'node:child_process';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { DISCOVERY_ASSESSMENT_CONTRACT, DISCOVERY_ASSESSMENT_CONTRACT_V2, type ResearchTurn } from '../src/discovery/research-model.js';
import { checkDiscoveryAssessmentForm, claimContentKey } from '../src/discovery/v7-attempt-assessment.js';
import { ASSESSMENT_METHODOLOGY_CONTRACT, ASSESSMENT_METHODOLOGY_POLICY,
  checkAssessmentMethodology, methodologyClosureGaps, type AssessmentMethodology,
  type MethodSource, type MethodEvidence } from '../src/discovery/assessment-methodology.js';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { readResearchConsumerTurn, intentWebCapability } from '../src/discovery/response-recovery.js';
import { type Source } from '../src/evidence/evidence.js';
import { type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import { assessmentSession } from '../src/discovery/assessment-session.js';
import { digest, hashJson } from '../src/canonical.js';
import { baselineGuards } from '../src/discovery/v7-attempt-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { ATTEMPTS_ASSESSMENT_INSTRUCTION } from '../src/discovery/continuation-packet.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omg-dr3bm2-")));
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
/** The next lawful plan edition: reopen and accept again. */
async function setup(t: test.TestContext) {
  const f = fixture(t), project = 'p', wire = join(f.root,'wire.ndjson'), adapter = join(f.root,'adapter.mjs');
  const settings = join(f.root,'reply.json');
  writeFileSync(settings,JSON.stringify({tokens:10}));
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const research=settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:settings.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = {executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure(project,{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:10000,webResearch:{enabled:true,gatewayUrl:'https://gateway.example.org',timeoutMs:10000,
      budgetContract:'web-budget/v2',limits:{materialChars:2_000_000,responseBytes:2_000_000}}},0);
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
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:1,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    const input={projectId:project,kind:'analyst' as const,key:run.id,owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:1,instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,intent,input,invoke,question,draft,selected,context};
  };
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,project,questions,subject,prepare,wires,environment,prompt,settings};
}


function selected(source: Revision<Source>, pointer: string): MethodEvidence {
  return {source:reference(source),selector:{kind:'json-pointer',pointer}};
}
function methodSource(source: Revision<Source>): MethodSource {
  return {source:reference(source),role:'primary',reason:'The author reports its own observation',
    evidence:[selected(source,'/fact')],original:reference(source),originalReason:'This is the original report',limitation:null,
    publicationDate:{status:'known',value:'2026-10-19',evidence:[selected(source,'/published')]},
    eventDate:{status:'unknown',reason:'The event day was not reported'},
    version:{status:'known',value:'2.1',evidence:[selected(source,'/version')]},retrievedAt:null};
}
async function admit(f:Awaited<ReturnType<typeof setup>>, reply:unknown, id='q-industry') {
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const m=f.prepare(f.subject(id)), response=await m.invoke();
  const execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:1,context:m.context,subject:m.selected,web:intentWebCapability(f.store,m.intent)});
  const turnId=managedTurnId(m.run.id,1);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id:turnId,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  return {...m,response,turn:f.store.get<ResearchTurn>(turnId)!,call:f.store.get<ResearchConsumerIntent>(m.intent.id)!.value.call!};
}
async function methodologyFixture(t:test.TestContext) {
  const f=await setup(t);
  const document=(key:string,fact:string,published='2026-10-19',project='p')=>
    f.discovery.evidence.document(project,key,JSON.stringify({fact,published,version:'2.1'}),'application/json',0);
  const source=document('survey','Measured throughput is 42 units per day'),second=document('independent','Independent measurement: 42 units per day');
  const claim={id:'fact-throughput',kind:'fact',text:'Throughput is 42 units per day',axis:'industry',
    planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
    basis:{source:{ref:reference(source),range:{start:0,end:source.value.content.length},valueHash:hashJson(source.value.content)},
      limit:'Measured deployment only',asOf:'2026-10'}};
  const m=await admit(f,{action:'answer',question:'q-industry',value:{type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,
    value:{claims:[claim]}},citations:[]});
  const recorded=recordV7Attempt(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:'q-industry',
    call:m.call,end:attemptEndOfAction(m.response,m.selected)});
  const done=completeResearchAttemptTurn(f.store,'p',reference(m.turn),reference(recorded.attempt));
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:'q-industry',
    entries:[{attempt:reference(recorded.attempt),binding:reference(done.binding)}]});
  const baseline={contract:V7_PROGRESS_BASELINE_CONTRACT,state:{kind:'absent' as const,id:v7ProgressStateId(packet)},materials:[]};
  const address:ClaimAddress={project:'p',container:reference(recorded.attempt),containerKind:'research-attempt',pointer:'/claims/0',claimId:claim.id};
  const method:AssessmentMethodology={contract:ASSESSMENT_METHODOLOGY_CONTRACT,policy:ASSESSMENT_METHODOLOGY_POLICY,facts:[{
    claim:address,significance:{kind:'blocking',reason:'This fact is used by the blocking criterion'},
    sources:[methodSource(source),methodSource(second)],
    temporalApplicability:{status:'established',scope:'The measured deployment in October 2026',reason:'Dated report of this deployment',evidence:[selected(source,'/published')]},
    corroboration:{status:'independent',sources:[reference(source),reference(second)],reason:'Separately authored measurement'},
    refutation:{status:'not_performed',reason:'No search has been executed yet',traces:[],counterarguments:[],limitations:['No refutation search yet']}
  }]};
  // The shared session/application producer gives real addresses, but this is
  // still a structural v2 form: the paid v2 assessor and its application belong to A/P.
  const reply={verdict:'return',reasons:['Continue research'],return:{target:{attempt:reference(recorded.attempt)},reason:'Continue research'},
    novelty:{attempts:[{attempt:reference(recorded.attempt),reason:'Reviewed'}],accepted:[],rejected:[{claim:address,reason:'Continue research'}],
      newContent:[],duplicates:[],noProgress:[{attempt:reference(recorded.attempt),reason:'Continue research'}],transition:null}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const stop=new Error('M2 stops at the durable paid boundary'),write=f.store.writeMany.bind(f.store);
  f.store.writeMany=((writes,guards=[])=>{
    const terminal=writes.some(w=>w.kind==='model-call'&&(w.value as any).purpose==='assessor'&&(w.value as any).status==='succeeded');
    const out=write(writes,guards);if(terminal)throw stop;return out;
  }) as typeof f.store.writeMany;
  try {await assert.rejects(assessmentSession(f.store,m.draft,m.question,f.environment,f.environment.value,undefined,
    {assessmentSubject:{kind:'attempts',packet,baseline},value:{attempts:packet.entries},observations:[]},
    ATTEMPTS_ASSESSMENT_INSTRUCTION,undefined,baselineGuards(baseline)),error=>error===stop);}
  finally {f.store.writeMany=write;}
  const application=f.store.list<any>('assessment-application')[0]!;
  assert.ok(application);
  const form={contract:DISCOVERY_ASSESSMENT_CONTRACT_V2,projectId:'p',subject:{kind:'attempts',packet},baseline,
    session:application.value.session,application:reference(f.store.get(application.id,1)!),
    assessor:f.environment.value.reviewer.actor,environment:reference(f.environment),verdict:'supported',reasons:['Measured facts'],return:null,
    novelty:{attempts:[{attempt:reference(recorded.attempt),reason:'Reviewed'}],accepted:[{claim:address,reason:'Measured'}],rejected:[],
      newContent:[{claim:address,reason:'New measurement'}],duplicates:[],noProgress:[],transition:null},methodology:method};
  const subject={project:'p',planAnswer:packet.planAnswer,planQuestionId:packet.planQuestionId,blocking:true,accepted:[address]};
  return {...f,m,document,source,second,address,form,method,methodSubject:subject};
}
function refused(fn:()=>unknown,field:string,code='discovery_novelty_invalid') {
  assert.throws(fn,(error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,code);
    assert.equal((error.details as any)?.field,field);return true;
  });
}
const factOf=(method:AssessmentMethodology)=>method.facts[0]!;

test('M2: versioned methodology proves dates, source independence and saved searches without applying an assessment',async t=>{
  const f=await methodologyFixture(t);
  const check=(method:unknown,store=f.store)=>checkAssessmentMethodology(store,method,f.methodSubject);
  const bad=(mutate:(m:any)=>void,field:string)=>{const m=structuredClone(f.method);mutate(m);refused(()=>check(m),field);};
  const prefix='methodology.facts.0';
  await t.test('v2 requires explicit policy and complete fact coverage; v1 remains readable in its own era',()=>{
    assert.deepEqual(checkDiscoveryAssessmentForm(f.store,f.form).value,f.form);
    const {methodology,...base}=f.form;
    const old={...base,contract:DISCOVERY_ASSESSMENT_CONTRACT};
    assert.deepEqual(checkDiscoveryAssessmentForm(f.store,old).value,old);
    refused(()=>checkDiscoveryAssessmentForm(f.store,base),'assessment','discovery_assessment_subject_invalid');
    refused(()=>checkDiscoveryAssessmentForm(f.store,{...f.form,methodology:null}),'methodology');
    refused(()=>checkDiscoveryAssessmentForm(f.store,{...old,methodology}),'assessment','discovery_assessment_subject_invalid');
    for(const field of ['contract','policy','facts'])for(const value of [undefined,null]){
      const m:any=structuredClone(f.method);if(value===undefined)delete m[field];else m[field]=value;
      refused(()=>check(m),field==='facts'&&value===null?'methodology.facts':'methodology');
    }
    bad(m=>m.policy='future','methodology');bad(m=>m.facts=[],'methodology.facts');
    bad(m=>m.facts.push(m.facts[0]),'methodology.facts.1.claim');
    bad(m=>m.facts[0].claim.project='foreign',`${prefix}.claim`);
    bad(m=>m.facts[0].significance.kind='supporting',`${prefix}.significance`);
    for(const field of ['claim','significance','sources','temporalApplicability','corroboration','refutation'])
      bad(m=>delete m.facts[0][field],prefix);
  });
  await t.test('every new nested structure is required and rejected claims get no accepting methodology',()=>{
    const shapes:[string[],string[]][]=[
      [['significance'],['kind','reason']],
      [['sources','0'],['source','role','reason','evidence','original','originalReason','limitation','publicationDate','eventDate','version','retrievedAt']],
      [['temporalApplicability'],['status','scope','reason','evidence']],
      [['corroboration'],['status','sources','reason']],
      [['refutation'],['status','reason','traces','counterarguments','limitations']],
    ];
    for(const [path,fields] of shapes)for(const field of fields)bad(m=>{
      const row=path.reduce((a:any,k)=>a[k],m.facts[0]);delete row[field];
    },`${prefix}.${path.join('.')}`);
    const returned:any=structuredClone(f.form);
    returned.verdict='return';returned.return={target:{attempt:returned.subject.packet.entries[0].attempt},reason:'Further research'};
    returned.novelty.rejected=returned.novelty.accepted;returned.novelty.accepted=[];returned.novelty.newContent=[];
    returned.novelty.noProgress=returned.novelty.attempts;
    refused(()=>checkDiscoveryAssessmentForm(f.store,returned),`${prefix}.claim`);
    returned.methodology.facts=[];checkDiscoveryAssessmentForm(f.store,returned);
    const unexpected=new Error('Store IO failed'),get=f.store.get.bind(f.store);
    f.store.get=((id:string,revision?:number)=>{if(id===f.source.id)throw unexpected;return get(id,revision);}) as typeof f.store.get;
    try{assert.throws(()=>check(f.method),error=>error===unexpected);}finally{f.store.get=get;}
  });
  await t.test('known dates and versions require exact selected bytes; unknown and retrieval are distinct',()=>{
    bad(m=>m.facts[0].sources[0].publicationDate.value='2026-10-20',`${prefix}.sources.0.publicationDate.evidence`);
    bad(m=>m.facts[0].sources[0].publicationDate.evidence=[],`${prefix}.sources.0.publicationDate.evidence`);
    bad(m=>m.facts[0].sources[0].publicationDate.value='2026-02-30',`${prefix}.sources.0.publicationDate.value`);
    bad(m=>m.facts[0].sources[0].version.value='3.0',`${prefix}.sources.0.version.evidence`);
    bad(m=>m.facts[0].sources[0].retrievedAt='2026-10-20T00:00:00Z',`${prefix}.sources.0.retrievedAt`);
    for(const field of ['publicationDate','eventDate','version']){
      bad(m=>delete m.facts[0].sources[0][field],`${prefix}.sources.0`);
      bad(m=>m.facts[0].sources[0][field]=null,`${prefix}.sources.0.${field}`);
      bad(m=>m.facts[0].sources[0][field]={status:'unknown',reason:''},`${prefix}.sources.0.${field}.reason`);
    }
    const m=structuredClone(f.method);
    for(const source of factOf(m).sources){source.publicationDate={status:'unknown',reason:'No publication date supplied'};source.version={status:'unknown',reason:'No edition given'};}
    check(m);
    assert.deepEqual(methodologyClosureGaps(factOf(m),{dated:true,versioned:true,independentConfirmation:true}),['date_unproven','version_unproven']);
    const proof=f.discovery.evidence.document('p','date-text','Published 2026-10-19','text/plain',0);
    const ms=factOf(m).sources[0]!;
    ms.publicationDate={status:'known',value:'2026-10-19',evidence:[{source:reference(proof),selector:{kind:'text-range',start:10,end:20}}]};
    check(m);
    ms.publicationDate.evidence[0]!.selector={kind:'text-range',start:0,end:20};
    refused(()=>check(m),`${prefix}.sources.0.publicationDate.evidence`);
  });
  await t.test('exact sources, selectors and project boundaries reject masquerades',()=>{
    const foreign=f.document('foreign','Foreign material','2026-10-19','other');
    bad(m=>m.facts[0].sources[0].source=reference(foreign),`${prefix}.sources.0.source`);
    bad(m=>m.facts[0].sources[0].source.hash='forged',`${prefix}.sources.0.source`);
    bad(m=>m.facts[0].sources[0].source.revision=999,`${prefix}.sources.0.source`);
    bad(m=>m.facts[0].sources[0].original=reference(foreign),`${prefix}.sources.0.original`);
    bad(m=>m.facts[0].sources[0].evidence[0].source=reference(foreign),`${prefix}.sources.0.evidence.0.source`);
    bad(m=>m.facts[0].sources[0].publicationDate.evidence[0].source=reference(foreign),`${prefix}.sources.0.publicationDate.evidence.0.source`);
    for(const pointer of ['/absent','/__proto__','/~2bad'])bad(m=>m.facts[0].sources[0].evidence[0].selector.pointer=pointer,`${prefix}.sources.0.evidence.0.selector`);
    bad(m=>m.facts[0].sources[0].evidence[0].selector={kind:'text-range',start:0,end:999999},`${prefix}.sources.0.evidence.0.selector`);
    bad(m=>m.facts[0].sources[0].evidence.push(m.facts[0].sources[0].evidence[0]),`${prefix}.sources.0.evidence`);
    bad(m=>m.facts[0].refutation.counterarguments=[{source:reference(foreign),selector:{kind:'json-pointer',pointer:'/fact'}}],`${prefix}.refutation.counterarguments.0.source`);
  });
  await t.test('mirrors and the same declared original cannot be counted as two confirmations',()=>{
    const mirror=f.discovery.evidence.document('p','mirror',f.source.value.content,'application/json',0);
    const m=structuredClone(f.method),fact=factOf(m);
    fact.sources[1]=methodSource(mirror);fact.corroboration={status:'independent',sources:[reference(f.source),reference(mirror)],reason:'Two URLs'};
    refused(()=>check(m),`${prefix}.corroboration.sources`);
    fact.sources[1]=methodSource(f.second);fact.sources[1].role='secondary';fact.sources[1].original=reference(f.source);
    fact.sources[1].limitation='Retells the first survey';fact.corroboration.sources[1]=reference(f.second);
    refused(()=>check(m),`${prefix}.corroboration.sources`);
    fact.corroboration={status:'single_confirmation',reason:'Same original',limitation:'Independent evidence has not been found'};
    check(m);
    assert.deepEqual(methodologyClosureGaps(fact,{dated:true,versioned:true,independentConfirmation:true}),['single_confirmation']);
    fact.sources[1].limitation=null;refused(()=>check(m),`${prefix}.sources.1.limitation`);
    for(const source of fact.sources){source.role='secondary';source.original=null;source.originalReason='Original publisher unavailable';source.limitation='Only a retelling is available';}
    check(m);
    fact.corroboration={status:'independent',sources:[reference(f.source),reference(f.second)],reason:'Different hosts'};
    refused(()=>check(m),`${prefix}.corroboration.sources`);
    bad(m=>m.facts[0].sources[0].originalReason='',`${prefix}.sources.0.originalReason`);
    bad(m=>m.facts[0].corroboration.sources=[reference(f.source),reference(f.source)],`${prefix}.corroboration.sources`);
    bad(m=>m.facts[0].corroboration={status:'single_confirmation',reason:'Only one',limitation:''},`${prefix}.corroboration.limitation`);
  });
  await t.test('false searched and missing traces cannot stand for a performed search',()=>{
    bad(m=>m.facts[0].refutation=true,`${prefix}.refutation`);
    bad(m=>m.facts[0].refutation.searched=true,`${prefix}.refutation`);
    bad(m=>m.facts[0].refutation.status=true,`${prefix}.refutation.status`);
    bad(m=>m.facts[0].refutation.status='performed',`${prefix}.refutation.traces`);
    bad(m=>m.facts[0].refutation={...m.facts[0].refutation,traces:[{turn:reference(f.m.turn),capture:reference(f.source)}]},`${prefix}.refutation.traces`);
    const m=structuredClone(f.method);factOf(m).refutation.status='unavailable';factOf(m).refutation.reason='Gateway unavailable before any request';check(m);
  });
  await t.test('a real paid search plus its saved result proves performance, including cold historical reading',async()=>{
    const failed=await admit(f,{action:'search',query:'counterargument'});
    const missed=new ResearchSources(f.store,'p',f.root).searchCaptured('counterargument',failed.turn);
    f.store.writeMany([missed.capture,{id:failed.turn.id,kind:'research-turn',expected:failed.turn.revision,value:missed.turn}],missed.guards);
    const limited=structuredClone(f.method);factOf(limited).refutation={status:'unavailable',reason:'Workspace is not a repository',
      traces:[{turn:reference(f.store.get(failed.turn.id)!),capture:missed.captureRef}],counterarguments:[],limitations:['Repository search unavailable']};
    check(limited);factOf(limited).refutation.status='performed';refused(()=>check(limited),`${prefix}.refutation.traces.0`);
    execFileSync('git',['init','--quiet',f.root]);
    writeFileSync(join(f.root,'survey.txt'),'A counterargument: different deployment and conditions.');
    execFileSync('git',['-C',f.root,'add','survey.txt']);
    const search=await admit(f,{action:'search',query:'counterargument'});
    const result=new ResearchSources(f.store,'p',f.root).searchCaptured('counterargument',search.turn);
    f.store.writeMany([result.capture,{id:search.turn.id,kind:'research-turn',expected:search.turn.revision,value:result.turn}],result.guards);
    const completed=f.store.get<ResearchTurn>(search.turn.id)!;
    readResearchConsumerTurn(f.store,reference(completed));
    const m=structuredClone(f.method),fact=factOf(m);
    fact.refutation={status:'performed',reason:'Searched the workspace for counterarguments',traces:[{turn:reference(completed),capture:result.captureRef}],
      counterarguments:[selected(f.second,'/fact')],limitations:['This search covers the local workspace only']};
    check(m);check(m,f.open());
    const trace=fact.refutation.traces[0]!;
    trace.turn=reference(search.turn);refused(()=>check(m),`${prefix}.refutation.traces.0`);
    trace.turn=reference(completed);trace.capture=reference(f.source);refused(()=>check(m),`${prefix}.refutation.traces.0.capture`);
    trace.capture=result.captureRef;fact.refutation.status='unavailable';refused(()=>check(m),`${prefix}.refutation.traces.0`);
    fact.refutation.status='performed';
    const otherSubject={...f.methodSubject,planQuestionId:'q-market'};
    refused(()=>checkAssessmentMethodology(f.store,m,otherSubject),`${prefix}.refutation.traces.0`);
    f.form.methodology=m;
  });
  await t.test('web retrieval time stays separate and two captures of one URL remain one source',async()=>{
    const url='https://example.org/study';
    const fetch=async(content:string,when:string)=>{
      const m=await admit(f,{action:'web_fetch',url,purpose:'Read the original study'}),bytes=Buffer.from(content);
      const result=await executeWebTurn({store:f.store,projectId:'p',stage:'discovery',environment:f.environment,turn:m.turn,
        transport:async()=>({status:200,body:{contract:'web-document/v2',requested_url:url,selected_url:url,final_url:url,
          fetched_at:when,status:200,success:true,failure:null,redirects:[],attempts:[],
          raw:{encoding:'base64',data:bytes.toString('base64'),mediaType:'text/markdown',byteLength:bytes.length,sha256:digest(bytes)},
          clean:{text:content,mediaType:'text/markdown',utf16Length:content.length,sha256:digest(content)},
          method:{kind:'native-markdown',version:'fixture/v1'},signals:{rawTruncated:false,cleanTruncated:false,completeness:'unknown'}}})});
      assert.ok(result.source);return result.source;
    };
    const a=await fetch('The original study, no publication date supplied.','2026-10-20T00:00:00Z');
    const b=await fetch('The original study, no publication date supplied. Updated footer.','2026-10-21T00:00:00Z');
    const method=(source:Revision<Source>):MethodSource=>({...methodSource(source),
      evidence:[{source:reference(source),selector:{kind:'text-range',start:0,end:18}}],
      publicationDate:{status:'unknown',reason:'The page states no publication date'},
      eventDate:{status:'unknown',reason:'The page states no event date'},version:{status:'unknown',reason:'No edition supplied'},
      retrievedAt:source.value.origin.kind==='web'?source.value.origin.fetchedAt:null});
    const m=structuredClone(f.method),fact=factOf(m);fact.sources.push(method(a),method(b));
    check(m);
    fact.corroboration={status:'independent',sources:[reference(f.source),reference(a),reference(b)],reason:'Three captures'};
    refused(()=>check(m),`${prefix}.corroboration.sources`);
    fact.corroboration={status:'single_confirmation',reason:'The web captures share one original',limitation:'No independent web confirmation'};
    fact.sources[2]!.publicationDate={status:'known',value:'2026-10-20T00:00:00Z',evidence:fact.sources[2]!.evidence};
    refused(()=>check(m),`${prefix}.sources.2.publicationDate.evidence`);
  });
  await t.test('a real web search result proves the action; refusal is an unavailable trace',async()=>{
    const search=await admit(f,{action:'web_search',query:'throughput counterarguments',purpose:'Find contrary evidence'});
    const outcome=await executeWebTurn({store:f.store,projectId:'p',stage:'discovery',environment:f.environment,turn:search.turn,
      transport:async()=>({status:200,body:{query:'throughput counterarguments',results:[],engines_queried:['fixture'],unresponsive_engines:[],elapsed_ms:1}})});
    assert.ok(outcome.capture);
    const m=structuredClone(f.method),fact=factOf(m);fact.refutation={status:'performed',reason:'Queried the named engine',
      traces:[{turn:reference(outcome.turn),capture:outcome.capture}],counterarguments:[],limitations:['No hit in this query does not prove absence of contrary evidence']};
    check(m);check(m,f.open());
    const down=await admit(f,{action:'web_search',query:'down',purpose:'Find contrary evidence'});
    const unavailable=await executeWebTurn({store:f.store,projectId:'p',stage:'discovery',environment:f.environment,turn:down.turn,
      transport:async()=>({status:200,body:{query:'down',results:[],engines_queried:['fixture'],unresponsive_engines:[['fixture','down']],elapsed_ms:1}})});
    assert.ok(unavailable.capture);
    fact.refutation={...fact.refutation,status:'unavailable',reason:'All queried engines failed',traces:[{turn:reference(unavailable.turn),capture:unavailable.capture}]};
    check(m);fact.refutation.status='performed';refused(()=>check(m),`${prefix}.refutation.traces.0.capture`);
    const missing=await admit(f,{action:'web_search',query:'unavailable',purpose:'Find contrary evidence'});
    const old=f.environment;
    const disabled=f.engine.environments.configure('p',{...old.value,webResearch:{...old.value.webResearch!,enabled:false}},old.revision);
    const refusedSearch=await executeWebTurn({store:f.store,projectId:'p',stage:'discovery',environment:disabled,turn:missing.turn,
      transport:async()=>{throw Error('Disabled search cannot send HTTP');}});
    assert.ok(refusedSearch.capture);
    fact.refutation={...fact.refutation,status:'unavailable',reason:'Web research was disabled',traces:[{turn:reference(refusedSearch.turn),capture:refusedSearch.capture}]};
    check(m);
    fact.refutation.status='performed';refused(()=>check(m),`${prefix}.refutation.traces.0`);
  });
  await t.test('registry enumerates every new exact reference and excludes free JSON from service references',()=>{
    const sites=referenceSites('discovery-assessment',f.form);
    const fields=sites.map(s=>s.field);
    for(const suffix of ['claim.container','sources[0].source','sources[0].original','sources[0].evidence[0].source',
      'sources[0].publicationDate.evidence[0].source','sources[0].version.evidence[0].source',
      'temporalApplicability.evidence[0].source','corroboration.sources[0]','refutation.traces[0].turn',
      'refutation.traces[0].capture','refutation.counterarguments[0].source'])
      assert.ok(fields.includes(`methodology.facts[0].${suffix}`),fields.join('\n'));
    const disguise:any=structuredClone(f.form);disguise.methodology.facts[0].refutation.reason=reference(f.source);
    disguise.methodology.facts[0].sources[0].version.value=reference(f.source);
    assert.deepEqual(referenceSites('discovery-assessment',disguise),sites,'Reference-shaped data is not a registry address');
    const {methodology,...old}=f.form;
    const oldSites=referenceSites('discovery-assessment',{...old,contract:DISCOVERY_ASSESSMENT_CONTRACT});
    assert.deepEqual(sites.filter(s=>!s.field.startsWith('methodology.')),oldSites);
    assert.deepEqual(checkStoreIntegrity(f.open()).findings??[],[]);
  });
  await t.test('new source heads and annotation changes neither replace historical bytes nor manufacture novelty',()=>{
    const beforeKey=claimContentKey(f.store,f.address),beforeEvents=f.store.events(0,f.store.lastEvent());
    const changed=structuredClone(f.form);changed.methodology.facts[0]!.refutation.reason='Same saved search, more precise wording';
    assert.deepEqual(checkDiscoveryAssessmentForm(f.store,changed).value.novelty,f.form.novelty);
    assert.equal(claimContentKey(f.store,f.address),beforeKey);
    assert.deepEqual(f.store.events(0,f.store.lastEvent()),beforeEvents,'Structural reading never writes');
    f.discovery.evidence.document('p','survey',JSON.stringify({fact:'Changed later',published:'2027-01-01',version:'3'}),'application/json',f.source.revision);
    assert.deepEqual(checkDiscoveryAssessmentForm(f.open(),f.form).value,f.form);
    assert.equal(claimContentKey(f.store,f.address),beforeKey);
    assert.equal(f.store.list('discovery-assessment').length,0,'A/P have not produced or applied a v2 assessment');
  });
});

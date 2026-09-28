import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference} from '../src/pipeline/contracts.js';
import {configureResearchScope,scopedQuestions} from '../src/graph/research-scope.js';
import {withTypedBasis,resolveResearchBasis} from '../src/graph/research-basis.js';
import {withObligationEvidence,obligationEvidenceFindings} from '../src/graph/obligation-evidence.js';
import {technicalProposalFindings} from '../src/graph/research-evidence.js';
import {assessAnswer} from '../src/discovery/research-assessment.js';
import {workingContext} from '../src/discovery/working-context.js';
import type {ObligationAssignment} from '../src/graph/obligation-policy.js';
import type {TechnicalReport} from '../src/graph/research-contracts.js';
import type {Question} from '../src/discovery/discovery.js';
import type {Graph} from '../src/graph/model.js';
import type {Json} from '../src/canonical.js';
import type {ResearchAction,ResearchAssessment} from '../src/discovery/research-model.js';

function fixture(t:test.TestContext,kind:ObligationAssignment['kind']='environment-confirmation',allowDocument=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'omg-obligation-evidence-'))),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Obligation evidence'});
 const graph={nodes:[{id:'n',code:[]}],horizon:[],connectors:[],tests:[],anchors:[]} as unknown as Graph;
 store.write({id:'graph:p',kind:'graph',expected:0,value:graph});
 const layer=store.write({id:'graph-layer:p:2',kind:'graph-layer',expected:0,value:{projection:graph}});
 const gap={id:'required',target:'n',field:'code',question:'Establish the required knowledge',consumer:'compilation',requiredFor:'next' as const};
 const r1=store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:'p',fields:{technical:{gaps:[gap]}}}});
 const phase=store.write({id:'phase:p:R1',kind:'phase',expected:0,value:{draft:reference(r1)}});
 const source=configureResearchScope(store,{projectId:'p',layer:reference(layer),r1:reference(phase),outcome:'Produce a justified plan',nodes:['n'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
  obligations:[{gap,state:'active',reason:'original',wake:null}]},0);
 writeFileSync(join(root,'code.ts'),'export const option = "read-only";');
 const file=engine.discovery.evidence.file('p','code',root,'code.ts','text/plain',0);
 const owner=engine.discovery.evidence.document('p','owner','Owner requests recoverable output.','text/plain',0);
 const metadata=engine.discovery.evidence.document('p','audit-metadata','Observed user_version=1 at audited event 2346.','text/plain',0);
 const allowance={sources:[reference(metadata)],claimLimit:'Only observed database metadata at event 2346, not integrity, migration permission or runtime isolation'};
 const assignment:ObligationAssignment={obligation:gap.id,original:{record:reference(source),pointer:'/obligations/0/gap'},kind,moment:'R2',responsibleNode:gap.target,responsibleConsumer:gap.consumer,neededForR2:true,reason:'Needed to justify this decision',returnCondition:null,
  ...(allowDocument?{documentaryAllowance:allowance}:{})};
 const scope=configureResearchScope(store,{...source.value,policy:{version:1,sourceScope:reference(source),assignments:[assignment]}},1);
 const spec=withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(s=>s.obligations)!));
 const draft=engine.discovery.create('p','om-g2','R2','compilation',[spec],[reference(scope)],2),question=store.get<Question>(draft.value.questions[0]!)!;
 const observations=[file,owner,metadata].map(s=>engine.discovery.evidence.observe('p',reference(s),{kind:'text-range',start:0,end:s.value.content.length}));
 const report:TechnicalReport={applicability:'applicable',reason:'Bound evidence and proposed change',facts:[{id:'f',claim:'The adapter declares an option',evidence:{kind:'repository-file',citation:0}}],
  designs:[{id:'d',decision:'Produce recoverable output',benefit:'Recoverability',consumer:'compilation'}],gaps:[],
  documents:[{id:'intent',kind:'owner-document',citation:1,quote:owner.value.content,claim:'Attributed owner intent',designs:['d'],gaps:[]},
    {id:'metadata',kind:'document-observation',citation:2,quote:metadata.value.content,claim:'Reported metadata at event 2346 only',designs:['d'],gaps:[]}],
  coverage:[{obligation:'required',facts:['f'],designs:['d'],gaps:[]}]};
 const wire=join(root,'wire.ndjson'),payload=join(root,'answer.json'),adapter=join(root,'adapter.mjs');
 writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');const research=r.subject.role==='assess-answer'?{verdict:'supported',reasons:[]}:JSON.parse(readFileSync(${JSON.stringify(payload)},'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const command={executable:process.execPath,args:[adapter]};
 const environment=engine.environments.configure('p',{workspace:root,implementer:{actor:'analyst',model:'fixture',effort:'high',command},reviewer:{actor:'assessor',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 const action=(r=report):Extract<ResearchAction,{action:'answer'}>=>({action:'answer',question:question.id,value:r as unknown as Json,citations:observations.map(({source,selector})=>({source,selector}))});
 writeFileSync(payload,JSON.stringify(action()));
 const findings=(r=report)=>technicalProposalFindings(store,'p','R2',question.id,spec.field,r,observations,graph,root);
 return {root,store,engine,source,scope,spec,draft,question,file,owner,metadata,observations,report,action,findings,environment,wire,allowance,assignment};
}

test('repository, design and owner obligations require different kinds of support',t=>{
 const repo=fixture(t,'repository-fact');
 assert.deepEqual(repo.findings(),[]);
 assert.ok(repo.findings({...repo.report,coverage:[{obligation:'required',facts:[],designs:['d'],gaps:[]}]}).some(f=>f.code==='obligation_repository_evidence_required'));
 const design=fixture(t,'design-decision');
 assert.deepEqual(design.findings(),[]);
 assert.ok(design.findings({...design.report,coverage:[{obligation:'required',facts:['f'],designs:[],gaps:[]}]}).some(f=>f.code==='obligation_design_required'));
 const owner=fixture(t,'owner-decision');assert.deepEqual(owner.findings(),[]);
 assert.ok(owner.findings({...owner.report,documents:owner.report.documents!.filter(d=>d.kind!=='owner-document')}).some(f=>f.code==='obligation_owner_intent_required'));
});

test('a bounded documentary allowance admits exact metadata but not another source or an intent label',t=>{
 const f=fixture(t,'environment-confirmation',true);assert.deepEqual(f.findings(),[]);
 assert.ok(f.findings({...f.report,documents:f.report.documents!.filter(d=>d.id==='intent')}).some(x=>x.code==='obligation_document_evidence_required'));
 const wrong={...f.report,documents:[{...f.report.documents![1]!,citation:1,quote:f.owner.value.content}]};
 assert.ok(f.findings(wrong).some(x=>x.code==='obligation_document_evidence_required'));
 assert.ok(f.findings({...f.report,coverage:[{obligation:'required',facts:['f'],designs:[],gaps:[]}]}).some(x=>x.code==='obligation_document_evidence_required'));
});

test('runtime isolation cannot be closed by code, owner intent or an unapproved documentary observation',async t=>{
 const f=fixture(t);
 assert.ok(f.findings().some(x=>x.code==='environment_confirmation_required'));
 await assert.rejects(assessAnswer(f.store,f.question,f.action(),f.environment,f.root),{code:'environment_confirmation_required'});
 assert.equal(f.store.list('model-call').length,0);
 const proof=fixture(t,'post-implementation-proof');
 assert.ok(proof.findings().some(x=>x.code==='implementation_confirmation_required'));
});

test('the real researcher pauses after one proposal and unchanged resume makes no new model call or owner escalation',async t=>{
 const f=fixture(t);
 const first=await f.engine.researcher.run('p',f.draft.id,10);
 assert.equal(first.value.status,'paused');assert.equal(first.value.pauseCode,'environment_confirmation_required');
 assert.equal(first.value.ownerQuestion,null);assert.match(first.value.error!,/required/);
 assert.equal(f.store.list('model-call').length,1);
 const turn=f.store.list<any>('research-turn')[0]!;
 assert.equal(turn.value.status,'pending');assert.equal(turn.value.observation,null);
 assert.match(first.value.error!,/\[required\]/);
 const second=await f.engine.researcher.run('p',f.draft.id,10);
 assert.equal(second.value.pauseCode,'environment_confirmation_required');assert.equal(f.store.list('model-call').length,1);
 assert.equal(f.store.list('research-assessment').length,0);
 assert.equal(f.store.get<Question>(f.question.id)!.value.status,'open');
});

test('a supported assessor result cannot bypass the assigned knowledge kind at storage',t=>{
 const f=fixture(t),bases=resolveResearchBasis(f.store,'p',f.report,f.observations,f.root,f.spec.field).bases;
 const assessment=f.store.write<ResearchAssessment>({id:'manufactured-assessment',kind:'research-assessment',expected:0,value:{projectId:'p',question:reference(f.question),value:f.report as unknown as Json,observations:f.observations,bases,
  verdict:'supported',reasons:[],researcher:'analyst',assessor:'assessor',environment:reference(f.environment)}});
 assert.throws(()=>f.engine.discovery.researched(f.question.id,f.question.revision,reference(assessment)),{code:'research_obligation_evidence_invalid'});
});

test('assessor receives the document claim limit and preserves reported-only evidence after acceptance',async t=>{
 const f=fixture(t,'environment-confirmation',true),assessment=await assessAnswer(f.store,f.question,f.action(),f.environment,f.root);
 const request=JSON.parse(readFileSync(f.wire,'utf8').trim());
 assert.equal(request.subject.question.obligations[0].assignment.documentaryAllowance.claimLimit,f.allowance.claimLimit);
 assert.match(request.prompt,/claimLimit/);
 assert.equal(assessment.value.bases!.find(b=>b.id==='metadata')!.proofLimit,'reported-not-runtime-proof');
 f.engine.discovery.researched(f.question.id,f.question.revision,reference(assessment));
 assert.equal(f.store.get<Question>(f.question.id)!.value.status,'answered');
});

test('allowances reject missing limits, code files and foreign or forged document refs; changed evidence remains stale',async t=>{
 const f=fixture(t,'environment-confirmation',true);
 for(const [index,allowance] of [{sources:[],claimLimit:'metadata'},{sources:[reference(f.file)],claimLimit:'metadata'},
   {sources:[{...reference(f.metadata),hash:'0'.repeat(64)}],claimLimit:'metadata'},{sources:[reference(f.metadata)],claimLimit:' '}].entries()){
  const policy={...f.scope.value.policy!,assignments:[{...f.assignment,documentaryAllowance:allowance}]};
  assert.throws(()=>configureResearchScope(f.store,{...f.scope.value,policy},2),{code:index===0?'obligation_policy_invalid':'obligation_document_allowance_invalid'});
 }
 const foreign=f.engine.discovery.evidence.document('other','foreign','metadata','text/plain',0);
 assert.throws(()=>configureResearchScope(f.store,{...f.scope.value,policy:{...f.scope.value.policy!,assignments:[{...f.assignment,documentaryAllowance:{sources:[reference(foreign)],claimLimit:'metadata'}}]}},2),{code:'obligation_document_allowance_invalid'});
 f.engine.discovery.evidence.document('p','audit-metadata','Different observed metadata','text/plain',1);
 assert.ok(f.findings().some(x=>x.code==='research_basis_invalid'));
 const paused=await f.engine.researcher.run('p',f.draft.id,10);
 assert.equal(paused.value.pauseCode,'obligation_document_source_unavailable');assert.equal(f.store.list('model-call').length,0);
});

test('unassigned knowledge pauses explicitly and recorded old questions retain their former contract',t=>{
 const f=fixture(t);
 const missing={...f.spec,obligations:f.spec.obligations!.map(({assignment,...entry})=>entry)};
 assert.ok(obligationEvidenceFindings(missing,f.report,f.observations).some(x=>x.code==='obligation_assignment_required'));
 const unknown=structuredClone(f.spec);(unknown.obligations![0]!.assignment as any).kind='unknown';
 assert.ok(obligationEvidenceFindings(unknown,f.report,f.observations).some(x=>x.code==='obligation_assignment_required'));
 const {obligationContract,...legacy}=f.spec;
 assert.deepEqual(obligationEvidenceFindings(legacy,f.report,f.observations),[]);
 assert.throws(()=>f.engine.discovery.create('p','om-g2','R2','compilation',[f.spec,{...legacy,field:'second'}],[],2),{code:'research_contract_mismatch'});
 for(const context of [{question:{id:f.question.id,...f.spec}},{questions:[{id:f.question.id,...f.spec}]}]){
  const initial=workingContext(f.store,'p',f.draft.id,f.question.id,context,120000,{common:true});
  const continued=workingContext(f.store,'p',f.draft.id,f.question.id,context,120000,{common:true,continuation:true,previous:initial.working.archive});
  assert.equal((continued.question??continued.questions[0]).obligationContract,'evidence-v1');
 }
});

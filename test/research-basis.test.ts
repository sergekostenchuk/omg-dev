import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Ajv} from 'ajv';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference} from '../src/pipeline/contracts.js';
import {withTypedBasis,resolveResearchBasis} from '../src/graph/research-basis.js';
import {technicalProposalFindings} from '../src/graph/research-evidence.js';
import {TECHNICAL_RESEARCH,type TechnicalReport} from '../src/graph/research-contracts.js';
import {assessAnswer} from '../src/discovery/research-assessment.js';
import {planningForQuestion} from '../src/discovery/research-routing.js';
import {workingContext} from '../src/discovery/working-context.js';
import type {Question} from '../src/discovery/discovery.js';
import type {Graph} from '../src/graph/model.js';
import type {Json} from '../src/canonical.js';
import type {ResearchAssessment,ResearchAction} from '../src/discovery/research-model.js';

function fixture(t:test.TestContext){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'omg-basis-'))),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Typed basis'});
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src','worker.ts'),'export const result = 1;\n');
 const wire=join(root,'wire.json'),adapter=join(root,'assessor.mjs');
 writeFileSync(adapter,`import{readFileSync,writeFileSync}from'node:fs';const raw=readFileSync(0,'utf8');writeFileSync(${JSON.stringify(wire)},raw);const r=JSON.parse(raw);console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{verdict:'supported',reasons:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const command={executable:process.execPath,args:[adapter]};
 const environment=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'assessor',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 const graph={nodes:[{id:'node',code:[],tests:[]}],horizon:[],connectors:[],tests:[]} as unknown as Graph;
 store.write({id:'graph:p',kind:'graph',expected:0,value:graph});
 const spec=withTypedBasis(TECHNICAL_RESEARCH.R2[0]!);
 const draft=engine.discovery.create('p','om-g2','R2','compilation',[spec],[],2);
 const question=store.get<Question>(draft.value.questions[0]!)!;
 const file=engine.discovery.evidence.file('p','code',root,'src/worker.ts','text/plain',0);
 const document=engine.discovery.evidence.document('p','owner','Owner requires recoverable projections. Observed schema version: 7.','text/plain',0);
 const sources=[file,document];
 const observations=sources.map(s=>engine.discovery.evidence.observe('p',reference(s),{kind:'text-range',start:0,end:s.value.content.length}));
 const report:TechnicalReport={applicability:'applicable',reason:'Known inputs for a proposed change',
  facts:[{id:'code',claim:'The file exports result = 1',evidence:{kind:'repository-file',citation:0}}],
  designs:[{id:'design',decision:'Generate recoverable projections',benefit:'Recover generated files',consumer:'compilation'}],gaps:[],
  documents:[{id:'intent',kind:'owner-document',citation:1,quote:'Owner requires recoverable projections.',claim:'The supplied owner intent requires recovery',designs:['design'],gaps:[]},
   {id:'observed',kind:'document-observation',citation:1,quote:'Observed schema version: 7.',claim:'The document reports version 7; no runtime proof',designs:['design'],gaps:[]}]};
 const resolve=(r=report,obs=observations)=>resolveResearchBasis(store,'p',r,obs,root,spec.field);
 const findings=(r=report)=>technicalProposalFindings(store,'p','R2',question.id,spec.field,r,observations,graph,root);
 const action=(r=report):Extract<ResearchAction,{action:'answer'}>=>({action:'answer',question:question.id,value:r as unknown as Json,citations:observations.map(({source,selector})=>({source,selector}))});
 return{root,store,engine,environment,graph,question,draft,report,observations,resolve,findings,action,wire,spec,file,document};
}

test('typed basis binds exact citations to relative code paths and retains different documentary proof limits',t=>{
 const f=fixture(t),resolved=f.resolve();
 assert.deepEqual(resolved.findings,[]);assert.deepEqual(f.findings(),[]);
 assert.deepEqual(resolved.bases[0],{id:'code',kind:'repository-file',source:reference(f.file),selector:f.observations[0]!.selector,repositoryPath:'src/worker.ts',proofLimit:'repository-observation',quote:null,designs:[],gaps:[]});
 assert.equal(resolved.bases[1]!.proofLimit,'quoted-intent-requires-attribution');
 assert.equal(resolved.bases[2]!.proofLimit,'reported-not-runtime-proof');
 assert.equal(resolved.bases[2]!.repositoryPath,null);
 assert.deepEqual(resolved.bases[2]!.source,reference(f.document));
 const gap={id:'future',target:'node',field:'tests',question:'Confirm actual runtime',consumer:'compilation',requiredFor:'current' as const};
 const reported={...f.report,gaps:[gap],documents:[{...f.report.documents![1]!,designs:[],gaps:['future']}]};
 assert.deepEqual(f.resolve(reported).findings,[],'A report may identify an unresolved confirmation');
 assert.ok(f.findings(reported).some(x=>x.code==='research_gap_unresolved'),'Document attachment cannot resolve the current runtime gap');
});

test('documents cannot masquerade as repository files; bad indices, foreign and stale citations fail closed',t=>{
 const f=fixture(t);
 const report=(citation:number)=>({...f.report,facts:[{id:'code',claim:'code fact',evidence:{kind:'repository-file' as const,citation}}]});
 assert.ok(f.resolve(report(1)).findings.some(x=>x.code==='repository_evidence_required'));
 for(const n of [-1,99,0.5])assert.ok(f.resolve(report(n)).findings.some(x=>x.code==='research_basis_invalid'));
 const foreign=f.engine.discovery.evidence.document('other','foreign','foreign','text/plain',0);
 const observation=f.engine.discovery.evidence.observe('other',reference(foreign),{kind:'text-range',start:0,end:7});
 assert.ok(f.resolve(f.report,[observation,...f.observations.slice(1)]).findings.some(x=>x.code==='research_basis_invalid'));
 assert.ok(f.resolve(f.report,[{...f.observations[0]!,source:{...f.observations[0]!.source,hash:'0'.repeat(64)}},f.observations[1]!]).findings.some(x=>x.code==='research_basis_invalid'));
 writeFileSync(join(f.root,'src/worker.ts'),'changed\n');
 assert.ok(f.resolve().findings.some(x=>x.code==='research_basis_invalid'));
});

test('missing fields, invented quotes, factual consumers and duplicate identifiers cannot erase documentary attribution',t=>{
 const f=fixture(t),doc=f.report.documents![0]!;
 const docs=(item:typeof doc)=>({...f.report,documents:[item]});
 const {documents,...missing}=f.report;
 assert.ok(f.resolve(missing).findings.some(x=>x.code==='research_basis_missing'));
 assert.ok(f.resolve(docs({...doc,quote:'The runtime is proven safe'})).findings.some(x=>x.code==='document_quote_invalid'));
 assert.ok(f.resolve(docs({...doc,quote:' '})).findings.some(x=>x.code==='document_quote_invalid'));
 assert.ok(f.resolve(docs({...doc,designs:['code']})).findings.some(x=>x.code==='document_consumer_missing'));
 assert.ok(f.resolve(docs({...doc,designs:[]})).findings.some(x=>x.code==='document_consumer_missing'));
 assert.ok(f.resolve(docs({...doc,id:'code'})).findings.some(x=>x.code==='research_basis_duplicate'));
 assert.ok(f.resolve(docs({...doc,citation:0})).findings.some(x=>x.code==='document_evidence_required'));
 const validate=new Ajv().compile(f.spec.schema as object);
 assert.equal(validate(f.report),true);
 assert.equal(validate({...f.report,facts:[{id:'old',claim:'fact',path:'src/worker.ts'}]}),false);
 assert.equal(validate(missing),false);
 assert.equal(validate(docs({...doc,kind:'runtime-proof' as typeof doc.kind})),false);
});

test('a real file outside this workspace and an unobserved quote remain unavailable bases',t=>{
 const f=fixture(t),outside=realpathSync(mkdtempSync(join(tmpdir(),'omg-basis-outside-')));
 t.after(()=>rmSync(outside,{recursive:true,force:true}));
 writeFileSync(join(outside,'other.ts'),'export const other = 1;');
 const source=f.engine.discovery.evidence.file('p','outside',outside,'other.ts','text/plain',0);
 const observation=f.engine.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:source.value.content.length});
 assert.ok(f.resolve(f.report,[observation,f.observations[1]!]).findings.some(x=>x.code==='research_source_foreign'));
 const short=f.engine.discovery.evidence.observe('p',reference(f.document),{kind:'text-range',start:0,end:5});
 assert.ok(f.resolve(f.report,[f.observations[0]!,short]).findings.some(x=>x.code==='document_quote_invalid'));
 assert.ok(f.resolve(f.report,[{...f.observations[0]!,value:'forged selected bytes'},f.observations[1]!]).findings.some(x=>x.code==='research_basis_invalid'));
});

test('new schema leaves old contracts intact and cannot be stripped to obtain legacy planning',t=>{
 const f=fixture(t);
 assert.equal(TECHNICAL_RESEARCH.R2[0]!.basisContract,undefined);
 const old=new Ajv().compile(TECHNICAL_RESEARCH.R2[0]!.schema as object);
 assert.equal(old({applicability:'applicable',reason:'legacy',facts:[{id:'f',claim:'source',path:'src/worker.ts'}],designs:[],gaps:[]}),true);
 const pilot={value:{planning:{fields:[],maxRequestChars:120000,maxRounds:5}}} as any;
 // Supply the accepted R1 basis required by ordinary routing, without calling a model.
 const r1=f.store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:'p',fields:{technical:{gaps:[]}}}});
 f.store.write({id:'phase:p:R1',kind:'phase',expected:0,value:{draft:reference(r1)}});
 assert.equal(planningForQuestion(f.store,f.draft,f.question,pilot),pilot.value.planning);
 assert.throws(()=>planningForQuestion(f.store,f.draft,{...f.question,value:{...f.question.value,spec:TECHNICAL_RESEARCH.R2[0]!}},pilot),{code:'research_contract_mismatch'});
 assert.throws(()=>f.engine.discovery.create('p','om-g2','R2','compilation',[f.spec,TECHNICAL_RESEARCH.R2[1]!],[],2),{code:'research_contract_mismatch'});
});

test('both singular and question-list continuations retain the typed format marker',t=>{
 const f=fixture(t),q={id:f.question.id,...f.spec};
 for(const context of [{question:q},{questions:[q]}]){
  const initial=workingContext(f.store,'p',f.draft.id,f.question.id,context,120000,{common:true});
  const continued=workingContext(f.store,'p',f.draft.id,f.question.id,context,120000,{common:true,continuation:true,previous:initial.working.archive});
  assert.equal((continued.question??continued.questions[0]).basisContract,'typed-v1');
 }
});

test('real assessment receives resolved bases and accepted storage rejects lost or forged normalization',async t=>{
 const f=fixture(t),assessment=await assessAnswer(f.store,f.question,f.action(),f.environment,f.root);
 const request=JSON.parse(readFileSync(f.wire,'utf8'));
 assert.deepEqual(request.subject.bases,assessment.value.bases!.map(({quote,...binding})=>binding));
 assert.equal(request.subject.bases[2].proofLimit,'reported-not-runtime-proof');
 assert.deepEqual(assessment.value.value,f.report);
 const {bases,...missing}=assessment.value;
 const forged=structuredClone(assessment.value);forged.bases![2]!.proofLimit='repository-observation';
 for(const [index,value] of [missing,{...assessment.value,bases:[]},forged].entries()){
  const bad=f.store.write<ResearchAssessment>({id:`bad-assessment-${index}`,kind:'research-assessment',expected:0,value});
  assert.throws(()=>f.engine.discovery.researched(f.question.id,f.question.revision,reference(bad)),{code:'research_basis_invalid'});
 }
 f.engine.discovery.researched(f.question.id,f.question.revision,reference(assessment));
 assert.deepEqual(f.engine.discovery.observations(f.question.id),f.observations);
 assert.deepEqual(f.store.get<any>(f.draft.id)!.value.fields[f.spec.field],f.report);
 assert.equal(f.store.list('model-call').length,1);
});

test('invalid typed proposal is refused before assessor dispatch and source changes prevent acceptance',async t=>{
 const f=fixture(t);
 const forged={...f.report,facts:[{id:'fake',claim:'Runtime is proven',evidence:{kind:'repository-file' as const,citation:1}}]};
 await assert.rejects(assessAnswer(f.store,f.question,f.action(forged),f.environment,f.root),{code:'research_proposal_invalid'});
 assert.equal(f.store.list('model-call').length,0);
 const assessment=await assessAnswer(f.store,f.question,f.action(),f.environment,f.root);
 writeFileSync(join(f.root,'src/worker.ts'),'changed after assessment\n');
 assert.throws(()=>f.engine.discovery.researched(f.question.id,f.question.revision,reference(assessment)),{code:'research_not_supported'});
 assert.equal(f.store.get<Question>(f.question.id)!.value.status,'open');
});

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, DISCOVERY_CLAIMS_CONTRACT, V7_AXES, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { type Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { readResearchConsumerExecution, prepareResearchConsumerApplication, completeResearchAttemptTurn,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import type { Environment } from '../src/runtime/environment.js';

/**
 * OMG-V7-HELPER, package 1 (P.2–P.5, MR.5): the producer preparation the Discovery v7 tests repeated byte for byte.
 *
 * Everything here only prepares inputs through the real producers. It asserts no outcome of a test, writes no assessor
 * answer, keeps no state between calls and caches nothing: every call builds its own root and its own Stores. What a file
 * does differently stays in the file — `prepare` (the ResearchRun and its consumer intent) and `assess` (the assessor's
 * verdict, novelty and methodology) are local, so the expectations remain readable next to the tests that hold them.
 */

function fixture(t: { after(fn: () => void): void }, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

export const rand = () => Math.random().toString(16).slice(2);
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
/**
 * Frame and plan enter through #answer with a manufactured `supported` assessment (answerDiscoveryFixture): the real
 * Discovery.researched door on a prepared basis, not a live model assessment of the frame or the plan. A paid attempt
 * produced later does not make this initial assessment a real model one.
 */
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

export interface ResearchSetupOptions {
  /** `queue` (default): a source read, then the queued replies, then `reply`; `archive` puts a read of the saved archive first. */
  readonly adapter?: 'queue' | 'archive';
  /** Prefix of the temporary root. */
  readonly prefix?: string;
}
/**
 * The scripted research environment of the v7 tests, in the order every copy used: root and Stores → scenario adapter
 * (`reply.json` and `adapter.mjs`, one command for both roles) → environment → service draft → paid calibration of the
 * analyst and the assessor → the fixture frame and plan. `prepare` and `runId` are the caller's.
 */
export async function researchSetup(t: TestContext, options: ResearchSetupOptions = {}) {
  const f = fixture(t, options.prefix ?? "omg-dr3ba-"), project = 'p', wire = join(f.root,'wire.ndjson'), adapter = join(f.root,'adapter.mjs');
  const archive = options.adapter === 'archive'
    ? `settings.readArchive?{action:'read_context',record:settings.corruptReadArchive?{...r.subject.working.archive,hash:'0'.repeat(64)}:r.subject.working.archive,pointer:'/body/value'}:` : '';
  const settings = join(f.root,'reply.json');
  writeFileSync(settings,JSON.stringify({tokens:10}));
  writeFileSync(adapter, `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const queued=settings.replies?.shift();if(queued)writeFileSync(${JSON.stringify(settings)},JSON.stringify(settings));
const research=${archive}settings.readSource&&!r.subject.contextWorkspace?.length?{action:'read_context',record:r.subject.working.archive,pointer:'/body/value/materials/0/value/content'}:queued??settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
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
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,project,questions,subject,wires,environment,prompt,settings,calibration:{draft:old,question:q}};
}

export const noEnd = () => ({ type:'impossible', code:'source_unavailable', evidence:[], text:'No source' });
export function hypothesis(f: { readonly v: { readonly planAnswer: Ref } }, text: string) {
  return { type:'submitted', contract:DISCOVERY_CLAIMS_CONTRACT, value:{claims:[{id:'h',kind:'hypothesis',text,
    axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
    basis:{howToVerify:'Measure it'}}]} };
}

/** What `produce` needs of a prepared turn; the files' own `prepare` returns more. */
export interface AttemptTurn {
  readonly run: Revision<ResearchRun>;
  readonly number: number;
  readonly intent: Revision<ResearchConsumerIntent>;
  readonly question: Revision<Question>;
  readonly context: Record<string, any>;
  readonly selected: V7PlanSubject;
  invoke(): Promise<unknown>;
}
/** What `produce` needs of a file's setup — not the whole of `researchSetup`'s result. */
export interface AttemptProducer {
  readonly store: Store;
  readonly environment: Revision<Environment>;
  readonly settings: string;
  subject(question?: string): V7PlanSubject;
  prepare(selected?: V7PlanSubject): AttemptTurn;
}
/** One paid, applied and recorded analyst attempt on the file's own `prepare`. */
export async function produce(f: AttemptProducer, end: unknown = noEnd(), question = 'q-industry') {
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
export type Entry = Awaited<ReturnType<typeof produce>>;

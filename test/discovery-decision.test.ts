import { answerDiscoveryCondition } from '../src/discovery/discovery-decision.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { discoveryContext, discoveryOutcome, requireDiscoveryProposal, type DiscoveryConditionDecision } from '../src/discovery/discovery-outcome.js';
import { researchAction } from '../src/discovery/research-protocol.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { preparedField, boundDiscoveryValue } from './preparation-fixture.js';

const ownerCondition = (id: string) => ({ id, kind: 'owner_choice', condition: `Choose ${id}`, criterion: 'Explicit owner choice', options: [
  { optionId: 'accept', label: 'Accept local scope', consequences: ['Reassess the local variant'], choice: 'accept' },
  { optionId: 'decline', label: 'Decline local scope', consequences: ['Reassess feasibility without this condition'], choice: 'decline' },
] });
function fixture(t: {after(fn: () => void): void}, conditions: any[] = [ownerCondition('scope')], outcome = 'conditional') {
  const root = mkdtempSync(join(tmpdir(), 'omg-discovery-choice-')), path = join(root, 'state.sqlite');
  const store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  engine.execute({type: 'create-project', project: 'p', title: 'Local CLI'});
  const source = engine.discovery.evidence.document('p', 'request', 'Local CLI feasibility research fixture', 'text/plain', 0);
  const draft = engine.prepare('p', 'discovery');
  const question = (field: string) => draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
  for (const id of draft.value.questions) {
    const q = store.get<Question>(id)!, field = q.value.spec.field;
    if (field === 'preparation') break;
    if (q.value.spec.kind === 'fact') engine.discovery.fact(q.id, q.revision, reference(source), {kind: 'text-range', start: 0, end: source.value.content.length});
    else if (['researchPlan', 'researchReport', 'verdict'].includes(field)) {
      const value: any = preparedField('p', field);
      if (field === 'verdict') Object.assign(value, {outcome, conditions});
      answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(draft.id)!, q, value, source);
    } else engine.discovery.decision(q.id, q.revision, 'local-owner', preparedField('p', field));
  }
  const verdict = question('verdict').value.answer!;
  const command = (conditionId = 'scope', optionId = 'accept') => ({type: 'answer-decision' as const, mode: 'discovery-condition' as const,
    project: 'p', draft: draft.id, verdictRef: verdict, conditionId, optionId});
  const state = () => discoveryOutcome(store, store.get<DiscoveryDraft>(draft.id)!);
  const answerVerdict = (value: any) => answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(draft.id)!, question('verdict'), value, source);
  return {store, engine, path, draft, question, verdict, command, state, answerVerdict};
}

test('DS1.1 partial choices survive restart; last choice and normal reopen are atomic and replay exactly once', t => {
  const f = fixture(t, [ownerCondition('scope'), ownerCondition('cost'), {id:'proof',kind:'evidence',condition:'Measure throughput',criterion:'Measured bound'}]);
  const original = f.store.get(f.verdict.id, f.verdict.revision), before = f.question('verdict');
  const first = f.engine.execute(f.command()) as Revision<DiscoveryConditionDecision>;
  assert.equal(first.value.actor, 'local-caller'); assert.equal(first.value.optionId, 'accept');
  assert.throws(() => f.engine.execute(f.command('scope', 'decline')), {code: 'discovery_choice_conflict'});
  assert.throws(() => new ProductEngine(f.store, 'another-owner').execute(f.command()), {code: 'discovery_choice_conflict'});
  assert.deepEqual(f.state().ownerChoices.map(c => c.conditionId), ['cost']);
  assert.equal(f.question('verdict').revision, before.revision);
  const reopenedStore = new Store(f.path);
  try {
    const engine = new ProductEngine(reopenedStore);
    assert.deepEqual(engine.execute(f.command()), first);
    const second = engine.execute(f.command('cost', 'decline'));
    assert.deepEqual(engine.execute(f.command('cost', 'decline')), second);
    assert.deepEqual(engine.execute(f.command()), first);
  } finally { reopenedStore.close(); }
  assert.equal(f.question('verdict').revision, before.revision + 1);
  assert.equal(f.question('verdict').value.status, 'open');
  assert.equal(f.state().state, 'researching', 'A choice does not prove feasibility or produce go');
  assert.equal(f.store.list('discovery-condition-decision').length, 2);
  assert.equal(f.store.list('discovery-choice-round').length, 1);
  assert.deepEqual(f.store.get(f.verdict.id, f.verdict.revision), original);
  const context = discoveryContext(f.store, f.store.get<DiscoveryDraft>(f.draft.id)!, f.question('verdict')).context!;
  assert.equal(context.ownerDecisions.length, 1);
  assert.deepEqual(context.ownerDecisions[0]!.decisions.map(d => d.option.choice), ['accept', 'decline']);
  assert.deepEqual(context.ownerDecisions[0]!.verdict.ref, f.verdict);
  assert.ok((context.ownerDecisions[0]!.verdict.value as any).conditions.some((c: any) => c.kind === 'evidence'));
  const next: any = preparedField('p', 'verdict'); next.outcome = 'conditional'; next.conditions = [ownerCondition('scope')];
  f.answerVerdict(next);
  assert.notDeepEqual(f.question('verdict').value.answer, f.verdict);
  assert.deepEqual(f.state().ownerChoices.map(c => c.conditionId), ['scope'], 'Same condition id in a new verdict is a new choice');
  assert.throws(() => f.engine.execute(f.command()), {code: 'discovery_choice_stale'});
});

test('DS1.1 declined choice remains a meaningful input to a new no_go; evidence has no choice command', t => {
  const f = fixture(t);
  f.engine.execute(f.command('scope', 'decline'));
  const next: any = preparedField('p', 'verdict'); next.outcome = 'no_go'; next.reason = 'The owner declined the necessary condition';
  f.answerVerdict(next); assert.equal(f.state().state, 'no_go');
  assert.equal(f.question('preparation').value.status, 'open');
  assert.throws(() => f.engine.prepare('p', 'concept'), {code: 'predecessor_not_ready'});
  const evidence = fixture(t, [{id:'proof',kind:'evidence',condition:'Measure it',criterion:'Observation'}]);
  assert.deepEqual(evidence.state().ownerChoices, []);
  assert.throws(() => evidence.engine.execute(evidence.command('proof')), {code: 'discovery_choice_invalid'});
});

test('DS1.1 invalid option, foreign project, changed report and changed verdict fail at the addressed door without writes', t => {
  const f = fixture(t);
  f.engine.execute({type:'create-project',project:'other',title:'Other'});
  for (const command of [{...f.command(),project:'other'}, f.command('scope','invented'), f.command('absent')]) {
    assert.throws(() => f.engine.execute(command), (error: any) => {
      assert.match(error.code, /^discovery_choice_(foreign|invalid)$/);
      assert.equal(error.details.draft, f.draft.id); assert.deepEqual(error.details.verdictRef, f.verdict); return true;
    });
  }
  assert.equal(f.store.list('discovery-condition-decision').length, 0);
  const report = f.question('researchReport'); f.engine.discovery.reopen(report.id, report.revision);
  assert.throws(() => f.engine.execute(f.command()), (error: any) => {
    assert.equal(error.code, 'discovery_choice_stale'); assert.equal(error.details.draft, f.draft.id); return true;
  });
  assert.equal(f.store.list('discovery-condition-decision').length, 0);
});

test('DS1.1 concurrent legitimate reopen aborts decision and round together; model cannot execute the owner door', t => {
  const f = fixture(t), write = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!raced && writes.some(w => w.kind === 'discovery-condition-decision')) {
      raced = true; const other = new Store(f.path);
      try { const q = other.get<Question>(f.question('researchReport').id)!; new ProductEngine(other).discovery.reopen(q.id, q.revision); }
      finally { other.close(); }
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  assert.throws(() => f.engine.execute(f.command()), (error: any) => /conflict|stale/.test(error.code));
  assert.ok(raced); assert.equal(f.store.list('discovery-condition-decision').length, 0);
  assert.equal(f.store.list('discovery-choice-round').length, 0);
  assert.equal(f.question('verdict').value.status, 'answered');
  assert.throws(() => researchAction({action:'answer-decision',...f.command()}), {code:'research_response_invalid'});
});

for (const kind of ['missing', 'foreign', 'correct']) test(`DS1.2 stage acceptance checks report constraint coverage: ${kind}`, t => {
  const f = fixture(t, [], 'go'), q = f.question('preparation');
  const context = discoveryContext(f.store, f.store.get<DiscoveryDraft>(f.draft.id)!, q).context!;
  const preparation: any = boundDiscoveryValue('preparation', preparedField('p','preparation'), context);
  if (kind === 'missing') preparation.constraints.pop();
  if (kind === 'foreign') {
    const address = JSON.parse(preparation.constraints.at(-1).basis); address.report.hash = '0'.repeat(64);
    preparation.constraints.at(-1).basis = JSON.stringify(address);
  }
  // An ordinary owner answer still exists; the product stage gate applies the same formal rule.
  f.engine.discovery.decision(q.id, q.revision, 'local-owner', preparation);
  const stage = f.engine.draft('p', 'discovery', f.draft.id, 0), inspection = f.engine.pipeline.inspect('p','discovery');
  if (kind === 'correct') { assert.equal(inspection.findings.length, 0); f.engine.pipeline.accept('p','discovery',stage.revision); }
  else {
    assert.ok(inspection.findings.some(x => x.code === `discovery_constraint_${kind === 'foreign' ? 'stale' : 'missing'}`), JSON.stringify(inspection));
    assert.throws(() => f.engine.pipeline.accept('p','discovery',stage.revision));
  }
});

test('DS1.1 missing command address is refused before lookup and before writing a decision', t => {
 const f=fixture(t);
 assert.throws(()=>answerDiscoveryCondition(f.store,f.command(),''),{code:'actor_missing'});
 for(const key of ['project','draft','verdictRef','conditionId','optionId']) {
  const request:any={...f.command()};delete request[key];
  assert.throws(()=>f.engine.execute(request),{code:'command_invalid'});
  assert.throws(()=>answerDiscoveryCondition(f.store,request,'local-owner'),{code:'discovery_choice_invalid'});
 }
 assert.equal(f.store.list('discovery-condition-decision').length,0);
});

for(const variant of ['duplicate-id','no-decline','missing-options']) test(`DS1.1 model owner options ${variant} are refused before assessment`, t => {
 const f=fixture(t),draft=f.store.get<DiscoveryDraft>(f.draft.id)!,q=f.question('verdict');
 const context=discoveryContext(f.store,draft,q).context!,condition:any=ownerCondition('scope');
 if(variant==='duplicate-id')condition.options[1].optionId=condition.options[0].optionId;
 if(variant==='no-decline')condition.options[1].choice='accept';
 if(variant==='missing-options')delete condition.options;
 const value:any=boundDiscoveryValue('verdict',preparedField('p','verdict'),context);
 value.outcome='conditional';value.conditions=[condition];
 assert.throws(()=>requireDiscoveryProposal(draft.value,q,value,context,1),{code:'discovery_research_invalid'});
 assert.equal(f.store.list('discovery-condition-decision').length,0);
});

test('DS1.1 concurrent answers to separate conditions cannot lose the final reopen', t => {
 const f=fixture(t,[ownerCondition('scope'),ownerCondition('cost')]),write=f.store.writeMany.bind(f.store);let raced=false;
 f.store.writeMany=((writes:any[],guards:any[]=[])=>{
  if(!raced&&writes.some(w=>w.kind==='discovery-condition-decision')) {
   raced=true;const other=new Store(f.path);
   try {new ProductEngine(other).execute(f.command('cost'));} finally {other.close();}
  }
  return write(writes,guards);
 }) as typeof f.store.writeMany;
 assert.throws(()=>f.engine.execute(f.command()),(error:any)=>/conflict|stale/.test(error.code));
 assert.equal(f.store.list('discovery-condition-decision').length,1);
 assert.equal(f.question('verdict').value.status,'answered');
 assert.deepEqual(f.state().ownerChoices.map(c=>c.conditionId),['scope']);
 f.engine.execute(f.command());
 assert.equal(f.question('verdict').value.status,'open');
 assert.equal(f.store.list('discovery-condition-decision').length,2);
 assert.equal(f.store.list('discovery-choice-round').length,1);
});

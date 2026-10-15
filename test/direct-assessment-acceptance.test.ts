import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { assessAnswer, directAssessmentBasis } from '../src/discovery/research-assessment.js';
import { reuseResearch } from '../src/discovery/research-reuse.js';
import { readAcceptedResearchAnswer, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { DIRECT_ASSESSMENT_ORIGIN, type ResearchAnswer, type ResearchAssessment } from '../src/discovery/research-model.js';
import { reference, uniqueRefs, type Ref } from '../src/pipeline/contracts.js';
import { preparedField } from './preparation-fixture.js';
import { answerDiscoveryFixture, currentUpstreamFixtureValue } from './product-fixture.js';

/**
 * ASM1.1 (№4791): a direct early-stage assessment is bound to the exact material its assessor saw — the accepted prefix of
 * neighbors is part of its identity — and its direct acceptance guards that prefix in the acceptance transaction itself.
 * A real assessor process (a fixture adapter) records every request; its verdict is read from a control file.
 */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'asm11-')), repo = join(root, 'repo'), file = join(root, 'state.sqlite');
  const wire = join(root, 'wire.ndjson'), control = join(root, 'verdict.json'), adapter = join(root, 'adapter.mjs');
  mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-b', 'main']); writeFileSync(join(repo, 'README.md'), 'AB\n'); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'base']);
  writeFileSync(adapter, `import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(wire)}, JSON.stringify(request) + '\\n');
const research = existsSync(${JSON.stringify(control)}) ? JSON.parse(readFileSync(${JSON.stringify(control)}, 'utf8')) : { verdict: 'supported', reasons: [] };
console.log(JSON.stringify({ protocol: request.protocol, requestId: request.requestId, research }));`);
  let store = new Store(file), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'Direct assessment acceptance' });
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: repo, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const source = engine.discovery.evidence.document('p', 'basis', 'AB', 'text/plain', 0);
  const discovery = engine.prepare('p', 'discovery');
  for (const id of discovery.value.questions) {
    const question = store.get<Question>(id)!;
    if (question.value.spec.kind === 'fact') engine.discovery.fact(id, question.revision, reference(source),
      { kind: 'text-range', start: 0, end: 2 });
    else if (['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(question.value.spec.field))
      answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(discovery.id)!, question,
        preparedField('p', question.value.spec.field), source);
    else engine.discovery.decision(id, question.revision, 'owner', preparedField('p', question.value.spec.field));
  }
  const discoveryArtifact = engine.draft('p', 'discovery', discovery.id, 0);
  const acceptedDiscovery = engine.pipeline.accept('p', 'discovery', discoveryArtifact.revision);
  const draft = engine.prepare('p', 'concept');
  const questions = draft.value.questions.map(id => store.get<Question>(id)!);
  for (const q of questions.slice(0, -1)) engine.discovery.decision(q.id, q.revision, 'owner', preparedField('p', q.value.spec.field));
  const selected = questions.at(-1)!;
  const candidate = { action: 'answer' as const, question: selected.id,
    value: currentUpstreamFixtureValue(engine, 'p', 'conceptSections', preparedField('p', 'conceptSections')),
    citations: [{ source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: 2 } }] };
  const calls = () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').length : 0;
  const delivered = () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line)
    .subject.stageNeighbors.fields.find((row: { field: string }) => row.field === 'audience')?.value) : [];
  const sent = () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, file, repo, environment, source, acceptedDiscovery, draft, questions, selected, candidate, calls, delivered, sent,
    verdict: (value: Json) => writeFileSync(control, JSON.stringify(value)),
    get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(file); engine = new ProductEngine(store); },
    /** A second Store changes the audience neighbor the legal way: reopen, and optionally a new decision. */
    neighbor(value: string | null) {
      const other = new Store(file), otherEngine = new ProductEngine(other);
      try {
        const audience = other.get<Question>(questions[0]!.id)!;
        const opened = otherEngine.discovery.reopen(audience.id, audience.revision);
        if (value !== null) otherEngine.discovery.decision(opened.id, opened.revision, 'owner', value);
      } finally { other.close(); }
    },
    assess() { return assessAnswer(store, store.get<Question>(selected.id)!, candidate, store.get(environment.id)! as never, repo); },
    accept(assessment: Revision<ResearchAssessment>) {
      const q = store.get<Question>(selected.id)!;
      return engine.discovery.researched(q.id, q.revision, reference(assessment));
    } };
}
type Fixture = ReturnType<typeof fixture>;
const snapshot = (store: Store) => canonical(store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) })));
function refused(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => error instanceof EngineError && error.code === code, code);
}
function unchanged(f: Fixture, before: { draft: Revision<DiscoveryDraft>; selected: Revision<Question>; answers: number }) {
  assert.deepEqual(reference(f.store.get<DiscoveryDraft>(f.draft.id)!), reference(before.draft), 'The draft is unchanged');
  assert.deepEqual(reference(f.store.get<Question>(f.selected.id)!), reference(before.selected), 'The selected question is unchanged');
  assert.equal(f.store.get<Question>(f.selected.id)!.value.status, 'open');
  assert.equal(f.store.list('research-answer').length, before.answers, 'No research answer is written');
}
const state = (f: Fixture) => ({ draft: f.store.get<DiscoveryDraft>(f.draft.id)!, selected: f.store.get<Question>(f.selected.id)!,
  answers: f.store.list('research-answer').length });

test('ASM1.1 №4791 a new direct assessment names its exact completed assessor session and application; the common reader re-derives it and returns the prefix it saw', async t => {
  const f = fixture(t), assessment = await f.assess();
  assert.equal(assessment.value.verdict, 'supported');
  assert.equal(assessment.value.origin?.contract, DIRECT_ASSESSMENT_ORIGIN);
  const neighbors = f.questions.slice(0, -1).map(q => f.store.get<Question>(q.id)!);
  const shown = f.sent()[0].subject;
  assert.deepEqual(shown.stageNeighbors.fields.map((row: { question: Ref; answer: Ref }) =>
    [row.question, row.answer]), neighbors.map(q => [reference(q), q.value.answer!]));
  assert.deepEqual(shown.discoveryBasisCatalogue.source, reference(f.acceptedDiscovery));
  const discovery = shown.discoveryContext;
  const basis = uniqueRefs([shown.discoveryBasisCatalogue.source,
    ...shown.stageNeighbors.fields.flatMap((row: { question: Ref; answer: Ref }) => [row.question, row.answer]),
    ...(discovery ? Object.values(discovery.fields).flatMap((row: any): Ref[] => [row.question, row.answer]) : []),
    ...(discovery ? discovery.ownerDecisions.flatMap((round: any): Ref[] => round.decisions.map((decision: any) => decision.ref)) : [])]);
  assert.deepEqual(directAssessmentBasis(f.store, assessment)!.map(ref => canonical(ref)).sort(),
    basis.map(ref => canonical(ref)).sort(), 'Every exact Discovery and neighbor reference the assessor saw');
  f.restart();
  assert.deepEqual(directAssessmentBasis(f.store, f.store.get<ResearchAssessment>(assessment.id)!), directAssessmentBasis(f.store, assessment));
});

test('ASM1.1 №4791 regression 1: a ready supported assessment is refused after a legal reopen and decision of a neighbor — the question and draft stay unchanged', async t => {
  const f = fixture(t), assessment = await f.assess();
  f.neighbor('Changed audience');
  const before = state(f), snap = snapshot(f.store);
  refused(() => f.accept(assessment), 'research_assessment_basis_stale');
  unchanged(f, before); assert.equal(snapshot(f.store), snap, 'Nothing is written');
  assert.equal(f.calls(), 1);
});

test('ASM1.1 №4791 regression 1: a pure reopen of a neighbor — no new draft revision — is detected and refuses the old assessment', async t => {
  const f = fixture(t), assessment = await f.assess();
  const draftBefore = reference(f.store.get<DiscoveryDraft>(f.draft.id)!);
  f.neighbor(null);
  assert.deepEqual(reference(f.store.get<DiscoveryDraft>(f.draft.id)!), draftBefore, 'A pure reopen leaves the draft revision as it was');
  const before = state(f), snap = snapshot(f.store);
  refused(() => f.accept(assessment), 'research_assessment_basis_stale');
  unchanged(f, before); assert.equal(snapshot(f.store), snap);
});

test('ASM1.1 №4791 regression 2 (window №4784): a neighbor reopened between the check and the acceptance writeMany refuses the whole transaction', async t => {
  const f = fixture(t), assessment = await f.assess();
  const before = state(f), store = f.store, writeMany = store.writeMany.bind(store);
  let injected = false;
  store.writeMany = ((writes, guards) => {
    if (!injected && writes.some(write => write.kind === 'research-answer')) { injected = true; f.neighbor('Changed audience'); }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  try { refused(() => f.accept(assessment), 'input_stale'); } finally { store.writeMany = writeMany; }
  assert.equal(injected, true, 'The neighbor changed inside the window');
  assert.deepEqual(reference(f.store.get<Question>(f.selected.id)!), reference(before.selected));
  assert.equal(f.store.list('research-answer').length, before.answers, 'No part of the acceptance is written');
  assert.equal(f.store.get<DiscoveryDraft>(f.draft.id)!.value.fields.conceptSections, before.draft.value.fields.conceptSections);
});

test('ASM1.1 №4791 regression 3: two real supported results with the same candidate and reasons on different prefixes are different assessments; the old one is never returned for the new prefix', async t => {
  const f = fixture(t), first = await f.assess();
  f.neighbor('Changed audience');
  const second = await f.assess();
  assert.deepEqual([first.value.verdict, second.value.verdict], ['supported', 'supported']);
  assert.deepEqual([first.value.reasons, second.value.reasons], [[], []]);
  assert.equal(canonical(first.value.value), canonical(second.value.value), 'The same candidate');
  assert.notEqual(first.id, second.id, 'A different prefix is a different assessment');
  assert.notDeepEqual(first.value.origin, second.value.origin);
  assert.deepEqual(f.delivered(), ['audience for p', 'Changed audience'], 'Each assessor saw its own prefix');
  refused(() => f.accept(first), 'research_assessment_basis_stale');
  f.accept(second);
  assert.equal(f.store.get<Question>(f.selected.id)!.value.status, 'answered');
});

test('ASM1.1 №4791 regression 4: the current basis gets a new assessment that is accepted; an unchanged basis after a restart returns the same assessment without a call', async t => {
  const f = fixture(t), first = await f.assess();
  f.restart();
  const again = await f.assess();
  assert.equal(again.id, first.id); assert.equal(f.calls(), 1, 'No second call on the same basis');
  f.neighbor('Changed audience');
  const current = await f.assess();
  assert.equal(f.calls(), 2);
  const accepted = f.accept(current);
  const answer = f.store.get<Question>(f.selected.id)!.value.answer!;
  assert.equal(accepted.value.fields.conceptSections !== undefined, true);
  assert.deepEqual(f.store.get<ResearchAnswer>(answer.id)!.value.assessment, reference(current));
});

test('ASM1.1 №4791 regression 5: an accepted bound answer reads by its own era — a later neighbor change does not reinterpret it; an assessment without origin keeps the earlier reading', async t => {
  const f = fixture(t), assessment = await f.assess();
  f.accept(assessment);
  const answer = f.store.get<Question>(f.selected.id)!.value.answer!;
  f.neighbor('Changed audience');
  f.restart();
  const read = readAcceptedResearchAnswer(f.store, 'p', answer);
  assert.deepEqual(reference(read.assessment!), reference(assessment), 'The historical acceptance reads without today\'s neighbors');
  const { origin: _origin, ...earlier } = assessment.value;
  assert.equal(directAssessmentBasis(f.store, { ...assessment, value: earlier }), null, 'An assessment of the earlier contract has no material basis');
});

test('ASM1.1 №4791 regression 6: a bound direct result is not a reuse candidate for another draft; the ordinary assessment of the new question stays available', async t => {
  const f = fixture(t), assessment = await f.assess();
  f.accept(assessment);
  const next = f.engine.discovery.forStage('p', 'concept', 'operation-map', [reference(f.acceptedDiscovery)]);
  const nextQuestions = next.value.questions.map(id => f.store.get<Question>(id)!);
  for (const q of nextQuestions.slice(0, -1)) f.engine.discovery.decision(q.id, q.revision, 'owner', preparedField('p', q.value.spec.field));
  const target = f.store.get<Question>(nextQuestions.at(-1)!.id)!;
  assert.equal(reuseResearch(f.store, f.engine.discovery, f.store.get<DiscoveryDraft>(next.id)!, reference(f.environment)), 0,
    'The bound result proves nothing for the other prefix');
  assert.equal(f.store.get<Question>(target.id)!.value.status, 'open');
  assert.ok(f.store.list<ResearchAssessment>('research-assessment').every(row => row.value.reusedFrom === undefined), 'No rebound record');
  const ordinary = await assessAnswer(f.store, target, { ...f.candidate, question: target.id }, f.store.get(f.environment.id)! as never, f.repo);
  assert.equal(ordinary.value.verdict, 'supported');
  assert.notEqual(ordinary.id, assessment.id);
  refused(() => f.engine.discovery.researched(target.id, target.revision, reference(assessment)), 'research_not_supported');
  f.engine.discovery.researched(target.id, target.revision, reference(ordinary));
  assert.equal(f.store.get<Question>(target.id)!.value.status, 'answered');
});

test('ASM1.1 №4791 §3 п.3: an open pending neighbor the assessor saw is part of the basis — answering it after the assessment refuses the old one', async t => {
  const f = fixture(t);
  const audience = f.store.get<Question>(f.questions[0]!.id)!;
  const opened = f.engine.discovery.reopen(audience.id, audience.revision);
  const assessment = await f.assess();
  assert.ok(directAssessmentBasis(f.store, assessment)!.some(ref => canonical(ref) === canonical(reference(opened))), 'The pending neighbor is guarded');
  f.engine.discovery.decision(opened.id, opened.revision, 'owner', 'Changed audience');
  const before = state(f);
  refused(() => f.accept(assessment), 'research_assessment_basis_stale');
  unchanged(f, before);
});

test('ASM1.1 №4791 (same class): a direct Discovery v5 assessment is bound to its Discovery grounds — a legal change of the objective refuses the old assessment', async t => {
  const f = fixture(t);
  const draft = f.engine.discovery.forStage('p', 'discovery', 'concept');
  const [brief, objective, plan] = draft.value.questions.map(id => f.store.get<Question>(id)!);
  f.engine.discovery.fact(brief!.id, brief!.revision, reference(f.source), { kind: 'text-range', start: 0, end: 2 });
  f.engine.discovery.decision(objective!.id, objective!.revision, 'owner', 'Deliver p outcome');
  const candidate = { action: 'answer' as const, question: plan!.id, value: preparedField('p', 'researchPlan'),
    citations: [{ source: reference(f.source), selector: { kind: 'text-range' as const, start: 0, end: 2 } }] };
  const assessment = await assessAnswer(f.store, f.store.get<Question>(plan!.id)!, candidate, f.store.get(f.environment.id)! as never, f.repo);
  assert.equal(assessment.value.origin?.contract, DIRECT_ASSESSMENT_ORIGIN);
  const goal = f.store.get<Question>(objective!.id)!;
  assert.ok(directAssessmentBasis(f.store, assessment)!.some(ref => canonical(ref) === canonical(reference(goal))), 'The objective is a guarded ground');
  const reopened = f.engine.discovery.reopen(goal.id, goal.revision);
  f.engine.discovery.decision(reopened.id, reopened.revision, 'owner', 'Deliver another outcome');
  const current = f.store.get<Question>(plan!.id)!;
  refused(() => f.engine.discovery.researched(current.id, current.revision, reference(assessment)), 'research_assessment_basis_stale');
  assert.equal(f.store.get<Question>(plan!.id)!.value.status, 'open');
});

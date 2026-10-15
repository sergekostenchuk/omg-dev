import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { answerDiscoveryCondition } from '../src/discovery/discovery-decision.js';
import { ProductEngine } from '../src/product/engine.js';
import { DiscoveryChoiceSessions, issueDiscoveryChoiceInvitation } from '../src/product/owner-authority.js';
import { RESEARCH_CONTRACT_VERSION, VERSION5_REQUIREMENTS } from '../src/discovery/requirements.js';
import { Store } from '../src/storage/store.js';
import { preparedField } from './preparation-fixture.js';

const ADAPTER = `import {readFileSync,appendFileSync} from 'node:fs';
import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js', import.meta.url).href)};
const request=JSON.parse(readFileSync(0,'utf8')),subject=request.subject,values=JSON.parse(readFileSync(process.argv[2],'utf8'));
appendFileSync(process.argv[3],JSON.stringify({role:subject.role,field:subject.questions?.[0]?.field,era:subject.discoveryContext?.contractVersion})+'\\n');
let research;
if(subject.role==='assess-answer') research={verdict:'supported',reasons:[]};
else {
 const question=subject.questions[0],inventory=subject.inventory?.sources??subject.originals?.sources??[];
 const sources=Array.isArray(inventory)?inventory:inventory.rows.map(row=>Object.fromEntries(inventory.columns.map((key,index)=>[key,row[index]])));
 const source=sources.find(row=>row.location==='values');
 const value=boundDiscoveryValue(question.field,structuredClone(values[question.field]),subject.discoveryContext);
 if(question.field==='verdict'&&subject.discoveryContext?.ownerDecisions?.length) {
   value.outcome='go';value.conditions=[];value.reason='The owner selected the supported local condition';
 }
 research={action:'answer',question:question.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+question.field}}]};
}
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));`;

function fixture(t: test.TestContext, project: string, outcome: 'go' | 'no_go' | 'conditional' | 'insufficient_evidence') {
  const root = mkdtempSync(join(tmpdir(), 'omg-ds12-v6-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project, title: project });
  const values = Object.fromEntries(VERSION5_REQUIREMENTS.discovery.map(spec => [spec.field, preparedField(project, spec.field)]));
  const verdict = values['verdict'] as Record<string, unknown>;
  verdict['outcome'] = outcome;
  verdict['reason'] = outcome === 'go' ? 'The local design can be implemented' : 'The researched variant needs an explicit disposition';
  verdict['conditions'] = outcome === 'conditional' ? [{
    id: 'local-scope', kind: 'owner_choice', condition: 'Keep the result local',
    criterion: 'A new supported verdict reflects the selected condition',
    options: [{ optionId: 'local', label: 'Use local scope', choice: 'accept',
      consequences: ['Reassess the supported variant'] },
    { optionId: 'decline', label: 'Decline this scope', choice: 'decline',
      consequences: ['Research another variant'] }],
  }] : [];
  const valuesPath = join(root, 'values.json'), log = join(root, 'calls.jsonl'), adapter = join(root, 'adapter.mjs');
  writeFileSync(valuesPath, JSON.stringify(values)); writeFileSync(adapter, ADAPTER);
  engine.discovery.evidence.document(project, 'values', JSON.stringify(values), 'application/json', 0);
  const command = { executable: process.execPath, args: [adapter, valuesPath, log] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'medium', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 10_000 }, 0);
  return { root, database, store, engine, log };
}

for (const outcome of ['go', 'no_go', 'conditional', 'insufficient_evidence'] as const) {
  test(`DS1.2v public v6 Discovery persists ${outcome} without inventing preparation`, async t => {
    const f = fixture(t, outcome, outcome);
    const draft = f.engine.prepare(outcome, 'discovery');
    assert.equal(RESEARCH_CONTRACT_VERSION, 6);
    assert.equal(draft.value.contractVersion, 6);
    const result = await f.engine.stageResearch.run(outcome, draft.id, 10);
    assert.equal(result.discovery?.state, outcome, JSON.stringify(result));
    assert.equal(result.status, outcome === 'go' ? 'accepted' : outcome === 'conditional' ? 'needs_owner' : 'paused');
    const opened = new Store(f.database);
    try {
      const calls = opened.list('model-call').length;
      const repeated = await new ProductEngine(opened).stageResearch.run(outcome, draft.id, 1);
      assert.equal(repeated.discovery?.state, outcome);
      assert.equal(opened.list('model-call').length, calls, 'A saved outcome does not pay again');
    } finally { opened.close(); }
    if (outcome === 'conditional') {
      const choice = result.discovery!.ownerChoices[0]!;
      const request = { project: outcome, draft: draft.id, verdictRef: choice.verdictRef,
        reportRef: result.discovery!.report!, conditionId: choice.conditionId, optionId: 'local' };
      const sessions = new DiscoveryChoiceSessions(f.store);
      const issued = issueDiscoveryChoiceInvitation(f.store, request);
      assert.equal(issued.ok, true, JSON.stringify(issued));
      if (!issued.ok) return;
      const exchanged = sessions.exchange({ project: outcome, invitation: issued.value.invitation });
      assert.equal(exchanged.ok, true, JSON.stringify(exchanged));
      if (!exchanged.ok) return;
      try {
        answerDiscoveryCondition(f.store, request, sessions.authority(exchanged.value.bearer));
      } finally { sessions.revoke(exchanged.value.bearer); }
      const after = new Store(f.database);
      try {
        const revised = await new ProductEngine(after).stageResearch.run(outcome, draft.id, 4);
        assert.equal(revised.discovery?.state, 'go', JSON.stringify(revised));
        assert.equal(revised.status, 'accepted');
      } finally { after.close(); }
    }
  });
}

test('DS1.2v direct research-draft of saved v5 cannot dispatch fresh work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-ds12-direct-v5-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store), project = 'old-direct';
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project, title: project });
  const draft = engine.discovery.create(project, 'discovery', 'R0', 'concept', VERSION5_REQUIREMENTS.discovery, [], 5);
  const marker = join(root, 'dispatched'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'sent');process.exit(1);`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'medium', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 10_000 }, 0);
  await assert.rejects(async () => engine.execute({ type: 'research-draft', project, draftId: draft.id, maxTurns: 1 }),
    { code: 'research_contract_upgrade_required' });
  assert.equal(existsSync(marker), false);
  assert.equal(store.list('model-call').length, 0);
  const paused = await engine.stageResearch.run(project, draft.id, 1);
  assert.equal(paused.reason?.code, 'research_contract_upgrade_required');
  assert.equal(existsSync(marker), false);
});

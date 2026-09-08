import type test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { preparedFeatures } from './product-fixture.js';
import { configureReaderPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { pilotContext } from '../src/discovery/pilot-context.js';
import { readResearchContext } from '../src/discovery/research-limits.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { synthesisSession } from '../src/discovery/synthesis-session.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import { checkpoint } from '../src/discovery/research-continuation.js';
import type { SynthesisNote } from '../src/discovery/conclusion-consolidation.js';
import { reference } from '../src/pipeline/contracts.js';
import type { Question } from '../src/discovery/discovery.js';
import type { Json } from '../src/canonical.js';

export async function fixture(t: test.TestContext, noteChars = 18000, limit = 100000, share = 0.35, consolidationTextChars = 0) {
  const root = mkdtempSync(join(tmpdir(), 'omg-consolidation-')), store = new Store(join(root, 'db.sqlite')), engine = new ProductEngine(store, 'codex');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); preparedFeatures(engine, 'p');
  const path = join(root, 'fixture.mjs'), log = join(root, 'wire.ndjson');
  writeFileSync(path, `import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject,consolidationTextChars=${consolidationTextChars};
appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
const research=c.dispatchMode==='consolidation'?{action:'checkpoint',question:c.question.id,value:{summaries:c.consolidation.notes.map((n,i)=>({notes:[i],text:'Finding '+i+' retains its exception and unresolved condition'})),citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['New conflict remains open']}:{action:'pause',reason:'Fixture stops after the next actual material packet'};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:c.dispatchMode==='consolidation'?{...research,value:{...research.value,summaries:research.value.summaries.map((summary,i)=>({...summary,text:summary.text+(consolidationTextChars?' '+'x'.repeat(consolidationTextChars+i):'')}))}}:research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [path] };
  const environment = engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: limit, maxContinuationChars: limit, conclusionShare: share,
    maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 20, maxReportedTokens: 100000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  const material = readResearchContext(store, draft, question.id, pilot, reference(store.get('graph-layer:p:1')!), '/projection/title');
  const context: Record<string, any> = { ...pilotContext(store, draft, question), workingSelections: [{ kind: 'context', value: material }] };
  const dispatch = pilotEnvironment(environment.value, pilot.value);
  const invoke = () => synthesisSession(store, draft, question, environment, dispatch, pilot, context, 'Return the declared research action');
  await previewResearch(invoke);
  // Establish a real delivered analyst packet, so consolidation uses its ordinary
  // continuation calibration and accounting, not a synthetic special purpose.
  await researchCall(dispatch.implementer, dispatch, 'Pause', context, undefined,
    { store, draftId: draft.id, questionId: question.id, purpose: 'analyst', pilot });
  const source = engine.discovery.evidence.document('p', 'basis', 'A precise source condition', 'text/plain', 0);
  const citation = { source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: source.value.content.length } };
  const notes: SynthesisNote[] = [0, 1, 2].map(i => {
    const proposal = { action: 'checkpoint' as const, question: question.id, value: { finding: String(i).repeat(noteChars), exception: 'condition-' + i },
      citations: [citation], unresolved: ['Keep unresolved-' + i] };
    const saved = checkpoint(store, draft, question, { ...proposal, value: proposal as unknown as Json });
    return { checkpoint: reference(saved), proposal, page: { offset: 0, end: 0 } };
  });
  const session = store.list<any>('synthesis-session')[0]!;
  const before = store.write<any>({ id: session.id, kind: session.kind, expected: session.revision,
    value: { ...session.value, materialOffset: 5, notes } });
  const wires = () => readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  return { root, store, engine, draft, question, pilot, context, invoke, notes, before, wires, path, material };
}


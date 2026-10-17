import type test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { preparedFeatures } from './product-fixture.js';
import { configureReaderPilot, pilotEnvironment, type ReaderPilotSettings } from '../src/discovery/reader-pilot.js';
import { pilotContext } from '../src/discovery/pilot-context.js';
import { readResearchContext } from '../src/discovery/research-limits.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { synthesisSession } from '../src/discovery/synthesis-session.js';
import type { SynthesisNote } from '../src/discovery/conclusion-consolidation.js';
import { reference } from '../src/pipeline/contracts.js';
import type { Question } from '../src/discovery/discovery.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { EngineError } from '../src/errors.js';
import { withInvocationAllowance } from '../src/discovery/invocation-progress.js';

/** The shared synthesis/consolidation fixture of the v2 era (№1555 X29): the
 * session state is produced exclusively by real paid producers — three exact
 * checkpoint steps across one small and one deliberately large material (the
 * fragment cursor is earned by real pagination, never hand-written), then one
 * pause step that parks the session for the measured entry. The setup spend is
 * reported separately (`setupCalls`); tests measure the operation under review
 * relative to it. */
export async function fixture(t: test.TestContext, noteChars = 18000, limit = 100000, share = 0.35, consolidationTextChars = 0, settings: Partial<ReaderPilotSettings> = {}, requestPadding = 0,
  layout: 'paged' | 'small' = 'paged', setupPaidCalls = 3) {
  const root = mkdtempSync(join(tmpdir(), 'omg-consolidation-')), store = new Store(join(root, 'db.sqlite')), engine = new ProductEngine(store, 'codex');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); preparedFeatures(engine, 'p');
  const path = join(root, 'fixture.mjs'), log = join(root, 'wire.ndjson'), stepsFile = join(root, 'steps');
  const source = engine.discovery.evidence.document('p', 'basis', 'A precise source condition', 'text/plain', 0);
  const citation = { source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: source.value.content.length } };
  writeFileSync(path, `import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject,consolidationTextChars=${consolidationTextChars},stepsFile=${JSON.stringify(stepsFile)},citation=${JSON.stringify(citation)},noteChars=${noteChars};
appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
const step=existsSync(stepsFile)?+readFileSync(stepsFile,'utf8'):0;
const research=c.dispatchMode==='consolidation'?{action:'checkpoint',question:c.question.id,value:{summaries:c.consolidation.notes.map((n,i)=>({notes:[i],text:'Finding '+i+' retains its exception and unresolved condition'})),citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['New conflict remains open']}:c.dispatchMode==='synthesis'&&step<3?{action:'checkpoint',question:c.question.id,value:{finding:String(step).repeat(noteChars),exception:'condition-'+step},citations:[citation],unresolved:['Keep unresolved-'+step]}:{action:'pause',reason:'Fixture stops after the next actual material packet'};
if(c.dispatchMode==='synthesis'&&step<3)writeFileSync(stepsFile,String(step+1));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:c.dispatchMode==='consolidation'?{...research,value:{...research.value,summaries:research.value.summaries.map((summary,i)=>({...summary,text:summary.text+(consolidationTextChars?' '+'x'.repeat(consolidationTextChars+i):'')}))}}:research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [path] };
  const environment = engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 30000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: limit, maxContinuationChars: limit, conclusionShare: share,
    maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 20, maxReportedTokens: 100000, ...settings }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  const small = readResearchContext(store, draft, question.id, pilot, reference(store.get('graph-layer:p:1')!), '/projection/title');
  // The large material earns a genuine fragment cursor: its first pages cannot
  // fit beside the mandatory packet, so materialOffset is produced, not written.
  // The 'small' layout instead takes four small materials — cheap and final-stage
  // friendly — for checks that never exercise pagination.
  // The 'small' layout instead takes four modest materials — one per page at
  // any used limit — cheap and final-stage friendly, for checks that never
  // exercise pagination.
  const workingSelections = layout === 'small'
    ? [0, 1, 2, 3].map(i => {
      const document = engine.discovery.evidence.document('p', `synthesis-material-${i}`,
        `Material condition ${i} with its exception. ` + 'detail '.repeat(Math.max(1, Math.floor(limit * 0.55 / 7))), 'text/plain', 0);
      return { kind: 'context', value: engine.discovery.evidence.observe('p', reference(document),
        { kind: 'text-range' as const, start: 0, end: document.value.content.length }) };
    })
    : [{ kind: 'context', value: small }, { kind: 'context', value: (() => {
      const bigText = 'A material condition with an exception and an unresolved detail.\n'.repeat(5000);
      writeFileSync(join(root, 'material.txt'), bigText);
      const bigSource = engine.discovery.evidence.file('p', 'synthesis-material', root, 'material.txt', 'text/plain', 0);
      return engine.discovery.evidence.observe('p', reference(bigSource),
        { kind: 'text-range', start: 0, end: bigSource.value.content.length });
    })() }];
  const material = workingSelections[1]!.value;
  const context: Record<string, any> = { ...pilotContext(store, draft, question), workingSelections };
  const dispatch = pilotEnvironment(environment.value, pilot.value);
  const invoke = () => synthesisSession(store, draft, question, environment, dispatch, pilot, context, 'Return the declared research action');
  // Establish a real delivered analyst packet, so consolidation uses its ordinary
  // continuation calibration and accounting, not a synthetic special purpose.
  await researchCall(dispatch.implementer, dispatch, 'Pause', context, undefined,
    { store, draftId: draft.id, questionId: question.id, purpose: 'analyst', pilot });
  if (noteChars >= 40000) {
    // Stop the large-note case at the real fourth-call boundary, before
    // paying for consolidation; the former transport refusal is gone.
    try {
      await withInvocationAllowance(setupPaidCalls, invoke);
      throw new Error('synthesis-session-fixture: setup did not reach the fourth-call boundary');
    } catch (error) {
      if (!(error instanceof EngineError && error.code === 'research_call_allowance')) throw error;
    }
  } else {
    const stopped = await invoke();
    if (stopped.action !== 'pause') throw new Error(`synthesis-session-fixture: setup ended with ${stopped.action}, not the produced pause`);
  }
  const before = store.get<any>(store.list<any>('synthesis-session')[0]!.id)!;
  if (!before.id.startsWith('synthesis-session:v2:') || before.value.contract !== 'synthesis-session/v2'
    || before.value.notes.length !== (noteChars >= 40000 ? setupPaidCalls : 3))
    throw new Error('synthesis-session-fixture: expected a v2 session with produced checkpoint notes');
  // The measured operation's transport pressure is applied after the basis was
  // produced; the padding is not part of the session basis.
  if (requestPadding) context.request = { immutableCondition: 'x'.repeat(requestPadding) };
  const notes: SynthesisNote[] = before.value.notes;
  const setupCalls = store.list<ModelCall>('model-call').length;
  const wires = () => readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  return { root, store, engine, draft, question, pilot, environment, context, dispatch, invoke, notes, before, wires, path, material, setupCalls, citation };
}

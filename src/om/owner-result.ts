import { hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { readRecord, writeGuarded } from './refs.js';
import type { readOmInput } from './input.js';
import type { readRoutes, RoutesRecord } from './routes.js';
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import type { GapRecord } from './gaps.js';
import { OWNER_RESULT_ACTION, requireOwnerAuthority, readOwnerSession, readOwnerSessionGrant,
  type OwnerSession, type OwnerSessionGrant } from '../product/owner-authority.js';

/**
 * H2.0 (№2719): the om-owner-result producer and its common reader. The producer is reachable only through an opaque
 * OwnerAuthority of src/product/owner-authority.ts — never through ProductEngine.execute, an actor string, an
 * `owner:true` field or a bare record hash. It binds one exact om-owner-question/v1 — the B1 input Ref, the D1 gap
 * record Ref, the M6 routes Ref and the route line identity — to the normalized decision value and basis, writes the
 * owner-command/v1 receipt and the om-owner-result/v1 record in ONE guarded transaction (guards: the live session
 * revision and the exact B1/D1/M6 heads), and is idempotent: a byte-identical repeat returns the prior result without
 * writes, even under a new session. The common reader re-derives the whole chain — result ← command → session → grant
 * and the question from its bound B1/D1/M6 records — so reading is never weaker than writing (урок 45), and logout or
 * session expiry after the write never retroactively invalidates a persisted result.
 */
export const OWNER_RESULT_KIND = 'om-owner-result';
export const OWNER_RESULT_CONTRACT = 'om-owner-result/v1';
export const OWNER_COMMAND_KIND = 'owner-command';
export const OWNER_COMMAND_CONTRACT = 'owner-command/v1';
export const OWNER_QUESTION_CONTRACT = 'om-owner-question/v1';
export const ownerResultNamespace = (project: string): string => `om-owner-result:${project}:`;
export const ownerCommandPrefix = (project: string): string => `owner-command:${project}:`;

export const OWNER_RESULT_REFUSAL_CODES = Object.freeze([
  'owner_request_invalid', 'owner_question_invalid', 'owner_command_invalid', 'owner_result_invalid',
] as const);
export type OwnerResultRefusalCode = typeof OWNER_RESULT_REFUSAL_CODES[number];

/** The route-line identity of the answered gap inside the bound M6 routes record. */
export interface OwnerQuestionRoute { gap: string; target: string; field: string }
/** The exact B1 question the owner answers — id, wording, consumer, owner-decision kind, moment and blocking flag. */
export interface OwnerQuestionDetail {
  id: string; text: string; consumer: string; kind: 'owner-decision'; moment: string; blocks: boolean;
}
/**
 * om-owner-question/v1 (договор №2719-3): the question contract of the owner route — {project, question, gap Ref (D1),
 * input Ref (B1), routes Ref (M6), route {gap, target, field}}. It is embedded in the command receipt, not stored.
 */
export interface OwnerQuestion {
  contract: typeof OWNER_QUESTION_CONTRACT; project: string; question: OwnerQuestionDetail;
  gap: Ref; input: Ref; routes: Ref; route: OwnerQuestionRoute;
}
/** owner-command/v1: the receipt — command identity, the exact live session revision, question, value and basis. */
export interface OwnerCommand {
  contract: typeof OWNER_COMMAND_CONTRACT; database: string; project: string; action: typeof OWNER_RESULT_ACTION;
  session: Ref; address: string; question: OwnerQuestion; value: Json; basis: string;
}
/** om-owner-result/v1: the answer — its exact receipt Ref, the question address, normalized value and basis. */
export interface OwnerResult {
  contract: typeof OWNER_RESULT_CONTRACT; project: string; command: Ref; question: string; value: Json; basis: string;
}
export interface OwnerDecisionRequest { project: string; routes: Ref; gap: Ref; value: Json; basis: string }
export interface OwnerDecisionOutcome {
  command: Revision<OwnerCommand>; result: Revision<OwnerResult>; repeated: boolean;
}
/** What the common reader proves: the result, its receipt, the re-derived question, and the session→grant chain. */
export interface OwnerResultView {
  record: Revision<OwnerResult>; command: Revision<OwnerCommand>; question: OwnerQuestion;
  session: Revision<OwnerSession>; grant: Revision<OwnerSessionGrant>;
}
/** One owner question the UI may list: the re-derived v1 question, its address and the result that answered it. */
export interface OwnerQuestionItem { question: OwnerQuestion; address: string; answered: Ref | null }
/**
 * The exact readers this producer shares with the gate — handed in, never imported, so this module stays off the OM
 * import ring it would otherwise join (the ring is a ratchet, import-ring.test.ts).
 */
export interface OwnerReaders { routes: typeof readRoutes; input: typeof readOmInput }

class OwnerResultFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function deny(code: OwnerResultRefusalCode, target: string, field: string, message: string, ref?: Ref): never {
  const result = refused(code, message, { unit: 'H2', target, field, ref }, 'owner');
  if (!result.ok) throw new OwnerResultFailure(result.refusal);
  throw new EngineError('owner_result_internal', 'Refusal unexpectedly produced a value');
}
function take<T>(result: OmResult<T>): T {
  if (!result.ok) throw new OwnerResultFailure(result.refusal);
  return result.value;
}
function run<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof OwnerResultFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
const shape = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const same = (a: unknown, b: unknown): boolean => hashJson(a) === hashJson(b);
const exactRef = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
/** The deterministic result address of one exact command Ref — one result per receipt, forever. */
export function ownerResultId(project: string, command: Ref): string {
  return `${ownerResultNamespace(project)}${hashJson(exactRef(command))}`;
}
/** The deterministic question address (om-owner-question:<project>:<hash>) of one v1 question object. */
export function ownerQuestionAddress(question: OwnerQuestion): string {
  return `om-owner-question:${question.project}:${hashJson(question)}`;
}
/** The command identity — the normalized command WITHOUT the session: a repeat under a new session reuses it. */
export function ownerCommandId(command: OwnerCommand): string {
  const { session: _session, ...identity } = command;
  return `${ownerCommandPrefix(command.project)}${hashJson(identity)}`;
}

/** The internal shape proof of one embedded om-owner-question/v1 object. */
function provenQuestion(value: unknown, project: string): OwnerQuestion {
  const question = value as OwnerQuestion;
  if (!shape(value) || value.contract !== OWNER_QUESTION_CONTRACT || value.project !== project
    || !shape(value.question) || !isText(value.question.id) || !isText(value.question.text)
    || !isText(value.question.consumer) || value.question.kind !== 'owner-decision' || !isText(value.question.moment)
    || typeof value.question.blocks !== 'boolean' || !isRef(value.gap) || !isRef(value.input) || !isRef(value.routes)
    || !shape(value.route) || !isText(value.route.gap) || !isText(value.route.target) || !isText(value.route.field)
    || Object.keys(value).some(key => !['contract', 'project', 'question', 'gap', 'input', 'routes', 'route'].includes(key))
    || Object.keys(value.question).some(key => !['id', 'text', 'consumer', 'kind', 'moment', 'blocks'].includes(key))
    || Object.keys(value.route).some(key => !['gap', 'target', 'field'].includes(key)))
    deny('owner_question_invalid', 'question', 'contract', 'An owner question keeps its complete v1 provenance');
  return question;
}
/**
 * The one derivation shared by writer and reader: from the exact M6 routes Ref and D1 gap record Ref, prove the
 * owner-routed owner-decision line, then build the om-owner-question/v1 out of the exact B1 input's own question row.
 * Nothing of the caller's phrasing enters — text, consumer, moment and blocks come from the bound records alone.
 */
function deriveOwnerQuestion(store: Store, readers: OwnerReaders, project: string, routesRef: Ref, gapRef: Ref): OwnerQuestion {
  const routes = take(readers.routes(store, { project, record: routesRef }));
  const gap = take(readRecord<GapRecord>(store, gapRef,
    { unit: 'H2', target: gapRef.id, idPrefix: `om-gap:${project}:`, kind: 'gap' }));
  // OWN1 (№3713): in the bypass M6 routes an owner question of the pass to the model (design); the owner's own explicit
  // answer of that very question stays admitted. The kind checks below keep it an owner-decision line.
  const line = routes.record.value.routes.find(item => (item.route === 'owner' || item.route === 'design') && same(item.record, exactRef(gapRef)));
  const body = gap.value.gap;
  if (!line || !shape(body) || line.gap !== body.id || line.target !== body.target || line.field !== body.field
    || line.kind !== 'owner-decision' || body.kind !== 'owner-decision' || !isRef(line.input))
    deny('owner_question_invalid', gapRef.id, 'route',
      'An owner answer needs the exact owner-routed owner-decision gap of this M6 route');
  const input = take(readers.input(store, project, line.input));
  const source = input.value.input.questions.find(item => item.id === line.target);
  if (!shape(source) || source.id !== line.target || !isText(source.question) || !isText(source.consumer)
    || source.kind !== 'owner-decision' || typeof source.blocks !== 'boolean')
    deny('owner_question_invalid', gapRef.id, 'question',
      'The answered gap must keep its owner-decision question in the exact B1 input');
  const question: OwnerQuestion = { contract: OWNER_QUESTION_CONTRACT, project,
    question: { id: source.id, text: source.question, consumer: source.consumer, kind: 'owner-decision',
      moment: source.moment ?? line.moment, blocks: source.blocks },
    gap: exactRef(reference(gap)), input: exactRef(line.input), routes: exactRef(routesRef),
    route: { gap: line.gap, target: line.target, field: line.field } };
  return question;
}

/** The internal shape proof of one owner-command receipt record. */
function provenCommand(record: Revision<OwnerCommand>, project: string): Revision<OwnerCommand> {
  const value = record.value;
  if (!shape(value) || value.contract !== OWNER_COMMAND_CONTRACT || value.project !== project
    || !isText(value.database) || value.action !== OWNER_RESULT_ACTION || !isRef(value.session)
    || !isText(value.address) || !shape(value.question) || !isText(value.basis)
    || !Object.hasOwn(value, 'value')
    || Object.keys(value).some(key => !['contract', 'database', 'project', 'action', 'session', 'address',
      'question', 'value', 'basis'].includes(key)))
    deny('owner_command_invalid', record.id, 'contract', 'An owner command keeps its complete v1 provenance');
  provenQuestion(value.question, project);
  if (value.address !== ownerQuestionAddress(value.question as OwnerQuestion))
    deny('owner_command_invalid', record.id, 'address', 'The receipt address must be the hash of its exact question');
  if (record.id !== ownerCommandId(value))
    deny('owner_command_invalid', record.id, 'id', 'The receipt id must be the hash of its normalized command');
  return record;
}
/** The internal shape proof of one om-owner-result record. */
function provenResult(record: Revision<OwnerResult>, project: string): Revision<OwnerResult> {
  const value = record.value;
  if (!shape(value) || value.contract !== OWNER_RESULT_CONTRACT || value.project !== project
    || !isRef(value.command) || !value.command.id.startsWith(ownerCommandPrefix(project))
    || !isText(value.question) || typeof value.basis !== 'string' || !Object.hasOwn(value, 'value')
    || Object.keys(value).some(key => !['contract', 'project', 'command', 'question', 'value', 'basis'].includes(key)))
    deny('owner_result_invalid', record.id, 'contract', 'An owner result keeps its complete v1 provenance');
  return record;
}

/**
 * The separately authenticated producer (H2.0). Authority is checked twice — before anything is prepared and again
 * immediately before the guarded commit — and the session's exact revision is one of the transaction guards, so a
 * revocation racing the commit is refused by the store, never by an unchecked window. The exact repeat of an already
 * answered command returns the prior result without writes; different content under an occupied identity is refused.
 */
export function writeOwnerResult(store: Store, authority: unknown, request: unknown,
  readers: OwnerReaders): OmResult<Sealed<OwnerDecisionOutcome>> {
  return run(() => {
    if (!(store instanceof Store))
      throw new EngineError('owner_request_invalid', 'The owner-result producer needs a Store');
    requireDecisionRequest(request);
    const decision = request;
    let value: Json;
    try { value = sealed(decision.value) as Json; }
    catch { deny('owner_request_invalid', decision.project, 'value', 'The decision value must be finite acyclic JSON'); }
    // Check 1: the opaque authority must be live before any preparation read is spent on it.
    take(requireOwnerAuthority(authority, { store, project: decision.project, action: OWNER_RESULT_ACTION }));
    const question = deriveOwnerQuestion(store, readers, decision.project, decision.routes, decision.gap);
    const identity: Omit<OwnerCommand, 'session'> = { contract: OWNER_COMMAND_CONTRACT, database: store.databaseId,
      project: decision.project, action: OWNER_RESULT_ACTION, address: ownerQuestionAddress(question), question,
      value, basis: decision.basis };
    const commandId = `owner-command:${decision.project}:${hashJson(identity)}`;
    const existing = store.get<OwnerCommand>(commandId);
    if (existing) {
      const prior = provenCommand(existing, decision.project);
      const priorResultId = ownerResultId(decision.project, reference(prior));
      const saved = store.get<OwnerResult>(priorResultId);
      if (!saved) deny('owner_result_invalid', priorResultId, 'command',
        'The receipt exists without the result its atomic write required');
      const view = take(readOwnerResult(store, { project: decision.project, record: reference(saved) }, readers));
      return { command: prior, result: view.record as Revision<OwnerResult>, repeated: true };
    }
    // Check 2: re-verify immediately before commit — the receipt pins the live session revision at apply time.
    const applied = take(requireOwnerAuthority(authority, { store, project: decision.project, action: OWNER_RESULT_ACTION }));
    const command: OwnerCommand = { ...identity, session: applied.session };
    const commandRef: Ref = { id: commandId, revision: 1, hash: hashJson(command) };
    const result: OwnerResult = { contract: OWNER_RESULT_CONTRACT, project: decision.project, command: commandRef,
      question: identity.address, value, basis: decision.basis };
    const writes: Write[] = [{ id: commandId, kind: OWNER_COMMAND_KIND, expected: 0, value: command },
      { id: ownerResultId(decision.project, commandRef), kind: OWNER_RESULT_KIND, expected: 0, value: result }];
    take(writeGuarded(store, { unit: 'H2', target: writes[1]!.id, writes,
      guards: [applied.session, question.gap, question.routes, question.input] }));
    const commandRecord: Revision<OwnerCommand> = { id: commandId, kind: OWNER_COMMAND_KIND, revision: 1,
      hash: hashJson(command), value: command };
    const resultRecord: Revision<OwnerResult> = { id: writes[1]!.id, kind: OWNER_RESULT_KIND, revision: 1,
      hash: hashJson(result), value: result };
    return { command: commandRecord, result: resultRecord, repeated: false };
  });
}
function requireDecisionRequest(request: unknown): asserts request is OwnerDecisionRequest {
  if (!shape(request) || !isText(request.project) || !isRef(request.routes) || !isRef(request.gap)
    || !Object.hasOwn(request, 'value') || !isText(request.basis)
    || Object.keys(request).some(key => !['project', 'routes', 'gap', 'value', 'basis'].includes(key)))
    deny('owner_request_invalid', 'owner-result', 'request',
      'An owner decision names its project, exact M6 routes Ref, exact D1 gap Ref, value and basis');
}

/**
 * The common reader — the G4b gate and the audit path share it. It re-derives the result from the receipt and the
 * bound records: result ← owner-command → owner-session → owner-session-grant, and the question from its exact
 * B1/D1/M6 sources via the writer's own deriveOwnerQuestion (чтение не слабее записи). Session liveness is not a
 * condition of the read: a persisted result is history and survives logout, expiry and server restart.
 */
export function readOwnerResult(store: Store, request: unknown,
  readers: OwnerReaders): OmResult<Sealed<OwnerResultView>> {
  return run(() => {
    if (!(store instanceof Store) || !shape(request) || !isText(request.project) || !isRef(request.record)
      || Object.keys(request).some(key => !['project', 'record'].includes(key)))
      deny('owner_request_invalid', 'owner-result', 'request', 'An owner result is read by project and exact Ref');
    const project = request.project as string;
    const record = take(readRecord<OwnerResult>(store, request.record,
      { unit: 'H2', target: request.record.id, idPrefix: ownerResultNamespace(project), kind: OWNER_RESULT_KIND })) as Revision<OwnerResult>;
    const body = provenResult(record, project);
    const command = provenCommand(take(readRecord<OwnerCommand>(store, body.value.command,
      { unit: 'H2', target: body.value.command.id, id: body.value.command.id, kind: OWNER_COMMAND_KIND })) as Revision<OwnerCommand>, project);
    const receipt = command.value;
    if (receipt.database !== store.databaseId)
      deny('owner_result_invalid', record.id, 'database', 'The receipt belongs to another database');
    if (!same(receipt.value, body.value.value) || receipt.basis !== body.value.basis
      || receipt.address !== body.value.question)
      deny('owner_result_invalid', record.id, 'command', 'The result must restate its receipt, exactly');
    const session = take(readOwnerSession(store, receipt.session));
    if (session.value.database !== receipt.database || session.value.project !== project
      || session.value.action !== receipt.action)
      deny('owner_result_invalid', record.id, 'session', 'The receipt session breaks the project/action/database chain');
    const grant = take(readOwnerSessionGrant(store, session.value.grant));
    if (grant.value.database !== receipt.database || grant.value.project !== project
      || grant.value.action !== receipt.action)
      deny('owner_result_invalid', record.id, 'grant', 'The receipt grant breaks the project/action/database chain');
    const derived = deriveOwnerQuestion(store, readers, project, receipt.question.routes, receipt.question.gap);
    if (!same(derived, receipt.question))
      deny('owner_result_invalid', record.id, 'question',
        'The receipt question does not rederive from its exact B1/D1/M6 sources');
    if (record.id !== ownerResultId(project, reference(command)))
      deny('owner_result_invalid', record.id, 'id', 'The result does not live at its receipt-derived identity');
    return { record, command, question: receipt.question, session, grant };
  });
}

/**
 * The projection feed for the owner UI (договор №2719-7: om-state names the wait, the projection names the question).
 * Lists every owner-decision gap (owner-routed, or routed to the model by the OWN1 bypass) of every current om-routes
 * head of the project, re-derived through the same path the producer and the gate use, with the exact Ref of the result
 * that already answered it (if any).
 * Reading is not authority — this endpoint proves nothing and grants nothing.
 */
export function listOwnerQuestions(store: Store, project: string,
  readers: OwnerReaders): OmResult<Sealed<OwnerQuestionItem[]>> {
  return run(() => {
    if (!(store instanceof Store) || !isText(project))
      deny('owner_request_invalid', 'owner-questions', 'project', 'Owner questions are listed for one named project');
    const answered = store.list<OwnerResult>(OWNER_RESULT_KIND)
      .filter(record => record.id.startsWith(ownerResultNamespace(project)))
      .map(record => readOwnerResult(store, { project, record: reference(record) }, readers))
      .filter((view): view is { readonly ok: true; readonly value: Sealed<OwnerResultView> } => view.ok);
    const items: OwnerQuestionItem[] = [];
    for (const head of store.list<RoutesRecord>('route-result')) {
      if (!head.id.startsWith(`om-routes:${project}:`)) continue;
      const routes = readers.routes(store, { project, record: reference(head) });
      if (!routes.ok) continue;
      const routesRef = reference(routes.value.record);
      for (const line of routes.value.record.value.routes) {
        // OWN1: an owner question the bypass routes to the model is still the owner's to answer explicitly.
        if (line.route !== 'owner' && !(line.route === 'design' && line.kind === 'owner-decision')) continue;
        try {
          const question = deriveOwnerQuestion(store, readers, project, exactRef(routesRef), line.record);
          const hit = answered.find(view => same(view.value.question.gap, question.gap)
            && same(view.value.question.routes, question.routes));
          items.push({ question, address: ownerQuestionAddress(question),
            answered: hit ? exactRef(reference(hit.value.record)) : null });
        } catch (error) {
          if (!(error instanceof OwnerResultFailure)) throw error;
          // A route whose gap or input no longer rederives lists nothing — the gate reports it instead.
        }
      }
    }
    return items;
  });
}

/**
 * OWN1 (№3719 P2-1): the owner's proved answers of the questions of one exact M6 route over one exact B1 — the same scan
 * and proof G4b admits them by. The owner's answer is above the model's: a question it answers is never sent to the
 * model, and its value is what the consumers get.
 */
export interface OwnerAnswer { gap: Ref; target: string; field: string; result: Ref; value: Json }
/** A B1 question row as far as the owner's question names it (OWN1.1). */
export interface HeldQuestion { id: string; question: string; consumer: string; kind: unknown }
export function ownerAnswersOf(store: Store, project: string, routes: Ref, input: Ref, readers: OwnerReaders): OwnerAnswer[] {
  const answers: OwnerAnswer[] = [];
  for (const head of store.list<OwnerResult>(OWNER_RESULT_KIND)) {
    if (!head.id.startsWith(ownerResultNamespace(project))) continue;
    const proved = readOwnerResult(store, { project, record: exactRef(head) }, readers);
    if (!proved.ok) continue;
    const question = proved.value.question;
    if (!same(question.routes, routes) || !same(question.input, input)) continue;
    answers.push({ gap: exactRef(question.gap), target: question.route.target, field: question.route.field,
      result: exactRef(head), value: proved.value.record.value.value as unknown as Json });
  }
  return answers;
}

/**
 * OWN1.1 (№3722): the owner's proved answers that still answer a question of the current B1. A result is proved by its
 * own era (the exact B1/D1/M6 it was given on); it still applies after the bases moved for other reasons when the very
 * question it answers — the same id, wording, consumer and kind — is still held open. One owner answer of a question
 * applies; two different answers of one question apply none of them (the owner decides between them, never the engine).
 */
export function ownerAnswersHeld(store: Store, project: string, held: readonly HeldQuestion[], readers: OwnerReaders): {
  applicable: OwnerAnswer[]; answered: Set<string>;
} {
  const byQuestion = new Map<string, OwnerAnswer[]>();
  for (const head of store.list<OwnerResult>(OWNER_RESULT_KIND)) {
    if (!head.id.startsWith(ownerResultNamespace(project))) continue;
    const proved = readOwnerResult(store, { project, record: exactRef(head) }, readers);
    if (!proved.ok) continue;
    const question = proved.value.question, detail = question.question;
    const row = held.find(item => item.id === detail.id);
    if (!row || row.question !== detail.text || row.consumer !== detail.consumer || row.kind !== detail.kind
      || question.route.target !== detail.id || question.route.field !== 'answer') continue;
    const answers = byQuestion.get(detail.id) ?? [];
    answers.push({ gap: exactRef(question.gap), target: detail.id, field: 'answer', result: exactRef(head),
      value: proved.value.record.value.value as unknown as Json });
    byQuestion.set(detail.id, answers);
  }
  const applicable: OwnerAnswer[] = [];
  for (const answers of byQuestion.values())
    if (answers.every(answer => same(answer.value, answers[0]!.value)))
      applicable.push([...answers].sort((a, b) => a.result.id < b.result.id ? -1 : a.result.id > b.result.id ? 1 : 0)[0]!);
  return { applicable: applicable.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0), answered: new Set(byQuestion.keys()) };
}

import { provePlanQuestions } from "./v7-plan-questions.js";
import type { ResearchAssessment } from './research-model.js';
import { Ajv } from 'ajv';
import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import type { BasisCatalogueEntry } from './basis-application.js';
import type { Store, Revision } from '../storage/store.js';
import { reference, uniqueRefs, isRef, type Ref, type Finding, type GateResult } from '../pipeline/contracts.js';
import { Discovery, type DiscoveryDraft, type Question, type AcceptedPrefixSnapshot } from './discovery.js';
import { DISCOVERY_RESEARCH_FIELDS } from './preparation-contracts.js';
import { DISCOVERY_CHOICE_ACTION, OWNER_GRANT_LIFETIME_MS, OWNER_SESSION_LIFETIME_MS,
  readDiscoveryChoiceSession, readDiscoveryChoiceSessionGrant,
  type DiscoveryChoiceScope, type DiscoveryChoiceSession, type DiscoveryChoiceSessionGrant } from '../product/owner-authority.js';

const fields = ['brief', 'objective', 'researchPlan', 'researchReport', 'verdict', 'preparation'] as const;
type Field = typeof fields[number];
type OutcomeGate = GateResult & { prefix?: AcceptedPrefixSnapshot };
export type DiscoveryVerdict = 'go' | 'conditional' | 'no_go' | 'insufficient_evidence';
export interface AcceptedField { question: Ref; answer: Ref; value: Json }
export interface DiscoveryContext {
  contract: 'discovery-research-context/v1';
  fields: Partial<Record<Field, AcceptedField>>;
  reportConstraints: { basis: string; rule: string }[];
  ownerDecisions: ChoiceHistory[];
}
export interface DiscoveryOutcome {
  state: 'legacy' | 'researching' | 'go' | 'conditional' | 'no_go' | 'insufficient_evidence';
  verdict: Ref | null; report: Ref | null; conditions: Json[]; reason: string | null;
  ownerChoices: DiscoveryChoice[]; guards: Ref[]; findings: Finding[];
}
export interface DiscoveryChoiceOption { optionId: string; label: string; consequences: string[]; choice: 'accept' | 'decline' }
export interface DiscoveryChoice {
  project: string; draft: string; verdictRef: Ref; conditionId: string; condition: string; criterion: string;
  options: DiscoveryChoiceOption[];
}
export interface DiscoveryConditionDecisionV1 {
  contract: 'discovery-condition-decision/v1'; projectId: string; draftId: string; verdictRef: Ref;
  conditionId: string; optionId: string; actor: string;
}
export interface DiscoveryConditionDecisionV2 {
  contract: 'discovery-condition-decision/v2'; database: string; projectId: string; draftId: string;
  verdictRef: Ref; reportRef: Ref; conditionId: string; optionId: string; actor: string; session: Ref;
}
export type DiscoveryConditionDecision = DiscoveryConditionDecisionV1 | DiscoveryConditionDecisionV2;
export interface DiscoveryConditionDecisionView {
  record: Revision<DiscoveryConditionDecision>; option: DiscoveryChoiceOption;
  authority: 'historical-caller' | 'local-owner-authority';
  session: Revision<DiscoveryChoiceSession> | null; grant: Revision<DiscoveryChoiceSessionGrant> | null;
}
export interface DiscoveryChoiceRound {
  contract: 'discovery-choice-round/v1'; projectId: string; draftId: string; verdictRef: Ref; reportRef: Ref;
  question: Ref; reopened: Ref; decisions: Ref[];
}
export interface ChoiceHistory {
  round: Ref; verdict: { ref: Ref; value: Json }; report: Ref;
  decisions: { ref: Ref; value: DiscoveryConditionDecision; option: DiscoveryChoiceOption }[];
}
export const discoveryDecisionId = (project: string, draft: string, verdict: Ref, condition: string) =>
  `discovery-condition-decision:${hashJson([project, draft, verdict, condition])}`;
export const discoveryChoiceRoundId = (project: string, draft: string, verdict: Ref) =>
  `discovery-choice-round:${hashJson([project, draft, verdict])}`;

function choiceError(code: string, target: string, message: string): never {
  throw new EngineError(code, `[${target}] ${message}`);
}

/**
 * The one exact reader shared by current outcome, historical context, producer replay and stage-summary. V1 retains
 * its historical caller semantics. V2 proves the saved open session revision and its scoped grant; current liveness
 * is deliberately irrelevant after the choice was committed.
 */
export function readDiscoveryConditionDecision(store: Store, request: {
  project: string; draft: string; verdictRef: Ref; reportRef: Ref; conditionId: string; record?: Ref;
}): DiscoveryConditionDecisionView {
  const id = discoveryDecisionId(request.project, request.draft, request.verdictRef, request.conditionId);
  const verdict = store.get<{ projectId: string; question: string; value: {
    outcome: string; researchReport: Ref; conditions: { id: string; kind: string; options?: DiscoveryChoiceOption[] }[];
  }}>(request.verdictRef.id, request.verdictRef.revision);
  if (!verdict || !same(reference(verdict), request.verdictRef) || verdict.kind !== 'research-answer'
    || verdict.value.projectId !== request.project || verdict.value.value.outcome !== 'conditional'
    || !same(verdict.value.value.researchReport, request.reportRef))
    return choiceError('discovery_choice_invalid', id, 'The saved choice needs its exact conditional verdict and report');
  const condition = verdict.value.value.conditions.find(item => item.id === request.conditionId);
  if (!condition || condition.kind !== 'owner_choice' || !Array.isArray(condition.options))
    return choiceError('discovery_choice_invalid', id, 'The saved choice must address an offered owner condition');
  const found = request.record ? store.get<DiscoveryConditionDecision>(request.record.id, request.record.revision)
    : store.get<DiscoveryConditionDecision>(id);
  if (!found || found.id !== id || found.kind !== 'discovery-condition-decision' || found.revision !== 1
    || request.record && !same(reference(found), request.record))
    return choiceError('discovery_choice_invalid', id, 'The exact saved Discovery choice is missing');
  const value = found.value;
  if (!object(value) || value.projectId !== request.project || value.draftId !== request.draft
    || !isRef(value.verdictRef) || !same(value.verdictRef, request.verdictRef) || value.conditionId !== request.conditionId
    || typeof value.optionId !== 'string' || typeof value.actor !== 'string' || value.actor.trim().length === 0)
    return choiceError('discovery_choice_invalid', id, 'The saved Discovery choice is foreign or malformed');
  const option = condition.options.find(item => item.optionId === value.optionId);
  if (!option) return choiceError('discovery_choice_invalid', id, 'The saved Discovery choice names no offered option');
  if (value.contract === 'discovery-condition-decision/v1') {
    if (Object.keys(value).some(key => !['contract', 'projectId', 'draftId', 'verdictRef', 'conditionId', 'optionId', 'actor'].includes(key)))
      return choiceError('discovery_choice_invalid', id, 'The historical v1 choice has unexpected authority fields');
    return { record: found, option, authority: 'historical-caller', session: null, grant: null };
  }
  if (value.contract !== 'discovery-condition-decision/v2' || value.database !== store.databaseId
    || value.actor !== 'local-owner'
    || !isRef(value.reportRef) || !same(value.reportRef, request.reportRef) || !isRef(value.session)
    || Object.keys(value).some(key => !['contract', 'database', 'projectId', 'draftId', 'verdictRef', 'reportRef',
      'conditionId', 'optionId', 'actor', 'session'].includes(key)))
    return choiceError('discovery_choice_invalid', id, 'The v2 choice lost its database, report or session proof');
  const sessionResult = readDiscoveryChoiceSession(store, value.session);
  if (!sessionResult.ok) throw new EngineError(sessionResult.refusal.code, sessionResult.refusal.message, sessionResult.refusal.at);
  const session = sessionResult.value;
  const grantResult = readDiscoveryChoiceSessionGrant(store, session.value.grant);
  if (!grantResult.ok) throw new EngineError(grantResult.refusal.code, grantResult.refusal.message, grantResult.refusal.at);
  const grant = grantResult.value;
  const scope: DiscoveryChoiceScope = { project: request.project, draft: request.draft,
    verdictRef: request.verdictRef, reportRef: request.reportRef, conditionId: request.conditionId,
    optionId: value.optionId };
  if (session.value.state !== 'open' || session.value.database !== value.database
    || session.value.action !== DISCOVERY_CHOICE_ACTION || !same(session.value.scope, scope)
    || grant.value.database !== value.database || grant.value.action !== DISCOVERY_CHOICE_ACTION
    || !same(grant.value.scope, scope) || !same(session.value.grant, reference(grant))
    || grant.value.expiresAt !== grant.value.issuedAt + OWNER_GRANT_LIFETIME_MS
    || session.value.openedAt < grant.value.issuedAt || session.value.openedAt >= grant.value.expiresAt
    || session.value.expiresAt !== session.value.openedAt + OWNER_SESSION_LIFETIME_MS)
    return choiceError('discovery_choice_invalid', id, 'The v2 choice breaks its saved session and grant scope');
  return { record: found, option, authority: 'local-owner-authority', session, grant };
}

/** Only choices whose normal reopen belongs to this question's history are delivered.
 * The exact old verdict stays visible; matching condition ids never transfer a choice. */
function choiceHistory(store: Store, draft: Revision<DiscoveryDraft>): { values: ChoiceHistory[]; guards: Ref[] } {
  const q = draft.value.questions.map(id => store.get<Question>(id)).find(row => row?.value.spec.field === 'verdict');
  if (!q) return { values: [], guards: [] };
  const values: ChoiceHistory[] = [], guards: Ref[] = [reference(q)];
  // Exact revision reads also work in the paid assessor's captured read view.
  for (let revision = 1; revision < q.revision; revision++) {
    const row = store.get<Question>(q.id, revision);
    requireCondition(row, 'discovery_research_invalid', `[${q.id}] The choice history lost revision ${revision}`);
    if (!row.value.answer) continue;
    const round = store.get<DiscoveryChoiceRound>(discoveryChoiceRoundId(draft.value.projectId, draft.id, row.value.answer));
    if (!round || round.value.reopened.revision > q.revision) continue;
    const verdict = store.get<{value: Json}>(round.value.verdictRef.id, round.value.verdictRef.revision)!;
    const decisions = round.value.decisions.map(ref => {
      const saved = store.get<DiscoveryConditionDecision>(ref.id, ref.revision);
      requireCondition(saved, 'discovery_choice_invalid', `[${ref.id}] The choice round lost a decision`);
      const proved = readDiscoveryConditionDecision(store, { project: draft.value.projectId, draft: draft.id,
        verdictRef: round.value.verdictRef, reportRef: round.value.reportRef,
        conditionId: saved.value.conditionId, record: ref });
      guards.push(reference(proved.record));
      return { ref: reference(proved.record), value: proved.record.value, option: proved.option };
    });
    guards.push(reference(round), reference(verdict), round.value.reportRef);
    values.push({ round: reference(round), verdict: { ref: reference(verdict), value: verdict.value.value },
      report: round.value.reportRef, decisions });
  }
  return { values, guards };
}

export function discoveryConstraintBindings(selected: DiscoveryContext['fields']): {basis: string; rule: string}[] {
  const report = selected.researchReport;
  return report ? ((report.value as any).constraints as string[]).map((rule, index) =>
    ({ basis: canonical({ report: report.answer, pointer: `/constraints/${index}` }), rule })) : [];
}
export interface DiscoveryBasisCatalogue {
  contract: 'discovery-basis-catalogue/v1';
  source: Ref;
  constraints: BasisCatalogueEntry[];
  variant: BasisCatalogueEntry;
}

/** The caller proves this exact accepted stage. Projection never follows current questions or heads,
 * and the original report basis stays on its constraint instead of becoming a second obligation. */
export function discoveryBasisCatalogue(source: { ref: Ref; fields: Record<string, Json> }): DiscoveryBasisCatalogue {
  const fail = (field: string, pointer: string, message: string): never => {
    throw new EngineError('discovery_basis_catalogue_invalid', message,
      { target: typeof source?.ref?.id === 'string' ? source.ref.id : 'discovery', field, pointer });
  };
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!source || !isRef(source.ref) || !source.ref.id.startsWith('stage:') || !source.ref.id.endsWith(':discovery'))
    return fail('source', '', 'The catalogue requires an exact Discovery stage reference');
  if (!record(source.fields)) return fail('fields', '/content/fields', 'The catalogue requires explicit accepted fields');
  const preparation = source.fields.preparation, verdict = source.fields.verdict;
  if (!record(preparation) || !Array.isArray(preparation.constraints))
    return fail('preparation', '/content/fields/preparation/constraints', 'The accepted constraints must be explicit, including an empty list');
  if (!record(verdict) || verdict.outcome !== 'go' || !text(verdict.variant))
    return fail('verdict', '/content/fields/verdict/variant', 'The catalogue requires the accepted go variant');
  const ref = { id: source.ref.id, revision: source.ref.revision, hash: source.ref.hash };
  const constraints = preparation.constraints.map((value: unknown, index: number): BasisCatalogueEntry => {
    const pointer = `/content/fields/preparation/constraints/${index}`;
    if (!record(value) || !text(value.id) || !text(value.rule) || !text(value.basis))
      return fail('preparation', pointer, 'Each accepted constraint retains its explicit id, rule and original basis');
    return { address: { record: ref, pointer }, value: JSON.parse(canonical(value)) as Json };
  });
  return structuredClone({ contract: 'discovery-basis-catalogue/v1', source: ref, constraints,
    variant: { address: { record: ref, pointer: '/content/fields/verdict/variant' }, value: verdict.variant } });
}

function requirePreparation(value: Json, selected: DiscoveryContext['fields'], questionId: string): void {
  requireCondition((selected.verdict?.value as any)?.outcome === 'go', 'discovery_go_required',
    `[${questionId}] Preparation requires the new accepted go verdict`);
  const expected = discoveryConstraintBindings(selected), constraints = (value as any)?.constraints;
  requireCondition(Array.isArray(constraints), 'discovery_constraint_missing', `[${questionId}] Preparation needs its constraints`);
  for (const item of constraints) {
    let address: any;
    try { address = JSON.parse(item.basis); } catch { continue; }
    if (!address || typeof address !== 'object' || !Object.hasOwn(address, 'report')) continue;
    requireCondition(expected.some(row => row.basis === item.basis), 'discovery_constraint_stale',
      `[${questionId}] Constraint ${item.id} must name an exact current report constraint: ${item.basis}`);
  }
  for (const row of expected) requireCondition(constraints.some(item => item.basis === row.basis),
    'discovery_constraint_missing', `[${questionId}] Missing report constraint ${row.basis}`);
}

const schema = new Ajv({ strict: true, allowUnionTypes: true });
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && canonical(a) === canonical(b);
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
const researchSchemas = new Map(DISCOVERY_RESEARCH_FIELDS.map(spec => [spec.field, schema.compile(spec.schema as object)]));
const questionSchemas = new Map<string, ReturnType<typeof schema.compile>>();
function questionSchema(value: Json) {
  const key = canonical(value);
  let validator = questionSchemas.get(key);
  if (!validator) {
    validator = new Ajv({ strict: true, allowUnionTypes: true }).compile(value as object);
    questionSchemas.set(key, validator);
  }
  return validator;
}
// The v5 research gate is also the explicit subject route of v6. Keep the exported name for its consumers.
export const isDiscoveryV5 = (draft: DiscoveryDraft) => draft.stage === 'discovery'
  && draft.contractVersion === 6;

/** Read the accepted prefix in question order. A reopened question stops the
 * prefix even though the draft deliberately retains its previous field value. */
function acceptedPrefix(store: Store, draft: Revision<DiscoveryDraft>, before: Field, gate?: OutcomeGate) {
  const selected: Partial<Record<Field, AcceptedField>> = {};
  const guards = [reference(draft)];
  requireCondition(Array.isArray(draft.value.questions) && draft.value.questions.every(id => typeof id === 'string') && object(draft.value.fields),
    'discovery_research_invalid', `[${draft.id}] Discovery lost its questions or fields`);
  const required = fields.slice(0, fields.indexOf(before));
  if (gate?.prefix) {
    const prefix = gate.prefix;
    requireCondition(prefix.contract === 'discovery-prefix/v1' && same(prefix.draft, reference(draft)),
      'discovery_stale', `[${draft.id}] The accepted prefix belongs to another draft revision`);
    guards.push(...gate.guards, prefix.closure);
    for (const field of required) {
      const matches = prefix.entries.filter(entry => entry.field === field);
      requireCondition(matches.length <= 1, 'discovery_research_invalid', `[${draft.id}] Discovery v5 needs one ${field} question`);
      const entry = matches[0];
      if (!entry) {
        // Only unfinished questions need bodies. Accepted questions and their answers stay in the proven snapshot.
        const answered = new Set(prefix.entries.map(item => item.question.id));
        const pending = draft.value.questions.filter(id => !answered.has(id)).map(id => store.get<Question>(id))
          .filter(q => q?.kind === 'question' && q.value.spec.field === field);
        requireCondition(pending.length === 1 && pending[0]!.value.status === 'open',
          'discovery_research_invalid', `[${draft.id}] Discovery v5 needs one ${field} question`);
        guards.push(reference(pending[0]!));
        return { context: selected, guards: uniqueRefs(guards), pending: pending[0]!.id };
      }
      if (['researchPlan', 'researchReport', 'verdict'].includes(field)) {
        requireCondition(entry.kind === 'research-answer' && isRef(entry.assessment) && entry.observations > 0,
          'discovery_research_required', `[${entry.question.id}] The delivered answer needs its exact supported assessment`);
        validateField(field, entry.value, selected, entry.observations, entry.question.id);
      }
      selected[field] = { question: entry.question, answer: entry.answer, value: entry.value };
    }
    return { context: selected, guards: uniqueRefs(guards), pending: null };
  }
  const questions = draft.value.questions.map(id => store.get<Question>(id));
  requireCondition(questions.every(q=>q?.kind==='question' && object(q.value)
    && object(q.value.spec) && typeof q.value.spec.field==='string'),
    'discovery_research_invalid', `[${draft.id}] An exact Discovery question is missing or malformed`);
  const fail = (question: string, reason: string, code = 'discovery_research_invalid'): never => {
    requireCondition(false, code, `[${question}] ${reason}`);
  };
  const finish = (pending: string | null) => {
    if (gate) {
      const selectedIds = new Set(Object.values(selected).map(item=>item.question.id));
      const refused = gate.findings.find(f=>selectedIds.has(f.target)||f.target===draft.id||f.code==='research_context_stale');
      if(refused) fail(refused.target,refused.message,refused.code);
      guards.push(...gate.guards);
    }
    return {context:selected,guards:uniqueRefs(guards),pending};
  };
  for (const field of required) {
    const matches = questions.filter(q => q?.kind === 'question' && q.value.spec.field === field);
    if (matches.length !== 1) fail(draft.id, `Discovery v5 needs one ${field} question`);
    const q = matches[0]!;
    guards.push(reference(q));
    requireCondition(q.value.projectId === draft.value.projectId && q.value.draftId === draft.id,
      'discovery_research_invalid', `[${q.id}] The question belongs to another Discovery`);
    requireCondition(['open', 'answered'].includes(q.value.status), 'discovery_research_invalid',
      `[${q.id}] The question lost its status`);
    if (q.value.status !== 'answered') return finish(q.id);
    const ref = q.value.answer;
    requireCondition(isRef(ref), 'discovery_research_invalid', `[${q.id}] Accepted answer is missing`);
    const record = store.get<{ projectId: string; question: string; value?: Json; observation?: {value:Json}; assessment?: Ref }>(ref.id, ref.revision);
    requireCondition(record && same(reference(record), ref), 'discovery_research_invalid', `[${q.id}] Exact accepted answer is missing`);
    requireCondition(object(record.value) && record.value.projectId === draft.value.projectId && record.value.question === q.id
      && (record.kind === q.value.spec.kind || record.kind === 'research-answer'),
      'discovery_research_invalid', `[${q.id}] Accepted answer belongs to another question`);
    const value = record.kind==='fact' ? record.value.observation?.value : record.value.value;
    requireCondition(value !== undefined && same(value,draft.value.fields[field]),
      'discovery_research_invalid', `[${q.id}] The accepted pair differs from the delivered value`);
    const validator = questionSchema(q.value.spec.schema);
    requireCondition(validator(value), 'discovery_research_invalid',
      `[${q.id}] Accepted value does not satisfy its question`);
    if (['researchPlan', 'researchReport', 'verdict'].includes(field)) {
      requireCondition(record.kind === 'research-answer', 'discovery_research_required',
        `[${q.id}] ${field} requires accepted research, not a bare decision`);
      const assessmentRef = record.value.assessment;
      requireCondition(isRef(assessmentRef), 'discovery_research_required', `[${q.id}] The accepted answer lost its assessment`);
      const assessment = store.get<ResearchAssessment>(assessmentRef.id, assessmentRef.revision);
      requireCondition(assessment?.kind==='research-assessment' && object(assessment.value) && same(reference(assessment),assessmentRef)
        && assessment.value.projectId===draft.value.projectId && assessment.value.verdict==='supported'
        && isRef(assessment.value.question) && assessment.value.question.id===q.id
        && same(assessment.value.value,value) && Array.isArray(assessment.value.observations)
        && assessment.value.observations.length>0,
        'discovery_research_required', `[${q.id}] The delivered answer needs its exact supported assessment`);
      validateField(field, value, selected, assessment.value.observations.length, q.id);
      guards.push(assessmentRef);
    }
    selected[field] = { question: reference(q), answer: ref, value };
    guards.push(ref);
  }
  return finish(null);
}

function validateField(field: Field, value: Json, selected: DiscoveryContext['fields'], observations: number, questionId: string): void {
  requireCondition(researchSchemas.get(field)?.(value), 'discovery_research_invalid',
    `[${questionId}] The research value lost a required field or its valid form`);
  const answer = value as any;
  if (field === 'researchPlan') {
    const ids = [...answer.startingQuestions, ...answer.feasibilityQuestions].map((item: any) => item.id);
    requireCondition(new Set(ids).size === ids.length && new Set(answer.sources.map((item: any) => item.id)).size === answer.sources.length,
      'discovery_research_invalid', `[${questionId}] Research questions and sources need unique local identifiers`);
  } else if (field === 'researchReport') {
    requireCondition(same(answer.researchPlan, selected.researchPlan?.answer), 'discovery_basis_stale',
      `[${questionId}] Reopen the report and verdict: the report names a previous research plan`);
    const plan = selected.researchPlan!.value as any;
    const ids = new Set([...plan.startingQuestions, ...plan.feasibilityQuestions].map((item: any) => item.id));
    const conclusions = [...answer.results, ...answer.openQuestions];
    requireCondition(conclusions.length > 0 && new Set(conclusions.map((item: any) => item.id)).size === conclusions.length
      && conclusions.every((item: any) => ids.has(item.question))
      && answer.results.every((item: any) => item.citations.every((index: number) => index < observations)),
    'discovery_research_invalid', `[${questionId}] Report results must address the plan and exact answer citations`);
  } else {
    requireCondition(same(answer.researchReport, selected.researchReport?.answer), 'discovery_basis_stale',
      `[${questionId}] Reopen the verdict: it names a previous research report`);
    const report = selected.researchReport!.value as any;
    const ids = new Set([...report.results, ...report.openQuestions].map((item: any) => item.id));
    requireCondition(answer.bases.every((item: any) => ids.has(item.result))
      && new Set(answer.conditions.map((item: any) => item.id)).size === answer.conditions.length
      && (answer.outcome !== 'go' || answer.conditions.length === 0)
      && (answer.outcome !== 'conditional' || answer.conditions.length > 0),
    'discovery_research_invalid', `[${questionId}] Verdict bases and conditions must belong to the current report`);
    for (const condition of answer.conditions.filter((c: any) => c.kind === 'owner_choice'))
      requireCondition(new Set(condition.options.map((o: DiscoveryChoiceOption) => o.optionId)).size === condition.options.length
        && condition.options.some((o: DiscoveryChoiceOption) => o.choice === 'accept')
        && condition.options.some((o: DiscoveryChoiceOption) => o.choice === 'decline'),
      'discovery_research_invalid', `[${questionId}] Owner condition ${condition.id} needs distinct stable options, including acceptance and refusal`);
  }
}

export function requireDiscoveryProposal(draft: DiscoveryDraft, question: Pick<Revision<Question>, 'id' | 'value'>, value: Json,
  context: DiscoveryContext | null, observations: number): void {
  if (!isDiscoveryV5(draft)) return;
  requireCondition(context?.contract === 'discovery-research-context/v1' && object(context.fields), 'discovery_basis_missing',
    `[${question.id}] The proposal needs its delivered research grounds`);
  for (const field of fields.slice(0, fields.indexOf(question.value.spec.field as Field))) {
    const accepted = context.fields[field];
    requireCondition(accepted && isRef(accepted.question) && isRef(accepted.answer) && accepted.value !== undefined,
      'discovery_basis_missing', `[${question.id}] The delivered grounds are missing accepted ${field}`);
  }
  if (['researchPlan', 'researchReport', 'verdict'].includes(question.value.spec.field))
    validateField(question.value.spec.field as Field, value, context.fields, observations, question.id);
  if (question.value.spec.field === 'preparation') requirePreparation(value, context.fields, question.id);
}

/** Material projection proves exact accepted pairs and their relationships.
 * Eligibility is proved separately by discoveryOutcome before new dispatch;
 * recording that full ancestor proof in every assessor origin grows recursively. */
export function discoveryContext(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>): {
  context: DiscoveryContext | null; guards: Ref[];
} {
  if (!isDiscoveryV5(draft.value)) return { context: null, guards: [] };
  const field = question.value.spec.field as Field;
  requireCondition(fields.includes(field), 'discovery_research_invalid', `[${question.id}] Unknown Discovery v5 question`);
  const read = acceptedPrefix(store, draft, field);
  requireCondition(read.pending === null, 'discovery_basis_missing',
    `[${question.id}] Prior research question ${read.pending} must be answered first`);
  const history = choiceHistory(store, draft);
  return { context: { contract: 'discovery-research-context/v1', fields: read.context,
    reportConstraints: discoveryConstraintBindings(read.context), ownerDecisions: history.values },
    guards: uniqueRefs([...read.guards, ...history.guards]) };
}

/** Public business result. Internal admission evidence never enters this value. */
export function discoveryOutcome(store: Store, draft: Revision<DiscoveryDraft>): DiscoveryOutcome {
  return discoveryInspection(store, draft).outcome;
}

/** Share one gate within a synchronous consumer, separately from the public outcome. */
export function discoveryInspection(store: Store, draft: Revision<DiscoveryDraft>,
  readGate: () => OutcomeGate = () => new Discovery(store).gate(draft.value.projectId, reference(draft))): { outcome: DiscoveryOutcome; gate: OutcomeGate } {
  // Evaluate once in this synchronous operation. The stage reader supplies its requested Ref, not a cached result.
  if (isDiscoveryV5(draft.value)) requireCondition(Array.isArray(draft.value.questions)
    && draft.value.questions.every(id => typeof id === 'string') && object(draft.value.fields),
    'discovery_research_invalid', `[${draft.id}] Discovery lost its questions or fields`);
  let gate: OutcomeGate;
  try { gate = readGate(); }
  catch (error) {
    // Before closures, the exact-pair reader diagnosed missing values before gate could access them.
    // Preserve that addressed refusal on old/corrupt records; an unrelated gate failure still propagates.
    if (isDiscoveryV5(draft.value)) acceptedPrefix(store, draft, 'preparation');
    throw error;
  }
  const invalidPrefix = gate.findings.find(finding => finding.code === 'discovery_prefix_closure_invalid');
  if (invalidPrefix) throw new EngineError(invalidPrefix.code, `[${invalidPrefix.target}] ${invalidPrefix.message}`);
  if (draft.value.contractVersion === 7 && draft.value.stage === 'discovery'
    && draft.value.fields.plan !== null && draft.value.fields.plan !== undefined) {
    const questions = draft.value.questions.map(id => store.get<Question>(id));
    requireCondition(questions.every(q => q?.kind === 'question' && q.value.projectId === draft.value.projectId
      && q.value.draftId === draft.id), 'plan_questions_invalid', 'Discovery lost a question of its plan');
    const plan = questions.find(q => q!.value.spec.field === 'plan');
    requireCondition(plan, 'plan_questions_invalid', 'Discovery lost its plan question');
    if (plan.value.status === 'answered') {
      requireCondition(isRef(plan.value.answer), 'plan_questions_invalid', 'The answered plan lost its exact answer');
      provePlanQuestions(store, draft, plan.value.answer);
    }
    // Traversal ends are not stage acceptance. Retain the full gate, including unresolved fields;
    // before a plan exists the original partial-v7 prefix reader keeps its constant read budget.
    return { outcome: { state: 'researching', verdict: null, report: null, conditions: [], ownerChoices: [],
      reason: null, guards: gate.guards, findings: [] }, gate };
  }
  return { outcome: outcomeFromGate(store, draft, gate), gate };
}

function outcomeFromGate(store: Store, draft: Revision<DiscoveryDraft>, gate: OutcomeGate): DiscoveryOutcome {
  const empty = { verdict: null, report: null, conditions: [], ownerChoices: [], reason: null, guards: [], findings: [] };
  if (!isDiscoveryV5(draft.value)) return { ...empty, state: 'legacy' };
  const read = acceptedPrefix(store, draft, 'preparation', gate);
  if (read.pending) return { ...empty, state: 'researching', guards: read.guards };
  const verdict = read.context.verdict!, answer = verdict.value as any;
  const state = answer.outcome as DiscoveryVerdict;
  const findings = state === 'go' ? [] : [{ code: `discovery_${state}`, target: verdict.question.id,
    message: answer.reason as string }];
  const ownerChoices: DiscoveryChoice[] = [];
  const conditions = answer.conditions.filter((condition: any) => {
    if (state !== 'conditional' || condition.kind !== 'owner_choice') return true;
    const decision = store.get<DiscoveryConditionDecision>(discoveryDecisionId(draft.value.projectId, draft.id, verdict.answer, condition.id));
    if (decision) {
      const proved = readDiscoveryConditionDecision(store, { project: draft.value.projectId, draft: draft.id,
        verdictRef: verdict.answer, reportRef: read.context.researchReport!.answer,
        conditionId: condition.id, record: reference(decision) });
      read.guards.push(reference(proved.record)); return false;
    }
    ownerChoices.push({ project: draft.value.projectId, draft: draft.id, verdictRef: verdict.answer,
      conditionId: condition.id, condition: condition.condition, criterion: condition.criterion, options: condition.options });
    return true;
  });
  const preparation = gate.prefix
    ? gate.prefix.entries.find(entry => entry.field === 'preparation')?.question.id
    : draft.value.questions.map(id => store.get<Question>(id))
      .find(q => q?.value.spec.field === 'preparation' && q.value.status === 'answered')?.id;
  if (state === 'go' && preparation) requirePreparation(draft.value.fields.preparation!, read.context, preparation);
  return { state, verdict: verdict.answer, report: read.context.researchReport!.answer,
    conditions, ownerChoices, reason: answer.reason, guards: read.guards, findings };
}

/** A reuse candidate is still an answer to its original question. Its body is
 * never rebound to new plan/report refs; a mismatch leaves ordinary research. */
export function discoveryReuseAdmission(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  value: Json, source: DiscoveryContext | null): { allowed: boolean; guards: Ref[] } {
  if (!isDiscoveryV5(draft.value)) return { allowed: true, guards: [] };
  const field=question.value.spec.field as Field;
  if (field==='brief'||field==='objective') return {allowed:true,guards:[]};
  const outcome=discoveryOutcome(store,draft);
  if(outcome.findings.length) return {allowed:false,guards:[]};
  const read=acceptedPrefix(store,draft,field);
  if(read.pending) return {allowed:false,guards:[]};
  if (!source || source.contract!=='discovery-research-context/v1' || !object(source.fields)) return {allowed:false,guards:[]};
  const current=read.context;
  const prefix=fields.slice(0,fields.indexOf(field));
  const samePrefix=prefix.every(name=>field==='researchPlan'
    ? same(source.fields[name]?.value,current[name]?.value)
    : same(source.fields[name]?.answer,current[name]?.answer));
  if(!samePrefix) return {allowed:false,guards:[]};
  const history = choiceHistory(store, draft);
  if (!same(source.ownerDecisions, history.values)) return {allowed:false,guards:[]};
  if(field==='preparation' && (current.verdict!.value as any).outcome!=='go') return {allowed:false,guards:[]};
  if(field==='researchReport'&&!same((value as any).researchPlan,current.researchPlan!.answer)
    ||field==='verdict'&&!same((value as any).researchReport,current.researchReport!.answer)) return {allowed:false,guards:[]};
  return {allowed:true,guards:uniqueRefs([...read.guards,...outcome.guards,...history.guards])};
}

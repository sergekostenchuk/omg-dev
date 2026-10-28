import { processStart } from '../runtime/process-identity.js';
import { historicalProof } from '../history/proofs.js';
import { genuineStore } from '../storage/store-view.js';
import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision } from '../storage/store.js';
import { Environments, readEnvironmentAt } from '../runtime/environment.js';
import { assessmentSessionWithProof, readAssessmentSessionOutcomeAt } from './assessment-session.js';
import { proveClaimAddress, type ClaimAddress } from './claim-address.js';
import { readVariantScope, readCurrentVariantScope } from './variant-scope.js';
import { currentPlan, provePlanQuestions } from './v7-plan-questions.js';
import { readDiscoveryFinalAssessmentSourceAt, type DiscoveryFinalAssessmentSource } from './discovery-final-assessment-source.js';
import { pilotEnvironment, readerPilot } from './reader-pilot.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { ResearchAnswer, ResearchRun } from './research-model.js';

export const RESEARCH_RETURN_REQUEST = 'discovery-research-return-request';
export const RESEARCH_RETURN = 'discovery-research-return';
export interface ResearchReturnInput {
  project: string; scope: Ref; plan: Ref; question: string; axis: string;
  grounds: ClaimAddress[]; destination: 'D4' | 'D5' | 'D7'; final: Ref | null;
  reason: string; requiredResult: string;
}
interface ReturnRequest {
  contract: 'discovery-research-return-request/v1'; input: ResearchReturnInput;
  environment: Ref; boundary: number; subject: ReturnType<typeof subjectAt>; finalMaterial: unknown;
}
export interface ResearchReturn {
  contract: 'discovery-research-return/v1'; projectId: string; request: Ref;
  session: Ref; application: Ref;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const PROMPT = 'Assess the proposed addressed Discovery return on the full proven subject. Return verdict supported only if the evidence establishes the requested route: D4 means the currently selected variant is refuted and must be reconsidered; D5 means this exact question/axis needs additional research, without refuting the variant; D7 means the saved final conclusion needs revision. Mere lack of evidence is not refutation. Preserve other claims and coverage. Caller reason and destination are proposals, not evidence. Return {verdict:"supported"|"insufficient"|"conflicting",reasons:[nonempty reasons]}. Do not choose a new variant or accept a final result.';
function invalid(message: string): never { throw new EngineError('discovery_research_return_invalid', message); }
function shape(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key))) invalid('Expected the closed research-return input');
}
function exact<T>(store: Store, at: Ref, kind: string): Revision<T> {
  if (!isRef(at)) invalid(`Missing exact ${kind}`);
  const row = store.get<T>(at.id, at.revision);
  if (!row || row.kind !== kind || !same(reference(row), at) || row.hash !== hashJson(row.value)) invalid(`Missing or changed ${kind}`);
  return row;
}
export function decodeResearchReturnInput(raw: unknown): ResearchReturnInput {
  // Read accessors once, before any await or admission.
  const value = structuredClone(raw);
  shape(value, ['project','scope','plan','question','axis','grounds','destination','final','reason','requiredResult']);
  for (const key of ['project','question','axis','reason','requiredResult'])
    if (typeof value[key] !== 'string' || !value[key].trim()) invalid(`Missing ${key}`);
  if (!isRef(value.scope) || !isRef(value.plan) || !['D4','D5','D7'].includes(String(value.destination))
    || (value.final !== null && !isRef(value.final)) || (value.destination === 'D7') !== (value.final !== null)
    || !Array.isArray(value.grounds) || !value.grounds.length) invalid('Exact scope, plan, grounds and route are required; D7 retains its paid final');
  return value as unknown as ResearchReturnInput;
}
function subjectAt(store: Store, input: ResearchReturnInput) {
  const selected = readVariantScope(store, input.project, input.scope), scope = selected.scope.value;
  const draft = exact<DiscoveryDraft>(store, scope.draft, 'discovery-draft');
  const questions = provePlanQuestions(store, draft, input.plan);
  const question = questions.find(item => item.planQuestionId === input.question);
  if (!question || (question.question as any).axis !== input.axis) invalid('The addressed axis/question must belong to the exact accepted plan');
  const grounds = input.grounds.map(address => {
    if (!address || address.project !== input.project) invalid('Foreign evidence');
    const proof = proveClaimAddress(store, address), claim = proof.claim as any;
    if (claim.axis !== input.axis || !claim.planQuestions?.some((q: any) => q.planQuestionId === input.question && same(q.planAnswer, input.plan))
      || !(claim.scope?.variants === 'common' || claim.scope?.variants?.some((member: Ref) => same(member, scope.member))))
      invalid('The accepted evidence must address this exact question, axis and selected member');
    const contradictions = [...(claim.contradicts ?? []), ...(claim.refutedBy ?? [])].map((other: ClaimAddress) => {
      if (!other || other.project !== input.project) invalid('A contradiction needs this project’s historical claim');
      const previous = proveClaimAddress(store, other);
      return { address: other, container: previous.container, claim: previous.claim };
    });
    return { address, container: proof.container, claim: proof.claim, contradictions };
  });
  return { scope: selected.scope, selection: selected.choice.state!, decision: selected.choice.ref,
    set: selected.generation.publication.result, members: selected.generation.publication.members,
    draft: scope.draft, question, grounds };
}
function presentAt(store: Store, at: Ref, boundary: number): boolean {
  // events is available on the shared atomic read view; no nested write or new Store is needed.
  return store.events(0, boundary).some(event => event.id === at.id && event.revision === at.revision);
}
function requestAt(store: Store, at: Ref) {
  const row = exact<ReturnRequest>(store, at, RESEARCH_RETURN_REQUEST), value = row.value;
  if (row.revision !== 1 || value.contract !== 'discovery-research-return-request/v1') invalid('Unknown return request');
  const input = decodeResearchReturnInput(value.input);
  if (row.id !== requestId(input) || !same(value.subject, subjectAt(store, input))) invalid('The return request lost its proven subject');
  readEnvironmentAt(store, input.project, value.environment);
  if (!Number.isSafeInteger(value.boundary) || value.boundary < 0
    || !presentAt(store, input.scope, value.boundary)) invalid('The return lost its historical boundary');
  return row;
}
const requestId = (input: ResearchReturnInput) => `${RESEARCH_RETURN_REQUEST}:${input.project}:${hashJson(input as unknown as Json)}`;
const resultId = (request: Ref) => `${RESEARCH_RETURN}:${hashJson(request as unknown as Json)}`;
/** Historical proof. Neither a proposed destination nor a stored return flag can authorize new work. */
function proveResearchReturn(store: Store, project: string, at: Ref): ReturnType<typeof deriveResearchReturn> {
  if (!isRef(at)) invalid('An exact research-return reference is required');
  if (!genuineStore(store)) return deriveResearchReturn(store, project, at);
  return structuredClone(historicalProof(store, {reader:'discovery.research-return/v1', project, ref:at},
    source => deriveResearchReturn(source, project, at), () => invalid('Cyclic return proof')));
}
function deriveResearchReturn(store: Store, project: string, at: Ref) {
  const record = exact<ResearchReturn>(store, at, RESEARCH_RETURN), v = record.value;
  if (record.revision !== 1 || v.contract !== 'discovery-research-return/v1' || v.projectId !== project || record.id !== resultId(v.request))
    invalid('Foreign return identity');
  const request = requestAt(store, v.request), proof = readAssessmentSessionOutcomeAt(store, project, v.session, v.application);
  if (request.value.input.project !== project || proof.prompt !== PROMPT || !same(proof.context.value, request.value)
    || !same(proof.context.observations, []) || !same(proof.environment, request.value.environment)) invalid('The return lost its exact paid assessment');
  const result = proof.result as { verdict: string; reasons: string[] };
  if (!result || !['supported','insufficient','conflicting'].includes(result.verdict)
    || !Array.isArray(result.reasons) || !result.reasons.length
    || result.reasons.some(reason => typeof reason !== 'string' || !reason.trim()))
    invalid('A semantic return assessment needs its typed verdict and explicit reasons');
  const approved = result.verdict === 'supported';
  return { record: structuredClone(record), request: structuredClone(request), assessment: structuredClone(proof),
    destination: approved ? request.value.input.destination : null,
    reason: { code: approved ? `discovery_return_${request.value.input.destination.toLowerCase()}` : 'discovery_return_unproven',
      target: { scope: request.value.input.scope, plan: request.value.input.plan, question: request.value.input.question, axis: request.value.input.axis },
      message: result.reasons.join('; ') }, requiredResult: request.value.input.requiredResult,
    final: request.value.input.final };
}
/** One paid assessment for an exact proposed return. The common session restores paid work before any new admission. */
export async function returnDiscoveryResearch(store: Store, raw: ResearchReturnInput, signal?: AbortSignal) {
  const input = decodeResearchReturnInput(raw), id = requestId(input);
  let request = store.get<ReturnRequest>(id);
  if (request) request = requestAt(store, reference(request));
  else {
    const subject = subjectAt(store, input), effective = new Environments(store).effective(input.project);
    const plan = currentPlan(store, input.project), selection = store.get(subject.selection.id);
    if (!same(reference(plan.draft), subject.draft) || !same(plan.planAnswer, input.plan)
      || !selection || !same(reference(selection), subject.selection)) invalid('The proposed return is no longer current');
    const finalMaterial = input.final ? await readDiscoveryFinalAssessmentSourceAt(store, input.project, input.final) : null;
    if (finalMaterial) requireFinalBinding(finalMaterial, input, subject.draft);
    const value: ReturnRequest = { contract: 'discovery-research-return-request/v1', input, environment: reference(effective.environment),
      subject, finalMaterial, boundary: store.lastEvent() };
    request = store.writeMany<ReturnRequest>([{ id, kind: RESEARCH_RETURN_REQUEST, expected: 0, value }],
      [reference(plan.draft), reference(plan.question), subject.selection, reference(effective.environment)])[0]!;
  }
  const saved = store.get<ResearchReturn>(resultId(reference(request)));
  if (saved) return activateReturn(store, await readResearchReturnAt(store, input.project, reference(saved)));
  const v = request.value, draft = exact<DiscoveryDraft>(store, v.subject.draft, 'discovery-draft');
  const planAnswer = exact<ResearchAnswer>(store, input.plan, 'research-answer');
  const question = store.get<Question>(planAnswer.value.question)!;
  const environment = readEnvironmentAt(store, input.project, v.environment);
  const pilot = readerPilot(store, input.project) ?? undefined;
  const dispatch = pilot ? pilotEnvironment(environment.value, pilot.value) : environment.value;
  const assessed = await assessmentSessionWithProof(store, draft, question, environment, dispatch, pilot,
    { value: v, observations: [] }, PROMPT, signal, [v.subject.selection, input.plan]);
  requireCondition(assessed.proof, 'discovery_research_return_invalid', 'The return needs a paid application');
  const value: ResearchReturn = { contract: 'discovery-research-return/v1', projectId: input.project,
    request: reference(request), session: assessed.proof.session, application: assessed.proof.application };
  const result = store.get<ResearchReturn>(resultId(value.request)) ?? store.write<ResearchReturn>({ id: resultId(value.request),
    kind: RESEARCH_RETURN, expected: 0, value });
  return activateReturn(store, await readResearchReturnAt(store, input.project, reference(result)));
}
/** Exact historical predecessor lookup, also used at the common model-choice reservation door. */
export function variantResearchReturn(store: Store, project: string, selection: Ref) {
  for (const row of store.list<ResearchReturn>(RESEARCH_RETURN)) {
    if (row.value.projectId !== project) continue;
    const request = store.get<ReturnRequest>(row.value.request.id, row.value.request.revision);
    if (request?.value.input.destination !== 'D4' || !same(request.value.subject.selection, selection)) continue;
    const proven = proveResearchReturn(store, project, reference(row));
    if (proven.destination === 'D4') return proven;
  }
  return null;
}
/** A late D5 return invalidates only the old sufficiency of its exact cell. Paid later evidence can close it again. */
export function researchReturnGap(store: Store, project: string, scope: Ref, plan: Ref, question: string,
  sufficiency: Ref | null, boundary?: number) {
  const rows = boundary === undefined ? store.list<ResearchReturn>(RESEARCH_RETURN)
    : store.identitiesAtEvent(boundary, RESEARCH_RETURN).map(row => store.get<ResearchReturn>(row.id, row.revision)!);
  for (const row of rows) {
    if (row.value.projectId !== project) continue;
    const candidate = store.get<ReturnRequest>(row.value.request.id, row.value.request.revision), input = candidate?.value.input;
    if (!input || input.destination !== 'D5' || !same(input.scope, scope) || !same(input.plan, plan) || input.question !== question) continue;
    const proven = proveResearchReturn(store, project, reference(row));
    if (proven.destination === 'D5' && (!sufficiency || presentAt(store, sufficiency, candidate!.value.boundary))) return proven;
  }
  return null;
}

function activateReturn(store: Store, returned: ReturnType<typeof proveResearchReturn>) {
  if (returned.destination !== 'D4' && returned.destination !== 'D5') return returned;
  const { input, subject } = returned.request.value;
  const state = store.get(subject.selection.id);
  // Restoring an old paid return never reactivates an obsolete selection.
  if (!state || !same(reference(state), subject.selection)) return returned;
  const id = `research-run:${hashJson([input.project, subject.draft.id])}`, run = store.get<ResearchRun>(id);
  if (run?.value.status === 'running' || (run && store.history<ResearchRun>(id)
    .some(revision => same(revision.value.researchReturn ?? null, reference(returned.record))))) return returned;
  if (!run || !same(run.value.researchReturn ?? null, reference(returned.record))) {
    const draft = exact<DiscoveryDraft>(store, subject.draft, 'discovery-draft');
    const value = run?.value ?? { projectId: input.project, draftId: draft.id,
      environment: returned.request.value.environment, turns: 0, limit: 1, requestChars: 0,
      owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, inputs: draft.value.inputs };
    store.writeMany([{ id, kind: 'research-run', expected: run?.revision ?? 0,
      value: { ...value, researchReturn: reference(returned.record), status: 'paused',
        pauseCode: returned.reason.code, error: canonical({ ...returned.reason, return: reference(returned.record) }) } }],
      [...(run ? [reference(run)] : []), subject.selection]);
  }
  return returned;
}

/** Typed contradictory accepted claims trigger an assessment, never an inferred semantic verdict.
 * Plain text and unaccepted/rejected attempts cannot enter this door. */
export async function assessDeepResearchReturns(store: Store, project: string, allowNew: boolean, beforeSend: () => void, signal?: AbortSignal) {
  const candidates = store.list<any>('research-attempt').filter(attempt => attempt.value.project === project
    && Array.isArray(attempt.value.end?.value?.claims)
    && attempt.value.end.value.claims.some((claim: any) => (claim.contradicts?.length ?? 0) + (claim.refutedBy?.length ?? 0) > 0));
  if (!candidates.length) return;
  const plan = currentPlan(store, project);
  let scope: ReturnType<typeof readCurrentVariantScope>;
  try { scope = readCurrentVariantScope(store, project, reference(plan.draft)); }
  catch (error) { if (error instanceof EngineError && error.code === 'discovery_variant_scope_required') return; throw error; }
  if (variantResearchReturn(store, project, reference(scope.state))) return;
  for (const attempt of candidates) {
    if (attempt.value.project !== project || !same(attempt.value.planAnswer, plan.planAnswer)) continue;
    const claims = attempt.value.end?.value?.claims ?? attempt.value.value?.claims;
    if (!Array.isArray(claims)) continue;
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      if ((claim.contradicts?.length ?? 0) + (claim.refutedBy?.length ?? 0) === 0
        || !(claim.scope?.variants === 'common' || claim.scope?.variants?.some((member: Ref) => same(member, scope.scope.value.member)))) continue;
      const address: ClaimAddress = { project, container: reference(attempt), containerKind: 'research-attempt', pointer: `/claims/${i}`, claimId: claim.id };
      try { proveClaimAddress(store, address); }
      catch (error) { if (error instanceof EngineError && error.code === 'claim_attempt_not_accepted') continue; throw error; }
      const input: ResearchReturnInput = { project, scope: reference(scope.scope), plan: plan.planAnswer,
        question: attempt.value.planQuestionId, axis: claim.axis, grounds: [address], destination: 'D4', final: null,
        reason: 'Accepted deep evidence contains a typed contradiction or refutation involving the selected variant',
        requiredResult: 'Reconsider the selected variant only if the contradiction refutes it; otherwise retain it' };
      const request = store.get<ReturnRequest>(requestId(input));
      if (request && store.get(resultId(reference(request)))) continue;
      if (!allowNew) return;
      beforeSend();
      const result = await returnDiscoveryResearch(store, input, signal);
      if (result.destination === 'D4') return;
      // One new assessment per bounded runner step; the next iteration handles another candidate.
      return;
    }
  }
}

export async function readResearchReturnAt(store: Store, project: string, at: Ref) {
  const proven = proveResearchReturn(store, project, at), input = proven.request.value.input;
  if (input.final) {
    const source = await readDiscoveryFinalAssessmentSourceAt(store, project, input.final);
    requireFinalBinding(source, input, proven.request.value.subject.draft);
    if (!same(source, proven.request.value.finalMaterial)) invalid('The return lost the full historical paid final');
  } else if (proven.request.value.finalMaterial !== null) invalid('A non-final return cannot substitute a final');
  return proven;
}
function requireFinalBinding(source: DiscoveryFinalAssessmentSource, input: ResearchReturnInput, draft: Ref) {
  const subject = source.paid.value.subject;
  if (!same(subject.basis.draft, draft) || !same(subject.basis.plan, input.plan)
    || !same(source.packet.final.dossier.route.scope?.ref, input.scope)) invalid('The old final belongs to another draft/plan');
}

/** Historical model revisions name their own immutable return, never whichever return is newest today. */
export function readVariantResearchReturnAt(store: Store, project: string, at: Ref, selection: Ref) {
  const proven = proveResearchReturn(store, project, at);
  if (proven.destination !== 'D4' || !same(proven.request.value.subject.selection, selection))
    invalid('The model revision needs the proved D4 return of its exact predecessor');
  return proven;
}

/** The full reconsideration subject and its judgment; transport receipts are addressed by the return Ref. */
export function researchReturnMaterial(proven: ReturnType<typeof proveResearchReturn>) {
  return structuredClone({ input: proven.request.value.input, subject: proven.request.value.subject,
    assessment: proven.assessment.result, final: proven.request.value.finalMaterial });
}

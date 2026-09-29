import { Ajv } from "ajv";
import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { Evidence } from "../evidence/evidence.js";
import { reference, isRef, type Ref, type Finding } from "../pipeline/contracts.js";
import { uniqueTransactionGuards, type Environment } from "../runtime/environment.js";
import { canonical, hashJson } from "../canonical.js";
import { realpathSync } from 'node:fs';
import { requireCondition, EngineError } from "../errors.js";
import type { Question, DiscoveryDraft } from "./discovery.js";
import type { ResearchAction, ResearchAssessment } from "./research-model.js";
import { researchPrerequisites, researchGraphContext } from "./research-context.js";
import { consumerFeedback } from "./consumer-feedback.js";
import { pilotEnvironment, type ReaderPilot } from "./reader-pilot.js";
import { pilotContext } from "./pilot-context.js";
import { layerDeltaView, expandLayerDelta } from "./layer-delta.js";
import { technicalProposalFindings, type LegacyPathResolution } from "../graph/research-evidence.js";
import type { TechnicalReport } from "../graph/research-contracts.js";
import type { Graph } from "../graph/model.js";
import { assessmentSession, assessmentSessionWithProof, readAssessmentSessionOutcomeAt,
  readAssessmentPaidOrigin, type AssessmentPaidOriginInput } from "./assessment-session.js";
import { assessmentReadView, readResearchConsumerIntent, readResearchConsumerTurn,
  prepareManagedProposalRefusal, type AssessmentReadProof } from './response-recovery.js';
import { researchAction } from './research-consumer-transition.js';
import { resolveResearchBasis } from '../graph/research-basis.js';
import { OBLIGATION_EVIDENCE_PAUSES, requireDocumentarySources } from '../graph/obligation-evidence.js';
import { collectRuntimeSelection, emptyRuntimeAdmission } from '../graph/runtime-evidence.js';
import { obligationHandoff } from '../graph/obligation-handoff.js';
import { requireTaskObligations } from '../graph/task-obligations.js';
import { composeLayer } from '../graph/layer-design.js';

const ASSESSMENT_BINDING = 'research-assessment-binding/v1' as const;
const PROPOSAL_REFUSAL_MESSAGE = 'Correct the typed proposal findings before model assessment';
interface ResearchAssessmentBinding {
  contract: typeof ASSESSMENT_BINDING; projectId: string; turn: Ref; pending: Ref;
  assessment: Ref; draft: Ref; question: Ref; environment: Ref;
  session: Ref; application: Ref; reads: AssessmentReadProof;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function assessmentPrompt(bases: ResearchAssessment['bases'] | undefined, obligationContract: unknown): string {
  return "Evaluate whether the supplied observations actually support the proposed answer to this exact question and all its required details. Source hashes prove identity only. A fact needs relevant evidence of the claimed behavior, not an unrelated quote, a plan, or model confidence. For kind=decision, only existing explicit owner intent supports the value. For kind=design, evaluate a model-authored proposal for completeness, usefulness to the named consumer, consistency with the supplied intent and constraints; it may introduce a design but must not pretend it is existing implementation or a new owner decision. Reject invented facts, unsupported inapplicability, and empty generic filler. Return JSON {verdict: supported|insufficient|conflicting, reasons: string[]}. If unsupported or contradictory explain exactly why. Do not change files or perform external actions." + (bases ? " bases[].proofLimit limits the claim: quoted-intent-requires-attribution requires establishing explicit attributable owner intent, not trusting the document ingestion label; reported-not-runtime-proof is a documentary report and does not establish current environment behavior or completed implementation. Preserve documentary support with its stated limits instead of promoting it to a repository fact or discarding it." : "") + (obligationContract ? " Assess each coverage member against its fixed assignment.kind and consumer. A documentaryAllowance only admits the named source: the actual claim must stay within assignment.documentaryAllowance.claimLimit and the quoted evidence. Reject broader claims; admission of a document does not certify runtime behavior or implementation." : "");
}
export const assessmentBindingId = (projectId: string, turnId: string) =>
  `research-assessment-binding:v1:${hashJson({ projectId, turnId })}`;
/** One subject check for the paid L3 proposal: its assembly composes against
 * the exact original graph and satisfies the exact producing handoff. The
 * `graph` argument selects the era — the captured head at production, the
 * saved origin revision for recovery and the historical reader (№1971-5/R11). */
function requirePaidLayerAssembly(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  graph: Revision<Graph>, value: unknown): void {
  const handoff = obligationHandoff(store, draft.value.projectId, draft.value.inputs);
  const assembled = composeLayer(graph.value, 3, value, question.value.spec.layerAssembly);
  if (handoff) requireTaskObligations(store, draft.value.projectId, assembled, handoff);
}
function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  requireCondition(isRef(ref), 'research_assessment_binding_invalid', 'An exact assessment source is required');
  const saved = store.get<T>(ref.id, ref.revision);
  requireCondition(saved?.kind === kind && same(reference(saved), ref) && hashJson(saved.value) === saved.hash,
    'research_assessment_binding_invalid', `[${ref.id}] Exact assessment source is missing, foreign or changed`);
  return saved;
}
function managedTurn(store: Store, pendingRef: Ref, draft: Revision<DiscoveryDraft>, question: Revision<Question>, action: Extract<ResearchAction, { action: 'answer' }>): Ref {
  const pending = readResearchConsumerTurn(store, pendingRef);
  const first = readResearchConsumerTurn(store, { id: pendingRef.id, revision: 1,
    hash: store.get(pendingRef.id, 1)?.hash ?? '' });
  const origin = readResearchConsumerIntent(store, first.value.consumerIntent);
  const paid = researchAction(first.value.action);
  requireCondition(pending.value.contract === 'research-consumer-turn/v1' && pending.value.status === 'pending'
    && same(reference(pending), pendingRef) && same(pending.value.question, reference(question))
    && same(origin.value.draft, reference(draft))
    && (paid.action === 'answer' || paid.action === 'answer_delta') && paid.question === question.id
    && same(paid.citations, action.citations)
    && (paid.action === 'answer' ? same(paid.value, action.value)
      : same(expandLayerDelta(store, draft, question, paid, 'historical'), action.value)),
    'research_assessment_binding_invalid', `[${pendingRef.id}] The assessment must consume this exact paid answer`);
  return reference(first);
}
function assessmentValue(question: Revision<Question>, action: Extract<ResearchAction, { action: 'answer' }>,
  environment: Revision<Environment>, observations: ResearchAssessment['observations'],
  bases: ResearchAssessment['bases'], runtimeProofs: ResearchAssessment['runtimeProofs'], response: { verdict: unknown; reasons: unknown }): ResearchAssessment {
  requireCondition(['supported', 'insufficient', 'conflicting'].includes(String(response.verdict))
    && Array.isArray(response.reasons) && response.reasons.every(item => typeof item === 'string')
    && (response.verdict === 'supported' || response.reasons.length > 0),
  'assessment_invalid', 'Assessment must explicitly classify support and explain unresolved evidence');
  return { projectId: question.value.projectId, question: reference(question), value: action.value,
    ...(bases ? { bases } : {}), ...(runtimeProofs?.length ? { runtimeProofs } : {}), observations,
    verdict: response.verdict as ResearchAssessment['verdict'], reasons: response.reasons as string[],
    researcher: environment.value.implementer.actor, assessor: environment.value.reviewer.actor,
    environment: reference(environment) };
}

export async function assessAnswer(store: Store, question: Revision<Question>, action: Extract<ResearchAction, { action: "answer" }>,
  environment: Revision<Environment>, root: string, signal?: AbortSignal, pilot?: Revision<ReaderPilot>, managedPending?: Ref): Promise<Revision<ResearchAssessment>> {
  const priorOrigin = managedPending ? readAssessmentPaidOrigin(store, question.value.projectId, managedPending) : null;
  const originalPilot = priorOrigin?.value.profile
    ? exact<ReaderPilot>(store, priorOrigin.value.profile, 'reader-pilot') : undefined;
  if (priorOrigin) {
    question = exact<Question>(store, priorOrigin.value.question, 'question');
    environment = exact<Environment>(store, priorOrigin.value.environment, 'environment');
    root = priorOrigin.value.root;
  }
  const readView = managedPending ? assessmentReadView(store, priorOrigin?.value.reads) : null;
  const inputStore = readView?.store ?? store;
  requireDocumentarySources(inputStore,question.value.projectId,question.value.spec);
  const schemaOk = new Ajv({ strict: true, allowUnionTypes: true })
    .compile(question.value.spec.schema as object)(action.value);
  // A fresh managed proposal keeps its D8.4c refusal: a schema-invalid value is
  // a technical finding and its prepared refusal, not a bare run pause. Every
  // other caller fails at the shared schema check before consuming the call.
  requireCondition(schemaOk || (managedPending !== undefined && !priorOrigin),
    "answer_invalid", "Proposed research result does not satisfy its consumer contract");
  const draft = inputStore.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(draft?.kind === "discovery-draft", "draft_missing", "The research context is missing");
  const turn = managedPending ? managedTurn(store, managedPending, draft, question, action) : null;
  const canonicalRoot = priorOrigin ? priorOrigin.value.root : managedPending ? realpathSync(root) : root;
  if (turn && !priorOrigin) {
    const sourceTurn = readResearchConsumerTurn(store, turn);
    const producerIntent = readResearchConsumerIntent(store, sourceTurn.value.consumerIntent);
    let producerRoot: string | null = null;
    try { producerRoot = realpathSync(producerIntent.value.dispatch.workspace); } catch { /* typed refusal below */ }
    requireCondition(producerRoot === canonicalRoot, 'research_assessment_binding_invalid',
      `[${turn.id}] The paid assessor workspace differs from its original dispatch`);
  }
  const legacyPaths: LegacyPathResolution[] = priorOrigin ? priorOrigin.value.legacyPaths : [];
  let proposalGraph: Ref | null = null;
  const evidence = new Evidence(readView?.store ?? store);
  const observations = action.citations.map(item => evidence.observe(question.value.projectId, item.source, item.selector));
  requireCondition(environment.value.implementer.actor !== environment.value.reviewer.actor, "assessor_not_independent", "Research assessment requires a separate actor");

  // The runtime result and the admission material it derives from are one selection (№2141): a restore takes both from
  // M, a fresh assessment derives both now and saves them together.
  const selection = priorOrigin ? { runtime: priorOrigin.value.runtime, admission: priorOrigin.value.runtimeAdmission }
    : schemaOk ? collectRuntimeSelection(store,question.value.projectId,question.value.spec, action.value as unknown as TechnicalReport,observations)
    : { runtime: { proofs: [], supporting: [], guards: [], admissionGuards: [] }, admission: emptyRuntimeAdmission() };
  const runtime = selection.runtime;
  const runtimeGuards = uniqueTransactionGuards([...runtime.guards, ...runtime.admissionGuards]);
  if (draft.value.stage === "om-g2" && ["R1", "R2"].includes(draft.value.level)
    && (draft.value.consumer === "compilation" || question.value.spec.field === 'layerDesign')) {
    const graph = inputStore.get<Graph>(`graph:${draft.value.projectId}`)!;
    requireCondition(graph?.kind === 'graph' && hashJson(graph.value) === graph.hash,
      'research_proposal_invalid', `[graph:${draft.value.projectId}] Technical proposal needs its exact graph`);
    proposalGraph = reference(graph);
    // The paid L3 proposal composes against its exact original graph — the
    // captured head for a fresh dispatch, the saved origin revision for a
    // restore — never today's moved head (№1971-5, R11, №1318-2).
    if (schemaOk && draft.value.level === 'R2' && question.value.spec.field === 'layerDesign')
      requirePaidLayerAssembly(store, draft, question, graph, action.value);
    if (draft.value.consumer === 'compilation') {
      const findings: Finding[] = !schemaOk
        ? [{ code: 'answer_invalid', target: question.id, field: question.value.spec.field,
            message: 'Proposed research result does not satisfy its consumer contract' }]
        : technicalProposalFindings(inputStore, draft.value.projectId, draft.value.level, question.id, question.value.spec.field,
          action.value as unknown as TechnicalReport, observations, graph.value, canonicalRoot,runtime,
          managedPending ? { mode: priorOrigin ? 'historical' : 'current', legacyPaths } : undefined);
      const pause = findings.find(finding => OBLIGATION_EVIDENCE_PAUSES.has(finding.code));
      if (pause) throw new EngineError(pause.code,`[${pause.target}] ${pause.message}`,findings);
      if (findings.length) {
        if (managedPending && !priorOrigin && turn && readView)
          throw prepareManagedProposalRefusal(draft.value.projectId, turn, managedPending,
            draft, question, environment, proposalGraph!, canonicalRoot, legacyPaths,
            readView.finish(), runtime, findings,
            uniqueTransactionGuards([...runtimeGuards, ...readView.guards]));
        if (priorOrigin) throw new EngineError('research_assessment_materials_invalid',
          'The paid assessor origin contradicts its original technical precheck', findings);
        throw new EngineError('research_proposal_invalid', PROPOSAL_REFUSAL_MESSAGE, findings);
      }
    } else requireCondition(schemaOk, 'answer_invalid',
      'Proposed research result does not satisfy its consumer contract');
  } else requireCondition(schemaOk, 'answer_invalid',
    'Proposed research result does not satisfy its consumer contract');
  const dispatch = priorOrigin?.value.dispatch
    ?? { ...(pilot ? pilotEnvironment(environment.value, pilot.value) : environment.value), workspace: canonicalRoot };
  const bases = question.value.spec.basisContract === 'typed-v1'
    ? resolveResearchBasis(inputStore, draft.value.projectId, action.value as unknown as TechnicalReport, observations,
      canonicalRoot, question.value.spec.field, priorOrigin ? 'historical' : 'current').bases : undefined;
  const sourceLocations = (priorOrigin ? originalPilot : pilot) ? observations.map(o => ({ source: o.source,
    location: inputStore.get<any>(o.source.id)!.value.origin.location })) : undefined;
  const assessmentReads = readView?.finish();
  // Exact quotes are already in the paged candidate and observations. Keep only
  // machine bindings mandatory instead of duplicating every quote on every page.
  const basisBindings = bases?.map(({ quote: _quote, ...binding }) => binding);
  const pilotPacket = !priorOrigin && pilot ? pilotContext(store, draft, question) : null;
  const assessmentObservations=[...observations,...runtime.supporting];
  const computedContext = priorOrigin ? null : pilotPacket ? { ...pilotPacket, ...(basisBindings ? { bases: basisBindings } : {}), ...(runtime.proofs.length?{runtimeProofs:runtime.proofs}:{}), role: "assess-answer", question: question.value.spec,
    sourceLocations: sourceLocations!,
    value: question.value.spec.field === "layerDesign" ? layerDeltaView(store, draft.value.projectId, action.value, draft.value.level === "R2" ? 3 : 2, question.value.spec.layerAssembly) : action.value,
    representation: question.value.spec.field === "layerDesign" ? "changes_against_exact_base_after_machine_L2_validation" : "complete_field",
    observations:assessmentObservations, consumerFeedback: consumerFeedback(store, draft.value) }
    : { role: "assess-answer", ...(basisBindings ? { bases: basisBindings } : {}), ...(runtime.proofs.length?{runtimeProofs:runtime.proofs}:{}), question: question.value.spec, value: action.value, observations:assessmentObservations,
      prerequisites: researchPrerequisites(store, draft.value), operationMap: researchGraphContext(store, draft.value),
      consumerFeedback: consumerFeedback(store, draft.value) };
  const context = priorOrigin?.value.context ?? computedContext!;
  const prompt = priorOrigin?.value.prompt ?? assessmentPrompt(bases, question.value.spec.obligationContract);
  const paidOrigin: AssessmentPaidOriginInput | undefined = managedPending && assessmentReads
    ? { pending: managedPending, root: canonicalRoot, graph: proposalGraph, legacyPaths, reads: assessmentReads, runtime, runtimeAdmission: selection.admission }
    : undefined;
  const delivered = managedPending
    ? await assessmentSessionWithProof(store, draft, question, environment, dispatch, pilot, context, prompt, signal,
      uniqueTransactionGuards([...runtimeGuards, ...(readView?.guards ?? [])]), paidOrigin)
    : { result: await assessmentSession(store, draft, question, environment, dispatch, pilot, context, prompt, signal,runtimeGuards), proof: null };
  const response = delivered.result as { verdict?: unknown; reasons?: unknown } | null;
  requireCondition(response !== null && response !== undefined, 'assessment_invalid', 'Assessment returned no verdict');
  const value = assessmentValue(question, action, environment, observations, bases, runtime.proofs,
    response as { verdict: unknown; reasons: unknown });
  const id = `research-assessment:${hashJson(value)}`;
  const existing = store.get<ResearchAssessment>(id);
  if (!managedPending) return existing ?? store.writeMany<ResearchAssessment>([{ id, kind: "research-assessment", expected: 0, value }],
    uniqueTransactionGuards([reference(question), reference(environment), ...draft.value.inputs, ...observations.map(item => item.source),
      ...runtimeGuards]))[0]!;
  requireCondition(delivered.proof && turn && assessmentReads, 'research_assessment_binding_invalid',
    'A managed paid answer needs its exact terminal assessor and read proof');
  const assessmentRef: Ref = existing ? reference(existing) : { id, revision: 1, hash: hashJson(value) };
  requireCondition(!existing || existing.kind === 'research-assessment' && existing.revision === 1
    && existing.id === `research-assessment:${hashJson(existing.value)}`
    && existing.hash === hashJson(existing.value) && same(existing.value, value),
    'research_assessment_binding_invalid', 'An existing assessment differs from its managed producer');
  const binding: ResearchAssessmentBinding = { contract: ASSESSMENT_BINDING, projectId: question.value.projectId,
    turn, pending: managedPending, assessment: assessmentRef, draft: reference(draft), question: reference(question),
    environment: reference(environment), session: delivered.proof.session, application: delivered.proof.application,
    reads: assessmentReads };
  const bindingId = assessmentBindingId(question.value.projectId, turn.id);
  const prior = store.get<ResearchAssessmentBinding>(bindingId);
  if (prior) {
    readResearchAssessmentAt(store, question.value.projectId, turn.id, assessmentRef);
    requireCondition(same(prior.value, binding), 'research_assessment_binding_invalid',
      'A managed turn cannot be rebound to another assessment');
    return existing!;
  }
  const writes: Write[] = [
    ...(!existing ? [{ id, kind: 'research-assessment', expected: 0, value }] : []),
    { id: bindingId, kind: 'research-assessment-binding', expected: 0, value: binding }
  ];
  // The assessor has already consumed a physical response. These are exact
  // historical inputs now; a later Source or graph head must not discard the
  // paid result while the pending turn and terminal application still match.
  // Terminal/application/origin are immutable exact historical evidence. A
  // later session cursor must not discard an already paid answer before the
  // pending turn can bind it; only that pending turn remains a current CAS.
  const guards: TransactionGuard[] = [managedPending];
  store.writeMany(writes, guards);
  return exact<ResearchAssessment>(store, assessmentRef, 'research-assessment');
}

/** The managed answer is read under the exact paid turn, terminal assessor, and
 * original captured evidence. Later Source, question, session or call heads do
 * not reinterpret its historical assessment. */
export function readResearchAssessmentAt(store: Store, projectId: string, turnId: string,
  assessmentRef: Ref): Revision<ResearchAssessment> {
  requireCondition(typeof projectId === 'string' && projectId.trim() && typeof turnId === 'string' && turnId.trim()
    && isRef(assessmentRef), 'research_assessment_binding_invalid', 'Managed assessment needs an exact turn and result');
  const binding = store.get<ResearchAssessmentBinding>(assessmentBindingId(projectId, turnId));
  requireCondition(binding?.kind === 'research-assessment-binding' && binding.revision === 1
    && binding.value !== null && typeof binding.value === 'object'
    && hashJson(binding.value) === binding.hash && binding.value.contract === ASSESSMENT_BINDING
    && binding.value.projectId === projectId && isRef(binding.value.turn)
    && binding.value.turn.id === turnId && binding.value.turn.revision === 1
    && isRef(binding.value.assessment) && same(binding.value.assessment, assessmentRef)
    && isRef(binding.value.pending) && binding.value.pending.id === turnId
    && isRef(binding.value.draft) && isRef(binding.value.question) && isRef(binding.value.environment)
    && isRef(binding.value.session) && isRef(binding.value.application)
    && binding.value.reads !== null && typeof binding.value.reads === 'object'
    && binding.value.reads.contract === 'assessment-read/v1',
    'research_assessment_binding_invalid', `[${turnId}] Managed assessment origin is missing or malformed`);
  const value = binding.value;
  const draft = exact<DiscoveryDraft>(store, value.draft, 'discovery-draft');
  const question = exact<Question>(store, value.question, 'question');
  const environment = exact<Environment>(store, value.environment, 'environment');
  requireCondition(draft.value.projectId === projectId && question.value.projectId === projectId
    && question.value.draftId === draft.id && environment.value.projectId === projectId,
    'research_assessment_binding_invalid', `[${turnId}] Managed assessment sources belong to another project`);
  const first = readResearchConsumerTurn(store, value.turn);
  const pending = readResearchConsumerTurn(store, value.pending);
  const paid = researchAction(first.value.action);
  requireCondition(same(reference(first), value.turn) && same(reference(pending), value.pending)
    && pending.value.status === 'pending' && same(pending.value.question, value.question)
    && (paid.action === 'answer' || paid.action === 'answer_delta') && paid.question === question.id,
    'research_assessment_binding_invalid', `[${turnId}] Managed assessment lost its paid answer`);
  const action: Extract<ResearchAction, { action: 'answer' }> = paid.action === 'answer' ? paid
    : { action: 'answer', question: paid.question,
      value: expandLayerDelta(store, draft, question, paid, 'historical'), citations: paid.citations };
  const outcome = readAssessmentSessionOutcomeAt(store, projectId, value.session, value.application);
  const origin = readAssessmentPaidOrigin(store, projectId, value.pending);
  requireCondition(origin && same(outcome.origin, reference(origin))
    && same(origin.value.reads, value.reads)
    && origin.value.root === outcome.dispatch.workspace,
    'research_assessment_binding_invalid', `[${turnId}] The assessment lost its original pre-dispatch materials`);
  requireCondition(isRef(first.value.consumerIntent), 'research_assessment_binding_invalid',
    `[${turnId}] The paid assessor lost its original dispatch`);
  readResearchConsumerIntent(store, first.value.consumerIntent);
  const savedPilot = outcome.profile ? exact<ReaderPilot>(store, outcome.profile, 'reader-pilot') : null;
  const expectedDispatch = {
    ...(savedPilot ? pilotEnvironment(environment.value, savedPilot.value) : environment.value),
    workspace: origin.value.root
  };
  requireCondition(same(outcome.draft, value.draft) && same(outcome.question, value.question)
    && same(outcome.environment, value.environment) && same(outcome.inputs, draft.value.inputs)
    && same(outcome.dispatch, expectedDispatch) && same(outcome.role, expectedDispatch.reviewer)
    && outcome.context.role === 'assess-answer' && same(outcome.context.question, question.value.spec),
    'research_assessment_binding_invalid', `[${turnId}] The terminal assessor belongs to another question or reviewer`);
  const view = assessmentReadView(store, origin.value.reads);
  requireDocumentarySources(view.store, projectId, question.value.spec);
  const capturedDraft = view.store.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(capturedDraft && same(reference(capturedDraft), value.draft),
    'research_assessment_binding_invalid', `[${turnId}] The captured proposal uses another draft`);
  const observations = action.citations.map(item => new Evidence(view.store).observe(projectId, item.source, item.selector));
  const runtime = origin.value.runtime;
  if (draft.value.stage === 'om-g2' && ['R1', 'R2'].includes(draft.value.level)
    && (draft.value.consumer === 'compilation' || question.value.spec.field === 'layerDesign')) {
    const graph = view.store.get<Graph>(`graph:${projectId}`);
    requireCondition(graph?.kind === 'graph' && same(reference(graph), origin.value.graph),
      'research_assessment_binding_invalid', `[${turnId}] The original technical graph is missing`);
    // The reader re-derives the paid L3 assembly against the exact saved graph
    // so a later head mutation cannot alter it (№1971-5, R11, №1318-2).
    if (draft.value.level === 'R2' && question.value.spec.field === 'layerDesign') {
      const schemaOk = new Ajv({ strict: true, allowUnionTypes: true })
        .compile(question.value.spec.schema as object)(action.value);
      if (schemaOk) requirePaidLayerAssembly(store, draft, question, graph, action.value);
    }
    if (draft.value.consumer === 'compilation') {
      const findings = technicalProposalFindings(view.store, projectId, draft.value.level, question.id,
        question.value.spec.field, action.value as unknown as TechnicalReport, observations, graph.value,
        origin.value.root, runtime, { mode: 'historical', legacyPaths: origin.value.legacyPaths });
      requireCondition(findings.length === 0, 'research_assessment_binding_invalid',
        `[${turnId}] The saved proposal fails its original technical checks`);
    }
  } else requireCondition(origin.value.graph === null && origin.value.legacyPaths.length === 0,
    'research_assessment_binding_invalid', `[${turnId}] A nontechnical assessment has foreign technical inputs`);
  const resolved = question.value.spec.basisContract === 'typed-v1'
    ? resolveResearchBasis(view.store, projectId, action.value as unknown as TechnicalReport,
      observations, origin.value.root, question.value.spec.field, 'historical') : null;
  requireCondition(!resolved?.findings.length, 'research_assessment_binding_invalid',
    `[${turnId}] The paid proposal has invalid typed bases`);
  const bases = resolved?.bases;
  const sourceLocations = origin.value.profile ? observations.map(o => ({ source: o.source,
    location: view.store.get<any>(o.source.id)!.value.origin.location })) : undefined;
  view.finish();
  requireCondition(!origin.value.profile || question.value.spec.field !== 'layerDesign' || paid.action === 'answer_delta',
    'research_assessment_binding_invalid', 'A piloted layer design must retain its exact original delta');
  const represented = origin.value.profile && question.value.spec.field === 'layerDesign'
    ? layerDeltaView(store, projectId, action.value, draft.value.level === 'R2' ? 3 : 2,
      question.value.spec.layerAssembly, { mode: 'historical', graph: (paid as Extract<ResearchAction, { action: 'answer_delta' }>).base })
    : action.value;
  const strippedBases = bases?.map(({ quote: _quote, ...rest }) => rest);
  requireCondition(same(outcome.context.value, represented)
    && same(outcome.context.observations, [...observations, ...runtime.supporting])
    && same(outcome.context.bases ?? null, strippedBases ?? null)
    && same(outcome.context.runtimeProofs ?? [], runtime.proofs)
    && same(outcome.context.representation ?? null, origin.value.profile
      ? question.value.spec.field === 'layerDesign'
        ? 'changes_against_exact_base_after_machine_L2_validation' : 'complete_field'
      : null)
    && (!origin.value.profile || same(outcome.context.sourceLocations, sourceLocations))
    && outcome.prompt === assessmentPrompt(bases, question.value.spec.obligationContract),
    'research_assessment_binding_invalid', `[${turnId}] The assessor context does not derive from the paid proposal and exact sources`);
  const projected = assessmentValue(question, action, environment, observations, bases, runtime.proofs,
    outcome.result as { verdict: unknown; reasons: unknown });
  const assessment = exact<ResearchAssessment>(store, assessmentRef, 'research-assessment');
  requireCondition(assessment.revision === 1 && assessment.id === `research-assessment:${hashJson(projected)}`
    && same(assessment.value, projected),
    'research_assessment_binding_invalid', `[${turnId}] Saved assessment does not derive from its exact paid producer`);
  return assessment;
}

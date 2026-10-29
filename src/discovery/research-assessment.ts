import { hasDiscoveryHandoff, hasDiscoveryHandoffScope, withDiscoveryHandoffAt } from './discovery-handoff.js';
import { hasV7PlanCoverage } from './v7-contracts.js';
import { readV7PlanBasis, requireV7PlanBasisAt, V7_PLAN_ASSESSMENT_PROMPT } from './v7-plan-assessment.js';
import { DOSSIER_ASSESSMENT_KIND, DOSSIER_ASSESSMENT_CONTRACT, type PaidDossierAssessment } from './dossier-manifest.js';
import { runDossierAssessmentSession, readDossierAssessmentSessionAt, DOSSIER_APPLICATION,
  type DossierAssessmentApplication } from './assessment-session.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { packetAssessmentSubject, methodologyAssessmentTransport, requirementsAssessmentTransport, assessmentQuestionContract, type AssessmentTransportSubject } from './continuation-packet.js';
import { proveAttemptPacket, checkProgressBaseline, baselineGuards, checkDiscoveryAssessmentForm,
  DISCOVERY_ASSESSMENT_KIND, savedV7ProgressApplication, type ProvenAttemptPacket } from './v7-attempt-assessment.js';
import { resolveClaimAddress, type ClaimAddress } from './claim-address.js';
import { DISCOVERY_ASSESSMENT_CONTRACT_V2, DISCOVERY_ASSESSMENT_CONTRACT_V3, type V7AttemptPacket, type V7ProgressBaseline,
  type DiscoveryAttemptsAssessmentV2, type DiscoveryAttemptsAssessmentV3, type PaidDiscoveryAttemptsAssessment } from './research-model.js';
import { stageNeighbors, usesStageNeighbors, STAGE_NEIGHBOR_CONTEXT, STAGE_NEIGHBOR_INSTRUCTION } from './stage-neighbors.js';
import { BASIS_APPLICATION_CONTRACT_ERA, contractEraOf, readDraft, readRecord, readStageArtifact } from './projection-reader.js';
import { discoveryContext, requireDiscoveryProposal } from './discovery-outcome.js';
import { v7FrameAssessment, v7FrameAssessmentBasis, V7_FRAME_ASSESSMENT_INSTRUCTION } from './v7-frame-assessment.js';
import { Ajv } from "ajv";
import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { historicalProof, historicalReadsReachGenuine, historicalSourceOverGenuine } from "../history/proofs.js";
import { isProxy } from "node:util/types";
import { Evidence } from "../evidence/evidence.js";
import { reference, isRef, stageId, uniqueRefs, type Ref, type Finding, type StageArtifact } from "../pipeline/contracts.js";
import { uniqueTransactionGuards, type Environment } from "../runtime/environment.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { realpathSync } from 'node:fs';
import { requireCondition, EngineError } from "../errors.js";
import type { Question, DiscoveryDraft } from "./discovery.js";
import { DIRECT_ASSESSMENT_ORIGIN, type ResearchAction, type ResearchAssessment } from "./research-model.js";
import { readDiscoveryBasisMaterial, researchPrerequisites, researchGraphContext,
  type InheritanceProposal } from "./research-context.js";
import { consumerFeedback } from "./consumer-feedback.js";
import { pilotEnvironment, type ReaderPilot } from "./reader-pilot.js";
import { pilotContext } from "./pilot-context.js";
import { layerDeltaView, expandLayerDelta } from "./layer-delta.js";
import { technicalProposalFindings, type LegacyPathResolution } from "../graph/research-evidence.js";
import type { TechnicalReport } from "../graph/research-contracts.js";
import type { Graph } from "../graph/model.js";
import { assessmentSessionWithProof, readAssessmentSessionOutcomeAt,
  readAssessmentPaidOrigin, readDirectAssessmentMaterials, type AssessmentPaidOriginInput } from "./assessment-session.js";
import { assessmentReadView, readResearchConsumerIntent, readResearchConsumerTurn,
  prepareManagedProposalRefusal, type AssessmentReadProof } from './response-recovery.js';
import { researchAction, projectPaidAttemptsAssessment, discoveryAssessmentId } from './research-consumer-transition.js';
import { resolveResearchBasis } from '../graph/research-basis.js';
import { OBLIGATION_EVIDENCE_PAUSES, requireDocumentarySources } from '../graph/obligation-evidence.js';
import { collectRuntimeSelection, emptyRuntimeAdmission } from '../graph/runtime-evidence.js';
import { obligationHandoff } from '../graph/obligation-handoff.js';
import { requireTaskObligations } from '../graph/task-obligations.js';
import { composeLayer } from '../graph/layer-design.js';
import { conceptApplicationFindings, requiresConceptApplications,
  requiresSpecificationApplications, specificationApplicationFindings } from './preparation-validation.js';

const ASSESSMENT_BINDING = 'research-assessment-binding/v1' as const;
const PROPOSAL_REFUSAL_MESSAGE = 'Correct the typed proposal findings before model assessment';
interface ResearchAssessmentBinding {
  contract: typeof ASSESSMENT_BINDING; projectId: string; turn: Ref; pending: Ref;
  assessment: Ref; draft: Ref; question: Ref; environment: Ref;
  session: Ref; application: Ref; reads: AssessmentReadProof;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function inheritanceProposal(draft: DiscoveryDraft, question: Question, value: Json): InheritanceProposal | undefined {
  if (contractEraOf(draft) !== BASIS_APPLICATION_CONTRACT_ERA) return undefined;
  if (draft.stage === 'operation-map' && question.spec.field === 'mapDesign') return { field: 'mapDesign', value };
  if (draft.stage === 'features' && question.spec.field === 'featurePreparation') return { field: 'featurePreparation', value };
  return undefined;
}
function assessmentPrompt(bases: ResearchAssessment['bases'] | undefined, obligationContract: unknown,
  discoveryPreparation = false, neighbors = false, conceptApplications = false, specificationGrounds = false, plan = false): string {
  return "Evaluate whether the supplied observations actually support the proposed answer to this exact question and all its required details. Source hashes prove identity only. A fact needs relevant evidence of the claimed behavior, not an unrelated quote, a plan, or model confidence. For kind=decision, only existing explicit owner intent supports the value. For kind=design, evaluate a model-authored proposal for completeness, usefulness to the named consumer, consistency with the supplied intent and constraints; it may introduce a design but must not pretend it is existing implementation or a new owner decision. Reject invented facts, unsupported inapplicability, and empty generic filler. Return JSON {verdict: supported|insufficient|conflicting, reasons: string[]}. If unsupported or contradictory explain exactly why. Do not change files or perform external actions." + (bases ? " bases[].proofLimit limits the claim: quoted-intent-requires-attribution requires establishing explicit attributable owner intent, not trusting the document ingestion label; reported-not-runtime-proof is a documentary report and does not establish current environment behavior or completed implementation. Preserve documentary support with its stated limits instead of promoting it to a repository fact or discarding it." : "") + (obligationContract ? " Assess each coverage member against its fixed assignment.kind and consumer. A documentaryAllowance only admits the named source: the actual claim must stay within assignment.documentaryAllowance.claimLimit and the quoted evidence. Reject broader claims; admission of a document does not certify runtime behavior or implementation." : "") + (discoveryPreparation ? ' For Discovery preparation, compare every rule with its addressed report constraint: a correct basis with opposite meaning is not supported. The outcomes, scenarios and external systems must develop verdict.variant without replacing it; preserve its risks and unresolved questions with their moments. Exact owner choices select conditions, not facts of feasibility.' : '') + (neighbors ? STAGE_NEIGHBOR_INSTRUCTION + ' If a necessary premise is missing, classify support as insufficient.' : '') + (conceptApplications ? ' For conceptSections, compare each requirement and its acceptance criterion with the exact selected variant and every addressed constraint in discoveryBasisCatalogue. An address alone does not establish semantic consistency: reject an application whose requirement reverses the source rule. Evaluate the proposed benefit and outcome against the accepted Discovery goals. If the source material is insufficient, say what evidence is missing rather than inventing support.' : '') + (specificationGrounds ? ' For specification, compare the separate constraints strings with the exact selected Discovery variant and constraints; a new project limit is a proposal, not invented source provenance. For behaviorContracts, check each inherited requirement ground against the addressed entry, inputs, success, failures, forbiddenEffects, state, compatibility or proof of that same contract. An exact address alone does not establish semantic consistency. Use the accepted conceptSections in prerequisites and the accepted prior fields in stageNeighbors; do not treat pending fields as accepted.' : '') + (plan ? '\n' + V7_PLAN_ASSESSMENT_PROMPT : '');
}
function assessmentBasisMaterial(store: Store, draft: Revision<DiscoveryDraft>) {
  if (contractEraOf(draft.value) !== BASIS_APPLICATION_CONTRACT_ERA || !['concept', 'specification'].includes(draft.value.stage)) return null;
  const discovery = readDiscoveryBasisMaterial(store, draft.value);
  if (draft.value.stage === 'concept') return { ...discovery, concept: null };
  const id = stageId(draft.value.projectId, 'concept');
  const refs = draft.value.inputs.filter(ref => ref.id === id), ref = refs[0];
  requireCondition(refs.length === 1 && isRef(ref), 'basis_application_material_invalid',
    `[${id}] Specification needs its exact accepted concept source`);
  const record = readStageArtifact<StageArtifact>(store, ref.id, ref.revision);
  requireCondition(record?.kind === 'stage' && same(reference(record), ref)
    && record.value.projectId === draft.value.projectId && record.value.stage === 'concept'
    && record.value.status === 'accepted' && record.value.inputs.some(input => same(input, discovery.source)),
    'basis_application_material_invalid', `[${id}] Concept and Discovery are not one accepted chain`);
  const content = record.value.content as { fields?: Record<string, Json> } | null;
  requireCondition(content?.fields && Object.hasOwn(content.fields, 'conceptSections'),
    'basis_application_material_invalid', `[${id}] Accepted concept requirements are missing`);
  return { ...discovery, concept: content.fields['conceptSections'], guards: [...discovery.guards, reference(record)] };
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
  const saved = readRecord<T>(store, ref.id, ref.revision);
  requireCondition(saved?.kind === kind && same(reference(saved), ref) && hashJson(saved.value) === saved.hash,
    'research_assessment_binding_invalid', `[${ref.id}] Exact assessment source is missing, foreign or changed`);
  return saved;
}
function managedTurn(store: Store, pendingRef: Ref, draft: Revision<DiscoveryDraft>, question: Revision<Question>, action: Extract<ResearchAction, { action: 'answer' }>): Ref {
  const pending = readResearchConsumerTurn(store, pendingRef);
  const first = readResearchConsumerTurn(store, { id: pendingRef.id, revision: 1,
    hash: readRecord(store, pendingRef.id, 1)?.hash ?? '' });
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
  bases: ResearchAssessment['bases'], runtimeProofs: ResearchAssessment['runtimeProofs'], response: { verdict: unknown; reasons: unknown },
  origin?: ResearchAssessment['origin']): ResearchAssessment {
  requireCondition(['supported', 'insufficient', 'conflicting'].includes(String(response.verdict))
    && Array.isArray(response.reasons) && response.reasons.every(item => typeof item === 'string')
    && (response.verdict === 'supported' || response.reasons.length > 0),
  'assessment_invalid', 'Assessment must explicitly classify support and explain unresolved evidence');
  return { projectId: question.value.projectId, question: reference(question), value: action.value,
    ...(bases ? { bases } : {}), ...(runtimeProofs?.length ? { runtimeProofs } : {}), observations,
    verdict: response.verdict as ResearchAssessment['verdict'], reasons: response.reasons as string[],
    researcher: environment.value.implementer.actor, assessor: environment.value.reviewer.actor,
    environment: reference(environment), ...(origin ? { origin } : {}) };
}

type AssessmentProof = ReturnType<typeof readAssessmentSessionOutcomeAt>;
const object = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
function originInvalid(id: string, message: string): never {
  throw new EngineError('research_assessment_origin_invalid', `[${id}] ${message}`);
}
/** ASM1.1 (№4791): the accepted prefix a saved assessor material was judged on — each neighbor's exact question and answer,
 * the pending neighbor, and the Discovery grounds with their owner decisions. Null when the material carries no prefix. */
function materialPrefix(context: Record<string, any>, id: string): Ref[] | null {
  const neighbors = context.assessmentContextContract === STAGE_NEIGHBOR_CONTEXT ? context.stageNeighbors : undefined;
  const discovery = object(context.discoveryContext) ? context.discoveryContext : undefined;
  const catalogue = context.discoveryBasisCatalogue;
  const frame = context.v7Frame;
  if (neighbors === undefined && discovery === undefined && catalogue === undefined && frame === undefined && context.planBasis === undefined) return null;
  const refs: Ref[] = [];
  if (frame !== undefined) refs.push(...v7FrameAssessmentBasis(frame));
  if (context.planBasis !== undefined) {
    const plan = context.planBasis;
    if (!object(plan) || plan.contract !== 'v7-plan-basis/v1' || !Array.isArray(plan.prefix)
      || plan.prefix.length !== 3 || !plan.prefix.every(isRef))
      originInvalid(id, 'The plan assessor lost its exact accepted prefix');
    refs.push(...plan.prefix);
  }
  if (catalogue !== undefined) {
    if (!object(catalogue) || !['discovery-basis-catalogue/v1', 'discovery-basis-catalogue/v2'].includes(catalogue.contract) || !isRef(catalogue.source))
      originInvalid(id, 'The saved assessor material lost its exact Discovery basis catalogue');
    refs.push(catalogue.source);
  }
  if (neighbors !== undefined) {
    if (!object(neighbors) || neighbors.contract !== 'stage-neighbors/v1' || !Array.isArray(neighbors.fields)
      || !neighbors.fields.every((row: unknown) => object(row) && isRef(row.question) && isRef(row.answer))
      || !(neighbors.pending === null || object(neighbors.pending) && isRef(neighbors.pending.question)))
      originInvalid(id, 'The saved assessor material lost its exact neighbors');
    for (const row of neighbors.fields) refs.push(row.question, row.answer);
    if (neighbors.pending) refs.push(neighbors.pending.question);
  }
  if (discovery !== undefined) {
    const fields: unknown[] = object(discovery.fields) ? Object.values(discovery.fields) : [];
    if (!object(discovery.fields) || !fields.every(row => object(row) && isRef(row.question) && isRef(row.answer))
      || !Array.isArray(discovery.ownerDecisions) || !discovery.ownerDecisions.every((round: unknown) => object(round)
        && Array.isArray(round.decisions) && round.decisions.every((decision: unknown) => object(decision) && isRef(decision.ref))))
      originInvalid(id, 'The saved assessor material lost its exact Discovery grounds');
    for (const row of fields as { question: Ref; answer: Ref }[]) refs.push(row.question, row.answer);
    for (const round of discovery.ownerDecisions) for (const decision of round.decisions) refs.push(decision.ref);
  }
  return uniqueRefs(refs);
}
/** ASM1.1: the one derivation of a direct assessment from its exact completed assessor material — the producer builds the
 * record with it and acceptance proves the record with it. Observations, bases and runtime proofs are those the material
 * showed the assessor; the verdict is the material's terminal result. */
function directAssessment(store: Store, projectId: string, proof: AssessmentProof, observations: ResearchAssessment['observations'],
  bases: ResearchAssessment['bases'], runtimeProofs: ResearchAssessment['runtimeProofs']): ResearchAssessment {
  const question = exact<Question>(store, proof.question, 'question');
  const environment = exact<Environment>(store, proof.environment, 'environment');
  const shown = proof.context;
  if (hasV7PlanCoverage(question.value.spec)) requireV7PlanBasisAt(store, question, shown.value, shown.planBasis);
  if (question.value.projectId !== projectId || !Array.isArray(shown.observations)
    || !same(shown.observations.slice(0, observations.length), observations)
    || !same(shown.bases ?? null, bases ? bases.map(({ quote: _quote, ...binding }) => binding) : null)
    || !same(shown.runtimeProofs ?? [], runtimeProofs ?? []))
    originInvalid(proof.application.id, 'The assessment differs from the material its assessor saw');
  return assessmentValue(question, { action: 'answer', question: question.id, value: shown.value, citations: [] }, environment,
    observations, bases, runtimeProofs, proof.result as { verdict: unknown; reasons: unknown },
    { contract: DIRECT_ASSESSMENT_ORIGIN, session: proof.session, application: proof.application });
}
/**
 * ASM1.1 (№4791): the exact prefix a direct assessment was judged on, re-read from its own completed session and application
 * by the common terminal reader — never from today's neighbors — once the assessment is re-derived from that material.
 * Null for an assessment made before its producer bound the material: it keeps the reading of its era.
 */
export function directAssessmentBasis(store: Store, assessment: Revision<ResearchAssessment>): Ref[] | null {
  const origin = assessment.value.origin;
  if (origin === undefined) return null;
  if (!object(origin) || origin.contract !== DIRECT_ASSESSMENT_ORIGIN || !isRef(origin.session) || !isRef(origin.application)
    || assessment.value.reusedFrom !== undefined)
    originInvalid(assessment.id, 'A direct assessment names its exact completed assessor session and application');
  const proof = readAssessmentSessionOutcomeAt(store, assessment.value.projectId, origin.session, origin.application);
  const prefix = materialPrefix(proof.context, assessment.id);
  if (prefix === null) originInvalid(assessment.id, 'A bound direct assessment stands on a material with an accepted prefix');
  if (!same(directAssessment(store, assessment.value.projectId, proof, assessment.value.observations,
    assessment.value.bases, assessment.value.runtimeProofs), assessment.value))
    originInvalid(assessment.id, 'The assessment is not what its exact assessor material produced');
  return prefix;
}

export async function assessAnswer(store: Store, question: Revision<Question>, action: Extract<ResearchAction, { action: "answer" }>,
  environment: Revision<Environment>, root: string, signal?: AbortSignal, pilot?: Revision<ReaderPilot>, managedPending?: Ref): Promise<Revision<ResearchAssessment>> {
  if (question.value.stage === 'discovery' && question.value.spec.field === 'frame') {
    try { action = JSON.parse(JSON.stringify(action)); }
    catch { throw new EngineError('answer_invalid', 'The frame proposal must be a JSON snapshot'); }
  }
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
  const draft = readDraft(inputStore, question.value.draftId);
  requireCondition(draft?.kind === "discovery-draft", "draft_missing", "The research context is missing");
  // Only new evaluations require today's mandate. A paid origin replays its
  // captured reads; an origin predating frame material retains its own era.
  const frame = !priorOrigin || Object.hasOwn(priorOrigin.value.context, 'v7Frame')
    ? v7FrameAssessment(inputStore, draft, question) : null;
  if (priorOrigin && frame) requireCondition(same(frame.context, priorOrigin.value.context['v7Frame']),
    'research_assessment_binding_invalid', 'The saved frame assessment lost its accepted mandate');
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
  if (frame && !observations.some(item => same(item, frame.context.brief.observation)))
    observations.push(frame.context.brief.observation);
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
    location: readRecord<any>(inputStore, o.source.id)!.value.origin.location })) : undefined;
  const related = discoveryContext(inputStore, draft, question);
  if (priorOrigin) requireCondition(same(related.context, priorOrigin.value.context['discoveryContext'] ?? null),
    'research_assessment_binding_invalid', 'The saved assessor context lost its accepted Discovery grounds');
  requireDiscoveryProposal(draft.value, question, action.value, related.context, observations.length);
  // Old paid origins retain the material of their own issued contract.
  const planBasis = !priorOrigin || priorOrigin.value.context['planBasis'] !== undefined
    ? readV7PlanBasis(inputStore, draft.value, question, action.value) : null;
  if (priorOrigin && planBasis) requireCondition(same(priorOrigin.value.context['planBasis'], planBasis.context),
    'research_assessment_binding_invalid', 'The plan assessor lost its exact accepted frame and mandate');
  const basisMaterial = assessmentBasisMaterial(inputStore, draft);
  const specificationApplications = requiresSpecificationApplications(draft.value, question.value);
  if (basisMaterial && schemaOk && (requiresConceptApplications(draft.value, question.value) || specificationApplications)) {
    const finding = (specificationApplications
      ? specificationApplicationFindings(action.value, basisMaterial.concept!, basisMaterial.catalogue)
      : conceptApplicationFindings(action.value, basisMaterial.catalogue))[0];
    if (finding) {
      if (priorOrigin) throw new EngineError('research_assessment_binding_invalid',
        `[${question.id}] The saved proposal contradicts its original basis`, finding);
      throw new EngineError(finding.code, `[${finding.target}] ${finding.message}`, finding);
    }
  }
  if (priorOrigin && basisMaterial) requireCondition(
    same(priorOrigin.value.context['discoveryBasisCatalogue'] ?? null, basisMaterial.catalogue),
    'research_assessment_binding_invalid', `[${question.id}] The paid assessor lost its exact Discovery catalogue`);
  // Exact quotes are already in the paged candidate and observations. Keep only
  // machine bindings mandatory instead of duplicating every quote on every page.
  const basisBindings = bases?.map(({ quote: _quote, ...binding }) => binding);
  const pilotPacket = !priorOrigin && pilot ? pilotContext(store, draft, question) : null;
  const assessmentObservations=[...observations,...runtime.supporting];
  const proposedInheritance = inheritanceProposal(draft.value, question.value, action.value);
  // New v6 producers capture these prerequisite reads with the paid answer.
  // A restore must consume the same reads before stageNeighbors, while older
  // producers keep their original (uncaptured) prerequisite material.
  if (priorOrigin && !originalPilot && contractEraOf(draft.value) === BASIS_APPLICATION_CONTRACT_ERA
    && ['specification', 'operation-map', 'features'].includes(draft.value.stage))
    requireCondition(same(priorOrigin.value.context['prerequisites'],
      researchPrerequisites(inputStore, draft.value, proposedInheritance)),
      'research_assessment_binding_invalid', `[${question.id}] The saved assessor lost its original prerequisites`);
  const computedContext = priorOrigin ? null : pilotPacket ? { ...pilotPacket, ...(basisBindings ? { bases: basisBindings } : {}), ...(runtime.proofs.length?{runtimeProofs:runtime.proofs}:{}), role: "assess-answer", question: question.value.spec,
    sourceLocations: sourceLocations!,
    value: question.value.spec.field === "layerDesign" ? layerDeltaView(store, draft.value.projectId, action.value, draft.value.level === "R2" ? 3 : 2, question.value.spec.layerAssembly) : action.value,
    representation: question.value.spec.field === "layerDesign" ? "changes_against_exact_base_after_machine_L2_validation" : "complete_field",
    observations:assessmentObservations, consumerFeedback: consumerFeedback(store, draft.value) }
    : { role: "assess-answer", ...(basisBindings ? { bases: basisBindings } : {}), ...(runtime.proofs.length?{runtimeProofs:runtime.proofs}:{}), question: question.value.spec, value: action.value, observations:assessmentObservations,
      prerequisites: planBasis ? [{ ref: planBasis.context.frame.answer, stage: 'discovery', fields: {} }] : researchPrerequisites(contractEraOf(draft.value) === BASIS_APPLICATION_CONTRACT_ERA
        && ['specification', 'operation-map', 'features'].includes(draft.value.stage)
        ? inputStore : store, draft.value, proposedInheritance), operationMap: researchGraphContext(store, draft.value),
      consumerFeedback: consumerFeedback(store, draft.value) };
  if (computedContext && planBasis) Object.assign(computedContext, { planBasis: planBasis.context });
  if (computedContext && related.context) Object.assign(computedContext, { discoveryContext: related.context });
  if (computedContext && frame) Object.assign(computedContext, { v7Frame: frame.context });
  if (computedContext && basisMaterial) Object.assign(computedContext, { discoveryBasisCatalogue: basisMaterial.catalogue });
  const direct = !managedPending && usesStageNeighbors(draft.value.stage) && computedContext
    ? readDirectAssessmentMaterials(store, draft, question, environment, computedContext,
      assessmentPrompt(bases, question.value.spec.obligationContract,
        related.context !== null && question.value.spec.field === 'preparation', false,
        requiresConceptApplications(draft.value, question.value), contractEraOf(draft.value) === BASIS_APPLICATION_CONTRACT_ERA
          && draft.value.stage === 'specification')) : null;
  const withNeighbors = priorOrigin ? priorOrigin.value.contract === 'assessment-paid-origin/v2'
    : direct ? direct.context.assessmentContextContract === STAGE_NEIGHBOR_CONTEXT : usesStageNeighbors(draft.value.stage);
  const neighbors = direct ? { context: direct.context.stageNeighbors ?? null, guards: direct.guards }
    : withNeighbors ? stageNeighbors(inputStore, draft, question) : { context: null, guards: [] };
  if (priorOrigin && withNeighbors) requireCondition(priorOrigin.value.context.assessmentContextContract === STAGE_NEIGHBOR_CONTEXT
    && neighbors.context !== null && priorOrigin.value.context.stageNeighbors !== undefined
    && same(neighbors.context, priorOrigin.value.context.stageNeighbors), 'research_assessment_binding_invalid',
    `[${question.id}] The saved assessor context lost its exact accepted neighbors`);
  const assessmentReads = readView?.finish();
  if (computedContext && withNeighbors) Object.assign(computedContext,
    { assessmentContextContract: STAGE_NEIGHBOR_CONTEXT, stageNeighbors: neighbors.context });
  const context = priorOrigin?.value.context ?? direct?.context ?? computedContext!;
  const prompt = priorOrigin?.value.prompt ?? direct?.prompt ?? (assessmentPrompt(bases, question.value.spec.obligationContract,
    related.context !== null && question.value.spec.field === 'preparation', withNeighbors,
    requiresConceptApplications(draft.value, question.value), contractEraOf(draft.value) === BASIS_APPLICATION_CONTRACT_ERA
      && draft.value.stage === 'specification', planBasis !== null) + (frame ? V7_FRAME_ASSESSMENT_INSTRUCTION : ''));
  const paidOrigin: AssessmentPaidOriginInput | undefined = managedPending && assessmentReads
    ? { ...(withNeighbors ? { materialContract: STAGE_NEIGHBOR_CONTEXT } : {}), pending: managedPending, root: canonicalRoot, graph: proposalGraph, legacyPaths, reads: assessmentReads, runtime, runtimeAdmission: selection.admission }
    : undefined;
  // A direct call has no paid origin; its completed session still yields the exact proof of what its assessor saw.
  const delivered = await assessmentSessionWithProof(store, draft, question, environment, dispatch, pilot, context, prompt, signal,
    uniqueTransactionGuards([...runtimeGuards, ...related.guards, ...neighbors.guards,
      ...(frame?.guards ?? []), ...(planBasis?.guards ?? []), ...(basisMaterial?.guards ?? []), ...(readView?.guards ?? [])]), paidOrigin);
  const response = delivered.result as { verdict?: unknown; reasons?: unknown } | null;
  requireCondition(response !== null && response !== undefined, 'assessment_invalid', 'Assessment returned no verdict');
  // ASM1.1 (№4791): a direct assessment on a prefixed material is bound to that exact material: its identity differs per
  // prefix and its acceptance guards the prefix the assessor saw. The material was saved before the call; a historical
  // standalone session without a terminal proof keeps its prior contract.
  const bound = !managedPending && delivered.proof && materialPrefix(delivered.proof.context, question.id) !== null ? delivered.proof : null;
  if (bound) requireCondition(same(bound.question, reference(question)) && same(bound.environment, reference(environment))
    && same(bound.context.value, action.value), 'research_assessment_binding_invalid',
    `[${question.id}] The direct assessor session judged another question, environment or candidate`);
  const value = bound ? directAssessment(store, question.value.projectId, bound, observations, bases, runtime.proofs)
    : assessmentValue(question, action, environment, observations, bases, runtime.proofs, response as { verdict: unknown; reasons: unknown });
  const id = `research-assessment:${hashJson(value)}`;
  const existing = readRecord<ResearchAssessment>(store, id);
  if (!managedPending) {
    const guards = uniqueTransactionGuards([reference(question), reference(environment), ...draft.value.inputs,
      ...observations.map(item => item.source), ...runtimeGuards, ...related.guards, ...neighbors.guards, ...(frame?.guards ?? []), ...(planBasis?.guards ?? [])]);
    if (existing) {
      // Returning an existing value is a current admission too: a second Store
      // may have changed the prefix after session selection or paid application.
      if (direct || withNeighbors || frame || planBasis) store.writeMany([], guards);
      return existing;
    }
    return store.writeMany<ResearchAssessment>([{ id, kind: "research-assessment", expected: 0, value }], guards)[0]!;
  }
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
  const prior = readRecord<ResearchAssessmentBinding>(store, bindingId);
  if (prior) {
    await readResearchAssessmentWithHandoffAt(store, question.value.projectId, turn.id, assessmentRef);
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

function checkedAssessmentBinding(store: Store, projectId: string, turnId: string, assessmentRef: Ref) {
  requireCondition(typeof projectId === 'string' && projectId.trim() && typeof turnId === 'string' && turnId.trim()
    && isRef(assessmentRef), 'research_assessment_binding_invalid', 'Managed assessment needs an exact turn and result');
  const binding = readRecord<ResearchAssessmentBinding>(store, assessmentBindingId(projectId, turnId));
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
  requireCondition(object(draft.value) && draft.value.projectId === projectId,
    'research_assessment_binding_invalid', `[${turnId}] The exact assessment draft is malformed or foreign`);
  return { binding, draft };
}

/** A cold external read reconstructs the exact C1 operation from the paid binding, never from a caller manifest. */
export async function readResearchAssessmentWithHandoffAt(store: Store, projectId: string, turnId: string,
  assessmentRef: Ref): Promise<Revision<ResearchAssessment>> {
  const { draft } = checkedAssessmentBinding(store, projectId, turnId, assessmentRef);
  const saved = JSON.parse(canonical({ projectId, turnId, assessmentRef })) as { projectId: string; turnId: string; assessmentRef: Ref };
  const read = () => readResearchAssessmentAt(store, saved.projectId, saved.turnId, saved.assessmentRef);
  return hasDiscoveryHandoff(store, draft.value) && !hasDiscoveryHandoffScope(store, draft.value)
    ? withDiscoveryHandoffAt(store, saved.projectId, reference(draft), read) : read();
}

/** The managed answer is read under the exact paid turn, terminal assessor, and
 * original captured evidence. Later Source, question, session or call heads do
 * not reinterpret its historical assessment. */
export function readResearchAssessmentAt(store: Store, projectId: string, turnId: string,
  assessmentRef: Ref): Revision<ResearchAssessment> {
  const { binding, draft } = checkedAssessmentBinding(store, projectId, turnId, assessmentRef);
  // PROOF-SPEED-2 (owner rule 08.10): the binding was written in one batch with the assessment, after its whole derivation
  // from the paid producer; on the genuine Store the pair is read as written. A captured or replayed evaluation view keeps
  // the full derivation and its read sequence.
  if (historicalReadsReachGenuine(store)) {
    const saved = exact<ResearchAssessment>(store, assessmentRef, 'research-assessment');
    requireCondition(saved.revision === 1 && saved.id.startsWith('research-assessment:'),
      'research_assessment_binding_invalid', `[${turnId}] Saved assessment does not derive from its exact paid producer`);
    return saved;
  }
  const value = binding.value;
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
  const capturedDraft = readDraft(view.store, question.value.draftId);
  requireCondition(capturedDraft && same(reference(capturedDraft), value.draft),
    'research_assessment_binding_invalid', `[${turnId}] The captured proposal uses another draft`);
  const frame = Object.hasOwn(origin.value.context, 'v7Frame')
    ? v7FrameAssessment(view.store, capturedDraft, question) : null;
  if (frame) requireCondition(same(frame.context, outcome.context.v7Frame),
    'research_assessment_binding_invalid', `[${turnId}] The assessor did not receive its exact accepted mandate`);
  const observations = action.citations.map(item => new Evidence(view.store).observe(projectId, item.source, item.selector));
  if (frame && !observations.some(item => same(item, frame.context.brief.observation)))
    observations.push(frame.context.brief.observation);
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
    location: readRecord<any>(view.store, o.source.id)!.value.origin.location })) : undefined;
  const related = discoveryContext(view.store, capturedDraft, question);
  requireDiscoveryProposal(capturedDraft.value, question, action.value, related.context, observations.length);
  requireCondition(same(related.context, outcome.context.discoveryContext ?? null),
    'research_assessment_binding_invalid', `[${turnId}] The assessor did not receive its exact Discovery grounds`);
  if (hasV7PlanCoverage(question.value.spec)) {
    const plan = readV7PlanBasis(view.store, capturedDraft.value, question, action.value);
    requireCondition(plan !== null && same(outcome.context.planBasis, plan.context),
      'research_assessment_binding_invalid', `[${turnId}] The plan assessor did not receive its exact frame and mandate`);
  }
  const basisMaterial = assessmentBasisMaterial(view.store, capturedDraft);
  if (basisMaterial) requireCondition(
    same(outcome.context.discoveryBasisCatalogue ?? null, basisMaterial.catalogue)
      && (basisMaterial.concept === null || same(outcome.context.prerequisites,
        researchPrerequisites(view.store, capturedDraft.value)))
      && (!requiresConceptApplications(capturedDraft.value, question.value)
        || conceptApplicationFindings(action.value, basisMaterial.catalogue).length === 0)
      && (!requiresSpecificationApplications(capturedDraft.value, question.value)
        || specificationApplicationFindings(action.value, basisMaterial.concept!, basisMaterial.catalogue).length === 0),
    'research_assessment_binding_invalid', `[${turnId}] The paid assessment lost its original applications or catalogue`);
  const proposedInheritance = inheritanceProposal(capturedDraft.value, question.value, action.value);
  // The v6 producer captures this derivation for every map/feature question,
  // including questions before the final candidate. Replay exactly one read.
  if (proposedInheritance || contractEraOf(capturedDraft.value) === BASIS_APPLICATION_CONTRACT_ERA
    && ['operation-map', 'features'].includes(capturedDraft.value.stage))
    requireCondition(same(outcome.context.prerequisites,
      researchPrerequisites(view.store, capturedDraft.value, proposedInheritance)),
      'research_assessment_binding_invalid', `[${turnId}] The paid assessment lost its selected requirement grounds`);
  const withNeighbors = origin.value.contract === 'assessment-paid-origin/v2';
  if (withNeighbors) {
    const neighbors = stageNeighbors(view.store, capturedDraft, question);
    requireCondition(outcome.context.assessmentContextContract === STAGE_NEIGHBOR_CONTEXT
      && neighbors.context !== null && outcome.context.stageNeighbors !== undefined
      && same(neighbors.context, outcome.context.stageNeighbors), 'research_assessment_binding_invalid',
      `[${turnId}] The assessor did not receive its exact accepted stage neighbors`);
  }
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
    && outcome.prompt === assessmentPrompt(bases, question.value.spec.obligationContract,
      related.context !== null && question.value.spec.field === 'preparation', withNeighbors,
      requiresConceptApplications(capturedDraft.value, question.value), contractEraOf(capturedDraft.value) === BASIS_APPLICATION_CONTRACT_ERA
        && capturedDraft.value.stage === 'specification', outcome.context.planBasis !== undefined) + (frame ? V7_FRAME_ASSESSMENT_INSTRUCTION : ''),
    'research_assessment_binding_invalid', `[${turnId}] The assessor context does not derive from the paid proposal and exact sources`);
  const projected = assessmentValue(question, action, environment, observations, bases, runtime.proofs,
    outcome.result as { verdict: unknown; reasons: unknown });
  const assessment = exact<ResearchAssessment>(store, assessmentRef, 'research-assessment');
  requireCondition(assessment.revision === 1 && assessment.id === `research-assessment:${hashJson(projected)}`
    && same(assessment.value, projected),
    'research_assessment_binding_invalid', `[${turnId}] Saved assessment does not derive from its exact paid producer`);
  return assessment;
}

function attemptsCandidate(store: Store, proven: ProvenAttemptPacket, baseline: V7ProgressBaseline) {
  const materials = new Map<string, { ref: Ref; kind: string; value: unknown }>();
  const related = new Map<string, { address: ClaimAddress; claim: Json }>();
  const pending: Json[] = proven.entries.flatMap(entry => entry.attempt.claims ?? []);
  const baselineClaims = baseline.materials.map(address => ({ address, claim: resolveClaimAddress(store, address).claim }));
  pending.push(...baselineClaims.map(item => item.claim));
  // Only contracted basis paths are references. Free claim JSON is never scanned
  // for Ref-shaped values. Exact material is paged by the shared packer/archive.
  for (let index = 0; index < pending.length; index++) {
    const claim = pending[index];
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) continue;
    const basis = claim.basis;
    if (!basis || typeof basis !== 'object' || Array.isArray(basis)) continue;
    const source = claim.kind === 'fact' && basis.source && typeof basis.source === 'object'
      && !Array.isArray(basis.source) ? basis.source.ref : claim.kind === 'owner-decision' ? basis.authority : null;
    if (isRef(source) && !materials.has(canonical(source))) {
      const record = readRecord(store, source.id, source.revision);
      requireCondition(record && same(reference(record), source) && hashJson(record.value) === record.hash
        && (claim.kind !== 'fact' || record.kind === 'source'),
        'discovery_assessment_invalid', `[${source.id}] The attempt basis needs its exact saved material`);
      materials.set(canonical(source), { ref: source, kind: record!.kind, value: record!.value });
    }
    if (claim.kind === 'inference' && Array.isArray(basis.from)) for (const item of basis.from) {
      const key = canonical(item);
      if (related.has(key)) continue;
      const address = item as unknown as ClaimAddress, resolved = resolveClaimAddress(store, address);
      related.set(key, { address, claim: resolved.claim }); pending.push(resolved.claim);
    }
  }
  return { planQuestion: proven.planQuestion,
    attempts: proven.entries.map(entry => ({ attempt: reference(entry.attempt.attempt), binding: reference(entry.binding),
      end: entry.attempt.attempt.value.end })), baseline: baselineClaims,
    relatedClaims: [...related.values()], materials: [...materials.values()] };
}

/** A derives a judgment from one exact paid terminal. P alone may apply it. */
function attemptsAssessmentValue(store: Store, proof: AssessmentProof): PaidDiscoveryAttemptsAssessment {
  const subject = packetAssessmentSubject(proof.context);
  requireCondition(subject?.assessment?.contract === DISCOVERY_ASSESSMENT_CONTRACT_V2
    || subject?.assessment?.contract === DISCOVERY_ASSESSMENT_CONTRACT_V3,
    'discovery_assessment_invalid', 'The paid attempts assessment must declare its exact methodology before dispatch');
  const { value } = projectPaidAttemptsAssessment({ subject: subject!, session: proof.session,
    application: proof.application, assessor: proof.role.actor, environment: proof.environment, result: proof.result });
  requireCondition(same(proof.question, subject!.packet.question) && proof.dispatch.projectId === value.projectId
    && same(proof.role, proof.dispatch.reviewer), 'discovery_assessment_invalid', 'The paid assessor belongs to this exact subject and role');
  const checked = checkDiscoveryAssessmentForm(store, value);
  requireCondition(same(proof.context.value, attemptsCandidate(store, checked.packet, subject!.baseline))
    && Array.isArray(proof.context.observations) && proof.context.observations.length === 0
    && proof.prompt === assessmentQuestionContract(subject!).prompt,
    'discovery_assessment_invalid', 'The paid assessor did not receive the exact attempt contents and baseline');
  return value;
}

/** Structural supported/version labels are insufficient: re-derive the entire saved
 * assessment from the producer's physical receipt, application and terminal.
 *
 * A dossier read asks for the same exact assessment once per claim, per cell and per material. Read on the genuine Store
 * it is one shared historical proof: derived once per operation, reused by a later one only while its whole read
 * footprint is current, and handed out as an independent copy. Read through any other source — a traced view inside
 * another proof, the assessment evaluation's own read view, an overlay — it is derived in place exactly as before, so the
 * reads of the enclosing proof and the recorded read sequence of an evaluation stay what they were. Arguments that cannot
 * key a proof refuse in the derivation itself, with the same typed refusal as ever. */
function plainExactRef(ref: unknown): Ref | null {
  // Not a Proxy (its traps could answer get and the descriptor differently), exactly Object.prototype, exactly three own
  // keys counting symbols, each an enumerable data field: any other form keeps the in-place derivation of the input.
  if (!ref || typeof ref !== 'object' || isProxy(ref) || Array.isArray(ref) || Object.getPrototypeOf(ref) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(ref), fields = Object.getOwnPropertyDescriptors(ref);
  if (keys.length !== 3 || !['id', 'revision', 'hash'].every(name => keys.includes(name)
    && 'value' in fields[name]! && fields[name]!.enumerable === true)) return null;
  const exact = { id: fields['id']!.value, revision: fields['revision']!.value, hash: fields['hash']!.value };
  return isRef(exact) ? exact : null;
}
export function readDiscoveryAssessment(store: Store, projectId: string, ref: Ref): Revision<PaidDiscoveryAttemptsAssessment> {
  // A nested derivation reads through the trace its parent proof made over the genuine Store: that source too may reuse
  // the kept proof of this exact Ref. The original store goes to historicalProof, so the parent still observes every read.
  // Only a plain exact Ref of three data fields keys the kept proof: its values are taken once and that very snapshot is
  // what the derivation proves. Accessors, a Proxy, an array or an inheriting object derive in place from the input as before.
  const exact = plainExactRef(ref);
  if (!historicalSourceOverGenuine(store) || typeof projectId !== 'string' || projectId.trim().length === 0 || !exact)
    return deriveDiscoveryAssessment(store, projectId, ref);
  // PROOF-SPEED (owner rule 08.10): an assessment P has already applied was proved in full before its application was
  // written; it is read as written, by its exact Ref, kind and hash. Only an unapplied one is derived.
  if (savedV7ProgressApplication(store, exact)) {
    const saved = store.get<PaidDiscoveryAttemptsAssessment>(exact.id, exact.revision);
    requireCondition(saved?.kind === DISCOVERY_ASSESSMENT_KIND && saved.revision === 1 && same(reference(saved), exact)
      && saved.hash === hashJson(saved.value) && saved.value !== null && typeof saved.value === 'object'
      && saved.value.projectId === projectId,
      'discovery_assessment_invalid', 'The exact discovery assessment is absent, changed or foreign');
    return structuredClone(saved!);
  }
  // Every entry receives its own copy, also inside one withHistoricalReads region where the kept value is shared.
  return structuredClone(historicalProof(store, { reader: 'discovery.assessment-read/v1', project: projectId, ref: exact },
    source => deriveDiscoveryAssessment(source, projectId, exact),
    () => { throw new EngineError('discovery_assessment_invalid', 'The exact assessment proof is cyclic'); }));
}
function deriveDiscoveryAssessment(store: Store, projectId: string, ref: Ref): Revision<PaidDiscoveryAttemptsAssessment> {
  const saved = isRef(ref) ? store.get<PaidDiscoveryAttemptsAssessment>(ref.id, ref.revision) : null;
  requireCondition(saved?.kind === DISCOVERY_ASSESSMENT_KIND && saved.revision === 1 && same(reference(saved), ref)
    && saved.hash === hashJson(saved.value) && saved.value !== null && typeof saved.value === 'object'
    && saved.value.projectId === projectId,
    'discovery_assessment_invalid', 'The exact discovery assessment is absent, changed or foreign');
  requireCondition(saved!.value.contract === DISCOVERY_ASSESSMENT_CONTRACT_V2
    || saved!.value.contract === DISCOVERY_ASSESSMENT_CONTRACT_V3,
    'discovery_assessment_invalid', 'This producer proves only an explicitly declared paid assessment');
  const proof = readAssessmentSessionOutcomeAt(store, projectId, saved!.value.session, saved!.value.application);
  const derived = attemptsAssessmentValue(store, proof);
  requireCondition(saved!.id === discoveryAssessmentId(derived) && same(saved!.value, derived),
    'discovery_assessment_invalid', 'The assessment differs from its exact paid terminal');
  return saved!;
}

/** Assess a fixed packet. The shared session resumes its paid application before
 * admission of another call. Fresh admissions guard the current plan/baseline;
 * saving a received judgment does not apply it or update an attempt/K record. */
async function assessDeclaredAttempts(store: Store, packet: V7AttemptPacket, baseline: V7ProgressBaseline,
  environment: Revision<Environment>, root: string, assessment: NonNullable<AssessmentTransportSubject['assessment']>,
  signal?: AbortSignal, pilot?: Revision<ReaderPilot>):
  Promise<Revision<PaidDiscoveryAttemptsAssessment>> {
  requireCondition(isRef(environment) && typeof root === 'string' && root.length > 0
    && (pilot === undefined || isRef(pilot)), 'discovery_assessment_invalid', 'Exact environment and workspace are required');
  const proven = proveAttemptPacket(store, packet);
  checkProgressBaseline(store, baseline, packet);
  const draft = proven.entries[0]!.attempt.draft;
  const question = exact<Question>(store, packet.question, 'question');
  environment = exact<Environment>(store, reference(environment), 'environment');
  if (pilot) pilot = exact<ReaderPilot>(store, reference(pilot), 'reader-pilot');
  requireCondition(!pilot || pilot.value.projectId === packet.project,
    'discovery_assessment_invalid', 'The assessor profile belongs to this packet project');
  requireCondition(environment.value.projectId === packet.project && realpathSync(root) === realpathSync(environment.value.workspace),
    'discovery_assessment_invalid', 'The assessor needs the packet project and its configured workspace');
  const subject = { kind: 'attempts' as const, packet, baseline, assessment };
  const context = { assessmentSubject: subject, value: attemptsCandidate(store, proven, baseline), observations: [] };
  const dispatch = pilot ? pilotEnvironment(environment.value, pilot.value) : environment.value;
  const delivered = await assessmentSessionWithProof(store, draft, question, environment, dispatch, pilot, context,
    assessmentQuestionContract(subject).prompt, signal, baselineGuards(baseline));
  requireCondition(delivered.proof, 'discovery_assessment_invalid', 'The attempts assessment needs its exact paid terminal proof');
  requireCondition(same(delivered.proof!.environment, reference(environment))
    && same(delivered.proof!.role, dispatch.reviewer) && same(delivered.proof!.profile, pilot ? reference(pilot) : null),
    'discovery_assessment_invalid', 'The paid assessment belongs to another environment, role or profile');
  const value = attemptsAssessmentValue(store, delivered.proof!);
  requireCondition(same(value.subject.packet, packet) && same(value.baseline, baseline),
    'discovery_assessment_invalid', 'The paid terminal belongs to another packet or baseline');
  const id = discoveryAssessmentId(value), existing = store.get<PaidDiscoveryAttemptsAssessment>(id);
  if (existing) return readDiscoveryAssessment(store, packet.project, reference(existing));
  try { return store.write<PaidDiscoveryAttemptsAssessment>({ id, kind: DISCOVERY_ASSESSMENT_KIND, expected: 0, value }); }
  catch (error) {
    if (!(error instanceof EngineError) || error.code !== 'revision_conflict') throw error;
    const saved = store.get(id);
    if (!saved) throw error;
    return readDiscoveryAssessment(store, packet.project, reference(saved));
  }
}

/** Explicit historical entry point. Selecting v3 never upgrades a saved v2 reply. */
export async function assessAttempts(store: Store, packet: V7AttemptPacket, baseline: V7ProgressBaseline,
  environment: Revision<Environment>, root: string, signal?: AbortSignal, pilot?: Revision<ReaderPilot>):
  Promise<Revision<DiscoveryAttemptsAssessmentV2>> {
  const saved = await assessDeclaredAttempts(store, packet, baseline, environment, root, methodologyAssessmentTransport(), signal, pilot);
  requireCondition(saved.value.contract === DISCOVERY_ASSESSMENT_CONTRACT_V2,
    'discovery_assessment_invalid', 'The selected historical producer retains its v2 contract');
  return saved as Revision<DiscoveryAttemptsAssessmentV2>;
}
/** MR: choose requirements before capacity, session identity and payment. */
export async function assessAttemptsWithRequirements(store: Store, packet: V7AttemptPacket, baseline: V7ProgressBaseline,
  environment: Revision<Environment>, root: string, signal?: AbortSignal, pilot?: Revision<ReaderPilot>):
  Promise<Revision<DiscoveryAttemptsAssessmentV3>> {
  const saved = await assessDeclaredAttempts(store, packet, baseline, environment, root, requirementsAssessmentTransport(), signal, pilot);
  requireCondition(saved.value.contract === DISCOVERY_ASSESSMENT_CONTRACT_V3,
    'discovery_assessment_invalid', 'The selected producer retains its v3 requirements contract');
  return saved as Revision<DiscoveryAttemptsAssessmentV3>;
}


function dossierAssessmentInvalid(condition:unknown,message:string):asserts condition {
  requireCondition(condition,'discovery_dossier_assessment_invalid',message);
}
const paidDossierAssessmentId=(value:PaidDossierAssessment)=>
  `discovery-dossier-assessment:v1:${hashJson([value.subject,value.session,value.application])}`;

/** Private derivation from the shared reader/executor's proven result. It cannot
 * be called with a caller packet and does not replay the same chain twice. */
function dossierAssessmentValue(store:Store,project:string,
  proof:Awaited<ReturnType<typeof readDossierAssessmentSessionAt>>):PaidDossierAssessment {
  dossierAssessmentInvalid(proof.result!==null && isRef(proof.application),
    'A continuing dossier session is not an assessment');
  const application=exact<DossierAssessmentApplication>(store,proof.application,'assessment-application');
  dossierAssessmentInvalid(application.value.contract===DOSSIER_APPLICATION && application.value.state==='applied'
    && same(application.value.after,reference(proof.session)) && isRef(application.value.received),
    'The dossier terminal lost its exact applied application');
  const call=exact<ModelCall>(store,application.value.received,'model-call');
  dossierAssessmentInvalid(isRef(call.value.request?.record) && isRef(call.value.response?.record),
    'The dossier assessment needs its original complete request and response');
  return {contract:DOSSIER_ASSESSMENT_CONTRACT,projectId:project,subject:proof.session.value.subject,
    manifest:proof.session.value.subject.manifest,session:reference(proof.session),application:reference(application),
    call:reference(call),request:call.value.request.record,response:call.value.response.record,result:proof.result};
}

/** Historical D6: all persisted fields derive from the same paid terminal at
 * its original boundary, independently of today's plan, choice or runtime. */
export async function readDossierAssessmentAt(store:Store,project:string,at:unknown):Promise<Revision<PaidDossierAssessment>> {
  dossierAssessmentInvalid(isRef(at),'An exact dossier assessment is required');
  const saved=exact<PaidDossierAssessment>(store,at,DOSSIER_ASSESSMENT_KIND);
  dossierAssessmentInvalid(saved.revision===1 && saved.value!==null && typeof saved.value==='object' && !Array.isArray(saved.value) && saved.value.contract===DOSSIER_ASSESSMENT_CONTRACT
    && saved.value.projectId===project,'The dossier assessment is foreign or has an unknown era');
  dossierAssessmentInvalid(isRef(saved.value.session),'The dossier assessment needs its exact terminal session');
  const derived=dossierAssessmentValue(store,project,await readDossierAssessmentSessionAt(store,project,saved.value.session));
  return requirePublishedDossierAssessment(saved,derived);
}
function requirePublishedDossierAssessment(saved:Revision<PaidDossierAssessment>,derived:PaidDossierAssessment) {
  dossierAssessmentInvalid(saved.kind===DOSSIER_ASSESSMENT_KIND && saved.revision===1 && hashJson(saved.value)===saved.hash,
    'The dossier assessment must be one immutable exact record');
  dossierAssessmentInvalid(saved.id===paidDossierAssessmentId(derived) && same(saved.value,derived),
    'The saved dossier assessment differs from its exact paid terminal');
  return saved;
}

/** Publication is one immutable expected:0 write. Historical source heads are
 * not current-admission guards: their exact revisions are the proof. */
function publishProvenDossierAssessment(store:Store,value:PaidDossierAssessment):Revision<PaidDossierAssessment> {
  const id=paidDossierAssessmentId(value);
  const prior=store.get<PaidDossierAssessment>(id);
  if(prior)return requirePublishedDossierAssessment(prior,value);
  try { return store.writeMany<PaidDossierAssessment>([{id,kind:DOSSIER_ASSESSMENT_KIND,expected:0,value}])[0]!; }
  catch(error) {
    if(!(error instanceof EngineError) || error.code!=='revision_conflict')throw error;
    const winner=store.get<PaidDossierAssessment>(id);
    if(!winner)throw error;
    return requirePublishedDossierAssessment(winner,value);
  }
}
export async function publishDossierAssessment(store:Store,project:string,terminal:unknown):Promise<Revision<PaidDossierAssessment>> {
  dossierAssessmentInvalid(typeof project==='string' && project.length>0 && isRef(terminal),
    'An exact terminal dossier session and project are required');
  const proof=await readDossierAssessmentSessionAt(store,project,terminal);
  return publishProvenDossierAssessment(store,dossierAssessmentValue(store,project,proof));
}

/** A saved terminal is restored by the managed executor before new allowance
 * or current-runtime admission; publication itself never sends or pays. */
export async function assessDossier(store:Store,project:string,subject:unknown,environment?:Revision<Environment>,
  pilot?:Revision<ReaderPilot>,signal?:AbortSignal,options:NonNullable<Parameters<typeof runDossierAssessmentSession>[6]>={}) {
  dossierAssessmentInvalid(options!==null && typeof options==='object' && !Array.isArray(options),'Dossier execution options must be an object');
  const terminal=await runDossierAssessmentSession(store,project,subject,environment,pilot,signal,options);
  dossierAssessmentInvalid(terminal.result!==null,'The saved dossier session has no terminal assessment');
  return publishProvenDossierAssessment(store,dossierAssessmentValue(store,project,terminal));
}

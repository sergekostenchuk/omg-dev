import { Ajv } from "ajv";
import { Store, type Revision } from "../storage/store.js";
import { Evidence } from "../evidence/evidence.js";
import { reference } from "../pipeline/contracts.js";
import type { Environment } from "../runtime/environment.js";
import { hashJson } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import type { Question, DiscoveryDraft } from "./discovery.js";
import type { ResearchAction, ResearchAssessment } from "./research-model.js";
import { researchPrerequisites, researchGraphContext } from "./research-context.js";
import { consumerFeedback } from "./consumer-feedback.js";
import { pilotEnvironment, type ReaderPilot } from "./reader-pilot.js";
import { pilotContext } from "./pilot-context.js";
import { layerDeltaView } from "./layer-delta.js";
import { technicalProposalFindings } from "../graph/research-evidence.js";
import type { TechnicalReport } from "../graph/research-contracts.js";
import type { Graph } from "../graph/model.js";
import { assessmentSession } from "./assessment-session.js";
import { resolveResearchBasis } from '../graph/research-basis.js';
import { OBLIGATION_EVIDENCE_PAUSES, requireDocumentarySources } from '../graph/obligation-evidence.js';

export async function assessAnswer(store: Store, question: Revision<Question>, action: Extract<ResearchAction, { action: "answer" }>,
  environment: Revision<Environment>, root: string, signal?: AbortSignal, pilot?: Revision<ReaderPilot>): Promise<Revision<ResearchAssessment>> {
  requireDocumentarySources(store,question.value.projectId,question.value.spec);
  requireCondition(new Ajv({ strict: true, allowUnionTypes: true }).compile(question.value.spec.schema as object)(action.value),
    "answer_invalid", "Proposed research result does not satisfy its consumer contract");
  const evidence = new Evidence(store);
  const observations = action.citations.map(item => evidence.observe(question.value.projectId, item.source, item.selector));
  const draft = store.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(draft?.kind === "discovery-draft", "draft_missing", "The research context is missing");
  requireCondition(environment.value.implementer.actor !== environment.value.reviewer.actor, "assessor_not_independent", "Research assessment requires a separate actor");
  if (draft.value.stage === "om-g2" && ["R1", "R2"].includes(draft.value.level) && draft.value.consumer === "compilation") {
    const graph = store.get<Graph>(`graph:${draft.value.projectId}`)!;
    const findings = technicalProposalFindings(store, draft.value.projectId, draft.value.level, question.id, question.value.spec.field,
      action.value as unknown as TechnicalReport, observations, graph.value, root);
    const pause = findings.find(finding => OBLIGATION_EVIDENCE_PAUSES.has(finding.code));
    if (pause) throw new EngineError(pause.code,`[${pause.target}] ${pause.message}`,findings);
    if (findings.length) throw new EngineError("research_proposal_invalid", "Correct the typed proposal findings before model assessment", findings);
  }
  const dispatch = { ...(pilot ? pilotEnvironment(environment.value, pilot.value) : environment.value), workspace: root };
  const bases = question.value.spec.basisContract === 'typed-v1'
    ? resolveResearchBasis(store, draft.value.projectId, action.value as unknown as TechnicalReport, observations, root, question.value.spec.field).bases : undefined;
  // Exact quotes are already in the paged candidate and observations. Keep only
  // machine bindings mandatory instead of duplicating every quote on every page.
  const basisBindings = bases?.map(({ quote: _quote, ...binding }) => binding);
  const pilotPacket = pilot ? pilotContext(store, draft, question) : null;
  const context = pilotPacket ? { ...pilotPacket, ...(basisBindings ? { bases: basisBindings } : {}), role: "assess-answer", question: question.value.spec,
    sourceLocations: observations.map(o => ({ source: o.source, location: store.get<any>(o.source.id)!.value.origin.location })),
    value: question.value.spec.field === "layerDesign" ? layerDeltaView(store, draft.value.projectId, action.value, draft.value.level === "R2" ? 3 : 2) : action.value,
    representation: question.value.spec.field === "layerDesign" ? "changes_against_exact_base_after_machine_L2_validation" : "complete_field",
    observations, consumerFeedback: consumerFeedback(store, draft.value) }
    : { role: "assess-answer", ...(basisBindings ? { bases: basisBindings } : {}), question: question.value.spec, value: action.value, observations,
      prerequisites: researchPrerequisites(store, draft.value), operationMap: researchGraphContext(store, draft.value),
      consumerFeedback: consumerFeedback(store, draft.value) };
  const prompt = "Evaluate whether the supplied observations actually support the proposed answer to this exact question and all its required details. Source hashes prove identity only. A fact needs relevant evidence of the claimed behavior, not an unrelated quote, a plan, or model confidence. For kind=decision, only existing explicit owner intent supports the value. For kind=design, evaluate a model-authored proposal for completeness, usefulness to the named consumer, consistency with the supplied intent and constraints; it may introduce a design but must not pretend it is existing implementation or a new owner decision. Reject invented facts, unsupported inapplicability, and empty generic filler. Return JSON {verdict: supported|insufficient|conflicting, reasons: string[]}. If unsupported or contradictory explain exactly why. Do not change files or perform external actions." + (bases ? " bases[].proofLimit limits the claim: quoted-intent-requires-attribution requires establishing explicit attributable owner intent, not trusting the document ingestion label; reported-not-runtime-proof is a documentary report and does not establish current environment behavior or completed implementation. Preserve documentary support with its stated limits instead of promoting it to a repository fact or discarding it." : "") + (question.value.spec.obligationContract ? " Assess each coverage member against its fixed assignment.kind and consumer. A documentaryAllowance only admits the named source: the actual claim must stay within assignment.documentaryAllowance.claimLimit and the quoted evidence. Reject broader claims; admission of a document does not certify runtime behavior or implementation." : "");
  const response = (await assessmentSession(store, draft, question, environment, dispatch, pilot, context, prompt, signal)) as { verdict?: unknown; reasons?: unknown } | null;
  requireCondition(response && ["supported", "insufficient", "conflicting"].includes(String(response.verdict))
    && Array.isArray(response.reasons) && response.reasons.every(item => typeof item === "string")
    && (response.verdict === "supported" || response.reasons.length > 0), "assessment_invalid", "Assessment must explicitly classify support and explain unresolved evidence");
  const value: ResearchAssessment = { projectId: question.value.projectId, question: reference(question), value: action.value,
    ...(bases ? { bases } : {}), observations, verdict: response.verdict as ResearchAssessment['verdict'], reasons: response.reasons,
    researcher: environment.value.implementer.actor, assessor: environment.value.reviewer.actor, environment: reference(environment) };
  const id = `research-assessment:${hashJson(value)}`;
  return store.get<ResearchAssessment>(id) ?? store.writeMany<ResearchAssessment>([{ id, kind: "research-assessment", expected: 0, value }],
    [reference(question), reference(environment), ...draft.value.inputs, ...observations.map(item => item.source)])[0]!;
}

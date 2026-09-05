import { Ajv } from "ajv";
import { Store, type Revision } from "../storage/store.js";
import { Evidence } from "../evidence/evidence.js";
import { reference } from "../pipeline/contracts.js";
import type { Environment } from "../runtime/environment.js";
import { hashJson } from "../canonical.js";
import { requireCondition } from "../errors.js";
import type { Question, DiscoveryDraft } from "./discovery.js";
import type { ResearchAction, ResearchAssessment } from "./research-model.js";
import { researchCall } from "./research-protocol.js";
import { researchPrerequisites, researchGraphContext } from "./research-context.js";

export async function assessAnswer(store: Store, question: Revision<Question>, action: Extract<ResearchAction, { action: "answer" }>,
  environment: Revision<Environment>, root: string, signal?: AbortSignal): Promise<Revision<ResearchAssessment>> {
  requireCondition(new Ajv({ strict: true, allowUnionTypes: true }).compile(question.value.spec.schema as object)(action.value),
    "answer_invalid", "Proposed research result does not satisfy its consumer contract");
  const evidence = new Evidence(store);
  const observations = action.citations.map(item => evidence.observe(question.value.projectId, item.source, item.selector));
  const draft = store.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(draft?.kind === "discovery-draft", "draft_missing", "The research context is missing");
  requireCondition(environment.value.implementer.actor !== environment.value.reviewer.actor, "assessor_not_independent", "Research assessment requires a separate actor");
  const response = await researchCall(environment.value.reviewer, { ...environment.value, workspace: root },
    "Evaluate whether the supplied observations actually support the proposed answer to this exact question and all its required details. Source hashes prove identity only. A fact needs relevant evidence of the claimed behavior, not an unrelated quote, a plan, or model confidence. For kind=decision, only existing explicit owner intent supports the value. For kind=design, evaluate a model-authored proposal for completeness, usefulness to the named consumer, consistency with the supplied intent and constraints; it may introduce a design but must not pretend it is existing implementation or a new owner decision. Reject invented facts, unsupported inapplicability, and empty generic filler. Return JSON {verdict: supported|insufficient|conflicting, reasons: string[]}. If unsupported or contradictory explain exactly why. Do not change files or perform external actions.",
    { role: "assess-answer", question: question.value.spec, value: action.value, observations,
      prerequisites: researchPrerequisites(store, draft.value), operationMap: researchGraphContext(store, draft.value) }, signal) as { verdict?: unknown; reasons?: unknown } | null;
  requireCondition(response && ["supported", "insufficient", "conflicting"].includes(String(response.verdict))
    && Array.isArray(response.reasons) && response.reasons.every(item => typeof item === "string")
    && (response.verdict === "supported" || response.reasons.length > 0), "assessment_invalid", "Assessment must explicitly classify support and explain unresolved evidence");
  const value: ResearchAssessment = { projectId: question.value.projectId, question: reference(question), value: action.value,
    observations, verdict: response.verdict as ResearchAssessment['verdict'], reasons: response.reasons,
    researcher: environment.value.implementer.actor, assessor: environment.value.reviewer.actor, environment: reference(environment) };
  const id = `research-assessment:${hashJson(value)}`;
  return store.get<ResearchAssessment>(id) ?? store.writeMany<ResearchAssessment>([{ id, kind: "research-assessment", expected: 0, value }],
    [reference(question), reference(environment), ...draft.value.inputs, ...observations.map(item => item.source)])[0]!;
}

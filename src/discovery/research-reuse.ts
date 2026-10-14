import { discoveryReuseAdmission, isDiscoveryV5, type DiscoveryContext } from './discovery-outcome.js';
import { readAssessmentPaidOrigin } from './assessment-session.js';
import { Store, type Revision } from "../storage/store.js";
import { canonical, hashJson } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import type { ResearchAnswer, ResearchAssessment } from "./research-model.js";
import { Discovery, readAcceptedResearchAnswer, type DiscoveryDraft, type Question } from "./discovery.js";

export function reuseResearch(store: Store, discovery: Discovery, draft: Revision<DiscoveryDraft>, environment: Ref): number {
  let reused = 0;
  for (const id of draft.value.questions) {
    const question = store.get<Question>(id)!;
    if (question.value.status === "answered") continue;
    for (const prior of store.list<ResearchAssessment>("research-assessment")) {
      const value = prior.value;
      const report = value.value;
      if (draft.value.stage === "om-g2" && report && typeof report === "object" && !Array.isArray(report)
        && Array.isArray(report['gaps']) && report['gaps'].length > 0) continue;
      // ASM1.1 (№4791 §6): a direct assessment bound to its own prefixed material proves nothing for another question's
      // prefix — not a reuse candidate; the ordinary current assessment of this question stays available.
      if (value.origin !== undefined) continue;
      if (value.projectId !== draft.value.projectId || value.verdict !== "supported" || value.researcher === value.assessor
        || canonical(value.environment) !== canonical(environment) || value.observations.length === 0
        || !value.observations.every(item => discovery.evidence.verify(item))) continue;
      const issued = store.get<Question>(value.question.id, value.question.revision);
      const current = store.get<Question>(value.question.id);
      const activeAnswer = current?.value.answer ? store.get<ResearchAnswer>(current.value.answer.id) : null;
      const priorDraft = issued ? store.get<DiscoveryDraft>(issued.value.draftId) : null;
      if (!issued || issued.hash !== value.question.hash || !priorDraft || issued.value.consumer !== question.value.consumer
        || current?.value.status !== "answered" || activeAnswer?.kind !== "research-answer"
        || canonical(activeAnswer.value.assessment) !== canonical(reference(prior))
        || issued.value.level !== question.value.level || issued.value.stage !== question.value.stage
        || canonical(issued.value.spec) !== canonical(question.value.spec)
        || canonical(priorDraft.value.inputs) !== canonical(draft.value.inputs)) continue;
      // D8.4.2 (№2230-4, №2276-3): the source is proven BEFORE the rebound is written — by its
      // exact accepted answer through the common reader, which also derives a rebound source's
      // own chain to the end (a managed source needs its own K; each rebound differs from its
      // source only in question/reusedFrom). A forged, lost or cyclic source is an addressed
      // refusal, not a skipped candidate. The rebound inherits no B/M/K of the source's turn.
      const proven = readAcceptedResearchAnswer(store, draft.value.projectId, reference(activeAnswer));
      requireCondition(proven.assessment !== null && canonical(reference(proven.assessment)) === canonical(reference(prior)),
        'research_reuse_source_invalid', `[${prior.id}] The reuse source is not the assessment of its accepted answer`);
      const origin = isDiscoveryV5(draft.value) && proven.binding
        ? readAssessmentPaidOrigin(store, draft.value.projectId, proven.binding.value.pending) : null;
      const admission = discoveryReuseAdmission(store, store.get<DiscoveryDraft>(draft.id)!, question, value.value,
        origin?.value.context['discoveryContext'] as DiscoveryContext | undefined ?? null);
      if (!admission.allowed) continue;
      const rebound: ResearchAssessment = { ...value, question: reference(question), reusedFrom: reference(prior) };
      const id = `research-assessment:${hashJson(rebound)}`;
      const assessment = store.get<ResearchAssessment>(id) ?? store.writeMany<ResearchAssessment>([{ id, kind: "research-assessment", expected: 0, value: rebound }],
        [reference(question), reference(prior), reference(current), reference(activeAnswer), ...draft.value.inputs, ...value.observations.map(item => item.source), ...admission.guards])[0]!;
      discovery.researched(question.id, question.revision, reference(assessment)); reused++; break;
    }
  }
  return reused;
}

import { Store, type Revision } from "../storage/store.js";
import { canonical, hashJson } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import type { ResearchAnswer, ResearchAssessment } from "./research-model.js";
import { Discovery, type DiscoveryDraft, type Question } from "./discovery.js";

export function reuseResearch(store: Store, discovery: Discovery, draft: Revision<DiscoveryDraft>, environment: Ref): number {
  let reused = 0;
  for (const id of draft.value.questions) {
    const question = store.get<Question>(id)!;
    if (question.value.status === "answered") continue;
    for (const prior of store.list<ResearchAssessment>("research-assessment")) {
      const value = prior.value;
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
      const rebound: ResearchAssessment = { ...value, question: reference(question), reusedFrom: reference(prior) };
      const id = `research-assessment:${hashJson(rebound)}`;
      const assessment = store.get<ResearchAssessment>(id) ?? store.writeMany<ResearchAssessment>([{ id, kind: "research-assessment", expected: 0, value: rebound }],
        [reference(question), reference(prior), reference(current), reference(activeAnswer), ...draft.value.inputs, ...value.observations.map(item => item.source)])[0]!;
      discovery.researched(question.id, question.revision, reference(assessment)); reused++; break;
    }
  }
  return reused;
}

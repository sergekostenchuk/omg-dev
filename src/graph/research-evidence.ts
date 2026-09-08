import { researchGapDeferred } from "./research-scope.js";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { Store } from "../storage/store.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { STAGES, stageId, type StageArtifact, type Finding } from "../pipeline/contracts.js";
import type { Source, Observation } from "../evidence/evidence.js";
import { workspacePath } from "../runtime/environment.js";
import type { Graph } from "./model.js";
import type { TechnicalReport } from "./research-contracts.js";
import { resolveResearchBasis } from './research-basis.js';

export function researchConsumerIds(store: Store, project: string, graph: Pick<Graph, "nodes">): string[] {
  const initial = store.get<StageArtifact>(stageId(project, "discovery"));
  const actors = (initial?.value.content as unknown as { fields?: { preparation?: { actors?: { id: string }[] } } })?.fields?.preparation?.actors ?? [];
  return [...new Set([...STAGES, ...graph.nodes.map(node => node.id), ...actors.map(actor => actor.id)])];
}

/** Deterministic proposal checks run before paying an assessor and are reused
 * by the final consumer; an accepted model verdict cannot bypass them. */
export function technicalProposalFindings(store: Store, project: string, level: string, questionId: string, field: string,
  report: TechnicalReport, observations: Observation[], graph: Graph, root: string): Finding[] {
  root = realpathSync(root);
  const findings: Finding[] = [];
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message, field });
  const initial = store.get<StageArtifact>(stageId(project, "discovery"));
  const actors = (initial?.value.content as unknown as { fields?: { preparation?: { actors?: { id: string }[] } } })?.fields?.preparation?.actors ?? [];
  const consumers = new Set(researchConsumerIds(store, project, graph));
  const files = observations.map(observation => store.get<Source>(observation.source.id)).filter((source): source is NonNullable<typeof source> => source?.value.origin.kind === "file");
  const question = store.get<Question>(questionId);
  const draft = question?.value.draftId ? store.get<DiscoveryDraft>(question.value.draftId) : null;
  const typed = question?.value.spec.basisContract === 'typed-v1';
  if (typed !== (draft?.value.basisContract === 'typed-v1')) fail('research_contract_mismatch', questionId, 'Question and draft must retain the same basis contract');
  if (typed) findings.push(...resolveResearchBasis(store, project, report, observations, root, field).findings);
  if (report.applicability === "applicable" && !report.facts.length && !report.designs.length) fail("research_report_empty", questionId, "An applicable domain needs concrete facts or explicit design decisions");
  if (report.applicability === "not_applicable" && (report.facts.length || report.designs.length || report.gaps.length || report.documents?.length)) fail("research_applicability_conflict", questionId, "An inapplicable domain cannot conceal facts, decisions or unresolved gaps");
  if (field.startsWith("gap_") && report.applicability !== "applicable") fail("research_gap_unresolved", questionId, "An inherited gap needs a concrete resolution, including when research disproves its premise");
  const obligations = store.get<Question>(questionId)?.value.spec.obligations;
  if (obligations?.length) {
    const coverage = report.coverage;
    if (!Array.isArray(coverage) || coverage.length !== obligations.length || new Set(coverage.map(c => c.obligation)).size !== obligations.length)
      fail("research_group_coverage_missing", questionId, "Every original group obligation needs its own explicit evidence/design/gap resolution");
    for (const obligation of obligations) {
      const item = coverage?.find(c => c.obligation === obligation.id);
      if (obligation.assignment?.moment === 'R2' && item?.gaps?.length)
        fail('research_gap_unresolved', obligation.id, 'An obligation due in R2 cannot be resolved by renaming an unresolved or sleeping gap');
      if (!item || !Array.isArray(item.facts) || !Array.isArray(item.designs) || !Array.isArray(item.gaps)
        || item.facts.length + item.designs.length + item.gaps.length === 0
        || !item.facts.every(id => report.facts.some(f => f.id === id))
        || !item.designs.every(id => report.designs.some(d => d.id === id && d.consumer === obligation.consumer))
        || !item.gaps.every(id => report.gaps.some(g => g.id === id && g.target === obligation.target && g.field === obligation.field && g.consumer === obligation.consumer)))
        fail("research_group_coverage_missing", obligation.id, "Group member lacks an attributable resolution; applicability alone cannot close it");
    }
  }
  for (const fact of typed ? [] : report.facts) {
    try {
      const path = realpathSync(workspacePath(root, fact.path ?? ''));
      if (!files.some(source => source.value.origin.location === path)) fail("repository_evidence_required", fact.id, "A repository fact must cite its actual source file");
    } catch { fail("repository_evidence_required", fact.id, "The factual source path is unavailable or outside the repository"); }
  }
  for (const file of files) {
    try { workspacePath(root, relative(root, file.value.origin.location)); }
    catch { fail("research_source_foreign", questionId, "A cited repository file belongs to a different workspace"); }
  }
  for (const design of report.designs) if (!consumers.has(design.consumer)) fail("research_consumer_missing", design.id, "Design must identify a real downstream consumer");
  for (const gap of report.gaps) {
    if (!consumers.has(gap.consumer) || !consumers.has(gap.target)) fail("research_consumer_missing", gap.id, "A gap needs an existing target and consumer");
    const target = graph.nodes.find(node => node.id === gap.target) ?? actors.find(actor => actor.id === gap.target);
    if (target && !Object.hasOwn(target, gap.field)) fail("research_field_missing", gap.id, "A node gap must identify an actual field of its target");
    if (gap.requiredFor === "current" || (level === "R2" && !researchGapDeferred(store, project, graph, gap))) fail("research_gap_unresolved", gap.id, gap.question);
  }
  return findings;
}

export function technicalResearchFindings(store: Store, discovery: Discovery, draft: DiscoveryDraft, graph: Graph, root: string): Finding[] {
  return draft.questions.flatMap(questionId => {
    const question = store.get<{ spec: { field: string }; answer: { id: string } | null }>(questionId)!;
    const field = question.value.spec.field;
    const answer = question.value.answer ? store.get(question.value.answer.id) : null;
    if (answer?.kind !== "research-answer") return [{ code: "research_assessment_required", target: questionId, field,
      message: "Technical research requires an evidence-assessed report; a manual declaration is insufficient" }];
    return technicalProposalFindings(store, draft.projectId, draft.level, questionId, field,
      draft.fields[field] as unknown as TechnicalReport, discovery.observations(questionId), graph, root);
  });
}

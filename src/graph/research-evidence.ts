import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { Store } from "../storage/store.js";
import { Discovery, type DiscoveryDraft } from "../discovery/discovery.js";
import { STAGES, stageId, type StageArtifact, type Finding } from "../pipeline/contracts.js";
import type { Source } from "../evidence/evidence.js";
import { workspacePath } from "../runtime/environment.js";
import type { Graph } from "./model.js";
import { deferredGap, type TechnicalReport } from "./research-contracts.js";

export function technicalResearchFindings(store: Store, discovery: Discovery, draft: DiscoveryDraft, graph: Graph, root: string): Finding[] {
  root = realpathSync(root);
  const findings: Finding[] = [];
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
  const initial = store.get<StageArtifact>(stageId(draft.projectId, "discovery"));
  const actors = (initial?.value.content as unknown as { fields?: { preparation?: { actors?: { id: string }[] } } })?.fields?.preparation?.actors ?? [];
  const consumers = new Set<string>([...STAGES, ...graph.nodes.map(node => node.id), ...actors.map(actor => actor.id)]);
  for (const questionId of draft.questions) {
    const question = store.get<{ spec: { field: string }; answer: { id: string } | null }>(questionId)!;
    const answer = question.value.answer ? store.get(question.value.answer.id) : null;
    if (answer?.kind !== "research-answer") { fail("research_assessment_required", questionId, "Technical research requires an evidence-assessed report; a manual declaration is insufficient"); continue; }
    const report = draft.fields[question.value.spec.field] as unknown as TechnicalReport;
    const observations = discovery.observations(questionId);
    const files = observations.map(observation => store.get<Source>(observation.source.id)!).filter(source => source.value.origin.kind === "file");
    if (report.applicability === "applicable" && !report.facts.length && !report.designs.length) fail("research_report_empty", questionId, "An applicable domain needs concrete facts or explicit design decisions");
    if (report.applicability === "not_applicable" && (report.facts.length || report.designs.length || report.gaps.length)) fail("research_applicability_conflict", questionId, "An inapplicable domain cannot conceal facts, decisions or unresolved gaps");
    if (question.value.spec.field.startsWith("gap_") && report.applicability !== "applicable") fail("research_gap_unresolved", questionId, "An inherited gap needs a concrete resolution, including when research disproves its premise");
    for (const fact of report.facts) {
      try {
        const path = realpathSync(workspacePath(root, fact.path));
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
      if (gap.requiredFor === "current" || (draft.level === "R2" && !deferredGap(graph, gap))) fail("research_gap_unresolved", gap.id, gap.question);
    }
  }
  return findings;
}

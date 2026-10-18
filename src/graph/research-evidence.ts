import { researchGapDeferred } from "./research-scope.js";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { Store, type TransactionGuard } from "../storage/store.js";
import { Discovery, type DiscoveryDraft } from "../discovery/discovery.js";
import { discoveryActors, orderedQuestions, readAnswer, readDraft, readQuestion } from "../discovery/projection-reader.js";
import { STAGES, reference, type Finding } from "../pipeline/contracts.js";
import type { Source, Observation } from "../evidence/evidence.js";
import { workspacePath, uniqueTransactionGuards } from "../runtime/environment.js";
import { requireCondition } from '../errors.js';
import { canonical } from '../canonical.js';
import type { Graph } from "./model.js";
import type { TechnicalReport } from "./research-contracts.js";
import { repositoryCitationPath, resolveResearchBasis, type ResearchPathMode } from './research-basis.js';
import { obligationEvidenceFindings } from './obligation-evidence.js';
import { collectRuntimeEvidence } from './runtime-evidence.js';
import { safeRelativePath } from './topology.js';

/** The physical resolution of a legacy facts.path is captured before paid
 * dispatch. Historical validation reuses that exact result, not a symlink's
 * present-day destination. Entries follow the proposal's facts order. */
export interface LegacyPathResolution { path: string; resolved: string }
export interface TechnicalProposalOptions {
  mode?: ResearchPathMode;
  legacyPaths?: LegacyPathResolution[];
}

export function researchConsumerIds(store: Store, project: string, graph: Pick<Graph, "nodes">): string[] {
  const actors = discoveryActors(store, project);
  return [...new Set([...STAGES, ...graph.nodes.map(node => node.id), ...actors.map(actor => actor.id)])];
}

/** Deterministic proposal checks run before paying an assessor and are reused
 * by the final consumer; an accepted model verdict cannot bypass them. */
export function technicalProposalFindings(store: Store, project: string, level: string, questionId: string, field: string,
  report: TechnicalReport, observations: Observation[], graph: Graph, root: string,
  runtime?:Pick<ReturnType<typeof collectRuntimeEvidence>, 'proofs'>,
  options: TechnicalProposalOptions = {}): Finding[] {
  const mode = options.mode ?? 'current';
  if (mode === 'current') {
    requireCondition(!options.legacyPaths?.length, 'research_context_read_proof_invalid',
      'A new precheck must capture its own legacy path resolutions');
    root = realpathSync(root);
  }
  else {
    requireCondition(mode === 'historical' && typeof root === 'string' && isAbsolute(root) && normalize(root) === root,
      'research_context_read_proof_invalid', 'Historical research needs its captured canonical workspace');
    requireCondition(runtime !== undefined, 'research_context_read_proof_invalid',
      'Historical proposal findings need the checked original runtime result');
  }
  const findings: Finding[] = [];
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message, field });
  const actors = discoveryActors(store, project);
  const consumers = new Set(researchConsumerIds(store, project, graph));
  const files = observations.flatMap(observation => {
    // Evidence.observe reads the Source head (and, in a captured assessment
    // view, proves the file snapshot). The exact read below retains its real
    // origin rather than the view's temporary owner-document projection.
    const head = store.get<Source>(observation.source.id);
    const source = store.get<Source>(observation.source.id, observation.source.revision);
    if (!head || !source || head.kind !== 'source' || source.kind !== 'source'
      || canonical(reference(head)) !== canonical(observation.source)
      || canonical(reference(source)) !== canonical(observation.source)
      || source.value.projectId !== project) {
      fail('research_basis_invalid', questionId, 'Every citation needs its original exact Source');
      return [];
    }
    return source.value.origin.kind === 'file' ? [source] : [];
  });
  const question = readQuestion(store, questionId);
  const draft = question?.value.draftId ? readDraft(store, question.value.draftId) : null;
  if (mode === 'historical' && (!question || !draft))
    fail('research_context_read_proof_invalid', questionId, 'Historical precheck lost its original question or draft');
  const typed = question?.value.spec.basisContract === 'typed-v1';
  if (typed !== (draft?.value.basisContract === 'typed-v1')) fail('research_contract_mismatch', questionId, 'Question and draft must retain the same basis contract');
  if (question?.value.spec.obligationContract !== draft?.value.obligationContract)
    fail('research_contract_mismatch',questionId,'Question and draft must retain the same obligation evidence contract');
  if (typed) findings.push(...resolveResearchBasis(store, project, report, observations, root, field, mode).findings);
  if (question) findings.push(...obligationEvidenceFindings(question.value.spec,report,observations,
    (runtime??collectRuntimeEvidence(store,project,question.value.spec,report,observations)).proofs));
  if (report.applicability === "applicable" && !report.facts.length && !report.designs.length) fail("research_report_empty", questionId, "An applicable domain needs concrete facts or explicit design decisions");
  if (report.applicability === "not_applicable" && (report.facts.length || report.designs.length || report.gaps.length || report.documents?.length)) fail("research_applicability_conflict", questionId, "An inapplicable domain cannot conceal facts, decisions or unresolved gaps");
  if (field.startsWith("gap_") && report.applicability !== "applicable") fail("research_gap_unresolved", questionId, "An inherited gap needs a concrete resolution, including when research disproves its premise");
  const obligations = question?.value.spec.obligations;
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
  let legacyIndex = 0;
  for (const fact of typed ? [] : report.facts) {
    try {
      const named = fact.path ?? '';
      let resolved: string;
      if (mode === 'historical') {
        // A failed current resolution has no path witness. Leave the next
        // witness available for the next fact so a saved refusal replays from
        // its original source view even if the file appears later.
        const captured = options.legacyPaths?.[legacyIndex];
        if (captured?.path === named) legacyIndex++;
        requireCondition(safeRelativePath(named) && !named.split('/').some(part => part.toLowerCase() === '.git')
          && captured?.path === named && typeof captured.resolved === 'string',
        'research_basis_invalid', 'Legacy fact path lost its original physical resolution');
        repositoryCitationPath(root, captured.resolved, 'historical');
        resolved = captured.resolved;
      } else {
        resolved = realpathSync(workspacePath(root, named));
        options.legacyPaths?.push({ path: named, resolved });
      }
      if (!files.some(source => source.value.origin.location === resolved))
        fail("repository_evidence_required", fact.id, "A repository fact must cite its actual source file");
    } catch { fail("repository_evidence_required", fact.id, "The factual source path is unavailable or outside the repository"); }
  }
  if (mode === 'historical' && (options.legacyPaths?.length ?? 0) !== legacyIndex)
    fail('research_basis_invalid', questionId, 'Historical path proof has surplus or mismatched legacy facts');
  for (const file of files) {
    try { repositoryCitationPath(root, file.value.origin.location, mode); }
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

export function technicalResearchFindings(store: Store, discovery: Discovery, draft: DiscoveryDraft, graph: Graph, root: string, admissionGuards:TransactionGuard[]=[]): Finding[] {
  return orderedQuestions(store, draft).flatMap(question => {
    const questionId = question!.id, field = question!.value.spec.field;
    const answer = question!.value.answer ? readAnswer(store, question!.value.answer.id) : null;
    if (answer?.kind !== "research-answer") return [{ code: "research_assessment_required", target: questionId, field,
      message: "Technical research requires an evidence-assessed report; a manual declaration is insufficient" }];
    const report=draft.fields[field] as unknown as TechnicalReport,observations=discovery.observations(questionId);
    const runtime=collectRuntimeEvidence(store,draft.projectId,question!.value.spec,report,observations);
    admissionGuards.push(...uniqueTransactionGuards([...runtime.guards, ...runtime.admissionGuards]));
    return technicalProposalFindings(store, draft.projectId, draft.level, questionId, field,report,observations,graph,root,runtime);
  });
}

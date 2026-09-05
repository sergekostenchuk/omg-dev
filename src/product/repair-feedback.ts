import type { Store } from "../storage/store.js";
import type { Discovery, DiscoveryDraft, Question } from "../discovery/discovery.js";
import type { PlanRepair } from "./repairs.js";
import { EngineError } from "../errors.js";
import { canonical, hashJson } from "../canonical.js";

export function reopenRejectedRepair(store: Store, discovery: Discovery, repair: PlanRepair, repairId: string, error: unknown): PlanRepair['phase'] | null {
  if (!(error instanceof EngineError)) return null;
  const technical = repair.phase === "research" && error.code === "technical_research_incomplete";
  const design = ["design", "compile"].includes(repair.phase) && ["accepted_prefix_repeated", "graph_invalid", "upper_layer_drift",
    "layer_connector_uncovered", "layer_port_unbound", "repair_not_feasible"].includes(error.code);
  if (!technical && !design) return null;
  const draft = store.get<DiscoveryDraft>(repair.draftId)!;
  const report = { kind: "repair-proposal-rejected", repair: repairId, draft: draft.id, proposalHash: hashJson(draft.value.fields),
    code: error.code, message: error.message, details: error.details };
  const id = `repair-feedback-${hashJson(report).slice(0, 32)}`;
  if (!store.get(`source:${repair.projectId}:${id}`)) discovery.evidence.document(repair.projectId, id, canonical(report), "application/json", 0);
  const targets = new Set<string>(technical && Array.isArray(error.details) ? error.details.map(item => item.target) : []);
  const answered = draft.value.questions.map(id => store.get<Question>(id)!).filter(question => question.value.status === "answered");
  const affected = answered.filter(question => {
    if (!technical || targets.has(question.id)) return true;
    const report = draft.value.fields[question.value.spec.field] as unknown as { facts?: { id: string }[]; designs?: { id: string }[]; gaps?: { id: string }[] };
    return [...(report?.facts ?? []), ...(report?.designs ?? []), ...(report?.gaps ?? [])].some(item => targets.has(item.id));
  });
  for (const question of affected.length ? affected : answered) discovery.reopen(question.id, question.revision);
  return technical ? "research" : "design";
}

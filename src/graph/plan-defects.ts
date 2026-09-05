import type { Store } from "../storage/store.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import type { TechnicalGap } from "./research-contracts.js";

export interface PlanDefect { projectId: string; run: Ref; plan: Ref; node: string; question: string; source: Ref; parked: Ref }
export interface PlanReissue { projectId: string; defect: Ref; plan: Ref }
export function planDefects(store: Store, project: string, imported: Ref[] = []) {
  return store.list<PlanDefect>("plan-defect").filter(record => record.value.projectId === project && (
    imported.some(ref => ref.id === record.id && ref.hash === record.hash)
    || !store.list<PlanReissue>("plan-reissue").some(reissue => reissue.value.defect.id === record.id && reissue.value.defect.hash === record.hash)));
}
export function defectGaps(store: Store, project: string, imported: Ref[] = []): TechnicalGap[] {
  return planDefects(store, project, imported).map(record => ({ id: record.id, target: record.value.node, field: "outcome",
    consumer: record.value.node, requiredFor: "current", question: `${record.value.question}\nИсследуй точную причину, мешающую получить результат узла, и необходимые изменения контракта. Источник: ${record.value.source.id}` }));
}
export function defectInputs(store: Store, project: string): Ref[] {
  return planDefects(store, project).flatMap(record => [reference(record), record.value.source]);
}

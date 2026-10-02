import { HASH_RE, type Json } from "../canonical.js";
import type { Revision, TransactionGuard } from "../storage/store.js";

export const STAGES = ["discovery", "concept", "operation-map", "specification", "features", "om-g2", "compilation", "execution"] as const;
export type Stage = typeof STAGES[number];
export type StageState = "missing" | "draft" | "blocked" | "accepted" | "stale";
export interface Finding { code: string; target: string; message: string; field?: string }
export interface Ref { id: string; revision: number; hash: string }
export interface StageArtifact {
  projectId: string;
  stage: Stage;
  status: "draft" | "accepted";
  content: Json;
  inputs: Ref[];
  proofs: Ref[];
}
export interface GateContext {
  projectId: string;
  content: Json;
  inputs: ReadonlyArray<Revision<StageArtifact>>;
  accepted?: boolean;
}
export interface GateResult { findings: Finding[]; guards: Ref[]; admissionGuards?: TransactionGuard[] }
export type StageValidator = (context: GateContext) => GateResult;
export type StageValidators = Record<Stage, StageValidator>;
export interface StageProjection { stage: Stage; state: StageState; artifact: Revision<StageArtifact> | null; findings: Finding[]; guards: Ref[]; admissionGuards?: TransactionGuard[] }

export const stageId = (project: string, stage: Stage): string => `stage:${project}:${stage}`;
export const reference = (record: Revision<unknown>): Ref => ({ id: record.id, revision: record.revision, hash: record.hash });
export function uniqueRefs(values: readonly Ref[]): Ref[] {
  return [...new Map(values.map(ref => [`${ref.id}:${ref.revision}:${ref.hash}`, ref])).entries()]
    .sort(([left], [right]) => left.localeCompare(right)).map(([, ref]) => ref);
}
export function isRef(value: unknown): value is Ref {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref['id'] === "string" && ref['id'].length > 0 && Number.isSafeInteger(ref['revision'])
    && Number(ref['revision']) > 0 && typeof ref['hash'] === "string" && HASH_RE.test(ref['hash']);
}
export function predecessor(stage: Stage): Stage | null {
  const index = STAGES.indexOf(stage);
  return index > 0 ? STAGES[index - 1]! : null;
}

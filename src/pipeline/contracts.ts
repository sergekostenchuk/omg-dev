import { HASH_RE, type Json } from "../canonical.js";
import type { Revision, Store, TransactionGuard } from "../storage/store.js";

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
  closure?: StageClosure;
}
export interface GateContext {
  projectId: string;
  content: Json;
  inputs: ReadonlyArray<Revision<StageArtifact>>;
  accepted?: boolean;
}
/** G1 (пул K ред.3, №6174): the contract of a recorded stage closure — one committed check of an accepted stage. */
export const STAGE_CLOSURE_CONTRACT = "stage-closure/v1";
/** An external check a stage validator declares for its closure: an executable descriptor, not a
 * function. `basis` is the exact Ref of the record the comparison was committed against — a saved
 * feasibility/inspection for repository/environment (its original root and expected state inside),
 * a plan/result for git-ancestry (its original root, commit, parent and tree inside). The handler
 * reads THAT exact basis and compares live data; it never picks a basis by a current head (№6212
 * п.1). Kinds the current binary cannot execute fall back to the full inspection path; a kind
 * outside this union makes the closure itself invalid. */
export type StageExternalCheck =
  | { kind: "source"; ref: Ref }
  | { kind: "graph-projection"; level: number; hash: string }
  | { kind: "repository"; basis: Ref }
  | { kind: "environment"; basis: Ref }
  | { kind: "git-ancestry"; basis: Ref }
  | { kind: "om-feasibility"; ref: Ref };
/** The validator's explicit declaration that `external` is the stage's COMPLETE external check surface —
 * its absence is not an empty list: stages without it never produce a closure (№6174 п.1). */
export interface StageClosureDeclaration { contract: typeof STAGE_CLOSURE_CONTRACT; external: StageExternalCheck[] }
/** The committed check of an accepted stage, stored inside its artifact: durable proofs and admission
 * (including absent guards), the external checks inherited from the predecessor's closure and declared by
 * this stage's own validator, and separately the guards of the acceptance write itself — those are an audit
 * of the commit, never proofs (№6174 п.2). */
export interface StageClosure {
  contract: typeof STAGE_CLOSURE_CONTRACT;
  proofs: Ref[];
  admission: TransactionGuard[];
  inherited: StageExternalCheck[];
  external: StageExternalCheck[];
  writeGuards: TransactionGuard[];
}
/** G1 (№6201 п.1): the context an external-check handler is called with — the Store to read live
 * dependencies from and the stage whose closure declared the check. */
export interface ExternalCheckContext { store: Store; projectId: string; stage: Stage }
/** The executor interface G2 plugs its handlers into (№6201 п.1): given the declaration and the saved
 * comparison basis carried inside it (the exact ref, the level/hash, the ancestry triple), a handler
 * checks live dependencies only — it never re-runs a stage validator or a full gate — and answers
 * `null` while the basis is still current or an addressed Finding with the stage's own code once it
 * is not. */
export type ExternalCheckHandler<K extends StageExternalCheck['kind'] = StageExternalCheck['kind']> =
  (check: Extract<StageExternalCheck, { kind: K }>, context: ExternalCheckContext) => Finding | null;
/** The registry of executors by check kind. A kind absent from the registry is not a silent pass:
 * the closed read falls back to the full inspection path. */
export type ExternalCheckHandlers = Readonly<{ [K in StageExternalCheck['kind']]?: ExternalCheckHandler<K> }>;
export interface GateResult { findings: Finding[]; guards: Ref[]; admissionGuards?: TransactionGuard[]; closure?: StageClosureDeclaration }
export type StageValidator = (context: GateContext) => GateResult;
export type StageValidators = Record<Stage, StageValidator>;
export interface StageProjection { stage: Stage; state: StageState; artifact: Revision<StageArtifact> | null; findings: Finding[]; guards: Ref[]; admissionGuards?: TransactionGuard[];
  /** The declaration the stage validator issued during this inspection; a closed read names none. */
  closure?: StageClosureDeclaration }

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

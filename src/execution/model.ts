import type { Ref } from "../pipeline/contracts.js";
import type { ProcessResult } from "../runtime/process.js";

export type RunState = "implementing" | "checking" | "reviewing" | "commit_pending" | "committed" | "needs_code" | "needs_plan" | "interrupted" | "awaiting_obligation";
/**
 * AT3a (№4125): the address of a plan finding — the exact plan, task and attempt, the candidate tree (none before a
 * candidate exists), the requirement or test of the task it concerns, and exactly one of the norm that contradicts it or
 * the necessary path outside the task's write paths; when it rests on a check, that saved check and its concrete failure.
 */
export interface PlanFindingAddress {
  plan: Ref; task: string; attempt: number; tree: string | null; requirement: string;
  norm: string | null; path: string | null; check: { index: number; failure: string } | null;
}
export interface ReviewFinding { text: string; address: PlanFindingAddress | null }
export const EXECUTION_REVIEW_CONTRACT = "execution-review/v2" as const;
/**
 * A review verdict. Its era: findings of strings before AT3a; findings with addresses under `contract` after it — the
 * engine marks a verdict it parsed in the addressed form, and a saved verdict is read by the rules of its own era.
 */
export interface ReviewResult { verdict: "pass" | "request_changes"; kind: "none" | "code" | "plan"; findings: (string | ReviewFinding)[];
  contract?: typeof EXECUTION_REVIEW_CONTRACT }
export const PLAN_DEFECT_CONTRACT = "execution-plan-defect/v1" as const;
/** AT3a: the addressed defect of the plan an attempt stopped on (needs_plan) — what AT3b turns into a repair of the accepted L3. */
export interface PlanDefect { contract: typeof PLAN_DEFECT_CONTRACT; source: "review" | "implementation"; findings: ReviewFinding[] }
/** The text of a finding of either era. */
export const findingText = (finding: string | ReviewFinding): string => typeof finding === "string" ? finding : finding.text;
export interface ArtifactValue { id: string }
export interface AgentUsage { mode: "implement" | "review"; model: string; effort: string; requestHash: string; requestChars: number; requestBytes: number; responseChars: number | null; responseBytes: number | null }
export interface ExecutionOptions { retry: boolean; maxContextChars: number; maxCorrections: number }
export interface CheckResult { command: { executable: string; args: string[] }; result: ProcessResult }
export interface TaskRun {
  obligationStartProofs: import('./task-obligations.js').TaskRuntimeProof[];
  obligationResultProofs: import('./task-obligations.js').TaskObligationProof[];
  projectId: string; plan: Ref; taskId: string; attempt: number; state: RunState;
  parent: string; tree: string | null; commit: string | null;
  implementation: string | null; artifacts: ArtifactValue[]; checks: CheckResult[];
  review: ReviewResult | null; reviewSubject: string | null; error: string | null;
  /** AT3a: present exactly on a needs_plan outcome of the addressed era. */
  planDefect?: PlanDefect;
  child: { pid: number; started: string } | null;
  inputs: Ref[]; usage: AgentUsage[];
  createdAt: number; updatedAt: number;
}
export interface ExecutionLock { projectId: string; token: string; pid: number; processStart: string; active: boolean }
export interface ExecutionResult { projectId: string; plan: Ref; runs: Ref[]; head: string }

export const runId = (planHash: string, taskId: string): string => `run:${planHash}:${taskId.replace(/^task:/, "")}`;

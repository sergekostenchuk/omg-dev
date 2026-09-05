import type { Ref } from "../pipeline/contracts.js";
import type { ProcessResult } from "../runtime/process.js";

export type RunState = "implementing" | "checking" | "reviewing" | "commit_pending" | "committed" | "needs_code" | "needs_plan" | "interrupted";
export interface ReviewResult { verdict: "pass" | "request_changes"; kind: "none" | "code" | "plan"; findings: string[] }
export interface ArtifactValue { id: string }
export interface AgentUsage { mode: "implement" | "review"; model: string; effort: string; requestHash: string; requestChars: number; requestBytes: number; responseChars: number | null; responseBytes: number | null }
export interface ExecutionOptions { retry: boolean; maxContextChars: number; maxCorrections: number }
export interface CheckResult { command: { executable: string; args: string[] }; result: ProcessResult }
export interface TaskRun {
  projectId: string; plan: Ref; taskId: string; attempt: number; state: RunState;
  parent: string; tree: string | null; commit: string | null;
  implementation: string | null; artifacts: ArtifactValue[]; checks: CheckResult[];
  review: ReviewResult | null; reviewSubject: string | null; error: string | null;
  child: { pid: number; started: string } | null;
  inputs: Ref[]; usage: AgentUsage[];
  createdAt: number; updatedAt: number;
}
export interface ExecutionLock { projectId: string; token: string; pid: number; processStart: string; active: boolean }
export interface ExecutionResult { projectId: string; plan: Ref; runs: Ref[]; head: string }

export const runId = (planHash: string, taskId: string): string => `run:${planHash}:${taskId.replace(/^task:/, "")}`;

import type { Json } from "../canonical.js";
import type { Ref } from "../pipeline/contracts.js";
import type { Observation, Selector } from "../evidence/evidence.js";

export interface ResearchAssessment {
  projectId: string; question: Ref; value: Json; observations: Observation[];
  verdict: "supported" | "insufficient" | "conflicting"; reasons: string[];
  researcher: string; assessor: string; environment: Ref;
  reusedFrom?: Ref;
}
export interface ResearchAnswer { projectId: string; question: string; assessment: Ref; value: Json }
export type ResearchAction =
  | { action: "search"; query: string }
  | { action: "read_source"; source: Ref; start: number; end: number }
  | { action: "read"; path: string; media: "text/plain" | "application/json" }
  | { action: "answer"; question: string; value: Json; citations: { source: Ref; selector: Selector }[] }
  | { action: "need_owner"; question: string; reason: string; searched: Ref[] }
  | { action: "pause"; reason: string };
export interface ResearchRun {
  projectId: string; draftId: string; environment: Ref; status: "running" | "completed" | "needs_owner" | "paused" | "failed";
  turns: number; limit: number; inputs: Ref[];
  ownerQuestion: { question: string; reason: string; searched: Ref[] } | null;
  error: string | null;
  owner: { pid: number; started: string }; requestChars: number;
}
export interface ResearchTurn {
  run: string; number: number; action: unknown; assessment: Ref | null; observation: unknown; error: string | null;
  status: "pending" | "completed"; question: Ref | null;
}

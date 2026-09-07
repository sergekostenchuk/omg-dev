import type { Json } from "../canonical.js";
import type { Ref } from "../pipeline/contracts.js";
import type { Observation, Selector } from "../evidence/evidence.js";
import type { LayerDelta } from "./layer-delta.js";
import type { BundleInput } from "./reader.js";
import type { ContextPage } from "./working-context.js";

export interface ResearchAssessment {
  projectId: string; question: Ref; value: Json; observations: Observation[];
  verdict: "supported" | "insufficient" | "conflicting"; reasons: string[];
  researcher: string; assessor: string; environment: Ref;
  reusedFrom?: Ref;
}
export interface ResearchAnswer { projectId: string; question: string; assessment: Ref; value: Json }
export type ResearchRead =
  | { action: "read_bundle"; purpose: string; inputs: BundleInput[] }
  | { action: "read_context"; record: Ref; pointer: string; page?: ContextPage }
  | { action: "search"; query: string }
  | { action: "read_source"; source: Ref; start: number; end: number }
  | { action: "read"; path: string; media: "text/plain" | "application/json" };
export type ResearchAction =
  | ResearchRead
  | { action: "read_plan"; question: string; reads: ResearchRead[] }
  | { action: "synthesize"; question: string }
  | { action: "need_research"; question: string; missing: string[] }
  | ({ action: "answer_delta"; question: string; citations: { source: Ref; selector: Selector }[] } & LayerDelta)
  | { action: "checkpoint"; question: string; value: Json; citations: { source: Ref; selector: Selector }[]; unresolved: string[] }
  | { action: "answer"; question: string; value: Json; citations: { source: Ref; selector: Selector }[] }
  | { action: "need_owner"; question: string; reason: string; searched: Ref[] }
  | { action: "pause"; reason: string };
export interface ResearchRun {
  projectId: string; draftId: string; environment: Ref; status: "running" | "completed" | "needs_owner" | "paused" | "failed";
  turns: number; limit: number; inputs: Ref[];
  ownerQuestion: { question: string; reason: string; searched: Ref[] } | null;
  error: string | null;
  pauseCode?: string | null;
  owner: { pid: number; started: string }; requestChars: number;
}
export interface ResearchTurn {
  run: string; number: number; action: unknown; assessment: Ref | null; observation: unknown; error: string | null;
  status: "pending" | "completed"; question: Ref | null;
  replayedFrom?: Ref;
  splitFrom?: Ref;
  recoveredRequest?: Ref;
  plannedBy?: Ref;
  dispatchMode?: "planning" | "synthesis";
}

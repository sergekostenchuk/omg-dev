import type { Json } from "../canonical.js";
import type { Ref } from "../pipeline/contracts.js";
import type { Observation, Selector } from "../evidence/evidence.js";
import type { LayerDelta } from "./layer-delta.js";
import type { BundleInput } from "./reader.js";
import type { ContextPage } from "./working-context.js";
import type { WebAction } from "./web-research.js";
import type { ClaimAddress } from "./claim-address.js";
import type { V7PlanSubject } from "./v7-managed-attempt.js";

/** ASM1.1 (№4791): the producer contract binding a direct assessment to the exact material its assessor saw. */
export const DIRECT_ASSESSMENT_ORIGIN = 'direct-assessment-origin/v1' as const;
export interface ResearchAssessment {
  /** ASM1.1: a direct assessment judged on an accepted prefix names its completed assessor session and application; their
   * saved material is the basis its acceptance guards. Part of the identity. Absent in an assessment made before. */
  origin?: { contract: typeof DIRECT_ASSESSMENT_ORIGIN; session: Ref; application: Ref };
  runtimeProofs?: import('../graph/runtime-evidence.js').RuntimeEvidence[];
  bases?: import('../graph/research-basis.js').ResolvedResearchBasis[];
  projectId: string; question: Ref; value: Json; observations: Observation[];
  verdict: "supported" | "insufficient" | "conflicting"; reasons: string[];
  researcher: string; assessor: string; environment: Ref;
  reusedFrom?: Ref;
}
/** UNK1 (№4686 §3): the completed turn of an early analyst that cannot answer its current question from the saved material.
 * The engine derives draft, question and field; missing is the model's; searched are the run's actually saved reads. */
export interface EarlyUnknown {
  contract: 'early-research-unknown/v1'; draft: Ref; question: Ref; field: string; missing: string[]; searched: Ref[];
  door: 'research' | 'upstream'; upstream?: { stage: Ref; field: string };
}
export interface ResearchAnswer { projectId: string; question: string; assessment: Ref; value: Json }
export type ResearchRead =
  | { action: "read_bundle"; purpose: string; inputs: BundleInput[] }
  | { action: "read_context"; purpose?: string; record: Ref; pointer: string; page?: ContextPage }
  | { action: "search"; query: string }
  | { action: "read_source"; source: Ref; start: number; end: number }
  | { action: "read"; path: string; media: "text/plain" | "application/json" }
  | WebAction;
export type ResearchAction =
  | ResearchRead
  | { action: "read_plan"; question: string; reads: ResearchRead[] }
  | { action: "synthesize"; question: string }
  | { action: "need_research"; question: string; missing: string[];
    /** UNK1 (№4686 §3): only in the early analyst era that admits the unknown door — the exact accepted input stage and
     * its field whose revision the missing material needs. Never guessed from the missing text. */
    upstream?: { stage: Ref; field: string } }
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
  /** DR3a3-S3: the exact plan subject. On a paid planner/analyst turn (O@1) it is fixed by the producer together
   * with attemptContract; on a queued child, its split parts and retries it is only the lineage of the exact
   * planner parent — never an attempt marker, so the child does not own an answer or K. */
  subject?: V7PlanSubject;
}

/* ---------- DR3b-M (codex-omg №7546 §1): the assessment of a packet of v7 attempts ---------- */

/** The subject of one attempts assessment: one plan-question of one exact plan edition and the completed managed
 * attempts of the packet, each with its exact attempt binding K, in the proven order (the ascending number of the K
 * original turn). Fixed before payment; nothing is added to a sent packet. */
export const V7_ATTEMPT_PACKET_CONTRACT = "v7-attempt-packet/v1" as const;
export interface V7AttemptPacketEntry { attempt: Ref; binding: Ref }
export interface V7AttemptPacket {
  contract: typeof V7_ATTEMPT_PACKET_CONTRACT;
  project: string;
  planAnswer: Ref;
  planQuestionId: string;
  /** The real Question of the plan field — the basis every producing intent of the packet named. */
  question: Ref;
  entries: V7AttemptPacketEntry[];
}

/** The comparison basis fixed with the packet: the exact previous progress state of the question (or its explicit
 * absence, guarded by absence) and the exact accepted materials the novelty is judged against. */
export const V7_PROGRESS_BASELINE_CONTRACT = "v7-progress-baseline/v1" as const;
export interface V7ProgressBaseline {
  contract: typeof V7_PROGRESS_BASELINE_CONTRACT;
  state: { kind: "absent"; id: string } | { kind: "state"; ref: Ref };
  materials: ClaimAddress[];
}

export interface V7NoveltyAttemptRow { attempt: Ref; reason: string }
export interface V7NoveltyClaimRow { claim: ClaimAddress; reason: string }
export interface V7NoveltyDuplicateRow { claim: ClaimAddress; of: ClaimAddress; reason: string }
/** A basis of a proposed question transition: an accepted claim, or the proven constraint of a refused/impossible
 * attempt of the packet (its code and evidence). */
export type V7TransitionBasis = { claim: ClaimAddress } | { constraint: Ref };
export interface V7QuestionTransition {
  outcome: "open" | "closed" | "unknown";
  bases: V7TransitionBasis[];
  reason: string;
  /** closed only: the saved sufficiency decision against the accepted plan's own criterion and depth. */
  sufficiency?: { criterion: string; requiredDepth: string; reason: string };
  /** unknown only (mandatory for a blocking question): the consequence and the next action. */
  consequence?: string;
  nextAction?: string;
}
/** The mandatory, complete classification of an attempts assessment. Every packet attempt has one row; every claim of
 * a submitted attempt is accepted or rejected; every accepted claim is new content or a duplicate of an earlier
 * accepted basis; noProgress names exactly the attempts without an acknowledged new basis. */
export interface V7Novelty {
  attempts: V7NoveltyAttemptRow[];
  accepted: V7NoveltyClaimRow[];
  rejected: V7NoveltyClaimRow[];
  newContent: V7NoveltyClaimRow[];
  duplicates: V7NoveltyDuplicateRow[];
  noProgress: V7NoveltyAttemptRow[];
  transition: V7QuestionTransition | null;
}

/** The separate, versioned assessment form of a v7 attempts packet. The old ResearchAssessment keeps its own meaning;
 * other subject kinds (dossier, bundle) are not admitted. The form names the paid session and application — whether
 * they prove a paid assessment is the paid reader's (DR3b-A), and its application is DR3b-P's. */
export const DISCOVERY_ASSESSMENT_CONTRACT = "discovery-assessment/v1" as const;
export interface DiscoveryAttemptsAssessment {
  contract: typeof DISCOVERY_ASSESSMENT_CONTRACT;
  projectId: string;
  subject: { kind: "attempts"; packet: V7AttemptPacket };
  baseline: V7ProgressBaseline;
  session: Ref;
  application: Ref;
  assessor: string;
  environment: Ref;
  verdict: "supported" | "return";
  reasons: string[];
  /** return only: where the work goes back — one packet attempt or one of its claims. */
  return: { target: { attempt: Ref } | { claim: ClaimAddress }; reason: string } | null;
  novelty: V7Novelty;
}

/** M2: v1 remains a historical form. A new producer explicitly chooses v2 and
 * delivers this methodology contract/policy before payment (T2/A). */
export const DISCOVERY_ASSESSMENT_CONTRACT_V2 = "discovery-assessment/v2" as const;
export interface DiscoveryAttemptsAssessmentV2 extends Omit<DiscoveryAttemptsAssessment, "contract"> {
  contract: typeof DISCOVERY_ASSESSMENT_CONTRACT_V2;
  methodology: import("./assessment-methodology.js").AssessmentMethodology;
}
export const DISCOVERY_ASSESSMENT_CONTRACT_V3 = 'discovery-assessment/v3' as const;
export interface V7QuestionTransitionV3 extends Omit<V7QuestionTransition, 'sufficiency'> {
  sufficiency?: NonNullable<V7QuestionTransition['sufficiency']> & {
    methodologyRequirements: import('./assessment-methodology.js').MethodologyRequirement[];
  };
}
export interface DiscoveryAttemptsAssessmentV3 extends Omit<DiscoveryAttemptsAssessmentV2, 'contract' | 'methodology' | 'novelty'> {
  contract: typeof DISCOVERY_ASSESSMENT_CONTRACT_V3;
  methodology: import('./assessment-methodology.js').AssessmentMethodology<'assessment-methodology-policy/v2'>;
  novelty: Omit<V7Novelty, 'transition'> & { transition: V7QuestionTransitionV3 | null };
}
export type PaidDiscoveryAttemptsAssessment = DiscoveryAttemptsAssessmentV2 | DiscoveryAttemptsAssessmentV3;
export type VersionedDiscoveryAttemptsAssessment = DiscoveryAttemptsAssessment | PaidDiscoveryAttemptsAssessment;

/** P.1: the counters fold is a pure projection, not a saved acceptance. */
export interface V7ProgressSubject { project: string; planAnswer: Ref; planQuestionId: string }
export interface V7ProgressSummary {
  cursor: { run: string; number: number } | null;
  count: number; streak: number; outcome: 'open' | 'closed' | 'unknown' | 'stalled';
  reason: string | null; nextAction: string | null;
}

export interface V7ProgressApplication {
  contract: 'v7-progress-application/v1'; subject: V7ProgressSubject; assessment: Ref;
  previous: Ref | null; methodologyOrigins: { claim: ClaimAddress; assessment: Ref }[];
  reused: Ref[]; priorEvents: Ref[]; attempts: Ref[]; after: V7ProgressSummary;
}
export interface V7ProgressState {
  contract: 'v7-progress-state/v1'; subject: V7ProgressSubject; application: Ref; summary: V7ProgressSummary;
}
export interface V7AttemptAccount {
  contract: 'v7-attempt-account/v1'; subject: V7ProgressSubject; application: Ref; attempt: Ref;
  number: number; accepted: ClaimAddress[]; eventIds: string[]; streak: number;
}
export interface V7ProgressEvent {
  contract: 'research-progress-event/v1'; id: string; subject: V7ProgressSubject; application: Ref; attempt: Ref;
  contentKey: string; type: 'claim' | 'constraint' | 'transition';
  basis: { claim: ClaimAddress } | { constraint: Ref }
    | { transition: { from: V7ProgressSummary['outcome']; to: string; bases: V7TransitionBasis[] } };
}

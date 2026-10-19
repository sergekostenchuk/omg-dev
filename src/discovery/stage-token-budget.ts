import type { Store, Revision, Write, ReadGuard } from "../storage/store.js";
import { reference } from "../pipeline/contracts.js";
import { hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import {
  segmentId,
  type BudgetSegment,
  type NewBudgetSegment,
  type BudgetSegmentTarget,
} from "../runtime/research-budget.js";
import type { DiscoveryDraft } from "./discovery.js";
import {
  isDiscoveryV7Draft,
  V7_STAGE_TOKEN_CEILING,
  V7_COMPLETION_RESERVE,
} from "./v7-contracts.js";

/** The deterministic budget key for stage-wide Discovery v7 tokens. */
export const DISCOVERY_V7_STAGE_BUDGET_KEY = "discovery-v7";

/**
 * Deterministic segment ID derived strictly from (projectId, 'discovery-v7'),
 * independent of any individual draft ID so that all drafts and replays of the
 * stage share the exact same stage budget segment.
 */
export function stageBudgetSegmentId(projectId: string): string {
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new EngineError("discovery_draft_invalid", "Project ID must be a non-empty string");
  }
  return segmentId(projectId, DISCOVERY_V7_STAGE_BUDGET_KEY);
}

export interface StageBudgetPlan {
  /** The stage budget segment: NewBudgetSegment if new (uncommitted), or Revision<BudgetSegment> if saved. */
  readonly segment: NewBudgetSegment | Revision<BudgetSegment>;
  /** Direct target for prepareNewSegmentReservation or reserveResearchCall. */
  readonly target: BudgetSegmentTarget;
  /** True when the segment does not exist yet and must be created by committing writes. */
  readonly isNew: boolean;
  /** Writes to commit: single segment write with expected: 0 when new, empty array when existing. */
  readonly writes: readonly Write[];
  /** Read guards: empty when new, [reference(existing)] when existing. */
  readonly guards: readonly ReadGuard[];
}

function checkStageBudgetSegmentPolicy(
  store: Store,
  segment: Revision<BudgetSegment>,
  projectId: string,
  segId: string
): void {
  // Integrity check: kind, id, hash
  if (
    segment.kind !== "research-budget" ||
    segment.id !== segId ||
    !segment.value ||
    typeof segment.value !== "object" ||
    Array.isArray(segment.value) ||
    segment.hash !== hashJson(segment.value) ||
    segment.value.projectId !== projectId ||
    segment.value.key !== DISCOVERY_V7_STAGE_BUDGET_KEY
  ) {
    throw new EngineError(
      "discovery_budget_policy_invalid",
      `Budget segment ${segId} is corrupted or forged`,
      { segmentId: segId, projectId }
    );
  }

  // Exact saved revision verification in store
  const saved = store.get<BudgetSegment>(segId, segment.revision);
  if (!saved || saved.hash !== segment.hash || saved.kind !== "research-budget") {
    throw new EngineError(
      "discovery_budget_policy_invalid",
      `Budget segment ${segId} revision ${segment.revision} is inconsistent in store`,
      { segmentId: segId, projectId }
    );
  }

  // Initial revision verification (segments in OMG are immutable from rev 1)
  const original = store.get<BudgetSegment>(segId, 1);
  if (!original || original.kind !== "research-budget" || original.id !== segId
    || original.revision !== 1 || !original.value || typeof original.value !== "object"
    || Array.isArray(original.value) || original.hash !== hashJson(original.value)
    || original.value.projectId !== projectId || original.value.key !== DISCOVERY_V7_STAGE_BUDGET_KEY) {
    throw new EngineError(
      "discovery_budget_policy_invalid",
      `Budget segment ${segId} original revision 1 is missing or invalid`,
      { segmentId: segId, projectId }
    );
  }

  // Trusted Discovery v7 policy checks:
  // limit = 20M, initialGroupLimit = 20M, completionReserve = 2M, ownerGroupCeiling = undefined
  const val = segment.value;
  if (
    val.limit !== V7_STAGE_TOKEN_CEILING ||
    val.initialGroupLimit !== V7_STAGE_TOKEN_CEILING ||
    val.completionReserve !== V7_COMPLETION_RESERVE ||
    val.ownerGroupCeiling !== undefined ||
    original.value.limit !== V7_STAGE_TOKEN_CEILING ||
    original.value.initialGroupLimit !== V7_STAGE_TOKEN_CEILING ||
    original.value.completionReserve !== V7_COMPLETION_RESERVE ||
    original.value.ownerGroupCeiling !== undefined
  ) {
    throw new EngineError(
      "discovery_budget_policy_invalid",
      `Budget segment ${segId} policy parameters deviate from trusted Discovery v7 policy`,
      { segmentId: segId, projectId, limit: val.limit, reserve: val.completionReserve }
    );
  }
}

function assertSavedDraftRevision(store: Store, draft: Revision<DiscoveryDraft>): void {
  if (
    !draft ||
    typeof draft !== "object" ||
    draft.kind !== "discovery-draft" ||
    typeof draft.id !== "string" ||
    typeof draft.revision !== "number" ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 1 ||
    typeof draft.hash !== "string" ||
    !draft.value ||
    typeof draft.value !== "object" ||
    Array.isArray(draft.value)
  ) {
    throw new EngineError("discovery_draft_invalid", "Draft must be a valid Revision<DiscoveryDraft>");
  }

  const saved = store.get<DiscoveryDraft>(draft.id, draft.revision);
  if (
    !saved ||
    saved.kind !== "discovery-draft" ||
    saved.hash !== draft.hash ||
    hashJson(draft.value) !== draft.hash
  ) {
    throw new EngineError(
      "discovery_draft_invalid",
      `Draft ${draft.id} is not an exact saved revision in the store`,
      { draftId: draft.id, revision: draft.revision }
    );
  }

  if (typeof draft.value.projectId !== "string" || draft.value.projectId.trim().length === 0) {
    throw new EngineError("discovery_draft_invalid", "Draft projectId must be a non-empty string", {
      draftId: draft.id,
    });
  }

  const draftValue = draft.value;
  if (!isDiscoveryV7Draft(draftValue)) {
    const raw = draftValue as Partial<DiscoveryDraft>;
    throw new EngineError(
      "discovery_budget_not_v7",
      `Stage token budget is only available for Discovery v7 drafts (stage=${raw.stage}, contractVersion=${raw.contractVersion})`,
      {
        draftId: draft.id,
        stage: raw.stage,
        contractVersion: raw.contractVersion,
      }
    );
  }
}

/**
 * Producer of the Discovery v7 stage token budget plan.
 *
 * Verifies that the draft is an exact saved Discovery era-7 draft.
 * - If the deterministic segment (projectId, 'discovery-v7') does not exist:
 *   returns a creation plan with expected: 0 according to the trusted policy.
 * - If the segment exists and matches the trusted policy:
 *   returns the existing segment without writes, guarding its current revision.
 * - If the segment exists but deviates or is damaged:
 *   throws a typed refusal `discovery_budget_policy_invalid` (absence != corruption).
 */
export function stageBudgetPlan(store: Store, draft: Revision<DiscoveryDraft>): StageBudgetPlan {
  assertSavedDraftRevision(store, draft);
  const projectId = draft.value.projectId;
  const segId = stageBudgetSegmentId(projectId);

  const existing = store.get<BudgetSegment>(segId);

  if (existing === null) {
    // Absence is NOT damage. Create plan with expected: 0.
    const creating: NewBudgetSegment = Object.freeze({
      projectId,
      key: DISCOVERY_V7_STAGE_BUDGET_KEY,
      limit: V7_STAGE_TOKEN_CEILING,
      initialGroupLimit: V7_STAGE_TOKEN_CEILING,
      completionReserve: V7_COMPLETION_RESERVE,
    });
    const write: Write = {
      id: segId,
      kind: "research-budget",
      expected: 0,
      value: creating,
    };
    return {
      segment: creating,
      target: { creating },
      isNew: true,
      writes: Object.freeze([write]),
      guards: Object.freeze([]),
    };
  }

  // Segment exists — verify integrity and policy conformance.
  checkStageBudgetSegmentPolicy(store, existing, projectId, segId);

  return {
    segment: existing,
    target: { saved: existing },
    isNew: false,
    writes: Object.freeze([]),
    guards: Object.freeze([reference(existing)]),
  };
}

/**
 * Convenience helper: executes stageBudgetPlan and, if new, commits the writes,
 * returning the saved Revision<BudgetSegment>.
 */
export function ensureStageBudget(store: Store, draft: Revision<DiscoveryDraft>): Revision<BudgetSegment> {
  const plan = stageBudgetPlan(store, draft);
  if (plan.isNew) {
    store.writeMany([...plan.writes], [...plan.guards]);
    const saved = store.get<BudgetSegment>(plan.writes[0]!.id);
    if (!saved) {
      throw new EngineError("discovery_budget_policy_invalid", "Failed to load newly created stage budget segment");
    }
    return saved;
  }
  return plan.segment as Revision<BudgetSegment>;
}

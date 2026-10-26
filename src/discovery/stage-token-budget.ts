import type { Store, Revision, Write, ReadGuard } from "../storage/store.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { canonical, hashJson } from "../canonical.js";
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

function policyInvalid(segId: string, projectId: string, message: string, details: Record<string, unknown> = {}): never {
  throw new EngineError("discovery_budget_policy_invalid", message, { segmentId: segId, projectId, ...details });
}
/** The trusted Discovery v7 policy of one segment body: initial group 20M, reserve 2M, no owner ceiling; `limit` given. */
function hasTrustedShape(value: BudgetSegment, limit: number): boolean {
  return value.limit === limit && value.initialGroupLimit === V7_STAGE_TOKEN_CEILING
    && value.completionReserve === V7_COMPLETION_RESERVE && value.ownerGroupCeiling === undefined;
}
/**
 * 5.7/Р3: the whole saved chain of the stage budget up to one exact revision. Revision 1 is the trusted policy of 20M.
 * A later revision is either the exact previous body with a higher limit, raised by its proven owner increase act, or —
 * markerless history kept by its former contract — the trusted policy itself. Any other head, a raised one without its
 * proven act above all, is refused. Only immutable saved revisions are read; no live bearer or head of today.
 */
function proveStageBudgetRevision(store: Store, projectId: string, segId: string, revision: number):
  { segment: Revision<BudgetSegment>; increases: Ref[] } {
  const segment = store.get<BudgetSegment>(segId, revision);
  if (!segment || segment.kind !== "research-budget" || segment.id !== segId || segment.revision !== revision
    || !segment.value || typeof segment.value !== "object" || Array.isArray(segment.value)
    || segment.hash !== hashJson(segment.value) || segment.value.projectId !== projectId
    || segment.value.key !== DISCOVERY_V7_STAGE_BUDGET_KEY)
    policyInvalid(segId, projectId, `Budget segment ${segId} revision ${revision} is missing, corrupted or forged`, { revision });
  if (revision === 1) {
    if (!hasTrustedShape(segment.value, V7_STAGE_TOKEN_CEILING))
      policyInvalid(segId, projectId, `Budget segment ${segId} original revision deviates from trusted Discovery v7 policy`,
        { limit: segment.value.limit, reserve: segment.value.completionReserve });
    return { segment, increases: [] };
  }
  const prior = proveStageBudgetRevision(store, projectId, segId, revision - 1);
  // The act is written once beside the revision it raises: its immutable first revision is read, never a head, so a
  // historical view over just the saved accounting grounds proves the same chain.
  const act = store.get<StageBudgetIncrease>(stageBudgetIncreaseId(projectId, revision), 1);
  if (!act) {
    if (!hasTrustedShape(segment.value, V7_STAGE_TOKEN_CEILING))
      policyInvalid(segId, projectId, `Budget segment ${segId} policy parameters deviate from trusted Discovery v7 policy without a proven owner increase`,
        { revision, limit: segment.value.limit, reserve: segment.value.completionReserve });
    return { segment, increases: prior.increases };
  }
  proveStageBudgetIncrease(store, projectId, act, segment, prior);
  return { segment, increases: [...prior.increases, reference(act)] };
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

  // Segment exists — verify integrity and the whole proven chain of its policy (5.7/Р3: proven owner increases).
  proveStageBudgetRevision(store, projectId, segId, existing.revision);

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

// ---- 5.7/Р3: the owner increase of the stage budget ----------------------------------------------------------------
// The capability itself (unforgeable authority, sessions, exchange, revoke, producer) lives in product/owner-authority.ts;
// the saved forms and their historical proofs live here, so that the budget reader proves an increase without importing
// the authority module (import ring). A separate versioned branch: no other owner action, actor, flag or mode is enough.
export const STAGE_BUDGET_ACTION = "discovery-stage-budget" as const;
export const STAGE_BUDGET_PAIRING_METHOD = "local-pairing/v1" as const;
export const STAGE_BUDGET_GRANT_CONTRACT = "owner-session-grant/v5" as const;
export const STAGE_BUDGET_SESSION_CONTRACT = "owner-session/v5" as const;
export const STAGE_BUDGET_GRANT_PREFIX = "owner-stage-budget-grant:";
export const STAGE_BUDGET_SESSION_PREFIX = "owner-stage-budget-session:";
export const STAGE_BUDGET_GRANT_KIND = "owner-session-grant";
export const STAGE_BUDGET_SESSION_KIND = "owner-session";
export const STAGE_BUDGET_GRANT_LIFETIME_MS = 10 * 60_000;
export const STAGE_BUDGET_SESSION_LIFETIME_MS = 30 * 60_000;
export const STAGE_BUDGET_INCREASE_KIND = "discovery-stage-budget-increase";
export const STAGE_BUDGET_INCREASE_CONTRACT = "discovery-stage-budget-increase/v1" as const;

/** One exact increase: the stage of one project, the exact previous segment revision and the approved new finite limit. */
export interface StageBudgetScope { project: string; stage: "discovery"; previous: Ref; limit: number }
export interface StageBudgetSessionGrant {
  contract: typeof STAGE_BUDGET_GRANT_CONTRACT; id: string; database: string; action: typeof STAGE_BUDGET_ACTION;
  method: typeof STAGE_BUDGET_PAIRING_METHOD; scope: StageBudgetScope; issuedAt: number; expiresAt: number; proof: string;
}
export interface StageBudgetSession {
  contract: typeof STAGE_BUDGET_SESSION_CONTRACT; grant: Ref; database: string; action: typeof STAGE_BUDGET_ACTION;
  method: typeof STAGE_BUDGET_PAIRING_METHOD; scope: StageBudgetScope; session: string; openedAt: number; expiresAt: number;
  state: "open" | "closed"; closedAt?: number;
}
/** The saved owner act: the new segment revision it wrote, the exact previous one, the limit and the authority used. */
export interface StageBudgetIncrease {
  contract: typeof STAGE_BUDGET_INCREASE_CONTRACT; database: string; project: string; stage: "discovery";
  segment: Ref; previous: Ref; limit: number; authority: { session: Ref; scope: StageBudgetScope }; at: number;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) =>
  keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const exact = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
function increaseInvalid(field: string, message: string, details: Record<string, unknown> = {}): never {
  throw new EngineError("discovery_budget_increase_invalid", message, { field, ...details });
}

export function stageBudgetSessionId(grant: Ref): string {
  return `${STAGE_BUDGET_SESSION_PREFIX}${hashJson({ id: grant.id, revision: grant.revision, hash: grant.hash })}`;
}
/** The one address of the increase act that wrote revision `revision` of the project's stage budget segment. */
export function stageBudgetIncreaseId(projectId: string, revision: number): string {
  return `${STAGE_BUDGET_INCREASE_KIND}:${hashJson({ segment: stageBudgetSegmentId(projectId), revision })}`;
}
/** The closed scope of one increase; a positive safe integer limit and the exact previous segment revision only. */
export function requireStageBudgetScope(value: unknown): StageBudgetScope {
  if (!plain(value) || !exactKeys(value, ["project", "stage", "previous", "limit"]) || !text(value.project)
    || value.stage !== "discovery" || !isRef(value.previous) || value.previous.id !== stageBudgetSegmentId(value.project)
    || !Number.isSafeInteger(value.limit) || (value.limit as number) <= 0)
    increaseInvalid("scope", "A stage-budget increase names the project, the discovery stage, the exact previous segment revision and a positive finite limit only");
  return { project: value.project as string, stage: "discovery", previous: exact(value.previous as Ref), limit: value.limit as number };
}
function exactRecord<T>(store: Store, ref: unknown, kind: string, prefix: string, field: string): Revision<T> {
  if (!isRef(ref) || !ref.id.startsWith(prefix)) increaseInvalid(field, `Expected the exact ${field} record`);
  const row = store.get<T>(ref.id, ref.revision);
  if (!row || row.kind !== kind || row.hash !== ref.hash || row.hash !== hashJson(row.value as never) || !plain(row.value))
    increaseInvalid(field, `The exact ${field} record is not stored as referenced`, { ref });
  return row;
}
/** Historical proof of one exact v5 grant record: its complete closed provenance. */
export function readStageBudgetGrant(store: Store, ref: unknown): Revision<StageBudgetSessionGrant> {
  const row = exactRecord<StageBudgetSessionGrant>(store, ref, STAGE_BUDGET_GRANT_KIND, STAGE_BUDGET_GRANT_PREFIX, "grant");
  const value = row.value as unknown as Record<string, unknown>;
  if (!exactKeys(value, ["contract", "id", "database", "action", "method", "scope", "issuedAt", "expiresAt", "proof"])
    || value.contract !== STAGE_BUDGET_GRANT_CONTRACT || !text(value.id) || row.id !== `${STAGE_BUDGET_GRANT_PREFIX}${value.id}`
    || !text(value.database) || value.action !== STAGE_BUDGET_ACTION || value.method !== STAGE_BUDGET_PAIRING_METHOD
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) - (value.issuedAt as number) !== STAGE_BUDGET_GRANT_LIFETIME_MS
    || typeof value.proof !== "string" || !/^[a-f0-9]{64}$/.test(value.proof))
    increaseInvalid("grant", "A stage-budget invitation keeps its complete v5 provenance", { ref: reference(row) });
  requireStageBudgetScope(value.scope);
  return row;
}
/** Historical proof of one exact v5 session revision: its complete closed provenance, open or closed. */
export function readStageBudgetSession(store: Store, ref: unknown): Revision<StageBudgetSession> {
  const row = exactRecord<StageBudgetSession>(store, ref, STAGE_BUDGET_SESSION_KIND, STAGE_BUDGET_SESSION_PREFIX, "session");
  const value = row.value as unknown as Record<string, unknown>;
  if (!exactKeys(value, ["contract", "grant", "database", "action", "method", "scope", "session", "openedAt", "expiresAt", "state"], ["closedAt"])
    || value.contract !== STAGE_BUDGET_SESSION_CONTRACT || !isRef(value.grant) || row.id !== stageBudgetSessionId(value.grant)
    || !text(value.database) || value.action !== STAGE_BUDGET_ACTION || value.method !== STAGE_BUDGET_PAIRING_METHOD
    || !text(value.session) || !Number.isSafeInteger(value.openedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) - (value.openedAt as number) !== STAGE_BUDGET_SESSION_LIFETIME_MS
    || (value.state !== "open" && value.state !== "closed")
    || (value.state === "closed") !== Object.hasOwn(value, "closedAt")
    || (value.state === "closed" && !Number.isSafeInteger(value.closedAt)))
    increaseInvalid("session", "A stage-budget owner session keeps its complete v5 provenance", { ref: reference(row) });
  requireStageBudgetScope(value.scope);
  return row;
}
/** The saved act that raised `segment` from `prior`, proved from its own grounds — never from a live bearer or today. */
function proveStageBudgetIncrease(store: Store, projectId: string, act: Revision<StageBudgetIncrease>,
  segment: Revision<BudgetSegment>, prior: { segment: Revision<BudgetSegment>; increases: Ref[] }): void {
  const segId = segment.id, value = act.value as unknown as Record<string, unknown>;
  const fail = (field: string, message: string): never => policyInvalid(segId, projectId, message, { revision: segment.revision, increase: reference(act), field });
  if (act.kind !== STAGE_BUDGET_INCREASE_KIND || act.hash !== hashJson(act.value as never) || !plain(value)
    || !exactKeys(value, ["contract", "database", "project", "stage", "segment", "previous", "limit", "authority", "at"])
    || value.contract !== STAGE_BUDGET_INCREASE_CONTRACT || value.database !== store.databaseId || value.project !== projectId
    || value.stage !== "discovery" || !Number.isSafeInteger(value.at) || (value.at as number) <= 0
    || !plain(value.authority) || !exactKeys(value.authority, ["session", "scope"]))
    fail("contract", "A stage-budget increase keeps its complete v1 provenance");
  const scope = (() => { try { return requireStageBudgetScope((value.authority as Record<string, unknown>).scope); }
    catch { return fail("scope", "The increase names a closed scope"); } })();
  if (!same(value.segment, reference(segment)) || !same(value.previous, reference(prior.segment))
    || !same(scope, { project: projectId, stage: "discovery", previous: reference(prior.segment), limit: value.limit })
    || value.limit !== segment.value.limit || (value.limit as number) <= prior.segment.value.limit
    || !same(segment.value, { ...prior.segment.value, limit: value.limit }))
    fail("segment", "The increase raises exactly the previous segment revision to its approved higher limit, changing nothing else");
  let session: Revision<StageBudgetSession>, grant: Revision<StageBudgetSessionGrant>;
  try {
    session = readStageBudgetSession(store, (value.authority as Record<string, unknown>).session);
    grant = readStageBudgetGrant(store, session.value.grant);
  } catch { return fail("authority", "The increase names its exact saved v5 session and grant"); }
  // The pinned revision is the exact open one the producer guarded; the relations are checked against the saved times.
  if (session!.value.state !== "open" || session!.value.database !== store.databaseId || !same(session!.value.scope, scope)
    || session!.value.openedAt > (value.at as number) || (value.at as number) >= session!.value.expiresAt)
    fail("session", "The increase was authorized by its exact saved open stage-budget session");
  if (grant!.value.database !== store.databaseId || !same(grant!.value.scope, session!.value.scope)
    || grant!.value.issuedAt > session!.value.openedAt || session!.value.openedAt >= grant!.value.expiresAt)
    fail("grant", "The stage-budget session descends from its exact saved grant");
  const previousAct = prior.increases.at(-1);
  if (previousAct && (store.get<StageBudgetIncrease>(previousAct.id, previousAct.revision)!.value.at > (value.at as number)))
    fail("at", "An increase is not older than the increase before it");
}
/** 5.7/Р3: the proven owner act at an exact Ref — its whole budget chain re-derived from saved records. */
export function readStageBudgetIncrease(store: Store, projectId: string, ref: unknown): Revision<StageBudgetIncrease> {
  const row = exactRecord<StageBudgetIncrease>(store, ref, STAGE_BUDGET_INCREASE_KIND, `${STAGE_BUDGET_INCREASE_KIND}:`, "increase");
  const segment = (row.value as unknown as Record<string, unknown>).segment;
  if (!isRef(segment) || segment.id !== stageBudgetSegmentId(projectId) || row.id !== stageBudgetIncreaseId(projectId, segment.revision))
    increaseInvalid("increase", "The increase is addressed by the segment revision it wrote", { ref });
  const proven = proveStageBudgetRevision(store, projectId, segment.id, segment.revision);
  if (!proven.increases.some(item => same(item, reference(row))))
    increaseInvalid("increase", "The increase is not the proven act of its segment revision", { ref });
  return row;
}
export interface EffectiveStageBudget {
  /** The proven head of the stage segment, or null while the stage has none. */
  segment: Revision<BudgetSegment> | null;
  /** The effective stage limit: the trusted 20M, or the limit of the last proven owner increase. */
  limit: number;
  completionReserve: number;
  /** The proven owner increases of the chain, in order. */
  increases: Ref[];
}
/** 5.7/Р3: the common reader of the effective stage allowance — the proven head chain, never a caller's limit. */
export function readEffectiveStageBudget(store: Store, projectId: string): EffectiveStageBudget {
  const segId = stageBudgetSegmentId(projectId), head = store.get<BudgetSegment>(segId);
  if (!head) return { segment: null, limit: V7_STAGE_TOKEN_CEILING, completionReserve: V7_COMPLETION_RESERVE, increases: [] };
  const proven = proveStageBudgetRevision(store, projectId, segId, head.revision);
  return { segment: proven.segment, limit: proven.segment.value.limit, completionReserve: proven.segment.value.completionReserve,
    increases: proven.increases };
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson } from "../src/canonical.js";
import { reference } from "../src/pipeline/contracts.js";
import { Store, type Write, type Revision, type ReadGuard } from "../src/storage/store.js";
import { Discovery, type DiscoveryDraft } from "../src/discovery/discovery.js";
import {
  V7_CONTRACT_ERA,
  V7_STAGE_TOKEN_CEILING,
  V7_COMPLETION_RESERVE,
  V7_STAGE_BUDGET_POLICY,
  isDiscoveryV7Draft,
  createPartialV7Draft,
  V7_AXES,
  V7_FRAME_FIELD,
  checkV7FieldAnswer,
} from "../src/discovery/v7-contracts.js";
import {
  stageBudgetSegmentId,
  stageBudgetPlan,
  ensureStageBudget,
  DISCOVERY_V7_STAGE_BUDGET_KEY,
} from "../src/discovery/stage-token-budget.js";
import {
  prepareNewSegmentReservation,
  reserveResearchCall,
  budgetUsage,
  type BudgetSegment,
  type NewBudgetSegment,
} from "../src/runtime/research-budget.js";
import type { ModelCall } from "../src/runtime/model-usage.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-stage-budget-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const discovery = new Discovery(store);
  return { root, store, discovery };
}

function beforeCommit(store: Store, injection: () => void) {
  const original = store.writeMany.bind(store);
  store.writeMany = function <T>(writes: Write[], guards: ReadGuard[] = []) {
    store.writeMany = original;
    injection();
    return original<T>(writes, guards);
  };
}

const role = {
  actor: "reader",
  model: "fixture",
  effort: "high",
  speed: "fast",
  command: { executable: process.execPath, args: [] },
} as const;

function mockModelCall(id: string, projectId = "p-1"): ModelCall {
  return {
    projectId,
    draftId: "d-1",
    purpose: "analyst",
    requestId: id,
    startedAt: 1,
    finishedAt: null,
    status: "running",
    requested: { ...role, command: { ...role.command, args: [] } },
    confirmed: { model: null, effort: null, speed: null },
    request: { chars: 1, bytes: 1, hash: hashJson(id) },
    response: null,
    usage: null,
    usageSource: "unavailable",
    error: null,
  };
}

test("isDiscoveryV7Draft predicate distinguishes era-7 discovery drafts from other stages and eras", (t) => {
  const { discovery } = fixture(t);
  const v7Draft = createPartialV7Draft(discovery, "p-v7", "concept");

  // The predicate narrows the draft body; an envelope is not that body.
  assert.equal(isDiscoveryV7Draft(v7Draft), false);
  assert.equal(isDiscoveryV7Draft(v7Draft.value), true);

  // False for different stage with contractVersion = 7
  assert.equal(isDiscoveryV7Draft({ stage: "concept", contractVersion: 7 }), false);
  assert.equal(isDiscoveryV7Draft({ stage: "operation-map", contractVersion: 7 }), false);

  // False for stage = discovery with era != 7 or undefined
  assert.equal(isDiscoveryV7Draft({ stage: "discovery", contractVersion: 6 }), false);
  assert.equal(isDiscoveryV7Draft({ stage: "discovery" }), false);
  assert.equal(isDiscoveryV7Draft({ stage: "discovery", contractVersion: undefined }), false);

  // False for non-objects / primitives / null
  assert.equal(isDiscoveryV7Draft(null), false);
  assert.equal(isDiscoveryV7Draft(undefined), false);
  assert.equal(isDiscoveryV7Draft("discovery"), false);
  assert.equal(isDiscoveryV7Draft(7), false);
  assert.equal(isDiscoveryV7Draft({}), false);
});

test("V7_STAGE_BUDGET_POLICY and completion reserve are frozen trusted constants", () => {
  assert.equal(V7_STAGE_TOKEN_CEILING, 20_000_000);
  assert.equal(V7_COMPLETION_RESERVE, 2_000_000);
  assert.deepEqual(V7_STAGE_BUDGET_POLICY, {
    ceiling: 20_000_000,
    completionReserve: 2_000_000,
  });
  assert.ok(Object.isFrozen(V7_STAGE_BUDGET_POLICY));
});

test("stageBudgetSegmentId produces deterministic segment ID decoupled from draft ID", () => {
  const seg1 = stageBudgetSegmentId("proj-alpha");
  const seg2 = stageBudgetSegmentId("proj-alpha");
  assert.equal(seg1, seg2);
  assert.equal(seg1, `research-budget:${hashJson(["proj-alpha", DISCOVERY_V7_STAGE_BUDGET_KEY])}`);

  const segBeta = stageBudgetSegmentId("proj-beta");
  assert.notEqual(seg1, segBeta);

  // Rejects invalid project IDs
  assert.throws(() => stageBudgetSegmentId(""), { code: "discovery_draft_invalid" });
  assert.throws(() => stageBudgetSegmentId("   "), { code: "discovery_draft_invalid" });
  assert.throws(() => stageBudgetSegmentId(null as unknown as string), { code: "discovery_draft_invalid" });
});

test("stageBudgetPlan on missing segment creates expected:0 plan matching trusted policy without writing store", (t) => {
  const { store, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "proj-1", "concept");
  const segId = stageBudgetSegmentId("proj-1");

  // Segment does not exist before plan
  assert.equal(store.get(segId), null);

  const plan = stageBudgetPlan(store, draft);

  // Plan properties
  assert.equal(plan.isNew, true);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.guards.length, 0);

  const write = plan.writes[0]!;
  assert.equal(write.id, segId);
  assert.equal(write.kind, "research-budget");
  assert.equal(write.expected, 0);
  assert.deepEqual(write.value, {
    projectId: "proj-1",
    key: DISCOVERY_V7_STAGE_BUDGET_KEY,
    limit: 20_000_000,
    initialGroupLimit: 20_000_000,
    completionReserve: 2_000_000,
  });

  // Target object structure
  assert.deepEqual(plan.target, { creating: write.value as NewBudgetSegment });
  assert.deepEqual(plan.segment, write.value);

  // Pure plan: store was not mutated by stageBudgetPlan
  assert.equal(store.get(segId), null);
});

test("committing plan writes and repeating stageBudgetPlan returns existing segment without writes", (t) => {
  const { store, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "proj-repeat", "concept");
  const segId = stageBudgetSegmentId("proj-repeat");

  const plan1 = stageBudgetPlan(store, draft);
  assert.equal(plan1.isNew, true);

  // Commit the plan
  store.writeMany([...plan1.writes], [...plan1.guards]);

  // Verified in store
  const saved = store.get<BudgetSegment>(segId);
  assert.ok(saved);
  assert.equal(saved.revision, 1);
  assert.equal(saved.value.limit, 20_000_000);
  assert.equal(saved.value.completionReserve, 2_000_000);

  // Repeat call with same draft
  const plan2 = stageBudgetPlan(store, draft);
  assert.equal(plan2.isNew, false);
  assert.equal(plan2.writes.length, 0);
  assert.deepEqual(plan2.guards, [reference(saved)]);
  const seg2 = plan2.segment as Revision<BudgetSegment>;
  assert.equal(seg2.revision, 1);
  assert.deepEqual(plan2.target, { saved });

  // ensureStageBudget convenience helper also returns the exact saved segment
  const ensured = ensureStageBudget(store, draft);
  assert.equal(ensured.revision, 1);
  assert.equal(ensured.hash, saved.hash);
});

test("draft replacement or recreation in the same stage retains segment and preserves expenditure", (t) => {
  const { store, discovery } = fixture(t);
  const draft1 = createPartialV7Draft(discovery, "proj-share", "concept");
  const seg = ensureStageBudget(store, draft1);

  // Spend tokens against the stage segment
  const estimate = {
    kind: "estimated" as const,
    tokens: 500_000,
    basis: [reference(draft1)],
    explanation: "first research call",
  };
  const reservation = reserveResearchCall(store, { saved: seg }, "call-1", ["shared-group"], estimate, "research");
  store.writeMany(
    [
      { id: "call-1", kind: "model-call", expected: 0, value: mockModelCall("call-1", "proj-share") },
      ...reservation.writes,
    ],
    reservation.guards
  );

  const usageBefore = budgetUsage(store, seg);
  assert.equal(usageBefore.reserved, 500_000);

  // Create a second v7 draft for the same project
  const draft2 = createPartialV7Draft(discovery, "proj-share", "concept");
  assert.notEqual(draft1.id, draft2.id);

  // Second draft stageBudgetPlan returns existing segment with expenditure preserved
  const plan2 = stageBudgetPlan(store, draft2);
  assert.equal(plan2.isNew, false);
  assert.equal(plan2.writes.length, 0);
  const segShare = plan2.segment as Revision<BudgetSegment>;
  assert.equal(segShare.id, seg.id);

  const usageAfter = budgetUsage(store, plan2.segment as Revision<BudgetSegment>);
  assert.equal(usageAfter.reserved, 500_000);
  assert.equal(usageAfter.remaining, 20_000_000 - 500_000);
});

test("non-v7 drafts are refused with discovery_budget_not_v7 and create no segment", (t) => {
  const { store } = fixture(t);
  const segId = stageBudgetSegmentId("proj-legacy");

  // Create a legacy v6 discovery draft directly in the store
  const v6Draft = store.write<DiscoveryDraft>({
    id: "draft-legacy-v6",
    kind: "discovery-draft",
    expected: 0,
    value: {
      projectId: "proj-legacy",
      createdAt: Date.now(),
      stage: "discovery",
      level: "R0",
      consumer: "tester",
      fields: {},
      questions: [],
      inputs: [],
      // no contractVersion, representing v6
    },
  });

  assert.throws(() => stageBudgetPlan(store, v6Draft), {
    code: "discovery_budget_not_v7",
  });
  assert.equal(store.get(segId), null);

  // Concept stage draft with contractVersion 7 is also refused
  const conceptDraft = store.write<DiscoveryDraft>({
    id: "draft-concept-v7",
    kind: "discovery-draft",
    expected: 0,
    value: {
      projectId: "proj-legacy",
      createdAt: Date.now(),
      stage: "concept",
      level: "R0",
      consumer: "tester",
      fields: {},
      questions: [],
      inputs: [],
      contractVersion: V7_CONTRACT_ERA,
    },
  });

  assert.throws(() => stageBudgetPlan(store, conceptDraft), {
    code: "discovery_budget_not_v7",
  });
  assert.equal(store.get(segId), null);
});

test("unstored, tampered or forged drafts are refused with discovery_draft_invalid", (t) => {
  const { store, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "proj-tamper", "concept");

  // 1. Unstored revision
  const unstored: Revision<DiscoveryDraft> = {
    id: "draft-unstored",
    kind: "discovery-draft",
    revision: 1,
    hash: hashJson({ test: 1 }),
    value: {
      projectId: "proj-tamper",
      createdAt: Date.now(),
      stage: "discovery",
      level: "R0",
      consumer: "tester",
      fields: {},
      questions: [],
      inputs: [],
      contractVersion: V7_CONTRACT_ERA,
    },
  };
  assert.throws(() => stageBudgetPlan(store, unstored), { code: "discovery_draft_invalid" });

  assert.throws(() => stageBudgetPlan(store, { ...draft, kind: "source" }),
    { code: "discovery_draft_invalid" });

  // 2. Tampered hash on saved draft
  const tamperedHash: Revision<DiscoveryDraft> = {
    ...draft,
    hash: "0000000000000000000000000000000000000000000000000000000000000000",
  };
  assert.throws(() => stageBudgetPlan(store, tamperedHash), { code: "discovery_draft_invalid" });

  // 3. Tampered value not matching hash
  const tamperedVal: Revision<DiscoveryDraft> = {
    ...draft,
    value: { ...draft.value, consumer: "attacker" },
  };
  assert.throws(() => stageBudgetPlan(store, tamperedVal), { code: "discovery_draft_invalid" });

  // 4. Missing projectId
  const badProj: Revision<DiscoveryDraft> = store.write<DiscoveryDraft>({
    id: "draft-bad-proj",
    kind: "discovery-draft",
    expected: 0,
    value: {
      projectId: "   ",
      createdAt: Date.now(),
      stage: "discovery",
      level: "R0",
      consumer: "tester",
      fields: {},
      questions: [],
      inputs: [],
      contractVersion: V7_CONTRACT_ERA,
    },
  });
  assert.throws(() => stageBudgetPlan(store, badProj), { code: "discovery_draft_invalid" });
});

test("damaged or policy-divergent segment throws discovery_budget_policy_invalid without recreation", (t) => {
  const variations: { name: string; segmentValue: Record<string, unknown>; omit?: string }[] = [
    { name: "wrong limit", segmentValue: { limit: 10_000_000 } },
    { name: "wrong initialGroupLimit", segmentValue: { initialGroupLimit: 700_000 } },
    { name: "wrong completionReserve", segmentValue: { completionReserve: 1_000_000 } },
    { name: "missing completionReserve", segmentValue: {}, omit: "completionReserve" },
    { name: "unpermitted ownerGroupCeiling", segmentValue: { ownerGroupCeiling: 10_000_000 } },
    { name: "wrong key", segmentValue: { key: "om-r2" } },
    { name: "wrong projectId", segmentValue: { projectId: "foreign-proj" } },
  ];

  for (const { name, segmentValue, omit } of variations) {
    const { store, discovery } = fixture(t);
    const draft = createPartialV7Draft(discovery, "p-corrupt", "concept");
    const segId = stageBudgetSegmentId("p-corrupt");

    // Write a damaged / divergent segment
    const corruptVal: Record<string, unknown> = {
      projectId: "p-corrupt",
      key: DISCOVERY_V7_STAGE_BUDGET_KEY,
      limit: 20_000_000,
      initialGroupLimit: 20_000_000,
      completionReserve: 2_000_000,
      ...segmentValue,
    };
    if (omit) {
      delete corruptVal[omit];
    }

    store.write({
      id: segId,
      kind: "research-budget",
      expected: 0,
      value: corruptVal as unknown as BudgetSegment,
    });

    const beforeState = store.get(segId)!;

    // Must throw discovery_budget_policy_invalid
    assert.throws(() => stageBudgetPlan(store, draft), {
      code: "discovery_budget_policy_invalid",
    }, `Failed to reject divergent segment for: ${name}`);

    // Verify it is NOT overwritten or recreated: store record is unchanged
    const afterState = store.get(segId)!;
    assert.equal(afterState.revision, beforeState.revision);
    assert.equal(afterState.hash, beforeState.hash);
  }
});

test("segment hash corruption in store triggers discovery_budget_policy_invalid without recreation", (t) => {
  const { store, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p-hash-corrupt", "concept");
  const segId = stageBudgetSegmentId("p-hash-corrupt");

  // Insert valid segment
  ensureStageBudget(store, draft);
  const original = store.get<BudgetSegment>(segId)!;

  // Corrupt the record via direct store tampering
  store.write<BudgetSegment>({
    id: segId,
    kind: "research-budget",
    expected: original.revision,
    value: {
      ...original.value,
      limit: 30_000_000,
    },
  });

  assert.throws(() => stageBudgetPlan(store, draft), {
    code: "discovery_budget_policy_invalid",
  });
});

test("integration with prepareNewSegmentReservation prepares atomic segment + ledger + model-call batch", (t) => {
  const { store, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p-integ", "concept");
  const segId = stageBudgetSegmentId("p-integ");

  // Initial plan indicates new segment
  const plan = stageBudgetPlan(store, draft);
  assert.equal(plan.isNew, true);

  const estimate = {
    kind: "estimated" as const,
    tokens: 100_000,
    basis: [reference(draft)],
    explanation: "discovery initial question",
  };

  // Prepare reservation directly using plan.segment
  const prep = prepareNewSegmentReservation(
    store,
    plan.segment as NewBudgetSegment,
    "first-call",
    ["axis-rules"],
    estimate,
    "research"
  );

  // Writes must contain segment (expected: 0) and ledger (expected: 0)
  assert.equal(prep.writes.length, 2);
  assert.equal(prep.writes[0]!.id, segId);
  assert.equal(prep.writes[0]!.expected, 0);
  assert.equal(prep.writes[1]!.expected, 0);

  // Commit model-call + segment + ledger in one atomic batch
  store.writeMany(
    [
      { id: "first-call", kind: "model-call", expected: 0, value: mockModelCall("first-call", "p-integ") },
      ...prep.writes,
    ],
    prep.guards
  );

  // All 3 items exist at revision 1
  assert.equal(store.get("first-call")!.revision, 1);
  assert.equal(store.get(segId)!.revision, 1);
  assert.equal(store.get(prep.writes[1]!.id)!.revision, 1);

  // Second call to stageBudgetPlan now returns isNew: false
  const plan2 = stageBudgetPlan(store, draft);
  assert.equal(plan2.isNew, false);
  assert.equal(plan2.writes.length, 0);

  // Next reservation uses { saved: plan2.segment }
  const nextReservation = reserveResearchCall(
    store,
    plan2.target,
    "second-call",
    ["axis-rules"],
    estimate,
    "research"
  );
  assert.equal(nextReservation.writes.length, 1); // only ledger write
  assert.equal(nextReservation.writes[0]!.expected, 1);
});

test("concurrency: two Store instances racing on initial stage budget converge to single segment", (t) => {
  const { store, discovery } = fixture(t);
  const other = new Store(store.path);
  t.after(() => other.close());

  const draft = createPartialV7Draft(discovery, "p-race", "concept");
  const otherDraft = other.get<DiscoveryDraft>(draft.id)!;

  // Both stores prepare stageBudgetPlan concurrently
  const planStore = stageBudgetPlan(store, draft);
  const planOther = stageBudgetPlan(other, otherDraft);

  assert.equal(planStore.isNew, true);
  assert.equal(planOther.isNew, true);

  // Before store commits, inject other store committing first
  beforeCommit(store, () => {
    other.writeMany([...planOther.writes], [...planOther.guards]);
  });

  // store's commit must fail with revision_conflict because segment already written
  assert.throws(() => store.writeMany([...planStore.writes], [...planStore.guards]), {
    code: "revision_conflict",
  });

  // Re-evaluating plan on store now converges to the segment created by other
  const converged = stageBudgetPlan(store, draft);
  assert.equal(converged.isNew, false);
  assert.equal(converged.writes.length, 0);
  const convergedSeg = converged.segment as Revision<BudgetSegment>;
  assert.equal(convergedSeg.revision, 1);
  assert.equal(convergedSeg.id, stageBudgetSegmentId("p-race"));
});

test("concurrency: first call loser leaves only the winner's segment, ledger and model-call", (t) => {
  const { store, discovery } = fixture(t);
  const other = new Store(store.path);
  t.after(() => other.close());

  const draft = createPartialV7Draft(discovery, "p-batch-race", "concept");
  const otherDraft = other.get<DiscoveryDraft>(draft.id)!;
  const segId = stageBudgetSegmentId("p-batch-race");

  const planA = stageBudgetPlan(store, draft);
  const planB = stageBudgetPlan(other, otherDraft);

  const estimate = {
    kind: "estimated" as const,
    tokens: 50_000,
    basis: [reference(draft)],
    explanation: "race estimate",
  };

  const prepA = prepareNewSegmentReservation(
    store,
    planA.segment as NewBudgetSegment,
    "call-A",
    ["g"],
    estimate,
    "research"
  );
  const prepB = prepareNewSegmentReservation(
    other,
    planB.segment as NewBudgetSegment,
    "call-B",
    ["g"],
    estimate,
    "research"
  );

  // Before store commits batch A, other commits batch B first
  beforeCommit(store, () => {
    other.writeMany(
      [
        { id: "call-B", kind: "model-call", expected: 0, value: mockModelCall("call-B", "p-batch-race") },
        ...prepB.writes,
      ],
      prepB.guards
    );
  });

  // Batch A commit must fail with revision_conflict on segment expected: 0
  assert.throws(
    () =>
      store.writeMany(
        [
          { id: "call-A", kind: "model-call", expected: 0, value: mockModelCall("call-A", "p-batch-race") },
          ...prepA.writes,
        ],
        prepA.guards
      ),
    { code: "revision_conflict" }
  );

  // Loser writes nothing: call-A does not exist in store!
  assert.equal(store.get("call-A"), null);

  // Winner call-B and its segment exist
  assert.equal(store.get("call-B")!.revision, 1);
  assert.equal(store.get(segId)!.revision, 1);
  const ledger = store.get<{ assignments: { call: string }[] }>(`research-budget-ledger:${hashJson(segId)}`)!;
  assert.equal(ledger.revision, 1);
  assert.deepEqual(ledger.value.assignments.map(item => item.call), ["call-B"]);

  // Store converges cleanly on next attempt
  const nextPlan = stageBudgetPlan(store, draft);
  assert.equal(nextPlan.isNew, false);
});

test("a nested value cannot disguise a non-v7 saved draft as Discovery v7", t => {
  const { store, discovery } = fixture(t);
  const genuine = createPartialV7Draft(discovery, "p-masquerade", "concept");
  for (const [index, body] of [
    { ...genuine.value, stage: "concept", value: genuine.value },
    { ...genuine.value, contractVersion: 6, value: genuine.value },
    { projectId: "p-masquerade", value: genuine.value },
  ].entries()) {
    assert.equal(isDiscoveryV7Draft(body), false);
    const saved = store.write<DiscoveryDraft>({ id: `masquerade:${index}`, kind: "discovery-draft",
      expected: 0, value: body as DiscoveryDraft });
    assert.throws(() => stageBudgetPlan(store, saved), { code: "discovery_budget_not_v7" });
  }
  assert.equal(store.get(stageBudgetSegmentId("p-masquerade")), null);
});

test("invalid initial segment bodies cannot be repaired into an accepted stage budget", t => {
  for (const body of [null, [], { projectId: "foreign" }, { key: "other-stage" },
    { limit: 1 }, { completionReserve: 0 }]) {
    const { store, discovery } = fixture(t);
    const draft = createPartialV7Draft(discovery, "p-origin", "concept");
    const plan = stageBudgetPlan(store, draft);
    const current = plan.writes[0]!;
    const original = store.write({ ...current, value: body === null || Array.isArray(body)
      ? body : { ...(current.value as BudgetSegment), ...body } });
    assert.throws(() => stageBudgetPlan(store, draft), { code: "discovery_budget_policy_invalid" });
    store.write({ ...current, expected: original.revision });
    const history = store.history(current.id);
    assert.throws(() => stageBudgetPlan(store, draft), { code: "discovery_budget_policy_invalid" });
    assert.throws(() => ensureStageBudget(store, draft), { code: "discovery_budget_policy_invalid" });
    assert.deepEqual(store.history(current.id), history);
  }
});

test("a conflict after prepared segment and ledger rolls back both first-call writes", t => {
  const { store, discovery } = fixture(t);
  const other = new Store(store.path);
  t.after(() => other.close());
  const draft = createPartialV7Draft(discovery, "p-rollback", "concept");
  const plan = stageBudgetPlan(store, draft);
  const prep = reserveResearchCall(store, plan.target, "call-conflict", ["discovery-v7"], {
    kind: "estimated", tokens: 10, basis: [reference(draft)], explanation: "first-call rollback"
  });
  beforeCommit(store, () => {
    other.write({ id: "call-conflict", kind: "model-call", expected: 0,
      value: mockModelCall("winner", "p-rollback") });
  });
  assert.throws(() => store.writeMany([...prep.writes,
    { id: "call-conflict", kind: "model-call", expected: 0, value: mockModelCall("loser", "p-rollback") }],
  prep.guards), { code: "revision_conflict" });
  const segId = stageBudgetSegmentId("p-rollback");
  assert.equal(store.get(segId), null);
  assert.equal(store.get(`research-budget-ledger:${hashJson(segId)}`), null);
  assert.equal(store.get<ModelCall>("call-conflict")!.value.requestId, "winner");
  assert.equal(store.history("call-conflict").length, 1);
});


test("v7 frame completion reserve is required and exactly the trusted policy", t => {
  const { discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p-frame-reserve", "concept");
  const frame = {
    axes: Object.fromEntries(V7_AXES.map(axis => [axis, { depth: "deep" }])),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: {}, completionReserve: V7_COMPLETION_RESERVE },
  };
  assert.doesNotThrow(() => checkV7FieldAnswer(draft.value, V7_FRAME_FIELD, frame, () => null));
  for (const reserve of [null, -1, 0, V7_COMPLETION_RESERVE - 1, V7_COMPLETION_RESERVE + 1]) {
    assert.throws(() => checkV7FieldAnswer(draft.value, V7_FRAME_FIELD,
      { ...frame, budget: { ...frame.budget, completionReserve: reserve } }, () => null),
    { code: "answer_invalid" });
  }
  const { completionReserve: _omitted, ...missingReserve } = frame.budget;
  assert.throws(() => checkV7FieldAnswer(draft.value, V7_FRAME_FIELD,
    { ...frame, budget: missingReserve }, () => null), { code: "answer_invalid" });
});

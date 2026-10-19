import test from "node:test";
import assert from "node:assert/strict";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
import { WAKE_INTENT_KIND } from "../src/om/wake-choice.js";
import { g51Pass } from "./om-run-fixture.js";


test("G5.1 rows 3, 5 a choice outside the allowed tests is refused, asked once more showing why, then chosen; twice refused, the wait stands with no third call", async t => {
  await t.test("refused, then chosen", async child => {
    const { trail, results } = await g51Pass(child, (allowed, index) => index === 0 ? "not-a-covering-test" : allowed[0]!);
    assert.deepEqual(results().map(row => row.value.verdict).sort(), ["chosen", "refused"], trail.join(","));
    assert.ok(trail.some(row => row.includes("works")), trail.join(","));
  });
  await t.test("off-form, then chosen", async child => {
    const { trail, results } = await g51Pass(child, (allowed, index) => index === 0 ? { answer: "the exact read test" } : allowed[1]!);
    assert.deepEqual(results().map(row => row.value.verdict).sort(), ["chosen", "off-form"], trail.join(","));
    assert.ok(trail.some(row => row.includes("works")), trail.join(","));
  });
  await t.test("interrupted, then chosen", async child => {
    const { trail, results } = await g51Pass(child, (allowed, index) => index === 0 ? { rawStdout: "{broken", exitCode: 7, stderr: "intentional failure" } : allowed[0]!);
    assert.equal(results().length, 2, trail.join(","));
    assert.ok(["interrupted", "off-form"].includes(results().find(row => row.value.verdict !== "chosen")!.value.verdict), "A technical outcome, never a choice");
    assert.ok(trail.some(row => row.includes("works")), trail.join(","));
  });
  await t.test("refused twice", async child => {
    const { f, trail, state, results } = await g51Pass(child, () => "not-a-covering-test");
    assert.deepEqual(results().map(row => row.value.verdict), ["refused", "refused"], trail.join(","));
    assert.equal(f.store.list(WAKE_INTENT_KIND).length, 2, "No third intent");
    assert.equal(state.phase, "waiting");
    assert.equal(trail.some(row => row.includes("works")), false);
  });
});

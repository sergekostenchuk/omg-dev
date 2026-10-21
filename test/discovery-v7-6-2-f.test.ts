import test from "node:test";
import assert from "node:assert/strict";
import { decodeDossierManifest, projectDossierManifest, readDossierManifestStructural,
  DOSSIER_MANIFEST_CONTRACT, DOSSIER_MANIFEST_KIND } from "../src/discovery/dossier-manifest.js";
import { V7_AXES } from "../src/discovery/v7-contracts.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import type { Ref } from "../src/pipeline/contracts.js";
import type { Revision } from "../src/storage/store.js";

// DR6 6.2-F (codex-omg №9189, №9412): the closed structural form of the dossier
// contradictions — both sides with their stated status, the incompatibility and
// its plan questions, blocking and the resolution with exact grounds. Structural
// only: the snapshots are in-memory inputs of the pure form, the projector and
// the exact structural reader over an in-memory view. No status, ground or link
// is proven here and no accepted attempt claim is faked — that is 6.2-D.

const at = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const claim = (n: number) => ({ project: "p", container: at("research-attempt:a1"),
  containerKind: "research-attempt", pointer: `/claims/${n}`, claimId: `claim-${n}` });
const answer = { project: "p", container: at("research-answer:r1"), containerKind: "research-answer",
  pointer: "/claims/0", claimId: "answer-0" };
const assessment = at("discovery-assessment:p1");
const side = (address: Record<string, unknown>, status: string, by: Ref | null = status === "unassessed" ? null : assessment) =>
  ({ claim: structuredClone(address), status, assessment: by });
/** Axis claims: claim(index) on every investigated axis, the old research answer on market; language inapplicable. */
const axes = () => Object.fromEntries(V7_AXES.map((axis, index) =>
  [axis, axis === "language" ? { depth: "inapplicable", reason: "One-language internal product", claims: [] }
    : { depth: "deep", reason: null, claims: [axis === "market" ? answer : claim(index)] }]));
const decided = () => ({ id: "c-side", relation: "contradicts", sides: [side(claim(0), "accepted"), side(claim(1), "rejected")],
  reason: "One source needs the act monthly, the other per object", planQuestionIds: ["q-forms"], blocking: false,
  resolution: { state: "side", holds: 0, reason: "The regulation text settles it", grounds: [assessment] } });
const refuting = () => ({ id: "c-open", relation: "refutes", sides: [side(claim(2), "unassessed"), side(claim(4), "accepted")],
  reason: "A newer reading refutes the accepted retention rule", planQuestionIds: ["q-retention", "q-forms"], blocking: true,
  resolution: { state: "open" } });
const scoped = () => ({ id: "c-scoped", relation: "contradicts", sides: [side(answer, "accepted", null), side(claim(6), "accepted")],
  reason: "The prices differ", planQuestionIds: ["q-money"], blocking: false,
  resolution: { state: "scoped", dimension: "asOf", reason: "Prices of 2025 and of 2026", grounds: [at("research-answer:r1")] } });
const snapshot = (contradictions: unknown[] = [decided(), refuting(), scoped()]): Record<string, any> => ({
  contract: DOSSIER_MANIFEST_CONTRACT, projectId: "p", draft: at("discovery:p:draft"), frame: at("research-answer:frame"),
  plan: at("research-answer:plan"), completeness: "complete", reasons: [], axes: axes(), unknowns: [], contradictions });
const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};
const field = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return ((error as EngineError).details as { field?: string } | null)?.field ?? "?"; }
  return "no-error";
};
const refused = (cases: [string, (s: Record<string, any>) => void, string][]) => {
  for (const [name, damage, expected] of cases) {
    const value = snapshot(); damage(value);
    assert.equal(code(() => decodeDossierManifest(value)), "discovery_dossier_invalid", name);
    assert.equal(field(() => decodeDossierManifest(value)), expected, `${name} is refused at its field`);
  }
};
const view = (rows: Revision<unknown>[]) => ({ get: <T,>(id: string, revision?: number) =>
  (rows.find(row => row.id === id && (revision === undefined || row.revision === revision)) ?? null) as Revision<T> | null });

test("6.2-F both sides are kept: a side resolution keeps the rejected side with its status, an open refutation keeps the unassessed counter-argument, a scoped difference keeps both accepted sides — on the decoder, the projector and the exact structural reader", () => {
  const value = snapshot();
  const decoded = decodeDossierManifest(value);
  assert.deepEqual(decoded, JSON.parse(canonical(value as Json)));
  assert.deepEqual(decoded.contradictions.map(entry => entry.sides.map(item => item.status)),
    [["accepted", "rejected"], ["unassessed", "accepted"], ["accepted", "accepted"]], "no side disappears or is reclassified");
  const projected = projectDossierManifest(value);
  assert.equal(projected.id, `${DOSSIER_MANIFEST_KIND}:p:${hashJson(value as Json)}`);
  const row = { id: projected.id, kind: DOSSIER_MANIFEST_KIND, revision: 1, hash: hashJson(projected.value as never), value: projected.value };
  const read = readDossierManifestStructural(view([row]), "p", { id: projected.id, revision: 1, hash: row.hash });
  assert.equal(read.verification, "structural", "a structural snapshot, never an accepted dossier");
  assert.deepEqual(read.record.value.contradictions, decoded.contradictions);
  assert.deepEqual(decodeDossierManifest(snapshot([])).contradictions, [], "a snapshot without contradictions lists none");
});

test("6.2-F the contradictions list is part of the closed form: its absence is never an empty list, and an entry keeps exactly its fields", () => {
  refused([
    ["missing contradictions", s => { delete s.contradictions; }, "dossier.contradictions"],
    ["contradictions not a list", s => { s.contradictions = {}; }, "contradictions"],
    ["missing reason", s => { delete s.contradictions[0].reason; }, "contradictions.0.reason"],
    ["blank reason", s => { s.contradictions[0].reason = " "; }, "contradictions.0.reason"],
    ["missing plan questions", s => { delete s.contradictions[0].planQuestionIds; }, "contradictions.0.planQuestionIds"],
    ["no plan question", s => { s.contradictions[0].planQuestionIds = []; }, "contradictions.0.planQuestionIds"],
    ["plan question twice", s => { s.contradictions[1].planQuestionIds = ["q-forms", "q-forms"]; }, "contradictions.1.planQuestionIds"],
    ["blank plan question", s => { s.contradictions[0].planQuestionIds = [""]; }, "contradictions.0.planQuestionIds.0"],
    ["unknown relation", s => { s.contradictions[0].relation = "disagrees"; }, "contradictions.0.relation"],
    ["blocking not boolean", s => { s.contradictions[0].blocking = "no"; }, "contradictions.0.blocking"],
    ["id twice", s => { s.contradictions[1].id = "c-side"; }, "contradictions.1.id"],
    ["an acceptance mark", s => { s.contradictions[0].accepted = true; }, "contradictions.0.accepted"],
    ["a winner outside the resolution", s => { s.contradictions[0].winner = 0; }, "contradictions.0.winner"]]);
});

test("6.2-F sides are two different claims of the snapshot axes by their full address, each with its stated status and assessment", () => {
  refused([
    ["one side", s => { s.contradictions[0].sides = [s.contradictions[0].sides[0]]; }, "contradictions.0.sides"],
    ["three sides", s => { s.contradictions[0].sides.push(side(claim(7), "accepted")); }, "contradictions.0.sides"],
    ["the same claim twice", s => { s.contradictions[0].sides[1] = side(claim(0), "accepted"); }, "contradictions.0.sides"],
    ["a claim outside the axes", s => { s.contradictions[0].sides[1] = side(claim(40), "rejected"); }, "contradictions.0.sides.1.claim"],
    ["another container kind", s => { s.contradictions[2].sides[0].claim.containerKind = "research-attempt"; }, "contradictions.2.sides.0.claim"],
    ["another project", s => { s.contradictions[0].sides[0].claim.project = "q"; }, "contradictions.0.sides.0.claim.project"],
    ["unknown status", s => { s.contradictions[0].sides[1].status = "doubtful"; }, "contradictions.0.sides.1.status"],
    ["an unassessed side names an assessment", s => { s.contradictions[1].sides[0].assessment = assessment; }, "contradictions.1.sides.0.assessment"],
    ["a classified attempt claim without its assessment", s => { s.contradictions[0].sides[1].assessment = null; }, "contradictions.0.sides.1.assessment"],
    ["an assessment not a Ref", s => { s.contradictions[0].sides[0].assessment = "discovery-assessment:p1"; }, "contradictions.0.sides.0.assessment"],
    ["a side without status", s => { delete s.contradictions[0].sides[0].status; }, "contradictions.0.sides.0.status"],
    ["a side with its own sources", s => { s.contradictions[0].sides[0].sources = [at("source:s1")]; }, "contradictions.0.sides.0.sources"]]);
  const answerByRef = snapshot([{ ...scoped(), sides: [side(answer, "accepted"), side(claim(6), "accepted")] }]);
  assert.equal(decodeDossierManifest(answerByRef).contradictions[0]?.sides[0].assessment?.id, assessment.id,
    "an old research answer may also name the chosen assessment");
});

test("6.2-F a pair is one contradiction: contradicts is symmetric, refutes keeps its direction (A.refutedBy = B is sides [B, A])", () => {
  const reversed = { ...decided(), id: "c-side-2", sides: [...decided().sides].reverse(), resolution: { state: "open" } };
  assert.equal(field(() => decodeDossierManifest(snapshot([decided(), reversed]))), "contradictions.1.sides",
    "a contradicts pair in the other order is the same contradiction");
  assert.equal(field(() => decodeDossierManifest(snapshot([refuting(), { ...refuting(), id: "c-open-2" }]))), "contradictions.1.sides",
    "the same refutation twice");
  const back = { ...refuting(), id: "c-back", sides: [side(claim(4), "accepted"), side(claim(2), "unassessed")] };
  const both = decodeDossierManifest(snapshot([refuting(), back]));
  assert.deepEqual(both.contradictions.map(entry => entry.sides.map(item => item.claim.claimId)),
    [["claim-2", "claim-4"], ["claim-4", "claim-2"]], "two directions are two refutations, each in its own order");
  const alongside = { ...refuting(), id: "c-also", relation: "contradicts" };
  assert.equal(decodeDossierManifest(snapshot([refuting(), alongside])).contradictions.length, 2,
    "a refutation and a contradiction of one pair are two relations");
});

test("6.2-F the resolution: open, the accepted standing side with reason and exact grounds, or an explicitly grounded scoped difference that blocks nothing", () => {
  refused([
    ["unknown state", s => { s.contradictions[0].resolution.state = "settled"; }, "contradictions.0.resolution.state"],
    ["not an object", s => { s.contradictions[0].resolution = "open"; }, "contradictions.0.resolution.state"],
    ["open with a winner", s => { s.contradictions[1].resolution.holds = 1; }, "contradictions.1.resolution.holds"],
    ["standing side out of range", s => { s.contradictions[0].resolution.holds = 2; }, "contradictions.0.resolution.holds"],
    ["the rejected side stands", s => { s.contradictions[0].resolution.holds = 1; }, "contradictions.0.resolution.holds"],
    ["the unassessed side stands", s => { s.contradictions[1].resolution = { ...decided().resolution, holds: 0 }; }, "contradictions.1.resolution.holds"],
    ["side without reason", s => { delete s.contradictions[0].resolution.reason; }, "contradictions.0.resolution.reason"],
    ["side without grounds", s => { s.contradictions[0].resolution.grounds = []; }, "contradictions.0.resolution.grounds"],
    ["grounds twice", s => { s.contradictions[0].resolution.grounds = [assessment, assessment]; }, "contradictions.0.resolution.grounds"],
    ["a ground not a Ref", s => { s.contradictions[0].resolution.grounds = ["the regulation"]; }, "contradictions.0.resolution.grounds.0"],
    ["unknown dimension", s => { s.contradictions[2].resolution.dimension = "mood"; }, "contradictions.2.resolution.dimension"],
    ["scoped without grounds", s => { delete s.contradictions[2].resolution.grounds; }, "contradictions.2.resolution.grounds"],
    ["a newer date as a win", s => { s.contradictions[2].resolution.holds = 1; }, "contradictions.2.resolution.holds"],
    ["a scoped difference that blocks", s => { s.contradictions[2].blocking = true; }, "contradictions.2.blocking"]]);
});

test("6.2-F reference sites: the snapshot declares the claim container and the assessment of every side and the grounds of every resolution; reasons and plan question ids are data", () => {
  const value = snapshot();
  const sites = referenceSites(DOSSIER_MANIFEST_KIND, value).map(site => site.field).filter(name => name.startsWith("contradictions")).sort();
  assert.deepEqual(sites, [
    "contradictions[0].resolution.grounds[0]", "contradictions[0].sides[0].assessment", "contradictions[0].sides[0].claim.container",
    "contradictions[0].sides[1].assessment", "contradictions[0].sides[1].claim.container",
    "contradictions[1].sides[0].claim.container", "contradictions[1].sides[1].assessment", "contradictions[1].sides[1].claim.container",
    "contradictions[2].resolution.grounds[0]", "contradictions[2].sides[0].claim.container",
    "contradictions[2].sides[1].assessment", "contradictions[2].sides[1].claim.container"].sort());
});

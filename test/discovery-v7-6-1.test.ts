import test from "node:test";
import assert from "node:assert/strict";
import { decodeDossierManifest, dossierManifestId, projectDossierManifest, readDossierManifestStructural,
  DOSSIER_MANIFEST_CONTRACT, DOSSIER_MANIFEST_KIND } from "../src/discovery/dossier-manifest.js";
import { V7_AXES } from "../src/discovery/v7-contracts.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import type { Ref } from "../src/pipeline/contracts.js";
import type { Revision } from "../src/storage/store.js";

// DR6 6.1 (codex-omg №9189, раздел DR6): the closed structural form of the exact
// dossier snapshot. Structural only — the snapshots are in-memory inputs of the
// pure form checks and of the exact structural reader over an in-memory view;
// no record is written as if a producer had made it, and nothing is accepted.

const at = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const claim = (n: number, container = at("research-attempt:a1")) => ({ project: "p", container,
  containerKind: "research-attempt", pointer: `/claims/${n}`, claimId: `claim-${n}` });
const axesWith = (claimsOf: (axis: string, index: number) => unknown[]) => Object.fromEntries(V7_AXES.map((axis, index) =>
  [axis, axis === "language" ? { depth: "inapplicable", reason: "One-language internal product", claims: [] }
    : { depth: index % 2 ? "brief" : "deep", reason: null, claims: claimsOf(axis, index) }]));
const complete = (): Record<string, any> => ({ contract: DOSSIER_MANIFEST_CONTRACT, projectId: "p",
  draft: at("discovery:p:draft"), frame: at("research-answer:frame"), plan: at("research-answer:plan"),
  completeness: "complete", reasons: [], axes: axesWith((_axis, index) => [claim(index)]),
  unknowns: [{ claim: claim(2), unknownId: "u-1", consumer: "operation-map", moment: "om-pass", blocksCurrentStage: false }],
  contradictions: [] });
const partial = (): Record<string, any> => ({ ...complete(), completeness: "partial",
  reasons: [{ code: "reject_all", message: "The owner rejected every variant", grounds: [at("discovery-variant-owner-decision:d1")] }],
  axes: axesWith((_axis, index) => index < 3 ? [claim(index)] : []), unknowns: [] });
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
/** A read-only view over in-memory revisions — no Store, no write. */
const view = (rows: Revision<unknown>[]) => ({ get: <T,>(id: string, revision?: number) =>
  (rows.find(row => row.id === id && (revision === undefined || row.revision === revision)) ?? null) as Revision<T> | null });
const row = (id: string, value: unknown, revision = 1, kind: string = DOSSIER_MANIFEST_KIND): Revision<unknown> =>
  ({ id, kind, revision, hash: hashJson(value as Json), value });

test("6.1 a complete and a partial snapshot have the closed form: 12 axes (inapplicable with its reason), addressed unknowns of the axis claims, partial reasons with exact grounds; the canonical address is content-addressed", () => {
  for (const snapshot of [complete(), partial()]) {
    assert.deepEqual(decodeDossierManifest(snapshot), JSON.parse(canonical(snapshot as Json)), snapshot.completeness);
    const projected = projectDossierManifest(snapshot);
    assert.equal(projected.id, `${DOSSIER_MANIFEST_KIND}:p:${hashJson(snapshot as Json)}`);
    assert.equal(projected.id, dossierManifestId(snapshot as { projectId: string }));
  }
  assert.equal(decodeDossierManifest(complete()).axes.language.reason, "One-language internal product");
});

test("6.1 the axes are closed: a missing or extra axis, an inapplicable axis without reason or with claims, an investigated axis with a reason, an empty investigated axis of a complete snapshot and a claim named twice are refused at their field", () => {
  const cases: [string, (snapshot: Record<string, any>) => void, string][] = [
    ["missing axis", s => { delete s.axes.market; }, "axes.market"],
    ["extra axis", s => { s.axes.weather = { depth: "deep", reason: null, claims: [] }; }, "axes.weather"],
    ["inapplicable without reason", s => { s.axes.language.reason = null; }, "axes.language.reason"],
    ["inapplicable with claims", s => { s.axes.language.claims = [claim(40)]; }, "axes.language.claims"],
    ["investigated with a reason", s => { s.axes.industry.reason = "Looks fine"; }, "axes.industry.reason"],
    ["empty investigated axis", s => { s.axes.industry.claims = []; }, "axes.industry.claims"],
    ["unknown depth", s => { s.axes.industry.depth = "medium"; }, "axes.industry.depth"],
    ["claim named twice", s => { s.axes.market.claims = [...s.axes.market.claims, claim(0)]; }, `axes.market.claims.1`],
    ["claim of another project", s => { s.axes.industry.claims = [{ ...claim(0), project: "other" }]; }, "axes.industry.claims.0.project"],
    ["pointer outside claims", s => { s.axes.industry.claims = [{ ...claim(0), pointer: "/value/claims/0" }]; }, "axes.industry.claims.0.pointer"],
    ["pointer index beyond a safe integer", s => { s.axes.industry.claims = [{ ...claim(0), pointer: "/claims/99999999999999999999" }]; }, "axes.industry.claims.0.pointer"],
    ["unknown container kind", s => { s.axes.industry.claims = [{ ...claim(0), containerKind: "research-checkpoint" }]; }, "axes.industry.claims.0.containerKind"],
    ["container not a Ref", s => { s.axes.industry.claims = [{ ...claim(0), container: "research-attempt:a1" }]; }, "axes.industry.claims.0.container"],
    ["missing claim id", s => { const { claimId: _id, ...rest } = claim(0); s.axes.industry.claims = [rest]; }, "axes.industry.claims.0.claimId"]];
  for (const [name, damage, expected] of cases) {
    const snapshot = complete(); damage(snapshot);
    assert.equal(code(() => decodeDossierManifest(snapshot)), "discovery_dossier_invalid", name);
    assert.equal(field(() => decodeDossierManifest(snapshot)), expected, `${name} is refused at its field`);
  }
});

test("6.1 unknowns are addressed and reasons are closed: an unknown outside the axes, twice, without consumer, with an unknown moment or flag; reasons on a complete snapshot, none on a partial, an unknown or repeated code or no grounds are refused", () => {
  const unknown = complete().unknowns[0];
  const cases: [string, () => Record<string, any>, string][] = [
    ["unknown outside the axes", () => ({ ...complete(), unknowns: [{ ...unknown, claim: claim(99) }] }), "unknowns.0.claim"],
    ["unknown listed twice", () => ({ ...complete(), unknowns: [unknown, { ...unknown, unknownId: "u-2" }] }), "unknowns.1.claim"],
    ["unknown id twice", () => ({ ...complete(), unknowns: [unknown, { ...unknown, claim: claim(4) }] }), "unknowns.1.unknownId"],
    ["unknown without consumer", () => ({ ...complete(), unknowns: [{ ...unknown, consumer: "" }] }), "unknowns.0.consumer"],
    ["unknown moment", () => ({ ...complete(), unknowns: [{ ...unknown, moment: "someday" }] }), "unknowns.0.moment"],
    ["blocking flag not boolean", () => ({ ...complete(), unknowns: [{ ...unknown, blocksCurrentStage: "no" }] }), "unknowns.0.blocksCurrentStage"],
    ["reasons on a complete snapshot", () => ({ ...complete(), reasons: partial().reasons }), "reasons"],
    ["partial without reasons", () => ({ ...partial(), reasons: [] }), "reasons"],
    ["unknown reason code", () => ({ ...partial(), reasons: [{ ...partial().reasons[0], code: "tired" }] }), "reasons.0.code"],
    ["reason named twice", () => ({ ...partial(), reasons: [partial().reasons[0], partial().reasons[0]] }), "reasons.1.code"],
    ["reason without grounds", () => ({ ...partial(), reasons: [{ ...partial().reasons[0], grounds: [] }] }), "reasons.0.grounds"],
    ["unknown completeness", () => ({ ...complete(), completeness: "mostly" }), "completeness"]];
  for (const [name, make, expected] of cases) {
    assert.equal(code(() => decodeDossierManifest(make())), "discovery_dossier_invalid", name);
    assert.equal(field(() => decodeDossierManifest(make())), expected, `${name} is refused at its field`);
  }
});

test("6.1 a structural snapshot is never accepted and an unknown version is never read as this one: acceptance or assessment fields, a missing field, another contract and a non-object are refused", () => {
  const cases: [string, unknown, string][] = [
    ["accepted mark", { ...complete(), accepted: true }, "dossier.accepted"],
    ["assessment", { ...complete(), assessment: at("discovery-assessment:x") }, "dossier.assessment"],
    ["status", { ...complete(), status: "accepted" }, "dossier.status"],
    ["missing unknowns", (({ unknowns: _unknowns, ...rest }) => rest)(complete()), "dossier.unknowns"],
    ["older contract", { ...complete(), contract: "discovery-dossier-manifest/v0" }, "contract"],
    ["newer contract", { ...complete(), contract: "discovery-dossier-manifest/v2" }, "contract"],
    ["no contract", (({ contract: _contract, ...rest }) => rest)(complete()), "contract"],
    ["draft not a Ref", { ...complete(), draft: "the draft" }, "draft"],
    ["null", null, "contract"], ["array", [], "contract"]];
  for (const [name, value, expected] of cases) {
    assert.equal(code(() => decodeDossierManifest(value)), "discovery_dossier_invalid", name);
    assert.equal(field(() => decodeDossierManifest(value)), expected, `${name} is refused at its field`);
  }
});

test("6.1 the exact structural reader proves only immutable bytes and form: the snapshot at its canonical address and first revision reads structural; another kind, revision, project, address or hash is refused", () => {
  const projected = projectDossierManifest(complete());
  const ref = (value: unknown, id = projected.id, revision = 1): Ref => ({ id, revision, hash: hashJson(value as Json) });
  const good = row(projected.id, projected.value);
  const read = readDossierManifestStructural(view([good]), "p", ref(projected.value));
  assert.equal(read.verification, "structural", "a structural snapshot, never an accepted dossier");
  assert.deepEqual(read.record.value, projected.value);
  const other = projectDossierManifest({ ...complete(), projectId: "q",
    axes: axesWith((_axis, index) => [{ ...claim(index), project: "q" }]),
    unknowns: [{ ...complete().unknowns[0], claim: { ...claim(2), project: "q" } }] });
  const cases: [string, Revision<unknown>[], Ref, string][] = [
    ["another kind", [row(projected.id, projected.value, 1, "discovery-variant-snapshot")], ref(projected.value), "p"],
    ["a later revision", [row(projected.id, projected.value, 2)], ref(projected.value, projected.id, 2), "p"],
    ["another project", [row(other.id, other.value)], ref(other.value, other.id), "p"],
    ["a noncanonical address", [row("discovery-dossier-manifest:p:elsewhere", projected.value)],
      ref(projected.value, "discovery-dossier-manifest:p:elsewhere"), "p"],
    ["a hash mismatch", [good], { id: projected.id, revision: 1, hash: "0".repeat(64) }, "p"],
    ["a missing record", [], ref(projected.value), "p"],
    ["a record without its value", [(({ value: _value, ...rest }) => rest as Revision<unknown>)(good)], ref(projected.value), "p"]];
  for (const [name, rows, target, project] of cases)
    assert.equal(code(() => readDossierManifestStructural(view(rows), project, target)), "discovery_dossier_invalid", name);
});

test("6.1 reference sites: the snapshot declares exactly its references — draft, frame, plan, reason grounds and the claim containers of the axes and unknowns — and its texts are data", () => {
  const snapshot = partial();
  const sites = referenceSites(DOSSIER_MANIFEST_KIND, snapshot).map(site => site.field).sort();
  const expected = ["draft", "frame", "plan", "reasons[0].grounds[0]",
    ...V7_AXES.flatMap(axis => (snapshot.axes[axis].claims as unknown[]).map((_c, i) => `axes.${axis}.claims[${i}].container`)),
    ...(snapshot.unknowns as unknown[]).map((_u, i) => `unknowns[${i}].claim.container`)].sort();
  assert.deepEqual(sites, expected);
  const withUnknown = complete();
  assert.ok(referenceSites(DOSSIER_MANIFEST_KIND, withUnknown).some(site => site.field === "unknowns[0].claim.container"));
});

test("6.1-01 an unknown names its axis claim by the full address: the same container, pointer and id under the other container kind is not that claim — on the decoder, the projector and the exact structural reader; both lawful kinds pass", () => {
  const snapshot = (kind: string): Record<string, any> => {
    const address = { ...claim(0), containerKind: kind };
    return { ...complete(), axes: axesWith((axis, index) => [axis === "market" ? address : claim(index + 100)]),
      unknowns: [{ claim: structuredClone(address), unknownId: "u-0", consumer: "operation-map", moment: "om-pass", blocksCurrentStage: false }] };
  };
  const structural = (value: Record<string, any>) => {
    const id = `${DOSSIER_MANIFEST_KIND}:p:${hashJson(value as Json)}`;
    return readDossierManifestStructural(view([row(id, value)]), "p", { id, revision: 1, hash: hashJson(value as Json) });
  };
  const readers: [string, (value: Record<string, any>) => unknown][] = [
    ["decoder", decodeDossierManifest], ["projector", projectDossierManifest], ["structural reader", structural]];
  for (const kind of ["research-answer", "research-attempt"]) {
    const lawful = snapshot(kind);
    assert.deepEqual(decodeDossierManifest(lawful), JSON.parse(canonical(lawful as Json)), `${kind} passes the decoder`);
    assert.deepEqual(projectDossierManifest(lawful).value, JSON.parse(canonical(lawful as Json)), `${kind} passes the projector`);
    assert.equal(structural(lawful).verification, "structural", `${kind} passes the structural reader`);
    for (const [name, read] of readers) {
      const swapped = snapshot(kind);
      swapped.unknowns[0].claim.containerKind = kind === "research-answer" ? "research-attempt" : "research-answer";
      assert.equal(code(() => read(swapped)), "discovery_dossier_invalid", `${name}: ${kind} swapped`);
      assert.equal(field(() => read(swapped)), "unknowns.0.claim", `${name}: ${kind} swapped is refused at the unknown claim`);
    }
  }
});

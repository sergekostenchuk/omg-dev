import test from "node:test";
import assert from "node:assert/strict";
import { decodeDiscoveryManifest, discoveryManifestId, projectDiscoveryManifest, readDiscoveryManifestStructural,
  DISCOVERY_MANIFEST_CONTRACT, DISCOVERY_MANIFEST_KIND } from "../src/discovery/discovery-manifest.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import type { Ref } from "../src/pipeline/contracts.js";
import type { Revision } from "../src/storage/store.js";

// DR7 7b.2-F (codex-omg №9189, №9660): the closed structural form of one manifest of
// the final Discovery bundle. Every positive manifest below is an unsaved structural
// input of the pure form, the projector and the exact structural reader over an
// in-memory view — no paid assessment, owner act or machine admission is written or
// faked; their origin, authority and the atomic acceptance are the main 7b.2.

const at = (id: string, revision = 1): Ref => ({ id, revision, hash: hashJson(`${id}@${revision}`) });
const initial = (kind = "owner"): Record<string, any> => ({ contract: DISCOVERY_MANIFEST_CONTRACT, projectId: "p",
  draft: at("discovery:p:draft", 9), bundle: at("research-answer:p:final", 1), assessment: at("research-assessment:p:final"),
  admission: { kind, record: kind === "owner" ? at("discovery-acceptance-act:p:a1") : at("discovery-machine-admission:p:m1") },
  previous: null, resolutions: [] });
const successor = (): Record<string, any> => ({ ...initial(), bundle: at("research-answer:p:final", 2),
  assessment: at("research-assessment:p:final-2"), previous: { id: discoveryManifestId(initial() as { projectId: string }), revision: 1, hash: hashJson(initial() as Json) },
  resolutions: [at("discovery-condition-resolution:p:c1"), at("discovery-condition-resolution:p:c2")] });
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
const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
const refused = (make: () => Record<string, any>, cases: [string, (m: Record<string, any>) => void, string][]) => {
  for (const [name, damage, expected] of cases) {
    const value = make(); damage(value);
    assert.equal(code(() => decodeDiscoveryManifest(value)), "discovery_manifest_invalid", name);
    assert.equal(field(() => decodeDiscoveryManifest(value)), expected, `${name} is refused at its field`);
  }
};
const view = (rows: Revision<unknown>[]) => ({ get: <T,>(id: string, revision?: number) =>
  (rows.find(row => row.id === id && (revision === undefined || row.revision === revision)) ?? null) as Revision<T> | null });
const row = (id: string, value: unknown, revision = 1, kind: string = DISCOVERY_MANIFEST_KIND): Revision<unknown> =>
  ({ id, kind, revision, hash: hashJson(value as Json), value });

test("7b.2-F both admission forms, an initial manifest and a structural successor keep their full composition; the address is content-addressed at revision 1, independent of the JSON key order, and a frozen input is never mutated", () => {
  for (const value of [initial("owner"), initial("machine"), successor()]) {
    const frozen = deepFreeze(structuredClone(value));
    const decoded = decodeDiscoveryManifest(frozen);
    assert.deepEqual(decoded, JSON.parse(canonical(value as Json)), "the full composition is kept");
    const projected = projectDiscoveryManifest(frozen);
    assert.deepEqual([projected.id, projected.revision], [`${DISCOVERY_MANIFEST_KIND}:p:${hashJson(value as Json)}`, 1]);
    assert.equal(projectDiscoveryManifest(reorder(value)).id, projected.id, "the JSON key order does not change the address");
    assert.notEqual(projected.value.admission, frozen.admission, "the projected manifest is a copy");
  }
  assert.deepEqual(decodeDiscoveryManifest(initial()).resolutions, [], "an initial manifest resolves nothing");
  assert.equal(decodeDiscoveryManifest(successor()).resolutions.length, 2);
});

test("7b.2-F every exact ground changes the manifest address", () => {
  const changes: [string, (m: Record<string, any>) => void][] = [
    ["project", m => { m.projectId = "q"; }],
    ["draft revision", m => { m.draft = at("discovery:p:draft", 10); }],
    ["draft hash", m => { m.draft = { ...m.draft, hash: "0".repeat(64) }; }],
    ["bundle id", m => { m.bundle = at("research-answer:p:final-other", 1); }],
    ["bundle revision", m => { m.bundle = at("research-answer:p:final", 3); }],
    ["bundle hash", m => { m.bundle = { ...m.bundle, hash: "f".repeat(64) }; }],
    ["assessment id", m => { m.assessment = at("research-assessment:p:other"); }],
    ["assessment hash", m => { m.assessment = { ...m.assessment, hash: "e".repeat(64) }; }],
    ["admission kind", m => { m.admission = { ...m.admission, kind: "machine" }; }],
    ["admission record", m => { m.admission = { ...m.admission, record: at("discovery-acceptance-act:p:a2") }; }],
    ["admission record revision", m => { m.admission = { ...m.admission, record: { ...m.admission.record, revision: 2 } }; }],
    ["previous", m => { m.previous = at(`${DISCOVERY_MANIFEST_KIND}:p:older`); }],
    ["a resolution", m => { m.resolutions = [at("discovery-condition-resolution:p:c9")]; }]];
  const ids = new Map<string, string>([[discoveryManifestId(initial() as { projectId: string }), "initial"]]);
  for (const [name, change] of changes) {
    const value = initial(); change(value);
    const next = discoveryManifestId(decodeDiscoveryManifest(value));
    assert.equal(ids.has(next), false, `${name} gets its own address, not the one of ${ids.get(next)}`);
    ids.set(next, name);
  }
});

test("7b.2-F every required part is present and exact; an admission is a closed owner or machine record, never a boolean, a bypass string or an author claim", () => {
  refused(initial, [
    ["no project", m => { delete m.projectId; }, "manifest.projectId"],
    ["a blank project", m => { m.projectId = " "; }, "projectId"],
    ["no draft", m => { delete m.draft; }, "manifest.draft"],
    ["no bundle", m => { delete m.bundle; }, "manifest.bundle"],
    ["no assessment", m => { delete m.assessment; }, "manifest.assessment"],
    ["no admission", m => { delete m.admission; }, "manifest.admission"],
    ["no previous", m => { delete m.previous; }, "manifest.previous"],
    ["no resolutions", m => { delete m.resolutions; }, "manifest.resolutions"],
    ["a draft as a bare id", m => { m.draft = "discovery:p:draft"; }, "draft"],
    ["a bundle without hash", m => { delete m.bundle.hash; }, "bundle.hash"],
    ["a bundle with revision zero", m => { m.bundle.revision = 0; }, "bundle"],
    ["an assessment with a short hash", m => { m.assessment.hash = "abc"; }, "assessment"],
    ["a draft with an extra field", m => { m.draft.head = true; }, "draft.head"],
    ["an admission as a boolean", m => { m.admission = true; }, "admission.kind"],
    ["a bypass string", m => { m.admission = "bypass"; }, "admission.kind"],
    ["an unknown admission branch", m => { m.admission.kind = "bypass"; }, "admission.kind"],
    ["an admission without kind", m => { delete m.admission.kind; }, "admission.kind"],
    ["an admission without record", m => { delete m.admission.record; }, "admission.record"],
    ["an admission record as text", m => { m.admission.record = "discovery-acceptance-act:p:a1"; }, "admission.record"],
    ["an admission with its mode", m => { m.admission.mode = "owner"; }, "admission.mode"],
    ["an admission with its author", m => { m.admission.author = "owner"; }, "admission.author"],
    ["an admission with its scope", m => { m.admission.scope = at("owner-scope:p:s1"); }, "admission.scope"]]);
});

test("7b.2-F previous and resolutions are exact addresses of grounds: null or a manifest of this project, unique exact records; accepted, supported, ready, an outcome and invented positive parts are no part of the form; another version is refused", () => {
  refused(successor, [
    ["previous as a bare id", m => { m.previous = m.previous.id; }, "previous"],
    ["previous without hash", m => { delete m.previous.hash; }, "previous.hash"],
    ["previous of another kind", m => { m.previous = at("discovery-dossier-manifest:p:x"); }, "previous"],
    ["previous of another project", m => { m.previous = at(`${DISCOVERY_MANIFEST_KIND}:q:older`); }, "previous"],
    ["resolutions not a list", m => { m.resolutions = at("discovery-condition-resolution:p:c1"); }, "resolutions"],
    ["a resolution twice", m => { m.resolutions = [m.resolutions[0], m.resolutions[0]]; }, "resolutions"],
    ["a resolution as a bare id", m => { m.resolutions[1] = "discovery-condition-resolution:p:c2"; }, "resolutions.1"],
    ["a resolution as a fulfilled flag", m => { m.resolutions[0] = { condition: "c1", fulfilled: true }; }, "resolutions.0.id"],
    ["an accepted mark", m => { m.accepted = true; }, "manifest.accepted"],
    ["a supported mark", m => { m.supported = true; }, "manifest.supported"],
    ["a ready mark", m => { m.ready = true; }, "manifest.ready"],
    ["an own outcome", m => { m.outcome = "go"; }, "manifest.outcome"],
    ["an accepted summary", m => { m.summary = at("research-answer:p:summary"); }, "manifest.summary"],
    ["an accepted projection", m => { m.projection = { users: ["a"] }; }, "manifest.projection"],
    ["an accepted constitution", m => { m.constitution = at("research-answer:p:constitution"); }, "manifest.constitution"],
    ["an owner approval flag", m => { m.ownerApproved = true; }, "manifest.ownerApproved"],
    ["a bypass flag", m => { m.bypass = "machine"; }, "manifest.bypass"]]);
  const versions: [string, unknown][] = [
    ["v6", { ...initial(), contract: "discovery-manifest/v6" }], ["v8", { ...initial(), contract: "discovery-manifest/v8" }],
    ["no contract", (({ contract: _c, ...rest }) => rest)(initial())], ["null", null], ["array", []], ["text", "manifest"]];
  for (const [name, value] of versions) {
    assert.equal(code(() => decodeDiscoveryManifest(value)), "discovery_manifest_invalid", name);
    assert.equal(field(() => decodeDiscoveryManifest(value)), "contract", `${name} is refused at the contract`);
  }
});

test("7b.2-F the exact structural reader reads only its own record and refuses a lost or substituted one; reference sites list exactly the grounds", () => {
  const projected = projectDiscoveryManifest(successor());
  const good = row(projected.id, projected.value);
  const ref = (id = projected.id, revision = 1, hash = good.hash): Ref => ({ id, revision, hash });
  const read = readDiscoveryManifestStructural(view([good]), "p", ref());
  assert.equal(read.verification, "structural", "a structural manifest, never an accepted Discovery");
  assert.deepEqual(read.record.value, projected.value);
  const other = projectDiscoveryManifest(initial("machine"));
  const cases: [string, Revision<unknown>[], Ref, string][] = [
    ["a lost record", [], ref(), "p"],
    ["another kind", [row(projected.id, projected.value, 1, "discovery-dossier-manifest")], ref(), "p"],
    ["a later revision", [row(projected.id, projected.value, 2)], ref(projected.id, 2), "p"],
    ["another project", [good], ref(), "q"],
    ["a noncanonical address", [row(`${DISCOVERY_MANIFEST_KIND}:p:elsewhere`, projected.value)], ref(`${DISCOVERY_MANIFEST_KIND}:p:elsewhere`), "p"],
    ["a substituted record", [row(projected.id, other.value)], ref(), "p"],
    ["a hash mismatch", [good], ref(projected.id, 1, "0".repeat(64)), "p"],
    ["a record without its value", [(({ value: _value, ...rest }) => rest as Revision<unknown>)(good)], ref(), "p"]];
  for (const [name, rows, target, project] of cases)
    assert.equal(code(() => readDiscoveryManifestStructural(view(rows), project, target)), "discovery_manifest_invalid", name);
  assert.deepEqual(referenceSites(DISCOVERY_MANIFEST_KIND, successor()).map(site => site.field).sort(),
    ["admission.record", "assessment", "bundle", "draft", "previous", "resolutions[0]", "resolutions[1]"]);
  assert.deepEqual(referenceSites(DISCOVERY_MANIFEST_KIND, initial()).map(site => site.field).sort(),
    ["admission.record", "assessment", "bundle", "draft"], "an initial manifest names no previous and no resolution");
});

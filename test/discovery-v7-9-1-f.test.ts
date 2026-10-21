import test from "node:test";
import assert from "node:assert/strict";
import { decodeKeeperCheckKey, keeperCheckKey, KEEPER_CHECK_KEY_CONTRACT, KEEPER_CHECK_KEY_KIND } from "../src/product/keeper.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import type { Ref } from "../src/pipeline/contracts.js";

// DR9 9.1-F (codex-omg №9189, №9463): the closed form and the pure key of a keeper
// check — exact artifact × exact constitution × declared check version. The
// addresses below are only inputs of the pure form: no record is written and no
// artifact or constitution is presented as accepted — that is 9.2/9.3.

const at = (id: string, revision = 1): Ref => ({ id, revision, hash: hashJson(`${id}@${revision}`) });
const key = (): Record<string, any> => ({ contract: KEEPER_CHECK_KEY_CONTRACT, projectId: "p",
  artifact: { container: at("stage:p:features"), pointer: "" },
  constitution: { container: at("discovery:p:draft", 7), pointer: "/fields/final/constitution" },
  checkVersion: "keeper-check/1" });
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

test("9.1-F one key for the same content whatever the JSON key order; the input is never mutated; the whole record is the empty pointer", () => {
  const original = key(), frozen = deepFreeze(key());
  const expected = `${KEEPER_CHECK_KEY_KIND}:p:${hashJson(original as Json)}`;
  assert.equal(keeperCheckKey(original), expected);
  assert.equal(keeperCheckKey(reorder(original)), expected, "the JSON key order does not change the key");
  assert.equal(keeperCheckKey(frozen), expected, "a deep-frozen input is read, not changed");
  assert.deepEqual(original, key(), "the input is not mutated");
  const decoded = decodeKeeperCheckKey(original);
  assert.deepEqual(decoded, JSON.parse(canonical(original as Json)));
  assert.notEqual(decoded, original, "the decoded form is a copy");
  assert.notEqual(decoded.artifact, original.artifact, "the decoded addresses are copies");
  assert.equal(decoded.artifact.pointer, "", "the empty pointer is the whole artifact record");
  assert.equal(keeperCheckKey({ ...key(), artifact: { container: at("stage:p:features"), pointer: "/a~1b/~0c/0" } }).startsWith(`${KEEPER_CHECK_KEY_KIND}:p:`), true,
    "escaped pointer segments are canonical");
});

test("9.1-F another exact revision, hash, container or pointer of either address, another project or another declared check version never gets the previous key", () => {
  const variants: [string, (k: Record<string, any>) => void][] = [
    ["artifact container id", k => { k.artifact.container = at("stage:p:features-2"); }],
    ["artifact revision", k => { k.artifact.container = { ...k.artifact.container, revision: 2 }; }],
    ["artifact hash", k => { k.artifact.container = { ...k.artifact.container, hash: "0".repeat(64) }; }],
    ["artifact pointer", k => { k.artifact.pointer = "/value"; }],
    ["constitution container id", k => { k.constitution.container = at("discovery:p:draft-2", 7); }],
    ["constitution revision", k => { k.constitution.container = { ...k.constitution.container, revision: 8 }; }],
    ["constitution hash", k => { k.constitution.container = { ...k.constitution.container, hash: "f".repeat(64) }; }],
    ["constitution pointer", k => { k.constitution.pointer = "/fields/final"; }],
    ["project", k => { k.projectId = "q"; }],
    ["check version", k => { k.checkVersion = "keeper-check/2"; }],
    ["artifact and constitution swapped", k => { [k.artifact, k.constitution] = [k.constitution, k.artifact]; }]];
  const keys = new Map<string, string>([[keeperCheckKey(key()), "original"]]);
  for (const [name, change] of variants) {
    const value = key(); change(value);
    const next = keeperCheckKey(value);
    assert.equal(keys.has(next), false, `${name} gets its own key, not the key of ${keys.get(next)}`);
    keys.set(next, name);
  }
});

test("9.1-F the form is closed: an absent field, an extra field, an unknown version and a non-object are refused at their field", () => {
  const cases: [string, unknown, string][] = [
    ["missing project", (({ projectId: _p, ...rest }) => rest)(key()), "key.projectId"],
    ["missing artifact", (({ artifact: _a, ...rest }) => rest)(key()), "key.artifact"],
    ["missing constitution", (({ constitution: _c, ...rest }) => rest)(key()), "key.constitution"],
    ["missing check version", (({ checkVersion: _v, ...rest }) => rest)(key()), "key.checkVersion"],
    ["an accepted mark", { ...key(), accepted: true }, "key.accepted"],
    ["a supported mark", { ...key(), supported: true }, "key.supported"],
    ["a paid mark", { ...key(), paid: true }, "key.paid"],
    ["a reuse permission", { ...key(), reuse: at("keeper-verdict:old") }, "key.reuse"],
    ["older contract", { ...key(), contract: "keeper-check-key/v0" }, "contract"],
    ["newer contract", { ...key(), contract: "keeper-check-key/v2" }, "contract"],
    ["no contract", (({ contract: _c, ...rest }) => rest)(key()), "contract"],
    ["null", null, "contract"], ["array", [], "contract"],
    ["blank project", { ...key(), projectId: " " }, "projectId"]];
  for (const [name, value, expected] of cases) {
    assert.equal(code(() => keeperCheckKey(value)), "keeper_key_invalid", name);
    assert.equal(field(() => decodeKeeperCheckKey(value)), expected, `${name} is refused at its field`);
  }
});

test("9.1-F an address is the exact Ref of its container and a canonical JSON Pointer; a check version is declared explicitly — damaged or moving forms are refused at their field", () => {
  const cases: [string, (k: Record<string, any>) => void, string][] = [
    ["address not an object", k => { k.artifact = "stage:p:features"; }, "artifact"],
    ["address without pointer", k => { delete k.artifact.pointer; }, "artifact.pointer"],
    ["address with an extra field", k => { k.constitution.text = "Goal and non-goals"; }, "constitution.text"],
    ["container as a bare id", k => { k.artifact.container = "stage:p:features"; }, "artifact.container"],
    ["container without hash", k => { delete k.artifact.container.hash; }, "artifact.container.hash"],
    ["container with an extra field", k => { k.artifact.container.head = true; }, "artifact.container.head"],
    ["revision zero", k => { k.constitution.container.revision = 0; }, "constitution.container"],
    ["revision as text", k => { k.constitution.container.revision = "7"; }, "constitution.container"],
    ["short hash", k => { k.constitution.container.hash = "abc"; }, "constitution.container"],
    ["empty container id", k => { k.artifact.container.id = ""; }, "artifact.container"],
    ["constitution as a hash of its text", k => { k.constitution = { container: { id: "", revision: 1, hash: hashJson("goal") }, pointer: "" }; }, "constitution.container"],
    ["pointer not text", k => { k.artifact.pointer = 0; }, "artifact.pointer"],
    ["pointer without a leading slash", k => { k.artifact.pointer = "value"; }, "artifact.pointer"],
    ["pointer with a bad escape", k => { k.constitution.pointer = "/fields/~2final"; }, "constitution.pointer"],
    ["pointer with a dangling escape", k => { k.constitution.pointer = "/fields/final~"; }, "constitution.pointer"],
    ["check version not text", k => { k.checkVersion = 1; }, "checkVersion"],
    ["empty check version", k => { k.checkVersion = ""; }, "checkVersion"],
    ["latest", k => { k.checkVersion = "latest"; }, "checkVersion"],
    ["Current", k => { k.checkVersion = "Current"; }, "checkVersion"],
    ["default with spaces", k => { k.checkVersion = " default "; }, "checkVersion"]];
  for (const [name, damage, expected] of cases) {
    const value = key(); damage(value);
    assert.equal(code(() => keeperCheckKey(value)), "keeper_key_invalid", name);
    assert.equal(field(() => decodeKeeperCheckKey(value)), expected, `${name} is refused at its field`);
  }
});

test("9.1-F reference sites: the key names exactly the container records of its two addresses; pointers, project and version are data and no other Ref-like value is a reference", () => {
  const sites = referenceSites(KEEPER_CHECK_KEY_KIND, key());
  assert.deepEqual(sites.map(site => site.field).sort(), ["artifact.container", "constitution.container"]);
  assert.deepEqual(sites.find(site => site.field === "constitution.container")?.ref, at("discovery:p:draft", 7));
  const extra = { ...key(), smuggled: at("keeper-verdict:old") };
  assert.deepEqual(referenceSites(KEEPER_CHECK_KEY_KIND, extra).map(site => site.field).sort(), ["artifact.container", "constitution.container"],
    "a Ref-like value outside the declared paths is not a service reference");
});

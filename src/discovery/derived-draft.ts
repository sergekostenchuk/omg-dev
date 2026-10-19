import { Store, type Revision } from "../storage/store.js";
import { canonical, hashJson } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { isRef, uniqueRefs, type Ref, type Stage, type StageArtifact } from "../pipeline/contracts.js";
import type { Json } from "../canonical.js";
import { DISCOVERY_PREFIX_CLOSURE_CONTRACT, DISCOVERY_PREFIX_CLOSURE_KIND, discoveryPrefixClosureId,
  type DiscoveryDraft, type DiscoveryPrefixClosure, type ResearchLevel } from "./discovery.js";

export interface Derivation { field: string; source: Ref; path: string[] }
export function deriveFields(store: Store, project: string, entries: Derivation[]): Record<string, Json> {
  requireCondition(Array.isArray(entries) && entries.length > 0
    && entries.every(entry => entry && typeof entry.field === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(entry.field)
      && isRef(entry.source) && Array.isArray(entry.path) && entry.path.length > 0 && entry.path.every(key => typeof key === "string"))
    && new Set(entries.map(entry => entry.field)).size === entries.length,
    "derivation_invalid", "Derivation needs distinct named fields");
  return Object.fromEntries(entries.map(entry => {
    const source = store.get<StageArtifact>(entry.source.id);
    requireCondition(source?.kind === "stage" && source.value.projectId === project && source.value.status === "accepted"
      && source.hash === entry.source.hash && source.revision === entry.source.revision, "derivation_stale", "Derived research requires the exact accepted input");
    let value: unknown = source.value.content;
    for (const key of entry.path) {
      requireCondition(value && typeof value === "object" && Object.hasOwn(value, key), "derivation_field_missing", "The accepted input does not contain the required field");
      value = (value as Record<string, unknown>)[key];
    }
    return [entry.field, JSON.parse(canonical(value)) as Json];
  }));
}
export function derivedDraft(store: Store, project: string, stage: Stage, level: ResearchLevel, consumer: string,
  entries: Derivation[], inputs: Ref[], version: number): Revision<DiscoveryDraft> {
  const fields = deriveFields(store, project, entries);
  const guards = uniqueRefs([...inputs, ...entries.map(entry => entry.source)]);
  const id = `derived-research:${project}:${level}`; const old = store.get<DiscoveryDraft>(id);
  const body = { projectId: project, stage, level, consumer, fields, questions: [], inputs: guards,
    contractVersion: version, derivations: entries };
  if (old && canonical({ ...old.value, createdAt: 0 }) === canonical({ ...body, createdAt: 0 })) return old;
  const revision = (old?.revision ?? 0) + 1;
  const value = { ...body, createdAt: Date.now() };
  // G4a: the derived draft's prefix is its derivation sources — closed in the same batch; a moved
  // source head makes the saved closure miss and the gate takes the full pass for the exact finding.
  const closure: DiscoveryPrefixClosure = { contract: DISCOVERY_PREFIX_CLOSURE_CONTRACT,
    projectId: project, draftId: id, draft: { id, revision, hash: hashJson(value) },
    inputs: body.inputs, derivations: entries.map(entry => entry.source), questions: [], external: [] };
  return store.writeMany<DiscoveryDraft>([
    { id, kind: "discovery-draft", expected: old?.revision ?? 0, value },
    { id: discoveryPrefixClosureId(id, revision), kind: DISCOVERY_PREFIX_CLOSURE_KIND, expected: 0, value: closure }], guards)[0]!;
}

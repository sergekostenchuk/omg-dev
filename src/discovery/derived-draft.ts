import { Store, type Revision } from "../storage/store.js";
import { canonical } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { isRef, uniqueRefs, type Ref, type Stage, type StageArtifact } from "../pipeline/contracts.js";
import type { Json } from "../canonical.js";
import type { DiscoveryDraft, ResearchLevel } from "./discovery.js";

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
  return store.writeMany<DiscoveryDraft>([{ id, kind: "discovery-draft", expected: old?.revision ?? 0,
    value: { ...body, createdAt: Date.now() } }], guards)[0]!;
}

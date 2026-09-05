import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Graph } from "../graph/model.js";
import type { Json } from "../canonical.js";
import { canonical, hashJson } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { layerDesignOf, composeLayer } from "../graph/layer-design.js";
import { requireCondition } from "../errors.js";

export const DELTA_COLLECTIONS = ["nodes", "connectors", "contracts", "artifacts", "edges", "journeys", "joins", "anchors", "tests", "packets", "transfers"] as const;
export type DeltaCollection = typeof DELTA_COLLECTIONS[number];
export interface LayerDelta {
  base: Ref;
  upserts: Partial<Record<DeltaCollection, { id: string; [key: string]: Json }[]>>;
  removes: Partial<Record<DeltaCollection, string[]>>;
}

export function expandLayerDelta(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, delta: LayerDelta): Json {
  requireCondition(draft.value.stage === "om-g2" && draft.value.level === "R1" && question.value.draftId === draft.id
    && question.value.spec.field === "layerDesign", "layer_delta_foreign", "This experiment applies deltas only to L2 design");
  const base = store.get<Graph>(`graph:${draft.value.projectId}`);
  requireCondition(base && canonical(reference(base)) === canonical(delta.base), "graph_stale", "The delta must bind the exact current graph");
  const design = layerDesignOf(base.value, 2) as Record<string, Json>;
  for (const collection of DELTA_COLLECTIONS) {
    const entries = (design[collection] ?? []) as { id: string; [key: string]: Json }[];
    const upserts = delta.upserts[collection] ?? [], removes = delta.removes[collection] ?? [];
    requireCondition(new Set(upserts.map(entry => entry.id)).size === upserts.length
      && new Set(removes).size === removes.length && !upserts.some(entry => removes.includes(entry.id)),
    "layer_delta_ambiguous", "Each entity can be changed only once in a delta");
    requireCondition(removes.every(id => entries.some(entry => entry.id === id)), "layer_delta_missing", "Cannot remove an entity absent from the base");
    const changed = entries.filter(entry => !removes.includes(entry.id)).map(entry => ({ ...entry, ...upserts.find(update => update.id === entry.id) }));
    changed.push(...upserts.filter(update => !entries.some(entry => entry.id === update.id)));
    design[collection] = changed;
  }
  // Validate the assembled graph, including unchanged upper layers and complete
  // L2 relationships. No graph or accepted draft is written by this expansion.
  return layerDesignOf(composeLayer(base.value, 2, design), 2);
}

export function layerDeltaView(store: Store, project: string, value: Json) {
  const base = store.get<Graph>(`graph:${project}`)!;
  const before = layerDesignOf(base.value, 2) as Record<string, Json>;
  const after = value as Record<string, Json>;
  const upserts: LayerDelta['upserts'] = {}, removes: LayerDelta['removes'] = {};
  for (const collection of DELTA_COLLECTIONS) {
    const old = (before[collection] ?? []) as { id: string; [key: string]: Json }[];
    const next = (after[collection] ?? []) as { id: string; [key: string]: Json }[];
    const updated = next.filter(entry => !old.some(previous => previous.id === entry.id && canonical(previous) === canonical(entry)))
      .map(entry => {
        const previous = old.find(value => value.id === entry.id);
        return previous ? Object.fromEntries(Object.entries(entry).filter(([key, value]) => key === "id"
          || !Object.hasOwn(previous, key) || canonical(previous[key]) !== canonical(value))) as typeof entry : entry;
      });
    const removed = old.filter(entry => !next.some(current => current.id === entry.id)).map(entry => entry.id);
    if (updated.length) upserts[collection] = updated;
    if (removed.length) removes[collection] = removed;
  }
  return { base: reference(base), candidateHash: hashJson(value), upserts, removes };
}

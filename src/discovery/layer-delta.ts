import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Graph } from "../graph/model.js";
import type { Json } from "../canonical.js";
import { canonical, hashJson } from "../canonical.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import type { ResearchTurn } from "./research-model.js";
import { layerDesignOf, composeLayer } from "../graph/layer-design.js";
import { requireCondition } from "../errors.js";
import { obligationHandoff } from '../graph/obligation-handoff.js';
import { requireTaskObligations } from '../graph/task-obligations.js';
import { Ajv } from 'ajv';
import type { LayerAssembly } from '../graph/layer-assembly.js';

export const DELTA_COLLECTIONS = ["nodes", "connectors", "contracts", "artifacts", "edges", "journeys", "joins", "anchors", "tests", "packets", "transfers", "researchObligations"] as const;
export type DeltaCollection = typeof DELTA_COLLECTIONS[number];
export interface LayerDelta {
  base: Ref;
  revises?: Ref;
  horizon?: string[];
  upserts: Partial<Record<DeltaCollection, { id: string; [key: string]: Json }[]>>;
  removes: Partial<Record<DeltaCollection, string[]>>;
}

/** Build an unaccepted candidate for correction/display. Only expandLayerDelta
 * may turn it into a validated layer proposal. */
export function layerDeltaCandidate(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, delta: LayerDelta): Json {
  requireCondition(draft.value.stage === "om-g2" && ["R1", "R2"].includes(draft.value.level) && question.value.draftId === draft.id
    && question.value.spec.field === "layerDesign", "layer_delta_foreign", "Deltas require a bound L2/L3 design question");
  const base = store.get<Graph>(`graph:${draft.value.projectId}`);
  requireCondition(base && canonical(reference(base)) === canonical(delta.base), "graph_stale", "The delta must bind the exact current graph");
  const level = draft.value.level === "R2" ? 3 : 2;
  const design = layerDesignOf(base.value, level, question.value.spec.layerAssembly) as Record<string, Json>;
  const chain: LayerDelta[] = [delta], seen = new Set<string>();
  let previous = delta.revises;
  while (previous) {
    requireCondition(isRef(previous) && !seen.has(previous.id), "layer_delta_revision_invalid", "Invalid or cyclic proposal revision");
    seen.add(previous.id);
    const turn = store.get<ResearchTurn>(previous.id);
    const action = turn?.value.action as (LayerDelta & { action?: string; question?: string }) | undefined;
    requireCondition(turn?.kind === "research-turn" && canonical(reference(turn)) === canonical(previous)
      && turn.value.status === "completed" && canonical(turn.value.question) === canonical(reference(question))
      && action?.action === "answer_delta" && action.question === question.id && canonical(action.base) === canonical(delta.base),
      "layer_delta_revision_foreign", "Correction must reference a completed proposal for this exact question and graph");
    chain.push(action); previous = action.revises;
  }
  for (const patch of chain.reverse()) {
    if (patch.horizon !== undefined) {
      requireCondition(level === 3, "layer_delta_foreign", "Only L3 can set the atomic horizon");
      design["horizon"] = patch.horizon;
    }
    for (const collection of DELTA_COLLECTIONS) {
      if (collection === 'researchObligations') {
        if (!Object.hasOwn(design, collection) && !Object.hasOwn(patch.upserts, collection) && !Object.hasOwn(patch.removes, collection)
          && !(question.value.spec.schema as { required?: string[] }).required?.includes(collection)) continue;
        requireCondition(level === 3, 'layer_delta_foreign', 'Only L3 binds future work and test consumers');
      }
      const entries = (design[collection] ?? []) as { id: string; [key: string]: Json }[];
      const upserts = patch.upserts[collection] ?? [], removes = patch.removes[collection] ?? [];
      requireCondition(new Set(upserts.map(entry => entry.id)).size === upserts.length
        && new Set(removes).size === removes.length && !upserts.some(entry => removes.includes(entry.id)),
      "layer_delta_ambiguous", "Each entity can be changed only once in a delta");
      requireCondition(removes.every(id => entries.some(entry => entry.id === id)), "layer_delta_missing", "Cannot remove an entity absent from the base");
      const changed = entries.filter(entry => !removes.includes(entry.id)).map(entry => ({ ...entry, ...upserts.find(update => update.id === entry.id) }));
      changed.push(...upserts.filter(update => !entries.some(entry => entry.id === update.id)));
      design[collection] = changed;
    }
  }
  return design;
}

export function expandLayerDelta(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, delta: LayerDelta): Json {
  const design = layerDeltaCandidate(store, draft, question, delta);
  const base = store.get<Graph>(delta.base.id, delta.base.revision)!;
  // Validate the assembled graph, including unchanged upper layers and complete
  // L2 relationships. No graph or accepted draft is written by this expansion.
  const level = draft.value.level === "R2" ? 3 : 2;
  if (question.value.spec.layerAssembly) requireCondition(new Ajv({ strict: true, allowUnionTypes: true }).compile(question.value.spec.schema as object)(design),
    'answer_invalid', 'The assembled proposal must satisfy its typed L3 authoring schema before graph validation');
  const graph = composeLayer(base.value, level, design, question.value.spec.layerAssembly);
  if (level === 3) {
    const handoff = obligationHandoff(store, draft.value.projectId, draft.value.inputs);
    if (handoff) requireTaskObligations(store, draft.value.projectId, graph, handoff);
  }
  return layerDesignOf(graph, level, question.value.spec.layerAssembly);
}

export function layerDeltaView(store: Store, project: string, value: Json, level: 2 | 3 = 2, assembly?: LayerAssembly) {
  const base = store.get<Graph>(`graph:${project}`)!;
  const before = layerDesignOf(base.value, level, assembly) as Record<string, Json>;
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
  return { ...(level === 3 ? { horizon: after["horizon"] as string[] } : {}), base: reference(base), candidateHash: hashJson(value), upserts, removes };
}

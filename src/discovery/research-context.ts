import type { Store } from "../storage/store.js";
import { STAGES, reference, type StageArtifact } from "../pipeline/contracts.js";
import type { DiscoveryDraft } from "./discovery.js";

/** The immediate accepted prerequisite carries the detailed handoff; older stages
 * supply identities needed for traceability, without duplicating every report. */
export function researchPrerequisites(store: Store, draft: DiscoveryDraft) {
  const stages = draft.inputs.flatMap(ref => {
    const record = store.get<StageArtifact>(ref.id, ref.revision);
    return record?.kind === "stage" && record.hash === ref.hash ? [record] : [];
  }).sort((left, right) => STAGES.indexOf(right.value.stage) - STAGES.indexOf(left.value.stage));
  const latest = stages[0];
  return stages.map(record => {
    const content = record.value.content as { fields?: Record<string, unknown> };
    const fields = content?.fields ?? {};
    const identities: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (name === "preparation" && value && typeof value === "object") {
        const preparation = value as Record<string, unknown>;
        identities[name] = { actors: preparation['actors'], outcomes: preparation['outcomes'], constraints: preparation['constraints'] };
      } else if (name === "conceptSections" && Array.isArray(value)) identities[name] = value;
    }
    return { ref: reference(record), stage: record.value.stage, fields: record === latest ? fields : identities };
  });
}

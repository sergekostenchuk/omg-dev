import type { Observation } from "../evidence/evidence.js";
import { canonical } from "../canonical.js";

/** Retain reading provenance and coverage, but point to identical text already
 * included in the assessor's observations. Stored evidence is never rewritten. */
export function assessmentReadings<T extends { observations: Observation[] }>(readings: T[], observations: Observation[]) {
  return readings.map(reading => ({ ...reading, observations: reading.observations.map(original => {
    if (original.selector.kind !== "text-range" || typeof original.value !== "string") return original;
    const selector = original.selector;
    const index = observations.findIndex(candidate => candidate.selector.kind === "text-range"
      && typeof candidate.value === "string" && candidate.projectId === original.projectId && canonical(candidate.source) === canonical(original.source)
      && candidate.selector.start <= selector.start && candidate.selector.end >= selector.end
      && candidate.value.slice(selector.start - candidate.selector.start, selector.end - candidate.selector.start) === original.value);
    if (index < 0) return original;
    const candidate = observations[index]!;
    if (candidate.selector.kind !== "text-range") return original;
    const { value: _value, ...provenance } = original;
    const compact = { ...provenance, valueFrom: { pointer: `/observations/${index}/value`,
      start: selector.start - candidate.selector.start, end: selector.end - candidate.selector.start } };
    return JSON.stringify(compact).length < JSON.stringify(original).length ? compact : original;
  }) }));
}

export const ASSESSMENT_READING_ENCODING = "A retained reading with valueFrom uses the exact string at that JSON pointer in THIS request, sliced by start/end UTF-16 offsets (end exclusive). The full text is already in observations. This is not a missing source or a summary; original source coordinates, hashes, coverage and unresolved questions remain attached.";

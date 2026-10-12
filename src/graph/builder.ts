import type { Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { requireGraph } from "./validate.js";
import { graphV2Schema } from "./schema.js";
import { projectGraph } from "./project.js";
import type { Graph } from "./model.js";

export const mapDesignSchema = structuredClone(graphV2Schema);
// New L3 join semantics must not rewrite accepted L1/L2 authoring schemas.
for (const field of ['condition', 'required', 'optional']) delete mapDesignSchema.properties['joins'].items.properties[field];
for (const field of ["version", "id", "title", "actors", "requirements", "researchObligations"]) {
  delete mapDesignSchema.properties[field]; mapDesignSchema.required = mapDesignSchema.required.filter(item => item !== field);
}
mapDesignSchema.properties['horizon'] = { type: "array", maxItems: 0 };
// AT1 (№4091 п.4, п.7): a work's impact decisions and required connections must not rewrite accepted L1–L3 authoring schemas.
for (const field of ["impact", "integrations"]) delete mapDesignSchema.properties['nodes'].items.properties[field];

export function designOf(graph: Graph): Record<string, unknown> {
  const projection = projectGraph(graph, 1);
  const { id: _id, title: _title, level: _level, version: _version, actors: _actors, requirements: _requirements, ...design } = projection;
  return design;
}
export function buildL1(graphId: string, title: string, design: unknown,
  initial: Record<string, Json>, concept: Record<string, Json>): Graph {
  requireCondition(design && typeof design === "object" && !Array.isArray(design), "map_design_missing", "A researched map design is required");
  requireCondition(!["version", "id", "title", "actors", "requirements"].some(key => Object.hasOwn(design, key)), "derived_field_conflict", "Map identity, actors and concept requirements are supplied by the engine");
  const preparation = initial['preparation'] as unknown as { actors: { id: string; role: string; channels: string[] }[];
    outcomes: { id: string }[]; journeys: Record<string, { applicability: string; scenarios: { actor: string; outcome: string }[] }> };
  const sections = concept['conceptSections'] as unknown as { id: string; requirements: { id: string; outcome: string; beneficiary: string; statement: string }[] }[];
  requireCondition(preparation && sections, "map_inputs_missing", "The initial research and concept must provide their enriched data");
  const actors = preparation.actors.map(({ id, role, channels }) => ({ id, role, channels }));
  const requirements = sections.flatMap(section => section.requirements.map(({ id, outcome, beneficiary, statement }) => ({ id, section: section.id, outcome, beneficiary, statement })));
  const graph = requireGraph({ ...design, version: 2, id: graphId, title, actors, requirements });
  requireCondition(graph.horizon.length === 0 && graph.nodes.every(node => ["product", "block"].includes(node.kind)
    && node.code.length === 0 && node.tests.length === 0) && graph.tests.length === 0 && graph.packets!.length === 0 && graph.transfers!.length === 0,
    "l1_detail_leak", "Initial topology must describe blocks and product flows without future code or task details");
  requireCondition(graph.connectors.every(connector => connector.bindings.every(binding => binding.level === 1)), "l1_detail_leak", "Initial map bindings must be L1");
  for (const outcome of preparation.outcomes) requireCondition(graph.journeys!.some(journey => journey.outcome === outcome.id && journey.terminal === "success"),
    "outcome_uncovered", `The product outcome ${outcome.id} has no successful path`);
  for (const [variant, entry] of Object.entries(preparation.journeys)) if (entry.applicability === "applicable") {
    const positive = ["success", "first_use", "repeated_use"].includes(variant);
    for (const scenario of entry.scenarios) requireCondition(graph.journeys!.some(journey => journey.variant === variant && journey.actor === scenario.actor
      && (positive ? journey.terminal === "success" && journey.outcome === scenario.outcome
        : journey.terminal !== "success" || journey.outcome === scenario.outcome)), "journey_uncovered", `Missing ${variant} journey for ${scenario.actor}`);
  }
  return graph;
}

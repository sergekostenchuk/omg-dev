import type { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { reference } from "../src/pipeline/contracts.js";
import { exampleGraph } from "./graph-fixture.js";
import type { Graph } from "../src/graph/model.js";

export function preparedFeatures(engine: ProductEngine, project: string, graph: Graph = exampleGraph(project)) {
  engine.execute({ type: "create-project", project, title: project });
  const source = engine.discovery.evidence.document(project, "brief", `A brief for ${project}`, "text/plain", 0);
  engine.graphs.save(project, graph, 0, "owner");
  for (const stage of UPSTREAM_STAGES) {
    const draft = engine.prepare(project, stage);
    for (const id of draft.value.questions) {
      const question = engine.projection(project).questions.find(q => q.id === id)!;
      if (question.value.spec.kind === "fact") engine.discovery.fact(id, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
      else {
        const field = question.value.spec.field;
        const value = field === "features" ? [{ title: "Deliver result", outcome: `${project}-result`, requirements: [0] }]
          : ["acceptance", "journey", "behavior", "constraints"].includes(field) ? [`${field} for ${project}`] : `${field} for ${project}`;
        engine.discovery.decision(id, 1, "owner", value);
      }
    }
    const artifact = engine.draft(project, stage, draft.id, 0); engine.pipeline.accept(project, stage, artifact.revision);
  }
}

export function refinedLayers(engine: ProductEngine, project: string) {
  const source = engine.discovery.evidence.document(project, "context", '{"context":{"language":"JavaScript"}}', "application/json", 0);
  for (const [level, layer] of [["R0", 1], ["R1", 2], ["R2", 3]] as const) {
    const draft = engine.refinement.begin(project, level);
    if (level === "R0") engine.discovery.decision(draft.value.questions[0]!, 1, "owner", "Owner receives the produced result; implementation and review are separate roles");
    else engine.discovery.fact(draft.value.questions[0]!, 1, reference(source), { kind: "json-pointer", pointer: "/context" });
    const current = engine.store.get(draft.id)!;
    engine.refinement.finishResearch(project, level, reference(current), 0);
    engine.refinement.sealLayer(project, layer, 0);
  }
}

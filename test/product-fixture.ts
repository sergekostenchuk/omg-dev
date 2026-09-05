import type { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { reference } from "../src/pipeline/contracts.js";
import { exampleGraph } from "./graph-fixture.js";
import type { Graph } from "../src/graph/model.js";
import { preparedField } from "./preparation-fixture.js";
import type { Json } from "../src/canonical.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";

export function preparedFeatures(engine: ProductEngine, project: string, graph: Graph = exampleGraph(project),
  valueFor: (field: string) => Json = field => preparedField(project, field)) {
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
        const value = valueFor(field);
        engine.discovery.decision(id, 1, "owner", value);
      }
    }
    const artifact = engine.draft(project, stage, draft.id, 0); engine.pipeline.accept(project, stage, artifact.revision);
  }
}

export function refinedLayers(engine: ProductEngine, project: string) {
  for (const [level, layer] of [["R0", 1], ["R1", 2], ["R2", 3]] as const) {
    const draft = engine.refinement.begin(project, level);
    if (level !== "R0") answerTechnicalFixture(engine, project, draft);
    const current = engine.store.get(draft.id)!;
    engine.refinement.finishResearch(project, level, reference(current), 0);
    engine.refinement.sealLayer(project, layer, 0);
  }
}

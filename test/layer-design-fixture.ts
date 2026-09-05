import type { ProductEngine } from "../src/product/engine.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { Revision } from "../src/storage/store.js";
import type { ResearchAssessment } from "../src/discovery/research-model.js";
import type { Graph } from "../src/graph/model.js";
import { reference } from "../src/pipeline/contracts.js";
import { hashJson } from "../src/canonical.js";
import { layerDesignOf } from "../src/graph/layer-design.js";

// Manufactured model assessment for deterministic downstream contract tests only.
export function answerLayerFixture(engine: ProductEngine, project: string, draft: Revision<DiscoveryDraft>, level: 2 | 3, graph: Graph) {
  const question = engine.store.get<Question>(draft.value.questions[0]!)!;
  const environment = engine.environments.get(project);
  const source = engine.discovery.evidence.document(project, `layer-fixture-${level}`, "Fixture design based on the accepted product brief", "text/plain",
    engine.store.get(`source:${project}:layer-fixture-${level}`)?.revision ?? 0);
  const value: ResearchAssessment = { projectId: project, question: reference(question), value: layerDesignOf(graph, level),
    observations: [engine.discovery.evidence.observe(project, reference(source), { kind: "text-range", start: 0, end: source.value.content.length })],
    verdict: "supported", reasons: [], researcher: environment.value.implementer.actor, assessor: environment.value.reviewer.actor, environment: reference(environment) };
  const assessment = engine.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(value)}`, kind: "research-assessment", expected: 0, value });
  return engine.discovery.researched(question.id, question.revision, reference(assessment));
}

export function deriveLayerFixture(engine: ProductEngine, project: string, level: 2 | 3) {
  const draft = engine.refinement.prepareLayer(project, level);
  const graph = engine.store.get<Graph>(`graph:${project}`)!;
  const answered = answerLayerFixture(engine, project, draft, level, graph.value);
  return engine.refinement.buildLayer(project, level, reference(answered), graph.revision, "fixture-researcher");
}

import type { ProductEngine } from "../src/product/engine.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { Revision } from "../src/storage/store.js";
import type { ResearchAssessment } from "../src/discovery/research-model.js";
import type { Source } from "../src/evidence/evidence.js";
import type { TechnicalReport } from "../src/graph/research-contracts.js";
import { reference } from "../src/pipeline/contracts.js";
import { hashJson, type Json } from "../src/canonical.js";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const DESIGNS: Record<string, string> = {
  productDomain: "Model input, validated intermediate data and terminal result as distinct values; one transformation owns each output.",
  actorsAndChannels: "A local CLI caller supplies input and consumes the result. No authenticated network entrypoint is planned.",
  runtime: "Use a bounded local process for transformation; process termination ends the stateless invocation.",
  persistence: "Keep intermediate and final transformation files separate. No durable user database or schema migration is planned.",
  authority: "Only the chosen local work directory is writable. Do not modify repository metadata or external user data.",
  integrations: "The producer publishes validated data to the consumer using the declared local artifact contract; no paid provider is planned.",
  recovery: "Do not publish a failed transformation. A caller may repeat a stateless request from unchanged input after failure.",
  delivery: "Deliver a standalone local CLI. There is no earlier product version or persisted user schema to migrate.",
  evidenceAndTests: "Exercise valid input through the CLI and invalid input through the same entrypoint; observe returned output and absence of publication on failure.",
  contractsAndConsumers: "The planned producer writes produce.txt and its direct consumer writes consume.txt. The graph's connector defines their input/output contract.",
  authorityPaths: "The local CLI is the only proposed entrypoint. Restrict writes to the declared work files; reject outside paths and foreign source revisions.",
  stateAndRecovery: "Each stateless transformation owns one output; do not expose incomplete output. A retry starts from the same input and publishes one final result.",
  connectivityAndProof: "Test the actual producer-to-consumer path. Removing the intermediate artifact must refuse consumption; no future network or paid provider is needed.",
};

// These explicitly manufactured assessments seed downstream unit tests. Live
// model assessment quality is covered separately; this is not research evidence.
export function answerTechnicalFixture(engine: ProductEngine, project: string, draft: Revision<DiscoveryDraft>,
  transform: (field: string, report: TechnicalReport) => TechnicalReport = (_field, report) => report): void {
  const environment = engine.environments.get(project);
  const root = realpathSync(engine.environments.effective(project).root);
  let source = engine.store.get<Source>(`source:${project}:context`);
  const key = source && source.value.origin.location !== join(root, "README.md") ? `context-${hashJson(root).slice(0, 24)}` : "context";
  source = engine.store.get<Source>(`source:${project}:${key}`);
  source ??= engine.discovery.evidence.file(project, key, root, "README.md", "text/plain", 0);
  for (const id of draft.value.questions) {
    const question = engine.store.get<Question>(id)!;
    if (question.value.status === "answered") continue;
    const report = transform(question.value.spec.field, { applicability: "applicable", reason: "The accepted fixture describes a new local stateless product",
      facts: [{ id: `${question.value.spec.field}-baseline`, claim: `Baseline documentation contains: ${source.value.content.trim()}`, path: "README.md" }],
      designs: [{ id: `${question.value.spec.field}-design`, decision: DESIGNS[question.value.spec.field] ?? "Resolve the inherited gap using the declared producer and consumer contract before proceeding.",
        benefit: "The consumer receives a bounded validated transformation result", consumer: "compilation" }], gaps: [] });
    const value: ResearchAssessment = { projectId: project, question: reference(question), value: report as unknown as Json,
      observations: [engine.discovery.evidence.observe(project, reference(source), { kind: "text-range", start: 0, end: source.value.content.length })],
      verdict: "supported", reasons: [], researcher: environment.value.implementer.actor, assessor: environment.value.reviewer.actor, environment: reference(environment) };
    const assessment = engine.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(value)}`, kind: "research-assessment", expected: 0, value });
    engine.discovery.researched(id, question.revision, reference(assessment));
  }
}

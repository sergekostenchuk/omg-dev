import { AsyncLocalStorage } from 'node:async_hooks';
import { discoveryBasisCatalogue, discoveryContext } from '../src/discovery/discovery-outcome.js';
import type { ResearchAssessment } from '../src/discovery/research-model.js';
import type { Environment } from '../src/runtime/environment.js';
import type { Question, DiscoveryDraft } from '../src/discovery/discovery.js';
import type { Revision } from '../src/storage/store.js';
import type { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { reference, stageId, type StageArtifact } from "../src/pipeline/contracts.js";
import { exampleGraph } from "./graph-fixture.js";
import type { Graph } from "../src/graph/model.js";
import { preparedField, boundDiscoveryValue } from "./preparation-fixture.js";
import { hashJson, type Json } from "../src/canonical.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { designOf } from "../src/graph/builder.js";
import { deriveLayerFixture } from "./layer-design-fixture.js";

const upstreamEra = new AsyncLocalStorage<string>();
/** Scope a neighboring fixture without changing its default for other tests. The scope names an upstream era that no fixture builds
 * any more: inside it a call that states no era of its own is refused (product_fixture_era_unsupported); an explicit "" builds the current stages. */
export function withHistoricalUpstream<T>(commit: string, fixture: () => T): T {
  return upstreamEra.run(commit, fixture);
}

/** Current fixture proposals use the exact accepted Discovery basis. */
export function currentUpstreamFixtureValue(engine: ProductEngine, project: string, field: string, value: Json): Json {
  if (field !== 'conceptSections' && field !== 'behaviorContracts') return value;
  const discovery = engine.store.get<StageArtifact>(stageId(project, 'discovery'));
  if (!discovery) return value;
  const fields = (discovery.value.content as { fields: Record<string, Json> }).fields;
  const catalogue = discoveryBasisCatalogue({ ref: reference(discovery), fields });
  const rows = structuredClone(value) as Record<string, unknown>[];
  if (field === 'conceptSections') {
    for (const [sectionIndex, section] of rows.entries()) {
      const requirements = section['requirements'] as Record<string, unknown>[];
      for (const [requirementIndex, requirement] of requirements.entries()) {
        requirement['applications'] = [catalogue.variant, ...catalogue.constraints].map(entry => ({
          contract: 'basis-application/v1', basis: entry.address,
          appliedAt: [`/${sectionIndex}/requirements/${requirementIndex}/${entry === catalogue.variant ? 'statement' : 'acceptance/0'}`],
        }));
      }
    }
  } else {
    const concept = engine.store.get<StageArtifact>(stageId(project, 'concept'));
    const sections = ((concept?.value.content as { fields?: Record<string, Json> } | undefined)?.fields?.['conceptSections'] ?? []) as Record<string, unknown>[];
    const requirements = sections.flatMap(section => section['requirements'] as Record<string, unknown>[]);
    for (const [index, contract] of rows.entries()) {
      const selected = new Set(contract['requirements'] as string[]);
      const basis = new Map<string, typeof catalogue.variant.address>();
      for (const requirement of requirements.filter(row => selected.has(row['id'] as string)))
        for (const application of requirement['applications'] as { basis: typeof catalogue.variant.address }[])
          basis.set(JSON.stringify(application.basis), application.basis);
      contract['applications'] = [...basis.values()].map(address => ({
        contract: 'basis-application/v1', basis: address,
        appliedAt: [address.pointer.includes('/verdict/') ? `/${index}/entry` : `/${index}/success/0`],
      }));
    }
  }
  return rows as Json;
}

export function preparedFeatures(engine: ProductEngine, project: string, graph: Graph = exampleGraph(project),
  valueFor: (field: string) => Json = field => preparedField(project, field), historicalCommit?: string) {
  const era = historicalCommit ?? upstreamEra.getStore();
  // A named era is not built any more, and it must never silently turn into the current one.
  if (era) throw new EngineError("product_fixture_era_unsupported",
    "The product fixture builds only the current upstream; a non-empty era, explicit or inherited, is not supported", { target: "/era" });
  engine.execute({ type: "create-project", project, title: project });
  const source = engine.discovery.evidence.document(project, "brief", `A brief for ${project}`, "text/plain", 0);
  graph = enrichedGraph(graph, project, valueFor("preparation"), valueFor("conceptSections"));
  engine.graphs.save(project, graph, 0, "owner");
  for (const stage of UPSTREAM_STAGES) {
    const draft = engine.prepare(project, stage);
    for (const id of draft.value.questions) {
      const question = engine.projection(project).questions.find(q => q.id === id)!;
      if (question.value.spec.kind === "fact") engine.discovery.fact(id, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
      else {
        const field = question.value.spec.field;
        const value = currentUpstreamFixtureValue(engine, project, field,
          field === "mapDesign" ? designOf(graph) as unknown as Json : valueFor(field));
        if (stage === 'discovery' && (draft.value.contractVersion ?? 0) >= 5 && ['researchPlan','researchReport','verdict','preparation'].includes(field))
          answerDiscoveryFixture(engine, project, engine.store.get<DiscoveryDraft>(draft.id)!, engine.store.get<Question>(id)!, value, source);
        else engine.discovery.decision(id, 1, "owner", value);
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
    if (layer !== 1) deriveLayerFixture(engine, project, layer);
    engine.refinement.sealLayer(project, layer, 0);
  }
}

/** Like answerTechnicalFixture, this seeds downstream unit tests with explicit
 * manufactured assessments. Research-stage integration tests use real adapters. */
export function answerDiscoveryFixture(engine: ProductEngine, project: string, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, value: Json, source: Revision<{content:string}>) {
  if (question.value.spec.field === 'preparation') return engine.discovery.decision(question.id, question.revision, 'owner',
    boundDiscoveryValue('preparation', value, discoveryContext(engine.store, draft, question).context));
  const command={executable:process.execPath,args:['--version']};
  // A frozen fixture-only environment is not the project's active execution
  // configuration; downstream tests retain their own first configure call.
  const environment=engine.store.get<Environment>(`fixture-research-environment:${project}`) ?? engine.store.write<Environment>({
    id:`fixture-research-environment:${project}`,kind:'environment',expected:0,value:{projectId:project,workspace:process.cwd(),
      implementer:{actor:'fixture-author',model:'fixture',effort:'medium',command},reviewer:{actor:'fixture-assessor',model:'fixture',effort:'medium',command},fullCheck:command,timeoutMs:10000}});
  const accepted=boundDiscoveryValue(question.value.spec.field,value,discoveryContext(engine.store,draft,question).context);
  const assessment:ResearchAssessment={projectId:project,question:reference(question),value:accepted,
    observations:[engine.discovery.evidence.observe(project,reference(source),{kind:'text-range',start:0,end:source.value.content.length})],
    verdict:'supported',reasons:[],researcher:'fixture-author',assessor:'fixture-assessor',environment:reference(environment)};
  const saved=engine.store.write({id:`research-assessment:${hashJson(assessment)}`,kind:'research-assessment',expected:0,value:assessment});
  return engine.discovery.researched(question.id,question.revision,reference(saved));
}

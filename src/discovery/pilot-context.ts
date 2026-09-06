import { mapStatus } from "../graph/map-status.js";
import { researchScope, scopeObligations } from "../graph/research-scope.js";
import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { readerResultCurrent, type ReaderResult } from "./reader.js";
import { Evidence, sourceIsCurrent, type Source, type Observation } from "../evidence/evidence.js";
import { reference, stageId, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { researchGraphContext } from "./research-context.js";
import type { Graph } from "../graph/model.js";
import { layerDeltaView } from "./layer-delta.js";
import { researchConsumerIds } from "../graph/research-evidence.js";
import { contextTable, targetFieldGroups, CONTEXT_ENCODING } from "./context-tables.js";
import { archivedContext, contextValue, contextPage, type ContextPage } from "./working-context.js";

const escape = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const descriptor = (pointer: string, value: unknown) => ({ pointer, chars: canonical(value).length, hash: hashJson(value) });

export function contextCatalogue(store: Store, draft: Revision<DiscoveryDraft>) {
  const allowed = [reference(draft), ...draft.value.inputs];
  return allowed.flatMap(ref => {
    const record = store.get(ref.id, ref.revision);
    if (!record || record.hash !== ref.hash || !["stage", "graph-layer", "discovery-draft", "research-scope"].includes(record.kind)) return [];
    const value = record.value as Record<string, any>;
    const fields = record.kind === "stage" ? value['content']?.fields : record.kind === "discovery-draft" ? value['fields'] : record.kind === "research-scope" ? value : null;
    const entries = fields ? Object.entries(fields).map(([key, value]) => ({ field: key,
      ...descriptor(`${record.kind === "research-scope" ? "" : record.kind === "stage" ? "/content/fields" : "/fields"}/${escape(key)}`, value) })) : [];
    return [{ ref, kind: record.kind, stage: value['stage'] ?? null, fields: entries }];
  });
}

export function readPilotContext(store: Store, draft: Revision<DiscoveryDraft>, ref: Ref, pointer: string, maxChars: number, page?: ContextPage) {
  if (store.get(ref.id, ref.revision)?.kind === "research-context") {
    const value = contextValue(archivedContext(store, draft, ref), pointer);
    const result = { record: ref, pointer, ...contextPage(value, page) };
    requireCondition(canonical(result).length <= maxChars, "context_read_limit", "Use a smaller page; the complete original remains in the archive");
    return result;
  }
  requireCondition(contextCatalogue(store, draft).some(item => canonical(item.ref) === canonical(ref)),
    "context_reference_foreign", "Only the current draft and its bound context records can be read");
  const record = store.get(ref.id, ref.revision)!;
  requireCondition(typeof pointer === "string" && (pointer === "" || pointer.startsWith("/")), "selector_invalid", "Use an explicit JSON pointer");
  let value = record.value;
  if (pointer) for (const encoded of pointer.slice(1).split("/")) {
    requireCondition(!/~(?![01])/.test(encoded), "selector_invalid", "Invalid pointer escape");
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    requireCondition(value !== null && typeof value === "object" && Object.hasOwn(value, key), "context_missing", "Context pointer does not exist");
    value = (value as Record<string, Json>)[key]!;
  }
  const result = { record: ref, pointer, ...contextPage(value, page) };
  requireCondition(canonical(result).length <= maxChars, "context_read_limit", "Select a smaller child pointer; the original context remains available");
  return result;
}

export function retainPilotRead(store: Store, project: string, question: string, action: unknown, observation: unknown) {
  const value = { projectId: project, question, action, observation };
  const id = `pilot-reading:${hashJson(value)}`;
  return store.get(id) ?? store.write({ id, kind: "pilot-reading", expected: 0, value });
}

export function pilotContext(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>) {
  const project = draft.value.projectId;
  const annotations = mapStatus(store, project);
  const scope = draft.value.level === "R2" ? researchScope(store, project) : null;
  if (scope) requireCondition(draft.value.inputs.some(ref => canonical(ref) === canonical(reference(scope))), "research_scope_stale", "Prepare a draft bound to the current scope before continuing");
  const stage = (name: "discovery" | "concept" | "specification" | "features") => {
    const record = store.get<StageArtifact>(stageId(project, name));
    requireCondition(record && draft.value.inputs.some(ref => canonical(ref) === canonical(reference(record))),
      "context_basis_missing", `The pilot requires its bound accepted ${name}`);
    return { ref: reference(record), fields: (record.value.content as unknown as { fields: Record<string, any> }).fields };
  };
  const initial = stage("discovery"), concept = stage("concept"), specification = stage("specification"), features = stage("features");
  const preparation = initial.fields['preparation'];
  const map = researchGraphContext(store, draft.value);
  requireCondition(map, "context_basis_missing", "The pilot requires the accepted upper map");
  const allowedConsumers = researchConsumerIds(store, project, map.graph);
  const gapFields = targetFieldGroups([...map.graph.nodes, ...preparation.actors]);
  const spec = structuredClone(question.value.spec);
  if (draft.value.consumer === "compilation") {
    const schema = spec.schema as any;
    requireCondition(schema?.properties?.designs?.items?.properties?.consumer && schema?.properties?.gaps?.items?.properties?.target,
      "pilot_question_unsupported", "The experiment requires the technical report contract");
  }
  const evidence = new Evidence(store);
  const sourceCurrent = (ref: Ref) => {
    const source = store.get<Source>(ref.id);
    return source?.kind === "source" && source.value.projectId === project && canonical(reference(source)) === canonical(ref)
      && sourceIsCurrent(source.value);
  };
  const allReadings = store.list<ReaderResult>("reader-result").filter(record => record.value.projectId === project
    && record.value.question.id === question.id);
  const readings = allReadings.filter(record => readerResultCurrent(store, project, record.value));
  const catalogue = contextCatalogue(store, draft);
  const directReadings = store.list<{ projectId: string; question: string; action: { action: string }; observation: any }>("pilot-reading")
    .filter(record => record.value.projectId === project && record.value.question === question.id);
  const currentRead = (record: typeof directReadings[number]) => {
    const { action, observation } = record.value;
    if (action.action === "read_source") return evidence.verify(observation as Observation);
    if (action.action === "read") return sourceCurrent(observation.ref);
    if (action.action === "read_context") {
      if (store.get(observation.record.id)?.kind === "research-context") {
        try { archivedContext(store, draft, observation.record); return true; } catch { return false; }
      }
      return catalogue.some(item => canonical(item.ref) === canonical(observation.record));
    }
    return action.action === "search"; // Search results are navigation hints, never evidence of a fact.
  };
  return {
    mapStatus: annotations?.current ? annotations : null,
    mapStatusFindings: annotations?.current === false ? [{ code: "map_status_stale", message: "Implementation annotations bind an older map and are excluded from this research context" }] : [],
    researchScope: scope ? { ref: reference(scope), ...scope.value, obligations: scopeObligations(scope.value) } : null,
    role: "research", stage: draft.value.stage, level: draft.value.level, consumer: draft.value.consumer,
    contextEncoding: CONTEXT_ENCODING, allowedConsumers, gapFields,
    graphBase: reference(store.get<Graph>(`graph:${project}`)!),
    core: { initial: initial.ref, brief: initial.fields['brief'], objective: initial.fields['objective'],
      problem: preparation.problem, existingSituation: preparation.existingSituation, actors: preparation.actors,
      outcomes: preparation.outcomes, constraints: preparation.constraints, risks: preparation.risks, unknowns: preparation.unknowns,
      concept: concept.ref, requirements: concept.fields['conceptSections'].map((section: { requirements: object[] }) => ({
        ...section, requirements: contextTable(section.requirements) })), acceptance: concept.fields['acceptance'],
      specification: specification.ref, specificationConstraints: specification.fields['constraints'],
      features: features.ref, featureIndex: contextTable(features.fields['features']) },
    map: { ref: map.ref, level: map.level,
      nodes: contextTable(map.graph.nodes.map((node, index) => ({ id: node.id, title: node.title, kind: node.kind, parent: node.parent,
        outcome: node.outcome, boundary: node.boundary, pointer: `/projection/nodes/${index}` }))),
      connectors: contextTable(map.graph.connectors.map((connector, index) => ({ id: connector.id, artifact: connector.artifact,
        bindings: connector.bindings.map(binding => ({ level: binding.level, producer: binding.producer, consumers: binding.consumers, anchor: binding.anchor })),
        returnsTo: connector.returnsTo, pointer: `/projection/connectors/${index}` }))),
      contracts: map.graph.contracts.map((contract, index) => ({ id: contract.id, ...descriptor(`/projection/contracts/${index}`, contract) })),
      controls: contextTable((map.graph.edges ?? []).map((edge, index) => ({ id: edge.id, relation: edge.relation, source: edge.source,
        target: edge.target, condition: edge.condition, pointer: `/projection/edges/${index}` }))),
      journeys: contextTable((map.graph.journeys ?? []).map((journey, index) => ({ ...journey, pointer: `/projection/journeys/${index}` }))) },
    draft: reference(draft), question: { id: question.id, ...spec },
    currentProposal: question.value.spec.field === "layerDesign" && draft.value.fields['layerDesign']
      ? layerDeltaView(store, project, draft.value.fields['layerDesign'], draft.value.level === 'R2' ? 3 : 2) : draft.value.fields[question.value.spec.field],
    catalogue,
    answers: draft.value.questions.map(id => store.get<Question>(id)!).map(q => ({ field: q.value.spec.field, status: q.value.status,
      pointer: `/fields/${escape(q.value.spec.field)}` })),
    readings: readings.map(record => ({ ref: reference(record), purpose: record.value.purpose,
      observations: record.value.observations, coverage: record.value.coverage, unresolved: record.value.unresolved })),
    staleReaderReadings: allReadings.filter(record => !readings.includes(record)).map(record => ({ ref: reference(record),
      purpose: record.value.purpose, sources: record.value.sources })),
    directReadings: directReadings.filter(currentRead).map(record => ({ ref: reference(record), ...record.value,
      navigationOnly: record.value.action.action === "search" })),
    staleReadings: directReadings.filter(record => !currentRead(record)).map(record => ({ ref: reference(record), action: record.value.action })),
    openGaps: map.openGaps, failures: map.failures,
  };
}

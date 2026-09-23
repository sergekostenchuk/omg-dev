import { Ajv } from "ajv";
import { canonical, digest, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { LEGACY_REQUIREMENTS, RESEARCH_CONTRACT_VERSION, REQUIREMENTS, UPSTREAM_STAGES, VERSION2_REQUIREMENTS, type UpstreamStage } from "../discovery/requirements.js";
import { preparationFindings } from "../discovery/preparation-validation.js";
import { buildL1 } from "../graph/builder.js";
import { projectGraph } from "../graph/project.js";
import { runtimeEvidenceDependencies } from "../graph/runtime-evidence.js";
import { isRef, reference, stageId, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { ProductEngine } from "../product/engine.js";
import { Store, type Revision, type Write } from "../storage/store.js";
import { delivered, isPlainObject, refused, sealed, type OmResult, type Refusal, type Sealed } from "./refusal.js";
import { readRecord, writeGuarded } from "./refs.js";

// The producer still emits contract v3 without structured nodes or check kinds.
export const NODES_REQUIRED_SINCE: number | null = null;
const INPUT_STAGES = Object.freeze([...UPSTREAM_STAGES]);
export const INPUT_REFUSAL_CODES = Object.freeze([
  "input_field_missing", "requirement_ref_unresolved", "contract_ref_unresolved", "behavior_index_out_of_range",
  "outcome_artifact_unknown", "contract_node_unknown", "feature_preparation_missing", "feature_preparation_ambiguous",
  "feature_preparation_foreign", "question_consumer_missing", "stage_contract_version_unknown", "contract_node_unbound",
  "acceptance_kind_missing", "contract_boundary_prose", "stage_not_accepted",
] as const);
export type InputRefusalCode = typeof INPUT_REFUSAL_CODES[number];
export interface InputStage { ref: Ref; contractVersion: number | null; fields: Record<string, Json> }
export type InputStages = Record<UpstreamStage, InputStage>;
export interface InputOptions { inventory?: Ref | null; nodesRequiredSince?: number | null }
export interface InputGap { code: string; target: string; field: string; consumer: Json; message: string; source: Ref | null }
export interface OmInput {
  sources: (Ref & { stage: UpstreamStage; contractVersion: number | null })[];
  inventory: Ref | null;
  requirements: { id: string; section: string }[];
  criteria: { id: string; requirement: string; checkKind: string | null }[];
  contracts: { id: string; nodes: string[] | null; requirements: string[]; outcome: string; actor: string;
    success: string[]; failures: string[]; forbiddenEffects: string[]; state: Record<string, Json>; proof: string }[];
  features: { index: number; title: string; outcome: string; behaviorIndexes: number[]; requirementIds: string[]; contracts: string[] }[];
  questions: { id: string; question: string; consumer: string; kind: Json; blocks: boolean; source: Ref }[];
  map: { nodes: string[]; artifacts: string[]; connectors: string[] };
}
export interface InputBuildResult { input: OmInput | null; hash: string | null; refusals: Refusal[]; gaps: InputGap[] }
export interface InputRequest { project: string; stages: Record<UpstreamStage, Ref>; inventory?: Ref | null; expected: number }
export interface OmInputRecord { projectId: string; input: OmInput; hash: string; gaps: InputGap[] }
export interface PreparedOmInput { record: OmInputRecord; writes: Write[]; guards: Ref[]; existing: Revision<OmInputRecord> | null }

type Row = Record<string, any>;
const object = (value: unknown): value is Row => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const at = (target: string, field: string, ref?: Ref) => ({ unit: "G1", target, field, ...(ref ? { ref } : {}) });
function invalid(field: string): never { throw new EngineError("input_request_invalid", "OM input needs a well-formed request", at("om-input", field)); }
function copy<T>(value: T): T {
  try { return sealed(value) as T; } catch { return invalid("json"); }
}

/** Pure normalization; persistence independently resolves and checks the saved source records. */
export function buildOmInput(stages: InputStages, options: InputOptions = {}): Sealed<InputBuildResult> {
  if (!object(stages)) invalid("stages");
  if (!object(options) || (options.inventory !== undefined && options.inventory !== null && !isRef(options.inventory))
    || (options.nodesRequiredSince !== undefined && options.nodesRequiredSince !== null
      && (!Number.isSafeInteger(options.nodesRequiredSince) || options.nodesRequiredSince <= 0))) invalid("options");
  options = copy(options);
  const refusals: Refusal[] = [], gaps: InputGap[] = [];
  const fail = (code: InputRefusalCode, stage: UpstreamStage, field: string, message: string) => {
    const ref = stages[stage]?.ref;
    const result = refused(code, message, at(isRef(ref) ? ref.id : `stage:${stage}`, field, isRef(ref) ? ref : undefined), "producer");
    if (!result.ok) refusals.push(result.refusal);
  };
  for (const stage of INPUT_STAGES) {
    const value = stages[stage];
    if (!object(value) || !isRef(value.ref) || !object(value.fields)) fail("input_field_missing", stage, "source", "A stage needs exact source and fields");
    else if (value.contractVersion !== null && (!Number.isSafeInteger(value.contractVersion) || value.contractVersion <= 0))
      fail("stage_contract_version_unknown", stage, "contractVersion", "The exact draft contract version is unavailable");
  }
  const finish = (input: OmInput | null): Sealed<InputBuildResult> => sealed({ input: refusals.length ? null : input,
    hash: refusals.length || !input ? null : hashJson(input), refusals: sorted(refusals), gaps: sorted(gaps) });
  if (refusals.length) return finish(null);
  stages = copy(stages);
  const rows = (value: unknown, stage: UpstreamStage, field: string): Row[] => {
    if (!Array.isArray(value) || !value.every(object)) { fail("input_field_missing", stage, field, "An explicit array of records is required"); return []; }
    return value;
  };
  const strings = (value: unknown, stage: UpstreamStage, field: string): string[] => {
    if (!Array.isArray(value) || !value.every(text)) { fail("input_field_missing", stage, field, "An explicit array of text values is required"); return []; }
    return [...value].sort(order);
  };
  const requiredText = (value: unknown, stage: UpstreamStage, field: string): string => {
    if (!text(value)) { fail("input_field_missing", stage, field, "A nonempty text field is required"); return ""; }
    return value;
  };
  const gap = (code: string, stage: UpstreamStage, target: string, field: string, consumer: Json, message: string) =>
    gaps.push({ code, target, field, consumer, message, source: stages[stage].ref });
  const threshold = options.nodesRequiredSince === undefined ? NODES_REQUIRED_SINCE : options.nodesRequiredSince;
  const newEra = (stage: UpstreamStage) => {
    const version = stages[stage].contractVersion;
    if (threshold !== null && version === null) fail("stage_contract_version_unknown", stage, "contractVersion", "The active era threshold needs the exact draft version");
    return threshold !== null && version !== null && version >= threshold;
  };
  const newContracts = newEra("specification"), newCriteria = newEra("concept");
  const preparation: unknown = stages.discovery.fields['preparation'];
  if (!object(preparation)) fail("input_field_missing", "discovery", "preparation", "Preparation is required");
  const actors = rows(object(preparation) ? preparation.actors : undefined, "discovery", "preparation.actors");
  const unknowns = rows(object(preparation) ? preparation.unknowns : undefined, "discovery", "preparation.unknowns");
  const sections = rows(stages.concept.fields['conceptSections'], "concept", "conceptSections");
  const map: unknown = stages['operation-map'].fields['mapDesign'];
  if (!object(map)) fail("input_field_missing", "operation-map", "mapDesign", "The accepted map composition is required");
  const ids = (field: string) => rows(object(map) ? map[field] : undefined, "operation-map", `mapDesign.${field}`)
    .map((item, i) => requiredText(item.id, "operation-map", `mapDesign.${field}[${i}].id`)).sort(order);
  const mapIds = { nodes: ids("nodes"), artifacts: ids("artifacts"), connectors: ids("connectors") };
  const nodeIds = new Set(mapIds.nodes), artifactIds = new Set(mapIds.artifacts);
  const actorIds = new Set(actors.map((actor, i) => requiredText(actor.id, "discovery", `preparation.actors[${i}].id`)));
  const behavior = strings(stages.specification.fields['behavior'], "specification", "behavior");
  const rawContracts = rows(stages.specification.fields['behaviorContracts'], "specification", "behaviorContracts");
  const rawFeatures = rows(stages.features.fields['features'], "features", "features");
  const preps = rows(stages.features.fields['featurePreparation'], "features", "featurePreparation");
  const requirements: OmInput['requirements'] = [], criteria: OmInput['criteria'] = [];
  for (const [si, section] of sections.entries()) {
    const sectionId = requiredText(section.id, "concept", `conceptSections[${si}].id`);
    for (const [ri, req] of rows(section.requirements, "concept", `${sectionId}.requirements`).entries()) {
      const id = requiredText(req.id, "concept", `${sectionId}.requirements[${ri}].id`);
      requirements.push({ id, section: sectionId });
      if (!Array.isArray(req.acceptance)) { fail("input_field_missing", "concept", `${id}.acceptance`, "Acceptance criteria must be explicit"); continue; }
      for (const [index, criterion] of req.acceptance.entries()) {
        const target = `${id}#${index + 1}`;
        if (!(text(criterion) || object(criterion) && text(criterion.text))) fail("input_field_missing", "concept", `${target}.text`, "A criterion needs its statement");
        const kind = object(criterion) ? criterion.checkKind : undefined;
        const validKind = ["test", "full-run", "environment-observation"].includes(kind);
        criteria.push({ id: target, requirement: id, checkKind: validKind ? kind : null });
        if (!validKind) {
          if (newCriteria) fail("acceptance_kind_missing", "concept", `${target}.checkKind`, "This contract era requires a check kind");
          else gap("acceptance_kind_missing", "concept", target, "checkKind", { requirement: id }, "The criterion has no structured check kind");
        }
      }
    }
  }
  const requirementIds = new Set(requirements.map(req => req.id));
  const prepOf = (feature: Row) => preps.filter(prep => prep.featureTitle === feature.title && prep.outcome === feature.outcome);
  const usedBy = (id: string): Json => ({ features: rawFeatures.flatMap((feature, index) => {
    const mine = prepOf(feature);
    return mine.length === 1 && Array.isArray(mine[0]!.behaviorContracts) && mine[0]!.behaviorContracts.includes(id)
      ? [{ feature: index, title: feature.title }] : [];
  }) });
  const contracts: OmInput['contracts'] = rawContracts.map((contract, index) => {
    const id = requiredText(contract.id, "specification", `behaviorContracts[${index}].id`);
    const refs = strings(contract.requirements, "specification", `${id}.requirements`);
    for (const ref of refs) if (!requirementIds.has(ref)) fail("requirement_ref_unresolved", "specification", `${id}.requirements`, `Unknown requirement ${ref}`);
    const outcome = requiredText(contract.outcome, "specification", `${id}.outcome`);
    if (!artifactIds.has(outcome)) fail("outcome_artifact_unknown", "specification", `${id}.outcome`, `Unknown artifact ${outcome}`);
    let nodes: string[] | null = null;
    if (Array.isArray(contract.nodes) && contract.nodes.length > 0 && contract.nodes.every(text)) {
      nodes = [...contract.nodes].sort(order);
      for (const id of nodes) if (!nodeIds.has(id)) fail("contract_node_unknown", "specification", `${contract.id}.nodes`, `Unknown map node ${id}`);
    } else if (newContracts || Object.hasOwn(contract, "nodes")) fail("contract_node_unbound", "specification", `${id}.nodes`, "A nonempty list of map node IDs is required");
    else gap("contract_node_unbound", "specification", id, "nodes", usedBy(id), "Prose cannot bind a contract to map nodes");
    const state: Record<string, Json> = {};
    for (const field of ["durability", "writer", "authority", "rollback", "restart", "replay"]) {
      const value = requiredText(object(contract.state) ? contract.state[field] : undefined, "specification", `${id}.state.${field}`);
      Object.defineProperty(state, field, { value, enumerable: true });
    }
    const prose = ["writer", "authority", "rollback"].filter(field => !nodeIds.has(state[field] as string) && !actorIds.has(state[field] as string));
    if (prose.length) {
      if (newContracts) fail("contract_boundary_prose", "specification", `${id}.state`, `Structured boundary IDs are required: ${prose.join(", ")}`);
      else gap("contract_boundary_prose", "specification", id, "state", usedBy(id), `Boundary values are prose: ${prose.join(", ")}`);
    }
    return { id, nodes, requirements: refs, outcome, actor: requiredText(contract.actor, "specification", `${id}.actor`),
      success: strings(contract.success, "specification", `${id}.success`), failures: strings(contract.failures, "specification", `${id}.failures`),
      forbiddenEffects: strings(contract.forbiddenEffects, "specification", `${id}.forbiddenEffects`), state,
      proof: requiredText(contract.proof, "specification", `${id}.proof`) };
  });
  const contractIds = new Set(contracts.map(contract => contract.id));
  const questions: OmInput['questions'] = [];
  const question = (raw: Row, id: string, stage: UpstreamStage) => {
    const wording = requiredText(raw.question, stage, `${id}.question`);
    if (!text(raw.consumer)) { fail("question_consumer_missing", stage, `${id}.consumer`, "A question must have its producer's consumer"); return; }
    if (typeof raw.blocksCurrentStage !== "boolean") fail("input_field_missing", stage, `${id}.blocksCurrentStage`, "The producer must specify whether the question blocks its stage");
    questions.push({ id, question: wording, consumer: raw.consumer, kind: Object.hasOwn(raw, "kind") ? raw.kind : null,
      blocks: raw.blocksCurrentStage === true, source: stages[stage].ref });
  };
  for (const [index, raw] of unknowns.entries()) question(raw, `discovery:${requiredText(raw.id, "discovery", `unknowns[${index}].id`)}`, "discovery");
  const features: OmInput['features'] = [];
  for (const [index, feature] of rawFeatures.entries()) {
    const target = `features[${index}]`;
    const title = requiredText(feature.title, "features", `${target}.title`), outcome = requiredText(feature.outcome, "features", `${target}.outcome`);
    if (!artifactIds.has(outcome)) fail("outcome_artifact_unknown", "features", `${target}.outcome`, `Unknown artifact ${outcome}`);
    const indexes = feature.requirements;
    if (!Array.isArray(indexes)) fail("input_field_missing", "features", `${target}.requirements`, "Behavior indexes must be explicit");
    else for (const value of indexes) if (!Number.isSafeInteger(value) || value < 0 || value >= behavior.length)
      fail("behavior_index_out_of_range", "features", `${target}.requirements`, "A behavior index is outside the source array");
    const mine = prepOf(feature);
    if (mine.length !== 1) { fail(mine.length ? "feature_preparation_ambiguous" : "feature_preparation_missing", "features", target, "Exactly one preparation must match title and outcome"); continue; }
    const prep = mine[0]!;
    const refs = strings(prep.requirements, "features", `${target}.preparation.requirements`);
    const bound = strings(prep.behaviorContracts, "features", `${target}.preparation.behaviorContracts`);
    for (const id of refs) if (!requirementIds.has(id)) fail("requirement_ref_unresolved", "features", `${target}.preparation.requirements`, `Unknown requirement ${id}`);
    for (const id of bound) if (!contractIds.has(id)) fail("contract_ref_unresolved", "features", `${target}.preparation.behaviorContracts`, `Unknown behavior contract ${id}`);
    features.push({ index, title, outcome, behaviorIndexes: Array.isArray(indexes) ? [...indexes].sort((a, b) => a - b) : [], requirementIds: refs, contracts: bound });
    for (const [qi, raw] of sorted(rows(prep.remainingQuestions, "features", `${target}.preparation.remainingQuestions`)).entries()) question(raw, `feature:${index}:${qi + 1}`, "features");
  }
  for (const [index, prep] of preps.entries()) if (!rawFeatures.some(feature => feature.title === prep.featureTitle && feature.outcome === prep.outcome))
    fail("feature_preparation_foreign", "features", `featurePreparation[${index}]`, "Preparation belongs to no feature with this title and outcome");
  if (!options.inventory) gaps.push({ code: "inventory_missing", target: "repo-inventory", field: "inventory",
    consumer: { mechanism: "M6", uses: ["code-answer", "project-question-package"] }, message: "Repository inventory is unavailable", source: null });
  return finish({ sources: INPUT_STAGES.map(stage => ({ stage, id: stages[stage].ref.id, revision: stages[stage].ref.revision,
    hash: stages[stage].ref.hash, contractVersion: stages[stage].contractVersion })),
    inventory: options.inventory ?? null, requirements: sorted(requirements), criteria: sorted(criteria), contracts: sorted(contracts),
    features, questions: sorted(questions), map: mapIds });
}

export function gateInput(result: InputBuildResult): Sealed<{ passed: boolean; codes: string[] }> {
  if (!object(result) || !Array.isArray(result.refusals) || !Array.isArray(result.gaps)
    || !result.refusals.every(item => object(item) && text(item.code))
    || (result.input !== null && !object(result.input)) || (result.hash !== null && !text(result.hash))) invalid("result");
  const passed = result.refusals.length === 0 && result.input !== null && result.hash === hashJson(result.input);
  return sealed({ passed, codes: [...new Set(result.refusals.map(item => item.code))].sort(order) });
}

const contractsByVersion = sealed({ 1: LEGACY_REQUIREMENTS, 2: VERSION2_REQUIREMENTS, [RESEARCH_CONTRACT_VERSION]: REQUIREMENTS });
const schemas = new Ajv({ strict: true, allowUnionTypes: true });

function requireInputRequest(store: Store, request: InputRequest): void {
  if (!(store instanceof Store)) invalid("store");
  if (!object(request)) invalid("request");
  if (typeof request.project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request.project)) invalid("project");
  if (!object(request.stages)) invalid("stages");
  if (!Number.isSafeInteger(request.expected) || request.expected < 0) invalid("expected");
  if (request.inventory !== undefined && request.inventory !== null && !isRef(request.inventory)) invalid("inventory");
}

// An accepted historical snapshot is checked against its saved proof closure. A later source revision or file edit
// is not a reason to rerun old acceptance against today's evidence or to substitute a current draft for its source.
function loadSources(store: Store, request: InputRequest): OmResult<Sealed<InputStages>> {
  const stages = new Map<UpstreamStage, Revision<StageArtifact>>();
  for (const stage of INPUT_STAGES) {
    const result = readRecord<StageArtifact>(store, request.stages[stage], { unit: "G1", target: stageId(request.project, stage),
      id: stageId(request.project, stage), kind: "stage" });
    if (!result.ok) return result;
    stages.set(stage, result.value as Revision<StageArtifact>);
  }
  const sources: Partial<InputStages> = {};
  for (const [index, stage] of INPUT_STAGES.entries()) {
    const record = stages.get(stage)!;
    const bad = (field: string, message: string): never => {
      throw new EngineError("stage_not_accepted", message, at(record.id, field, reference(record)));
    };
    function check(condition: unknown, field: string, message: string): asserts condition {
      if (!condition) bad(field, message);
    }
    try {
      const value = record.value;
      check(object(value) && value.projectId === request.project && value.stage === stage && value.status === "accepted",
        "status", "The exact stage must belong to this project and be accepted");
      check(Array.isArray(value.inputs) && value.inputs.every(isRef) && Array.isArray(value.proofs) && value.proofs.every(isRef),
        "proofs", "Accepted stage inputs and proofs must be explicit exact references");
      const predecessor = index > 0 ? stages.get(INPUT_STAGES[index - 1]!)! : null;
      check(canonical(value.inputs) === canonical(predecessor ? [reference(predecessor)] : []), "inputs", "The stage must bind the supplied exact predecessor");
      const content: unknown = value.content;
      check(object(content) && isRef(content.draft) && object(content.fields) && Object.hasOwn(content, "graph"),
        "content", "The stage must bind its exact research draft and fields");
      const proofs = new Map<string, Revision<Row>>();
      for (const ref of value.proofs) {
        const found = store.get<Row>(ref.id, ref.revision);
        check(found && found.hash === ref.hash, "proofs", `Exact proof is unavailable: ${ref.id}`);
        const prior = proofs.get(ref.id);
        check(!prior || canonical(reference(prior)) === canonical(ref), "proofs", "Proofs cannot claim two versions of one source");
        proofs.set(ref.id, found);
      }
      const proof = (ref: Ref, kind?: string): Revision<Row> => {
        check(isRef(ref), "proofs", "A proof needs its exact reference");
        const found = proofs.get(ref.id);
        check(found && canonical(reference(found)) === canonical(ref) && (!kind || found.kind === kind), "proofs", `Acceptance has no matching proof: ${ref.id}`);
        check(object(found.value), "proofs", `Proof has no record body: ${ref.id}`);
        return found;
      };
      const byId = (id: string, kind: string) => {
        const found = proofs.get(id);
        check(found && found.kind === kind, "proofs", `Acceptance has no ${kind} proof: ${id}`);
        return proof(reference(found), kind);
      };
      for (const input of value.inputs) proof(input, "stage");
      const draftRecord = proof(content.draft, "discovery-draft"), draft = draftRecord.value;
      check(draftRecord.id.startsWith(`discovery:${request.project}:`) && draft.projectId === request.project && draft.stage === stage
        && object(draft.fields) && canonical(draft.fields) === canonical(content.fields), "content.draft", "The exact draft must belong to this stage and preserve its fields");
      const version = Object.hasOwn(draft, "contractVersion") ? draft.contractVersion : null;
      check(version === null || Number.isSafeInteger(version) && version > 0, "contractVersion", "The exact draft version is malformed");
      const specs = contractsByVersion[(version ?? 1) as keyof typeof contractsByVersion]?.[stage];
      check(specs, "contractVersion", "The draft uses an unknown historical contract");
      check(Array.isArray(draft.questions) && draft.questions.every(text) && Array.isArray(draft.inputs) && draft.inputs.every(isRef),
        "content.draft", "The research question and input sets must be explicit");
      for (const input of draft.inputs) proof(input);
      check(!predecessor || draft.inputs.some((ref: Ref) => canonical(ref) === canonical(reference(predecessor))), "inputs", "Research must bind its accepted predecessor");
      const questions = draft.questions.map((id: string) => byId(id, "question"));
      check(canonical(questions.map((question: Revision<Row>) => question.value.spec)) === canonical(specs), "questions", "The complete question set must match the saved contract era");
      const observation = (raw: unknown): Json => {
        check(object(raw) && raw.projectId === request.project && isRef(raw.source) && object(raw.selector), "observation", "Observation needs its project, exact source and selector");
        const sourceRecord = proof(raw.source, "source"), source = sourceRecord.value;
        check(sourceRecord.id.startsWith(`source:${request.project}:`) && source.projectId === request.project
          && typeof source.content === "string" && digest(source.content) === source.sha256
          && ["text/plain", "application/json"].includes(source.mediaType) && object(source.origin)
          && ["file", "owner-document"].includes(source.origin.kind) && typeof source.origin.location === "string",
        "observation.source", "Saved evidence must preserve its content, digest, project and origin");
        let extracted: Json;
        if (raw.selector.kind === "text-range") {
          const { start, end } = raw.selector;
          check(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= source.content.length,
            "observation.selector", "Text range is outside the saved source");
          extracted = source.content.slice(start, end);
        } else {
          const pointer = raw.selector.pointer;
          check(raw.selector.kind === "json-pointer" && source.mediaType === "application/json" && typeof pointer === "string"
            && (pointer === "" || pointer.startsWith("/")), "observation.selector", "JSON evidence needs a valid pointer");
          extracted = JSON.parse(source.content) as Json;
          if (pointer) for (const encoded of pointer.slice(1).split("/")) {
            check(!/~(?![01])/.test(encoded), "observation.selector", "Invalid pointer escape");
            const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
            check(extracted !== null && typeof extracted === "object" && Object.hasOwn(extracted, key), "observation.selector", "Selected field is absent from the saved source");
            extracted = (extracted as Record<string, Json>)[key]!;
          }
        }
        check(canonical(extracted) === canonical(raw.value), "observation.value", "Observation must be derived from its saved source");
        return extracted;
      };
      for (const question of questions as Revision<Row>[]) {
        const q = question.value;
        check(question.id.startsWith(`question:${request.project}:`) && q.projectId === request.project && q.stage === stage
          && q.draftId === draftRecord.id && q.status === "answered" && isRef(q.answer), "questions", "Every research question must have its own saved answer");
        const answerRecord = proof(q.answer), answer = answerRecord.value;
        check(answer.projectId === request.project && answer.question === question.id && answerRecord.id.startsWith(`${answerRecord.kind}:${request.project}:`)
          && (answerRecord.kind === q.spec.kind || answerRecord.kind === "research-answer"), "answers", "The answer belongs to another question, project or kind");
        let answered: Json;
        if (answerRecord.kind === "fact") answered = observation(answer.observation);
        else if (answerRecord.kind === "research-answer") {
          const assessment = proof(answer.assessment, "research-assessment").value;
          check(assessment.projectId === request.project && assessment.verdict === "supported" && text(assessment.researcher)
            && text(assessment.assessor) && assessment.researcher !== assessment.assessor && isRef(assessment.question), "assessment", "Research needs an independent supported assessment");
          const issued = store.get<Row>(assessment.question.id, assessment.question.revision);
          check(issued?.kind === "question" && issued.id === question.id && issued.hash === assessment.question.hash
            && object(issued.value) && canonical(issued.value.spec) === canonical(q.spec), "assessment.question", "Assessment must bind the issued question contract");
          check(Array.isArray(assessment.observations) && assessment.observations.length > 0, "assessment.observations", "Supported research needs saved observations");
          for (const raw of assessment.observations) observation(raw);
          for (const dependency of runtimeEvidenceDependencies(assessment.runtimeProofs ?? [])) proof(dependency);
          check(canonical(assessment.value) === canonical(answer.value), "assessment.value", "The assessment must support this answer value");
          answered = answer.value;
        } else {
          check(text(answer.actor), "answer.actor", "A saved decision names its owner");
          answered = answer.value;
        }
        check(canonical(answered) === canonical(draft.fields[q.spec.field]) && schemas.compile(q.spec.schema)(answered),
          `fields.${q.spec.field}`, "Fields must match the answered value and historical schema");
      }
      if (stage === "operation-map") {
        check(isRef(content.graph) && content.graph.id === `graph-layer:${request.project}:1`, "content.graph", "The map must bind its exact L1 projection");
        const layer = proof(content.graph, "graph-layer").value, projection = layer.projection;
        check(object(projection), "content.graph", "The saved L1 projection is missing");
        check(Array.isArray(layer.inputs) && layer.inputs.every(isRef) && Array.isArray(layer.obligations)
          && (layer.layerProofs === undefined || Array.isArray(layer.layerProofs)), "content.graph", "Layer evidence sets must be explicit");
        const dependencies: Ref[] = [];
        for (const obligation of layer.obligations) {
          check(object(obligation) && text(obligation.node) && text(obligation.field) && Array.isArray(obligation.inputs)
            && obligation.inputs.every(isRef), "content.graph.obligations", "A layer obligation must identify its field and exact evidence");
          const node = projection.nodes.find((candidate: Row) => candidate.id === obligation.node);
          check(node && Object.hasOwn(node, obligation.field) && hashJson(node[obligation.field]) === obligation.valueHash,
            "content.graph.obligations", "The layer field must match its saved evidence");
          dependencies.push(...obligation.inputs);
        }
        for (const layerProof of layer.layerProofs ?? []) {
          check(object(layerProof) && layerProof.level === 1 && layerProof.hash === hashJson(projection)
            && Array.isArray(layerProof.inputs) && layerProof.inputs.every(isRef), "content.graph.layerProofs", "L1 must match its exact research proof");
          dependencies.push(...layerProof.inputs);
        }
        const unique = (refs: Ref[]) => sorted([...new Map(refs.map(ref => [canonical(ref), ref])).values()]);
        check(canonical(unique(dependencies)) === canonical(sorted(layer.inputs)), "content.graph.inputs", "Layer inputs must cover all field and layer evidence");
        for (const input of layer.inputs) proof(input);
        if (version === RESEARCH_CONTRACT_VERSION) {
          const initial = sources.discovery!.fields, concept = sources.concept!.fields;
          const proposed = buildL1(projection.id, projection.title, content.fields.mapDesign, initial, concept);
          check(canonical(projectGraph(proposed, 1)) === canonical(projection), "content.graph", "The exact map must derive from its saved stage fields");
        }
      } else check(content.graph === null, "content.graph", "Only the operation map binds its own L1 projection");
      sources[stage] = { ref: reference(record), contractVersion: version, fields: content.fields as Record<string, Json> };
    } catch (error) {
      return refused("stage_not_accepted", error instanceof Error ? error.message : "Saved acceptance proof is invalid",
        error instanceof EngineError && error.code === "stage_not_accepted" ? error.details as ReturnType<typeof at>
          : at(record.id, "proofs", reference(record)), "producer");
    }
  }
  const result = sources as InputStages;
  const behaviors = result.specification.fields['behavior'], features = result.features.fields['features'];
  if (Array.isArray(behaviors) && Array.isArray(features)) {
    const covered = new Set(features.flatMap((feature: unknown) => object(feature) && Array.isArray(feature.requirements) ? feature.requirements : []));
    if (covered.size !== behaviors.length || [...covered].some(value => !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= behaviors.length))
      return refused("stage_not_accepted", "Prepared features must cover every specified behavior", at(result.features.ref.id, "features.requirements", result.features.ref), "producer");
  }
  const outcomes = (result['operation-map'].fields['mapDesign'] as Row)?.artifacts;
  if (Array.isArray(outcomes)) for (const stage of INPUT_STAGES) {
    if ((result[stage].contractVersion ?? 1) === 1) continue;
    const findings = preparationFindings(stage, result[stage].fields, name => result[name as UpstreamStage]?.fields ?? null,
      outcomes.map((artifact: Row) => artifact.id));
    if (findings.length) return refused("stage_not_accepted", findings[0]!.message,
      at(result[stage].ref.id, findings[0]!.field ?? findings[0]!.target, result[stage].ref), "producer");
  }
  return delivered(result);
}

function deriveInputRecord(store: Store, request: InputRequest): OmResult<Sealed<OmInputRecord>> {
  const sources = loadSources(store, request);
  if (!sources.ok) return sources;
  const inventory = request.inventory ?? null;
  if (inventory) {
    const read = readRecord(store, inventory, { unit: "G1", target: inventory.id, id: `repo-inventory:${request.project}`, kind: "repo-inventory" });
    if (!read.ok) return read;
  }
  const result = buildOmInput(sources.value as InputStages, { inventory });
  if (result.refusals.length) return { ok: false, refusal: result.refusals[0]! };
  if (!result.input || !result.hash) invalid("result");
  return delivered({ projectId: request.project, input: result.input as OmInput, hash: result.hash, gaps: result.gaps as InputGap[] });
}

// Current acceptance reads more heads than Pipeline exposes as guards (notably the full graph).
// Trace those reads without turning exact historical reads, such as an issued question, into heads.
function currentAcceptance(store: Store, request: InputRequest): OmResult<Sealed<Ref[]>> {
  const heads = new Map<string, Ref>();
  const remember = (ref: Ref) => {
    const previous = heads.get(ref.id);
    if (previous && canonical(previous) !== canonical(ref))
      throw new EngineError("input_stale", "An acceptance dependency changed during preparation", at(ref.id, "head", previous));
    heads.set(ref.id, ref);
  };
  const traced = new Proxy(store, {
    get(target, key) {
      if (key === "get") return <T = Json>(id: string, revision?: number): Revision<T> | null => {
        const record = target.get<T>(id, revision);
        if (revision === undefined && record) remember(reference(record));
        return record;
      };
      const member: unknown = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  try {
    for (const ref of [...INPUT_STAGES.map(stage => request.stages[stage]), ...(request.inventory ? [request.inventory] : [])]) {
      const head = traced.get(ref.id);
      if (!head || canonical(reference(head)) !== canonical(ref))
        return refused("input_stale", "The requested input source is no longer current", at(ref.id, "head", ref), "producer");
    }
    const projection = new ProductEngine(traced).pipeline.inspect(request.project, "features");
    if (projection.state !== "accepted") {
      const finding = projection.findings[0];
      return refused("stage_not_accepted", finding?.message ?? "The current stages are not accepted",
        at(finding?.target ?? request.stages.features.id, finding?.field ?? finding?.code ?? "status", request.stages.features), "producer");
    }
    for (const ref of [...projection.guards, ...(projection.admissionGuards ?? [])]) remember(ref);
    return delivered(sorted([...heads.values()]));
  } catch (error) {
    if (error instanceof EngineError && error.code === "input_stale")
      return refused("input_stale", error.message, error.details as ReturnType<typeof at>, "producer");
    throw error;
  }
}

export function prepareOmInput(store: Store, request: InputRequest): OmResult<Sealed<PreparedOmInput>> {
  requireInputRequest(store, request);
  request = copy(request);
  const derived = deriveInputRecord(store, request);
  if (!derived.ok) return derived;
  const acceptance = currentAcceptance(store, request);
  if (!acceptance.ok) return acceptance;
  const record = derived.value;
  const id = `om-input:${request.project}`, current = store.get<OmInputRecord>(id);
  const guards = [...acceptance.value];
  const existing = current?.kind === "om-input" && current.revision === request.expected && canonical(current.value) === canonical(record) ? current : null;
  return delivered({ record, existing, writes: existing ? [] : [{ id, kind: "om-input", expected: request.expected, value: record }],
    guards: [...guards, ...(existing ? [reference(existing)] : [])] });
}

export function writeOmInput(store: Store, request: InputRequest): OmResult<Sealed<Revision<OmInputRecord>>> {
  const prepared = prepareOmInput(store, request);
  if (!prepared.ok) return prepared;
  if (prepared.value.existing) return delivered(prepared.value.existing);
  const result = writeGuarded<OmInputRecord>(store, { unit: "G1", target: `om-input:${request.project}`,
    writes: prepared.value.writes as Write[], guards: prepared.value.guards });
  if (!result.ok) return result;
  return delivered(result.value[0]!);
}

export function readOmInput(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<OmInputRecord>>> {
  requireInputRequest(store, { project, stages: {} as InputRequest['stages'], expected: 0 });
  const read = readRecord<OmInputRecord>(store, ref, { unit: "G1", target: `om-input:${project}`, id: `om-input:${project}`, kind: "om-input" });
  if (!read.ok) return read;
  const body = read.value.value;
  if (!object(body) || body.projectId !== project || !object(body.input) || !Array.isArray(body.input.sources)
    || body.input.sources.length !== INPUT_STAGES.length || !Array.isArray(body.gaps))
    return refused("record_forged", "OM input has an incomplete saved source set", at(ref.id, "sources", ref), "producer");
  const refs = new Map<UpstreamStage, Ref>();
  for (const source of body.input.sources) {
    const stage = object(source) ? source.stage as UpstreamStage : null;
    if (!stage || !INPUT_STAGES.includes(stage) || !isRef(source) || refs.has(stage))
      return refused("record_forged", "OM input sources are foreign or duplicated", at(ref.id, "sources", ref), "producer");
    refs.set(stage, { id: source.id, revision: source.revision, hash: source.hash });
  }
  const rebuilt = deriveInputRecord(store, { project, stages: Object.fromEntries(refs) as InputRequest['stages'],
    inventory: body.input.inventory, expected: 0 });
  if (!rebuilt.ok) return rebuilt;
  if (canonical(rebuilt.value) !== canonical(body))
    return refused("record_forged", "OM input must be derived again from its exact saved sources", at(ref.id, "input", ref), "producer");
  return delivered(read.value);
}
